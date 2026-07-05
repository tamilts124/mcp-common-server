"use strict";
// Standalone test script for find_empty_catch_blocks (not added to the
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "empty-catch-"));
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

async function call(args) { return executeTool("find_empty_catch_blocks", args); }

(async () => {
  console.log("find_empty_catch_blocks tests:");

  writeFile("proj/mixed/a.js", [
    "try { risky(); } catch (e) {}",
    "try { risky(); } catch (e) { console.log(e); }",
    "try { risky(); } catch { }",
    "try { risky(); } catch (e) {\n  // swallow intentionally\n}",
    "try { risky(); } catch (e) { throw e; }",
  ].join("\n"));

  await test("Normal: fully empty catch flagged", async () => {
    const r = await call({ path: "proj/mixed/a.js" });
    assert.ok(r.findings.some(f => f.line === 1));
  });

  await test("Normal: catch with real handling not flagged", async () => {
    const r = await call({ path: "proj/mixed/a.js" });
    assert.ok(!r.findings.some(f => f.line === 2));
  });

  await test("Normal: bare `catch {}` (no binding) flagged", async () => {
    const r = await call({ path: "proj/mixed/a.js" });
    assert.ok(r.findings.some(f => f.line === 3));
  });

  await test("Normal: comment-only catch flagged with hasCommentOnly:true", async () => {
    const r = await call({ path: "proj/mixed/a.js" });
    const f = r.findings.find(x => x.hasCommentOnly === true);
    assert.ok(f);
  });

  await test("Normal: rethrow catch not flagged", async () => {
    const r = await call({ path: "proj/mixed/a.js" });
    assert.ok(!r.findings.some(f => /throw e/.test(f.snippet)));
  });

  await test("Normal: clean file has zero findings", async () => {
    writeFile("proj/clean/b.js", "try { risky(); } catch (e) { logger.error(e); }");
    const r = await call({ path: "proj/clean/b.js" });
    assert.strictEqual(r.findingsCount, 0);
  });

  await test("Normal: directory scan aggregates across files", async () => {
    const r = await call({ path: "proj/mixed" });
    assert.ok(r.filesScanned >= 1);
    assert.ok(r.findingsCount >= 3);
  });

  // ── Medium: boundary & parameter validation ────────────────────────────
  await test("Medium: nonexistent path throws", async () => {
    await assert.rejects(() => call({ path: "proj/does-not-exist.js" }));
  });

  await test("Medium: non-number max_results throws", async () => {
    await assert.rejects(() => call({ path: "proj/mixed/a.js", max_results: "5" }));
  });

  await test("Medium: non-array extensions falls back to default set, not a crash", async () => {
    const r = await call({ path: "proj/mixed", extensions: ".js" });
    assert.ok(r.filesScanned >= 1);
  });

  await test("Medium: single file with non-matching extension throws", async () => {
    writeFile("proj/mixed/notes.txt", "catch {}");
    await assert.rejects(() => call({ path: "proj/mixed/notes.txt" }));
  });

  // ── High: edge handling ─────────────────────────────────────────────────
  await test("High: nested catch blocks each scanned independently", async () => {
    writeFile("proj/nested/c.js", "try {\n  try { a(); } catch (e) {}\n} catch (e) { log(e); }");
    const r = await call({ path: "proj/nested/c.js" });
    assert.strictEqual(r.findingsCount, 1);
  });

  await test("High: extensions filter narrows scan", async () => {
    writeFile("proj/extfilter/d.ts", "try { a(); } catch (e) {}");
    writeFile("proj/extfilter/d.js", "try { a(); } catch (e) {}");
    const r = await call({ path: "proj/extfilter", extensions: [".ts"] });
    assert.strictEqual(r.filesScanned, 1);
  });

  await test("High: multi-line catch body with only whitespace flagged", async () => {
    writeFile("proj/whitespace/e.js", "try { a(); } catch (e) {\n\n\n}");
    const r = await call({ path: "proj/whitespace/e.js" });
    assert.strictEqual(r.findingsCount, 1);
  });

  // ── Critical: security & input sanitization ────────────────────────────
  await test("Critical: path traversal outside root is blocked", async () => {
    await assert.rejects(() => call({ path: "../../../../etc/passwd" }));
  });

  await test("Critical: shell/script-injection-shaped comment text handled as inert data", async () => {
    writeFile("proj/adversarial/f.js", "try { a(); } catch (e) {\n  // $(rm -rf /); <script>alert(1)</script>\n}");
    const r = await call({ path: "proj/adversarial/f.js" });
    assert.strictEqual(r.findings[0].hasCommentOnly, true);
  });

  await test("Critical: result is JSON-serialisable with only known top-level keys", async () => {
    const r = await call({ path: "proj/clean/b.js" });
    JSON.stringify(r);
    const known = ["path", "filesScanned", "findingsCount", "truncated", "findings"];
    assert.deepStrictEqual(Object.keys(r).sort(), known.sort());
  });

  // ── Extreme: fuzzing, concurrency, truncation ──────────────────────────
  await test("Extreme: max_results truncation sets truncated flag", async () => {
    let src = "";
    for (let i = 0; i < 20; i++) src += "try { a(); } catch (e) {}\n";
    writeFile("proj/many/g.js", src);
    const r = await call({ path: "proj/many/g.js", max_results: 5 });
    assert.strictEqual(r.findings.length, 5);
    assert.strictEqual(r.truncated, true);
    assert.strictEqual(r.findingsCount, 20);
  });

  await test("Extreme: fuzz random-byte file doesn't crash", async () => {
    fs.writeFileSync(path.join(TMP, "proj/fuzz.js"), require("crypto").randomBytes(2000));
    await assert.doesNotReject(() => call({ path: "proj/fuzz.js" }));
  });

  await test("Extreme: 10 concurrent calls give consistent results", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => call({ path: "proj/clean/b.js" })));
    for (const r of results) assert.strictEqual(r.findingsCount, 0);
  });

  await test("Extreme: execute_pipeline op-enum registration", async () => {
    const { EXEC_SCHEMAS } = require("../lib/schemas/execSchemas");
    const pipelineSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
    const opEnum = pipelineSchema.inputSchema.properties.steps.items.properties.op.enum;
    assert.ok(opEnum.includes("find_empty_catch_blocks"));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})();
