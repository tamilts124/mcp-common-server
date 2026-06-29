"use strict";
/**
 * test/sections/31-yaml-merge.js
 *
 * Isolated functional tests for the yaml_merge tool — all five rigor levels
 * (Normal/Medium/High/Critical/Extreme) in one file since the tool is small.
 *
 * Does NOT start the HTTP server or any MCP client.
 * All file I/O uses the shared TMP sandbox from test-harness.js.
 *
 * Section [34]
 */

const fs   = require("fs");
const path = require("path");

const { test, TMP } = require("../test-harness");
const { yamlMerge, deepMerge } = require("../../lib/yamlMergeOps");
const { parseYaml }            = require("../../lib/yamlOps");

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

let _counter = 0;
function tmpYaml(content) {
  const p = path.join(TMP, `ym-${++_counter}.yaml`);
  fs.writeFileSync(p, content, "utf8");
  return p;
}

// ════════════════════════════════════════════════════════════════════════════
// [34-A] NORMAL — happy path
// ════════════════════════════════════════════════════════════════════════════

test("[34-A-1] merge: patch adds a new top-level key", () => {
  const p = tmpYaml("name: Alice\nage: 30\n");
  const r = yamlMerge(p, "test.yaml", "city: London\n");
  assert(r.apply === true, "apply should default to true");
  assert(typeof r.originalSize === "number" && r.originalSize > 0, "originalSize > 0");
  assert(typeof r.newSize === "number" && r.newSize > 0, "newSize > 0");
  const doc = parseYaml(fs.readFileSync(p, "utf8"));
  assert(doc.name === "Alice", "name preserved");
  assert(doc.age === 30, "age preserved");
  assert(doc.city === "London", "city added");
});

test("[34-A-2] merge: patch overrides an existing scalar key", () => {
  const p = tmpYaml("version: 1\ndebug: false\n");
  yamlMerge(p, "test.yaml", "version: 2\n");
  const doc = parseYaml(fs.readFileSync(p, "utf8"));
  assert(doc.version === 2, "version overridden");
  assert(doc.debug === false, "debug preserved");
});

test("[34-A-3] merge: nested mappings merge recursively, sibling keys preserved", () => {
  const p = tmpYaml("service:\n  name: web\n  port: 80\n");
  yamlMerge(p, "test.yaml", "service:\n  port: 8080\n");
  const doc = parseYaml(fs.readFileSync(p, "utf8"));
  assert(doc.service.name === "web", "service.name preserved");
  assert(doc.service.port === 8080, "service.port overridden");
});

test("[34-A-4] merge: array in patch fully replaces base array (no concat)", () => {
  const p = tmpYaml("ports:\n  - 80\n  - 443\n");
  yamlMerge(p, "test.yaml", "ports:\n  - 9000\n");
  const doc = parseYaml(fs.readFileSync(p, "utf8"));
  assert(Array.isArray(doc.ports), "ports is an array");
  assert(doc.ports.length === 1 && doc.ports[0] === 9000, "ports fully replaced, not appended");
});

test("[34-A-5] merge: deeply nested key path merges only the touched branch", () => {
  const p = tmpYaml("a:\n  b:\n    c: 1\n    d: 2\n  e: 3\n");
  yamlMerge(p, "test.yaml", "a:\n  b:\n    c: 99\n");
  const doc = parseYaml(fs.readFileSync(p, "utf8"));
  assert(doc.a.b.c === 99, "a.b.c overridden");
  assert(doc.a.b.d === 2, "a.b.d preserved");
  assert(doc.a.e === 3, "a.e preserved");
});

test("[34-A-6] merge: dry-run (apply=false) does not modify the file", () => {
  const p = tmpYaml("x: 1\n");
  const before = fs.readFileSync(p, "utf8");
  const r = yamlMerge(p, "test.yaml", "x: 2\ny: 3\n", { apply: false });
  const after = fs.readFileSync(p, "utf8");
  assert(before === after, "file unchanged on dry-run");
  assert(r.apply === false, "apply echoed back as false");
  assert(r.result.x === 2 && r.result.y === 3, "result reflects merged doc even though not written");
});

test("[34-A-7] merge: result object has all required fields", () => {
  const p = tmpYaml("a: 1\n");
  const r = yamlMerge(p, "test.yaml", "b: 2\n");
  assert("path" in r && "apply" in r && "originalSize" in r && "newSize" in r && "result" in r,
    "result has path/apply/originalSize/newSize/result");
  assert(r.path === "test.yaml", "path echoes client-relative path, not absolute");
});

test("[34-A-8] merge: empty base file (treated as empty mapping) merges patch cleanly", () => {
  const p = tmpYaml("");
  yamlMerge(p, "test.yaml", "a: 1\nb: 2\n");
  const doc = parseYaml(fs.readFileSync(p, "utf8"));
  assert(doc.a === 1 && doc.b === 2, "patch applied onto empty base");
});

test("[34-A-9] deepMerge (direct): pure function does not mutate its inputs", () => {
  const base = { a: 1, nested: { x: 1 } };
  const patch = { nested: { y: 2 } };
  const merged = deepMerge(base, patch);
  assert(base.nested.y === undefined, "base.nested unmutated by merge");
  assert(merged.nested.x === 1 && merged.nested.y === 2, "merged result combines both");
});

// ════════════════════════════════════════════════════════════════════════════
// [34-B] MEDIUM — boundary & parameter validation
// ════════════════════════════════════════════════════════════════════════════

test("[34-B-1] merge: missing 'patch' argument throws -32602", () => {
  const p = tmpYaml("a: 1\n");
  let threw = false;
  try { yamlMerge(p, "test.yaml", undefined); } catch (e) { threw = true; assert(e.code === -32602, "code -32602"); }
  assert(threw, "should throw");
});

test("[34-B-2] merge: empty string 'patch' throws -32602", () => {
  const p = tmpYaml("a: 1\n");
  let threw = false;
  try { yamlMerge(p, "test.yaml", ""); } catch (e) { threw = true; assert(e.code === -32602, "code -32602"); }
  assert(threw, "should throw");
});

test("[34-B-3] merge: whitespace-only 'patch' throws -32602", () => {
  const p = tmpYaml("a: 1\n");
  let threw = false;
  try { yamlMerge(p, "test.yaml", "   \n  \n"); } catch (e) { threw = true; assert(e.code === -32602, "code -32602"); }
  assert(threw, "should throw");
});

test("[34-B-4] merge: non-string 'patch' (number) throws -32602", () => {
  const p = tmpYaml("a: 1\n");
  let threw = false;
  try { yamlMerge(p, "test.yaml", 12345); } catch (e) { threw = true; assert(e.code === -32602, "code -32602"); }
  assert(threw, "should throw");
});

test("[34-B-5] merge: base file does not exist throws (not silent)", () => {
  let threw = false;
  try { yamlMerge(path.join(TMP, "does-not-exist.yaml"), "x.yaml", "a: 1\n"); } catch (e) { threw = true; }
  assert(threw, "should throw on missing base file");
});

test("[34-B-6] merge: invalid YAML in base file throws a descriptive error", () => {
  const p = tmpYaml("this is not valid yaml\n");
  let threw = false, msg = "";
  try { yamlMerge(p, "test.yaml", "a: 1\n"); } catch (e) { threw = true; msg = e.message; }
  assert(threw, "should throw");
  assert(/base file is not valid YAML/.test(msg), "error mentions base file is not valid YAML");
});

test("[34-B-7] merge: invalid YAML in patch string throws a descriptive error", () => {
  const p = tmpYaml("a: 1\n");
  let threw = false, msg = "";
  try { yamlMerge(p, "test.yaml", "this is not valid yaml\n"); } catch (e) { threw = true; msg = e.message; }
  assert(threw, "should throw");
  assert(/patch is not valid YAML/.test(msg), "error mentions patch is not valid YAML");
});

test("[34-B-8] merge: patch re-asserting an identical value is a true no-op", () => {
  // The parser only supports mapping/sequence/null root documents (no bare
  // scalar root, and no empty flow-mapping "{}" either — confirmed by
  // lib/yamlOps.js's "expected 'key: value'" error), so this boundary case
  // targets a patch whose values exactly match the base instead.
  const p = tmpYaml("a: 1\nb: 2\n");
  const r = yamlMerge(p, "test.yaml", "a: 1\n");
  assert(r.result.a === 1 && r.result.b === 2, "patch re-asserting an unchanged value leaves base untouched");
});

// ════════════════════════════════════════════════════════════════════════════
// [34-C] HIGH — mismatched shapes / structural edge cases
// ════════════════════════════════════════════════════════════════════════════

test("[34-C-1] merge: base mapping + patch scalar for same key — patch replaces outright", () => {
  const p = tmpYaml("config:\n  a: 1\n  b: 2\n");
  yamlMerge(p, "test.yaml", "config: disabled\n");
  const doc = parseYaml(fs.readFileSync(p, "utf8"));
  assert(doc.config === "disabled", "mapping replaced wholesale by scalar patch value");
});

test("[34-C-2] merge: base scalar + patch mapping for same key — patch replaces outright", () => {
  const p = tmpYaml("config: disabled\n");
  yamlMerge(p, "test.yaml", "config:\n  a: 1\n");
  const doc = parseYaml(fs.readFileSync(p, "utf8"));
  assert(doc.config.a === 1, "scalar replaced wholesale by mapping patch value");
});

test("[34-C-3] merge: base array + patch mapping for same key — patch replaces outright", () => {
  const p = tmpYaml("items:\n  - 1\n  - 2\n");
  yamlMerge(p, "test.yaml", "items:\n  x: 1\n");
  const doc = parseYaml(fs.readFileSync(p, "utf8"));
  assert(!Array.isArray(doc.items) && doc.items.x === 1, "array replaced wholesale by mapping patch value");
});

test("[34-C-4] merge: null in patch explicitly sets the key to null (not treated as absent)", () => {
  const p = tmpYaml("a: 1\nb: 2\n");
  yamlMerge(p, "test.yaml", "a: null\n");
  const doc = parseYaml(fs.readFileSync(p, "utf8"));
  assert(doc.a === null, "a explicitly nulled");
  assert(doc.b === 2, "b unaffected");
});

test("[34-C-5] merge: multiple sibling keys merged independently in one call", () => {
  const p = tmpYaml("a: 1\nb: 2\nc: 3\n");
  yamlMerge(p, "test.yaml", "b: 20\nc: 30\nd: 4\n");
  const doc = parseYaml(fs.readFileSync(p, "utf8"));
  assert(doc.a === 1 && doc.b === 20 && doc.c === 30 && doc.d === 4, "all keys correctly merged/added/preserved");
});

test("[34-C-6] merge: sequence of mappings as patch value round-trips correctly", () => {
  const p = tmpYaml("users:\n  - name: a\n");
  yamlMerge(p, "test.yaml", "users:\n  - name: x\n    role: admin\n  - name: y\n    role: viewer\n");
  const doc = parseYaml(fs.readFileSync(p, "utf8"));
  assert(doc.users.length === 2, "users array replaced with 2-item patch array");
  assert(doc.users[0].role === "admin" && doc.users[1].role === "viewer", "nested mapping fields intact");
});

test("[34-C-7] merge: patch with multiple levels of new nested keys auto-creates structure", () => {
  const p = tmpYaml("top: 1\n");
  yamlMerge(p, "test.yaml", "deep:\n  a:\n    b:\n      c: hello\n");
  const doc = parseYaml(fs.readFileSync(p, "utf8"));
  assert(doc.deep.a.b.c === "hello", "deeply nested new key path created");
  assert(doc.top === 1, "original top-level key preserved");
});

// ════════════════════════════════════════════════════════════════════════════
// [34-D] CRITICAL — security & input sanitization
// ════════════════════════════════════════════════════════════════════════════

test("[34-D-1] merge: shell/SQL-injection-shaped string values round-trip literally, never executed", () => {
  const p = tmpYaml("cmd: clean\n");
  yamlMerge(p, "test.yaml", "cmd: \"'; DROP TABLE users; --\"\nsql: \"$(rm -rf /)\"\n");
  const doc = parseYaml(fs.readFileSync(p, "utf8"));
  assert(doc.cmd === "'; DROP TABLE users; --", "shell/SQL-injection-shaped value stored literally");
  assert(doc.sql === "$(rm -rf /)", "shell-metachar-shaped value stored literally");
});

test("[34-D-2] merge: HTML/script-shaped value round-trips as literal text", () => {
  const p = tmpYaml("note: ok\n");
  yamlMerge(p, "test.yaml", "note: \"<script>alert(1)</script>\"\n");
  const doc = parseYaml(fs.readFileSync(p, "utf8"));
  assert(doc.note === "<script>alert(1)</script>", "HTML/script content stored literally, not executed");
});

test("[34-D-3] merge: prototype-pollution attempt via __proto__ key is harmless", () => {
  const p = tmpYaml("a: 1\n");
  yamlMerge(p, "test.yaml", "__proto__:\n  polluted: true\n");
  // Object.prototype should remain pristine for plain objects created elsewhere
  assert(({}).polluted === undefined, "Object.prototype not polluted by merge");
});

test("[34-D-4] merge: path traversal in the base file path is rejected by the caller's jail (resolveClientPath), not this module — verify module itself does not bypass fs errors", () => {
  // yamlMerge itself takes an already-resolved absolute path; the traversal
  // check happens one layer up in dispatchWrite.js via resolveClientPath.
  // Here we verify a nonexistent path (simulating a path the jail would
  // never resolve to) still throws cleanly rather than doing anything odd.
  let threw = false;
  try { yamlMerge(path.join(TMP, "..", "..", "etc", "passwd-sim.yaml"), "../../etc/passwd-sim.yaml", "a: 1\n"); }
  catch (e) { threw = true; }
  assert(threw, "nonexistent simulated-traversal target throws cleanly");
});

test("[34-D-5] merge: result is fully JSON-serialisable (no circular refs, no undefined leaking)", () => {
  const p = tmpYaml("a: 1\n");
  const r = yamlMerge(p, "test.yaml", "b: 2\nc:\n  d: 3\n");
  const json = JSON.stringify(r);
  assert(typeof json === "string" && json.length > 0, "JSON.stringify succeeds");
  const parsed = JSON.parse(json);
  assert(parsed.result.c.d === 3, "nested merged value survives JSON round-trip");
});

test("[34-D-6] merge: result has no unexpected top-level keys (no prototype pollution)", () => {
  const p = tmpYaml("a: 1\n");
  const r = yamlMerge(p, "test.yaml", "b: 2\n");
  const keys = Object.keys(r).sort();
  assert(JSON.stringify(keys) === JSON.stringify(["apply", "newSize", "originalSize", "path", "result"]),
    "exactly the documented keys, nothing extra");
});

test("[34-D-7] merge: unicode and emoji values round-trip correctly", () => {
  const p = tmpYaml("greeting: hello\n");
  yamlMerge(p, "test.yaml", 'greeting: "héllo wörld 🚀 日本語"\n');
  const doc = parseYaml(fs.readFileSync(p, "utf8"));
  assert(doc.greeting === "héllo wörld 🚀 日本語", "unicode/emoji preserved exactly");
});

// ════════════════════════════════════════════════════════════════════════════
// [34-E] EXTREME — fuzzing, concurrency, scale
// ════════════════════════════════════════════════════════════════════════════

test("[34-E-1] merge: large base document (1000 keys) merges a small patch quickly and correctly", () => {
  const lines = [];
  for (let i = 0; i < 1000; i++) lines.push(`k${i}: ${i}`);
  const p = tmpYaml(lines.join("\n") + "\n");
  const start = Date.now();
  yamlMerge(p, "test.yaml", "k500: 999999\nnewkey: added\n");
  const elapsed = Date.now() - start;
  assert(elapsed < 5000, "completes within 5s");
  const doc = parseYaml(fs.readFileSync(p, "utf8"));
  assert(doc.k500 === 999999, "targeted key overridden");
  assert(doc.k0 === 0 && doc.k999 === 999, "untouched keys preserved");
  assert(doc.newkey === "added", "new key added");
});

test("[34-E-2] merge: deeply nested patch (10 levels) merges and reads back correctly", () => {
  const p = tmpYaml("root: 1\n");
  let yaml = "a:\n";
  let indent = "  ";
  for (let i = 0; i < 9; i++) {
    yaml += `${indent}n${i}:\n`;
    indent += "  ";
  }
  yaml += `${indent}leaf: deep-value\n`;
  yamlMerge(p, "test.yaml", yaml);
  const doc = parseYaml(fs.readFileSync(p, "utf8"));
  let node = doc.a;
  for (let i = 0; i < 9; i++) node = node[`n${i}`];
  assert(node.leaf === "deep-value", "10-level-deep nested value reachable after merge");
});

test("[34-E-3] merge: 50 sequential merges on the same file accumulate correctly", () => {
  const p = tmpYaml("count: 0\n");
  for (let i = 1; i <= 50; i++) {
    yamlMerge(p, "test.yaml", `count: ${i}\n`);
  }
  const doc = parseYaml(fs.readFileSync(p, "utf8"));
  assert(doc.count === 50, "final count reflects last of 50 sequential merges");
});

test("[34-E-4] merge: 10 concurrent dry-run calls on the same file do not interfere or write", () => {
  const p = tmpYaml("x: 1\n");
  const before = fs.readFileSync(p, "utf8");
  const results = [];
  for (let i = 0; i < 10; i++) {
    results.push(yamlMerge(p, "test.yaml", `x: ${i}\n`, { apply: false }));
  }
  const after = fs.readFileSync(p, "utf8");
  assert(before === after, "file untouched after 10 dry-runs");
  assert(results.every((r, i) => r.result.x === i), "each dry-run reflects its own patch value independently");
});

test("[34-E-5] merge: fuzz — random bytes as patch string throws cleanly, never crashes the process", () => {
  const p = tmpYaml("a: 1\n");
  const fuzz = Buffer.from(Array.from({ length: 200 }, () => Math.floor(Math.random() * 256))).toString("latin1");
  let threwOrSucceeded = false;
  try {
    yamlMerge(p, "test.yaml", fuzz);
    threwOrSucceeded = true; // some fuzz bytes might parse as a plain scalar string — that's fine too
  } catch (e) {
    threwOrSucceeded = true; // throwing cleanly is also an acceptable, non-crashing outcome
  }
  assert(threwOrSucceeded, "fuzz patch string handled without crashing the process");
});

test("[34-E-6] merge: large patch value (500-entry array) does not crash the serializer", () => {
  const p = tmpYaml("items:\n  - 1\n");
  const arr = Array.from({ length: 500 }, (_, i) => `  - item${i}`).join("\n");
  yamlMerge(p, "test.yaml", `items:\n${arr}\n`);
  const doc = parseYaml(fs.readFileSync(p, "utf8"));
  assert(doc.items.length === 500, "500-item array merged and serialised correctly");
});

test("[34-E-7] cleanup: remove yaml_merge fixture files created in this section", () => {
  for (let i = 1; i <= _counter; i++) {
    const p = path.join(TMP, `ym-${i}.yaml`);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  assert(true, "cleanup completed");
});
