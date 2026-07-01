"use strict";
// ── BROWSER NETWORK: request/response capture, route interception ──
const { ToolError, getSession, requireSessionId } = require("./shared");

const MAX_NETWORK_LOGS = 500;

function networkRequestHandler(entry) {
  return (req) => {
    entry.networkLog.push({
      type: "request", url: req.url(), method: req.method(),
      resource_type: req.resourceType(), time: new Date().toISOString(),
    });
    if (entry.networkLog.length > MAX_NETWORK_LOGS) entry.networkLog = entry.networkLog.slice(-MAX_NETWORK_LOGS);
  };
}

function networkResponseHandler(entry) {
  return (res) => {
    entry.networkLog.push({
      type: "response", url: res.url(), status: res.status(),
      resource_type: res.request().resourceType(), time: new Date().toISOString(),
    });
    if (entry.networkLog.length > MAX_NETWORK_LOGS) entry.networkLog = entry.networkLog.slice(-MAX_NETWORK_LOGS);
  };
}

function networkFailedHandler(entry) {
  return (req) => {
    const failure = req.failure();
    entry.networkLog.push({
      type: "request_failed", url: req.url(), method: req.method(),
      error: failure ? failure.errorText : "unknown", time: new Date().toISOString(),
    });
    if (entry.networkLog.length > MAX_NETWORK_LOGS) entry.networkLog = entry.networkLog.slice(-MAX_NETWORK_LOGS);
  };
}

function startNetworkCapture(args = {}) {
  requireSessionId(args, "browser_network_start");
  const entry = getSession(args.session_id);
  if (entry.networkCapturing)
    return { session_id: args.session_id, status: "already_capturing" };
  entry._reqHandler = networkRequestHandler(entry);
  entry._resHandler = networkResponseHandler(entry);
  entry._failHandler = networkFailedHandler(entry);
  entry.page.on("request", entry._reqHandler);
  entry.page.on("response", entry._resHandler);
  entry.page.on("requestfailed", entry._failHandler);
  entry.networkCapturing = true;
  return { session_id: args.session_id, status: "capturing" };
}

function stopNetworkCapture(args = {}) {
  requireSessionId(args, "browser_network_stop");
  const entry = getSession(args.session_id);
  if (entry.networkCapturing) {
    try {
      entry.page.off("request", entry._reqHandler);
      entry.page.off("response", entry._resHandler);
      entry.page.off("requestfailed", entry._failHandler);
    } catch (_) { /* best effort */ }
  }
  entry.networkCapturing = false;
  return { session_id: args.session_id, status: "stopped", count: entry.networkLog.length };
}

function getNetworkRequests(args = {}) {
  requireSessionId(args, "browser_get_network_requests");
  const entry = getSession(args.session_id);
  let log = entry.networkLog.slice();
  if (args.url_contains) log = log.filter((e) => e.url.includes(String(args.url_contains)));
  if (args.resource_type) log = log.filter((e) => e.resource_type === String(args.resource_type));
  if (args.type) log = log.filter((e) => e.type === String(args.type));
  const limit = Number.isFinite(args.limit) && args.limit > 0 ? Math.min(args.limit, MAX_NETWORK_LOGS) : 100;
  log = log.slice(-limit);
  if (args.clear) entry.networkLog = [];
  return { session_id: args.session_id, requests: log, count: log.length, capturing: entry.networkCapturing, cleared: !!args.clear };
}

const ROUTE_ACTIONS = new Set(["abort", "fulfill", "continue"]);

async function routeRequest(args = {}) {
  requireSessionId(args, "browser_route");
  if (!args.url_pattern) throw new ToolError("browser_route requires a 'url_pattern' field.", -32602);
  if (!ROUTE_ACTIONS.has(args.action))
    throw new ToolError("browser_route requires 'action' to be one of: abort, fulfill, continue.", -32602);
  const entry = getSession(args.session_id);
  const action = args.action;
  const handler = async (route) => {
    try {
      if (action === "abort") await route.abort(args.error_code || "failed");
      else if (action === "continue") await route.continue();
      else await route.fulfill({
        status: Number.isFinite(args.status) ? args.status : 200,
        body: args.body != null ? String(args.body) : "",
        contentType: args.content_type || "text/plain",
        headers: args.headers && typeof args.headers === "object" ? args.headers : undefined,
      });
    } catch (_) { /* route/page may already be gone */ }
  };
  try {
    await entry.page.route(args.url_pattern, handler);
  } catch (e) {
    throw new ToolError(`browser_route failed: ${e.message}`, -32603);
  }
  entry.routes.set(args.url_pattern, handler);
  return { session_id: args.session_id, url_pattern: args.url_pattern, action, status: "routed" };
}

async function unroute(args = {}) {
  requireSessionId(args, "browser_unroute");
  const entry = getSession(args.session_id);
  if (args.url_pattern) {
    const handler = entry.routes.get(args.url_pattern);
    if (!handler) throw new ToolError(`No active route for pattern: ${args.url_pattern}`, -32602);
    try { await entry.page.unroute(args.url_pattern, handler); } catch (_) { /* best effort */ }
    entry.routes.delete(args.url_pattern);
    return { session_id: args.session_id, url_pattern: args.url_pattern, status: "unrouted" };
  }
  const count = entry.routes.size;
  for (const [pattern, handler] of entry.routes) {
    try { await entry.page.unroute(pattern, handler); } catch (_) { /* best effort */ }
  }
  entry.routes.clear();
  return { session_id: args.session_id, status: "unrouted_all", count };
}

module.exports = {
  startNetworkCapture, stopNetworkCapture, getNetworkRequests, routeRequest, unroute,
};
