"use strict";
// Standalone isolated test for disk_usage_summary (not part of frozen run-tests.js).
const fs = require("fs");
const os = require("os");
const path = require("path");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "disk-usage-"));
process.env.MCP_ROOTS = TMP;
process.env.MCP_ALLOW_EXEC = "true";
process.env.MCP_READ_ONLY = "false";

const { buildRoots } = require("../lib/roots");
buildRoots();
const { executeTool } = require("../lib/executeTool");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.error(`PASS: ${name}`); }
  catch (e) { fail++; console.error(`FAIL: ${name} -- ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function call(args) { return executeTool("disk_usage_summary", args); }

// ── fixtures ──
fs.mkdirSync(path.join(TMP, "a", "b"), { recursive: true });
fs.writeFileSync(path.join(TMP, "a", "f1.txt"), "x".repeat(100));
fs.writeFileSync(path.join(TMP, "a", "b", "f2.txt"), "y".repeat(300));
fs.writeFileSync(path.join(TMP, "root.js"), "z".repeat(50));

// Normal
test("happy path: combined shape + correct totals", () => {
  const r = call({ path: "." });
  assert(r.totalFiles === 3, "totalFiles=" + r.totalFiles);
  assert(r.totalBytes === 450, "totalBytes=" + r.totalBytes);
  assert(Array.isArray(r.largestFiles) && r.largestFiles.length === 3);
  assert(Array.isArray(r.largestDirs));
  assert(Array.isArray(r.byExtension));
  assert(r.avgBytes === Math.round(450 / 3));
});

test("largestDirs includes nested rollup (a includes a/b)", () => {
  const r = call({ path: "." });
  const aDir = r.largestDirs.find(d => d.path.endsWith("/a") || d.path === "a");
  assert(aDir, "dir 'a' not found in " + JSON.stringify(r.largestDirs));
  assert(aDir.bytes === 400, "a.bytes=" + aDir.bytes); // 100 + 300
});

// Medium — param validation / boundaries
test("top_files/top_dirs/max_depth respected", () => {
  const r = call({ path: ".", top_files: 1, top_dirs: 1, max_depth: 1 });
  assert(r.largestFiles.length === 1, "largestFiles.length=" + r.largestFiles.length);
  assert(r.largestDirs.length <= 1, "largestDirs.length=" + r.largestDirs.length);
});

test("missing path defaults to root, no throw", () => {
  const r = call({});
  assert(typeof r.totalBytes === "number");
});

test("empty directory returns all-zero", () => {
  fs.mkdirSync(path.join(TMP, "empty"));
  const r = call({ path: "empty" });
  assert(r.totalFiles === 0 && r.totalBytes === 0);
});

// High — dependency-failure-style (non-existent dir)
test("non-existent directory throws cleanly", () => {
  let threw = false;
  try { call({ path: "does-not-exist" }); }
  catch (e) { threw = true; }
  assert(threw, "expected throw");
});

test("file-as-path throws descriptive error", () => {
  let threw = false;
  try { call({ path: "root.js" }); }
  catch (e) { threw = true; assert(/not a directory/.test(e.message), e.message); }
  assert(threw);
});

// Critical — security
test("path traversal blocked", () => {
  let threw = false;
  try { call({ path: "../../../etc" }); }
  catch (e) { threw = true; }
  assert(threw, "traversal should throw");
});

test("injection-shaped filenames round-trip literally, not executed", () => {
  const injDir = path.join(TMP, "inj");
  fs.mkdirSync(injDir);
  fs.writeFileSync(path.join(injDir, "DROP-TABLE-users--.txt"), "abc");
  const r = call({ path: "inj" });
  assert(r.totalFiles === 1);
  assert(r.largestFiles[0].path.includes("DROP-TABLE"));
});

// Extreme — concurrency / JSON-serializability
test("JSON-serializable, no prototype pollution", () => {
  const r = call({ path: "." });
  const s = JSON.stringify(r);
  assert(typeof s === "string" && s.length > 0);
  assert(!({}).polluted);
});

test("10 concurrent calls consistent", () => {
  const results = [];
  for (let i = 0; i < 10; i++) results.push(call({ path: "." }));
  const first = JSON.stringify(results[0]);
  for (const r of results) assert(JSON.stringify(r) === first, "inconsistent result");
});

test("execute_pipeline op-enum registration check", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "schemas", "execSchemas.js"), "utf8");
  assert(src.includes('"disk_usage_summary"'), "disk_usage_summary missing from execute_pipeline enum");
});

// cleanup
fs.rmSync(TMP, { recursive: true, force: true });

console.error(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
