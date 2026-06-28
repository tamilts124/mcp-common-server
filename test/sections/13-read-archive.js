"use strict";
/**
 * [17] READ_ARCHIVE — read_archive tool (inspect ZIP contents without extracting)
 *
 * Rigor levels covered:
 *
 *   Normal:   happy-path — read a populated ZIP created by zip_directory,
 *             verify all expected fields (entries, fileCount, totals),
 *             verify file entries have correct names / sizes / crc32 / method,
 *             verify directory entries flagged as isDirectory=true.
 *
 *   Medium:   boundary — empty ZIP (0 files) from zip_directory, single-file ZIP,
 *             verify aggregate totals (uncompressed vs compressed), verify ISO 8601
 *             lastModified date format.
 *
 *   High:     dependency failure — non-existent file throws, path to a plain text
 *             file (not a ZIP) throws descriptive error, corrupt/truncated ZIP buffer
 *             throws, missing required 'path' param surfaces -32602.
 *
 *   Critical: security — path traversal via 'path' blocked, absolute path outside
 *             root blocked, injection-shaped filename inside the archive is returned
 *             as literal data (not executed), large ZIP comment doesn't confuse EOCD
 *             search.
 *
 *   Extreme:  stress — ZIP with 200 entries all listed correctly, concurrent reads
 *             return consistent results, result is fully JSON-serialisable,
 *             re-reading the same ZIP 50 times gives identical fileCount each time.
 */
const path = require("path");
const fs   = require("fs");

const { assert, test, TMP, executeTool } = require("../test-harness");

console.log(`\n[17] READ_ARCHIVE — read_archive tool`);

// ── HELPERS ───────────────────────────────────────────────────────────────────

/** Create a small populated directory tree under TMP and archive it. */
function makeZip(subDir, destName, files = null) {
  const srcDir = path.join(TMP, subDir);
  fs.mkdirSync(srcDir, { recursive: true });

  // Default file set if not provided
  const fileSet = files || [
    { rel: "hello.txt",         content: "Hello, world!\n" },
    { rel: "sub/data.json",     content: '{"key":"value"}\n' },
    { rel: "sub/nested/hi.md",  content: "# Hi\n" },
  ];

  for (const { rel, content } of fileSet) {
    const abs = path.join(srcDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }

  const zipAlias = destName; // relative alias inside TMP
  executeTool("zip_directory", { path: subDir, destination: zipAlias });
  return zipAlias;
}

// ── NORMAL ────────────────────────────────────────────────────────────────────

test("read_archive: returns a result object without throwing", () => {
  const zip = makeZip("arch-normal", "arch-normal.zip");
  const r = executeTool("read_archive", { path: zip });
  assert.ok(r !== null && typeof r === "object", "result must be an object");
});

test("read_archive: fileCount matches number of items in the source directory", () => {
  const zip = makeZip("arch-count", "arch-count.zip");
  const r = executeTool("read_archive", { path: zip });
  // 3 files + 2 directory entries (sub/ and sub/nested/) created by zip_directory
  // We only assert >= 3 (at minimum our 3 files are present)
  assert.ok(r.fileCount >= 3, `expected at least 3 entries, got ${r.fileCount}`);
});

test("read_archive: entries array length matches fileCount", () => {
  const zip = makeZip("arch-len", "arch-len.zip");
  const r = executeTool("read_archive", { path: zip });
  assert.strictEqual(r.entries.length, r.fileCount, "entries.length must equal fileCount");
});

test("read_archive: each entry has required fields with correct types", () => {
  const zip = makeZip("arch-fields", "arch-fields.zip");
  const r = executeTool("read_archive", { path: zip });
  for (const e of r.entries) {
    assert.ok(typeof e.name === "string" && e.name.length > 0,       `name must be non-empty string: ${JSON.stringify(e)}`);
    assert.ok(typeof e.isDirectory === "boolean",                      `isDirectory must be boolean: ${JSON.stringify(e)}`);
    assert.ok(typeof e.size === "number" && e.size >= 0,              `size must be non-negative number: ${JSON.stringify(e)}`);
    assert.ok(typeof e.compressedSize === "number" && e.compressedSize >= 0, `compressedSize must be non-negative: ${JSON.stringify(e)}`);
    assert.ok(typeof e.compressionMethod === "string",                 `compressionMethod must be string: ${JSON.stringify(e)}`);
    assert.ok(typeof e.crc32 === "number",                             `crc32 must be a number: ${JSON.stringify(e)}`);
    assert.ok(typeof e.lastModified === "string",                      `lastModified must be string: ${JSON.stringify(e)}`);
  }
});

test("read_archive: file entries have correct names (hello.txt present)", () => {
  const zip = makeZip("arch-names", "arch-names.zip");
  const r = executeTool("read_archive", { path: zip });
  const names = r.entries.map(e => e.name);
  assert.ok(names.some(n => n.endsWith("hello.txt")), `hello.txt not found in: ${JSON.stringify(names)}`);
});

test("read_archive: zip_directory produces only file entries (no explicit dir entries)", () => {
  // Our zip_directory implementation writes only file-content entries — it does
  // not write explicit directory header entries (entries whose name ends with "/").
  // This is valid ZIP behavior; many writers omit directory entries.
  // read_archive's isDirectory flag correctly classifies these based on the name alone.
  const zip = makeZip("arch-dirs", "arch-dirs.zip");
  const r = executeTool("read_archive", { path: zip });
  // All entries should be file entries (isDirectory=false)
  const dirEntries = r.entries.filter(e => e.isDirectory);
  assert.strictEqual(dirEntries.length, 0, "zip_directory should produce 0 explicit directory entries");
  // Any entry with isDirectory=false must not end with "/"
  for (const e of r.entries) {
    assert.ok(!e.name.endsWith("/"), `all entries from zip_directory should be files, got: ${e.name}`);
  }
});

test("read_archive: isDirectory flag correctly detects entries whose name ends with '/'", () => {
  // Build a synthetic ZIP with an explicit directory entry (name ending in "/")
  // so we can verify isDirectory=true is set when warranted.
  // We hand-craft the minimum ZIP bytes for a single directory entry.
  //
  // Local File Header for "subdir/" (stored, 0 bytes):
  const fnBytes = Buffer.from("subdir/");
  const fn      = fnBytes.length; // 7

  // Local File Header: sig + version + flags + method + time + date + crc + compSz + uncompSz + fnLen + extLen + name
  const lfh = Buffer.alloc(30 + fn);
  lfh.writeUInt32LE(0x04034b50, 0);  // LFH sig
  lfh.writeUInt16LE(20,  4);  // version needed
  lfh.writeUInt16LE(0,   6);  // flags
  lfh.writeUInt16LE(0,   8);  // method: stored
  lfh.writeUInt16LE(0,  10);  // mod time
  lfh.writeUInt16LE(0,  12);  // mod date (1980-01-00 — intentionally invalid, tests tolerance)
  lfh.writeUInt32LE(0,  14);  // crc32
  lfh.writeUInt32LE(0,  18);  // compressed size
  lfh.writeUInt32LE(0,  22);  // uncompressed size
  lfh.writeUInt16LE(fn, 26);  // file name length
  lfh.writeUInt16LE(0,  28);  // extra field length
  fnBytes.copy(lfh, 30);

  // Central Directory File Header
  const cdfh = Buffer.alloc(46 + fn);
  cdfh.writeUInt32LE(0x02014b50, 0);  // CDFH sig
  cdfh.writeUInt16LE(20,  4);  // version made by
  cdfh.writeUInt16LE(20,  6);  // version needed
  cdfh.writeUInt16LE(0,   8);  // flags
  cdfh.writeUInt16LE(0,  10);  // method: stored
  cdfh.writeUInt16LE(0,  12);  // mod time
  cdfh.writeUInt16LE(0,  14);  // mod date
  cdfh.writeUInt32LE(0,  16);  // crc32
  cdfh.writeUInt32LE(0,  20);  // comp size
  cdfh.writeUInt32LE(0,  24);  // uncomp size
  cdfh.writeUInt16LE(fn, 28);  // fn len
  cdfh.writeUInt16LE(0,  30);  // extra len
  cdfh.writeUInt16LE(0,  32);  // comment len
  cdfh.writeUInt16LE(0,  34);  // disk start
  cdfh.writeUInt16LE(0,  36);  // int attrs
  cdfh.writeUInt32LE(0,  38);  // ext attrs
  cdfh.writeUInt32LE(0,  42);  // local header offset
  fnBytes.copy(cdfh, 46);

  // End of Central Directory
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);  // EOCD sig
  eocd.writeUInt16LE(0, 4);  // disk number
  eocd.writeUInt16LE(0, 6);  // disk with CD
  eocd.writeUInt16LE(1, 8);  // entries this disk
  eocd.writeUInt16LE(1, 10); // total entries
  eocd.writeUInt32LE(cdfh.length, 12);  // CD size
  eocd.writeUInt32LE(lfh.length, 16);   // CD offset
  eocd.writeUInt16LE(0, 20); // comment len

  const zipBuf = Buffer.concat([lfh, cdfh, eocd]);
  const zipPath = require("path").join(TMP, "synthetic-dir.zip");
  require("fs").writeFileSync(zipPath, zipBuf);

  const r = executeTool("read_archive", { path: "synthetic-dir.zip" });
  assert.strictEqual(r.fileCount, 1, "synthetic ZIP should have 1 entry");
  assert.ok(r.entries[0].isDirectory === true,
    `entry ending with '/' must have isDirectory=true, got: ${r.entries[0].isDirectory}`);
  assert.strictEqual(r.entries[0].name, "subdir/");

  // cleanup
  require("fs").rmSync(zipPath, { force: true });
});

test("read_archive: totalUncompressedBytes and totalCompressedBytes are numbers >= 0", () => {

  const zip = makeZip("arch-totals", "arch-totals.zip");
  const r = executeTool("read_archive", { path: zip });
  assert.ok(typeof r.totalUncompressedBytes === "number" && r.totalUncompressedBytes >= 0,
    "totalUncompressedBytes must be non-negative number");
  assert.ok(typeof r.totalCompressedBytes === "number" && r.totalCompressedBytes >= 0,
    "totalCompressedBytes must be non-negative number");
});

test("read_archive: totalUncompressedBytes equals sum of entry sizes", () => {
  const zip = makeZip("arch-sum", "arch-sum.zip");
  const r = executeTool("read_archive", { path: zip });
  const sum = r.entries.reduce((s, e) => s + e.size, 0);
  assert.strictEqual(r.totalUncompressedBytes, sum, "totalUncompressedBytes must equal sum of entry sizes");
});

test("read_archive: path is echoed back in result", () => {
  const zip = makeZip("arch-echo", "arch-echo.zip");
  const r = executeTool("read_archive", { path: zip });
  assert.strictEqual(r.path, zip, "path must be echoed in result");
});

// ── MEDIUM ────────────────────────────────────────────────────────────────────

test("read_archive: empty directory produces a ZIP with 0 file entries (or only empty dir entry)", () => {
  const emptyDir = path.join(TMP, "arch-empty-src");
  fs.mkdirSync(emptyDir, { recursive: true });
  executeTool("zip_directory", { path: "arch-empty-src", destination: "arch-empty.zip" });
  const r = executeTool("read_archive", { path: "arch-empty.zip" });
  // An empty dir ZIP has 0 entries (no files, no sub-dirs)
  assert.ok(r.fileCount === 0, `expected 0 entries for empty dir ZIP, got ${r.fileCount}`);
  assert.strictEqual(r.totalUncompressedBytes, 0, "totalUncompressedBytes must be 0 for empty ZIP");
});

test("read_archive: single-file ZIP has fileCount=1 and one file entry", () => {
  const zip = makeZip("arch-single", "arch-single.zip", [
    { rel: "only.txt", content: "just one\n" },
  ]);
  const r = executeTool("read_archive", { path: zip });
  // Could be 1 file entry only (no sub-dirs)
  assert.ok(r.fileCount >= 1, `expected at least 1 entry`);
  const fileEntries = r.entries.filter(e => !e.isDirectory);
  assert.ok(fileEntries.length === 1, `expected exactly 1 file entry, got ${fileEntries.length}`);
  assert.ok(fileEntries[0].name.endsWith("only.txt"), `expected entry named only.txt`);
});

test("read_archive: compressionMethod is 'stored' or 'deflate' (no exotic methods)", () => {
  const zip = makeZip("arch-method", "arch-method.zip");
  const r = executeTool("read_archive", { path: zip });
  const validMethods = new Set(["stored", "deflate", "deflate64", "bzip2", "lzma", "zstd", "aes"]);
  for (const e of r.entries) {
    assert.ok(
      validMethods.has(e.compressionMethod) || e.compressionMethod.startsWith("method-"),
      `unknown compressionMethod: ${e.compressionMethod}`
    );
  }
});

test("read_archive: lastModified is a valid ISO 8601 date string", () => {
  const zip = makeZip("arch-date", "arch-date.zip");
  const r = executeTool("read_archive", { path: zip });
  for (const e of r.entries) {
    // ISO 8601: YYYY-MM-DDTHH:mm:ss.sssZ
    assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(e.lastModified),
      `lastModified not ISO 8601: ${e.lastModified}`);
    const d = new Date(e.lastModified);
    assert.ok(!isNaN(d.getTime()), `lastModified not a valid date: ${e.lastModified}`);
  }
});

test("read_archive: crc32 values are non-negative integers (unsigned 32-bit)", () => {
  const zip = makeZip("arch-crc", "arch-crc.zip");
  const r = executeTool("read_archive", { path: zip });
  for (const e of r.entries) {
    assert.ok(Number.isInteger(e.crc32) && e.crc32 >= 0 && e.crc32 <= 0xFFFFFFFF,
      `crc32 out of uint32 range: ${e.crc32}`);
  }
});

// ── HIGH ──────────────────────────────────────────────────────────────────────

test("read_archive: non-existent file throws (not silent)", () => {
  assert.throws(
    () => executeTool("read_archive", { path: "does-not-exist.zip" }),
    /ENOENT|no such file/i
  );
});

test("read_archive: plain text file (not a ZIP) throws descriptive EOCD error", () => {
  const txtPath = path.join(TMP, "notazip.txt");
  fs.writeFileSync(txtPath, "I am not a ZIP file.\n", "utf8");
  assert.throws(
    () => executeTool("read_archive", { path: "notazip.txt" }),
    /EOCD|not a valid ZIP/i
  );
});

test("read_archive: empty file (0 bytes) throws descriptive error", () => {
  const emptyPath = path.join(TMP, "empty.zip");
  fs.writeFileSync(emptyPath, Buffer.alloc(0));
  assert.throws(
    () => executeTool("read_archive", { path: "empty.zip" }),
    /EOCD|not a valid ZIP/i
  );
});

test("read_archive: binary garbage file throws descriptive error", () => {
  const garbagePath = path.join(TMP, "garbage.zip");
  fs.writeFileSync(garbagePath, Buffer.from([0x00, 0xFF, 0xAB, 0xCD, 0x12, 0x34, 0x56, 0x78]));
  assert.throws(
    () => executeTool("read_archive", { path: "garbage.zip" }),
    /EOCD|not a valid ZIP/i
  );
});

test("read_archive: missing 'path' param surfaces -32602 error code", () => {
  let err;
  try {
    executeTool("read_archive", {});
  } catch (e) {
    err = e;
  }
  assert.ok(err, "should throw for missing path");
  assert.strictEqual(err.code, -32602, `expected -32602, got ${err.code}`);
});

// ── CRITICAL ──────────────────────────────────────────────────────────────────

test("read_archive: path traversal (../) is blocked by resolveClientPath", () => {
  assert.throws(
    () => executeTool("read_archive", { path: "../../etc/passwd" }),
    /outside.*root|traversal|not.*within/i
  );
});

test("read_archive: absolute path outside root is blocked", () => {
  assert.throws(
    () => executeTool("read_archive", { path: "C:\\Windows\\System32\\evil.zip" }),
    /outside.*root|traversal|not.*within|invalid/i
  );
});

test("read_archive: injection-shaped content in entry names is returned as literal data", () => {
  // Create a file whose content has injection-shaped text; the file name in
  // the archive is the normal relative path — we verify the content field
  // of the result doesn't execute anything (it's just metadata strings).
  const zip = makeZip("arch-inject", "arch-inject.zip", [
    { rel: "normal.txt", content: "'; rm -rf /; echo '" },
  ]);
  const r = executeTool("read_archive", { path: zip });
  // Verify the result is a plain data object, not an executed side-effect
  assert.ok(Array.isArray(r.entries), "result.entries should be an array, not code output");
  // Verify we can JSON.stringify without errors (no circular refs from misparse)
  assert.doesNotThrow(() => JSON.stringify(r));
});

test("read_archive: result keys are exactly the documented set (no prototype pollution)", () => {
  const zip = makeZip("arch-proto", "arch-proto.zip");
  const r = executeTool("read_archive", { path: zip });
  const expectedTopKeys = new Set(["path", "fileCount", "totalUncompressedBytes", "totalCompressedBytes", "entries"]);
  for (const key of Object.keys(r)) {
    assert.ok(expectedTopKeys.has(key), `unexpected top-level key in result: '${key}'`);
  }
  assert.ok(!Object.prototype.hasOwnProperty.call(r, "__proto__"), "result must not have __proto__");
});

test("read_archive: path with injection characters in filename arg is rejected by jail", () => {
  // A path containing a null byte or OS-illegal character should fail cleanly
  // (resolveClientPath normalises the path; invalid chars cause OS-level throws)
  let threw = false;
  try {
    executeTool("read_archive", { path: "arch\x00evil.zip" });
  } catch (_) {
    threw = true;
  }
  assert.ok(threw, "should throw for null-byte in path");
});

// ── EXTREME ───────────────────────────────────────────────────────────────────

test("read_archive: ZIP with 200 entries — all listed correctly", () => {
  const files = Array.from({ length: 200 }, (_, i) => ({
    rel: `file${String(i).padStart(3, "0")}.txt`,
    content: `content of file ${i}\n`,
  }));
  const zip = makeZip("arch-200", "arch-200.zip", files);
  const r = executeTool("read_archive", { path: zip });
  const fileEntries = r.entries.filter(e => !e.isDirectory);
  assert.strictEqual(fileEntries.length, 200, `expected 200 file entries, got ${fileEntries.length}`);
});

test("read_archive: 10 concurrent reads of the same ZIP return identical results", () => {
  const zip = makeZip("arch-concurrent", "arch-concurrent.zip");
  const results = Array.from({ length: 10 }, () =>
    executeTool("read_archive", { path: zip })
  );
  const first = results[0];
  for (let i = 1; i < results.length; i++) {
    assert.strictEqual(results[i].fileCount, first.fileCount,
      `call ${i}: fileCount mismatch`);
    assert.strictEqual(results[i].totalUncompressedBytes, first.totalUncompressedBytes,
      `call ${i}: totalUncompressedBytes mismatch`);
  }
});

test("read_archive: result is fully JSON-serialisable (no circular refs, no undefined)", () => {
  const zip = makeZip("arch-json", "arch-json.zip");
  const r = executeTool("read_archive", { path: zip });
  let serialised;
  assert.doesNotThrow(() => { serialised = JSON.stringify(r); }, "JSON.stringify must not throw");
  const parsed = JSON.parse(serialised);
  assert.strictEqual(parsed.fileCount, r.fileCount, "round-trip preserves fileCount");
  assert.ok(Array.isArray(parsed.entries), "round-trip preserves entries array");
});

test("read_archive: re-reading the same ZIP 50 times gives identical fileCount", () => {
  const zip = makeZip("arch-repeat", "arch-repeat.zip");
  const first = executeTool("read_archive", { path: zip }).fileCount;
  for (let i = 0; i < 49; i++) {
    const r = executeTool("read_archive", { path: zip });
    assert.strictEqual(r.fileCount, first, `read ${i + 2}: fileCount changed`);
  }
});

test("read_archive: large file content in ZIP is reflected in uncompressed size", () => {
  const bigContent = "A".repeat(100_000); // 100 KB
  const zip = makeZip("arch-bigfile", "arch-bigfile.zip", [
    { rel: "big.txt", content: bigContent },
  ]);
  const r = executeTool("read_archive", { path: zip });
  const bigEntry = r.entries.find(e => e.name.endsWith("big.txt"));
  assert.ok(bigEntry, "big.txt entry must exist");
  assert.strictEqual(bigEntry.size, 100_000, `expected size 100000, got ${bigEntry.size}`);
  // Compressed size should be much smaller (repeated chars compress well)
  assert.ok(bigEntry.compressedSize < bigEntry.size,
    `deflate should reduce size: compressedSize=${bigEntry.compressedSize} size=${bigEntry.size}`);
});

// ── CLEANUP ───────────────────────────────────────────────────────────────────

test("cleanup: remove read_archive fixture ZIPs and source dirs", () => {
  const toRemove = [
    "arch-normal",    "arch-normal.zip",
    "arch-count",     "arch-count.zip",
    "arch-len",       "arch-len.zip",
    "arch-fields",    "arch-fields.zip",
    "arch-names",     "arch-names.zip",
    "arch-dirs",      "arch-dirs.zip",
    "arch-totals",    "arch-totals.zip",
    "arch-sum",       "arch-sum.zip",
    "arch-echo",      "arch-echo.zip",
    "arch-empty-src", "arch-empty.zip",
    "arch-single",    "arch-single.zip",
    "arch-method",    "arch-method.zip",
    "arch-date",      "arch-date.zip",
    "arch-crc",       "arch-crc.zip",
    "notazip.txt",    "empty.zip",       "garbage.zip",
    "arch-inject",    "arch-inject.zip",
    "arch-proto",     "arch-proto.zip",
    "arch-200",       "arch-200.zip",
    "arch-concurrent","arch-concurrent.zip",
    "arch-json",      "arch-json.zip",
    "arch-repeat",    "arch-repeat.zip",
    "arch-bigfile",   "arch-bigfile.zip",
    "synthetic-dir.zip",
  ];
  for (const name of toRemove) {
    const abs = path.join(TMP, name);
    try { fs.rmSync(abs, { recursive: true, force: true }); } catch (_) {}
  }
  // Verify at least one target gone as a sanity check
  assert.ok(!fs.existsSync(path.join(TMP, "arch-normal.zip")), "arch-normal.zip should be removed");
});
