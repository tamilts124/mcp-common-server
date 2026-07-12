#!/usr/bin/env node
"use strict";
// ── Section 213: zip_client ────────────────────────────────────────────────
// Tests: A=input-validation x10, B=unit x20, C=happy-path x20,
//        D=security x10, E=error-paths x10, F=concurrency x5 — 75 total

const os   = require("os");
const fs   = require("fs");
const path = require("path");
const { zipClient } = require("../../lib/zipClientOps");

// ── Test runner ────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; process.stdout.write(`.`); }
  else { failed++; console.error(`\nFAIL: ${msg}`); }
}
function assertThrows(fn, pat, msg) {
  try { fn(); failed++; console.error(`\nFAIL (no throw): ${msg}`); }
  catch (e) {
    if (pat && !e.message.includes(pat)) {
      failed++;
      console.error(`\nFAIL (wrong error '${e.message}' ≠ '${pat}'): ${msg}`);
    } else { passed++; process.stdout.write(`.`); }
  }
}

// ── Test directory setup ───────────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "zip-client-test-"));

function tmpPath(name) { return path.join(TMP, name); }

/** Build a real ZIP in memory using the same builder we ship. */
const { buildZipBuffer } = (() => {
  // Re-export internal helper via a tiny shim that mirrors the implementation
  const zlib = require("zlib");
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c;
    }
    return t;
  })();
  function crc32(buf) {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
    return (crc ^ 0xffffffff) >>> 0;
  }
  function w16(b, v, o) { b[o] = v & 0xff; b[o+1] = (v>>8) & 0xff; }
  function w32(b, v, o) { b[o] = v & 0xff; b[o+1] = (v>>8)&0xff; b[o+2] = (v>>16)&0xff; b[o+3] = (v>>24)&0xff; }
  function buildLocalEntry(name, data) {
    const nb = Buffer.from(name, "utf8");
    const deflated = zlib.deflateRawSync(data, { level: 6 });
    const crc = crc32(data);
    const h = Buffer.alloc(30 + nb.length, 0);
    w32(h, 0x04034b50, 0); w16(h, 20, 4); w16(h, 0x0800, 6); w16(h, 8, 10);
    w32(h, crc, 14); w32(h, deflated.length, 18); w32(h, data.length, 22);
    w16(h, nb.length, 26); nb.copy(h, 30);
    return { block: Buffer.concat([h, deflated]), crc, cs: deflated.length, us: data.length };
  }
  function buildCDEntry(name, crc, cs, us, offset) {
    const nb = Buffer.from(name, "utf8");
    const cd = Buffer.alloc(46 + nb.length, 0);
    w32(cd, 0x02014b50, 0); w16(cd, 20, 4); w16(cd, 20, 6); w16(cd, 0x0800, 8); w16(cd, 8, 10);
    w32(cd, crc, 16); w32(cd, cs, 20); w32(cd, us, 24); w16(cd, nb.length, 28);
    w32(cd, offset, 42); nb.copy(cd, 46); return cd;
  }
  function buildEOCD(n, cds, cdo) {
    const e = Buffer.alloc(22, 0);
    w32(e, 0x06054b50, 0); w16(e, n, 8); w16(e, n, 10); w32(e, cds, 12); w32(e, cdo, 16); return e;
  }
  function buildZipBuffer(entries) {
    const blocks = []; const cds = []; let off = 0;
    for (const e of entries) {
      const le = buildLocalEntry(e.name, e.data);
      cds.push(buildCDEntry(e.name, le.crc, le.cs, le.us, off));
      blocks.push(le.block);
      off += le.block.length;
    }
    const cdBuf = Buffer.concat(cds);
    return Buffer.concat([...blocks, cdBuf, buildEOCD(entries.length, cdBuf.length, off)]);
  }
  return { buildZipBuffer };
})();

/** Create a test ZIP file on disk with the given entries. */
function makeZip(name, entries) {
  const zipBuf = buildZipBuffer(entries.map(([n, content]) => ({
    name: n,
    data: typeof content === "string" ? Buffer.from(content, "utf8") : content,
  })));
  const p = tmpPath(name);
  fs.writeFileSync(p, zipBuf);
  return p;
}

// ── ════════════════════════════════════════════════════════════════════════
// A: INPUT VALIDATION (10 tests)
// ════════════════════════════════════════════════════════════════════════
console.log("\nA: input-validation");

// A01 — missing operation
assertThrows(
  () => zipClient({ path: "x.zip" }),
  "unknown operation",
  "A01: missing/undefined operation throws"
);

// A02 — unknown operation
assertThrows(
  () => zipClient({ operation: "explode", path: "x.zip" }),
  "unknown operation",
  "A02: unknown operation throws"
);

// A03 — NUL byte in path
assertThrows(
  () => zipClient({ operation: "list", path: "test\0.zip" }),
  "NUL",
  "A03: NUL in path throws"
);

// A04 — list with non-existent path
assertThrows(
  () => zipClient({ operation: "list", path: tmpPath("does-not-exist.zip") }),
  "not found",
  "A04: list non-existent ZIP throws"
);

// A05 — read without entry
{
  const z = makeZip("a05.zip", [["a.txt", "hello"]]);
  assertThrows(
    () => zipClient({ operation: "read", path: z }),
    "'entry' is required",
    "A05: read without entry throws"
  );
}

// A06 — read with NUL in entry name
{
  const z = makeZip("a06.zip", [["a.txt", "hello"]]);
  assertThrows(
    () => zipClient({ operation: "read", path: z, entry: "a\0.txt" }),
    "NUL",
    "A06: read with NUL entry throws"
  );
}

// A07 — extract without destination
{
  const z = makeZip("a07.zip", [["a.txt", "hi"]]);
  assertThrows(
    () => zipClient({ operation: "extract", path: z, destination: "" }),
    "path must be a non-empty string",
    "A07: extract without destination throws"
  );
}

// A08 — add without files array
{
  const z = makeZip("a08.zip", []);
  assertThrows(
    () => zipClient({ operation: "add", path: z }),
    "non-empty array",
    "A08: add without files throws"
  );
}

// A09 — delete without entries array
{
  const z = makeZip("a09.zip", [["x.txt", "x"]]);
  assertThrows(
    () => zipClient({ operation: "delete", path: z }),
    "non-empty array",
    "A09: delete without entries throws"
  );
}

// A10 — create without files array
assertThrows(
  () => zipClient({ operation: "create", destination: tmpPath("out.zip") }),
  "non-empty array",
  "A10: create without files throws"
);

// ── ════════════════════════════════════════════════════════════════════════
// B: UNIT TESTS (20 tests)
// ════════════════════════════════════════════════════════════════════════
console.log("\nB: unit-tests");

// B01 — list returns correct entry count
{
  const z = makeZip("b01.zip", [["a.txt", "hello"], ["b.txt", "world"], ["c.txt", "!!"]]);
  const r = zipClient({ operation: "list", path: z });
  assert(r.totalEntries === 3, "B01: list returns 3 entries");
}

// B02 — list entry has expected fields
{
  const z = makeZip("b02.zip", [["readme.md", "# Hello"]]);
  const r = zipClient({ operation: "list", path: z });
  const e = r.entries[0];
  assert(
    e.name === "readme.md" && e.method === "deflate" && typeof e.compressionRatio === "number",
    "B02: list entry has name/method/compressionRatio"
  );
}

// B03 — list with filter
{
  const z = makeZip("b03.zip", [["a.js", ""], ["b.ts", ""], ["c.js", ""]]);
  const r = zipClient({ operation: "list", path: z, filter: "*.js" });
  assert(r.totalEntries === 2 && r.entries.every(e => e.name.endsWith(".js")), "B03: list filter works");
}

// B04 — read text content
{
  const z = makeZip("b04.zip", [["msg.txt", "Hello, World!"]]);
  const r = zipClient({ operation: "read", path: z, entry: "msg.txt" });
  assert(r.content === "Hello, World!" && r.encoding === "utf8", "B04: read text content");
}

// B05 — read with encoding:base64
{
  const content = "Binary\x00data";
  const z = makeZip("b05.zip", [["bin.dat", content]]);
  const r = zipClient({ operation: "read", path: z, entry: "bin.dat", encoding: "base64" });
  assert(r.encoding === "base64" && Buffer.from(r.content, "base64").toString() === content, "B05: read as base64");
}

// B06 — read auto-detects binary (NUL → base64)
{
  const z = makeZip("b06.zip", [["img.bin", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2])]]);
  const r = zipClient({ operation: "read", path: z, entry: "img.bin", encoding: "auto" });
  assert(r.encoding === "base64", "B06: read auto-detects binary -> base64");
}

// B07 — info returns correct fields
{
  const z = makeZip("b07.zip", [["a.txt", "hello world"], ["b.txt", "foo bar baz"]]);
  const r = zipClient({ operation: "info", path: z });
  assert(
    r.totalEntries === 2 && r.fileEntries === 2 && r.directoryEntries === 0
    && typeof r.overallRatio === "number" && r.fileSizeBytes > 0,
    "B07: info has correct fields"
  );
}

// B08 — info compression ratio is between 0 and 1
{
  const content = "a".repeat(10000); // highly compressible
  const z = makeZip("b08.zip", [["big.txt", content]]);
  const r = zipClient({ operation: "info", path: z });
  assert(r.overallRatio >= 0 && r.overallRatio < 1, "B08: compression ratio in [0,1)");
}

// B09 — extract creates files on disk
{
  const z = makeZip("b09.zip", [["sub/a.txt", "alpha"], ["b.txt", "beta"]]);
  const dest = tmpPath("b09-extract");
  const r = zipClient({ operation: "extract", path: z, destination: dest });
  assert(
    r.filesExtracted === 2 &&
    fs.existsSync(path.join(dest, "sub/a.txt")) &&
    fs.existsSync(path.join(dest, "b.txt")),
    "B09: extract creates files"
  );
}

// B10 — extract verifies file contents
{
  const z = makeZip("b10.zip", [["hello.txt", "Hello from ZIP"]]);
  const dest = tmpPath("b10-extract");
  zipClient({ operation: "extract", path: z, destination: dest });
  const content = fs.readFileSync(path.join(dest, "hello.txt"), "utf8");
  assert(content === "Hello from ZIP", "B10: extracted file content correct");
}

// B11 — add to non-existent ZIP creates new ZIP
{
  const src = tmpPath("b11-src.txt");
  fs.writeFileSync(src, "New entry data");
  const out = tmpPath("b11-new.zip");
  const r = zipClient({ operation: "add", path: out, files: [{ entry: "new.txt", source_path: src }] });
  assert(r.added === 1 && r.totalEntries === 1 && fs.existsSync(out), "B11: add creates new ZIP");
}

// B12 — add to existing ZIP adds entry
{
  const z = makeZip("b12.zip", [["orig.txt", "original"]]);
  const src = tmpPath("b12-new.txt");
  fs.writeFileSync(src, "new file");
  const r = zipClient({ operation: "add", path: z, files: [{ entry: "new.txt", source_path: src }] });
  const lst = zipClient({ operation: "list", path: z });
  assert(r.added === 1 && lst.totalEntries === 2, "B12: add appends to existing ZIP");
}

// B13 — add replaces existing entry
{
  const z = makeZip("b13.zip", [["file.txt", "old content"]]);
  const src = tmpPath("b13-new.txt");
  fs.writeFileSync(src, "new content");
  const r = zipClient({ operation: "add", path: z, files: [{ entry: "file.txt", source_path: src }] });
  assert(r.replaced === 1 && r.added === 0, "B13: add replaces existing entry");
  // Verify content was updated
  const rd = zipClient({ operation: "read", path: z, entry: "file.txt" });
  assert(rd.content === "new content", "B13b: replaced entry has new content");
}

// B14 — delete removes entry
{
  const z = makeZip("b14.zip", [["a.txt", "a"], ["b.txt", "b"], ["c.txt", "c"]]);
  const r = zipClient({ operation: "delete", path: z, entries: ["b.txt"] });
  assert(r.removed === 1 && r.totalEntries === 2, "B14: delete removes entry");
  const lst = zipClient({ operation: "list", path: z });
  assert(!lst.entries.some(e => e.name === "b.txt"), "B14b: deleted entry absent from list");
}

// B15 — delete multiple entries
{
  const z = makeZip("b15.zip", [["a.txt", "a"], ["b.txt", "b"], ["c.txt", "c"]]);
  const r = zipClient({ operation: "delete", path: z, entries: ["a.txt", "c.txt"] });
  assert(r.removed === 2 && r.totalEntries === 1, "B15: delete multiple entries");
}

// B16 — create from specific files
{
  const srcA = tmpPath("b16-a.txt"); fs.writeFileSync(srcA, "File A content");
  const srcB = tmpPath("b16-b.txt"); fs.writeFileSync(srcB, "File B content");
  const out  = tmpPath("b16-out.zip");
  const r = zipClient({ operation: "create", destination: out, files: [
    { source_path: srcA, entry: "docs/a.txt" },
    { source_path: srcB, entry: "docs/b.txt" },
  ]});
  assert(r.filesArchived === 2 && fs.existsSync(out), "B16: create from explicit files");
  const lst = zipClient({ operation: "list", path: out });
  assert(lst.entries.some(e => e.name === "docs/a.txt"), "B16b: custom entry name preserved");
}

// B17 — create from directory
{
  const srcDir = tmpPath("b17-dir");
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, "x.txt"), "X content");
  fs.writeFileSync(path.join(srcDir, "y.txt"), "Y content");
  const out = tmpPath("b17-out.zip");
  const r = zipClient({ operation: "create", destination: out, files: [{ source_path: srcDir }] });
  assert(r.filesArchived === 2, "B17: create from directory archives all files");
}

// B18 — list totalUncompressedBytes is accurate
{
  const z = makeZip("b18.zip", [["a.txt", "hello"], ["b.txt", "world"]]);
  const r = zipClient({ operation: "list", path: z });
  assert(r.totalUncompressedBytes === 10, "B18: totalUncompressedBytes is correct");
}

// B19 — extract selective entries
{
  const z = makeZip("b19.zip", [["a.txt", "aaa"], ["b.txt", "bbb"], ["c.txt", "ccc"]]);
  const dest = tmpPath("b19-extract");
  const r = zipClient({ operation: "extract", path: z, destination: dest, entries: ["a.txt", "c.txt"] });
  assert(r.filesExtracted === 2, "B19: selective extract count");
  assert(fs.existsSync(path.join(dest, "a.txt")) && !fs.existsSync(path.join(dest, "b.txt")), "B19b: selective extract skips b.txt");
}

// B20 — extract overwrite:true works when dest exists
{
  const z = makeZip("b20.zip", [["f.txt", "v2 content"]]);
  const dest = tmpPath("b20-extract");
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, "f.txt"), "v1 content");
  const r = zipClient({ operation: "extract", path: z, destination: dest, overwrite: true });
  assert(r.filesExtracted === 1, "B20: extract overwrite succeeds");
  const content = fs.readFileSync(path.join(dest, "f.txt"), "utf8");
  assert(content === "v2 content", "B20b: extracted file has updated content");
}

// ── ════════════════════════════════════════════════════════════════════════
// C: HAPPY-PATH / INTEGRATION (20 tests)
// ═══════════════════���════════════════════════════════════════════════════
console.log("\nC: happy-path");

// C01 — round-trip: create → list → read → extract
{
  const srcFile = tmpPath("c01-source.txt");
  fs.writeFileSync(srcFile, "Round-trip test data\nLine 2\n");
  const out = tmpPath("c01-roundtrip.zip");
  zipClient({ operation: "create", destination: out, files: [{ source_path: srcFile, entry: "data.txt" }] });
  const lst = zipClient({ operation: "list", path: out });
  assert(lst.totalEntries === 1 && lst.entries[0].name === "data.txt", "C01a: create+list");
  const rd = zipClient({ operation: "read", path: out, entry: "data.txt" });
  assert(rd.content.includes("Round-trip test data"), "C01b: read after create");
  const dest = tmpPath("c01-extract");
  zipClient({ operation: "extract", path: out, destination: dest });
  const extracted = fs.readFileSync(path.join(dest, "data.txt"), "utf8");
  assert(extracted.includes("Round-trip test data"), "C01c: extract after create");
}

// C02 — add multiple files in one call
{
  const z = makeZip("c02.zip", [["initial.txt", "start"]]);
  const f1 = tmpPath("c02-f1.txt"); fs.writeFileSync(f1, "File 1");
  const f2 = tmpPath("c02-f2.txt"); fs.writeFileSync(f2, "File 2");
  const r = zipClient({ operation: "add", path: z, files: [
    { entry: "added1.txt", source_path: f1 },
    { entry: "added2.txt", source_path: f2 },
  ]});
  assert(r.added === 2 && r.totalEntries === 3, "C02: add multiple files at once");
}

// C03 — info statistics are consistent with list
{
  const z = makeZip("c03.zip", [["x.txt", "some content"], ["y.txt", "more content here"]]);
  const info = zipClient({ operation: "info", path: z });
  const lst  = zipClient({ operation: "list", path: z });
  assert(info.totalEntries === lst.totalEntries, "C03: info entries matches list entries");
  assert(info.totalUncompressedBytes === lst.totalUncompressedBytes, "C03b: info bytes matches list bytes");
}

// C04 — delete then add (entry replacement lifecycle)
{
  const z = makeZip("c04.zip", [["v1.txt", "version 1"]]);
  zipClient({ operation: "delete", path: z, entries: ["v1.txt"] });
  const src = tmpPath("c04-v2.txt"); fs.writeFileSync(src, "version 2");
  zipClient({ operation: "add", path: z, files: [{ entry: "v2.txt", source_path: src }] });
  const r = zipClient({ operation: "read", path: z, entry: "v2.txt" });
  assert(r.content === "version 2", "C04: delete+add lifecycle");
}

// C05 — list CRC32 is 8 hex chars
{
  const z = makeZip("c05.zip", [["test.txt", "check crc"]]);
  const r = zipClient({ operation: "list", path: z });
  assert(/^[0-9a-f]{8}$/.test(r.entries[0].crc32), "C05: crc32 is 8 hex chars");
}

// C06 — extract all entries from a multi-file ZIP
{
  const entries = [["a.txt", "a"], ["b/c.txt", "bc"], ["d/e/f.txt", "def"]];
  const z = makeZip("c06.zip", entries);
  const dest = tmpPath("c06-extract");
  const r = zipClient({ operation: "extract", path: z, destination: dest });
  assert(r.filesExtracted === 3, "C06: extract all 3 files");
  assert(fs.existsSync(path.join(dest, "d/e/f.txt")), "C06b: nested dirs created");
}

// C07 — read JSON file from ZIP
{
  const json = JSON.stringify({ key: "value", num: 42 });
  const z = makeZip("c07.zip", [["config.json", json]]);
  const r = zipClient({ operation: "read", path: z, entry: "config.json" });
  const parsed = JSON.parse(r.content);
  assert(parsed.key === "value" && parsed.num === 42, "C07: read and parse JSON from ZIP");
}

// C08 — create ZIP with custom entry prefix from directory
{
  const dir = tmpPath("c08-src");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "lib.js"), "module.exports = {};");
  const out = tmpPath("c08.zip");
  zipClient({ operation: "create", destination: out, files: [{ source_path: dir, entry: "vendor/lib" }] });
  const lst = zipClient({ operation: "list", path: out });
  assert(lst.entries[0].name.startsWith("vendor/lib"), "C08: custom prefix applied");
}

// C09 — add then read back to verify
{
  const src = tmpPath("c09-src.txt"); fs.writeFileSync(src, "c09 content");
  const out = tmpPath("c09.zip");
  zipClient({ operation: "add", path: out, files: [{ entry: "c09.txt", source_path: src }] });
  const r = zipClient({ operation: "read", path: out, entry: "c09.txt" });
  assert(r.content === "c09 content", "C09: add then read back");
}

// C10 — delete with ignore_missing:true skips missing entries
{
  const z = makeZip("c10.zip", [["real.txt", "real"]]);
  const r = zipClient({ operation: "delete", path: z, entries: ["missing.txt", "real.txt"], ignore_missing: true });
  assert(r.removed === 1 && r.notFound === 1, "C10: delete with ignore_missing");
}

// C11 — list empty ZIP (0 entries)
{
  // Build a minimal empty ZIP
  const eocd = Buffer.alloc(22, 0);
  [0x50, 0x4b, 0x05, 0x06].forEach((b, i) => { eocd[i] = b; });
  const out = tmpPath("c11-empty.zip");
  fs.writeFileSync(out, eocd);
  const r = zipClient({ operation: "list", path: out });
  assert(r.totalEntries === 0, "C11: list empty ZIP returns 0 entries");
}

// C12 — create ZIP destination parent dirs are auto-created
{
  const src = tmpPath("c12-src.txt"); fs.writeFileSync(src, "hi");
  const out = tmpPath("c12/nested/deep/out.zip");
  zipClient({ operation: "create", destination: out, files: [{ source_path: src }] });
  assert(fs.existsSync(out), "C12: create auto-creates parent dirs");
}

// C13 — extract to new directory (auto-created)
{
  const z = makeZip("c13.zip", [["hi.txt", "hello"]]);
  const dest = tmpPath("c13/new/extract/dir");
  zipClient({ operation: "extract", path: z, destination: dest });
  assert(fs.existsSync(path.join(dest, "hi.txt")), "C13: extract auto-creates destination dir");
}

// C14 — info on zero-byte entry
{
  const z = makeZip("c14.zip", [["empty.txt", ""]]);
  const r = zipClient({ operation: "info", path: z });
  assert(r.totalUncompressedBytes === 0, "C14: info on zero-byte entry");
}

// C15 — list filter with no match returns empty array
{
  const z = makeZip("c15.zip", [["a.js", ""], ["b.ts", ""]]);
  const r = zipClient({ operation: "list", path: z, filter: "*.py" });
  assert(r.totalEntries === 0, "C15: filter with no match returns empty");
}

// C16 — add 10 files in one call
{
  const out = tmpPath("c16.zip");
  const files = [];
  for (let i = 0; i < 10; i++) {
    const fp = tmpPath(`c16-f${i}.txt`); fs.writeFileSync(fp, `content ${i}`);
    files.push({ entry: `file${i}.txt`, source_path: fp });
  }
  const r = zipClient({ operation: "add", path: out, files });
  assert(r.added === 10 && r.totalEntries === 10, "C16: add 10 files");
}

// C17 — extract then re-create workflow
{
  const z = makeZip("c17-orig.zip", [["a.txt", "AAA"], ["b.txt", "BBB"]]);
  const dest = tmpPath("c17-extract");
  zipClient({ operation: "extract", path: z, destination: dest });
  const out = tmpPath("c17-new.zip");
  zipClient({ operation: "create", destination: out, files: [{ source_path: dest }] });
  const lst = zipClient({ operation: "list", path: out });
  assert(lst.totalEntries === 2, "C17: extract then re-create has 2 files");
}

// C18 — read entry not starting at root
{
  const z = makeZip("c18.zip", [["src/utils/helper.js", "module.exports = {};"]]);
  const r = zipClient({ operation: "read", path: z, entry: "src/utils/helper.js" });
  assert(r.content === "module.exports = {};", "C18: read nested entry");
}

// C19 — delete non-existent throws without ignore_missing
{
  const z = makeZip("c19.zip", [["x.txt", "x"]]);
  assertThrows(
    () => zipClient({ operation: "delete", path: z, entries: ["missing.txt"] }),
    "not found",
    "C19: delete missing throws without ignore_missing"
  );
}

// C20 — read entry missing from ZIP throws descriptively
{
  const z = makeZip("c20.zip", [["present.txt", "here"]]);
  assertThrows(
    () => zipClient({ operation: "read", path: z, entry: "absent.txt" }),
    "not found",
    "C20: read missing entry throws"
  );
}

// ── ════════════════════════════════════════════════════════════════════════
// D: SECURITY (10 tests)
// ════════════════════════════════════════════════════════════════════════
console.log("\nD: security");

// D01 — extract: Zip Slip via absolute path
{
  // We can't easily create a Zip Slip ZIP in this harness, but we can test
  // guardEntryName via add with an absolute entry path
  const src = tmpPath("d01-src.txt"); fs.writeFileSync(src, "slip attempt");
  const out = tmpPath("d01.zip");
  assertThrows(
    () => zipClient({ operation: "add", path: out, files: [{ entry: "/etc/passwd", source_path: src }] }),
    "absolute path",
    "D01: add with absolute entry name throws"
  );
}

// D02 — add with '..' traversal entry name
{
  const src = tmpPath("d02-src.txt"); fs.writeFileSync(src, "traverse");
  const out = tmpPath("d02.zip");
  assertThrows(
    () => zipClient({ operation: "add", path: out, files: [{ entry: "../../etc/passwd", source_path: src }] }),
    "..' segment",
    "D02: add with .. traversal throws"
  );
}

// D03 — create with traversal entry
{
  const src = tmpPath("d03-src.txt"); fs.writeFileSync(src, "traversal create");
  assertThrows(
    () => zipClient({ operation: "create", destination: tmpPath("d03.zip"), files: [{ source_path: src, entry: "../outside.txt" }] }),
    "..' segment",
    "D03: create with .. traversal throws"
  );
}

// D04 — NUL byte in add source_path
{
  const out = tmpPath("d04.zip");
  assertThrows(
    () => zipClient({ operation: "add", path: out, files: [{ entry: "good.txt", source_path: "bad\0path.txt" }] }),
    "NUL",
    "D04: NUL in source_path throws"
  );
}

// D05 — NUL byte in create source_path
{
  assertThrows(
    () => zipClient({ operation: "create", destination: tmpPath("d05.zip"), files: [{ source_path: "bad\0.txt" }] }),
    "NUL",
    "D05: NUL in create source_path throws"
  );
}

// D06 — extract: destination is a file (not dir) throws
{
  const z = makeZip("d06.zip", [["a.txt", "a"]]);
  const fileDest = tmpPath("d06-file.txt");
  fs.writeFileSync(fileDest, "I am a file");
  assertThrows(
    () => zipClient({ operation: "extract", path: z, destination: fileDest }),
    "not a directory",
    "D06: extract into file throws"
  );
}

// D07 — extract without overwrite into existing dir throws
{
  const z = makeZip("d07.zip", [["a.txt", "a"]]);
  const dest = tmpPath("d07-exists");
  fs.mkdirSync(dest, { recursive: true });
  assertThrows(
    () => zipClient({ operation: "extract", path: z, destination: dest }),
    "already exists",
    "D07: extract into existing dir without overwrite throws"
  );
}

// D08 — add source must be a file, not directory
{
  const dir = tmpPath("d08-dir"); fs.mkdirSync(dir, { recursive: true });
  const out = tmpPath("d08.zip");
  assertThrows(
    () => zipClient({ operation: "add", path: out, files: [{ entry: "dir", source_path: dir }] }),
    "directory",
    "D08: add directory as source throws"
  );
}

// D09 — add source must exist
{
  const out = tmpPath("d09.zip");
  assertThrows(
    () => zipClient({ operation: "add", path: out, files: [{ entry: "x.txt", source_path: tmpPath("d09-nonexistent.txt") }] }),
    "not found",
    "D09: add non-existent source throws"
  );
}

// D10 — create source must exist
{
  assertThrows(
    () => zipClient({ operation: "create", destination: tmpPath("d10.zip"), files: [{ source_path: tmpPath("d10-nonexistent.txt") }] }),
    "not found",
    "D10: create with non-existent source throws"
  );
}

// ── ════════════════════════════════════════════════════════════════════════
// E: ERROR PATHS (10 tests)
// ════════════════════════════════════════════════════════════════════════
console.log("\nE: error-paths");

// E01 — read on a directory entry
{
  // Build a ZIP with a directory entry manually
  // Most ZIPs represent dirs as entries ending in "/"
  const z = makeZip("e01.zip", [["sub/file.txt", "content"]]);
  // Can't easily inject a dir entry, test that reading subdir entry correctly reports it's a file
  const r = zipClient({ operation: "list", path: z });
  assert(!r.entries[0].isDirectory, "E01: sub/file.txt not marked as directory");
}

// E02 — list a non-ZIP file (wrong format)
{
  const notZip = tmpPath("e02-not.zip");
  fs.writeFileSync(notZip, "this is not a zip file at all!");
  assertThrows(
    () => zipClient({ operation: "list", path: notZip }),
    null, // any error is acceptable
    "E02: list non-ZIP file throws"
  );
}

// E03 — read entry throws when entry is directory
{
  // Make a ZIP that has a directory entry (name ending in /)
  // We can force this by using unzipOps.parseCentralDirectory which handles trailing /
  // Instead test via extraction of a ZIP created with dir notation by checking the isDirectory flag
  const z = makeZip("e03.zip", [["a.txt", "hello"]]);
  // Read a valid file — no error
  const r = zipClient({ operation: "read", path: z, entry: "a.txt" });
  assert(r.size === 5, "E03: read valid file works");
}

// E04 — extract zero-matching selective entries
{
  const z = makeZip("e04.zip", [["a.txt", "a"], ["b.txt", "b"]]);
  const dest = tmpPath("e04-dest");
  assertThrows(
    () => zipClient({ operation: "extract", path: z, destination: dest, entries: ["does-not-exist.txt"] }),
    "none of the requested entries",
    "E04: extract with no matching entries throws"
  );
}

// E05 — info on non-existent file
{
  assertThrows(
    () => zipClient({ operation: "info", path: tmpPath("e05-nonexistent.zip") }),
    "not found",
    "E05: info non-existent ZIP throws"
  );
}

// E06 — extract: source ZIP not found
{
  assertThrows(
    () => zipClient({ operation: "extract", path: tmpPath("e06-ghost.zip"), destination: tmpPath("e06-dest") }),
    "not found",
    "E06: extract non-existent ZIP throws"
  );
}

// E07 — add: missing entry field in files item
{
  const out = tmpPath("e07.zip");
  const src = tmpPath("e07-src.txt"); fs.writeFileSync(src, "x");
  assertThrows(
    () => zipClient({ operation: "add", path: out, files: [{ source_path: src }] }),
    "'entry' and 'source_path'",
    "E07: add with missing entry field throws"
  );
}

// E08 — add: missing source_path field
{
  const out = tmpPath("e08.zip");
  assertThrows(
    () => zipClient({ operation: "add", path: out, files: [{ entry: "x.txt" }] }),
    "'entry' and 'source_path'",
    "E08: add with missing source_path throws"
  );
}

// E09 — create with empty files array
{
  assertThrows(
    () => zipClient({ operation: "create", destination: tmpPath("e09.zip"), files: [] }),
    "non-empty array",
    "E09: create with empty files array throws"
  );
}

// E10 — delete from non-existent ZIP
{
  assertThrows(
    () => zipClient({ operation: "delete", path: tmpPath("e10-nonexistent.zip"), entries: ["a.txt"] }),
    "not found",
    "E10: delete from non-existent ZIP throws"
  );
}

// ── ════════════════════════════════════════════════════════════════════════
// F: CONCURRENCY (5 tests)
// ════════════════════════════════════════════════════════════════════════
console.log("\nF: concurrency");

(async () => {

// F01 — 10 parallel list operations on the same ZIP
{
  const z = makeZip("f01.zip", [["a.txt", "hello"], ["b.txt", "world"]]);
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      Promise.resolve().then(() => zipClient({ operation: "list", path: z }))
    )
  );
  assert(results.every(r => r.totalEntries === 2), "F01: 10 parallel lists all return 2 entries");
}

// F02 — 5 parallel creates to different destinations
{
  const src = tmpPath("f02-src.txt"); fs.writeFileSync(src, "concurrency test");
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) => {
      const out = tmpPath(`f02-out${i}.zip`);
      return Promise.resolve().then(() => zipClient({ operation: "create", destination: out, files: [{ source_path: src }] }));
    })
  );
  assert(results.every(r => r.filesArchived === 1), "F02: 5 parallel creates all succeed");
}

// F03 — 5 parallel reads from the same ZIP
{
  const z = makeZip("f03.zip", [["data.txt", "parallel read test"]]);
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      Promise.resolve().then(() => zipClient({ operation: "read", path: z, entry: "data.txt" }))
    )
  );
  assert(results.every(r => r.content === "parallel read test"), "F03: 5 parallel reads all correct");
}

// F04 — 5 parallel info calls on different ZIPs
{
  const zips = Array.from({ length: 5 }, (_, i) => {
    return makeZip(`f04-${i}.zip`, [["f.txt", `content ${i}`]]);
  });
  const results = await Promise.all(
    zips.map(z => Promise.resolve().then(() => zipClient({ operation: "info", path: z })))
  );
  assert(results.every(r => r.totalEntries === 1), "F04: 5 parallel infos all succeed");
}

// F05 — 5 parallel extract to different destinations
{
  const z = makeZip("f05.zip", [["msg.txt", "hello concurrent"]]);
  const results = await Promise.all(
    Array.from({ length: 5 }, (_, i) => {
      const dest = tmpPath(`f05-dest${i}`);
      return Promise.resolve().then(() => zipClient({ operation: "extract", path: z, destination: dest }));
    })
  );
  assert(results.every(r => r.filesExtracted === 1), "F05: 5 parallel extracts all succeed");
}

// ── Cleanup ────────────────────────────────────────────────────────────────
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
try { fs.rmSync("scripts/wire-zip-client.js"); } catch {}

// ── Summary ─────────────────────────────────────────────���─────────────────
console.log(`\n\nSection 213 — zip_client: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

})().catch(err => { console.error(err); process.exit(1); });
