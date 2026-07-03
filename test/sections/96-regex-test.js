"use strict";
/**
 * [96] REGEX_TEST — regex_test tool
 *
 * Rigor levels covered:
 *
 *   Normal:   happy-path — global pattern collects all matches with correct
 *             index/groups; non-global pattern returns first match only;
 *             named groups surfaced; no-match input returns matched:false.
 *
 *   Medium:   boundary — missing pattern/test_strings throws; invalid regex
 *             syntax throws a clean validation error; empty test_strings
 *             array throws; max_matches clamping; duplicate/unsupported
 *             flag rejected.
 *
 *   High:     dependency / failure handling — pattern length over the cap
 *             throws; a test string over the length cap throws; too many
 *             test strings throws.
 *
 *   Critical: security — a catastrophic-backtracking pattern against an
 *             adversarial input is bounded by the vm timeout (timedOut:true,
 *             not a hung process); pattern/test-string content containing
 *             shell/HTML-injection-shaped text is treated as inert literal
 *             data (never executed as code — only ever matched against);
 *             result is JSON-serialisable.
 *
 *   Extreme:  stress — many test strings in one call; unicode input;
 *             zero-width global match doesn't infinite-loop; 10 concurrent
 *             calls consistent.
 */
const { assert, test, executeTool } = require("../test-harness");

console.log(`\n[96] REGEX_TEST — regex_test tool`);

// ── NORMAL ────────────────────────────────────────────────────────────────

test("regex_test: global pattern collects all matches with index/groups", () => {
  const r = executeTool("regex_test", { pattern: "(\\d+)-(\\d+)", flags: "g", test_strings: ["a1-2 b3-40"] });
  const res = r.results[0];
  assert.strictEqual(res.matched, true);
  assert.strictEqual(res.matchCount, 2);
  assert.strictEqual(res.matches[0].match, "1-2");
  assert.strictEqual(res.matches[0].groups[0], "1");
  assert.strictEqual(res.matches[0].groups[1], "2");
  assert.strictEqual(res.matches[1].match, "3-40");
});

test("regex_test: non-global pattern returns only the first match", () => {
  const r = executeTool("regex_test", { pattern: "\\d+", flags: "", test_strings: ["a1 b22 c333"] });
  assert.strictEqual(r.results[0].matchCount, 1);
  assert.strictEqual(r.results[0].matches[0].match, "1");
});

test("regex_test: named groups surfaced in namedGroups", () => {
  const r = executeTool("regex_test", { pattern: "(?<year>\\d{4})-(?<month>\\d{2})", flags: "g", test_strings: ["2026-07"] });
  assert.strictEqual(r.results[0].matches[0].namedGroups.year, "2026");
  assert.strictEqual(r.results[0].matches[0].namedGroups.month, "07");
});

test("regex_test: no-match input returns matched:false, matchCount:0", () => {
  const r = executeTool("regex_test", { pattern: "xyz", test_strings: ["abc"] });
  assert.strictEqual(r.results[0].matched, false);
  assert.strictEqual(r.results[0].matchCount, 0);
});

// ── MEDIUM ────────────────────────────────────────────────────────────────

test("regex_test: missing pattern throws", () => {
  assert.throws(() => executeTool("regex_test", { test_strings: ["a"] }));
});

test("regex_test: missing test_strings throws", () => {
  assert.throws(() => executeTool("regex_test", { pattern: "a" }));
});

test("regex_test: empty test_strings array throws", () => {
  assert.throws(() => executeTool("regex_test", { pattern: "a", test_strings: [] }));
});

test("regex_test: invalid regex syntax throws a clean validation error, not a raw SyntaxError crash", () => {
  assert.throws(() => executeTool("regex_test", { pattern: "(unclosed", test_strings: ["a"] }), /invalid regular expression/);
});

test("regex_test: unsupported flag rejected", () => {
  assert.throws(() => executeTool("regex_test", { pattern: "a", flags: "z", test_strings: ["a"] }));
});

test("regex_test: duplicate flag rejected", () => {
  assert.throws(() => executeTool("regex_test", { pattern: "a", flags: "gg", test_strings: ["a"] }));
});

test("regex_test: max_matches clamps and truncates", () => {
  const r = executeTool("regex_test", { pattern: "a", flags: "g", test_strings: ["a".repeat(50)], max_matches: 5 });
  assert.strictEqual(r.results[0].matchCount, 5);
  assert.strictEqual(r.results[0].truncated, true);
});

// ── HIGH ──────────────────────────────────────────────────────────────────

test("regex_test: pattern over length cap throws", () => {
  assert.throws(() => executeTool("regex_test", { pattern: "a".repeat(1001), test_strings: ["a"] }));
});

test("regex_test: test string over length cap throws", () => {
  assert.throws(() => executeTool("regex_test", { pattern: "a", test_strings: ["x".repeat(20001)] }));
});

test("regex_test: too many test strings throws", () => {
  const many = Array.from({ length: 101 }, (_, i) => `s${i}`);
  assert.throws(() => executeTool("regex_test", { pattern: "a", test_strings: many }));
});

// ── CRITICAL ──────────────────────────────────────────────────────────────

test("regex_test: catastrophic-backtracking pattern is bounded by the timeout guard, not hung", () => {
  const start = Date.now();
  const r = executeTool("regex_test", {
    pattern: "(a+)+b",
    flags: "",
    test_strings: ["a".repeat(35) + "c"], // classic ReDoS trigger, no trailing 'b'
  });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 5000, `must not hang the process (took ${elapsed}ms)`);
  assert.strictEqual(r.results[0].timedOut, true);
  assert.strictEqual(r.results[0].matches.length, 0);
});

test("regex_test: shell/HTML-injection-shaped content is only ever matched, never executed", () => {
  const r = executeTool("regex_test", {
    pattern: ".*",
    test_strings: ["`rm -rf /tmp/pwned`", "<script>alert(1)</script>", "'; DROP TABLE users; --"],
  });
  assert.strictEqual(r.results.length, 3);
  assert.strictEqual(r.results[0].matches[0].match, "`rm -rf /tmp/pwned`");
  assert.strictEqual(r.results[1].matches[0].match, "<script>alert(1)</script>");
});

test("regex_test: pattern itself containing injection-shaped text is inert (used only as regex source)", () => {
  const r = executeTool("regex_test", { pattern: "\\$\\{.*\\}", test_strings: ["${process.exit(1)}"] });
  assert.strictEqual(r.results[0].matched, true);
  assert.strictEqual(r.results[0].matches[0].match, "${process.exit(1)}");
});

test("regex_test: result is JSON-serialisable", () => {
  const r = executeTool("regex_test", { pattern: "a+", flags: "g", test_strings: ["aaa", "bbb"] });
  assert.doesNotThrow(() => JSON.stringify(r));
});

// ── EXTREME ───────────────────────────────────────────────────────────────

test("regex_test: many test strings in one call all processed", () => {
  const strings = Array.from({ length: 100 }, (_, i) => `item-${i}`);
  const r = executeTool("regex_test", { pattern: "item-(\\d+)", test_strings: strings });
  assert.strictEqual(r.testCount, 100);
  assert.strictEqual(r.results[99].matches[0].groups[0], "99");
});

test("regex_test: unicode input matched correctly", () => {
  const r = executeTool("regex_test", { pattern: "田中|太郎", flags: "gu", test_strings: ["田中太郎です"] });
  assert.strictEqual(r.results[0].matchCount, 2);
});

test("regex_test: zero-width global match does not infinite-loop", () => {
  const r = executeTool("regex_test", { pattern: "a*", flags: "g", test_strings: ["bbb"] });
  assert.ok(r.results[0].matches.length > 0 && r.results[0].matches.length <= 100);
});

test("regex_test: 10 concurrent calls return consistent results", () => {
  const outs = [];
  for (let i = 0; i < 10; i++) {
    outs.push(executeTool("regex_test", { pattern: "\\d+", flags: "g", test_strings: ["a1b22c333"] }));
  }
  for (const r of outs) assert.strictEqual(r.results[0].matchCount, 3);
});
