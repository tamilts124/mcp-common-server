"use strict";
/**
 * test/sections/290-shopify-client.js
 * Isolated tests for shopifyClientOps.js
 * 5 rigor levels: A=normal, B=validation, C=mock-network, D=security, E=concurrency
 *
 * Mocking strategy:
 *   - All tests use bearer token mode (access_token) to avoid any real network calls.
 *   - We monkey-patch https.request to control responses.
 */
const https = require("https");
const { EventEmitter } = require("events");
const { shopifyClient } = require("../../lib/shopifyClientOps");

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

function mockHttps(statusCode, body) {
  const original = https.request;
  https.request = (_opts, cb) => {
    const res = new EventEmitter();
    res.statusCode = statusCode;
    res.headers = { "x-shopify-shop-api-call-limit": "10/40" };
    const payload = body !== null && body !== undefined
      ? (typeof body === "string" ? body : JSON.stringify(body))
      : null;
    process.nextTick(() => {
      cb(res);
      if (payload) res.emit("data", Buffer.from(payload));
      res.emit("end");
    });
    const req = new EventEmitter();
    req.write   = () => {};
    req.end     = () => {};
    req.destroy = () => {};
    return req;
  };
  return () => { https.request = original; };
}

function mockHttpsEmpty(statusCode) {
  const original = https.request;
  https.request = (_opts, cb) => {
    const res = new EventEmitter();
    res.statusCode = statusCode;
    res.headers = {};
    process.nextTick(() => { cb(res); res.emit("end"); });
    const req = new EventEmitter();
    req.write   = () => {};
    req.end     = () => {};
    req.destroy = () => {};
    return req;
  };
  return () => { https.request = original; };
}

function mockHttpsError(errMsg) {
  const original = https.request;
  https.request = (_opts, _cb) => {
    const req = new EventEmitter();
    req.write   = () => {};
    req.end     = () => { process.nextTick(() => req.emit("error", new Error(errMsg))); };
    req.destroy = () => {};
    return req;
  };
  return () => { https.request = original; };
}

// ── Base args ─────────────────────────────────────────────────────────────────
const BASE = { shop: "my-test-store", access_token: "shpat_FAKE_TOKEN_123456789" };
function call(extra) { return shopifyClient({ ...BASE, ...extra }); }

// ════════════════════════════════════════════════════════════════════════════
// A — Normal / happy-path
// ════════════════════════════════════════════════════════════════════════════
console.log("\n[A] Normal / happy-path tests");

async function testA() {
  // A1: product_list returns products array
  {
    const restore = mockHttps(200, { products: [{ id: 1, title: "Widget" }, { id: 2, title: "Gadget" }] });
    const r = await call({ operation: "product_list" });
    assert(Array.isArray(r.products) && r.products.length === 2 && r.products[0].title === "Widget",
      "A1: product_list returns products array");
    restore();
  }

  // A2: product_get returns single product
  {
    const restore = mockHttps(200, { product: { id: 632910392, title: "IPod Nano - 8GB", vendor: "Apple" } });
    const r = await call({ operation: "product_get", id: 632910392 });
    assert(r.product && r.product.id === 632910392 && r.product.vendor === "Apple",
      "A2: product_get returns single product");
    restore();
  }

  // A3: product_create returns 201 body
  {
    const restore = mockHttps(201, { product: { id: 999, title: "New Widget", status: "active" } });
    const r = await call({ operation: "product_create", product: { title: "New Widget", status: "active" } });
    assert(r.product && r.product.id === 999 && r.product.title === "New Widget",
      "A3: product_create returns 201 body");
    restore();
  }

  // A4: product_update returns updated product
  {
    const restore = mockHttps(200, { product: { id: 632910392, title: "IPod Nano - 16GB" } });
    const r = await call({ operation: "product_update", id: 632910392, product: { title: "IPod Nano - 16GB" } });
    assert(r.product && r.product.title === "IPod Nano - 16GB",
      "A4: product_update returns updated product");
    restore();
  }

  // A5: product_delete returns {deleted:true}
  {
    const restore = mockHttps(200, {});
    const r = await call({ operation: "product_delete", id: 632910392 });
    assert(r.deleted === true && r.id === "632910392",
      "A5: product_delete returns {deleted:true, id}");
    restore();
  }

  // A6: product_count returns count
  {
    const restore = mockHttps(200, { count: 42 });
    const r = await call({ operation: "product_count" });
    assert(r.count === 42, "A6: product_count returns count");
    restore();
  }

  // A7: order_list returns orders
  {
    const restore = mockHttps(200, { orders: [{ id: 1001, email: "buyer@test.com", financial_status: "paid" }] });
    const r = await call({ operation: "order_list", status: "any" });
    assert(Array.isArray(r.orders) && r.orders[0].email === "buyer@test.com",
      "A7: order_list returns orders");
    restore();
  }

  // A8: order_get returns single order
  {
    const restore = mockHttps(200, { order: { id: 1001, total_price: "199.99", financial_status: "paid" } });
    const r = await call({ operation: "order_get", id: 1001 });
    assert(r.order && r.order.total_price === "199.99",
      "A8: order_get returns single order");
    restore();
  }

  // A9: order_update returns updated order
  {
    const restore = mockHttps(200, { order: { id: 1001, note: "Rush delivery" } });
    const r = await call({ operation: "order_update", id: 1001, order: { note: "Rush delivery" } });
    assert(r.order && r.order.note === "Rush delivery",
      "A9: order_update returns updated order");
    restore();
  }

  // A10: order_cancel returns cancelled order
  {
    const restore = mockHttps(200, { order: { id: 1001, cancelled_at: "2024-01-15T10:00:00Z" } });
    const r = await call({ operation: "order_cancel", id: 1001, reason: "customer" });
    assert(r.order && r.order.cancelled_at !== null,
      "A10: order_cancel returns cancelled order");
    restore();
  }

  // A11: order_close returns closed order
  {
    const restore = mockHttps(200, { order: { id: 1001, closed_at: "2024-01-15T10:00:00Z" } });
    const r = await call({ operation: "order_close", id: 1001 });
    assert(r.order && r.order.closed_at !== null,
      "A11: order_close returns closed order");
    restore();
  }

  // A12: order_count returns count
  {
    const restore = mockHttps(200, { count: 17 });
    const r = await call({ operation: "order_count", status: "open" });
    assert(r.count === 17, "A12: order_count returns count");
    restore();
  }

  // A13: customer_list returns customers
  {
    const restore = mockHttps(200, { customers: [{ id: 5001, email: "alice@test.com" }, { id: 5002, email: "bob@test.com" }] });
    const r = await call({ operation: "customer_list" });
    assert(Array.isArray(r.customers) && r.customers.length === 2,
      "A13: customer_list returns customers");
    restore();
  }

  // A14: customer_get returns single customer
  {
    const restore = mockHttps(200, { customer: { id: 5001, first_name: "Alice", last_name: "Smith" } });
    const r = await call({ operation: "customer_get", id: 5001 });
    assert(r.customer && r.customer.first_name === "Alice",
      "A14: customer_get returns single customer");
    restore();
  }

  // A15: customer_create returns 201 body
  {
    const restore = mockHttps(201, { customer: { id: 5003, email: "charlie@test.com", first_name: "Charlie" } });
    const r = await call({ operation: "customer_create", customer: { email: "charlie@test.com", first_name: "Charlie" } });
    assert(r.customer && r.customer.id === 5003,
      "A15: customer_create returns 201 body");
    restore();
  }

  // A16: customer_update returns updated customer
  {
    const restore = mockHttps(200, { customer: { id: 5001, first_name: "Alicia" } });
    const r = await call({ operation: "customer_update", id: 5001, customer: { first_name: "Alicia" } });
    assert(r.customer && r.customer.first_name === "Alicia",
      "A16: customer_update returns updated customer");
    restore();
  }

  // A17: customer_search returns matching customers
  {
    const restore = mockHttps(200, { customers: [{ id: 5001, email: "alice@test.com" }] });
    const r = await call({ operation: "customer_search", query: "email:alice@test.com" });
    assert(Array.isArray(r.customers) && r.customers[0].email === "alice@test.com",
      "A17: customer_search returns matching customers");
    restore();
  }

  // A18: inventory_level_list returns levels
  {
    const restore = mockHttps(200, {
      inventory_levels: [{ inventory_item_id: 808950810, location_id: 905684977, available: 100 }]
    });
    const r = await call({ operation: "inventory_level_list", inventory_item_ids: [808950810] });
    assert(Array.isArray(r.inventory_levels) && r.inventory_levels[0].available === 100,
      "A18: inventory_level_list returns inventory levels");
    restore();
  }

  // A19: inventory_adjust returns adjusted level
  {
    const restore = mockHttps(200, {
      inventory_level: { inventory_item_id: 808950810, location_id: 905684977, available: 105 }
    });
    const r = await call({
      operation: "inventory_adjust",
      inventory_item_id: 808950810,
      location_id: 905684977,
      available_adjustment: 5,
    });
    assert(r.inventory_level && r.inventory_level.available === 105,
      "A19: inventory_adjust returns adjusted level");
    restore();
  }

  // A20: inventory_set returns set level
  {
    const restore = mockHttps(200, {
      inventory_level: { inventory_item_id: 808950810, location_id: 905684977, available: 50 }
    });
    const r = await call({
      operation: "inventory_set",
      inventory_item_id: 808950810,
      location_id: 905684977,
      available: 50,
    });
    assert(r.inventory_level && r.inventory_level.available === 50,
      "A20: inventory_set returns set level");
    restore();
  }

  // A21: variant_get returns variant
  {
    const restore = mockHttps(200, { variant: { id: 39072856, title: "Green", price: "14.00", sku: "GRN-001" } });
    const r = await call({ operation: "variant_get", id: 39072856 });
    assert(r.variant && r.variant.title === "Green" && r.variant.sku === "GRN-001",
      "A21: variant_get returns variant");
    restore();
  }

  // A22: variant_update returns updated variant
  {
    const restore = mockHttps(200, { variant: { id: 39072856, price: "19.99" } });
    const r = await call({ operation: "variant_update", id: 39072856, variant: { price: "19.99" } });
    assert(r.variant && r.variant.price === "19.99",
      "A22: variant_update returns updated variant");
    restore();
  }

  // A23: collection_list (custom) returns collections
  {
    const restore = mockHttps(200, { custom_collections: [{ id: 841564295, title: "Frontpage" }] });
    const r = await call({ operation: "collection_list" });
    assert(r.custom_collections && r.custom_collections[0].title === "Frontpage",
      "A23: collection_list returns custom collections");
    restore();
  }

  // A24: collection_list (smart) returns smart collections
  {
    const restore = mockHttps(200, { smart_collections: [{ id: 1063001488, title: "Macbooks" }] });
    const r = await call({ operation: "collection_list", collection_type: "smart" });
    assert(r.smart_collections && r.smart_collections[0].title === "Macbooks",
      "A24: collection_list smart returns smart collections");
    restore();
  }

  // A25: shop_get returns shop details
  {
    const restore = mockHttps(200, { shop: { id: 1, name: "My Test Store", currency: "USD", timezone: "Eastern Time (US & Canada)" } });
    const r = await call({ operation: "shop_get" });
    assert(r.shop && r.shop.currency === "USD" && r.shop.name === "My Test Store",
      "A25: shop_get returns shop details");
    restore();
  }

  // A26: location_list returns locations
  {
    const restore = mockHttps(200, { locations: [{ id: 905684977, name: "50 Elgin Street" }, { id: 487838322, name: "Ottawa Store" }] });
    const r = await call({ operation: "location_list" });
    assert(Array.isArray(r.locations) && r.locations.length === 2,
      "A26: location_list returns locations");
    restore();
  }

  // A27: generic GET request
  {
    const restore = mockHttps(200, { count: 99 });
    const r = await call({ operation: "request", method: "GET", path: "/products/count.json" });
    assert(r.count === 99, "A27: generic GET request returns body");
    restore();
  }

  // A28: generic POST request
  {
    const restore = mockHttps(200, { order: { id: 1001 } });
    const r = await call({ operation: "request", method: "POST", path: "/orders/1001/close.json", body: {} });
    assert(r.order && r.order.id === 1001, "A28: generic POST request returns body");
    restore();
  }

  // A29: shop subdomain strips .myshopify.com suffix
  {
    const restore = mockHttps(200, { shop: { id: 1, name: "Test" } });
    const r = await shopifyClient({ ...BASE, shop: "my-test-store.myshopify.com", operation: "shop_get" });
    assert(r.shop && r.shop.id === 1, "A29: shop with .myshopify.com suffix is handled");
    restore();
  }

  // A30: product_list with limit param
  {
    let capturedPath = null;
    const original = https.request;
    https.request = (opts, cb) => {
      capturedPath = opts.path;
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = {};
      process.nextTick(() => {
        cb(res);
        res.emit("data", Buffer.from(JSON.stringify({ products: [] })));
        res.emit("end");
      });
      const req = new EventEmitter(); req.write = () => {}; req.end = () => {}; req.destroy = () => {};
      return req;
    };
    await call({ operation: "product_list", limit: 10 });
    assert(capturedPath && capturedPath.includes("limit=10"),
      "A30: product_list sends limit as query param");
    https.request = original;
  }

  // A31: non-JSON response returned as {_raw}
  {
    const original = https.request;
    https.request = (_opts, cb) => {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = {};
      process.nextTick(() => {
        cb(res);
        res.emit("data", Buffer.from("<html>Shopify maintenance</html>"));
        res.emit("end");
      });
      const req = new EventEmitter(); req.write = () => {}; req.end = () => {}; req.destroy = () => {};
      return req;
    };
    const r = await call({ operation: "shop_get" });
    assert(r && r._raw && r._raw.includes("<html>"),
      "A31: non-JSON response returned as {_raw}");
    https.request = original;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// B — Validation (empty/invalid inputs)
// ════════════════════════════════════════════════════════════════════════════
console.log("\n[B] Validation tests");

async function testB() {
  // B1: missing operation throws
  await assertRejects(
    () => shopifyClient({ ...BASE }),
    /operation.*required|non-empty/i, "B1: missing operation throws"
  );

  // B2: missing shop throws
  await assertRejects(
    () => shopifyClient({ operation: "shop_get", access_token: "tok" }),
    /shop.*required|non-empty/i, "B2: missing shop throws"
  );

  // B3: missing auth throws
  await assertRejects(
    () => shopifyClient({ shop: "my-store", operation: "shop_get" }),
    /Auth required|access_token|api_key/i, "B3: missing auth throws"
  );

  // B4: unknown operation throws
  await assertRejects(
    () => call({ operation: "banana" }),
    /Unknown operation.*banana/i, "B4: unknown operation throws"
  );

  // B5: product_create missing product throws
  await assertRejects(
    () => call({ operation: "product_create" }),
    /product.*required/i, "B5: product_create missing product throws"
  );

  // B6: product_create product as array throws
  await assertRejects(
    () => call({ operation: "product_create", product: ["bad"] }),
    /product.*required/i, "B6: product_create product as array throws"
  );

  // B7: product_update missing product throws
  await assertRejects(
    () => call({ operation: "product_update", id: 123 }),
    /product.*required/i, "B7: product_update missing product throws"
  );

  // B8: product_get missing id throws
  await assertRejects(
    () => call({ operation: "product_get" }),
    /id.*required|non-empty/i, "B8: product_get missing id throws"
  );

  // B9: order_update missing order throws
  await assertRejects(
    () => call({ operation: "order_update", id: 1001 }),
    /order.*required/i, "B9: order_update missing order throws"
  );

  // B10: customer_create missing customer throws
  await assertRejects(
    () => call({ operation: "customer_create" }),
    /customer.*required/i, "B10: customer_create missing customer throws"
  );

  // B11: customer_update missing customer throws
  await assertRejects(
    () => call({ operation: "customer_update", id: 5001 }),
    /customer.*required/i, "B11: customer_update missing customer throws"
  );

  // B12: customer_search missing query throws
  await assertRejects(
    () => call({ operation: "customer_search" }),
    /query.*required|non-empty/i, "B12: customer_search missing query throws"
  );

  // B13: inventory_level_list missing ids throws
  await assertRejects(
    () => call({ operation: "inventory_level_list" }),
    /inventory_item_ids|location_ids/i, "B13: inventory_level_list missing ids throws"
  );

  // B14: inventory_adjust missing item id throws
  await assertRejects(
    () => call({ operation: "inventory_adjust", location_id: 1, available_adjustment: 5 }),
    /inventory_item_id.*required|non-empty/i, "B14: inventory_adjust missing inventory_item_id throws"
  );

  // B15: inventory_adjust missing available_adjustment throws
  await assertRejects(
    () => call({ operation: "inventory_adjust", inventory_item_id: 1, location_id: 1 }),
    /available_adjustment.*required/i, "B15: inventory_adjust missing available_adjustment throws"
  );

  // B16: inventory_set missing available throws
  await assertRejects(
    () => call({ operation: "inventory_set", inventory_item_id: 1, location_id: 1 }),
    /available.*required/i, "B16: inventory_set missing available throws"
  );

  // B17: variant_update missing variant throws
  await assertRejects(
    () => call({ operation: "variant_update", id: 39072856 }),
    /variant.*required/i, "B17: variant_update missing variant throws"
  );

  // B18: generic request unsupported method throws
  await assertRejects(
    () => call({ operation: "request", method: "TRACE", path: "/products.json" }),
    /Unsupported method|TRACE/i, "B18: generic request TRACE method throws"
  );

  // B19: generic request missing path throws
  await assertRejects(
    () => call({ operation: "request", method: "GET" }),
    /path.*required|non-empty/i, "B19: generic request missing path throws"
  );

  // B20: product_list with invalid limit throws
  await assertRejects(
    () => call({ operation: "product_list", limit: 999 }),
    /limit.*<= 250/i, "B20: product_list limit > 250 throws"
  );
}

// ════════════════════════════════════════════════════════════════════════════
// C — Mock network failures
// ════════════════════════════════════════════════════════════════════════════
console.log("\n[C] Mock-network tests");

async function testC() {
  // C1: network error propagates
  {
    const restore = mockHttpsError("ECONNREFUSED");
    await assertRejects(
      () => call({ operation: "shop_get" }),
      /ECONNREFUSED/i, "C1: network error propagates"
    );
    restore();
  }

  // C2: 401 Unauthorized throws
  {
    const restore = mockHttps(401, { errors: "Invalid API key or access token (unrecognized login or wrong password)." });
    await assertRejects(
      () => call({ operation: "shop_get" }),
      /Shopify API error 401/i, "C2: 401 Unauthorized throws"
    );
    restore();
  }

  // C3: 404 Not Found throws
  {
    const restore = mockHttps(404, { errors: "Not Found" });
    await assertRejects(
      () => call({ operation: "product_get", id: 99999 }),
      /Shopify API error 404/i, "C3: 404 Not Found throws"
    );
    restore();
  }

  // C4: 422 Unprocessable Entity throws
  {
    const restore = mockHttps(422, { errors: { title: ["can't be blank"] } });
    await assertRejects(
      () => call({ operation: "product_create", product: {} }),
      /Shopify API error 422/i, "C4: 422 Unprocessable Entity throws"
    );
    restore();
  }

  // C5: 429 Rate Limit throws
  {
    const restore = mockHttps(429, { errors: "Exceeded 2 calls per second for api client." });
    await assertRejects(
      () => call({ operation: "product_list" }),
      /Shopify API error 429/i, "C5: 429 Rate Limit throws"
    );
    restore();
  }

  // C6: 503 Service Unavailable throws
  {
    const restore = mockHttps(503, { errors: "Service Unavailable" });
    await assertRejects(
      () => call({ operation: "shop_get" }),
      /Shopify API error 503/i, "C6: 503 Service Unavailable throws"
    );
    restore();
  }

  // C7: request times out
  {
    const original = https.request;
    https.request = (_opts, _cb) => {
      const req = new EventEmitter();
      req.write   = () => {};
      req.end     = () => {};
      req.destroy = () => req.emit("error", new Error("socket hang up"));
      return req;
    };
    await assertRejects(
      () => call({ operation: "shop_get", timeout: 50 }),
      /timed out|hang up/i, "C7: request times out"
    );
    https.request = original;
  }

  // C8: X-Shopify-Access-Token header sent correctly
  {
    let capturedHeaders = null;
    const original = https.request;
    https.request = (opts, cb) => {
      capturedHeaders = opts.headers;
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = {};
      process.nextTick(() => {
        cb(res);
        res.emit("data", Buffer.from(JSON.stringify({ shop: { id: 1 } })));
        res.emit("end");
      });
      const req = new EventEmitter(); req.write = () => {}; req.end = () => {}; req.destroy = () => {};
      return req;
    };
    await call({ operation: "shop_get" });
    assert(capturedHeaders && capturedHeaders["X-Shopify-Access-Token"] === "shpat_FAKE_TOKEN_123456789",
      "C8: X-Shopify-Access-Token header sent correctly");
    https.request = original;
  }

  // C9: api_key+api_password sends Basic auth header
  {
    let capturedHeaders = null;
    const original = https.request;
    https.request = (opts, cb) => {
      capturedHeaders = opts.headers;
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = {};
      process.nextTick(() => {
        cb(res);
        res.emit("data", Buffer.from(JSON.stringify({ shop: { id: 1 } })));
        res.emit("end");
      });
      const req = new EventEmitter(); req.write = () => {}; req.end = () => {}; req.destroy = () => {};
      return req;
    };
    await shopifyClient({ shop: "test-store", api_key: "MYKEY", api_password: "MYPWD", operation: "shop_get" });
    const expectedB64 = Buffer.from("MYKEY:MYPWD").toString("base64");
    assert(capturedHeaders && capturedHeaders["Authorization"] === `Basic ${expectedB64}`,
      "C9: api_key+api_password sends Basic auth header");
    https.request = original;
  }

  // C10: product_create sends JSON body with "product" wrapper
  {
    let capturedBody = null;
    const original = https.request;
    https.request = (_opts, cb) => {
      const res = new EventEmitter();
      res.statusCode = 201;
      res.headers = {};
      process.nextTick(() => {
        cb(res);
        res.emit("data", Buffer.from(JSON.stringify({ product: { id: 1, title: "Tester" } })));
        res.emit("end");
      });
      const req = new EventEmitter();
      req.write = (b) => { capturedBody = b; };
      req.end   = () => {}; req.destroy = () => {};
      return req;
    };
    await call({ operation: "product_create", product: { title: "Tester" } });
    const parsed = JSON.parse(capturedBody);
    assert(parsed.product && parsed.product.title === "Tester",
      "C10: product_create sends body wrapped in {product}");
    https.request = original;
  }

  // C11: correct hostname used (shop.myshopify.com)
  {
    let capturedHostname = null;
    const original = https.request;
    https.request = (opts, cb) => {
      capturedHostname = opts.hostname;
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = {};
      process.nextTick(() => {
        cb(res);
        res.emit("data", Buffer.from(JSON.stringify({ shop: { id: 1 } })));
        res.emit("end");
      });
      const req = new EventEmitter(); req.write = () => {}; req.end = () => {}; req.destroy = () => {};
      return req;
    };
    await call({ operation: "shop_get" });
    assert(capturedHostname === "my-test-store.myshopify.com",
      "C11: correct hostname (shop.myshopify.com) used");
    https.request = original;
  }

  // C12: correct path prefix includes api version
  {
    let capturedPath = null;
    const original = https.request;
    https.request = (opts, cb) => {
      capturedPath = opts.path;
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = {};
      process.nextTick(() => {
        cb(res);
        res.emit("data", Buffer.from(JSON.stringify({ shop: { id: 1 } })));
        res.emit("end");
      });
      const req = new EventEmitter(); req.write = () => {}; req.end = () => {}; req.destroy = () => {};
      return req;
    };
    await call({ operation: "shop_get" });
    assert(capturedPath && capturedPath.includes("/admin/api/2024-01/shop.json"),
      "C12: path includes /admin/api/{version}/");
    https.request = original;
  }

  // C13: custom api_version used
  {
    let capturedPath = null;
    const original = https.request;
    https.request = (opts, cb) => {
      capturedPath = opts.path;
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = {};
      process.nextTick(() => {
        cb(res);
        res.emit("data", Buffer.from(JSON.stringify({ shop: { id: 1 } })));
        res.emit("end");
      });
      const req = new EventEmitter(); req.write = () => {}; req.end = () => {}; req.destroy = () => {};
      return req;
    };
    await call({ operation: "shop_get", api_version: "2023-10" });
    assert(capturedPath && capturedPath.includes("/admin/api/2023-10/"),
      "C13: custom api_version used in path");
    https.request = original;
  }

  // C14: response body exceeds 16 MB cap
  {
    const original = https.request;
    https.request = (_opts, cb) => {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = {};
      process.nextTick(() => {
        cb(res);
        res.emit("data", Buffer.alloc(17 * 1024 * 1024, 0x41));
        res.emit("end");
      });
      const req = new EventEmitter(); req.write = () => {}; req.end = () => {}; req.destroy = () => {};
      return req;
    };
    await assertRejects(
      () => call({ operation: "shop_get" }),
      /16 MB|exceeds/i, "C14: 17 MB response exceeds 16 MB cap"
    );
    https.request = original;
  }

  // C15: inventory_adjust sends correct JSON body
  {
    let capturedBody = null;
    const original = https.request;
    https.request = (_opts, cb) => {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = {};
      process.nextTick(() => {
        cb(res);
        res.emit("data", Buffer.from(JSON.stringify({ inventory_level: { available: 15 } })));
        res.emit("end");
      });
      const req = new EventEmitter();
      req.write = (b) => { capturedBody = b; }; req.end = () => {}; req.destroy = () => {};
      return req;
    };
    await call({
      operation: "inventory_adjust",
      inventory_item_id: 808950810,
      location_id: 905684977,
      available_adjustment: -5,
    });
    const parsed = JSON.parse(capturedBody);
    assert(parsed.available_adjustment === -5 && parsed.inventory_item_id === 808950810,
      "C15: inventory_adjust sends correct body");
    https.request = original;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// D — Security tests
// ════════════════════════════════════════════════════════════════════════════
console.log("\n[D] Security tests");

async function testD() {
  // D1: NUL byte in operation throws
  await assertRejects(
    () => call({ operation: "shop_get\x00inject" }),
    /NUL|operation/i, "D1: NUL byte in operation is rejected"
  );

  // D2: NUL byte in shop throws
  await assertRejects(
    () => shopifyClient({ shop: "my\x00store", access_token: "tok", operation: "shop_get" }),
    /NUL|shop/i, "D2: NUL byte in shop is rejected"
  );

  // D3: NUL byte in access_token throws
  await assertRejects(
    () => shopifyClient({ shop: "my-store", access_token: "tok\x00en", operation: "shop_get" }),
    /NUL|access_token/i, "D3: NUL byte in access_token is rejected"
  );

  // D4: NUL byte in product id throws
  await assertRejects(
    () => call({ operation: "product_get", id: "123\x00abc" }),
    /NUL|id/i, "D4: NUL byte in product id is rejected"
  );

  // D5: access_token scrubbed from API error messages
  {
    const canaryToken = "shpat_CANARY_SECRET_DO_NOT_LEAK_abc123";
    const restore = mockHttps(401, { errors: `Invalid token: ${canaryToken}` });
    try {
      await shopifyClient({ shop: "test-store", access_token: canaryToken, operation: "shop_get" });
      assert(false, "D5: should have thrown");
    } catch (e) {
      assert(!e.message.includes(canaryToken), "D5: access_token scrubbed from API error");
    }
    restore();
  }

  // D6: api_password scrubbed from API error messages
  {
    const canaryPwd = "CANARY_PWD_DO_NOT_LEAK_xyzxyzxyz";
    const original = https.request;
    https.request = (_opts, cb) => {
      const res = new EventEmitter();
      res.statusCode = 401;
      res.headers = {};
      process.nextTick(() => {
        cb(res);
        res.emit("data", Buffer.from(JSON.stringify({ errors: `Bad password: ${canaryPwd}` })));
        res.emit("end");
      });
      const req = new EventEmitter(); req.write = () => {}; req.end = () => {}; req.destroy = () => {};
      return req;
    };
    try {
      await shopifyClient({ shop: "test-store", api_key: "key", api_password: canaryPwd, operation: "shop_get" });
      assert(false, "D6: should have thrown");
    } catch (e) {
      assert(!e.message.includes(canaryPwd), "D6: api_password scrubbed from API error");
    }
    https.request = original;
  }

  // D7: reject_unauthorized defaults to true
  {
    let capturedOpts = null;
    const original = https.request;
    https.request = (opts, cb) => {
      capturedOpts = opts;
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = {};
      process.nextTick(() => {
        cb(res);
        res.emit("data", Buffer.from(JSON.stringify({ shop: { id: 1 } })));
        res.emit("end");
      });
      const req = new EventEmitter(); req.write = () => {}; req.end = () => {}; req.destroy = () => {};
      return req;
    };
    await call({ operation: "shop_get" });
    assert(capturedOpts && capturedOpts.rejectUnauthorized === true,
      "D7: rejectUnauthorized defaults to true");
    https.request = original;
  }

  // D8: reject_unauthorized:false forwarded
  {
    let capturedOpts = null;
    const original = https.request;
    https.request = (opts, cb) => {
      capturedOpts = opts;
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = {};
      process.nextTick(() => {
        cb(res);
        res.emit("data", Buffer.from(JSON.stringify({ shop: { id: 1 } })));
        res.emit("end");
      });
      const req = new EventEmitter(); req.write = () => {}; req.end = () => {}; req.destroy = () => {};
      return req;
    };
    await call({ operation: "shop_get", reject_unauthorized: false });
    assert(capturedOpts && capturedOpts.rejectUnauthorized === false,
      "D8: rejectUnauthorized:false forwarded");
    https.request = original;
  }

  // D9: huge timeout clamped, request still works
  {
    const restore = mockHttps(200, { shop: { id: 1, name: "Test" } });
    const r = await call({ operation: "shop_get", timeout: 9_999_999 });
    assert(r && r.shop, "D9: huge timeout clamped, request still works");
    restore();
  }

  // D10: NUL byte in query string throws
  await assertRejects(
    () => call({ operation: "customer_search", query: "email:test\x00@evil.com" }),
    /NUL|query/i, "D10: NUL byte in customer query is rejected"
  );

  // D11: access_token not leaked in returned response body
  {
    const restore = mockHttps(200, { shop: { id: 1, name: "My Store" } });
    const r = await call({ operation: "shop_get" });
    assert(!JSON.stringify(r).includes("shpat_FAKE_TOKEN_123456789"),
      "D11: access_token not leaked in response body");
    restore();
  }

  // D12: NUL byte in order id throws
  await assertRejects(
    () => call({ operation: "order_get", id: "1001\x00inject" }),
    /NUL|id/i, "D12: NUL byte in order id is rejected"
  );

  // D13: api_key scrubbed from error messages
  {
    const canaryKey = "CANARY_API_KEY_DO_NOT_LEAK_abcdef";
    const original = https.request;
    https.request = (_opts, cb) => {
      const res = new EventEmitter();
      res.statusCode = 403;
      res.headers = {};
      process.nextTick(() => {
        cb(res);
        res.emit("data", Buffer.from(JSON.stringify({ errors: `Key ${canaryKey} is forbidden` })));
        res.emit("end");
      });
      const req = new EventEmitter(); req.write = () => {}; req.end = () => {}; req.destroy = () => {};
      return req;
    };
    try {
      await shopifyClient({ shop: "test-store", api_key: canaryKey, api_password: "pwd", operation: "shop_get" });
      assert(false, "D13: should have thrown");
    } catch (e) {
      assert(!e.message.includes(canaryKey), "D13: api_key scrubbed from API error");
    }
    https.request = original;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// E — Concurrency / stress
// ════════════════════════════════════════════════════════════════════════════
console.log("\n[E] Concurrency tests");

async function testE() {
  // E1: 20 concurrent shop_get calls all succeed
  {
    const restore = mockHttps(200, { shop: { id: 1, name: "Test Store", currency: "USD" } });
    const tasks = Array.from({ length: 20 }, () => call({ operation: "shop_get" }));
    const results = await Promise.all(tasks);
    assert(results.length === 20 && results.every(r => r.shop && r.shop.currency === "USD"),
      "E1: 20 concurrent shop_get calls all succeed");
    restore();
  }

  // E2: 10 concurrent product_list calls
  {
    const restore = mockHttps(200, { products: [{ id: 1, title: "Widget" }] });
    const tasks = Array.from({ length: 10 }, () => call({ operation: "product_list" }));
    const results = await Promise.all(tasks);
    assert(results.length === 10 && results.every(r => Array.isArray(r.products)),
      "E2: 10 concurrent product_list calls all succeed");
    restore();
  }

  // E3: mix of success and validation errors in parallel
  {
    const restore = mockHttps(200, { shop: { id: 1 } });
    const tasks = [
      call({ operation: "shop_get" }),
      call({ operation: "product_create" }).catch(e => e),        // missing product
      call({ operation: "shop_get" }),
    ];
    const [r1, r2, r3] = await Promise.all(tasks);
    assert(r1.shop && r2 instanceof Error && r3.shop,
      "E3: mix of success + validation errors handled correctly");
    restore();
  }

  // E4: 15 rapid calls don't leak state
  {
    let callCount = 0;
    const original = https.request;
    https.request = (_opts, cb) => {
      callCount++;
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = {};
      process.nextTick(() => {
        cb(res);
        res.emit("data", Buffer.from(JSON.stringify({ shop: { id: callCount } })));
        res.emit("end");
      });
      const req = new EventEmitter(); req.write = () => {}; req.end = () => {}; req.destroy = () => {};
      return req;
    };
    const tasks = Array.from({ length: 15 }, () => call({ operation: "shop_get" }));
    const results = await Promise.all(tasks);
    assert(callCount === 15 && results.length === 15,
      "E4: 15 rapid calls, no state leakage");
    https.request = original;
  }

  // E5: concurrent network errors all propagate independently
  {
    const restore = mockHttpsError("ECONNRESET");
    const tasks = Array.from({ length: 8 }, () => call({ operation: "shop_get" }).catch(e => e));
    const results = await Promise.all(tasks);
    assert(results.length === 8 && results.every(e => e instanceof Error && /ECONNRESET/i.test(e.message)),
      "E5: 8 concurrent network errors all propagate independently");
    restore();
  }

  // E6: 5 concurrent different operations succeed
  {
    const restore = mockHttps(200, {
      shop: { id: 1 },
      products: [],
      orders: [],
      customers: [],
      locations: [],
    });
    const tasks = [
      call({ operation: "shop_get" }),
      call({ operation: "product_list" }),
      call({ operation: "order_list" }),
      call({ operation: "customer_list" }),
      call({ operation: "location_list" }),
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

  // E8: concurrent calls with different tokens get correct auth headers
  {
    const token1 = "shpat_TOKEN1_aaaaaaaaaaaaaaaaaaaaaaaaa";
    const token2 = "shpat_TOKEN2_bbbbbbbbbbbbbbbbbbbbbbbbb";
    const tokens = [];
    const original = https.request;
    https.request = (opts, cb) => {
      tokens.push(opts.headers["X-Shopify-Access-Token"]);
      const res = new EventEmitter();
      res.statusCode = 200;
      res.headers = {};
      process.nextTick(() => {
        cb(res);
        res.emit("data", Buffer.from(JSON.stringify({ shop: { id: 1 } })));
        res.emit("end");
      });
      const req = new EventEmitter(); req.write = () => {}; req.end = () => {}; req.destroy = () => {};
      return req;
    };
    await Promise.all([
      shopifyClient({ shop: "store1", access_token: token1, operation: "shop_get" }),
      shopifyClient({ shop: "store2", access_token: token2, operation: "shop_get" }),
    ]);
    assert(
      tokens.some(t => t === token1) && tokens.some(t => t === token2),
      "E8: concurrent calls with different tokens send correct individual auth headers"
    );
    https.request = original;
  }

  // E9: 30 concurrent product_creates all succeed
  {
    const restore = mockHttps(201, { product: { id: 1, title: "Widget", status: "active" } });
    const tasks = Array.from({ length: 30 }, (_, i) =>
      call({ operation: "product_create", product: { title: `Product ${i}` } })
    );
    const results = await Promise.all(tasks);
    assert(results.length === 30 && results.every(r => r.product && r.product.status === "active"),
      "E9: 30 concurrent product_creates all succeed");
    restore();
  }

  // E10: 10 concurrent: 5 success + 5 auth failures handled correctly
  {
    let toggle = 0;
    const original = https.request;
    https.request = (_opts, cb) => {
      const mine = toggle++;
      const statusCode = mine % 2 === 0 ? 200 : 401;
      const body = mine % 2 === 0
        ? { shop: { id: 1 } }
        : { errors: "Invalid API key." };
      const res = new EventEmitter();
      res.statusCode = statusCode;
      res.headers = {};
      process.nextTick(() => {
        cb(res);
        res.emit("data", Buffer.from(JSON.stringify(body)));
        res.emit("end");
      });
      const req = new EventEmitter(); req.write = () => {}; req.end = () => {}; req.destroy = () => {};
      return req;
    };
    const tasks = Array.from({ length: 10 }, () =>
      call({ operation: "shop_get" }).catch(e => ({ error: e.message }))
    );
    const results = await Promise.all(tasks);
    const successes = results.filter(r => r.shop).length;
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
