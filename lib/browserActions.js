"use strict";
// ── BROWSER PAGE ACTIONS: navigate/content/evaluate/click/type/screenshot/console ──

const { ToolError } = require("./errors");
const { resolveClientPath, clientRelative } = require("./roots");
const { getSession } = require("./browserLaunch");

const DEFAULT_TIMEOUT = 30000;
const MAX_CONTENT_CHARS = 200000; // guard against dumping megabytes of HTML into a tool result

function requireSessionId(args, tool) {
  if (!args || !args.session_id)
    throw new ToolError(`${tool} requires a 'session_id' field.`, -32602);
}

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

async function getCookies(args = {}) {
  requireSessionId(args, "browser_get_cookies");
  const { context } = getSession(args.session_id);
  let cookies;
  try {
    cookies = args.urls ? await context.cookies(args.urls) : await context.cookies();
  } catch (e) {
    throw new ToolError(`browser_get_cookies failed: ${e.message}`, -32603);
  }
  return { session_id: args.session_id, cookies, count: cookies.length };
}

async function setCookies(args = {}) {
  requireSessionId(args, "browser_set_cookies");
  if (!Array.isArray(args.cookies) || args.cookies.length === 0)
    throw new ToolError("browser_set_cookies requires a non-empty 'cookies' array.", -32602);
  for (const c of args.cookies) {
    if (!c || typeof c.name !== "string" || typeof c.value !== "string" || (!c.url && !c.domain))
      throw new ToolError("Each cookie requires 'name', 'value', and either 'url' or 'domain'.", -32602);
  }
  const { context } = getSession(args.session_id);
  try {
    await context.addCookies(args.cookies);
  } catch (e) {
    throw new ToolError(`browser_set_cookies failed: ${e.message}`, -32603);
  }
  return { session_id: args.session_id, status: "set", count: args.cookies.length };
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

module.exports = {
  navigate, getContent, evaluate, click, type, screenshot, getConsoleLogs,
  waitForSelector, goBack, goForward, reload, getCookies, setCookies, pdf, selectOption, pressKey,
};
