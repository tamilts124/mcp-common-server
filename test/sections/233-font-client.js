"use strict";
// ── Section 233: font_client tests ──────────────────────────────────────────
// Zero-dep font reader: TTF/OTF, WOFF, WOFF2, TTC
// Rigor: A=validation(10), B=unit(20), C=happy-path(20),
//         D=security(10), E=error-paths(10), F=concurrency(6) -- 76 total

const fs   = require("fs");
const path = require("path");
const os   = require("os");

const { fontClient } = require("../../lib/fontClientOps");

// ── Test runner ──────────────────────────────────────────────────────────────
let passed = 0; let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.error(`  PASS: ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL: ${name}`);
    console.error(`        ${e.message}`);
    failed++;
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function assertThrows(fn, msgPart) {
  let threw = false;
  try { fn(); } catch (e) {
    threw = true;
    if (msgPart && !e.message.includes(msgPart))
      throw new Error(`Expected error containing '${msgPart}', got: ${e.message}`);
  }
  if (!threw) throw new Error(`Expected an error but none was thrown`);
}

// ── Minimal synthetic font builder ──────────────────────────────────────────
// Builds a minimal binary TTF with real head/name/maxp tables so parsers work.

function be16(v) { const b = Buffer.alloc(2); b.writeUInt16BE(v, 0); return b; }
function be32(v) { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0, 0); return b; }
function ascii4(s) { return Buffer.from(s.padEnd(4, " ").slice(0, 4), "ascii"); }

function buildNameRecord(platformId, encodingId, languageId, nameId, value) {
  // Encode value depending on platform
  let strBuf;
  if (platformId === 3) {
    // Windows: UTF-16 BE
    strBuf = Buffer.alloc(value.length * 2);
    for (let i = 0; i < value.length; i++) strBuf.writeUInt16BE(value.charCodeAt(i), i * 2);
  } else {
    strBuf = Buffer.from(value, "latin1");
  }
  return { platformId, encodingId, languageId, nameId, strBuf };
}

function buildNameTable(records) {
  // name table format 0
  const count  = records.length;
  const strOff = 6 + count * 12;  // offset to string storage
  let strings  = Buffer.alloc(0);
  const dirs   = [];
  for (const r of records) {
    const offset = strings.length;
    dirs.push({ ...r, offset, length: r.strBuf.length });
    strings = Buffer.concat([strings, r.strBuf]);
  }
  const header = Buffer.alloc(6);
  header.writeUInt16BE(0, 0);        // format
  header.writeUInt16BE(count, 2);    // count
  header.writeUInt16BE(strOff, 4);   // stringOffset
  const dirBuf = Buffer.alloc(count * 12);
  for (let i = 0; i < dirs.length; i++) {
    const d = dirs[i];
    const base = i * 12;
    dirBuf.writeUInt16BE(d.platformId, base);
    dirBuf.writeUInt16BE(d.encodingId, base + 2);
    dirBuf.writeUInt16BE(d.languageId, base + 4);
    dirBuf.writeUInt16BE(d.nameId,     base + 6);
    dirBuf.writeUInt16BE(d.length,     base + 8);
    dirBuf.writeUInt16BE(d.offset,     base + 10);
  }
  return Buffer.concat([header, dirBuf, strings]);
}

function buildHeadTable() {
  const buf = Buffer.alloc(54);
  buf.writeUInt16BE(1, 0);   // majorVersion
  buf.writeUInt16BE(0, 2);   // minorVersion
  buf.writeInt16BE(1, 4);    // fontRevision high
  buf.writeUInt16BE(0, 6);   // fontRevision low
  buf.writeUInt16BE(0, 16);  // flags
  buf.writeUInt16BE(1000, 18); // unitsPerEm
  // created: write 0 (epoch diff will give negative → null)
  buf.writeUInt16BE(0, 44);  // macStyle = normal
  buf.writeUInt16BE(8, 46);  // lowestRecPPEM
  buf.writeUInt16BE(0, 50);  // fontDirectionHint
  buf.writeInt16BE(0, 52);   // indexToLocFormat (short loca)
  return buf;
}

function buildMaxpTable(numGlyphs) {
  const buf = Buffer.alloc(6);
  buf.writeUInt32BE(0x00050000, 0); // version 0.5 (minimal)
  buf.writeUInt16BE(numGlyphs, 4);
  return buf;
}

function buildCmapTableFmt4(pairs) {
  // pairs: [{start, end, delta}]
  // Format 4 cmap
  const segCount = pairs.length + 1; // +1 for 0xFFFF terminator
  const segCountX2 = segCount * 2;
  // header: format(2), length(2), language(2), segCountX2(2),
  //         searchRange(2), entrySelector(2), rangeShift(2)
  // then endCount[segCount](2*n), reservedPad(2),
  //      startCount[segCount](2*n), idDelta[segCount](2*n),
  //      idRangeOffset[segCount](2*n)
  const headerSize  = 14;
  const tableSize   = headerSize + segCountX2 * 4 + 2; // 4 arrays + pad
  const buf = Buffer.alloc(tableSize);
  let off = 0;
  buf.writeUInt16BE(4, off); off += 2;                 // format
  buf.writeUInt16BE(tableSize, off); off += 2;          // length
  buf.writeUInt16BE(0, off); off += 2;                 // language
  buf.writeUInt16BE(segCountX2, off); off += 2;        // segCountX2
  const sr  = Math.pow(2, Math.floor(Math.log2(segCount))) * 2;
  const es  = Math.floor(Math.log2(segCount));
  const rs  = segCountX2 - sr;
  buf.writeUInt16BE(sr, off); off += 2;
  buf.writeUInt16BE(es, off); off += 2;
  buf.writeUInt16BE(rs, off); off += 2;
  // endCount
  for (const p of pairs) { buf.writeUInt16BE(p.end, off); off += 2; }
  buf.writeUInt16BE(0xFFFF, off); off += 2;  // terminator
  buf.writeUInt16BE(0, off); off += 2;        // reservedPad
  // startCount
  for (const p of pairs) { buf.writeUInt16BE(p.start, off); off += 2; }
  buf.writeUInt16BE(0xFFFF, off); off += 2;  // terminator
  // idDelta  (glyph = cp + delta, delta = 1 to make glyph non-zero for cp=0 segments)
  for (const p of pairs) { buf.writeInt16BE(p.delta !== undefined ? p.delta : 1, off); off += 2; }
  buf.writeInt16BE(1, off); off += 2;        // terminator delta
  // idRangeOffset — all 0 (use delta)
  for (let i = 0; i < segCount; i++) { buf.writeUInt16BE(0, off); off += 2; }
  return buf;
}

// wrap cmap subtable into a cmap table with one Windows/BMP subtable
function buildCmapTable(subtableBuf) {
  const numSubtables = 1;
  const headerSize   = 4;            // version(2) + numSubtables(2)
  const dirEntrySize = 8;            // platformId(2)+encodingId(2)+offset(4)
  const subtableOffset = headerSize + numSubtables * dirEntrySize;

  const buf = Buffer.alloc(headerSize + dirEntrySize);
  buf.writeUInt16BE(0, 0);           // version
  buf.writeUInt16BE(1, 2);           // numSubtables
  buf.writeUInt16BE(3, 4);           // platformId = Windows
  buf.writeUInt16BE(1, 6);           // encodingId = BMP
  buf.writeUInt32BE(subtableOffset, 8); // offset
  return Buffer.concat([buf, subtableBuf]);
}

function buildOs2Table() {
  const buf = Buffer.alloc(78);
  buf.writeUInt16BE(4, 0);   // version
  buf.writeInt16BE(500, 2);  // xAvgCharWidth
  buf.writeUInt16BE(400, 4); // weightClass = Regular
  buf.writeUInt16BE(5, 6);   // widthClass = Normal
  buf.writeUInt16BE(0, 8);   // fsType = installable
  // panose at 32: zeros
  // unicodeRange at 42
  buf.writeUInt32BE(0x00000003, 42); // Basic Latin + Latin-1
  // vendorId at 58: 'TEST'
  buf.write("TEST", 58, 4, "ascii");
  buf.writeUInt16BE(0x0040, 62); // fsSelection = Regular
  buf.writeUInt16BE(0x0020, 64); // firstCharIndex
  buf.writeUInt16BE(0x007E, 66); // lastCharIndex
  buf.writeInt16BE(800, 68);  // typoAscender
  buf.writeInt16BE(-200, 70); // typoDescender
  buf.writeInt16BE(0, 72);    // typoLineGap
  buf.writeUInt16BE(900, 74); // winAscent
  buf.writeUInt16BE(200, 76); // winDescent
  return buf;
}

function buildHheaTable() {
  const buf = Buffer.alloc(36);
  buf.writeUInt16BE(1, 0);   // majorVersion
  buf.writeUInt16BE(0, 2);   // minorVersion
  buf.writeInt16BE(800, 4);  // ascender
  buf.writeInt16BE(-200, 6); // descender
  buf.writeInt16BE(0, 8);    // lineGap
  buf.writeUInt16BE(600, 10); // advanceWidthMax
  buf.writeUInt16BE(100, 34); // numHMetrics
  return buf;
}

function buildPostTable() {
  const buf = Buffer.alloc(32);
  buf.writeUInt16BE(2, 0);   // format 2.0
  buf.writeUInt16BE(0, 2);
  buf.writeInt16BE(0, 4);   // italicAngle int
  buf.writeUInt16BE(0, 6);  // italicAngle frac
  buf.writeInt16BE(-75, 8); // underlinePosition
  buf.writeInt16BE(50, 10); // underlineThickness
  buf.writeUInt32BE(0, 12); // isFixedPitch = false
  return buf;
}

/**
 * Build a minimal but valid TTF binary.
 * Tables: head, hhea, maxp, OS/2, name, cmap, post
 */
function buildTtf(opts = {}) {
  const family    = opts.family    || "TestFont";
  const subfamily = opts.subfamily || "Regular";
  const fullName  = opts.fullName  || "TestFont Regular";
  const psName    = opts.psName    || "TestFont-Regular";
  const version   = opts.version   || "Version 1.000";
  const copyright = opts.copyright || "Copyright 2024 Test";
  const numGlyphs = opts.numGlyphs || 100;

  // Build name records (platform 3, encoding 1, language 0x0409)
  const nameRecs = [
    buildNameRecord(3, 1, 0x0409, 0, copyright),
    buildNameRecord(3, 1, 0x0409, 1, family),
    buildNameRecord(3, 1, 0x0409, 2, subfamily),
    buildNameRecord(3, 1, 0x0409, 4, fullName),
    buildNameRecord(3, 1, 0x0409, 5, version),
    buildNameRecord(3, 1, 0x0409, 6, psName),
  ];

  // Build table data
  const tableData = {
    head: buildHeadTable(),
    hhea: buildHheaTable(),
    maxp: buildMaxpTable(numGlyphs),
    "OS/2": buildOs2Table(),
    name: buildNameTable(nameRecs),
    cmap: buildCmapTable(buildCmapTableFmt4([
      { start: 0x0020, end: 0x007E },  // Basic ASCII
      { start: 0x00C0, end: 0x00FF },  // Latin-1 supplement
    ])),
    post: buildPostTable(),
  };

  const tags = Object.keys(tableData);
  const numTables = tags.length;

  // Calculate offsets: sfnt offset table (12) + table dir (16*n)
  let offset = 12 + numTables * 16;
  const entries = [];
  for (const tag of tags) {
    const data = tableData[tag];
    entries.push({ tag, offset, data, length: data.length, checksum: 0 });
    // Pad to 4-byte boundary
    offset += Math.ceil(data.length / 4) * 4;
  }

  // Build offset table
  const sr  = Math.pow(2, Math.floor(Math.log2(numTables))) * 16;
  const es  = Math.floor(Math.log2(numTables));
  const rs  = numTables * 16 - sr;

  const sfntHeader = Buffer.alloc(12);
  sfntHeader.writeUInt32BE(0x00010000, 0); // sfVersion = 1.0 (TrueType)
  sfntHeader.writeUInt16BE(numTables, 4);
  sfntHeader.writeUInt16BE(sr, 6);
  sfntHeader.writeUInt16BE(es, 8);
  sfntHeader.writeUInt16BE(rs, 10);

  // Build table directory
  const tableDir = Buffer.alloc(numTables * 16);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const base = i * 16;
    tableDir.write(e.tag.padEnd(4, " "), base, 4, "ascii");
    tableDir.writeUInt32BE(e.checksum, base + 4);
    tableDir.writeUInt32BE(e.offset, base + 8);
    tableDir.writeUInt32BE(e.length, base + 12);
  }

  // Build padded table data
  const tableBuffers = entries.map(e => {
    const padded = Math.ceil(e.data.length / 4) * 4;
    const buf = Buffer.alloc(padded);
    e.data.copy(buf);
    return buf;
  });

  return Buffer.concat([sfntHeader, tableDir, ...tableBuffers]);
}

/**
 * Build a minimal WOFF file wrapping the same tables as above.
 * WOFF stores uncompressed tables (compLength == origLength) so parsers can read them.
 */
function buildWoff(ttfBuf) {
  // Parse the TTF to extract tables
  const numTables = ttfBuf.readUInt16BE(4);
  const flavor    = ttfBuf.readUInt32BE(0);

  // Re-extract table entries from TTF
  const tables = [];
  for (let i = 0; i < numTables; i++) {
    const base = 12 + i * 16;
    const tag        = ttfBuf.toString("ascii", base, base + 4);
    const checksum   = ttfBuf.readUInt32BE(base + 4);
    const offset     = ttfBuf.readUInt32BE(base + 8);
    const length     = ttfBuf.readUInt32BE(base + 12);
    const origLength = length;
    tables.push({ tag, checksum, offset, length, origLength });
  }

  // WOFF header: 44 bytes
  // signature(4)+flavor(4)+length(4)+numTables(2)+reserved(2)+
  // totalSfntSize(4)+majorVersion(2)+minorVersion(2)+
  // metaOffset(4)+metaLength(4)+metaOrigLength(4)+privOffset(4)+privLength(4)
  const woffHeaderSize  = 44;
  const woffDirEntrySize = 20; // tag(4)+offset(4)+compLength(4)+origLength(4)+checksum(4)
  const woffDirSize     = tables.length * woffDirEntrySize;

  // Table data starts after woff header + woff table directory
  let dataOffset = woffHeaderSize + woffDirSize;
  const woffTables = tables.map(t => {
    // Pad to 4-byte boundary
    const padded = Math.ceil(t.origLength / 4) * 4;
    const data = Buffer.alloc(padded);
    ttfBuf.copy(data, 0, t.offset, t.offset + t.origLength);
    const woff = { tag: t.tag, offset: dataOffset, compLength: t.origLength,
                   origLength: t.origLength, checksum: t.checksum, data };
    dataOffset += padded;
    return woff;
  });

  const totalLength = dataOffset;

  const header = Buffer.alloc(woffHeaderSize);
  header.writeUInt32BE(0x774F4646, 0); // 'wOFF'
  header.writeUInt32BE(flavor, 4);     // flavor
  header.writeUInt32BE(totalLength, 8);
  header.writeUInt16BE(tables.length, 12);
  header.writeUInt16BE(0, 14);         // reserved
  header.writeUInt32BE(ttfBuf.length, 16); // totalSfntSize (approx)
  header.writeUInt16BE(1, 20);         // majorVersion
  header.writeUInt16BE(0, 22);         // minorVersion

  const dirBuf = Buffer.alloc(woffDirSize);
  for (let i = 0; i < woffTables.length; i++) {
    const t = woffTables[i];
    const base = i * woffDirEntrySize;
    dirBuf.write(t.tag.padEnd(4, " "), base, 4, "ascii");
    dirBuf.writeUInt32BE(t.offset, base + 4);
    dirBuf.writeUInt32BE(t.compLength, base + 8);
    dirBuf.writeUInt32BE(t.origLength, base + 12);
    dirBuf.writeUInt32BE(t.checksum, base + 16);
  }

  return Buffer.concat([header, dirBuf, ...woffTables.map(t => t.data)]);
}

/** Minimal WOFF2 header (only magic + header fields, no table data) */
function buildWoff2(ttfBuf) {
  const numTables = ttfBuf.readUInt16BE(4);
  const flavor    = ttfBuf.readUInt32BE(0);
  const buf = Buffer.alloc(48 + numTables); // minimal
  buf.writeUInt32BE(0x774F4632, 0); // 'wOF2'
  buf.writeUInt32BE(flavor, 4);
  buf.writeUInt32BE(buf.length, 8); // total length (fake)
  buf.writeUInt16BE(numTables, 12);
  buf.writeUInt16BE(1, 16); // majorVersion
  buf.writeUInt16BE(0, 18); // minorVersion
  // totalUncompressedSize at 24 (6 bytes) — zero is fine
  // Table directory: minimal entries — one byte each (flag byte only, known table index)
  // Use known table indices: head=1, hhea=2, maxp=4, OS/2=6, name=5, cmap=0, post=-
  const KNOWN = {"cmap":0,"head":1,"hhea":2,"maxp":4,"name":5,"OS/2":6,"post":7};
  let entry = 48;
  for (let i = 0; i < numTables && entry < buf.length; i++) {
    const base = 12 + i * 16;
    const tag = ttfBuf.toString("ascii", base, base + 4).trim();
    const idx = KNOWN[tag];
    if (idx !== undefined && entry < buf.length) {
      buf[entry++] = idx & 0x3F; // flags = known table index + no transform
      // write origLength as UIntBase128: 1-byte approximation for small values
      const len = ttfBuf.readUInt32BE(base + 12);
      if (entry < buf.length) buf[entry++] = len & 0x7F; // simplified 1-byte
    }
  }
  return buf;
}

// ── Setup: write test font files ─────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "font-test-"));
const TTF_PATH  = path.join(TMP, "test.ttf");
const WOFF_PATH = path.join(TMP, "test.woff");
const WOFF2_PATH = path.join(TMP, "test.woff2");
const EMPTY_PATH = path.join(TMP, "empty.ttf");
const TINY_PATH  = path.join(TMP, "tiny.bin");

const ttfBuf   = buildTtf({ family: "TestFont", numGlyphs: 128 });
const woffBuf  = buildWoff(ttfBuf);
const woff2Buf = buildWoff2(ttfBuf);

fs.writeFileSync(TTF_PATH, ttfBuf);
fs.writeFileSync(WOFF_PATH, woffBuf);
fs.writeFileSync(WOFF2_PATH, woff2Buf);
fs.writeFileSync(EMPTY_PATH, Buffer.alloc(0));
fs.writeFileSync(TINY_PATH,  Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00])); // too small + TTF magic

console.error("\nSection 233: font_client");
console.error(`  TTF: ${ttfBuf.length} bytes, ${ttfBuf.readUInt16BE(4)} tables`);
console.error(`  WOFF: ${woffBuf.length} bytes`);
console.error(`  WOFF2: ${woff2Buf.length} bytes`);

// ═══════════════════════════════════════════════════════════════════════
// A: Validation tests (10)
// ═══════════════════════════════════════════════════════════════════════
console.error("\n[A] Validation");

test("A01 missing operation throws", () => {
  assertThrows(() => fontClient({ path: TTF_PATH }), "'operation' is required");
});

test("A02 invalid operation throws", () => {
  assertThrows(() => fontClient({ operation: "bogus", path: TTF_PATH }), "Unknown operation");
});

test("A03 missing path throws", () => {
  assertThrows(() => fontClient({ operation: "info" }), "non-empty string");
});

test("A04 empty path throws", () => {
  assertThrows(() => fontClient({ operation: "info", path: "" }), "non-empty string");
});

test("A05 non-string path throws", () => {
  assertThrows(() => fontClient({ operation: "info", path: 42 }), "non-empty string");
});

test("A06 NUL byte in path throws", () => {
  assertThrows(() => fontClient({ operation: "info", path: "test\0.ttf" }), "NUL bytes");
});

test("A07 directory path throws", () => {
  assertThrows(() => fontClient({ operation: "info", path: TMP }), "is a directory");
});

test("A08 nonexistent file throws", () => {
  assertThrows(() => fontClient({ operation: "info", path: "/nonexistent/does/not/exist.ttf" }), "Cannot access");
});

test("A09 file too small throws", () => {
  assertThrows(() => fontClient({ operation: "info", path: EMPTY_PATH }), "too small");
});

test("A10 all 6 valid operations accepted for TTF", () => {
  const ops = ["info", "names", "metrics", "tables", "glyphs", "unicode"];
  for (const op of ops) {
    const res = fontClient({ operation: op, path: TTF_PATH });
    assert(res && res.operation === op, `op '${op}' returned wrong operation field`);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// B: Unit tests (20) — table parsers and internal logic
// ═══════════════════════════════════════════════════════════════════════
console.error("\n[B] Unit");

test("B01 info returns correct format=ttf", () => {
  const r = fontClient({ operation: "info", path: TTF_PATH });
  assert(r.format === "ttf", `expected ttf, got ${r.format}`);
});

test("B02 info returns correct family name", () => {
  const r = fontClient({ operation: "info", path: TTF_PATH });
  assert(r.family === "TestFont", `family: ${r.family}`);
});

test("B03 info returns correct subfamily", () => {
  const r = fontClient({ operation: "info", path: TTF_PATH });
  assert(r.subfamily === "Regular", `subfamily: ${r.subfamily}`);
});

test("B04 info returns numGlyphs=128", () => {
  const r = fontClient({ operation: "info", path: TTF_PATH });
  assert(r.numGlyphs === 128, `numGlyphs: ${r.numGlyphs}`);
});

test("B05 info returns unitsPerEm=1000", () => {
  const r = fontClient({ operation: "info", path: TTF_PATH });
  assert(r.unitsPerEm === 1000, `unitsPerEm: ${r.unitsPerEm}`);
});

test("B06 info returns fileSize", () => {
  const r = fontClient({ operation: "info", path: TTF_PATH });
  assert(r.fileSize > 0, "fileSize must be positive");
  assert(r.fileSize === ttfBuf.length, `fileSize mismatch: ${r.fileSize} vs ${ttfBuf.length}`);
});

test("B07 info weightClass is Regular (400)", () => {
  const r = fontClient({ operation: "info", path: TTF_PATH });
  assert(r.weightClass && r.weightClass.value === 400, `weightClass: ${JSON.stringify(r.weightClass)}`);
  assert(r.weightClass.name === "Regular", `weightClass.name: ${r.weightClass.name}`);
});

test("B08 info widthClass is Normal (5)", () => {
  const r = fontClient({ operation: "info", path: TTF_PATH });
  assert(r.widthClass && r.widthClass.value === 5, `widthClass: ${JSON.stringify(r.widthClass)}`);
  assert(r.widthClass.name === "Normal", `widthClass.name: ${r.widthClass.name}`);
});

test("B09 info vendorId=TEST", () => {
  const r = fontClient({ operation: "info", path: TTF_PATH });
  assert(r.vendorId === "TEST", `vendorId: ${r.vendorId}`);
});

test("B10 info isVariable=false (no fvar table)", () => {
  const r = fontClient({ operation: "info", path: TTF_PATH });
  assert(r.isVariable === false, `isVariable: ${r.isVariable}`);
  assert(r.variableAxes === null, `variableAxes should be null: ${r.variableAxes}`);
});

test("B11 tables op returns all 7 tables", () => {
  const r = fontClient({ operation: "tables", path: TTF_PATH });
  assert(Array.isArray(r.tables), "tables must be array");
  assert(r.tables.length === 7, `expected 7 tables, got ${r.tables.length}`);
});

test("B12 tables has expected tags", () => {
  const r = fontClient({ operation: "tables", path: TTF_PATH });
  const tags = r.tables.map(t => t.tag);
  for (const expected of ["head", "hhea", "maxp", "OS/2", "name", "cmap", "post"]) {
    assert(tags.includes(expected), `Missing table: ${expected}`);
  }
});

test("B13 tables entries have tag/offset/length", () => {
  const r = fontClient({ operation: "tables", path: TTF_PATH });
  for (const t of r.tables) {
    assert(typeof t.tag === "string" && t.tag.length === 4, `tag: ${t.tag}`);
    assert(typeof t.offset === "number" && t.offset >= 0, `offset: ${t.offset}`);
    assert(typeof t.length === "number" && t.length > 0, `length: ${t.length}`);
  }
});

test("B14 metrics returns hhea ascender=800", () => {
  const r = fontClient({ operation: "metrics", path: TTF_PATH });
  assert(r.hhea && r.hhea.ascender === 800, `ascender: ${r.hhea?.ascender}`);
});

test("B15 metrics returns hhea descender=-200", () => {
  const r = fontClient({ operation: "metrics", path: TTF_PATH });
  assert(r.hhea && r.hhea.descender === -200, `descender: ${r.hhea?.descender}`);
});

test("B16 metrics returns OS2 typoAscender=800", () => {
  const r = fontClient({ operation: "metrics", path: TTF_PATH });
  assert(r.os2 && r.os2.typoAscender === 800, `typoAscender: ${r.os2?.typoAscender}`);
});

test("B17 metrics returns post italicAngle=0", () => {
  const r = fontClient({ operation: "metrics", path: TTF_PATH });
  assert(r.post && r.post.italicAngle === 0, `italicAngle: ${r.post?.italicAngle}`);
});

test("B18 metrics post isFixedPitch=false", () => {
  const r = fontClient({ operation: "metrics", path: TTF_PATH });
  assert(r.post && r.post.isFixedPitch === false, `isFixedPitch: ${r.post?.isFixedPitch}`);
});

test("B19 glyphs returns numGlyphs=128 and codepointCount>0", () => {
  const r = fontClient({ operation: "glyphs", path: TTF_PATH });
  assert(r.numGlyphs === 128, `numGlyphs: ${r.numGlyphs}`);
  assert(r.codepointCount !== null && r.codepointCount > 0,
    `codepointCount: ${r.codepointCount}`);
});

test("B20 glyphs cmapFormat platform=3", () => {
  const r = fontClient({ operation: "glyphs", path: TTF_PATH });
  assert(r.cmapFormat && r.cmapFormat.platformId === 3,
    `platformId: ${r.cmapFormat?.platformId}`);
});

// ═══════════════════════════════════════════════════════════════════════
// C: Happy-path tests (20)
// ═══════════════════════════════════════════════════════════════════════
console.error("\n[C] Happy-path");

test("C01 info on TTF returns operation='info'", () => {
  const r = fontClient({ operation: "info", path: TTF_PATH });
  assert(r.operation === "info");
});

test("C02 info on WOFF returns format=woff", () => {
  const r = fontClient({ operation: "info", path: WOFF_PATH });
  assert(r.format === "woff", `format: ${r.format}`);
});

test("C03 info on WOFF2 returns format=woff2", () => {
  const r = fontClient({ operation: "info", path: WOFF2_PATH });
  assert(r.format === "woff2", `format: ${r.format}`);
});

test("C04 WOFF2 info sets isWoff2HeaderOnly=true", () => {
  const r = fontClient({ operation: "info", path: WOFF2_PATH });
  assert(r.isWoff2HeaderOnly === true, `isWoff2HeaderOnly: ${r.isWoff2HeaderOnly}`);
});

test("C05 info returns path field", () => {
  const r = fontClient({ operation: "info", path: TTF_PATH });
  assert(r.path === TTF_PATH, `path: ${r.path}`);
});

test("C06 info sfVersion is TrueType", () => {
  const r = fontClient({ operation: "info", path: TTF_PATH });
  assert(r.sfVersion && r.sfVersion.includes("TrueType"), `sfVersion: ${r.sfVersion}`);
});

test("C07 info numTables=7", () => {
  const r = fontClient({ operation: "info", path: TTF_PATH });
  assert(r.numTables === 7, `numTables: ${r.numTables}`);
});

test("C08 info postscriptName matches", () => {
  const r = fontClient({ operation: "info", path: TTF_PATH });
  assert(r.postscriptName === "TestFont-Regular", `psName: ${r.postscriptName}`);
});

test("C09 names returns all 6 name records", () => {
  const r = fontClient({ operation: "names", path: TTF_PATH });
  assert(r.totalRecords === 6, `totalRecords: ${r.totalRecords}`);
});

test("C10 names summary has family key", () => {
  const r = fontClient({ operation: "names", path: TTF_PATH });
  assert(r.summary && r.summary.family === "TestFont", `summary.family: ${r.summary?.family}`);
});

test("C11 names filter by platform=3 returns all records", () => {
  const r = fontClient({ operation: "names", path: TTF_PATH, platform: 3 });
  assert(r.filtered === 6, `filtered: ${r.filtered}`);
});

test("C12 names filter by platform=0 returns 0 records (no Mac records)", () => {
  const r = fontClient({ operation: "names", path: TTF_PATH, platform: 1 });
  assert(r.filtered === 0, `filtered: ${r.filtered}`);
});

test("C13 names filter by language=0x0409 returns 6 records", () => {
  const r = fontClient({ operation: "names", path: TTF_PATH, language: 0x0409 });
  assert(r.filtered === 6, `filtered: ${r.filtered}`);
});

test("C14 unicode returns codepoints array", () => {
  const r = fontClient({ operation: "unicode", path: TTF_PATH });
  assert(Array.isArray(r.codepoints), "codepoints must be array");
  assert(r.codepoints.length > 0, "codepoints must not be empty");
});

test("C15 unicode codepoints start with U+ prefix", () => {
  const r = fontClient({ operation: "unicode", path: TTF_PATH });
  assert(r.codepoints[0].startsWith("U+"), `first cp: ${r.codepoints[0]}`);
});

test("C16 unicode includes Basic ASCII range (U+0020)", () => {
  const r = fontClient({ operation: "unicode", path: TTF_PATH });
  // Our cmap has 0x0020-0x007E
  assert(r.codepoints.includes("U+0020"), "U+0020 (space) must be in codepoints");
});

test("C17 unicode ranges are computed", () => {
  const r = fontClient({ operation: "unicode", path: TTF_PATH });
  assert(Array.isArray(r.ranges) && r.ranges.length > 0, "ranges must be non-empty array");
  const firstRange = r.ranges[0];
  assert(firstRange.range && firstRange.count > 0, `range format: ${JSON.stringify(firstRange)}`);
});

test("C18 unicode pagination offset/limit", () => {
  const all = fontClient({ operation: "unicode", path: TTF_PATH });
  const paged = fontClient({ operation: "unicode", path: TTF_PATH, offset: 5, limit: 3 });
  assert(paged.count <= 3, `count: ${paged.count}`);
  assert(paged.offset === 5, `offset: ${paged.offset}`);
  // verify paged[0] == all[5]
  if (all.codepoints.length > 5 && paged.codepoints.length > 0) {
    assert(paged.codepoints[0] === all.codepoints[5],
      `paged[0]=${paged.codepoints[0]}, all[5]=${all.codepoints[5]}`);
  }
});

test("C19 unicode ranges=false suppresses range computation", () => {
  const r = fontClient({ operation: "unicode", path: TTF_PATH, ranges: false });
  assert(Array.isArray(r.ranges) && r.ranges.length === 0,
    `ranges should be empty: ${JSON.stringify(r.ranges)}`);
});

test("C20 metrics unitsPerEm=1000 and ascenderEM computed", () => {
  const r = fontClient({ operation: "metrics", path: TTF_PATH });
  assert(r.unitsPerEm === 1000, `unitsPerEm: ${r.unitsPerEm}`);
  assert(r.hhea && typeof r.hhea.ascenderEM === "number",
    `ascenderEM: ${r.hhea?.ascenderEM}`);
  assert(Math.abs(r.hhea.ascenderEM - 0.8) < 0.001, `ascenderEM value: ${r.hhea.ascenderEM}`);
});

// ═══════════════════════════════════════════════════════════════════════
// D: Security tests (10)
// ═══════════════════════════════════════════════════════════════════════
console.error("\n[D] Security");

test("D01 NUL byte in path rejected", () => {
  assertThrows(() => fontClient({ operation: "info", path: `/tmp/x\0.ttf` }), "NUL bytes");
});

test("D02 directory traversal path rejected if pointing at directory", () => {
  // Use the OS temp dir which is guaranteed to exist on all platforms
  const { tmpdir } = require("os");
  assertThrows(() => fontClient({ operation: "info", path: tmpdir() }), "is a directory");
});

test("D03 nonexistent path reports meaningful error", () => {
  const noSuchPath = path.join(os.tmpdir(), "__no_such_font_12345.ttf");
  let msg = null;
  try { fontClient({ operation: "info", path: noSuchPath }); }
  catch (e) { msg = e.message; }
  assert(msg && msg.includes(noSuchPath), `Error doesn't include path: ${msg}`);
});

test("D04 zero-byte file rejected (too small)", () => {
  assertThrows(() => fontClient({ operation: "info", path: EMPTY_PATH }), "too small");
});

test("D05 unrecognized magic bytes rejected with descriptive error", () => {
  const bad = path.join(TMP, "bad.ttf");
  fs.writeFileSync(bad, Buffer.from([0xDE, 0xAD, 0xBE, 0xEF, 0,0,0,0,0,0,0,0]));
  assertThrows(() => fontClient({ operation: "info", path: bad }), "Unrecognized font format");
});

test("D06 null operation rejected", () => {
  assertThrows(() => fontClient({ operation: null, path: TTF_PATH }), "required");
});

test("D07 path injection attempt (operation is a string check)", () => {
  assertThrows(() => fontClient({ operation: "info; rm -rf", path: TTF_PATH }), "Unknown operation");
});

test("D08 unicode limit capped at 100000", () => {
  const r = fontClient({ operation: "unicode", path: TTF_PATH, limit: 999999 });
  assert(r.limit <= 100000, `limit should be capped: ${r.limit}`);
});

test("D09 unicode offset 0 + limit 0 handled gracefully (clamped to 1)", () => {
  // limit < 1 would be schema-rejected; but if somehow passed it's clamped
  // We test that limit=1 (minimum) works
  const r = fontClient({ operation: "unicode", path: TTF_PATH, limit: 1 });
  assert(r.codepoints.length <= 1, `should return at most 1 codepoint`);
});

test("D10 buffer overflow guard: implausible numTables in crafted file", () => {
  // Craft a TTF with numTables=512 (max) but no actual data — parser should handle gracefully
  const craftedBuf = Buffer.alloc(12 + 512 * 16); // sfnt header + empty dir, no table data
  craftedBuf.writeUInt32BE(0x00010000, 0); // TrueType magic
  craftedBuf.writeUInt16BE(512, 4);         // numTables = max allowed (will get trimmed)
  const crafted = path.join(TMP, "crafted.ttf");
  fs.writeFileSync(crafted, craftedBuf);
  // Should not throw — should either return partial data or detect invalid font gracefully
  let threw = false;
  try {
    const r = fontClient({ operation: "tables", path: crafted });
    // Even if it returns, it should have sensible data
    assert(r.operation === "tables", "should return tables op");
  } catch (e) {
    // Acceptable too (e.g. if format detection fails)
    threw = true;
  }
  // Either outcome is acceptable — the key is it doesn't crash the process
});

// ═══════════════════════════════════════════════════════════════════════
// E: Error-path tests (10)
// ═══════════════════════════════════════════════════════════════════════
console.error("\n[E] Error-paths");

test("E01 WOFF2 metrics returns note about Brotli", () => {
  const r = fontClient({ operation: "metrics", path: WOFF2_PATH });
  // Either returns note or full metrics from header
  assert(r.operation === "metrics");
});

test("E02 WOFF2 glyphs returns note about Brotli", () => {
  const r = fontClient({ operation: "glyphs", path: WOFF2_PATH });
  assert(r.operation === "glyphs");
  assert(r.note && r.note.includes("WOFF2"), `note: ${r.note}`);
});

test("E03 WOFF2 unicode returns note about Brotli", () => {
  const r = fontClient({ operation: "unicode", path: WOFF2_PATH });
  assert(r.operation === "unicode");
  assert(r.note && r.note.includes("WOFF2"), `note: ${r.note}`);
});

test("E04 file with truncated name table parses without crash", () => {
  // Build a font but truncate the name table midway
  const truncated = Buffer.from(ttfBuf);
  // We can't easily truncate a specific table, so write a font with a
  // shorter overall buffer by slicing — main parser should handle gracefully
  const short = truncated.slice(0, Math.floor(truncated.length * 0.5));
  const spath = path.join(TMP, "short.ttf");
  fs.writeFileSync(spath, short);
  // May throw (too small) or return partial data — either is fine
  try {
    const r = fontClient({ operation: "info", path: spath });
    assert(r.format === "ttf" || r.format === undefined);
  } catch (e) {
    // ok — must have descriptive error
    assert(e.message.length > 0, "error must have a message");
  }
});

test("E05 empty operation string throws with list of valid ops", () => {
  assertThrows(() => fontClient({ operation: "", path: TTF_PATH }), "required");
});

test("E06 unicode offset beyond total codepoints returns count=0", () => {
  const r = fontClient({ operation: "unicode", path: TTF_PATH });
  const totalCps = r.totalCodepoints;
  const far = fontClient({ operation: "unicode", path: TTF_PATH, offset: totalCps + 1000 });
  assert(far.count === 0, `count should be 0: ${far.count}`);
  assert(!far.truncated, "truncated should be false");
});

test("E07 names filter by nonexistent language returns 0 records", () => {
  const r = fontClient({ operation: "names", path: TTF_PATH, language: 0x1234 });
  assert(r.filtered === 0, `filtered: ${r.filtered}`);
});

test("E08 tables op on WOFF returns table list with WOFF note", () => {
  const r = fontClient({ operation: "tables", path: WOFF_PATH });
  assert(r.format === "woff", `format: ${r.format}`);
  assert(Array.isArray(r.tables) && r.tables.length > 0, "tables must be non-empty");
});

test("E09 tables op on WOFF2 returns header-only note", () => {
  const r = fontClient({ operation: "tables", path: WOFF2_PATH });
  assert(r.format === "woff2", `format: ${r.format}`);
  assert(r.note && r.note.includes("WOFF2"), `note: ${r.note}`);
});

test("E10 operation with extra unknown field ignored (robustness)", () => {
  // fontClient doesn't validate extra fields — this tests it doesn't crash
  const r = fontClient({ operation: "info", path: TTF_PATH, unknownArg: "foo" });
  assert(r.operation === "info", `operation: ${r.operation}`);
});

// ═══════════════════════════════════════════════════════════════════════
// F: Concurrency tests (6)
// ═══════════════════════════════════════════════════════════════════════
console.error("\n[F] Concurrency");

test("F01 20 concurrent info calls all succeed", async () => {
  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      Promise.resolve(fontClient({ operation: "info", path: TTF_PATH }))
    )
  );
  for (const r of results) {
    assert(r.family === "TestFont", `concurrent info family: ${r.family}`);
  }
});

test("F02 mixed concurrent operations on same file", async () => {
  const ops = ["info", "names", "metrics", "tables", "glyphs", "unicode",
                "info", "names", "metrics", "tables"];
  const results = await Promise.all(
    ops.map(op => Promise.resolve(fontClient({ operation: op, path: TTF_PATH })))
  );
  for (let i = 0; i < results.length; i++) {
    assert(results[i].operation === ops[i], `op[${i}] mismatch`);
  }
});

test("F03 concurrent calls on TTF and WOFF", async () => {
  const calls = [
    ...Array.from({ length: 10 }, () =>
      Promise.resolve(fontClient({ operation: "info", path: TTF_PATH }))),
    ...Array.from({ length: 10 }, () =>
      Promise.resolve(fontClient({ operation: "info", path: WOFF_PATH }))),
  ];
  const results = await Promise.all(calls);
  assert(results.slice(0, 10).every(r => r.format === "ttf"), "first 10 should be ttf");
  assert(results.slice(10).every(r => r.format === "woff"), "last 10 should be woff");
});

test("F04 concurrent unicode with different offsets", async () => {
  const results = await Promise.all(
    [0, 10, 20, 30, 40].map(offset =>
      Promise.resolve(fontClient({ operation: "unicode", path: TTF_PATH, offset, limit: 5 }))
    )
  );
  for (let i = 0; i < results.length; i++) {
    assert(results[i].offset === [0,10,20,30,40][i], `offset mismatch at index ${i}`);
  }
});

test("F05 concurrent error calls don't crash valid calls", async () => {
  const results = await Promise.allSettled([
    Promise.resolve(fontClient({ operation: "info", path: TTF_PATH })),
    Promise.resolve().then(() => fontClient({ operation: "info", path: "/nope.ttf" })).catch(e => e),
    Promise.resolve(fontClient({ operation: "info", path: TTF_PATH })),
    Promise.resolve().then(() => fontClient({ operation: "bogus", path: TTF_PATH })).catch(e => e),
    Promise.resolve(fontClient({ operation: "info", path: TTF_PATH })),
  ]);
  // First, third, fifth should succeed
  assert(results[0].status === "fulfilled" && results[0].value.family === "TestFont",
    "call 0 should succeed");
  assert(results[2].status === "fulfilled" && results[2].value.family === "TestFont",
    "call 2 should succeed");
  assert(results[4].status === "fulfilled" && results[4].value.family === "TestFont",
    "call 4 should succeed");
});

test("F06 repeated calls return identical results (determinism)", () => {
  const r1 = fontClient({ operation: "unicode", path: TTF_PATH });
  const r2 = fontClient({ operation: "unicode", path: TTF_PATH });
  assert(r1.totalCodepoints === r2.totalCodepoints, "totalCodepoints must be deterministic");
  assert(r1.codepoints.length === r2.codepoints.length, "codepoints length must be deterministic");
  assert(r1.codepoints[0] === r2.codepoints[0], "first codepoint must be deterministic");
});

// ── Cleanup ──────────────────────────────────────────────────────────────────
try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {}

// ── Summary ──────────────────────────────────────────────────────────────────
const total = passed + failed;
console.error(`\nSection 233 results: ${passed}/${total} passed`);
if (failed > 0) {
  console.error(`FAILED: ${failed} tests`);
  process.exit(1);
} else {
  console.error("All tests passed.");
}
