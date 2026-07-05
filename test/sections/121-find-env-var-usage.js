"use strict";
/**
 * [121] FIND_ENV_VAR_USAGE — find_env_var_usage tool
 *
 * Rigor levels covered:
 *   Normal:   var referenced in code + documented in .env.example -> neither
 *             undocumented nor unused; var referenced but not documented ->
 *             undocumented.
 *   Medium:   var documented but never referenced -> unused; missing
 *             env_files (no .env/.env.example present) doesn't error, just
 *             empty documented set; custom env_files param used instead of
 *             defaults; non-directory path throws.
 *   High:     Python os.environ/os.getenv forms recognised; comment lines
 *             and `export KEY=` lines in env file handled correctly.
 *   Critical: path traversal / absolute-path-outside-root blocked on both
 *             `path` and `env_files` entries; secret VALUES from a real
 *             .env-shaped file never appear anywhere in the output, only
 *             key names; JSON-serialisable; no unexpected top-level keys.
 *   Extreme:  many-var file scan; 10 concurrent calls consistent;
 *             execute_pipeline op-enum registration; cleanup.
 */
const path = require("path");
const fs   = require("fs");

const { assert, test, TMP, executeTool } = require("../test-harness");

console.log(`\n[121] FIND_ENV_VAR_USAGE — find_env_var_usage tool`);

function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }

// ── NORMAL ────────────────────────────────────────────────────────────────────

test("find_env_var_usage: referenced + documented var is neither undocumented nor unused", () => {
  const dir = path.join(TMP, "fevu-basic");
  mkdirp(dir);
  fs.writeFileSync(path.join(dir, "config.js"), 'const port = process.env.PORT;\n', "utf8");
  fs.writeFileSync(path.join(dir, ".env.example"), 'PORT=3000\n', "utf8");
  const r = executeTool("find_env_var_usage", { path: path.relative(TMP, dir) });
  assert.strictEqual(r.referencedCount, 1);
  assert.strictEqual(r.documentedCount, 1);
  assert.deepStrictEqual(r.undocumented, []);
  assert.deepStrictEqual(r.unused, []);
});

test("find_env_var_usage: referenced but undocumented var is flagged", () => {
  const dir = path.join(TMP, "fevu-undoc");
  mkdirp(dir);
  fs.writeFileSync(path.join(dir, "config.js"), 'const key = process.env.SECRET_KEY;\n', "utf8");
  fs.writeFileSync(path.join(dir, ".env.example"), 'PORT=3000\n', "utf8");
  const r = executeTool("find_env_var_usage", { path: path.relative(TMP, dir) });
  assert.deepStrictEqual(r.undocumented, ["SECRET_KEY"]);
});

// ── MEDIUM — boundary & param validation ─────────────────────────────────────

test("find_env_var_usage: documented but never-referenced var is flagged unused", () => {
  const dir = path.join(TMP, "fevu-unused");
  mkdirp(dir);
  fs.writeFileSync(path.join(dir, "config.js"), 'const p = process.env.PORT;\n', "utf8");
  fs.writeFileSync(path.join(dir, ".env.example"), 'PORT=3000\nSTALE_VAR=x\n', "utf8");
  const r = executeTool("find_env_var_usage", { path: path.relative(TMP, dir) });
  assert.deepStrictEqual(r.unused, ["STALE_VAR"]);
});

test("find_env_var_usage: no env files present doesn't error, empty documented set", () => {
  const dir = path.join(TMP, "fevu-noenv");
  mkdirp(dir);
  fs.writeFileSync(path.join(dir, "config.js"), 'const p = process.env.PORT;\n', "utf8");
  let r;
  assert.doesNotThrow(() => { r = executeTool("find_env_var_usage", { path: path.relative(TMP, dir) }); });
  assert.strictEqual(r.documentedCount, 0);
  assert.deepStrictEqual(r.envFilesRead, []);
  assert.deepStrictEqual(r.undocumented, ["PORT"]);
});

test("find_env_var_usage: custom env_files param used instead of defaults", () => {
  const dir = path.join(TMP, "fevu-customenv");
  mkdirp(dir);
  fs.writeFileSync(path.join(dir, "config.js"), 'const p = process.env.PORT;\n', "utf8");
  fs.writeFileSync(path.join(dir, "custom.env"), 'PORT=3000\n', "utf8");
  const r = executeTool("find_env_var_usage", {
    path: path.relative(TMP, dir),
    env_files: [path.join(path.relative(TMP, dir), "custom.env")],
  });
  assert.strictEqual(r.documentedCount, 1);
  assert.deepStrictEqual(r.undocumented, []);
});

test("find_env_var_usage: non-directory path throws a descriptive error", () => {
  const dir = path.join(TMP, "fevu-notdir");
  mkdirp(dir);
  fs.writeFileSync(path.join(dir, "f.txt"), "x", "utf8");
  assert.throws(
    () => executeTool("find_env_var_usage", { path: path.relative(TMP, path.join(dir, "f.txt")) }),
    /not a directory/i
  );
});

// ── HIGH — dependency / failure handling ─────────────────────────────────────

test("find_env_var_usage: Python os.environ/os.getenv forms recognised", () => {
  const dir = path.join(TMP, "fevu-python");
  mkdirp(dir);
  fs.writeFileSync(path.join(dir, "app.py"),
    "import os\nA = os.environ['ALPHA']\nB = os.environ.get('BETA')\nC = os.getenv('GAMMA')\n", "utf8");
  const r = executeTool("find_env_var_usage", { path: path.relative(TMP, dir) });
  assert.strictEqual(r.referencedCount, 3);
  assert.deepStrictEqual(r.undocumented.sort(), ["ALPHA", "BETA", "GAMMA"]);
});

test("find_env_var_usage: comment lines and export-prefixed lines in env file handled correctly", () => {
  const dir = path.join(TMP, "fevu-envsyntax");
  mkdirp(dir);
  fs.writeFileSync(path.join(dir, "config.js"), 'const a = process.env.FOO;\nconst b = process.env.BAR;\n', "utf8");
  fs.writeFileSync(path.join(dir, ".env.example"), '# a comment\nexport FOO=1\nBAR=2\n', "utf8");
  const r = executeTool("find_env_var_usage", { path: path.relative(TMP, dir) });
  assert.strictEqual(r.documentedCount, 2);
  assert.deepStrictEqual(r.undocumented, []);
});

// ── CRITICAL — security & input sanitization ─────────────────────────────────

test("find_env_var_usage: path traversal via path arg is blocked", () => {
  assert.throws(
    () => executeTool("find_env_var_usage", { path: "../../etc" }),
    /outside.*root|traversal|not.*within/i
  );
});

test("find_env_var_usage: path traversal via env_files entry is blocked", () => {
  const dir = path.join(TMP, "fevu-traverse-env");
  mkdirp(dir);
  fs.writeFileSync(path.join(dir, "config.js"), "x", "utf8");
  assert.throws(
    () => executeTool("find_env_var_usage", { path: path.relative(TMP, dir), env_files: ["../../../etc/passwd"] }),
    /outside.*root|traversal|not.*within/i
  );
});

test("find_env_var_usage: secret values never appear in output, only key names", () => {
  const dir = path.join(TMP, "fevu-secretsafe");
  mkdirp(dir);
  fs.writeFileSync(path.join(dir, "config.js"), "const k = process.env.API_TOKEN;\n", "utf8");
  fs.writeFileSync(path.join(dir, ".env"), "API_TOKEN=sk_live_supersecretvalue12345\n", "utf8");
  const r = executeTool("find_env_var_usage", { path: path.relative(TMP, dir) });
  const serialised = JSON.stringify(r);
  assert.ok(!serialised.includes("supersecretvalue"), "secret value leaked into tool output");
  assert.ok(r.documentedCount >= 1);
});

test("find_env_var_usage: result is fully JSON-serialisable", () => {
  const dir = path.join(TMP, "fevu-json");
  mkdirp(dir);
  fs.writeFileSync(path.join(dir, "a.js"), "process.env.X\n", "utf8");
  const r = executeTool("find_env_var_usage", { path: path.relative(TMP, dir) });
  let serialised;
  assert.doesNotThrow(() => { serialised = JSON.stringify(r); });
  assert.strictEqual(JSON.parse(serialised).referencedCount, r.referencedCount);
});

test("find_env_var_usage: result has no unexpected top-level keys", () => {
  const dir = path.join(TMP, "fevu-keys");
  mkdirp(dir);
  const r = executeTool("find_env_var_usage", { path: path.relative(TMP, dir) });
  const expected = new Set(["scanPath", "filesScanned", "envFilesRead", "documentedCount", "referencedCount", "undocumented", "unused"]);
  for (const key of Object.keys(r)) assert.ok(expected.has(key), `unexpected top-level key: '${key}'`);
});

// ── EXTREME — stress, fuzzing & concurrency ──────────────────────────────────

test("find_env_var_usage: many-var file scan completes without crashing", () => {
  const dir = path.join(TMP, "fevu-many");
  mkdirp(dir);
  let content = "";
  for (let i = 0; i < 100; i++) content += `const v${i} = process.env.VAR_${i};\n`;
  fs.writeFileSync(path.join(dir, "a.js"), content, "utf8");
  let r;
  assert.doesNotThrow(() => { r = executeTool("find_env_var_usage", { path: path.relative(TMP, dir) }); });
  assert.strictEqual(r.referencedCount, 100);
});

test("find_env_var_usage: 10 concurrent calls return consistent results", () => {
  const dir = path.join(TMP, "fevu-concurrent");
  mkdirp(dir);
  fs.writeFileSync(path.join(dir, "a.js"), "process.env.A\nprocess.env.B\n", "utf8");
  fs.writeFileSync(path.join(dir, ".env.example"), "A=1\n", "utf8");
  const relPath = path.relative(TMP, dir);
  const results = Array.from({ length: 10 }, () => executeTool("find_env_var_usage", { path: relPath }));
  const first = results[0];
  for (let i = 1; i < results.length; i++) {
    assert.deepStrictEqual(results[i].undocumented, first.undocumented, `call ${i}: mismatch`);
  }
});

test("find_env_var_usage: is registered in the execute_pipeline op enum", () => {
  const { EXEC_SCHEMAS } = require("../../lib/schemas/execSchemas");
  const pipelineSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
  const opEnum = pipelineSchema.inputSchema.properties.steps.items.properties.op.enum;
  assert.ok(opEnum.includes("find_env_var_usage"), "find_env_var_usage missing from execute_pipeline op enum");
});

// ── CLEANUP ───────────────────────────────────────────────────────────────────

test("cleanup: remove find_env_var_usage fixture dirs", () => {
  const dirs = [
    "fevu-basic", "fevu-undoc", "fevu-unused", "fevu-noenv", "fevu-customenv", "fevu-notdir",
    "fevu-python", "fevu-envsyntax", "fevu-traverse-env", "fevu-secretsafe", "fevu-json", "fevu-keys",
    "fevu-many", "fevu-concurrent",
  ];
  for (const d of dirs) {
    try { fs.rmSync(path.join(TMP, d), { recursive: true, force: true }); } catch (_) {}
  }
  assert.ok(!fs.existsSync(path.join(TMP, "fevu-basic")));
});
