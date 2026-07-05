"use strict";
// ── FIND_UNREACHABLE_MODULES — file-level reachability from entry point(s) ──
// Deeper than find_dead_exports (which only checks "is this export ever
// re-imported by name anywhere in the tree") and find_circular_deps (which
// only detects cycles): this tool builds the actual import/require graph
// starting from one or more entry-point files and does a real graph
// traversal (BFS), then reports every scanned file the traversal never
// reaches at all — i.e. files with zero path back to how the program
// actually starts, not just files nobody happens to `import {name}` from.
// A file can have "used" exports per find_dead_exports yet still be
// unreachable here (e.g. two dead files that import only each other, or a
// file only reachable via a specifier this text-scanner can't statically
// resolve — see CAVEATS below).
//
// Same collectFiles/isIgnored/relative-specifier-resolution conventions as
// circularDepsOps.js/deadExportsOps.js. Pure text-scan (regex-extracted
// specifiers), not a real module resolver/bundler:
//   CAVEATS (conservative-by-omission, not conservative-by-over-marking —
//   unlike find_dead_exports, there's no safe "mark whole file used" escape
//   hatch for graph traversal, so anything below UNDER-reports edges, which
//   means it can produce false positives for "unreachable"; treat results
//   as a starting point for human/agent review, not an authoritative kill
//   list):
//     - only import/export ...from '...', bare `import '...'`,
//       `import('...')`, and `require('...')` are recognised — no
//       webpack/vite magic comments, no path aliases (tsconfig `paths`),
//       no dynamically-constructed specifiers (`require(dir + name)`).
//     - entry points not reachable via any static import (e.g. a CLI bin
//       script spawned as a subprocess, a file loaded by a test runner's
//       config glob, a Next.js page file resolved by filesystem convention
//       alone) will falsely appear unreachable unless explicitly listed in
//       entry_points.
const fs   = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const RESOLVE_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".json"];
const DEFAULT_ENTRY_CANDIDATES = ["index.js", "index.ts", "src/index.js", "src/index.ts", "server.js", "app.js", "main.js"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

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

function resolveRelative(fromRelDir, spec, fileSet) {
  if (!(spec.startsWith(".") || spec.startsWith("/"))) return null; // bare specifier: external package, not part of the graph
  const rawJoined = path.posix.normalize(
    spec.startsWith("/") ? spec.slice(1) : path.posix.join(fromRelDir, spec)
  );
  const candidates = [rawJoined];
  for (const ext of RESOLVE_EXTENSIONS) candidates.push(rawJoined + ext);
  for (const ext of RESOLVE_EXTENSIONS) candidates.push(path.posix.join(rawJoined, "index" + ext));
  for (const c of candidates) if (fileSet.has(c)) return c;
  return null;
}

const IMPORT_FROM_RE  = /(?:import|export)\s+[^;'"`]*?from\s*["'`]([^"'`]+)["'`]/g;
const BARE_IMPORT_RE  = /import\s*["'`]([^"'`]+)["'`]/g;
const DYNAMIC_IMPORT_RE = /import\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
const REQUIRE_RE      = /require\(\s*["'`]([^"'`]+)["'`]\s*\)/g;

function extractSpecifiers(source) {
  const specs = [];
  for (const re of [IMPORT_FROM_RE, BARE_IMPORT_RE, DYNAMIC_IMPORT_RE, REQUIRE_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source)) !== null) specs.push(m[1]);
  }
  return specs;
}

// Resolve default entry point(s): package.json "main" field (if present and
// resolvable in the scanned tree) plus the first of a few common
// filesystem-convention filenames that actually exist. Best-effort, silent
// on any read/parse failure — falls through to whatever candidates did work.
function discoverDefaultEntryPoints(absDir, fileSet) {
  const found = [];
  try {
    const pkgRaw = fs.readFileSync(path.join(absDir, "package.json"), "utf8");
    const pkg = JSON.parse(pkgRaw);
    if (typeof pkg.main === "string") {
      const resolved = resolveRelative("", pkg.main.startsWith("./") ? pkg.main : "./" + pkg.main, fileSet);
      if (resolved) found.push(resolved);
    }
  } catch (_) { /* no/invalid package.json — not fatal, just skip this source */ }
  for (const cand of DEFAULT_ENTRY_CANDIDATES) {
    if (fileSet.has(cand) && !found.includes(cand)) found.push(cand);
  }
  return found;
}

/**
 * @param {string} absDir   Absolute, jail-validated directory to scan.
 * @param {string} origPath Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {string[]} [opts.entryPoints] Explicit entry-point files, relative to absDir (default: auto-discovered).
 * @param {string[]} [opts.extensions]  File extensions to scan.
 * @param {number}   [opts.maxResults]  Cap on reported unreachable files (1-5000, default 500).
 * @returns {{path, entryPoints, filesScanned, reachableCount, unreachableCount, truncated, unreachable: string[]}}
 */
function findUnreachableModules(absDir, origPath, opts = {}) {
  const stat = fs.statSync(absDir);
  if (!stat.isDirectory())
    throw new ToolError(`find_unreachable_modules: '${origPath}' is not a directory.`, -32602);

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_unreachable_modules: max_results must be a number.", -32602);
  if (opts.entryPoints !== undefined && !Array.isArray(opts.entryPoints))
    throw new ToolError("find_unreachable_modules: entry_points must be an array of strings.", -32602);

  const extensions = Array.isArray(opts.extensions) && opts.extensions.length
    ? opts.extensions : DEFAULT_EXTENSIONS;
  const maxResults = Math.min(Math.max(1, Math.trunc(opts.maxResults ?? DEFAULT_MAX_RESULTS)), HARD_MAX_RESULTS);

  const files = collectFiles(absDir, extensions);
  const fileSet = new Set(files);

  let entryPoints;
  let entryPointsSource;
  if (Array.isArray(opts.entryPoints) && opts.entryPoints.length) {
    entryPoints = [];
    for (const ep of opts.entryPoints) {
      if (typeof ep !== "string" || !ep.length)
        throw new ToolError("find_unreachable_modules: every entry_points item must be a non-empty string.", -32602);
      const norm = path.posix.normalize(ep.replace(/^\.\//, ""));
      if (!fileSet.has(norm))
        throw new ToolError(`find_unreachable_modules: entry point '${ep}' was not found among scanned files (check the path is relative to '${origPath}' and matches one of the scanned extensions).`, -32602);
      entryPoints.push(norm);
    }
    entryPointsSource = "explicit";
  } else {
    entryPoints = discoverDefaultEntryPoints(absDir, fileSet);
    entryPointsSource = "auto-discovered";
    if (entryPoints.length === 0)
      throw new ToolError(`find_unreachable_modules: could not auto-discover an entry point in '${origPath}' (no package.json "main" and none of ${DEFAULT_ENTRY_CANDIDATES.join(", ")} exist). Pass entry_points explicitly.`, -32602);
  }

  const visited = new Set();
  const queue = [...entryPoints];
  while (queue.length) {
    const rel = queue.shift();
    if (visited.has(rel)) continue;
    visited.add(rel);
    let source;
    try { source = fs.readFileSync(path.join(absDir, rel), "utf8"); }
    catch (_) { continue; }
    const fromDir = path.posix.dirname(rel) === "." ? "" : path.posix.dirname(rel);
    for (const spec of extractSpecifiers(source)) {
      const resolved = resolveRelative(fromDir, spec, fileSet);
      if (resolved && !visited.has(resolved)) queue.push(resolved);
    }
  }

  const unreachable = files.filter(f => !visited.has(f)).sort();
  const truncated = unreachable.length > maxResults;

  return {
    path: origPath,
    entryPoints,
    entryPointsSource,
    filesScanned: files.length,
    reachableCount: visited.size,
    unreachableCount: unreachable.length,
    truncated,
    unreachable: unreachable.slice(0, maxResults),
  };
}

module.exports = { findUnreachableModules };
