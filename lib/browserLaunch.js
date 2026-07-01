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

  const context = await browser.newContext({
    viewport,
    userAgent: userAgent || undefined,
  });
  const page = await context.newPage();

  const id = crypto.randomUUID();
  const entry = {
    id, browser, context, page,
    consoleLogs: [],
    createdAt: new Date().toISOString(),
    headless,
  };

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

module.exports = { SESSIONS, getSession, launchSession, listSessions, closeSession };
