"use strict";
/**
 * [65] ENV_DIFF — compare two .env-style files
 *
 * Rigor levels:
 *   Normal:   happy-path diff between two files with overlapping/unique keys.
 *   Medium:   missing required args throw -32602; identical files -> empty diffs.
 *   High:     nonexistent file paths throw descriptive errors, not a crash.
 *   Critical: quoted values, 'export KEY=', duplicate keys (last wins),
 *             malformed lines (no '=') are skipped, not crashed on.
 *   Extreme:  large file (many keys) performs fine; empty file vs populated file.
 */
const { assert, test, executeTool } = require("../test-harness");

console.log(`\n[65] ENV_DIFF — compare .env-style files`);

test("normal: happy-path diff with unique/common/empty keys", () => {
  executeTool("write_file", { path: "ed_a.env", content: "FOO=1\nBAR=\nBAZ=baz\n" });
  executeTool("write_file", { path: "ed_b.env", content: "FOO=1\nBAR=2\nQUX=q\n" });
  const r = executeTool("env_diff", { path: "ed_a.env", compare_path: "ed_b.env" });
  assert.deepStrictEqual(r.onlyInPath, ["BAZ"]);
  assert.deepStrictEqual(r.onlyInComparePath, ["QUX"]);
  assert.deepStrictEqual(r.emptyInPath, ["BAR"]);
  assert.strictEqual(r.commonKeyCount, 2);
  assert.strictEqual(r.totalPathKeys, 3);
  assert.strictEqual(r.totalCompareKeys, 3);
});

test("medium: missing compare_path throws -32602", () => {
  try {
    executeTool("env_diff", { path: "ed_a.env" });
    assert.fail("should have thrown");
  } catch (e) { assert.strictEqual(e.code, -32602); }
});

test("medium: identical files produce empty diffs", () => {
  executeTool("write_file", { path: "ed_c.env", content: "A=1\nB=2\n" });
  const r = executeTool("env_diff", { path: "ed_c.env", compare_path: "ed_c.env" });
  assert.deepStrictEqual(r.onlyInPath, []);
  assert.deepStrictEqual(r.onlyInComparePath, []);
  assert.deepStrictEqual(r.emptyInPath, []);
});

test("high: nonexistent compare file throws descriptively", () => {
  try {
    executeTool("env_diff", { path: "ed_a.env", compare_path: "ed_does_not_exist.env" });
    assert.fail("should have thrown");
  } catch (e) { assert.strictEqual(e.code, -32602); }
});

test("critical: quotes, export prefix, duplicate keys, malformed lines handled", () => {
  const content = [
    "# comment line",
    "",
    "export KEY1=\"quoted value\"",
    "KEY2='single quoted'",
    "KEY3=first",
    "KEY3=second", // duplicate — last wins
    "not_a_valid_line_no_equals",
    "KEY4=../../../etc/passwd", // path-traversal-shaped value, must not be interpreted
  ].join("\n");
  executeTool("write_file", { path: "ed_d.env", content });
  executeTool("write_file", { path: "ed_e.env", content: "KEY1=x\nKEY2=y\nKEY3=z\nKEY4=w\n" });
  const r = executeTool("env_diff", { path: "ed_d.env", compare_path: "ed_e.env" });
  assert.strictEqual(r.totalPathKeys, 4); // KEY1-4, malformed line skipped
  assert.deepStrictEqual(r.onlyInPath, []);
  assert.deepStrictEqual(r.onlyInComparePath, []);
});

test("extreme: large file with many keys performs correctly", () => {
  const many = Array.from({ length: 500 }, (_, i) => `KEY_${i}=val${i}`).join("\n");
  executeTool("write_file", { path: "ed_big.env", content: many });
  const r = executeTool("env_diff", { path: "ed_big.env", compare_path: "ed_c.env" });
  assert.strictEqual(r.totalPathKeys, 500);
  assert.strictEqual(r.onlyInComparePath.length, 2); // A, B from ed_c.env
});

test("extreme: empty file vs populated file", () => {
  executeTool("write_file", { path: "ed_empty.env", content: "\n" });
  const r = executeTool("env_diff", { path: "ed_empty.env", compare_path: "ed_c.env" });
  assert.strictEqual(r.totalPathKeys, 0);
  assert.strictEqual(r.onlyInComparePath.length, 2);
});

test("cleanup: remove env_diff fixtures", () => {
  for (const f of ["ed_a.env", "ed_b.env", "ed_c.env", "ed_d.env", "ed_e.env", "ed_big.env", "ed_empty.env"]) {
    try { executeTool("delete_file", { path: f }); } catch (_) {}
  }
});
