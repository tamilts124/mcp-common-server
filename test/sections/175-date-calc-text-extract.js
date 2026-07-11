"use strict";
/**
 * test/sections/175-date-calc-text-extract.js
 * Isolated functional tests for date_calc and text_extract.
 * Section [175] — 5 rigor levels (A-E) per tool, 10 sub-sections total.
 */
const { test } = require("../test-harness");
const { dateCalc }    = require("../../lib/dateCalcOps");
const { textExtract } = require("../../lib/textExtractOps");

function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function assertThrows(fn, check) {
  let threw = false, err;
  try { fn(); } catch (e) { threw = true; err = e; }
  assert(threw, "expected an error to be thrown");
  if (check) check(err);
}
function approxEq(a, b, eps = 0.001) { return Math.abs(a - b) < eps; }

// ============================================================
// Section A: date_calc — Normal (happy-path)
// ============================================================

test("[175-A1] date_calc now returns iso + unix", () => {
  const r = dateCalc({ operation: "now" });
  assert(r.operation === "now", `op=${r.operation}`);
  assert(typeof r.iso === "string" && r.iso.includes("T"), `iso=${r.iso}`);
  assert(typeof r.unix === "number" && r.unix > 0, `unix=${r.unix}`);
  assert(r.timezone === "UTC", `tz=${r.timezone}`);
});

test("[175-A2] date_calc parse ISO string", () => {
  const r = dateCalc({ operation: "parse", date: "2024-06-15T12:00:00Z" });
  assert(r.components.year === 2024, `year=${r.components.year}`);
  assert(r.components.month === 6, `month=${r.components.month}`);
  assert(r.components.day === 15, `day=${r.components.day}`);
  assert(r.components.hour === 12, `hour=${r.components.hour}`);
});

test("[175-A3] date_calc format with tokens", () => {
  const r = dateCalc({ operation: "format", date: "2024-03-07T09:05:00Z", format: "YYYY-MM-DD HH:mm" });
  assert(r.formatted === "2024-03-07 09:05", `formatted=${r.formatted}`);
});

test("[175-A4] date_calc add 5 days", () => {
  const r = dateCalc({ operation: "add", date: "2024-01-01T00:00:00Z", amount: 5, unit: "day" });
  assert(r.components.day === 6, `day=${r.components.day}`);
});

test("[175-A5] date_calc subtract 1 month", () => {
  const r = dateCalc({ operation: "subtract", date: "2024-03-31T00:00:00Z", amount: 1, unit: "month" });
  // March - 1 month = Feb; Feb has 29 days in 2024 (leap year) — clamp to 29
  assert(r.components.month === 2, `month=${r.components.month}`);
  assert(r.components.day === 29, `day=${r.components.day}`);
});

test("[175-A6] date_calc diff in days", () => {
  const r = dateCalc({ operation: "diff", date: "2024-01-01T00:00:00Z", date2: "2024-01-11T00:00:00Z", unit: "day" });
  assert(r.diff === 10, `diff=${r.diff}`);
});

test("[175-A7] date_calc start_of day", () => {
  const r = dateCalc({ operation: "start_of", date: "2024-06-15T14:30:45Z", unit: "day" });
  assert(r.components.hour === 0, `hour=${r.components.hour}`);
  assert(r.components.minute === 0, `min=${r.components.minute}`);
  assert(r.components.second === 0, `sec=${r.components.second}`);
});

test("[175-A8] date_calc end_of month", () => {
  const r = dateCalc({ operation: "end_of", date: "2024-02-10T00:00:00Z", unit: "month" });
  assert(r.components.day === 29, `day=${r.components.day}`); // 2024 is leap year
  assert(r.components.hour === 23, `hour=${r.components.hour}`);
});

test("[175-A9] date_calc convert_tz UTC to IST", () => {
  const r = dateCalc({
    operation: "convert_tz", date: "2024-01-01T00:00:00Z",
    to_timezone: "Asia/Kolkata",
  });
  // UTC+5:30 -> hour should be 5, minute 30
  assert(r.components.hour === 5, `hour=${r.components.hour}`);
  assert(r.components.minute === 30, `min=${r.components.minute}`);
  assert(r.toTimezone === "Asia/Kolkata", `toTz=${r.toTimezone}`);
});

test("[175-A10] date_calc is_valid for valid and invalid dates", () => {
  const ok = dateCalc({ operation: "is_valid", date: "2024-06-15" });
  assert(ok.valid === true, `valid=${ok.valid}`);
  const bad = dateCalc({ operation: "is_valid", date: "not-a-date" });
  assert(bad.valid === false, `valid=${bad.valid}`);
});

// ============================================================
// Section B: date_calc — Medium (edge values)
// ============================================================

test("[175-B1] date_calc parse unix seconds", () => {
  const r = dateCalc({ operation: "parse", date: 0 });
  assert(r.components.year === 1970, `year=${r.components.year}`);
});

test("[175-B2] date_calc parse unix ms string", () => {
  const r = dateCalc({ operation: "parse", date: "1704067200000" }); // 2024-01-01T00:00:00Z
  assert(r.components.year === 2024, `year=${r.components.year}`);
});

test("[175-B3] date_calc add 1 year leap-year boundary", () => {
  // 2024-02-29 + 1 year → 2025-02-28 (not a leap year)
  const r = dateCalc({ operation: "add", date: "2024-02-29T00:00:00Z", amount: 1, unit: "year" });
  assert(r.components.year === 2025, `year=${r.components.year}`);
  assert(r.components.month === 2, `month=${r.components.month}`);
  assert(r.components.day === 28, `day=${r.components.day}`);
});

test("[175-B4] date_calc diff in hours negative direction", () => {
  const r = dateCalc({ operation: "diff", date: "2024-01-10T00:00:00Z", date2: "2024-01-01T00:00:00Z", unit: "hour" });
  assert(r.diff === -216, `diff=${r.diff}`); // -9 * 24
});

test("[175-B5] date_calc format MMMM and dddd tokens", () => {
  const r = dateCalc({ operation: "format", date: "2024-01-15T00:00:00Z", format: "MMMM dddd" });
  assert(r.formatted === "January Monday", `formatted=${r.formatted}`);
});

test("[175-B6] date_calc format AM/PM for noon and midnight", () => {
  const noon = dateCalc({ operation: "format", date: "2024-01-01T12:00:00Z", format: "h:mm A" });
  assert(noon.formatted === "12:00 PM", `noon=${noon.formatted}`);
  const midnight = dateCalc({ operation: "format", date: "2024-01-01T00:00:00Z", format: "h:mm A" });
  assert(midnight.formatted === "12:00 AM", `midnight=${midnight.formatted}`);
});

test("[175-B7] date_calc start_of week (Monday)", () => {
  // 2024-01-17 is a Wednesday. start_of week = Monday 2024-01-15
  const r = dateCalc({ operation: "start_of", date: "2024-01-17T12:00:00Z", unit: "week" });
  assert(r.components.day === 15, `day=${r.components.day}`);
});

test("[175-B8] date_calc diff in months", () => {
  const r = dateCalc({ operation: "diff", date: "2023-01-01T00:00:00Z", date2: "2024-06-01T00:00:00Z", unit: "month" });
  assert(r.diff === 17, `diff=${r.diff}`);
});

// ============================================================
// Section C: date_calc — High (timezone + format coverage)
// ============================================================

test("[175-C1] date_calc format X = unix seconds", () => {
  const r = dateCalc({ operation: "format", date: "2024-01-01T00:00:00Z", format: "X" });
  assert(r.formatted === "1704067200", `X=${r.formatted}`);
});

test("[175-C2] date_calc format x = unix ms", () => {
  const r = dateCalc({ operation: "format", date: "2024-01-01T00:00:00Z", format: "x" });
  assert(r.formatted === "1704067200000", `x=${r.formatted}`);
});

test("[175-C3] date_calc convert_tz UTC to US/Eastern (winter = -5h)", () => {
  const r = dateCalc({
    operation: "convert_tz", date: "2024-01-15T12:00:00Z",
    to_timezone: "America/New_York",
  });
  assert(r.components.hour === 7, `hour=${r.components.hour}`);
});

test("[175-C4] date_calc end_of year", () => {
  const r = dateCalc({ operation: "end_of", date: "2024-06-15T00:00:00Z", unit: "year" });
  assert(r.components.month === 12, `month=${r.components.month}`);
  assert(r.components.day === 31, `day=${r.components.day}`);
});

test("[175-C5] date_calc now with format option", () => {
  const r = dateCalc({ operation: "now", format: "YYYY" });
  assert(typeof r.formatted === "string" && r.formatted.length === 4, `formatted=${r.formatted}`);
});

test("[175-C6] date_calc diff in years fractional", () => {
  const r = dateCalc({ operation: "diff", date: "2024-01-01T00:00:00Z", date2: "2024-07-01T00:00:00Z", unit: "year" });
  assert(approxEq(r.diff, 0.5, 0.05), `diff=${r.diff}`);
});

// ============================================================
// Section D: date_calc — Critical (error handling)
// ============================================================

test("[175-D1] date_calc missing operation throws", () => {
  assertThrows(() => dateCalc({}), e => assert(e.message.includes("operation"), `msg=${e.message}`));
});

test("[175-D2] date_calc unknown operation throws", () => {
  assertThrows(() => dateCalc({ operation: "INVALID" }), e => assert(e.message.includes("INVALID"), `msg=${e.message}`));
});

test("[175-D3] date_calc add missing amount throws", () => {
  assertThrows(() => dateCalc({ operation: "add", date: "2024-01-01T00:00:00Z", unit: "day" }),
    e => assert(e.message.includes("amount"), `msg=${e.message}`));
});

test("[175-D4] date_calc add missing unit throws", () => {
  assertThrows(() => dateCalc({ operation: "add", date: "2024-01-01T00:00:00Z", amount: 1 }),
    e => assert(e.message.includes("unit"), `msg=${e.message}`));
});

test("[175-D5] date_calc unknown timezone throws", () => {
  assertThrows(() => dateCalc({ operation: "now", timezone: "Not/AReal/Zone" }),
    e => assert(e.message.includes("Unknown timezone"), `msg=${e.message}`));
});

test("[175-D6] date_calc convert_tz missing to_timezone throws", () => {
  assertThrows(() => dateCalc({ operation: "convert_tz", date: "2024-01-01T00:00:00Z" }),
    e => assert(e.message.includes("to_timezone"), `msg=${e.message}`));
});

test("[175-D7] date_calc parse unparseable string throws", () => {
  assertThrows(() => dateCalc({ operation: "parse", date: "banana" }),
    e => assert(e.message.includes("Cannot parse"), `msg=${e.message}`));
});

test("[175-D8] date_calc diff missing date2 throws", () => {
  assertThrows(() => dateCalc({ operation: "diff", date: "2024-01-01T00:00:00Z" }),
    e => assert(e.message.includes("date2"), `msg=${e.message}`));
});

// ============================================================
// Section E: date_calc — Extreme (stress / correctness)
// ============================================================

test("[175-E1] date_calc add 365 days equals ~1 year", () => {
  const r = dateCalc({ operation: "add", date: "2024-01-01T00:00:00Z", amount: 366, unit: "day" }); // 2024 is leap
  assert(r.components.year === 2025, `year=${r.components.year}`);
  assert(r.components.month === 1, `month=${r.components.month}`);
  assert(r.components.day === 1, `day=${r.components.day}`);
});

test("[175-E2] date_calc 120 sequential adds of 1 day are consistent", () => {
  let date = "2024-01-01T00:00:00Z";
  for (let i = 0; i < 120; i++) {
    const r = dateCalc({ operation: "add", date, amount: 1, unit: "day" });
    assert(r.iso, `step ${i}: no iso`);
    date = r.iso;
  }
  // After 120 days from Jan 1 2024 = April 30, 2024
  // Jan=31 days (-1 for start) + Feb=29 + Mar=31 + 29 into Apr = Apr 30 = 120 total adds
  const final = dateCalc({ operation: "parse", date });
  assert(final.components.month === 4, `month=${final.components.month}`);
  assert(final.components.day === 30, `day=${final.components.day}`);
});

test("[175-E3] date_calc all 12 start_of month first days", () => {
  for (let m = 1; m <= 12; m++) {
    const mm = String(m).padStart(2, "0");
    const r = dateCalc({ operation: "start_of", date: `2024-${mm}-15T12:30:00Z`, unit: "month" });
    assert(r.components.day === 1, `month ${m}: day=${r.components.day}`);
    assert(r.components.hour === 0, `month ${m}: hour=${r.components.hour}`);
  }
});

// ============================================================
// Section F: text_extract — Normal (happy-path)
// ============================================================

test("[175-F1] text_extract emails basic", () => {
  const r = textExtract({ operation: "emails", text: "Contact us at hello@example.com or support@test.org" });
  assert(r.operation === "emails", `op=${r.operation}`);
  assert(r.count === 2, `count=${r.count}`);
  assert(r.emails.includes("hello@example.com"), "missing hello@example.com");
  assert(r.emails.includes("support@test.org"), "missing support@test.org");
});

test("[175-F2] text_extract urls http and https", () => {
  const r = textExtract({ operation: "urls", text: "Visit https://example.com/path?q=1 or http://old.site.net" });
  assert(r.count === 2, `count=${r.count}`);
  assert(r.urls.some(u => u.startsWith("https://example.com")), "missing https url");
  assert(r.urls.some(u => u.includes("old.site.net")), "missing http url");
});

test("[175-F3] text_extract phones US format", () => {
  const r = textExtract({ operation: "phones", text: "Call (800) 555-1234 or 1-888-987-6543" });
  assert(r.count >= 1, `count=${r.count}`);
  assert(r.phones.length > 0, "no phones found");
});

test("[175-F4] text_extract ips IPv4", () => {
  const r = textExtract({ operation: "ips", text: "Server at 192.168.1.1 and 10.0.0.255 are up" });
  assert(r.count === 2, `count=${r.count}`);
  assert(r.ips.some(x => x.address === "192.168.1.1"), "missing 192.168.1.1");
  assert(r.ips.every(x => x.version === 4), "all should be v4");
});

test("[175-F5] text_extract numbers integer and decimal", () => {
  const r = textExtract({ operation: "numbers", text: "There are 42 items at $3.99 each, totaling -167.58" });
  const vals = r.numbers.map(n => n.value);
  assert(vals.includes(42), "missing 42");
  assert(vals.some(v => Math.abs(v - 3.99) < 0.001), "missing 3.99");
  assert(vals.some(v => Math.abs(v - (-167.58)) < 0.001), "missing -167.58");
});

test("[175-F6] text_extract dates ISO and slash-format", () => {
  const r = textExtract({ operation: "dates", text: "Event on 2024-06-15 and 01/31/2024 are both confirmed" });
  assert(r.count >= 2, `count=${r.count}`);
  assert(r.dates.some(d => d.date.includes("2024-06-15")), "missing ISO date");
});

test("[175-F7] text_extract json fragment", () => {
  const r = textExtract({ operation: "json", text: 'Response: {"status":"ok","code":200} end' });
  assert(r.count === 1, `count=${r.count}`);
  assert(r.fragments[0].value.status === "ok", `status=${r.fragments[0].value.status}`);
  assert(r.fragments[0].value.code === 200, `code=${r.fragments[0].value.code}`);
});

test("[175-F8] text_extract lines filter", () => {
  const r = textExtract({ operation: "lines", text: "alpha\nbeta\ngamma\nalpha again", pattern: "alpha" });
  assert(r.matchCount === 2, `matchCount=${r.matchCount}`);
  assert(r.lines.every(l => !l.matched || l.text.includes("alpha")), "non-alpha matched");
});

test("[175-F9] text_extract between delimiters", () => {
  const r = textExtract({ operation: "between", text: "<start>hello world<end>", start: "<start>", end: "<end>" });
  assert(r.count === 1, `count=${r.count}`);
  assert(r.matches[0].content === "hello world", `content=${r.matches[0].content}`);
});

test("[175-F10] text_extract pattern custom regex", () => {
  const r = textExtract({ operation: "pattern", text: "v1.2.3 and v4.5.6 are versions", pattern: "v\\d+\\.\\d+\\.\\d+" });
  assert(r.count === 2, `count=${r.count}`);
  assert(r.matches[0].match === "v1.2.3", `match=${r.matches[0].match}`);
});

test("[175-F11] text_extract words top frequency", () => {
  const r = textExtract({ operation: "words", text: "the cat sat on the mat the cat" });
  assert(r.topWords[0].word === "the", `top=${r.topWords[0].word}`);
  assert(r.topWords[0].count === 3, `count=${r.topWords[0].count}`);
});

// ============================================================
// Section G: text_extract — Medium (edge cases)
// ============================================================

test("[175-G1] text_extract emails dedupe removes duplicates", () => {
  const r = textExtract({ operation: "emails", text: "a@b.com, a@b.com, c@d.com" });
  assert(r.count === 2, `count=${r.count}`);
});

test("[175-G2] text_extract emails dedupe=false keeps all", () => {
  const r = textExtract({ operation: "emails", text: "a@b.com a@b.com a@b.com", dedupe: false });
  assert(r.count === 3, `count=${r.count}`);
});

test("[175-G3] text_extract urls strips trailing punctuation", () => {
  const r = textExtract({ operation: "urls", text: "See https://example.com/page." });
  assert(r.urls[0].endsWith("page"), `url=${r.urls[0]}`);
});

test("[175-G4] text_extract lines invert", () => {
  const r = textExtract({ operation: "lines", text: "error: bad\ninfo: ok\nerror: again", pattern: "error", invert: true });
  assert(r.lines.every(l => l.text.includes("info")), "invert failed");
});

test("[175-G5] text_extract lines with context", () => {
  const r = textExtract({ operation: "lines", text: "A\nB\nC\nD\nE", pattern: "C", context: 1 });
  const texts = r.lines.map(l => l.text);
  assert(texts.includes("B") && texts.includes("C") && texts.includes("D"), `lines=${texts}`);
});

test("[175-G6] text_extract between multiple spans", () => {
  const r = textExtract({ operation: "between", text: "[a][b][c]", start: "[", end: "]" });
  assert(r.count === 3, `count=${r.count}`);
  assert(r.matches.map(m => m.content).join("") === "abc", `content=${r.matches.map(m=>m.content)}`);
});

test("[175-G7] text_extract between include_delimiters", () => {
  const r = textExtract({ operation: "between", text: "{{foo}}", start: "{{", end: "}}", include_delimiters: true });
  assert(r.matches[0].full === "{{foo}}", `full=${r.matches[0].full}`);
});

test("[175-G8] text_extract between greedy", () => {
  const r = textExtract({ operation: "between", text: "[outer[inner]outer]", start: "[", end: "]", greedy: true });
  assert(r.count === 1, `count=${r.count}`);
  assert(r.matches[0].content.includes("inner"), `content=${r.matches[0].content}`);
});

test("[175-G9] text_extract words stop_words", () => {
  const r = textExtract({ operation: "words", text: "the cat sat on the mat", stop_words: ["the", "on"] });
  assert(!r.topWords.some(w => w.word === "the"), "should exclude 'the'");
});

test("[175-G10] text_extract words min_length", () => {
  const r = textExtract({ operation: "words", text: "a bb ccc dddd eeeee", min_length: 3 });
  assert(!r.topWords.some(w => w.word.length < 3), "words shorter than 3 included");
});

// ============================================================
// Section H: text_extract — High (JSON fragments + regex groups)
// ============================================================

test("[175-H1] text_extract json finds nested object", () => {
  const r = textExtract({ operation: "json", text: 'data: {"a":{"b":1}} end' });
  assert(r.count === 1, `count=${r.count}`);
  assert(r.fragments[0].value.a.b === 1, `nested=${r.fragments[0].value.a.b}`);
});

test("[175-H2] text_extract json finds array", () => {
  const r = textExtract({ operation: "json", text: "list: [1,2,3] done" });
  assert(r.count === 1, `count=${r.count}`);
  assert(Array.isArray(r.fragments[0].value), "not an array");
  assert(r.fragments[0].value.length === 3, `length=${r.fragments[0].value.length}`);
});

test("[175-H3] text_extract json skips invalid fragments", () => {
  const r = textExtract({ operation: "json", text: "{invalid} and {\"ok\": true}" });
  assert(r.count === 1, `count=${r.count}`);
  assert(r.fragments[0].value.ok === true, `ok=${r.fragments[0].value.ok}`);
});

test("[175-H4] text_extract pattern with capture groups", () => {
  const r = textExtract({ operation: "pattern", text: "2024-01-15 and 2023-12-31", pattern: "(\\d{4})-(\\d{2})-(\\d{2})" });
  assert(r.count === 2, `count=${r.count}`);
  assert(r.matches[0].groups[0] === "2024", `g0=${r.matches[0].groups[0]}`);
  assert(r.matches[0].groups[2] === "15", `g2=${r.matches[0].groups[2]}`);
});

test("[175-H5] text_extract pattern named groups", () => {
  const r = textExtract({ operation: "pattern", text: "price: $42.50", pattern: "\\$(?<dollars>\\d+)\\.(?<cents>\\d{2})" });
  assert(r.count === 1, `count=${r.count}`);
  assert(r.matches[0].namedGroups.dollars === "42", `dollars=${r.matches[0].namedGroups?.dollars}`);
  assert(r.matches[0].namedGroups.cents === "50", `cents=${r.matches[0].namedGroups?.cents}`);
});

test("[175-H6] text_extract ips v4 does not include broadcast 255.255.255.255 issues", () => {
  const r = textExtract({ operation: "ips", text: "Broadcast: 255.255.255.255, localhost: 127.0.0.1" });
  assert(r.ips.some(x => x.address === "127.0.0.1"), "missing 127.0.0.1");
  assert(r.ips.some(x => x.address === "255.255.255.255"), "missing broadcast");
});

// ============================================================
// Section I: text_extract — Critical (validation)
// ============================================================

test("[175-I1] text_extract missing operation throws", () => {
  assertThrows(() => textExtract({ text: "hello" }),
    e => assert(e.message.includes("operation"), `msg=${e.message}`));
});

test("[175-I2] text_extract unknown operation throws", () => {
  assertThrows(() => textExtract({ operation: "NOPE", text: "hello" }),
    e => assert(e.message.includes("NOPE"), `msg=${e.message}`));
});

test("[175-I3] text_extract non-string text throws", () => {
  assertThrows(() => textExtract({ operation: "emails", text: 12345 }),
    e => assert(e.message.includes("string"), `msg=${e.message}`));
});

test("[175-I4] text_extract between missing start throws", () => {
  assertThrows(() => textExtract({ operation: "between", text: "foo", end: "]" }),
    e => assert(e.message.includes("start"), `msg=${e.message}`));
});

test("[175-I5] text_extract between missing end throws", () => {
  assertThrows(() => textExtract({ operation: "between", text: "foo", start: "[" }),
    e => assert(e.message.includes("end"), `msg=${e.message}`));
});

test("[175-I6] text_extract pattern missing pattern throws", () => {
  assertThrows(() => textExtract({ operation: "pattern", text: "hello" }),
    e => assert(e.message.includes("pattern"), `msg=${e.message}`));
});

test("[175-I7] text_extract pattern invalid regex throws", () => {
  assertThrows(() => textExtract({ operation: "pattern", text: "hello", pattern: "(" }),
    e => assert(e.message.toLowerCase().includes("invalid") || e.message.toLowerCase().includes("regex") || e.message.includes("("), `msg=${e.message}`));
});

test("[175-I8] text_extract lines invalid regex throws", () => {
  assertThrows(() => textExtract({ operation: "lines", text: "hello", pattern: "(?<bad", is_regex: true }),
    e => assert(e.message.toLowerCase().includes("invalid") || e.message.includes("regex"), `msg=${e.message}`));
});

// ============================================================
// Section J: text_extract — Extreme (stress / performance)
// ============================================================

test("[175-J1] text_extract emails 500-email haystack", () => {
  const emails = [];
  for (let i = 0; i < 500; i++) emails.push(`user${i}@example${i % 10}.com`);
  const text = emails.join(" ");
  const r = textExtract({ operation: "emails", text });
  assert(r.count === 500, `count=${r.count}`);
});

test("[175-J2] text_extract numbers 1000-number haystack", () => {
  const nums = Array.from({ length: 1000 }, (_, i) => i * 1.5).join(" ");
  const r = textExtract({ operation: "numbers", text: nums });
  assert(r.count >= 1000, `count=${r.count}`);
});

test("[175-J3] text_extract lines 5000 lines, pattern on 100", () => {
  const lines = Array.from({ length: 5000 }, (_, i) => i % 50 === 0 ? "TARGET line" : `line ${i}`).join("\n");
  const r = textExtract({ operation: "lines", text: lines, pattern: "TARGET", is_regex: false });
  assert(r.matchCount === 100, `matchCount=${r.matchCount}`);
});

test("[175-J4] text_extract between 200 spans in loop", () => {
  const text = Array.from({ length: 200 }, (_, i) => `<item>${i}</item>`).join(" ");
  const r = textExtract({ operation: "between", text, start: "<item>", end: "</item>" });
  assert(r.count === 200, `count=${r.count}`);
  assert(r.matches[0].content === "0", `first=${r.matches[0].content}`);
});

test("[175-J5] text_extract words large text performance", () => {
  // ~50KB of repeated words
  const words = ["apple","banana","cherry","date","elderberry"];
  const text = Array.from({ length: 10000 }, (_, i) => words[i % words.length]).join(" ");
  const r = textExtract({ operation: "words", text, top_n: 5 });
  assert(r.uniqueWords === 5, `unique=${r.uniqueWords}`);
  assert(r.topWords.length === 5, `top=${r.topWords.length}`);
  // Each word appears 2000 times
  assert(r.topWords.every(w => w.count === 2000), `counts=${r.topWords.map(w=>w.count)}`);
});

console.error("[175] date_calc + text_extract section done.");
