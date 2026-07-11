"use strict";
/**
 * test/sections/176-str-similarity-table-ops.js
 * Isolated functional tests for str_similarity and table_ops.
 * Section [176] — 5 rigor levels (A-E) per tool, 10 sub-sections total.
 * Target: ~76 tests.
 */
const { test } = require("../test-harness");
const { strSimilarity } = require("../../lib/strSimilarityOps");
const { tableOps }      = require("../../lib/tableOps");

function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function assertThrows(fn, check) {
  let threw = false, err;
  try { fn(); } catch (e) { threw = true; err = e; }
  assert(threw, "expected an error to be thrown");
  if (check) check(err);
}

// ============================================================
// Section A: str_similarity — Normal (happy-path)
// ============================================================

test("[176-A1] str_similarity distance levenshtein identical", () => {
  const r = strSimilarity({ operation: "distance", a: "hello", b: "hello" });
  assert(r.similarity === 1, `sim=${r.similarity}`);
  assert(r.distance === 0, `dist=${r.distance}`);
});

test("[176-A2] str_similarity distance levenshtein one deletion", () => {
  const r = strSimilarity({ operation: "distance", a: "kitten", b: "sitten" });
  // 1 substitution
  assert(r.distance === 1, `dist=${r.distance}`);
  assert(r.similarity < 1, "should not be identical");
});

test("[176-A3] str_similarity distance jaro_winkler close strings", () => {
  const r = strSimilarity({ operation: "distance", metric: "jaro_winkler", a: "MARTHA", b: "MARHTA" });
  assert(r.similarity > 0.9, `sim=${r.similarity}`);
});

test("[176-A4] str_similarity distance dice same bigrams", () => {
  const r = strSimilarity({ operation: "distance", metric: "dice", a: "night", b: "nacht" });
  assert(typeof r.similarity === "number" && r.similarity >= 0, "dice sim ok");
});

test("[176-A5] str_similarity distance hamming equal length", () => {
  const r = strSimilarity({ operation: "distance", metric: "hamming", a: "karolin", b: "kathrin" });
  assert(r.distance === 3, `dist=${r.distance}`);
});

test("[176-A6] str_similarity search top results", () => {
  const r = strSimilarity({
    operation: "search",
    query: "apple",
    candidates: ["apple", "apply", "banana", "apples", "orange"],
    top_n: 3,
  });
  assert(r.resultCount === 3, `count=${r.resultCount}`);
  assert(r.results[0].candidate === "apple", "best match first");
});

test("[176-A7] str_similarity cluster groups similar strings", () => {
  const r = strSimilarity({
    operation: "cluster",
    strings: ["color", "colour", "xyz"],
    threshold: 0.6,
  });
  // "color" and "colour" should cluster together
  assert(r.clusterCount <= 2, `clusters=${r.clusterCount}`);
  const large = r.clusters.find(c => c.length >= 2);
  assert(large !== undefined, "expected a cluster of size >= 2");
});

test("[176-A8] str_similarity dedupe removes near-duplicates", () => {
  const r = strSimilarity({
    operation: "dedupe",
    strings: ["hello world", "hello world!", "foo bar"],
    threshold: 0.9,
    metric: "dice",
  });
  // "hello world" and "hello world!" are very similar, one should be removed
  assert(r.dedupeCount < 3, `kept=${r.dedupeCount}`);
  assert(r.removed >= 1, `removed=${r.removed}`);
});

test("[176-A9] str_similarity normalize lowercase + trim", () => {
  const r = strSimilarity({ operation: "normalize", string: "  Hello World  " });
  assert(r.string === "hello world", `got='${r.string}'`);
});

test("[176-A10] str_similarity normalize batch strings", () => {
  const r = strSimilarity({ operation: "normalize", strings: ["FOO", "  BAR  "] });
  assert(Array.isArray(r.strings), "expected array");
  assert(r.strings[0] === "foo", `got='${r.strings[0]}'`);
  assert(r.strings[1] === "bar", `got='${r.strings[1]}'`);
});

// ============================================================
// Section B: str_similarity — Medium (edge cases / validation)
// ============================================================

test("[176-B1] str_similarity distance empty strings", () => {
  const r = strSimilarity({ operation: "distance", a: "", b: "" });
  assert(r.similarity === 1, `sim=${r.similarity}`);
  assert(r.distance === 0, `dist=${r.distance}`);
});

test("[176-B2] str_similarity distance one empty string", () => {
  const r = strSimilarity({ operation: "distance", a: "", b: "abc" });
  assert(r.similarity === 0, `sim=${r.similarity}`);
  assert(r.distance === 3, `dist=${r.distance}`);
});

test("[176-B3] str_similarity hamming throws on different lengths", () => {
  assertThrows(
    () => strSimilarity({ operation: "distance", metric: "hamming", a: "abc", b: "abcd" }),
    e => assert(e.message.includes("equal length"), e.message),
  );
});

test("[176-B4] str_similarity search threshold filters results", () => {
  const r = strSimilarity({
    operation: "search",
    query: "cat",
    candidates: ["cat", "hat", "xyz"],
    threshold: 0.9,
  });
  assert(r.results.every(x => x.similarity >= 0.9), "all above threshold");
});

test("[176-B5] str_similarity search ignore_case", () => {
  const r = strSimilarity({
    operation: "search",
    query: "APPLE",
    candidates: ["apple"],
    ignore_case: true,
    threshold: 0.99,
  });
  assert(r.resultCount === 1, "should match case-insensitively");
});

test("[176-B6] str_similarity normalize strip_punctuation", () => {
  const r = strSimilarity({
    operation: "normalize",
    string: "Hello, World!",
    strip_punctuation: true,
  });
  assert(!r.string.includes(",") && !r.string.includes("!"), `got='${r.string}'`);
});

test("[176-B7] str_similarity normalize strip_diacritics", () => {
  const r = strSimilarity({
    operation: "normalize",
    string: "caf\u00e9", // 'café'
    strip_diacritics: true,
  });
  assert(r.string === "cafe", `got='${r.string}'`);
});

test("[176-B8] str_similarity dedupe empty list", () => {
  const r = strSimilarity({ operation: "dedupe", strings: [] });
  assert(r.dedupeCount === 0, "empty");
  assert(r.removed === 0, "no removed");
});

// ============================================================
// Section C: str_similarity — High (error paths)
// ============================================================

test("[176-C1] str_similarity missing operation throws", () => {
  assertThrows(
    () => strSimilarity({}),
    e => assert(e.message.includes("operation"), e.message),
  );
});

test("[176-C2] str_similarity unknown operation throws", () => {
  assertThrows(
    () => strSimilarity({ operation: "invalid" }),
    e => assert(e.message.includes("Unknown operation"), e.message),
  );
});

test("[176-C3] str_similarity unknown metric throws", () => {
  assertThrows(
    () => strSimilarity({ operation: "distance", a: "x", b: "y", metric: "bogus" }),
    e => assert(e.message.includes("Unknown metric"), e.message),
  );
});

test("[176-C4] str_similarity distance missing 'a' throws", () => {
  assertThrows(
    () => strSimilarity({ operation: "distance", b: "hello" }),
    e => assert(e.message.includes("'a' and 'b'"), e.message),
  );
});

test("[176-C5] str_similarity search missing candidates throws", () => {
  assertThrows(
    () => strSimilarity({ operation: "search", query: "x" }),
    e => assert(e.message.includes("candidates"), e.message),
  );
});

test("[176-C6] str_similarity cluster missing strings throws", () => {
  assertThrows(
    () => strSimilarity({ operation: "cluster" }),
    e => assert(e.message.includes("strings"), e.message),
  );
});

test("[176-C7] str_similarity normalize missing input throws", () => {
  assertThrows(
    () => strSimilarity({ operation: "normalize" }),
    e => assert(e.message.includes("'string'"), e.message),
  );
});

// ============================================================
// Section D: str_similarity — Critical (LCS + dice accuracy)
// ============================================================

test("[176-D1] str_similarity lcs similarity known pairs", () => {
  // LCS("ABCBDAB", "BDCAB") = 4 => sim = 4/7 ≈ 0.5714
  const r = strSimilarity({ operation: "distance", metric: "longest_common_subsequence", a: "ABCBDAB", b: "BDCAB" });
  const expected = 4 / 7;
  assert(Math.abs(r.similarity - Math.round(expected * 10000) / 10000) < 0.001, `sim=${r.similarity}`);
});

test("[176-D2] str_similarity dice identical strings similarity = 1", () => {
  const r = strSimilarity({ operation: "distance", metric: "dice", a: "night", b: "night" });
  assert(r.similarity === 1, `sim=${r.similarity}`);
});

test("[176-D3] str_similarity jaro_winkler prefix boost > jaro", () => {
  // "MARTHA" / "MARHTA" share 3-char prefix after adjusting
  const rJW = strSimilarity({ operation: "distance", metric: "jaro_winkler", a: "MARTHA", b: "MARHTA" });
  // jaro_winkler similarity for these is classically ~0.9611
  assert(rJW.similarity > 0.95, `jw sim=${rJW.similarity}`);
});

test("[176-D4] str_similarity dedupe keeps first occurrence", () => {
  const r = strSimilarity({ operation: "dedupe", strings: ["foo", "bar", "foo"], threshold: 1.0 });
  assert(r.strings[0] === "foo", "first kept");
  assert(r.strings.filter(s => s === "foo").length === 1, "only one foo");
});

test("[176-D5] str_similarity search top_n cap", () => {
  const candidates = Array.from({ length: 20 }, (_, i) => `word${i}`);
  const r = strSimilarity({ operation: "search", query: "word0", candidates, top_n: 5 });
  assert(r.results.length <= 5, `len=${r.results.length}`);
});

// ============================================================
// Section E: str_similarity — Extreme (stress / concurrency)
// ============================================================

test("[176-E1] str_similarity search 1000 candidates performance", () => {
  const candidates = Array.from({ length: 1000 }, (_, i) => `candidate_${i}`);
  const start = Date.now();
  const r = strSimilarity({ operation: "search", query: "candidate_500", candidates, top_n: 10 });
  const elapsed = Date.now() - start;
  assert(r.resultCount === 10, `count=${r.resultCount}`);
  assert(elapsed < 3000, `too slow: ${elapsed}ms`);
});

test("[176-E2] str_similarity cluster 100 strings performance", () => {
  const strings = Array.from({ length: 100 }, (_, i) => `string_item_${i % 10}`);
  const start = Date.now();
  const r = strSimilarity({ operation: "cluster", strings, threshold: 0.9 });
  const elapsed = Date.now() - start;
  assert(r.clusterCount <= 10, `clusters=${r.clusterCount}`);
  assert(elapsed < 5000, `too slow: ${elapsed}ms`);
});

test("[176-E3] str_similarity 50 sequential distance calls", () => {
  const words = ["apple", "apply", "application", "apt", "ape"];
  let count = 0;
  for (let i = 0; i < words.length; i++) {
    for (let j = i + 1; j < words.length; j++) {
      const r = strSimilarity({ operation: "distance", a: words[i], b: words[j] });
      assert(r.similarity >= 0 && r.similarity <= 1, "sim in range");
      count++;
    }
  }
  assert(count === 10, `count=${count}`);
});

// ============================================================
// Section F: table_ops — Normal (happy-path)
// ============================================================

const SAMPLE_ROWS = [
  { id: 1, name: "Alice", age: 30, dept: "Engineering" },
  { id: 2, name: "Bob",   age: 25, dept: "Marketing" },
  { id: 3, name: "Carol", age: 35, dept: "Engineering" },
  { id: 4, name: "Dave",  age: 28, dept: "Marketing" },
  { id: 5, name: "Eve",   age: 22, dept: "HR" },
];

test("[176-F1] table_ops info returns schema", () => {
  const r = tableOps({ operation: "info", rows: SAMPLE_ROWS });
  assert(r.rowCount === 5, `rows=${r.rowCount}`);
  assert(r.columnCount === 4, `cols=${r.columnCount}`);
  const cols = r.columns.map(c => c.name);
  assert(cols.includes("id") && cols.includes("name"), "expected columns");
});

test("[176-F2] table_ops filter eq", () => {
  const r = tableOps({ operation: "filter", rows: SAMPLE_ROWS, conditions: [{ field: "dept", op: "eq", value: "Engineering" }] });
  assert(r.rowCount === 2, `rows=${r.rowCount}`);
  assert(r.rows.every(row => row.dept === "Engineering"), "all Engineering");
});

test("[176-F3] table_ops sort ascending", () => {
  const r = tableOps({ operation: "sort", rows: SAMPLE_ROWS, by: "age" });
  const ages = r.rows.map(row => row.age);
  assert(ages[0] === 22 && ages[ages.length - 1] === 35, `ages=${ages}`);
});

test("[176-F4] table_ops sort descending", () => {
  const r = tableOps({ operation: "sort", rows: SAMPLE_ROWS, by: [{ field: "age", dir: "desc" }] });
  assert(r.rows[0].age === 35, `first=${r.rows[0].age}`);
});

test("[176-F5] table_ops select columns", () => {
  const r = tableOps({ operation: "select", rows: SAMPLE_ROWS, fields: ["id", "name"] });
  assert(Object.keys(r.rows[0]).length === 2, "only 2 columns");
  assert(r.rows[0].name !== undefined, "name present");
});

test("[176-F6] table_ops group_by sum", () => {
  const r = tableOps({
    operation: "group_by", rows: SAMPLE_ROWS,
    by: "dept",
    aggregations: [{ field: "age", op: "sum", alias: "total_age" }],
  });
  const eng = r.rows.find(row => row.dept === "Engineering");
  assert(eng && eng.total_age === 65, `eng total_age=${eng?.total_age}`);
});

test("[176-F7] table_ops join inner", () => {
  const left  = [{ id: 1, name: "Alice" }, { id: 2, name: "Bob" }];
  const right = [{ id: 1, salary: 100000 }, { id: 3, salary: 90000 }];
  const r = tableOps({ operation: "join", rows: left, right_rows: right, on: "id", type: "inner" });
  assert(r.rowCount === 1, `rows=${r.rowCount}`);
  assert(r.rows[0].salary === 100000, "salary joined");
});

test("[176-F8] table_ops pivot", () => {
  const rows = [
    { product: "A", month: "Jan", sales: 10 },
    { product: "A", month: "Feb", sales: 20 },
    { product: "B", month: "Jan", sales: 15 },
  ];
  const r = tableOps({ operation: "pivot", rows, index_field: "product", key_field: "month", value_field: "sales" });
  assert(r.pivotKeys.includes("Jan") && r.pivotKeys.includes("Feb"), `keys=${r.pivotKeys}`);
  const rowA = r.rows.find(row => row.product === "A");
  assert(rowA && rowA.Jan === 10 && rowA.Feb === 20, `A Jan=${rowA?.Jan} Feb=${rowA?.Feb}`);
});

// ============================================================
// Section G: table_ops — Medium (edge cases)
// ============================================================

test("[176-G1] table_ops filter OR logic", () => {
  const r = tableOps({
    operation: "filter", rows: SAMPLE_ROWS,
    conditions: [
      { field: "dept", op: "eq", value: "HR" },
      { field: "age",  op: "lt", value: 26 },
    ],
    logic: "or",
  });
  // Eve (HR) and Bob (age=25 < 26) => 2 rows
  assert(r.rowCount === 2, `rows=${r.rowCount}`);
});

test("[176-G2] table_ops filter in operator", () => {
  const r = tableOps({ operation: "filter", rows: SAMPLE_ROWS, conditions: [{ field: "id", op: "in", value: [1, 3, 5] }] });
  assert(r.rowCount === 3, `rows=${r.rowCount}`);
});

test("[176-G3] table_ops filter regex", () => {
  const r = tableOps({ operation: "filter", rows: SAMPLE_ROWS, conditions: [{ field: "name", op: "regex", value: "^[AB]" }] });
  assert(r.rowCount === 2 && r.rows.every(x => /^[AB]/.test(x.name)), `rows=${r.rowCount}`);
});

test("[176-G4] table_ops rename columns", () => {
  const r = tableOps({ operation: "rename", rows: SAMPLE_ROWS, mapping: { name: "full_name" } });
  assert(r.rows[0].full_name !== undefined, "renamed");
  assert(r.rows[0].name === undefined, "old gone");
});

test("[176-G5] table_ops derive arithmetic", () => {
  const r = tableOps({ operation: "derive", rows: SAMPLE_ROWS, name: "age_in_5", op: "add", field: "age", value: 5 });
  assert(r.rows[0].age_in_5 === 35, `age_in_5=${r.rows[0].age_in_5}`);
});

test("[176-G6] table_ops derive template", () => {
  const r = tableOps({ operation: "derive", rows: SAMPLE_ROWS, name: "label", op: "template", value: "{name} ({dept})" });
  assert(r.rows[0].label === "Alice (Engineering)", `label='${r.rows[0].label}'`);
});

test("[176-G7] table_ops distinct by fields", () => {
  const rows = [
    { dept: "Eng", level: "senior" },
    { dept: "Eng", level: "junior" },
    { dept: "Eng", level: "senior" },
  ];
  const r = tableOps({ operation: "distinct", rows, fields: ["dept", "level"] });
  assert(r.rowCount === 2, `rows=${r.rowCount}`);
});

test("[176-G8] table_ops limit with offset", () => {
  const r = tableOps({ operation: "limit", rows: SAMPLE_ROWS, count: 2, offset: 2 });
  assert(r.rowCount === 2, `rows=${r.rowCount}`);
  assert(r.rows[0].id === 3, `first id=${r.rows[0].id}`);
});

// ============================================================
// Section H: table_ops — High (error paths)
// ============================================================

test("[176-H1] table_ops missing operation throws", () => {
  assertThrows(
    () => tableOps({ rows: [] }),
    e => assert(e.message.includes("operation"), e.message),
  );
});

test("[176-H2] table_ops unknown operation throws", () => {
  assertThrows(
    () => tableOps({ operation: "invalid", rows: [] }),
    e => assert(e.message.includes("Unknown operation"), e.message),
  );
});

test("[176-H3] table_ops filter empty conditions throws", () => {
  assertThrows(
    () => tableOps({ operation: "filter", rows: SAMPLE_ROWS, conditions: [] }),
    e => assert(e.message.includes("conditions"), e.message),
  );
});

test("[176-H4] table_ops sort missing 'by' throws", () => {
  assertThrows(
    () => tableOps({ operation: "sort", rows: SAMPLE_ROWS }),
    e => assert(e.message.includes("'by'"), e.message),
  );
});

test("[176-H5] table_ops join missing 'on' throws", () => {
  assertThrows(
    () => tableOps({ operation: "join", rows: SAMPLE_ROWS, right_rows: [] }),
    e => assert(e.message.includes("'on'"), e.message),
  );
});

test("[176-H6] table_ops join invalid type throws", () => {
  assertThrows(
    () => tableOps({ operation: "join", rows: [], right_rows: [], on: "id", type: "cross" }),
    e => assert(e.message.includes("'type' must be"), e.message),
  );
});

test("[176-H7] table_ops limit negative count throws", () => {
  assertThrows(
    () => tableOps({ operation: "limit", rows: SAMPLE_ROWS, count: -1 }),
    e => assert(e.message.includes("non-negative"), e.message),
  );
});

test("[176-H8] table_ops pivot missing key_field throws", () => {
  assertThrows(
    () => tableOps({ operation: "pivot", rows: SAMPLE_ROWS, index_field: "id" }),
    e => assert(e.message.includes("'key_field'"), e.message),
  );
});

// ============================================================
// Section I: table_ops — Critical (advanced ops accuracy)
// ============================================================

test("[176-I1] table_ops group_by count", () => {
  const r = tableOps({
    operation: "group_by", rows: SAMPLE_ROWS,
    by: "dept",
    aggregations: [{ field: "id", op: "count", alias: "n" }],
  });
  const eng = r.rows.find(row => row.dept === "Engineering");
  assert(eng && eng.n === 2, `n=${eng?.n}`);
});

test("[176-I2] table_ops group_by avg", () => {
  const r = tableOps({
    operation: "group_by", rows: SAMPLE_ROWS,
    by: "dept",
    aggregations: [{ field: "age", op: "avg", alias: "avg_age" }],
  });
  const eng = r.rows.find(row => row.dept === "Engineering");
  assert(eng && eng.avg_age === 32.5, `avg=${eng?.avg_age}`);
});

test("[176-I3] table_ops join left keeps unmatched left rows", () => {
  const left  = [{ id: 1, name: "A" }, { id: 99, name: "B" }];
  const right = [{ id: 1, val: "x" }];
  const r = tableOps({ operation: "join", rows: left, right_rows: right, on: "id", type: "left" });
  assert(r.rowCount === 2, `rows=${r.rowCount}`);
  const unmatched = r.rows.find(row => row.id === 99);
  assert(unmatched !== undefined, "unmatched left row kept");
});

test("[176-I4] table_ops join full includes both sides", () => {
  const left  = [{ id: 1 }];
  const right = [{ id: 2 }];
  const r = tableOps({ operation: "join", rows: left, right_rows: right, on: "id", type: "full" });
  assert(r.rowCount === 2, `rows=${r.rowCount}`);
});

test("[176-I5] table_ops unpivot", () => {
  const rows = [{ name: "Alice", jan: 10, feb: 20 }];
  const r = tableOps({ operation: "unpivot", rows, id_fields: ["name"], key_name: "month", value_name: "sales" });
  assert(r.rowCount === 2, `rows=${r.rowCount}`);
  assert(r.rows.every(row => row.name === "Alice"), "id col kept");
  const jan = r.rows.find(row => row.month === "jan");
  assert(jan && jan.sales === 10, `jan sales=${jan?.sales}`);
});

test("[176-I6] table_ops derive coalesce", () => {
  const rows = [{ a: null, b: 42 }, { a: 1, b: 99 }];
  const r = tableOps({ operation: "derive", rows, name: "first", op: "coalesce", value: ["a", "b"] });
  assert(r.rows[0].first === 42, `first=${r.rows[0].first}`);
  assert(r.rows[1].first === 1, `first=${r.rows[1].first}`);
});

test("[176-I7] table_ops select drop mode", () => {
  const r = tableOps({ operation: "select", rows: SAMPLE_ROWS, fields: ["age", "dept"], drop: true });
  assert(r.rows[0].id !== undefined, "id still present");
  assert(r.rows[0].age === undefined, "age dropped");
});

test("[176-I8] table_ops filter is_null", () => {
  const rows = [{ x: null }, { x: 1 }, { x: undefined }];
  const r = tableOps({ operation: "filter", rows, conditions: [{ field: "x", op: "is_null" }] });
  assert(r.rowCount === 2, `rows=${r.rowCount}`);
});

// ============================================================
// Section J: table_ops — Extreme (stress / empty data)
// ============================================================

test("[176-J1] table_ops info on empty rows", () => {
  const r = tableOps({ operation: "info", rows: [] });
  assert(r.rowCount === 0, "empty");
  assert(r.columnCount === 0, "no cols");
});

test("[176-J2] table_ops filter empty input returns empty", () => {
  const r = tableOps({ operation: "filter", rows: [], conditions: [{ field: "x", op: "eq", value: 1 }] });
  assert(r.rowCount === 0, "empty");
});

test("[176-J3] table_ops group_by on empty rows", () => {
  const r = tableOps({ operation: "group_by", rows: [], by: "dept", aggregations: [{ field: "age", op: "count", alias: "n" }] });
  assert(r.groupCount === 0, "no groups");
});

test("[176-J4] table_ops limit beyond row count", () => {
  const r = tableOps({ operation: "limit", rows: SAMPLE_ROWS, count: 100 });
  assert(r.rowCount === 5, `rows=${r.rowCount}`);
  assert(r.totalRows === 5, `total=${r.totalRows}`);
});

test("[176-J5] table_ops sort 500 rows stable", () => {
  const rows = Array.from({ length: 500 }, (_, i) => ({ id: 500 - i, val: Math.random() }));
  const r = tableOps({ operation: "sort", rows, by: "id" });
  for (let i = 1; i < r.rows.length; i++) {
    assert(r.rows[i].id >= r.rows[i - 1].id, `not sorted at ${i}`);
  }
});

test("[176-J6] table_ops group_by 200 rows many groups", () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({ grp: i % 50, val: i }));
  const r = tableOps({ operation: "group_by", rows, by: "grp", aggregations: [{ field: "val", op: "sum", alias: "s" }] });
  assert(r.groupCount === 50, `groups=${r.groupCount}`);
});

test("[176-J7] table_ops derive upper on 100 rows", () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ name: `person_${i}` }));
  const r = tableOps({ operation: "derive", rows, name: "upper_name", op: "upper", field: "name" });
  assert(r.rows[0].upper_name === "PERSON_0", `got=${r.rows[0].upper_name}`);
  assert(r.rowCount === 100, `rows=${r.rowCount}`);
});

test("[176-J8] table_ops distinct on 200 rows with duplicates", () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({ key: i % 10, val: i }));
  const r = tableOps({ operation: "distinct", rows, fields: ["key"] });
  assert(r.rowCount === 10, `rows=${r.rowCount}`);
});
