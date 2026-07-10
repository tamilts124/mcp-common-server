// test/sections/162-find-insecure-deserialization.js
// Tests for find_insecure_deserialization + find_prototype_pollution_via_merge
"use strict";
const path = require("path");
const os   = require("os");
const fs   = require("fs");
const { findInsecureDeserialization }    = require("../../lib/insecureDeserializationOps");
const { findPrototypePollutionViaMerge } = require("../../lib/prototypePollutionMergeOps");

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { console.log("  \u2713", msg); passed++; }
  else       { console.error("  \u2717", msg); failed++; }
}

function withTmp(name, content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deser-test-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, "utf8");
  try { fn(dir, file); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// === find_insecure_deserialization ===

console.log("\n=== find_insecure_deserialization ===\n");

// 1. node-serialize unserialize -> error
console.log("1. node-serialize unserialize detected");
withTmp("a.js", `
const serialize = require('node-serialize');
const obj = serialize.unserialize(req.body.data);
`, (dir) => {
  const r = findInsecureDeserialization(dir, ".");
  assert(r.findings.some(f => f.rule === "unsafe_deserializer_call"), "detected unserialize");
  assert(r.findings.some(f => f.severity === "error"), "severity=error");
});

// 2. vm.runInThisContext -> error
console.log("2. vm.runInThisContext detected");
withTmp("b.js", `
const vm = require('vm');
vm.runInThisContext(userCode);
`, (dir) => {
  const r = findInsecureDeserialization(dir, ".");
  assert(r.findings.some(f => f.rule === "unsafe_deserializer_call"), "detected vm.runInThisContext");
});

// 3. unsafe yaml.load -> error
console.log("3. yaml.load without SAFE_SCHEMA -> error");
withTmp("c.js", `
const yaml = require('js-yaml');
const data = yaml.load(req.body.config);
`, (dir) => {
  const r = findInsecureDeserialization(dir, ".");
  assert(r.findings.some(f => f.rule === "unsafe_yaml_load"), "detected unsafe_yaml_load");
});

// 4. yaml.load with SAFE_SCHEMA suppressed
console.log("4. yaml.load with SAFE_SCHEMA -> suppressed");
withTmp("d.js", `
const yaml = require('js-yaml');
const data = yaml.load(str, { schema: yaml.SAFE_SCHEMA });
`, (dir) => {
  const r = findInsecureDeserialization(dir, ".");
  assert(!r.findings.some(f => f.rule === "unsafe_yaml_load"), "no finding when SAFE_SCHEMA present");
});

// 5. JSON.parse with req.body -> warning
console.log("5. JSON.parse with req.body -> warning");
withTmp("e.js", `
const data = JSON.parse(req.body.raw);
`, (dir) => {
  const r = findInsecureDeserialization(dir, ".");
  assert(r.findings.some(f => f.rule === "json_parse_untrusted_source"), "detected json_parse_untrusted_source");
  assert(r.findings.some(f => f.severity === "warning"), "severity=warning");
});

// 6. // safe suppression
console.log("6. // safe annotation suppresses");
withTmp("f.js", `
const obj = serialize.unserialize(data); // safe
`, (dir) => {
  const r = findInsecureDeserialization(dir, ".");
  assert(r.findings.length === 0, "no findings with // safe");
});

// 7. Bad path throws
console.log("7. Bad path throws ToolError");
try {
  findInsecureDeserialization("/bad/path", "/bad/path");
  assert(false, "should throw");
} catch(e) {
  assert(e.message.includes("cannot access") || e.message.includes("ENOENT"), "throws ToolError");
}

// 8. Non-array extensions -> error
console.log("8. Invalid extensions");
withTmp("g.js", `serialize.unserialize(x);`, (dir) => {
  try {
    findInsecureDeserialization(dir, ".", { extensions: "str" });
    assert(false, "should throw");
  } catch(e) {
    assert(e.message.includes("extensions"), "error mentions extensions");
  }
});

// 9. Empty file
console.log("9. Empty file -> 0 findings");
withTmp("h.js", "", (dir) => {
  const r = findInsecureDeserialization(dir, ".");
  assert(r.findingsCount === 0, "0 findings on empty file");
});

// 10. // nosec suppresses vm call
console.log("10. // nosec suppresses vm.runInThisContext");
withTmp("i.js", `vm.runInThisContext(code); // nosec`, (dir) => {
  const r = findInsecureDeserialization(dir, ".");
  assert(r.findings.length === 0, "no findings with // nosec");
});

// === find_prototype_pollution_via_merge ===

console.log("\n=== find_prototype_pollution_via_merge ===\n");

// 11. _.merge with req.body -> error
console.log("11. _.merge with req.body -> error");
withTmp("m1.js", `
const result = _.merge(target, req.body);
`, (dir) => {
  const r = findPrototypePollutionViaMerge(dir, ".");
  assert(r.findings.some(f => f.rule === "deep_merge_with_user_input"), "detected deep_merge_with_user_input");
  assert(r.findings.some(f => f.severity === "error"), "severity=error");
});

// 12. deepmerge with body input -> error
console.log("12. deepmerge with body -> error");
withTmp("m2.js", `
const merged = deepmerge(defaults, body);
`, (dir) => {
  const r = findPrototypePollutionViaMerge(dir, ".");
  assert(r.findings.some(f => f.rule === "deep_merge_with_user_input"), "detected deepmerge finding");
});

// 13. _.merge with __proto__ guard -> suppressed
console.log("13. _.merge with __proto__ guard suppressed");
withTmp("m3.js", `
// sanitize __proto__ before merge
delete req.body.__proto__;
const result = _.merge(target, req.body);
`, (dir) => {
  const r = findPrototypePollutionViaMerge(dir, ".");
  assert(!r.findings.some(f => f.rule === "deep_merge_with_user_input"), "no finding with __proto__ guard");
});

// 14. Object.assign spread with req.body -> warning
console.log("14. Spread {...req.body} -> warning");
withTmp("m4.js", `
const cfg = { ...req.body, id: 42 };
`, (dir) => {
  const r = findPrototypePollutionViaMerge(dir, ".");
  assert(r.findings.some(f => f.rule === "object_assign_spread_no_sanitize"), "detected spread warning");
  assert(r.findings.some(f => f.severity === "warning"), "severity=warning");
});

// 15. custom mergeDeep with input -> error
console.log("15. mergeDeep with input -> error");
withTmp("m5.js", `
const result = mergeDeep(defaults, data);
`, (dir) => {
  const r = findPrototypePollutionViaMerge(dir, ".");
  assert(r.findings.some(f => f.rule === "recursive_assign_with_user_input"), "detected recursive_assign");
});

// 16. // sanitized annotation suppresses
console.log("16. // sanitized suppresses");
withTmp("m6.js", `
const result = _.merge(target, req.body); // sanitized
`, (dir) => {
  const r = findPrototypePollutionViaMerge(dir, ".");
  assert(r.findings.length === 0, "no findings with // sanitized");
});

// 17. Bad path throws
console.log("17. Bad path throws");
try {
  findPrototypePollutionViaMerge("/no/path", "/no/path");
  assert(false, "should throw");
} catch(e) {
  assert(e.message.includes("cannot access") || e.message.includes("ENOENT"), "throws on bad path");
}

// 18. Non-number max_results -> error
console.log("18. max_results non-number -> error");
withTmp("m7.js", `_.merge(t, req.body);`, (dir) => {
  try {
    findPrototypePollutionViaMerge(dir, ".", { maxResults: "five" });
    assert(false, "should throw");
  } catch(e) {
    assert(e.message.includes("max_results"), "error mentions max_results");
  }
});

// 19. No merge calls -> 0 findings
console.log("19. No merge calls -> 0 findings");
withTmp("m8.js", `const x = req.body; db.insert(x);`, (dir) => {
  const r = findPrototypePollutionViaMerge(dir, ".");
  assert(r.findingsCount === 0, "0 findings with no merge");
});

// 20. Object.assign with hasOwnProperty guard -> suppressed
console.log("20. Object.assign with hasOwnProperty guard suppressed");
withTmp("m9.js", `
// hasOwnProperty check ensures safe keys
if (!Object.prototype.hasOwnProperty.call(req.body, '__proto__')) {
  Object.assign(target, req.body);
}
`, (dir) => {
  const r = findPrototypePollutionViaMerge(dir, ".");
  assert(!r.findings.some(f => f.severity === "error"), "no error findings with hasOwnProperty guard");
});

// Summary
console.log("\n=== Results: " + passed + " passed, " + failed + " failed ===\n");
if (failed > 0) process.exit(1);
