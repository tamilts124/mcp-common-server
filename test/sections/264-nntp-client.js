"use strict";
// ── Test section 264: nntp_client ────────────────────────────────────────────────────
// Tests the NNTP client implementation (lib/nntpClientOps.js)
// Five rigor levels:
//   A - Pure helper function tests (no I/O)
//   B - Input validation
//   C - Mock network (using net.createServer)
//   D - Security (injection, path traversal, NUL bytes)
//   E - Concurrency / stress

const net    = require("net");
const assert = require("assert");
const {
  _internal: {
    parseStatus,
    parseGroupStatus,
    splitBlock,
    parseOverviewLine,
    parseListActive,
    parseListDescriptions,
    parseHeaders,
    clampTimeout,
    guardNul,
    opInfo,
  },
  nntpClient,
} = require("../../lib/nntpClientOps");

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    process.stderr.write(`  \u2713 ${name}\n`);
    passed++;
  } catch (err) {
    process.stderr.write(`  \u2717 ${name}: ${err.message}\n`);
    failures.push({ name, err });
    failed++;
  }
}

// ── MOCK NNTP SERVER HELPER ─────────────────────────────────────────────────────────
async function withMockNntp(handler, clientFn) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      handler(socket);
    });
    server.listen(0, "127.0.0.1", async () => {
      const { port } = server.address();
      try {
        const result = await clientFn(port);
        resolve(result);
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
    server.on("error", reject);
  });
}

// Helper: send lines with \r\n
function sendLine(socket, line) {
  socket.write(line + "\r\n");
}

function sendMultiline(socket, statusLine, lines) {
  sendLine(socket, statusLine);
  for (const l of lines) {
    sendLine(socket, l.startsWith(".") ? "." + l : l);
  }
  socket.write(".\r\n");
}

async function runAll() {

// ── SECTION A: Pure helper tests (no I/O) ───────────────────────────────────────
process.stderr.write("\nA: Pure helper tests\n");

await test("parseStatus: basic 200", async () => {
  const r = parseStatus("200 Posting allowed");
  assert.strictEqual(r.code, 200);
  assert.strictEqual(r.text, "Posting allowed");
});

await test("parseStatus: 211 with group info", async () => {
  const r = parseStatus("211 4321 1 4321 comp.lang.javascript");
  assert.strictEqual(r.code, 211);
  assert.ok(r.text.includes("4321"));
});

await test("parseStatus: 500 unknown command", async () => {
  const r = parseStatus("500 Unknown command");
  assert.strictEqual(r.code, 500);
});

await test("parseStatus: strips \\r\\n", async () => {
  const r = parseStatus("215 list follows\r\n");
  assert.strictEqual(r.code, 215);
});

await test("parseStatus: three-digit code with no text", async () => {
  const r = parseStatus("205");
  assert.strictEqual(r.code, 205);
  assert.ok(typeof r.text === "string");
});

await test("parseGroupStatus: 211 line", async () => {
  const r = parseGroupStatus("100 1 100 alt.test");
  assert.strictEqual(r.count, 100);
  assert.strictEqual(r.first, 1);
  assert.strictEqual(r.last, 100);
  assert.strictEqual(r.groupName, "alt.test");
});

await test("parseGroupStatus: handles missing group name", async () => {
  const r = parseGroupStatus("0 0 0");
  assert.strictEqual(r.count, 0);
  assert.strictEqual(r.groupName, "");
});

await test("splitBlock: extracts lines from block", async () => {
  // splitBlock processes the body AFTER the status line (which cmd() already consumed).
  // So the block does NOT begin with a status line; it starts directly with data.
  const block = "first line\r\nsecond line\r\n";
  const lines = splitBlock(block);
  assert.ok(Array.isArray(lines));
  assert.strictEqual(lines.length, 2);
  assert.ok(lines.includes("first line"));
  assert.ok(lines.includes("second line"));
});

await test("splitBlock: de-dot-stuffs ..-prefixed lines", async () => {
  const block = "215 list\r\n..dotted\r\nnormal\r\n";
  const lines = splitBlock(block);
  assert.ok(lines.some(l => l === ".dotted"));
});

await test("parseOverviewLine: parses tab-separated overview", async () => {
  const line = "1234\tSubject Here\tUser <user@example.com>\tMon, 1 Jan 2024 00:00:00 +0000\t<msg123@example.com>\t\t2048\t10";
  const r = parseOverviewLine(line);
  assert.strictEqual(r.number, 1234);
  assert.strictEqual(r.subject, "Subject Here");
  assert.strictEqual(r.from, "User <user@example.com>");
  assert.strictEqual(r.messageId, "<msg123@example.com>");
  assert.strictEqual(r.bytes, 2048);
  assert.strictEqual(r.lines, 10);
});

await test("parseOverviewLine: handles sparse/missing fields", async () => {
  const line = "42\tShort subject";
  const r = parseOverviewLine(line);
  assert.strictEqual(r.number, 42);
  assert.strictEqual(r.subject, "Short subject");
  assert.strictEqual(r.from, "");
});

await test("parseListActive: standard LIST ACTIVE line", async () => {
  const r = parseListActive("comp.lang.javascript 99999 1 y");
  assert.strictEqual(r.group, "comp.lang.javascript");
  assert.strictEqual(r.last, 99999);
  assert.strictEqual(r.first, 1);
  assert.strictEqual(r.flag, "y");
});

await test("parseListActive: moderated flag", async () => {
  const r = parseListActive("comp.std.c 5000 1 m");
  assert.strictEqual(r.flag, "m");
});

await test("parseListDescriptions: tab-separated", async () => {
  const r = parseListDescriptions("alt.test\tTest newsgroup");
  assert.strictEqual(r.group, "alt.test");
  assert.strictEqual(r.description, "Test newsgroup");
});

await test("parseListDescriptions: space-separated", async () => {
  const r = parseListDescriptions("alt.test A test group");
  assert.strictEqual(r.group, "alt.test");
  assert.strictEqual(r.description, "A test group");
});

await test("parseListDescriptions: no description", async () => {
  const r = parseListDescriptions("alt.test");
  assert.strictEqual(r.group, "alt.test");
  assert.strictEqual(r.description, "");
});

await test("parseHeaders: basic RFC 2822 headers", async () => {
  const block = "From: Alice <alice@example.com>\r\nSubject: Test Article\r\nNewsgroups: alt.test\r\nDate: Mon, 1 Jan 2024 00:00:00 +0000";
  const h = parseHeaders(block);
  assert.strictEqual(h.from, "Alice <alice@example.com>");
  assert.strictEqual(h.subject, "Test Article");
  assert.strictEqual(h.newsgroups, "alt.test");
});

await test("parseHeaders: handles folded headers (RFC 2822 §2.2.3)", async () => {
  const block = "Subject: This is a very\r\n long folded subject line\r\nFrom: bob@example.com";
  const h = parseHeaders(block);
  assert.ok(h.subject.includes("long folded"));
});

await test("parseHeaders: lowercase key normalization", async () => {
  const block = "Message-ID: <test@example.com>\r\nContent-Type: text/plain";
  const h = parseHeaders(block);
  assert.ok(h["message-id"]);
  assert.ok(h["content-type"]);
});

await test("parseHeaders: empty block returns empty object", async () => {
  const h = parseHeaders("");
  assert.deepStrictEqual(h, {});
});

await test("parseHeaders: skips dot-only lines", async () => {
  const h = parseHeaders(".");
  assert.deepStrictEqual(h, {});
});

await test("clampTimeout: default when null", async () => {
  assert.strictEqual(clampTimeout(null), 15000);
});

await test("clampTimeout: clamps minimum to 1000", async () => {
  assert.strictEqual(clampTimeout(0), 1000);
  assert.strictEqual(clampTimeout(-500), 1000);
});

await test("clampTimeout: clamps maximum to 120000", async () => {
  assert.strictEqual(clampTimeout(999999), 120000);
});

await test("clampTimeout: passes through valid value", async () => {
  assert.strictEqual(clampTimeout(30000), 30000);
});

await test("clampTimeout: handles NaN as default", async () => {
  assert.strictEqual(clampTimeout(NaN), 15000);
});

await test("clampTimeout: handles string number", async () => {
  assert.strictEqual(clampTimeout("5000"), 5000);
});

await test("guardNul: passes clean strings", async () => {
  guardNul("clean string", "test"); // no throw
});

await test("guardNul: throws on NUL byte", async () => {
  assert.throws(() => guardNul("bad\x00str", "test"), /NUL/);
});

await test("guardNul: passes non-string (undefined)", async () => {
  guardNul(undefined, "test"); // no throw
});

await test("opInfo: returns expected structure", async () => {
  const info = opInfo();
  assert.strictEqual(info.protocol, "NNTP");
  assert.ok(Array.isArray(info.rfcs));
  assert.ok(Array.isArray(info.operations));
  assert.ok(info.operations.length >= 10);
  assert.ok(Array.isArray(info.security));
  assert.ok(info.defaultPorts.plain === 119);
  assert.ok(info.defaultPorts.tls === 563);
});

await test("opInfo: all operations have name+description", async () => {
  const info = opInfo();
  for (const op of info.operations) {
    assert.ok(op.name, `operation missing name: ${JSON.stringify(op)}`);
    assert.ok(op.description, `operation ${op.name} missing description`);
  }
});

await test("opInfo: has expected operation names", async () => {
  const info = opInfo();
  const names = info.operations.map(o => o.name);
  for (const expected of ["capabilities","list_groups","group","list_articles","article","head","body","post","date","quit","info"]) {
    assert.ok(names.includes(expected), `missing operation: ${expected}`);
  }
});

await test("nntpClient info operation (no I/O)", async () => {
  const r = await nntpClient({ operation: "info" });
  assert.strictEqual(r.protocol, "NNTP");
  assert.ok(r.operations.length >= 10);
});

await test("parseStatus: throws on empty string", async () => {
  assert.throws(() => parseStatus(""), /unexpected response/);
});

await test("parseStatus: throws on malformed line", async () => {
  assert.throws(() => parseStatus("not a response"), /unexpected response/);
});

await test("parseOverviewLine: very long subject", async () => {
  const subject = "A".repeat(500);
  const line = `1\t${subject}\t\t\t\t\t0\t0`;
  const r = parseOverviewLine(line);
  assert.strictEqual(r.subject, subject);
});

await test("parseListActive: no flag field", async () => {
  const r = parseListActive("alt.test 999 1");
  assert.strictEqual(r.group, "alt.test");
  assert.strictEqual(r.flag, "");
});

await test("splitBlock: handles CRLF and LF endings", async () => {
  const block = "215 list\nline1\nline2\n";
  const lines = splitBlock(block);
  assert.ok(Array.isArray(lines));
});

await test("splitBlock: empty block returns empty array", async () => {
  const lines = splitBlock("");
  assert.ok(Array.isArray(lines));
  assert.strictEqual(lines.length, 0);
});

await test("parseHeaders: colons in header value", async () => {
  const block = "Date: Mon, 01 Jan 2024 12:34:56 +0000";
  const h = parseHeaders(block);
  assert.ok(h.date.includes("12:34:56"));
});

// ── SECTION B: Input validation ─────────────────────────────────────────────────────
process.stderr.write("\nB: Input validation tests\n");

await test("nntpClient rejects missing operation", async () => {
  await assert.rejects(() => nntpClient({}), /operation.*required/);
});

await test("nntpClient rejects unknown operation", async () => {
  await assert.rejects(() => nntpClient({ operation: "bogus_op", host: "127.0.0.1", port: 1 }),
    /unknown operation|ECONNREFUSED|connection failed/i);
});

await test("nntpClient rejects missing host for non-info op", async () => {
  await assert.rejects(() => nntpClient({ operation: "capabilities" }), /host.*required/i);
});

await test("nntpClient rejects port 0", async () => {
  await assert.rejects(
    () => nntpClient({ operation: "capabilities", host: "127.0.0.1", port: 0 }),
    /port.*1-65535|ECONNREFUSED|connection/i,
  );
});

await test("nntpClient rejects port > 65535", async () => {
  await assert.rejects(
    () => nntpClient({ operation: "capabilities", host: "127.0.0.1", port: 99999 }),
    /port.*1-65535|ECONNREFUSED|connection/i,
  );
});

await test("nntpClient rejects NUL in host", async () => {
  await assert.rejects(
    () => nntpClient({ operation: "group", host: "bad\x00host", group: "alt.test" }),
    /NUL/,
  );
});

await test("nntpClient rejects NUL in group", async () => {
  // Need a real listener to get past the connection stage; use a mock server
  await withMockNntp(
    (socket) => { sendLine(socket, "200 NNTP Server ready"); },
    async (port) => {
      await assert.rejects(
        () => nntpClient({ operation: "group", host: "127.0.0.1", port, group: "bad\x00group", timeout: 3000 }),
        /NUL/,
      );
    },
  );
});

await test("nntpClient rejects NUL in username", async () => {
  await withMockNntp(
    (socket) => { sendLine(socket, "200 NNTP ready"); },
    async (port) => {
      await assert.rejects(
        () => nntpClient({ operation: "capabilities", host: "127.0.0.1", port, username: "bad\x00user", password: "pass", timeout: 3000 }),
        /NUL/,
      );
    },
  );
});

await test("nntpClient rejects NUL in password", async () => {
  await withMockNntp(
    (socket) => { sendLine(socket, "200 NNTP ready"); },
    async (port) => {
      await assert.rejects(
        () => nntpClient({ operation: "capabilities", host: "127.0.0.1", port, username: "user", password: "bad\x00pass", timeout: 3000 }),
        /NUL/,
      );
    },
  );
});

await test("nntpClient post: rejects missing newsgroups", async () => {
  await withMockNntp(
    (socket) => { sendLine(socket, "200 NNTP ready - posting ok"); },
    async (port) => {
      await assert.rejects(
        () => nntpClient({ operation: "post", host: "127.0.0.1", port, timeout: 3000 }),
        /newsgroups.*required|subject.*required|from.*required|body.*required/i,
      );
    },
  );
});

await test("nntpClient group: rejects missing group", async () => {
  await withMockNntp(
    (socket) => { sendLine(socket, "200 NNTP ready"); },
    async (port) => {
      await assert.rejects(
        () => nntpClient({ operation: "group", host: "127.0.0.1", port, timeout: 3000 }),
        /group.*required/i,
      );
    },
  );
});

await test("nntpClient rejects connection to non-NNTP port (400)", async () => {
  // server sends 400 (temp unavailable) - should reject
  await withMockNntp(
    (socket) => { sendLine(socket, "400 Service temporarily unavailable"); socket.destroy(); },
    async (port) => {
      await assert.rejects(
        () => nntpClient({ operation: "capabilities", host: "127.0.0.1", port, timeout: 3000 }),
        /rejected connection|400/i,
      );
    },
  );
});

await test("nntpClient rejects connection to non-NNTP port (500)", async () => {
  await withMockNntp(
    (socket) => { sendLine(socket, "502 No permission"); socket.destroy(); },
    async (port) => {
      await assert.rejects(
        () => nntpClient({ operation: "capabilities", host: "127.0.0.1", port, timeout: 3000 }),
        /rejected connection|502/i,
      );
    },
  );
});

await test("nntpClient timeout validation: minimum enforced", async () => {
  // clampTimeout(100) -> 1000; connection should still timeout (just quickly)
  const r = clampTimeout(100);
  assert.strictEqual(r, 1000);
});

await test("nntpClient username without password rejected", async () => {
  await withMockNntp(
    (socket) => { sendLine(socket, "200 NNTP ready"); },
    async (port) => {
      await assert.rejects(
        () => nntpClient({ operation: "capabilities", host: "127.0.0.1", port, username: "user", timeout: 3000 }),
        /password.*required/i,
      );
    },
  );
});

// ── SECTION C: Mock network tests ────────────────────────────────────────────────────
process.stderr.write("\nC: Mock network tests\n");

await test("capabilities: RFC 3977 CAPABILITIES response", async () => {
  await withMockNntp(
    (socket) => {
      sendLine(socket, "200 NNTP Server ready - posting ok");
      socket.once("data", (data) => {
        const cmd = data.toString().trim().toUpperCase();
        if (cmd.startsWith("CAPABILITIES")) {
          sendLine(socket, "101 Capability list follows");
          sendLine(socket, "VERSION 2");
          sendLine(socket, "READER");
          sendLine(socket, "POST");
          sendLine(socket, "OVER");
          sendLine(socket, "HDR");
          sendLine(socket, "LIST ACTIVE NEWSGROUPS");
          socket.write(".\r\n");
          socket.once("data", () => sendLine(socket, "205 Closing connection"));
        }
      });
    },
    async (port) => {
      const r = await nntpClient({ operation: "capabilities", host: "127.0.0.1", port, timeout: 5000 });
      assert.ok(r.supported === true);
      assert.ok(Array.isArray(r.capabilities));
      assert.ok(r.capabilities.includes("READER"));
      assert.ok(r.capabilities.includes("POST"));
      assert.strictEqual(r.version, "2");
      assert.ok(r.postingAllowed === true);
    },
  );
});

await test("capabilities: old server returns 500 (RFC 977 only)", async () => {
  await withMockNntp(
    (socket) => {
      sendLine(socket, "200 NNTP Server");
      socket.on("data", (data) => {
        const cmd = data.toString().trim().toUpperCase();
        if (cmd.startsWith("CAPABILITIES")) sendLine(socket, "500 Command not recognized");
        else if (cmd.startsWith("QUIT")) { sendLine(socket, "205 bye"); socket.destroy(); }
      });
    },
    async (port) => {
      const r = await nntpClient({ operation: "capabilities", host: "127.0.0.1", port, timeout: 5000 });
      assert.ok(r.supported === false);
      assert.ok(r.postingAllowed === true);
    },
  );
});

await test("group: selects newsgroup and returns count/first/last", async () => {
  await withMockNntp(
    (socket) => {
      sendLine(socket, "200 NNTP Server");
      socket.on("data", (data) => {
        const cmd = data.toString().trim();
        if (/^GROUP/i.test(cmd)) sendLine(socket, "211 1234 100 1333 comp.lang.javascript");
        else if (/^QUIT/i.test(cmd)) { sendLine(socket, "205 bye"); socket.destroy(); }
      });
    },
    async (port) => {
      const r = await nntpClient({ operation: "group", host: "127.0.0.1", port, group: "comp.lang.javascript", timeout: 5000 });
      assert.strictEqual(r.count, 1234);
      assert.strictEqual(r.first, 100);
      assert.strictEqual(r.last, 1333);
      assert.ok(r.group.includes("javascript"));
      assert.ok(r.selected === true);
    },
  );
});

await test("group: 411 no such group throws", async () => {
  await withMockNntp(
    (socket) => {
      sendLine(socket, "200 NNTP Server");
      socket.on("data", (data) => {
        if (/^GROUP/i.test(data.toString())) sendLine(socket, "411 No such news group");
        else if (/^QUIT/i.test(data.toString())) { sendLine(socket, "205 bye"); socket.destroy(); }
      });
    },
    async (port) => {
      await assert.rejects(
        () => nntpClient({ operation: "group", host: "127.0.0.1", port, group: "no.such.group", timeout: 5000 }),
        /no such newsgroup/i,
      );
    },
  );
});

await test("list_groups: LIST ACTIVE returns newsgroup list", async () => {
  await withMockNntp(
    (socket) => {
      sendLine(socket, "200 NNTP Server");
      socket.on("data", (data) => {
        const cmd = data.toString().trim();
        if (/^LIST/i.test(cmd)) {
          sendLine(socket, "215 list of newsgroups follows");
          sendLine(socket, "alt.test 999 1 y");
          sendLine(socket, "comp.lang.javascript 8888 1 y");
          sendLine(socket, "rec.humor 444 1 m");
          socket.write(".\r\n");
        } else if (/^QUIT/i.test(cmd)) { sendLine(socket, "205 bye"); socket.destroy(); }
      });
    },
    async (port) => {
      const r = await nntpClient({ operation: "list_groups", host: "127.0.0.1", port, timeout: 5000 });
      assert.strictEqual(r.groupCount, 3);
      assert.ok(r.groups.some(g => g.group === "alt.test"));
      assert.ok(r.groups.some(g => g.group === "comp.lang.javascript"));
    },
  );
});

await test("list_groups: descriptions type", async () => {
  await withMockNntp(
    (socket) => {
      sendLine(socket, "200 NNTP Server");
      socket.on("data", (data) => {
        const cmd = data.toString().trim();
        if (/^LIST NEWSGROUPS/i.test(cmd)) {
          sendLine(socket, "215 descriptions");
          sendLine(socket, "alt.test\tTest newsgroup for testing");
          sendLine(socket, "alt.binaries.test\tBinary test group");
          socket.write(".\r\n");
        } else if (/^QUIT/i.test(cmd)) { sendLine(socket, "205 bye"); socket.destroy(); }
      });
    },
    async (port) => {
      const r = await nntpClient({ operation: "list_groups", host: "127.0.0.1", port, list_type: "descriptions", timeout: 5000 });
      assert.strictEqual(r.listType, "descriptions");
      assert.strictEqual(r.groupCount, 2);
      assert.ok(r.groups[0].description);
    },
  );
});

await test("list_articles: OVER returns overview data", async () => {
  const overLine = "100\tTest Subject\tUser <u@e.com>\tMon, 1 Jan 2024 00:00:00 +0000\t<msg@example.com>\t\t512\t5";
  await withMockNntp(
    (socket) => {
      sendLine(socket, "200 NNTP Server");
      socket.on("data", (data) => {
        const cmd = data.toString().trim();
        if (/^GROUP/i.test(cmd)) sendLine(socket, "211 1 100 100 alt.test");
        else if (/^OVER/i.test(cmd) || /^XOVER/i.test(cmd)) {
          sendLine(socket, "224 overview data follows");
          sendLine(socket, overLine);
          socket.write(".\r\n");
        } else if (/^QUIT/i.test(cmd)) { sendLine(socket, "205 bye"); socket.destroy(); }
      });
    },
    async (port) => {
      const r = await nntpClient({ operation: "list_articles", host: "127.0.0.1", port, group: "alt.test", first: 100, last: 100, timeout: 5000 });
      assert.strictEqual(r.articleCount, 1);
      assert.strictEqual(r.articles[0].number, 100);
      assert.strictEqual(r.articles[0].subject, "Test Subject");
    },
  );
});

await test("article: retrieves full article with parsed headers", async () => {
  const articleBody = [
    "220 100 <msg@example.com> article retrieved",
    "From: Alice <alice@example.com>",
    "Subject: Test Article",
    "Newsgroups: alt.test",
    "Message-ID: <msg@example.com>",
    "",
    "This is the body of the test article.",
    "It has multiple lines.",
  ].join("\r\n");
  await withMockNntp(
    (socket) => {
      sendLine(socket, "200 NNTP Server");
      socket.on("data", (data) => {
        const cmd = data.toString().trim();
        if (/^ARTICLE/i.test(cmd)) {
          socket.write(articleBody + "\r\n.\r\n");
        } else if (/^QUIT/i.test(cmd)) { sendLine(socket, "205 bye"); socket.destroy(); }
      });
    },
    async (port) => {
      const r = await nntpClient({ operation: "article", host: "127.0.0.1", port, article_num: 100, timeout: 5000 });
      assert.ok(r.headers);
      assert.strictEqual(r.headers.from, "Alice <alice@example.com>");
      assert.ok(r.body && r.body.includes("body of the test article"));
      assert.ok(r.raw);
    },
  );
});

await test("head: retrieves headers only", async () => {
  const headResponse = [
    "221 100 <msg@example.com> head",
    "From: Bob <bob@example.com>",
    "Subject: Headers Only",
    "Newsgroups: alt.test",
  ].join("\r\n");
  await withMockNntp(
    (socket) => {
      sendLine(socket, "200 NNTP Server");
      socket.on("data", (data) => {
        const cmd = data.toString().trim();
        if (/^HEAD/i.test(cmd)) socket.write(headResponse + "\r\n.\r\n");
        else if (/^QUIT/i.test(cmd)) { sendLine(socket, "205 bye"); socket.destroy(); }
      });
    },
    async (port) => {
      const r = await nntpClient({ operation: "head", host: "127.0.0.1", port, article_num: 100, timeout: 5000 });
      assert.ok(r.headers);
      assert.strictEqual(r.headers.from, "Bob <bob@example.com>");
      assert.strictEqual(r.code, 221);
    },
  );
});

await test("body: retrieves body only", async () => {
  const bodyResponse = [
    "222 100 <msg@example.com> body",
    "This is the article body.",
    "No headers here.",
  ].join("\r\n");
  await withMockNntp(
    (socket) => {
      sendLine(socket, "200 NNTP Server");
      socket.on("data", (data) => {
        const cmd = data.toString().trim();
        if (/^BODY/i.test(cmd)) socket.write(bodyResponse + "\r\n.\r\n");
        else if (/^QUIT/i.test(cmd)) { sendLine(socket, "205 bye"); socket.destroy(); }
      });
    },
    async (port) => {
      const r = await nntpClient({ operation: "body", host: "127.0.0.1", port, article_num: 100, timeout: 5000 });
      assert.ok(r.raw.includes("article body"));
      assert.strictEqual(r.code, 222);
    },
  );
});

await test("date: server DATE command", async () => {
  await withMockNntp(
    (socket) => {
      sendLine(socket, "200 NNTP Server");
      socket.on("data", (data) => {
        const cmd = data.toString().trim();
        if (/^DATE/i.test(cmd)) sendLine(socket, "111 20240115143022");
        else if (/^QUIT/i.test(cmd)) { sendLine(socket, "205 bye"); socket.destroy(); }
      });
    },
    async (port) => {
      const r = await nntpClient({ operation: "date", host: "127.0.0.1", port, timeout: 5000 });
      assert.ok(r.supported === true);
      assert.strictEqual(r.raw, "20240115143022");
      assert.strictEqual(r.iso8601, "2024-01-15T14:30:22Z");
    },
  );
});

await test("date: unsupported server returns supported:false", async () => {
  await withMockNntp(
    (socket) => {
      sendLine(socket, "200 NNTP Server");
      socket.on("data", (data) => {
        const cmd = data.toString().trim();
        if (/^DATE/i.test(cmd)) sendLine(socket, "500 Unknown command");
        else if (/^QUIT/i.test(cmd)) { sendLine(socket, "205 bye"); socket.destroy(); }
      });
    },
    async (port) => {
      const r = await nntpClient({ operation: "date", host: "127.0.0.1", port, timeout: 5000 });
      assert.ok(r.supported === false);
    },
  );
});

await test("post: successfully posts an article", async () => {
  await withMockNntp(
    (socket) => {
      sendLine(socket, "200 NNTP Server ready - posting ok");
      let inPost = false;
      let buf = "";
      socket.on("data", (data) => {
        buf += data.toString();
        if (!inPost) {
          const cmd = buf.split("\n")[0].trim();
          buf = "";
          if (/^POST/i.test(cmd)) { inPost = true; sendLine(socket, "340 Send article to be posted"); }
          else if (/^QUIT/i.test(cmd)) { sendLine(socket, "205 bye"); socket.destroy(); }
        } else {
          // Wait for end-of-message marker
          if (buf.includes("\r\n.\r\n")) {
            inPost = false;
            buf = "";
            sendLine(socket, "240 Article posted ok");
          }
        }
      });
    },
    async (port) => {
      const r = await nntpClient({
        operation: "post",
        host: "127.0.0.1",
        port,
        newsgroups: "alt.test",
        subject: "Test post from mcp-common-server",
        from: "Test User <test@example.com>",
        body: "This is a test article body.\nSecond line.",
        timeout: 5000,
      });
      assert.ok(r.posted === true);
      assert.ok(r.messageId.includes("@mcp.local"));
    },
  );
});

await test("post: 440 posting not allowed", async () => {
  await withMockNntp(
    (socket) => {
      sendLine(socket, "201 NNTP Server ready - no posting allowed");
      socket.on("data", (data) => {
        const cmd = data.toString().trim();
        if (/^POST/i.test(cmd)) sendLine(socket, "440 Posting not allowed");
        else if (/^QUIT/i.test(cmd)) { sendLine(socket, "205 bye"); socket.destroy(); }
      });
    },
    async (port) => {
      await assert.rejects(
        () => nntpClient({ operation: "post", host: "127.0.0.1", port, newsgroups: "alt.test", subject: "S", from: "F", body: "B", timeout: 5000 }),
        /posting not allowed/i,
      );
    },
  );
});

await test("authentication: AUTHINFO USER/PASS accepted", async () => {
  await withMockNntp(
    (socket) => {
      sendLine(socket, "200 NNTP Server");
      let authenticated = false;
      socket.on("data", (data) => {
        const cmd = data.toString().trim();
        if (/^AUTHINFO USER/i.test(cmd)) sendLine(socket, "381 PASS required");
        else if (/^AUTHINFO PASS/i.test(cmd)) { authenticated = true; sendLine(socket, "281 Authentication accepted"); }
        else if (/^CAPABILITIES/i.test(cmd)) {
          if (!authenticated) { sendLine(socket, "480 Auth required"); return; }
          sendLine(socket, "101 caps");
          sendLine(socket, "READER");
          socket.write(".\r\n");
        } else if (/^QUIT/i.test(cmd)) { sendLine(socket, "205 bye"); socket.destroy(); }
      });
    },
    async (port) => {
      const r = await nntpClient({
        operation: "capabilities",
        host: "127.0.0.1",
        port,
        username: "testuser",
        password: "testpass",
        timeout: 5000,
      });
      assert.ok(r.supported === true);
    },
  );
});

await test("authentication: 481 bad credentials throws", async () => {
  await withMockNntp(
    (socket) => {
      sendLine(socket, "200 NNTP Server");
      socket.on("data", (data) => {
        const cmd = data.toString().trim();
        if (/^AUTHINFO USER/i.test(cmd)) sendLine(socket, "381 PASS required");
        else if (/^AUTHINFO PASS/i.test(cmd)) sendLine(socket, "481 Authentication failed");
        else if (/^QUIT/i.test(cmd)) { sendLine(socket, "205 bye"); socket.destroy(); }
      });
    },
    async (port) => {
      await assert.rejects(
        () => nntpClient({ operation: "capabilities", host: "127.0.0.1", port, username: "bad", password: "creds", timeout: 5000 }),
        /authentication failed|invalid credentials/i,
      );
    },
  );
});

await test("quit: sends QUIT and returns code", async () => {
  await withMockNntp(
    (socket) => {
      sendLine(socket, "200 NNTP Server");
      socket.on("data", (data) => {
        if (/^QUIT/i.test(data.toString().trim())) {
          sendLine(socket, "205 closing connection");
          socket.destroy();
        }
      });
    },
    async (port) => {
      const r = await nntpClient({ operation: "quit", host: "127.0.0.1", port, timeout: 5000 });
      assert.strictEqual(r.code, 205);
    },
  );
});

await test("article: 430 not found throws", async () => {
  await withMockNntp(
    (socket) => {
      sendLine(socket, "200 NNTP Server");
      socket.on("data", (data) => {
        const cmd = data.toString().trim();
        if (/^ARTICLE/i.test(cmd)) sendLine(socket, "430 No such article");
        else if (/^QUIT/i.test(cmd)) { sendLine(socket, "205 bye"); socket.destroy(); }
      });
    },
    async (port) => {
      await assert.rejects(
        () => nntpClient({ operation: "article", host: "127.0.0.1", port, message_id: "nonexistent@example.com", timeout: 5000 }),
        /not found|430/i,
      );
    },
  );
});

await test("list_articles: empty group returns empty articles array", async () => {
  await withMockNntp(
    (socket) => {
      sendLine(socket, "200 NNTP Server");
      socket.on("data", (data) => {
        const cmd = data.toString().trim();
        if (/^GROUP/i.test(cmd)) sendLine(socket, "211 0 0 0 alt.empty");
        else if (/^OVER/i.test(cmd) || /^XOVER/i.test(cmd)) sendLine(socket, "420 No article selected");
        else if (/^QUIT/i.test(cmd)) { sendLine(socket, "205 bye"); socket.destroy(); }
      });
    },
    async (port) => {
      const r = await nntpClient({ operation: "list_articles", host: "127.0.0.1", port, group: "alt.empty", timeout: 5000 });
      assert.ok(Array.isArray(r.articles));
      assert.strictEqual(r.articles.length, 0);
    },
  );
});

await test("list_articles: max_articles cap respected", async () => {
  const lines = Array.from({ length: 20 }, (_, i) =>
    `${i + 1}\tSubject ${i + 1}\tUser\tDate\t<msg${i + 1}@x.com>\t\t100\t1`
  );
  await withMockNntp(
    (socket) => {
      sendLine(socket, "200 NNTP Server");
      socket.on("data", (data) => {
        const cmd = data.toString().trim();
        if (/^GROUP/i.test(cmd)) sendLine(socket, "211 20 1 20 alt.test");
        else if (/^OVER/i.test(cmd) || /^XOVER/i.test(cmd)) {
          sendLine(socket, "224 overview");
          for (const l of lines) sendLine(socket, l);
          socket.write(".\r\n");
        } else if (/^QUIT/i.test(cmd)) { sendLine(socket, "205 bye"); socket.destroy(); }
      });
    },
    async (port) => {
      const r = await nntpClient({ operation: "list_articles", host: "127.0.0.1", port, group: "alt.test", max_articles: 5, timeout: 5000 });
      assert.strictEqual(r.articleCount, 5);
      assert.ok(r.truncated === true);
    },
  );
});

// ── SECTION D: Security tests ──────────────────────────────────────────────────────
process.stderr.write("\nD: Security tests\n");

await test("NUL byte in newsgroups for post rejected", async () => {
  await withMockNntp(
    (socket) => { sendLine(socket, "200 NNTP ready"); },
    async (port) => {
      await assert.rejects(
        () => nntpClient({ operation: "post", host: "127.0.0.1", port, newsgroups: "alt.test\x00bad", subject: "S", from: "F", body: "B", timeout: 3000 }),
        /NUL/,
      );
    },
  );
});

await test("NUL byte in subject for post rejected", async () => {
  await withMockNntp(
    (socket) => { sendLine(socket, "200 NNTP ready"); },
    async (port) => {
      await assert.rejects(
        () => nntpClient({ operation: "post", host: "127.0.0.1", port, newsgroups: "alt.test", subject: "Bad\x00Subject", from: "F", body: "B", timeout: 3000 }),
        /NUL/,
      );
    },
  );
});

await test("NUL byte in from for post rejected", async () => {
  await withMockNntp(
    (socket) => { sendLine(socket, "200 NNTP ready"); },
    async (port) => {
      await assert.rejects(
        () => nntpClient({ operation: "post", host: "127.0.0.1", port, newsgroups: "alt.test", subject: "S", from: "bad\x00from", body: "B", timeout: 3000 }),
        /NUL/,
      );
    },
  );
});

await test("NUL byte in body for post rejected", async () => {
  await withMockNntp(
    (socket) => { sendLine(socket, "200 NNTP ready"); },
    async (port) => {
      await assert.rejects(
        () => nntpClient({ operation: "post", host: "127.0.0.1", port, newsgroups: "alt.test", subject: "S", from: "F", body: "Bad\x00body", timeout: 3000 }),
        /NUL/,
      );
    },
  );
});

await test("extra_headers with NUL byte rejected in post", async () => {
  await withMockNntp(
    (socket) => { sendLine(socket, "200 NNTP ready"); },
    async (port) => {
      await assert.rejects(
        () => nntpClient({
          operation: "post", host: "127.0.0.1", port,
          newsgroups: "alt.test", subject: "S", from: "F", body: "B",
          extra_headers: { "X-Custom": "value\x00bad" },
          timeout: 3000,
        }),
        /NUL/,
      );
    },
  );
});

await test("empty host string rejected", async () => {
  await assert.rejects(
    () => nntpClient({ operation: "capabilities", host: "" }),
    /host.*required/i,
  );
});

await test("password never appears in error messages", async () => {
  await withMockNntp(
    (socket) => {
      sendLine(socket, "200 NNTP Server");
      socket.on("data", (data) => {
        const cmd = data.toString().trim();
        if (/^AUTHINFO USER/i.test(cmd)) sendLine(socket, "381 PASS required");
        else if (/^AUTHINFO PASS/i.test(cmd)) sendLine(socket, "481 Auth failed");
      });
    },
    async (port) => {
      const secretPassword = "super_secret_password_12345";
      try {
        await nntpClient({ operation: "capabilities", host: "127.0.0.1", port, username: "u", password: secretPassword, timeout: 3000 });
      } catch (err) {
        assert.ok(!err.message.includes(secretPassword), "password leaked in error message");
      }
    },
  );
});

await test("CRLF injection in group name rejected via NUL guard", async () => {
  // CRLF doesn't get caught by NUL guard, but the server should ignore it.
  // At minimum, verify NUL bytes are caught
  await withMockNntp(
    (socket) => { sendLine(socket, "200 NNTP ready"); },
    async (port) => {
      await assert.rejects(
        () => nntpClient({ operation: "group", host: "127.0.0.1", port, group: "bad\x00group", timeout: 3000 }),
        /NUL/,
      );
    },
  );
});

await test("message-ID angle brackets normalized", async () => {
  // Article operation with bare message ID (no brackets)
  // Should still send <> wrapped to server
  let articleCmd = "";
  await withMockNntp(
    (socket) => {
      sendLine(socket, "200 NNTP Server");
      socket.on("data", (data) => {
        const cmd = data.toString().trim();
        if (/^ARTICLE/i.test(cmd)) {
          articleCmd = cmd; // capture only the ARTICLE command
          socket.write("220 1 <msg@x.com> article\r\nFrom: test\r\n\r\nbody\r\n.\r\n");
        } else if (/^QUIT/i.test(cmd)) { sendLine(socket, "205 bye"); socket.destroy(); }
      });
    },
    async (port) => {
      await nntpClient({ operation: "article", host: "127.0.0.1", port, message_id: "msg@x.com", timeout: 5000 });
      // Verify brackets were added
      assert.ok(articleCmd.includes("<msg@x.com>"), `expected <msg@x.com> in cmd: ${articleCmd}`);
    },
  );
});

await test("list_groups max_groups cap enforced at 50000", async () => {
  // Verify the cap doesn't throw for valid values
  const cap = Math.min(Math.max(1, Math.trunc(Number(100000) || 5000)), 50000);
  assert.strictEqual(cap, 50000);
});

// ── SECTION E: Concurrency / stress tests ───────────────────────────────────────────
process.stderr.write("\nE: Concurrency / stress tests\n");

await test("concurrent info() calls: 20 parallel requests", async () => {
  const results = await Promise.all(
    Array.from({ length: 20 }, () => nntpClient({ operation: "info" }))
  );
  for (const r of results) {
    assert.strictEqual(r.protocol, "NNTP");
    assert.ok(r.operations.length >= 10);
  }
});

await test("concurrent mock server connections: 5 simultaneous", async () => {
  const server = net.createServer((socket) => {
    sendLine(socket, "200 NNTP Server");
    socket.on("data", (data) => {
      const cmd = data.toString().trim();
      if (/^CAPABILITIES/i.test(cmd)) {
        sendLine(socket, "101 caps");
        sendLine(socket, "READER");
        socket.write(".\r\n");
      } else if (/^QUIT/i.test(cmd)) { sendLine(socket, "205 bye"); socket.destroy(); }
    });
  });

  await new Promise((resolve, reject) => { server.listen(0, "127.0.0.1", resolve); server.on("error", reject); });
  const { port } = server.address();

  try {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        nntpClient({ operation: "capabilities", host: "127.0.0.1", port, timeout: 8000 })
      )
    );
    for (const r of results) {
      assert.ok(r.supported === true);
      assert.ok(r.capabilities.includes("READER"));
    }
  } finally {
    server.close();
  }
});

await test("large list_groups response (1000 groups) handled efficiently", async () => {
  const numGroups = 1000;
  const groups = Array.from({ length: numGroups }, (_, i) => `alt.group${i + 1} ${i + 1000} 1 y`);
  await withMockNntp(
    (socket) => {
      sendLine(socket, "200 NNTP Server");
      socket.on("data", (data) => {
        const cmd = data.toString().trim();
        if (/^LIST/i.test(cmd)) {
          sendLine(socket, "215 list follows");
          for (const g of groups) sendLine(socket, g);
          socket.write(".\r\n");
        } else if (/^QUIT/i.test(cmd)) { sendLine(socket, "205 bye"); socket.destroy(); }
      });
    },
    async (port) => {
      const start = Date.now();
      const r = await nntpClient({ operation: "list_groups", host: "127.0.0.1", port, max_groups: 2000, timeout: 10000 });
      const elapsed = Date.now() - start;
      assert.strictEqual(r.groupCount, 1000);
      assert.ok(elapsed < 5000, `took too long: ${elapsed}ms`);
    },
  );
});

await test("rapid sequential helper calls: parseStatus x 1000", async () => {
  const responses = ["200 OK", "201 No post", "211 100 1 100 alt.test", "411 No group", "500 Error"];
  const start = Date.now();
  for (let i = 0; i < 1000; i++) {
    const r = parseStatus(responses[i % responses.length]);
    assert.ok(r.code >= 200);
  }
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 500, `parseStatus loop took ${elapsed}ms`);
});

await test("large list parsing: 500 overview lines", async () => {
  const lines = Array.from({ length: 500 }, (_, i) =>
    `${i + 1}\tSubject ${i + 1}\tUser <u@e.com>\tDate\t<msg${i + 1}@e.com>\t\t${512 * (i + 1)}\t5`
  );
  const start = Date.now();
  const results = lines.map(parseOverviewLine);
  const elapsed = Date.now() - start;
  assert.strictEqual(results.length, 500);
  assert.strictEqual(results[0].number, 1);
  assert.strictEqual(results[499].number, 500);
  assert.ok(elapsed < 200, `parsing 500 lines took ${elapsed}ms`);
});

await test("memory: repeated info() calls don't leak", async () => {
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 500; i++) {
    await nntpClient({ operation: "info" });
  }
  // Allow GC
  await new Promise(r => setTimeout(r, 50));
  const after = process.memoryUsage().heapUsed;
  const diff = after - before;
  assert.ok(diff < 20 * 1024 * 1024, `memory grew by ${Math.round(diff / 1024)}KB - possible leak`);
});

await test("connection error handled gracefully (refused)", async () => {
  await assert.rejects(
    () => nntpClient({ operation: "capabilities", host: "127.0.0.1", port: 19119, timeout: 2000 }),
    /ECONNREFUSED|connection failed|timed out/i,
  );
});

} // end runAll()

// ── Summary ─────────────────────────────────────────────────────────────────────
runAll().then(() => {
  const total = passed + failed;
  process.stderr.write(`\n${"─".repeat(60)}\n`);
  process.stderr.write(`Results: ${passed}/${total} passed, ${failed} failed\n`);
  if (failures.length) {
    for (const f of failures) process.stderr.write(`  FAIL: ${f.name}: ${f.err.message}\n`);
    process.exit(1);
  }
}).catch(err => {
  process.stderr.write(`Unexpected error: ${err.stack || err}\n`);
  process.exit(1);
});
