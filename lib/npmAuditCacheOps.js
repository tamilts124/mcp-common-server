"use strict";
// ── CHECK_NPM_AUDIT_CACHE — summarise npm audit vulnerabilities by severity ──
// Reads a pre-generated `npm audit --json` report (explicit cache_path, or
// one of a few conventional default filenames inside `path`) and normalises
// it into a severity breakdown. Optionally (run_live:true) falls back to
// actually spawning `npm audit --json` in `path` — gated behind an explicit
// flag rather than being the default, since it requires network access to
// the npm registry and is slow/flaky in sandboxed or offline environments;
// reading a cached report is the primary, deterministic path.
// Supports both the npm v7+ report shape (`metadata.vulnerabilities` +
// top-level `vulnerabilities` map keyed by package name) and the legacy
// npm v6 shape (`metadata.vulnerabilities` + `advisories` map keyed by id).
const fs   = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { ToolError } = require("./errors");

const DEFAULT_CACHE_NAMES = ["npm-audit.json", ".npm-audit-cache.json", "audit-report.json"];
const SEVERITIES = ["info", "low", "moderate", "high", "critical"];
const MAX_TIMEOUT_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_RESULTS = 500;
const DEFAULT_MAX_RESULTS = 20;

function emptySeverityCounts() {
  return { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
}

// Normalise either report shape into { bySeverity, totalVulnerabilities, dependenciesAudited, advisories }
function normaliseAuditReport(doc, origLabel) {
  if (!doc || typeof doc !== "object")
    throw new ToolError(`check_npm_audit_cache: '${origLabel}' is not a JSON object.`, -32602);

  const meta = doc.metadata && typeof doc.metadata === "object" ? doc.metadata : null;
  const bySeverity = emptySeverityCounts();
  let dependenciesAudited = null;

  if (meta && meta.vulnerabilities && typeof meta.vulnerabilities === "object") {
    for (const sev of SEVERITIES) {
      const v = meta.vulnerabilities[sev];
      if (typeof v === "number") bySeverity[sev] = v;
    }
    if (typeof meta.dependencies === "number") dependenciesAudited = meta.dependencies;
    else if (meta.dependencies && typeof meta.dependencies === "object" && typeof meta.dependencies.total === "number")
      dependenciesAudited = meta.dependencies.total;
  }

  const advisories = [];
  if (doc.vulnerabilities && typeof doc.vulnerabilities === "object") {
    // npm v7+ shape: keyed by package name.
    for (const [name, info] of Object.entries(doc.vulnerabilities)) {
      if (!info || typeof info !== "object") continue;
      advisories.push({ name, severity: typeof info.severity === "string" ? info.severity : "unknown", fixAvailable: !!info.fixAvailable });
    }
  } else if (doc.advisories && typeof doc.advisories === "object") {
    // npm v6 legacy shape: keyed by advisory id.
    for (const [id, info] of Object.entries(doc.advisories)) {
      if (!info || typeof info !== "object") continue;
      advisories.push({ name: info.module_name || `advisory-${id}`, severity: typeof info.severity === "string" ? info.severity : "unknown", fixAvailable: null });
    }
  }

  const hasRecognisedShape = meta !== null || advisories.length > 0
    || (doc.vulnerabilities && typeof doc.vulnerabilities === "object");
  if (!hasRecognisedShape)
    throw new ToolError(`check_npm_audit_cache: '${origLabel}' does not look like an npm audit --json report (missing metadata/vulnerabilities/advisories).`, -32602);

  const totalVulnerabilities = SEVERITIES.reduce((sum, s) => sum + bySeverity[s], 0);
  advisories.sort((a, b) => SEVERITIES.indexOf(b.severity) - SEVERITIES.indexOf(a.severity) || a.name.localeCompare(b.name));

  return { bySeverity, totalVulnerabilities, dependenciesAudited, advisories };
}

function readJsonFile(absPath, origLabel) {
  let raw;
  try { raw = fs.readFileSync(absPath, "utf8"); }
  catch (e) { throw new ToolError(`check_npm_audit_cache: cannot read '${origLabel}': ${e.message}`, -32603); }
  try { return JSON.parse(raw); }
  catch (e) { throw new ToolError(`check_npm_audit_cache: '${origLabel}' is not valid JSON: ${e.message.split("\n")[0]}`, -32602); }
}

function findDefaultCacheFile(scanAbsDir) {
  for (const name of DEFAULT_CACHE_NAMES) {
    const p = path.join(scanAbsDir, name);
    try { if (fs.statSync(p).isFile()) return { absPath: p, name }; }
    catch (_) { /* not present, try next */ }
  }
  return null;
}

function runLiveNpmAudit(scanAbsDir, origPath, timeoutMs) {
  const result = spawnSync("npm", ["audit", "--json"], {
    cwd: scanAbsDir, timeout: timeoutMs, encoding: "utf8", windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
  });
  if (result.error) {
    if (result.error.code === "ENOENT")
      throw new ToolError("check_npm_audit_cache: npm executable not found on PATH.", -32603);
    if (result.error.code === "ETIMEDOUT" || result.signal === "SIGTERM")
      throw new ToolError(`check_npm_audit_cache: npm audit timed out after ${timeoutMs}ms.`, -32603);
    throw new ToolError(`check_npm_audit_cache: npm audit failed: ${result.error.message}`, -32603);
  }
  const stdout = (result.stdout || "").trim();
  if (!stdout)
    throw new ToolError(`check_npm_audit_cache: npm audit produced no output (stderr: ${(result.stderr || "").slice(0, 500)}).`, -32603);
  let doc;
  try { doc = JSON.parse(stdout); }
  catch (e) { throw new ToolError(`check_npm_audit_cache: npm audit output was not valid JSON: ${e.message.split("\n")[0]}`, -32603); }
  return doc;
}

/**
 * @param {string} scanAbsDir Absolute, jail-validated project directory.
 * @param {string} scanOrigPath Client-relative path echoed in the result.
 * @param {{cachePath?: {absPath: string, origPath: string}, runLive?: boolean, timeoutMs?: number, maxResults?: number}} opts
 * @returns {object}
 */
function checkNpmAuditCache(scanAbsDir, scanOrigPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(scanAbsDir); }
  catch (e) { throw new ToolError(`check_npm_audit_cache: cannot access '${scanOrigPath}': ${e.message}`, -32603); }
  if (!stat.isDirectory())
    throw new ToolError(`check_npm_audit_cache: '${scanOrigPath}' is not a directory.`, -32602);

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("check_npm_audit_cache: max_results must be a number.", -32602);
  if (opts.timeoutMs !== undefined && typeof opts.timeoutMs !== "number")
    throw new ToolError("check_npm_audit_cache: timeout_ms must be a number.", -32602);

  const maxResults = Math.min(Math.max(opts.maxResults || DEFAULT_MAX_RESULTS, 1), MAX_RESULTS);
  const timeoutMs = Math.min(Math.max(opts.timeoutMs || DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);

  let source, cacheFile, doc;

  if (opts.cachePath) {
    doc = readJsonFile(opts.cachePath.absPath, opts.cachePath.origPath);
    source = "cache_path";
    cacheFile = opts.cachePath.origPath;
  } else {
    const found = findDefaultCacheFile(scanAbsDir);
    if (found) {
      doc = readJsonFile(found.absPath, found.name);
      source = "default_cache";
      cacheFile = found.name;
    } else if (opts.runLive) {
      doc = runLiveNpmAudit(scanAbsDir, scanOrigPath, timeoutMs);
      source = "live";
      cacheFile = null;
    } else {
      return {
        path: scanOrigPath, source: "none", cacheFile: null, found: false,
        totalVulnerabilities: 0, bySeverity: emptySeverityCounts(),
        dependenciesAudited: null, advisories: [], truncated: false,
        hints: ["No cached npm audit report found and run_live was not set — pass cache_path, place one of npm-audit.json/.npm-audit-cache.json/audit-report.json in `path`, or set run_live:true."],
      };
    }
  }

  const { bySeverity, totalVulnerabilities, dependenciesAudited, advisories } = normaliseAuditReport(doc, cacheFile || "npm audit --json output");
  const truncated = advisories.length > maxResults;

  const hints = [];
  if (bySeverity.critical > 0) hints.push(`${bySeverity.critical} critical-severity vulnerability(ies) found.`);
  if (bySeverity.high > 0) hints.push(`${bySeverity.high} high-severity vulnerability(ies) found.`);
  if (totalVulnerabilities === 0) hints.push("No vulnerabilities reported.");

  return {
    path: scanOrigPath, source, cacheFile, found: true,
    totalVulnerabilities, bySeverity, dependenciesAudited,
    advisories: advisories.slice(0, maxResults), truncated,
    hints,
  };
}

module.exports = { checkNpmAuditCache };
