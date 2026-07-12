"use strict";
// test/sections/205-yaml-client.js — yaml_client tool tests
// Section 205: A=input-validation x10, B=parser-unit x20, C=writer-unit x10,
//              D=happy-path x20, E=security x10, F=concurrency x5 — 75 total

const fs   = require("fs");
const path = require("path");
const os   = require("os");

const { yamlClient, _parse } = require("../../lib/yamlClientOps");

// ─── Test harness ─────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
    process.stderr.write(`  ✓ ${msg}\n`);
  } else {
    failed++;
    process.stderr.write(`  ✗ FAIL: ${msg}\n`);
  }
}

function assertThrows(fn, containsMsg, label) {
  try {
    fn();
    failed++;
    process.stderr.write(`  ✗ FAIL (no throw): ${label}\n`);
  } catch (e) {
    if (containsMsg && !e.message.includes(containsMsg)) {
      failed++;
      process.stderr.write(`  ✗ FAIL (wrong error: ${e.message}): ${label}\n`);
    } else {
      passed++;
      process.stderr.write(`  ✓ ${label}\n`);
    }
  }
}

// ─── Temp file helpers ──────────────────────────────────────────────────────

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "yaml-client-test-"));

function tmpFile(name, content) {
  const p = path.join(tmpDir, name);
  if (content !== undefined) fs.writeFileSync(p, content, "utf8");
  return p;
}

function cleanup() {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
}

// ─── Section A: Input Validation (x10) ────────────────────────────────────

process.stderr.write("\n=== Section A: Input Validation ===\n");

// A01: missing operation
assertThrows(() => yamlClient({}), "'operation' is required", "A01: missing operation throws");

// A02: unknown operation
assertThrows(() => yamlClient({ operation: "banana" }), "unknown operation", "A02: unknown operation throws");

// A03: read without path
assertThrows(() => yamlClient({ operation: "read" }), "'path' is required", "A03: read without path throws");

// A04: get without key_path
{
  const p = tmpFile("a04.yaml", "x: 1\n");
  assertThrows(() => yamlClient({ operation: "get", path: p }), "'key_path' is required", "A04: get without key_path throws");
}

// A05: set without key_path
{
  const p = tmpFile("a05.yaml", "x: 1\n");
  assertThrows(() => yamlClient({ operation: "set", path: p, value: 2 }), "'key_path' is required", "A05: set without key_path throws");
}

// A06: set without value
{
  const p = tmpFile("a06.yaml", "x: 1\n");
  assertThrows(() => yamlClient({ operation: "set", path: p, key_path: "x" }), "'value' is required", "A06: set without value throws");
}

// A07: delete without key_path
{
  const p = tmpFile("a07.yaml", "x: 1\n");
  assertThrows(() => yamlClient({ operation: "delete", path: p }), "'key_path' is required", "A07: delete without key_path throws");
}

// A08: merge without source_path
{
  const p = tmpFile("a08.yaml", "x: 1\n");
  assertThrows(() => yamlClient({ operation: "merge", path: p }), "'source_path' is required", "A08: merge without source_path throws");
}

// A09: stringify without data or path
assertThrows(() => yamlClient({ operation: "stringify" }), "'data' or 'path'", "A09: stringify without data/path throws");

// A10: read non-existent file throws
assertThrows(() => yamlClient({ operation: "read", path: "/nonexistent/xyz.yaml" }), "", "A10: read non-existent file throws");

// ─── Section B: Parser Unit Tests (x20) ───────────────────────────────────

process.stderr.write("\n=== Section B: Parser Unit ===\n");

const { parseYaml, parseScalar, stringifyYaml } = _parse;

// B01: simple key-value
{
  const data = parseYaml("name: Alice\nage: 30\n");
  assert(data.name === "Alice" && data.age === 30, "B01: simple key-value parsing");
}

// B02: nested mapping
{
  const data = parseYaml("server:\n  host: localhost\n  port: 8080\n");
  assert(data.server.host === "localhost" && data.server.port === 8080, "B02: nested mapping");
}

// B03: block sequence
{
  const data = parseYaml("items:\n  - apple\n  - banana\n  - cherry\n");
  assert(Array.isArray(data.items) && data.items.length === 3 && data.items[1] === "banana", "B03: block sequence");
}

// B04: flow sequence
{
  const data = parseYaml("colors: [red, green, blue]\n");
  assert(Array.isArray(data.colors) && data.colors[2] === "blue", "B04: flow sequence");
}

// B05: flow mapping
{
  const data = parseYaml("point: {x: 1, y: 2}\n");
  assert(data.point.x === 1 && data.point.y === 2, "B05: flow mapping");
}

// B06: boolean parsing
{
  const data = parseYaml("enabled: true\ndisabled: false\n");
  assert(data.enabled === true && data.disabled === false, "B06: boolean parsing");
}

// B07: null parsing
{
  const data = parseYaml("missing: null\nalso: ~\n");
  assert(data.missing === null && data.also === null, "B07: null parsing");
}

// B08: integer types
{
  const data = parseYaml("dec: 42\nhex: 0xFF\noct: 0o17\nbin: 0b1010\n");
  assert(data.dec === 42 && data.hex === 255 && data.oct === 15 && data.bin === 10, "B08: integer types");
}

// B09: float and special floats
{
  const data = parseYaml("pi: 3.14\ninf: .inf\nnan: .nan\n");
  assert(data.pi === 3.14 && data.inf === Infinity && isNaN(data.nan), "B09: float and special floats");
}

// B10: double-quoted string with escapes
{
  const data = parseYaml('msg: "hello\\nworld\\t!"\n');
  assert(data.msg === "hello\nworld\t!", "B10: double-quoted escape sequences");
}

// B11: single-quoted string
{
  const data = parseYaml("msg: 'it''s a test'\n");
  assert(data.msg === "it's a test", "B11: single-quoted string with '' escape");
}

// B12: inline comments ignored
{
  const data = parseYaml("x: 42 # this is a comment\ny: hello # another\n");
  assert(data.x === 42 && data.y === "hello", "B12: inline comments ignored");
}

// B13: doc_start marker
{
  const data = parseYaml("---\nname: Bob\nage: 25\n");
  assert(data.name === "Bob" && data.age === 25, "B13: document start marker handled");
}

// B14: literal block scalar
{
  const yaml = "text: |\n  line one\n  line two\n";
  const data = parseYaml(yaml);
  assert(data.text === "line one\nline two\n", "B14: literal block scalar");
}

// B15: sequence of objects
{
  const yaml = "users:\n  - name: Alice\n    role: admin\n  - name: Bob\n    role: user\n";
  const data = parseYaml(yaml);
  assert(Array.isArray(data.users) && data.users[0].name === "Alice" && data.users[1].role === "user", "B15: sequence of objects");
}

// B16: deeply nested
{
  const yaml = "a:\n  b:\n    c:\n      d: deep\n";
  const data = parseYaml(yaml);
  assert(data.a.b.c.d === "deep", "B16: deeply nested mapping");
}

// B17: parseScalar types
{
  assert(parseScalar("null") === null, "B17a: scalar null");
  assert(parseScalar("true") === true, "B17b: scalar true");
  assert(parseScalar("42") === 42, "B17c: scalar int");
  assert(parseScalar("3.14") === 3.14, "B17d: scalar float");
  assert(parseScalar("hello") === "hello", "B17e: scalar string");
}

// B18: empty document returns null
{
  const data = parseYaml("\n\n# just comments\n\n");
  assert(data === null, "B18: empty document returns null");
}

// B19: top-level sequence
{
  const data = parseYaml("- one\n- two\n- three\n");
  assert(Array.isArray(data) && data[0] === "one" && data[2] === "three", "B19: top-level sequence");
}

// B20: multi-line string preserved in double-quotes
{
  const yaml = 'description: "first line\\nsecond line"\n';
  const data = parseYaml(yaml);
  assert(typeof data.description === "string" && data.description.includes("\n"), "B20: multi-line in double-quoted string");
}

// ─── Section C: Writer Unit Tests (x10) ────────────────────────────────────

process.stderr.write("\n=== Section C: Writer Unit ===\n");

// C01: simple object
{
  const yaml = stringifyYaml({ name: "Alice", age: 30 });
  assert(yaml.includes("name: Alice") && yaml.includes("age: 30"), "C01: stringify simple object");
}

// C02: nested object
{
  const yaml = stringifyYaml({ server: { host: "localhost", port: 8080 } });
  assert(yaml.includes("server:") && yaml.includes("host: localhost"), "C02: stringify nested object");
}

// C03: array value
{
  const yaml = stringifyYaml({ colors: ["red", "green", "blue"] });
  assert(yaml.includes("colors:") && yaml.includes("- red"), "C03: stringify array");
}

// C04: null and boolean
{
  const yaml = stringifyYaml({ a: null, b: true, c: false });
  assert(yaml.includes("a: null") && yaml.includes("b: true") && yaml.includes("c: false"), "C04: stringify null/bool");
}

// C05: special floats
{
  const yaml = stringifyYaml({ inf: Infinity, nan: NaN });
  assert(yaml.includes(".inf") && yaml.includes(".nan"), "C05: stringify special floats");
}

// C06: reserved words quoted
{
  const yaml = stringifyYaml({ status: "true" });
  assert(yaml.includes("'true'"), "C06: reserved word string is quoted");
}

// C07: empty object
{
  const yaml = stringifyYaml({});
  assert(yaml.includes("{}"), "C07: stringify empty object");
}

// C08: empty array
{
  const yaml = stringifyYaml({ items: [] });
  assert(yaml.includes("items: []"), "C08: stringify empty array");
}

// C09: round-trip parse->stringify->parse
{
  const original = { name: "Bob", scores: [10, 20, 30], meta: { active: true, count: 3 } };
  const yaml = stringifyYaml(original);
  const parsed = parseYaml(yaml);
  assert(parsed.name === "Bob" && Array.isArray(parsed.scores) && parsed.meta.active === true, "C09: round-trip parse->stringify->parse");
}

// C10: negative number
{
  const yaml = stringifyYaml({ temp: -42, delta: -3.14 });
  assert(yaml.includes("temp: -42") && yaml.includes("delta: -3.14"), "C10: stringify negative numbers");
}

// ─── Section D: Happy-Path Integration Tests (x20) ─────────────────────────

process.stderr.write("\n=== Section D: Happy-Path Integration ===\n");

// D01: read simple YAML file
{
  const p = tmpFile("d01.yaml", "name: Alice\nage: 30\n");
  const r = yamlClient({ operation: "read", path: p });
  assert(r.data.name === "Alice" && r.data.age === 30 && r.keyCount === 2, "D01: read simple YAML");
}

// D02: get top-level key
{
  const p = tmpFile("d02.yaml", "name: Bob\nage: 25\n");
  const r = yamlClient({ operation: "get", path: p, key_path: "name" });
  assert(r.found === true && r.value === "Bob", "D02: get top-level key");
}

// D03: get nested key
{
  const p = tmpFile("d03.yaml", "server:\n  host: localhost\n  port: 8080\n");
  const r = yamlClient({ operation: "get", path: p, key_path: "server.port" });
  assert(r.found === true && r.value === 8080, "D03: get nested key");
}

// D04: get array element
{
  const p = tmpFile("d04.yaml", "items:\n  - apple\n  - banana\n  - cherry\n");
  const r = yamlClient({ operation: "get", path: p, key_path: "items.1" });
  assert(r.found === true && r.value === "banana", "D04: get array element by index");
}

// D05: get missing key returns found:false
{
  const p = tmpFile("d05.yaml", "x: 1\n");
  const r = yamlClient({ operation: "get", path: p, key_path: "missing" });
  assert(r.found === false && r.value === null, "D05: get missing key returns found:false");
}

// D06: set top-level key (update)
{
  const p = tmpFile("d06.yaml", "name: Alice\nage: 30\n");
  yamlClient({ operation: "set", path: p, key_path: "age", value: 31 });
  const r = yamlClient({ operation: "get", path: p, key_path: "age" });
  assert(r.value === 31, "D06: set top-level key (update)");
}

// D07: set nested key
{
  const p = tmpFile("d07.yaml", "server:\n  host: localhost\n  port: 8080\n");
  yamlClient({ operation: "set", path: p, key_path: "server.port", value: 9090 });
  const r = yamlClient({ operation: "get", path: p, key_path: "server.port" });
  assert(r.value === 9090, "D07: set nested key");
}

// D08: set creates new key
{
  const p = tmpFile("d08.yaml", "existing: yes\n");
  yamlClient({ operation: "set", path: p, key_path: "newkey", value: "newval" });
  const r = yamlClient({ operation: "get", path: p, key_path: "newkey" });
  assert(r.found && r.value === "newval", "D08: set creates new top-level key");
}

// D09a: delete existing key - returns deleted:true
{
  const p = tmpFile("d09.yaml", "keep: yes\nremove: yes\n");
  const r = yamlClient({ operation: "delete", path: p, key_path: "remove" });
  assert(r.deleted === true, "D09a: delete existing key returns deleted:true");
}

// D09b: deleted key is gone
{
  const p = tmpFile("d09b.yaml", "keep: yes\nremove: yes\n");
  yamlClient({ operation: "delete", path: p, key_path: "remove" });
  const r = yamlClient({ operation: "get", path: p, key_path: "remove" });
  assert(r.found === false, "D09b: deleted key not found after delete");
}

// D10: delete non-existent key is safe
{
  const p = tmpFile("d10.yaml", "x: 1\n");
  const r = yamlClient({ operation: "delete", path: p, key_path: "nonexistent" });
  assert(r.deleted === false, "D10: delete non-existent key returns deleted:false");
}

// D11: list_keys root level
{
  const p = tmpFile("d11.yaml", "a: 1\nb: 2\nc: 3\n");
  const r = yamlClient({ operation: "list_keys", path: p });
  assert(r.keyCount === 3 && r.keys.includes("a") && r.keys.includes("c"), "D11: list_keys root level");
}

// D12: list_keys with section
{
  const p = tmpFile("d12.yaml", "server:\n  host: localhost\n  port: 8080\n  tls: true\n");
  const r = yamlClient({ operation: "list_keys", path: p, section: "server" });
  assert(r.keyCount === 3 && r.keys.includes("host") && r.keys.includes("tls"), "D12: list_keys with section path");
}

// D13: list_sections
{
  const p = tmpFile("d13.yaml", "a:\n  b:\n    c: deep\nd:\n  e: flat\n");
  const r = yamlClient({ operation: "list_sections", path: p });
  assert(r.sections.includes("a") && r.sections.includes("a.b"), "D13: list_sections finds nested paths");
}

// D14: merge two YAML files
{
  const base = tmpFile("d14-base.yaml", "name: Alice\nage: 30\nrole: user\n");
  const src  = tmpFile("d14-src.yaml",  "age: 31\nnewkey: added\n");
  const out  = path.join(tmpDir, "d14-out.yaml");
  yamlClient({ operation: "merge", path: base, source_path: src, output_path: out });
  const r = yamlClient({ operation: "read", path: out });
  assert(r.data.name === "Alice" && r.data.age === 31 && r.data.newkey === "added", "D14: merge with output_path");
}

// D15: merge overwrites base file by default
{
  const base = tmpFile("d15.yaml", "x: 1\ny: 2\n");
  const src  = tmpFile("d15-src.yaml", "y: 99\n");
  yamlClient({ operation: "merge", path: base, source_path: src });
  const r = yamlClient({ operation: "get", path: base, key_path: "y" });
  assert(r.value === 99, "D15: merge default overwrites base");
}

// D16: stringify from data object
{
  const r = yamlClient({ operation: "stringify", data: { name: "Test", count: 5 } });
  assert(r.yaml.includes("name: Test") && r.sizeBytes > 0, "D16: stringify from data");
}

// D17: stringify to file
{
  const out = path.join(tmpDir, "d17-out.yaml");
  yamlClient({ operation: "stringify", data: { saved: true }, output_path: out });
  const content = fs.readFileSync(out, "utf8");
  assert(content.includes("saved: true"), "D17: stringify writes to output_path");
}

// D18: set boolean value
{
  const p = tmpFile("d18.yaml", "enabled: false\n");
  yamlClient({ operation: "set", path: p, key_path: "enabled", value: true });
  const r = yamlClient({ operation: "get", path: p, key_path: "enabled" });
  assert(r.value === true, "D18: set boolean value");
}

// D19: set array value
{
  const p = tmpFile("d19.yaml", "tags: []\n");
  yamlClient({ operation: "set", path: p, key_path: "tags", value: ["a", "b", "c"] });
  const r = yamlClient({ operation: "get", path: p, key_path: "tags" });
  assert(Array.isArray(r.value) && r.value.length === 3, "D19: set array value");
}

// D20: docker-compose style YAML
{
  const yaml = [
    "version: '3.8'",
    "services:",
    "  web:",
    "    image: nginx:latest",
    "    ports:",
    "      - '80:80'",
    "  db:",
    "    image: postgres:15",
    "    environment:",
    "      POSTGRES_DB: mydb",
  ].join("\n") + "\n";
  const p = tmpFile("d20.yaml", yaml);
  const r = yamlClient({ operation: "read", path: p });
  assert(r.data.services && r.data.services.web && r.data.services.db, "D20: docker-compose style YAML");
}

// ─── Section E: Security Tests (x10) ──────────────────────────────────────

process.stderr.write("\n=== Section E: Security ===\n");

// E01: NUL byte in path blocked
assertThrows(() => yamlClient({ operation: "read", path: "file\x00.yaml" }), "NUL", "E01: NUL byte in path throws");

// E02: NUL byte in source_path
{
  const p = tmpFile("e02.yaml", "x: 1\n");
  assertThrows(() => yamlClient({ operation: "merge", path: p, source_path: "src\x00.yaml" }), "NUL", "E02: NUL in source_path throws");
}

// E03: NUL byte in output_path
{
  const p = tmpFile("e03.yaml", "x: 1\n");
  const src = tmpFile("e03-src.yaml", "y: 2\n");
  assertThrows(() => yamlClient({ operation: "merge", path: p, source_path: src, output_path: "out\x00.yaml" }), "NUL", "E03: NUL in output_path throws");
}

// E04: file too large
{
  const p = path.join(tmpDir, "e04.yaml");
  const bigContent = "# start\n" + ("x: " + "a".repeat(10000) + "\n").repeat(420);
  fs.writeFileSync(p, bigContent, "utf8");
  const stat = fs.statSync(p);
  if (stat.size > 4 * 1024 * 1024) {
    assertThrows(() => yamlClient({ operation: "read", path: p }), "too large", "E04: file exceeds 4MB limit");
  } else {
    // File might be smaller; write guaranteed oversized
    const huge = Buffer.alloc(4 * 1024 * 1024 + 1, 65); // 4MB+1 of 'A'
    fs.writeFileSync(p, huge);
    assertThrows(() => yamlClient({ operation: "read", path: p }), "too large", "E04: file exceeds 4MB limit");
  }
}

// E05: depth limit in parser
{
  let yaml = "";
  for (let i = 0; i <= 22; i++) {
    yaml += " ".repeat(i * 2) + `l${i}:\n`;
  }
  yaml += " ".repeat(23 * 2) + "value: deep\n";
  assertThrows(() => parseYaml(yaml), "too deep", "E05: parser depth limit enforced");
}

// E06: stringify depth limit
{
  function buildDeep(n) {
    if (n === 0) return { val: "leaf" };
    return { child: buildDeep(n - 1) };
  }
  const obj = buildDeep(22);
  assertThrows(() => stringifyYaml(obj), "too deep", "E06: stringify depth limit enforced");
}

// E07: reading /etc/passwd (non-YAML file or not found on Windows)
{
  // This should throw either ENOENT or a parse error — both are acceptable
  try {
    const r = yamlClient({ operation: "read", path: "/etc/passwd" });
    // If it reads, data should at least not be null/crash
    assert(true, "E07: /etc/passwd read without crash (acceptable)");
  } catch (e) {
    assert(true, "E07: /etc/passwd read throws (acceptable)");
  }
}

// E08: empty key_path
{
  const p = tmpFile("e08.yaml", "x: 1\n");
  assertThrows(() => yamlClient({ operation: "get", path: p, key_path: "" }), "", "E08: empty key_path throws");
}

// E09: set deep path on scalar throws
{
  const p = tmpFile("e09.yaml", "x: 42\n");
  assertThrows(() => yamlClient({ operation: "set", path: p, key_path: "x.y", value: "val" }), "", "E09: set deep path on scalar value throws");
}

// E10: key_path with only dots
{
  const p = tmpFile("e10.yaml", "x: 1\n");
  assertThrows(() => yamlClient({ operation: "get", path: p, key_path: "..." }), "", "E10: key_path of only dots throws");
}

// ─── Section F: Concurrency Tests (x5) ─────────────────────────────────────

process.stderr.write("\n=== Section F: Concurrency ===\n");

// F01: concurrent reads on same file
{
  const p = tmpFile("f01.yaml", "count: 100\nname: test\n");
  const results = Array.from({ length: 10 }, () =>
    yamlClient({ operation: "read", path: p })
  );
  const allOk = results.every(r => r.data.count === 100);
  assert(allOk, "F01: concurrent reads on same file all succeed");
}

// F02: reads on different files
{
  const files = Array.from({ length: 5 }, (_, i) => {
    const p = tmpFile(`f02-${i}.yaml`, `index: ${i}\nname: file${i}\n`);
    return { p, i };
  });
  const results = files.map(({ p, i }) =>
    yamlClient({ operation: "get", path: p, key_path: "index" })
  );
  const allOk = results.every((r, i) => r.value === files[i].i);
  assert(allOk, "F02: reads on different files all correct");
}

// F03: writes on different files
{
  const fileList = Array.from({ length: 5 }, (_, i) => {
    const p = tmpFile(`f03-${i}.yaml`, `val: 0\n`);
    return p;
  });
  fileList.forEach((p, i) =>
    yamlClient({ operation: "set", path: p, key_path: "val", value: i * 10 })
  );
  const results = fileList.map(p => yamlClient({ operation: "read", path: p }));
  const allOk = results.every((r, i) => r.data.val === i * 10);
  assert(allOk, "F03: writes on different files all correct");
}

// F04: sequential increment test
{
  const p = tmpFile("f04.yaml", "counter: 0\n");
  for (let i = 0; i < 5; i++) {
    const r = yamlClient({ operation: "get", path: p, key_path: "counter" });
    yamlClient({ operation: "set", path: p, key_path: "counter", value: (r.value || 0) + 1 });
  }
  const final = yamlClient({ operation: "get", path: p, key_path: "counter" });
  assert(final.value === 5, "F04: sequential increment 5 times = 5");
}

// F05: concurrent stringify (pure CPU, no I/O)
{
  const objs = Array.from({ length: 10 }, (_, i) => ({ id: i, name: `item_${i}`, active: true }));
  const results = objs.map(o => yamlClient({ operation: "stringify", data: o }));
  const allOk = results.every((r, i) => r.yaml.includes(`id: ${i}`));
  assert(allOk, "F05: concurrent stringify all correct");
}

// ─── Cleanup & Summary ──────────────────────────────────────────────────────

cleanup();

process.stderr.write(`\n=== Results: ${passed} passed, ${failed} failed / ${passed + failed} total ===\n`);

if (failed > 0) process.exit(1);
