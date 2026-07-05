"use strict";
// ── FIND_ENV_VAR_DEFAULT_FALLBACK_MASKING_ERRORS — silent secret fallback scan ──
// Scans JS/TS for `process.env.VAR` / `process.env['VAR']` reads immediately
// followed by a `||` or `??` fallback, where VAR's name looks security-
// sensitive (contains SECRET/KEY/TOKEN/PASSWORD/CREDENTIAL, case-insensitive).
// A missing required secret that silently falls back to a hardcoded or
// empty value instead of failing fast at startup is a common
// misconfiguration-masking bug: the app boots "successfully" with a dev
// placeholder secret in production, e.g. `process.env.JWT_SECRET || 'dev'`.
//
// Distinct from scan_secrets (finds literal hardcoded secret *values*
// anywhere in source) and find_hardcoded_credentials_in_config (config
// files specifically) — this tool doesn't care whether the fallback value
// itself looks like a real secret, only that a sensitively-named env var
// has *any* fallback at all, since even an empty-string or `undefined`
// fallback defeats fail-fast validation.
//
// Pure text-scan (regex), not a control-flow/AST analyzer: does not check
// whether the read is inside a startup validation block that would
// otherwise throw (e.g. `const s = process.env.X || 'd'; if (!s) throw`),
// and does not evaluate what the fallback expression actually is — any
// `||`/`??` immediately after the env read counts as a match, same
// documented-limitation style as sibling scan tools.
const fs = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

const ENV_FALLBACK_RE = /process\s*\.\s*env\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*(['"`])([^'"`]+)\2\s*\])\s*(\|\|(?!\|)|\?\?)\s*/g;
const SENSITIVE_NAME_RE = /SECRET|KEY|TOKEN|PASSWORD|CREDENTIAL/i;

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

function extractFallbackSnippet(source, afterIdx) {
  const stopIdx = (() => {
    for (let i = afterIdx; i < source.length; i++) {
      const c = source[i];
      if (c === ";" || c === "," || c === ")" || c === "\n") return i;
    }
    return source.length;
  })();
  return source.slice(afterIdx, stopIdx).trim();
}

function scanFile(relPath, source, findings) {
  ENV_FALLBACK_RE.lastIndex = 0;
  let m;
  while ((m = ENV_FALLBACK_RE.exec(source)) !== null) {
    const varName = m[1] || m[3];
    if (!SENSITIVE_NAME_RE.test(varName)) continue;
    const fallback = extractFallbackSnippet(source, ENV_FALLBACK_RE.lastIndex);
    findings.push({
      file: relPath,
      line: lineOf(source, m.index),
      rule: "env_var_default_fallback_masking_errors",
      severity: "warning",
      message: `process.env.${varName} has a ${m[4]} fallback (${fallback || "<empty>"}) — a missing required secret silently falls back instead of failing fast at startup.`,
    });
  }
}

/**
 * @param {string} absDir   Absolute, jail-validated file or directory to scan.
 * @param {string} origPath Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {string[]} [opts.extensions] File extensions to scan (default JS/TS family).
 * @param {number}   [opts.maxResults] Cap on reported findings (1-5000, default 500).
 * @returns {{path, filesScanned, envReadsSeen, findingsCount, warningCount, truncated, findings}}
 */
function findEnvVarDefaultFallbackMaskingErrors(absDir, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absDir); }
  catch (e) { throw new ToolError(`find_env_var_default_fallback_masking_errors: cannot access '${origPath}': ${e.message}`, -32602); }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_env_var_default_fallback_masking_errors: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_env_var_default_fallback_masking_errors: extensions must be an array of strings.", -32602);

  const extensions = Array.isArray(opts.extensions) && opts.extensions.length ? opts.extensions : DEFAULT_EXTENSIONS;
  const maxResults = Math.min(Math.max(1, Math.trunc(opts.maxResults ?? DEFAULT_MAX_RESULTS)), HARD_MAX_RESULTS);

  const files = stat.isDirectory() ? collectFiles(absDir, extensions) : [path.basename(absDir)];
  const baseDir = stat.isDirectory() ? absDir : path.dirname(absDir);

  const findings = [];
  let envReadsSeen = 0;

  for (const rel of files) {
    let buf;
    try { buf = fs.readFileSync(path.join(baseDir, rel)); }
    catch (_) { continue; }
    if (looksBinary(buf)) continue;
    const source = buf.toString("utf8");

    const matches = source.match(ENV_FALLBACK_RE);
    envReadsSeen += matches ? matches.length : 0;

    scanFile(rel, source, findings);
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const truncated = findings.length > maxResults;
  const warningCount = findings.filter(f => f.severity === "warning").length;

  return {
    path: origPath,
    filesScanned: files.length,
    envReadsSeen,
    findingsCount: findings.length,
    warningCount,
    truncated,
    findings: findings.slice(0, maxResults),
  };
}

module.exports = { findEnvVarDefaultFallbackMaskingErrors };
