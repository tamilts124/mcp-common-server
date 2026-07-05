"use strict";
// Standalone test script for find_hardcoded_credentials_in_config (not added
// to the frozen test/run-tests.js — new tool areas get their own script per
// the testing-strategy pivot documented in task.md).
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ok - ${name}`); passed++; }
  catch (e) { console.log(`  FAIL - ${name}\n    ${e.message}`); failed++; }
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cred-config-"));
process.env.MCP_ROOTS = TMP;
process.env.MCP_ALLOW_EXEC = "true";
process.env.MCP_READ_ONLY = "false";
const { buildRoots } = require("../lib/roots");
buildRoots();
const { executeTool } = require("../lib/executeTool");

function writeFile(rel, content) {
  const p = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

async function call(args) { return executeTool("find_hardcoded_credentials_in_config", args); }

(async () => {
  console.log("find_hardcoded_credentials_in_config tests:");

  writeFile("proj/config.json", JSON.stringify({
    db: { password: "SuperSecretP4ss!", host: "localhost" },
    api_key: "${API_KEY}",
    token: "changeme",
    nested: { deep: { client_secret: "realLookingSecretValue123" } },
  }, null, 2));

  writeFile("proj/config.yaml", "db:\n  password: AnotherRealSecret99\n  host: localhost\napi_key: \"${API_KEY}\"\n");

  writeFile("proj/.env", [
    "DB_PASSWORD=RealEnvSecretXYZ",
    "API_TOKEN=${API_TOKEN}",
    "PORT=3000",
    "# comment line",
    'QUOTED_SECRET="quotedRealSecret1"',
  ].join("\n"));

  await test("Normal: JSON nested credential key flagged, redacted", async () => {
    const r = await call({ path: "proj/config.json" });
    const f = r.findings.find(x => x.key === "db.password");
    assert.ok(f);
    assert.ok(!f.value.includes("SuperSecretP4ss"));
  });

  await test("Normal: JSON placeholder value (${VAR}) not flagged", async () => {
    const r = await call({ path: "proj/config.json" });
    assert.ok(!r.findings.some(x => x.key === "api_key"));
  });

  await test("Normal: JSON filler word 'changeme' not flagged", async () => {
    const r = await call({ path: "proj/config.json" });
    assert.ok(!r.findings.some(x => x.key === "token"));
  });

  await test("Normal: deeply nested JSON credential key flagged with dotted path", async () => {
    const r = await call({ path: "proj/config.json" });
    assert.ok(r.findings.some(x => x.key === "nested.deep.client_secret"));
  });

  await test("Normal: non-credential key (host) never flagged", async () => {
    const r = await call({ path: "proj/config.json" });
    assert.ok(!r.findings.some(x => x.key.endsWith("host")));
  });

  await test("Normal: YAML credential key flagged", async () => {
    const r = await call({ path: "proj/config.yaml" });
    assert.ok(r.findings.some(x => x.key === "db.password"));
  });

  await test("Normal: .env real secret flagged, placeholder and non-credential vars not", async () => {
    const r = await call({ path: "proj/.env" });
    assert.ok(r.findings.some(x => x.key === "DB_PASSWORD"));
    assert.ok(!r.findings.some(x => x.key === "API_TOKEN"));
    assert.ok(!r.findings.some(x => x.key === "PORT"));
  });

  await test("Normal: .env quoted value unwrapped before redaction check", async () => {
    const r = await call({ path: "proj/.env" });
    assert.ok(r.findings.some(x => x.key === "QUOTED_SECRET"));
  });

  await test("Normal: directory scan aggregates across json/yaml/env", async () => {
    const r = await call({ path: "proj" });
    assert.ok(r.filesScanned >= 3);
    assert.ok(r.findingsCount >= 4);
  });

  // ── Medium: boundary & parameter validation ────────────────────────────
  await test("Medium: nonexistent path throws", async () => {
    await assert.rejects(() => call({ path: "proj/does-not-exist.json" }));
  });

  await test("Medium: non-number max_results throws", async () => {
    await assert.rejects(() => call({ path: "proj/config.json", max_results: "5" }));
  });

  await test("Medium: unrecognized single-file format throws", async () => {
    writeFile("proj/notes.txt", "password=realsecret123");
    await assert.rejects(() => call({ path: "proj/notes.txt" }));
  });

  await test("Medium: malformed JSON recorded as parseError, not a crash", async () => {
    writeFile("proj/badjson/broken.json", "{ not valid json");
    const r = await call({ path: "proj/badjson" });
    assert.ok(r.parseErrors.some(e => e.file === "broken.json"));
  });

  // ── High: edge handling ─────────────────────────────────────────────────
  await test("High: .env.production variant recognized by directory walk", async () => {
    writeFile("proj/envvariant/.env.production", "SECRET_KEY=realProdSecretValue");
    const r = await call({ path: "proj/envvariant" });
    assert.ok(r.findings.some(x => x.key === "SECRET_KEY"));
  });

  await test("High: short value under 4 chars treated as placeholder-like, not flagged", async () => {
    writeFile("proj/shortval/c.json", JSON.stringify({ password: "abc" }));
    const r = await call({ path: "proj/shortval/c.json" });
    assert.strictEqual(r.findingsCount, 0);
  });

  await test("High: extensions filter narrows directory scan", async () => {
    const r = await call({ path: "proj", extensions: [".json"] });
    assert.ok(r.findings.every(f => f.file.endsWith(".json")));
  });

  // ── Critical: security & input sanitization ────────────────────────────
  await test("Critical: path traversal outside root is blocked", async () => {
    await assert.rejects(() => call({ path: "../../../../etc/passwd" }));
  });

  await test("Critical: redacted value never contains the full raw secret", async () => {
    writeFile("proj/adversarial/d.json", JSON.stringify({ password: "$(rm -rf /)ScriptInjectionSecret" }));
    const r = await call({ path: "proj/adversarial/d.json" });
    assert.ok(!r.findings[0].value.includes("rm -rf"));
  });

  await test("Critical: result is JSON-serialisable with only known top-level keys", async () => {
    const r = await call({ path: "proj/config.json" });
    JSON.stringify(r);
    const known = ["path", "filesScanned", "findingsCount", "truncated", "findings", "parseErrors"];
    assert.deepStrictEqual(Object.keys(r).sort(), known.sort());
  });

  // ── Extreme: fuzzing, concurrency, truncation ──────────────────────────
  await test("Extreme: max_results truncation sets truncated flag", async () => {
    const obj = {};
    for (let i = 0; i < 20; i++) obj[`password_${i}`] = `realSecretValue${i}`;
    writeFile("proj/many/e.json", JSON.stringify(obj));
    const r = await call({ path: "proj/many/e.json", max_results: 5 });
    assert.strictEqual(r.findings.length, 5);
    assert.strictEqual(r.truncated, true);
    assert.strictEqual(r.findingsCount, 20);
  });

  await test("Extreme: fuzz random-byte json file doesn't crash", async () => {
    fs.writeFileSync(path.join(TMP, "proj/fuzz.json"), require("crypto").randomBytes(500));
    const r = await call({ path: "proj/fuzz.json" });
    assert.ok(r.parseErrors.length >= 0); // just must not throw
  });

  await test("Extreme: 10 concurrent calls give consistent results", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => call({ path: "proj/shortval/c.json" })));
    for (const r of results) assert.strictEqual(r.findingsCount, 0);
  });

  await test("Extreme: execute_pipeline op-enum registration", async () => {
    const { EXEC_SCHEMAS } = require("../lib/schemas/execSchemas");
    const pipelineSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
    const opEnum = pipelineSchema.inputSchema.properties.steps.items.properties.op.enum;
    assert.ok(opEnum.includes("find_hardcoded_credentials_in_config"));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
