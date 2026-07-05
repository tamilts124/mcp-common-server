"use strict";
// ── FIND_REQ_BODY_MASS_ASSIGNMENT — flag unguarded req.body into ORM writes ─
// Passing `req.body` (or a bare alias of it) straight into a Mongoose/
// Sequelize/generic ORM write call lets a client set ANY field on the model
// — including fields like `role`, `isAdmin`, `verified` that were never
// meant to be client-settable. Classic mass-assignment vulnerability.
// Flags, per call-site:
//   - `mass_assignment_via_create` (error)      — `X.create(` / `new X(` call
//     whose argument is `req.body`, a spread of it (`{...req.body}` /
//     `{...req.body, field: val}`), or a tracked bare-alias variable.
//   - `mass_assignment_via_update` (error)      — `.update(` / `.updateOne(`
//     / `.updateMany(` / `.findByIdAndUpdate(` / `.findOneAndUpdate(` call
//     with the same argument shapes.
// A same-line-or-nearby sanitize hint (`pick(`, `omit(`, `sanitize`,
// `validate`, `Joi.`, `zod`, `.parse(`, `ALLOWED_FIELDS`, `allowlist`,
// case-insensitive, within a small lookback/lookahead window) suppresses
// the finding — same false-positive-reduction convention as
// find_open_redirect_risks' ALLOWLIST_HINT_RE.
//
// Pure text-scan (regex + small line window), not an AST/data-flow parser:
//   CAVEATS:
//     - only a direct `const/let/var NAME = req.body;` (whole-statement
//       alias, no destructure) marks NAME as tainted; taint through any
//       other path (function param, reassignment, spread into another var)
//       is not tracked — same documented tradeoff as
//       find_missing_sort_comparator's numeric-variable tracking.
//     - the sanitize hint is a same-window textual signal, not proof the
//       hint actually reaches the tainted value (e.g. `pick(` used on an
//       unrelated object nearby still suppresses).
//     - `new X(req.body)` is flagged as a lower-confidence `warning` since
//       plain-object constructors that happen to be named like a model
//       (e.g. `new Error(req.body)`) are indistinguishable from real ORM
//       model constructors by text alone.
const fs = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

const BODY_ALIAS_DECL_RE = /\b(?:const|let|var)\s+(\w+)\s*=\s*req\.body\s*;/g;
const SANITIZE_HINT_RE = /\bpick\s*\(|\bomit\s*\(|sanitize|validate|Joi\.|zod\b|\.parse\s*\(|ALLOWED_FIELDS|allowlist|allow_list|whitelist/i;

// Body-shaped argument: `req.body`, `{...req.body}`, `{...req.body, k: v}`,
// or (filled in per-call, see TAINT_NAMES) a tracked alias variable name.
function bodyArgRe(name) {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Whole-value use only: `{...NAME}` / `{...NAME, k: v}` or a bare `NAME`
  // NOT immediately followed by `.field` (field-level access is an explicit,
  // safe allow-list pattern, not a whole-body pass-through).
  return new RegExp(`\\{\\s*\\.\\.\\.${n}\\b[^}]*\\}|\\b${n}\\b(?!\\s*\\.)`, "");
}

const REQ_BODY_WHOLE_RE = /req\s*\.\s*body\b(?!\s*\.)/;

const CREATE_CALL_RE = /\b(\w+)\s*\.\s*create\s*\(([^;]*?)\)/g;
const NEW_CTOR_CALL_RE = /\bnew\s+(\w+)\s*\(([^;)]*)\)/g;
const UPDATE_CALL_RE = /\b(\w+)\s*\.\s*(update|updateOne|updateMany|findByIdAndUpdate|findOneAndUpdate)\s*\(([^;]*?)\)/g;

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

function lineOf(source, idx) {
  return source.slice(0, idx).split("\n").length;
}

function nearbyWindow(source, idx, radius = 120) {
  return source.slice(Math.max(0, idx - radius), Math.min(source.length, idx + radius));
}

function argIsTainted(argText, taintNames) {
  if (REQ_BODY_WHOLE_RE.test(argText)) return true;
  for (const name of taintNames) {
    if (bodyArgRe(name).test(argText)) return true;
  }
  return false;
}

function scanFileForMassAssignment(relPath, source) {
  const findings = [];
  const taintNames = new Set();

  BODY_ALIAS_DECL_RE.lastIndex = 0;
  let m;
  while ((m = BODY_ALIAS_DECL_RE.exec(source)) !== null) taintNames.add(m[1]);

  CREATE_CALL_RE.lastIndex = 0;
  while ((m = CREATE_CALL_RE.exec(source)) !== null) {
    if (!argIsTainted(m[2], taintNames)) continue;
    if (SANITIZE_HINT_RE.test(nearbyWindow(source, m.index))) continue;
    findings.push({
      file: relPath, line: lineOf(source, m.index),
      rule: "mass_assignment_via_create", severity: "error", callee: m[1],
      message: `'${m[1]}.create()' is called with req.body (or an untracked alias of it) with no visible pick/omit/sanitize step — a client can set any field, including ones never meant to be client-writable.`,
    });
  }

  UPDATE_CALL_RE.lastIndex = 0;
  while ((m = UPDATE_CALL_RE.exec(source)) !== null) {
    if (!argIsTainted(m[3], taintNames)) continue;
    if (SANITIZE_HINT_RE.test(nearbyWindow(source, m.index))) continue;
    findings.push({
      file: relPath, line: lineOf(source, m.index),
      rule: "mass_assignment_via_update", severity: "error", callee: `${m[1]}.${m[2]}`,
      message: `'${m[1]}.${m[2]}()' is called with req.body (or an untracked alias of it) with no visible pick/omit/sanitize step — a client can overwrite any field, including ones never meant to be client-writable.`,
    });
  }

  NEW_CTOR_CALL_RE.lastIndex = 0;
  while ((m = NEW_CTOR_CALL_RE.exec(source)) !== null) {
    if (!argIsTainted(m[2], taintNames)) continue;
    if (SANITIZE_HINT_RE.test(nearbyWindow(source, m.index))) continue;
    findings.push({
      file: relPath, line: lineOf(source, m.index),
      rule: "mass_assignment_via_constructor", severity: "warning", callee: m[1],
      message: `'new ${m[1]}(...)' is constructed with req.body (or an untracked alias of it) with no visible pick/omit/sanitize step — flagged as a warning since text-scan can't confirm '${m[1]}' is actually an ORM model.`,
    });
  }

  return findings;
}

/**
 * @param {string} absTarget  Absolute, jail-validated file or directory.
 * @param {string} origPath   Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {string[]} [opts.extensions]
 * @param {number}   [opts.maxResults] Cap on findings[] length (1-5000, default 500).
 * @returns {{path, filesScanned, findingsCount, errorCount, warningCount, truncated, findings: Array}}
 */
function findReqBodyMassAssignment(absTarget, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absTarget); }
  catch (e) { throw new ToolError(`find_req_body_mass_assignment: cannot access '${origPath}': ${e.message}`, -32602); }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_req_body_mass_assignment: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_req_body_mass_assignment: extensions must be an array of strings.", -32602);

  const maxResults = Math.min(Math.max(1, Math.trunc(opts.maxResults ?? DEFAULT_MAX_RESULTS)), HARD_MAX_RESULTS);
  const extensions = Array.isArray(opts.extensions) && opts.extensions.length
    ? opts.extensions : DEFAULT_EXTENSIONS;

  const isDirectory = stat.isDirectory();
  let files;
  if (isDirectory) {
    files = collectFiles(absTarget, extensions);
  } else {
    if (!extensions.some(e => absTarget.endsWith(e)))
      throw new ToolError(`find_req_body_mass_assignment: '${origPath}' does not match any scanned extension.`, -32602);
    files = [path.basename(absTarget)];
  }
  const baseDir = isDirectory ? absTarget : path.dirname(absTarget);

  const findings = [];
  for (const rel of files) {
    let buf;
    try { buf = fs.readFileSync(path.join(baseDir, rel)); }
    catch (_) { continue; }
    if (looksBinary(buf)) continue;
    findings.push(...scanFileForMassAssignment(rel, buf.toString("utf8")));
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const truncated = findings.length > maxResults;
  const errorCount = findings.filter(f => f.severity === "error").length;
  const warningCount = findings.filter(f => f.severity === "warning").length;

  return {
    path: origPath,
    filesScanned: files.length,
    findingsCount: findings.length,
    errorCount, warningCount,
    truncated,
    findings: findings.slice(0, maxResults),
  };
}

module.exports = { findReqBodyMassAssignment };
