"use strict";
// ── CHECK_SEMVER_RANGE_STRICTNESS — dependency range looseness audit ────────
// Classifies each package.json dependency's declared version range by risk
// tier: exact pin (strictest, no issue), tilde (~1.2.3, patch-level drift),
// caret (^1.2.3, minor+patch drift — npm's default, most common), complex
// comparator ranges (>=, <=, >, <, ||, hyphen ranges — hardest to reason
// about), and unbounded (*, "", "latest", "x" — no real guarantee at all).
// git+/github:/file:/link:/workspace:/npm: specifiers are skipped (not
// semver-range syntax). Zero-dependency, read-only.
const fs = require("fs");
const { ToolError } = require("./errors");

const DEFAULT_BLOCKS = ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

const SKIP_RE = /^(git\+|git:|github:|file:|link:|workspace:|npm:|https?:\/\/)/i;
const EXACT_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const TILDE_RE = /^~\s*\d/;
const CARET_RE = /^\^\s*\d/;
const UNBOUNDED_RE = /^(\*|x|X|latest|)$/;

function classifyRange(range) {
  const r = (range || "").trim();
  if (SKIP_RE.test(r)) return null; // not a semver range, out of scope
  if (UNBOUNDED_RE.test(r)) {
    return { tier: "unbounded", severity: "error", message: `'${range}' places no real constraint on the resolved version.` };
  }
  if (EXACT_RE.test(r)) return null; // exact pin, strictest, no issue
  if (TILDE_RE.test(r)) {
    return { tier: "tilde", severity: "info", message: `'${range}' allows patch-level drift.` };
  }
  if (CARET_RE.test(r)) {
    return { tier: "caret", severity: "info", message: `'${range}' allows minor+patch drift (npm's default range style).` };
  }
  // anything else with comparator/range syntax
  if (/[<>|\-\s]/.test(r) || r.includes("||")) {
    return { tier: "complex_range", severity: "warning", message: `'${range}' is a complex comparator/hyphen/OR range — harder to reason about than a single caret/tilde.` };
  }
  return { tier: "unrecognized", severity: "info", message: `'${range}' doesn't match a recognized semver range shape.` };
}

/**
 * @param {string} absPath  Absolute, jail-validated path to package.json.
 * @param {string} origPath Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {string[]} [opts.blocks]
 * @param {number}   [opts.maxResults]
 * @returns {{path, depsScanned, exactCount, issueCount, errorCount, warningCount, infoCount, truncated, issues, tierCounts}}
 */
function checkSemverRangeStrictness(absPath, origPath, opts = {}) {
  let raw;
  try { raw = fs.readFileSync(absPath, "utf8"); }
  catch (e) { throw new ToolError(`check_semver_range_strictness: cannot access '${origPath}': ${e.message}`, -32602); }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("check_semver_range_strictness: max_results must be a number.", -32602);
  if (opts.blocks !== undefined && !Array.isArray(opts.blocks))
    throw new ToolError("check_semver_range_strictness: blocks must be an array of strings.", -32602);
  const maxResults = Math.min(Math.max(1, Math.trunc(opts.maxResults ?? DEFAULT_MAX_RESULTS)), HARD_MAX_RESULTS);
  const blocks = Array.isArray(opts.blocks) && opts.blocks.length ? opts.blocks : DEFAULT_BLOCKS;

  let pkg;
  try { pkg = JSON.parse(raw); }
  catch (e) { throw new ToolError(`check_semver_range_strictness: malformed JSON in '${origPath}': ${e.message}`, -32602); }

  const issues = [];
  const tierCounts = {};
  let depsScanned = 0;
  let exactCount = 0;

  for (const block of blocks) {
    const deps = pkg && typeof pkg[block] === "object" && pkg[block];
    if (!deps) continue;
    for (const [name, range] of Object.entries(deps)) {
      depsScanned++;
      const result = classifyRange(typeof range === "string" ? range : "");
      if (!result) { exactCount++; continue; }
      tierCounts[result.tier] = (tierCounts[result.tier] || 0) + 1;
      issues.push({ block, name, range, ...result });
    }
  }

  issues.sort((a, b) => a.block.localeCompare(b.block) || a.name.localeCompare(b.name));
  const truncated = issues.length > maxResults;
  const finalIssues = issues.slice(0, maxResults);

  return {
    path: origPath,
    depsScanned,
    exactCount,
    issueCount: issues.length,
    errorCount: finalIssues.filter(i => i.severity === "error").length,
    warningCount: finalIssues.filter(i => i.severity === "warning").length,
    infoCount: finalIssues.filter(i => i.severity === "info").length,
    truncated,
    issues: finalIssues,
    tierCounts,
  };
}

module.exports = { checkSemverRangeStrictness };
