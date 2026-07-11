"use strict";
// ── UTILITY TOOL SCHEMAS — part 5 ────────────────────────────────────────────
// Added: uuid_generate (v1/v4/v5/ULID), cron_next (cron parser + scheduler).

const UTIL_SCHEMAS_5 = [
  {
    name: "uuid_generate",
    description:
      "Generate one or more UUIDs or ULIDs — Node.js built-in crypto only, zero npm dependencies. " +
      "Versions: 'v4' (default) — cryptographically random UUID per RFC 4122 §4.4 using crypto.randomUUID(); " +
      "'v1' — time-based UUID (60-bit UTC timestamp at 100-ns resolution + 14-bit monotonic clock sequence + " +
      "random 48-bit node with multicast bit set, RFC 4122 §4.2); " +
      "'v5' — name-based UUID using SHA-1 hash of a namespace UUID + name string, fully deterministic (same inputs → same UUID, " +
      "RFC 4122 §4.3 + Appendix C); predefined namespaces: 'dns', 'url', 'oid', 'x500', or any custom UUID string. " +
      "'ulid' — Universally Unique Lexicographically Sortable Identifier: 26 Crockford Base32 chars (48-bit ms timestamp + " +
      "80-bit crypto-random), sortable by creation time unlike UUID v4, URL-safe. " +
      "Generate up to 100 at once via 'count'. Returns { version, count, ids, id? (when count=1), name? (v5), namespace? (v5) }. " +
      "Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: {
      type: "object",
      properties: {
        version: {
          type: "string",
          description:
            "UUID/ID version to generate: 'v4' (random, default), 'v1' (time-based), " +
            "'v5' (name-based SHA-1, requires 'name'), 'ulid' (sortable, Crockford Base32).",
        },
        count: {
          type: "number",
          description: "Number of IDs to generate (1–100, default 1).",
        },
        name: {
          type: "string",
          description:
            "For v5 only: the name string to hash together with the namespace. Required when version='v5'.",
        },
        namespace: {
          type: "string",
          description:
            "For v5 only: the namespace UUID to hash with. " +
            "Predefined shortcuts: 'dns' (default), 'url', 'oid', 'x500'. " +
            "Or supply any UUID string (e.g. '6ba7b810-9dad-11d1-80b4-00c04fd430c8').",
        },
        uppercase: {
          type: "boolean",
          description:
            "Return UUID hex digits in UPPERCASE (default: false, lowercase). " +
            "Has no effect on 'ulid' (already uppercase).",
        },
      },
    },
  },
  {
    name: "cron_next",
    description:
      "Parse a cron expression and compute the next N scheduled run times — zero npm dependencies, " +
      "pure UTC date arithmetic. Useful for debugging scheduled jobs, validating cron syntax, and " +
      "planning around automated tasks. " +
      "Supported formats: 5-field standard '* * * * *' (minute hour dom month dow) and 6-field with " +
      "seconds prefix '* * * * * *' (sec min hour dom month dow). " +
      "Field syntax: '*' (every), '5' (specific), '1-5' (range), '*/15' (step from min), " +
      "'1-5/2' (step within range), '1,3,5' (list), combinations like '0,30' or '1-5,10'. " +
      "Month and weekday names accepted (jan-dec, sun-sat). " +
      "Predefined aliases: @hourly, @daily, @midnight, @weekly, @monthly, @yearly, @annually. " +
      "DOM/DOW interaction follows Vixie-cron OR semantics: when both fields are non-wildcard, " +
      "a time matches if dom OR dow matches; when one is '*', only the other is checked. " +
      "Returns { expression, count, from, format, schedule: [ISO-8601-or-unix, ...] }. " +
      "Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: {
      type: "object",
      required: ["expression"],
      properties: {
        expression: {
          type: "string",
          description:
            "Cron expression to parse. Examples: '0 9 * * 1-5' (09:00 weekdays), " +
            "'*/5 * * * *' (every 5 minutes), '0 0 1 * *' (midnight on the 1st), " +
            "'30 18 * * fri' (18:30 every Friday), '@daily', '@hourly'. " +
            "6-field (with seconds): '0 */5 * * * *' (every 5 minutes at :00 seconds).",
        },
        count: {
          type: "number",
          description: "Number of upcoming occurrences to return (1–100, default 5).",
        },
        from: {
          type: "string",
          description:
            "ISO-8601 timestamp to start searching from (default: now). " +
            "E.g. '2026-01-01T00:00:00Z'. Occurrences are strictly after this time.",
        },
        format: {
          type: "string",
          description:
            "Output format for timestamps: 'iso' (default, ISO-8601 UTC strings like '2026-07-15T09:00:00.000Z') " +
            "or 'unix' (seconds since Unix epoch).",
        },
      },
    },
  },
];

module.exports = { UTIL_SCHEMAS_5 };
