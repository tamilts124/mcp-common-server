"use strict";
/**
 * Standalone tests for checksum_verify. NOT added to frozen test/run-tests.js.
 * Run: node test/checksum-verify-tests.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-checksum-test-"));
process.env.MCP_ROOTS = TMP;
process.env.MCP_ALLOW_EXEC = "true";
process.env.MCP_READ_ONLY = "false";

const { buildRoots } = require("../lib/roots");
buildRoots();
const { executeTool } = require("../lib/executeTool");

const counters = { pass: 0, fail: 0 };
async function test(name, fn) {
  try { await fn(); counters.pass++; console.log(`  ok - ${name}`); }
  catch (e) { counters.fail++; console.log(`  FAIL - ${name}\n      ${e.message}`); }
}
function assertEq(a, b, msg) { if (a !== b) throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
async function expectThrow(fn, codeOrMsgFrag) {
  try { await fn(); throw new Error("expected throw, none occurred"); }
  catch (e) {
    if (e.message === "expected throw, none occurred") throw e;
    if (typeof codeOrMsgFrag === "number" && e.code !== codeOrMsgFrag)
      throw new Error(`expected code ${codeOrMsgFrag}, got ${e.code}: ${e.message}`);
    if (typeof codeOrMsgFrag === "string" && !e.message.includes(codeOrMsgFrag))
      throw new Error(`expected message to include '${codeOrMsgFrag}', got: ${e.message}`);
  }
}
function writeSrc(name, content) { fs.writeFileSync(path.join(TMP, name), content); return name; }
function sha256(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }

(async () => {
  console.log("== checksum-verify-tests.js ==");

  // ── Normal (happy path) ──────────────────────────────────────────────
  await test("checksum_verify: matching sha256 digest -> match:true", async () => {
    writeSrc("a.txt", "hello world");
    const expected = sha256(Buffer.from("hello world"));
    const r = await executeTool("checksum_verify", { path: "a.txt", expected });
    assertEq(r.match, true);
    assertEq(r.algorithm, "sha256");
    assertEq(r.expected, expected);
    assertEq(r.actual, expected);
  });

  await test("checksum_verify: mismatching digest -> match:false, no throw", async () => {
    const r = await executeTool("checksum_verify", { path: "a.txt", expected: "0".repeat(64) });
    assertEq(r.match, false);
    assertEq(r.actual, sha256(Buffer.from("hello world")));
  });

  await test("checksum_verify: uppercase expected digest matches case-insensitively", async () => {
    const expected = sha256(Buffer.from("hello world")).toUpperCase();
    const r = await executeTool("checksum_verify", { path: "a.txt", expected });
    assertEq(r.match, true);
    assertEq(r.expected, expected.toLowerCase());
  });

  await test("checksum_verify: whitespace around expected digest is trimmed", async () => {
    const expected = `  ${sha256(Buffer.from("hello world"))}  \n`;
    const r = await executeTool("checksum_verify", { path: "a.txt", expected });
    assertEq(r.match, true);
  });

  await test("checksum_verify: md5 algorithm works end to end", async () => {
    const expected = crypto.createHash("md5").update("hello world").digest("hex");
    const r = await executeTool("checksum_verify", { path: "a.txt", expected, algorithm: "md5" });
    assertEq(r.match, true);
    assertEq(r.algorithm, "md5");
  });

  // ── Medium (boundary & parameter validation) ─────────────────────────
  await test("checksum_verify: missing 'path' -> -32602", async () => {
    await expectThrow(() => executeTool("checksum_verify", { expected: "a".repeat(64) }), -32602);
  });

  await test("checksum_verify: missing 'expected' -> -32602", async () => {
    await expectThrow(() => executeTool("checksum_verify", { path: "a.txt" }), -32602);
  });

  await test("checksum_verify: empty-string 'expected' -> -32602 (schema-level required-field check)", async () => {
    await expectThrow(() => executeTool("checksum_verify", { path: "a.txt", expected: "" }), -32602);
  });

  await test("checksum_verify: whitespace-only 'expected' -> clean error", async () => {
    await expectThrow(() => executeTool("checksum_verify", { path: "a.txt", expected: "   " }), "non-empty string");
  });

  await test("checksum_verify: non-hex 'expected' -> clean error", async () => {
    await expectThrow(() => executeTool("checksum_verify", { path: "a.txt", expected: "not-a-hex-digest!" }), "hex digest");
  });

  await test("checksum_verify: unsupported algorithm -> clean error", async () => {
    await expectThrow(() => executeTool("checksum_verify", { path: "a.txt", expected: "a".repeat(64), algorithm: "sha3" }), "Unsupported algorithm");
  });

  await test("checksum_verify: nonexistent file -> clean error", async () => {
    await expectThrow(() => executeTool("checksum_verify", { path: "missing.txt", expected: "a".repeat(64) }), "ENOENT");
  });

  // ── High (dependency-failure equivalent) ──────────────────────────────
  await test("checksum_verify: source is a directory, not a file -> clean error, no crash", async () => {
    fs.mkdirSync(path.join(TMP, "adir"), { recursive: true });
    await expectThrow(() => executeTool("checksum_verify", { path: "adir", expected: "a".repeat(64) }));
  });

  // ── Critical (security / path traversal) ──────────────────────────────
  await test("checksum_verify: path traversal in 'path' rejected", async () => {
    await expectThrow(() => executeTool("checksum_verify", { path: "../../../../etc/passwd", expected: "a".repeat(64) }), "Access denied");
  });

  await test("checksum_verify: SQL-injection-shaped 'expected' rejected as non-hex, not executed anywhere", async () => {
    await expectThrow(() => executeTool("checksum_verify", { path: "a.txt", expected: "' OR 1=1; --" }), "hex digest");
  });

  await test("checksum_verify: shell-injection-shaped 'expected' rejected as non-hex", async () => {
    await expectThrow(() => executeTool("checksum_verify", { path: "a.txt", expected: "$(whoami)" }), "hex digest");
  });

  // ── Extreme (fuzzing, concurrency, large payloads) ─────────────────────
  await test("checksum_verify: large file (2MB) verifies correctly", async () => {
    const big = crypto.randomBytes(2_000_000);
    fs.writeFileSync(path.join(TMP, "big.bin"), big);
    const expected = sha256(big);
    const r = await executeTool("checksum_verify", { path: "big.bin", expected });
    assertEq(r.match, true);
    assertEq(r.sizeBytes, big.length);
  });

  await test("checksum_verify: empty file (0 bytes) verifies against known empty-sha256", async () => {
    writeSrc("empty.txt", "");
    const expected = sha256(Buffer.alloc(0));
    const r = await executeTool("checksum_verify", { path: "empty.txt", expected });
    assertEq(r.match, true);
    assertEq(r.sizeBytes, 0);
  });

  await test("checksum_verify: extremely long garbage 'expected' string rejected cleanly, no crash", async () => {
    await expectThrow(() => executeTool("checksum_verify", { path: "a.txt", expected: "f".repeat(50000) + "!" }), "hex digest");
  });

  await test("concurrency: 10 parallel checksum_verify calls, consistent results", async () => {
    const expected = sha256(Buffer.from("hello world"));
    const jobs = [];
    for (let i = 0; i < 10; i++) jobs.push(executeTool("checksum_verify", { path: "a.txt", expected }));
    const results = await Promise.all(jobs);
    for (const r of results) assertEq(r.match, true);
  });

  console.log(`\n${counters.pass} passed, ${counters.fail} failed`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(counters.fail > 0 ? 1 : 0);
})();
