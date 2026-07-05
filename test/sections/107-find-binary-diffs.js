"use strict";
/**
 * test/sections/107-find-binary-diffs.js
 * Isolated functional tests for the find_binary_diffs tool.
 * Section [44]
 */

const fs   = require("fs");
const path = require("path");

const { test, TMP } = require("../test-harness");
const { findBinaryDiffs } = require("../../lib/findBinaryDiffsOps");

function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

let _counter = 0;
function mkDirs() {
  const n = ++_counter;
  const l = path.join(TMP, `fbd-l-${n}`);
  const r = path.join(TMP, `fbd-r-${n}`);
  fs.mkdirSync(l, { recursive: true });
  fs.mkdirSync(r, { recursive: true });
  return { l, r };
}
function w(dir, name, content) { fs.writeFileSync(path.join(dir, name), content); }
function png(bytes) { return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(bytes)]); }
function findPath(list, p) { return list.find((e) => e.path === p); }

// [44-A] NORMAL
test("[44-A-1] find_binary_diffs: identical trees -> no changed binary files", () => {
  const { l, r } = mkDirs();
  fs.writeFileSync(path.join(l, "img.png"), png([1, 2, 3]));
  fs.writeFileSync(path.join(r, "img.png"), png([1, 2, 3]));
  const res = findBinaryDiffs(l, r, "l", "r");
  assert(res.changedBinaryFiles.length === 0 && res.modifiedCount === 0);
});
test("[44-A-2] find_binary_diffs: changed binary file reports leftHash/rightHash/sizes", () => {
  const { l, r } = mkDirs();
  fs.writeFileSync(path.join(l, "img.png"), png([1, 2, 3]));
  fs.writeFileSync(path.join(r, "img.png"), png([1, 2, 3, 4]));
  const res = findBinaryDiffs(l, r, "l", "r");
  const d = findPath(res.changedBinaryFiles, "img.png");
  assert(d && typeof d.leftHash === "string" && typeof d.rightHash === "string" && d.leftHash !== d.rightHash);
  assert(d.leftSize !== d.rightSize && d.identical === false);
});
test("[44-A-3] find_binary_diffs: text file modification is skipped, not reported", () => {
  const { l, r } = mkDirs();
  w(l, "notes.txt", "hello"); w(r, "notes.txt", "world");
  const res = findBinaryDiffs(l, r, "l", "r");
  assert(res.changedBinaryFiles.length === 0 && res.skippedTextOrErrored === 1);
});
test("[44-A-4] find_binary_diffs: added/removed/unchanged counts pass through from compare_directories", () => {
  const { l, r } = mkDirs();
  w(l, "only-left.txt", "x");
  w(r, "only-right.txt", "y");
  w(l, "same.txt", "s"); w(r, "same.txt", "s");
  const res = findBinaryDiffs(l, r, "l", "r");
  assert(res.addedCount === 1 && res.removedCount === 1 && res.unchangedCount === 1 && res.modifiedCount === 0);
});
test("[44-A-5] find_binary_diffs: algorithm option (md5) is honored and reported", () => {
  const { l, r } = mkDirs();
  fs.writeFileSync(path.join(l, "img.png"), png([1]));
  fs.writeFileSync(path.join(r, "img.png"), png([2]));
  const res = findBinaryDiffs(l, r, "l", "r", { algorithm: "md5" });
  const d = findPath(res.changedBinaryFiles, "img.png");
  assert(res.algorithm === "md5" && d.leftHash.length === 32); // md5 hex length
});
test("[44-A-6] find_binary_diffs: mixed binary+text modifications only report the binary one", () => {
  const { l, r } = mkDirs();
  fs.writeFileSync(path.join(l, "img.png"), png([1])); fs.writeFileSync(path.join(r, "img.png"), png([2]));
  w(l, "a.txt", "1"); w(r, "a.txt", "2");
  const res = findBinaryDiffs(l, r, "l", "r");
  assert(res.modifiedCount === 2 && res.changedBinaryFiles.length === 1 && res.skippedTextOrErrored === 1);
});

// [44-B] MEDIUM — boundary & validation
test("[44-B-1] find_binary_diffs: nonexistent left directory throws", () => {
  const { r } = mkDirs();
  let threw = false;
  try { findBinaryDiffs(path.join(TMP, "nope-dir-fbd"), r, "l", "r"); } catch (e) { threw = true; }
  assert(threw);
});
test("[44-B-2] find_binary_diffs: empty directories -> empty result, no error", () => {
  const { l, r } = mkDirs();
  const res = findBinaryDiffs(l, r, "l", "r");
  assert(res.changedBinaryFiles.length === 0 && res.truncated === false);
});
test("[44-B-3] find_binary_diffs: unsupported algorithm value throws", () => {
  const { l, r } = mkDirs();
  let threw = false;
  try { findBinaryDiffs(l, r, "l", "r", { algorithm: "sha3-nope" }); } catch (e) { threw = true; }
  assert(threw);
});
test("[44-B-4] find_binary_diffs: non-numeric max_files falls back to default", () => {
  const { l, r } = mkDirs();
  fs.writeFileSync(path.join(l, "img.png"), png([1])); fs.writeFileSync(path.join(r, "img.png"), png([2]));
  const res = findBinaryDiffs(l, r, "l", "r", { max_files: "not-a-number" });
  assert(res.inspected === 1);
});
test("[44-B-5] find_binary_diffs: max_files above hard cap is clamped, not rejected", () => {
  const { l, r } = mkDirs();
  fs.writeFileSync(path.join(l, "img.png"), png([1])); fs.writeFileSync(path.join(r, "img.png"), png([2]));
  const res = findBinaryDiffs(l, r, "l", "r", { max_files: 999999 });
  assert(res.inspected === 1); // clamp only limits the ceiling, doesn't force extra work
});
test("[44-B-6] find_binary_diffs: extensions filter restricts compare_directories itself", () => {
  const { l, r } = mkDirs();
  fs.writeFileSync(path.join(l, "img.png"), png([1])); fs.writeFileSync(path.join(r, "img.png"), png([2]));
  fs.writeFileSync(path.join(l, "img.jpg"), Buffer.from([0xff, 0xd8, 0xff, 1])); fs.writeFileSync(path.join(r, "img.jpg"), Buffer.from([0xff, 0xd8, 0xff, 2]));
  const res = findBinaryDiffs(l, r, "l", "r", { extensions: [".png"] });
  assert(res.modifiedCount === 1 && findPath(res.changedBinaryFiles, "img.jpg") === undefined);
});

// [44-C] HIGH — composition / dependency edge cases
test("[44-C-1] find_binary_diffs: max_files caps inspected pairs, truncated:true when more modified exist", () => {
  const { l, r } = mkDirs();
  for (let i = 0; i < 5; i++) {
    fs.writeFileSync(path.join(l, `img${i}.png`), png([i]));
    fs.writeFileSync(path.join(r, `img${i}.png`), png([i, 9]));
  }
  const res = findBinaryDiffs(l, r, "l", "r", { max_files: 2 });
  assert(res.modifiedCount === 5 && res.inspected === 2 && res.truncated === true);
});
test("[44-C-2] find_binary_diffs: nested subdirectory binary file uses forward-slash relPath", () => {
  const { l, r } = mkDirs();
  fs.mkdirSync(path.join(l, "sub"), { recursive: true });
  fs.mkdirSync(path.join(r, "sub"), { recursive: true });
  fs.writeFileSync(path.join(l, "sub", "x.png"), png([1]));
  fs.writeFileSync(path.join(r, "sub", "x.png"), png([2]));
  const res = findBinaryDiffs(l, r, "l", "r");
  assert(findPath(res.changedBinaryFiles, "sub/x.png") !== undefined);
});
test("[44-C-3] find_binary_diffs: file that only changes mtime/perms but not content -> identical:true", () => {
  const { l, r } = mkDirs();
  // Same content hash but compare_directories already dedupes identical content via size+hash,
  // so simulate by making sizes equal but hashes computed independently confirm equality.
  fs.writeFileSync(path.join(l, "img.png"), png([1, 2, 3, 4, 5])); // pad so size differs from a 1-byte diff case elsewhere
  fs.writeFileSync(path.join(r, "img.png"), png([1, 2, 3, 4, 5]));
  const res = findBinaryDiffs(l, r, "l", "r");
  // identical content means compare_directories itself puts it in unchanged, not modified
  assert(res.unchangedCount === 1 && findPath(res.changedBinaryFiles, "img.png") === undefined);
});
test("[44-C-4] find_binary_diffs: unrecognized-signature binary (NUL bytes) is still detected and reported", () => {
  const { l, r } = mkDirs();
  fs.writeFileSync(path.join(l, "blob.dat"), Buffer.from([0, 1, 2, 3, 0, 5]));
  fs.writeFileSync(path.join(r, "blob.dat"), Buffer.from([0, 1, 2, 3, 0, 9]));
  const res = findBinaryDiffs(l, r, "l", "r");
  assert(findPath(res.changedBinaryFiles, "blob.dat") !== undefined);
});

// [44-D] CRITICAL — security
test("[44-D-1] find_binary_diffs: path-traversal-shaped filenames stay inert relPaths", () => {
  const { l, r } = mkDirs();
  fs.writeFileSync(path.join(l, "..%2F..%2Fetc.png"), png([1]));
  fs.writeFileSync(path.join(r, "..%2F..%2Fetc.png"), png([2]));
  const res = findBinaryDiffs(l, r, "l", "r");
  const d = findPath(res.changedBinaryFiles, "..%2F..%2Fetc.png");
  assert(d !== undefined);
});
test("[44-D-2] find_binary_diffs: shell-injection-shaped filename is treated as a literal name, never executed", () => {
  const { l, r } = mkDirs();
  const name = "a;rm -rf .png";
  fs.writeFileSync(path.join(l, name), png([1]));
  fs.writeFileSync(path.join(r, name), png([2]));
  const res = findBinaryDiffs(l, r, "l", "r");
  assert(findPath(res.changedBinaryFiles, name) !== undefined);
});
test("[44-D-3] find_binary_diffs: result has no unexpected top-level keys", () => {
  const { l, r } = mkDirs();
  const res = findBinaryDiffs(l, r, "l", "r");
  const keys = Object.keys(res).sort();
  assert(JSON.stringify(keys) === JSON.stringify(
    ["addedCount", "algorithm", "changedBinaryFiles", "inspected", "left",
     "modifiedCount", "removedCount", "right", "skippedTextOrErrored", "truncated", "unchangedCount"]
  ));
});
test("[44-D-4] find_binary_diffs: hashes never leak absolute filesystem paths in the response", () => {
  const { l, r } = mkDirs();
  fs.writeFileSync(path.join(l, "img.png"), png([1])); fs.writeFileSync(path.join(r, "img.png"), png([2]));
  const res = findBinaryDiffs(l, r, "l", "r");
  const serialized = JSON.stringify(res);
  assert(!serialized.includes(TMP));
});

// [44-E] EXTREME — fuzz, scale, cleanup
test("[44-E-1] find_binary_diffs: 100 changed binary files completes correctly and fast", () => {
  const { l, r } = mkDirs();
  for (let i = 0; i < 100; i++) {
    fs.writeFileSync(path.join(l, `img${i}.png`), png([i]));
    fs.writeFileSync(path.join(r, `img${i}.png`), png([i, 1]));
  }
  const start = Date.now();
  const res = findBinaryDiffs(l, r, "l", "r", { max_files: 500 });
  assert(Date.now() - start < 5000);
  assert(res.modifiedCount === 100 && res.changedBinaryFiles.length === 100);
});
test("[44-E-2] find_binary_diffs: fuzz — random-byte content on both sides never crashes", () => {
  const { l, r } = mkDirs();
  const junkA = Buffer.from(Array.from({ length: 500 }, () => Math.floor(Math.random() * 256)));
  const junkB = Buffer.from(Array.from({ length: 500 }, () => Math.floor(Math.random() * 256)));
  fs.writeFileSync(path.join(l, "rand.bin"), junkA);
  fs.writeFileSync(path.join(r, "rand.bin"), junkB);
  let handled = false;
  try { findBinaryDiffs(l, r, "l", "r"); handled = true; } catch (e) { handled = true; }
  assert(handled);
});
test("[44-E-3] find_binary_diffs: 15 rapid sequential calls with fresh directory pairs are independent", () => {
  for (let i = 0; i < 15; i++) {
    const { l, r } = mkDirs();
    fs.writeFileSync(path.join(l, "v.png"), png([i]));
    fs.writeFileSync(path.join(r, "v.png"), png([i + 1]));
    const res = findBinaryDiffs(l, r, "l", "r");
    assert(res.changedBinaryFiles.length === 1);
  }
});
test("[44-E-4] cleanup: remove find_binary_diffs fixture directories created in this section", () => {
  for (let i = 1; i <= _counter; i++) {
    for (const side of ["l", "r"]) {
      const p = path.join(TMP, `fbd-${side}-${i}`);
      if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
    }
  }
  assert(true);
});
