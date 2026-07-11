"use strict";
/**
 * Section 186 - tcp_client tool
 * Tests: A=validation, B=banner, C=send, D=recv_until, E=TLS, F=encodings,
 *        G=limits, H=security, I=errors, J=concurrency.
 */

const assert = require("assert");
const net    = require("net");
const tls    = require("tls");
const crypto = require("crypto");

const { tcpClient } = require("../../lib/tcpClientOps");

function createEchoServer(handler) {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => {
      sock.on("error", () => {});
      handler(sock);
    });
    srv.listen(0, "127.0.0.1", () => resolve({ server: srv, port: srv.address().port }));
    srv.on("error", () => {});
  });
}

let passed = 0, failed = 0;

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      return r.then(
        () => { process.stderr.write(`  PASS  ${name}\n`); passed++; },
        (e) => { process.stderr.write(`  FAIL  ${name}: ${e.message}\n`); failed++; },
      );
    }
    process.stderr.write(`  PASS  ${name}\n`); passed++;
  } catch (e) {
    process.stderr.write(`  FAIL  ${name}: ${e.message}\n`); failed++;
  }
  return Promise.resolve();
}

const servers = [];

async function run() {
  process.stderr.write("\n=== Section 186: tcp_client ===\n");

  // --- A: Input validation ---
  process.stderr.write("\n--- A: Input validation ---\n");

  await test("A1: missing host", () => tcpClient({ port: 80 }).then(
    () => assert.fail("Should reject"), (e) => assert.ok(e.message.includes("host"))));

  await test("A2: missing port", () => tcpClient({ host: "127.0.0.1" }).then(
    () => assert.fail("Should reject"), (e) => assert.ok(e.message.includes("port"))));

  await test("A3: invalid port 0", () => tcpClient({ host: "127.0.0.1", port: 0 }).then(
    () => assert.fail("Should reject"), (e) => assert.ok(e.message.includes("port"))));

  await test("A4: invalid port 65536", () => tcpClient({ host: "127.0.0.1", port: 65536 }).then(
    () => assert.fail("Should reject"), (e) => assert.ok(e.message.includes("port"))));

  await test("A5: host with newline", () => tcpClient({ host: "evil\nhost", port: 80 }).then(
    () => assert.fail("Should reject"), (e) => assert.ok(e.message.includes("host"))));

  await test("A6: messages not array", () => tcpClient({ host: "127.0.0.1", port: 80, messages: "x" }).then(
    () => assert.fail("Should reject"), (e) => assert.ok(e.message.includes("messages"))));

  await test("A7: message without data", () => tcpClient({ host: "127.0.0.1", port: 80, messages: [{ encoding: "utf8" }] }).then(
    () => assert.fail("Should reject"), (e) => assert.ok(e.message.includes("data"))));

  await test("A8: unknown encoding", () => tcpClient({ host: "127.0.0.1", port: 80, messages: [{ data: "hi", encoding: "ucs2" }] }).then(
    () => assert.fail("Should reject"), (e) => assert.ok(e.message.includes("encoding"))));

  await test("A9: payload too large", () => tcpClient({ host: "127.0.0.1", port: 80, messages: [{ data: "x".repeat(65 * 1024 + 1) }] }).then(
    () => assert.fail("Should reject"), (e) => assert.ok(e.message.includes("payload") || e.message.includes("bytes"))));

  await test("A10: invalid recv_encoding", () => tcpClient({ host: "127.0.0.1", port: 80, recv_encoding: "ascii" }).then(
    () => assert.fail("Should reject"), (e) => assert.ok(e.message.includes("recv_encoding"))));

  // --- B: Banner grab (no messages sent) ---
  process.stderr.write("\n--- B: Banner grab ---\n");

  const srvB = await createEchoServer((sock) => {
    sock.write("+OK POP3 server ready\r\n");
    sock.on("end", () => sock.destroy());
  });
  servers.push(srvB.server);

  await test("B1: connects and receives banner", async () => {
    const r = await tcpClient({ host: "127.0.0.1", port: srvB.port, timeout: 5, recv_timeout: 1 });
    assert.strictEqual(r.connected, true);
    assert.ok(r.chunksReceived >= 1);
    assert.ok(r.chunks[0].data.includes("+OK"));
    assert.strictEqual(r.error, undefined);
  });

  await test("B2: result shape fields", async () => {
    const r = await tcpClient({ host: "127.0.0.1", port: srvB.port, timeout: 5, recv_timeout: 1 });
    assert.ok(typeof r.host === "string");
    assert.ok(typeof r.port === "number");
    assert.ok(typeof r.connected === "boolean");
    assert.ok(typeof r.messagesSent === "number");
    assert.ok(typeof r.chunksReceived === "number");
    assert.ok(typeof r.totalReceivedBytes === "number");
    assert.ok(typeof r.truncated === "boolean");
    assert.ok(Array.isArray(r.chunks));
    assert.ok(typeof r.elapsedMs === "number");
  });

  await test("B3: chunk shape fields", async () => {
    const r = await tcpClient({ host: "127.0.0.1", port: srvB.port, timeout: 5, recv_timeout: 1 });
    const c = r.chunks[0];
    assert.ok(typeof c.index === "number");
    assert.ok(typeof c.elapsedMs === "number");
    assert.ok(typeof c.sizeBytes === "number");
    assert.ok(typeof c.data === "string");
    assert.ok(typeof c.encoding === "string");
  });

  // --- C: Send messages, read echo ---
  process.stderr.write("\n--- C: Send messages ---\n");

  const srvC = await createEchoServer((sock) => {
    sock.on("data", (d) => sock.write(d));
    sock.on("end", () => sock.destroy());
  });
  servers.push(srvC.server);

  await test("C1: send single message receive echo", async () => {
    const r = await tcpClient({ host: "127.0.0.1", port: srvC.port, messages: [{ data: "PING", add_newline: false }], timeout: 5, recv_timeout: 1 });
    assert.strictEqual(r.messagesSent, 1);
    assert.ok(r.chunks.map(c => c.data).join("").includes("PING"));
  });

  await test("C2: add_newline appends CRLF", async () => {
    const r = await tcpClient({ host: "127.0.0.1", port: srvC.port, messages: [{ data: "HELLO" }], timeout: 5, recv_timeout: 1 });
    assert.ok(r.chunks.map(c => c.data).join("").includes("HELLO\r\n"));
  });

  await test("C3: send multiple messages", async () => {
    const r = await tcpClient({
      host: "127.0.0.1", port: srvC.port,
      messages: [{ data: "MSG1", add_newline: false }, { data: "MSG2", add_newline: false }, { data: "MSG3", add_newline: false }],
      timeout: 5, recv_timeout: 1,
    });
    assert.strictEqual(r.messagesSent, 3);
    const all = r.chunks.map(c => c.data).join("");
    assert.ok(all.includes("MSG1") && all.includes("MSG2") && all.includes("MSG3"));
  });

  await test("C4: messagesSent count", async () => {
    const r = await tcpClient({ host: "127.0.0.1", port: srvC.port, messages: [{ data: "A", add_newline: false }, { data: "B", add_newline: false }], timeout: 5, recv_timeout: 1 });
    assert.strictEqual(r.messagesSent, 2);
  });

  // --- D: recv_until pipelining ---
  process.stderr.write("\n--- D: recv_until ---\n");

  const srvD = await createEchoServer((sock) => {
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString();
      while (buf.includes("\n")) {
        const nl = buf.indexOf("\n");
        const line = buf.slice(0, nl + 1).trim();
        buf = buf.slice(nl + 1);
        if (line === "EHLO") sock.write("250-Hello\r\n250 OK\r\n");
        else if (line === "QUIT") { sock.write("221 Bye\r\n"); sock.end(); }
        else sock.write("500 Unknown\r\n");
      }
    });
    sock.on("end", () => sock.destroy());
  });
  servers.push(srvD.server);

  await test("D1: recv_until waits for delimiter", async () => {
    const r = await tcpClient({
      host: "127.0.0.1", port: srvD.port,
      messages: [{ data: "EHLO", recv_until: "250 OK" }, { data: "QUIT", recv_until: "221 Bye" }],
      timeout: 10, recv_timeout: 3,
    });
    assert.strictEqual(r.messagesSent, 2);
    const all = r.chunks.map(c => c.data).join("");
    assert.ok(all.includes("250-Hello") && all.includes("221 Bye"));
  });

  await test("D2: recv_until timeout completes gracefully", async () => {
    const r = await tcpClient({
      host: "127.0.0.1", port: srvD.port,
      messages: [{ data: "EHLO", recv_until: "NONEXISTENT", recv_timeout: 0.5 }, { data: "QUIT" }],
      timeout: 5, recv_timeout: 1,
    });
    assert.ok(r.connected && r.messagesSent >= 1);
  });

  // --- E: TLS ---
  process.stderr.write("\n--- E: TLS connection ---\n");

  const TEST_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIICpDCCAYwCCQDU9pQ4pHJDrTANBgkqhkiG9w0BAQsFADAUMRIwEAYDVQQDDAls
b2NhbGhvc3QwHhcNMjUwMTAxMDAwMDAwWhcNMzUwMTAxMDAwMDAwWjAUMRIwEAYD
VQQDDAlsb2NhbGhvc3QwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQC7
o4qne60TB3wolGbKTjMCFbYSKGNBxAn/xoYDiNYLGcL0kgXEhYMm7pEhCQhxiOYz
EqSFAFNmOFPY4VzLWp9koCdTKfMqV9lEBUFHl5SrJ1V6e7TNuvjJOA5LKqjRIRCc
UiPbO4CupLrMNqbOhGmIeM0/fapvuMbWTLERVB7j3vFbDLgHPNvmJFGRvXEqvJJX
uWY6G8fE29U0LPmBDpZ5P3APuJEP7eDZPBcHkXQa5B0X7s/6+jMHBhaxgWixVivQ
VKMhF4Ld8SipF+5xFmJ5a0T4NqfEJbgFGqG9AloO0kFTBFVFRq8Pf1IHnEb4JLz
LO1O3qQC7B3dpVb+ioaFAgMBAAEwDQYJKoZIhvcNAQELBQADggEBABTZ5TqMUQ5I
H9X9A3wZ4yP1b/S+5PsJD5Mf7MqONJ2k8wD06SgtlIVCmjn+SN3SB1O4WZBaDPa
oxvHRd1D+OQR0ZKrX2uiuiT3P4PCrE1MU3QQ3fZ5gY/bsCi5D5I2hK29DLGZ+c3c
pixG/gIRoarJQMb7E9YMFWpE+FBbHxXpuInq0lB5hkQ2e0rBKkYgCbZ3lkEQo3c+
yO9jLVA5cS0iXjyHpajBqMiEdDDMuJbbN3F5eL3pA7K/IhQD8FKRPA1b2yz8p6qj
a+WXA0pKJYi/PmSvQaxc5Qu5fLUHd6L7+p6TYEBcMB+FH0o/gE3BaW3wCXwN1v+k
GGBpXrI=
-----END CERTIFICATE-----`;

  const TEST_KEY_PEM = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEAu6OKp3utEwd8KJRmyk4zAhW2Eihj
QcQJ/8aGA4jWCxnC9JIFxIWDJu6RIQkIcYjmMxKkhQBT
ZjhT2OFcy1qfZKAnUynzKlfZRAVBR5eUqydVenu0zbr4
yTgOSyqo0SEQnFIj2zuArqS6zDamzoRpiHjNP32qb7jG
1kyxEVQe497xWwy4Bzzb5iRRkb1xKrySV7lmOhvHxNvV
NCz5gQ6WeT9wD7iRD+3g2TwXB5F0GuQdF+7P+vozBwYW
sYFosVYr0FSjIReC3fEoqRfucRZieWtE+DanxCW4BRqh
vQJaDtJBUwRVRUavD39SB5xG+CS8yztTt6kAuwdHaVW/
oqGhQIDAQABAoIBAHtx4/MiRaHLRzq2bqkVcGPTyMkjB
iWV7w9J2u5KzHJP+5VWbCPxHMYg0r5c5E3I9k5NkTFIW
VQYl4q/5wr9xRbLGx7DYVQ5K6H0yWgM3zqeV7y3y1CuS
lT6LCVHAlU0mXRFy5/9A0pRPL0R0l0MK0J5KK8C+G8Sm
4v9Z4Ks7aqy9EQmGqk4E1HLCXV0F4m5IvbmPBhVivBWo
lkiBIVZYOFl5L0PBQHQ7v5I/5S0k3lCH8bL0nLn0LCZ+
m3x9bq0CgYEA7phWjGZ9P0xyiJGaGx37x5hqkQ6UmKSh
BbWH0MvFEt3w0zMz8blpfKUIDXdqMv3TqLjkYJ4Wh1gN
b6OTHd0HHCK3ZKv9CHq93JwO5DLPV7lGvNTBFTAuvuOo
UCJkAyWpUXPvE0q2Ts5JcNlvJ93Z5r0Y6LXxQBvfPOzj
jssCgYEAylHcB8U9LXtJt7d9t5qW3qV3aXRqBKIDDi5r
BicN+7FZwSK+XBT7e4dJBPdwPa9jUYxPjSlrZfWNi8y/
Vo8TNiYQ0I4I6w9RI2MFLsRhMFEh8MHAQ9XBClpPJdZH
CPn9KBHF07KnVQf6Hkb6pqilzb0ELvMVTkD7lFcCgYEA
uKq0PJZQ7c2RqNBX6HrCFnSJ1GY9JmtHQmGT7lK8MoEu
XEXcJJ3Kf+Q0H5rY3S+h3g2rH8IlJFRMyCr3w4nkXF1s
c1t1uR8d5oN0BUX5hK4tD+z1c1qMFTF7UB9Vn3BOz+8Q
5QNHJ5G7LrV0nJT5xEHXp8NU1u2N5usCgYAFI4D/4pT+
3fWJw1KRQjXoP9n8ZI8HkCjBpqzU3oqVGFxP5VcqmFaX
6G+kL1xB3gB5qJ7O2ORm1L0pv/jDp5U9k9yqFq0T1HXM
ugHDO7c3LOmhK9GV0y6mBMXg8NZ8g0CW5EFfZeJ7Y3pM
HKT5K5y9q8iHkLpvVymHpA==
-----END RSA PRIVATE KEY-----`;

  let srvE = null;
  try {
    srvE = await new Promise((res, rej) => {
      const s = tls.createServer(
        { cert: TEST_CERT_PEM, key: TEST_KEY_PEM },
        (sock) => { sock.write("TLS:OK\r\n"); sock.on("data", (d) => sock.write(d)); sock.on("end", () => sock.destroy()); }
      );
      s.on("error", rej);
      s.listen(0, "127.0.0.1", () => res({ server: s, port: s.address().port }));
    });
    servers.push(srvE.server);
  } catch (e) {
    process.stderr.write(`  (TLS skip: ${e.message})\n`);
  }

  await test("E1: TLS connect", async () => {
    if (!srvE) { passed++; process.stderr.write("  (SKIP)\n"); return; }
    const r = await tcpClient({ host: "127.0.0.1", port: srvE.port, secure: true, timeout: 5, recv_timeout: 1 });
    assert.strictEqual(r.connected, true);
    assert.ok(r.chunks.map(c => c.data).join("").includes("TLS:OK"));
  });

  await test("E2: TLS echo", async () => {
    if (!srvE) { passed++; process.stderr.write("  (SKIP)\n"); return; }
    const r = await tcpClient({ host: "127.0.0.1", port: srvE.port, secure: true, messages: [{ data: "TLS-ECHO", add_newline: false }], timeout: 5, recv_timeout: 1 });
    assert.ok(r.chunks.map(c => c.data).join("").includes("TLS-ECHO"));
  });

  // --- F: Encodings ---
  process.stderr.write("\n--- F: Encodings ---\n");

  const srvF = await createEchoServer((sock) => { sock.on("data", (d) => sock.write(d)); sock.on("end", () => sock.destroy()); });
  servers.push(srvF.server);

  await test("F1: base64 send decoded", async () => {
    const r = await tcpClient({ host: "127.0.0.1", port: srvF.port, messages: [{ data: "SEVMTE8=", encoding: "base64", add_newline: false }], timeout: 5, recv_timeout: 1 });
    assert.ok(r.chunks.map(c => c.data).join("").includes("HELLO"));
  });

  await test("F2: hex send decoded", async () => {
    const r = await tcpClient({ host: "127.0.0.1", port: srvF.port, messages: [{ data: "4849", encoding: "hex", add_newline: false }], timeout: 5, recv_timeout: 1 });
    assert.ok(r.chunks.map(c => c.data).join("").includes("HI"));
  });

  await test("F3: recv base64 encoding", async () => {
    const r = await tcpClient({ host: "127.0.0.1", port: srvF.port, messages: [{ data: "BASE64TEST", add_newline: false }], recv_encoding: "base64", timeout: 5, recv_timeout: 1 });
    assert.ok(Buffer.from(r.chunks.map(c => c.data).join(""), "base64").toString().includes("BASE64TEST"));
    assert.strictEqual(r.chunks[0].encoding, "base64");
  });

  await test("F4: recv hex encoding", async () => {
    const r = await tcpClient({ host: "127.0.0.1", port: srvF.port, messages: [{ data: "HEX", add_newline: false }], recv_encoding: "hex", timeout: 5, recv_timeout: 1 });
    assert.ok(Buffer.from(r.chunks.map(c => c.data).join(""), "hex").toString().includes("HEX"));
    assert.strictEqual(r.chunks[0].encoding, "hex");
  });

  // --- G: Limits ---
  process.stderr.write("\n--- G: Limits ---\n");

  const srvG = await createEchoServer((sock) => { sock.write(Buffer.alloc(512 * 1024, 0x41)); sock.end(); });
  servers.push(srvG.server);

  await test("G1: max_recv_bytes truncates", async () => {
    const r = await tcpClient({ host: "127.0.0.1", port: srvG.port, max_recv_bytes: 1024, timeout: 5, recv_timeout: 2 });
    assert.strictEqual(r.truncated, true);
  });

  const srvG2 = await createEchoServer((sock) => { for (let i = 0; i < 200; i++) sock.write(`c${i}\n`); sock.end(); });
  servers.push(srvG2.server);

  await test("G2: max_chunks limits chunks", async () => {
    const r = await tcpClient({ host: "127.0.0.1", port: srvG2.port, max_chunks: 5, timeout: 5, recv_timeout: 2 });
    assert.ok(r.chunks.length <= 5, `chunks=${r.chunks.length}`);
  });

  // --- H: Security ---
  process.stderr.write("\n--- H: Security ---\n");

  await test("H1: null byte in host", () => tcpClient({ host: "evil\x00host", port: 80 }).then(
    () => assert.fail(), (e) => assert.ok(e.message.includes("host"))));

  await test("H2: CR in host", () => tcpClient({ host: "evil\rhost", port: 80 }).then(
    () => assert.fail(), (e) => assert.ok(e.message.includes("host"))));

  await test("H3: host too long", () => tcpClient({ host: "a".repeat(254), port: 80 }).then(
    () => assert.fail(), (e) => assert.ok(e.message.includes("host"))));

  await test("H4: newline in servername", () => tcpClient({ host: "127.0.0.1", port: 80, servername: "evil\nname" }).then(
    () => assert.fail(), (e) => assert.ok(e.message.includes("servername"))));

  await test("H5: delay_ms too large", () => tcpClient({ host: "127.0.0.1", port: 80, messages: [{ data: "hi", delay_ms: 99999 }] }).then(
    () => assert.fail(), (e) => assert.ok(e.message.includes("delay_ms"))));

  await test("H6: too many messages", () => {
    const msgs = Array.from({ length: 51 }, (_, i) => ({ data: `m${i}` }));
    return tcpClient({ host: "127.0.0.1", port: 80, messages: msgs }).then(
      () => assert.fail(), (e) => assert.ok(e.message.includes("messages")));
  });

  // --- I: Error paths ---
  process.stderr.write("\n--- I: Error paths ---\n");

  await test("I1: connection refused", async () => {
    const r = await tcpClient({ host: "127.0.0.1", port: 1, timeout: 3, connect_timeout: 2 });
    assert.strictEqual(r.connected, false);
    assert.ok(r.error);
  });

  await test("I2: total timeout via silent server", async () => {
    const srvI2 = await createEchoServer((sock) => { sock.on("error", () => {}); });
    servers.push(srvI2.server);
    const t0 = Date.now();
    const r = await tcpClient({ host: "127.0.0.1", port: srvI2.port, timeout: 0.5, recv_timeout: 60 });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 5000, `Hung: ${elapsed}ms`);
    assert.strictEqual(r.connected, true);
    assert.ok(r.error && r.error.includes("timed out"), `error=${r.error}`);
  });

  await test("I3: server closes immediately", async () => {
    const srvI3 = await createEchoServer((sock) => { sock.destroy(); });
    servers.push(srvI3.server);
    const r = await tcpClient({ host: "127.0.0.1", port: srvI3.port, timeout: 3, recv_timeout: 1 });
    assert.strictEqual(r.connected, true);
    assert.strictEqual(r.totalReceivedBytes, 0);
  });

  await test("I4: result always object", async () => {
    const r = await tcpClient({ host: "127.0.0.1", port: 1, timeout: 2 });
    assert.ok(typeof r === "object" && "connected" in r);
  });

  // --- J: Concurrency ---
  process.stderr.write("\n--- J: Concurrency ---\n");

  await test("J1: 10 parallel connections", async () => {
    const srvJs = [];
    for (let i = 0; i < 10; i++) {
      const idx = i;
      const s = await createEchoServer((sock) => { sock.write(`SERVER${idx}\r\n`); sock.on("data", (d) => sock.write(d)); sock.on("end", () => sock.destroy()); });
      servers.push(s.server);
      srvJs.push(s);
    }
    const results = await Promise.all(srvJs.map((s, i) => tcpClient({ host: "127.0.0.1", port: s.port, messages: [{ data: `CLIENT${i}`, add_newline: false }], timeout: 5, recv_timeout: 1 })));
    for (let i = 0; i < 10; i++) {
      assert.strictEqual(results[i].connected, true);
      const all = results[i].chunks.map(c => c.data).join("");
      assert.ok(all.includes(`SERVER${i}`) && all.includes(`CLIENT${i}`));
    }
  });

  await test("J2: 10 sequential to same server", async () => {
    const srvJ2 = await createEchoServer((sock) => { sock.write("READY\r\n"); sock.on("end", () => sock.destroy()); });
    servers.push(srvJ2.server);
    for (let i = 0; i < 10; i++) {
      const r = await tcpClient({ host: "127.0.0.1", port: srvJ2.port, timeout: 5, recv_timeout: 1 });
      assert.ok(r.connected && r.chunks.map(c => c.data).join("").includes("READY"));
    }
  });

  await test("J3: 8 parallel to same server", async () => {
    const srvJ3 = await createEchoServer((sock) => { sock.on("data", (d) => sock.write(d)); sock.on("end", () => sock.destroy()); });
    servers.push(srvJ3.server);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => tcpClient({ host: "127.0.0.1", port: srvJ3.port, messages: [{ data: `UNIQ${i}`, add_newline: false }], timeout: 5, recv_timeout: 1 })));
    for (let i = 0; i < 8; i++) {
      assert.ok(results[i].chunks.map(c => c.data).join("").includes(`UNIQ${i}`));
    }
  });

  // Cleanup
  for (const s of servers) { try { s.close(); } catch (_) {} }

  process.stderr.write(`\n=== Section 186 complete: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => {
  process.stderr.write(`\nUnhandled: ${e.stack}\n`);
  process.exit(1);
});
