"use strict";
/**
 * find_timing_attack_risk
 *
 * Scans JS/TS files for timing-attack vulnerabilities where security-sensitive
 * values (passwords, tokens, secrets, hashes, keys, signatures) are compared
 * using JavaScript's `===` or `==` operators instead of the constant-time
 * `crypto.timingSafeEqual()`. Variable-time comparison leaks secret length and
 * content through timing side channels.
 *
 * Two rules:
 *
 *   1. unsafe_secret_comparison (error)
 *      An `if` condition or ternary that uses `===`/`!==`/`==`/`!=` to compare
 *      a value whose name matches a security-sensitive pattern:
 *      password/passwd/pwd, token/accessToken/refreshToken, secret, hash,
 *      hmac, digest, signature/sig, apiKey/api_key, sessionId,
 *      authCode/authToken, otp, nonce.
 *      RHS must be a variable, property access, function call, or template
 *      literal — not two hardcoded literals comparing to each other.
 *
 *   2. string_equality_on_hash (warning)
 *      A Buffer.from() or hex-encoded string compared with === in a context
 *      that doesn't involve a literal on both sides (suggests a computed
 *      hash/MAC being compared).
 *
 * Suppressions: same-line `// safe`, `// timing-safe`, or presence of
 * `timingSafeEqual` anywhere in the same block (-5/+5 lines).
 *
 * Returns { path, filesScanned, findingsCount, errorCount, warningCount,
 *           truncated, findings: [{file,line,rule,severity,message}] }.
 * Always available — does not require MCP_ALLOW_EXEC.
 */
const fs   = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS    = 5000;

// Security-sensitive identifier patterns (case-insensitive)
const SENSITIVE_VAR_RE = /\b(?:password|passwd|pwd|secret|token|access_?token|refresh_?token|hash|hmac|digest|signature|sig|api_?key|session_?id|auth_?(?:code|token)|otp|nonce)\b/i;

// Equality operators: ===, !==, ==, !=
const EQ_OP_RE = /===|!==|==(?!=)|!=(?!=)/;

// Lines that contain timingSafeEqual — used for suppression window
const TIMING_SAFE_RE = /timingSafeEqual|crypto\.timingSafeEqual|scryptSync|bcrypt\.compare|argon2\.verify|pbkdf2/i;

// Safe annotation suppression
const SAFE_ANNOT_RE = /\/\/\s*(?:safe|timing-safe)/i;

// Buffer.from or hex string patterns (for rule 2)
const BUFFER_FROM_RE = /Buffer\.from\s*\(/;
const HEX_STR_RE = /['"`][0-9a-fA-F]{16,}['"`]/;

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

// Match `if (X === Y)`, `X === Y`, `X !== Y` where X or Y is sensitive
// Returns list of { lineNo, rule, severity, message }
function scanFile(relPath, src) {
  const findings = [];
  const lines    = src.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line    = lines[i];
    const lineNo  = i + 1;

    if (SAFE_ANNOT_RE.test(line)) continue;

    // Check ±5-line window for timingSafeEqual
    const windowStart = Math.max(0, i - 5);
    const windowEnd   = Math.min(lines.length, i + 6);
    const window5     = lines.slice(windowStart, windowEnd).join(" ");
    if (TIMING_SAFE_RE.test(window5)) continue;

    // Rule 1: sensitive variable name in equality check
    if (SENSITIVE_VAR_RE.test(line) && EQ_OP_RE.test(line)) {
      // Skip if both sides appear to be string literals (e.g. comparing two hardcoded constants)
      const stripped = line.replace(/\/\/.*$/, "").trim();
      // Simple heuristic: if we have `"str" === "str"` skip it
      const bothLiterals = /['"`][^'"\`]*['"`]\s*(?:===|!==|==|!=)\s*['"`][^'"\`]*['"`]/.test(stripped);
      if (!bothLiterals) {
        findings.push({
          file:     relPath,
          line:     lineNo,
          rule:     "unsafe_secret_comparison",
          severity: "error",
          message:
            `Security-sensitive value compared with === instead of crypto.timingSafeEqual(). ` +
            `Variable-time string comparison leaks the secret's value through timing side channels ` +
            `(an attacker can determine content character-by-character by measuring response time). ` +
            `Use crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)) for all password, token, ` +
            `hash, and HMAC comparisons.`,
        });
      }
    }

    // Rule 2: Buffer.from or hex string in equality check (computed hash comparison)
    if ((BUFFER_FROM_RE.test(line) || HEX_STR_RE.test(line)) && EQ_OP_RE.test(line)) {
      // Skip if already flagged by rule 1 (same line)
      const alreadyFlagged = findings.some(f => f.line === lineNo);
      if (!alreadyFlagged) {
        findings.push({
          file:     relPath,
          line:     lineNo,
          rule:     "string_equality_on_hash",
          severity: "warning",
          message:
            `Computed hash or buffer compared with ===. String/Buffer equality is not constant-time — ` +
            `the comparison short-circuits as soon as bytes differ, leaking timing information. ` +
            `Use crypto.timingSafeEqual(a, b) where both a and b are equal-length Buffer instances.`,
        });
      }
    }
  }

  return findings;
}

function findTimingAttackRisk(absPath, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absPath); }
  catch (e) {
    throw new ToolError(
      `find_timing_attack_risk: cannot access '${origPath}': ${e.message}`,
      -32602
    );
  }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_timing_attack_risk: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_timing_attack_risk: extensions must be an array.", -32602);

  const extensions = Array.isArray(opts.extensions) && opts.extensions.length
    ? opts.extensions : DEFAULT_EXTENSIONS;
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
    findings.push(...scanFile(rel, buf.toString("utf8")));
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

module.exports = { findTimingAttackRisk };
