"use strict";
// ── BROWSER SCRIPTING: init-scripts/exposed-functions/response-waiting ──
// Extracted from lib/browserActions/core.js (which had grown past the 500-line threshold).
const {
  ToolError, getSession,
  DEFAULT_TIMEOUT, requireSessionId,
} = require("./shared");

async function addInitScript(args = {}) {
  requireSessionId(args, "browser_add_init_script");
  if (!args.script || typeof args.script !== "string")
    throw new ToolError("browser_add_init_script requires a 'script' string field.", -32602);
  const { context } = getSession(args.session_id);
  try {
    await context.addInitScript({ content: args.script });
  } catch (e) {
    throw new ToolError(`browser_add_init_script failed: ${e.message}`, -32603);
  }
  return { session_id: args.session_id, applied: true, script_length: args.script.length };
}

const MAX_EXPOSED_CALLS = 200;
const FUNC_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

async function exposeFunction(args = {}) {
  requireSessionId(args, "browser_expose_function");
  if (!args.name || typeof args.name !== "string" || !FUNC_NAME_RE.test(args.name))
    throw new ToolError("browser_expose_function requires a valid identifier 'name' (letters/digits/_/$, not starting with a digit).", -32602);
  const entry = getSession(args.session_id);
  entry.exposedFunctions = entry.exposedFunctions || new Set();
  entry.exposedCalls = entry.exposedCalls || [];
  if (entry.exposedFunctions.has(args.name))
    throw new ToolError(`browser_expose_function: '${args.name}' is already exposed on this session.`, -32602);
  try {
    await entry.page.exposeFunction(args.name, (...callArgs) => {
      entry.exposedCalls.push({ name: args.name, args: callArgs, time: new Date().toISOString() });
      if (entry.exposedCalls.length > MAX_EXPOSED_CALLS) entry.exposedCalls = entry.exposedCalls.slice(-MAX_EXPOSED_CALLS);
      return { received: true };
    });
  } catch (e) {
    throw new ToolError(`browser_expose_function failed: ${e.message}`, -32603);
  }
  entry.exposedFunctions.add(args.name);
  return { session_id: args.session_id, name: args.name, exposed: true };
}

function getExposedCalls(args = {}) {
  requireSessionId(args, "browser_get_exposed_calls");
  const entry = getSession(args.session_id);
  let calls = (entry.exposedCalls || []).slice();
  if (args.name) calls = calls.filter((c) => c.name === String(args.name));
  const limit = Number.isFinite(args.limit) && args.limit > 0 ? Math.min(args.limit, MAX_EXPOSED_CALLS) : MAX_EXPOSED_CALLS;
  calls = calls.slice(-limit);
  if (args.clear) entry.exposedCalls = [];
  return { session_id: args.session_id, calls, count: calls.length, cleared: !!args.clear };
}

async function waitForResponse(args = {}) {
  requireSessionId(args, "browser_wait_for_response");
  if (!args.url_pattern || typeof args.url_pattern !== "string")
    throw new ToolError("browser_wait_for_response requires a 'url_pattern' string field.", -32602);
  const { page } = getSession(args.session_id);
  const expectStatus = args.status;
  let response;
  try {
    response = await page.waitForResponse(
      (res) => res.url().includes(args.url_pattern) && (expectStatus === undefined || res.status() === expectStatus),
      { timeout: args.timeout || DEFAULT_TIMEOUT },
    );
  } catch (e) {
    throw new ToolError(`browser_wait_for_response timed out or failed: ${e.message}`, -32603);
  }
  return { session_id: args.session_id, url: response.url(), status: response.status(), ok: response.ok() };
}

module.exports = { addInitScript, exposeFunction, getExposedCalls, waitForResponse };
