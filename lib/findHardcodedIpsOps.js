"use strict";
// ── FIND_HARDCODED_IPS — scan source files for hardcoded IP literals ───────
// Lightweight config/secrets-hygiene companion to scan_secrets: hardcoded
// IPs in source (rather than env vars/config) are a common source of
// "works on my machine"/environment-leak bugs and occasionally an actual
// info-disclosure (internal infra addresses baked into client-shipped code).
// Same MCP_IGNORE-aware recursive walk + binary-skip heuristic as
// scan_todos/scan_secrets/scan_conflict_markers.
//
// Deliberately a pattern-shape scanner, not a semantic one: it cannot tell
// a real network address from a version number or a UUID segment that
// happens to look IP-shaped, and it does not resolve/classify addresses via
// DNS or a live network call (this tool never touches the network). Findings
// are a review lead, not a guaranteed issue.
const fs   = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

// IPv4: strict 0-255-per-octet match, not just \d{1,3}(\.\d{1,3}){3} (which
// would also match e.g. "999.999.999.999" as a false positive).
const OCTET = "(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])";
const IPV4_RE = new RegExp(`\\b${OCTET}\\.${OCTET}\\.${OCTET}\\.${OCTET}\\b`, "g");

// IPv6: full and `::`-compressed forms. Deliberately permissive (matches
// some invalid-but-shaped strings) since this is a lead-generation scan, not
// a validator — an over-broad match just gets filtered by context, an
// under-broad one silently hides a real hardcoded address.
const IPV6_RE = /\b(?:[0-9A-Fa-f]{1,4}:){2,7}[0-9A-Fa-f]{1,4}\b|\b(?:[0-9A-Fa-f]{1,4}:)+:(?:[0-9A-Fa-f]{1,4}:)*[0-9A-Fa-f]{1,4}\b|::1\b/g;

// Addresses that are almost never a meaningful finding on their own —
// loopback/any/broadcast/documentation ranges and version-string lookalikes.
const IPV4_ALWAYS_SAFE = new Set(["0.0.0.0", "127.0.0.1", "255.255.255.255"]);
function isPrivateOrReservedV4(ip) {
  const [a, b] = ip.split(".").map(Number);
  if (a === 10) return true;                              // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true;        // 172.16.0.0/12
  if (a === 192 && b === 168) return true;                 // 192.168.0.0/16
  if (a === 169 && b === 254) return true;                 // link-local
  if (a === 127) return true;                               // loopback range
  return false;
}
const IPV6_ALWAYS_SAFE = new Set(["::1", "::"]);

function classifyV4(ip) {
  if (IPV4_ALWAYS_SAFE.has(ip)) return "loopback-or-broadcast";
  if (isPrivateOrReservedV4(ip)) return "private";
  return "public";
}
function classifyV6(ip) {
  const lower = ip.toLowerCase();
  if (IPV6_ALWAYS_SAFE.has(lower)) return "loopback";
  if (/^fe80:/.test(lower)) return "link-local";
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return "private"; // fc00::/7 unique local
  return "public";
}

function looksBinary(buf) {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}

// A bare run of 1-4 hex groups without any colon context (e.g. a git short
// hash, a color-adjacent token) can spuriously match the loose IPv6 regex.
// Require at least one ':' in the match (always true for our regex) plus a
// sanity check: reject if it has no digit at all AND fewer than 2 groups
// (extremely permissive already; this mainly guards degenerate single-token
// matches like "a:b").
function looksLikeRealV6(m) {
  if (m === "::1" || m === "::") return true; // compressed-to-nothing loopback/unspecified — always real
  return m.split(":").filter(Boolean).length >= 2;
}

function scanFileInto(absPath, relPath, maxMatches, includePrivate, results) {
  let buf;
  try { buf = fs.readFileSync(absPath); } catch (_) { return; }
  if (looksBinary(buf)) return;
  const lines = buf.toString("utf8").split(/\r\n|\n/);
  for (let i = 0; i < lines.length; i++) {
    if (results.length >= maxMatches) return;
    const line = lines[i];

    let m;
    IPV4_RE.lastIndex = 0;
    while ((m = IPV4_RE.exec(line))) {
      const ip = m[0];
      const classification = classifyV4(ip);
      if (classification === "loopback-or-broadcast" && !includePrivate) continue;
      if (classification === "private" && !includePrivate) continue;
      results.push({ file: relPath, line: i + 1, ip, version: 4, classification });
      if (results.length >= maxMatches) return;
    }

    IPV6_RE.lastIndex = 0;
    while ((m = IPV6_RE.exec(line))) {
      const ip = m[0];
      if (!looksLikeRealV6(ip)) continue;
      const classification = classifyV6(ip);
      if ((classification === "loopback" || classification === "link-local" || classification === "private") && !includePrivate) continue;
      results.push({ file: relPath, line: i + 1, ip, version: 6, classification });
      if (results.length >= maxMatches) return;
    }
  }
}

/**
 * Scan a file or directory tree for hardcoded IPv4/IPv6 literals.
 * @param {string} absPath
 * @param {string} origPath
 * @param {{ extensions?: string[], maxMatches?: number, includePrivate?: boolean }} opts
 *   includePrivate (default false): also report loopback/private/link-local
 *   addresses, which are usually noise (dev defaults, docker-compose IPs).
 * @returns {{ path, filesScanned, totalMatches, truncated, byClassification, filesAffected, matches }}
 */
function findHardcodedIps(absPath, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absPath); }
  catch (e) { throw new ToolError(`find_hardcoded_ips: cannot access '${origPath}': ${e.message}`, -32602); }

  const maxMatches = Math.min(Math.max(1, Math.trunc(opts.maxMatches ?? 500)), 5000);
  const includePrivate = !!opts.includePrivate;
  const exts = opts.extensions?.length
    ? opts.extensions.map(e => e.startsWith(".") ? e.toLowerCase() : "." + e.toLowerCase())
    : null;

  const results = [];
  let filesScanned = 0;

  if (stat.isFile()) {
    filesScanned = 1;
    scanFileInto(absPath, origPath, maxMatches, includePrivate, results);
  } else if (stat.isDirectory()) {
    (function walk(dir, relDir) {
      if (results.length >= maxMatches) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch (_) { return; }
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
          scanFileInto(full, origPath ? origPath + "/" + relPath : relPath, maxMatches, includePrivate, results);
        }
      }
    })(absPath, "");
  } else {
    throw new ToolError(`find_hardcoded_ips: '${origPath}' is neither a regular file nor a directory.`, -32602);
  }

  const byClassification = {};
  for (const r of results) byClassification[r.classification] = (byClassification[r.classification] || 0) + 1;
  const filesAffected = new Set(results.map(r => r.file)).size;

  return {
    path: origPath,
    filesScanned,
    totalMatches: results.length,
    truncated: results.length >= maxMatches,
    byClassification,
    filesAffected,
    matches: results,
  };
}

module.exports = { findHardcodedIps };
