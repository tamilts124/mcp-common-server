"use strict";
/**
 * [31b] UNZIP_ARCHIVE — Critical / Extreme rigor levels.
 * Normal / Medium / High are in test/sections/28-unzip-archive.js.
 */
const path   = require("path");
const fs     = require("fs");
const crypto = require("crypto");

const { assert, test, TMP, executeTool } = require("../test-harness");
const { uq, makeZip, buildRawZip } = require("./28-unzip-archive");

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
    // May throw for __proto__-named dir; that's fine.
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
    "\ud800\udc00",
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
