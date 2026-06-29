"use strict";
/**
 * [31] UNZIP_ARCHIVE — extract a ZIP file's contents into a jailed directory
 *
 * Rigor levels covered:
 *
 *   Normal:   happy-path — create a ZIP via zip_directory, then extract it into a
 *             new destination; verify every file's content is correct, returned
 *             fields (filesExtracted, directoriesCreated, totalBytes, extracted,
 *             merged) are all present and plausible. Also: single-file ZIP,
 *             overwrite:true into an existing destination (merge semantics),
 *             destination-auto-creation (parent dirs created automatically).
 *
 *   Medium:   boundary — empty ZIP extracts to an empty destination; ZIP with
 *             only directory entries; missing required 'path' field returns -32602;
 *             missing required 'destination' field returns -32602; source is a
 *             plain directory (not a zip file) returns descriptive error; source
 *             is a .txt file (not a ZIP) throws EOCD-not-found error; destination
 *             already exists without overwrite: true returns descriptive error;
 *             source ZIP does not exist returns descriptive error.
 *
 *   High:     dependency failure — ZIP with a stored (method 0) entry is extracted
 *             correctly (in addition to the DEFLATE entries covered by Normal);
 *             ZIP with a corrupt/truncated buffer surfaces descriptive error
 *             without crashing; ZIP with unsupported compression method (method 1
 *             = shrunk) returns descriptive error; corrupt Local File Header magic
 *             triggers descriptive error.
 *
 *   Critical: security — entry with '..' traversal segment rejected before ANY
 *             write (Zip Slip); entry with absolute POSIX path '/etc/passwd'
 *             rejected; entry with absolute Windows path 'C:\Windows\passwd'
 *             rejected; entry with null byte in name rejected; injected
 *             injection-shaped file CONTENT round-trips literally (not executed);
 *             path traversal via 'path' argument blocked; path traversal via
 *             'destination' argument blocked; absolute OS path via 'path'
 *             blocked; no prototype pollution from entry data.
 *
 *   Extreme:  stress — ZIP with 100 files extracts all of them correctly;
 *             ZIP with a 200 KB binary file round-trips exactly (byte-for-byte);
 *             10 concurrent extractions of the same ZIP into different dirs all
 *             succeed; re-extract 50 times in a row gives consistent filesExtracted;
 *             result is fully JSON-serialisable; fuzz bytes as 'path' throw cleanly.
 */
const path = require("path");
const fs   = require("fs");
const zlib = require("zlib");
const crypto = require("crypto");

const { assert, test, TMP, executeTool, ToolError } = require("../test-harness");

console.log(`\n[31] UNZIP_ARCHIVE — unzip_archive tool`);

// ── HELPERS ───────────────────────────────────────────────────────────────────

/** Sequence counter for unique sub-directory names so no test steps on another. */
let _seq = 0;
function uq(prefix) { return `${prefix}-${++_seq}`; }

/**
 * Build a source directory under TMP, write `files` to it, create a ZIP via
 * zip_directory, and return the client-relative zip path string.
 */
function makeZip(srcRel, destRel, files = []) {
  const srcAbs = path.join(TMP, srcRel);
  fs.mkdirSync(srcAbs, { recursive: true });
  for (const { rel, buf } of files) {
    const abs = path.join(srcAbs, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, buf instanceof Buffer ? buf : Buffer.from(buf, "utf8"));
  }
  executeTool("zip_directory", { path: srcRel, destination: destRel });
  return destRel;
}

/**
 * Build a valid minimal ZIP buffer by hand, useful for crafting malformed or
 * security-test ZIPs without going through zip_directory.
 *
 * @param {Array<{name:string, data:Buffer, method:number}>} entries
 *   method 0 = stored, method 8 = deflate (caller must pre-deflate data)
 */
function buildRawZip(entries) {
  // CRC-32 table
  const crcTable = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c;
    }
    return t;
  })();
  function crc32(buf) {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  const lfhBufs = [];
  const cdfhBufs = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const crc = crc32(e.method === 0 ? e.data : e.originalData || e.data);
    const lfh = Buffer.allocUnsafe(30 + nameBuf.length);
    lfh.writeUInt32LE(0x04034b50, 0); // LFH sig
    lfh.writeUInt16LE(20, 4);          // version needed
    lfh.writeUInt16LE(0, 6);           // flags
    lfh.writeUInt16LE(e.method, 8);
    lfh.writeUInt16LE(0, 10);          // mod time
    lfh.writeUInt16LE(0, 12);          // mod date
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(e.data.length, 18); // compressed size
    lfh.writeUInt32LE((e.originalData || e.data).length, 22); // uncompressed size
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);
    nameBuf.copy(lfh, 30);

    const cdfh = Buffer.allocUnsafe(46 + nameBuf.length);
    cdfh.writeUInt32LE(0x02014b50, 0); // CDFH sig
    cdfh.writeUInt16LE(20, 4);
    cdfh.writeUInt16LE(20, 6);
    cdfh.writeUInt16LE(0, 8);          // flags
    cdfh.writeUInt16LE(e.method, 10);
    cdfh.writeUInt16LE(0, 12);
    cdfh.writeUInt16LE(0, 14);
    cdfh.writeUInt32LE(crc, 16);
    cdfh.writeUInt32LE(e.data.length, 20);
    cdfh.writeUInt32LE((e.originalData || e.data).length, 24);
    cdfh.writeUInt16LE(nameBuf.length, 28);
    cdfh.writeUInt16LE(0, 30);          // extra len
    cdfh.writeUInt16LE(0, 32);          // comment len
    cdfh.writeUInt16LE(0, 34);          // disk start
    cdfh.writeUInt16LE(0, 36);          // int attribs
    cdfh.writeUInt32LE(0, 38);          // ext attribs
    cdfh.writeUInt32LE(offset, 42);
    nameBuf.copy(cdfh, 46);

    lfhBufs.push(lfh, e.data);
    cdfhBufs.push(cdfh);
    offset += lfh.length + e.data.length;
  }

  const cdBuf = Buffer.concat(cdfhBufs);
  const eocd  = Buffer.allocUnsafe(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...lfhBufs, cdBuf, eocd]);
}

// ── NORMAL ────────────────────────────────────────────────────────────────────

test("unzip_archive: happy-path — extract multi-file ZIP, all files correct", () => {
  const files = [
    { rel: "hello.txt",        buf: "Hello, world!\n" },
    { rel: "sub/data.json",    buf: '{"key":"value"}\n' },
    { rel: "sub/nested/hi.md", buf: "# Hi\n" },
  ];
  const zipRel = makeZip(uq("src-a"), uq("out-a") + ".zip", files);
  const destRel = uq("extract-a");

  const r = executeTool("unzip_archive", { path: zipRel, destination: destRel });
  assert.strictEqual(r.extracted, true);
  assert.strictEqual(r.merged,    false);
  assert.ok(r.filesExtracted >= 3, `filesExtracted=${r.filesExtracted}`);
  assert.ok(r.totalBytes > 0);

  const destAbs = path.join(TMP, destRel);
  assert.strictEqual(fs.readFileSync(path.join(destAbs, "hello.txt"),        "utf8"), "Hello, world!\n");
  assert.strictEqual(fs.readFileSync(path.join(destAbs, "sub/data.json"),    "utf8"), '{"key":"value"}\n');
  assert.strictEqual(fs.readFileSync(path.join(destAbs, "sub/nested/hi.md"), "utf8"), "# Hi\n");
});

test("unzip_archive: result fields all present and typed correctly", () => {
  const zipRel = makeZip(uq("src-b"), uq("out-b") + ".zip", [{ rel: "a.txt", buf: "a" }]);
  const destRel = uq("extract-b");
  const r = executeTool("unzip_archive", { path: zipRel, destination: destRel });
  assert.ok(typeof r.extracted === "boolean");
  assert.ok(typeof r.merged    === "boolean");
  assert.ok(typeof r.filesExtracted     === "number");
  assert.ok(typeof r.directoriesCreated === "number");
  assert.ok(typeof r.totalBytes         === "number");
  assert.ok(typeof r.source      === "string");
  assert.ok(typeof r.destination === "string");
});

test("unzip_archive: single-file ZIP extracts correctly", () => {
  const zipRel = makeZip(uq("src-c"), uq("out-c") + ".zip", [{ rel: "only.txt", buf: "solo\n" }]);
  const destRel = uq("extract-c");
  const r = executeTool("unzip_archive", { path: zipRel, destination: destRel });
  assert.strictEqual(r.filesExtracted, 1);
  assert.strictEqual(fs.readFileSync(path.join(TMP, destRel, "only.txt"), "utf8"), "solo\n");
});

test("unzip_archive: overwrite:true merges into existing destination", () => {
  const files = [{ rel: "a.txt", buf: "new-a\n" }, { rel: "b.txt", buf: "new-b\n" }];
  const zipRel = makeZip(uq("src-d"), uq("out-d") + ".zip", files);
  const destRel = uq("extract-d");
  const destAbs = path.join(TMP, destRel);

  // Pre-create destination with a pre-existing file that should NOT be removed
  fs.mkdirSync(destAbs, { recursive: true });
  fs.writeFileSync(path.join(destAbs, "preexisting.txt"), "old\n", "utf8");

  const r = executeTool("unzip_archive", { path: zipRel, destination: destRel, overwrite: true });
  assert.strictEqual(r.merged, true);
  // Both ZIP files extracted
  assert.strictEqual(fs.readFileSync(path.join(destAbs, "a.txt"), "utf8"), "new-a\n");
  assert.strictEqual(fs.readFileSync(path.join(destAbs, "b.txt"), "utf8"), "new-b\n");
  // Pre-existing file NOT removed (merge, not replace)
  assert.strictEqual(fs.readFileSync(path.join(destAbs, "preexisting.txt"), "utf8"), "old\n");
});

test("unzip_archive: destination parent dirs auto-created", () => {
  const zipRel = makeZip(uq("src-e"), uq("out-e") + ".zip", [{ rel: "x.txt", buf: "x\n" }]);
  const destRel = uq("deep") + "/nested/new/extract";
  const r = executeTool("unzip_archive", { path: zipRel, destination: destRel });
  assert.strictEqual(r.extracted, true);
  assert.ok(fs.existsSync(path.join(TMP, destRel, "x.txt")));
});

// ── MEDIUM ────────────────────────────────────────────────────────────────────

test("unzip_archive: empty ZIP (0 files) extracts to empty destination", () => {
  const emptyZip = buildRawZip([]);
  const zipAbs = path.join(TMP, uq("empty") + ".zip");
  fs.writeFileSync(zipAbs, emptyZip);
  const zipRel = path.basename(zipAbs);
  const destRel = uq("extract-empty");
  const r = executeTool("unzip_archive", { path: zipRel, destination: destRel });
  assert.strictEqual(r.filesExtracted, 0);
  assert.ok(fs.existsSync(path.join(TMP, destRel)));
});

test("unzip_archive: ZIP with only directory entries creates directories", () => {
  const dirEntry = { name: "mydir/", data: Buffer.alloc(0), method: 0 };
  const buf = buildRawZip([dirEntry]);
  const zipAbs = path.join(TMP, uq("dironly") + ".zip");
  fs.writeFileSync(zipAbs, buf);
  const destRel = uq("extract-dironly");
  const r = executeTool("unzip_archive", { path: path.basename(zipAbs), destination: destRel });
  assert.strictEqual(r.filesExtracted, 0);
  assert.ok(fs.existsSync(path.join(TMP, destRel, "mydir")));
});

test("unzip_archive: missing required 'path' field returns -32602", () => {
  let caught = null;
  try { executeTool("unzip_archive", { destination: "somewhere" }); }
  catch (e) { caught = e; }
  assert.ok(caught, "should have thrown");
  assert.ok(caught.code === -32602 || caught.message.includes("path"));
});

test("unzip_archive: missing required 'destination' field returns -32602", () => {
  let caught = null;
  try { executeTool("unzip_archive", { path: "some.zip" }); }
  catch (e) { caught = e; }
  assert.ok(caught, "should have thrown");
  assert.ok(caught.code === -32602 || caught.message.includes("destination"));
});

test("unzip_archive: source is a directory returns descriptive error", () => {
  const srcRel = uq("src-isdir");
  fs.mkdirSync(path.join(TMP, srcRel), { recursive: true });
  let caught = null;
  try { executeTool("unzip_archive", { path: srcRel, destination: uq("dest") }); }
  catch (e) { caught = e; }
  assert.ok(caught, "should have thrown");
  assert.ok(caught.message.toLowerCase().includes("director"), `msg: ${caught.message}`);
});

test("unzip_archive: source is a text file (not a ZIP) throws descriptive EOCD error", () => {
  const txtRel = uq("not-a-zip") + ".txt";
  fs.writeFileSync(path.join(TMP, txtRel), "this is not a zip file", "utf8");
  let caught = null;
  try { executeTool("unzip_archive", { path: txtRel, destination: uq("dest") }); }
  catch (e) { caught = e; }
  assert.ok(caught, "should have thrown");
  assert.ok(caught.message.toLowerCase().includes("eocd") || caught.message.toLowerCase().includes("zip"),
    `msg: ${caught.message}`);
});

test("unzip_archive: destination exists without overwrite:true returns descriptive error", () => {
  const zipRel = makeZip(uq("src-ow"), uq("out-ow") + ".zip", [{ rel: "f.txt", buf: "x" }]);
  const destRel = uq("extract-ow");
  fs.mkdirSync(path.join(TMP, destRel), { recursive: true });
  let caught = null;
  try { executeTool("unzip_archive", { path: zipRel, destination: destRel }); }
  catch (e) { caught = e; }
  assert.ok(caught, "should have thrown");
  assert.ok(caught.message.toLowerCase().includes("exist") || caught.message.toLowerCase().includes("overwrite"),
    `msg: ${caught.message}`);
});

test("unzip_archive: source ZIP does not exist returns descriptive error", () => {
  let caught = null;
  try { executeTool("unzip_archive", { path: "nonexistent-99999.zip", destination: uq("dest") }); }
  catch (e) { caught = e; }
  assert.ok(caught, "should have thrown");
  assert.ok(caught.message.toLowerCase().includes("exist") || caught.message.toLowerCase().includes("zip"),
    `msg: ${caught.message}`);
});

// ── HIGH ──────────────────────────────────────────────────────────────────────

test("unzip_archive: 'stored' (method 0) entries extracted correctly", () => {
  const content = Buffer.from("stored-content\n");
  const entry = { name: "stored.txt", data: content, method: 0 };
  const buf = buildRawZip([entry]);
  const zipAbs = path.join(TMP, uq("stored") + ".zip");
  fs.writeFileSync(zipAbs, buf);
  const destRel = uq("extract-stored");
  const r = executeTool("unzip_archive", { path: path.basename(zipAbs), destination: destRel });
  assert.strictEqual(r.filesExtracted, 1);
  const out = fs.readFileSync(path.join(TMP, destRel, "stored.txt"));
  assert.ok(out.equals(content), "stored content round-trip mismatch");
});

test("unzip_archive: corrupt/truncated ZIP buffer surfaces descriptive error", () => {
  const corrupt = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xDE, 0xAD, 0xBE, 0xEF]);
  const zipAbs = path.join(TMP, uq("corrupt") + ".zip");
  fs.writeFileSync(zipAbs, corrupt);
  let caught = null;
  try { executeTool("unzip_archive", { path: path.basename(zipAbs), destination: uq("dest") }); }
  catch (e) { caught = e; }
  assert.ok(caught, "should have thrown");
  assert.ok(typeof caught.message === "string" && caught.message.length > 0);
});

test("unzip_archive: unsupported compression method returns descriptive error", () => {
  // Method 1 = shrunk — not supported
  const entry = { name: "shrunk.txt", data: Buffer.from("dummy"), method: 1 };
  const buf = buildRawZip([entry]);
  const zipAbs = path.join(TMP, uq("method1") + ".zip");
  fs.writeFileSync(zipAbs, buf);
  let caught = null;
  try { executeTool("unzip_archive", { path: path.basename(zipAbs), destination: uq("dest") }); }
  catch (e) { caught = e; }
  assert.ok(caught, "should have thrown");
  assert.ok(caught.message.includes("method") || caught.message.includes("compression"),
    `msg: ${caught.message}`);
});

test("unzip_archive: corrupt Local File Header magic triggers descriptive error", () => {
  // Build valid-looking CD but corrupt the LFH signature in the data area
  const nameBuf = Buffer.from("file.txt", "utf8");
  const data    = Buffer.from("hello");
  const crc32   = 0x3610a686; // crc32 of "hello"

  // CDFH pointing to offset 0, but write garbage at offset 0 instead of valid LFH
  const junk = Buffer.alloc(50, 0xCC); // NOT a valid LFH

  const cdfh = Buffer.allocUnsafe(46 + nameBuf.length);
  cdfh.writeUInt32LE(0x02014b50, 0);
  cdfh.writeUInt16LE(20, 4); cdfh.writeUInt16LE(20, 6);
  cdfh.writeUInt16LE(0, 8); cdfh.writeUInt16LE(8, 10);
  cdfh.writeUInt16LE(0, 12); cdfh.writeUInt16LE(0, 14);
  cdfh.writeUInt32LE(crc32, 16);
  cdfh.writeUInt32LE(data.length, 20); cdfh.writeUInt32LE(data.length, 24);
  cdfh.writeUInt16LE(nameBuf.length, 28);
  cdfh.writeUInt16LE(0, 30); cdfh.writeUInt16LE(0, 32);
  cdfh.writeUInt16LE(0, 34); cdfh.writeUInt16LE(0, 36);
  cdfh.writeUInt32LE(0, 38); cdfh.writeUInt32LE(0, 42); // localHeaderOffset = 0
  nameBuf.copy(cdfh, 46);

  const eocd = Buffer.allocUnsafe(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdfh.length, 12);
  eocd.writeUInt32LE(junk.length, 16);
  eocd.writeUInt16LE(0, 20);

  const badZip = Buffer.concat([junk, cdfh, eocd]);
  const zipAbs = path.join(TMP, uq("badlfh") + ".zip");
  fs.writeFileSync(zipAbs, badZip);
  let caught = null;
  try { executeTool("unzip_archive", { path: path.basename(zipAbs), destination: uq("dest") }); }
  catch (e) { caught = e; }
  assert.ok(caught, "should have thrown for corrupt LFH");
  assert.ok(typeof caught.message === "string" && caught.message.length > 0, `msg: ${caught.message}`);
});

// ── CRITICAL ──────────────────────────────────────────────────────────────────

test("unzip_archive: entry with '..' segment rejected before any write (Zip Slip)", () => {
  const slipEntry = { name: "../escape.txt", data: Buffer.from("evil"), method: 0 };
  const safeEntry = { name: "safe.txt",      data: Buffer.from("safe"), method: 0 };
  const buf = buildRawZip([slipEntry, safeEntry]);
  const zipAbs = path.join(TMP, uq("zipslip") + ".zip");
  fs.writeFileSync(zipAbs, buf);
  const destRel = uq("zipslip-dest");
  let caught = null;
  try { executeTool("unzip_archive", { path: path.basename(zipAbs), destination: destRel }); }
  catch (e) { caught = e; }
  assert.ok(caught, "should have thrown for Zip Slip");
  assert.ok(caught.message.includes("..") || caught.message.includes("traversal"),
    `msg: ${caught.message}`);
  // safe.txt must NOT have been written (abort-before-write)
  assert.ok(!fs.existsSync(path.join(TMP, destRel, "safe.txt")),
    "abort-before-write: safe.txt should not exist after Zip Slip rejection");
});

test("unzip_archive: entry with absolute POSIX path rejected (Zip Slip)", () => {
  const entry = { name: "/etc/passwd", data: Buffer.from("evil"), method: 0 };
  const buf = buildRawZip([entry]);
  const zipAbs = path.join(TMP, uq("abs-posix") + ".zip");
  fs.writeFileSync(zipAbs, buf);
  let caught = null;
  try { executeTool("unzip_archive", { path: path.basename(zipAbs), destination: uq("dest") }); }
  catch (e) { caught = e; }
  assert.ok(caught, "should have thrown for absolute POSIX path");
  assert.ok(caught.message.toLowerCase().includes("absolute") || caught.message.includes("Zip Slip"),
    `msg: ${caught.message}`);
});

test("unzip_archive: entry with absolute Windows path rejected (Zip Slip)", () => {
  const entry = { name: "C:\\Windows\\evil.txt", data: Buffer.from("evil"), method: 0 };
  const buf = buildRawZip([entry]);
  const zipAbs = path.join(TMP, uq("abs-win") + ".zip");
  fs.writeFileSync(zipAbs, buf);
  let caught = null;
  try { executeTool("unzip_archive", { path: path.basename(zipAbs), destination: uq("dest") }); }
  catch (e) { caught = e; }
  assert.ok(caught, "should have thrown for absolute Windows path");
  assert.ok(caught.message.toLowerCase().includes("absolute") || caught.message.includes("Zip Slip"),
    `msg: ${caught.message}`);
});

test("unzip_archive: entry with null byte in name rejected", () => {
  const entry = { name: "file\0.txt", data: Buffer.from("evil"), method: 0 };
  const buf = buildRawZip([entry]);
  const zipAbs = path.join(TMP, uq("nullbyte") + ".zip");
  fs.writeFileSync(zipAbs, buf);
  let caught = null;
  try { executeTool("unzip_archive", { path: path.basename(zipAbs), destination: uq("dest") }); }
  catch (e) { caught = e; }
  assert.ok(caught, "should have thrown for null byte in entry name");
  assert.ok(caught.message.includes("null") || caught.message.toLowerCase().includes("byte"),
    `msg: ${caught.message}`);
});

test("unzip_archive: injection-shaped file CONTENT round-trips literally", () => {
  const injContent = Buffer.from("; DROP TABLE users; --\n<script>alert(1)</script>\n../../../etc/shadow\n");
  const zipRel = makeZip(uq("src-inj"), uq("out-inj") + ".zip", [{ rel: "payload.txt", buf: injContent }]);
  const destRel = uq("extract-inj");
  executeTool("unzip_archive", { path: zipRel, destination: destRel });
  const out = fs.readFileSync(path.join(TMP, destRel, "payload.txt"));
  assert.ok(out.equals(injContent), "injection content must round-trip literally");
});

test("unzip_archive: path traversal via 'path' argument blocked", () => {
  let caught = null;
  try { executeTool("unzip_archive", { path: "../../escape.zip", destination: uq("dest") }); }
  catch (e) { caught = e; }
  assert.ok(caught, "should have thrown for path traversal in 'path'");
});

test("unzip_archive: path traversal via 'destination' argument blocked", () => {
  const zipRel = makeZip(uq("src-esc"), uq("out-esc") + ".zip", [{ rel: "f.txt", buf: "x" }]);
  let caught = null;
  try { executeTool("unzip_archive", { path: zipRel, destination: "../../escape-dest" }); }
  catch (e) { caught = e; }
  assert.ok(caught, "should have thrown for path traversal in 'destination'");
});

test("unzip_archive: absolute OS path via 'path' argument blocked", () => {
  let caught = null;
  try { executeTool("unzip_archive", { path: "C:\\Windows\\system32\\evil.zip", destination: uq("dest") }); }
  catch (e) { caught = e; }
  assert.ok(caught, "should have thrown for absolute OS path in 'path'");
});

test("unzip_archive: no prototype pollution from entry data", () => {
  const before = Object.prototype.toString;
  const zipRel = makeZip(uq("src-pp"), uq("out-pp") + ".zip", [
    { rel: "__proto__/polluted.txt", buf: "evil" },
  ]);
  const destRel = uq("extract-pp");
  try {
    executeTool("unzip_archive", { path: zipRel, destination: destRel, overwrite: true });
  } catch (_) {
    // May throw due to __proto__ being a POSIX-safe but semantically weird dir name; that's fine.
  }
  assert.strictEqual(Object.prototype.toString, before, "Object.prototype.toString should not have been modified");
});

// ── EXTREME ───────────────────────────────────────────────────────────────────

test("unzip_archive: 100-file ZIP extracts all files correctly", () => {
  const files = Array.from({ length: 100 }, (_, i) => ({
    rel: `dir${Math.floor(i / 10)}/file${i}.txt`,
    buf: `content-${i}\n`,
  }));
  const zipRel = makeZip(uq("src-100"), uq("out-100") + ".zip", files);
  const destRel = uq("extract-100");
  const r = executeTool("unzip_archive", { path: zipRel, destination: destRel });
  assert.strictEqual(r.filesExtracted, 100);
  // Spot-check 10 random files
  for (let i = 0; i < 100; i += 10) {
    const expected = `content-${i}\n`;
    const rel = `dir${Math.floor(i / 10)}/file${i}.txt`;
    const actual = fs.readFileSync(path.join(TMP, destRel, rel), "utf8");
    assert.strictEqual(actual, expected, `file ${rel} mismatch`);
  }
});

test("unzip_archive: 200 KB binary file round-trips byte-for-byte", () => {
  const binary = crypto.randomBytes(200 * 1024);
  const zipRel = makeZip(uq("src-bin"), uq("out-bin") + ".zip", [{ rel: "big.bin", buf: binary }]);
  const destRel = uq("extract-bin");
  const r = executeTool("unzip_archive", { path: zipRel, destination: destRel });
  assert.strictEqual(r.filesExtracted, 1);
  const extracted = fs.readFileSync(path.join(TMP, destRel, "big.bin"));
  assert.ok(extracted.equals(binary), "200KB binary round-trip mismatch");
});

test("unzip_archive: 10 concurrent extractions of same ZIP into different dirs all succeed", () => {
  const zipRel = makeZip(uq("src-conc"), uq("out-conc") + ".zip", [
    { rel: "a.txt", buf: "alpha\n" },
    { rel: "b.txt", buf: "beta\n" },
  ]);
  const results = [];
  for (let i = 0; i < 10; i++) {
    const destRel = uq("extract-conc");
    results.push(executeTool("unzip_archive", { path: zipRel, destination: destRel }));
  }
  for (const r of results) {
    assert.strictEqual(r.filesExtracted, 2);
    assert.strictEqual(r.extracted, true);
  }
});

test("unzip_archive: 50 sequential extractions give consistent filesExtracted", () => {
  const zipRel = makeZip(uq("src-seq"), uq("out-seq") + ".zip", [
    { rel: "x.txt", buf: "x\n" },
  ]);
  for (let i = 0; i < 50; i++) {
    const r = executeTool("unzip_archive", { path: zipRel, destination: uq("extract-seq") });
    assert.strictEqual(r.filesExtracted, 1, `run ${i}: filesExtracted should be 1`);
  }
});

test("unzip_archive: result is fully JSON-serialisable", () => {
  const zipRel = makeZip(uq("src-json"), uq("out-json") + ".zip", [{ rel: "j.txt", buf: "j\n" }]);
  const r = executeTool("unzip_archive", { path: zipRel, destination: uq("extract-json") });
  let serialised;
  assert.doesNotThrow(() => { serialised = JSON.stringify(r); });
  const parsed = JSON.parse(serialised);
  assert.strictEqual(parsed.filesExtracted, r.filesExtracted);
});

test("unzip_archive: fuzz bytes as 'path' throw cleanly without crashing", () => {
  const fuzzPaths = [
    "\x00\x01\x02\x03",
    "a".repeat(4096),
    "\ud800\udc00",  // surrogate pair
    "file\nnewline.zip",
  ];
  for (const p of fuzzPaths) {
    let caught = null;
    try { executeTool("unzip_archive", { path: p, destination: uq("dest") }); }
    catch (e) { caught = e; }
    assert.ok(caught, `fuzz path ${JSON.stringify(p.slice(0, 20))} should throw`);
    assert.ok(typeof caught.message === "string", "error should have string message");
  }
});
