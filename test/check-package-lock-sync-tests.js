"use strict";
// Standalone test script for check_package_lock_sync (not added to the
// frozen test/run-tests.js — new tool areas get their own script per the
// testing-strategy pivot documented in task.md).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok - ${name}`); passed++; }
  catch (e) { console.log(`  FAIL - ${name}\n    ${e.message}`); failed++; }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "pkg-lock-sync-"));
process.env.MCP_ROOTS = TMP;
process.env.MCP_ALLOW_EXEC = "true";
process.env.MCP_READ_ONLY = "false";
const { buildRoots } = require("../lib/roots");
buildRoots();
const { executeTool } = require("../lib/executeTool");
const { checkPackageLockSync } = require("../lib/packageLockSyncOps");

function write(rel, obj) {
  const p = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof obj === "string" ? obj : JSON.stringify(obj, null, 2));
}

async function call(args) {
  return executeTool("check_package_lock_sync", args);
}

(async () => {
  console.log("check_package_lock_sync tests:");

  // ── Normal ────────────────────────────────────────────────────────────
  const projV3 = "proj-v3";
  write(`${projV3}/package.json`, { name: "x", version: "1.0.0", dependencies: { foo: "^1.2.0" }, devDependencies: { bar: "~2.0.0" } });
  write(`${projV3}/package-lock.json`, {
    name: "x", version: "1.0.0", lockfileVersion: 3,
    packages: {
      "": { name: "x", version: "1.0.0" },
      "node_modules/foo": { version: "1.2.5" },
      "node_modules/bar": { version: "2.0.3" },
    },
  });
  await (async () => {
    const res = await call({ pkg_path: `${projV3}/package.json`, lock_path: `${projV3}/package-lock.json` });
    test("v2/v3 packages-shape lockfile: in-sync deps reported inSync", () => {
      assert.strictEqual(res.inSync, true);
      assert.strictEqual(res.checked, 2);
      assert.strictEqual(res.missingCount, 0);
      assert.strictEqual(res.mismatchCount, 0);
      assert.strictEqual(res.lockfileVersion, 3);
    });
  })();

  const projV1 = "proj-v1";
  write(`${projV1}/package.json`, { name: "y", version: "1.0.0", dependencies: { foo: "^1.0.0" } });
  write(`${projV1}/package-lock.json`, { name: "y", version: "1.0.0", lockfileVersion: 1, dependencies: { foo: { version: "1.5.0" } } });
  await (async () => {
    const res = await call({ pkg_path: `${projV1}/package.json`, lock_path: `${projV1}/package-lock.json` });
    test("lockfileVersion 1 dependencies-shape resolves correctly", () => {
      assert.strictEqual(res.inSync, true);
      assert.strictEqual(res.lockfileVersion, 1);
    });
  })();

  // ── Medium ────────────────────────────────────────────────────────────
  test("missing package.json throws", () => {
    assert.throws(() => checkPackageLockSync(path.join(TMP, "nope.json"), path.join(TMP, projV3, "package-lock.json"), "nope.json", "x"));
  });

  test("malformed JSON throws with parse detail", () => {
    write(`${projV3}/bad.json`, "not json {{{");
    assert.throws(() => checkPackageLockSync(path.join(TMP, projV3, "bad.json"), path.join(TMP, projV3, "package-lock.json"), "bad.json", "x"), /not valid JSON/);
  });

  test("blocks must be an array", () => {
    assert.throws(() => checkPackageLockSync(path.join(TMP, projV3, "package.json"), path.join(TMP, projV3, "package-lock.json"), "x", "y", { blocks: "dependencies" }), /must be an array/);
  });

  const projMissing = "proj-missing-dep";
  write(`${projMissing}/package.json`, { name: "z", version: "1.0.0", dependencies: { ghost: "^1.0.0" } });
  write(`${projMissing}/package-lock.json`, { name: "z", version: "1.0.0", lockfileVersion: 3, packages: { "": {} } });
  await (async () => {
    const res = await call({ pkg_path: `${projMissing}/package.json`, lock_path: `${projMissing}/package-lock.json` });
    test("dep missing from lockfile flagged, inSync false", () => {
      assert.strictEqual(res.inSync, false);
      assert.strictEqual(res.missingCount, 1);
      assert.strictEqual(res.issues[0].status, "missing");
    });
  })();

  // ── High ──────────────────────────────────────────────────────────────
  const projMismatch = "proj-mismatch";
  write(`${projMismatch}/package.json`, { name: "m", version: "1.0.0", dependencies: { foo: "^2.0.0" } });
  write(`${projMismatch}/package-lock.json`, { name: "m", version: "1.0.0", lockfileVersion: 3, packages: { "": {}, "node_modules/foo": { version: "1.0.0" } } });
  await (async () => {
    const res = await call({ pkg_path: `${projMismatch}/package.json`, lock_path: `${projMismatch}/package-lock.json` });
    test("version mismatch (locked < declared range) flagged", () => {
      assert.strictEqual(res.inSync, false);
      assert.strictEqual(res.mismatchCount, 1);
      assert.strictEqual(res.issues[0].lockedVersion, "1.0.0");
    });
  })();

  const projSkip = "proj-skip";
  write(`${projSkip}/package.json`, { name: "s", version: "1.0.0", dependencies: { foo: "git+https://x.com/foo.git", bar: "*" } });
  write(`${projSkip}/package-lock.json`, { name: "s", version: "1.0.0", lockfileVersion: 3, packages: { "": {}, "node_modules/foo": { version: "1.0.0" }, "node_modules/bar": { version: "1.0.0" } } });
  await (async () => {
    const res = await call({ pkg_path: `${projSkip}/package.json`, lock_path: `${projSkip}/package-lock.json` });
    test("git-url and wildcard ranges skipped, not mismatches", () => {
      assert.strictEqual(res.skippedCount, 2);
      assert.strictEqual(res.mismatchCount, 0);
      assert.strictEqual(res.inSync, true);
    });
  })();

  // ── Critical ──────────────────────────────────────────────────────────
  test("path traversal on pkg_path blocked", () => {
    assert.throws(() => executeTool("check_package_lock_sync", { pkg_path: "../../../etc/passwd" }));
  });

  const projInj = "proj-inject";
  write(`${projInj}/package.json`, { name: "i", version: "1.0.0", dependencies: { "'; rm -rf / #": "^1.0.0" } });
  write(`${projInj}/package-lock.json`, { name: "i", version: "1.0.0", lockfileVersion: 3, packages: { "": {} } });
  await (async () => {
    const res = await call({ pkg_path: `${projInj}/package.json`, lock_path: `${projInj}/package-lock.json` });
    test("shell-injection-shaped dep name handled as inert literal, never executed", () => {
      assert.strictEqual(res.issues[0].name, "'; rm -rf / #");
      assert.strictEqual(res.issues[0].status, "missing");
    });
  })();

  test("result is JSON-serialisable", () => {
    const res = checkPackageLockSync(path.join(TMP, projV3, "package.json"), path.join(TMP, projV3, "package-lock.json"), "x", "y");
    JSON.stringify(res);
  });

  test("no unexpected top-level keys", () => {
    const res = checkPackageLockSync(path.join(TMP, projV3, "package.json"), path.join(TMP, projV3, "package-lock.json"), "x", "y");
    assert.deepStrictEqual(Object.keys(res).sort(), ["checked", "inSync", "invalidCount", "issues", "lockPath", "lockfileVersion", "mismatchCount", "missingCount", "path", "skippedCount"]);
  });

  // ── Extreme ───────────────────────────────────────────────────────────
  const projStress = "proj-stress";
  const deps = {}, lockedPkgs = { "": {} };
  for (let i = 0; i < 100; i++) {
    deps[`pkg${i}`] = "^1.0.0";
    lockedPkgs[`node_modules/pkg${i}`] = { version: i % 2 === 0 ? "1.0.0" : "0.5.0" };
  }
  write(`${projStress}/package.json`, { name: "st", version: "1.0.0", dependencies: deps });
  write(`${projStress}/package-lock.json`, { name: "st", version: "1.0.0", lockfileVersion: 3, packages: lockedPkgs });
  await (async () => {
    const res = await call({ pkg_path: `${projStress}/package.json`, lock_path: `${projStress}/package-lock.json` });
    test("100-dep stress case: exactly the odd-indexed pkgs mismatch", () => {
      assert.strictEqual(res.checked, 100);
      assert.strictEqual(res.mismatchCount, 50);
    });
  })();

  await (async () => {
    const calls = Array.from({ length: 10 }, () => call({ pkg_path: `${projV3}/package.json`, lock_path: `${projV3}/package-lock.json` }));
    const results = await Promise.all(calls);
    test("10 concurrent calls all consistent", () => {
      for (const r of results) assert.strictEqual(r.inSync, true);
    });
  })();

  test("fuzz: garbage lockfile content throws cleanly, no crash", () => {
    write(`${projV3}/garbage-lock.json`, "\u0000\u0001\u0002random bytes not json");
    assert.throws(() => checkPackageLockSync(path.join(TMP, projV3, "package.json"), path.join(TMP, projV3, "garbage-lock.json"), "x", "y"));
  });

  test("execute_pipeline op-enum registration", () => {
    const schemas = require("../lib/toolsSchema").TOOLS_ALL;
    const pipelineSchema = schemas.find(s => s.name === "execute_pipeline");
    const opEnum = pipelineSchema.inputSchema.properties.steps.items.properties.op.enum;
    assert.ok(opEnum.includes("check_package_lock_sync"));
  });

  fs.rmSync(TMP, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
