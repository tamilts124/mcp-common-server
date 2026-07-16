"use strict";
/**
 * test/sections/291-woocommerce-client.js
 * Isolated tests for woocommerceClientOps.js
 * 5 rigor levels: A=normal, B=validation, C=mock-network, D=security, E=concurrency
 *
 * All tests mock https.request — zero real network calls.
 */
const https = require("https");
const { EventEmitter } = require("events");
const { woocommerceClient } = require("../../lib/woocommerceClientOps");

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  \u2713 ${msg}`);
    passed++;
  } else {
    console.error(`  \u2717 FAIL: ${msg}`);
    failed++;
  }
}

async function assertRejects(fn, pattern, msg) {
  try {
    await fn();
    console.error(`  \u2717 FAIL (no throw): ${msg}`);
    failed++;
  } catch (e) {
    const ok = pattern ? (e.message || "").match(pattern) : true;
    if (ok) {
      console.log(`  \u2713 ${msg}`);
      passed++;
    } else {
      console.error(`  \u2717 FAIL (wrong error "${e.message}"): ${msg}`);
      failed++;
    }
  }
}

// ── Mock helpers ──────────────────────────────────────────────────────────────

function mockHttps(statusCode, body, headers = {}) {
  const original = https.request;
  https.request = (_opts, cb) => {
    const res = new EventEmitter();
    res.statusCode = statusCode;
    res.headers = {
      "x-wp-total": "100",
      "x-wp-totalpages": "10",
      ...headers,
    };
    const payload = body !== null && body !== undefined
      ? (typeof body === "string" ? body : JSON.stringify(body))
      : null;
    process.nextTick(() => {
      cb(res);
      if (payload) res.emit("data", Buffer.from(payload));
      res.emit("end");
    });
    const req = new EventEmitter();
    req.write = () => {}; req.end = () => {}; req.destroy = () => {};
    return req;
  };
  return () => { https.request = original; };
}

function mockHttpsError(errMsg) {
  const original = https.request;
  https.request = (_opts, _cb) => {
    const req = new EventEmitter();
    req.write = () => {};
    req.end = () => { process.nextTick(() => req.emit("error", new Error(errMsg))); };
    req.destroy = () => {};
    return req;
  };
  return () => { https.request = original; };
}

// ── Base args ─────────────────────────────────────────────────────────────────
const BASE = {
  site_url:        "https://mystore.example.com",
  consumer_key:    "ck_FAKE_CONSUMER_KEY_abc123xyz",
  consumer_secret: "cs_FAKE_CONSUMER_SECRET_xyz789abc",
};
function call(extra) { return woocommerceClient({ ...BASE, ...extra }); }

// ═══════════════════════════════════════════════════════════════════════════════
// A — Normal / happy-path
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n[A] Normal / happy-path tests");

async function testA() {
  // A1: product_list returns products array with pagination
  {
    const restore = mockHttps(200, [{ id: 1, name: "Widget" }, { id: 2, name: "Gadget" }]);
    const r = await call({ operation: "product_list" });
    assert(Array.isArray(r.data) && r.data.length === 2 && r.data[0].name === "Widget",
      "A1: product_list returns products array");
    assert(r._total === "100" && r._pages === "10",
      "A1b: product_list includes pagination metadata");
    restore();
  }

  // A2: product_get returns single product
  {
    const restore = mockHttps(200, { id: 42, name: "Super Widget", price: "29.99" });
    const r = await call({ operation: "product_get", id: 42 });
    assert(r.id === 42 && r.name === "Super Widget",
      "A2: product_get returns single product");
    restore();
  }

  // A3: product_create returns 201 product
  {
    const restore = mockHttps(201, { id: 99, name: "New Widget", status: "publish", price: "19.99" });
    const r = await call({ operation: "product_create", data: { name: "New Widget", regular_price: "19.99" } });
    assert(r.id === 99 && r.name === "New Widget" && r.status === "publish",
      "A3: product_create returns 201 product");
    restore();
  }

  // A4: product_update returns updated product
  {
    const restore = mockHttps(200, { id: 42, name: "Super Widget Pro", price: "39.99" });
    const r = await call({ operation: "product_update", id: 42, data: { name: "Super Widget Pro" } });
    assert(r.id === 42 && r.name === "Super Widget Pro",
      "A4: product_update returns updated product");
    restore();
  }

  // A5: product_delete returns deleted product object
  {
    const restore = mockHttps(200, { id: 42, name: "Widget", status: "trash" });
    const r = await call({ operation: "product_delete", id: 42 });
    assert(r.id === 42, "A5: product_delete returns deleted product");
    restore();
  }

  // A6: product_count returns count
  {
    const restore = mockHttps(200, { count: 57 });
    const r = await call({ operation: "product_count" });
    assert(r.count === 57, "A6: product_count returns count");
    restore();
  }

  // A7: product_variations returns variations array
  {
    const restore = mockHttps(200, [{ id: 101, attributes: [{ name: "Color", option: "Blue" }], price: "9.99" }]);
    const r = await call({ operation: "product_variations", product_id: 42 });
    assert(Array.isArray(r.data) && r.data[0].id === 101,
      "A7: product_variations returns variations");
    restore();
  }

  // A8: order_list returns orders array
  {
    const restore = mockHttps(200, [{ id: 201, status: "processing", total: "59.99" }, { id: 202, status: "completed", total: "29.99" }]);
    const r = await call({ operation: "order_list" });
    assert(Array.isArray(r.data) && r.data.length === 2 && r.data[0].status === "processing",
      "A8: order_list returns orders");
    restore();
  }

  // A9: order_get returns single order
  {
    const restore = mockHttps(200, { id: 201, status: "processing", billing: { first_name: "Alice" }, total: "59.99" });
    const r = await call({ operation: "order_get", id: 201 });
    assert(r.id === 201 && r.billing.first_name === "Alice",
      "A9: order_get returns single order");
    restore();
  }

  // A10: order_create returns 201 order
  {
    const restore = mockHttps(201, { id: 203, status: "pending", total: "15.00" });
    const r = await call({ operation: "order_create", data: { payment_method: "bacs", line_items: [{ product_id: 42, quantity: 1 }] } });
    assert(r.id === 203 && r.status === "pending",
      "A10: order_create returns 201 order");
    restore();
  }

  // A11: order_update returns updated order
  {
    const restore = mockHttps(200, { id: 201, status: "completed" });
    const r = await call({ operation: "order_update", id: 201, data: { status: "completed" } });
    assert(r.id === 201 && r.status === "completed",
      "A11: order_update returns updated order");
    restore();
  }

  // A12: order_delete returns deleted order
  {
    const restore = mockHttps(200, { id: 201, status: "trash" });
    const r = await call({ operation: "order_delete", id: 201 });
    assert(r.id === 201, "A12: order_delete returns deleted order");
    restore();
  }

  // A13: order_count returns count
  {
    const restore = mockHttps(200, { count: 33 });
    const r = await call({ operation: "order_count" });
    assert(r.count === 33, "A13: order_count returns count");
    restore();
  }

  // A14: order_notes returns notes array
  {
    const restore = mockHttps(200, [{ id: 1, note: "Order confirmed." }, { id: 2, note: "Shipped." }]);
    const r = await call({ operation: "order_notes", id: 201 });
    assert(Array.isArray(r.data) && r.data[0].note === "Order confirmed.",
      "A14: order_notes returns notes");
    restore();
  }

  // A15: customer_list returns customers
  {
    const restore = mockHttps(200, [{ id: 301, email: "alice@test.com" }, { id: 302, email: "bob@test.com" }]);
    const r = await call({ operation: "customer_list" });
    assert(Array.isArray(r.data) && r.data.length === 2,
      "A15: customer_list returns customers");
    restore();
  }

  // A16: customer_get returns single customer
  {
    const restore = mockHttps(200, { id: 301, email: "alice@test.com", first_name: "Alice" });
    const r = await call({ operation: "customer_get", id: 301 });
    assert(r.id === 301 && r.first_name === "Alice",
      "A16: customer_get returns single customer");
    restore();
  }

  // A17: customer_create returns 201 customer
  {
    const restore = mockHttps(201, { id: 303, email: "charlie@test.com", first_name: "Charlie" });
    const r = await call({ operation: "customer_create", data: { email: "charlie@test.com", first_name: "Charlie", username: "charlie" } });
    assert(r.id === 303 && r.email === "charlie@test.com",
      "A17: customer_create returns 201 customer");
    restore();
  }

  // A18: customer_update returns updated customer
  {
    const restore = mockHttps(200, { id: 301, first_name: "Alicia" });
    const r = await call({ operation: "customer_update", id: 301, data: { first_name: "Alicia" } });
    assert(r.id === 301 && r.first_name === "Alicia",
      "A18: customer_update returns updated customer");
    restore();
  }

  // A19: customer_delete returns deleted customer
  {
    const restore = mockHttps(200, { id: 301, email: "alice@test.com" });
    const r = await call({ operation: "customer_delete", id: 301 });
    assert(r.id === 301, "A19: customer_delete returns deleted customer");
    restore();
  }

  // A20: customer_count returns count
  {
    const restore = mockHttps(200, { count: 12 });
    const r = await call({ operation: "customer_count" });
    assert(r.count === 12, "A20: customer_count returns count");
    restore();
  }

  // A21: coupon_list returns coupons
  {
    const restore = mockHttps(200, [{ id: 401, code: "SAVE10", discount_type: "percent" }]);
    const r = await call({ operation: "coupon_list" });
    assert(Array.isArray(r.data) && r.data[0].code === "SAVE10",
      "A21: coupon_list returns coupons");
    restore();
  }

  // A22: coupon_get returns single coupon
  {
    const restore = mockHttps(200, { id: 401, code: "SAVE10", amount: "10.00" });
    const r = await call({ operation: "coupon_get", id: 401 });
    assert(r.id === 401 && r.code === "SAVE10",
      "A22: coupon_get returns single coupon");
    restore();
  }

  // A23: coupon_create returns 201 coupon
  {
    const restore = mockHttps(201, { id: 402, code: "SUMMER20", discount_type: "percent", amount: "20.00" });
    const r = await call({ operation: "coupon_create", data: { code: "SUMMER20", discount_type: "percent", amount: "20" } });
    assert(r.id === 402 && r.code === "SUMMER20",
      "A23: coupon_create returns 201 coupon");
    restore();
  }

  // A24: coupon_update returns updated coupon
  {
    const restore = mockHttps(200, { id: 401, code: "SAVE10", amount: "15.00" });
    const r = await call({ operation: "coupon_update", id: 401, data: { amount: "15" } });
    assert(r.amount === "15.00", "A24: coupon_update returns updated coupon");
    restore();
  }

  // A25: coupon_delete returns deleted coupon
  {
    const restore = mockHttps(200, { id: 401, code: "SAVE10" });
    const r = await call({ operation: "coupon_delete", id: 401 });
    assert(r.id === 401, "A25: coupon_delete returns deleted coupon");
    restore();
  }

  // A26: report_sales returns sales data
  {
    const restore = mockHttps(200, [{ totals: { net_revenue: "5430.00", orders_count: 87 } }]);
    const r = await call({ operation: "report_sales", period: "month" });
    // Sales report returns an array
    assert(Array.isArray(r.data) && r.data[0].totals !== undefined,
      "A26: report_sales returns sales data");
    restore();
  }

  // A27: report_top_sellers returns top products
  {
    const restore = mockHttps(200, [{ name: "Widget", product_id: 42, quantity: 120 }]);
    const r = await call({ operation: "report_top_sellers" });
    assert(Array.isArray(r.data) && r.data[0].name === "Widget",
      "A27: report_top_sellers returns top-selling products");
    restore();
  }

  // A28: report_orders_totals returns order totals by status
  {
    const restore = mockHttps(200, [{ slug: "pending", name: "Pending payment", total: "5" }, { slug: "processing", name: "Processing", total: "12" }]);
    const r = await call({ operation: "report_orders_totals" });
    assert(Array.isArray(r.data) && r.data[0].slug === "pending",
      "A28: report_orders_totals returns totals by status");
    restore();
  }

  // A29: settings_get (all groups)
  {
    const restore = mockHttps(200, [{ id: "general", label: "General" }, { id: "products", label: "Products" }]);
    const r = await call({ operation: "settings_get" });
    assert(Array.isArray(r.data) && r.data[0].id === "general",
      "A29: settings_get returns settings groups");
    restore();
  }

  // A30: settings_get with specific group
  {
    const restore = mockHttps(200, [{ id: "woocommerce_store_address", value: "123 Main St" }]);
    const r = await call({ operation: "settings_get", group: "general" });
    assert(Array.isArray(r.data),
      "A30: settings_get with group returns settings");
    restore();
  }

  // A31: settings_update returns updated setting
  {
    const restore = mockHttps(200, { id: "woocommerce_currency", value: "EUR" });
    const r = await call({ operation: "settings_update", group: "general", id: "woocommerce_currency", value: "EUR" });
    assert(r.id === "woocommerce_currency" && r.value === "EUR",
      "A31: settings_update returns updated setting");
    restore();
  }

  // A32: system_status returns status info
  {
    const restore = mockHttps(200, { environment: { site_url: "https://mystore.example.com", wc_version: "8.0.0" }, database: { wc_database_version: "8.0.0" } });
    const r = await call({ operation: "system_status" });
    assert(r.environment && r.environment.wc_version === "8.0.0",
      "A32: system_status returns WC system info");
    restore();
  }

  // A33: generic GET request
  {
    const restore = mockHttps(200, { count: 57 });
    const r = await call({ operation: "request", method: "GET", path: "/products/count" });
    assert(r.count === 57, "A33: generic GET request returns body");
    restore();
  }

  // A34: generic POST request
  {
    const restore = mockHttps(200, { id: 201, status: "completed" });
    const r = await call({ operation: "request", method: "POST", path: "/orders/201", body: { status: "completed" } });
    assert(r.status === "completed", "A34: generic POST request returns body");
    restore();
  }

  // A35: subdirectory WordPress install
  {
    let capturedHostname = null, capturedPath = null;
    const original = https.request;
    https.request = (opts, cb) => {
      capturedHostname = opts.hostname;
      capturedPath = opts.path;
      const res = new EventEmitter();
      res.statusCode = 200; res.headers = {};
      process.nextTick(() => {
        cb(res);
        res.emit("data", Buffer.from(JSON.stringify({ id: 1, name: "Widget" })));
        res.emit("end");
      });
      const req = new EventEmitter(); req.write = () => {}; req.end = () => {}; req.destroy = () => {};
      return req;
    };
    await woocommerceClient({ ...BASE, site_url: "https://example.com/shop", operation: "product_get", id: 1 });
    assert(capturedHostname === "example.com" && capturedPath.includes("/shop/wp-json/wc/v3/"),
      "A35: subdirectory install uses correct hostname + path prefix");
    https.request = original;
  }

  // A36: product_list with per_page and status filters
  {
    let capturedPath = null;
    const original = https.request;
    https.request = (opts, cb) => {
      capturedPath = opts.path;
      const res = new EventEmitter();
      res.statusCode = 200; res.headers = {};
      process.nextTick(() => {
        cb(res);
        res.emit("data", Buffer.from(JSON.stringify([])));
        res.emit("end");
      });
      const req = new EventEmitter(); req.write = () => {}; req.end = () => {}; req.destroy = () => {};
      return req;
    };
    await call({ operation: "product_list", per_page: 20, status: "publish" });
    assert(capturedPath && capturedPath.includes("per_page=20") && capturedPath.includes("status=publish"),
      "A36: product_list sends per_page and status as query params");
    https.request = original;
  }

  // A37: non-JSON response returned as {_raw}
  {
    const original = https.request;
    https.request = (_opts, cb) => {
      const res = new EventEmitter();
      res.statusCode = 200; res.headers = {};
      process.nextTick(() => {
        cb(res);
        res.emit("data", Buffer.from("<html>Maintenance</html>"));
        res.emit("end");
      });
      const req = new EventEmitter(); req.write = () => {}; req.end = () => {}; req.destroy = () => {};
      return req;
    };
    const r = await call({ operation: "system_status" });
    assert(r && r._raw && r._raw.includes("<html>"),
      "A37: non-JSON response returned as {_raw}");
    https.request = original;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// B — Validation (empty/invalid inputs)
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n[B] Validation tests");

async function testB() {
  // B1: missing operation throws
  await assertRejects(
    () => woocommerceClient({ ...BASE }),
    /operation.*required|non-empty/i, "B1: missing operation throws"
  );

  // B2: missing site_url throws
  await assertRejects(
    () => woocommerceClient({ operation: "product_list", consumer_key: "ck_x", consumer_secret: "cs_x" }),
    /site_url.*required|non-empty/i, "B2: missing site_url throws"
  );

  // B3: missing consumer_key throws
  await assertRejects(
    () => woocommerceClient({ ...BASE, consumer_key: undefined }),
    /consumer_key.*required|non-empty/i, "B3: missing consumer_key throws"
  );

  // B4: missing consumer_secret throws
  await assertRejects(
    () => woocommerceClient({ ...BASE, consumer_secret: undefined }),
    /consumer_secret.*required|non-empty/i, "B4: missing consumer_secret throws"
  );

  // B5: unknown operation throws
  await assertRejects(
    () => call({ operation: "banana" }),
    /Unknown operation.*banana/i, "B5: unknown operation throws"
  );

  // B6: product_create missing data throws
  await assertRejects(
    () => call({ operation: "product_create" }),
    /data.*required/i, "B6: product_create missing data throws"
  );

  // B7: product_create data as array throws
  await assertRejects(
    () => call({ operation: "product_create", data: ["bad"] }),
    /data.*required/i, "B7: product_create data as array throws"
  );

  // B8: product_get missing id throws
  await assertRejects(
    () => call({ operation: "product_get" }),
    /id.*required|non-empty/i, "B8: product_get missing id throws"
  );

  // B9: product_update missing data throws
  await assertRejects(
    () => call({ operation: "product_update", id: 42 }),
    /data.*required/i, "B9: product_update missing data throws"
  );

  // B10: product_variations missing product_id throws
  await assertRejects(
    () => call({ operation: "product_variations" }),
    /product_id.*required|non-empty/i, "B10: product_variations missing product_id throws"
  );

  // B11: order_create missing data throws
  await assertRejects(
    () => call({ operation: "order_create" }),
    /data.*required/i, "B11: order_create missing data throws"
  );

  // B12: order_update missing data throws
  await assertRejects(
    () => call({ operation: "order_update", id: 201 }),
    /data.*required/i, "B12: order_update missing data throws"
  );

  // B13: order_get missing id throws
  await assertRejects(
    () => call({ operation: "order_get" }),
    /id.*required|non-empty/i, "B13: order_get missing id throws"
  );

  // B14: order_notes missing id throws
  await assertRejects(
    () => call({ operation: "order_notes" }),
    /id.*required|non-empty/i, "B14: order_notes missing id throws"
  );

  // B15: customer_create missing data throws
  await assertRejects(
    () => call({ operation: "customer_create" }),
    /data.*required/i, "B15: customer_create missing data throws"
  );

  // B16: coupon_create missing data throws
  await assertRejects(
    () => call({ operation: "coupon_create" }),
    /data.*required/i, "B16: coupon_create missing data throws"
  );

  // B17: coupon_update missing data throws
  await assertRejects(
    () => call({ operation: "coupon_update", id: 401 }),
    /data.*required/i, "B17: coupon_update missing data throws"
  );

  // B18: settings_update missing group throws
  await assertRejects(
    () => call({ operation: "settings_update", id: "woocommerce_currency", value: "EUR" }),
    /group.*required|non-empty/i, "B18: settings_update missing group throws"
  );

  // B19: settings_update missing id throws
  await assertRejects(
    () => call({ operation: "settings_update", group: "general", value: "EUR" }),
    /id.*required|non-empty/i, "B19: settings_update missing id throws"
  );

  // B20: settings_update missing value throws
  await assertRejects(
    () => call({ operation: "settings_update", group: "general", id: "woocommerce_currency" }),
    /value.*required/i, "B20: settings_update missing value throws"
  );

  // B21: generic request unsupported method throws
  await assertRejects(
    () => call({ operation: "request", method: "TRACE", path: "/products" }),
    /Unsupported method|TRACE/i, "B21: generic request TRACE method throws"
  );

  // B22: generic request missing path throws
  await assertRejects(
    () => call({ operation: "request", method: "GET" }),
    /path.*required|non-empty/i, "B22: generic request missing path throws"
  );

  // B23: per_page out of range throws
  await assertRejects(
    () => call({ operation: "product_list", per_page: 200 }),
    /per_page.*<= 100/i, "B23: per_page > 100 throws"
  );

  // B24: invalid site_url throws
  await assertRejects(
    () => woocommerceClient({ ...BASE, site_url: "not-a-url-!!!#@", operation: "system_status" }),
    /not a valid URL|site_url/i, "B24: invalid site_url throws"
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// C — Mock-network tests
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n[C] Mock-network tests");

async function testC() {
  // C1: network error propagates
  {
    const restore = mockHttpsError("ECONNREFUSED");
    await assertRejects(
      () => call({ operation: "system_status" }),
      /ECONNREFUSED/i, "C1: network error propagates"
    );
    restore();
  }

  // C2: 401 Unauthorized throws
  {
    const restore = mockHttps(401, { code: "woocommerce_rest_cannot_view", message: "Sorry, you cannot list resources." });
    await assertRejects(
      () => call({ operation: "product_list" }),
      /WooCommerce API error 401/i, "C2: 401 Unauthorized throws"
    );
    restore();
  }

  // C3: 404 Not Found throws
  {
    const restore = mockHttps(404, { code: "woocommerce_rest_product_invalid_id", message: "Invalid ID." });
    await assertRejects(
      () => call({ operation: "product_get", id: 99999 }),
      /WooCommerce API error 404/i, "C3: 404 Not Found throws"
    );
    restore();
  }

  // C4: 422 Unprocessable Entity throws
  {
    const restore = mockHttps(422, { code: "rest_invalid_param", message: "Invalid parameter(s): email" });
    await assertRejects(
      () => call({ operation: "customer_create", data: { email: "bad" } }),
      /WooCommerce API error 422/i, "C4: 422 Unprocessable Entity throws"
    );
    restore();
  }

  // C5: 403 Forbidden throws
  {
    const restore = mockHttps(403, { code: "woocommerce_rest_cannot_edit", message: "Sorry, you are not allowed to edit this resource." });
    await assertRejects(
      () => call({ operation: "order_update", id: 201, data: { status: "completed" } }),
      /WooCommerce API error 403/i, "C5: 403 Forbidden throws"
    );
    restore();
  }

  // C6: 500 Server Error throws
  {
    const restore = mockHttps(500, { code: "internal_error", message: "Internal server error" });
    await assertRejects(
      () => call({ operation: "system_status" }),
      /WooCommerce API error 500/i, "C6: 500 Server Error throws"
    );
    restore();
  }

  // C7: timeout throws
  {
    const original = https.request;
    https.request = (_opts, _cb) => {
      const req = new EventEmitter();
      req.write = () => {}; req.end = () => {};
      req.destroy = () => req.emit("error", new Error("socket hang up"));
      return req;
    };
    await assertRejects(
      () => call({ operation: "system_status", timeout: 50 }),
      /timed out|hang up/i, "C7: request times out"
    );
    https.request = original;
  }

  // C8: Basic auth header sent correctly
  {
    let capturedHeaders = null;
    const original = https.request;
    https.request = (opts, cb) => {
      capturedHeaders = opts.headers;
      const res = new EventEmitter();
      res.statusCode = 200; res.headers = {};
      process.nextTick(() => {
        cb(res);
        res.emit("data", Buffer.from(JSON.stringify({ environment: {} })));
        res.emit("end");
      });
      const req = new EventEmitter(); req.write = () => {}; req.end = () => {}; req.destroy = () => {};
      return req;
    };
    await call({ operation: "system_status" });
    const expectedB64 = Buffer.from(`${BASE.consumer_key}:${BASE.consumer_secret}`).toString("base64");
    assert(capturedHeaders && capturedHeaders["Authorization"] === `Basic ${expectedB64}`,
      "C8: Basic auth header is correct base64 of key:secret");
    https.request = original;
  }

  // C9: correct hostname used
  {
    let capturedHostname = null;
    const original = https.request;
    https.request = (opts, cb) => {
      capturedHostname = opts.hostname;
      const res = new EventEmitter();
      res.statusCode = 200; res.headers = {};
      process.nextTick(() => {
        cb(res);
        res.emit("data", Buffer.from(JSON.stringify({ environment: {} })));
        res.emit("end");
      });
      const req = new EventEmitter(); req.write = () => {}; req.end = () => {}; req.destroy = () => {};
      return req;
    };
    await call({ operation: "system_status" });
    assert(capturedHostname === "mystore.example.com",
      "C9: correct hostname (mystore.example.com) used");
    https.request = original;
  }

  // C10: correct WC API path prefix used
  {
    let capturedPath = null;
    const original = https.request;
    https.request = (opts, cb) => {
      capturedPath = opts.path;
      const res = new EventEmitter();
      res.statusCode = 200; res.headers = {};
      process.nextTick(() => {
        cb(res);
        res.emit("data", Buffer.from(JSON.stringify([]))); res.emit("end");
      });
      const req = new EventEmitter(); req.write = () => {}; req.end = () => {}; req.destroy = () => {};
      return req;
    };
    await call({ operation: "product_list" });
    assert(capturedPath && capturedPath.startsWith("/wp-json/wc/v3/"),
      "C10: API path starts with /wp-json/wc/v3/");
    https.request = original;
  }

  // C11: product_create sends JSON body
  {
    let capturedBody = null;
    const original = https.request;
    https.request = (_opts, cb) => {
      const res = new EventEmitter();
      res.statusCode = 201; res.headers = {};
      process.nextTick(() => {
        cb(res);
        res.emit("data", Buffer.from(JSON.stringify({ id: 1, name: "Tester" })));
        res.emit("end");
      });
      const req = new EventEmitter();
      req.write = (b) => { capturedBody = b; }; req.end = () => {}; req.destroy = () => {};
      return req;
    };
    await call({ operation: "product_create", data: { name: "Tester", regular_price: "9.99" } });
    const parsed = JSON.parse(capturedBody);
    assert(parsed.name === "Tester" && parsed.regular_price === "9.99",
      "C11: product_create sends correct JSON body");
    https.request = original;
  }

  // C12: response body exceeds 16 MB cap
  {
    const original = https.request;
    https.request = (_opts, cb) => {
      const res = new EventEmitter();
      res.statusCode = 200; res.headers = {};
      process.nextTick(() => {
        cb(res);
        res.emit("data", Buffer.alloc(17 * 1024 * 1024, 0x41));
        res.emit("end");
      });
      const req = new EventEmitter(); req.write = () => {}; req.end = () => {}; req.destroy = () => {};
      return req;
    };
    await assertRejects(
      () => call({ operation: "system_status" }),
      /16 MB|exceeds/i, "C12: 17 MB response exceeds 16 MB cap"
    );
    https.request = original;
  }

  // C13: order_list with date filters sends correct params
  {
    let capturedPath = null;
    const original = https.request;
    https.request = (opts, cb) => {
      capturedPath = opts.path;
      const res = new EventEmitter();
      res.statusCode = 200; res.headers = {};
      process.nextTick(() => {
        cb(res); res.emit("data", Buffer.from(JSON.stringify([]))); res.emit("end");
      });
      const req = new EventEmitter(); req.write = () => {}; req.end = () => {}; req.destroy = () => {};
      return req;
    };
    await call({ operation: "order_list", after: "2024-01-01T00:00:00", before: "2024-01-31T23:59:59", status: "completed" });
    assert(capturedPath && capturedPath.includes("after=") && capturedPath.includes("status=completed"),
      "C13: order_list sends date filters and status as query params");
    https.request = original;
  }

  // C14: rejectUnauthorized defaults to true
  {
    let capturedOpts = null;
    const original = https.request;
    https.request = (opts, cb) => {
      capturedOpts = opts;
      const res = new EventEmitter();
      res.statusCode = 200; res.headers = {};
      process.nextTick(() => {
        cb(res); res.emit("data", Buffer.from(JSON.stringify({ environment: {} }))); res.emit("end");
      });
      const req = new EventEmitter(); req.write = () => {}; req.end = () => {}; req.destroy = () => {};
      return req;
    };
    await call({ operation: "system_status" });
    assert(capturedOpts && capturedOpts.rejectUnauthorized === true,
      "C14: rejectUnauthorized defaults to true");
    https.request = original;
  }

  // C15: product_delete sends force=true as query param
  {
    let capturedPath = null;
    const original = https.request;
    https.request = (opts, cb) => {
      capturedPath = opts.path;
      const res = new EventEmitter();
      res.statusCode = 200; res.headers = {};
      process.nextTick(() => {
        cb(res); res.emit("data", Buffer.from(JSON.stringify({ id: 42 }))); res.emit("end");
      });
      const req = new EventEmitter(); req.write = () => {}; req.end = () => {}; req.destroy = () => {};
      return req;
    };
    await call({ operation: "product_delete", id: 42 });
    assert(capturedPath && capturedPath.includes("force=true"),
      "C15: product_delete sends force=true by default");
    https.request = original;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// D — Security tests
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n[D] Security tests");

async function testD() {
  // D1: NUL byte in operation throws
  await assertRejects(
    () => call({ operation: "system_status\x00inject" }),
    /NUL|operation/i, "D1: NUL byte in operation is rejected"
  );

  // D2: NUL byte in site_url throws
  await assertRejects(
    () => woocommerceClient({ ...BASE, site_url: "https://evil\x00.com", operation: "system_status" }),
    /NUL|site_url/i, "D2: NUL byte in site_url is rejected"
  );

  // D3: NUL byte in consumer_key throws
  await assertRejects(
    () => woocommerceClient({ ...BASE, consumer_key: "ck_\x00bad", operation: "system_status" }),
    /NUL|consumer_key/i, "D3: NUL byte in consumer_key is rejected"
  );

  // D4: NUL byte in consumer_secret throws
  await assertRejects(
    () => woocommerceClient({ ...BASE, consumer_secret: "cs_\x00bad", operation: "system_status" }),
    /NUL|consumer_secret/i, "D4: NUL byte in consumer_secret is rejected"
  );

  // D5: NUL byte in product search throws
  await assertRejects(
    () => call({ operation: "product_list", search: "widget\x00inject" }),
    /NUL|search/i, "D5: NUL byte in search is rejected"
  );

  // D6: consumer_key scrubbed from API error messages
  {
    const canaryKey = "ck_CANARY_KEY_DO_NOT_LEAK_abc123xyz";
    const restore = mockHttps(401, { code: "rest_forbidden", message: `Invalid key: ${canaryKey}` });
    try {
      await woocommerceClient({ ...BASE, consumer_key: canaryKey, operation: "system_status" });
      assert(false, "D6: should have thrown");
    } catch (e) {
      assert(!e.message.includes(canaryKey), "D6: consumer_key scrubbed from API error");
    }
    restore();
  }

  // D7: consumer_secret scrubbed from API error messages
  {
    const canarySecret = "cs_CANARY_SECRET_DO_NOT_LEAK_xyz789";
    const original = https.request;
    https.request = (_opts, cb) => {
      const res = new EventEmitter();
      res.statusCode = 401; res.headers = {};
      process.nextTick(() => {
        cb(res);
        res.emit("data", Buffer.from(JSON.stringify({ message: `Bad secret: ${canarySecret}` })));
        res.emit("end");
      });
      const req = new EventEmitter(); req.write = () => {}; req.end = () => {}; req.destroy = () => {};
      return req;
    };
    try {
      await woocommerceClient({ ...BASE, consumer_secret: canarySecret, operation: "system_status" });
      assert(false, "D7: should have thrown");
    } catch (e) {
      assert(!e.message.includes(canarySecret), "D7: consumer_secret scrubbed from API error");
    }
    https.request = original;
  }

  // D8: reject_unauthorized defaults to true (TLS enforced)
  {
    let capturedOpts = null;
    const original = https.request;
    https.request = (opts, cb) => {
      capturedOpts = opts;
      const res = new EventEmitter();
      res.statusCode = 200; res.headers = {};
      process.nextTick(() => { cb(res); res.emit("data", Buffer.from(JSON.stringify({}))); res.emit("end"); });
      const req = new EventEmitter(); req.write = () => {}; req.end = () => {}; req.destroy = () => {};
      return req;
    };
    await call({ operation: "system_status" });
    assert(capturedOpts && capturedOpts.rejectUnauthorized === true,
      "D8: rejectUnauthorized=true by default (TLS enforced)");
    https.request = original;
  }

  // D9: reject_unauthorized: false forwarded
  {
    let capturedOpts = null;
    const original = https.request;
    https.request = (opts, cb) => {
      capturedOpts = opts;
      const res = new EventEmitter();
      res.statusCode = 200; res.headers = {};
      process.nextTick(() => { cb(res); res.emit("data", Buffer.from(JSON.stringify({}))); res.emit("end"); });
      const req = new EventEmitter(); req.write = () => {}; req.end = () => {}; req.destroy = () => {};
      return req;
    };
    await call({ operation: "system_status", reject_unauthorized: false });
    assert(capturedOpts && capturedOpts.rejectUnauthorized === false,
      "D9: rejectUnauthorized:false forwarded correctly");
    https.request = original;
  }

  // D10: huge timeout clamped, request still succeeds
  {
    const restore = mockHttps(200, { environment: { wc_version: "8.0.0" } });
    const r = await call({ operation: "system_status", timeout: 9_999_999 });
    assert(r && r.environment, "D10: huge timeout clamped, request still works");
    restore();
  }

  // D11: NUL byte in customer email field throws
  await assertRejects(
    () => call({ operation: "customer_list", email: "bad\x00@evil.com" }),
    /NUL|email/i, "D11: NUL byte in customer email is rejected"
  );

  // D12: consumer_key not leaked in response body
  {
    const restore = mockHttps(200, { environment: { site_url: "https://mystore.example.com" } });
    const r = await call({ operation: "system_status" });
    assert(!JSON.stringify(r).includes(BASE.consumer_key),
      "D12: consumer_key not leaked in response body");
    restore();
  }

  // D13: NUL byte in group setting throws
  await assertRejects(
    () => call({ operation: "settings_update", group: "general\x00inject", id: "woocommerce_currency", value: "EUR" }),
    /NUL|group/i, "D13: NUL byte in settings group is rejected"
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// E — Concurrency / stress tests
// ═══════════════════════════════════════════════════════════════════════════════
console.log("\n[E] Concurrency tests");

async function testE() {
  // E1: 20 concurrent system_status calls all succeed
  {
    const restore = mockHttps(200, { environment: { wc_version: "8.0.0" } });
    const tasks = Array.from({ length: 20 }, () => call({ operation: "system_status" }));
    const results = await Promise.all(tasks);
    assert(results.length === 20 && results.every(r => r.environment && r.environment.wc_version === "8.0.0"),
      "E1: 20 concurrent system_status calls all succeed");
    restore();
  }

  // E2: 10 concurrent product_list calls
  {
    const restore = mockHttps(200, [{ id: 1, name: "Widget" }]);
    const tasks = Array.from({ length: 10 }, () => call({ operation: "product_list" }));
    const results = await Promise.all(tasks);
    assert(results.length === 10 && results.every(r => Array.isArray(r.data)),
      "E2: 10 concurrent product_list calls all succeed");
    restore();
  }

  // E3: mix of success and validation errors in parallel
  {
    const restore = mockHttps(200, { environment: {} });
    const tasks = [
      call({ operation: "system_status" }),
      call({ operation: "product_create" }).catch(e => e),    // missing data
      call({ operation: "system_status" }),
    ];
    const [r1, r2, r3] = await Promise.all(tasks);
    assert(r1.environment !== undefined && r2 instanceof Error && r3.environment !== undefined,
      "E3: mix of success + validation errors handled correctly");
    restore();
  }

  // E4: 15 rapid calls don't leak state across contexts
  {
    let callCount = 0;
    const original = https.request;
    https.request = (_opts, cb) => {
      callCount++;
      const mine = callCount;
      const res = new EventEmitter();
      res.statusCode = 200; res.headers = {};
      process.nextTick(() => {
        cb(res);
        res.emit("data", Buffer.from(JSON.stringify({ environment: { call_id: mine } })));
        res.emit("end");
      });
      const req = new EventEmitter(); req.write = () => {}; req.end = () => {}; req.destroy = () => {};
      return req;
    };
    const tasks = Array.from({ length: 15 }, () => call({ operation: "system_status" }));
    const results = await Promise.all(tasks);
    assert(callCount === 15 && results.length === 15,
      "E4: 15 rapid calls, no state leakage");
    https.request = original;
  }

  // E5: concurrent network errors all propagate independently
  {
    const restore = mockHttpsError("ECONNRESET");
    const tasks = Array.from({ length: 8 }, () => call({ operation: "system_status" }).catch(e => e));
    const results = await Promise.all(tasks);
    assert(results.length === 8 && results.every(e => e instanceof Error && /ECONNRESET/i.test(e.message)),
      "E5: 8 concurrent network errors all propagate independently");
    restore();
  }

  // E6: 5 concurrent different operations succeed
  {
    const restore = mockHttps(200, { id: 1, environment: {}, count: 10 });
    const tasks = [
      call({ operation: "system_status" }),
      call({ operation: "product_count" }),
      call({ operation: "order_count" }),
      call({ operation: "customer_count" }),
      call({ operation: "settings_get" }),
    ];
    const results = await Promise.all(tasks);
    assert(results.length === 5 && results.every(r => r !== null),
      "E6: 5 concurrent different operations succeed");
    restore();
  }

  // E7: 50 sequential validation errors don't accumulate
  {
    let errCount = 0;
    for (let i = 0; i < 50; i++) {
      await call({ operation: "product_create" }).catch(() => errCount++);
    }
    assert(errCount === 50, "E7: 50 sequential validation errors all caught cleanly");
  }

  // E8: concurrent calls with different stores use correct auth
  {
    const key1 = "ck_STORE1_aaaaaaaaaaaaaaaaaaaaaaaa";
    const key2 = "ck_STORE2_bbbbbbbbbbbbbbbbbbbbbbbb";
    const keys = [];
    const original = https.request;
    https.request = (opts, cb) => {
      keys.push(opts.headers["Authorization"]);
      const res = new EventEmitter();
      res.statusCode = 200; res.headers = {};
      process.nextTick(() => {
        cb(res); res.emit("data", Buffer.from(JSON.stringify({ environment: {} }))); res.emit("end");
      });
      const req = new EventEmitter(); req.write = () => {}; req.end = () => {}; req.destroy = () => {};
      return req;
    };
    await Promise.all([
      woocommerceClient({ ...BASE, consumer_key: key1, operation: "system_status" }),
      woocommerceClient({ ...BASE, consumer_key: key2, operation: "system_status" }),
    ]);
    const b64_1 = Buffer.from(`${key1}:${BASE.consumer_secret}`).toString("base64");
    const b64_2 = Buffer.from(`${key2}:${BASE.consumer_secret}`).toString("base64");
    assert(
      keys.some(k => k === `Basic ${b64_1}`) && keys.some(k => k === `Basic ${b64_2}`),
      "E8: concurrent calls with different stores use correct auth headers"
    );
    https.request = original;
  }

  // E9: 30 concurrent product_creates all succeed
  {
    const restore = mockHttps(201, { id: 1, name: "Widget", status: "publish" });
    const tasks = Array.from({ length: 30 }, (_, i) =>
      call({ operation: "product_create", data: { name: `Product ${i}` } })
    );
    const results = await Promise.all(tasks);
    assert(results.length === 30 && results.every(r => r.status === "publish"),
      "E9: 30 concurrent product_creates all succeed");
    restore();
  }

  // E10: 10 concurrent: 5 success + 5 API errors handled
  {
    let toggle = 0;
    const original = https.request;
    https.request = (_opts, cb) => {
      const mine = toggle++;
      const statusCode = mine % 2 === 0 ? 200 : 404;
      const body = mine % 2 === 0
        ? { environment: { ok: true } }
        : { code: "not_found", message: "Not found." };
      const res = new EventEmitter();
      res.statusCode = statusCode; res.headers = {};
      process.nextTick(() => {
        cb(res);
        res.emit("data", Buffer.from(JSON.stringify(body)));
        res.emit("end");
      });
      const req = new EventEmitter(); req.write = () => {}; req.end = () => {}; req.destroy = () => {};
      return req;
    };
    const tasks = Array.from({ length: 10 }, () =>
      call({ operation: "system_status" }).catch(e => ({ error: e.message }))
    );
    const results = await Promise.all(tasks);
    const successes = results.filter(r => r.environment).length;
    const failures  = results.filter(r => r.error).length;
    assert(successes === 5 && failures === 5,
      "E10: 10 concurrent: 5 succeed + 5 fail correctly");
    https.request = original;
  }
}

// ── Run all ───────────────────────────────────────────────────────────────────
(async () => {
  try {
    await testA();
    await testB();
    await testC();
    await testD();
    await testE();
  } catch (err) {
    console.error("UNEXPECTED:", err);
    failed++;
  }
  console.log(`\n${"─".repeat(60)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
