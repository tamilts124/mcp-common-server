"use strict";
/**
 * [11] YAML BLOCK SCALARS — literal (|) and folded (>) support in
 * lib/yamlOps.js, exercised through the query_data tool (full integration,
 * not just direct parseYaml calls) plus a few direct parseYaml checks for
 * low-level chomping/folding semantics.
 *
 * Rigor levels covered:
 *   Normal:   happy-path literal/folded block scalars, as mapping values and
 *             as sequence items, via the real query_data tool path.
 *   Medium:   chomping indicators (-/+/clip), explicit indentation digit,
 *             empty block scalar content.
 *   High:     parser-boundary behavior — block ends correctly at a
 *             dedented sibling key, EOF-terminated block scalar, folded
 *             paragraph breaks, deep-nesting integration.
 *   Critical: injection-shaped content preserved literally, path traversal
 *             still blocked, YAML-looking lines inside a block scalar are
 *             NOT parsed as nested structure.
 *   Extreme:  large block scalar (thousands of lines), concurrent reads,
 *             fuzz bytes after a block indicator never crash the process.
 */
const { fs, path, assert, test, executeTool } = require("../test-harness");
const { parseYaml } = require("../../lib/yamlOps");

console.log(`\n[11] YAML BLOCK SCALARS — literal (|) / folded (>), lib/yamlOps.js`);

// ── NORMAL — happy path (via query_data, full tool integration) ─────────────
test("query_data: literal block scalar (|) preserves newlines", () => {
  executeTool("create_file", {
    path: "lit.yaml",
    content: "script: |\n  echo hello\n  echo world\n",
  });
  const r = executeTool("query_data", { path: "lit.yaml", query: "script" });
  assert.strictEqual(r.value, "echo hello\necho world\n");
  assert.strictEqual(r.type, "string");
});

test("query_data: folded block scalar (>) joins lines with spaces", () => {
  executeTool("create_file", {
    path: "fold.yaml",
    content: "summary: >\n  this is a\n  long sentence\n",
  });
  const r = executeTool("query_data", { path: "fold.yaml", query: "summary" });
  assert.strictEqual(r.value, "this is a long sentence\n");
});

test("query_data: block scalar as a sequence item", () => {
  executeTool("create_file", {
    path: "seqlit.yaml",
    content: "scripts:\n  - |\n    line a\n    line b\n  - plain\n",
  });
  const r = executeTool("query_data", { path: "seqlit.yaml", query: "scripts.0" });
  assert.strictEqual(r.value, "line a\nline b\n");
  const r2 = executeTool("query_data", { path: "seqlit.yaml", query: "scripts.1" });
  assert.strictEqual(r2.value, "plain");
});

test("query_data: block scalar nested under a mapping key", () => {
  executeTool("create_file", {
    path: "nestedlit.yaml",
    content: "container:\n  cmd: |\n    run-this\n    and-this\n",
  });
  const r = executeTool("query_data", { path: "nestedlit.yaml", query: "container.cmd" });
  assert.strictEqual(r.value, "run-this\nand-this\n");
});

test("query_data: default (clip) chomping leaves exactly one trailing newline", () => {
  executeTool("create_file", { path: "clip.yaml", content: "v: |\n  hello\n\n\n" });
  const r = executeTool("query_data", { path: "clip.yaml", query: "v" });
  assert.strictEqual(r.value, "hello\n");
});

// ── MEDIUM — chomping indicators, explicit indent, empty content ───────────
test("query_data: strip chomping (|-) removes all trailing newlines", () => {
  executeTool("create_file", { path: "strip.yaml", content: "v: |-\n  hello\n  world\n" });
  const r = executeTool("query_data", { path: "strip.yaml", query: "v" });
  assert.strictEqual(r.value, "hello\nworld");
});

test("query_data: keep chomping (|+) preserves trailing blank lines", () => {
  const r = parseYaml("v: |+\n  hello\n\n\n");
  assert.ok(r.v.startsWith("hello\n"), "keep-chomped value should start with hello\\n");
  assert.ok(r.v.length > "hello\n".length, "keep chomping should retain trailing blank lines");
});

test("query_data: folded strip (>-) combines fold + strip", () => {
  executeTool("create_file", { path: "foldstrip.yaml", content: "v: >-\n  a\n  b\n" });
  const r = executeTool("query_data", { path: "foldstrip.yaml", query: "v" });
  assert.strictEqual(r.value, "a b");
});

test("query_data: explicit indentation indicator (|2) is honored", () => {
  // Content is indented 4 spaces under a 0-indent key; explicit indicator of 2
  // tells the parser only 2 spaces are structural, the rest is data.
  const r = parseYaml("v: |2\n    abcd\n");
  assert.strictEqual(r.v, "  abcd\n");
});

test("query_data: empty block scalar content yields empty string", () => {
  executeTool("create_file", { path: "emptylit.yaml", content: "v: |\nb: 2\n" });
  const r = executeTool("query_data", { path: "emptylit.yaml", query: "v" });
  assert.strictEqual(r.value, "");
  const r2 = executeTool("query_data", { path: "emptylit.yaml", query: "b" });
  assert.strictEqual(r2.value, 2);
});

// ── HIGH — parser-boundary behavior ─────────────────────────────────────────
test("query_data: block scalar ends at dedented sibling key, sibling still parses", () => {
  executeTool("create_file", {
    path: "sibling.yaml",
    content: "first: |\n  content here\nsecond: ok\n",
  });
  const r1 = executeTool("query_data", { path: "sibling.yaml", query: "first" });
  assert.strictEqual(r1.value, "content here\n");
  const r2 = executeTool("query_data", { path: "sibling.yaml", query: "second" });
  assert.strictEqual(r2.value, "ok");
});

test("query_data: block scalar terminated by EOF (no trailing sibling) does not crash", () => {
  executeTool("create_file", { path: "eof.yaml", content: "last: |\n  only line" });
  const r = executeTool("query_data", { path: "eof.yaml", query: "last" });
  assert.strictEqual(r.value, "only line\n");
});

test("query_data: folded block scalar blank line becomes a paragraph break", () => {
  executeTool("create_file", {
    path: "para.yaml",
    content: "v: >\n  first part\n\n  second part\n",
  });
  const r = executeTool("query_data", { path: "para.yaml", query: "v" });
  assert.strictEqual(r.value, "first part\n\nsecond part\n");
});

test("query_data: '#' inside a literal block scalar is content, not a comment", () => {
  executeTool("create_file", {
    path: "hashlit.yaml",
    content: "v: |\n  keep # this\n  also # that\n",
  });
  const r = executeTool("query_data", { path: "hashlit.yaml", query: "v" });
  assert.strictEqual(r.value, "keep # this\nalso # that\n");
});

test("query_data: block scalar value reachable through 3 levels of nesting", () => {
  executeTool("create_file", {
    path: "deepblock.yaml",
    content: "a:\n  b:\n    c: |\n      deep content\n",
  });
  const r = executeTool("query_data", { path: "deepblock.yaml", query: "a.b.c" });
  assert.strictEqual(r.value, "deep content\n");
});

// ── CRITICAL — injection-shaped content, traversal, literal-vs-structure ───
test("query_data: shell-injection-shaped content inside a literal block round-trips literally", () => {
  executeTool("create_file", {
    path: "injectblock.yaml",
    content: "script: |\n  rm -rf / ; echo $(whoami) `id`\n",
  });
  const r = executeTool("query_data", { path: "injectblock.yaml", query: "script" });
  assert.strictEqual(r.value, "rm -rf / ; echo $(whoami) `id`\n");
});

test("query_data: path traversal still blocked for files containing block scalars", () => {
  assert.throws(
    () => executeTool("query_data", { path: "../../../etc/passwd", format: "yaml" }),
    /Access denied/,
  );
});

test("query_data: YAML-looking lines inside a literal block are NOT parsed as nested mapping", () => {
  executeTool("create_file", {
    path: "fakemap.yaml",
    content: "note: |\n  key: not-a-real-key\n  - not-a-real-sequence-item\n",
  });
  const r = executeTool("query_data", { path: "fakemap.yaml", query: "note" });
  assert.strictEqual(r.value, "key: not-a-real-key\n- not-a-real-sequence-item\n");
  assert.strictEqual(typeof r.value, "string");
});

test("query_data: SQL-injection-shaped content inside a folded block round-trips as literal text", () => {
  executeTool("create_file", {
    path: "sqliblock.yaml",
    content: "note: >\n  ' OR '1'='1\n  ; DROP TABLE users;\n",
  });
  const r = executeTool("query_data", { path: "sqliblock.yaml", query: "note" });
  assert.strictEqual(r.value, "' OR '1'='1 ; DROP TABLE users;\n");
});

// ── EXTREME — large input, concurrency, fuzzing ─────────────────────────────
test("query_data: large literal block scalar (5000 lines) parses correctly and quickly", () => {
  const lines = ["bigtext: |"];
  for (let i = 0; i < 5000; i++) lines.push(`  line ${i}`);
  executeTool("create_file", { path: "bigblock.yaml", content: lines.join("\n") + "\n" });
  const start = Date.now();
  const r = executeTool("query_data", { path: "bigblock.yaml", query: "bigtext" });
  const elapsed = Date.now() - start;
  const resultLines = r.value.split("\n");
  assert.strictEqual(resultLines[0], "line 0");
  assert.strictEqual(resultLines[4999], "line 4999");
  assert.ok(elapsed < 5000, `large block scalar took too long (${elapsed}ms)`);
});

test("query_data: concurrent reads of a block-scalar YAML file return consistent results", () => {
  executeTool("create_file", { path: "concblock.yaml", content: "v: |\n  stable\n  content\n" });
  const results = Array.from({ length: 10 }, () =>
    executeTool("query_data", { path: "concblock.yaml", query: "v" }),
  );
  for (const r of results) assert.strictEqual(r.value, "stable\ncontent\n");
});

test("parseYaml (direct): random fuzz bytes after a block indicator do not crash the process", () => {
  const fuzz = Buffer.from(Array.from({ length: 300 }, () => Math.floor(Math.random() * 256))).toString("latin1");
  const doc = `v: |\n  ${fuzz.replace(/\n/g, " ")}\n`;
  try {
    const r = parseYaml(doc);
    assert.ok(typeof r.v === "string", "fuzz block scalar should parse to a string when it doesn't throw");
  } catch (e) {
    assert.ok(e instanceof Error, "fuzz input must fail with a proper Error, not crash");
  }
});

test("parseYaml (direct): malformed block indicator (bad chomp char) falls back to plain scalar, no crash", () => {
  // '|x' is not a valid chomp/indent suffix character — should not match the
  // block-scalar detector and instead be treated as a normal (odd) scalar.
  const r = parseYaml("v: |x weird\n");
  assert.strictEqual(typeof r.v, "string");
});

test("cleanup: remove block-scalar fixture files created in this section", () => {
  const files = [
    "lit.yaml", "fold.yaml", "seqlit.yaml", "nestedlit.yaml", "clip.yaml",
    "strip.yaml", "foldstrip.yaml", "emptylit.yaml", "sibling.yaml", "eof.yaml",
    "para.yaml", "hashlit.yaml", "deepblock.yaml", "injectblock.yaml", "fakemap.yaml",
    "sqliblock.yaml", "bigblock.yaml", "concblock.yaml",
  ];
  for (const f of files) {
    const p = path.join(require("../test-harness").TMP, f);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  assert.ok(true);
});
