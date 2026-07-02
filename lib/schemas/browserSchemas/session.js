"use strict";
// ── Session/tab lifecycle + action recording ──

const SESSION_SCHEMAS = [
  {
    name: "browser_launch",
    description: "Launch a stealth Chromium browser session (playwright-extra + puppeteer-extra-plugin-stealth) and return a session id used by all other browser_* tools.",
    inputSchema: { type: "object", properties: {
      headless:   { type: "boolean", description: "Run without a visible window (default: true)." },
      user_agent: { type: "string",  description: "Optional custom User-Agent string." },
      viewport:   { type: "object",  description: "Optional {width, height} viewport (default 1280x800).",
        properties: { width: { type: "number" }, height: { type: "number" } } },
      device_scale_factor: { type: "number", description: "Optional device pixel ratio, e.g. 2 for retina (default 1). Fixed for the session's lifetime." },
      timezone_id:         { type: "string", description: "Optional IANA timezone id, e.g. 'America/New_York'. Fixed for the session's lifetime." },
      locale:              { type: "string", description: "Optional locale, e.g. 'en-US', 'fr-FR'. Fixed for the session's lifetime." },
      storage_state:       { type: "object", description: "Optional storage state (cookies + per-origin localStorage) previously captured via browser_get_storage_state, to resume a logged-in session." },
    }},
  },
  {
    name: "browser_navigate",
    description: "Navigate a browser session's page to a URL and wait for it to load.",
    inputSchema: { type: "object", required: ["session_id", "url"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
      url:        { type: "string", description: "URL to navigate to." },
      wait_until: { type: "string", description: "One of 'load', 'domcontentloaded', 'networkidle', 'commit' (default: 'load')." },
      timeout:    { type: "number", description: "Milliseconds before navigation times out (default: 30000)." },
    }},
  },
  {
    name: "browser_list_sessions",
    description: "List all active browser sessions with their current URL and metadata.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_close",
    description: "Close a browser session's page/context/browser and drop it from the session table.",
    inputSchema: { type: "object", required: ["session_id"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
    }},
  },
  {
    name: "browser_new_page",
    description: "Open a new tab/page in an existing browser session's context and make it the active page. Optionally navigate it.",
    inputSchema: { type: "object", required: ["session_id"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
      url:        { type: "string", description: "Optional URL to navigate the new page to." },
      wait_until: { type: "string", description: "Navigation wait condition (default: load)." },
      timeout:    { type: "number", description: "Milliseconds before timing out (default: 30000)." },
    }},
  },
  {
    name: "browser_switch_page",
    description: "Switch the active page/tab for a session. Subsequent tool calls on this session_id act on the newly active page.",
    inputSchema: { type: "object", required: ["session_id", "page_id"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
      page_id:    { type: "string", description: "Page id returned by browser_launch or browser_new_page." },
    }},
  },
  {
    name: "browser_list_pages",
    description: "List all open pages/tabs in a session with their URL and which one is currently active.",
    inputSchema: { type: "object", required: ["session_id"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
    }},
  },
  {
    name: "browser_close_page",
    description: "Close a specific page/tab in a session (not the whole session). Cannot close the last remaining page — use browser_close instead.",
    inputSchema: { type: "object", required: ["session_id", "page_id"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
      page_id:    { type: "string", description: "Page id to close." },
    }},
  },
  {
    name: "browser_start_recording",
    description: "Start recording every subsequent browser_* tool call made on this session (tool name + args + timestamp) into a per-session action log, for later export/replay via browser_get_recording/browser_replay_actions. Recording-control tools and browser_launch/browser_close are never recorded. Clears any previous log by default (pass clear:false to keep appending to an existing log instead).",
    inputSchema: { type: "object", required: ["session_id"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
      clear:      { type: "boolean", description: "Clear the existing action log before starting (default: true)." },
    }},
  },
  {
    name: "browser_stop_recording",
    description: "Stop recording on this session and return the full recorded action log (does not clear it — the log remains readable via browser_get_recording until browser_clear_recording or the next browser_start_recording).",
    inputSchema: { type: "object", required: ["session_id"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
    }},
  },
  {
    name: "browser_get_recording",
    description: "Read this session's current action log (whether or not recording is currently active) without stopping/clearing it. Returns { session_id, recording, actionCount, actions: [{tool, args, ts}] }.",
    inputSchema: { type: "object", required: ["session_id"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
    }},
  },
  {
    name: "browser_clear_recording",
    description: "Clear this session's action log without changing whether recording is currently on/off.",
    inputSchema: { type: "object", required: ["session_id"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
    }},
  },
  {
    name: "browser_replay_actions",
    description: "Replay a sequence of previously-recorded (or explicitly supplied) browser_* tool calls against a session, in order — useful for turning an ad-hoc exploration session into a repeatable script. By default replays this session's own action log (from browser_start_recording/browser_stop_recording); pass an explicit `actions` array (each {tool, args}) to replay a hand-built or edited sequence instead. Each action's own session_id is ignored and replaced with `target_session_id` (or `session_id` if omitted), so a recording made on one session can be replayed onto a different, fresh session. browser_launch/browser_close/recording-control/browser_replay_actions itself are never replayable (skipped with a reason). browser_screenshot/browser_download/browser_pdf (file-writing tools) are skipped by default — pass include_side_effects:true to replay them too. Stops at the first failing action by default; pass stop_on_error:false to continue past failures. Returns { session_id, totalActions, replayed, skipped, failed, results: [{index, tool, status, result?/error?/reason?}] }.",
    inputSchema: { type: "object", required: ["session_id"], properties: {
      session_id:          { type: "string", description: "Session id whose own recording to replay (also the default replay target)." },
      actions:             { type: "array", items: { type: "object" }, description: "Optional explicit list of {tool, args} to replay instead of the session's own recording." },
      target_session_id:   { type: "string", description: "Optional: replay onto a different (already-launched) session instead of session_id." },
      include_side_effects: { type: "boolean", description: "Also replay browser_screenshot/browser_download/browser_pdf (default: false — skipped)." },
      stop_on_error:        { type: "boolean", description: "Stop at the first failing action (default: true)." },
    }},
  },
];

module.exports = { SESSION_SCHEMAS };
