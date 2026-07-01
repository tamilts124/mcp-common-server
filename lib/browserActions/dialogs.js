"use strict";
// ── BROWSER DIALOGS: arm accept/dismiss for the next alert/confirm/prompt, read the dialog log ──
const { ToolError, getSession, requireSessionId } = require("./shared");

const MAX_DIALOG_LOG = 200;

async function handleNextDialog(args = {}) {
  requireSessionId(args, "browser_handle_next_dialog");
  if (args.action !== "accept" && args.action !== "dismiss")
    throw new ToolError("browser_handle_next_dialog requires an 'action' field of 'accept' or 'dismiss'.", -32602);
  const entry = getSession(args.session_id);
  entry.dialogAction = { action: args.action, promptText: args.prompt_text !== undefined ? String(args.prompt_text) : undefined };
  return { session_id: args.session_id, armed: true, action: args.action, prompt_text: args.prompt_text ?? null };
}

async function getDialogLog(args = {}) {
  requireSessionId(args, "browser_get_dialog_log");
  const entry = getSession(args.session_id);
  let log = (entry.dialogLog || []).slice();
  const limit = Number.isFinite(args.limit) && args.limit > 0 ? Math.min(args.limit, MAX_DIALOG_LOG) : MAX_DIALOG_LOG;
  log = log.slice(-limit);
  if (args.clear) entry.dialogLog = [];
  return { session_id: args.session_id, dialogs: log, count: log.length, cleared: !!args.clear };
}

module.exports = { handleNextDialog, getDialogLog };
