"use strict";
// ── CSV QUERY — parse and query CSV files ────────────────────────────────────
// csv_query: reads a CSV file, parses it per RFC 4180 (quoted fields, embedded
// commas and newlines), and returns rows with optional:
//   - column projection (select subset of columns)
//   - row range (offset + limit)
//   - simple equality filter (column = value, string comparison)
//   - aggregate mode: group_by + aggregate (sum/avg/count/min/max per group)
//
// Non-aggregate mode returns:
//   { path, columns, totalRows, returnedRows, rows: [{col: val, ...}] }
//
// Aggregate mode (triggered by a non-empty `aggregate` array) returns:
//   { path, groupBy, aggregates, totalRows, groupCount, returnedGroups, groups: [...] }
//
// Zero dependencies — pure Node.js built-ins.

const fs = require("fs");
const { ToolError } = require("./errors");

// ─────────────────────────────────────────────────────────────────────────────
//  RFC 4180-compliant CSV parser (handles quoted fields with embedded comma/CR/LF)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a CSV string into an array of string arrays (rows of fields).
 * Supports: CRLF or LF line endings, double-quote escaping (""  → "),
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

// ─────────────────────────────────────────────────────────────────────────────
//  Aggregate support
// ─────────────────────────────────────────────────────────────────────────────

const AGG_OPS = new Set(["sum", "avg", "count", "min", "max"]);
const MAX_AGGREGATES = 20;

/**
 * Validate the `aggregate` argument shape against the strict op allow-list
 * and the known headers. Throws ToolError(-32602) with a clear, specific
 * message on any deviation — never silently coerces or drops a bad entry.
 *
 * @param {Array}    aggregate  Raw `aggregate` argument as supplied by the caller.
 * @param {string[]} headers    Known CSV column names.
 * @returns {{column: string|null, op: string, field: string}[]} Normalised spec list.
 */
function validateAggregateSpec(aggregate, headers) {
  if (!Array.isArray(aggregate) || aggregate.length === 0)
    throw new ToolError("csv_query: 'aggregate' must be a non-empty array.", -32602);
  if (aggregate.length > MAX_AGGREGATES)
    throw new ToolError(`csv_query: 'aggregate' exceeds the maximum of ${MAX_AGGREGATES} entries.`, -32602);

  const seen = new Set();
  const specs = aggregate.map((entry, i) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry))
      throw new ToolError(`csv_query: aggregate[${i}] must be an object like {column, op}.`, -32602);

    const op = entry.op;
    if (typeof op !== "string" || !AGG_OPS.has(op))
      throw new ToolError(`csv_query: aggregate[${i}].op must be one of: ${[...AGG_OPS].join(", ")}. Got: ${JSON.stringify(op)}.`, -32602);

    const requiresColumn = op !== "count";
    let column = entry.column ?? null;
    if (column !== null && typeof column !== "string")
      throw new ToolError(`csv_query: aggregate[${i}].column must be a string when supplied. Got: ${typeof column}.`, -32602);
    if (requiresColumn && !column)
      throw new ToolError(`csv_query: aggregate[${i}].op '${op}' requires a 'column'.`, -32602);
    if (column && !headers.includes(column))
      throw new ToolError(`csv_query: aggregate[${i}].column '${column}' not found. Available columns: ${headers.join(", ")}.`, -32602);

    const field = column ? `${op}_${column}` : op; // e.g. "sum_price" or bare "count"
    if (seen.has(field))
      throw new ToolError(`csv_query: duplicate aggregate result field '${field}' — combine or rename to avoid collision.`, -32602);
    seen.add(field);

    return { column, op, field };
  });

  return specs;
}

/**
 * Parse a cell value as a finite number for a numeric aggregate op.
 * Throws a clear, specific ToolError rather than silently producing NaN.
 */
function parseNumericCell(rawVal, column, op) {
  const trimmed = (rawVal ?? "").trim();
  const n = trimmed === "" ? NaN : Number(trimmed);
  if (!Number.isFinite(n))
    throw new ToolError(`csv_query: cannot compute '${op}' on column '${column}' — non-numeric value ${JSON.stringify(rawVal)} encountered.`, -32602);
  return n;
}

/**
 * Compute one aggregate op over an array of row objects for a given group.
 */
function computeAgg(spec, groupRows) {
  if (spec.op === "count") {
    if (!spec.column) return groupRows.length;
    // count of non-empty values in the given column
    return groupRows.reduce((n, r) => n + ((r[spec.column] ?? "") !== "" ? 1 : 0), 0);
  }

  const values = groupRows.map(r => parseNumericCell(r[spec.column], spec.column, spec.op));

  switch (spec.op) {
    case "sum": return values.reduce((a, b) => a + b, 0);
    case "avg": return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    case "min": return Math.min(...values);
    case "max": return Math.max(...values);
    default:    return null; // unreachable — op already validated
  }
}

/**
 * Group row objects by a column's value (or a single implicit group when
 * groupBy is null) and compute every requested aggregate per group.
 *
 * @param {object[]} rowObjs   Row objects (already filtered/header-mapped).
 * @param {string|null} groupBy  Column name to group by, or null for one overall group.
 * @param {Array}    aggSpecs  Normalised specs from validateAggregateSpec().
 * @returns {{groupCount: number, groups: object[]}}
 */
function aggregateRows(rowObjs, groupBy, aggSpecs) {
  const buckets = new Map(); // key -> row objects in that group

  if (groupBy === null) {
    buckets.set(null, rowObjs);
  } else {
    for (const r of rowObjs) {
      const key = r[groupBy] ?? "";
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(r);
    }
  }

  // Deterministic ordering: sort group keys (null sorts first/alone).
  const keys = [...buckets.keys()].sort((a, b) => {
    if (a === null || b === null) return 0;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  const groups = keys.map(key => {
    const groupRows = buckets.get(key);
    const out = groupBy !== null ? { group: key } : {};
    for (const spec of aggSpecs) out[spec.field] = computeAgg(spec, groupRows);
    return out;
  });

  return { groupCount: groups.length, groups };
}

/**
 * Read and query a CSV file.
 *
 * @param {string}   absPath   Absolute path (jail-validated by caller).
 * @param {string}   origPath  Client path echoed back.
 * @param {object}   [opts]
 * @param {string[]} [opts.columns]     Column names to include in output (default: all). Ignored in aggregate mode.
 * @param {number}   [opts.offset]      Skip first N rows/groups (0-based, default: 0).
 * @param {number}   [opts.limit]       Max rows/groups to return (default: 100, max: 10000).
 * @param {string}   [opts.filter_col]  Column name to filter on.
 * @param {string}   [opts.filter_val]  Value to match (exact, case-sensitive string comparison).
 * @param {boolean}  [opts.has_header]  Whether the first row is a header (default: true).
 * @param {string}   [opts.group_by]    Optional column name to group by (aggregate mode only).
 * @param {Array}    [opts.aggregate]   Optional array of {column, op} — presence triggers aggregate mode.
 * @returns {object}
 */
function csvQuery(absPath, origPath, opts = {}) {
  const hasHeader = opts.has_header !== false;
  const offset    = Math.max(0, Math.trunc(opts.offset ?? 0));
  const limit     = Math.min(Math.max(1, Math.trunc(opts.limit ?? 100)), 10000);
  const selectCols = opts.columns?.length ? opts.columns : null;
  const filterCol  = opts.filter_col ?? null;
  const filterVal  = opts.filter_val ?? null;
  const groupBy    = opts.group_by ?? null;
  const aggregate  = opts.aggregate ?? null;
  const aggregateMode = Array.isArray(aggregate) && aggregate.length > 0;

  if (groupBy !== null && typeof groupBy !== "string")
    throw new ToolError(`csv_query: 'group_by' must be a string. Got: ${typeof groupBy}.`, -32602);
  if (groupBy !== null && !aggregateMode)
    throw new ToolError("csv_query: 'group_by' requires a non-empty 'aggregate' array.", -32602);

  let raw;
  try { raw = fs.readFileSync(absPath, "utf8"); }
  catch (e) { throw new Error(`csv_query: cannot read '${origPath}': ${e.message}`); }

  const parsed = parseCsvText(raw);

  if (parsed.length === 0) {
    if (aggregateMode)
      return { path: origPath, groupBy, aggregates: [], totalRows: 0, groupCount: 0, returnedGroups: 0, groups: [] };
    return { path: origPath, columns: [], totalRows: 0, returnedRows: 0, rows: [] };
  }

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

  // Validate select columns (non-aggregate mode only)
  if (!aggregateMode && selectCols) {
    for (const c of selectCols) {
      if (!headers.includes(c))
        throw new Error(`csv_query: selected column '${c}' not found. Available columns: ${headers.join(", ")}.`);
    }
  }

  // Validate group_by column exists
  if (groupBy !== null && !headers.includes(groupBy))
    throw new ToolError(`csv_query: group_by column '${groupBy}' not found. Available columns: ${headers.join(", ")}.`, -32602);

  const filterColIdx = filterCol !== null ? headers.indexOf(filterCol) : -1;

  // Filter all data rows (shared by both modes)
  const filteredRaw = parsed.slice(dataStart).filter(row => {
    if (row.length === 1 && row[0] === "") return false; // skip trailing blank lines
    if (filterColIdx >= 0) {
      const cellVal = row[filterColIdx] ?? "";
      if (cellVal !== filterVal) return false;
    }
    return true;
  });

  const totalRows = filteredRaw.length;

  if (aggregateMode) {
    const aggSpecs = validateAggregateSpec(aggregate, headers);
    // Map every filtered row to a full {header: value} object once, so both
    // group_by lookups and per-aggregate column access are simple key reads.
    const rowObjs = filteredRaw.map(row => {
      const obj = {};
      for (let i = 0; i < headers.length; i++) obj[headers[i]] = row[i] ?? "";
      return obj;
    });

    const { groupCount, groups: allGroups } = aggregateRows(rowObjs, groupBy, aggSpecs);
    const returnedGroups = allGroups.slice(offset, offset + limit);

    return {
      path:        origPath,
      groupBy,
      aggregates:  aggSpecs.map(s => ({ column: s.column, op: s.op, field: s.field })),
      totalRows,
      groupCount,
      returnedGroups: returnedGroups.length,
      groups: returnedGroups,
    };
  }

  // ── Non-aggregate mode (original behavior, unchanged) ──────────────────────
  const outCols    = selectCols ?? headers;
  const outColIdxs = outCols.map(c => headers.indexOf(c));
  const sliced      = filteredRaw.slice(offset, offset + limit);

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
