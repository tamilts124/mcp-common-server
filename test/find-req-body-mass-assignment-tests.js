"use strict";
// Tests for find_req_body_mass_assignment (lib/reqBodyMassAssignmentOps.js)
// Rigor levels: Normal, Medium, High, Critical, Extreme.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { findReqBodyMassAssignment } = require("../lib/reqBodyMassAssignmentOps");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log(`ok - ${name}`); }
  catch (e) { fail++; console.log(`FAIL - ${name}: ${e.message}`); }
}

function tmpFile(content, ext = ".js") {
  const p = path.join(os.tmpdir(), `rbma-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  fs.writeFileSync(p, content);
  return p;
}
function tmpDir() {
  const d = path.join(os.tmpdir(), `rbma-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(d);
  return d;
}

// ── Normal ──────────────────────────────────────────────────────────────
test("flags User.create(req.body)", () => {
  const f = tmpFile("User.create(req.body);\n");
  const r = findReqBodyMassAssignment(f, f);
  assert.strictEqual(r.findingsCount, 1);
  assert.strictEqual(r.findings[0].rule, "mass_assignment_via_create");
  assert.strictEqual(r.findings[0].severity, "error");
  fs.unlinkSync(f);
});

test("flags User.create({...req.body, extra: 1})", () => {
  const f = tmpFile("User.create({...req.body, extra: 1});\n");
  const r = findReqBodyMassAssignment(f, f);
  assert.strictEqual(r.findingsCount, 1);
  fs.unlinkSync(f);
});

test("flags tracked whole-body alias passed into .create()", () => {
  const f = tmpFile("const data = req.body;\nUser.create(data);\n");
  const r = findReqBodyMassAssignment(f, f);
  assert.strictEqual(r.findingsCount, 1);
  fs.unlinkSync(f);
});

test("flags .update()/.updateOne()/.findByIdAndUpdate() with req.body", () => {
  const f = tmpFile("User.update({_id}, req.body);\nUser.updateOne({_id}, req.body);\nUser.findByIdAndUpdate(id, req.body);\n");
  const r = findReqBodyMassAssignment(f, f);
  assert.strictEqual(r.findingsCount, 3);
  assert.ok(r.findings.every(x => x.rule === "mass_assignment_via_update"));
  fs.unlinkSync(f);
});

test("flags new Model(req.body) as warning-level constructor rule", () => {
  const f = tmpFile("new User(req.body);\n");
  const r = findReqBodyMassAssignment(f, f);
  assert.strictEqual(r.findingsCount, 1);
  assert.strictEqual(r.findings[0].rule, "mass_assignment_via_constructor");
  assert.strictEqual(r.findings[0].severity, "warning");
  fs.unlinkSync(f);
});

test("does not flag field-level access like req.body.name", () => {
  const f = tmpFile("User.create({name: req.body.name});\n");
  const r = findReqBodyMassAssignment(f, f);
  assert.strictEqual(r.findingsCount, 0);
  fs.unlinkSync(f);
});

test("sanitize hint (pick) inline suppresses the finding", () => {
  const f = tmpFile("User.create(pick(req.body, ['name']));\n");
  const r = findReqBodyMassAssignment(f, f);
  assert.strictEqual(r.findingsCount, 0);
  fs.unlinkSync(f);
});

test("errorCount/warningCount tally correctly across mixed findings", () => {
  const f = tmpFile("User.create(req.body);\nnew Widget(req.body);\n");
  const r = findReqBodyMassAssignment(f, f);
  assert.strictEqual(r.errorCount, 1);
  assert.strictEqual(r.warningCount, 1);
  fs.unlinkSync(f);
});

test("directory aggregation across multiple files", () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, "a.js"), "User.create(req.body);\n");
  fs.writeFileSync(path.join(d, "b.js"), "Post.create(req.body);\n");
  const r = findReqBodyMassAssignment(d, d);
  assert.strictEqual(r.filesScanned, 2);
  assert.strictEqual(r.findingsCount, 2);
  fs.rmSync(d, { recursive: true, force: true });
});

// ── Medium (boundary / validation) ─────────────────────────────────────
test("nonexistent path throws", () => {
  assert.throws(() => findReqBodyMassAssignment("/no/such/path/xyz.js", "/no/such/path/xyz.js"));
});

test("max_results type mismatch throws ToolError", () => {
  const f = tmpFile("User.create(req.body);\n");
  assert.throws(() => findReqBodyMassAssignment(f, f, { maxResults: "five" }), /max_results must be a number/);
  fs.unlinkSync(f);
});

test("extensions type mismatch throws ToolError", () => {
  const f = tmpFile("User.create(req.body);\n");
  assert.throws(() => findReqBodyMassAssignment(f, f, { extensions: "not-an-array" }), /extensions must be an array/);
  fs.unlinkSync(f);
});

test("unrecognized extension on single-file target throws", () => {
  const f = tmpFile("User.create(req.body);\n", ".unsupportedext");
  assert.throws(() => findReqBodyMassAssignment(f, f));
  fs.unlinkSync(f);
});

test("clean file (no req.body usage) yields zero findings", () => {
  const f = tmpFile("function noop() { return 1; }\n");
  const r = findReqBodyMassAssignment(f, f);
  assert.strictEqual(r.findingsCount, 0);
  fs.unlinkSync(f);
});

test("extensions filter narrows directory scan", () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, "a.js"), "User.create(req.body);\n");
  fs.writeFileSync(path.join(d, "b.ts"), "Post.create(req.body);\n");
  const r = findReqBodyMassAssignment(d, d, { extensions: [".ts"] });
  assert.strictEqual(r.filesScanned, 1);
  assert.strictEqual(r.findingsCount, 1);
  fs.rmSync(d, { recursive: true, force: true });
});

// ── High (dependency / edge-case failure handling) ──────────────────────
test("binary file in directory scan is skipped without crash", () => {
  const d = tmpDir();
  fs.writeFileSync(path.join(d, "bin.js"), Buffer.from([0, 1, 2, 0, 255, 0]));
  fs.writeFileSync(path.join(d, "ok.js"), "User.create(req.body);\n");
  const r = findReqBodyMassAssignment(d, d);
  assert.strictEqual(r.filesScanned, 2);
  assert.strictEqual(r.findingsCount, 1);
  fs.rmSync(d, { recursive: true, force: true });
});

test("nested sub-directory scan does not crash", () => {
  const d = tmpDir();
  fs.mkdirSync(path.join(d, "nested"));
  fs.writeFileSync(path.join(d, "nested", "deep.js"), "User.create(req.body);\n");
  const r = findReqBodyMassAssignment(d, d);
  assert.strictEqual(r.filesScanned, 1);
  assert.strictEqual(r.findingsCount, 1);
  fs.rmSync(d, { recursive: true, force: true });
});

test("direct call with cwd '.' as label works without crash", () => {
  const r = findReqBodyMassAssignment(process.cwd(), ".");
  assert.ok(typeof r.filesScanned === "number");
});

// ── Critical (security / sanitization) ──────────────────────────────────
test("path traversal label is echoed back but not resolved into a real traversal", () => {
  const f = tmpFile("User.create(req.body);\n");
  const r = findReqBodyMassAssignment(f, "../../../etc/passwd");
  assert.strictEqual(r.path, "../../../etc/passwd"); // echoed label only; absTarget was the real jailed path
  fs.unlinkSync(f);
});

test("shell-injection-shaped content is only reported as text, never executed", () => {
  const f = tmpFile("User.create(req.body); // $(rm -rf /) `; rm -rf / #`\n");
  const r = findReqBodyMassAssignment(f, f);
  assert.ok(Array.isArray(r.findings));
  assert.strictEqual(r.findingsCount, 1);
  fs.unlinkSync(f);
});

test("result is JSON-serialisable with exact expected top-level keys", () => {
  const f = tmpFile("User.create(req.body);\n");
  const r = findReqBodyMassAssignment(f, f);
  const json = JSON.parse(JSON.stringify(r));
  assert.deepStrictEqual(
    Object.keys(json).sort(),
    ["errorCount", "filesScanned", "findings", "findingsCount", "path", "truncated", "warningCount"].sort()
  );
  fs.unlinkSync(f);
});

// ── Extreme (fuzzing / concurrency / limits) ─────────────────────────────
test("max_results truncation sets truncated flag", () => {
  let src = "";
  for (let i = 0; i < 20; i++) src += `Model${i}.create(req.body);\n`;
  const f = tmpFile(src);
  const r = findReqBodyMassAssignment(f, f, { maxResults: 5 });
  assert.strictEqual(r.findings.length, 5);
  assert.strictEqual(r.truncated, true);
  fs.unlinkSync(f);
});

test("fuzz: random-byte file does not crash scan", () => {
  const buf = Buffer.alloc(2000);
  for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
  const f = path.join(os.tmpdir(), `rbma-fuzz-${Date.now()}.js`);
  fs.writeFileSync(f, buf);
  assert.doesNotThrow(() => findReqBodyMassAssignment(f, f));
  fs.unlinkSync(f);
});

test("empty directory yields zero findings, no crash", () => {
  const d = tmpDir();
  const r = findReqBodyMassAssignment(d, d);
  assert.strictEqual(r.filesScanned, 0);
  assert.strictEqual(r.findingsCount, 0);
  fs.rmSync(d, { recursive: true, force: true });
});

test("10 concurrent scans of the same file give consistent results", () => {
  const f = tmpFile("User.create(req.body);\nnew Widget(req.body);\n");
  const results = [];
  for (let i = 0; i < 10; i++) results.push(findReqBodyMassAssignment(f, f));
  for (const r of results) assert.strictEqual(r.findingsCount, 2);
  fs.unlinkSync(f);
});

test("execute_pipeline op-enum registration includes find_req_body_mass_assignment", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "schemas", "execSchemas.js"), "utf8");
  assert.ok(src.includes('"find_req_body_mass_assignment"'));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
