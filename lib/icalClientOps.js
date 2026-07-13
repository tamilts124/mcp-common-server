"use strict";
// ── ical_client — zero-dep iCalendar (.ics) reader (pure Node.js) ─────────────
// Operations: info, events, todos, freebusy, to_json
// RFC 5545 / RFC 2445 compliant parser
// Supports: VEVENT, VTODO, VJOURNAL, VFREEBUSY, VTIMEZONE, VALARM
// Handles: folded lines, CRLF/LF, quoted-printable, base64, RRULE, EXDATE

const fs = require("fs");
const path = require("path");
const { ToolError } = require("./errors");

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const MAX_COMPONENTS = 100_000;

// ── File loading ──────────────────────────────────────────────────────────────
function loadFile(filePath) {
  if (!filePath || typeof filePath !== "string")
    throw new ToolError("ical_client: 'path' must be a non-empty string.", -32602);
  if (filePath.includes("\0"))
    throw new ToolError("ical_client: 'path' must not contain NUL bytes.", -32602);

  let resolved;
  try { resolved = path.resolve(filePath); } catch {
    throw new ToolError(`ical_client: Cannot resolve path '${filePath}'.`, -32602);
  }

  let stat;
  try { stat = fs.statSync(resolved); } catch (e) {
    throw new ToolError(`ical_client: Cannot access '${filePath}': ${e.message}`, -32602);
  }
  if (stat.isDirectory())
    throw new ToolError(`ical_client: '${filePath}' is a directory, not a file.`, -32602);
  if (stat.size > MAX_FILE_SIZE)
    throw new ToolError(
      `ical_client: File too large (${stat.size} bytes; limit ${MAX_FILE_SIZE}).`, -32602
    );

  return fs.readFileSync(resolved, "utf8");
}

// ── Line unfolding (RFC 5545 §3.1) ──────────────────────────────────────────
// Lines may be folded by inserting CRLF + whitespace (or LF + whitespace)
function unfoldLines(raw) {
  return raw.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
}

// ── Parse property line into { name, params, value } ─────────────────────────
// e.g. "DTSTART;TZID=America/New_York:20230101T090000"
function parsePropLine(line) {
  let colonIdx = -1;
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') inQuote = !inQuote;
    else if (line[i] === ":" && !inQuote) { colonIdx = i; break; }
  }
  if (colonIdx === -1) return { name: line.trim().toUpperCase(), params: {}, value: "" };

  const namePart = line.slice(0, colonIdx);
  const value = line.slice(colonIdx + 1);

  const parts = [];
  let cur = "", inQ = false;
  for (const ch of namePart) {
    if (ch === '"') { inQ = !inQ; cur += ch; }
    else if (ch === ";" && !inQ) { parts.push(cur); cur = ""; }
    else cur += ch;
  }
  parts.push(cur);

  const name = parts[0].trim().toUpperCase();
  const params = {};
  for (let i = 1; i < parts.length; i++) {
    const eqIdx = parts[i].indexOf("=");
    if (eqIdx === -1) continue;
    const pName = parts[i].slice(0, eqIdx).trim().toUpperCase();
    const pVal = parts[i].slice(eqIdx + 1).trim().replace(/^"(.*)"$/, "$1");
    params[pName] = pVal;
  }

  return { name, params, value };
}

// ── Decode value ──────────────────────────────────────────────────────────────
function decodeValue(prop) {
  if (prop.params.ENCODING === "QUOTED-PRINTABLE") {
    return prop.value.replace(/=([0-9A-Fa-f]{2})/g, (_, h) =>
      String.fromCharCode(parseInt(h, 16))
    );
  }
  if (prop.params.ENCODING === "BASE64") {
    return prop.value;
  }
  return prop.value
    .replace(/\\n/gi, "\n")
    .replace(/\\;/g, ";")
    .replace(/\\,/g, ",")
    .replace(/\\\\/g, "\\");
}

// ── Parse iCal datetime string ────────────────────────────────────────────────
function parseDateTime(val, params) {
  if (!val) return null;
  const dateOnly = val.length === 8 || params?.VALUE === "DATE";

  if (dateOnly && /^\d{8}$/.test(val)) {
    return {
      date: `${val.slice(0,4)}-${val.slice(4,6)}-${val.slice(6,8)}`,
      dateOnly: true,
      utc: false,
      tzid: params?.TZID || null,
      raw: val,
    };
  }

  const m = val.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return { raw: val, parseError: true };

  const utc = m[7] === "Z";
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${utc ? "Z" : ""}`;
  return {
    iso,
    date: `${m[1]}-${m[2]}-${m[3]}`,
    time: `${m[4]}:${m[5]}:${m[6]}`,
    utc,
    tzid: utc ? "UTC" : (params?.TZID || null),
    dateOnly: false,
    raw: val,
  };
}

// ── Parse duration (PT1H30M, P1DT2H, -PT30M) ─────────────────────────────────
function parseDuration(val) {
  if (!val) return null;
  const neg = val.startsWith("-");
  const m = val.replace(/^-?P/, "").match(
    /^(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/
  );
  if (!m) return { raw: val };
  const weeks = parseInt(m[1] || 0, 10);
  const days  = parseInt(m[2] || 0, 10);
  const hours = parseInt(m[3] || 0, 10);
  const mins  = parseInt(m[4] || 0, 10);
  const secs  = parseInt(m[5] || 0, 10);
  const totalSeconds = (weeks * 7 * 86400 + days * 86400 + hours * 3600 + mins * 60 + secs) * (neg ? -1 : 1);
  return { raw: val, negative: neg, weeks, days, hours, minutes: mins, seconds: secs, totalSeconds };
}

// ── Parse RRULE value string ──────────────────────────────────────────────────
function parseRRule(val) {
  const obj = {};
  for (const part of val.split(";")) {
    const [k, v] = part.split("=");
    if (k && v !== undefined) obj[k.trim().toUpperCase()] = v.trim();
  }
  return obj;
}

// ── Main iCal parser ──────────────────────────────────────────────────────────
function parseICal(raw) {
  const lines = unfoldLines(raw).split("\n");
  const calendar = { properties: {}, components: [] };
  const stack = [calendar];

  let componentCount = 0;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (/^BEGIN:/i.test(line)) {
      const compType = line.slice(6).trim().toUpperCase();
      const comp = { type: compType, properties: {}, components: [] };
      componentCount++;
      if (componentCount > MAX_COMPONENTS)
        throw new ToolError(`ical_client: Too many components (limit ${MAX_COMPONENTS}).`, -32602);

      const parent = stack[stack.length - 1];
      parent.components.push(comp);
      stack.push(comp);
    } else if (/^END:/i.test(line)) {
      if (stack.length > 1) stack.pop();
    } else {
      const prop = parsePropLine(line);
      const target = stack[stack.length - 1];
      const decodedVal = decodeValue(prop);

      if (prop.name in target.properties) {
        const existing = target.properties[prop.name];
        if (!Array.isArray(existing)) {
          target.properties[prop.name] = [existing, { params: prop.params, value: decodedVal, raw: prop.value }];
        } else {
          existing.push({ params: prop.params, value: decodedVal, raw: prop.value });
        }
      } else {
        target.properties[prop.name] = { params: prop.params, value: decodedVal, raw: prop.value };
      }
    }
  }

  return calendar;
}

// ── Property value helpers ────────────────────────────────────────────────────
function propVal(prop) {
  if (!prop) return null;
  if (Array.isArray(prop)) return prop.map(p => p.value);
  return prop.value;
}

function propParams(prop) {
  if (!prop) return {};
  if (Array.isArray(prop)) return prop[0]?.params || {};
  return prop.params || {};
}

function scalarVal(prop) {
  const v = propVal(prop);
  return Array.isArray(v) ? v[0] : v;
}

// ── Format VEVENT to a clean object ──────────────────────────────────────────
function formatEvent(comp) {
  const p = comp.properties;

  const dtStartProp = Array.isArray(p.DTSTART) ? p.DTSTART[0] : p.DTSTART;
  const dtEndProp   = Array.isArray(p.DTEND)   ? p.DTEND[0]   : p.DTEND;
  const dtStart = parseDateTime(dtStartProp?.value, dtStartProp?.params);
  const dtEnd   = parseDateTime(dtEndProp?.value, dtEndProp?.params);

  const durationRaw = scalarVal(p.DURATION);
  const duration = durationRaw ? parseDuration(durationRaw) : null;

  const rruleProp = Array.isArray(p.RRULE) ? p.RRULE[0] : p.RRULE;
  const rrule = rruleProp ? parseRRule(rruleProp.value) : null;

  const exdates = [];
  if (p.EXDATE) {
    const ex = Array.isArray(p.EXDATE) ? p.EXDATE : [p.EXDATE];
    for (const e of ex) {
      for (const d of e.value.split(",")) {
        const dt = parseDateTime(d.trim(), e.params);
        if (dt) exdates.push(dt);
      }
    }
  }

  const attendees = [];
  if (p.ATTENDEE) {
    const att = Array.isArray(p.ATTENDEE) ? p.ATTENDEE : [p.ATTENDEE];
    for (const a of att) {
      attendees.push({
        email: a.value.replace(/^mailto:/i, ""),
        cn: a.params?.CN || null,
        role: a.params?.ROLE || null,
        status: a.params?.PARTSTAT || null,
        rsvp: a.params?.RSVP === "TRUE",
      });
    }
  }

  const alarms = (comp.components || [])
    .filter(c => c.type === "VALARM")
    .map(a => ({
      action: scalarVal(a.properties.ACTION),
      trigger: parseDuration(scalarVal(a.properties.TRIGGER)) || scalarVal(a.properties.TRIGGER),
      description: scalarVal(a.properties.DESCRIPTION),
    }));

  const organizerProp = Array.isArray(p.ORGANIZER) ? p.ORGANIZER[0] : p.ORGANIZER;

  return {
    uid:           scalarVal(p.UID),
    summary:       scalarVal(p.SUMMARY),
    description:   scalarVal(p.DESCRIPTION) || null,
    location:      scalarVal(p.LOCATION) || null,
    url:           scalarVal(p.URL) || null,
    status:        scalarVal(p.STATUS) || null,
    categories:    scalarVal(p.CATEGORIES) ? String(scalarVal(p.CATEGORIES)).split(",").map(s => s.trim()) : [],
    class:         scalarVal(p.CLASS) || null,
    priority:      scalarVal(p.PRIORITY) != null ? parseInt(scalarVal(p.PRIORITY), 10) : null,
    transp:        scalarVal(p.TRANSP) || null,
    sequence:      scalarVal(p.SEQUENCE) != null ? parseInt(scalarVal(p.SEQUENCE), 10) : 0,
    dtstart:       dtStart,
    dtend:         dtEnd || null,
    duration:      duration,
    created:       parseDateTime(scalarVal(p.CREATED), propParams(p.CREATED)),
    last_modified: parseDateTime(scalarVal(p["LAST-MODIFIED"]), propParams(p["LAST-MODIFIED"])),
    dtstamp:       parseDateTime(scalarVal(p.DTSTAMP), propParams(p.DTSTAMP)),
    organizer: organizerProp ? {
      email: organizerProp.value.replace(/^mailto:/i, ""),
      cn:    organizerProp.params?.CN || null,
    } : null,
    attendees,
    recurrence: rrule ? { rrule, exdates } : null,
    alarms,
    geo: p.GEO ? (() => {
      const [lat, lon] = String(scalarVal(p.GEO)).split(";");
      return { latitude: parseFloat(lat), longitude: parseFloat(lon) };
    })() : null,
  };
}

// ── Format VTODO to a clean object ────────────────────────────────────────────
function formatTodo(comp) {
  const p = comp.properties;
  const dueProp = Array.isArray(p.DUE) ? p.DUE[0] : p.DUE;
  return {
    uid:              scalarVal(p.UID),
    summary:          scalarVal(p.SUMMARY),
    description:      scalarVal(p.DESCRIPTION) || null,
    status:           scalarVal(p.STATUS) || null,
    priority:         scalarVal(p.PRIORITY) != null ? parseInt(scalarVal(p.PRIORITY), 10) : null,
    percent_complete: scalarVal(p["PERCENT-COMPLETE"]) != null ? parseInt(scalarVal(p["PERCENT-COMPLETE"]), 10) : null,
    due:              parseDateTime(dueProp?.value, dueProp?.params),
    completed:        parseDateTime(scalarVal(p.COMPLETED), propParams(p.COMPLETED)),
    categories:       scalarVal(p.CATEGORIES) ? String(scalarVal(p.CATEGORIES)).split(",").map(s => s.trim()) : [],
    location:         scalarVal(p.LOCATION) || null,
    url:              scalarVal(p.URL) || null,
    created:          parseDateTime(scalarVal(p.CREATED), propParams(p.CREATED)),
    last_modified:    parseDateTime(scalarVal(p["LAST-MODIFIED"]), propParams(p["LAST-MODIFIED"])),
  };
}

// ── Format VFREEBUSY ─────────────────────────────────────────────────────────
function formatFreeBusy(comp) {
  const p = comp.properties;
  const periods = [];
  if (p.FREEBUSY) {
    const fb = Array.isArray(p.FREEBUSY) ? p.FREEBUSY : [p.FREEBUSY];
    for (const f of fb) {
      const fbtype = f.params?.FBTYPE || "BUSY";
      for (const period of f.value.split(",")) {
        const [start, end] = period.split("/");
        periods.push({
          fbtype,
          start: parseDateTime(start?.trim(), {}),
          end: end?.trim().startsWith("P") ? parseDuration(end.trim()) : parseDateTime(end?.trim(), {}),
        });
      }
    }
  }
  const orgProp = Array.isArray(p.ORGANIZER) ? p.ORGANIZER[0] : p.ORGANIZER;
  return {
    uid:      scalarVal(p.UID),
    organizer: orgProp ? orgProp.value.replace(/^mailto:/i, "") : null,
    dtstart:  parseDateTime(scalarVal(p.DTSTART), propParams(p.DTSTART)),
    dtend:    parseDateTime(scalarVal(p.DTEND), propParams(p.DTEND)),
    periods,
  };
}

// ── Collect calendar-level metadata ───────────────────────────────────────────
function calendarInfo(vcal) {
  const p = vcal.properties;
  const eventComps   = vcal.components.filter(c => c.type === "VEVENT");
  const todoComps    = vcal.components.filter(c => c.type === "VTODO");
  const journalComps = vcal.components.filter(c => c.type === "VJOURNAL");
  const fbComps      = vcal.components.filter(c => c.type === "VFREEBUSY");
  const tzComps      = vcal.components.filter(c => c.type === "VTIMEZONE");

  return {
    prodid:      scalarVal(p.PRODID),
    version:     scalarVal(p.VERSION),
    calscale:    scalarVal(p.CALSCALE) || "GREGORIAN",
    method:      scalarVal(p.METHOD) || null,
    name:        scalarVal(p["X-WR-CALNAME"]) || scalarVal(p.NAME) || null,
    description: scalarVal(p["X-WR-CALDESC"]) || scalarVal(p.DESCRIPTION) || null,
    timezone:    scalarVal(p["X-WR-TIMEZONE"]) || null,
    color:       scalarVal(p.COLOR) || scalarVal(p["X-APPLE-CALENDAR-COLOR"]) || null,
    componentCounts: {
      events:    eventComps.length,
      todos:     todoComps.length,
      journals:  journalComps.length,
      freebusy:  fbComps.length,
      timezones: tzComps.length,
    },
    timezones: tzComps.map(tz => ({ tzid: scalarVal(tz.properties.TZID) })),
  };
}

// ── Locate VCALENDAR component ────────────────────────────────────────────────
function locateVcal(cal) {
  // The outermost BEGIN:VCALENDAR creates a component inside the root shell
  if (cal.components.length === 1 && cal.components[0].type === "VCALENDAR") {
    return cal.components[0];
  }
  // Fallback: treat root itself (for malformed/headerless input)
  return cal;
}

// ── Main ical_client function ─────────────────────────────────────────────────
function icalClient(args) {
  const op = (args.operation || "").trim();
  if (!op)
    throw new ToolError(
      "ical_client: 'operation' is required. Valid: info, events, todos, freebusy, to_json.",
      -32602
    );

  const raw = loadFile(args.path);
  const cal = parseICal(raw);
  const vcal = locateVcal(cal);

  const allEvents   = vcal.components.filter(c => c.type === "VEVENT");
  const allTodos    = vcal.components.filter(c => c.type === "VTODO");
  const allFreeBusy = vcal.components.filter(c => c.type === "VFREEBUSY");

  switch (op) {
    // ── info ─────────────────────────────────────────────────────────────────
    case "info": {
      return { operation: "info", path: args.path, ...calendarInfo(vcal) };
    }

    // ── events ────────────────────────────────────────────────────────────────
    case "events": {
      const offset = typeof args.offset === "number" ? Math.max(0, args.offset) : 0;
      const limit  = typeof args.limit  === "number" ? Math.max(1, args.limit)  : allEvents.length;

      let events = allEvents.map(formatEvent);

      if (args.status) {
        const statuses = (Array.isArray(args.status) ? args.status : [args.status])
          .map(s => s.toUpperCase());
        events = events.filter(e => statuses.includes((e.status || "").toUpperCase()));
      }
      if (args.search) {
        const q = args.search.toLowerCase();
        events = events.filter(e =>
          (e.summary || "").toLowerCase().includes(q) ||
          (e.description || "").toLowerCase().includes(q) ||
          (e.location || "").toLowerCase().includes(q)
        );
      }
      if (args.date_from) {
        const from = new Date(args.date_from);
        if (!isNaN(from)) {
          events = events.filter(e => {
            const d = e.dtstart?.iso ? new Date(e.dtstart.iso) :
                      (e.dtstart?.date ? new Date(e.dtstart.date) : null);
            return d && d >= from;
          });
        }
      }
      if (args.date_to) {
        const to = new Date(args.date_to);
        if (!isNaN(to)) {
          events = events.filter(e => {
            const d = e.dtstart?.iso ? new Date(e.dtstart.iso) :
                      (e.dtstart?.date ? new Date(e.dtstart.date) : null);
            return d && d <= to;
          });
        }
      }

      const totalFiltered = events.length;
      events = events.slice(offset, offset + limit);

      return {
        operation: "events",
        path: args.path,
        total: allEvents.length,
        filtered: totalFiltered,
        offset,
        limit,
        count: events.length,
        events,
      };
    }

    // ── todos ─────────────────────────────────────────────────────────────────
    case "todos": {
      const offset = typeof args.offset === "number" ? Math.max(0, args.offset) : 0;
      const limit  = typeof args.limit  === "number" ? Math.max(1, args.limit)  : allTodos.length;

      let todos = allTodos.map(formatTodo);

      if (args.status) {
        const statuses = (Array.isArray(args.status) ? args.status : [args.status])
          .map(s => s.toUpperCase());
        todos = todos.filter(t => statuses.includes((t.status || "").toUpperCase()));
      }
      if (args.search) {
        const q = args.search.toLowerCase();
        todos = todos.filter(t =>
          (t.summary || "").toLowerCase().includes(q) ||
          (t.description || "").toLowerCase().includes(q)
        );
      }

      const totalFiltered = todos.length;
      todos = todos.slice(offset, offset + limit);

      return {
        operation: "todos",
        path: args.path,
        total: allTodos.length,
        filtered: totalFiltered,
        offset,
        limit,
        count: todos.length,
        todos,
      };
    }

    // ── freebusy ──────────────────────────────────────────────────────────────
    case "freebusy": {
      const items = allFreeBusy.map(formatFreeBusy);
      return { operation: "freebusy", path: args.path, count: items.length, freebusy: items };
    }

    // ── to_json ───────────────────────────────────────────────────────────────
    case "to_json": {
      const include = args.include
        ? (Array.isArray(args.include) ? args.include : [args.include]).map(s => s.toLowerCase())
        : ["events", "todos", "freebusy"];

      const output = { calendar: calendarInfo(vcal) };
      if (include.includes("events"))   output.events   = allEvents.map(formatEvent);
      if (include.includes("todos"))    output.todos    = allTodos.map(formatTodo);
      if (include.includes("freebusy")) output.freebusy = allFreeBusy.map(formatFreeBusy);

      const pretty = args.pretty !== false;
      const jsonStr = JSON.stringify(output, null, pretty ? 2 : 0);

      if (args.output_file) {
        const outPath = path.resolve(args.output_file);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, jsonStr, "utf8");
        return {
          operation: "to_json",
          path: args.path,
          output_file: args.output_file,
          bytes: jsonStr.length,
          eventCount:    include.includes("events")   ? output.events.length   : null,
          todoCount:     include.includes("todos")    ? output.todos.length    : null,
          freebusyCount: include.includes("freebusy") ? output.freebusy.length : null,
        };
      }

      return {
        operation: "to_json",
        path: args.path,
        bytes: jsonStr.length,
        eventCount:    include.includes("events")   ? output.events.length   : null,
        todoCount:     include.includes("todos")    ? output.todos.length    : null,
        freebusyCount: include.includes("freebusy") ? output.freebusy.length : null,
        json: jsonStr,
      };
    }

    default:
      throw new ToolError(
        `ical_client: unknown operation '${op}'. Valid: info, events, todos, freebusy, to_json.`,
        -32602
      );
  }
}

module.exports = { icalClient };
