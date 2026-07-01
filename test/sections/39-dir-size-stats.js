"use strict";
/**
 * [42] DIR_SIZE_STATS — directory-level disk-usage rollup tool
 *
 * Tests the `dir_size_stats` tool across all five rigor levels.
 * `dir_size_stats` complements `file_stats` (flat per-file top-N) with a
 * directory-level rollup similar to `du -h --max-depth=N`: each reported
 * directory's bytes/fileCount are recursive (include everything nested
 * beneath it, however deep), but which directories are *listed* is capped
 * by `max_depth` levels below the scanned root.
 *
 * Rigor levels covered:
 *   Normal:   happy-path — nested tree rollup correctness, sort order,
 *             default max_depth/top_n
 *   Medium:   boundary — empty directory, max_depth=1 hides deeper dirs but
 *             still rolls their bytes up, top_n=1, missing path defaults to
 *             root, out-of-range max_depth/top_n are clamped not rejected,
 *             non-numeric max_depth/top_n fall back to defaults (not NaN)
 *   High:     dependency failure — a file (not directory) as path throws;
 *             non-existent path throws cleanly
 *   Critical: path traversal blocked; absolute path outside root blocked;
 *             injection-shaped directory/file names round-trip literally;
 *             MCP_IGNORE'd directories (node_modules) excluded
 *   Extreme:  deeply nested tree (6 levels) rollup accuracy; wide tree (30
 *             subdirectories) top_n slicing; JSON-serialisability; no
 *             prototype pollution; 10 concurrent calls consistent; fuzz
 *             garbage-typed max_depth/top_n never crash the process
 */
const { assert, test, executeTool } = require("../test-harness");

console.log(`\n[42] DIR_SIZE_STATS — directory-level disk-usage rollup tool`);

// ── NORMAL — happy path ───────────────────────────────────────────────────────
test("dir_size_stats: nested tree rolls up bytes recursively per directory", () => {
  executeTool("create_directory", { path: "dss-basic/a/b" });
  executeTool("create_directory", { path: "dss-basic/c" });
  executeTool("create_file", { path: "dss-basic/root.txt", content: "x".repeat(10) });
  executeTool("create_file", { path: "dss-basic/a/one.txt", content: "x".repeat(100) });
  executeTool("create_file", { path: "dss-basic/a/b/two.txt", content: "x".repeat(1000) });
  executeTool("create_file", { path: "dss-basic/c/three.txt", content: "x".repeat(50) });

  const r = executeTool("dir_size_stats", { path: "dss-basic", max_depth: 2 });
  assert.strictEqual(r.totalBytes, 10 + 100 + 1000 + 50);
  assert.strictEqual(r.totalFiles, 4);
  assert.strictEqual(r.totalDirs, 3); // a, a/b, c

  const a  = r.directories.find(d => d.path === "dss-basic/a");
  const ab = r.directories.find(d => d.path === "dss-basic/a/b");
  const c  = r.directories.find(d => d.path === "dss-basic/c");
  assert.ok(a && ab && c, "all three directories must be listed at max_depth=2");
  assert.strictEqual(a.bytes, 100 + 1000, "a's bytes must include everything nested beneath it (a/one.txt + a/b/two.txt)");
  assert.strictEqual(a.fileCount, 2);
  assert.strictEqual(ab.bytes, 1000);
  assert.strictEqual(ab.depth, 2);
  assert.strictEqual(c.bytes, 50);
  assert.strictEqual(a.depth, 1);
});

test("dir_size_stats: directories are sorted by bytes descending", () => {
  const r = executeTool("dir_size_stats", { path: "dss-basic", max_depth: 2 });
  for (let i = 1; i < r.directories.length; i++) {
    assert.ok(r.directories[i - 1].bytes >= r.directories[i].bytes, "must be sorted descending by bytes");
  }
});

test("dir_size_stats: default max_depth is 2 and default top_n is 20 when omitted", () => {
  const r = executeTool("dir_size_stats", { path: "dss-basic" });
  assert.strictEqual(r.maxDepth, 2, "default max_depth should be 2");
  assert.ok(r.directories.length <= 20, "default top_n should cap at 20");
});

test("dir_size_stats: root itself is never listed as a directory entry", () => {
  const r = executeTool("dir_size_stats", { path: "dss-basic", max_depth: 2 });
  assert.ok(!r.directories.some(d => d.path === "dss-basic"), "root must not appear in directories list");
});

// ── MEDIUM — boundary & parameter validation ─────────────────────────────────
test("dir_size_stats: empty directory returns all-zero counts and empty directories array", () => {
  executeTool("create_directory", { path: "dss-empty" });
  const r = executeTool("dir_size_stats", { path: "dss-empty" });
  assert.strictEqual(r.totalBytes, 0);
  assert.strictEqual(r.totalFiles, 0);
  assert.strictEqual(r.totalDirs, 0);
  assert.deepStrictEqual(r.directories, []);
});

test("dir_size_stats: max_depth=1 hides deeper directories but still rolls their bytes into the parent", () => {
  const r = executeTool("dir_size_stats", { path: "dss-basic", max_depth: 1 });
  assert.ok(!r.directories.some(d => d.path === "dss-basic/a/b"), "depth-2 dir must not be listed at max_depth=1");
  const a = r.directories.find(d => d.path === "dss-basic/a");
  assert.ok(a, "depth-1 dir 'a' must still be listed");
  assert.strictEqual(a.bytes, 100 + 1000, "a's rollup must still include a/b's bytes even though a/b itself isn't listed");
});

test("dir_size_stats: top_n=1 returns exactly the single largest directory", () => {
  const r = executeTool("dir_size_stats", { path: "dss-basic", max_depth: 2, top_n: 1 });
  assert.strictEqual(r.directories.length, 1);
  assert.strictEqual(r.directories[0].path, "dss-basic/a", "largest directory (a, including a/b) must be first");
});

test("dir_size_stats: missing path defaults to root without throwing", () => {
  assert.doesNotThrow(() => executeTool("dir_size_stats", {}));
});

test("dir_size_stats: max_depth above the hard cap (999) is clamped to 10, not rejected", () => {
  const r = executeTool("dir_size_stats", { path: "dss-basic", max_depth: 999 });
  assert.strictEqual(r.maxDepth, 10);
});

test("dir_size_stats: max_depth below 1 (0 or negative) is clamped to 1, not rejected", () => {
  const r0 = executeTool("dir_size_stats", { path: "dss-basic", max_depth: 0 });
  assert.strictEqual(r0.maxDepth, 1);
  const rNeg = executeTool("dir_size_stats", { path: "dss-basic", max_depth: -5 });
  assert.strictEqual(rNeg.maxDepth, 1);
});

test("dir_size_stats: top_n above the hard cap (5000) is clamped to 200, not rejected", () => {
  const r = executeTool("dir_size_stats", { path: "dss-basic", top_n: 5000 });
  assert.ok(r.directories.length <= 200);
});

test("dir_size_stats: non-numeric max_depth/top_n fall back to safe defaults, not NaN", () => {
  const r = executeTool("dir_size_stats", { path: "dss-basic", max_depth: "garbage", top_n: "garbage" });
  assert.strictEqual(r.maxDepth, 2, "non-numeric max_depth must fall back to default 2, not NaN");
  assert.ok(r.directories.length > 0, "non-numeric top_n must fall back to a usable default, not an empty/NaN-filtered list");
});

// ── HIGH — dependency / failure handling ──────────────────────────────────────
test("dir_size_stats: a file (not a directory) passed as path throws descriptive error", () => {
  executeTool("create_file", { path: "dss-notadir.txt", content: "hello" });
  assert.throws(() => executeTool("dir_size_stats", { path: "dss-notadir.txt" }), /not a directory/);
});

test("dir_size_stats: non-existent directory throws cleanly (not a crash)", () => {
  assert.throws(() => executeTool("dir_size_stats", { path: "dss-does-not-exist-xyz" }));
});

// ── CRITICAL — security & input sanitization ──────────────────────────────────
test("dir_size_stats: path traversal via 'path' arg is blocked", () => {
  assert.throws(
    () => executeTool("dir_size_stats", { path: "../../../../etc" }),
    /outside.*root|access denied/i,
  );
});

test("dir_size_stats: absolute path outside root is blocked", () => {
  const outside = process.platform === "win32" ? "C:\\Windows" : "/etc";
  assert.throws(() => executeTool("dir_size_stats", { path: outside }));
});

test("dir_size_stats: injection-shaped directory/file names round-trip literally, never executed", () => {
  const evilDir = "dss-injection/$(whoami)`id`;rm -rf .";
  executeTool("create_directory", { path: evilDir });
  executeTool("create_file", { path: evilDir + "/f.txt", content: "x".repeat(5) });
  const r = executeTool("dir_size_stats", { path: "dss-injection", max_depth: 1 });
  assert.strictEqual(r.totalFiles, 1);
  assert.strictEqual(r.totalBytes, 5);
  assert.ok(r.directories.some(d => d.path.includes("$(whoami)")), "injection-shaped path must appear literally, not be executed");
});

test("dir_size_stats: MCP_IGNORE'd directories (node_modules) are excluded from the rollup", () => {
  executeTool("create_directory", { path: "dss-ignore/node_modules/pkg" });
  executeTool("create_file", { path: "dss-ignore/node_modules/pkg/big.js", content: "x".repeat(9999) });
  executeTool("create_file", { path: "dss-ignore/real.txt", content: "x".repeat(5) });
  const r = executeTool("dir_size_stats", { path: "dss-ignore", max_depth: 3 });
  assert.strictEqual(r.totalBytes, 5, "node_modules content must be excluded from totals");
  assert.strictEqual(r.totalFiles, 1);
  assert.ok(!r.directories.some(d => d.path.includes("node_modules")), "node_modules must not appear in directories list");
});

// ── EXTREME — fuzzing, concurrency, large trees ───────────────────────────────
test("dir_size_stats: deeply nested tree (6 levels) rolls up correctly at every depth", () => {
  let p = "dss-deep";
  for (let i = 1; i <= 6; i++) {
    p += `/lvl${i}`;
    executeTool("create_directory", { path: p });
    executeTool("create_file", { path: `${p}/f.txt`, content: "x".repeat(10) });
  }
  const r = executeTool("dir_size_stats", { path: "dss-deep", max_depth: 10, top_n: 200 });
  assert.strictEqual(r.totalBytes, 60, "6 files x 10 bytes = 60 total bytes");
  assert.strictEqual(r.totalFiles, 6);
  const lvl1 = r.directories.find(d => d.path === "dss-deep/lvl1");
  assert.strictEqual(lvl1.bytes, 60, "top-level dir must roll up all 6 nested files' bytes");
  const lvl6 = r.directories.find(d => d.path.endsWith("lvl6"));
  assert.strictEqual(lvl6.bytes, 10, "deepest dir only contains its own single file");
  assert.strictEqual(lvl6.depth, 6);
});

test("dir_size_stats: wide tree (30 subdirectories) — top_n correctly slices the largest ones", () => {
  for (let i = 0; i < 30; i++) {
    executeTool("create_directory", { path: `dss-wide/dir${i}` });
    executeTool("create_file", { path: `dss-wide/dir${i}/f.txt`, content: "x".repeat((i + 1) * 10) });
  }
  const r = executeTool("dir_size_stats", { path: "dss-wide", max_depth: 1, top_n: 5 });
  assert.strictEqual(r.directories.length, 5, "top_n=5 must return exactly 5 entries");
  assert.strictEqual(r.directories[0].path, "dss-wide/dir29", "dir29 (300 bytes) must be the largest");
  assert.strictEqual(r.directories[4].path, "dss-wide/dir25", "5th largest must be dir25 (260 bytes)");
  assert.strictEqual(r.totalDirs, 30, "totalDirs must count all 30 even though only 5 are listed");
});

test("dir_size_stats: result is fully JSON-serialisable (no circular refs)", () => {
  const r = executeTool("dir_size_stats", { path: "dss-basic", max_depth: 2 });
  let s;
  assert.doesNotThrow(() => { s = JSON.stringify(r); }, "JSON.stringify must not throw");
  const parsed = JSON.parse(s);
  assert.strictEqual(parsed.totalBytes, r.totalBytes);
  assert.ok(Array.isArray(parsed.directories));
});

test("dir_size_stats: result has no unexpected top-level keys (no prototype pollution)", () => {
  const r = executeTool("dir_size_stats", { path: "dss-basic", max_depth: 2 });
  const allowed = new Set(["path", "maxDepth", "totalBytes", "totalFiles", "totalDirs", "directories"]);
  for (const key of Object.keys(r)) {
    assert.ok(allowed.has(key), `unexpected top-level key: ${key}`);
  }
});

test("dir_size_stats: 10 concurrent calls on the same tree return consistent results", () => {
  const results = Array.from({ length: 10 }, () => executeTool("dir_size_stats", { path: "dss-basic", max_depth: 2 }));
  const first = results[0];
  for (let i = 1; i < results.length; i++) {
    assert.strictEqual(results[i].totalBytes, first.totalBytes, `call ${i} totalBytes mismatch`);
    assert.deepStrictEqual(results[i].directories, first.directories, `call ${i} directories mismatch`);
  }
});

test("dir_size_stats: fuzz — array/object-shaped max_depth/top_n do not crash the process", () => {
  assert.doesNotThrow(() => executeTool("dir_size_stats", { path: "dss-basic", max_depth: [1, 2, 3], top_n: {} }));
  assert.doesNotThrow(() => executeTool("dir_size_stats", { path: "dss-basic", max_depth: null, top_n: undefined }));
  assert.doesNotThrow(() => executeTool("dir_size_stats", { path: "dss-basic", max_depth: NaN, top_n: Infinity }));
});

test("cleanup: remove dir_size_stats fixture directories/files", () => {
  const { fs, path } = require("../test-harness");
  for (const p of ["dss-basic", "dss-empty", "dss-notadir.txt", "dss-injection", "dss-ignore", "dss-deep", "dss-wide"]) {
    try { fs.rmSync(path.join(require("../test-harness").TMP, p), { recursive: true, force: true }); } catch (_) {}
  }
});
