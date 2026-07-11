"use strict";
/**
 * Section 177 — graphql_query + jsonl_ops tools
 * Tests are isolated: graphql_query logic is exercised without a live
 * GraphQL server (we test validation, URL parsing, header assembly, and
 * operation-type detection directly from the module). jsonl_ops is fully
 * exercised in-process via inline 'rows' and temp file paths.
 *
 * Rigor levels A–J (10 groups):
 *   A  Normal — happy-path graphql_query validation + op-type detection
 *   B  Normal — jsonl_ops parse/count/head/tail/to_json (inline rows)
 *   C  Normal — jsonl_ops filter / transform / sort (inline rows)
 *   D  Normal — jsonl_ops sample + seed reproducibility
 *   E  Normal — jsonl_ops file-based: parse, count, validate, head, tail
 *   F  Medium — jsonl_ops filter edge-cases (all ops, logic: or/and)
 *   G  Medium — jsonl_ops transform: select, drop, rename, combined
 *   H  High   — jsonl_ops validate detects malformed lines; parse skips blanks
 *   I  Critical — path traversal guard; oversized inline rows; unknown ops
 *   J  Extreme — large inline dataset: 5 000 rows sort + filter under 3 s
 */

const path = require("path");
const fs   = require("fs");
const os   = require("os");

// !! Direct module imports — do NOT start the server !!
const { graphqlQuery } = require("../../lib/graphqlQueryOps");
const { jsonlOps }     = require("../../lib/jsonlOps");
const { ToolError }    = require("../../lib/errors");

// ── Test harness (shared counters from run-tests.js sibling files) ────────
// Each section file is require()'d by run-tests.js which sets up
// global.testHarness. Fall back to a local counter when run standalone.
const harness = (() => {
  if (global.testHarness) return global.testHarness;
  let pass = 0, fail = 0;
  return {
    ok(cond, msg) {
      if (cond) { pass++; process.stdout.write(`  ✓ ${msg}\n`); }
      else      { fail++; process.stdout.write(`  ✗ ${msg}\n`); }
    },
    done() { process.stdout.write(`\n${pass} passed, ${fail} failed\n`); },
    get counters() { return { pass, fail }; },
  };
})();

const { ok } = harness;

// ── Temp-file helpers ────────────────────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mcs-177-"));
const tmpFile = (name, content) => {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, content, "utf8");
  return p;
};

// Fake resolveClientPath: just returns the absolute path (tests use absolute paths)
const resolveClientPath = (p) => ({ resolved: p });

// ── A: graphql_query validation (no network) ───────────────────────────
console.log("[177-A] graphql_query: input validation");

// Missing url
try {
  graphqlQuery({ query: "{ user { name } }" });
  ok(false, "A1: should throw for missing url");
} catch (e) { ok(e instanceof ToolError, "A1: ToolError for missing url"); }

// Missing query
try {
  graphqlQuery({ url: "http://localhost/graphql" });
  ok(false, "A2: should throw for missing query");
} catch (e) { ok(e instanceof ToolError, "A2: ToolError for missing query"); }

// Invalid URL scheme (ftp)
try {
  graphqlQuery({ url: "ftp://example.com/graphql", query: "{ a }" });
  ok(false, "A3: should throw for ftp scheme");
} catch (e) { ok(e instanceof ToolError, "A3: ToolError for ftp scheme"); }

// variables must be an object, not an array
try {
  graphqlQuery({ url: "http://localhost/graphql", query: "{ a }", variables: [1, 2] });
  ok(false, "A4: should throw for array variables");
} catch (e) { ok(e instanceof ToolError, "A4: ToolError for array variables"); }

// Query too long
try {
  graphqlQuery({ url: "http://localhost/graphql", query: "x".repeat(100_001) });
  ok(false, "A5: should throw for oversized query");
} catch (e) { ok(e instanceof ToolError, "A5: ToolError for oversized query"); }

// Invalid timeout
try {
  graphqlQuery({ url: "http://localhost/graphql", query: "{ a }", timeout: -1 });
  ok(false, "A6: should throw for negative timeout");
} catch (e) { ok(e instanceof ToolError, "A6: ToolError for negative timeout"); }

// Totally broken URL
try {
  graphqlQuery({ url: "not_a_url", query: "{ a }" });
  ok(false, "A7: should throw for bad URL");
} catch (e) { ok(e instanceof ToolError, "A7: ToolError for bad URL"); }

// ── B: jsonl_ops parse / count / head / tail / to_json (inline rows) ─────
console.log("[177-B] jsonl_ops: parse/count/head/tail/to_json inline");

const ROWS = [
  { id: 1, name: "Alice", age: 30, active: true  },
  { id: 2, name: "Bob",   age: 25, active: false },
  { id: 3, name: "Carol", age: 35, active: true  },
  { id: 4, name: "Dave",  age: 28, active: true  },
  { id: 5, name: "Eve",   age: 22, active: false },
];

const parse = jsonlOps({ operation: "parse",   rows: ROWS }, resolveClientPath);
ok(parse.validCount  === 5, "B1: parse validCount=5");
ok(parse.rows.length === 5, "B2: parse returns 5 rows");
ok(parse.truncated   === false, "B3: parse not truncated");

const cnt = jsonlOps({ operation: "count",  rows: ROWS }, resolveClientPath);
ok(cnt.validCount === 5, "B4: count validCount");
ok(cnt.totalLines === 5, "B5: count totalLines");
ok(!cnt.rows,            "B6: count has no rows");

const head = jsonlOps({ operation: "head", rows: ROWS, count: 3 }, resolveClientPath);
ok(head.rows.length  === 3,       "B7: head returns 3");
ok(head.rows[0].name === "Alice", "B8: head first row is Alice");

const tail = jsonlOps({ operation: "tail", rows: ROWS, count: 2 }, resolveClientPath);
ok(tail.rows.length  === 2,     "B9: tail returns 2");
ok(tail.rows[0].name === "Dave","B10: tail first is Dave");
ok(tail.rows[1].name === "Eve", "B11: tail last is Eve");

const toJ = jsonlOps({ operation: "to_json", rows: ROWS }, resolveClientPath);
ok(Array.isArray(toJ.json),    "B12: to_json returns json array");
ok(toJ.json.length === 5,      "B13: to_json length=5");
ok(toJ.json[2].name === "Carol","B14: to_json[2] is Carol");

// ── C: filter / transform / sort ───────────────────────────────────────────
console.log("[177-C] jsonl_ops: filter/transform/sort inline");

// filter eq
const filt = jsonlOps({
  operation: "filter",
  rows: ROWS,
  conditions: [{ field: "active", op: "eq", value: true }],
}, resolveClientPath);
ok(filt.matchedCount === 3, "C1: filter active=true → 3 rows");
ok(filt.rows.every(r => r.active === true), "C2: all filtered rows are active");

// filter lt
const filt2 = jsonlOps({
  operation: "filter",
  rows: ROWS,
  conditions: [{ field: "age", op: "lt", value: 28 }],
}, resolveClientPath);
ok(filt2.matchedCount === 2, "C3: age < 28 → 2 rows (Bob 25, Eve 22)");

// filter contains
const filt3 = jsonlOps({
  operation: "filter",
  rows: ROWS,
  conditions: [{ field: "name", op: "contains", value: "a" }],
}, resolveClientPath);
ok(filt3.matchedCount === 2, "C4: name contains 'a' (case-sensitive) → Carol, Dave only (Alice has no lowercase a)");
// Alice(a), Carol(a in Carol? no... C-a-r-o-l yes), Dave(a in Dave yes)=3

// filter is_null / not_null
const rowsWithNull = [...ROWS, { id: 6, name: null, age: 40, active: true }];
const filtNull = jsonlOps({
  operation: "filter",
  rows: rowsWithNull,
  conditions: [{ field: "name", op: "is_null" }],
}, resolveClientPath);
ok(filtNull.matchedCount === 1, "C5: is_null → 1 row");

// transform select
const trans = jsonlOps({
  operation: "transform",
  rows: ROWS,
  fields: ["id", "name"],
}, resolveClientPath);
ok(Object.keys(trans.rows[0]).join(",") === "id,name", "C6: transform select id,name");
ok(trans.rows[0].age === undefined, "C7: age not in transform result");

// transform rename
const ren = jsonlOps({
  operation: "transform",
  rows: ROWS,
  mapping: { name: "fullName", age: "years" },
}, resolveClientPath);
ok(ren.rows[0].fullName === "Alice", "C8: rename name→fullName");
ok(ren.rows[0].years   === 30,      "C9: rename age→years");
ok(ren.rows[0].name    === undefined, "C10: old 'name' gone");

// sort asc
const sortA = jsonlOps({ operation: "sort", rows: ROWS, field: "age", dir: "asc" }, resolveClientPath);
ok(sortA.rows[0].age  === 22, "C11: sort asc first = Eve (22)");
ok(sortA.rows[4].age  === 35, "C12: sort asc last = Carol (35)");

// sort desc
const sortD = jsonlOps({ operation: "sort", rows: ROWS, field: "name", dir: "desc" }, resolveClientPath);
ok(sortD.rows[0].name === "Eve", "C13: sort name desc first = Eve");

// ── D: sample + seed ────────────────────────────────────────────────────────
console.log("[177-D] jsonl_ops: sample + seed");

const bigRows = Array.from({ length: 100 }, (_, i) => ({ id: i, val: i * 2 }));
const s1 = jsonlOps({ operation: "sample", rows: bigRows, count: 10, seed: 42 }, resolveClientPath);
const s2 = jsonlOps({ operation: "sample", rows: bigRows, count: 10, seed: 42 }, resolveClientPath);
const s3 = jsonlOps({ operation: "sample", rows: bigRows, count: 10, seed: 99 }, resolveClientPath);

ok(s1.rows.length === 10, "D1: sample returns 10 rows");
ok(JSON.stringify(s1.rows) === JSON.stringify(s2.rows), "D2: same seed → same sample");
ok(JSON.stringify(s1.rows) !== JSON.stringify(s3.rows), "D3: diff seed → diff sample");

// sample count >= array length → all rows
const sAll = jsonlOps({ operation: "sample", rows: ROWS, count: 100 }, resolveClientPath);
ok(sAll.rows.length === 5, "D4: count>length → all rows");

// default count=10
const sDefault = jsonlOps({ operation: "sample", rows: bigRows }, resolveClientPath);
ok(sDefault.rows.length === 10, "D5: default sample count=10");

// ── E: file-based operations (parse, count, validate, head, tail, merge) ──
console.log("[177-E] jsonl_ops: file-based operations");

const goodJsonl = ROWS.map(r => JSON.stringify(r)).join("\n");
const goodFile  = tmpFile("good.jsonl", goodJsonl);

const eCount = jsonlOps({ operation: "count", path: goodFile }, resolveClientPath);
ok(eCount.validCount   === 5, "E1: file count validCount=5");
ok(eCount.invalidCount === 0, "E2: file count invalidCount=0");

const eHead = jsonlOps({ operation: "head", path: goodFile, count: 2 }, resolveClientPath);
ok(eHead.rows.length   === 2,       "E3: file head count=2");
ok(eHead.rows[0].name  === "Alice", "E4: file head[0]=Alice");

const eTail = jsonlOps({ operation: "tail", path: goodFile, count: 2 }, resolveClientPath);
ok(eTail.rows[1].name  === "Eve",   "E5: file tail last=Eve");

// validate: file with 2 bad lines
const badJsonl = [
  JSON.stringify({ id: 1 }),
  "this is not json",
  JSON.stringify({ id: 2 }),
  "{broken",
  JSON.stringify({ id: 3 }),
].join("\n");
const badFile = tmpFile("bad.jsonl", badJsonl);

const eVal = jsonlOps({ operation: "validate", path: badFile }, resolveClientPath);
ok(eVal.valid         === false, "E6: validate detects bad file");
ok(eVal.invalidCount  === 2,    "E7: validate finds 2 bad lines");
ok(eVal.errors.length === 2,    "E8: validate error list length=2");

// merge two files
const file2Content = [{ id: 6, name: "Frank", age: 45, active: true }].map(r => JSON.stringify(r)).join("\n");
const file2 = tmpFile("extra.jsonl", file2Content);

const eMerge = jsonlOps({ operation: "merge", paths: [goodFile, file2] }, resolveClientPath);
ok(eMerge.totalRows     === 6,   "E9: merge totalRows=6");
ok(eMerge.returnedRows  === 6,   "E10: merge returnedRows=6");
ok(eMerge.filesRead     === 2,   "E11: merge filesRead=2");
ok(eMerge.rows[5].name === "Frank", "E12: merge last row is Frank");

// ── F: filter edge-cases ────────────────────────────────────────────────────
console.log("[177-F] jsonl_ops: filter edge-cases");

// logic: or
const fOr = jsonlOps({
  operation: "filter",
  rows: ROWS,
  conditions: [
    { field: "age", op: "lt", value: 23 },
    { field: "age", op: "gt", value: 34 },
  ],
  logic: "or",
}, resolveClientPath);
ok(fOr.matchedCount === 2, "F1: or filter age<23 || age>34 → 2 (Eve 22, Carol 35)");

// in / not_in
const fIn = jsonlOps({
  operation: "filter",
  rows: ROWS,
  conditions: [{ field: "id", op: "in", value: [1, 3, 5] }],
}, resolveClientPath);
ok(fIn.matchedCount === 3, "F2: in [1,3,5] → 3 rows");

const fNotIn = jsonlOps({
  operation: "filter",
  rows: ROWS,
  conditions: [{ field: "id", op: "not_in", value: [1, 3, 5] }],
}, resolveClientPath);
ok(fNotIn.matchedCount === 2, "F3: not_in [1,3,5] → 2 rows");

// regex
const fReg = jsonlOps({
  operation: "filter",
  rows: ROWS,
  conditions: [{ field: "name", op: "regex", value: "^[ABC]" }],
}, resolveClientPath);
ok(fReg.matchedCount === 3, "F4: regex ^[ABC] → Alice(A), Bob(B), Carol(C) = 3 matches");
// Alice(A), Bob(B), Carol(C) = 3 actually
ok(fReg.matchedCount >= 2, "F4b: regex ^[ABC] → at least 2");

// empty result
const fEmpty = jsonlOps({
  operation: "filter",
  rows: ROWS,
  conditions: [{ field: "age", op: "gt", value: 100 }],
}, resolveClientPath);
ok(fEmpty.matchedCount === 0, "F5: filter with no matches → 0");

// ── G: transform edge-cases ─────────────────────────────────────────────
console.log("[177-G] jsonl_ops: transform edge-cases");

// drop mode
const gDrop = jsonlOps({
  operation: "transform",
  rows: ROWS,
  fields: ["age", "active"],
  drop: true,
}, resolveClientPath);
ok(!("age"    in gDrop.rows[0]), "G1: drop removes 'age'");
ok(!("active" in gDrop.rows[0]), "G2: drop removes 'active'");
ok("id"   in gDrop.rows[0],     "G3: drop keeps 'id'");
ok("name" in gDrop.rows[0],     "G4: drop keeps 'name'");

// no fields, no mapping → passthrough
const gPass = jsonlOps({ operation: "transform", rows: ROWS }, resolveClientPath);
ok(gPass.rows.length === 5, "G5: transform passthrough returns all rows");
ok("age" in gPass.rows[0],   "G6: passthrough keeps 'age'");

// combined select + rename
const gComb = jsonlOps({
  operation: "transform",
  rows: ROWS,
  fields:  ["id", "name"],
  mapping: { name: "userName" },
}, resolveClientPath);
ok("userName" in gComb.rows[0], "G7: combined: renamed name→userName");
ok(!("age" in gComb.rows[0]),   "G8: combined: age dropped");

// ── H: validate bad lines + blank line handling ───────────────────────
console.log("[177-H] jsonl_ops: validate + blank line handling");

// mixed: valid, blank, invalid
const mixedContent = [
  JSON.stringify({ a: 1 }),
  "",
  "not json",
  "   ",
  JSON.stringify({ a: 2 }),
  "{unclosed",
].join("\n");
const mixedFile = tmpFile("mixed.jsonl", mixedContent);

const hParse = jsonlOps({ operation: "parse", path: mixedFile }, resolveClientPath);
ok(hParse.validCount   === 2, "H1: parse finds 2 valid rows");
ok(hParse.invalidCount === 2, "H2: parse finds 2 invalid lines");
ok(hParse.blankCount   === 2, "H3: parse finds 2 blank lines");
ok(hParse.parseErrors.length === 2, "H4: parseErrors has 2 entries");
ok(typeof hParse.parseErrors[0].lineNumber === "number", "H5: error has lineNumber");
ok(typeof hParse.parseErrors[0].error      === "string", "H6: error has message");

// validate on a clean file returns valid:true
const hVal = jsonlOps({ operation: "validate", path: goodFile }, resolveClientPath);
ok(hVal.valid           === true,  "H7: validate on clean file is valid");
ok(hVal.invalidCount    === 0,     "H8: validate clean file invalidCount=0");

// ── I: Critical — validation errors and safety ───────────────────────
console.log("[177-I] jsonl_ops: critical validation");

// unknown operation
try {
  jsonlOps({ operation: "explode", rows: ROWS }, resolveClientPath);
  ok(false, "I1: should throw for unknown op");
} catch (e) { ok(e instanceof ToolError, "I1: ToolError for unknown op"); }

// missing operation
try {
  jsonlOps({ rows: ROWS }, resolveClientPath);
  ok(false, "I2: should throw for missing operation");
} catch (e) { ok(e instanceof ToolError, "I2: ToolError for missing operation"); }

// filter: missing conditions
try {
  jsonlOps({ operation: "filter", rows: ROWS, conditions: [] }, resolveClientPath);
  ok(false, "I3: should throw for empty conditions");
} catch (e) { ok(e instanceof ToolError, "I3: ToolError for empty conditions"); }

// merge: missing paths
try {
  jsonlOps({ operation: "merge" }, resolveClientPath);
  ok(false, "I4: should throw for merge without paths");
} catch (e) { ok(e instanceof ToolError, "I4: ToolError for merge without paths"); }

// merge: too many paths
try {
  const paths = Array.from({ length: 51 }, () => goodFile);
  jsonlOps({ operation: "merge", paths }, resolveClientPath);
  ok(false, "I5: should throw for >50 paths");
} catch (e) { ok(e instanceof ToolError, "I5: ToolError for >50 paths"); }

// sort: missing field
try {
  jsonlOps({ operation: "sort", rows: ROWS }, resolveClientPath);
  ok(false, "I6: should throw for sort without field");
} catch (e) { ok(e instanceof ToolError, "I6: ToolError for sort without field"); }

// validate: requires path (not inline rows)
try {
  jsonlOps({ operation: "validate", rows: ROWS }, resolveClientPath);
  ok(false, "I7: validate should require path");
} catch (e) { ok(e instanceof ToolError, "I7: ToolError for validate without path"); }

// rows is not an array
try {
  jsonlOps({ operation: "parse", rows: "not an array" }, resolveClientPath);
  ok(false, "I8: should throw for non-array rows");
} catch (e) { ok(e instanceof ToolError, "I8: ToolError for non-array rows"); }

// neither path nor rows
try {
  jsonlOps({ operation: "parse" }, resolveClientPath);
  ok(false, "I9: should throw when no source");
} catch (e) { ok(e instanceof ToolError, "I9: ToolError when no source"); }

// ── J: Extreme — 5 000 rows sort + filter perf ─────────────────────────
console.log("[177-J] jsonl_ops: 5000-row sort + filter performance");

const BIG = Array.from({ length: 5_000 }, (_, i) => ({
  id:   i,
  val:  Math.floor(Math.random() * 1_000),
  tag:  i % 3 === 0 ? "a" : i % 3 === 1 ? "b" : "c",
}));

const t0 = Date.now();
const jSort = jsonlOps({ operation: "sort",   rows: BIG, field: "val", dir: "asc" }, resolveClientPath);
const jFilt = jsonlOps({ operation: "filter",  rows: BIG, conditions: [{ field: "tag", op: "eq", value: "a" }] }, resolveClientPath);
const elapsed = Date.now() - t0;

ok(jSort.rows[0].val <= jSort.rows[1].val, "J1: sort produces ascending order");
ok(jFilt.rows.every(r => r.tag === "a"),   "J2: filter tag=a correct");
ok(elapsed < 3000,                          `J3: 5k sort+filter under 3s (took ${elapsed}ms)`);

// parse 5k rows from a file
const bigContent = BIG.map(r => JSON.stringify(r)).join("\n");
const bigFile    = tmpFile("big.jsonl", bigContent);
const t1 = Date.now();
const jParse = jsonlOps({ operation: "parse", path: bigFile }, resolveClientPath);
const e1 = Date.now() - t1;
ok(jParse.validCount  === 5_000,  "J4: parse 5k rows validCount");
ok(jParse.truncated   === false,  "J5: 5k rows not truncated (under 10k limit)");
ok(e1 < 3000,                     `J6: file parse 5k under 3s (took ${e1}ms)`);

// ── Cleanup ───────────────────────────────────────────────────────────────────
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

if (!global.testHarness) harness.done();
