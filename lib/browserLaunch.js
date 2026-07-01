"use strict";
// ── BROWSER SESSION TABLE: browser_launch / browser_list_sessions / browser_close ──
// Stealth Chromium via playwright-extra + puppeteer-extra-plugin-stealth to
// avoid basic bot-detection/rendering issues on typical sites.

const crypto = require("crypto");
const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();
const { ToolError } = require("./errors");

chromium.use(stealth);

// sessionId -> { browser, context, page, consoleLogs: [], createdAt, options }
const SESSIONS = new Map();
const MAX_CONSOLE_LOGS = 500;
const MAX_SESSIONS = parseInt(process.env.MCP_MAX_BROWSER_SESSIONS, 10) || 8;

// Best-effort cleanup of orphaned Chromium processes if the server exits
// (crash, SIGINT/SIGTERM) while sessions are still open.
let exitHooked = false;
function hookExitCleanup() {
  if (exitHooked) return;
  exitHooked = true;
  const cleanup = () => {
    for (const [, e] of SESSIONS) {
      try { e.browser.close(); } catch (_) { /* best effort */ }
    }
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => { cleanup(); process.exit(130); });
  process.on("SIGTERM", () => { cleanup(); process.exit(143); });
}

function attachPageListeners(entry, page) {
  page.on("console", (msg) => {
    entry.consoleLogs.push({
      type: msg.type(),
      text: msg.text(),
      time: new Date().toISOString(),
    });
    if (entry.consoleLogs.length > MAX_CONSOLE_LOGS) {
      entry.consoleLogs = entry.consoleLogs.slice(-MAX_CONSOLE_LOGS);
    }
  });
  page.on("pageerror", (err) => {
    entry.consoleLogs.push({ type: "pageerror", text: err.message, time: new Date().toISOString() });
  });
}

function getSession(sessionId) {
  const s = SESSIONS.get(sessionId);
  if (!s) throw new ToolError(`No browser session with id: ${sessionId}`, -32602);
  return s;
}

// Synchronous reservation count so concurrent launchSession() calls can't all
// pass the cap check before any of them has actually registered a session
// (SESSIONS.set only happens after the awaited browser.launch() resolves).
let pendingLaunches = 0;

async function launchSession(args = {}) {
  if (SESSIONS.size + pendingLaunches >= MAX_SESSIONS) {
    throw new ToolError(
      `Max concurrent browser sessions (${MAX_SESSIONS}) reached. Close an existing session first.`,
      -32603
    );
  }
  pendingLaunches++;
  hookExitCleanup();
  const headless = args.headless !== false; // default true
  const userAgent = args.user_agent;
  const viewport = args.viewport && typeof args.viewport === "object"
    ? { width: args.viewport.width || 1280, height: args.viewport.height || 800 }
    : { width: 1280, height: 800 };

  let browser;
  try {
    browser = await chromium.launch({ headless });
  } catch (e) {
    pendingLaunches--;
    throw new ToolError(`Failed to launch browser: ${e.message}`, -32603);
  }
  pendingLaunches--;

  const deviceScaleFactor = Number.isFinite(args.device_scale_factor) && args.device_scale_factor > 0
    ? args.device_scale_factor : undefined;
  let storageState;
  if (args.storage_state !== undefined) {
    if (typeof args.storage_state !== "object" || args.storage_state === null || Array.isArray(args.storage_state))
      throw new ToolError("browser_launch storage_state must be an object (as returned by browser_get_storage_state).", -32602);
    storageState = args.storage_state;
  }
  let context, page;
  try {
    context = await browser.newContext({
      viewport,
      userAgent: userAgent || undefined,
      deviceScaleFactor,
      timezoneId: args.timezone_id || undefined,
      locale: args.locale || undefined,
      storageState,
    });
    page = await context.newPage();
  } catch (e) {
    try { await browser.close(); } catch (_) { /* best effort */ }
    throw new ToolError(`Failed to create browser context: ${e.message}`, -32603);
  }

  const id = crypto.randomUUID();
  const mainPageId = crypto.randomUUID();
  const entry = {
    id, browser, context, page,
    pages: new Map([[mainPageId, page]]),
    activePageId: mainPageId,
    consoleLogs: [],
    networkLog: [],
    networkCapturing: false,
    routes: new Map(),
    createdAt: new Date().toISOString(),
    headless,
  };

  attachPageListeners(entry, page);
  SESSIONS.set(id, entry);
  console.error(`[BROWSER] Launched session ${id} (headless=${headless})`);

  return { session_id: id, headless, viewport, createdAt: entry.createdAt };
}

function listSessions() {
  const list = [];
  for (const [id, e] of SESSIONS) {
    list.push({
      session_id: id,
      headless: e.headless,
      createdAt: e.createdAt,
      url: e.page.url(),
      consoleLogCount: e.consoleLogs.length,
    });
  }
  return { sessions: list, count: list.length };
}

async function closeSession(args = {}) {
  const sessionId = args.session_id;
  if (!sessionId) throw new ToolError("browser_close requires a 'session_id' field.", -32602);
  const entry = getSession(sessionId);

  try {
    await entry.browser.close();
  } catch (e) {
    // Already closed/crashed — still drop the session entry below.
    console.error(`[BROWSER] Error closing session ${sessionId}: ${e.message}`);
  }
  SESSIONS.delete(sessionId);
  return { session_id: sessionId, status: "closed" };
}

async function newPage(args = {}) {
  if (!args.session_id) throw new ToolError("browser_new_page requires a 'session_id' field.", -32602);
  const entry = getSession(args.session_id);
  const page = await entry.context.newPage();
  attachPageListeners(entry, page);
  if (args.url) {
    try {
      await page.goto(args.url, { waitUntil: args.wait_until || "load", timeout: args.timeout || 30000 });
    } catch (e) {
      try { await page.close(); } catch (_) { /* best effort */ }
      throw new ToolError(`browser_new_page navigation failed: ${e.message}`, -32603);
    }
  }
  const pageId = crypto.randomUUID();
  entry.pages.set(pageId, page);
  entry.activePageId = pageId;
  entry.page = page;
  return { session_id: args.session_id, page_id: pageId, url: page.url(), status: "opened" };
}

function switchPage(args = {}) {
  if (!args.session_id) throw new ToolError("browser_switch_page requires a 'session_id' field.", -32602);
  if (!args.page_id) throw new ToolError("browser_switch_page requires a 'page_id' field.", -32602);
  const entry = getSession(args.session_id);
  const page = entry.pages.get(args.page_id);
  if (!page) throw new ToolError(`No page with id: ${args.page_id}`, -32602);
  entry.activePageId = args.page_id;
  entry.page = page;
  return { session_id: args.session_id, page_id: args.page_id, url: page.url(), status: "switched" };
}

function listPages(args = {}) {
  if (!args.session_id) throw new ToolError("browser_list_pages requires a 'session_id' field.", -32602);
  const entry = getSession(args.session_id);
  const pages = [];
  for (const [pageId, page] of entry.pages) {
    pages.push({ page_id: pageId, url: page.url(), active: pageId === entry.activePageId });
  }
  return { session_id: args.session_id, pages, count: pages.length };
}

async function closePage(args = {}) {
  if (!args.session_id) throw new ToolError("browser_close_page requires a 'session_id' field.", -32602);
  if (!args.page_id) throw new ToolError("browser_close_page requires a 'page_id' field.", -32602);
  const entry = getSession(args.session_id);
  const page = entry.pages.get(args.page_id);
  if (!page) throw new ToolError(`No page with id: ${args.page_id}`, -32602);
  if (entry.pages.size <= 1)
    throw new ToolError("Cannot close the last remaining page; use browser_close to close the whole session.", -32602);
  try {
    await page.close();
  } catch (e) {
    console.error(`[BROWSER] Error closing page ${args.page_id}: ${e.message}`);
  }
  entry.pages.delete(args.page_id);
  if (entry.activePageId === args.page_id) {
    const [firstId, firstPage] = entry.pages.entries().next().value;
    entry.activePageId = firstId;
    entry.page = firstPage;
  }
  return { session_id: args.session_id, page_id: args.page_id, status: "closed", active_page_id: entry.activePageId };
}

module.exports = {
  SESSIONS, getSession, launchSession, listSessions, closeSession,
  newPage, switchPage, listPages, closePage,
};
