"use strict";
// ── BROWSER TOOL DISPATCH HANDLERS ──────────────────────────────────────────
// Mirrors dispatchRead.js/dispatchWrite.js pattern. Handlers may be async
// (return a Promise); executeTool()/executePipeline() already await results.

const { launchSession, listSessions, closeSession, newPage, switchPage, listPages, closePage } = require("./browserLaunch");
const {
  navigate, getContent, evaluate, click, type, screenshot, getConsoleLogs,
  waitForSelector, goBack, goForward, reload, getCookies, setCookies, pdf, selectOption, pressKey,
  waitForNavigation, hover, uploadFile, scroll, doubleClick, rightClick, dragAndDrop, download,
  getAttribute, isVisible, isChecked, check, uncheck, getElementInfo,
  startNetworkCapture, stopNetworkCapture, getNetworkRequests,
  routeRequest, unroute,
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
};

module.exports = { BROWSER_DISPATCH };
