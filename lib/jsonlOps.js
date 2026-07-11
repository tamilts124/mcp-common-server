"use strict";
// ── jsonl_ops: JSONL (newline-delimited JSON) file operations ────────────────────
// Zero npm dependencies. Operations: parse, count, head, tail, sample,
// validate, filter, transform, sort, merge, to_json.
// Input limits: 100 000 lines per file; output truncated at 10 000 rows.

const fs   = require("fs");
const path = require("path");
const { ToolError } = require("./errors");

const MAX_INPUT_LINES  = 100_000;
const MAX_OUTPUT_ROWS  = 10_000;
const MAX_FILE_BYTES   = 50 * 1024 * 1024; // 50 MB

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Parse JSONL text into rows, tracking valid/invalid/blank counts.
 * @param {string} text
 * @returns {{ rows: object[], validCount: number, invalidCount: number,
 *             blankCount: number, errors: object[], totalLines: number }}
 */
function parseText(text) {
  const lines = text.split("\n");
  const rows  = [];
  let validCount = 0, invalidCount = 0, blankCount = 0;
  const errors = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) { blankCount++; continue; }
    try {
      rows.push(JSON.parse(trimmed));
      validCount++;
    } catch (e) {
      invalidCount++;
      errors.push({ lineNumber: i + 1, raw: trimmed.slice(0, 200), error: e.message });
    }
  }
  return { rows, validCount, invalidCount, blankCount, errors, totalLines: lines.length };
}

/**
 * Read a JSONL file, enforce byte + line limits.
 */
function readJsonlFile(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_FILE_BYTES)
    throw new ToolError(
      `jsonl_ops: file '${path.basename(filePath)}' exceeds ${MAX_FILE_BYTES / 1024 / 1024} MB limit.`,
      -32602
    );
  const text = fs.readFileSync(filePath, "utf8");
  const result = parseText(text);
  if (result.rows.length > MAX_INPUT_LINES)
    throw new ToolError(
      `jsonl_ops: file contains more than ${MAX_INPUT_LINES} valid lines.`,
      -32602
    );
  return result;
}

/**
 * Apply filter conditions to a row array (same logic as tableOps for consistency).
 */
function applyFilter(rows, conditions, logic = "and") {
  if (!Array.isArray(conditions) || conditions.length === 0) return rows;
  return rows.filter((row) => {
    const results = conditions.map(({ field, op, value }) => {
      const v = row[field];
      switch (op) {
        case "eq":          return v === value;
        case "ne":          return v !== value;
        case "lt":          return v <   value;
        case "gt":          return v >   value;
        case "le":          return v <=  value;
        case "ge":          return v >=  value;
        case "contains":    return String(v ?? "").includes(value);
        case "starts_with": return String(v ?? "").startsWith(value);
        case "ends_with":   return String(v ?? "").endsWith(value);
        case "is_null":     return v == null;
        case "not_null":    return v != null;
        case "in":          return Array.isArray(value) && value.includes(v);
        case "not_in":      return Array.isArray(value) && !value.includes(v);
        case "regex":
          try { return new RegExp(value).test(String(v ?? "")); }
          catch { return false; }
        default: return true;
      }
    });
    return logic === "or" ? results.some(Boolean) : results.every(Boolean);
  });
}

/**
 * Reservoir-sample n items from an array (Vitter's Algorithm R).
 * Deterministic when seed is provided (cheap LCG pseudo-random).
 */
function reservoirSample(arr, n, seed) {
  if (n >= arr.length) return arr.slice();
  // Optional reproducible LCG
  let state = (typeof seed === "number" && isFinite(seed)) ? (seed >>> 0) : Math.floor(Math.random() * 0xFFFFFFFF);
  const lcg = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 0x100000000; };
  const rand = (typeof seed === "number" && isFinite(seed)) ? lcg : Math.random.bind(Math);

  const reservoir = arr.slice(0, n);
  for (let i = n; i < arr.length; i++) {
    const j = Math.floor(rand() * (i + 1));
    if (j < n) reservoir[j] = arr[i];
  }
  return reservoir;
}

/**
 * Truncate an output rows array, attaching a `truncated` flag.
 */
function truncate(rows, limit = MAX_OUTPUT_ROWS) {
  const truncated = rows.length > limit;
  return { rows: truncated ? rows.slice(0, limit) : rows, truncated };
}

// ── Main dispatch ───────────────────────────────────────────────────────────────

/**
 * Execute a jsonl_ops operation.
 *
 * @param {object} args
 * @param {Function} resolveClientPath  from roots.js  (path => {resolved})
 * @returns {object}
 */
function jsonlOps(args, resolveClientPath) {
  const { operation } = args;
  if (!operation || typeof operation !== "string")
    throw new ToolError("jsonl_ops: 'operation' is required.", -32602);

  // ── Shared input loading: file OR inline rows ─────────────────────────────
  function loadRows() {
    if (args.rows != null) {
      // Inline rows provided directly (array of objects)
      if (!Array.isArray(args.rows))
        throw new ToolError("jsonl_ops: 'rows' must be an array of objects.", -32602);
      if (args.rows.length > MAX_INPUT_LINES)
        throw new ToolError(`jsonl_ops: inline 'rows' exceeds ${MAX_INPUT_LINES} entry limit.`, -32602);
      return {
        rows:         args.rows,
        validCount:   args.rows.length,
        invalidCount: 0,
        blankCount:   0,
        errors:       [],
        totalLines:   args.rows.length,
        source:       "inline",
      };
    }
    if (args.path != null) {
      const { resolved } = resolveClientPath(args.path);
      const r = readJsonlFile(resolved);
      return { ...r, source: args.path };
    }
    throw new ToolError("jsonl_ops: provide 'path' (file) or 'rows' (inline array).", -32602);
  }

  // ── Operations ────────────────────────────────────────────────────────────────

  switch (operation) {

    // ── parse: load file and return rows (up to MAX_OUTPUT_ROWS) ──────────────
    case "parse": {
      const { rows, validCount, invalidCount, blankCount, errors, totalLines, source } = loadRows();
      const { rows: out, truncated } = truncate(rows);
      return {
        operation, source,
        totalLines, validCount, invalidCount, blankCount,
        returnedRows: out.length,
        truncated,
        rows: out,
        parseErrors: errors.slice(0, 100),
      };
    }

    // ── count: count lines without returning data ─────────────────────────
    case "count": {
      const { validCount, invalidCount, blankCount, totalLines, source } = loadRows();
      return { operation, source, totalLines, validCount, invalidCount, blankCount };
    }

    // ── head: first N rows ──────────────────────────────────────────
    case "head": {
      const n = typeof args.count === "number" && args.count > 0 ? args.count : 10;
      const { rows, validCount, totalLines, source } = loadRows();
      const out = rows.slice(0, Math.min(n, MAX_OUTPUT_ROWS));
      return { operation, source, totalLines, validCount, count: n, returnedRows: out.length, rows: out };
    }

    // ── tail: last N rows ──────────────────────────────────────────
    case "tail": {
      const n = typeof args.count === "number" && args.count > 0 ? args.count : 10;
      const { rows, validCount, totalLines, source } = loadRows();
      const start = Math.max(0, rows.length - n);
      const out = rows.slice(start, rows.length);
      return { operation, source, totalLines, validCount, count: n, returnedRows: out.length, rows: out };
    }

    // ── sample: reservoir-sample N rows ───────────────────────────────
    case "sample": {
      const n = typeof args.count === "number" && args.count > 0 ? Math.min(args.count, MAX_OUTPUT_ROWS) : 10;
      const { rows, validCount, totalLines, source } = loadRows();
      const out = reservoirSample(rows, n, args.seed);
      return { operation, source, totalLines, validCount, count: n, returnedRows: out.length, rows: out };
    }

    // ── validate: return invalid lines ────────────────────────────────
    case "validate": {
      if (!args.path)
        throw new ToolError("jsonl_ops validate: 'path' is required (inline rows are always valid JSON).", -32602);
      const { resolved } = resolveClientPath(args.path);
      const { validCount, invalidCount, blankCount, errors, totalLines } = readJsonlFile(resolved);
      return {
        operation,
        source:       args.path,
        totalLines,   validCount, invalidCount, blankCount,
        valid:        invalidCount === 0,
        errors:       errors.slice(0, MAX_OUTPUT_ROWS),
        truncated:    errors.length > MAX_OUTPUT_ROWS,
      };
    }

    // ── filter: keep rows matching conditions ───────────────────────────
    case "filter": {
      if (!Array.isArray(args.conditions) || args.conditions.length === 0)
        throw new ToolError("jsonl_ops filter: 'conditions' must be a non-empty array.", -32602);
      const { rows, validCount, totalLines, source } = loadRows();
      const filtered = applyFilter(rows, args.conditions, args.logic || "and");
      const { rows: out, truncated } = truncate(filtered);
      return {
        operation, source,
        totalLines, validCount,
        matchedCount: filtered.length,
        returnedRows: out.length,
        truncated,
        rows: out,
      };
    }

    // ── transform: select/rename/drop fields ───────────────────────────
    case "transform": {
      const { rows, validCount, totalLines, source } = loadRows();
      const fields  = Array.isArray(args.fields) ? args.fields : null;   // select
      const mapping = args.mapping && typeof args.mapping === "object" ? args.mapping : null; // rename
      const drop    = args.drop === true;  // if true, fields is a drop-list

      const out = rows.map((row) => {
        let r = row;
        // Select / drop
        if (fields) {
          if (drop) {
            const dropSet = new Set(fields);
            r = Object.fromEntries(Object.entries(r).filter(([k]) => !dropSet.has(k)));
          } else {
            r = Object.fromEntries(fields.map(f => [f, r[f]]));
          }
        }
        // Rename
        if (mapping) {
          const next = {};
          for (const [k, v] of Object.entries(r))
            next[mapping[k] ?? k] = v;
          r = next;
        }
        return r;
      });

      const { rows: result, truncated } = truncate(out);
      return {
        operation, source,
        totalLines, validCount,
        returnedRows: result.length,
        truncated,
        rows: result,
      };
    }

    // ── sort: sort rows by a field ────────────────────────────────────
    case "sort": {
      const field = args.field;
      if (!field || typeof field !== "string")
        throw new ToolError("jsonl_ops sort: 'field' is required.", -32602);
      const dir = (args.dir || args.direction || "asc").toLowerCase();
      const { rows, validCount, totalLines, source } = loadRows();
      const sorted = rows.slice().sort((a, b) => {
        const av = a[field], bv = b[field];
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        const cmp = (typeof av === "number" && typeof bv === "number")
          ? av - bv
          : String(av) < String(bv) ? -1 : String(av) > String(bv) ? 1 : 0;
        return dir === "desc" ? -cmp : cmp;
      });
      const { rows: out, truncated } = truncate(sorted);
      return {
        operation, source,
        totalLines, validCount,
        field, dir,
        returnedRows: out.length,
        truncated,
        rows: out,
      };
    }

    // ── merge: combine multiple JSONL files ────────────────────────────
    case "merge": {
      if (!Array.isArray(args.paths) || args.paths.length === 0)
        throw new ToolError("jsonl_ops merge: 'paths' must be a non-empty array of file paths.", -32602);
      if (args.paths.length > 50)
        throw new ToolError("jsonl_ops merge: 'paths' exceeds 50 file limit.", -32602);

      let allRows = [];
      const fileStats = [];
      for (const p of args.paths) {
        const { resolved } = resolveClientPath(p);
        const r = readJsonlFile(resolved);
        fileStats.push({ path: p, validCount: r.validCount, invalidCount: r.invalidCount, totalLines: r.totalLines });
        allRows = allRows.concat(r.rows);
        if (allRows.length > MAX_INPUT_LINES)
          throw new ToolError(`jsonl_ops merge: merged row count exceeds ${MAX_INPUT_LINES} limit.`, -32602);
      }
      const { rows: out, truncated } = truncate(allRows);
      return {
        operation,
        filesRead:    args.paths.length,
        fileStats,
        totalRows:    allRows.length,
        returnedRows: out.length,
        truncated,
        rows: out,
      };
    }

    // ── to_json: convert JSONL to a JSON array ──────────────────────────
    case "to_json": {
      const { rows, validCount, invalidCount, blankCount, totalLines, errors, source } = loadRows();
      const { rows: out, truncated } = truncate(rows);
      return {
        operation, source,
        totalLines, validCount, invalidCount, blankCount,
        returnedRows: out.length,
        truncated,
        json: out,
        parseErrors: errors.slice(0, 100),
      };
    }

    default:
      throw new ToolError(
        `jsonl_ops: unknown operation '${operation}'. ` +
        `Valid: parse, count, head, tail, sample, validate, filter, transform, sort, merge, to_json.`,
        -32602
      );
  }
}

module.exports = { jsonlOps };
