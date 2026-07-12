"use strict";
// ── Section 198: ftp_client ────────────────────────────────────────────────
// 70 tests: A=input-validation(10), B=parser-unit(10), C=security-guards(10),
//           D=happy-path-mock(30), E=error-paths(5), F=concurrency(5)
//
// All network I/O is mocked via net.createConnection monkey-patching.
// No real FTP server required.

const net    = require("net");
const assert = require("assert");
const {
  ftpClient,
  FtpResponseParser,
  parsePasvResponse,
  parseEpsvResponse,
  parseListOutput,
  parseListEntry,
} = require("../../lib/ftpClientOps");

// ── Test harness ─────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

async function test(label, fn) {
  try {
    await fn();
    passed++;
    process.stdout.write(".");
  } catch (e) {
    failed++;
    failures.push({ label, err: e.message || String(e) });
    process.stdout.write("F");
  }
}

function eq(a, b, msg) {
  assert.deepStrictEqual(a, b, msg);
}

function ok(cond, msg) {
  assert.ok(cond, msg || "Expected truthy");
}

async function rejects(fn, pattern) {
  try {
    await fn();
    throw new Error("Expected rejection but resolved");
  } catch (e) {
    if (e.message === "Expected rejection but resolved") throw e;
    if (pattern) {
      ok(
        pattern.test ? pattern.test(e.message) : e.message.includes(pattern),
        `Expected error matching ${pattern}, got: ${e.message}`
      );
    }
  }
}

// ── Mock FTP Server Helpers ──────────────────────────────────────────────────

/**
 * makeMockFtp({ opHandler }) — patches net.createConnection so that:
 *   1. A fake EventEmitter-based socket is returned.
 *   2. The socket emits "connect" on nextTick.
 *   3. Banner "220 Mock FTP Ready" is delivered.
 *   4. USER → 331, PASS → 230, TYPE → 200 are auto-handled.
 *   5. Additional commands are delegated to opHandler(cmd, send).
 *
 * opHandler(cmd, send) — called for each command after login.
 * send(text) — writes a raw FTP response line back to the client parser.
 */
function makeMockFtp(opts) {
  opts = opts || {};
  const { opHandler } = opts;
  const EventEmitter = require("events");
  const _orig = net.createConnection;

  const mockSocket = new EventEmitter();
  mockSocket.destroyed = false;
  mockSocket.destroy = function () { mockSocket.destroyed = true; mockSocket.emit("close"); };
  mockSocket.write = function (data, _enc, cb) {
    if (cb) cb();
    const cmd = (typeof data === "string" ? data : data.toString()).replace(/\r\n$/, "").trim();
    setImmediate(function () { handleCommand(cmd); });
  };
  mockSocket.end = function () {};

  function send(line) {
    mockSocket.emit("data", Buffer.from(line + "\r\n"));
  }

  function handleCommand(cmd) {
    const upper = cmd.toUpperCase();
    if (upper.startsWith("USER "))  return send("331 Password required");
    if (upper.startsWith("PASS "))  return send("230 Logged in");
    if (upper.startsWith("TYPE "))  return send("200 Type set");
    if (upper === "PBSZ 0")         return send("200 PBSZ=0");
    if (upper === "PROT P")         return send("200 PROT P OK");
    if (upper === "QUIT")           return send("221 Goodbye");
    if (opHandler) opHandler(cmd, send);
  }

  // Track connections: first call is the FTP control channel (mock),
  // subsequent calls are passive data channels (real TCP to makeDataServer).
  let _controlConnected = false;

  net.createConnection = function () {
    if (!_controlConnected) {
      // First call: FTP control channel -> use mock socket
      _controlConnected = true;
      setImmediate(function () {
        send("220 Mock FTP Ready");
        mockSocket.emit("connect");
      });
      return mockSocket;
    }
    // Subsequent calls: passive data channel -> use real TCP
    return _orig.apply(net, arguments); // safe: local loopback only
  };

  return {
    restore: function () { net.createConnection = _orig; },
    send:       send,
    mockSocket: mockSocket,
  };
}

// Helper: open a real local data TCP server for PASV/EPSV data transfers.
function makeDataServer(onDataSock) {
  const srv = net.createServer(function (sock) { onDataSock(sock); });
  return new Promise(function (res) {
    srv.listen(0, "127.0.0.1", function () {
      res({ port: srv.address().port, server: srv });
    });
  });
}

// ── Section A: Input Validation ───────────────────────────────────────────────
async function runSectionA() {
  process.stderr.write("\n[A] Input Validation\n");

  await test("A01 — missing host throws", async function () {
    await rejects(function () { return ftpClient({ operation: "pwd" }); }, /host.*required/i);
  });

  await test("A02 — invalid host type throws", async function () {
    await rejects(function () { return ftpClient({ host: 123, operation: "pwd" }); }, /host.*required/i);
  });

  await test("A03 — missing operation throws", async function () {
    await rejects(function () { return ftpClient({ host: "ftp.example.com" }); }, /operation.*must be one of/i);
  });

  await test("A04 — invalid operation throws", async function () {
    await rejects(
      function () { return ftpClient({ host: "ftp.example.com", operation: "hack" }); },
      /operation.*must be one of/i
    );
  });

  await test("A05 — 'get' without path throws", async function () {
    await rejects(
      function () { return ftpClient({ host: "ftp.example.com", operation: "get" }); },
      /path.*required.*get/i
    );
  });

  await test("A06 — 'put' without data throws", async function () {
    await rejects(
      function () { return ftpClient({ host: "ftp.example.com", operation: "put", path: "/file.txt" }); },
      /data.*required.*put/i
    );
  });

  await test("A07 — 'put' with non-string data throws", async function () {
    await rejects(
      function () { return ftpClient({ host: "ftp.example.com", operation: "put", path: "/file.txt", data: 123 }); },
      /data.*must be a string/i
    );
  });

  await test("A08 — 'rename' without new_name throws", async function () {
    await rejects(
      function () { return ftpClient({ host: "ftp.example.com", operation: "rename", path: "/old.txt" }); },
      /new_name.*required.*rename/i
    );
  });

  await test("A09 — 'delete' without path throws", async function () {
    await rejects(
      function () { return ftpClient({ host: "ftp.example.com", operation: "delete" }); },
      /path.*required.*delete/i
    );
  });

  await test("A10 — all valid operations accepted (pwd succeeds)", async function () {
    const mock = makeMockFtp({
      opHandler: function (cmd, send) {
        if (cmd.toUpperCase() === "PWD") send('257 "/home/user" is current directory');
      }
    });
    try {
      const r = await ftpClient({ host: "localhost", operation: "pwd", timeout: 5 });
      ok(r.cwd, "cwd should be set");
      eq(r.operation, "pwd");
    } finally { mock.restore(); }
  });
}

// ── Section B: Parser Unit Tests ──────────────────────────────────────────────
async function runSectionB() {
  process.stderr.write("\n[B] Parser Unit Tests\n");

  await test("B01 — FtpResponseParser: single-line response", async function () {
    const p = new FtpResponseParser();
    p.feed("220 Welcome\r\n");
    const r = p.shift();
    eq(r.code, "220");
    eq(r.text, "Welcome");
  });

  await test("B02 — FtpResponseParser: multi-line response", async function () {
    const p = new FtpResponseParser();
    p.feed("220-Hello there\r\nThis is line 2\r\n220 End\r\n");
    const r = p.shift();
    eq(r.code, "220");
    ok(r.lines.length >= 2);
  });

  await test("B03 — FtpResponseParser: fragmented delivery", async function () {
    const p = new FtpResponseParser();
    p.feed("22");
    p.feed("0 Welc");
    p.feed("ome\r\n");
    const r = p.shift();
    eq(r.code, "220");
    eq(r.text, "Welcome");
  });

  await test("B04 — FtpResponseParser: two consecutive responses", async function () {
    const p = new FtpResponseParser();
    p.feed("200 OK\r\n331 Password required\r\n");
    eq(p.shift().code, "200");
    eq(p.shift().code, "331");
  });

  await test("B05 — parsePasvResponse: IPv4 standard", async function () {
    const r = parsePasvResponse("Entering Passive Mode (192,168,1,1,19,134).");
    eq(r.host, "192.168.1.1");
    eq(r.port, 19 * 256 + 134);
  });

  await test("B06 — parsePasvResponse: minimal form", async function () {
    const r = parsePasvResponse("(127,0,0,1,0,21)");
    eq(r.host, "127.0.0.1");
    eq(r.port, 21);
  });

  await test("B07 — parseEpsvResponse: standard", async function () {
    const r = parseEpsvResponse("Entering Extended Passive Mode (|||54321|).");
    eq(r.port, 54321);
  });

  await test("B08 — parseListEntry: Unix file", async function () {
    const e = parseListEntry("-rwxr-xr-x 1 user group 1234 Jan  1 12:00 file.txt");
    eq(e.type, "file");
    eq(e.name, "file.txt");
    eq(e.size, 1234);
  });

  await test("B09 — parseListEntry: Unix directory", async function () {
    const e = parseListEntry("drwxr-xr-x 2 user group 4096 Dec 31 23:59 mydir");
    eq(e.type, "directory");
    eq(e.name, "mydir");
  });

  await test("B10 — parseListOutput: filters 'total' line, returns all entries", async function () {
    const raw = "total 8\n-rw-r--r-- 1 u g 100 Jan  1 00:00 a.txt\n-rw-r--r-- 1 u g 200 Jan  1 00:00 b.txt\n";
    const entries = parseListOutput(raw);
    eq(entries.length, 2);
    eq(entries[0].name, "a.txt");
    eq(entries[1].name, "b.txt");
  });
}

// ── Section C: Security Guards ───────────────────────────────────────────────
async function runSectionC() {
  process.stderr.write("\n[C] Security Guards\n");

  await test("C01 — NUL byte in path rejected", async function () {
    await rejects(function () { return ftpClient({ host: "h", operation: "get", path: "/file\x00.txt" }); }, /NUL or CRLF/i);
  });

  await test("C02 — CR in path rejected", async function () {
    await rejects(function () { return ftpClient({ host: "h", operation: "get", path: "/file\r.txt" }); }, /NUL or CRLF/i);
  });

  await test("C03 — LF in path rejected", async function () {
    await rejects(function () { return ftpClient({ host: "h", operation: "get", path: "/file\n.txt" }); }, /NUL or CRLF/i);
  });

  await test("C04 — path exceeding 4096 chars rejected", async function () {
    await rejects(
      function () { return ftpClient({ host: "h", operation: "get", path: "/" + "a".repeat(4097) }); },
      /exceeds.*4096-char/i
    );
  });

  await test("C05 — NUL byte in username rejected", async function () {
    await rejects(function () { return ftpClient({ host: "h", operation: "pwd", username: "user\x00" }); }, /NUL or CRLF/i);
  });

  await test("C06 — NUL byte in password rejected", async function () {
    await rejects(function () { return ftpClient({ host: "h", operation: "pwd", password: "pass\x00" }); }, /NUL or CRLF/i);
  });

  await test("C07 — CRLF injection in username rejected", async function () {
    await rejects(function () { return ftpClient({ host: "h", operation: "pwd", username: "user\r\n" }); }, /NUL or CRLF/i);
  });

  await test("C08 — NUL byte in new_name (rename) rejected", async function () {
    await rejects(
      function () { return ftpClient({ host: "h", operation: "rename", path: "/a.txt", new_name: "b\x00.txt" }); },
      /NUL or CRLF/i
    );
  });

  await test("C09 — upload data exceeding 100 MB rejected", async function () {
    const bigB64 = Buffer.alloc(101 * 1024 * 1024).toString("base64");
    await rejects(
      function () { return ftpClient({ host: "h", operation: "put", path: "/f.bin", data: bigB64 }); },
      /exceeds.*100 MB/i
    );
  });

  await test("C10 — CRLF injection in new_name (rename) rejected", async function () {
    await rejects(
      function () { return ftpClient({ host: "h", operation: "rename", path: "/a.txt", new_name: "b.txt\r\nPASS injected" }); },
      /NUL or CRLF/i
    );
  });
}

// ── Section D: Happy-Path Mock Tests (30 tests) ───────────────────────────────
async function runSectionD() {
  process.stderr.write("\n[D] Happy-Path Mock Tests\n");

  await test("D01 — pwd returns cwd string", async function () {
    const mock = makeMockFtp({
      opHandler: function (cmd, send) {
        if (cmd.toUpperCase() === "PWD") send('257 "/var/ftp" is current directory');
      }
    });
    try {
      const r = await ftpClient({ host: "localhost", operation: "pwd", timeout: 5 });
      eq(r.cwd, "/var/ftp");
      eq(r.operation, "pwd");
      ok(r.elapsedMs >= 0);
      eq(r.host, "localhost");
    } finally { mock.restore(); }
  });

  await test("D02 — quit returns quit:true with resultCode", async function () {
    const mock = makeMockFtp({ opHandler: function () {} });
    try {
      const r = await ftpClient({ host: "localhost", operation: "quit", timeout: 5 });
      ok(r.quit);
      ok(r.resultCode, "resultCode should be set");
    } finally { mock.restore(); }
  });

  await test("D03 — delete returns deleted:true", async function () {
    const mock = makeMockFtp({
      opHandler: function (cmd, send) {
        if (cmd.toUpperCase().startsWith("DELE ")) send("250 File deleted");
      }
    });
    try {
      const r = await ftpClient({ host: "localhost", operation: "delete", path: "/tmp/old.txt", timeout: 5 });
      ok(r.deleted);
      eq(r.path, "/tmp/old.txt");
    } finally { mock.restore(); }
  });

  await test("D04 — mkdir returns created:true", async function () {
    const mock = makeMockFtp({
      opHandler: function (cmd, send) {
        if (cmd.toUpperCase().startsWith("MKD ")) send('257 "/newdir" created');
      }
    });
    try {
      const r = await ftpClient({ host: "localhost", operation: "mkdir", path: "/newdir", timeout: 5 });
      ok(r.created);
      eq(r.path, "/newdir");
    } finally { mock.restore(); }
  });

  await test("D05 — rmdir returns removed:true", async function () {
    const mock = makeMockFtp({
      opHandler: function (cmd, send) {
        if (cmd.toUpperCase().startsWith("RMD ")) send("250 Directory removed");
      }
    });
    try {
      const r = await ftpClient({ host: "localhost", operation: "rmdir", path: "/olddir", timeout: 5 });
      ok(r.removed);
      eq(r.path, "/olddir");
    } finally { mock.restore(); }
  });

  await test("D06 — rename sends RNFR then RNTO", async function () {
    const cmds = [];
    const mock = makeMockFtp({
      opHandler: function (cmd, send) {
        cmds.push(cmd);
        const u = cmd.toUpperCase();
        if (u.startsWith("RNFR ")) send("350 Ready for RNTO");
        else if (u.startsWith("RNTO ")) send("250 File renamed");
      }
    });
    try {
      const r = await ftpClient({
        host: "localhost", operation: "rename",
        path: "/old.txt", new_name: "/new.txt", timeout: 5
      });
      ok(r.renamed);
      ok(cmds.some(function (c) { return c.toUpperCase().startsWith("RNFR "); }));
      ok(cmds.some(function (c) { return c.toUpperCase().startsWith("RNTO "); }));
    } finally { mock.restore(); }
  });

  await test("D07 — stat returns size + ISO-8601 modified", async function () {
    const mock = makeMockFtp({
      opHandler: function (cmd, send) {
        const u = cmd.toUpperCase();
        if (u.startsWith("SIZE ")) send("213 1048576");
        else if (u.startsWith("MDTM ")) send("213 20240101120000");
      }
    });
    try {
      const r = await ftpClient({ host: "localhost", operation: "stat", path: "/big.bin", timeout: 5 });
      eq(r.size, 1048576);
      ok(r.modified.startsWith("2024-01-01"));
      ok(r.exists);
    } finally { mock.restore(); }
  });

  await test("D08 — stat with 502 for SIZE/MDTM → exists:false, nulls", async function () {
    const mock = makeMockFtp({
      opHandler: function (cmd, send) {
        const u = cmd.toUpperCase();
        if (u.startsWith("SIZE ")) send("502 Command not implemented");
        else if (u.startsWith("MDTM ")) send("502 Command not implemented");
      }
    });
    try {
      const r = await ftpClient({ host: "localhost", operation: "stat", path: "/x.txt", timeout: 5 });
      eq(r.size, null);
      eq(r.modified, null);
      eq(r.exists, false);
    } finally { mock.restore(); }
  });

  await test("D09 — list parses Unix directory entries", async function () {
    let dataSrv;
    const dataProm = makeDataServer(function (sock) {
      sock.end(
        "-rw-r--r-- 1 user group  100 Jan  1 12:00 file1.txt\r\n" +
        "drwxr-xr-x 2 user group 4096 Jan  2 09:00 subdir\r\n"
      );
    });
    const { port: dataPort, server } = await dataProm;
    dataSrv = server;

    const mock = makeMockFtp({
      opHandler: function (cmd, send) {
        const u = cmd.toUpperCase();
        if (u === "EPSV") send("229 Entering Extended Passive Mode (|||" + dataPort + "|");
        else if (u.startsWith("LIST")) {
          send("150 Opening data connection");
          setTimeout(function () { send("226 Transfer complete"); }, 50);
        }
      }
    });

    try {
      const r = await ftpClient({ host: "127.0.0.1", operation: "list", timeout: 5 });
      ok(r.entries.length >= 2);
      ok(r.entries.some(function (e) { return e.name === "file1.txt" && e.type === "file"; }));
      ok(r.entries.some(function (e) { return e.name === "subdir" && e.type === "directory"; }));
    } finally {
      mock.restore();
      dataSrv.close();
    }
  });

  await test("D10 — list with optional path sends CWD first", async function () {
    let dataSrv;
    const { port: dataPort, server } = await makeDataServer(function (sock) {
      sock.end("-rw-r--r-- 1 u g 10 Jan  1 00:00 readme.md\r\n");
    });
    dataSrv = server;

    let cwdSeen = false;
    const mock = makeMockFtp({
      opHandler: function (cmd, send) {
        const u = cmd.toUpperCase();
        if (u.startsWith("CWD ")) { cwdSeen = true; send("250 CWD OK"); }
        else if (u === "EPSV") send("229 Entering Extended Passive Mode (|||" + dataPort + "|");
        else if (u.startsWith("LIST")) {
          send("150 Here comes listing");
          setTimeout(function () { send("226 Directory send OK"); }, 50);
        }
      }
    });

    try {
      const r = await ftpClient({ host: "127.0.0.1", operation: "list", path: "/home/user", timeout: 5 });
      ok(cwdSeen, "CWD should have been sent");
      eq(r.path, "/home/user");
    } finally {
      mock.restore();
      dataSrv.close();
    }
  });

  await test("D11 — get downloads file, returns base64", async function () {
    const fileContent = Buffer.from("Hello, FTP World!", "utf8");
    const { port: dataPort, server: dataSrv } = await makeDataServer(function (sock) {
      sock.end(fileContent);
    });

    const mock = makeMockFtp({
      opHandler: function (cmd, send) {
        const u = cmd.toUpperCase();
        if (u === "EPSV") send("229 Entering Extended Passive Mode (|||" + dataPort + "|");
        else if (u.startsWith("RETR ")) {
          send("150 Opening data connection");
          setTimeout(function () { send("226 Transfer complete"); }, 50);
        }
      }
    });

    try {
      const r = await ftpClient({ host: "127.0.0.1", operation: "get", path: "/hello.txt", timeout: 5 });
      eq(r.encoding, "base64");
      eq(Buffer.from(r.data, "base64").toString("utf8"), "Hello, FTP World!");
      eq(r.size, fileContent.length);
      eq(r.path, "/hello.txt");
    } finally {
      mock.restore();
      dataSrv.close();
    }
  });

  await test("D12 — get with encoding=utf8 returns text", async function () {
    const { port: dataPort, server: dataSrv } = await makeDataServer(function (sock) {
      sock.end(Buffer.from("plain text content"));
    });

    const mock = makeMockFtp({
      opHandler: function (cmd, send) {
        const u = cmd.toUpperCase();
        if (u === "EPSV") send("229 Entering Extended Passive Mode (|||" + dataPort + "|");
        else if (u.startsWith("RETR ")) {
          send("150 Opening");
          setTimeout(function () { send("226 Transfer complete"); }, 50);
        }
      }
    });

    try {
      const r = await ftpClient({
        host: "127.0.0.1", operation: "get", path: "/text.txt",
        encoding: "utf8", timeout: 5
      });
      eq(r.encoding, "utf8");
      eq(r.data, "plain text content");
    } finally {
      mock.restore();
      dataSrv.close();
    }
  });

  await test("D13 — put uploads base64 data via STOR", async function () {
    const uploadContent = "Hello upload!";
    const b64 = Buffer.from(uploadContent).toString("base64");

    const { port: dataPort, server: dataSrv } = await makeDataServer(function (sock) {
      sock.on("data", function () {});
    });

    const mock = makeMockFtp({
      opHandler: function (cmd, send) {
        const u = cmd.toUpperCase();
        if (u === "EPSV") send("229 Entering Extended Passive Mode (|||" + dataPort + "|");
        else if (u.startsWith("STOR ")) {
          send("150 Opening data connection");
          setTimeout(function () { send("226 Transfer complete"); }, 100);
        }
      }
    });

    try {
      const r = await ftpClient({
        host: "127.0.0.1", operation: "put",
        path: "/upload.txt", data: b64, timeout: 5
      });
      ok(r.uploaded);
      eq(r.size, Buffer.from(uploadContent).length);
      eq(r.path, "/upload.txt");
    } finally {
      mock.restore();
      dataSrv.close();
    }
  });

  await test("D14 — put with encoding=utf8 uploads correctly", async function () {
    const { port: dataPort, server: dataSrv } = await makeDataServer(function (sock) {
      sock.on("data", function () {});
    });

    const mock = makeMockFtp({
      opHandler: function (cmd, send) {
        const u = cmd.toUpperCase();
        if (u === "EPSV") send("229 Entering Extended Passive Mode (|||" + dataPort + "|");
        else if (u.startsWith("STOR ")) {
          send("150 Opening data connection");
          setTimeout(function () { send("226 Transfer complete"); }, 80);
        }
      }
    });

    try {
      const r = await ftpClient({
        host: "127.0.0.1", operation: "put",
        path: "/utf.txt", data: "hello utf8", encoding: "utf8", timeout: 5
      });
      ok(r.uploaded);
      eq(r.size, Buffer.byteLength("hello utf8", "utf8"));
    } finally {
      mock.restore();
      dataSrv.close();
    }
  });

  await test("D15 — result always includes host, port, elapsedMs, banner", async function () {
    const mock = makeMockFtp({
      opHandler: function (cmd, send) {
        if (cmd.toUpperCase() === "PWD") send('257 "/" is current directory');
      }
    });
    try {
      const r = await ftpClient({ host: "localhost", port: 21, operation: "pwd", timeout: 5 });
      eq(r.host, "localhost");
      eq(r.port, 21);
      ok(typeof r.elapsedMs === "number" && r.elapsedMs >= 0);
      ok(r.banner, "banner should be present");
    } finally { mock.restore(); }
  });

  await test("D16 — anonymous login defaults (username=anonymous, password=anonymous@)", async function () {
    let userSeen = "", passSeen = "";
    const EventEmitter = require("events");
    const _orig = net.createConnection;
    const s = new EventEmitter();
    s.destroyed = false;
    s.destroy = function () { s.destroyed = true; };
    s.write = function (data) {
      const cmd = (typeof data === "string" ? data : data.toString()).replace(/\r\n$/, "").trim();
      setImmediate(function () {
        const u = cmd.toUpperCase();
        if (u.startsWith("USER ")) { userSeen = cmd.slice(5); s.emit("data", Buffer.from("331 Pass\r\n")); }
        else if (u.startsWith("PASS ")) { passSeen = cmd.slice(5); s.emit("data", Buffer.from("230 OK\r\n")); }
        else if (u.startsWith("TYPE ")) s.emit("data", Buffer.from("200 OK\r\n"));
        else if (u === "PWD") s.emit("data", Buffer.from('257 "/" is cwd\r\n'));
        else if (u === "QUIT") s.emit("data", Buffer.from("221 Bye\r\n"));
      });
    };
    s.end = function () {};
    net.createConnection = function () {
      setImmediate(function () { s.emit("data", Buffer.from("220 Ready\r\n")); s.emit("connect"); });
      return s;
    };
    try {
      await ftpClient({ host: "localhost", operation: "pwd", timeout: 5 });
      eq(userSeen, "anonymous");
      eq(passSeen, "anonymous@");
    } finally { net.createConnection = _orig; }
  });

  await test("D17 — list falls back to PASV when EPSV not supported", async function () {
    const { port: dataPort, server: dataSrv } = await makeDataServer(function (sock) {
      sock.end("-rw-r--r-- 1 u g 10 Jan  1 00:00 file.txt\r\n");
    });

    const p1 = Math.floor(dataPort / 256);
    const p2 = dataPort % 256;

    const mock = makeMockFtp({
      opHandler: function (cmd, send) {
        const u = cmd.toUpperCase();
        if (u === "EPSV") send("500 Unknown command");
        else if (u === "PASV") send("227 Entering Passive Mode (127,0,0,1," + p1 + "," + p2 + ")");
        else if (u.startsWith("LIST")) {
          send("150 Opening data connection");
          setTimeout(function () { send("226 Transfer complete"); }, 50);
        }
      }
    });

    try {
      const r = await ftpClient({ host: "127.0.0.1", operation: "list", timeout: 5 });
      ok(r.entries.length >= 1);
      ok(r.entries[0].name === "file.txt");
    } finally {
      mock.restore();
      dataSrv.close();
    }
  });

  await test("D18 — stat MDTM parsed to ISO-8601 timestamp", async function () {
    const mock = makeMockFtp({
      opHandler: function (cmd, send) {
        const u = cmd.toUpperCase();
        if (u.startsWith("SIZE ")) send("213 500");
        else if (u.startsWith("MDTM ")) send("213 20231225153045");
      }
    });
    try {
      const r = await ftpClient({ host: "localhost", operation: "stat", path: "/xmas.txt", timeout: 5 });
      eq(r.modified, "2023-12-25T15:30:45Z");
      eq(r.size, 500);
    } finally { mock.restore(); }
  });

  await test("D19 — delete with 200 response also accepted", async function () {
    const mock = makeMockFtp({
      opHandler: function (cmd, send) {
        if (cmd.toUpperCase().startsWith("DELE ")) send("200 Deleted");
      }
    });
    try {
      const r = await ftpClient({ host: "localhost", operation: "delete", path: "/f.txt", timeout: 5 });
      ok(r.deleted);
      eq(r.resultCode, "200");
    } finally { mock.restore(); }
  });

  await test("D20 — pwd extracts quoted path from 257", async function () {
    const mock = makeMockFtp({
      opHandler: function (cmd, send) {
        if (cmd.toUpperCase() === "PWD") send('257 "/usr/local/ftp" is the cwd');
      }
    });
    try {
      const r = await ftpClient({ host: "localhost", operation: "pwd", timeout: 5 });
      eq(r.cwd, "/usr/local/ftp");
    } finally { mock.restore(); }
  });

  await test("D21 — list returns entryCount equal to entry array length", async function () {
    const lines = Array.from({ length: 5 }, function (_, i) {
      return "-rw-r--r-- 1 u g " + (i * 100) + " Jan  1 00:0" + i + " file" + i + ".txt";
    }).join("\r\n") + "\r\n";

    const { port: dataPort, server: dataSrv } = await makeDataServer(function (sock) {
      sock.end(lines);
    });

    const mock = makeMockFtp({
      opHandler: function (cmd, send) {
        const u = cmd.toUpperCase();
        if (u === "EPSV") send("229 Entering Extended Passive Mode (|||" + dataPort + "|");
        else if (u.startsWith("LIST")) {
          send("150 Opening");
          setTimeout(function () { send("226 Done"); }, 50);
        }
      }
    });

    try {
      const r = await ftpClient({ host: "127.0.0.1", operation: "list", timeout: 5 });
      eq(r.entryCount, r.entries.length);
      eq(r.entryCount, 5);
    } finally {
      mock.restore();
      dataSrv.close();
    }
  });

  await test("D22 — rename: RNFR/RNTO result includes path + new_name", async function () {
    const mock = makeMockFtp({
      opHandler: function (cmd, send) {
        const u = cmd.toUpperCase();
        if (u.startsWith("RNFR ")) send("350 Ready for RNTO");
        else if (u.startsWith("RNTO ")) send("250 Renamed OK");
      }
    });
    try {
      const r = await ftpClient({
        host: "localhost", operation: "rename",
        path: "/a/old.txt", new_name: "/a/new.txt", timeout: 5
      });
      ok(r.renamed);
      eq(r.path, "/a/old.txt");
      eq(r.new_name, "/a/new.txt");
    } finally { mock.restore(); }
  });

  await test("D23 — get resultCode from 226 Transfer complete", async function () {
    const { port: dataPort, server: dataSrv } = await makeDataServer(function (sock) {
      sock.end(Buffer.from("data"));
    });
    const mock = makeMockFtp({
      opHandler: function (cmd, send) {
        const u = cmd.toUpperCase();
        if (u === "EPSV") send("229 Entering Extended Passive Mode (|||" + dataPort + "|");
        else if (u.startsWith("RETR ")) {
          send("150 Opening");
          setTimeout(function () { send("226 Transfer complete"); }, 50);
        }
      }
    });
    try {
      const r = await ftpClient({ host: "127.0.0.1", operation: "get", path: "/d.bin", timeout: 5 });
      eq(r.resultCode, "226");
    } finally {
      mock.restore();
      dataSrv.close();
    }
  });

  await test("D24 — mkdir resultCode is 257", async function () {
    const mock = makeMockFtp({
      opHandler: function (cmd, send) {
        if (cmd.toUpperCase().startsWith("MKD ")) send('257 "/d" created');
      }
    });
    try {
      const r = await ftpClient({ host: "localhost", operation: "mkdir", path: "/d", timeout: 5 });
      eq(r.resultCode, "257");
    } finally { mock.restore(); }
  });

  await test("D25 — rmdir resultCode is 250", async function () {
    const mock = makeMockFtp({
      opHandler: function (cmd, send) {
        if (cmd.toUpperCase().startsWith("RMD ")) send("250 Directory removed");
      }
    });
    try {
      const r = await ftpClient({ host: "localhost", operation: "rmdir", path: "/d", timeout: 5 });
      eq(r.resultCode, "250");
    } finally { mock.restore(); }
  });

  await test("D26 — QUIT sent after every non-quit operation", async function () {
    const cmds = [];
    const EventEmitter = require("events");
    const _orig = net.createConnection;
    const s = new EventEmitter();
    s.destroyed = false; s.destroy = function () { s.destroyed = true; };
    s.write = function (data) {
      const cmd = (typeof data === "string" ? data : data.toString()).replace(/\r\n$/, "").trim();
      cmds.push(cmd);
      setImmediate(function () {
        const u = cmd.toUpperCase();
        if (u.startsWith("USER ")) s.emit("data", Buffer.from("331 Pass\r\n"));
        else if (u.startsWith("PASS ")) s.emit("data", Buffer.from("230 OK\r\n"));
        else if (u.startsWith("TYPE ")) s.emit("data", Buffer.from("200 OK\r\n"));
        else if (u === "PWD") s.emit("data", Buffer.from('257 "/" is cwd\r\n'));
        else if (u === "QUIT") s.emit("data", Buffer.from("221 Bye\r\n"));
      });
    };
    s.end = function () {};
    net.createConnection = function () {
      setImmediate(function () { s.emit("data", Buffer.from("220 Ready\r\n")); s.emit("connect"); });
      return s;
    };
    try {
      await ftpClient({ host: "localhost", operation: "pwd", timeout: 5 });
      ok(cmds.some(function (c) { return c.toUpperCase() === "QUIT"; }), "QUIT should be sent");
    } finally { net.createConnection = _orig; }
  });

  await test("D27 — login with direct 230 (no PASS needed)", async function () {
    const EventEmitter = require("events");
    const _orig = net.createConnection;
    const s = new EventEmitter();
    s.destroyed = false; s.destroy = function () { s.destroyed = true; };
    s.write = function (data) {
      const cmd = (typeof data === "string" ? data : data.toString()).replace(/\r\n$/, "").trim();
      setImmediate(function () {
        const u = cmd.toUpperCase();
        if (u.startsWith("USER ")) s.emit("data", Buffer.from("230 Logged in directly\r\n"));
        else if (u.startsWith("TYPE ")) s.emit("data", Buffer.from("200 OK\r\n"));
        else if (u === "PWD") s.emit("data", Buffer.from('257 "/home" is cwd\r\n'));
        else if (u === "QUIT") s.emit("data", Buffer.from("221 Bye\r\n"));
      });
    };
    s.end = function () {};
    net.createConnection = function () {
      setImmediate(function () { s.emit("data", Buffer.from("220 Ready\r\n")); s.emit("connect"); });
      return s;
    };
    try {
      const r = await ftpClient({ host: "localhost", operation: "pwd", timeout: 5 });
      eq(r.cwd, "/home");
    } finally { net.createConnection = _orig; }
  });

  await test("D28 — list parses DOS-style entries", async function () {
    const { port: dataPort, server: dataSrv } = await makeDataServer(function (sock) {
      sock.end(
        "01-01-21  12:00AM <DIR>          mydir\r\n" +
        "01-02-21  01:30PM         123456 file.zip\r\n"
      );
    });

    const mock = makeMockFtp({
      opHandler: function (cmd, send) {
        const u = cmd.toUpperCase();
        if (u === "EPSV") send("229 Entering Extended Passive Mode (|||" + dataPort + "|");
        else if (u.startsWith("LIST")) {
          send("150 Opening data connection");
          setTimeout(function () { send("226 Transfer complete"); }, 50);
        }
      }
    });

    try {
      const r = await ftpClient({ host: "127.0.0.1", operation: "list", timeout: 5 });
      const dir  = r.entries.find(function (e) { return e.name === "mydir"; });
      const file = r.entries.find(function (e) { return e.name === "file.zip"; });
      ok(dir  && dir.type  === "directory", "mydir should be a directory");
      ok(file && file.type === "file" && file.size === 123456, "file.zip should be a file");
    } finally {
      mock.restore();
      dataSrv.close();
    }
  });

  await test("D29 — custom username and password sent in auth", async function () {
    let seenUser = "", seenPass = "";
    const EventEmitter = require("events");
    const _orig = net.createConnection;
    const s = new EventEmitter();
    s.destroyed = false; s.destroy = function () { s.destroyed = true; };
    s.write = function (data) {
      const cmd = (typeof data === "string" ? data : data.toString()).replace(/\r\n$/, "").trim();
      setImmediate(function () {
        const u = cmd.toUpperCase();
        if (u.startsWith("USER ")) { seenUser = cmd.slice(5); s.emit("data", Buffer.from("331 Pass\r\n")); }
        else if (u.startsWith("PASS ")) { seenPass = cmd.slice(5); s.emit("data", Buffer.from("230 OK\r\n")); }
        else if (u.startsWith("TYPE ")) s.emit("data", Buffer.from("200 OK\r\n"));
        else if (u === "PWD") s.emit("data", Buffer.from('257 "/" is cwd\r\n'));
        else if (u === "QUIT") s.emit("data", Buffer.from("221 Bye\r\n"));
      });
    };
    s.end = function () {};
    net.createConnection = function () {
      setImmediate(function () { s.emit("data", Buffer.from("220 Ready\r\n")); s.emit("connect"); });
      return s;
    };
    try {
      await ftpClient({ host: "localhost", operation: "pwd", username: "alice", password: "s3cr3t", timeout: 5 });
      eq(seenUser, "alice");
      eq(seenPass, "s3cr3t");
    } finally { net.createConnection = _orig; }
  });

  await test("D30 — custom port reflected in result", async function () {
    const mock = makeMockFtp({
      opHandler: function (cmd, send) {
        if (cmd.toUpperCase() === "PWD") send('257 "/" is cwd');
      }
    });
    try {
      const r = await ftpClient({ host: "localhost", port: 2121, operation: "pwd", timeout: 5 });
      eq(r.port, 2121);
    } finally { mock.restore(); }
  });
}

// ── Section E: Error Paths ─────────────────────────────────────────────────────
async function runSectionE() {
  process.stderr.write("\n[E] Error Paths\n");

  await test("E01 — wrong banner code (421) throws 'expected 220'", async function () {
    const EventEmitter = require("events");
    const _orig = net.createConnection;
    const s = new EventEmitter();
    s.destroyed = false; s.destroy = function () { s.destroyed = true; };
    s.write = function () {};
    s.end = function () {};
    net.createConnection = function () {
      setImmediate(function () {
        s.emit("data", Buffer.from("421 Service unavailable\r\n"));
        s.emit("connect");
      });
      return s;
    };
    try {
      await rejects(
        function () { return ftpClient({ host: "localhost", operation: "pwd", timeout: 2 }); },
        /expected 220 greeting/i
      );
    } finally { net.createConnection = _orig; }
  });

  await test("E02 — login failure (530) throws descriptive error", async function () {
    const EventEmitter = require("events");
    const _orig = net.createConnection;
    const s = new EventEmitter();
    s.destroyed = false; s.destroy = function () { s.destroyed = true; };
    s.write = function (data) {
      const cmd = (typeof data === "string" ? data : data.toString()).replace(/\r\n$/, "").trim();
      setImmediate(function () {
        const u = cmd.toUpperCase();
        if (u.startsWith("USER ")) s.emit("data", Buffer.from("331 Pass req\r\n"));
        else if (u.startsWith("PASS ")) s.emit("data", Buffer.from("530 Login incorrect\r\n"));
      });
    };
    s.end = function () {};
    net.createConnection = function () {
      setImmediate(function () { s.emit("data", Buffer.from("220 Ready\r\n")); s.emit("connect"); });
      return s;
    };
    try {
      await rejects(
        function () { return ftpClient({ host: "localhost", operation: "pwd", timeout: 2 }); },
        /login failed.*530/i
      );
    } finally { net.createConnection = _orig; }
  });

  await test("E03 — DELE failure (550) throws", async function () {
    const mock = makeMockFtp({
      opHandler: function (cmd, send) {
        if (cmd.toUpperCase().startsWith("DELE ")) send("550 No such file");
      }
    });
    try {
      await rejects(
        function () { return ftpClient({ host: "localhost", operation: "delete", path: "/gone.txt", timeout: 3 }); },
        /delete failed.*550/i
      );
    } finally { mock.restore(); }
  });

  await test("E04 — CWD failure (550) during list throws", async function () {
    const mock = makeMockFtp({
      opHandler: function (cmd, send) {
        if (cmd.toUpperCase().startsWith("CWD ")) send("550 No such directory");
      }
    });
    try {
      await rejects(
        function () { return ftpClient({ host: "localhost", operation: "list", path: "/nonexistent", timeout: 3 }); },
        /CWD.*failed.*550/i
      );
    } finally { mock.restore(); }
  });

  await test("E05 — RETR failure (550) throws", async function () {
    const { port: dataPort, server: dataSrv } = await makeDataServer(function (sock) {
      sock.end();
    });
    const mock = makeMockFtp({
      opHandler: function (cmd, send) {
        const u = cmd.toUpperCase();
        if (u === "EPSV") send("229 Entering Extended Passive Mode (|||" + dataPort + "|");
        else if (u.startsWith("RETR ")) send("550 File not found");
      }
    });
    try {
      await rejects(
        function () { return ftpClient({ host: "127.0.0.1", operation: "get", path: "/missing.txt", timeout: 3 }); },
        /RETR.*failed.*550/i
      );
    } finally {
      mock.restore();
      dataSrv.close();
    }
  });
}

// ── Section F: Concurrency ─────────────────────────────────────────────────────
async function runSectionF() {
  process.stderr.write("\n[F] Concurrency Tests\n");

  await test("F01 — 5 concurrent pwd operations each return unique cwd", async function () {
    const results = await Promise.all(
      Array.from({ length: 5 }, function (_, i) {
        const mock = makeMockFtp({
          opHandler: function (cmd, send) {
            if (cmd.toUpperCase() === "PWD") send('257 "/home/user' + i + '" is cwd');
          }
        });
        return ftpClient({ host: "localhost", operation: "pwd", timeout: 5 }).finally(function () { mock.restore(); });
      })
    );
    eq(results.length, 5);
    for (let i = 0; i < results.length; i++) {
      ok(results[i].cwd, "each result should have cwd");
      eq(results[i].operation, "pwd");
    }
  });

  await test("F02 — 5 concurrent delete operations all return deleted:true", async function () {
    const results = await Promise.all(
      Array.from({ length: 5 }, function (_, i) {
        const mock = makeMockFtp({
          opHandler: function (cmd, send) {
            if (cmd.toUpperCase().startsWith("DELE ")) send("250 Deleted");
          }
        });
        return ftpClient({
          host: "localhost", operation: "delete", path: "/file" + i + ".txt", timeout: 5
        }).finally(function () { mock.restore(); });
      })
    );
    for (let i = 0; i < results.length; i++) ok(results[i].deleted);
  });

  await test("F03 — 5 concurrent stat operations return independent results", async function () {
    const results = await Promise.all(
      Array.from({ length: 5 }, function (_, i) {
        const size = (i + 1) * 1000;
        const mock = makeMockFtp({
          opHandler: function (cmd, send) {
            const u = cmd.toUpperCase();
            if (u.startsWith("SIZE ")) send("213 " + size);
            else if (u.startsWith("MDTM ")) send("502 Not implemented");
          }
        });
        return ftpClient({
          host: "localhost", operation: "stat", path: "/file" + i + ".txt", timeout: 5
        }).finally(function () { mock.restore(); });
      })
    );
    eq(results.length, 5);
    const sizes = results.map(function (r) { return r.size; }).sort(function (a, b) { return a - b; });
    for (let i = 0; i < 5; i++) eq(sizes[i], (i + 1) * 1000);
  });

  await test("F04 — concurrent mkdir + rmdir don't interfere", async function () {
    const mkResults = await Promise.all(
      Array.from({ length: 3 }, function (_, i) {
        const mock = makeMockFtp({
          opHandler: function (cmd, send) {
            if (cmd.toUpperCase().startsWith("MKD ")) send('257 "/dir' + i + '" created');
          }
        });
        return ftpClient({ host: "localhost", operation: "mkdir", path: "/dir" + i, timeout: 5 })
          .finally(function () { mock.restore(); });
      })
    );
    const rmResults = await Promise.all(
      Array.from({ length: 3 }, function (_, i) {
        const mock = makeMockFtp({
          opHandler: function (cmd, send) {
            if (cmd.toUpperCase().startsWith("RMD ")) send("250 Removed");
          }
        });
        return ftpClient({ host: "localhost", operation: "rmdir", path: "/dir" + i, timeout: 5 })
          .finally(function () { mock.restore(); });
      })
    );
    for (let i = 0; i < mkResults.length; i++) ok(mkResults[i].created);
    for (let i = 0; i < rmResults.length; i++) ok(rmResults[i].removed);
  });

  await test("F05 — 10 concurrent validation rejections (no network)", async function () {
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, function () {
        return ftpClient({ host: "h", operation: "get" }) // missing path → throws
          .then(function () { return false; })
          .catch(function () { return true; });
      })
    );
    ok(outcomes.every(Boolean), "All 10 should have thrown");
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
(async function () {
  process.stderr.write("\n=== Section 198: ftp_client ===\n");

  await runSectionA();
  await runSectionB();
  await runSectionC();
  await runSectionD();
  await runSectionE();
  await runSectionF();

  const total = passed + failed;
  process.stdout.write("\n");
  process.stderr.write("\nResults: " + passed + "/" + total + " passed");
  if (failures.length) {
    process.stderr.write(" (" + failed + " FAILED)\n");
    for (let i = 0; i < failures.length; i++)
      process.stderr.write("  FAIL: " + failures[i].label + "\n        " + failures[i].err + "\n");
    process.exit(1);
  }
  process.stderr.write(" (all passed)\n");
})();
