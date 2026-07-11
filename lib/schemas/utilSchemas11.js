"use strict";
// ── UTILITY TOOL SCHEMAS — part 11 ──────────────────────────────────────────────
// Added: date_calc (v4.147.0), text_extract (v4.147.0).

const UTIL_SCHEMAS_11 = [
  {
    name: "date_calc",
    description:
      "Date/time arithmetic, formatting, parsing, and timezone conversion — " +
      "zero npm dependencies, pure Node.js Intl + Date APIs. " +
      "Operations: " +
      "'now' — return the current time in any IANA timezone with optional format string and locale. " +
      "'parse' — parse an ISO string, Unix timestamp (seconds or ms), or 'now' into structured components. " +
      "'format' — format a date with a Moment.js-compatible token string " +
      "(YYYY MM DD HH mm ss SSS A dddd ddd MMMM MMM Z X x). " +
      "'add' / 'subtract' — add or subtract an amount of units " +
      "(year month week day hour minute second millisecond) from a date. " +
      "'diff' — compute the signed difference between two dates in the given unit. " +
      "'start_of' / 'end_of' — snap a date to the start or end of a unit " +
      "(year month week day hour minute). " +
      "'convert_tz' — convert a date to a different IANA timezone. " +
      "'is_valid' — check whether a date string or number is parseable. " +
      "All operations return { iso, isoLocal, unix, unixMs, timezone, utcOffset, components } " +
      "plus any operation-specific fields. " +
      "Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: {
      type: "object",
      required: ["operation"],
      properties: {
        operation: {
          type: "string",
          description:
            "Operation: now, parse, format, add, subtract, diff, start_of, end_of, convert_tz, is_valid.",
        },
        date: {
          description:
            "Input date: ISO 8601 string (e.g. '2024-06-15T12:00:00Z'), " +
            "Unix seconds or milliseconds (number or numeric string), or 'now'. " +
            "Defaults to current time when omitted.",
          oneOf: [{ type: "string" }, { type: "number" }],
        },
        date2: {
          description: "(diff only) Second date to compare against 'date'.",
          oneOf: [{ type: "string" }, { type: "number" }],
        },
        amount: {
          type: "number",
          description:
            "(add/subtract) The number of units to add or subtract. May be fractional for supported units.",
        },
        unit: {
          type: "string",
          description:
            "Time unit: year, month, week, day, hour, minute, second, millisecond. " +
            "Required for add/subtract/diff/start_of/end_of.",
        },
        timezone: {
          type: "string",
          description:
            "IANA timezone name for output (e.g. 'America/New_York', 'Asia/Kolkata', 'UTC'). Default: UTC.",
        },
        to_timezone: {
          type: "string",
          description: "(convert_tz only) Target IANA timezone to convert the date into.",
        },
        format: {
          type: "string",
          description:
            "Moment.js-compatible format string for a formatted output field, e.g. 'YYYY-MM-DD HH:mm:ss Z'. " +
            "Tokens: YYYY YY MMMM MMM MM M DD D HH H hh h mm ss SSS dddd ddd A a Z X x. " +
            "Optional for now/parse/add/subtract/start_of/end_of/convert_tz; required for format operation.",
        },
        locale: {
          type: "string",
          description:
            "(now/parse/convert_tz) BCP 47 locale tag for a localeString field via Intl.DateTimeFormat, " +
            "e.g. 'en-US', 'fr-FR', 'ja-JP'.",
        },
      },
    },
  },
  {
    name: "text_extract",
    description:
      "Extract structured entities and patterns from any unstructured text string — " +
      "zero npm dependencies, pure Node.js regex. " +
      "Operations: " +
      "'emails' — extract email addresses (RFC 5321 simplified). " +
      "'urls' — extract http/https/ftp URLs. " +
      "'phones' — extract phone numbers (international and US formats, min 7 digits). " +
      "'ips' — extract IPv4 and IPv6 addresses with version labels. " +
      "'numbers' — extract all numeric values (integer, decimal, negative, scientific notation, comma-grouped). " +
      "'dates' — extract date-like patterns (ISO 8601, MM/DD/YYYY, DD-Month-YYYY, Month DD YYYY, etc.). " +
      "'json' — find and parse embedded JSON objects/arrays (balanced bracket scanning). " +
      "'lines' — filter lines matching a pattern (like grep); supports regex, ignore_case, invert, context lines. " +
      "'between' — extract content between a start and end delimiter string; greedy mode returns the outermost span. " +
      "'pattern' — extract all matches for a custom JavaScript regex with optional capture groups. " +
      "'words' — compute word frequency and return top-N words, with stop_word filtering. " +
      "Most operations support 'dedupe' (default true) and 'max_results' (default 1000, hard cap 10000). " +
      "Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: {
      type: "object",
      required: ["operation", "text"],
      properties: {
        operation: {
          type: "string",
          description:
            "Extraction operation: emails, urls, phones, ips, numbers, dates, json, lines, between, pattern, words.",
        },
        text: {
          type: "string",
          description: "Input text to extract from. Max 10 MB.",
        },
        // shared
        dedupe: {
          type: "boolean",
          description:
            "Remove duplicate matches (default: true). Applies to emails, urls, phones, ips, dates.",
        },
        max_results: {
          type: "number",
          description: "Maximum number of results to return (1–10000, default 1000).",
        },
        // lines / pattern shared
        pattern: {
          type: "string",
          description:
            "(lines/pattern) Regex or literal pattern to match. " +
            "For 'lines': filters to matching lines. For 'pattern': extracts all regex matches.",
        },
        is_regex: {
          type: "boolean",
          description: "(lines) Treat 'pattern' as a JavaScript regex (default: false — literal string match).",
        },
        ignore_case: {
          type: "boolean",
          description: "(lines/pattern/words) Case-insensitive matching (default: false for lines/pattern, true for words).",
        },
        invert: {
          type: "boolean",
          description: "(lines) Return lines that do NOT match the pattern (default: false).",
        },
        context: {
          type: "number",
          description:
            "(lines) Number of surrounding context lines to include around each matching line (0–50, default 0).",
        },
        flags: {
          type: "string",
          description:
            "(pattern) JavaScript regex flags, e.g. 'gi', 'gm'. Default: 'g'. " +
            "'g' is added automatically if not present.",
        },
        // between
        start: {
          type: "string",
          description: "(between) Start delimiter string. Required for 'between' operation.",
        },
        end: {
          type: "string",
          description: "(between) End delimiter string. Required for 'between' operation.",
        },
        include_delimiters: {
          type: "boolean",
          description: "(between) Include the start/end delimiter strings in the 'full' field (default: false).",
        },
        greedy: {
          type: "boolean",
          description:
            "(between) Find the outermost span: match from the first occurrence of 'start' " +
            "to the LAST occurrence of 'end'. Returns at most one result (default: false — leftmost non-overlapping).",
        },
        // words
        min_length: {
          type: "number",
          description: "(words) Minimum word length to include (default: 1).",
        },
        top_n: {
          type: "number",
          description: "(words) Maximum number of top words to return by frequency (default: 50, max: 10000).",
        },
        stop_words: {
          type: "array",
          items: { type: "string" },
          description: "(words) Words to exclude from frequency counts (e.g. common English stop words).",
        },
      },
    },
  },
];

module.exports = { UTIL_SCHEMAS_11 };
