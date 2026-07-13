"use strict";
/**
 * radius_client — Zero-dependency RADIUS client (pure Node.js dgram/crypto built-ins; no npm deps)
 *
 * RFC 2865  – Remote Authentication Dial In User Service (RADIUS)
 * RFC 2866  – RADIUS Accounting
 * RFC 2868  – RADIUS Tunnel attributes
 * RFC 5176  – Dynamic Authorization Extensions (CoA/Disconnect)
 *
 * Operations:
 *   authenticate – Access-Request → Access-Accept / Access-Reject / Access-Challenge
 *   accounting   – Accounting-Request → Accounting-Response
 *   status       – Status-Server (RFC 5997) → response (server health check)
 *   info         – Return protocol/attribute/config table (no I/O)
 *
 * Auth methods supported:
 *   PAP   – User-Password attribute, XOR-encrypted with MD5(secret + authenticator)
 *   CHAP  – CHAP-Password attribute, MD5(chapId + password + authenticator)
 *
 * Transport:
 *   UDP (default port 1812 auth, 1813 accounting)
 *   Retransmit up to 3 times on timeout (RFC 2865 §2)
 */

const dgram  = require("dgram");
const crypto = require("crypto");

// ── constants ──────────────────────────────────────────────────────────────────
const RADIUS_CODE = {
  ACCESS_REQUEST:    1,
  ACCESS_ACCEPT:     2,
  ACCESS_REJECT:     3,
  ACCOUNTING_REQUEST: 4,
  ACCOUNTING_RESPONSE: 5,
  ACCESS_CHALLENGE:  11,
  STATUS_SERVER:     12,
  STATUS_CLIENT:     13,
  DISCONNECT_REQUEST: 40,
  DISCONNECT_ACK:    41,
  DISCONNECT_NAK:    42,
  COA_REQUEST:       43,
  COA_ACK:           44,
  COA_NAK:           45,
};

const CODE_NAMES = {};
for (const [k, v] of Object.entries(RADIUS_CODE)) CODE_NAMES[v] = k;

// RFC 2865 §5 attribute types (subset — most common)
const ATTR = {
  USER_NAME:              1,
  USER_PASSWORD:          2,
  CHAP_PASSWORD:          3,
  NAS_IP_ADDRESS:         4,
  NAS_PORT:               5,
  SERVICE_TYPE:           6,
  FRAMED_PROTOCOL:        7,
  FRAMED_IP_ADDRESS:      8,
  FRAMED_IP_NETMASK:      9,
  REPLY_MESSAGE:          18,
  CALLBACK_NUMBER:        19,
  FRAMED_ROUTE:           22,
  STATE:                  24,
  CLASS:                  25,
  VENDOR_SPECIFIC:        26,
  SESSION_TIMEOUT:        27,
  IDLE_TIMEOUT:           28,
  TERMINATION_ACTION:     29,
  CALLED_STATION_ID:      30,
  CALLING_STATION_ID:     31,
  NAS_IDENTIFIER:         32,
  PROXY_STATE:            33,
  ACCT_STATUS_TYPE:       40,
  ACCT_DELAY_TIME:        41,
  ACCT_INPUT_OCTETS:      42,
  ACCT_OUTPUT_OCTETS:     43,
  ACCT_SESSION_ID:        44,
  ACCT_AUTHENTIC:         45,
  ACCT_SESSION_TIME:      46,
  ACCT_INPUT_PACKETS:     47,
  ACCT_OUTPUT_PACKETS:    48,
  ACCT_TERMINATE_CAUSE:   49,
  ACCT_MULTI_SESSION_ID:  50,
  ACCT_LINK_COUNT:        51,
  CHAP_CHALLENGE:         60,
  NAS_PORT_TYPE:          61,
  PORT_LIMIT:             62,
  ACCT_INTERIM_INTERVAL:  85,
  ACCT_TUNNEL_PACKETS_LOST: 86,
  NAS_PORT_ID:            87,
  FRAMED_POOL:            88,
  NAS_IPV6_ADDRESS:       95,
  EVENT_TIMESTAMP:        55,
  MESSAGE_AUTHENTICATOR:  80,
};

const ATTR_NAMES = {};
for (const [k, v] of Object.entries(ATTR)) ATTR_NAMES[v] = k;

// Accounting-Status-Type values
const ACCT_STATUS = {
  start:     1,
  stop:      2,
  interim:   3,
  "on":      7,
  "off":     8,
};

// NAS-Port-Type values
const NAS_PORT_TYPE = {
  async: 0, sync: 1, isdn: 2, isdn_v120: 3, isdn_v110: 4,
  virtual: 5, piafs: 6, hdlc: 7, x25: 8, x75: 9, g3_fax: 10,
  sdsl: 11, adsl_cap: 12, adsl_dmt: 13, idsl: 14, ethernet: 15,
  xdsl: 16, cable: 17, wireless_other: 18, wireless_802_11: 19,
};

// ── utilities ──────────────────────────────────────────────────────────────────

/** Generate a 16-byte cryptographically random request authenticator */
function randomAuthenticator() {
  return crypto.randomBytes(16);
}

/**
 * Encrypt User-Password per RFC 2865 §5.2
 * Pads password to multiple of 16 bytes, XORs each block with MD5(secret + prev_block)
 */
function encryptPassword(password, secret, authenticator) {
  const passBuf = Buffer.from(password, "utf8");
  // Pad to multiple of 16
  const padLen = Math.ceil(Math.max(passBuf.length, 1) / 16) * 16;
  const padded = Buffer.alloc(padLen, 0);
  passBuf.copy(padded);

  const secretBuf = Buffer.from(secret, "utf8");
  const result    = Buffer.alloc(padLen);
  let prev = authenticator; // first block: MD5(secret + Request-Authenticator)

  for (let i = 0; i < padLen; i += 16) {
    const hash = crypto.createHash("md5")
      .update(secretBuf)
      .update(prev)
      .digest();
    for (let j = 0; j < 16; j++) {
      result[i + j] = padded[i + j] ^ hash[j];
    }
    prev = result.slice(i, i + 16);
  }
  return result;
}

/**
 * Build CHAP-Password attribute value (RFC 2865 §5.3)
 * MD5(chapId + password + challenge)
 */
function buildChapPassword(chapId, password, challenge) {
  const id  = Buffer.from([chapId]);
  const pwd = Buffer.from(password, "utf8");
  const hash = crypto.createHash("md5")
    .update(id)
    .update(pwd)
    .update(challenge)
    .digest();
  return Buffer.concat([id, hash]); // 17 bytes: 1 id + 16 hash
}

/**
 * Encode a single RADIUS attribute
 * @param {number} type  - Attribute type (1-255)
 * @param {Buffer|string|number} value
 * @returns {Buffer}
 */
function encodeAttr(type, value) {
  let val;
  if (Buffer.isBuffer(value)) {
    val = value;
  } else if (typeof value === "number") {
    val = Buffer.alloc(4);
    val.writeUInt32BE(value, 0);
  } else {
    val = Buffer.from(String(value), "utf8");
  }
  if (val.length > 253) val = val.slice(0, 253); // RFC 2865 §3 max attr value 253
  const buf = Buffer.alloc(2 + val.length);
  buf[0] = type;
  buf[1] = 2 + val.length;
  val.copy(buf, 2);
  return buf;
}

/**
 * Encode an IPv4 address string to 4-byte Buffer
 */
function encodeIPv4(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) {
    throw new Error(`Invalid IPv4 address: ${ip}`);
  }
  return Buffer.from(parts);
}

/**
 * Build a full RADIUS packet
 * @param {number} code        - Packet code
 * @param {number} identifier  - 0-255
 * @param {Buffer} authenticator - 16 bytes
 * @param {Buffer[]} attrs     - Encoded attribute buffers
 * @returns {Buffer}
 */
function buildPacket(code, identifier, authenticator, attrs) {
  const attrBuf = Buffer.concat(attrs);
  const length  = 20 + attrBuf.length;
  if (length > 4096) throw new Error(`RADIUS packet too large: ${length} bytes (max 4096)`);
  const pkt = Buffer.alloc(length);
  pkt[0] = code;
  pkt[1] = identifier;
  pkt.writeUInt16BE(length, 2);
  authenticator.copy(pkt, 4);
  attrBuf.copy(pkt, 20);
  return pkt;
}

/**
 * Compute the Response-Authenticator for Accounting-Request
 * MD5(Code + Identifier + Length + 16-zero-bytes + Attributes + Secret)
 * RFC 2866 §3
 */
function computeAcctAuthenticator(pkt, secret) {
  const secretBuf = Buffer.from(secret, "utf8");
  return crypto.createHash("md5")
    .update(pkt)
    .update(secretBuf)
    .digest();
}

/**
 * Verify the response authenticator from server
 * MD5(Code + Identifier + Length + RequestAuth + Attributes + Secret)
 */
function verifyResponseAuthenticator(response, requestAuth, secret) {
  if (response.length < 20) return false;
  const copy = Buffer.from(response);
  requestAuth.copy(copy, 4); // replace response auth with request auth
  const secretBuf = Buffer.from(secret, "utf8");
  const expected = crypto.createHash("md5")
    .update(copy)
    .update(secretBuf)
    .digest();
  return response.slice(4, 20).equals(expected);
}

/**
 * Parse a RADIUS response packet into a structured object
 */
function parseResponse(buf) {
  if (buf.length < 20) throw new Error("Response too short (< 20 bytes)");
  const code   = buf[0];
  const id     = buf[1];
  const length = buf.readUInt16BE(2);
  const auth   = buf.slice(4, 20);
  const attrs  = [];

  let offset = 20;
  while (offset < length && offset < buf.length) {
    const type  = buf[offset];
    const len   = buf[offset + 1];
    if (len < 2 || offset + len > buf.length) break;
    const value = buf.slice(offset + 2, offset + len);
    attrs.push({ type, length: len, name: ATTR_NAMES[type] || `attr_${type}`, value });
    offset += len;
  }

  return { code, codeName: CODE_NAMES[code] || `code_${code}`, identifier: id, authenticator: auth, attributes: attrs };
}

/**
 * Extract readable attribute values from parsed attrs array
 */
function decodeAttributes(attrs) {
  const out = {};
  for (const attr of attrs) {
    const key = attr.name;
    let decoded;
    // String attrs
    if ([ATTR.USER_NAME, ATTR.REPLY_MESSAGE, ATTR.NAS_IDENTIFIER,
         ATTR.CALLED_STATION_ID, ATTR.CALLING_STATION_ID,
         ATTR.ACCT_SESSION_ID, ATTR.FRAMED_ROUTE, ATTR.FRAMED_POOL,
         ATTR.NAS_PORT_ID, ATTR.CLASS, ATTR.ACCT_MULTI_SESSION_ID].includes(attr.type)) {
      decoded = attr.value.toString("utf8");
    } else if ([ATTR.NAS_IP_ADDRESS, ATTR.FRAMED_IP_ADDRESS, ATTR.FRAMED_IP_NETMASK].includes(attr.type)) {
      // IPv4
      if (attr.value.length === 4) {
        decoded = Array.from(attr.value).join(".");
      } else {
        decoded = attr.value.toString("hex");
      }
    } else if (attr.value.length === 4) {
      // Integer / 32-bit
      decoded = attr.value.readUInt32BE(0);
    } else if (attr.type === ATTR.STATE || attr.type === ATTR.CHAP_CHALLENGE
               || attr.type === ATTR.MESSAGE_AUTHENTICATOR) {
      decoded = attr.value.toString("hex");
    } else {
      decoded = attr.value.toString("utf8").replace(/\0/g, "") || attr.value.toString("hex");
    }
    // Multiple attrs of same type → array
    if (key in out) {
      if (!Array.isArray(out[key])) out[key] = [out[key]];
      out[key].push(decoded);
    } else {
      out[key] = decoded;
    }
  }
  return out;
}

// ── UDP send/receive ───────────────────────────────────────────────────────────

/**
 * Send a RADIUS UDP packet and receive the response.
 * Retransmits up to `retries` times on timeout.
 */
function sendRadiusPacket(server, port, packet, timeoutMs, retries) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket("udp4");
    let attempts = 0;
    let timer;
    let done = false;

    function cleanup() {
      done = true;
      clearTimeout(timer);
      try { sock.close(); } catch (_) {}
    }

    function attempt() {
      attempts++;
      sock.send(packet, 0, packet.length, port, server, (err) => {
        if (err) { cleanup(); return reject(new Error(`UDP send failed: ${err.message}. Server: ${server}:${port}`)); }
      });
      timer = setTimeout(() => {
        if (done) return;
        if (attempts < retries) {
          attempt();
        } else {
          cleanup();
          reject(new Error(
            `RADIUS server ${server}:${port} did not respond after ${retries} attempts (${timeoutMs}ms each). ` +
            "Check server address, port, and that the shared secret is correct."
          ));
        }
      }, timeoutMs);
    }

    sock.on("message", (msg) => {
      if (done) return;
      cleanup();
      resolve(msg);
    });

    sock.on("error", (err) => {
      if (done) return;
      cleanup();
      reject(new Error(`UDP socket error: ${err.message}`));
    });

    attempt();
  });
}

// ── guard helpers ──────────────────────────────────────────────────────────────

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

// ── operations ─────────────────────────────────────────────────────────────────

/**
 * Send an Access-Request and return parsed response
 */
async function opAuthenticate(args) {
  requireString(args.server,   "server");
  requireString(args.secret,   "secret");
  requireString(args.username, "username");

  const server   = args.server.trim();
  const secret   = args.secret;
  const username = args.username;
  const password = args.password || "";
  const authMethod = (args.auth_method || "pap").toLowerCase();
  if (!["pap", "chap"].includes(authMethod))
    throw new Error(`auth_method must be 'pap' or 'chap', got: ${authMethod}`);

  const port    = clampInt(args.port, 1812, 1, 65535, "port");
  const timeout = clampInt(args.timeout, 5000, 1000, 60000, "timeout");
  const retries = clampInt(args.retries, 3, 1, 10, "retries");
  const nasIp   = args.nas_ip || "127.0.0.1";
  const nasPort = clampInt(args.nas_port, 0, 0, 65535, "nas_port");
  const identifier = Math.floor(Math.random() * 256);

  const requestAuth = randomAuthenticator();
  const attrs = [];

  // User-Name (attr 1)
  attrs.push(encodeAttr(ATTR.USER_NAME, username));

  if (authMethod === "pap") {
    // User-Password (attr 2): encrypted per RFC 2865 §5.2
    if (!password) throw new Error("password is required for PAP authentication");
    const encPwd = encryptPassword(password, secret, requestAuth);
    attrs.push(encodeAttr(ATTR.USER_PASSWORD, encPwd));
  } else {
    // CHAP (attr 3)
    if (!password) throw new Error("password is required for CHAP authentication");
    const chapId = Math.floor(Math.random() * 256);
    const chapChallenge = requestAuth; // RFC 2865 uses Request Authenticator as challenge
    const chapPwd = buildChapPassword(chapId, password, chapChallenge);
    attrs.push(encodeAttr(ATTR.CHAP_PASSWORD, chapPwd));
    // CHAP-Challenge (attr 60) — optional when using Request Authenticator
  }

  // NAS-IP-Address (attr 4)
  try { attrs.push(encodeAttr(ATTR.NAS_IP_ADDRESS, encodeIPv4(nasIp))); } catch (_) {}
  // NAS-Port (attr 5)
  if (nasPort > 0) attrs.push(encodeAttr(ATTR.NAS_PORT, nasPort));
  // NAS-Identifier (attr 32)
  if (args.nas_identifier) attrs.push(encodeAttr(ATTR.NAS_IDENTIFIER, String(args.nas_identifier).slice(0, 253)));
  // Called-Station-Id (attr 30)
  if (args.called_station_id) attrs.push(encodeAttr(ATTR.CALLED_STATION_ID, String(args.called_station_id).slice(0, 253)));
  // Calling-Station-Id (attr 31)
  if (args.calling_station_id) attrs.push(encodeAttr(ATTR.CALLING_STATION_ID, String(args.calling_station_id).slice(0, 253)));
  // Service-Type (attr 6) — default 1 = Login
  const serviceType = clampInt(args.service_type, 1, 1, 20, "service_type");
  attrs.push(encodeAttr(ATTR.SERVICE_TYPE, serviceType));

  const packet = buildPacket(RADIUS_CODE.ACCESS_REQUEST, identifier, requestAuth, attrs);
  const t0 = Date.now();
  const rawResp = await sendRadiusPacket(server, port, packet, timeout, retries);
  const elapsedMs = Date.now() - t0;

  const parsed = parseResponse(rawResp);
  if (parsed.identifier !== identifier) {
    throw new Error(`Response identifier mismatch: expected ${identifier}, got ${parsed.identifier}`);
  }
  const authOk = verifyResponseAuthenticator(rawResp, requestAuth, secret);
  const decodedAttrs = decodeAttributes(parsed.attributes);

  return {
    ok:              parsed.code === RADIUS_CODE.ACCESS_ACCEPT,
    result:          parsed.codeName,
    code:            parsed.code,
    identifier,
    elapsedMs,
    authVerified:    authOk,
    server,
    port,
    authMethod,
    username,
    attributes:      decodedAttrs,
    rawAttributeCount: parsed.attributes.length,
    ...(parsed.code === RADIUS_CODE.ACCESS_CHALLENGE && decodedAttrs.STATE
      ? { challenge: true, state: decodedAttrs.STATE }
      : {}),
    ...(decodedAttrs.REPLY_MESSAGE ? { replyMessage: decodedAttrs.REPLY_MESSAGE } : {}),
  };
}

/**
 * Send an Accounting-Request and return parsed response
 */
async function opAccounting(args) {
  requireString(args.server,  "server");
  requireString(args.secret,  "secret");
  requireString(args.username, "username");
  requireString(args.session_id, "session_id");

  const server    = args.server.trim();
  const secret    = args.secret;
  const username  = args.username;
  const sessionId = String(args.session_id);
  const statusTypeName = (args.acct_status_type || "start").toLowerCase();
  const statusType = ACCT_STATUS[statusTypeName];
  if (statusType === undefined)
    throw new Error(`acct_status_type must be one of: ${Object.keys(ACCT_STATUS).join(", ")}`);

  const port    = clampInt(args.port, 1813, 1, 65535, "port");
  const timeout = clampInt(args.timeout, 5000, 1000, 60000, "timeout");
  const retries = clampInt(args.retries, 3, 1, 10, "retries");
  const identifier = Math.floor(Math.random() * 256);

  // Accounting-Request authenticator starts as 16 zeros (RFC 2866 §3)
  const zeroAuth = Buffer.alloc(16, 0);
  const attrs = [];

  attrs.push(encodeAttr(ATTR.USER_NAME, username));
  attrs.push(encodeAttr(ATTR.ACCT_STATUS_TYPE, statusType));
  attrs.push(encodeAttr(ATTR.ACCT_SESSION_ID, sessionId));
  attrs.push(encodeAttr(ATTR.ACCT_DELAY_TIME, clampInt(args.acct_delay_time, 0, 0, 65535, "acct_delay_time")));

  if (args.nas_ip) {
    try { attrs.push(encodeAttr(ATTR.NAS_IP_ADDRESS, encodeIPv4(args.nas_ip))); } catch (_) {}
  }
  if (args.nas_identifier) attrs.push(encodeAttr(ATTR.NAS_IDENTIFIER, String(args.nas_identifier).slice(0, 253)));
  if (args.nas_port !== undefined) attrs.push(encodeAttr(ATTR.NAS_PORT, clampInt(args.nas_port, 0, 0, 65535, "nas_port")));

  // Session-time, I/O octets for stop/interim
  if (statusType === ACCT_STATUS.stop || statusType === ACCT_STATUS.interim) {
    if (args.acct_session_time !== undefined)
      attrs.push(encodeAttr(ATTR.ACCT_SESSION_TIME, clampInt(args.acct_session_time, 0, 0, 0xFFFFFFFF, "acct_session_time")));
    if (args.acct_input_octets !== undefined)
      attrs.push(encodeAttr(ATTR.ACCT_INPUT_OCTETS, clampInt(args.acct_input_octets, 0, 0, 0xFFFFFFFF, "acct_input_octets")));
    if (args.acct_output_octets !== undefined)
      attrs.push(encodeAttr(ATTR.ACCT_OUTPUT_OCTETS, clampInt(args.acct_output_octets, 0, 0, 0xFFFFFFFF, "acct_output_octets")));
    if (args.acct_terminate_cause !== undefined)
      attrs.push(encodeAttr(ATTR.ACCT_TERMINATE_CAUSE, clampInt(args.acct_terminate_cause, 1, 1, 20, "acct_terminate_cause")));
  }

  if (args.called_station_id) attrs.push(encodeAttr(ATTR.CALLED_STATION_ID, String(args.called_station_id).slice(0, 253)));
  if (args.calling_station_id) attrs.push(encodeAttr(ATTR.CALLING_STATION_ID, String(args.calling_station_id).slice(0, 253)));
  if (args.framed_ip_address) {
    try { attrs.push(encodeAttr(ATTR.FRAMED_IP_ADDRESS, encodeIPv4(args.framed_ip_address))); } catch (_) {}
  }

  // Build packet with zero authenticator first, then compute real authenticator
  let packet = buildPacket(RADIUS_CODE.ACCOUNTING_REQUEST, identifier, zeroAuth, attrs);
  const realAuth = computeAcctAuthenticator(packet, secret);
  // Replace bytes 4-19 with computed authenticator
  realAuth.copy(packet, 4);

  const t0 = Date.now();
  const rawResp = await sendRadiusPacket(server, port, packet, timeout, retries);
  const elapsedMs = Date.now() - t0;

  const parsed = parseResponse(rawResp);
  const authOk = verifyResponseAuthenticator(rawResp, realAuth, secret);
  const decodedAttrs = decodeAttributes(parsed.attributes);

  return {
    ok:              parsed.code === RADIUS_CODE.ACCOUNTING_RESPONSE,
    result:          parsed.codeName,
    code:            parsed.code,
    identifier,
    elapsedMs,
    authVerified:    authOk,
    server,
    port,
    username,
    sessionId,
    acctStatusType:  statusTypeName,
    attributes:      decodedAttrs,
  };
}

/**
 * Send a Status-Server packet (RFC 5997) — server health check
 */
async function opStatus(args) {
  requireString(args.server, "server");
  requireString(args.secret, "secret");

  const server  = args.server.trim();
  const secret  = args.secret;
  const port    = clampInt(args.port, 1812, 1, 65535, "port");
  const timeout = clampInt(args.timeout, 5000, 1000, 30000, "timeout");
  const retries = clampInt(args.retries, 2, 1, 10, "retries");
  const identifier = Math.floor(Math.random() * 256);

  const requestAuth = randomAuthenticator();
  const attrs = [];

  // Message-Authenticator is required for Status-Server (RFC 5997 §4)
  // We compute a placeholder; real HMAC-MD5 Message-Authenticator:
  // HMAC-MD5(packet_with_zero_message_auth, secret)
  const placeholderMsgAuth = Buffer.alloc(16, 0);
  attrs.push(encodeAttr(ATTR.MESSAGE_AUTHENTICATOR, placeholderMsgAuth));

  let packet = buildPacket(RADIUS_CODE.STATUS_SERVER, identifier, requestAuth, attrs);

  // Compute real Message-Authenticator = HMAC-MD5(packet, secret)
  const hmac = crypto.createHmac("md5", Buffer.from(secret, "utf8"))
    .update(packet)
    .digest();

  // Find the Message-Authenticator attribute in the packet and overwrite it
  // It starts at byte 20 (first attr) since we only have one attr
  // Type(1) + Length(1) + 16-byte value = bytes 20..37
  hmac.copy(packet, 22); // offset 20 = type, 21 = length, 22..37 = value

  const t0 = Date.now();
  let rawResp;
  try {
    rawResp = await sendRadiusPacket(server, port, packet, timeout, retries);
  } catch (err) {
    return {
      ok:       false,
      result:   "NO_RESPONSE",
      server,
      port,
      error:    err.message,
      elapsedMs: Date.now() - t0,
    };
  }
  const elapsedMs = Date.now() - t0;

  const parsed = parseResponse(rawResp);
  const authOk = verifyResponseAuthenticator(rawResp, requestAuth, secret);
  const decodedAttrs = decodeAttributes(parsed.attributes);

  return {
    ok:           [RADIUS_CODE.ACCESS_ACCEPT, RADIUS_CODE.ACCOUNTING_RESPONSE].includes(parsed.code),
    result:       parsed.codeName,
    code:         parsed.code,
    elapsedMs,
    authVerified: authOk,
    server,
    port,
    attributes:   decodedAttrs,
  };
}

/** Return protocol/attribute/config info table — no I/O */
function opInfo() {
  return {
    protocol:   "RADIUS (Remote Authentication Dial In User Service)",
    rfcs:       ["RFC 2865 (Auth)", "RFC 2866 (Accounting)", "RFC 5997 (Status-Server)"],
    defaultPorts: { authentication: 1812, accounting: 1813 },
    operations: [
      { op: "authenticate", description: "Access-Request → Access-Accept/Reject/Challenge" },
      { op: "accounting",   description: "Accounting-Request → Accounting-Response" },
      { op: "status",       description: "Status-Server (RFC 5997) → server health check" },
      { op: "info",         description: "Return protocol/config table (no I/O)" },
    ],
    authMethods: [
      { method: "pap",  description: "Password Authentication Protocol — User-Password XOR-encrypted with MD5" },
      { method: "chap", description: "Challenge Handshake Auth Protocol — MD5(chapId+password+challenge)" },
    ],
    acctStatusTypes: Object.keys(ACCT_STATUS),
    commonAttributes: Object.entries(ATTR).map(([k, v]) => ({ name: k, type: v })),
    nasPortTypes: Object.keys(NAS_PORT_TYPE),
    transport:  "UDP",
    security:   "Shared Secret + MD5-based authenticator; TLS/RADSEC not implemented",
    maxPacketSize: 4096,
    retransmit: "Up to 3 attempts (configurable)",
  };
}

// ── main entry point ───────────────────────────────────────────────────────────

async function radiusClient(args) {
  const operation = (args.operation || "").toLowerCase();
  switch (operation) {
    case "authenticate": return opAuthenticate(args);
    case "accounting":   return opAccounting(args);
    case "status":       return opStatus(args);
    case "info":         return opInfo();
    default:
      throw new Error(`Unknown radius_client operation: '${operation}'. Valid: authenticate, accounting, status, info`);
  }
}

module.exports = { radiusClient };
