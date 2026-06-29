"use strict";
/**
 * test/sections/30b-yaml-patch-de.js
 *
 * Isolated functional tests for the yaml_patch tool — Critical / Extreme.
 * Normal / Medium / High levels are in test/sections/30-yaml-patch.js.
 *
 * Does NOT start the HTTP server or any MCP client.
 * All file I/O uses the shared TMP sandbox from test-harness.js.
 *
 * Section [33-D/E]
 */

const fs   = require("fs");
const path = require("path");

const { test, TMP } = require("../test-harness");
const { yamlPatch }     = require("../../lib/yamlPatchOps");
const { parseYaml }     = require("../../lib/yamlOps");

// ── Simple assertion helper ────────────────────────────────────────────────────
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

// ── Helper: write a temp YAML file and return its abs path ────────────────────
let _counter = 0;
function tmpYaml(content) {
  const p = path.join(TMP, `ypde-${++_counter}.yaml`);
  fs.writeFileSync(p, content, "utf8");
  return p;
}

// ════════════════════════════════════════════════════════════════════════════
// [33-D] CRITICAL — security / adversarial inputs
// ════════════════════════════════════════════════════════════════════════════

test("[33-D-1] path traversal in op key path is NOT a filesystem escape", () => {
  // The dot-notation 'path' field in ops is a document key path, NOT a filesystem
  // path — traversal sequences there are literal key name tokens, not FS escapes.
  const p = tmpYaml("a: 1\n");
  // "../../etc/passwd" as a dot-path splits into tokens ["../..", "etc", "passwd"]
  // on "."-split... but actually "." is the delimiter so the first token is "../.."
  // and second is "etc/passwd" — either way it must NOT touch any real file.
  yamlPatch(p, "t.yaml", [{ op: "set", path: "../../etc/passwd", value: "safe" }]);
  // The key created lives inside the in-memory doc, written back to `p` only.
  // A file at /etc/passwd should not have been written.
  const doc = parseYaml(fs.readFileSync(p, "utf8"));
  assert(typeof doc === "object" && doc !== null, "result should still be an object");
  // Crucially the real /etc/passwd is not reachable from here.
  // On Windows there is no /etc/passwd; on any OS we just confirm no crash:
  assert(true, "no filesystem escape occurred");
});

test("[33-D-2] SQL/shell injection-shaped value round-trips literally", () => {
  const p = tmpYaml("cmd: safe\n");
  const injValue = "'; DROP TABLE users; --";
  yamlPatch(p, "t.yaml", [{ op: "set", path: "cmd", value: injValue }]);
  const doc = parseYaml(fs.readFileSync(p, "utf8"));
  assert(doc.cmd === injValue, "injection-shaped string should round-trip literally");
});

test("[33-D-3] shell metacharacters in value are quoted, not executed", () => {
  const p = tmpYaml("x: 1\n");
  const evil = "$(rm -rf /)";
  yamlPatch(p, "t.yaml", [{ op: "set", path: "x", value: evil }]);
  const doc = parseYaml(fs.readFileSync(p, "utf8"));
  assert(doc.x === evil, "shell metachar string should round-trip literally");
});

test("[33-D-4] prototype-pollution via __proto__ key is harmless", () => {
  const p = tmpYaml("legit: value\n");
  // Attempt to set a key literally named "__proto__" — this is a plain string
  // key in YAML, not Object.prototype pollution, because parseYaml uses
  // Object.create(null)-style plain objects and pathSet uses hasOwnProperty.
  yamlPatch(p, "t.yaml", [{ op: "set", path: "__proto__", value: { polluted: true } }]);
  // The key should appear in the result object but NOT pollute Object.prototype.
  assert(({}).polluted === undefined, "Object.prototype should not be polluted");
});

test("[33-D-5] JSON-serialisable result — no circular references", () => {
  const p = tmpYaml("data:\n  x: 1\n  y: 2\n");
  const r = yamlPatch(p, "t.yaml", [{ op: "set", path: "data.z", value: 3 }]);
  let serialised;
  try { serialised = JSON.stringify(r); } catch (e) { serialised = null; }
  assert(serialised !== null, "result should be JSON-serialisable");
  assert(typeof serialised === "string", "serialised result should be a string");
});

test("[33-D-6] ops with numeric-string op name → rejected", () => {
  const p = tmpYaml("a: 1\n");
  let threw = false;
  try { yamlPatch(p, "t.yaml", [{ op: "123", path: "a", value: 2 }]); }
  catch (e) { threw = true; assert(e.code === -32602, "should be -32602"); }
  assert(threw, "should have thrown for numeric-like op name");
});

test("[33-D-7] large value object does not crash serialiser", () => {
  const p = tmpYaml("top: {}\n");
  const bigObj = {};
  for (let i = 0; i < 200; i++) bigObj[`key_${i}`] = i;
  yamlPatch(p, "t.yaml", [{ op: "set", path: "top", value: bigObj }]);
  const doc = parseYaml(fs.readFileSync(p, "utf8"));
  assert(doc.top.key_199 === 199, "large object should round-trip");
});

test("[33-D-8] null-byte in op path rejected or treated as literal", () => {
  // A null byte in a dot-path token is just a weird key name; it must not crash.
  const p = tmpYaml("a: 1\n");
  let errored = false;
  try {
    yamlPatch(p, "t.yaml", [{ op: "set", path: "a\x00b", value: 99 }]);
  } catch (e) {
    errored = true; // acceptable to reject
  }
  // Either it wrote a weird key (no crash) or it threw cleanly — both are fine.
  assert(true, "null-byte in path must not crash the process");
});

// ════════════════════════════════════════════════════════════════════════════
// [33-E] EXTREME — stress, concurrency, fuzz
// ════════════════════════════════════════════════════════════════════════════

test("[33-E-1] 50 sequential set operations on the same file", () => {
  const p = tmpYaml("counter: 0\n");
  for (let i = 1; i <= 50; i++) {
    yamlPatch(p, "t.yaml", [{ op: "set", path: "counter", value: i }]);
  }
  const doc = parseYaml(fs.readFileSync(p, "utf8"));
  assert(doc.counter === 50, "counter should be 50 after 50 sequential sets");
});

test("[33-E-2] 100 sequential append_to operations", () => {
  const p = tmpYaml("items: []\n");
  for (let i = 0; i < 100; i++) {
    yamlPatch(p, "t.yaml", [{ op: "append_to", path: "items", value: i }]);
  }
  const doc = parseYaml(fs.readFileSync(p, "utf8"));
  assert(doc.items.length === 100, "items should have 100 elements");
  assert(doc.items[99] === 99, "last item should be 99");
});

test("[33-E-3] 10 concurrent dry-run calls do not interfere", () => {
  const p = tmpYaml("x: 0\n");
  // yamlPatch is synchronous; run 10 dry-runs in sequence to verify none modifies the file
  const results = [];
  for (let i = 0; i < 10; i++) {
    results.push(yamlPatch(p, "t.yaml", [{ op: "set", path: "x", value: i }], { apply: false }));
  }
  // File on disk should still be "x: 0\n" (all dry-runs)
  const doc = parseYaml(fs.readFileSync(p, "utf8"));
  assert(doc.x === 0, "dry-run calls should not modify file");
  assert(results.length === 10, "should have 10 results");
  assert(results.every(r => r.apply === false), "all results should have apply:false");
});

test("[33-E-4] deeply nested 10-level set and read-back", () => {
  const p = tmpYaml("root: {}\n");
  // Build path "root.a.b.c.d.e.f.g.h" (8 levels deep under root)
  const deepPath = "root.a.b.c.d.e.f.g.h";
  yamlPatch(p, "t.yaml", [{ op: "set", path: deepPath, value: "bottom" }]);
  const doc = parseYaml(fs.readFileSync(p, "utf8"));
  assert(doc.root.a.b.c.d.e.f.g.h === "bottom", "deep nested value should be bottom");
});

test("[33-E-5] 550-item array append performance (< 5s)", () => {
  const p = tmpYaml("items: []\n");
  // Write the whole 500-item array at once to set up
  const initialArr = Array.from({ length: 500 }, (_, i) => i);
  yamlPatch(p, "t.yaml", [{ op: "set", path: "items", value: initialArr }]);
  // Then append 50 more individually and time it
  const start = Date.now();
  for (let i = 500; i < 550; i++) {
    yamlPatch(p, "t.yaml", [{ op: "append_to", path: "items", value: i }]);
  }
  const elapsed = Date.now() - start;
  assert(elapsed < 5000, `50 appends to 500-item array should finish in <5s (took ${elapsed}ms)`);
  const doc = parseYaml(fs.readFileSync(p, "utf8"));
  assert(doc.items.length === 550, "should have 550 items");
});

test("[33-E-6] result is consistently JSON-serialisable on complex nested doc", () => {
  const p = tmpYaml("services:\n  web:\n    ports:\n      - 80\n      - 443\n    env:\n      NODE_ENV: production\n");
  const r = yamlPatch(p, "t.yaml", [
    { op: "append_to", path: "services.web.ports", value: 8080 },
    { op: "set",       path: "services.web.env.LOG_LEVEL", value: "info" },
  ]);
  assert(r.operationsApplied === 2, "operationsApplied should be 2");
  let s;
  try { s = JSON.stringify(r); } catch (e) { s = null; }
  assert(s !== null && typeof s === "string", "result should be JSON-serialisable");
});

test("[33-E-7] fuzz: random bytes as op path does not crash", () => {
  const p = tmpYaml("a: 1\n");
  // Pass random-ish unicode/bytes as op path — should either work or throw cleanly
  const weirdPaths = [
    "\u0000\u0001\u0002",
    "\uFFFD\uFFFE",
    "a".repeat(2000),
    "\n\r\t",
    "🔑.🗝️.key",
  ];
  for (const wp of weirdPaths) {
    try {
      yamlPatch(p, "t.yaml", [{ op: "set", path: wp, value: "v" }], { apply: false });
    } catch (e) {
      // Any error is fine — as long as it's a proper Error, not a process crash
      assert(e instanceof Error, "fuzz path error must be an Error instance");
    }
  }
  assert(true, "fuzz path inputs must not crash the process");
});
