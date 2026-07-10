"use strict";
/**
 * find_circular_reference_risks
 *
 * Scans JS/TS files for patterns that create circular object references —
 * structures that cause JSON.stringify() to throw ("Converting circular
 * structure to JSON") and can prevent garbage collection in older engines.
 *
 * Rules:
 *
 *   1. self_reference_assignment (error)
 *      `obj.prop = obj` — an object's own property is set to the object
 *      itself. This is the most common accidental circular reference.
 *      Detected shapes:
 *        NAME.anything = NAME
 *        NAME[anything] = NAME
 *        NAME.anything.anything = NAME   (one level of nesting)
 *
 *   2. mutual_module_scope_reference (warning)
 *      Two module-scope identifiers (zero-indentation const/let/var NAME)
 *      reference each other:  A.ref = B  AND  B.ref = A  appear in the
 *      same file. A classic circular-singleton pattern that breaks
 *      JSON serialization of either object.
 *
 *   3. circular_require_risk (warning)
 *      A `require()` call references a sibling module that, judged by its
 *      name, likely already requires the current file (mutual-require pattern:
 *      e.g.  a.js requires b.js, b.js requires a.js). Detected heuristically:
 *      if the same base-name string appears as a require argument in two
 *      different files in the same directory (would need cross-file scan).
 *      Scope: single-file only — flags when the file imports a module whose
 *      base name is the same as a module-scope export name in this file
 *      (BASENAME_MATCH heuristic), suggesting a likely mutual dependency.
 *
 * Siblings: find_memory_leak_patterns, find_circular_deps (import-graph
 *   level), find_unbounded_object_growth
 */
const fs   = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS    = 5000;

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
 * Collect all module-scope identifier names (const/let/var at col 0).
 */
function collectModuleScopeNames(src) {
  const re = /^(?:const|let|var)\s+(\w+)/gm;
  const names = new Set();
  let m;
  while ((m = re.exec(src)) !== null) names.add(m[1]);
  return names;
}

/**
 * Scan a single file for circular reference risks.
 */
function scanFile(relPath, src) {
  const findings = [];
  const lines    = src.split("\n");

  // ── Rule 1: self_reference_assignment ──────────────────────────────────────
  // Matches: NAME.prop = NAME  or  NAME[...] = NAME  or NAME.p.q = NAME
  const SELF_REF_RE =
    /\b(\w+)(?:\.\w+|\[[^\]]+\])(?:\.\w+)?\s*=\s*\1\b/g;
  let m;
  while ((m = SELF_REF_RE.exec(src)) !== null) {
    const name = m[1];
    // Skip assignments where rhs is a different identifier (false positives from
    // operator-like constructs are unlikely here, but skip 'this' self-refs
    // for React/class idiom: this.x = this is unusual but valid)
    if (name === "this" || name === "self" || name === "window" || name === "global") continue;
    findings.push({
      file: relPath,
      line: lineOf(src, m.index),
      variable: name,
      rule: "self_reference_assignment",
      severity: "error",
      message:
        `\`${m[0].trim()}\` — \`${name}\` holds a reference to itself. ` +
        `JSON.stringify(${name}) will throw "Converting circular structure to JSON". ` +
        `Any serialization or deep-clone attempt will also fail or loop infinitely. ` +
        `Use a WeakRef, a separate parent-link convention, or restructure the data model.`,
    });
  }

  // ── Rule 2: mutual_module_scope_reference ───────────────────────────────────
  // Collect all module-scope names, then look for A.x = B AND B.y = A patterns
  const moduleNames = collectModuleScopeNames(src);
  if (moduleNames.size >= 2) {
    // For each pair (A, B) check for cross-assignment
    const namesArr = [...moduleNames];
    // Build assignment map: name -> set of names it references via .prop = OTHER
    const assignsTo = new Map(); // A -> [B, C, ...]
    const ASSIGN_RE = /\b(\w+)\s*\.\s*\w+\s*=\s*(\w+)\b/g;
    while ((m = ASSIGN_RE.exec(src)) !== null) {
      const [, lhs, rhs] = m;
      if (!moduleNames.has(lhs) || !moduleNames.has(rhs) || lhs === rhs) continue;
      if (!assignsTo.has(lhs)) assignsTo.set(lhs, new Set());
      assignsTo.get(lhs).add(rhs);
    }
    // Detect symmetric pairs
    const reported = new Set();
    for (const [a, targets] of assignsTo) {
      for (const b of targets) {
        const pair = [a, b].sort().join("|");
        if (reported.has(pair)) continue;
        if (assignsTo.get(b)?.has(a)) {
          reported.add(pair);
          // Find the line of A.x = B
          const aToB_Re = new RegExp(`\\b${a}\\s*\\.\\s*\\w+\\s*=\\s*${b}\\b`);
          const lineIdx = lines.findIndex(l => aToB_Re.test(l));
          findings.push({
            file: relPath,
            line: lineIdx >= 0 ? lineIdx + 1 : 1,
            variables: [a, b],
            rule: "mutual_module_scope_reference",
            severity: "warning",
            message:
              `Module-scope objects \`${a}\` and \`${b}\` reference each other ` +
              `(\`${a}.x = ${b}\` and \`${b}.y = ${a}\`). This mutual reference ` +
              `creates a circular structure: JSON.stringify of either will throw, ` +
              `and in engines without mark-and-sweep GC the pair may leak. ` +
              `Break the cycle by extracting shared state into a third object, ` +
              `using WeakRef, or restructuring the dependency.`,
          });
        }
      }
    }
  }

  // ── Rule 3: circular_require_risk ──────────────────────────────────────────
  // Collect all require() arguments (relative paths only) and all
  // module.exports / exports.NAME assignments. Flag if a required module
  // name matches an exported name (heuristic for mutual-require pairs).
  const requirePaths = [];
  const REQ_RE = /\brequire\s*\(\s*['"`](\.[^'"`]+)['"`]\s*\)/g;
  while ((m = REQ_RE.exec(src)) !== null) requirePaths.push({ spec: m[1], idx: m.index });

  const exportedNames = new Set();
  const EXP_RE = /\bmodule\.exports\.(\w+)\s*=|exports\.(\w+)\s*=/g;
  while ((m = EXP_RE.exec(src)) !== null) exportedNames.add(m[1] || m[2]);

  for (const { spec, idx } of requirePaths) {
    // Get the base name of the required module without extension
    const requiredBase = path.basename(spec).replace(/\.[^.]+$/, "");
    // If the required module's base name appears in the same file's exports,
    // it's likely a mutual-dependency situation (A exports A, requires ./A)
    // — but more precisely, if the required module name is the SAME as this
    // file's own base name (A requires ./A — direct self-require), flag it.
    // For cross-file mutual: flag if a module-scope name assigned from the
    // require result is also in exportedNames (suggests the required module
    // might export back to us)
    // Self-require check
    // (Assigned to a const: `const X = require('./a')` where base is 'a')
    // Check the line for pattern: const NAME = require('./BASENAME')
    const lineNo = lineOf(src, idx);
    const lineTxt = lines[lineNo - 1] || "";
    const assignMatch = lineTxt.match(/\b(?:const|let|var)\s+(\w+)\s*=\s*require/);
    if (assignMatch) {
      const importedName = assignMatch[1];
      if (exportedNames.has(importedName) && requiredBase !== importedName) {
        // The imported variable name clashes with something this file exports
        // pointing to potential re-export / mutual dependency
        findings.push({
          file: relPath,
          line: lineNo,
          variable: importedName,
          required: spec,
          rule: "circular_require_risk",
          severity: "warning",
          message:
            `\`${importedName}\` is imported from '${spec}' but this file also ` +
            `exports \`${importedName}\` via \`exports.${importedName}\` or ` +
            `\`module.exports.${importedName}\`. If '${spec}' also requires this ` +
            `file, Node.js will return an incomplete (partially-initialised) module ` +
            `object at require-time — a silent circular-require bug. ` +
            `Refactor shared state into a dedicated module to break the cycle.`,
        });
      }
    }
  }

  return findings;
}

/**
 * Main exported function.
 *
 * @param {string} absPath   Absolute, jail-validated file or directory.
 * @param {string} origPath  Client-relative path echoed in result.
 * @param {object} [opts]
 * @param {string[]} [opts.extensions]  Extensions to scan.
 * @param {number}   [opts.maxResults]  Cap on findings (1-5000, default 500).
 */
function findCircularReferenceRisks(absPath, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absPath); }
  catch (e) {
    throw new ToolError(
      `find_circular_reference_risks: cannot access '${origPath}': ${e.message}`,
      -32602
    );
  }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_circular_reference_risks: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_circular_reference_risks: extensions must be an array of strings.", -32602);

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
  const errorCount   = findings.filter(f => f.severity === "error").length;
  const warningCount = findings.filter(f => f.severity === "warning").length;

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

module.exports = { findCircularReferenceRisks };
