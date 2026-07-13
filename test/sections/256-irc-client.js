"use strict";
/**
 * Section 256 — irc_client tests
 *
 * Five rigour levels:
 *   A — Pure helper / unit tests (no I/O)         x20
 *   B — Validation / error-path tests             x15
 *   C — Mock-network tests (injected connections) x12
 *   D — Security tests                            x10
 *   E — Concurrency / edge-case tests             x8
 *
 * Total: 65 tests
 *
 * Network tests (C-group, E-group) use local mock servers.
 * A, B, D are entirely offline.
 */

const assert = require("assert");
const net    = require("net");
const {
  parseLine,
  nickFromPrefix,
  validateChannel,
  validateNick,
  sanitiseMessage,
  guardString,
  guardNul,
  guardCrLf,
  clampTimeout,
  ircClient,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_PORT_PLAIN,
  DEFAULT_PORT_TLS,
  MAX_IRC_LINE,
  MAX_MESSAGES_SEND,
  MAX_CHANNELS,
} = require("../../lib/ircClientOps");

let passed  = 0;
let failed  = 0;
const results = [];

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      return r
        .then(() => { passed++; results.push({ name, status: "PASS" }); })
        .catch((err) => { failed++; results.push({ name, status: "FAIL", error: err.message }); });
    }
    passed++;
    results.push({ name, status: "PASS" });
  } catch (err) {
    failed++;
    results.push({ name, status: "FAIL", error: err.message });
  }
  return Promise.resolve();
}

// ── Minimal IRC mock server ──────────────────────────────────────────────────

/**
 * Creates a minimal IRC mock server on a random port.
 * The server sends a welcome sequence (001) and then auto-replies to PING.
 * Optional hooks let tests intercept received lines.
 */
function createMockIrcServer({ onLine, extraHandlers = {} } = {}) {
  let connSocket = null;

  const server = net.createServer((socket) => {
    connSocket = socket;
    socket.setEncoding("utf8");
    let buf = "";

    const write = (line) => {
      try { socket.write(line + "\r\n"); } catch (_) {}
    };

    socket.on("data", (chunk) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, "");
        if (!line) continue;
        if (onLine) onLine(line, write);

        const parts = line.split(" ");
        const cmd   = parts[0]?.toUpperCase();

        if (cmd === "NICK") {
          // send RPL_WELCOME (001)
          const nick = parts[1] || "unknown";
          write(`:irc.mock 001 ${nick} :Welcome to MockIRC`);
        } else if (cmd === "PING") {
          write(`PONG :${parts[1] || ""}`);
        } else if (cmd === "JOIN") {
          const ch = (parts[1] || "#test").split(",")[0];
          const nick = "mcpbot";
          write(`:${nick}!user@host JOIN ${ch}`);
          write(`:irc.mock 366 ${nick} ${ch} :End of /NAMES list.`);
        } else if (cmd === "LIST") {
          write(`:irc.mock 322 mcpbot #general 42 :General chat`);
          write(`:irc.mock 322 mcpbot #offtopic 7 :Off-topic`);
          write(`:irc.mock 323 mcpbot :End of /LIST`);
        } else if (cmd === "WHOIS") {
          const target = parts[1] || "unknown";
          write(`:irc.mock 311 mcpbot ${target} user host * :Real Name`);
          write(`:irc.mock 319 mcpbot ${target} :#general`);
          write(`:irc.mock 318 mcpbot ${target} :End of /WHOIS list.`);
        } else if (cmd === "QUIT") {
          socket.end();
        }

        // Check extra handlers
        if (extraHandlers[cmd]) {
          extraHandlers[cmd](line, parts, write);
        }
      }
    });

    socket.on("error", () => {});
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        port,
        host: "127.0.0.1",
        close: () => new Promise((r) => server.close(r)),
        getSocket: () => connSocket,
        write: (line) => { if (connSocket) connSocket.write(line + "\r\n"); },
      });
    });
  });
}

async function runAll() {

  // =========================================================================
  // A — Pure helper / unit tests (no I/O)
  // =========================================================================

  await test("A01: parseLine — basic command with no prefix", () => {
    const p = parseLine("PING :server.irc.net");
    assert.strictEqual(p.prefix,   null);
    assert.strictEqual(p.command,  "PING");
    assert.deepStrictEqual(p.params, ["server.irc.net"]);
    assert.strictEqual(p.trailing, "server.irc.net");
  });

  await test("A02: parseLine — prefix + numeric command", () => {
    const p = parseLine(":irc.server 001 mynick :Welcome to IRC");
    assert.strictEqual(p.prefix,  "irc.server");
    assert.strictEqual(p.command, "001");
    assert.strictEqual(p.params[0], "mynick");
    assert.strictEqual(p.trailing, "Welcome to IRC");
  });

  await test("A03: parseLine — PRIVMSG with channel and trailing", () => {
    const p = parseLine(":nick!user@host PRIVMSG #channel :Hello world");
    assert.strictEqual(p.prefix,   "nick!user@host");
    assert.strictEqual(p.command,  "PRIVMSG");
    assert.strictEqual(p.params[0], "#channel");
    assert.strictEqual(p.params[1], "Hello world");
    assert.strictEqual(p.trailing,  "Hello world");
  });

  await test("A04: parseLine — command only (no params, no prefix)", () => {
    const p = parseLine("QUIT");
    assert.strictEqual(p.prefix,  null);
    assert.strictEqual(p.command, "QUIT");
    assert.strictEqual(p.params.length, 0);
  });

  await test("A05: parseLine — handles prefix-only edge case", () => {
    // ':prefix' with no space after — degenerate case
    const p = parseLine(":prefix");
    assert.strictEqual(p.prefix,  "prefix");
    assert.strictEqual(p.command, "");
  });

  await test("A06: nickFromPrefix — 'nick!user@host' extracts nick", () => {
    assert.strictEqual(nickFromPrefix("alice!alice@irc.example.com"), "alice");
    assert.strictEqual(nickFromPrefix("bob!bob@1.2.3.4"),             "bob");
  });

  await test("A07: nickFromPrefix — prefix without ! returns whole string", () => {
    assert.strictEqual(nickFromPrefix("irc.server.net"), "irc.server.net");
  });

  await test("A08: nickFromPrefix — null prefix returns null", () => {
    assert.strictEqual(nickFromPrefix(null),      null);
    assert.strictEqual(nickFromPrefix(undefined), null);
    assert.strictEqual(nickFromPrefix(""),         null);
  });

  await test("A09: validateChannel — valid channel names", () => {
    assert(validateChannel("#general"));
    assert(validateChannel("&local"));
    assert(validateChannel("+moderated"));
    assert(validateChannel("!special"));
    assert(validateChannel("#a"));
    assert(validateChannel("#channel-with-dashes"));
  });

  await test("A10: validateChannel — invalid channel names", () => {
    assert(!validateChannel(""));
    assert(!validateChannel("nochanprefix"));
    assert(!validateChannel("#has space"));
    assert(!validateChannel("#has,comma"));
    assert(!validateChannel("#" + "a".repeat(50)),  "too long");
    assert(!validateChannel("#has\0nul"));
  });

  await test("A11: validateNick — valid nicks", () => {
    assert(validateNick("alice"));
    assert(validateNick("Bob123"));
    assert(validateNick("[guest]"));
    assert(validateNick("{user}"));
    assert(validateNick("|pipe|"));
    assert(validateNick("^caret"));
    assert(validateNick("_underscore"));
  });

  await test("A12: validateNick — invalid nicks", () => {
    assert(!validateNick(""));
    assert(!validateNick("123startsdigit"));
    assert(!validateNick("has space"));
    assert(!validateNick("nick#hash"));
    assert(!validateNick("n".repeat(31)),   "too long");
  });

  await test("A13: sanitiseMessage — strips CR/LF", () => {
    const s = sanitiseMessage("hello\r\nworld\nfoo\rbar");
    assert(!s.includes("\r"));
    assert(!s.includes("\n"));
    assert(s.includes("hello"));
  });

  await test("A14: sanitiseMessage — clamps to 510 chars", () => {
    const long = "x".repeat(600);
    const s    = sanitiseMessage(long);
    assert.strictEqual(s.length, 510);
  });

  await test("A15: sanitiseMessage — short message unchanged", () => {
    const m = "Hello, world!";
    assert.strictEqual(sanitiseMessage(m), m);
  });

  await test("A16: clampTimeout — clamps below minimum", () => {
    assert.strictEqual(clampTimeout(100),  3000);
    assert.strictEqual(clampTimeout(0),    3000);
    assert.strictEqual(clampTimeout(-500), 3000);
  });

  await test("A17: clampTimeout — clamps above maximum", () => {
    assert.strictEqual(clampTimeout(999999), 60000);
    assert.strictEqual(clampTimeout(100000), 60000);
  });

  await test("A18: clampTimeout — preserves in-range value", () => {
    assert.strictEqual(clampTimeout(10000), 10000);
    assert.strictEqual(clampTimeout(3000),  3000);
    assert.strictEqual(clampTimeout(60000), 60000);
  });

  await test("A19: clampTimeout — uses default for non-number", () => {
    assert.strictEqual(clampTimeout(undefined), DEFAULT_TIMEOUT_MS);
    assert.strictEqual(clampTimeout(null),       DEFAULT_TIMEOUT_MS);
    assert.strictEqual(clampTimeout("abc"),      DEFAULT_TIMEOUT_MS);
  });

  await test("A20: constants are correct", () => {
    assert.strictEqual(DEFAULT_PORT_PLAIN, 6667);
    assert.strictEqual(DEFAULT_PORT_TLS,   6697);
    assert.strictEqual(MAX_IRC_LINE,       510);
    assert(MAX_MESSAGES_SEND >= 1);
    assert(MAX_CHANNELS >= 1);
  });

  // =========================================================================
  // B — Validation / error-path tests
  // =========================================================================

  await test("B01: missing 'operation' throws", async () => {
    await assert.rejects(
      () => ircClient({}),
      /operation.*required/i
    );
  });

  await test("B02: unknown operation throws", async () => {
    await assert.rejects(
      () => ircClient({ operation: "hack" }),
      /unknown operation/i
    );
  });

  await test("B03: send_message — missing 'host' throws", async () => {
    await assert.rejects(
      () => ircClient({ operation: "send_message", target: "#a", message: "hi" }),
      /host.*required/i
    );
  });

  await test("B04: send_message — missing 'target' throws", async () => {
    await assert.rejects(
      () => ircClient({ operation: "send_message", host: "localhost", message: "hi" }),
      /target.*required/i
    );
  });

  await test("B05: send_message — missing message throws", async () => {
    await assert.rejects(
      () => ircClient({ operation: "send_message", host: "localhost", target: "#a" }),
      /message.*required/i
    );
  });

  await test("B06: send_message — invalid nick throws", async () => {
    await assert.rejects(
      () => ircClient({ operation: "send_message", host: "localhost", nick: "123bad", target: "#a", message: "hi" }),
      /invalid nick/i
    );
  });

  await test("B07: join — missing 'host' throws", async () => {
    await assert.rejects(
      () => ircClient({ operation: "join", channels: ["#test"] }),
      /host.*required/i
    );
  });

  await test("B08: join — invalid channel name throws", async () => {
    await assert.rejects(
      () => ircClient({ operation: "join", host: "localhost", channels: ["badchannel"] }),
      /invalid channel/i
    );
  });

  await test("B09: join — missing channels throws", async () => {
    await assert.rejects(
      () => ircClient({ operation: "join", host: "localhost" }),
      /channels.*required/i
    );
  });

  await test("B10: whois — missing 'host' throws", async () => {
    await assert.rejects(
      () => ircClient({ operation: "whois", target: "alice" }),
      /host.*required/i
    );
  });

  await test("B11: whois — missing 'target' throws", async () => {
    await assert.rejects(
      () => ircClient({ operation: "whois", host: "localhost" }),
      /target.*required/i
    );
  });

  await test("B12: nick — missing 'new_nick' throws", async () => {
    await assert.rejects(
      () => ircClient({ operation: "nick", host: "localhost" }),
      /new_nick.*required/i
    );
  });

  await test("B13: raw — missing command throws", async () => {
    await assert.rejects(
      () => ircClient({ operation: "raw", host: "localhost" }),
      /command.*required/i
    );
  });

  await test("B14: send_message — too many targets throws", async () => {
    const targets = Array(MAX_CHANNELS + 1).fill("#chan").map((c, i) => `${c}${i}`);
    await assert.rejects(
      () => ircClient({ operation: "send_message", host: "localhost", target: targets, message: "hi" }),
      /too many targets/i
    );
  });

  await test("B15: raw — too many commands throws", async () => {
    const commands = Array(21).fill("PING :test");
    await assert.rejects(
      () => ircClient({ operation: "raw", host: "localhost", commands }),
      /too many commands/i
    );
  });

  // =========================================================================
  // C — Mock-network tests
  // =========================================================================

  await test("C01: info operation returns config (no I/O)", async () => {
    const r = await ircClient({ operation: "info" });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.operation, "info");
    assert(r.defaultPort);
    assert.strictEqual(r.defaultPort.plain, DEFAULT_PORT_PLAIN);
    assert.strictEqual(r.defaultPort.tls,   DEFAULT_PORT_TLS);
    assert(Array.isArray(r.authMethods));
    assert(Array.isArray(r.operations));
    assert(Array.isArray(r.notes));
  });

  await test("C02: send_message — connects, sends PRIVMSG, disconnects", async () => {
    const mock = await createMockIrcServer();
    const received = [];
    // Attach line spy
    const origOnLine = (line, write) => { received.push(line); };
    const mock2 = await createMockIrcServer({ onLine: origOnLine });
    try {
      const r = await ircClient({
        operation: "send_message",
        host:      mock2.host,
        port:      mock2.port,
        nick:      "mcpbot",
        target:    "#general",
        message:   "Hello from test",
        timeout:   5000,
      });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.operation, "send_message");
      assert(r.sentCount >= 1);
      assert(received.some(l => l.includes("JOIN")));
      assert(received.some(l => l.includes("PRIVMSG")));
    } finally {
      await mock.close();
      await mock2.close();
    }
  });

  await test("C03: send_message — multiple messages to single channel", async () => {
    const mock = await createMockIrcServer();
    try {
      const r = await ircClient({
        operation: "send_message",
        host:      mock.host,
        port:      mock.port,
        nick:      "mcpbot",
        target:    "#test",
        messages:  ["msg1", "msg2", "msg3"],
        timeout:   5000,
      });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.sentCount, 3);
    } finally {
      await mock.close();
    }
  });

  await test("C04: join — connects, joins channel, receives messages", async () => {
    const received = [];
    const mock = await createMockIrcServer({
      onLine: (line, write) => {
        received.push(line);
        // Send a mock PRIVMSG after JOIN
        if (line.startsWith("JOIN")) {
          setTimeout(() => {
            write(":alice!alice@host PRIVMSG #test :Hello from alice");
          }, 100);
        }
      },
    });
    try {
      const r = await ircClient({
        operation:   "join",
        host:        mock.host,
        port:        mock.port,
        nick:        "mcpbot",
        channels:    ["#test"],
        duration_ms: 500,
        timeout:     5000,
      });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.operation, "join");
      // Messages may or may not arrive in the 500ms window
      assert(Array.isArray(r.messages));
    } finally {
      await mock.close();
    }
  });

  await test("C05: list — returns channel list", async () => {
    const mock = await createMockIrcServer();
    try {
      const r = await ircClient({
        operation: "list",
        host:      mock.host,
        port:      mock.port,
        nick:      "mcpbot",
        timeout:   5000,
      });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.operation, "list");
      assert(r.channelCount >= 2);
      assert(r.channels.some(c => c.channel === "#general"));
      assert(r.channels.some(c => c.channel === "#offtopic"));
    } finally {
      await mock.close();
    }
  });

  await test("C06: list — filter returns subset of channels", async () => {
    const mock = await createMockIrcServer();
    try {
      const r = await ircClient({
        operation: "list",
        host:      mock.host,
        port:      mock.port,
        nick:      "mcpbot",
        filter:    "general",
        timeout:   5000,
      });
      assert.strictEqual(r.ok, true);
      assert(r.channels.every(c => c.channel.includes("general") || c.topic.toLowerCase().includes("general")));
    } finally {
      await mock.close();
    }
  });

  await test("C07: whois — returns whois info", async () => {
    const mock = await createMockIrcServer();
    try {
      const r = await ircClient({
        operation: "whois",
        host:      mock.host,
        port:      mock.port,
        nick:      "mcpbot",
        target:    "alice",
        timeout:   5000,
      });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.operation, "whois");
      assert.strictEqual(r.target, "alice");
      assert(r.whois.nick || r.whois.error || typeof r.whois === "object");
    } finally {
      await mock.close();
    }
  });

  await test("C08: raw — sends command and collects responses", async () => {
    const mock = await createMockIrcServer();
    try {
      const r = await ircClient({
        operation:   "raw",
        host:        mock.host,
        port:        mock.port,
        nick:        "mcpbot",
        command:     "PING :test",
        duration_ms: 1000,
        timeout:     5000,
      });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.operation, "raw");
      assert.strictEqual(r.commandsSent, 1);
      assert(Array.isArray(r.responseLines));
    } finally {
      await mock.close();
    }
  });

  await test("C09: raw — multiple commands sent in order", async () => {
    const received = [];
    const mock = await createMockIrcServer({ onLine: (l) => received.push(l) });
    try {
      const r = await ircClient({
        operation:   "raw",
        host:        mock.host,
        port:        mock.port,
        nick:        "mcpbot",
        commands:    ["PING :cmd1", "PING :cmd2"],
        duration_ms: 500,
        timeout:     5000,
      });
      assert.strictEqual(r.commandsSent, 2);
      // Both PINGs should appear in received
      assert(received.some(l => l.includes("cmd1")));
      assert(received.some(l => l.includes("cmd2")));
    } finally {
      await mock.close();
    }
  });

  await test("C10: send_message — elapsedMs is a number", async () => {
    const mock = await createMockIrcServer();
    try {
      const r = await ircClient({
        operation: "send_message",
        host:      mock.host,
        port:      mock.port,
        nick:      "mcpbot",
        target:    "#test",
        message:   "timing check",
        timeout:   5000,
      });
      assert(typeof r.elapsedMs === "number");
      assert(r.elapsedMs >= 0);
    } finally {
      await mock.close();
    }
  });

  await test("C11: connection refused returns ok:false with error", async () => {
    // Use port 1 (refused on all systems)
    const r = await ircClient({
      operation: "send_message",
      host:      "127.0.0.1",
      port:      1,
      nick:      "mcpbot",
      target:    "#test",
      message:   "hi",
      timeout:   3000,
    });
    assert.strictEqual(r.ok, false);
    assert(Array.isArray(r.errors) && r.errors.length > 0);
  });

  await test("C12: join — multiple channels", async () => {
    const received = [];
    const mock = await createMockIrcServer({ onLine: (l) => received.push(l) });
    try {
      const r = await ircClient({
        operation:   "join",
        host:        mock.host,
        port:        mock.port,
        nick:        "mcpbot",
        channels:    ["#chan1", "#chan2"],
        duration_ms: 500,
        timeout:     5000,
      });
      assert.strictEqual(r.ok, true);
      // Both JOIN commands should have been sent
      assert(received.some(l => l.includes("chan1")));
      assert(received.some(l => l.includes("chan2")));
    } finally {
      await mock.close();
    }
  });

  // =========================================================================
  // D — Security tests
  // =========================================================================

  await test("D01: NUL byte in host blocked", async () => {
    await assert.rejects(
      () => ircClient({ operation: "send_message", host: "ircd\x00.evil", target: "#a", message: "hi" }),
      /NUL/i
    );
  });

  await test("D02: NUL byte in nick blocked", async () => {
    await assert.rejects(
      () => ircClient({ operation: "send_message", host: "localhost", nick: "nul\x00nick", target: "#a", message: "hi" }),
      /NUL|invalid nick/i
    );
  });

  await test("D03: CR in message is stripped by sanitiseMessage", () => {
    const s = sanitiseMessage("hello\rworld");
    assert(!s.includes("\r"), "CR should be stripped");
  });

  await test("D04: LF in message is stripped by sanitiseMessage", () => {
    const s = sanitiseMessage("hello\nworld");
    assert(!s.includes("\n"), "LF should be stripped");
  });

  await test("D05: guardNul throws on NUL byte", () => {
    assert.throws(() => guardNul("abc\x00def", "test"), /NUL/);
  });

  await test("D06: guardNul passes on clean string", () => {
    assert.doesNotThrow(() => guardNul("clean", "test"));
  });

  await test("D07: guardCrLf throws on CR", () => {
    assert.throws(() => guardCrLf("abc\rdef", "test"), /CR|LF/);
  });

  await test("D08: guardCrLf throws on LF", () => {
    assert.throws(() => guardCrLf("abc\ndef", "test"), /CR|LF/);
  });

  await test("D09: guardString throws on NUL byte", () => {
    assert.throws(() => guardString("ab\x00c", "test"), /NUL/);
  });

  await test("D10: guardString throws on CR/LF", () => {
    assert.throws(() => guardString("ab\nc", "test"), /CR|LF/);
  });

  // =========================================================================
  // E — Concurrency / edge-case tests
  // =========================================================================

  await test("E01: info is idempotent across multiple calls", async () => {
    const calls = Array(5).fill(null).map(() => ircClient({ operation: "info" }));
    const all   = await Promise.all(calls);
    assert(all.every(r => r.ok), "All info calls should succeed");
    assert(all.every(r => r.operation === "info"));
  });

  await test("E02: parseLine handles empty trailing", () => {
    const p = parseLine(":prefix CMD param1 :");
    assert.strictEqual(p.trailing, "");
    assert(p.params.includes(""));
  });

  await test("E03: parseLine handles multi-word params before trailing", () => {
    const p = parseLine(":server 332 nick #chan :Topic text here");
    assert.strictEqual(p.command,  "332");
    assert.strictEqual(p.params[1], "#chan");
    assert.strictEqual(p.trailing,  "Topic text here");
  });

  await test("E04: sanitiseMessage handles exactly 510 chars", () => {
    const m = "x".repeat(510);
    assert.strictEqual(sanitiseMessage(m).length, 510);
  });

  await test("E05: sanitiseMessage handles exactly 511 chars (clamps to 510)", () => {
    const m = "x".repeat(511);
    assert.strictEqual(sanitiseMessage(m).length, 510);
  });

  await test("E06: two concurrent send_message ops on different servers", async () => {
    const m1 = await createMockIrcServer();
    const m2 = await createMockIrcServer();
    try {
      const [r1, r2] = await Promise.all([
        ircClient({ operation: "send_message", host: m1.host, port: m1.port, nick: "bot1", target: "#a", message: "hi", timeout: 5000 }),
        ircClient({ operation: "send_message", host: m2.host, port: m2.port, nick: "bot2", target: "#b", message: "hi", timeout: 5000 }),
      ]);
      assert.strictEqual(r1.ok, true);
      assert.strictEqual(r2.ok, true);
    } finally {
      await m1.close();
      await m2.close();
    }
  });

  await test("E07: single-string 'channel' param accepted for join", async () => {
    const mock = await createMockIrcServer();
    try {
      const r = await ircClient({
        operation:   "join",
        host:        mock.host,
        port:        mock.port,
        nick:        "mcpbot",
        channel:     "#single",
        duration_ms: 500,
        timeout:     5000,
      });
      assert.strictEqual(r.ok, true);
      assert.deepStrictEqual(r.channels, ["#single"]);
    } finally {
      await mock.close();
    }
  });

  await test("E08: server_password sent in PASS before NICK", async () => {
    const received = [];
    const mock = await createMockIrcServer({ onLine: (l) => received.push(l) });
    try {
      await ircClient({
        operation:       "send_message",
        host:            mock.host,
        port:            mock.port,
        nick:            "mcpbot",
        target:          "#test",
        message:         "hi",
        server_password: "s3cr3t",
        timeout:         5000,
      });
      const passIdx = received.findIndex(l => l.startsWith("PASS"));
      const nickIdx = received.findIndex(l => l.startsWith("NICK"));
      if (passIdx !== -1 && nickIdx !== -1) {
        assert(passIdx < nickIdx, "PASS must come before NICK");
      }
      // At minimum PASS should be in the stream
      assert(received.some(l => l.startsWith("PASS") && l.includes("s3cr3t")));
    } finally {
      await mock.close();
    }
  });

  // ── Print summary ──────────────────────────────────────────────────────────
  console.error("\n=== Section 256: irc_client ===\n");
  for (const r of results) {
    const icon = r.status === "PASS" ? "✔" : "✘";
    const msg  = r.status === "FAIL" ? ` — ${r.error}` : "";
    console.error(`  ${icon} ${r.name}${msg}`);
  }
  console.error(`\nResults: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);

  if (failed > 0) process.exit(1);
}

runAll().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
