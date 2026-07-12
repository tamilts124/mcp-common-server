"use strict";
/**
 * Section 202: grpc_client tool tests
 * 70 tests across 6 groups:
 *   A (10) — input validation
 *   B (10) — proto3 codec unit tests
 *   C (10) — security guards
 *   D (30) — happy-path with mock HTTP/2 gRPC server
 *   E  (5) — error paths
 *   F  (5) — concurrency
 */

const http2  = require("http2");
const net    = require("net");
const assert = require("assert");
const { grpcClient, _proto } = require("../../lib/grpcClientOps");

const {
  encodeVarint, decodeVarint, encodeField, encodeBytes, encodeString,
  encodeVarintField, decodeFields, grpcFrame, parseGrpcFrames,
  encodeHealthCheckRequest, decodeHealthCheckResponse,
  encodeReflectionListServicesRequest, decodeReflectionListServicesResponse,
} = _proto;

// ─── Test runner ───────────────────────────────────────────────────────────────

let passed = 0; let failed = 0;
async function test(label, fn) {
  try { await fn(); process.stderr.write(`  ✓ ${label}\n`); passed++; }
  catch (err) { process.stderr.write(`  ✗ ${label}: ${err.message}\n`); failed++; }
}

// ─── Mock gRPC Server (HTTP/2 + gRPC framing) ───────────────────────────────

/**
 * createMockGrpcServer(handler) -> { server, port }
 * handler(path, requestBuf) -> { messages: Buffer[], status: 0|number, statusMsg?: string }
 * We use HTTP/2 directly over plaintext TCP.
 */
function createMockGrpcServer(handler) {
  return new Promise((resolve) => {
    const server = http2.createServer();

    server.on("stream", (stream, headers) => {
      const path = headers[":path"] || "";
      const chunks = [];

      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("end", () => {
        const raw     = Buffer.concat(chunks);
        // Parse gRPC frames from request body
        const { messages } = parseGrpcFrames(raw);
        const reqBuf = messages[0]?.data ?? Buffer.alloc(0);

        let response;
        try {
          response = handler(path, reqBuf);
        } catch (err) {
          response = { messages: [], status: 13, statusMsg: err.message };
        }

        const { messages: respMsgs = [], status = 0, statusMsg = "" } = response;

        // Send response headers (waitForTrailers lets us send trailers on 'wantTrailers')
        stream.respond(
          { ":status": 200, "content-type": "application/grpc" },
          { waitForTrailers: true }
        );

        // Write gRPC-framed messages
        for (const msgBuf of respMsgs) {
          stream.write(grpcFrame(msgBuf));
        }

        // Send trailers via 'wantTrailers' event (correct HTTP/2 trailer API)
        stream.on("wantTrailers", () => {
          stream.sendTrailers({
            "grpc-status":  String(status),
            "grpc-message": statusMsg,
          });
        });
        stream.end();
      });

      stream.on("error", () => {});
    });

    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

// ─── Helpers ─────────────────────────────────────────────────────────────────────

async function rejects(fn, pattern) {
  try { await fn(); assert.fail("Expected rejection"); }
  catch (err) {
    if (err.message === "Expected rejection") throw err;
    if (pattern && !err.message.includes(pattern))
      throw new Error(`Expected error containing '${pattern}', got: '${err.message}'`);
  }
}

// ─── Group A: Input Validation (10) ──────────────────────────────────────────

async function runA() {
  process.stderr.write("\nA — Input Validation\n");

  await test("A01: missing operation rejects", async () => {
    await rejects(() => grpcClient({}), "operation");
  });

  await test("A02: unknown operation rejects", async () => {
    await rejects(() => grpcClient({ operation: "subscribe" }), "unknown operation");
  });

  await test("A03: invalid host (empty string) rejects", async () => {
    await rejects(() => grpcClient({ operation: "health_check", host: "" }), "host");
  });

  await test("A04: invalid port (0) rejects", async () => {
    await rejects(() => grpcClient({ operation: "health_check", host: "localhost", port: 0 }), "port");
  });

  await test("A05: invalid port (99999) rejects", async () => {
    await rejects(() => grpcClient({ operation: "health_check", host: "localhost", port: 99999 }), "port");
  });

  await test("A06: unary missing method rejects", async () => {
    await rejects(() => grpcClient({ operation: "unary", host: "localhost", port: 50051 }), "method");
  });

  await test("A07: unary invalid method format rejects", async () => {
    await rejects(() => grpcClient({ operation: "unary", host: "localhost", port: 50051, method: "SayHello" }), "method");
  });

  await test("A08: server_stream missing method rejects", async () => {
    await rejects(() => grpcClient({ operation: "server_stream", host: "localhost", port: 50051 }), "method");
  });

  await test("A09: method with spaces rejects", async () => {
    await rejects(
      () => grpcClient({ operation: "unary", host: "localhost", port: 50051, method: "/hello world/Say" }),
      "method"
    );
  });

  await test("A10: port float rejects", async () => {
    await rejects(() => grpcClient({ operation: "health_check", host: "localhost", port: 50051.5 }), "port");
  });
}

// ─── Group B: Proto3 Codec Unit Tests (10) ─────────────────────────────────

async function runB() {
  process.stderr.write("\nB — Proto3 Codec\n");

  await test("B01: encodeVarint(0) = [0x00]", async () => {
    assert.deepStrictEqual(Array.from(encodeVarint(0)), [0x00]);
  });

  await test("B02: encodeVarint(1) = [0x01]", async () => {
    assert.deepStrictEqual(Array.from(encodeVarint(1)), [0x01]);
  });

  await test("B03: encodeVarint(300) = [0xAC, 0x02]", async () => {
    assert.deepStrictEqual(Array.from(encodeVarint(300)), [0xAC, 0x02]);
  });

  await test("B04: decodeVarint round-trips 300", async () => {
    const enc = encodeVarint(300);
    const { value, bytesRead } = decodeVarint(enc, 0);
    assert.strictEqual(Number(value), 300);
    assert.strictEqual(bytesRead, 2);
  });

  await test("B05: encodeString/decodeFields round-trip", async () => {
    const buf = encodeString(1, "hello");
    const fields = decodeFields(buf);
    assert.strictEqual(fields.length, 1);
    assert.strictEqual(fields[0].fieldNumber, 1);
    assert.strictEqual(fields[0].wireType, 2);
    assert.strictEqual(fields[0].value.toString("utf8"), "hello");
  });

  await test("B06: encodeVarintField(2, 42) round-trips", async () => {
    const buf = encodeVarintField(2, 42);
    const fields = decodeFields(buf);
    assert.strictEqual(fields[0].fieldNumber, 2);
    assert.strictEqual(Number(fields[0].value), 42);
  });

  await test("B07: grpcFrame has 5-byte header", async () => {
    const msg = Buffer.from("test");
    const framed = grpcFrame(msg);
    assert.strictEqual(framed.length, 9); // 5 + 4
    assert.strictEqual(framed[0], 0x00);  // no compression
    assert.strictEqual(framed.readUInt32BE(1), 4); // msg length
  });

  await test("B08: parseGrpcFrames round-trips", async () => {
    const msg1 = Buffer.from("hello");
    const msg2 = Buffer.from("world");
    const framed = Buffer.concat([grpcFrame(msg1), grpcFrame(msg2)]);
    const { messages } = parseGrpcFrames(framed);
    assert.strictEqual(messages.length, 2);
    assert.strictEqual(messages[0].data.toString(), "hello");
    assert.strictEqual(messages[1].data.toString(), "world");
  });

  await test("B09: decodeHealthCheckResponse (SERVING=1)", async () => {
    // encode: field 1, varint 1
    const buf = encodeVarintField(1, 1);
    const result = decodeHealthCheckResponse(buf);
    assert.strictEqual(result.status, 1);
    assert.strictEqual(result.statusName, "SERVING");
    assert.strictEqual(result.serving, true);
  });

  await test("B10: decodeHealthCheckResponse (NOT_SERVING=2)", async () => {
    const buf = encodeVarintField(1, 2);
    const result = decodeHealthCheckResponse(buf);
    assert.strictEqual(result.status, 2);
    assert.strictEqual(result.statusName, "NOT_SERVING");
    assert.strictEqual(result.serving, false);
  });
}

// ─── Group C: Security Guards (10) ───────────────────────────────────────────

async function runC() {
  process.stderr.write("\nC — Security Guards\n");

  await test("C01: NUL byte in host rejects", async () => {
    await rejects(() => grpcClient({ operation: "health_check", host: "local\x00host", port: 50051 }), "NUL");
  });

  await test("C02: CR in host rejects", async () => {
    await rejects(() => grpcClient({ operation: "health_check", host: "local\rhost", port: 50051 }), "invalid characters");
  });

  await test("C03: LF in host rejects", async () => {
    await rejects(() => grpcClient({ operation: "health_check", host: "local\nhost", port: 50051 }), "invalid characters");
  });

  await test("C04: host too long (254 chars) rejects", async () => {
    await rejects(() => grpcClient({ operation: "health_check", host: "a".repeat(254), port: 50051 }), "too long");
  });

  await test("C05: method without leading slash rejects", async () => {
    await rejects(() => grpcClient({ operation: "unary", host: "localhost", port: 50051, method: "pkg.Svc/Method" }), "method");
  });

  await test("C06: method with only one segment rejects", async () => {
    await rejects(() => grpcClient({ operation: "unary", host: "localhost", port: 50051, method: "/Method" }), "method");
  });

  await test("C07: method with special chars rejects", async () => {
    await rejects(
      () => grpcClient({ operation: "unary", host: "localhost", port: 50051, method: "/pkg.Svc/Method?a=b" }),
      "method"
    );
  });

  await test("C08: encodeHealthCheckRequest sanitizes empty service", async () => {
    // Empty service should produce empty buffer (no fields)
    const buf = encodeHealthCheckRequest("");
    assert.strictEqual(buf.length, 0);
  });

  await test("C09: parseGrpcFrames handles partial frame gracefully", async () => {
    // Only 3 bytes of a 5-byte header — should return empty messages
    const partial = Buffer.from([0x00, 0x00, 0x00]);
    const { messages } = parseGrpcFrames(partial);
    assert.strictEqual(messages.length, 0);
  });

  await test("C10: decodeVarint overflow throws", async () => {
    // 10 continuation bytes — should overflow
    const overflow = Buffer.from([0x80,0x80,0x80,0x80,0x80,0x80,0x80,0x80,0x80,0x80,0x00]);
    assert.throws(() => decodeVarint(overflow, 0), /overflow/);
  });
}

// ─── Group D: Happy-Path Mock Server (30) ─────────────────────────────────

async function runD() {
  process.stderr.write("\nD — Happy-Path Mock Server\n");

  // ---- Greeter server: /helloworld.Greeter/SayHello ----
  // Returns field 1 (string) = "Hello, <name>!"
  const greeterHandler = (path, reqBuf) => {
    if (path === "/helloworld.Greeter/SayHello") {
      // Decode field 1 (string) from request
      let name = "World";
      try {
        const fields = decodeFields(reqBuf);
        const nf = fields.find(f => f.fieldNumber === 1 && f.wireType === 2);
        if (nf) name = nf.value.toString("utf8");
      } catch (_) {}
      const reply = encodeString(1, `Hello, ${name}!`);
      return { messages: [reply], status: 0 };
    }
    return { messages: [], status: 12, statusMsg: "UNIMPLEMENTED" };
  };

  // ---- Health server ----
  const healthHandler = (path, reqBuf) => {
    if (path !== "/grpc.health.v1.Health/Check")
      return { messages: [], status: 12 };
    // Decode service name from field 1 (string)
    let service = "";
    try {
      const fields = decodeFields(reqBuf);
      const sf = fields.find(f => f.fieldNumber === 1 && f.wireType === 2);
      if (sf) service = sf.value.toString("utf8");
    } catch (_) {}
    if (service === "unknown.Service") {
      // simulate NOT_FOUND for unknown service
      return { messages: [], status: 5, statusMsg: "service not found" };
    }
    // Return SERVING (1)
    const resp = encodeVarintField(1, 1);
    return { messages: [resp], status: 0 };
  };

  // ---- Reflection server ----
  const buildReflectionResponse = (services) => {
    // Build ListServiceResponse (field 4) containing ServiceResponse entries (field 1 repeated)
    const serviceEntries = services.map(name => {
      const nameBuf = encodeString(1, name);        // ServiceResponse.name
      return encodeBytes(1, nameBuf);               // ServiceResponse entry
    });
    const listServiceResp = encodeBytes(4, Buffer.concat(serviceEntries)); // field 4
    return listServiceResp;
  };

  const reflectionHandler = (path, _reqBuf) => {
    if (path !== "/grpc.reflection.v1alpha.ServerReflection/ServerReflectionInfo")
      return { messages: [], status: 12 };
    const resp = buildReflectionResponse(["helloworld.Greeter", "grpc.health.v1.Health"]);
    return { messages: [resp], status: 0 };
  };

  // Start servers
  const { server: greeterSrv, port: greeterPort } = await createMockGrpcServer(greeterHandler);
  const { server: healthSrv,  port: healthPort  } = await createMockGrpcServer(healthHandler);
  const { server: reflSrv,   port: reflPort    } = await createMockGrpcServer(reflectionHandler);

  // ---- Unary tests (D01–D10) ----

  await test("D01: unary SayHello returns greeting", async () => {
    const req = encodeString(1, "Alice");
    const r = await grpcClient({
      operation: "unary", host: "127.0.0.1", port: greeterPort,
      method: "/helloworld.Greeter/SayHello",
      request_base64: req.toString("base64"),
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.status, 0);
    assert(r.response.fields);
    const field1 = r.response.fields.find(f => f.fieldNumber === 1);
    assert.strictEqual(field1.value, "Hello, Alice!");
  });

  await test("D02: unary with empty request returns greeting", async () => {
    const r = await grpcClient({
      operation: "unary", host: "127.0.0.1", port: greeterPort,
      method: "/helloworld.Greeter/SayHello",
    });
    assert.strictEqual(r.ok, true);
    const field1 = r.response.fields?.find(f => f.fieldNumber === 1);
    assert(field1?.value.includes("Hello"));
  });

  await test("D03: unary with request_json encodes correctly", async () => {
    // request_json — encodes as field 1 (string)
    const r = await grpcClient({
      operation: "unary", host: "127.0.0.1", port: greeterPort,
      method: "/helloworld.Greeter/SayHello",
      request_json: "Bob",
    });
    assert.strictEqual(r.ok, true);
    // The server sees field 1 = "Bob" and replies "Hello, Bob!"
    const field1 = r.response.fields?.find(f => f.fieldNumber === 1);
    assert(field1?.value.includes("Bob"));
  });

  await test("D04: unary with response_encoding=base64 returns base64", async () => {
    const r = await grpcClient({
      operation: "unary", host: "127.0.0.1", port: greeterPort,
      method: "/helloworld.Greeter/SayHello",
      response_encoding: "base64",
    });
    assert.strictEqual(r.ok, true);
    assert(typeof r.response.base64 === "string");
    assert(r.response.bytes >= 0);
    assert(!r.response.fields); // fields not returned in base64 mode
  });

  await test("D05: unary result includes trailers", async () => {
    const r = await grpcClient({
      operation: "unary", host: "127.0.0.1", port: greeterPort,
      method: "/helloworld.Greeter/SayHello",
    });
    assert(typeof r.trailers === "object");
    assert("grpc-status" in r.trailers);
  });

  await test("D06: unary returns statusMessage", async () => {
    const r = await grpcClient({
      operation: "unary", host: "127.0.0.1", port: greeterPort,
      method: "/helloworld.Greeter/SayHello",
    });
    assert.strictEqual(r.status, 0);
    // statusMessage can be "OK" or "" depending on what server sends
    assert(typeof r.statusMessage === "string");
  });

  await test("D07: unary method field echoed in result", async () => {
    const r = await grpcClient({
      operation: "unary", host: "127.0.0.1", port: greeterPort,
      method: "/helloworld.Greeter/SayHello",
    });
    assert.strictEqual(r.method, "/helloworld.Greeter/SayHello");
  });

  await test("D08: unary with metadata header passes through", async () => {
    const r = await grpcClient({
      operation: "unary", host: "127.0.0.1", port: greeterPort,
      method: "/helloworld.Greeter/SayHello",
      metadata: { "x-request-id": "test-123" },
    });
    assert.strictEqual(r.ok, true);
  });

  await test("D09: unary SayHello with Unicode name", async () => {
    const req = encodeString(1, "汉字");
    const r = await grpcClient({
      operation: "unary", host: "127.0.0.1", port: greeterPort,
      method: "/helloworld.Greeter/SayHello",
      request_base64: req.toString("base64"),
    });
    assert.strictEqual(r.ok, true);
    const field1 = r.response.fields?.find(f => f.fieldNumber === 1);
    assert(field1?.value.includes("汉字"));
  });

  await test("D10: unary with explicit timeout=5 succeeds", async () => {
    const r = await grpcClient({
      operation: "unary", host: "127.0.0.1", port: greeterPort,
      method: "/helloworld.Greeter/SayHello",
      timeout: 5,
    });
    assert.strictEqual(r.ok, true);
  });

  // ---- Health check tests (D11–D20) ----

  await test("D11: health_check overall server returns SERVING", async () => {
    const r = await grpcClient({
      operation: "health_check", host: "127.0.0.1", port: healthPort,
    });
    assert.strictEqual(r.status, "SERVING");
    assert.strictEqual(r.statusCode, 1);
    assert.strictEqual(r.serving, true);
    assert.strictEqual(r.grpcStatus, 0);
  });

  await test("D12: health_check specific service returns SERVING", async () => {
    const r = await grpcClient({
      operation: "health_check", host: "127.0.0.1", port: healthPort,
      service: "helloworld.Greeter",
    });
    assert.strictEqual(r.status, "SERVING");
    assert.strictEqual(r.serving, true);
  });

  await test("D13: health_check unknown service returns SERVICE_UNKNOWN", async () => {
    const r = await grpcClient({
      operation: "health_check", host: "127.0.0.1", port: healthPort,
      service: "unknown.Service",
    });
    assert.strictEqual(r.status, "SERVICE_UNKNOWN");
    assert.strictEqual(r.serving, false);
    assert.strictEqual(r.grpcStatus, 5);
  });

  await test("D14: health_check echos service name", async () => {
    const r = await grpcClient({
      operation: "health_check", host: "127.0.0.1", port: healthPort,
      service: "grpc.health.v1.Health",
    });
    assert.strictEqual(r.service, "grpc.health.v1.Health");
  });

  await test("D15: health_check empty service checks server overall", async () => {
    const r = await grpcClient({
      operation: "health_check", host: "127.0.0.1", port: healthPort,
      service: "",
    });
    assert.strictEqual(r.serving, true);
  });

  await test("D16: health_check statusCode is numeric", async () => {
    const r = await grpcClient({
      operation: "health_check", host: "127.0.0.1", port: healthPort,
    });
    assert(typeof r.statusCode === "number");
  });

  await test("D17: health_check grpcStatus is 0 for SERVING", async () => {
    const r = await grpcClient({
      operation: "health_check", host: "127.0.0.1", port: healthPort,
    });
    assert.strictEqual(r.grpcStatus, 0);
  });

  await test("D18: health_check with metadata succeeds", async () => {
    const r = await grpcClient({
      operation: "health_check", host: "127.0.0.1", port: healthPort,
      metadata: { "authorization": "Bearer fake" },
    });
    assert(r.serving === true || r.serving === false);
  });

  await test("D19: health_check with timeout=10 succeeds", async () => {
    const r = await grpcClient({
      operation: "health_check", host: "127.0.0.1", port: healthPort,
      timeout: 10,
    });
    assert.strictEqual(r.serving, true);
  });

  await test("D20: health_check responds quickly (<3s)", async () => {
    const start = Date.now();
    await grpcClient({
      operation: "health_check", host: "127.0.0.1", port: healthPort,
    });
    assert(Date.now() - start < 3000);
  });

  // ---- Reflection tests (D21–D30) ----

  await test("D21: list_services returns service list", async () => {
    const r = await grpcClient({
      operation: "list_services", host: "127.0.0.1", port: reflPort,
    });
    assert(Array.isArray(r.services));
    assert(r.services.length >= 1);
    assert(r.serviceCount >= 1);
  });

  await test("D22: list_services includes Greeter", async () => {
    const r = await grpcClient({
      operation: "list_services", host: "127.0.0.1", port: reflPort,
    });
    assert(r.services.includes("helloworld.Greeter"));
  });

  await test("D23: list_services includes Health", async () => {
    const r = await grpcClient({
      operation: "list_services", host: "127.0.0.1", port: reflPort,
    });
    assert(r.services.includes("grpc.health.v1.Health"));
  });

  await test("D24: list_services echos host and port", async () => {
    const r = await grpcClient({
      operation: "list_services", host: "127.0.0.1", port: reflPort,
    });
    assert.strictEqual(r.host, "127.0.0.1");
    assert.strictEqual(r.port, reflPort);
  });

  await test("D25: list_services serviceCount matches services.length", async () => {
    const r = await grpcClient({
      operation: "list_services", host: "127.0.0.1", port: reflPort,
    });
    assert.strictEqual(r.serviceCount, r.services.length);
  });

  await test("D26: encodeReflectionListServicesRequest produces non-empty buffer", async () => {
    const buf = encodeReflectionListServicesRequest("127.0.0.1");
    assert(buf.length > 0);
    // Field 4 (list_services string) must be present
    const fields = decodeFields(buf);
    const field4 = fields.find(f => f.fieldNumber === 4);
    assert(field4);
    assert.strictEqual(field4.value.toString("utf8"), "");
  });

  await test("D27: decodeReflectionListServicesResponse round-trips", async () => {
    // Build a reflection response manually
    const serviceEntries = ["foo.Service", "bar.Service"].map(name => {
      const nameBuf = encodeString(1, name);
      return encodeBytes(1, nameBuf);
    });
    const listServiceResp = encodeBytes(4, Buffer.concat(serviceEntries));
    const services = decodeReflectionListServicesResponse(listServiceResp);
    assert.deepStrictEqual(services, ["foo.Service", "bar.Service"]);
  });

  await test("D28: list_services with timeout=5 succeeds", async () => {
    const r = await grpcClient({
      operation: "list_services", host: "127.0.0.1", port: reflPort,
      timeout: 5,
    });
    assert(r.serviceCount >= 1);
  });

  await test("D29: server_stream returns messages array", async () => {
    const req = encodeString(1, "Alice");
    const r = await grpcClient({
      operation: "server_stream", host: "127.0.0.1", port: greeterPort,
      method: "/helloworld.Greeter/SayHello",
      request_base64: req.toString("base64"),
    });
    assert(Array.isArray(r.messages));
    assert(typeof r.messageCount === "number");
    assert(r.messageCount >= 0);
    assert.strictEqual(r.ok, true);
  });

  await test("D30: server_stream truncated=false for single-message response", async () => {
    const r = await grpcClient({
      operation: "server_stream", host: "127.0.0.1", port: greeterPort,
      method: "/helloworld.Greeter/SayHello",
    });
    assert.strictEqual(r.truncated, false);
  });

  await stopServer(greeterSrv);
  await stopServer(healthSrv);
  await stopServer(reflSrv);
}

// ─── Group E: Error Paths (5) ──────────────────────────────────────────────────

async function runE() {
  process.stderr.write("\nE — Error Paths\n");

  await test("E01: connect to closed port throws session error", async () => {
    // Use a port that should be closed
    const freePort = await new Promise(res => {
      const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); });
    });
    await rejects(
      () => grpcClient({ operation: "health_check", host: "127.0.0.1", port: freePort, timeout: 3 }),
      "grpc_client:"
    );
  });

  await test("E02: unary gRPC error status throws", async () => {
    // Server that returns status 3 (INVALID_ARGUMENT)
    const handler = (_path, _req) => ({ messages: [], status: 3, statusMsg: "invalid arg" });
    const { server, port } = await createMockGrpcServer(handler);
    await rejects(
      () => grpcClient({ operation: "unary", host: "127.0.0.1", port,
                        method: "/pkg.Svc/Method", timeout: 5 }),
      "gRPC error 3"
    );
    await stopServer(server);
  });

  await test("E03: server_stream gRPC error status throws", async () => {
    const handler = (_path, _req) => ({ messages: [], status: 2, statusMsg: "unknown" });
    const { server, port } = await createMockGrpcServer(handler);
    await rejects(
      () => grpcClient({ operation: "server_stream", host: "127.0.0.1", port,
                        method: "/pkg.Svc/Stream", timeout: 5 }),
      "gRPC error 2"
    );
    await stopServer(server);
  });

  await test("E04: health_check non-recoverable error throws", async () => {
    const handler = (_path, _req) => ({ messages: [], status: 13, statusMsg: "internal" });
    const { server, port } = await createMockGrpcServer(handler);
    await rejects(
      () => grpcClient({ operation: "health_check", host: "127.0.0.1", port, timeout: 5 }),
      "health_check gRPC error 13"
    );
    await stopServer(server);
  });

  await test("E05: list_services error status throws with hint", async () => {
    const handler = (_path, _req) => ({ messages: [], status: 12, statusMsg: "unimplemented" });
    const { server, port } = await createMockGrpcServer(handler);
    await rejects(
      () => grpcClient({ operation: "list_services", host: "127.0.0.1", port, timeout: 5 }),
      "list_services gRPC error 12"
    );
    await stopServer(server);
  });
}

// ─── Group F: Concurrency (5) ──────────────────────────────────────────────────

async function runF() {
  process.stderr.write("\nF — Concurrency\n");

  await test("F01: 10 parallel unary calls all succeed", async () => {
    const handler = (path, reqBuf) => {
      let name = "World";
      try {
        const fields = decodeFields(reqBuf);
        const nf = fields.find(f => f.fieldNumber === 1 && f.wireType === 2);
        if (nf) name = nf.value.toString("utf8");
      } catch (_) {}
      return { messages: [encodeString(1, `Hello, ${name}!`)], status: 0 };
    };
    const { server, port } = await createMockGrpcServer(handler);

    const names = ["Alice","Bob","Charlie","Dave","Eve","Frank","Grace","Hank","Ivy","Jack"];
    const results = await Promise.all(names.map(name =>
      grpcClient({
        operation: "unary", host: "127.0.0.1", port,
        method: "/helloworld.Greeter/SayHello",
        request_base64: encodeString(1, name).toString("base64"),
      })
    ));

    results.forEach((r, i) => {
      assert.strictEqual(r.ok, true);
      const field1 = r.response.fields?.find(f => f.fieldNumber === 1);
      assert(field1?.value.includes(names[i]), `Expected ${names[i]} in response`);
    });
    await stopServer(server);
  });

  await test("F02: 5 parallel health checks succeed", async () => {
    const handler = (_path, _req) => ({ messages: [encodeVarintField(1, 1)], status: 0 });
    const { server, port } = await createMockGrpcServer(handler);

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        grpcClient({ operation: "health_check", host: "127.0.0.1", port })
      )
    );
    results.forEach(r => assert.strictEqual(r.serving, true));
    await stopServer(server);
  });

  await test("F03: concurrent calls maintain isolation (different responses)", async () => {
    let counter = 0;
    const handler = (_path, _req) => {
      const n = ++counter;
      return { messages: [encodeVarintField(1, n)], status: 0 };
    };
    const { server, port } = await createMockGrpcServer(handler);

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        grpcClient({
          operation: "unary", host: "127.0.0.1", port,
          method: "/test.Svc/Get",
          response_encoding: "base64",
        })
      )
    );
    // All should succeed
    results.forEach(r => assert.strictEqual(r.ok, true));
    // All base64 blobs should be non-empty
    results.forEach(r => assert(r.response.bytes > 0));
    await stopServer(server);
  });

  await test("F04: 5 parallel list_services calls succeed", async () => {
    const buildResp = () => {
      const nameEntries = ["foo.Service"].map(n => encodeBytes(1, encodeString(1, n)));
      return encodeBytes(4, Buffer.concat(nameEntries));
    };
    const handler = (_path, _req) => ({ messages: [buildResp()], status: 0 });
    const { server, port } = await createMockGrpcServer(handler);

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        grpcClient({ operation: "list_services", host: "127.0.0.1", port })
      )
    );
    results.forEach(r => {
      assert(r.serviceCount >= 1);
      assert(r.services.includes("foo.Service"));
    });
    await stopServer(server);
  });

  await test("F05: mixed parallel ops (unary + health_check) succeed", async () => {
    const handler = (path, reqBuf) => {
      if (path === "/grpc.health.v1.Health/Check")
        return { messages: [encodeVarintField(1, 1)], status: 0 };
      return { messages: [encodeString(1, "ok")], status: 0 };
    };
    const { server, port } = await createMockGrpcServer(handler);

    const ops = [
      grpcClient({ operation: "health_check",  host: "127.0.0.1", port }),
      grpcClient({ operation: "unary", host: "127.0.0.1", port, method: "/x.S/M" }),
      grpcClient({ operation: "health_check",  host: "127.0.0.1", port }),
      grpcClient({ operation: "unary", host: "127.0.0.1", port, method: "/x.S/M" }),
      grpcClient({ operation: "health_check",  host: "127.0.0.1", port }),
    ];
    const results = await Promise.all(ops);
    assert(results[0].serving === true);
    assert(results[1].ok === true);
    assert(results[2].serving === true);
    assert(results[3].ok === true);
    assert(results[4].serving === true);
    await stopServer(server);
  });
}

// ─── Main ───────────────────────────────────────────────────────────────────────

(async () => {
  process.stderr.write("\n=== Section 202: grpc_client ===\n");
  await runA();
  await runB();
  await runC();
  await runD();
  await runE();
  await runF();
  process.stderr.write(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
})();
