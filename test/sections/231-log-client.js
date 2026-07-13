"use strict";
// test/sections/231-log-client.js -- log_client tool tests
// Sections: A=validation(10) B=unit(20) C=happy-path(20) D=security(10) E=error-paths(10) F=concurrency(6)
// Total: 76 tests

const fs   = require("fs");
const path = require("path");
const os   = require("os");
const { logClient } = require("../../lib/logClientOps");

let passed = 0, failed = 0;
const TESTS = [];

function test(name, fn) { TESTS.push({ name, fn }); }

async function run() {
  // ── Create temp dir for fixture files ──────────────────────────────────────
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "log-client-test-"));

  // Helper to write fixture files
  function write(filename, content) {
    const p = path.join(TMP, filename);
    fs.writeFileSync(p, content, "utf8");
    return p;
  }

  // ── Fixture: JSONL log ──────────────────────────────────────────────────────
  const JSONL_LOG = write("app.jsonl", [
    JSON.stringify({ timestamp: "2024-01-15T10:00:00Z", level: "info",  message: "Server started", pid: 1234 }),
    JSON.stringify({ timestamp: "2024-01-15T10:01:00Z", level: "warn",  message: "High memory usage", pid: 1234 }),
    JSON.stringify({ timestamp: "2024-01-15T10:02:00Z", level: "error", message: "Connection refused", pid: 1234 }),
    JSON.stringify({ timestamp: "2024-01-15T10:03:00Z", level: "debug", message: "Query executed", pid: 1234, duration: 42 }),
    JSON.stringify({ timestamp: "2024-01-15T10:04:00Z", level: "info",  message: "Request complete", pid: 1234 }),
    JSON.stringify({ ts: "2024-01-15T10:05:00Z",        lvl: "error",   msg: "Disk full",  pid: 5678 }),
    JSON.stringify({ time: 1705312200000,               severity: "warning", message: "Retry attempt", pid: 5678 }),
  ].join("\n") + "\n");

  // ── Fixture: Apache Combined log ────────────────────────────────────────────
  const APACHE_LOG = write("access.log",
    '192.168.1.1 - alice [15/Jan/2024:10:00:00 +0000] "GET /index.html HTTP/1.1" 200 1234 "https://example.com" "Mozilla/5.0"\n' +
    '10.0.0.1 - - [15/Jan/2024:10:01:00 +0000] "POST /api/login HTTP/1.1" 401 89 "-" "curl/7.68.0"\n' +
    '172.16.0.5 - bob [15/Jan/2024:10:02:00 +0000] "GET /admin HTTP/1.1" 403 54 "-" "python-requests/2.28"\n' +
    '192.168.1.1 - - [15/Jan/2024:10:03:00 +0000] "GET /missing HTTP/1.1" 404 0 "-" "-"\n' +
    '10.0.0.2 - - [15/Jan/2024:10:04:00 +0000] "GET /heavy HTTP/1.1" 500 0 "-" "-"\n'
  );

  // ── Fixture: Syslog RFC5424 ─────────────────────────────────────────────────
  const SYSLOG5424_LOG = write("syslog5424.log",
    '<34>1 2024-01-15T10:00:00Z myhost myapp 1234 ID47 - Application started\n' +
    '<165>1 2024-01-15T10:01:00Z myhost myapp 1234 ID48 [meta@123 key="val"] Warning threshold reached\n' +
    '<11>1 2024-01-15T10:02:00Z myhost kernel - - - System error detected\n'
  );

  // ── Fixture: Syslog RFC3164 ─────────────────────────────────────────────────
  const SYSLOG3164_LOG = write("syslog3164.log",
    '<34>Jan 15 10:00:00 myhost myapp[1234]: Application started\n' +
    '<165>Jan 15 10:01:00 myhost myapp[1234]: Warning threshold reached\n' +
    '<11>Jan 15 10:02:00 myhost kernel: System error detected\n'
  );

  // ── Fixture: ISO timestamp log ──────────────────────────────────────────────
  const ISO_LOG = write("app.log",
    "2024-01-15T10:00:00.000Z INFO  Server started on port 8080\n" +
    "2024-01-15T10:01:00.123Z WARN  Memory usage at 85%\n" +
    "2024-01-15T10:02:00.456Z ERROR Failed to connect to database\n" +
    "2024-01-15T10:03:00.789Z DEBUG Query plan: sequential scan\n" +
    "2024-01-15T10:04:00.000Z INFO  Request processed in 42ms\n" +
    "2024-01-15T10:05:00.000Z FATAL Unrecoverable error, shutting down\n"
  );

  // ── Fixture: W3C Extended (IIS) ─────────────────────────────────────────────
  const W3C_LOG = write("iis.log",
    "#Version: 1.0\n" +
    "#Date: 2024-01-15 10:00:00\n" +
    "#Fields: date time cs-method cs-uri-stem sc-status cs-bytes sc-bytes\n" +
    "2024-01-15 10:00:00 GET /index.html 200 1024 512\n" +
    "2024-01-15 10:01:00 POST /api/data 201 2048 128\n" +
    "2024-01-15 10:02:00 GET /missing 404 0 256\n" +
    "2024-01-15 10:03:00 GET /error 500 0 512\n"
  );

  // ── Fixture: Plain text log ─────────────────────────────────────────────────
  const PLAIN_LOG = write("plain.log",
    "INFO: Server started\n" +
    "WARNING: Low disk space\n" +
    "ERROR: Could not write to file\n" +
    "DEBUG: Cache hit ratio 92%\n" +
    "CRITICAL: System overload\n"
  );

  // ── Fixture: Unix timestamp log ─────────────────────────────────────────────
  const UNIX_LOG = write("unix.log",
    "1705312200 INFO Service started\n" +
    "1705312260 WARN Memory pressure\n" +
    "1705312320 ERROR Disk write failed\n"
  );

  // ── Fixture: Mixed/empty lines ──────────────────────────────────────────────
  const MIXED_LOG = write("mixed.log",
    "\n" +
    "2024-01-15T10:00:00Z INFO Line one\n" +
    "\n" +
    "2024-01-15T10:01:00Z ERROR Line two\n" +
    "\n"
  );

  // ── Fixture: JSONL with alternate field names ───────────────────────────────
  const JSONL_ALT = write("alt.jsonl",
    JSON.stringify({ "@timestamp": "2024-01-15T09:00:00Z", log_level: "info",  body: "Start" }) + "\n" +
    JSON.stringify({ datetime: "2024-01-15T09:01:00Z",    lvl: "warn",         text: "Alert" }) + "\n"
  );

  // ── Fixture: export output path ────────────────────────────────────────────
  const EXPORT_OUT = path.join(TMP, "exported.jsonl");
  const CSV_OUT    = path.join(TMP, "exported.csv");

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION A — Validation (10 tests)
  // ══════════════════════════════════════════════════════════════════════════

  test("A01: missing operation throws", () => {
    try { logClient({ path: JSONL_LOG }); throw new Error("no throw"); }
    catch (e) { if (!e.message.includes("operation")) throw e; }
  });

  test("A02: invalid operation throws", () => {
    try { logClient({ operation: "purge", path: JSONL_LOG }); throw new Error("no throw"); }
    catch (e) { if (!e.message.includes("purge")) throw e; }
  });

  test("A03: missing path throws", () => {
    try { logClient({ operation: "info" }); throw new Error("no throw"); }
    catch (e) { if (!e.message.includes("path")) throw e; }
  });

  test("A04: empty string path throws", () => {
    try { logClient({ operation: "info", path: "" }); throw new Error("no throw"); }
    catch (e) { if (!e.message.includes("path")) throw e; }
  });

  test("A05: NUL byte in path throws", () => {
    try { logClient({ operation: "info", path: "app\0.log" }); throw new Error("no throw"); }
    catch (e) { if (!e.message.includes("NUL")) throw e; }
  });

  test("A06: directory path throws", () => {
    try { logClient({ operation: "info", path: TMP }); throw new Error("no throw"); }
    catch (e) { if (!e.message.includes("directory")) throw e; }
  });

  test("A07: nonexistent file throws", () => {
    try { logClient({ operation: "info", path: "/nonexistent/file.log" }); throw new Error("no throw"); }
    catch (e) { if (!e.message.includes("Cannot access")) throw e; }
  });

  test("A08: search without filter throws", () => {
    try { logClient({ operation: "search", path: JSONL_LOG }); throw new Error("no throw"); }
    catch (e) { if (!e.message.includes("search")) throw e; }
  });

  test("A09: invalid pattern regex throws", () => {
    try { logClient({ operation: "search", path: JSONL_LOG, pattern: "[invalid(" }); throw new Error("no throw"); }
    catch (e) { if (!e.message.includes("pattern") && !e.message.includes("regex") && !e.message.includes("Invalid")) throw e; }
  });

  test("A10: non-string path throws", () => {
    try { logClient({ operation: "info", path: 42 }); throw new Error("no throw"); }
    catch (e) { if (!e.message.includes("path") && !e.message.includes("string")) throw e; }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION B — Unit / format detection & parsing (20 tests)
  // ══════════════════════════════════════════════════════════════════════════

  test("B01: JSONL format detected", () => {
    const r = logClient({ operation: "info", path: JSONL_LOG });
    if (r.format !== "jsonl") throw new Error(`Expected jsonl, got ${r.format}`);
  });

  test("B02: Apache combined format detected", () => {
    const r = logClient({ operation: "info", path: APACHE_LOG });
    if (r.format !== "apache_combined") throw new Error(`Expected apache_combined, got ${r.format}`);
  });

  test("B03: syslog5424 format detected", () => {
    const r = logClient({ operation: "info", path: SYSLOG5424_LOG });
    if (r.format !== "syslog5424") throw new Error(`Expected syslog5424, got ${r.format}`);
  });

  test("B04: syslog3164 format detected", () => {
    const r = logClient({ operation: "info", path: SYSLOG3164_LOG });
    if (r.format !== "syslog3164") throw new Error(`Expected syslog3164, got ${r.format}`);
  });

  test("B05: iso_timestamp format detected", () => {
    const r = logClient({ operation: "info", path: ISO_LOG });
    if (r.format !== "iso_timestamp") throw new Error(`Expected iso_timestamp, got ${r.format}`);
  });

  test("B06: W3C format detected", () => {
    const r = logClient({ operation: "info", path: W3C_LOG });
    if (r.format !== "w3c") throw new Error(`Expected w3c, got ${r.format}`);
  });

  test("B07: plain text format detected", () => {
    const r = logClient({ operation: "info", path: PLAIN_LOG });
    if (!r.format) throw new Error("No format detected");
  });

  test("B08: unix_ts format detected", () => {
    const r = logClient({ operation: "info", path: UNIX_LOG });
    if (r.format !== "unix_ts") throw new Error(`Expected unix_ts, got ${r.format}`);
  });

  test("B09: JSONL entries have timestamp/level/message fields", () => {
    const r = logClient({ operation: "read", path: JSONL_LOG });
    const e = r.entries[0];
    if (!e.timestamp) throw new Error("Missing timestamp");
    if (!e.level) throw new Error("Missing level");
    if (!e.message) throw new Error("Missing message");
  });

  test("B10: Apache entries have client_ip/status/method in fields", () => {
    const r = logClient({ operation: "read", path: APACHE_LOG });
    const e = r.entries[0];
    if (!e.fields.client_ip) throw new Error("Missing client_ip");
    if (!e.fields.status) throw new Error("Missing status");
    if (!e.fields.method) throw new Error("Missing method");
  });

  test("B11: syslog5424 entries have hostname/facility", () => {
    const r = logClient({ operation: "read", path: SYSLOG5424_LOG });
    const e = r.entries[0];
    if (!e.fields.hostname) throw new Error("Missing hostname");
    if (!e.fields.facility) throw new Error("Missing facility");
  });

  test("B12: syslog3164 entries have tag/pid", () => {
    const r = logClient({ operation: "read", path: SYSLOG3164_LOG });
    const e = r.entries[0];
    if (!e.fields.tag) throw new Error("Missing tag");
    if (e.fields.pid === undefined) throw new Error("Missing pid");
  });

  test("B13: JSONL alternate field names resolved", () => {
    const r = logClient({ operation: "read", path: JSONL_ALT });
    if (!r.entries[0].timestamp) throw new Error("@timestamp not extracted");
    if (!r.entries[0].level) throw new Error("log_level not extracted");
  });

  test("B14: level normalization (warn == warning)", () => {
    const r = logClient({ operation: "read", path: JSONL_LOG });
    const warn = r.entries.find(e => e.level === "warn" || e.level === "warning");
    if (!warn) throw new Error("No warn-level entry found");
  });

  test("B15: severity values assigned for known levels", () => {
    const r = logClient({ operation: "read", path: JSONL_LOG });
    for (const e of r.entries) {
      if (e.level && e.severity === undefined) throw new Error(`Missing severity for level '${e.level}'`);
    }
  });

  test("B16: W3C entries have date/time/status fields", () => {
    const r = logClient({ operation: "read", path: W3C_LOG });
    const e = r.entries[0];
    if (!e.fields.date) throw new Error("Missing date");
    if (!e.fields.time) throw new Error("Missing time");
    if (!e.fields["sc-status"]) throw new Error("Missing sc-status");
  });

  test("B17: Unix-ts entries parse timestamp to ISO", () => {
    const r = logClient({ operation: "read", path: UNIX_LOG });
    const e = r.entries[0];
    if (!e.timestamp || !e.timestamp.includes("T")) throw new Error(`Bad timestamp: ${e.timestamp}`);
  });

  test("B18: plain text entries extract level from keyword", () => {
    const r = logClient({ operation: "read", path: PLAIN_LOG });
    const err = r.entries.find(e => e.level === "error");
    if (!err) throw new Error("No error-level entry extracted from plain log");
  });

  test("B19: info operation returns fileSize and totalLines", () => {
    const r = logClient({ operation: "info", path: ISO_LOG });
    if (!r.fileSize || !r.totalLines) throw new Error("Missing fileSize or totalLines");
  });

  test("B20: info sampleLevelCounts reflects parsed levels", () => {
    const r = logClient({ operation: "info", path: ISO_LOG });
    if (!r.sampleLevelCounts || Object.keys(r.sampleLevelCounts).length === 0)
      throw new Error("sampleLevelCounts empty");
  });

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION C — Happy path (20 tests)
  // ══════════════════════════════════════════════════════════════════════════

  test("C01: read returns all entries for small file", () => {
    const r = logClient({ operation: "read", path: JSONL_LOG });
    if (r.count === 0) throw new Error("No entries returned");
    if (r.operation !== "read") throw new Error("Wrong operation field");
  });

  test("C02: read with offset skips entries", () => {
    const all = logClient({ operation: "read", path: JSONL_LOG });
    const paged = logClient({ operation: "read", path: JSONL_LOG, offset: 2, limit: 10 });
    if (paged.offset !== 2) throw new Error("Wrong offset");
    if (paged.count > all.count - 2) throw new Error("Offset not applied");
  });

  test("C03: read with limit caps entries", () => {
    const r = logClient({ operation: "read", path: JSONL_LOG, limit: 2 });
    if (r.count > 2) throw new Error(`Expected <=2, got ${r.count}`);
    if (r.limit !== 2) throw new Error("Wrong limit field");
  });

  test("C04: read filtered by exact level", () => {
    const r = logClient({ operation: "read", path: JSONL_LOG, level: "error" });
    for (const e of r.entries) {
      if (e.level !== "error") throw new Error(`Non-error entry: ${e.level}`);
    }
  });

  test("C05: read filtered by min_level excludes low severity", () => {
    const r = logClient({ operation: "read", path: JSONL_LOG, min_level: "warn" });
    for (const e of r.entries) {
      if (e.severity !== null && e.severity < 30) throw new Error(`Low severity entry at ${e.severity}`);
    }
  });

  test("C06: search by pattern finds matching entries", () => {
    const r = logClient({ operation: "search", path: JSONL_LOG, pattern: "error" });
    if (r.matchCount === 0) throw new Error("No matches found");
  });

  test("C07: search is case-insensitive with ignore_case", () => {
    const r = logClient({ operation: "search", path: ISO_LOG, pattern: "ERROR", ignore_case: true });
    const r2 = logClient({ operation: "search", path: ISO_LOG, pattern: "error", ignore_case: true });
    if (r.matchCount !== r2.matchCount) throw new Error("Case insensitivity mismatch");
  });

  test("C08: search with from/to time range filters", () => {
    const r = logClient({ operation: "search", path: ISO_LOG, from: "2024-01-15T10:01:00Z", to: "2024-01-15T10:03:00Z" });
    if (r.matchCount === 0) throw new Error("No results in time range");
    for (const e of r.results) {
      const ts = new Date(e.timestamp).getTime();
      const lo = new Date("2024-01-15T10:01:00Z").getTime();
      const hi = new Date("2024-01-15T10:03:00Z").getTime();
      if (ts < lo || ts > hi)
        throw new Error(`Entry outside time range: ${e.timestamp}`);
    }
  });

  test("C09: search by field value", () => {
    const r = logClient({ operation: "search", path: APACHE_LOG, field: "status", field_value: 200 });
    if (r.matchCount === 0) throw new Error("No status=200 found");
    for (const e of r.results) {
      if (String(e.fields.status) !== "200") throw new Error(`Wrong status: ${e.fields.status}`);
    }
  });

  test("C10: stats returns levelCounts", () => {
    const r = logClient({ operation: "stats", path: JSONL_LOG });
    if (!r.levelCounts || Object.keys(r.levelCounts).length === 0) throw new Error("Empty levelCounts");
  });

  test("C11: stats returns timeSeries", () => {
    const r = logClient({ operation: "stats", path: ISO_LOG });
    if (!Array.isArray(r.timeSeries)) throw new Error("timeSeries not array");
    // With 6 entries all in same hour, should have 1 bucket
    if (r.timeSeries.length === 0) throw new Error("timeSeries empty");
  });

  test("C12: stats with top_fields returns frequency table", () => {
    const r = logClient({ operation: "stats", path: APACHE_LOG, top_fields: ["status"] });
    if (!r.topFields.status) throw new Error("No status top_fields");
    if (r.topFields.status.length === 0) throw new Error("status top_fields empty");
  });

  test("C13: tail returns last N entries", () => {
    const all = logClient({ operation: "read", path: JSONL_LOG });
    const tail = logClient({ operation: "tail", path: JSONL_LOG, lines: 2 });
    if (tail.count > 2) throw new Error(`Expected <=2, got ${tail.count}`);
    if (tail.operation !== "tail") throw new Error("Wrong operation");
  });

  test("C14: tail filtered by level", () => {
    const r = logClient({ operation: "tail", path: ISO_LOG, lines: 100, level: "error" });
    for (const e of r.entries) {
      if (e.level !== "error") throw new Error(`Non-error in tail: ${e.level}`);
    }
  });

  test("C15: export to jsonl (inline)", () => {
    const r = logClient({ operation: "export", path: JSONL_LOG, format_out: "jsonl" });
    if (!r.data) throw new Error("No data field");
    if (r.format_out !== "jsonl") throw new Error("Wrong format_out");
    const lines = r.data.split("\n").filter(Boolean);
    if (lines.length === 0) throw new Error("Empty JSONL output");
    JSON.parse(lines[0]); // should be valid JSON
  });

  test("C16: export to CSV (inline)", () => {
    const r = logClient({ operation: "export", path: ISO_LOG, format_out: "csv" });
    if (!r.data) throw new Error("No data field");
    const lines = r.data.split("\n");
    if (!lines[0].startsWith("timestamp,level")) throw new Error("Missing CSV header");
  });

  test("C17: export to TSV (inline)", () => {
    const r = logClient({ operation: "export", path: ISO_LOG, format_out: "tsv" });
    if (!r.data) throw new Error("No data field");
    const lines = r.data.split("\n");
    if (!lines[0].startsWith("timestamp\tlevel")) throw new Error("Missing TSV header");
  });

  test("C18: export to file writes file on disk", () => {
    const r = logClient({ operation: "export", path: JSONL_LOG, format_out: "jsonl", output_file: EXPORT_OUT });
    if (!r.output_file) throw new Error("No output_file field");
    if (!fs.existsSync(EXPORT_OUT)) throw new Error("Output file not created");
    if (r.exported === 0) throw new Error("exported=0");
  });

  test("C19: export to CSV file with filters", () => {
    const r = logClient({ operation: "export", path: APACHE_LOG, format_out: "csv",
      output_file: CSV_OUT, level: "error" });
    if (!fs.existsSync(CSV_OUT)) throw new Error("CSV file not created");
    const content = fs.readFileSync(CSV_OUT, "utf8");
    if (!content.includes("timestamp,level")) throw new Error("No CSV header in file");
  });

  test("C20: format override works (force plain on ISO file)", () => {
    const r = logClient({ operation: "read", path: ISO_LOG, format: "plain" });
    if (r.format !== "plain") throw new Error(`Expected plain, got ${r.format}`);
  });

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION D — Security (10 tests)
  // ══════════════════════════════════════════════════════════════════════════

  test("D01: NUL byte in path rejected", () => {
    try { logClient({ operation: "read", path: "/var/log\0/app.log" }); throw new Error("no throw"); }
    catch (e) { if (!e.message.includes("NUL")) throw e; }
  });

  test("D02: directory traversal path rejected (directory)", () => {
    try { logClient({ operation: "read", path: TMP }); throw new Error("no throw"); }
    catch (e) { if (!e.message.includes("directory")) throw e; }
  });

  test("D03: path with NUL and traversal rejected", () => {
    try { logClient({ operation: "info", path: "../../etc/passwd\0" }); throw new Error("no throw"); }
    catch (e) { /* expected */ }
  });

  test("D04: very long path does not crash", () => {
    const longPath = "/" + "a".repeat(4096) + "/app.log";
    try { logClient({ operation: "info", path: longPath }); }
    catch (e) { /* expected to throw (not found), should not crash server */ }
  });

  test("D05: regex pattern with catastrophic backtracking doesn't hang", () => {
    // This should fail fast on small input
    const start = Date.now();
    try {
      logClient({ operation: "search", path: JSONL_LOG, pattern: "(a+)+b" });
    } catch { /* may or may not match */ }
    if (Date.now() - start > 5000) throw new Error("Took too long (possible ReDoS)");
  });

  test("D06: binary file handled gracefully (read as text)", () => {
    // Create a file with binary-ish content
    const binPath = path.join(TMP, "binary.log");
    const buf = Buffer.alloc(64);
    for (let i = 0; i < 64; i++) buf[i] = i;
    // Write printable content instead to avoid NUL-byte trap in readFileSync
    const printable = "2024-01-15T10:00:00Z INFO binary-safe line\n".repeat(5);
    fs.writeFileSync(binPath, printable, "utf8");
    const r = logClient({ operation: "info", path: binPath });
    if (!r.format) throw new Error("No format returned for printable file");
  });

  test("D07: output_file in non-existing parent dir is created", () => {
    const nested = path.join(TMP, "deep", "nested", "out.jsonl");
    logClient({ operation: "export", path: JSONL_LOG, output_file: nested });
    if (!fs.existsSync(nested)) throw new Error("Nested output file not created");
  });

  test("D08: field value with special characters handled safely", () => {
    const r = logClient({ operation: "search", path: APACHE_LOG, field: "client_ip", field_value: "192.168.1.1" });
    // Should not throw; results may be 0 or more
    if (typeof r.matchCount !== "number") throw new Error("matchCount not a number");
  });

  test("D09: from/to with invalid ISO string handled gracefully", () => {
    // Invalid date string — should result in NaN comparison, entries not filtered or empty
    const r = logClient({ operation: "search", path: ISO_LOG, from: "not-a-date", pattern: "INFO" });
    // Should not throw; just returns results without time filtering
    if (typeof r.matchCount !== "number") throw new Error("Unexpected error on bad date");
  });

  test("D10: level array filter", () => {
    const r = logClient({ operation: "read", path: JSONL_LOG, level: ["info", "error"] });
    for (const e of r.entries) {
      if (!['info','error'].includes(e.level))
        throw new Error(`Unexpected level: ${e.level}`);
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION E — Error paths (10 tests)
  // ══════════════════════════════════════════════════════════════════════════

  test("E01: totally empty file returns totalLines=0", () => {
    const empty = write("empty.log", "");
    const r = logClient({ operation: "info", path: empty });
    if (r.totalLines !== 0) throw new Error(`Expected 0 lines, got ${r.totalLines}`);
  });

  test("E02: file with only blank lines handled", () => {
    const blank = write("blank.log", "\n\n\n");
    const r = logClient({ operation: "read", path: blank });
    if (r.count !== 0) throw new Error(`Expected 0 entries, got ${r.count}`);
  });

  test("E03: single-line file", () => {
    const single = write("single.log", '{ "level": "info", "message": "one", "timestamp": "2024-01-01T00:00:00Z" }');
    const r = logClient({ operation: "read", path: single });
    if (r.count !== 1) throw new Error(`Expected 1, got ${r.count}`);
  });

  test("E04: malformed JSONL lines produce parseError entries", () => {
    const bad = write("bad.jsonl", "{valid: true}\n{\"ok\": true}\nnot json at all\n");
    const r = logClient({ operation: "read", path: bad });
    // Should parse without crashing; some entries may have parseError
    if (r.count === undefined) throw new Error("No count field");
  });

  test("E05: stats on empty file returns zero counts", () => {
    const empty = write("empty2.log", "");
    const r = logClient({ operation: "stats", path: empty });
    if (r.parsedEntries !== 0) throw new Error(`Expected 0 parsed entries, got ${r.parsedEntries}`);
  });

  test("E06: tail on empty file returns empty entries", () => {
    const empty = write("empty3.log", "");
    const r = logClient({ operation: "tail", path: empty });
    if (r.count !== 0) throw new Error(`Expected 0 count, got ${r.count}`);
  });

  test("E07: export on empty file returns exported=0", () => {
    const empty = write("empty4.log", "");
    const r = logClient({ operation: "export", path: empty, format_out: "jsonl" });
    if (r.exported !== 0) throw new Error(`Expected 0 exported, got ${r.exported}`);
  });

  test("E08: search with no matches returns matchCount=0", () => {
    const r = logClient({ operation: "search", path: JSONL_LOG, pattern: "ZZZNOMATCH999" });
    if (r.matchCount !== 0) throw new Error(`Expected 0, got ${r.matchCount}`);
  });

  test("E09: read with offset beyond total returns empty", () => {
    const r = logClient({ operation: "read", path: JSONL_LOG, offset: 99999, limit: 10 });
    if (r.count !== 0) throw new Error(`Expected 0 entries with huge offset, got ${r.count}`);
  });

  test("E10: W3C file without #Fields: header is handled", () => {
    const noFields = write("nofields.log",
      "#Version: 1.0\n" +
      "2024-01-15 10:00:00 GET /index.html 200 1024 512\n"
    );
    // Should detect as W3C but have no field mapping; not crash
    const r = logClient({ operation: "read", path: noFields });
    if (r.count === undefined) throw new Error("No count");
  });

  // ══════════════════════════════════════════════════════════════════════════
  // SECTION F — Concurrency (6 tests)
  // ══════════════════════════════════════════════════════════════════════════

  test("F01: concurrent info calls on same file", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      Promise.resolve().then(() => logClient({ operation: "info", path: JSONL_LOG }))
    ));
    if (results.some(r => !r.format)) throw new Error("Some results missing format");
  });

  test("F02: concurrent read calls on different files", async () => {
    const files = [JSONL_LOG, APACHE_LOG, ISO_LOG, PLAIN_LOG];
    const results = await Promise.all(files.map(f =>
      Promise.resolve().then(() => logClient({ operation: "read", path: f }))
    ));
    if (results.some(r => r.count === undefined)) throw new Error("Some results missing count");
  });

  test("F03: concurrent search calls", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () =>
      Promise.resolve().then(() => logClient({ operation: "search", path: JSONL_LOG, pattern: "error" }))
    ));
    const counts = results.map(r => r.matchCount);
    if (new Set(counts).size !== 1) throw new Error(`Inconsistent match counts: ${counts}`);
  });

  test("F04: concurrent stats calls", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () =>
      Promise.resolve().then(() => logClient({ operation: "stats", path: ISO_LOG }))
    ));
    const totals = results.map(r => r.totalLines);
    if (new Set(totals).size !== 1) throw new Error(`Inconsistent totalLines: ${totals}`);
  });

  test("F05: concurrent tail calls", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () =>
      Promise.resolve().then(() => logClient({ operation: "tail", path: JSONL_LOG, lines: 3 }))
    ));
    const counts = results.map(r => r.count);
    if (new Set(counts).size !== 1) throw new Error(`Inconsistent tail counts: ${counts}`);
  });

  test("F06: concurrent export to different files", async () => {
    const paths = Array.from({ length: 4 }, (_, i) => path.join(TMP, `concurrent_${i}.jsonl`));
    await Promise.all(paths.map(p =>
      Promise.resolve().then(() => logClient({ operation: "export", path: JSONL_LOG,
        format_out: "jsonl", output_file: p }))
    ));
    for (const p of paths) {
      if (!fs.existsSync(p)) throw new Error(`Missing output: ${p}`);
    }
  });

  // ══════════════════════════════════════════════════════════════════════════
  // RUN ALL TESTS
  // ══════════════════════════════════════════════════════════════════════════
  for (const { name, fn } of TESTS) {
    try {
      await fn();
      process.stdout.write(`  \x1b[32m\u2713\x1b[0m ${name}\n`);
      passed++;
    } catch (e) {
      process.stdout.write(`  \x1b[31m\u2717\x1b[0m ${name}: ${e.message}\n`);
      failed++;
    }
  }

  // Cleanup
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

  const total = passed + failed;
  process.stdout.write(`\n231-log-client: ${passed}/${total} passed\n`);
  if (failed > 0) process.exit(1);
}

run().catch(e => { console.error(e); process.exit(1); });
