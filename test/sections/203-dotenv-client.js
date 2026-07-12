"use strict";
// test/sections/203-dotenv-client.js
// Five-rigor test suite for dotenv_client (section 203)
// 70 tests: A=input-validation x10, B=parser-unit x10, C=writer-unit x10,
//           D=happy-path x30, E=security x5, F=concurrency x5

const fs   = require("fs");
const path = require("path");
const os   = require("os");

const { dotenvClient, _parse } = require("../../lib/dotenvClientOps");
const { parseEnvContent, parseValue, serializeValue, serializeEntries } = _parse;

// ─── Test harness ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const errs  = [];

async function test(label, fn) {
  try {
    await fn();
    passed++;
    process.stderr.write(`  ✓ ${label}\n`);
  } catch (e) {
    failed++;
    errs.push({ label, err: e });
    process.stderr.write(`  ✗ ${label}: ${e.message}\n`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

function assertRejects(fn, fragment) {
  return fn().then(
    () => { throw new Error(`Expected rejection containing: ${fragment}`); },
    e  => {
      if (!e.message.includes(fragment))
        throw new Error(`Expected '${fragment}' in '${e.message}'`);
    }
  );
}

// ─── Temp dir helper ──────────────────────────────────────────────────────────

let TMP;
function setup() {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "dotenv-test-"));
}
function cleanup() {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
}
function tmpFile(name, content) {
  const p = path.join(TMP, name);
  if (content !== undefined) fs.writeFileSync(p, content, "utf8");
  return p;
}

// ─── ===== SECTION A: Input Validation (10 tests) ===========================

async function runA() {
  process.stderr.write("\nA ─ Input Validation\n");

  await test("A01 missing operation rejects", () =>
    assertRejects(() => dotenvClient({}), "operation"));

  await test("A02 unknown operation rejects", () =>
    assertRejects(() => dotenvClient({ operation: "explode" }), "unknown operation"));

  await test("A03 read: missing path rejects", () =>
    assertRejects(() => dotenvClient({ operation: "read" }), "'path' is required"));

  await test("A04 write: missing vars rejects", () => {
    const p = tmpFile("a04.env", "FOO=bar\n");
    return assertRejects(
      () => dotenvClient({ operation: "write", path: p }),
      "'vars' must be an object"
    );
  });

  await test("A05 write: invalid key (space) rejects", () => {
    const p = tmpFile("a05.env", "");
    return assertRejects(
      () => dotenvClient({ operation: "write", path: p, vars: { "BAD KEY": "v" } }),
      "invalid characters"
    );
  });

  await test("A06 write: key starting with digit rejects", () => {
    const p = tmpFile("a06.env", "");
    return assertRejects(
      () => dotenvClient({ operation: "write", path: p, vars: { "1BAD": "v" } }),
      "must match"
    );
  });

  await test("A07 delete: missing keys array rejects", () => {
    const p = tmpFile("a07.env", "A=1\n");
    return assertRejects(
      () => dotenvClient({ operation: "delete", path: p }),
      "'keys' must be a non-empty array"
    );
  });

  await test("A08 merge: missing source rejects", () => {
    const p = tmpFile("a08.env", "A=1\n");
    return assertRejects(
      () => dotenvClient({ operation: "merge", path: p }),
      "'source' is required"
    );
  });

  await test("A09 validate: missing required array rejects", () => {
    const p = tmpFile("a09.env", "A=1\n");
    return assertRejects(
      () => dotenvClient({ operation: "validate", path: p }),
      "'required' must be a non-empty array"
    );
  });

  await test("A10 list: missing path rejects", () =>
    assertRejects(() => dotenvClient({ operation: "list" }), "'path' is required"));
}

// ─── ===== SECTION B: Parser Unit (10 tests) ================================

async function runB() {
  process.stderr.write("\nB ─ Parser Unit\n");

  await test("B01 blank lines and comments preserved", () => {
    const { entries, vars } = parseEnvContent("# comment\nFOO=bar\n\nBAZ=qux\n");
    assert(entries.some(e => e.type === "comment"), "comment");
    assert(entries.some(e => e.type === "blank"), "blank");
    assert(vars.FOO === "bar");
    assert(vars.BAZ === "qux");
  });

  await test("B02 double-quoted escape sequences", () => {
    const v = parseValue('"hello\\nworld"');
    assert(v === "hello\nworld", `got: ${JSON.stringify(v)}`);
  });

  await test("B03 single-quoted literal (no escaping)", () => {
    const v = parseValue("'hello\\nworld'");
    assert(v === "hello\\nworld", `got: ${JSON.stringify(v)}`);
  });

  await test("B04 unquoted inline comment stripped", () => {
    const v = parseValue("somevalue # inline comment");
    assert(v === "somevalue", `got: ${JSON.stringify(v)}`);
  });

  await test("B05 export prefix ignored", () => {
    const { vars } = parseEnvContent("export MY_KEY=hello\n");
    assert(vars.MY_KEY === "hello");
  });

  await test("B06 empty value", () => {
    const { vars } = parseEnvContent("EMPTY=\n");
    assert(vars.EMPTY === "");
  });

  await test("B07 backtick-quoted treated as double-quote", () => {
    const v = parseValue("`tab\\there`");
    assert(v === "tab\there", `got: ${JSON.stringify(v)}`);
  });

  await test("B08 CRLF line endings normalised", () => {
    const { vars } = parseEnvContent("A=1\r\nB=2\r\n");
    assert(vars.A === "1");
    assert(vars.B === "2");
  });

  await test("B09 multi-key parse produces correct count", () => {
    const content = Array.from({ length: 10 }, (_, i) => `K${i}=v${i}`).join("\n") + "\n";
    const { vars } = parseEnvContent(content);
    assert(Object.keys(vars).length === 10);
  });

  await test("B10 invalid line (no =) captured as invalid entry", () => {
    const { entries } = parseEnvContent("JUSTKEY\n");
    assert(entries.some(e => e.type === "invalid"), "should have invalid entry");
  });
}

// ─── ===== SECTION C: Writer Unit (10 tests) ================================

async function runC() {
  process.stderr.write("\nC ─ Writer Unit\n");

  await test("C01 plain value written unquoted", () => {
    const v = serializeValue("hello");
    assert(v === "hello", `got: ${JSON.stringify(v)}`);
  });

  await test("C02 value with newline double-quoted", () => {
    const v = serializeValue("line1\nline2");
    assert(v.startsWith('"'), "should be double-quoted");
    assert(v.includes("\\n"), "should escape newline");
  });

  await test("C03 empty value serialised as empty string", () => {
    const v = serializeValue("");
    assert(v === "");
  });

  await test("C04 serializeEntries preserves comments", () => {
    const { entries } = parseEnvContent("# My comment\nFOO=old\n");
    const result = serializeEntries(entries, { FOO: "new" }, new Set());
    assert(result.includes("# My comment"), "comment preserved");
    assert(result.includes("FOO=new"), "value updated");
  });

  await test("C05 serializeEntries deletes key", () => {
    const { entries } = parseEnvContent("A=1\nB=2\n");
    const result = serializeEntries(entries, {}, new Set(["A"]));
    assert(!result.includes("A="), "A deleted");
    assert(result.includes("B=2"), "B kept");
  });

  await test("C06 serializeEntries appends new key", () => {
    const { entries } = parseEnvContent("A=1\n");
    const result = serializeEntries(entries, { NEW: "val" }, new Set());
    assert(result.includes("NEW=val"), "new key appended");
  });

  await test("C07 output always ends with newline", () => {
    const { entries } = parseEnvContent("X=1");
    const result = serializeEntries(entries, {}, new Set());
    assert(result.endsWith("\n"), "ends with newline");
  });

  await test("C08 value with spaces double-quoted", () => {
    const v = serializeValue("hello world");
    assert(v.startsWith('"') || v.includes(" "), "should be quoted or contain space");
    // Must round-trip: after parsing the serialized value gives back original
    const parsed = parseValue(v);
    assert(parsed === "hello world", `round-trip failed: ${JSON.stringify(parsed)}`);
  });

  await test("C09 value with # double-quoted", () => {
    const v = serializeValue("val#tag");
    const parsed = parseValue(v);
    assert(parsed === "val#tag", `round-trip failed: ${JSON.stringify(parsed)}`);
  });

  await test("C10 blank line inserted before new keys block", () => {
    const { entries } = parseEnvContent("A=1\n");
    const result = serializeEntries(entries, { NEW: "val" }, new Set());
    // There should be a blank line before NEW=val
    const lines = result.split("\n");
    const newIdx = lines.findIndex(l => l.startsWith("NEW="));
    assert(newIdx > 0 && lines[newIdx - 1].trim() === "", "blank line before new keys");
  });
}

// ─── ===== SECTION D: Happy Path (30 tests) ==================================

async function runD() {
  process.stderr.write("\nD ─ Happy Path\n");

  // D01-D05: read
  await test("D01 read: parses vars correctly", async () => {
    const p = tmpFile("d01.env", "DB_HOST=localhost\nDB_PORT=5432\n");
    const r = await dotenvClient({ operation: "read", path: p });
    assert(r.vars.DB_HOST === "localhost");
    assert(r.vars.DB_PORT === "5432");
    assert(r.keyCount === 2);
  });

  await test("D02 read: counts comments and blanks", async () => {
    const p = tmpFile("d02.env", "# Comment\n\nFOO=bar\n");
    const r = await dotenvClient({ operation: "read", path: p });
    assert(r.commentCount === 1, `commentCount=${r.commentCount}`);
    assert(r.blankCount >= 1, `blankCount=${r.blankCount}`);
  });

  await test("D03 read: double-quoted multiline value", async () => {
    const p = tmpFile("d03.env", 'MULTI="line1\\nline2"\n');
    const r = await dotenvClient({ operation: "read", path: p });
    assert(r.vars.MULTI === "line1\nline2");
  });

  await test("D04 read: export prefix supported", async () => {
    const p = tmpFile("d04.env", "export MY_VAR=hello\n");
    const r = await dotenvClient({ operation: "read", path: p });
    assert(r.vars.MY_VAR === "hello");
  });

  await test("D05 read: single-quoted value", async () => {
    const p = tmpFile("d05.env", "NOESCAPE='raw\\nval'\n");
    const r = await dotenvClient({ operation: "read", path: p });
    assert(r.vars.NOESCAPE === "raw\\nval");
  });

  // D06-D10: list
  await test("D06 list: returns key names", async () => {
    const p = tmpFile("d06.env", "A=1\nB=2\nC=3\n");
    const r = await dotenvClient({ operation: "list", path: p });
    assert(r.keys.length === 3);
    assert(r.keys.includes("A") && r.keys.includes("B") && r.keys.includes("C"));
  });

  await test("D07 list: empty file returns empty array", async () => {
    const p = tmpFile("d07.env", "\n");
    const r = await dotenvClient({ operation: "list", path: p });
    assert(r.keyCount === 0);
  });

  await test("D08 list: skips comments", async () => {
    const p = tmpFile("d08.env", "# skip me\nREAL=val\n");
    const r = await dotenvClient({ operation: "list", path: p });
    assert(r.keys.length === 1 && r.keys[0] === "REAL");
  });

  await test("D09 list: only key names, no values", async () => {
    const p = tmpFile("d09.env", "SECRET=abc123\n");
    const r = await dotenvClient({ operation: "list", path: p });
    assert(!JSON.stringify(r).includes("abc123"), "values should not appear");
  });

  await test("D10 list: 5 keys from mixed file", async () => {
    const content = "# header\nA=1\n\nB=2\nC=3\n# mid\nD=4\nE=5\n";
    const p = tmpFile("d10.env", content);
    const r = await dotenvClient({ operation: "list", path: p });
    assert(r.keyCount === 5);
  });

  // D11-D15: write
  await test("D11 write: creates new file", async () => {
    const p = path.join(TMP, "d11.env");
    const r = await dotenvClient({ operation: "write", path: p, vars: { APP_ENV: "test" } });
    assert(r.written === 1);
    assert(fs.readFileSync(p, "utf8").includes("APP_ENV=test"));
  });

  await test("D12 write: updates existing key preserving others", async () => {
    const p = tmpFile("d12.env", "FOO=old\nBAR=keep\n");
    await dotenvClient({ operation: "write", path: p, vars: { FOO: "new" } });
    const content = fs.readFileSync(p, "utf8");
    assert(content.includes("FOO=new"));
    assert(content.includes("BAR=keep"));
  });

  await test("D13 write: appends new key", async () => {
    const p = tmpFile("d13.env", "A=1\n");
    await dotenvClient({ operation: "write", path: p, vars: { B: "2" } });
    const content = fs.readFileSync(p, "utf8");
    assert(content.includes("A=1"));
    assert(content.includes("B=2"));
  });

  await test("D14 write: special-char value quoted", async () => {
    const p = tmpFile("d14.env", "");
    await dotenvClient({ operation: "write", path: p, vars: { MSG: "hello world" } });
    const content = fs.readFileSync(p, "utf8");
    // After read, value should round-trip
    const r = await dotenvClient({ operation: "read", path: p });
    assert(r.vars.MSG === "hello world");
  });

  await test("D15 write: multiple vars at once", async () => {
    const p = tmpFile("d15.env", "");
    await dotenvClient({ operation: "write", path: p, vars: { X: "1", Y: "2", Z: "3" } });
    const r = await dotenvClient({ operation: "read", path: p });
    assert(r.keyCount === 3);
  });

  // D16-D18: delete
  await test("D16 delete: removes specified key", async () => {
    const p = tmpFile("d16.env", "A=1\nB=2\nC=3\n");
    const r = await dotenvClient({ operation: "delete", path: p, keys: ["B"] });
    assert(r.deleted.includes("B"));
    const content = fs.readFileSync(p, "utf8");
    assert(!content.includes("B="));
    assert(content.includes("A=1"));
    assert(content.includes("C=3"));
  });

  await test("D17 delete: notFound populated for missing key", async () => {
    const p = tmpFile("d17.env", "A=1\n");
    const r = await dotenvClient({ operation: "delete", path: p, keys: ["GHOST"] });
    assert(r.notFound.includes("GHOST"));
    assert(r.deleted.length === 0);
  });

  await test("D18 delete: multiple keys at once", async () => {
    const p = tmpFile("d18.env", "A=1\nB=2\nC=3\n");
    const r = await dotenvClient({ operation: "delete", path: p, keys: ["A", "C"] });
    assert(r.deleted.length === 2);
    const content = fs.readFileSync(p, "utf8");
    assert(!content.includes("A="));
    assert(!content.includes("C="));
    assert(content.includes("B=2"));
  });

  // D19-D21: merge
  await test("D19 merge: source overrides base", async () => {
    const base = tmpFile("d19base.env", "A=old\nB=keep\n");
    const src  = tmpFile("d19src.env", "A=new\n");
    const r = await dotenvClient({ operation: "merge", path: base, source: src });
    assert(r.overridden.includes("A"));
    const content = fs.readFileSync(base, "utf8");
    assert(content.includes("A=new"));
    assert(content.includes("B=keep"));
  });

  await test("D20 merge: new keys from source appended", async () => {
    const base = tmpFile("d20base.env", "A=1\n");
    const src  = tmpFile("d20src.env", "NEW=added\n");
    const r = await dotenvClient({ operation: "merge", path: base, source: src });
    assert(r.added.includes("NEW"));
    const content = fs.readFileSync(base, "utf8");
    assert(content.includes("NEW=added"));
  });

  await test("D21 merge: output path writes to separate file", async () => {
    const base = tmpFile("d21base.env", "A=1\n");
    const src  = tmpFile("d21src.env", "B=2\n");
    const out  = path.join(TMP, "d21out.env");
    await dotenvClient({ operation: "merge", path: base, source: src, output: out });
    assert(fs.existsSync(out));
    const outContent = fs.readFileSync(out, "utf8");
    assert(outContent.includes("A=1") && outContent.includes("B=2"));
  });

  // D22-D24: validate
  await test("D22 validate: all required present returns valid=true", async () => {
    const p = tmpFile("d22.env", "A=1\nB=hello\n");
    const r = await dotenvClient({ operation: "validate", path: p, required: ["A", "B"] });
    assert(r.valid === true);
    assert(r.missing.length === 0);
  });

  await test("D23 validate: missing key returns valid=false", async () => {
    const p = tmpFile("d23.env", "A=1\n");
    const r = await dotenvClient({ operation: "validate", path: p, required: ["A", "B"] });
    assert(r.valid === false);
    assert(r.missing.includes("B"));
  });

  await test("D24 validate: empty value treated as missing", async () => {
    const p = tmpFile("d24.env", "A=\n");
    const r = await dotenvClient({ operation: "validate", path: p, required: ["A"] });
    assert(r.valid === false);
    assert(r.missing.includes("A"));
  });

  // D25-D27: to_shell
  await test("D25 to_shell: default export prefix", async () => {
    const p = tmpFile("d25.env", "FOO=bar\n");
    const r = await dotenvClient({ operation: "to_shell", path: p });
    assert(r.shell.includes("export FOO="));
  });

  await test("D26 to_shell: custom prefix", async () => {
    const p = tmpFile("d26.env", "X=1\n");
    const r = await dotenvClient({ operation: "to_shell", path: p, prefix: "" });
    assert(r.shell.includes("X="));
    assert(!r.shell.includes("export"));
  });

  await test("D27 to_shell: keys filter", async () => {
    const p = tmpFile("d27.env", "A=1\nB=2\nC=3\n");
    const r = await dotenvClient({ operation: "to_shell", path: p, keys: ["A", "C"] });
    assert(r.keyCount === 2);
    assert(r.shell.includes("A="));
    assert(r.shell.includes("C="));
    assert(!r.shell.includes("B="));
  });

  // D28-D30: cross-op round-trips
  await test("D28 write then read round-trip", async () => {
    const p = path.join(TMP, "d28.env");
    await dotenvClient({ operation: "write", path: p, vars: { ALPHA: "first", BETA: "second" } });
    const r = await dotenvClient({ operation: "read", path: p });
    assert(r.vars.ALPHA === "first");
    assert(r.vars.BETA === "second");
  });

  await test("D29 write + delete + read round-trip", async () => {
    const p = path.join(TMP, "d29.env");
    await dotenvClient({ operation: "write", path: p, vars: { K1: "v1", K2: "v2" } });
    await dotenvClient({ operation: "delete", path: p, keys: ["K1"] });
    const r = await dotenvClient({ operation: "read", path: p });
    assert(!r.vars.K1, "K1 deleted");
    assert(r.vars.K2 === "v2");
  });

  await test("D30 merge then validate", async () => {
    const base = tmpFile("d30base.env", "DB_HOST=localhost\n");
    const src  = tmpFile("d30src.env", "DB_PASS=secret\n");
    await dotenvClient({ operation: "merge", path: base, source: src });
    const r = await dotenvClient({ operation: "validate", path: base, required: ["DB_HOST", "DB_PASS"] });
    assert(r.valid === true);
  });
}

// ─── ===== SECTION E: Security (5 tests) =====================================

async function runE() {
  process.stderr.write("\nE ─ Security\n");

  await test("E01 NUL byte in key rejected", () => {
    const p = tmpFile("e01.env", "");
    return assertRejects(
      () => dotenvClient({ operation: "write", path: p, vars: { "KEY\x00NAME": "v" } }),
      "invalid characters"
    );
  });

  await test("E02 NUL byte in value rejected", () => {
    const p = tmpFile("e02.env", "");
    return assertRejects(
      () => dotenvClient({ operation: "write", path: p, vars: { GOOD_KEY: "val\x00ue" } }),
      "NUL byte"
    );
  });

  await test("E03 CRLF in key rejected", () => {
    const p = tmpFile("e03.env", "");
    return assertRejects(
      () => dotenvClient({ operation: "write", path: p, vars: { "KEY\rNAME": "v" } }),
      "invalid characters"
    );
  });

  await test("E04 key too long rejected", () => {
    const p = tmpFile("e04.env", "");
    const longKey = "A" + "B".repeat(256); // 257 chars
    return assertRejects(
      () => dotenvClient({ operation: "write", path: p, vars: { [longKey]: "v" } }),
      "key too long"
    );
  });

  await test("E05 value too large rejected", () => {
    const p = tmpFile("e05.env", "");
    const bigVal = "X".repeat(1 * 1024 * 1024 + 1); // > 1 MB
    return assertRejects(
      () => dotenvClient({ operation: "write", path: p, vars: { BIGVAL: bigVal } }),
      "too large"
    );
  });
}

// ─── ===== SECTION F: Concurrency (5 tests) ==================================

async function runF() {
  process.stderr.write("\nF ─ Concurrency\n");

  await test("F01 10 parallel reads from same file", async () => {
    const p = tmpFile("f01.env", "A=1\nB=2\nC=3\n");
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        dotenvClient({ operation: "read", path: p })
      )
    );
    for (const r of results) {
      assert(r.keyCount === 3);
      assert(r.vars.A === "1");
    }
  });

  await test("F02 parallel reads from different files", async () => {
    const files = Array.from({ length: 5 }, (_, i) => {
      const p = tmpFile(`f02_${i}.env`, `VAL=file${i}\n`);
      return { p, i };
    });
    const results = await Promise.all(
      files.map(({ p, i }) => dotenvClient({ operation: "read", path: p }))
    );
    for (let i = 0; i < files.length; i++) {
      assert(results[i].vars.VAL === `file${i}`, `file ${i} mismatch`);
    }
  });

  await test("F03 parallel writes to different files don't interfere", async () => {
    const files = Array.from({ length: 5 }, (_, i) => path.join(TMP, `f03_${i}.env`));
    await Promise.all(
      files.map((p, i) => dotenvClient({ operation: "write", path: p, vars: { IDX: String(i) } }))
    );
    for (let i = 0; i < files.length; i++) {
      const r = await dotenvClient({ operation: "read", path: files[i] });
      assert(r.vars.IDX === String(i), `IDX mismatch at ${i}`);
    }
  });

  await test("F04 parallel to_shell calls", async () => {
    const p = tmpFile("f04.env", "X=1\nY=2\nZ=3\n");
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        dotenvClient({ operation: "to_shell", path: p })
      )
    );
    for (const r of results) {
      assert(r.keyCount === 3);
      assert(r.shell.includes("export X="));
    }
  });

  await test("F05 parallel validate calls", async () => {
    const p = tmpFile("f05.env", "A=ok\nB=ok\nC=ok\n");
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        dotenvClient({ operation: "validate", path: p, required: ["A", "B", "C"] })
      )
    );
    for (const r of results) {
      assert(r.valid === true, "should be valid");
    }
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  setup();
  try {
    await runA();
    await runB();
    await runC();
    await runD();
    await runE();
    await runF();
  } finally {
    cleanup();
  }

  process.stderr.write(`\n────────────────────────────────────────────────────────────────────\n`);
  process.stderr.write(`section 203 dotenv-client: ${passed}/${passed + failed} passed\n`);

  if (errs.length) {
    process.stderr.write("\nFailed tests:\n");
    for (const { label, err } of errs)
      process.stderr.write(`  ✗ ${label}\n    ${err.stack || err.message}\n`);
  }

  // Print summary to stdout for run-tests.js runner
  process.stdout.write(
    JSON.stringify({ section: 203, name: "dotenv-client", passed, failed }) + "\n"
  );

  if (failed > 0) process.exit(1);
}

main().catch(e => {
  process.stderr.write(`FATAL: ${e.stack || e.message}\n`);
  process.exit(1);
});
