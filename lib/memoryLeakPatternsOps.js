"use strict";
/**
 * find_memory_leak_patterns
 *
 * Scans JS/TS files for common patterns that cause memory leaks in long-running
 * Node.js servers:
 *
 *   1. module_scope_cache_no_eviction (warning)
 *      A Map or Set is declared at module scope (zero indentation const/let/var)
 *      and has .set( / .add( calls somewhere in the file, but NO .delete( /
 *      .clear( calls appear anywhere in the file. The cache grows unboundedly
 *      until the process is killed.
 *
 *   2. dom_ref_in_module_scope (warning)
 *      A module-scope variable is assigned a document.querySelector* or
 *      document.getElementById / document.getElementsBy* call result. In a
 *      Node.js/SSR context this is almost always an error (document is
 *      undefined outside a browser); in a browser context a module-scope DOM
 *      reference prevents GC of the element even after it is removed from
 *      the DOM.
 *
 *   3. accumulating_push_in_closure (warning)
 *      An array declared at module scope (zero-indentation) has .push( called
 *      on it inside a nested function/callback (indented context), but no
 *      corresponding .splice(/[0]= slice/shift/pop/length= reset appears
 *      anywhere in the file. The array grows without bound as the callback
 *      fires repeatedly.
 *
 * Siblings: find_setinterval_without_clear, find_missing_remove_event_listener,
 *   find_unbounded_object_growth, find_unbounded_array_push_in_loop
 */
const fs   = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS    = 5000;

// Module-scope declaration: starts at column 0, const/let/var NAME = new Map/Set
// \w+ extended to [\w$]+ to include $ which is valid in JS identifiers
const MODULE_MAP_SET_RE =
  /^(?:const|let|var)\s+([\w$]+)\s*=\s*new\s+(?:Map|Set)\s*\(/gm;

// Module-scope array declaration: starts at column 0
const MODULE_ARRAY_RE =
  /^(?:const|let|var)\s+([\w$]+)\s*=\s*\[/gm;

// DOM query assigned at module scope (line starts at col 0)
const DOM_REF_RE =
  /^(?:const|let|var)\s+([\w$]+)\s*=\s*document\s*\.\s*(?:querySelector(?:All)?|getElementById|getElementsBy\w+|getElement(?:s?)By\w+)\s*\(/gm;

function looksBinary(buf) {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}

function lineOf(src, idx) {
  let n = 1;
  for (let i = 0; i < idx && i < src.length; i++) if (src[i] === "\n") n++;
  return n;
}

/**
 * Collect all files under absDir matching extensions.
 */
function collectFiles(absDir, extensions, relBase) {
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

/**
 * Scan a single file and return findings[].
 */
function scanFile(relPath, src) {
  const findings = [];

  // ── Rule 1: module-scope Map/Set with no eviction ──────────────────────────
  MODULE_MAP_SET_RE.lastIndex = 0;
  let m;
  while ((m = MODULE_MAP_SET_RE.exec(src)) !== null) {
    const name = m[1];
    const esc  = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const hasWrite  = new RegExp(`\\b${esc}\\s*\\.\\s*(?:set|add)\\s*\\(`).test(src);
    const hasEvict  = new RegExp(`\\b${esc}\\s*\\.\\s*(?:delete|clear)\\s*\\(`).test(src);
    if (hasWrite && !hasEvict) {
      findings.push({
        file: relPath,
        line: lineOf(src, m.index),
        variable: name,
        rule: "module_scope_cache_no_eviction",
        severity: "warning",
        message:
          `Module-scope ${src.slice(m.index, m.index + m[0].length).includes("Map") ? "Map" : "Set"} \`${name}\` ` +
          `has .set()/.add() calls but no .delete()/.clear() — it grows without bound and ` +
          `will leak memory in long-running processes. Add an eviction strategy (max-size cap, TTL, ` +
          `or explicit .delete(key) when the item is no longer needed).`,
      });
    }
  }

  // ── Rule 2: DOM reference stored at module scope ────────────────────────────
  DOM_REF_RE.lastIndex = 0;
  while ((m = DOM_REF_RE.exec(src)) !== null) {
    const name = m[1];
    findings.push({
      file: relPath,
      line: lineOf(src, m.index),
      variable: name,
      rule: "dom_ref_in_module_scope",
      severity: "warning",
      message:
        `\`${name}\` stores a DOM query result at module scope. In Node.js/SSR environments ` +
        `\`document\` is undefined and this will throw at load time. In browser environments ` +
        `a module-scope reference keeps the DOM element alive (prevents GC) even after it is ` +
        `removed from the document — a subtle memory leak in SPAs that hot-swap content.`,
    });
  }

  // ── Rule 3: module-scope array accumulated inside closures ─────────────────
  MODULE_ARRAY_RE.lastIndex = 0;
  while ((m = MODULE_ARRAY_RE.exec(src)) !== null) {
    const name = m[1];
    const esc  = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Check for .push( calls that appear on a line OTHER than the declaration line
    // (covers both indented lines and inline callbacks like `app.on('x', () => { arr.push(v); })`)
    const declLineNo = lineOf(src, m.index);
    const pushAnyRe = new RegExp(`\\b${esc}\\s*\\.\\s*push\\s*\\(`, "g");
    let hasPushInCallback = false;
    let pm;
    while ((pm = pushAnyRe.exec(src)) !== null) {
      if (lineOf(src, pm.index) !== declLineNo) { hasPushInCallback = true; break; }
    }
    if (!hasPushInCallback) continue;
    // If there is any reset/drain operation, skip.
    // Note: exclude the initial declaration line (const/let/var NAME = [).
    const hasMethodReset = new RegExp(
      `\\b${esc}\\s*\\.\\s*(?:splice|shift|pop)\\s*\\(|\\b${esc}\\.length\\s*=\\s*0`
    ).test(src);
    // Re-assignment to [] only counts if NOT on a declaration line
    const hasReassign = new RegExp(`^(?![ \\t]*(?:const|let|var)\\s+${esc}).*\\b${esc}\\s*=\\s*\\[`, "m").test(src);
    if (hasMethodReset || hasReassign) continue;
    findings.push({
      file: relPath,
      line: lineOf(src, m.index),
      variable: name,
      rule: "accumulating_push_in_closure",
      severity: "warning",
      message:
        `Module-scope array \`${name}\` has .push() called inside a nested function/callback ` +
        `but no .splice()/.shift()/.pop() or length-reset anywhere in the file. ` +
        `If the callback is invoked repeatedly (event handler, interval, request handler) ` +
        `the array accumulates entries for the life of the process — a classic unbounded-growth ` +
        `memory leak. Drain or cap the array, or use a circular buffer.`,
    });
  }

  return findings;
}

/**
 * Main exported function.
 *
 * @param {string} absPath   Absolute, jail-validated file or directory to scan.
 * @param {string} origPath  Client-relative path echoed in result.
 * @param {object} [opts]
 * @param {string[]} [opts.extensions]  Extensions to scan.
 * @param {number}   [opts.maxResults]  Cap on findings (1-5000, default 500).
 */
function findMemoryLeakPatterns(absPath, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absPath); }
  catch (e) {
    throw new ToolError(
      `find_memory_leak_patterns: cannot access '${origPath}': ${e.message}`,
      -32602
    );
  }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_memory_leak_patterns: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_memory_leak_patterns: extensions must be an array of strings.", -32602);

  const extensions = Array.isArray(opts.extensions) && opts.extensions.length
    ? opts.extensions
    : DEFAULT_EXTENSIONS;
  const maxResults = Math.min(
    Math.max(1, Math.trunc(opts.maxResults ?? DEFAULT_MAX_RESULTS)),
    HARD_MAX_RESULTS
  );

  const files   = stat.isDirectory() ? collectFiles(absPath, extensions, "") : [path.basename(absPath)];
  const baseDir = stat.isDirectory() ? absPath : path.dirname(absPath);

  const findings = [];
  for (const rel of files) {
    let buf;
    try { buf = fs.readFileSync(path.join(baseDir, rel)); }
    catch (_) { continue; }
    if (looksBinary(buf)) continue;
    const source = buf.toString("utf8");
    findings.push(...scanFile(rel, source));
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const truncated    = findings.length > maxResults;
  const warningCount = findings.filter(f => f.severity === "warning").length;
  const errorCount   = findings.filter(f => f.severity === "error").length;

  return {
    path: origPath,
    filesScanned: files.length,
    findingsCount: Math.min(findings.length, maxResults),
    errorCount,
    warningCount,
    truncated,
    findings: findings.slice(0, maxResults),
  };
}

module.exports = { findMemoryLeakPatterns };
