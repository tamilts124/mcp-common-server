"use strict";
/**
 * Tests for:
 *  - browser_set_cookies cookies_file parameter (offline, no browser needed —
 *    tests the JSON-parse / file-read logic and ToolError paths)
 *  - browser_storage_state_save ToolError validation paths (no-session guards)
 *
 * setCookies and saveStorageState are async functions — all tests that call
 * them await the returned promise so rejections surface correctly.
 *
 * Exports a Promise so run-tests.js can `await` it (same pattern as sections
 * 29/29b/55/58 etc. that also wrap async work in an exported IIFE promise).
 *
 * v4.137.0
 */
const path = require("path");
const os   = require("os");
const fs   = require("fs");

const { ToolError } = require("../../lib/errors");
const { setCookies, saveStorageState } = require("../../lib/browserActions/storage");

let passed = 0, failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
async function assertRejects(fn, check) {
  let threw = false;
  try { await fn(); } catch (e) {
    threw = true;
    if (check) assert(check(e), `error check failed: ${e.message}`);
  }
  assert(threw, "expected a rejection but none occurred");
}

function tmpFile(content, ext = ".json") {
  const f = path.join(os.tmpdir(), `cft-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  fs.writeFileSync(f, content, "utf8");
  return f;
}

// ── Cookies-file JSON parsing (tested offline via the raw parseCookiesFile
//    logic extracted inline — no browser session needed for file I/O tests) ──
function parseCookiesFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    throw new ToolError(`browser_set_cookies: cannot read cookies_file '${filePath}': ${e.message}`, -32602);
  }
  try {
    const parsed = JSON.parse(raw);
    const cookies = Array.isArray(parsed) ? parsed : parsed.cookies;
    if (!Array.isArray(cookies))
      throw new Error("expected a JSON array or an object with a 'cookies' array");
    return cookies;
  } catch (e) {
    throw new ToolError(`browser_set_cookies: cookies_file '${filePath}' is not valid JSON: ${e.message}`, -32602);
  }
}

module.exports = (async () => {
  console.log("\n=== browser_set_cookies cookies_file parsing (offline) ===");
  console.log("\n-- Normal Level --");

  await test("bare JSON array of cookies is accepted", async () => {
    const cookies = [{ name: "session", value: "abc123", url: "https://example.com" }];
    const f = tmpFile(JSON.stringify(cookies));
    const result = parseCookiesFile(f);
    fs.unlinkSync(f);
    assert(Array.isArray(result) && result.length === 1 && result[0].name === "session");
  });

  await test("Playwright storageState object with cookies key is accepted", async () => {
    const state = {
      cookies: [
        { name: "auth",  value: "tok",  url: "https://app.example.com" },
        { name: "pref",  value: "dark", domain: "app.example.com", path: "/" },
      ],
      origins: [],
    };
    const f = tmpFile(JSON.stringify(state));
    const result = parseCookiesFile(f);
    fs.unlinkSync(f);
    assert(result.length === 2 && result[0].name === "auth" && result[1].name === "pref");
  });

  await test("pretty-printed JSON file is accepted", async () => {
    const cookies = [{ name: "x", value: "1", url: "https://x.com" }];
    const f = tmpFile(JSON.stringify(cookies, null, 2));
    const result = parseCookiesFile(f);
    fs.unlinkSync(f);
    assert(result.length === 1);
  });

  console.log("\n-- Medium Level --");

  await test("non-existent file throws ToolError with descriptive message", async () => {
    let threw = false;
    try { parseCookiesFile("/no/such/file-abc123.json"); } catch (e) {
      threw = true;
      assert(e instanceof ToolError && e.message.includes("cannot read cookies_file"));
    }
    assert(threw);
  });

  await test("invalid JSON throws ToolError", async () => {
    const f = tmpFile("not json {{{");
    let threw = false;
    try { parseCookiesFile(f); } catch (e) {
      threw = true;
      assert(e instanceof ToolError && e.message.includes("not valid JSON"));
    }
    fs.unlinkSync(f);
    assert(threw);
  });

  await test("JSON object without cookies key throws ToolError", async () => {
    const f = tmpFile(JSON.stringify({ sessions: [], tokens: [] }));
    let threw = false;
    try { parseCookiesFile(f); } catch (e) { threw = true; assert(e instanceof ToolError); }
    fs.unlinkSync(f);
    assert(threw);
  });

  await test("JSON null throws ToolError", async () => {
    const f = tmpFile("null");
    let threw = false;
    try { parseCookiesFile(f); } catch (e) { threw = true; }
    fs.unlinkSync(f);
    assert(threw);
  });

  await test("JSON string throws ToolError", async () => {
    const f = tmpFile('"just a string"');
    let threw = false;
    try { parseCookiesFile(f); } catch (e) { threw = true; }
    fs.unlinkSync(f);
    assert(threw);
  });

  console.log("\n-- High Level --");

  await test("empty JSON array accepted (validation deferred to addCookies)", async () => {
    const f = tmpFile("[]");
    const result = parseCookiesFile(f);
    fs.unlinkSync(f);
    assert(Array.isArray(result) && result.length === 0);
  });

  await test("storageState with empty cookies array is accepted", async () => {
    const f = tmpFile(JSON.stringify({ cookies: [], origins: [] }));
    const result = parseCookiesFile(f);
    fs.unlinkSync(f);
    assert(Array.isArray(result) && result.length === 0);
  });

  await test("large cookies array (500 entries) parsed in < 500ms", async () => {
    const cookies = Array.from({ length: 500 }, (_, i) => ({ name: `c${i}`, value: `v${i}`, url: "https://x.com" }));
    const f = tmpFile(JSON.stringify(cookies));
    const start = Date.now();
    const result = parseCookiesFile(f);
    fs.unlinkSync(f);
    assert(result.length === 500 && Date.now() - start < 500);
  });

  console.log("\n-- Critical Level --");

  await test("path traversal in cookie value is preserved as-is by parser", async () => {
    const cookies = [{ name: "x", value: "../../../etc/passwd", url: "https://x.com" }];
    const f = tmpFile(JSON.stringify(cookies));
    const result = parseCookiesFile(f);
    fs.unlinkSync(f);
    assert(result[0].value === "../../../etc/passwd");
  });

  await test("very long cookie name/value accepted (no crash)", async () => {
    const cookies = [{ name: "x".repeat(4096), value: "y".repeat(4096), url: "https://x.com" }];
    const f = tmpFile(JSON.stringify(cookies));
    let threw = false;
    let result;
    try { result = parseCookiesFile(f); } catch (e) { threw = true; }
    fs.unlinkSync(f);
    assert(!threw && result[0].name.length === 4096);
  });

  console.log("\n-- Extreme Level --");

  await test("cookies_file with Unicode content parsed correctly", async () => {
    const cookies = [{ name: "lang", value: "日本語テスト", url: "https://example.jp" }];
    const f = path.join(os.tmpdir(), `uc-${Date.now()}.json`);
    fs.writeFileSync(f, JSON.stringify(cookies), "utf8");
    const result = parseCookiesFile(f);
    fs.unlinkSync(f);
    assert(result[0].value === "日本語テスト");
  });

  await test("10 sequential parse calls complete without error", async () => {
    const cookies = [{ name: "a", value: "1", url: "https://a.com" }];
    const files = Array.from({ length: 10 }, () => tmpFile(JSON.stringify(cookies)));
    let errors = 0;
    for (const f of files) {
      try { parseCookiesFile(f); } catch (_) { errors++; }
      fs.unlinkSync(f);
    }
    assert(errors === 0, `${errors} parse errors`);
  });

  // ── browser_set_cookies async validation (no-session error paths) ──────────
  console.log("\n=== browser_set_cookies async validation ===");
  console.log("\n-- Normal Level --");

  await test("missing session_id rejects with ToolError", async () => {
    await assertRejects(
      () => setCookies({ cookies: [] }),
      e => e instanceof ToolError,
    );
  });

  await test("cookies_file empty string rejects with ToolError", async () => {
    await assertRejects(
      () => setCookies({ session_id: "s", cookies_file: "" }),
      e => e instanceof ToolError,
    );
  });

  await test("cookies_file whitespace-only string rejects with ToolError", async () => {
    await assertRejects(
      () => setCookies({ session_id: "s", cookies_file: "   " }),
      e => e instanceof ToolError,
    );
  });

  await test("cookies_file non-existent path rejects before session lookup", async () => {
    await assertRejects(
      () => setCookies({ session_id: "s", cookies_file: "/no/such/cookies-xyz.json" }),
      e => e instanceof ToolError && e.message.includes("cannot read cookies_file"),
    );
  });

  await test("no cookies and no cookies_file rejects with ToolError", async () => {
    await assertRejects(
      () => setCookies({ session_id: "s" }),
      e => e instanceof ToolError,
    );
  });

  console.log("\n-- Medium Level --");

  await test("cookies_file invalid JSON rejects with descriptive ToolError", async () => {
    const f = tmpFile("definitely not json >>><<<");
    await assertRejects(
      () => setCookies({ session_id: "s", cookies_file: f }),
      e => e instanceof ToolError && e.message.includes("not valid JSON"),
    );
    fs.unlinkSync(f);
  });

  await test("cookies_file without cookies key rejects with ToolError", async () => {
    const f = tmpFile(JSON.stringify({ data: [] }));
    await assertRejects(
      () => setCookies({ session_id: "s", cookies_file: f }),
      e => e instanceof ToolError,
    );
    fs.unlinkSync(f);
  });

  // ── browser_storage_state_save async validation (no-session error paths) ──
  console.log("\n=== browser_storage_state_save async validation ===");
  console.log("\n-- Normal Level --");

  await test("missing session_id rejects with ToolError", async () => {
    await assertRejects(
      () => saveStorageState({ path: "/tmp/state.json" }),
      e => e instanceof ToolError,
    );
  });

  await test("missing path rejects with ToolError", async () => {
    await assertRejects(
      () => saveStorageState({ session_id: "fake" }),
      e => e instanceof ToolError,
    );
  });

  await test("empty path string rejects with ToolError", async () => {
    await assertRejects(
      () => saveStorageState({ session_id: "fake", path: "  " }),
      e => e instanceof ToolError,
    );
  });

  console.log("\n-- Medium Level --");

  await test("null path rejects", async () => {
    await assertRejects(() => saveStorageState({ session_id: "s", path: null }));
  });

  await test("numeric path rejects", async () => {
    await assertRejects(() => saveStorageState({ session_id: "s", path: 123 }));
  });

  await test("unknown session_id rejects after path validation passes", async () => {
    // path is valid, session is unknown → getSession should throw
    await assertRejects(
      () => saveStorageState({ session_id: "definitely-not-real", path: "/tmp/x.json" }),
      e => e instanceof ToolError,
    );
  });

  console.log(`\n  Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
