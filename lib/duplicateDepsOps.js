"use strict";
// ── FIND_DUPLICATE_DEPENDENCIES — monorepo package.json version-conflict scan ─
// Recursively finds every package.json under a root, collects each package's
// declared dependency versions, and flags dependency names that are declared
// with more than one distinct version range across the tree. Pure text/JSON
// scan (no npm-registry calls, no semver-range intersection — a stricter tool
// would resolve ranges like "^1.2.0" vs "~1.3.0" to check real overlap; this
// one flags any literal string mismatch, same "best-effort textual heuristic,
// documented tradeoff" convention as find_unused_dependencies/find_dead_exports).
//
// Known false-positive class (documented, not fixed): two different literal
// range strings can still be compatible (e.g. "^1.2.0" and "^1.2.3" both
// resolve into the 1.x line and npm/yarn workspaces would happily hoist a
// single satisfying version) — this tool reports the literal mismatch as a
// lead for review, not a guaranteed real conflict.
const fs   = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");

const ALL_BLOCKS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const DEFAULT_BLOCKS = ["dependencies", "devDependencies"];

function collectPackageJsonFiles(absDir, relBase = "") {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); }
  catch (e) { return out; }
  for (const ent of entries) {
    if (isIgnored(ent.name)) continue;
    const abs = path.join(absDir, ent.name);
    const rel = relBase ? relBase + "/" + ent.name : ent.name;
    if (ent.isDirectory()) out.push(...collectPackageJsonFiles(abs, rel));
    else if (ent.isFile() && ent.name === "package.json") out.push(rel);
  }
  return out;
}

/**
 * Find dependency version conflicts across every package.json in a directory tree.
 * @param {string} rootAbsPath  Absolute, jail-validated directory to scan.
 * @param {string} rootOrigPath Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {string[]} [opts.blocks] Which dependency blocks to check
 *   (default ["dependencies","devDependencies"]; valid: dependencies,
 *   devDependencies, peerDependencies, optionalDependencies).
 * @returns {{path, packagesScanned, malformed: string[], dependenciesChecked, conflictCount, conflicts: Array}}
 */
function findDuplicateDependencies(rootAbsPath, rootOrigPath, opts = {}) {
  const rootStat = fs.statSync(rootAbsPath);
  if (!rootStat.isDirectory())
    throw new Error(`find_duplicate_dependencies: '${rootOrigPath}' is not a directory.`);

  const blocks = Array.isArray(opts.blocks) && opts.blocks.length
    ? opts.blocks.filter(b => ALL_BLOCKS.includes(b))
    : DEFAULT_BLOCKS;
  if (Array.isArray(opts.blocks) && opts.blocks.length && blocks.length === 0)
    throw new Error(`find_duplicate_dependencies: 'blocks' contained no valid block names (valid: ${ALL_BLOCKS.join(", ")}).`);

  const files = collectPackageJsonFiles(rootAbsPath);
  const malformed = [];
  // depName -> version -> [{ package, block }]
  const registry = new Map();
  let packagesScanned = 0;

  for (const rel of files) {
    let raw, pkg;
    try { raw = fs.readFileSync(path.join(rootAbsPath, rel), "utf8"); }
    catch (e) { malformed.push(rel); continue; }
    try { pkg = JSON.parse(raw); }
    catch (e) { malformed.push(rel); continue; }
    if (pkg === null || typeof pkg !== "object" || Array.isArray(pkg)) { malformed.push(rel); continue; }
    packagesScanned++;

    for (const block of blocks) {
      const val = pkg[block];
      if (val === undefined || val === null || typeof val !== "object" || Array.isArray(val)) continue;
      for (const [name, version] of Object.entries(val)) {
        if (typeof version !== "string") continue;
        if (!registry.has(name)) registry.set(name, new Map());
        const versions = registry.get(name);
        if (!versions.has(version)) versions.set(version, []);
        versions.get(version).push({ package: rel, block });
      }
    }
  }

  const conflicts = [];
  for (const [name, versions] of registry) {
    if (versions.size < 2) continue;
    conflicts.push({
      name,
      versionCount: versions.size,
      versions: [...versions.entries()].map(([version, packages]) => ({ version, packages })),
    });
  }
  conflicts.sort((a, b) => a.name.localeCompare(b.name));

  return {
    path: rootOrigPath,
    packagesScanned,
    malformed,
    dependenciesChecked: registry.size,
    conflictCount: conflicts.length,
    conflicts,
  };
}

module.exports = { findDuplicateDependencies };
