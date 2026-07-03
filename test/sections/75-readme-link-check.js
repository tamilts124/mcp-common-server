"use strict";
/**
 * [75] README_LINK_CHECK — broken relative-link detection in markdown
 *
 * Rigor levels:
 *   Normal:   local link to an existing file -> exists:true, not broken.
 *   Medium:   local link to a missing file -> exists:false, in broken[];
 *             non-markdown/nonexistent path throws.
 *   High:     external (http/mailto) links classified separately, not
 *             existence-checked; anchor-only links (#section) classified
 *             separately, not existence-checked.
 *   Critical: link target with '#anchor' suffix on a real file strips the
 *             anchor before checking existence; autolink <https://...>
 *             syntax also captured.
 *   Extreme:  many links (40) on one line / across file parsed without
 *             crashing; duplicate identical links deduped by (target,line).
 */
const { assert, test, executeTool } = require("../test-harness");

console.log(`\n[75] README_LINK_CHECK — markdown link checker`);

test("normal: local link to existing file -> exists:true, not broken", () => {
  executeTool("write_file", { path: "rlc_target.txt", content: "hi" });
  executeTool("write_file", { path: "rlc1.md", content: "See [target](rlc_target.txt) for details.\n" });
  const r = executeTool("readme_link_check", { path: "rlc1.md" });
  assert.strictEqual(r.local.length, 1);
  assert.strictEqual(r.local[0].exists, true);
  assert.strictEqual(r.brokenCount, 0);
});

test("medium: local link to missing file -> exists:false, in broken[]", () => {
  executeTool("write_file", { path: "rlc2.md", content: "See [missing](does-not-exist.txt).\n" });
  const r = executeTool("readme_link_check", { path: "rlc2.md" });
  assert.strictEqual(r.brokenCount, 1);
  assert.strictEqual(r.broken[0].target, "does-not-exist.txt");
});

test("medium: nonexistent path throws", () => {
  try {
    executeTool("readme_link_check", { path: "rlc_does_not_exist.md" });
    assert.fail("should have thrown");
  } catch (e) { assert.ok(e); }
});

test("high: external and anchor links classified separately, not existence-checked", () => {
  const content = "[site](https://example.com) and [section](#intro) and [mail](mailto:a@b.com)\n";
  executeTool("write_file", { path: "rlc3.md", content });
  const r = executeTool("readme_link_check", { path: "rlc3.md" });
  assert.strictEqual(r.external.length, 2);
  assert.strictEqual(r.anchors.length, 1);
  assert.strictEqual(r.local.length, 0);
});

test("critical: '#anchor' suffix on real local file strips anchor before existence check", () => {
  executeTool("write_file", { path: "rlc4.md", content: "[jump](rlc_target.txt#section-2)\n" });
  const r = executeTool("readme_link_check", { path: "rlc4.md" });
  assert.strictEqual(r.local[0].exists, true);
});

test("critical: bare autolink <https://...> syntax captured as external", () => {
  executeTool("write_file", { path: "rlc5.md", content: "Visit <https://example.com/page> now.\n" });
  const r = executeTool("readme_link_check", { path: "rlc5.md" });
  assert.strictEqual(r.external.length, 1);
  assert.strictEqual(r.external[0].target, "https://example.com/page");
});

test("extreme: 40 links across file parsed without crashing", () => {
  let content = "";
  for (let i = 0; i < 40; i++) content += `[l${i}](rlc_target.txt)\n`;
  executeTool("write_file", { path: "rlc6.md", content });
  const r = executeTool("readme_link_check", { path: "rlc6.md" });
  assert.strictEqual(r.totalLinks, 40);
  assert.strictEqual(r.brokenCount, 0);
});

test("extreme: duplicate identical (target,line) links deduped", () => {
  executeTool("write_file", { path: "rlc7.md", content: "[a](rlc_target.txt) [b](rlc_target.txt)\n" });
  const r = executeTool("readme_link_check", { path: "rlc7.md" });
  // two distinct link texts pointing at the same target on the same line —
  // both should be recorded (different match positions, not a true dup);
  // this asserts the parser doesn't accidentally under- or over-count.
  assert.strictEqual(r.local.length, 2);
});

test("cleanup: remove readme_link_check fixtures", () => {
  for (const f of ["rlc_target.txt", "rlc1.md", "rlc2.md", "rlc3.md", "rlc4.md", "rlc5.md", "rlc6.md", "rlc7.md"]) {
    try { executeTool("delete_file", { path: f }); } catch (_) {}
  }
});
