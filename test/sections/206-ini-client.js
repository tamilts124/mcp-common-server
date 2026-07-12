"use strict";
/**
 * test/sections/206-ini-client.js
 * Comprehensive tests for ini_client (section 206)
 *
 * Groups:
 *   A — Input validation (10 tests)
 *   B — Parser unit tests (20 tests)
 *   C — Writer unit tests (10 tests)
 *   D — Happy-path end-to-end (20 tests)
 *   E — Security guards (10 tests)
 *   F — Concurrency / stress (5 tests)
 *
 * Total: 75 tests
 */

const fs   = require("fs");
const os   = require("os");
const path = require("path");

// ── Load the module under test directly ──────────────────────────────────────
const {
  parseIni,
  stringifySections,
  sectionsToObject,
  objectToSections,
  iniClient,
  GLOBAL_SECTION,
} = require("../../lib/iniClientOps");

// ── Test harness ─────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];

function assert(condition, name, detail = "") {
  if (condition) {
    passed++;
    process.stderr.write(`  ✓ ${name}\n`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ": " + detail : ""}`);
    process.stderr.write(`  ✗ ${name}${detail ? " — " + detail : ""}\n`);
  }
}

function assertThrows(fn, name, msgSubstring) {
  try {
    fn();
    failed++;
    failures.push(`${name}: expected throw but did not throw`);
    process.stderr.write(`  ✗ ${name} — expected throw\n`);
  } catch (e) {
    if (msgSubstring && !e.message.includes(msgSubstring)) {
      failed++;
      failures.push(`${name}: wrong error message: ${e.message}`);
      process.stderr.write(`  ✗ ${name} — wrong msg: ${e.message}\n`);
    } else {
      passed++;
      process.stderr.write(`  ✓ ${name}\n`);
    }
  }
}

// Temp dir helper
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ini-test-"));
function tmpPath(name) { return path.join(TMP, name); }
function writeTemp(name, content) {
  const p = tmpPath(name);
  fs.writeFileSync(p, content, "utf8");
  return p;
}

// ── Group A — Input validation ─────────────────────────────────────────────
process.stderr.write("\n[A] Input validation\n");

assertThrows(
  () => iniClient({ operation: "read" }),
  "A01 read without path throws",
  "non-empty string",
);

assertThrows(
  () => iniClient({ operation: "get", path: "file.ini" }),
  "A02 get without key_path throws",
  "key_path",
);

assertThrows(
  () => iniClient({ operation: "set", path: "file.ini", key_path: "s.k" }),
  "A03 set without value throws",
  "value",
);

assertThrows(
  () => iniClient({ operation: "delete", path: "file.ini" }),
  "A04 delete without key_path throws",
  "key_path",
);

assertThrows(
  () => iniClient({ operation: "merge", path: "file.ini" }),
  "A05 merge without source_path throws",
  "source_path",
);

assertThrows(
  () => iniClient({ operation: "stringify" }),
  "A06 stringify without data or path throws",
  "provide",
);

assertThrows(
  () => iniClient({ operation: "stringify", data: [1, 2, 3] }),
  "A07 stringify with array data throws",
  "plain object",
);

assertThrows(
  () => iniClient({ operation: "read", path: "a\0b" }),
  "A08 NUL in path throws",
  "NUL",
);

assertThrows(
  () => iniClient({ operation: "unknown_op" }),
  "A09 unknown operation throws",
  "unknown operation",
);

assertThrows(
  () => iniClient({ operation: "stringify", data: {}, path: "x.ini" }),
  "A10 stringify with both data and path throws",
  "not both",
);

// ── Group B — Parser unit tests ───────────────────────────────────────────
process.stderr.write("\n[B] Parser unit tests\n");

{
  const m = parseIni("[s1]\nfoo=bar\nbaz=qux\n");
  assert(m.has("s1"), "B01 single section parsed");
  assert(m.get("s1").get("foo") === "bar", "B02 key=value in section");
  assert(m.get("s1").get("baz") === "qux", "B03 second key in section");
}

{
  const m = parseIni("global_key=hello\n[sec]\nk=v\n");
  assert(m.get(GLOBAL_SECTION).get("global_key") === "hello", "B04 global key before section");
  assert(m.get("sec").get("k") === "v", "B05 key after section");
}

{
  const m = parseIni("[php]\nmemory_limit: 128M\n");
  assert(m.get("php").get("memory_limit") === "128M", "B06 colon separator");
}

{
  const m = parseIni("[s]\n# comment line\nk=1\n; another comment\nv=2\n");
  assert(m.get("s").get("k") === "1", "B07 # comment skipped");
  assert(m.get("s").get("v") === "2", "B08 ; comment skipped");
}

{
  const m = parseIni("[s]\nk=hello # inline\n");
  assert(m.get("s").get("k") === "hello", "B09 inline hash comment stripped");
}

{
  const m = parseIni("[s]\nk=hello ; inline\n");
  assert(m.get("s").get("k") === "hello", "B10 inline semicolon comment stripped");
}

{
  const m = parseIni('[s]\nk="quoted value"\n');
  assert(m.get("s").get("k") === "quoted value", "B11 double-quoted value");
}

{
  const m = parseIni("[s]\nk='single quoted'\n");
  assert(m.get("s").get("k") === "single quoted", "B12 single-quoted value");
}

{
  const m = parseIni("[s]\nk=line1 \\\n  continuation\n");
  assert(m.get("s").get("k") === "line1 continuation", "B13 line continuation with backslash");
}

{
  const m = parseIni("[s1]\na=1\n[s2]\nb=2\n");
  assert(m.has("s1") && m.has("s2"), "B14 multiple sections");
  assert(m.get("s1").get("a") === "1", "B15 key in s1");
  assert(m.get("s2").get("b") === "2", "B16 key in s2");
}

{
  const m = parseIni("[sec]\nkey=\n");
  assert(m.get("sec").get("key") === "", "B17 empty value");
}

{
  // CRLF line endings
  const m = parseIni("[s]\r\nk=v\r\n");
  assert(m.get("s").get("k") === "v", "B18 CRLF line endings parsed");
}

{
  // Duplicate key — last value wins
  const m = parseIni("[s]\nk=first\nk=second\n");
  assert(m.get("s").get("k") === "second", "B19 duplicate key last wins");
}

{
  // Blank lines between sections
  const m = parseIni("\n\n[s]\n\nk=v\n\n");
  assert(m.get("s").get("k") === "v", "B20 blank lines ignored");
}

// ── Group C — Writer unit tests ───────────────────────────────────────────
process.stderr.write("\n[C] Writer unit tests\n");

{
  const sections = new Map([
    [GLOBAL_SECTION, new Map([["g", "1"]])],
    ["sec", new Map([["k", "v"]])],
  ]);
  const out = stringifySections(sections);
  assert(out.includes("g=1"), "C01 global key written without section header");
  assert(out.includes("[sec]"), "C02 section header written");
  assert(out.includes("k=v"), "C03 section key written");
}

{
  // Empty sections map
  const sections = new Map([[GLOBAL_SECTION, new Map()]]);
  const out = stringifySections(sections);
  assert(out.trim() === "", "C04 empty sections produce empty output");
}

{
  // Round-trip
  const original = "[db]\nhost=localhost\nport=5432\n[cache]\nttl=300\n";
  const sections = parseIni(original);
  const out = stringifySections(sections);
  const reparsed = parseIni(out);
  assert(reparsed.get("db").get("host") === "localhost", "C05 round-trip host");
  assert(reparsed.get("db").get("port") === "5432", "C06 round-trip port");
  assert(reparsed.get("cache").get("ttl") === "300", "C07 round-trip ttl");
}

{
  // objectToSections / sectionsToObject round-trip
  const obj = { [GLOBAL_SECTION]: { g: "0" }, s1: { a: "1", b: "2" } };
  const secs = objectToSections(obj);
  const obj2 = sectionsToObject(secs);
  assert(obj2[GLOBAL_SECTION].g === "0", "C08 objectToSections global key");
  assert(obj2.s1.a === "1", "C09 objectToSections section key");
  assert(obj2.s1.b === "2", "C10 objectToSections second section key");
}

// ── Group D — Happy-path end-to-end ──────────────────────────────────────
process.stderr.write("\n[D] Happy-path end-to-end\n");

{
  const p = writeTemp("d01.ini", "[database]\nhost=db.example.com\nport=3306\n");
  const r = iniClient({ operation: "read", path: p });
  assert(r.sectionCount === 1, "D01 read sectionCount=1");
  assert(r.sections[0] === "database", "D02 read section name");
  assert(r.data.database.host === "db.example.com", "D03 read data.database.host");
}

{
  const p = writeTemp("d04.ini", "[s]\nalpha=A\nbeta=B\n");
  const r = iniClient({ operation: "get", path: p, key_path: "s.alpha" });
  assert(r.found === true, "D04 get found=true");
  assert(r.value === "A", "D05 get correct value");
}

{
  const p = writeTemp("d06.ini", "[s]\nalpha=A\n");
  const r = iniClient({ operation: "get", path: p, key_path: "missing_key" });
  assert(r.found === false, "D06 get missing key found=false");
}

{
  const p = writeTemp("d07.ini", "[s]\nalpha=A\n");
  const r = iniClient({ operation: "get", path: p, key_path: "s" });
  assert(r.found === true && typeof r.value === "object", "D07 get whole section returns object");
  assert(r.value.alpha === "A", "D08 get whole section value correct");
}

{
  const p = writeTemp("d09.ini", "[s]\nk=old\n");
  iniClient({ operation: "set", path: p, key_path: "s.k", value: "new" });
  const content = fs.readFileSync(p, "utf8");
  assert(content.includes("k=new"), "D09 set overwrites key");
}

{
  const p = writeTemp("d10.ini", "[s]\nk=v\n");
  iniClient({ operation: "set", path: p, key_path: "s.newkey", value: "hello" });
  const r = iniClient({ operation: "get", path: p, key_path: "s.newkey" });
  assert(r.value === "hello", "D10 set adds new key");
}

{
  const p = writeTemp("d11.ini", "");
  iniClient({ operation: "set", path: p, key_path: "newsec.k", value: "1" });
  const r = iniClient({ operation: "get", path: p, key_path: "newsec.k" });
  assert(r.value === "1", "D11 set creates new section");
}

{
  const p = writeTemp("d12.ini", "[s]\na=1\nb=2\n");
  iniClient({ operation: "delete", path: p, key_path: "s.a" });
  const r = iniClient({ operation: "get", path: p, key_path: "s.a" });
  assert(r.found === false, "D12 delete removes key");
}

{
  const p = writeTemp("d13.ini", "[sec]\nk=v\n");
  const dr = iniClient({ operation: "delete", path: p, key_path: "sec" });
  assert(dr.deleted === true, "D13 delete section deleted=true");
  const sections2 = parseIni(fs.readFileSync(p, "utf8"));
  assert(!sections2.has("sec"), "D14 deleted section no longer in file");
}

{
  const p = writeTemp("d15.ini", "[s]\na=1\nb=2\nc=3\n");
  const r = iniClient({ operation: "list_keys", path: p, section: "s" });
  assert(r.keyCount === 3, "D15 list_keys count=3");
  assert(r.keys.includes("a") && r.keys.includes("b") && r.keys.includes("c"), "D16 list_keys all keys");
}

{
  const p = writeTemp("d17.ini", "global=yes\n[s1]\n[s2]\n");
  const r = iniClient({ operation: "list_sections", path: p });
  assert(r.sectionCount === 2, "D17 list_sections count=2");
  assert(r.globalKeyCount === 1, "D18 list_sections global key counted");
}

{
  const base = writeTemp("d19-base.ini", "[s]\nk=base\n[b_only]\nx=1\n");
  const src  = writeTemp("d19-src.ini",  "[s]\nk=overridden\n[s_only]\ny=2\n");
  const out  = tmpPath("d19-out.ini");
  iniClient({ operation: "merge", path: base, source_path: src, output_path: out });
  const r = iniClient({ operation: "read", path: out });
  assert(r.data.s.k === "overridden", "D19 merge overrides base key");
  assert(r.data.b_only?.x === "1", "D20 merge preserves base-only section");
}

// ── Group E — Security guards ─────────────────────────────────────────────
process.stderr.write("\n[E] Security guards\n");

{
  // NUL byte in path
  assertThrows(
    () => iniClient({ operation: "read", path: "fi\0le.ini" }),
    "E01 NUL in read path throws",
    "NUL",
  );
}

{
  // NUL byte in source_path
  const base = writeTemp("e02-base.ini", "[s]\nk=v\n");
  assertThrows(
    () => iniClient({ operation: "merge", path: base, source_path: "so\0urce.ini" }),
    "E02 NUL in source_path throws",
    "NUL",
  );
}

{
  // File too large — use a 4 MB + 1 byte buffer (simulated via monkey-patching statSync)
  const bigPath = tmpPath("e03-big.ini");
  fs.writeFileSync(bigPath, "[s]\nk=v\n");
  const origStat = fs.statSync.bind(fs);
  const origStatSync = fs.statSync;
  // Override size in the module's view
  const realStat = fs.statSync;
  fs.statSync = (p, ...rest) => {
    const s = realStat(p, ...rest);
    if (p === bigPath) return Object.assign(Object.create(Object.getPrototypeOf(s)), s, { size: 4 * 1024 * 1024 + 1 });
    return s;
  };
  assertThrows(
    () => iniClient({ operation: "read", path: bigPath }),
    "E03 file too large throws",
    "too large",
  );
  fs.statSync = realStat;
}

{
  // Section name too long
  const longName = "x".repeat(300);
  const p = writeTemp("e04.ini", `[${longName}]\nk=v\n`);
  assertThrows(
    () => iniClient({ operation: "read", path: p }),
    "E04 section name too long throws",
    "section name too long",
  );
}

{
  // Key name too long
  const longKey = "k".repeat(300);
  const p = writeTemp("e05.ini", `[s]\n${longKey}=v\n`);
  assertThrows(
    () => iniClient({ operation: "read", path: p }),
    "E05 key name too long throws",
    "key name too long",
  );
}

{
  // Too many keys
  const lines = ["[s]"];
  for (let i = 0; i < 50001; i++) lines.push(`k${i}=v`);
  const p = writeTemp("e06-big.ini", lines.join("\n"));
  assertThrows(
    () => iniClient({ operation: "read", path: p }),
    "E06 too many keys throws",
    "too many keys",
  );
}

{
  // Reading a path that does not exist (or is inaccessible) should throw
  // Works on both POSIX (/etc/no-such-ini) and Windows (drive letter non-existent)
  assertThrows(
    () => iniClient({ operation: "read", path: "/no/such/ini/file-e07.ini" }),
    "E07 nonexistent absolute path throws",
  );
}

{
  // Empty key_path for get
  const p = writeTemp("e08.ini", "[s]\nk=v\n");
  assertThrows(
    () => iniClient({ operation: "get", path: p, key_path: "" }),
    "E08 empty key_path throws",
    "key_path",
  );
}

{
  // set to a section path (no key)
  const p = writeTemp("e09.ini", "[sec]\nk=v\n");
  assertThrows(
    () => iniClient({ operation: "set", path: p, key_path: "sec", value: "x" }),
    "E09 set to bare section name throws",
    "section",
  );
}

{
  // Non-existent file for get should throw (statSync)
  assertThrows(
    () => iniClient({ operation: "read", path: tmpPath("nonexistent-99.ini") }),
    "E10 read nonexistent file throws",
  );
}

// ── Group F — Concurrency / stress ────────────────────────────────────────
process.stderr.write("\n[F] Concurrency / stress\n");

{
  // Concurrent writes to different files
  const results = [];
  const files = Array.from({ length: 10 }, (_, i) => tmpPath(`f01-${i}.ini`));
  files.forEach((p, i) => {
    iniClient({ operation: "set", path: p, key_path: `s.k`, value: String(i) });
    results.push(iniClient({ operation: "get", path: p, key_path: "s.k" }).value);
  });
  assert(results.every((v, i) => v === String(i)), "F01 concurrent writes to distinct files all correct");
}

{
  // Rapid set+get on same file
  const p = tmpPath("f02.ini");
  fs.writeFileSync(p, "[s]\nk=init\n", "utf8");
  for (let i = 0; i < 20; i++) {
    iniClient({ operation: "set", path: p, key_path: "s.k", value: String(i) });
  }
  const r = iniClient({ operation: "get", path: p, key_path: "s.k" });
  assert(r.value === "19", "F02 rapid set+get final value correct");
}

{
  // Large file with many sections
  const lines = [];
  for (let s = 0; s < 200; s++) {
    lines.push(`[section${s}]`);
    for (let k = 0; k < 5; k++) lines.push(`key${k}=val${s}_${k}`);
  }
  const p = writeTemp("f03-large.ini", lines.join("\n"));
  const r = iniClient({ operation: "read", path: p });
  assert(r.sectionCount === 200, "F03 large file 200 sections read correctly");
}

{
  // Stringify large object
  const data = { [GLOBAL_SECTION]: { version: "1.0" } };
  for (let s = 0; s < 100; s++) {
    data[`section${s}`] = {};
    for (let k = 0; k < 10; k++) data[`section${s}`][`key${k}`] = `v${s}${k}`;
  }
  const r = iniClient({ operation: "stringify", data });
  assert(r.ini.includes("[section99]") && r.ini.includes("key9=v999"), "F04 stringify large object produces correct output");
}

{
  // merge is idempotent when src == base
  const p  = writeTemp("f05-idem.ini", "[s]\nk=v\n");
  const p2 = writeTemp("f05-src.ini",  "[s]\nk=v\n");
  iniClient({ operation: "merge", path: p, source_path: p2 });
  iniClient({ operation: "merge", path: p, source_path: p2 });
  const r = iniClient({ operation: "get", path: p, key_path: "s.k" });
  assert(r.value === "v", "F05 idempotent merge preserves value");
}

// ── Summary ──────────────────────────────────────────────────────────────────
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

const total = passed + failed;
process.stderr.write(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
process.stderr.write(`Section 206 — ini_client: ${passed}/${total} passed\n`);
if (failures.length > 0) {
  process.stderr.write("\nFailed tests:\n");
  failures.forEach(f => process.stderr.write(`  • ${f}\n`));
}
process.stderr.write(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

if (failed > 0) process.exit(1);
