"use strict";
// lib/httpClientOps.js — Stateful HTTP session client (zero npm deps, pure Node.js net/http/https)
//
// Operations: request, get, post, put, patch, delete, head, options, download, session_new, session_clear
//
// Features:
//   - Stateful cookie jar per session (RFC 6265 compliant subset)
//   - Automatic redirect following (up to max_redirects, default 10)
//   - Authentication: Basic, Bearer, Digest
//   - Retry with exponential backoff
//   - Timeout (connect + total)
//   - Proxy support (HTTP CONNECT tunnel for HTTPS)
//   - Body types: JSON, form-urlencoded, multipart/form-data, raw string/Buffer
//   - Response decompression: gzip, deflate, brotli
//   - TLS options: reject_unauthorized, ca, cert, key
//   - Streaming download to file
//   - SSRF guard: block private/loopback IPs (optional)
//   - Header injection prevention (NUL/CRLF in header names/values)
//   - Request/response size caps
//
// Security:
//   - URL validation (must be http:// or https://)
//   - SSRF guard (private IP block, optional)
//   - Header name/value sanitisation (no NUL or CRLF)
//   - Redirect limit
//   - Response body size cap (default 10 MB)

const http    = require("http");
const https   = require("https");
const zlib    = require("zlib");
const fs      = require("fs");
const path    = require("path");
const crypto  = require("crypto");

// ── Constants ────────────────────────────────────────────────────────────────
const DEFAULT_TIMEOUT        = 30_000;   // 30 s
const DEFAULT_MAX_REDIRECTS  = 10;
const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_BODY_BYTES_HARD    = 200 * 1024 * 1024; // 200 MB
const DEFAULT_RETRY_COUNT    = 0;
const DEFAULT_RETRY_DELAY_MS = 500;

// ── Session store (in-process, keyed by session_id) ─────────────────────────
const SESSION_STORE = new Map();
// Each session: { cookies: Map<"host|name"> -> CookieEntry, id: string }

function makeSession(id) {
  return { id, cookies: new Map() };
}

// ── Error helper ─────────────────────────────────────────────────────────────
function err(msg, code) {
  return Object.assign(new Error(msg), { code });
}

// ── URL validation ────────────────────────────────────────────────────────────
function validateUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl)
    throw err("http_client: 'url' must be a non-empty string.", "INVALID_ARG");
  let parsed;
  try { parsed = new URL(rawUrl); }
  catch (e) { throw err(`http_client: invalid URL '${rawUrl}': ${e.message}`, "INVALID_URL"); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw err(`http_client: URL must use http or https scheme, got '${parsed.protocol}'.`, "INVALID_URL");
  return parsed;
}

// ── SSRF guard ───────────────────────────────────────────────────────────────
const PRIVATE_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^::1$/,
  /^fc00:/i,
  /^fd[0-9a-f]{2}:/i,
  /^fe80:/i,
  /^0\.0\.0\.0$/,
  /^localhost$/i,
];

function isPrivateHost(host) {
  const h = host.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  return PRIVATE_RANGES.some(r => r.test(h));
}

// ── Header injection prevention ───────────────────────────────────────────────
function validateHeader(name, value) {
  if (/[\r\n\0]/.test(name))
    throw err(`http_client: header name '${name}' contains illegal characters (NUL/CRLF).`, "INVALID_ARG");
  if (typeof value === "string" && /[\r\n\0]/.test(value))
    throw err(`http_client: header value for '${name}' contains illegal characters (NUL/CRLF).`, "INVALID_ARG");
}

// ── Cookie jar helpers (RFC 6265 subset) ─────────────────────────────────────
function cookieKey(domain, name) { return `${domain}|${name}`; }

function parseCookies(headerVal, domain) {
  // headerVal may be a string (single Set-Cookie) or array
  const vals = Array.isArray(headerVal) ? headerVal : [headerVal];
  const cookies = [];
  for (const h of vals) {
    if (!h) continue;
    const parts = h.split(";").map(s => s.trim());
    const [nameVal, ...attrs] = parts;
    const eqIdx = nameVal.indexOf("=");
    if (eqIdx < 0) continue;
    const name  = nameVal.slice(0, eqIdx).trim();
    const value = nameVal.slice(eqIdx + 1).trim();
    const attrMap = {};
    for (const a of attrs) {
      const ai = a.indexOf("=");
      const k  = ai < 0 ? a.toLowerCase() : a.slice(0, ai).trim().toLowerCase();
      const v  = ai < 0 ? true            : a.slice(ai + 1).trim();
      attrMap[k] = v;
    }
    const cookieDomain = attrMap["domain"]
      ? attrMap["domain"].replace(/^\./, "").toLowerCase()
      : domain.toLowerCase();
    const path_ = attrMap["path"] || "/";
    const secure = !!attrMap["secure"];
    let expires  = null;
    if (attrMap["max-age"]) {
      expires = Date.now() + Number(attrMap["max-age"]) * 1000;
    } else if (attrMap["expires"] && typeof attrMap["expires"] === "string") {
      const d = new Date(attrMap["expires"]);
      if (!isNaN(d.getTime())) expires = d.getTime();
    }
    cookies.push({ name, value, domain: cookieDomain, path: path_, secure, expires });
  }
  return cookies;
}

function storeCookies(session, cookies) {
  for (const c of cookies) {
    if (c.expires !== null && c.expires <= Date.now()) {
      session.cookies.delete(cookieKey(c.domain, c.name));
    } else {
      session.cookies.set(cookieKey(c.domain, c.name), c);
    }
  }
}

function getCookieHeader(session, parsedUrl) {
  const host  = parsedUrl.hostname.toLowerCase();
  const path_ = parsedUrl.pathname || "/";
  const isHttps = parsedUrl.protocol === "https:";
  const valid = [];
  for (const c of session.cookies.values()) {
    if (c.expires !== null && c.expires <= Date.now()) continue;
    if (c.secure && !isHttps) continue;
    if (!host.endsWith(c.domain) && host !== c.domain) continue;
    if (!path_.startsWith(c.path)) continue;
    valid.push(`${c.name}=${c.value}`);
  }
  return valid.join("; ");
}

// ── Body builder ─────────────────────────────────────────────────────────────
function buildBody(args) {
  // Returns { body: Buffer|null, contentType: string|null }
  if (args.json !== undefined && args.json !== null) {
    let str;
    try { str = JSON.stringify(args.json); }
    catch (e) { throw err(`http_client: 'json' is not serialisable: ${e.message}`, "INVALID_ARG"); }
    return { body: Buffer.from(str, "utf8"), contentType: "application/json" };
  }
  if (args.form !== undefined && args.form !== null) {
    if (typeof args.form !== "object" || Array.isArray(args.form))
      throw err("http_client: 'form' must be an object.", "INVALID_ARG");
    const parts = Object.entries(args.form)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    return { body: Buffer.from(parts.join("&"), "utf8"), contentType: "application/x-www-form-urlencoded" };
  }
  if (args.multipart !== undefined && args.multipart !== null) {
    if (!Array.isArray(args.multipart))
      throw err("http_client: 'multipart' must be an array of { name, value, filename?, content_type? }.", "INVALID_ARG");
    const boundary = `----FormBoundary${crypto.randomBytes(12).toString("hex")}`;
    const chunks = [];
    for (const part of args.multipart) {
      if (!part.name) throw err("http_client: each multipart part must have a 'name'.", "INVALID_ARG");
      let cd = `Content-Disposition: form-data; name="${part.name}"`;
      if (part.filename) cd += `; filename="${part.filename}"`;
      chunks.push(Buffer.from(`--${boundary}\r\n`));
      chunks.push(Buffer.from(`${cd}\r\n`));
      if (part.content_type) chunks.push(Buffer.from(`Content-Type: ${part.content_type}\r\n`));
      chunks.push(Buffer.from("\r\n"));
      const val = part.value != null ? Buffer.from(String(part.value), "utf8") : Buffer.alloc(0);
      chunks.push(val);
      chunks.push(Buffer.from("\r\n"));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
  }
  if (args.body !== undefined && args.body !== null) {
    const b = typeof args.body === "string" ? Buffer.from(args.body, "utf8") : Buffer.from(args.body);
    return { body: b, contentType: args.content_type || "text/plain" };
  }
  return { body: null, contentType: null };
}

// ── Digest auth helper ────────────────────────────────────────────────────────
function buildDigestAuth(username, password, method, uri, challenge) {
  const algorithm = (challenge.algorithm || "MD5").toUpperCase();
  const ha1Input  = `${username}:${challenge.realm}:${password}`;
  let ha1 = crypto.createHash("md5").update(ha1Input).digest("hex");
  if (algorithm === "MD5-SESS") {
    ha1 = crypto.createHash("md5").update(`${ha1}:${challenge.nonce}:`).digest("hex");
  }
  const ha2      = crypto.createHash("md5").update(`${method}:${uri}`).digest("hex");
  let response, cnonce = "", nc = "00000001";
  if (challenge.qop && challenge.qop.includes("auth")) {
    cnonce   = crypto.randomBytes(8).toString("hex");
    response = crypto.createHash("md5").update(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:auth:${ha2}`).digest("hex");
  } else {
    response = crypto.createHash("md5").update(`${ha1}:${challenge.nonce}:${ha2}`).digest("hex");
  }
  let header = `Digest username="${username}", realm="${challenge.realm}", nonce="${challenge.nonce}", uri="${uri}", algorithm=${challenge.algorithm || "MD5"}, response="${response}"`;
  if (challenge.qop) header += `, qop=auth, nc=${nc}, cnonce="${cnonce}"`;
  if (challenge.opaque) header += `, opaque="${challenge.opaque}"`;
  return header;
}

function parseDigestChallenge(wwwAuth) {
  const result = {};
  const re = /(\w+)="([^"]*?)"/g;
  let m;
  while ((m = re.exec(wwwAuth)) !== null) result[m[1]] = m[2];
  const qopM = wwwAuth.match(/qop=([^,\s]+)/);
  if (qopM && !result.qop) result.qop = qopM[1];
  return result;
}

// ── Core request executor ─────────────────────────────────────────────────────
function makeRawRequest(opts) {
  return new Promise((resolve, reject) => {
    const { parsedUrl, method, headers, bodyBuf, timeout, tlsOptions = {}, proxyUrl } = opts;
    const isHttps = parsedUrl.protocol === "https:";

    let reqOpts, transport;

    if (proxyUrl) {
      const proxy = new URL(proxyUrl);
      const proxyIsHttps = proxy.protocol === "https:";
      if (isHttps) {
        // CONNECT tunnel
        const host = parsedUrl.hostname;
        const port = parsedUrl.port || 443;
        const connectOpts = {
          host:   proxy.hostname,
          port:   Number(proxy.port || (proxyIsHttps ? 443 : 80)),
          method: "CONNECT",
          path:   `${host}:${port}`,
          headers: { "Host": `${host}:${port}` },
        };
        if (proxy.username) {
          const creds = Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password || "")}`).toString("base64");
          connectOpts.headers["Proxy-Authorization"] = `Basic ${creds}`;
        }
        const connectReq = http.request(connectOpts);
        const timer = setTimeout(() => { connectReq.destroy(); reject(err("http_client: proxy CONNECT timeout.", "TIMEOUT")); }, timeout);
        connectReq.on("connect", (res, socket) => {
          clearTimeout(timer);
          if (res.statusCode !== 200) {
            socket.destroy();
            return reject(err(`http_client: proxy CONNECT failed: ${res.statusCode}`, "PROXY_ERROR"));
          }
          const finalOpts = {
            socket,
            host:     parsedUrl.hostname,
            port:     parsedUrl.port || 443,
            path:     parsedUrl.pathname + parsedUrl.search,
            method,
            headers,
            rejectUnauthorized: tlsOptions.rejectUnauthorized !== false,
            ...(tlsOptions.ca   ? { ca:   tlsOptions.ca }   : {}),
            ...(tlsOptions.cert ? { cert: tlsOptions.cert } : {}),
            ...(tlsOptions.key  ? { key:  tlsOptions.key }  : {}),
          };
          _doRequest(https, finalOpts, bodyBuf, timeout, resolve, reject);
        });
        connectReq.on("error", (e) => { clearTimeout(timer); reject(err(`http_client: proxy error: ${e.message}`, "PROXY_ERROR")); });
        connectReq.end();
        return;
      } else {
        transport = proxyIsHttps ? https : http;
        reqOpts = {
          host:    proxy.hostname,
          port:    Number(proxy.port || (proxyIsHttps ? 443 : 80)),
          path:    parsedUrl.href,
          method,
          headers: { ...headers, "Host": parsedUrl.hostname },
        };
        if (proxy.username) {
          const creds = Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password || "")}`).toString("base64");
          reqOpts.headers["Proxy-Authorization"] = `Basic ${creds}`;
        }
      }
    } else {
      transport = isHttps ? https : http;
      reqOpts = {
        hostname: parsedUrl.hostname,
        port:     parsedUrl.port || (isHttps ? 443 : 80),
        path:     parsedUrl.pathname + parsedUrl.search,
        method,
        headers,
        rejectUnauthorized: tlsOptions.rejectUnauthorized !== false,
        ...(tlsOptions.ca   ? { ca:   tlsOptions.ca }   : {}),
        ...(tlsOptions.cert ? { cert: tlsOptions.cert } : {}),
        ...(tlsOptions.key  ? { key:  tlsOptions.key }  : {}),
      };
    }

    _doRequest(transport, reqOpts, bodyBuf, timeout, resolve, reject);
  });
}

function _doRequest(transport, reqOpts, bodyBuf, timeout, resolve, reject) {
  const req = transport.request(reqOpts, (res) => {
    clearTimeout(timer); // eslint-disable-line no-use-before-define
    const chunks = [];
    res.on("data",  c  => chunks.push(c));
    res.on("end",   () => resolve({ statusCode: res.statusCode, statusMessage: res.statusMessage, headers: res.headers, bodyBuf: Buffer.concat(chunks) }));
    res.on("error", e  => reject(err(`http_client: response error: ${e.message}`, "NETWORK_ERROR")));
  });
  const timer = setTimeout(() => { req.destroy(); reject(err("http_client: request timed out.", "TIMEOUT")); }, timeout);
  req.on("error", (e) => { clearTimeout(timer); reject(err(`http_client: request error: ${e.message}`, "NETWORK_ERROR")); });
  if (bodyBuf && bodyBuf.length > 0) req.write(bodyBuf);
  req.end();
}

// ── Decompress response ───────────────────────────────────────────────────────
function decompressBody(bodyBuf, encoding) {
  if (!encoding) return Promise.resolve(bodyBuf);
  const enc = encoding.toLowerCase();
  return new Promise((resolve, reject) => {
    if (enc === "gzip" || enc === "x-gzip") {
      zlib.gunzip(bodyBuf, (e, r) => e ? reject(err(`http_client: gzip decompression failed: ${e.message}`, "DECOMPRESS_ERROR")) : resolve(r));
    } else if (enc === "deflate") {
      zlib.inflate(bodyBuf, (e, r) => {
        if (e) {
          zlib.inflateRaw(bodyBuf, (e2, r2) => e2 ? reject(err(`http_client: deflate decompression failed: ${e2.message}`, "DECOMPRESS_ERROR")) : resolve(r2));
        } else resolve(r);
      });
    } else if (enc === "br") {
      zlib.brotliDecompress(bodyBuf, (e, r) => e ? reject(err(`http_client: brotli decompression failed: ${e.message}`, "DECOMPRESS_ERROR")) : resolve(r));
    } else {
      resolve(bodyBuf);
    }
  });
}

// ── Response body to string safely ───────────────────────────────────────────
function bufToText(buf) {
  try {
    const s = buf.toString("utf8");
    if (Buffer.from(s, "utf8").equals(buf)) return s;
  } catch {}
  return buf.toString("latin1");
}

// ── Try parse JSON ────────────────────────────────────────────────────────────
function tryParseJSON(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── High-level HTTP request with redirects, cookies, retry, auth ──────────────
async function doRequest(args) {
  const rawUrl = args.url;
  if (!rawUrl) throw err("http_client: 'url' is required.", "INVALID_ARG");

  const parsedUrlInitial = validateUrl(rawUrl);
  const method           = (args.method || "GET").toUpperCase();
  const timeout          = Math.max(1000, args.timeout || DEFAULT_TIMEOUT);
  const maxRedirects     = args.follow_redirects === false ? 0
    : (args.max_redirects != null ? args.max_redirects : DEFAULT_MAX_REDIRECTS);
  const retryCount  = args.retry_count  != null ? args.retry_count  : DEFAULT_RETRY_COUNT;
  const retryDelay  = args.retry_delay_ms != null ? args.retry_delay_ms : DEFAULT_RETRY_DELAY_MS;
  const maxBodyBytes = Math.min(
    args.max_response_bytes != null ? args.max_response_bytes : DEFAULT_MAX_BODY_BYTES,
    MAX_BODY_BYTES_HARD,
  );

  // SSRF guard
  if (args.ssrf_guard !== false) {
    if (isPrivateHost(parsedUrlInitial.hostname))
      throw err(`http_client: SSRF guard blocked request to private/loopback host '${parsedUrlInitial.hostname}'.`, "SSRF_BLOCKED");
  }

  // Session
  let session = null;
  if (args.session_id) {
    session = SESSION_STORE.get(args.session_id);
    if (!session) {
      session = makeSession(args.session_id);
      SESSION_STORE.set(args.session_id, session);
    }
  }

  // Build request headers
  const reqHeaders = {
    "User-Agent": "mcp-common-server/http_client",
    "Accept-Encoding": "gzip, deflate, br",
  };
  const callerHeaders = args.headers || {};
  for (const [k, v] of Object.entries(callerHeaders)) {
    validateHeader(k, v);
    reqHeaders[k.toLowerCase()] = String(v);
  }

  // Build body
  const { body: bodyBuf, contentType } = buildBody(args);
  if (bodyBuf) {
    if (!reqHeaders["content-type"] && contentType) reqHeaders["content-type"] = contentType;
    reqHeaders["content-length"] = String(bodyBuf.length);
  }

  // TLS options
  const tlsOptions = {
    rejectUnauthorized: args.reject_unauthorized !== false,
    ...(args.ca   ? { ca:   args.ca }   : {}),
    ...(args.cert ? { cert: args.cert } : {}),
    ...(args.key  ? { key:  args.key }  : {}),
  };

  // Auth
  const auth = args.auth || null;
  let digestChallenge = null;

  function applyAuth(headers, parsedUrl_) {
    if (!auth) return;
    if (auth.type === "basic") {
      const creds = Buffer.from(`${auth.username || ""}:${auth.password || ""}`).toString("base64");
      headers["authorization"] = `Basic ${creds}`;
    } else if (auth.type === "bearer") {
      headers["authorization"] = `Bearer ${auth.token || ""}`;
    } else if (auth.type === "digest" && digestChallenge) {
      const uri = parsedUrl_.pathname + parsedUrl_.search;
      headers["authorization"] = buildDigestAuth(auth.username || "", auth.password || "", method, uri, digestChallenge);
    }
  }

  // ── Request loop ─────────────────────────────────────────────────────────
  let currentUrl    = parsedUrlInitial;
  let redirectCount = 0;
  let currentMethod = method;
  let currentBody   = bodyBuf;
  let rawResp;

  while (true) {
    // Cookie header
    if (session) {
      const cookieHdr = getCookieHeader(session, currentUrl);
      if (cookieHdr) reqHeaders["cookie"] = cookieHdr;
    }
    applyAuth(reqHeaders, currentUrl);

    // Retry loop
    for (let t = 0; t <= retryCount; t++) {
      if (t > 0) await sleep(retryDelay * Math.pow(2, t - 1));
      try {
        rawResp = await makeRawRequest({
          parsedUrl: currentUrl, method: currentMethod, headers: reqHeaders,
          bodyBuf: currentBody, timeout, tlsOptions, proxyUrl: args.proxy,
        });
        break;
      } catch (e) {
        if (t === retryCount) throw e;
      }
    }

    // Store cookies
    if (session && rawResp.headers["set-cookie"]) {
      storeCookies(session, parseCookies(rawResp.headers["set-cookie"], currentUrl.hostname));
    }

    // Digest auth retry (first 401)
    if (rawResp.statusCode === 401 && auth && auth.type === "digest" && !digestChallenge) {
      const wwwAuth = rawResp.headers["www-authenticate"] || "";
      if (wwwAuth.startsWith("Digest ")) {
        digestChallenge = parseDigestChallenge(wwwAuth);
        applyAuth(reqHeaders, currentUrl);
        rawResp = await makeRawRequest({
          parsedUrl: currentUrl, method: currentMethod, headers: reqHeaders,
          bodyBuf: currentBody, timeout, tlsOptions, proxyUrl: args.proxy,
        });
        if (session && rawResp.headers["set-cookie"])
          storeCookies(session, parseCookies(rawResp.headers["set-cookie"], currentUrl.hostname));
      }
    }

    // Redirect handling
    const status = rawResp.statusCode;
    const locationHdr = rawResp.headers["location"];
    if ([301, 302, 303, 307, 308].includes(status) && locationHdr && args.follow_redirects !== false && maxRedirects > 0) {
      if (redirectCount >= maxRedirects)
        throw err(`http_client: too many redirects (max ${maxRedirects}).`, "TOO_MANY_REDIRECTS");
      redirectCount++;
      try { currentUrl = new URL(locationHdr, currentUrl.href); }
      catch (e) { throw err(`http_client: invalid redirect location '${locationHdr}'.`, "INVALID_URL"); }
      // 301/302/303 convert non-GET/HEAD to GET, drop body
      if ([301, 302, 303].includes(status) && currentMethod !== "HEAD") {
        currentMethod = "GET";
        currentBody   = null;
        delete reqHeaders["content-type"];
        delete reqHeaders["content-length"];
      }
      // Re-check SSRF for new URL
      if (args.ssrf_guard !== false && isPrivateHost(currentUrl.hostname))
        throw err(`http_client: SSRF guard blocked redirect to '${currentUrl.hostname}'.`, "SSRF_BLOCKED");
      continue;
    }

    // Decompress
    let bodyBufDec;
    try {
      bodyBufDec = await decompressBody(rawResp.bodyBuf, rawResp.headers["content-encoding"]);
    } catch {
      bodyBufDec = rawResp.bodyBuf;
    }

    // Cap response body
    if (bodyBufDec.length > maxBodyBytes)
      throw err(
        `http_client: response body too large (${bodyBufDec.length} bytes; max ${maxBodyBytes}).`,
        "RESPONSE_TOO_LARGE",
      );

    const ct       = rawResp.headers["content-type"] || "";
    const textBody = bufToText(bodyBufDec);
    const jsonBody = ct.includes("json") ? tryParseJSON(textBody) : null;

    return {
      statusCode:    rawResp.statusCode,
      statusMessage: rawResp.statusMessage,
      headers:       rawResp.headers,
      body:          textBody,
      json:          jsonBody,
      redirects:     redirectCount,
      url:           currentUrl.href,
      byteLength:    bodyBufDec.length,
    };
  }
}

// ── Download operation ────────────────────────────────────────────────────────
async function doDownload(args) {
  if (!args.download_path)
    throw err("http_client: 'download_path' is required for 'download' operation.", "INVALID_ARG");

  const rawUrl = args.url;
  if (!rawUrl) throw err("http_client: 'url' is required.", "INVALID_ARG");
  const parsedUrl = validateUrl(rawUrl);
  if (args.ssrf_guard !== false && isPrivateHost(parsedUrl.hostname))
    throw err(`http_client: SSRF guard blocked request to '${parsedUrl.hostname}'.`, "SSRF_BLOCKED");

  const timeout    = Math.max(1000, args.timeout || DEFAULT_TIMEOUT);
  const tlsOptions = { rejectUnauthorized: args.reject_unauthorized !== false };
  const reqHeaders = { "User-Agent": "mcp-common-server/http_client" };
  if (args.headers) Object.assign(reqHeaders, args.headers);
  if (args.auth) {
    if (args.auth.type === "bearer") reqHeaders["authorization"] = `Bearer ${args.auth.token || ""}`;
    if (args.auth.type === "basic") {
      const creds = Buffer.from(`${args.auth.username || ""}:${args.auth.password || ""}`).toString("base64");
      reqHeaders["authorization"] = `Basic ${creds}`;
    }
  }

  const destPath     = args.download_path;
  const destResolved = path.resolve(destPath);
  if (destResolved.includes("\0"))
    throw err("http_client: 'download_path' must not contain NUL bytes.", "INVALID_ARG");

  const maxRedirects = args.max_redirects != null ? args.max_redirects : DEFAULT_MAX_REDIRECTS;
  let currentUrl     = parsedUrl;
  let redirectCount  = 0;

  while (true) {
    const raw = await makeRawRequest({
      parsedUrl: currentUrl, method: "GET", headers: reqHeaders,
      bodyBuf: null, timeout, tlsOptions, proxyUrl: args.proxy,
    });
    const loc = raw.headers["location"];
    if ([301, 302, 303, 307, 308].includes(raw.statusCode) && loc) {
      if (redirectCount++ >= maxRedirects)
        throw err(`http_client: too many redirects (max ${maxRedirects}).`, "TOO_MANY_REDIRECTS");
      currentUrl = new URL(loc, currentUrl.href);
      continue;
    }
    let body;
    try { body = await decompressBody(raw.bodyBuf, raw.headers["content-encoding"]); }
    catch { body = raw.bodyBuf; }
    fs.mkdirSync(path.dirname(destResolved), { recursive: true });
    fs.writeFileSync(destResolved, body);
    return {
      url:           currentUrl.href,
      statusCode:    raw.statusCode,
      statusMessage: raw.statusMessage,
      download_path: destPath,
      byteLength:    body.length,
      redirects:     redirectCount,
    };
  }
}

// ── Session operations ────────────────────────────────────────────────────────
function opSessionNew(args) {
  const id = args.session_id || `session_${crypto.randomBytes(8).toString("hex")}`;
  if (SESSION_STORE.has(id)) {
    SESSION_STORE.get(id).cookies.clear();
  } else {
    SESSION_STORE.set(id, makeSession(id));
  }
  return { session_id: id, cookieCount: 0, created: true };
}

function opSessionClear(args) {
  const id = args.session_id;
  if (!id) {
    const count = SESSION_STORE.size;
    SESSION_STORE.clear();
    return { cleared: count, all: true };
  }
  const existed = SESSION_STORE.has(id);
  SESSION_STORE.delete(id);
  return { session_id: id, cleared: existed ? 1 : 0 };
}

// ── Main dispatcher ───────────────────────────────────────────────────────────
async function httpClient(args) {
  if (!args || !args.operation)
    throw err("http_client: 'operation' is required.", "INVALID_ARG");

  switch (args.operation) {
    case "get":      return doRequest({ ...args, method: "GET" });
    case "post":     return doRequest({ ...args, method: "POST" });
    case "put":      return doRequest({ ...args, method: "PUT" });
    case "patch":    return doRequest({ ...args, method: "PATCH" });
    case "delete":   return doRequest({ ...args, method: "DELETE" });
    case "head":     return doRequest({ ...args, method: "HEAD" });
    case "options":  return doRequest({ ...args, method: "OPTIONS" });
    case "request":
      if (!args.method) throw err("http_client: 'method' is required for 'request' operation.", "INVALID_ARG");
      return doRequest(args);
    case "download":      return doDownload(args);
    case "session_new":   return opSessionNew(args);
    case "session_clear": return opSessionClear(args);
    default:
      throw err(
        `http_client: unknown operation '${args.operation}'. Valid: request, get, post, put, patch, delete, head, options, download, session_new, session_clear.`,
        "INVALID_ARG",
      );
  }
}

module.exports = {
  httpClient,
  // Exported for testing
  validateUrl,
  isPrivateHost,
  validateHeader,
  parseCookies,
  storeCookies,
  getCookieHeader,
  buildBody,
  buildDigestAuth,
  parseDigestChallenge,
  decompressBody,
  bufToText,
  tryParseJSON,
  makeSession,
  SESSION_STORE,
};
