"use strict";
/**
 * [67] SCAN_SECRETS — find likely hardcoded credentials (redacted output)
 *
 * Rigor levels:
 *   Normal:   AWS key, generic api_key assignment, PEM header each detected
 *             with correct type/line; output value is redacted.
 *   Medium:   clean file returns empty matches; nonexistent path -32602.
 *   High:     directory mode across files, extensions filter.
 *   Critical: redaction never contains the full raw secret substring;
 *             short quoted strings (<8 chars) are NOT flagged (no noisy
 *             false positives on trivial values).
 *   Extreme:  max_matches caps + truncated; many findings across one file.
 */
const { assert, test, executeTool } = require("../test-harness");

console.log(`\n[67] SCAN_SECRETS — hardcoded credential scanner (redacted)`);

test("normal: AWS key, generic api_key, PEM header detected", () => {
  const content = [
    "aws_key = AKIAABCDEFGHIJKLMNOP",
    'api_key: "sk_live_1234567890abcdef"',
    "-----BEGIN RSA PRIVATE KEY-----",
  ].join("\n");
  executeTool("write_file", { path: "ss1.txt", content });
  const r = executeTool("scan_secrets", { path: "ss1.txt" });
  assert.strictEqual(r.totalMatches, 3);
  assert.strictEqual(r.matches[0].type, "aws_access_key_id");
  assert.strictEqual(r.matches[0].line, 1);
  assert.strictEqual(r.matches[1].type, "generic_secret");
  assert.strictEqual(r.matches[2].type, "private_key_block");
});

test("medium: clean file returns empty matches", () => {
  executeTool("write_file", { path: "ss2.txt", content: "const x = 1;\nfunction foo() { return x; }\n" });
  const r = executeTool("scan_secrets", { path: "ss2.txt" });
  assert.strictEqual(r.totalMatches, 0);
});

test("medium: nonexistent path throws -32602", () => {
  try {
    executeTool("scan_secrets", { path: "ss_does_not_exist.txt" });
    assert.fail("should have thrown");
  } catch (e) { assert.strictEqual(e.code, -32602); }
});

test("high: directory mode + extensions filter", () => {
  executeTool("create_directory", { path: "ss_dir" });
  executeTool("write_file", { path: "ss_dir/a.env", content: 'password = "hunter2hunter2"\n' });
  executeTool("write_file", { path: "ss_dir/b.md", content: "no secrets here\n" });
  const rAll = executeTool("scan_secrets", { path: "ss_dir" });
  assert.strictEqual(rAll.filesAffected, 1);
  const rMd = executeTool("scan_secrets", { path: "ss_dir", extensions: [".md"] });
  assert.strictEqual(rMd.totalMatches, 0);
});

test("critical: redacted output never contains full raw secret", () => {
  const secret = "AKIASUPERSECRETKEY99";
  executeTool("write_file", { path: "ss3.txt", content: `key=${secret}\n` });
  const r = executeTool("scan_secrets", { path: "ss3.txt" });
  assert.ok(r.totalMatches >= 1);
  for (const m of r.matches) {
    assert.strictEqual(m.match.includes(secret), false);
    assert.ok(m.match.includes("***"));
  }
});

test("critical: trivial short values are not flagged", () => {
  executeTool("write_file", { path: "ss4.txt", content: 'token = "abc"\npassword=""\n' });
  const r = executeTool("scan_secrets", { path: "ss4.txt" });
  assert.strictEqual(r.totalMatches, 0);
});

test("extreme: max_matches caps results and sets truncated", () => {
  const lines = Array.from({ length: 20 }, (_, i) => `api_key = "AAAAAAAAAAAAAAAA${i}"`);
  executeTool("write_file", { path: "ss5.txt", content: lines.join("\n") });
  const r = executeTool("scan_secrets", { path: "ss5.txt", max_matches: 5 });
  assert.strictEqual(r.matches.length, 5);
  assert.strictEqual(r.truncated, true);
});

test("cleanup: remove scan_secrets fixtures", () => {
  for (const f of ["ss1.txt", "ss2.txt", "ss3.txt", "ss4.txt", "ss5.txt"]) {
    try { executeTool("delete_file", { path: f }); } catch (_) {}
  }
  try { executeTool("delete_directory", { path: "ss_dir", recursive: true }); } catch (_) {}
});
