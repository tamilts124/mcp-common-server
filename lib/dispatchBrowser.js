"use strict";
// ── BROWSER TOOL DISPATCH HANDLERS ──────────────────────────────────────────
// Mirrors dispatchRead.js/dispatchWrite.js pattern. Handlers may be async
// (return a Promise); executeTool()/executePipeline() already await results.

const { launchSession, listSessions, closeSession } = require("./browserLaunch");
const {
  navigate, getContent, evaluate, click, type, screenshot, getConsoleLogs,
  waitForSelector, goBack, goForward, reload, getCookies, setCookies, pdf, selectOption, pressKey,
  waitForNavigation,
} = require("./browserActions");

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
  browser_go_back:           goBack,
  browser_go_forward:        goForward,
  browser_reload:            reload,
  browser_get_cookies:       getCookies,
  browser_set_cookies:       setCookies,
  browser_pdf:               pdf,
  browser_select_option:     selectOption,
  browser_press_key:         pressKey,
  browser_wait_for_navigation: waitForNavigation,
};

module.exports = { BROWSER_DISPATCH };
