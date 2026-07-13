"use strict";
/**
 * modbus_client — Zero-dependency Modbus TCP client.
 * Pure Node.js (net built-in; no npm deps).
 *
 * Implements Modbus TCP (MBAP framing) per IEC 61158 / MODBUS Application Protocol v1.1b3.
 * Supports RTU-over-TCP as well (same MBAP framing, same operations).
 *
 * Supported operations:
 *   read_coils               — Read N coils (FC 01) from a device
 *   read_discrete_inputs     — Read N discrete inputs (FC 02)
 *   read_holding_registers   — Read N holding registers (FC 03, 16-bit words)
 *   read_input_registers     — Read N input registers (FC 04, 16-bit words)
 *   write_coil               — Write a single coil (FC 05, ON/OFF)
 *   write_register           — Write a single holding register (FC 06, 16-bit)
 *   write_multiple_coils     — Write N coils (FC 15)
 *   write_multiple_registers — Write N holding registers (FC 16)
 *   info                     — Return connection config and protocol info (no device I/O)
 *
 * Security:
 *   - NUL-byte guards on host
 *   - Timeout clamped 500 ms – 30 s
 *   - Port must be 1–65535
 *   - Unit ID must be 0–255
 *   - Address and quantity validated per Modbus spec
 *   - Exceptions decoded to human-readable messages
 *   - No credentials needed (Modbus has no auth)
 */

const net = require("net");

// ── Constants ─────────────────────────────────────────────────────────────────
const DEFAULT_HOST       = "127.0.0.1";
const DEFAULT_PORT       = 502;
const DEFAULT_UNIT_ID    = 1;
const DEFAULT_TIMEOUT    = 5_000;
const MIN_TIMEOUT        = 500;
const MAX_TIMEOUT        = 30_000;

// Modbus Function Codes
const FC_READ_COILS                 = 0x01;
const FC_READ_DISCRETE_INPUTS       = 0x02;
const FC_READ_HOLDING_REGISTERS     = 0x03;
const FC_READ_INPUT_REGISTERS       = 0x04;
const FC_WRITE_SINGLE_COIL          = 0x05;
const FC_WRITE_SINGLE_REGISTER      = 0x06;
const FC_WRITE_MULTIPLE_COILS       = 0x0F;
const FC_WRITE_MULTIPLE_REGISTERS   = 0x10;

// Modbus exception codes
const EXCEPTION_CODES = {
  0x01: "ILLEGAL_FUNCTION — The function code is not supported by this device.",
  0x02: "ILLEGAL_DATA_ADDRESS — The data address is not an allowable address for this device.",
  0x03: "ILLEGAL_DATA_VALUE — A value in the data field is not permissible for this device.",
  0x04: "SERVER_DEVICE_FAILURE — An unrecoverable error occurred while the device was attempting to perform the requested action.",
  0x05: "ACKNOWLEDGE — The device has accepted the request and is processing it, but a long duration of time will be required.",
  0x06: "SERVER_DEVICE_BUSY — The device is busy processing a long-duration command.",
  0x08: "MEMORY_PARITY_ERROR — The device attempted to read record file that it failed to detect parity error in.",
  0x0A: "GATEWAY_PATH_UNAVAILABLE — Gateway was unable to allocate an internal communication path.",
  0x0B: "GATEWAY_TARGET_DEVICE_FAILED_TO_RESPOND — No response was obtained from the target device.",
};

// Transaction ID counter (rolling 16-bit)
let _txnId = 0;
function nextTxnId() {
  _txnId = (_txnId + 1) & 0xFFFF;
  return _txnId;
}

// ── Guards ────────────────────────────────────────────────────────────────────
function guardNul(value, name) {
  if (typeof value === "string" && value.includes("\0"))
    throw new Error(`modbus_client: '${name}' must not contain NUL bytes.`);
}

function clampTimeout(t) {
  const n = typeof t === "number" ? t : DEFAULT_TIMEOUT;
  return Math.max(MIN_TIMEOUT, Math.min(MAX_TIMEOUT, Math.trunc(n)));
}

function validatePort(port, def) {
  const p = port ?? def;
  if (!Number.isInteger(p) || p < 1 || p > 65535)
    throw new Error(`modbus_client: 'port' must be an integer 1–65535 (got ${p}).`);
  return p;
}

function validateUnitId(unitId) {
  const u = unitId ?? DEFAULT_UNIT_ID;
  if (!Number.isInteger(u) || u < 0 || u > 255)
    throw new Error(`modbus_client: 'unit_id' must be an integer 0–255 (got ${u}).`);
  return u;
}

function validateAddress(addr, name) {
  if (!Number.isInteger(addr) || addr < 0 || addr > 65535)
    throw new Error(`modbus_client: '${name}' must be an integer 0–65535 (got ${addr}).`);
  return addr;
}

function validateQuantity(qty, max, name) {
  if (!Number.isInteger(qty) || qty < 1 || qty > max)
    throw new Error(`modbus_client: '${name}' must be an integer 1–${max} (got ${qty}).`);
  return qty;
}

// ── Config builder ────────────────────────────────────────────────────────────
function buildConfig(args) {
  const host      = args.host || DEFAULT_HOST;
  const port      = validatePort(args.port, DEFAULT_PORT);
  const unitId    = validateUnitId(args.unit_id);
  const timeoutMs = clampTimeout(args.timeout);

  guardNul(host, "host");

  return { host, port, unitId, timeoutMs };
}

// ── TCP request/response ─────────────────────────────────────────────────────
/**
 * Build a Modbus TCP MBAP + PDU request buffer.
 *
 * MBAP Header (6 bytes):
 *   [0-1]: Transaction ID (16-bit big-endian)
 *   [2-3]: Protocol ID = 0x0000 (Modbus)
 *   [4-5]: PDU length = unit_id byte + pdu bytes
 *   [6]:   Unit ID
 * PDU:
 *   [7]:   Function code
 *   [8+]:  Data
 */
function buildRequest(txnId, unitId, pdu) {
  const mbapLen = 1 + pdu.length; // unit_id + pdu
  const buf = Buffer.alloc(6 + 1 + pdu.length);
  buf.writeUInt16BE(txnId,   0);  // transaction id
  buf.writeUInt16BE(0,       2);  // protocol id
  buf.writeUInt16BE(mbapLen, 4);  // length
  buf.writeUInt8(unitId,     6);  // unit id
  pdu.copy(buf, 7);               // function code + data
  return buf;
}

/**
 * Parse a Modbus TCP MBAP response.
 * Returns { txnId, unitId, fc, data, exception, exceptionCode, exceptionMessage }
 */
function parseResponse(buf, expectedTxnId, expectedFc) {
  if (buf.length < 8)
    throw new Error(`modbus_client: response too short (${buf.length} bytes, expected >=8).`);

  const rxTxnId    = buf.readUInt16BE(0);
  const protocolId = buf.readUInt16BE(2);
  const length     = buf.readUInt16BE(4);
  const unitId     = buf.readUInt8(6);
  const fc         = buf.readUInt8(7);

  if (protocolId !== 0)
    throw new Error(`modbus_client: unexpected protocol ID ${protocolId} (expected 0 for Modbus).`);
  if (rxTxnId !== expectedTxnId)
    throw new Error(`modbus_client: transaction ID mismatch (sent ${expectedTxnId}, got ${rxTxnId}).`);

  // Check for exception response (FC | 0x80)
  if (fc === (expectedFc | 0x80)) {
    if (buf.length < 9)
      throw new Error("modbus_client: exception response truncated.");
    const exCode = buf.readUInt8(8);
    const exMsg  = EXCEPTION_CODES[exCode] || `Unknown exception code 0x${exCode.toString(16).padStart(2, "0")}.`;
    return { txnId: rxTxnId, unitId, fc, exception: true, exceptionCode: exCode, exceptionMessage: exMsg, data: null };
  }

  if (fc !== expectedFc)
    throw new Error(`modbus_client: unexpected function code 0x${fc.toString(16)} (expected 0x${expectedFc.toString(16)}).`);

  // length field = unitId(1) + fc(1) + payload, so payload starts at byte 8
  const data = buf.slice(8, 6 + length);
  return { txnId: rxTxnId, unitId, fc, exception: false, data };
}

/**
 * Send a Modbus TCP request and receive the complete response.
 * Handles partial reads by accumulating until MBAP length is satisfied.
 */
function sendModbusRequest(cfg, reqBuf) {
  return new Promise((resolve, reject) => {
    let socket;
    let timedOut = false;
    const chunks = [];
    let totalReceived = 0;
    let expectedLen = null;

    const cleanup = () => {
      if (socket) {
        socket.removeAllListeners();
        socket.destroy();
        socket = null;
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      cleanup();
      reject(new Error(
        `modbus_client: request to ${cfg.host}:${cfg.port} timed out after ${cfg.timeoutMs} ms.`
      ));
    }, cfg.timeoutMs);

    socket = new net.Socket();

    socket.on("connect", () => {
      socket.write(reqBuf, (err) => {
        if (err) {
          clearTimeout(timer);
          cleanup();
          reject(new Error(`modbus_client: write error: ${err.message}`));
        }
      });
    });

    socket.on("data", (chunk) => {
      if (timedOut) return;
      chunks.push(chunk);
      totalReceived += chunk.length;

      // Determine expected total response length from MBAP header
      if (expectedLen === null && totalReceived >= 6) {
        const hdr = Buffer.concat(chunks);
        const pduLen = hdr.readUInt16BE(4); // MBAP length field = unitId + PDU
        expectedLen = 6 + pduLen;           // 6-byte MBAP header + pduLen bytes
      }

      if (expectedLen !== null && totalReceived >= expectedLen) {
        clearTimeout(timer);
        const fullBuf = Buffer.concat(chunks).slice(0, expectedLen);
        cleanup();
        resolve(fullBuf);
      }
    });

    socket.on("error", (err) => {
      if (timedOut) return;
      clearTimeout(timer);
      cleanup();
      if (err.code === "ECONNREFUSED")
        reject(new Error(`modbus_client: connection refused to ${cfg.host}:${cfg.port}. Is the Modbus device reachable?`));
      else if (err.code === "ENOTFOUND")
        reject(new Error(`modbus_client: host not found: '${cfg.host}'.`));
      else if (err.code === "ETIMEDOUT")
        reject(new Error(`modbus_client: connection to ${cfg.host}:${cfg.port} timed out.`));
      else
        reject(new Error(`modbus_client: network error: ${err.message}`));
    });

    socket.on("close", () => {
      if (timedOut) return;
      if (expectedLen === null || totalReceived < expectedLen) {
        clearTimeout(timer);
        cleanup();
        reject(new Error(`modbus_client: connection closed before full response received (got ${totalReceived} bytes).`));
      }
    });

    socket.connect(cfg.port, cfg.host);
  });
}

/**
 * Execute a single Modbus function: build PDU, send MBAP request, parse response.
 */
async function execModbus(cfg, fc, pdu) {
  const txnId  = nextTxnId();
  const reqBuf = buildRequest(txnId, cfg.unitId, pdu);
  const resBuf = await sendModbusRequest(cfg, reqBuf);
  const parsed = parseResponse(resBuf, txnId, fc);

  if (parsed.exception) {
    throw new Error(
      `modbus_client: Modbus exception for FC 0x${fc.toString(16).padStart(2, "0")} — ` +
      `code 0x${parsed.exceptionCode.toString(16).padStart(2, "0")}: ${parsed.exceptionMessage}`
    );
  }

  return parsed;
}

// ── Bit/register decoders ─────────────────────────────────────────────────────

/** Decode packed coil/discrete-input bits from Modbus response data bytes. */
function decodeCoils(data, quantity) {
  const coils = [];
  for (let i = 0; i < quantity; i++) {
    const byteIndex = Math.floor(i / 8);
    const bitIndex  = i % 8;
    coils.push(!!(data[byteIndex] & (1 << bitIndex)));
  }
  return coils;
}

/** Decode 16-bit registers from Modbus response data bytes. */
function decodeRegisters(data, quantity, registerType) {
  const regs = [];
  for (let i = 0; i < quantity; i++) {
    const val = data.readUInt16BE(i * 2);
    if (registerType === "signed") {
      regs.push(val > 32767 ? val - 65536 : val);
    } else {
      regs.push(val);
    }
  }
  return regs;
}

// ── Operations ────────────────────────────────────────────────────────────────

/** read_coils — FC 01 */
async function opReadCoils(args) {
  const cfg      = buildConfig(args);
  const address  = validateAddress(args.address ?? 0, "address");
  const quantity = validateQuantity(args.quantity ?? 1, 2000, "quantity");

  const pdu = Buffer.alloc(5);
  pdu.writeUInt8(FC_READ_COILS, 0);
  pdu.writeUInt16BE(address,  1);
  pdu.writeUInt16BE(quantity, 3);

  const t0     = Date.now();
  const parsed = await execModbus(cfg, FC_READ_COILS, pdu);
  const ms     = Date.now() - t0;

  const byteCount = parsed.data.readUInt8(0);
  const coilBytes = parsed.data.slice(1, 1 + byteCount);
  const values    = decodeCoils(coilBytes, quantity);

  return {
    ok:        true,
    operation: "read_coils",
    host:      cfg.host,
    port:      cfg.port,
    unitId:    cfg.unitId,
    address,
    quantity,
    values,
    byteCount,
    elapsedMs: ms,
  };
}

/** read_discrete_inputs — FC 02 */
async function opReadDiscreteInputs(args) {
  const cfg      = buildConfig(args);
  const address  = validateAddress(args.address ?? 0, "address");
  const quantity = validateQuantity(args.quantity ?? 1, 2000, "quantity");

  const pdu = Buffer.alloc(5);
  pdu.writeUInt8(FC_READ_DISCRETE_INPUTS, 0);
  pdu.writeUInt16BE(address,  1);
  pdu.writeUInt16BE(quantity, 3);

  const t0     = Date.now();
  const parsed = await execModbus(cfg, FC_READ_DISCRETE_INPUTS, pdu);
  const ms     = Date.now() - t0;

  const byteCount = parsed.data.readUInt8(0);
  const bitBytes  = parsed.data.slice(1, 1 + byteCount);
  const values    = decodeCoils(bitBytes, quantity);

  return {
    ok:        true,
    operation: "read_discrete_inputs",
    host:      cfg.host,
    port:      cfg.port,
    unitId:    cfg.unitId,
    address,
    quantity,
    values,
    byteCount,
    elapsedMs: ms,
  };
}

/** read_holding_registers — FC 03 */
async function opReadHoldingRegisters(args) {
  const cfg      = buildConfig(args);
  const address  = validateAddress(args.address ?? 0, "address");
  const quantity = validateQuantity(args.quantity ?? 1, 125, "quantity");
  const signed   = args.signed === true;

  const pdu = Buffer.alloc(5);
  pdu.writeUInt8(FC_READ_HOLDING_REGISTERS, 0);
  pdu.writeUInt16BE(address,  1);
  pdu.writeUInt16BE(quantity, 3);

  const t0     = Date.now();
  const parsed = await execModbus(cfg, FC_READ_HOLDING_REGISTERS, pdu);
  const ms     = Date.now() - t0;

  const byteCount = parsed.data.readUInt8(0);
  const regBytes  = parsed.data.slice(1, 1 + byteCount);
  const values    = decodeRegisters(regBytes, quantity, signed ? "signed" : "unsigned");

  return {
    ok:        true,
    operation: "read_holding_registers",
    host:      cfg.host,
    port:      cfg.port,
    unitId:    cfg.unitId,
    address,
    quantity,
    values,
    signed,
    byteCount,
    elapsedMs: ms,
  };
}

/** read_input_registers — FC 04 */
async function opReadInputRegisters(args) {
  const cfg      = buildConfig(args);
  const address  = validateAddress(args.address ?? 0, "address");
  const quantity = validateQuantity(args.quantity ?? 1, 125, "quantity");
  const signed   = args.signed === true;

  const pdu = Buffer.alloc(5);
  pdu.writeUInt8(FC_READ_INPUT_REGISTERS, 0);
  pdu.writeUInt16BE(address,  1);
  pdu.writeUInt16BE(quantity, 3);

  const t0     = Date.now();
  const parsed = await execModbus(cfg, FC_READ_INPUT_REGISTERS, pdu);
  const ms     = Date.now() - t0;

  const byteCount = parsed.data.readUInt8(0);
  const regBytes  = parsed.data.slice(1, 1 + byteCount);
  const values    = decodeRegisters(regBytes, quantity, signed ? "signed" : "unsigned");

  return {
    ok:        true,
    operation: "read_input_registers",
    host:      cfg.host,
    port:      cfg.port,
    unitId:    cfg.unitId,
    address,
    quantity,
    values,
    signed,
    byteCount,
    elapsedMs: ms,
  };
}

/** write_coil — FC 05 */
async function opWriteCoil(args) {
  const cfg     = buildConfig(args);
  const address = validateAddress(args.address ?? 0, "address");

  if (typeof args.value !== "boolean")
    throw new Error("modbus_client: 'value' must be a boolean (true=ON, false=OFF) for write_coil.");

  // Modbus coil value: 0xFF00 = ON, 0x0000 = OFF
  const coilVal = args.value ? 0xFF00 : 0x0000;

  const pdu = Buffer.alloc(5);
  pdu.writeUInt8(FC_WRITE_SINGLE_COIL, 0);
  pdu.writeUInt16BE(address, 1);
  pdu.writeUInt16BE(coilVal, 3);

  const t0     = Date.now();
  const parsed = await execModbus(cfg, FC_WRITE_SINGLE_COIL, pdu);
  const ms     = Date.now() - t0;

  // Echo: response mirrors address + value
  const echoAddress = parsed.data.readUInt16BE(0);
  const echoVal     = parsed.data.readUInt16BE(2);

  return {
    ok:          true,
    operation:   "write_coil",
    host:        cfg.host,
    port:        cfg.port,
    unitId:      cfg.unitId,
    address,
    value:       args.value,
    echoAddress,
    echoValue:   echoVal === 0xFF00,
    elapsedMs:   ms,
  };
}

/** write_register — FC 06 */
async function opWriteRegister(args) {
  const cfg     = buildConfig(args);
  const address = validateAddress(args.address ?? 0, "address");

  const val = args.value;
  if (!Number.isInteger(val) || val < -32768 || val > 65535)
    throw new Error("modbus_client: 'value' must be an integer in range -32768 to 65535 for write_register.");

  // Convert signed to unsigned 16-bit
  const rawVal = val < 0 ? val + 65536 : val;

  const pdu = Buffer.alloc(5);
  pdu.writeUInt8(FC_WRITE_SINGLE_REGISTER, 0);
  pdu.writeUInt16BE(address, 1);
  pdu.writeUInt16BE(rawVal,  3);

  const t0     = Date.now();
  const parsed = await execModbus(cfg, FC_WRITE_SINGLE_REGISTER, pdu);
  const ms     = Date.now() - t0;

  const echoAddress = parsed.data.readUInt16BE(0);
  const echoRawVal  = parsed.data.readUInt16BE(2);

  return {
    ok:           true,
    operation:    "write_register",
    host:         cfg.host,
    port:         cfg.port,
    unitId:       cfg.unitId,
    address,
    value:        val,
    rawValue:     rawVal,
    echoAddress,
    echoRawValue: echoRawVal,
    elapsedMs:    ms,
  };
}

/** write_multiple_coils — FC 15 (0x0F) */
async function opWriteMultipleCoils(args) {
  const cfg     = buildConfig(args);
  const address = validateAddress(args.address ?? 0, "address");

  if (!Array.isArray(args.values) || args.values.length === 0)
    throw new Error("modbus_client: 'values' must be a non-empty array of booleans for write_multiple_coils.");
  if (args.values.length > 1968)
    throw new Error(`modbus_client: 'values' array too large (${args.values.length}; max 1968).`);
  if (!args.values.every(v => typeof v === "boolean"))
    throw new Error("modbus_client: all 'values' must be booleans for write_multiple_coils.");

  const quantity  = args.values.length;
  const byteCount = Math.ceil(quantity / 8);

  // Pack booleans into bytes (LSB first per Modbus spec)
  const coilBytes = Buffer.alloc(byteCount, 0);
  for (let i = 0; i < quantity; i++) {
    if (args.values[i]) {
      coilBytes[Math.floor(i / 8)] |= (1 << (i % 8));
    }
  }

  const pdu = Buffer.alloc(6 + byteCount);
  pdu.writeUInt8(FC_WRITE_MULTIPLE_COILS, 0);
  pdu.writeUInt16BE(address,  1);
  pdu.writeUInt16BE(quantity, 3);
  pdu.writeUInt8(byteCount,  5);
  coilBytes.copy(pdu, 6);

  const t0     = Date.now();
  const parsed = await execModbus(cfg, FC_WRITE_MULTIPLE_COILS, pdu);
  const ms     = Date.now() - t0;

  const echoAddress  = parsed.data.readUInt16BE(0);
  const echoQuantity = parsed.data.readUInt16BE(2);

  return {
    ok:           true,
    operation:    "write_multiple_coils",
    host:         cfg.host,
    port:         cfg.port,
    unitId:       cfg.unitId,
    address,
    quantity,
    values:       args.values,
    echoAddress,
    echoQuantity,
    elapsedMs:    ms,
  };
}

/** write_multiple_registers — FC 16 (0x10) */
async function opWriteMultipleRegisters(args) {
  const cfg     = buildConfig(args);
  const address = validateAddress(args.address ?? 0, "address");

  if (!Array.isArray(args.values) || args.values.length === 0)
    throw new Error("modbus_client: 'values' must be a non-empty array of integers for write_multiple_registers.");
  if (args.values.length > 123)
    throw new Error(`modbus_client: 'values' array too large (${args.values.length}; max 123).`);
  for (const v of args.values) {
    if (!Number.isInteger(v) || v < -32768 || v > 65535)
      throw new Error(`modbus_client: all 'values' must be integers in range -32768 to 65535 (got ${v}).`);
  }

  const quantity  = args.values.length;
  const byteCount = quantity * 2;

  const regBytes = Buffer.alloc(byteCount);
  for (let i = 0; i < quantity; i++) {
    const raw = args.values[i] < 0 ? args.values[i] + 65536 : args.values[i];
    regBytes.writeUInt16BE(raw, i * 2);
  }

  const pdu = Buffer.alloc(6 + byteCount);
  pdu.writeUInt8(FC_WRITE_MULTIPLE_REGISTERS, 0);
  pdu.writeUInt16BE(address,  1);
  pdu.writeUInt16BE(quantity, 3);
  pdu.writeUInt8(byteCount,  5);
  regBytes.copy(pdu, 6);

  const t0     = Date.now();
  const parsed = await execModbus(cfg, FC_WRITE_MULTIPLE_REGISTERS, pdu);
  const ms     = Date.now() - t0;

  const echoAddress  = parsed.data.readUInt16BE(0);
  const echoQuantity = parsed.data.readUInt16BE(2);

  const rawValues = args.values.map(v => v < 0 ? v + 65536 : v);

  return {
    ok:           true,
    operation:    "write_multiple_registers",
    host:         cfg.host,
    port:         cfg.port,
    unitId:       cfg.unitId,
    address,
    quantity,
    values:       args.values,
    rawValues,
    echoAddress,
    echoQuantity,
    elapsedMs:    ms,
  };
}

/** info — Return connection config and protocol info (no device I/O) */
function opInfo(args) {
  const cfg = buildConfig(args);
  return {
    ok:        true,
    operation: "info",
    host:      cfg.host,
    port:      cfg.port,
    unitId:    cfg.unitId,
    timeoutMs: cfg.timeoutMs,
    protocol:  "Modbus TCP (MBAP framing, IEC 61158 / MODBUS Application Protocol v1.1b3)",
    transport: "TCP (plain, port 502 default)",
    functionCodes: {
      "0x01 (1)":  "Read Coils",
      "0x02 (2)":  "Read Discrete Inputs",
      "0x03 (3)":  "Read Holding Registers",
      "0x04 (4)":  "Read Input Registers",
      "0x05 (5)":  "Write Single Coil",
      "0x06 (6)":  "Write Single Register",
      "0x0F (15)": "Write Multiple Coils",
      "0x10 (16)": "Write Multiple Registers",
    },
    limits: {
      maxCoilsPerRead:            2000,
      maxDiscreteInputsPerRead:   2000,
      maxHoldingRegistersPerRead: 125,
      maxInputRegistersPerRead:   125,
      maxCoilsPerWrite:           1968,
      maxRegistersPerWrite:       123,
    },
    note: "Modbus has no built-in authentication. Apply firewall/network access control at the network layer.",
  };
}

// ── Main entry point ──────────────────────────────────────────────────────────
async function modbusClient(args) {
  const op = args.operation;
  if (!op) throw new Error("modbus_client: 'operation' is required.");

  switch (op) {
    case "read_coils":               return opReadCoils(args);
    case "read_discrete_inputs":     return opReadDiscreteInputs(args);
    case "read_holding_registers":   return opReadHoldingRegisters(args);
    case "read_input_registers":     return opReadInputRegisters(args);
    case "write_coil":               return opWriteCoil(args);
    case "write_register":           return opWriteRegister(args);
    case "write_multiple_coils":     return opWriteMultipleCoils(args);
    case "write_multiple_registers": return opWriteMultipleRegisters(args);
    case "info":                     return opInfo(args);
    default:
      throw new Error(
        `modbus_client: unknown operation '${op}'. ` +
        `Valid: read_coils, read_discrete_inputs, read_holding_registers, read_input_registers, ` +
        `write_coil, write_register, write_multiple_coils, write_multiple_registers, info.`
      );
  }
}

module.exports = { modbusClient };
