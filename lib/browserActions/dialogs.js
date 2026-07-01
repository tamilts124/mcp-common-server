"use strict";
// ── BROWSER DIALOGS: arm accept/dismiss for the next alert/confirm/prompt, read the dialog log ──
const { ToolError, getSession, requireSessionId } = require("./shared");

const MAX_DIALOG_LOG = 200;
const MAX_DIALOG_QUEUE = 50;
const MAX_WAIT_MS = 30000;
const DEFAULT_WAIT_MS = 5000;

async function handleNextDialog(args = {}) {
  requireSessionId(args, "browser_handle_next_dialog");
  if (args.action !== "accept" && args.action !== "dismiss")
    throw new ToolError("browser_handle_next_dialog requires an 'action' field of 'accept' or 'dismiss'.", -32602);
  const entry = getSession(args.session_id);
  const armed = { action: args.action, promptText: args.prompt_text !== undefined ? String(args.prompt_text) : undefined };
  if (!entry.dialogQueue) entry.dialogQueue = [];
  if (args.queue) {
    if (entry.dialogQueue.length >= MAX_DIALOG_QUEUE)
      throw new ToolError(`Dialog queue full (max ${MAX_DIALOG_QUEUE}).`, -32602);
    entry.dialogQueue.push(armed);
  } else {
    // Non-queueing call replaces any pending queue with a single one-shot,
    // matching the original (pre-queue) semantics for existing callers.
    entry.dialogQueue = [armed];
  }
  return {
    session_id: args.session_id,
    armed: true,
    action: args.action,
    prompt_text: args.prompt_text ?? null,
    queue_length: entry.dialogQueue.length,
  };
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

async function waitForDialog(args = {}) {
  requireSessionId(args, "browser_wait_for_dialog");
  const entry = getSession(args.session_id);
  const timeoutMs = Number.isFinite(args.timeout_ms) && args.timeout_ms > 0
    ? Math.min(args.timeout_ms, MAX_WAIT_MS)
    : DEFAULT_WAIT_MS;
  if (!entry.dialogWaiters) entry.dialogWaiters = [];
  return new Promise((resolve) => {
    const waiter = { resolve, timer: null };
    waiter.timer = setTimeout(() => {
      const idx = entry.dialogWaiters.indexOf(waiter);
      if (idx !== -1) entry.dialogWaiters.splice(idx, 1);
      resolve({ session_id: args.session_id, timed_out: true, dialog: null });
    }, timeoutMs);
    entry.dialogWaiters.push(waiter);
  });
}

module.exports = { handleNextDialog, getDialogLog, waitForDialog };
