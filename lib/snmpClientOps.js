"use strict";
// lib/snmpClientOps.js — Zero-dependency SNMP v1/v2c client
// Uses Node.js built-in dgram module only. No npm deps.
// Supports: SNMPv1, SNMPv2c
// Operations: get, get_next, get_bulk, walk, set

const dgram  = require("dgram");
const crypto = require("crypto");

// ─── BER / ASN.1 Constants ───────────────────────────────────────────────────────────────
const ASN1 = {
  BOOLEAN:       0x01,
  INTEGER:       0x02,
  BIT_STRING:    0x03,
  OCTET_STRING:  0x04,
  NULL:          0x05,
  OID:           0x06,
  SEQUENCE:      0x30,
  // SNMP application types
  IP_ADDRESS:    0x40,
  COUNTER32:     0x41,
  GAUGE32:       0x42,
  TIMETICKS:     0x43,
  OPAQUE:        0x44,
  COUNTER64:     0x46,
  NO_SUCH_OBJECT:    0x80,
  NO_SUCH_INSTANCE:  0x81,
  END_OF_MIB_VIEW:   0x82,
  // PDU types (context-constructed)
  GET_REQUEST:     0xa0,
  GET_NEXT:        0xa1,
  GET_RESPONSE:    0xa2,
  SET_REQUEST:     0xa3,
  GET_BULK:        0xa5,
  INFORM_REQUEST:  0xa6,
  TRAP_V2:         0xa7,
};

// ─── BER Encoder ───────────────────────────────────────────────────────────────────
function encodeLength(len) {
  if (len < 0x80) return Buffer.from([len]);
  const bytes = [];
  let n = len;
  while (n > 0) { bytes.unshift(n & 0xff); n >>>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function encodeTLV(tag, value) {
  return Buffer.concat([Buffer.from([tag]), encodeLength(value.length), value]);
}

function encodeInteger(n) {
  if (n === 0) return encodeTLV(ASN1.INTEGER, Buffer.from([0x00]));
  const bytes = [];
  let v = n;
  // Handle negative numbers with two's complement
  if (v < 0) {
    // Convert to positive, negate bits, add 1
    v = (-v - 1);
    let tmp = v;
    while (tmp > 0) { bytes.unshift((~tmp) & 0xff); tmp >>>= 8; }
    // Ensure sign bit is set
    if ((bytes[0] & 0x80) === 0) bytes.unshift(0xff);
  } else {
    while (v > 0) { bytes.unshift(v & 0xff); v >>>= 8; }
    // Ensure no false sign bit
    if (bytes[0] & 0x80) bytes.unshift(0x00);
  }
  return encodeTLV(ASN1.INTEGER, Buffer.from(bytes));
}

function encodeUint32(n, tag) {
  tag = tag || ASN1.INTEGER;
  const v = n >>> 0; // force unsigned
  const bytes = [];
  let tmp = v;
  while (tmp > 0) { bytes.unshift(tmp & 0xff); tmp >>>= 8; }
  if (bytes.length === 0) bytes.push(0);
  // No sign-extend for unsigned (add 0x00 if high bit set)
  if (bytes[0] & 0x80) bytes.unshift(0x00);
  return encodeTLV(tag, Buffer.from(bytes));
}

function encodeOctetString(str, tag) {
  tag = tag || ASN1.OCTET_STRING;
  const buf = Buffer.isBuffer(str) ? str : Buffer.from(str, "utf8");
  return encodeTLV(tag, buf);
}

function encodeNull() {
  return Buffer.from([ASN1.NULL, 0x00]);
}

function encodeOid(oidStr) {
  // oidStr: "1.3.6.1.2.1.1.1.0" etc.
  const parts = oidStr.split(".").map(Number);
  if (parts.length < 2)
    throw new Error(`Invalid OID: ${oidStr}`);
  const bytes = [];
  // First two sub-identifiers are combined
  bytes.push(parts[0] * 40 + parts[1]);
  for (let i = 2; i < parts.length; i++) {
    let n = parts[i];
    if (n === 0) { bytes.push(0); continue; }
    const subBytes = [];
    while (n > 0) {
      subBytes.unshift(n & 0x7f);
      n >>>= 7;
    }
    for (let j = 0; j < subBytes.length - 1; j++)
      bytes.push(subBytes[j] | 0x80);
    bytes.push(subBytes[subBytes.length - 1]);
  }
  return encodeTLV(ASN1.OID, Buffer.from(bytes));
}

function encodeSequence(parts) {
  const inner = Buffer.concat(parts);
  return encodeTLV(ASN1.SEQUENCE, inner);
}

function encodePdu(pduType, parts) {
  const inner = Buffer.concat(parts);
  return encodeTLV(pduType, inner);
}

// Encode VarBind: { oid, type, value }
function encodeVarBind(oid, type, value) {
  let valBuf;
  switch (type) {
    case "null":           valBuf = encodeNull(); break;
    case "integer":        valBuf = encodeInteger(typeof value === "number" ? value : parseInt(value, 10)); break;
    case "octet_string":   valBuf = encodeOctetString(value); break;
    case "gauge32":        valBuf = encodeUint32(value >>> 0, ASN1.GAUGE32); break;
    case "counter32":      valBuf = encodeUint32(value >>> 0, ASN1.COUNTER32); break;
    case "timeticks":      valBuf = encodeUint32(value >>> 0, ASN1.TIMETICKS); break;
    case "oid":            valBuf = encodeOid(String(value)); break;
    // Exception types (zero-length value field per RFC 1905)
    case "endOfMibView":   valBuf = encodeTLV(ASN1.END_OF_MIB_VIEW,  Buffer.alloc(0)); break;
    case "noSuchObject":   valBuf = encodeTLV(ASN1.NO_SUCH_OBJECT,   Buffer.alloc(0)); break;
    case "noSuchInstance": valBuf = encodeTLV(ASN1.NO_SUCH_INSTANCE, Buffer.alloc(0)); break;
    case "ip_address": {
      const octets = String(value).split(".").map(Number);
      if (octets.length !== 4) throw new Error(`Invalid IP: ${value}`);
      valBuf = encodeTLV(ASN1.IP_ADDRESS, Buffer.from(octets));
      break;
    }
    default:
      valBuf = encodeNull();
  }
  return encodeSequence([encodeOid(oid), valBuf]);
}

// ─── BER Decoder ───────────────────────────────────────────────────────────────────
function decodeLength(buf, offset) {
  const first = buf[offset++];
  if (first < 0x80) return { length: first, offset };
  const numBytes = first & 0x7f;
  if (numBytes === 0) throw new Error("Indefinite length not supported");
  let length = 0;
  for (let i = 0; i < numBytes; i++) {
    length = (length << 8) | buf[offset++];
  }
  return { length, offset };
}

function decodeTLV(buf, offset) {
  if (offset >= buf.length) throw new Error("Buffer underrun at offset " + offset);
  const tag = buf[offset++];
  const { length, offset: nextOff } = decodeLength(buf, offset);
  const value = buf.slice(nextOff, nextOff + length);
  return { tag, length, value, next: nextOff + length };
}

function decodeInteger(buf) {
  if (buf.length === 0) return 0;
  let val = buf[0] & 0x80 ? -1 : 0; // sign extension
  for (const byte of buf) val = (val * 256) + byte;
  return val;
}

function decodeUint32(buf) {
  let val = 0;
  for (const byte of buf) val = ((val * 256) + byte) >>> 0;
  return val;
}

function decodeUint64(buf) {
  // Return as string to avoid JS precision loss
  let hi = 0, lo = 0;
  for (let i = 0; i < Math.min(buf.length, 4); i++) hi = (hi * 256 + buf[i]) >>> 0;
  for (let i = 4; i < Math.min(buf.length, 8); i++) lo = (lo * 256 + buf[i]) >>> 0;
  // Return numeric approximation (good enough for display)
  return hi * 4294967296 + lo;
}

function decodeOid(buf) {
  if (buf.length === 0) return "";
  const parts = [];
  const first = buf[0];
  parts.push(Math.floor(first / 40));
  parts.push(first % 40);
  let i = 1;
  while (i < buf.length) {
    let n = 0;
    let byte;
    do {
      byte = buf[i++];
      n = (n << 7) | (byte & 0x7f);
    } while (byte & 0x80);
    parts.push(n);
  }
  return parts.join(".");
}

function decodeValue(tag, value) {
  switch (tag) {
    case ASN1.INTEGER:      return { type: "integer",      value: decodeInteger(value) };
    case ASN1.OCTET_STRING: return { type: "octet_string", value: value.toString("utf8") };
    case ASN1.NULL:         return { type: "null",         value: null };
    case ASN1.OID:          return { type: "oid",          value: decodeOid(value) };
    case ASN1.IP_ADDRESS:   return { type: "ip_address",  value: Array.from(value).join(".") };
    case ASN1.COUNTER32:    return { type: "counter32",   value: decodeUint32(value) };
    case ASN1.GAUGE32:      return { type: "gauge32",     value: decodeUint32(value) };
    case ASN1.TIMETICKS:    return { type: "timeticks",   value: decodeUint32(value) };
    case ASN1.OPAQUE:       return { type: "opaque",      value: value.toString("hex") };
    case ASN1.COUNTER64:    return { type: "counter64",   value: decodeUint64(value) };
    case ASN1.NO_SUCH_OBJECT:   return { type: "noSuchObject",   value: null };
    case ASN1.NO_SUCH_INSTANCE: return { type: "noSuchInstance", value: null };
    case ASN1.END_OF_MIB_VIEW:  return { type: "endOfMibView",   value: null };
    default:
      return { type: `unknown(0x${tag.toString(16)})`, value: value.toString("hex") };
  }
}

function decodeVarBindList(buf) {
  const varBinds = [];
  let offset = 0;
  while (offset < buf.length) {
    // Each VarBind is a SEQUENCE
    const { tag, value: vbContent, next } = decodeTLV(buf, offset);
    if (tag !== ASN1.SEQUENCE) throw new Error(`Expected VarBind SEQUENCE, got 0x${tag.toString(16)}`);
    offset = next;
    // Inside: OID + value
    let inner = 0;
    const { tag: oidTag, value: oidBuf, next: afterOid } = decodeTLV(vbContent, inner);
    if (oidTag !== ASN1.OID) throw new Error(`Expected OID in VarBind, got 0x${oidTag.toString(16)}`);
    inner = afterOid;
    const oid = decodeOid(oidBuf);
    const { tag: valTag, value: valBuf } = decodeTLV(vbContent, inner);
    const decoded = decodeValue(valTag, valBuf);
    varBinds.push({ oid, ...decoded });
  }
  return varBinds;
}

// ─── SNMP PDU Build / Parse ──────────────────────────────────────────────────────────────
let _requestId = Math.floor(Math.random() * 0x7fffff);
function nextRequestId() {
  _requestId = (_requestId + 1) & 0x7fffffff;
  return _requestId;
}

/**
 * Build a full SNMP v1/v2c message.
 * @param {object} opts
 *   version: 0 (v1) | 1 (v2c)
 *   community: string
 *   pduType: ASN1 PDU type constant
 *   requestId: number (auto-generated if omitted)
 *   errorStatus: number (default 0)
 *   errorIndex: number (default 0)
 *   nonRepeaters: number (for GETBULK)
 *   maxRepetitions: number (for GETBULK)
 *   varBinds: [{oid, type?, value?}]
 */
function buildSnmpMessage(opts) {
  const version   = opts.version   || 0; // 0=v1, 1=v2c
  const community = opts.community || "public";
  const pduType   = opts.pduType;
  const reqId     = opts.requestId || nextRequestId();
  const varBinds  = opts.varBinds  || [];

  // Encode VarBindList
  const vbList = varBinds.map(vb =>
    encodeVarBind(vb.oid, vb.type || "null", vb.value !== undefined ? vb.value : null)
  );
  const varBindListBuf = encodeSequence(vbList);

  let pduParts;
  if (pduType === ASN1.GET_BULK) {
    // GETBULK uses nonRepeaters and maxRepetitions instead of error-status/index
    pduParts = [
      encodeInteger(reqId),
      encodeInteger(opts.nonRepeaters  || 0),
      encodeInteger(opts.maxRepetitions || 10),
      varBindListBuf,
    ];
  } else {
    pduParts = [
      encodeInteger(reqId),
      encodeInteger(opts.errorStatus || 0),
      encodeInteger(opts.errorIndex  || 0),
      varBindListBuf,
    ];
  }

  const pdu = encodePdu(pduType, pduParts);

  // SNMP Message = SEQUENCE { version, community, pdu }
  const msg = encodeSequence([
    encodeInteger(version),
    encodeOctetString(community),
    pdu,
  ]);
  return { msg, requestId: reqId };
}

/**
 * Parse a raw SNMP response buffer.
 * Returns { version, community, pduType, requestId, errorStatus, errorIndex,
 *           errorStatusText, varBinds }
 */
const ERROR_STATUS_NAMES = [
  "noError", "tooBig", "noSuchName", "badValue", "readOnly", "genErr",
  "noAccess", "wrongType", "wrongLength", "wrongEncoding", "wrongValue",
  "noCreation", "inconsistentValue", "resourceUnavailable", "commitFailed",
  "undoFailed", "authorizationError", "notWritable", "inconsistentName",
];

function parseSnmpMessage(buf) {
  // Top-level SEQUENCE
  const { tag: outerTag, value: outerBuf } = decodeTLV(buf, 0);
  if (outerTag !== ASN1.SEQUENCE)
    throw new Error(`Expected SNMP SEQUENCE, got 0x${outerTag.toString(16)}`);

  let offset = 0;
  // version
  const { tag: verTag, value: verBuf, next: afterVer } = decodeTLV(outerBuf, offset);
  if (verTag !== ASN1.INTEGER) throw new Error("Expected version INTEGER");
  const version = decodeInteger(verBuf);
  offset = afterVer;

  // community
  const { tag: comTag, value: comBuf, next: afterCom } = decodeTLV(outerBuf, offset);
  if (comTag !== ASN1.OCTET_STRING) throw new Error("Expected community OCTET_STRING");
  const community = comBuf.toString("utf8");
  offset = afterCom;

  // PDU (tag varies by PDU type)
  const { tag: pduTag, value: pduBuf } = decodeTLV(outerBuf, offset);
  const pduType = pduTag;

  // Inside PDU
  let pOffset = 0;
  const { tag: ridTag, value: ridBuf, next: afterRid } = decodeTLV(pduBuf, pOffset);
  if (ridTag !== ASN1.INTEGER) throw new Error("Expected requestId INTEGER");
  const requestId = decodeInteger(ridBuf);
  pOffset = afterRid;

  const { tag: esTag, value: esBuf, next: afterEs } = decodeTLV(pduBuf, pOffset);
  if (esTag !== ASN1.INTEGER) throw new Error("Expected errorStatus INTEGER");
  const errorStatus = decodeInteger(esBuf);
  pOffset = afterEs;

  const { tag: eiTag, value: eiBuf, next: afterEi } = decodeTLV(pduBuf, pOffset);
  if (eiTag !== ASN1.INTEGER) throw new Error("Expected errorIndex INTEGER");
  const errorIndex = decodeInteger(eiBuf);
  pOffset = afterEi;

  // VarBind list (another SEQUENCE)
  const { tag: vblTag, value: vblBuf } = decodeTLV(pduBuf, pOffset);
  if (vblTag !== ASN1.SEQUENCE) throw new Error("Expected VarBindList SEQUENCE");
  const varBinds = decodeVarBindList(vblBuf);

  return {
    version,
    community,
    pduType,
    requestId,
    errorStatus,
    errorIndex,
    errorStatusText: ERROR_STATUS_NAMES[errorStatus] || `unknown(${errorStatus})`,
    varBinds,
  };
}

// ─── UDP Send/Receive Helper ─────────────────────────────────────────────────────────────────
const MAX_RESPONSE_BYTES = 65535; // UDP max

/**
 * Send a SNMP UDP request and await one response matching the requestId.
 */
function sendRequest(opts) {
  return new Promise((resolve, reject) => {
    const {
      host, port, msgBuf, requestId,
      timeout, community, version,
    } = opts;
    const socket = dgram.createSocket("udp4");
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      socket.close();
      reject(new Error(`SNMP timeout after ${timeout}ms (host: ${host}:${port})`));
    }, timeout);

    socket.on("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.close();
      reject(err);
    });

    socket.on("message", (msg) => {
      if (done) return;
      try {
        if (msg.length > MAX_RESPONSE_BYTES) {
          throw new Error("Response exceeds 64 KB cap");
        }
        const parsed = parseSnmpMessage(msg);
        if (parsed.requestId !== requestId) return; // spurious/old packet
        if (parsed.community !== community) return;  // wrong community
        done = true;
        clearTimeout(timer);
        socket.close();
        resolve(parsed);
      } catch (e) {
        done = true;
        clearTimeout(timer);
        socket.close();
        reject(e);
      }
    });

    socket.bind(() => {
      socket.send(msgBuf, 0, msgBuf.length, port, host, (err) => {
        if (err && !done) {
          done = true;
          clearTimeout(timer);
          socket.close();
          reject(err);
        }
      });
    });
  });
}

// ─── Security Guards ──────────────────────────────────────────────────────────────────────────
function guardString(val, name, maxLen) {
  if (typeof val !== "string")
    throw new Error(`${name} must be a string`);
  if (val.includes("\x00"))
    throw new Error(`${name} must not contain NUL bytes`);
  if (maxLen && val.length > maxLen)
    throw new Error(`${name} exceeds maximum length of ${maxLen}`);
}

function guardOid(oid) {
  if (typeof oid !== "string")
    throw new Error("OID must be a string");
  if (!/^\d+(\.\d+)*$/.test(oid))
    throw new Error(`Invalid OID format: '${oid}'. Must be numeric dot-notation e.g. '1.3.6.1.2.1.1.1.0'`);
  if (oid.length > 256)
    throw new Error("OID exceeds 256 character limit");
}

// ─── OID Alias Map (common MIB-II names) ────────────────────────────────────────────────────────────
const OID_ALIASES = {
  "sysDescr":        "1.3.6.1.2.1.1.1.0",
  "sysObjectID":     "1.3.6.1.2.1.1.2.0",
  "sysUpTime":       "1.3.6.1.2.1.1.3.0",
  "sysContact":      "1.3.6.1.2.1.1.4.0",
  "sysName":         "1.3.6.1.2.1.1.5.0",
  "sysLocation":     "1.3.6.1.2.1.1.6.0",
  "sysServices":     "1.3.6.1.2.1.1.7.0",
  "ifNumber":        "1.3.6.1.2.1.2.1.0",
  "ifIndex":         "1.3.6.1.2.1.2.2.1.1",
  "ifDescr":         "1.3.6.1.2.1.2.2.1.2",
  "ifType":          "1.3.6.1.2.1.2.2.1.3",
  "ifMtu":           "1.3.6.1.2.1.2.2.1.4",
  "ifSpeed":         "1.3.6.1.2.1.2.2.1.5",
  "ifPhysAddress":   "1.3.6.1.2.1.2.2.1.6",
  "ifAdminStatus":   "1.3.6.1.2.1.2.2.1.7",
  "ifOperStatus":    "1.3.6.1.2.1.2.2.1.8",
  "ifInOctets":      "1.3.6.1.2.1.2.2.1.10",
  "ifOutOctets":     "1.3.6.1.2.1.2.2.1.16",
  "hrSystemUptime":  "1.3.6.1.2.11.25.1.1.0",
  "hrProcessorLoad": "1.3.6.1.2.11.25.3.3.1.2",
  "tcpConnState":    "1.3.6.1.2.1.6.13.1.1",
  "udpInDatagrams":  "1.3.6.1.2.1.7.1.0",
};

function resolveOid(oid) {
  return OID_ALIASES[oid] || oid;
}

// ─── Core Operation Helpers ─────────────────────────────────────────────────────────────────
async function doSnmpRequest(host, port, version, community, pduType, varBinds, timeout, extraOpts) {
  const { msg, requestId } = buildSnmpMessage({
    version, community, pduType,
    varBinds,
    ...(extraOpts || {}),
  });
  return sendRequest({ host, port, msgBuf: msg, requestId, timeout, community, version });
}

// ─── Exported Operations ─────────────────────────────────────────────────────────────────────

/**
 * Main entrypoint for snmp_client tool.
 * args.operation: get | get_next | get_bulk | walk | set
 */
async function snmpClient(args) {
  const t0 = Date.now();

  // ── Required params ───────────────────────────────────────────────────────────────────
  const host      = args.host;
  const port      = args.port      || 161;
  const community = args.community || "public";
  const version   = args.version   || "v2c"; // "v1" | "v2c"
  const timeout   = Math.round((args.timeout || 5) * 1000);
  const operation = args.operation;

  // ── Validate ────────────────────────────────────────────────────────────────────────────
  if (!host) throw new Error("snmp_client: 'host' is required");
  guardString(host, "host", 253);
  if (host.includes("\n") || host.includes("\r"))
    throw new Error("host must not contain CRLF");
  guardString(community, "community", 256);
  if (community.includes("\n") || community.includes("\r"))
    throw new Error("community must not contain CRLF");

  if (!operation)
    throw new Error("snmp_client: 'operation' is required");

  const snmpVersion = version === "v1" ? 0 : 1; // 0=v1, 1=v2c

  const elapsedMs = () => Date.now() - t0;
  const base = { host, port, version, operation };

  // ── Resolve OIDs helper ──────────────────────────────────────────────────────────────────
  const resolveOids = (oids) => {
    // Guard against undefined/null (no OID provided at all)
    if (oids == null) throw new Error("At least one OID is required");
    if (!Array.isArray(oids)) oids = [oids];
    if (oids.length === 0) throw new Error("At least one OID is required");
    if (oids.length > 100) throw new Error("Maximum 100 OIDs per request");
    return oids.map(o => {
      const resolved = resolveOid(String(o));
      guardOid(resolved);
      return resolved;
    });
  };

  switch (operation) {

    // ── GET ──────────────────────────────────────────────────────────────────────────
    case "get": {
      const oids = resolveOids(args.oids || args.oid);
      const varBinds = oids.map(oid => ({ oid, type: "null" }));
      const resp = await doSnmpRequest(host, port, snmpVersion, community,
        ASN1.GET_REQUEST, varBinds, timeout);

      if (resp.errorStatus !== 0)
        throw new Error(`SNMP error: ${resp.errorStatusText} (status=${resp.errorStatus}, index=${resp.errorIndex})`);

      return {
        ...base, elapsedMs: elapsedMs(),
        varBinds: resp.varBinds,
        count: resp.varBinds.length,
      };
    }

    // ── GET_NEXT ───────────────────────────────────────────────────────────────────────
    case "get_next": {
      const oids = resolveOids(args.oids || args.oid);
      const varBinds = oids.map(oid => ({ oid, type: "null" }));
      const resp = await doSnmpRequest(host, port, snmpVersion, community,
        ASN1.GET_NEXT, varBinds, timeout);

      if (resp.errorStatus !== 0)
        throw new Error(`SNMP error: ${resp.errorStatusText} (status=${resp.errorStatus}, index=${resp.errorIndex})`);

      return {
        ...base, elapsedMs: elapsedMs(),
        varBinds: resp.varBinds,
        count: resp.varBinds.length,
      };
    }

    // ── GET_BULK (v2c only) ───────────────────────────────────────────────────────────────────
    case "get_bulk": {
      if (snmpVersion < 1)
        throw new Error("get_bulk requires SNMPv2c (version: 'v2c')");
      const oids = resolveOids(args.oids || args.oid);
      const varBinds = oids.map(oid => ({ oid, type: "null" }));
      const resp = await doSnmpRequest(host, port, snmpVersion, community,
        ASN1.GET_BULK, varBinds, timeout, {
          nonRepeaters:   args.non_repeaters   || 0,
          maxRepetitions: args.max_repetitions || 10,
        });

      if (resp.errorStatus !== 0)
        throw new Error(`SNMP error: ${resp.errorStatusText} (status=${resp.errorStatus}, index=${resp.errorIndex})`);

      return {
        ...base, elapsedMs: elapsedMs(),
        varBinds: resp.varBinds,
        count: resp.varBinds.length,
        nonRepeaters: args.non_repeaters || 0,
        maxRepetitions: args.max_repetitions || 10,
      };
    }

    // ── WALK (repeated GETNEXT/GETBULK until end of subtree) ──────────────────────────────
    case "walk": {
      const rootOid = resolveOid(String(args.oid || (args.oids && args.oids[0]) || ""));
      guardOid(rootOid);
      const maxVars   = Math.min(args.max_results || 100, 1000);
      const varBinds  = [];
      let   currentOid = rootOid;
      const deadline   = Date.now() + timeout;

      while (varBinds.length < maxVars) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`SNMP walk timeout after ${timeout}ms`);

        const resp = await doSnmpRequest(host, port, snmpVersion, community,
          snmpVersion >= 1 ? ASN1.GET_BULK : ASN1.GET_NEXT,
          [{ oid: currentOid, type: "null" }],
          remaining,
          snmpVersion >= 1 ? { nonRepeaters: 0, maxRepetitions: Math.min(10, maxVars - varBinds.length) } : undefined
        );

        if (resp.errorStatus !== 0) break; // end of walk on error

        let advanced = false;
        for (const vb of resp.varBinds) {
          // Stop if out of subtree
          if (!vb.oid.startsWith(rootOid + ".") && vb.oid !== rootOid) break;
          if (vb.type === "endOfMibView" || vb.type === "noSuchObject" || vb.type === "noSuchInstance") break;
          varBinds.push(vb);
          currentOid = vb.oid;
          advanced = true;
          if (varBinds.length >= maxVars) break;
        }
        if (!advanced) break;
      }

      return {
        ...base, elapsedMs: elapsedMs(),
        rootOid,
        varBinds,
        count: varBinds.length,
        truncated: varBinds.length >= maxVars,
      };
    }

    // ── SET ──────────────────────────────────────────────────────────────────────────
    case "set": {
      if (!args.set_vars || !Array.isArray(args.set_vars) || args.set_vars.length === 0)
        throw new Error("set operation requires 'set_vars': [{oid, type, value}]");
      if (args.set_vars.length > 100)
        throw new Error("Maximum 100 set variables per request");

      const varBinds = args.set_vars.map(sv => {
        const oid = resolveOid(String(sv.oid || ""));
        guardOid(oid);
        return { oid, type: sv.type || "octet_string", value: sv.value };
      });

      const resp = await doSnmpRequest(host, port, snmpVersion, community,
        ASN1.SET_REQUEST, varBinds, timeout);

      if (resp.errorStatus !== 0)
        throw new Error(`SNMP SET error: ${resp.errorStatusText} (status=${resp.errorStatus}, index=${resp.errorIndex})`);

      return {
        ...base, elapsedMs: elapsedMs(),
        varBinds: resp.varBinds,
        count: resp.varBinds.length,
        success: true,
      };
    }

    default:
      throw new Error(`snmp_client: unknown operation '${operation}'. Valid: get, get_next, get_bulk, walk, set`);
  }
}

// ─── BER Codec exports (used by tests) ──────────────────────────────────────────────────────────────
module.exports = {
  snmpClient,
  // Export codec internals for unit testing
  _ber: {
    encodeInteger, encodeUint32, encodeOctetString, encodeNull, encodeOid,
    encodeSequence, encodePdu, encodeVarBind, buildSnmpMessage,
    decodeLength, decodeTLV, decodeInteger, decodeUint32, decodeOid,
    decodeValue, decodeVarBindList, parseSnmpMessage,
  },
  _oidAliases: OID_ALIASES,
  _resolveOid: resolveOid,
};
