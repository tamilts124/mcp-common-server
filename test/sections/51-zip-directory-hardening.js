"use strict";
/**
 * [51] ZIP_DIRECTORY HARDENING — audit + fix pass on the pre-existing
 * zip_directory tool (implemented long before the project's current 5-rigor
 * -level testing convention existed; section [7]/03-utility-tools.js only
 * ever covered a Normal/Medium/light-Critical slice of it).
 *
 * This session's audit found TWO genuine bugs, both fixed in lib/utilOps.js
 * and lib/toolsSchema.js (not just re-tested, actually fixed):
 *
 *   BUG 1 — zip_directory was completely missing from the WRITE_TOOLS set in
 *   lib/toolsSchema.js, even though it writes a real .zip file to disk
 *   (mkdirSync + fs.writeFileSync inside zipDirectory()). Its handler lives
 *   in lib/dispatchRead.js (grouped with the other lib/utilOps.js utility
 *   tools) and its schema lives in UTIL_SCHEMAS rather than WRITE_SCHEMAS,
 *   which is presumably how it fell through the cracks — but write-gating in
 *   lib/executeTool.js only checks Set membership, not which file a handler
 *   lives in. Net effect: under MCP_READ_ONLY=true, zip_directory could
 *   still write arbitrary new .zip files to disk, silently bypassing the
 *   server's read-only guarantee that every other write-capable tool
 *   respects. Fixed by adding "zip_directory" to WRITE_TOOLS with an
 *   explanatory comment.
 *
 *   BUG 2 — collectFiles() (the recursive directory walker backing
 *   zip_directory) did not skip MCP_IGNORE'd entries (node_modules, .git,
 *   dist, build, etc.) — every other directory-walking tool in this codebase
 *   (file_stats, dir_size_stats, hash_directory, find_duplicates,
 *   compare_directories, move_directory, search_lines, file_tree) honours
 *   MCP_IGNORE via lib/roots.js's isIgnored(), but zip_directory silently
 *   bundled ignored directories into the archive. Fixed by adding an
 *   isIgnored() check at the top of collectFiles()'s entry loop.
 *
 * Rigor levels covered by this section (on top of section [7]'s existing
 * Normal/Medium/light-Critical coverage, which is left in place unchanged):
 *   Normal:   nested multi-level directory tree archives correctly with
 *             forward-slash relative entry names (verified via read_archive
 *             round-trip), single-file directory.
 *   Medium:   destination directory auto-created when it doesn't exist yet,
 *             missing 'destination' throws -32602.
 *   High:     re-zipping into an existing destination path overwrites it
 *             cleanly (simulates a "stale output file" dependency-adjacent
 *             failure mode) rather than corrupting/appending.
 *   Critical: **BUG 1 regression test** — zip_directory is in WRITE_TOOLS
 *             (would be blocked under MCP_READ_ONLY); **BUG 2 regression
 *             test** — a node_modules/.git/dist subdirectory inside the
 *             zipped source is excluded from the archive entirely, verified
 *             both via filesArchived count and by inspecting actual archive
 *             entries with read_archive; path traversal on destination
 *             (not just source, which section [7] already covers) is
 *             blocked; injection-shaped file/directory names round-trip
 *             literally as archive entry names, never interpreted.
 *   Extreme:  larger tree (60 files across nested dirs) archives correctly
 *             and every entry round-trips through read_archive with correct
 *             byte-for-byte content; zip_directory is registered in the
 *             execute_pipeline op enum; result is JSON-serialisable.
 */
const { assert, test, executeTool, fs, resolveClientPath } = require("../test-harness");

console.log(`\n[51] ZIP_DIRECTORY HARDENING — WRITE_TOOLS gating + MCP_IGNORE fixes, extended coverage`);

// ── NORMAL — happy path ────────────────────────────────────────────────────

test("zip_directory: nested multi-level tree archives with correct forward-slash entry names", () => {
  executeTool("create_directory", { path: "zh-nested/a/b/c" });
  executeTool("create_file", { path: "zh-nested/root.txt", content: "root" });
  executeTool("create_file", { path: "zh-nested/a/one.txt", content: "one" });
  executeTool("create_file", { path: "zh-nested/a/b/two.txt", content: "two" });
  executeTool("create_file", { path: "zh-nested/a/b/c/three.txt", content: "three" });

  const r = executeTool("zip_directory", { path: "zh-nested", destination: "zh-nested-out.zip" });
  assert.strictEqual(r.filesArchived, 4);

  const archive = executeTool("read_archive", { path: "zh-nested-out.zip" });
  const names = archive.entries.map(e => e.name).sort();
  assert.deepStrictEqual(names, ["a/b/c/three.txt", "a/b/two.txt", "a/one.txt", "root.txt"].sort());
  // Windows path separators must never leak into archive entry names.
  for (const n of names) assert.ok(!n.includes("\\"), `entry name '${n}' must use forward slashes only`);
});

test("zip_directory: single-file directory archives with filesArchived:1", () => {
  executeTool("create_directory", { path: "zh-single" });
  executeTool("create_file", { path: "zh-single/only.txt", content: "solo" });
  const r = executeTool("zip_directory", { path: "zh-single", destination: "zh-single-out.zip" });
  assert.strictEqual(r.filesArchived, 1);
});

// ── MEDIUM — boundary & param validation ───────────────────────────────────

test("zip_directory: destination directory is auto-created when it doesn't exist yet", () => {
  executeTool("create_directory", { path: "zh-autodir-src" });
  executeTool("create_file", { path: "zh-autodir-src/f.txt", content: "x" });
  const r = executeTool("zip_directory", { path: "zh-autodir-src", destination: "zh-autodir/nested/out.zip" });
  assert.strictEqual(r.filesArchived, 1);
  const { resolved } = resolveClientPath("zh-autodir/nested/out.zip");
  assert.ok(fs.existsSync(resolved));
});

test("zip_directory: missing 'destination' throws -32602", () => {
  executeTool("create_directory", { path: "zh-nodest" });
  try {
    executeTool("zip_directory", { path: "zh-nodest" });
    assert.fail("should have thrown");
  } catch (e) {
    assert.strictEqual(e.code, -32602);
  }
});

// ── HIGH — dependency/failure-adjacent behavior ────────────────────────────

test("zip_directory: re-zipping into an existing destination path overwrites cleanly (no corruption/append)", () => {
  executeTool("create_directory", { path: "zh-overwrite-src1" });
  executeTool("create_file", { path: "zh-overwrite-src1/a.txt", content: "first version" });
  const r1 = executeTool("zip_directory", { path: "zh-overwrite-src1", destination: "zh-overwrite-out.zip" });
  assert.strictEqual(r1.filesArchived, 1);

  executeTool("create_directory", { path: "zh-overwrite-src2" });
  executeTool("create_file", { path: "zh-overwrite-src2/a.txt", content: "second" });
  executeTool("create_file", { path: "zh-overwrite-src2/b.txt", content: "third" });
  const r2 = executeTool("zip_directory", { path: "zh-overwrite-src2", destination: "zh-overwrite-out.zip" });
  assert.strictEqual(r2.filesArchived, 2, "second zip must fully replace the first, not append to it");

  const archive = executeTool("read_archive", { path: "zh-overwrite-out.zip" });
  assert.strictEqual(archive.entries.length, 2);
});

// ── CRITICAL — security, sanitization, and this session's two bug fixes ───

test("BUG FIX 1 REGRESSION: zip_directory is registered in WRITE_TOOLS (blocked under MCP_READ_ONLY)", () => {
  const { WRITE_TOOLS } = require("../../lib/toolsSchema");
  assert.ok(WRITE_TOOLS.has("zip_directory"), "zip_directory missing from WRITE_TOOLS -- read-only mode would not block it from writing a .zip file to disk");
});

test("BUG FIX 2 REGRESSION: MCP_IGNORE'd subdirectories (node_modules, .git, dist) are excluded from the archive", () => {
  executeTool("create_directory", { path: "zh-ignore-src" });
  executeTool("create_file", { path: "zh-ignore-src/keep.txt", content: "keep me" });
  executeTool("create_directory", { path: "zh-ignore-src/node_modules" });
  executeTool("create_file", { path: "zh-ignore-src/node_modules/pkg.js", content: "should not appear" });
  executeTool("create_directory", { path: "zh-ignore-src/.git" });
  executeTool("create_file", { path: "zh-ignore-src/.git/HEAD", content: "ref: refs/heads/main" });
  executeTool("create_directory", { path: "zh-ignore-src/dist" });
  executeTool("create_file", { path: "zh-ignore-src/dist/bundle.js", content: "should not appear either" });

  const r = executeTool("zip_directory", { path: "zh-ignore-src", destination: "zh-ignore-out.zip" });
  assert.strictEqual(r.filesArchived, 1, "only keep.txt should be archived -- node_modules/.git/dist must be MCP_IGNORE'd");

  const archive = executeTool("read_archive", { path: "zh-ignore-out.zip" });
  const names = archive.entries.map(e => e.name);
  assert.deepStrictEqual(names, ["keep.txt"]);
  for (const n of names) {
    assert.ok(!n.includes("node_modules"), `ignored dir leaked into archive: ${n}`);
    assert.ok(!n.includes(".git"), `ignored dir leaked into archive: ${n}`);
    assert.ok(!n.includes("dist"), `ignored dir leaked into archive: ${n}`);
  }
});

test("zip_directory: path traversal on 'destination' (not just source) is blocked", () => {
  executeTool("create_directory", { path: "zh-trav-src" });
  executeTool("create_file", { path: "zh-trav-src/f.txt", content: "x" });
  assert.throws(
    () => executeTool("zip_directory", { path: "zh-trav-src", destination: "../../../../tmp/evil.zip" }),
    /Access denied/
  );
});

test("zip_directory: injection-shaped file/directory names round-trip literally as archive entry names", () => {
  executeTool("create_directory", { path: "zh-inj-src" });
  const trickyName = "'; rm -rf . $(whoami)--x.txt";
  executeTool("create_file", { path: `zh-inj-src/${trickyName}`, content: "payload" });
  const r = executeTool("zip_directory", { path: "zh-inj-src", destination: "zh-inj-out.zip" });
  assert.strictEqual(r.filesArchived, 1);
  const archive = executeTool("read_archive", { path: "zh-inj-out.zip" });
  assert.strictEqual(archive.entries[0].name, trickyName);
});

// ── EXTREME — larger tree, round-trip fidelity, registration checks ───────

test("zip_directory: larger tree (60 files across nested dirs) archives and every entry round-trips byte-for-byte", () => {
  executeTool("create_directory", { path: "zh-big/d1" });
  executeTool("create_directory", { path: "zh-big/d2/d3" });
  const expected = {};
  for (let i = 0; i < 20; i++) {
    const content = `root-file-${i}-`.repeat(20);
    executeTool("create_file", { path: `zh-big/r${i}.txt`, content });
    expected[`r${i}.txt`] = content;
  }
  for (let i = 0; i < 20; i++) {
    const content = `d1-file-${i}-`.repeat(20);
    executeTool("create_file", { path: `zh-big/d1/f${i}.txt`, content });
    expected[`d1/f${i}.txt`] = content;
  }
  for (let i = 0; i < 20; i++) {
    const content = `d3-file-${i}-`.repeat(20);
    executeTool("create_file", { path: `zh-big/d2/d3/g${i}.txt`, content });
    expected[`d2/d3/g${i}.txt`] = content;
  }

  const r = executeTool("zip_directory", { path: "zh-big", destination: "zh-big-out.zip" });
  assert.strictEqual(r.filesArchived, 60);

  // Extract and verify byte-for-byte fidelity of every entry via unzip_archive.
  executeTool("unzip_archive", { path: "zh-big-out.zip", destination: "zh-big-extracted" });
  for (const [rel, content] of Object.entries(expected)) {
    const { resolved } = resolveClientPath(`zh-big-extracted/${rel}`);
    assert.strictEqual(fs.readFileSync(resolved, "utf8"), content, `content mismatch for ${rel}`);
  }
});

test("zip_directory: is registered in the execute_pipeline op enum", () => {
  const { TOOLS_ALL } = require("../../lib/toolsSchema");
  const pipelineTool = TOOLS_ALL.find(t => t.name === "execute_pipeline");
  const opEnum = pipelineTool.inputSchema.properties.steps.items.properties.op.enum;
  assert.ok(opEnum.includes("zip_directory"), "zip_directory missing from execute_pipeline op enum");
});

test("zip_directory: result is fully JSON-serialisable (no circular refs, no undefined leaking into JSON)", () => {
  executeTool("create_directory", { path: "zh-ser-src" });
  executeTool("create_file", { path: "zh-ser-src/f.txt", content: "x" });
  const r = executeTool("zip_directory", { path: "zh-ser-src", destination: "zh-ser-out.zip" });
  const parsed = JSON.parse(JSON.stringify(r));
  assert.strictEqual(parsed.filesArchived, r.filesArchived);
  assert.strictEqual(parsed.zipPath, r.zipPath);
});

test("cleanup: remove zip_directory-hardening fixture files/dirs created in this section", () => {
  const paths = [
    "zh-nested", "zh-nested-out.zip", "zh-single", "zh-single-out.zip",
    "zh-autodir-src", "zh-autodir", "zh-nodest",
    "zh-overwrite-src1", "zh-overwrite-src2", "zh-overwrite-out.zip",
    "zh-ignore-src", "zh-ignore-out.zip",
    "zh-trav-src", "zh-inj-src", "zh-inj-out.zip",
    "zh-big", "zh-big-out.zip", "zh-big-extracted",
    "zh-ser-src", "zh-ser-out.zip",
  ];
  for (const p of paths) {
    try {
      const { resolved } = resolveClientPath(p);
      fs.rmSync(resolved, { recursive: true, force: true });
    } catch (_) {}
  }
});
