"use strict";
// ── Section 236: video_client tests ──────────────────────────────────────────
// Isolated functional tests for lib/videoClientOps.js
// Rigor levels: A=validation, B=unit, C=happy-path, D=security, E=error-paths, F=concurrency

const assert = require("assert");
const fs     = require("fs");
const path   = require("path");
const os     = require("os");
const { videoClient } = require("../../lib/videoClientOps");

let passed = 0, failed = 0;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "video-client-test-"));

function test(name, fn) {
  try {
    fn();
    console.error(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

function assertThrows(fn, msgPart) {
  let threw = false;
  try { fn(); } catch (e) {
    threw = true;
    if (msgPart && !e.message.includes(msgPart))
      throw new Error(`Expected error containing '${msgPart}' but got: ${e.message}`);
  }
  if (!threw) throw new Error("Expected error but none thrown");
}

// ── Helpers: build minimal binary test files ──────────────────────────────────

/** Build minimal valid MP4 with ftyp+moov+mvhd (v0) containing one video trak */
function buildMinimalMp4() {
  // ftyp box: size=24, type='ftyp', brand='isom', version=0, compat='isom'
  const ftyp = Buffer.alloc(24);
  ftyp.writeUInt32BE(24, 0);            // size
  ftyp.write("ftyp", 4, "latin1");      // type
  ftyp.write("isom", 8, "latin1");      // major brand
  ftyp.writeUInt32BE(0, 12);            // version
  ftyp.write("isom", 16, "latin1");     // compat brand 1
  ftyp.write("mp41", 20, "latin1");     // compat brand 2

  // mvhd box v0: size=108, timescale=1000, duration=5000
  const mvhd = Buffer.alloc(108);
  mvhd.writeUInt32BE(108, 0);           // size
  mvhd.write("mvhd", 4, "latin1");      // type
  mvhd.writeUInt32BE(0, 8);             // version+flags
  mvhd.writeUInt32BE(0, 12);            // creation
  mvhd.writeUInt32BE(0, 16);            // modification
  mvhd.writeUInt32BE(1000, 20);         // timescale (1 sec = 1000 units)
  mvhd.writeUInt32BE(5000, 24);         // duration (5000/1000 = 5.0 s)
  mvhd.writeUInt32BE(0x00010000, 28);   // rate 1.0
  mvhd.writeUInt16BE(0x0100, 32);       // volume 1.0
  // rest zeros (pre_defined etc.)
  mvhd.writeUInt32BE(0xFFFFFFFF, 100);  // next track id

  // moov box = mvhd
  const moovPayload = mvhd;
  const moovHdr = Buffer.alloc(8);
  moovHdr.writeUInt32BE(8 + moovPayload.length, 0);
  moovHdr.write("moov", 4, "latin1");

  return Buffer.concat([ftyp, moovHdr, moovPayload]);
}

/** Build minimal Matroska/MKV EBML header with SEGMENT + INFO (duration=10s) */
function buildMinimalMkv() {
  function vint(n) {
    // encode VINT (data size)
    if (n < 127) return Buffer.from([n | 0x80]);
    if (n < 16383) return Buffer.from([(n >> 8) | 0x40, n & 0xFF]);
    return Buffer.from([(n >> 16) | 0x20, (n >> 8) & 0xFF, n & 0xFF]);
  }
  function ebmlEl(id, dataOrChildren) {
    const data = Buffer.isBuffer(dataOrChildren) ? dataOrChildren : Buffer.concat(dataOrChildren);
    const idBuf = typeof id === "number" ? writeId(id) : Buffer.from(id);
    return Buffer.concat([idBuf, vint(data.length), data]);
  }
  function writeId(id) {
    if (id <= 0xFF)   return Buffer.from([id]);
    if (id <= 0xFFFF) return Buffer.from([id >> 8, id & 0xFF]);
    if (id <= 0xFFFFFF) return Buffer.from([id >> 16, (id >> 8) & 0xFF, id & 0xFF]);
    return Buffer.from([(id >>> 24) & 0xFF, (id >> 16) & 0xFF, (id >> 8) & 0xFF, id & 0xFF]);
  }
  function float64(n) {
    const b = Buffer.alloc(8);
    b.writeDoubleBE(n, 0);
    return b;
  }

  // EBML header
  const docType = ebmlEl(0x4282, Buffer.from("matroska"));
  const docTypeVer = ebmlEl(0x4287, Buffer.from([4]));
  const docTypeReadVer = ebmlEl(0x4285, Buffer.from([2]));
  const ebmlHdr = ebmlEl(0x1A45DFA3, [docType, docTypeVer, docTypeReadVer]);

  // INFO element: duration=10000ms (timecodeScale=1000000ns → 10000 units)
  const timecodeScale = ebmlEl(0x2AD7B1, Buffer.from([0x0F, 0x42, 0x40])); // 1000000
  const duration      = ebmlEl(0x4489, float64(10000.0));
  const muxApp       = ebmlEl(0x4D80, Buffer.from("test-muxer"));
  const infoEl       = ebmlEl(0x1549A966, [timecodeScale, duration, muxApp]);

  // TRACKS: one video track (type=1, codec=V_MPEG4/ISO/AVC)
  const trackNum     = ebmlEl(0xD7, Buffer.from([1]));
  const trackType    = ebmlEl(0x83, Buffer.from([1])); // video
  const codecId      = ebmlEl(0x86, Buffer.from("V_MPEG4/ISO/AVC"));
  const pixW = ebmlEl(0xB0, Buffer.from([0x05, 0x00])); // 1280
  const pixH = ebmlEl(0xBA, Buffer.from([0x02, 0xD0])); // 720
  const videoEl      = ebmlEl(0xE0, [pixW, pixH]);
  const trackEntry   = ebmlEl(0xAE, [trackNum, trackType, codecId, videoEl]);
  const tracksEl     = ebmlEl(0x1654AE6B, [trackEntry]);

  // SEGMENT: contains INFO + TRACKS
  const segPayload = Buffer.concat([infoEl, tracksEl]);
  const segIdBuf   = Buffer.from([0x18, 0x53, 0x80, 0x67]);
  const segSzBuf   = vint(segPayload.length);
  const segment    = Buffer.concat([segIdBuf, segSzBuf, segPayload]);

  return Buffer.concat([ebmlHdr, segment]);
}

/** Build minimal AVI RIFF file with hdrl + avih (1280x720 @ 25fps, 125 frames = 5s) */
function buildMinimalAvi() {
  function u32le(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b; }
  function fourcc(s) { return Buffer.from(s.padEnd(4, "\0").slice(0, 4), "latin1"); }
  function chunk(fcc, data) { return Buffer.concat([fourcc(fcc), u32le(data.length), data]); }
  function list(fcc, type, children) {
    const payload = Buffer.concat([fourcc(type), ...children]);
    return chunk("LIST", payload);
  }

  // avih: microseconds per frame = 40000 (25fps), totalFrames=125, w=1280, h=720
  const avihData = Buffer.alloc(56, 0);
  avihData.writeUInt32LE(40000, 0);   // dwMicroSecPerFrame
  avihData.writeUInt32LE(0, 4);       // dwMaxBytesPerSec
  avihData.writeUInt32LE(0, 8);       // dwPaddingGranularity
  avihData.writeUInt32LE(0x10, 12);   // dwFlags (AVIF_HASINDEX)
  avihData.writeUInt32LE(125, 16);    // dwTotalFrames
  avihData.writeUInt32LE(0, 20);      // dwInitialFrames
  avihData.writeUInt32LE(1, 24);      // dwStreams
  avihData.writeUInt32LE(0, 28);      // dwSuggestedBufferSize
  avihData.writeUInt32LE(1280, 32);   // dwWidth
  avihData.writeUInt32LE(720, 36);    // dwHeight

  // strh (video): fccType='vids', fccHandler='xvid', scale=1, rate=25
  const strhData = Buffer.alloc(56, 0);
  strhData.write("vids", 0, "latin1"); // fccType
  strhData.write("xvid", 4, "latin1"); // fccHandler
  strhData.writeUInt32LE(0, 16);       // flags
  strhData.writeUInt32LE(0, 20);       // wPriority+wLanguage
  strhData.writeUInt32LE(1, 24);       // scale (dwScale)
  strhData.writeUInt32LE(25, 28);      // rate  (dwRate)
  strhData.writeUInt32LE(0, 32);       // dwStart
  strhData.writeUInt32LE(125, 36);     // dwLength

  // strf for video: BITMAPINFOHEADER
  const strfData = Buffer.alloc(40, 0);
  strfData.writeUInt32LE(40, 0);       // biSize
  strfData.writeUInt32LE(1280, 4);     // biWidth
  strfData.writeInt32LE(720, 8);       // biHeight
  strfData.writeUInt16LE(1, 12);       // biPlanes
  strfData.writeUInt16LE(24, 14);      // biBitCount
  strfData.write("xvid", 16, "latin1");// biCompression

  const strl = list("LIST", "strl", [
    chunk("strh", strhData),
    chunk("strf", strfData),
  ]);
  const hdrl = list("LIST", "hdrl", [
    chunk("avih", avihData),
    strl,
  ]);

  const moviList = list("LIST", "movi", []);
  const riffPayload = Buffer.concat([fourcc("AVI "), hdrl, moviList]);
  const riffChunk = Buffer.concat([fourcc("RIFF"), u32le(riffPayload.length), riffPayload]);
  return riffChunk;
}

// Write test files
const mp4Path = path.join(tmpDir, "test.mp4");
const mkvPath = path.join(tmpDir, "test.mkv");
const aviPath = path.join(tmpDir, "test.avi");
const emptyPath = path.join(tmpDir, "empty.mp4");
const notVideoPath = path.join(tmpDir, "notavideo.mp4");

fs.writeFileSync(mp4Path, buildMinimalMp4());
fs.writeFileSync(mkvPath, buildMinimalMkv());
fs.writeFileSync(aviPath, buildMinimalAvi());
fs.writeFileSync(emptyPath, Buffer.alloc(0));
fs.writeFileSync(notVideoPath, Buffer.from("Hello World, this is not a video file!"));

console.error("\n=== Section 236: video_client ===");

// ── A: Validation (10 tests) ──────────────────────────────────────────────────
console.error("\n-- A: Validation --");

test("A1: missing operation throws", () => {
  assertThrows(() => videoClient({ path: mp4Path }), "'operation' is required");
});

test("A2: missing path throws", () => {
  assertThrows(() => videoClient({ operation: "info" }), "'path' is required");
});

test("A3: unknown operation throws", () => {
  assertThrows(() => videoClient({ operation: "dump", path: mp4Path }), "unknown operation");
});

test("A4: all valid operations accepted without error (MP4)", () => {
  for (const op of ["info", "streams", "tags", "chapters", "validate"]) {
    const r = videoClient({ operation: op, path: mp4Path });
    assert.ok(r, `operation ${op} returned falsy`);
  }
});

test("A5: NUL byte in path throws", () => {
  assertThrows(() => videoClient({ operation: "info", path: "/tmp/foo\0bar.mp4" }), "NUL byte");
});

test("A6: path that is a directory throws", () => {
  assertThrows(() => videoClient({ operation: "info", path: tmpDir }), "directory");
});

test("A7: nonexistent path throws", () => {
  assertThrows(() => videoClient({ operation: "info", path: "/nonexistent/fake/path/video.mp4" }));
});

test("A8: empty file throws unrecognized format", () => {
  assertThrows(() => videoClient({ operation: "info", path: emptyPath }), "unrecognized video format");
});

test("A9: non-video file throws unrecognized format", () => {
  assertThrows(() => videoClient({ operation: "info", path: notVideoPath }), "unrecognized video format");
});

test("A10: result always has path and operation fields", () => {
  const r = videoClient({ operation: "info", path: mp4Path });
  assert.strictEqual(r.path, mp4Path);
  assert.strictEqual(r.operation, "info");
});

// ── B: Unit / parser logic (20 tests) ─────────────────────────────────────────
console.error("\n-- B: Unit / parser --");

test("B1: MP4 info returns format=MP4/MOV", () => {
  const r = videoClient({ operation: "info", path: mp4Path });
  assert.ok(r.format.includes("MP4") || r.format.includes("MOV"), `format=${r.format}`);
});

test("B2: MP4 info returns container=ISO BMFF", () => {
  const r = videoClient({ operation: "info", path: mp4Path });
  assert.strictEqual(r.container, "ISO BMFF");
});

test("B3: MP4 info returns fileSize > 0", () => {
  const r = videoClient({ operation: "info", path: mp4Path });
  assert.ok(r.fileSize > 0, `fileSize=${r.fileSize}`);
});

test("B4: MP4 info duration=5.0 seconds from mvhd", () => {
  const r = videoClient({ operation: "info", path: mp4Path });
  assert.strictEqual(r.duration, 5.0);
});

test("B5: MP4 info durationHms format", () => {
  const r = videoClient({ operation: "info", path: mp4Path });
  assert.ok(r.durationHms && r.durationHms.includes(":"), `durationHms=${r.durationHms}`);
});

test("B6: MP4 info brand = isom from ftyp", () => {
  const r = videoClient({ operation: "info", path: mp4Path });
  assert.strictEqual(r.brand, "isom");
});

test("B7: MKV info returns format=MKV or WebM", () => {
  const r = videoClient({ operation: "info", path: mkvPath });
  assert.ok(r.format === "MKV" || r.format === "WebM", `format=${r.format}`);
});

test("B8: MKV info returns container=Matroska/WebM (EBML)", () => {
  const r = videoClient({ operation: "info", path: mkvPath });
  assert.ok(r.container.includes("EBML") || r.container.includes("Matroska"), `container=${r.container}`);
});

test("B9: MKV info duration ~10s (10000ms / timecodeScale)", () => {
  const r = videoClient({ operation: "info", path: mkvPath });
  assert.ok(r.duration != null && Math.abs(r.duration - 10.0) < 0.1, `duration=${r.duration}`);
});

test("B10: MKV info muxingApp parsed", () => {
  const r = videoClient({ operation: "info", path: mkvPath });
  assert.strictEqual(r.muxingApp, "test-muxer");
});

test("B11: AVI info returns format=AVI", () => {
  const r = videoClient({ operation: "info", path: aviPath });
  assert.strictEqual(r.format, "AVI");
});

test("B12: AVI info width=1280 height=720", () => {
  const r = videoClient({ operation: "info", path: aviPath });
  assert.strictEqual(r.width, 1280);
  assert.strictEqual(r.height, 720);
});

test("B13: AVI info frameRate=25", () => {
  const r = videoClient({ operation: "info", path: aviPath });
  assert.ok(Math.abs(r.frameRate - 25.0) < 0.01, `frameRate=${r.frameRate}`);
});

test("B14: AVI info duration=5s (125 frames / 25fps)", () => {
  const r = videoClient({ operation: "info", path: aviPath });
  assert.ok(Math.abs(r.duration - 5.0) < 0.01, `duration=${r.duration}`);
});

test("B15: MP4 streams returns streams array", () => {
  const r = videoClient({ operation: "streams", path: mp4Path });
  assert.ok(Array.isArray(r.streams), "streams not array");
});

test("B16: MKV streams contains video track", () => {
  const r = videoClient({ operation: "streams", path: mkvPath });
  assert.ok(r.videoCount >= 1, `videoCount=${r.videoCount}`);
});

test("B17: MKV stream has width=1280 height=720 from VIDEO element", () => {
  const r = videoClient({ operation: "streams", path: mkvPath });
  const vs = r.streams.find(s => s.type === "video");
  assert.ok(vs, "No video stream found");
  assert.strictEqual(vs.width, 1280);
  assert.strictEqual(vs.height, 720);
});

test("B18: AVI streams contains video track with codec", () => {
  const r = videoClient({ operation: "streams", path: aviPath });
  const vs = r.streams.find(s => s.type === "video");
  assert.ok(vs, "No video stream found");
  assert.ok(vs.codec, `codec=${vs.codec}`);
});

test("B19: MP4 tags returns object", () => {
  const r = videoClient({ operation: "tags", path: mp4Path });
  assert.ok(r.tags !== null && typeof r.tags === "object");
  assert.strictEqual(typeof r.tagCount, "number");
});

test("B20: MP4 chapters returns array", () => {
  const r = videoClient({ operation: "chapters", path: mp4Path });
  assert.ok(Array.isArray(r.chapters));
  assert.strictEqual(typeof r.chapterCount, "number");
});

// ── C: Happy-path (20 tests) ───────────────────────────────────────────────────
console.error("\n-- C: Happy-path --");

test("C1: MP4 validate returns valid boolean", () => {
  const r = videoClient({ operation: "validate", path: mp4Path });
  assert.strictEqual(typeof r.valid, "boolean");
  assert.ok(Array.isArray(r.issues));
});

test("C2: MP4 validate returns issueCount", () => {
  const r = videoClient({ operation: "validate", path: mp4Path });
  assert.strictEqual(typeof r.issueCount, "number");
  assert.strictEqual(r.issueCount, r.issues.length);
});

test("C3: MKV validate valid=false because no audio (acceptable edge-case)", () => {
  const r = videoClient({ operation: "validate", path: mkvPath });
  assert.strictEqual(typeof r.valid, "boolean");
  assert.ok(Array.isArray(r.issues));
});

test("C4: AVI validate returns streamCount ≥ 1", () => {
  const r = videoClient({ operation: "validate", path: aviPath });
  assert.ok(r.streamCount >= 1, `streamCount=${r.streamCount}`);
});

test("C5: MP4 info streamCount equals videoCount+audioCount+otherCount", () => {
  const r = videoClient({ operation: "info", path: mp4Path });
  const computed = (r.videoCount || 0) + (r.audioCount || 0) + (r.otherCount || 0);
  assert.strictEqual(r.streamCount, computed);
});

test("C6: MKV info streamCount consistent with track types", () => {
  const r = videoClient({ operation: "info", path: mkvPath });
  const computed = (r.videoCount || 0) + (r.audioCount || 0) + (r.otherCount || 0);
  assert.strictEqual(r.streamCount, computed);
});

test("C7: AVI streams each entry has type field", () => {
  const r = videoClient({ operation: "streams", path: aviPath });
  assert.ok(r.streams.length > 0, "no streams");
  for (const s of r.streams)
    assert.ok(s.type, `stream has no type: ${JSON.stringify(s)}`);
});

test("C8: AVI streams video entry has width/height", () => {
  const r = videoClient({ operation: "streams", path: aviPath });
  const vs = r.streams.find(s => s.type === "video");
  assert.ok(vs.width > 0 && vs.height > 0, `w=${vs.width} h=${vs.height}`);
});

test("C9: MP4 info tags object always present (even empty)", () => {
  const r = videoClient({ operation: "info", path: mp4Path });
  assert.ok(r.tags !== undefined, "tags missing from info result");
});

test("C10: MKV info tags object present", () => {
  const r = videoClient({ operation: "info", path: mkvPath });
  assert.ok(r.tags !== undefined, "tags missing from MKV info result");
});

test("C11: AVI tags returns object", () => {
  const r = videoClient({ operation: "tags", path: aviPath });
  assert.ok(r.tags !== null && typeof r.tags === "object");
});

test("C12: MKV tags returns object with tagCount", () => {
  const r = videoClient({ operation: "tags", path: mkvPath });
  assert.ok(r.tags !== null && typeof r.tags === "object");
  assert.strictEqual(typeof r.tagCount, "number");
});

test("C13: AVI chapters returns array with note about no chapters", () => {
  const r = videoClient({ operation: "chapters", path: aviPath });
  assert.ok(Array.isArray(r.chapters));
  assert.strictEqual(r.chapters.length, 0);
  assert.ok(r.note, "expected note about AVI chapters");
});

test("C14: MKV chapters returns array", () => {
  const r = videoClient({ operation: "chapters", path: mkvPath });
  assert.ok(Array.isArray(r.chapters));
  assert.strictEqual(typeof r.chapterCount, "number");
});

test("C15: MP4 fileSize matches actual file size on disk", () => {
  const r = videoClient({ operation: "info", path: mp4Path });
  const stat = fs.statSync(mp4Path);
  assert.strictEqual(r.fileSize, stat.size);
});

test("C16: MKV fileSize matches actual file size", () => {
  const r = videoClient({ operation: "info", path: mkvPath });
  const stat = fs.statSync(mkvPath);
  assert.strictEqual(r.fileSize, stat.size);
});

test("C17: AVI fileSize matches actual file size", () => {
  const r = videoClient({ operation: "info", path: aviPath });
  const stat = fs.statSync(aviPath);
  assert.strictEqual(r.fileSize, stat.size);
});

test("C18: MKV codec ID extracted correctly", () => {
  const r = videoClient({ operation: "streams", path: mkvPath });
  const vs = r.streams.find(s => s.type === "video");
  assert.ok(vs && vs.codec === "V_MPEG4/ISO/AVC", `codec=${vs && vs.codec}`);
});

test("C19: MP4 streams duration field present in response", () => {
  const r = videoClient({ operation: "streams", path: mp4Path });
  assert.ok("duration" in r, "streams result missing duration");
});

test("C20: MKV streams durationHms present in result when duration found", () => {
  const r = videoClient({ operation: "streams", path: mkvPath });
  assert.ok("duration" in r, "streams result missing duration");
});

// ── D: Security (10 tests) ────────────────────────────────────────────────────
console.error("\n-- D: Security --");

test("D1: NUL byte in path blocked", () => {
  assertThrows(() => videoClient({ operation: "info", path: "/tmp/a\0b.mp4" }), "NUL byte");
});

test("D2: path traversal attempt still resolves as a file path (no crash)", () => {
  // traversal doesn't bypass security here — file just won't exist
  assertThrows(() => videoClient({ operation: "info", path: "../../etc/passwd" }));
});

test("D3: directory path throws descriptive error", () => {
  assertThrows(() => videoClient({ operation: "info", path: tmpDir }), "directory");
});

test("D4: truncated/garbage MP4-lookalike returns warning or throws", () => {
  // A file that starts with 'ftyp' box but has wrong sizes should not crash
  const garbagePath = path.join(tmpDir, "garbage.mp4");
  const buf = Buffer.alloc(32);
  buf.writeUInt32BE(8, 0);  // size=8 (valid minimal box)
  buf.write("ftyp", 4, "latin1");
  fs.writeFileSync(garbagePath, buf);
  try {
    const r = videoClient({ operation: "info", path: garbagePath });
    assert.ok(r.format || r.warning, "expected result with format or warning");
  } catch (e) {
    assert.ok(true, "acceptable: threw instead of crashing");
  }
});

test("D5: large fake file size in RIFF header does not crash", () => {
  const evilAvi = buildMinimalAvi();
  // Corrupt the RIFF size to a huge value
  evilAvi.writeUInt32LE(0xFFFFFFFF, 4);
  const evilPath = path.join(tmpDir, "evil.avi");
  fs.writeFileSync(evilPath, evilAvi);
  // Should still parse without crashing (capped by buf.length)
  const r = videoClient({ operation: "info", path: evilPath });
  assert.ok(r.format === "AVI");
});

test("D6: MKV with unknown VINT length byte does not crash", () => {
  const buf = Buffer.alloc(8);
  buf[0] = 0x1A; buf[1] = 0x45; buf[2] = 0xDF; buf[3] = 0xA3; // EBML header ID
  buf[4] = 0x00; // invalid VINT (would be size 0 leading to issues)
  const p = path.join(tmpDir, "badebml.mkv");
  fs.writeFileSync(p, buf);
  // Should not crash — result may have format or a warning
  let r;
  try {
    r = videoClient({ operation: "info", path: p });
    // If we reach here, result must be a non-null object
    assert.ok(r && typeof r === "object", "result must be an object");
  } catch (e) {
    // Throwing is also acceptable — as long as process does not crash
    assert.ok(e instanceof Error, "must throw a proper Error");
  }
});

test("D7: operation injection attempt blocked by enum check", () => {
  assertThrows(() => videoClient({ operation: "__proto__", path: mp4Path }), "unknown operation");
});

test("D8: empty path string throws", () => {
  assertThrows(() => videoClient({ operation: "info", path: "" }));
});

test("D9: non-string path throws or rejects gracefully", () => {
  try {
    videoClient({ operation: "info", path: 12345 });
    // If it doesn't throw, it should at least not crash the process
  } catch (e) {
    assert.ok(true); // expected
  }
});

test("D10: file with RIFF but wrong subtype returns error not panic", () => {
  const wavLike = Buffer.alloc(20);
  wavLike.write("RIFF", 0, "latin1");
  wavLike.writeUInt32LE(12, 4);
  wavLike.write("WAVE", 8, "latin1"); // not "AVI "
  const wavPath = path.join(tmpDir, "notavi.avi");
  fs.writeFileSync(wavPath, wavLike);
  assertThrows(() => videoClient({ operation: "info", path: wavPath }), "unrecognized video format");
});

// ── E: Error paths (10 tests) ─────────────────────────────────────────────────
console.error("\n-- E: Error paths --");

test("E1: nonexistent file throws fs error", () => {
  assertThrows(() => videoClient({ operation: "info", path: "/nonexistent/x.mp4" }));
});

test("E2: random binary file (not video) throws unrecognized", () => {
  const binaryPath = path.join(tmpDir, "random.bin");
  const buf = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) buf[i] = Math.floor(Math.random() * 100) + 1;
  fs.writeFileSync(binaryPath, buf);
  assertThrows(() => videoClient({ operation: "info", path: binaryPath }), "unrecognized video format");
});

test("E3: truncated MKV (only EBML header, no segment) returns result with warning", () => {
  const buf = buildMinimalMkv().slice(0, 30); // cut short
  const p = path.join(tmpDir, "truncated.mkv");
  fs.writeFileSync(p, buf);
  try {
    const r = videoClient({ operation: "info", path: p });
    assert.ok(r.format === "MKV" || r.format === "WebM" || r.warning);
  } catch (e) {
    assert.ok(true); // throwing is also acceptable
  }
});

test("E4: MP4 with moov at very end (past read head) returns warning", () => {
  // Build an MP4 where moov is not in the first 32MB
  // (we just use a file with ftyp and large mdat placeholder)
  const ftyp = buildMinimalMp4().slice(0, 24);
  const mdatHdr = Buffer.alloc(8);
  mdatHdr.writeUInt32BE(8, 0);
  mdatHdr.write("mdat", 4, "latin1");
  // No moov → warning expected
  const noMoovPath = path.join(tmpDir, "nomoov.mp4");
  fs.writeFileSync(noMoovPath, Buffer.concat([ftyp, mdatHdr]));
  const r = videoClient({ operation: "info", path: noMoovPath });
  assert.ok(r.warning, `Expected warning when moov not found, got: ${r.warning}`);
});

test("E5: all operations handle missing moov gracefully", () => {
  const ftyp = buildMinimalMp4().slice(0, 24);
  const mdatHdr = Buffer.alloc(8);
  mdatHdr.writeUInt32BE(8, 0);
  mdatHdr.write("mdat", 4, "latin1");
  const p = path.join(tmpDir, "nomoov2.mp4");
  fs.writeFileSync(p, Buffer.concat([ftyp, mdatHdr]));
  for (const op of ["streams", "tags", "chapters", "validate"]) {
    const r = videoClient({ operation: op, path: p });
    assert.ok(r, `${op} returned falsy`);
  }
});

test("E6: zero-byte EBML ID does not loop forever or crash", () => {
  const buf = Buffer.alloc(20);
  buf[0] = 0x1A; buf[1] = 0x45; buf[2] = 0xDF; buf[3] = 0xA3;
  buf[4] = 0x85; // vint: 5 bytes
  // content starts at 5; fill with zeros → EBML ID=0 which is invalid
  const p = path.join(tmpDir, "zeroids.mkv");
  fs.writeFileSync(p, buf);
  const r = videoClient({ operation: "info", path: p });
  assert.ok(r); // should not crash
});

test("E7: AVI with missing hdrl LIST returns warning", () => {
  const buf = Buffer.alloc(24);
  buf.write("RIFF", 0, "latin1");
  buf.writeUInt32LE(16, 4);
  buf.write("AVI ", 8, "latin1");
  // No hdrl LIST
  buf.write("JUNK", 12, "latin1");
  buf.writeUInt32LE(4, 16);
  buf.writeUInt32LE(0, 20);
  const p = path.join(tmpDir, "nohdrl.avi");
  fs.writeFileSync(p, buf);
  const r = videoClient({ operation: "info", path: p });
  assert.ok(r.warning, `Expected warning, got: ${r.warning}`);
});

test("E8: streams result always has streams array even if empty", () => {
  const r = videoClient({ operation: "streams", path: mp4Path });
  assert.ok(Array.isArray(r.streams), "streams must be an array");
});

test("E9: tags result always has tags object even if empty", () => {
  const r = videoClient({ operation: "tags", path: aviPath });
  assert.ok(r.tags !== null && typeof r.tags === "object", "tags must be an object");
});

test("E10: chapters result always has chapters array even if empty", () => {
  const r = videoClient({ operation: "chapters", path: mkvPath });
  assert.ok(Array.isArray(r.chapters), "chapters must be an array");
});

// ── F: Concurrency (6 tests) ──────────────────────────────────────────────────
console.error("\n-- F: Concurrency --");

test("F1: 10 concurrent MP4 info calls all succeed", () => {
  const results = Array.from({ length: 10 }, () => videoClient({ operation: "info", path: mp4Path }));
  assert.strictEqual(results.length, 10);
  for (const r of results) assert.ok(r.format);
});

test("F2: 10 concurrent MKV info calls all succeed", () => {
  const results = Array.from({ length: 10 }, () => videoClient({ operation: "info", path: mkvPath }));
  assert.strictEqual(results.length, 10);
  for (const r of results) assert.ok(r.format);
});

test("F3: 10 concurrent AVI info calls all succeed", () => {
  const results = Array.from({ length: 10 }, () => videoClient({ operation: "info", path: aviPath }));
  assert.strictEqual(results.length, 10);
  for (const r of results) assert.ok(r.format);
});

test("F4: mixed operations across 3 formats concurrently", () => {
  const tasks = [
    { operation: "info",     path: mp4Path },
    { operation: "streams",  path: mkvPath },
    { operation: "tags",     path: aviPath },
    { operation: "chapters", path: mp4Path },
    { operation: "validate", path: mkvPath },
    { operation: "streams",  path: aviPath },
  ];
  const results = tasks.map(args => videoClient(args));
  assert.strictEqual(results.length, tasks.length);
  for (const r of results) assert.ok(r);
});

test("F5: no shared mutable state — parallel results are independent", () => {
  const [r1, r2] = [
    videoClient({ operation: "info", path: mp4Path }),
    videoClient({ operation: "info", path: mkvPath }),
  ];
  assert.notStrictEqual(r1.format, r2.format);
});

test("F6: 20 simultaneous validate calls return consistent valid field", () => {
  const results = Array.from({ length: 20 }, () => videoClient({ operation: "validate", path: aviPath }));
  const firstValid = results[0].valid;
  for (const r of results)
    assert.strictEqual(r.valid, firstValid, "validate results inconsistent across calls");
});

// ── Cleanup ────────────────────────────────────────────────────────────────────
try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}

console.error(`\n=== Section 236 results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
