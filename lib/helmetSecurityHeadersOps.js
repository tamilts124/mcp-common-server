"use strict";
// ── CHECK_MISSING_HELMET_SECURITY_HEADERS — generic hardening-header scan ──
// Broader sibling of check_missing_csp_header: that tool checks only the
// CSP-specific header. This tool checks for the presence of *any* generic
// security-hardening header helmet sets by default (X-Content-Type-Options,
// X-Frame-Options, Strict-Transport-Security, X-DNS-Prefetch-Control,
// X-Download-Options, X-Permitted-Cross-Domain-Policies) or the `helmet(`
// middleware call itself, which sets all of them at once.
//
// Two independent checks:
//   1. Project-level: if any file registers Express routes but NO file in
//      the same scan sets ANY of the recognized hardening headers/`helmet(`
//      call anywhere — a single project-level finding, `missing_security_headers`.
//   2. Per-call-site: `helmet({ ... })` with one or more of its built-in
//      header modules explicitly turned off (`frameguard: false`,
//      `hsts: false`, `noSniff: false`, `dnsPrefetchControl: false`,
//      `ieNoOpen: false`, `permittedCrossDomainPolicies: false`) — flagged
//      individually per disabled module, same "easy to miss" rationale as
//      check_missing_csp_header's csp_explicitly_disabled rule.
//
// Pure text-scan (regex + looksBinary skip), not an AST/app-instance-aware
// parser — same documented heuristic gaps as check_missing_csp_header
// (project-wide hint, literal header-name/option matching only).
const fs = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

const ROUTE_REGISTRATION_RE = /\b(?:app|router)\s*\.\s*(?:get|post|put|delete|patch|all)\s*\(/;
const HEADER_HINT_RE = /\bhelmet\s*\(|x-content-type-options|x-frame-options|strict-transport-security|x-dns-prefetch-control|x-download-options|x-permitted-cross-domain-policies/i;

// module option name -> { headerName, rule label already implied by option }
const DISABLED_MODULE_RES = [
  { re: /\bframeguard\s*:\s*false\b/g, option: "frameguard", header: "X-Frame-Options" },
  { re: /\bhsts\s*:\s*false\b/g, option: "hsts", header: "Strict-Transport-Security" },
  { re: /\bnoSniff\s*:\s*false\b/g, option: "noSniff", header: "X-Content-Type-Options" },
  { re: /\bdnsPrefetchControl\s*:\s*false\b/g, option: "dnsPrefetchControl", header: "X-DNS-Prefetch-Control" },
  { re: /\bieNoOpen\s*:\s*false\b/g, option: "ieNoOpen", header: "X-Download-Options" },
  { re: /\bpermittedCrossDomainPolicies\s*:\s*false\b/g, option: "permittedCrossDomainPolicies", header: "X-Permitted-Cross-Domain-Policies" },
];

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

function scanFileForDisabledModules(relPath, source) {
  const findings = [];
  for (const { re, option, header } of DISABLED_MODULE_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source)) !== null) {
      findings.push({
        file: relPath,
        line: lineOf(source, m.index),
        rule: "helmet_module_explicitly_disabled",
        severity: "warning",
        message: `helmet's '${option}' module is explicitly disabled (${option}: false) — the ${header} header will not be set by helmet. Confirm this is intentional and the header is set elsewhere.`,
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
 * @returns {{path, filesScanned, hasRouteRegistrations, hasSecurityHeaderHint, findingsCount, errorCount, warningCount, truncated, findings}}
 */
function checkMissingHelmetSecurityHeaders(absDir, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absDir); }
  catch (e) { throw new ToolError(`check_missing_helmet_security_headers: cannot access '${origPath}': ${e.message}`, -32602); }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("check_missing_helmet_security_headers: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("check_missing_helmet_security_headers: extensions must be an array of strings.", -32602);

  const extensions = Array.isArray(opts.extensions) && opts.extensions.length ? opts.extensions : DEFAULT_EXTENSIONS;
  const maxResults = Math.min(Math.max(1, Math.trunc(opts.maxResults ?? DEFAULT_MAX_RESULTS)), HARD_MAX_RESULTS);

  const files = stat.isDirectory() ? collectFiles(absDir, extensions) : [path.basename(absDir)];
  const baseDir = stat.isDirectory() ? absDir : path.dirname(absDir);

  const findings = [];
  let hasRouteRegistrations = false;
  let hasSecurityHeaderHint = false;

  for (const rel of files) {
    let buf;
    try { buf = fs.readFileSync(path.join(baseDir, rel)); }
    catch (_) { continue; }
    if (looksBinary(buf)) continue;
    const source = buf.toString("utf8");

    if (ROUTE_REGISTRATION_RE.test(source)) hasRouteRegistrations = true;
    if (HEADER_HINT_RE.test(source)) hasSecurityHeaderHint = true;

    findings.push(...scanFileForDisabledModules(rel, source));
  }

  if (hasRouteRegistrations && !hasSecurityHeaderHint) {
    findings.push({
      file: null,
      line: null,
      rule: "missing_security_headers",
      severity: "warning",
      message: "Route registrations were found (app./router.get|post|put|delete|patch|all) but no generic security-hardening header hint (helmet middleware, or a literal X-Content-Type-Options/X-Frame-Options/Strict-Transport-Security/etc. header) exists anywhere in the scanned files — responses have none of these clickjacking/MIME-sniffing/downgrade-attack mitigations by default.",
    });
  }

  findings.sort((a, b) => {
    if (a.file === null) return 1;
    if (b.file === null) return -1;
    return a.file.localeCompare(b.file) || a.line - b.line;
  });
  const truncated = findings.length > maxResults;
  const errorCount = findings.filter(f => f.severity === "error").length;
  const warningCount = findings.filter(f => f.severity === "warning").length;

  return {
    path: origPath,
    filesScanned: files.length,
    hasRouteRegistrations,
    hasSecurityHeaderHint,
    findingsCount: findings.length,
    errorCount, warningCount,
    truncated,
    findings: findings.slice(0, maxResults),
  };
}

module.exports = { checkMissingHelmetSecurityHeaders };
