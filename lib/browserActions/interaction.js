"use strict";
// ── BROWSER INTERACTION: click/type/hover/scroll/drag/upload/checkbox/select/key ──
// Extracted from lib/browserActions/core.js (which had grown past the 500-line threshold).
const {
  ToolError, resolveClientPath, getSession,
  DEFAULT_TIMEOUT, requireSessionId,
} = require("./shared");

async function click(args = {}) {
  requireSessionId(args, "browser_click");
  if (!args.selector) throw new ToolError("browser_click requires a 'selector' field.", -32602);
  const { page } = getSession(args.session_id);

  try {
    await page.click(args.selector, { timeout: args.timeout || DEFAULT_TIMEOUT });
  } catch (e) {
    throw new ToolError(`browser_click failed: ${e.message}`, -32603);
  }

  return { session_id: args.session_id, selector: args.selector, status: "clicked" };
}

async function type(args = {}) {
  requireSessionId(args, "browser_type");
  if (!args.selector) throw new ToolError("browser_type requires a 'selector' field.", -32602);
  if (args.text === undefined || args.text === null)
    throw new ToolError("browser_type requires a 'text' field.", -32602);
  const { page } = getSession(args.session_id);

  try {
    await page.fill(args.selector, String(args.text), { timeout: args.timeout || DEFAULT_TIMEOUT });
  } catch (e) {
    throw new ToolError(`browser_type failed: ${e.message}`, -32603);
  }

  return { session_id: args.session_id, selector: args.selector, status: "typed" };
}

async function selectOption(args = {}) {
  requireSessionId(args, "browser_select_option");
  if (!args.selector) throw new ToolError("browser_select_option requires a 'selector' field.", -32602);
  if (args.value === undefined && args.label === undefined)
    throw new ToolError("browser_select_option requires a 'value' or 'label' field.", -32602);
  const { page } = getSession(args.session_id);
  const opt = args.label !== undefined ? { label: String(args.label) } : String(args.value);
  let selected;
  try {
    selected = await page.selectOption(args.selector, opt, { timeout: args.timeout || DEFAULT_TIMEOUT });
  } catch (e) {
    throw new ToolError(`browser_select_option failed: ${e.message}`, -32603);
  }
  return { session_id: args.session_id, selector: args.selector, selected, status: "selected" };
}

async function pressKey(args = {}) {
  requireSessionId(args, "browser_press_key");
  if (!args.key) throw new ToolError("browser_press_key requires a 'key' field.", -32602);
  const { page } = getSession(args.session_id);
  try {
    if (args.selector) {
      await page.press(args.selector, args.key, { timeout: args.timeout || DEFAULT_TIMEOUT });
    } else {
      await page.keyboard.press(args.key);
    }
  } catch (e) {
    throw new ToolError(`browser_press_key failed: ${e.message}`, -32603);
  }
  return { session_id: args.session_id, key: args.key, selector: args.selector || null, status: "pressed" };
}

async function hover(args = {}) {
  requireSessionId(args, "browser_hover");
  if (!args.selector) throw new ToolError("browser_hover requires a 'selector' field.", -32602);
  const { page } = getSession(args.session_id);
  try {
    await page.hover(args.selector, { timeout: args.timeout || DEFAULT_TIMEOUT });
  } catch (e) {
    throw new ToolError(`browser_hover failed: ${e.message}`, -32603);
  }
  return { session_id: args.session_id, selector: args.selector, status: "hovered" };
}

async function uploadFile(args = {}) {
  requireSessionId(args, "browser_upload_file");
  if (!args.selector) throw new ToolError("browser_upload_file requires a 'selector' field.", -32602);
  const raw = args.files !== undefined ? args.files : args.path;
  if (!raw || (Array.isArray(raw) && raw.length === 0))
    throw new ToolError("browser_upload_file requires a 'files' (array) or 'path' field.", -32602);
  const list = Array.isArray(raw) ? raw : [raw];
  const resolvedPaths = list.map((p) => resolveClientPath(String(p)).resolved);
  const { page } = getSession(args.session_id);
  try {
    await page.setInputFiles(args.selector, resolvedPaths, { timeout: args.timeout || DEFAULT_TIMEOUT });
  } catch (e) {
    throw new ToolError(`browser_upload_file failed: ${e.message}`, -32603);
  }
  return { session_id: args.session_id, selector: args.selector, files: list.map(String), status: "uploaded" };
}

async function scroll(args = {}) {
  requireSessionId(args, "browser_scroll");
  const { page } = getSession(args.session_id);
  try {
    if (args.selector) {
      await page.locator(args.selector).scrollIntoViewIfNeeded({ timeout: args.timeout || DEFAULT_TIMEOUT });
    } else {
      const x = Number.isFinite(args.x) ? args.x : 0;
      const y = Number.isFinite(args.y) ? args.y : 0;
      await page.mouse.wheel(x, y);
    }
  } catch (e) {
    throw new ToolError(`browser_scroll failed: ${e.message}`, -32603);
  }
  return { session_id: args.session_id, selector: args.selector || null, status: "scrolled" };
}

async function doubleClick(args = {}) {
  requireSessionId(args, "browser_double_click");
  if (!args.selector) throw new ToolError("browser_double_click requires a 'selector' field.", -32602);
  const { page } = getSession(args.session_id);
  try {
    await page.dblclick(args.selector, { timeout: args.timeout || DEFAULT_TIMEOUT });
  } catch (e) {
    throw new ToolError(`browser_double_click failed: ${e.message}`, -32603);
  }
  return { session_id: args.session_id, selector: args.selector, status: "double_clicked" };
}

async function rightClick(args = {}) {
  requireSessionId(args, "browser_right_click");
  if (!args.selector) throw new ToolError("browser_right_click requires a 'selector' field.", -32602);
  const { page } = getSession(args.session_id);
  try {
    await page.click(args.selector, { button: "right", timeout: args.timeout || DEFAULT_TIMEOUT });
  } catch (e) {
    throw new ToolError(`browser_right_click failed: ${e.message}`, -32603);
  }
  return { session_id: args.session_id, selector: args.selector, status: "right_clicked" };
}

async function dragAndDrop(args = {}) {
  requireSessionId(args, "browser_drag_and_drop");
  if (!args.source) throw new ToolError("browser_drag_and_drop requires a 'source' field.", -32602);
  if (!args.target) throw new ToolError("browser_drag_and_drop requires a 'target' field.", -32602);
  const { page } = getSession(args.session_id);
  const timeout = args.timeout || DEFAULT_TIMEOUT;
  // page.dragAndDrop() only resolves selectors within a single frame — when either endpoint
  // lives inside an <iframe> (source_frame_selector/target_frame_selector), fall back to
  // manual mouse choreography across frameLocator-scoped bounding boxes instead.
  const crossFrame = args.source_frame_selector || args.target_frame_selector;
  try {
    if (!crossFrame) {
      await page.dragAndDrop(args.source, args.target, { timeout });
    } else {
      const srcLocator = args.source_frame_selector ? page.frameLocator(args.source_frame_selector).locator(args.source) : page.locator(args.source);
      const tgtLocator = args.target_frame_selector ? page.frameLocator(args.target_frame_selector).locator(args.target) : page.locator(args.target);
      // Ensure both elements exist/are visible first (also enforces timeout like the same-frame path).
      const srcBox = await srcLocator.boundingBox({ timeout });
      if (!srcBox) throw new Error(`source element '${args.source}' not visible/found`);
      const tgtBox = await tgtLocator.boundingBox({ timeout });
      if (!tgtBox) throw new Error(`target element '${args.target}' not visible/found`);
      // CDP-level page.mouse input dispatched while a button is held does not reliably
      // cross <iframe> boundaries in headless Chromium (events land only after mouseup,
      // if at all — verified empirically). Dispatch native MouseEvents directly on each
      // element's own document instead, which is deterministic regardless of frame nesting.
      const dispatchOn = async (locator, type) => {
        await locator.evaluate((el, evtType) => {
          const r = el.getBoundingClientRect();
          el.dispatchEvent(new MouseEvent(evtType, {
            bubbles: true, cancelable: true, view: el.ownerDocument.defaultView,
            clientX: r.x + r.width / 2, clientY: r.y + r.height / 2,
          }));
        }, type);
      };
      await dispatchOn(srcLocator, "mousedown");
      await dispatchOn(srcLocator, "mousemove");
      await dispatchOn(tgtLocator, "mousemove");
      await dispatchOn(tgtLocator, "mouseup");
    }
  } catch (e) {
    throw new ToolError(`browser_drag_and_drop failed: ${e.message}`, -32603);
  }
  return { session_id: args.session_id, source: args.source, target: args.target, cross_frame: !!crossFrame, status: "dropped" };
}

async function check(args = {}) {
  requireSessionId(args, "browser_check");
  if (!args.selector) throw new ToolError("browser_check requires a 'selector' field.", -32602);
  const { page } = getSession(args.session_id);
  try {
    await page.check(args.selector, { timeout: args.timeout || DEFAULT_TIMEOUT });
  } catch (e) {
    throw new ToolError(`browser_check failed: ${e.message}`, -32603);
  }
  return { session_id: args.session_id, selector: args.selector, status: "checked" };
}

async function uncheck(args = {}) {
  requireSessionId(args, "browser_uncheck");
  if (!args.selector) throw new ToolError("browser_uncheck requires a 'selector' field.", -32602);
  const { page } = getSession(args.session_id);
  try {
    await page.uncheck(args.selector, { timeout: args.timeout || DEFAULT_TIMEOUT });
  } catch (e) {
    throw new ToolError(`browser_uncheck failed: ${e.message}`, -32603);
  }
  return { session_id: args.session_id, selector: args.selector, status: "unchecked" };
}

module.exports = {
  click, type, selectOption, pressKey, hover, uploadFile, scroll,
  doubleClick, rightClick, dragAndDrop, check, uncheck,
};
