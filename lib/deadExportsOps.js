"use strict";
// ── FIND_DEAD_EXPORTS — JS/TS exports never imported anywhere else ────────
// Pure text-scan (no real module resolution/bundler), same collectFiles +
// relative-specifier resolution approach as lib/circularDepsOps.js. Scans
// both ESM (export const/function/class/default, export {a as b}, export
// {a} from './x') and CJS (module.exports.NAME=, module.exports={a,b})
// syntax for exports, and both ESM (import {a} / import Def / import * as
// ns) and CJS (const {a}=require(), const x=require()) syntax for usage.
//
// Conservative by design: anything we can't cleanly resolve to a specific
// named import (namespace import, whole-module require, `export * from`)
// marks the ENTIRE target file as used rather than risking a false
// positive. A file whose only importer is external to the scanned tree
// (e.g. a package.json "main" entry point) will have its exports reported
// as dead — expected given intra-project-only scope, not a bug (same
// scoping convention as find_circular_deps).
const fs   = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const RESOLVE_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".json"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

function collectFiles(absDir, extensions, relBase = "") {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); }
  catch (e) { return out; }
  for (const ent of entries) {
    if (isIgnored(ent.name)) continue;
    const abs = path.join(absDir, ent.name);
    const rel = relBase ? relBase + "/" + ent.name : ent.name;
    if (ent.isDirectory()) out.push(...collectFiles(abs, extensions, rel));
    else if (ent.isFile() && extensions.some(e => ent.name.endsWith(e))) out.push(rel);
  }
  return out;
}

function resolveRelative(fromRelDir, spec, fileSet) {
  if (!(spec.startsWith(".") || spec.startsWith("/"))) return null; // bare specifier: external
  const rawJoined = path.posix.normalize(
    spec.startsWith("/") ? spec.slice(1) : path.posix.join(fromRelDir, spec)
  );
  const candidates = [rawJoined];
  for (const ext of RESOLVE_EXTENSIONS) candidates.push(rawJoined + ext);
  for (const ext of RESOLVE_EXTENSIONS) candidates.push(path.posix.join(rawJoined, "index" + ext));
  for (const c of candidates) if (fileSet.has(c)) return c;
  return null;
}

function lineOf(source, index) {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) if (source[i] === "\n") line++;
  return line;
}

// Parse a comma-separated `{ a, b as c }` / `{ a, b: c }` item list into
// the ORIGINAL/EXPORTED name for each entry (left side of as/: ), which is
// what we key exports/usage by regardless of local renaming.
function parseNameList(raw) {
  return raw.split(",").map(s => s.trim()).filter(Boolean).map(item => {
    const asMatch = item.match(/^([A-Za-z_$][\w$]*)\s+as\s+[A-Za-z_$][\w$]*$/);
    if (asMatch) return asMatch[1];
    const colonMatch = item.match(/^([A-Za-z_$][\w$]*)\s*:\s*[A-Za-z_$][\w$]*$/);
    if (colonMatch) return colonMatch[1];
    const bare = item.match(/^([A-Za-z_$][\w$]*)$/);
    return bare ? bare[1] : null;
  }).filter(Boolean);
}

const EXPORT_NAMED_RE   = /export\s+(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/g;
const EXPORT_DEFAULT_RE = /export\s+default\b/g;
const EXPORT_LIST_RE    = /export\s*\{([^}]*)\}\s*(?!from)/g;
const EXPORT_REEXPORT_RE = /export\s*\{([^}]*)\}\s*from\s*["'`]([^"'`]+)["'`]/g;
const EXPORT_STAR_RE    = /export\s*\*\s*(?:as\s+\w+\s+)?from\s*["'`]([^"'`]+)["'`]/g;
const CJS_PROP_EXPORT_RE = /module\.exports\.([A-Za-z_$][\w$]*)\s*=/g;
const CJS_OBJECT_EXPORT_RE = /module\.exports\s*=\s*\{([\s\S]*?)\}/;

const IMPORT_RE = /import\s+(?:([A-Za-z_$][\w$]*)\s*(?:,\s*)?)?(?:\{([^}]*)\}\s*)?(?:\*\s*as\s+([A-Za-z_$][\w$]*)\s*)?from\s*["'`]([^"'`]+)["'`]/g;
const REQUIRE_DESTRUCTURE_RE = /const\s*\{([^}]*)\}\s*=\s*require\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
const REQUIRE_WHOLE_RE = /(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*require\(\s*["'`]([^"'`]+)["'`]\s*\)/g;

/**
 * Find JS/TS exports never imported anywhere else in the scanned tree.
 * @param {string} absDir   Absolute, jail-validated directory path.
 * @param {string} origPath Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {string[]} [opts.extensions]  File extensions to scan (default DEFAULT_EXTENSIONS).
 * @param {number}   [opts.maxResults]  Cap on reported dead exports (1-5000, default 500).
 * @returns {{path, filesScanned, exportsFound, deadCount, truncated, dead: Array}}
 */
function findDeadExports(absDir, origPath, opts = {}) {
  const stat = fs.statSync(absDir);
  if (!stat.isDirectory())
    throw new Error(`find_dead_exports: '${origPath}' is not a directory.`);

  const extensions = Array.isArray(opts.extensions) && opts.extensions.length
    ? opts.extensions : DEFAULT_EXTENSIONS;
  const maxResults = Math.min(Math.max(1, Math.trunc(opts.maxResults ?? DEFAULT_MAX_RESULTS)), HARD_MAX_RESULTS);

  const files   = collectFiles(absDir, extensions);
  const fileSet = new Set(files);
  const exportsByFile = new Map(); // rel -> Map(name -> line)
  const usedByFile     = new Map(); // rel -> Set(name)
  const fullyUsedFiles = new Set();
  let exportsFound = 0;

  const addExport = (rel, name, line) => {
    if (!exportsByFile.has(rel)) exportsByFile.set(rel, new Map());
    if (!exportsByFile.get(rel).has(name)) { exportsByFile.get(rel).set(name, line); exportsFound++; }
  };
  const addUsed = (rel, name) => {
    if (!usedByFile.has(rel)) usedByFile.set(rel, new Set());
    usedByFile.get(rel).add(name);
  };

  for (const rel of files) {
    let source;
    try { source = fs.readFileSync(path.join(absDir, rel), "utf8"); }
    catch (e) { continue; }
    const fromDir = path.posix.dirname(rel) === "." ? "" : path.posix.dirname(rel);

    let m;
    EXPORT_NAMED_RE.lastIndex = 0;
    while ((m = EXPORT_NAMED_RE.exec(source)) !== null) addExport(rel, m[1], lineOf(source, m.index));

    EXPORT_DEFAULT_RE.lastIndex = 0;
    if (EXPORT_DEFAULT_RE.exec(source)) addExport(rel, "default", lineOf(source, source.search(EXPORT_DEFAULT_RE)));

    EXPORT_LIST_RE.lastIndex = 0;
    while ((m = EXPORT_LIST_RE.exec(source)) !== null)
      for (const name of parseNameList(m[1])) addExport(rel, name, lineOf(source, m.index));

    EXPORT_REEXPORT_RE.lastIndex = 0;
    while ((m = EXPORT_REEXPORT_RE.exec(source)) !== null) {
      const names = parseNameList(m[1]);
      for (const name of names) addExport(rel, name, lineOf(source, m.index));
      const resolved = resolveRelative(fromDir, m[2], fileSet);
      if (resolved) for (const name of names) addUsed(resolved, name);
    }

    EXPORT_STAR_RE.lastIndex = 0;
    while ((m = EXPORT_STAR_RE.exec(source)) !== null) {
      const resolved = resolveRelative(fromDir, m[1], fileSet);
      if (resolved) fullyUsedFiles.add(resolved);
    }

    CJS_PROP_EXPORT_RE.lastIndex = 0;
    while ((m = CJS_PROP_EXPORT_RE.exec(source)) !== null) addExport(rel, m[1], lineOf(source, m.index));

    const objMatch = source.match(CJS_OBJECT_EXPORT_RE);
    if (objMatch) for (const name of parseNameList(objMatch[1])) addExport(rel, name, lineOf(source, objMatch.index));

    IMPORT_RE.lastIndex = 0;
    while ((m = IMPORT_RE.exec(source)) !== null) {
      const [, defaultName, namedList, nsName, spec] = m;
      const resolved = resolveRelative(fromDir, spec, fileSet);
      if (!resolved) continue;
      if (nsName) fullyUsedFiles.add(resolved);
      if (defaultName) addUsed(resolved, "default");
      if (namedList) for (const name of parseNameList(namedList)) addUsed(resolved, name);
    }

    REQUIRE_DESTRUCTURE_RE.lastIndex = 0;
    while ((m = REQUIRE_DESTRUCTURE_RE.exec(source)) !== null) {
      const resolved = resolveRelative(fromDir, m[2], fileSet);
      if (resolved) for (const name of parseNameList(m[1])) addUsed(resolved, name);
    }

    REQUIRE_WHOLE_RE.lastIndex = 0;
    while ((m = REQUIRE_WHOLE_RE.exec(source)) !== null) {
      const resolved = resolveRelative(fromDir, m[1], fileSet);
      if (resolved) fullyUsedFiles.add(resolved);
    }
  }

  const dead = [];
  for (const [rel, nameMap] of exportsByFile) {
    if (fullyUsedFiles.has(rel)) continue;
    const used = usedByFile.get(rel) || new Set();
    for (const [name, line] of nameMap) {
      if (!used.has(name)) dead.push({ file: rel, name, line });
    }
  }
  dead.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  const truncated = dead.length > maxResults;
  const result = dead.slice(0, maxResults);

  return {
    path: origPath,
    filesScanned: files.length,
    exportsFound,
    deadCount: dead.length,
    truncated,
    dead: result,
  };
}

module.exports = { findDeadExports };
