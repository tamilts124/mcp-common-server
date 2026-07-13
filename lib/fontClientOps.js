"use strict";
// ── font_client — zero-dep font file reader (pure Node.js) ───────────────────
// Operations: info, names, metrics, tables, glyphs, unicode
// Formats: TTF/OTF (OpenType/TrueType), WOFF, WOFF2 (header-level)
// Security: 50 MB file cap; NUL-byte guard; directory guard

const fs   = require("fs");
const path = require("path");
const { ToolError } = require("./errors");

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

// ══════════════════════════════════════════════════════════════════════════════
// FILE LOADING
// ══════════════════════════════════════════════════════════════════════════════

function loadFile(filePath) {
  if (!filePath || typeof filePath !== "string")
    throw new ToolError("font_client: 'path' must be a non-empty string.", -32602);
  if (filePath.includes("\0"))
    throw new ToolError("font_client: 'path' must not contain NUL bytes.", -32602);

  let resolved;
  try { resolved = path.resolve(filePath); } catch {
    throw new ToolError(`font_client: Cannot resolve path '${filePath}'.`, -32602);
  }

  let stat;
  try { stat = fs.statSync(resolved); } catch (e) {
    throw new ToolError(`font_client: Cannot access '${filePath}': ${e.message}`, -32602);
  }
  if (stat.isDirectory())
    throw new ToolError(`font_client: '${filePath}' is a directory, not a file.`, -32602);
  if (stat.size > MAX_FILE_SIZE)
    throw new ToolError(
      `font_client: File too large (${stat.size} bytes; limit ${MAX_FILE_SIZE}).`, -32602
    );
  if (stat.size < 12)
    throw new ToolError(`font_client: File too small to be a valid font (${stat.size} bytes).`, -32602);

  return { buf: fs.readFileSync(resolved), stat, resolved };
}

// ══════════════════════════════════════════════════════════════════════════════
// FORMAT DETECTION
// ══════════════════════════════════════════════════════════════════════════════

function detectFormat(buf) {
  // Check magic bytes
  const tag = buf.readUInt32BE(0);

  // WOFF: 'wOFF' = 0x774F4646
  if (tag === 0x774F4646) return "woff";
  // WOFF2: 'wOF2' = 0x774F4632
  if (tag === 0x774F4632) return "woff2";
  // TrueType: 0x00010000
  if (tag === 0x00010000) return "ttf";
  // OTF CFF: 'OTTO' = 0x4F54544F
  if (tag === 0x4F54544F) return "otf";
  // TrueType collection: 'ttcf' = 0x74746366
  if (tag === 0x74746366) return "ttc";
  // Some fonts use 'true' = 0x74727565 (Apple TrueType)
  if (tag === 0x74727565) return "ttf";
  // 'typ1' = 0x74797031 (old Type 1 sfnt)
  if (tag === 0x74797031) return "otf";

  const ext = path.extname(buf._path || "").toLowerCase();
  if (ext === ".ttf") return "ttf";
  if (ext === ".otf") return "otf";
  if (ext === ".woff") return "woff";
  if (ext === ".woff2") return "woff2";

  throw new ToolError(
    `font_client: Unrecognized font format (magic: 0x${tag.toString(16).padStart(8, "0").toUpperCase()}).`,
    -32602
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// SFNT TABLE DIRECTORY PARSER (shared by TTF, OTF, WOFF)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Parse the OpenType/TrueType offset table and table directory.
 * Returns { sfVersion, numTables, tables: [{tag, checksum, offset, length}] }
 */
function parseSfntDirectory(buf, baseOffset) {
  const off = baseOffset || 0;
  if (buf.length < off + 12)
    throw new ToolError("font_client: Buffer too small for sfnt offset table.", -32602);

  const sfVersionU32 = buf.readUInt32BE(off);
  const numTables    = buf.readUInt16BE(off + 4);
  // searchRange, entrySelector, rangeShift at off+6, off+8, off+10 (skip)

  const sfVersion = sfntVersionString(sfVersionU32);

  if (numTables > 512)
    throw new ToolError(`font_client: Implausibly large table count (${numTables}).`, -32602);

  const tableDir = [];
  const dirOffset = off + 12;
  for (let i = 0; i < numTables; i++) {
    const entry = dirOffset + i * 16;
    if (entry + 16 > buf.length) break;
    const tag      = buf.toString("ascii", entry, entry + 4);
    const checksum = buf.readUInt32BE(entry + 4);
    const offset   = buf.readUInt32BE(entry + 8);
    const length   = buf.readUInt32BE(entry + 12);
    tableDir.push({ tag, checksum, offset, length });
  }

  return { sfVersion, numTables: tableDir.length, tables: tableDir };
}

function sfntVersionString(u32) {
  if (u32 === 0x00010000) return "1.0 (TrueType)";
  if (u32 === 0x4F54544F) return "OTTO (CFF/OTF)";
  if (u32 === 0x74727565) return "true (Apple TrueType)";
  if (u32 === 0x74797031) return "typ1";
  // Encode as 4 ASCII chars if printable
  const s = String.fromCharCode(
    (u32 >> 24) & 0xFF, (u32 >> 16) & 0xFF, (u32 >> 8) & 0xFF, u32 & 0xFF
  );
  return s;
}

function findTable(tables, tag) {
  return tables.find(t => t.tag === tag) || null;
}

function tableSlice(buf, tableEntry) {
  const { offset, length } = tableEntry;
  if (offset + length > buf.length) return null;
  return buf.slice(offset, offset + length);
}

// ══════════════════════════════════════════════════════════════════════════════
// WOFF HEADER PARSER → unwraps to sfnt directory offset
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Parse WOFF wrapper header (44 bytes) and return a virtual sfnt-like
 * table list. WOFF tables are zlib-compressed but we can still read headers.
 * https://www.w3.org/TR/WOFF/
 */
function parseWoffDirectory(buf) {
  if (buf.length < 44)
    throw new ToolError("font_client: WOFF file too small.", -32602);

  // signature=4, flavor=4, length=4, numTables=2, reserved=2,
  // totalSfntSize=4, majorVersion=2, minorVersion=2, metaOffset=4,
  // metaLength=4, metaOrigLength=4, privOffset=4, privLength=4
  const flavor    = buf.readUInt32BE(4);
  const numTables = buf.readUInt16BE(12);
  const major     = buf.readUInt16BE(16);
  const minor     = buf.readUInt16BE(18);

  const tables = [];
  let entry = 44; // table directory starts at byte 44
  for (let i = 0; i < numTables && entry + 20 <= buf.length; i++) {
    // Each WOFF table dir entry: tag(4), offset(4), compLength(4),
    //   origLength(4), origChecksum(4)
    const tag          = buf.toString("ascii", entry, entry + 4);
    const offset       = buf.readUInt32BE(entry + 4);
    const compLength   = buf.readUInt32BE(entry + 8);
    const origLength   = buf.readUInt32BE(entry + 12);
    const origChecksum = buf.readUInt32BE(entry + 16);
    tables.push({ tag, offset, length: compLength, origLength, checksum: origChecksum });
    entry += 20;
  }

  return {
    sfVersion: sfntVersionString(flavor),
    numTables: tables.length,
    fontVersion: `${major}.${minor}`,
    tables,
    woff: true,
  };
}

/**
 * Parse WOFF2 header (minimal — WOFF2 tables are Brotli-compressed
 * and we cannot decompress without a library, but we can read header info).
 * https://www.w3.org/TR/WOFF2/
 */
function parseWoff2Header(buf) {
  if (buf.length < 48)
    throw new ToolError("font_client: WOFF2 file too small.", -32602);

  const flavor    = buf.readUInt32BE(4);
  const length    = buf.readUInt32BE(8);
  const numTables = buf.readUInt16BE(12);
  const major     = buf.readUInt16BE(16);
  const minor     = buf.readUInt16BE(18);
  const totalUncompressedSize = readUInt48(buf, 24); // 6-byte UIntBase128 — simplified

  // WOFF2 table directory entries use a different format with variable-length
  // fields; we parse the tag bytes at fixed offsets as a best-effort.
  const tables = [];
  let entry = 48;
  for (let i = 0; i < numTables && entry + 1 <= buf.length; i++) {
    // First byte: flags (6-bit table index + 2-bit transform)
    const flags = buf[entry];
    const tableIdxOrKnown = flags & 0x3F;
    const transformVersion = (flags >> 6) & 0x3;

    let tag;
    if (tableIdxOrKnown < 63) {
      // Known table — look up name from predefined list
      tag = WOFF2_KNOWN_TABLES[tableIdxOrKnown] || `UNK_${tableIdxOrKnown}`;
      entry += 1;
    } else {
      // Arbitrary tag: next 4 bytes
      if (entry + 5 > buf.length) break;
      tag = buf.toString("ascii", entry + 1, entry + 5);
      entry += 5;
    }
    // origLength: variable-length UIntBase128 (1–5 bytes)
    let origLength = 0;
    for (let b = 0; b < 5 && entry < buf.length; b++) {
      const byte = buf[entry++];
      origLength = (origLength << 7) | (byte & 0x7F);
      if (!(byte & 0x80)) break;
    }
    // transformLength (only if transform != 0 for glyf/loca, otherwise implied)
    let transformLength = origLength;
    if ((tableIdxOrKnown === 0 || tableIdxOrKnown === 1) && transformVersion !== 3) {
      // glyf/loca have a separate transform length field
      for (let b = 0; b < 5 && entry < buf.length; b++) {
        const byte = buf[entry++];
        transformLength = (transformLength << 7) | (byte & 0x7F);
        if (!(byte & 0x80)) { transformLength = origLength; break; } // simplified
      }
    }
    tables.push({ tag, origLength, transformVersion });
  }

  return {
    sfVersion: sfntVersionString(flavor),
    numTables: numTables,
    fontVersion: `${major}.${minor}`,
    tables,
    woff2: true,
    note: "WOFF2 tables are Brotli-compressed; full table data unavailable without decompression.",
  };
}

// https://www.w3.org/TR/WOFF2/#table_directory
const WOFF2_KNOWN_TABLES = [
  "cmap","head","hhea","hmtx","maxp","name","OS/2","post",  // 0-7
  "cvt ","fpgm","glyf","loca","prep","CFF ","VORG","EBDT",  // 8-15
  "EBLC","gasp","hdmx","kern","LTSH","PCLT","VDMX","vhea",  // 16-23
  "vmtx","BASE","GDEF","GPOS","GSUB","EBSC","JSTF","MATH",  // 24-31
  "CBDT","CBLC","COLR","CPAL","SVG ","sbix","acnt","avar",  // 32-39
  "bdat","bloc","bsln","cvar","fdsc","feat","fmtx","fvar",  // 40-47
  "gvar","hsty","just","lcar","mort","morx","opbd","prop",  // 48-55
  "trak","Zapf","Silf","Glat","Gloc","Feat","Sill",          // 56-62
];

function readUInt48(buf, offset) {
  // Read 6-byte big-endian number (simplified — treats top 2 bytes as 0 if large)
  const hi = buf.readUInt16BE(offset);
  const lo = buf.readUInt32BE(offset + 2);
  return hi * 0x100000000 + lo;
}

// ══════════════════════════════════════════════════════════════════════════════
// FONT TABLE PARSERS
// ══════════════════════════════════════════════════════════════════════════════

// ── 'name' table ─────────────────────────────────────────────────────────────

const NAME_IDS = {
  0:  "copyright",
  1:  "family",
  2:  "subfamily",
  3:  "unique_id",
  4:  "full_name",
  5:  "version",
  6:  "postscript_name",
  7:  "trademark",
  8:  "manufacturer",
  9:  "designer",
  10: "description",
  11: "vendor_url",
  12: "designer_url",
  13: "license",
  14: "license_url",
  16: "typographic_family",
  17: "typographic_subfamily",
  18: "compatible_full",
  19: "sample_text",
  20: "postscript_cid",
  21: "wws_family",
  22: "wws_subfamily",
  23: "light_background_palette",
  24: "dark_background_palette",
  25: "variations_postscript_prefix",
};

const PLATFORM_NAMES = { 0: "Unicode", 1: "Macintosh", 2: "ISO", 3: "Windows" };

function decodeNameString(buf, platformId, encodingId) {
  // Windows (3,*) and Unicode (0,*): UTF-16 Big-Endian
  if (platformId === 3 || platformId === 0) {
    // Manual UTF-16 BE decode (Node has no utf16be encoding)
    let result = "";
    for (let i = 0; i + 1 < buf.length; i += 2) {
      result += String.fromCharCode(buf.readUInt16BE(i));
    }
    return result;
  }
  // Macintosh (1,0): Mac Roman / Latin-1
  return buf.toString("latin1");
}

function parseNameTable(buf) {
  if (!buf || buf.length < 6) return [];
  const format = buf.readUInt16BE(0);
  const count  = buf.readUInt16BE(2);
  const strOff = buf.readUInt16BE(4);

  const records = [];
  for (let i = 0; i < count; i++) {
    const base = 6 + i * 12;
    if (base + 12 > buf.length) break;
    const platformId = buf.readUInt16BE(base);
    const encodingId = buf.readUInt16BE(base + 2);
    const languageId = buf.readUInt16BE(base + 4);
    const nameId     = buf.readUInt16BE(base + 6);
    const length     = buf.readUInt16BE(base + 8);
    const offset     = buf.readUInt16BE(base + 10);
    const absOff = strOff + offset;
    if (absOff + length > buf.length) continue;
    const strBuf = buf.slice(absOff, absOff + length);
    const value  = decodeNameString(strBuf, platformId, encodingId);
    records.push({
      nameId,
      name:       NAME_IDS[nameId] || `name_${nameId}`,
      platformId,
      platform:   PLATFORM_NAMES[platformId] || `platform_${platformId}`,
      encodingId,
      languageId,
      value,
    });
  }
  return records;
}

/** Extract the "best" value for a given name ID (prefer Windows/Unicode) */
function bestName(records, nameId) {
  // Priority: platform 3 (Windows) first, then platform 0 (Unicode), then 1 (Mac)
  const hits = records.filter(r => r.nameId === nameId);
  const win  = hits.find(r => r.platformId === 3);
  if (win)  return win.value;
  const uni  = hits.find(r => r.platformId === 0);
  if (uni)  return uni.value;
  const mac  = hits.find(r => r.platformId === 1);
  if (mac)  return mac.value;
  return hits[0]?.value ?? null;
}

// ── 'head' table ─────────────────────────────────────────────────────────────

function parseHeadTable(buf) {
  if (!buf || buf.length < 54) return null;
  const majorVersion  = buf.readUInt16BE(0);
  const minorVersion  = buf.readUInt16BE(2);
  // fontRevision is Fixed (16.16) at offset 4
  const fontRevHigh   = buf.readInt16BE(4);
  const fontRevLow    = buf.readUInt16BE(6);
  const fontRevision  = `${fontRevHigh}.${fontRevLow.toString().padStart(3, "0")}`;
  const flags         = buf.readUInt16BE(16);
  const unitsPerEm    = buf.readUInt16BE(18);
  // created/modified: 8-byte signed int (seconds since 1904-01-01)
  const EPOCH_DIFF = 2082844800; // seconds from 1904 to 1970
  const createdSecs  = readInt64(buf, 20) - EPOCH_DIFF;
  const modifiedSecs = readInt64(buf, 28) - EPOCH_DIFF;
  const created   = isFinite(createdSecs)  && createdSecs  > 0 ? new Date(createdSecs  * 1000).toISOString() : null;
  const modified  = isFinite(modifiedSecs) && modifiedSecs > 0 ? new Date(modifiedSecs * 1000).toISOString() : null;
  const xMin      = buf.readInt16BE(36);
  const yMin      = buf.readInt16BE(38);
  const xMax      = buf.readInt16BE(40);
  const yMax      = buf.readInt16BE(42);
  const macStyle  = buf.readUInt16BE(44);
  const lowestPPEM = buf.readUInt16BE(46);
  const indexToLocFormat = buf.readInt16BE(52); // 0=short, 1=long

  const style = [];
  if (macStyle & 0x0001) style.push("Bold");
  if (macStyle & 0x0002) style.push("Italic");
  if (macStyle & 0x0004) style.push("Underline");
  if (macStyle & 0x0008) style.push("Outline");
  if (macStyle & 0x0010) style.push("Shadow");
  if (macStyle & 0x0020) style.push("Condensed");
  if (macStyle & 0x0040) style.push("Extended");

  return {
    version: `${majorVersion}.${minorVersion}`,
    fontRevision,
    flags,
    unitsPerEm,
    created,
    modified,
    bbox: { xMin, yMin, xMax, yMax },
    macStyle,
    styleFlags: style,
    lowestPPEM,
    indexToLocFormat,
  };
}

function readInt64(buf, offset) {
  // Read 8-byte big-endian signed int as JS number (precision OK for dates)
  const hi = buf.readInt32BE(offset);
  const lo = buf.readUInt32BE(offset + 4);
  return hi * 0x100000000 + lo;
}

// ── 'hhea' table ─────────────────────────────────────────────────────────────

function parseHheaTable(buf) {
  if (!buf || buf.length < 36) return null;
  return {
    ascender:         buf.readInt16BE(4),
    descender:        buf.readInt16BE(6),
    lineGap:          buf.readInt16BE(8),
    advanceWidthMax:  buf.readUInt16BE(10),
    minLSB:           buf.readInt16BE(12),
    minRSB:           buf.readInt16BE(14),
    xMaxExtent:       buf.readInt16BE(16),
    caretSlopeRise:   buf.readInt16BE(18),
    caretSlopeRun:    buf.readInt16BE(20),
    numHMetrics:      buf.readUInt16BE(34),
  };
}

// ── 'OS/2' table ─────────────────────────────────────────────────────────────

const WEIGHT_CLASS = {
  100: "Thin", 200: "ExtraLight", 300: "Light", 350: "SemiLight",
  400: "Regular", 500: "Medium", 600: "SemiBold", 700: "Bold",
  800: "ExtraBold", 900: "Black",
};

const WIDTH_CLASS = {
  1: "Ultra-condensed", 2: "Extra-condensed", 3: "Condensed",
  4: "Semi-condensed",  5: "Normal",          6: "Semi-expanded",
  7: "Expanded",        8: "Extra-expanded",  9: "Ultra-expanded",
};

const PANOSE_FAMILY = [
  "Any", "No Fit", "Latin Text", "Latin Hand Written",
  "Latin Decorative", "Latin Symbol",
];

function parseOs2Table(buf) {
  if (!buf || buf.length < 78) return null;
  const version       = buf.readUInt16BE(0);
  const xAvgCharWidth = buf.readInt16BE(2);
  const weightClass   = buf.readUInt16BE(4);
  const widthClass    = buf.readUInt16BE(6);
  const fsType        = buf.readUInt16BE(8);
  // panose: 10 bytes at offset 32
  const panose        = Array.from(buf.slice(32, 42));
  // Unicode ranges: 4 x uint32 at offset 42
  const ulUnicodeRange1 = buf.readUInt32BE(42);
  const ulUnicodeRange2 = buf.readUInt32BE(46);
  const ulUnicodeRange3 = buf.readUInt32BE(50);
  const ulUnicodeRange4 = buf.readUInt32BE(54);
  // achVendID: 4 ASCII chars at offset 58
  const vendorId      = buf.toString("ascii", 58, 62).replace(/\0/g, "").trim();
  const fsSelection   = buf.readUInt16BE(62);
  const firstChar     = buf.readUInt16BE(64);
  const lastChar      = buf.readUInt16BE(66);
  const typoAscender  = buf.readInt16BE(68);
  const typoDescender = buf.readInt16BE(70);
  const typoLineGap   = buf.readInt16BE(72);
  const winAscent     = buf.readUInt16BE(74);
  const winDescent    = buf.readUInt16BE(76);

  const styleFlags = [];
  if (fsSelection & 0x0001) styleFlags.push("Italic");
  if (fsSelection & 0x0020) styleFlags.push("Bold");
  if (fsSelection & 0x0040) styleFlags.push("Regular");
  if (fsSelection & 0x0080) styleFlags.push("UseTypoMetrics");
  if (fsSelection & 0x0100) styleFlags.push("WWS");
  if (fsSelection & 0x0200) styleFlags.push("Oblique");

  // Decode Unicode range bits
  const unicodeRanges = decodeUnicodeRangeBits(
    ulUnicodeRange1, ulUnicodeRange2, ulUnicodeRange3, ulUnicodeRange4
  );

  // Embedding rights
  const embedLevel = fsType & 0x000F;
  const embedRights =
    embedLevel === 0 ? "Installable" :
    embedLevel === 2 ? "Restricted" :
    embedLevel === 4 ? "Print & Preview" :
    embedLevel === 8 ? "Editable" : `0x${embedLevel.toString(16)}`;

  return {
    version,
    xAvgCharWidth,
    weightClass,
    weightName: WEIGHT_CLASS[weightClass] || `${weightClass}`,
    widthClass,
    widthName: WIDTH_CLASS[widthClass] || `${widthClass}`,
    fsType,
    embedRights,
    panose,
    panoseFamily: PANOSE_FAMILY[panose[0]] || `${panose[0]}`,
    vendorId,
    fsSelection,
    styleFlags,
    firstChar,
    lastChar,
    typoAscender,
    typoDescender,
    typoLineGap,
    winAscent,
    winDescent,
    unicodeRanges,
  };
}

// ── Unicode range bit → script name mapping ──────────────────────────────────
// Based on OS/2 table spec (ulUnicodeRange1-4, bits 0-127)
const UNICODE_RANGE_BITS = [
  // Range1 bits 0-31
  [0,  "Basic Latin"],
  [1,  "Latin-1 Supplement"],
  [2,  "Latin Extended-A"],
  [3,  "Latin Extended-B"],
  [4,  "IPA Extensions"],
  [5,  "Spacing Modifier Letters"],
  [6,  "Combining Diacritical Marks"],
  [7,  "Greek and Coptic"],
  [8,  "Coptic"],
  [9,  "Cyrillic"],
  [10, "Armenian"],
  [11, "Hebrew"],
  [12, "Vai"],
  [13, "Arabic"],
  [14, "NKo"],
  [15, "Devanagari"],
  [16, "Bengali"],
  [17, "Gurmukhi"],
  [18, "Gujarati"],
  [19, "Oriya"],
  [20, "Tamil"],
  [21, "Telugu"],
  [22, "Kannada"],
  [23, "Malayalam"],
  [24, "Thai"],
  [25, "Lao"],
  [26, "Georgian"],
  [27, "Balinese"],
  [28, "Hangul Jamo"],
  [29, "Latin Extended Additional"],
  [30, "Greek Extended"],
  [31, "General Punctuation"],
  // Range2 bits 32-63
  [32, "Superscripts And Subscripts"],
  [33, "Currency Symbols"],
  [34, "Combining Diacritical Marks For Symbols"],
  [35, "Letterlike Symbols"],
  [36, "Number Forms"],
  [37, "Arrows"],
  [38, "Mathematical Operators"],
  [39, "Miscellaneous Technical"],
  [40, "Control Pictures"],
  [41, "OCR"],
  [42, "Enclosed Alphanumerics"],
  [43, "Box Drawing"],
  [44, "Block Elements"],
  [45, "Geometric Shapes"],
  [46, "Miscellaneous Symbols"],
  [47, "Dingbats"],
  [48, "CJK Symbols And Punctuation"],
  [49, "Hiragana"],
  [50, "Katakana"],
  [51, "Bopomofo"],
  [52, "Hangul Compatibility Jamo"],
  [53, "Phags-pa"],
  [54, "Enclosed CJK Letters And Months"],
  [55, "CJK Compatibility"],
  [56, "Hangul Syllables"],
  [57, "Non-Plane 0"],
  [58, "Phoenician"],
  [59, "CJK Unified Ideographs"],
  [60, "Private Use Area"],
  [61, "CJK Strokes"],
  [62, "Alphabetic Presentation Forms"],
  [63, "Arabic Presentation Forms-A"],
  // Range3 bits 64-95
  [64, "Combining Half Marks"],
  [65, "Vertical Forms"],
  [66, "Small Form Variants"],
  [67, "Arabic Presentation Forms-B"],
  [68, "Halfwidth And Fullwidth Forms"],
  [69, "Specials"],
  [70, "Tibetan"],
  [71, "Syriac"],
  [72, "Thaana"],
  [73, "Sinhala"],
  [74, "Myanmar"],
  [75, "Ethiopic"],
  [76, "Cherokee"],
  [77, "Unified Canadian Aboriginal Syllabics"],
  [78, "Ogham"],
  [79, "Runic"],
  [80, "Khmer"],
  [81, "Mongolian"],
  [82, "Braille Patterns"],
  [83, "Yi Syllables"],
  [84, "Tagalog, Hanunoo, Buhid, Tagbanwa"],
  [85, "Old Italic"],
  [86, "Gothic"],
  [87, "Deseret"],
  [88, "Byzantine Musical Symbols"],
  [89, "Mathematical Alphanumeric Symbols"],
  [90, "Private Use (plane 15+16)"],
  [91, "Variation Selectors"],
  [92, "Tags"],
  [93, "Limbu"],
  [94, "Tai Le"],
  [95, "New Tai Lue"],
  // Range4 bits 96-127
  [96, "Buginese"],
  [97, "Glagolitic"],
  [98, "Tifinagh"],
  [99, "Yijing Hexagram Symbols"],
  [100, "Syloti Nagri"],
  [101, "Linear B Syllabary"],
  [102, "Ancient Greek Numbers"],
  [103, "Ugaritic"],
  [104, "Old Persian"],
  [105, "Shavian"],
  [106, "Osmanya"],
  [107, "Cypriot Syllabary"],
  [108, "Kharoshthi"],
  [109, "Tai Xuan Jing Symbols"],
  [110, "Cuneiform"],
  [111, "Counting Rod Numerals"],
  [112, "Sudanese"],
  [113, "Lepcha"],
  [114, "Ol Chiki"],
  [115, "Saurashtra"],
  [116, "Kayah Li"],
  [117, "Rejang"],
  [118, "Cham"],
  [119, "Ancient Symbols"],
  [120, "Phaistos Disc"],
  [121, "Carian/Lycian/Lydian"],
  [122, "Domino Tiles"],
];

function decodeUnicodeRangeBits(r1, r2, r3, r4) {
  const set = [r1, r2, r3, r4];
  const ranges = [];
  for (const [bit, name] of UNICODE_RANGE_BITS) {
    const wordIdx = Math.floor(bit / 32);
    const bitIdx  = bit % 32;
    if (set[wordIdx] & (1 << bitIdx)) ranges.push(name);
  }
  return ranges;
}

// ── 'post' table ─────────────────────────────────────────────────────────────

function parsePostTable(buf) {
  if (!buf || buf.length < 32) return null;
  const formatHigh = buf.readUInt16BE(0);
  const formatLow  = buf.readUInt16BE(2);
  const italicAngle = buf.readInt16BE(4) + buf.readUInt16BE(6) / 65536;
  const underlinePosition  = buf.readInt16BE(8);
  const underlineThickness = buf.readInt16BE(10);
  const isFixedPitch = buf.readUInt32BE(12);

  return {
    format: `${formatHigh}.${formatLow.toString(16).padStart(4, "0")}`,
    italicAngle,
    underlinePosition,
    underlineThickness,
    isFixedPitch: isFixedPitch !== 0,
  };
}

// ── 'maxp' table ─────────────────────────────────────────────────────────────

function parseMaxpTable(buf) {
  if (!buf || buf.length < 6) return null;
  const version    = buf.readUInt32BE(0);
  const numGlyphs  = buf.readUInt16BE(4);
  const result     = { version: `0x${version.toString(16).padStart(8,"0")}`, numGlyphs };

  // Full version 1.0 has more fields
  if (version === 0x00010000 && buf.length >= 32) {
    result.maxPoints          = buf.readUInt16BE(6);
    result.maxContours        = buf.readUInt16BE(8);
    result.maxCompositePoints = buf.readUInt16BE(10);
    result.maxCompositeContours = buf.readUInt16BE(12);
    result.maxZones           = buf.readUInt16BE(14);
    result.maxTwilightPoints  = buf.readUInt16BE(16);
    result.maxStorage         = buf.readUInt16BE(18);
    result.maxFunctionDefs    = buf.readUInt16BE(20);
    result.maxInstructionDefs = buf.readUInt16BE(22);
    result.maxStackElements   = buf.readUInt16BE(24);
    result.maxSizeOfInstructions = buf.readUInt16BE(26);
    result.maxComponentElements  = buf.readUInt16BE(28);
    result.maxComponentDepth     = buf.readUInt16BE(30);
  }
  return result;
}

// ── 'cmap' table — builds a Set of supported Unicode codepoints ──────────────

function parseCmapTable(buf) {
  if (!buf || buf.length < 4) return { subtableCount: 0, codepoints: [] };
  const version     = buf.readUInt16BE(0);
  const numSubtables = buf.readUInt16BE(2);

  const subtables = [];
  let bestSubtable = null;
  let bestScore    = -1;

  for (let i = 0; i < numSubtables; i++) {
    const base = 4 + i * 8;
    if (base + 8 > buf.length) break;
    const platformId = buf.readUInt16BE(base);
    const encodingId = buf.readUInt16BE(base + 2);
    const offset     = buf.readUInt32BE(base + 4);
    subtables.push({ platformId, encodingId, offset });

    // Score: prefer platform 3 (Windows) encoding 10 (Full Unicode) > 1 (BMP) > platform 0
    let score = 0;
    if (platformId === 3 && encodingId === 10) score = 100; // Full Unicode
    else if (platformId === 3 && encodingId === 1)  score = 90;  // BMP
    else if (platformId === 0 && encodingId === 4)  score = 80;  // Unicode 2.0+
    else if (platformId === 0 && encodingId === 3)  score = 70;
    else if (platformId === 0 && encodingId === 0)  score = 60;
    else if (platformId === 1 && encodingId === 0)  score = 40;  // Mac Roman
    if (score > bestScore) { bestScore = score; bestSubtable = { platformId, encodingId, offset }; }
  }

  if (!bestSubtable) return { subtableCount: subtables.length, codepoints: [] };

  const codepoints = extractCodepoints(buf, bestSubtable.offset, bestSubtable.platformId, bestSubtable.encodingId);
  return {
    subtableCount: subtables.length,
    subtables: subtables.slice(0, 20), // cap summary at 20
    selectedPlatform: bestSubtable.platformId,
    selectedEncoding: bestSubtable.encodingId,
    codepointCount: codepoints.length,
    codepoints, // caller may truncate
  };
}

function extractCodepoints(buf, offset, platformId, encodingId) {
  if (offset + 2 > buf.length) return [];
  const format = buf.readUInt16BE(offset);
  const cps = new Set();

  try {
    if (format === 4) {
      // Format 4: segmented mapping to delta values
      if (offset + 14 > buf.length) return [];
      const length   = buf.readUInt16BE(offset + 2);
      const segCount = buf.readUInt16BE(offset + 6) >> 1;
      const endBase    = offset + 14;
      const startBase  = endBase + segCount * 2 + 2;
      const deltaBase  = startBase + segCount * 2;
      const rangeBase  = deltaBase + segCount * 2;

      for (let s = 0; s < segCount; s++) {
        const endCode   = buf.readUInt16BE(endBase   + s * 2);
        const startCode = buf.readUInt16BE(startBase + s * 2);
        const idDelta   = buf.readInt16BE(deltaBase  + s * 2);
        const idRangeOffset = buf.readUInt16BE(rangeBase + s * 2);

        if (startCode === 0xFFFF && endCode === 0xFFFF) break;
        for (let cp = startCode; cp <= endCode && cp <= 0x10FFFF; cp++) {
          if (idRangeOffset === 0) {
            const glyph = (cp + idDelta) & 0xFFFF;
            if (glyph !== 0) cps.add(cp);
          } else {
            // Index into glyphIdArray
            const glyphIdPtr = rangeBase + s * 2 + idRangeOffset + (cp - startCode) * 2;
            if (glyphIdPtr + 2 <= buf.length) {
              const glyph = (buf.readUInt16BE(glyphIdPtr) + idDelta) & 0xFFFF;
              if (glyph !== 0) cps.add(cp);
            }
          }
          if (cps.size > 100000) break; // safety cap
        }
        if (cps.size > 100000) break;
      }
    } else if (format === 12 || format === 13) {
      // Format 12/13: segmented coverage for full Unicode
      if (offset + 16 > buf.length) return [];
      const length   = buf.readUInt32BE(offset + 4);
      const numGroups = buf.readUInt32BE(offset + 12);
      for (let g = 0; g < numGroups && g < 50000; g++) {
        const base2     = offset + 16 + g * 12;
        if (base2 + 12 > buf.length) break;
        const startChar = buf.readUInt32BE(base2);
        const endChar   = buf.readUInt32BE(base2 + 4);
        const startGlyph = buf.readUInt32BE(base2 + 8);
        for (let cp = startChar; cp <= endChar && cp <= 0x10FFFF; cp++) {
          const glyphId = format === 12 ? startGlyph + (cp - startChar) : startGlyph;
          if (glyphId !== 0) cps.add(cp);
          if (cps.size > 100000) break;
        }
        if (cps.size > 100000) break;
      }
    } else if (format === 6) {
      // Format 6: trimmed table mapping
      if (offset + 10 > buf.length) return [];
      const firstCode  = buf.readUInt16BE(offset + 6);
      const entryCount = buf.readUInt16BE(offset + 8);
      for (let e = 0; e < entryCount; e++) {
        const glyphId = buf.readUInt16BE(offset + 10 + e * 2);
        if (glyphId !== 0) cps.add(firstCode + e);
      }
    } else if (format === 0) {
      // Format 0: byte encoding table (256 entries)
      for (let cp = 0; cp < 256 && offset + 6 + cp < buf.length; cp++) {
        if (buf[offset + 6 + cp] !== 0) cps.add(cp);
      }
    }
  } catch {
    // Return what we have
  }

  return [...cps].sort((a, b) => a - b);
}

// ── 'kern' table — kerning pair count ────────────────────────────────────────

function parseKernTable(buf) {
  if (!buf || buf.length < 4) return null;
  const version = buf.readUInt16BE(0);
  const nTables = buf.readUInt16BE(2);
  let pairCount = 0;
  let off = 4;
  for (let t = 0; t < nTables && off + 6 <= buf.length; t++) {
    const stVersion = buf.readUInt16BE(off);
    const stLength  = buf.readUInt16BE(off + 2);
    const coverage  = buf.readUInt16BE(off + 4);
    const format    = (coverage >> 8) & 0xFF;
    if (format === 0 && off + 14 <= buf.length) {
      pairCount += buf.readUInt16BE(off + 6);
    }
    if (stLength < 6) break;
    off += stLength;
  }
  return { version, subtableCount: nTables, pairCount };
}

// ── 'GPOS'/'GSUB' — feature count ────────────────────────────────────────────

function parseLayoutTable(buf, label) {
  if (!buf || buf.length < 10) return null;
  const majorVersion = buf.readUInt16BE(0);
  const minorVersion = buf.readUInt16BE(2);
  const scriptListOffset  = buf.readUInt16BE(4);
  const featureListOffset = buf.readUInt16BE(6);
  const lookupListOffset  = buf.readUInt16BE(8);

  let featureCount = 0;
  let lookupCount  = 0;
  let scriptCount  = 0;

  if (featureListOffset && featureListOffset + 2 <= buf.length) {
    featureCount = buf.readUInt16BE(featureListOffset);
  }
  if (lookupListOffset && lookupListOffset + 2 <= buf.length) {
    lookupCount = buf.readUInt16BE(lookupListOffset);
  }
  if (scriptListOffset && scriptListOffset + 2 <= buf.length) {
    scriptCount = buf.readUInt16BE(scriptListOffset);
  }

  return { version: `${majorVersion}.${minorVersion}`, scriptCount, featureCount, lookupCount };
}

// ── 'fvar' — variable font axes ──────────────────────────────────────────────

const FVAR_AXIS_NAMES = {
  "wght": "Weight", "wdth": "Width", "ital": "Italic",
  "slnt": "Slant",  "opsz": "Optical Size", "GRAD": "Grade",
  "XOPQ": "X Opaque", "YOPQ": "Y Opaque", "XTRA": "X Transparent",
};

function parseFvarTable(buf) {
  if (!buf || buf.length < 16) return null;
  const majorVersion = buf.readUInt16BE(0);
  const minorVersion = buf.readUInt16BE(2);
  const axesArrayOffset   = buf.readUInt16BE(4);
  const axisCount  = buf.readUInt16BE(8);
  const axisSize   = buf.readUInt16BE(10);
  const instanceCount = buf.readUInt16BE(12);
  const instanceSize  = buf.readUInt16BE(14);

  const axes = [];
  for (let i = 0; i < axisCount; i++) {
    const base = axesArrayOffset + i * axisSize;
    if (base + 20 > buf.length) break;
    const tag      = buf.toString("ascii", base, base + 4);
    const minValue = buf.readInt32BE(base + 4)  / 65536;
    const defValue = buf.readInt32BE(base + 8)  / 65536;
    const maxValue = buf.readInt32BE(base + 12) / 65536;
    const flags    = buf.readUInt16BE(base + 16);
    const nameId   = buf.readUInt16BE(base + 18);
    axes.push({
      tag,
      name: FVAR_AXIS_NAMES[tag] || tag,
      minValue, defaultValue: defValue, maxValue,
      flags, nameId,
    });
  }

  return {
    version: `${majorVersion}.${minorVersion}`,
    axisCount,
    instanceCount,
    axes,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// FULL FONT PARSE DISPATCHER
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Parse a font buffer and return directory + all parsed table data.
 * Works for TTF, OTF, and WOFF. WOFF2 returns header-only.
 */
function parseFont(buf, filePath, fmt) {
  let dir;
  if (fmt === "woff") {
    dir = parseWoffDirectory(buf);
    // WOFF tables point to compressed data; we attempt partial reads for
    // uncompressed tables (compLength == origLength means stored uncompressed).
  } else if (fmt === "woff2") {
    dir = parseWoff2Header(buf);
    // WOFF2 tables are all Brotli-compressed; we can only return header info.
    return { dir, tables: {}, fmt, woff2Only: true };
  } else if (fmt === "ttc") {
    // TTC: read first font entry
    if (buf.length < 12) throw new ToolError("font_client: TTC file too small.", -32602);
    const numFonts  = buf.readUInt32BE(8);
    const offset0   = buf.length >= 16 ? buf.readUInt32BE(12) : 0;
    dir = parseSfntDirectory(buf, offset0);
    dir.ttc = true;
    dir.ttcFontCount = numFonts;
  } else {
    dir = parseSfntDirectory(buf, 0);
  }

  // Now extract individual tables
  const parsed = {};

  function getTableBuf(tag) {
    const entry = findTable(dir.tables, tag);
    if (!entry) return null;
    if (fmt === "woff") {
      // For WOFF: if compLength == origLength, data is uncompressed
      if (entry.length === entry.origLength) {
        return tableSlice(buf, entry);
      }
      // Otherwise compressed — skip full parse
      return null;
    }
    return tableSlice(buf, entry);
  }

  parsed.head  = parseHeadTable(getTableBuf("head"));
  parsed.hhea  = parseHheaTable(getTableBuf("hhea"));
  parsed.os2   = parseOs2Table(getTableBuf("OS/2"));
  parsed.post  = parsePostTable(getTableBuf("post"));
  parsed.maxp  = parseMaxpTable(getTableBuf("maxp"));
  parsed.name  = parseNameTable(getTableBuf("name"));
  parsed.cmap  = parseCmapTable(getTableBuf("cmap"));
  parsed.kern  = parseKernTable(getTableBuf("kern"));
  parsed.gpos  = parseLayoutTable(getTableBuf("GPOS"), "GPOS");
  parsed.gsub  = parseLayoutTable(getTableBuf("GSUB"), "GSUB");
  parsed.fvar  = parseFvarTable(getTableBuf("fvar"));

  return { dir, tables: parsed, fmt };
}

// ══════════════════════════════════════════════════════════════════════════════
// OPERATIONS
// ══════════════════════════════════════════════════════════════════════════════

// ── op: info ─────────────────────────────────────────────────────────────────
function opInfo(args) {
  const { buf, stat, resolved } = loadFile(args.path);
  const fmt = detectFormat(buf);
  const { dir, tables, fmt: detectedFmt, woff2Only } = parseFont(buf, args.path, fmt);

  const nameRecords = tables.name || [];
  const head = tables.head;
  const os2  = tables.os2;
  const maxp = tables.maxp;
  const post = tables.post;
  const fvar = tables.fvar;

  return {
    operation:    "info",
    path:         args.path,
    format:       fmt,
    fileSize:     stat.size,
    modified:     stat.mtime.toISOString(),
    sfVersion:    dir.sfVersion,
    numTables:    dir.numTables,
    fontVersion:  dir.fontVersion || (head ? head.fontRevision : null),
    family:       bestName(nameRecords, 1),
    subfamily:    bestName(nameRecords, 2),
    fullName:     bestName(nameRecords, 4),
    postscriptName: bestName(nameRecords, 6),
    typographicFamily:    bestName(nameRecords, 16),
    typographicSubfamily: bestName(nameRecords, 17),
    version:      bestName(nameRecords, 5),
    copyright:    bestName(nameRecords, 0),
    manufacturer: bestName(nameRecords, 8),
    designer:     bestName(nameRecords, 9),
    vendorId:     os2?.vendorId ?? null,
    weightClass:  os2 ? { value: os2.weightClass, name: os2.weightName } : null,
    widthClass:   os2 ? { value: os2.widthClass,  name: os2.widthName  } : null,
    styleFlags:   os2?.styleFlags ?? head?.styleFlags ?? [],
    isFixedPitch: post?.isFixedPitch ?? null,
    numGlyphs:    maxp?.numGlyphs ?? null,
    unitsPerEm:   head?.unitsPerEm ?? null,
    isVariable:   fvar !== null,
    variableAxes: fvar?.axes ?? null,
    isWoff2HeaderOnly: woff2Only || false,
    ...(dir.ttc ? { ttc: true, ttcFontCount: dir.ttcFontCount } : {}),
  };
}

// ── op: names ─────────────────────────────────────────────────────────────────
function opNames(args) {
  const { buf, stat } = loadFile(args.path);
  const fmt = detectFormat(buf);
  const { dir, tables, woff2Only } = parseFont(buf, args.path, fmt);

  const nameRecords = tables.name || [];
  const platformFilter = args.platform !== undefined ? Number(args.platform) : null;
  const languageFilter = args.language !== undefined ? Number(args.language) : null;

  let records = nameRecords;
  if (platformFilter !== null)
    records = records.filter(r => r.platformId === platformFilter);
  if (languageFilter !== null)
    records = records.filter(r => r.languageId === languageFilter);

  // Build a compact keyed summary
  const summary = {};
  for (const r of records) {
    if (!summary[r.name]) summary[r.name] = r.value;
  }

  return {
    operation:    "names",
    path:         args.path,
    format:       fmt,
    totalRecords: nameRecords.length,
    filtered:     records.length,
    summary,
    records,
  };
}

// ── op: metrics ──────────────────────────────────────────────────────────────
function opMetrics(args) {
  const { buf, stat } = loadFile(args.path);
  const fmt = detectFormat(buf);
  const { dir, tables, woff2Only } = parseFont(buf, args.path, fmt);

  const head = tables.head;
  const hhea = tables.hhea;
  const os2  = tables.os2;
  const post = tables.post;
  const maxp = tables.maxp;

  if (!head && !hhea && !os2) {
    if (woff2Only)
      return { operation: "metrics", path: args.path, format: fmt,
               note: "WOFF2 Brotli-compressed tables cannot be decoded without a decompressor." };
    throw new ToolError("font_client: No metric tables found (head/hhea/OS/2).", -32602);
  }

  const upm = head?.unitsPerEm ?? 1000;
  function toEM(v) { return v !== undefined && v !== null ? +(v / upm).toFixed(4) : null; }

  return {
    operation:     "metrics",
    path:          args.path,
    format:        fmt,
    unitsPerEm:    upm,
    numGlyphs:     maxp?.numGlyphs ?? null,
    // hhea values
    hhea: hhea ? {
      ascender:        hhea.ascender,
      descender:       hhea.descender,
      lineGap:         hhea.lineGap,
      ascenderEM:      toEM(hhea.ascender),
      descenderEM:     toEM(hhea.descender),
      lineGapEM:       toEM(hhea.lineGap),
      advanceWidthMax: hhea.advanceWidthMax,
      numHMetrics:     hhea.numHMetrics,
    } : null,
    // OS/2 values (win & typo metrics)
    os2: os2 ? {
      typoAscender:    os2.typoAscender,
      typoDescender:   os2.typoDescender,
      typoLineGap:     os2.typoLineGap,
      winAscent:       os2.winAscent,
      winDescent:      os2.winDescent,
      xAvgCharWidth:   os2.xAvgCharWidth,
      firstChar:       os2.firstChar,
      lastChar:        os2.lastChar,
      embedRights:     os2.embedRights,
    } : null,
    // head
    head: head ? {
      fontRevision:  head.fontRevision,
      bbox:          head.bbox,
      lowestPPEM:    head.lowestPPEM,
      styleFlags:    head.styleFlags,
      created:       head.created,
      modified:      head.modified,
    } : null,
    // post
    post: post ? {
      italicAngle:          post.italicAngle,
      underlinePosition:    post.underlinePosition,
      underlineThickness:   post.underlineThickness,
      isFixedPitch:         post.isFixedPitch,
    } : null,
    // Kern / OpenType layout
    kern:    tables.kern,
    gpos:    tables.gpos,
    gsub:    tables.gsub,
    // Variable font axes
    fvar:    tables.fvar,
  };
}

// ── op: tables ────────────────────────────────────────────────────────────────
function opTables(args) {
  const { buf, stat } = loadFile(args.path);
  const fmt = detectFormat(buf);
  const { dir, tables: parsed, woff2Only } = parseFont(buf, args.path, fmt);

  const tableList = dir.tables.map(t => ({
    tag:      t.tag,
    offset:   t.offset,
    length:   t.length,
    ...(t.origLength !== undefined ? { origLength: t.origLength } : {}),
    ...(t.checksum   !== undefined ? { checksum: `0x${t.checksum.toString(16).padStart(8,"0")}` } : {}),
  }));

  return {
    operation:     "tables",
    path:          args.path,
    format:        fmt,
    sfVersion:     dir.sfVersion,
    numTables:     dir.numTables,
    fontVersion:   dir.fontVersion || null,
    ...(dir.ttc ? { ttc: true, ttcFontCount: dir.ttcFontCount } : {}),
    ...(woff2Only ? { note: "WOFF2: table offsets unavailable (Brotli-compressed)." } : {}),
    tables:        tableList,
  };
}

// ── op: glyphs ────────────────────────────────────────────────────────────────
function opGlyphs(args) {
  const { buf, stat } = loadFile(args.path);
  const fmt = detectFormat(buf);
  const { dir, tables, woff2Only } = parseFont(buf, args.path, fmt);

  if (woff2Only)
    return {
      operation: "glyphs",
      path: args.path,
      format: fmt,
      note: "WOFF2 Brotli-compressed tables cannot be decoded without a decompressor.",
    };

  const maxp = tables.maxp;
  const cmap = tables.cmap;
  const fvar = tables.fvar;
  const os2  = tables.os2;

  return {
    operation:     "glyphs",
    path:          args.path,
    format:        fmt,
    numGlyphs:     maxp?.numGlyphs ?? null,
    codepointCount: cmap?.codepointCount ?? null,
    cmapSubtables:  cmap?.subtableCount ?? null,
    cmapFormat: cmap ? {
      platformId: cmap.selectedPlatform,
      encodingId: cmap.selectedEncoding,
    } : null,
    charRange: os2 ? { first: os2.firstChar, last: os2.lastChar } : null,
    maxp: maxp ? {
      maxPoints:          maxp.maxPoints ?? null,
      maxContours:        maxp.maxContours ?? null,
      maxCompositePoints: maxp.maxCompositePoints ?? null,
      maxStackElements:   maxp.maxStackElements ?? null,
    } : null,
    isVariable: fvar !== null,
    variableAxes: fvar?.axes ?? null,
  };
}

// ── op: unicode ───────────────────────────────────────────────────────────────
function opUnicode(args) {
  const { buf, stat } = loadFile(args.path);
  const fmt = detectFormat(buf);
  const { dir, tables, woff2Only } = parseFont(buf, args.path, fmt);

  if (woff2Only)
    return {
      operation: "unicode",
      path: args.path,
      format: fmt,
      note: "WOFF2 Brotli-compressed tables cannot be decoded without a decompressor.",
    };

  const cmap = tables.cmap;
  const os2  = tables.os2;
  const limit = typeof args.limit === "number" ? Math.min(Math.max(1, args.limit), 100000) : 1000;
  const offset = typeof args.offset === "number" ? Math.max(0, args.offset) : 0;

  const allCps = cmap?.codepoints ?? [];
  const sliced = allCps.slice(offset, offset + limit);

  // Build range groups (contiguous codepoints → U+XXXX–U+YYYY)
  const ranges = [];
  if (args.ranges !== false) {
    let rangeStart = null;
    let rangeEnd   = null;
    for (const cp of allCps) {
      if (rangeStart === null) { rangeStart = cp; rangeEnd = cp; }
      else if (cp === rangeEnd + 1) { rangeEnd = cp; }
      else {
        ranges.push(toURange(rangeStart, rangeEnd));
        rangeStart = cp; rangeEnd = cp;
      }
      if (ranges.length >= 500) break; // cap
    }
    if (rangeStart !== null) ranges.push(toURange(rangeStart, rangeEnd));
  }

  function toURange(start, end) {
    const s = `U+${start.toString(16).toUpperCase().padStart(4,"0")}`;
    const e = `U+${end.toString(16).toUpperCase().padStart(4,"0")}`;
    return start === end ? { range: s, count: 1 }
      : { range: `${s}–${e}`, count: end - start + 1 };
  }

  function cpToHex(cp) {
    return `U+${cp.toString(16).toUpperCase().padStart(4,"0")}`;
  }

  return {
    operation:      "unicode",
    path:           args.path,
    format:         fmt,
    totalCodepoints: allCps.length,
    offset,
    limit,
    count:          sliced.length,
    truncated:      allCps.length > offset + limit,
    codepoints:     sliced.map(cpToHex),
    ranges,
    unicodeScripts: os2?.unicodeRanges ?? [],
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ══════════════════════════════════════════════════════════════════════════════

function fontClient(args) {
  const op = (args.operation || "").trim();
  const VALID_OPS = ["info", "names", "metrics", "tables", "glyphs", "unicode"];
  if (!op)
    throw new ToolError(
      `font_client: 'operation' is required. Valid: ${VALID_OPS.join(", ")}.`, -32602
    );
  if (!VALID_OPS.includes(op))
    throw new ToolError(
      `font_client: Unknown operation '${op}'. Valid: ${VALID_OPS.join(", ")}.`, -32602
    );

  switch (op) {
    case "info":    return opInfo(args);
    case "names":   return opNames(args);
    case "metrics": return opMetrics(args);
    case "tables":  return opTables(args);
    case "glyphs":  return opGlyphs(args);
    case "unicode": return opUnicode(args);
    default:
      throw new ToolError(`font_client: Unhandled operation '${op}'.`, -32603);
  }
}

module.exports = { fontClient };
