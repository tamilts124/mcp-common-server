"use strict";
/**
 * [58] EMAIL SEND (SMTP) — validateSendParams, buildMessage/dotStuff/
 * encodeHeaderValue, email_send tool dispatch + validation.
 * Rigor: Normal/Medium/High/Critical/Extreme.
 *
 * Async section (email_send is a Promise-returning tool; several tests make
 * real fast-failing TCP connections to 127.0.0.1:1). Wrapped in an async
 * IIFE assigned to module.exports, same pattern as section 55.
 */
const { assert, test, counters } = require("../test-harness");
const { executeTool } = require("../../lib/executeTool");
const {
  validateSendParams, buildMessage, dotStuff, encodeHeaderValue, normalizeAddrList,
} = require("../../lib/emailSendOps");

console.log(`\n[58] EMAIL SEND (SMTP) OPS`);

module.exports = (async () => {

  // ── NORMAL ──────────────────────────────────────────────────────────────
  await test("validateSendParams: happy path with explicit args", () => {
    const p = validateSendParams({
      username: "a@b.com", password: "x", to: "c@d.com", subject: "Hi", body: "Hello",
    });
    assert.strictEqual(p.username, "a@b.com");
    assert.deepStrictEqual(p.to, ["c@d.com"]);
    assert.strictEqual(p.port, 465);
    assert.strictEqual(p.host, "smtp.gmail.com");
  });
  await test("normalizeAddrList: accepts comma-separated string", () => {
    assert.deepStrictEqual(normalizeAddrList("a@b.com, c@d.com", "to", true), ["a@b.com", "c@d.com"]);
  });
  await test("normalizeAddrList: accepts array", () => {
    assert.deepStrictEqual(normalizeAddrList(["a@b.com", "c@d.com"], "to", true), ["a@b.com", "c@d.com"]);
  });
  await test("encodeHeaderValue: ASCII passes through unchanged", () => {
    assert.strictEqual(encodeHeaderValue("Hello world"), "Hello world");
  });
  await test("encodeHeaderValue: non-ASCII is RFC2047 base64-encoded", () => {
    const out = encodeHeaderValue("Café");
    assert.ok(out.startsWith("=?UTF-8?B?") && out.endsWith("?="));
  });
  await test("buildMessage: plain-text-only message has correct headers/content-type", () => {
    const msg = buildMessage({ username: "a@b.com", to: ["c@d.com"], cc: [], subject: "Hi", bodyText: "Hello", bodyHtml: null });
    assert.ok(msg.includes("Content-Type: text/plain; charset=UTF-8"));
    assert.ok(msg.includes("To: c@d.com"));
    assert.ok(msg.includes("Hello"));
  });
  await test("buildMessage: html-only message uses text/html content-type", () => {
    const msg = buildMessage({ username: "a@b.com", to: ["c@d.com"], cc: [], subject: "Hi", bodyText: "", bodyHtml: "<b>hi</b>" });
    assert.ok(msg.includes("Content-Type: text/html; charset=UTF-8"));
    assert.ok(msg.includes("<b>hi</b>"));
  });
  await test("buildMessage: both text+html builds multipart/alternative with both parts", () => {
    const msg = buildMessage({ username: "a@b.com", to: ["c@d.com"], cc: [], subject: "Hi", bodyText: "plain body", bodyHtml: "<i>html body</i>" });
    assert.ok(msg.includes("multipart/alternative"));
    assert.ok(msg.includes("plain body"));
    assert.ok(msg.includes("<i>html body</i>"));
  });
  await test("buildMessage: cc header included when cc present", () => {
    const msg = buildMessage({ username: "a@b.com", to: ["c@d.com"], cc: ["e@f.com"], subject: "Hi", bodyText: "x", bodyHtml: null });
    assert.ok(msg.includes("Cc: e@f.com"));
  });
  await test("dotStuff: leading-dot line is escaped to double-dot", () => {
    assert.strictEqual(dotStuff("hello\r\n.world\r\nend"), "hello\r\n..world\r\nend");
  });

  // ── MEDIUM ──────────────────────────────────────────────────────────────
  await test("email_send: missing 'to' throws -32602", async () => {
    try { await executeTool("email_send", { username: "a@b.com", password: "x", subject: "hi", body: "hi" }); assert.fail("should throw"); }
    catch (e) { assert.strictEqual(e.code, -32602); }
  });
  await test("email_send: missing body and body_html throws -32602", async () => {
    try { await executeTool("email_send", { username: "a@b.com", password: "x", to: "c@d.com" }); assert.fail("should throw"); }
    catch (e) { assert.strictEqual(e.code, -32602); }
  });
  await test("email_send: missing credentials (env cleared) throws -32602", async () => {
    const savedU = process.env.EMAIL_USERNAME, savedP = process.env.EMAIL_APP_PASSWORD;
    delete process.env.EMAIL_USERNAME; delete process.env.EMAIL_APP_PASSWORD;
    try {
      try { await executeTool("email_send", { to: "c@d.com", body: "hi" }); assert.fail("should throw"); }
      catch (e) { assert.strictEqual(e.code, -32602); }
    } finally {
      if (savedU !== undefined) process.env.EMAIL_USERNAME = savedU;
      if (savedP !== undefined) process.env.EMAIL_APP_PASSWORD = savedP;
    }
  });
  await test("email_send: invalid email address in 'to' throws -32602", async () => {
    try { await executeTool("email_send", { username: "a@b.com", password: "x", to: "not-an-email", body: "hi" }); assert.fail("should throw"); }
    catch (e) { assert.strictEqual(e.code, -32602); }
  });
  await test("email_send: non-numeric port throws -32602", async () => {
    try { await executeTool("email_send", { username: "a@b.com", password: "x", to: "c@d.com", body: "hi", port: "not-a-number" }); assert.fail("should throw"); }
    catch (e) { assert.strictEqual(e.code, -32602); }
  });
  await test("email_send: empty 'to' array throws -32602", async () => {
    try { await executeTool("email_send", { username: "a@b.com", password: "x", to: [], body: "hi" }); assert.fail("should throw"); }
    catch (e) { assert.strictEqual(e.code, -32602); }
  });

  // ── HIGH (dependency failure) ───────────────────────────────────────────
  await test("email_send: connection refused (unreachable port) rejects with -32603, not a crash", async () => {
    try {
      await executeTool("email_send", { username: "a@b.com", password: "x", to: "c@d.com", body: "hi", host: "127.0.0.1", port: 1 });
      assert.fail("should have rejected");
    } catch (e) {
      assert.strictEqual(e.code, -32603);
    }
  });
  await test("email_send: env-fallback credentials also reach the (expected) connection failure", async () => {
    const savedU = process.env.EMAIL_USERNAME, savedP = process.env.EMAIL_APP_PASSWORD;
    process.env.EMAIL_USERNAME = "envuser@example.com";
    process.env.EMAIL_APP_PASSWORD = "envpass";
    try {
      await executeTool("email_send", { to: "c@d.com", body: "hi", host: "127.0.0.1", port: 1 });
      assert.fail("should have rejected (connection refused), proving it got past credential validation");
    } catch (e) {
      assert.strictEqual(e.code, -32603);
    } finally {
      if (savedU !== undefined) process.env.EMAIL_USERNAME = savedU; else delete process.env.EMAIL_USERNAME;
      if (savedP !== undefined) process.env.EMAIL_APP_PASSWORD = savedP; else delete process.env.EMAIL_APP_PASSWORD;
    }
  });

  // ── CRITICAL (injection / sanitization) ─────────────────────────────────
  await test("email_send: CRLF injection in 'to' address rejected (header injection attempt)", async () => {
    try {
      await executeTool("email_send", { username: "a@b.com", password: "x", to: "c@d.com\r\nBcc: evil@evil.com", body: "hi" });
      assert.fail("should throw");
    } catch (e) { assert.strictEqual(e.code, -32602); }
  });
  await test("email_send: CRLF injection in subject rejected", async () => {
    try {
      await executeTool("email_send", { username: "a@b.com", password: "x", to: "c@d.com", subject: "hi\r\nBcc: evil@evil.com", body: "hi" });
      assert.fail("should throw");
    } catch (e) { assert.strictEqual(e.code, -32602); }
  });
  await test("email_send: control characters in credentials rejected before any network I/O", async () => {
    try {
      await executeTool("email_send", { username: "a@b.com\r\nEVIL", password: "x", to: "c@d.com", body: "hi" });
      assert.fail("should throw");
    } catch (e) { assert.strictEqual(e.code, -32602); }
  });
  await test("buildMessage: HTML/script-shaped body round-trips literally, never executed/stripped", () => {
    const payload = "<script>alert(1)</script>";
    const msg = buildMessage({ username: "a@b.com", to: ["c@d.com"], cc: [], subject: "Hi", bodyText: "", bodyHtml: payload });
    assert.ok(msg.includes(payload));
  });
  await test("dotStuff: message body line literally '.' is escaped so SMTP DATA terminator isn't spoofed", () => {
    const out = dotStuff("line1\r\n.\r\nline3");
    assert.strictEqual(out, "line1\r\n..\r\nline3");
    assert.ok(!/\r\n\.\r\n/.test(out));
  });

  // ── EXTREME (fuzzing / large payload) ───────────────────────────────────
  await test("buildMessage: large body (100KB) builds without error", () => {
    const big = "x".repeat(100000);
    const msg = buildMessage({ username: "a@b.com", to: ["c@d.com"], cc: [], subject: "Hi", bodyText: big, bodyHtml: null });
    assert.ok(msg.length > 100000);
  });
  await test("normalizeAddrList: fuzz — random garbage string throws cleanly (invalid address), never crashes", () => {
    const garbage = Array.from({ length: 50 }, () => String.fromCharCode(1 + Math.floor(Math.random() * 65000))).join("");
    try {
      normalizeAddrList(garbage, "to", true);
      // Some random unicode might slip past the regex; either outcome is fine as long as it doesn't crash.
    } catch (e) {
      assert.strictEqual(e.code, -32602);
    }
  });
  await test("email_send: 20 concurrent connection-refused calls all reject cleanly (no unhandled rejection)", async () => {
    const calls = Array.from({ length: 20 }, () =>
      executeTool("email_send", { username: "a@b.com", password: "x", to: "c@d.com", body: "hi", host: "127.0.0.1", port: 1 })
        .then(() => { throw new Error("should have rejected"); })
        .catch(e => { if (e.code !== -32603) throw e; })
    );
    await Promise.all(calls);
  });
  await test("email_send / registered in TOOLS_ALL schema list and pipeline op enum", () => {
    const { TOOLS_ALL } = require("../../lib/toolsSchema");
    assert.ok(TOOLS_ALL.some(t => t.name === "email_send"));
    const { EXEC_SCHEMAS } = require("../../lib/schemas/execSchemas");
    const pipelineOp = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
    const opEnum = pipelineOp.inputSchema.properties.steps.items.properties.op.enum;
    assert.ok(opEnum.includes("email_send"));
  });

})();
