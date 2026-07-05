"use strict";
// ── FIND_UNBOUNDED_OBJECT_GROWTH — in-memory cache leak hygiene scan ───────
// Scans JS/TS files for module-level Map/Set/plain-object caches that are
// populated (.set()/.add()/dynamic-key-assignment) inside what looks like a
// request handler or loop, with no corresponding .delete()/.clear()/eviction
// logic anywhere in the same file — the classic "cache that only grows"
// slow memory leak shape in a long-running Node process.
//
// Detection, pure text-scan (regex + fixed lookback window), not an AST/
// scope parser:
//   1. Module-level declaration: a `const/let/var NAME = new Map(...)` /
//      `new Set(...)` / `NAME = {}` (bare empty object literal only, to
//      avoid flagging ordinary config objects) on an UNINDENTED line — the
//      same "column 0 = module scope" heuristic used nowhere else yet in
//      this codebase but a reasonable low-cost proxy for "not local to a
//      function", since a real scope-aware check would need a full parser.
//   2. Population site: `NAME.set(`/`NAME.add(` for Map/Set, or
//      `NAME[...] =`/`NAME.key =` (dynamic property assignment, not `==`)
//      for plain objects — searched anywhere in the file. Each match is
//      checked against a 30-line lookback window for a handler-signature
//      hint (`(req, res` / `app./router.<verb>(`) or a loop-signature hint
//      (`for(`/`while(`/`.forEach(`/`.map(`) — only matches inside such a
//      context count as "handler/loop populated" per the tool's stated
//      scope; a one-off population at module init time is not flagged.
//   3. Eviction/TTL check: `NAME.delete(`/`NAME.clear(` (Map/Set) or
//      `delete NAME[`/`delete NAME.` (object) anywhere in the file, OR a
//      generic file-wide TTL/eviction keyword hint (ttl/expire/evict/
//      maxSize/LRU, case-insensitive) — either suppresses the finding for
//      that cache, since the keyword hint catches eviction logic written
//      against a helper/wrapper rather than the raw Map/Set methods.
// One finding per flagged cache name (not per population site) to avoid
// duplicate spam across a hot loop calling .set() many times.

const fs   = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;
const LOOKBACK_LINES = 30;

const MAP_SET_DECL_RE = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+(Map|Set)\s*\(/;
const OBJECT_DECL_RE = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\{\}\s*;?\s*$/;
const HANDLER_HINT_RE = /\(\s*req\s*,\s*res\b|\b(?:app|router)\s*\.\s*(?:get|post|put|delete|patch|all|use)\s*\(/;
const LOOP_HINT_RE = /\bfor\s*\(|\bwhile\s*\(|\.\s*forEach\s*\(|\.\s*map\s*\(/;
const EVICTION_KEYWORD_RE = /\b(?:ttl|expire|evict|maxsize|max_size|lru)\b/i;

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

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findDeclaredCaches(lines) {
  const caches = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s/.test(line)) continue; // only unindented (module-level) declarations
    let m = MAP_SET_DECL_RE.exec(line);
    if (m) { caches.push({ name: m[1], kind: m[2], declLine: i + 1 }); continue; }
    m = OBJECT_DECL_RE.exec(line);
    if (m) caches.push({ name: m[1], kind: "Object", declLine: i + 1 });
  }
  return caches;
}

function windowBefore(lines, lineIdx, size) {
  const start = Math.max(0, lineIdx - size);
  return lines.slice(start, lineIdx + 1).join("\n");
}

function scanFile(relPath, source) {
  const findings = [];
  const lines = source.split(/\r\n|\r|\n/);
  const caches = findDeclaredCaches(lines);

  for (const cache of caches) {
    const nameRe = escapeRegExp(cache.name);
    let populationRe, deletionRe;
    if (cache.kind === "Object") {
      populationRe = new RegExp(`\\b${nameRe}(?:\\[[^\\]\\n]+\\]|\\.[A-Za-z_$][\\w$]*)\\s*=(?!=)`, "g");
      deletionRe = new RegExp(`\\bdelete\\s+${nameRe}\\s*(?:\\[|\\.)`);
    } else {
      const method = cache.kind === "Map" ? "set" : "add";
      populationRe = new RegExp(`\\b${nameRe}\\s*\\.\\s*${method}\\s*\\(`, "g");
      deletionRe = new RegExp(`\\b${nameRe}\\s*\\.\\s*(?:delete|clear)\\s*\\(`);
    }

    if (deletionRe.test(source) || EVICTION_KEYWORD_RE.test(source)) continue; // handled elsewhere in file

    let firstFlaggedLine = null;
    let m;
    populationRe.lastIndex = 0;
    while ((m = populationRe.exec(source)) !== null) {
      const lineNo = source.slice(0, m.index).split("\n").length;
      const window = windowBefore(lines, lineNo - 1, LOOKBACK_LINES);
      if (HANDLER_HINT_RE.test(window) || LOOP_HINT_RE.test(window)) {
        firstFlaggedLine = lineNo;
        break;
      }
    }

    if (firstFlaggedLine !== null) {
      findings.push({
        file: relPath,
        line: firstFlaggedLine,
        name: cache.name,
        kind: cache.kind,
        rule: "unbounded_cache_growth",
        severity: "warning",
        message: `Module-level ${cache.kind} '${cache.name}' is populated inside a request handler or loop with no visible .delete()/.clear()/eviction logic anywhere in the file — likely unbounded growth over the process lifetime.`,
      });
    }
  }
  return findings;
}

/**
 * @param {string} absDir   Absolute, jail-validated file or directory to scan.
 * @param {string} origPath Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {string[]} [opts.extensions] File extensions to scan (default JS/TS family).
 * @param {number}   [opts.maxResults] Cap on reported findings (1-5000, default 500).
 * @returns {{path, filesScanned, findingsCount, truncated, findings}}
 */
function findUnboundedObjectGrowth(absDir, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absDir); }
  catch (e) { throw new ToolError(`find_unbounded_object_growth: cannot access '${origPath}': ${e.message}`, -32602); }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_unbounded_object_growth: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_unbounded_object_growth: extensions must be an array of strings.", -32602);

  const extensions = Array.isArray(opts.extensions) && opts.extensions.length ? opts.extensions : DEFAULT_EXTENSIONS;
  const maxResults = Math.min(Math.max(1, Math.trunc(opts.maxResults ?? DEFAULT_MAX_RESULTS)), HARD_MAX_RESULTS);

  const files = stat.isDirectory() ? collectFiles(absDir, extensions) : [path.basename(absDir)];
  const baseDir = stat.isDirectory() ? absDir : path.dirname(absDir);

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
  const truncated = findings.length > maxResults;

  return {
    path: origPath,
    filesScanned: files.length,
    findingsCount: findings.length,
    truncated,
    findings: findings.slice(0, maxResults),
  };
}

module.exports = { findUnboundedObjectGrowth };
