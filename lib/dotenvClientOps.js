"use strict";
// lib/dotenvClientOps.js — Zero-dependency .env file parser/writer
// Pure Node.js fs only. No npm dependencies.
//
// Supported operations:
//   read      — parse a .env file into a key-value object
//   write     — add/update key-value pairs in a .env file
//   delete    — remove one or more keys from a .env file
//   merge     — merge two .env files (second overrides first)
//   validate  — check that all required keys are present
//   to_shell  — emit `export KEY=val` lines for shell sourcing
//   list      — list all key names in a .env file
//
// Parser features:
//   - Blank lines and # comments preserved on write
//   - Quoted values: single, double, backtick (backtick treated as double)
//   - Multiline values: double-quoted with embedded \n
//   - Escape sequences: \n \r \t \\ \" \' in double-quoted values
//   - Variable expansion NOT supported (security risk; out of scope)
//   - export KEY=val syntax supported on read

const fs   = require("fs");
const path = require("path");

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_FILE_SIZE  = 4 * 1024 * 1024;  // 4 MB max .env file
const MAX_VALUE_SIZE = 1 * 1024 * 1024;  // 1 MB max per-value
const MAX_KEY_LEN    = 256;
const MAX_KEYS       = 5000;

// ─── Key Validation ───────────────────────────────────────────────────────────

function validateKey(key) {
  if (typeof key !== "string" || key.length === 0)
    throw new Error("dotenv_client: key must be a non-empty string.");
  if (key.length > MAX_KEY_LEN)
    throw new Error(`dotenv_client: key too long (max ${MAX_KEY_LEN} chars): '${key.slice(0, 40)}'.`);
  if (/[\x00\r\n\t =]/.test(key))
    throw new Error(`dotenv_client: key '${key}' contains invalid characters (NUL/CR/LF/TAB/space/equals).`);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
    throw new Error(`dotenv_client: key '${key}' must match [A-Za-z_][A-Za-z0-9_]*.`);
}

function validateValue(value, key) {
  if (typeof value !== "string")
    throw new Error(`dotenv_client: value for key '${key}' must be a string.`);
  if (value.length > MAX_VALUE_SIZE)
    throw new Error(`dotenv_client: value for key '${key}' too large (max ${MAX_VALUE_SIZE} bytes).`);
  if (/\x00/.test(value))
    throw new Error(`dotenv_client: value for key '${key}' contains NUL byte.`);
}

// ─── Parser ───────────────────────────────────────────────────────────────────

/**
 * Parse a .env file content string into a structured representation.
 * Returns: { entries: [{type, raw, key?, value?, comment?}], vars: {key: value} }
 * Entry types: 'blank', 'comment', 'assignment', 'invalid'
 */
function parseEnvContent(content) {
  const lines   = content.split(/\n/);
  const entries = [];
  const vars    = {};

  for (let i = 0; i < lines.length; i++) {
    // Strip trailing \r for CRLF files
    const raw  = lines[i].replace(/\r$/, "");
    const trim = raw.trim();

    // Blank line
    if (trim === "") {
      entries.push({ type: "blank", raw });
      continue;
    }

    // Comment line
    if (trim.startsWith("#")) {
      entries.push({ type: "comment", raw, comment: trim.slice(1).trim() });
      continue;
    }

    // Strip optional "export " prefix
    let work = trim;
    if (work.startsWith("export "))
      work = work.slice(7).trim();

    // Find the = sign
    const eqIdx = work.indexOf("=");
    if (eqIdx < 1) {
      entries.push({ type: "invalid", raw });
      continue;
    }

    const key     = work.slice(0, eqIdx).trim();
    const rawVal  = work.slice(eqIdx + 1);
    const value   = parseValue(rawVal);

    entries.push({ type: "assignment", raw, key, value });
    vars[key] = value;
  }

  return { entries, vars };
}

function parseValue(rawVal) {
  if (rawVal === "") return "";

  const first = rawVal[0];

  // Double-quoted or backtick-quoted (backtick = double-quote semantics)
  if (first === '"' || first === '`') {
    const closeChar = first === '`' ? '`' : '"';
    let   result    = "";
    let   i         = 1;
    while (i < rawVal.length) {
      const ch = rawVal[i];
      if (ch === '\\' && i + 1 < rawVal.length) {
        const next = rawVal[i + 1];
        switch (next) {
          case 'n':  result += "\n"; i += 2; break;
          case 'r':  result += "\r"; i += 2; break;
          case 't':  result += "\t"; i += 2; break;
          case '\\': result += "\\"; i += 2; break;
          case '"':  result += "\""; i += 2; break;
          case "'":  result += "'";  i += 2; break;
          case '`':  result += "`";  i += 2; break;
          case '$':  result += "$";  i += 2; break;
          default:   result += ch;   i++;    break;
        }
      } else if (ch === closeChar) {
        // Closing quote found — ignore anything after it on same line (inline comments)
        break;
      } else {
        result += ch;
        i++;
      }
    }
    return result;
  }

  // Single-quoted: literal, no escaping
  if (first === "'") {
    const closeIdx = rawVal.indexOf("'", 1);
    return closeIdx === -1 ? rawVal.slice(1) : rawVal.slice(1, closeIdx);
  }

  // Unquoted: strip inline comment (#) if preceded by whitespace
  const commentMatch = rawVal.match(/^([^#]*)(?:\s+#.*)?$/);
  const val = commentMatch ? commentMatch[1].trim() : rawVal.trim();
  return val;
}

// ─── Serializer ───────────────────────────────────────────────────────────────

/**
 * Serialize a value for writing to .env.
 * Uses double-quotes if value contains special chars.
 */
function serializeValue(value) {
  if (value === "") return "";

  // If value has no special chars, write unquoted
  if (!/[\r\n\t'"\\\x00$`#\s]/.test(value) && value === value.trim())
    return value;

  // Double-quote with escaping
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g,  "\\\"")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/\x00/g, "")  // strip NUL
    .replace(/`/g, "\\`")
    .replace(/\$/g, "\\$");
  return `"${escaped}"`;
}

/**
 * Rebuild a .env file content string from entries, applying updates.
 * @param {Array}  entries    - parsed entries array
 * @param {Object} updates    - {key: newValue} — keys to add/update
 * @param {Set}    deletions  - set of keys to remove
 * @returns {string} new file content
 */
function serializeEntries(entries, updates, deletions) {
  const updatesRemaining = new Set(Object.keys(updates));
  const lines = [];

  for (const entry of entries) {
    if (entry.type === "assignment") {
      const key = entry.key;
      if (deletions.has(key)) continue; // Remove this key

      if (key in updates) {
        // Update existing entry
        lines.push(`${key}=${serializeValue(updates[key])}`);
        updatesRemaining.delete(key);
      } else {
        lines.push(entry.raw);
      }
    } else {
      lines.push(entry.raw);
    }
  }

  // Append any new keys not found in existing file
  if (updatesRemaining.size > 0) {
    if (lines.length > 0 && lines[lines.length - 1].trim() !== "")
      lines.push(""); // blank line before new entries
    for (const key of updatesRemaining) {
      lines.push(`${key}=${serializeValue(updates[key])}`);
    }
  }

  // Ensure file ends with newline
  let result = lines.join("\n");
  if (result && !result.endsWith("\n")) result += "\n";
  return result;
}

// ─── File Read/Write Helpers ─────────────────────────────────────────────────

function readEnvFile(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_FILE_SIZE)
    throw new Error(`dotenv_client: file too large (${stat.size} bytes; max ${MAX_FILE_SIZE}).`);
  const content = fs.readFileSync(filePath, "utf8");
  return content;
}

function writeEnvFile(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

// ─── Public API ───────────────────────────────────────────────────────────────

async function dotenvClient(args) {
  const op      = args.operation;
  const filePath = args.path;

  if (!op)
    throw new Error("dotenv_client: 'operation' is required.");

  switch (op) {

    // ── READ ─────────────────────────────────────────────────────────────────
    case "read": {
      if (!filePath)
        throw new Error("dotenv_client: 'path' is required for operation 'read'.");

      const content  = readEnvFile(filePath);
      const { vars, entries } = parseEnvContent(content);

      const keyCount = Object.keys(vars).length;
      if (keyCount > MAX_KEYS)
        throw new Error(`dotenv_client: file has too many keys (${keyCount}; max ${MAX_KEYS}).`);

      return {
        path:       filePath,
        keyCount,
        vars,
        commentCount: entries.filter(e => e.type === "comment").length,
        blankCount:   entries.filter(e => e.type === "blank").length,
        invalidCount: entries.filter(e => e.type === "invalid").length,
      };
    }

    // ── LIST ─────────────────────────────────────────────────────────────────
    case "list": {
      if (!filePath)
        throw new Error("dotenv_client: 'path' is required for operation 'list'.");

      const content  = readEnvFile(filePath);
      const { vars } = parseEnvContent(content);
      const keys     = Object.keys(vars);

      return { path: filePath, keyCount: keys.length, keys };
    }

    // ── WRITE ─────────────────────────────────────────────────────────────────
    case "write": {
      if (!filePath)
        throw new Error("dotenv_client: 'path' is required for operation 'write'.");
      if (!args.vars || typeof args.vars !== "object" || Array.isArray(args.vars))
        throw new Error("dotenv_client: 'vars' must be an object mapping keys to values.");

      const updates = args.vars;

      // Validate all keys/values first
      for (const [k, v] of Object.entries(updates)) {
        validateKey(k);
        validateValue(String(v), k);
      }

      // Read existing file if it exists, otherwise start empty
      let existingContent = "";
      try { existingContent = readEnvFile(filePath); } catch (_) { /* new file */ }

      const { entries } = parseEnvContent(existingContent);
      const stringUpdates = {};
      for (const [k, v] of Object.entries(updates))
        stringUpdates[k] = String(v);

      const newContent = serializeEntries(entries, stringUpdates, new Set());
      writeEnvFile(filePath, newContent);

      return {
        path:        filePath,
        written:     Object.keys(updates).length,
        keys:        Object.keys(updates),
      };
    }

    // ── DELETE ────────────────────────────────────────────────────────────────
    case "delete": {
      if (!filePath)
        throw new Error("dotenv_client: 'path' is required for operation 'delete'.");
      if (!Array.isArray(args.keys) || args.keys.length === 0)
        throw new Error("dotenv_client: 'keys' must be a non-empty array of key names to delete.");

      for (const k of args.keys) validateKey(k);

      const content = readEnvFile(filePath);
      const { entries, vars } = parseEnvContent(content);

      const deletions   = new Set(args.keys);
      const notFound    = args.keys.filter(k => !(k in vars));
      const newContent  = serializeEntries(entries, {}, deletions);
      writeEnvFile(filePath, newContent);

      return {
        path:    filePath,
        deleted: args.keys.filter(k => k in vars),
        notFound,
      };
    }

    // ── MERGE ─────────────────────────────────────────────────────────────────
    case "merge": {
      if (!filePath)
        throw new Error("dotenv_client: 'path' is required for operation 'merge' (base file).");
      if (!args.source)
        throw new Error("dotenv_client: 'source' is required for operation 'merge' (override file).");

      const baseContent   = readEnvFile(filePath);
      const sourceContent = readEnvFile(args.source);
      const { entries: baseEntries, vars: baseVars }     = parseEnvContent(baseContent);
      const { vars: sourceVars }                         = parseEnvContent(sourceContent);

      // source overrides base
      const overrideKeys  = Object.keys(sourceVars);
      const newContent    = serializeEntries(baseEntries, sourceVars, new Set());

      // Write to output path (or overwrite base if output not given)
      const outPath = args.output || filePath;
      writeEnvFile(outPath, newContent);

      const baseKeys   = Object.keys(baseVars);
      const added      = overrideKeys.filter(k => !(k in baseVars));
      const overridden = overrideKeys.filter(k => k in baseVars && baseVars[k] !== sourceVars[k]);
      const unchanged  = overrideKeys.filter(k => k in baseVars && baseVars[k] === sourceVars[k]);

      return {
        path:          outPath,
        basePath:      filePath,
        sourcePath:    args.source,
        baseKeyCount:  baseKeys.length,
        sourceKeyCount: overrideKeys.length,
        added,
        overridden,
        unchanged,
        totalKeys:     Object.keys({ ...baseVars, ...sourceVars }).length,
      };
    }

    // ── VALIDATE ──────────────────────────────────────────────────────────────
    case "validate": {
      if (!filePath)
        throw new Error("dotenv_client: 'path' is required for operation 'validate'.");
      if (!Array.isArray(args.required) || args.required.length === 0)
        throw new Error("dotenv_client: 'required' must be a non-empty array of key names.");

      const content  = readEnvFile(filePath);
      const { vars } = parseEnvContent(content);

      const missing = args.required.filter(k => !(k in vars) || vars[k] === "");
      const present = args.required.filter(k =>   k in vars  && vars[k] !== "");

      return {
        path:     filePath,
        valid:    missing.length === 0,
        required: args.required.length,
        present,
        missing,
      };
    }

    // ── TO_SHELL ──────────────────────────────────────────────────────────────
    case "to_shell": {
      if (!filePath)
        throw new Error("dotenv_client: 'path' is required for operation 'to_shell'.");

      const content  = readEnvFile(filePath);
      const { vars } = parseEnvContent(content);

      const prefix  = args.prefix ?? "export ";
      const keys    = args.keys
        ? args.keys.filter(k => k in vars)
        : Object.keys(vars);

      const lines   = keys.map(k => `${prefix}${k}=${serializeValue(vars[k])}`);
      const shell   = lines.join("\n") + (lines.length ? "\n" : "");

      return {
        path:    filePath,
        keyCount: keys.length,
        shell,
      };
    }

    default:
      throw new Error(
        `dotenv_client: unknown operation '${op}'. Valid: read, list, write, delete, merge, validate, to_shell.`
      );
  }
}

module.exports = {
  dotenvClient,
  _parse: {
    parseEnvContent,
    parseValue,
    serializeValue,
    serializeEntries,
  },
};
