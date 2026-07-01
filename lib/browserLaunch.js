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

function getSession(sessionId) {
  const s = SESSIONS.get(sessionId);
  if (!s) throw new ToolError(`No browser session with id: ${sessionId}`, -32602);
  return s;
}

async function launchSession(args = {}) {
  const headless = args.headless !== false; // default true
  const userAgent = args.user_agent;
  const viewport = args.viewport && typeof args.viewport === "object"
    ? { width: args.viewport.width || 1280, height: args.viewport.height || 800 }
    : { width: 1280, height: 800 };

  let browser;
  try {
    browser = await chromium.launch({ headless });
  } catch (e) {
    throw new ToolError(`Failed to launch browser: ${e.message}`, -32603);
  }

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
