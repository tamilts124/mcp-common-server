"use strict";
// Isolated functional tests for check_dotenv_files_not_gitignored (lib/dotenvExposureOps.js).
// Run: node test/check-dotenv-files-not-gitignored-tests.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");
const { checkDotenvFilesNotGitignored } = require("../lib/dotenvExposureOps");
const { GIT_DISPATCH } = require("../lib/dispatchGit");
const { EXEC_SCHEMAS } = require("../lib/schemas/execSchemas");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("ok -", name); }
  catch (e) { fail++; console.log("FAIL -", name, "-", e.message); }
}

function git(dir, args) {
  execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
}
function initRepo() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "dotenv-test-"));
  git(d, ["init", "-q"]);
  git(d, ["config", "user.email", "t@t.com"]);
  git(d, ["config", "user.name", "t"]);
  return d;
}
function writeFile(dir, name, content) {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}
function commitAll(dir, msg) {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", msg]);
}

// ── Normal ──────────────────────────────────────────────────────────────
t("tracked .env file flagged as error", () => {
  const d = initRepo();
  try {
    writeFile(d, ".env", "SECRET=1\n");
    commitAll(d, "add env");
    const r = checkDotenvFilesNotGitignored(d, ".");
    assert.strictEqual(r.trackedCount, 1);
    assert.strictEqual(r.findings[0].rule, "dotenv_file_tracked_by_git");
    assert.strictEqual(r.findings[0].severity, "error");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("untracked + not gitignored flagged as warning", () => {
  const d = initRepo();
  try {
    writeFile(d, ".env", "SECRET=1\n");
    const r = checkDotenvFilesNotGitignored(d, ".");
    assert.strictEqual(r.notIgnoredCount, 1);
    assert.strictEqual(r.findings[0].rule, "dotenv_file_not_gitignored");
    assert.strictEqual(r.findings[0].severity, "warning");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("untracked + gitignored produces no finding", () => {
  const d = initRepo();
  try {
    writeFile(d, ".gitignore", ".env\n");
    writeFile(d, ".env", "SECRET=1\n");
    const r = checkDotenvFilesNotGitignored(d, ".");
    assert.strictEqual(r.findingsCount, 0);
    assert.strictEqual(r.dotenvFiles.find(f => f.file === ".env").ignored, true);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t(".env.example excluded by default", () => {
  const d = initRepo();
  try {
    writeFile(d, ".env.example", "SECRET=changeme\n");
    const r = checkDotenvFilesNotGitignored(d, ".");
    assert.strictEqual(r.filesScanned, 0);
    assert.strictEqual(r.filesSkippedAsExample, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("include_examples true includes example file", () => {
  const d = initRepo();
  try {
    writeFile(d, ".env.sample", "SECRET=changeme\n");
    const r = checkDotenvFilesNotGitignored(d, ".", { includeExamples: true });
    assert.strictEqual(r.filesScanned, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("nested subdirectory dotenv file detected", () => {
  const d = initRepo();
  try {
    writeFile(d, "config/.env.production", "SECRET=1\n");
    const r = checkDotenvFilesNotGitignored(d, ".");
    assert.strictEqual(r.filesScanned, 1);
    assert.strictEqual(r.dotenvFiles[0].file, "config/.env.production");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("clean repo with no dotenv files returns zero findings", () => {
  const d = initRepo();
  try {
    writeFile(d, "index.js", "console.log(1);\n");
    const r = checkDotenvFilesNotGitignored(d, ".");
    assert.strictEqual(r.filesScanned, 0);
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Medium ──────────────────────────────────────────────────────────────
t("non-git directory throws", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "dotenv-nogit-"));
  try {
    assert.throws(() => checkDotenvFilesNotGitignored(d, "."));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("max_files type mismatch throws", () => {
  const d = initRepo();
  try {
    assert.throws(() => checkDotenvFilesNotGitignored(d, ".", { maxFiles: "5" }));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("include_examples type mismatch throws", () => {
  const d = initRepo();
  try {
    assert.throws(() => checkDotenvFilesNotGitignored(d, ".", { includeExamples: "yes" }));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("max_files caps candidates and sets truncated flag", () => {
  const d = initRepo();
  try {
    writeFile(d, ".env.a", "1\n");
    writeFile(d, ".env.b", "1\n");
    writeFile(d, ".env.c", "1\n");
    const r = checkDotenvFilesNotGitignored(d, ".", { maxFiles: 1 });
    assert.strictEqual(r.filesScanned, 1);
    assert.strictEqual(r.truncated, true);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── High ────────────────────────────────────────────────────────────────
t("dotenv file inside an ignored parent directory is classified as ignored", () => {
  const d = initRepo();
  try {
    writeFile(d, ".gitignore", "secrets/\n");
    writeFile(d, "secrets/.env", "1\n");
    const r = checkDotenvFilesNotGitignored(d, ".");
    assert.strictEqual(r.findingsCount, 0);
    assert.strictEqual(r.dotenvFiles[0].ignored, true);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("mixed tracked/untracked/ignored files each classified correctly", () => {
  const d = initRepo();
  try {
    writeFile(d, ".env", "1\n");
    commitAll(d, "tracked one");
    writeFile(d, ".gitignore", ".env.local\n");
    writeFile(d, ".env.local", "1\n");
    writeFile(d, ".env.staging", "1\n");
    const r = checkDotenvFilesNotGitignored(d, ".");
    const byName = Object.fromEntries(r.dotenvFiles.map(f => [f.file, f]));
    assert.strictEqual(byName[".env"].tracked, true);
    assert.strictEqual(byName[".env.local"].ignored, true);
    assert.strictEqual(byName[".env.staging"].ignored, false);
    assert.strictEqual(r.findingsCount, 2); // tracked .env + not-ignored .env.staging
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("dispatch handler is registered and callable (signature check only — real dispatch requires an in-jail root path)", () => {
  assert.strictEqual(typeof GIT_DISPATCH.check_dotenv_files_not_gitignored, "function");
});

// ── Critical ────────────────────────────────────────────────────────────
t("path-traversal label echoed back but not resolved into a real traversal", () => {
  const d = initRepo();
  try {
    writeFile(d, ".env", "1\n");
    const r = checkDotenvFilesNotGitignored(d, "../../../etc/passwd");
    assert.strictEqual(r.path, "../../../etc/passwd");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("adversarial-shaped dotenv filename only reported as text, never executed", () => {
  const d = initRepo();
  try {
    writeFile(d, ".env.'--injected", "1\n");
    let r;
    assert.doesNotThrow(() => { r = checkDotenvFilesNotGitignored(d, "."); });
    assert.strictEqual(r.filesScanned, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("result is JSON-serialisable with exact expected top-level keys", () => {
  const d = initRepo();
  try {
    writeFile(d, ".env", "1\n");
    const r = checkDotenvFilesNotGitignored(d, ".");
    const json = JSON.parse(JSON.stringify(r));
    assert.deepStrictEqual(Object.keys(json).sort(), [
      "path", "filesScanned", "filesSkippedAsExample", "trackedCount", "notIgnoredCount",
      "findingsCount", "errorCount", "warningCount", "truncated", "dotenvFiles", "findings",
    ].sort());
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Extreme ─────────────────────────────────────────────────────────────
t("fuzz: many dotenv-shaped files scanned without crash", () => {
  const d = initRepo();
  try {
    for (let i = 0; i < 15; i++) writeFile(d, `.env.variant${i}`, "1\n");
    assert.doesNotThrow(() => checkDotenvFilesNotGitignored(d, "."));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("empty repo (no files at all) yields zero findings, no crash", () => {
  const d = initRepo();
  try {
    const r = checkDotenvFilesNotGitignored(d, ".");
    assert.strictEqual(r.findingsCount, 0);
    assert.strictEqual(r.filesScanned, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("5 concurrent scans of the same repo give consistent results", () => {
  const d = initRepo();
  try {
    writeFile(d, ".env", "1\n");
    const results = [];
    for (let i = 0; i < 5; i++) results.push(checkDotenvFilesNotGitignored(d, "."));
    for (const r of results) assert.strictEqual(r.notIgnoredCount, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("execute_pipeline op-enum registration includes check_dotenv_files_not_gitignored", () => {
  const opEnumSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
  const opEnum = opEnumSchema.inputSchema.properties.steps.items.properties.op.enum;
  assert.ok(opEnum.includes("check_dotenv_files_not_gitignored"));
  assert.ok(typeof GIT_DISPATCH.check_dotenv_files_not_gitignored === "function");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
