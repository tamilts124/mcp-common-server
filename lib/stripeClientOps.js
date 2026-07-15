"use strict";
/**
 * stripeClientOps.js
 * Zero-dependency Stripe REST API v1 client (pure Node.js https built-ins; no npm deps).
 * Auth: secret_key (Bearer) — sk_live_* or sk_test_* or restricted rk_*
 * Base URL: https://api.stripe.com/v1
 * All credentials are scrubbed from error messages.
 * Response capped at 16 MB; timeout clamped 1–120 s (default 20 s).
 */

const https = require("https");

// ── Constants ────────────────────────────────────────────────────────────────
const DEFAULT_TIMEOUT   = 20_000;
const MIN_TIMEOUT       = 1_000;
const MAX_TIMEOUT       = 120_000;
const MAX_RESPONSE_BODY = 16 * 1024 * 1024; // 16 MB
const API_HOSTNAME      = "api.stripe.com";
const NUL_RE            = /\x00/;

// ── Helpers ──────────────────────────────────────────────────────────────────
function scrubCreds(str, secretKey) {
  let s = String(str);
  if (secretKey) s = s.split(secretKey).join("[secret_key]");
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

/**
 * Flatten a nested JS object into Stripe's bracket-notation form-encoded format.
 * e.g. { metadata: { key: "val" } } → "metadata[key]=val"
 * Also handles arrays: { expand: ["a", "b"] } → "expand[]=a&expand[]=b"
 */
function flattenParams(obj, prefix = "") {
  const pairs = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object" && !Array.isArray(v)) {
      pairs.push(...flattenParams(v, key));
    } else if (Array.isArray(v)) {
      for (const item of v) {
        if (item == null) continue;
        if (typeof item === "object") {
          pairs.push(...flattenParams(item, `${key}[]`));
        } else {
          pairs.push([`${key}[]`, String(item)]);
        }
      }
    } else {
      pairs.push([key, String(v)]);
    }
  }
  return pairs;
}

function encodeParams(obj) {
  if (!obj || Object.keys(obj).length === 0) return "";
  return flattenParams(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}

/**
 * Low-level HTTPS request to Stripe REST API.
 * Stripe uses HTTP Basic auth (key as username, empty password)
 * and form-encoded bodies for POST/PUT/PATCH.
 */
function stripeRequest({
  secretKey, method, path, params, timeout, rejectUnauthorized,
  stripeAccount, idempotencyKey,
}) {
  return new Promise((resolve, reject) => {
    const ms = clampTimeout(timeout);
    const basicAuth = Buffer.from(`${secretKey}:`).toString("base64");

    let bodyStr = null;
    let fullPath = path;

    if ((method === "GET" || method === "DELETE") && params && Object.keys(params).length) {
      const qs = encodeParams(params);
      if (qs) fullPath = `${path}?${qs}`;
    } else if (params && Object.keys(params).length) {
      bodyStr = encodeParams(params);
    }

    const headers = {
      Authorization:  `Basic ${basicAuth}`,
      Accept:         "application/json",
      "Stripe-Version": "2023-10-16",
      "User-Agent":   "mcp-common-server/stripe_client",
    };
    if (bodyStr) {
      headers["Content-Type"]   = "application/x-www-form-urlencoded";
      headers["Content-Length"] = Buffer.byteLength(bodyStr);
    }
    if (stripeAccount) headers["Stripe-Account"] = stripeAccount;
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

    const options = {
      hostname:           API_HOSTNAME,
      port:               443,
      path:               fullPath,
      method:             method || "GET",
      headers,
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
        if (!raw.trim()) { resolve({ status, body: null }); return; }
        let parsed;
        try { parsed = JSON.parse(raw); } catch (_) { parsed = { _raw: raw }; }
        resolve({ status, body: parsed });
      });
      res.on("error", (err) => {
        clearTimeout(timer);
        reject(new Error(scrubCreds(err.message, secretKey)));
      });
    });

    timer = setTimeout(() => {
      reject(new Error(`Stripe request timed out after ${ms} ms`));
      req.destroy();
    }, ms);

    req.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(scrubCreds(err.message, secretKey)));
    });

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function strReq(ctx, method, path, params, allowedStatuses) {
  const res = await stripeRequest({
    secretKey:          ctx.secretKey,
    method, path, params,
    timeout:            ctx.timeout,
    rejectUnauthorized: ctx.rejectUnauthorized,
    stripeAccount:      ctx.stripeAccount,
    idempotencyKey:     ctx.idempotencyKey,
  });
  const ok = allowedStatuses
    ? allowedStatuses.includes(res.status)
    : res.status >= 200 && res.status < 300;
  if (!ok) {
    const errBody = res.body
      ? (res.body.error ? JSON.stringify(res.body.error) : JSON.stringify(res.body))
      : "(empty)";
    const scrubbed = scrubCreds(errBody, ctx.secretKey);
    throw new Error(`Stripe API error ${res.status}: ${scrubbed}`);
  }
  return res;
}

function buildCtx(args) {
  const secretKey = requireString(args.secret_key, "secret_key");
  // Validate key format
  if (!/^(sk_|rk_)/.test(secretKey))
    throw new Error("secret_key must start with 'sk_' (secret key) or 'rk_' (restricted key)");
  return {
    secretKey,
    timeout:            args.timeout,
    rejectUnauthorized: args.reject_unauthorized,
    stripeAccount:      optStr(args.stripe_account, "stripe_account"),
    idempotencyKey:     optStr(args.idempotency_key, "idempotency_key"),
  };
}

function buildList(params = {}) {
  // Common list parameters
  const p = {};
  if (params.limit       != null) p.limit        = Math.min(100, Math.max(1, Number(params.limit)));
  if (params.starting_after)      p.starting_after = params.starting_after;
  if (params.ending_before)       p.ending_before  = params.ending_before;
  if (params.created)             p.created        = params.created;
  if (params.customer)            p.customer       = params.customer;
  if (params.expand)              p.expand         = params.expand;
  return p;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CUSTOMERS
// ═══════════════════════════════════════════════════════════════════════════════

async function customerCreate(ctx, args) {
  const params = {};
  if (args.email)        params.email        = requireString(args.email, "email");
  if (args.name)         params.name         = args.name;
  if (args.phone)        params.phone        = args.phone;
  if (args.description)  params.description  = args.description;
  if (args.metadata)     params.metadata     = args.metadata;
  if (args.address)      params.address      = args.address;
  if (args.payment_method) params.payment_method = args.payment_method;
  if (args.source)       params.source       = args.source;
  const res = await strReq(ctx, "POST", "/v1/customers", params, [200]);
  return res.body;
}

async function customerGet(ctx, args) {
  const id = requireString(args.customer_id, "customer_id");
  const params = {};
  if (args.expand) params.expand = args.expand;
  const res = await strReq(ctx, "GET", `/v1/customers/${id}`, Object.keys(params).length ? params : null, [200, 404]);
  if (res.status === 404 || res.body?.deleted) return { exists: false, customer_id: id };
  return res.body;
}

async function customerUpdate(ctx, args) {
  const id = requireString(args.customer_id, "customer_id");
  const params = {};
  if (args.email)        params.email        = args.email;
  if (args.name)         params.name         = args.name;
  if (args.phone)        params.phone        = args.phone;
  if (args.description)  params.description  = args.description;
  if (args.metadata)     params.metadata     = args.metadata;
  if (args.address)      params.address      = args.address;
  if (args.payment_method) params.payment_method = args.payment_method;
  if (!Object.keys(params).length) throw new Error("At least one field to update is required");
  const res = await strReq(ctx, "POST", `/v1/customers/${id}`, params);
  return res.body;
}

async function customerDelete(ctx, args) {
  const id = requireString(args.customer_id, "customer_id");
  const res = await strReq(ctx, "DELETE", `/v1/customers/${id}`, null, [200, 404]);
  if (res.status === 404) return { deleted: false, customer_id: id };
  return { deleted: res.body?.deleted === true, customer_id: id };
}

async function customerList(ctx, args) {
  const params = buildList(args);
  if (args.email) params.email = args.email;
  const res = await strReq(ctx, "GET", "/v1/customers", params);
  return res.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PAYMENT INTENTS
// ═══════════════════════════════════════════════════════════════════════════════

async function paymentIntentCreate(ctx, args) {
  const amount   = optInt(args.amount, "amount", 1);
  if (!amount) throw new Error("amount is required (in smallest currency unit, e.g. cents)");
  const currency = requireString(args.currency, "currency");
  const params   = { amount, currency: currency.toLowerCase() };
  if (args.customer)            params.customer             = args.customer;
  if (args.description)         params.description          = args.description;
  if (args.metadata)            params.metadata             = args.metadata;
  if (args.payment_method)      params.payment_method       = args.payment_method;
  if (args.payment_method_types) params.payment_method_types = args.payment_method_types;
  if (args.confirm != null)     params.confirm              = args.confirm;
  if (args.capture_method)      params.capture_method       = args.capture_method;
  if (args.setup_future_usage)  params.setup_future_usage   = args.setup_future_usage;
  if (args.return_url)          params.return_url           = args.return_url;
  if (args.statement_descriptor) params.statement_descriptor = args.statement_descriptor;
  if (args.receipt_email)        params.receipt_email        = args.receipt_email;
  const res = await strReq(ctx, "POST", "/v1/payment_intents", params, [200]);
  return res.body;
}

async function paymentIntentGet(ctx, args) {
  const id = requireString(args.payment_intent_id, "payment_intent_id");
  const params = {};
  if (args.expand) params.expand = args.expand;
  const res = await strReq(ctx, "GET", `/v1/payment_intents/${id}`,
    Object.keys(params).length ? params : null, [200, 404]);
  if (res.status === 404) return { exists: false, payment_intent_id: id };
  return res.body;
}

async function paymentIntentUpdate(ctx, args) {
  const id = requireString(args.payment_intent_id, "payment_intent_id");
  const params = {};
  if (args.amount)       params.amount       = args.amount;
  if (args.currency)     params.currency     = args.currency;
  if (args.description)  params.description  = args.description;
  if (args.metadata)     params.metadata     = args.metadata;
  if (args.receipt_email) params.receipt_email = args.receipt_email;
  if (args.payment_method) params.payment_method = args.payment_method;
  if (!Object.keys(params).length) throw new Error("At least one field to update is required");
  const res = await strReq(ctx, "POST", `/v1/payment_intents/${id}`, params);
  return res.body;
}

async function paymentIntentConfirm(ctx, args) {
  const id = requireString(args.payment_intent_id, "payment_intent_id");
  const params = {};
  if (args.payment_method) params.payment_method = args.payment_method;
  if (args.return_url)     params.return_url     = args.return_url;
  const res = await strReq(ctx, "POST", `/v1/payment_intents/${id}/confirm`,
    Object.keys(params).length ? params : null, [200]);
  return res.body;
}

async function paymentIntentCapture(ctx, args) {
  const id = requireString(args.payment_intent_id, "payment_intent_id");
  const params = {};
  if (args.amount_to_capture) params.amount_to_capture = args.amount_to_capture;
  const res = await strReq(ctx, "POST", `/v1/payment_intents/${id}/capture`,
    Object.keys(params).length ? params : null, [200]);
  return res.body;
}

async function paymentIntentCancel(ctx, args) {
  const id = requireString(args.payment_intent_id, "payment_intent_id");
  const params = {};
  if (args.cancellation_reason) params.cancellation_reason = args.cancellation_reason;
  const res = await strReq(ctx, "POST", `/v1/payment_intents/${id}/cancel`,
    Object.keys(params).length ? params : null, [200]);
  return res.body;
}

async function paymentIntentList(ctx, args) {
  const params = buildList(args);
  const res = await strReq(ctx, "GET", "/v1/payment_intents", params);
  return res.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PAYMENT METHODS
// ═══════════════════════════════════════════════════════════════════════════════

async function paymentMethodCreate(ctx, args) {
  const type = requireString(args.type, "type");
  const params = { type };
  if (args.card)          params.card          = args.card;
  if (args.billing_details) params.billing_details = args.billing_details;
  if (args.metadata)      params.metadata      = args.metadata;
  const res = await strReq(ctx, "POST", "/v1/payment_methods", params, [200]);
  return res.body;
}

async function paymentMethodGet(ctx, args) {
  const id = requireString(args.payment_method_id, "payment_method_id");
  const res = await strReq(ctx, "GET", `/v1/payment_methods/${id}`, null, [200, 404]);
  if (res.status === 404) return { exists: false, payment_method_id: id };
  return res.body;
}

async function paymentMethodAttach(ctx, args) {
  const id       = requireString(args.payment_method_id, "payment_method_id");
  const customer = requireString(args.customer_id,       "customer_id");
  const res = await strReq(ctx, "POST", `/v1/payment_methods/${id}/attach`,
    { customer }, [200]);
  return res.body;
}

async function paymentMethodDetach(ctx, args) {
  const id = requireString(args.payment_method_id, "payment_method_id");
  const res = await strReq(ctx, "POST", `/v1/payment_methods/${id}/detach`, null, [200]);
  return res.body;
}

async function paymentMethodList(ctx, args) {
  const customer = requireString(args.customer_id, "customer_id");
  const params = { customer };
  if (args.type)  params.type  = args.type;
  if (args.limit) params.limit = Math.min(100, Math.max(1, Number(args.limit)));
  const res = await strReq(ctx, "GET", "/v1/payment_methods", params);
  return res.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHARGES
// ═══════════════════════════════════════════════════════════════════════════════

async function chargeCreate(ctx, args) {
  const amount   = optInt(args.amount, "amount", 1);
  if (!amount) throw new Error("amount is required");
  const currency = requireString(args.currency, "currency");
  const params   = { amount, currency: currency.toLowerCase() };
  if (args.customer)    params.customer     = args.customer;
  if (args.source)      params.source       = args.source;
  if (args.description) params.description  = args.description;
  if (args.metadata)    params.metadata     = args.metadata;
  if (args.receipt_email) params.receipt_email = args.receipt_email;
  if (args.capture != null) params.capture  = args.capture;
  const res = await strReq(ctx, "POST", "/v1/charges", params, [200]);
  return res.body;
}

async function chargeGet(ctx, args) {
  const id = requireString(args.charge_id, "charge_id");
  const res = await strReq(ctx, "GET", `/v1/charges/${id}`, null, [200, 404]);
  if (res.status === 404) return { exists: false, charge_id: id };
  return res.body;
}

async function chargeCapture(ctx, args) {
  const id = requireString(args.charge_id, "charge_id");
  const params = {};
  if (args.amount) params.amount = args.amount;
  const res = await strReq(ctx, "POST", `/v1/charges/${id}/capture`,
    Object.keys(params).length ? params : null, [200]);
  return res.body;
}

async function chargeList(ctx, args) {
  const params = buildList(args);
  const res = await strReq(ctx, "GET", "/v1/charges", params);
  return res.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// REFUNDS
// ═══════════════════════════════════════════════════════════════════════════════

async function refundCreate(ctx, args) {
  const params = {};
  if (args.charge)          params.charge          = args.charge;
  if (args.payment_intent)  params.payment_intent  = args.payment_intent;
  if (!params.charge && !params.payment_intent)
    throw new Error("charge or payment_intent is required");
  if (args.amount)          params.amount          = args.amount;
  if (args.reason)          params.reason          = args.reason;
  if (args.metadata)        params.metadata        = args.metadata;
  const res = await strReq(ctx, "POST", "/v1/refunds", params, [200]);
  return res.body;
}

async function refundGet(ctx, args) {
  const id = requireString(args.refund_id, "refund_id");
  const res = await strReq(ctx, "GET", `/v1/refunds/${id}`, null, [200, 404]);
  if (res.status === 404) return { exists: false, refund_id: id };
  return res.body;
}

async function refundList(ctx, args) {
  const params = buildList(args);
  if (args.charge)         params.charge         = args.charge;
  if (args.payment_intent) params.payment_intent = args.payment_intent;
  const res = await strReq(ctx, "GET", "/v1/refunds", params);
  return res.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUBSCRIPTIONS
// ═══════════════════════════════════════════════════════════════════════════════

async function subscriptionCreate(ctx, args) {
  const customer = requireString(args.customer_id, "customer_id");
  const items    = args.items;
  if (!Array.isArray(items) || !items.length)
    throw new Error("items (array of {price, quantity?}) is required");
  const params = { customer, items };
  if (args.trial_period_days) params.trial_period_days = args.trial_period_days;
  if (args.payment_behavior)  params.payment_behavior  = args.payment_behavior;
  if (args.proration_behavior) params.proration_behavior = args.proration_behavior;
  if (args.default_payment_method) params.default_payment_method = args.default_payment_method;
  if (args.metadata)          params.metadata          = args.metadata;
  if (args.cancel_at_period_end != null) params.cancel_at_period_end = args.cancel_at_period_end;
  if (args.collection_method)  params.collection_method = args.collection_method;
  if (args.coupon)             params.coupon            = args.coupon;
  const res = await strReq(ctx, "POST", "/v1/subscriptions", params, [200]);
  return res.body;
}

async function subscriptionGet(ctx, args) {
  const id = requireString(args.subscription_id, "subscription_id");
  const params = {};
  if (args.expand) params.expand = args.expand;
  const res = await strReq(ctx, "GET", `/v1/subscriptions/${id}`,
    Object.keys(params).length ? params : null, [200, 404]);
  if (res.status === 404) return { exists: false, subscription_id: id };
  return res.body;
}

async function subscriptionUpdate(ctx, args) {
  const id = requireString(args.subscription_id, "subscription_id");
  const params = {};
  if (args.items)               params.items               = args.items;
  if (args.metadata)            params.metadata            = args.metadata;
  if (args.coupon)              params.coupon              = args.coupon;
  if (args.cancel_at_period_end != null) params.cancel_at_period_end = args.cancel_at_period_end;
  if (args.default_payment_method) params.default_payment_method = args.default_payment_method;
  if (args.proration_behavior)  params.proration_behavior  = args.proration_behavior;
  if (args.trial_end)           params.trial_end           = args.trial_end;
  if (!Object.keys(params).length) throw new Error("At least one field to update is required");
  const res = await strReq(ctx, "POST", `/v1/subscriptions/${id}`, params);
  return res.body;
}

async function subscriptionCancel(ctx, args) {
  const id = requireString(args.subscription_id, "subscription_id");
  const params = {};
  if (args.invoice_now != null)  params.invoice_now  = args.invoice_now;
  if (args.prorate != null)      params.prorate      = args.prorate;
  const res = await strReq(ctx, "DELETE", `/v1/subscriptions/${id}`,
    Object.keys(params).length ? params : null, [200, 404]);
  if (res.status === 404) return { canceled: false, subscription_id: id };
  return res.body;
}

async function subscriptionList(ctx, args) {
  const params = buildList(args);
  if (args.status)   params.status   = args.status;
  if (args.price)    params.price    = args.price;
  const res = await strReq(ctx, "GET", "/v1/subscriptions", params);
  return res.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// INVOICES
// ═══════════════════════════════════════════════════════════════════════════════

async function invoiceCreate(ctx, args) {
  const customer = requireString(args.customer_id, "customer_id");
  const params = { customer };
  if (args.description)        params.description        = args.description;
  if (args.metadata)           params.metadata           = args.metadata;
  if (args.collection_method)  params.collection_method  = args.collection_method;
  if (args.days_until_due)     params.days_until_due     = args.days_until_due;
  if (args.auto_advance != null) params.auto_advance     = args.auto_advance;
  const res = await strReq(ctx, "POST", "/v1/invoices", params, [200]);
  return res.body;
}

async function invoiceGet(ctx, args) {
  const id = requireString(args.invoice_id, "invoice_id");
  const params = {};
  if (args.expand) params.expand = args.expand;
  const res = await strReq(ctx, "GET", `/v1/invoices/${id}`,
    Object.keys(params).length ? params : null, [200, 404]);
  if (res.status === 404) return { exists: false, invoice_id: id };
  return res.body;
}

async function invoiceFinalizeInvoice(ctx, args) {
  const id = requireString(args.invoice_id, "invoice_id");
  const res = await strReq(ctx, "POST", `/v1/invoices/${id}/finalize`, null, [200]);
  return res.body;
}

async function invoicePay(ctx, args) {
  const id = requireString(args.invoice_id, "invoice_id");
  const params = {};
  if (args.payment_method) params.payment_method = args.payment_method;
  const res = await strReq(ctx, "POST", `/v1/invoices/${id}/pay`,
    Object.keys(params).length ? params : null, [200]);
  return res.body;
}

async function invoiceVoid(ctx, args) {
  const id = requireString(args.invoice_id, "invoice_id");
  const res = await strReq(ctx, "POST", `/v1/invoices/${id}/void`, null, [200]);
  return res.body;
}

async function invoiceList(ctx, args) {
  const params = buildList(args);
  if (args.status)       params.status       = args.status;
  if (args.subscription) params.subscription = args.subscription;
  const res = await strReq(ctx, "GET", "/v1/invoices", params);
  return res.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PRICES & PRODUCTS
// ═══════════════════════════════════════════════════════════════════════════════

async function productCreate(ctx, args) {
  const name = requireString(args.name, "name");
  const params = { name };
  if (args.description)   params.description   = args.description;
  if (args.active != null) params.active        = args.active;
  if (args.metadata)      params.metadata      = args.metadata;
  if (args.images)        params.images        = args.images;
  const res = await strReq(ctx, "POST", "/v1/products", params, [200]);
  return res.body;
}

async function productGet(ctx, args) {
  const id = requireString(args.product_id, "product_id");
  const res = await strReq(ctx, "GET", `/v1/products/${id}`, null, [200, 404]);
  if (res.status === 404) return { exists: false, product_id: id };
  return res.body;
}

async function productUpdate(ctx, args) {
  const id = requireString(args.product_id, "product_id");
  const params = {};
  if (args.name)        params.name        = args.name;
  if (args.description) params.description = args.description;
  if (args.active != null) params.active   = args.active;
  if (args.metadata)    params.metadata    = args.metadata;
  if (!Object.keys(params).length) throw new Error("At least one field to update is required");
  const res = await strReq(ctx, "POST", `/v1/products/${id}`, params);
  return res.body;
}

async function productDelete(ctx, args) {
  const id = requireString(args.product_id, "product_id");
  const res = await strReq(ctx, "DELETE", `/v1/products/${id}`, null, [200, 404]);
  if (res.status === 404) return { deleted: false, product_id: id };
  return { deleted: res.body?.deleted === true, product_id: id };
}

async function productList(ctx, args) {
  const params = buildList(args);
  if (args.active != null) params.active = args.active;
  const res = await strReq(ctx, "GET", "/v1/products", params);
  return res.body;
}

async function priceCreate(ctx, args) {
  const currency    = requireString(args.currency, "currency");
  const unitAmount  = optInt(args.unit_amount, "unit_amount", 0);
  const params = { currency: currency.toLowerCase() };
  if (unitAmount != null) params.unit_amount = unitAmount;
  if (args.product)      params.product      = requireString(args.product, "product");
  if (args.recurring)    params.recurring    = args.recurring;
  if (args.nickname)     params.nickname     = args.nickname;
  if (args.metadata)     params.metadata     = args.metadata;
  if (args.active != null) params.active     = args.active;
  if (args.billing_scheme) params.billing_scheme = args.billing_scheme;
  if (args.tiers)        params.tiers        = args.tiers;
  if (args.tiers_mode)   params.tiers_mode   = args.tiers_mode;
  const res = await strReq(ctx, "POST", "/v1/prices", params, [200]);
  return res.body;
}

async function priceGet(ctx, args) {
  const id = requireString(args.price_id, "price_id");
  const res = await strReq(ctx, "GET", `/v1/prices/${id}`, null, [200, 404]);
  if (res.status === 404) return { exists: false, price_id: id };
  return res.body;
}

async function priceList(ctx, args) {
  const params = buildList(args);
  if (args.product)      params.product      = args.product;
  if (args.currency)     params.currency     = args.currency;
  if (args.active != null) params.active     = args.active;
  const res = await strReq(ctx, "GET", "/v1/prices", params);
  return res.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COUPONS & PROMOTION CODES
// ═══════════════════════════════════════════════════════════════════════════════

async function couponCreate(ctx, args) {
  const params = {};
  if (args.id)                  params.id                  = args.id;
  if (args.percent_off != null) params.percent_off         = args.percent_off;
  if (args.amount_off != null)  params.amount_off          = args.amount_off;
  if (args.currency)            params.currency            = args.currency;
  if (!params.percent_off && !params.amount_off)
    throw new Error("percent_off or amount_off is required");
  if (args.duration)            params.duration            = requireString(args.duration, "duration");
  if (args.duration_in_months)  params.duration_in_months  = args.duration_in_months;
  if (args.max_redemptions)     params.max_redemptions     = args.max_redemptions;
  if (args.redeem_by)           params.redeem_by           = args.redeem_by;
  if (args.name)                params.name                = args.name;
  if (args.metadata)            params.metadata            = args.metadata;
  const res = await strReq(ctx, "POST", "/v1/coupons", params, [200]);
  return res.body;
}

async function couponGet(ctx, args) {
  const id = requireString(args.coupon_id, "coupon_id");
  const res = await strReq(ctx, "GET", `/v1/coupons/${id}`, null, [200, 404]);
  if (res.status === 404) return { exists: false, coupon_id: id };
  return res.body;
}

async function couponDelete(ctx, args) {
  const id = requireString(args.coupon_id, "coupon_id");
  const res = await strReq(ctx, "DELETE", `/v1/coupons/${id}`, null, [200, 404]);
  if (res.status === 404) return { deleted: false, coupon_id: id };
  return { deleted: res.body?.deleted === true, coupon_id: id };
}

async function couponList(ctx, args) {
  const params = buildList(args);
  const res = await strReq(ctx, "GET", "/v1/coupons", params);
  return res.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHECKOUT SESSIONS
// ═══════════════════════════════════════════════════════════════════════════════

async function checkoutSessionCreate(ctx, args) {
  const mode        = requireString(args.mode, "mode");
  const successUrl  = requireString(args.success_url, "success_url");
  const params = { mode, success_url: successUrl };
  if (args.cancel_url)   params.cancel_url   = args.cancel_url;
  if (args.customer)     params.customer     = args.customer;
  if (args.customer_email) params.customer_email = args.customer_email;
  if (args.line_items)   params.line_items   = args.line_items;
  if (args.metadata)     params.metadata     = args.metadata;
  if (args.payment_method_types) params.payment_method_types = args.payment_method_types;
  if (args.subscription_data) params.subscription_data = args.subscription_data;
  if (args.allow_promotion_codes != null) params.allow_promotion_codes = args.allow_promotion_codes;
  const res = await strReq(ctx, "POST", "/v1/checkout/sessions", params, [200]);
  return res.body;
}

async function checkoutSessionGet(ctx, args) {
  const id = requireString(args.session_id, "session_id");
  const res = await strReq(ctx, "GET", `/v1/checkout/sessions/${id}`, null, [200, 404]);
  if (res.status === 404) return { exists: false, session_id: id };
  return res.body;
}

async function checkoutSessionList(ctx, args) {
  const params = buildList(args);
  if (args.payment_intent) params.payment_intent = args.payment_intent;
  if (args.subscription)   params.subscription   = args.subscription;
  const res = await strReq(ctx, "GET", "/v1/checkout/sessions", params);
  return res.body;
}

async function checkoutSessionExpire(ctx, args) {
  const id = requireString(args.session_id, "session_id");
  const res = await strReq(ctx, "POST", `/v1/checkout/sessions/${id}/expire`, null, [200]);
  return res.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// WEBHOOKS (Endpoint management only — no signature verification to avoid raw body needs)
// ═══════════════════════════════════════════════════════════════════════════════

async function webhookEndpointCreate(ctx, args) {
  const url             = requireString(args.url, "url");
  const enabledEvents   = args.enabled_events;
  if (!Array.isArray(enabledEvents) || !enabledEvents.length)
    throw new Error("enabled_events (array of event type strings, or ['*']) is required");
  const params = { url, enabled_events: enabledEvents };
  if (args.description) params.description = args.description;
  if (args.metadata)    params.metadata    = args.metadata;
  const res = await strReq(ctx, "POST", "/v1/webhook_endpoints", params, [200]);
  return res.body;
}

async function webhookEndpointGet(ctx, args) {
  const id = requireString(args.webhook_endpoint_id, "webhook_endpoint_id");
  const res = await strReq(ctx, "GET", `/v1/webhook_endpoints/${id}`, null, [200, 404]);
  if (res.status === 404) return { exists: false, webhook_endpoint_id: id };
  return res.body;
}

async function webhookEndpointUpdate(ctx, args) {
  const id = requireString(args.webhook_endpoint_id, "webhook_endpoint_id");
  const params = {};
  if (args.url)            params.url            = args.url;
  if (args.enabled_events) params.enabled_events = args.enabled_events;
  if (args.description)    params.description    = args.description;
  if (args.disabled != null) params.disabled     = args.disabled;
  if (!Object.keys(params).length) throw new Error("At least one field to update is required");
  const res = await strReq(ctx, "POST", `/v1/webhook_endpoints/${id}`, params);
  return res.body;
}

async function webhookEndpointDelete(ctx, args) {
  const id = requireString(args.webhook_endpoint_id, "webhook_endpoint_id");
  const res = await strReq(ctx, "DELETE", `/v1/webhook_endpoints/${id}`, null, [200, 404]);
  if (res.status === 404) return { deleted: false, webhook_endpoint_id: id };
  return { deleted: res.body?.deleted === true, webhook_endpoint_id: id };
}

async function webhookEndpointList(ctx, args) {
  const params = buildList(args);
  const res = await strReq(ctx, "GET", "/v1/webhook_endpoints", params);
  return res.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BALANCE & PAYOUTS
// ═══════════════════════════════════════════════════════════════════════════════

async function balanceGet(ctx, _args) {
  const res = await strReq(ctx, "GET", "/v1/balance", null, [200]);
  return res.body;
}

async function balanceTransactionList(ctx, args) {
  const params = buildList(args);
  if (args.type)   params.type   = args.type;
  if (args.source) params.source = args.source;
  const res = await strReq(ctx, "GET", "/v1/balance_transactions", params);
  return res.body;
}

async function payoutCreate(ctx, args) {
  const amount   = optInt(args.amount, "amount", 1);
  if (!amount) throw new Error("amount is required");
  const currency = requireString(args.currency, "currency");
  const params = { amount, currency: currency.toLowerCase() };
  if (args.description)   params.description   = args.description;
  if (args.metadata)      params.metadata      = args.metadata;
  if (args.method)        params.method        = args.method;
  if (args.statement_descriptor) params.statement_descriptor = args.statement_descriptor;
  const res = await strReq(ctx, "POST", "/v1/payouts", params, [200]);
  return res.body;
}

async function payoutGet(ctx, args) {
  const id = requireString(args.payout_id, "payout_id");
  const res = await strReq(ctx, "GET", `/v1/payouts/${id}`, null, [200, 404]);
  if (res.status === 404) return { exists: false, payout_id: id };
  return res.body;
}

async function payoutList(ctx, args) {
  const params = buildList(args);
  if (args.status) params.status = args.status;
  const res = await strReq(ctx, "GET", "/v1/payouts", params);
  return res.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// DISPUTES
// ═══════════════════════════════════════════════════════════════════════════════

async function disputeGet(ctx, args) {
  const id = requireString(args.dispute_id, "dispute_id");
  const res = await strReq(ctx, "GET", `/v1/disputes/${id}`, null, [200, 404]);
  if (res.status === 404) return { exists: false, dispute_id: id };
  return res.body;
}

async function disputeList(ctx, args) {
  const params = buildList(args);
  if (args.charge)         params.charge         = args.charge;
  if (args.payment_intent) params.payment_intent = args.payment_intent;
  const res = await strReq(ctx, "GET", "/v1/disputes", params);
  return res.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GENERIC / ACCOUNT / INFO
// ═══════════════════════════════════════════════════════════════════════════════

async function accountInfo(ctx, _args) {
  const res = await strReq(ctx, "GET", "/v1/account", null, [200]);
  return res.body;
}

async function genericRequest(ctx, args) {
  const method = requireString(args.method, "method").toUpperCase();
  const path   = requireString(args.path,   "path");
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method))
    throw new Error(`Unsupported method: ${method}`);
  const params = args.params || {};
  const isReadMethod = method === "GET" || method === "DELETE";
  const res = await strReq(ctx, method, path, Object.keys(params).length ? params : null);
  return res.body;
}

async function infoGet(ctx, _args) {
  const account = await accountInfo(ctx, {});
  return {
    account_id:     account.id,
    business_name:  account.business_profile?.name ?? account.settings?.dashboard?.display_name,
    email:          account.email,
    country:        account.country,
    default_currency: account.default_currency,
    charges_enabled: account.charges_enabled,
    payouts_enabled: account.payouts_enabled,
    type:           account.type,
    api_version:    "2023-10-16",
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN DISPATCHER
// ═══════════════════════════════════════════════════════════════════════════════

async function stripeClient(args) {
  const op = requireString(args.operation, "operation");
  const ctx = buildCtx(args);

  switch (op) {
    // Customers
    case "customer_create": return customerCreate(ctx, args);
    case "customer_get":    return customerGet(ctx, args);
    case "customer_update": return customerUpdate(ctx, args);
    case "customer_delete": return customerDelete(ctx, args);
    case "customer_list":   return customerList(ctx, args);
    // Payment Intents
    case "payment_intent_create":  return paymentIntentCreate(ctx, args);
    case "payment_intent_get":     return paymentIntentGet(ctx, args);
    case "payment_intent_update":  return paymentIntentUpdate(ctx, args);
    case "payment_intent_confirm": return paymentIntentConfirm(ctx, args);
    case "payment_intent_capture": return paymentIntentCapture(ctx, args);
    case "payment_intent_cancel":  return paymentIntentCancel(ctx, args);
    case "payment_intent_list":    return paymentIntentList(ctx, args);
    // Payment Methods
    case "payment_method_create": return paymentMethodCreate(ctx, args);
    case "payment_method_get":    return paymentMethodGet(ctx, args);
    case "payment_method_attach": return paymentMethodAttach(ctx, args);
    case "payment_method_detach": return paymentMethodDetach(ctx, args);
    case "payment_method_list":   return paymentMethodList(ctx, args);
    // Charges
    case "charge_create":  return chargeCreate(ctx, args);
    case "charge_get":     return chargeGet(ctx, args);
    case "charge_capture": return chargeCapture(ctx, args);
    case "charge_list":    return chargeList(ctx, args);
    // Refunds
    case "refund_create": return refundCreate(ctx, args);
    case "refund_get":    return refundGet(ctx, args);
    case "refund_list":   return refundList(ctx, args);
    // Subscriptions
    case "subscription_create": return subscriptionCreate(ctx, args);
    case "subscription_get":    return subscriptionGet(ctx, args);
    case "subscription_update": return subscriptionUpdate(ctx, args);
    case "subscription_cancel": return subscriptionCancel(ctx, args);
    case "subscription_list":   return subscriptionList(ctx, args);
    // Invoices
    case "invoice_create":   return invoiceCreate(ctx, args);
    case "invoice_get":      return invoiceGet(ctx, args);
    case "invoice_finalize": return invoiceFinalizeInvoice(ctx, args);
    case "invoice_pay":      return invoicePay(ctx, args);
    case "invoice_void":     return invoiceVoid(ctx, args);
    case "invoice_list":     return invoiceList(ctx, args);
    // Products
    case "product_create": return productCreate(ctx, args);
    case "product_get":    return productGet(ctx, args);
    case "product_update": return productUpdate(ctx, args);
    case "product_delete": return productDelete(ctx, args);
    case "product_list":   return productList(ctx, args);
    // Prices
    case "price_create": return priceCreate(ctx, args);
    case "price_get":    return priceGet(ctx, args);
    case "price_list":   return priceList(ctx, args);
    // Coupons
    case "coupon_create": return couponCreate(ctx, args);
    case "coupon_get":    return couponGet(ctx, args);
    case "coupon_delete": return couponDelete(ctx, args);
    case "coupon_list":   return couponList(ctx, args);
    // Checkout Sessions
    case "checkout_session_create": return checkoutSessionCreate(ctx, args);
    case "checkout_session_get":    return checkoutSessionGet(ctx, args);
    case "checkout_session_list":   return checkoutSessionList(ctx, args);
    case "checkout_session_expire": return checkoutSessionExpire(ctx, args);
    // Webhook Endpoints
    case "webhook_endpoint_create": return webhookEndpointCreate(ctx, args);
    case "webhook_endpoint_get":    return webhookEndpointGet(ctx, args);
    case "webhook_endpoint_update": return webhookEndpointUpdate(ctx, args);
    case "webhook_endpoint_delete": return webhookEndpointDelete(ctx, args);
    case "webhook_endpoint_list":   return webhookEndpointList(ctx, args);
    // Balance & Payouts
    case "balance_get":              return balanceGet(ctx, args);
    case "balance_transaction_list": return balanceTransactionList(ctx, args);
    case "payout_create": return payoutCreate(ctx, args);
    case "payout_get":    return payoutGet(ctx, args);
    case "payout_list":   return payoutList(ctx, args);
    // Disputes
    case "dispute_get":  return disputeGet(ctx, args);
    case "dispute_list": return disputeList(ctx, args);
    // Generic / Account
    case "account_info": return accountInfo(ctx, args);
    case "request":      return genericRequest(ctx, args);
    case "info":         return infoGet(ctx, args);
    default:
      throw new Error(
        `Unknown operation: ${op}. Supported: customer_create, customer_get, customer_update, ` +
        `customer_delete, customer_list, payment_intent_create, payment_intent_get, payment_intent_update, ` +
        `payment_intent_confirm, payment_intent_capture, payment_intent_cancel, payment_intent_list, ` +
        `payment_method_create, payment_method_get, payment_method_attach, payment_method_detach, ` +
        `payment_method_list, charge_create, charge_get, charge_capture, charge_list, ` +
        `refund_create, refund_get, refund_list, subscription_create, subscription_get, ` +
        `subscription_update, subscription_cancel, subscription_list, invoice_create, invoice_get, ` +
        `invoice_finalize, invoice_pay, invoice_void, invoice_list, product_create, product_get, ` +
        `product_update, product_delete, product_list, price_create, price_get, price_list, ` +
        `coupon_create, coupon_get, coupon_delete, coupon_list, checkout_session_create, ` +
        `checkout_session_get, checkout_session_list, checkout_session_expire, ` +
        `webhook_endpoint_create, webhook_endpoint_get, webhook_endpoint_update, ` +
        `webhook_endpoint_delete, webhook_endpoint_list, balance_get, balance_transaction_list, ` +
        `payout_create, payout_get, payout_list, dispute_get, dispute_list, ` +
        `account_info, request, info`
      );
  }
}

module.exports = { stripeClient };
