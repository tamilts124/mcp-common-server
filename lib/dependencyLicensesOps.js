"use strict";
// ── SCAN_DEPENDENCY_LICENSES — node_modules license compliance audit ─────
// Walks node_modules top-level entries (+ one level into @scope/ namespaces —
// not recursively into nested node_modules; same "top-level survey,
// documented tradeoff" convention as find_duplicate_dependencies) reading
// each installed package's package.json `license` field (falling back to
// the legacy `licenses: [{type}]` array shape some older packages still
// ship), and classifies it: permissive / weak-copyleft / copyleft / custom /
// unknown. SPDX "OR" expressions (e.g. "MIT OR GPL-3.0") resolve to the
// *least* restrictive branch (a real choice is available); "AND"/"WITH" or
// bare single-license strings resolve to the *most* restrictive token found.
// Flags copyleft + unknown by default (configurable via flag_categories),
// plus any license string matching a caller-supplied `disallowed` substring
// list regardless of category. Pure fs + JSON.parse, no npm CLI, no network.

const fs = require("fs");
const path = require("path");
const { ToolError } = require("./errors");

const PERMISSIVE = new Set([
  "MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause", "BSD-3-Clause-Clear", "0BSD",
  "Apache-2.0", "CC0-1.0", "Unlicense", "WTFPL", "Python-2.0", "Zlib", "BSL-1.0",
]);
const RANK_NAMES = ["permissive", "weak-copyleft", "copyleft", "custom"];
const VALID_CATEGORIES = new Set(["permissive", "weak-copyleft", "copyleft", "custom", "unknown"]);

function rankToken(t) {
  const u = t.toUpperCase();
  if (/^AGPL/.test(u)) return 2;
  if (/^LGPL/.test(u)) return 1;
  if (/^GPL/.test(u)) return 2;
  if (/^MPL/.test(u)) return 1;
  if (PERMISSIVE.has(t)) return 0;
  return 3;
}

/** Classify a raw license string (or SPDX expression) into a category. */
function classifyLicense(raw) {
  if (raw === undefined || raw === null) return "unknown";
  const s = String(raw).trim();
  if (!s) return "unknown";
  const hasOr = /\bOR\b/i.test(s);
  const tokens = s.replace(/[()]/g, " ").split(/\s+(?:OR|AND|WITH)\s+/i).map(t => t.trim()).filter(Boolean);
  if (tokens.length === 0) return "unknown";
  const ranks = tokens.map(rankToken);
  const pick = hasOr ? Math.min(...ranks) : Math.max(...ranks);
  return RANK_NAMES[pick];
}

function listPackageDirs(nodeModulesAbs) {
  let entries;
  try { entries = fs.readdirSync(nodeModulesAbs, { withFileTypes: true }); }
  catch (e) { return []; }
  const pkgs = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name === ".bin" || ent.name.startsWith(".")) continue;
    if (ent.name.startsWith("@")) {
      const scopeAbs = path.join(nodeModulesAbs, ent.name);
      let subs;
      try { subs = fs.readdirSync(scopeAbs, { withFileTypes: true }); }
      catch (e) { continue; }
      for (const sub of subs) {
        if (sub.isDirectory()) pkgs.push({ name: `${ent.name}/${sub.name}`, abs: path.join(scopeAbs, sub.name) });
      }
      continue;
    }
    pkgs.push({ name: ent.name, abs: path.join(nodeModulesAbs, ent.name) });
  }
  return pkgs;
}

/**
 * @param {string} nodeModulesAbs  Absolute, jail-validated path to a node_modules directory.
 * @param {string} origPath        Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {string[]} [opts.disallowed]      License substrings to always flag (case-insensitive).
 * @param {string[]} [opts.flag_categories] Categories to flag (default ["copyleft","unknown"]).
 * @param {number} [opts.max_results]       Cap on returned issues (default 500, hard cap 5000).
 * @returns {{path, foundNodeModules, packagesScanned, malformed, counts, issueCount, truncated, issues}}
 */
function scanDependencyLicenses(nodeModulesAbs, origPath, opts = {}) {
  if (opts.max_results !== undefined && typeof opts.max_results !== "number")
    throw new ToolError("scan_dependency_licenses: max_results must be a number.", -32602);
  if (opts.disallowed !== undefined && !Array.isArray(opts.disallowed))
    throw new ToolError("scan_dependency_licenses: disallowed must be an array of strings.", -32602);
  if (opts.flag_categories !== undefined && !Array.isArray(opts.flag_categories))
    throw new ToolError("scan_dependency_licenses: flag_categories must be an array of strings.", -32602);

  const flagCategories = new Set(
    Array.isArray(opts.flag_categories) && opts.flag_categories.length
      ? opts.flag_categories
      : ["copyleft", "unknown"]
  );
  for (const c of flagCategories)
    if (!VALID_CATEGORIES.has(c))
      throw new ToolError(`scan_dependency_licenses: invalid flag_categories entry '${c}' (valid: ${[...VALID_CATEGORIES].join(", ")}).`, -32602);

  const maxResults = Math.min(Math.max(opts.max_results || 500, 1), 5000);
  const disallowed = (opts.disallowed || []).map(s => String(s).toLowerCase());

  let nmStat;
  try { nmStat = fs.statSync(nodeModulesAbs); }
  catch (e) {
    return { path: origPath, foundNodeModules: false, note: "No node_modules directory found — run npm install." };
  }
  if (!nmStat.isDirectory())
    throw new ToolError(`scan_dependency_licenses: '${origPath}' exists but is not a directory.`, -32602);

  const pkgDirs = listPackageDirs(nodeModulesAbs);
  const counts = { permissive: 0, "weak-copyleft": 0, copyleft: 0, custom: 0, unknown: 0 };
  const issues = [];
  const malformed = [];
  let scanned = 0;

  for (const { name, abs } of pkgDirs) {
    let raw, pkg;
    try { raw = fs.readFileSync(path.join(abs, "package.json"), "utf8"); }
    catch (e) { continue; } // no package.json (stray dir) — skipped, not malformed
    try { pkg = JSON.parse(raw); }
    catch (e) { malformed.push(name); continue; }
    if (pkg === null || typeof pkg !== "object" || Array.isArray(pkg)) { malformed.push(name); continue; }
    scanned++;

    let licenseField = pkg.license;
    if (licenseField === undefined && Array.isArray(pkg.licenses)) {
      licenseField = pkg.licenses.map(l => l && l.type).filter(Boolean).join(" OR ");
    }
    const licenseStr = licenseField === undefined || licenseField === null
      ? null
      : (typeof licenseField === "object" ? (licenseField.type || null) : String(licenseField));

    const category = classifyLicense(licenseStr);
    counts[category]++;

    const isDisallowed = !!licenseStr && disallowed.some(d => licenseStr.toLowerCase().includes(d));
    if (isDisallowed || flagCategories.has(category)) {
      issues.push({
        name,
        version: typeof pkg.version === "string" ? pkg.version : null,
        license: licenseStr,
        category,
        reason: isDisallowed ? "disallowed" : "flagged-category",
      });
    }
  }

  issues.sort((a, b) => a.name.localeCompare(b.name));
  const truncated = issues.length > maxResults;
  const limitedIssues = truncated ? issues.slice(0, maxResults) : issues;

  return {
    path: origPath,
    foundNodeModules: true,
    packagesScanned: scanned,
    malformed,
    counts,
    issueCount: issues.length,
    truncated,
    issues: limitedIssues,
  };
}

module.exports = { scanDependencyLicenses, classifyLicense };
