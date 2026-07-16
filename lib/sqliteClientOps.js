"use strict";
// ── sqlite_client — zero-dep stateless SQLite file reader/writer (pure Node.js) ─
// Operations: info, tables, schema, query, execute, export
// Implements a minimal SQLite3 file format parser (no npm deps, no native bindings)
// Supports: SQLite 3.x database files (magic header, B-tree pages, WAL)
// File format reference: https://www.sqlite.org/fileformat2.html
//
// PATCH HISTORY:
//   2026-07-16 Bug Fix 1: parseSelect column parser broke on function calls like
//              COUNT(*) — tokenizer emitted '(', '*', ')' as separate punct tokens
//              which were all consumed as column names. Fixed by consuming function
//              call arguments through matching parentheses into a single colName.
//   2026-07-16 Bug Fix 2: opQuery (and opInfo/opTables/opExport/opSchema) reads the
//              raw .db file via fs.readFileSync, which misses uncommitted WAL frames
//              written by sqlite3 CLI (opExecute). Fixed: before reading the file,
//              if a -wal sidecar exists we run PRAGMA wal_checkpoint(FULL) via the
//              CLI to flush WAL frames back into the main database file.

const fs   = require("fs");
const path = require("path");
const { ToolError } = require("./errors");

const MAX_FILE_SIZE  = 256 * 1024 * 1024; // 256 MB
const MAX_ROWS       = 1_000_000;
const MAX_EXPORT_ROWS = 100_000;
const SQLITE_MAGIC   = "SQLite format 3\0";

// ══════════════════════════════════════════════════════════════════════════════
// LOW-LEVEL SQLITE3 BINARY PARSER
// ══════════════════════════════════════════════════════════════════════════════

// ── Varint decoder (SQLite variable-length integer, up to 9 bytes) ─────────
function readVarint(buf, offset) {
  let value = 0;
  let bytesRead = 0;
  for (let i = 0; i < 9; i++) {
    if (offset + i >= buf.length) break;
    const byte = buf[offset + i];
    bytesRead++;
    if (i < 8) {
      value = value * 128 + (byte & 0x7F);
      if (!(byte & 0x80)) break;
    } else {
      // 9th byte: all 8 bits contribute
      value = value * 256 + byte;
    }
  }
  return { value, bytesRead };
}

// ── Read big-endian integers from buffer ──────────────────────────────────
function readUint8(buf, off)  { return buf[off]; }
function readUint16BE(buf, off) { return (buf[off] << 8) | buf[off+1]; }
function readUint32BE(buf, off) {
  return ((buf[off] * 16777216) + (buf[off+1] << 16) + (buf[off+2] << 8) + buf[off+3]) >>> 0;
}
function readInt32BE(buf, off) {
  const v = readUint32BE(buf, off);
  return v > 0x7FFFFFFF ? v - 0x100000000 : v;
}
function readInt64BE(buf, off) {
  // JS can't safely represent 64-bit integers; use BigInt then convert
  const hi = readInt32BE(buf, off);
  const lo = readUint32BE(buf, off + 4);
  return hi * 4294967296 + lo;
}
function readFloat64BE(buf, off) {
  const tmp = Buffer.allocUnsafe(8);
  buf.copy(tmp, 0, off, off + 8);
  return tmp.readDoubleBE(0);
}

// ── Parse SQLite file header (first 100 bytes) ────────────────────────────
function parseFileHeader(buf) {
  if (buf.length < 100) throw new ToolError("sqlite_client: File too small to be a valid SQLite database.", -32602);
  const magic = buf.slice(0, 16).toString("binary");
  if (magic !== SQLITE_MAGIC)
    throw new ToolError(
      "sqlite_client: Not a valid SQLite database file (bad magic header).", -32602
    );

  const pageSize = readUint16BE(buf, 16) === 1 ? 65536 : readUint16BE(buf, 16);
  return {
    pageSize,
    writeVersion:     readUint8(buf, 18),
    readVersion:      readUint8(buf, 19),
    reservedSpace:    readUint8(buf, 20),
    maxEmbedFraction: readUint8(buf, 21),
    minEmbedFraction: readUint8(buf, 22),
    minLeafFraction:  readUint8(buf, 23),
    changeCounter:    readUint32BE(buf, 24),
    pageCount:        readUint32BE(buf, 28),
    firstFreePage:    readUint32BE(buf, 32),
    freePageCount:    readUint32BE(buf, 36),
    schemaCookie:     readUint32BE(buf, 40),
    schemaFormat:     readUint32BE(buf, 44),
    defaultCacheSize: readUint32BE(buf, 48),
    largestRootPage:  readUint32BE(buf, 52),
    textEncoding:     readUint32BE(buf, 56), // 1=UTF-8, 2=UTF-16le, 3=UTF-16be
    userVersion:      readUint32BE(buf, 60),
    incrementalVacuum:readUint32BE(buf, 64),
    applicationId:    readUint32BE(buf, 68),
    versionValidFor:  readUint32BE(buf, 92),
    sqliteVersion:    readUint32BE(buf, 96),
  };
}

// ── SQLite cell serial-type to value decoder ──────────────────────────────
function serialTypeInfo(serialType) {
  if (serialType === 0) return { kind: "null",    size: 0 };
  if (serialType === 1) return { kind: "int",     size: 1 };
  if (serialType === 2) return { kind: "int",     size: 2 };
  if (serialType === 3) return { kind: "int",     size: 3 };
  if (serialType === 4) return { kind: "int",     size: 4 };
  if (serialType === 5) return { kind: "int",     size: 6 };
  if (serialType === 6) return { kind: "int",     size: 8 };
  if (serialType === 7) return { kind: "float",   size: 8 };
  if (serialType === 8) return { kind: "int0",    size: 0 };  // integer 0
  if (serialType === 9) return { kind: "int1",    size: 0 };  // integer 1
  if (serialType >= 12 && serialType % 2 === 0) return { kind: "blob", size: (serialType - 12) / 2 };
  if (serialType >= 13 && serialType % 2 === 1) return { kind: "text", size: (serialType - 13) / 2 };
  return { kind: "unknown", size: 0 };
}

function readSerialValue(buf, offset, serialType, encoding) {
  const { kind, size } = serialTypeInfo(serialType);
  if (kind === "null")  return { value: null,  bytesRead: 0 };
  if (kind === "int0")  return { value: 0,     bytesRead: 0 };
  if (kind === "int1")  return { value: 1,     bytesRead: 0 };
  if (kind === "float") return { value: readFloat64BE(buf, offset), bytesRead: 8 };
  if (kind === "blob")  return { value: buf.slice(offset, offset + size), bytesRead: size };
  if (kind === "int") {
    if (offset + size > buf.length) return { value: null, bytesRead: size };
    let v = 0;
    // big-endian signed
    for (let i = 0; i < size; i++) v = v * 256 + buf[offset + i];
    // sign extend
    const bits = size * 8;
    if (v >= Math.pow(2, bits - 1)) v -= Math.pow(2, bits);
    return { value: v, bytesRead: size };
  }
  if (kind === "text") {
    const slice = buf.slice(offset, offset + size);
    let str;
    if (encoding === 2)      str = slice.toString("utf16le");
    else if (encoding === 3) str = slice.swap16().toString("utf16le");
    else                     str = slice.toString("utf8");
    return { value: str, bytesRead: size };
  }
  return { value: null, bytesRead: 0 };
}

// ── B-tree page parser ────────────────────────────────────────────────────
// Returns array of cell payloads (raw Buffers) from a leaf table page
function parseLeafTablePage(pageBuf, pageSize, isFirstPage, encoding) {
  const headerOffset = isFirstPage ? 100 : 0;
  const pageType = readUint8(pageBuf, headerOffset);

  // 0x0D = leaf table b-tree, 0x05 = interior table b-tree
  // 0x0A = leaf index b-tree, 0x02 = interior index b-tree
  if (pageType !== 0x0D && pageType !== 0x05) return null;

  const freeBlockOffset  = readUint16BE(pageBuf, headerOffset + 1);
  const cellCount        = readUint16BE(pageBuf, headerOffset + 3);
  const cellContentStart = readUint16BE(pageBuf, headerOffset + 5) || 65536;
  const fragFreeBytes    = readUint8(pageBuf, headerOffset + 7);
  const rightmostPointer = pageType === 0x05 ? readUint32BE(pageBuf, headerOffset + 8) : null;
  const cellArrayStart   = headerOffset + (pageType === 0x05 ? 12 : 8);

  const rows = [];
  for (let i = 0; i < cellCount; i++) {
    const cellPtrOffset = cellArrayStart + i * 2;
    if (cellPtrOffset + 2 > pageBuf.length) break;
    const cellOffset = readUint16BE(pageBuf, cellPtrOffset);
    if (cellOffset === 0 || cellOffset >= pageBuf.length) continue;

    if (pageType === 0x0D) {
      // Leaf table B-tree cell: payload-length varint, rowid varint, payload
      let pos = cellOffset;
      const pLen = readVarint(pageBuf, pos);
      pos += pLen.bytesRead;
      const rowid = readVarint(pageBuf, pos);
      pos += rowid.bytesRead;

      // Inline payload (may overflow to overflow pages, but we handle only inline here)
      const payloadLen = pLen.value;
      const inlineSize = Math.min(payloadLen, pageBuf.length - pos);
      const payload = pageBuf.slice(pos, pos + inlineSize);
      rows.push({ rowid: rowid.value, payload, payloadLen });
    }
  }
  return { pageType, cellCount, rightmostPointer, rows };
}

// ── Parse a record payload into column values ─────────────────────────────
function parseRecord(payload, encoding) {
  if (!payload || payload.length === 0) return [];

  // Header: header-length varint + serial-type varints
  let pos = 0;
  const hdrLen = readVarint(payload, 0);
  pos += hdrLen.bytesRead;

  const serialTypes = [];
  while (pos < hdrLen.value) {
    const st = readVarint(payload, pos);
    if (st.bytesRead === 0) break;
    serialTypes.push(st.value);
    pos += st.bytesRead;
  }

  // Values start after header
  let dataPos = hdrLen.value;
  const values = [];
  for (const st of serialTypes) {
    if (dataPos > payload.length) break;
    const { value, bytesRead } = readSerialValue(payload, dataPos, st, encoding);
    values.push(value instanceof Buffer ? `<blob:${value.length}bytes>` : value);
    dataPos += bytesRead;
  }
  return values;
}

// ── Walk all leaf table pages via interior pages ──────────────────────────
function collectLeafPages(dbBuf, rootPage, pageSize, visited) {
  if (visited.has(rootPage)) return [];
  visited.add(rootPage);

  const pageOffset = (rootPage - 1) * pageSize;
  if (pageOffset + pageSize > dbBuf.length) return [];
  const pageBuf = dbBuf.slice(pageOffset, pageOffset + pageSize);
  const isFirst = rootPage === 1;
  const headerOffset = isFirst ? 100 : 0;
  const pageType = readUint8(pageBuf, headerOffset);

  if (pageType === 0x0D) {
    // Leaf table page
    return [rootPage];
  }
  if (pageType === 0x05) {
    // Interior table page — recurse into child pages
    const cellCount = readUint16BE(pageBuf, headerOffset + 3);
    const rightmost = readUint32BE(pageBuf, headerOffset + 8);
    const cellArrayStart = headerOffset + 12;
    const childPages = [];

    for (let i = 0; i < cellCount; i++) {
      const cellPtrOffset = cellArrayStart + i * 2;
      if (cellPtrOffset + 2 > pageBuf.length) break;
      const cellOffset = readUint16BE(pageBuf, cellPtrOffset);
      if (cellOffset < 4 || cellOffset >= pageBuf.length) continue;
      const leftChild = readUint32BE(pageBuf, cellOffset);
      childPages.push(...collectLeafPages(dbBuf, leftChild, pageSize, visited));
    }
    childPages.push(...collectLeafPages(dbBuf, rightmost, pageSize, visited));
    return childPages;
  }
  return [];
}

// ── Read all rows from a table given its root page ────────────────────────
function readTableRows(dbBuf, rootPage, pageSize, encoding, maxRows) {
  const visited = new Set();
  const leafPages = collectLeafPages(dbBuf, rootPage, pageSize, visited);

  const rows = [];
  for (const pgNum of leafPages) {
    if (rows.length >= maxRows) break;
    const pageOffset = (pgNum - 1) * pageSize;
    if (pageOffset + pageSize > dbBuf.length) continue;
    const pageBuf = dbBuf.slice(pageOffset, pageOffset + pageSize);
    const result = parseLeafTablePage(pageBuf, pageSize, pgNum === 1, encoding);
    if (!result) continue;
    for (const cell of result.rows) {
      if (rows.length >= maxRows) break;
      const values = parseRecord(cell.payload, encoding);
      rows.push({ rowid: cell.rowid, values });
    }
  }
  return rows;
}

// ══════════════════════════════════════════════════════════════════════════════
// SCHEMA PARSER (sqlite_master)
// ══════════════════════════════════════════════════════════════════════════════

// sqlite_master columns: type, name, tbl_name, rootpage, sql
const SCHEMA_ROOT_PAGE = 1;

function parseSchema(dbBuf, pageSize, encoding) {
  const rawRows = readTableRows(dbBuf, SCHEMA_ROOT_PAGE, pageSize, encoding, 10000);
  const entries = [];
  for (const row of rawRows) {
    const [type, name, tbl_name, rootpage, sql] = row.values;
    if (type == null && name == null) continue;
    entries.push({
      type:      typeof type === "string" ? type : String(type ?? ""),
      name:      typeof name === "string" ? name : String(name ?? ""),
      tbl_name:  typeof tbl_name === "string" ? tbl_name : String(tbl_name ?? ""),
      rootpage:  typeof rootpage === "number" ? Math.round(rootpage) : 0,
      sql:       typeof sql === "string" ? sql : null,
    });
  }
  return entries;
}

// ── Parse CREATE TABLE SQL to extract column definitions ─────────────────
function parseCreateTable(sql) {
  if (!sql) return [];
  // Extract content between first ( and last )
  const inner = sql.replace(/^[\s\S]*?\(/, "").replace(/\)[^)]*$/, "");
  const cols = [];
  let depth = 0, cur = "", inStr = false, strChar = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (inStr) {
      cur += ch;
      if (ch === strChar && inner[i-1] !== "\\") inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = true; strChar = ch; cur += ch; continue; }
    if (ch === "(") { depth++; cur += ch; continue; }
    if (ch === ")") { depth--; cur += ch; continue; }
    if (ch === "," && depth === 0) {
      const trimmed = cur.trim();
      if (trimmed && !trimmed.toUpperCase().startsWith("PRIMARY KEY") &&
          !trimmed.toUpperCase().startsWith("UNIQUE") &&
          !trimmed.toUpperCase().startsWith("CHECK") &&
          !trimmed.toUpperCase().startsWith("FOREIGN KEY") &&
          !trimmed.toUpperCase().startsWith("CONSTRAINT")) {
        const colMatch = trimmed.match(/^`?"?([^`"\s]+)`?"?\s*(\w+)?/);
        if (colMatch) {
          cols.push({
            name:       colMatch[1].replace(/["`]/g, ""),
            type:       (colMatch[2] || "TEXT").toUpperCase(),
            definition: trimmed,
          });
        }
      }
      cur = "";
      continue;
    }
    cur += ch;
  }
  // Last column
  const trimmed = cur.trim();
  if (trimmed && !trimmed.toUpperCase().startsWith("PRIMARY KEY") &&
      !trimmed.toUpperCase().startsWith("UNIQUE") &&
      !trimmed.toUpperCase().startsWith("CHECK") &&
      !trimmed.toUpperCase().startsWith("FOREIGN KEY") &&
      !trimmed.toUpperCase().startsWith("CONSTRAINT")) {
    const colMatch = trimmed.match(/^`?"?([^`"\s]+)`?"?\s*(\w+)?/);
    if (colMatch) {
      cols.push({
        name:       colMatch[1].replace(/["`]/g, ""),
        type:       (colMatch[2] || "TEXT").toUpperCase(),
        definition: trimmed,
      });
    }
  }
  return cols;
}

// ══════════════════════════════════════════════════════════════════════════════
// SQL QUERY EXECUTOR (SELECT-only, pure JS)
// ══════════════════════════════════════════════════════════════════════════════

// Minimal SQL tokenizer for SELECT parsing
function tokenizeSQL(sql) {
  const tokens = [];
  let i = 0;
  const s = sql.trim();
  while (i < s.length) {
    // Skip whitespace
    if (/\s/.test(s[i])) { i++; continue; }
    // String literal
    if (s[i] === "'" || s[i] === '"' || s[i] === '`') {
      const q = s[i]; let tok = q; i++;
      while (i < s.length) {
        if (s[i] === q) { tok += q; i++; break; }
        if (s[i] === "\\" && i+1 < s.length) { tok += s[i] + s[i+1]; i += 2; }
        else { tok += s[i++]; }
      }
      tokens.push({ type: "string", value: tok.slice(1, -1) });
      continue;
    }
    // Number
    if (/[0-9]/.test(s[i]) || (s[i] === "-" && /[0-9]/.test(s[i+1]))) {
      let tok = ""; if (s[i] === "-") tok = s[i++];
      while (i < s.length && /[0-9.]/.test(s[i])) tok += s[i++];
      tokens.push({ type: "number", value: parseFloat(tok) });
      continue;
    }
    // Operators
    if (">=<!".includes(s[i])) {
      let op = s[i++];
      if (i < s.length && ">=<".includes(s[i])) op += s[i++];
      tokens.push({ type: "op", value: op });
      continue;
    }
    // Punct
    if (",;().*".includes(s[i])) { tokens.push({ type: "punct", value: s[i++] }); continue; }
    // Word/identifier
    let tok = "";
    while (i < s.length && !/[\s,;()='"\`<>=!*]/.test(s[i])) tok += s[i++];
    if (tok) tokens.push({ type: "word", value: tok });
  }
  return tokens;
}

// Parse SELECT statement: SELECT [cols] FROM [table] [WHERE ...] [ORDER BY ...] [LIMIT n] [OFFSET m]
function parseSelect(sql) {
  const tokens = tokenizeSQL(sql);
  let pos = 0;
  const peek = () => tokens[pos];
  const consume = () => tokens[pos++];
  const expectWord = (word) => {
    const t = consume();
    if (!t || t.value.toUpperCase() !== word.toUpperCase())
      throw new ToolError(`sqlite_client: Expected '${word}' in query, got '${t?.value}'.`, -32602);
  };

  expectWord("SELECT");

  // ── FIX Bug 1: Column list parser ──────────────────────────────────────
  // Previously, punct tokens like '(' ')' '*' inside function calls such as
  // COUNT(*) were each treated as separate column names, producing phantom
  // columns [COUNT, (, *, )] instead of one column [COUNT(*)].
  // Fix: skip bare punct separators; when a word is followed by '(' consume
  // the entire argument list through the matching ')' as one expression.
  const columns = [];
  if (peek()?.value === "*") {
    consume();
    columns.push("*");
  } else {
    while (pos < tokens.length) {
      const t = peek();
      if (!t) break;
      // Stop at FROM keyword
      if (t.type === "word" && t.value.toUpperCase() === "FROM") break;
      // Skip comma separators and other stray punct between columns
      if (t.type === "punct" && t.value !== "*") { consume(); continue; }
      // Consume the column name or function name
      const col = consume();
      // Ignore lone punct that slipped through
      if (col.type === "punct" && col.value !== "*") continue;
      let colName = col.value;
      // If next token is '(', this is a function call — consume through matching ')'
      // e.g. COUNT(*), MAX(id), COALESCE(a, b)
      if (peek()?.type === "punct" && peek()?.value === "(") {
        let expr = colName + "(";
        consume(); // consume '('
        let depth = 1;
        while (pos < tokens.length && depth > 0) {
          const inner = consume();
          if (inner.value === "(") { depth++; expr += "("; }
          else if (inner.value === ")") { depth--; expr += ")"; }
          else { expr += inner.value; }
        }
        colName = expr; // e.g. "COUNT(*)"
      }
      // Handle table.column notation: tbl.col
      if (peek()?.value === ".") { consume(); const sub = consume(); colName = sub?.value || colName; }
      // Optional alias: [AS] alias_name
      let alias = colName;
      if (peek()?.value?.toUpperCase() === "AS") { consume(); alias = consume()?.value || colName; }
      columns.push({ col: colName, alias });
    }
    if (columns.length === 0) throw new ToolError("sqlite_client: SELECT requires column list or *.", -32602);
  }

  expectWord("FROM");
  const tableName = consume()?.value;
  if (!tableName) throw new ToolError("sqlite_client: SELECT requires a table name after FROM.", -32602);

  // Optional WHERE
  let whereClause = null;
  if (peek()?.value?.toUpperCase() === "WHERE") {
    consume(); // consume WHERE
    // Collect tokens until LIMIT, OFFSET, ORDER, GROUP, or end
    const stopWords = ["LIMIT", "OFFSET", "ORDER", "GROUP", "HAVING"];
    const whereToks = [];
    while (pos < tokens.length) {
      const pv = peek();
      if (pv && typeof pv.value === "string" && stopWords.includes(pv.value.toUpperCase())) break;
      whereToks.push(consume());
    }
    whereClause = whereToks;
  }

  // Optional ORDER BY
  let orderBy = null;
  if (peek()?.value?.toUpperCase() === "ORDER") {
    consume();
    if (peek()?.value?.toUpperCase() === "BY") consume();
    const col = consume()?.value;
    const dir = peek()?.value?.toUpperCase() === "DESC" ? (consume(), "DESC") : "ASC";
    orderBy = { col, dir };
  }

  // Optional LIMIT
  let limit = null;
  if (peek()?.value?.toUpperCase() === "LIMIT") {
    consume();
    limit = Number(consume()?.value);
  }

  // Optional OFFSET
  let offset = 0;
  if (peek()?.value?.toUpperCase() === "OFFSET") {
    consume();
    offset = Number(consume()?.value);
  }

  return { columns, tableName, whereClause, orderBy, limit, offset };
}

// Evaluate a WHERE clause token list against a row object
function evaluateWhere(whereToks, rowObj) {
  if (!whereToks || whereToks.length === 0) return true;
  // Support: col OP value AND/OR col OP value ...
  try {
    let result = true;
    let combinator = "AND";
    let i = 0;
    while (i < whereToks.length) {
      const t = whereToks[i];
      if (t.type === "word" && (t.value.toUpperCase() === "AND" || t.value.toUpperCase() === "OR")) {
        combinator = t.value.toUpperCase();
        i++; continue;
      }
      // Expect: col op value
      if (i + 2 >= whereToks.length) { i++; continue; }
      const colTok  = whereToks[i];
      const opTok   = whereToks[i+1];
      const valTok  = whereToks[i+2];
      i += 3;

      const colName = colTok.value;
      const op      = opTok.value;
      const rawVal  = valTok.type === "number" ? valTok.value : valTok.value;
      const colVal  = rowObj[colName] ?? rowObj[colName.toUpperCase()] ?? rowObj[colName.toLowerCase()];

      let cmp;
      const numVal = Number(rawVal);
      const colNum = Number(colVal);
      const useNum = !isNaN(numVal) && !isNaN(colNum);

      switch (op) {
        case "=": case "==":  cmp = useNum ? colNum === numVal : String(colVal ?? "").toLowerCase() === String(rawVal).toLowerCase(); break;
        case "!=": case "<>": cmp = useNum ? colNum !== numVal : String(colVal ?? "").toLowerCase() !== String(rawVal).toLowerCase(); break;
        case ">": cmp = useNum ? colNum > numVal : String(colVal ?? "") > String(rawVal); break;
        case ">=": cmp = useNum ? colNum >= numVal : String(colVal ?? "") >= String(rawVal); break;
        case "<": cmp = useNum ? colNum < numVal : String(colVal ?? "") < String(rawVal); break;
        case "<=": cmp = useNum ? colNum <= numVal : String(colVal ?? "") <= String(rawVal); break;
        default: cmp = true;
      }

      if (combinator === "OR")  result = result || cmp;
      else                       result = result && cmp;
    }
    return result;
  } catch {
    return true; // on error, don't filter
  }
}

// ── Execute a SELECT query against the database ───────────────────────────
function executeSelect(parsed, schema, dbBuf, pageSize, encoding) {
  const { columns, tableName, whereClause, orderBy, limit, offset } = parsed;

  // Find the table in schema
  const tableEntry = schema.find(
    e => e.type === "table" && e.name.toLowerCase() === tableName.toLowerCase()
  );
  if (!tableEntry)
    throw new ToolError(`sqlite_client: Table '${tableName}' not found. Available tables: ${schema.filter(e=>e.type==="table").map(e=>e.name).join(", ") || "(none)"}.`, -32602);

  // Parse columns from CREATE TABLE
  const colDefs = parseCreateTable(tableEntry.sql);
  const colNames = colDefs.map(c => c.name);

  // Read all rows from the table's root page
  const maxRead = Math.min((limit ?? MAX_ROWS) + offset + 1, MAX_ROWS);
  const rawRows = readTableRows(dbBuf, tableEntry.rootpage, pageSize, encoding, maxRead);

  // Detect INTEGER PRIMARY KEY — this column IS the rowid and is NOT stored in the payload
  // When such a column exists, values[] starts at the NEXT column
  const pkCol = colDefs.find(c => /INTEGER\s+PRIMARY\s+KEY/i.test(c.definition));
  const hasRowidPK = !!pkCol;

  // Convert raw rows to objects
  let objRows = rawRows.map(row => {
    const obj = {};
    if (hasRowidPK) {
      // Inject rowid as the PK column value, then map remaining values
      let valIdx = 0;
      for (let i = 0; i < colNames.length; i++) {
        if (colNames[i] === pkCol.name) {
          obj[colNames[i]] = row.rowid;
        } else {
          obj[colNames[i]] = row.values[valIdx++] ?? null;
        }
      }
    } else {
      for (let i = 0; i < colNames.length; i++) {
        obj[colNames[i]] = row.values[i] ?? null;
      }
    }
    obj._rowid_ = row.rowid;
    return obj;
  });

  // WHERE filter
  if (whereClause && whereClause.length > 0) {
    objRows = objRows.filter(row => evaluateWhere(whereClause, row));
  }

  // ORDER BY
  if (orderBy) {
    const { col, dir } = orderBy;
    objRows.sort((a, b) => {
      const av = a[col] ?? a[col.toLowerCase()] ?? null;
      const bv = b[col] ?? b[col.toLowerCase()] ?? null;
      const aNum = Number(av), bNum = Number(bv);
      const useNum = !isNaN(aNum) && !isNaN(bNum);
      let cmp = 0;
      if (useNum) cmp = aNum - bNum;
      else cmp = String(av ?? "") < String(bv ?? "") ? -1 : String(av ?? "") > String(bv ?? "") ? 1 : 0;
      return dir === "DESC" ? -cmp : cmp;
    });
  }

  // OFFSET + LIMIT
  const totalFiltered = objRows.length;
  if (offset > 0) objRows = objRows.slice(offset);
  if (limit != null) objRows = objRows.slice(0, limit);

  // Project columns
  let resultCols = colNames;
  let projected;
  if (columns[0] === "*") {
    projected = objRows.map(r => {
      const out = {};
      for (const c of colNames) out[c] = r[c] ?? null;
      return out;
    });
  } else {
    resultCols = columns.map(c => (typeof c === "string" ? c : c.alias));
    projected = objRows.map(r => {
      const out = {};
      for (const c of columns) {
        const colKey = typeof c === "string" ? c : c.col;
        const alias  = typeof c === "string" ? c : c.alias;
        out[alias] = r[colKey] ?? r[colKey.toLowerCase()] ?? null;
      }
      return out;
    });
  }

  return { columns: resultCols, totalFiltered, rows: projected };
}

// ══════════════════════════════════════════════════════════════════════════════
// WRITE OPERATIONS: execute INSERT/UPDATE/DELETE via sqlite3 CLI
// ══════════════════════════════════════════════════════════════════════════════

// Note: True SQLite binary-level write is extremely complex.
// We use a safe approach: delegate actual write operations to Node's
// child_process with sqlite3 CLI if available, otherwise error with guidance.
// READ operations are always pure Node.js (no external deps).

function runWithSqliteCLI(dbPath, sql, timeout) {
  const { spawnSync } = require("child_process");
  const t = Math.max(1000, Math.min(timeout || 30000, 300000));

  // Check if sqlite3 CLI is available
  const which = spawnSync(process.platform === "win32" ? "where" : "which",
    ["sqlite3"], { encoding: "utf8", timeout: 2000 });
  if (which.status !== 0)
    throw new ToolError(
      "sqlite_client: Write operations (execute) require the 'sqlite3' CLI to be installed on the system PATH. " +
      "Install it (e.g. 'apt install sqlite3' or 'brew install sqlite3') and retry, or use the stateful " +
      "'sqlite_connect' + 'sqlite_execute' tools for write access.",
      -32602
    );

  const result = spawnSync("sqlite3", [dbPath, sql], {
    encoding: "utf8",
    timeout:  t,
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.status !== 0 || result.error)
    throw new ToolError(
      `sqlite_client: sqlite3 CLI error: ${result.stderr?.trim() || result.error?.message || "unknown error"}.`,
      -32603
    );

  return result.stdout?.trim() || "";
}

// ── FIX Bug 2: WAL checkpoint before read ────────────────────────────────
// When sqlite3 CLI writes to a database in WAL mode, changes go to a -wal
// sidecar file first and are only merged back to the main .db file on
// checkpoint. Our pure-JS reader only reads the main file, so it would see
// stale data until a checkpoint occurs. Fix: if a -wal file exists beside
// the database, run PRAGMA wal_checkpoint(FULL) via the CLI before reading,
// which flushes all WAL frames back into the main database file.
function ensureWalCheckpoint(resolvedDbPath) {
  const walPath = resolvedDbPath + "-wal";
  let walExists = false;
  try { fs.statSync(walPath); walExists = true; } catch { /* no WAL file */ }
  if (!walExists) return; // nothing to do

  const { spawnSync } = require("child_process");
  // Check sqlite3 CLI availability — if not present, skip silently
  // (reads may be stale but we don't want to error on a read operation)
  const which = spawnSync(process.platform === "win32" ? "where" : "which",
    ["sqlite3"], { encoding: "utf8", timeout: 2000 });
  if (which.status !== 0) return; // sqlite3 not available, skip

  spawnSync("sqlite3", [resolvedDbPath, "PRAGMA wal_checkpoint(FULL);"], {
    encoding: "utf8",
    timeout:  10000,
    maxBuffer: 1024 * 1024,
  });
  // Ignore checkpoint errors — the read will proceed with whatever is in .db
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN sqlite_client OPERATIONS
// ══════════════════════════════════════════════════════════════════════════════

function loadDb(filePath) {
  if (!filePath || typeof filePath !== "string")
    throw new ToolError("sqlite_client: 'path' must be a non-empty string.", -32602);
  if (filePath.includes("\0"))
    throw new ToolError("sqlite_client: 'path' must not contain NUL bytes.", -32602);

  let resolved;
  try { resolved = path.resolve(filePath); } catch {
    throw new ToolError(`sqlite_client: Cannot resolve path '${filePath}'.`, -32602);
  }

  let stat;
  try { stat = fs.statSync(resolved); } catch (e) {
    throw new ToolError(`sqlite_client: Cannot access '${filePath}': ${e.message}`, -32602);
  }
  if (stat.isDirectory())
    throw new ToolError(`sqlite_client: '${filePath}' is a directory, not a file.`, -32602);
  if (stat.size > MAX_FILE_SIZE)
    throw new ToolError(
      `sqlite_client: File too large (${stat.size} bytes; limit ${MAX_FILE_SIZE}).`, -32602
    );

  // FIX Bug 2: Flush any pending WAL frames before reading the main file
  ensureWalCheckpoint(resolved);

  const buf = fs.readFileSync(resolved);
  const header = parseFileHeader(buf);
  return { buf, header, resolved, stat };
}

// ── op: info ──────────────────────────────────────────────────────────────
function opInfo(args) {
  const { buf, header, stat, resolved } = loadDb(args.path);
  const schema = parseSchema(buf, header.pageSize, header.textEncoding);

  const tables  = schema.filter(e => e.type === "table");
  const views   = schema.filter(e => e.type === "view");
  const indexes = schema.filter(e => e.type === "index");
  const triggers = schema.filter(e => e.type === "trigger");

  const encodingName = header.textEncoding === 2 ? "UTF-16le" : header.textEncoding === 3 ? "UTF-16be" : "UTF-8";
  const versionStr = `${Math.floor(header.sqliteVersion / 1000000)}.${Math.floor((header.sqliteVersion % 1000000) / 1000)}.${header.sqliteVersion % 1000}`;

  return {
    operation:       "info",
    path:            args.path,
    fileSize:        stat.size,
    pageSize:        header.pageSize,
    pageCount:       header.pageCount,
    freePages:       header.freePageCount,
    encoding:        encodingName,
    applicationId:   header.applicationId,
    userVersion:     header.userVersion,
    schemaFormat:    header.schemaFormat,
    sqliteVersion:   versionStr,
    changeCounter:   header.changeCounter,
    schemaCookie:    header.schemaCookie,
    writeVersion:    header.writeVersion,
    readVersion:     header.readVersion,
    tableCounts: {
      tables:   tables.length,
      views:    views.length,
      indexes:  indexes.length,
      triggers: triggers.length,
    },
    tables:   tables.map(t => t.name),
    views:    views.map(v => v.name),
    indexes:  indexes.map(i => ({ name: i.name, table: i.tbl_name })),
    triggers: triggers.map(t => ({ name: t.name, table: t.tbl_name })),
  };
}

// ── op: tables ────────────────────────────────────────────────────────────
function opTables(args) {
  const { buf, header } = loadDb(args.path);
  const schema = parseSchema(buf, header.pageSize, header.textEncoding);
  const type = (args.type || "table").toLowerCase();
  const entries = schema.filter(e => e.type === type);

  return {
    operation: "tables",
    path: args.path,
    type,
    count: entries.length,
    tables: entries.map(e => ({
      name:     e.name,
      rootpage: e.rootpage,
    })),
  };
}

// ── op: schema ────────────────────────────────────────────────────────────
function opSchema(args) {
  const { buf, header } = loadDb(args.path);
  const schema = parseSchema(buf, header.pageSize, header.textEncoding);

  let entries = schema;
  if (args.table) {
    const tname = args.table.toLowerCase();
    entries = schema.filter(e => e.name.toLowerCase() === tname || e.tbl_name.toLowerCase() === tname);
    if (entries.length === 0)
      throw new ToolError(`sqlite_client: No schema entries found for '${args.table}'. Available tables: ${schema.filter(e=>e.type==="table").map(e=>e.name).join(", ") || "(none)"}.`, -32602);
  }

  const result = entries.map(e => {
    const base = { type: e.type, name: e.name, tbl_name: e.tbl_name, rootpage: e.rootpage };
    if (e.type === "table" && e.sql) {
      base.sql = e.sql;
      base.columns = parseCreateTable(e.sql);
    } else if (e.sql) {
      base.sql = e.sql;
    }
    return base;
  });

  return {
    operation: "schema",
    path: args.path,
    table: args.table || null,
    count: result.length,
    schema: result,
  };
}

// ── op: query ─────────────────────────────────────────────────────────────
function opQuery(args) {
  if (!args.sql || typeof args.sql !== "string")
    throw new ToolError("sqlite_client: 'sql' is required for 'query' operation.", -32602);

  const sql = args.sql.trim();
  if (!sql.toUpperCase().startsWith("SELECT"))
    throw new ToolError("sqlite_client: 'query' only supports SELECT statements. Use 'execute' for INSERT/UPDATE/DELETE.", -32602);

  // loadDb now calls ensureWalCheckpoint internally (Bug 2 fix)
  const { buf, header } = loadDb(args.path);
  const schema = parseSchema(buf, header.pageSize, header.textEncoding);

  let parsed;
  try {
    parsed = parseSelect(sql);
  } catch (e) {
    throw new ToolError(`sqlite_client: SQL parse error: ${e.message}`, -32602);
  }

  const { columns, totalFiltered, rows } = executeSelect(
    parsed, schema, buf, header.pageSize, header.textEncoding
  );

  const maxR = Math.min(args.max_rows ?? MAX_ROWS, MAX_ROWS);
  const truncated = rows.length > maxR;
  const resultRows = truncated ? rows.slice(0, maxR) : rows;

  return {
    operation:     "query",
    path:          args.path,
    sql,
    columns,
    totalFiltered,
    rowCount:      resultRows.length,
    truncated,
    rows: resultRows,
  };
}

// ── op: execute ───────────────────────────────────────────────────────────
function opExecute(args) {
  if (!args.sql || typeof args.sql !== "string")
    throw new ToolError("sqlite_client: 'sql' is required for 'execute' operation.", -32602);

  const sql = args.sql.trim();
  const upperSql = sql.toUpperCase();

  // Safety: block dangerous statements
  if (upperSql.startsWith("DROP DATABASE") || upperSql.startsWith("ATTACH") || upperSql.startsWith("DETACH"))
    throw new ToolError("sqlite_client: 'execute' does not allow DROP DATABASE, ATTACH, or DETACH statements.", -32602);

  // Resolve the path
  if (!args.path || typeof args.path !== "string")
    throw new ToolError("sqlite_client: 'path' is required.", -32602);
  if (args.path.includes("\0"))
    throw new ToolError("sqlite_client: 'path' must not contain NUL bytes.", -32602);

  const resolved = path.resolve(args.path);

  // Check if file exists (for write ops it may or may not exist)
  let fileExists = false;
  try { fs.statSync(resolved); fileExists = true; } catch { /* new file */ }

  const output = runWithSqliteCLI(resolved, sql, args.timeout);

  return {
    operation:   "execute",
    path:        args.path,
    sql,
    output:      output || null,
    rowsAffected: null, // sqlite3 CLI doesn't report this by default
    note:        "Write operations delegated to sqlite3 CLI.",
  };
}

// ── op: export ────────────────────────────────────────────────────────────
function opExport(args) {
  // loadDb calls ensureWalCheckpoint (Bug 2 fix)
  const { buf, header } = loadDb(args.path);
  const schema = parseSchema(buf, header.pageSize, header.textEncoding);

  if (!args.table)
    throw new ToolError("sqlite_client: 'table' is required for 'export' operation.", -32602);

  const tableEntry = schema.find(
    e => e.type === "table" && e.name.toLowerCase() === args.table.toLowerCase()
  );
  if (!tableEntry)
    throw new ToolError(`sqlite_client: Table '${args.table}' not found. Available: ${schema.filter(e=>e.type==="table").map(e=>e.name).join(", ") || "(none)"}.`, -32602);

  const colDefs  = parseCreateTable(tableEntry.sql);
  const colNames = colDefs.map(c => c.name);
  const maxR     = Math.min(args.max_rows ?? MAX_EXPORT_ROWS, MAX_EXPORT_ROWS);

  const rawRows = readTableRows(buf, tableEntry.rootpage, header.pageSize, header.textEncoding, maxR + 1);
  const truncated = rawRows.length > maxR;
  const usedRows  = truncated ? rawRows.slice(0, maxR) : rawRows;

  // Detect INTEGER PRIMARY KEY (rowid alias — not stored in payload)
  const pkColDef = colDefs.find(c => /INTEGER\s+PRIMARY\s+KEY/i.test(c.definition));
  const hasRowidPK = !!pkColDef;

  // Build row-to-object helper respecting rowid PK
  function rowToObj(row) {
    const obj = {};
    if (hasRowidPK) {
      let valIdx = 0;
      for (let i = 0; i < colNames.length; i++) {
        if (colNames[i] === pkColDef.name) obj[colNames[i]] = row.rowid;
        else obj[colNames[i]] = row.values[valIdx++] ?? null;
      }
    } else {
      for (let i = 0; i < colNames.length; i++) obj[colNames[i]] = row.values[i] ?? null;
    }
    return obj;
  }

  const format = (args.format || "json").toLowerCase();

  if (format === "csv") {
    const escCsv = v => {
      if (v == null) return "";
      const s = String(v);
      if (s.includes(",") || s.includes('"') || s.includes("\n")) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };
    const lines = [];
    if (args.header !== false) lines.push(colNames.map(escCsv).join(","));
    for (const row of usedRows) {
      const obj = rowToObj(row);
      const vals = colNames.map(c => escCsv(obj[c] ?? null));
      lines.push(vals.join(","));
    }
    const csv = lines.join("\n");
    if (args.output_file) {
      const outPath = path.resolve(args.output_file);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, csv, "utf8");
      return { operation: "export", path: args.path, table: args.table, format: "csv",
               rowCount: usedRows.length, truncated, output_file: args.output_file, bytes: csv.length };
    }
    return { operation: "export", path: args.path, table: args.table, format: "csv",
             rowCount: usedRows.length, truncated, bytes: csv.length, data: csv };
  }

  // Default: JSON
  const rows = usedRows.map(rowToObj);
  const pretty = args.pretty !== false;
  const jsonStr = JSON.stringify({ table: args.table, columns: colNames, rows }, null, pretty ? 2 : 0);

  if (args.output_file) {
    const outPath = path.resolve(args.output_file);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, jsonStr, "utf8");
    return { operation: "export", path: args.path, table: args.table, format: "json",
             rowCount: usedRows.length, truncated, output_file: args.output_file, bytes: jsonStr.length };
  }
  return { operation: "export", path: args.path, table: args.table, format: "json",
           rowCount: usedRows.length, truncated, columns: colNames, bytes: jsonStr.length, data: jsonStr };
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ══════════════════════════════════════════════════════════════════════════════

function sqliteClient(args) {
  const op = (args.operation || "").trim();
  const VALID_OPS = ["info", "tables", "schema", "query", "execute", "export"];
  if (!op)
    throw new ToolError(
      `sqlite_client: 'operation' is required. Valid: ${VALID_OPS.join(", ")}.`, -32602
    );
  if (!VALID_OPS.includes(op))
    throw new ToolError(
      `sqlite_client: Unknown operation '${op}'. Valid: ${VALID_OPS.join(", ")}.`, -32602
    );

  switch (op) {
    case "info":    return opInfo(args);
    case "tables":  return opTables(args);
    case "schema":  return opSchema(args);
    case "query":   return opQuery(args);
    case "execute": return opExecute(args);
    case "export":  return opExport(args);
    default:
      throw new ToolError(`sqlite_client: Unhandled operation '${op}'.`, -32603);
  }
}

module.exports = { sqliteClient };
