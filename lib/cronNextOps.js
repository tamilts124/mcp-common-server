"use strict";
// ── Cron expression parser + next-N scheduler ─────────────────────────────────
// Zero npm dependencies. Supports 5-field (min hour dom month dow) and 6-field
// (sec min hour dom month dow) expressions plus common @aliases.
// Uses UTC arithmetic throughout to avoid DST ambiguity.

const { ToolError } = require("./errors");

// ── Alias → canonical form ─────────────────────────────────────────────────
const ALIASES = {
  "@yearly":   "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly":  "0 0 1 * *",
  "@weekly":   "0 0 * * 0",
  "@daily":    "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly":   "0 * * * *",
};

// ── Field metadata ─────────────────────────────────────────────────────────────
const FIELDS_5 = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour",   min: 0, max: 23 },
  { name: "dom",    min: 1, max: 31 },
  { name: "month",  min: 1, max: 12 },
  { name: "dow",    min: 0, max:  7 },
];
const FIELDS_6 = [
  { name: "second", min: 0, max: 59 },
  ...FIELDS_5,
];

// Symbolic names for month/dow fields
const MONTH_SYM = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
const DOW_SYM   = { sun:0,mon:1,tue:2,wed:3,thu:4,fri:5,sat:6 };
// 7 → 0 alias (some tools use 7 for Sunday)
function resolveDow(val) { return val === 7 ? 0 : val; }

// ── Single-value resolver ──────────────────────────────────────────────────────
function resolveVal(tok, min, max, sym) {
  const lower = String(tok).toLowerCase();
  if (sym && sym[lower] !== undefined) return sym[lower];
  const n = Number(tok);
  if (!Number.isInteger(n) || n < min || n > max)
    throw new ToolError(
      `cron_next: value '${tok}' out of range ${min}–${max}`, -32602
    );
  return n;
}

// ── Parse a single cron field → sorted number[] ───────────────────────────────
function parseField(str, { name, min, max }) {
  const sym = name === "month" ? MONTH_SYM : name === "dow" ? DOW_SYM : null;
  const set = new Set();

  for (const part of str.split(",")) {
    // Extract optional /step
    let step = 1;
    let rangePart = part;
    const slashIdx = part.indexOf("/");
    if (slashIdx !== -1) {
      rangePart = part.slice(0, slashIdx);
      step = Number(part.slice(slashIdx + 1));
      if (!Number.isInteger(step) || step < 1 || step > (max - min + 1))
        throw new ToolError(
          `cron_next: invalid step '${part.slice(slashIdx + 1)}' in field '${name}'`, -32602
        );
    }

    if (rangePart === "*" || rangePart === "?") {
      // Wildcard: every value in [min, max] stepping by `step`
      for (let v = min; v <= max; v += step) set.add(v);
    } else if (rangePart.includes("-")) {
      const dashIdx = rangePart.indexOf("-");
      let from = resolveVal(rangePart.slice(0, dashIdx), min, max, sym);
      let to   = resolveVal(rangePart.slice(dashIdx + 1), min, max, sym);
      if (name === "dow") { from = resolveDow(from); to = resolveDow(to); }
      if (from > to)
        throw new ToolError(
          `cron_next: invalid range '${rangePart}' in field '${name}' (start > end)`, -32602
        );
      for (let v = from; v <= to; v += step) set.add(v);
    } else {
      // Single value, possibly with /step (means "from this value, every step, up to max")
      let start = resolveVal(rangePart, min, max, sym);
      if (name === "dow") start = resolveDow(start);
      if (slashIdx !== -1) {
        for (let v = start; v <= max; v += step) set.add(v);
      } else {
        set.add(start);
      }
    }
  }

  // DOW alias: 7 is a valid synonym for Sunday (0)
  if (name === "dow" && set.has(7)) { set.delete(7); set.add(0); }
  if (set.size === 0)
    throw new ToolError(`cron_next: field '${name}' resolved to empty set from '${str}'`, -32602);

  return Array.from(set).sort((a, b) => a - b);
}

// ── Parse a full cron expression ──────────────────────────────────────────────
function parseExpression(expr) {
  let normalized = String(expr).trim();
  const aliasKey = normalized.toLowerCase();
  if (ALIASES[aliasKey]) normalized = ALIASES[aliasKey];

  const parts = normalized.split(/\s+/);
  let fieldDefs, hasSec;

  if (parts.length === 5) {
    fieldDefs = FIELDS_5;
    hasSec = false;
  } else if (parts.length === 6) {
    fieldDefs = FIELDS_6;
    hasSec = true;
  } else {
    throw new ToolError(
      `cron_next: expected 5 or 6 space-separated fields, got ${parts.length}: '${expr}'`,
      -32602
    );
  }

  const parsed = {};
  for (let i = 0; i < fieldDefs.length; i++) {
    parsed[fieldDefs[i].name] = parseField(parts[i], fieldDefs[i]);
  }
  if (!hasSec) parsed.second = [0]; // 5-field → seconds always 0

  // Track whether dom/dow were wildcards (for OR vs AND semantics)
  const domRaw = hasSec ? parts[3] : parts[2];
  const dowRaw = hasSec ? parts[5] : parts[4];
  const domIsWild = domRaw === "*" || domRaw === "?";
  const dowIsWild = dowRaw === "*" || dowRaw === "?";

  return { parsed, hasSec, domIsWild, dowIsWild };
}

// ── Smart-skip helper: next value ≥ cur in sorted set, or null ────────────────
function nextGeq(arr, val) {
  for (const v of arr) if (v >= val) return v;
  return null;
}

// ── Advance to next matching second in same minute, or first sec of next min ──
function advanceSec(parsed, yr, mo, d, h, mn, s) {
  const nextS = nextGeq(parsed.second, s);
  if (nextS !== null)
    return new Date(Date.UTC(yr, mo - 1, d, h, mn, nextS));
  // Overflow to next matching minute
  return advanceMin(parsed, yr, mo, d, h, mn + 1);
}

function advanceMin(parsed, yr, mo, d, h, mn) {
  const nextMn = nextGeq(parsed.minute, mn);
  if (nextMn !== null)
    return new Date(Date.UTC(yr, mo - 1, d, h, nextMn, parsed.second[0]));
  return advanceHour(parsed, yr, mo, d, h + 1);
}

function advanceHour(parsed, yr, mo, d, h) {
  const nextH = nextGeq(parsed.hour, h);
  if (nextH !== null)
    return new Date(Date.UTC(yr, mo - 1, d, nextH, parsed.minute[0], parsed.second[0]));
  return new Date(Date.UTC(yr, mo - 1, d + 1, parsed.hour[0], parsed.minute[0], parsed.second[0]));
}

// ── Compute next N occurrences ─────────────────────────────────────────────────
/**
 * @param {string} expr   Cron expression string
 * @param {object} opts
 * @param {number} [opts.count=5]    1–100
 * @param {string} [opts.from]       ISO-8601 start timestamp (default: now)
 * @param {"iso"|"unix"} [opts.format="iso"]
 */
function nextOccurrences(expr, { count = 5, from, format = "iso" } = {}) {
  count = Number(count);
  if (!Number.isInteger(count) || count < 1 || count > 100)
    throw new ToolError("cron_next: 'count' must be an integer between 1 and 100.", -32602);

  if (format !== "iso" && format !== "unix")
    throw new ToolError("cron_next: 'format' must be 'iso' or 'unix'.", -32602);

  let startMs;
  if (from != null) {
    startMs = Date.parse(from);
    if (Number.isNaN(startMs))
      throw new ToolError(`cron_next: 'from' is not a valid ISO-8601 date: '${from}'`, -32602);
  } else {
    startMs = Date.now();
  }

  const { parsed, domIsWild, dowIsWild } = parseExpression(expr);
  const { second: secs, minute: mins, hour: hours, dom, month: months, dow } = parsed;

  // Start searching from the next second boundary after `startMs`
  let startDate = new Date(startMs);
  startDate.setUTCMilliseconds(0);
  let cur = new Date(startDate.getTime() + 1000); // advance by 1 second

  const results = [];
  const MAX_ITER = 20000; // sufficient for any reasonable expression
  let iter = 0;

  while (results.length < count && iter < MAX_ITER) {
    iter++;
    const yr = cur.getUTCFullYear();
    const mo = cur.getUTCMonth() + 1; // 1-12
    const d  = cur.getUTCDate();      // 1-31
    const h  = cur.getUTCHours();
    const mn = cur.getUTCMinutes();
    const s  = cur.getUTCSeconds();
    const wd = cur.getUTCDay();       // 0-6 (Sun=0)

    // ── Month check ───────────────────────────────────────────────────────
    const nextMo = nextGeq(months, mo);
    if (nextMo === null) {
      // Wrap to January of next year
      cur = new Date(Date.UTC(yr + 1, months[0] - 1, 1, hours[0], mins[0], secs[0]));
      continue;
    }
    if (nextMo > mo) {
      cur = new Date(Date.UTC(yr, nextMo - 1, 1, hours[0], mins[0], secs[0]));
      continue;
    }

    // ── DOM / DOW check (OR semantics when both are non-wildcard) ─────────
    const domOk = dom.includes(d);
    const dowOk = dow.includes(wd);
    let dayOk;
    if (domIsWild && dowIsWild) {
      dayOk = true; // both wildcards: always true
    } else if (domIsWild) {
      dayOk = dowOk; // dom is *, only dow matters
    } else if (dowIsWild) {
      dayOk = domOk; // dow is *, only dom matters
    } else {
      dayOk = domOk || dowOk; // standard Vixie OR semantics
    }

    if (!dayOk) {
      // Advance to next day (don't know which it is — let next iteration sort it out)
      cur = new Date(Date.UTC(yr, mo - 1, d + 1, hours[0], mins[0], secs[0]));
      continue;
    }

    // ── Hour check ────────────────────────────────────────────────────────
    const nextH = nextGeq(hours, h);
    if (nextH === null) {
      cur = new Date(Date.UTC(yr, mo - 1, d + 1, hours[0], mins[0], secs[0]));
      continue;
    }
    if (nextH > h) {
      cur = new Date(Date.UTC(yr, mo - 1, d, nextH, mins[0], secs[0]));
      continue;
    }

    // ── Minute check ──────────────────────────────────────────────────────
    const nextMn = nextGeq(mins, mn);
    if (nextMn === null) {
      cur = advanceHour(parsed, yr, mo, d, h + 1);
      continue;
    }
    if (nextMn > mn) {
      cur = new Date(Date.UTC(yr, mo - 1, d, h, nextMn, secs[0]));
      continue;
    }

    // ── Second check ──────────────────────────────────────────────────────
    const nextS = nextGeq(secs, s);
    if (nextS === null) {
      cur = advanceMin(parsed, yr, mo, d, h, mn + 1);
      continue;
    }
    if (nextS > s) {
      cur = new Date(Date.UTC(yr, mo - 1, d, h, mn, nextS));
      continue;
    }

    // ── Match! ────────────────────────────────────────────────────────────
    results.push(format === "unix" ? Math.floor(cur.getTime() / 1000) : cur.toISOString());

    // Advance past this second
    cur = advanceSec(parsed, yr, mo, d, h, mn, s + 1);
  }

  if (results.length < count)
    throw new ToolError(
      `cron_next: could not find ${count} occurrence(s) within search limit — ` +
        "check the expression or use a less restrictive one.",
      -32602
    );

  // Build a human-readable description of the fields
  const { parsed: p } = parseExpression(expr);
  return {
    expression: expr,
    count: results.length,
    from: new Date(startMs).toISOString(),
    format,
    schedule: results,
  };
}

module.exports = { nextOccurrences, parseExpression };
