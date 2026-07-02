"use strict";
// ── TOOL DISPATCH & PIPELINE EXECUTION — thin coordinator ──────────────────────
// Actual per-tool logic lives in lib/dispatchRead.js (read/git/utility tools)
// and lib/dispatchWrite.js (write/exec tools) so this file stays under the
// project's 500-line threshold. This file owns: the available-tools filter,
// JSON-RPC schema validation, the read-only/exec policy gate, and the
// execute_pipeline runner (which needs to call back into executeTool()).

const { READ_ONLY, ALLOW_EXEC } = require("./config");
const { WRITE_TOOLS, EXEC_TOOLS, TOOLS_ALL } = require("./toolsSchema");
const { ToolError, getErrorCode } = require("./errors");
const { READ_DISPATCH }  = require("./dispatchRead");
const { WRITE_DISPATCH } = require("./dispatchWrite");
const { BROWSER_DISPATCH } = require("./dispatchBrowser");
const { recordAction } = require("./browserLaunch");

// Tools excluded from action-log recording: recording-control tools
// themselves (would otherwise record their own on/off toggles) and
// session-lifecycle tools (launch/close — replay always targets an
// already-open session, it never re-launches/closes one).
const RECORDING_EXCLUDED = new Set([
  "browser_launch", "browser_close", "browser_replay_actions",
  "browser_start_recording", "browser_stop_recording",
  "browser_get_recording", "browser_clear_recording",
]);

const TOOLS = TOOLS_ALL.filter(t => {
  if (READ_ONLY && (WRITE_TOOLS.has(t.name) || EXEC_TOOLS.has(t.name))) return false;
  if (!ALLOW_EXEC && EXEC_TOOLS.has(t.name)) return false;
  return true;
});

const TOOLS_BY_NAME = new Map(TOOLS_ALL.map(t => [t.name, t]));

// Validates `args` against the tool's declared inputSchema.required before
// dispatch. Throws a ToolError (with .code) on any schema violation so
// callers (e.g. the HTTP/SSE layer) can return a proper JSON-RPC error code
// instead of a generic crash/500.
function validateArgs(name, args) {
  const schema = TOOLS_BY_NAME.get(name);
  if (!schema) throw new ToolError(`Unknown tool: ${name}`, -32601);

  const a = args || {};
  if (typeof a !== "object" || Array.isArray(a)) {
    throw new ToolError(`Invalid params for '${name}': arguments must be an object.`, -32602);
  }

  const required = schema.inputSchema?.required || [];
  for (const field of required) {
    const v = a[field];
    if (v === undefined || v === null || (typeof v === "string" && v === "")) {
      throw new ToolError(`Invalid params for '${name}': missing required field '${field}'.`, -32602);
    }
  }
}

function executeTool(name, args) {
  validateArgs(name, args);

  if (READ_ONLY && (WRITE_TOOLS.has(name) || EXEC_TOOLS.has(name)))
    throw new ToolError(`Server is in read-only mode — '${name}' is disabled.`, -32001);
  if (!ALLOW_EXEC && EXEC_TOOLS.has(name))
    throw new ToolError(`'${name}' requires MCP_ALLOW_EXEC=true on the server.`, -32001);

  if (name === "execute_pipeline") return executePipeline(args.steps);

  const handler = READ_DISPATCH[name] || WRITE_DISPATCH[name] || BROWSER_DISPATCH[name];
  if (!handler) throw new ToolError(`Unknown tool: ${name}`, -32601);

  // Single central recording hook (not scattered across every
  // browserActions.js function): if this is a browser_* tool called with a
  // session_id whose session has recording enabled, append it to that
  // session's action log before dispatch — even if the call itself later
  // throws, so a recorded exploration session reflects what was actually
  // attempted.
  if (BROWSER_DISPATCH[name] && args && args.session_id && !RECORDING_EXCLUDED.has(name)) {
    recordAction(args.session_id, name, args);
  }

  // Handlers may return a plain value (sync) or a Promise (async).
  // Callers should await Promise.resolve(executeTool(...)) to handle both.
  return handler(args);
}

// Runs a sequence of operations (any tool) in order.
// Each step: { op, on_error?, ...tool-specific args }
// Async: some tools (e.g. http_fetch) return a Promise from executeTool();
// every step is awaited so its real result/rejection is captured instead of
// a dangling, JSON.stringify-to-"{}" Promise object leaking into the report.
async function executePipeline(steps) {
  if (!Array.isArray(steps) || steps.length === 0)
    throw new Error("execute_pipeline requires a non-empty 'steps' array.");

  const results   = [];
  let stoppedAt   = null;
  let completed   = 0;

  for (let i = 0; i < steps.length; i++) {
    const step     = steps[i];
    const op       = step.op;
    const onError  = step.on_error ?? "stop";

    if (!op) {
      results.push({ index: i, op: null, status: "error", error: "Missing 'op' field in step." });
      if (onError === "stop") { stoppedAt = i; break; }
      continue;
    }

    const { op: _op, on_error: _oe, ...toolArgs } = step;

    try {
      const result = await Promise.resolve(executeTool(op, toolArgs));
      results.push({ index: i, op, status: "ok", result });
      completed++;
    } catch (e) {
      results.push({ index: i, op, status: "error", error: e.message });
      if (onError === "stop") {
        stoppedAt = i;
        for (let j = i + 1; j < steps.length; j++) {
          results.push({ index: j, op: steps[j].op || null, status: "skipped" });
        }
        break;
      }
    }
  }

  return {
    total:      steps.length,
    completed,
    failed:     results.filter(r => r.status === "error").length,
    skipped:    results.filter(r => r.status === "skipped").length,
    stopped_at: stoppedAt,
    steps:      results,
  };
}

module.exports = { TOOLS, executeTool, executePipeline, ToolError, validateArgs, getErrorCode };
