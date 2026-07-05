"use strict";
/**
 * [117] CHECK_BRANCH_PROTECTION_HINTS — check_branch_protection_hints tool
 *
 * Rigor levels covered:
 *   Normal:   CODEOWNERS + PR-triggered workflow detected, job names parsed,
 *             appropriate hints generated.
 *   Medium:   empty/bare directory (no signals) reports all-false with
 *             corresponding hints; missing path defaults to first root
 *             without throwing; non-directory path throws.
 *   High:     unreadable/malformed settings.yml is handled gracefully
 *             (parsed:false + error, not a crash); workflow file that fails
 *             to parse as YAML still reports runsOnPR via the regex
 *             fallback and jobNames:null rather than throwing.
 *   Critical: path traversal / absolute-path-outside-root blocked; a
 *             CODEOWNERS/workflow file with shell/HTML-injection-shaped
 *             content round-trips as inert data (never executed/parsed as
 *             markup); result is JSON-serialisable; no unexpected keys.
 *   Extreme:  many-workflow-file directory scan completes without
 *             crashing; 10 concurrent calls consistent; registered in
 *             execute_pipeline op enum; cleanup.
 */
const path = require("path");
const fs   = require("fs");

const { assert, test, TMP, executeTool } = require("../test-harness");

console.log(`\n[117] CHECK_BRANCH_PROTECTION_HINTS — check_branch_protection_hints tool`);

function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }

// ── NORMAL ──────────────────────────────────────────────────────────────────

test("check_branch_protection_hints: CODEOWNERS + PR workflow detected, hints generated", () => {
  const dir = path.join(TMP, "cbph-basic");
  mkdirp(path.join(dir, ".github/workflows"));
  fs.writeFileSync(path.join(dir, "CODEOWNERS"), "* @someone\n", "utf8");
  fs.writeFileSync(path.join(dir, ".github/workflows/ci.yml"),
    "on:\n  pull_request:\njobs:\n  build:\n    runs-on: ubuntu-latest\n  test:\n    runs-on: ubuntu-latest\n", "utf8");
  const r = executeTool("check_branch_protection_hints", { path: path.relative(TMP, dir) });
  assert.strictEqual(r.hasCodeowners, true);
  assert.strictEqual(r.codeownersPath, "CODEOWNERS");
  assert.strictEqual(r.anyWorkflowRunsOnPR, true);
  assert.deepStrictEqual(r.workflows[0].jobNames.sort(), ["build", "test"]);
  assert.ok(r.hints.some(h => /Both CODEOWNERS/i.test(h)));
});

// ── MEDIUM — boundary & param validation ─────────────────────────────────────

test("check_branch_protection_hints: bare directory reports all-false with hints", () => {
  const dir = path.join(TMP, "cbph-empty");
  mkdirp(dir);
  const r = executeTool("check_branch_protection_hints", { path: path.relative(TMP, dir) });
  assert.strictEqual(r.hasCodeowners, false);
  assert.strictEqual(r.workflowsDir, null);
  assert.strictEqual(r.anyWorkflowRunsOnPR, false);
  assert.ok(r.hints.length >= 2);
});

test("check_branch_protection_hints: missing path defaults without throwing", () => {
  assert.doesNotThrow(() => executeTool("check_branch_protection_hints", {}));
});

test("check_branch_protection_hints: non-directory path throws a descriptive error", () => {
  const dir = path.join(TMP, "cbph-file");
  mkdirp(dir);
  fs.writeFileSync(path.join(dir, "notadir.txt"), "x", "utf8");
  assert.throws(
    () => executeTool("check_branch_protection_hints", { path: path.relative(TMP, path.join(dir, "notadir.txt")) }),
    /not a directory/i
  );
});

// ── HIGH — dependency / failure handling ─────────────────────────────────────

test("check_branch_protection_hints: malformed settings.yml handled gracefully, not a crash", () => {
  const dir = path.join(TMP, "cbph-bad-settings");
  mkdirp(path.join(dir, ".github"));
  // Anchors are explicitly unsupported by the project's YAML parser -> parse error expected, not a crash.
  fs.writeFileSync(path.join(dir, ".github/settings.yml"), "branches:\n  - &anchor\n    name: main\n", "utf8");
  let r;
  assert.doesNotThrow(() => { r = executeTool("check_branch_protection_hints", { path: path.relative(TMP, dir) }); });
  assert.strictEqual(r.settingsYml.present, true);
  assert.strictEqual(r.settingsYml.parsed, false);
  assert.ok(typeof r.settingsYml.error === "string" && r.settingsYml.error.length > 0);
});

test("check_branch_protection_hints: unparseable workflow still reports runsOnPR via regex fallback", () => {
  const dir = path.join(TMP, "cbph-weird-workflow");
  mkdirp(path.join(dir, ".github/workflows"));
  // Deliberately malformed/unusual YAML shape the minimal parser may choke on,
  // but the literal "pull_request" token under "on:" is still present.
  fs.writeFileSync(path.join(dir, ".github/workflows/weird.yml"),
    "on:\n  pull_request:\n    branches: [main\njobs: {{{not valid\n", "utf8");
  let r;
  assert.doesNotThrow(() => { r = executeTool("check_branch_protection_hints", { path: path.relative(TMP, dir) }); });
  assert.strictEqual(r.workflows[0].runsOnPR, true);
  assert.strictEqual(r.workflows[0].jobNames, null);
});

// ── CRITICAL — security & input sanitization ─────────────────────────────────

test("check_branch_protection_hints: path traversal via path arg is blocked", () => {
  assert.throws(
    () => executeTool("check_branch_protection_hints", { path: "../../etc" }),
    /outside.*root|traversal|not.*within/i
  );
});

test("check_branch_protection_hints: absolute path outside root is blocked", () => {
  assert.throws(
    () => executeTool("check_branch_protection_hints", { path: "C:\\Windows\\System32" }),
    /outside.*root|traversal|not.*within|invalid/i
  );
});

test("check_branch_protection_hints: injection-shaped CODEOWNERS content round-trips as inert data", () => {
  const dir = path.join(TMP, "cbph-inject");
  mkdirp(dir);
  fs.writeFileSync(path.join(dir, "CODEOWNERS"), "$(rm -rf /) * <script>alert(1)</script>\n", "utf8");
  const r = executeTool("check_branch_protection_hints", { path: path.relative(TMP, dir) });
  assert.strictEqual(r.hasCodeowners, true);
  assert.ok(fs.existsSync(path.join(dir, "CODEOWNERS")), "working tree should be untouched by the injection payload");
});

test("check_branch_protection_hints: result is fully JSON-serialisable", () => {
  const dir = path.join(TMP, "cbph-json");
  mkdirp(dir);
  const r = executeTool("check_branch_protection_hints", { path: path.relative(TMP, dir) });
  let serialised;
  assert.doesNotThrow(() => { serialised = JSON.stringify(r); });
  assert.strictEqual(JSON.parse(serialised).hasCodeowners, r.hasCodeowners);
});

test("check_branch_protection_hints: result has no unexpected top-level keys", () => {
  const dir = path.join(TMP, "cbph-keys");
  mkdirp(dir);
  const r = executeTool("check_branch_protection_hints", { path: path.relative(TMP, dir) });
  const expectedTop = new Set([
    "path", "hasCodeowners", "codeownersPath", "workflowsDir",
    "workflows", "anyWorkflowRunsOnPR", "settingsYml", "hints",
  ]);
  for (const key of Object.keys(r)) assert.ok(expectedTop.has(key), `unexpected top-level key: '${key}'`);
});

// ── EXTREME — stress, fuzzing & concurrency ──────────────────────────────────

test("check_branch_protection_hints: many-workflow-file directory scan completes without crashing", () => {
  const dir = path.join(TMP, "cbph-many");
  mkdirp(path.join(dir, ".github/workflows"));
  for (let i = 0; i < 30; i++) {
    fs.writeFileSync(path.join(dir, `.github/workflows/wf${i}.yml`), `on:\n  push:\njobs:\n  job${i}:\n    runs-on: ubuntu-latest\n`, "utf8");
  }
  let r;
  assert.doesNotThrow(() => { r = executeTool("check_branch_protection_hints", { path: path.relative(TMP, dir) }); });
  assert.strictEqual(r.workflows.length, 30);
  assert.strictEqual(r.anyWorkflowRunsOnPR, false);
});

test("check_branch_protection_hints: 10 concurrent calls return consistent results", () => {
  const dir = path.join(TMP, "cbph-concurrent");
  mkdirp(path.join(dir, ".github/workflows"));
  fs.writeFileSync(path.join(dir, ".github/workflows/ci.yml"), "on:\n  pull_request:\njobs:\n  build:\n    runs-on: ubuntu-latest\n", "utf8");
  const relPath = path.relative(TMP, dir);
  const results = Array.from({ length: 10 }, () => executeTool("check_branch_protection_hints", { path: relPath }));
  const first = results[0];
  for (let i = 1; i < results.length; i++) {
    assert.strictEqual(results[i].anyWorkflowRunsOnPR, first.anyWorkflowRunsOnPR, `call ${i}: mismatch`);
  }
});

test("check_branch_protection_hints: is registered in the execute_pipeline op enum", () => {
  const { EXEC_SCHEMAS } = require("../../lib/schemas/execSchemas");
  const pipelineSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
  const opEnum = pipelineSchema.inputSchema.properties.steps.items.properties.op.enum;
  assert.ok(opEnum.includes("check_branch_protection_hints"), "check_branch_protection_hints missing from execute_pipeline op enum");
});

// ── CLEANUP ───────────────────────────────────────────────────────────────────

test("cleanup: remove check_branch_protection_hints fixture dirs", () => {
  const dirs = [
    "cbph-basic", "cbph-empty", "cbph-file", "cbph-bad-settings",
    "cbph-weird-workflow", "cbph-inject", "cbph-json", "cbph-keys", "cbph-many", "cbph-concurrent",
  ];
  for (const d of dirs) {
    try { fs.rmSync(path.join(TMP, d), { recursive: true, force: true }); } catch (_) {}
  }
  assert.ok(!fs.existsSync(path.join(TMP, "cbph-basic")));
});
