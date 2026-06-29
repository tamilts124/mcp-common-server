"use strict";
/**
 * [31] UNZIP_ARCHIVE — extract a ZIP file's contents into a jailed directory
 * Normal / Medium / High rigor levels.
 * Critical / Extreme are in test/sections/28b-unzip-archive-ce.js.
 */
const path = require("path");
const fs   = require("fs");

const { assert, test, TMP, executeTool } = require("../test-harness");

console.log(`\n[31] UNZIP_ARCHIVE — unzip_archive tool`);

// ── HELPERS ───────────────────────────────────────────────────────────────────

let _seq = 0;
function uq(prefix) { return `${prefix}-${++_seq}`; }

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
 * Build a valid minimal ZIP buffer by hand for crafting malformed / security-test ZIPs.
 * @param {Array<{name:string, data:Buffer, method:number, originalData?:Buffer}>} entries
 */
function buildRawZip(entries) {
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
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(0, 6);
    lfh.writeUInt16LE(e.method, 8);
    lfh.writeUInt16LE(0, 10);
    lfh.writeUInt16LE(0, 12);
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(e.data.length, 18);
    lfh.writeUInt32LE((e.originalData || e.data).length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28);
    nameBuf.copy(lfh, 30);

    const cdfh = Buffer.allocUnsafe(46 + nameBuf.length);
    cdfh.writeUInt32LE(0x02014b50, 0);
    cdfh.writeUInt16LE(20, 4); cdfh.writeUInt16LE(20, 6);
    cdfh.writeUInt16LE(0, 8); cdfh.writeUInt16LE(e.method, 10);
    cdfh.writeUInt16LE(0, 12); cdfh.writeUInt16LE(0, 14);
    cdfh.writeUInt32LE(crc, 16);
    cdfh.writeUInt32LE(e.data.length, 20);
    cdfh.writeUInt32LE((e.originalData || e.data).length, 24);
    cdfh.writeUInt16LE(nameBuf.length, 28);
    cdfh.writeUInt16LE(0, 30); cdfh.writeUInt16LE(0, 32);
    cdfh.writeUInt16LE(0, 34); cdfh.writeUInt16LE(0, 36);
    cdfh.writeUInt32LE(0, 38); cdfh.writeUInt32LE(offset, 42);
    nameBuf.copy(cdfh, 46);

    lfhBufs.push(lfh, e.data);
    cdfhBufs.push(cdfh);
    offset += lfh.length + e.data.length;
  }

  const cdBuf = Buffer.concat(cdfhBufs);
  const eocd  = Buffer.allocUnsafe(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...lfhBufs, cdBuf, eocd]);
}

// Export helpers for the companion file
module.exports = { uq, makeZip, buildRawZip };

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

  fs.mkdirSync(destAbs, { recursive: true });
  fs.writeFileSync(path.join(destAbs, "preexisting.txt"), "old\n", "utf8");

  const r = executeTool("unzip_archive", { path: zipRel, destination: destRel, overwrite: true });
  assert.strictEqual(r.merged, true);
  assert.strictEqual(fs.readFileSync(path.join(destAbs, "a.txt"), "utf8"), "new-a\n");
  assert.strictEqual(fs.readFileSync(path.join(destAbs, "b.txt"), "utf8"), "new-b\n");
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
  const destRel = uq("extract-empty");
  const r = executeTool("unzip_archive", { path: path.basename(zipAbs), destination: destRel });
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
  const nameBuf = Buffer.from("file.txt", "utf8");
  const junk = Buffer.alloc(50, 0xCC); // NOT a valid LFH

  const cdfh = Buffer.allocUnsafe(46 + nameBuf.length);
  cdfh.writeUInt32LE(0x02014b50, 0);
  cdfh.writeUInt16LE(20, 4); cdfh.writeUInt16LE(20, 6);
  cdfh.writeUInt16LE(0, 8); cdfh.writeUInt16LE(8, 10);
  cdfh.writeUInt16LE(0, 12); cdfh.writeUInt16LE(0, 14);
  cdfh.writeUInt32LE(0x3610a686, 16); // crc32("hello")
  cdfh.writeUInt32LE(5, 20); cdfh.writeUInt32LE(5, 24);
  cdfh.writeUInt16LE(nameBuf.length, 28);
  cdfh.writeUInt16LE(0, 30); cdfh.writeUInt16LE(0, 32);
  cdfh.writeUInt16LE(0, 34); cdfh.writeUInt16LE(0, 36);
  cdfh.writeUInt32LE(0, 38); cdfh.writeUInt32LE(0, 42);
  nameBuf.copy(cdfh, 46);

  const eocd = Buffer.allocUnsafe(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdfh.length, 12); eocd.writeUInt32LE(junk.length, 16);
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
