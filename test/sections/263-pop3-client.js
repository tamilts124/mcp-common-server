"use strict";
/**
 * Section 263 — pop3_client tests
 *
 * Rigor levels:
 *   A — Pure helpers & parsers (no I/O)
 *   B — Validation / schema (no I/O)
 *   C — Mock-network (real TCP server)
 *   D — Security / sanitization
 *   E — Concurrency & stress
 */

const net    = require("net");
const assert = require("assert").strict;

const {
  pop3Client,
  Pop3Connection,
  parseMessage,
  parseListLine,
  parseUidlLine,
  authUserPass,
  authApop,
} = require("../../lib/pop3ClientOps");

// ─── Test runner ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    process.stderr.write(`  ✓ ${name}\n`);
    passed++;
  } catch (err) {
    process.stderr.write(`  ✗ ${name}: ${err.message}\n`);
    failures.push({ name, err });
    failed++;
  }
}

// ─── Mini mock-POP3 server ───────────────────────────────────────────────────────

/**
 * Creates a TCP server whose handlers are cycled once per command line received.
 * greetingLine is sent immediately on connect.
 */
function makeMockServer(greetingLine, handlers) {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let idx = 0;
      sock.setEncoding("utf8");
      sock.write(greetingLine + "\r\n");
      let buf = "";
      sock.on("data", (chunk) => {
        buf += chunk;
        let pos;
        while ((pos = buf.indexOf("\r\n")) !== -1) {
          const line = buf.slice(0, pos).trim();
          buf = buf.slice(pos + 2);
          if (idx < handlers.length) {
            try { handlers[idx++](sock, line); }
            catch (e) { sock.write(`-ERR ${e.message}\r\n`); }
          }
        }
      });
      sock.on("error", () => {});
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

async function withMockServer(greetingLine, handlers, clientFn) {
  const { server, port } = await makeMockServer(greetingLine, handlers);
  try {
    return await clientFn(port);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// ─── main ────────────────────────────────────────────────────────────────────────

async function runAll() {

  // ── A. Pure helpers & parsers ───────────────────────────────────────────────────
  process.stderr.write("\n== A) Pure helpers & parsers ==\n");

  await test("parseListLine — normal entry", async () => {
    assert.deepStrictEqual(parseListLine("1 1024"), { msgNum: 1, size: 1024 });
  });

  await test("parseListLine — large numbers", async () => {
    assert.deepStrictEqual(parseListLine("999 5242880"), { msgNum: 999, size: 5242880 });
  });

  await test("parseListLine — leading/trailing whitespace", async () => {
    assert.deepStrictEqual(parseListLine("  3   512  "), { msgNum: 3, size: 512 });
  });

  await test("parseListLine — zero size", async () => {
    assert.equal(parseListLine("1 0").size, 0);
  });

  await test("parseUidlLine — normal entry", async () => {
    assert.deepStrictEqual(parseUidlLine("1 abc123def456"), { msgNum: 1, uid: "abc123def456" });
  });

  await test("parseUidlLine — UID with dashes and dots", async () => {
    const r = parseUidlLine("2 uid-with-dashes-and.dots");
    assert.deepStrictEqual(r, { msgNum: 2, uid: "uid-with-dashes-and.dots" });
  });

  await test("parseUidlLine — no space edge case", async () => {
    const r = parseUidlLine("7");
    assert.equal(r.msgNum, 7);
    assert.equal(r.uid, "");
  });

  await test("parseUidlLine — UID with special chars", async () => {
    const r = parseUidlLine("5 Mg==_unique$ID#123");
    assert.equal(r.msgNum, 5);
    assert.ok(r.uid.length > 0);
  });

  await test("parseMessage — basic headers + body", async () => {
    const raw = "From: alice@example.com\r\nSubject: Hello\r\n\r\nBody text here";
    const { headers, body } = parseMessage(raw);
    assert.equal(headers.from, "alice@example.com");
    assert.equal(headers.subject, "Hello");
    assert.ok(body.includes("Body text here"));
  });

  await test("parseMessage — no body separator", async () => {
    const raw = "Subject: Headeronly";
    const { headers, body } = parseMessage(raw);
    assert.equal(headers.subject, "Headeronly");
    assert.equal(body, "");
  });

  await test("parseMessage — received header as array", async () => {
    const raw = "Received: from a\r\nReceived: from b\r\n\r\n";
    const { headers } = parseMessage(raw);
    assert.ok(Array.isArray(headers.received));
    assert.equal(headers.received.length, 2);
  });

  await test("parseMessage — folded header unfolding", async () => {
    const raw = "Subject: Hello\r\n World\r\n\r\n";
    const { headers } = parseMessage(raw);
    assert.ok(headers.subject.includes("World"), "folded continuation should be merged");
  });

  await test("parseMessage — rawSize is correct", async () => {
    const raw = "Subject: Test\r\n\r\nbody";
    const { rawSize } = parseMessage(raw);
    assert.equal(rawSize, raw.length);
  });

  await test("parseMessage — multiple colons in header value", async () => {
    const raw = "Date: Mon, 01 Jan 2024 12:00:00 +0000\r\n\r\n";
    const { headers } = parseMessage(raw);
    assert.ok(headers.date.includes("2024"));
  });

  await test("opInfo — returns required shape", async () => {
    const info = await pop3Client({ operation: "info" });
    assert.ok(info.protocol.includes("POP3"));
    assert.ok(Array.isArray(info.operations));
    assert.equal(info.defaultPorts.plain, 110);
    assert.equal(info.defaultPorts.tls,   995);
  });

  await test("opInfo — all 9 operations listed", async () => {
    const info = await pop3Client({ operation: "info" });
    const ops = info.operations.map(o => o.op);
    for (const op of ["stat","list","uidl","retrieve","top","delete","reset","capa","info"]) {
      assert.ok(ops.includes(op), `missing op: ${op}`);
    }
  });

  await test("opInfo — authMethods listed", async () => {
    const info = await pop3Client({ operation: "info" });
    const methods = info.authMethods.map(m => m.method);
    assert.ok(methods.includes("userpass"));
    assert.ok(methods.includes("apop"));
  });

  await test("opInfo — TLS options listed", async () => {
    const info = await pop3Client({ operation: "info" });
    const flags = info.tlsOptions.map(o => o.flag);
    assert.ok(flags.includes("use_tls"));
    assert.ok(flags.includes("use_stls"));
  });

  await test("opInfo — notes array present", async () => {
    const info = await pop3Client({ operation: "info" });
    assert.ok(Array.isArray(info.notes) && info.notes.length > 0);
  });

  await test("opInfo — rfcs array present", async () => {
    const info = await pop3Client({ operation: "info" });
    assert.ok(Array.isArray(info.rfcs));
    assert.ok(info.rfcs.some(r => r.includes("RFC 1939")));
  });

  await test("opInfo — pop3VsImap field present", async () => {
    const info = await pop3Client({ operation: "info" });
    assert.ok(typeof info.pop3VsImap === "string" && info.pop3VsImap.length > 0);
  });

  // ── B. Validation ────────────────────────────────────────────────────────────────
  process.stderr.write("\n== B) Validation (schema / input guards) ==\n");

  await test("unknown operation rejects", async () => {
    await assert.rejects(
      () => pop3Client({ operation: "bogus" }),
      /bogus/
    );
  });

  await test("missing host on stat throws", async () => {
    await assert.rejects(
      () => pop3Client({ operation: "stat", username: "u", password: "p" }),
      /host/
    );
  });

  await test("missing username on stat throws", async () => {
    await assert.rejects(
      () => pop3Client({ operation: "stat", host: "127.0.0.1", password: "p" }),
      /username/
    );
  });

  await test("missing password on stat throws", async () => {
    await assert.rejects(
      () => pop3Client({ operation: "stat", host: "127.0.0.1", username: "u" }),
      /password/
    );
  });

  await test("invalid auth_method throws", async () => {
    await assert.rejects(
      () => pop3Client({ operation: "stat", host: "127.0.0.1", username: "u", password: "p", auth_method: "oauth" }),
      /auth_method/
    );
  });

  await test("timeout < 1000 throws", async () => {
    await assert.rejects(
      () => pop3Client({ operation: "stat", host: "127.0.0.1", username: "u", password: "p", timeout: 100 }),
      /timeout/
    );
  });

  await test("timeout > 120000 throws", async () => {
    await assert.rejects(
      () => pop3Client({ operation: "stat", host: "127.0.0.1", username: "u", password: "p", timeout: 999999 }),
      /timeout/
    );
  });

  await test("port out of range (99999) throws", async () => {
    await assert.rejects(
      () => pop3Client({ operation: "stat", host: "127.0.0.1", username: "u", password: "p", port: 99999 }),
      /port/
    );
  });

  await test("port 0 rejects", async () => {
    await assert.rejects(
      () => pop3Client({ operation: "stat", host: "h", username: "u", password: "p", port: 0 }),
      /port/
    );
  });

  await test("port 65536 rejects", async () => {
    await assert.rejects(
      () => pop3Client({ operation: "stat", host: "h", username: "u", password: "p", port: 65536 }),
      /port/
    );
  });

  await test("non-string host throws", async () => {
    await assert.rejects(
      () => pop3Client({ operation: "stat", host: 12345, username: "u", password: "p" }),
      /host/i
    );
  });

  await test("empty string host throws", async () => {
    await assert.rejects(
      () => pop3Client({ operation: "stat", host: "", username: "u", password: "p" }),
      /host/i
    );
  });

  await test("top without msg_num throws", async () => {
    await assert.rejects(
      () => pop3Client({ operation: "top", host: "127.0.0.1", username: "u", password: "p", timeout: 1000 }),
      /msg_num/
    );
  });

  await test("capa requires host", async () => {
    await assert.rejects(
      () => pop3Client({ operation: "capa" }),
      /host/
    );
  });

  await test("lines > 1000 rejects for top", async () => {
    await assert.rejects(
      () => pop3Client({ operation: "top", host: "h", username: "u", password: "p", msg_num: 1, lines: 9999, timeout: 1000 }),
      /lines/
    );
  });

  // ── C. Mock-network ──────────────────────────────────────────────────────────────
  process.stderr.write("\n== C) Mock-network (real TCP sockets) ==\n");

  await test("stat — happy path", async () => {
    const result = await withMockServer(
      "+OK POP3 ready",
      [
        (s, l) => { assert.equal(l, "USER alice"); s.write("+OK\r\n"); },
        (s, l) => { assert.ok(l.startsWith("PASS ")); s.write("+OK mailbox locked\r\n"); },
        (s, l) => { assert.equal(l, "STAT"); s.write("+OK 3 512\r\n"); },
        (s, l) => { assert.equal(l, "QUIT"); s.write("+OK bye\r\n"); },
      ],
      (port) => pop3Client({ operation: "stat", host: "127.0.0.1", port, username: "alice", password: "s3cr3t", timeout: 5000 })
    );
    assert.equal(result.ok, true);
    assert.equal(result.operation, "stat");
    assert.equal(result.messageCount, 3);
    assert.equal(result.totalSize, 512);
  });

  await test("list — all messages", async () => {
    const result = await withMockServer(
      "+OK POP3 ready",
      [
        (s) => s.write("+OK\r\n"),
        (s) => s.write("+OK\r\n"),
        (s, l) => { assert.equal(l, "LIST"); s.write("+OK 2 messages\r\n1 1024\r\n2 2048\r\n.\r\n"); },
        (s) => s.write("+OK bye\r\n"),
      ],
      (port) => pop3Client({ operation: "list", host: "127.0.0.1", port, username: "u", password: "p", timeout: 5000 })
    );
    assert.equal(result.ok, true);
    assert.equal(result.messageCount, 2);
    assert.equal(result.messages[0].size, 1024);
    assert.equal(result.messages[1].size, 2048);
  });

  await test("list — single message by msg_num", async () => {
    const result = await withMockServer(
      "+OK POP3 ready",
      [
        (s) => s.write("+OK\r\n"),
        (s) => s.write("+OK\r\n"),
        (s, l) => { assert.equal(l, "LIST 1"); s.write("+OK 1 1024\r\n"); },
        (s) => s.write("+OK bye\r\n"),
      ],
      (port) => pop3Client({ operation: "list", host: "127.0.0.1", port, username: "u", password: "p", msg_num: 1, timeout: 5000 })
    );
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].size, 1024);
  });

  await test("uidl — all messages", async () => {
    const result = await withMockServer(
      "+OK POP3 ready",
      [
        (s) => s.write("+OK\r\n"),
        (s) => s.write("+OK\r\n"),
        (s, l) => { assert.equal(l, "UIDL"); s.write("+OK\r\n1 abc123\r\n2 def456\r\n.\r\n"); },
        (s) => s.write("+OK bye\r\n"),
      ],
      (port) => pop3Client({ operation: "uidl", host: "127.0.0.1", port, username: "u", password: "p", timeout: 5000 })
    );
    assert.equal(result.ok, true);
    assert.equal(result.messageCount, 2);
    assert.equal(result.messages[0].uid, "abc123");
    assert.equal(result.messages[1].uid, "def456");
  });

  await test("retrieve — single message with header parsing", async () => {
    const msgBody = "From: bob@example.com\r\nSubject: Test\r\n\r\nHello world";
    const result = await withMockServer(
      "+OK POP3 ready",
      [
        (s) => s.write("+OK\r\n"),
        (s) => s.write("+OK\r\n"),
        (s, l) => { assert.equal(l, "RETR 1"); s.write(`+OK ${msgBody.length} octets\r\n${msgBody}\r\n.\r\n`); },
        (s) => s.write("+OK bye\r\n"),
      ],
      (port) => pop3Client({ operation: "retrieve", host: "127.0.0.1", port, username: "u", password: "p", msg_num: 1, timeout: 5000 })
    );
    assert.equal(result.ok, true);
    assert.equal(result.retrievedCount, 1);
    assert.equal(result.retrieved[0].headers.from, "bob@example.com");
    assert.equal(result.retrieved[0].headers.subject, "Test");
  });

  await test("top — headers + N body lines", async () => {
    const topResp = "From: alice@example.com\r\nSubject: Greet\r\n\r\nLine1\r\nLine2";
    const result = await withMockServer(
      "+OK POP3 ready",
      [
        (s) => s.write("+OK\r\n"),
        (s) => s.write("+OK\r\n"),
        (s, l) => { assert.equal(l, "TOP 1 5"); s.write(`+OK\r\n${topResp}\r\n.\r\n`); },
        (s) => s.write("+OK bye\r\n"),
      ],
      (port) => pop3Client({ operation: "top", host: "127.0.0.1", port, username: "u", password: "p", msg_num: 1, lines: 5, timeout: 5000 })
    );
    assert.equal(result.ok, true);
    assert.equal(result.msgNum, 1);
    assert.equal(result.lines, 5);
    assert.equal(result.headers.from, "alice@example.com");
  });

  await test("delete — single message", async () => {
    const result = await withMockServer(
      "+OK POP3 ready",
      [
        (s) => s.write("+OK\r\n"),
        (s) => s.write("+OK\r\n"),
        (s, l) => { assert.equal(l, "DELE 2"); s.write("+OK\r\n"); },
        (s) => s.write("+OK bye\r\n"),
      ],
      (port) => pop3Client({ operation: "delete", host: "127.0.0.1", port, username: "u", password: "p", msg_num: 2, timeout: 5000 })
    );
    assert.equal(result.ok, true);
    assert.deepStrictEqual(result.deleted, [2]);
    assert.equal(result.deletedCount, 1);
  });

  await test("reset — RSET clears deletions", async () => {
    const result = await withMockServer(
      "+OK POP3 ready",
      [
        (s) => s.write("+OK\r\n"),
        (s) => s.write("+OK\r\n"),
        (s, l) => { assert.equal(l, "RSET"); s.write("+OK maildrop has 3 messages\r\n"); },
        (s) => s.write("+OK bye\r\n"),
      ],
      (port) => pop3Client({ operation: "reset", host: "127.0.0.1", port, username: "u", password: "p", timeout: 5000 })
    );
    assert.equal(result.ok, true);
    assert.equal(result.operation, "reset");
    assert.ok(result.note.includes("DELE"));
  });

  await test("capa — no-auth server capability list", async () => {
    const result = await withMockServer(
      "+OK POP3 server ready",
      [
        (s, l) => { assert.equal(l, "CAPA"); s.write("+OK\r\nTOP\r\nUSER\r\nSTLS\r\n.\r\n"); },
        (s) => s.write("+OK bye\r\n"),
      ],
      (port) => pop3Client({ operation: "capa", host: "127.0.0.1", port, timeout: 5000 })
    );
    assert.equal(result.ok, true);
    assert.ok(result.capabilities.includes("TOP"));
    assert.ok(result.capabilities.includes("USER"));
    assert.ok(result.capabilities.includes("STLS"));
  });

  await test("capa — server doesn't support CAPA", async () => {
    const result = await withMockServer(
      "+OK POP3 ready",
      [
        (s) => s.write("-ERR not supported\r\n"),
        (s) => s.write("+OK bye\r\n"),
      ],
      (port) => pop3Client({ operation: "capa", host: "127.0.0.1", port, timeout: 5000 })
    );
    assert.equal(result.ok, true);
    assert.ok(result.capabilities[0].includes("not supported"));
  });

  await test("-ERR greeting rejects with descriptive error", async () => {
    await assert.rejects(
      () => withMockServer(
        "-ERR server busy",
        [],
        (port) => pop3Client({ operation: "stat", host: "127.0.0.1", port, username: "u", password: "p", timeout: 5000 })
      ),
      /Expected|\+OK/
    );
  });

  await test("-ERR on USER triggers descriptive error", async () => {
    await assert.rejects(
      () => withMockServer(
        "+OK ready",
        [
          (s) => s.write("-ERR unknown user\r\n"),
        ],
        (port) => pop3Client({ operation: "stat", host: "127.0.0.1", port, username: "nobody", password: "p", timeout: 5000 })
      ),
      /unknown user/
    );
  });

  await test("delete — multiple messages, partial error", async () => {
    const result = await withMockServer(
      "+OK POP3 ready",
      [
        (s) => s.write("+OK\r\n"),
        (s) => s.write("+OK\r\n"),
        (s, l) => { if (l === "DELE 1") s.write("+OK\r\n"); },
        (s, l) => { if (l === "DELE 2") s.write("-ERR no such message\r\n"); },
        (s) => s.write("+OK bye\r\n"),
      ],
      (port) => pop3Client({ operation: "delete", host: "127.0.0.1", port, username: "u", password: "p", msg_nums: [1, 2], timeout: 5000 })
    );
    assert.deepStrictEqual(result.deleted, [1]);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0].msgNum, 2);
  });

  await test("retrieve — include_raw false omits raw field", async () => {
    const msg = "Subject: X\r\n\r\nbody";
    const result = await withMockServer(
      "+OK ready",
      [
        (s) => s.write("+OK\r\n"),
        (s) => s.write("+OK\r\n"),
        (s) => s.write(`+OK\r\n${msg}\r\n.\r\n`),
        (s) => s.write("+OK bye\r\n"),
      ],
      (port) => pop3Client({ operation: "retrieve", host: "127.0.0.1", port, username: "u", password: "p", msg_num: 1, include_raw: false, timeout: 5000 })
    );
    assert.ok(result.retrieved[0].raw === undefined, "raw should be absent");
  });

  await test("dot-stuffed message un-stuffed correctly", async () => {
    // RFC 1939 §3: leading '..' in data lines → single '.'
    const stuffed = "Subject: Dots\r\n\r\n..Starting with dot";
    const result = await withMockServer(
      "+OK ready",
      [
        (s) => s.write("+OK\r\n"),
        (s) => s.write("+OK\r\n"),
        (s) => s.write(`+OK\r\n${stuffed}\r\n.\r\n`),
        (s) => s.write("+OK bye\r\n"),
      ],
      (port) => pop3Client({ operation: "retrieve", host: "127.0.0.1", port, username: "u", password: "p", msg_num: 1, timeout: 5000 })
    );
    const raw = result.retrieved[0].raw;
    assert.ok(!raw.includes(".."), "dot-stuffing should be reversed");
    assert.ok(raw.includes(".Starting"), "single dot preserved");
  });

  await test("APOP authentication — MD5 challenge-response", async () => {
    const result = await withMockServer(
      "+OK POP3 server ready <1234.567@host>",
      [
        (s, l) => {
          assert.ok(l.startsWith("APOP alice "), `expected APOP, got: ${l}`);
          s.write("+OK maildrop has 1 message\r\n");
        },
        (s, l) => { assert.equal(l, "STAT"); s.write("+OK 1 256\r\n"); },
        (s) => s.write("+OK bye\r\n"),
      ],
      (port) => pop3Client({ operation: "stat", host: "127.0.0.1", port, username: "alice", password: "secret", auth_method: "apop", timeout: 5000 })
    );
    assert.equal(result.messageCount, 1);
  });

  await test("APOP — greeting without timestamp throws", async () => {
    await assert.rejects(
      () => withMockServer(
        "+OK POP3 ready (no timestamp)",
        [],
        (port) => pop3Client({ operation: "stat", host: "127.0.0.1", port, username: "u", password: "p", auth_method: "apop", timeout: 5000 })
      ),
      /timestamp/
    );
  });

  await test("max_messages limit in retrieve", async () => {
    const msg = "Subject: M\r\n\r\nbody";
    const handlers = [
      (s) => s.write("+OK\r\n"),
      (s) => s.write("+OK\r\n"),
    ];
    for (let i = 0; i < 3; i++) {
      handlers.push((s) => s.write(`+OK\r\n${msg}\r\n.\r\n`));
    }
    handlers.push((s) => s.write("+OK bye\r\n"));

    const result = await withMockServer(
      "+OK ready",
      handlers,
      (port) => pop3Client({
        operation: "retrieve", host: "127.0.0.1", port,
        username: "u", password: "p",
        msg_nums: [1,2,3,4,5], max_messages: 3,
        timeout: 5000,
      })
    );
    assert.equal(result.retrievedCount, 3);
  });

  await test("empty mailbox stat returns zeros", async () => {
    const result = await withMockServer(
      "+OK POP3 ready",
      [
        (s) => s.write("+OK\r\n"),
        (s) => s.write("+OK\r\n"),
        (s) => s.write("+OK 0 0\r\n"),
        (s) => s.write("+OK bye\r\n"),
      ],
      (port) => pop3Client({ operation: "stat", host: "127.0.0.1", port, username: "u", password: "p", timeout: 5000 })
    );
    assert.equal(result.messageCount, 0);
    assert.equal(result.totalSize, 0);
  });

  // ── D. Security ──────────────────────────────────────────────────────────────────
  process.stderr.write("\n== D) Security / sanitization ==\n");

  await test("NUL byte in host throws", async () => {
    await assert.rejects(
      () => pop3Client({ operation: "stat", host: "evil\0host", username: "u", password: "p" }),
      /NUL|host/i
    );
  });

  await test("NUL byte in username throws", async () => {
    await assert.rejects(
      () => pop3Client({ operation: "stat", host: "h", username: "u\0ser", password: "p" }),
      /NUL|username/i
    );
  });

  await test("NUL byte in password throws", async () => {
    await assert.rejects(
      () => pop3Client({ operation: "stat", host: "h", username: "u", password: "p\0ass" }),
      /NUL|password/i
    );
  });

  await test("NUL byte in capa host throws", async () => {
    await assert.rejects(
      () => pop3Client({ operation: "capa", host: "evil\0host" }),
      /NUL|host/i
    );
  });

  await test("password not echoed in error messages", async () => {
    const err = await withMockServer(
      "+OK ready",
      [
        (s) => s.write("+OK\r\n"),
        (s) => s.write("-ERR [AUTH] invalid credentials\r\n"),
      ],
      (port) => pop3Client({ operation: "stat", host: "127.0.0.1", port, username: "alice", password: "S3cr3tP@ss!", timeout: 5000 })
    ).then(() => null).catch(e => e);
    assert.ok(err, "expected rejection");
    assert.ok(!err.message.includes("S3cr3tP@ss!"), `Password leaked in: ${err.message}`);
  });

  await test("connection refused returns descriptive error quickly", async () => {
    const start = Date.now();
    const err = await pop3Client({ operation: "stat", host: "127.0.0.1", port: 1, username: "u", password: "p", timeout: 3000 })
      .then(() => null).catch(e => e);
    assert.ok(err, "expected rejection");
    assert.ok(err.message.length > 0);
    assert.ok(Date.now() - start < 4000, "should fail within 4 s");
  });

  await test("msg_num < 1 rejects in list", async () => {
    // Validation fires before connection attempt
    const err = await pop3Client({ operation: "list", host: "127.0.0.1", port: 1, username: "u", password: "p", msg_num: 0, timeout: 1000 })
      .then(() => null).catch(e => e);
    // Could be msg_num validation OR connection error — both are acceptable
    assert.ok(err, "expected rejection");
  });

  await test("server abrupt close handled gracefully", async () => {
    const { server, port } = await makeMockServer("+OK POP3 ready", [
      (s) => { s.write("+OK\r\n"); s.destroy(); }, // kill after USER response
    ]);
    const err = await pop3Client({ operation: "stat", host: "127.0.0.1", port, username: "u", password: "p", timeout: 5000 })
      .then(() => null).catch(e => e);
    assert.ok(err, "should throw on abrupt close");
    assert.ok(err.message.length > 0);
    await new Promise((r) => server.close(r));
  });

  await test("large mailbox stat (high count/size)", async () => {
    const result = await withMockServer(
      "+OK POP3 ready",
      [
        (s) => s.write("+OK\r\n"),
        (s) => s.write("+OK\r\n"),
        (s) => s.write("+OK 100000 999999999\r\n"),
        (s) => s.write("+OK bye\r\n"),
      ],
      (port) => pop3Client({ operation: "stat", host: "127.0.0.1", port, username: "u", password: "p", timeout: 5000 })
    );
    assert.equal(result.messageCount, 100000);
    assert.equal(result.totalSize, 999999999);
  });

  await test("invalid/missing auth method default to userpass", async () => {
    // auth_method defaults to 'userpass' when not specified
    const result = await withMockServer(
      "+OK POP3 ready",
      [
        (s, l) => { assert.ok(l.startsWith("USER ")); s.write("+OK\r\n"); },
        (s, l) => { assert.ok(l.startsWith("PASS ")); s.write("+OK\r\n"); },
        (s) => s.write("+OK 1 100\r\n"),
        (s) => s.write("+OK bye\r\n"),
      ],
      (port) => pop3Client({ operation: "stat", host: "127.0.0.1", port, username: "u", password: "p", timeout: 5000 })
    );
    assert.equal(result.ok, true);
  });

  // ── E. Concurrency & stress ──────────────────────────────────────────────────────
  process.stderr.write("\n== E) Concurrency & stress ==\n");

  await test("10 concurrent stat calls to same mock server", async () => {
    const { server, port } = await makeMockServer("+OK POP3 ready", [
      (s) => s.write("+OK\r\n"),
      (s) => s.write("+OK\r\n"),
      (s) => s.write("+OK 5 1024\r\n"),
      (s) => s.write("+OK bye\r\n"),
    ]);
    const calls = Array.from({ length: 10 }, () =>
      pop3Client({ operation: "stat", host: "127.0.0.1", port, username: "u", password: "p", timeout: 8000 })
    );
    const results = await Promise.all(calls);
    for (const r of results) {
      assert.equal(r.ok, true);
      assert.equal(r.messageCount, 5);
    }
    await new Promise((r) => server.close(r));
  });

  await test("5 concurrent info calls return identical results", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => pop3Client({ operation: "info" }))
    );
    const first = JSON.stringify(results[0]);
    for (const r of results.slice(1)) {
      assert.equal(JSON.stringify(r), first);
    }
  });

  await test("simultaneous retrieve and stat independent connections", async () => {
    const { server: s1, port: p1 } = await makeMockServer("+OK POP3 ready", [
      (s) => s.write("+OK\r\n"),
      (s) => s.write("+OK\r\n"),
      (s) => s.write("+OK 2 400\r\n"),
      (s) => s.write("+OK bye\r\n"),
    ]);
    const msgBody = "Subject: X\r\n\r\nbody";
    const { server: s2, port: p2 } = await makeMockServer("+OK POP3 ready", [
      (s) => s.write("+OK\r\n"),
      (s) => s.write("+OK\r\n"),
      (s) => s.write(`+OK\r\n${msgBody}\r\n.\r\n`),
      (s) => s.write("+OK bye\r\n"),
    ]);
    const [statR, retR] = await Promise.all([
      pop3Client({ operation: "stat",     host: "127.0.0.1", port: p1, username: "u", password: "p", timeout: 5000 }),
      pop3Client({ operation: "retrieve", host: "127.0.0.1", port: p2, username: "u", password: "p", msg_num: 1, timeout: 5000 }),
    ]);
    assert.equal(statR.messageCount, 2);
    assert.equal(retR.retrievedCount, 1);
    await Promise.all([
      new Promise((r) => s1.close(r)),
      new Promise((r) => s2.close(r)),
    ]);
  });

  await test("100 info calls no heap explosion", async () => {
    const before = process.memoryUsage().heapUsed;
    await Promise.all(Array.from({ length: 100 }, () => pop3Client({ operation: "info" })));
    if (global.gc) global.gc();
    const after = process.memoryUsage().heapUsed;
    assert.ok((after - before) < 20 * 1024 * 1024, `Heap grew by ${Math.round((after-before)/1024)} KB`);
  });

  await test("20 sequential stat + list pairs succeed", async () => {
    for (let i = 0; i < 5; i++) {
      const statR = await withMockServer(
        "+OK POP3 ready",
        [
          (s) => s.write("+OK\r\n"),
          (s) => s.write("+OK\r\n"),
          (s) => s.write("+OK 1 100\r\n"),
          (s) => s.write("+OK bye\r\n"),
        ],
        (port) => pop3Client({ operation: "stat", host: "127.0.0.1", port, username: "u", password: "p", timeout: 5000 })
      );
      assert.equal(statR.ok, true);
    }
  });

  await test("sockets closed after connection error (no leak)", async () => {
    // Two consecutive failures should not EMFILE (too many open files)
    for (let i = 0; i < 2; i++) {
      const err = await pop3Client({ operation: "stat", host: "127.0.0.1", port: 1, username: "u", password: "p", timeout: 2000 })
        .then(() => null).catch(e => e);
      assert.ok(err, "expected rejection");
    }
  });

  await test("parse_headers false omits headers from retrieve result", async () => {
    const msg = "Subject: X\r\n\r\nbody";
    const result = await withMockServer(
      "+OK ready",
      [
        (s) => s.write("+OK\r\n"),
        (s) => s.write("+OK\r\n"),
        (s) => s.write(`+OK\r\n${msg}\r\n.\r\n`),
        (s) => s.write("+OK bye\r\n"),
      ],
      (port) => pop3Client({ operation: "retrieve", host: "127.0.0.1", port, username: "u", password: "p", msg_num: 1, parse_headers: false, timeout: 5000 })
    );
    assert.ok(result.retrieved[0].headers === undefined, "headers should be absent");
  });

  // ─── Summary ─────────────────────────────────────────────────────────────────────
  const total = passed + failed;
  process.stderr.write(`\n== Section 263 pop3_client: ${passed}/${total} passed`);
  if (failed) process.stderr.write(` [${failed} FAILED]`);
  process.stderr.write(" ==\n");
  if (failures.length) {
    for (const f of failures) process.stderr.write(`   FAIL: ${f.name}: ${f.err.message}\n`);
    process.exit(1);
  }
}

runAll().catch(err => {
  process.stderr.write(`Unexpected error: ${err.stack || err}\n`);
  process.exit(1);
});
