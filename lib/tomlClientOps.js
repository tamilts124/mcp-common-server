"use strict";
// lib/tomlClientOps.js — Zero-dependency TOML v1.0 parser/writer
// Pure Node.js fs only. No npm dependencies.
//
// Supported operations:
//   read          — parse a TOML file into a JS object
//   get           — get a value at a dotted key path
//   set           — set/update a value at a dotted key path and rewrite file
//   delete        — remove a key at a dotted key path and rewrite file
//   list_keys     — list all top-level or section keys
//   list_sections — list all [table] and [[array-of-tables]] headers
//   merge         — merge two TOML files (second overrides first)
//   stringify     — convert a JS object to TOML string
//
// Parser supports (TOML v1.0):
//   - Basic strings (double-quoted, escape sequences)
//   - Literal strings (single-quoted, no escapes)
//   - Multiline basic strings ("""...""")
//   - Multiline literal strings ('''...''')
//   - Integers (decimal, hex 0x, octal 0o, binary 0b, underscores)
//   - Floats (decimal, e-notation, inf, nan)
//   - Booleans (true/false)
//   - Offset date-times, local date-times, local dates, local times
//   - Arrays (inline and multiline)
//   - Inline tables ({key = val, ...})
//   - Standard tables ([section])
//   - Array of tables ([[section]])
//   - Dotted keys (a.b.c = 1)
//   - Comments (#)

const fs   = require("fs");
const path = require("path");

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_FILE_SIZE  = 4 * 1024 * 1024;   // 4 MB
const MAX_KEY_DEPTH  = 20;                 // dotted key nesting limit
const MAX_KEYS       = 50000;              // total key limit

// ─── Path validation ──────────────────────────────────────────────────────────

function validatePath(p) {
  if (typeof p !== "string" || p.trim() === "")
    throw new Error("toml_client: path must be a non-empty string.");
  if (/[\x00]/.test(p))
    throw new Error("toml_client: path contains NUL byte.");
  return path.resolve(p);
}

// ─── TOML Parser ──────────────────────────────────────────────────────────────

class TomlParser {
  constructor(src) {
    this.src   = src;
    this.pos   = 0;
    this.line  = 1;
    this.root  = Object.create(null);
    // Track implicit tables created by dotted keys to allow later expansion
    this.implicitTables = new Set();   // dotted paths of implicit tables
    this.currentTable  = this.root;
    this.currentPath   = [];           // [] = root
    this.keyCount      = 0;
    // Track defined table paths to detect redefinition
    this.definedTables = new Set();
    this.arrayTables   = new Map();    // path -> count
  }

  error(msg) {
    throw new Error(`toml_client: parse error at line ${this.line}: ${msg}`);
  }

  // ── Character helpers ──────────────────────────────────────────────────────

  peek(offset = 0)  { return this.src[this.pos + offset]; }
  cur()             { return this.src[this.pos]; }
  eof()             { return this.pos >= this.src.length; }

  advance() {
    const ch = this.src[this.pos++];
    if (ch === "\n") this.line++;
    return ch;
  }

  expect(ch) {
    if (this.cur() !== ch)
      this.error(`expected '${ch}' but got '${this.cur() ?? "EOF"}' `);
    this.advance();
  }

  // ── Whitespace / comment ───────────────────────────────────────────────────

  skipWS() {
    while (!this.eof() && (this.cur() === " " || this.cur() === "\t"))
      this.advance();
  }

  skipWSNL() {
    while (!this.eof()) {
      const ch = this.cur();
      if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n")
        this.advance();
      else if (ch === "#") { this.skipComment(); }
      else break;
    }
  }

  skipComment() {
    while (!this.eof() && this.cur() !== "\n") this.advance();
  }

  skipLineEnd() {
    this.skipWS();
    if (!this.eof() && this.cur() === "#") this.skipComment();
    if (!this.eof()) {
      if (this.cur() === "\r") this.advance();
      if (this.cur() === "\n") this.advance();
      else if (!this.eof())
        this.error("expected newline after key-value pair");
    }
  }

  // ── Key parsing ───────────────────────────────────────────────────────────

  parseBareKey() {
    const start = this.pos;
    while (!this.eof() && /[A-Za-z0-9_\-]/.test(this.cur()))
      this.advance();
    if (this.pos === start)
      this.error(`expected key character, got '${this.cur() ?? "EOF"}' `);
    return this.src.slice(start, this.pos);
  }

  parseKey() {
    // Returns array of key parts (handles dotted keys: a.b.c)
    const parts = [];
    while (true) {
      this.skipWS();
      if (this.cur() === "\"") parts.push(this.parseBasicString());
      else if (this.cur() === "'") parts.push(this.parseLiteralString());
      else parts.push(this.parseBareKey());
      this.skipWS();
      if (this.cur() === ".") { this.advance(); continue; }
      break;
    }
    if (parts.length > MAX_KEY_DEPTH)
      this.error(`key nesting too deep (max ${MAX_KEY_DEPTH})`);
    return parts;
  }

  // ── Value parsing ─────────────────────────────────────────────────────────

  parseValue() {
    this.skipWS();
    const ch = this.cur();

    if (ch === "\"") {
      if (this.peek(1) === "\"" && this.peek(2) === "\"")
        return this.parseMultilineBasicString();
      return this.parseBasicString();
    }
    if (ch === "'") {
      if (this.peek(1) === "'" && this.peek(2) === "'")
        return this.parseMultilineLiteralString();
      return this.parseLiteralString();
    }
    if (ch === "[")
      return this.parseArray();
    if (ch === "{")
      return this.parseInlineTable();
    if (ch === "t" && this.src.startsWith("true", this.pos)) {
      this.pos += 4; return true;
    }
    if (ch === "f" && this.src.startsWith("false", this.pos)) {
      this.pos += 5; return false;
    }
    return this.parseNumberOrDate();
  }

  // Basic string: double-quoted with escape processing
  parseBasicString() {
    this.expect("\"");
    let out = "";
    while (!this.eof() && this.cur() !== "\"") {
      if (this.cur() === "\n" || this.cur() === "\r")
        this.error("newline in basic string");
      if (this.cur() === "\\") {
        this.advance();
        out += this.parseEscape();
      } else {
        out += this.advance();
      }
    }
    this.expect("\"");
    return out;
  }

  parseEscape() {
    const ch = this.advance();
    switch (ch) {
      case "b":  return "\b";
      case "t":  return "\t";
      case "n":  return "\n";
      case "f":  return "\f";
      case "r":  return "\r";
      case "\"": return "\"";
      case "\\": return "\\";
      case "u":  return this.parseUnicodeEscape(4);
      case "U":  return this.parseUnicodeEscape(8);
      default:
        this.error(`invalid escape sequence: \\${ch}`);
    }
  }

  parseUnicodeEscape(len) {
    let hex = "";
    for (let i = 0; i < len; i++) {
      if (!/[0-9A-Fa-f]/.test(this.cur()))
        this.error(`expected hex digit in \\u/\\U escape`);
      hex += this.advance();
    }
    const cp = parseInt(hex, 16);
    return String.fromCodePoint(cp);
  }

  // Literal string: single-quoted, no escapes
  parseLiteralString() {
    this.expect("'");
    let out = "";
    while (!this.eof() && this.cur() !== "'") {
      if (this.cur() === "\n" || this.cur() === "\r")
        this.error("newline in literal string");
      out += this.advance();
    }
    this.expect("'");
    return out;
  }

  // Multiline basic string: """...""" with line trimming
  parseMultilineBasicString() {
    this.pos += 3; // consume """
    // Skip immediate newline after opening delimiter
    if (this.cur() === "\r") this.advance();
    if (this.cur() === "\n") { this.line++; this.advance(); }
    let out = "";
    while (!this.eof()) {
      if (this.cur() === "\"" && this.peek(1) === "\"" && this.peek(2) === "\"") {
        // Handle up to 2 extra quotes before closing
        this.pos += 3;
        // Allow """" and """"" but not more
        if (this.cur() === "\"") { out += "\""; this.advance(); }
        if (this.cur() === "\"") { out += "\""; this.advance(); }
        return out;
      }
      if (this.cur() === "\\") {
        this.advance();
        // Line ending backslash: skip whitespace+newlines
        if (this.cur() === "\n" || this.cur() === "\r" || this.cur() === " " || this.cur() === "\t") {
          while (!this.eof() && (this.cur() === " " || this.cur() === "\t" || this.cur() === "\r" || this.cur() === "\n")) {
            if (this.cur() === "\n") this.line++;
            this.advance();
          }
        } else {
          out += this.parseEscape();
        }
        continue;
      }
      const ch = this.advance();
      if (ch === "\n") this.line++;
      out += ch;
    }
    this.error("unterminated multiline basic string");
  }

  // Multiline literal string: '''...'''
  parseMultilineLiteralString() {
    this.pos += 3; // consume '''
    if (this.cur() === "\r") this.advance();
    if (this.cur() === "\n") { this.line++; this.advance(); }
    let out = "";
    while (!this.eof()) {
      if (this.cur() === "'" && this.peek(1) === "'" && this.peek(2) === "'") {
        this.pos += 3;
        if (this.cur() === "'") { out += "'"; this.advance(); }
        if (this.cur() === "'") { out += "'"; this.advance(); }
        return out;
      }
      const ch = this.advance();
      if (ch === "\n") this.line++;
      out += ch;
    }
    this.error("unterminated multiline literal string");
  }

  // Numbers, floats, dates
  parseNumberOrDate() {
    // Collect the raw token
    const start = this.pos;
    // Optional sign
    if (this.cur() === "+" || this.cur() === "-") this.advance();

    // Hex / octal / binary integers
    if (this.cur() === "0" && /[xXoObB]/.test(this.peek(1) ?? "")) {
      const prefix = this.advance() + this.advance(); // "0x"
      const numStart = this.pos;
      while (!this.eof() && /[0-9A-Fa-f_]/.test(this.cur())) this.advance();
      const digits = this.src.slice(numStart, this.pos).replace(/_/g, "");
      const base = prefix[1].toLowerCase();
      if (base === "x") return parseInt(digits, 16);
      if (base === "o") return parseInt(digits, 8);
      if (base === "b") return parseInt(digits, 2);
    }

    // Special float literals: inf, nan (with optional leading sign already consumed)
    const rest = this.src.slice(this.pos);
    if (rest.startsWith("inf"))  { this.pos += 3; return this.src[start] === "-" ? -Infinity : Infinity; }
    if (rest.startsWith("nan"))  { this.pos += 3; return NaN; }

    // Consume remaining number/date characters
    while (!this.eof() && /[0-9A-Za-z:+.\-_TZ]/.test(this.cur())) this.advance();
    const raw = this.src.slice(start, this.pos);

    // Detect date/time: contains '-' in date position OR 'T' or ':'
    // RFC 3339 / TOML date patterns
    if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
      const d = new Date(raw);
      if (!isNaN(d.getTime())) return d;
      // Local date (no time)
      if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
      return raw; // Return as string if not parseable
    }
    if (/^\d{2}:\d{2}:\d{2}/.test(raw)) return raw; // local time string

    // Float detection
    const noUnder = raw.replace(/_/g, "");
    if (noUnder.includes(".") || /[eE]/.test(noUnder)) {
      const f = parseFloat(noUnder);
      if (isNaN(f) && noUnder !== "nan") this.error(`invalid float: ${raw}`);
      return f;
    }

    // Integer
    const n = parseInt(noUnder, 10);
    if (isNaN(n)) this.error(`invalid number: ${raw}`);
    // Use BigInt for large integers beyond safe integer range
    if (Math.abs(n) > Number.MAX_SAFE_INTEGER) {
      try { return BigInt(noUnder); } catch (_) { return n; }
    }
    return n;
  }

  // Array
  parseArray() {
    this.expect("[");
    const arr = [];
    while (true) {
      this.skipWSNL();
      if (this.cur() === "]") { this.advance(); break; }
      arr.push(this.parseValue());
      this.skipWSNL();
      if (this.cur() === ",") { this.advance(); continue; }
      if (this.cur() === "]") { this.advance(); break; }
      this.error("expected ',' or ']' in array");
    }
    return arr;
  }

  // Inline table
  parseInlineTable() {
    this.expect("{");
    const obj = Object.create(null);
    this.skipWS();
    if (this.cur() === "}") { this.advance(); return obj; }
    while (true) {
      this.skipWS();
      const key = this.parseKey();
      this.skipWS();
      this.expect("=");
      const val = this.parseValue();
      this.skipWS();
      setNestedKey(obj, key, val, () => this.error(`duplicate key in inline table: ${key.join(".")}`) );
      if (this.cur() === ",") { this.advance(); continue; }
      if (this.cur() === "}") { this.advance(); break; }
      this.error("expected ',' or '}' in inline table");
    }
    return obj;
  }

  // ── Top-level parse loop ──────────────────────────────────────────────────

  parse() {
    while (true) {
      this.skipWSNL();
      if (this.eof()) break;

      const ch = this.cur();

      // Table header or array-of-tables
      if (ch === "[") {
        if (this.peek(1) === "[") {
          this.parseArrayOfTablesHeader();
        } else {
          this.parseTableHeader();
        }
        continue;
      }

      // Key-value pair
      const key = this.parseKey();
      this.skipWS();
      this.expect("=");
      const val = this.parseValue();
      this.skipLineEnd();

      this.keyCount++;
      if (this.keyCount > MAX_KEYS)
        this.error(`too many keys (max ${MAX_KEYS})`);

      setNestedKey(this.currentTable, key, val, () =>
        this.error(`duplicate or conflicting key: ${key.join(".")}`) );
    }
    return this.root;
  }

  parseTableHeader() {
    this.expect("[");
    this.skipWS();
    const key = this.parseKey();
    this.skipWS();
    this.expect("]");
    this.skipLineEnd();

    const pathStr = key.join("\x00");
    if (this.definedTables.has(pathStr))
      this.error(`table [${key.join(".")}] defined more than once`);
    if (this.arrayTables.has(pathStr))
      this.error(`[${key.join(".")}] conflicts with existing [[${key.join(".")}]]`);
    this.definedTables.add(pathStr);

    this.currentPath = key;
    this.currentTable = resolveTablePath(this.root, key, false, this);
  }

  parseArrayOfTablesHeader() {
    this.pos += 2; // consume [[
    this.skipWS();
    const key = this.parseKey();
    this.skipWS();
    if (this.cur() !== "]" || this.peek(1) !== "]")
      this.error("expected ']]' to close array-of-tables header");
    this.pos += 2;
    this.skipLineEnd();

    const pathStr = key.join("\x00");
    if (this.definedTables.has(pathStr))
      this.error(`[[${key.join(".")}]] conflicts with existing [${key.join(".")}]`);

    const count = (this.arrayTables.get(pathStr) ?? 0) + 1;
    this.arrayTables.set(pathStr, count);

    // Navigate to parent, ensure array exists, push new table
    const parentKey = key.slice(0, -1);
    const lastName  = key[key.length - 1];
    const parent    = parentKey.length ? resolveTablePath(this.root, parentKey, false, this) : this.root;

    if (!(lastName in parent)) parent[lastName] = [];
    if (!Array.isArray(parent[lastName]))
      this.error(`key '${lastName}' is not an array-of-tables`);

    const newTable = Object.create(null);
    parent[lastName].push(newTable);
    this.currentPath = key;
    this.currentTable = newTable;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveTablePath(root, keyParts, createArrayLast, parser) {
  let cur = root;
  for (let i = 0; i < keyParts.length; i++) {
    const k = keyParts[i];
    if (!(k in cur)) {
      cur[k] = Object.create(null);
    } else if (Array.isArray(cur[k])) {
      // Navigate into last element of an array-of-tables
      cur = cur[k][cur[k].length - 1];
      continue;
    } else if (typeof cur[k] !== "object" || cur[k] === null) {
      parser.error(`key '${k}' already defined as a non-table value`);
    }
    cur = cur[k];
  }
  return cur;
}

function setNestedKey(obj, keyParts, value, onDuplicate) {
  let cur = obj;
  for (let i = 0; i < keyParts.length - 1; i++) {
    const k = keyParts[i];
    if (!(k in cur)) {
      cur[k] = Object.create(null);
    } else if (typeof cur[k] !== "object" || cur[k] === null || Array.isArray(cur[k])) {
      onDuplicate();
    }
    cur = cur[k];
  }
  const last = keyParts[keyParts.length - 1];
  if (last in cur) onDuplicate();
  cur[last] = value;
}

// ─── TOML Serializer ──────────────────────────────────────────────────────────

/**
 * Serialize a JS object to TOML.
 * Uses a BFS-like two-pass approach: first emit scalar/array key=val lines for
 * the current scope, then recursively emit sub-tables with their [header].
 */
function tomlStringify(obj, _prefix) {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj))
    throw new Error("toml_client: stringify requires a plain object");
  const out = [];
  _serializeTable(obj, "", out);
  return out.join("");
}

function _serializeTable(obj, prefix, out) {
  const scalars    = [];  // key-value lines for this table
  const subTables  = [];  // deferred: [section] tables
  const arrTables  = [];  // deferred: [[array-of-tables]]

  for (const [rawKey, val] of Object.entries(obj)) {
    const k = needsQuote(rawKey) ? quoteKey(rawKey) : rawKey;
    const fullPath = prefix ? `${prefix}.${k}` : k;

    if (Array.isArray(val) && val.length > 0
        && typeof val[0] === "object" && val[0] !== null && !isDate(val[0])) {
      // Array of tables -> [[header]]
      arrTables.push({ key: k, path: fullPath, items: val });
    } else if (typeof val === "object" && val !== null && !Array.isArray(val) && !isDate(val)) {
      // Sub-table -> [header]
      subTables.push({ key: k, path: fullPath, val });
    } else {
      scalars.push(`${k} = ${tomlValue(val)}`);
    }
  }

  // Emit [header] for non-root tables if there are scalar lines
  if (prefix && (scalars.length > 0 || (subTables.length === 0 && arrTables.length === 0))) {
    out.push(`[${prefix}]\n`);
  }

  if (scalars.length > 0) {
    out.push(scalars.join("\n") + "\n");
  }

  // Emit nested [sub.tables]
  for (const { path, val } of subTables) {
    if (scalars.length > 0 || out.length > 0) out.push("\n");
    _serializeTable(val, path, out);
  }

  // Emit [[array-of-tables]]
  for (const { path, items } of arrTables) {
    for (const item of items) {
      out.push(`\n[[${path}]]\n`);
      const itemScalars    = [];
      const itemSubTables  = [];
      const itemArrTables  = [];
      for (const [rawKey2, val2] of Object.entries(item)) {
        const k2 = needsQuote(rawKey2) ? quoteKey(rawKey2) : rawKey2;
        const p2 = `${path}.${k2}`;
        if (Array.isArray(val2) && val2.length > 0
            && typeof val2[0] === "object" && val2[0] !== null && !isDate(val2[0])) {
          itemArrTables.push({ key: k2, path: p2, items: val2 });
        } else if (typeof val2 === "object" && val2 !== null && !Array.isArray(val2) && !isDate(val2)) {
          itemSubTables.push({ key: k2, path: p2, val: val2 });
        } else {
          itemScalars.push(`${k2} = ${tomlValue(val2)}`);
        }
      }
      if (itemScalars.length > 0) out.push(itemScalars.join("\n") + "\n");
      for (const { path: sp, val: sv } of itemSubTables) {
        out.push("\n");
        _serializeTable(sv, sp, out);
      }
      for (const { path: ap, items: ai } of itemArrTables) {
        for (const aItem of ai) {
          out.push(`\n[[${ap}]]\n`);
          _serializeTable(aItem, ap, out);
        }
      }
    }
  }
}

function isDate(v) { return v instanceof Date; }

function needsQuote(key) {
  return !/^[A-Za-z0-9_\-]+$/.test(key);
}

function quoteKey(key) {
  return '"' + key.replace(/\\/g, "\\\\").replace(/"/g, "\\\"") + '"';
}

function tomlValue(val) {
  if (val === null || val === undefined)
    throw new Error("toml_client: TOML does not support null/undefined values");
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "bigint") return val.toString();
  if (typeof val === "number") {
    if (isNaN(val))        return "nan";
    if (val === Infinity)  return "inf";
    if (val === -Infinity) return "-inf";
    if (Number.isInteger(val)) return val.toString();
    // Ensure float representation
    const s = val.toString();
    return s.includes(".") || s.includes("e") ? s : s + ".0";
  }
  if (typeof val === "string") return tomlString(val);
  if (val instanceof Date) {
    const iso = val.toISOString();
    return iso; // offset datetime
  }
  if (Array.isArray(val)) {
    if (val.length === 0) return "[]";
    return "[" + val.map(tomlValue).join(", ") + "]";
  }
  if (typeof val === "object") {
    // Inline table
    const pairs = Object.entries(val).map(([k, v]) => {
      const tk = needsQuote(k) ? quoteKey(k) : k;
      return `${tk} = ${tomlValue(v)}`;
    });
    return "{" + pairs.join(", ") + "}";
  }
  throw new Error(`toml_client: unsupported value type: ${typeof val}`);
}

function tomlString(s) {
  // Check if multiline is beneficial
  if (s.includes("\n")) {
    return '"""\n' + s.replace(/\\/g, "\\\\").replace(/"""/g, '\\"\\"\\"') + '"""';
  }
  return '"' + s
    .replace(/\\/g, "\\\\")
    .replace(/"/g,  "\\\"")
    .replace(/\t/g, "\\t")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n")
    .replace(/[\x00-\x1f]/g, ch => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"))
    + '"';
}

// ─── Dotted key access helpers ─────────────────────────────────────────────────

function parseDottedKey(keyPath) {
  if (typeof keyPath !== "string" || keyPath.trim() === "")
    throw new Error("toml_client: key_path must be a non-empty string");
  // Split on unquoted dots
  return keyPath.split(".").map(k => k.trim());
}

function getNestedValue(obj, parts) {
  let cur = obj;
  for (const k of parts) {
    if (typeof cur !== "object" || cur === null || !(k in cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

function deleteNestedKey(obj, parts) {
  if (parts.length === 0) return false;
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur !== "object" || cur === null || !(parts[i] in cur)) return false;
    cur = cur[parts[i]];
  }
  const last = parts[parts.length - 1];
  if (!(last in cur)) return false;
  delete cur[last];
  return true;
}

function setNestedValue(obj, parts, value) {
  if (parts.length === 0) throw new Error("toml_client: empty key path");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (!(k in cur) || typeof cur[k] !== "object") cur[k] = Object.create(null);
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
}

// ─── File helpers ─────────────────────────────────────────────────────────────

function readTomlFile(filePath) {
  const abs = validatePath(filePath);
  let src;
  try {
    src = fs.readFileSync(abs, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") throw new Error(`toml_client: file not found: ${filePath}`);
    throw new Error(`toml_client: cannot read file: ${e.message}`);
  }
  if (Buffer.byteLength(src, "utf8") > MAX_FILE_SIZE)
    throw new Error(`toml_client: file too large (max ${MAX_FILE_SIZE} bytes): ${filePath}`);
  const parser = new TomlParser(src);
  return parser.parse();
}

function writeTomlFile(filePath, obj) {
  const abs = validatePath(filePath);
  const content = tomlStringify(obj);
  try {
    fs.writeFileSync(abs, content, "utf8");
  } catch (e) {
    throw new Error(`toml_client: cannot write file: ${e.message}`);
  }
}

function deepMerge(base, overlay) {
  const result = Object.assign(Object.create(null), base);
  for (const [k, v] of Object.entries(overlay)) {
    if (typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date)
        && typeof result[k] === "object" && result[k] !== null && !Array.isArray(result[k])) {
      result[k] = deepMerge(result[k], v);
    } else {
      result[k] = v;
    }
  }
  return result;
}

function listSections(obj, prefix = "") {
  const sections = [];
  for (const [k, v] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${k}` : k;
    if (Array.isArray(v) && v.length > 0 && typeof v[0] === "object" && v[0] !== null && !(v[0] instanceof Date)) {
      sections.push(`[[${fullKey}]]`);
      for (const item of v) {
        sections.push(...listSections(item, fullKey).map(s => "  " + s));
      }
    } else if (typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date)) {
      sections.push(`[${fullKey}]`);
      sections.push(...listSections(v, fullKey).map(s => "  " + s));
    }
  }
  return sections;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

function tomlClient(args) {
  const op = args.operation;
  if (!op) throw new Error("toml_client: 'operation' is required");

  switch (op) {

    case "read": {
      if (!args.path) throw new Error("toml_client: 'path' is required for read");
      const parsed = readTomlFile(args.path);
      // Serialize for JSON transport: convert BigInt/Date
      const json = JSON.parse(JSON.stringify(parsed, (_, v) =>
        typeof v === "bigint" ? v.toString() :
        v instanceof Date    ? v.toISOString() : v
      ));
      return { ok: true, data: json };
    }

    case "get": {
      if (!args.path)     throw new Error("toml_client: 'path' is required for get");
      if (!args.key_path) throw new Error("toml_client: 'key_path' is required for get");
      const parsed = readTomlFile(args.path);
      const parts  = parseDottedKey(args.key_path);
      const val    = getNestedValue(parsed, parts);
      if (val === undefined) return { ok: true, found: false, value: null };
      const safe = JSON.parse(JSON.stringify(val, (_, v) =>
        typeof v === "bigint" ? v.toString() :
        v instanceof Date    ? v.toISOString() : v
      ));
      return { ok: true, found: true, value: safe, type: typeof safe === "object" ? (Array.isArray(safe) ? "array" : "table") : typeof safe };
    }

    case "set": {
      if (!args.path)     throw new Error("toml_client: 'path' is required for set");
      if (!args.key_path) throw new Error("toml_client: 'key_path' is required for set");
      if (args.value === undefined) throw new Error("toml_client: 'value' is required for set");
      const parsed = readTomlFile(args.path);
      const parts  = parseDottedKey(args.key_path);
      setNestedValue(parsed, parts, args.value);
      writeTomlFile(args.path, parsed);
      return { ok: true, key_path: args.key_path, operation: "set" };
    }

    case "delete": {
      if (!args.path)     throw new Error("toml_client: 'path' is required for delete");
      if (!args.key_path) throw new Error("toml_client: 'key_path' is required for delete");
      const parsed  = readTomlFile(args.path);
      const parts   = parseDottedKey(args.key_path);
      const deleted = deleteNestedKey(parsed, parts);
      if (deleted) writeTomlFile(args.path, parsed);
      return { ok: true, key_path: args.key_path, deleted };
    }

    case "list_keys": {
      if (!args.path) throw new Error("toml_client: 'path' is required for list_keys");
      const parsed = readTomlFile(args.path);
      let target = parsed;
      if (args.section) {
        const parts = parseDottedKey(args.section);
        target = getNestedValue(parsed, parts);
        if (typeof target !== "object" || target === null || Array.isArray(target))
          throw new Error(`toml_client: section '${args.section}' not found or not a table`);
      }
      const keys = Object.keys(target);
      return { ok: true, keys, count: keys.length };
    }

    case "list_sections": {
      if (!args.path) throw new Error("toml_client: 'path' is required for list_sections");
      const parsed   = readTomlFile(args.path);
      const sections = listSections(parsed);
      return { ok: true, sections, count: sections.length };
    }

    case "merge": {
      if (!args.path)        throw new Error("toml_client: 'path' is required for merge");
      if (!args.source_path) throw new Error("toml_client: 'source_path' is required for merge");
      const base    = readTomlFile(args.path);
      const overlay = readTomlFile(args.source_path);
      const merged  = deepMerge(base, overlay);
      const outPath = args.output_path || args.path;
      writeTomlFile(outPath, merged);
      return { ok: true, output_path: outPath, merged_keys: Object.keys(merged).length };
    }

    case "stringify": {
      if (!args.data) throw new Error("toml_client: 'data' is required for stringify");
      if (typeof args.data !== "object" || Array.isArray(args.data))
        throw new Error("toml_client: 'data' must be a plain object");
      const toml = tomlStringify(args.data);
      if (args.output_path) {
        const abs = validatePath(args.output_path);
        fs.writeFileSync(abs, toml, "utf8");
        return { ok: true, output_path: args.output_path, length: toml.length };
      }
      return { ok: true, toml };
    }

    default:
      throw new Error(`toml_client: unknown operation '${op}'. Valid: read, get, set, delete, list_keys, list_sections, merge, stringify`);
  }
}

module.exports = { tomlClient, TomlParser, tomlStringify, tomlValue };
