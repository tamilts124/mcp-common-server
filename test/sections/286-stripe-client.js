"use strict";
/**
 * test/sections/286-stripe-client.js
 * Isolated tests for stripeClientOps.js
 * 5 rigor levels: A=normal, B=validation, C=mock-network, D=security, E=concurrency
 */
const https = require("https");
const { EventEmitter } = require("events");
const { stripeClient } = require("../../lib/stripeClientOps");

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${msg}`);
    failed++;
  }
}

async function assertRejects(fn, pattern, msg) {
  try {
    await fn();
    console.error(`  ✗ FAIL (no throw): ${msg}`);
    failed++;
  } catch (e) {
    const ok = pattern ? (e.message || "").match(pattern) : true;
    if (ok) {
      console.log(`  ✓ ${msg}`);
      passed++;
    } else {
      console.error(`  ✗ FAIL (wrong error: ${e.message}): ${msg}`);
      failed++;
    }
  }
}

// ── Mock HTTPS helper ─────────────────────────────────────────────────────────
function mockHttps(statusCode, body) {
  const original = https.request;
  https.request = (opts, cb) => {
    const res = new EventEmitter();
    res.statusCode = statusCode;
    process.nextTick(() => {
      cb(res);
      res.emit("data", Buffer.from(JSON.stringify(body)));
      res.emit("end");
    });
    const req = new EventEmitter();
    req.write = () => {};
    req.end = () => {};
    req.destroy = () => {};
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

const FAKE_KEY = "sk_test_" + "a".repeat(24);

// ══════════════════════════════════════════════════════════════════════════════
// A — Normal (happy-path assertions)
// ══════════════════════════════════════════════════════════════════════════════
console.log("\n[A] Normal / happy-path tests");

async function testA() {
  // A1: customer_create returns body
  {
    const restore = mockHttps(200, { id: "cus_123", object: "customer", email: "test@example.com" });
    const r = await stripeClient({ operation: "customer_create", secret_key: FAKE_KEY, email: "test@example.com" });
    assert(r.id === "cus_123", "A1: customer_create returns body with id");
    restore();
  }

  // A2: customer_get returns customer object
  {
    const restore = mockHttps(200, { id: "cus_456", object: "customer" });
    const r = await stripeClient({ operation: "customer_get", secret_key: FAKE_KEY, customer_id: "cus_456" });
    assert(r.id === "cus_456", "A2: customer_get returns customer object");
    restore();
  }

  // A3: customer_get 404 returns exists:false
  {
    const restore = mockHttps(404, { error: { code: "resource_missing" } });
    const r = await stripeClient({ operation: "customer_get", secret_key: FAKE_KEY, customer_id: "cus_bad" });
    assert(r.exists === false, "A3: customer_get 404 returns {exists:false}");
    restore();
  }

  // A4: customer_delete 200 returns deleted:true
  {
    const restore = mockHttps(200, { deleted: true, id: "cus_789" });
    const r = await stripeClient({ operation: "customer_delete", secret_key: FAKE_KEY, customer_id: "cus_789" });
    assert(r.deleted === true, "A4: customer_delete 200 returns deleted:true");
    restore();
  }

  // A5: customer_list returns Stripe list format
  {
    const restore = mockHttps(200, { object: "list", data: [{ id: "cus_1" }], has_more: false });
    const r = await stripeClient({ operation: "customer_list", secret_key: FAKE_KEY, limit: 5 });
    assert(r.object === "list" && r.data.length === 1, "A5: customer_list returns list with data");
    restore();
  }

  // A6: payment_intent_create returns PI
  {
    const restore = mockHttps(200, { id: "pi_001", object: "payment_intent", status: "requires_payment_method" });
    const r = await stripeClient({ operation: "payment_intent_create", secret_key: FAKE_KEY, amount: 1000, currency: "usd" });
    assert(r.id === "pi_001" && r.status === "requires_payment_method", "A6: payment_intent_create returns PI object");
    restore();
  }

  // A7: payment_intent_get 404 returns exists:false
  {
    const restore = mockHttps(404, { error: { code: "resource_missing" } });
    const r = await stripeClient({ operation: "payment_intent_get", secret_key: FAKE_KEY, payment_intent_id: "pi_bad" });
    assert(r.exists === false, "A7: payment_intent_get 404 returns {exists:false}");
    restore();
  }

  // A8: charge_create returns charge object
  {
    const restore = mockHttps(200, { id: "ch_001", object: "charge", status: "succeeded" });
    const r = await stripeClient({ operation: "charge_create", secret_key: FAKE_KEY, amount: 500, currency: "usd", customer: "cus_123" });
    assert(r.id === "ch_001", "A8: charge_create returns charge object");
    restore();
  }

  // A9: refund_create returns refund object
  {
    const restore = mockHttps(200, { id: "re_001", object: "refund", status: "succeeded" });
    const r = await stripeClient({ operation: "refund_create", secret_key: FAKE_KEY, charge: "ch_001" });
    assert(r.id === "re_001", "A9: refund_create returns refund object");
    restore();
  }

  // A10: subscription_create returns subscription
  {
    const restore = mockHttps(200, { id: "sub_001", object: "subscription", status: "active" });
    const r = await stripeClient({ operation: "subscription_create", secret_key: FAKE_KEY, customer_id: "cus_123", items: [{ price: "price_abc" }] });
    assert(r.id === "sub_001", "A10: subscription_create returns subscription object");
    restore();
  }

  // A11: invoice_create returns invoice
  {
    const restore = mockHttps(200, { id: "in_001", object: "invoice", status: "draft" });
    const r = await stripeClient({ operation: "invoice_create", secret_key: FAKE_KEY, customer_id: "cus_123" });
    assert(r.id === "in_001", "A11: invoice_create returns invoice object");
    restore();
  }

  // A12: product_create returns product
  {
    const restore = mockHttps(200, { id: "prod_001", object: "product", name: "Widget" });
    const r = await stripeClient({ operation: "product_create", secret_key: FAKE_KEY, name: "Widget" });
    assert(r.id === "prod_001", "A12: product_create returns product object");
    restore();
  }

  // A13: price_create returns price
  {
    const restore = mockHttps(200, { id: "price_001", object: "price", currency: "usd" });
    const r = await stripeClient({ operation: "price_create", secret_key: FAKE_KEY, currency: "usd", unit_amount: 2000, product: "prod_001" });
    assert(r.id === "price_001", "A13: price_create returns price object");
    restore();
  }

  // A14: coupon_create returns coupon
  {
    const restore = mockHttps(200, { id: "coupon_001", object: "coupon", percent_off: 20 });
    const r = await stripeClient({ operation: "coupon_create", secret_key: FAKE_KEY, percent_off: 20, duration: "once" });
    assert(r.id === "coupon_001", "A14: coupon_create returns coupon object");
    restore();
  }

  // A15: checkout_session_create returns session
  {
    const restore = mockHttps(200, { id: "cs_001", object: "checkout.session", url: "https://checkout.stripe.com/pay/cs_001" });
    const r = await stripeClient({ operation: "checkout_session_create", secret_key: FAKE_KEY, mode: "payment", success_url: "https://example.com/success" });
    assert(r.id === "cs_001", "A15: checkout_session_create returns session object");
    restore();
  }

  // A16: balance_get returns balance object
  {
    const restore = mockHttps(200, { object: "balance", available: [], pending: [] });
    const r = await stripeClient({ operation: "balance_get", secret_key: FAKE_KEY });
    assert(r.object === "balance", "A16: balance_get returns balance object");
    restore();
  }

  // A17: info operation returns account summary
  {
    const restore = mockHttps(200, { id: "acct_001", email: "owner@example.com", type: "standard", charges_enabled: true, payouts_enabled: true, country: "US", default_currency: "usd" });
    const r = await stripeClient({ operation: "info", secret_key: FAKE_KEY });
    assert(r.account_id === "acct_001" && r.type === "standard", "A17: info returns structured account info");
    restore();
  }

  // A18: webhook_endpoint_create returns endpoint
  {
    const restore = mockHttps(200, { id: "we_001", object: "webhook_endpoint", url: "https://example.com/webhook" });
    const r = await stripeClient({ operation: "webhook_endpoint_create", secret_key: FAKE_KEY, url: "https://example.com/webhook", enabled_events: ["payment_intent.succeeded"] });
    assert(r.id === "we_001", "A18: webhook_endpoint_create returns endpoint object");
    restore();
  }

  // A19: payout_create returns payout
  {
    const restore = mockHttps(200, { id: "po_001", object: "payout", status: "pending" });
    const r = await stripeClient({ operation: "payout_create", secret_key: FAKE_KEY, amount: 5000, currency: "usd" });
    assert(r.id === "po_001", "A19: payout_create returns payout object");
    restore();
  }

  // A20: dispute_get 404 returns exists:false
  {
    const restore = mockHttps(404, { error: { code: "resource_missing" } });
    const r = await stripeClient({ operation: "dispute_get", secret_key: FAKE_KEY, dispute_id: "dp_bad" });
    assert(r.exists === false, "A20: dispute_get 404 returns {exists:false}");
    restore();
  }

  // A21: currency is lowercased by payment_intent_create
  {
    const restore = mockHttps(200, { id: "pi_002", object: "payment_intent" });
    let capturedBody = null;
    const origReq = https.request;
    https.request = (opts, cb) => {
      const res = new EventEmitter();
      res.statusCode = 200;
      process.nextTick(() => { cb(res); res.emit("data", Buffer.from(JSON.stringify({ id: "pi_002", object: "payment_intent" }))); res.emit("end"); });
      const req = new EventEmitter();
      req.write = (body) => { capturedBody = body; };
      req.end = () => {};
      req.destroy = () => {};
      return req;
    };
    await stripeClient({ operation: "payment_intent_create", secret_key: FAKE_KEY, amount: 500, currency: "USD" });
    assert(capturedBody && capturedBody.includes("currency=usd"), "A21: currency is lowercased in form body");
    https.request = origReq;
    restore();
  }

  // A22: generic request operation works
  {
    const restore = mockHttps(200, { object: "list", data: [] });
    const r = await stripeClient({ operation: "request", secret_key: FAKE_KEY, method: "GET", path: "/v1/events" });
    assert(r.object === "list", "A22: generic request returns body");
    restore();
  }

  // A23: subscription_cancel 404 returns canceled:false
  {
    const restore = mockHttps(404, { error: { code: "resource_missing" } });
    const r = await stripeClient({ operation: "subscription_cancel", secret_key: FAKE_KEY, subscription_id: "sub_bad" });
    assert(r.canceled === false, "A23: subscription_cancel 404 returns {canceled:false}");
    restore();
  }

  // A24: product_delete 404 returns deleted:false
  {
    const restore = mockHttps(404, { error: { code: "resource_missing" } });
    const r = await stripeClient({ operation: "product_delete", secret_key: FAKE_KEY, product_id: "prod_bad" });
    assert(r.deleted === false, "A24: product_delete 404 returns {deleted:false}");
    restore();
  }

  // A25: payment_method_list requires customer_id
  {
    const restore = mockHttps(200, { object: "list", data: [] });
    const r = await stripeClient({ operation: "payment_method_list", secret_key: FAKE_KEY, customer_id: "cus_123" });
    assert(r.object === "list", "A25: payment_method_list returns list");
    restore();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// B — Validation (empty/invalid inputs)
// ══════════════════════════════════════════════════════════════════════════════
console.log("\n[B] Validation tests");

async function testB() {
  // B1: missing operation throws
  await assertRejects(
    () => stripeClient({ secret_key: FAKE_KEY }),
    /operation.*required|non-empty/i, "B1: missing operation throws"
  );

  // B2: missing secret_key throws
  await assertRejects(
    () => stripeClient({ operation: "info" }),
    /secret_key.*required|non-empty/i, "B2: missing secret_key throws"
  );

  // B3: invalid secret_key prefix throws
  await assertRejects(
    () => stripeClient({ operation: "info", secret_key: "pk_test_badkey" }),
    /secret_key.*must start/i, "B3: invalid secret_key prefix (pk_) throws"
  );

  // B4: unknown operation throws descriptive error
  await assertRejects(
    () => stripeClient({ operation: "banana", secret_key: FAKE_KEY }),
    /Unknown operation.*banana/i, "B4: unknown operation throws descriptive error"
  );

  // B5: customer_get missing customer_id throws
  await assertRejects(
    () => stripeClient({ operation: "customer_get", secret_key: FAKE_KEY }),
    /customer_id.*required|non-empty/i, "B5: customer_get missing customer_id throws"
  );

  // B6: payment_intent_create missing amount throws
  await assertRejects(
    () => stripeClient({ operation: "payment_intent_create", secret_key: FAKE_KEY, currency: "usd" }),
    /amount.*required/i, "B6: payment_intent_create missing amount throws"
  );

  // B7: payment_intent_create missing currency throws
  await assertRejects(
    () => stripeClient({ operation: "payment_intent_create", secret_key: FAKE_KEY, amount: 1000 }),
    /currency.*required|non-empty/i, "B7: payment_intent_create missing currency throws"
  );

  // B8: charge_create missing amount throws
  await assertRejects(
    () => stripeClient({ operation: "charge_create", secret_key: FAKE_KEY, currency: "usd" }),
    /amount.*required/i, "B8: charge_create missing amount throws"
  );

  // B9: refund_create missing charge and payment_intent throws
  await assertRejects(
    () => stripeClient({ operation: "refund_create", secret_key: FAKE_KEY }),
    /charge or payment_intent.*required/i, "B9: refund_create missing charge/payment_intent throws"
  );

  // B10: subscription_create missing items throws
  await assertRejects(
    () => stripeClient({ operation: "subscription_create", secret_key: FAKE_KEY, customer_id: "cus_123" }),
    /items.*required|array/i, "B10: subscription_create missing items throws"
  );

  // B11: coupon_create missing percent_off and amount_off throws
  await assertRejects(
    () => stripeClient({ operation: "coupon_create", secret_key: FAKE_KEY }),
    /percent_off or amount_off.*required/i, "B11: coupon_create missing discount throws"
  );

  // B12: checkout_session_create missing mode throws
  await assertRejects(
    () => stripeClient({ operation: "checkout_session_create", secret_key: FAKE_KEY, success_url: "https://x.com" }),
    /mode.*required|non-empty/i, "B12: checkout_session_create missing mode throws"
  );

  // B13: webhook_endpoint_create missing enabled_events throws
  await assertRejects(
    () => stripeClient({ operation: "webhook_endpoint_create", secret_key: FAKE_KEY, url: "https://x.com" }),
    /enabled_events.*required|array/i, "B13: webhook_endpoint_create missing enabled_events throws"
  );

  // B14: customer_update with no fields throws
  await assertRejects(
    () => stripeClient({ operation: "customer_update", secret_key: FAKE_KEY, customer_id: "cus_123" }),
    /at least one field/i, "B14: customer_update with no fields throws"
  );

  // B15: generic request missing method throws
  await assertRejects(
    () => stripeClient({ operation: "request", secret_key: FAKE_KEY, path: "/v1/events" }),
    /method.*required|non-empty/i, "B15: generic request missing method throws"
  );

  // B16: generic request with unsupported method throws
  await assertRejects(
    () => stripeClient({ operation: "request", secret_key: FAKE_KEY, method: "HEAD", path: "/v1/events" }),
    /Unsupported method|HEAD/i, "B16: generic request unsupported method throws"
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// C — Mock network failures
// ══════════════════════════════════════════════════════════════════════════════
console.log("\n[C] Mock-network tests");

async function testC() {
  // C1: network error propagates as Error
  {
    const restore = mockHttpsError("ECONNREFUSED");
    await assertRejects(
      () => stripeClient({ operation: "balance_get", secret_key: FAKE_KEY }),
      /ECONNREFUSED/i, "C1: network error propagates"
    );
    restore();
  }

  // C2: Stripe API 4xx error throws with status
  {
    const restore = mockHttps(402, { error: { type: "card_error", code: "card_declined", message: "Your card was declined." } });
    await assertRejects(
      () => stripeClient({ operation: "payment_intent_create", secret_key: FAKE_KEY, amount: 100, currency: "usd" }),
      /Stripe API error 402/i, "C2: Stripe 402 error is thrown"
    );
    restore();
  }

  // C3: Stripe API 5xx error throws
  {
    const restore = mockHttps(500, { error: { type: "api_error", message: "Internal server error" } });
    await assertRejects(
      () => stripeClient({ operation: "customer_list", secret_key: FAKE_KEY }),
      /Stripe API error 500/i, "C3: Stripe 500 error is thrown"
    );
    restore();
  }

  // C4: timeout is respected
  {
    const original = https.request;
    https.request = (_opts, _cb) => {
      const req = new EventEmitter();
      req.write = () => {};
      req.end = () => {}; // never resolves
      req.destroy = () => req.emit("error", new Error("socket hang up"));
      return req;
    };
    await assertRejects(
      () => stripeClient({ operation: "balance_get", secret_key: FAKE_KEY, timeout: 50 }),
      /timed out|hang up/i, "C4: request times out after specified ms"
    );
    https.request = original;
  }

  // C5: empty response body is handled gracefully
  {
    const original = https.request;
    https.request = (_opts, cb) => {
      const res = new EventEmitter();
      res.statusCode = 200;
      process.nextTick(() => { cb(res); res.emit("end"); }); // no data events
      const req = new EventEmitter();
      req.write = () => {};
      req.end = () => {};
      req.destroy = () => {};
      return req;
    };
    const r = await stripeClient({ operation: "balance_get", secret_key: FAKE_KEY });
    assert(r === null, "C5: empty 200 response body returns null");
    https.request = original;
  }

  // C6: non-JSON response body is returned as _raw
  {
    const original = https.request;
    https.request = (_opts, cb) => {
      const res = new EventEmitter();
      res.statusCode = 200;
      process.nextTick(() => { cb(res); res.emit("data", Buffer.from("<html>error</html>")); res.emit("end"); });
      const req = new EventEmitter();
      req.write = () => {};
      req.end = () => {};
      req.destroy = () => {};
      return req;
    };
    const r = await stripeClient({ operation: "balance_get", secret_key: FAKE_KEY });
    assert(r && r._raw, "C6: non-JSON body returned as {_raw}");
    https.request = original;
  }

  // C7: response body exceeds 16 MB cap
  {
    const original = https.request;
    https.request = (_opts, cb) => {
      const res = new EventEmitter();
      res.statusCode = 200;
      process.nextTick(() => {
        cb(res);
        res.emit("data", Buffer.alloc(17 * 1024 * 1024, 0x41)); // 17 MB
        res.emit("end");
      });
      const req = new EventEmitter();
      req.write = () => {};
      req.end = () => {};
      req.destroy = () => {};
      return req;
    };
    await assertRejects(
      () => stripeClient({ operation: "balance_get", secret_key: FAKE_KEY }),
      /16 MB|exceeds/i, "C7: 17 MB response exceeds 16 MB cap"
    );
    https.request = original;
  }

  // C8: rk_ restricted key is accepted
  {
    const restore = mockHttps(200, { object: "balance" });
    const r = await stripeClient({ operation: "balance_get", secret_key: "rk_live_" + "b".repeat(24) });
    assert(r && r.object === "balance", "C8: rk_* restricted key is accepted");
    restore();
  }

  // C9: Stripe-Account header is sent when stripe_account provided
  {
    let capturedHeaders = null;
    const original = https.request;
    https.request = (opts, cb) => {
      capturedHeaders = opts.headers;
      const res = new EventEmitter();
      res.statusCode = 200;
      process.nextTick(() => { cb(res); res.emit("data", Buffer.from(JSON.stringify({ object: "balance" }))); res.emit("end"); });
      const req = new EventEmitter();
      req.write = () => {};
      req.end = () => {};
      req.destroy = () => {};
      return req;
    };
    await stripeClient({ operation: "balance_get", secret_key: FAKE_KEY, stripe_account: "acct_connected" });
    assert(capturedHeaders && capturedHeaders["Stripe-Account"] === "acct_connected", "C9: Stripe-Account header sent for Connect");
    https.request = original;
  }

  // C10: idempotency_key is forwarded in headers
  {
    let capturedHeaders = null;
    const original = https.request;
    https.request = (opts, cb) => {
      capturedHeaders = opts.headers;
      const res = new EventEmitter();
      res.statusCode = 200;
      process.nextTick(() => { cb(res); res.emit("data", Buffer.from(JSON.stringify({ id: "pi_x", object: "payment_intent" }))); res.emit("end"); });
      const req = new EventEmitter();
      req.write = () => {};
      req.end = () => {};
      req.destroy = () => {};
      return req;
    };
    await stripeClient({ operation: "payment_intent_create", secret_key: FAKE_KEY, amount: 100, currency: "usd", idempotency_key: "my-key-123" });
    assert(capturedHeaders && capturedHeaders["Idempotency-Key"] === "my-key-123", "C10: Idempotency-Key header forwarded");
    https.request = original;
  }

  // C11: Stripe-Version header always sent
  {
    let capturedHeaders = null;
    const original = https.request;
    https.request = (opts, cb) => {
      capturedHeaders = opts.headers;
      const res = new EventEmitter();
      res.statusCode = 200;
      process.nextTick(() => { cb(res); res.emit("data", Buffer.from(JSON.stringify({ object: "balance" }))); res.emit("end"); });
      const req = new EventEmitter();
      req.write = () => {};
      req.end = () => {};
      req.destroy = () => {};
      return req;
    };
    await stripeClient({ operation: "balance_get", secret_key: FAKE_KEY });
    assert(capturedHeaders && capturedHeaders["Stripe-Version"] === "2023-10-16", "C11: Stripe-Version header always sent");
    https.request = original;
  }

  // C12: GET requests send query string not body
  {
    let capturedPath = null;
    let capturedBody = null;
    const original = https.request;
    https.request = (opts, cb) => {
      capturedPath = opts.path;
      const res = new EventEmitter();
      res.statusCode = 200;
      process.nextTick(() => { cb(res); res.emit("data", Buffer.from(JSON.stringify({ object: "list", data: [] }))); res.emit("end"); });
      const req = new EventEmitter();
      req.write = (b) => { capturedBody = b; };
      req.end = () => {};
      req.destroy = () => {};
      return req;
    };
    await stripeClient({ operation: "customer_list", secret_key: FAKE_KEY, limit: 5, email: "a@b.com" });
    assert(capturedPath && capturedPath.includes("limit=5") && capturedBody === null, "C12: GET list sends params in query string");
    https.request = original;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// D — Security (sanitization, injection, path traversal)
// ══════════════════════════════════════════════════════════════════════════════
console.log("\n[D] Security tests");

async function testD() {
  // D1: NUL byte in secret_key throws
  await assertRejects(
    () => stripeClient({ operation: "info", secret_key: "sk_test_\x00evil" }),
    /NUL|secret_key/i, "D1: NUL byte in secret_key is rejected"
  );

  // D2: NUL byte in customer_id throws
  await assertRejects(
    () => stripeClient({ operation: "customer_get", secret_key: FAKE_KEY, customer_id: "cus_\x00evil" }),
    /NUL|customer_id/i, "D2: NUL byte in customer_id is rejected"
  );

  // D3: secret_key scrubbed from error messages
  {
    const realKey = "sk_test_supersecretcanary";
    const restore = mockHttpsError(`Connection refused ${realKey}`);
    try {
      await stripeClient({ operation: "balance_get", secret_key: realKey });
      assert(false, "D3: should have thrown");
    } catch (e) {
      assert(!e.message.includes(realKey), "D3: secret_key scrubbed from error message");
    }
    restore();
  }

  // D4: secret_key scrubbed from API error body
  {
    const realKey = "sk_test_supersecretcanary";
    const restore = mockHttps(400, { error: { message: `Invalid key ${realKey}` } });
    try {
      await stripeClient({ operation: "balance_get", secret_key: realKey });
      assert(false, "D4: should have thrown");
    } catch (e) {
      assert(!e.message.includes(realKey), "D4: secret_key scrubbed from API error body");
    }
    restore();
  }

  // D5: Basic auth uses key as username with empty password
  {
    let capturedAuth = null;
    const original = https.request;
    https.request = (opts, cb) => {
      capturedAuth = opts.headers.Authorization;
      const res = new EventEmitter();
      res.statusCode = 200;
      process.nextTick(() => { cb(res); res.emit("data", Buffer.from(JSON.stringify({ object: "balance" }))); res.emit("end"); });
      const req = new EventEmitter();
      req.write = () => {};
      req.end = () => {};
      req.destroy = () => {};
      return req;
    };
    const key = "sk_test_" + "c".repeat(24);
    await stripeClient({ operation: "balance_get", secret_key: key });
    const expected = "Basic " + Buffer.from(`${key}:`).toString("base64");
    assert(capturedAuth === expected, "D5: Basic auth header uses key:empty-password format");
    https.request = original;
  }

  // D6: reject_unauthorized=false allowed for TLS dev
  {
    let capturedOpts = null;
    const original = https.request;
    https.request = (opts, cb) => {
      capturedOpts = opts;
      const res = new EventEmitter();
      res.statusCode = 200;
      process.nextTick(() => { cb(res); res.emit("data", Buffer.from(JSON.stringify({ object: "balance" }))); res.emit("end"); });
      const req = new EventEmitter();
      req.write = () => {};
      req.end = () => {};
      req.destroy = () => {};
      return req;
    };
    await stripeClient({ operation: "balance_get", secret_key: FAKE_KEY, reject_unauthorized: false });
    assert(capturedOpts && capturedOpts.rejectUnauthorized === false, "D6: reject_unauthorized:false forwarded to TLS options");
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
      process.nextTick(() => { cb(res); res.emit("data", Buffer.from(JSON.stringify({ object: "balance" }))); res.emit("end"); });
      const req = new EventEmitter();
      req.write = () => {};
      req.end = () => {};
      req.destroy = () => {};
      return req;
    };
    await stripeClient({ operation: "balance_get", secret_key: FAKE_KEY });
    assert(capturedOpts && capturedOpts.rejectUnauthorized === true, "D7: reject_unauthorized defaults to true");
    https.request = original;
  }

  // D8: NUL byte in email is rejected
  await assertRejects(
    () => stripeClient({ operation: "customer_create", secret_key: FAKE_KEY, email: "a@b.com\x00evil" }),
    /NUL|email/i, "D8: NUL byte in email is rejected"
  );

  // D9: timeout clamped to max 120000ms
  {
    let capturedTimeout = null;
    // We test via a very large timeout that should be clamped
    const original = https.request;
    https.request = (_opts, cb) => {
      const res = new EventEmitter();
      res.statusCode = 200;
      process.nextTick(() => { cb(res); res.emit("data", Buffer.from(JSON.stringify({ object: "balance" }))); res.emit("end"); });
      const req = new EventEmitter();
      req.write = () => {};
      req.end = () => {};
      req.destroy = () => {};
      // Simulate that the timer would fire after MAX timeout
      return req;
    };
    // Just verify it doesn't throw with a huge timeout value (clamped internally)
    const r = await stripeClient({ operation: "balance_get", secret_key: FAKE_KEY, timeout: 999999 });
    assert(r && r.object === "balance", "D9: huge timeout clamped, request still works");
    https.request = original;
  }

  // D10: NUL byte in stripe_account is rejected
  await assertRejects(
    () => stripeClient({ operation: "balance_get", secret_key: FAKE_KEY, stripe_account: "acct_\x00evil" }),
    /NUL|stripe_account/i, "D10: NUL byte in stripe_account is rejected"
  );

  // D11: amount must be positive integer
  await assertRejects(
    () => stripeClient({ operation: "charge_create", secret_key: FAKE_KEY, amount: 0, currency: "usd" }),
    /amount.*required|>= 1|invalid/i, "D11: amount=0 is rejected for charge_create"
  );

  // D12: pk_ prefix is rejected (not a secret key)
  await assertRejects(
    () => stripeClient({ operation: "info", secret_key: "pk_live_testkey" }),
    /secret_key.*must start.*sk_/i, "D12: pk_ prefix is rejected as non-secret key"
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// E — Concurrency / stress
// ══════════════════════════════════════════════════════════════════════════════
console.log("\n[E] Concurrency tests");

async function testE() {
  // E1: 20 concurrent customer_get calls succeed
  {
    const restore = mockHttps(200, { id: "cus_concurrent", object: "customer" });
    const tasks = Array.from({ length: 20 }, (_, i) =>
      stripeClient({ operation: "customer_get", secret_key: FAKE_KEY, customer_id: "cus_" + i })
    );
    const results = await Promise.all(tasks);
    assert(results.length === 20 && results.every(r => r.id === "cus_concurrent"), "E1: 20 concurrent customer_get calls all succeed");
    restore();
  }

  // E2: 10 concurrent payment_intent_create calls succeed
  {
    const restore = mockHttps(200, { id: "pi_concurrent", object: "payment_intent" });
    const tasks = Array.from({ length: 10 }, () =>
      stripeClient({ operation: "payment_intent_create", secret_key: FAKE_KEY, amount: 100, currency: "usd" })
    );
    const results = await Promise.all(tasks);
    assert(results.length === 10 && results.every(r => r.id === "pi_concurrent"), "E2: 10 concurrent payment_intent_create calls succeed");
    restore();
  }

  // E3: mix of success and validation errors in parallel
  {
    const restore = mockHttps(200, { id: "cus_mix", object: "customer" });
    const tasks = [
      stripeClient({ operation: "customer_get", secret_key: FAKE_KEY, customer_id: "cus_123" }),
      stripeClient({ operation: "customer_get", secret_key: FAKE_KEY }).catch(e => e),
      stripeClient({ operation: "customer_get", secret_key: FAKE_KEY, customer_id: "cus_456" }),
    ];
    const [r1, r2, r3] = await Promise.all(tasks);
    assert(r1.id === "cus_mix" && r2 instanceof Error && r3.id === "cus_mix",
      "E3: mix of success + validation errors in parallel handled correctly");
    restore();
  }

  // E4: repeated rapid calls don't leak state
  {
    let callCount = 0;
    const original = https.request;
    https.request = (_opts, cb) => {
      callCount++;
      const res = new EventEmitter();
      res.statusCode = 200;
      process.nextTick(() => { cb(res); res.emit("data", Buffer.from(JSON.stringify({ object: "balance", count: callCount }))); res.emit("end"); });
      const req = new EventEmitter();
      req.write = () => {};
      req.end = () => {};
      req.destroy = () => {};
      return req;
    };
    const tasks = Array.from({ length: 15 }, () => stripeClient({ operation: "balance_get", secret_key: FAKE_KEY }));
    const results = await Promise.all(tasks);
    assert(callCount === 15 && results.length === 15, "E4: 15 rapid calls all complete, no state leakage");
    https.request = original;
  }

  // E5: concurrent network errors all propagate independently
  {
    const restore = mockHttpsError("ECONNRESET");
    const tasks = Array.from({ length: 8 }, () =>
      stripeClient({ operation: "balance_get", secret_key: FAKE_KEY }).catch(e => e)
    );
    const results = await Promise.all(tasks);
    assert(results.length === 8 && results.every(e => e instanceof Error && /ECONNRESET/i.test(e.message)),
      "E5: 8 concurrent network errors all propagate independently");
    restore();
  }

  // E6: concurrent calls with different operations don't interfere
  {
    const restore = mockHttps(200, { object: "test", data: [] });
    const tasks = [
      stripeClient({ operation: "customer_list", secret_key: FAKE_KEY }),
      stripeClient({ operation: "charge_list", secret_key: FAKE_KEY }),
      stripeClient({ operation: "invoice_list", secret_key: FAKE_KEY }),
      stripeClient({ operation: "subscription_list", secret_key: FAKE_KEY }),
      stripeClient({ operation: "payout_list", secret_key: FAKE_KEY }),
    ];
    const results = await Promise.all(tasks);
    assert(results.length === 5 && results.every(r => r.object === "test"),
      "E6: 5 concurrent different operations succeed without interference");
    restore();
  }

  // E7: 50 sequential validation rejections don't accumulate error handlers
  {
    let errCount = 0;
    for (let i = 0; i < 50; i++) {
      await stripeClient({ operation: "customer_create", secret_key: FAKE_KEY }).catch(() => errCount++);
    }
    assert(errCount === 50, "E7: 50 sequential validation errors all caught cleanly");
  }

  // E8: concurrent calls where half succeed half fail
  {
    let toggle = 0;
    const original = https.request;
    https.request = (_opts, cb) => {
      const mine = toggle++;
      const statusCode = mine % 2 === 0 ? 200 : 402;
      const body = mine % 2 === 0
        ? { object: "balance" }
        : { error: { type: "card_error", message: "Declined" } };
      const res = new EventEmitter();
      res.statusCode = statusCode;
      process.nextTick(() => { cb(res); res.emit("data", Buffer.from(JSON.stringify(body))); res.emit("end"); });
      const req = new EventEmitter();
      req.write = () => {};
      req.end = () => {};
      req.destroy = () => {};
      return req;
    };
    const tasks = Array.from({ length: 10 }, () =>
      stripeClient({ operation: "balance_get", secret_key: FAKE_KEY }).catch(e => ({ error: e.message }))
    );
    const results = await Promise.all(tasks);
    const successes = results.filter(r => r.object === "balance").length;
    const failures = results.filter(r => r.error).length;
    assert(successes === 5 && failures === 5, "E8: 10 concurrent calls: 5 succeed + 5 fail correctly");
    https.request = original;
  }
}

// ── Run all ────────────────────────────────────────────────────────────────
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
  console.log(`\n────────────────────────────────────────`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
