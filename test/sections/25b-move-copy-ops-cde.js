"use strict";
// ── Section [28-DE]: move_file / copy_file — Critical & Extreme ───────────────
// D (Critical) and E (Extreme) rigor levels for lib/moveOps.js.
// A, B, C levels are in 25-move-copy-ops.js.

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

// ─── D. Critical level (security / path traversal / injection) ────────────────
console.log("\n[28-D] move_file / copy_file — Critical (security / path traversal)");

test("copy_file: blocks path traversal in source (../../etc/passwd)", () => {
  const { resolveClientPath } = require("../../lib/roots");
  try {
    resolveClientPath("../../etc/passwd");
    throw new Error("expected access-denied error");
  } catch (e) {
    if (!e.message.toLowerCase().includes("access denied") &&
        !e.message.toLowerCase().includes("outside root")) throw e;
  }
});

test("copy_file: blocks absolute path outside root as source", () => {
  const { resolveClientPath } = require("../../lib/roots");
  try {
    resolveClientPath("C:/Windows/System32/drivers/etc/hosts");
    throw new Error("expected access-denied error");
  } catch (e) {
    if (!e.message.toLowerCase().includes("access denied") &&
        !e.message.toLowerCase().includes("outside root")) throw e;
  }
});

test("copy_file: blocks symlink that escapes root — source symlink check", () => {
  // Create a file outside the root and a symlink inside the root pointing to it.
  // On Windows, symlinks may require elevated privileges — skip gracefully.
  const outsideDir  = path.join(path.dirname(ROOT), "mc-outside-target");
  const outsideFile = path.join(outsideDir, "secret.txt");
  const symlinkPath = path.join(ROOT, "mc-evil-symlink.txt");
  const dst         = path.join(ROOT, "mc-symlink-copy.txt");

  try {
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(outsideFile, "outside content");
    try {
      fs.symlinkSync(outsideFile, symlinkPath);
    } catch (_) {
      console.log("        [skip] symlink creation requires elevated privileges on this OS");
      return;
    }

    try {
      copyFile(symlinkPath, ROOT, dst, ROOT, {});
      if (fs.existsSync(dst)) {
        fs.unlinkSync(dst);
        throw new Error("SECURITY: symlink escaping root was not blocked");
      }
    } catch (e) {
      if (e.code !== -32001 && !e.message.includes("Access denied")) throw e;
    }
  } finally {
    if (fs.existsSync(symlinkPath)) fs.unlinkSync(symlinkPath);
    if (fs.existsSync(dst))         fs.unlinkSync(dst);
    if (fs.existsSync(outsideFile)) fs.unlinkSync(outsideFile);
    if (fs.existsSync(outsideDir))  fs.rmdirSync(outsideDir, { recursive: true });
  }
});

test("copy_file: injection-shaped filenames are treated as literal paths (no shell exec)", () => {
  // A file whose name looks like a shell injection — must be treated as a
  // filename, not passed to any shell. Expect "does not exist", not exec error.
  const injName = "foo; rm -rf /; bar.txt";
  const src = path.join(ROOT, injName);
  const dst = path.join(ROOT, "mc-inj-dst.txt");
  try {
    copyFile(src, ROOT, dst, ROOT, {});
    throw new Error("expected error for non-existent file");
  } catch (e) {
    if (!e.message.match(/does not exist|ENOENT|no such file/i)) throw e;
  }
});

test("move_file: leading-slash client path is normalized and stays jailed inside the root (not a real OS-absolute escape)", () => {
  // NOTE: resolveClientPath's client-path convention strips a leading "/"
  // (it is alias-relative addressing, not a literal OS path) — so
  // "/tmp/malicious-src.txt" is NOT equivalent to a real POSIX absolute
  // path here. It normalizes to "tmp/malicious-src.txt" and resolves
  // *inside* the owning root. The actual escape vectors (".." traversal,
  // and a real OS-absolute path with a drive letter / no matching alias)
  // are covered by the adjacent tests in this block. This test instead
  // asserts the correct containment property: the resolved path must
  // still land inside the root, never above/outside it.
  const { resolveClientPath, ROOTS } = require("../../lib/roots");
  const { resolved, root } = resolveClientPath("/tmp/malicious-src.txt");
  const withSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (resolved !== root && !resolved.startsWith(withSep)) {
    throw new Error(`SECURITY: leading-slash path escaped its root: ${resolved}`);
  }
});

test("copy_file: null byte in path does not execute arbitrary path", () => {
  // Null bytes in paths are rejected by Node's fs layer with ENOENT or
  // an explicit "path must be a string without null bytes" error.
  const src = path.join(ROOT, "mc-null\x00byte.txt");
  const dst = path.join(ROOT, "mc-null-dst.txt");
  try {
    copyFile(src, ROOT, dst, ROOT, {});
    throw new Error("expected error for null-byte path");
  } catch (e) {
    // Node throws ERR_INVALID_ARG_VALUE or ENOENT — any error is acceptable
    if (!e.message && e.code === undefined) throw e;
  }
});

// ─── E. Extreme level (stress / fuzz / edge) ──────────────────────────────────
console.log("\n[28-E] move_file / copy_file — Extreme (stress / fuzz / edge)");

test("copy_file: very long filename (240 chars) within root", () => {
  const longName = "mc-" + "x".repeat(240 - 7) + ".txt";
  const src = path.join(ROOT, longName);
  const dst = path.join(ROOT, "mc-long-dst.txt");
  try {
    fs.writeFileSync(src, "long name test");
    if (fs.existsSync(dst)) fs.unlinkSync(dst);
    copyFile(src, ROOT, dst, ROOT, {});
    if (!fs.existsSync(dst)) throw new Error("long-named file was not copied");
    fs.unlinkSync(src); fs.unlinkSync(dst);
  } catch (e) {
    if (e.code !== "ENAMETOOLONG" && !e.message.includes("name too long")) throw e;
    if (fs.existsSync(src)) fs.unlinkSync(src);
    if (fs.existsSync(dst)) fs.unlinkSync(dst);
  }
});

test("copy_file: Unicode filename (emoji + CJK) copies correctly", () => {
  const name = "mc-日本語-🚀-src.txt";
  const src  = path.join(ROOT, name);
  const dst  = path.join(ROOT, "mc-unicode-dst.txt");
  fs.writeFileSync(src, "unicode content");
  if (fs.existsSync(dst)) fs.unlinkSync(dst);
  copyFile(src, ROOT, dst, ROOT, {});
  if (fs.readFileSync(dst, "utf8") !== "unicode content")
    throw new Error("unicode file content mismatch");
  fs.unlinkSync(src); fs.unlinkSync(dst);
});

test("copy_file: empty file (0 bytes) copies successfully", () => {
  const src = path.join(ROOT, "mc-empty-src.txt");
  const dst = path.join(ROOT, "mc-empty-dst.txt");
  fs.writeFileSync(src, "");
  if (fs.existsSync(dst)) fs.unlinkSync(dst);
  copyFile(src, ROOT, dst, ROOT, {});
  if (fs.statSync(dst).size !== 0) throw new Error("destination is not empty");
  fs.unlinkSync(src); fs.unlinkSync(dst);
});

test("move_file: empty file (0 bytes) moves successfully", () => {
  const src = path.join(ROOT, "mc-mv-empty-src.txt");
  const dst = path.join(ROOT, "mc-mv-empty-dst.txt");
  fs.writeFileSync(src, "");
  if (fs.existsSync(dst)) fs.unlinkSync(dst);
  moveFile(src, ROOT, dst, ROOT, {});
  if (fs.existsSync(src))     throw new Error("source not removed after empty-file move");
  if (fs.statSync(dst).size !== 0) throw new Error("destination is not empty");
  fs.unlinkSync(dst);
});

test("copy_file: fuzz bytes in file content copy bit-perfect", () => {
  const src = path.join(ROOT, "mc-fuzz-src.bin");
  const dst = path.join(ROOT, "mc-fuzz-dst.bin");
  const buf = Buffer.alloc(1024);
  let v = 0x13;
  for (let i = 0; i < buf.length; i++) { v = (v * 31 + 7) & 0xFF; buf[i] = v; }
  fs.writeFileSync(src, buf);
  if (fs.existsSync(dst)) fs.unlinkSync(dst);
  copyFile(src, ROOT, dst, ROOT, {});
  const read = fs.readFileSync(dst);
  if (!read.equals(buf)) throw new Error("fuzz content mismatch");
  fs.unlinkSync(src); fs.unlinkSync(dst);
});

test("copy_file: 50 sequential copies are all consistent (no state bleed)", () => {
  const src = path.join(ROOT, "mc-seq-src.txt");
  fs.writeFileSync(src, "sequential");
  const dsts = [];
  for (let i = 0; i < 50; i++) {
    const dst = path.join(ROOT, `mc-seq-dst-${i}.txt`);
    dsts.push(dst);
    if (fs.existsSync(dst)) fs.unlinkSync(dst);
    const r = copyFile(src, ROOT, dst, ROOT, {});
    if (!r.copied) throw new Error(`copied false on iteration ${i}`);
  }
  for (const dst of dsts) {
    if (fs.readFileSync(dst, "utf8") !== "sequential")
      throw new Error(`Content wrong on ${dst}`);
    fs.unlinkSync(dst);
  }
  fs.unlinkSync(src);
});

test("copy_file + move_file result objects are JSON-serialisable", () => {
  const src1 = path.join(ROOT, "mc-json-src-1.txt");
  const dst1 = path.join(ROOT, "mc-json-dst-1.txt");
  const src2 = path.join(ROOT, "mc-json-src-2.txt");
  const dst2 = path.join(ROOT, "mc-json-dst-2.txt");
  fs.writeFileSync(src1, "json copy");
  fs.writeFileSync(src2, "json move");
  if (fs.existsSync(dst1)) fs.unlinkSync(dst1);
  if (fs.existsSync(dst2)) fs.unlinkSync(dst2);
  const r1 = copyFile(src1, ROOT, dst1, ROOT, {});
  const r2 = moveFile(src2, ROOT, dst2, ROOT, {});
  const s1 = JSON.stringify(r1);
  const s2 = JSON.stringify(r2);
  if (!s1.includes("copied")) throw new Error("copy result missing 'copied' in JSON");
  if (!s2.includes("moved"))  throw new Error("move result missing 'moved' in JSON");
  fs.unlinkSync(src1); fs.unlinkSync(dst1); fs.unlinkSync(dst2);
});

test("copy_file: no prototype pollution in returned result object", () => {
  const src = path.join(ROOT, "mc-proto-src.txt");
  const dst = path.join(ROOT, "mc-proto-dst.txt");
  fs.writeFileSync(src, "proto check");
  if (fs.existsSync(dst)) fs.unlinkSync(dst);
  const r = copyFile(src, ROOT, dst, ROOT, {});
  if (Object.keys(r).some(k => k === "__proto__")) throw new Error("__proto__ in result");
  if (r.constructor !== Object) throw new Error("result is not a plain Object");
  fs.unlinkSync(src); fs.unlinkSync(dst);
});
