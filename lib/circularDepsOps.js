"use strict";
// ── FIND_CIRCULAR_DEPS — detect import/require cycles in JS/TS sources ────
// Pure text-scan (no real module resolution / no bundler): regex-extracts
// static `require("...")`, `import ... from "..."`, `export ... from "..."`,
// and dynamic `import("...")` specifiers per file, resolves *relative*
// specifiers against the importing file's directory (extension-probing +
// index-file fallback), builds a directed graph keyed by root-relative
// path, then DFS's it with a recursion stack to report every unique cycle.
// Bare specifiers (npm packages, node builtins, path aliases) are skipped —
// this is an intra-project cycle detector, not a full resolver.

const fs   = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const RESOLVE_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".json"];

// Matches: require("x") / require('x') ; import ... from "x" ; export ... from "x" ;
// bare `import "x"` (side-effect only) ; dynamic import("x").
const SPEC_RE = /(?:require\(\s*["'`]([^"'`]+)["'`]\s*\)|import\s*\(\s*["'`]([^"'`]+)["'`]\s*\)|(?:import|export)(?:[^'"`;]*?from)?\s*["'`]([^"'`]+)["'`])/g;

function extractSpecifiers(source) {
  const specs = [];
  let m;
  SPEC_RE.lastIndex = 0;
  while ((m = SPEC_RE.exec(source)) !== null) {
    const spec = m[1] || m[2] || m[3];
    if (spec) specs.push(spec);
  }
  return specs;
}

function collectFiles(absDir, extensions, relBase = "") {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); }
  catch (e) { return out; }
  for (const ent of entries) {
    if (isIgnored(ent.name)) continue;
    const abs = path.join(absDir, ent.name);
    const rel = relBase ? relBase + "/" + ent.name : ent.name;
    if (ent.isDirectory()) {
      out.push(...collectFiles(abs, extensions, rel));
    } else if (ent.isFile() && extensions.some(e => ent.name.endsWith(e))) {
      out.push(rel);
    }
  }
  return out;
}

// Resolve a relative specifier (already known to start with '.' or '/')
// against the importing file's directory. Returns the resolved root-relative
// path (posix-separated) if it matches a known file, else null.
function resolveRelative(fromRelDir, spec, fileSet) {
  const rawJoined = path.posix.normalize(
    spec.startsWith("/") ? spec.slice(1) : path.posix.join(fromRelDir, spec)
  );
  const candidates = [rawJoined];
  for (const ext of RESOLVE_EXTENSIONS) candidates.push(rawJoined + ext);
  for (const ext of RESOLVE_EXTENSIONS) candidates.push(path.posix.join(rawJoined, "index" + ext));
  for (const c of candidates) if (fileSet.has(c)) return c;
  return null;
}

/**
 * Detect circular import/require chains in a JS/TS project subtree.
 * @param {string} absDir   Absolute, jail-validated directory path.
 * @param {string} origPath Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {string[]} [opts.extensions]  File extensions to scan (default DEFAULT_EXTENSIONS).
 * @param {number}   [opts.maxCycles]   Cap on reported cycles (1-1000, default 200).
 * @returns {{path, filesScanned, edgesFound, cycles:Array<string[]>, cycleCount, truncated}}
 */
function findCircularDeps(absDir, origPath, opts = {}) {
  const stat = fs.statSync(absDir);
  if (!stat.isDirectory())
    throw new Error(`find_circular_deps: '${origPath}' is not a directory.`);

  const extensions = Array.isArray(opts.extensions) && opts.extensions.length
    ? opts.extensions : DEFAULT_EXTENSIONS;
  const maxCycles = Math.min(Math.max(1, Math.trunc(opts.maxCycles ?? 200)), 1000);

  const files   = collectFiles(absDir, extensions);
  const fileSet = new Set(files);
  const graph   = new Map(); // relPath -> Set(relPath)
  let edgesFound = 0;

  for (const rel of files) {
    let source;
    try { source = fs.readFileSync(path.join(absDir, rel), "utf8"); }
    catch (e) { continue; }
    const fromDir = path.posix.dirname(rel);
    const deps = new Set();
    for (const spec of extractSpecifiers(source)) {
      if (!spec.startsWith(".") && !spec.startsWith("/")) continue; // skip bare specifiers
      const resolved = resolveRelative(fromDir === "." ? "" : fromDir, spec, fileSet);
      if (resolved && resolved !== rel) { deps.add(resolved); edgesFound++; }
    }
    graph.set(rel, deps);
  }

  // DFS cycle detection with recursion-stack path tracking.
  const cycles = [];
  const seenCycleKeys = new Set();
  const state = new Map(); // relPath -> 0=unvisited,1=in-stack,2=done
  const stack = [];
  let truncated = false;

  function dfs(node) {
    if (truncated) return;
    state.set(node, 1);
    stack.push(node);
    for (const dep of graph.get(node) || []) {
      if (truncated) break;
      const st = state.get(dep) || 0;
      if (st === 1) {
        const idx = stack.indexOf(dep);
        const cyclePath = stack.slice(idx).concat(dep);
        const key = [...new Set(cyclePath)].sort().join("|");
        if (!seenCycleKeys.has(key)) {
          seenCycleKeys.add(key);
          if (cycles.length < maxCycles) cycles.push(cyclePath);
          else truncated = true;
        }
      } else if (st === 0) {
        dfs(dep);
      }
    }
    stack.pop();
    state.set(node, 2);
  }

  for (const rel of files) {
    if (truncated) break;
    if (!state.get(rel)) dfs(rel);
  }

  return {
    path: origPath,
    filesScanned: files.length,
    edgesFound,
    cycles,
    cycleCount: cycles.length,
    truncated,
  };
}

module.exports = { findCircularDeps };
