"use strict";
// ── CSV_DIFF — row-level diff of two CSV files ──────────────────────────────
// Read-only companion to csv_query/csv_convert (no CSV comparison tool
// existed previously). Two modes:
//   - key_column given: rows matched by that column's value (identity diff —
//     row order/position doesn't matter, matches json_diff's object
//     key-diff semantics applied to CSV rows).
//   - no key_column: rows matched by POSITION (index), same documented
//     by-index convention as json_diff/json_patch_generate — not an
//     LCS/edit-distance diff. Extra right-side rows are 'added' ascending;
//     extra left-side rows are 'removed' descending (highest index first).
//
// Column sets may differ between the two files; the diff runs over the
// UNION of both files' headers (missing cells read as "", matching
// csv_query's convention) so an added/removed column still surfaces as a
// per-cell change rather than being silently ignored.

const fs = require("fs");
const { parseCsvText } = require("./csvOps");
const { ToolError } = require("./errors");

const DEFAULT_MAX_ROWS = 2000;
const HARD_MAX_ROWS    = 20000;

function headersAndData(parsed, hasHeader) {
  if (parsed.length === 0) return { headers: [], data: [] };
  const headers = hasHeader ? parsed[0] : parsed[0].map((_, i) => `col${i}`);
  const dataRows = hasHeader ? parsed.slice(1) : parsed.slice(0);
  const data = dataRows.filter((row) => !(row.length === 1 && row[0] === ""));
  return { headers, data };
}

function toRowObj(row, headers) {
  const obj = {};
  for (let i = 0; i < headers.length; i++) obj[headers[i]] = row[i] ?? "";
  return obj;
}

function unionColumns(a, b) {
  const out = [...a];
  const seen = new Set(a);
  for (const c of b) if (!seen.has(c)) { out.push(c); seen.add(c); }
  return out;
}

function cellDiff(oldObj, newObj, columns) {
  const cells = [];
  for (const col of columns) {
    const oldVal = oldObj[col] ?? "";
    const newVal = newObj[col] ?? "";
    if (oldVal !== newVal) cells.push({ column: col, oldValue: oldVal, newValue: newVal });
  }
  return cells;
}

function readCsv(filePath, side) {
  let raw;
  try { raw = fs.readFileSync(filePath, "utf8"); }
  catch (e) { throw new ToolError(`csv_diff: cannot read ${side} file — ${e.message}`, -32602); }
  return parseCsvText(raw);
}

/**
 * Diff two CSV files.
 * @param {string} leftResolved  Absolute, jail-checked path to the 'before' CSV.
 * @param {string} rightResolved Absolute, jail-checked path to the 'after' CSV.
 * @param {string} leftClientPath  Client-relative path echoed back.
 * @param {string} rightClientPath Client-relative path echoed back.
 * @param {object} [opts]
 * @param {string}  [opts.key_column]  Column name to match rows by. Omit for positional (index) diffing.
 * @param {boolean} [opts.has_header]  Whether row 0 is a header (default: true).
 * @param {number}  [opts.max_rows]    Cap on total added+removed+changed entries enumerated (default 2000, hard cap 20000).
 */
function csvDiff(leftResolved, rightResolved, leftClientPath, rightClientPath, opts = {}) {
  const hasHeader = opts.has_header !== false;
  let maxRows = parseInt(opts.max_rows, 10);
  if (!Number.isFinite(maxRows) || maxRows <= 0) maxRows = DEFAULT_MAX_ROWS;
  maxRows = Math.min(maxRows, HARD_MAX_ROWS);
  const keyColumn = opts.key_column != null ? String(opts.key_column) : null;

  const leftParsed  = readCsv(leftResolved,  "left");
  const rightParsed = readCsv(rightResolved, "right");
  const { headers: leftHeaders,  data: leftData  } = headersAndData(leftParsed,  hasHeader);
  const { headers: rightHeaders, data: rightData } = headersAndData(rightParsed, hasHeader);

  if (keyColumn !== null) {
    if (!leftHeaders.includes(keyColumn) || !rightHeaders.includes(keyColumn))
      throw new ToolError(`csv_diff: key_column '${keyColumn}' not found in both files' headers.`, -32602);
  }

  const columns = unionColumns(leftHeaders, rightHeaders);

  const added = [], removed = [], changed = [];
  const counter = { total: 0 };

  if (keyColumn !== null) {
    const leftObjs  = leftData.map((r) => toRowObj(r, leftHeaders));
    const rightObjs = rightData.map((r) => toRowObj(r, rightHeaders));

    const leftMap = new Map();
    for (const obj of leftObjs) {
      const k = obj[keyColumn];
      if (leftMap.has(k)) throw new ToolError(`csv_diff: duplicate key '${k}' in left file's '${keyColumn}' column — key must be unique.`, -32602);
      leftMap.set(k, obj);
    }
    const rightMap = new Map();
    for (const obj of rightObjs) {
      const k = obj[keyColumn];
      if (rightMap.has(k)) throw new ToolError(`csv_diff: duplicate key '${k}' in right file's '${keyColumn}' column — key must be unique.`, -32602);
      rightMap.set(k, obj);
    }

    for (const [k, obj] of leftMap) {
      if (!rightMap.has(k)) { counter.total++; if (removed.length < maxRows) removed.push({ key: k, row: obj }); }
    }
    for (const [k, obj] of rightMap) {
      if (!leftMap.has(k)) { counter.total++; if (added.length < maxRows) added.push({ key: k, row: obj }); continue; }
      const cells = cellDiff(leftMap.get(k), obj, columns);
      if (cells.length > 0) { counter.total++; if (changed.length < maxRows) changed.push({ key: k, cells }); }
    }
  } else {
    const minLen = Math.min(leftData.length, rightData.length);
    for (let i = 0; i < minLen; i++) {
      const cells = cellDiff(toRowObj(leftData[i], leftHeaders), toRowObj(rightData[i], rightHeaders), columns);
      if (cells.length > 0) { counter.total++; if (changed.length < maxRows) changed.push({ key: i, cells }); }
    }
    for (let i = leftData.length; i < rightData.length; i++) {
      counter.total++;
      if (added.length < maxRows) added.push({ key: i, row: toRowObj(rightData[i], rightHeaders) });
    }
    for (let i = leftData.length - 1; i >= rightData.length; i--) {
      counter.total++;
      if (removed.length < maxRows) removed.push({ key: i, row: toRowObj(leftData[i], leftHeaders) });
    }
  }

  const enumeratedCount = added.length + removed.length + changed.length;

  return {
    left: leftClientPath,
    right: rightClientPath,
    keyColumn,
    hasHeader,
    totalLeftRows: leftData.length,
    totalRightRows: rightData.length,
    identical: counter.total === 0,
    addedCount: added.length,
    removedCount: removed.length,
    changedCount: changed.length,
    truncated: counter.total > enumeratedCount,
    added,
    removed,
    changed,
  };
}

module.exports = { csvDiff };
