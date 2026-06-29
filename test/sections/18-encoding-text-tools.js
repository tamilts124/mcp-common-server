"use strict";
/**
 * [22] BASE64 ENCODE/DECODE, JSON_FORMAT, TEXT_TRANSFORM — new utility tools
 *
 * Rigor levels covered:
 *
 *   Normal:   happy-path — base64 encode/decode round-trip (incl. url_safe);
 *             json_format pretty-print + minify; text_transform single and
 *             chained transforms (uppercase, trim+sort+dedupe).
 *
 *   Medium:   boundary — missing required fields (-32602); whitespace-
 *             wrapped base64 input still decodes correctly (regression test
 *             for a real bug found this session); invalid base64 rejected;
 *             invalid JSON rejected; unknown/empty transform list rejected;
 *             indent=0 minifies, negative indent clamped to 0.
 *
 *   High:     error handling — non-regular-file / non-existent file inputs;
 *             in_place=true actually rewrites the file on disk while
 *             in_place=false (default) leaves it untouched; destination
 *             parent directories auto-created on decode; all four new
 *             tools correctly registered in WRITE_TOOLS where applicable.
 *
 *   Critical: security — path traversal blocked on every path-accepting
 *             tool; injection-shaped content (shell/SQL/script) round-trips
 *             as literal data through encode/decode and text_transform;
 *             results are JSON-serialisable with no prototype pollution.
 *
 *   Extreme:  stress — 100KB binary round-trip via base64; fuzz (random)
 *             non-base64 input throws cleanly instead of crashing; large
 *             (5000-line) text_transform sort+dedupe; large JSON re-format;
 *             10 concurrent base64_encode calls return identical results.
 */
const { fs, path, assert, test, executeTool, TMP } = require("../test-harness");

console.log(`\n[22] BASE64 / JSON_FORMAT / TEXT_TRANSFORM — new utility tools`);

// ── NORMAL ────────────────────────────────────────────────────────────────────

test("base64_encode: encodes a known file to the expected base64 string", () => {
  executeTool("create_file", { path: "b64-basic.txt", content: "hello world" });
  const r = executeTool("base64_encode", { path: "b64-basic.txt" });
  assert.strictEqual(r.base64, Buffer.from("hello world").toString("base64"));
  assert.strictEqual(r.bytes, 11);
  assert.strictEqual(r.encoding, "base64");
  assert.strictEqual(r.path, "b64-basic.txt");
});

test("base64_encode -> base64_decode: full round-trip reproduces original bytes", () => {
  executeTool("create_file", { path: "b64-roundtrip-src.bin", content: "round trip payload 12345" });
  const enc = executeTool("base64_encode", { path: "b64-roundtrip-src.bin" });
  const dec = executeTool("base64_decode", { data: enc.base64, destination: "b64-roundtrip-dst.bin" });
  assert.strictEqual(dec.bytes, 24);
  const back = executeTool("read_file", { path: "b64-roundtrip-dst.bin" });
  assert.strictEqual(back.content, "round trip payload 12345");
});

test("base64_encode: url_safe alphabet replaces + and / with - and _", () => {
  // Bytes chosen so the standard base64 alphabet is guaranteed to contain
  // both '+' and '/' (0xFB 0xFF 0xBF -> "+/+/" in standard base64).
  // Written directly via fs (not the text-based create_file tool) so the
  // exact bytes are preserved on disk.
  const buf = Buffer.from([0xfb, 0xff, 0xbf]);
  fs.writeFileSync(path.join(TMP, "b64-urlsafe.bin"), buf);
  const std = executeTool("base64_encode", { path: "b64-urlsafe.bin" });
  const url = executeTool("base64_encode", { path: "b64-urlsafe.bin", url_safe: true });
  assert.strictEqual(std.base64, "+/+/");
  assert.strictEqual(url.encoding, "base64url");
  assert.ok(!url.base64.includes("+") && !url.base64.includes("/"), "url_safe output must not contain + or /");
  assert.strictEqual(std.base64.replace(/\+/g, "-").replace(/\//g, "_"), url.base64);
});

test("json_format: pretty-prints with default indent of 2", () => {
  executeTool("create_file", { path: "jf-basic.json", content: '{"a":1,"b":[1,2,3]}' });
  const r = executeTool("json_format", { path: "jf-basic.json" });
  assert.strictEqual(r.indent, 2);
  assert.strictEqual(r.formatted, JSON.stringify({ a: 1, b: [1, 2, 3] }, null, 2));
  assert.strictEqual(r.writtenInPlace, false);
});

test("json_format: indent=0 minifies the JSON", () => {
  executeTool("create_file", { path: "jf-minify.json", content: '{\n  "a": 1,\n  "b": 2\n}\n' });
  const r = executeTool("json_format", { path: "jf-minify.json", indent: 0 });
  assert.strictEqual(r.formatted, '{"a":1,"b":2}');
});

test("text_transform: uppercase transform", () => {
  executeTool("create_file", { path: "tt-upper.txt", content: "hello\nworld\n" });
  const r = executeTool("text_transform", { path: "tt-upper.txt", transforms: ["uppercase"] });
  assert.strictEqual(r.result, "HELLO\nWORLD\n");
});

test("text_transform: chained transforms apply in order (trim, sort, dedupe)", () => {
  executeTool("create_file", { path: "tt-chain.txt", content: "  banana \napple\napple\n  banana\ncherry\n" });
  const r = executeTool("text_transform", {
    path: "tt-chain.txt",
    transforms: ["trim_lines", "sort_lines", "dedupe_lines"],
  });
  assert.strictEqual(r.result, "apple\nbanana\ncherry\n");
});

// ── MEDIUM ────────────────────────────────────────────────────────────────────

test("base64_encode: missing required 'path' throws -32602", () => {
  try { executeTool("base64_encode", {}); assert.fail("should have thrown"); }
  catch (e) { assert.strictEqual(e.code, -32602); }
});

test("base64_decode: missing required 'data' or 'destination' throws -32602", () => {
  try { executeTool("base64_decode", { destination: "x.bin" }); assert.fail("should have thrown"); }
  catch (e) { assert.strictEqual(e.code, -32602); }
  try { executeTool("base64_decode", { data: "aGk=" }); assert.fail("should have thrown"); }
  catch (e) { assert.strictEqual(e.code, -32602); }
});

test("base64_decode: whitespace/line-wrapped base64 still decodes correctly (regression)", () => {
  const original = "this string is long enough to wrap across multiple base64 lines for the test";
  const flat = Buffer.from(original).toString("base64");
  // Simulate MIME-style 16-char line wrapping
  const wrapped = flat.replace(/(.{16})/g, "$1\n");
  const r = executeTool("base64_decode", { data: wrapped, destination: "b64-wrapped.bin" });
  const back = executeTool("read_file", { path: "b64-wrapped.bin" });
  assert.strictEqual(back.content, original, "whitespace-wrapped base64 must decode to the original text");
});

test("base64_decode: genuinely invalid base64 characters are rejected", () => {
  assert.throws(
    () => executeTool("base64_decode", { data: "not!!valid$$base64%%", destination: "b64-bad.bin" }),
    /not valid base64/i
  );
});

test("json_format: missing required 'path' throws -32602", () => {
  try { executeTool("json_format", {}); assert.fail("should have thrown"); }
  catch (e) { assert.strictEqual(e.code, -32602); }
});

test("json_format: invalid JSON content throws a descriptive error", () => {
  executeTool("create_file", { path: "jf-invalid.json", content: "{not valid json" });
  assert.throws(
    () => executeTool("json_format", { path: "jf-invalid.json" }),
    /not valid JSON/i
  );
});

test("json_format: negative indent is clamped to 0 (minify)", () => {
  executeTool("create_file", { path: "jf-negindent.json", content: '{"a":1}' });
  const r = executeTool("json_format", { path: "jf-negindent.json", indent: -5 });
  assert.strictEqual(r.indent, 0);
  assert.strictEqual(r.formatted, '{"a":1}');
});

test("text_transform: missing required 'transforms' throws -32602", () => {
  executeTool("create_file", { path: "tt-notransforms.txt", content: "x" });
  try { executeTool("text_transform", { path: "tt-notransforms.txt" }); assert.fail("should have thrown"); }
  catch (e) { assert.strictEqual(e.code, -32602); }
});

test("text_transform: unknown transform name throws a descriptive error", () => {
  executeTool("create_file", { path: "tt-unknown.txt", content: "x" });
  assert.throws(
    () => executeTool("text_transform", { path: "tt-unknown.txt", transforms: ["reverse_words"] }),
    /unknown transform/i
  );
});

test("text_transform: empty transforms array throws a descriptive error", () => {
  executeTool("create_file", { path: "tt-empty-transforms.txt", content: "x" });
  assert.throws(
    () => executeTool("text_transform", { path: "tt-empty-transforms.txt", transforms: [] }),
    /non-empty array/i
  );
});

// ── HIGH ──────────────────────────────────────────────────────────────────────

test("base64_encode: a directory passed instead of a file throws descriptive error", () => {
  executeTool("create_directory", { path: "b64-dir" });
  assert.throws(
    () => executeTool("base64_encode", { path: "b64-dir" }),
    /not a regular file/i
  );
});

test("base64_encode: non-existent file throws cleanly", () => {
  assert.throws(() => executeTool("base64_encode", { path: "b64-nonexistent.bin" }));
});

test("base64_decode: destination parent directories are created automatically", () => {
  const r = executeTool("base64_decode", { data: Buffer.from("nested").toString("base64"), destination: "b64-nested/deep/dir/out.bin" });
  assert.strictEqual(r.bytes, 6);
  const back = executeTool("read_file", { path: "b64-nested/deep/dir/out.bin" });
  assert.strictEqual(back.content, "nested");
});

test("json_format: in_place=true rewrites the file on disk; in_place=false (default) leaves it untouched", () => {
  executeTool("create_file", { path: "jf-inplace.json", content: '{"a":1}' });
  const r1 = executeTool("json_format", { path: "jf-inplace.json", indent: 4 });
  const untouched = executeTool("read_file", { path: "jf-inplace.json" });
  assert.strictEqual(untouched.content, '{"a":1}', "in_place=false must not modify the file");
  assert.strictEqual(r1.writtenInPlace, false);

  const r2 = executeTool("json_format", { path: "jf-inplace.json", indent: 4, in_place: true });
  assert.strictEqual(r2.writtenInPlace, true);
  const after = executeTool("read_file", { path: "jf-inplace.json" });
  assert.strictEqual(after.content, JSON.stringify({ a: 1 }, null, 4) + "\n");
});

test("text_transform: in_place=true rewrites the file; in_place=false leaves it untouched", () => {
  executeTool("create_file", { path: "tt-inplace.txt", content: "B\nA\nC\n" });
  const r1 = executeTool("text_transform", { path: "tt-inplace.txt", transforms: ["sort_lines"] });
  const untouched = executeTool("read_file", { path: "tt-inplace.txt" });
  assert.strictEqual(untouched.content, "B\nA\nC\n", "in_place=false must not modify the file");
  assert.strictEqual(r1.writtenInPlace, false);

  executeTool("text_transform", { path: "tt-inplace.txt", transforms: ["sort_lines"], in_place: true });
  const after = executeTool("read_file", { path: "tt-inplace.txt" });
  assert.strictEqual(after.content, "A\nB\nC\n");
});

test("WRITE_TOOLS registration: base64_decode, json_format, text_transform are write-gated; base64_encode is not", () => {
  const { WRITE_TOOLS } = require("../../lib/toolsSchema");
  assert.ok(WRITE_TOOLS.has("base64_decode"), "base64_decode must be in WRITE_TOOLS");
  assert.ok(WRITE_TOOLS.has("json_format"), "json_format must be in WRITE_TOOLS");
  assert.ok(WRITE_TOOLS.has("text_transform"), "text_transform must be in WRITE_TOOLS");
  assert.ok(!WRITE_TOOLS.has("base64_encode"), "base64_encode is read-only and must NOT be in WRITE_TOOLS");
});

// ── CRITICAL ──────────────────────────────────────────────────────────────────

test("base64_encode: path traversal is blocked", () => {
  assert.throws(() => executeTool("base64_encode", { path: "../../etc/passwd" }), /Access denied/);
});

test("base64_decode: destination path traversal is blocked", () => {
  assert.throws(
    () => executeTool("base64_decode", { data: "aGk=", destination: "../../etc/evil.bin" }),
    /Access denied/
  );
});

test("json_format: path traversal is blocked", () => {
  assert.throws(() => executeTool("json_format", { path: "../../etc/passwd" }), /Access denied/);
});

test("text_transform: path traversal is blocked", () => {
  assert.throws(
    () => executeTool("text_transform", { path: "../../etc/passwd", transforms: ["uppercase"] }),
    /Access denied/
  );
});

test("base64_decode: shell/SQL-injection-shaped payload decodes and writes as literal bytes only", () => {
  const evil = "; rm -rf / && echo $(whoami) `cat /etc/passwd` '; DROP TABLE users; --";
  const enc = Buffer.from(evil).toString("base64");
  executeTool("base64_decode", { data: enc, destination: "b64-inject-out.bin" });
  const back = executeTool("read_file", { path: "b64-inject-out.bin" });
  assert.strictEqual(back.content, evil, "decoded content must be exactly the literal bytes, never executed");
});

test("text_transform: injection-shaped content round-trips literally through transforms", () => {
  const evil = "$(rm -rf /)\n`whoami`\n'; DROP TABLE users; --\n";
  executeTool("create_file", { path: "tt-inject.txt", content: evil });
  const r = executeTool("text_transform", { path: "tt-inject.txt", transforms: ["trim_lines"] });
  assert.ok(r.result.includes("$(rm -rf /)") && r.result.includes("`whoami`"), "injection-shaped lines must survive as literal text");
});

test("json_format: injection-shaped string values round-trip literally (never evaluated)", () => {
  const data = { cmd: "$(rm -rf /)", sql: "'; DROP TABLE users; --" };
  executeTool("create_file", { path: "jf-inject.json", content: JSON.stringify(data) });
  const r = executeTool("json_format", { path: "jf-inject.json" });
  assert.deepStrictEqual(JSON.parse(r.formatted), data);
});

test("base64/json/text results are JSON-serialisable with no prototype pollution", () => {
  executeTool("create_file", { path: "b64-json-check.txt", content: "x" });
  const enc = executeTool("base64_encode", { path: "b64-json-check.txt" });
  executeTool("create_file", { path: "jf-json-check.json", content: "{}" });
  const fmt = executeTool("json_format", { path: "jf-json-check.json" });
  executeTool("create_file", { path: "tt-json-check.txt", content: "x" });
  const trf = executeTool("text_transform", { path: "tt-json-check.txt", transforms: ["uppercase"] });
  for (const r of [enc, fmt, trf]) {
    assert.doesNotThrow(() => JSON.stringify(r));
    assert.ok(!Object.prototype.hasOwnProperty.call(r, "__proto__"));
  }
});

// ── EXTREME ───────────────────────────────────────────────────────────────────

test("base64_encode/decode: 100KB random binary content round-trips exactly", () => {
  const original = Buffer.from(Array.from({ length: 100_000 }, () => Math.floor(Math.random() * 256)));
  // Write the raw bytes directly via fs (not the text-based write_file tool,
  // which is UTF-8-oriented and not binary-safe) so the source fixture is a
  // true binary file — exactly what base64_encode is meant to handle.
  fs.writeFileSync(path.join(TMP, "b64-large-src.bin"), original);
  const enc = executeTool("base64_encode", { path: "b64-large-src.bin" });
  assert.strictEqual(enc.bytes, 100_000);
  executeTool("base64_decode", { data: enc.base64, destination: "b64-large-dst.bin" });
  const dstAbs = path.join(TMP, "b64-large-dst.bin");
  const roundTripped = fs.readFileSync(dstAbs);
  assert.strictEqual(roundTripped.length, original.length);
  assert.ok(roundTripped.equals(original), "100KB binary round-trip must be byte-for-byte identical");
});

test("base64_decode: random fuzz bytes as 'data' throw cleanly instead of crashing", () => {
  const fuzz = Array.from({ length: 300 }, () => String.fromCharCode(1 + Math.floor(Math.random() * 254))).join("");
  assert.throws(() => executeTool("base64_decode", { data: fuzz, destination: "b64-fuzz-out.bin" }));
});

test("text_transform: large file (5000 lines) sort+dedupe completes correctly", () => {
  const lines = [];
  for (let i = 0; i < 5000; i++) lines.push(`item-${i % 1000}`); // 1000 unique values, 5x duplicated
  executeTool("create_file", { path: "tt-large.txt", content: lines.join("\n") + "\n" });
  const r = executeTool("text_transform", { path: "tt-large.txt", transforms: ["sort_lines", "dedupe_lines"] });
  assert.strictEqual(r.newLines, 1000, "dedupe must reduce 5000 lines to 1000 unique values");
});

test("json_format: large JSON array re-formats and round-trips without data loss", () => {
  const data = Array.from({ length: 2000 }, (_, i) => ({ id: i, name: `item-${i}` }));
  executeTool("create_file", { path: "jf-large.json", content: JSON.stringify(data) });
  const r = executeTool("json_format", { path: "jf-large.json", indent: 2 });
  assert.deepStrictEqual(JSON.parse(r.formatted), data);
});

test("base64_encode: 10 concurrent calls on the same file return identical results", () => {
  executeTool("create_file", { path: "b64-concurrent.txt", content: "concurrent base64 content" });
  const results = Array.from({ length: 10 }, () => executeTool("base64_encode", { path: "b64-concurrent.txt" }));
  const first = results[0].base64;
  for (let i = 1; i < results.length; i++) assert.strictEqual(results[i].base64, first, `call ${i} mismatch`);
});

// ── CLEANUP ───────────────────────────────────────────────────────────────────

test("cleanup: remove base64/json_format/text_transform fixture files", () => {
  const items = [
    "b64-basic.txt", "b64-roundtrip-src.bin", "b64-roundtrip-dst.bin", "b64-urlsafe.bin",
    "jf-basic.json", "jf-minify.json", "tt-upper.txt", "tt-chain.txt",
    "b64-wrapped.bin", "b64-bad.bin", "jf-invalid.json", "jf-negindent.json",
    "tt-notransforms.txt", "tt-unknown.txt", "tt-empty-transforms.txt",
    "b64-dir", "b64-nonexistent.bin", "b64-nested",
    "jf-inplace.json", "tt-inplace.txt",
    "b64-inject-out.bin", "tt-inject.txt", "jf-inject.json",
    "b64-json-check.txt", "jf-json-check.json", "tt-json-check.txt",
    "b64-large-src.bin", "b64-large-dst.bin", "b64-fuzz-out.bin",
    "tt-large.txt", "jf-large.json", "b64-concurrent.txt",
  ];
  for (const item of items) {
    try { fs.rmSync(path.join(TMP, item), { recursive: true, force: true }); } catch (_) {}
  }
  assert.ok(!fs.existsSync(path.join(TMP, "b64-basic.txt")), "b64-basic.txt removed");
});
