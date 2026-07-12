"use strict";
// lib/excelClientOps.js — Zero-dep XLSX reader/writer/editor (pure Node.js)
// Supports .xlsx (Office Open XML) — NOT legacy .xls (BIFF format).
// Security: 50 MB file cap; 1,000,000 row limit; 16,384 column limit;
//           NUL-byte path guard; directory path rejected.

const fs   = require("fs");
const path = require("path");
const zlib = require("zlib");

// ── Constants ────────────────────────────────────────────────────────────────
const MAX_FILE_SIZE  = 50 * 1024 * 1024;  // 50 MB
const MAX_ROWS       = 1_000_000;
const MAX_COLS       = 16_384;
const MAX_SHEETS     = 1_000;
const MAX_XML_NODES  = 5_000_000;

// ── Utility: column letter ↔ index ──────────────────────────────────────────
function colLetterToIndex(letters) {
  let n = 0;
  for (let i = 0; i < letters.length; i++) {
    n = n * 26 + (letters.charCodeAt(i) - 64);
  }
  return n - 1; // 0-based
}

function indexToColLetter(idx) {
  // idx is 0-based
  let n = idx + 1;
  let result = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    result = String.fromCharCode(65 + rem) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

// Parse cell address like "A1", "BC42" → { col: 0-based, row: 0-based }
function parseCellAddress(addr) {
  const m = /^([A-Z]{1,3})(\d+)$/.exec(addr.toUpperCase().trim());
  if (!m) throw new Error(`Invalid cell address: '${addr}'. Expected format like 'A1', 'BC42'.`);
  const row1 = parseInt(m[2], 10);
  if (row1 < 1) throw new Error("Invalid cell address: " + JSON.stringify(addr) + ". Row number must be >= 1.");
  return { col: colLetterToIndex(m[1]), row: row1 - 1 };
}

function toCellAddress(row0, col0) {
  return indexToColLetter(col0) + (row0 + 1);
}

// ── Minimal ZIP reader (DEFLATE only) ───────────────────────────────────────
// XLSX files are ZIP archives. We parse the local-file-header entries and
// inflate DEFLATED entries. STORED entries are used as-is.

const SIG_LOCAL  = 0x04034b50;
const SIG_CDIR   = 0x02014b50;
const SIG_EOCD   = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_DD     = 0x08074b50; // data descriptor

function readUint16LE(buf, off) { return buf[off] | (buf[off + 1] << 8); }
function readUint32LE(buf, off) {
  return ((buf[off] | (buf[off+1]<<8) | (buf[off+2]<<16)) + buf[off+3] * 0x1000000) >>> 0;
}
function readUint64LE(buf, off) {
  const lo = readUint32LE(buf, off);
  const hi = readUint32LE(buf, off + 4);
  return hi * 0x100000000 + lo;
}

function findEOCD(buf) {
  // Search backwards for EOCD signature
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (readUint32LE(buf, i) === SIG_EOCD) return i;
  }
  throw new Error("ZIP: cannot find End-of-Central-Directory record");
}

function parseCentralDirectory(buf) {
  const eocdOff = findEOCD(buf);
  let cdOffset, cdCount;

  // Check for ZIP64 EOCD locator just before EOCD
  if (eocdOff >= 20 && readUint32LE(buf, eocdOff - 20) === 0x07064b50) {
    const eocd64Off = Number(readUint64LE(buf, eocdOff - 20 + 8));
    cdCount  = Number(readUint64LE(buf, eocd64Off + 32));
    cdOffset = Number(readUint64LE(buf, eocd64Off + 48));
  } else {
    cdCount  = readUint16LE(buf, eocdOff + 10);
    cdOffset = readUint32LE(buf, eocdOff + 16);
  }

  const entries = [];
  let off = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (readUint32LE(buf, off) !== SIG_CDIR)
      throw new Error("ZIP: Central directory signature mismatch");
    const method       = readUint16LE(buf, off + 10);
    const crc32        = readUint32LE(buf, off + 16);
    let   compSize     = readUint32LE(buf, off + 20);
    let   uncompSize   = readUint32LE(buf, off + 24);
    const fnLen        = readUint16LE(buf, off + 28);
    const extraLen     = readUint16LE(buf, off + 30);
    const commentLen   = readUint16LE(buf, off + 32);
    let   localOffset  = readUint32LE(buf, off + 42);
    const name         = buf.toString("utf8", off + 46, off + 46 + fnLen);

    // Parse ZIP64 extra field if sizes/offset are 0xFFFFFFFF
    if (compSize === 0xFFFFFFFF || uncompSize === 0xFFFFFFFF || localOffset === 0xFFFFFFFF) {
      let exOff = off + 46 + fnLen;
      const exEnd = exOff + extraLen;
      while (exOff + 4 <= exEnd) {
        const exTag  = readUint16LE(buf, exOff);
        const exSize = readUint16LE(buf, exOff + 2);
        exOff += 4;
        if (exTag === 0x0001) { // ZIP64 extra
          let p = exOff;
          if (uncompSize === 0xFFFFFFFF && p + 8 <= exOff + exSize) { uncompSize = Number(readUint64LE(buf, p)); p += 8; }
          if (compSize   === 0xFFFFFFFF && p + 8 <= exOff + exSize) { compSize   = Number(readUint64LE(buf, p)); p += 8; }
          if (localOffset=== 0xFFFFFFFF && p + 8 <= exOff + exSize) { localOffset= Number(readUint64LE(buf, p)); }
          break;
        }
        exOff += exSize;
      }
    }

    entries.push({ name, method, compSize, uncompSize, localOffset });
    off += 46 + fnLen + extraLen + commentLen;
  }
  return entries;
}

function inflateEntry(buf, entry) {
  const localOff = entry.localOffset;
  if (readUint32LE(buf, localOff) !== SIG_LOCAL)
    throw new Error(`ZIP: Local file header signature mismatch for '${entry.name}'`);
  const fnLen    = readUint16LE(buf, localOff + 26);
  const extraLen = readUint16LE(buf, localOff + 28);
  const dataOff  = localOff + 30 + fnLen + extraLen;
  const compBuf  = buf.slice(dataOff, dataOff + entry.compSize);

  if (entry.method === 0) return compBuf;  // STORED
  if (entry.method === 8) return zlib.inflateRawSync(compBuf);  // DEFLATED
  throw new Error(`ZIP: unsupported compression method ${entry.method} for '${entry.name}'`);
}

// ── Minimal ZIP writer ───────────────────────────────────────────────────────

function buildZip(fileMap) {
  // fileMap: Map<string, Buffer|string>  name → content
  const parts   = [];
  const dirEntries = [];
  let offset = 0;

  for (const [name, rawContent] of fileMap) {
    const content = typeof rawContent === "string" ? Buffer.from(rawContent, "utf8") : rawContent;
    const nameBuf = Buffer.from(name, "utf8");

    // Try to DEFLATE; use STORED if compressed version is larger
    let method, dataBuf;
    const compressed = zlib.deflateRawSync(content, { level: 6 });
    if (compressed.length < content.length) {
      method = 8; dataBuf = compressed;
    } else {
      method = 0; dataBuf = content;
    }

    // CRC-32
    const crc = crc32Buffer(content);

    // Local header
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4);           // version needed
    local.writeUInt16LE(0, 6);            // flags
    local.writeUInt16LE(method, 8);       // compression
    local.writeUInt16LE(0, 10);           // mod time
    local.writeUInt16LE(0, 12);           // mod date
    local.writeUInt32LE(crc >>> 0, 14);   // CRC-32
    local.writeUInt32LE(dataBuf.length, 18); // compressed size
    local.writeUInt32LE(content.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26); // filename length
    local.writeUInt16LE(0, 28);           // extra length
    nameBuf.copy(local, 30);

    dirEntries.push({ name, nameBuf, method, crc, compSize: dataBuf.length, uncompSize: content.length, localOffset: offset });
    parts.push(local, dataBuf);
    offset += local.length + dataBuf.length;
  }

  // Central directory
  const cdStart = offset;
  const cdParts = [];
  for (const e of dirEntries) {
    const cd = Buffer.alloc(46 + e.nameBuf.length);
    cd.writeUInt32LE(SIG_CDIR, 0);
    cd.writeUInt16LE(20, 4);              // version made by
    cd.writeUInt16LE(20, 6);              // version needed
    cd.writeUInt16LE(0, 8);              // flags
    cd.writeUInt16LE(e.method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(e.crc >>> 0, 16);
    cd.writeUInt32LE(e.compSize, 20);
    cd.writeUInt32LE(e.uncompSize, 24);
    cd.writeUInt16LE(e.nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);             // extra length
    cd.writeUInt16LE(0, 32);             // comment length
    cd.writeUInt16LE(0, 34);             // disk start
    cd.writeUInt16LE(0, 36);             // internal attrs
    cd.writeUInt32LE(0, 38);             // external attrs
    cd.writeUInt32LE(e.localOffset, 42); // local header offset
    e.nameBuf.copy(cd, 46);
    cdParts.push(cd);
    offset += cd.length;
  }

  const cdSize = offset - cdStart;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);   // disk
  eocd.writeUInt16LE(0, 6);   // cd start disk
  eocd.writeUInt16LE(dirEntries.length, 8);
  eocd.writeUInt16LE(dirEntries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdStart, 16);
  eocd.writeUInt16LE(0, 20);  // comment length

  return Buffer.concat([...parts, ...cdParts, eocd]);
}

// ── CRC-32 ───────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32Buffer(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ── Minimal XML parser ───────────────────────────────────────────────────────
// Returns a simple node tree: { tag, attrs, children[], text }

function parseXml(xmlStr) {
  // Strip BOM and XML declaration
  let s = xmlStr.replace(/^\uFEFF/, "").replace(/<\?xml[^?]*\?>/i, "").trim();
  const stack  = [{ tag: "__root__", attrs: {}, children: [], text: "" }];
  let pos = 0, nodeCount = 0;

  function peek() { return s[pos]; }
  function consume(n = 1) { const r = s.slice(pos, pos + n); pos += n; return r; }
  function skipWS() { while (pos < s.length && /\s/.test(s[pos])) pos++; }

  function readAttrValue() {
    const q = consume(); // ' or "
    let val = "";
    while (pos < s.length && s[pos] !== q) val += consume();
    consume(); // closing quote
    return decodeXmlEntities(val);
  }

  function readTag() {
    // After '<' already consumed
    const isClose = peek() === "/";
    if (isClose) consume();
    const isProc  = peek() === "?";
    if (isProc)  { while (pos < s.length && !(s[pos-1]==="?" && s[pos]===">")) consume(); consume(); return null; }
    const isCData = s.slice(pos, pos+8) === "![CDATA[";
    if (isCData) {
      pos += 8;
      let cd = "";
      while (pos < s.length && s.slice(pos, pos+3) !== "]]>") cd += consume();
      pos += 3;
      return { type: "cdata", text: cd };
    }
    const isComment = s.slice(pos, pos+3) === "!--";
    if (isComment) { pos += 3; while (pos < s.length && s.slice(pos,pos+3) !== "-->") consume(); pos+=3; return null; }
    // Doctype
    if (s.slice(pos, pos+8) === "!DOCTYPE") { while (pos<s.length && s[pos]!==">") consume(); consume(); return null; }

    // Tag name
    let tag = "";
    while (pos < s.length && !/[\s>/]/.test(s[pos])) tag += consume();

    // Attributes
    const attrs = {};
    while (pos < s.length) {
      skipWS();
      if (s[pos] === ">" || s[pos] === "/") break;
      let name = "";
      while (pos < s.length && !/[\s=>/]/.test(s[pos])) name += consume();
      skipWS();
      if (s[pos] === "=") {
        consume(); skipWS();
        attrs[name] = readAttrValue();
      } else {
        attrs[name] = "";
      }
    }
    const selfClose = s[pos] === "/";
    if (selfClose) consume();
    if (s[pos] === ">") consume();
    return { type: "open", tag, attrs, selfClose, isClose };
  }

  while (pos < s.length) {
    if (nodeCount > MAX_XML_NODES) throw new Error("XML: document too large (node limit exceeded)");
    if (peek() === "<") {
      // Capture preceding text
      const parent = stack[stack.length - 1];
      consume(); // '<'
      const result = readTag();
      if (!result) continue;
      if (result.type === "cdata") {
        parent.text = (parent.text || "") + result.text;
        continue;
      }
      const { tag, attrs, selfClose, isClose } = result;
      if (isClose) {
        if (stack.length > 1) stack.pop();
      } else {
        const node = { tag, attrs, children: [], text: "" };
        parent.children.push(node);
        nodeCount++;
        if (!selfClose) stack.push(node);
      }
    } else {
      // Text content
      let t = "";
      while (pos < s.length && peek() !== "<") t += consume();
      const parent = stack[stack.length - 1];
      parent.text = (parent.text || "") + decodeXmlEntities(t);
    }
  }
  return stack[0]; // __root__
}

function decodeXmlEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function encodeXmlEntities(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function findAll(node, tag) {
  const results = [];
  if (!node || !node.children) return results;
  for (const c of node.children) {
    if (c.tag === tag || c.tag.endsWith(`:${tag}`)) results.push(c);
  }
  return results;
}

function findOne(node, tag) {
  if (!node || !node.children) return null;
  for (const c of node.children) {
    if (c.tag === tag || c.tag.endsWith(`:${tag}`)) return c;
  }
  return null;
}

function attr(node, ...names) {
  for (const n of names) if (node.attrs[n] !== undefined) return node.attrs[n];
  return undefined;
}

// ── XLSX structure ───────────────────────────────────────────────────────────
// Boilerplate XML strings for building a minimal XLSX from scratch

const CONTENT_TYPES_TEMPLATE = (sheetEntries) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
${sheetEntries}
</Types>`;

const RELS_TEMPLATE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const WORKBOOK_RELS_TEMPLATE = (sheetRels, ssRel, stylesRel) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheetRels}
${ssRel}
${stylesRel}
</Relationships>`;

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="2">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
  </fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
</styleSheet>`;

// ── XLSX parser ──────────────────────────────────────────────────────────────

function parseXlsx(buf) {
  if (buf.length > MAX_FILE_SIZE)
    throw new Error(`excel_client: file too large (${buf.length} bytes; max ${MAX_FILE_SIZE})`);

  // Parse ZIP
  const zipEntries = parseCentralDirectory(buf);
  const files = new Map();
  for (const entry of zipEntries) {
    const data = inflateEntry(buf, entry);
    files.set(entry.name, data.toString("utf8"));
  }

  // Shared strings
  const ssXml = files.get("xl/sharedStrings.xml") || files.get("xl/SharedStrings.xml");
  const sharedStrings = [];
  if (ssXml) {
    const ssRoot = parseXml(ssXml);
    const siList = findAll(ssRoot.children[0] || ssRoot, "si");
    for (const si of siList) {
      // Concatenate all <t> nodes within <si>
      const text = collectText(si);
      sharedStrings.push(text);
    }
  }

  // Styles — detect date formats
  const stylesXml = files.get("xl/styles.xml");
  const dateNumFmtIds = new Set();
  if (stylesXml) {
    const sRoot = parseXml(stylesXml);
    const styleSheet = sRoot.children[0] || sRoot;
    const numFmts = findOne(styleSheet, "numFmts");
    if (numFmts) {
      for (const nf of findAll(numFmts, "numFmt")) {
        const id  = parseInt(attr(nf, "numFmtId") || "0", 10);
        const fmt = (attr(nf, "formatCode") || "").toLowerCase();
        if (/[ymd]/.test(fmt) && !/\[|[hms]/.test(fmt)) dateNumFmtIds.add(id);
      }
    }
    // Built-in date numFmtIds: 14–17 (date), 18–21 (time includes), 27–36 (locale dates)
    for (const id of [14,15,16,17,22,27,28,29,30,31,32,33,34,35,36,45,46,47]) dateNumFmtIds.add(id);
    const cellXfs = findOne(styleSheet, "cellXfs");
    if (cellXfs) {
      let idx = 0;
      for (const xf of findAll(cellXfs, "xf")) {
        const fmtId = parseInt(attr(xf, "numFmtId") || "0", 10);
        if (dateNumFmtIds.has(fmtId)) dateNumFmtIds.add(1000000 + idx); // mark xf index
        idx++;
      }
    }
  }

  // Workbook — sheet list
  const wbXml = files.get("xl/workbook.xml");
  if (!wbXml) throw new Error("excel_client: missing xl/workbook.xml");
  const wbRoot = parseXml(wbXml);
  const wb = wbRoot.children[0] || wbRoot;
  const sheetsNode = findOne(wb, "sheets");
  const sheetDefs = findAll(sheetsNode || wb, "sheet");

  // Workbook relationships — map rId → sheet file
  const wbRelsXml = files.get("xl/_rels/workbook.xml.rels");
  const rIdToTarget = new Map();
  if (wbRelsXml) {
    const rRoot = parseXml(wbRelsXml);
    const rels = rRoot.children[0] || rRoot;
    for (const r of findAll(rels, "Relationship")) {
      rIdToTarget.set(attr(r, "Id"), attr(r, "Target"));
    }
  }

  const sheets = [];
  for (const sd of sheetDefs) {
    const name  = attr(sd, "name") || "Sheet";
    const sheetId = attr(sd, "sheetId");
    const rId   = attr(sd, "r:id", "id");
    let target  = rIdToTarget.get(rId) || `worksheets/sheet${sheetId}.xml`;
    if (!target.startsWith("xl/")) target = `xl/${target}`;

    const sheetXml = files.get(target);
    if (!sheetXml) { sheets.push({ name, rows: [], rowCount: 0, colCount: 0 }); continue; }

    const sheetRoot  = parseXml(sheetXml);
    const worksheet  = sheetRoot.children[0] || sheetRoot;
    const sheetData  = findOne(worksheet, "sheetData");
    const rowNodes   = sheetData ? findAll(sheetData, "row") : [];

    const rows = [];
    let maxCol = 0;
    for (const rowNode of rowNodes) {
      const rIdx = parseInt(attr(rowNode, "r") || "0", 10) - 1; // 0-based
      const cells = findAll(rowNode, "c");
      const rowData = [];
      for (const cell of cells) {
        const addrStr = attr(cell, "r") || "";
        const { col } = parseCellAddress(addrStr);
        const t  = attr(cell, "t") || "n"; // type: s=shared string, inlineStr, b=bool, e=error, n=number, str
        const sIdx = parseInt(attr(cell, "s") || "-1", 10);
        const vNode = findOne(cell, "v");
        const isNode = findOne(cell, "is");
        const fNode  = findOne(cell, "f");
        let value = null;
        let formula = fNode ? (fNode.text || "") : undefined;

        if (t === "s" && vNode) {
          const ssIdx = parseInt(vNode.text || "0", 10);
          value = sharedStrings[ssIdx] ?? "";
        } else if (t === "inlineStr" && isNode) {
          value = collectText(isNode);
        } else if (t === "b" && vNode) {
          value = vNode.text === "1";
        } else if (t === "e" && vNode) {
          value = `#ERR:${vNode.text}`;
        } else if (t === "str" && vNode) {
          value = vNode.text || "";
        } else if (vNode) {
          const num = parseFloat(vNode.text || "0");
          // Detect date style
          if (sIdx >= 0 && dateNumFmtIds.has(1000000 + sIdx)) {
            value = excelSerialToDate(num);
          } else {
            value = isNaN(num) ? (vNode.text || null) : num;
          }
        } else if (fNode) {
          value = null; // formula with no cached value
        }

        if (col > maxCol) maxCol = col;
        // Expand row array if needed
        while (rowData.length <= col) rowData.push(null);
        rowData[col] = formula !== undefined ? { value, formula } : value;
      }
      while (rows.length <= rIdx) rows.push(null);
      rows[rIdx] = rowData;
    }

    sheets.push({ name, rows, rowCount: rows.length, colCount: maxCol + (maxCol > 0 || rows.some(r => r && r.length > 0) ? 1 : 0) });
  }

  return { sheets, sharedStrings };
}

function collectText(node) {
  if (!node) return "";
  let text = node.text || "";
  for (const child of (node.children || [])) {
    // <t> nodes contain the text
    if (child.tag === "t" || child.tag.endsWith(":t")) text += (child.text || "");
    else text += collectText(child);
  }
  return text;
}

// Excel serial date to ISO string (UTC)
function excelSerialToDate(serial) {
  // Excel's epoch is Jan 1, 1900, but it incorrectly treats 1900 as a leap year
  const EPOCH = Date.UTC(1899, 11, 30); // Dec 30, 1899 compensates for the 1900 bug
  const ms = EPOCH + Math.round(serial) * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

function dateToExcelSerial(dateStr) {
  const EPOCH = Date.UTC(1899, 11, 30);
  const d = new Date(dateStr + "T00:00:00Z");
  if (isNaN(d.getTime())) return null;
  return Math.round((d.getTime() - EPOCH) / 86400000);
}

// ── XLSX serialiser ──────────────────────────────────────────────────────────

function serializeXlsx(sheets) {
  // Build shared strings table
  const ssMap   = new Map(); // string → index
  const ssList  = [];

  function getSsIdx(str) {
    const s = String(str);
    if (ssMap.has(s)) return ssMap.get(s);
    const idx = ssList.length;
    ssMap.set(s, idx);
    ssList.push(s);
    return idx;
  }

  // Build sheet XMLs
  const sheetXmls = [];
  for (const sheet of sheets) {
    const rowParts = [];
    const rows = sheet.rows || [];
    for (let ri = 0; ri < rows.length; ri++) {
      const row = rows[ri];
      if (!row || row.length === 0) continue;
      let hasData = false;
      const cellParts = [];
      for (let ci = 0; ci < row.length; ci++) {
        let val = row[ci];
        if (val === null || val === undefined) continue;
        hasData = true;
        const addr = toCellAddress(ri, ci);
        let formula = undefined;
        if (val !== null && typeof val === "object" && "value" in val) {
          formula = val.formula;
          val = val.value;
        }
        if (formula !== undefined) {
          const fEsc = encodeXmlEntities(formula);
          const vPart = val !== null && val !== undefined ? `<v>${encodeXmlEntities(val)}</v>` : "";
          cellParts.push(`<c r="${addr}"><f>${fEsc}</f>${vPart}</c>`);
        } else if (typeof val === "string") {
          const idx = getSsIdx(val);
          cellParts.push(`<c r="${addr}" t="s"><v>${idx}</v></c>`);
        } else if (typeof val === "boolean") {
          cellParts.push(`<c r="${addr}" t="b"><v>${val ? 1 : 0}</v></c>`);
        } else if (typeof val === "number") {
          cellParts.push(`<c r="${addr}"><v>${val}</v></c>`);
        } else {
          // Inline string fallback
          const idx = getSsIdx(String(val));
          cellParts.push(`<c r="${addr}" t="s"><v>${idx}</v></c>`);
        }
      }
      if (hasData) rowParts.push(`<row r="${ri + 1}">${cellParts.join("")}</row>`);
    }
    sheetXmls.push(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${rowParts.join("")}</sheetData>
</worksheet>`);
  }

  // Shared strings XML
  const ssXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${ssList.length}" uniqueCount="${ssList.length}">
${ssList.map(s => `  <si><t>${encodeXmlEntities(s)}</t></si>`).join("\n")}
</sst>`;

  // Workbook XML
  const sheetElems = sheets.map((s, i) =>
    `<sheet name="${encodeXmlEntities(s.name)}" sheetId="${i+1}" r:id="rId${i+1}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>`);
  const wbXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>${sheetElems.join("")}</sheets>
</workbook>`;

  // Workbook rels
  const sheetRels = sheets.map((_, i) =>
    `  <Relationship Id="rId${i+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i+1}.xml"/>`);
  const wbRels = WORKBOOK_RELS_TEMPLATE(
    sheetRels.join("\n"),
    `  <Relationship Id="rId${sheets.length+1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>`,
    `  <Relationship Id="rId${sheets.length+2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`,
  );

  // Content types
  const sheetCT = sheets.map((_, i) =>
    `  <Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
  const ctXml = CONTENT_TYPES_TEMPLATE(sheetCT.join("\n"));

  // Assemble ZIP
  const fileMap = new Map();
  fileMap.set("[Content_Types].xml", ctXml);
  fileMap.set("_rels/.rels", RELS_TEMPLATE);
  fileMap.set("xl/workbook.xml", wbXml);
  fileMap.set("xl/_rels/workbook.xml.rels", wbRels);
  fileMap.set("xl/styles.xml", STYLES_XML);
  fileMap.set("xl/sharedStrings.xml", ssXml);
  for (let i = 0; i < sheets.length; i++) {
    fileMap.set(`xl/worksheets/sheet${i+1}.xml`, sheetXmls[i]);
  }

  return buildZip(fileMap);
}

// ── Path guard ───────────────────────────────────────────────────────────────
function guardPath(p) {
  if (!p || typeof p !== "string") throw new Error("excel_client: 'path' is required and must be a string.");
  if (p.includes("\0")) throw new Error("excel_client: 'path' must not contain NUL bytes.");
  if (!p.toLowerCase().endsWith(".xlsx")) throw new Error("excel_client: only .xlsx files are supported (not legacy .xls).");
}

// ── Load / save helpers ──────────────────────────────────────────────────────
function loadWorkbook(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) throw new Error(`excel_client: '${filePath}' is a directory, not a file.`);
  if (stat.size > MAX_FILE_SIZE) throw new Error(`excel_client: file too large (${stat.size} bytes; max ${MAX_FILE_SIZE}).`);
  const buf = fs.readFileSync(filePath);
  return parseXlsx(buf);
}

function saveWorkbook(filePath, sheets) {
  const buf = serializeXlsx(sheets);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, buf);
}

// ── Sheet resolution ─────────────────────────────────────────────────────────
function resolveSheet(sheets, sheetRef) {
  if (sheetRef === undefined || sheetRef === null) return sheets[0]; // default: first sheet
  if (typeof sheetRef === "number") {
    if (sheetRef < 0 || sheetRef >= sheets.length)
      throw new Error(`excel_client: sheet index ${sheetRef} out of range (0–${sheets.length - 1}).`);
    return sheets[sheetRef];
  }
  const found = sheets.find(s => s.name === sheetRef);
  if (!found) throw new Error(`excel_client: sheet '${sheetRef}' not found. Available: ${sheets.map(s => `'${s.name}'`).join(", ")}.`);
  return found;
}

// ── Cell access helpers ───────────────────────────────────────────────────────
function getCell(sheet, row0, col0) {
  if (!sheet.rows[row0]) return null;
  const row = sheet.rows[row0];
  return row[col0] !== undefined ? row[col0] : null;
}

function setCell(sheet, row0, col0, value) {
  if (row0 < 0 || row0 >= MAX_ROWS) throw new Error(`excel_client: row index ${row0} out of range.`);
  if (col0 < 0 || col0 >= MAX_COLS) throw new Error(`excel_client: col index ${col0} out of range.`);
  while (sheet.rows.length <= row0) sheet.rows.push(null);
  if (!sheet.rows[row0]) sheet.rows[row0] = [];
  while (sheet.rows[row0].length <= col0) sheet.rows[row0].push(null);
  sheet.rows[row0][col0] = value;
}

// ── Public API ───────────────────────────────────────────────────────────────

function excelClient(args, resolveClientPath) {
  const { operation } = args;
  if (!operation) throw new Error("excel_client: 'operation' is required.");

  const VALID_OPS = ["read", "get_cell", "set_cell", "get_range", "set_range",
    "add_sheet", "delete_sheet", "list_sheets", "append_rows", "delete_rows",
    "stringify"];
  if (!VALID_OPS.includes(operation))
    throw new Error(`excel_client: unknown operation '${operation}'. Valid: ${VALID_OPS.join(", ")}.`);

  // ── list_sheets ────────────────────────────────────────────────────────────
  if (operation === "list_sheets") {
    guardPath(args.path);
    const { resolved } = resolveClientPath(args.path);
    const wb = loadWorkbook(resolved);
    return {
      path: args.path,
      sheetCount: wb.sheets.length,
      sheets: wb.sheets.map((s, i) => ({
        index: i, name: s.name, rowCount: s.rows.filter(Boolean).length,
        colCount: s.rows.reduce((m, r) => r ? Math.max(m, r.length) : m, 0),
      })),
    };
  }

  // ── read ───────────────────────────────────────────────────────────────────
  if (operation === "read") {
    guardPath(args.path);
    const { resolved } = resolveClientPath(args.path);
    const wb = loadWorkbook(resolved);
    const sheet = resolveSheet(wb.sheets, args.sheet);
    const offset = Math.max(0, args.offset || 0);
    const limit  = args.limit != null ? Math.min(Math.max(1, args.limit), MAX_ROWS) : MAX_ROWS;
    const raw    = args.raw === true;

    let rows = sheet.rows;
    const totalRows = rows.filter(Boolean).length;
    // Slice with offset/limit over non-null rows
    let count = 0, skipped = 0;
    const resultRows = [];
    for (let ri = 0; ri < rows.length; ri++) {
      if (!rows[ri]) continue;
      if (skipped < offset) { skipped++; continue; }
      if (count >= limit) break;
      const rowData = rows[ri].map(c => raw ? c : cellDisplayValue(c));
      resultRows.push({ row: ri, cells: rowData });
      count++;
    }
    return {
      path: args.path, sheet: sheet.name, totalRows,
      returnedRows: resultRows.length, offset, limit,
      rows: resultRows,
    };
  }

  // ── get_cell ───────────────────────────────────────────────────────────────
  if (operation === "get_cell") {
    if (!args.cell) throw new Error("excel_client: 'cell' is required for get_cell (e.g. 'A1').");
    guardPath(args.path);
    const { resolved } = resolveClientPath(args.path);
    const wb = loadWorkbook(resolved);
    const sheet = resolveSheet(wb.sheets, args.sheet);
    const { row, col } = parseCellAddress(args.cell);
    const raw = getCell(sheet, row, col);
    return { path: args.path, sheet: sheet.name, cell: args.cell.toUpperCase(), raw, value: cellDisplayValue(raw) };
  }

  // ── set_cell ───────────────────────────────────────────────────────────────
  if (operation === "set_cell") {
    if (!args.cell) throw new Error("excel_client: 'cell' is required for set_cell.");
    if (args.value === undefined) throw new Error("excel_client: 'value' is required for set_cell.");
    guardPath(args.path);
    const { resolved } = resolveClientPath(args.path);
    const wb = fs.existsSync(resolved)
      ? loadWorkbook(resolved)
      : { sheets: [{ name: "Sheet1", rows: [] }] };
    const sheet = resolveSheet(wb.sheets, args.sheet);
    const { row, col } = parseCellAddress(args.cell);
    setCell(sheet, row, col, args.value);
    saveWorkbook(resolved, wb.sheets);
    return { path: args.path, sheet: sheet.name, cell: args.cell.toUpperCase(), value: args.value, written: true };
  }

  // ── get_range ───────────────────────────────────────────────────────────────
  if (operation === "get_range") {
    if (!args.range) throw new Error("excel_client: 'range' is required for get_range (e.g. 'A1:C10').");
    const [startAddr, endAddr] = args.range.split(":").map(s => s.trim());
    if (!endAddr) throw new Error("excel_client: 'range' must be in A1:C10 format.");
    guardPath(args.path);
    const { resolved } = resolveClientPath(args.path);
    const wb = loadWorkbook(resolved);
    const sheet = resolveSheet(wb.sheets, args.sheet);
    const start = parseCellAddress(startAddr);
    const end   = parseCellAddress(endAddr);
    const result = [];
    for (let r = start.row; r <= end.row; r++) {
      const rowData = [];
      for (let c = start.col; c <= end.col; c++) {
        const raw = getCell(sheet, r, c);
        rowData.push(args.raw ? raw : cellDisplayValue(raw));
      }
      result.push({ row: r, cells: rowData });
    }
    return { path: args.path, sheet: sheet.name, range: args.range.toUpperCase(), rows: result };
  }

  // ── set_range ───────────────────────────────────────────────────────────────
  if (operation === "set_range") {
    if (!args.range) throw new Error("excel_client: 'range' is required for set_range.");
    if (!Array.isArray(args.values)) throw new Error("excel_client: 'values' must be a 2D array for set_range.");
    const [startAddr] = args.range.split(":").map(s => s.trim());
    const start = parseCellAddress(startAddr);
    guardPath(args.path);
    const { resolved } = resolveClientPath(args.path);
    const wb = fs.existsSync(resolved)
      ? loadWorkbook(resolved)
      : { sheets: [{ name: "Sheet1", rows: [] }] };
    const sheet = resolveSheet(wb.sheets, args.sheet);
    let written = 0;
    for (let ri = 0; ri < args.values.length; ri++) {
      const rowVals = args.values[ri];
      if (!Array.isArray(rowVals)) continue;
      for (let ci = 0; ci < rowVals.length; ci++) {
        if (rowVals[ci] !== undefined) {
          setCell(sheet, start.row + ri, start.col + ci, rowVals[ci]);
          written++;
        }
      }
    }
    saveWorkbook(resolved, wb.sheets);
    return { path: args.path, sheet: sheet.name, range: args.range.toUpperCase(), cellsWritten: written };
  }

  // ── add_sheet ───────────────────────────────────────────────────────────────
  if (operation === "add_sheet") {
    if (!args.name) throw new Error("excel_client: 'name' is required for add_sheet.");
    if (args.name.length > 31) throw new Error("excel_client: sheet name must be ≤ 31 characters.");
    guardPath(args.path);
    const { resolved } = resolveClientPath(args.path);
    const wb = fs.existsSync(resolved)
      ? loadWorkbook(resolved)
      : { sheets: [] };
    if (wb.sheets.length >= MAX_SHEETS)
      throw new Error(`excel_client: too many sheets (max ${MAX_SHEETS}).`);
    if (wb.sheets.find(s => s.name === args.name))
      throw new Error(`excel_client: sheet '${args.name}' already exists.`);
    const newSheet = { name: args.name, rows: [] };
    if (args.index !== undefined) {
      const idx = Math.max(0, Math.min(args.index, wb.sheets.length));
      wb.sheets.splice(idx, 0, newSheet);
    } else {
      wb.sheets.push(newSheet);
    }
    saveWorkbook(resolved, wb.sheets);
    return { path: args.path, name: args.name, sheetCount: wb.sheets.length, added: true };
  }

  // ── delete_sheet ─────────────────────────────────────────────────────────────
  if (operation === "delete_sheet") {
    if (args.sheet === undefined) throw new Error("excel_client: 'sheet' is required for delete_sheet.");
    guardPath(args.path);
    const { resolved } = resolveClientPath(args.path);
    const wb = loadWorkbook(resolved);
    const sheet = resolveSheet(wb.sheets, args.sheet);
    if (wb.sheets.length === 1) throw new Error("excel_client: cannot delete the last remaining sheet.");
    const idx = wb.sheets.indexOf(sheet);
    wb.sheets.splice(idx, 1);
    saveWorkbook(resolved, wb.sheets);
    return { path: args.path, deleted: sheet.name, remainingSheets: wb.sheets.map(s => s.name) };
  }

  // ── append_rows ─────────────────────────────────────────────────────────────
  if (operation === "append_rows") {
    if (!Array.isArray(args.rows)) throw new Error("excel_client: 'rows' must be an array of arrays for append_rows.");
    guardPath(args.path);
    const { resolved } = resolveClientPath(args.path);
    const wb = fs.existsSync(resolved)
      ? loadWorkbook(resolved)
      : { sheets: [{ name: "Sheet1", rows: [] }] };
    const sheet = resolveSheet(wb.sheets, args.sheet);
    // Find first empty row
    let startRow = sheet.rows.length;
    // Skip trailing null rows
    while (startRow > 0 && !sheet.rows[startRow - 1]) startRow--;
    const addedRows = [];
    for (let ri = 0; ri < args.rows.length; ri++) {
      const rowData = args.rows[ri];
      if (!Array.isArray(rowData)) throw new Error(`excel_client: append_rows: row ${ri} must be an array.`);
      const targetRow = startRow + ri;
      if (targetRow >= MAX_ROWS) throw new Error(`excel_client: too many rows (max ${MAX_ROWS}).`);
      while (sheet.rows.length <= targetRow) sheet.rows.push(null);
      sheet.rows[targetRow] = rowData.slice();
      addedRows.push(targetRow);
    }
    saveWorkbook(resolved, wb.sheets);
    return { path: args.path, sheet: sheet.name, appendedRows: addedRows.length, startRow, endRow: startRow + addedRows.length - 1 };
  }

  // ── delete_rows ─────────────────────────────────────────────────────────────
  if (operation === "delete_rows") {
    if (args.row === undefined) throw new Error("excel_client: 'row' is required for delete_rows (0-based row index).");
    guardPath(args.path);
    const { resolved } = resolveClientPath(args.path);
    const wb = loadWorkbook(resolved);
    const sheet = resolveSheet(wb.sheets, args.sheet);
    const startRow = parseInt(args.row, 10);
    const count2   = Math.max(1, parseInt(args.count || "1", 10));
    if (startRow < 0 || startRow >= sheet.rows.length)
      throw new Error(`excel_client: delete_rows: row ${startRow} out of range (0–${sheet.rows.length - 1}).`);
    sheet.rows.splice(startRow, count2);
    saveWorkbook(resolved, wb.sheets);
    return { path: args.path, sheet: sheet.name, deletedStartRow: startRow, deletedCount: count2, remainingRows: sheet.rows.filter(Boolean).length };
  }

  // ── stringify ──────────────────────────────────────────────────────────────
  if (operation === "stringify") {
    guardPath(args.path);
    const { resolved } = resolveClientPath(args.path);
    const wb = loadWorkbook(resolved);
    const sheet = resolveSheet(wb.sheets, args.sheet);
    const separator = args.separator || ",";
    const lines = [];
    for (const row of sheet.rows) {
      if (!row) { lines.push(""); continue; }
      lines.push(row.map(c => csvEscapeCell(cellDisplayValue(c), separator)).join(separator));
    }
    return { path: args.path, sheet: sheet.name, csv: lines.join("\n") };
  }

  throw new Error(`excel_client: unhandled operation '${operation}'.`);
}

function cellDisplayValue(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "object" && "value" in raw) return raw.value;
  return raw;
}

function csvEscapeCell(v, sep) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (s.includes(sep) || s.includes('"') || s.includes("\n")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

module.exports = { excelClient };
