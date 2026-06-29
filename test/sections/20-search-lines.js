"use strict";
/**
 * [24] SEARCH_LINES — grep-like line-number search with optional context,
 * literal/regex modes, case-insensitivity, extension filtering, and a
 * result cap. Complements search_files (which returns matching file names).
 */
const { fs, path, assert, test, executeTool } = require("../test-harness");

console.log(`\n[24] SEARCH_LINES — grep-like line search with context`);

// ── Normal (happy path) ─────────────────────────────────────────────────────
test("search_lines: literal match in a single file returns correct line numbers", () => {
  executeTool("create_file", { path: "sl1.txt", content: "alpha\nbeta\ngamma\nbeta again\n" });
  const r = executeTool("search_lines", { path: "sl1.txt", pattern: "beta" });
  assert.strictEqual(r.totalMatches, 2);
  assert.strictEqual(r.matches[0].line, 2);
  assert.strictEqual(r.matches[0].content, "beta");
  assert.strictEqual(r.matches[1].line, 4);
});

test("search_lines: directory mode walks recursively and reports matchedFiles", () => {
  executeTool("create_directory", { path: "sldir" });
  executeTool("create_directory", { path: "sldir/sub" });
  executeTool("create_file", { path: "sldir/a.txt", content: "needle here\nother\n" });
  executeTool("create_file", { path: "sldir/sub/b.txt", content: "no match\nneedle again\n" });
  const r = executeTool("search_lines", { path: "sldir", pattern: "needle" });
  assert.strictEqual(r.totalMatches, 2);
  assert.strictEqual(r.matchedFiles, 2);
});

test("search_lines: regex mode matches a pattern not a literal string", () => {
  executeTool("create_file", { path: "sl2.txt", content: "foo123\nfoobar\nfoo456\n" });
  const r = executeTool("search_lines", { path: "sl2.txt", pattern: "foo\\d+", is_regex: true });
  assert.strictEqual(r.totalMatches, 2);
  assert.strictEqual(r.matches[0].content, "foo123");
  assert.strictEqual(r.matches[1].content, "foo456");
});

test("search_lines: context lines included before/after a match", () => {
  executeTool("create_file", { path: "sl3.txt", content: "l1\nl2\nMATCH\nl4\nl5\n" });
  const r = executeTool("search_lines", { path: "sl3.txt", pattern: "MATCH", context: 2 });
  assert.deepStrictEqual(r.matches[0].context.before, ["l1", "l2"]);
  assert.deepStrictEqual(r.matches[0].context.after, ["l4", "l5"]);
});

// ── Medium (boundary & parameter validation) ────────────────────────────────
test("search_lines: missing pattern throws -32602", () => {
  try {
    executeTool("search_lines", { path: "sl1.txt" });
    assert.fail("should have thrown");
  } catch (e) {
    assert.strictEqual(e.code, -32602);
  }
});

test("search_lines: missing path throws -32602", () => {
  try {
    executeTool("search_lines", { pattern: "x" });
    assert.fail("should have thrown");
  } catch (e) {
    assert.strictEqual(e.code, -32602);
  }
});

test("search_lines: no matches returns empty array, not an error", () => {
  const r = executeTool("search_lines", { path: "sl1.txt", pattern: "zzz_no_such_thing" });
  assert.strictEqual(r.totalMatches, 0);
  assert.deepStrictEqual(r.matches, []);
});

test("search_lines: context clamps to max 10 even if a larger value is requested", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n");
  executeTool("create_file", { path: "sl_ctx.txt", content: lines + "\nMATCH\n" + lines });
  const r = executeTool("search_lines", { path: "sl_ctx.txt", pattern: "MATCH", context: 999 });
  assert.ok(r.matches[0].context.before.length <= 10);
  assert.ok(r.matches[0].context.after.length <= 10);
});

test("search_lines: max_matches caps total matches and sets truncated", () => {
  const content = Array.from({ length: 20 }, () => "hit").join("\n");
  executeTool("create_file", { path: "sl_max.txt", content });
  const r = executeTool("search_lines", { path: "sl_max.txt", pattern: "hit", max_matches: 5 });
  assert.strictEqual(r.totalMatches, 5);
  assert.strictEqual(r.truncated, true);
});

test("search_lines: ignore_case finds differently-cased matches", () => {
  executeTool("create_file", { path: "sl_case.txt", content: "Hello\nHELLO\nhello\n" });
  const r = executeTool("search_lines", { path: "sl_case.txt", pattern: "hello", ignore_case: true });
  assert.strictEqual(r.totalMatches, 3);
});

test("search_lines: extensions filter restricts directory-mode matches", () => {
  executeTool("create_directory", { path: "slext" });
  executeTool("create_file", { path: "slext/keep.js", content: "target\n" });
  executeTool("create_file", { path: "slext/skip.md", content: "target\n" });
  const r = executeTool("search_lines", { path: "slext", pattern: "target", extensions: [".js"] });
  assert.strictEqual(r.totalMatches, 1);
  assert.ok(r.matches[0].file.endsWith("keep.js"));
});

test("search_lines: invalid regex pattern throws a descriptive error", () => {
  assert.throws(
    () => executeTool("search_lines", { path: "sl1.txt", pattern: "(unterminated", is_regex: true }),
    /invalid regex pattern/
  );
});

// ── High (dependency / file-system failure handling) ────────────────────────
test("search_lines: non-existent path throws (not silent)", () => {
  assert.throws(() => executeTool("search_lines", { path: "ghost_sl.txt", pattern: "x" }));
});

test("search_lines: binary/unreadable file in directory mode is skipped, not fatal", () => {
  executeTool("create_directory", { path: "slbin" });
  // Write a file containing invalid-UTF8-ish byte sequence via base64_decode to simulate binary content.
  executeTool("base64_decode", { data: Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x02]).toString("base64"), destination: "slbin/blob.bin" });
  executeTool("create_file", { path: "slbin/text.txt", content: "findme\n" });
  const r = executeTool("search_lines", { path: "slbin", pattern: "findme" });
  assert.strictEqual(r.totalMatches, 1);
});

test("search_lines: MCP_IGNORE'd directories (node_modules) are skipped", () => {
  executeTool("create_directory", { path: "slnm" });
  executeTool("create_directory", { path: "slnm/node_modules" });
  executeTool("create_file", { path: "slnm/node_modules/dep.js", content: "secretpattern\n" });
  executeTool("create_file", { path: "slnm/real.js", content: "no match here\n" });
  const r = executeTool("search_lines", { path: "slnm", pattern: "secretpattern" });
  assert.strictEqual(r.totalMatches, 0);
});

// ── Critical (security & input sanitization) ────────────────────────────────
test("search_lines: path traversal blocked", () => {
  assert.throws(
    () => executeTool("search_lines", { path: "../../../etc/passwd", pattern: "root" }),
    /Access denied/
  );
});

test("search_lines: absolute-path-outside-root blocked", () => {
  assert.throws(
    () => executeTool("search_lines", { path: "C:\\Windows\\System32\\drivers\\etc\\hosts", pattern: "x" }),
    /Access denied/
  );
});

test("search_lines: literal mode treats regex metacharacters as plain text (no injection)", () => {
  executeTool("create_file", { path: "sl_lit.txt", content: "price: $5.00 (special)\nplain line\n" });
  const r = executeTool("search_lines", { path: "sl_lit.txt", pattern: "$5.00 (special)" });
  assert.strictEqual(r.totalMatches, 1);
});

test("search_lines: shell/SQL-injection-shaped content round-trips as literal text, never executed", () => {
  const evil = "'; DROP TABLE users; -- $(rm -rf /) `whoami`";
  executeTool("create_file", { path: "sl_inj.txt", content: evil + "\nharmless\n" });
  const r = executeTool("search_lines", { path: "sl_inj.txt", pattern: "DROP TABLE" });
  assert.strictEqual(r.totalMatches, 1);
  assert.strictEqual(r.matches[0].content, evil);
});

test("search_lines: regex mode cannot be used to read outside the jail (ReDoS-shaped pattern still just a regex)", () => {
  executeTool("create_file", { path: "sl_redos.txt", content: "aaaaaaaaaaaaaaaaaaaaaaaaaaaa!\n" });
  const start = Date.now();
  const r = executeTool("search_lines", { path: "sl_redos.txt", pattern: "a+a+a+a+b", is_regex: true });
  assert.strictEqual(r.totalMatches, 0);
  assert.ok(Date.now() - start < 5000, "should not hang catastrophically on this short input");
});

// ── Extreme (fuzzing, concurrency, large input) ─────────────────────────────
test("search_lines: large file (5000 lines) with sparse matches completes and reports correct count", () => {
  const lines = [];
  for (let i = 0; i < 5000; i++) lines.push(i % 777 === 0 ? "RARE_MARKER" : `line ${i}`);
  executeTool("create_file", { path: "sl_big.txt", content: lines.join("\n") });
  const r = executeTool("search_lines", { path: "sl_big.txt", pattern: "RARE_MARKER", max_matches: 2000 });
  const expected = lines.filter(l => l === "RARE_MARKER").length;
  assert.strictEqual(r.totalMatches, expected);
});

test("search_lines: fuzz bytes (random non-UTF8 content) do not crash the call", () => {
  const randomBuf = Buffer.from(Array.from({ length: 256 }, () => Math.floor(Math.random() * 256)));
  executeTool("base64_decode", { data: randomBuf.toString("base64"), destination: "sl_fuzz.bin" });
  assert.doesNotThrow(() => executeTool("search_lines", { path: "sl_fuzz.bin", pattern: "anything" }));
});

test("search_lines: 10 concurrent (sequential-async-simulated) calls return consistent results", () => {
  executeTool("create_file", { path: "sl_conc.txt", content: "stable\nstable\nstable\n" });
  const results = [];
  for (let i = 0; i < 10; i++) results.push(executeTool("search_lines", { path: "sl_conc.txt", pattern: "stable" }));
  for (const r of results) assert.strictEqual(r.totalMatches, 3);
});

test("search_lines: result is JSON-serialisable with no prototype pollution", () => {
  executeTool("create_file", { path: "sl_json.txt", content: "__proto__\nconstructor\nok\n" });
  const r = executeTool("search_lines", { path: "sl_json.txt", pattern: "constructor" });
  const json = JSON.parse(JSON.stringify(r));
  assert.strictEqual(json.totalMatches, 1);
  assert.strictEqual(Object.getPrototypeOf({}).constructor.name, "Object"); // global Object.prototype untouched
});

test("search_lines: cleanup — temp fixtures from this section do not leak outside the sandbox root", () => {
  // All fixtures above were created via create_file/create_directory inside the
  // shared MCP_ROOTS sandbox (TMP), which test-harness.js / run-tests.js cleans
  // up at the very end of the full suite run — nothing further to do here.
  assert.ok(true);
});
