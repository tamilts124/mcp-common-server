"use strict";
// ── DATE CALC OPS ──────────────────────────────────────────────────────────────
// Zero-dependency date/time arithmetic, formatting, parsing, and timezone
// conversion — pure Node.js built-in Date + Intl APIs, no npm packages.

const { ToolError } = require("./errors");

// ── Constants ────────────────────────────────────────────────────────────────

const MONTHS_LONG  = ["January","February","March","April","May","June",
                      "July","August","September","October","November","December"];
const MONTHS_SHORT = ["Jan","Feb","Mar","Apr","May","Jun",
                      "Jul","Aug","Sep","Oct","Nov","Dec"];
const DAYS_LONG    = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const DAYS_SHORT   = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];

const UNIT_MS = {
  week: 7*86400000, day: 86400000, hour: 3600000,
  minute: 60000, second: 1000, millisecond: 1,
};
const VALID_UNITS = ["year","month","week","day","hour","minute","second","millisecond"];
const VALID_OPS   = ["now","parse","format","add","subtract","diff","start_of","end_of","convert_tz","is_valid"];

// ── Helpers ──────────────────────────────────────────────────────────────────

function pad(n, len = 2) { return String(n).padStart(len, "0"); }

/** Parse date input: ISO string | unix number | "now" | null => Date. */
function parseInput(date) {
  if (date == null || date === "now") return new Date();
  if (typeof date === "number")
    return new Date(date > 1e10 ? date : date * 1000);
  if (typeof date === "string") {
    const t = date.trim();
    if (/^\d{9,13}$/.test(t)) {
      const n = Number(t);
      return new Date(t.length >= 13 ? n : n * 1000);
    }
    const d = new Date(t);
    if (isNaN(d.getTime()))
      throw new ToolError(`date_calc: Cannot parse date '${date}'.`, -32602);
    return d;
  }
  throw new ToolError("date_calc: 'date' must be an ISO string, Unix timestamp, 'now', or null.", -32602);
}

/** Break a Date into local components for a given IANA timezone. */
function getPartsInTz(date, tz) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz || "UTC",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
  const map = {};
  for (const { type, value } of dtf.formatToParts(date)) map[type] = value;
  if (map.hour === "24") map.hour = "00"; // ICU midnight edge-case guard
  return {
    year:        parseInt(map.year,   10),
    month:       parseInt(map.month,  10),
    day:         parseInt(map.day,    10),
    hour:        parseInt(map.hour,   10),
    minute:      parseInt(map.minute, 10),
    second:      parseInt(map.second, 10),
    millisecond: ((date.getTime() % 1000) + 1000) % 1000,
  };
}

/** UTC offset in minutes for a date in an IANA timezone (+east). */
function getTzOffsetMins(date, tz) {
  if (!tz || tz === "UTC") return 0;
  const p = getPartsInTz(date, tz);
  const pseudo = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((pseudo - date.getTime()) / 60000);
}

function fmtOffset(mins) {
  const sign = mins >= 0 ? "+" : "-";
  const abs  = Math.abs(mins);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Validate an IANA timezone string. */
function assertTz(tz, label) {
  try { new Intl.DateTimeFormat("en", { timeZone: tz }); }
  catch { throw new ToolError(`date_calc ${label}: Unknown timezone '${tz}'.`, -32602); }
}

// ── Token formatter (single-pass, no double-replacement) ─────────────────────

const TOKEN_RE = /YYYY|YY|MMMM|MMM|MM|M|DD|D|HH|H|hh|h|mm|ss|SSS|dddd|ddd|A|a|Z|X|x/g;

function formatDate(date, fmt, tz) {
  const p       = getPartsInTz(date, tz);
  const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  const offMins = getTzOffsetMins(date, tz);
  const h12     = p.hour % 12 || 12;
  const isAM    = p.hour < 12;
  const unix    = Math.floor(date.getTime() / 1000);

  return fmt.replace(TOKEN_RE, tok => {
    switch (tok) {
      case "YYYY": return pad(p.year, 4);
      case "YY":   return pad(p.year % 100, 2);
      case "MMMM": return MONTHS_LONG[p.month - 1];
      case "MMM":  return MONTHS_SHORT[p.month - 1];
      case "MM":   return pad(p.month);
      case "M":    return String(p.month);
      case "DD":   return pad(p.day);
      case "D":    return String(p.day);
      case "HH":   return pad(p.hour);
      case "H":    return String(p.hour);
      case "hh":   return pad(h12);
      case "h":    return String(h12);
      case "mm":   return pad(p.minute);
      case "ss":   return pad(p.second);
      case "SSS":  return pad(p.millisecond, 3);
      case "dddd": return DAYS_LONG[weekday];
      case "ddd":  return DAYS_SHORT[weekday];
      case "A":    return isAM ? "AM" : "PM";
      case "a":    return isAM ? "am" : "pm";
      case "Z":    return fmtOffset(offMins);
      case "X":    return String(unix);
      case "x":    return String(date.getTime());
      default:     return tok;
    }
  });
}

function toIsoLocal(date, tz) {
  const p   = getPartsInTz(date, tz);
  const off = fmtOffset(getTzOffsetMins(date, tz));
  return `${pad(p.year,4)}-${pad(p.month)}-${pad(p.day)}` +
         `T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}.${pad(p.millisecond,3)}${off}`;
}

function buildResult(date, tz) {
  const p       = getPartsInTz(date, tz);
  const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  return {
    iso:       date.toISOString(),
    isoLocal:  toIsoLocal(date, tz),
    unix:      Math.floor(date.getTime() / 1000),
    unixMs:    date.getTime(),
    timezone:  tz || "UTC",
    utcOffset: fmtOffset(getTzOffsetMins(date, tz)),
    components: {
      year: p.year, month: p.month, day: p.day,
      hour: p.hour, minute: p.minute, second: p.second,
      millisecond: p.millisecond,
      weekday:      DAYS_LONG[weekday],
      weekdayShort: DAYS_SHORT[weekday],
    },
  };
}

// ── Date arithmetic ───────────────────────────────────────────────────────────

function addDate(date, amount, unit, tz) {
  if (unit === "year" || unit === "month") {
    const p = getPartsInTz(date, tz);
    let { year, month, day, hour, minute, second, millisecond } = p;
    if (unit === "year")  year  += amount;
    else                  month += amount;
    while (month > 12) { month -= 12; year++; }
    while (month < 1)  { month += 12; year--; }
    const maxDay = new Date(year, month, 0).getDate();
    if (day > maxDay) day = maxDay;
    const offMins = getTzOffsetMins(date, tz);
    return new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond) - offMins * 60000);
  }
  if (!UNIT_MS[unit])
    throw new ToolError(`date_calc add/subtract: Unknown unit '${unit}'. Valid: ${VALID_UNITS.join(", ")}.`, -32602);
  return new Date(date.getTime() + amount * UNIT_MS[unit]);
}

function diffDates(d1, d2, unit) {
  if (unit === "year") {
    return (d2.getUTCFullYear() - d1.getUTCFullYear())
         + (d2.getUTCMonth() - d1.getUTCMonth()) / 12;
  }
  if (unit === "month") {
    return (d2.getUTCFullYear() - d1.getUTCFullYear()) * 12
         + (d2.getUTCMonth() - d1.getUTCMonth());
  }
  if (!UNIT_MS[unit])
    throw new ToolError(`date_calc diff: Unknown unit '${unit}'. Valid: ${VALID_UNITS.join(", ")}.`, -32602);
  return (d2.getTime() - d1.getTime()) / UNIT_MS[unit];
}

function startOf(date, unit, tz) {
  const p = getPartsInTz(date, tz);
  let { year, month, day, hour, minute, second } = p;
  switch (unit) {
    case "year":   month = 1;  day = 1; hour = 0; minute = 0; second = 0; break;
    case "month":  day = 1;   hour = 0; minute = 0; second = 0; break;
    case "week": {
      const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
      day -= (dow === 0 ? 6 : dow - 1); // Monday = start
      hour = 0; minute = 0; second = 0; break;
    }
    case "day":    hour = 0; minute = 0; second = 0; break;
    case "hour":   minute = 0; second = 0; break;
    case "minute": second = 0; break;
    default: throw new ToolError(`date_calc start_of: Unknown unit '${unit}'.`, -32602);
  }
  const offMins = getTzOffsetMins(date, tz);
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second, 0) - offMins * 60000);
}

function endOf(date, unit, tz) {
  const p = getPartsInTz(date, tz);
  let { year, month, day, hour, minute, second } = p;
  switch (unit) {
    case "year":  month = 12; day = 31; hour = 23; minute = 59; second = 59; break;
    case "month": {
      day = new Date(year, month, 0).getDate();
      hour = 23; minute = 59; second = 59; break;
    }
    case "week": {
      const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
      day += (dow === 0 ? 0 : 7 - dow); // Sunday = end
      hour = 23; minute = 59; second = 59; break;
    }
    case "day":    hour = 23; minute = 59; second = 59; break;
    case "hour":   minute = 59; second = 59; break;
    case "minute": second = 59; break;
    default: throw new ToolError(`date_calc end_of: Unknown unit '${unit}'.`, -32602);
  }
  const offMins = getTzOffsetMins(date, tz);
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second, 999) - offMins * 60000);
}

// ── Main entry point ──────────────────────────────────────────────────────────

function dateCalc(args) {
  const { operation } = args;
  if (!operation)
    throw new ToolError("date_calc: 'operation' is required.", -32602);
  if (!VALID_OPS.includes(operation))
    throw new ToolError(`date_calc: Unknown operation '${operation}'. Valid: ${VALID_OPS.join(", ")}.`, -32602);

  const tz = args.timezone || "UTC";
  assertTz(tz, "timezone");

  switch (operation) {

    case "is_valid": {
      if (args.date == null)
        throw new ToolError("date_calc is_valid: 'date' is required.", -32602);
      let valid = true, reason = null;
      try {
        const s = String(args.date).trim();
        const d = /^\d{9,13}$/.test(s)
          ? new Date(s.length >= 13 ? Number(s) : Number(s) * 1000)
          : new Date(args.date);
        if (isNaN(d.getTime())) { valid = false; reason = "Not a valid date"; }
      } catch (e) { valid = false; reason = e.message; }
      return { operation, input: args.date, valid, reason };
    }

    case "now": {
      const d   = new Date();
      const out = buildResult(d, tz);
      if (args.format) out.formatted = formatDate(d, args.format, tz);
      if (args.locale) {
        try { out.localeString = new Intl.DateTimeFormat(args.locale, { timeZone: tz, dateStyle: "full", timeStyle: "long" }).format(d); }
        catch (e) { out.localeError = e.message; }
      }
      return { operation, ...out };
    }

    case "parse": {
      if (args.date == null)
        throw new ToolError("date_calc parse: 'date' is required.", -32602);
      const d   = parseInput(args.date);
      const out = buildResult(d, tz);
      if (args.format) out.formatted = formatDate(d, args.format, tz);
      if (args.locale) {
        try { out.localeString = new Intl.DateTimeFormat(args.locale, { timeZone: tz, dateStyle: "full", timeStyle: "long" }).format(d); }
        catch (e) { out.localeError = e.message; }
      }
      return { operation, input: args.date, ...out };
    }

    case "format": {
      if (!args.format)
        throw new ToolError("date_calc format: 'format' is required.", -32602);
      const d = parseInput(args.date);
      return {
        operation, input: args.date || "now",
        formatted: formatDate(d, args.format, tz),
        format: args.format, timezone: tz,
        unix: Math.floor(d.getTime() / 1000), iso: d.toISOString(),
      };
    }

    case "add":
    case "subtract": {
      if (args.amount == null)
        throw new ToolError(`date_calc ${operation}: 'amount' is required.`, -32602);
      if (!args.unit)
        throw new ToolError(`date_calc ${operation}: 'unit' is required.`, -32602);
      const amt = Number(args.amount);
      if (!isFinite(amt))
        throw new ToolError(`date_calc ${operation}: 'amount' must be a finite number.`, -32602);
      const delta  = operation === "subtract" ? -amt : amt;
      const d      = parseInput(args.date);
      const result = addDate(d, delta, args.unit, tz);
      const out    = buildResult(result, tz);
      if (args.format) out.formatted = formatDate(result, args.format, tz);
      return { operation, input: args.date || "now", amount: delta, unit: args.unit, ...out };
    }

    case "diff": {
      if (args.date == null || args.date2 == null)
        throw new ToolError("date_calc diff: 'date' and 'date2' are required.", -32602);
      const d1   = parseInput(args.date);
      const d2   = parseInput(args.date2);
      const unit = args.unit || "day";
      const raw  = diffDates(d1, d2, unit);
      return {
        operation, from: d1.toISOString(), to: d2.toISOString(), unit,
        diff: raw, diffRounded: Math.round(raw), diffTrunc: Math.trunc(raw),
        absoluteMs: Math.abs(d2.getTime() - d1.getTime()),
      };
    }

    case "start_of": {
      if (!args.unit)
        throw new ToolError("date_calc start_of: 'unit' is required.", -32602);
      const d      = parseInput(args.date);
      const result = startOf(d, args.unit, tz);
      const out    = buildResult(result, tz);
      if (args.format) out.formatted = formatDate(result, args.format, tz);
      return { operation, input: args.date || "now", unit: args.unit, ...out };
    }

    case "end_of": {
      if (!args.unit)
        throw new ToolError("date_calc end_of: 'unit' is required.", -32602);
      const d      = parseInput(args.date);
      const result = endOf(d, args.unit, tz);
      const out    = buildResult(result, tz);
      if (args.format) out.formatted = formatDate(result, args.format, tz);
      return { operation, input: args.date || "now", unit: args.unit, ...out };
    }

    case "convert_tz": {
      if (!args.to_timezone)
        throw new ToolError("date_calc convert_tz: 'to_timezone' is required.", -32602);
      assertTz(args.to_timezone, "convert_tz to_timezone");
      const d   = parseInput(args.date);
      const out = buildResult(d, args.to_timezone);
      if (args.format) out.formatted = formatDate(d, args.format, args.to_timezone);
      if (args.locale) {
        try { out.localeString = new Intl.DateTimeFormat(args.locale, { timeZone: args.to_timezone, dateStyle: "full", timeStyle: "long" }).format(d); }
        catch (e) { out.localeError = e.message; }
      }
      return { operation, input: args.date || "now", fromTimezone: tz, toTimezone: args.to_timezone, ...out };
    }
  }
}

module.exports = { dateCalc };
