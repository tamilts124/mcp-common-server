"use strict";
/**
 * woocommerceClientOps.js
 * Zero-dependency WooCommerce REST API v3 client (pure Node.js https; no npm deps).
 *
 * Auth: Consumer Key + Consumer Secret via HTTP Basic Auth (over HTTPS).
 * Base URL: https://{site_url}/wp-json/wc/v3/
 *
 * Supports:
 *   Products (7): product_list, product_get, product_create, product_update,
 *                 product_delete, product_count, product_variations
 *   Orders (7):   order_list, order_get, order_create, order_update,
 *                 order_delete, order_count, order_notes
 *   Customers (6): customer_list, customer_get, customer_create, customer_update,
 *                  customer_delete, customer_count
 *   Coupons (5):  coupon_list, coupon_get, coupon_create, coupon_update, coupon_delete
 *   Reports (3):  report_sales, report_top_sellers, report_orders_totals
 *   Settings (2): settings_get, settings_update
 *   System (1):   system_status
 *   Generic (1):  request
 *
 * Security: NUL-byte guards on all string inputs; credentials scrubbed from ALL
 * error messages; 16 MB response cap; timeout clamped 1000–120000 ms; TLS enforced.
 */

const https = require("https");

// ── Constants ─────────────────────────────────────────────────────────────────
const DEFAULT_TIMEOUT   = 20_000;
const MIN_TIMEOUT       = 1_000;
const MAX_TIMEOUT       = 120_000;
const MAX_RESPONSE_BODY = 16 * 1024 * 1024; // 16 MB
const WC_API_PATH       = "/wp-json/wc/v3";
const NUL_RE            = /\x00/;

// ── Helpers ───────────────────────────────────────────────────────────────────
function scrubCreds(str, ...secrets) {
  let s = String(str);
  for (const sec of secrets) {
    if (sec) s = s.split(sec).join("[REDACTED]");
  }
  return s;
}

function validateNul(val, name) {
  if (typeof val === "string" && NUL_RE.test(val))
    throw new Error(`${name} must not contain NUL bytes`);
}

function clampTimeout(t) {
  if (t == null) return DEFAULT_TIMEOUT;
  const n = Number(t);
  if (!isFinite(n)) return DEFAULT_TIMEOUT;
  return Math.max(MIN_TIMEOUT, Math.min(MAX_TIMEOUT, Math.round(n)));
}

function requireString(val, name) {
  if (typeof val !== "string" || !val.trim())
    throw new Error(`${name} is required and must be a non-empty string`);
  validateNul(val, name);
  return val.trim();
}

function optStr(val, name) {
  if (val == null) return undefined;
  if (typeof val !== "string") throw new Error(`${name} must be a string`);
  validateNul(val, name);
  return val;
}

function optInt(val, name, min, max) {
  if (val == null) return undefined;
  const n = Number(val);
  if (!isFinite(n) || !Number.isInteger(n))
    throw new Error(`${name} must be an integer`);
  if (min != null && n < min) throw new Error(`${name} must be >= ${min}`);
  if (max != null && n > max) throw new Error(`${name} must be <= ${max}`);
  return n;
}

function requireId(val, name) {
  if (val == null) throw new Error(`${name} is required and must be a non-empty string`);
  return requireString(String(val), name);
}

/**
 * Parse a site URL and return hostname + base path prefix.
 * Strips trailing slash, extracts host, supports subdirectory installs.
 * e.g. "https://example.com/shop" → { hostname: "example.com", pathPrefix: "/shop" }
 */
function parseSiteUrl(raw) {
  validateNul(raw, "site_url");
  const url = raw.trim().replace(/\/+$/, "");
  // Add scheme if missing so URL constructor works
  const withScheme = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch (_) {
    throw new Error(`site_url is not a valid URL: ${raw}`);
  }
  const hostname   = parsed.hostname;
  const pathPrefix = parsed.pathname.replace(/\/+$/, ""); // e.g. "" or "/shop"

  // Validate hostname — must contain only valid characters (letters, digits, hyphens, dots)
  // and must have at least one dot (or be localhost) to be a real hostname.
  if (!hostname) throw new Error(`site_url has empty hostname: ${raw}`);
  // RFC 1123 hostname: labels of [a-z0-9-], separated by dots, no leading/trailing hyphens.
  const HOSTNAME_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$|^localhost$|^(?:\d{1,3}\.){3}\d{1,3}$/i;
  if (!HOSTNAME_RE.test(hostname))
    throw new Error(`site_url has an invalid hostname "${hostname}": ${raw}`);

  return { hostname, pathPrefix };
}

/**
 * Low-level HTTPS request (returns raw status + parsed body).
 */
function rawRequest({ hostname, path, method, headers, body, timeout, rejectUnauthorized }) {
  return new Promise((resolve, reject) => {
    const ms = clampTimeout(timeout);

    const bodyStr = body != null
      ? (typeof body === "string" ? body : JSON.stringify(body))
      : null;

    const hdrs = { ...headers };
    if (bodyStr) {
      if (!hdrs["Content-Type"]) hdrs["Content-Type"] = "application/json";
      hdrs["Content-Length"] = Buffer.byteLength(bodyStr);
    }

    const options = {
      hostname,
      port: 443,
      path,
      method: method || "GET",
      headers: hdrs,
      rejectUnauthorized: rejectUnauthorized !== false,
    };

    let timer;
    const req = https.request(options, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BODY) {
          req.destroy();
          clearTimeout(timer);
          reject(new Error("Response body exceeds 16 MB limit"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        clearTimeout(timer);
        const raw = Buffer.concat(chunks).toString("utf8");
        const status = res.statusCode;
        const totalCount = res.headers["x-wp-total"]     || null;
        const totalPages = res.headers["x-wp-totalpages"] || null;
        if (!raw.trim()) { resolve({ status, body: null, totalCount, totalPages }); return; }
        let parsed;
        try { parsed = JSON.parse(raw); } catch (_) { parsed = { _raw: raw }; }
        resolve({ status, body: parsed, totalCount, totalPages });
      });
      res.on("error", (err) => { clearTimeout(timer); reject(new Error(err.message)); });
    });

    timer = setTimeout(() => {
      reject(new Error(`WooCommerce request timed out after ${ms} ms`));
      req.destroy();
    }, ms);

    req.on("error", (err) => { clearTimeout(timer); reject(new Error(err.message)); });

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/**
 * Build context from tool args.
 */
function buildCtx(args) {
  const siteUrl          = requireString(args.site_url, "site_url");
  const consumer_key     = requireString(args.consumer_key, "consumer_key");
  const consumer_secret  = requireString(args.consumer_secret, "consumer_secret");

  const { hostname, pathPrefix } = parseSiteUrl(siteUrl);
  const b64 = Buffer.from(`${consumer_key}:${consumer_secret}`).toString("base64");

  return {
    hostname,
    apiBase:            pathPrefix + WC_API_PATH,
    authHeader:         `Basic ${b64}`,
    timeout:            clampTimeout(args.timeout),
    rejectUnauthorized: args.reject_unauthorized !== false,
    _secrets:           [consumer_key, consumer_secret],
  };
}

/**
 * WooCommerce REST request.
 */
async function wcRequest(ctx, method, path, body, params, allowedStatuses) {
  let fullPath = ctx.apiBase + path;

  if ((method === "GET" || method === "DELETE") && params && Object.keys(params).length) {
    const filtered = Object.entries(params).filter(([, v]) => v != null);
    if (filtered.length) {
      const qs = filtered
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join("&");
      fullPath += "?" + qs;
    }
  }

  const headers = {
    "Authorization": ctx.authHeader,
    "Accept":        "application/json",
    "User-Agent":    "mcp-common-server/woocommerce_client",
  };

  const res = await rawRequest({
    hostname:           ctx.hostname,
    path:               fullPath,
    method,
    headers,
    body:               (method !== "GET" && method !== "DELETE") ? (body ?? null) : null,
    timeout:            ctx.timeout,
    rejectUnauthorized: ctx.rejectUnauthorized,
  });

  const ok = allowedStatuses
    ? allowedStatuses.includes(res.status)
    : res.status >= 200 && res.status < 300;

  if (!ok) {
    const errBody = res.body ? JSON.stringify(res.body) : "(empty)";
    const scrubbed = scrubCreds(errBody, ...ctx._secrets);
    throw new Error(`WooCommerce API error ${res.status}: ${scrubbed}`);
  }

  // Attach pagination metadata when present
  const result = res.body;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    if (res.totalCount != null) result._total  = res.totalCount;
    if (res.totalPages != null) result._pages  = res.totalPages;
  } else if (Array.isArray(result)) {
    // Return as wrapper object with pagination
    return {
      data:   result,
      _total: res.totalCount,
      _pages: res.totalPages,
    };
  }
  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRODUCTS
// ═══════════════════════════════════════════════════════════════════════════════

async function productList(ctx, args) {
  const params = {};
  const p = optInt(args.per_page, "per_page", 1, 100);
  const pg = optInt(args.page, "page", 1);
  if (p  != null) params.per_page = p;
  if (pg != null) params.page     = pg;
  const status = optStr(args.status, "status");
  const type   = optStr(args.type,   "type");
  const search = optStr(args.search, "search");
  const category = optStr(args.category, "category");
  const order    = optStr(args.order,    "order");
  const orderby  = optStr(args.orderby,  "orderby");
  if (status)   params.status   = status;
  if (type)     params.type     = type;
  if (search)   params.search   = search;
  if (category) params.category = category;
  if (order)    params.order    = order;
  if (orderby)  params.orderby  = orderby;
  return wcRequest(ctx, "GET", "/products", null, params, [200]);
}

async function productGet(ctx, args) {
  const id = requireId(args.id, "id");
  return wcRequest(ctx, "GET", `/products/${encodeURIComponent(id)}`, null, null, [200]);
}

async function productCreate(ctx, args) {
  const data = args.data;
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("data (object) is required for product_create");
  return wcRequest(ctx, "POST", "/products", data, null, [201]);
}

async function productUpdate(ctx, args) {
  const id   = requireId(args.id, "id");
  const data = args.data;
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("data (object) is required for product_update");
  return wcRequest(ctx, "PUT", `/products/${encodeURIComponent(id)}`, data, null, [200]);
}

async function productDelete(ctx, args) {
  const id    = requireId(args.id, "id");
  const force = args.force !== false; // default true — moves to trash otherwise
  const params = { force: force ? "true" : "false" };
  const res = await wcRequest(ctx, "DELETE", `/products/${encodeURIComponent(id)}`, null, params, [200]);
  return res ?? { deleted: true, id };
}

async function productCount(ctx, args) {
  const params = {};
  const status = optStr(args.status, "status");
  if (status) params.status = status;
  return wcRequest(ctx, "GET", "/products/count", null, params, [200]);
}

async function productVariations(ctx, args) {
  const product_id = requireId(args.product_id, "product_id");
  const params = {};
  const p  = optInt(args.per_page, "per_page", 1, 100);
  const pg = optInt(args.page,     "page",     1);
  if (p  != null) params.per_page = p;
  if (pg != null) params.page     = pg;
  return wcRequest(ctx, "GET", `/products/${encodeURIComponent(product_id)}/variations`, null, params, [200]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ORDERS
// ═══════════════════════════════════════════════════════════════════════════════

async function orderList(ctx, args) {
  const params = {};
  const p  = optInt(args.per_page, "per_page", 1, 100);
  const pg = optInt(args.page,     "page",     1);
  if (p  != null) params.per_page = p;
  if (pg != null) params.page     = pg;
  const status  = optStr(args.status,   "status");
  const customer = optStr(args.customer, "customer");
  const product  = optStr(args.product,  "product");
  const after    = optStr(args.after,    "after");
  const before   = optStr(args.before,   "before");
  const order    = optStr(args.order,    "order");
  const orderby  = optStr(args.orderby,  "orderby");
  if (status)   params.status   = status;
  if (customer) params.customer = customer;
  if (product)  params.product  = product;
  if (after)    params.after    = after;
  if (before)   params.before   = before;
  if (order)    params.order    = order;
  if (orderby)  params.orderby  = orderby;
  return wcRequest(ctx, "GET", "/orders", null, params, [200]);
}

async function orderGet(ctx, args) {
  const id = requireId(args.id, "id");
  return wcRequest(ctx, "GET", `/orders/${encodeURIComponent(id)}`, null, null, [200]);
}

async function orderCreate(ctx, args) {
  const data = args.data;
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("data (object) is required for order_create");
  return wcRequest(ctx, "POST", "/orders", data, null, [201]);
}

async function orderUpdate(ctx, args) {
  const id   = requireId(args.id, "id");
  const data = args.data;
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("data (object) is required for order_update");
  return wcRequest(ctx, "PUT", `/orders/${encodeURIComponent(id)}`, data, null, [200]);
}

async function orderDelete(ctx, args) {
  const id    = requireId(args.id, "id");
  const force = args.force !== false;
  const params = { force: force ? "true" : "false" };
  const res = await wcRequest(ctx, "DELETE", `/orders/${encodeURIComponent(id)}`, null, params, [200]);
  return res ?? { deleted: true, id };
}

async function orderCount(ctx, args) {
  const params = {};
  const status = optStr(args.status, "status");
  if (status) params.status = status;
  return wcRequest(ctx, "GET", "/orders/count", null, params, [200]);
}

async function orderNotes(ctx, args) {
  const id = requireId(args.id, "id");
  return wcRequest(ctx, "GET", `/orders/${encodeURIComponent(id)}/notes`, null, null, [200]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// CUSTOMERS
// ═══════════════════════════════════════════════════════════════════════════════

async function customerList(ctx, args) {
  const params = {};
  const p  = optInt(args.per_page, "per_page", 1, 100);
  const pg = optInt(args.page,     "page",     1);
  if (p  != null) params.per_page = p;
  if (pg != null) params.page     = pg;
  const search  = optStr(args.search,  "search");
  const email   = optStr(args.email,   "email");
  const role    = optStr(args.role,    "role");
  const order   = optStr(args.order,   "order");
  const orderby = optStr(args.orderby, "orderby");
  if (search)  params.search  = search;
  if (email)   params.email   = email;
  if (role)    params.role    = role;
  if (order)   params.order   = order;
  if (orderby) params.orderby = orderby;
  return wcRequest(ctx, "GET", "/customers", null, params, [200]);
}

async function customerGet(ctx, args) {
  const id = requireId(args.id, "id");
  return wcRequest(ctx, "GET", `/customers/${encodeURIComponent(id)}`, null, null, [200]);
}

async function customerCreate(ctx, args) {
  const data = args.data;
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("data (object) is required for customer_create");
  return wcRequest(ctx, "POST", "/customers", data, null, [201]);
}

async function customerUpdate(ctx, args) {
  const id   = requireId(args.id, "id");
  const data = args.data;
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("data (object) is required for customer_update");
  return wcRequest(ctx, "PUT", `/customers/${encodeURIComponent(id)}`, data, null, [200]);
}

async function customerDelete(ctx, args) {
  const id    = requireId(args.id, "id");
  const force = args.force !== false;
  const params = { force: force ? "true" : "false" };
  const res = await wcRequest(ctx, "DELETE", `/customers/${encodeURIComponent(id)}`, null, params, [200]);
  return res ?? { deleted: true, id };
}

async function customerCount(ctx, args) {
  const params = {};
  const role = optStr(args.role, "role");
  if (role) params.role = role;
  return wcRequest(ctx, "GET", "/customers/count", null, params, [200]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// COUPONS
// ═══════════════════════════════════════════════════════════════════════════════

async function couponList(ctx, args) {
  const params = {};
  const p  = optInt(args.per_page, "per_page", 1, 100);
  const pg = optInt(args.page,     "page",     1);
  if (p  != null) params.per_page = p;
  if (pg != null) params.page     = pg;
  const search = optStr(args.search, "search");
  const code   = optStr(args.code,   "code");
  if (search) params.search = search;
  if (code)   params.code   = code;
  return wcRequest(ctx, "GET", "/coupons", null, params, [200]);
}

async function couponGet(ctx, args) {
  const id = requireId(args.id, "id");
  return wcRequest(ctx, "GET", `/coupons/${encodeURIComponent(id)}`, null, null, [200]);
}

async function couponCreate(ctx, args) {
  const data = args.data;
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("data (object) is required for coupon_create");
  return wcRequest(ctx, "POST", "/coupons", data, null, [201]);
}

async function couponUpdate(ctx, args) {
  const id   = requireId(args.id, "id");
  const data = args.data;
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("data (object) is required for coupon_update");
  return wcRequest(ctx, "PUT", `/coupons/${encodeURIComponent(id)}`, data, null, [200]);
}

async function couponDelete(ctx, args) {
  const id    = requireId(args.id, "id");
  const force = args.force !== false;
  const params = { force: force ? "true" : "false" };
  const res = await wcRequest(ctx, "DELETE", `/coupons/${encodeURIComponent(id)}`, null, params, [200]);
  return res ?? { deleted: true, id };
}

// ═══════════════════════════════════════════════════════════════════════════════
// REPORTS
// ═══════════════════════════════════════════════════════════════════════════════

async function reportSales(ctx, args) {
  const params = {};
  const date_min = optStr(args.date_min, "date_min");
  const date_max = optStr(args.date_max, "date_max");
  const period   = optStr(args.period,   "period");
  if (date_min) params.date_min = date_min;
  if (date_max) params.date_max = date_max;
  if (period)   params.period   = period;
  return wcRequest(ctx, "GET", "/reports/sales", null, params, [200]);
}

async function reportTopSellers(ctx, args) {
  const params = {};
  const date_min = optStr(args.date_min, "date_min");
  const date_max = optStr(args.date_max, "date_max");
  const period   = optStr(args.period,   "period");
  if (date_min) params.date_min = date_min;
  if (date_max) params.date_max = date_max;
  if (period)   params.period   = period;
  return wcRequest(ctx, "GET", "/reports/top_sellers", null, params, [200]);
}

async function reportOrdersTotals(ctx, _args) {
  return wcRequest(ctx, "GET", "/reports/orders/totals", null, null, [200]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════════════════════════════════

async function settingsGet(ctx, args) {
  const group = optStr(args.group, "group");
  const path  = group ? `/settings/${encodeURIComponent(group)}` : "/settings";
  return wcRequest(ctx, "GET", path, null, null, [200]);
}

async function settingsUpdate(ctx, args) {
  const group = requireString(args.group, "group");
  const id    = requireString(args.id,    "id");
  const value = args.value;
  if (value === undefined || value === null)
    throw new Error("value is required for settings_update");
  return wcRequest(ctx, "POST", `/settings/${encodeURIComponent(group)}/${encodeURIComponent(id)}`, { value }, null, [200]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// SYSTEM STATUS
// ═══════════════════════════════════════════════════════════════════════════════

async function systemStatus(ctx, _args) {
  return wcRequest(ctx, "GET", "/system_status", null, null, [200]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// GENERIC REQUEST
// ═══════════════════════════════════════════════════════════════════════════════

async function genericRequest(ctx, args) {
  const method = requireString(args.method, "method").toUpperCase();
  const path   = requireString(args.path,   "path");
  if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(method))
    throw new Error(`Unsupported method: ${method}`);
  const body   = (method !== "GET" && method !== "DELETE" && method !== "HEAD")
    ? (args.body ?? null) : null;
  const params = (method === "GET" || method === "DELETE") ? (args.params ?? null) : null;
  return wcRequest(ctx, method, path, body, params);
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN DISPATCHER
// ═══════════════════════════════════════════════════════════════════════════════

async function woocommerceClient(args) {
  const op  = requireString(args.operation, "operation");
  const ctx = buildCtx(args);

  switch (op) {
    // Products
    case "product_list":       return productList(ctx, args);
    case "product_get":        return productGet(ctx, args);
    case "product_create":     return productCreate(ctx, args);
    case "product_update":     return productUpdate(ctx, args);
    case "product_delete":     return productDelete(ctx, args);
    case "product_count":      return productCount(ctx, args);
    case "product_variations": return productVariations(ctx, args);
    // Orders
    case "order_list":         return orderList(ctx, args);
    case "order_get":          return orderGet(ctx, args);
    case "order_create":       return orderCreate(ctx, args);
    case "order_update":       return orderUpdate(ctx, args);
    case "order_delete":       return orderDelete(ctx, args);
    case "order_count":        return orderCount(ctx, args);
    case "order_notes":        return orderNotes(ctx, args);
    // Customers
    case "customer_list":      return customerList(ctx, args);
    case "customer_get":       return customerGet(ctx, args);
    case "customer_create":    return customerCreate(ctx, args);
    case "customer_update":    return customerUpdate(ctx, args);
    case "customer_delete":    return customerDelete(ctx, args);
    case "customer_count":     return customerCount(ctx, args);
    // Coupons
    case "coupon_list":        return couponList(ctx, args);
    case "coupon_get":         return couponGet(ctx, args);
    case "coupon_create":      return couponCreate(ctx, args);
    case "coupon_update":      return couponUpdate(ctx, args);
    case "coupon_delete":      return couponDelete(ctx, args);
    // Reports
    case "report_sales":          return reportSales(ctx, args);
    case "report_top_sellers":    return reportTopSellers(ctx, args);
    case "report_orders_totals":  return reportOrdersTotals(ctx, args);
    // Settings
    case "settings_get":       return settingsGet(ctx, args);
    case "settings_update":    return settingsUpdate(ctx, args);
    // System
    case "system_status":      return systemStatus(ctx, args);
    // Generic
    case "request":            return genericRequest(ctx, args);
    default:
      throw new Error(
        `Unknown operation: ${op}. Supported: ` +
        `product_list, product_get, product_create, product_update, product_delete, product_count, product_variations, ` +
        `order_list, order_get, order_create, order_update, order_delete, order_count, order_notes, ` +
        `customer_list, customer_get, customer_create, customer_update, customer_delete, customer_count, ` +
        `coupon_list, coupon_get, coupon_create, coupon_update, coupon_delete, ` +
        `report_sales, report_top_sellers, report_orders_totals, ` +
        `settings_get, settings_update, system_status, request`
      );
  }
}

module.exports = { woocommerceClient };
