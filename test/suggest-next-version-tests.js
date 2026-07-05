"use strict";
// Standalone test script for suggest_next_version (not added to the
// frozen test/run-tests.js — new tool areas get their own script per the
// testing-strategy pivot documented in task.md).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok - ${name}`); passed++; }
  catch (e) { console.log(`  FAIL - ${name}\n    ${e.message}`); failed++; }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "next-version-"));
process.env.MCP_ROOTS = TMP;
process.env.MCP_ALLOW_EXEC = "true";
process.env.MCP_READ_ONLY = "false";
const { buildRoots } = require("../lib/roots");
buildRoots();
const { executeTool } = require("../lib/executeTool");
const { suggestNextVersion } = require("../lib/nextVersionOps");

function git(args, cwd) { return execFileSync("git", args, { cwd, encoding: "utf8" }); }

function makeRepo(name) {
  const dir = path.join(TMP, name);
  fs.mkdirSync(dir, { recursive: true });
  git(["init", "-q"], dir);
  git(["config", "user.email", "t@t.com"], dir);
  git(["config", "user.name", "Test"], dir);
  fs.writeFileSync(path.join(dir, "f.txt"), "hi");
  git(["add", "."], dir);
  git(["commit", "-q", "-m", "initial"], dir);
  return dir;
}

function tag(dir, name) { git(["tag", name], dir); }

async function call(args) { return executeTool("suggest_next_version", args); }

(async () => {
  console.log("suggest_next_version tests:");

  // ── Normal ────────────────────────────────────────────────────────────
  const repoA = makeRepo("repo-a");
  tag(repoA, "v1.0.0"); tag(repoA, "v1.2.0"); tag(repoA, "v1.1.5");
  await (async () => {
    const res = await call({ path: "repo-a" });
    test("highest semver tag found by real precedence (not string sort)", () => {
      assert.strictEqual(res.latestTag, "v1.2.0");
      assert.strictEqual(res.latestVersion, "1.2.0");
    });
    test("suggestions computed correctly (patch/minor/major)", () => {
      assert.deepStrictEqual(res.suggestions, { patch: "1.2.1", minor: "1.3.0", major: "2.0.0" });
    });
    test("matchedCount/tagCount reported", () => {
      assert.strictEqual(res.tagCount, 3);
      assert.strictEqual(res.matchedCount, 3);
    });
  })();

  // ── Medium ────────────────────────────────────────────────────────────
  const repoNoTags = makeRepo("repo-no-tags");
  await (async () => {
    const res = await call({ path: "repo-no-tags" });
    test("no tags: latestVersion null, note present, no crash", () => {
      assert.strictEqual(res.latestVersion, null);
      assert.strictEqual(res.suggestions, null);
      assert.ok(res.note);
    });
  })();

  const repoNonSemver = makeRepo("repo-non-semver");
  tag(repoNonSemver, "release-candidate");
  tag(repoNonSemver, "checkpoint");
  await (async () => {
    const res = await call({ path: "repo-non-semver" });
    test("non-semver-shaped tags all excluded, matchedCount 0", () => {
      assert.strictEqual(res.tagCount, 2);
      assert.strictEqual(res.matchedCount, 0);
      assert.strictEqual(res.latestVersion, null);
    });
  })();

  test("non-git directory throws", () => {
    const dir = path.join(TMP, "not-a-repo");
    fs.mkdirSync(dir, { recursive: true });
    assert.throws(() => suggestNextVersion(dir, "not-a-repo"));
  });

  // ── High ──────────────────────────────────────────────────────────────
  const repoMixed = makeRepo("repo-mixed");
  tag(repoMixed, "v1.0.0"); tag(repoMixed, "checkpoint-x"); tag(repoMixed, "v2.5.3");
  await (async () => {
    const res = await call({ path: "repo-mixed" });
    test("mixed semver + non-semver tags: only semver ones counted, highest wins", () => {
      assert.strictEqual(res.tagCount, 3);
      assert.strictEqual(res.matchedCount, 2);
      assert.strictEqual(res.latestVersion, "2.5.3");
    });
  })();

  const repoPkg = makeRepo("repo-pkg");
  tag(repoPkg, "v1.5.0");
  fs.writeFileSync(path.join(repoPkg, "package.json"), JSON.stringify({ name: "x", version: "1.5.0" }));
  await (async () => {
    const res = await call({ path: "repo-pkg" });
    test("package.json cross-check: in-sync case", () => {
      assert.strictEqual(res.pkgJsonVersion, "1.5.0");
      assert.strictEqual(res.inSyncWithPackageJson, true);
    });
  })();

  fs.writeFileSync(path.join(repoPkg, "package.json"), JSON.stringify({ name: "x", version: "1.6.0" }));
  await (async () => {
    const res = await call({ path: "repo-pkg" });
    test("package.json cross-check: drift detected (bumped in pkg but not tagged)", () => {
      assert.strictEqual(res.inSyncWithPackageJson, false);
    });
  })();

  await (async () => {
    const res = await call({ path: "repo-no-tags" }); // no package.json here
    test("missing package.json: pkgJsonVersion/inSyncWithPackageJson simply omitted, no throw", () => {
      assert.strictEqual(res.pkgJsonVersion, undefined);
      assert.strictEqual(res.inSyncWithPackageJson, undefined);
    });
  })();

  // ── Critical ──────────────────────────────────────────────────────────
  test("path traversal blocked", () => {
    assert.throws(() => executeTool("suggest_next_version", { path: "../../../etc" }));
  });

  const repoAnnotated = makeRepo("repo-annotated");
  git(["tag", "-a", "v3.0.0", "-m", "'; rm -rf / #"], repoAnnotated);
  await (async () => {
    const res = await call({ path: "repo-annotated" });
    test("shell-injection-shaped annotated tag message handled inertly, tag name itself parsed fine", () => {
      assert.strictEqual(res.latestVersion, "3.0.0");
    });
  })();

  test("result is JSON-serialisable", () => {
    const res = suggestNextVersion(repoA, "repo-a");
    JSON.stringify(res);
  });

  test("no unexpected top-level keys (base case, no pkg.json)", () => {
    const res = suggestNextVersion(repoA, "repo-a");
    assert.deepStrictEqual(Object.keys(res).sort(), ["latestTag", "latestVersion", "matchedCount", "path", "suggestions", "tagCount"]);
  });

  // ── Extreme ───────────────────────────────────────────────────────────
  const repoStress = makeRepo("repo-stress");
  for (let i = 0; i < 30; i++) tag(repoStress, `v0.${i}.0`);
  tag(repoStress, "v1.0.0"); // ensure a clear highest amid 30 lexically-larger-looking 0.x tags
  await (async () => {
    const res = await call({ path: "repo-stress" });
    test("31-tag stress case: correct highest found despite lexical-sort traps", () => {
      assert.strictEqual(res.matchedCount, 31);
      assert.strictEqual(res.latestVersion, "1.0.0");
    });
  })();

  await (async () => {
    const calls = Array.from({ length: 10 }, () => call({ path: "repo-a" }));
    const results = await Promise.all(calls);
    test("10 concurrent calls all consistent", () => {
      for (const r of results) assert.strictEqual(r.latestVersion, "1.2.0");
    });
  })();

  test("fuzz: malformed package.json doesn't crash, fields just omitted", () => {
    fs.writeFileSync(path.join(repoA, "package.json"), "{ not json ");
    const res = suggestNextVersion(repoA, "repo-a", { pkgJsonAbsPath: path.join(repoA, "package.json") });
    assert.strictEqual(res.pkgJsonVersion, undefined);
  });

  test("execute_pipeline op-enum registration", () => {
    const schemas = require("../lib/toolsSchema").TOOLS_ALL;
    const pipelineSchema = schemas.find(s => s.name === "execute_pipeline");
    const opEnum = pipelineSchema.inputSchema.properties.steps.items.properties.op.enum;
    assert.ok(opEnum.includes("suggest_next_version"));
  });

  fs.rmSync(TMP, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
