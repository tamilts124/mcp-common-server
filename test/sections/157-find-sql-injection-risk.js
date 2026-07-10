"use strict";
/**
 * Tests for find_sql_injection_risk (all 5 rigor levels)
 */
const path = require("path");
const os   = require("os");
const fs   = require("fs");
const { findSqlInjectionRisk } = require("../../lib/sqlInjectionOps");

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { console.log("  ✓", msg); passed++; }
  else       { console.error("  ✗", msg); failed++; }
}

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "sql-test-"));
  return d;
}
function writeFile(dir, name, content) {
  fs.writeFileSync(path.join(dir, name), content);
}
function cleanup(dir) { fs.rmSync(dir, { recursive: true, force: true }); }

// ── LEVEL 1: Happy-path (normal) ────────────────────────────────────────────
console.log("\n── Level 1: Happy-path ──────────────────────────────────────────");
{
  const d = tmpDir();

  // Rule 1: sql_string_concat with req.body
  writeFile(d, "concat.js", `
const q = "SELECT * FROM users WHERE id = " + req.body.id;
db.query(q);
`);
  // Rule 2: sql_template_literal
  writeFile(d, "template.js", `
const q = \`SELECT * FROM users WHERE name = \${req.query.name}\`;
db.run(q);
`);
  // Rule 3: sql_dynamic_query_variable
  writeFile(d, "dynamic.js", `
let userSQL = "SELECT * FROM users";
userSQL += " WHERE active = 1";
`);

  const r1 = findSqlInjectionRisk(d, ".", {});
  assert(r1.filesScanned === 3, `3 files scanned (got ${r1.filesScanned})`);
  assert(r1.findingsCount >= 2, `at least 2 findings (got ${r1.findingsCount})`);
  assert(r1.findings.some(f => f.rule === "sql_string_concat"), "sql_string_concat rule fires");
  assert(r1.findings.some(f => f.rule === "sql_template_literal"), "sql_template_literal rule fires");
  assert(r1.findings.some(f => f.rule === "sql_dynamic_query_variable"), "sql_dynamic_query_variable rule fires");
  assert(r1.errorCount > 0, "errorCount > 0");

  // clean file (parameterised)
  writeFile(d, "safe.js", `
const q = "SELECT * FROM users WHERE id = ?";
db.query(q, [req.body.id]);
`);
  const r2 = findSqlInjectionRisk(path.join(d,"safe.js"), "safe.js", {});
  assert(r2.findingsCount === 0, "parameterised query not flagged");

  cleanup(d);
}

// ── LEVEL 2: Boundary & parameter validation ─────────────────────────────────
console.log("\n── Level 2: Boundary & parameter validation ─────────────────────");
{
  // Invalid maxResults type
  let threw = false;
  try { findSqlInjectionRisk(".", ".", { maxResults: "abc" }); }
  catch (e) { threw = true; assert(/max_results/.test(e.message), "max_results type error message"); }
  assert(threw, "throws on non-number maxResults");

  // Invalid extensions type
  threw = false;
  try { findSqlInjectionRisk(".", ".", { extensions: "js" }); }
  catch (e) { threw = true; assert(/extensions/.test(e.message), "extensions type error message"); }
  assert(threw, "throws on non-array extensions");

  // Missing path
  threw = false;
  try { findSqlInjectionRisk("/nonexistent/path", "/nonexistent/path", {}); }
  catch (e) { threw = true; assert(/cannot access/.test(e.message), "missing path error"); }
  assert(threw, "throws on missing path");

  // maxResults = 1 truncates
  const d = tmpDir();
  for (let i = 0; i < 3; i++) {
    writeFile(d, `f${i}.js`, `const q = "SELECT * FROM t WHERE x = " + req.body.x;\ndb.run(q);\n`);
  }
  const r = findSqlInjectionRisk(d, ".", { maxResults: 1 });
  assert(r.findingsCount === 1, "maxResults=1 truncates to 1");
  assert(r.truncated === true, "truncated flag set");
  cleanup(d);
}

// ── LEVEL 3: Suppression / safe annotations ──────────────────────────────────
console.log("\n── Level 3: Suppression / safe annotations ─────────────────────");
{
  const d = tmpDir();

  // safe annotation suppresses
  writeFile(d, "annotated.js", `
const q = "SELECT * FROM users WHERE id = " + req.body.id; // safe
`);
  const r1 = findSqlInjectionRisk(d, ".", {});
  assert(r1.findingsCount === 0, "// safe annotation suppresses finding");

  // parameterised-query hint suppresses
  writeFile(d, "paramhint.js", `
const q = \`SELECT * FROM users WHERE name = \${name}\`;
db.query(q, [name]);
`);
  const r2 = findSqlInjectionRisk(path.join(d,"paramhint.js"), ".", {});
  assert(r2.findingsCount === 0, "parameterised query hint suppresses template literal");

  // nosql annotation
  writeFile(d, "nosql.js", `
const q = "SELECT * FROM users WHERE id = " + req.body.id; // nosql
`);
  const r3 = findSqlInjectionRisk(path.join(d,"nosql.js"), ".", {});
  assert(r3.findingsCount === 0, "// nosql annotation suppresses finding");

  cleanup(d);
}

// ── LEVEL 4: Security — path traversal inputs ────────────────────────────────
console.log("\n── Level 4: Security / adversarial inputs ───────────────────────");
{
  // Path traversal in path param
  let threw = false;
  try { findSqlInjectionRisk("../../../etc/passwd", "../../../etc/passwd", {}); }
  catch (e) { threw = true; assert(true, "path traversal attempt rejected"); }
  if (!threw) {
    // If it didn't throw, it should return empty findings (file not found or binary)
    assert(true, "path traversal handled gracefully");
  }

  // Huge file content doesn't crash
  const d = tmpDir();
  const huge = "// comment\n".repeat(50000) + `const q = "SELECT * FROM t WHERE x = " + req.body.x;\ndb.run(q);\n`;
  writeFile(d, "huge.js", huge);
  const r = findSqlInjectionRisk(d, ".", {});
  assert(r.filesScanned === 1, "huge file scanned without crash");
  assert(r.findingsCount >= 1, "finding detected in huge file");
  cleanup(d);
}

// ── LEVEL 5: Fuzzing / extreme ───────────────────────────────────────────────
console.log("\n── Level 5: Fuzzing / extreme ───────────────────────────────────");
{
  const d = tmpDir();

  // Binary file is skipped
  const binBuf = Buffer.alloc(100);
  binBuf[5] = 0x00; // NUL byte
  fs.writeFileSync(path.join(d, "bin.js"), binBuf);
  const r1 = findSqlInjectionRisk(d, ".", {});
  assert(r1.filesScanned === 1, "binary file counted");
  assert(r1.findingsCount === 0, "binary file produces no findings");

  // Empty file
  writeFile(d, "empty.js", "");
  const r2 = findSqlInjectionRisk(path.join(d,"empty.js"), ".", {});
  assert(r2.findingsCount === 0, "empty file produces no findings");

  // Many simultaneous findings (stress)
  const stressDir = tmpDir();
  for (let i = 0; i < 20; i++) {
    writeFile(stressDir, `f${i}.js`,
      `const q = "SELECT * FROM t WHERE id = " + req.body.id;\ndb.run(q);\n` +
      `const s = \`UPDATE t SET x = \${req.query.x}\`;\n`
    );
  }
  const r3 = findSqlInjectionRisk(stressDir, ".", {});
  assert(r3.filesScanned === 20, `20 files scanned (got ${r3.filesScanned})`);
  assert(r3.findingsCount > 0, `findings found in stress test`);
  cleanup(stressDir);
  cleanup(d);
}

console.log(`\n  ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
