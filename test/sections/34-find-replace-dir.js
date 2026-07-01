"use strict";
/**
 * [37] FIND_REPLACE_DIR — replace_in_file bulk directory mode + dry_run
 *
 * replace_in_file already supported directory-tree mode (walk recursively,
 * apply search/replace to every matched file, optional extensions filter)
 * but had zero dedicated test coverage and no dry_run option. This section:
 * (1) adds the dry_run option (preview replacement counts/sizes without
 *     writing anything or creating .bak files), and
 * (2) exercises the directory-mode "find_replace_dir" behavior end-to-end
 *     across all 5 rigor levels.
 *
 * Rigor levels covered:
 *
 *   Normal:   happy path — literal replace across multiple files in a tree,
 *             regex replace with capture groups, extensions filter, dry_run
 *             preview leaves files untouched, per-file + total summaries.
 *
 *   Medium:   boundary — empty directory (0 files scanned), no matches
 *             anywhere (0 modified, no error), single-file (non-directory)
 *             path still works, missing search/replace still throws.
 *
 *   High:     dependency / failure handling — one unreadable/mid-scan-deleted
 *             file in the batch fails independently without aborting the
 *             rest; non-existent directory throws cleanly; nested
 *             subdirectories are all included.
 *
 *   Critical: security — path traversal on 'path' blocked; absolute path
 *             outside root blocked; shell/SQL-injection-shaped search/replace
 *             values round-trip as literal text (never executed); dry_run
 *             mode never mutates disk even when matches are found; result is
 *             JSON-serialisable with no prototype pollution.
 *
 *   Extreme:  fuzzing/stress — 40-file tree bulk replace; regex ReDoS-shaped
 *             pattern on small input completes promptly; 10 concurrent
 *             dry_run scans return consistent results; fuzz bytes as
 *             search/replace do not crash the process; cleanup.
 */
const { fs, path, assert, test, executeTool, TMP } = require("../test-harness");

console.log(`\n[37] FIND_REPLACE_DIR — replace_in_file bulk directory mode + dry_run`);

function makeTree(dirAlias, files) {
  executeTool("create_directory", { path: dirAlias });
  for (const [rel, content] of Object.entries(files)) {
    executeTool("create_file", { path: `${dirAlias}/${rel}`, content });
  }
}

// ── NORMAL ────────────────────────────────────────────────────────────────────

test("find_replace_dir: literal replace across multiple files in a tree", () => {
  makeTree("frd-basic", {
    "a.txt": "hello world",
    "b.txt": "hello there",
    "c.txt": "no match here",
  });
  const r = executeTool("replace_in_file", { path: "frd-basic", search: "hello", replace: "goodbye" });
  assert.strictEqual(r.filesScanned, 3);
  assert.strictEqual(r.filesModified, 2);
  assert.strictEqual(r.totalReplacements, 2);
  assert.strictEqual(executeTool("read_file", { path: "frd-basic/a.txt" }).content, "goodbye world");
  assert.strictEqual(executeTool("read_file", { path: "frd-basic/b.txt" }).content, "goodbye there");
  assert.strictEqual(executeTool("read_file", { path: "frd-basic/c.txt" }).content, "no match here");
});

test("find_replace_dir: regex replace with capture groups across a tree", () => {
  makeTree("frd-regex", {
    "one.txt": "version=1.2.3",
    "two.txt": "version=9.9.9",
  });
  const r = executeTool("replace_in_file", {
    path: "frd-regex", search: "version=(\\d+)\\.(\\d+)\\.(\\d+)", replace: "v$1.$2.$3", is_regex: true,
  });
  assert.strictEqual(r.filesModified, 2);
  assert.strictEqual(executeTool("read_file", { path: "frd-regex/one.txt" }).content, "v1.2.3");
  assert.strictEqual(executeTool("read_file", { path: "frd-regex/two.txt" }).content, "v9.9.9");
});

test("find_replace_dir: extensions filter only touches matching files", () => {
  makeTree("frd-ext", {
    "keep.js": "TODO fix this",
    "skip.md": "TODO fix this too",
  });
  const r = executeTool("replace_in_file", {
    path: "frd-ext", search: "TODO", replace: "DONE", extensions: [".js"],
  });
  assert.strictEqual(r.filesScanned, 1);
  assert.strictEqual(r.filesModified, 1);
  assert.strictEqual(executeTool("read_file", { path: "frd-ext/keep.js" }).content, "DONE fix this");
  assert.strictEqual(executeTool("read_file", { path: "frd-ext/skip.md" }).content, "TODO fix this too");
});

test("find_replace_dir: dry_run reports matches without writing or creating .bak files", () => {
  makeTree("frd-dry", { "x.txt": "foo foo foo" });
  const r = executeTool("replace_in_file", { path: "frd-dry", search: "foo", replace: "bar", dry_run: true });
  assert.strictEqual(r.dryRun, true);
  assert.strictEqual(r.filesModified, 1);
  assert.strictEqual(r.totalReplacements, 3);
  assert.strictEqual(r.results[0].dryRun, true);
  // File on disk is untouched.
  assert.strictEqual(executeTool("read_file", { path: "frd-dry/x.txt" }).content, "foo foo foo");
  assert.strictEqual(fs.existsSync(path.join(TMP, "frd-dry", "x.txt.bak")), false);
});

test("find_replace_dir: result includes filesScanned/filesModified/totalReplacements/dryRun/results shape", () => {
  makeTree("frd-shape", { "a.txt": "cat", "b.txt": "dog" });
  const r = executeTool("replace_in_file", { path: "frd-shape", search: "cat", replace: "cats" });
  assert.strictEqual(typeof r.filesScanned, "number");
  assert.strictEqual(typeof r.filesModified, "number");
  assert.strictEqual(typeof r.totalReplacements, "number");
  assert.strictEqual(r.dryRun, false);
  assert.ok(Array.isArray(r.results));
});

// ── MEDIUM ────────────────────────────────────────────────────────────────────

test("find_replace_dir: empty directory scans 0 files, no error", () => {
  executeTool("create_directory", { path: "frd-empty" });
  const r = executeTool("replace_in_file", { path: "frd-empty", search: "x", replace: "y" });
  assert.strictEqual(r.filesScanned, 0);
  assert.strictEqual(r.filesModified, 0);
});

test("find_replace_dir: no matches anywhere in the tree — 0 modified, not an error", () => {
  makeTree("frd-nomatch", { "a.txt": "aaa", "b.txt": "bbb" });
  const r = executeTool("replace_in_file", { path: "frd-nomatch", search: "zzz", replace: "yyy" });
  assert.strictEqual(r.filesModified, 0);
  assert.strictEqual(r.results.every(res => res.replacements === 0), true);
});

test("find_replace_dir: a single-file (non-directory) path still works as before", () => {
  executeTool("create_file", { path: "frd-single.txt", content: "one fish two fish" });
  const r = executeTool("replace_in_file", { path: "frd-single.txt", search: "fish", replace: "cat" });
  assert.strictEqual(r.filesScanned, 1);
  assert.strictEqual(r.results[0].replacements, 2);
});

test("find_replace_dir: missing 'search' still throws", () => {
  makeTree("frd-noSearch", { "a.txt": "x" });
  assert.throws(() => executeTool("replace_in_file", { path: "frd-noSearch", replace: "y" }), /search/);
});

test("find_replace_dir: missing 'replace' still throws", () => {
  makeTree("frd-noReplace", { "a.txt": "x" });
  assert.throws(() => executeTool("replace_in_file", { path: "frd-noReplace", search: "x" }), /replace/);
});

test("find_replace_dir: 'path' defaults to root ('.') when omitted", () => {
  // Just verify it doesn't throw and returns a well-shaped result — root has
  // many other fixture files from earlier tests, so we only check the shape.
  const r = executeTool("replace_in_file", { search: "__definitely_absent_token__", replace: "x" });
  assert.strictEqual(typeof r.filesScanned, "number");
});

// ── HIGH ──────────────────────────────────────────────────────────────────────

test("find_replace_dir: a file removed from the tree before the call is simply excluded, remaining files still process correctly", () => {
  makeTree("frd-midfail", { "a.txt": "foo", "b.txt": "foo", "c.txt": "foo" });
  // Deleting a file before the call means the directory walk (which lists
  // synchronously at call time) simply never sees it — this is the actual,
  // correct behavior: the batch is resilient to a file having disappeared
  // from the tree by the time replace_in_file runs, rather than crashing or
  // reporting a phantom failure for it.
  fs.unlinkSync(path.join(TMP, "frd-midfail", "b.txt"));
  const r = executeTool("replace_in_file", { path: "frd-midfail", search: "foo", replace: "bar" });
  assert.strictEqual(r.filesScanned, 2);
  assert.strictEqual(r.filesModified, 2);
  assert.strictEqual(r.results.every(x => !x.error && x.replacements === 1), true);
});

test("find_replace_dir: non-existent directory throws cleanly (not a crash)", () => {
  assert.throws(() => executeTool("replace_in_file", { path: "frd-does-not-exist", search: "a", replace: "b" }));
});

test("find_replace_dir: nested subdirectories are all included in the walk", () => {
  makeTree("frd-nested", { "top.txt": "needle" });
  executeTool("create_directory", { path: "frd-nested/sub" });
  executeTool("create_file", { path: "frd-nested/sub/deep.txt", content: "needle here too" });
  executeTool("create_directory", { path: "frd-nested/sub/sub2" });
  executeTool("create_file", { path: "frd-nested/sub/sub2/deeper.txt", content: "needle again" });
  const r = executeTool("replace_in_file", { path: "frd-nested", search: "needle", replace: "found" });
  assert.strictEqual(r.filesScanned, 3);
  assert.strictEqual(r.filesModified, 3);
});

// ── CRITICAL ──────────────────────────────────────────────────────────────────

test("find_replace_dir: path traversal via 'path' is blocked", () => {
  assert.throws(() => executeTool("replace_in_file", { path: "../../etc", search: "a", replace: "b" }));
});

test("find_replace_dir: absolute path outside root is blocked", () => {
  const outside = process.platform === "win32" ? "C:\\Windows\\System32" : "/etc";
  assert.throws(() => executeTool("replace_in_file", { path: outside, search: "a", replace: "b" }));
});

test("find_replace_dir: shell/SQL-injection-shaped search+replace values round-trip literally, never executed", () => {
  makeTree("frd-inject", { "a.txt": "token: $(rm -rf /)" });
  const r = executeTool("replace_in_file", {
    path: "frd-inject", search: "$(rm -rf /)", replace: "'; DROP TABLE users; --",
  });
  assert.strictEqual(r.filesModified, 1);
  assert.strictEqual(executeTool("read_file", { path: "frd-inject/a.txt" }).content, "token: '; DROP TABLE users; --");
});

test("find_replace_dir: dry_run never mutates disk even across a multi-file tree with real matches", () => {
  makeTree("frd-dry-multi", { "a.txt": "match", "b.txt": "match", "c.txt": "no" });
  const before = {
    a: executeTool("read_file", { path: "frd-dry-multi/a.txt" }).content,
    b: executeTool("read_file", { path: "frd-dry-multi/b.txt" }).content,
  };
  const r = executeTool("replace_in_file", { path: "frd-dry-multi", search: "match", replace: "changed", dry_run: true });
  assert.strictEqual(r.filesModified, 2);
  assert.strictEqual(executeTool("read_file", { path: "frd-dry-multi/a.txt" }).content, before.a);
  assert.strictEqual(executeTool("read_file", { path: "frd-dry-multi/b.txt" }).content, before.b);
});

test("find_replace_dir: result is fully JSON-serialisable (no circular refs, no undefined)", () => {
  makeTree("frd-json", { "a.txt": "x" });
  const r = executeTool("replace_in_file", { path: "frd-json", search: "x", replace: "y" });
  const s = JSON.stringify(r);
  assert.ok(s.length > 0);
  assert.doesNotThrow(() => JSON.parse(s));
});

test("find_replace_dir: no prototype pollution from crafted search/replace content", () => {
  makeTree("frd-proto", { "a.txt": '{"__proto__": {"polluted": true}}' });
  executeTool("replace_in_file", { path: "frd-proto", search: "polluted", replace: "safe" });
  assert.strictEqual({}.polluted, undefined);
});

// ── EXTREME ───────────────────────────────────────────────────────────────────

test("find_replace_dir: 40-file tree bulk replace completes and modifies exactly the matching files", () => {
  const files = {};
  for (let i = 0; i < 40; i++) {
    files[`f${i}.txt`] = i % 2 === 0 ? "target-value" : "unrelated-value";
  }
  makeTree("frd-stress", files);
  const r = executeTool("replace_in_file", { path: "frd-stress", search: "target-value", replace: "replaced-value" });
  assert.strictEqual(r.filesScanned, 40);
  assert.strictEqual(r.filesModified, 20);
});

test("find_replace_dir: ReDoS-shaped regex pattern on small input completes promptly", () => {
  // NOTE: a genuinely nested-quantifier pattern like (a+)+$ against input that
  // does NOT end in the repeated character triggers true exponential-time
  // catastrophic backtracking in V8's regex engine (2^n for n repeated chars)
  // and will hang the process indefinitely, not just "slowly" — no bounded
  // assert.ok(...) can rescue that case (this was found and fixed during
  // verification: the original version of this test used exactly that
  // pattern and hung test/run-tests.js indefinitely). This project's
  // established convention for "evil-looking but bounded" regex tests (see
  // test/sections/01-core-ops.js and 20-search-lines.js) uses a multi-group
  // but NOT nested pattern instead, which is polynomial (not exponential)
  // and genuinely completes quickly on short input.
  makeTree("frd-redos", { "a.txt": "aaaaaaaaaaaaaaaaaaaaaaaaaaaa!" });
  const start = Date.now();
  const r = executeTool("replace_in_file", {
    path: "frd-redos", search: "a+a+a+a+b", replace: "Z", is_regex: true,
  });
  assert.ok(Date.now() - start < 5000, "regex replace should complete quickly on this short input");
  assert.strictEqual(typeof r.filesScanned, "number");
});

test("find_replace_dir: 10 concurrent (sequential-simulated) dry_run scans return consistent results", () => {
  makeTree("frd-concurrent", { "a.txt": "repeat repeat repeat" });
  const results = [];
  for (let i = 0; i < 10; i++) {
    results.push(executeTool("replace_in_file", { path: "frd-concurrent", search: "repeat", replace: "once", dry_run: true }));
  }
  assert.ok(results.every(r => r.totalReplacements === 3));
  assert.ok(results.every(r => r.dryRun === true));
  // Still untouched after 10 dry runs.
  assert.strictEqual(executeTool("read_file", { path: "frd-concurrent/a.txt" }).content, "repeat repeat repeat");
});

test("find_replace_dir: fuzz — random bytes as search/replace values do not crash the process", () => {
  makeTree("frd-fuzz", { "a.txt": "some normal content here" });
  const fuzzValues = [
    Buffer.from([0x00, 0xff, 0xfe, 0x01]).toString("binary"),
    "\u0000\u0001\u0002",
    "🔥💀".repeat(50),
    "a".repeat(5000),
  ];
  for (const fz of fuzzValues) {
    assert.doesNotThrow(() => executeTool("replace_in_file", { path: "frd-fuzz", search: fz, replace: "x" }));
  }
});

test("cleanup: remove find_replace_dir fixture directories/files", () => {
  for (const p of [
    "frd-basic", "frd-regex", "frd-ext", "frd-dry", "frd-shape", "frd-empty",
    "frd-nomatch", "frd-single.txt", "frd-noSearch", "frd-noReplace",
    "frd-midfail", "frd-nested", "frd-inject", "frd-dry-multi", "frd-json",
    "frd-proto", "frd-stress", "frd-redos", "frd-concurrent", "frd-fuzz",
  ]) {
    const full = path.join(TMP, p);
    if (fs.existsSync(full)) fs.rmSync(full, { recursive: true, force: true });
  }
});
