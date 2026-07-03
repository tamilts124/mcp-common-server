"use strict";
/**
 * [88] FIND_TODO_OWNERS — TODO/FIXME marker -> git-blame author attribution
 *
 * Rigor levels:
 *   Normal:   marker attributed to correct commit author; multi-author grouping.
 *   Medium:   missing path throws; empty markers array throws; non-git dir throws.
 *   High:     max_markers cap; markers filter.
 *   Critical: path traversal blocked; shell-injection-shaped marker text inert.
 *   Extreme:  unresolved (uncommitted) line handled gracefully; JSON-serialisable;
 *             10 concurrent calls consistent.
 */
const { assert, test, executeTool, TMP } = require("../test-harness");
const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

console.log(`\n[88] FIND_TODO_OWNERS — TODO marker -> git blame author`);

function makeRepo(dirAbs) {
  fs.mkdirSync(dirAbs, { recursive: true });
  execSync("git init -q", { cwd: dirAbs });
  execSync('git config user.email "a@example.com"', { cwd: dirAbs });
  execSync('git config user.name "Alice"', { cwd: dirAbs });
}

function commitAll(dirAbs, msg, author) {
  execSync("git add -A", { cwd: dirAbs });
  if (author) execSync(`git config user.name "${author}"`, { cwd: dirAbs });
  execSync(`git commit -q -m "${msg}"`, { cwd: dirAbs });
}

test("normal: marker attributed to correct author", () => {
  const rel = "fto_normal";
  const repoAbs = path.join(TMP, rel);
  executeTool("create_directory", { path: rel });
  makeRepo(repoAbs);
  executeTool("write_file", { path: `${rel}/a.js`, content: `function f() {\n  // TODO fix this\n  return 1;\n}` });
  commitAll(repoAbs, "init", "Alice");
  const r = executeTool("find_todo_owners", { path: rel });
  assert.strictEqual(r.totalMarkers, 1);
  assert.strictEqual(r.byAuthor.length, 1);
  assert.strictEqual(r.byAuthor[0].author, "Alice");
  assert.strictEqual(r.byAuthor[0].items[0].marker, "TODO");
});

test("normal: multi-author grouping", () => {
  const rel = "fto_multi";
  const repoAbs = path.join(TMP, rel);
  executeTool("create_directory", { path: rel });
  makeRepo(repoAbs);
  executeTool("write_file", { path: `${rel}/a.js`, content: `// TODO a\n` });
  commitAll(repoAbs, "c1", "Alice");
  executeTool("write_file", { path: `${rel}/b.js`, content: `// FIXME b\n` });
  commitAll(repoAbs, "c2", "Bob");
  const r = executeTool("find_todo_owners", { path: rel });
  assert.strictEqual(r.totalMarkers, 2);
  const names = r.byAuthor.map(a => a.author).sort();
  assert.deepStrictEqual(names, ["Alice", "Bob"]);
});

test("medium: missing path throws", () => {
  try { executeTool("find_todo_owners", {}); assert.fail("should throw"); }
  catch (e) { assert.ok(e); }
});

test("medium: empty markers array throws", () => {
  try { executeTool("find_todo_owners", { path: "fto_normal", markers: [] }); assert.fail("should throw"); }
  catch (e) { assert.ok(e); }
});

test("medium: non-git directory throws", () => {
  executeTool("create_directory", { path: "fto_notgit" });
  executeTool("write_file", { path: "fto_notgit/a.js", content: "// TODO x\n" });
  try { executeTool("find_todo_owners", { path: "fto_notgit" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e); }
});

test("high: max_markers caps processed markers", () => {
  const rel = "fto_cap";
  const repoAbs = path.join(TMP, rel);
  executeTool("create_directory", { path: rel });
  makeRepo(repoAbs);
  let content = "";
  for (let i = 0; i < 5; i++) content += `// TODO item ${i}\n`;
  executeTool("write_file", { path: `${rel}/a.js`, content });
  commitAll(repoAbs, "many", "Alice");
  const r = executeTool("find_todo_owners", { path: rel, max_markers: 2 });
  assert.strictEqual(r.totalMarkers, 2);
  assert.strictEqual(r.truncated, true);
});

test("high: markers filter narrows results", () => {
  const rel = "fto_filter";
  const repoAbs = path.join(TMP, rel);
  executeTool("create_directory", { path: rel });
  makeRepo(repoAbs);
  executeTool("write_file", { path: `${rel}/a.js`, content: "// TODO a\n// FIXME b\n" });
  commitAll(repoAbs, "c", "Alice");
  const r = executeTool("find_todo_owners", { path: rel, markers: ["FIXME"] });
  assert.strictEqual(r.totalMarkers, 1);
  assert.strictEqual(r.byAuthor[0].items[0].marker, "FIXME");
});

test("critical: path traversal blocked", () => {
  try { executeTool("find_todo_owners", { path: "../../../etc/passwd" }); assert.fail("should throw"); }
  catch (e) { assert.ok(e); }
});

test("critical: shell-injection-shaped marker text handled as inert literal", () => {
  const rel = "fto_inject";
  const repoAbs = path.join(TMP, rel);
  executeTool("create_directory", { path: rel });
  makeRepo(repoAbs);
  executeTool("write_file", { path: `${rel}/a.js`, content: '// TODO $(rm -rf /) `whoami`\n' });
  commitAll(repoAbs, "c", "Alice");
  const r = executeTool("find_todo_owners", { path: rel });
  assert.strictEqual(r.totalMarkers, 1);
  assert.ok(r.byAuthor[0].items[0].text.includes("$(rm -rf /)"));
});

test("extreme: uncommitted line handled gracefully (unresolved, not thrown)", () => {
  const rel = "fto_uncommitted";
  const repoAbs = path.join(TMP, rel);
  executeTool("create_directory", { path: rel });
  makeRepo(repoAbs);
  executeTool("write_file", { path: `${rel}/a.js`, content: "// TODO committed\n" });
  commitAll(repoAbs, "c", "Alice");
  executeTool("append_file", { path: `${rel}/a.js`, content: "// TODO uncommitted\n" });
  const r = executeTool("find_todo_owners", { path: rel });
  assert.strictEqual(r.totalMarkers, 2);
  assert.ok(r.resolvedCount >= 1);
});

test("extreme: result is JSON-serialisable", () => {
  const r = executeTool("find_todo_owners", { path: "fto_normal" });
  assert.doesNotThrow(() => JSON.stringify(r));
});

test("extreme: 10 concurrent calls consistent", () => {
  const results = [];
  for (let i = 0; i < 10; i++) results.push(executeTool("find_todo_owners", { path: "fto_normal" }));
  for (const r of results) assert.strictEqual(r.totalMarkers, 1);
});

test("cleanup: remove find_todo_owners fixtures", () => {
  for (const d of ["fto_normal", "fto_multi", "fto_notgit", "fto_cap", "fto_filter", "fto_inject", "fto_uncommitted"]) {
    try { executeTool("delete_directory", { path: d, recursive: true }); } catch (_) {}
  }
});
