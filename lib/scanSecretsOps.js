"use strict";
// ── SCAN_SECRETS — find likely hardcoded credentials in files ──────────────
// Recursively walks a file or directory (same MCP_IGNORE-aware walk pattern
// as scan_todos/scan_conflict_markers) looking for common secret shapes:
// AWS access keys, GitHub/Slack tokens, PEM private-key headers, JWTs, and
// generic api_key/secret/password/token assignments. Matched values are
// REDACTED in the output (first 4 + last 4 chars kept, middle masked) so the
// tool itself never leaks the secret it finds. Read-only, zero-dependency.
// Binary files skipped (NUL-byte heuristic, same as scan_todos/git_show).
//
// This is a pattern-shape scanner, not a secrets-database lookup — false
// positives/negatives are expected. It's a quick pre-commit-style sweep, not
// a substitute for a dedicated secrets scanner.

const fs   = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const PATTERNS = [
  { type: "aws_access_key_id",     re: /AKIA[0-9A-Z]{16}/ },
  { type: "aws_secret_access_key", re: /(?:aws_secret_access_key|secret_access_key)\s*[:=]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/i },
  { type: "github_token",          re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { type: "slack_token",           re: /xox[baprs]-[A-Za-z0-9-]{10,}/i },
  { type: "private_key_block",     re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |)PRIVATE KEY-----/ },
  { type: "jwt",                   re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { type: "generic_secret",        re: /(?:api[_-]?key|secret|token|password|passwd|client_secret|access_token)\s*[:=]\s*['"][^'"\s]{8,100}['"]/i },
];

function looksBinary(buf) {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}

// Redact a matched string: keep first 4 + last 4 chars, mask the middle.
function redact(s) {
  if (s.length <= 10) return s.slice(0, 2) + "***";
  return s.slice(0, 4) + "***" + s.slice(-4);
}

function scanFileInto(absPath, relPath, maxMatches, results) {
  let buf;
  try { buf = fs.readFileSync(absPath); } catch (e) { return; }
  if (looksBinary(buf)) return;
  const lines = buf.toString("utf8").split(/\r\n|\n/);
  for (let i = 0; i < lines.length; i++) {
    if (results.length >= maxMatches) return;
    const line = lines[i];
    for (const { type, re } of PATTERNS) {
      const m = re.exec(line);
      if (m) {
        results.push({ file: relPath, line: i + 1, type, match: redact(m[0]) });
        break; // one finding per line — avoid double-reporting overlapping patterns
      }
    }
  }
}

/**
 * Scan a file or directory tree for likely hardcoded credentials.
 * @returns {{ path, filesScanned, totalMatches, truncated, byType, filesAffected, matches }}
 */
function scanSecrets(absPath, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absPath); }
  catch (e) { throw new ToolError(`scan_secrets: cannot access '${origPath}': ${e.message}`, -32602); }

  const maxMatches = Math.min(Math.max(1, Math.trunc(opts.maxMatches ?? 500)), 5000);
  const exts = opts.extensions?.length
    ? opts.extensions.map(e => e.startsWith(".") ? e.toLowerCase() : "." + e.toLowerCase())
    : null;

  const results = [];
  let filesScanned = 0;

  if (stat.isFile()) {
    filesScanned = 1;
    scanFileInto(absPath, origPath, maxMatches, results);
  } else if (stat.isDirectory()) {
    (function walk(dir, relDir) {
      if (results.length >= maxMatches) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch (e) { return; }
      for (const ent of entries) {
        if (results.length >= maxMatches) return;
        if (isIgnored(ent.name)) continue;
        const relPath = relDir ? relDir + "/" + ent.name : ent.name;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          walk(full, relPath);
        } else if (ent.isFile()) {
          if (exts && !exts.includes(path.extname(ent.name).toLowerCase())) continue;
          filesScanned++;
          scanFileInto(full, origPath ? origPath + "/" + relPath : relPath, maxMatches, results);
        }
      }
    })(absPath, "");
  } else {
    throw new ToolError(`scan_secrets: '${origPath}' is neither a regular file nor a directory.`, -32602);
  }

  const byType = {};
  for (const r of results) byType[r.type] = (byType[r.type] || 0) + 1;
  const filesAffected = new Set(results.map(r => r.file)).size;

  return {
    path: origPath,
    filesScanned,
    totalMatches: results.length,
    truncated: results.length >= maxMatches,
    byType,
    filesAffected,
    matches: results,
  };
}

module.exports = { scanSecrets };
