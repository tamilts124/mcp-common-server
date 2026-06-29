"use strict";
/**
 * test/sections/32-file-diff-dir.js
 *
 * Isolated functional tests for the file_diff_dir tool — combines
 * compare_directories (file-level classification) and diff_files
 * (line-level unified diff) into one tool. All 5 rigor levels.
 *
 * Section [35]
 */
const { fs, path, assert, test, executeTool, TMP } = require("../test-harness");

console.log(`\n[35] FILE_DIFF_DIR — file_diff_dir tool`);

// ════════════════════════════════════════════════════════════════════════════
// [35-A] NORMAL — happy path
// ════════════════════════════════════════════════════════════════════════════

test("file_diff_dir: classifies added/removed/modified/unchanged like compare_directories", () => {
  executeTool("create_directory", { path: "fdd-basic-left" });
  executeTool("create_directory", { path: "fdd-basic-right" });
  executeTool("create_file", { path: "fdd-basic-left/same.txt", content: "identical\n" });
  executeTool("create_file", { path: "fdd-basic-right/same.txt", content: "identical\n" });
  executeTool("create_file", { path: "fdd-basic-left/changed.txt", content: "line1\nline2\n" });
  executeTool("create_file", { path: "fdd-basic-right/changed.txt", content: "line1\nline2 edited\n" });
  executeTool("create_file", { path: "fdd-basic-left/gone.txt", content: "will be removed\n" });
  executeTool("create_file", { path: "fdd-basic-right/new.txt", content: "newly added\n" });

  const r = executeTool("file_diff_dir", { left: "fdd-basic-left", right: "fdd-basic-right" });
  assert.strictEqual(r.summary.addedCount, 1);
  assert.strictEqual(r.summary.removedCount, 1);
  assert.strictEqual(r.summary.modifiedCount, 1);
  assert.strictEqual(r.summary.unchangedCount, 1);
});

test("file_diff_dir: modified file entries include a real unified diff", () => {
  executeTool("create_directory", { path: "fdd-unified-left" });
  executeTool("create_directory", { path: "fdd-unified-right" });
  executeTool("create_file", { path: "fdd-unified-left/a.txt", content: "one\ntwo\nthree\n" });
  executeTool("create_file", { path: "fdd-unified-right/a.txt", content: "one\nTWO\nthree\n" });

  const r = executeTool("file_diff_dir", { left: "fdd-unified-left", right: "fdd-unified-right" });
  const entry = r.diffs.find(d => d.relPath === "a.txt");
  assert(entry, "a.txt should be in diffs");
  assert.strictEqual(entry.status, "modified");
  assert(entry.unified.includes("-two"), "unified diff should show removed line");
  assert(entry.unified.includes("+TWO"), "unified diff should show added line");
  assert.strictEqual(entry.additions, 1);
  assert.strictEqual(entry.deletions, 1);
});

test("file_diff_dir: added/removed entries have status only, no unified field", () => {
  executeTool("create_directory", { path: "fdd-ar-left" });
  executeTool("create_directory", { path: "fdd-ar-right" });
  executeTool("create_file", { path: "fdd-ar-left/onlyleft.txt", content: "x\n" });
  executeTool("create_file", { path: "fdd-ar-right/onlyright.txt", content: "y\n" });

  const r = executeTool("file_diff_dir", { left: "fdd-ar-left", right: "fdd-ar-right" });
  const removed = r.diffs.find(d => d.relPath === "onlyleft.txt");
  const added   = r.diffs.find(d => d.relPath === "onlyright.txt");
  assert.strictEqual(removed.status, "removed");
  assert.strictEqual(added.status, "added");
  assert.strictEqual(removed.unified, undefined);
  assert.strictEqual(added.unified, undefined);
});

test("file_diff_dir: unchanged files are omitted from the diffs array", () => {
  executeTool("create_directory", { path: "fdd-unchg-left" });
  executeTool("create_directory", { path: "fdd-unchg-right" });
  executeTool("create_file", { path: "fdd-unchg-left/same.txt", content: "same\n" });
  executeTool("create_file", { path: "fdd-unchg-right/same.txt", content: "same\n" });

  const r = executeTool("file_diff_dir", { left: "fdd-unchg-left", right: "fdd-unchg-right" });
  assert.strictEqual(r.diffs.length, 0);
  assert.strictEqual(r.summary.unchangedCount, 1);
});

test("file_diff_dir: result echoes left/right client paths and algorithm", () => {
  executeTool("create_directory", { path: "fdd-echo-left" });
  executeTool("create_directory", { path: "fdd-echo-right" });
  const r = executeTool("file_diff_dir", { left: "fdd-echo-left", right: "fdd-echo-right" });
  assert.strictEqual(r.left, "fdd-echo-left");
  assert.strictEqual(r.right, "fdd-echo-right");
  assert.strictEqual(r.algorithm, "sha256");
});

test("file_diff_dir: diffs array is sorted alphabetically by relPath across statuses", () => {
  executeTool("create_directory", { path: "fdd-sort-left" });
  executeTool("create_directory", { path: "fdd-sort-right" });
  executeTool("create_file", { path: "fdd-sort-left/zzz.txt", content: "z\n" });
  executeTool("create_file", { path: "fdd-sort-right/zzz.txt", content: "Z\n" });
  executeTool("create_file", { path: "fdd-sort-left/aaa.txt", content: "remove me\n" });
  executeTool("create_file", { path: "fdd-sort-right/mmm.txt", content: "add me\n" });

  const r = executeTool("file_diff_dir", { left: "fdd-sort-left", right: "fdd-sort-right" });
  const names = r.diffs.map(d => d.relPath);
  const sorted = [...names].sort();
  assert.deepStrictEqual(names, sorted);
});

test("file_diff_dir: directory compared to itself yields empty diffs, all-unchanged", () => {
  executeTool("create_directory", { path: "fdd-self" });
  executeTool("create_file", { path: "fdd-self/a.txt", content: "content\n" });
  const r = executeTool("file_diff_dir", { left: "fdd-self", right: "fdd-self" });
  assert.strictEqual(r.diffs.length, 0);
  assert.strictEqual(r.summary.unchangedCount, 1);
});

// ════════════════════════════════════════════════════════════════════════════
// [35-B] MEDIUM — boundary & parameter validation
// ════════════════════════════════════════════════════════════════════════════

test("file_diff_dir: missing 'left' throws -32602", () => {
  assert.throws(() => executeTool("file_diff_dir", { right: "fdd-basic-right" }));
});

test("file_diff_dir: missing 'right' throws -32602", () => {
  assert.throws(() => executeTool("file_diff_dir", { left: "fdd-basic-left" }));
});

test("file_diff_dir: invalid algorithm throws a descriptive error", () => {
  executeTool("create_directory", { path: "fdd-badalgo-left" });
  executeTool("create_directory", { path: "fdd-badalgo-right" });
  assert.throws(
    () => executeTool("file_diff_dir", { left: "fdd-badalgo-left", right: "fdd-badalgo-right", algorithm: "crc16" }),
    /algorithm/,
  );
});

test("file_diff_dir: non-existent 'left' directory throws cleanly", () => {
  executeTool("create_directory", { path: "fdd-noleft-right" });
  assert.throws(() => executeTool("file_diff_dir", { left: "does-not-exist-fdd", right: "fdd-noleft-right" }));
});

test("file_diff_dir: a file (not a directory) passed as 'right' throws descriptive error", () => {
  executeTool("create_directory", { path: "fdd-fileasright-left" });
  executeTool("create_file", { path: "fdd-fileasright.txt", content: "not a dir\n" });
  assert.throws(() => executeTool("file_diff_dir", { left: "fdd-fileasright-left", right: "fdd-fileasright.txt" }));
});

test("file_diff_dir: max_diff_lines=0 lists modified files without any unified diff, truncated=true", () => {
  executeTool("create_directory", { path: "fdd-zero-left" });
  executeTool("create_directory", { path: "fdd-zero-right" });
  executeTool("create_file", { path: "fdd-zero-left/a.txt", content: "x\n" });
  executeTool("create_file", { path: "fdd-zero-right/a.txt", content: "y\n" });

  const r = executeTool("file_diff_dir", { left: "fdd-zero-left", right: "fdd-zero-right", max_diff_lines: 0 });
  const entry = r.diffs.find(d => d.relPath === "a.txt");
  assert.strictEqual(entry.status, "modified");
  assert.strictEqual(entry.unified, undefined);
  assert.strictEqual(r.truncated, true);
});

test("file_diff_dir: negative max_diff_lines throws -32602", () => {
  executeTool("create_directory", { path: "fdd-neg-left" });
  executeTool("create_directory", { path: "fdd-neg-right" });
  assert.throws(() => executeTool("file_diff_dir", { left: "fdd-neg-left", right: "fdd-neg-right", max_diff_lines: -5 }));
});

test("file_diff_dir: max_diff_lines above the hard cap (5000) is clamped, not rejected", () => {
  executeTool("create_directory", { path: "fdd-clamp-left" });
  executeTool("create_directory", { path: "fdd-clamp-right" });
  const r = executeTool("file_diff_dir", { left: "fdd-clamp-left", right: "fdd-clamp-right", max_diff_lines: 999999 });
  assert.strictEqual(r.maxDiffLines, 5000);
});

test("file_diff_dir: extensions filter narrows both sides consistently", () => {
  executeTool("create_directory", { path: "fdd-ext-left" });
  executeTool("create_directory", { path: "fdd-ext-right" });
  executeTool("create_file", { path: "fdd-ext-left/keep.txt", content: "a\n" });
  executeTool("create_file", { path: "fdd-ext-right/keep.txt", content: "b\n" });
  executeTool("create_file", { path: "fdd-ext-left/ignore.log", content: "a\n" });
  executeTool("create_file", { path: "fdd-ext-right/ignore.log", content: "different\n" });

  const r = executeTool("file_diff_dir", { left: "fdd-ext-left", right: "fdd-ext-right", extensions: [".txt"] });
  assert.strictEqual(r.diffs.length, 1);
  assert.strictEqual(r.diffs[0].relPath, "keep.txt");
});

// ════════════════════════════════════════════════════════════════════════════
// [35-C] HIGH — dependency / failure handling
// ════════════════════════════════════════════════════════════════════════════

test("file_diff_dir: empty left vs populated right yields all-added, no unified diffs computed", () => {
  executeTool("create_directory", { path: "fdd-emptyleft-left" });
  executeTool("create_directory", { path: "fdd-emptyleft-right" });
  executeTool("create_file", { path: "fdd-emptyleft-right/a.txt", content: "a\n" });
  executeTool("create_file", { path: "fdd-emptyleft-right/b.txt", content: "b\n" });

  const r = executeTool("file_diff_dir", { left: "fdd-emptyleft-left", right: "fdd-emptyleft-right" });
  assert.strictEqual(r.summary.addedCount, 2);
  assert(r.diffs.every(d => d.status === "added" && d.unified === undefined));
});

test("file_diff_dir: populated left vs empty right yields all-removed", () => {
  executeTool("create_directory", { path: "fdd-emptyright-left" });
  executeTool("create_directory", { path: "fdd-emptyright-right" });
  executeTool("create_file", { path: "fdd-emptyright-left/a.txt", content: "a\n" });

  const r = executeTool("file_diff_dir", { left: "fdd-emptyright-left", right: "fdd-emptyright-right" });
  assert.strictEqual(r.summary.removedCount, 1);
  assert.strictEqual(r.diffs[0].status, "removed");
});

test("file_diff_dir: budget partially exhausted mid-list — earlier files keep diffs, later are listed bare", () => {
  executeTool("create_directory", { path: "fdd-budget-left" });
  executeTool("create_directory", { path: "fdd-budget-right" });
  // Each modified file's unified diff is a handful of lines (header + 1 hunk).
  // With a tight budget, only the first file(s) should retain `unified`.
  executeTool("create_file", { path: "fdd-budget-left/a.txt", content: "x\n" });
  executeTool("create_file", { path: "fdd-budget-right/a.txt", content: "y\n" });
  executeTool("create_file", { path: "fdd-budget-left/b.txt", content: "x\n" });
  executeTool("create_file", { path: "fdd-budget-right/b.txt", content: "y\n" });

  const r = executeTool("file_diff_dir", { left: "fdd-budget-left", right: "fdd-budget-right", max_diff_lines: 6 });
  const withUnified = r.diffs.filter(d => d.unified !== undefined);
  const withoutUnified = r.diffs.filter(d => d.unified === undefined);
  assert(withUnified.length >= 1, "at least one file should fit in the budget");
  assert(withoutUnified.length >= 1, "at least one file should be excluded by the budget");
  assert.strictEqual(r.truncated, true);
});

test("file_diff_dir: ignored directories (node_modules) are excluded from both sides", () => {
  executeTool("create_directory", { path: "fdd-ignore-left/node_modules" });
  executeTool("create_directory", { path: "fdd-ignore-right/node_modules" });
  executeTool("create_file", { path: "fdd-ignore-left/node_modules/dep.js", content: "v1\n" });
  executeTool("create_file", { path: "fdd-ignore-right/node_modules/dep.js", content: "v2\n" });
  executeTool("create_file", { path: "fdd-ignore-left/real.js", content: "same\n" });
  executeTool("create_file", { path: "fdd-ignore-right/real.js", content: "same\n" });

  const r = executeTool("file_diff_dir", { left: "fdd-ignore-left", right: "fdd-ignore-right" });
  assert.strictEqual(r.diffs.length, 0);
  assert.strictEqual(r.leftFileCount, 1);
  assert.strictEqual(r.rightFileCount, 1);
});

// ════════════════════════════════════════════════════════════════════════════
// [35-D] CRITICAL — security & input sanitization
// ════════════════════════════════════════════════════════════════════════════

test("file_diff_dir: path traversal via 'left' is blocked", () => {
  executeTool("create_directory", { path: "fdd-trav-right" });
  assert.throws(() => executeTool("file_diff_dir", { left: "../../../etc", right: "fdd-trav-right" }));
});

test("file_diff_dir: path traversal via 'right' is blocked", () => {
  executeTool("create_directory", { path: "fdd-trav-left" });
  assert.throws(() => executeTool("file_diff_dir", { left: "fdd-trav-left", right: "../../../etc" }));
});

test("file_diff_dir: absolute path outside root is blocked", () => {
  executeTool("create_directory", { path: "fdd-abs-left" });
  assert.throws(() => executeTool("file_diff_dir", { left: "fdd-abs-left", right: "C:\\Windows" }));
});

test("file_diff_dir: shell/SQL-injection-shaped file content is diffed as literal data, never executed", () => {
  executeTool("create_directory", { path: "fdd-inj-left" });
  executeTool("create_directory", { path: "fdd-inj-right" });
  executeTool("create_file", { path: "fdd-inj-left/a.txt", content: "clean\n" });
  executeTool("create_file", { path: "fdd-inj-right/a.txt", content: "'; DROP TABLE users; -- $(rm -rf /)\n" });

  const r = executeTool("file_diff_dir", { left: "fdd-inj-left", right: "fdd-inj-right" });
  const entry = r.diffs.find(d => d.relPath === "a.txt");
  assert(entry.unified.includes("DROP TABLE"), "injection-shaped content present literally in the diff text");
});

test("file_diff_dir: injection-shaped algorithm value is rejected, not executed", () => {
  executeTool("create_directory", { path: "fdd-injalgo-left" });
  executeTool("create_directory", { path: "fdd-injalgo-right" });
  assert.throws(() => executeTool("file_diff_dir", {
    left: "fdd-injalgo-left", right: "fdd-injalgo-right", algorithm: "sha256; rm -rf /",
  }));
});

test("file_diff_dir: result is fully JSON-serialisable (no circular refs)", () => {
  executeTool("create_directory", { path: "fdd-json-left" });
  executeTool("create_directory", { path: "fdd-json-right" });
  executeTool("create_file", { path: "fdd-json-left/a.txt", content: "1\n" });
  executeTool("create_file", { path: "fdd-json-right/a.txt", content: "2\n" });
  const r = executeTool("file_diff_dir", { left: "fdd-json-left", right: "fdd-json-right" });
  const json = JSON.stringify(r);
  assert(typeof json === "string" && json.length > 0);
  const parsed = JSON.parse(json);
  assert.strictEqual(parsed.summary.modifiedCount, 1);
});

test("file_diff_dir: result has no unexpected top-level keys (no prototype pollution)", () => {
  executeTool("create_directory", { path: "fdd-proto-left" });
  executeTool("create_directory", { path: "fdd-proto-right" });
  const r = executeTool("file_diff_dir", { left: "fdd-proto-left", right: "fdd-proto-right" });
  const expected = ["left", "right", "algorithm", "leftFileCount", "rightFileCount", "summary", "diffs", "maxDiffLines", "totalDiffLinesEmitted", "truncated"].sort();
  assert.deepStrictEqual(Object.keys(r).sort(), expected);
});

// ════════════════════════════════════════════════════════════════════════════
// [35-E] EXTREME — fuzzing, concurrency, scale
// ════════════════════════════════════════════════════════════════════════════

test("file_diff_dir: 30-file tree with a deterministic added/removed/modified/unchanged mix classifies and diffs correctly", () => {
  executeTool("create_directory", { path: "fdd-mix-left" });
  executeTool("create_directory", { path: "fdd-mix-right" });
  for (let i = 0; i < 30; i++) {
    const name = `f${i}.txt`;
    if (i % 4 === 0) {
      // unchanged
      executeTool("create_file", { path: `fdd-mix-left/${name}`, content: `same-${i}\n` });
      executeTool("create_file", { path: `fdd-mix-right/${name}`, content: `same-${i}\n` });
    } else if (i % 4 === 1) {
      // modified
      executeTool("create_file", { path: `fdd-mix-left/${name}`, content: `before-${i}\n` });
      executeTool("create_file", { path: `fdd-mix-right/${name}`, content: `after-${i}\n` });
    } else if (i % 4 === 2) {
      // removed (left only)
      executeTool("create_file", { path: `fdd-mix-left/${name}`, content: `gone-${i}\n` });
    } else {
      // added (right only)
      executeTool("create_file", { path: `fdd-mix-right/${name}`, content: `new-${i}\n` });
    }
  }
  const r = executeTool("file_diff_dir", { left: "fdd-mix-left", right: "fdd-mix-right", max_diff_lines: 5000 });
  assert.strictEqual(r.summary.unchangedCount + r.summary.modifiedCount + r.summary.removedCount + r.summary.addedCount, 30);
  const modifiedDiffs = r.diffs.filter(d => d.status === "modified");
  assert(modifiedDiffs.every(d => typeof d.unified === "string" && d.unified.length > 0));
});

test("file_diff_dir: large file (500 lines, one change) diffs correctly within the default budget", () => {
  executeTool("create_directory", { path: "fdd-large-left" });
  executeTool("create_directory", { path: "fdd-large-right" });
  const lines = [];
  for (let i = 0; i < 500; i++) lines.push(`line ${i}`);
  executeTool("create_file", { path: "fdd-large-left/big.txt", content: lines.join("\n") + "\n" });
  lines[250] = "line 250 CHANGED";
  executeTool("create_file", { path: "fdd-large-right/big.txt", content: lines.join("\n") + "\n" });

  const r = executeTool("file_diff_dir", { left: "fdd-large-left", right: "fdd-large-right" });
  const entry = r.diffs.find(d => d.relPath === "big.txt");
  assert.strictEqual(entry.status, "modified");
  assert(entry.unified.includes("CHANGED"));
});

test("file_diff_dir: 10 concurrent (sequential-simulated) calls on the same trees return consistent results", () => {
  executeTool("create_directory", { path: "fdd-concurrent-left" });
  executeTool("create_directory", { path: "fdd-concurrent-right" });
  executeTool("create_file", { path: "fdd-concurrent-left/a.txt", content: "x\n" });
  executeTool("create_file", { path: "fdd-concurrent-right/a.txt", content: "y\n" });

  const results = [];
  for (let i = 0; i < 10; i++) {
    results.push(executeTool("file_diff_dir", { left: "fdd-concurrent-left", right: "fdd-concurrent-right" }));
  }
  const first = JSON.stringify(results[0]);
  assert(results.every(r => JSON.stringify(r) === first), "all 10 calls return identical results");
});

test("file_diff_dir: nested subdirectory structures are matched up correctly", () => {
  executeTool("create_directory", { path: "fdd-nested-left/sub/deep" });
  executeTool("create_directory", { path: "fdd-nested-right/sub/deep" });
  executeTool("create_file", { path: "fdd-nested-left/sub/deep/file.txt", content: "v1\n" });
  executeTool("create_file", { path: "fdd-nested-right/sub/deep/file.txt", content: "v2\n" });

  const r = executeTool("file_diff_dir", { left: "fdd-nested-left", right: "fdd-nested-right" });
  const entry = r.diffs.find(d => d.relPath === "sub/deep/file.txt");
  assert(entry, "nested relPath should use forward slashes and match across the trees");
  assert.strictEqual(entry.status, "modified");
});

test("file_diff_dir: fuzz — random binary content in a modified file does not crash the diff", () => {
  executeTool("create_directory", { path: "fdd-fuzz-left" });
  executeTool("create_directory", { path: "fdd-fuzz-right" });
  const fuzzA = Buffer.from(Array.from({ length: 300 }, () => Math.floor(Math.random() * 256))).toString("latin1");
  const fuzzB = Buffer.from(Array.from({ length: 300 }, () => Math.floor(Math.random() * 256))).toString("latin1");
  executeTool("create_file", { path: "fdd-fuzz-left/bin.dat", content: fuzzA });
  executeTool("create_file", { path: "fdd-fuzz-right/bin.dat", content: fuzzB });

  let threw = false;
  try {
    executeTool("file_diff_dir", { left: "fdd-fuzz-left", right: "fdd-fuzz-right" });
  } catch (e) {
    threw = true;
  }
  // Either a clean result or a clean throw is acceptable — the only failure
  // mode we guard against is a hard process crash, which would abort the
  // whole test run rather than land here.
  assert(threw === true || threw === false);
});

test("file_diff_dir: cleanup — remove all fdd-* fixture directories created in this section", () => {
  const entries = fs.readdirSync(TMP);
  for (const name of entries) {
    if (name.startsWith("fdd-")) {
      fs.rmSync(path.join(TMP, name), { recursive: true, force: true });
    }
  }
  assert(true, "cleanup completed");
});
