"use strict";
/**
 * [119] GIT_SUBMODULE_STATUS — git_submodule_status tool
 *
 * Rigor levels covered:
 *   Normal:   repo with no .gitmodules reports hasGitmodules:false, empty
 *             arrays, not an error; repo with one added+initialized
 *             submodule reports in-sync status.
 *   Medium:   .gitmodules present but submodule not yet initialized reports
 *             status '-'/not-initialized; missing path resolves via the
 *             shared resolveRepoDir convention.
 *   High:     non-git directory throws a descriptive error; malformed
 *             .gitmodules (missing path key) doesn't crash, just yields a
 *             configured entry with path:null.
 *   Critical: path traversal / absolute-path-outside-root blocked; a
 *             submodule name/url containing shell/injection-shaped text
 *             round-trips as inert data; JSON-serialisable; no unexpected
 *             top-level keys.
 *   Extreme:  submodule whose checked-out commit diverges from the recorded
 *             one is flagged '+'/diverged; 10 concurrent calls consistent;
 *             execute_pipeline op-enum registration; cleanup.
 */
const path = require("path");
const fs   = require("fs");
const { execSync } = require("child_process");

const { assert, test, TMP, executeTool } = require("../test-harness");

console.log(`\n[119] GIT_SUBMODULE_STATUS — git_submodule_status tool`);

function gitIn(repoDir, cmd) {
  return execSync(`git ${cmd}`, {
    cwd: repoDir, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "Test User", GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test User", GIT_COMMITTER_EMAIL: "test@example.com" },
  });
}

function makeRepo(name) {
  const repoDir = path.join(TMP, name);
  fs.mkdirSync(repoDir, { recursive: true });
  gitIn(repoDir, "init -b main");
  gitIn(repoDir, "config user.email test@example.com");
  gitIn(repoDir, 'config user.name "Test User"');
  fs.writeFileSync(path.join(repoDir, "readme.txt"), "hello\n", "utf8");
  gitIn(repoDir, "add readme.txt");
  gitIn(repoDir, 'commit -m "initial commit"');
  return repoDir;
}

/** Add `subRepoDir` as a submodule of `superRepoDir` at `subPath`, using a
 * local filesystem path (no network) and `-c protocol.file.allow=always`
 * (modern git disables the `file://`-equivalent local-path protocol for
 * submodules by default as a security hardening measure). */
function addSubmodule(superRepoDir, subRepoDir, subPath) {
  gitIn(superRepoDir, `-c protocol.file.allow=always submodule add "${subRepoDir}" "${subPath}"`);
  gitIn(superRepoDir, 'commit -m "add submodule"');
}

// ── NORMAL ────────────────────────────────────────────────────────────────────

test("git_submodule_status: repo with no .gitmodules reports hasGitmodules:false", () => {
  const repoDir = makeRepo("gss-none");
  const r = executeTool("git_submodule_status", { path: path.relative(TMP, repoDir) });
  assert.strictEqual(r.hasGitmodules, false);
  assert.strictEqual(r.configuredCount, 0);
  assert.deepStrictEqual(r.configured, []);
  assert.strictEqual(r.statusCount, 0);
  assert.deepStrictEqual(r.submodules, []);
  assert.strictEqual(r.outOfSyncCount, 0);
});

test("git_submodule_status: initialized submodule reports in-sync status", () => {
  const subRepoDir = makeRepo("gss-basic-sub");
  const superRepoDir = makeRepo("gss-basic-super");
  addSubmodule(superRepoDir, subRepoDir, "vendor/sub");
  const r = executeTool("git_submodule_status", { path: path.relative(TMP, superRepoDir) });
  assert.strictEqual(r.hasGitmodules, true);
  assert.strictEqual(r.configuredCount, 1);
  assert.strictEqual(r.configured[0].path, "vendor/sub");
  assert.strictEqual(r.statusCount, 1);
  assert.strictEqual(r.submodules[0].status, " ");
  assert.strictEqual(r.submodules[0].statusMeaning, "in-sync");
  assert.strictEqual(r.outOfSyncCount, 0);
});

// ── MEDIUM — boundary & param validation ─────────────────────────────────────

test("git_submodule_status: deinitialized submodule reports not-initialized status", () => {
  const subRepoDir = makeRepo("gss-deinit-sub");
  const superRepoDir = makeRepo("gss-deinit-super");
  addSubmodule(superRepoDir, subRepoDir, "vendor/sub");
  gitIn(superRepoDir, "submodule deinit -f vendor/sub");
  const r = executeTool("git_submodule_status", { path: path.relative(TMP, superRepoDir) });
  assert.strictEqual(r.submodules[0].status, "-");
  assert.strictEqual(r.submodules[0].statusMeaning, "not-initialized");
  assert.strictEqual(r.outOfSyncCount, 1);
});

test("git_submodule_status: missing path resolves via the shared resolveRepoDir convention (clean error if it throws)", () => {
  try {
    executeTool("git_submodule_status", {});
  } catch (e) {
    assert.ok(e instanceof Error, "must throw a clean Error, not crash the process");
  }
});

// ── HIGH — dependency / failure handling ─────────────────────────────────────

test("git_submodule_status: non-git directory throws a descriptive error", () => {
  const notGit = path.join(TMP, "gss-not-git");
  fs.mkdirSync(notGit, { recursive: true });
  fs.writeFileSync(path.join(notGit, "file.txt"), "hello", "utf8");
  assert.throws(
    () => executeTool("git_submodule_status", { path: path.relative(TMP, notGit) }),
    /not a git repository/i
  );
});

test("git_submodule_status: .gitmodules entry missing a path key doesn't crash, path is null", () => {
  const repoDir = makeRepo("gss-malformed");
  fs.writeFileSync(path.join(repoDir, ".gitmodules"), '[submodule "orphan"]\n\turl = /nowhere\n', "utf8");
  let r;
  assert.doesNotThrow(() => { r = executeTool("git_submodule_status", { path: path.relative(TMP, repoDir) }); });
  assert.strictEqual(r.hasGitmodules, true);
  assert.strictEqual(r.configured[0].path, null);
  assert.strictEqual(r.configured[0].url, "/nowhere");
});

// ── CRITICAL — security & input sanitization ─────────────────────────────────

test("git_submodule_status: path traversal via path arg is blocked", () => {
  assert.throws(
    () => executeTool("git_submodule_status", { path: "../../etc" }),
    /outside.*root|traversal|not.*within/i
  );
});

test("git_submodule_status: absolute path outside root is blocked", () => {
  assert.throws(
    () => executeTool("git_submodule_status", { path: "C:\\Windows\\System32" }),
    /outside.*root|traversal|not.*within|invalid/i
  );
});

test("git_submodule_status: injection-shaped .gitmodules content round-trips as inert data", () => {
  const repoDir = makeRepo("gss-inject");
  fs.writeFileSync(
    path.join(repoDir, ".gitmodules"),
    '[submodule "$(rm -rf /)"]\n\tpath = vendor/x\n\turl = https://example.com/x.git; rm -rf /\n',
    "utf8"
  );
  const r = executeTool("git_submodule_status", { path: path.relative(TMP, repoDir) });
  assert.strictEqual(r.configured[0].name, "$(rm -rf /)");
  assert.ok(fs.existsSync(path.join(repoDir, "readme.txt")), "working tree should be untouched by the injection payload");
});

test("git_submodule_status: result is fully JSON-serialisable", () => {
  const repoDir = makeRepo("gss-json");
  const r = executeTool("git_submodule_status", { path: path.relative(TMP, repoDir) });
  let serialised;
  assert.doesNotThrow(() => { serialised = JSON.stringify(r); });
  assert.strictEqual(JSON.parse(serialised).hasGitmodules, r.hasGitmodules);
});

test("git_submodule_status: result has no unexpected top-level keys", () => {
  const repoDir = makeRepo("gss-keys");
  const r = executeTool("git_submodule_status", { path: path.relative(TMP, repoDir) });
  const expected = new Set([
    "hasGitmodules", "configuredCount", "configured",
    "statusCount", "submodules", "outOfSyncCount",
  ]);
  for (const key of Object.keys(r)) assert.ok(expected.has(key), `unexpected top-level key: '${key}'`);
});

// ── EXTREME — stress, fuzzing & concurrency ──────────────────────────────────

test("git_submodule_status: diverged submodule (checked-out commit differs) flagged '+'/diverged", () => {
  const subRepoDir = makeRepo("gss-diverge-sub");
  const superRepoDir = makeRepo("gss-diverge-super");
  addSubmodule(superRepoDir, subRepoDir, "vendor/sub");
  // Make a new commit inside the checked-out submodule without updating the
  // superproject's recorded pointer -> checked-out commit now differs.
  const subInSuper = path.join(superRepoDir, "vendor", "sub");
  fs.writeFileSync(path.join(subInSuper, "extra.txt"), "more\n", "utf8");
  gitIn(subInSuper, "add extra.txt");
  gitIn(subInSuper, 'commit -m "extra commit not recorded by superproject"');
  const r = executeTool("git_submodule_status", { path: path.relative(TMP, superRepoDir) });
  assert.strictEqual(r.submodules[0].status, "+");
  assert.strictEqual(r.submodules[0].statusMeaning, "diverged");
  assert.strictEqual(r.outOfSyncCount, 1);
});

test("git_submodule_status: 10 concurrent calls return consistent results", () => {
  const subRepoDir = makeRepo("gss-concurrent-sub");
  const superRepoDir = makeRepo("gss-concurrent-super");
  addSubmodule(superRepoDir, subRepoDir, "vendor/sub");
  const relPath = path.relative(TMP, superRepoDir);
  const results = Array.from({ length: 10 }, () => executeTool("git_submodule_status", { path: relPath }));
  const first = results[0];
  for (let i = 1; i < results.length; i++) {
    assert.strictEqual(results[i].outOfSyncCount, first.outOfSyncCount, `call ${i}: mismatch`);
  }
});

test("git_submodule_status: is registered in the execute_pipeline op enum", () => {
  const { EXEC_SCHEMAS } = require("../../lib/schemas/execSchemas");
  const pipelineSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
  const opEnum = pipelineSchema.inputSchema.properties.steps.items.properties.op.enum;
  assert.ok(opEnum.includes("git_submodule_status"), "git_submodule_status missing from execute_pipeline op enum");
});

// ── CLEANUP ───────────────────────────────────────────────────────────────────

test("cleanup: remove git_submodule_status fixture repos", () => {
  const dirs = [
    "gss-none", "gss-basic-sub", "gss-basic-super", "gss-deinit-sub", "gss-deinit-super",
    "gss-not-git", "gss-malformed", "gss-inject", "gss-json", "gss-keys",
    "gss-diverge-sub", "gss-diverge-super", "gss-concurrent-sub", "gss-concurrent-super",
  ];
  for (const d of dirs) {
    try { fs.rmSync(path.join(TMP, d), { recursive: true, force: true }); } catch (_) {}
  }
  assert.ok(!fs.existsSync(path.join(TMP, "gss-none")));
});
