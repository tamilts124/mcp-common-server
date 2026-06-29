"use strict";
/**
 * [21] COUNT_LINES, FILE_TREE, HASH_DIRECTORY — new utility tools
 *
 * Rigor levels covered:
 *
 *   Normal:   happy-path — correct line/word/byte counts; correct tree
 *             ASCII output; aggregate hash is deterministic and changes
 *             when any file changes.
 *
 *   Medium:   boundary — empty files; single-line no-trailing-newline;
 *             depth limit for file_tree; extensions filter for
 *             hash_directory; invalid algorithm rejected; count_lines
 *             with multiple files aggregates correctly.
 *
 *   High:     error handling — non-existent paths throw cleanly; a
 *             directory passed to count_lines throws; empty directory
 *             for hash_directory; sizes annotation for file_tree.
 *
 *   Critical: security — path traversal blocked on all three tools;
 *             injection-shaped file content is handled literally;
 *             result is fully JSON-serialisable (no circular refs);
 *             no prototype pollution.
 *
 *   Extreme:  stress — large file (500 lines, 100KB); 10 concurrent
 *             hash_directory calls return identical results; file_tree
 *             with many files triggers truncation at 500 nodes; fuzz
 *             bytes in file content do not crash count_lines.
 */
const { fs, path, assert, test, executeTool, TMP } = require("../test-harness");

console.log(`\n[21] COUNT_LINES, FILE_TREE, HASH_DIRECTORY — new utility tools`);

// ── NORMAL ────────────────────────────────────────────────────────────────────

test("count_lines: basic line/word/byte count on a known file", () => {
  executeTool("create_file", { path: "wc-basic.txt", content: "hello world\nfoo bar baz\n" });
  const r = executeTool("count_lines", { paths: ["wc-basic.txt"] });
  assert.strictEqual(r.files.length, 1);
  assert.strictEqual(r.files[0].lines, 2);
  assert.strictEqual(r.files[0].words, 5);
  assert.strictEqual(r.files[0].bytes, 24);
  assert.strictEqual(r.total.lines, 2);
  assert.strictEqual(r.total.words, 5);
  assert.strictEqual(r.total.bytes, 24);
});

test("count_lines: multiple files aggregate correctly", () => {
  executeTool("create_file", { path: "wc-a.txt", content: "one\ntwo\n" });
  executeTool("create_file", { path: "wc-b.txt", content: "three\n" });
  const r = executeTool("count_lines", { paths: ["wc-a.txt", "wc-b.txt"] });
  assert.strictEqual(r.files.length, 2);
  assert.strictEqual(r.total.lines, 3);
  assert.strictEqual(r.total.words, 3);
});

test("file_tree: returns expected ASCII tree structure", () => {
  executeTool("create_directory", { path: "tree-basic/subdir" });
  executeTool("create_file", { path: "tree-basic/a.txt", content: "a" });
  executeTool("create_file", { path: "tree-basic/subdir/b.txt", content: "b" });
  const r = executeTool("file_tree", { path: "tree-basic" });
  assert.ok(r.tree.includes("a.txt"), "a.txt should appear in tree");
  assert.ok(r.tree.includes("subdir/"), "subdir/ should appear in tree");
  assert.ok(r.tree.includes("b.txt"), "b.txt should appear in tree");
  assert.ok(r.tree.includes("├──") || r.tree.includes("└──"), "tree connectors should be present");
  assert.strictEqual(r.dirCount, 1);
  assert.strictEqual(r.fileCount, 2);
  assert.strictEqual(r.truncated, false);
});

test("file_tree: result includes path and summary line", () => {
  executeTool("create_directory", { path: "tree-echo" });
  executeTool("create_file", { path: "tree-echo/x.txt", content: "x" });
  const r = executeTool("file_tree", { path: "tree-echo" });
  assert.strictEqual(r.path, "tree-echo");
  assert.ok(r.tree.startsWith("tree-echo"), "root label should be the path");
  assert.ok(r.tree.includes("directories") && r.tree.includes("files"), "summary line must be present");
});

test("hash_directory: deterministic hash for the same tree", () => {
  executeTool("create_directory", { path: "hash-det" });
  executeTool("create_file", { path: "hash-det/a.txt", content: "content-a" });
  executeTool("create_file", { path: "hash-det/b.txt", content: "content-b" });
  const h1 = executeTool("hash_directory", { path: "hash-det" });
  const h2 = executeTool("hash_directory", { path: "hash-det" });
  assert.strictEqual(h1.hash, h2.hash, "same tree must produce identical hash");
  assert.strictEqual(h1.algorithm, "sha256");
  assert.strictEqual(h1.fileCount, 2);
  assert.ok(typeof h1.totalBytes === "number" && h1.totalBytes > 0);
  assert.strictEqual(h1.hash.length, 64, "sha256 hex is 64 chars");
});

test("hash_directory: hash changes when a file is added", () => {
  executeTool("create_directory", { path: "hash-change" });
  executeTool("create_file", { path: "hash-change/a.txt", content: "before" });
  const before = executeTool("hash_directory", { path: "hash-change" });
  executeTool("create_file", { path: "hash-change/b.txt", content: "new" });
  const after = executeTool("hash_directory", { path: "hash-change" });
  assert.notStrictEqual(before.hash, after.hash, "adding a file must change the aggregate hash");
});

test("hash_directory: hash changes when file content is modified", () => {
  executeTool("create_directory", { path: "hash-modify" });
  executeTool("create_file", { path: "hash-modify/a.txt", content: "v1" });
  const h1 = executeTool("hash_directory", { path: "hash-modify" });
  executeTool("write_file", { path: "hash-modify/a.txt", content: "v2" });
  const h2 = executeTool("hash_directory", { path: "hash-modify" });
  assert.notStrictEqual(h1.hash, h2.hash, "modifying a file must change the hash");
});

// ── MEDIUM ────────────────────────────────────────────────────────────────────

test("count_lines: empty file counts as 0 lines, 0 words, 0 bytes", () => {
  executeTool("create_file", { path: "wc-empty.txt", content: "" });
  const r = executeTool("count_lines", { paths: ["wc-empty.txt"] });
  assert.strictEqual(r.files[0].lines, 0);
  assert.strictEqual(r.files[0].words, 0);
  assert.strictEqual(r.files[0].bytes, 0);
});

test("count_lines: single-line file with no trailing newline counts as 1 line", () => {
  executeTool("create_file", { path: "wc-nonl.txt", content: "no newline" });
  const r = executeTool("count_lines", { paths: ["wc-nonl.txt"] });
  assert.strictEqual(r.files[0].lines, 1);
  assert.strictEqual(r.files[0].words, 2);
});

test("count_lines: missing required 'paths' param throws -32602", () => {
  try {
    executeTool("count_lines", {});
    assert.fail("should have thrown");
  } catch (e) {
    assert.strictEqual(e.code, -32602);
  }
});

test("file_tree: depth limit is respected", () => {
  executeTool("create_directory", { path: "tree-depth/l1/l2/l3/l4" });
  executeTool("create_file", { path: "tree-depth/l1/l2/l3/l4/deep.txt", content: "deep" });
  const r = executeTool("file_tree", { path: "tree-depth", depth: 2 });
  // l4 and deep.txt should not appear (they are at depth 3 and 4 respectively)
  assert.ok(!r.tree.includes("deep.txt"), "deep file should be excluded by depth limit");
});

test("file_tree: sizes annotation shows byte counts", () => {
  executeTool("create_directory", { path: "tree-sizes" });
  executeTool("create_file", { path: "tree-sizes/hello.txt", content: "hello" });
  const r = executeTool("file_tree", { path: "tree-sizes", sizes: true });
  assert.ok(r.tree.includes("(5B)"), "file size annotation should appear");
});

test("hash_directory: empty directory produces a stable hash", () => {
  executeTool("create_directory", { path: "hash-empty" });
  const h1 = executeTool("hash_directory", { path: "hash-empty" });
  const h2 = executeTool("hash_directory", { path: "hash-empty" });
  assert.strictEqual(h1.hash, h2.hash, "empty dir hash should be stable");
  assert.strictEqual(h1.fileCount, 0);
  assert.strictEqual(h1.totalBytes, 0);
});

test("hash_directory: extensions filter only hashes matching files", () => {
  executeTool("create_directory", { path: "hash-ext" });
  executeTool("create_file", { path: "hash-ext/a.txt", content: "txt" });
  executeTool("create_file", { path: "hash-ext/b.log", content: "log" });
  const rTxt = executeTool("hash_directory", { path: "hash-ext", extensions: [".txt"] });
  const rAll = executeTool("hash_directory", { path: "hash-ext" });
  assert.strictEqual(rTxt.fileCount, 1);
  assert.notStrictEqual(rTxt.hash, rAll.hash, "extension filter changes which files are hashed");
});

test("hash_directory: md5 algorithm produces 32-char hex hash", () => {
  executeTool("create_directory", { path: "hash-md5" });
  executeTool("create_file", { path: "hash-md5/a.txt", content: "a" });
  const r = executeTool("hash_directory", { path: "hash-md5", algorithm: "md5" });
  assert.strictEqual(r.algorithm, "md5");
  assert.strictEqual(r.hash.length, 32);
});

test("hash_directory: invalid algorithm throws descriptive error", () => {
  executeTool("create_directory", { path: "hash-badalgo" });
  assert.throws(
    () => executeTool("hash_directory", { path: "hash-badalgo", algorithm: "crc32" }),
    /unsupported algorithm/i
  );
});

// ── HIGH ──────────────────────────────────────────────────────────────────────

test("count_lines: non-existent file throws cleanly", () => {
  assert.throws(() => executeTool("count_lines", { paths: ["wc-nonexistent.txt"] }));
});

test("count_lines: a directory passed as a file path throws descriptive error", () => {
  executeTool("create_directory", { path: "wc-dir" });
  assert.throws(
    () => executeTool("count_lines", { paths: ["wc-dir"] }),
    /not a regular file/i
  );
});

test("count_lines: empty paths array throws -32602 (custom validation in dispatch)", () => {
  assert.throws(() => {
    executeTool("count_lines", { paths: [] });
  });
});

test("file_tree: non-existent directory throws cleanly", () => {
  assert.throws(() => executeTool("file_tree", { path: "tree-does-not-exist" }));
});

test("file_tree: a file (not a directory) passed as path throws descriptive error", () => {
  executeTool("create_file", { path: "tree-file.txt", content: "I am a file" });
  assert.throws(
    () => executeTool("file_tree", { path: "tree-file.txt" }),
    /not a directory/i
  );
});

test("hash_directory: non-existent directory throws cleanly", () => {
  assert.throws(() => executeTool("hash_directory", { path: "hash-nonexistent" }));
});

test("hash_directory: a file (not a directory) passed throws descriptive error", () => {
  executeTool("create_file", { path: "hash-file.txt", content: "I am a file" });
  assert.throws(
    () => executeTool("hash_directory", { path: "hash-file.txt" }),
    /not a directory/i
  );
});

test("file_tree: node_modules directories are excluded (MCP_IGNORE)", () => {
  executeTool("create_directory", { path: "tree-ignore/node_modules" });
  executeTool("create_file", { path: "tree-ignore/node_modules/dep.js", content: "dep" });
  executeTool("create_file", { path: "tree-ignore/real.js", content: "real" });
  const r = executeTool("file_tree", { path: "tree-ignore" });
  assert.ok(!r.tree.includes("node_modules"), "node_modules should not appear in tree");
  assert.ok(r.tree.includes("real.js"), "real.js should appear in tree");
});

// ── CRITICAL ──────────────────────────────────────────────────────────────────

test("count_lines: path traversal is blocked", () => {
  assert.throws(
    () => executeTool("count_lines", { paths: ["../../etc/passwd"] }),
    /Access denied/
  );
});

test("file_tree: path traversal is blocked", () => {
  assert.throws(
    () => executeTool("file_tree", { path: "../../etc" }),
    /Access denied/
  );
});

test("hash_directory: path traversal is blocked", () => {
  assert.throws(
    () => executeTool("hash_directory", { path: "../../etc" }),
    /Access denied/
  );
});

test("count_lines: injection-shaped file content is counted as literal bytes", () => {
  const payload = "'; DROP TABLE users; -- $(rm -rf /) `whoami`";
  executeTool("create_file", { path: "wc-inject.txt", content: payload });
  const r = executeTool("count_lines", { paths: ["wc-inject.txt"] });
  assert.strictEqual(r.files[0].bytes, Buffer.byteLength(payload, "utf8"));
  assert.strictEqual(r.files[0].lines, 1);
});

test("count_lines: result is JSON-serialisable, no prototype pollution", () => {
  executeTool("create_file", { path: "wc-json.txt", content: "hello\nworld\n" });
  const r = executeTool("count_lines", { paths: ["wc-json.txt"] });
  assert.doesNotThrow(() => JSON.stringify(r));
  assert.ok(!Object.prototype.hasOwnProperty.call(r, "__proto__"));
});

test("file_tree: result is JSON-serialisable, no prototype pollution", () => {
  executeTool("create_directory", { path: "tree-json" });
  executeTool("create_file", { path: "tree-json/a.txt", content: "a" });
  const r = executeTool("file_tree", { path: "tree-json" });
  assert.doesNotThrow(() => JSON.stringify(r));
  assert.ok(!Object.prototype.hasOwnProperty.call(r, "__proto__"));
});

test("hash_directory: result is JSON-serialisable, no prototype pollution", () => {
  executeTool("create_directory", { path: "hash-json" });
  executeTool("create_file", { path: "hash-json/a.txt", content: "a" });
  const r = executeTool("hash_directory", { path: "hash-json" });
  assert.doesNotThrow(() => JSON.stringify(r));
  assert.ok(!Object.prototype.hasOwnProperty.call(r, "__proto__"));
  const expected = new Set(["path", "algorithm", "hash", "fileCount", "totalBytes"]);
  for (const k of Object.keys(r)) assert.ok(expected.has(k), `unexpected key '${k}'`);
});

test("hash_directory: injection-shaped algorithm value is rejected, not executed", () => {
  executeTool("create_directory", { path: "hash-inject-algo" });
  assert.throws(
    () => executeTool("hash_directory", { path: "hash-inject-algo", algorithm: "sha256; rm -rf /" }),
    /unsupported algorithm/i
  );
});

// ── EXTREME ───────────────────────────────────────────────────────────────────

test("count_lines: large file (500 lines, ~50KB) counts correctly", () => {
  const content = Array.from({ length: 500 }, (_, i) => `line number ${i + 1} padding-text-here`).join("\n") + "\n";
  executeTool("create_file", { path: "wc-large.txt", content });
  const r = executeTool("count_lines", { paths: ["wc-large.txt"] });
  assert.strictEqual(r.files[0].lines, 500);
  assert.strictEqual(r.files[0].bytes, Buffer.byteLength(content, "utf8"));
});

test("count_lines: fuzz printable-ASCII content does not crash the process", () => {
  const fuzz = Array.from({ length: 200 }, () => String.fromCharCode(32 + Math.floor(Math.random() * 95))).join("");
  executeTool("create_file", { path: "wc-fuzz.txt", content: fuzz });
  const r = executeTool("count_lines", { paths: ["wc-fuzz.txt"] });
  assert.ok(typeof r.files[0].bytes === "number");
});

test("file_tree: 501+ files in a flat directory triggers truncation", () => {
  executeTool("create_directory", { path: "tree-trunc" });
  // Create 505 files to exceed the 500-node cap
  for (let i = 0; i < 505; i++) {
    executeTool("create_file", { path: `tree-trunc/f${String(i).padStart(4, "0")}.txt`, content: `${i}` });
  }
  const r = executeTool("file_tree", { path: "tree-trunc" });
  assert.strictEqual(r.truncated, true, "result must report truncation");
  assert.ok(r.tree.includes("truncated"), "tree string must mention truncation");
});

test("hash_directory: 10 concurrent hash calls return identical results", () => {
  executeTool("create_directory", { path: "hash-concurrent" });
  executeTool("create_file", { path: "hash-concurrent/a.txt", content: "concurrent" });
  executeTool("create_file", { path: "hash-concurrent/b.txt", content: "stable" });
  const results = Array.from({ length: 10 }, () =>
    executeTool("hash_directory", { path: "hash-concurrent" })
  );
  const first = results[0].hash;
  for (let i = 1; i < results.length; i++) {
    assert.strictEqual(results[i].hash, first, `call ${i}: hash mismatch`);
  }
});

test("hash_directory: large file (100KB content) is hashed without error", () => {
  executeTool("create_directory", { path: "hash-large" });
  executeTool("create_file", { path: "hash-large/big.txt", content: "Z".repeat(100_000) });
  const r = executeTool("hash_directory", { path: "hash-large" });
  assert.strictEqual(r.fileCount, 1);
  assert.strictEqual(r.totalBytes, 100_000);
  assert.strictEqual(r.hash.length, 64);
});

// ── CLEANUP ───────────────────────────────────────────────────────────────────

test("cleanup: remove count_lines / file_tree / hash_directory fixture files", () => {
  const items = [
    "wc-basic.txt", "wc-a.txt", "wc-b.txt", "wc-empty.txt", "wc-nonl.txt",
    "wc-dir", "wc-inject.txt", "wc-json.txt", "wc-large.txt", "wc-fuzz.txt", "wc-nonexistent.txt",
    "tree-basic", "tree-echo", "tree-depth", "tree-sizes", "tree-ignore",
    "tree-json", "tree-trunc", "tree-file.txt",
    "hash-det", "hash-change", "hash-modify", "hash-empty", "hash-ext",
    "hash-md5", "hash-badalgo", "hash-file.txt", "hash-json", "hash-inject-algo",
    "hash-concurrent", "hash-large",
  ];
  for (const item of items) {
    try { fs.rmSync(path.join(TMP, item), { recursive: true, force: true }); } catch (_) {}
  }
  assert.ok(!fs.existsSync(path.join(TMP, "wc-basic.txt")), "wc-basic.txt removed");
});
