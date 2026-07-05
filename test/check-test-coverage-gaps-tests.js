"use strict";
// Standalone test script for check_test_coverage_gaps (not added to the
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cov-gaps-"));
process.env.MCP_ROOTS = TMP;
process.env.MCP_ALLOW_EXEC = "true";
process.env.MCP_READ_ONLY = "false";
const { buildRoots } = require("../lib/roots");
buildRoots();
const { executeTool } = require("../lib/executeTool");
const { checkTestCoverageGaps } = require("../lib/coverageGapsOps");

function write(rel, content) {
  const p = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

async function call(args) {
  return executeTool("check_test_coverage_gaps", args);
}

(async () => {
  console.log("check_test_coverage_gaps tests:");

  // ── Normal ────────────────────────────────────────────────────────────
  const projA = "proj-a";
  write(`${projA}/src/foo.js`, "module.exports = {};");
  write(`${projA}/src/foo.test.js`, "test('x',()=>{});");
  write(`${projA}/src/bar.js`, "module.exports = {};");
  await (async () => {
    const res = await call({ path: projA });
    test("covered source file not flagged, uncovered one is", () => {
      assert.ok(!res.gaps.includes(`${projA}/src/foo.js`.replace(/\\/g, "/")));
      assert.ok(res.gaps.some(g => g.endsWith("bar.js")));
    });
    test("result shape has expected numeric fields", () => {
      assert.ok(Number.isInteger(res.filesScanned));
      assert.ok(Number.isInteger(res.sourceFilesScanned));
      assert.ok(Number.isInteger(res.testFilesScanned));
      assert.strictEqual(res.gapCount, res.gaps.length);
    });
  })();

  // test-dir-to-src-dir segment swap convention
  const projB = "proj-b";
  write(`${projB}/src/baz.js`, "x");
  write(`${projB}/test/baz.test.js`, "x");
  await (async () => {
    const res = await call({ path: projB });
    test("test-dir/src-dir segment-swap convention resolves coverage", () => {
      assert.ok(!res.gaps.some(g => g.endsWith("baz.js")));
    });
  })();

  // ── Medium ────────────────────────────────────────────────────────────
  test("nonexistent directory throws", () => {
    assert.throws(() => checkTestCoverageGaps(path.join(TMP, "nope"), "nope"));
  });

  test("file (not directory) path throws -32602", () => {
    write("single.js", "x");
    assert.throws(() => checkTestCoverageGaps(path.join(TMP, "single.js"), "single.js"), /not a directory/);
  });

  const projC = "proj-c";
  write(`${projC}/index.js`, "x");
  write(`${projC}/util.js`, "x");
  await (async () => {
    const res = await call({ path: projC, exclude_filenames: ["index.js"] });
    test("exclude_filenames suppresses known-intentional gaps", () => {
      assert.ok(!res.gaps.some(g => g.endsWith("index.js")));
      assert.ok(res.gaps.some(g => g.endsWith("util.js")));
    });
  })();

  test("max_results must be a number", () => {
    assert.throws(() => checkTestCoverageGaps(path.join(TMP, projC), projC, { maxResults: "5" }), /max_results must be a number/);
  });

  test("exclude_filenames must be an array", () => {
    assert.throws(() => checkTestCoverageGaps(path.join(TMP, projC), projC, { excludeFilenames: "x" }), /must be an array/);
  });

  // ── High ──────────────────────────────────────────────────────────────
  const projEmpty = "proj-empty";
  fs.mkdirSync(path.join(TMP, projEmpty), { recursive: true });
  await (async () => {
    const res = await call({ path: projEmpty });
    test("empty directory: zero scanned, zero gaps, no crash", () => {
      assert.strictEqual(res.sourceFilesScanned, 0);
      assert.strictEqual(res.gapCount, 0);
    });
  })();

  const projFull = "proj-full-cov";
  write(`${projFull}/a.js`, "x");
  write(`${projFull}/a.test.js`, "x");
  await (async () => {
    const res = await call({ path: projFull });
    test("fully-covered project reports zero gaps", () => {
      assert.strictEqual(res.gapCount, 0);
    });
  })();

  // ── Critical ──────────────────────────────────────────────────────────
  test("path traversal blocked", () => {
    assert.throws(() => executeTool("check_test_coverage_gaps", { path: "../../../etc" }));
  });

  const projInj = "proj-inject";
  write(`${projInj}/'; rm -rf / #.js`, "x");
  await (async () => {
    const res = await call({ path: projInj });
    test("shell-injection-shaped filename handled as inert literal path, never executed", () => {
      assert.ok(res.gaps.some(g => g.includes("rm -rf")));
    });
  })();

  test("result is JSON-serialisable", () => {
    const res = checkTestCoverageGaps(path.join(TMP, projA), projA);
    JSON.stringify(res);
  });

  test("no unexpected top-level keys", () => {
    const res = checkTestCoverageGaps(path.join(TMP, projA), projA);
    const keys = Object.keys(res).sort();
    assert.deepStrictEqual(keys, ["filesScanned", "gapCount", "gaps", "path", "sourceFilesScanned", "testFilesScanned", "truncated"]);
  });

  // ── Extreme ───────────────────────────────────────────────────────────
  const projStress = "proj-stress";
  for (let i = 0; i < 60; i++) {
    write(`${projStress}/mod${i}.js`, "x");
    if (i % 2 === 0) write(`${projStress}/mod${i}.test.js`, "x");
  }
  await (async () => {
    const res = await call({ path: projStress });
    test("60-file stress case: exactly the odd-indexed modules are gaps", () => {
      assert.strictEqual(res.gapCount, 30);
    });
  })();

  await (async () => {
    const res = await call({ path: projStress, max_results: 5 });
    test("max_results caps gaps[] length and sets truncated", () => {
      assert.strictEqual(res.gaps.length, 5);
      assert.strictEqual(res.truncated, true);
    });
  })();

  await (async () => {
    const calls = Array.from({ length: 10 }, () => call({ path: projStress }));
    const results = await Promise.all(calls);
    test("10 concurrent calls all consistent", () => {
      for (const r of results) assert.strictEqual(r.gapCount, 30);
    });
  })();

  test("execute_pipeline op-enum registration", () => {
    const execSchemas = require("../lib/schemas/execSchemas");
    const schemas = require("../lib/toolsSchema").TOOLS_ALL;
    const pipelineSchema = schemas.find(s => s.name === "execute_pipeline");
    const opEnum = pipelineSchema.inputSchema.properties.steps.items.properties.op.enum;
    assert.ok(opEnum.includes("check_test_coverage_gaps"));
  });

  fs.rmSync(TMP, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
