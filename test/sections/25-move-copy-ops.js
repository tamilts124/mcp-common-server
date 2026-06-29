"use strict";
// ── Section [28-ABC]: move_file / copy_file — Normal / Medium / High ──────────
// Tests lib/moveOps.js: symlink escape, EXDEV, overwrite safety,
// directory source rejection, same-path no-op, large/binary files.
// D (Critical) and E (Extreme) levels are in 25b-move-copy-ops-cde.js.

const fs   = require("fs");
const path = require("path");
const { counters, TMP } = require("../test-harness");
const { moveFile, copyFile } = require("../../lib/moveOps");

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

// ─── A. Normal level (happy-path) ─────────────────────────────────────────────
console.log("\n[28-A] move_file / copy_file — Normal (happy path)");

test("copy_file: copies a file to a new path", () => {
  const src = path.join(ROOT, "mc-src-1.txt");
  const dst = path.join(ROOT, "mc-dst-1.txt");
  fs.writeFileSync(src, "hello copy");
  if (fs.existsSync(dst)) fs.unlinkSync(dst);
  const r = copyFile(src, ROOT, dst, ROOT, {});
  if (!r.copied) throw new Error("copied flag not true");
  if (r.noop)    throw new Error("unexpected noop");
  if (!fs.existsSync(dst)) throw new Error("destination not created");
  if (fs.readFileSync(dst, "utf8") !== "hello copy") throw new Error("content mismatch");
  fs.unlinkSync(src); fs.unlinkSync(dst);
});

test("copy_file: source still exists after copy", () => {
  const src = path.join(ROOT, "mc-src-2.txt");
  const dst = path.join(ROOT, "mc-dst-2.txt");
  fs.writeFileSync(src, "keep me");
  if (fs.existsSync(dst)) fs.unlinkSync(dst);
  copyFile(src, ROOT, dst, ROOT, {});
  if (!fs.existsSync(src)) throw new Error("source was deleted by copy_file");
  fs.unlinkSync(src); fs.unlinkSync(dst);
});

test("move_file: moves a file and removes source", () => {
  const src = path.join(ROOT, "mc-mv-1.txt");
  const dst = path.join(ROOT, "mc-mv-dst-1.txt");
  fs.writeFileSync(src, "move me");
  if (fs.existsSync(dst)) fs.unlinkSync(dst);
  const r = moveFile(src, ROOT, dst, ROOT, {});
  if (!r.moved)           throw new Error("moved flag not true");
  if (r.noop)             throw new Error("unexpected noop");
  if (fs.existsSync(src)) throw new Error("source still exists after move");
  if (!fs.existsSync(dst)) throw new Error("destination not created by move");
  if (fs.readFileSync(dst, "utf8") !== "move me") throw new Error("content mismatch");
  fs.unlinkSync(dst);
});

test("copy_file: creates missing parent directories", () => {
  const src = path.join(ROOT, "mc-parent-src.txt");
  const dst = path.join(ROOT, "mc-subdir", "nested", "mc-parent-dst.txt");
  fs.writeFileSync(src, "nested copy");
  const r = copyFile(src, ROOT, dst, ROOT, {});
  if (!r.copied) throw new Error("copied flag not true");
  if (!fs.existsSync(dst)) throw new Error("nested destination not created");
  fs.unlinkSync(src); fs.unlinkSync(dst);
  fs.rmdirSync(path.join(ROOT, "mc-subdir", "nested"));
  fs.rmdirSync(path.join(ROOT, "mc-subdir"));
});

test("move_file: creates missing parent directories", () => {
  const src = path.join(ROOT, "mc-mv-parent-src.txt");
  const dst = path.join(ROOT, "mc-mv-subdir", "mc-mv-parent-dst.txt");
  fs.writeFileSync(src, "nested move");
  const r = moveFile(src, ROOT, dst, ROOT, {});
  if (!r.moved)             throw new Error("moved flag not true");
  if (fs.existsSync(src))   throw new Error("source still exists");
  if (!fs.existsSync(dst))  throw new Error("nested destination not created");
  fs.unlinkSync(dst);
  fs.rmdirSync(path.join(ROOT, "mc-mv-subdir"));
});

test("copy_file: overwrite: true replaces existing destination", () => {
  const src = path.join(ROOT, "mc-ow-src.txt");
  const dst = path.join(ROOT, "mc-ow-dst.txt");
  fs.writeFileSync(src, "new content");
  fs.writeFileSync(dst, "old content");
  copyFile(src, ROOT, dst, ROOT, { overwrite: true });
  if (fs.readFileSync(dst, "utf8") !== "new content")
    throw new Error("destination was not overwritten");
  fs.unlinkSync(src); fs.unlinkSync(dst);
});

test("move_file: overwrite: true replaces existing destination", () => {
  const src = path.join(ROOT, "mc-mv-ow-src.txt");
  const dst = path.join(ROOT, "mc-mv-ow-dst.txt");
  fs.writeFileSync(src, "new move content");
  fs.writeFileSync(dst, "old content");
  moveFile(src, ROOT, dst, ROOT, { overwrite: true });
  if (fs.readFileSync(dst, "utf8") !== "new move content")
    throw new Error("destination was not overwritten by move");
  if (fs.existsSync(src)) throw new Error("source still exists after move overwrite");
  fs.unlinkSync(dst);
});

// ─── B. Medium level (boundary / param validation) ────────────────────────────
console.log("\n[28-B] move_file / copy_file — Medium (boundary & param validation)");

test("copy_file: throws -32602 when source does not exist", () => {
  const src = path.join(ROOT, "mc-nonexistent-src.txt");
  const dst = path.join(ROOT, "mc-nonexistent-dst.txt");
  try {
    copyFile(src, ROOT, dst, ROOT, {});
    throw new Error("expected ToolError, got none");
  } catch (e) {
    if (!e.message.includes("does not exist")) throw e;
    if (e.code !== -32602) throw new Error(`expected code -32602, got ${e.code}`);
  }
});

test("move_file: throws -32602 when source does not exist", () => {
  const src = path.join(ROOT, "mc-mv-nonexistent.txt");
  const dst = path.join(ROOT, "mc-mv-nonexistent-dst.txt");
  try {
    moveFile(src, ROOT, dst, ROOT, {});
    throw new Error("expected ToolError, got none");
  } catch (e) {
    if (!e.message.includes("does not exist")) throw e;
  }
});

test("copy_file: throws -32602 when destination exists and overwrite not set", () => {
  const src = path.join(ROOT, "mc-no-ow-src.txt");
  const dst = path.join(ROOT, "mc-no-ow-dst.txt");
  fs.writeFileSync(src, "src");
  fs.writeFileSync(dst, "dst");
  try {
    copyFile(src, ROOT, dst, ROOT, {});
    throw new Error("expected ToolError, got none");
  } catch (e) {
    if (!e.message.includes("already exists")) throw e;
    if (e.code !== -32602) throw new Error(`expected code -32602, got ${e.code}`);
  } finally {
    fs.unlinkSync(src); fs.unlinkSync(dst);
  }
});

test("move_file: throws -32602 when destination exists and overwrite not set", () => {
  const src = path.join(ROOT, "mc-mv-no-ow-src.txt");
  const dst = path.join(ROOT, "mc-mv-no-ow-dst.txt");
  fs.writeFileSync(src, "src");
  fs.writeFileSync(dst, "dst");
  try {
    moveFile(src, ROOT, dst, ROOT, {});
    throw new Error("expected ToolError, got none");
  } catch (e) {
    if (!e.message.includes("already exists")) throw e;
  } finally {
    if (fs.existsSync(src)) fs.unlinkSync(src);
    if (fs.existsSync(dst)) fs.unlinkSync(dst);
  }
});

test("copy_file: rejects directory as source (-32602)", () => {
  const src = path.join(ROOT, "mc-dir-src");
  const dst = path.join(ROOT, "mc-dir-dst.txt");
  fs.mkdirSync(src, { recursive: true });
  try {
    copyFile(src, ROOT, dst, ROOT, {});
    throw new Error("expected ToolError for directory source, got none");
  } catch (e) {
    if (!e.message.includes("directory")) throw e;
    if (e.code !== -32602) throw new Error(`expected code -32602, got ${e.code}`);
  } finally {
    fs.rmdirSync(src);
  }
});

test("move_file: rejects directory as source (-32602)", () => {
  const src = path.join(ROOT, "mc-mv-dir-src");
  const dst = path.join(ROOT, "mc-mv-dir-dst.txt");
  fs.mkdirSync(src, { recursive: true });
  try {
    moveFile(src, ROOT, dst, ROOT, {});
    throw new Error("expected ToolError for directory source, got none");
  } catch (e) {
    if (!e.message.includes("directory")) throw e;
  } finally {
    if (fs.existsSync(src)) fs.rmdirSync(src);
  }
});

test("copy_file: same-path no-op returns noop: true without touching file", () => {
  const src = path.join(ROOT, "mc-samepath.txt");
  fs.writeFileSync(src, "same");
  const r = copyFile(src, ROOT, src, ROOT, {});
  if (!r.noop)  throw new Error("expected noop: true for same source and destination");
  if (!r.copied) throw new Error("copied should still be true in noop case");
  if (fs.readFileSync(src, "utf8") !== "same") throw new Error("file was modified");
  fs.unlinkSync(src);
});

test("move_file: same-path no-op returns noop: true without touching file", () => {
  const src = path.join(ROOT, "mc-mv-samepath.txt");
  fs.writeFileSync(src, "same move");
  const r = moveFile(src, ROOT, src, ROOT, {});
  if (!r.noop)  throw new Error("expected noop: true for same source and destination");
  if (!r.moved) throw new Error("moved should still be true in noop case");
  if (!fs.existsSync(src)) throw new Error("file should still exist after no-op move");
  fs.unlinkSync(src);
});

// ─── C. High level (edge conditions / failure injection) ──────────────────────
console.log("\n[28-C] move_file / copy_file — High (failure injection / edge cases)");

test("copy_file: result includes { copied: true, noop: false } for normal copy", () => {
  const src = path.join(ROOT, "mc-result-src.txt");
  const dst = path.join(ROOT, "mc-result-dst.txt");
  fs.writeFileSync(src, "result");
  if (fs.existsSync(dst)) fs.unlinkSync(dst);
  const r = copyFile(src, ROOT, dst, ROOT, {});
  if (r.copied !== true)  throw new Error("copied should be true");
  if (r.noop   !== false) throw new Error("noop should be false");
  fs.unlinkSync(src); fs.unlinkSync(dst);
});

test("move_file: result includes { moved: true, crossDevice: false } for same-device move", () => {
  const src = path.join(ROOT, "mc-mv-result-src.txt");
  const dst = path.join(ROOT, "mc-mv-result-dst.txt");
  fs.writeFileSync(src, "move result");
  if (fs.existsSync(dst)) fs.unlinkSync(dst);
  const r = moveFile(src, ROOT, dst, ROOT, {});
  if (r.moved       !== true)  throw new Error("moved should be true");
  if (r.crossDevice !== false)  throw new Error("crossDevice should be false for same-device");
  fs.unlinkSync(dst);
});

test("copy_file: large file (100KB) copies intact", () => {
  const src = path.join(ROOT, "mc-large-src.bin");
  const dst = path.join(ROOT, "mc-large-dst.bin");
  const data = Buffer.alloc(100 * 1024, 0x41);
  fs.writeFileSync(src, data);
  if (fs.existsSync(dst)) fs.unlinkSync(dst);
  copyFile(src, ROOT, dst, ROOT, {});
  const read = fs.readFileSync(dst);
  if (read.length !== data.length) throw new Error(`size mismatch: ${read.length} vs ${data.length}`);
  if (!read.equals(data)) throw new Error("content mismatch on large file");
  fs.unlinkSync(src); fs.unlinkSync(dst);
});

test("move_file: large file (100KB) moves intact", () => {
  const src = path.join(ROOT, "mc-mv-large-src.bin");
  const dst = path.join(ROOT, "mc-mv-large-dst.bin");
  const data = Buffer.alloc(100 * 1024, 0x42);
  fs.writeFileSync(src, data);
  if (fs.existsSync(dst)) fs.unlinkSync(dst);
  moveFile(src, ROOT, dst, ROOT, {});
  if (fs.existsSync(src)) throw new Error("source still exists after large move");
  const read = fs.readFileSync(dst);
  if (!read.equals(data)) throw new Error("content mismatch on large move");
  fs.unlinkSync(dst);
});

test("copy_file: binary file (null bytes) copies bit-perfect", () => {
  const src = path.join(ROOT, "mc-bin-src.bin");
  const dst = path.join(ROOT, "mc-bin-dst.bin");
  const data = Buffer.from([0x00, 0xFF, 0x0A, 0x1B, 0x00, 0xAB, 0xCD]);
  fs.writeFileSync(src, data);
  if (fs.existsSync(dst)) fs.unlinkSync(dst);
  copyFile(src, ROOT, dst, ROOT, {});
  const read = fs.readFileSync(dst);
  if (!read.equals(data)) throw new Error("binary content mismatch");
  fs.unlinkSync(src); fs.unlinkSync(dst);
});

test("copy_file: 10 concurrent copies to distinct destinations are all correct", () => {
  const src = path.join(ROOT, "mc-concurrent-src.txt");
  fs.writeFileSync(src, "concurrent copy content");
  const dsts = [];
  for (let i = 0; i < 10; i++) {
    const dst = path.join(ROOT, `mc-concurrent-dst-${i}.txt`);
    dsts.push(dst);
    if (fs.existsSync(dst)) fs.unlinkSync(dst);
    copyFile(src, ROOT, dst, ROOT, {});
  }
  for (const dst of dsts) {
    if (!fs.existsSync(dst)) throw new Error(`Missing concurrent dst: ${dst}`);
    if (fs.readFileSync(dst, "utf8") !== "concurrent copy content")
      throw new Error(`Content mismatch: ${dst}`);
    fs.unlinkSync(dst);
  }
  fs.unlinkSync(src);
});
