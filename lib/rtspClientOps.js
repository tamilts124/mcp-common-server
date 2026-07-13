"use strict";
/**
 * rtsp_client — Zero-dependency RTSP client.
 * Pure Node.js (net + tls built-ins; no npm deps).
 *
 * Implements:
 *   RFC 2326  — Real Time Streaming Protocol (RTSP) 1.0
 *   RFC 2327  — SDP: Session Description Protocol (for parsing DESCRIBE response)
 *   RFC 2616  — HTTP/1.1 digest auth (subset used in RTSP)
 *
 * Operations:
 *   options   — Query server capabilities (OPTIONS method)
 *   describe  — Fetch SDP session description (DESCRIBE method)
 *   setup     — Establish a media stream session (SETUP method)
 *   play      — Start/resume media delivery (PLAY method)
 *   pause     — Pause media delivery (PAUSE method)
 *   teardown  — End session and release resources (TEARDOWN method)
 *   info      — Return protocol/config info (no I/O)
 *
 * Authentication: Basic (RFC 7617) and Digest (RFC 7616) are both supported.
 * TLS: rtsp:// uses plain TCP (port 554); rtsps:// uses TLS (port 322).
 *
 * Security:
 *   - NUL-byte guards on url/username/password
 *   - Timeout clamped 1s–60s (default 10s)
 *   - Response body capped at 4 MB
 *   - Port must be 1–65535
 *   - CSeq auto-incremented per request
 */

const net = require("net");
const tls = require("tls");
const crypto = require("crypto");

// ── Constants ─────────────────────────────────────────────────────────────────
const RTSP_DEFAULT_PORT  = 554;
const RTSPS_DEFAULT_PORT = 322;
const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS     = 1_000;
const MAX_TIMEOUT_MS     = 60_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024; // 4 MB
const RTSP_VERSION       = "RTSP/1.0";

// ── Validation helpers ────────────────────────────────────────────────────────
function guardNul(value, name) {
  if (typeof value === "string" && value.includes("\0"))
    throw new Error(`rtsp_client: '${name}' must not contain NUL bytes.`);
}

function clampTimeout(t) {
  const n = typeof t === "number" ? t : DEFAULT_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.trunc(n)));
}

// ── RTSP URL parser ───────────────────────────────────────────────────────────
/**
 * Parse an RTSP URL into { scheme, host, port, path, userinfo }.
 * Supports: rtsp://[user:pass@]host[:port]/path
 *           rtsps://[user:pass@]host[:port]/path
 */
function parseRtspUrl(urlStr) {
  if (!urlStr || typeof urlStr !== "string")
    throw new Error("rtsp_client: 'url' must be a non-empty string.");

  const lower = urlStr.trim().toLowerCase();
  let scheme;
  let rest;
  if (lower.startsWith("rtsps://")) {
    scheme = "rtsps";
    rest = urlStr.trim().slice(8);
  } else if (lower.startsWith("rtsp://")) {
    scheme = "rtsp";
    rest = urlStr.trim().slice(7);
  } else {
    throw new Error(
      `rtsp_client: URL must start with rtsp:// or rtsps:// (got: ${urlStr.slice(0, 30)})`
    );
  }

  // Split userinfo@host:port/path
  let userinfo = null;
  const atIdx = rest.indexOf("@");
  const slashIdx = rest.indexOf("/");
  if (atIdx !== -1 && (slashIdx === -1 || atIdx < slashIdx)) {
    userinfo = rest.slice(0, atIdx);
    rest = rest.slice(atIdx + 1);
  }

  // host:port/path
  const pathStart = rest.indexOf("/");
  let authority;
  let path;
  if (pathStart === -1) {
    authority = rest;
    path = "/";
  } else {
    authority = rest.slice(0, pathStart);
    path = rest.slice(pathStart) || "/";
  }

  // IPv6
  let host, port;
  if (authority.startsWith("[")) {
    const bracketEnd = authority.indexOf("]");
    if (bracketEnd === -1) throw new Error("rtsp_client: malformed IPv6 address.");
    host = authority.slice(1, bracketEnd);
    const portPart = authority.slice(bracketEnd + 1);
    port = portPart.startsWith(":") ? parseInt(portPart.slice(1), 10) : (scheme === "rtsps" ? RTSPS_DEFAULT_PORT : RTSP_DEFAULT_PORT);
  } else {
    const colonIdx = authority.lastIndexOf(":");
    if (colonIdx !== -1) {
      host = authority.slice(0, colonIdx);
      port = parseInt(authority.slice(colonIdx + 1), 10);
    } else {
      host = authority;
      port = scheme === "rtsps" ? RTSPS_DEFAULT_PORT : RTSP_DEFAULT_PORT;
    }
  }

  if (!host) throw new Error("rtsp_client: URL is missing host.");
  if (!isFinite(port) || port < 1 || port > 65535)
    throw new Error(`rtsp_client: invalid port ${port} in URL.`);

  let username = null;
  let password = null;
  if (userinfo) {
    const ci = userinfo.indexOf(":");
    username = ci === -1 ? decodeURIComponent(userinfo) : decodeURIComponent(userinfo.slice(0, ci));
    password = ci === -1 ? "" : decodeURIComponent(userinfo.slice(ci + 1));
  }

  return { scheme, host, port, path, username, password };
}

// ── RTSP message builder ──────────────────────────────────────────────────────
/**
 * Build an RTSP request string.
 */
function buildRequest(method, url, cseq, headers, body) {
  const hdrs = Object.assign({ CSeq: cseq }, headers || {});
  if (body) hdrs["Content-Length"] = Buffer.byteLength(body, "utf8");
  let req = `${method} ${url} ${RTSP_VERSION}\r\n`;
  for (const [k, v] of Object.entries(hdrs)) {
    req += `${k}: ${v}\r\n`;
  }
  req += "\r\n";
  if (body) req += body;
  return req;
}

// ── RTSP response parser ──────────────────────────────────────────────────────
/**
 * Parse an RTSP response.
 * Returns { statusCode, statusText, headers, body }.
 */
function parseResponse(raw) {
  const headerEnd = raw.indexOf("\r\n\r\n");
  if (headerEnd === -1) throw new Error("rtsp_client: incomplete RTSP response (no header terminator).");

  const headerSection = raw.slice(0, headerEnd);
  const bodySection   = raw.slice(headerEnd + 4);

  const lines = headerSection.split("\r\n");
  const statusLine = lines[0];
  const statusMatch = statusLine.match(/^RTSP\/\d+\.\d+\s+(\d+)\s+(.*)/);
  if (!statusMatch)
    throw new Error(`rtsp_client: invalid RTSP status line: ${statusLine.slice(0, 80)}`);

  const statusCode = parseInt(statusMatch[1], 10);
  const statusText = statusMatch[2].trim();

  const headers = {};
  for (let i = 1; i < lines.length; i++) {
    const colon = lines[i].indexOf(":");
    if (colon === -1) continue;
    const key = lines[i].slice(0, colon).trim().toLowerCase();
    const val = lines[i].slice(colon + 1).trim();
    headers[key] = val;
  }

  return { statusCode, statusText, headers, body: bodySection };
}

// ── Digest auth helper ────────────────────────────────────────────────────────
function parseWwwAuthenticate(header) {
  if (!header) return null;
  const lower = header.toLowerCase();
  if (lower.startsWith("basic")) {
    return { scheme: "basic", realm: (header.match(/realm="([^"]+)"/) || [])[1] || "" };
  }
  if (lower.startsWith("digest")) {
    const realm  = (header.match(/realm="([^"]+)"/)  || [])[1] || "";
    const nonce  = (header.match(/nonce="([^"]+)"/)  || [])[1] || "";
    const opaque = (header.match(/opaque="([^"]+)"/) || [])[1] || "";
    const qop    = (header.match(/qop="([^"]+)"/)    || [])[1] || "";
    const algorithm = (header.match(/algorithm=([^,\s]+)/i) || [])[1] || "MD5";
    return { scheme: "digest", realm, nonce, opaque, qop, algorithm };
  }
  return null;
}

function buildAuthHeader(method, url, username, password, challenge) {
  if (!challenge) return null;
  if (challenge.scheme === "basic") {
    const b64 = Buffer.from(`${username}:${password}`).toString("base64");
    return `Basic ${b64}`;
  }
  if (challenge.scheme === "digest") {
    const { realm, nonce, opaque, qop, algorithm } = challenge;
    const ha1 = crypto.createHash("md5").update(`${username}:${realm}:${password}`).digest("hex");
    const ha2 = crypto.createHash("md5").update(`${method}:${url}`).digest("hex");
    let response;
    let ncHex = "00000001";
    let cnonce = "";
    if (qop && qop.includes("auth")) {
      cnonce = crypto.randomBytes(8).toString("hex");
      response = crypto.createHash("md5").update(`${ha1}:${nonce}:${ncHex}:${cnonce}:auth:${ha2}`).digest("hex");
    } else {
      response = crypto.createHash("md5").update(`${ha1}:${nonce}:${ha2}`).digest("hex");
    }
    let auth = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${url}", response="${response}"`;
    if (opaque) auth += `, opaque="${opaque}"`;
    if (algorithm) auth += `, algorithm=${algorithm}`;
    if (qop && qop.includes("auth")) auth += `, qop=auth, nc=${ncHex}, cnonce="${cnonce}"`;
    return auth;
  }
  return null;
}

// ── TCP/TLS connection helper ─────────────────────────────────────────────────
/**
 * Open a TCP (or TLS for rtsps://) connection and return a socket + send/recv interface.
 */
function openConnection(scheme, host, port, timeoutMs, tlsOptions) {
  return new Promise((resolve, reject) => {
    let sock;
    if (scheme === "rtsps") {
      sock = tls.connect(port, host, Object.assign({
        servername: host,
        rejectUnauthorized: tlsOptions?.rejectUnauthorized !== false,
      }, tlsOptions || {}));
    } else {
      sock = net.connect(port, host);
    }

    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`rtsp_client: connection to ${host}:${port} timed out after ${timeoutMs} ms.`));
    }, timeoutMs);

    sock.once("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`rtsp_client: connection error: ${err.message}`));
    });

    const onConnect = () => {
      clearTimeout(timer);
      resolve(sock);
    };

    if (scheme === "rtsps") {
      sock.once("secureConnect", onConnect);
    } else {
      sock.once("connect", onConnect);
    }
  });
}

/**
 * Send a raw string on a socket, accumulate response until we have a complete
 * RTSP response (headers + Content-Length bytes of body).
 */
function sendAndReceive(sock, request, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = "";
    let done = false;

    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        sock.destroy();
        reject(new Error(`rtsp_client: response timed out after ${timeoutMs} ms.`));
      }
    }, timeoutMs);

    function finish(result) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    }

    function onData(chunk) {
      buf += chunk.toString("binary");
      if (buf.length > MAX_RESPONSE_BYTES) {
        done = true;
        clearTimeout(timer);
        sock.destroy();
        reject(new Error(`rtsp_client: response exceeds ${MAX_RESPONSE_BYTES} byte cap.`));
        return;
      }

      // Check if we have complete headers
      const sep = buf.indexOf("\r\n\r\n");
      if (sep === -1) return;

      // Parse headers to find Content-Length
      const headerText = buf.slice(0, sep);
      const clMatch = headerText.match(/content-length:\s*(\d+)/i);
      const contentLength = clMatch ? parseInt(clMatch[1], 10) : 0;

      const bodyStart = sep + 4;
      const received = Buffer.byteLength(buf.slice(bodyStart), "binary");
      if (received >= contentLength) {
        finish(buf);
      }
    }

    sock.on("data", onData);
    sock.once("error", (err) => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(new Error(`rtsp_client: socket error: ${err.message}`));
      }
    });
    sock.once("close", () => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        // Server closed — return whatever we have if headers are complete
        if (buf.indexOf("\r\n\r\n") !== -1) resolve(buf);
        else reject(new Error("rtsp_client: connection closed before complete response received."));
      }
    });

    sock.write(request);
  });
}

// ── SDP parser ────────────────────────────────────────────────────────────────
/**
 * Parse an SDP body (RFC 2327) into a structured object.
 */
function parseSdp(sdpText) {
  if (!sdpText || !sdpText.trim()) return null;
  const result = {
    version: null,
    origin: null,
    sessionName: null,
    info: null,
    timing: [],
    connection: null,
    attributes: {},
    bandwidth: [],
    mediaDescriptions: [],
    raw: sdpText,
  };

  let currentMedia = null;

  for (const rawLine of sdpText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length < 2 || line[1] !== "=") continue;
    const type = line[0];
    const value = line.slice(2);

    if (type === "v") {
      result.version = parseInt(value, 10);
    } else if (type === "o") {
      const [username, sessId, sessVer, nettype, addrtype, addr] = value.split(" ");
      result.origin = { username, sessId, sessVer, nettype, addrtype, addr };
    } else if (type === "s") {
      if (!currentMedia) result.sessionName = value;
    } else if (type === "i") {
      if (!currentMedia) result.info = value;
    } else if (type === "t") {
      result.timing.push(value);
    } else if (type === "c") {
      const conn = parseConnectionLine(value);
      if (currentMedia) currentMedia.connection = conn;
      else result.connection = conn;
    } else if (type === "b") {
      const bw = { raw: value };
      const [bwtype, bandwidth] = value.split(":");
      bw.bwtype = bwtype;
      bw.bandwidth = parseInt(bandwidth, 10);
      if (currentMedia) currentMedia.bandwidth.push(bw);
      else result.bandwidth.push(bw);
    } else if (type === "a") {
      const colonIdx = value.indexOf(":");
      const attrName = colonIdx === -1 ? value : value.slice(0, colonIdx);
      const attrVal  = colonIdx === -1 ? true   : value.slice(colonIdx + 1);
      if (currentMedia) {
        if (!currentMedia.attributes[attrName]) currentMedia.attributes[attrName] = [];
        currentMedia.attributes[attrName].push(attrVal);
      } else {
        if (!result.attributes[attrName]) result.attributes[attrName] = [];
        result.attributes[attrName].push(attrVal);
      }
    } else if (type === "m") {
      // m=<media> <port> <proto> <fmt list>
      const parts = value.split(" ");
      const media = {
        type:         parts[0],
        port:         parseInt(parts[1], 10),
        protocol:     parts[2],
        formats:      parts.slice(3),
        connection:   null,
        bandwidth:    [],
        attributes:   {},
        controlUrl:   null,
      };
      result.mediaDescriptions.push(media);
      currentMedia = media;
    }
  }

  // Extract control URLs from attributes
  if (result.attributes.control) {
    result.controlUrl = result.attributes.control[0];
  }
  for (const m of result.mediaDescriptions) {
    if (m.attributes.control) m.controlUrl = m.attributes.control[0];
  }

  return result;
}

function parseConnectionLine(value) {
  const parts = value.split(" ");
  return {
    nettype:  parts[0] || "IN",
    addrtype: parts[1] || "IP4",
    address:  parts[2] || "",
  };
}

// ��─ Core RTSP request engine ──────────────────────────────────────────────────
/**
 * Execute a single RTSP method, handling 401 Digest/Basic re-auth automatically.
 *
 * @param {object} params
 * @param {string} params.method
 * @param {string} params.url     - Full RTSP URL (used in request line + Digest URI)
 * @param {string} params.host
 * @param {number} params.port
 * @param {string} params.scheme
 * @param {object} params.extraHeaders  - Additional request headers
 * @param {string|null} params.username
 * @param {string|null} params.password
 * @param {number} params.timeoutMs
 * @param {object} [params.tlsOptions]
 * @returns {Promise<{statusCode, statusText, headers, body, requestsSent}>}
 */
async function rtspRequest(params) {
  const {
    method, url, host, port, scheme,
    extraHeaders, username, password,
    timeoutMs, tlsOptions,
  } = params;

  let cseq = 1;
  const userAgent = "mcp-common-server/rtsp_client";

  // First attempt (no auth)
  const sock1 = await openConnection(scheme, host, port, timeoutMs, tlsOptions);
  try {
    const req1 = buildRequest(method, url, cseq++, Object.assign({ "User-Agent": userAgent }, extraHeaders || {}));
    const raw1  = await sendAndReceive(sock1, req1, timeoutMs);
    const resp1 = parseResponse(raw1);

    // If 401 and we have credentials, retry with auth
    if (resp1.statusCode === 401 && username) {
      const wwwAuth  = resp1.headers["www-authenticate"];
      const challenge = parseWwwAuthenticate(wwwAuth);
      const authHdr   = buildAuthHeader(method, url, username, password || "", challenge);
      if (authHdr) {
        sock1.destroy();
        const sock2 = await openConnection(scheme, host, port, timeoutMs, tlsOptions);
        try {
          const req2 = buildRequest(method, url, cseq++, Object.assign({
            "User-Agent": userAgent,
            "Authorization": authHdr,
          }, extraHeaders || {}));
          const raw2  = await sendAndReceive(sock2, req2, timeoutMs);
          const resp2 = parseResponse(raw2);
          resp2.requestsSent = 2;
          return resp2;
        } finally {
          sock2.destroy();
        }
      }
    }

    resp1.requestsSent = 1;
    return resp1;
  } finally {
    sock1.destroy();
  }
}

// ── Operations ────────────────────────────────────────────────────────────────

/** options — Query server capabilities */
async function opOptions(args) {
  const { parsed, timeoutMs, tlsOptions } = prepareArgs(args);
  const url = buildUrl(parsed, args.url);

  const resp = await rtspRequest({
    method: "OPTIONS",
    url,
    host: parsed.host,
    port: parsed.port,
    scheme: parsed.scheme,
    extraHeaders: args.session_id ? { Session: args.session_id } : {},
    username: args.username || parsed.username,
    password: args.password || parsed.password,
    timeoutMs,
    tlsOptions,
  });

  const publicMethods = (resp.headers["public"] || "").split(",").map(s => s.trim()).filter(Boolean);

  return {
    ok:            resp.statusCode >= 200 && resp.statusCode < 300,
    operation:     "options",
    url,
    statusCode:    resp.statusCode,
    statusText:    resp.statusText,
    publicMethods,
    headers:       resp.headers,
    requestsSent:  resp.requestsSent,
  };
}

/** describe — Fetch SDP session description */
async function opDescribe(args) {
  const { parsed, timeoutMs, tlsOptions } = prepareArgs(args);
  const url = buildUrl(parsed, args.url);

  const resp = await rtspRequest({
    method: "DESCRIBE",
    url,
    host: parsed.host,
    port: parsed.port,
    scheme: parsed.scheme,
    extraHeaders: { Accept: "application/sdp" },
    username: args.username || parsed.username,
    password: args.password || parsed.password,
    timeoutMs,
    tlsOptions,
  });

  const sdp = (resp.statusCode >= 200 && resp.statusCode < 300)
    ? parseSdp(resp.body)
    : null;

  return {
    ok:           resp.statusCode >= 200 && resp.statusCode < 300,
    operation:    "describe",
    url,
    statusCode:   resp.statusCode,
    statusText:   resp.statusText,
    contentType:  resp.headers["content-type"] || null,
    sdp,
    headers:      resp.headers,
    requestsSent: resp.requestsSent,
  };
}

/** setup — Establish a media stream session */
async function opSetup(args) {
  const { parsed, timeoutMs, tlsOptions } = prepareArgs(args);
  const url = buildUrl(parsed, args.url);

  // Determine control URL (track URL)
  const controlUrl = args.control_url || url;

  // Transport header: RTP/AVP;unicast;client_port=<rtp_port>-<rtcp_port>
  const rtpPort  = args.rtp_port  || 0;  // 0 = any available
  const rtcpPort = args.rtcp_port || (rtpPort ? rtpPort + 1 : 0);
  const transport = args.transport ||
    `RTP/AVP;unicast;client_port=${rtpPort}-${rtcpPort}`;

  const extraHeaders = { Transport: transport };
  if (args.session_id) extraHeaders.Session = args.session_id;

  const resp = await rtspRequest({
    method: "SETUP",
    url: controlUrl,
    host: parsed.host,
    port: parsed.port,
    scheme: parsed.scheme,
    extraHeaders,
    username: args.username || parsed.username,
    password: args.password || parsed.password,
    timeoutMs,
    tlsOptions,
  });

  const sessionId = (resp.headers["session"] || "").split(";")[0].trim() || null;
  const serverTransport = resp.headers["transport"] || null;

  return {
    ok:              resp.statusCode >= 200 && resp.statusCode < 300,
    operation:       "setup",
    url:             controlUrl,
    statusCode:      resp.statusCode,
    statusText:      resp.statusText,
    sessionId,
    serverTransport,
    headers:         resp.headers,
    requestsSent:    resp.requestsSent,
  };
}

/** play — Start/resume media delivery */
async function opPlay(args) {
  const { parsed, timeoutMs, tlsOptions } = prepareArgs(args);
  const url = buildUrl(parsed, args.url);

  if (!args.session_id)
    throw new Error("rtsp_client: play requires 'session_id' (from a prior SETUP).");

  const extraHeaders = { Session: args.session_id };
  if (args.range) extraHeaders.Range = args.range;

  const resp = await rtspRequest({
    method: "PLAY",
    url,
    host: parsed.host,
    port: parsed.port,
    scheme: parsed.scheme,
    extraHeaders,
    username: args.username || parsed.username,
    password: args.password || parsed.password,
    timeoutMs,
    tlsOptions,
  });

  return {
    ok:           resp.statusCode >= 200 && resp.statusCode < 300,
    operation:    "play",
    url,
    statusCode:   resp.statusCode,
    statusText:   resp.statusText,
    sessionId:    args.session_id,
    rtpInfo:      resp.headers["rtp-info"] || null,
    range:        resp.headers["range"] || null,
    headers:      resp.headers,
    requestsSent: resp.requestsSent,
  };
}

/** pause — Pause media delivery */
async function opPause(args) {
  const { parsed, timeoutMs, tlsOptions } = prepareArgs(args);
  const url = buildUrl(parsed, args.url);

  if (!args.session_id)
    throw new Error("rtsp_client: pause requires 'session_id' (from a prior SETUP).");

  const resp = await rtspRequest({
    method: "PAUSE",
    url,
    host: parsed.host,
    port: parsed.port,
    scheme: parsed.scheme,
    extraHeaders: { Session: args.session_id },
    username: args.username || parsed.username,
    password: args.password || parsed.password,
    timeoutMs,
    tlsOptions,
  });

  return {
    ok:           resp.statusCode >= 200 && resp.statusCode < 300,
    operation:    "pause",
    url,
    statusCode:   resp.statusCode,
    statusText:   resp.statusText,
    sessionId:    args.session_id,
    headers:      resp.headers,
    requestsSent: resp.requestsSent,
  };
}

/** teardown — End session and release resources */
async function opTeardown(args) {
  const { parsed, timeoutMs, tlsOptions } = prepareArgs(args);
  const url = buildUrl(parsed, args.url);

  if (!args.session_id)
    throw new Error("rtsp_client: teardown requires 'session_id' (from a prior SETUP).");

  const resp = await rtspRequest({
    method: "TEARDOWN",
    url,
    host: parsed.host,
    port: parsed.port,
    scheme: parsed.scheme,
    extraHeaders: { Session: args.session_id },
    username: args.username || parsed.username,
    password: args.password || parsed.password,
    timeoutMs,
    tlsOptions,
  });

  return {
    ok:           resp.statusCode >= 200 && resp.statusCode < 300,
    operation:    "teardown",
    url,
    statusCode:   resp.statusCode,
    statusText:   resp.statusText,
    sessionId:    args.session_id,
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
      name:         "RTSP — Real Time Streaming Protocol",
      version:      "1.0",
      rfcs:         ["RFC 2326 (RTSP)", "RFC 2327 (SDP)", "RFC 2616 (HTTP/1.1 auth)"],
      transport:    "TCP (persistent connection)",
      defaultPorts: { "rtsp:": RTSP_DEFAULT_PORT, "rtsps:": RTSPS_DEFAULT_PORT },
      methods:      ["OPTIONS", "DESCRIBE", "SETUP", "PLAY", "PAUSE", "TEARDOWN"],
    },
    operations: [
      "options   — Query server capabilities (OPTIONS)",
      "describe  — Fetch SDP session description (DESCRIBE)",
      "setup     — Establish a stream session (SETUP)",
      "play      — Start/resume media delivery (PLAY)",
      "pause     — Pause media delivery (PAUSE)",
      "teardown  — End session and release resources (TEARDOWN)",
      "info      — Return this info object (no I/O)",
    ],
    authentication: ["Basic (RFC 7617)", "Digest MD5 (RFC 7616)"],
    sdpFields: [
      "v (version)", "o (origin)", "s (session name)", "i (info)",
      "c (connection)", "b (bandwidth)", "t (timing)", "a (attributes)",
      "m (media description)",
    ],
    defaults: {
      port:         RTSP_DEFAULT_PORT,
      portsPort:    RTSPS_DEFAULT_PORT,
      timeoutMs:    DEFAULT_TIMEOUT_MS,
      maxResponseBytes: MAX_RESPONSE_BYTES,
    },
    notes: [
      "Zero npm dependencies — pure Node.js net/tls/crypto built-ins.",
      "SETUP returns sessionId; pass it to PLAY/PAUSE/TEARDOWN.",
      "DESCRIBE returns SDP parsed into mediaDescriptions with controlUrl per track.",
      "Authentication: Basic and Digest (MD5/qop=auth) are auto-negotiated on 401.",
      "TLS: use rtsps:// scheme for encrypted connections (default port 322).",
    ],
  };
}

// ── Shared helpers ────────────────────────────────────────────────────────────
function prepareArgs(args) {
  const urlStr = (args.url || "").trim();
  if (!urlStr) throw new Error("rtsp_client: 'url' is required.");
  guardNul(urlStr, "url");
  if (args.username) guardNul(args.username, "username");
  if (args.password) guardNul(args.password, "password");

  const parsed = parseRtspUrl(urlStr);
  const timeoutMs = clampTimeout(args.timeout);

  const tlsOptions = {};
  if (typeof args.reject_unauthorized === "boolean") {
    tlsOptions.rejectUnauthorized = args.reject_unauthorized;
  }

  return { parsed, timeoutMs, tlsOptions: Object.keys(tlsOptions).length ? tlsOptions : undefined };
}

/** Build the canonical URL to use in the RTSP request line. */
function buildUrl(parsed, originalUrl) {
  // Use the original URL as the request target (strip credentials)
  if (parsed.username) {
    // Remove userinfo from URL for request line (security: don't send creds in-line)
    const scheme = parsed.scheme;
    const withoutCreds = `${scheme}://${parsed.host}:${parsed.port}${parsed.path}`;
    return withoutCreds;
  }
  return originalUrl.trim();
}

// ── Main entry point ──────────────────────────────────────────────────────────
async function rtspClient(args) {
  const op = (args.operation || "").trim();
  if (!op) throw new Error("rtsp_client: 'operation' is required.");

  switch (op) {
    case "options":  return opOptions(args);
    case "describe": return opDescribe(args);
    case "setup":    return opSetup(args);
    case "play":     return opPlay(args);
    case "pause":    return opPause(args);
    case "teardown": return opTeardown(args);
    case "info":     return opInfo();
    default:
      throw new Error(
        `rtsp_client: unknown operation '${op}'. Valid: options, describe, setup, play, pause, teardown, info.`
      );
  }
}

module.exports = {
  rtspClient,
  // Exported for testing
  parseRtspUrl,
  buildRequest,
  parseResponse,
  parseSdp,
  parseWwwAuthenticate,
  buildAuthHeader,
  clampTimeout,
  guardNul,
  RTSP_DEFAULT_PORT,
  RTSPS_DEFAULT_PORT,
  DEFAULT_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  RTSP_VERSION,
};
