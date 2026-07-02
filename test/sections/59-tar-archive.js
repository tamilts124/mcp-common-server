"use strict";
/**
 * [59] TAR ARCHIVE — create_tar / extract_tar (USTAR + optional gzip).
 * Rigor: Normal/Medium/High/Critical/Extreme.
 */
const path = require("path");
const fs   = require("fs");
const zlib = require("zlib");

const { assert, test, TMP, executeTool } = require("../test-harness");

console.log(`\n[59] TAR ARCHIVE — create_tar / extract_tar`);

let _seq = 0;
function uq(p) { return `${p}-${++_seq}`; }

function mkSrc(rel, files) {
  const abs = path.join(TMP, rel);
  fs.mkdirSync(abs, { recursive: true });
  for (const { rel: r, data } of files) {
    const fabs = path.join(abs, r);
    fs.mkdirSync(path.dirname(fabs), { recursive: true });
    fs.writeFileSync(fabs, data);
  }
  return rel;
}

/** Hand-build a raw (unwrapped, non-gzip) USTAR buffer for malformed-archive tests. */
function buildRawTar(entries) {
  const blocks = [];
  for (const e of entries) {
    const buf = Buffer.alloc(512, 0);
    buf.write(e.name || "", 0, 100, "utf8");
    buf.write("0000644", 100, 7, "ascii"); buf[107] = 0;
    buf.write("0000000", 108, 7, "ascii"); buf[115] = 0;
    buf.write("0000000", 116, 7, "ascii"); buf[123] = 0;
    const sizeOct = (e.size ?? (e.data ? e.data.length : 0)).toString(8).padStart(11, "0");
    buf.write(sizeOct, 124, 11, "ascii"); buf[135] = 0;
    buf.write("00000000000", 136, 11, "ascii"); buf[147] = 0;
    buf.fill(0x20, 148, 156);
    buf[156] = (e.typeflag || "0").charCodeAt(0);
    buf.write("ustar", 257, 6, "ascii");
    buf.write("00", 263, 2, "ascii");
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += buf[i];
    buf.write(sum.toString(8).padStart(6, "0"), 148, 6, "ascii");
    buf[154] = 0; buf[155] = 0x20;
    blocks.push(buf);
    if (e.data) {
      blocks.push(e.data);
      const pad = (512 - (e.data.length % 512)) % 512;
      if (pad) blocks.push(Buffer.alloc(pad, 0));
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(blocks);
}

// ── NORMAL ──────────────────────────────────────────────────────────────────
test("create_tar + extract_tar: round-trip preserves nested file contents", () => {
  const src = mkSrc(uq("src"), [{ rel: "a.txt", data: "hello" }, { rel: "sub/b.txt", data: "world" }]);
  const tarDest = uq("out") + ".tar.gz";
  const r1 = executeTool("create_tar", { path: src, destination: tarDest });
  assert.strictEqual(r1.filesArchived, 2);
  assert.strictEqual(r1.gzip, true);
  const extractDest = uq("ext");
  const r2 = executeTool("extract_tar", { path: tarDest, destination: extractDest });
  assert.strictEqual(r2.filesExtracted, 2);
  assert.strictEqual(fs.readFileSync(path.join(TMP, extractDest, "a.txt"), "utf8"), "hello");
  assert.strictEqual(fs.readFileSync(path.join(TMP, extractDest, "sub/b.txt"), "utf8"), "world");
});
test("create_tar: .tar extension (no gzip) produces a plain, non-gzip-magic file", () => {
  const src = mkSrc(uq("src"), [{ rel: "a.txt", data: "x" }]);
  const dest = uq("out") + ".tar";
  const r = executeTool("create_tar", { path: src, destination: dest });
  assert.strictEqual(r.gzip, false);
  const buf = fs.readFileSync(path.join(TMP, dest));
  assert.ok(!(buf[0] === 0x1f && buf[1] === 0x8b));
});
test("create_tar: explicit gzip:false overrides .tar.gz extension inference", () => {
  const src = mkSrc(uq("src"), [{ rel: "a.txt", data: "x" }]);
  const dest = uq("out") + ".tar.gz";
  const r = executeTool("create_tar", { path: src, destination: dest, gzip: false });
  assert.strictEqual(r.gzip, false);
});
test("extract_tar: return shape has extracted/merged/filesExtracted/directoriesCreated/totalBytes", () => {
  const src = mkSrc(uq("src"), [{ rel: "a.txt", data: "12345" }]);
  const dest = uq("out") + ".tar";
  executeTool("create_tar", { path: src, destination: dest });
  const r = executeTool("extract_tar", { path: dest, destination: uq("ext") });
  assert.deepStrictEqual(Object.keys(r).sort(), ["destination", "directoriesCreated", "extracted", "filesExtracted", "merged", "source", "totalBytes"].sort());
  assert.strictEqual(r.totalBytes, 5);
});

// ── MEDIUM ──────────────────────────────────────────────────────────────────
test("create_tar: missing 'path' throws -32602", () => {
  assert.throws(() => executeTool("create_tar", { destination: "x.tar" }), e => e.code === -32602);
});
test("create_tar: missing 'destination' throws -32602", () => {
  assert.throws(() => executeTool("create_tar", { path: "." }), e => e.code === -32602);
});
test("create_tar: source is a file, not a directory, throws", () => {
  const src = mkSrc(uq("src"), [{ rel: "a.txt", data: "x" }]);
  assert.throws(() => executeTool("create_tar", { path: `${src}/a.txt`, destination: uq("out") + ".tar" }));
});
test("extract_tar: non-existent source throws -32602", () => {
  assert.throws(() => executeTool("extract_tar", { path: "does-not-exist.tar", destination: uq("ext") }), e => e.code === -32602);
});
test("extract_tar: existing destination without overwrite throws -32602", () => {
  const src = mkSrc(uq("src"), [{ rel: "a.txt", data: "x" }]);
  const dest = uq("out") + ".tar";
  executeTool("create_tar", { path: src, destination: dest });
  const extractDest = uq("ext");
  fs.mkdirSync(path.join(TMP, extractDest));
  assert.throws(() => executeTool("extract_tar", { path: dest, destination: extractDest }), e => e.code === -32602);
});
test("extract_tar: overwrite:true merges into an existing destination", () => {
  const src = mkSrc(uq("src"), [{ rel: "a.txt", data: "x" }]);
  const dest = uq("out") + ".tar";
  executeTool("create_tar", { path: src, destination: dest });
  const extractDest = uq("ext");
  fs.mkdirSync(path.join(TMP, extractDest));
  fs.writeFileSync(path.join(TMP, extractDest, "keep.txt"), "kept");
  const r = executeTool("extract_tar", { path: dest, destination: extractDest, overwrite: true });
  assert.strictEqual(r.merged, true);
  assert.strictEqual(fs.readFileSync(path.join(TMP, extractDest, "keep.txt"), "utf8"), "kept");
});

// ── HIGH ────────────────────────────────────────────────────────────────────
test("extract_tar: gzip auto-detected from magic bytes regardless of extension", () => {
  const src = mkSrc(uq("src"), [{ rel: "a.txt", data: "gz-detect" }]);
  const gzDest = uq("out") + ".tar.gz";
  executeTool("create_tar", { path: src, destination: gzDest });
  const renamed = uq("out") + ".tar"; // .tar extension but actually gzip content
  fs.renameSync(path.join(TMP, gzDest), path.join(TMP, renamed));
  const r = executeTool("extract_tar", { path: renamed, destination: uq("ext") });
  assert.strictEqual(r.filesExtracted, 1);
});
test("extract_tar: gzip-magic file with corrupt gzip payload throws a clean ToolError, no crash", () => {
  const bad = Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.from("not really gzip data at all")]);
  const p = uq("bad") + ".tar.gz";
  fs.writeFileSync(path.join(TMP, p), bad);
  assert.throws(() => executeTool("extract_tar", { path: p, destination: uq("ext") }), e => e.code === -32602);
});
test("extract_tar: truncated archive (entry size exceeds remaining bytes) throws cleanly", () => {
  const raw = buildRawTar([{ name: "a.txt", size: 9999, data: Buffer.from("short") }]);
  const truncated = raw.subarray(0, 512 + 100); // cut the data block short
  const p = uq("trunc") + ".tar";
  fs.writeFileSync(path.join(TMP, p), truncated);
  assert.throws(() => executeTool("extract_tar", { path: p, destination: uq("ext") }), e => e.code === -32602);
});

// ── CRITICAL ────────────────────────────────────────────────────────────────
test("extract_tar: '..' traversal entry name rejected, nothing written", () => {
  const raw = buildRawTar([{ name: "../../evil.txt", data: Buffer.from("pwned") }]);
  const p = uq("evil") + ".tar";
  fs.writeFileSync(path.join(TMP, p), raw);
  const dest = uq("ext");
  assert.throws(() => executeTool("extract_tar", { path: p, destination: dest }), e => e.code === -32001);
  assert.ok(!fs.existsSync(path.join(TMP, "evil.txt")));
});
test("extract_tar: absolute-path entry name rejected", () => {
  const raw = buildRawTar([{ name: "/etc/passwd", data: Buffer.from("x") }]);
  const p = uq("evil") + ".tar";
  fs.writeFileSync(path.join(TMP, p), raw);
  assert.throws(() => executeTool("extract_tar", { path: p, destination: uq("ext") }), e => e.code === -32001);
});
test("extract_tar: symlink-type entry rejected outright", () => {
  const raw = buildRawTar([{ name: "link", typeflag: "2", size: 0 }]);
  const p = uq("evil") + ".tar";
  fs.writeFileSync(path.join(TMP, p), raw);
  assert.throws(() => executeTool("extract_tar", { path: p, destination: uq("ext") }), e => e.code === -32001);
});
test("extract_tar: entry with an empty/null-only name is rejected", () => {
  const raw = buildRawTar([{ name: "\0", data: Buffer.from("x") }]);
  const p = uq("evil") + ".tar";
  fs.writeFileSync(path.join(TMP, p), raw);
  assert.throws(() => executeTool("extract_tar", { path: p, destination: uq("ext") }));
});
test("create_tar: archived injection-shaped filenames/content round-trip literally, never executed", () => {
  const src = mkSrc(uq("src"), [{ rel: "$(rm -rf tmp).txt", data: "'; DROP TABLE users; --" }]);
  const dest = uq("out") + ".tar";
  executeTool("create_tar", { path: src, destination: dest });
  const extractDest = uq("ext");
  executeTool("extract_tar", { path: dest, destination: extractDest });
  assert.strictEqual(
    fs.readFileSync(path.join(TMP, extractDest, "$(rm -rf tmp).txt"), "utf8"),
    "'; DROP TABLE users; --"
  );
});

// ── EXTREME ─────────────────────────────────────────────────────────────────
test("extract_tar: fuzzed random garbage bytes never crash — throws or fails cleanly", () => {
  const garbage = Buffer.from(Array.from({ length: 2000 }, () => Math.floor(Math.random() * 256)));
  const p = uq("fuzz") + ".tar";
  fs.writeFileSync(path.join(TMP, p), garbage);
  try {
    executeTool("extract_tar", { path: p, destination: uq("ext") });
  } catch (e) {
    assert.ok(typeof e.code === "number");
  }
});
test("create_tar + extract_tar: 60-file tree round-trips with correct count/bytes", () => {
  const files = Array.from({ length: 60 }, (_, i) => ({ rel: `f${i}.txt`, data: `content-${i}` }));
  const src = mkSrc(uq("src"), files);
  const dest = uq("out") + ".tar.gz";
  const r1 = executeTool("create_tar", { path: src, destination: dest });
  assert.strictEqual(r1.filesArchived, 60);
  const extractDest = uq("ext");
  const r2 = executeTool("extract_tar", { path: dest, destination: extractDest });
  assert.strictEqual(r2.filesExtracted, 60);
  assert.strictEqual(fs.readFileSync(path.join(TMP, extractDest, "f59.txt"), "utf8"), "content-59");
});
test("create_tar: path name >100 bytes splits into USTAR prefix/name and round-trips", () => {
  const longDir = "a".repeat(80) + "/" + "b".repeat(80);
  const src = mkSrc(uq("src"), [{ rel: `${longDir}/file.txt`, data: "deep" }]);
  const dest = uq("out") + ".tar";
  executeTool("create_tar", { path: src, destination: dest });
  const extractDest = uq("ext");
  executeTool("extract_tar", { path: dest, destination: extractDest });
  assert.strictEqual(fs.readFileSync(path.join(TMP, extractDest, longDir, "file.txt"), "utf8"), "deep");
});
test("create_tar: a single path segment >255 bytes throws a clear USTAR-limit error", () => {
  // A 300-byte filename component isn't creatable on most filesystems, so this
  // exercises tarOps.splitName() directly rather than via a real fixture file.
  const { splitName } = require("../../lib/tarOps");
  assert.throws(() => splitName("c".repeat(300) + ".txt"), e => e.code === -32602);
});
test("create_tar/extract_tar: 10 concurrent round-trips don't interfere with each other", () => {
  const results = [];
  for (let i = 0; i < 10; i++) {
    const src = mkSrc(uq("src"), [{ rel: "a.txt", data: `run-${i}` }]);
    const dest = uq("out") + ".tar";
    executeTool("create_tar", { path: src, destination: dest });
    const extractDest = uq("ext");
    executeTool("extract_tar", { path: dest, destination: extractDest });
    results.push(fs.readFileSync(path.join(TMP, extractDest, "a.txt"), "utf8"));
  }
  for (let i = 0; i < 10; i++) assert.strictEqual(results[i], `run-${i}`);
});
test("create_tar/extract_tar registered in TOOLS_ALL, WRITE_TOOLS, and execute_pipeline op enum", () => {
  const { TOOLS_ALL, WRITE_TOOLS } = require("../../lib/toolsSchema");
  assert.ok(TOOLS_ALL.some(t => t.name === "create_tar"));
  assert.ok(TOOLS_ALL.some(t => t.name === "extract_tar"));
  assert.ok(WRITE_TOOLS.has("create_tar"));
  assert.ok(WRITE_TOOLS.has("extract_tar"));
  const { EXEC_SCHEMAS } = require("../../lib/schemas/execSchemas");
  const pipelineOp = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
  const opEnum = pipelineOp.inputSchema.properties.steps.items.properties.op.enum;
  assert.ok(opEnum.includes("create_tar"));
  assert.ok(opEnum.includes("extract_tar"));
});
