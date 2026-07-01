"use strict";
// ── csv_convert — convert a CSV file to JSON or a JSON file (array) to CSV ────
// Complements convert_data (JSON<->YAML) and csv_query (read-only CSV
// querying) by covering the CSV<->JSON round-trip, including a write-back
// destination.
//
// Reuses the existing zero-dep, RFC-4180-compliant `parseCsvText` from
// lib/csvOps.js for the CSV-parsing side (quoted fields, embedded commas/
// newlines, "" escaped-quote handling) rather than reimplementing a parser,
// and the same trailing-blank-line convention csv_query already uses
// (`row.length === 1 && row[0] === ""`) so behavior is consistent across
// both tools.
//
// Source format is auto-detected from the source file's extension (.csv ->
// csv, everything else -> json), same convention as convert_data/query_data,
// and can be overridden with an explicit `format` argument. Target format
// defaults to "the other one" but can be forced with `to`.
//
// CSV -> JSON: with has_header (default true), each data row becomes a
// {header: value} object; with has_header:false, rows are returned as raw
// string arrays instead.
//
// JSON -> CSV: the JSON value must be an array. If every element is a flat
// object, the output column set is the union of keys across all rows (in
// first-seen order) and has_header (default true) controls whether a header
// row is emitted. If every element is itself an array, rows are written
// as-is (has_header/column-union do not apply).
//
// If a `destinationResolved`/`destinationClientPath` pair is supplied, the
// converted text is written there (respecting `apply: false` for a dry-run
// preview) -- same convention as convert_data: without a destination this is
// a pure in-memory conversion/preview (works even under MCP_READ_ONLY), the
// destination-writing path is what's gated (via WRITE_TOOLS).

const fs   = require("fs");
const path = require("path");

const { parseCsvText } = require("./csvOps");
const { ToolError }    = require("./errors");

const VALID_FORMATS = new Set(["csv", "json"]);

function detectFormat(clientPath) {
  const ext = path.extname(clientPath || "").toLowerCase();
  return ext === ".csv" ? "csv" : "json";
}

// Quote a CSV field iff it contains a comma, double-quote, or line break;
// embedded double-quotes are doubled per RFC 4180.
function csvField(val) {
  const s = (val === null || val === undefined) ? "" : String(val);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function csvToJsonValue(raw, hasHeader) {
  const parsed = parseCsvText(raw).filter(row => !(row.length === 1 && row[0] === ""));

  if (!hasHeader) return parsed;

  if (parsed.length === 0) return [];
  const headers = parsed[0];
  return parsed.slice(1).map(row => {
    const obj = {};
    for (let i = 0; i < headers.length; i++) obj[headers[i]] = row[i] ?? "";
    return obj;
  });
}

function jsonValueToCsv(value, hasHeader) {
  if (!Array.isArray(value)) {
    throw new ToolError("csv_convert: JSON source must be an array (of flat objects, or of arrays) to convert to CSV.", -32602);
  }
  if (value.length === 0) return "";

  const allArrays = value.every(row => Array.isArray(row));
  if (allArrays) {
    const lines = value.map(row => row.map(csvField).join(","));
    return lines.join("\r\n") + "\r\n";
  }

  // Array-of-objects mode. Reject a mixed/invalid shape explicitly rather
  // than silently coercing (e.g. a stray array element, or a primitive).
  const columns = [];
  const seen = new Set();
  for (const row of value) {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      throw new ToolError("csv_convert: to convert JSON to CSV, every array element must be a flat object, or every element must be an array. Mixed/invalid shapes are not supported.", -32602);
    }
    for (const k of Object.keys(row)) {
      if (!seen.has(k)) { seen.add(k); columns.push(k); }
    }
  }

  const lines = [];
  if (hasHeader) lines.push(columns.map(csvField).join(","));
  for (const row of value) {
    lines.push(columns.map(c => csvField(row[c])).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

/**
 * @param {string} srcResolved       absolute path to the source file on disk
 * @param {string} srcClientPath     original client-facing path (for echo + format detection)
 * @param {object} opts
 * @param {string} [opts.format]     force source format ("csv"|"json") instead of auto-detecting by extension
 * @param {string} [opts.to]         target format ("csv"|"json"); defaults to the format that isn't the source's
 * @param {boolean}[opts.has_header] CSV<->JSON header handling (default true) -- see module doc comment
 * @param {number} [opts.indent]     JSON output indent (default 2, clamped to >= 0); ignored for csv target
 * @param {string} [opts.destinationResolved]   absolute path to write the converted text to
 * @param {string} [opts.destinationClientPath] client-facing destination path (echoed back)
 * @param {boolean}[opts.apply]      when a destination is given, false = dry-run preview only (default true)
 * @returns {{path, sourceFormat, targetFormat, hasHeader, indent, converted, destination?, written?}}
 */
function csvConvert(srcResolved, srcClientPath, opts = {}) {
  const sourceFormat = opts.format || detectFormat(srcClientPath);
  if (!VALID_FORMATS.has(sourceFormat)) {
    throw new ToolError(`csv_convert: unsupported source format '${sourceFormat}'. Must be 'csv' or 'json'.`, -32602);
  }

  const targetFormat = opts.to || (sourceFormat === "csv" ? "json" : "csv");
  if (!VALID_FORMATS.has(targetFormat)) {
    throw new ToolError(`csv_convert: unsupported target format '${targetFormat}'. Must be 'csv' or 'json'.`, -32602);
  }
  if (sourceFormat === targetFormat) {
    throw new ToolError(`csv_convert: source and target format are both '${sourceFormat}' -- nothing to convert. Use 'to' to pick the other format.`, -32602);
  }

  const stat = fs.statSync(srcResolved);
  if (stat.isDirectory()) {
    throw new ToolError(`csv_convert: '${srcClientPath}' is a directory, not a file.`, -32602);
  }

  const raw = fs.readFileSync(srcResolved, "utf8");
  const hasHeader = opts.has_header !== false;

  let indent = opts.indent != null ? Math.trunc(opts.indent) : 2;
  if (!Number.isFinite(indent) || indent < 0) indent = 2;

  let converted;
  let value;
  try {
    if (sourceFormat === "csv") {
      value = csvToJsonValue(raw, hasHeader);
      converted = JSON.stringify(value, null, indent) + "\n";
    } else {
      try { value = JSON.parse(raw); }
      catch (e) { throw new Error(`failed to parse source as json: ${e.message}`); }
      converted = jsonValueToCsv(value, hasHeader);
    }
  } catch (e) {
    if (e instanceof ToolError) throw e;
    throw new Error(`csv_convert: ${e.message}`);
  }

  const result = {
    path: srcClientPath,
    sourceFormat,
    targetFormat,
    hasHeader,
    indent: targetFormat === "json" ? indent : undefined,
    converted,
  };

  if (opts.destinationResolved) {
    const apply = opts.apply !== false;
    result.destination = opts.destinationClientPath;
    result.written = false;
    if (apply) {
      fs.mkdirSync(path.dirname(opts.destinationResolved), { recursive: true });
      fs.writeFileSync(opts.destinationResolved, converted, "utf8");
      result.written = true;
    }
  }

  return result;
}

module.exports = { csvConvert, detectFormat };
