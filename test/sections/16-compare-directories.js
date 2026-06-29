"use strict";
/**
 * [20] COMPARE_DIRECTORIES — compare_directories tool
 *
 * Rigor levels covered:
 *
 *   Normal:   happy path — added/removed/modified/unchanged are each detected
 *             correctly; result summary counts match the array lengths;
 *             comparing a directory to itself yields all-unchanged.
 *
 *   Medium:   boundary — both dirs empty; one dir empty vs populated (all
 *             added or all removed); invalid algorithm throws; extensions
 *             filter narrows both sides consistently; identical content under
 *             different relative names is NOT matched (paths must match too).
 *
 *   High:     dependency / failure handling — non-existent 'left'/'right'
 *             directory throws cleanly; a file (not a directory) passed as
 *             'left' or 'right' throws a descriptive error; ignored
 *             directories (node_modules) are excluded from both sides.
 *
 *   Critical: security — path traversal and absolute-path-outside-root are
 *             blocked for both 'left' and 'right'; result is fully
 *             JSON-serialisable with no prototype pollution; shell/SQL-
 *             injection-shaped file content is compared as literal data,
 *             never executed; an injection-shaped algorithm value is
 *             rejected, not executed.
 *
 *   Extreme:  fuzzing/stress — 50-file trees with a deterministic mix of
 *             added/removed/modified/unchanged classify correctly; large
 *             (200KB) file comparison; nested subdirectory structures;
 *             10 concurrent comparisons return consistent results; cleanup.
 */
const { fs, path, assert, test, executeTool, TMP } = require("../test-harness");

console.log(`\n[20] COMPARE_DIRECTORIES — compare_directories tool`);

// ── NORMAL ────────────────────────────────────────────────────────────────────

test("compare_directories: detects added, removed, modified, and unchanged files", () => {
  executeTool("create_directory", { path: "cmp-basic-left" });
  executeTool("create_directory", { path: "cmp-basic-right" });
  executeTool("create_file", { path: "cmp-basic-left/same.txt", content: "identical" });
  executeTool("create_file", { path: "cmp-basic-right/same.txt", content: "identical" });
  executeTool("create_file", { path: "cmp-basic-left/changed.txt", content: "before" });
  executeTool("create_file", { path: "cmp-basic-right/changed.txt", content: "after" });
  executeTool("create_file", { path: "cmp-basic-left/gone.txt", content: "will be removed" });
  executeTool("create_file", { path: "cmp-basic-right/new.txt", content: "newly added" });

  const r = executeTool("compare_directories", { left: "cmp-basic-left", right: "cmp-basic-right" });
  assert.deepStrictEqual(r.added, ["new.txt"]);
  assert.deepStrictEqual(r.removed, ["gone.txt"]);
  assert.deepStrictEqual(r.modified, ["changed.txt"]);
  assert.deepStrictEqual(r.unchanged, ["same.txt"]);
});

test("compare_directories: summary counts match array lengths", () => {
  executeTool("create_directory", { path: "cmp-summary-left" });
  executeTool("create_directory", { path: "cmp-summary-right" });
  executeTool("create_file", { path: "cmp-summary-left/a.txt", content: "a" });
  executeTool("create_file", { path: "cmp-summary-right/a.txt", content: "a" });
  executeTool("create_file", { path: "cmp-summary-right/b.txt", content: "b" });
  const r = executeTool("compare_directories", { left: "cmp-summary-left", right: "cmp-summary-right" });
  assert.strictEqual(r.summary.addedCount, r.added.length);
  assert.strictEqual(r.summary.removedCount, r.removed.length);
  assert.strictEqual(r.summary.modifiedCount, r.modified.length);
  assert.strictEqual(r.summary.unchangedCount, r.unchanged.length);
});

test("compare_directories: comparing a directory to itself yields all-unchanged", () => {
  executeTool("create_directory", { path: "cmp-self" });
  executeTool("create_file", { path: "cmp-self/x.txt", content: "self-compare" });
  executeTool("create_file", { path: "cmp-self/y.txt", content: "self-compare-2" });
  const r = executeTool("compare_directories", { left: "cmp-self", right: "cmp-self" });
  assert.strictEqual(r.added.length, 0);
  assert.strictEqual(r.removed.length, 0);
  assert.strictEqual(r.modified.length, 0);
  assert.strictEqual(r.unchanged.length, 2);
});

test("compare_directories: result echoes left/right paths and default algorithm", () => {
  executeTool("create_directory", { path: "cmp-echo-left" });
  executeTool("create_directory", { path: "cmp-echo-right" });
  const r = executeTool("compare_directories", { left: "cmp-echo-left", right: "cmp-echo-right" });
  assert.strictEqual(r.left, "cmp-echo-left");
  assert.strictEqual(r.right, "cmp-echo-right");
  assert.strictEqual(r.algorithm, "sha256");
});

// ── MEDIUM ────────────────────────────────────────────────────────────────────

test("compare_directories: both directories empty yields all-zero result", () => {
  executeTool("create_directory", { path: "cmp-empty-left" });
  executeTool("create_directory", { path: "cmp-empty-right" });
  const r = executeTool("compare_directories", { left: "cmp-empty-left", right: "cmp-empty-right" });
  assert.strictEqual(r.leftFileCount, 0);
  assert.strictEqual(r.rightFileCount, 0);
  assert.strictEqual(r.summary.addedCount, 0);
  assert.strictEqual(r.summary.removedCount, 0);
});

test("compare_directories: empty left vs populated right yields all-added", () => {
  executeTool("create_directory", { path: "cmp-alladded-left" });
  executeTool("create_directory", { path: "cmp-alladded-right" });
  executeTool("create_file", { path: "cmp-alladded-right/a.txt", content: "a" });
  executeTool("create_file", { path: "cmp-alladded-right/b.txt", content: "b" });
  const r = executeTool("compare_directories", { left: "cmp-alladded-left", right: "cmp-alladded-right" });
  assert.strictEqual(r.added.length, 2);
  assert.strictEqual(r.removed.length, 0);
});

test("compare_directories: populated left vs empty right yields all-removed", () => {
  executeTool("create_directory", { path: "cmp-allremoved-left" });
  executeTool("create_directory", { path: "cmp-allremoved-right" });
  executeTool("create_file", { path: "cmp-allremoved-left/a.txt", content: "a" });
  const r = executeTool("compare_directories", { left: "cmp-allremoved-left", right: "cmp-allremoved-right" });
  assert.strictEqual(r.removed.length, 1);
  assert.strictEqual(r.added.length, 0);
});

test("compare_directories: invalid algorithm throws descriptive error", () => {
  executeTool("create_directory", { path: "cmp-badalgo-left" });
  executeTool("create_directory", { path: "cmp-badalgo-right" });
  assert.throws(
    () => executeTool("compare_directories", { left: "cmp-badalgo-left", right: "cmp-badalgo-right", algorithm: "blake3" }),
    /unsupported algorithm/i
  );
});

test("compare_directories: missing left/right param throws -32602", () => {
  try {
    executeTool("compare_directories", { left: "cmp-badalgo-left" });
    assert.fail("should have thrown");
  } catch (e) {
    assert.strictEqual(e.code, -32602);
  }
});

test("compare_directories: extensions filter narrows both sides consistently", () => {
  executeTool("create_directory", { path: "cmp-ext-left" });
  executeTool("create_directory", { path: "cmp-ext-right" });
  executeTool("create_file", { path: "cmp-ext-left/a.txt", content: "txt-a" });
  executeTool("create_file", { path: "cmp-ext-left/a.log", content: "log-a" });
  executeTool("create_file", { path: "cmp-ext-right/a.txt", content: "txt-a" });
  executeTool("create_file", { path: "cmp-ext-right/a.log", content: "log-a-different" });
  const r = executeTool("compare_directories", { left: "cmp-ext-left", right: "cmp-ext-right", extensions: [".txt"] });
  assert.strictEqual(r.leftFileCount, 1, "only .txt counted on left");
  assert.strictEqual(r.rightFileCount, 1, "only .txt counted on right");
  assert.strictEqual(r.unchanged.length, 1);
  assert.strictEqual(r.modified.length, 0, ".log change must be excluded by extensions filter");
});

test("compare_directories: same content under different relative names is NOT matched", () => {
  executeTool("create_directory", { path: "cmp-rename-left" });
  executeTool("create_directory", { path: "cmp-rename-right" });
  executeTool("create_file", { path: "cmp-rename-left/old-name.txt", content: "renamed content" });
  executeTool("create_file", { path: "cmp-rename-right/new-name.txt", content: "renamed content" });
  const r = executeTool("compare_directories", { left: "cmp-rename-left", right: "cmp-rename-right" });
  assert.deepStrictEqual(r.removed, ["old-name.txt"]);
  assert.deepStrictEqual(r.added, ["new-name.txt"]);
  assert.strictEqual(r.unchanged.length, 0, "comparison matches by relative path, not content alone");
});

// ── HIGH ──────────────────────────────────────────────────────────────────────

test("compare_directories: non-existent 'left' directory throws cleanly (not a crash)", () => {
  executeTool("create_directory", { path: "cmp-exists-right" });
  assert.throws(() => executeTool("compare_directories", { left: "cmp-does-not-exist", right: "cmp-exists-right" }));
});

test("compare_directories: non-existent 'right' directory throws cleanly (not a crash)", () => {
  executeTool("create_directory", { path: "cmp-exists-left" });
  assert.throws(() => executeTool("compare_directories", { left: "cmp-exists-left", right: "cmp-also-does-not-exist" }));
});

test("compare_directories: a file (not a directory) passed as 'left' throws descriptive error", () => {
  executeTool("create_file", { path: "cmp-leftfile.txt", content: "I am a file" });
  executeTool("create_directory", { path: "cmp-rightdir" });
  assert.throws(
    () => executeTool("compare_directories", { left: "cmp-leftfile.txt", right: "cmp-rightdir" }),
    /not a directory/i
  );
});

test("compare_directories: a file (not a directory) passed as 'right' throws descriptive error", () => {
  executeTool("create_directory", { path: "cmp-leftdir2" });
  executeTool("create_file", { path: "cmp-rightfile.txt", content: "I am a file" });
  assert.throws(
    () => executeTool("compare_directories", { left: "cmp-leftdir2", right: "cmp-rightfile.txt" }),
    /not a directory/i
  );
});

test("compare_directories: ignored directories (node_modules) are excluded from both sides", () => {
  executeTool("create_directory", { path: "cmp-ignore-left/node_modules" });
  executeTool("create_directory", { path: "cmp-ignore-right/node_modules" });
  executeTool("create_file", { path: "cmp-ignore-left/node_modules/dep.txt", content: "left dep" });
  executeTool("create_file", { path: "cmp-ignore-right/node_modules/dep.txt", content: "right dep, different" });
  executeTool("create_file", { path: "cmp-ignore-left/real.txt", content: "same" });
  executeTool("create_file", { path: "cmp-ignore-right/real.txt", content: "same" });
  const r = executeTool("compare_directories", { left: "cmp-ignore-left", right: "cmp-ignore-right" });
  assert.strictEqual(r.leftFileCount, 1, "node_modules contents must be excluded");
  assert.strictEqual(r.rightFileCount, 1, "node_modules contents must be excluded");
  assert.strictEqual(r.unchanged.length, 1);
  assert.strictEqual(r.modified.length, 0, "the node_modules diff must not surface as a modification");
});

// ── CRITICAL ──────────────────────────────────────────────────────────────────

test("compare_directories: path traversal via 'left' is blocked", () => {
  executeTool("create_directory", { path: "cmp-trav-right" });
  assert.throws(
    () => executeTool("compare_directories", { left: "../../etc", right: "cmp-trav-right" }),
    /Access denied/
  );
});

test("compare_directories: path traversal via 'right' is blocked", () => {
  executeTool("create_directory", { path: "cmp-trav-left" });
  assert.throws(
    () => executeTool("compare_directories", { left: "cmp-trav-left", right: "../../etc" }),
    /Access denied/
  );
});

test("compare_directories: absolute path outside root is blocked", () => {
  executeTool("create_directory", { path: "cmp-abs-left" });
  assert.throws(
    () => executeTool("compare_directories", { left: "cmp-abs-left", right: "C:\\Windows\\System32" }),
    /Access denied|outside|invalid/i
  );
});

test("compare_directories: result is fully JSON-serialisable (no circular refs)", () => {
  executeTool("create_directory", { path: "cmp-json-left" });
  executeTool("create_directory", { path: "cmp-json-right" });
  executeTool("create_file", { path: "cmp-json-left/a.txt", content: "json" });
  executeTool("create_file", { path: "cmp-json-right/a.txt", content: "json" });
  const r = executeTool("compare_directories", { left: "cmp-json-left", right: "cmp-json-right" });
  let serialised;
  assert.doesNotThrow(() => { serialised = JSON.stringify(r); });
  const parsed = JSON.parse(serialised);
  assert.strictEqual(parsed.summary.unchangedCount, r.summary.unchangedCount);
});

test("compare_directories: result has no unexpected top-level keys (no prototype pollution)", () => {
  executeTool("create_directory", { path: "cmp-proto-left" });
  executeTool("create_directory", { path: "cmp-proto-right" });
  const r = executeTool("compare_directories", { left: "cmp-proto-left", right: "cmp-proto-right" });
  const expected = new Set(["left", "right", "algorithm", "leftFileCount", "rightFileCount", "added", "removed", "modified", "unchanged", "summary"]);
  for (const key of Object.keys(r)) assert.ok(expected.has(key), `unexpected key '${key}'`);
  assert.ok(!Object.prototype.hasOwnProperty.call(r, "__proto__"));
});

test("compare_directories: shell/SQL-injection-shaped file content is compared as literal data", () => {
  executeTool("create_directory", { path: "cmp-inject-left" });
  executeTool("create_directory", { path: "cmp-inject-right" });
  const payload = "'; DROP TABLE users; -- $(rm -rf /) `whoami`";
  executeTool("create_file", { path: "cmp-inject-left/a.txt", content: payload });
  executeTool("create_file", { path: "cmp-inject-right/a.txt", content: payload });
  const r = executeTool("compare_directories", { left: "cmp-inject-left", right: "cmp-inject-right" });
  assert.strictEqual(r.unchanged.length, 1, "identical injection-shaped content should compare as literally unchanged");
});

test("compare_directories: injection-shaped algorithm value is rejected, not executed", () => {
  executeTool("create_directory", { path: "cmp-inject-algo-left" });
  executeTool("create_directory", { path: "cmp-inject-algo-right" });
  assert.throws(
    () => executeTool("compare_directories", { left: "cmp-inject-algo-left", right: "cmp-inject-algo-right", algorithm: "sha256; rm -rf /" }),
    /unsupported algorithm/i
  );
});

// ── EXTREME ───────────────────────────────────────────────────────────────────

test("compare_directories: 50-file trees with deterministic added/removed/modified/unchanged mix classify correctly", () => {
  executeTool("create_directory", { path: "cmp-stress-left" });
  executeTool("create_directory", { path: "cmp-stress-right" });
  // 20 unchanged
  for (let i = 0; i < 20; i++) {
    executeTool("create_file", { path: `cmp-stress-left/unchanged${i}.txt`, content: `same-${i}` });
    executeTool("create_file", { path: `cmp-stress-right/unchanged${i}.txt`, content: `same-${i}` });
  }
  // 10 modified
  for (let i = 0; i < 10; i++) {
    executeTool("create_file", { path: `cmp-stress-left/modified${i}.txt`, content: `before-${i}` });
    executeTool("create_file", { path: `cmp-stress-right/modified${i}.txt`, content: `after-${i}` });
  }
  // 10 removed (left only)
  for (let i = 0; i < 10; i++) {
    executeTool("create_file", { path: `cmp-stress-left/removed${i}.txt`, content: `gone-${i}` });
  }
  // 10 added (right only)
  for (let i = 0; i < 10; i++) {
    executeTool("create_file", { path: `cmp-stress-right/added${i}.txt`, content: `new-${i}` });
  }
  const r = executeTool("compare_directories", { left: "cmp-stress-left", right: "cmp-stress-right" });
  assert.strictEqual(r.unchanged.length, 20);
  assert.strictEqual(r.modified.length, 10);
  assert.strictEqual(r.removed.length, 10);
  assert.strictEqual(r.added.length, 10);
  assert.strictEqual(r.leftFileCount, 40);
  assert.strictEqual(r.rightFileCount, 40);
});

test("compare_directories: large (200KB) identical files compare as unchanged", () => {
  executeTool("create_directory", { path: "cmp-large-left" });
  executeTool("create_directory", { path: "cmp-large-right" });
  const big = "Q".repeat(200_000);
  executeTool("create_file", { path: "cmp-large-left/big.bin", content: big });
  executeTool("create_file", { path: "cmp-large-right/big.bin", content: big });
  const r = executeTool("compare_directories", { left: "cmp-large-left", right: "cmp-large-right" });
  assert.strictEqual(r.unchanged.length, 1);
  assert.strictEqual(r.modified.length, 0);
});

test("compare_directories: nested subdirectory structures are matched up correctly", () => {
  executeTool("create_directory", { path: "cmp-nested-left/sub/deep" });
  executeTool("create_directory", { path: "cmp-nested-right/sub/deep" });
  executeTool("create_file", { path: "cmp-nested-left/sub/deep/a.txt", content: "nested-same" });
  executeTool("create_file", { path: "cmp-nested-right/sub/deep/a.txt", content: "nested-same" });
  executeTool("create_file", { path: "cmp-nested-left/sub/deep/b.txt", content: "nested-before" });
  executeTool("create_file", { path: "cmp-nested-right/sub/deep/b.txt", content: "nested-after" });
  const r = executeTool("compare_directories", { left: "cmp-nested-left", right: "cmp-nested-right" });
  assert.deepStrictEqual(r.unchanged, ["sub/deep/a.txt"]);
  assert.deepStrictEqual(r.modified, ["sub/deep/b.txt"]);
});

test("compare_directories: 10 concurrent comparisons return consistent results", () => {
  executeTool("create_directory", { path: "cmp-concurrent-left" });
  executeTool("create_directory", { path: "cmp-concurrent-right" });
  executeTool("create_file", { path: "cmp-concurrent-left/a.txt", content: "concurrent-same" });
  executeTool("create_file", { path: "cmp-concurrent-right/a.txt", content: "concurrent-same" });
  executeTool("create_file", { path: "cmp-concurrent-left/b.txt", content: "concurrent-before" });
  executeTool("create_file", { path: "cmp-concurrent-right/b.txt", content: "concurrent-after" });
  const results = Array.from({ length: 10 }, () =>
    executeTool("compare_directories", { left: "cmp-concurrent-left", right: "cmp-concurrent-right" })
  );
  const first = results[0];
  for (let i = 1; i < results.length; i++) {
    assert.deepStrictEqual(results[i].unchanged, first.unchanged, `call ${i}: unchanged mismatch`);
    assert.deepStrictEqual(results[i].modified, first.modified, `call ${i}: modified mismatch`);
  }
});

// ── CLEANUP ───────────────────────────────────────────────────────────────────

test("cleanup: remove compare_directories fixture directories/files", () => {
  const items = [
    "cmp-basic-left", "cmp-basic-right", "cmp-summary-left", "cmp-summary-right",
    "cmp-self", "cmp-echo-left", "cmp-echo-right", "cmp-empty-left", "cmp-empty-right",
    "cmp-alladded-left", "cmp-alladded-right", "cmp-allremoved-left", "cmp-allremoved-right",
    "cmp-badalgo-left", "cmp-badalgo-right", "cmp-ext-left", "cmp-ext-right",
    "cmp-rename-left", "cmp-rename-right", "cmp-exists-right", "cmp-exists-left",
    "cmp-leftfile.txt", "cmp-rightdir", "cmp-leftdir2", "cmp-rightfile.txt",
    "cmp-ignore-left", "cmp-ignore-right", "cmp-trav-right", "cmp-trav-left",
    "cmp-abs-left", "cmp-json-left", "cmp-json-right", "cmp-proto-left", "cmp-proto-right",
    "cmp-inject-left", "cmp-inject-right", "cmp-inject-algo-left", "cmp-inject-algo-right",
    "cmp-stress-left", "cmp-stress-right", "cmp-large-left", "cmp-large-right",
    "cmp-nested-left", "cmp-nested-right", "cmp-concurrent-left", "cmp-concurrent-right",
  ];
  for (const item of items) {
    try { fs.rmSync(path.join(TMP, item), { recursive: true, force: true }); } catch (_) {}
  }
  assert.ok(!fs.existsSync(path.join(TMP, "cmp-basic-left")), "cmp-basic-left removed");
});
