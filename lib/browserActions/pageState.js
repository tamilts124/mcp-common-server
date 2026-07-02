"use strict";
// ── BROWSER PAGE STATE: nav-history/waits/element-state queries/metrics ──
// Extracted from lib/browserActions/core.js (which had grown past the 500-line threshold).
const {
  ToolError, getSession,
  DEFAULT_TIMEOUT, requireSessionId,
} = require("./shared");

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

function getCurrentUrl(args = {}) {
  requireSessionId(args, "browser_get_current_url");
  const { page } = getSession(args.session_id);
  return { session_id: args.session_id, url: page.url() };
}

async function getTitle(args = {}) {
  requireSessionId(args, "browser_get_title");
  const { page } = getSession(args.session_id);
  let title;
  try {
    title = await page.title();
  } catch (e) {
    throw new ToolError(`browser_get_title failed: ${e.message}`, -32603);
  }
  return { session_id: args.session_id, title };
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

module.exports = {
  getConsoleLogs, waitForSelector, getCurrentUrl, getTitle, goBack, goForward, reload,
  waitForNavigation, getAttribute, isVisible, isChecked, getElementInfo, getPageMetrics,
};
