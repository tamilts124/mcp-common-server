"use strict";
/**
 * Section 204 — toml_client tool tests
 * A = input-validation (10)
 * B = parser-unit (20)
 * C = writer/stringify-unit (10)
 * D = happy-path-integration (20)
 * E = security-guards (10)
 * F = concurrency (5)
 * Total: 75 tests
 */

const assert = require("assert");
const fs     = require("fs");
const os     = require("os");
const path   = require("path");

const { tomlClient, TomlParser, tomlStringify, tomlValue } = require("../../lib/tomlClientOps");

// ─── Helpers ────────────────────────────────────────────────────────────────

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-toml-"));
function tmp(name) { return path.join(TMP, name); }
function write(name, content) { fs.writeFileSync(tmp(name), content, "utf8"); }
function read(name) { return fs.readFileSync(tmp(name), "utf8"); }

function throws(fn, pattern) {
  try { fn(); assert.fail("should have thrown"); }
  catch (e) { if (pattern) assert.ok(pattern.test(e.message), `msg='${e.message}' pattern=${pattern}`); }
}

function parse(src) { return new TomlParser(src).parse(); }

let passed = 0, failed = 0, total = 0;
function test(name, fn) {
  total++;
  try {
    fn();
    passed++;
    process.stderr.write(`  \x1b[32m\u2713\x1b[0m ${name}\n`);
  } catch (e) {
    failed++;
    process.stderr.write(`  \x1b[31m\u2717\x1b[0m ${name}\n    ${e.message}\n`);
  }
}

process.stderr.write("\n=== Section 204: toml_client ===\n");

// ─── A: Input Validation (10) ────────────────────────────────────────────────

process.stderr.write("\n[A] Input Validation\n");

test("A01 missing operation throws", () => {
  throws(() => tomlClient({}), /operation.*required/);
});

test("A02 unknown operation throws", () => {
  throws(() => tomlClient({ operation: "frobnicate" }), /unknown operation/);
});

test("A03 read without path throws", () => {
  throws(() => tomlClient({ operation: "read" }), /path.*required/);
});

test("A04 get without path throws", () => {
  throws(() => tomlClient({ operation: "get", key_path: "a" }), /path.*required/);
});

test("A05 get without key_path throws", () => {
  write("a05.toml", "a = 1\n");
  throws(() => tomlClient({ operation: "get", path: tmp("a05.toml") }), /key_path.*required/);
});

test("A06 set without value throws", () => {
  write("a06.toml", "a = 1\n");
  throws(() => tomlClient({ operation: "set", path: tmp("a06.toml"), key_path: "a" }), /value.*required/);
});

test("A07 delete without key_path throws", () => {
  write("a07.toml", "a = 1\n");
  throws(() => tomlClient({ operation: "delete", path: tmp("a07.toml") }), /key_path.*required/);
});

test("A08 merge without source_path throws", () => {
  write("a08.toml", "a = 1\n");
  throws(() => tomlClient({ operation: "merge", path: tmp("a08.toml") }), /source_path.*required/);
});

test("A09 stringify non-object throws", () => {
  throws(() => tomlClient({ operation: "stringify", data: [1, 2] }), /must be a plain object/);
});

test("A10 path with NUL byte throws", () => {
  throws(() => tomlClient({ operation: "read", path: "foo\x00bar" }), /NUL/);
});

// ─── B: Parser Unit (20) ────────────────────────────────────────────────────

process.stderr.write("\n[B] Parser Unit\n");

test("B01 basic string double-quoted", () => {
  const r = parse('greeting = "Hello, World!"\n');
  assert.strictEqual(r.greeting, "Hello, World!");
});

test("B02 basic string escape sequences", () => {
  const r = parse('s = "tab\\there\\nnewline"\n');
  assert.strictEqual(r.s, "tab\there\nnewline");
});

test("B03 literal string single-quoted", () => {
  const r = parse("path = 'C:\\\\Users\\\\foo'\n");
  assert.strictEqual(r.path, "C:\\\\Users\\\\foo");
});

test("B04 multiline basic string", () => {
  const r = parse('ml = """\nline1\nline2\n"""\n');
  assert.strictEqual(r.ml, "line1\nline2\n");
});

test("B05 multiline literal string", () => {
  const r = parse("ml = '''\nno\\escapes\n'''\n");
  assert.strictEqual(r.ml, "no\\escapes\n");
});

test("B06 integers decimal and underscore", () => {
  const r = parse("n = 1_000_000\n");
  assert.strictEqual(r.n, 1000000);
});

test("B07 hex integer", () => {
  const r = parse("n = 0xFF\n");
  assert.strictEqual(r.n, 255);
});

test("B08 octal integer", () => {
  const r = parse("n = 0o17\n");
  assert.strictEqual(r.n, 15);
});

test("B09 binary integer", () => {
  const r = parse("n = 0b1010\n");
  assert.strictEqual(r.n, 10);
});

test("B10 float with exponent", () => {
  const r = parse("f = 6.626e-34\n");
  assert.ok(Math.abs(r.f - 6.626e-34) < 1e-40);
});

test("B11 float inf and nan", () => {
  const r = parse("a = inf\nb = nan\nc = -inf\n");
  assert.strictEqual(r.a,  Infinity);
  assert.ok(isNaN(r.b));
  assert.strictEqual(r.c, -Infinity);
});

test("B12 boolean true and false", () => {
  const r = parse("a = true\nb = false\n");
  assert.strictEqual(r.a, true);
  assert.strictEqual(r.b, false);
});

test("B13 inline array", () => {
  const r = parse("arr = [1, 2, 3]\n");
  assert.deepStrictEqual(r.arr, [1, 2, 3]);
});

test("B14 inline table", () => {
  const r = parse('pt = {x = 1, y = 2}\n');
  assert.strictEqual(r.pt.x, 1);
  assert.strictEqual(r.pt.y, 2);
});

test("B15 standard table section", () => {
  const r = parse('[database]\nhost = "localhost"\nport = 5432\n');
  assert.strictEqual(r.database.host, "localhost");
  assert.strictEqual(r.database.port, 5432);
});

test("B16 array of tables", () => {
  const r = parse('[[products]]\nname = "A"\n\n[[products]]\nname = "B"\n');
  assert.ok(Array.isArray(r.products));
  assert.strictEqual(r.products.length, 2);
  assert.strictEqual(r.products[0].name, "A");
  assert.strictEqual(r.products[1].name, "B");
});

test("B17 dotted keys", () => {
  const r = parse("a.b.c = 42\n");
  assert.strictEqual(r.a.b.c, 42);
});

test("B18 comments ignored", () => {
  const r = parse("# This is a comment\nx = 1 # inline\n");
  assert.strictEqual(r.x, 1);
  assert.strictEqual(Object.keys(r).length, 1);
});

test("B19 unicode escape \\u and \\U", () => {
  const r = parse('s = "\\u0041\\U0001F600"\n');
  assert.strictEqual(r.s, "A\uD83D\uDE00");
});

test("B20 duplicate key throws", () => {
  throws(() => parse("a = 1\na = 2\n"), /duplicate/);
});

// ─── C: Writer/Stringify Unit (10) ───────────────────────────────────────────

process.stderr.write("\n[C] Writer/Stringify Unit\n");

test("C01 stringify string value", () => {
  assert.strictEqual(tomlValue("hello"), '"hello"');
});

test("C02 stringify integer", () => {
  assert.strictEqual(tomlValue(42), "42");
});

test("C03 stringify float", () => {
  const s = tomlValue(3.14);
  assert.ok(s.includes("."));
});

test("C04 stringify boolean", () => {
  assert.strictEqual(tomlValue(true),  "true");
  assert.strictEqual(tomlValue(false), "false");
});

test("C05 stringify array", () => {
  assert.strictEqual(tomlValue([1, 2, 3]), "[1, 2, 3]");
});

test("C06 stringify special float literals", () => {
  assert.strictEqual(tomlValue(Infinity),  "inf");
  assert.strictEqual(tomlValue(-Infinity), "-inf");
  assert.strictEqual(tomlValue(NaN),       "nan");
});

test("C07 stringify Date as ISO string", () => {
  const d = new Date("2024-01-15T12:00:00.000Z");
  const s = tomlValue(d);
  assert.ok(s.includes("2024-01-15"));
});

test("C08 stringify object round-trip", () => {
  const obj = { name: "test", version: "1.0.0", count: 42 };
  const toml = tomlStringify(obj);
  const back = new TomlParser(toml).parse();
  assert.strictEqual(back.name, "test");
  assert.strictEqual(back.version, "1.0.0");
  assert.strictEqual(back.count, 42);
});

test("C09 stringify escapes special chars in strings", () => {
  const s = tomlValue("tab\there");
  assert.ok(s.includes("\\t"));
});

test("C10 stringify null/undefined throws", () => {
  throws(() => tomlValue(null),      /null\/undefined/);
  throws(() => tomlValue(undefined), /null\/undefined/);
});

// ─── D: Happy-Path Integration (20) ─────────────────────────────────────────

process.stderr.write("\n[D] Happy-Path Integration\n");

const CARGO_TOML = `
[package]
name = "my-app"
version = "0.1.0"
edition = "2021"

[dependencies]
serde = { version = "1.0", features = ["derive"] }
tokio = "1.0"

[dev-dependencies]
pretty_assertions = "1.4"

[[bin]]
name = "my-app"
path = "src/main.rs"

[[bin]]
name = "cli"
path = "src/cli.rs"
`.trim() + "\n";

test("D01 read Cargo.toml-style file", () => {
  write("d01.toml", CARGO_TOML);
  const r = tomlClient({ operation: "read", path: tmp("d01.toml") });
  assert.ok(r.ok);
  assert.strictEqual(r.data.package.name, "my-app");
  assert.strictEqual(r.data.package.version, "0.1.0");
});

test("D02 read returns array of tables", () => {
  write("d02.toml", CARGO_TOML);
  const r = tomlClient({ operation: "read", path: tmp("d02.toml") });
  assert.ok(Array.isArray(r.data.bin));
  assert.strictEqual(r.data.bin.length, 2);
  assert.strictEqual(r.data.bin[0].name, "my-app");
});

test("D03 get top-level key", () => {
  write("d03.toml", CARGO_TOML);
  const r = tomlClient({ operation: "get", path: tmp("d03.toml"), key_path: "package.version" });
  assert.ok(r.ok && r.found);
  assert.strictEqual(r.value, "0.1.0");
});

test("D04 get nested inline table key", () => {
  write("d04.toml", CARGO_TOML);
  const r = tomlClient({ operation: "get", path: tmp("d04.toml"), key_path: "dependencies.serde.version" });
  assert.ok(r.ok && r.found);
  assert.strictEqual(r.value, "1.0");
});

test("D05 get non-existent key returns found=false", () => {
  write("d05.toml", "a = 1\n");
  const r = tomlClient({ operation: "get", path: tmp("d05.toml"), key_path: "does.not.exist" });
  assert.ok(r.ok);
  assert.strictEqual(r.found, false);
  assert.strictEqual(r.value, null);
});

test("D06 set creates new key", () => {
  write("d06.toml", "name = \"foo\"\n");
  tomlClient({ operation: "set", path: tmp("d06.toml"), key_path: "version", value: "2.0.0" });
  const r = tomlClient({ operation: "get", path: tmp("d06.toml"), key_path: "version" });
  assert.ok(r.found);
  assert.strictEqual(r.value, "2.0.0");
});

test("D07 set updates existing key", () => {
  write("d07.toml", "[package]\nversion = \"0.1.0\"\n");
  tomlClient({ operation: "set", path: tmp("d07.toml"), key_path: "package.version", value: "1.0.0" });
  const r = tomlClient({ operation: "get", path: tmp("d07.toml"), key_path: "package.version" });
  assert.strictEqual(r.value, "1.0.0");
});

test("D08 delete existing key", () => {
  write("d08.toml", "a = 1\nb = 2\n");
  const r = tomlClient({ operation: "delete", path: tmp("d08.toml"), key_path: "a" });
  assert.ok(r.ok && r.deleted);
  const r2 = tomlClient({ operation: "get", path: tmp("d08.toml"), key_path: "a" });
  assert.strictEqual(r2.found, false);
});

test("D09 delete non-existent key returns deleted=false", () => {
  write("d09.toml", "a = 1\n");
  const r = tomlClient({ operation: "delete", path: tmp("d09.toml"), key_path: "z" });
  assert.ok(r.ok);
  assert.strictEqual(r.deleted, false);
});

test("D10 list_keys root level", () => {
  write("d10.toml", "a = 1\nb = 2\n[c]\nd = 3\n");
  const r = tomlClient({ operation: "list_keys", path: tmp("d10.toml") });
  assert.ok(r.ok);
  assert.ok(r.keys.includes("a"));
  assert.ok(r.keys.includes("b"));
  assert.ok(r.keys.includes("c"));
});

test("D11 list_keys with section filter", () => {
  write("d11.toml", "[pkg]\nname = \"x\"\nver = \"1\"\n");
  const r = tomlClient({ operation: "list_keys", path: tmp("d11.toml"), section: "pkg" });
  assert.ok(r.ok);
  assert.deepStrictEqual(r.keys.sort(), ["name", "ver"]);
});

test("D12 list_sections returns table headers", () => {
  write("d12.toml", CARGO_TOML);
  const r = tomlClient({ operation: "list_sections", path: tmp("d12.toml") });
  assert.ok(r.ok);
  assert.ok(r.sections.some(s => s.includes("package")));
  assert.ok(r.sections.some(s => s.includes("dependencies")));
  assert.ok(r.sections.some(s => s.includes("[[bin]]")));
});

test("D13 merge overlays second over first", () => {
  write("d13base.toml", "[pkg]\nname = \"base\"\nversion = \"1.0\"\n");
  write("d13src.toml",  "[pkg]\nversion = \"2.0\"\nextra = true\n");
  const r = tomlClient({ operation: "merge", path: tmp("d13base.toml"), source_path: tmp("d13src.toml"), output_path: tmp("d13out.toml") });
  assert.ok(r.ok);
  const check = tomlClient({ operation: "read", path: tmp("d13out.toml") });
  assert.strictEqual(check.data.pkg.name,    "base");
  assert.strictEqual(check.data.pkg.version, "2.0");
  assert.strictEqual(check.data.pkg.extra,   true);
});

test("D14 stringify then parse round-trip", () => {
  const obj = { project: { name: "app", version: "3.0", debug: false, ports: [8080, 8443] } };
  const r = tomlClient({ operation: "stringify", data: obj });
  assert.ok(r.ok);
  const back = new TomlParser(r.toml).parse();
  assert.strictEqual(back.project.name, "app");
  assert.strictEqual(back.project.debug, false);
  assert.deepStrictEqual(back.project.ports, [8080, 8443]);
});

test("D15 stringify to output file", () => {
  const r = tomlClient({ operation: "stringify", data: { x: 99 }, output_path: tmp("d15.toml") });
  assert.ok(r.ok);
  assert.ok(r.output_path);
  const content = read("d15.toml");
  assert.ok(content.includes("x = 99"));
});

test("D16 read file not found gives clear error", () => {
  throws(
    () => tomlClient({ operation: "read", path: tmp("no-such-file.toml") }),
    /not found/
  );
});

test("D17 set number value", () => {
  write("d17.toml", "[server]\nport = 8080\n");
  tomlClient({ operation: "set", path: tmp("d17.toml"), key_path: "server.port", value: 9090 });
  const r = tomlClient({ operation: "get", path: tmp("d17.toml"), key_path: "server.port" });
  assert.strictEqual(r.value, 9090);
});

test("D18 set boolean value", () => {
  write("d18.toml", "debug = false\n");
  tomlClient({ operation: "set", path: tmp("d18.toml"), key_path: "debug", value: true });
  const r = tomlClient({ operation: "get", path: tmp("d18.toml"), key_path: "debug" });
  assert.strictEqual(r.value, true);
});

test("D19 list_keys section not found throws", () => {
  write("d19.toml", "a = 1\n");
  throws(
    () => tomlClient({ operation: "list_keys", path: tmp("d19.toml"), section: "nonexistent" }),
    /not found/
  );
});

test("D20 get returns type field", () => {
  write("d20.toml", "[server]\nport = 3000\n");
  const r = tomlClient({ operation: "get", path: tmp("d20.toml"), key_path: "server" });
  assert.ok(r.found);
  assert.strictEqual(r.type, "table");
});

// ─── E: Security Guards (10) ──────────────────────────────���─────────────────

process.stderr.write("\n[E] Security Guards\n");

test("E01 NUL byte in path blocked", () => {
  throws(() => tomlClient({ operation: "read", path: "/tmp/f\x00ile.toml" }), /NUL/);
});

test("E02 duplicate key parse rejection", () => {
  throws(() => parse("a = 1\na = 2\n"), /duplicate/);
});

test("E03 duplicate table definition rejected", () => {
  throws(() => parse("[a]\n[a]\n"), /more than once/);
});

test("E04 table conflicts with array-of-tables", () => {
  throws(() => parse("[a]\n[[a]]\n"), /conflicts/);
});

test("E05 newline in basic string rejected", () => {
  throws(() => parse('s = "line1\nline2"\n'), /newline in basic string/);
});

test("E06 invalid escape sequence rejected", () => {
  throws(() => parse('s = "\\q"\n'), /invalid escape/);
});

test("E07 deeply nested dotted key depth limit", () => {
  // Build a 21-level deep key which exceeds MAX_KEY_DEPTH=20
  const deepKey = Array(22).fill("a").join(".");
  throws(() => parse(`${deepKey} = 1\n`), /too deep/);
});

test("E08 file too large blocked", () => {
  // Create a file-size check bypass by patching: instead test via actual write
  const bigPath = tmp("e08big.toml");
  // Write a 4MB+1 file
  const chunk = Buffer.alloc(4 * 1024 * 1024 + 1, 0x23); // '#' characters = comment
  fs.writeFileSync(bigPath, chunk);
  throws(() => tomlClient({ operation: "read", path: bigPath }), /too large/);
});

test("E09 empty key_path throws", () => {
  write("e09.toml", "a = 1\n");
  throws(
    () => tomlClient({ operation: "get", path: tmp("e09.toml"), key_path: "" }),
    /key_path.*required|non-empty/
  );
});

test("E10 unterminated string throws parse error", () => {
  throws(() => parse('s = "unterminated\n'), /newline in basic string|parse error/);
});

// ─── F: Concurrency (5) ─────────────────────────────────────────────────────

process.stderr.write("\n[F] Concurrency\n");

test("F01 concurrent reads return correct data", async () => {
  write("f01.toml", "[pkg]\nname = \"concurrent\"\n");
  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      Promise.resolve(tomlClient({ operation: "read", path: tmp("f01.toml") }))
    )
  );
  for (const r of results) {
    assert.strictEqual(r.data.pkg.name, "concurrent");
  }
});

test("F02 independent parsers don't share state", () => {
  const src1 = "a = 1\n";
  const src2 = "b = 2\n";
  const p1 = new TomlParser(src1);
  const p2 = new TomlParser(src2);
  const r1 = p1.parse();
  const r2 = p2.parse();
  assert.strictEqual(r1.a, 1);
  assert.strictEqual(r2.b, 2);
  assert.ok(!("b" in r1));
  assert.ok(!("a" in r2));
});

test("F03 parallel stringify calls are pure", async () => {
  const objs = Array.from({ length: 10 }, (_, i) => ({ idx: i, name: `item-${i}` }));
  const results = await Promise.all(objs.map(obj =>
    Promise.resolve(tomlClient({ operation: "stringify", data: obj }))
  ));
  results.forEach((r, i) => {
    assert.ok(r.toml.includes(`${i}`));
    assert.ok(r.toml.includes(`item-${i}`));
  });
});

test("F04 concurrent gets from same file", async () => {
  write("f04.toml", "x = 42\n");
  const results = await Promise.all(
    Array.from({ length: 15 }, () =>
      Promise.resolve(tomlClient({ operation: "get", path: tmp("f04.toml"), key_path: "x" }))
    )
  );
  for (const r of results) assert.strictEqual(r.value, 42);
});

test("F05 large TOML with many keys parses correctly", () => {
  // Build a TOML with 1000 keys
  const lines = Array.from({ length: 1000 }, (_, i) => `key${i} = ${i}`).join("\n");
  const r = new TomlParser(lines + "\n").parse();
  assert.strictEqual(r.key0,   0);
  assert.strictEqual(r.key999, 999);
});

// ─── Cleanup & Summary ───────────────────────────────────────────────────────────

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}

process.stderr.write(`\n=== Section 204 Results: ${passed}/${total} passed`);
if (failed > 0) process.stderr.write(` (${failed} FAILED)`);
process.stderr.write(" ===\n\n");

if (failed > 0) process.exit(1);
