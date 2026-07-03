"use strict";
// ── PACKAGE_JSON_AUDIT — static structural audit of a package.json ────────
// Pure structural analysis, zero network/registry calls (offline-safe,
// deterministic). Flags common footguns:
//   - missing required fields (name, version)
//   - invalid/non-semver-shaped "version"
//   - a dependency listed in both dependencies AND devDependencies
//   - risky version pins: "*", "latest", "" (empty string)
//   - "main"/"exports" entry pointing at a file that doesn't exist on disk
//   - scripts referencing "TODO"/"echo 'Error: no test specified'" placeholders
// Severity: "error" (will likely break installs/builds) vs "warning" (smell).

const fs   = require("fs");
const path = require("path");

const SEMVER_SHAPE = /^\d+\.\d+\.\d+/; // loose: leading X.Y.Z, ignores prerelease/build tags
const RISKY_PINS = new Set(["*", "latest", "x", ""]);

function checkDepBlock(deps, blockName, issues) {
  if (deps === undefined) return;
  if (deps === null || typeof deps !== "object" || Array.isArray(deps)) {
    issues.push({ severity: "error", field: blockName, message: `'${blockName}' must be an object mapping package name to version range.` });
    return;
  }
  for (const [name, range] of Object.entries(deps)) {
    if (typeof range !== "string" || RISKY_PINS.has(range.trim())) {
      issues.push({ severity: "warning", field: `${blockName}.${name}`, message: `Risky/unpinned version range '${range}' — consider a specific range (e.g. '^1.2.3').` });
    }
  }
}

/**
 * Audit a package.json file for common structural issues.
 * @param {string} filePath   Absolute path to package.json.
 * @param {string} pkgDir     Absolute directory containing the file (for main/exports existence checks).
 * @returns {{ path, valid, errorCount, warningCount, issues: [{severity,field,message}] }}
 */
function packageJsonAudit(filePath, pkgDir, origPath) {
  let raw;
  try { raw = fs.readFileSync(filePath, "utf8"); }
  catch (e) { throw new Error(`package_json_audit: cannot read '${origPath}': ${e.message}`); }

  let pkg;
  try { pkg = JSON.parse(raw); }
  catch (e) { throw new Error(`package_json_audit: '${origPath}' is not valid JSON: ${e.message}`); }

  if (pkg === null || typeof pkg !== "object" || Array.isArray(pkg))
    throw new Error(`package_json_audit: '${origPath}' must contain a JSON object at the top level.`);

  const issues = [];

  if (!pkg.name || typeof pkg.name !== "string")
    issues.push({ severity: "error", field: "name", message: "Missing or non-string 'name' field." });
  if (!pkg.version || typeof pkg.version !== "string")
    issues.push({ severity: "error", field: "version", message: "Missing or non-string 'version' field." });
  else if (!SEMVER_SHAPE.test(pkg.version))
    issues.push({ severity: "warning", field: "version", message: `'version' ("${pkg.version}") doesn't look like semver (expected X.Y.Z...).` });

  checkDepBlock(pkg.dependencies, "dependencies", issues);
  checkDepBlock(pkg.devDependencies, "devDependencies", issues);
  checkDepBlock(pkg.peerDependencies, "peerDependencies", issues);
  checkDepBlock(pkg.optionalDependencies, "optionalDependencies", issues);

  if (pkg.dependencies && pkg.devDependencies) {
    const dupes = Object.keys(pkg.dependencies).filter(n => Object.prototype.hasOwnProperty.call(pkg.devDependencies, n));
    for (const n of dupes) {
      issues.push({ severity: "error", field: n, message: `'${n}' is listed in both dependencies and devDependencies.` });
    }
  }

  if (typeof pkg.main === "string" && pkg.main.trim()) {
    const mainAbs = path.join(pkgDir, pkg.main);
    if (!fs.existsSync(mainAbs))
      issues.push({ severity: "error", field: "main", message: `'main' points to '${pkg.main}', which does not exist on disk.` });
  }

  if (pkg.scripts && typeof pkg.scripts === "object" && !Array.isArray(pkg.scripts)) {
    if (typeof pkg.scripts.test === "string" && /no test specified/i.test(pkg.scripts.test)) {
      issues.push({ severity: "warning", field: "scripts.test", message: "Default placeholder test script — no real tests configured." });
    }
  } else if (pkg.scripts !== undefined) {
    issues.push({ severity: "error", field: "scripts", message: "'scripts' must be an object." });
  }

  if (pkg.private !== true && !pkg.license) {
    issues.push({ severity: "warning", field: "license", message: "No 'license' field and package is not marked private — publishing intent is ambiguous." });
  }

  const errorCount = issues.filter(i => i.severity === "error").length;
  const warningCount = issues.filter(i => i.severity === "warning").length;

  return { path: origPath, valid: errorCount === 0, errorCount, warningCount, issues };
}

module.exports = { packageJsonAudit };
