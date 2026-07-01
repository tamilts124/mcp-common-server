"use strict";
// ── BROWSER FRAMES: enumerate + interact inside <iframe> boundaries page.locator() can't pierce ──
const { ToolError, getSession, requireSessionId, DEFAULT_TIMEOUT, MAX_CONTENT_CHARS } = require("./shared");

function requireFrameSelector(args, tool) {
  if (!args.frame_selector || typeof args.frame_selector !== "string")
    throw new ToolError(`${tool} requires a 'frame_selector' string field (CSS selector of the <iframe> element).`, -32602);
}

async function listFrames(args = {}) {
  requireSessionId(args, "browser_list_frames");
  const { page } = getSession(args.session_id);
  const main = page.mainFrame();
  let frames;
  try {
    frames = page.frames().map((f) => ({
      url: f.url(),
      name: f.name(),
      isMainFrame: f === main,
      childCount: f.childFrames().length,
    }));
  } catch (e) {
    throw new ToolError(`browser_list_frames failed: ${e.message}`, -32603);
  }
  return { session_id: args.session_id, frames, count: frames.length };
}

async function frameClick(args = {}) {
  requireSessionId(args, "browser_frame_click");
  requireFrameSelector(args, "browser_frame_click");
  if (!args.selector) throw new ToolError("browser_frame_click requires a 'selector' field.", -32602);
  const { page } = getSession(args.session_id);
  try {
    await page.frameLocator(args.frame_selector).locator(args.selector).click({ timeout: args.timeout || DEFAULT_TIMEOUT });
  } catch (e) {
    throw new ToolError(`browser_frame_click failed: ${e.message}`, -32603);
  }
  return { session_id: args.session_id, frame_selector: args.frame_selector, selector: args.selector, status: "clicked" };
}

async function frameType(args = {}) {
  requireSessionId(args, "browser_frame_type");
  requireFrameSelector(args, "browser_frame_type");
  if (!args.selector) throw new ToolError("browser_frame_type requires a 'selector' field.", -32602);
  if (args.text === undefined || args.text === null)
    throw new ToolError("browser_frame_type requires a 'text' field.", -32602);
  const { page } = getSession(args.session_id);
  try {
    await page.frameLocator(args.frame_selector).locator(args.selector).fill(String(args.text), { timeout: args.timeout || DEFAULT_TIMEOUT });
  } catch (e) {
    throw new ToolError(`browser_frame_type failed: ${e.message}`, -32603);
  }
  return { session_id: args.session_id, frame_selector: args.frame_selector, selector: args.selector, status: "typed" };
}

async function frameGetContent(args = {}) {
  requireSessionId(args, "browser_frame_get_content");
  requireFrameSelector(args, "browser_frame_get_content");
  const { page } = getSession(args.session_id);
  const mode = args.mode || "text";
  const target = args.selector || "body";
  let scoped, count;
  try {
    scoped = page.frameLocator(args.frame_selector).locator(target);
    count = await scoped.count();
  } catch (e) {
    throw new ToolError(`browser_frame_get_content invalid selector: ${e.message}`, -32603);
  }
  // Mirrors browser_get_content's not-found convention: zero matches (bad frame_selector
  // or bad inner selector, syntax was fine either way) is a param problem, not an internal error.
  if (count === 0) throw new ToolError(`No element matching '${target}' inside frame '${args.frame_selector}'.`, -32602);

  let content;
  try {
    content = mode === "html" ? await scoped.first().innerHTML({ timeout: args.timeout || DEFAULT_TIMEOUT }) : await scoped.first().innerText({ timeout: args.timeout || DEFAULT_TIMEOUT });
  } catch (e) {
    throw new ToolError(`browser_frame_get_content failed: ${e.message}`, -32603);
  }
  const truncated = content.length > MAX_CONTENT_CHARS;
  if (truncated) content = content.slice(0, MAX_CONTENT_CHARS);
  return { session_id: args.session_id, frame_selector: args.frame_selector, mode, selector: args.selector || null, content, truncated };
}

async function frameEvaluate(args = {}) {
  requireSessionId(args, "browser_frame_evaluate");
  requireFrameSelector(args, "browser_frame_evaluate");
  if (!args.script) throw new ToolError("browser_frame_evaluate requires a 'script' field.", -32602);
  const { page } = getSession(args.session_id);

  let frame;
  try {
    const handle = await page.locator(args.frame_selector).elementHandle({ timeout: args.timeout || DEFAULT_TIMEOUT });
    frame = handle && (await handle.contentFrame());
  } catch (e) {
    throw new ToolError(`browser_frame_evaluate failed to locate frame '${args.frame_selector}': ${e.message}`, -32603);
  }
  if (!frame) throw new ToolError(`No <iframe> matching '${args.frame_selector}', or it has no content document.`, -32602);

  let result;
  try {
    result = await frame.evaluate(args.script);
  } catch (e) {
    throw new ToolError(`browser_frame_evaluate failed: ${e.message}`, -32603);
  }
  return { session_id: args.session_id, frame_selector: args.frame_selector, result };
}

module.exports = { listFrames, frameClick, frameType, frameGetContent, frameEvaluate };
