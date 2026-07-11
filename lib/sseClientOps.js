"use strict";
// ── SSE_CLIENT — Server-Sent Events client ────────────────────────────────────
// Zero npm dependencies — uses Node.js built-in http/https modules.
// Connects to an SSE endpoint (text/event-stream), parses the stream,
// and returns collected events. Supports filtering by event type and
// resuming from a Last-Event-ID.

const http    = require("http");
const https   = require("https");
const { URL } = require("url");
const { ToolError } = require("./errors");

const DEFAULT_TIMEOUT_S    = 10;
const MAX_TIMEOUT_S        = 120;
const DEFAULT_MAX_EVENTS   = 100;
const MAX_EVENTS           = 5000;
const MAX_EVENT_DATA_BYTES = 512 * 1024; // 512 KB per event data field
const MAX_TOTAL_BYTES      = 10 * 1024 * 1024; // 10 MB total
const MAX_EXTRA_HEADERS    = 30;
const MAX_HEADER_VALUE_LEN = 4000;

// ── Input validation ────────────────────────────────────────────────────────
function validateInputs(opts) {
  const url = opts.url;
  if (!url || typeof url !== "string") {
    throw new ToolError("sse_client: 'url' is required and must be a string.", -32602);
  }
  if (!/^https?:\/\//i.test(url)) {
    throw new ToolError("sse_client: 'url' must start with http:// or https://.", -32602);
  }
  if (/[\r\n]/.test(url)) {
    throw new ToolError("sse_client: 'url' must not contain newline characters.", -32602);
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch (_) {
    throw new ToolError(`sse_client: invalid URL: ${url}`, -32602);
  }

  let timeout = DEFAULT_TIMEOUT_S;
  if (opts.timeout !== undefined) {
    if (typeof opts.timeout !== "number" || !Number.isFinite(opts.timeout) || opts.timeout <= 0) {
      throw new ToolError("sse_client: 'timeout' must be a positive number of seconds.", -32602);
    }
    timeout = Math.min(opts.timeout, MAX_TIMEOUT_S);
  }

  let maxEvents = DEFAULT_MAX_EVENTS;
  if (opts.max_events !== undefined) {
    if (typeof opts.max_events !== "number" || !Number.isInteger(opts.max_events) || opts.max_events < 1) {
      throw new ToolError("sse_client: 'max_events' must be a positive integer.", -32602);
    }
    maxEvents = Math.min(opts.max_events, MAX_EVENTS);
  }

  const headers = opts.headers ?? {};
  if (typeof headers !== "object" || Array.isArray(headers)) {
    throw new ToolError("sse_client: 'headers' must be a plain object.", -32602);
  }
  if (Object.keys(headers).length > MAX_EXTRA_HEADERS) {
    throw new ToolError(`sse_client: 'headers' may have at most ${MAX_EXTRA_HEADERS} entries.`, -32602);
  }
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v !== "string" && typeof v !== "number") {
      throw new ToolError(`sse_client: headers['${k}'] must be a string or number.`, -32602);
    }
    if (String(v).length > MAX_HEADER_VALUE_LEN || /[\r\n]/.test(String(v))) {
      throw new ToolError(`sse_client: headers['${k}'] contains invalid characters or is too long.`, -32602);
    }
    const kLower = k.toLowerCase();
    if (["accept", "cache-control"].includes(kLower)) {
      throw new ToolError(
        `sse_client: cannot override reserved header '${k}'. These are set automatically.`, -32602,
      );
    }
  }

  const eventTypes = opts.event_types;
  if (eventTypes !== undefined) {
    if (!Array.isArray(eventTypes)) {
      throw new ToolError("sse_client: 'event_types' must be an array of strings.", -32602);
    }
    for (const t of eventTypes) {
      if (typeof t !== "string" || t.length === 0) {
        throw new ToolError("sse_client: each entry in 'event_types' must be a non-empty string.", -32602);
      }
    }
  }

  const lastEventId = opts.last_event_id;
  if (lastEventId !== undefined && typeof lastEventId !== "string") {
    throw new ToolError("sse_client: 'last_event_id' must be a string.", -32602);
  }

  return { url, parsedUrl, timeout, maxEvents, headers, eventTypes: eventTypes ?? null, lastEventId: lastEventId ?? null };
}

// ── SSE line-based parser (RFC 8895) ───────────────────────────────────────
class SseParser {
  constructor() {
    this._buf       = "";
    this._events    = [];
    this._current   = this._blankEvent();
    this._lastId    = "";
  }

  _blankEvent() {
    return { id: null, event: "message", data: "", retry: null, _hasData: false };
  }

  push(text) {
    this._buf += text;
    this._processLines();
  }

  _processLines() {
    // Split on LF, CRLF, or CR per SSE spec
    const lines = this._buf.split(/\n|\r\n|\r/);
    // Last element is incomplete line (re-buffer it)
    this._buf = lines.pop();

    for (const raw of lines) {
      if (raw === "") {
        // Empty line: dispatch event
        this._dispatch();
      } else if (raw.startsWith(":")) {
        // Comment — ignore
      } else {
        const colonPos = raw.indexOf(":");
        let field, value;
        if (colonPos === -1) {
          field = raw;
          value = "";
        } else {
          field = raw.slice(0, colonPos);
          // Single optional space after colon per spec
          value = raw.slice(colonPos + 1).replace(/^ /, "");
        }
        this._processField(field, value);
      }
    }
  }

  _processField(field, value) {
    const c = this._current;
    switch (field) {
      case "id":
        // Only set if value doesn't contain null byte
        if (!value.includes("\0")) {
          c.id        = value;
          this._lastId = value;
        }
        break;
      case "event":
        c.event = value;
        break;
      case "data":
        c._hasData = true;
        c.data     = c.data === "" ? value : c.data + "\n" + value;
        break;
      case "retry":
        if (/^\d+$/.test(value)) c.retry = parseInt(value, 10);
        break;
      // Unknown fields are ignored per spec
    }
  }

  _dispatch() {
    const c = this._current;
    this._current = this._blankEvent();
    this._current.id = this._lastId || null; // inherit last id
    if (!c._hasData) return; // No data field — don't dispatch
    // Remove trailing newline from data per spec
    const data = c.data.replace(/\n$/, "");
    this._events.push({
      id:        c.id,
      event:     c.event,
      data,
      retry:     c.retry,
    });
  }

  shift() {
    return this._events.shift() ?? null;
  }

  get eventCount() {
    return this._events.length;
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────
/**
 * @param {object}   opts
 * @param {string}   opts.url            http:// or https:// SSE endpoint
 * @param {object}   [opts.headers]      extra HTTP request headers
 * @param {number}   [opts.timeout]      seconds to collect events (default 10, max 120)
 * @param {number}   [opts.max_events]   max events to collect (default 100, max 5000)
 * @param {string[]} [opts.event_types]  only include events with these 'event' field values
 * @param {string}   [opts.last_event_id] sent as Last-Event-ID header to resume a stream
 * @returns {Promise<object>}
 */
function sseClient(opts = {}) {
  const { url, parsedUrl, timeout, maxEvents, headers, eventTypes, lastEventId }
    = validateInputs(opts);

  return new Promise((resolve) => {
    const startMs   = Date.now();
    const events    = [];
    let   totalBytes = 0;
    let   truncated  = false;
    let   connected  = false;
    let   status     = null;
    let   settled    = false;
    let   timer      = null;
    let   req        = null;

    function finish(error) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (req) { try { req.destroy(); } catch (_) {} }

      const result = {
        url,
        connected,
        status,
        eventCount: events.length,
        events,
        truncated,
        elapsedMs: Date.now() - startMs,
      };
      if (error) result.error = String(error);
      resolve(result);
    }

    timer = setTimeout(() => finish(), timeout * 1000);

    const lib     = parsedUrl.protocol === "https:" ? https : http;
    const port    = parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80);
    const reqHdrs = {
      ...headers,
      "Accept":        "text/event-stream",
      "Cache-Control": "no-cache",
    };
    if (lastEventId !== null) reqHdrs["Last-Event-ID"] = lastEventId;

    const reqOpts = {
      method:   "GET",
      hostname: parsedUrl.hostname,
      port,
      path:     parsedUrl.pathname + parsedUrl.search,
      headers:  reqHdrs,
      rejectUnauthorized: false,
    };

    const parser = new SseParser();

    function processEvents() {
      let ev;
      while ((ev = parser.shift()) !== null) {
        if (settled) break;
        // Apply event type filter
        if (eventTypes !== null && !eventTypes.includes(ev.event)) continue;
        events.push({
          index:     events.length,
          id:        ev.id,
          event:     ev.event,
          data:      ev.data,
          timestamp: Date.now(),
        });
        if (events.length >= maxEvents) {
          truncated = true;
          finish();
          return;
        }
      }
    }

    try {
      req = lib.request(reqOpts, (res) => {
        status = res.statusCode;

        const contentType = (res.headers["content-type"] || "").toLowerCase();
        if (!contentType.includes("text/event-stream")) {
          // Read and discard the body so the socket is released
          res.resume();
          finish(`Expected content-type text/event-stream, got: ${contentType || "(none)"}`);
          return;
        }

        if (status < 200 || status >= 300) {
          res.resume();
          finish(`Server returned HTTP ${status}`);
          return;
        }

        connected = true;
        res.setEncoding("utf8");

        res.on("data", (chunk) => {
          if (settled) return;
          totalBytes += Buffer.byteLength(chunk, "utf8");
          if (totalBytes > MAX_TOTAL_BYTES) {
            finish("SSE stream exceeded total byte limit");
            return;
          }
          parser.push(chunk);
          processEvents();
        });

        res.on("end",   () => { if (!settled) finish(); });
        res.on("error", (e) => { if (!settled) finish(e.message); });
      });

      req.on("error", (e) => { if (!settled) finish(e.message); });
      req.end();
    } catch (e) {
      finish(e.message);
    }
  });
}

module.exports = { sseClient, SseParser };
