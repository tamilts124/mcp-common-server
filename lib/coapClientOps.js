"use strict";
/**
 * coap_client — Zero-dependency CoAP (Constrained Application Protocol) client.
 * Pure Node.js (dgram built-in; no npm deps).
 *
 * Implements CoAP per RFC 7252 over UDP (IPv4 and IPv6).
 * Supports confirmable (CON) and non-confirmable (NON) messages.
 *
 * Supported operations:
 *   get      — CoAP GET (read a resource)
 *   post     — CoAP POST (create/execute a resource)
 *   put      — CoAP PUT (update a resource)
 *   delete   — CoAP DELETE (delete a resource)
 *   discover — CoAP resource discovery (GET /.well-known/core)
 *   observe  — CoAP GET with Observe option (subscribe to notifications, with timeout)
 *   ping     — CoAP Empty CON message (RFC 7252 §4.2 ping)
 *   info     — Return client config and protocol info (no device I/O)
 *
 * Security:
 *   - NUL-byte guards on host and path
 *   - Timeout clamped 500 ms – 60 s
 *   - Response payload capped at 256 KB
 *   - Port must be 1–65535
 *   - No credentials (CoAP itself is unauthenticated; DTLS is out of scope)
 */

const dgram  = require("dgram");
const crypto = require("crypto");

// ── Constants ─────────────────────────────────────────────────────────────────
const DEFAULT_HOST        = "127.0.0.1";
const DEFAULT_PORT        = 5683;           // Standard CoAP port
const DEFAULT_TIMEOUT     = 5_000;          // ms
const MIN_TIMEOUT         = 500;
const MAX_TIMEOUT         = 60_000;
const MAX_PAYLOAD_BYTES   = 256 * 1024;     // 256 KB response cap
const MAX_RETRANSMIT      = 4;              // RFC 7252 §4.8
const ACK_TIMEOUT_MS      = 2_000;          // RFC 7252 §4.8 ACK_TIMEOUT
const COAP_VERSION        = 1;

// CoAP message types (T field, 2 bits)
const TYPE_CON  = 0;  // Confirmable
const TYPE_NON  = 1;  // Non-confirmable
const TYPE_ACK  = 2;  // Acknowledgement
const TYPE_RST  = 3;  // Reset

const TYPE_NAMES = { 0: "CON", 1: "NON", 2: "ACK", 3: "RST" };

// CoAP method codes (request codes)
const CODE_EMPTY  = 0x00;  // 0.00 Empty
const CODE_GET    = 0x01;  // 0.01
const CODE_POST   = 0x02;  // 0.02
const CODE_PUT    = 0x03;  // 0.03
const CODE_DELETE = 0x04;  // 0.04

// CoAP response code classes
// 2.xx = Success, 4.xx = Client Error, 5.xx = Server Error
const RESPONSE_CODES = {
  // 2.xx Success
  0x41: "2.01 Created",
  0x42: "2.02 Deleted",
  0x43: "2.03 Valid",
  0x44: "2.04 Changed",
  0x45: "2.05 Content",
  // 4.xx Client Error
  0x80: "4.00 Bad Request",
  0x81: "4.01 Unauthorized",
  0x82: "4.02 Bad Option",
  0x83: "4.03 Forbidden",
  0x84: "4.04 Not Found",
  0x85: "4.05 Method Not Allowed",
  0x86: "4.06 Not Acceptable",
  0x8C: "4.12 Precondition Failed",
  0x8D: "4.13 Request Entity Too Large",
  0x8F: "4.15 Unsupported Content-Format",
  // 5.xx Server Error
  0xA0: "5.00 Internal Server Error",
  0xA1: "5.01 Not Implemented",
  0xA2: "5.02 Bad Gateway",
  0xA3: "5.03 Service Unavailable",
  0xA4: "5.04 Gateway Timeout",
  0xA5: "5.05 Proxying Not Supported",
};

// CoAP option numbers (RFC 7252 §12.2)
const OPT_IF_MATCH        = 1;
const OPT_URI_HOST        = 3;
const OPT_ETAG            = 4;
const OPT_IF_NONE_MATCH   = 5;
const OPT_OBSERVE         = 6;   // RFC 7641
const OPT_URI_PORT        = 7;
const OPT_LOCATION_PATH   = 8;
const OPT_URI_PATH        = 11;
const OPT_CONTENT_FORMAT  = 12;
const OPT_MAX_AGE         = 14;
const OPT_URI_QUERY       = 15;
const OPT_ACCEPT          = 17;
const OPT_LOCATION_QUERY  = 20;
const OPT_PROXY_URI       = 35;
const OPT_PROXY_SCHEME    = 39;
const OPT_SIZE1           = 60;

// Content-Format values
const CONTENT_FORMATS = {
  "text/plain":               0,
  "application/link-format":  40,
  "application/xml":          41,
  "application/octet-stream": 42,
  "application/exi":          47,
  "application/json":         50,
  "application/cbor":         60,
};

const CONTENT_FORMAT_NAMES = Object.fromEntries(
  Object.entries(CONTENT_FORMATS).map(([k, v]) => [v, k])
);

// ── Rolling 16-bit message ID ─────────────────────────────────────────────────
let _msgId = Math.floor(Math.random() * 0x10000);
function nextMsgId() {
  _msgId = (_msgId + 1) & 0xFFFF;
  return _msgId;
}

// ── Guards ────────────────────────────────────────────────────────────────────
function guardNul(value, name) {
  if (typeof value === "string" && value.includes("\0"))
    throw new Error(`coap_client: '${name}' must not contain NUL bytes.`);
}

function clampTimeout(t) {
  const n = typeof t === "number" ? t : DEFAULT_TIMEOUT;
  return Math.max(MIN_TIMEOUT, Math.min(MAX_TIMEOUT, Math.trunc(n)));
}

function validatePort(port, def) {
  const p = port ?? def;
  if (!Number.isInteger(p) || p < 1 || p > 65535)
    throw new Error(`coap_client: 'port' must be an integer 1–65535 (got ${p}).`);
  return p;
}

// ── URI parser ────────────────────────────────────────────────────────────────
/**
 * Parse a CoAP URI or a bare path+query string into { host, port, path, query }.
 * Accepts:
 *   coap://host[:port]/path?query
 *   coap://[::1]:5683/path
 *   /path?query   (host/port come from args.host / args.port)
 *   path/segments
 */
function parseCoapUri(uri, defaultHost, defaultPort) {
  if (!uri) return { host: defaultHost, port: defaultPort, pathSegments: [""], queryPairs: [] };

  guardNul(uri, "uri");

  let host = defaultHost;
  let port = defaultPort;
  let pathStr = uri;
  let queryStr = "";

  if (/^coaps?:\/\//i.test(uri)) {
    // Full URI
    let rest = uri.replace(/^coaps?:\/\//i, "");

    // Extract host (handle IPv6 bracket notation)
    if (rest.startsWith("[")) {
      const closeBracket = rest.indexOf("]");
      if (closeBracket === -1) throw new Error("coap_client: malformed IPv6 address in URI.");
      host = rest.slice(1, closeBracket);
      rest = rest.slice(closeBracket + 1);
    } else {
      const slashIdx = rest.search(/[\/\?]/);
      const hostPart = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
      rest = slashIdx === -1 ? "" : rest.slice(slashIdx);
      if (hostPart.includes(":")) {
        const colonIdx = hostPart.lastIndexOf(":");
        host = hostPart.slice(0, colonIdx);
        port = parseInt(hostPart.slice(colonIdx + 1), 10);
      } else {
        host = hostPart;
      }
    }

    // Port after bracket (e.g. [::1]:5683)
    if (rest.startsWith(":")) {
      const slashIdx = rest.search(/[\/\?]/);
      const portStr = slashIdx === -1 ? rest.slice(1) : rest.slice(1, slashIdx);
      port = parseInt(portStr, 10);
      rest = slashIdx === -1 ? "" : rest.slice(slashIdx);
    }

    pathStr = rest || "/";
  }

  // Split path and query
  const qIdx = pathStr.indexOf("?");
  if (qIdx !== -1) {
    queryStr = pathStr.slice(qIdx + 1);
    pathStr  = pathStr.slice(0, qIdx);
  }

  // Normalise path to segments
  const pathSegments = pathStr
    .split("/")
    .filter((s, i) => i > 0 || s !== "")  // drop leading empty from leading slash
    .map(decodePercent);

  if (pathSegments.length === 0) pathSegments.push("");

  const queryPairs = queryStr
    ? queryStr.split("&").map(decodePercent)
    : [];

  guardNul(host, "host");
  return { host, port, pathSegments, queryPairs };
}

function decodePercent(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

// ── Option encoding ───────────────────────────────────────────────────────────
/**
 * Encode a list of { number, value } options into the CoAP option wire format.
 * Options MUST be provided in ascending order by option number.
 * value can be Buffer | number | string.
 */
function encodeOptions(options) {
  // Sort by option number (ascending)
  const sorted = [...options].sort((a, b) => a.number - b.number);
  const parts = [];
  let prevNum = 0;

  for (const opt of sorted) {
    const delta  = opt.number - prevNum;
    prevNum      = opt.number;
    const valBuf = optionValueToBuffer(opt.value);
    const len    = valBuf.length;

    const deltaExt = encodeOptField(delta);
    const lenExt   = encodeOptField(len);

    const headerByte = (deltaExt.nibble << 4) | lenExt.nibble;
    const header     = Buffer.from([headerByte]);

    parts.push(header, deltaExt.ext, lenExt.ext, valBuf);
  }

  return Buffer.concat(parts);
}

function encodeOptField(value) {
  if (value <= 12) {
    return { nibble: value, ext: Buffer.alloc(0) };
  } else if (value <= 268) {
    return { nibble: 13, ext: Buffer.from([value - 13]) };
  } else if (value <= 65804) {
    const ext = Buffer.alloc(2);
    ext.writeUInt16BE(value - 269, 0);
    return { nibble: 14, ext };
  }
  throw new Error(`coap_client: option value ${value} too large to encode.`);
}

function optionValueToBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "number") {
    // Encode as minimal unsigned integer (big-endian)
    if (value === 0) return Buffer.alloc(0);
    if (value <= 0xFF) return Buffer.from([value]);
    if (value <= 0xFFFF) { const b = Buffer.alloc(2); b.writeUInt16BE(value); return b; }
    if (value <= 0xFFFFFF) { const b = Buffer.alloc(3); b.writeUIntBE(value, 0, 3); return b; }
    const b = Buffer.alloc(4); b.writeUInt32BE(value); return b;
  }
  return Buffer.from(String(value), "utf8");
}

// ── Packet builder ────────────────────────────────────────────────────────────
/**
 * Build a CoAP packet:
 *   Byte 0: Ver(2) T(2) TKL(4)
 *   Byte 1: Code
 *   Byte 2-3: Message ID
 *   Bytes 4..(4+TKL-1): Token
 *   Options (delta-encoded TLV)
 *   0xFF marker if payload present
 *   Payload
 */
function buildPacket({ type, code, msgId, token, options, payload }) {
  const tkl      = token ? token.length : 0;
  const byte0    = ((COAP_VERSION & 0x3) << 6) | ((type & 0x3) << 4) | (tkl & 0xF);
  const header   = Buffer.alloc(4);
  header[0]      = byte0;
  header[1]      = code;
  header.writeUInt16BE(msgId, 2);

  const tokenBuf  = token || Buffer.alloc(0);
  const optsBuf   = options && options.length > 0 ? encodeOptions(options) : Buffer.alloc(0);

  const parts = [header, tokenBuf, optsBuf];

  if (payload && payload.length > 0) {
    parts.push(Buffer.from([0xFF]));  // payload marker
    parts.push(payload);
  }

  return Buffer.concat(parts);
}

// ── Packet parser ─────────────────────────────────────────────────────────────
/**
 * Parse a received CoAP packet.
 * Returns { ver, type, typeName, tkl, code, codeStr, msgId, token, options, payload }
 */
function parsePacket(buf) {
  if (buf.length < 4)
    throw new Error(`coap_client: packet too short (${buf.length} bytes; minimum 4).`);

  const byte0   = buf[0];
  const ver     = (byte0 >> 6) & 0x3;
  const type    = (byte0 >> 4) & 0x3;
  const tkl     = byte0 & 0xF;
  const code    = buf[1];
  const msgId   = buf.readUInt16BE(2);

  if (ver !== COAP_VERSION)
    throw new Error(`coap_client: unexpected CoAP version ${ver} (expected ${COAP_VERSION}).`);
  if (tkl > 8)
    throw new Error(`coap_client: invalid TKL ${tkl} (max 8).`);
  if (buf.length < 4 + tkl)
    throw new Error(`coap_client: packet too short for token (need ${4 + tkl}, got ${buf.length}).`);

  const token = buf.slice(4, 4 + tkl);
  let   pos   = 4 + tkl;

  // Decode options
  const options = [];
  let optNum    = 0;

  while (pos < buf.length && buf[pos] !== 0xFF) {
    const optByte  = buf[pos++];
    let   delta    = (optByte >> 4) & 0xF;
    let   optLen   = optByte & 0xF;

    if (delta === 13) {
      if (pos >= buf.length) throw new Error("coap_client: option delta13 truncated.");
      delta = buf[pos++] + 13;
    } else if (delta === 14) {
      if (pos + 1 >= buf.length) throw new Error("coap_client: option delta14 truncated.");
      delta = buf.readUInt16BE(pos) + 269;
      pos += 2;
    } else if (delta === 15) {
      throw new Error("coap_client: option delta 15 is reserved.");
    }

    if (optLen === 13) {
      if (pos >= buf.length) throw new Error("coap_client: option len13 truncated.");
      optLen = buf[pos++] + 13;
    } else if (optLen === 14) {
      if (pos + 1 >= buf.length) throw new Error("coap_client: option len14 truncated.");
      optLen = buf.readUInt16BE(pos) + 269;
      pos += 2;
    } else if (optLen === 15) {
      throw new Error("coap_client: option len 15 is reserved.");
    }

    optNum += delta;
    const optVal = buf.slice(pos, pos + optLen);
    pos += optLen;
    options.push({ number: optNum, value: optVal });
  }

  // Payload (after 0xFF marker)
  let payload = Buffer.alloc(0);
  if (pos < buf.length && buf[pos] === 0xFF) {
    pos++;
    payload = buf.slice(pos);
    if (payload.length === 0)
      throw new Error("coap_client: payload marker present but no payload bytes follow.");
  }

  const codeStr = formatCode(code);

  return { ver, type, typeName: TYPE_NAMES[type] || "?", tkl, code, codeStr, msgId, token, options, payload };
}

function formatCode(code) {
  if (RESPONSE_CODES[code]) return RESPONSE_CODES[code];
  const cls    = (code >> 5) & 0x7;
  const detail = code & 0x1F;
  return `${cls}.${String(detail).padStart(2, "0")}`;
}

// ── Option decoder helpers ────────────────────────────────────────────────────
function optionToString(opt) {
  return opt.value.toString("utf8");
}

function optionToUint(opt) {
  let val = 0;
  for (let i = 0; i < opt.value.length; i++) val = (val * 256) + opt.value[i];
  return val;
}

function decodeResponseOptions(options) {
  const result = {};
  for (const opt of options) {
    switch (opt.number) {
      case OPT_CONTENT_FORMAT:
        result.contentFormat = optionToUint(opt);
        result.contentType   = CONTENT_FORMAT_NAMES[result.contentFormat] || `format:${result.contentFormat}`;
        break;
      case OPT_MAX_AGE:
        result.maxAge = optionToUint(opt);
        break;
      case OPT_ETAG:
        result.etag = opt.value.toString("hex");
        break;
      case OPT_OBSERVE:
        result.observe = optionToUint(opt);
        break;
      case OPT_LOCATION_PATH:
        result.locationPath = (result.locationPath || "") + "/" + optionToString(opt);
        break;
      case OPT_LOCATION_QUERY:
        result.locationQuery = (result.locationQuery ? result.locationQuery + "&" : "") + optionToString(opt);
        break;
      case OPT_URI_HOST:
        result.uriHost = optionToString(opt);
        break;
      case OPT_SIZE1:
        result.size1 = optionToUint(opt);
        break;
    }
  }
  return result;
}

// ── UDP request/response ─────────────────────────────────────────────────────
/**
 * Send a CoAP packet over UDP and receive the response.
 * For CON messages, retransmits per RFC 7252 §4.2.
 * For NON messages, one-shot send with timeout.
 */
function sendCoapRequest(cfg, pkt, expectedMsgId, expectedTokenHex, waitForAck) {
  return new Promise((resolve, reject) => {
    const family = cfg.host.includes(":") ? "udp6" : "udp4";
    const sock   = dgram.createSocket(family);
    let timedOut = false;
    let attempts = 0;
    let retryTimer;
    let masterTimer;

    const cleanup = () => {
      clearTimeout(retryTimer);
      clearTimeout(masterTimer);
      try { sock.close(); } catch (_) {}
    };

    masterTimer = setTimeout(() => {
      timedOut = true;
      cleanup();
      reject(new Error(
        `coap_client: request to ${cfg.host}:${cfg.port} timed out after ${cfg.timeoutMs} ms.`
      ));
    }, cfg.timeoutMs);

    const sendPacket = () => {
      if (timedOut) return;
      attempts++;
      sock.send(pkt, 0, pkt.length, cfg.port, cfg.host, (err) => {
        if (err && !timedOut) {
          cleanup();
          reject(new Error(`coap_client: send error: ${err.message}`));
        }
      });

      // Schedule retransmit for CON messages (exponential back-off)
      if (waitForAck && attempts <= MAX_RETRANSMIT) {
        const backoff = ACK_TIMEOUT_MS * Math.pow(2, attempts - 1);
        retryTimer = setTimeout(sendPacket, backoff);
      }
    };

    sock.on("message", (msg, rinfo) => {
      if (timedOut) return;

      // Parse packet and check token + message ID
      let parsed;
      try {
        parsed = parsePacket(msg);
      } catch (e) {
        // Ignore unparseable packets (could be from other sources)
        return;
      }

      // For CON: we need ACK or RST with matching msgId
      // For NON: we match by token
      const tokenMatch = parsed.token.toString("hex") === expectedTokenHex;
      const idMatch    = parsed.msgId === expectedMsgId;

      if (waitForAck) {
        // Accept ACK (with or without payload - could be separate response)
        if (idMatch && (parsed.type === TYPE_ACK || parsed.type === TYPE_RST)) {
          clearTimeout(retryTimer);
          if (parsed.type === TYPE_RST) {
            cleanup();
            reject(new Error(`coap_client: RST received from ${cfg.host}:${cfg.port} (msg ID ${expectedMsgId}).`));
            return;
          }
          // Empty ACK = separate response will follow (2.00-like)
          if (parsed.code === CODE_EMPTY) {
            // Separate response: wait for CON with matching token
            // Switch to token-matching mode for the rest of the timeout
            clearTimeout(retryTimer);
            return; // continue listening for the separate response
          }
          // Piggybacked response
          cleanup();
          resolve(parsed);
          return;
        }
        // Separate response (CON with matching token)
        if (tokenMatch && parsed.type === TYPE_CON && parsed.code !== CODE_EMPTY) {
          // Send ACK for the separate CON response
          const ack = buildPacket({ type: TYPE_ACK, code: CODE_EMPTY, msgId: parsed.msgId, token: null });
          sock.send(ack, 0, ack.length, cfg.port, cfg.host, () => {});
          cleanup();
          resolve(parsed);
          return;
        }
        // NON separate response with matching token
        if (tokenMatch && parsed.type === TYPE_NON && parsed.code !== CODE_EMPTY) {
          cleanup();
          resolve(parsed);
          return;
        }
      } else {
        // NON request: match by token
        if (tokenMatch && parsed.code !== CODE_EMPTY) {
          cleanup();
          resolve(parsed);
          return;
        }
        // Also accept any response matching msgId for NON
        if (idMatch && parsed.code !== CODE_EMPTY) {
          cleanup();
          resolve(parsed);
          return;
        }
      }
    });

    sock.on("error", (err) => {
      if (timedOut) return;
      cleanup();
      if (err.code === "ENOTFOUND")
        reject(new Error(`coap_client: host not found: '${cfg.host}'.`));
      else if (err.code === "ECONNREFUSED" || err.code === "ECONNRESET")
        reject(new Error(`coap_client: connection refused/reset by ${cfg.host}:${cfg.port}.`));
      else
        reject(new Error(`coap_client: network error: ${err.message}`));
    });

    sendPacket();
  });
}

// ── Config builder ────────────────────────────────────────────────────────────
function buildConfig(args) {
  const host      = (args.host || DEFAULT_HOST).trim();
  const port      = validatePort(args.port, DEFAULT_PORT);
  const timeoutMs = clampTimeout(args.timeout);
  const confirmable = args.confirmable !== false; // default: true (CON)

  guardNul(host, "host");
  return { host, port, timeoutMs, confirmable };
}

// ── Build request options list ────────────────────────────────────────────────
function buildRequestOptions(parsed, args, extraOptions) {
  const { pathSegments, queryPairs, host, port } = parsed;
  const options = [];

  // Uri-Host (if not default)
  if (host !== DEFAULT_HOST) {
    options.push({ number: OPT_URI_HOST, value: host });
  }

  // Uri-Port (if non-standard)
  if (port !== DEFAULT_PORT) {
    options.push({ number: OPT_URI_PORT, value: port });
  }

  // Uri-Path segments
  for (const seg of pathSegments) {
    options.push({ number: OPT_URI_PATH, value: seg });
  }

  // Uri-Query pairs
  for (const q of queryPairs) {
    options.push({ number: OPT_URI_QUERY, value: q });
  }

  // Content-Format
  if (args.content_format !== undefined) {
    const cf = resolveContentFormat(args.content_format);
    options.push({ number: OPT_CONTENT_FORMAT, value: cf });
  }

  // Accept
  if (args.accept !== undefined) {
    const ac = resolveContentFormat(args.accept);
    options.push({ number: OPT_ACCEPT, value: ac });
  }

  // Extra options (e.g. Observe)
  if (extraOptions) {
    for (const opt of extraOptions) options.push(opt);
  }

  return options;
}

function resolveContentFormat(cf) {
  if (typeof cf === "number") return cf;
  const n = CONTENT_FORMATS[String(cf).toLowerCase()];
  if (n !== undefined) return n;
  const asNum = parseInt(cf, 10);
  if (!isNaN(asNum)) return asNum;
  throw new Error(`coap_client: unknown content-format '${cf}'. Use a numeric ID or one of: ${Object.keys(CONTENT_FORMATS).join(", ")}.`);
}

// ── Payload builder ───────────────────────────────────────────────────────────
function buildPayload(args) {
  if (args.payload === undefined || args.payload === null) return null;
  if (Buffer.isBuffer(args.payload)) return args.payload;
  if (typeof args.payload === "string") return Buffer.from(args.payload, "utf8");
  if (typeof args.payload === "object") return Buffer.from(JSON.stringify(args.payload), "utf8");
  return Buffer.from(String(args.payload), "utf8");
}

// ── Response formatter ────────────────────────────────────────────────────────
function formatResponse(parsed, elapsedMs, requestOp) {
  const decodedOpts = decodeResponseOptions(parsed.options);
  const payloadStr  = tryDecodePayload(parsed.payload, decodedOpts.contentFormat);
  const isError     = (parsed.code >> 5) >= 4;

  const result = {
    ok:          !isError,
    operation:   requestOp,
    code:        parsed.codeStr,
    type:        parsed.typeName,
    msgId:       parsed.msgId,
    token:       parsed.token.toString("hex"),
    payload:     payloadStr,
    payloadRaw:  parsed.payload.length > 0 ? parsed.payload.toString("base64") : undefined,
    payloadSize: parsed.payload.length,
    elapsedMs,
    ...decodedOpts,
  };

  if (isError) {
    result.error = `CoAP error response: ${parsed.codeStr}`;
  }

  return result;
}

function tryDecodePayload(payload, contentFormat) {
  if (!payload || payload.length === 0) return null;
  if (payload.length > MAX_PAYLOAD_BYTES) {
    return `[payload truncated: ${payload.length} bytes exceeds ${MAX_PAYLOAD_BYTES} byte cap]`;
  }
  // Try to decode as UTF-8 text for text types or JSON
  if (contentFormat === undefined ||
      contentFormat === 0 ||   // text/plain
      contentFormat === 40 ||  // application/link-format
      contentFormat === 41 ||  // application/xml
      contentFormat === 50) {  // application/json
    const str = payload.toString("utf8");
    // Check if it looks like valid text (no control chars except \r \n \t)
    if (!/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(str)) return str;
  }
  // Return hex for binary
  return `[binary: ${payload.length} bytes, hex: ${payload.slice(0, 64).toString("hex")}${payload.length > 64 ? "..." : ""}]`;
}

// ── Core request executor ─────────────────────────────────────────────────────
async function execCoapRequest(args, methodCode, requestOp, extraOptions, payloadOverride) {
  const cfg     = buildConfig(args);
  const uri     = args.uri || args.path || "/";
  const parsed  = parseCoapUri(uri, cfg.host, cfg.port);

  // Use parsed host/port if they came from a full URI
  const effectiveHost = parsed.host;
  const effectivePort = parsed.port;
  const effectiveCfg  = { ...cfg, host: effectiveHost, port: effectivePort };

  const options = buildRequestOptions(parsed, args, extraOptions);
  const payload = payloadOverride !== undefined ? payloadOverride : buildPayload(args);

  // Generate token (4 bytes random)
  const token    = crypto.randomBytes(4);
  const msgId    = nextMsgId();
  const type     = cfg.confirmable ? TYPE_CON : TYPE_NON;

  const pkt = buildPacket({ type, code: methodCode, msgId, token, options, payload });

  const t0       = Date.now();
  const response = await sendCoapRequest(effectiveCfg, pkt, msgId, token.toString("hex"), cfg.confirmable);
  const elapsed  = Date.now() - t0;

  if (response.payload.length > MAX_PAYLOAD_BYTES) {
    throw new Error(
      `coap_client: response payload too large (${response.payload.length} bytes; cap ${MAX_PAYLOAD_BYTES}).`
    );
  }

  return formatResponse(response, elapsed, requestOp);
}

// ── Operations ────────────────────────────────────────────────────────────────

/** get — CoAP GET */
async function opGet(args) {
  return execCoapRequest(args, CODE_GET, "get");
}

/** post — CoAP POST */
async function opPost(args) {
  return execCoapRequest(args, CODE_POST, "post");
}

/** put — CoAP PUT */
async function opPut(args) {
  return execCoapRequest(args, CODE_PUT, "put");
}

/** delete — CoAP DELETE */
async function opDelete(args) {
  return execCoapRequest(args, CODE_DELETE, "delete");
}

/** discover — CoAP resource discovery via /.well-known/core (RFC 6690) */
async function opDiscover(args) {
  // Always GET /.well-known/core with Accept: application/link-format
  const discoverArgs = {
    ...args,
    uri: `coap://${args.host || DEFAULT_HOST}:${args.port || DEFAULT_PORT}/.well-known/core`,
    accept: 40, // application/link-format
  };

  const result = await execCoapRequest(discoverArgs, CODE_GET, "discover");

  // Parse link-format into structured list
  if (result.payload && typeof result.payload === "string") {
    result.resources = parseLinkFormat(result.payload);
  }

  return result;
}

/**
 * Parse RFC 6690 link-format into an array of { uri, attributes } objects.
 * Format: </path>;attr=val;attr2="val2",</path2>;attr=val
 */
function parseLinkFormat(text) {
  const resources = [];
  const links     = text.split(",");
  for (const link of links) {
    const parts = link.trim().split(";");
    const uriPart = parts[0].trim();
    const uriMatch = uriPart.match(/^<([^>]*)>$/);
    const uri     = uriMatch ? uriMatch[1] : uriPart;
    const attrs   = {};
    for (const attr of parts.slice(1)) {
      const eqIdx = attr.indexOf("=");
      if (eqIdx === -1) {
        attrs[attr.trim()] = true;
      } else {
        const k = attr.slice(0, eqIdx).trim();
        let   v = attr.slice(eqIdx + 1).trim();
        if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
        attrs[k] = v;
      }
    }
    resources.push({ uri, attributes: attrs });
  }
  return resources;
}

/** observe — CoAP Observe (RFC 7641): register, receive N notifications, then deregister */
async function opObserve(args) {
  const cfg         = buildConfig(args);
  const uri         = args.uri || args.path || "/";
  const maxNotifs   = Math.min(Math.max(1, args.max_notifications || 3), 20);
  const parsed      = parseCoapUri(uri, cfg.host, cfg.port);
  const effectiveCfg = { ...cfg, host: parsed.host, port: parsed.port };

  const options = buildRequestOptions(parsed, args, [
    { number: OPT_OBSERVE, value: 0 }, // Register (value=0)
  ]);

  const token  = crypto.randomBytes(4);
  const msgId  = nextMsgId();
  const pkt    = buildPacket({ type: TYPE_CON, code: CODE_GET, msgId, token, options, payload: null });

  const notifications = [];
  const tokenHex      = token.toString("hex");

  const result = await new Promise((resolve, reject) => {
    const family = effectiveCfg.host.includes(":") ? "udp6" : "udp4";
    const sock   = dgram.createSocket(family);
    let timedOut = false;
    let gotFirstAck = false;
    let seqNum = 0;

    const masterTimer = setTimeout(() => {
      timedOut = true;
      // Deregister by sending GET with Observe=1
      try {
        const deregOpts = buildRequestOptions(parsed, args, [
          { number: OPT_OBSERVE, value: 1 }, // Deregister
        ]);
        const deregToken = crypto.randomBytes(4);
        const deregPkt   = buildPacket({ type: TYPE_NON, code: CODE_GET, msgId: nextMsgId(), token: deregToken, options: deregOpts });
        sock.send(deregPkt, 0, deregPkt.length, effectiveCfg.port, effectiveCfg.host, () => {});
      } catch (_) {}
      try { sock.close(); } catch (_) {}
      resolve(notifications);
    }, effectiveCfg.timeoutMs);

    sock.on("message", (msg, rinfo) => {
      if (timedOut) return;
      let resp;
      try { resp = parsePacket(msg); } catch { return; }

      const isOurToken = resp.token.toString("hex") === tokenHex;
      const isAckForUs = resp.type === TYPE_ACK && resp.msgId === msgId;

      if (isAckForUs && !gotFirstAck) {
        gotFirstAck = true;
        if (resp.code === CODE_EMPTY) return; // separate response forthcoming
      }

      if (!isOurToken) return;
      if (resp.code === CODE_EMPTY) return;

      // ACK the CON notifications
      if (resp.type === TYPE_CON) {
        const ack = buildPacket({ type: TYPE_ACK, code: CODE_EMPTY, msgId: resp.msgId, token: null });
        sock.send(ack, 0, ack.length, effectiveCfg.port, effectiveCfg.host, () => {});
      }

      const decodedOpts = decodeResponseOptions(resp.options);
      const payloadStr  = tryDecodePayload(resp.payload, decodedOpts.contentFormat);

      notifications.push({
        seq:         seqNum++,
        code:        resp.codeStr,
        type:        resp.typeName,
        observe:     decodedOpts.observe,
        payload:     payloadStr,
        payloadSize: resp.payload.length,
        contentType: decodedOpts.contentType,
        elapsedMs:   Date.now(),
      });

      if (notifications.length >= maxNotifs) {
        clearTimeout(masterTimer);
        timedOut = true;
        // Deregister
        try {
          const deregOpts = buildRequestOptions(parsed, args, [
            { number: OPT_OBSERVE, value: 1 },
          ]);
          const deregToken = crypto.randomBytes(4);
          const deregPkt   = buildPacket({ type: TYPE_NON, code: CODE_GET, msgId: nextMsgId(), token: deregToken, options: deregOpts });
          sock.send(deregPkt, 0, deregPkt.length, effectiveCfg.port, effectiveCfg.host, () => {});
        } catch (_) {}
        try { sock.close(); } catch (_) {}
        resolve(notifications);
      }
    });

    sock.on("error", (err) => {
      if (timedOut) return;
      clearTimeout(masterTimer);
      timedOut = true;
      try { sock.close(); } catch (_) {}
      reject(new Error(`coap_client: observe network error: ${err.message}`));
    });

    // Send observe registration
    sock.send(pkt, 0, pkt.length, effectiveCfg.port, effectiveCfg.host, (err) => {
      if (err && !timedOut) {
        clearTimeout(masterTimer);
        try { sock.close(); } catch (_) {}
        reject(new Error(`coap_client: observe send error: ${err.message}`));
      }
    });
  });

  // Convert absolute timestamps to relative elapsedMs from first notification
  const t0 = result.length > 0 ? result[0].elapsedMs : Date.now();
  for (const n of result) n.elapsedMs = n.elapsedMs - t0;

  return {
    ok:             true,
    operation:      "observe",
    host:           effectiveCfg.host,
    port:           effectiveCfg.port,
    uri,
    notifications:  result,
    count:          result.length,
    maxRequested:   maxNotifs,
    timeoutMs:      effectiveCfg.timeoutMs,
  };
}

/** ping — CoAP Empty CON (RFC 7252 §4.2): device must reply with RST or ACK */
async function opPing(args) {
  const cfg    = buildConfig(args);
  const token  = Buffer.alloc(0);
  const msgId  = nextMsgId();
  const pkt    = buildPacket({ type: TYPE_CON, code: CODE_EMPTY, msgId, token: null, options: [] });

  const t0 = Date.now();

  const result = await new Promise((resolve, reject) => {
    const family = cfg.host.includes(":") ? "udp6" : "udp4";
    const sock   = dgram.createSocket(family);
    let done     = false;

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { sock.close(); } catch (_) {}
      reject(new Error(`coap_client: ping to ${cfg.host}:${cfg.port} timed out after ${cfg.timeoutMs} ms.`));
    }, cfg.timeoutMs);

    sock.on("message", (msg) => {
      if (done) return;
      let resp;
      try { resp = parsePacket(msg); } catch { return; }
      if (resp.msgId !== msgId) return;
      if (resp.type === TYPE_RST || resp.type === TYPE_ACK) {
        done = true;
        clearTimeout(timer);
        try { sock.close(); } catch (_) {}
        resolve({ type: resp.typeName, code: resp.codeStr });
      }
    });

    sock.on("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.close(); } catch (_) {}
      reject(new Error(`coap_client: ping error: ${err.message}`));
    });

    sock.send(pkt, 0, pkt.length, cfg.port, cfg.host, (err) => {
      if (err && !done) {
        done = true;
        clearTimeout(timer);
        try { sock.close(); } catch (_) {}
        reject(new Error(`coap_client: ping send error: ${err.message}`));
      }
    });
  });

  return {
    ok:        true,
    operation: "ping",
    host:      cfg.host,
    port:      cfg.port,
    elapsedMs: Date.now() - t0,
    response:  result.type,
    code:      result.code,
    reachable: true,
  };
}

/** info — Return configuration and protocol information (no I/O) */
function opInfo(args) {
  const host      = (args.host || DEFAULT_HOST).trim();
  const port      = validatePort(args.port, DEFAULT_PORT);
  const timeoutMs = clampTimeout(args.timeout);
  const confirmable = args.confirmable !== false;

  guardNul(host, "host");

  return {
    ok:          true,
    operation:   "info",
    host,
    port,
    timeoutMs,
    confirmable,
    protocol:    "CoAP — Constrained Application Protocol (RFC 7252)",
    transport:   "UDP (IPv4 and IPv6); DTLS not implemented",
    defaultPort: DEFAULT_PORT,
    messageTypes: {
      CON: "Confirmable — requires ACK; retransmitted up to 4 times",
      NON: "Non-confirmable — fire-and-forget",
      ACK: "Acknowledgement",
      RST: "Reset",
    },
    methods: {
      GET:    "0.01 — Read a resource",
      POST:   "0.02 — Create or execute",
      PUT:    "0.03 — Update a resource",
      DELETE: "0.04 — Delete a resource",
    },
    contentFormats: CONTENT_FORMATS,
    operations: ["get", "post", "put", "delete", "discover", "observe", "ping", "info"],
    limits: {
      maxPayloadBytes:   MAX_PAYLOAD_BYTES,
      maxRetransmit:     MAX_RETRANSMIT,
      ackTimeoutMs:      ACK_TIMEOUT_MS,
      maxObserveNotifs:  20,
    },
    note: "CoAP has no built-in authentication. Use DTLS or network-layer controls for security.",
  };
}

// ── Main entry point ──────────────────────────────────────────────────────────
async function coapClient(args) {
  const op = args.operation;
  if (!op) throw new Error("coap_client: 'operation' is required.");

  switch (op) {
    case "get":      return opGet(args);
    case "post":     return opPost(args);
    case "put":      return opPut(args);
    case "delete":   return opDelete(args);
    case "discover": return opDiscover(args);
    case "observe":  return opObserve(args);
    case "ping":     return opPing(args);
    case "info":     return opInfo(args);
    default:
      throw new Error(
        `coap_client: unknown operation '${op}'. ` +
        `Valid: get, post, put, delete, discover, observe, ping, info.`
      );
  }
}

module.exports = { coapClient, buildPacket, parsePacket, encodeOptions, parseLinkFormat, parseCoapUri };
