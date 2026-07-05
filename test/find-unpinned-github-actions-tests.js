"use strict";
// Standalone test script for find_unpinned_github_actions (not added to the
// frozen test/run-tests.js — new tool areas get their own script per the
// testing-strategy pivot documented in task.md).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok - ${name}`); passed++; }
  catch (e) { console.log(`  FAIL - ${name}\n    ${e.message}`); failed++; }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "unpinned-actions-"));
process.env.MCP_ROOTS = TMP;
process.env.MCP_ALLOW_EXEC = "true";
process.env.MCP_READ_ONLY = "false";
const { buildRoots } = require("../lib/roots");
buildRoots();
const { executeTool } = require("../lib/executeTool");
const { scanUnpinnedActions } = require("../lib/unpinnedActionsOps");

function write(rel, content) {
  const p = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

async function call(args) { return executeTool("find_unpinned_github_actions", args); }
const SHA = "a".repeat(40);

(async () => {
  console.log("find_unpinned_github_actions tests:");

  const wf = ".github/workflows";
  write(`${wf}/ci.yml`, `jobs:\n  build:\n    steps:\n      - uses: actions/checkout@${SHA}\n      - uses: actions/setup-node@v4\n      - uses: some/action@main\n      - uses: another/action\n`);
  write(`${wf}/clean.yml`, `steps:\n  - uses: actions/checkout@${SHA}\n`);
  write(`${wf}/local.yml`, `steps:\n  - uses: ./local-action\n  - uses: docker://alpine:3.18\n`);

  await test("Normal: full-SHA pin is not flagged", async () => {
    const r = scanUnpinnedActions(path.join(TMP, `${wf}/clean.yml`), `${wf}/clean.yml`);
    assert.strictEqual(r.issueCount, 0);
    assert.strictEqual(r.pinnedCount, 1);
  });

  await test("Normal: tag ref flagged as tag_not_sha warning", async () => {
    const r = scanUnpinnedActions(path.join(TMP, `${wf}/ci.yml`), `${wf}/ci.yml`);
    const tagIssue = r.issues.find(i => i.rule === "tag_not_sha");
    assert.ok(tagIssue);
    assert.strictEqual(tagIssue.severity, "warning");
  });

  await test("Normal: @main flagged as mutable_branch_ref error", async () => {
    const r = scanUnpinnedActions(path.join(TMP, `${wf}/ci.yml`), `${wf}/ci.yml`);
    const branchIssue = r.issues.find(i => i.rule === "mutable_branch_ref");
    assert.ok(branchIssue);
    assert.strictEqual(branchIssue.severity, "error");
  });

  await test("Normal: no @ref at all flagged as missing_ref error", async () => {
    const r = scanUnpinnedActions(path.join(TMP, `${wf}/ci.yml`), `${wf}/ci.yml`);
    const missingIssue = r.issues.find(i => i.rule === "missing_ref");
    assert.ok(missingIssue);
    assert.strictEqual(missingIssue.severity, "error");
  });

  await test("Normal: local (./) and docker:// refs are skipped", async () => {
    const r = scanUnpinnedActions(path.join(TMP, `${wf}/local.yml`), `${wf}/local.yml`);
    assert.strictEqual(r.actionsFound, 0);
    assert.strictEqual(r.issueCount, 0);
  });

  await test("Normal: directory scan aggregates across files, default path used via dispatch", async () => {
    const r = await call({});
    assert.ok(r.filesScanned >= 3);
    assert.ok(r.issueCount >= 3);
  });

  // ── Medium: boundary & parameter validation ────────────────────────────
  await test("Medium: nonexistent path throws", async () => {
    await assert.rejects(() => call({ path: `${wf}/does-not-exist.yml` }));
  });

  await test("Medium: non-array extensions throws", async () => {
    await assert.rejects(() => call({ path: wf, extensions: ".yml" }));
  });

  await test("Medium: non-number max_results throws", async () => {
    await assert.rejects(() => call({ path: wf, max_results: "5" }));
  });

  await test("Medium: single-file mode works directly on a file path", async () => {
    const r = await call({ path: `${wf}/clean.yml` });
    assert.strictEqual(r.filesScanned, 1);
    assert.strictEqual(r.issueCount, 0);
  });

  await test("Medium: empty file produces zero issues, not a crash", async () => {
    write(`${wf}/empty.yml`, "");
    const r = await call({ path: `${wf}/empty.yml` });
    assert.strictEqual(r.issueCount, 0);
    assert.strictEqual(r.filesWithErrors, 0);
  });

  // ── High: edge handling ─────────────────────────────────────────────────
  await test("High: extensions filter narrows scan to .yml only", async () => {
    write(`${wf}/notyaml.txt`, "uses: foo/bar@main\n");
    const r = await call({ path: wf, extensions: [".yml"] });
    assert.ok(!r.errors.some(e => e.file === "notyaml.txt"));
  });

  await test("High: binary file is skipped without crashing", async () => {
    fs.writeFileSync(path.join(TMP, `${wf}/binary.yml`), Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00]));
    const r = await call({ path: wf });
    assert.ok(typeof r.filesScanned === "number");
  });

  await test("High: quoted uses value handled", async () => {
    write(`${wf}/quoted.yml`, `steps:\n  - uses: 'actions/checkout@v4'\n`);
    const r = await call({ path: `${wf}/quoted.yml` });
    assert.strictEqual(r.actionsFound, 1);
    assert.strictEqual(r.issues[0].action, "actions/checkout");
  });

  // ── Critical: security & input sanitization ────────────────────────────
  await test("Critical: path traversal outside root is blocked", async () => {
    await assert.rejects(() => call({ path: "../../../../etc/passwd" }));
  });

  await test("Critical: shell-injection-shaped action ref only reported, never executed", async () => {
    write(`${wf}/adversarial.yml`, "steps:\n  - uses: evil/action@$(rm -rf /)\n");
    const r = await call({ path: `${wf}/adversarial.yml` });
    assert.strictEqual(r.actionsFound, 1);
    assert.strictEqual(r.issues[0].rule, "unrecognized_ref");
  });

  await test("Critical: result is JSON-serialisable with only known top-level keys", async () => {
    const r = await call({ path: wf });
    JSON.stringify(r);
    const known = ["path", "filesScanned", "filesWithErrors", "actionsFound", "pinnedCount", "issueCount", "errorCount", "warningCount", "truncated", "issues", "errors"];
    assert.deepStrictEqual(Object.keys(r).sort(), known.sort());
  });

  // ── Extreme: fuzzing, concurrency, truncation ──────────────────────────
  await test("Extreme: max_results truncation sets truncated flag", async () => {
    let content = "steps:\n";
    for (let i = 0; i < 20; i++) content += `  - uses: org/action${i}@main\n`;
    write("wf2/many.yml", content);
    const r = await call({ path: "wf2/many.yml", max_results: 5 });
    assert.strictEqual(r.issues.length, 5);
    assert.strictEqual(r.truncated, true);
    assert.strictEqual(r.issueCount, 20);
  });

  await test("Extreme: fuzz random-byte file handled without crash", async () => {
    fs.writeFileSync(path.join(TMP, `${wf}/fuzz.yml`), require("crypto").randomBytes(2000));
    const r = await call({ path: `${wf}/fuzz.yml` });
    assert.ok(typeof r.filesScanned === "number");
  });

  await test("Extreme: 10 concurrent calls give consistent results", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => call({ path: `${wf}/clean.yml` })));
    for (const r of results) assert.strictEqual(r.issueCount, 0);
  });

  await test("Extreme: execute_pipeline op-enum registration", async () => {
    const { EXEC_SCHEMAS } = require("../lib/schemas/execSchemas");
    const pipelineSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
    const opEnum = pipelineSchema.inputSchema.properties.steps.items.properties.op.enum;
    assert.ok(opEnum.includes("find_unpinned_github_actions"));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
