"use strict";
// ── CSV QUERY — parse and query CSV files ────────────────────────────────────
// csv_query: reads a CSV file, parses it per RFC 4180 (quoted fields, embedded
// commas and newlines), and returns rows with optional:
//   - column projection (select subset of columns)
//   - row range (offset + limit)
//   - simple equality filter (column = value, string comparison)
//
// Returns:
//   { path, columns, totalRows, returnedRows, rows: [{col: val, ...}] }
//
// Zero dependencies — pure Node.js built-ins.

const fs = require("fs");

// ─────────────────────────────────────────────────────────────────────────────
//  RFC 4180-compliant CSV parser (handles quoted fields with embedded comma/CR/LF)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a CSV string into an array of string arrays (rows of fields).
 * Supports: CRLF or LF line endings, double-quote escaping ("" → "),
 * quoted fields containing commas/newlines, and an optional BOM.
 *
 * @param {string} src   Raw CSV text.
 * @returns {string[][]}
 */
function parseCsvText(src) {
  // Strip optional UTF-8 BOM
  if (src.charCodeAt(0) === 0xFEFF) src = src.slice(1);

  const rows = [];
  let pos = 0;
  const len = src.length;

  function parseField() {
    if (pos >= len) return "";
    if (src[pos] === '"') {
      // Quoted field
      pos++; // skip opening quote
      let val = "";
      while (pos < len) {
        if (src[pos] === '"') {
          if (pos + 1 < len && src[pos + 1] === '"') {
            val += '"'; // escaped quote
            pos += 2;
          } else {
            pos++; // closing quote
            break;
          }
        } else {
          val += src[pos++];
        }
      }
      return val;
    } else {
      // Unquoted field — read until comma or newline
      let start = pos;
      while (pos < len && src[pos] !== ',' && src[pos] !== '\n' && src[pos] !== '\r') pos++;
      return src.slice(start, pos);
    }
  }

  while (pos < len) {
    const row = [];
    // Parse one row
    while (true) {
      row.push(parseField());
      if (pos >= len || src[pos] === '\n' || src[pos] === '\r') break;
      if (src[pos] === ',') pos++; // consume comma
    }
    // Skip line terminator (\r\n or \n)
    if (pos < len && src[pos] === '\r') pos++;
    if (pos < len && src[pos] === '\n') pos++;

    rows.push(row);
  }

  return rows;
}

/**
 * Read and query a CSV file.
 *
 * @param {string}   absPath   Absolute path (jail-validated by caller).
 * @param {string}   origPath  Client path echoed back.
 * @param {object}   [opts]
 * @param {string[]} [opts.columns]     Column names to include in output (default: all).
 * @param {number}   [opts.offset]      Skip first N data rows (0-based, default: 0).
 * @param {number}   [opts.limit]       Max rows to return (default: 100, max: 10000).
 * @param {string}   [opts.filter_col]  Column name to filter on.
 * @param {string}   [opts.filter_val]  Value to match (exact, case-sensitive string comparison).
 * @param {boolean}  [opts.has_header]  Whether the first row is a header (default: true).
 * @returns {object}
 */
function csvQuery(absPath, origPath, opts = {}) {
  const hasHeader = opts.has_header !== false;
  const offset    = Math.max(0, Math.trunc(opts.offset ?? 0));
  const limit     = Math.min(Math.max(1, Math.trunc(opts.limit ?? 100)), 10000);
  const selectCols = opts.columns?.length ? opts.columns : null;
  const filterCol  = opts.filter_col ?? null;
  const filterVal  = opts.filter_val ?? null;

  let raw;
  try { raw = fs.readFileSync(absPath, "utf8"); }
  catch (e) { throw new Error(`csv_query: cannot read '${origPath}': ${e.message}`); }

  const parsed = parseCsvText(raw);

  if (parsed.length === 0)
    return { path: origPath, columns: [], totalRows: 0, returnedRows: 0, rows: [] };

  // Determine headers
  let headers;
  let dataStart;
  if (hasHeader) {
    headers   = parsed[0];
    dataStart = 1;
  } else {
    // Generate synthetic column names: col0, col1, ...
    headers   = parsed[0].map((_, i) => `col${i}`);
    dataStart = 0;
  }

  // Validate filter column
  if (filterCol !== null && !headers.includes(filterCol))
    throw new Error(`csv_query: filter column '${filterCol}' not found. Available columns: ${headers.join(", ")}.`);

  // Validate select columns
  if (selectCols) {
    for (const c of selectCols) {
      if (!headers.includes(c))
        throw new Error(`csv_query: selected column '${c}' not found. Available columns: ${headers.join(", ")}.`);
    }
  }

  const filterColIdx = filterCol !== null ? headers.indexOf(filterCol) : -1;
  const outCols      = selectCols ?? headers;
  const outColIdxs   = outCols.map(c => headers.indexOf(c));

  // Filter + project all data rows, then slice
  const dataRows = parsed.slice(dataStart).filter(row => {
    if (row.length === 1 && row[0] === "") return false; // skip trailing blank lines
    if (filterColIdx >= 0) {
      const cellVal = row[filterColIdx] ?? "";
      if (cellVal !== filterVal) return false;
    }
    return true;
  });

  const totalRows = dataRows.length;
  const sliced    = dataRows.slice(offset, offset + limit);

  const rows = sliced.map(row => {
    const obj = {};
    for (let i = 0; i < outCols.length; i++) {
      obj[outCols[i]] = row[outColIdxs[i]] ?? "";
    }
    return obj;
  });

  return {
    path:         origPath,
    columns:      outCols,
    totalRows,
    returnedRows: rows.length,
    rows,
  };
}

module.exports = { csvQuery, parseCsvText };
