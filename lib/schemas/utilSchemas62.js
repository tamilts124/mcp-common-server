"use strict";
// lib/schemas/utilSchemas62.js -- JSON schema for ical_client tool

const UTIL_SCHEMAS_62 = [
  {
    name: "ical_client",
    description:
      "Zero-dependency iCalendar (.ics) file reader/parser (pure Node.js; no npm deps). " +
      "Reads calendar data produced by Google Calendar, Apple Calendar (macOS/iOS), " +
      "Microsoft Outlook, Thunderbird, Fastmail, and any RFC 5545 / RFC 2445 compatible application. " +
      "Parses VEVENT (meetings, appointments), VTODO (tasks/reminders), VFREEBUSY (free/busy info), " +
      "and VTIMEZONE components. Handles line folding, CRLF/LF, quoted-printable, " +
      "RRULE (recurrence rules), EXDATE (recurrence exceptions), and VALARM (alarms). " +
      "Operations: " +
      "info (calendar metadata: PRODID, VERSION, CALSCALE, METHOD, calendar name/description/timezone/color, " +
      "component counts by type, and list of declared timezones); " +
      "events (return decoded VEVENT records with optional status/search/date_from/date_to filters, offset/limit pagination); " +
      "todos (return decoded VTODO records with optional status/search filters, offset/limit pagination); " +
      "freebusy (return VFREEBUSY records with decoded period list and FBTYPE classification); " +
      "to_json (export all or selected component types to a JSON string or file). " +
      "Each event includes: uid, summary, description, location, url, status, categories, class, " +
      "priority, transp, sequence, dtstart/dtend (ISO date+time, dateOnly flag, tzid, utc), " +
      "duration (parsed into weeks/days/hours/minutes/seconds/totalSeconds), " +
      "created/last_modified/dtstamp, organizer (email+cn), attendees (email/cn/role/partstat/rsvp), " +
      "recurrence (rrule object + exdates), alarms (action/trigger/description), geo (lat/lon). " +
      "Security: 50 MB file size cap; 100,000 component limit; NUL-byte path guard; directory path rejected.",
    inputSchema: {
      type: "object",
      required: ["operation", "path"],
      additionalProperties: false,
      properties: {
        operation: {
          type: "string",
          enum: ["info", "events", "todos", "freebusy", "to_json"],
          description:
            "Operation to perform. " +
            "'info': return calendar-level metadata (PRODID, VERSION, name, description, timezone, color, " +
            "component counts for events/todos/journals/freebusy/timezones). " +
            "'events': decode and return VEVENT records; supports status/search/date_from/date_to filters " +
            "and offset/limit pagination. " +
            "'todos': decode and return VTODO records; supports status/search filters and offset/limit. " +
            "'freebusy': return VFREEBUSY records with classified free/busy time periods. " +
            "'to_json': export events/todos/freebusy to a JSON string or file.",
        },

        path: {
          type: "string",
          description:
            "Path to the .ics iCalendar file to read. " +
            "Files produced by any RFC 5545 / RFC 2445 compliant application are supported.",
        },

        offset: {
          type: "integer",
          minimum: 0,
          description: "For 'events' and 'todos': skip this many (filtered) records from the start. Default: 0.",
        },

        limit: {
          type: "integer",
          minimum: 1,
          description:
            "For 'events' and 'todos': maximum number of records to return after filtering. Default: all records.",
        },

        status: {
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
          description:
            "For 'events': filter by STATUS property (e.g. 'CONFIRMED', 'TENTATIVE', 'CANCELLED'). " +
            "For 'todos': filter by STATUS property (e.g. 'NEEDS-ACTION', 'IN-PROCESS', 'COMPLETED', 'CANCELLED'). " +
            "Case-insensitive. Accepts a single string or an array of strings (matches any).",
        },

        search: {
          type: "string",
          description:
            "For 'events' and 'todos': case-insensitive substring search across summary, description, " +
            "and (for events) location fields.",
        },

        date_from: {
          type: "string",
          description:
            "For 'events': only return events whose DTSTART is on or after this ISO-8601 date/datetime " +
            "(e.g. '2024-01-01' or '2024-01-01T00:00:00Z'). Compared as a JS Date.",
        },

        date_to: {
          type: "string",
          description:
            "For 'events': only return events whose DTSTART is on or before this ISO-8601 date/datetime. " +
            "Combine with date_from for a date-range filter.",
        },

        include: {
          oneOf: [
            { type: "string", enum: ["events", "todos", "freebusy"] },
            { type: "array", items: { type: "string", enum: ["events", "todos", "freebusy"] } },
          ],
          description:
            "For 'to_json': which component types to include in the output JSON. " +
            "Default: all three (['events', 'todos', 'freebusy']). " +
            "Accepts a single string or an array.",
        },

        output_file: {
          type: "string",
          description:
            "For 'to_json': write the JSON output to this file path instead of returning it inline. " +
            "Parent directories are created automatically.",
        },

        pretty: {
          type: "boolean",
          description:
            "For 'to_json': pretty-print the JSON output with 2-space indentation (default: true). " +
            "Set to false for compact/minified output.",
        },
      },
    },
  },
];

module.exports = { UTIL_SCHEMAS_62 };
