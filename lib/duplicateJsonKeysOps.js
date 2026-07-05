"use strict";
// ── FIND_DUPLICATE_JSON_KEYS — raw-text JSON duplicate-key scanner ─────────
// JSON.parse silently keeps only the last value for a duplicate object key
// (valid per the JSON spec, but almost always an accidental data-loss bug
// in hand-edited config/data files). Every other JSON tool in this server
// (json_schema_validate, json_diff, query_json/query_data, json_patch, ...)
// parses through JSON.parse first, so duplicates are already gone by the
// time any of them ever see the document. This tool walks the raw source
// text with a small hand-rolled recursive-descent scanner instead, so every
// occurrence of a duplicate key -- and its line number -- is preserved.
// Read-only, zero-dependency.

const fs   = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".json"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

function looksBinary(buf) {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}

function collectFiles(absDir, extensions, relBase = "") {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); }
  catch (_) { return out; }
  for (const ent of entries) {
    if (isIgnored(ent.name)) continue;
    const abs = path.join(absDir, ent.name);
    const rel = relBase ? relBase + "/" + ent.name : ent.name;
    if (ent.isDirectory()) out.push(...collectFiles(abs, extensions, rel));
    else if (ent.isFile() && extensions.some(e => ent.name.endsWith(e))) out.push(rel);
  }
  return out;
}

// Minimal recursive-descent JSON scanner. Not a validating parser -- it
// accepts the same grammar JSON.parse does (objects, arrays, strings,
// numbers, true/false/null) but its only real job is tracking, per object
// literal, every key seen and flagging repeats with both occurrences' line
// numbers. Malformed JSON throws a descriptive parse error (caught by the
// caller and reported per-file, not a scan-wide abort).
class DupKeyScanner {
  constructor(text) {
    this.s = text;
    this.i = 0;
    this.n = text.length;
    this.line = 1;
    this.issues = [];
  }

  error(msg) {
    const e = new Error(`invalid JSON at line ${this.line}: ${msg}`);
    throw e;
  }

  peek() { return this.s[this.i]; }

  advance() {
    const c = this.s[this.i++];
    if (c === "\n") this.line++;
    return c;
  }

  skipWs() {
    while (this.i < this.n) {
      const c = this.peek();
      if (c === " " || c === "\t" || c === "\r" || c === "\n") this.advance();
      else break;
    }
  }

  parseString() {
    const startLine = this.line;
    if (this.advance() !== "\"") this.error("expected string");
    let out = "";
    while (true) {
      if (this.i >= this.n) this.error("unterminated string");
      const c = this.advance();
      if (c === "\"") break;
      if (c === "\\") {
        const esc = this.advance();
        const map = { "\"": "\"", "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
        if (esc === "u") {
          const hex = this.s.slice(this.i, this.i + 4);
          this.i += 4;
          out += String.fromCharCode(parseInt(hex, 16) || 0);
        } else if (map[esc] !== undefined) {
          out += map[esc];
        } else {
          this.error(`invalid escape \\${esc}`);
        }
      } else {
        out += c;
      }
    }
    return { value: out, line: startLine };
  }

  parseValue(pathStack) {
    this.skipWs();
    const c = this.peek();
    if (c === "{") { this.parseObject(pathStack); return; }
    if (c === "[") { this.parseArray(pathStack); return; }
    if (c === "\"") { this.parseString(); return; }
    if (c === "t") { this.expectLiteral("true"); return; }
    if (c === "f") { this.expectLiteral("false"); return; }
    if (c === "n") { this.expectLiteral("null"); return; }
    if (c === "-" || (c >= "0" && c <= "9")) { this.parseNumber(); return; }
    this.error(`unexpected character '${c === undefined ? "EOF" : c}'`);
  }

  expectLiteral(lit) {
    for (const ch of lit) {
      if (this.i >= this.n || this.advance() !== ch) this.error(`expected '${lit}'`);
    }
  }

  parseNumber() {
    if (this.peek() === "-") this.advance();
    if (!/[0-9]/.test(this.peek() || "")) this.error("invalid number");
    while (this.i < this.n && /[0-9.eE+-]/.test(this.peek())) this.advance();
  }

  parseObject(pathStack) {
    this.advance(); // '{'
    const seen = new Map(); // key -> first-seen line
    this.skipWs();
    if (this.peek() === "}") { this.advance(); return; }
    while (true) {
      this.skipWs();
      if (this.peek() !== "\"") this.error("expected string key");
      const { value: key, line: keyLine } = this.parseString();
      if (seen.has(key)) {
        this.issues.push({
          path: pathStack.length ? pathStack.join(".") : "$",
          key,
          firstLine: seen.get(key),
          duplicateLine: keyLine,
        });
      } else {
        seen.set(key, keyLine);
      }
      this.skipWs();
      if (this.i >= this.n || this.advance() !== ":") this.error("expected ':' after key");
      pathStack.push(key);
      this.parseValue(pathStack);
      pathStack.pop();
      this.skipWs();
      if (this.i >= this.n) this.error("unterminated object");
      const sep = this.advance();
      if (sep === ",") continue;
      if (sep === "}") break;
      this.error(`expected ',' or '}', got '${sep}'`);
    }
  }

  parseArray(pathStack) {
    this.advance(); // '['
    this.skipWs();
    if (this.peek() === "]") { this.advance(); return; }
    let idx = 0;
    while (true) {
      pathStack.push(`[${idx}]`);
      this.parseValue(pathStack);
      pathStack.pop();
      idx++;
      this.skipWs();
      if (this.i >= this.n) this.error("unterminated array");
      const sep = this.advance();
      if (sep === ",") continue;
      if (sep === "]") break;
      this.error(`expected ',' or ']', got '${sep}'`);
    }
  }

  run() {
    this.skipWs();
    if (this.i >= this.n) this.error("empty document");
    this.parseValue([]);
    this.skipWs();
    if (this.i < this.n) this.error("unexpected trailing content");
    return this.issues;
  }
}

function scanFileForDuplicateKeys(absPath, relPath) {
  let buf;
  try { buf = fs.readFileSync(absPath); }
  catch (e) { return { file: relPath, error: `cannot read: ${e.message}`, issues: [] }; }
  if (looksBinary(buf)) return { file: relPath, skipped: true, issues: [] };
  const text = buf.toString("utf8");
  try {
    const issues = new DupKeyScanner(text).run();
    return { file: relPath, error: null, issues };
  } catch (e) {
    return { file: relPath, error: e.message, issues: [] };
  }
}

/**
 * @param {string} absDir   Absolute, jail-validated file or directory to scan.
 * @param {string} origPath Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {string[]} [opts.extensions] File extensions to scan (default ['.json']).
 * @param {number}   [opts.maxResults] Cap on reported duplicate-key issues (1-5000, default 500).
 * @returns {{path, filesScanned, filesWithErrors, duplicateKeyCount, truncated, issues, errors}}
 */
function scanJsonDuplicateKeys(absDir, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absDir); }
  catch (e) { throw new ToolError(`find_duplicate_json_keys: cannot access '${origPath}': ${e.message}`, -32602); }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_duplicate_json_keys: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_duplicate_json_keys: extensions must be an array of strings.", -32602);

  const extensions = Array.isArray(opts.extensions) && opts.extensions.length ? opts.extensions : DEFAULT_EXTENSIONS;
  const maxResults = Math.min(Math.max(1, Math.trunc(opts.maxResults ?? DEFAULT_MAX_RESULTS)), HARD_MAX_RESULTS);

  const files = stat.isDirectory() ? collectFiles(absDir, extensions) : [path.basename(absDir)];
  const baseDir = stat.isDirectory() ? absDir : path.dirname(absDir);

  const allIssues = [];
  const errors = [];
  let filesScanned = 0;

  for (const rel of files) {
    const abs = path.join(baseDir, rel);
    const result = scanFileForDuplicateKeys(abs, rel);
    if (result.skipped) continue;
    filesScanned++;
    if (result.error) { errors.push({ file: rel, error: result.error }); continue; }
    for (const issue of result.issues) {
      allIssues.push({ file: rel, path: issue.path, key: issue.key, firstLine: issue.firstLine, duplicateLine: issue.duplicateLine });
    }
  }

  allIssues.sort((a, b) => a.file.localeCompare(b.file) || a.duplicateLine - b.duplicateLine);
  const truncated = allIssues.length > maxResults;

  return {
    path: origPath,
    filesScanned,
    filesWithErrors: errors.length,
    duplicateKeyCount: allIssues.length,
    truncated,
    issues: allIssues.slice(0, maxResults),
    errors,
  };
}

module.exports = { scanJsonDuplicateKeys };
