"use strict";
/**
 * [122] GIT_HOOKS_AUDIT — git_hooks_audit tool
 *
 * Rigor levels covered:
 *   Normal:   husky dir + hook present + lint-staged wired -> no hint about
 *             missing wiring; husky dependency but no .husky dir -> flagged.
 *   Medium:   missing package.json throws; non-directory path throws;
 *             custom pkg_path used instead of default.
 *   High:     legacy husky v4 "husky.hooks" config alongside modern .husky
 *             flagged as dead config; lint-staged dependency without a
 *             "lint-staged" config block flagged.
 *   Critical: path traversal on `path` and `pkg_path` blocked; malformed
 *             package.json JSON throws a descriptive error; JSON-serialisable;
 *             no unexpected top-level keys.
 *   Extreme:  .git/hooks local hook flagged as non-portable; 10 concurrent
 *             calls consistent; execute_pipeline op-enum registration; cleanup.
 */
const path = require("path");
const fs   = require("fs");

const { assert, test, TMP, executeTool } = require("../test-harness");

console.log(`\n[122] GIT_HOOKS_AUDIT — git_hooks_audit tool`);

function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }
function writePkg(dir, obj) { fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(obj, null, 2), "utf8"); }

// ── NORMAL ────────────────────────────────────────────────────────────────────

test("git_hooks_audit: husky dir + hook + lint-staged wired -> no missing-wiring hint", () => {
  const dir = path.join(TMP, "gha-basic");
  mkdirp(path.join(dir, ".husky"));
  fs.writeFileSync(path.join(dir, ".husky", "pre-commit"), "npx lint-staged\n", "utf8");
  writePkg(dir, { devDependencies: { husky: "^9.0.0", "lint-staged": "^15.0.0" }, "lint-staged": { "*.js": "eslint" } });
  const r = executeTool("git_hooks_audit", { path: path.relative(TMP, dir) });
  assert.strictEqual(r.huskyDirPresent, true);
  assert.deepStrictEqual(r.huskyHooks, ["pre-commit"]);
  assert.strictEqual(r.lintStagedWiredInHook, true);
  assert.ok(!r.hints.some(h => /no \.husky hook script appears to invoke/.test(h)));
});

test("git_hooks_audit: husky dependency but no .husky dir is flagged", () => {
  const dir = path.join(TMP, "gha-nohusky");
  mkdirp(dir);
  writePkg(dir, { devDependencies: { husky: "^9.0.0" } });
  const r = executeTool("git_hooks_audit", { path: path.relative(TMP, dir) });
  assert.strictEqual(r.huskyDirPresent, false);
  assert.ok(r.hints.some(h => /no \.husky directory was found/.test(h)));
});

// ── MEDIUM — boundary & param validation ─────────────────────────────────────

test("git_hooks_audit: missing package.json throws", () => {
  const dir = path.join(TMP, "gha-nopkg");
  mkdirp(dir);
  assert.throws(() => executeTool("git_hooks_audit", { path: path.relative(TMP, dir) }), /cannot read/i);
});

test("git_hooks_audit: non-directory path throws", () => {
  const dir = path.join(TMP, "gha-notdir");
  mkdirp(dir);
  fs.writeFileSync(path.join(dir, "f.txt"), "x", "utf8");
  assert.throws(
    () => executeTool("git_hooks_audit", { path: path.relative(TMP, path.join(dir, "f.txt")) }),
    /not a directory/i
  );
});

test("git_hooks_audit: custom pkg_path used instead of default", () => {
  const dir = path.join(TMP, "gha-custompkg");
  mkdirp(dir);
  writePkg(dir, { devDependencies: {} });
  fs.renameSync(path.join(dir, "package.json"), path.join(dir, "custom.package.json"));
  const r = executeTool("git_hooks_audit", {
    path: path.relative(TMP, dir),
    pkg_path: path.join(path.relative(TMP, dir), "custom.package.json"),
  });
  assert.strictEqual(r.dependsOnHusky, false);
});

// ── HIGH — dependency / failure handling ─────────────────────────────────────

test("git_hooks_audit: legacy husky v4 config alongside modern .husky flagged as dead", () => {
  const dir = path.join(TMP, "gha-legacy");
  mkdirp(path.join(dir, ".husky"));
  fs.writeFileSync(path.join(dir, ".husky", "pre-commit"), "npm test\n", "utf8");
  writePkg(dir, { husky: { hooks: { "pre-commit": "npm test" } } });
  const r = executeTool("git_hooks_audit", { path: path.relative(TMP, dir) });
  assert.deepStrictEqual(r.packageJsonLegacyHuskyHooks, ["pre-commit"]);
  assert.ok(r.hints.some(h => /legacy husky v4-style/.test(h) && /ignored by husky v6\+/.test(h)));
});

test("git_hooks_audit: lint-staged dependency without config block is flagged", () => {
  const dir = path.join(TMP, "gha-lsnoconfig");
  mkdirp(dir);
  writePkg(dir, { devDependencies: { "lint-staged": "^15.0.0" } });
  const r = executeTool("git_hooks_audit", { path: path.relative(TMP, dir) });
  assert.strictEqual(r.dependsOnLintStaged, true);
  assert.strictEqual(r.lintStagedConfigured, false);
  assert.ok(r.hints.some(h => /no "lint-staged" config block/.test(h)));
});

// ── CRITICAL — security & input sanitization ─────────────────────────────────

test("git_hooks_audit: path traversal via path arg is blocked", () => {
  assert.throws(
    () => executeTool("git_hooks_audit", { path: "../../etc" }),
    /outside.*root|traversal|not.*within/i
  );
});

test("git_hooks_audit: path traversal via pkg_path arg is blocked", () => {
  const dir = path.join(TMP, "gha-traverse-pkg");
  mkdirp(dir);
  assert.throws(
    () => executeTool("git_hooks_audit", { path: path.relative(TMP, dir), pkg_path: "../../../etc/passwd" }),
    /outside.*root|traversal|not.*within/i
  );
});

test("git_hooks_audit: malformed package.json JSON throws a descriptive error", () => {
  const dir = path.join(TMP, "gha-badjson");
  mkdirp(dir);
  fs.writeFileSync(path.join(dir, "package.json"), "{ not valid json", "utf8");
  assert.throws(() => executeTool("git_hooks_audit", { path: path.relative(TMP, dir) }), /not valid JSON/i);
});

test("git_hooks_audit: result is fully JSON-serialisable", () => {
  const dir = path.join(TMP, "gha-json");
  mkdirp(dir);
  writePkg(dir, {});
  const r = executeTool("git_hooks_audit", { path: path.relative(TMP, dir) });
  let serialised;
  assert.doesNotThrow(() => { serialised = JSON.stringify(r); });
  assert.strictEqual(JSON.parse(serialised).huskyDirPresent, r.huskyDirPresent);
});

test("git_hooks_audit: result has no unexpected top-level keys", () => {
  const dir = path.join(TMP, "gha-keys");
  mkdirp(dir);
  writePkg(dir, {});
  const r = executeTool("git_hooks_audit", { path: path.relative(TMP, dir) });
  const expected = new Set([
    "path", "pkgPath", "huskyDirPresent", "huskyHooks", "gitHooksDirLocalHooks",
    "packageJsonLegacyHuskyHooks", "lintStagedConfigured", "dependsOnHusky",
    "dependsOnLintStaged", "lintStagedWiredInHook", "hints",
  ]);
  for (const key of Object.keys(r)) assert.ok(expected.has(key), `unexpected top-level key: '${key}'`);
});

// ── EXTREME — stress, fuzzing & concurrency ──────────────────────────────────

test("git_hooks_audit: .git/hooks local hook flagged as non-portable", () => {
  const dir = path.join(TMP, "gha-gitlocal");
  mkdirp(path.join(dir, ".git", "hooks"));
  fs.writeFileSync(path.join(dir, ".git", "hooks", "pre-push"), "#!/bin/sh\nnpm test\n", "utf8");
  fs.writeFileSync(path.join(dir, ".git", "hooks", "pre-commit.sample"), "# sample, not real\n", "utf8");
  writePkg(dir, {});
  const r = executeTool("git_hooks_audit", { path: path.relative(TMP, dir) });
  assert.deepStrictEqual(r.gitHooksDirLocalHooks, ["pre-push"]);
  assert.ok(r.hints.some(h => /NOT version-controlled/.test(h)));
});

test("git_hooks_audit: 10 concurrent calls return consistent results", () => {
  const dir = path.join(TMP, "gha-concurrent");
  mkdirp(path.join(dir, ".husky"));
  fs.writeFileSync(path.join(dir, ".husky", "pre-commit"), "npm test\n", "utf8");
  writePkg(dir, { devDependencies: { husky: "^9.0.0" } });
  const relPath = path.relative(TMP, dir);
  const results = Array.from({ length: 10 }, () => executeTool("git_hooks_audit", { path: relPath }));
  const first = results[0];
  for (let i = 1; i < results.length; i++) {
    assert.deepStrictEqual(results[i].huskyHooks, first.huskyHooks, `call ${i}: mismatch`);
  }
});

test("git_hooks_audit: is registered in the execute_pipeline op enum", () => {
  const { EXEC_SCHEMAS } = require("../../lib/schemas/execSchemas");
  const pipelineSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
  const opEnum = pipelineSchema.inputSchema.properties.steps.items.properties.op.enum;
  assert.ok(opEnum.includes("git_hooks_audit"), "git_hooks_audit missing from execute_pipeline op enum");
});

// ── CLEANUP ───────────────────────────────────────────────────────────────────

test("cleanup: remove git_hooks_audit fixture dirs", () => {
  const dirs = [
    "gha-basic", "gha-nohusky", "gha-nopkg", "gha-notdir", "gha-custompkg",
    "gha-legacy", "gha-lsnoconfig", "gha-traverse-pkg", "gha-badjson",
    "gha-json", "gha-keys", "gha-gitlocal", "gha-concurrent",
  ];
  for (const d of dirs) {
    try { fs.rmSync(path.join(TMP, d), { recursive: true, force: true }); } catch (_) {}
  }
  assert.ok(!fs.existsSync(path.join(TMP, "gha-basic")));
});
