"use strict";
// ── FIND_ENV_VAR_USAGE — process.env / os.environ usage vs .env docs ───────
// Scans a source tree for environment-variable references (`process.env.X`,
// `process.env["X"]`, `os.environ['X']`, `os.environ.get('X')`,
// `os.getenv('X')`) and cross-checks the referenced names against one or
// more env-example files (default: .env.example, then .env if present).
// Flags names referenced in code but never documented in an example file
// ("undocumented" — a new var a contributor added without updating the
// example) and names documented but never referenced ("unused" — stale
// config, or referenced dynamically in a way this text-scan can't see).
//
// SECRET-SAFETY: only *key names* are ever extracted from env files — their
// values are read only long enough to locate the `=` separator and are then
// discarded; no value ever appears in this tool's output, even for files
// like `.env` that may contain real secrets. Pure text-scan (no code
// execution), same collectFiles/MCP_IGNORE convention as
// find_unused_dependencies/find_circular_deps.
const fs   = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".py"];

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

// Reference-extraction patterns. Each yields the bare env-var name only.
const REF_PATTERNS = [
  /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g,
  /process\.env\[\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]\s*\]/g,
  /os\.environ\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/g,
  /os\.environ\.get\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g,
  /os\.getenv\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g,
];

function extractReferencedNames(source) {
  const names = new Set();
  for (const re of REF_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source)) !== null) names.add(m[1]);
  }
  return names;
}

// Parse an env file's key names only — values are read (to find the `=`)
// but never retained. Lines starting with # (after trim) are comments.
// `export KEY=val` (shell-sourceable .env style) is also recognised.
function parseEnvFileKeys(raw) {
  const keys = new Set();
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice(7).trimStart() : line;
    const m = withoutExport.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m) keys.add(m[1]);
  }
  return keys;
}

/**
 * @param {string} scanAbsDir   Absolute, jail-validated directory to scan for usage.
 * @param {string} scanOrigPath Client-relative scan path echoed in the result.
 * @param {Array<{absPath: string, origPath: string}>} envFiles Resolved env-example/.env file candidates; missing ones are skipped silently.
 * @param {{ extensions?: string[] }} [opts]
 * @returns {{
 *   scanPath: string, filesScanned: number,
 *   envFilesRead: string[], documentedCount: number,
 *   referencedCount: number,
 *   undocumented: string[], unused: string[],
 * }}
 */
function findEnvVarUsage(scanAbsDir, scanOrigPath, envFiles, opts = {}) {
  const scanStat = fs.statSync(scanAbsDir);
  if (!scanStat.isDirectory())
    throw new Error(`find_env_var_usage: '${scanOrigPath}' is not a directory.`);

  const extensions = Array.isArray(opts.extensions) && opts.extensions.length
    ? opts.extensions : DEFAULT_EXTENSIONS;

  const documented = new Set();
  const envFilesRead = [];
  for (const ef of envFiles) {
    let raw;
    try { raw = fs.readFileSync(ef.absPath, "utf8"); }
    catch (_) { continue; } // missing env-example file is not an error — just nothing to cross-check against
    envFilesRead.push(ef.origPath);
    for (const key of parseEnvFileKeys(raw)) documented.add(key);
  }

  const files = collectFiles(scanAbsDir, extensions);
  const referenced = new Set();
  for (const rel of files) {
    let source;
    try { source = fs.readFileSync(path.join(scanAbsDir, rel), "utf8"); }
    catch (_) { continue; }
    for (const name of extractReferencedNames(source)) referenced.add(name);
  }

  const undocumented = [...referenced].filter(n => !documented.has(n)).sort();
  const unused = [...documented].filter(n => !referenced.has(n)).sort();

  return {
    scanPath: scanOrigPath,
    filesScanned: files.length,
    envFilesRead,
    documentedCount: documented.size,
    referencedCount: referenced.size,
    undocumented,
    unused,
  };
}

module.exports = { findEnvVarUsage };
