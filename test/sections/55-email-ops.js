"use strict";
/**
 * [55] EMAIL (IMAP) OPS — decodeMimeWords, parseRawMessage, buildSearchCriteria,
 * email_list_mailboxes / email_search tool dispatch + validation.
 * Rigor: Normal/Medium/High/Critical/Extreme.
 *
 * Async section (email_search/email_list_mailboxes are Promise-returning
 * tools; several tests make real fast-failing TCP connections to
 * 127.0.0.1:1). Wrapped in an async IIFE assigned to module.exports so
 * run-tests.js can `await require(...)` it, same pattern as sections
 * 01/08/29/29b.
 */
const { assert, test, counters } = require("../test-harness");
const { executeTool } = require("../../lib/executeTool");
const {
  decodeMimeWords, parseRawMessage, buildSearchCriteria, toImapDate, imapQuote,
} = require("../../lib/emailOps");

console.log(`\n[55] EMAIL (IMAP) OPS`);

module.exports = (async () => {

  // ── NORMAL ──────────────────────────────────────────────────────────────
  await test("decodeMimeWords: plain ASCII subject passes through unchanged", () => {
    assert.strictEqual(decodeMimeWords("Hello world"), "Hello world");
  });
  await test("decodeMimeWords: Q-encoded UTF-8 subject decodes correctly", () => {
    assert.strictEqual(decodeMimeWords("=?UTF-8?Q?Caf=C3=A9?="), "Café");
  });
  await test("decodeMimeWords: B-encoded (base64) UTF-8 subject decodes correctly", () => {
    const b64 = Buffer.from("Héllo", "utf8").toString("base64");
    assert.strictEqual(decodeMimeWords(`=?UTF-8?B?${b64}?=`), "Héllo");
  });
  await test("decodeMimeWords: multiple adjacent encoded-words fold together", () => {
    const out = decodeMimeWords("=?UTF-8?Q?Hello=2C?= =?UTF-8?Q?_World?=");
    assert.strictEqual(out, "Hello, World");
  });
  await test("parseRawMessage: simple plain-text message parses subject/sender/body/date", () => {
    const raw = [
      "Subject: Test Subject",
      "From: Alice <alice@example.com>",
      "Date: Mon, 01 Jan 2024 10:00:00 +0000",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Hello there.",
    ].join("\r\n");
    const msg = parseRawMessage(Buffer.from(raw, "utf8"));
    assert.strictEqual(msg.subject, "Test Subject");
    assert.strictEqual(msg.sender, "Alice <alice@example.com>");
    assert.strictEqual(msg.body.trim(), "Hello there.");
    assert.ok(msg.date && msg.date.startsWith("2024-01-01"));
  });
  await test("parseRawMessage: multipart/alternative picks text/plain part", () => {
    const boundary = "BOUND123";
    const raw =
      `Subject: Multi\r\nFrom: b@x.com\r\nDate: Tue, 02 Jan 2024 00:00:00 +0000\r\n` +
      `Content-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n` +
      `--${boundary}\r\nContent-Type: text/plain\r\n\r\nPlain body.\r\n` +
      `--${boundary}\r\nContent-Type: text/html\r\n\r\n<p>Html body</p>\r\n` +
      `--${boundary}--\r\n`;
    const msg = parseRawMessage(Buffer.from(raw, "utf8"));
    assert.strictEqual(msg.body.trim(), "Plain body.");
  });
  await test("buildSearchCriteria: no filters returns ALL", () => {
    assert.strictEqual(buildSearchCriteria({}), "ALL");
  });
  await test("buildSearchCriteria: subject+sender+date combine correctly", () => {
    const c = buildSearchCriteria({ subject_keyword: "invoice", sender: "billing@x.com", date: "2024-03-05" });
    assert.strictEqual(c, 'SUBJECT "invoice" FROM "billing@x.com" ON 05-Mar-2024');
  });
  await test("toImapDate: converts ISO date to IMAP DD-Mon-YYYY format", () => {
    assert.strictEqual(toImapDate("2024-12-25"), "25-Dec-2024");
  });

  // ── MEDIUM — boundary & param validation ───────────────────────────────
  // NOTE: username/password are no longer schema-required (env fallback via
  // EMAIL_USERNAME/EMAIL_APP_PASSWORD — see lib/emailOps.js validateConnParams),
  // so the throw now happens inside the async handler, not synchronously at
  // schema-validation time. These tests must await + delete any stray env vars
  // so they don't accidentally pass because a real .env has credentials set.
  const savedEnvUser = process.env.EMAIL_USERNAME;
  const savedEnvPass = process.env.EMAIL_APP_PASSWORD;
  delete process.env.EMAIL_USERNAME;
  delete process.env.EMAIL_APP_PASSWORD;
  await test("email_search: missing username throws -32602", async () => {
    try { await executeTool("email_search", { password: "x" }); assert.fail("should throw"); }
    catch (e) { assert.strictEqual(e.code, -32602); }
  });
  await test("email_search: missing password throws -32602", async () => {
    try { await executeTool("email_search", { username: "a@b.com" }); assert.fail("should throw"); }
    catch (e) { assert.strictEqual(e.code, -32602); }
  });
  await test("email_list_mailboxes: missing both credentials throws -32602", async () => {
    try { await executeTool("email_list_mailboxes", {}); assert.fail("should throw"); }
    catch (e) { assert.strictEqual(e.code, -32602); }
  });
  await test("email_search: falls back to EMAIL_USERNAME/EMAIL_APP_PASSWORD env vars when args omit them", async () => {
    process.env.EMAIL_USERNAME = "envuser@example.com";
    process.env.EMAIL_APP_PASSWORD = "envpass";
    try {
      await executeTool("email_search", { host: "127.0.0.1", port: 1 });
      assert.fail("should have rejected (connection refused), proving it got past credential validation");
    } catch (e) {
      assert.strictEqual(e.code, -32603); // connection-refused, not -32602 — env creds were accepted
    } finally {
      delete process.env.EMAIL_USERNAME;
      delete process.env.EMAIL_APP_PASSWORD;
    }
  });
  await test("email_search: explicit args override EMAIL_USERNAME/EMAIL_APP_PASSWORD env vars", async () => {
    process.env.EMAIL_USERNAME = "envuser@example.com\r\nEVIL"; // would fail control-char check if used
    process.env.EMAIL_APP_PASSWORD = "envpass";
    try {
      await executeTool("email_search", { username: "explicit@example.com", password: "x", host: "127.0.0.1", port: 1 });
      assert.fail("should have rejected (connection refused)");
    } catch (e) {
      // -32603 (connection refused) proves the clean explicit args were used,
      // not the control-char-poisoned env username (which would be -32602).
      assert.strictEqual(e.code, -32603);
    } finally {
      delete process.env.EMAIL_USERNAME;
      delete process.env.EMAIL_APP_PASSWORD;
    }
  });
  if (savedEnvUser !== undefined) process.env.EMAIL_USERNAME = savedEnvUser;
  if (savedEnvPass !== undefined) process.env.EMAIL_APP_PASSWORD = savedEnvPass;
  await test("toImapDate: malformed date string throws -32602", () => {
    try { toImapDate("2024/12/25"); assert.fail("should throw"); }
    catch (e) { assert.strictEqual(e.code, -32602); }
  });
  await test("toImapDate: invalid calendar date (month 13) throws -32602", () => {
    try { toImapDate("2024-13-01"); assert.fail("should throw"); }
    catch (e) { assert.strictEqual(e.code, -32602); }
  });
  await test("decodeMimeWords: empty/undefined input returns empty string, no throw", () => {
    assert.strictEqual(decodeMimeWords(""), "");
    assert.strictEqual(decodeMimeWords(undefined), "");
  });

  // ── HIGH — dependency / network failure handling ───────────────────────
  await test("email_search: connection refused (unreachable port) rejects with -32603, not a crash", async () => {
    try {
      await executeTool("email_search", { username: "a@b.com", password: "x", host: "127.0.0.1", port: 1 });
      assert.fail("should have rejected");
    } catch (e) {
      assert.strictEqual(e.code, -32603);
    }
  });
  await test("email_list_mailboxes: connection refused rejects with -32603, not a crash", async () => {
    try {
      await executeTool("email_list_mailboxes", { username: "a@b.com", password: "x", host: "127.0.0.1", port: 1 });
      assert.fail("should have rejected");
    } catch (e) {
      assert.strictEqual(e.code, -32603);
    }
  });

  // ── CRITICAL — security & input sanitization ───────────────────────────
  await test("imapQuote: CRLF injection in a field throws -32602 instead of splitting the IMAP command", () => {
    try { imapQuote("foo\r\nA2 LOGOUT"); assert.fail("should throw"); }
    catch (e) { assert.strictEqual(e.code, -32602); }
  });
  await test("buildSearchCriteria: quotes and backslashes in subject_keyword are escaped, not breaking the query", () => {
    const c = buildSearchCriteria({ subject_keyword: 'he said "hi" \\ ok' });
    assert.strictEqual(c, 'SUBJECT "he said \\"hi\\" \\\\ ok"');
  });
  await test("email_search: control characters in username/password rejected before any network I/O", async () => {
    try { await executeTool("email_search", { username: "a@b.com\r\nEVIL", password: "x" }); assert.fail("should throw"); }
    catch (e) { assert.strictEqual(e.code, -32602); }
  });
  await test("email_search: control characters in mailbox name rejected", async () => {
    try {
      await executeTool("email_search", { username: "a@b.com", password: "x", host: "127.0.0.1", port: 1, mailbox: 'INBOX"\r\nEVIL' });
      assert.fail("should throw");
    } catch (e) {
      assert.strictEqual(e.code, -32602);
    }
  });
  await test("parseRawMessage: script/HTML-injection-shaped content in body is returned as literal decoded text, never executed", () => {
    const raw = "Subject: x\r\nFrom: a@b.com\r\nContent-Type: text/plain\r\n\r\n<script>alert(1)</script>";
    const msg = parseRawMessage(Buffer.from(raw, "utf8"));
    assert.ok(msg.body.includes("<script>alert(1)</script>"));
  });

  // ── EXTREME — fuzzing, malformed input, robustness ─────────────────────
  await test("parseRawMessage: malformed/empty buffer does not throw", () => {
    const msg = parseRawMessage(Buffer.alloc(0));
    assert.strictEqual(msg.subject, "");
    assert.strictEqual(msg.date, null);
  });
  await test("parseRawMessage: random fuzz bytes never crash the parser", () => {
    for (let i = 0; i < 20; i++) {
      const buf = Buffer.from(Array.from({ length: 200 }, () => Math.floor(Math.random() * 256)));
      parseRawMessage(buf); // must not throw
    }
  });
  await test("decodeMimeWords: malformed encoded-word (bad base64) falls back gracefully, no throw", () => {
    const out = decodeMimeWords("=?UTF-8?B?not-valid-base64!!!?=");
    assert.strictEqual(typeof out, "string");
  });
  await test("parseRawMessage: very large body (200KB) parses without error", () => {
    const bigBody = "x".repeat(200000);
    const raw = `Subject: big\r\nFrom: a@b.com\r\nContent-Type: text/plain\r\n\r\n${bigBody}`;
    const msg = parseRawMessage(Buffer.from(raw, "utf8"));
    assert.strictEqual(msg.body.length, 200000);
  });
  await test("email_search: oversized limit does not crash validation before the (expected) connection failure", async () => {
    try {
      await executeTool("email_search", { username: "a@b.com", password: "x", host: "127.0.0.1", port: 1, limit: 99999 });
      assert.fail("should have rejected");
    } catch (e) {
      assert.strictEqual(e.code, -32603);
    }
  });
  await test("email_search / email_list_mailboxes: registered in TOOLS_ALL schema list", () => {
    const { TOOLS_ALL } = require("../../lib/toolsSchema");
    const names = TOOLS_ALL.map(t => t.name);
    assert.ok(names.includes("email_search"));
    assert.ok(names.includes("email_list_mailboxes"));
  });

})().catch((e) => {
  counters.fail++;
  console.error(`[55] UNHANDLED TEST ERROR: ${e.stack || e.message}`);
});
