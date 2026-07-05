"use strict";
// ── CHECK_MISSING_ENGINES_FIELD — package.json Node/npm version-pin audit ──
// A missing/loose `engines` constraint lets CI, deploy targets, and local
// dev machines silently drift onto incompatible Node/npm versions. Pure
// structural check on the parsed package.json object — no network calls,
// no semver-range evaluation beyond a "looks risky" literal check.
//
// Findings (field-level, no line numbers — package.json is parsed as JSON,
// not text-scanned):
//   missing_engines_field   (warning) — no `engines` key at all.
//   invalid_engines_field   (error)   — `engines` present but not an object.
//   missing_engines_node    (warning) — `engines` present, no `node` entry.
//   risky_engines_node_range(warning) — `engines.node` is '*', '', or 'latest'
//                                       (accepts anything — same as absent).
//   missing_engines_npm     (info)    — `engines` present, no `npm` entry
//                                       (node-only pin is the common case,
//                                       so this is informational, not a warning).
const fs = require("fs");
const { ToolError } = require("./errors");

const RISKY_RANGES = new Set(["*", "", "latest", "x"]);

/**
 * @param {string} filePath  Absolute path to package.json.
 * @param {string} origPath  Client-relative path echoed in the result.
 * @returns {{path, hasEngines, hasEnginesNode, findingsCount, errorCount, warningCount, infoCount, findings: Array}}
 */
function checkMissingEnginesField(filePath, origPath) {
  let raw;
  try { raw = fs.readFileSync(filePath, "utf8"); }
  catch (e) { throw new ToolError(`check_missing_engines_field: cannot read '${origPath}': ${e.message}`, -32602); }

  let pkg;
  try { pkg = JSON.parse(raw); }
  catch (e) { throw new ToolError(`check_missing_engines_field: '${origPath}' is not valid JSON: ${e.message}`, -32602); }

  if (pkg === null || typeof pkg !== "object" || Array.isArray(pkg))
    throw new ToolError(`check_missing_engines_field: '${origPath}' must contain a JSON object at the top level.`, -32602);

  const findings = [];
  const engines = pkg.engines;
  let hasEngines = false;
  let hasEnginesNode = false;

  if (engines === undefined) {
    findings.push({ rule: "missing_engines_field", severity: "warning",
      message: "No 'engines' field — Node/npm version compatibility is unpinned; CI and dev machines may silently drift onto incompatible runtimes." });
  } else if (engines === null || typeof engines !== "object" || Array.isArray(engines)) {
    findings.push({ rule: "invalid_engines_field", severity: "error",
      message: "'engines' field must be an object mapping engine name to a semver range (e.g. { \"node\": \">=18\" })." });
  } else {
    hasEngines = true;
    const nodeRange = engines.node;
    if (nodeRange === undefined) {
      findings.push({ rule: "missing_engines_node", severity: "warning",
        message: "'engines' present but has no 'node' entry — Node version compatibility is unpinned." });
    } else if (typeof nodeRange !== "string" || RISKY_RANGES.has(nodeRange.trim())) {
      findings.push({ rule: "risky_engines_node_range", severity: "warning",
        message: `'engines.node' ("${nodeRange}") accepts any version — equivalent to unpinned; consider a specific range (e.g. ">=18").` });
    } else {
      hasEnginesNode = true;
    }

    if (engines.npm === undefined) {
      findings.push({ rule: "missing_engines_npm", severity: "info",
        message: "'engines' has no 'npm' entry — optional, but pinning npm alongside node avoids lockfile-format drift." });
    }
  }

  const errorCount = findings.filter(f => f.severity === "error").length;
  const warningCount = findings.filter(f => f.severity === "warning").length;
  const infoCount = findings.filter(f => f.severity === "info").length;

  return { path: origPath, hasEngines, hasEnginesNode, findingsCount: findings.length, errorCount, warningCount, infoCount, findings };
}

module.exports = { checkMissingEnginesField };
