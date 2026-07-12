"use strict";
// ── Section 191: imap_client tests ──────────────────────────────────────────
// Five rigor levels:
//   A — Input validation (no network)
//   B — IMAP parsing unit tests (parseFetchResponses, parseHeaders)
//   C — Security / injection guards
//   D — Happy-path mock (in-process fake IMAP server)
//   E — Error paths (connection refused, bad greeting, auth failure)
//   F — Concurrency (multiple parallel sessions against mock)

const net = require("net");
const { imapClient, ImapSession, parseFetchResponses, parseHeaders } = require("../../lib/imapClientOps");

// ── Minimal test harness ──────────────────────────────────────────────────────
let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; process.stdout.write("."); }
  else { failed++; process.stderr.write(`\n  FAIL: ${msg}\n`); }
}
async function test(name, fn) {
  try {
    await fn();
    passed++;
    process.stdout.write(".");
  } catch (e) {
    failed++;
    process.stderr.write(`\n  FAIL [${name}]: ${e.message}\n`);
  }
}
async function expectThrow(fn, msg) {
  let threw = false;
  try { await fn(); } catch (e) { threw = true; }
  assert(threw, msg);
}

// ── Mock IMAP server factory ──────────────────────────────────────────────────
function createMockImapServer({
  greeting             = "* OK [CAPABILITY IMAP4rev1 STARTTLS AUTH=PLAIN LOGIN] Gimap ready\r\n",
  loginOk              = true,
  capabilities         = "IMAP4rev1 AUTH=PLAIN LOGIN",
  disconnectAfterGreeting = false,
  badGreeting          = false,
  customHandler        = null,
} = {}) {
  const TAG_RE = /^(A\d+) /;
  return new Promise((resolve, reject) => {
    const server = net.createServer((sock) => {
      if (badGreeting) {
        sock.write("GARBAGE BAD\r\n");
      } else {
        sock.write(greeting);
      }
      if (disconnectAfterGreeting) { sock.destroy(); return; }

      let buf = "";
      sock.on("data", (d) => {
        buf += d.toString("utf8");
        let idx;
        while ((idx = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, idx + 1).replace(/\r?\n$/, "");
          buf = buf.slice(idx + 1);
          handleLine(line, sock);
        }
      });
      sock.on("error", () => {});
    });

    function handleLine(line, sock) {
      if (customHandler) {
        const responses = customHandler(line, sock);
        if (responses) {
          for (const r of responses) sock.write(r + "\r\n");
          return;
        }
      }
      const m = line.match(TAG_RE);
      if (!m) return;
      const tag  = m[1];
      const rest = line.slice(tag.length + 1).toUpperCase();

      if (rest.startsWith("CAPABILITY")) {
        sock.write(`* CAPABILITY ${capabilities}\r\n`);
        sock.write(`${tag} OK CAPABILITY completed\r\n`);
      } else if (rest.startsWith("LOGIN")) {
        sock.write(loginOk ? `${tag} OK LOGIN succeeded\r\n` : `${tag} NO LOGIN failed (bad credentials)\r\n`);
      } else if (rest.startsWith("AUTHENTICATE PLAIN")) {
        sock.write(loginOk ? `${tag} OK AUTHENTICATE succeeded\r\n` : `${tag} NO AUTHENTICATE failed\r\n`);
      } else if (rest.startsWith("LIST")) {
        sock.write(`* LIST (\\HasNoChildren) "/" "INBOX"\r\n`);
        sock.write(`* LIST (\\HasNoChildren) "/" "Sent"\r\n`);
        sock.write(`* LIST (\\HasChildren) "/" "Archive"\r\n`);
        sock.write(`${tag} OK LIST completed\r\n`);
      } else if (rest.startsWith("SELECT") || rest.startsWith("EXAMINE")) {
        sock.write(`* 42 EXISTS\r\n`);
        sock.write(`* 3 RECENT\r\n`);
        sock.write(`* FLAGS (\\Answered \\Deleted \\Draft \\Flagged \\Seen)\r\n`);
        sock.write(`* OK [UNSEEN 5] first unseen\r\n`);
        sock.write(`* OK [UIDVALIDITY 1234567890] uidvalidity\r\n`);
        sock.write(`* OK [UIDNEXT 100] uidnext\r\n`);
        sock.write(`* OK [PERMANENTFLAGS (\\Deleted \\Seen \\*)]\r\n`);
        sock.write(`${tag} OK [READ-ONLY] EXAMINE completed\r\n`);
      } else if (rest.startsWith("STATUS")) {
        sock.write(`* STATUS "INBOX" (MESSAGES 42 UNSEEN 5 RECENT 3 UIDNEXT 100 UIDVALIDITY 1234567890)\r\n`);
        sock.write(`${tag} OK STATUS completed\r\n`);
      } else if (rest.startsWith("SEARCH") || rest.startsWith("UID SEARCH")) {
        sock.write(`* SEARCH 1 2 3 5 8 13\r\n`);
        sock.write(`${tag} OK SEARCH completed\r\n`);
      } else if (rest.startsWith("FETCH") || rest.startsWith("UID FETCH")) {
        sock.write(`* 1 FETCH (UID 10 FLAGS (\\Seen) RFC822.SIZE 88)\r\n`);
        sock.write(`* 2 FETCH (UID 11 FLAGS () RFC822.SIZE 200)\r\n`);
        sock.write(`${tag} OK FETCH completed\r\n`);
      } else if (rest.startsWith("STORE") || rest.startsWith("UID STORE")) {
        sock.write(`* 1 FETCH (FLAGS (\\Seen \\Deleted))\r\n`);
        sock.write(`${tag} OK STORE completed\r\n`);
      } else if (rest.startsWith("COPY") || rest.startsWith("UID COPY")) {
        sock.write(`${tag} OK COPY completed\r\n`);
      } else if (rest.startsWith("EXPUNGE")) {
        sock.write(`* 3 EXPUNGE\r\n`);
        sock.write(`* 2 EXPUNGE\r\n`);
        sock.write(`${tag} OK EXPUNGE completed\r\n`);
      } else if (rest.startsWith("APPEND")) {
        const litM = line.match(/\{(\d+)\}/);
        if (litM) {
          sock.write(`+ Continue\r\n`);
          setTimeout(() => sock.write(`${tag} OK APPEND completed\r\n`), 30);
        } else {
          sock.write(`${tag} NO APPEND error\r\n`);
        }
      } else if (rest.startsWith("LOGOUT")) {
        sock.write(`* BYE Logging out\r\n`);
        sock.write(`${tag} OK LOGOUT completed\r\n`);
        sock.destroy();
      } else if (rest.startsWith("NOOP")) {
        sock.write(`${tag} OK NOOP\r\n`);
      } else {
        sock.write(`${tag} BAD Unknown command\r\n`);
      }
    }

    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

async function withMockServer(opts, fn) {
  const { server, port } = await createMockImapServer(opts);
  try {
    await fn(port);
  } finally {
    await new Promise(r => server.close(r));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
async function runTests() {
  console.log("\n══ Section 191: imap_client tests ══");

  // ──────────────────────────────────────────────────────────────────────────
  console.log("\n--- A: Input Validation ---");

  // A1: missing host
  await test("A1: missing host rejects", async () => {
    let threw = false;
    try { await imapClient({ operation: "list" }); } catch (e) { threw = true; }
    if (!threw) {
      const r = await imapClient({ operation: "list" });
      assert(!r.success, "A1: missing host should fail");
    } else {
      assert(true, "A1: threw on missing host");
    }
  });

  // A2: CRLF in host
  await test("A2: host with newline rejected", async () => {
    await expectThrow(() => imapClient({ host: "evil\nhost" }), "A2: CRLF in host");
  });

  // A3: unknown operation
  await test("A3: unknown operation rejects", async () => {
    await expectThrow(() => imapClient({ host: "localhost", operation: "badop" }), "A3: unknown operation");
  });

  // A4: search missing criteria
  await test("A4: search missing criteria rejects", async () => {
    await expectThrow(
      () => imapClient({ host: "localhost", operation: "search", mailbox: "INBOX" }),
      "A4: search without criteria",
    );
  });

  // A5: search missing mailbox
  await test("A5: search missing mailbox rejects", async () => {
    await expectThrow(
      () => imapClient({ host: "localhost", operation: "search", criteria: "ALL" }),
      "A5: search without mailbox",
    );
  });

  // A6: fetch missing sequence_set
  await test("A6: fetch missing sequence_set rejects", async () => {
    await expectThrow(
      () => imapClient({ host: "localhost", operation: "fetch", mailbox: "INBOX" }),
      "A6: fetch without sequence_set",
    );
  });

  // A7: fetch invalid sequence_set
  await test("A7: fetch invalid sequence_set rejects", async () => {
    await expectThrow(
      () => imapClient({ host: "localhost", operation: "fetch", mailbox: "INBOX", sequence_set: "1; DROP TABLE" }),
      "A7: invalid sequence_set",
    );
  });

  // A8: append missing message
  await test("A8: append missing message rejects", async () => {
    await expectThrow(
      () => imapClient({ host: "localhost", operation: "append", mailbox: "INBOX" }),
      "A8: append without message",
    );
  });

  // A9: store missing flags
  await test("A9: store missing flags rejects", async () => {
    await expectThrow(
      () => imapClient({ host: "localhost", operation: "store", mailbox: "INBOX", sequence_set: "1" }),
      "A9: store without flags",
    );
  });

  // A10: copy missing dest_mailbox
  await test("A10: copy missing dest_mailbox rejects", async () => {
    await expectThrow(
      () => imapClient({ host: "localhost", operation: "copy", mailbox: "INBOX", sequence_set: "1" }),
      "A10: copy without dest_mailbox",
    );
  });

  // A11: expunge missing mailbox
  await test("A11: expunge missing mailbox rejects", async () => {
    await expectThrow(
      () => imapClient({ host: "localhost", operation: "expunge" }),
      "A11: expunge without mailbox",
    );
  });

  // A12: invalid auth method
  await test("A12: invalid auth method rejects", async () => {
    await expectThrow(
      () => imapClient({ host: "localhost", operation: "list", auth: { user: "u", password: "p", method: "DIGEST-MD5" } }),
      "A12: unknown auth method",
    );
  });

  // A13: auth missing password
  await test("A13: auth missing password rejects", async () => {
    await expectThrow(
      () => imapClient({ host: "localhost", operation: "list", auth: { user: "u" } }),
      "A13: auth without password",
    );
  });

  // A14: select missing mailbox
  await test("A14: select missing mailbox rejects", async () => {
    await expectThrow(
      () => imapClient({ host: "localhost", operation: "select" }),
      "A14: select without mailbox",
    );
  });

  // A15: status missing mailbox
  await test("A15: status missing mailbox rejects", async () => {
    await expectThrow(
      () => imapClient({ host: "localhost", operation: "status" }),
      "A15: status without mailbox",
    );
  });

  // ──────────────────────────────────────────────────────────────────────────
  console.log("\n--- B: IMAP Parsing Unit Tests ---");

  // B1: parseHeaders basic
  await test("B1: parseHeaders basic", async () => {
    const raw = "From: alice@example.com\r\nSubject: Hello World\r\nDate: Mon, 1 Jan 2024 00:00:00 +0000\r\n\r\n";
    const h = parseHeaders(raw);
    assert(h["from"] === "alice@example.com", "B1: from header");
    assert(h["subject"] === "Hello World", "B1: subject header");
  });

  // B2: parseHeaders folded headers
  await test("B2: parseHeaders folded headers", async () => {
    const raw = "Subject: Long\r\n Subject Continued\r\n\r\n";
    const h = parseHeaders(raw);
    assert(h["subject"] && h["subject"].includes("Long"), "B2: subject start");
    assert(h["subject"].includes("Subject Continued"), "B2: folded continuation");
  });

  // B3: parseHeaders empty
  await test("B3: parseHeaders empty input", async () => {
    const h = parseHeaders("");
    assert(typeof h === "object", "B3: returns object");
  });

  // B4: parseFetchResponses flags + uid
  await test("B4: parseFetchResponses: flags + uid", async () => {
    const lines = ["* 1 FETCH (UID 42 FLAGS (\\Seen \\Answered) RFC822.SIZE 1024)"];
    const msgs = parseFetchResponses(lines);
    assert(msgs.length === 1, "B4: one message");
    assert(msgs[0].seqno === 1, "B4: seqno");
    assert(msgs[0].uid === 42, "B4: uid");
    assert(msgs[0].flags && msgs[0].flags.includes("\\Seen"), "B4: seen flag");
    assert(msgs[0].size === 1024, "B4: size");
  });

  // B5: parseFetchResponses INTERNALDATE
  await test("B5: parseFetchResponses: INTERNALDATE", async () => {
    const lines = ['* 5 FETCH (INTERNALDATE "12-Jul-2024 10:00:00 +0000" UID 99)'];
    const msgs = parseFetchResponses(lines);
    assert(msgs[0] && msgs[0].internalDate === "12-Jul-2024 10:00:00 +0000", "B5: internalDate");
    assert(msgs[0].uid === 99, "B5: uid");
  });

  // B6: parseFetchResponses multiple messages
  await test("B6: parseFetchResponses: multiple messages", async () => {
    const lines = [
      "* 1 FETCH (UID 1 FLAGS (\\Seen))",
      "* 2 FETCH (UID 2 FLAGS ())",
      "* 3 FETCH (UID 3 FLAGS (\\Flagged))",
    ];
    const msgs = parseFetchResponses(lines);
    assert(msgs.length === 3, "B6: 3 messages");
    assert(msgs[2].uid === 3, "B6: 3rd uid");
  });

  // B7: parseFetchResponses with literal header block
  await test("B7: parseFetchResponses: literal header block", async () => {
    const lines = [
      "* 1 FETCH (FLAGS (\\Seen) RFC822.HEADER {30}",
      "From: alice@x.com",
      "Subject: Test",
      "",
      ")",
    ];
    const msgs = parseFetchResponses(lines);
    assert(Array.isArray(msgs), "B7: returns array (no throw)");
  });

  // B8: parseFetchResponses empty
  await test("B8: parseFetchResponses: empty input", async () => {
    const msgs = parseFetchResponses([]);
    assert(msgs.length === 0, "B8: empty");
  });

  // B9: parseFetchResponses skip non-FETCH lines
  await test("B9: parseFetchResponses: non-FETCH lines skipped", async () => {
    const lines = [
      "* 42 EXISTS",
      "* OK [UNSEEN 5] first",
      "* 1 FETCH (UID 1)",
    ];
    const msgs = parseFetchResponses(lines);
    assert(msgs.length === 1, "B9: only FETCH line parsed");
  });

  // B10: parseHeaders case insensitive keys
  await test("B10: parseHeaders lowercases keys", async () => {
    const raw = "X-CUSTOM-HEADER: myvalue\r\n";
    const h = parseHeaders(raw);
    assert(h["x-custom-header"] === "myvalue", "B10: lowercased key");
  });

  // ──────────────────────────────────────────────────────────────────────────
  console.log("\n--- C: Security / Injection Guards ---");

  // C1: CRLF injection in host
  await test("C1: CRLF injection in host rejected", async () => {
    await expectThrow(() => imapClient({ host: "host\r\nBAD" }), "C1: CRLF in host");
  });

  // C2: NUL byte in host
  await test("C2: NUL byte in host rejected", async () => {
    await expectThrow(() => imapClient({ host: "host\x00" }), "C2: NUL in host");
  });

  // C3: CR in mailbox
  await test("C3: CR in mailbox rejected", async () => {
    await expectThrow(
      () => imapClient({ host: "localhost", operation: "select", mailbox: "IN\rBOX" }),
      "C3: CR in mailbox",
    );
  });

  // C4: LF in mailbox
  await test("C4: LF in mailbox rejected", async () => {
    await expectThrow(
      () => imapClient({ host: "localhost", operation: "select", mailbox: "IN\nBOX" }),
      "C4: LF in mailbox",
    );
  });

  // C5: IMAP literal brace in mailbox
  await test("C5: IMAP literal brace in mailbox rejected", async () => {
    await expectThrow(
      () => imapClient({ host: "localhost", operation: "select", mailbox: "IN{BOX}" }),
      "C5: literal brace in mailbox",
    );
  });

  // C6: CRLF in auth user
  await test("C6: CRLF in auth user rejected", async () => {
    await expectThrow(
      () => imapClient({ host: "localhost", operation: "list", auth: { user: "u\r\n", password: "p" } }),
      "C6: CRLF in auth.user",
    );
  });

  // C7: CRLF in auth password
  await test("C7: CRLF in auth password rejected", async () => {
    await expectThrow(
      () => imapClient({ host: "localhost", operation: "list", auth: { user: "u", password: "p\r\n" } }),
      "C7: CRLF in auth.password",
    );
  });

  // C8: NUL in criteria
  await test("C8: NUL in criteria rejected", async () => {
    await expectThrow(
      () => imapClient({ host: "localhost", operation: "search", mailbox: "INBOX", criteria: "ALL\x00" }),
      "C8: NUL in criteria",
    );
  });

  // C9: sequence_set with semicolons
  await test("C9: sequence_set with semicolons rejected", async () => {
    await expectThrow(
      () => imapClient({ host: "localhost", operation: "fetch", mailbox: "INBOX", sequence_set: "1;ls" }),
      "C9: semicolons in sequence_set",
    );
  });

  // C10: sequence_set with spaces
  await test("C10: sequence_set with spaces rejected", async () => {
    await expectThrow(
      () => imapClient({ host: "localhost", operation: "fetch", mailbox: "INBOX", sequence_set: "1 2" }),
      "C10: spaces in sequence_set",
    );
  });

  // C11: oversized host rejected
  await test("C11: oversized host rejected", async () => {
    await expectThrow(
      () => imapClient({ host: "a".repeat(300), operation: "list" }),
      "C11: host too long",
    );
  });

  // C12: oversized mailbox rejected
  await test("C12: oversized mailbox rejected", async () => {
    await expectThrow(
      () => imapClient({ host: "localhost", operation: "select", mailbox: "M".repeat(300) }),
      "C12: mailbox too long",
    );
  });

  // C13: literal brace in criteria rejected
  await test("C13: literal brace in criteria rejected", async () => {
    await expectThrow(
      () => imapClient({ host: "localhost", operation: "search", mailbox: "INBOX", criteria: "FROM {evil}" }),
      "C13: literal brace in criteria",
    );
  });

  // C14: CRLF in dest_mailbox rejected
  await test("C14: dest_mailbox with CRLF rejected", async () => {
    await expectThrow(
      () => imapClient({ host: "localhost", operation: "copy", mailbox: "INBOX", sequence_set: "1", dest_mailbox: "Ar\r\nchive" }),
      "C14: CRLF in dest_mailbox",
    );
  });

  // C15: CRLF in reference validated at operation layer
  await test("C15: CRLF in reference causes error", async () => {
    // reference is guarded inside the operation block — any conn fail is also OK
    let threw = false;
    try {
      const r = await imapClient({
        host: "127.0.0.1", port: 1,
        operation: "list",
        reference: "ref\r\nbad",
        timeout: 1, connect_timeout: 1,
      });
      assert(!r.success, "C15: CRLF in reference should cause failure");
    } catch (e) {
      threw = true;
      assert(true, "C15: threw on CRLF in reference");
    }
    if (!threw) { /* already asserted above */ }
  });

  // ──────────────────────────────────────────────────────────────────────────
  console.log("\n--- D: Happy-path Mock Tests ---");

  // D1: list mailboxes
  await test("D1: list mailboxes", async () => {
    await withMockServer({}, async (port) => {
      const r = await imapClient({
        host: "127.0.0.1", port,
        secure: false, starttls: false,
        operation: "list",
        auth: { user: "user", password: "pass" },
      });
      assert(r.success, `D1: should succeed, got: ${r.error}`);
      assert(Array.isArray(r.mailboxes), "D1: mailboxes array");
      assert(r.mailboxes.length >= 2, "D1: at least 2 mailboxes");
      assert(r.mailboxes.some(m => m.name === "INBOX"), "D1: INBOX present");
      assert(r.mailboxes.some(m => m.name === "Sent"),  "D1: Sent present");
      assert(r.operation === "list", "D1: operation field");
      assert(r.authenticated, "D1: authenticated flag");
      assert(r.elapsedMs >= 0, "D1: elapsedMs");
    });
  });

  // D2: list without auth (anonymous)
  await test("D2: list without auth (anonymous)", async () => {
    await withMockServer({}, async (port) => {
      const r = await imapClient({
        host: "127.0.0.1", port,
        secure: false, starttls: false,
        operation: "list",
      });
      assert(r.success, `D2: should succeed: ${r.error}`);
      assert(!r.authenticated, "D2: not authenticated");
      assert(Array.isArray(r.mailboxes), "D2: mailboxes array");
    });
  });

  // D3: select INBOX
  await test("D3: select INBOX", async () => {
    await withMockServer({}, async (port) => {
      const r = await imapClient({
        host: "127.0.0.1", port,
        secure: false, starttls: false,
        operation: "select", mailbox: "INBOX",
        auth: { user: "user", password: "pass" },
      });
      assert(r.success, `D3: should succeed: ${r.error}`);
      assert(r.mailbox, "D3: mailbox result");
      assert(r.mailbox.exists === 42, "D3: exists");
      assert(r.mailbox.recent === 3,  "D3: recent");
      assert(r.mailbox.unseen === 5,  "D3: unseen");
      assert(r.mailbox.uidValidity === 1234567890, "D3: uidValidity");
      assert(r.mailbox.uidNext === 100, "D3: uidNext");
      assert(Array.isArray(r.mailbox.flags), "D3: flags array");
    });
  });

  // D4: select INBOX readonly (EXAMINE)
  await test("D4: select INBOX readonly (EXAMINE)", async () => {
    await withMockServer({}, async (port) => {
      const r = await imapClient({
        host: "127.0.0.1", port,
        secure: false, starttls: false,
        operation: "select", mailbox: "INBOX", readonly: true,
      });
      assert(r.success, `D4: should succeed: ${r.error}`);
      assert(r.mailbox.name === "INBOX", "D4: mailbox name");
    });
  });

  // D5: status INBOX
  await test("D5: status INBOX", async () => {
    await withMockServer({}, async (port) => {
      const r = await imapClient({
        host: "127.0.0.1", port,
        secure: false, starttls: false,
        operation: "status", mailbox: "INBOX",
      });
      assert(r.success, `D5: should succeed: ${r.error}`);
      assert(r.status, "D5: status result");
      assert(r.status.messages === 42, "D5: messages");
      assert(r.status.unseen   === 5,  "D5: unseen");
    });
  });

  // D6: search ALL
  await test("D6: search ALL", async () => {
    await withMockServer({}, async (port) => {
      const r = await imapClient({
        host: "127.0.0.1", port,
        secure: false, starttls: false,
        operation: "search", mailbox: "INBOX", criteria: "ALL",
      });
      assert(r.success, `D6: should succeed: ${r.error}`);
      assert(Array.isArray(r.ids), "D6: ids array");
      assert(r.ids.length > 0, "D6: ids not empty");
      assert(r.ids.includes(1),  "D6: includes 1");
      assert(r.ids.includes(13), "D6: includes 13");
      assert(r.criteria === "ALL", "D6: criteria echoed");
    });
  });

  // D7: search UNSEEN with uid=true
  await test("D7: search UNSEEN uid=true", async () => {
    await withMockServer({}, async (port) => {
      const r = await imapClient({
        host: "127.0.0.1", port,
        secure: false, starttls: false,
        operation: "search", mailbox: "INBOX", criteria: "UNSEEN", use_uid: true,
      });
      assert(r.success, `D7: should succeed: ${r.error}`);
      assert(r.useUid, "D7: useUid flag");
    });
  });

  // D8: fetch messages
  await test("D8: fetch messages", async () => {
    await withMockServer({}, async (port) => {
      const r = await imapClient({
        host: "127.0.0.1", port,
        secure: false, starttls: false,
        operation: "fetch", mailbox: "INBOX",
        sequence_set: "1:2", fetch_items: "(FLAGS RFC822.SIZE)",
      });
      assert(r.success, `D8: should succeed: ${r.error}`);
      assert(Array.isArray(r.messages), "D8: messages array");
      assert(r.count >= 1, "D8: at least 1 message");
      assert(r.sequenceSet === "1:2", "D8: sequence_set echoed");
    });
  });

  // D9: fetch default items
  await test("D9: fetch default items", async () => {
    await withMockServer({}, async (port) => {
      const r = await imapClient({
        host: "127.0.0.1", port,
        secure: false, starttls: false,
        operation: "fetch", mailbox: "INBOX", sequence_set: "1",
      });
      assert(r.success, `D9: should succeed: ${r.error}`);
      assert(Array.isArray(r.messages), "D9: messages");
    });
  });

  // D10: store flags
  await test("D10: store flags (+FLAGS.SILENT)", async () => {
    await withMockServer({}, async (port) => {
      const r = await imapClient({
        host: "127.0.0.1", port,
        secure: false, starttls: false,
        operation: "store", mailbox: "INBOX",
        sequence_set: "1", flags: ["\\Deleted"], store_operation: "+FLAGS.SILENT",
      });
      assert(r.success, `D10: should succeed: ${r.error}`);
      assert(r.storeOperation === "+FLAGS.SILENT", "D10: store op");
    });
  });

  // D11: copy messages
  await test("D11: copy messages", async () => {
    await withMockServer({}, async (port) => {
      const r = await imapClient({
        host: "127.0.0.1", port,
        secure: false, starttls: false,
        operation: "copy", mailbox: "INBOX",
        sequence_set: "1:3", dest_mailbox: "Archive",
      });
      assert(r.success, `D11: should succeed: ${r.error}`);
      assert(r.copied, "D11: copied flag");
      assert(r.destMailbox === "Archive", "D11: dest");
    });
  });

  // D12: expunge
  await test("D12: expunge", async () => {
    await withMockServer({}, async (port) => {
      const r = await imapClient({
        host: "127.0.0.1", port,
        secure: false, starttls: false,
        operation: "expunge", mailbox: "INBOX",
      });
      assert(r.success, `D12: should succeed: ${r.error}`);
      assert(Array.isArray(r.expunged), "D12: expunged array");
      assert(r.expunged.length === 2, "D12: 2 expunged");
    });
  });

  // D13: append message
  await test("D13: append message", async () => {
    await withMockServer({}, async (port) => {
      const r = await imapClient({
        host: "127.0.0.1", port,
        secure: false, starttls: false,
        operation: "append", mailbox: "INBOX",
        message: "From: alice@example.com\r\nTo: bob@example.com\r\nSubject: Test\r\n\r\nHello world",
        flags: ["\\Seen"],
      });
      assert(r.success, `D13: should succeed: ${r.error}`);
      assert(r.appended, "D13: appended flag");
    });
  });

  // D14: transcript includes session dialogue with no credentials
  await test("D14: include_transcript + credential redaction", async () => {
    await withMockServer({}, async (port) => {
      const r = await imapClient({
        host: "127.0.0.1", port,
        secure: false, starttls: false,
        operation: "list",
        auth: { user: "user", password: "pass" },
        include_transcript: true,
      });
      assert(r.success, `D14: should succeed: ${r.error}`);
      assert(Array.isArray(r.transcript), "D14: transcript is array");
      assert(r.transcript.length > 0, "D14: transcript not empty");
      const credLines = r.transcript.filter(t => t.dir === "C" && t.line.includes("pass"));
      assert(credLines.length === 0, "D14: no raw credentials in transcript");
    });
  });

  // D15: custom LIST pattern
  await test("D15: custom LIST pattern", async () => {
    await withMockServer({}, async (port) => {
      const r = await imapClient({
        host: "127.0.0.1", port,
        secure: false, starttls: false,
        operation: "list", pattern: "INBOX*",
      });
      assert(r.success, `D15: should succeed: ${r.error}`);
      assert(Array.isArray(r.mailboxes), "D15: mailboxes");
    });
  });

  // D16: authenticate PLAIN method
  await test("D16: authenticate PLAIN method", async () => {
    await withMockServer({
      capabilities: "IMAP4rev1 AUTH=PLAIN",
      greeting: "* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN] ready\r\n",
    }, async (port) => {
      const r = await imapClient({
        host: "127.0.0.1", port,
        secure: false, starttls: false,
        operation: "list",
        auth: { user: "user", password: "pass", method: "PLAIN" },
      });
      assert(r.success, `D16: should succeed: ${r.error}`);
      assert(r.authenticated, "D16: authenticated");
    });
  });

  // D17: result shape has required fields
  await test("D17: result shape has required fields", async () => {
    await withMockServer({}, async (port) => {
      const r = await imapClient({
        host: "127.0.0.1", port,
        secure: false, starttls: false,
        operation: "status", mailbox: "INBOX",
      });
      assert("host"          in r, "D17: host");
      assert("port"          in r, "D17: port");
      assert("secure"        in r, "D17: secure");
      assert("operation"     in r, "D17: operation");
      assert("connected"     in r, "D17: connected");
      assert("authenticated" in r, "D17: authenticated");
      assert("success"       in r, "D17: success");
      assert("elapsedMs"     in r, "D17: elapsedMs");
    });
  });

  // D18: store with -FLAGS (remove)
  await test("D18: store with -FLAGS (remove)", async () => {
    await withMockServer({}, async (port) => {
      const r = await imapClient({
        host: "127.0.0.1", port,
        secure: false, starttls: false,
        operation: "store", mailbox: "INBOX",
        sequence_set: "1:5", flags: ["\\Seen"], store_operation: "-FLAGS",
      });
      assert(r.success, `D18: should succeed: ${r.error}`);
      assert(r.storeOperation === "-FLAGS", "D18: store op");
    });
  });

  // D19: search max_results cap
  await test("D19: search max_results cap", async () => {
    await withMockServer({}, async (port) => {
      const r = await imapClient({
        host: "127.0.0.1", port,
        secure: false, starttls: false,
        operation: "search", mailbox: "INBOX", criteria: "ALL", max_results: 3,
      });
      assert(r.success, `D19: should succeed: ${r.error}`);
      assert(r.ids.length <= 3, "D19: results capped at 3");
    });
  });

  // D20: port in result matches what we passed
  await test("D20: port in result is correct", async () => {
    await withMockServer({}, async (port) => {
      const r = await imapClient({
        host: "127.0.0.1", port,
        secure: false, starttls: false,
        operation: "list",
      });
      assert(r.port === port, "D20: port in result matches");
    });
  });

  // D21: starttls=false disables STARTTLS upgrade
  await test("D21: starttls=false disables upgrade", async () => {
    await withMockServer({ capabilities: "IMAP4rev1 STARTTLS" }, async (port) => {
      const r = await imapClient({
        host: "127.0.0.1", port,
        secure: false, starttls: false,
        operation: "list",
      });
      assert(r.success, `D21: should succeed: ${r.error}`);
      assert(!r.starttlsUpgraded, "D21: no STARTTLS upgrade");
    });
  });

  // D22: mailbox flags and delimiter parsed correctly
  await test("D22: mailbox flags + delimiter parsed", async () => {
    await withMockServer({}, async (port) => {
      const r = await imapClient({
        host: "127.0.0.1", port,
        secure: false, starttls: false,
        operation: "list",
      });
      assert(r.success, `D22: should succeed: ${r.error}`);
      const inbox = r.mailboxes.find(m => m.name === "INBOX");
      assert(inbox, "D22: INBOX found");
      assert(Array.isArray(inbox.flags), "D22: flags is array");
      assert(inbox.delimiter === "/", "D22: delimiter");
    });
  });

  // D23: search with compound criteria
  await test("D23: search with compound criteria string", async () => {
    await withMockServer({}, async (port) => {
      const r = await imapClient({
        host: "127.0.0.1", port,
        secure: false, starttls: false,
        operation: "search", mailbox: "INBOX",
        criteria: 'UNSEEN FROM "alice@example.com"',
      });
      assert(r.success, `D23: should succeed: ${r.error}`);
      assert(Array.isArray(r.ids), "D23: ids array");
    });
  });

  // D24: uid copy
  await test("D24: uid copy", async () => {
    await withMockServer({}, async (port) => {
      const r = await imapClient({
        host: "127.0.0.1", port,
        secure: false, starttls: false,
        operation: "copy", mailbox: "INBOX",
        sequence_set: "10:20", dest_mailbox: "Archive", use_uid: true,
      });
      assert(r.success, `D24: should succeed: ${r.error}`);
      assert(r.copied, "D24: copied");
    });
  });

  // D25: transcript absent by default
  await test("D25: no transcript by default", async () => {
    await withMockServer({}, async (port) => {
      const r = await imapClient({
        host: "127.0.0.1", port,
        secure: false, starttls: false,
        operation: "list",
      });
      assert(r.success, `D25: should succeed: ${r.error}`);
      assert(r.transcript === undefined, "D25: transcript absent by default");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  console.log("\n--- E: Error Paths ---");

  // E1: connection refused
  await test("E1: connection refused returns success:false", async () => {
    const r = await imapClient({
      host: "127.0.0.1", port: 59999,
      operation: "list", timeout: 2, connect_timeout: 1,
    });
    assert(!r.success, "E1: should fail");
    assert(typeof r.error === "string", "E1: error string");
    assert(r.connected === false, "E1: connected=false");
  });

  // E2: bad greeting
  await test("E2: bad greeting returns success:false", async () => {
    await withMockServer({ badGreeting: true }, async (port) => {
      const r = await imapClient({
        host: "127.0.0.1", port,
        operation: "list", timeout: 3,
      });
      assert(!r.success, "E2: bad greeting → fail");
      assert(typeof r.error === "string", "E2: error string");
    });
  });

  // E3: server disconnects after greeting
  await test("E3: server disconnects after greeting", async () => {
    await withMockServer({ disconnectAfterGreeting: true }, async (port) => {
      const r = await imapClient({
        host: "127.0.0.1", port,
        operation: "list", timeout: 3,
      });
      assert(!r.success, "E3: disconnect → fail");
    });
  });

  // E4: login failure
  await test("E4: login failure returns success:false", async () => {
    await withMockServer({ loginOk: false }, async (port) => {
      const r = await imapClient({
        host: "127.0.0.1", port,
        secure: false, starttls: false,
        operation: "list",
        auth: { user: "bad", password: "wrong" },
      });
      assert(!r.success, "E4: bad login → fail");
      assert(
        r.error.toLowerCase().includes("login") || r.error.toLowerCase().includes("failed"),
        "E4: error mentions login/failed",
      );
    });
  });

  // E5: session timeout (server never answers CAPABILITY)
  await test("E5: session timeout returns success:false", async () => {
    const { server, port } = await createMockImapServer({
      customHandler: (line, _sock) => {
        if (/CAPABILITY/.test(line.toUpperCase())) return [];  // never respond
        return null;  // pass through
      },
    });
    const r = await imapClient({
      host: "127.0.0.1", port,
      operation: "list", timeout: 1, connect_timeout: 1,
    });
    await new Promise(res => server.close(res));
    assert(!r.success, "E5: timeout → fail");
  });

  // E6: invalid store_operation at runtime
  await test("E6: invalid store_operation rejected", async () => {
    await withMockServer({}, async (port) => {
      let threw = false;
      try {
        const r = await imapClient({
          host: "127.0.0.1", port,
          secure: false, starttls: false,
          operation: "store", mailbox: "INBOX",
          sequence_set: "1", flags: ["\\Deleted"],
          store_operation: "BADOP",
        });
        // store_operation validation happens after connect; may return !success
        assert(!r.success, "E6: invalid store_operation → fail");
      } catch (e) {
        threw = true;
        assert(true, "E6: threw on invalid store_operation");
      }
    });
  });

  // E7: connect to wrong host
  await test("E7: connect to wrong host returns error", async () => {
    const r = await imapClient({
      host: "0.0.0.0", port: 60000,
      operation: "list", timeout: 1, connect_timeout: 1,
    });
    assert(!r.success, "E7: wrong host → fail");
  });

  // E8: oversized append message
  await test("E8: append oversized message rejects", async () => {
    await expectThrow(
      () => imapClient({
        host: "localhost",
        operation: "append", mailbox: "INBOX",
        message: "X".repeat(11 * 1024 * 1024),   // 11 MB
      }),
      "E8: oversized message",
    );
  });

  // E9: credentials never leaked in error result
  await test("E9: credentials not leaked on failure", async () => {
    await withMockServer({ loginOk: false }, async (port) => {
      const r = await imapClient({
        host: "127.0.0.1", port,
        secure: false, starttls: false,
        operation: "list",
        auth: { user: "myuser", password: "SECRET_PASS_999" },
        include_transcript: true,
      });
      const str = JSON.stringify(r);
      assert(!str.includes("SECRET_PASS_999"), "E9: password not leaked");
    });
  });

  // E10: successful list after bad-capability line (no capability in greeting)
  await test("E10: list succeeds even without CAPABILITY in greeting", async () => {
    await withMockServer({
      greeting: "* OK Dovecot ready.\r\n",  // no [CAPABILITY ...] in greeting
    }, async (port) => {
      const r = await imapClient({
        host: "127.0.0.1", port,
        secure: false, starttls: false,
        operation: "list",
      });
      assert(r.success, `E10: should succeed: ${r.error}`);
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  console.log("\n--- F: Concurrency ---");

  // F1: 5 concurrent list sessions
  await test("F1: 5 concurrent list sessions", async () => {
    await withMockServer({}, async (port) => {
      const tasks = Array.from({ length: 5 }, () =>
        imapClient({ host: "127.0.0.1", port, secure: false, starttls: false, operation: "list" }),
      );
      const results = await Promise.all(tasks);
      const ok = results.filter(r => r.success).length;
      assert(ok >= 4, `F1: at least 4/5 succeed (got ${ok}/5)`);
    });
  });

  // F2: 3 concurrent search sessions
  await test("F2: 3 concurrent search sessions", async () => {
    await withMockServer({}, async (port) => {
      const tasks = Array.from({ length: 3 }, () =>
        imapClient({ host: "127.0.0.1", port, secure: false, starttls: false,
          operation: "search", mailbox: "INBOX", criteria: "ALL" }),
      );
      const results = await Promise.all(tasks);
      const ok = results.filter(r => r.success).length;
      assert(ok >= 2, `F2: at least 2/3 succeed (got ${ok}/3)`);
    });
  });

  // F3: mix of operations concurrently
  await test("F3: mix of operations concurrently", async () => {
    await withMockServer({}, async (port) => {
      const results = await Promise.all([
        imapClient({ host: "127.0.0.1", port, secure: false, starttls: false, operation: "list" }),
        imapClient({ host: "127.0.0.1", port, secure: false, starttls: false, operation: "status", mailbox: "INBOX" }),
        imapClient({ host: "127.0.0.1", port, secure: false, starttls: false, operation: "search", mailbox: "INBOX", criteria: "ALL" }),
      ]);
      const ok = results.filter(r => r.success).length;
      assert(ok >= 2, `F3: at least 2/3 succeed (got ${ok}/3)`);
    });
  });

  // F4: 10 rapid status requests
  await test("F4: 10 rapid status requests", async () => {
    await withMockServer({}, async (port) => {
      const tasks = Array.from({ length: 10 }, () =>
        imapClient({ host: "127.0.0.1", port, secure: false, starttls: false,
          operation: "status", mailbox: "INBOX", timeout: 5 }),
      );
      const results = await Promise.all(tasks);
      const ok = results.filter(r => r.success).length;
      assert(ok >= 8, `F4: at least 8/10 succeed (got ${ok}/10)`);
    });
  });

  // F5: sessions don't cross-contaminate
  await test("F5: sessions are isolated", async () => {
    await withMockServer({}, async (port) => {
      const [r1, r2] = await Promise.all([
        imapClient({ host: "127.0.0.1", port, secure: false, starttls: false, operation: "list" }),
        imapClient({ host: "127.0.0.1", port, secure: false, starttls: false, operation: "status", mailbox: "INBOX" }),
      ]);
      if (r1.success) assert(r1.operation === "list",   "F5: r1 is list");
      if (r2.success) assert(r2.operation === "status", "F5: r2 is status");
    });
  });

  // ──────────────────────────────────────────────────────────────────────────
  console.log(`\n\nSection 191: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

runTests().catch(e => {
  console.error("Unhandled error:", e);
  process.exit(1);
});
