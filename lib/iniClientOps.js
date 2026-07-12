"use strict";
// lib/iniClientOps.js — Zero-dependency INI/CFG file parser and writer
// Operations: read, get, set, delete, list_keys, list_sections, merge, stringify
//
// INI dialect supported:
//   [section]        — section header (case-preserving)
//   key=value        — assignment with '=' separator
//   key: value       — assignment with ':' separator  (php-style / Python configparser)
//   # comment        — hash comment (whole line or inline after whitespace)
//   ; comment        — semicolon comment
//   key=val \        — line continuation with trailing backslash
//   "quoted values"  — double/single-quoted values (quotes stripped)
//   global keys      — key/value pairs before the first [section] go into __global__
//
// Security:
//   - path NUL guard
//   - 4 MB file cap
//   - 50,000 key limit
//   - section/key name length cap (256 chars each)

const fs   = require("fs");
const path = require("path");

// ── Constants ────────────────────────────────────────────────────────────────
const MAX_FILE_BYTES  = 4 * 1024 * 1024; // 4 MB
const MAX_KEYS        = 50_000;
const MAX_NAME_LEN    = 256;
const GLOBAL_SECTION  = "__global__";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Validate and resolve a path argument.
 * Guards against empty strings and NUL bytes, then returns the absolute path.
 */
function resolvePath(p) {
  if (typeof p !== "string" || p.length === 0)
    throw Object.assign(new Error("ini_client: 'path' must be a non-empty string."), { code: "INVALID_ARG" });
  if (p.includes("\0"))
    throw Object.assign(new Error("ini_client: 'path' must not contain NUL bytes."), { code: "INVALID_ARG" });
  return path.resolve(p);
}

// guardPath: validate only (used where return value not needed)
function guardPath(p) { resolvePath(p); }

function readFileSafe(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_FILE_BYTES)
    throw Object.assign(
      new Error(`ini_client: file too large (${stat.size} bytes; max ${MAX_FILE_BYTES}).`),
      { code: "FILE_TOO_LARGE" },
    );
  return fs.readFileSync(filePath, "utf8");
}

/**
 * Strip a trailing inline comment from a value string.
 * Inline comments must be preceded by at least one whitespace character.
 * Hash/semicolons within quoted portions are NOT stripped.
 */
function stripInlineComment(val) {
  if (val.length > 0 && (val[0] === '"' || val[0] === "'")) {
    const q = val[0];
    const close = val.indexOf(q, 1);
    if (close !== -1) return val.slice(1, close);
    return val.slice(1);
  }
  const m = val.match(/^(.*?)\s+[#;].*$/);
  return m ? m[1] : val;
}

/**
 * Parse an INI string into a Map<sectionName, Map<key, value>>.
 * Global (pre-section) keys go into GLOBAL_SECTION.
 */
function parseIni(text) {
  const sections = new Map();
  sections.set(GLOBAL_SECTION, new Map());
  let current = GLOBAL_SECTION;
  let totalKeys = 0;

  const rawLines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");

  // Join continuation lines (trailing backslash)
  const lines = [];
  for (let i = 0; i < rawLines.length; i++) {
    let line = rawLines[i];
    while (line.endsWith("\\") && i + 1 < rawLines.length) {
      line = line.slice(0, -1) + rawLines[++i].trimStart();
    }
    lines.push(line);
  }

  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0 || line[0] === "#" || line[0] === ";") continue;

    if (line[0] === "[") {
      const close = line.indexOf("]");
      if (close === -1) continue;
      const name = line.slice(1, close).trim();
      if (!name) continue;
      if (name.length > MAX_NAME_LEN)
        throw Object.assign(
          new Error(`ini_client: section name too long (max ${MAX_NAME_LEN}).`),
          { code: "INVALID_FORMAT" },
        );
      if (!sections.has(name)) sections.set(name, new Map());
      current = name;
      continue;
    }

    const eqIdx  = line.indexOf("=");
    const colIdx = line.indexOf(":");
    let sepIdx = -1;
    if (eqIdx !== -1 && colIdx !== -1) sepIdx = Math.min(eqIdx, colIdx);
    else if (eqIdx !== -1) sepIdx = eqIdx;
    else if (colIdx !== -1) sepIdx = colIdx;
    if (sepIdx === -1) continue;

    const key = line.slice(0, sepIdx).trim();
    if (!key) continue;
    if (key.length > MAX_NAME_LEN)
      throw Object.assign(
        new Error(`ini_client: key name too long (max ${MAX_NAME_LEN}).`),
        { code: "INVALID_FORMAT" },
      );

    const rawVal = line.slice(sepIdx + 1).trim();
    const val    = stripInlineComment(rawVal);

    if (totalKeys >= MAX_KEYS)
      throw Object.assign(
        new Error(`ini_client: too many keys (max ${MAX_KEYS}).`),
        { code: "TOO_MANY_KEYS" },
      );

    sections.get(current).set(key, val);
    totalKeys++;
  }

  return sections;
}

function sectionsToObject(sections) {
  const obj = {};
  for (const [sec, map] of sections) {
    obj[sec] = {};
    for (const [k, v] of map) obj[sec][k] = v;
  }
  return obj;
}

function objectToSections(obj) {
  const sections = new Map();
  if (!obj || typeof obj !== "object") return sections;
  for (const [sec, vals] of Object.entries(obj)) {
    const map = new Map();
    if (vals && typeof vals === "object") {
      for (const [k, v] of Object.entries(vals)) map.set(k, String(v ?? ""));
    }
    sections.set(sec, map);
  }
  return sections;
}

function stringifySections(sections) {
  const parts = [];
  const global = sections.get(GLOBAL_SECTION);
  if (global && global.size > 0) {
    for (const [k, v] of global) parts.push(`${k}=${v}`);
    parts.push("");
  }
  for (const [sec, map] of sections) {
    if (sec === GLOBAL_SECTION) continue;
    parts.push(`[${sec}]`);
    for (const [k, v] of map) parts.push(`${k}=${v}`);
    parts.push("");
  }
  return parts.join("\n").trimEnd() + "\n";
}

function parsePath(keyPath, sections) {
  if (!keyPath || typeof keyPath !== "string")
    throw Object.assign(new Error("ini_client: 'key_path' must be a non-empty string."), { code: "INVALID_ARG" });
  const dot = keyPath.indexOf(".");
  if (dot === -1) {
    if (sections && sections.has(keyPath) && keyPath !== GLOBAL_SECTION)
      return { section: keyPath, key: null };
    return { section: GLOBAL_SECTION, key: keyPath };
  }
  const section = keyPath.slice(0, dot);
  const key     = keyPath.slice(dot + 1);
  if (!key) throw Object.assign(new Error(`ini_client: 'key_path' '${keyPath}' has empty key after section.`), { code: "INVALID_ARG" });
  return { section, key };
}

function mergeSections(dst, src) {
  for (const [sec, map] of src) {
    if (!dst.has(sec)) dst.set(sec, new Map());
    const dstMap = dst.get(sec);
    for (const [k, v] of map) dstMap.set(k, v);
  }
}

// ── Public Operations ─────────────────────────────────────────────────────────

function opRead(args) {
  const resolved = resolvePath(args.path);
  const text = readFileSafe(resolved);
  const sections = parseIni(text);
  const data = sectionsToObject(sections);
  const sectionNames = [...sections.keys()].filter(s => s !== GLOBAL_SECTION);
  let totalKeys = 0;
  for (const m of sections.values()) totalKeys += m.size;
  return { path: args.path, sectionCount: sectionNames.length, keyCount: totalKeys, sections: sectionNames, data };
}

function opGet(args) {
  if (!args.key_path)
    throw Object.assign(new Error("ini_client: 'key_path' is required for get."), { code: "INVALID_ARG" });
  const resolved = resolvePath(args.path);
  const text = readFileSafe(resolved);
  const sections = parseIni(text);
  const { section, key } = parsePath(args.key_path, sections);
  if (key === null) {
    if (!sections.has(section))
      return { path: args.path, key_path: args.key_path, found: false, value: null };
    const secObj = {};
    for (const [k, v] of sections.get(section)) secObj[k] = v;
    return { path: args.path, key_path: args.key_path, found: true, value: secObj, type: "section" };
  }
  if (!sections.has(section) || !sections.get(section).has(key))
    return { path: args.path, key_path: args.key_path, found: false, value: null };
  const value = sections.get(section).get(key);
  return { path: args.path, key_path: args.key_path, found: true, value, type: typeof value };
}

function opSet(args) {
  if (!args.key_path)
    throw Object.assign(new Error("ini_client: 'key_path' is required for set."), { code: "INVALID_ARG" });
  if (args.value === undefined)
    throw Object.assign(new Error("ini_client: 'value' is required for set."), { code: "INVALID_ARG" });
  const resolved = resolvePath(args.path);
  let sections;
  if (fs.existsSync(resolved)) {
    sections = parseIni(readFileSafe(resolved));
  } else {
    sections = new Map([[GLOBAL_SECTION, new Map()]]);
  }
  const { section, key } = parsePath(args.key_path, sections);
  if (key === null)
    throw Object.assign(new Error(`ini_client: 'key_path' '${args.key_path}' points to a section, not a key. Use 'section.key' notation.`), { code: "INVALID_ARG" });
  if (!sections.has(section)) sections.set(section, new Map());
  const strVal = String(args.value ?? "");
  sections.get(section).set(key, strVal);
  const out = stringifySections(sections);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, out, "utf8");
  return { path: args.path, key_path: args.key_path, section, key, value: strVal, written: true };
}

function opDelete(args) {
  if (!args.key_path)
    throw Object.assign(new Error("ini_client: 'key_path' is required for delete."), { code: "INVALID_ARG" });
  const resolved = resolvePath(args.path);
  const text = readFileSafe(resolved);
  const sections = parseIni(text);
  const { section, key } = parsePath(args.key_path, sections);
  let deleted = false;
  if (key === null) {
    if (sections.has(section)) { sections.delete(section); deleted = true; }
  } else {
    if (sections.has(section) && sections.get(section).has(key)) {
      sections.get(section).delete(key);
      if (section !== GLOBAL_SECTION && sections.get(section).size === 0)
        sections.delete(section);
      deleted = true;
    }
  }
  if (deleted) fs.writeFileSync(resolved, stringifySections(sections), "utf8");
  return { path: args.path, key_path: args.key_path, deleted, written: deleted };
}

function opListKeys(args) {
  const resolved = resolvePath(args.path);
  const sections = parseIni(readFileSafe(resolved));
  const target = args.section || GLOBAL_SECTION;
  if (!sections.has(target)) return { path: args.path, section: target, keys: [], keyCount: 0 };
  const keys = [...sections.get(target).keys()];
  return { path: args.path, section: target, keys, keyCount: keys.length };
}

function opListSections(args) {
  const resolved = resolvePath(args.path);
  const sections = parseIni(readFileSafe(resolved));
  const names = [...sections.keys()].filter(s => s !== GLOBAL_SECTION);
  const globalKeys = [...(sections.get(GLOBAL_SECTION)?.keys() ?? [])];
  return { path: args.path, sections: names, sectionCount: names.length, globalKeyCount: globalKeys.length, globalKeys };
}

function opMerge(args) {
  if (!args.source_path)
    throw Object.assign(new Error("ini_client: 'source_path' is required for merge."), { code: "INVALID_ARG" });
  const baseResolved = resolvePath(args.path);
  const srcResolved  = resolvePath(args.source_path);
  let baseSections;
  if (fs.existsSync(baseResolved)) {
    baseSections = parseIni(readFileSafe(baseResolved));
  } else {
    baseSections = new Map([[GLOBAL_SECTION, new Map()]]);
  }
  const srcSections = parseIni(readFileSafe(srcResolved));
  mergeSections(baseSections, srcSections);
  const outPath     = args.output_path || args.path;
  const outResolved = resolvePath(outPath);
  const out = stringifySections(baseSections);
  fs.mkdirSync(path.dirname(outResolved), { recursive: true });
  fs.writeFileSync(outResolved, out, "utf8");
  let totalKeys = 0;
  for (const m of baseSections.values()) totalKeys += m.size;
  return {
    path: args.path, source_path: args.source_path, output_path: outPath,
    sectionCount: [...baseSections.keys()].filter(s => s !== GLOBAL_SECTION).length,
    keyCount: totalKeys, written: true,
  };
}

function opStringify(args) {
  if (args.data != null && args.path != null)
    throw Object.assign(new Error("ini_client: provide 'data' or 'path', not both."), { code: "INVALID_ARG" });
  let sections;
  if (args.data != null) {
    if (typeof args.data !== "object" || Array.isArray(args.data))
      throw Object.assign(new Error("ini_client: 'data' must be a plain object for stringify."), { code: "INVALID_ARG" });
    sections = objectToSections(args.data);
  } else if (args.path != null) {
    const resolved = resolvePath(args.path);
    sections = parseIni(readFileSafe(resolved));
  } else {
    throw Object.assign(new Error("ini_client: provide 'data' or 'path' for stringify."), { code: "INVALID_ARG" });
  }
  const iniText = stringifySections(sections);
  if (args.output_path) {
    const outResolved = resolvePath(args.output_path);
    fs.mkdirSync(path.dirname(outResolved), { recursive: true });
    fs.writeFileSync(outResolved, iniText, "utf8");
    return { output_path: args.output_path, length: iniText.length, written: true, ini: iniText };
  }
  return { length: iniText.length, written: false, ini: iniText };
}

// ── Main Dispatcher ───────────────────────────────────────────────────────────

function iniClient(args) {
  if (!args || !args.operation)
    throw Object.assign(new Error("ini_client: 'operation' is required."), { code: "INVALID_ARG" });
  switch (args.operation) {
    case "read":          return opRead(args);
    case "get":           return opGet(args);
    case "set":           return opSet(args);
    case "delete":        return opDelete(args);
    case "list_keys":     return opListKeys(args);
    case "list_sections": return opListSections(args);
    case "merge":         return opMerge(args);
    case "stringify":     return opStringify(args);
    default:
      throw Object.assign(
        new Error(`ini_client: unknown operation '${args.operation}'. Valid: read, get, set, delete, list_keys, list_sections, merge, stringify.`),
        { code: "INVALID_ARG" },
      );
  }
}

module.exports = { iniClient, parseIni, stringifySections, sectionsToObject, objectToSections, GLOBAL_SECTION };
