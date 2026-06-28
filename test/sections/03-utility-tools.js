"use strict";
/**
 * [7] UTILITY TOOLS — file_checksum, zip_directory, query_json.
 */
const { fs, path, assert, test, executeTool, resolveClientPath } = require("../test-harness");

console.log(`\n[7] UTILITY TOOLS — file_checksum, zip_directory, query_json`);

// ── file_checksum ──────────────────────────────────────────────────────────
test("file_checksum: sha256 of a known file produces consistent hex", () => {
  executeTool("create_file", { path: "chk.txt", content: "hello checksum" });
  const r = executeTool("file_checksum", { path: "chk.txt" });
  assert.strictEqual(r.algorithm, "sha256");
  assert.match(r.hex, /^[0-9a-f]{64}$/);  // 256-bit = 64 hex chars
  assert.strictEqual(r.sizeBytes, Buffer.byteLength("hello checksum"));
});

test("file_checksum: same content produces same hash (determinism)", () => {
  executeTool("create_file", { path: "chk2.txt", content: "hello checksum" });
  const r1 = executeTool("file_checksum", { path: "chk.txt" });
  const r2 = executeTool("file_checksum", { path: "chk2.txt" });
  assert.strictEqual(r1.hex, r2.hex);
});

test("file_checksum: md5 algorithm produces 32-char hex", () => {
  const r = executeTool("file_checksum", { path: "chk.txt", algorithm: "md5" });
  assert.strictEqual(r.algorithm, "md5");
  assert.match(r.hex, /^[0-9a-f]{32}$/);
});

test("file_checksum: sha512 algorithm produces 128-char hex", () => {
  const r = executeTool("file_checksum", { path: "chk.txt", algorithm: "sha512" });
  assert.strictEqual(r.algorithm, "sha512");
  assert.match(r.hex, /^[0-9a-f]{128}$/);
});

test("file_checksum: unsupported algorithm throws descriptive error", () => {
  assert.throws(
    () => executeTool("file_checksum", { path: "chk.txt", algorithm: "blake3" }),
    /Unsupported algorithm/
  );
});

test("file_checksum: missing path throws -32602", () => {
  try {
    executeTool("file_checksum", {});
    assert.fail("should have thrown");
  } catch (e) {
    assert.strictEqual(e.code, -32602);
  }
});

test("file_checksum: non-existent file throws (not silent)", () => {
  assert.throws(() => executeTool("file_checksum", { path: "ghost_chk.txt" }));
});

test("file_checksum: path traversal blocked on file_checksum", () => {
  assert.throws(
    () => executeTool("file_checksum", { path: "../../etc/passwd" }),
    /Access denied/
  );
});

// ── zip_directory ──────────────────────────────────────────────────────────
test("zip_directory: archives a populated dir and returns valid metadata", () => {
  // Create a small dir tree to zip
  executeTool("create_directory", { path: "zipme" });
  executeTool("create_file", { path: "zipme/a.txt",    content: "file a" });
  executeTool("create_file", { path: "zipme/b.txt",    content: "file b" });
  executeTool("create_directory", { path: "zipme/sub" });
  executeTool("create_file", { path: "zipme/sub/c.txt", content: "nested c" });

  const r = executeTool("zip_directory", { path: "zipme", destination: "out.zip" });
  assert.strictEqual(r.filesArchived, 3);
  assert.ok(r.sizeBytes > 0, "zip should have non-zero size");
  // Verify the zip was actually written inside the temp root
  const { resolved } = resolveClientPath("out.zip");
  const buf = fs.readFileSync(resolved);
  // Check ZIP magic bytes (PK\x03\x04)
  assert.strictEqual(buf[0], 0x50); // P
  assert.strictEqual(buf[1], 0x4b); // K
  assert.strictEqual(buf[2], 0x03);
  assert.strictEqual(buf[3], 0x04);
});

test("zip_directory: empty dir produces valid zip (0 files, still has EOCD)", () => {
  executeTool("create_directory", { path: "emptydir" });
  const r = executeTool("zip_directory", { path: "emptydir", destination: "empty.zip" });
  assert.strictEqual(r.filesArchived, 0);
  assert.ok(r.sizeBytes >= 22, "EOCD alone is 22 bytes"); // EOCD is always present
});

test("zip_directory: path traversal on source blocked", () => {
  assert.throws(
    () => executeTool("zip_directory", { path: "../../", destination: "evil.zip" }),
    /Access denied/
  );
});

test("zip_directory: non-directory source throws descriptive error", () => {
  assert.throws(
    () => executeTool("zip_directory", { path: "chk.txt", destination: "notdir.zip" }),
    /not a directory/
  );
});

test("zip_directory: missing path throws -32602", () => {
  try {
    executeTool("zip_directory", { destination: "x.zip" });
    assert.fail("should have thrown");
  } catch (e) {
    assert.strictEqual(e.code, -32602);
  }
});

// ── query_json ─────────────────────────────────────────────────────────────
const SAMPLE_JSON = JSON.stringify({
  name: "mcp-common-server",
  version: "3.0.0",
  nested: { deep: { value: 42 } },
  items: [{ id: 1, label: "one" }, { id: 2, label: "two" }],
  nullField: null,
});

test("query_json: empty query returns full document", () => {
  executeTool("create_file", { path: "sample.json", content: SAMPLE_JSON });
  const r = executeTool("query_json", { path: "sample.json" });
  assert.strictEqual(r.type, "object");
  assert.strictEqual(r.value.name, "mcp-common-server");
});

test("query_json: top-level string field", () => {
  const r = executeTool("query_json", { path: "sample.json", query: "name" });
  assert.strictEqual(r.value, "mcp-common-server");
  assert.strictEqual(r.type, "string");
});

test("query_json: dot-path into nested object", () => {
  const r = executeTool("query_json", { path: "sample.json", query: "nested.deep.value" });
  assert.strictEqual(r.value, 42);
  assert.strictEqual(r.type, "number");
});

test("query_json: array element by index", () => {
  const r = executeTool("query_json", { path: "sample.json", query: "items.1.label" });
  assert.strictEqual(r.value, "two");
});

test("query_json: null field returns type 'null'", () => {
  const r = executeTool("query_json", { path: "sample.json", query: "nullField" });
  assert.strictEqual(r.value, null);
  assert.strictEqual(r.type, "null");
});

test("query_json: array root returns type 'array'", () => {
  const r = executeTool("query_json", { path: "sample.json", query: "items" });
  assert.strictEqual(r.type, "array");
  assert.strictEqual(r.value.length, 2);
});

test("query_json: invalid path throws descriptive error", () => {
  assert.throws(
    () => executeTool("query_json", { path: "sample.json", query: "nested.bogus.xyz" }),
    /does not exist/
  );
});

test("query_json: invalid JSON file throws SyntaxError", () => {
  executeTool("create_file", { path: "bad.json", content: "{ not valid json [}" });
  assert.throws(() => executeTool("query_json", { path: "bad.json" }), /SyntaxError|JSON/i);
});

test("query_json: missing path throws -32602", () => {
  try {
    executeTool("query_json", {});
    assert.fail("should have thrown");
  } catch (e) {
    assert.strictEqual(e.code, -32602);
  }
});

test("query_json: path traversal blocked", () => {
  assert.throws(
    () => executeTool("query_json", { path: "../../../etc/passwd", query: "" }),
    /Access denied/
  );
});
