"use strict";
// ── BROWSER TOOL DISPATCH HANDLERS ──────────────────────────────────────────
// Mirrors dispatchRead.js/dispatchWrite.js pattern. Handlers may be async
// (return a Promise); executeTool()/executePipeline() already await results.

const { launchSession, listSessions, closeSession, newPage, switchPage, listPages, closePage, getSession, startRecording, stopRecording, getRecording, clearRecording } = require("./browserLaunch");
const { ToolError } = require("./errors");
const {
  navigate, getContent, evaluate, click, type, screenshot, getConsoleLogs,
  waitForSelector, getCurrentUrl, getTitle, goBack, goForward, reload, getCookies, setCookies, pdf, selectOption, pressKey,
  waitForNavigation, hover, uploadFile, scroll, doubleClick, rightClick, dragAndDrop, download,
  getAttribute, isVisible, isChecked, check, uncheck, getElementInfo,
  startNetworkCapture, stopNetworkCapture, getNetworkRequests,
  routeRequest, unroute, emulate, setViewport,
  setExtraHeaders, getLocalStorage, setLocalStorage,
  addInitScript, getPageMetrics,
  exposeFunction, getExposedCalls, waitForResponse,
  getStorageState,
  accessibilitySnapshot, findByRole,
  handleNextDialog, getDialogLog, waitForDialog,
  listFrames, frameClick, frameType, frameGetContent, frameEvaluate,
} = require("./browserActions");

// Tools that must never appear inside a replayed action list — either
// because replaying them would recurse/corrupt session lifecycle
// (browser_launch/browser_close/browser_replay_actions itself) or because
// they are recording-control tools, not page actions.
const REPLAY_EXCLUDED_TOOLS = new Set([
  "browser_launch", "browser_close", "browser_replay_actions",
  "browser_start_recording", "browser_stop_recording",
  "browser_get_recording", "browser_clear_recording",
]);
// File-writing tools — skipped by default on replay (re-running these
// silently overwrites/re-downloads files each replay) unless the caller
// explicitly opts in via include_side_effects:true.
const SIDE_EFFECT_TOOLS = new Set(["browser_screenshot", "browser_download", "browser_pdf"]);

async function replayActions(args = {}) {
  const sessionId = args.session_id;
  if (!sessionId) throw new ToolError("browser_replay_actions requires a 'session_id' field.", -32602);
  const entry = getSession(sessionId); // validates the session exists

  let actions = args.actions !== undefined ? args.actions : entry.actionLog;
  if (!Array.isArray(actions)) throw new ToolError("browser_replay_actions: 'actions' must be an array.", -32602);
  if (actions.length === 0) throw new ToolError("browser_replay_actions: no actions to replay (empty 'actions' array or empty recording).", -32602);
  if (actions.length > 500) throw new ToolError("browser_replay_actions: too many actions (max 500 per call).", -32602);

  const includeSideEffects = args.include_side_effects === true;
  const stopOnError = args.stop_on_error !== false; // default true
  const targetSessionId = args.target_session_id || sessionId;
  getSession(targetSessionId); // validates target exists too (may equal sessionId)

  const results = [];
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const toolName = action && action.tool;
    if (!toolName || typeof toolName !== "string") {
      results.push({ index: i, tool: toolName ?? null, status: "error", error: "action missing/invalid 'tool' field" });
      if (stopOnError) break;
      continue;
    }
    if (REPLAY_EXCLUDED_TOOLS.has(toolName)) {
      results.push({ index: i, tool: toolName, status: "skipped", reason: "control/lifecycle tool, not replayable" });
      continue;
    }
    if (!includeSideEffects && SIDE_EFFECT_TOOLS.has(toolName)) {
      results.push({ index: i, tool: toolName, status: "skipped", reason: "file-write side-effect tool skipped by default; pass include_side_effects:true to replay it" });
      continue;
    }
    const handler = BROWSER_DISPATCH[toolName];
    if (!handler) {
      results.push({ index: i, tool: toolName, status: "error", error: `unknown browser tool: ${toolName}` });
      if (stopOnError) break;
      continue;
    }
    const callArgs = { ...(action.args && typeof action.args === "object" ? action.args : {}), session_id: targetSessionId };
    try {
      const result = await Promise.resolve(handler(callArgs));
      results.push({ index: i, tool: toolName, status: "ok", result });
    } catch (e) {
      results.push({ index: i, tool: toolName, status: "error", error: e.message });
      if (stopOnError) break;
    }
  }

  return {
    session_id: targetSessionId,
    totalActions: actions.length,
    replayed: results.filter(r => r.status === "ok").length,
    skipped:  results.filter(r => r.status === "skipped").length,
    failed:   results.filter(r => r.status === "error").length,
    results,
  };
}

const BROWSER_DISPATCH = {
  browser_launch:            launchSession,
  browser_navigate:          navigate,
  browser_get_content:       getContent,
  browser_evaluate:          evaluate,
  browser_click:             click,
  browser_type:              type,
  browser_screenshot:        screenshot,
  browser_get_console_logs:  getConsoleLogs,
  browser_list_sessions:     listSessions,
  browser_close:             closeSession,
  browser_wait_for_selector: waitForSelector,
  browser_get_current_url:  getCurrentUrl,
  browser_get_title:        getTitle,
  browser_go_back:           goBack,
  browser_go_forward:        goForward,
  browser_reload:            reload,
  browser_get_cookies:       getCookies,
  browser_set_cookies:       setCookies,
  browser_pdf:               pdf,
  browser_select_option:     selectOption,
  browser_press_key:         pressKey,
  browser_wait_for_navigation: waitForNavigation,
  browser_hover:             hover,
  browser_upload_file:       uploadFile,
  browser_scroll:            scroll,
  browser_double_click:      doubleClick,
  browser_right_click:       rightClick,
  browser_drag_and_drop:     dragAndDrop,
  browser_download:          download,
  browser_get_attribute:     getAttribute,
  browser_is_visible:        isVisible,
  browser_is_checked:        isChecked,
  browser_check:             check,
  browser_uncheck:           uncheck,
  browser_get_element_info:  getElementInfo,
  browser_new_page:          newPage,
  browser_switch_page:       switchPage,
  browser_list_pages:        listPages,
  browser_close_page:        closePage,
  browser_network_start:     startNetworkCapture,
  browser_network_stop:      stopNetworkCapture,
  browser_get_network_requests: getNetworkRequests,
  browser_route:             routeRequest,
  browser_unroute:           unroute,
  browser_emulate:           emulate,
  browser_set_viewport:      setViewport,
  browser_set_extra_headers: setExtraHeaders,
  browser_get_local_storage: getLocalStorage,
  browser_set_local_storage: setLocalStorage,
  browser_add_init_script:  addInitScript,
  browser_get_page_metrics: getPageMetrics,
  browser_expose_function:  exposeFunction,
  browser_get_exposed_calls: getExposedCalls,
  browser_wait_for_response: waitForResponse,
  browser_get_storage_state: getStorageState,
  browser_accessibility_snapshot: accessibilitySnapshot,
  browser_find_by_role:     findByRole,
  browser_handle_next_dialog: handleNextDialog,
  browser_get_dialog_log:   getDialogLog,
  browser_wait_for_dialog:  waitForDialog,
  browser_list_frames:      listFrames,
  browser_frame_click:      frameClick,
  browser_frame_type:       frameType,
  browser_frame_get_content: frameGetContent,
  browser_frame_evaluate:    frameEvaluate,
  browser_start_recording:  startRecording,
  browser_stop_recording:   stopRecording,
  browser_get_recording:    getRecording,
  browser_clear_recording:  clearRecording,
  browser_replay_actions:   replayActions,
};

module.exports = { BROWSER_DISPATCH };
