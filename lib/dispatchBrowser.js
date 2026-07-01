"use strict";
// ── BROWSER TOOL DISPATCH HANDLERS ──────────────────────────────────────────
// Mirrors dispatchRead.js/dispatchWrite.js pattern. Handlers may be async
// (return a Promise); executeTool()/executePipeline() already await results.

const { launchSession, listSessions, closeSession } = require("./browserLaunch");
const { navigate, getContent, evaluate, click, type, screenshot, getConsoleLogs } = require("./browserActions");

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
};

module.exports = { BROWSER_DISPATCH };
