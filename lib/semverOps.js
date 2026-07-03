"use strict";
// ── SEMVER_COMPARE — parse/compare SemVer 2.0.0 versions, range checks ────
// Pure computation, no fs/exec. Implements the official SemVer 2.0.0 grammar
// and comparison precedence rules (https://semver.org/#spec-item-11), plus
// a common subset of package.json-style comparator/range syntax for
// satisfies() checks (^, ~, >=, <=, >, <, =, x-ranges, *).

const { ToolError } = require("./errors");

// Strict SemVer 2.0.0 regex (from the official spec's suggested pattern).
const SEMVER_RE = new RegExp(
  "^v?(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)" +
  "(?:-((?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?" +
  "(?:\\+([0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*))?$"
);

function parseSemver(version) {
  if (typeof version !== "string" || version.trim() === "") {
    throw new ToolError("semver_compare: version must be a non-empty string.", -32602);
  }
  const m = SEMVER_RE.exec(version.trim());
  if (!m) {
    throw new ToolError(`semver_compare: '${version}' is not a valid SemVer 2.0.0 version (expected major.minor.patch[-prerelease][+build]).`, -32602);
  }
  const [, major, minor, patch, prerelease, build] = m;
  return {
    raw: version.trim(),
    major: parseInt(major, 10),
    minor: parseInt(minor, 10),
    patch: parseInt(patch, 10),
    prerelease: prerelease ? prerelease.split(".") : [],
    build: build ? build.split(".") : [],
  };
}

/** Compare two dot-separated prerelease identifier arrays per SemVer #11. */
function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;  // no prerelease > has prerelease
  if (b.length === 0) return -1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (i >= a.length) return -1; // a ran out of fields -> a is smaller
    if (i >= b.length) return 1;
    const ai = a[i], bi = b[i];
    const aNum = /^\d+$/.test(ai), bNum = /^\d+$/.test(bi);
    if (aNum && bNum) {
      const diff = parseInt(ai, 10) - parseInt(bi, 10);
      if (diff !== 0) return diff < 0 ? -1 : 1;
    } else if (aNum !== bNum) {
      return aNum ? -1 : 1; // numeric identifiers always < alphanumeric
    } else if (ai !== bi) {
      return ai < bi ? -1 : 1;
    }
  }
  return 0;
}

/** Compare two parsed SemVer objects. Returns -1, 0, or 1. Build metadata is ignored (spec #10). */
function compareParsed(a, b) {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

function compareSemver(versionA, versionB) {
  return compareParsed(parseSemver(versionA), parseSemver(versionB));
}

// ── Range satisfaction (common package.json comparator subset) ────────────

function bumpForCaret(p) {
  // ^1.2.3 := >=1.2.3 <2.0.0 ; ^0.2.3 := >=0.2.3 <0.3.0 ; ^0.0.3 := >=0.0.3 <0.0.4
  if (p.major > 0) return { major: p.major + 1, minor: 0, patch: 0, prerelease: [] };
  if (p.minor > 0) return { major: 0, minor: p.minor + 1, patch: 0, prerelease: [] };
  return { major: 0, minor: 0, patch: p.patch + 1, prerelease: [] };
}
function bumpForTilde(p) {
  // ~1.2.3 := >=1.2.3 <1.3.0 ; ~1.2 := >=1.2.0 <1.3.0 ; ~1 := >=1.0.0 <2.0.0
  return { major: p.major, minor: p.minor + 1, patch: 0, prerelease: [] };
}

/**
 * Parse a single comparator like '^1.2.3', '~1.2', '>=1.2.3', '1.2.x', '*'.
 * Returns { min: parsedOrNull, minInclusive, max: parsedOrNull, maxInclusive }.
 */
function parseComparator(raw) {
  const c = raw.trim();
  if (c === "" || c === "*" || c === "latest" || /^x(\.x)*$/i.test(c)) {
    return { min: null, minInclusive: true, max: null, maxInclusive: true };
  }

  const opMatch = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(c);
  const op = opMatch[1] || "=";
  let rest = opMatch[2];

  // x-ranges: 1.2.x, 1.x, 1.x.x -> treat missing/x parts as 0 with an upper bump.
  const xMatch = /^(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/.exec(rest);
  if (xMatch && /[xX*]/.test(rest)) {
    const maj = parseInt(xMatch[1], 10);
    if (xMatch[2] === undefined || /[xX*]/.test(xMatch[2])) {
      // 1.x -> >=1.0.0 <2.0.0
      return { min: { major: maj, minor: 0, patch: 0, prerelease: [] }, minInclusive: true,
               max: { major: maj + 1, minor: 0, patch: 0, prerelease: [] }, maxInclusive: false };
    }
    // 1.2.x -> >=1.2.0 <1.3.0
    const min = parseInt(xMatch[2], 10);
    return { min: { major: maj, minor: min, patch: 0, prerelease: [] }, minInclusive: true,
             max: { major: maj, minor: min + 1, patch: 0, prerelease: [] }, maxInclusive: false };
  }

  // Otherwise rest must itself be a valid (possibly partial) semver-like x.y[.z].
  const partial = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/.exec(rest);
  if (!partial) {
    throw new ToolError(`semver_compare: could not parse range comparator '${raw}'.`, -32602);
  }
  const p = {
    major: parseInt(partial[1], 10),
    minor: partial[2] !== undefined ? parseInt(partial[2], 10) : 0,
    patch: partial[3] !== undefined ? parseInt(partial[3], 10) : 0,
    prerelease: partial[4] ? partial[4].split(".") : [],
  };

  if (op === "^") {
    return { min: p, minInclusive: true, max: bumpForCaret(p), maxInclusive: false };
  }
  if (op === "~") {
    return { min: p, minInclusive: true, max: bumpForTilde(p), maxInclusive: false };
  }
  if (op === ">=") return { min: p, minInclusive: true, max: null, maxInclusive: true };
  if (op === ">")  return { min: p, minInclusive: false, max: null, maxInclusive: true };
  if (op === "<=") return { min: null, minInclusive: true, max: p, maxInclusive: true };
  if (op === "<")  return { min: null, minInclusive: true, max: p, maxInclusive: false };
  return { min: p, minInclusive: true, max: p, maxInclusive: true }; // '='
}

/**
 * Check whether `version` satisfies `range`. `range` may be a space-separated
 * conjunction of comparators (all must hold), e.g. '>=1.2.0 <2.0.0'.
 */
function satisfiesRange(version, range) {
  if (typeof range !== "string" || range.trim() === "") {
    throw new ToolError("semver_compare: range must be a non-empty string.", -32602);
  }
  const v = parseSemver(version);
  const comparators = range.trim().split(/\s+/).map(parseComparator);

  for (const { min, minInclusive, max, maxInclusive } of comparators) {
    if (min) {
      const cmp = compareParsed(v, min);
      if (minInclusive ? cmp < 0 : cmp <= 0) return false;
    }
    if (max) {
      const cmp = compareParsed(v, max);
      if (maxInclusive ? cmp > 0 : cmp >= 0) return false;
    }
  }
  return true;
}

module.exports = { parseSemver, compareSemver, satisfiesRange };
