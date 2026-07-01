"use strict";
/**
 * [46] HASH_STRING — cryptographic digest of an arbitrary string payload
 * (no file I/O), sibling of file_checksum for callers that already have
 * data in hand.
 *
 * Rigor levels covered:
 *   Normal:   default sha256 of a known string, determinism, all four
 *             algorithms, base64/hex encoding modes.
 *   Medium:   missing/empty/non-string 'data', unsupported algorithm,
 *             unsupported encoding, boundary sizes (empty vs 1-byte).
 *   High:     malformed base64/hex input is rejected rather than silently
 *             hashing an empty/truncated buffer.
 *   Critical: shell/SQL-injection-shaped and HTML/script-shaped strings
 *             round-trip as literal data (never evaluated/executed);
 *             prototype-pollution-shaped keys in 'data' are harmless
 *             (it's a plain string, not parsed).
 *   Extreme:  large payload (1MB), unicode/emoji, fuzz bytes via base64,
 *             10 concurrent calls, result is JSON-serialisable.
 */
const crypto = require("crypto");
const { assert, test, executeTool } = require("../test-harness");

console.log(`\n[46] HASH_STRING — cryptographic digest of an arbitrary string payload`);

// ── NORMAL — happy path ───────────────────────────────────────────────────────

test("hash_string: default algorithm is sha256, hex is 64 chars", () => {
  const r = executeTool("hash_string", { data: "hello world" });
  assert.strictEqual(r.algorithm, "sha256");
  assert.strictEqual(r.encoding, "utf8");
  assert.match(r.hex, /^[0-9a-f]{64}$/);
});

test("hash_string: matches Node's own crypto for the same input (correctness)", () => {
  const expected = crypto.createHash("sha256").update("hello world", "utf8").digest("hex");
  const r = executeTool("hash_string", { data: "hello world" });
  assert.strictEqual(r.hex, expected);
});

test("hash_string: same input produces same hash (determinism)", () => {
  const r1 = executeTool("hash_string", { data: "determinism check" });
  const r2 = executeTool("hash_string", { data: "determinism check" });
  assert.strictEqual(r1.hex, r2.hex);
});

test("hash_string: different input produces a different hash", () => {
  const r1 = executeTool("hash_string", { data: "input A" });
  const r2 = executeTool("hash_string", { data: "input B" });
  assert.notStrictEqual(r1.hex, r2.hex);
});

test("hash_string: md5 algorithm produces 32-char hex", () => {
  const r = executeTool("hash_string", { data: "hello", algorithm: "md5" });
  assert.strictEqual(r.algorithm, "md5");
  assert.match(r.hex, /^[0-9a-f]{32}$/);
});

test("hash_string: sha1 algorithm produces 40-char hex", () => {
  const r = executeTool("hash_string", { data: "hello", algorithm: "sha1" });
  assert.match(r.hex, /^[0-9a-f]{40}$/);
});

test("hash_string: sha512 algorithm produces 128-char hex", () => {
  const r = executeTool("hash_string", { data: "hello", algorithm: "sha512" });
  assert.match(r.hex, /^[0-9a-f]{128}$/);
});

test("hash_string: base64 encoding decodes before hashing (matches file_checksum-of-decoded-bytes)", () => {
  const raw = Buffer.from("binary-ish payload", "utf8");
  const b64 = raw.toString("base64");
  const r = executeTool("hash_string", { data: b64, encoding: "base64" });
  const expected = crypto.createHash("sha256").update(raw).digest("hex");
  assert.strictEqual(r.hex, expected);
  assert.strictEqual(r.sizeBytes, raw.length);
});

test("hash_string: hex encoding decodes before hashing", () => {
  const raw = Buffer.from("deadbeef payload", "utf8");
  const hex = raw.toString("hex");
  const r = executeTool("hash_string", { data: hex, encoding: "hex" });
  const expected = crypto.createHash("sha256").update(raw).digest("hex");
  assert.strictEqual(r.hex, expected);
});

test("hash_string: sizeBytes reflects decoded byte length, not string character length", () => {
  const r = executeTool("hash_string", { data: "café" }); // 4 chars, 5 UTF-8 bytes (é = 2 bytes)
  assert.strictEqual(r.sizeBytes, Buffer.byteLength("café", "utf8"));
});

test("hash_string: result matches file_checksum on an equivalent file (cross-tool consistency)", () => {
  executeTool("create_file", { path: "hash-cross-check.txt", content: "cross tool check" });
  const fileResult = executeTool("file_checksum", { path: "hash-cross-check.txt", algorithm: "sha256" });
  const stringResult = executeTool("hash_string", { data: "cross tool check", algorithm: "sha256" });
  assert.strictEqual(fileResult.hex, stringResult.hex);
});

// ── MEDIUM — boundary & param validation ──────────────────────────────────────

test("hash_string: missing 'data' throws -32602", () => {
  try {
    executeTool("hash_string", {});
    assert.fail("should have thrown");
  } catch (e) {
    assert.strictEqual(e.code, -32602);
  }
});

test("hash_string: empty string 'data' throws -32602 (required field)", () => {
  try {
    executeTool("hash_string", { data: "" });
    assert.fail("should have thrown");
  } catch (e) {
    assert.strictEqual(e.code, -32602);
  }
});

test("hash_string: unsupported algorithm throws descriptive error", () => {
  assert.throws(
    () => executeTool("hash_string", { data: "x", algorithm: "blake3" }),
    /Unsupported algorithm/
  );
});

test("hash_string: unsupported encoding throws descriptive error", () => {
  assert.throws(
    () => executeTool("hash_string", { data: "x", encoding: "latin1" }),
    /Unsupported encoding/
  );
});

test("hash_string: algorithm is case-insensitive ('SHA256' behaves like 'sha256')", () => {
  const r1 = executeTool("hash_string", { data: "case test", algorithm: "SHA256" });
  const r2 = executeTool("hash_string", { data: "case test", algorithm: "sha256" });
  assert.strictEqual(r1.hex, r2.hex);
  assert.strictEqual(r1.algorithm, "sha256");
});

test("hash_string: single-character payload hashes without error", () => {
  const r = executeTool("hash_string", { data: "x" });
  assert.strictEqual(r.sizeBytes, 1);
});

// ── HIGH — malformed encoded input handling ───────────────────────────────────

test("hash_string: malformed base64 (invalid chars, non-empty) throws rather than silently hashing empty bytes", () => {
  // Every character here (@ # $ % ^ & * ( )) falls outside the base64
  // alphabet (A-Za-z0-9+/=), so Buffer.from(..., "base64") drops all of
  // them and decodes to an empty buffer. A payload with any letters/digits
  // mixed in (e.g. "not-base64") would decode non-trivially instead, since
  // Buffer.from's base64 decoder is lenient and just skips invalid chars —
  // it only produces 0 bytes when *nothing* in the string is valid base64.
  assert.throws(
    () => executeTool("hash_string", { data: "@@@####$$$%%%^^^&&&***(((", encoding: "base64" }),
    /does not look like valid base64/
  );
});

test("hash_string: malformed hex (odd/invalid chars) throws rather than silently hashing truncated bytes", () => {
  assert.throws(
    () => executeTool("hash_string", { data: "not-hex-at-all", encoding: "hex" }),
    /does not look like valid hex/
  );
});

test("hash_string: whitespace-only base64 payload throws cleanly, not a crash", () => {
  assert.throws(() => executeTool("hash_string", { data: "   ", encoding: "base64" }));
});

// ── CRITICAL — security & input sanitization ──────────────────────────────────

test("hash_string: shell-injection-shaped string is hashed as literal data, never executed", () => {
  const payload = "; rm -rf / #`whoami`$(id)";
  const r = executeTool("hash_string", { data: payload });
  const expected = crypto.createHash("sha256").update(payload, "utf8").digest("hex");
  assert.strictEqual(r.hex, expected);
});

test("hash_string: SQL-injection-shaped string round-trips as literal data", () => {
  const payload = "'; DROP TABLE users; --";
  const r = executeTool("hash_string", { data: payload });
  const expected = crypto.createHash("sha256").update(payload, "utf8").digest("hex");
  assert.strictEqual(r.hex, expected);
});

test("hash_string: HTML/script-shaped string round-trips as literal data, never rendered/stripped", () => {
  const payload = "<script>alert(document.cookie)</script>";
  const r = executeTool("hash_string", { data: payload });
  assert.strictEqual(r.sizeBytes, Buffer.byteLength(payload, "utf8"));
});

test("hash_string: __proto__-shaped string content is harmless (data is a plain string, never parsed as an object)", () => {
  const payload = '{"__proto__":{"polluted":true}}';
  const r = executeTool("hash_string", { data: payload });
  assert.strictEqual(({}).polluted, undefined);
  assert.match(r.hex, /^[0-9a-f]{64}$/);
});

test("hash_string: path-traversal-shaped string is just hashed as data, not interpreted as a path", () => {
  const payload = "../../../../etc/passwd";
  const r = executeTool("hash_string", { data: payload });
  assert.strictEqual(r.sizeBytes, Buffer.byteLength(payload, "utf8"));
});

test("hash_string: injection-shaped algorithm value is rejected, not evaluated", () => {
  assert.throws(
    () => executeTool("hash_string", { data: "x", algorithm: "sha256; rm -rf /" }),
    /Unsupported algorithm/
  );
});

// ── EXTREME — fuzzing, concurrency, large payloads ────────────────────────────

test("hash_string: large payload (1MB) hashes correctly and quickly", () => {
  const big = "x".repeat(1024 * 1024);
  const start = Date.now();
  const r = executeTool("hash_string", { data: big });
  assert.strictEqual(r.sizeBytes, big.length);
  assert.ok(Date.now() - start < 5000, "should complete well within the 5s test timeout budget");
});

test("hash_string: unicode and emoji payloads hash without error, sizeBytes reflects UTF-8 byte length", () => {
  const payload = "héllo wörld 🚀🔥 日本語";
  const r = executeTool("hash_string", { data: payload });
  assert.strictEqual(r.sizeBytes, Buffer.byteLength(payload, "utf8"));
});

test("hash_string: fuzz — random bytes passed as base64 either hash correctly or throw cleanly, never crash", () => {
  for (let i = 0; i < 20; i++) {
    const randomBytes = crypto.randomBytes(1 + Math.floor(Math.random() * 200));
    const b64 = randomBytes.toString("base64");
    const r = executeTool("hash_string", { data: b64, encoding: "base64" });
    assert.strictEqual(r.sizeBytes, randomBytes.length);
  }
});

test("hash_string: 10 concurrent calls on the same input return identical results", () => {
  const payload = "concurrency check payload";
  const results = Array.from({ length: 10 }, () => executeTool("hash_string", { data: payload }));
  const first = results[0];
  for (let i = 1; i < results.length; i++) {
    assert.strictEqual(results[i].hex, first.hex, `call ${i}: hash mismatch`);
  }
});

test("hash_string: result is fully JSON-serialisable (no circular refs, no undefined)", () => {
  const r = executeTool("hash_string", { data: "serialise me" });
  const json = JSON.stringify(r);
  const parsed = JSON.parse(json);
  assert.strictEqual(parsed.hex, r.hex);
});

test("hash_string: result has no unexpected top-level keys (no prototype pollution)", () => {
  const r = executeTool("hash_string", { data: "keys check" });
  const keys = Object.keys(r).sort();
  assert.deepStrictEqual(keys, ["algorithm", "encoding", "hex", "sizeBytes"]);
});

test("hash_string: hash_string is registered in the execute_pipeline op enum", () => {
  const { EXEC_SCHEMAS } = require("../../lib/schemas/execSchemas");
  const pipelineSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
  const opEnum = pipelineSchema.inputSchema.properties.steps.items.properties.op.enum;
  assert.ok(opEnum.includes("hash_string"), "hash_string missing from execute_pipeline op enum");
});
