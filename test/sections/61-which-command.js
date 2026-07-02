"use strict";
/**
 * [61] WHICH COMMAND — which_command tool (PATH executable resolution).
 *
 * Rigor levels covered:
 *   Normal:   resolves a known-installed executable (node) with correct shape
 *   Medium:   missing/empty/non-string 'command' -> -32602; unknown command
 *             returns found:false with empty allMatches, not an error
 *   High:     PATH duplicated entries dedupe to a single match (regression
 *             test for the bug found this session); works when PATH is unset
 *   Critical: path-separator-containing input rejected (not a path oracle);
 *             shell-injection-shaped command names return found:false safely,
 *             never executed
 *   Extreme:  100 rapid repeated calls consistent; long/garbage command names
 *             don't throw; result is valid JSON
 */
const { assert, test, executeTool, ToolError, getErrorCode } = require("../test-harness");

console.log(`\n[61] WHICH COMMAND — which_command tool`);

const KNOWN_CMD = "node"; // the test runner itself is running under node

// ── NORMAL — happy path ──────────────────────────────────────────────────
test("which_command: resolves 'node' successfully", () => {
  const r = executeTool("which_command", { command: KNOWN_CMD });
  assert.ok(r.found === true, "node should be found on PATH");
  assert.ok(typeof r.resolvedPath === "string" && r.resolvedPath.length > 0, "resolvedPath must be a non-empty string");
});

test("which_command: returns correct shape", () => {
  const r = executeTool("which_command", { command: KNOWN_CMD });
  assert.strictEqual(r.command, KNOWN_CMD, "command must be echoed back");
  assert.ok(typeof r.platform === "string", "platform must be a string");
  assert.ok(Array.isArray(r.allMatches), "allMatches must be an array");
  assert.ok(r.allMatches.length >= 1, "allMatches should have at least one entry for a found command");
});

test("which_command: resolvedPath is the first entry in allMatches", () => {
  const r = executeTool("which_command", { command: KNOWN_CMD });
  assert.strictEqual(r.resolvedPath, r.allMatches[0], "resolvedPath must equal allMatches[0]");
});

// ── MEDIUM — parameter validation ────────────────────────────────────────
test("which_command: missing 'command' throws -32602", () => {
  assert.throws(() => executeTool("which_command", {}), (e) => getErrorCode(e) === -32602);
});

test("which_command: empty string 'command' throws -32602", () => {
  assert.throws(() => executeTool("which_command", { command: "" }), (e) => getErrorCode(e) === -32602);
});

test("which_command: whitespace-only 'command' throws -32602", () => {
  assert.throws(() => executeTool("which_command", { command: "   " }), (e) => getErrorCode(e) === -32602);
});

test("which_command: non-string 'command' (number) throws -32602", () => {
  assert.throws(() => executeTool("which_command", { command: 42 }), (e) => getErrorCode(e) === -32602);
});

test("which_command: unknown command returns found:false, not an error", () => {
  const r = executeTool("which_command", { command: "definitely_not_a_real_command_xyz123" });
  assert.strictEqual(r.found, false, "unknown command must not be found");
  assert.strictEqual(r.resolvedPath, null, "resolvedPath must be null when not found");
  assert.deepStrictEqual(r.allMatches, [], "allMatches must be empty when not found");
});

// ── HIGH — dedupe regression + degraded environment ──────────────────────
test("which_command: duplicate PATH directories dedupe to a single match (regression)", () => {
  const originalPath = process.env.PATH;
  try {
    const nodeDir = require("path").dirname(process.execPath);
    process.env.PATH = [nodeDir, nodeDir, nodeDir].join(require("path").delimiter);
    const r = executeTool("which_command", { command: KNOWN_CMD });
    assert.strictEqual(r.allMatches.length, 1, `expected exactly 1 deduped match, got ${r.allMatches.length}`);
  } finally {
    process.env.PATH = originalPath;
  }
});

test("which_command: empty PATH degrades gracefully (found:false, no throw)", () => {
  const originalPath = process.env.PATH;
  const originalPath2 = process.env.Path;
  try {
    process.env.PATH = "";
    process.env.Path = "";
    const r = executeTool("which_command", { command: KNOWN_CMD });
    assert.strictEqual(r.found, false, "with empty PATH nothing should be found");
  } finally {
    process.env.PATH = originalPath;
    process.env.Path = originalPath2;
  }
});

// ── CRITICAL — not a path oracle, injection-safe ─────────────────────────
test("which_command: forward-slash path separator rejected", () => {
  assert.throws(() => executeTool("which_command", { command: "a/b" }), (e) => getErrorCode(e) === -32602);
});

test("which_command: backslash path separator rejected", () => {
  assert.throws(() => executeTool("which_command", { command: "a\\b" }), (e) => getErrorCode(e) === -32602);
});

test("which_command: path traversal shaped input rejected", () => {
  assert.throws(() => executeTool("which_command", { command: "../../../etc/passwd" }), (e) => getErrorCode(e) === -32602);
});

test("which_command: absolute path input rejected (not a path oracle)", () => {
  assert.throws(() => executeTool("which_command", { command: "/usr/bin/node" }), (e) => getErrorCode(e) === -32602);
});

test("which_command: shell-injection-shaped command name is treated as a literal PATH lookup, never executed", () => {
  const r = executeTool("which_command", { command: "node;echo pwned" });
  // The whole string (including ';echo pwned') is looked up as one literal
  // filename on PATH — nothing is shelled out, so this just isn't found.
  assert.strictEqual(r.found, false, "injection-shaped literal command name should not resolve to anything");
});

test("which_command: null-byte-shaped command name does not crash the process", () => {
  const r = executeTool("which_command", { command: "node\0evil" });
  assert.strictEqual(r.found, false, "null-byte-embedded command name should safely resolve to not-found, not crash");
});

// ── EXTREME — fuzzing / stress ────────────────────────────────────────────
test("which_command: 100 rapid repeated calls are consistent", () => {
  let last = null;
  for (let i = 0; i < 100; i++) {
    const r = executeTool("which_command", { command: KNOWN_CMD });
    if (last) assert.deepStrictEqual(r, last, `iteration ${i} inconsistent with previous result`);
    last = r;
  }
});

test("which_command: very long garbage command name does not throw unexpectedly", () => {
  const r = executeTool("which_command", { command: "x".repeat(5000) });
  assert.strictEqual(r.found, false, "5000-char garbage name should simply not be found");
});

test("which_command: unicode/emoji command name handled safely", () => {
  const r = executeTool("which_command", { command: "\u{1F600}\u{1F4A9}" });
  assert.strictEqual(r.found, false, "emoji command name should simply not be found");
});

test("which_command: result is valid JSON (round-trips through JSON.stringify/parse)", () => {
  const r = executeTool("which_command", { command: KNOWN_CMD });
  const roundTripped = JSON.parse(JSON.stringify(r));
  assert.deepStrictEqual(roundTripped, r, "result must be valid, lossless JSON");
});
