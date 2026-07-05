"use strict";
// ── DOCKERIGNORE COVERAGE CHECKER ──────────────────────────────────────────
// Analogous to check_gitignore_coverage, but for .dockerignore: no git
// dependency exists for this (there's no `docker check-ignore`), so this
// implements a simplified pattern matcher covering the common cases —
// literal segments, '*' (any chars, no '/'), '?' (one char, no '/'), and
// '**' (zero or more path segments) — plus '!' negation, evaluated in
// file order with last-match-wins semantics. It intentionally does NOT
// implement every edge case of Docker's real patternmatcher (e.g.
// re-including a specific file after a parent directory was excluded via a
// non-negated pattern is treated the same as ordinary last-match-wins,
// where Docker's own resolver actually forbids re-inclusion under an
// excluded directory). Treat results as a strong heuristic, not a
// byte-for-byte guarantee of real `docker build` context behaviour.
const fs = require("fs");
const path = require("path");
const { ToolError } = require("./errors");

const MAX_PATHS = 100;

const DEFAULT_CHECK_PATHS = [
  ".git/config",
  "node_modules/example-pkg/index.js",
  ".env",
  ".env.local",
  ".DS_Store",
  "Thumbs.db",
  "npm-debug.log",
  "dist/bundle.js",
  "build/output.js",
  "debug.log",
  "coverage/lcov-report/index.html",
  ".vscode/settings.json",
  ".idea/workspace.xml",
  "test/fixture.spec.js",
];

function validatePaths(paths) {
  if (paths === undefined || paths === null) return null;
  if (!Array.isArray(paths))
    throw new ToolError("check_dockerignore_coverage: paths must be an array of strings.", -32602);
  if (paths.length === 0)
    throw new ToolError("check_dockerignore_coverage: paths must not be empty when provided.", -32602);
  if (paths.length > MAX_PATHS)
    throw new ToolError(`check_dockerignore_coverage: paths exceeds max of ${MAX_PATHS}.`, -32602);
  for (const p of paths) {
    if (typeof p !== "string" || p.length === 0)
      throw new ToolError("check_dockerignore_coverage: every path must be a non-empty string.", -32602);
    if (p.length > 1024)
      throw new ToolError("check_dockerignore_coverage: a path exceeds 1024 characters.", -32602);
    if (p.includes("\0"))
      throw new ToolError("check_dockerignore_coverage: a path contains a null byte.", -32602);
  }
  return paths;
}

function normSegs(p) {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "").split("/").filter(Boolean);
}

function segmentMatch(pat, seg) {
  let re = "^";
  for (const ch of pat) {
    if (ch === "*") re += ".*";
    else if (ch === "?") re += ".";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  re += "$";
  return new RegExp(re).test(seg);
}

function matchSegments(patSegs, tgtSegs) {
  if (patSegs.length === 0) return tgtSegs.length === 0;
  const [p, ...prest] = patSegs;
  if (p === "**") {
    for (let i = 0; i <= tgtSegs.length; i++) {
      if (matchSegments(prest, tgtSegs.slice(i))) return true;
    }
    return false;
  }
  if (tgtSegs.length === 0) return false;
  if (!segmentMatch(p, tgtSegs[0])) return false;
  return matchSegments(prest, tgtSegs.slice(1));
}

// True if pattern matches the full path OR any ancestor directory of it
// (excluding a directory excludes everything beneath it).
function isMatch(patSegs, pathSegs) {
  for (let k = 1; k <= pathSegs.length; k++) {
    if (matchSegments(patSegs, pathSegs.slice(0, k))) return true;
  }
  return false;
}

function parseDockerignore(text) {
  return text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith("#"));
}

function evaluate(rules, candidatePath) {
  const pathSegs = normSegs(candidatePath);
  let ignored = false;
  let matchedRule = null;
  for (const rawRule of rules) {
    const neg = rawRule.startsWith("!");
    const ruleText = neg ? rawRule.slice(1) : rawRule;
    const patSegs = normSegs(ruleText);
    if (patSegs.length === 0) continue;
    if (isMatch(patSegs, pathSegs)) {
      ignored = !neg;
      matchedRule = rawRule;
    }
  }
  return { ignored, matchedRule };
}

/**
 * @param {string} rootDir Absolute, jail-validated directory containing (or near) .dockerignore.
 * @param {string} origPath Client-relative path echoed in the result.
 * @param {string[]} [paths] Candidate paths to check (defaults to DEFAULT_CHECK_PATHS).
 * @param {string} [dockerignoreRel] Relative path to the .dockerignore file (default '.dockerignore').
 */
function checkDockerignoreCoverage(rootDir, origPath, paths, dockerignoreRel) {
  const relIgnoreFile = dockerignoreRel || ".dockerignore";
  const ignoreFilePath = path.join(rootDir, relIgnoreFile);

  let text;
  try {
    text = fs.readFileSync(ignoreFilePath, "utf8");
  } catch (e) {
    throw new ToolError(`check_dockerignore_coverage: cannot read '${relIgnoreFile}' under '${origPath}': ${e.message}`, -32602);
  }

  const validated = validatePaths(paths);
  const usingDefaults = validated === null;
  const candidates = usingDefaults ? DEFAULT_CHECK_PATHS : validated;
  const rules = parseDockerignore(text);

  const results = candidates.map(c => {
    const { ignored, matchedRule } = evaluate(rules, c);
    return { path: c, ignored, matchedRule };
  });

  const ignoredCount = results.filter(r => r.ignored).length;
  const notIgnoredCount = results.length - ignoredCount;

  const recommendations = usingDefaults
    ? results.filter(r => !r.ignored).map(r =>
        `'${r.path}' is not ignored by .dockerignore — consider adding a rule for it to keep the build context small if this is unintentional.`)
    : [];

  return {
    path: origPath,
    dockerignoreFile: relIgnoreFile,
    ruleCount: rules.length,
    usingDefaults,
    totalChecked: candidates.length,
    ignoredCount,
    notIgnoredCount,
    results,
    recommendations,
  };
}

module.exports = { checkDockerignoreCoverage, DEFAULT_CHECK_PATHS };
