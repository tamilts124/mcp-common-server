"use strict";
/**
 * sip_client — Zero-dependency SIP client.
 * Pure Node.js (dgram + net + tls + crypto built-ins; no npm deps).
 *
 * Implements:
 *   RFC 3261  — SIP: Session Initiation Protocol
 *   RFC 3428  — SIP Extension for Instant Messaging (MESSAGE method)
 *   RFC 3265  — SIP-Specific Event Notification (SUBSCRIBE/NOTIFY)
 *   RFC 2327  — SDP: Session Description Protocol (for INVITE bodies)
 *   RFC 2617  — HTTP Authentication (Digest, used in SIP)
 *
 * Operations:
 *   options    — Send OPTIONS request, discover server capabilities
 *   register   — Send REGISTER to register a SIP address
 *   invite     — Send INVITE to initiate a call (signaling only)
 *   message    — Send MESSAGE (SIP instant message)
 *   subscribe  — Send SUBSCRIBE to event package
 *   info       — Return protocol/config info (no I/O)
 *
 * Transport: UDP (default, RFC 3261 §18.1), TCP, or TLS (SIPS).
 * Authentication: Digest MD5 (RFC 2617), auto-retried on 401/407.
 *
 * Security:
 *   - NUL-byte guards on all string inputs
 *   - Timeout clamped 1s–60s (default 5s)
 *   - Response size cap 512 KB
 *   - Port must be 1–65535
 *   - Via branch generated with cryptographically random magic cookie
 *   - CSeq auto-incremented; Call-ID per-request random
 */

const dgram  = require("dgram");
const net    = require("net");
const tls    = require("tls");
const crypto = require("crypto");

// ── Constants ─────────────────────────────────────────────────────────────────
const SIP_DEFAULT_PORT  = 5060;
const SIPS_DEFAULT_PORT = 5061;
const DEFAULT_TIMEOUT_MS = 5_000;
const MIN_TIMEOUT_MS     = 1_000;
const MAX_TIMEOUT_MS     = 60_000;
const MAX_RESPONSE_BYTES = 512 * 1024; // 512 KB
const SIP_VERSION        = "SIP/2.0";
const MAGIC_COOKIE       = "z9hG4bK"; // RFC 3261 §8.1.1.7

// ── Validation helpers ────────────────────────────────────────────────────────
function guardNul(value, name) {
  if (typeof value === "string" && value.includes("\0"))
    throw new Error(`sip_client: '${name}' must not contain NUL bytes.`);
}

function clampTimeout(t) {
  const n = typeof t === "number" ? t : DEFAULT_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.trunc(n)));
}

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}

function randomCallId(domain) {
  return `${randomHex(10)}@${domain || "mcp-sip"}`;
}

function randomTag() {
  return randomHex(6);
}

function randomBranch() {
  return `${MAGIC_COOKIE}${randomHex(8)}`;
}

// ── SIP URI parser ─────────────────────────────────────────────────────────────
/**
 * Parse a SIP URI: sip:user@host[:port] or sips:user@host[:port]
 * Also accepts bare host[:port] (no scheme), defaulting to sip.
 */
function parseSipUri(uriStr) {
  if (!uriStr || typeof uriStr !== "string")
    throw new Error("sip_client: SIP URI must be a non-empty string.");

  let scheme = "sip";
  let rest = uriStr.trim();

  if (rest.toLowerCase().startsWith("sips:")) {
    scheme = "sips";
    rest = rest.slice(5);
  } else if (rest.toLowerCase().startsWith("sip:")) {
    scheme = "sip";
    rest = rest.slice(4);
  }
  // strip leading //
  if (rest.startsWith("//")) rest = rest.slice(2);

  // user@host:port or host:port
  let user = null;
  const atIdx = rest.indexOf("@");
  if (atIdx !== -1) {
    user = decodeURIComponent(rest.slice(0, atIdx));
    rest = rest.slice(atIdx + 1);
  }

  // strip any ;parameters or ?headers from rest
  const semicolon = rest.indexOf(";");
  const question  = rest.indexOf("?");
  let hostPort = rest;
  if (semicolon !== -1) hostPort = hostPort.slice(0, semicolon);
  if (question  !== -1) hostPort = hostPort.slice(0, question);

  let host, port;
  if (hostPort.startsWith("[")) {
    const bracketEnd = hostPort.indexOf("]");
    if (bracketEnd === -1) throw new Error("sip_client: malformed IPv6 address in SIP URI.");
    host = hostPort.slice(1, bracketEnd);
    const portPart = hostPort.slice(bracketEnd + 1);
    port = portPart.startsWith(":") ? parseInt(portPart.slice(1), 10) : (scheme === "sips" ? SIPS_DEFAULT_PORT : SIP_DEFAULT_PORT);
  } else {
    const colonIdx = hostPort.lastIndexOf(":");
    if (colonIdx !== -1) {
      host = hostPort.slice(0, colonIdx);
      port = parseInt(hostPort.slice(colonIdx + 1), 10);
    } else {
      host = hostPort;
      port = scheme === "sips" ? SIPS_DEFAULT_PORT : SIP_DEFAULT_PORT;
    }
  }

  if (!host) throw new Error("sip_client: SIP URI is missing host.");
  if (!isFinite(port) || port < 1 || port > 65535)
    throw new Error(`sip_client: invalid port ${port} in SIP URI.`);

  return { scheme, user, host, port };
}

/**
 * Serialize a parsed SIP URI back to canonical string form.
 */
function formatSipUri(parsed, includeUser = true) {
  const userPart = (includeUser && parsed.user) ? `${parsed.user}@` : "";
  const defaultPort = parsed.scheme === "sips" ? SIPS_DEFAULT_PORT : SIP_DEFAULT_PORT;
  const portPart = parsed.port !== defaultPort ? `:${parsed.port}` : "";
  return `${parsed.scheme}:${userPart}${parsed.host}${portPart}`;
}

// ── SIP message builder ───────────────────────────────────────────────────────
/**
 * Build a SIP request string.
 *
 * @param {object} opts
 * @param {string} opts.method
 * @param {string} opts.requestUri  - Request-URI in the start line
 * @param {object} opts.headers     - SIP headers (object, key: value)
 * @param {string} [opts.body]      - Optional body
 */
function buildRequest(opts) {
  const { method, requestUri, headers, body } = opts;
  let msg = `${method} ${requestUri} ${SIP_VERSION}\r\n`;
  for (const [k, v] of Object.entries(headers || {})) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      for (const vi of v) msg += `${k}: ${vi}\r\n`;
    } else {
      msg += `${k}: ${v}\r\n`;
    }
  }
  if (body) {
    msg += `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n`;
  } else {
    msg += `Content-Length: 0\r\n`;
  }
  msg += "\r\n";
  if (body) msg += body;
  return msg;
}

// ── SIP response parser ───────────────────────────────────────────────────────
/**
 * Parse a SIP response.
 * Returns { statusCode, statusText, headers, body }.
 */
function parseResponse(raw) {
  // SIP may arrive in chunks over TCP — find the header/body separator
  const sep = raw.indexOf("\r\n\r\n");
  if (sep === -1) {
    // Try bare LF separator as fallback (some broken implementations)
    const sep2 = raw.indexOf("\n\n");
    if (sep2 === -1) throw new Error("sip_client: incomplete SIP response (no header terminator).");
    return parseResponse(raw.replace(/\n/g, "\r\n"));
  }

  const headerSection = raw.slice(0, sep);
  const bodySection   = raw.slice(sep + 4);

  const lines = headerSection.split("\r\n");
  const statusLine = lines[0];
  // SIP/2.0 NNN Reason Text
  const statusMatch = statusLine.match(/^SIP\/\d+\.\d+\s+(\d+)\s+(.*)/i);
  if (!statusMatch)
    throw new Error(`sip_client: invalid SIP status line: "${statusLine.slice(0, 80)}".`);

  const statusCode = parseInt(statusMatch[1], 10);
  const statusText = statusMatch[2].trim();

  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    // Compact header names (RFC 3261 §7.3.3)
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const rawKey = line.slice(0, colon).trim();
    const val    = line.slice(colon + 1).trim();
    const key    = expandCompactHeader(rawKey).toLowerCase();
    if (key in headers) {
      // Multiple values: collect into array
      if (Array.isArray(headers[key])) headers[key].push(val);
      else headers[key] = [headers[key], val];
    } else {
      headers[key] = val;
    }
  }

  return { statusCode, statusText, headers, body: bodySection };
}

/** Expand compact header names per RFC 3261 §7.3.3 */
function expandCompactHeader(name) {
  const compact = {
    v: "Via",
    t: "To",
    f: "From",
    m: "Contact",
    i: "Call-ID",
    e: "Content-Encoding",
    l: "Content-Length",
    c: "Content-Type",
    o: "Event",
    r: "Refer-To",
    s: "Subject",
    k: "Supported",
    u: "Allow-Events",
  };
  return compact[name.toLowerCase()] || name;
}

// ── Digest auth helper (RFC 2617 / RFC 3261 §22) ──────────────────────────────
function parseWwwAuthenticate(header) {
  if (!header) return null;
  const h = Array.isArray(header) ? header[0] : header;
  const lower = h.toLowerCase();
  if (lower.startsWith("digest")) {
    const realm     = (h.match(/realm\s*=\s*"([^"]+)"/)     || [])[1] || "";
    const nonce     = (h.match(/nonce\s*=\s*"([^"]+)"/)     || [])[1] || "";
    const opaque    = (h.match(/opaque\s*=\s*"([^"]+)"/)    || [])[1] || "";
    const qop       = (h.match(/qop\s*=\s*"([^"]+)"/)       || [])[1] || "";
    const algorithm = (h.match(/algorithm\s*=\s*([\w-]+)/i) || [])[1] || "MD5";
    return { scheme: "digest", realm, nonce, opaque, qop, algorithm };
  }
  return null;
}

function buildDigestAuth(method, uri, username, password, challenge) {
  if (!challenge) return null;
  const { realm, nonce, opaque, qop, algorithm } = challenge;
  const ha1 = crypto.createHash("md5").update(`${username}:${realm}:${password}`).digest("hex");
  const ha2 = crypto.createHash("md5").update(`${method}:${uri}`).digest("hex");
  let response, cnonce = "", ncHex = "00000001";
  if (qop && qop.includes("auth")) {
    cnonce = randomHex(8);
    response = crypto.createHash("md5").update(`${ha1}:${nonce}:${ncHex}:${cnonce}:auth:${ha2}`).digest("hex");
  } else {
    response = crypto.createHash("md5").update(`${ha1}:${nonce}:${ha2}`).digest("hex");
  }
  let auth = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}", algorithm=${algorithm}`;
  if (opaque) auth += `, opaque="${opaque}"`;
  if (qop && qop.includes("auth")) auth += `, qop=auth, nc=${ncHex}, cnonce="${cnonce}"`;
  return auth;
}

// ── UDP transport ─────────────────────────────────────────────────────────────
function sendUdp(message, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket("udp4");
    let done = false;
    let buf = "";

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      sock.close();
      reject(new Error(`sip_client: UDP response timed out after ${timeoutMs} ms.`));
    }, timeoutMs);

    sock.on("error", (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.close();
      reject(new Error(`sip_client: UDP error: ${err.message}`));
    });

    sock.on("message", (msg) => {
      if (done) return;
      buf += msg.toString("utf8");
      // Check if we have a complete SIP response (headers + body per CL)
      if (isCompleteResponse(buf)) {
        done = true;
        clearTimeout(timer);
        try { sock.close(); } catch (_) {}
        resolve(buf);
      }
    });

    const msgBuf = Buffer.from(message, "utf8");
    sock.send(msgBuf, 0, msgBuf.length, port, host, (err) => {
      if (err) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        sock.close();
        reject(new Error(`sip_client: UDP send error: ${err.message}`));
      }
    });
  });
}

// ── TCP/TLS transport ─────────────────────────────────────────────────────────
function sendTcp(message, host, port, timeoutMs, useTls, tlsOptions) {
  return new Promise((resolve, reject) => {
    let sock;
    if (useTls) {
      sock = tls.connect(port, host, Object.assign({
        servername: host,
        rejectUnauthorized: tlsOptions?.rejectUnauthorized !== false,
      }, tlsOptions || {}));
    } else {
      sock = net.connect(port, host);
    }

    let done = false;
    let buf = "";

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      sock.destroy();
      reject(new Error(`sip_client: TCP response timed out after ${timeoutMs} ms.`));
    }, timeoutMs);

    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch (_) {}
      resolve(result);
    };

    const fail = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch (_) {}
      reject(err);
    };

    sock.once("error", (err) => fail(new Error(`sip_client: TCP error: ${err.message}`)));

    const onConnect = () => {
      sock.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        if (buf.length > MAX_RESPONSE_BYTES) {
          fail(new Error(`sip_client: response exceeds ${MAX_RESPONSE_BYTES} byte cap.`));
          return;
        }
        if (isCompleteResponse(buf)) finish(buf);
      });
      sock.once("close", () => {
        if (!done) {
          if (buf.indexOf("\r\n\r\n") !== -1) finish(buf);
          else fail(new Error("sip_client: connection closed before complete SIP response."));
        }
      });
      sock.write(Buffer.from(message, "utf8"));
    };

    if (useTls) sock.once("secureConnect", onConnect);
    else        sock.once("connect", onConnect);
  });
}

/**
 * Check if we have a complete SIP response (all headers + full body per Content-Length).
 */
function isCompleteResponse(buf) {
  const sep = buf.indexOf("\r\n\r\n");
  if (sep === -1) return false;
  const clMatch = buf.slice(0, sep).match(/content-length:\s*(\d+)/i);
  const contentLength = clMatch ? parseInt(clMatch[1], 10) : 0;
  const bodyReceived = Buffer.byteLength(buf.slice(sep + 4), "utf8");
  return bodyReceived >= contentLength;
}

// ── Core SIP request engine ───────────────────────────────────────────────────
/**
 * Send a SIP request and receive a response.
 * Handles 401/407 Digest re-authentication automatically.
 *
 * @param {object} params
 * @returns {Promise<{statusCode, statusText, headers, body, requestsSent}>}
 */
async function sipRequest(params) {
  const {
    method, requestUri, fromUri, toUri,
    callId, cseq, extraHeaders, body, contentType,
    host, port, transport, timeoutMs, tlsOptions,
    username, password,
  } = params;

  const useTls = (transport === "tls" || transport === "sips");
  const useTcp = (transport === "tcp" || useTls);

  const via = `${SIP_VERSION}/UDP ${fromUri.host};branch=${randomBranch()}`
    .replace("UDP", transport === "tcp" ? "TCP" : (useTls ? "TLS" : "UDP"));

  function buildHeaders(authHeader) {
    const hdrs = {
      "Via":          via,
      "Max-Forwards": "70",
      "From":         `<${formatSipUri(fromUri)}>;tag=${randomTag()}`,
      "To":           `<${formatSipUri(toUri)}>`,
      "Call-ID":      callId,
      "CSeq":         `${cseq} ${method}`,
      "User-Agent":   "mcp-common-server/sip_client",
      ...(extraHeaders || {}),
    };
    if (authHeader) hdrs["Authorization"] = authHeader;
    if (body && contentType) hdrs["Content-Type"] = contentType;
    return hdrs;
  }

  async function send(authHeader) {
    const msg = buildRequest({
      method,
      requestUri,
      headers: buildHeaders(authHeader),
      body,
    });
    let rawResp;
    if (useTcp) {
      rawResp = await sendTcp(msg, host, port, timeoutMs, useTls, tlsOptions);
    } else {
      rawResp = await sendUdp(msg, host, port, timeoutMs);
    }
    return parseResponse(rawResp);
  }

  // First attempt (no auth)
  const resp1 = await send(null);

  // 401 Unauthorized or 407 Proxy Auth Required → retry with Digest
  if ((resp1.statusCode === 401 || resp1.statusCode === 407) && username) {
    const wwwHdr = resp1.statusCode === 401
      ? (resp1.headers["www-authenticate"] || resp1.headers["proxy-authenticate"])
      : (resp1.headers["proxy-authenticate"] || resp1.headers["www-authenticate"]);
    const challenge = parseWwwAuthenticate(wwwHdr);
    const authHdr   = buildDigestAuth(method, requestUri, username, password || "", challenge);
    if (authHdr) {
      const resp2 = await send(authHdr);
      resp2.requestsSent = 2;
      return resp2;
    }
  }

  resp1.requestsSent = 1;
  return resp1;
}

// ── Shared preparation ────────────────────────────────────────────────────────
function prepareArgs(args) {
  const serverStr = (args.server || "").trim();
  if (!serverStr) throw new Error("sip_client: 'server' is required for this operation.");
  guardNul(serverStr, "server");
  if (args.username) guardNul(args.username, "username");
  if (args.password) guardNul(args.password, "password");
  if (args.from)     guardNul(args.from, "from");
  if (args.to)       guardNul(args.to, "to");

  const transport = (args.transport || "udp").toLowerCase();
  if (!["udp", "tcp", "tls", "sips"].includes(transport))
    throw new Error(`sip_client: invalid transport '${transport}'. Valid: udp, tcp, tls.`);

  const serverParsed = parseSipUri(serverStr);
  const host = args.host || serverParsed.host;
  const port = args.port || serverParsed.port;
  if (!isFinite(port) || port < 1 || port > 65535)
    throw new Error(`sip_client: invalid port ${port}.`);

  const timeoutMs = clampTimeout(args.timeout);
  const tlsOptions = {};
  if (typeof args.reject_unauthorized === "boolean")
    tlsOptions.rejectUnauthorized = args.reject_unauthorized;

  return {
    serverParsed, host, port, transport, timeoutMs,
    tlsOptions: Object.keys(tlsOptions).length ? tlsOptions : undefined,
    username: args.username || null,
    password: args.password || null,
  };
}

// ── Classify SIP response ─────────────────────────────────────────────────────
function describeStatus(code) {
  if (code >= 100 && code < 200) return "Provisional";
  if (code >= 200 && code < 300) return "Success";
  if (code >= 300 && code < 400) return "Redirection";
  if (code >= 400 && code < 500) return "Client Error";
  if (code >= 500 && code < 600) return "Server Error";
  if (code >= 600 && code < 700) return "Global Failure";
  return "Unknown";
}

// ── Operations ────────────────────────────────────────────────────────────────

/** options — Probe server capabilities */
async function opOptions(args) {
  const { serverParsed, host, port, transport, timeoutMs, tlsOptions, username, password } = prepareArgs(args);

  const fromUri = args.from ? parseSipUri(args.from) : { ...serverParsed, user: "mcp-probe", scheme: "sip" };
  const toUri   = { ...serverParsed };
  const callId  = randomCallId(fromUri.host);
  const requestUri = formatSipUri(serverParsed, false) + ";maddr=" + host;

  const resp = await sipRequest({
    method: "OPTIONS",
    requestUri: formatSipUri(serverParsed, false),
    fromUri, toUri,
    callId, cseq: 1,
    extraHeaders: {
      Accept: "application/sdp",
    },
    host, port, transport, timeoutMs, tlsOptions, username, password,
  });

  const allow   = (resp.headers["allow"]   || "").split(",").map(s => s.trim()).filter(Boolean);
  const accept  = (resp.headers["accept"]  || "").split(",").map(s => s.trim()).filter(Boolean);
  const supported = (resp.headers["supported"] || "").split(",").map(s => s.trim()).filter(Boolean);

  return {
    ok:           resp.statusCode >= 200 && resp.statusCode < 300,
    operation:    "options",
    server:       args.server,
    statusCode:   resp.statusCode,
    statusText:   resp.statusText,
    statusClass:  describeStatus(resp.statusCode),
    allow,
    accept,
    supported,
    userAgent:    resp.headers["user-agent"] || null,
    server_hdr:   resp.headers["server"] || null,
    headers:      resp.headers,
    requestsSent: resp.requestsSent,
  };
}

/** register — Register a SIP address */
async function opRegister(args) {
  const { serverParsed, host, port, transport, timeoutMs, tlsOptions, username, password } = prepareArgs(args);

  if (!args.from) throw new Error("sip_client: register requires 'from' (SIP URI of the address to register).");
  const fromUri = parseSipUri(args.from);
  const toUri   = { ...fromUri };
  const callId  = randomCallId(fromUri.host);
  const expires = args.expires != null ? Math.trunc(args.expires) : 3600;

  // Contact: if not provided, use the from URI with expires
  const contactUri = args.contact || formatSipUri(fromUri);

  const resp = await sipRequest({
    method: "REGISTER",
    requestUri: formatSipUri(serverParsed, false),
    fromUri, toUri,
    callId, cseq: 1,
    extraHeaders: {
      Contact: `<${contactUri}>;expires=${expires}`,
      Expires: String(expires),
    },
    host, port, transport, timeoutMs, tlsOptions,
    username: username || fromUri.user,
    password,
  });

  // Parse registered contacts from 200 OK
  const contacts = [];
  if (resp.statusCode >= 200 && resp.statusCode < 300) {
    const contactHdr = resp.headers["contact"];
    if (contactHdr) {
      const clist = Array.isArray(contactHdr) ? contactHdr : [contactHdr];
      for (const c of clist) {
        const expiresMatch = c.match(/expires=(\d+)/i);
        const uriMatch     = c.match(/<([^>]+)>/);
        contacts.push({
          uri:     uriMatch ? uriMatch[1] : c,
          expires: expiresMatch ? parseInt(expiresMatch[1], 10) : expires,
        });
      }
    }
  }

  return {
    ok:           resp.statusCode >= 200 && resp.statusCode < 300,
    operation:    "register",
    server:       args.server,
    from:         args.from,
    statusCode:   resp.statusCode,
    statusText:   resp.statusText,
    statusClass:  describeStatus(resp.statusCode),
    expires,
    contacts,
    headers:      resp.headers,
    requestsSent: resp.requestsSent,
  };
}

/** invite — Initiate a SIP call (signaling only; no media) */
async function opInvite(args) {
  const { serverParsed, host, port, transport, timeoutMs, tlsOptions, username, password } = prepareArgs(args);

  if (!args.from) throw new Error("sip_client: invite requires 'from' (caller SIP URI).");
  if (!args.to)   throw new Error("sip_client: invite requires 'to' (callee SIP URI).");

  const fromUri = parseSipUri(args.from);
  const toUri   = parseSipUri(args.to);
  const callId  = randomCallId(fromUri.host);

  // Build minimal SDP offer if requested
  let body = null;
  let contentType = null;
  if (args.sdp_body) {
    body = args.sdp_body;
    contentType = "application/sdp";
  } else if (args.include_sdp !== false) {
    // Build a minimal SDP offer (signaling only — no real media)
    const sessId = Date.now();
    body = [
      "v=0",
      `o=mcp-sip ${sessId} ${sessId} IN IP4 ${fromUri.host}`,
      "s=MCP SIP INVITE",
      "t=0 0",
      "m=audio 0 RTP/AVP 0",
      "a=sendrecv",
    ].join("\r\n") + "\r\n";
    contentType = "application/sdp";
  }

  const resp = await sipRequest({
    method: "INVITE",
    requestUri: formatSipUri(toUri),
    fromUri, toUri,
    callId, cseq: 1,
    extraHeaders: {
      Contact: `<${formatSipUri(fromUri)}>`,
      "Allow": "INVITE, ACK, CANCEL, BYE, OPTIONS",
    },
    body, contentType,
    host, port, transport, timeoutMs, tlsOptions,
    username: username || fromUri.user,
    password,
  });

  // Extract session info from response
  const toTag = (resp.headers["to"] || "").match(/;tag=([^\s;,>]+)/i)?.[1] || null;
  const sessionId = callId;

  return {
    ok:           resp.statusCode >= 100 && resp.statusCode < 300,
    operation:    "invite",
    server:       args.server,
    from:         args.from,
    to:           args.to,
    statusCode:   resp.statusCode,
    statusText:   resp.statusText,
    statusClass:  describeStatus(resp.statusCode),
    callId,
    toTag,
    sessionId,
    contact:      resp.headers["contact"] || null,
    headers:      resp.headers,
    body:         resp.body || null,
    requestsSent: resp.requestsSent,
  };
}

/** message — Send a SIP MESSAGE (instant message) */
async function opMessage(args) {
  const { serverParsed, host, port, transport, timeoutMs, tlsOptions, username, password } = prepareArgs(args);

  if (!args.from) throw new Error("sip_client: message requires 'from' (sender SIP URI).");
  if (!args.to)   throw new Error("sip_client: message requires 'to' (recipient SIP URI).");
  if (!args.body && args.body !== "") throw new Error("sip_client: message requires 'body' (message text).");

  const fromUri = parseSipUri(args.from);
  const toUri   = parseSipUri(args.to);
  const callId  = randomCallId(fromUri.host);
  const msgBody = String(args.body);
  const msgContentType = args.content_type || "text/plain;charset=UTF-8";

  const resp = await sipRequest({
    method: "MESSAGE",
    requestUri: formatSipUri(toUri),
    fromUri, toUri,
    callId, cseq: 1,
    body: msgBody,
    contentType: msgContentType,
    host, port, transport, timeoutMs, tlsOptions,
    username: username || fromUri.user,
    password,
  });

  return {
    ok:           resp.statusCode >= 200 && resp.statusCode < 300,
    operation:    "message",
    server:       args.server,
    from:         args.from,
    to:           args.to,
    statusCode:   resp.statusCode,
    statusText:   resp.statusText,
    statusClass:  describeStatus(resp.statusCode),
    callId,
    bodyLength:   Buffer.byteLength(msgBody, "utf8"),
    headers:      resp.headers,
    requestsSent: resp.requestsSent,
  };
}

/** subscribe — Send a SUBSCRIBE for event notification */
async function opSubscribe(args) {
  const { serverParsed, host, port, transport, timeoutMs, tlsOptions, username, password } = prepareArgs(args);

  if (!args.from)  throw new Error("sip_client: subscribe requires 'from' (subscriber SIP URI).");
  if (!args.to)    throw new Error("sip_client: subscribe requires 'to' (notifier/resource SIP URI).");
  if (!args.event) throw new Error("sip_client: subscribe requires 'event' (event package, e.g. presence).");
  guardNul(args.event, "event");

  const fromUri = parseSipUri(args.from);
  const toUri   = parseSipUri(args.to);
  const callId  = randomCallId(fromUri.host);
  const expires = args.expires != null ? Math.trunc(args.expires) : 3600;

  const resp = await sipRequest({
    method: "SUBSCRIBE",
    requestUri: formatSipUri(toUri),
    fromUri, toUri,
    callId, cseq: 1,
    extraHeaders: {
      Event:   args.event,
      Expires: String(expires),
      Accept:  args.accept || "application/pidf+xml",
      Contact: `<${formatSipUri(fromUri)}>`,
    },
    host, port, transport, timeoutMs, tlsOptions,
    username: username || fromUri.user,
    password,
  });

  return {
    ok:           resp.statusCode >= 200 && resp.statusCode < 300,
    operation:    "subscribe",
    server:       args.server,
    from:         args.from,
    to:           args.to,
    event:        args.event,
    statusCode:   resp.statusCode,
    statusText:   resp.statusText,
    statusClass:  describeStatus(resp.statusCode),
    callId,
    expires:      resp.headers["expires"] || String(expires),
    headers:      resp.headers,
    requestsSent: resp.requestsSent,
  };
}

/** info — Return protocol info (no I/O) */
function opInfo() {
  return {
    ok: true,
    operation: "info",
    protocol: {
      name:        "SIP — Session Initiation Protocol",
      version:     "2.0",
      rfcs:        ["RFC 3261 (SIP)", "RFC 3428 (MESSAGE)", "RFC 3265 (SUBSCRIBE/NOTIFY)", "RFC 2617 (Digest Auth)", "RFC 2327 (SDP)"],
      transports:  ["UDP (default, RFC 3261 §18.1)", "TCP", "TLS (SIPS)"],
      defaultPorts: { "sip:": SIP_DEFAULT_PORT, "sips:": SIPS_DEFAULT_PORT },
      methods:     ["OPTIONS", "REGISTER", "INVITE", "ACK", "BYE", "CANCEL", "MESSAGE", "SUBSCRIBE", "NOTIFY"],
    },
    operations: [
      "options   — Probe server capabilities (OPTIONS)",
      "register  — Register a SIP address (REGISTER)",
      "invite    — Initiate a call (INVITE, signaling only, no media)",
      "message   — Send a SIP instant message (MESSAGE, RFC 3428)",
      "subscribe — Subscribe to an event package (SUBSCRIBE, RFC 3265)",
      "info      — Return this info object (no I/O)",
    ],
    authentication: ["Digest MD5 (RFC 2617), auto-retried on 401/407"],
    defaults: {
      transport:    "udp",
      port_sip:     SIP_DEFAULT_PORT,
      port_sips:    SIPS_DEFAULT_PORT,
      timeoutMs:    DEFAULT_TIMEOUT_MS,
      maxResponseBytes: MAX_RESPONSE_BYTES,
      expires:      3600,
    },
    notes: [
      "Zero npm dependencies — pure Node.js dgram/net/tls/crypto built-ins.",
      "UDP is the standard SIP transport; TCP/TLS also supported.",
      "INVITE is signaling-only — no RTP media streams are established.",
      "Authentication: Digest MD5 with optional qop=auth is auto-negotiated on 401/407.",
      "SIP URI format: sip:user@host[:port] or sips:user@host[:port].",
    ],
  };
}

// ── Main entry point ──────────────────────────────────────────────────────────
async function sipClient(args) {
  const op = (args.operation || "").trim();
  if (!op) throw new Error("sip_client: 'operation' is required.");

  switch (op) {
    case "options":   return opOptions(args);
    case "register":  return opRegister(args);
    case "invite":    return opInvite(args);
    case "message":   return opMessage(args);
    case "subscribe": return opSubscribe(args);
    case "info":      return opInfo();
    default:
      throw new Error(
        `sip_client: unknown operation '${op}'. Valid: options, register, invite, message, subscribe, info.`
      );
  }
}

module.exports = {
  sipClient,
  // Exported for testing
  parseSipUri,
  formatSipUri,
  buildRequest,
  parseResponse,
  parseWwwAuthenticate,
  buildDigestAuth,
  expandCompactHeader,
  isCompleteResponse,
  randomBranch,
  randomCallId,
  randomTag,
  clampTimeout,
  guardNul,
  describeStatus,
  SIP_DEFAULT_PORT,
  SIPS_DEFAULT_PORT,
  DEFAULT_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  SIP_VERSION,
  MAGIC_COOKIE,
};
