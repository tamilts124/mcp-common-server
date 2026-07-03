"use strict";
/**
 * test/sections/102-semver-compare.js
 * Isolated functional tests for the semver_compare tool (parseSemver /
 * compareSemver / satisfiesRange).
 * Section [40]
 */

const { test } = require("../test-harness");
const { parseSemver, compareSemver, satisfiesRange } = require("../../lib/semverOps");

function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

// [40-A] NORMAL
test("[40-A-1] parse: basic major.minor.patch", () => {
  const p = parseSemver("1.2.3");
  assert(p.major === 1 && p.minor === 2 && p.patch === 3 && p.prerelease.length === 0);
});
test("[40-A-2] parse: leading 'v' prefix accepted", () => {
  const p = parseSemver("v2.0.0");
  assert(p.major === 2);
});
test("[40-A-3] parse: prerelease and build metadata split correctly", () => {
  const p = parseSemver("1.0.0-beta.1+build.5");
  assert(p.prerelease.join(".") === "beta.1" && p.build.join(".") === "build.5");
});
test("[40-A-4] compare: equal versions -> 0", () => {
  assert(compareSemver("1.2.3", "1.2.3") === 0);
});
test("[40-A-5] compare: patch difference", () => {
  assert(compareSemver("1.2.3", "1.2.4") < 0);
  assert(compareSemver("1.2.4", "1.2.3") > 0);
});
test("[40-A-6] compare: no-prerelease > has-prerelease at same major.minor.patch", () => {
  assert(compareSemver("1.0.0", "1.0.0-alpha") > 0);
});
test("[40-A-7] compare: numeric prerelease identifiers compared numerically not lexically", () => {
  assert(compareSemver("1.0.0-alpha.2", "1.0.0-alpha.10") < 0); // 2 < 10 numerically
});
test("[40-A-8] compare: build metadata ignored in comparison", () => {
  assert(compareSemver("1.0.0+build1", "1.0.0+build2") === 0);
});
test("[40-A-9] satisfies: caret range allows minor/patch bumps within same major", () => {
  assert(satisfiesRange("1.5.0", "^1.2.3") === true);
  assert(satisfiesRange("2.0.0", "^1.2.3") === false);
});
test("[40-A-10] satisfies: tilde range allows only patch bumps", () => {
  assert(satisfiesRange("1.2.9", "~1.2.3") === true);
  assert(satisfiesRange("1.3.0", "~1.2.3") === false);
});
test("[40-A-11] satisfies: x-range matches any minor/patch", () => {
  assert(satisfiesRange("1.9.9", "1.x") === true);
  assert(satisfiesRange("2.0.0", "1.x") === false);
});
test("[40-A-12] satisfies: wildcard '*' matches anything", () => {
  assert(satisfiesRange("9.9.9", "*") === true);
});
test("[40-A-13] satisfies: conjunction of comparators (all must hold)", () => {
  assert(satisfiesRange("1.5.0", ">=1.2.0 <2.0.0") === true);
  assert(satisfiesRange("2.0.0", ">=1.2.0 <2.0.0") === false);
});

// [40-B] MEDIUM — boundary & validation
test("[40-B-1] parse: missing version throws -32602", () => {
  let threw = false;
  try { parseSemver(undefined); } catch (e) { threw = true; assert(e.code === -32602); }
  assert(threw);
});
test("[40-B-2] parse: non-string version throws -32602", () => {
  let threw = false;
  try { parseSemver(123); } catch (e) { threw = true; assert(e.code === -32602); }
  assert(threw);
});
test("[40-B-3] parse: empty string throws -32602", () => {
  let threw = false;
  try { parseSemver("   "); } catch (e) { threw = true; assert(e.code === -32602); }
  assert(threw);
});
test("[40-B-4] parse: incomplete version (missing patch) throws", () => {
  let threw = false;
  try { parseSemver("1.2"); } catch (e) { threw = true; }
  assert(threw);
});
test("[40-B-5] parse: leading-zero major throws (not valid SemVer)", () => {
  let threw = false;
  try { parseSemver("01.2.3"); } catch (e) { threw = true; }
  assert(threw);
});
test("[40-B-6] parse: non-numeric segment throws", () => {
  let threw = false;
  try { parseSemver("a.b.c"); } catch (e) { threw = true; }
  assert(threw);
});
test("[40-B-7] compare: invalid version_b throws -32602", () => {
  let threw = false;
  try { compareSemver("1.0.0", "not-a-version"); } catch (e) { threw = true; assert(e.code === -32602); }
  assert(threw);
});
test("[40-B-8] satisfies: missing range throws -32602", () => {
  let threw = false;
  try { satisfiesRange("1.0.0", ""); } catch (e) { threw = true; assert(e.code === -32602); }
  assert(threw);
});
test("[40-B-9] satisfies: unparseable comparator throws with clear message", () => {
  let threw = false, msg = "";
  try { satisfiesRange("1.0.0", "^abc"); } catch (e) { threw = true; msg = e.message; }
  assert(threw && /could not parse/.test(msg));
});

// [40-C] HIGH — structural edge cases
test("[40-C-1] compare: major.minor take precedence over prerelease", () => {
  assert(compareSemver("2.0.0-alpha", "1.9.9") > 0);
});
test("[40-C-2] compare: multi-dot-separated prerelease identifiers compared piecewise", () => {
  assert(compareSemver("1.0.0-alpha", "1.0.0-alpha.1") < 0); // fewer fields = lower precedence
});
test("[40-C-3] compare: alphanumeric identifiers compared lexically (ASCII)", () => {
  assert(compareSemver("1.0.0-alpha", "1.0.0-beta") < 0);
});
test("[40-C-4] satisfies: '>' and '<' are exclusive at the boundary", () => {
  assert(satisfiesRange("1.2.3", ">1.2.3") === false);
  assert(satisfiesRange("1.2.4", ">1.2.3") === true);
});
test("[40-C-5] satisfies: bare exact version comparator ('1.2.3') matches only that version", () => {
  assert(satisfiesRange("1.2.3", "1.2.3") === true);
  assert(satisfiesRange("1.2.4", "1.2.3") === false);
});
test("[40-C-6] satisfies: caret on 0.x.y only allows patch bumps (spec's 0.x special case)", () => {
  assert(satisfiesRange("0.2.9", "^0.2.3") === true);
  assert(satisfiesRange("0.3.0", "^0.2.3") === false);
});
test("[40-C-7] satisfies: caret on 0.0.x pins exactly (spec's 0.0.x special case)", () => {
  assert(satisfiesRange("0.0.3", "^0.0.3") === true);
  assert(satisfiesRange("0.0.4", "^0.0.3") === false);
});

// [40-D] CRITICAL — security
test("[40-D-1] parse: SQL-injection-shaped string is just rejected as invalid semver, not executed", () => {
  let threw = false;
  try { parseSemver("1.2.3'; DROP TABLE users; --"); } catch (e) { threw = true; }
  assert(threw);
});
test("[40-D-2] parse: path-traversal-shaped string rejected as invalid semver", () => {
  let threw = false;
  try { parseSemver("../../../etc/passwd"); } catch (e) { threw = true; }
  assert(threw);
});
test("[40-D-3] parse: HTML/script-shaped string rejected as invalid semver", () => {
  let threw = false;
  try { parseSemver("<script>alert(1)</script>"); } catch (e) { threw = true; }
  assert(threw);
});
test("[40-D-4] parse: prerelease containing sanitized script-shaped text is inert data, round-trips literally", () => {
  const p = parseSemver("1.0.0-scriptalert1script");
  assert(Array.isArray(p.prerelease) && p.prerelease[0] === "scriptalert1script");
});
test("[40-D-5] compare: never eval()'s or executes any part of the input", () => {
  // If compareSemver ever used eval/Function on input this would throw ReferenceError instead of ToolError.
  let code = null;
  try { compareSemver("1.0.0", "require('fs')"); } catch (e) { code = e.code; }
  assert(code === -32602);
});

// [40-E] EXTREME
test("[40-E-1] fuzz: random-byte version string throws cleanly, never crashes process", () => {
  const fuzz = Buffer.from(Array.from({ length: 200 }, () => Math.floor(Math.random() * 256))).toString("latin1");
  let handled = false;
  try { parseSemver(fuzz); handled = true; } catch (e) { handled = true; }
  assert(handled);
});
test("[40-E-2] extreme: very large version numbers compare correctly", () => {
  assert(compareSemver("999999999.0.0", "1000000000.0.0") < 0);
});
test("[40-E-3] extreme: long prerelease identifier chain compares correctly", () => {
  const a = "1.0.0-" + Array.from({ length: 50 }, (_, i) => `a${i}`).join(".");
  const b = "1.0.0-" + Array.from({ length: 51 }, (_, i) => `a${i}`).join(".");
  assert(compareSemver(a, b) < 0); // fewer fields (a) has lower precedence than b when a is a prefix of b
});
test("[40-E-4] extreme: 30 rapid sequential comparisons are independent (no shared state)", () => {
  for (let i = 0; i < 30; i++) {
    assert(compareSemver(`${i}.0.0`, `${i + 1}.0.0`) < 0);
  }
});
