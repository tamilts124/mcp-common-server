"use strict";
// ── BROWSER STORAGE/CONTEXT: cookies/local storage/storage state/headers/emulation ──
const { ToolError, getSession, requireSessionId } = require("./shared");

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

const COLOR_SCHEMES = new Set(["light", "dark", "no-preference", "null"]);

async function emulate(args = {}) {
  requireSessionId(args, "browser_emulate");
  const entry = getSession(args.session_id);
  const applied = {};

  if (args.viewport && typeof args.viewport === "object") {
    const w = args.viewport.width, h = args.viewport.height;
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0)
      throw new ToolError("browser_emulate viewport requires positive numeric width/height.", -32602);
    try { await entry.page.setViewportSize({ width: w, height: h }); }
    catch (e) { throw new ToolError(`browser_emulate viewport failed: ${e.message}`, -32603); }
    applied.viewport = { width: w, height: h };
  }

  if (args.geolocation && typeof args.geolocation === "object") {
    const { latitude, longitude, accuracy } = args.geolocation;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude))
      throw new ToolError("browser_emulate geolocation requires numeric latitude/longitude.", -32602);
    try {
      await entry.context.grantPermissions(["geolocation"]);
      await entry.context.setGeolocation({ latitude, longitude, accuracy: Number.isFinite(accuracy) ? accuracy : undefined });
    } catch (e) { throw new ToolError(`browser_emulate geolocation failed: ${e.message}`, -32603); }
    applied.geolocation = { latitude, longitude, accuracy: accuracy ?? null };
  }

  if (args.color_scheme !== undefined) {
    const scheme = args.color_scheme === null ? "null" : String(args.color_scheme);
    if (!COLOR_SCHEMES.has(scheme))
      throw new ToolError("browser_emulate color_scheme must be one of: light, dark, no-preference, null.", -32602);
    try { await entry.page.emulateMedia({ colorScheme: scheme === "null" ? null : scheme }); }
    catch (e) { throw new ToolError(`browser_emulate color_scheme failed: ${e.message}`, -32603); }
    applied.color_scheme = scheme;
  }

  if (args.offline !== undefined) {
    try { await entry.context.setOffline(!!args.offline); }
    catch (e) { throw new ToolError(`browser_emulate offline failed: ${e.message}`, -32603); }
    applied.offline = !!args.offline;
  }

  if (Object.keys(applied).length === 0)
    throw new ToolError("browser_emulate requires at least one of: viewport, geolocation, color_scheme, offline.", -32602);

  return { session_id: args.session_id, applied };
}

async function setExtraHeaders(args = {}) {
  requireSessionId(args, "browser_set_extra_headers");
  if (!args.headers || typeof args.headers !== "object" || Array.isArray(args.headers) || Object.keys(args.headers).length === 0)
    throw new ToolError("browser_set_extra_headers requires a non-empty 'headers' object.", -32602);
  const headers = {};
  for (const [k, v] of Object.entries(args.headers)) {
    if (typeof v !== "string")
      throw new ToolError(`browser_set_extra_headers header '${k}' must be a string value.`, -32602);
    headers[k] = v;
  }
  const { context } = getSession(args.session_id);
  try {
    await context.setExtraHTTPHeaders(headers);
  } catch (e) {
    throw new ToolError(`browser_set_extra_headers failed: ${e.message}`, -32603);
  }
  return { session_id: args.session_id, headers_set: Object.keys(headers).length };
}

async function getLocalStorage(args = {}) {
  requireSessionId(args, "browser_get_local_storage");
  const { page } = getSession(args.session_id);
  let items;
  try {
    items = await page.evaluate(() => {
      const out = {};
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        out[k] = window.localStorage.getItem(k);
      }
      return out;
    });
  } catch (e) {
    throw new ToolError(`browser_get_local_storage failed: ${e.message}`, -32603);
  }
  return { session_id: args.session_id, url: page.url(), items, count: Object.keys(items).length };
}

async function setLocalStorage(args = {}) {
  requireSessionId(args, "browser_set_local_storage");
  if (!args.items || typeof args.items !== "object" || Array.isArray(args.items) || Object.keys(args.items).length === 0)
    throw new ToolError("browser_set_local_storage requires a non-empty 'items' object of string key/value pairs.", -32602);
  const items = {};
  for (const [k, v] of Object.entries(args.items)) {
    if (typeof v !== "string")
      throw new ToolError(`browser_set_local_storage item '${k}' must be a string value.`, -32602);
    items[k] = v;
  }
  const { page } = getSession(args.session_id);
  try {
    await page.evaluate((data) => {
      for (const [k, v] of Object.entries(data)) window.localStorage.setItem(k, v);
    }, items);
  } catch (e) {
    throw new ToolError(`browser_set_local_storage failed: ${e.message}`, -32603);
  }
  return { session_id: args.session_id, items_set: Object.keys(items).length };
}

async function getStorageState(args = {}) {
  requireSessionId(args, "browser_get_storage_state");
  const { context } = getSession(args.session_id);
  let state;
  try {
    state = await context.storageState();
  } catch (e) {
    throw new ToolError(`browser_get_storage_state failed: ${e.message}`, -32603);
  }
  return { session_id: args.session_id, storage_state: state, cookie_count: state.cookies.length, origin_count: state.origins.length };
}

module.exports = {
  getCookies, setCookies, emulate, setExtraHeaders, getLocalStorage, setLocalStorage, getStorageState,
};
