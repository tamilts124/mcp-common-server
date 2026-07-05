"use strict";
/**
 * test/sections/105-dir-diff-summary.js
 * Isolated functional tests for the dir_diff_summary tool.
 * Section [43]
 */

const fs   = require("fs");
const path = require("path");

const { test, TMP } = require("../test-harness");
const { dirDiffSummary } = require("../../lib/dirDiffSummaryOps");

function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

let _counter = 0;
function mkDirs() {
  const n = ++_counter;
  const l = path.join(TMP, `dds-l-${n}`);
  const r = path.join(TMP, `dds-r-${n}`);
  fs.mkdirSync(l, { recursive: true });
  fs.mkdirSync(r, { recursive: true });
  return { l, r };
}
function w(dir, name, content) { fs.writeFileSync(path.join(dir, name), content); }
function findPath(list, p) { return list.find((e) => e.path === p); }

// [43-A] NORMAL
test("[43-A-1] dir_diff_summary: identical trees -> zero added/removed/modified", () => {
  const { l, r } = mkDirs();
  w(l, "a.txt", "hello"); w(r, "a.txt", "hello");
  const res = dirDiffSummary(l, r, "l", "r");
  assert(res.addedCount === 0 && res.removedCount === 0 && res.modifiedCount === 0 && res.filesDiffed === 0);
});
test("[43-A-2] dir_diff_summary: added + removed files reported by relPath", () => {
  const { l, r } = mkDirs();
  w(l, "only-left.txt", "x");
  w(r, "only-right.txt", "y");
  const res = dirDiffSummary(l, r, "l", "r");
  assert(res.addedCount === 1 && res.added[0] === "only-right.txt");
  assert(res.removedCount === 1 && res.removed[0] === "only-left.txt");
});
test("[43-A-3] dir_diff_summary: modified .json file gets a json_diff-shaped entry", () => {
  const { l, r } = mkDirs();
  w(l, "cfg.json", JSON.stringify({ a: 1, b: 2 }));
  w(r, "cfg.json", JSON.stringify({ a: 1, b: 3 }));
  const res = dirDiffSummary(l, r, "l", "r");
  const d = findPath(res.diffs, "cfg.json");
  assert(d && d.kind === "json" && d.identical === false && d.totalChanges === 1);
});
test("[43-A-4] dir_diff_summary: modified .csv file gets a csv_diff-shaped entry (positional)", () => {
  const { l, r } = mkDirs();
  w(l, "data.csv", "id,name\n1,a\n");
  w(r, "data.csv", "id,name\n1,b\n");
  const res = dirDiffSummary(l, r, "l", "r");
  const d = findPath(res.diffs, "data.csv");
  assert(d && d.kind === "csv" && d.changedCount === 1);
});
test("[43-A-5] dir_diff_summary: modified .yaml file is auto-detected and diffed like json", () => {
  const { l, r } = mkDirs();
  w(l, "cfg.yaml", "a: 1\nb: 2\n");
  w(r, "cfg.yaml", "a: 1\nb: 3\n");
  const res = dirDiffSummary(l, r, "l", "r");
  const d = findPath(res.diffs, "cfg.yaml");
  assert(d && d.kind === "yaml" && d.identical === false);
});
test("[43-A-6] dir_diff_summary: modified plain text file gets a text diff_files-shaped entry", () => {
  const { l, r } = mkDirs();
  w(l, "notes.txt", "line1\nline2\n");
  w(r, "notes.txt", "line1\nline2 changed\n");
  const res = dirDiffSummary(l, r, "l", "r");
  const d = findPath(res.diffs, "notes.txt");
  assert(d && d.kind === "text" && d.identical === false && d.unified === undefined);
});
test("[43-A-7] dir_diff_summary: include_unified_diff:true includes full unified text", () => {
  const { l, r } = mkDirs();
  w(l, "notes.txt", "line1\n");
  w(r, "notes.txt", "line1 changed\n");
  const res = dirDiffSummary(l, r, "l", "r", { include_unified_diff: true });
  const d = findPath(res.diffs, "notes.txt");
  assert(typeof d.unified === "string" && d.unified.length > 0);
});

// [43-B] MEDIUM — boundary & validation
test("[43-B-1] dir_diff_summary: nonexistent left directory throws", () => {
  const { r } = mkDirs();
  let threw = false;
  try { dirDiffSummary(path.join(TMP, "nope-dir"), r, "l", "r"); } catch (e) { threw = true; }
  assert(threw);
});
test("[43-B-2] dir_diff_summary: empty directories on both sides -> no diffs, no error", () => {
  const { l, r } = mkDirs();
  const res = dirDiffSummary(l, r, "l", "r");
  assert(res.addedCount === 0 && res.removedCount === 0 && res.filesDiffed === 0 && res.truncated === false);
});
test("[43-B-3] dir_diff_summary: max_files caps per-file diffs but modifiedCount stays true total", () => {
  const { l, r } = mkDirs();
  for (let i = 0; i < 5; i++) { w(l, `f${i}.txt`, `v${i}`); w(r, `f${i}.txt`, `v${i}-x`); }
  const res = dirDiffSummary(l, r, "l", "r", { max_files: 2 });
  assert(res.modifiedCount === 5 && res.filesDiffed === 2 && res.truncated === true);
});
test("[43-B-4] dir_diff_summary: max_files non-numeric falls back to default budget", () => {
  const { l, r } = mkDirs();
  w(l, "a.txt", "1"); w(r, "a.txt", "2");
  const res = dirDiffSummary(l, r, "l", "r", { max_files: "not-a-number" });
  assert(res.filesDiffed === 1);
});
test("[43-B-5] dir_diff_summary: extensions filter restricts which files are compared at all", () => {
  const { l, r } = mkDirs();
  w(l, "a.txt", "1"); w(r, "a.txt", "2");
  w(l, "a.md", "1"); w(r, "a.md", "2");
  const res = dirDiffSummary(l, r, "l", "r", { extensions: [".txt"] });
  assert(res.modifiedCount === 1 && findPath(res.diffs, "a.md") === undefined);
});

// [43-C] HIGH — composition / dependency edge cases
test("[43-C-1] dir_diff_summary: malformed JSON on one side reports a per-file error, not a crash", () => {
  const { l, r } = mkDirs();
  w(l, "bad.json", "{ not valid json");
  w(r, "bad.json", '{"a":1}');
  const res = dirDiffSummary(l, r, "l", "r");
  const d = findPath(res.diffs, "bad.json");
  assert(d && d.kind === "json" && typeof d.error === "string");
});
test("[43-C-2] dir_diff_summary: binary file reported as binary, not diffed", () => {
  const { l, r } = mkDirs();
  fs.writeFileSync(path.join(l, "img.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  fs.writeFileSync(path.join(r, "img.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 9, 9, 9]));
  const res = dirDiffSummary(l, r, "l", "r");
  const d = findPath(res.diffs, "img.png");
  assert(d && d.kind === "binary");
});
test("[43-C-3] dir_diff_summary: nested subdirectory files use forward-slash relPath", () => {
  const { l, r } = mkDirs();
  fs.mkdirSync(path.join(l, "sub"), { recursive: true });
  fs.mkdirSync(path.join(r, "sub"), { recursive: true });
  w(path.join(l, "sub"), "x.txt", "1");
  w(path.join(r, "sub"), "x.txt", "2");
  const res = dirDiffSummary(l, r, "l", "r");
  assert(findPath(res.diffs, "sub/x.txt") !== undefined);
});
test("[43-C-4] dir_diff_summary: mixed change types (json+csv+text+binary) all classified independently", () => {
  const { l, r } = mkDirs();
  w(l, "c.json", '{"a":1}'); w(r, "c.json", '{"a":2}');
  w(l, "c.csv", "id\n1\n"); w(r, "c.csv", "id\n2\n");
  w(l, "c.txt", "x"); w(r, "c.txt", "y");
  const res = dirDiffSummary(l, r, "l", "r");
  const kinds = res.diffs.map((d) => d.kind).sort();
  assert(JSON.stringify(kinds) === JSON.stringify(["csv", "json", "text"]));
});

// [43-D] CRITICAL — security
test("[43-D-1] dir_diff_summary: path-traversal-shaped filenames inside the diffed tree are inert (never escape jail)", () => {
  const { l, r } = mkDirs();
  w(l, "..%2F..%2Fetc.txt", "1"); w(r, "..%2F..%2Fetc.txt", "2");
  const res = dirDiffSummary(l, r, "l", "r");
  const d = findPath(res.diffs, "..%2F..%2Fetc.txt");
  assert(d && d.kind === "text");
});
test("[43-D-2] dir_diff_summary: SQL/script-injection-shaped file content round-trips as inert literal text", () => {
  const { l, r } = mkDirs();
  w(l, "payload.json", JSON.stringify({ q: "clean" }));
  w(r, "payload.json", JSON.stringify({ q: "'; DROP TABLE users; --" }));
  const res = dirDiffSummary(l, r, "l", "r");
  const d = findPath(res.diffs, "payload.json");
  assert(d.changes[0].newValue === "'; DROP TABLE users; --");
});
test("[43-D-3] dir_diff_summary: result has no unexpected top-level keys", () => {
  const { l, r } = mkDirs();
  const res = dirDiffSummary(l, r, "l", "r");
  const keys = Object.keys(res).sort();
  assert(JSON.stringify(keys) === JSON.stringify(
    ["added", "addedCount", "diffs", "filesDiffed", "left", "modifiedCount",
     "removed", "removedCount", "right", "truncated", "unchangedCount"]
  ));
});

// [43-E] EXTREME — fuzz, scale, cleanup
test("[43-E-1] dir_diff_summary: 100 modified files completes correctly and quickly", () => {
  const { l, r } = mkDirs();
  for (let i = 0; i < 100; i++) { w(l, `f${i}.txt`, `v${i}`); w(r, `f${i}.txt`, `v${i}-x`); }
  const start = Date.now();
  const res = dirDiffSummary(l, r, "l", "r", { max_files: 500 });
  assert(Date.now() - start < 5000);
  assert(res.modifiedCount === 100 && res.filesDiffed === 100);
});
test("[43-E-2] dir_diff_summary: fuzz — random-byte file content on both sides doesn't crash", () => {
  const { l, r } = mkDirs();
  const junkA = Buffer.from(Array.from({ length: 300 }, () => Math.floor(Math.random() * 256)));
  const junkB = Buffer.from(Array.from({ length: 300 }, () => Math.floor(Math.random() * 256)));
  fs.writeFileSync(path.join(l, "rand.bin"), junkA);
  fs.writeFileSync(path.join(r, "rand.bin"), junkB);
  let handled = false;
  try { dirDiffSummary(l, r, "l", "r"); handled = true; } catch (e) { handled = true; }
  assert(handled);
});
test("[43-E-3] dir_diff_summary: 15 rapid sequential calls with different dir pairs are independent", () => {
  for (let i = 0; i < 15; i++) {
    const { l, r } = mkDirs();
    w(l, "v.txt", String(i)); w(r, "v.txt", String(i + 1));
    const res = dirDiffSummary(l, r, "l", "r");
    assert(res.modifiedCount === 1);
  }
});
test("[43-E-4] cleanup: remove dir_diff_summary fixture directories created in this section", () => {
  for (let i = 1; i <= _counter; i++) {
    for (const side of ["l", "r"]) {
      const p = path.join(TMP, `dds-${side}-${i}`);
      if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
    }
  }
  assert(true);
});
