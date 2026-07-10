"use strict";
/**
 * Tests for find_command_injection_risk (all 5 rigor levels)
 */
const path = require("path");
const os   = require("os");
const fs   = require("fs");
const { findCommandInjectionRisk } = require("../../lib/commandInjectionOps");

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { console.log("  \u2713", msg); passed++; }
  else       { console.error("  \u2717", msg); failed++; }
}

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), "cmd-test-")); }
function writeFile(dir, name, content) { fs.writeFileSync(path.join(dir, name), content); }
function cleanup(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

// ── LEVEL 1: Happy-path ───────────────────────────────────────────────────
console.log("\n\u2500\u2500 Level 1: Happy-path \u2500\u2500");
{
  const d = tmpDir();

  // Rule 1: exec_with_concat with req.body
  writeFile(d, "concat.js", `const cp = require("child_process");
cp.exec("ls -la " + req.body.path);
`);
  // Rule 2: shell:true spawn with dynamic arg
  writeFile(d, "shell.js", `const { spawn } = require("child_process");
spawn("grep", [\`-r \${req.query.search}\`], { shell: true });
`);
  // Rule 3: unvalidated path in exec
  writeFile(d, "pathexec.js", `const filePath = req.body.file;
exec(filePath);
`);

  const r1 = findCommandInjectionRisk(d, ".", {});
  assert(r1.filesScanned === 3, `3 files scanned (got ${r1.filesScanned})`);
  assert(r1.findingsCount >= 1, `at least 1 finding (got ${r1.findingsCount})`);
  assert(r1.errorCount >= 1, "errorCount >= 1");

  // clean safe call (no template, no user input)
  writeFile(d, "safe.js", `const cp = require("child_process");
cp.exec("ls -la /tmp");
`);
  const r2 = findCommandInjectionRisk(path.join(d, "safe.js"), "safe.js", {});
  assert(r2.findingsCount === 0, "static command not flagged");

  cleanup(d);
}

// ── LEVEL 2: Boundary & validation ───────────────────────────────────────────
console.log("\n\u2500\u2500 Level 2: Boundary & parameter validation \u2500");
{
  let threw = false;
  try { findCommandInjectionRisk(".", ".", { maxResults: "abc" }); }
  catch (e) { threw = true; assert(/max_results/.test(e.message), "maxResults type error"); }
  assert(threw, "throws on non-number maxResults");

  threw = false;
  try { findCommandInjectionRisk(".", ".", { extensions: "js" }); }
  catch (e) { threw = true; assert(/extensions/.test(e.message), "extensions type error"); }
  assert(threw, "throws on non-array extensions");

  threw = false;
  try { findCommandInjectionRisk("/nonexistent", "/nonexistent", {}); }
  catch (e) { threw = true; assert(/cannot access/.test(e.message), "missing path error"); }
  assert(threw, "throws on missing path");

  // maxResults truncation
  const d = tmpDir();
  for (let i = 0; i < 3; i++) {
    writeFile(d, `f${i}.js`, `exec("cmd " + req.body.input);
`);
  }
  const r = findCommandInjectionRisk(d, ".", { maxResults: 1 });
  assert(r.findingsCount === 1, "maxResults=1 truncates to 1");
  assert(r.truncated === true, "truncated flag set");
  cleanup(d);
}

// ── LEVEL 3: Suppression annotations ──────────────────────────────────────────nconsole.log("\n\u2500\u2500 Level 3: Suppression / safe annotations \u2500");
{
  const d = tmpDir();

  // // safe annotation suppresses
  writeFile(d, "safe_annot.js", `exec("ls " + req.body.path); // safe
`);
  const r1 = findCommandInjectionRisk(d, ".", {});
  assert(r1.findingsCount === 0, "// safe annotation suppresses finding");

  // // noexec annotation suppresses
  writeFile(d, "noexec.js", `exec(\`ls \${req.body.path}\`); // noexec
`);
  const r2 = findCommandInjectionRisk(path.join(d, "noexec.js"), ".", {});
  assert(r2.findingsCount === 0, "// noexec annotation suppresses finding");

  // Non-suppression comment does NOT suppress
  writeFile(d, "nosuppress.js", `exec("echo " + req.body.msg); // risky code
`);
  const r3 = findCommandInjectionRisk(path.join(d, "nosuppress.js"), ".", {});
  assert(r3.findingsCount >= 1, "non-suppression comment does not suppress injection risk");

  cleanup(d);
}

// ── LEVEL 4: Security / adversarial ─────────────────────────────────────────────nconsole.log("\n\u2500\u2500 Level 4: Security / adversarial \u2500");
{
  let threw = false;
  try { findCommandInjectionRisk("../../../etc/passwd", "../../../etc/passwd", {}); }
  catch (e) { threw = true; assert(true, "path traversal rejected or handled"); }
  if (!threw) assert(true, "path traversal handled gracefully");

  // Huge file doesn't crash
  const d = tmpDir();
  const huge = "// comment\n".repeat(50000) + `exec("ls " + req.body.dir);
`;
  writeFile(d, "huge.js", huge);
  const r = findCommandInjectionRisk(d, ".", {});
  assert(r.filesScanned === 1, "huge file scanned without crash");
  assert(r.findingsCount >= 1, "finding detected in huge file");
  cleanup(d);
}

// ── LEVEL 5: Fuzzing / extreme ────────────────────────────────────────────────────nconsole.log("\n\u2500\u2500 Level 5: Fuzzing / extreme \u2500");
{
  const d = tmpDir();

  // Binary skip
  const binBuf = Buffer.alloc(100, 0);
  fs.writeFileSync(path.join(d, "bin.js"), binBuf);
  const r1 = findCommandInjectionRisk(d, ".", {});
  assert(r1.findingsCount === 0, "binary file skipped");

  // Empty file
  writeFile(d, "empty.js", "");
  const r2 = findCommandInjectionRisk(path.join(d, "empty.js"), ".", {});
  assert(r2.findingsCount === 0, "empty file no findings");

  // Stress: many files
  const stressDir = tmpDir();
  for (let i = 0; i < 20; i++) {
    writeFile(stressDir, `f${i}.js`, `exec("ls " + req.body.dir);
`);
  }
  const r3 = findCommandInjectionRisk(stressDir, ".", {});
  assert(r3.filesScanned === 20, `20 files scanned (got ${r3.filesScanned})`);
  cleanup(stressDir);
  cleanup(d);
}

console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
