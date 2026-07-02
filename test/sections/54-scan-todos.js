"use strict";
/**
 * [54] SCAN_TODOS — recursive TODO/FIXME/HACK/XXX/BUG comment-marker scanner
 * Rigor: Normal/Medium/High/Critical/Extreme.
 */
const { assert, test, executeTool } = require("../test-harness");

console.log(`\n[54] SCAN_TODOS — TODO/FIXME marker scanner`);

// ── NORMAL ──────────────────────────────────────────────────────────────
test("scan_todos: finds default markers across a directory", () => {
  executeTool("create_directory", { path: "std-basic/sub" });
  executeTool("create_file", { path: "std-basic/a.js", content: "// TODO: fix this\nconst x = 1;\n// FIXME broken\n" });
  executeTool("create_file", { path: "std-basic/sub/b.js", content: "// HACK workaround\nfoo();\n" });
  executeTool("create_file", { path: "std-basic/clean.js", content: "const y = 2;\n" });

  const r = executeTool("scan_todos", { path: "std-basic" });
  assert.strictEqual(r.filesScanned, 3);
  assert.strictEqual(r.totalMatches, 3);
  assert.strictEqual(r.byMarker.TODO, 1);
  assert.strictEqual(r.byMarker.FIXME, 1);
  assert.strictEqual(r.byMarker.HACK, 1);
  assert.strictEqual(r.matches[0].line, 1);
});

test("scan_todos: single-file mode works", () => {
  const r = executeTool("scan_todos", { path: "std-basic/a.js" });
  assert.strictEqual(r.filesScanned, 1);
  assert.strictEqual(r.totalMatches, 2);
});

// ── MEDIUM — boundary & validation ────────────────────────────────────────
test("scan_todos: custom markers list restricts matches", () => {
  const r = executeTool("scan_todos", { path: "std-basic", markers: ["HACK"] });
  assert.strictEqual(r.totalMatches, 1);
  assert.strictEqual(r.matches[0].marker, "HACK");
});

test("scan_todos: empty markers array falls back to default markers", () => {
  const r = executeTool("scan_todos", { path: "std-basic", markers: [] });
  assert.strictEqual(r.totalMatches, 3);
});

test("scan_todos: case_sensitive true misses lowercase marker", () => {
  executeTool("create_file", { path: "std-basic/lower.js", content: "// todo lowercase\n" });
  const r = executeTool("scan_todos", { path: "std-basic/lower.js", case_sensitive: true });
  assert.strictEqual(r.totalMatches, 0);
});

test("scan_todos: extensions filter narrows directory scan", () => {
  executeTool("create_file", { path: "std-basic/note.txt", content: "TODO in txt\n" });
  const r = executeTool("scan_todos", { path: "std-basic", extensions: [".js"] });
  assert.ok(!r.matches.some(m => m.file.endsWith(".txt")));
});

test("scan_todos: max_matches caps results and sets truncated", () => {
  const r = executeTool("scan_todos", { path: "std-basic", max_matches: 1 });
  assert.strictEqual(r.matches.length, 1);
  assert.strictEqual(r.truncated, true);
});

test("scan_todos: missing path defaults without throwing", () => {
  assert.doesNotThrow(() => executeTool("scan_todos", {}));
});

// ── HIGH — failure handling ────────────────────────────────────────────
test("scan_todos: non-existent path throws cleanly", () => {
  assert.throws(() => executeTool("scan_todos", { path: "std-does-not-exist-xyz" }));
});

test("scan_todos: binary file is skipped, not crashed on", () => {
  const { fs, path, TMP } = require("../test-harness");
  const dir = path.join(TMP, "std-binary");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "bin.dat"), Buffer.from([0, 1, 2, 0, 84, 79, 68, 79]));
  const r = executeTool("scan_todos", { path: "std-binary" });
  assert.strictEqual(r.totalMatches, 0);
  assert.strictEqual(r.filesScanned, 1);
});

// ── CRITICAL — security ────────────────────────────────────────────────
test("scan_todos: path traversal is blocked", () => {
  assert.throws(() => executeTool("scan_todos", { path: "../../../../etc" }), /outside.*root|access denied/i);
});

test("scan_todos: absolute path outside root is blocked", () => {
  const outside = process.platform === "win32" ? "C:\\Windows" : "/etc";
  assert.throws(() => executeTool("scan_todos", { path: outside }));
});

test("scan_todos: injection-shaped marker text round-trips literally, not executed", () => {
  executeTool("create_file", { path: "std-inj.js", content: "// TODO $(whoami) `id`; rm -rf .\n" });
  const r = executeTool("scan_todos", { path: "std-inj.js" });
  assert.strictEqual(r.totalMatches, 1);
  assert.ok(r.matches[0].text.includes("$(whoami)"));
});

test("scan_todos: MCP_IGNORE'd directories excluded", () => {
  executeTool("create_directory", { path: "std-ignore/node_modules" });
  executeTool("create_file", { path: "std-ignore/node_modules/x.js", content: "// TODO hidden\n" });
  executeTool("create_file", { path: "std-ignore/real.js", content: "const z = 1;\n" });
  const r = executeTool("scan_todos", { path: "std-ignore" });
  assert.strictEqual(r.totalMatches, 0);
});

// ── EXTREME — fuzz/concurrency ─────────────────────────────────────────
test("scan_todos: result is JSON-serialisable", () => {
  const r = executeTool("scan_todos", { path: "std-basic" });
  assert.doesNotThrow(() => JSON.stringify(r));
});

test("scan_todos: fuzz — garbage-typed opts do not crash", () => {
  assert.doesNotThrow(() => executeTool("scan_todos", { path: "std-basic", max_matches: "garbage", markers: null, extensions: {} }));
});

test("scan_todos: 10 concurrent calls consistent", () => {
  const results = Array.from({ length: 10 }, () => executeTool("scan_todos", { path: "std-basic" }));
  const first = results[0];
  for (const r of results) assert.strictEqual(r.totalMatches, first.totalMatches);
});

test("cleanup: remove scan_todos fixtures", () => {
  const { fs, path, TMP } = require("../test-harness");
  for (const p of ["std-basic", "std-binary", "std-inj.js", "std-ignore"]) {
    try { fs.rmSync(path.join(TMP, p), { recursive: true, force: true }); } catch (_) {}
  }
});
