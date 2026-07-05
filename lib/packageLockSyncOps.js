"use strict";
// ── CHECK_PACKAGE_LOCK_SYNC — package.json vs package-lock.json drift ────
// Cross-checks every declared dependency/devDependency/optionalDependency
// range in package.json against the actual locked version in
// package-lock.json, catching the classic "edited package.json by hand,
// forgot to run npm install" drift. Supports both lockfileVersion 1
// (top-level `dependencies` map) and v2/v3 (`packages["node_modules/<name>"]`
// map, falling back to the legacy `dependencies` block npm still writes
// into v2/v3 lockfiles for backwards compatibility). Non-registry ranges
// (git/file/link/workspace/npm-alias specifiers, or 'latest'/'*') are not
// semver-checked — flagged 'skipped', not an error, since satisfiesRange()
// only understands registry-style ranges. Pure fs + JSON.parse, no network,
// no npm CLI invocation.

const fs = require("fs");
const { ToolError } = require("./errors");
const { satisfiesRange, parseSemver } = require("./semverOps");

const DEFAULT_BLOCKS = ["dependencies", "devDependencies", "optionalDependencies"];
const NON_REGISTRY_RE = /^(git\+|git:|github:|file:|link:|workspace:|npm:|https?:)/i;

function readJson(filePath, origPath, label) {
  let raw;
  try { raw = fs.readFileSync(filePath, "utf8"); }
  catch (e) { throw new ToolError(`check_package_lock_sync: cannot read ${label} '${origPath}': ${e.message}`, -32602); }
  try { return JSON.parse(raw); }
  catch (e) { throw new ToolError(`check_package_lock_sync: ${label} '${origPath}' is not valid JSON: ${e.message}`, -32602); }
}

/** Build a name -> lockedVersion map covering both lockfile shapes. */
function lockedVersionMap(lock) {
  const map = new Map();
  if (lock.packages && typeof lock.packages === "object") {
    for (const [key, entry] of Object.entries(lock.packages)) {
      if (key === "" || !entry || typeof entry !== "object") continue;
      const idx = key.lastIndexOf("node_modules/");
      if (idx === -1) continue;
      const name = key.slice(idx + "node_modules/".length);
      if (typeof entry.version === "string") map.set(name, entry.version);
    }
  }
  if (lock.dependencies && typeof lock.dependencies === "object") {
    for (const [name, entry] of Object.entries(lock.dependencies)) {
      if (!map.has(name) && entry && typeof entry.version === "string") map.set(name, entry.version);
    }
  }
  return map;
}

/**
 * @param {string} pkgPath    Absolute path to package.json.
 * @param {string} lockPath   Absolute path to package-lock.json.
 * @param {string} origPkgPath  Client-relative path echoed in the result.
 * @param {string} origLockPath Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {string[]} [opts.blocks] Which package.json blocks to check (default dependencies/devDependencies/optionalDependencies).
 * @returns {{path, lockPath, lockfileVersion, checked, inSyncCount, missingCount, mismatchCount, skippedCount, inSync, issues}}
 */
function checkPackageLockSync(pkgPath, lockPath, origPkgPath, origLockPath, opts = {}) {
  if (opts.blocks !== undefined && !Array.isArray(opts.blocks))
    throw new ToolError("check_package_lock_sync: blocks must be an array of strings.", -32602);
  const blocks = Array.isArray(opts.blocks) && opts.blocks.length ? opts.blocks : DEFAULT_BLOCKS;

  const pkg = readJson(pkgPath, origPkgPath, "package.json");
  if (pkg === null || typeof pkg !== "object" || Array.isArray(pkg))
    throw new ToolError(`check_package_lock_sync: '${origPkgPath}' must contain a JSON object at the top level.`, -32602);

  const lock = readJson(lockPath, origLockPath, "package-lock.json");
  if (lock === null || typeof lock !== "object" || Array.isArray(lock))
    throw new ToolError(`check_package_lock_sync: '${origLockPath}' must contain a JSON object at the top level.`, -32602);

  const locked = lockedVersionMap(lock);
  const issues = [];
  let checked = 0;

  for (const block of blocks) {
    const deps = pkg[block];
    if (deps === undefined) continue;
    if (deps === null || typeof deps !== "object" || Array.isArray(deps)) {
      issues.push({ name: null, block, declaredRange: null, lockedVersion: null, status: "invalid-block", message: `'${block}' must be an object mapping package name to version range.` });
      continue;
    }
    for (const [name, range] of Object.entries(deps)) {
      checked++;
      const lockedVersion = locked.get(name);
      if (lockedVersion === undefined) {
        issues.push({ name, block, declaredRange: range, lockedVersion: null, status: "missing", message: `'${name}' is declared in ${block} but has no entry in the lockfile — run npm install.` });
        continue;
      }
      if (typeof range !== "string" || NON_REGISTRY_RE.test(range.trim()) || range.trim() === "*" || range.trim() === "latest") {
        issues.push({ name, block, declaredRange: range, lockedVersion, status: "skipped", message: `Non-registry or wildcard range — not semver-checked.` });
        continue;
      }
      let satisfies;
      try { satisfies = satisfiesRange(parseSemver(lockedVersion).raw, range); }
      catch (e) { issues.push({ name, block, declaredRange: range, lockedVersion, status: "unparseable", message: e.message }); continue; }
      if (!satisfies) {
        issues.push({ name, block, declaredRange: range, lockedVersion, status: "mismatch", message: `Locked version '${lockedVersion}' does not satisfy declared range '${range}'.` });
      }
    }
  }

  const missingCount = issues.filter(i => i.status === "missing").length;
  const mismatchCount = issues.filter(i => i.status === "mismatch").length;
  const skippedCount = issues.filter(i => i.status === "skipped").length;
  const invalidCount = issues.filter(i => i.status === "invalid-block" || i.status === "unparseable").length;

  return {
    path: origPkgPath,
    lockPath: origLockPath,
    lockfileVersion: typeof lock.lockfileVersion === "number" ? lock.lockfileVersion : null,
    checked,
    inSync: missingCount === 0 && mismatchCount === 0 && invalidCount === 0,
    missingCount,
    mismatchCount,
    skippedCount,
    invalidCount,
    issues,
  };
}

module.exports = { checkPackageLockSync };
