"use strict";
// ── CHECK_DEPENDENCY_CONFUSION_RISK — internal package registry-squat audit ─
// Classic dependency-confusion attack: an org publishes/consumes an internal
// package under an unscoped name (e.g. "acme-billing-core") that has no
// reservation on the public npm registry — an attacker can publish a
// same-named malicious package publicly, and a misconfigured install
// (missing/incorrect .npmrc scope-registry mapping, or no scope at all)
// resolves to the attacker's package instead of the intended private one.
//
// Two independent, read-only, zero-network checks against package.json (+
// .npmrc if present alongside it):
//   1. unscoped_internal_looking_dependency (error) — a dependency name (in
//      dependencies/devDependencies/peerDependencies/optionalDependencies)
//      matches an "internal-looking" heuristic — either explicitly supplied
//      via opts.internalPackagePrefixes, or auto-derived from the scanned
//      package.json's OWN name field when it is itself scoped (e.g. this
//      project is "@acme/foo" -> "@acme/" is treated as the org's internal
//      scope) — but the dependency itself has no "@scope/" prefix. An
//      unscoped internal-looking name is squattable on the public registry.
//   2. scoped_dependency_missing_registry_pin (warning) — a scoped
//      dependency ("@scope/name") is declared, but no matching
//      "@scope:registry=" line exists anywhere in a sibling .npmrc file (or
//      opts.npmrcContent, for callers that want to pass it explicitly) —
//      without an explicit registry pin for that scope, some npm/yarn
//      configurations can still fall through to the public registry.
//
// Pure heuristic, not a live registry lookup: this tool intentionally makes
// NO network calls (consistent with every other scan tool in this family
// being zero-network/zero-dependency) — it cannot confirm whether a name is
// actually unclaimed on the public registry, only that the local
// configuration provides no protection against that possibility.
const fs = require("fs");
const path = require("path");
const { ToolError } = require("./errors");

const DEFAULT_BLOCKS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

function isScoped(name) {
  return typeof name === "string" && name.startsWith("@") && name.includes("/");
}

function scopeOf(name) {
  const idx = name.indexOf("/");
  return idx === -1 ? null : name.slice(0, idx); // e.g. "@acme"
}

function readNpmrcScopeRegistries(npmrcText) {
  const scopes = new Set();
  const RE = /^\s*(@[^:\s]+):registry\s*=/gm;
  let m;
  while ((m = RE.exec(npmrcText)) !== null) scopes.add(m[1]);
  return scopes;
}

/**
 * @param {string} absPath  Absolute, jail-validated path to package.json.
 * @param {string} origPath Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {string[]} [opts.blocks]
 * @param {string[]} [opts.internalPackagePrefixes] Explicit internal-name prefixes (e.g. ["acme-", "@acme/"]).
 * @param {string}   [opts.npmrcContent] Explicit .npmrc text to check instead of reading a sibling file.
 * @param {number}   [opts.maxResults]
 * @returns {{path, depsScanned, ownScope, internalPrefixesUsed, issueCount, errorCount, warningCount, truncated, issues}}
 */
function checkDependencyConfusionRisk(absPath, origPath, opts = {}) {
  let raw;
  try { raw = fs.readFileSync(absPath, "utf8"); }
  catch (e) { throw new ToolError(`check_dependency_confusion_risk: cannot access '${origPath}': ${e.message}`, -32602); }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("check_dependency_confusion_risk: max_results must be a number.", -32602);
  if (opts.blocks !== undefined && !Array.isArray(opts.blocks))
    throw new ToolError("check_dependency_confusion_risk: blocks must be an array of strings.", -32602);
  if (opts.internalPackagePrefixes !== undefined && !Array.isArray(opts.internalPackagePrefixes))
    throw new ToolError("check_dependency_confusion_risk: internalPackagePrefixes must be an array of strings.", -32602);

  const maxResults = Math.min(Math.max(1, Math.trunc(opts.maxResults ?? DEFAULT_MAX_RESULTS)), HARD_MAX_RESULTS);
  const blocks = Array.isArray(opts.blocks) && opts.blocks.length ? opts.blocks : DEFAULT_BLOCKS;

  let pkg;
  try { pkg = JSON.parse(raw); }
  catch (e) { throw new ToolError(`check_dependency_confusion_risk: malformed JSON in '${origPath}': ${e.message}`, -32602); }

  const ownScope = isScoped(pkg && pkg.name) ? scopeOf(pkg.name) : null;
  const explicitPrefixes = Array.isArray(opts.internalPackagePrefixes) ? opts.internalPackagePrefixes.filter(p => typeof p === "string" && p.length > 0) : [];
  const internalPrefixesUsed = ownScope ? [...explicitPrefixes, ownScope + "/"] : explicitPrefixes.slice();

  let npmrcText = "";
  if (typeof opts.npmrcContent === "string") {
    npmrcText = opts.npmrcContent;
  } else {
    try { npmrcText = fs.readFileSync(path.join(path.dirname(absPath), ".npmrc"), "utf8"); }
    catch (_) { npmrcText = ""; }
  }
  const pinnedScopes = readNpmrcScopeRegistries(npmrcText);

  const issues = [];
  let depsScanned = 0;

  for (const block of blocks) {
    const deps = pkg && typeof pkg[block] === "object" && pkg[block];
    if (!deps) continue;
    for (const name of Object.keys(deps)) {
      depsScanned++;

      if (isScoped(name)) {
        const scope = scopeOf(name);
        if (!pinnedScopes.has(scope)) {
          issues.push({
            block, name, rule: "scoped_dependency_missing_registry_pin", severity: "warning",
            message: `'${name}' is scoped but no '${scope}:registry=' line was found in .npmrc — without an explicit registry pin, some configurations can still resolve this scope from the public registry.`,
          });
        }
        continue;
      }

      const matchedPrefix = internalPrefixesUsed.find(p => !p.startsWith("@") && name.startsWith(p));
      if (matchedPrefix) {
        issues.push({
          block, name, rule: "unscoped_internal_looking_dependency", severity: "error",
          message: `'${name}' matches internal-looking prefix '${matchedPrefix}' but is unscoped — an attacker can publish a same-named package publicly (dependency confusion). Consider a scoped name (e.g. '${ownScope || "@yourorg"}/${name}') or a private-registry-only mapping.`,
        });
      }
    }
  }

  issues.sort((a, b) => a.block.localeCompare(b.block) || a.name.localeCompare(b.name));
  const truncated = issues.length > maxResults;
  const finalIssues = issues.slice(0, maxResults);

  return {
    path: origPath,
    depsScanned,
    ownScope,
    internalPrefixesUsed,
    issueCount: issues.length,
    errorCount: finalIssues.filter(i => i.severity === "error").length,
    warningCount: finalIssues.filter(i => i.severity === "warning").length,
    truncated,
    issues: finalIssues,
  };
}

module.exports = { checkDependencyConfusionRisk };
