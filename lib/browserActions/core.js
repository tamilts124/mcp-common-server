"use strict";
// ── BROWSER CORE: navigate/content/evaluate/input/interaction/element-state/scripting ──
const {
  ToolError, resolveClientPath, clientRelative, getSession,
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

async function screenshot(args = {}) {
  requireSessionId(args, "browser_screenshot");
  if (!args.path) throw new ToolError("browser_screenshot requires a 'path' field.", -32602);
  const { page } = getSession(args.session_id);
  const { alias, resolved } = resolveClientPath(args.path);

  try {
    await page.screenshot({ path: resolved, fullPage: !!args.full_page });
  } catch (e) {
    throw new ToolError(`browser_screenshot failed: ${e.message}`, -32603);
  }

  return { session_id: args.session_id, path: clientRelative(alias, resolved), full_page: !!args.full_page };
}

function getConsoleLogs(args = {}) {
  requireSessionId(args, "browser_get_console_logs");
  const entry = getSession(args.session_id);
  const logs = entry.consoleLogs.slice();
  if (args.clear) entry.consoleLogs = [];
  return { session_id: args.session_id, logs, count: logs.length, cleared: !!args.clear };
}

async function waitForSelector(args = {}) {
  requireSessionId(args, "browser_wait_for_selector");
  if (!args.selector) throw new ToolError("browser_wait_for_selector requires a 'selector' field.", -32602);
  const { page } = getSession(args.session_id);
  try {
    await page.waitForSelector(args.selector, {
      timeout: args.timeout || DEFAULT_TIMEOUT,
      state: args.state || "visible",
    });
  } catch (e) {
    throw new ToolError(`browser_wait_for_selector failed: ${e.message}`, -32603);
  }
  return { session_id: args.session_id, selector: args.selector, state: args.state || "visible", status: "found" };
}

async function goBack(args = {}) {
  requireSessionId(args, "browser_go_back");
  const { page } = getSession(args.session_id);
  try {
    await page.goBack({ timeout: args.timeout || DEFAULT_TIMEOUT, waitUntil: args.wait_until || "load" });
  } catch (e) {
    throw new ToolError(`browser_go_back failed: ${e.message}`, -32603);
  }
  return { session_id: args.session_id, url: page.url(), status: "back" };
}

async function goForward(args = {}) {
  requireSessionId(args, "browser_go_forward");
  const { page } = getSession(args.session_id);
  try {
    await page.goForward({ timeout: args.timeout || DEFAULT_TIMEOUT, waitUntil: args.wait_until || "load" });
  } catch (e) {
    throw new ToolError(`browser_go_forward failed: ${e.message}`, -32603);
  }
  return { session_id: args.session_id, url: page.url(), status: "forward" };
}

async function reload(args = {}) {
  requireSessionId(args, "browser_reload");
  const { page } = getSession(args.session_id);
  try {
    await page.reload({ timeout: args.timeout || DEFAULT_TIMEOUT, waitUntil: args.wait_until || "load" });
  } catch (e) {
    throw new ToolError(`browser_reload failed: ${e.message}`, -32603);
  }
  return { session_id: args.session_id, url: page.url(), status: "reloaded" };
}

async function pdf(args = {}) {
  requireSessionId(args, "browser_pdf");
  if (!args.path) throw new ToolError("browser_pdf requires a 'path' field.", -32602);
  const { page } = getSession(args.session_id);
  const { alias, resolved } = resolveClientPath(args.path);
  try {
    await page.pdf({ path: resolved, format: args.format || "A4", printBackground: args.print_background !== false });
  } catch (e) {
    throw new ToolError(`browser_pdf failed: ${e.message}`, -32603);
  }
  return { session_id: args.session_id, path: clientRelative(alias, resolved), format: args.format || "A4" };
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

async function waitForNavigation(args = {}) {
  requireSessionId(args, "browser_wait_for_navigation");
  const { page } = getSession(args.session_id);
  try {
    await page.waitForLoadState(args.wait_until || "load", { timeout: args.timeout || DEFAULT_TIMEOUT });
  } catch (e) {
    throw new ToolError(`browser_wait_for_navigation failed: ${e.message}`, -32603);
  }
  return { session_id: args.session_id, url: page.url(), wait_until: args.wait_until || "load", status: "settled" };
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
  try {
    await page.dragAndDrop(args.source, args.target, { timeout: args.timeout || DEFAULT_TIMEOUT });
  } catch (e) {
    throw new ToolError(`browser_drag_and_drop failed: ${e.message}`, -32603);
  }
  return { session_id: args.session_id, source: args.source, target: args.target, status: "dropped" };
}

async function download(args = {}) {
  requireSessionId(args, "browser_download");
  if (!args.selector) throw new ToolError("browser_download requires a 'selector' field.", -32602);
  if (!args.path) throw new ToolError("browser_download requires a 'path' field.", -32602);
  const { page } = getSession(args.session_id);
  const { alias, resolved } = resolveClientPath(args.path);

  let download;
  try {
    const [dl] = await Promise.all([
      page.waitForEvent("download", { timeout: args.timeout || DEFAULT_TIMEOUT }),
      page.click(args.selector, { timeout: args.timeout || DEFAULT_TIMEOUT }),
    ]);
    download = dl;
    await download.saveAs(resolved);
  } catch (e) {
    throw new ToolError(`browser_download failed: ${e.message}`, -32603);
  }

  return {
    session_id: args.session_id,
    selector: args.selector,
    path: clientRelative(alias, resolved),
    suggested_filename: download.suggestedFilename(),
    status: "downloaded",
  };
}

async function getAttribute(args = {}) {
  requireSessionId(args, "browser_get_attribute");
  if (!args.selector) throw new ToolError("browser_get_attribute requires a 'selector' field.", -32602);
  if (!args.attribute) throw new ToolError("browser_get_attribute requires an 'attribute' field.", -32602);
  const { page } = getSession(args.session_id);
  let value;
  try {
    const el = await page.$(args.selector);
    if (!el) throw new ToolError(`Selector not found: ${args.selector}`, -32602);
    value = await el.getAttribute(args.attribute);
  } catch (e) {
    if (e instanceof ToolError) throw e;
    throw new ToolError(`browser_get_attribute failed: ${e.message}`, -32603);
  }
  return { session_id: args.session_id, selector: args.selector, attribute: args.attribute, value };
}

async function isVisible(args = {}) {
  requireSessionId(args, "browser_is_visible");
  if (!args.selector) throw new ToolError("browser_is_visible requires a 'selector' field.", -32602);
  const { page } = getSession(args.session_id);
  let visible;
  try {
    visible = await page.isVisible(args.selector);
  } catch (e) {
    throw new ToolError(`browser_is_visible failed: ${e.message}`, -32603);
  }
  return { session_id: args.session_id, selector: args.selector, visible };
}

async function isChecked(args = {}) {
  requireSessionId(args, "browser_is_checked");
  if (!args.selector) throw new ToolError("browser_is_checked requires a 'selector' field.", -32602);
  const { page } = getSession(args.session_id);
  let checked;
  try {
    checked = await page.isChecked(args.selector);
  } catch (e) {
    throw new ToolError(`browser_is_checked failed: ${e.message}`, -32603);
  }
  return { session_id: args.session_id, selector: args.selector, checked };
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

async function getElementInfo(args = {}) {
  requireSessionId(args, "browser_get_element_info");
  if (!args.selector) throw new ToolError("browser_get_element_info requires a 'selector' field.", -32602);
  const { page } = getSession(args.session_id);
  let info;
  try {
    const el = await page.$(args.selector);
    if (!el) throw new ToolError(`Selector not found: ${args.selector}`, -32602);
    const box = await el.boundingBox();
    info = await el.evaluate((node) => {
      const attributes = {};
      for (const a of node.attributes) attributes[a.name] = a.value;
      return { tag: node.tagName.toLowerCase(), text: node.textContent, attributes };
    });
    info.bounding_box = box;
  } catch (e) {
    if (e instanceof ToolError) throw e;
    throw new ToolError(`browser_get_element_info failed: ${e.message}`, -32603);
  }
  return { session_id: args.session_id, selector: args.selector, ...info };
}

async function addInitScript(args = {}) {
  requireSessionId(args, "browser_add_init_script");
  if (!args.script || typeof args.script !== "string")
    throw new ToolError("browser_add_init_script requires a 'script' string field.", -32602);
  const { context } = getSession(args.session_id);
  try {
    await context.addInitScript({ content: args.script });
  } catch (e) {
    throw new ToolError(`browser_add_init_script failed: ${e.message}`, -32603);
  }
  return { session_id: args.session_id, applied: true, script_length: args.script.length };
}

async function getPageMetrics(args = {}) {
  requireSessionId(args, "browser_get_page_metrics");
  const { page } = getSession(args.session_id);
  let metrics;
  try {
    metrics = await page.evaluate(() => {
      const nav = performance.getEntriesByType("navigation")[0] || {};
      const resources = performance.getEntriesByType("resource");
      return {
        dom_content_loaded_ms: nav.domContentLoadedEventEnd ?? null,
        load_event_ms: nav.loadEventEnd ?? null,
        ttfb_ms: nav.responseStart ?? null,
        transfer_size_bytes: nav.transferSize ?? null,
        resource_count: resources.length,
        js_heap_used_bytes: (performance.memory && performance.memory.usedJSHeapSize) ?? null,
      };
    });
  } catch (e) {
    throw new ToolError(`browser_get_page_metrics failed: ${e.message}`, -32603);
  }
  return { session_id: args.session_id, url: page.url(), metrics };
}

const MAX_EXPOSED_CALLS = 200;
const FUNC_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

async function exposeFunction(args = {}) {
  requireSessionId(args, "browser_expose_function");
  if (!args.name || typeof args.name !== "string" || !FUNC_NAME_RE.test(args.name))
    throw new ToolError("browser_expose_function requires a valid identifier 'name' (letters/digits/_/$, not starting with a digit).", -32602);
  const entry = getSession(args.session_id);
  entry.exposedFunctions = entry.exposedFunctions || new Set();
  entry.exposedCalls = entry.exposedCalls || [];
  if (entry.exposedFunctions.has(args.name))
    throw new ToolError(`browser_expose_function: '${args.name}' is already exposed on this session.`, -32602);
  try {
    await entry.page.exposeFunction(args.name, (...callArgs) => {
      entry.exposedCalls.push({ name: args.name, args: callArgs, time: new Date().toISOString() });
      if (entry.exposedCalls.length > MAX_EXPOSED_CALLS) entry.exposedCalls = entry.exposedCalls.slice(-MAX_EXPOSED_CALLS);
      return { received: true };
    });
  } catch (e) {
    throw new ToolError(`browser_expose_function failed: ${e.message}`, -32603);
  }
  entry.exposedFunctions.add(args.name);
  return { session_id: args.session_id, name: args.name, exposed: true };
}

function getExposedCalls(args = {}) {
  requireSessionId(args, "browser_get_exposed_calls");
  const entry = getSession(args.session_id);
  let calls = (entry.exposedCalls || []).slice();
  if (args.name) calls = calls.filter((c) => c.name === String(args.name));
  const limit = Number.isFinite(args.limit) && args.limit > 0 ? Math.min(args.limit, MAX_EXPOSED_CALLS) : MAX_EXPOSED_CALLS;
  calls = calls.slice(-limit);
  if (args.clear) entry.exposedCalls = [];
  return { session_id: args.session_id, calls, count: calls.length, cleared: !!args.clear };
}

async function waitForResponse(args = {}) {
  requireSessionId(args, "browser_wait_for_response");
  if (!args.url_pattern || typeof args.url_pattern !== "string")
    throw new ToolError("browser_wait_for_response requires a 'url_pattern' string field.", -32602);
  const { page } = getSession(args.session_id);
  const expectStatus = args.status;
  let response;
  try {
    response = await page.waitForResponse(
      (res) => res.url().includes(args.url_pattern) && (expectStatus === undefined || res.status() === expectStatus),
      { timeout: args.timeout || DEFAULT_TIMEOUT },
    );
  } catch (e) {
    throw new ToolError(`browser_wait_for_response timed out or failed: ${e.message}`, -32603);
  }
  return { session_id: args.session_id, url: response.url(), status: response.status(), ok: response.ok() };
}

module.exports = {
  navigate, getContent, evaluate, click, type, screenshot, getConsoleLogs,
  waitForSelector, goBack, goForward, reload, pdf, selectOption, pressKey,
  waitForNavigation, hover, uploadFile, scroll, doubleClick, rightClick, dragAndDrop, download,
  getAttribute, isVisible, isChecked, check, uncheck, getElementInfo,
  addInitScript, getPageMetrics, exposeFunction, getExposedCalls, waitForResponse,
};
