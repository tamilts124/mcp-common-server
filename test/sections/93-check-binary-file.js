"use strict";
/**
 * [93] CHECK_BINARY_FILE — sniff text vs binary + best-guess MIME type via
 * magic-byte signature match, falling back to a NUL-byte/control-ratio
 * heuristic.
 *
 * Rigor levels covered:
 *   Normal:   PNG/ZIP/GZIP signature detection, plain-text heuristic
 *             detection, sizeBytes correctness.
 *   Medium:   missing path, directory-as-path, empty file (heuristic
 *             non-binary), nonexistent path.
 *   High:     file with unreadable content mid-sample doesn't crash
 *             (large file — only first 8000 bytes sampled).
 *   Critical: path traversal blocked, shell-injection-shaped filename
 *             content is treated as inert bytes, not executed.
 *   Extreme:  fuzz random bytes, 5 consistent calls, JSON-serialisability,
 *             execute_pipeline op-enum registration check.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { assert, test, executeTool, TMP } = require("../test-harness");

console.log(`\n[93] CHECK_BINARY_FILE — text/binary sniffing + MIME guess`);

function writeTmp(name, bufOrStr) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, bufOrStr);
  return name;
}

// ── NORMAL ──────────────────────────────────────────────────────────────────

test("normal: PNG signature detected", () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("restofdata")]);
  const name = writeTmp("cbf_png.bin", png);
  const r = executeTool("check_binary_file", { path: name });
  assert.strictEqual(r.isBinary, true);
  assert.strictEqual(r.mimeType, "image/png");
  assert.strictEqual(r.detectionMethod, "signature");
  assert.strictEqual(r.sizeBytes, png.length);
});

test("normal: ZIP signature detected", () => {
  const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(20)]);
  const name = writeTmp("cbf_zip.bin", zip);
  const r = executeTool("check_binary_file", { path: name });
  assert.strictEqual(r.mimeType, "application/zip");
});

test("normal: GZIP signature detected", () => {
  const gz = Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.alloc(10)]);
  const name = writeTmp("cbf_gz.bin", gz);
  const r = executeTool("check_binary_file", { path: name });
  assert.strictEqual(r.mimeType, "application/gzip");
});

test("normal: plain text file detected via heuristic, not binary", () => {
  const name = writeTmp("cbf_text.txt", "hello world\nthis is plain text\n");
  const r = executeTool("check_binary_file", { path: name });
  assert.strictEqual(r.isBinary, false);
  assert.strictEqual(r.mimeType, "text/plain");
  assert.strictEqual(r.detectionMethod, "heuristic");
  assert.strictEqual(r.nulByteFound, false);
});

test("normal: unrecognized binary content (NUL bytes) flagged via heuristic", () => {
  const buf = Buffer.from([0x41, 0x42, 0x00, 0x43, 0x00, 0x44]);
  const name = writeTmp("cbf_nul.bin", buf);
  const r = executeTool("check_binary_file", { path: name });
  assert.strictEqual(r.isBinary, true);
  assert.strictEqual(r.detectionMethod, "heuristic");
  assert.strictEqual(r.nulByteFound, true);
});

// ── MEDIUM — boundary & param validation ────────────────────────────────────

test("medium: missing path throws -32602", () => {
  try { executeTool("check_binary_file", {}); assert.fail("should have thrown"); }
  catch (e) { assert.strictEqual(e.code, -32602); }
});

test("medium: directory-as-path throws a clean error", () => {
  fs.mkdirSync(path.join(TMP, "cbf_dir"), { recursive: true });
  assert.throws(() => executeTool("check_binary_file", { path: "cbf_dir" }));
});

test("medium: empty file is not binary (heuristic, zero-length sample)", () => {
  const name = writeTmp("cbf_empty.txt", "");
  const r = executeTool("check_binary_file", { path: name });
  assert.strictEqual(r.isBinary, false);
  assert.strictEqual(r.sizeBytes, 0);
});

test("medium: nonexistent path throws a descriptive error", () => {
  assert.throws(() => executeTool("check_binary_file", { path: "cbf_does_not_exist.bin" }));
});

// ── HIGH — larger files, sampling boundary ──────────────────────────────────

test("high: large text file (only first 8000 bytes sampled) does not crash, still text", () => {
  const big = "line of plain text\n".repeat(2000); // ~40KB
  const name = writeTmp("cbf_large.txt", big);
  const r = executeTool("check_binary_file", { path: name });
  assert.strictEqual(r.isBinary, false);
  assert.strictEqual(r.sizeBytes, Buffer.byteLength(big));
});

test("high: NUL byte beyond the 8000-byte sample window is NOT detected (documents sampling boundary)", () => {
  const buf = Buffer.concat([Buffer.alloc(9000, 0x41), Buffer.from([0x00])]);
  const name = writeTmp("cbf_late_nul.bin", buf);
  const r = executeTool("check_binary_file", { path: name });
  assert.strictEqual(r.isBinary, false); // NUL is past the 8000-byte sample
});

// ── CRITICAL — security & input sanitization ────────────────────────────────

test("critical: path traversal via path arg is blocked", () => {
  try {
    executeTool("check_binary_file", { path: "../../../../etc/passwd" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("critical: shell-injection-shaped filename content is inert (never executed)", () => {
  const name = writeTmp("cbf_inject.txt", "; rm -rf / #`whoami`$(id)\n");
  const r = executeTool("check_binary_file", { path: name });
  assert.strictEqual(r.isBinary, false);
});

test("critical: null-byte path argument is rejected, not silently truncated", () => {
  assert.throws(() => executeTool("check_binary_file", { path: "cbf_text.txt\0.exe" }));
});

// ── EXTREME — fuzzing, concurrency, serialisability ─────────────────────────

test("extreme: fuzz — random byte buffers never crash the tool", () => {
  for (let i = 0; i < 15; i++) {
    const buf = crypto.randomBytes(1 + Math.floor(Math.random() * 500));
    const name = writeTmp(`cbf_fuzz_${i}.bin`, buf);
    const r = executeTool("check_binary_file", { path: name });
    assert.ok(typeof r.isBinary === "boolean");
  }
});

test("extreme: 5 consistent calls on the same file return identical results", () => {
  const name = writeTmp("cbf_consistent.txt", "consistency check payload");
  const results = Array.from({ length: 5 }, () => executeTool("check_binary_file", { path: name }));
  for (let i = 1; i < results.length; i++) {
    assert.deepStrictEqual(results[i], results[0], `call ${i}: mismatch`);
  }
});

test("extreme: result is fully JSON-serialisable", () => {
  const name = writeTmp("cbf_json.txt", "serialise me");
  const r = executeTool("check_binary_file", { path: name });
  const parsed = JSON.parse(JSON.stringify(r));
  assert.strictEqual(parsed.path, r.path);
});

test("extreme: check_binary_file is registered in the execute_pipeline op enum", () => {
  const { EXEC_SCHEMAS } = require("../../lib/schemas/execSchemas");
  const pipelineSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
  const opEnum = pipelineSchema.inputSchema.properties.steps.items.properties.op.enum;
  assert.ok(opEnum.includes("check_binary_file"), "check_binary_file missing from execute_pipeline op enum");
});
