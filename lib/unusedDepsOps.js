"use strict";
// ── FIND_UNUSED_DEPENDENCIES — package.json deps never require()'d/import'd ─
// Cross-references package.json dependency blocks against actual bare-specifier
// usage (require/import/dynamic import) across a source tree. Pure text-scan,
// same collectFiles/relative-vs-bare-specifier convention as find_circular_deps
// and find_dead_exports. Bare (non-relative, non-absolute) specifiers are
// normalised to their top-level package name (scoped: "@scope/pkg/sub" ->
// "@scope/pkg"; unscoped: "lodash/fp" -> "lodash") and compared against the
// configured dependency names.
//
// Known false-positive class (documented, not fixed): devDependencies that
// are only referenced from config files (.eslintrc, jest.config.js, etc.) or
// invoked purely via npm scripts/CLI (never `require()`'d from source) will
// be reported unused even though they are legitimately needed. Callers should
// treat results as a lead to review, not an automatic prune list.
const fs   = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_BLOCKS = ["dependencies", "devDependencies"];
const ALL_BLOCKS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

function collectFiles(absDir, extensions, relBase = "") {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); }
  catch (e) { return out; }
  for (const ent of entries) {
    if (isIgnored(ent.name)) continue;
    const abs = path.join(absDir, ent.name);
    const rel = relBase ? relBase + "/" + ent.name : ent.name;
    if (ent.isDirectory()) out.push(...collectFiles(abs, extensions, rel));
    else if (ent.isFile() && extensions.some(e => ent.name.endsWith(e))) out.push(rel);
  }
  return out;
}

// Top-level package name for a bare specifier: scoped packages keep 2
// segments ("@scope/name"), unscoped packages keep 1 ("name" from "name/sub").
function topLevelPkgName(spec) {
  if (spec.startsWith("@")) {
    const parts = spec.split("/");
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : spec;
  }
  return spec.split("/")[0];
}

const IMPORT_FROM_RE   = /import\s+(?:[\s\S]*?)\s+from\s*["'`]([^"'`]+)["'`]/g;
const IMPORT_BARE_RE   = /import\s*["'`]([^"'`]+)["'`]/g; // side-effect-only `import "spec"`
const DYNAMIC_IMPORT_RE = /import\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
const REQUIRE_RE       = /require\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
const EXPORT_FROM_RE   = /export\s*(?:\*|\{[^}]*\})\s*from\s*["'`]([^"'`]+)["'`]/g;

function extractSpecifiers(source) {
  const specs = [];
  let m;
  for (const re of [IMPORT_FROM_RE, IMPORT_BARE_RE, DYNAMIC_IMPORT_RE, REQUIRE_RE, EXPORT_FROM_RE]) {
    re.lastIndex = 0;
    while ((m = re.exec(source)) !== null) specs.push(m[1]);
  }
  return specs;
}

/**
 * Find package.json dependencies never require()'d/import'd anywhere in a source tree.
 * @param {string} pkgAbsPath   Absolute, jail-validated path to package.json.
 * @param {string} pkgOrigPath  Client-relative path echoed in the result.
 * @param {string} scanAbsDir   Absolute, jail-validated directory to scan for usage.
 * @param {string} scanOrigPath Client-relative scan path echoed in the result.
 * @param {object} [opts]
 * @param {string[]} [opts.extensions] File extensions to scan (default DEFAULT_EXTENSIONS).
 * @param {string[]} [opts.blocks]     Which package.json dependency blocks to check
 *   (default ["dependencies","devDependencies"]; valid: dependencies, devDependencies,
 *   peerDependencies, optionalDependencies).
 * @returns {{path, scanPath, filesScanned, dependenciesChecked, unusedCount, unused: Array}}
 */
function findUnusedDependencies(pkgAbsPath, pkgOrigPath, scanAbsDir, scanOrigPath, opts = {}) {
  let raw;
  try { raw = fs.readFileSync(pkgAbsPath, "utf8"); }
  catch (e) { throw new Error(`find_unused_dependencies: cannot read '${pkgOrigPath}': ${e.message}`); }

  let pkg;
  try { pkg = JSON.parse(raw); }
  catch (e) { throw new Error(`find_unused_dependencies: '${pkgOrigPath}' is not valid JSON: ${e.message}`); }

  if (pkg === null || typeof pkg !== "object" || Array.isArray(pkg))
    throw new Error(`find_unused_dependencies: '${pkgOrigPath}' must contain a JSON object at the top level.`);

  const scanStat = fs.statSync(scanAbsDir);
  if (!scanStat.isDirectory())
    throw new Error(`find_unused_dependencies: '${scanOrigPath}' is not a directory.`);

  const blocks = Array.isArray(opts.blocks) && opts.blocks.length
    ? opts.blocks.filter(b => ALL_BLOCKS.includes(b))
    : DEFAULT_BLOCKS;
  if (Array.isArray(opts.blocks) && opts.blocks.length && blocks.length === 0)
    throw new Error(`find_unused_dependencies: 'blocks' contained no valid block names (valid: ${ALL_BLOCKS.join(", ")}).`);

  const extensions = Array.isArray(opts.extensions) && opts.extensions.length
    ? opts.extensions : DEFAULT_EXTENSIONS;

  // name -> block it was found in (first match wins if listed in multiple blocks)
  const deps = new Map();
  for (const block of blocks) {
    const val = pkg[block];
    if (val === undefined) continue;
    if (val === null || typeof val !== "object" || Array.isArray(val)) continue; // malformed block: skip, not this tool's job to flag shape
    for (const name of Object.keys(val)) {
      if (!deps.has(name)) deps.set(name, block);
    }
  }

  const files = collectFiles(scanAbsDir, extensions);
  const usedPkgNames = new Set();
  for (const rel of files) {
    let source;
    try { source = fs.readFileSync(path.join(scanAbsDir, rel), "utf8"); }
    catch (e) { continue; }
    for (const spec of extractSpecifiers(source)) {
      if (spec.startsWith(".") || spec.startsWith("/")) continue; // relative/absolute: not a dependency
      usedPkgNames.add(topLevelPkgName(spec));
    }
  }

  const unused = [];
  for (const [name, block] of deps) {
    if (!usedPkgNames.has(name)) unused.push({ name, block });
  }
  unused.sort((a, b) => a.name.localeCompare(b.name));

  return {
    path: pkgOrigPath,
    scanPath: scanOrigPath,
    filesScanned: files.length,
    dependenciesChecked: deps.size,
    unusedCount: unused.length,
    unused,
  };
}

module.exports = { findUnusedDependencies };
