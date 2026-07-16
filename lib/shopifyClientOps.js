"use strict";
/**
 * shopifyClientOps.js
 * Zero-dependency Shopify Admin REST API client (pure Node.js https; no npm deps).
 *
 * Auth modes:
 *   1. access_token  (OAuth / custom app) — X-Shopify-Access-Token header
 *   2. api_key + api_secret  (private app basic auth, legacy)
 *
 * Base URL: https://{shop}.myshopify.com/admin/api/{api_version}/
 * API version: defaults to "2024-01"
 *
 * Credentials are scrubbed from ALL error messages.
 * Response capped at 16 MB; timeout clamped 1-120 s (default 20 s).
 * NUL-byte guards on every string input.
 */

const https = require("https");

// ── Constants ─────────────────────────────────────────────────────────────────
const DEFAULT_TIMEOUT    = 20_000;
const MIN_TIMEOUT        = 1_000;
const MAX_TIMEOUT        = 120_000;
const MAX_RESPONSE_BODY  = 16 * 1024 * 1024; // 16 MB
const DEFAULT_API_VER    = "2024-01";
const NUL_RE             = /\x00/;

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

function optBool(val, _name) {
  if (val == null) return undefined;
  return !!val;
}

/**
 * Low-level HTTPS request.
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
        const rateLimitRemaining = res.headers["x-shopify-shop-api-call-limit"] || null;
        if (!raw.trim()) { resolve({ status, body: null, rateLimitRemaining }); return; }
        let parsed;
        try { parsed = JSON.parse(raw); } catch (_) { parsed = { _raw: raw }; }
        resolve({ status, body: parsed, rateLimitRemaining });
      });
      res.on("error", (err) => {
        clearTimeout(timer);
        reject(new Error(err.message));
      });
    });

    timer = setTimeout(() => {
      reject(new Error(`Shopify request timed out after ${ms} ms`));
      req.destroy();
    }, ms);

    req.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(err.message));
    });

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/**
 * Build context from args.
 */
function buildCtx(args) {
  const shop       = requireString(args.shop, "shop").replace(/\.myshopify\.com$/, "");
  validateNul(shop, "shop");

  const api_version = optStr(args.api_version, "api_version") || DEFAULT_API_VER;
  const timeout     = clampTimeout(args.timeout);
  const rejectUnauthorized = args.reject_unauthorized !== false;

  let authHeaders;
  if (args.access_token) {
    const token = requireString(args.access_token, "access_token");
    authHeaders = { "X-Shopify-Access-Token": token };
  } else if (args.api_key && args.api_password) {
    const key = requireString(args.api_key, "api_key");
    const pwd = requireString(args.api_password, "api_password");
    const b64 = Buffer.from(`${key}:${pwd}`).toString("base64");
    authHeaders = { "Authorization": `Basic ${b64}` };
  } else {
    throw new Error(
      "Auth required: provide access_token OR api_key + api_password"
    );
  }

  return {
    shop,
    api_version,
    hostname: `${shop}.myshopify.com`,
    apiBase:  `/admin/api/${api_version}`,
    authHeaders,
    timeout,
    rejectUnauthorized,
    // for scrubbing
    _secrets: [args.access_token, args.api_password, args.api_key],
  };
}

/**
 * Core Shopify REST request after auth.
 */
async function shopifyRequest(ctx, method, path, body, params, allowedStatuses) {
  let fullPath = ctx.apiBase + path;

  if ((method === "GET" || method === "DELETE") && params && Object.keys(params).length) {
    const qs = Object.entries(params)
      .filter(([, v]) => v != null)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join("&");
    if (qs) fullPath += "?" + qs;
  }

  const headers = {
    ...ctx.authHeaders,
    "Accept":     "application/json",
    "User-Agent": "mcp-common-server/shopify_client",
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
    throw new Error(`Shopify API error ${res.status}: ${scrubbed}`);
  }

  return res;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRODUCTS
// ═══════════════════════════════════════════════════════════════════════════════

async function productList(ctx, args) {
  const params = {};
  if (args.limit)        params.limit        = optInt(args.limit, "limit", 1, 250);
  if (args.page_info)    params.page_info    = optStr(args.page_info, "page_info");
  if (args.status)       params.status       = optStr(args.status, "status");
  if (args.vendor)       params.vendor       = optStr(args.vendor, "vendor");
  if (args.product_type) params.product_type = optStr(args.product_type, "product_type");
  if (args.fields)       params.fields       = Array.isArray(args.fields) ? args.fields.join(",") : args.fields;
  const res = await shopifyRequest(ctx, "GET", "/products.json", null, params, [200]);
  return res.body;
}

async function productGet(ctx, args) {
  if (args.id == null) throw new Error("id is required and must be a non-empty string");
  const id = requireString(String(args.id), "id");
  const params = {};
  if (args.fields) params.fields = Array.isArray(args.fields) ? args.fields.join(",") : args.fields;
  const res = await shopifyRequest(ctx, "GET", `/products/${encodeURIComponent(id)}.json`, null, params, [200]);
  return res.body;
}

async function productCreate(ctx, args) {
  const product = args.product;
  if (!product || typeof product !== "object" || Array.isArray(product))
    throw new Error("product (object) is required for product_create");
  const res = await shopifyRequest(ctx, "POST", "/products.json", { product }, null, [201]);
  return res.body;
}

async function productUpdate(ctx, args) {
  const id = requireString(String(args.id), "id");
  const product = args.product;
  if (!product || typeof product !== "object" || Array.isArray(product))
    throw new Error("product (object) is required for product_update");
  const res = await shopifyRequest(ctx, "PUT", `/products/${encodeURIComponent(id)}.json`, { product }, null, [200]);
  return res.body;
}

async function productDelete(ctx, args) {
  const id = requireString(String(args.id), "id");
  const res = await shopifyRequest(ctx, "DELETE", `/products/${encodeURIComponent(id)}.json`, null, null, [200]);
  return { deleted: true, id };
}

async function productCount(ctx, args) {
  const params = {};
  if (args.vendor)       params.vendor       = optStr(args.vendor, "vendor");
  if (args.product_type) params.product_type = optStr(args.product_type, "product_type");
  if (args.status)       params.status       = optStr(args.status, "status");
  const res = await shopifyRequest(ctx, "GET", "/products/count.json", null, params, [200]);
  return res.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ORDERS
// ═══════════════════════════════════════════════════════════════════════════════

async function orderList(ctx, args) {
  const params = {};
  if (args.limit)      params.limit      = optInt(args.limit, "limit", 1, 250);
  if (args.page_info)  params.page_info  = optStr(args.page_info, "page_info");
  if (args.status)     params.status     = optStr(args.status, "status");
  if (args.financial_status) params.financial_status = optStr(args.financial_status, "financial_status");
  if (args.fulfillment_status) params.fulfillment_status = optStr(args.fulfillment_status, "fulfillment_status");
  if (args.fields)     params.fields     = Array.isArray(args.fields) ? args.fields.join(",") : args.fields;
  if (args.since_id)   params.since_id   = String(args.since_id);
  const res = await shopifyRequest(ctx, "GET", "/orders.json", null, params, [200]);
  return res.body;
}

async function orderGet(ctx, args) {
  const id = requireString(String(args.id), "id");
  const params = {};
  if (args.fields) params.fields = Array.isArray(args.fields) ? args.fields.join(",") : args.fields;
  const res = await shopifyRequest(ctx, "GET", `/orders/${encodeURIComponent(id)}.json`, null, params, [200]);
  return res.body;
}

async function orderUpdate(ctx, args) {
  const id = requireString(String(args.id), "id");
  const order = args.order;
  if (!order || typeof order !== "object" || Array.isArray(order))
    throw new Error("order (object) is required for order_update");
  const res = await shopifyRequest(ctx, "PUT", `/orders/${encodeURIComponent(id)}.json`, { order }, null, [200]);
  return res.body;
}

async function orderCancel(ctx, args) {
  const id = requireString(String(args.id), "id");
  const body = {};
  if (args.reason)  body.reason  = optStr(args.reason, "reason");
  if (args.email)   body.email   = optBool(args.email, "email");
  if (args.refund)  body.refund  = optBool(args.refund, "refund");
  const res = await shopifyRequest(ctx, "POST", `/orders/${encodeURIComponent(id)}/cancel.json`, body, null, [200]);
  return res.body;
}

async function orderClose(ctx, args) {
  const id = requireString(String(args.id), "id");
  const res = await shopifyRequest(ctx, "POST", `/orders/${encodeURIComponent(id)}/close.json`, {}, null, [200]);
  return res.body;
}

async function orderCount(ctx, args) {
  const params = {};
  if (args.status)           params.status           = optStr(args.status, "status");
  if (args.financial_status) params.financial_status = optStr(args.financial_status, "financial_status");
  if (args.fulfillment_status) params.fulfillment_status = optStr(args.fulfillment_status, "fulfillment_status");
  const res = await shopifyRequest(ctx, "GET", "/orders/count.json", null, params, [200]);
  return res.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CUSTOMERS
// ═══════════════════════════════════════════════════════════════════════════════

async function customerList(ctx, args) {
  const params = {};
  if (args.limit)     params.limit     = optInt(args.limit, "limit", 1, 250);
  if (args.page_info) params.page_info = optStr(args.page_info, "page_info");
  if (args.fields)    params.fields    = Array.isArray(args.fields) ? args.fields.join(",") : args.fields;
  if (args.since_id)  params.since_id  = String(args.since_id);
  const res = await shopifyRequest(ctx, "GET", "/customers.json", null, params, [200]);
  return res.body;
}

async function customerGet(ctx, args) {
  const id = requireString(String(args.id), "id");
  const params = {};
  if (args.fields) params.fields = Array.isArray(args.fields) ? args.fields.join(",") : args.fields;
  const res = await shopifyRequest(ctx, "GET", `/customers/${encodeURIComponent(id)}.json`, null, params, [200]);
  return res.body;
}

async function customerCreate(ctx, args) {
  const customer = args.customer;
  if (!customer || typeof customer !== "object" || Array.isArray(customer))
    throw new Error("customer (object) is required for customer_create");
  const res = await shopifyRequest(ctx, "POST", "/customers.json", { customer }, null, [201]);
  return res.body;
}

async function customerUpdate(ctx, args) {
  const id = requireString(String(args.id), "id");
  const customer = args.customer;
  if (!customer || typeof customer !== "object" || Array.isArray(customer))
    throw new Error("customer (object) is required for customer_update");
  const res = await shopifyRequest(ctx, "PUT", `/customers/${encodeURIComponent(id)}.json`, { customer }, null, [200]);
  return res.body;
}

async function customerSearch(ctx, args) {
  const query = requireString(args.query, "query");
  const params = { query };
  if (args.limit)  params.limit  = optInt(args.limit, "limit", 1, 250);
  if (args.fields) params.fields = Array.isArray(args.fields) ? args.fields.join(",") : args.fields;
  const res = await shopifyRequest(ctx, "GET", "/customers/search.json", null, params, [200]);
  return res.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// INVENTORY
// ═══════════════════════════════════════════════════════════════════════════════

async function inventoryLevelList(ctx, args) {
  const params = {};
  if (args.inventory_item_ids) {
    params.inventory_item_ids = Array.isArray(args.inventory_item_ids)
      ? args.inventory_item_ids.join(",")
      : String(args.inventory_item_ids);
  }
  if (args.location_ids) {
    params.location_ids = Array.isArray(args.location_ids)
      ? args.location_ids.join(",")
      : String(args.location_ids);
  }
  if (args.limit) params.limit = optInt(args.limit, "limit", 1, 250);
  if (!params.inventory_item_ids && !params.location_ids)
    throw new Error("inventory_item_ids or location_ids is required for inventory_level_list");
  const res = await shopifyRequest(ctx, "GET", "/inventory_levels.json", null, params, [200]);
  return res.body;
}

async function inventoryAdjust(ctx, args) {
  if (args.inventory_item_id == null) throw new Error("inventory_item_id is required and must be a non-empty string");
  const inventory_item_id = requireString(String(args.inventory_item_id), "inventory_item_id");
  const location_id       = requireString(String(args.location_id), "location_id");
  const available_adjustment = args.available_adjustment;
  if (available_adjustment == null || !Number.isFinite(Number(available_adjustment)))
    throw new Error("available_adjustment (number) is required for inventory_adjust");
  const body = {
    inventory_item_id: Number(inventory_item_id),
    location_id:       Number(location_id),
    available_adjustment: Number(available_adjustment),
  };
  const res = await shopifyRequest(ctx, "POST", "/inventory_levels/adjust.json", body, null, [200]);
  return res.body;
}

async function inventorySet(ctx, args) {
  const inventory_item_id = requireString(String(args.inventory_item_id), "inventory_item_id");
  const location_id       = requireString(String(args.location_id), "location_id");
  if (args.available == null)
    throw new Error("available (number) is required for inventory_set");
  const body = {
    inventory_item_id: Number(inventory_item_id),
    location_id:       Number(location_id),
    available:         Number(args.available),
  };
  const res = await shopifyRequest(ctx, "POST", "/inventory_levels/set.json", body, null, [200]);
  return res.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// VARIANTS
// ═══════════════════════════════════════════════════════════════════════════════

async function variantGet(ctx, args) {
  const id = requireString(String(args.id), "id");
  const res = await shopifyRequest(ctx, "GET", `/variants/${encodeURIComponent(id)}.json`, null, null, [200]);
  return res.body;
}

async function variantUpdate(ctx, args) {
  const id      = requireString(String(args.id), "id");
  const variant = args.variant;
  if (!variant || typeof variant !== "object" || Array.isArray(variant))
    throw new Error("variant (object) is required for variant_update");
  const res = await shopifyRequest(ctx, "PUT", `/variants/${encodeURIComponent(id)}.json`, { variant }, null, [200]);
  return res.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COLLECTIONS
// ═══════════════════════════════════════════════════════════════════════════════

async function collectionList(ctx, args) {
  const params = {};
  if (args.limit)     params.limit     = optInt(args.limit, "limit", 1, 250);
  if (args.page_info) params.page_info = optStr(args.page_info, "page_info");
  // Shopify has custom_collections and smart_collections
  const type = optStr(args.collection_type, "collection_type") || "custom";
  const endpoint = type === "smart" ? "/smart_collections.json" : "/custom_collections.json";
  const res = await shopifyRequest(ctx, "GET", endpoint, null, params, [200]);
  return res.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHOP & LOCATIONS
// ═══════════════════════════════════════════════════════════════════════════════

async function shopGet(ctx, _args) {
  const res = await shopifyRequest(ctx, "GET", "/shop.json", null, null, [200]);
  return res.body;
}

async function locationList(ctx, _args) {
  const res = await shopifyRequest(ctx, "GET", "/locations.json", null, null, [200]);
  return res.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GENERIC REQUEST
// ═══════════════════════════════════════════════════════════════════════════════

async function genericRequest(ctx, args) {
  const method = requireString(args.method, "method").toUpperCase();
  const path   = requireString(args.path, "path");
  if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(method))
    throw new Error(`Unsupported method: ${method}`);
  const body   = (method !== "GET" && method !== "DELETE" && method !== "HEAD")
    ? (args.body ?? null) : null;
  const params = (method === "GET" || method === "DELETE") ? (args.params ?? null) : null;
  const res = await shopifyRequest(ctx, method, path, body, params);
  return res.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN DISPATCHER
// ═══════════════════════════════════════════════════════════════════════════════

async function shopifyClient(args) {
  const op  = requireString(args.operation, "operation");
  const ctx = buildCtx(args);

  switch (op) {
    // Products
    case "product_list":     return productList(ctx, args);
    case "product_get":      return productGet(ctx, args);
    case "product_create":   return productCreate(ctx, args);
    case "product_update":   return productUpdate(ctx, args);
    case "product_delete":   return productDelete(ctx, args);
    case "product_count":    return productCount(ctx, args);
    // Orders
    case "order_list":       return orderList(ctx, args);
    case "order_get":        return orderGet(ctx, args);
    case "order_update":     return orderUpdate(ctx, args);
    case "order_cancel":     return orderCancel(ctx, args);
    case "order_close":      return orderClose(ctx, args);
    case "order_count":      return orderCount(ctx, args);
    // Customers
    case "customer_list":    return customerList(ctx, args);
    case "customer_get":     return customerGet(ctx, args);
    case "customer_create":  return customerCreate(ctx, args);
    case "customer_update":  return customerUpdate(ctx, args);
    case "customer_search":  return customerSearch(ctx, args);
    // Inventory
    case "inventory_level_list": return inventoryLevelList(ctx, args);
    case "inventory_adjust": return inventoryAdjust(ctx, args);
    case "inventory_set":    return inventorySet(ctx, args);
    // Variants
    case "variant_get":      return variantGet(ctx, args);
    case "variant_update":   return variantUpdate(ctx, args);
    // Collections
    case "collection_list":  return collectionList(ctx, args);
    // Shop & Locations
    case "shop_get":         return shopGet(ctx, args);
    case "location_list":    return locationList(ctx, args);
    // Generic
    case "request":          return genericRequest(ctx, args);
    default:
      throw new Error(
        `Unknown operation: ${op}. Supported: ` +
        `product_list, product_get, product_create, product_update, product_delete, product_count, ` +
        `order_list, order_get, order_update, order_cancel, order_close, order_count, ` +
        `customer_list, customer_get, customer_create, customer_update, customer_search, ` +
        `inventory_level_list, inventory_adjust, inventory_set, ` +
        `variant_get, variant_update, collection_list, ` +
        `shop_get, location_list, request`
      );
  }
}

module.exports = { shopifyClient };
