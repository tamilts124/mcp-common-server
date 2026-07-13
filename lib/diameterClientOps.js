"use strict";
/**
 * diameter_client — Zero-dependency Diameter protocol client
 * (pure Node.js net/tls/crypto built-ins; no npm deps)
 *
 * RFC 6733  — Diameter Base Protocol
 * RFC 4006  — Diameter Credit-Control Application (CCA)
 * RFC 5778  — Diameter Mobile IPv6 (Nx interface hint)
 * RFC 7683  — Diameter Overload Indication Conveyance (DOIC)
 *
 * Operations:
 *   capabilities_exchange  — CER/CEA handshake (discover server capabilities)
 *   device_watchdog        — DWR/DWA round-trip (keepalive / latency)
 *   disconnect_peer        — DPR/DPA graceful disconnect
 *   send_request           — Send any Diameter request message and receive answer
 *   info                   — Return protocol/AVP/config table (no I/O)
 *
 * Transport:
 *   TCP (plain, default port 3868)
 *   TLS (secure, default port 5658)
 *
 * Wire format:
 *   4-byte header version/length, 4-byte flags+command, 4-byte App-ID,
 *   4-byte Hop-by-Hop ID, 4-byte End-to-End ID, then AVPs.
 *   Each AVP: 4-byte code, 1-byte flags, 3-byte length, optional 4-byte
 *   Vendor-ID, value bytes, padded to 4-byte alignment.
 */

const net    = require("net");
const tls    = require("tls");
const crypto = require("crypto");

// ── Constants ──────────────────────────────────────────────────────────────────

/** Diameter command codes (RFC 6733 §3.1) */
const CMD = {
  CAPABILITIES_EXCHANGE: 257,
  WATCHDOG:              280,
  DISCONNECT_PEER:       282,
  // RFC 4006 Credit-Control
  CREDIT_CONTROL:        272,
  // RFC 4072 EAP
  EAP:                   268,
  // RFC 7683 DOIC
  CAPABILITIES_UPDATE:   328,
};

/** Application IDs (RFC 6733 §2.4) */
const APP_ID = {
  BASE:           0,
  NASREQ:         1,
  MOBILE_IPV4:    2,
  BASE_ACCOUNTING: 3,
  CREDIT_CONTROL: 4,
  EAP:            5,
  SIP:            6,
  MIP6I:          7,
  MIP6A:          8,
  RELAY:          0xFFFFFFFF,
};

/** Message flag bits (RFC 6733 §3) */
const FLAG = {
  REQUEST:  0x80,
  PROXIABLE: 0x40,
  ERROR:    0x20,
  RETRANSMIT: 0x10,
};

/** AVP flag bits (RFC 6733 §4.1) */
const AVP_FLAG = {
  MANDATORY: 0x40,
  VENDOR:    0x80,
};

/** Common AVP codes (RFC 6733 §4.3 + extensions) */
const AVP = {
  // Base
  ACCT_INTERIM_INTERVAL:  85,
  ACCOUNTING_REALTIME_REQUIRED: 483,
  ACCT_MULTI_SESSION_ID: 50,
  ACCOUNTING_RECORD_NUMBER: 485,
  ACCOUNTING_RECORD_TYPE: 480,
  ACCOUNTING_SESSION_ID: 44,
  ACCOUNTING_SUB_SESSION_ID: 287,
  ACCT_APPLICATION_ID:   259,
  AUTH_APPLICATION_ID:   258,
  AUTH_REQUEST_TYPE:     274,
  AUTH_SESSION_STATE:    277,
  AUTHORIZATION_LIFETIME: 291,
  CLASS:                 25,
  DESTINATION_HOST:      293,
  DESTINATION_REALM:     283,
  DISCONNECT_CAUSE:      273,
  E2E_SEQUENCE:          300,
  ERROR_MESSAGE:         281,
  ERROR_REPORTING_HOST:  294,
  EXPERIMENTAL_RESULT:   297,
  EXPERIMENTAL_RESULT_CODE: 298,
  FAILED_AVP:            279,
  FIRMWARE_REVISION:     267,
  HOST_IP_ADDRESS:       257,
  INBAND_SECURITY_ID:    299,
  MULTI_ROUND_TIME_OUT:  272,
  ORIGIN_HOST:           264,
  ORIGIN_REALM:          296,
  ORIGIN_STATE_ID:       278,
  PRODUCT_NAME:          269,
  PROXY_HOST:            280,
  PROXY_INFO:            284,
  PROXY_STATE:           33,
  REDIRECT_HOST:         292,
  REDIRECT_HOST_USAGE:   261,
  REDIRECT_MAX_CACHE_TIME: 262,
  RESULT_CODE:           268,
  ROUTE_RECORD:          282,
  SESSION_BINDING:       270,
  SESSION_ID:            263,
  SESSION_SERVER_FAILOVER: 271,
  SESSION_TIMEOUT:       27,
  SUBSCRIPTION_ID:       443,
  SUBSCRIPTION_ID_DATA:  444,
  SUBSCRIPTION_ID_TYPE:  450,
  SUPPORTED_VENDOR_ID:   265,
  TERMINATION_CAUSE:     295,
  USER_NAME:             1,
  VENDOR_ID:             266,
  VENDOR_SPECIFIC_APPLICATION_ID: 260,
};

/** Result-Code values (RFC 6733 §7.1) */
const RESULT_CODE = {
  // 1xxx Informational
  MULTI_ROUND_AUTH:       1001,
  // 2xxx Success
  SUCCESS:                2001,
  LIMITED_SUCCESS:        2002,
  // 3xxx Protocol Errors
  COMMAND_UNSUPPORTED:    3001,
  UNABLE_TO_DELIVER:      3002,
  REALM_NOT_SERVED:       3003,
  TOO_BUSY:               3004,
  LOOP_DETECTED:          3005,
  REDIRECT_INDICATION:    3006,
  APPLICATION_UNSUPPORTED: 3007,
  INVALID_HDR_BITS:       3008,
  INVALID_AVP_BITS:       3009,
  UNKNOWN_PEER:           3010,
  // 4xxx Transient Failures
  AUTHENTICATION_REJECTED: 4001,
  OUT_OF_SPACE:           4002,
  ELECTION_LOST:          4003,
  // 5xxx Permanent Failures
  AVP_UNSUPPORTED:        5001,
  UNKNOWN_SESSION_ID:     5002,
  AUTHORIZATION_REJECTED: 5003,
  INVALID_AVP_VALUE:      5004,
  MISSING_AVP:            5005,
  RESOURCES_EXCEEDED:     5006,
  CONTRADICTING_AVPS:     5007,
  AVP_NOT_ALLOWED:        5008,
  AVP_OCCURS_TOO_MANY_TIMES: 5009,
  NO_COMMON_APPLICATION:  5010,
  UNSUPPORTED_VERSION:    5011,
  UNABLE_TO_COMPLY:       5012,
  INVALID_BIT_IN_HEADER:  5013,
  INVALID_AVP_LENGTH:     5014,
  INVALID_MESSAGE_LENGTH: 5015,
  INVALID_AVP_BIT_COMBO:  5016,
  NO_COMMON_SECURITY:     5017,
};

const RESULT_CODE_NAMES = {};
for (const [k, v] of Object.entries(RESULT_CODE)) RESULT_CODE_NAMES[v] = k;

/** Disconnect-Cause values (RFC 6733 §5.4.3) */
const DISCONNECT_CAUSE = {
  rebooting:           0,
  busy:                1,
  do_not_want_to_talk: 2,
};

/** Data types for decoding AVP values */
const AVP_TYPE = {
  OCTET_STRING: "OctetString",
  INTEGER32:    "Integer32",
  INTEGER64:    "Integer64",
  UNSIGNED32:   "Unsigned32",
  UNSIGNED64:   "Unsigned64",
  FLOAT32:      "Float32",
  FLOAT64:      "Float64",
  GROUPED:      "Grouped",
  ADDRESS:      "Address",
  DIAMIDENT:    "DiameterIdentity",
  DIAMURI:      "DiameterURI",
  ENUMERATED:   "Enumerated",
  UTCTIME:      "Time",
  UTF8STRING:   "UTF8String",
  IPFILTERRULE: "IPFilterRule",
};

/** Map AVP code → { name, type } for decoding common AVPs */
const AVP_META = {
  [AVP.SESSION_ID]:           { name: "Session-Id",           type: AVP_TYPE.UTF8STRING },
  [AVP.ORIGIN_HOST]:          { name: "Origin-Host",          type: AVP_TYPE.DIAMIDENT },
  [AVP.ORIGIN_REALM]:         { name: "Origin-Realm",         type: AVP_TYPE.DIAMIDENT },
  [AVP.DESTINATION_HOST]:     { name: "Destination-Host",     type: AVP_TYPE.DIAMIDENT },
  [AVP.DESTINATION_REALM]:    { name: "Destination-Realm",    type: AVP_TYPE.DIAMIDENT },
  [AVP.RESULT_CODE]:          { name: "Result-Code",          type: AVP_TYPE.UNSIGNED32 },
  [AVP.AUTH_APPLICATION_ID]:  { name: "Auth-Application-Id",  type: AVP_TYPE.UNSIGNED32 },
  [AVP.ACCT_APPLICATION_ID]:  { name: "Acct-Application-Id",  type: AVP_TYPE.UNSIGNED32 },
  [AVP.HOST_IP_ADDRESS]:      { name: "Host-IP-Address",      type: AVP_TYPE.ADDRESS },
  [AVP.VENDOR_ID]:            { name: "Vendor-Id",            type: AVP_TYPE.UNSIGNED32 },
  [AVP.PRODUCT_NAME]:         { name: "Product-Name",         type: AVP_TYPE.UTF8STRING },
  [AVP.FIRMWARE_REVISION]:    { name: "Firmware-Revision",    type: AVP_TYPE.UNSIGNED32 },
  [AVP.SUPPORTED_VENDOR_ID]:  { name: "Supported-Vendor-Id",  type: AVP_TYPE.UNSIGNED32 },
  [AVP.ORIGIN_STATE_ID]:      { name: "Origin-State-Id",      type: AVP_TYPE.UNSIGNED32 },
  [AVP.DISCONNECT_CAUSE]:     { name: "Disconnect-Cause",     type: AVP_TYPE.ENUMERATED },
  [AVP.USER_NAME]:            { name: "User-Name",            type: AVP_TYPE.UTF8STRING },
  [AVP.SESSION_TIMEOUT]:      { name: "Session-Timeout",      type: AVP_TYPE.UNSIGNED32 },
  [AVP.ERROR_MESSAGE]:        { name: "Error-Message",        type: AVP_TYPE.UTF8STRING },
  [AVP.ROUTE_RECORD]:         { name: "Route-Record",         type: AVP_TYPE.DIAMIDENT },
  [AVP.CLASS]:                { name: "Class",                type: AVP_TYPE.OCTET_STRING },
  [AVP.AUTH_SESSION_STATE]:   { name: "Auth-Session-State",   type: AVP_TYPE.ENUMERATED },
  [AVP.AUTH_REQUEST_TYPE]:    { name: "Auth-Request-Type",    type: AVP_TYPE.ENUMERATED },
};

// ── Wire-format helpers ────────────────────────────────────────────────────────

/**
 * Encode an AVP.
 * @param {number} code      - AVP code (32-bit)
 * @param {Buffer} value     - Raw value bytes
 * @param {object} [opts]
 * @param {boolean} [opts.mandatory=true]  - Set M flag
 * @param {number}  [opts.vendorId]        - If set, include V flag + 4-byte vendor-id
 * @returns {Buffer}
 */
function encodeAvp(code, value, opts = {}) {
  const mandatory = opts.mandatory !== false; // default true
  const vendorId  = opts.vendorId || 0;
  const hasVendor = vendorId !== 0;

  let flags = 0;
  if (mandatory) flags |= AVP_FLAG.MANDATORY;
  if (hasVendor) flags |= AVP_FLAG.VENDOR;

  const headerLen = hasVendor ? 12 : 8;
  const rawLen    = headerLen + value.length;
  const pad       = (4 - (rawLen % 4)) % 4;
  const totalLen  = rawLen + pad;

  const buf = Buffer.alloc(totalLen, 0);
  buf.writeUInt32BE(code, 0);
  buf[4] = flags;
  // 3-byte length field (bytes 5-7): rawLen (not including padding)
  buf[5] = (rawLen >> 16) & 0xFF;
  buf[6] = (rawLen >> 8)  & 0xFF;
  buf[7] =  rawLen        & 0xFF;
  if (hasVendor) {
    buf.writeUInt32BE(vendorId, 8);
    value.copy(buf, 12);
  } else {
    value.copy(buf, 8);
  }
  return buf;
}

/** Encode a UTF-8 / DiameterIdentity string AVP */
function encodeAvpUtf8(code, str, opts) {
  return encodeAvp(code, Buffer.from(str, "utf8"), opts);
}

/** Encode an Unsigned32 / Integer32 / Enumerated AVP */
function encodeAvpUint32(code, value, opts) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(value >>> 0, 0);
  return encodeAvp(code, b, opts);
}

/** Encode a Host-IP-Address AVP (RFC 6733 §4.3.1) — Address type with 2-byte address family */
function encodeAvpAddress(code, ip, opts) {
  // IPv4: family=1, 4 bytes; IPv6: family=2, 16 bytes
  const isV6 = ip.includes(":");
  if (isV6) {
    // Parse IPv6 — simple best-effort for loopback / common forms
    const parts = expandIPv6(ip);
    const b = Buffer.alloc(18);
    b.writeUInt16BE(2, 0);
    parts.copy(b, 2);
    return encodeAvp(code, b, opts);
  } else {
    const octets = ip.split(".").map(Number);
    const b = Buffer.alloc(6);
    b.writeUInt16BE(1, 0);
    octets.forEach((o, i) => { b[2 + i] = o; });
    return encodeAvp(code, b, opts);
  }
}

/** Expand an IPv6 address into 16 bytes */
function expandIPv6(ip) {
  const buf = Buffer.alloc(16, 0);
  // Handle :: compression
  const halves = ip.split("::");
  let left, right;
  if (halves.length === 2) {
    left  = halves[0] ? halves[0].split(":") : [];
    right = halves[1] ? halves[1].split(":") : [];
  } else {
    left  = ip.split(":");
    right = [];
  }
  const missing = 8 - left.length - right.length;
  const groups  = [...left, ...Array(missing).fill("0"), ...right];
  groups.forEach((g, i) => buf.writeUInt16BE(parseInt(g || "0", 16), i * 2));
  return buf;
}

/**
 * Build a Diameter message header + AVPs.
 * @param {object} opts
 * @param {number}  opts.commandCode
 * @param {number}  opts.appId
 * @param {boolean} opts.isRequest
 * @param {boolean} [opts.proxiable=true]
 * @param {Buffer[]} opts.avps
 * @param {number}  [opts.hopByHopId]
 * @param {number}  [opts.endToEndId]
 * @returns {{ buf: Buffer, hopByHopId: number, endToEndId: number }}
 */
function buildMessage(opts) {
  const { commandCode, appId, isRequest, avps = [] } = opts;
  const proxiable   = opts.proxiable !== false;
  const hopByHopId  = opts.hopByHopId !== undefined ? opts.hopByHopId : (crypto.randomBytes(4).readUInt32BE(0));
  const endToEndId  = opts.endToEndId !== undefined ? opts.endToEndId : (crypto.randomBytes(4).readUInt32BE(0));

  const avpBuf = Buffer.concat(avps);
  const length = 20 + avpBuf.length;

  const buf = Buffer.alloc(length);
  // Byte 0: version = 1
  buf[0] = 1;
  // Bytes 1-3: message length
  buf[1] = (length >> 16) & 0xFF;
  buf[2] = (length >> 8)  & 0xFF;
  buf[3] =  length        & 0xFF;
  // Byte 4: flags
  let flags = 0;
  if (isRequest)  flags |= FLAG.REQUEST;
  if (proxiable)  flags |= FLAG.PROXIABLE;
  buf[4] = flags;
  // Bytes 5-7: command code (24-bit)
  buf[5] = (commandCode >> 16) & 0xFF;
  buf[6] = (commandCode >> 8)  & 0xFF;
  buf[7] =  commandCode        & 0xFF;
  // Bytes 8-11: Application-ID
  buf.writeUInt32BE(appId >>> 0, 8);
  // Bytes 12-15: Hop-by-Hop Identifier
  buf.writeUInt32BE(hopByHopId >>> 0, 12);
  // Bytes 16-19: End-to-End Identifier
  buf.writeUInt32BE(endToEndId >>> 0, 16);
  // AVPs
  avpBuf.copy(buf, 20);

  return { buf, hopByHopId, endToEndId };
}

/**
 * Parse a Diameter message from a Buffer.
 * Returns header fields + array of parsed AVPs.
 */
function parseMessage(buf) {
  if (buf.length < 20) throw new Error("Diameter message too short (< 20 bytes)");
  const version = buf[0];
  if (version !== 1) throw new Error(`Unsupported Diameter version: ${version}`);
  const length  = (buf[1] << 16) | (buf[2] << 8) | buf[3];
  const msgFlags = buf[4];
  const commandCode = (buf[5] << 16) | (buf[6] << 8) | buf[7];
  const appId      = buf.readUInt32BE(8);
  const hopByHopId = buf.readUInt32BE(12);
  const endToEndId = buf.readUInt32BE(16);

  const isRequest  = !!(msgFlags & FLAG.REQUEST);
  const isProxiable = !!(msgFlags & FLAG.PROXIABLE);
  const isError    = !!(msgFlags & FLAG.ERROR);

  const avps = parseAvps(buf, 20, Math.min(length, buf.length));

  return {
    version, length, flags: msgFlags, commandCode, appId,
    hopByHopId, endToEndId, isRequest, isProxiable, isError, avps,
  };
}

/**
 * Parse AVPs from a buffer slice [start, end).
 */
function parseAvps(buf, start, end) {
  const result = [];
  let offset = start;
  while (offset + 8 <= end) {
    const code  = buf.readUInt32BE(offset);
    const flags = buf[offset + 4];
    const rawLen = (buf[offset + 5] << 16) | (buf[offset + 6] << 8) | buf[offset + 7];
    if (rawLen < 8 || offset + rawLen > end + 4) break; // sanity

    const hasVendor = !!(flags & AVP_FLAG.VENDOR);
    const isMandatory = !!(flags & AVP_FLAG.MANDATORY);
    let valueStart = offset + 8;
    let vendorId   = 0;
    if (hasVendor) {
      if (rawLen < 12) break;
      vendorId   = buf.readUInt32BE(offset + 8);
      valueStart = offset + 12;
    }
    const valueLen = rawLen - (hasVendor ? 12 : 8);
    const value    = valueLen > 0 ? buf.slice(valueStart, valueStart + valueLen) : Buffer.alloc(0);

    // Padding to 4-byte alignment
    const pad    = (4 - (rawLen % 4)) % 4;
    const avpEnd = offset + rawLen + pad;

    const meta    = AVP_META[code];
    const decoded = decodeAvpValue(value, meta ? meta.type : null, code);

    result.push({
      code,
      name:       meta ? meta.name : `AVP-${code}`,
      flags,
      isMandatory,
      hasVendor,
      vendorId,
      rawLength: rawLen,
      value,       // raw Buffer
      decoded,     // human-readable
    });

    offset = avpEnd;
  }
  return result;
}

/**
 * Decode an AVP value to a human-readable form.
 */
function decodeAvpValue(value, type, code) {
  if (!value || value.length === 0) return null;
  try {
    switch (type) {
      case AVP_TYPE.UTF8STRING:
      case AVP_TYPE.DIAMIDENT:
      case AVP_TYPE.DIAMURI:
      case AVP_TYPE.IPFILTERRULE:
        return value.toString("utf8");
      case AVP_TYPE.UNSIGNED32:
      case AVP_TYPE.ENUMERATED:
      case AVP_TYPE.INTEGER32:
        return value.length >= 4 ? value.readUInt32BE(0) : value.readUInt16BE(0);
      case AVP_TYPE.UNSIGNED64:
      case AVP_TYPE.INTEGER64: {
        // Return as hex string for large values (BigInt not available everywhere)
        const hi = value.readUInt32BE(0);
        const lo = value.readUInt32BE(4);
        return hi === 0 ? lo : `0x${hi.toString(16)}${lo.toString(16).padStart(8, "0")}`;
      }
      case AVP_TYPE.ADDRESS: {
        // 2-byte family + address bytes
        if (value.length < 2) return value.toString("hex");
        const family = value.readUInt16BE(0);
        if (family === 1 && value.length >= 6) {
          return `${value[2]}.${value[3]}.${value[4]}.${value[5]}`;
        } else if (family === 2 && value.length >= 18) {
          const parts = [];
          for (let i = 2; i < 18; i += 2) parts.push(value.readUInt16BE(i).toString(16));
          return parts.join(":");
        }
        return value.toString("hex");
      }
      case AVP_TYPE.UTCTIME: {
        // 4-byte seconds since 1900-01-01
        const secs = value.readUInt32BE(0);
        // NTP epoch offset: 70 years in seconds
        const NTP_OFFSET = 2208988800;
        return new Date((secs - NTP_OFFSET) * 1000).toISOString();
      }
      case AVP_TYPE.OCTET_STRING:
      default:
        // Try UTF-8, fall back to hex
        try {
          const str = value.toString("utf8");
          if (/^[\x20-\x7E]*$/.test(str)) return str;
        } catch (_) {}
        return value.toString("hex");
    }
  } catch (_) {
    return value.toString("hex");
  }
}

/**
 * Extract a specific AVP decoded value from a parsed AVPs array.
 */
function getAvp(avps, code) {
  const a = avps.find(av => av.code === code);
  return a ? a.decoded : undefined;
}

// ── TCP/TLS transport ──────────────────────────────────────────────────────────

/**
 * Connect to a Diameter peer over TCP (or TLS) and exchange a single
 * request/answer pair (identified by Hop-by-Hop ID).
 *
 * @param {object} opts
 * @param {string}  opts.host
 * @param {number}  opts.port
 * @param {boolean} opts.useTls
 * @param {boolean} opts.rejectUnauthorized
 * @param {Buffer}  opts.request        - Full encoded Diameter message
 * @param {number}  opts.hopByHopId     - Expected Hop-by-Hop ID in answer
 * @param {number}  opts.timeoutMs
 * @returns {Promise<Buffer>}            - Raw response message
 */
function sendAndReceive(opts) {
  return new Promise((resolve, reject) => {
    const { host, port, useTls, rejectUnauthorized, request, hopByHopId, timeoutMs } = opts;

    let sock;
    let done      = false;
    let buf       = Buffer.alloc(0);
    let timer;

    const MAX_RESPONSE = 4 * 1024 * 1024; // 4 MB cap

    function cleanup(err) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch (_) {}
      if (err) reject(err);
    }

    function tryParse() {
      // Each Diameter message starts with 4 bytes: version(1) + length(3)
      while (buf.length >= 4) {
        const msgLen = (buf[1] << 16) | (buf[2] << 8) | buf[3];
        if (msgLen < 20) {
          cleanup(new Error(`Invalid Diameter message length: ${msgLen}`));
          return;
        }
        if (buf.length < msgLen) break; // incomplete

        const msg = buf.slice(0, msgLen);
        buf = buf.slice(msgLen);

        // Check if this is the answer to our request (matching Hop-by-Hop ID)
        if (msg.length >= 16) {
          const msgHbh = msg.readUInt32BE(12);
          if (msgHbh === hopByHopId) {
            cleanup(null);
            resolve(msg);
            return;
          }
          // Not our answer — silently skip (could be a peer-initiated message)
        }
      }
    }

    const connectOpts = { host, port };
    if (useTls) {
      connectOpts.rejectUnauthorized = rejectUnauthorized !== false;
      connectOpts.servername = host;
    }

    sock = useTls
      ? tls.connect(connectOpts)
      : net.connect({ host, port });

    timer = setTimeout(() => {
      cleanup(new Error(
        `Diameter peer ${host}:${port} did not respond within ${timeoutMs}ms. ` +
        "Check server address, port, and that Diameter is running."
      ));
    }, timeoutMs);

    sock.on("connect", () => {
      sock.write(request, (err) => {
        if (err && !done) cleanup(new Error(`Write failed: ${err.message}`));
      });
    });

    // TLS specific
    sock.on("secureConnect", () => {
      sock.write(request, (err) => {
        if (err && !done) cleanup(new Error(`TLS write failed: ${err.message}`));
      });
    });

    sock.on("data", (chunk) => {
      if (done) return;
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > MAX_RESPONSE) {
        cleanup(new Error(`Response exceeded ${MAX_RESPONSE} byte cap`));
        return;
      }
      tryParse();
    });

    sock.on("end", () => {
      if (!done) cleanup(new Error("Connection closed by peer before complete response received"));
    });

    sock.on("error", (err) => {
      if (!done) cleanup(new Error(`Socket error: ${err.message}. Peer: ${host}:${port}`));
    });

    sock.on("close", () => {
      if (!done) cleanup(new Error("Socket closed unexpectedly"));
    });
  });
}

// ── Guard helpers ──────────────────────────────────────────────────────────────

function requireString(val, name) {
  if (typeof val !== "string" || val.length === 0)
    throw new Error(`${name} must be a non-empty string`);
  if (val.includes("\0"))
    throw new Error(`${name} must not contain NUL bytes`);
}

function clampInt(val, def, min, max, name) {
  if (val === undefined || val === null) return def;
  const n = Number(val);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  if (n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return Math.round(n);
}

function defaultString(val, def) {
  return (typeof val === "string" && val.length > 0) ? val : def;
}

// ── Operations ─────────────────────────────────────────────────────────────────

/**
 * Capabilities Exchange (CER/CEA) — RFC 6733 §5.3
 * Sends a Capabilities-Exchange-Request and parses the answer.
 * Used to establish a Diameter peer relationship and discover server capabilities.
 */
async function opCapabilitiesExchange(args) {
  requireString(args.host,         "host");
  requireString(args.origin_host,  "origin_host");
  requireString(args.origin_realm, "origin_realm");

  const host             = args.host.trim();
  const port             = clampInt(args.port, 3868, 1, 65535, "port");
  const timeoutMs        = clampInt(args.timeout, 10000, 1000, 60000, "timeout");
  const useTls           = !!args.use_tls;
  const rejectUnauth     = args.reject_unauthorized !== false;
  const originHost       = args.origin_host;
  const originRealm      = args.origin_realm;
  const originIp         = defaultString(args.origin_ip, "127.0.0.1");
  const vendorId         = clampInt(args.vendor_id, 0, 0, 0xFFFFFFFF, "vendor_id");
  const productName      = defaultString(args.product_name, "mcp-common-server");
  const firmwareRevision = clampInt(args.firmware_revision, 1, 0, 0xFFFFFFFF, "firmware_revision");

  // Auth-Application-Id list: default to BASE (0) + relay
  const authAppIds = Array.isArray(args.auth_app_ids)
    ? args.auth_app_ids.map(Number)
    : [APP_ID.BASE, APP_ID.NASREQ];

  const avps = [];
  // Origin-Host (mandatory)
  avps.push(encodeAvpUtf8(AVP.ORIGIN_HOST, originHost));
  // Origin-Realm (mandatory)
  avps.push(encodeAvpUtf8(AVP.ORIGIN_REALM, originRealm));
  // Host-IP-Address (mandatory, one or more)
  avps.push(encodeAvpAddress(AVP.HOST_IP_ADDRESS, originIp));
  // Vendor-Id (mandatory)
  avps.push(encodeAvpUint32(AVP.VENDOR_ID, vendorId));
  // Product-Name (mandatory)
  avps.push(encodeAvpUtf8(AVP.PRODUCT_NAME, productName));
  // Auth-Application-Id (one per supported app)
  for (const appId of authAppIds) {
    avps.push(encodeAvpUint32(AVP.AUTH_APPLICATION_ID, appId));
  }
  // Inband-Security-Id: 0 = NO_INBAND_SECURITY
  avps.push(encodeAvpUint32(AVP.INBAND_SECURITY_ID, 0));
  // Firmware-Revision (optional but common)
  avps.push(encodeAvpUint32(AVP.FIRMWARE_REVISION, firmwareRevision));
  // Origin-State-Id
  avps.push(encodeAvpUint32(AVP.ORIGIN_STATE_ID, Math.floor(Date.now() / 1000)));

  const { buf: request, hopByHopId, endToEndId } = buildMessage({
    commandCode: CMD.CAPABILITIES_EXCHANGE,
    appId:       APP_ID.BASE,
    isRequest:   true,
    avps,
  });

  const t0 = Date.now();
  const rawResp = await sendAndReceive({ host, port, useTls, rejectUnauthorized: rejectUnauth, request, hopByHopId, timeoutMs });
  const elapsedMs = Date.now() - t0;

  const parsed = parseMessage(rawResp);
  const resultCode = getAvp(parsed.avps, AVP.RESULT_CODE);
  const peerHost   = getAvp(parsed.avps, AVP.ORIGIN_HOST);
  const peerRealm  = getAvp(parsed.avps, AVP.ORIGIN_REALM);
  const peerProduct = getAvp(parsed.avps, AVP.PRODUCT_NAME);
  const peerVendorId = getAvp(parsed.avps, AVP.VENDOR_ID);
  const peerFirmware = getAvp(parsed.avps, AVP.FIRMWARE_REVISION);
  const errorMsg   = getAvp(parsed.avps, AVP.ERROR_MESSAGE);

  // Collect peer's supported application IDs
  const peerAuthApps = parsed.avps.filter(a => a.code === AVP.AUTH_APPLICATION_ID).map(a => a.decoded);
  const peerAcctApps = parsed.avps.filter(a => a.code === AVP.ACCT_APPLICATION_ID).map(a => a.decoded);

  return {
    ok:              resultCode === RESULT_CODE.SUCCESS,
    operation:       "capabilities_exchange",
    resultCode,
    resultCodeName:  resultCode != null ? (RESULT_CODE_NAMES[resultCode] || `result_${resultCode}`) : null,
    commandCode:     parsed.commandCode,
    hopByHopId,
    endToEndId,
    elapsedMs,
    host,
    port,
    peer: {
      originHost:      peerHost,
      originRealm:     peerRealm,
      productName:     peerProduct,
      vendorId:        peerVendorId,
      firmwareRevision: peerFirmware,
      authApplicationIds: peerAuthApps,
      acctApplicationIds: peerAcctApps,
    },
    ...(errorMsg ? { errorMessage: errorMsg } : {}),
    avpCount: parsed.avps.length,
  };
}

/**
 * Device-Watchdog (DWR/DWA) — RFC 6733 §5.5
 * Sends a Device-Watchdog-Request and measures round-trip latency.
 */
async function opDeviceWatchdog(args) {
  requireString(args.host,         "host");
  requireString(args.origin_host,  "origin_host");
  requireString(args.origin_realm, "origin_realm");

  const host         = args.host.trim();
  const port         = clampInt(args.port, 3868, 1, 65535, "port");
  const timeoutMs    = clampInt(args.timeout, 10000, 1000, 60000, "timeout");
  const useTls       = !!args.use_tls;
  const rejectUnauth = args.reject_unauthorized !== false;
  const originHost   = args.origin_host;
  const originRealm  = args.origin_realm;

  const avps = [
    encodeAvpUtf8(AVP.ORIGIN_HOST, originHost),
    encodeAvpUtf8(AVP.ORIGIN_REALM, originRealm),
    encodeAvpUint32(AVP.ORIGIN_STATE_ID, Math.floor(Date.now() / 1000)),
  ];

  const { buf: request, hopByHopId, endToEndId } = buildMessage({
    commandCode: CMD.WATCHDOG,
    appId:       APP_ID.BASE,
    isRequest:   true,
    avps,
  });

  const t0 = Date.now();
  const rawResp = await sendAndReceive({ host, port, useTls, rejectUnauthorized: rejectUnauth, request, hopByHopId, timeoutMs });
  const elapsedMs = Date.now() - t0;

  const parsed = parseMessage(rawResp);
  const resultCode = getAvp(parsed.avps, AVP.RESULT_CODE);
  const peerHost   = getAvp(parsed.avps, AVP.ORIGIN_HOST);
  const errorMsg   = getAvp(parsed.avps, AVP.ERROR_MESSAGE);

  return {
    ok:             resultCode === RESULT_CODE.SUCCESS,
    operation:      "device_watchdog",
    resultCode,
    resultCodeName: resultCode != null ? (RESULT_CODE_NAMES[resultCode] || `result_${resultCode}`) : null,
    hopByHopId,
    endToEndId,
    elapsedMs,
    host,
    port,
    peerHost,
    ...(errorMsg ? { errorMessage: errorMsg } : {}),
  };
}

/**
 * Disconnect-Peer (DPR/DPA) — RFC 6733 §5.4
 * Sends a Disconnect-Peer-Request and gracefully terminates the peer connection.
 */
async function opDisconnectPeer(args) {
  requireString(args.host,         "host");
  requireString(args.origin_host,  "origin_host");
  requireString(args.origin_realm, "origin_realm");

  const host         = args.host.trim();
  const port         = clampInt(args.port, 3868, 1, 65535, "port");
  const timeoutMs    = clampInt(args.timeout, 10000, 1000, 30000, "timeout");
  const useTls       = !!args.use_tls;
  const rejectUnauth = args.reject_unauthorized !== false;
  const originHost   = args.origin_host;
  const originRealm  = args.origin_realm;
  const causeName    = (args.disconnect_cause || "rebooting").toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(DISCONNECT_CAUSE, causeName)) {
    throw new Error(`disconnect_cause must be one of: ${Object.keys(DISCONNECT_CAUSE).join(", ")}`);
  }
  const cause = DISCONNECT_CAUSE[causeName];

  const avps = [
    encodeAvpUtf8(AVP.ORIGIN_HOST, originHost),
    encodeAvpUtf8(AVP.ORIGIN_REALM, originRealm),
    encodeAvpUint32(AVP.DISCONNECT_CAUSE, cause),
  ];

  const { buf: request, hopByHopId, endToEndId } = buildMessage({
    commandCode: CMD.DISCONNECT_PEER,
    appId:       APP_ID.BASE,
    isRequest:   true,
    avps,
  });

  const t0 = Date.now();
  const rawResp = await sendAndReceive({ host, port, useTls, rejectUnauthorized: rejectUnauth, request, hopByHopId, timeoutMs });
  const elapsedMs = Date.now() - t0;

  const parsed = parseMessage(rawResp);
  const resultCode = getAvp(parsed.avps, AVP.RESULT_CODE);
  const errorMsg   = getAvp(parsed.avps, AVP.ERROR_MESSAGE);

  return {
    ok:             resultCode === RESULT_CODE.SUCCESS,
    operation:      "disconnect_peer",
    resultCode,
    resultCodeName: resultCode != null ? (RESULT_CODE_NAMES[resultCode] || `result_${resultCode}`) : null,
    disconnectCause: causeName,
    hopByHopId,
    endToEndId,
    elapsedMs,
    host,
    port,
    ...(errorMsg ? { errorMessage: errorMsg } : {}),
  };
}

/**
 * Send-Request — Send any Diameter request and receive the answer.
 * Allows testing arbitrary Diameter command codes and applications.
 */
async function opSendRequest(args) {
  requireString(args.host,         "host");
  requireString(args.origin_host,  "origin_host");
  requireString(args.origin_realm, "origin_realm");

  const host         = args.host.trim();
  const port         = clampInt(args.port, 3868, 1, 65535, "port");
  const timeoutMs    = clampInt(args.timeout, 10000, 1000, 60000, "timeout");
  const useTls       = !!args.use_tls;
  const rejectUnauth = args.reject_unauthorized !== false;
  const originHost   = args.origin_host;
  const originRealm  = args.origin_realm;
  const commandCode  = clampInt(args.command_code, CMD.CAPABILITIES_EXCHANGE, 0, 0xFFFFFF, "command_code");
  const appId        = clampInt(args.application_id, APP_ID.BASE, 0, 0xFFFFFFFF, "application_id");
  const destHost     = defaultString(args.destination_host, "");
  const destRealm    = defaultString(args.destination_realm, "");
  const sessionId    = defaultString(args.session_id, `${originHost};${Date.now()};${Math.floor(Math.random() * 0xFFFF)}`);
  const userName     = defaultString(args.user_name, "");

  // Build a Session-Id based on RFC 6733 §8.8
  const avps = [];
  // Session-Id is usually first
  avps.push(encodeAvpUtf8(AVP.SESSION_ID, sessionId));
  avps.push(encodeAvpUtf8(AVP.ORIGIN_HOST, originHost));
  avps.push(encodeAvpUtf8(AVP.ORIGIN_REALM, originRealm));
  if (destHost)  avps.push(encodeAvpUtf8(AVP.DESTINATION_HOST, destHost));
  if (destRealm) avps.push(encodeAvpUtf8(AVP.DESTINATION_REALM, destRealm));
  if (userName)  avps.push(encodeAvpUtf8(AVP.USER_NAME, userName));
  avps.push(encodeAvpUint32(AVP.AUTH_APPLICATION_ID, appId));
  avps.push(encodeAvpUint32(AVP.AUTH_SESSION_STATE, 1)); // NO_STATE_MAINTAINED

  // Caller can pass extra AVPs as [{code, value_hex, mandatory, vendor_id}]
  if (Array.isArray(args.extra_avps)) {
    for (const ea of args.extra_avps) {
      if (!ea || typeof ea.code !== "number") continue;
      let val;
      if (ea.value_hex) {
        val = Buffer.from(ea.value_hex.replace(/\s/g, ""), "hex");
      } else if (typeof ea.value_string === "string") {
        val = Buffer.from(ea.value_string, "utf8");
      } else if (typeof ea.value_uint32 === "number") {
        val = Buffer.alloc(4);
        val.writeUInt32BE(ea.value_uint32 >>> 0, 0);
      } else {
        continue;
      }
      avps.push(encodeAvp(ea.code, val, {
        mandatory: ea.mandatory !== false,
        vendorId:  ea.vendor_id || 0,
      }));
    }
  }

  const { buf: request, hopByHopId, endToEndId } = buildMessage({
    commandCode,
    appId,
    isRequest: true,
    avps,
  });

  const t0 = Date.now();
  const rawResp = await sendAndReceive({ host, port, useTls, rejectUnauthorized: rejectUnauth, request, hopByHopId, timeoutMs });
  const elapsedMs = Date.now() - t0;

  const parsed = parseMessage(rawResp);
  const resultCode = getAvp(parsed.avps, AVP.RESULT_CODE);
  const errorMsg   = getAvp(parsed.avps, AVP.ERROR_MESSAGE);
  const peerHost   = getAvp(parsed.avps, AVP.ORIGIN_HOST);
  const peerRealm  = getAvp(parsed.avps, AVP.ORIGIN_REALM);

  // Return all decoded AVPs
  const decodedAvps = parsed.avps.map(a => ({
    code:    a.code,
    name:    a.name,
    decoded: a.decoded,
    hex:     a.value ? a.value.toString("hex") : null,
  }));

  return {
    ok:             resultCode === RESULT_CODE.SUCCESS || resultCode === RESULT_CODE.LIMITED_SUCCESS,
    operation:      "send_request",
    commandCode:    parsed.commandCode,
    applicationId:  parsed.appId,
    resultCode,
    resultCodeName: resultCode != null ? (RESULT_CODE_NAMES[resultCode] || `result_${resultCode}`) : null,
    isError:        parsed.isError,
    hopByHopId,
    endToEndId,
    sessionId,
    elapsedMs,
    host,
    port,
    peerHost,
    peerRealm,
    avpCount: parsed.avps.length,
    avps:     decodedAvps,
    ...(errorMsg ? { errorMessage: errorMsg } : {}),
  };
}

/** Return protocol/AVP/config info table — no I/O */
function opInfo() {
  return {
    protocol:    "Diameter (RFC 6733, successor to RADIUS)",
    rfcs:        ["RFC 6733 (Base)", "RFC 4006 (Credit-Control)", "RFC 4072 (EAP)", "RFC 7683 (DOIC)"],
    defaultPorts: { tcp: 3868, tls: 5658 },
    operations: [
      { op: "capabilities_exchange", description: "CER/CEA handshake — discover peer capabilities" },
      { op: "device_watchdog",       description: "DWR/DWA — keepalive / round-trip latency" },
      { op: "disconnect_peer",       description: "DPR/DPA — graceful disconnect" },
      { op: "send_request",          description: "Send any Diameter request and receive answer" },
      { op: "info",                  description: "Return protocol/config table (no I/O)" },
    ],
    applicationIds: Object.entries(APP_ID).map(([k, v]) => ({ name: k, id: v })),
    commandCodes:   Object.entries(CMD).map(([k, v]) => ({ name: k, code: v })),
    resultCodes:    Object.entries(RESULT_CODE).map(([k, v]) => ({ name: k, code: v })),
    disconnectCauses: Object.entries(DISCONNECT_CAUSE).map(([k, v]) => ({ name: k, value: v })),
    commonAvps:    Object.entries(AVP).map(([k, v]) => ({ name: k, code: v })),
    transport:     "TCP (plain) or TLS",
    headerSize:    "20 bytes (version:1, length:3, flags:1, command:3, app-id:4, hbh-id:4, e2e-id:4)",
    avpFormat:     "code:4 flags:1 length:3 [vendor-id:4] value:N padded-to-4-bytes",
    notes: [
      "Diameter supersedes RADIUS with reliable TCP transport, TLS support, and structured AVP encoding.",
      "Used in LTE/4G/5G (S6a, Gx, Gy, Cx), IMS, and enterprise AAA.",
      "CER/CEA must be exchanged before any application-level messages.",
    ],
  };
}

// ── Main entry point ───────────────────────────────────────────────────────────

async function diameterClient(args) {
  const operation = (args.operation || "").toLowerCase();
  switch (operation) {
    case "capabilities_exchange": return opCapabilitiesExchange(args);
    case "device_watchdog":       return opDeviceWatchdog(args);
    case "disconnect_peer":       return opDisconnectPeer(args);
    case "send_request":          return opSendRequest(args);
    case "info":                  return opInfo();
    default:
      throw new Error(
        `Unknown diameter_client operation: '${operation}'. ` +
        "Valid: capabilities_exchange, device_watchdog, disconnect_peer, send_request, info"
      );
  }
}

module.exports = { diameterClient, buildMessage, parseMessage, encodeAvp, encodeAvpUtf8, encodeAvpUint32, encodeAvpAddress, parseAvps, decodeAvpValue, getAvp, expandIPv6, CMD, AVP, APP_ID, FLAG, AVP_FLAG, RESULT_CODE, RESULT_CODE_NAMES, DISCONNECT_CAUSE, AVP_META, AVP_TYPE };
