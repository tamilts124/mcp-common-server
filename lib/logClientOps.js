"use strict";
// ── log_client — zero-dep structured log file reader/analyzer (pure Node.js) ──
// Operations: info, read, search, stats, tail, export
// Formats (auto-detected): JSON-lines, Apache/Nginx CLF+Combined, Syslog RFC3164/5424,
//   W3C Extended (IIS), TSV/CSV logs, plain text
// Filters: level, time range, pattern/regex, field matching
// Security: 500 MB file cap; 5,000,000 line limit; NUL-byte guard; directory guard

const fs   = require("fs");
const path = require("path");
const { ToolError } = require("./errors");

const MAX_FILE_SIZE  = 500 * 1024 * 1024; // 500 MB
const MAX_LINES      = 5_000_000;
const MAX_EXPORT     = 500_000;
const MAX_READ_LINES = 100_000;
const MAX_TAIL_LINES = 10_000;
const MAX_SEARCH_RESULTS = 50_000;

// ── Known log levels (normalised) ────────────────────────────────────────────
const LOG_LEVELS = new Map([
  ["trace",     0], ["verbose",  0],
  ["debug",    10], ["dbg",     10],
  ["info",     20], ["information", 20], ["inf", 20], ["notice", 25],
  ["warn",     30], ["warning",  30], ["wrn", 30],
  ["error",    40], ["err",     40], ["eror", 40],
  ["critical", 50], ["crit",   50], ["fatal", 60], ["ftl", 60],
  ["alert",    55], ["emerg",   65], ["panic", 65],
]);

function normLevel(raw) {
  if (!raw) return null;
  const s = String(raw).toLowerCase().trim();
  // Strip brackets: [INFO] -> INFO
  const stripped = s.replace(/^\[|\]$/g, "");
  const num = LOG_LEVELS.get(stripped);
  if (num !== undefined) return { name: stripped, severity: num };
  // Try without leading zero padding for HTTP codes used as severity
  if (/^\d+$/.test(stripped)) return { name: stripped, severity: parseInt(stripped, 10) };
  return { name: stripped, severity: null };
}

// ── File loader ───────────────────────────────────────────────────────────────
function loadFileMeta(filePath) {
  if (!filePath || typeof filePath !== "string")
    throw new ToolError("log_client: 'path' must be a non-empty string.", -32602);
  if (filePath.includes("\0"))
    throw new ToolError("log_client: 'path' must not contain NUL bytes.", -32602);

  let resolved;
  try { resolved = path.resolve(filePath); } catch {
    throw new ToolError(`log_client: Cannot resolve path '${filePath}'.`, -32602);
  }

  let stat;
  try { stat = fs.statSync(resolved); } catch (e) {
    throw new ToolError(`log_client: Cannot access '${filePath}': ${e.message}`, -32602);
  }
  if (stat.isDirectory())
    throw new ToolError(`log_client: '${filePath}' is a directory, not a file.`, -32602);
  if (stat.size > MAX_FILE_SIZE)
    throw new ToolError(
      `log_client: File too large (${stat.size} bytes; limit ${MAX_FILE_SIZE}).`, -32602
    );

  return { resolved, stat };
}

function readFileText(resolved) {
  return fs.readFileSync(resolved, "utf8");
}

// ── Line reader with optional tail mode ──────────────────────────────────────
function readLines(resolved, maxLines, fromEnd) {
  const text = readFileText(resolved);
  const allLines = text.split(/\r?\n/);
  // Remove trailing empty line
  if (allLines.length > 0 && allLines[allLines.length - 1] === "") allLines.pop();
  const total = allLines.length;
  if (total > MAX_LINES)
    throw new ToolError(
      `log_client: File has ${total} lines (limit ${MAX_LINES}).`, -32602
    );
  if (fromEnd) {
    const n = Math.min(maxLines, total);
    return { lines: allLines.slice(total - n), total, truncated: false };
  }
  const cap = Math.min(maxLines, total);
  return { lines: allLines.slice(0, cap), total, truncated: cap < total };
}

// ══════════════════════════════════════════════════════════════════════════════
// FORMAT DETECTION
// ══════════════════════════════════════════════════════════════════════════════

// Try to detect the log format from a sample of lines
const FORMAT_PATTERNS = {
  // JSON-lines: line starts with { or [
  jsonl:   /^\s*[\[{]/,
  // Syslog RFC5424: <PRI>VERSION TIMESTAMP HOSTNAME APP-NAME PROCID MSGID
  syslog5424: /^<\d+>\d+\s+\S+\s+\S+\s+\S+\s+\S+\s+\S+/,
  // Syslog RFC3164: <PRI>MONTH DAY HH:MM:SS HOSTNAME
  syslog3164: /^<\d+>[A-Z][a-z]{2}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\S+/,
  // Apache/Nginx Combined: IP - - [date] "METHOD path HTTP/1.x" status size "ref" "ua"
  apache_combined: /^\S+\s+-\s+-\s+\[\d{2}\/\w+\/\d{4}:\d{2}:\d{2}:\d{2}\s+[+-]\d{4}\]\s+"[A-Z]+\s+\S+\s+HTTP\/\d\.\d"\s+\d+\s+\S+\s+"/,
  // Apache/Nginx CLF (no referer/ua)
  apache_clf: /^\S+\s+-\s+-\s+\[\d{2}\/\w+\/\d{4}:\d{2}:\d{2}:\d{2}\s+[+-]\d{4}\]\s+"[A-Z]+\s+\S+\s+HTTP\/\d\.\d"\s+\d+/,
  // W3C Extended (IIS): lines start with field names prefixed by '#Fields:'
  w3c: /^#(?:Version|Date|Software|Fields|Remark):/i,
  // ISO timestamp prefix: 2023-01-01T00:00:00 or 2023-01-01 00:00:00
  iso_timestamp: /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/,
  // Unix timestamp prefix
  unix_ts: /^\d{10}(?:\.\d+)?\s+/,
  // Common log: timestamp level message
  common: /^[\d\-T:.Z ]+\s+(?:TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|CRITICAL|FATAL|ERR|ALERT|EMERG|PANIC)/i,
};

function detectFormat(sampleLines) {
  const nonEmpty = sampleLines.filter(l => l.trim() && !l.startsWith("#"));
  if (nonEmpty.length === 0) return "unknown";

  // Count matches per format
  const counts = {};
  for (const [fmt, re] of Object.entries(FORMAT_PATTERNS)) {
    counts[fmt] = nonEmpty.filter(l => re.test(l)).length;
  }
  const total = nonEmpty.length;
  const minMatch = Math.min(3, total);

  // Check W3C header markers in the raw sample
  if (sampleLines.some(l => /^#Fields:/i.test(l))) return "w3c";
  if (counts.syslog5424 >= minMatch)    return "syslog5424";
  if (counts.syslog3164 >= minMatch)    return "syslog3164";
  if (counts.apache_combined >= minMatch) return "apache_combined";
  if (counts.apache_clf >= minMatch)    return "apache_clf";

  // JSON: check if majority are parseable as JSON
  let jsonCount = 0;
  for (const l of nonEmpty.slice(0, 20)) {
    if (!FORMAT_PATTERNS.jsonl.test(l)) continue;
    try { JSON.parse(l); jsonCount++; } catch {}
  }
  if (jsonCount >= Math.min(3, nonEmpty.slice(0, 20).length)) return "jsonl";

  if (counts.iso_timestamp >= minMatch) return "iso_timestamp";
  if (counts.unix_ts >= minMatch)       return "unix_ts";
  if (counts.common >= minMatch)        return "common";

  return "plain";
}

// ══════════════════════════════════════════════════════════════════════════════
// LINE PARSERS
// ══════════════════════════════════════════════════════════════════════════════

// Month abbreviation → number
const MONTHS = { Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12 };

function parseIsoTs(s) {
  if (!s) return null;
  try { const d = new Date(s); return isNaN(d) ? null : d.toISOString(); } catch { return null; }
}

// ── JSON-lines parser ─────────────────────────────────────────────────────────
function parseJsonlLine(line, lineNum) {
  try {
    const obj = JSON.parse(line);
    if (typeof obj !== "object" || obj === null) {
      return { lineNum, format: "jsonl", raw: line, parsed: true, value: obj };
    }
    // Attempt to extract common fields
    const ts = obj.timestamp ?? obj.time ?? obj.ts ?? obj["@timestamp"] ?? obj.datetime ?? null;
    const lvl = obj.level ?? obj.severity ?? obj.lvl ?? obj.log_level ?? null;
    const msg = obj.message ?? obj.msg ?? obj.text ?? obj.body ?? null;
    const level = normLevel(lvl);
    return {
      lineNum,
      format:    "jsonl",
      timestamp: parseIsoTs(ts ? String(ts) : null) ?? (typeof ts === "number" ? new Date(ts * (ts > 1e12 ? 1 : 1000)).toISOString() : null),
      level:     level?.name ?? null,
      severity:  level?.severity ?? null,
      message:   msg != null ? String(msg) : null,
      fields:    obj,
      raw:       line,
    };
  } catch {
    return { lineNum, format: "jsonl", raw: line, parseError: true };
  }
}

// ── Apache/Nginx CLF + Combined parser ───────────────────────────────────────
// CLF: %h %l %u %t "%r" %>s %b
// Combined: %h %l %u %t "%r" %>s %b "%{Referer}i" "%{User-agent}i"
const APACHE_RE = /^(\S+)\s+(\S+)\s+(\S+)\s+\[(\d{2})\/(\w+)\/(\d{4}):(\d{2}):(\d{2}):(\d{2})\s+([+-]\d{4})\]\s+"((?:[^"\\]|\\.)*)"\s+(\d+)\s+(\S+)(?:\s+"((?:[^"\\]|\\.)*?)"\s+"((?:[^"\\]|\\.)*?)")?/;

function parseApacheLine(line, lineNum) {
  const m = APACHE_RE.exec(line);
  if (!m) return { lineNum, format: "apache", raw: line, parseError: true };

  const month = MONTHS[m[5]] || 1;
  const tsStr = `${m[6]}-${String(month).padStart(2,"0")}-${m[4]}T${m[7]}:${m[8]}:${m[9]}${m[10].slice(0,3)}:${m[10].slice(3)}`;
  const status = parseInt(m[12], 10);
  const bytes  = m[13] === "-" ? 0 : parseInt(m[13], 10);

  // Parse method + path + protocol from request
  const reqParts = m[11].split(" ");
  const method   = reqParts[0] || null;
  const url      = reqParts[1] || null;
  const protocol = reqParts[2] || null;

  // Level from HTTP status
  let levelName = "info";
  if (status >= 500) levelName = "error";
  else if (status >= 400) levelName = "warn";

  return {
    lineNum,
    format:    m[14] !== undefined ? "apache_combined" : "apache_clf",
    timestamp: parseIsoTs(tsStr),
    level:     levelName,
    severity:  LOG_LEVELS.get(levelName) ?? null,
    message:   `${method} ${url} ${status}`,
    fields: {
      client_ip: m[1],
      ident:     m[2] === "-" ? null : m[2],
      user:      m[3] === "-" ? null : m[3],
      method,
      url,
      protocol,
      status,
      bytes,
      referer:    m[14] ?? null,
      user_agent: m[15] ?? null,
    },
    raw: line,
  };
}

// ── Syslog RFC5424 parser ─────────────────────────────────────────────────────
// <PRI>VERSION TIMESTAMP HOSTNAME APP-NAME PROCID MSGID [STRUCTURED-DATA] MSG
const SYSLOG5424_RE = /^<(\d+)>(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(?:(\[.*?\])\s+)?(.*)$/s;

const SYSLOG_SEVERITY = ["emerg","alert","critical","error","warn","notice","info","debug"];
const SYSLOG_FACILITY = [
  "kern","user","mail","daemon","auth","syslog","lpr","news",
  "uucp","cron","authpriv","ftp","ntp","security","console","solcron",
  "local0","local1","local2","local3","local4","local5","local6","local7",
];

function parseSyslog5424Line(line, lineNum) {
  const m = SYSLOG5424_RE.exec(line);
  if (!m) return { lineNum, format: "syslog5424", raw: line, parseError: true };

  const pri      = parseInt(m[1], 10);
  const facility = Math.floor(pri / 8);
  const sevIdx   = pri % 8;
  const sevName  = SYSLOG_SEVERITY[sevIdx] || "unknown";

  return {
    lineNum,
    format:    "syslog5424",
    timestamp: m[3] === "-" ? null : parseIsoTs(m[3]),
    level:     sevName,
    severity:  LOG_LEVELS.get(sevName) ?? sevIdx,
    message:   m[9]?.trim() || null,
    fields: {
      priority:   pri,
      facility:   SYSLOG_FACILITY[facility] || String(facility),
      version:    parseInt(m[2], 10),
      hostname:   m[4] === "-" ? null : m[4],
      app_name:   m[5] === "-" ? null : m[5],
      proc_id:    m[6] === "-" ? null : m[6],
      msg_id:     m[7] === "-" ? null : m[7],
      structured: m[8] || null,
    },
    raw: line,
  };
}

// ── Syslog RFC3164 parser ─────────────────────────────────────────────────────
// <PRI>MONTH DAY HH:MM:SS HOSTNAME [TAG[PID]]: MSG
const SYSLOG3164_RE = /^<(\d+)>([A-Z][a-z]{2})\s+(\d+)\s+(\d{2}:\d{2}:\d{2})\s+(\S+)\s+(\S+?)(?:\[(\d+)\])?:\s+(.*)/s;
const SYSLOG3164_NOHEAD_RE = /^([A-Z][a-z]{2})\s+(\d+)\s+(\d{2}:\d{2}:\d{2})\s+(\S+)\s+(\S+?)(?:\[(\d+)\])?:\s+(.*)/s;

function parseSyslog3164Line(line, lineNum) {
  let m = SYSLOG3164_RE.exec(line);
  let pri = null;
  let month, day, time, hostname, tag, pid, msg;

  if (m) {
    pri = parseInt(m[1], 10);
    [,, month, day, time, hostname, tag, pid, msg] = m;
  } else {
    m = SYSLOG3164_NOHEAD_RE.exec(line);
    if (!m) return { lineNum, format: "syslog3164", raw: line, parseError: true };
    [, month, day, time, hostname, tag, pid, msg] = m;
  }

  const sevIdx  = pri !== null ? (pri % 8) : 6; // default info
  const sevName = SYSLOG_SEVERITY[sevIdx] || "info";
  const monthNum = MONTHS[month] || 1;
  const year = new Date().getFullYear();
  const tsStr = `${year}-${String(monthNum).padStart(2,"0")}-${String(day).padStart(2,"0")}T${time}`;

  return {
    lineNum,
    format:    "syslog3164",
    timestamp: parseIsoTs(tsStr),
    level:     sevName,
    severity:  LOG_LEVELS.get(sevName) ?? sevIdx,
    message:   msg?.trim() || null,
    fields: {
      priority: pri,
      facility: pri !== null ? (SYSLOG_FACILITY[Math.floor(pri / 8)] || String(Math.floor(pri / 8))) : null,
      hostname,
      tag,
      pid: pid ? parseInt(pid, 10) : null,
    },
    raw: line,
  };
}

// ── W3C Extended (IIS) parser ─────────────────────────────────────────────────
// Header lines start with #; #Fields: defines columns
// Data lines are space-separated values
function parseW3cLines(lines) {
  let fields = null;
  const entries = [];
  let lineNum = 0;
  for (const line of lines) {
    lineNum++;
    if (!line.trim()) continue;
    if (line.startsWith("#Fields:")) {
      fields = line.slice(8).trim().split(/\s+/);
      continue;
    }
    if (line.startsWith("#")) continue;
    if (!fields) continue;
    const values = line.split(/\s+/);
    const obj = {};
    fields.forEach((f, i) => { obj[f] = values[i] ?? null; });

    // Build timestamp from date + time fields
    const datePart = obj.date ?? obj["date"] ?? null;
    const timePart = obj.time ?? obj["time"] ?? null;
    const tsStr    = datePart && timePart ? `${datePart}T${timePart}` : (datePart || null);

    // Detect level from sc-status or cs-method
    const status = obj["sc-status"] ? parseInt(obj["sc-status"], 10) : null;
    let levelName = "info";
    if (status !== null && status >= 500) levelName = "error";
    else if (status !== null && status >= 400) levelName = "warn";

    entries.push({
      lineNum,
      format:    "w3c",
      timestamp: tsStr ? parseIsoTs(tsStr) : null,
      level:     levelName,
      severity:  LOG_LEVELS.get(levelName) ?? null,
      message:   status !== null ? `${obj["cs-method"] || ""}${obj["cs-uri-stem"] ? " " + obj["cs-uri-stem"] : ""} ${status}`.trim() : line,
      fields:    obj,
      raw:       line,
    });
  }
  return entries;
}

// ── ISO-timestamp / common format parser ──────────────────────────────────────
// Handles: "2023-01-01T00:00:00.000Z INFO message"
//          "2023-01-01 00:00:00,000 [ERROR] (thread) message"
//          "[2023-01-01 00:00:00] WARN message"
const ISO_LOG_RE = /^\[?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\]?\s*(?:\[?(TRACE|VERBOSE|DEBUG|DBG|INFO|INFORMATION|NOTICE|WARN|WARNING|ERR|ERROR|CRITICAL|CRIT|FATAL|FTL|ALERT|EMERG|PANIC)\]?)?\s*(.*)/i;

function parseIsoLogLine(line, lineNum) {
  const m = ISO_LOG_RE.exec(line);
  if (!m) return { lineNum, format: "iso_timestamp", raw: line, parseError: true };

  const ts  = m[1];
  const lvl = m[2] || null;
  const msg = m[3] || "";
  const level = normLevel(lvl);

  return {
    lineNum,
    format:    "iso_timestamp",
    timestamp: parseIsoTs(ts),
    level:     level?.name ?? null,
    severity:  level?.severity ?? null,
    message:   msg.trim() || null,
    fields:    {},
    raw:       line,
  };
}

// ── Unix-timestamp prefix parser ──────────────────────────────────────────────
const UNIX_TS_RE = /^(\d{10}(?:\.\d+)?)\s+(.*)/s;

function parseUnixTsLine(line, lineNum) {
  const m = UNIX_TS_RE.exec(line);
  if (!m) return { lineNum, format: "unix_ts", raw: line, parseError: true };

  const ts  = parseFloat(m[1]);
  const rest = m[2];
  const isoTs = new Date(ts * 1000).toISOString();

  // Try to find a level token
  const lvlMatch = rest.match(/^\[?(TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|CRIT|CRITICAL|FATAL|ALERT)\]?/i);
  const level = lvlMatch ? normLevel(lvlMatch[1]) : null;
  const msg = lvlMatch ? rest.slice(lvlMatch[0].length).trim() : rest.trim();

  return {
    lineNum,
    format:    "unix_ts",
    timestamp: isoTs,
    level:     level?.name ?? null,
    severity:  level?.severity ?? null,
    message:   msg || null,
    fields:    {},
    raw:       line,
  };
}

// ── Plain-text fallback parser ────────────────────────────────────────────────
// Tries to extract a level keyword from anywhere in the line
const LEVEL_TOKEN_RE = /\b(TRACE|VERBOSE|DEBUG|DBG|INFO|INFORMATION|NOTICE|WARN|WARNING|ERR(?:OR)?|CRIT(?:ICAL)?|FATAL|FTL|ALERT|EMERG|PANIC)\b/i;
// Also handles [LEVEL] patterns
const LEVEL_BRACKET_RE = /\[(TRACE|VERBOSE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|CRIT(?:ICAL)?|FATAL|ALERT|EMERG|PANIC)\]/i;

function parsePlainLine(line, lineNum) {
  const bm = LEVEL_BRACKET_RE.exec(line);
  const tm = bm ? null : LEVEL_TOKEN_RE.exec(line);
  const raw_level = (bm ?? tm)?.[1] ?? null;
  const level = normLevel(raw_level);
  return {
    lineNum,
    format:   "plain",
    timestamp: null,
    level:    level?.name ?? null,
    severity: level?.severity ?? null,
    message:  line.trim() || null,
    fields:   {},
    raw:      line,
  };
}

// ── Dispatcher ────────────────────────────────────────────────────────────────
function parseLine(line, lineNum, format) {
  if (!line.trim()) return null; // skip blanks
  switch (format) {
    case "jsonl":          return parseJsonlLine(line, lineNum);
    case "apache_combined":
    case "apache_clf":     return parseApacheLine(line, lineNum);
    case "syslog5424":     return parseSyslog5424Line(line, lineNum);
    case "syslog3164":     return parseSyslog3164Line(line, lineNum);
    case "iso_timestamp": return parseIsoLogLine(line, lineNum);
    case "unix_ts":        return parseUnixTsLine(line, lineNum);
    case "w3c":            return null; // w3c handled in bulk
    default:               return parsePlainLine(line, lineNum);
  }
}

// ── Parse all lines, return entries ───────────────────────────────────────────
function parseAllLines(lines, format) {
  if (format === "w3c") {
    return parseW3cLines(lines);
  }
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const entry = parseLine(lines[i], i + 1, format);
    if (entry) entries.push(entry);
  }
  return entries;
}

// ══════════════════════════════════════════════════════════════════════════════
// FILTERING
// ══════════════════════════════════════════════════════════════════════════════

function buildLevelFilter(levelArg) {
  if (!levelArg) return null;
  // min_level means severity >= threshold
  const norm = normLevel(levelArg);
  return norm;
}

function applyFilters(entries, args) {
  let result = entries;

  // Level filter: min_level (severity >=)
  if (args.min_level) {
    const threshold = buildLevelFilter(args.min_level);
    if (threshold && threshold.severity !== null) {
      result = result.filter(e =>
        e.severity !== null && e.severity >= threshold.severity
      );
    }
  }

  // Exact level(s)
  if (args.level) {
    const levels = (Array.isArray(args.level) ? args.level : [args.level])
      .map(l => l.toLowerCase().trim());
    result = result.filter(e => e.level && levels.includes(e.level.toLowerCase()));
  }

  // Time range filters
  if (args.from) {
    const from = new Date(args.from);
    if (!isNaN(from)) {
      result = result.filter(e => e.timestamp && new Date(e.timestamp) >= from);
    }
  }
  if (args.to) {
    const to = new Date(args.to);
    if (!isNaN(to)) {
      result = result.filter(e => e.timestamp && new Date(e.timestamp) <= to);
    }
  }

  // Pattern filter (applied to raw line or message)
  if (args.pattern) {
    let re;
    try {
      re = new RegExp(args.pattern, args.ignore_case ? "i" : "");
    } catch {
      throw new ToolError(`log_client: Invalid pattern regex '${args.pattern}'.`, -32602);
    }
    result = result.filter(e =>
      re.test(e.raw) || (e.message && re.test(e.message))
    );
  }

  // Field filter: field=value exact match or regex
  if (args.field && args.field_value !== undefined) {
    const field = args.field;
    const val   = String(args.field_value);
    result = result.filter(e => {
      const fv = e.fields?.[field] ?? (e[field] !== undefined ? e[field] : null);
      return fv !== null && String(fv) === val;
    });
  }

  return result;
}

// ══════════════════════════════════════════════════════════════════════════════
// OPERATIONS
// ══════════════════════════════════════════════════════════════════════════════

// ── op: info ─────────────────────────────────────────────────────────────────
function opInfo(args) {
  const { resolved, stat } = loadFileMeta(args.path);
  const { lines, total } = readLines(resolved, 200, false);
  const format = detectFormat(lines);

  // Count levels and gather timestamps from a sample
  const entries = parseAllLines(lines, format);
  const levelCounts = {};
  let firstTs = null, lastTs = null;
  for (const e of entries) {
    if (e.level) levelCounts[e.level] = (levelCounts[e.level] || 0) + 1;
    if (e.timestamp) {
      if (!firstTs || e.timestamp < firstTs) firstTs = e.timestamp;
      if (!lastTs  || e.timestamp > lastTs)  lastTs  = e.timestamp;
    }
  }

  // Detect newline style
  const rawHead = fs.readFileSync(resolved, { encoding: "utf8", flag: "r" });
  const hasCRLF = rawHead.includes("\r\n");

  return {
    operation:   "info",
    path:        args.path,
    format,
    totalLines:  total,
    fileSize:    stat.size,
    modified:    stat.mtime.toISOString(),
    newlineStyle: hasCRLF ? "CRLF" : "LF",
    sampleLevelCounts: levelCounts,
    firstTimestamp: firstTs,
    lastTimestamp:  lastTs,
    encoding: "utf-8",
  };
}

// ── op: read ──────────────────────────────────────────────────────────────────
function opRead(args) {
  const { resolved, stat } = loadFileMeta(args.path);
  const offset = typeof args.offset === "number" ? Math.max(0, args.offset) : 0;
  const limit  = typeof args.limit  === "number" ? Math.min(Math.max(1, args.limit), MAX_READ_LINES) : 1000;

  const { lines: rawLines, total, truncated: rawTrunc } = readLines(resolved, MAX_LINES, false);
  const format = args.format || detectFormat(rawLines.slice(0, 100));

  // Parse all and then slice
  let entries = parseAllLines(rawLines, format);
  entries = applyFilters(entries, args);
  const filtered = entries.length;

  const sliced    = entries.slice(offset, offset + limit);
  const truncated = filtered > offset + limit;

  return {
    operation:   "read",
    path:        args.path,
    format,
    totalLines:  total,
    filtered,
    offset,
    limit,
    count:       sliced.length,
    truncated,
    entries:     sliced,
  };
}

// ── op: search ────────────────────────────────────────────────────────────────
function opSearch(args) {
  if (!args.pattern && !args.level && !args.min_level && !args.from && !args.to && args.field === undefined)
    throw new ToolError("log_client: 'search' requires at least one filter (pattern, level, min_level, from, to, or field).", -32602);

  const { resolved, stat } = loadFileMeta(args.path);
  const { lines: rawLines, total } = readLines(resolved, MAX_LINES, false);
  const format = args.format || detectFormat(rawLines.slice(0, 100));

  let entries = parseAllLines(rawLines, format);
  entries = applyFilters(entries, args);

  const cap = Math.min(entries.length, MAX_SEARCH_RESULTS);
  const truncated = entries.length > cap;

  return {
    operation:   "search",
    path:        args.path,
    format,
    totalLines:  total,
    matchCount:  entries.length,
    truncated,
    results:     entries.slice(0, cap),
  };
}

// ── op: stats ─────────────────────────────────────────────────────────────────
function opStats(args) {
  const { resolved, stat } = loadFileMeta(args.path);
  const { lines: rawLines, total } = readLines(resolved, MAX_LINES, false);
  const format = args.format || detectFormat(rawLines.slice(0, 100));

  const entries = parseAllLines(rawLines, format);

  // Level counts
  const levelCounts = {};
  // Per-hour counts (for time series)
  const hourCounts  = {};
  // Top fields
  const fieldVals   = {};
  let parseErrors = 0;
  let firstTs = null, lastTs = null;
  let byteTotal = 0;

  for (const e of entries) {
    byteTotal += (e.raw?.length || 0) + 1;
    if (e.parseError) { parseErrors++; continue; }

    if (e.level) levelCounts[e.level] = (levelCounts[e.level] || 0) + 1;

    if (e.timestamp) {
      if (!firstTs || e.timestamp < firstTs) firstTs = e.timestamp;
      if (!lastTs  || e.timestamp > lastTs)  lastTs  = e.timestamp;
      const hour = e.timestamp.slice(0, 13); // YYYY-MM-DDTHH
      hourCounts[hour] = (hourCounts[hour] || 0) + 1;
    }

    // Gather field stats (top_fields arg)
    const trackFields = args.top_fields || [];
    for (const f of trackFields) {
      const v = e.fields?.[f];
      if (v !== undefined && v !== null) {
        if (!fieldVals[f]) fieldVals[f] = {};
        const key = String(v);
        fieldVals[f][key] = (fieldVals[f][key] || 0) + 1;
      }
    }
  }

  // Sort hourCounts by key for time series
  const timeSeries = Object.entries(hourCounts)
    .sort(([a], [b]) => a < b ? -1 : 1)
    .map(([hour, count]) => ({ hour, count }));

  // Top field values
  const topFields = {};
  for (const [f, vals] of Object.entries(fieldVals)) {
    topFields[f] = Object.entries(vals)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 20)
      .map(([value, count]) => ({ value, count }));
  }

  return {
    operation:      "stats",
    path:           args.path,
    format,
    totalLines:     total,
    parsedEntries:  entries.length,
    parseErrors,
    firstTimestamp: firstTs,
    lastTimestamp:  lastTs,
    levelCounts,
    timeSeries,
    topFields,
  };
}

// ── op: tail ──────────────────────────────────────────────────────────────────
function opTail(args) {
  const { resolved, stat } = loadFileMeta(args.path);
  const n = typeof args.lines === "number" ? Math.min(Math.max(1, args.lines), MAX_TAIL_LINES) : 100;
  const { lines: rawLines, total } = readLines(resolved, n, true); // fromEnd=true
  const format = args.format || detectFormat(rawLines.slice(0, 50));

  const entries = parseAllLines(rawLines, format);
  let filtered = applyFilters(entries, args);

  return {
    operation:  "tail",
    path:       args.path,
    format,
    totalLines: total,
    requested:  n,
    count:      filtered.length,
    entries:    filtered,
  };
}

// ── op: export ────────────────────────────────────────────────────────────────
function opExport(args) {
  const { resolved, stat } = loadFileMeta(args.path);
  const { lines: rawLines, total } = readLines(resolved, MAX_LINES, false);
  const format = args.format_in || args.format || detectFormat(rawLines.slice(0, 100));

  let entries = parseAllLines(rawLines, format);
  entries = applyFilters(entries, args);

  const cap = Math.min(entries.length, MAX_EXPORT);
  const truncated = entries.length > cap;
  const exportEntries = entries.slice(0, cap);

  const outFmt = (args.format_out || "jsonl").toLowerCase();
  let output;

  if (outFmt === "csv") {
    // CSV: timestamp, level, message, raw
    const escCsv = v => {
      if (v == null) return "";
      const s = String(v);
      if (s.includes(",") || s.includes('"') || s.includes("\n")) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };
    const header = "timestamp,level,severity,message,raw";
    const rows = exportEntries.map(e =>
      [e.timestamp, e.level, e.severity, e.message, e.raw].map(escCsv).join(",")
    );
    output = [header, ...rows].join("\n");
  } else if (outFmt === "tsv") {
    const header = "timestamp\tlevel\tseverity\tmessage\traw";
    const rows = exportEntries.map(e =>
      [e.timestamp ?? "", e.level ?? "", e.severity ?? "", e.message ?? "", e.raw ?? ""]
        .map(v => String(v).replace(/\t/g, " "))
        .join("\t")
    );
    output = [header, ...rows].join("\n");
  } else if (outFmt === "jsonl") {
    output = exportEntries.map(e => JSON.stringify(e)).join("\n");
  } else {
    // default: pretty JSON array
    const pretty = args.pretty !== false;
    output = JSON.stringify(exportEntries, null, pretty ? 2 : 0);
  }

  if (args.output_file) {
    const outPath = path.resolve(args.output_file);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, output, "utf8");
    return {
      operation:   "export",
      path:        args.path,
      format_in:   format,
      format_out:  outFmt,
      totalLines:  total,
      exported:    exportEntries.length,
      truncated,
      output_file: args.output_file,
      bytes:       output.length,
    };
  }

  return {
    operation:  "export",
    path:       args.path,
    format_in:  format,
    format_out: outFmt,
    totalLines: total,
    exported:   exportEntries.length,
    truncated,
    bytes:      output.length,
    data:       output,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ══════════════════════════════════════════════════════════════════════════════

function logClient(args) {
  const op = (args.operation || "").trim();
  const VALID_OPS = ["info", "read", "search", "stats", "tail", "export"];
  if (!op)
    throw new ToolError(
      `log_client: 'operation' is required. Valid: ${VALID_OPS.join(", ")}.`, -32602
    );
  if (!VALID_OPS.includes(op))
    throw new ToolError(
      `log_client: unknown operation '${op}'. Valid: ${VALID_OPS.join(", ")}.`, -32602
    );

  switch (op) {
    case "info":   return opInfo(args);
    case "read":   return opRead(args);
    case "search": return opSearch(args);
    case "stats":  return opStats(args);
    case "tail":   return opTail(args);
    case "export": return opExport(args);
    default:
      throw new ToolError(`log_client: unhandled operation '${op}'.`, -32603);
  }
}

module.exports = { logClient };
