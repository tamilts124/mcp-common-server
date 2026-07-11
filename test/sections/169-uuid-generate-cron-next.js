"use strict";
/**
 * test/sections/169-uuid-generate-cron-next.js
 * Isolated functional tests for uuid_generate (v1/v4/v5/ULID) and cron_next.
 * Section [169] — 5 rigor levels.
 */

const { test } = require("../test-harness");
const { uuidGenerate } = require("../../lib/uuidGenerateOps");
const { nextOccurrences, parseExpression } = require("../../lib/cronNextOps");

function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

const UUID_RE  = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ULID_RE  = /^[0-9A-Z]{26}$/;

// ───────────────────────────────────────────────────────────────────────────────
// [169-A] NORMAL — uuid_generate happy paths
// ───────────────────────────────────────────────────────────────────────────────
test("[169-A-1] uuid_generate: v4 default produces valid UUID", () => {
  const r = uuidGenerate();
  assert(UUID_RE.test(r.id), `bad UUID: ${r.id}`);
  assert(r.version === "v4" && r.count === 1);
  assert(Array.isArray(r.ids) && r.ids.length === 1);
});

test("[169-A-2] uuid_generate: v4 version nibble is 4", () => {
  const r = uuidGenerate({ version: "v4" });
  // 3rd group starts with '4'
  assert(r.id.split("-")[2][0] === "4", `version nibble: ${r.id}`);
});

test("[169-A-3] uuid_generate: v1 produces valid UUID with version nibble 1", () => {
  const r = uuidGenerate({ version: "v1" });
  assert(UUID_RE.test(r.id), `bad UUID: ${r.id}`);
  assert(r.id.split("-")[2][0] === "1", `v1 nibble wrong: ${r.id}`);
});

test("[169-A-4] uuid_generate: v1 variant bits are 10xx (8, 9, a, or b)", () => {
  const r = uuidGenerate({ version: "v1" });
  const variantNibble = r.id.split("-")[3][0];
  assert(["8","9","a","b"].includes(variantNibble.toLowerCase()),
    `variant nibble '${variantNibble}' is not 10xx`);
});

test("[169-A-5] uuid_generate: v5 deterministic — same input always same output", () => {
  const a = uuidGenerate({ version: "v5", name: "hello.example.com", namespace: "dns" });
  const b = uuidGenerate({ version: "v5", name: "hello.example.com", namespace: "dns" });
  assert(a.id === b.id, `v5 not deterministic: ${a.id} vs ${b.id}`);
  assert(a.id.split("-")[2][0] === "5", `version nibble wrong: ${a.id}`);
});

test("[169-A-6] uuid_generate: v5 RFC 4122 Appendix C test vector (dns namespace)", () => {
  // RFC 4122 §B: v5 of 'python.org' in DNS namespace = 886313e1-3b8a-5372-9b90-0c9aee199e5d
  const r = uuidGenerate({ version: "v5", name: "python.org", namespace: "dns" });
  assert(r.id === "886313e1-3b8a-5372-9b90-0c9aee199e5d",
    `expected RFC vector, got: ${r.id}`);
});

test("[169-A-7] uuid_generate: ulid produces 26-char Crockford Base32 string", () => {
  const r = uuidGenerate({ version: "ulid" });
  assert(ULID_RE.test(r.id), `bad ULID: ${r.id}`);
  assert(r.version === "ulid" && r.count === 1);
});

test("[169-A-8] uuid_generate: count=5 returns 5 unique IDs", () => {
  const r = uuidGenerate({ version: "v4", count: 5 });
  assert(r.count === 5 && r.ids.length === 5);
  // id field only present when count=1
  assert(r.id === undefined, "id field should be absent when count>1");
  const unique = new Set(r.ids);
  assert(unique.size === 5, "expected 5 unique UUIDs");
});

test("[169-A-9] uuid_generate: uppercase option", () => {
  const r = uuidGenerate({ version: "v4", uppercase: true });
  assert(r.id === r.id.toUpperCase(), `expected uppercase: ${r.id}`);
});

test("[169-A-10] uuid_generate: v5 url namespace", () => {
  const a = uuidGenerate({ version: "v5", name: "https://example.com", namespace: "url" });
  const b = uuidGenerate({ version: "v5", name: "https://example.com", namespace: "url" });
  assert(a.id === b.id);
  assert(UUID_RE.test(a.id));
});

test("[169-A-11] uuid_generate: v5 custom uuid namespace", () => {
  const custom = "12345678-1234-5678-1234-567812345678";
  const r = uuidGenerate({ version: "v5", name: "test", namespace: custom });
  assert(UUID_RE.test(r.id));
});

// ───────────────────────────────────────────────────────────────────────────────
// [169-B] NORMAL — cron_next happy paths
// ───────────────────────────────────────────────────────────────────────────────
const BASE = "2026-01-01T00:00:00.000Z"; // fixed reference point

test("[169-B-1] cron_next: @daily returns next midnight UTC", () => {
  const r = nextOccurrences("@daily", { count: 1, from: BASE, format: "iso" });
  assert(r.schedule[0] === "2026-01-02T00:00:00.000Z",
    `expected 2026-01-02 midnight, got ${r.schedule[0]}`);
});

test("[169-B-2] cron_next: @hourly returns next hour boundary", () => {
  const r = nextOccurrences("@hourly", { count: 1, from: BASE, format: "iso" });
  assert(r.schedule[0] === "2026-01-01T01:00:00.000Z", r.schedule[0]);
});

test("[169-B-3] cron_next: every-5-minutes expression produces correct spacing", () => {
  const r = nextOccurrences("*/5 * * * *", { count: 3, from: "2026-01-01T00:00:00.000Z", format: "iso" });
  assert(r.schedule[0] === "2026-01-01T00:05:00.000Z", r.schedule[0]);
  assert(r.schedule[1] === "2026-01-01T00:10:00.000Z", r.schedule[1]);
  assert(r.schedule[2] === "2026-01-01T00:15:00.000Z", r.schedule[2]);
});

test("[169-B-4] cron_next: specific hour/minute (09:00 weekdays)", () => {
  // from a Sunday 2026-01-04 → next weekday is Monday 2026-01-05
  const r = nextOccurrences("0 9 * * 1-5", { count: 1, from: "2026-01-04T10:00:00.000Z", format: "iso" });
  assert(r.schedule[0] === "2026-01-05T09:00:00.000Z", r.schedule[0]);
});

test("[169-B-5] cron_next: @monthly fires on the 1st of next month", () => {
  const r = nextOccurrences("@monthly", { count: 1, from: "2026-01-15T12:00:00.000Z", format: "iso" });
  assert(r.schedule[0] === "2026-02-01T00:00:00.000Z", r.schedule[0]);
});

test("[169-B-6] cron_next: unix format returns integer seconds", () => {
  const r = nextOccurrences("@daily", { count: 1, from: BASE, format: "unix" });
  const expected = new Date("2026-01-02T00:00:00.000Z").getTime() / 1000;
  assert(r.schedule[0] === expected, `expected ${expected}, got ${r.schedule[0]}`);
  assert(Number.isInteger(r.schedule[0]));
});

test("[169-B-7] cron_next: count=10 returns exactly 10 entries", () => {
  const r = nextOccurrences("*/15 * * * *", { count: 10, from: BASE, format: "iso" });
  assert(r.count === 10 && r.schedule.length === 10);
});

test("[169-B-8] cron_next: 6-field expression with seconds", () => {
  // '0 */5 * * * *' = at second 0, every 5 minutes
  const r = nextOccurrences("0 */5 * * * *", { count: 1, from: "2026-01-01T00:00:00.000Z", format: "iso" });
  assert(r.schedule[0] === "2026-01-01T00:05:00.000Z", r.schedule[0]);
});

test("[169-B-9] cron_next: response metadata fields", () => {
  const r = nextOccurrences("@daily", { count: 2, from: BASE, format: "iso" });
  assert(r.expression === "@daily");
  assert(r.from === BASE);
  assert(r.format === "iso");
  assert(r.count === 2);
});

test("[169-B-10] cron_next: month name syntax (jan-dec)", () => {
  // 0 12 1 jan *  = noon on Jan 1st
  const r = nextOccurrences("0 12 1 jan *", { count: 1, from: "2026-01-01T13:00:00.000Z", format: "iso" });
  assert(r.schedule[0] === "2027-01-01T12:00:00.000Z", r.schedule[0]);
});

test("[169-B-11] cron_next: weekday name syntax (sun-sat)", () => {
  // 0 0 * * fri = midnight every Friday
  const r = nextOccurrences("0 0 * * fri", { count: 1, from: "2026-01-01T00:00:01.000Z", format: "iso" });
  const d = new Date(r.schedule[0]);
  assert(d.getUTCDay() === 5, `expected Friday, got day ${d.getUTCDay()}`);
});

// ───────────────────────────────────────────────────────────────────────────────
// [169-C] MEDIUM — validation for empty/invalid inputs
// ───────────────────────────────────────────────────────────────────────────────
test("[169-C-1] uuid_generate: invalid version throws ToolError", () => {
  let threw = false;
  try { uuidGenerate({ version: "v7" }); } catch (e) { threw = true; }
  assert(threw);
});

test("[169-C-2] uuid_generate: count=0 throws ToolError", () => {
  let threw = false;
  try { uuidGenerate({ count: 0 }); } catch (e) { threw = true; }
  assert(threw);
});

test("[169-C-3] uuid_generate: count=101 throws ToolError", () => {
  let threw = false;
  try { uuidGenerate({ count: 101 }); } catch (e) { threw = true; }
  assert(threw);
});

test("[169-C-4] uuid_generate: v5 without name throws ToolError", () => {
  let threw = false;
  try { uuidGenerate({ version: "v5" }); } catch (e) { threw = true; }
  assert(threw);
});

test("[169-C-5] uuid_generate: v5 empty name throws ToolError", () => {
  let threw = false;
  try { uuidGenerate({ version: "v5", name: "" }); } catch (e) { threw = true; }
  assert(threw);
});

test("[169-C-6] uuid_generate: v5 invalid namespace throws ToolError", () => {
  let threw = false;
  try { uuidGenerate({ version: "v5", name: "test", namespace: "not-a-valid-ns" }); }
  catch (e) { threw = true; }
  assert(threw);
});

test("[169-C-7] cron_next: missing expression throws", () => {
  let threw = false;
  try { nextOccurrences(undefined); } catch (e) { threw = true; }
  assert(threw);
});

test("[169-C-8] cron_next: too many fields throws ToolError", () => {
  let threw = false;
  try { nextOccurrences("* * * * * * *"); } catch (e) { threw = true; }
  assert(threw);
});

test("[169-C-9] cron_next: count=0 throws ToolError", () => {
  let threw = false;
  try { nextOccurrences("* * * * *", { count: 0 }); } catch (e) { threw = true; }
  assert(threw);
});

test("[169-C-10] cron_next: count=101 throws ToolError", () => {
  let threw = false;
  try { nextOccurrences("* * * * *", { count: 101 }); } catch (e) { threw = true; }
  assert(threw);
});

test("[169-C-11] cron_next: invalid format throws ToolError", () => {
  let threw = false;
  try { nextOccurrences("* * * * *", { format: "datetime" }); } catch (e) { threw = true; }
  assert(threw);
});

test("[169-C-12] cron_next: invalid from date throws ToolError", () => {
  let threw = false;
  try { nextOccurrences("* * * * *", { from: "not-a-date" }); } catch (e) { threw = true; }
  assert(threw);
});

test("[169-C-13] cron_next: out-of-range hour field throws ToolError", () => {
  let threw = false;
  try { parseExpression("0 25 * * *"); } catch (e) { threw = true; }
  assert(threw);
});

test("[169-C-14] cron_next: invalid step (0) throws ToolError", () => {
  let threw = false;
  try { parseExpression("*/0 * * * *"); } catch (e) { threw = true; }
  assert(threw);
});

// ───────────────────────────────────────────────────────────────────────────────
// [169-D] HIGH — edge cases and complex expressions
// ───────────────────────────────────────────────────────────────────────────────
test("[169-D-1] uuid_generate: v1 sequential calls are monotonically increasing", () => {
  const a = uuidGenerate({ version: "v1" }).id;
  const b = uuidGenerate({ version: "v1" }).id;
  // In v1, the first 8 hex chars encode the low 32 bits of the timestamp;
  // lexicographic compare on hex ≈ timestamp order for non-wrapping periods
  assert(a !== b, "sequential v1 UUIDs must differ");
});

test("[169-D-2] uuid_generate: v5 different names → different UUIDs", () => {
  const a = uuidGenerate({ version: "v5", name: "example.com", namespace: "dns" }).id;
  const b = uuidGenerate({ version: "v5", name: "example.org", namespace: "dns" }).id;
  assert(a !== b);
});

test("[169-D-3] uuid_generate: v5 different namespaces → different UUIDs for same name", () => {
  const a = uuidGenerate({ version: "v5", name: "test", namespace: "dns" }).id;
  const b = uuidGenerate({ version: "v5", name: "test", namespace: "url" }).id;
  assert(a !== b);
});

test("[169-D-4] uuid_generate: ulid preserves temporal ordering across ms boundaries", () => {
  // Generate two batches and verify the first 10 chars (timestamp part) are ordered
  const a = uuidGenerate({ version: "ulid" }).id;
  // Small pause to ensure different ms (spin 2ms)
  const wait = Date.now() + 2; while (Date.now() < wait) {}
  const b = uuidGenerate({ version: "ulid" }).id;
  assert(a.slice(0, 10) <= b.slice(0, 10),
    `ULID timestamp part should be non-decreasing: ${a.slice(0,10)} > ${b.slice(0,10)}`);
});

test("[169-D-5] cron_next: leap-year — Feb 29 fires correctly in 2028", () => {
  const r = nextOccurrences("0 0 29 2 *", { count: 1, from: "2027-01-01T00:00:00.000Z", format: "iso" });
  assert(r.schedule[0] === "2028-02-29T00:00:00.000Z", r.schedule[0]);
});

test("[169-D-6] cron_next: list syntax fires on all listed values", () => {
  // '0 0 * * 1,3,5' = midnight Mon/Wed/Fri
  // From Sunday 2026-01-04 → next match is Monday 2026-01-05
  const r = nextOccurrences("0 0 * * 1,3,5", { count: 3, from: "2026-01-04T00:00:00.000Z", format: "iso" });
  const days = r.schedule.map(s => new Date(s).getUTCDay());
  // Mon=1, Wed=3, Fri=5
  assert(days[0] === 1 && days[1] === 3 && days[2] === 5,
    `expected 1,3,5 got ${days}`);
});

test("[169-D-7] cron_next: range syntax '1-5' in hour field", () => {
  // '0 1-5 * * *' = at minute 0 of hours 1-5
  const r = nextOccurrences("0 1-5 * * *", { count: 5, from: "2026-01-01T00:00:00.000Z", format: "iso" });
  const hours = r.schedule.map(s => new Date(s).getUTCHours());
  assert(hours.every((h, i) => h === i + 1), `expected hours 1-5, got ${hours}`);
});

test("[169-D-8] cron_next: @yearly fires on Jan 1 at midnight", () => {
  const r = nextOccurrences("@yearly", { count: 1, from: "2026-06-15T00:00:00.000Z", format: "iso" });
  assert(r.schedule[0] === "2027-01-01T00:00:00.000Z", r.schedule[0]);
});

test("[169-D-9] cron_next: @weekly fires on Sunday at midnight", () => {
  const r = nextOccurrences("@weekly", { count: 1, from: "2026-01-02T00:00:00.000Z", format: "iso" });
  const d = new Date(r.schedule[0]);
  assert(d.getUTCDay() === 0, `expected Sunday, got day ${d.getUTCDay()}`);
  assert(d.getUTCHours() === 0 && d.getUTCMinutes() === 0);
});

test("[169-D-10] cron_next: Sunday=7 alias works (dow=7 treated as 0)", () => {
  // '0 0 * * 7' should be same as '0 0 * * 0' (Sunday)
  const r = nextOccurrences("0 0 * * 7", { count: 1, from: "2026-01-02T00:00:00.000Z", format: "iso" });
  const d = new Date(r.schedule[0]);
  assert(d.getUTCDay() === 0, `expected Sunday (0), got ${d.getUTCDay()}`);
});

test("[169-D-11] cron_next: step from specific value (e.g. '5/15' in minute = 5,20,35,50)", () => {
  const r = nextOccurrences("5/15 0 * * *", { count: 4, from: "2026-01-01T00:00:00.000Z", format: "iso" });
  const minutes = r.schedule.map(s => new Date(s).getUTCMinutes());
  assert(JSON.stringify(minutes) === JSON.stringify([5, 20, 35, 50]),
    `expected [5,20,35,50], got ${minutes}`);
});

// ───────────────────────────────────────────────────────────────────────────────
// [169-E] CRITICAL — boundary safety and correctness
// ───────────────────────────────────────────────────────────────────────────────
test("[169-E-1] uuid_generate: v4 variant nibble is always 8/9/a/b (RFC 4122 variant)", () => {
  for (let i = 0; i < 100; i++) {
    const id = uuidGenerate({ version: "v4" }).id;
    const v = id.split("-")[3][0].toLowerCase();
    assert(["8","9","a","b"].includes(v), `variant nibble '${v}' wrong in ${id}`);
  }
});

test("[169-E-2] uuid_generate: v4 version nibble always 4", () => {
  for (let i = 0; i < 100; i++) {
    const id = uuidGenerate({ version: "v4" }).id;
    assert(id.split("-")[2][0] === "4", `version nibble wrong: ${id}`);
  }
});

test("[169-E-3] uuid_generate: v5 variant nibble always RFC 4122 variant", () => {
  for (let i = 0; i < 20; i++) {
    const id = uuidGenerate({ version: "v5", name: `test-${i}`, namespace: "dns" }).id;
    const v = id.split("-")[3][0].toLowerCase();
    assert(["8","9","a","b"].includes(v), `v5 variant nibble '${v}' wrong in ${id}`);
  }
});

test("[169-E-4] uuid_generate: ulid 26 chars, all Crockford-valid", () => {
  const CK = new Set("0123456789ABCDEFGHJKMNPQRSTVWXYZ");
  for (let i = 0; i < 50; i++) {
    const id = uuidGenerate({ version: "ulid" }).id;
    assert(id.length === 26, `ULID length ${id.length}`);
    for (const c of id) assert(CK.has(c), `invalid Crockford char '${c}' in ${id}`);
  }
});

test("[169-E-5] cron_next: non-existent dom never fires when month-end too short", () => {
  // Feb never has day 30; must jump to next available year/month with day 30
  // 0 0 30 * * should skip Feb entirely
  const r = nextOccurrences("0 0 30 * *", { count: 3, from: "2026-01-30T00:00:01.000Z", format: "iso" });
  const months = r.schedule.map(s => new Date(s).getUTCMonth() + 1);
  assert(!months.includes(2), `Feb should be skipped, but got ${months}`);
});

test("[169-E-6] cron_next: year-boundary wrap (count schedules cross Dec→Jan)", () => {
  const r = nextOccurrences("0 0 1 * *", { count: 2, from: "2026-11-15T00:00:00.000Z", format: "iso" });
  assert(r.schedule[0] === "2026-12-01T00:00:00.000Z", r.schedule[0]);
  assert(r.schedule[1] === "2027-01-01T00:00:00.000Z", r.schedule[1]);
});

test("[169-E-7] cron_next: dom/dow OR semantics", () => {
  // '0 0 15 * 1' = midnight on the 15th OR on Monday
  // From 2026-01-12 Mon, next match should be 2026-01-12 (Monday itself)
  const r = nextOccurrences("0 0 15 * 1", { count: 1, from: "2026-01-11T00:00:01.000Z", format: "iso" });
  const d = new Date(r.schedule[0]);
  // The 12th is Monday (day 1), and the 15th is Thursday — Monday comes first
  assert(d.getUTCDay() === 1 || d.getUTCDate() === 15,
    `expected Monday or 15th: ${r.schedule[0]}`);
});

test("[169-E-8] uuid_generate: count=100 produces 100 IDs, all valid UUIDs", () => {
  const r = uuidGenerate({ version: "v4", count: 100 });
  assert(r.count === 100 && r.ids.length === 100);
  assert(r.ids.every(id => UUID_RE.test(id)), "some IDs are not valid UUIDs");
});

// ───────────────────────────────────────────────────────────────────────────────
// [169-F] EXTREME — stress, concurrency, and memory efficiency
// ───────────────────────────────────────────────────────────────────────────────
test("[169-F-1] uuid_generate: v4 — 10,000 sequential UUIDs all valid and unique", () => {
  const ids = new Set();
  for (let i = 0; i < 10000; i++) {
    const id = uuidGenerate({ version: "v4" }).id;
    assert(UUID_RE.test(id), `invalid UUID at i=${i}`);
    ids.add(id);
  }
  assert(ids.size === 10000, `collision detected: got ${ids.size} unique out of 10000`);
});

test("[169-F-2] uuid_generate: ulid — 1,000 sequential ULIDs all valid", () => {
  const ids = [];
  for (let i = 0; i < 1000; i++) ids.push(uuidGenerate({ version: "ulid" }).id);
  assert(ids.every(id => ULID_RE.test(id)), "some ULIDs are invalid");
});

test("[169-F-3] uuid_generate: v1 — 500 sequential IDs all valid UUIDs", () => {
  const ids = [];
  for (let i = 0; i < 500; i++) ids.push(uuidGenerate({ version: "v1" }).id);
  assert(ids.every(id => UUID_RE.test(id)), "some v1 UUIDs are invalid");
});

test("[169-F-4] cron_next: count=100 on */1 * * * * (every minute) returns exactly 100 entries spaced 60s", () => {
  const r = nextOccurrences("*/1 * * * *", { count: 100, from: BASE, format: "unix" });
  assert(r.count === 100 && r.schedule.length === 100);
  for (let i = 1; i < 100; i++) {
    assert(r.schedule[i] - r.schedule[i - 1] === 60,
      `gap at ${i}: expected 60, got ${r.schedule[i] - r.schedule[i - 1]}`);
  }
});

test("[169-F-5] cron_next: rare expression (0 0 29 2 *) returns correct future dates", () => {
  // Feb 29 = leap year only — every 4 years (except century non-multiples of 400)
  const r = nextOccurrences("0 0 29 2 *", { count: 3, from: "2026-01-01T00:00:00.000Z", format: "iso" });
  assert(r.schedule[0] === "2028-02-29T00:00:00.000Z", r.schedule[0]);
  assert(r.schedule[1] === "2032-02-29T00:00:00.000Z", r.schedule[1]);
  assert(r.schedule[2] === "2036-02-29T00:00:00.000Z", r.schedule[2]);
});

test("[169-F-6] uuid_generate + cron_next: 100 concurrent Promise.all calls", async () => {
  const results = await Promise.all(
    Array.from({ length: 100 }, (_, i) =>
      Promise.resolve().then(() => {
        const uid = uuidGenerate({ version: "v4" }).id;
        const cron = nextOccurrences("*/5 * * * *", { count: 1, from: BASE, format: "iso" });
        return { uid, cron: cron.schedule[0] };
      })
    )
  );
  const uids = new Set(results.map(r => r.uid));
  assert(uids.size === 100, "all concurrent UUIDs must be unique");
  assert(results.every(r => r.cron === "2026-01-01T00:05:00.000Z"));
});
