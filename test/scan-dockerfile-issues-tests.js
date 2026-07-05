"use strict";
// Standalone test script for scan_dockerfile_issues (not added to the
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dockerfile-audit-"));
process.env.MCP_ROOTS = TMP;
process.env.MCP_ALLOW_EXEC = "true";
process.env.MCP_READ_ONLY = "false";
const { buildRoots } = require("../lib/roots");
buildRoots();
const { executeTool } = require("../lib/executeTool");
const { scanDockerfileIssues } = require("../lib/dockerfileAuditOps");

function write(rel, content) {
  const p = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

async function call(args) {
  return executeTool("scan_dockerfile_issues", args);
}

(async () => {
  console.log("scan_dockerfile_issues tests:");

  // ── Normal ────────────────────────────────────────────────────────────
  write("clean/Dockerfile", "FROM node:18.19.0-slim\nCOPY . /app\nUSER node\nCMD [\"node\",\"index.js\"]\n");
  await (async () => {
    const res = await call({ path: "clean/Dockerfile" });
    test("pinned tag + USER present + COPY: zero errors, zero warnings", () => {
      assert.strictEqual(res.errorCount, 0);
      assert.strictEqual(res.warningCount, 0);
      assert.strictEqual(res.hasUserInFinalStage, true);
      assert.strictEqual(res.stages[0].tag, "18.19.0-slim");
    });
  })();

  write("digest/Dockerfile", "FROM alpine@sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789\nUSER app\n");
  await (async () => {
    const res = await call({ path: "digest/Dockerfile" });
    test("digest-pinned FROM (no tag) not flagged as unpinned", () => {
      assert.strictEqual(res.errorCount, 0);
      assert.strictEqual(res.stages[0].digest, "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789");
    });
  })();

  // ── Medium ────────────────────────────────────────────────────────────
  test("missing file throws", () => {
    assert.throws(() => scanDockerfileIssues(path.join(TMP, "nope/Dockerfile"), "nope/Dockerfile"));
  });

  write("noFrom/Dockerfile", "# just a comment\nRUN echo hi\n");
  await (async () => {
    const res = await call({ path: "noFrom/Dockerfile" });
    test("no FROM instruction -> error, stageCount 0", () => {
      assert.strictEqual(res.stageCount, 0);
      assert.ok(res.issues.some(i => i.instruction === "FROM" && i.severity === "error" && /No FROM/.test(i.message)));
    });
  })();

  write("implicitLatest/Dockerfile", "FROM ubuntu\nUSER app\n");
  await (async () => {
    const res = await call({ path: "implicitLatest/Dockerfile" });
    test("no tag/digest -> implicit latest error", () => {
      assert.strictEqual(res.errorCount, 1);
      assert.strictEqual(res.stages[0].tag, null);
    });
  })();

  // ── High ──────────────────────────────────────────────────────────────
  write("explicitLatest/Dockerfile", "FROM node:latest\nUSER app\n");
  await (async () => {
    const res = await call({ path: "explicitLatest/Dockerfile" });
    test("explicit ':latest' tag -> warning not error", () => {
      assert.strictEqual(res.errorCount, 0);
      assert.ok(res.issues.some(i => i.severity === "warning" && /:latest/.test(i.message)));
    });
  })();

  write("noUser/Dockerfile", "FROM node:18\nCOPY . /app\n");
  await (async () => {
    const res = await call({ path: "noUser/Dockerfile" });
    test("missing USER in final stage -> warning", () => {
      assert.strictEqual(res.hasUserInFinalStage, false);
      assert.ok(res.issues.some(i => i.instruction === "USER"));
    });
  })();

  write("multiStage/Dockerfile", "FROM node:18 AS build\nRUN npm run build\nFROM node:18-slim\nCOPY --from=build /app/dist /app\nUSER node\n");
  await (async () => {
    const res = await call({ path: "multiStage/Dockerfile" });
    test("multi-stage: only final stage checked for USER, builder stage USER-less is fine", () => {
      assert.strictEqual(res.stageCount, 2);
      assert.strictEqual(res.hasUserInFinalStage, true);
      assert.strictEqual(res.stages[0].alias, "build");
    });
  })();

  write("lineCont/Dockerfile", "FROM node:18\nRUN apt-get update && \\\n    apt-get install -y curl\nUSER node\n");
  await (async () => {
    const res = await call({ path: "lineCont/Dockerfile" });
    test("line continuation ('\\\\') joined into one logical instruction", () => {
      assert.strictEqual(res.errorCount, 0);
      assert.strictEqual(res.hasUserInFinalStage, true);
    });
  })();

  // ── Critical ──────────────────────────────────────────────────────────
  test("path traversal blocked", () => {
    assert.throws(() => executeTool("scan_dockerfile_issues", { path: "../../../etc/passwd" }));
  });

  write("addLocal/Dockerfile", "FROM node:18\nADD ./'; rm -rf / #.tar /app\nUSER node\n");
  await (async () => {
    const res = await call({ path: "addLocal/Dockerfile" });
    test("shell-injection-shaped ADD source handled as inert literal text, never executed", () => {
      assert.ok(res.addLocalCount >= 1);
      assert.ok(res.issues.some(i => i.instruction === "ADD"));
    });
  })();

  write("addUrl/Dockerfile", "FROM node:18\nADD https://example.com/f.tar.gz /app\nUSER node\n");
  await (async () => {
    const res = await call({ path: "addUrl/Dockerfile" });
    test("ADD with an http(s) URL source not flagged (legitimate ADD use)", () => {
      assert.strictEqual(res.addLocalCount, 0);
    });
  })();

  test("result is JSON-serialisable", () => {
    const res = scanDockerfileIssues(path.join(TMP, "clean", "Dockerfile"), "clean/Dockerfile");
    JSON.stringify(res);
  });

  test("no unexpected top-level keys", () => {
    const res = scanDockerfileIssues(path.join(TMP, "clean", "Dockerfile"), "clean/Dockerfile");
    assert.deepStrictEqual(Object.keys(res).sort(), ["addLocalCount", "errorCount", "hasUserInFinalStage", "issues", "path", "stageCount", "stages", "warningCount"]);
  });

  // ── Extreme ───────────────────────────────────────────────────────────
  let bigDockerfile = "";
  for (let i = 0; i < 20; i++) bigDockerfile += `FROM node:18 AS stage${i}\nRUN echo ${i}\n`;
  bigDockerfile += "FROM node:18-slim\nUSER node\n";
  write("stress/Dockerfile", bigDockerfile);
  await (async () => {
    const res = await call({ path: "stress/Dockerfile" });
    test("21-stage Dockerfile parsed correctly, only final stage's USER matters", () => {
      assert.strictEqual(res.stageCount, 21);
      assert.strictEqual(res.hasUserInFinalStage, true);
    });
  })();

  await (async () => {
    const calls = Array.from({ length: 10 }, () => call({ path: "clean/Dockerfile" }));
    const results = await Promise.all(calls);
    test("10 concurrent calls all consistent", () => {
      for (const r of results) assert.strictEqual(r.errorCount, 0);
    });
  })();

  test("fuzz: garbage binary content doesn't crash, no FROM found reported as error", () => {
    write("fuzz/Dockerfile", Buffer.from([0, 1, 2, 255, 254, 253]).toString("binary"));
    const res = scanDockerfileIssues(path.join(TMP, "fuzz", "Dockerfile"), "fuzz/Dockerfile");
    assert.strictEqual(res.stageCount, 0);
  });

  test("execute_pipeline op-enum registration", () => {
    const schemas = require("../lib/toolsSchema").TOOLS_ALL;
    const pipelineSchema = schemas.find(s => s.name === "execute_pipeline");
    const opEnum = pipelineSchema.inputSchema.properties.steps.items.properties.op.enum;
    assert.ok(opEnum.includes("scan_dockerfile_issues"));
  });

  fs.rmSync(TMP, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
