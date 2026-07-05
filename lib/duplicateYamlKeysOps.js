"use strict";
// ── FIND_DUPLICATE_YAML_KEYS — indentation-based YAML duplicate-key scanner ─
// YAML block mappings silently allow duplicate keys at the same level; most
// YAML loaders (js-yaml, PyYAML, etc.) keep only the last value, same
// last-value-wins data-loss bug as find_duplicate_json_keys but for YAML.
// This is a line-oriented heuristic scanner (indentation + regex), NOT a
// real YAML parser: it does not understand flow-style mappings ({a: 1}),
// block scalars (|, >) whose *content* lines merely resemble 'key: value',
// anchors/aliases, or tags. For typical hand-written block-style YAML
// (configs, CI workflows, k8s manifests) this catches the common case
// cleanly; treat findings as a strong lead, not a guaranteed real parser
// error. Zero-dependency, read-only.
const fs = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".yml", ".yaml"];
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

// Extracts a mapping key from the text following an indent (or list dash).
// Handles double-quoted, single-quoted, and plain scalar keys. Returns
// { key } or null if this line isn't a 'key: ...' / 'key:' mapping line.
function parseKey(rest) {
  let m = rest.match(/^"((?:[^"\\]|\\.)*)"\s*:(\s|$)/);
  if (m) return { key: m[1] };
  m = rest.match(/^'([^']*)'\s*:(\s|$)/);
  if (m) return { key: m[1] };
  m = rest.match(/^([^:#\s][^:#]*?)\s*:(\s|$)/);
  if (m) return { key: m[1] };
  return null;
}

function registerKey(level, key, lineNum, docIndex, issues, file) {
  if (level.seen.has(key)) {
    issues.push({ file, doc: docIndex, path: level.path, key, firstLine: level.seen.get(key), duplicateLine: lineNum });
  } else {
    level.seen.set(key, lineNum);
  }
}

function scanYamlText(text, file) {
  const lines = text.split(/\r?\n/);
  const issues = [];
  let stack = [{ indent: -1, seen: new Map(), lastKey: null, path: "$" }];
  let docIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const raw = lines[i];
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (trimmed === "---") {
      docIndex++;
      stack = [{ indent: -1, seen: new Map(), lastKey: null, path: "$" }];
      continue;
    }
    if (trimmed === "...") continue;

    const dashMatch = raw.match(/^(\s*)-\s?(.*)$/);
    if (dashMatch) {
      const dashIndent = dashMatch[1].length;
      while (stack.length > 1 && stack[stack.length - 1].indent >= dashIndent) stack.pop();
      const rest = dashMatch[2];
      if (rest && !rest.startsWith("#")) {
        const keyInfo = parseKey(rest);
        if (keyInfo) {
          const keyIndent = raw.length - rest.length;
          const parent = stack[stack.length - 1];
          const parentPath = parent.path === "$" ? "$" : parent.path;
          const level = { indent: keyIndent, seen: new Map(), lastKey: null, path: parentPath + "[]" };
          stack.push(level);
          registerKey(level, keyInfo.key, lineNum, docIndex, issues, file);
          level.lastKey = keyInfo.key;
        }
      }
      continue;
    }

    const m = raw.match(/^(\s*)(.+)$/);
    if (!m) continue;
    const indent = m[1].length;
    const rest = m[2];
    if (rest.startsWith("#")) continue;
    const keyInfo = parseKey(rest);
    if (!keyInfo) continue;

    while (stack.length > 1 && stack[stack.length - 1].indent > indent) stack.pop();
    let level;
    const top = stack[stack.length - 1];
    if (top.indent === indent) {
      level = top;
    } else {
      const parentPath = top.lastKey ? (top.path === "$" ? top.lastKey : top.path + "." + top.lastKey) : top.path;
      level = { indent, seen: new Map(), lastKey: null, path: parentPath };
      stack.push(level);
    }
    registerKey(level, keyInfo.key, lineNum, docIndex, issues, file);
    level.lastKey = keyInfo.key;
  }
  return issues;
}

function scanFileForDuplicateKeys(absPath, relPath) {
  let buf;
  try { buf = fs.readFileSync(absPath); }
  catch (e) { return { file: relPath, error: `cannot read: ${e.message}`, issues: [] }; }
  if (looksBinary(buf)) return { file: relPath, skipped: true, issues: [] };
  const text = buf.toString("utf8");
  try {
    const issues = scanYamlText(text, relPath);
    return { file: relPath, error: null, issues };
  } catch (e) {
    return { file: relPath, error: e.message, issues: [] };
  }
}

/**
 * @param {string} absDir   Absolute, jail-validated file or directory to scan.
 * @param {string} origPath Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {string[]} [opts.extensions] File extensions to scan (default ['.yml','.yaml']).
 * @param {number}   [opts.maxResults] Cap on reported duplicate-key issues (1-5000, default 500).
 * @returns {{path, filesScanned, filesWithErrors, duplicateKeyCount, truncated, issues, errors}}
 */
function scanYamlDuplicateKeys(absDir, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absDir); }
  catch (e) { throw new ToolError(`find_duplicate_yaml_keys: cannot access '${origPath}': ${e.message}`, -32602); }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_duplicate_yaml_keys: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_duplicate_yaml_keys: extensions must be an array of strings.", -32602);

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
    for (const issue of result.issues) allIssues.push(issue);
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

module.exports = { scanYamlDuplicateKeys };
