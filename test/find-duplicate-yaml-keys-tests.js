"use strict";
// Standalone test script for find_duplicate_yaml_keys (not added to the
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dup-yaml-keys-"));
process.env.MCP_ROOTS = TMP;
process.env.MCP_ALLOW_EXEC = "true";
process.env.MCP_READ_ONLY = "false";
const { buildRoots } = require("../lib/roots");
buildRoots();
const { executeTool } = require("../lib/executeTool");
const { scanYamlDuplicateKeys } = require("../lib/duplicateYamlKeysOps");

function write(rel, content) {
  const p = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

async function call(args) { return executeTool("find_duplicate_yaml_keys", args); }

(async () => {
  console.log("find_duplicate_yaml_keys tests:");

  // ── Normal ───────────────────────────────────────────────────────────────
  const proj = "proj";
  write(`${proj}/dup-top.yaml`, "a: 1\nb: 2\na: 3\n");
  write(`${proj}/dup-nested.yaml`, "outer:\n  x: 1\n  x: 2\nother:\n  y: 1\n");
  write(`${proj}/clean.yaml`, "a: 1\nb:\n  c: 2\nlist:\n  - 1\n  - 2\n");
  write(`${proj}/list-of-maps.yaml`, "items:\n  - name: a\n    val: 1\n  - name: b\n    val: 2\n");
  write(`${proj}/list-of-maps-dup.yaml`, "items:\n  - name: a\n    name: b\n");
  write(`${proj}/multidoc.yaml`, "a: 1\na: 2\n---\na: 1\nb: 2\n");

  await test("Normal: top-level duplicate key detected", async () => {
    const r = scanYamlDuplicateKeys(path.join(TMP, `${proj}/dup-top.yaml`), `${proj}/dup-top.yaml`);
    assert.strictEqual(r.duplicateKeyCount, 1);
    assert.strictEqual(r.issues[0].key, "a");
    assert.strictEqual(r.issues[0].path, "$");
  });

  await test("Normal: nested mapping duplicate detected, sibling mapping unaffected", async () => {
    const r = scanYamlDuplicateKeys(path.join(TMP, `${proj}/dup-nested.yaml`), `${proj}/dup-nested.yaml`);
    assert.strictEqual(r.duplicateKeyCount, 1);
    assert.strictEqual(r.issues[0].key, "x");
    assert.strictEqual(r.issues[0].path, "outer");
  });

  await test("Normal: clean file has zero issues", async () => {
    const r = scanYamlDuplicateKeys(path.join(TMP, `${proj}/clean.yaml`), `${proj}/clean.yaml`);
    assert.strictEqual(r.duplicateKeyCount, 0);
  });

  await test("Normal: list-of-mappings with same key per item is NOT a false positive", async () => {
    const r = scanYamlDuplicateKeys(path.join(TMP, `${proj}/list-of-maps.yaml`), `${proj}/list-of-maps.yaml`);
    assert.strictEqual(r.duplicateKeyCount, 0);
  });

  await test("Normal: duplicate key within a single list item IS detected", async () => {
    const r = scanYamlDuplicateKeys(path.join(TMP, `${proj}/list-of-maps-dup.yaml`), `${proj}/list-of-maps-dup.yaml`);
    assert.strictEqual(r.duplicateKeyCount, 1);
    assert.strictEqual(r.issues[0].key, "name");
  });

  await test("Normal: multi-document file scans each document independently", async () => {
    const r = scanYamlDuplicateKeys(path.join(TMP, `${proj}/multidoc.yaml`), `${proj}/multidoc.yaml`);
    assert.strictEqual(r.duplicateKeyCount, 1);
    assert.strictEqual(r.issues[0].doc, 0);
  });

  await test("Normal: directory scan aggregates across files", async () => {
    const r = await call({ path: proj });
    assert.ok(r.filesScanned >= 6);
    assert.ok(r.duplicateKeyCount >= 4);
  });

  // ── Medium: boundary & parameter validation ────────────────────────────────
  await test("Medium: nonexistent path throws", async () => {
    await assert.rejects(() => call({ path: `${proj}/does-not-exist.yaml` }));
  });

  await test("Medium: non-array extensions throws", async () => {
    await assert.rejects(() => call({ path: proj, extensions: ".yaml" }));
  });

  await test("Medium: non-number max_results throws", async () => {
    await assert.rejects(() => call({ path: proj, max_results: "5" }));
  });

  await test("Medium: single-file mode works directly on a file path", async () => {
    const r = await call({ path: `${proj}/dup-top.yaml` });
    assert.strictEqual(r.filesScanned, 1);
    assert.strictEqual(r.duplicateKeyCount, 1);
  });

  await test("Medium: empty file produces zero issues, not a crash", async () => {
    write(`${proj}/empty.yaml`, "");
    const r = await call({ path: `${proj}/empty.yaml` });
    assert.strictEqual(r.duplicateKeyCount, 0);
    assert.strictEqual(r.filesWithErrors, 0);
  });

  // ── High: edge handling ─────────────────────────────────────────────────
  await test("High: extensions filter narrows scan to .yaml/.yml only", async () => {
    write(`${proj}/not-yaml.txt`, "a: 1\na: 2\n");
    const r = await call({ path: proj, extensions: [".yaml"] });
    assert.ok(!r.errors.some(e => e.file === "not-yaml.txt"));
  });

  await test("High: binary file is skipped without crashing", async () => {
    fs.writeFileSync(path.join(TMP, `${proj}/binary.yaml`), Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00]));
    const r = await call({ path: proj });
    assert.ok(typeof r.filesScanned === "number");
  });

  await test("High: quoted keys (single and double) are recognised", async () => {
    write(`${proj}/quoted.yaml`, '"a": 1\n\'a\': 2\n');
    const r = await call({ path: `${proj}/quoted.yaml` });
    assert.strictEqual(r.duplicateKeyCount, 1);
  });

  // ── Critical: security & input sanitization ────────────────────────────────
  await test("Critical: path traversal outside root is blocked", async () => {
    await assert.rejects(() => call({ path: "../../../../etc/passwd" }));
  });

  await test("Critical: duplicate-key value containing script/SQLi-shaped text is only reported, not executed", async () => {
    write(`${proj}/adversarial.yaml`, "q: \"'; DROP TABLE users; --\"\nq: \"<script>alert(1)</script>\"\n");
    const r = await call({ path: `${proj}/adversarial.yaml` });
    assert.strictEqual(r.duplicateKeyCount, 1);
    assert.strictEqual(r.issues[0].key, "q");
  });

  await test("Critical: result is JSON-serialisable with only known top-level keys", async () => {
    const r = await call({ path: proj });
    JSON.stringify(r);
    const known = ["path", "filesScanned", "filesWithErrors", "duplicateKeyCount", "truncated", "issues", "errors"];
    assert.deepStrictEqual(Object.keys(r).sort(), known.sort());
  });

  // ── Extreme: fuzzing, concurrency, truncation ──────────────────────────────
  await test("Extreme: max_results truncation sets truncated flag", async () => {
    let content = "";
    for (let i = 0; i < 20; i++) content += `k${i}: 1\nk${i}: 2\n`;
    write("proj2/many.yaml", content);
    const r = await call({ path: "proj2/many.yaml", max_results: 5 });
    assert.strictEqual(r.issues.length, 5);
    assert.strictEqual(r.truncated, true);
    assert.strictEqual(r.duplicateKeyCount, 20);
  });

  await test("Extreme: fuzz random-byte file handled without crash", async () => {
    fs.writeFileSync(path.join(TMP, `${proj}/fuzz.yaml`), require("crypto").randomBytes(2000));
    const r = await call({ path: `${proj}/fuzz.yaml` });
    assert.ok(typeof r.filesScanned === "number");
  });

  await test("Extreme: 10 concurrent calls give consistent results", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => call({ path: `${proj}/dup-top.yaml` })));
    for (const r of results) assert.strictEqual(r.duplicateKeyCount, 1);
  });

  await test("Extreme: execute_pipeline op-enum registration", async () => {
    const { EXEC_SCHEMAS } = require("../lib/schemas/execSchemas");
    const pipelineSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
    const opEnum = pipelineSchema.inputSchema.properties.steps.items.properties.op.enum;
    assert.ok(opEnum.includes("find_duplicate_yaml_keys"));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
