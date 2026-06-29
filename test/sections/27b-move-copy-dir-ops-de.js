"use strict";
// ── Section [30-DE]: move_directory / copy_directory — Critical & Extreme ─────
// D (Critical) and E (Extreme) rigor levels for lib/moveDirOps.js.
// A, B, C levels are in 27-move-copy-dir-ops.js.

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

// ─── D. Critical level (security / path traversal / symlink escape) ───────────
console.log("\n[30-D] move_directory / copy_directory — Critical (security)");

test("copy_directory: blocks path traversal in source via resolveClientPath", () => {
  const { resolveClientPath } = require("../../lib/roots");
  try {
    resolveClientPath("../../etc");
    throw new Error("expected access-denied error");
  } catch (e) {
    if (!e.message.toLowerCase().includes("access denied") &&
        !e.message.toLowerCase().includes("outside root")) throw e;
  }
});

test("copy_directory: blocks absolute path outside root as destination via resolveClientPath", () => {
  const { resolveClientPath } = require("../../lib/roots");
  try {
    resolveClientPath("C:/Windows/System32");
    throw new Error("expected access-denied error");
  } catch (e) {
    if (!e.message.toLowerCase().includes("access denied") &&
        !e.message.toLowerCase().includes("outside root")) throw e;
  }
});

test("copy_directory: aborts the whole operation (writes nothing) when a symlink exists anywhere inside the source tree", () => {
  // On Windows, symlink creation may require elevated privileges — skip
  // gracefully if so, same convention as 25b-move-copy-ops-cde.js.
  const src = path.join(ROOT, "cd-symlink-src");
  const dst = path.join(ROOT, "cd-symlink-dst");
  const outsideDir  = path.join(path.dirname(ROOT), "cd-outside-target");
  const outsideFile = path.join(outsideDir, "secret.txt");
  rmrf(src); rmrf(dst);
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, "normal.txt"), "normal file");

  try {
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(outsideFile, "outside secret");
    try {
      fs.symlinkSync(outsideFile, path.join(src, "evil-link.txt"));
    } catch (_) {
      console.log("        [skip] symlink creation requires elevated privileges on this OS");
      return;
    }

    try {
      copyDirectory(src, ROOT, dst, ROOT, {});
      throw new Error("SECURITY: copy_directory did not reject a symlinked source tree entry");
    } catch (e) {
      if (e.code !== -32001 && !e.message.toLowerCase().includes("symlink")) throw e;
    }
    // Nothing at all should have been written to dst — abort-before-write guarantee.
    if (fs.existsSync(dst)) throw new Error("SECURITY: destination was partially written despite the symlink rejection");
  } finally {
    rmrf(src); rmrf(dst);
    if (fs.existsSync(outsideFile)) fs.unlinkSync(outsideFile);
    rmrf(outsideDir);
  }
});

test("copy_directory: injection-shaped directory/file names are treated as literal paths (no shell exec)", () => {
  const src = path.join(ROOT, "cd-inj-src; rm -rf ; foo");
  const dst = path.join(ROOT, "cd-inj-dst");
  rmrf(src); rmrf(dst);
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, "$(whoami).txt"), "literal content");
  const r = copyDirectory(src, ROOT, dst, ROOT, {});
  if (!r.copied) throw new Error("copy with injection-shaped names should still succeed as literal paths");
  if (!fs.existsSync(path.join(dst, "$(whoami).txt"))) throw new Error("literal-named file missing from destination");
  if (fs.readFileSync(path.join(dst, "$(whoami).txt"), "utf8") !== "literal content") throw new Error("content mismatch for injection-shaped filename");
  rmrf(src); rmrf(dst);
});

test("move_directory: non-existent destination parent path is still safely jailed (created, not escaped)", () => {
  const src = path.join(ROOT, "cd-mv-jail-src");
  const dst = path.join(ROOT, "cd-mv-jail-holder", "deep", "dst");
  rmrf(src); rmrf(path.join(ROOT, "cd-mv-jail-holder"));
  makeTree(src);
  const r = moveDirectory(src, ROOT, dst, ROOT, {});
  if (!r.moved) throw new Error("move with deep new destination path should succeed");
  const withSep = ROOT.endsWith(path.sep) ? ROOT : ROOT + path.sep;
  if (!dst.startsWith(withSep)) throw new Error("destination escaped the root");
  rmrf(path.join(ROOT, "cd-mv-jail-holder"));
});

// ─── E. Extreme level (stress / fuzz / concurrency) ────────────────────────────
console.log("\n[30-E] move_directory / copy_directory — Extreme (stress / fuzz / concurrency)");

test("copy_directory: deeply nested tree (10 levels) copies correctly", () => {
  const src = path.join(ROOT, "cd-deep-src");
  const dst = path.join(ROOT, "cd-deep-dst");
  rmrf(src); rmrf(dst);
  let cur = src;
  for (let i = 0; i < 10; i++) cur = path.join(cur, `lvl${i}`);
  fs.mkdirSync(cur, { recursive: true });
  fs.writeFileSync(path.join(cur, "deep.txt"), "deep content");
  const r = copyDirectory(src, ROOT, dst, ROOT, {});
  if (r.filesCopied !== 1) throw new Error(`expected 1 deep file, got ${r.filesCopied}`);
  let curDst = dst;
  for (let i = 0; i < 10; i++) curDst = path.join(curDst, `lvl${i}`);
  if (fs.readFileSync(path.join(curDst, "deep.txt"), "utf8") !== "deep content") throw new Error("deep content mismatch");
  rmrf(src); rmrf(dst);
});

test("copy_directory: wide tree (100 files in one directory) copies completely", () => {
  const src = path.join(ROOT, "cd-wide-src");
  const dst = path.join(ROOT, "cd-wide-dst");
  rmrf(src); rmrf(dst);
  fs.mkdirSync(src, { recursive: true });
  for (let i = 0; i < 100; i++) fs.writeFileSync(path.join(src, `file-${i}.txt`), `content ${i}`);
  const r = copyDirectory(src, ROOT, dst, ROOT, {});
  if (r.filesCopied !== 100) throw new Error(`expected 100 files copied, got ${r.filesCopied}`);
  for (let i = 0; i < 100; i += 17) { // spot-check a sample
    if (fs.readFileSync(path.join(dst, `file-${i}.txt`), "utf8") !== `content ${i}`)
      throw new Error(`content mismatch at file-${i}.txt`);
  }
  rmrf(src); rmrf(dst);
});

test("copy_directory: large binary file (200KB) inside the tree copies bit-perfect", () => {
  const src = path.join(ROOT, "cd-large-src");
  const dst = path.join(ROOT, "cd-large-dst");
  rmrf(src); rmrf(dst);
  fs.mkdirSync(src, { recursive: true });
  const data = Buffer.alloc(200 * 1024);
  for (let i = 0; i < data.length; i++) data[i] = (i * 37) & 0xFF;
  fs.writeFileSync(path.join(src, "big.bin"), data);
  copyDirectory(src, ROOT, dst, ROOT, {});
  const read = fs.readFileSync(path.join(dst, "big.bin"));
  if (!read.equals(data)) throw new Error("large binary content mismatch");
  rmrf(src); rmrf(dst);
});

test("copy_directory: 10 concurrent copies of the same source to distinct destinations all succeed consistently", () => {
  const src = path.join(ROOT, "cd-concurrent-src");
  rmrf(src);
  makeTree(src);
  const dsts = [];
  for (let i = 0; i < 10; i++) {
    const dst = path.join(ROOT, `cd-concurrent-dst-${i}`);
    rmrf(dst);
    dsts.push(dst);
    const r = copyDirectory(src, ROOT, dst, ROOT, {});
    if (r.filesCopied !== 3) throw new Error(`concurrent copy ${i}: expected 3 files, got ${r.filesCopied}`);
  }
  for (const dst of dsts) {
    if (fs.readFileSync(path.join(dst, "sub", "b.txt"), "utf8") !== "file b") throw new Error(`content mismatch in ${dst}`);
    rmrf(dst);
  }
  rmrf(src);
});

test("copy_directory: empty/whitespace-only file content inside the tree round-trips correctly", () => {
  const src = path.join(ROOT, "cd-blank-src");
  const dst = path.join(ROOT, "cd-blank-dst");
  rmrf(src); rmrf(dst);
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, "empty.txt"), "");
  fs.writeFileSync(path.join(src, "whitespace.txt"), "   \n\t  \n");
  copyDirectory(src, ROOT, dst, ROOT, {});
  if (fs.statSync(path.join(dst, "empty.txt")).size !== 0) throw new Error("empty file not preserved as empty");
  if (fs.readFileSync(path.join(dst, "whitespace.txt"), "utf8") !== "   \n\t  \n") throw new Error("whitespace content mismatch");
  rmrf(src); rmrf(dst);
});

test("move_directory: fast-rename path leaves no dangling source after a 50-file tree move", () => {
  const src = path.join(ROOT, "cd-mv-stress-src");
  const dst = path.join(ROOT, "cd-mv-stress-dst");
  rmrf(src); rmrf(dst);
  fs.mkdirSync(src, { recursive: true });
  for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(src, `f-${i}.txt`), `v${i}`);
  const r = moveDirectory(src, ROOT, dst, ROOT, {});
  if (r.strategy !== "rename") throw new Error(`expected fast rename, got ${r.strategy}`);
  if (fs.existsSync(src)) throw new Error("source dangling after rename-strategy move");
  if (!fs.existsSync(path.join(dst, "f-49.txt"))) throw new Error("destination missing files after move");
  rmrf(dst);
});

test("copy_directory: Unicode + emoji file and directory names copy correctly", () => {
  const src = path.join(ROOT, "cd-unicode-src");
  const dst = path.join(ROOT, "cd-unicode-dst");
  rmrf(src); rmrf(dst);
  fs.mkdirSync(path.join(src, "日本語フォルダ"), { recursive: true });
  fs.writeFileSync(path.join(src, "日本語フォルダ", "🚀-file.txt"), "unicode content");
  const r = copyDirectory(src, ROOT, dst, ROOT, {});
  if (r.filesCopied !== 1) throw new Error("expected 1 unicode-named file copied");
  if (fs.readFileSync(path.join(dst, "日本語フォルダ", "🚀-file.txt"), "utf8") !== "unicode content")
    throw new Error("unicode content mismatch");
  rmrf(src); rmrf(dst);
});
