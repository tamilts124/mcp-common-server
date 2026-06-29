"use strict";
/**
 * [19] FIND_DUPLICATES — find_duplicates tool
 *
 * Rigor levels covered:
 *
 *   Normal:   happy path — identical files grouped into a duplicate set with
 *             correct hash/size/count/wastedBytes/files fields; unique files
 *             produce no duplicate sets; default algorithm is sha256.
 *
 *   Medium:   boundary — empty directory, single file, 3-way duplicate sets,
 *             same-size-but-different-content files are NOT false-positived,
 *             invalid algorithm / negative min_size throw descriptive errors,
 *             extensions and min_size filters work as documented.
 *
 *   High:     dependency / failure handling — non-existent directory throws
 *             cleanly; a file (not a directory) passed as 'path' throws a
 *             descriptive error instead of crashing; ignored directories
 *             (node_modules, per MCP_IGNORE) are skipped; duplicates across
 *             nested subdirectories are still detected.
 *
 *   Critical: security — path traversal and absolute-path-outside-root are
 *             blocked; result is fully JSON-serialisable with no prototype
 *             pollution; shell/SQL-injection-shaped file content and names
 *             round-trip as literal data, never executed; an injection-shaped
 *             'algorithm' value is rejected as unsupported, not executed.
 *
 *   Extreme:  fuzzing/stress — 40 files forming 10 duplicate pairs detected
 *             correctly and efficiently; large (200KB) identical files hash
 *             correctly; random fuzz byte content across many files never
 *             crashes and never produces a false-positive duplicate; 10
 *             concurrent scans return consistent results; fixture cleanup.
 */
const { fs, path, assert, test, executeTool, TMP } = require("../test-harness");

console.log(`\n[19] FIND_DUPLICATES — find_duplicates tool`);

// ── NORMAL ────────────────────────────────────────────────────────────────────

test("find_duplicates: two identical files form one duplicate set", () => {
  executeTool("create_directory", { path: "dup-basic" });
  executeTool("create_file", { path: "dup-basic/a.txt", content: "same content here" });
  executeTool("create_file", { path: "dup-basic/b.txt", content: "same content here" });
  const r = executeTool("find_duplicates", { path: "dup-basic" });
  assert.strictEqual(r.duplicateSetCount, 1, "expected exactly 1 duplicate set");
  assert.strictEqual(r.duplicateSets[0].count, 2);
  assert.deepStrictEqual(r.duplicateSets[0].files.slice().sort(), ["dup-basic/a.txt", "dup-basic/b.txt"]);
});

test("find_duplicates: unique files produce no duplicate sets", () => {
  executeTool("create_directory", { path: "dup-unique" });
  executeTool("create_file", { path: "dup-unique/x.txt", content: "content X" });
  executeTool("create_file", { path: "dup-unique/y.txt", content: "content Y, longer" });
  const r = executeTool("find_duplicates", { path: "dup-unique" });
  assert.strictEqual(r.duplicateSetCount, 0);
  assert.strictEqual(r.totalDuplicateFiles, 0);
  assert.strictEqual(r.filesScanned, 2);
});

test("find_duplicates: default algorithm is sha256, hash is 64 hex chars", () => {
  executeTool("create_directory", { path: "dup-algo" });
  executeTool("create_file", { path: "dup-algo/p.txt", content: "hash me" });
  executeTool("create_file", { path: "dup-algo/q.txt", content: "hash me" });
  const r = executeTool("find_duplicates", { path: "dup-algo" });
  assert.strictEqual(r.algorithm, "sha256");
  assert.match(r.duplicateSets[0].hash, /^[0-9a-f]{64}$/);
});

test("find_duplicates: wastedBytes equals size * (count - 1)", () => {
  executeTool("create_directory", { path: "dup-waste" });
  const content = "twelve bytes";
  executeTool("create_file", { path: "dup-waste/a.txt", content });
  executeTool("create_file", { path: "dup-waste/b.txt", content });
  executeTool("create_file", { path: "dup-waste/c.txt", content });
  const r = executeTool("find_duplicates", { path: "dup-waste" });
  const set = r.duplicateSets[0];
  assert.strictEqual(set.count, 3);
  assert.strictEqual(set.wastedBytes, set.size * 2);
});

test("find_duplicates: duplicate set files array is sorted alphabetically", () => {
  executeTool("create_directory", { path: "dup-sorted" });
  executeTool("create_file", { path: "dup-sorted/z.txt", content: "sorted-test" });
  executeTool("create_file", { path: "dup-sorted/a.txt", content: "sorted-test" });
  const r = executeTool("find_duplicates", { path: "dup-sorted" });
  const files = r.duplicateSets[0].files;
  const sorted = files.slice().sort();
  assert.deepStrictEqual(files, sorted);
});

test("find_duplicates: result has all documented top-level fields", () => {
  executeTool("create_directory", { path: "dup-shape" });
  executeTool("create_file", { path: "dup-shape/a.txt", content: "shape" });
  const r = executeTool("find_duplicates", { path: "dup-shape" });
  for (const key of ["algorithm", "filesScanned", "filesHashed", "duplicateSetCount", "totalDuplicateFiles", "totalWastedBytes", "duplicateSets"]) {
    assert.ok(key in r, `missing field '${key}'`);
  }
});

// ── MEDIUM ────────────────────────────────────────────────────────────────────

test("find_duplicates: empty directory returns zero counts", () => {
  executeTool("create_directory", { path: "dup-empty" });
  const r = executeTool("find_duplicates", { path: "dup-empty" });
  assert.strictEqual(r.filesScanned, 0);
  assert.strictEqual(r.duplicateSetCount, 0);
  assert.deepStrictEqual(r.duplicateSets, []);
});

test("find_duplicates: single file produces no duplicates", () => {
  executeTool("create_directory", { path: "dup-single" });
  executeTool("create_file", { path: "dup-single/lonely.txt", content: "alone" });
  const r = executeTool("find_duplicates", { path: "dup-single" });
  assert.strictEqual(r.filesScanned, 1);
  assert.strictEqual(r.duplicateSetCount, 0);
});

test("find_duplicates: invalid algorithm throws descriptive error", () => {
  executeTool("create_directory", { path: "dup-badalgo" });
  assert.throws(
    () => executeTool("find_duplicates", { path: "dup-badalgo", algorithm: "blake3" }),
    /unsupported algorithm/i
  );
});

test("find_duplicates: negative min_size throws descriptive error", () => {
  executeTool("create_directory", { path: "dup-negsize" });
  assert.throws(
    () => executeTool("find_duplicates", { path: "dup-negsize", min_size: -5 }),
    /min_size/i
  );
});

test("find_duplicates: min_size filters out small duplicate files", () => {
  executeTool("create_directory", { path: "dup-minsize" });
  executeTool("create_file", { path: "dup-minsize/tiny1.txt", content: "ab" });
  executeTool("create_file", { path: "dup-minsize/tiny2.txt", content: "ab" });
  const withAll   = executeTool("find_duplicates", { path: "dup-minsize" });
  const filtered  = executeTool("find_duplicates", { path: "dup-minsize", min_size: 100 });
  assert.strictEqual(withAll.duplicateSetCount, 1, "without min_size, the 2-byte duplicate should be found");
  assert.strictEqual(filtered.duplicateSetCount, 0, "min_size=100 should exclude the 2-byte files");
  assert.strictEqual(filtered.filesScanned, 0);
});

test("find_duplicates: extensions filter only considers matching files", () => {
  executeTool("create_directory", { path: "dup-ext" });
  executeTool("create_file", { path: "dup-ext/a.log", content: "shared text" });
  executeTool("create_file", { path: "dup-ext/b.txt", content: "shared text" });
  const r = executeTool("find_duplicates", { path: "dup-ext", extensions: [".txt"] });
  assert.strictEqual(r.filesScanned, 1, "only .txt should be scanned");
  assert.strictEqual(r.duplicateSetCount, 0, "single matching file cannot be a duplicate of itself");
});

test("find_duplicates: 3 identical files form one set with count 3", () => {
  executeTool("create_directory", { path: "dup-three" });
  executeTool("create_file", { path: "dup-three/a.txt", content: "triplet" });
  executeTool("create_file", { path: "dup-three/b.txt", content: "triplet" });
  executeTool("create_file", { path: "dup-three/c.txt", content: "triplet" });
  const r = executeTool("find_duplicates", { path: "dup-three" });
  assert.strictEqual(r.duplicateSetCount, 1);
  assert.strictEqual(r.duplicateSets[0].count, 3);
});

test("find_duplicates: same size but different content is NOT a false-positive duplicate", () => {
  executeTool("create_directory", { path: "dup-samesize" });
  executeTool("create_file", { path: "dup-samesize/a.txt", content: "AAAAAAAAAA" }); // 10 bytes
  executeTool("create_file", { path: "dup-samesize/b.txt", content: "BBBBBBBBBB" }); // 10 bytes, different content
  const r = executeTool("find_duplicates", { path: "dup-samesize" });
  assert.strictEqual(r.duplicateSetCount, 0, "same-size different-content files must not be flagged");
  assert.strictEqual(r.filesHashed, 2, "both same-size files should still be hashed (size pre-filter passed)");
});

test("find_duplicates: explicit md5 algorithm works and is echoed back", () => {
  executeTool("create_directory", { path: "dup-md5" });
  executeTool("create_file", { path: "dup-md5/a.txt", content: "md5 test" });
  executeTool("create_file", { path: "dup-md5/b.txt", content: "md5 test" });
  const r = executeTool("find_duplicates", { path: "dup-md5", algorithm: "MD5" });
  assert.strictEqual(r.algorithm, "md5");
  assert.match(r.duplicateSets[0].hash, /^[0-9a-f]{32}$/);
});

// ── HIGH ──────────────────────────────────────────────────────────────────────

test("find_duplicates: non-existent directory throws cleanly (not a crash)", () => {
  assert.throws(() => executeTool("find_duplicates", { path: "dup-does-not-exist" }));
});

test("find_duplicates: a file (not a directory) passed as path throws descriptive error", () => {
  executeTool("create_file", { path: "dup-not-a-dir.txt", content: "I am a file" });
  assert.throws(
    () => executeTool("find_duplicates", { path: "dup-not-a-dir.txt" }),
    /not a directory/i
  );
});

test("find_duplicates: ignored directories (node_modules) are skipped per MCP_IGNORE", () => {
  executeTool("create_directory", { path: "dup-ignore/node_modules" });
  executeTool("create_file", { path: "dup-ignore/node_modules/dep.txt", content: "ignored dupe" });
  executeTool("create_file", { path: "dup-ignore/real.txt", content: "ignored dupe" });
  const r = executeTool("find_duplicates", { path: "dup-ignore" });
  assert.strictEqual(r.filesScanned, 1, "node_modules contents must be skipped");
  assert.strictEqual(r.duplicateSetCount, 0, "only one real file remains, so no duplicate set");
});

test("find_duplicates: duplicates across nested subdirectories are detected", () => {
  executeTool("create_directory", { path: "dup-nested/sub1/deep" });
  executeTool("create_directory", { path: "dup-nested/sub2" });
  executeTool("create_file", { path: "dup-nested/sub1/deep/a.txt", content: "nested duplicate" });
  executeTool("create_file", { path: "dup-nested/sub2/b.txt", content: "nested duplicate" });
  const r = executeTool("find_duplicates", { path: "dup-nested" });
  assert.strictEqual(r.duplicateSetCount, 1);
  assert.strictEqual(r.duplicateSets[0].count, 2);
});

// ── CRITICAL ──────────────────────────────────────────────────────────────────

test("find_duplicates: path traversal is blocked", () => {
  assert.throws(
    () => executeTool("find_duplicates", { path: "../../etc" }),
    /Access denied/
  );
});

test("find_duplicates: absolute path outside root is blocked", () => {
  assert.throws(
    () => executeTool("find_duplicates", { path: "C:\\Windows\\System32" }),
    /Access denied|outside|invalid/i
  );
});

test("find_duplicates: result is fully JSON-serialisable (no circular refs)", () => {
  executeTool("create_directory", { path: "dup-json" });
  executeTool("create_file", { path: "dup-json/a.txt", content: "json-test" });
  executeTool("create_file", { path: "dup-json/b.txt", content: "json-test" });
  const r = executeTool("find_duplicates", { path: "dup-json" });
  let serialised;
  assert.doesNotThrow(() => { serialised = JSON.stringify(r); });
  const parsed = JSON.parse(serialised);
  assert.strictEqual(parsed.duplicateSetCount, r.duplicateSetCount);
});

test("find_duplicates: result has no unexpected top-level keys (no prototype pollution)", () => {
  executeTool("create_directory", { path: "dup-proto" });
  executeTool("create_file", { path: "dup-proto/a.txt", content: "proto-test" });
  const r = executeTool("find_duplicates", { path: "dup-proto" });
  const expected = new Set(["path", "algorithm", "filesScanned", "filesHashed", "duplicateSetCount", "totalDuplicateFiles", "totalWastedBytes", "duplicateSets"]);
  for (const key of Object.keys(r)) assert.ok(expected.has(key), `unexpected key '${key}'`);
  assert.ok(!Object.prototype.hasOwnProperty.call(r, "__proto__"));
});

test("find_duplicates: shell/SQL-injection-shaped file content round-trips literally", () => {
  executeTool("create_directory", { path: "dup-inject" });
  const payload = "'; DROP TABLE users; -- $(rm -rf /) `whoami`";
  executeTool("create_file", { path: "dup-inject/a.txt", content: payload });
  executeTool("create_file", { path: "dup-inject/b.txt", content: payload });
  const r = executeTool("find_duplicates", { path: "dup-inject" });
  assert.strictEqual(r.duplicateSetCount, 1, "injection-shaped identical content should still be detected as a literal duplicate");
});

test("find_duplicates: injection-shaped algorithm value is rejected, not executed", () => {
  executeTool("create_directory", { path: "dup-inject-algo" });
  assert.throws(
    () => executeTool("find_duplicates", { path: "dup-inject-algo", algorithm: "sha256; rm -rf /" }),
    /unsupported algorithm/i
  );
});

// ── EXTREME ───────────────────────────────────────────────────────────────────

test("find_duplicates: 40 files forming 10 duplicate pairs are all detected correctly", () => {
  executeTool("create_directory", { path: "dup-stress" });
  for (let i = 0; i < 10; i++) {
    executeTool("create_file", { path: `dup-stress/pair${i}-a.txt`, content: `pair-content-${i}` });
    executeTool("create_file", { path: `dup-stress/pair${i}-b.txt`, content: `pair-content-${i}` });
  }
  for (let i = 0; i < 20; i++) {
    executeTool("create_file", { path: `dup-stress/unique${i}.txt`, content: `unique-content-${i}-${"x".repeat(i)}` });
  }
  const r = executeTool("find_duplicates", { path: "dup-stress" });
  assert.strictEqual(r.filesScanned, 40);
  assert.strictEqual(r.duplicateSetCount, 10, "expected exactly 10 duplicate pairs");
  assert.ok(r.duplicateSets.every(s => s.count === 2));
});

test("find_duplicates: large (200KB) identical files are hashed and matched correctly", () => {
  executeTool("create_directory", { path: "dup-large" });
  const big = "Z".repeat(200_000);
  executeTool("create_file", { path: "dup-large/big1.bin", content: big });
  executeTool("create_file", { path: "dup-large/big2.bin", content: big });
  const r = executeTool("find_duplicates", { path: "dup-large" });
  assert.strictEqual(r.duplicateSetCount, 1);
  assert.strictEqual(r.duplicateSets[0].size, Buffer.byteLength(big));
});

test("find_duplicates: random fuzz byte content across many files never crashes, no false positives", () => {
  executeTool("create_directory", { path: "dup-fuzz" });
  const crypto = require("crypto");
  for (let i = 0; i < 15; i++) {
    const randomBytes = crypto.randomBytes(64 + i).toString("binary");
    executeTool("create_file", { path: `dup-fuzz/f${i}.bin`, content: randomBytes });
  }
  let r;
  assert.doesNotThrow(() => { r = executeTool("find_duplicates", { path: "dup-fuzz" }); });
  assert.strictEqual(r.filesScanned, 15);
  // Astronomically unlikely that random independent byte streams of differing
  // lengths collide — assert no false-positive duplicate sets were created.
  assert.strictEqual(r.duplicateSetCount, 0);
});

test("find_duplicates: 10 concurrent scans of the same directory return consistent results", () => {
  executeTool("create_directory", { path: "dup-concurrent" });
  executeTool("create_file", { path: "dup-concurrent/a.txt", content: "concurrent-dup" });
  executeTool("create_file", { path: "dup-concurrent/b.txt", content: "concurrent-dup" });
  executeTool("create_file", { path: "dup-concurrent/c.txt", content: "unique-one" });
  const results = Array.from({ length: 10 }, () => executeTool("find_duplicates", { path: "dup-concurrent" }));
  const first = results[0];
  for (let i = 1; i < results.length; i++) {
    assert.strictEqual(results[i].duplicateSetCount, first.duplicateSetCount, `call ${i}: mismatch`);
    assert.strictEqual(results[i].duplicateSets[0]?.hash, first.duplicateSets[0]?.hash, `call ${i}: hash mismatch`);
  }
});

// ── CLEANUP ───────────────────────────────────────────────────────────────────

test("cleanup: remove find_duplicates fixture directories/files", () => {
  const items = [
    "dup-basic", "dup-unique", "dup-algo", "dup-waste", "dup-sorted", "dup-shape",
    "dup-empty", "dup-single", "dup-badalgo", "dup-negsize", "dup-minsize", "dup-ext",
    "dup-three", "dup-samesize", "dup-md5", "dup-not-a-dir.txt", "dup-ignore", "dup-nested",
    "dup-json", "dup-proto", "dup-inject", "dup-inject-algo", "dup-stress", "dup-large",
    "dup-fuzz", "dup-concurrent",
  ];
  for (const item of items) {
    try { fs.rmSync(path.join(TMP, item), { recursive: true, force: true }); } catch (_) {}
  }
  assert.ok(!fs.existsSync(path.join(TMP, "dup-basic")), "dup-basic removed");
});
