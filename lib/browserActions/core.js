"use strict";
// ── BROWSER CORE: navigate/get_content/evaluate ──
// Sibling modules under lib/browserActions/ (split out when this file grew past the
// 500-line threshold): interaction.js (click/type/hover/scroll/drag/upload/checkbox/select/key),
// pageState.js (nav-history/waits/element-state queries/metrics), capture.js
// (screenshot/pdf/download), scripting.js (init-scripts/exposed-functions/response-waiting).
const {
  ToolError, getSession,
  DEFAULT_TIMEOUT, MAX_CONTENT_CHARS, requireSessionId,
} = require("./shared");

async function navigate(args = {}) {
  requireSessionId(args, "browser_navigate");
  if (!args.url) throw new ToolError("browser_navigate requires a 'url' field.", -32602);
  const { page } = getSession(args.session_id);

  let response;
  try {
    response = await page.goto(args.url, {
      waitUntil: args.wait_until || "load",
      timeout: args.timeout || DEFAULT_TIMEOUT,
    });
  } catch (e) {
    throw new ToolError(`Navigation failed: ${e.message}`, -32603);
  }

  return {
    session_id: args.session_id,
    url: page.url(),
    status: response ? response.status() : null,
    title: await page.title(),
  };
}

async function getContent(args = {}) {
  requireSessionId(args, "browser_get_content");
  const { page } = getSession(args.session_id);
  const mode = args.mode || "text";

  let content;
  try {
    if (args.selector) {
      const el = await page.$(args.selector);
      if (!el) throw new ToolError(`Selector not found: ${args.selector}`, -32602);
      content = mode === "html" ? await el.innerHTML() : await el.innerText();
    } else {
      content = mode === "html" ? await page.content() : await page.innerText("body");
    }
  } catch (e) {
    if (e instanceof ToolError) throw e;
    throw new ToolError(`browser_get_content failed: ${e.message}`, -32603);
  }

  const truncated = content.length > MAX_CONTENT_CHARS;
  if (truncated) content = content.slice(0, MAX_CONTENT_CHARS);

  return { session_id: args.session_id, mode, selector: args.selector || null, content, truncated };
}

async function evaluate(args = {}) {
  requireSessionId(args, "browser_evaluate");
  if (!args.script) throw new ToolError("browser_evaluate requires a 'script' field.", -32602);
  const { page } = getSession(args.session_id);

  let result;
  try {
    result = await page.evaluate(args.script);
  } catch (e) {
    throw new ToolError(`browser_evaluate failed: ${e.message}`, -32603);
  }

  // Ensure JSON-serializable output (functions/undefined/etc. collapse to null via JSON round-trip).
  let safeResult;
  try {
    safeResult = JSON.parse(JSON.stringify(result === undefined ? null : result));
  } catch {
    safeResult = String(result);
  }

  return { session_id: args.session_id, result: safeResult };
}

module.exports = { navigate, getContent, evaluate };
