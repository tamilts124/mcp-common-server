"use strict";
// Standalone test script for find_duplicate_json_keys (not added to the
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dup-json-keys-"));
process.env.MCP_ROOTS = TMP;
process.env.MCP_ALLOW_EXEC = "true";
process.env.MCP_READ_ONLY = "false";
const { buildRoots } = require("../lib/roots");
buildRoots();
const { executeTool } = require("../lib/executeTool");
const { scanJsonDuplicateKeys } = require("../lib/duplicateJsonKeysOps");

function write(rel, content) {
  const p = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

async function call(args) { return executeTool("find_duplicate_json_keys", args); }

(async () => {
  console.log("find_duplicate_json_keys tests:");

  // ── Normal ───────────────────────────────────────────────────────────────
  const proj = "proj";
  write(`${proj}/dup-top.json`, `{"a":1,"b":2,"a":3}`);
  write(`${proj}/dup-nested.json`, `{"outer":{"x":1,"x":2},"arr":[{"k":1},{"k":2,"k":3}]}`);
  write(`${proj}/clean.json`, `{"a":1,"b":{"c":2},"arr":[1,2,3]}`);
  write(`${proj}/malformed.json`, `{"a":1,}`);
  write(`${proj}/multiline.json`, `{\n  "name": "x",\n  "value": 1,\n  "name": "y"\n}`);

  await test("Normal: top-level duplicate key detected", async () => {
    const r = scanJsonDuplicateKeys(path.join(TMP, `${proj}/dup-top.json`), `${proj}/dup-top.json`);
    assert.strictEqual(r.duplicateKeyCount, 1);
    assert.strictEqual(r.issues[0].key, "a");
    assert.strictEqual(r.issues[0].path, "$");
  });

  await test("Normal: nested object + array-of-objects duplicates detected", async () => {
    const r = scanJsonDuplicateKeys(path.join(TMP, `${proj}/dup-nested.json`), `${proj}/dup-nested.json`);
    assert.strictEqual(r.duplicateKeyCount, 2);
    const keys = r.issues.map(i => i.key).sort();
    assert.deepStrictEqual(keys, ["k", "x"]);
  });

  await test("Normal: clean file has zero issues", async () => {
    const r = scanJsonDuplicateKeys(path.join(TMP, `${proj}/clean.json`), `${proj}/clean.json`);
    assert.strictEqual(r.duplicateKeyCount, 0);
  });

  await test("Normal: directory scan aggregates across files, reports malformed separately", async () => {
    const r = await call({ path: proj });
    assert.ok(r.filesScanned >= 5);
    assert.ok(r.duplicateKeyCount >= 3);
    assert.strictEqual(r.filesWithErrors, 1);
    assert.ok(r.errors.some(e => e.file === "malformed.json"));
  });

  await test("Normal: line numbers reported for multiline duplicate", async () => {
    const r = scanJsonDuplicateKeys(path.join(TMP, `${proj}/multiline.json`), `${proj}/multiline.json`);
    assert.strictEqual(r.duplicateKeyCount, 1);
    assert.strictEqual(r.issues[0].firstLine, 2);
    assert.strictEqual(r.issues[0].duplicateLine, 4);
  });

  // ── Medium: boundary & parameter validation ────────────────────────────────
  await test("Medium: nonexistent path throws", async () => {
    await assert.rejects(() => call({ path: `${proj}/does-not-exist.json` }));
  });

  await test("Medium: non-array extensions throws", async () => {
    await assert.rejects(() => call({ path: proj, extensions: ".json" }));
  });

  await test("Medium: non-number max_results throws", async () => {
    await assert.rejects(() => call({ path: proj, max_results: "5" }));
  });

  await test("Medium: single-file mode works directly on a file path", async () => {
    const r = await call({ path: `${proj}/dup-top.json` });
    assert.strictEqual(r.filesScanned, 1);
    assert.strictEqual(r.duplicateKeyCount, 1);
  });

  await test("Medium: empty object / empty array produce no issues", async () => {
    write(`${proj}/empty.json`, `{}`);
    const r = scanJsonDuplicateKeys(path.join(TMP, `${proj}/empty.json`), `${proj}/empty.json`);
    assert.strictEqual(r.duplicateKeyCount, 0);
  });

  // ── High: dependency-failure-style / edge handling ─────────────────────────
  await test("High: extensions filter narrows scan to .json only", async () => {
    write(`${proj}/not-json.txt`, `{"a":1,"a":2}`);
    const r = await call({ path: proj, extensions: [".json"] });
    assert.ok(!r.errors.some(e => e.file === "not-json.txt"));
  });

  await test("High: binary file is skipped without crashing", async () => {
    const p = path.join(TMP, `${proj}/binary.json`);
    fs.writeFileSync(p, Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00]));
    const r = await call({ path: proj });
    assert.ok(r.filesScanned >= 0); // did not throw
  });

  await test("High: empty document reported as parse error, not a crash", async () => {
    write(`${proj}/empty-doc.json`, ``);
    const r = await call({ path: `${proj}/empty-doc.json` });
    assert.strictEqual(r.filesWithErrors, 1);
    assert.ok(/empty document/.test(r.errors[0].error));
  });

  // ── Critical: security & input sanitization ────────────────────────────────
  await test("Critical: path traversal outside root is blocked", async () => {
    await assert.rejects(() => call({ path: "../../../../etc/passwd" }));
  });

  await test("Critical: duplicate-key value containing script/SQLi-shaped text is only reported, not executed/interpreted", async () => {
    write(`${proj}/adversarial.json`, `{"q":"'; DROP TABLE users; --","q":"<script>alert(1)</script>"}`);
    const r = await call({ path: `${proj}/adversarial.json` });
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
    const many = "proj2/many.json";
    let obj = "{";
    for (let i = 0; i < 20; i++) obj += `"k${i}":1,"k${i}":2,`;
    obj = obj.slice(0, -1) + "}";
    write(many, obj);
    const r = await call({ path: many, max_results: 5 });
    assert.strictEqual(r.issues.length, 5);
    assert.strictEqual(r.truncated, true);
    assert.strictEqual(r.duplicateKeyCount, 20);
  });

  await test("Extreme: fuzz random-byte file handled without crash", async () => {
    const p = path.join(TMP, `${proj}/fuzz.json`);
    fs.writeFileSync(p, require("crypto").randomBytes(2000));
    const r = await call({ path: `${proj}/fuzz.json` });
    assert.ok(typeof r.filesScanned === "number");
  });

  await test("Extreme: 10 concurrent calls give consistent results", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => call({ path: `${proj}/dup-top.json` })));
    for (const r of results) assert.strictEqual(r.duplicateKeyCount, 1);
  });

  await test("Extreme: execute_pipeline op-enum registration", async () => {
    const { EXEC_SCHEMAS } = require("../lib/schemas/execSchemas");
    const pipelineSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
    const opEnum = pipelineSchema.inputSchema.properties.steps.items.properties.op.enum;
    assert.ok(opEnum.includes("find_duplicate_json_keys"));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
