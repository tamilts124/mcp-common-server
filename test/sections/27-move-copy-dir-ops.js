"use strict";
// ── Section [30-ABC]: move_directory / copy_directory — lib/moveDirOps.js ────
// Recursive-tree variants built on the audited lib/moveOps.js primitives.
// Normal/Medium/High rigor levels here; Critical/Extreme are in
// 27b-move-copy-dir-ops-de.js.

const fs   = require("fs");
const path = require("path");
const { counters, TMP } = require("../test-harness");
const { moveDirectory, copyDirectory, walkTree } = require("../../lib/moveDirOps");

function test(name, fn) {
  try {
    fn();
    counters.pass++;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    counters.fail++;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${e.message}`);
  }
}

const ROOT = TMP;

/** Build a small nested tree under `dir`: dir/a.txt, dir/sub/b.txt, dir/sub/sub2/c.txt */
function makeTree(dir) {
  fs.mkdirSync(path.join(dir, "sub", "sub2"), { recursive: true });
  fs.writeFileSync(path.join(dir, "a.txt"), "file a");
  fs.writeFileSync(path.join(dir, "sub", "b.txt"), "file b");
  fs.writeFileSync(path.join(dir, "sub", "sub2", "c.txt"), "file c");
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

// ─── A. Normal level (happy path) ──────────────────────────────────────────────
console.log("\n[30-A] move_directory / copy_directory — Normal (happy path)");

test("copy_directory: copies a nested tree to a new path", () => {
  const src = path.join(ROOT, "cd-src-1");
  const dst = path.join(ROOT, "cd-dst-1");
  rmrf(src); rmrf(dst);
  makeTree(src);
  const r = copyDirectory(src, ROOT, dst, ROOT, {});
  if (!r.copied) throw new Error("copied flag not true");
  if (r.noop) throw new Error("unexpected noop");
  if (r.filesCopied !== 3) throw new Error(`expected 3 files copied, got ${r.filesCopied}`);
  if (fs.readFileSync(path.join(dst, "a.txt"), "utf8") !== "file a") throw new Error("a.txt content mismatch");
  if (fs.readFileSync(path.join(dst, "sub", "b.txt"), "utf8") !== "file b") throw new Error("sub/b.txt content mismatch");
  if (fs.readFileSync(path.join(dst, "sub", "sub2", "c.txt"), "utf8") !== "file c") throw new Error("nested c.txt content mismatch");
  rmrf(src); rmrf(dst);
});

test("copy_directory: source tree is left untouched after copy", () => {
  const src = path.join(ROOT, "cd-src-2");
  const dst = path.join(ROOT, "cd-dst-2");
  rmrf(src); rmrf(dst);
  makeTree(src);
  copyDirectory(src, ROOT, dst, ROOT, {});
  if (!fs.existsSync(path.join(src, "sub", "sub2", "c.txt"))) throw new Error("source tree was modified/removed");
  rmrf(src); rmrf(dst);
});

test("move_directory: moves a nested tree and removes source (fast rename path)", () => {
  const src = path.join(ROOT, "cd-mv-1");
  const dst = path.join(ROOT, "cd-mv-dst-1");
  rmrf(src); rmrf(dst);
  makeTree(src);
  const r = moveDirectory(src, ROOT, dst, ROOT, {});
  if (!r.moved) throw new Error("moved flag not true");
  if (r.strategy !== "rename") throw new Error(`expected fast rename strategy, got ${r.strategy}`);
  if (fs.existsSync(src)) throw new Error("source still exists after move");
  if (fs.readFileSync(path.join(dst, "sub", "b.txt"), "utf8") !== "file b") throw new Error("content mismatch after move");
  rmrf(dst);
});

test("copy_directory: creates missing destination parent directories", () => {
  const src = path.join(ROOT, "cd-parent-src");
  const dst = path.join(ROOT, "cd-parent-holder", "nested", "cd-parent-dst");
  rmrf(src); rmrf(path.join(ROOT, "cd-parent-holder"));
  makeTree(src);
  const r = copyDirectory(src, ROOT, dst, ROOT, {});
  if (!r.copied) throw new Error("copied flag not true");
  if (!fs.existsSync(path.join(dst, "a.txt"))) throw new Error("nested destination not created");
  rmrf(src); rmrf(path.join(ROOT, "cd-parent-holder"));
});

test("move_directory: result reports directoriesCreated/totalBytes via copy+delete fallback path", () => {
  // Force the copy+delete path by pre-creating the destination (merge case).
  const src = path.join(ROOT, "cd-mv-2");
  const dst = path.join(ROOT, "cd-mv-dst-2");
  rmrf(src); rmrf(dst);
  makeTree(src);
  fs.mkdirSync(dst, { recursive: true }); // destination pre-exists -> merge path
  const r = moveDirectory(src, ROOT, dst, ROOT, { overwrite: true });
  if (!r.moved) throw new Error("moved flag not true");
  if (r.strategy !== "copy+delete") throw new Error(`expected copy+delete strategy, got ${r.strategy}`);
  if (typeof r.filesCopied !== "number" || r.filesCopied !== 3) throw new Error("filesCopied missing/wrong");
  if (typeof r.totalBytes !== "number") throw new Error("totalBytes missing");
  if (fs.existsSync(src)) throw new Error("source still exists after merge-move");
  rmrf(dst);
});

test("copy_directory: empty source directory copies to an empty destination", () => {
  const src = path.join(ROOT, "cd-empty-src");
  const dst = path.join(ROOT, "cd-empty-dst");
  rmrf(src); rmrf(dst);
  fs.mkdirSync(src, { recursive: true });
  const r = copyDirectory(src, ROOT, dst, ROOT, {});
  if (!r.copied) throw new Error("copied flag not true");
  if (r.filesCopied !== 0) throw new Error("expected 0 files for empty dir");
  if (!fs.existsSync(dst) || !fs.statSync(dst).isDirectory()) throw new Error("empty destination dir not created");
  rmrf(src); rmrf(dst);
});

// ─── B. Medium level (boundary & param validation) ─────────────────────────────
console.log("\n[30-B] move_directory / copy_directory — Medium (boundary & param validation)");

test("copy_directory: throws -32602 when source does not exist", () => {
  const src = path.join(ROOT, "cd-nonexistent-src");
  const dst = path.join(ROOT, "cd-nonexistent-dst");
  try {
    copyDirectory(src, ROOT, dst, ROOT, {});
    throw new Error("expected ToolError, got none");
  } catch (e) {
    if (!e.message.includes("does not exist")) throw e;
    if (e.code !== -32602) throw new Error(`expected code -32602, got ${e.code}`);
  }
});

test("move_directory: throws -32602 when source does not exist", () => {
  const src = path.join(ROOT, "cd-mv-nonexistent-src");
  const dst = path.join(ROOT, "cd-mv-nonexistent-dst");
  try {
    moveDirectory(src, ROOT, dst, ROOT, {});
    throw new Error("expected ToolError, got none");
  } catch (e) {
    if (!e.message.includes("does not exist")) throw e;
  }
});

test("copy_directory: rejects a file (not a directory) as source (-32602)", () => {
  const src = path.join(ROOT, "cd-file-src.txt");
  const dst = path.join(ROOT, "cd-file-dst");
  fs.writeFileSync(src, "im a file");
  try {
    copyDirectory(src, ROOT, dst, ROOT, {});
    throw new Error("expected ToolError for file source, got none");
  } catch (e) {
    if (!e.message.includes("not a directory")) throw e;
    if (e.code !== -32602) throw new Error(`expected code -32602, got ${e.code}`);
  } finally {
    fs.unlinkSync(src);
  }
});

test("move_directory: rejects a file (not a directory) as source (-32602)", () => {
  const src = path.join(ROOT, "cd-mv-file-src.txt");
  const dst = path.join(ROOT, "cd-mv-file-dst");
  fs.writeFileSync(src, "im a file too");
  try {
    moveDirectory(src, ROOT, dst, ROOT, {});
    throw new Error("expected ToolError for file source, got none");
  } catch (e) {
    if (!e.message.includes("not a directory")) throw e;
  } finally {
    fs.unlinkSync(src);
  }
});

test("copy_directory: throws -32602 when destination dir exists and overwrite not set", () => {
  const src = path.join(ROOT, "cd-no-ow-src");
  const dst = path.join(ROOT, "cd-no-ow-dst");
  rmrf(src); rmrf(dst);
  makeTree(src);
  fs.mkdirSync(dst, { recursive: true });
  try {
    copyDirectory(src, ROOT, dst, ROOT, {});
    throw new Error("expected ToolError, got none");
  } catch (e) {
    if (!e.message.includes("already exists")) throw e;
    if (e.code !== -32602) throw new Error(`expected code -32602, got ${e.code}`);
  } finally {
    rmrf(src); rmrf(dst);
  }
});

test("move_directory: throws -32602 when destination dir exists and overwrite not set", () => {
  const src = path.join(ROOT, "cd-mv-no-ow-src");
  const dst = path.join(ROOT, "cd-mv-no-ow-dst");
  rmrf(src); rmrf(dst);
  makeTree(src);
  fs.mkdirSync(dst, { recursive: true });
  try {
    moveDirectory(src, ROOT, dst, ROOT, {});
    throw new Error("expected ToolError, got none");
  } catch (e) {
    if (!e.message.includes("already exists")) throw e;
  } finally {
    rmrf(src); rmrf(dst);
  }
});

test("copy_directory: destination existing as a file (not dir) throws -32602", () => {
  const src = path.join(ROOT, "cd-destfile-src");
  const dst = path.join(ROOT, "cd-destfile-dst.txt");
  rmrf(src);
  makeTree(src);
  fs.writeFileSync(dst, "i am a file blocking the dest");
  try {
    copyDirectory(src, ROOT, dst, ROOT, { overwrite: true });
    throw new Error("expected ToolError, got none");
  } catch (e) {
    if (!e.message.includes("not a directory")) throw e;
    if (e.code !== -32602) throw new Error(`expected code -32602, got ${e.code}`);
  } finally {
    rmrf(src);
    if (fs.existsSync(dst)) fs.unlinkSync(dst);
  }
});

test("copy_directory: same-path no-op returns noop:true without touching the tree", () => {
  const src = path.join(ROOT, "cd-samepath");
  rmrf(src);
  makeTree(src);
  const r = copyDirectory(src, ROOT, src, ROOT, {});
  if (!r.noop) throw new Error("expected noop:true for same source/destination");
  if (!r.copied) throw new Error("copied should still be true in noop case");
  if (!fs.existsSync(path.join(src, "sub", "b.txt"))) throw new Error("tree was modified by noop");
  rmrf(src);
});

test("move_directory: same-path no-op returns noop:true without touching the tree", () => {
  const src = path.join(ROOT, "cd-mv-samepath");
  rmrf(src);
  makeTree(src);
  const r = moveDirectory(src, ROOT, src, ROOT, {});
  if (!r.noop) throw new Error("expected noop:true for same source/destination");
  if (!r.moved) throw new Error("moved should still be true in noop case");
  if (!fs.existsSync(path.join(src, "sub", "b.txt"))) throw new Error("tree was modified by noop");
  rmrf(src);
});

// ─── C. High level (merge semantics / failure edge cases) ─────────────────────
console.log("\n[30-C] move_directory / copy_directory — High (merge semantics / edge cases)");

test("copy_directory: overwrite:true merges into an existing destination, overwriting colliding files", () => {
  const src = path.join(ROOT, "cd-merge-src");
  const dst = path.join(ROOT, "cd-merge-dst");
  rmrf(src); rmrf(dst);
  makeTree(src);
  fs.mkdirSync(dst, { recursive: true });
  fs.writeFileSync(path.join(dst, "a.txt"), "OLD a"); // colliding file
  fs.writeFileSync(path.join(dst, "keepme.txt"), "untouched"); // non-colliding file
  const r = copyDirectory(src, ROOT, dst, ROOT, { overwrite: true });
  if (!r.merged) throw new Error("expected merged:true");
  if (fs.readFileSync(path.join(dst, "a.txt"), "utf8") !== "file a") throw new Error("colliding file was not overwritten");
  if (fs.readFileSync(path.join(dst, "keepme.txt"), "utf8") !== "untouched") throw new Error("non-colliding file was removed/altered by merge");
  rmrf(src); rmrf(dst);
});

test("move_directory: overwrite:true merges into existing destination via copy+delete fallback", () => {
  const src = path.join(ROOT, "cd-mv-merge-src");
  const dst = path.join(ROOT, "cd-mv-merge-dst");
  rmrf(src); rmrf(dst);
  makeTree(src);
  fs.mkdirSync(dst, { recursive: true });
  fs.writeFileSync(path.join(dst, "keepme2.txt"), "stay");
  const r = moveDirectory(src, ROOT, dst, ROOT, { overwrite: true });
  if (!r.merged) throw new Error("expected merged:true");
  if (r.strategy !== "copy+delete") throw new Error(`expected copy+delete for merge, got ${r.strategy}`);
  if (fs.existsSync(src)) throw new Error("source still exists after merge-move");
  if (fs.readFileSync(path.join(dst, "keepme2.txt"), "utf8") !== "stay") throw new Error("pre-existing destination file lost during merge");
  if (fs.readFileSync(path.join(dst, "a.txt"), "utf8") !== "file a") throw new Error("moved file missing after merge");
  rmrf(dst);
});

test("walkTree: lists files and directories with forward-slash relative paths, parent before child", () => {
  const src = path.join(ROOT, "cd-walk-src");
  rmrf(src);
  makeTree(src);
  const { files, dirs } = walkTree(src);
  if (files.length !== 3) throw new Error(`expected 3 files, got ${files.length}`);
  if (dirs.length !== 2) throw new Error(`expected 2 dirs, got ${dirs.length}`);
  if (!files.includes("sub/sub2/c.txt")) throw new Error("forward-slash relative path missing for nested file");
  if (dirs.indexOf("sub") > dirs.indexOf("sub/sub2")) throw new Error("parent dir 'sub' must be listed before child 'sub/sub2'");
  rmrf(src);
});

test("copy_directory/move_directory: MCP_IGNORE'd entries (node_modules) are skipped during walk", () => {
  const src = path.join(ROOT, "cd-ignore-src");
  const dst = path.join(ROOT, "cd-ignore-dst");
  rmrf(src); rmrf(dst);
  fs.mkdirSync(path.join(src, "node_modules", "somepkg"), { recursive: true });
  fs.writeFileSync(path.join(src, "node_modules", "somepkg", "index.js"), "ignored");
  fs.writeFileSync(path.join(src, "real.txt"), "real content");
  const r = copyDirectory(src, ROOT, dst, ROOT, {});
  if (r.filesCopied !== 1) throw new Error(`expected only 1 real file copied, got ${r.filesCopied}`);
  if (fs.existsSync(path.join(dst, "node_modules"))) throw new Error("node_modules was not ignored");
  if (!fs.existsSync(path.join(dst, "real.txt"))) throw new Error("real.txt missing from destination");
  rmrf(src); rmrf(dst);
});

test("copy_directory: result is JSON-serialisable, no prototype pollution", () => {
  const src = path.join(ROOT, "cd-json-src");
  const dst = path.join(ROOT, "cd-json-dst");
  rmrf(src); rmrf(dst);
  makeTree(src);
  const r = copyDirectory(src, ROOT, dst, ROOT, {});
  const s = JSON.stringify(r);
  if (!s.includes("copied")) throw new Error("missing 'copied' field in JSON");
  if (Object.keys(r).some(k => k === "__proto__")) throw new Error("__proto__ key present in result");
  if (r.constructor !== Object) throw new Error("result is not a plain Object");
  rmrf(src); rmrf(dst);
});
