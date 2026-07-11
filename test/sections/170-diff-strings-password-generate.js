"use strict";
/**
 * test/sections/170-diff-strings-password-generate.js
 * Isolated functional tests for diff_strings and password_generate.
 * Section [170] — 5 rigor levels.
 */

const { test } = require("../test-harness");
const { diffStrings } = require("../../lib/diffStringsOps");
const { generatePasswords, WORD_LIST, randomUniform } = require("../../lib/passwordGenerateOps");
const { ToolError } = require("../../lib/errors");

function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

// ─────────────────────────────────────────────────────────────────────────────
// [170-A] NORMAL — diff_strings happy paths
// ─────────────────────────────────────────────────────────────────────────────
test("[170-A-1] diff_strings: identical strings → identical:true, 0 hunks", () => {
  const r = diffStrings("hello\nworld", "hello\nworld");
  assert(r.identical === true);
  assert(r.hunks === 0);
  assert(r.additions === 0);
  assert(r.deletions === 0);
  assert(r.unified === "");
});

test("[170-A-2] diff_strings: one added line → 1 addition, 0 deletions", () => {
  const r = diffStrings("alpha\nbeta", "alpha\nbeta\ngamma");
  assert(r.identical === false);
  assert(r.additions === 1 && r.deletions === 0);
  assert(r.hunks === 1);
  assert(r.unified.includes("+gamma"));
});

test("[170-A-3] diff_strings: one removed line → 0 additions, 1 deletion", () => {
  const r = diffStrings("alpha\nbeta\ngamma", "alpha\ngamma");
  assert(r.additions === 0 && r.deletions === 1);
  assert(r.unified.includes("-beta"));
});

test("[170-A-4] diff_strings: modified line → 1 addition + 1 deletion", () => {
  const r = diffStrings("line1\nold line\nline3", "line1\nnew line\nline3");
  assert(r.additions === 1 && r.deletions === 1);
  assert(r.unified.includes("-old line"));
  assert(r.unified.includes("+new line"));
});

test("[170-A-5] diff_strings: unified header contains custom labels", () => {
  const r = diffStrings("a", "b", { label_a: "expected", label_b: "actual" });
  assert(r.labelA === "expected" && r.labelB === "actual");
  assert(r.unified.includes("--- expected"));
  assert(r.unified.includes("+++ actual"));
});

test("[170-A-6] diff_strings: json format returns structured changes array", () => {
  const r = diffStrings("x\ny", "x\nz", { format: "json" });
  assert(Array.isArray(r.changes), "changes should be array");
  assert(r.changes.length >= 1);
  const all = r.changes.flat();
  assert(all.some(e => e.op === "-" && e.text === "y"), "missing delete entry");
  assert(all.some(e => e.op === "+" && e.text === "z"), "missing insert entry");
});

test("[170-A-7] diff_strings: context=0 shows only changed lines (no context)", () => {
  const a = Array.from({length: 20}, (_, i) => `line${i}`).join("\n");
  const b = a.replace("line10", "CHANGED");
  const r = diffStrings(a, b, { context: 0 });
  const lines = r.unified.split("\n");
  const bodyLines = lines.filter(l => l.startsWith(" "));
  assert(bodyLines.length === 0, `got ${bodyLines.length} context lines with context=0`);
});

test("[170-A-8] diff_strings: aLines + bLines counts are correct", () => {
  const a = "a\nb\nc";
  const b = "a\nb\nc\nd\ne";
  const r = diffStrings(a, b);
  assert(r.aLines === 3, `aLines=${r.aLines}`);
  assert(r.bLines === 5, `bLines=${r.bLines}`);
});

test("[170-A-9] diff_strings: empty a + non-empty b → all additions", () => {
  const r = diffStrings("", "alpha\nbeta\ngamma");
  assert(r.additions === 3, `additions=${r.additions}`);
  assert(r.deletions === 0);
});

test("[170-A-10] diff_strings: non-empty a + empty b → all deletions", () => {
  const r = diffStrings("alpha\nbeta", "");
  assert(r.deletions === 2, `deletions=${r.deletions}`);
  assert(r.additions === 0);
});

test("[170-A-11] diff_strings: both empty strings → identical:true", () => {
  const r = diffStrings("", "");
  assert(r.identical === true && r.hunks === 0);
});

test("[170-A-12] diff_strings: json format per-entry aLine/bLine are 1-based", () => {
  const r = diffStrings("line1\nremoved", "line1\nadded", { format: "json" });
  const all = r.changes.flat();
  for (const e of all) {
    if (e.op === "-") assert(typeof e.aLine === "number" && e.aLine >= 1);
    if (e.op === "+") assert(typeof e.bLine === "number" && e.bLine >= 1);
    if (e.op === " ") {
      assert(typeof e.aLine === "number" && e.aLine >= 1);
      assert(typeof e.bLine === "number" && e.bLine >= 1);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// [170-B] MEDIUM — diff_strings validation / edge inputs
// ─────────────────────────────────────────────────────────────────────────────
test("[170-B-1] diff_strings: non-string 'a' throws TypeError", () => {
  let threw = false;
  try { diffStrings(123, "b"); } catch (e) { threw = true; assert(e instanceof TypeError); }
  assert(threw, "should have thrown TypeError");
});

test("[170-B-2] diff_strings: non-string 'b' throws TypeError", () => {
  let threw = false;
  try { diffStrings("a", null); } catch (e) { threw = true; assert(e instanceof TypeError); }
  assert(threw, "should have thrown TypeError");
});

test("[170-B-3] diff_strings: negative context is clamped to 0 (no crash)", () => {
  const r = diffStrings("old", "new", { context: -5 });
  assert(typeof r.hunks === "number");
});

test("[170-B-4] diff_strings: unknown format defaults to 'unified'", () => {
  const r = diffStrings("a", "b", { format: "xml" });
  assert(typeof r.unified === "string", "should default to unified");
  assert(r.changes === undefined);
});

test("[170-B-5] diff_strings: single-char difference isolated to one hunk", () => {
  const a = "AAAA\nBBBB\nCCCC\nDDDD\nEEEE\nFFFF\nGGGG\nHHHH";
  const b = "AAAA\nBBBB\nCCCC\nDDDX\nEEEE\nFFFF\nGGGG\nHHHH";
  const r = diffStrings(a, b, { context: 2 });
  assert(r.hunks === 1, `expected 1 hunk, got ${r.hunks}`);
  assert(r.additions === 1 && r.deletions === 1);
});

test("[170-B-6] diff_strings: Windows CRLF lines treated as single lines", () => {
  const a = "hello\r\nworld";
  const b = "hello\r\nearth";
  const r = diffStrings(a, b);
  assert(r.additions === 1 && r.deletions === 1);
});

test("[170-B-7] diff_strings: multi-hunk output with far-apart changes", () => {
  const lines = Array.from({length: 40}, (_, i) => `line${i}`);
  const a = lines.join("\n");
  const bLines = [...lines];
  bLines[1] = "CHANGED1";
  bLines[39] = "CHANGED39";
  const r = diffStrings(a, bLines.join("\n"), { context: 3 });
  assert(r.hunks === 2, `expected 2 hunks, got ${r.hunks}`);
  assert(r.additions === 2 && r.deletions === 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// [170-C] HIGH — large diffs
// ─────────────────────────────────────────────────────────────────────────────
test("[170-C-1] diff_strings: 1000-line diff — additions count correct", () => {
  const a = Array.from({length: 1000}, (_, i) => `line${i}`).join("\n");
  const b = a + "\nextra1\nextra2\nextra3";
  const r = diffStrings(a, b);
  assert(r.additions === 3 && r.deletions === 0);
  assert(r.hunks === 1);
});

test("[170-C-2] diff_strings: 500-line a, 500-line b with 50 scattered changes", () => {
  const a = Array.from({length: 500}, (_, i) => `original-line-${i}`);
  const b = [...a];
  for (let i = 0; i < 500; i += 10) b[i] = `modified-line-${i}`;
  const r = diffStrings(a.join("\n"), b.join("\n"), { context: 0 });
  assert(r.additions === 50 && r.deletions === 50,
    `adds=${r.additions}, dels=${r.deletions}`);
});

test("[170-C-3] diff_strings: json format on 100-line diff — block count >= 1", () => {
  const a = Array.from({length: 100}, (_, i) => `l${i}`).join("\n");
  const b = a.replace("l50", "CHANGED");
  const r = diffStrings(a, b, { format: "json", context: 1 });
  assert(Array.isArray(r.changes) && r.changes.length >= 1);
  assert(r.additions === 1 && r.deletions === 1);
});

test("[170-C-4] diff_strings: 3.9 MB string near limit → no crash", () => {
  const big = "x".repeat(3 * 1024 * 1024);
  // big is a single line (no newlines); big+"y" is a different single line
  // so the diff is 1 deletion (old line) + 1 addition (new line)
  const r = diffStrings(big, big + "y");
  assert(r.additions === 1 && r.deletions === 1, `adds=${r.additions}, dels=${r.deletions}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// [170-D] CRITICAL — sanitization / adversarial inputs
// ─────────────────────────────────────────────────────────────────────────────
test("[170-D-1] diff_strings: label with newlines doesn't crash the header", () => {
  const r = diffStrings("old", "new", {
    label_a: "before\nhacked-line",
    label_b: "after\nhacked-line",
  });
  assert(r.unified.includes("@@"), "should still have @@ hunk marker");
});

test("[170-D-2] diff_strings: NUL bytes in strings are handled gracefully", () => {
  const a = "line1\n\x00nullbyte\nline3";
  const b = "line1\nno-null\nline3";
  const r = diffStrings(a, b);
  assert(r.additions === 1 && r.deletions === 1);
});

test("[170-D-3] diff_strings: >4 MB 'a' throws RangeError", () => {
  const tooBig = "x".repeat(4 * 1024 * 1024 + 1);
  let threw = false;
  try { diffStrings(tooBig, ""); } catch (e) { threw = true; assert(e instanceof RangeError); }
  assert(threw, "should throw RangeError for oversized input");
});

test("[170-D-4] diff_strings: >4 MB 'b' throws RangeError", () => {
  const tooBig = "y".repeat(4 * 1024 * 1024 + 1);
  let threw = false;
  try { diffStrings("small", tooBig); } catch (e) { threw = true; assert(e instanceof RangeError); }
  assert(threw, "should throw RangeError for oversized input");
});

test("[170-D-5] diff_strings: unicode multibyte strings diff correctly", () => {
  const a = "café\nnaïve\nрезультат";
  const b = "café\nnaïve\nresult";
  const r = diffStrings(a, b);
  assert(r.additions === 1 && r.deletions === 1);
  assert(r.unified.includes("-результат"));
  assert(r.unified.includes("+result"));
});

// ─────────────────────────────────────────────────────────────────────────────
// [170-E] EXTREME — concurrency & memory efficiency
// ─────────────────────────────────────────────────────────────────────────────
test("[170-E-1] diff_strings: 50 concurrent calls return consistent results", async () => {
  const a = Array.from({length: 200}, (_, i) => `l${i}`).join("\n");
  const b = a.replace("l100", "CHANGED");
  const results = await Promise.all(
    Array.from({length: 50}, () => Promise.resolve(diffStrings(a, b)))
  );
  for (const r of results) {
    assert(r.additions === 1 && r.deletions === 1, "concurrent result mismatch");
  }
});

test("[170-E-2] diff_strings: all-changed lines (worst-case LCS)", () => {
  const a = Array.from({length: 80}, (_, i) => `a-${i}`).join("\n");
  const b = Array.from({length: 80}, (_, i) => `b-${i}`).join("\n");
  const r = diffStrings(a, b);
  assert(r.additions === 80 && r.deletions === 80,
    `adds=${r.additions}, dels=${r.deletions}`);
});

test("[170-E-3] diff_strings: json format produces identical semantics as unified", () => {
  const a = "alpha\nbeta\ngamma\ndelta";
  const b = "alpha\nBETA\ngamma\nDELTA";
  const rU = diffStrings(a, b, { format: "unified" });
  const rJ = diffStrings(a, b, { format: "json" });
  assert(rU.additions === rJ.additions);
  assert(rU.deletions === rJ.deletions);
  assert(rU.hunks === rJ.hunks);
  assert(rU.identical === rJ.identical);
});

// ─────────────────────────────────────────────────────────────────────────────
// [170-F] NORMAL — password_generate (password mode)
// ─────────────────────────────────────────────────────────────────────────────
test("[170-F-1] password_generate: default returns 16-char password with entropy", () => {
  const r = generatePasswords();
  assert(r.mode === "password");
  assert(r.count === 1);
  assert(r.length === 16, `length=${r.length}`);
  assert(typeof r.password === "string" && r.password.length === 16);
  assert(r.entropyBits > 0, `entropyBits=${r.entropyBits}`);
  assert(Array.isArray(r.passwords) && r.passwords.length === 1);
});

test("[170-F-2] password_generate: custom length option is honoured", () => {
  const r = generatePasswords({ length: 32 });
  assert(r.password.length === 32 && r.length === 32);
});

test("[170-F-3] password_generate: include_symbols adds symbol chars to pool", () => {
  const r = generatePasswords({ include_symbols: true, count: 200, length: 64 });
  const symbols = "!@#$%^&*()-_=+[]{}|;:,.<>?";
  const allChars = r.passwords.join("");
  assert([...symbols].some(s => allChars.includes(s)),
    "symbol class enabled but no symbol found in 200 passwords");
});

test("[170-F-4] password_generate: count=5 returns exactly 5 passwords", () => {
  const r = generatePasswords({ count: 5 });
  assert(r.count === 5);
  assert(r.passwords.length === 5);
  assert(r.password === undefined, "convenience key should not exist for count>1");
});

test("[170-F-5] password_generate: count=1 includes convenience 'password' key", () => {
  const r = generatePasswords({ count: 1 });
  assert(typeof r.password === "string");
  assert(r.password === r.passwords[0]);
});

test("[170-F-6] password_generate: lowercase-only pool produces only [a-z]", () => {
  const r = generatePasswords({
    include_lowercase: true, include_uppercase: false, include_digits: false,
    count: 5, length: 40,
  });
  for (const pwd of r.passwords)
    assert(/^[a-z]+$/.test(pwd), `non-lowercase char in: ${pwd}`);
});

test("[170-F-7] password_generate: digits-only pool produces only [0-9]", () => {
  const r = generatePasswords({
    include_lowercase: false, include_uppercase: false, include_digits: true,
    count: 5, length: 20,
  });
  for (const pwd of r.passwords)
    assert(/^\d+$/.test(pwd), `non-digit in: ${pwd}`);
});

test("[170-F-8] password_generate: exclude_chars removes specified chars from output", () => {
  const r = generatePasswords({ exclude_chars: "0Ol1I", count: 20, length: 64 });
  const ambiguous = new Set("0Ol1I");
  for (const pwd of r.passwords)
    for (const ch of pwd)
      assert(!ambiguous.has(ch), `excluded char '${ch}' appeared in: ${pwd}`);
});

test("[170-F-9] password_generate: custom symbols string is used when include_symbols=true", () => {
  const r = generatePasswords({
    include_lowercase: false, include_uppercase: false, include_digits: false,
    include_symbols: true, symbols: "!@#", count: 10, length: 30,
  });
  for (const pwd of r.passwords)
    assert(/^[!@#]+$/.test(pwd), `unexpected char in: ${pwd}`);
});

test("[170-F-10] password_generate: charsetSize matches lowercase-only pool (26)", () => {
  const r = generatePasswords({
    include_lowercase: true, include_uppercase: false,
    include_digits: false, include_symbols: false,
  });
  assert(r.charsetSize === 26, `charsetSize=${r.charsetSize}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// [170-G] NORMAL — password_generate (passphrase mode)
// ─────────────────────────────────────────────────────────────────────────────
test("[170-G-1] passphrase mode: default 4 words joined by '-'", () => {
  const r = generatePasswords({ mode: "passphrase" });
  assert(r.mode === "passphrase");
  assert(r.wordCount === 4);
  assert(r.separator === "-");
  const parts = r.passphrase.split("-");
  assert(parts.length === 4, `parts=${parts.length}`);
  for (const w of parts)
    assert(WORD_LIST.includes(w), `word '${w}' not in word list`);
});

test("[170-G-2] passphrase: capitalize_words Title-cases each word", () => {
  const r = generatePasswords({ mode: "passphrase", capitalize_words: true, count: 10 });
  for (const phrase of r.passphrases) {
    const words = phrase.split("-");
    for (const w of words)
      assert(w[0] === w[0].toUpperCase(), `word '${w}' not capitalized`);
  }
});

test("[170-G-3] passphrase: add_number appends a single digit 0-9", () => {
  const r = generatePasswords({ mode: "passphrase", add_number: true, count: 20 });
  for (const phrase of r.passphrases) {
    const last = phrase[phrase.length - 1];
    assert(/\d/.test(last), `no trailing digit in: ${phrase}`);
  }
});

test("[170-G-4] passphrase: word_count=6 produces 6 words", () => {
  const r = generatePasswords({ mode: "passphrase", word_count: 6 });
  assert(r.wordCount === 6);
  const parts = r.passphrase.split("-");
  assert(parts.length === 6, `parts=${parts.length}`);
});

test("[170-G-5] passphrase: entropyBits = 9 × wordCount for 512-word list", () => {
  const r = generatePasswords({ mode: "passphrase", word_count: 4 });
  assert(Math.abs(r.entropyBits - 36) < 0.01, `entropyBits=${r.entropyBits}`);
});

test("[170-G-6] passphrase: add_number adds ~3.32 extra bits of entropy", () => {
  const base    = generatePasswords({ mode: "passphrase", word_count: 4, add_number: false });
  const withNum = generatePasswords({ mode: "passphrase", word_count: 4, add_number: true });
  const diff = withNum.entropyBits - base.entropyBits;
  assert(Math.abs(diff - Math.log2(10)) < 0.01, `entropy diff=${diff}`);
});

test("[170-G-7] passphrase: custom separator (space) works", () => {
  const r = generatePasswords({ mode: "passphrase", word_separator: " ", word_count: 4 });
  const parts = r.passphrase.split(" ");
  assert(parts.length === 4, `parts=${parts.length}`);
});

test("[170-G-8] passphrase: count=5 returns 5 passphrases, no convenience key", () => {
  const r = generatePasswords({ mode: "passphrase", count: 5 });
  assert(r.passphrases.length === 5);
  assert(r.passphrase === undefined, "convenience key should not exist for count>1");
});

test("[170-G-9] passphrase: wordlistSize is 512", () => {
  const r = generatePasswords({ mode: "passphrase" });
  assert(r.wordlistSize === 512);
  assert(WORD_LIST.length === 512, `WORD_LIST.length=${WORD_LIST.length}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// [170-H] MEDIUM — password_generate validation / empty inputs
// ─────────────────────────────────────────────────────────────────────────────
test("[170-H-1] password_generate: empty pool → ToolError (-32602)", () => {
  let threw = false;
  try {
    generatePasswords({
      include_lowercase: false, include_uppercase: false,
      include_digits: false, include_symbols: false,
    });
  } catch (e) {
    threw = true;
    assert(e instanceof ToolError, `expected ToolError, got ${e.constructor.name}`);
    assert(e.code === -32602);
  }
  assert(threw, "should have thrown ToolError for empty pool");
});

test("[170-H-2] password_generate: exclude_chars drains pool entirely → ToolError", () => {
  let threw = false;
  try {
    generatePasswords({
      include_lowercase: false, include_uppercase: false,
      include_digits: true,
      exclude_chars: "0123456789",
    });
  } catch (e) {
    threw = true;
    assert(e instanceof ToolError);
  }
  assert(threw, "should have thrown ToolError");
});

test("[170-H-3] password_generate: count < 1 → clamped to 1", () => {
  const r = generatePasswords({ count: -5 });
  assert(r.count === 1 && r.passwords.length === 1);
});

test("[170-H-4] password_generate: count > 100 → clamped to 100", () => {
  const r = generatePasswords({ count: 999 });
  assert(r.count === 100 && r.passwords.length === 100);
});

test("[170-H-5] password_generate: length < 4 → clamped to 4", () => {
  const r = generatePasswords({ length: 1 });
  assert(r.length === 4 && r.password.length === 4);
});

test("[170-H-6] password_generate: length > 512 → clamped to 512", () => {
  const r = generatePasswords({ length: 9999 });
  assert(r.length === 512 && r.password.length === 512);
});

test("[170-H-7] passphrase: word_count < 3 → clamped to 3", () => {
  const r = generatePasswords({ mode: "passphrase", word_count: 1 });
  assert(r.wordCount === 3);
});

test("[170-H-8] passphrase: word_count > 10 → clamped to 10", () => {
  const r = generatePasswords({ mode: "passphrase", word_count: 99 });
  assert(r.wordCount === 10);
});

test("[170-H-9] password_generate: single-char pool → ToolError", () => {
  let threw = false;
  try {
    generatePasswords({
      include_lowercase: false, include_uppercase: false,
      include_digits: false, include_symbols: true, symbols: "X",
    });
  } catch (e) {
    threw = true;
    assert(e instanceof ToolError, `expected ToolError, got ${e.constructor.name}`);
  }
  assert(threw, "should throw ToolError for single-char pool");
});

// ─────────────────────────────────────────────────────────────────────────────
// [170-I] HIGH — charset correctness, entropy, rejection-sampling
// ─────────────────────────────────────────────────────────────────────────────
test("[170-I-1] password_generate: all chars in output come from expected pool", () => {
  const pool = new Set("ABCDE");
  const r = generatePasswords({
    include_lowercase: false, include_uppercase: false,
    include_digits: false, include_symbols: true,
    symbols: "ABCDE", count: 20, length: 32,
  });
  for (const pwd of r.passwords)
    for (const ch of pwd)
      assert(pool.has(ch), `char '${ch}' not in pool`);
});

test("[170-I-2] password_generate: entropyBits = length × log2(charsetSize)", () => {
  const r = generatePasswords({
    include_lowercase: true, include_uppercase: false, include_digits: false, length: 16,
  });
  const expected = parseFloat((16 * Math.log2(26)).toFixed(2));
  assert(Math.abs(r.entropyBits - expected) < 0.01,
    `entropyBits=${r.entropyBits}, expected=${expected}`);
});

test("[170-I-3] password_generate: 100 passwords are statistically unique", () => {
  const r = generatePasswords({ count: 100, length: 16 });
  const unique = new Set(r.passwords);
  assert(unique.size === 100, `only ${unique.size} unique passwords in 100 generated`);
});

test("[170-I-4] password_generate: randomUniform returns values in [0, n)", () => {
  for (const n of [2, 3, 7, 10, 26, 62, 97]) {
    for (let i = 0; i < 50; i++) {
      const v = randomUniform(n);
      assert(v >= 0 && v < n, `randomUniform(${n})=${v} out of range`);
    }
  }
});

test("[170-I-5] password_generate: uppercase-only pool produces only [A-Z]", () => {
  const r = generatePasswords({
    include_lowercase: false, include_uppercase: true, include_digits: false,
    count: 5, length: 40,
  });
  for (const pwd of r.passwords)
    assert(/^[A-Z]+$/.test(pwd), `non-uppercase char in: ${pwd}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// [170-J] EXTREME — concurrency, stress, memory
// ─────────────────────────────────────────────────────────────────────────────
test("[170-J-1] password_generate: count=100, length=512 — max-size stress", () => {
  const r = generatePasswords({ count: 100, length: 512 });
  assert(r.passwords.length === 100);
  for (const pwd of r.passwords)
    assert(pwd.length === 512, `pwd.length=${pwd.length}`);
});

test("[170-J-2] password_generate: 50 concurrent calls return correct mode", async () => {
  const results = await Promise.all(
    Array.from({length: 50}, () => Promise.resolve(generatePasswords({ count: 5 })))
  );
  for (const r of results) {
    assert(r.mode === "password");
    assert(r.passwords.length === 5);
    for (const pwd of r.passwords)
      assert(pwd.length === 16, `pwd.length=${pwd.length}`);
  }
});

test("[170-J-3] passphrase: 50 concurrent calls, all valid words", async () => {
  const calls = Array.from({length: 50}, () =>
    Promise.resolve(generatePasswords({ mode: "passphrase", word_count: 6, count: 3 }))
  );
  const results = await Promise.all(calls);
  const wordSet = new Set(WORD_LIST);
  for (const r of results) {
    for (const phrase of r.passphrases) {
      const words = phrase.split("-");
      assert(words.length === 6, `word count mismatch: ${words.length}`);
      for (const w of words)
        assert(wordSet.has(w), `unknown word '${w}'`);
    }
  }
});

test("[170-J-4] password_generate: entropy monotonically increases with length", () => {
  let prevBits = 0;
  for (const len of [8, 12, 16, 24, 32, 64]) {
    const r = generatePasswords({ length: len });
    assert(r.entropyBits > prevBits,
      `entropy not increasing: len=${len} bits=${r.entropyBits} prev=${prevBits}`);
    prevBits = r.entropyBits;
  }
});

test("[170-J-5] password_generate: all 512 words in WORD_LIST are unique", () => {
  const unique = new Set(WORD_LIST);
  assert(unique.size === 512,
    `WORD_LIST has ${unique.size} unique words (expected 512)`);
});
