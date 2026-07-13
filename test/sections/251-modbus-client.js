"use strict";
/**
 * Section 251 — modbus_client tests
 * Zero-dependency Modbus TCP client (pure Node.js net)
 *
 * Test plan (56 tests total):
 *   A. Validation / Unit (10)   — input validation, config build, PDU encoding
 *   B. Protocol / Codec (20)    — MBAP framing, bit packing, register decoding,
 *                                  exception handling, multi-register writes
 *   C. Mock-network (10)        — local TCP server simulating Modbus responses
 *   D. Security (10)            — NUL guards, boundary attacks, injection
 *   E. Error paths (6)          — ECONNREFUSED, timeout, truncated response, bad FC
 */

const net  = require("net");
const { modbusClient } = require("../../lib/modbusClientOps");

// ── Helpers ───────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const results = [];

function assert(condition, message) {
  if (condition) {
    passed++;
    results.push(`  PASS: ${message}`);
  } else {
    failed++;
    results.push(`  FAIL: ${message}`);
  }
}

async function assertRejects(fn, pattern, message) {
  try {
    await fn();
    failed++;
    results.push(`  FAIL: ${message} (expected rejection, got success)`);
  } catch (e) {
    const ok = pattern ? (pattern instanceof RegExp ? pattern.test(e.message) : e.message.includes(pattern)) : true;
    if (ok) {
      passed++;
      results.push(`  PASS: ${message}`);
    } else {
      failed++;
      results.push(`  FAIL: ${message} (error: ${e.message})`);
    }
  }
}

// ── Internal helpers from modbusClientOps (access via require trick) ──────────
// We test internal functions by calling modbusClient with op="info" (no I/O)
// or by building a minimal mock server.

// Build a Modbus MBAP + PDU buffer (mirrors the internal buildRequest)
function buildMbapResponse(txnId, unitId, fc, payload) {
  const pduLen = 1 + payload.length; // fc(1) + payload
  const mbapLen = 1 + pduLen;        // unitId(1) + fc(1) + payload
  const buf = Buffer.alloc(6 + 1 + pduLen);
  buf.writeUInt16BE(txnId,   0);
  buf.writeUInt16BE(0,       2); // protocol id
  buf.writeUInt16BE(mbapLen, 4);
  buf.writeUInt8(unitId,     6);
  buf.writeUInt8(fc,         7);
  payload.copy(buf, 8);
  return buf;
}

// Build a Modbus exception response
function buildExceptionResponse(txnId, unitId, fc, exceptionCode) {
  const buf = Buffer.alloc(9);
  buf.writeUInt16BE(txnId,         0);
  buf.writeUInt16BE(0,             2);
  buf.writeUInt16BE(3,             4); // mbapLen: unitId(1) + fc(1) + exCode(1)
  buf.writeUInt8(unitId,          6);
  buf.writeUInt8(fc | 0x80,       7); // exception bit
  buf.writeUInt8(exceptionCode,   8);
  return buf;
}

// Start a minimal TCP server that responds to ONE Modbus request with given response buffer
function startMockServer(responseBuilder) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.once("data", (req) => {
        // Extract txnId and fc from request for building the response
        const txnId  = req.readUInt16BE(0);
        const unitId = req.readUInt8(6);
        const fc     = req.readUInt8(7);
        const pdu    = req.slice(8); // request payload after fc
        const resp   = responseBuilder(txnId, unitId, fc, pdu);
        socket.write(resp, () => socket.destroy());
      });
      socket.on("error", () => {});
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
    server.on("error", reject);
  });
}

function stopServer(server) {
  return new Promise((res) => server.close(() => res()));
}

// ── A. Validation / Unit (10) ─────────────────────────────────────────────────
async function sectionA() {
  console.log("\nA. Validation / Unit");

  // A1: info operation returns config without connecting
  const info = await modbusClient({ operation: "info", host: "10.0.0.1", port: 502, unit_id: 5 });
  assert(info.ok === true, "A1: info returns ok:true");
  assert(info.host === "10.0.0.1", "A1: info returns correct host");
  assert(info.unitId === 5, "A1: info returns correct unitId");
  assert(info.port === 502, "A1: info returns correct port");

  // A2: info defaults
  const infoDefaults = await modbusClient({ operation: "info" });
  assert(infoDefaults.host === "127.0.0.1", "A2: info default host");
  assert(infoDefaults.port === 502, "A2: info default port");
  assert(infoDefaults.unitId === 1, "A2: info default unitId");

  // A3: missing operation
  await assertRejects(
    () => modbusClient({}),
    "'operation' is required",
    "A3: missing operation throws"
  );

  // A4: unknown operation
  await assertRejects(
    () => modbusClient({ operation: "unknown_op" }),
    "unknown operation",
    "A4: unknown operation throws"
  );

  // A5: invalid port
  await assertRejects(
    () => modbusClient({ operation: "info", port: 99999 }),
    "port",
    "A5: invalid port 99999 throws"
  );

  // A6: invalid unit_id
  await assertRejects(
    () => modbusClient({ operation: "info", unit_id: 300 }),
    "unit_id",
    "A6: unit_id 300 > 255 throws"
  );

  // A7: write_coil value not boolean
  await assertRejects(
    () => modbusClient({ operation: "write_coil", host: "127.0.0.1", port: 19999, address: 0, value: 1 }),
    "boolean",
    "A7: write_coil value=1 (not boolean) throws"
  );

  // A8: write_register value out of range
  await assertRejects(
    () => modbusClient({ operation: "write_register", host: "127.0.0.1", port: 19999, address: 0, value: 70000 }),
    "range",
    "A8: write_register value=70000 out of range throws"
  );

  // A9: write_multiple_registers too many values
  await assertRejects(
    () => modbusClient({ operation: "write_multiple_registers", host: "127.0.0.1", port: 19999, address: 0, values: new Array(124).fill(0) }),
    "too large",
    "A9: write_multiple_registers >123 values throws"
  );

  // A10: read_holding_registers quantity > 125
  await assertRejects(
    () => modbusClient({ operation: "read_holding_registers", host: "127.0.0.1", port: 19999, address: 0, quantity: 126 }),
    "quantity",
    "A10: read_holding_registers quantity=126 >125 throws"
  );
}

// ── B. Protocol / Codec (20) ─────────────────────────────────────────────────
async function sectionB() {
  console.log("\nB. Protocol / Codec");

  // B1-B5: Read Coils response decoding
  // Mock server for read_coils: FC=0x01, returns 3 coils = [true, false, true]
  {
    const { server, port } = await startMockServer((txnId, unitId, fc, reqPdu) => {
      // Build response: byteCount=1, value=0b00000101 (coil0=ON, coil1=OFF, coil2=ON)
      const payload = Buffer.alloc(2);
      payload.writeUInt8(1, 0); // byteCount
      payload.writeUInt8(0b00000101, 1); // 3 coils
      return buildMbapResponse(txnId, unitId, 0x01, payload);
    });
    try {
      const r = await modbusClient({ operation: "read_coils", host: "127.0.0.1", port, unit_id: 1, address: 0, quantity: 3 });
      assert(r.ok === true, "B1: read_coils ok");
      assert(Array.isArray(r.values), "B2: read_coils returns values array");
      assert(r.values.length === 3, "B3: read_coils returns 3 values");
      assert(r.values[0] === true,  "B4: coil[0] is ON");
      assert(r.values[1] === false, "B5: coil[1] is OFF");
      assert(r.values[2] === true,  "B5b: coil[2] is ON");
    } finally {
      await stopServer(server);
    }
  }

  // B6-B8: Read Holding Registers response decoding
  {
    const { server, port } = await startMockServer((txnId, unitId, fc, reqPdu) => {
      // 2 registers: 0x0064 (100) and 0xFFFF (65535)
      const payload = Buffer.alloc(5);
      payload.writeUInt8(4, 0); // byteCount = 2 regs * 2 bytes
      payload.writeUInt16BE(100,   1);
      payload.writeUInt16BE(65535, 3);
      return buildMbapResponse(txnId, unitId, 0x03, payload);
    });
    try {
      const r = await modbusClient({ operation: "read_holding_registers", host: "127.0.0.1", port, unit_id: 1, address: 100, quantity: 2 });
      assert(r.ok === true, "B6: read_holding_registers ok");
      assert(r.values[0] === 100, "B7: register[0] = 100");
      assert(r.values[1] === 65535, "B8: register[1] = 65535 (unsigned)");
    } finally {
      await stopServer(server);
    }
  }

  // B9: Signed registers interpretation
  {
    const { server, port } = await startMockServer((txnId, unitId, fc, reqPdu) => {
      // Register value 0xFFFF = 65535 unsigned = -1 signed
      const payload = Buffer.alloc(3);
      payload.writeUInt8(2, 0);
      payload.writeUInt16BE(0xFFFF, 1); // -1 in signed 16-bit
      return buildMbapResponse(txnId, unitId, 0x03, payload);
    });
    try {
      const r = await modbusClient({ operation: "read_holding_registers", host: "127.0.0.1", port, unit_id: 1, address: 0, quantity: 1, signed: true });
      assert(r.values[0] === -1, "B9: signed register 0xFFFF = -1");
    } finally {
      await stopServer(server);
    }
  }

  // B10: Read Input Registers FC04
  {
    const { server, port } = await startMockServer((txnId, unitId, fc, reqPdu) => {
      const payload = Buffer.alloc(3);
      payload.writeUInt8(2, 0);
      payload.writeUInt16BE(4200, 1);
      return buildMbapResponse(txnId, unitId, 0x04, payload);
    });
    try {
      const r = await modbusClient({ operation: "read_input_registers", host: "127.0.0.1", port, unit_id: 1, address: 30000, quantity: 1 });
      assert(r.values[0] === 4200, "B10: input register = 4200");
    } finally {
      await stopServer(server);
    }
  }

  // B11: Write Coil ON - FC05
  {
    const { server, port } = await startMockServer((txnId, unitId, fc, reqPdu) => {
      // Echo: address=0x0010 (16), value=0xFF00 (ON)
      const payload = Buffer.alloc(4);
      payload.writeUInt16BE(0x0010, 0); // echo address
      payload.writeUInt16BE(0xFF00, 2); // echo value (ON)
      return buildMbapResponse(txnId, unitId, 0x05, payload);
    });
    try {
      const r = await modbusClient({ operation: "write_coil", host: "127.0.0.1", port, address: 16, value: true });
      assert(r.ok === true, "B11: write_coil ok");
      assert(r.echoValue === true, "B11: write_coil echo ON");
    } finally {
      await stopServer(server);
    }
  }

  // B12: Write Coil OFF
  {
    const { server, port } = await startMockServer((txnId, unitId, fc, reqPdu) => {
      const payload = Buffer.alloc(4);
      payload.writeUInt16BE(0x0005, 0);
      payload.writeUInt16BE(0x0000, 2); // OFF
      return buildMbapResponse(txnId, unitId, 0x05, payload);
    });
    try {
      const r = await modbusClient({ operation: "write_coil", host: "127.0.0.1", port, address: 5, value: false });
      assert(r.echoValue === false, "B12: write_coil echo OFF");
    } finally {
      await stopServer(server);
    }
  }

  // B13: Write Single Register FC06
  {
    const { server, port } = await startMockServer((txnId, unitId, fc, reqPdu) => {
      // Echo back address=0x0002, value=0x0064 (100)
      const payload = Buffer.alloc(4);
      payload.writeUInt16BE(2,   0);
      payload.writeUInt16BE(100, 2);
      return buildMbapResponse(txnId, unitId, 0x06, payload);
    });
    try {
      const r = await modbusClient({ operation: "write_register", host: "127.0.0.1", port, address: 2, value: 100 });
      assert(r.ok === true, "B13: write_register ok");
      assert(r.echoRawValue === 100, "B13: write_register echo value");
    } finally {
      await stopServer(server);
    }
  }

  // B14: Write Register signed negative value
  {
    const { server, port } = await startMockServer((txnId, unitId, fc, reqPdu) => {
      // -1 encoded as 0xFFFF
      const payload = Buffer.alloc(4);
      payload.writeUInt16BE(0,      0);
      payload.writeUInt16BE(0xFFFF, 2);
      return buildMbapResponse(txnId, unitId, 0x06, payload);
    });
    try {
      const r = await modbusClient({ operation: "write_register", host: "127.0.0.1", port, address: 0, value: -1 });
      assert(r.rawValue === 65535, "B14: write_register -1 encodes as 65535");
    } finally {
      await stopServer(server);
    }
  }

  // B15: Write Multiple Coils FC15
  {
    const { server, port } = await startMockServer((txnId, unitId, fc, reqPdu) => {
      // Echo: address=0, quantity=8
      const payload = Buffer.alloc(4);
      payload.writeUInt16BE(0, 0);
      payload.writeUInt16BE(8, 2);
      return buildMbapResponse(txnId, unitId, 0x0F, payload);
    });
    try {
      const coils = [true, false, true, false, true, false, true, true];
      const r = await modbusClient({ operation: "write_multiple_coils", host: "127.0.0.1", port, address: 0, values: coils });
      assert(r.ok === true, "B15: write_multiple_coils ok");
      assert(r.echoQuantity === 8, "B15: write_multiple_coils echo quantity");
    } finally {
      await stopServer(server);
    }
  }

  // B16: Coil bit packing LSB-first (spec compliance)
  // coils=[true,false,true,false,false,false,false,false] = 0b00000101 = 0x05
  // coils=[true,true,true,false,false,false,false,false] = 0b00000111 = 0x07
  {
    let capturedPdu = null;
    const { server, port } = await startMockServer((txnId, unitId, fc, reqPdu) => {
      capturedPdu = Buffer.from(reqPdu);
      const payload = Buffer.alloc(4);
      payload.writeUInt16BE(0, 0);
      payload.writeUInt16BE(3, 2);
      return buildMbapResponse(txnId, unitId, 0x0F, payload);
    });
    try {
      await modbusClient({ operation: "write_multiple_coils", host: "127.0.0.1", port, address: 0, values: [true, true, true] });
      // reqPdu after fc: address(2) + quantity(2) + byteCount(1) + data(1)
      // data should be 0b00000111 = 0x07
      if (capturedPdu) {
        const dataOffset = 4; // skip address(2)+quantity(2) in pdu
        const byteCountByte = capturedPdu.readUInt8(4); // byteCount
        const dataByte = capturedPdu.readUInt8(5);
        assert(byteCountByte === 1, "B16: byteCount=1 for 3 coils");
        assert(dataByte === 0x07, "B16: [T,T,T] packs to 0x07 (LSB-first)");
      } else {
        assert(false, "B16: no pdu captured");
      }
    } finally {
      await stopServer(server);
    }
  }

  // B17: Write Multiple Registers FC16
  {
    const { server, port } = await startMockServer((txnId, unitId, fc, reqPdu) => {
      const payload = Buffer.alloc(4);
      payload.writeUInt16BE(10, 0);
      payload.writeUInt16BE(3,  2); // 3 registers written
      return buildMbapResponse(txnId, unitId, 0x10, payload);
    });
    try {
      const r = await modbusClient({ operation: "write_multiple_registers", host: "127.0.0.1", port, address: 10, values: [100, 200, 300] });
      assert(r.ok === true, "B17: write_multiple_registers ok");
      assert(r.echoQuantity === 3, "B17: echo quantity=3");
      assert(r.rawValues.length === 3, "B17: rawValues has 3 entries");
    } finally {
      await stopServer(server);
    }
  }

  // B18: Modbus exception decode
  {
    const { server, port } = await startMockServer((txnId, unitId, fc) => {
      return buildExceptionResponse(txnId, unitId, 0x03, 0x02); // FC03, ILLEGAL_DATA_ADDRESS
    });
    try {
      await assertRejects(
        () => modbusClient({ operation: "read_holding_registers", host: "127.0.0.1", port, address: 0, quantity: 1 }),
        "ILLEGAL_DATA_ADDRESS",
        "B18: Modbus exception 0x02 decoded to ILLEGAL_DATA_ADDRESS"
      );
    } finally {
      await stopServer(server);
    }
  }

  // B19: Discrete inputs FC02
  {
    const { server, port } = await startMockServer((txnId, unitId, fc) => {
      const payload = Buffer.alloc(2);
      payload.writeUInt8(1,    0); // byteCount
      payload.writeUInt8(0xAA, 1); // 0b10101010: inputs alternating
      return buildMbapResponse(txnId, unitId, 0x02, payload);
    });
    try {
      const r = await modbusClient({ operation: "read_discrete_inputs", host: "127.0.0.1", port, address: 0, quantity: 8 });
      assert(r.values[0] === false, "B19: discrete[0]=OFF (bit0=0)");
      assert(r.values[1] === true,  "B19: discrete[1]=ON  (bit1=1)");
      assert(r.values[7] === true,  "B19: discrete[7]=ON  (bit7=1)");
    } finally {
      await stopServer(server);
    }
  }

  // B20: info lists all function codes
  const info = await modbusClient({ operation: "info" });
  assert(typeof info.functionCodes === "object", "B20: info.functionCodes is object");
  assert("0x01 (1)" in info.functionCodes, "B20: FC01 listed");
  assert("0x10 (16)" in info.functionCodes, "B20: FC16 listed");
  assert(info.limits.maxHoldingRegistersPerRead === 125, "B20: limits correct");
}

// ── C. Mock-network (10) ──────────────────────────────────────────────────────
async function sectionC() {
  console.log("\nC. Mock-network");

  // C1: read_coils with unit_id=255 (broadcast)
  {
    const { server, port } = await startMockServer((txnId, unitId, fc) => {
      const payload = Buffer.alloc(2);
      payload.writeUInt8(1, 0);
      payload.writeUInt8(0xFF, 1);
      return buildMbapResponse(txnId, unitId, 0x01, payload);
    });
    try {
      const r = await modbusClient({ operation: "read_coils", host: "127.0.0.1", port, unit_id: 255, address: 0, quantity: 8 });
      assert(r.unitId === 255, "C1: unit_id=255 accepted and echoed");
    } finally {
      await stopServer(server);
    }
  }

  // C2: read_coils at maximum address 65535
  {
    const { server, port } = await startMockServer((txnId, unitId, fc) => {
      const payload = Buffer.alloc(2);
      payload.writeUInt8(1, 0);
      payload.writeUInt8(1, 1);
      return buildMbapResponse(txnId, unitId, 0x01, payload);
    });
    try {
      const r = await modbusClient({ operation: "read_coils", host: "127.0.0.1", port, address: 65535, quantity: 1 });
      assert(r.address === 65535, "C2: max address 65535 accepted");
    } finally {
      await stopServer(server);
    }
  }

  // C3: Multiple registers max (125)
  {
    const { server, port } = await startMockServer((txnId, unitId, fc) => {
      const byteCount = 125 * 2;
      const payload = Buffer.alloc(1 + byteCount);
      payload.writeUInt8(byteCount, 0);
      for (let i = 0; i < 125; i++) payload.writeUInt16BE(i, 1 + i * 2);
      return buildMbapResponse(txnId, unitId, 0x03, payload);
    });
    try {
      const r = await modbusClient({ operation: "read_holding_registers", host: "127.0.0.1", port, address: 0, quantity: 125 });
      assert(r.values.length === 125, "C3: read 125 holding registers");
      assert(r.values[124] === 124, "C3: last register = 124");
    } finally {
      await stopServer(server);
    }
  }

  // C4: write_multiple_coils 16 values (2 bytes)
  {
    const { server, port } = await startMockServer((txnId, unitId, fc) => {
      const payload = Buffer.alloc(4);
      payload.writeUInt16BE(0,  0);
      payload.writeUInt16BE(16, 2);
      return buildMbapResponse(txnId, unitId, 0x0F, payload);
    });
    try {
      const vals = Array(16).fill(null).map((_, i) => i % 2 === 0);
      const r = await modbusClient({ operation: "write_multiple_coils", host: "127.0.0.1", port, address: 0, values: vals });
      assert(r.quantity === 16, "C4: write_multiple_coils 16 coils");
    } finally {
      await stopServer(server);
    }
  }

  // C5: write_register with value=0 (edge)
  {
    const { server, port } = await startMockServer((txnId, unitId, fc) => {
      const payload = Buffer.alloc(4);
      payload.writeUInt16BE(0, 0);
      payload.writeUInt16BE(0, 2);
      return buildMbapResponse(txnId, unitId, 0x06, payload);
    });
    try {
      const r = await modbusClient({ operation: "write_register", host: "127.0.0.1", port, address: 0, value: 0 });
      assert(r.rawValue === 0, "C5: write_register value=0 ok");
    } finally {
      await stopServer(server);
    }
  }

  // C6: Server closes connection immediately (truncated)
  {
    const server = net.createServer((sock) => {
      sock.destroy(); // abruptly close
    });
    await new Promise((res) => server.listen(0, "127.0.0.1", res));
    const port = server.address().port;
    try {
      await assertRejects(
        () => modbusClient({ operation: "read_coils", host: "127.0.0.1", port, address: 0, quantity: 1, timeout: 2000 }),
        /connection closed|network error/i,
        "C6: server closes connection immediately"
      );
    } finally {
      await stopServer(server);
    }
  }

  // C7: Partial response (server sends only MBAP header, no PDU data)
  {
    const server = net.createServer((sock) => {
      sock.once("data", (req) => {
        const txnId = req.readUInt16BE(0);
        // Send just 6 bytes (MBAP header only, no unit/fc/payload)
        const partial = Buffer.alloc(6);
        partial.writeUInt16BE(txnId, 0);
        partial.writeUInt16BE(0,     2);
        partial.writeUInt16BE(2,     4); // length=2 means 2 more bytes expected
        sock.write(partial, () => { /* don't send rest */ });
        // Close after short delay to trigger "closed before full response"
        setTimeout(() => sock.destroy(), 100);
      });
      sock.on("error", () => {});
    });
    await new Promise((res) => server.listen(0, "127.0.0.1", res));
    const port = server.address().port;
    try {
      await assertRejects(
        () => modbusClient({ operation: "read_coils", host: "127.0.0.1", port, address: 0, quantity: 1, timeout: 2000 }),
        /closed before|network error/i,
        "C7: partial response (only MBAP header)"
      );
    } finally {
      await stopServer(server);
    }
  }

  // C8: Concurrent requests to the same mock server (isolation check)
  // Each call to modbusClient opens its own connection, so concurrent calls are independent
  {
    let callCount = 0;
    const server = net.createServer((sock) => {
      callCount++;
      sock.once("data", (req) => {
        const txnId = req.readUInt16BE(0);
        const unitId = req.readUInt8(6);
        const payload = Buffer.alloc(2);
        payload.writeUInt8(1, 0);
        payload.writeUInt8(0xFF, 1);
        sock.write(buildMbapResponse(txnId, unitId, 0x01, payload), () => sock.destroy());
      });
      sock.on("error", () => {});
    });
    await new Promise((res) => server.listen(0, "127.0.0.1", res));
    const port = server.address().port;
    try {
      const results = await Promise.all([
        modbusClient({ operation: "read_coils", host: "127.0.0.1", port, address: 0, quantity: 8 }),
        modbusClient({ operation: "read_coils", host: "127.0.0.1", port, address: 0, quantity: 8 }),
        modbusClient({ operation: "read_coils", host: "127.0.0.1", port, address: 0, quantity: 8 }),
      ]);
      assert(results.every(r => r.ok), "C8: concurrent requests all succeed");
      assert(callCount === 3, "C8: server handled 3 separate connections");
    } finally {
      await stopServer(server);
    }
  }

  // C9: Exception code 0x01 (ILLEGAL_FUNCTION) decode
  {
    const { server, port } = await startMockServer((txnId, unitId, fc) => {
      return buildExceptionResponse(txnId, unitId, 0x01, 0x01);
    });
    try {
      await assertRejects(
        () => modbusClient({ operation: "read_coils", host: "127.0.0.1", port, address: 0, quantity: 1 }),
        "ILLEGAL_FUNCTION",
        "C9: exception 0x01 = ILLEGAL_FUNCTION"
      );
    } finally {
      await stopServer(server);
    }
  }

  // C10: elapsedMs is present and non-negative
  {
    const { server, port } = await startMockServer((txnId, unitId, fc) => {
      const payload = Buffer.alloc(3);
      payload.writeUInt8(2, 0);
      payload.writeUInt16BE(42, 1);
      return buildMbapResponse(txnId, unitId, 0x04, payload);
    });
    try {
      const r = await modbusClient({ operation: "read_input_registers", host: "127.0.0.1", port, address: 0, quantity: 1 });
      assert(typeof r.elapsedMs === "number" && r.elapsedMs >= 0, "C10: elapsedMs is non-negative number");
    } finally {
      await stopServer(server);
    }
  }
}

// ── D. Security (10) ─────────────────────────────────────────────────────────
async function sectionD() {
  console.log("\nD. Security");

  // D1: NUL byte in host
  await assertRejects(
    () => modbusClient({ operation: "info", host: "127.0.0\x001" }),
    "NUL",
    "D1: NUL byte in host rejected"
  );

  // D2: negative address rejected (validate before TCP by using read_coils; throws before connect)
  await assertRejects(
    () => modbusClient({ operation: "read_coils", host: "127.0.0.1", port: 19999, address: -1, quantity: 1 }),
    "address",
    "D2: negative address rejected"
  );

  // D3: address > 65535 rejected
  await assertRejects(
    () => modbusClient({ operation: "read_coils", host: "127.0.0.1", port: 19999, address: 65536, quantity: 1 }),
    "address",
    "D3: address > 65535 rejected"
  );

  // D4: quantity 0 rejected
  await assertRejects(
    () => modbusClient({ operation: "read_coils", host: "127.0.0.1", port: 19999, quantity: 0 }),
    "quantity",
    "D4: quantity=0 rejected"
  );

  // D5: quantity > 2000 for coils rejected
  await assertRejects(
    () => modbusClient({ operation: "read_coils", host: "127.0.0.1", port: 19999, quantity: 2001 }),
    "quantity",
    "D5: quantity=2001 > 2000 for coils rejected"
  );

  // D6: write_multiple_coils empty array rejected
  await assertRejects(
    () => modbusClient({ operation: "write_multiple_coils", host: "127.0.0.1", port: 19999, address: 0, values: [] }),
    "non-empty",
    "D6: write_multiple_coils empty values rejected"
  );

  // D7: write_multiple_coils non-boolean values rejected
  await assertRejects(
    () => modbusClient({ operation: "write_multiple_coils", host: "127.0.0.1", port: 19999, address: 0, values: [1, 0, 1] }),
    "booleans",
    "D7: write_multiple_coils non-boolean rejected"
  );

  // D8: write_multiple_registers empty array rejected
  await assertRejects(
    () => modbusClient({ operation: "write_multiple_registers", host: "127.0.0.1", port: 19999, address: 0, values: [] }),
    "non-empty",
    "D8: write_multiple_registers empty values rejected"
  );

  // D9: write_multiple_registers with non-integer value rejected
  await assertRejects(
    () => modbusClient({ operation: "write_multiple_registers", host: "127.0.0.1", port: 19999, address: 0, values: [1.5] }),
    "integers",
    "D9: write_multiple_registers non-integer rejected"
  );

  // D10: timeout clamp (too low => 500 ms used)
  const infoLow = await modbusClient({ operation: "info", timeout: 10 });
  assert(infoLow.timeoutMs === 500, "D10: timeout too low clamped to 500ms");
}

// ── E. Error Paths (6) ────────────────────────────────────────────────────────
async function sectionE() {
  console.log("\nE. Error paths");

  // E1: ECONNREFUSED (port not in use)
  await assertRejects(
    () => modbusClient({ operation: "read_coils", host: "127.0.0.1", port: 19502, address: 0, quantity: 1, timeout: 2000 }),
    /refused|not found|timed out|network error/i,
    "E1: ECONNREFUSED on closed port"
  );

  // E2: timeout fires (slow server that never responds)
  {
    const server = net.createServer((sock) => {
      sock.on("data", () => { /* eat data, never respond */ });
      sock.on("error", () => {});
    });
    await new Promise((res) => server.listen(0, "127.0.0.1", res));
    const port = server.address().port;
    const t0 = Date.now();
    try {
      await assertRejects(
        () => modbusClient({ operation: "read_coils", host: "127.0.0.1", port, address: 0, quantity: 1, timeout: 600 }),
        /timed out/i,
        "E2: request timeout fires"
      );
      const elapsed = Date.now() - t0;
      assert(elapsed < 3000, "E2: timeout fired in < 3 s");
    } finally {
      await stopServer(server);
    }
  }

  // E3: invalid port 0
  await assertRejects(
    () => modbusClient({ operation: "read_coils", host: "127.0.0.1", port: 0, address: 0, quantity: 1 }),
    "port",
    "E3: port=0 rejected"
  );

  // E4: unit_id -1
  await assertRejects(
    () => modbusClient({ operation: "info", unit_id: -1 }),
    "unit_id",
    "E4: unit_id=-1 rejected"
  );

  // E5: write_coil missing value
  await assertRejects(
    () => modbusClient({ operation: "write_coil", host: "127.0.0.1", port: 19999, address: 0 }),
    "boolean",
    "E5: write_coil missing value rejected"
  );

  // E6: write_register missing value (undefined)
  await assertRejects(
    () => modbusClient({ operation: "write_register", host: "127.0.0.1", port: 19999, address: 0 }),
    "range",
    "E6: write_register missing value rejected"
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== Section 251: modbus_client tests ===");

  try {
    await sectionA();
    await sectionB();
    await sectionC();
    await sectionD();
    await sectionE();
  } catch (e) {
    console.error("UNEXPECTED ERROR:", e);
    failed++;
  }

  console.log("\nResults:");
  for (const r of results) console.log(r);
  console.log(`\n${passed} passed, ${failed} failed out of ${passed + failed} tests`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
