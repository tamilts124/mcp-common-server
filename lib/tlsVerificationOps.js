"use strict";
// ── FIND_DISABLED_TLS_VERIFICATION — MITM-exposure hygiene scan ────────────
// Scans JS/TS for code that disables TLS/SSL certificate verification,
// which defeats the entire purpose of HTTPS and exposes the process to
// man-in-the-middle attacks (a compromised network, proxy, or DNS hijack can
// silently intercept/modify "encrypted" traffic).
//
// Three rules:
//   - reject_unauthorized_false (error) — a literal `rejectUnauthorized:
//     false` option, whether passed to https.request/https.Agent/tls.connect/
//     axios's httpsAgent config, or any other options object using that key.
//   - node_tls_reject_unauthorized_env (error) — the well-known Node.js
//     environment-variable kill-switch set to '0' either via a real
//     `process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'` assignment or an
//     inline `NODE_TLS_REJECT_UNAUTHORIZED=0` shell-style prefix appearing in
//     a JS string/script line — disables verification process-wide for
//     every TLS connection, not just one client.
//   - insecure_https_agent (error) — `new https.Agent({ ... })` /
//     `new tls.SecureContext`-adjacent constructor call whose argument
//     object contains `rejectUnauthorized: false` within the same call
//     (paren-depth extraction), reported once per constructor call even if
//     rejectUnauthorized_false also matched the same line (deduped by line).
//
// A same-line or short-lookback NODE_ENV/isDev/isTest guard suppresses the
// finding — a deliberate dev/test-only bypass (e.g. against a local
// self-signed cert) is a common, accepted pattern; this tool flags
// unconditional or production-reachable disabling.
//
// Pure text-scan (regex + paren-depth call-arg extraction, reusing the
// convention from find_prototype_pollution_risk's matchParen helper), not
// an AST/data-flow parser: only the literal option-key/env-var shapes above
// are matched; a value built indirectly (e.g. a variable holding `false`
// passed as `rejectUnauthorized: allowInsecure`) is not tracked unless the
// variable name itself is literally `false`.
const fs = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;
const DEV_GUARD_RE = /NODE_ENV\s*(?:!==|===)\s*['"](?:production|development|test)['"]|isProduction|isDev(?:elopment)?\b|isTest\b/;
const LOOKBACK_LINES = 5;

const REJECT_UNAUTH_RE = /\brejectUnauthorized\s*:\s*false\b/;
const ENV_ASSIGN_RE = /\bprocess\s*\.\s*env\s*\.\s*NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0['"]?/;
const ENV_INLINE_RE = /\bNODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0['"]?/;
const AGENT_CTOR_RE = /\bnew\s+(?:https|tls)\s*\.\s*(?:Agent|SecureContext)\s*\(/g;

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

// Finds the index just past the matching close paren for an open paren at openIdx.
function matchParen(source, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")") { depth--; if (depth === 0) return i; }
  }
  return -1;
}

function lineOf(source, idx) {
  return source.slice(0, idx).split("\n").length;
}

function hasDevGuardNearby(lines, lineIdx) {
  const start = Math.max(0, lineIdx - LOOKBACK_LINES);
  for (let i = lineIdx; i >= start; i--) {
    if (DEV_GUARD_RE.test(lines[i])) return true;
  }
  return false;
}

/**
 * @param {string} absDir   Absolute, jail-validated file or directory to scan.
 * @param {string} origPath Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {string[]} [opts.extensions]
 * @param {number}   [opts.maxResults]
 * @returns {{path, filesScanned, findingsCount, errorCount, truncated, findings}}
 */
function findDisabledTlsVerification(absDir, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absDir); }
  catch (e) { throw new ToolError(`find_disabled_tls_verification: cannot access '${origPath}': ${e.message}`, -32602); }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_disabled_tls_verification: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_disabled_tls_verification: extensions must be an array of strings.", -32602);

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
    const lines = source.split(/\r\n|\r|\n/);
    const seenLines = new Set();

    // Rule: insecure_https_agent (checked first so its line is claimed
    // and not double-reported by the plain rejectUnauthorized_false pass).
    AGENT_CTOR_RE.lastIndex = 0;
    let m;
    while ((m = AGENT_CTOR_RE.exec(source)) !== null) {
      const openIdx = source.indexOf("(", m.index);
      const closeIdx = matchParen(source, openIdx);
      if (closeIdx === -1) continue;
      const argText = source.slice(openIdx, closeIdx + 1);
      if (REJECT_UNAUTH_RE.test(argText)) {
        const ln = lineOf(source, m.index);
        if (!hasDevGuardNearby(lines, ln - 1)) {
          findings.push({
            file: rel, line: ln, rule: "insecure_https_agent", severity: "error",
            message: "An https/tls Agent is constructed with rejectUnauthorized: false — TLS certificate verification is disabled for every request made through this agent, exposing it to man-in-the-middle attacks.",
          });
        }
        seenLines.add(ln);
      }
    }

    for (let i = 0; i < lines.length; i++) {
      if (seenLines.has(i + 1)) continue;
      const line = lines[i];
      let rule = null, message = null;

      if (REJECT_UNAUTH_RE.test(line)) {
        rule = "reject_unauthorized_false";
        message = "rejectUnauthorized: false disables TLS certificate verification, exposing the connection to man-in-the-middle attacks.";
      } else if (ENV_ASSIGN_RE.test(line) || ENV_INLINE_RE.test(line)) {
        rule = "node_tls_reject_unauthorized_env";
        message = "NODE_TLS_REJECT_UNAUTHORIZED=0 disables TLS certificate verification process-wide for every outgoing HTTPS/TLS connection in this Node.js process.";
      } else {
        continue;
      }

      if (hasDevGuardNearby(lines, i)) continue;
      findings.push({ file: rel, line: i + 1, rule, severity: "error", message });
    }
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const truncated = findings.length > maxResults;
  const errorCount = findings.filter(f => f.severity === "error").length;

  return {
    path: origPath,
    filesScanned: files.length,
    findingsCount: findings.length,
    errorCount,
    truncated,
    findings: findings.slice(0, maxResults),
  };
}

module.exports = { findDisabledTlsVerification };
