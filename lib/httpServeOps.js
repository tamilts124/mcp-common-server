"use strict";
// ── HTTP_SERVE — start/manage temporary in-process mock HTTP servers ────────────
//
// Spin up a lightweight Node.js http.Server as a "session" (like browser
// sessions or background processes). Each session:
//   • Listens on a random or caller-specified port
//   • Holds an ordered list of route definitions (method + path pattern → response)
//   • Captures every incoming request (method, path, headers, body)
//   • Responds 404 when no route matches
//
// Use cases:
//   • Webhook receivers — start a server, trigger an external webhook call,
//     poll with operation:'requests' to see what arrived
//   • API mocking — configure routes before running browser automation
//   • Integration-test helpers — verify outbound HTTP from run_command payloads
//
// Does NOT require MCP_ALLOW_EXEC — everything is in-process Node http module.
// Sessions must be explicitly stopped (operation:'stop') to free the port.

const http   = require("http");
const crypto = require("crypto");
const { ToolError } = require("./errors");

// ── Session store ────────────────────────────────────────────────────────────────────────
/** @type {Map<string, MockServerSession>} */
const SERVERS = new Map();

/**
 * @typedef {object} RouteDefinition
 * @property {string}  method       — HTTP method or '*' for any
 * @property {string}  path         — Exact path, prefix (ends with *), or '*' for any
 * @property {number}  [status]     — Response status code (default 200)
 * @property {object}  [headers]    — Extra response headers
 * @property {string}  [body]       — Response body string
 * @property {number}  [delay_ms]   — Artificial delay before responding (0– 5000 ms)
 */

/**
 * @typedef {object} CapturedRequest
 * @property {string}  id
 * @property {string}  timestamp
 * @property {string}  method
 * @property {string}  path
 * @property {object}  headers
 * @property {string}  body
 * @property {number}  bodySize
 * @property {boolean} matched      — true if a route was matched
 * @property {string|null} matchedRoute — `"METHOD path"` label of the matched route
 */

/**
 * @typedef {object} MockServerSession
 * @property {string}              id
 * @property {http.Server}         server
 * @property {number}              port
 * @property {RouteDefinition[]}   routes
 * @property {CapturedRequest[]}   requests
 * @property {string}              startedAt
 * @property {boolean}             active
 */

// ── Route helpers ───────────────────────────────────────────────────────────────────────

const MAX_DELAY_MS     = 5000;
const MAX_REQUEST_BODY = 1 * 1024 * 1024; // 1 MB cap per captured request body
const MAX_CAPTURED     = 1000;            // max requests stored per session
const MAX_ROUTES       = 200;

function normalizeMethod(m) {
  return typeof m === "string" && m.trim() ? m.trim().toUpperCase() : "*";
}

/**
 * Match an incoming path against a route pattern.
 * Patterns:
 *   '*'          — match everything
 *   '/exact'     — exact match
 *   '/prefix/*'  — prefix match (everything starting with /prefix/)
 */
function matchPath(incoming, pattern) {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) {
    return incoming.startsWith(pattern.slice(0, -1));
  }
  return incoming === pattern;
}

function findRoute(routes, method, path) {
  for (const r of routes) {
    const rm = normalizeMethod(r.method);
    if (rm !== "*" && rm !== method.toUpperCase()) continue;
    if (!matchPath(path, r.path || "*")) continue;
    return r;
  }
  return null;
}

function validateRoute(r) {
  if (!r || typeof r !== "object") throw new ToolError("http_serve: route must be an object.", -32602);
  // path is required
  if (typeof r.path !== "string" || r.path.trim() === "") {
    throw new ToolError("http_serve: route.path must be a non-empty string (use '*' for catch-all).", -32602);
  }
  if (r.status != null && (typeof r.status !== "number" || r.status < 100 || r.status > 599)) {
    throw new ToolError(`http_serve: route.status must be 100–599, got ${r.status}.`, -32602);
  }
  if (r.delay_ms != null && (typeof r.delay_ms !== "number" || r.delay_ms < 0 || r.delay_ms > MAX_DELAY_MS)) {
    throw new ToolError(`http_serve: route.delay_ms must be 0–${MAX_DELAY_MS}.`, -32602);
  }
  if (r.headers != null && (typeof r.headers !== "object" || Array.isArray(r.headers))) {
    throw new ToolError("http_serve: route.headers must be a plain object.", -32602);
  }
}

function getSession(sessionId) {
  if (!sessionId || typeof sessionId !== "string") {
    throw new ToolError("http_serve: 'session_id' is required.", -32602);
  }
  const session = SERVERS.get(sessionId);
  if (!session) throw new ToolError(`http_serve: no session with id '${sessionId}'.`, -32602);
  return session;
}

// ── Request handler factory ─────────────────────────────────────────────────────────────

function createRequestHandler(session) {
  return function(req, res) {
    const reqPath = (req.url || "/").split("?")[0] || "/"; // strip query string for routing
    const method  = req.method || "GET";

    // Buffer the request body (capped)
    const bodyChunks = [];
    let bodySize = 0;
    let bodyTruncated = false;

    req.on("data", (chunk) => {
      if (bodyTruncated) return;
      if (bodySize + chunk.length > MAX_REQUEST_BODY) {
        const rem = MAX_REQUEST_BODY - bodySize;
        if (rem > 0) bodyChunks.push(chunk.slice(0, rem));
        bodyTruncated = true;
        bodySize = MAX_REQUEST_BODY;
      } else {
        bodyChunks.push(chunk);
        bodySize += chunk.length;
      }
    });

    req.on("end", () => {
      const bodyStr = Buffer.concat(bodyChunks).toString("utf8") + (bodyTruncated ? "\n...[truncated]" : "");

      // Find a matching route
      const route   = findRoute(session.routes, method, reqPath);
      const matched = route !== null;
      const matchedRoute = matched ? `${normalizeMethod(route.method)} ${route.path}` : null;

      // Capture
      if (session.requests.length < MAX_CAPTURED) {
        session.requests.push({
          id:           crypto.randomUUID(),
          timestamp:    new Date().toISOString(),
          method,
          path:         req.url || "/",
          headers:      Object.fromEntries(Object.entries(req.headers)),
          body:         bodyStr,
          bodySize,
          bodyTruncated,
          matched,
          matchedRoute,
        });
      }

      const respond = () => {
        const status  = route ? (route.status || 200) : 404;
        const resBody = route ? (route.body != null ? String(route.body) : "") : "{\"error\":\"no route matched\"}";

        // Merge user-supplied response headers
        const extraHeaders = (route && route.headers) ? route.headers : {};
        res.writeHead(status, {
          "content-type":   "application/json",
          "x-mcp-mock":     "1",
          "x-session-id":   session.id,
          ...Object.fromEntries(
            Object.entries(extraHeaders).map(([k, v]) => [k.toLowerCase(), String(v)])
          ),
          "content-length": Buffer.byteLength(resBody, "utf8").toString(),
        });
        res.end(resBody);
      };

      const delay = (route && route.delay_ms) ? Math.min(route.delay_ms, MAX_DELAY_MS) : 0;
      if (delay > 0) {
        setTimeout(respond, delay);
      } else {
        respond();
      }
    });

    req.on("error", () => {
      try { res.writeHead(400); res.end(); } catch (_) {}
    });
  };
}

// ── Operations ───────────────────────────────────────────────────────────────────────────

/** operation: 'start' */
function opStart(args) {
  const routes = args.routes || [];
  if (!Array.isArray(routes)) {
    throw new ToolError("http_serve: 'routes' must be an array.", -32602);
  }
  if (routes.length > MAX_ROUTES) {
    throw new ToolError(`http_serve: too many routes (${routes.length} > ${MAX_ROUTES}).`, -32602);
  }
  routes.forEach(validateRoute);

  // Validate port
  let port = args.port != null ? parseInt(args.port, 10) : 0; // 0 = OS picks
  if (isNaN(port) || port < 0 || port > 65535) {
    throw new ToolError(`http_serve: invalid port '${args.port}'.`, -32602);
  }

  const id      = crypto.randomUUID();
  const session = {
    id,
    server:    null,
    port:      null,
    routes:    [...routes],
    requests:  [],
    startedAt: new Date().toISOString(),
    active:    false,
  };

  const server = http.createServer(createRequestHandler(session));
  session.server = server;

  return new Promise((resolve, reject) => {
    server.on("error", (err) => {
      reject(new ToolError(
        `http_serve: failed to start server on port ${port} — ${err.message}`, -32603));
    });

    server.listen(port, "127.0.0.1", () => {
      const actualPort = server.address().port;
      session.port   = actualPort;
      session.active = true;
      SERVERS.set(id, session);
      console.error(`[HTTP_SERVE] Session ${id} started on port ${actualPort}`);
      resolve({
        session_id:   id,
        url:          `http://127.0.0.1:${actualPort}`,
        port:         actualPort,
        routes_count: session.routes.length,
        startedAt:    session.startedAt,
      });
    });
  });
}

/** operation: 'stop' */
function opStop(args) {
  const session = getSession(args.session_id);
  if (!session.active) {
    return { session_id: session.id, status: "already_stopped" };
  }
  return new Promise((resolve) => {
    session.server.close(() => {
      session.active = false;
      SERVERS.delete(session.id);
      console.error(`[HTTP_SERVE] Session ${session.id} stopped`);
      resolve({
        session_id:      session.id,
        status:          "stopped",
        requests_captured: session.requests.length,
      });
    });
    // Force-close keep-alive connections
    try { session.server.closeAllConnections?.(); } catch (_) {}
  });
}

/** operation: 'status' */
function opStatus() {
  const list = [];
  for (const [id, s] of SERVERS) {
    list.push({
      session_id:       id,
      url:              `http://127.0.0.1:${s.port}`,
      port:             s.port,
      active:           s.active,
      routes_count:     s.routes.length,
      requests_captured: s.requests.length,
      startedAt:        s.startedAt,
    });
  }
  return { sessions: list, count: list.length };
}

/** operation: 'requests' */
function opRequests(args) {
  const session = getSession(args.session_id);
  const limit   = typeof args.limit === "number" ? Math.max(1, Math.min(args.limit, MAX_CAPTURED)) : MAX_CAPTURED;
  const reqs    = session.requests.slice(-limit);

  if (args.clear) session.requests = [];

  return {
    session_id:       session.id,
    total_captured:   session.requests.length + (args.clear ? reqs.length : 0),
    returned:         reqs.length,
    cleared:          !!args.clear,
    requests:         reqs,
  };
}

/** operation: 'add_route' */
function opAddRoute(args) {
  const session = getSession(args.session_id);
  if (!session.active) {
    throw new ToolError(`http_serve: session '${args.session_id}' is not active.`, -32602);
  }
  if (session.routes.length >= MAX_ROUTES) {
    throw new ToolError(`http_serve: session already has ${MAX_ROUTES} routes (maximum).`, -32602);
  }
  const route = args.route;
  validateRoute(route);
  // prepend so newly-added routes take priority
  session.routes.unshift({ ...route });
  return {
    session_id:   session.id,
    routes_count: session.routes.length,
    added:        { method: normalizeMethod(route.method), path: route.path },
  };
}

/** operation: 'clear_requests' */
function opClearRequests(args) {
  const session = getSession(args.session_id);
  const cleared = session.requests.length;
  session.requests = [];
  return { session_id: session.id, cleared };
}

/**
 * operation: 'wait'
 * Block until a request matching path_match / method_match arrives, or timeout.
 */
function opWait(args) {
  const session = getSession(args.session_id);
  const timeoutMs = typeof args.timeout === "number" ? Math.min(args.timeout, 60) * 1000 : 10000;
  const startIdx  = session.requests.length; // only watch requests that arrive after 'wait' starts
  const pathMatch  = args.path_match  ? String(args.path_match)  : null;
  const methodMatch = args.method_match ? String(args.method_match).toUpperCase() : null;

  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;

    function check() {
      // Search from startIdx onward
      for (let i = startIdx; i < session.requests.length; i++) {
        const r = session.requests[i];
        if (pathMatch   && !r.path.startsWith(pathMatch.endsWith("*") ? pathMatch.slice(0,-1) : pathMatch)
                        && r.path !== pathMatch) continue;
        if (pathMatch   && pathMatch !== "*" && !matchPath(r.path.split("?")[0], pathMatch)) continue;
        if (methodMatch && r.method !== methodMatch) continue;
        return resolve({ session_id: session.id, found: true, request: r, waited_ms: Date.now() - (deadline - timeoutMs) });
      }
      if (Date.now() >= deadline) {
        return resolve({ session_id: session.id, found: false, waited_ms: timeoutMs, timed_out: true });
      }
      setTimeout(check, 50);
    }
    check();
  });
}

// ── Public entry point ─────────────────────────────────────────────────────────────────────

function httpServe(args) {
  const op = (args.operation || "start").toLowerCase();
  switch (op) {
    case "start":          return opStart(args);
    case "stop":           return opStop(args);
    case "status":         return opStatus();
    case "requests":       return opRequests(args);
    case "add_route":      return opAddRoute(args);
    case "clear_requests": return opClearRequests(args);
    case "wait":           return opWait(args);
    default:
      throw new ToolError(
        `http_serve: unknown operation '${op}'. ` +
        "Valid: start, stop, status, requests, add_route, clear_requests, wait.",
        -32602
      );
  }
}

module.exports = { httpServe, SERVERS };
