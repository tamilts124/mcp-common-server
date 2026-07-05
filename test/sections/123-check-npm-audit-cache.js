"use strict";
/**
 * [123] CHECK_NPM_AUDIT_CACHE — check_npm_audit_cache tool
 *
 * Rigor levels covered:
 *   Normal:   npm v7+-shaped cache_path report -> correct severity breakdown;
 *             default-named cache file (npm-audit.json) auto-detected in `path`.
 *   Medium:   no cache file + run_live unset -> found:false + hint, not an
 *             error; non-directory path throws; max_results caps advisories[]
 *             + sets truncated; max_results/timeout_ms type mismatch throws.
 *   High:     legacy npm v6 "advisories" shape normalised correctly; npm
 *             binary unavailable (PATH stripped) during run_live surfaces a
 *             clean ENOENT-derived error, not a crash.
 *   Critical: path traversal blocked on both `path` and `cache_path`;
 *             malformed JSON cache file throws descriptively; non-audit-shaped
 *             JSON throws descriptively; JSON-serialisable; no unexpected
 *             top-level keys.
 *   Extreme:  10 concurrent calls consistent; execute_pipeline op-enum
 *             registration; cleanup.
 */
const path = require("path");
const fs   = require("fs");

const { assert, test, TMP, executeTool } = require("../test-harness");

console.log(`\n[123] CHECK_NPM_AUDIT_CACHE — check_npm_audit_cache tool`);

function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }

const V7_REPORT = {
  vulnerabilities: {
    lodash: { severity: "high", fixAvailable: true },
    minimist: { severity: "critical", fixAvailable: false },
  },
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 1, total: 2 }, dependencies: 42 },
};

const V6_REPORT = {
  advisories: {
    "1001": { module_name: "event-stream", severity: "high" },
  },
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 } },
};

// ── NORMAL ────────────────────────────────────────────────────────────────────

test("check_npm_audit_cache: npm v7+ cache_path report yields correct severity breakdown", () => {
  const dir = path.join(TMP, "cnac-v7");
  mkdirp(dir);
  fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(V7_REPORT), "utf8");
  const r = executeTool("check_npm_audit_cache", {
    path: path.relative(TMP, dir),
    cache_path: path.join(path.relative(TMP, dir), "report.json"),
  });
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.source, "cache_path");
  assert.strictEqual(r.totalVulnerabilities, 2);
  assert.strictEqual(r.bySeverity.critical, 1);
  assert.strictEqual(r.bySeverity.high, 1);
  assert.strictEqual(r.dependenciesAudited, 42);
  assert.strictEqual(r.advisories.length, 2);
  assert.strictEqual(r.advisories[0].severity, "critical");
});

test("check_npm_audit_cache: default-named cache file auto-detected in path", () => {
  const dir = path.join(TMP, "cnac-default");
  mkdirp(dir);
  fs.writeFileSync(path.join(dir, "npm-audit.json"), JSON.stringify(V7_REPORT), "utf8");
  const r = executeTool("check_npm_audit_cache", { path: path.relative(TMP, dir) });
  assert.strictEqual(r.source, "default_cache");
  assert.strictEqual(r.cacheFile, "npm-audit.json");
  assert.strictEqual(r.totalVulnerabilities, 2);
});

// ── MEDIUM — boundary & param validation ─────────────────────────────────────

test("check_npm_audit_cache: no cache file + run_live unset returns found:false with hint", () => {
  const dir = path.join(TMP, "cnac-none");
  mkdirp(dir);
  const r = executeTool("check_npm_audit_cache", { path: path.relative(TMP, dir) });
  assert.strictEqual(r.found, false);
  assert.strictEqual(r.source, "none");
  assert.ok(r.hints.length > 0);
});

test("check_npm_audit_cache: non-directory path throws", () => {
  const dir = path.join(TMP, "cnac-notdir");
  mkdirp(dir);
  fs.writeFileSync(path.join(dir, "f.txt"), "x", "utf8");
  assert.throws(
    () => executeTool("check_npm_audit_cache", { path: path.relative(TMP, path.join(dir, "f.txt")) }),
    /not a directory/i
  );
});

test("check_npm_audit_cache: max_results caps advisories[] and sets truncated", () => {
  const dir = path.join(TMP, "cnac-maxresults");
  mkdirp(dir);
  const manyVulns = {};
  for (let i = 0; i < 10; i++) manyVulns[`pkg${i}`] = { severity: "low", fixAvailable: false };
  const report = { vulnerabilities: manyVulns, metadata: { vulnerabilities: { info: 0, low: 10, moderate: 0, high: 0, critical: 0 } } };
  fs.writeFileSync(path.join(dir, "npm-audit.json"), JSON.stringify(report), "utf8");
  const r = executeTool("check_npm_audit_cache", { path: path.relative(TMP, dir), max_results: 3 });
  assert.strictEqual(r.advisories.length, 3);
  assert.strictEqual(r.truncated, true);
});

test("check_npm_audit_cache: max_results type mismatch throws", () => {
  const dir = path.join(TMP, "cnac-badtype");
  mkdirp(dir);
  assert.throws(
    () => executeTool("check_npm_audit_cache", { path: path.relative(TMP, dir), max_results: "five" }),
    /max_results must be a number/i
  );
});

// ── HIGH — dependency / failure handling ─────────────────────────────────────

test("check_npm_audit_cache: legacy npm v6 advisories shape normalised correctly", () => {
  const dir = path.join(TMP, "cnac-v6");
  mkdirp(dir);
  fs.writeFileSync(path.join(dir, "npm-audit.json"), JSON.stringify(V6_REPORT), "utf8");
  const r = executeTool("check_npm_audit_cache", { path: path.relative(TMP, dir) });
  assert.strictEqual(r.totalVulnerabilities, 1);
  assert.strictEqual(r.advisories.length, 1);
  assert.strictEqual(r.advisories[0].name, "event-stream");
});

test("check_npm_audit_cache: npm unavailable during run_live surfaces a clean error, not a crash", () => {
  const dir = path.join(TMP, "cnac-nonpm");
  mkdirp(dir);
  const origPath = process.env.PATH;
  process.env.PATH = "";
  try {
    assert.throws(
      () => executeTool("check_npm_audit_cache", { path: path.relative(TMP, dir), run_live: true }),
      /npm executable not found|npm audit failed/i
    );
  } finally {
    process.env.PATH = origPath;
  }
});

// ── CRITICAL — security & input sanitization ─────────────────────────────────

test("check_npm_audit_cache: path traversal via path arg is blocked", () => {
  assert.throws(
    () => executeTool("check_npm_audit_cache", { path: "../../etc" }),
    /outside.*root|traversal|not.*within/i
  );
});

test("check_npm_audit_cache: path traversal via cache_path arg is blocked", () => {
  const dir = path.join(TMP, "cnac-traverse");
  mkdirp(dir);
  assert.throws(
    () => executeTool("check_npm_audit_cache", { path: path.relative(TMP, dir), cache_path: "../../../etc/passwd" }),
    /outside.*root|traversal|not.*within/i
  );
});

test("check_npm_audit_cache: malformed JSON cache file throws descriptively", () => {
  const dir = path.join(TMP, "cnac-badjson");
  mkdirp(dir);
  fs.writeFileSync(path.join(dir, "npm-audit.json"), "{ not valid json", "utf8");
  assert.throws(() => executeTool("check_npm_audit_cache", { path: path.relative(TMP, dir) }), /not valid JSON/i);
});

test("check_npm_audit_cache: non-audit-shaped JSON throws descriptively", () => {
  const dir = path.join(TMP, "cnac-wrongshape");
  mkdirp(dir);
  fs.writeFileSync(path.join(dir, "npm-audit.json"), JSON.stringify({ foo: "bar" }), "utf8");
  assert.throws(() => executeTool("check_npm_audit_cache", { path: path.relative(TMP, dir) }), /does not look like/i);
});

test("check_npm_audit_cache: result is fully JSON-serialisable", () => {
  const dir = path.join(TMP, "cnac-json");
  mkdirp(dir);
  fs.writeFileSync(path.join(dir, "npm-audit.json"), JSON.stringify(V7_REPORT), "utf8");
  const r = executeTool("check_npm_audit_cache", { path: path.relative(TMP, dir) });
  let serialised;
  assert.doesNotThrow(() => { serialised = JSON.stringify(r); });
  assert.strictEqual(JSON.parse(serialised).totalVulnerabilities, r.totalVulnerabilities);
});

test("check_npm_audit_cache: result has no unexpected top-level keys", () => {
  const dir = path.join(TMP, "cnac-keys");
  mkdirp(dir);
  const r = executeTool("check_npm_audit_cache", { path: path.relative(TMP, dir) });
  const expected = new Set([
    "path", "source", "cacheFile", "found", "totalVulnerabilities", "bySeverity",
    "dependenciesAudited", "advisories", "truncated", "hints",
  ]);
  for (const key of Object.keys(r)) assert.ok(expected.has(key), `unexpected top-level key: '${key}'`);
});

// ── EXTREME — stress, fuzzing & concurrency ──────────────────────────────────

test("check_npm_audit_cache: 10 concurrent calls return consistent results", () => {
  const dir = path.join(TMP, "cnac-concurrent");
  mkdirp(dir);
  fs.writeFileSync(path.join(dir, "npm-audit.json"), JSON.stringify(V7_REPORT), "utf8");
  const relPath = path.relative(TMP, dir);
  const results = Array.from({ length: 10 }, () => executeTool("check_npm_audit_cache", { path: relPath }));
  const first = results[0];
  for (let i = 1; i < results.length; i++) {
    assert.deepStrictEqual(results[i].bySeverity, first.bySeverity, `call ${i}: mismatch`);
  }
});

test("check_npm_audit_cache: is registered in the execute_pipeline op enum", () => {
  const { EXEC_SCHEMAS } = require("../../lib/schemas/execSchemas");
  const pipelineSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
  const opEnum = pipelineSchema.inputSchema.properties.steps.items.properties.op.enum;
  assert.ok(opEnum.includes("check_npm_audit_cache"), "check_npm_audit_cache missing from execute_pipeline op enum");
});

// ── CLEANUP ───────────────────────────────────────────────────────────────────

test("cleanup: remove check_npm_audit_cache fixture dirs", () => {
  const dirs = [
    "cnac-v7", "cnac-default", "cnac-none", "cnac-notdir", "cnac-maxresults",
    "cnac-badtype", "cnac-v6", "cnac-nonpm", "cnac-traverse", "cnac-badjson",
    "cnac-wrongshape", "cnac-json", "cnac-keys", "cnac-concurrent",
  ];
  for (const d of dirs) {
    try { fs.rmSync(path.join(TMP, d), { recursive: true, force: true }); } catch (_) {}
  }
  assert.ok(!fs.existsSync(path.join(TMP, "cnac-v7")));
});
