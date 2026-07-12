"use strict";
// lib/jsonlClientOps.js -- Zero-dependency JSONL/NDJSON file reader/writer/editor
// Operations: read, write, append, get_line, set_line, delete_line,
//             filter, map, aggregate, validate, stringify
//
// JSONL features supported:
//   - RFC-compliant JSONL (one JSON value per line)
//   - NDJSON (newline-delimited JSON) — identical format
//   - Blank lines skipped (not counted as records)
//   - Comment lines (#) optionally supported
//   - Offset/limit pagination
//   - Field projection (select/exclude specific fields)
//   - Filter expressions (field comparisons, regex, type checks)
//   - Map/transform (set field, delete field, compute field)
//   - Aggregate (count, sum, avg, min, max, group_by)
//   - Validation (check each line parses as valid JSON)
//   - Stringify (re-serialise, compact or pretty-print)
//
// Security:
//   - path NUL guard
//   - 4 MB file cap (configurable with max_bytes up to 50 MB)
//   - 1,000,000 line limit
//   - No eval/Function() usage

const fs   = require("fs");
const path = require("path");

// Constants
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;  // 4 MB
const ABSOLUTE_MAX_BYTES = 50 * 1024 * 1024; // 50 MB
const MAX_LINES          = 1_000_000;

// ── Error helper ────────────────────────────────────────────────────────────
function err(msg, code) {
  return Object.assign(new Error(msg), { code });
}

// ── Path helpers ─────────────────────────────────────────────────────────────
function resolvePath(p) {
  if (typeof p !== "string" || p.length === 0)
    throw err("jsonl_client: 'path' must be a non-empty string.", "INVALID_ARG");
  if (p.includes("\0"))
    throw err("jsonl_client: 'path' must not contain NUL bytes.", "INVALID_ARG");
  return path.resolve(p);
}

function readFileSafe(filePath, maxBytes) {
  const cap = Math.min(maxBytes || DEFAULT_MAX_BYTES, ABSOLUTE_MAX_BYTES);
  const stat = fs.statSync(filePath);
  if (stat.size > cap)
    throw err(
      `jsonl_client: file too large (${stat.size} bytes; max ${cap}).`,
      "FILE_TOO_LARGE",
    );
  return fs.readFileSync(filePath, "utf8");
}

// ── JSONL Parser ─────────────────────────────────────────────────────────────
// Returns array of { lineNo (1-based), raw, value } objects.
// lineNo is the physical file line number.
function parseJSONL(text, { allowComments = false } = {}) {
  const records = [];
  const lines   = text.split(/\r?\n/);
  let lineCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();

    // Skip blank lines
    if (trimmed === "") continue;

    // Skip comment lines if enabled
    if (allowComments && trimmed.startsWith("#")) continue;

    if (++lineCount > MAX_LINES)
      throw err(`jsonl_client: file exceeds ${MAX_LINES} line limit.`, "TOO_MANY_LINES");

    let value;
    try {
      value = JSON.parse(raw);
    } catch (e) {
      throw err(
        `jsonl_client: JSON parse error on line ${i + 1}: ${e.message}`,
        "PARSE_ERROR",
      );
    }

    records.push({ lineNo: i + 1, raw, value });
  }

  return records;
}

// ── JSONL Serialiser ──────────────────────────────────────────────────────────
function serialiseJSONL(records, { pretty = false, indent = 2 } = {}) {
  return records
    .map(r => {
      if (pretty) return JSON.stringify(r.value ?? r, null, indent);
      // Use the stored raw if value hasn't changed, otherwise re-serialise
      return JSON.stringify(r.value ?? r);
    })
    .join("\n") + "\n";
}

// ── Field projection ──────────────────────────────────────────────────────────
// select: ['field1','field2'] — include only these fields
// exclude: ['field1'] — exclude these fields
function projectRecord(value, { select, exclude } = {}) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return value;
  if (select && select.length > 0) {
    const result = {};
    for (const k of select) {
      if (Object.prototype.hasOwnProperty.call(value, k))
        result[k] = value[k];
    }
    return result;
  }
  if (exclude && exclude.length > 0) {
    const result = {};
    for (const k of Object.keys(value)) {
      if (!exclude.includes(k)) result[k] = value[k];
    }
    return result;
  }
  return value;
}

// ── Field accessor (supports dot-notation for nested fields) ─────────────────
function getField(obj, fieldPath) {
  if (typeof fieldPath !== "string") return undefined;
  const parts = fieldPath.split(".");
  let cur = obj;
  for (const part of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return cur;
}

function setField(obj, fieldPath, value) {
  if (typeof obj !== "object" || obj === null) return obj;
  const parts = fieldPath.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== "object")
      cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
  return obj;
}

function deleteField(obj, fieldPath) {
  if (typeof obj !== "object" || obj === null) return obj;
  const parts = fieldPath.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null) return obj;
    cur = cur[parts[i]];
  }
  delete cur[parts[parts.length - 1]];
  return obj;
}

// ── Filter evaluator ──────────────────────────────────────────────────────────
// Supported filter: { field, operator, value, ignore_case }
// Operators: eq, neq, gt, gte, lt, lte, contains, not_contains,
//            starts_with, ends_with, regex, exists, not_exists,
//            is_null, is_number, is_string, is_boolean, is_array, is_object
function matchesFilter(record, filter) {
  if (!filter) return true;
  const filters = Array.isArray(filter) ? filter : [filter];

  for (const f of filters) {
    if (!evalFilter(record, f)) return false;
  }
  return true;
}

function evalFilter(record, f) {
  const fieldVal = f.field !== undefined ? getField(record, f.field) : record;
  const op       = f.operator || "eq";
  const icase    = f.ignore_case === true;

  switch (op) {
    case "exists":      return f.field !== undefined
      ? Object.prototype.hasOwnProperty.call(
          getFieldParent(record, f.field), getFieldLastKey(f.field)
        )
      : record !== undefined;
    case "not_exists":  return !evalFilter(record, { ...f, operator: "exists" });
    case "is_null":     return fieldVal === null;
    case "is_number":   return typeof fieldVal === "number";
    case "is_string":   return typeof fieldVal === "string";
    case "is_boolean":  return typeof fieldVal === "boolean";
    case "is_array":    return Array.isArray(fieldVal);
    case "is_object":   return typeof fieldVal === "object" && fieldVal !== null && !Array.isArray(fieldVal);
    case "eq": {
      let a = String(fieldVal ?? ""), b = String(f.value ?? "");
      if (icase) { a = a.toLowerCase(); b = b.toLowerCase(); }
      return a === b;
    }
    case "neq": return !evalFilter(record, { ...f, operator: "eq" });
    case "contains": {
      let a = String(fieldVal ?? ""), b = String(f.value ?? "");
      if (icase) { a = a.toLowerCase(); b = b.toLowerCase(); }
      return a.includes(b);
    }
    case "not_contains": return !evalFilter(record, { ...f, operator: "contains" });
    case "starts_with": {
      let a = String(fieldVal ?? ""), b = String(f.value ?? "");
      if (icase) { a = a.toLowerCase(); b = b.toLowerCase(); }
      return a.startsWith(b);
    }
    case "ends_with": {
      let a = String(fieldVal ?? ""), b = String(f.value ?? "");
      if (icase) { a = a.toLowerCase(); b = b.toLowerCase(); }
      return a.endsWith(b);
    }
    case "gt":  return Number(fieldVal) >  Number(f.value);
    case "gte": return Number(fieldVal) >= Number(f.value);
    case "lt":  return Number(fieldVal) <  Number(f.value);
    case "lte": return Number(fieldVal) <= Number(f.value);
    case "regex": {
      const flags = icase ? "i" : "";
      return new RegExp(String(f.value ?? ""), flags).test(String(fieldVal ?? ""));
    }
    default:
      throw err(
        `jsonl_client: unknown filter operator '${op}'. Valid: eq, neq, gt, gte, lt, lte, ` +
        `contains, not_contains, starts_with, ends_with, regex, exists, not_exists, ` +
        `is_null, is_number, is_string, is_boolean, is_array, is_object.`,
        "INVALID_ARG",
      );
  }
}

function getFieldParent(obj, fieldPath) {
  const parts = fieldPath.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur == null) return {};
    cur = cur[parts[i]];
  }
  return cur || {};
}

function getFieldLastKey(fieldPath) {
  const parts = fieldPath.split(".");
  return parts[parts.length - 1];
}

// ── Aggregate helpers ────────────────────────────────────────────────────────
function computeAggregate(records, { operation, field, group_by }) {
  if (group_by) {
    // Grouped aggregation
    const groups = new Map();
    for (const r of records) {
      const key = JSON.stringify(getField(r.value, group_by));
      if (!groups.has(key)) groups.set(key, { groupKey: getField(r.value, group_by), items: [] });
      groups.get(key).items.push(r.value);
    }
    const result = [];
    for (const { groupKey, items } of groups.values()) {
      const agg = computeSingleAggregate(items.map(v => ({ value: v })), { operation, field });
      result.push({ [group_by]: groupKey, ...agg });
    }
    return { groups: result, groupCount: result.length };
  }
  return computeSingleAggregate(records, { operation, field });
}

function computeSingleAggregate(records, { operation, field }) {
  const vals = field
    ? records.map(r => getField(r.value, field)).filter(v => v !== undefined)
    : records.map(r => r.value);

  switch (operation || "count") {
    case "count":
      return { count: records.length };
    case "sum": {
      const nums = vals.map(Number).filter(n => !isNaN(n));
      return { sum: nums.reduce((a, b) => a + b, 0), count: nums.length };
    }
    case "avg": {
      const nums = vals.map(Number).filter(n => !isNaN(n));
      return {
        avg:   nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null,
        count: nums.length,
      };
    }
    case "min": {
      const nums = vals.map(Number).filter(n => !isNaN(n));
      return { min: nums.length ? Math.min(...nums) : null, count: nums.length };
    }
    case "max": {
      const nums = vals.map(Number).filter(n => !isNaN(n));
      return { max: nums.length ? Math.max(...nums) : null, count: nums.length };
    }
    case "distinct": {
      const seen = new Set(vals.map(v => JSON.stringify(v)));
      return { distinctCount: seen.size, distinct: [...seen].map(v => JSON.parse(v)) };
    }
    case "stats": {
      const nums = vals.map(Number).filter(n => !isNaN(n));
      if (!nums.length) return { count: 0, sum: 0, avg: null, min: null, max: null, stddev: null };
      const sum  = nums.reduce((a, b) => a + b, 0);
      const avg  = sum / nums.length;
      const variance = nums.reduce((a, b) => a + (b - avg) ** 2, 0) / nums.length;
      return {
        count:  nums.length,
        sum,
        avg,
        min:    Math.min(...nums),
        max:    Math.max(...nums),
        stddev: Math.sqrt(variance),
      };
    }
    default:
      throw err(
        `jsonl_client: unknown aggregate operation '${operation}'. Valid: count, sum, avg, min, max, distinct, stats.`,
        "INVALID_ARG",
      );
  }
}

// ── Map/transform helper ─────────────────────────────────────────────────────
// transforms: array of { op, field, value, from, to }
// op: set_field, delete_field, rename_field, copy_field, compute (numeric expression)
function applyTransforms(value, transforms) {
  if (!transforms || !transforms.length) return value;
  // Deep clone to avoid mutation
  let v = JSON.parse(JSON.stringify(value));
  for (const t of transforms) {
    const op = t.op || t.operation;
    switch (op) {
      case "set_field":
        if (!t.field) throw err("jsonl_client: transform set_field requires 'field'.", "INVALID_ARG");
        v = setField(v, t.field, t.value);
        break;
      case "delete_field":
        if (!t.field) throw err("jsonl_client: transform delete_field requires 'field'.", "INVALID_ARG");
        v = deleteField(v, t.field);
        break;
      case "rename_field": {
        if (!t.from || !t.to) throw err("jsonl_client: transform rename_field requires 'from' and 'to'.", "INVALID_ARG");
        const fieldValue = getField(v, t.from);
        v = deleteField(v, t.from);
        v = setField(v, t.to, fieldValue);
        break;
      }
      case "copy_field": {
        if (!t.from || !t.to) throw err("jsonl_client: transform copy_field requires 'from' and 'to'.", "INVALID_ARG");
        v = setField(v, t.to, getField(v, t.from));
        break;
      }
      case "uppercase_field": {
        if (!t.field) throw err("jsonl_client: transform uppercase_field requires 'field'.", "INVALID_ARG");
        const fv = getField(v, t.field);
        if (typeof fv === "string") v = setField(v, t.field, fv.toUpperCase());
        break;
      }
      case "lowercase_field": {
        if (!t.field) throw err("jsonl_client: transform lowercase_field requires 'field'.", "INVALID_ARG");
        const fv2 = getField(v, t.field);
        if (typeof fv2 === "string") v = setField(v, t.field, fv2.toLowerCase());
        break;
      }
      case "trim_field": {
        if (!t.field) throw err("jsonl_client: transform trim_field requires 'field'.", "INVALID_ARG");
        const fv3 = getField(v, t.field);
        if (typeof fv3 === "string") v = setField(v, t.field, fv3.trim());
        break;
      }
      case "add_number": {
        if (!t.field) throw err("jsonl_client: transform add_number requires 'field'.", "INVALID_ARG");
        const fv4 = Number(getField(v, t.field));
        v = setField(v, t.field, fv4 + Number(t.value || 0));
        break;
      }
      case "multiply_number": {
        if (!t.field) throw err("jsonl_client: transform multiply_number requires 'field'.", "INVALID_ARG");
        const fv5 = Number(getField(v, t.field));
        v = setField(v, t.field, fv5 * Number(t.value || 1));
        break;
      }
      default:
        throw err(
          `jsonl_client: unknown transform op '${op}'. Valid: set_field, delete_field, rename_field, copy_field, uppercase_field, lowercase_field, trim_field, add_number, multiply_number.`,
          "INVALID_ARG",
        );
    }
  }
  return v;
}

// ── Operations ────────────────────────────────────────────────────────────────

function opRead(args) {
  const resolved  = resolvePath(args.path);
  const raw       = readFileSafe(resolved, args.max_bytes);
  const records   = parseJSONL(raw, { allowComments: args.allow_comments });

  const offset = Math.max(0, args.offset || 0);
  const limit  = args.limit != null ? Math.max(0, args.limit) : records.length;
  const slice  = records.slice(offset, offset + limit);

  // Apply filter
  const filtered = args.filter
    ? slice.filter(r => { try { return matchesFilter(r.value, args.filter); } catch { return false; } })
    : slice;

  // Apply projection
  const rows = filtered.map(r => projectRecord(r.value, {
    select:  args.select,
    exclude: args.exclude,
  }));

  return {
    path:        args.path,
    totalLines:  records.length,
    offset,
    returned:    rows.length,
    rows,
  };
}

function opWrite(args) {
  if (!Array.isArray(args.rows))
    throw err("jsonl_client: 'rows' must be an array for write.", "INVALID_ARG");

  const resolved = resolvePath(args.path);
  const pretty   = args.pretty === true;
  const indent   = args.indent != null ? args.indent : 2;
  const lines    = args.rows.map((v, i) => {
    try {
      return pretty ? JSON.stringify(v, null, indent) : JSON.stringify(v);
    } catch (e) {
      throw err(`jsonl_client: row ${i} is not JSON-serialisable: ${e.message}`, "INVALID_ARG");
    }
  });

  const text = lines.join("\n") + (lines.length ? "\n" : "");
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, text, "utf8");
  return {
    path:      args.path,
    written:   true,
    rowCount:  args.rows.length,
    byteCount: Buffer.byteLength(text, "utf8"),
  };
}

function opAppend(args) {
  if (!Array.isArray(args.rows) || args.rows.length === 0)
    throw err("jsonl_client: 'rows' must be a non-empty array for append.", "INVALID_ARG");

  const resolved = resolvePath(args.path);
  const pretty   = args.pretty === true;
  const indent   = args.indent != null ? args.indent : 2;
  const lines    = args.rows.map((v, i) => {
    try {
      return pretty ? JSON.stringify(v, null, indent) : JSON.stringify(v);
    } catch (e) {
      throw err(`jsonl_client: row ${i} is not JSON-serialisable: ${e.message}`, "INVALID_ARG");
    }
  });

  const text = lines.join("\n") + "\n";

  // If file exists, check if it ends with newline; if not, prepend one
  let prefix = "";
  try {
    const existing = fs.readFileSync(resolved, "utf8");
    if (existing.length > 0 && !existing.endsWith("\n")) prefix = "\n";
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    // File doesn't exist — will be created
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
  }

  fs.appendFileSync(resolved, prefix + text, "utf8");
  return {
    path:     args.path,
    appended: args.rows.length,
    written:  true,
  };
}

function opGetLine(args) {
  if (args.line_index == null)
    throw err("jsonl_client: 'line_index' is required for get_line.", "INVALID_ARG");

  const resolved = resolvePath(args.path);
  const raw      = readFileSafe(resolved, args.max_bytes);
  const records  = parseJSONL(raw, { allowComments: args.allow_comments });

  const idx = args.line_index;
  if (!Number.isInteger(idx) || idx < 0)
    throw err("jsonl_client: 'line_index' must be a non-negative integer.", "INVALID_ARG");

  if (idx >= records.length)
    return { path: args.path, line_index: idx, found: false, value: null };

  return {
    path:       args.path,
    line_index: idx,
    lineNo:     records[idx].lineNo,
    found:      true,
    value:      records[idx].value,
  };
}

function opSetLine(args) {
  if (args.line_index == null)
    throw err("jsonl_client: 'line_index' is required for set_line.", "INVALID_ARG");
  if (args.value === undefined)
    throw err("jsonl_client: 'value' is required for set_line.", "INVALID_ARG");

  const resolved = resolvePath(args.path);
  const raw      = readFileSafe(resolved, args.max_bytes);
  const records  = parseJSONL(raw, { allowComments: args.allow_comments });

  const idx = args.line_index;
  if (!Number.isInteger(idx) || idx < 0)
    throw err("jsonl_client: 'line_index' must be a non-negative integer.", "INVALID_ARG");

  let serialised;
  try { serialised = JSON.stringify(args.value); }
  catch (e) { throw err(`jsonl_client: 'value' is not JSON-serialisable: ${e.message}`, "INVALID_ARG"); }

  const created = idx >= records.length;
  while (records.length <= idx) records.push({ lineNo: -1, raw: "null", value: null });
  records[idx] = { lineNo: -1, raw: serialised, value: args.value };

  const text = records.map(r => r.raw).join("\n") + "\n";
  const outPath = args.output_path || args.path;
  const outResolved = resolvePath(outPath);
  fs.mkdirSync(path.dirname(outResolved), { recursive: true });
  fs.writeFileSync(outResolved, text, "utf8");
  return { path: args.path, line_index: idx, created, written: true, output_path: outPath };
}

function opDeleteLine(args) {
  if (args.line_index == null && args.line_indices == null)
    throw err("jsonl_client: 'line_index' or 'line_indices' is required for delete_line.", "INVALID_ARG");

  const resolved = resolvePath(args.path);
  const raw      = readFileSafe(resolved, args.max_bytes);
  const records  = parseJSONL(raw, { allowComments: args.allow_comments });

  const toDelete = new Set(
    args.line_indices != null ? args.line_indices : [args.line_index]
  );
  const before  = records.length;
  const kept    = records.filter((_, i) => !toDelete.has(i));
  const deleted = before - kept.length;

  const text = kept.map(r => r.raw).join("\n") + (kept.length ? "\n" : "");
  const outPath = args.output_path || args.path;
  const outResolved = resolvePath(outPath);
  fs.mkdirSync(path.dirname(outResolved), { recursive: true });
  fs.writeFileSync(outResolved, text, "utf8");
  return { path: args.path, deleted, remaining: kept.length, written: true, output_path: outPath };
}

function opFilter(args) {
  if (!args.filter)
    throw err("jsonl_client: 'filter' is required for filter operation.", "INVALID_ARG");

  const resolved = resolvePath(args.path);
  const raw      = readFileSafe(resolved, args.max_bytes);
  const records  = parseJSONL(raw, { allowComments: args.allow_comments });

  const offset   = Math.max(0, args.offset || 0);
  const limit    = args.limit != null ? Math.max(0, args.limit) : records.length;
  const slice    = records.slice(offset, offset + limit);

  const matched = slice.filter(r => {
    try { return matchesFilter(r.value, args.filter); }
    catch { return false; }
  });

  const rows = matched.map(r => projectRecord(r.value, {
    select:  args.select,
    exclude: args.exclude,
  }));

  if (args.output_path) {
    const text       = matched.map(r => r.raw).join("\n") + (matched.length ? "\n" : "");
    const outResolved = resolvePath(args.output_path);
    fs.mkdirSync(path.dirname(outResolved), { recursive: true });
    fs.writeFileSync(outResolved, text, "utf8");
  }

  return {
    path:        args.path,
    totalLines:  records.length,
    scanned:     slice.length,
    matched:     matched.length,
    rows,
    ...(args.output_path ? { written: true, output_path: args.output_path } : { written: false }),
  };
}

function opMap(args) {
  if (!args.transforms || !args.transforms.length)
    throw err("jsonl_client: 'transforms' must be a non-empty array for map.", "INVALID_ARG");

  const resolved = resolvePath(args.path);
  const raw      = readFileSafe(resolved, args.max_bytes);
  const records  = parseJSONL(raw, { allowComments: args.allow_comments });

  // Optionally pre-filter before mapping
  const source = args.filter
    ? records.filter(r => { try { return matchesFilter(r.value, args.filter); } catch { return false; } })
    : records;

  const transformed = source.map(r => {
    const newValue = applyTransforms(r.value, args.transforms);
    const newRaw   = JSON.stringify(newValue);
    return { lineNo: r.lineNo, raw: newRaw, value: newValue };
  });

  const outPath    = args.output_path || args.path;
  const outResolved = resolvePath(outPath);
  const text = transformed.map(r => r.raw).join("\n") + (transformed.length ? "\n" : "");
  fs.mkdirSync(path.dirname(outResolved), { recursive: true });
  fs.writeFileSync(outResolved, text, "utf8");

  return {
    path:         args.path,
    totalLines:   records.length,
    transformed:  transformed.length,
    written:      true,
    output_path:  outPath,
  };
}

function opAggregate(args) {
  const resolved = resolvePath(args.path);
  const raw      = readFileSafe(resolved, args.max_bytes);
  const records  = parseJSONL(raw, { allowComments: args.allow_comments });

  // Apply filter first
  const source = args.filter
    ? records.filter(r => { try { return matchesFilter(r.value, args.filter); } catch { return false; } })
    : records;

  const result = computeAggregate(source, {
    operation: args.aggregate_op || args.operation || "count",
    field:     args.field,
    group_by:  args.group_by,
  });

  return {
    path:       args.path,
    totalLines: records.length,
    scanned:    source.length,
    ...result,
  };
}

function opValidate(args) {
  const resolved = resolvePath(args.path);

  // For validate we must read the file line-by-line and catch individual errors
  const cap  = Math.min(args.max_bytes || DEFAULT_MAX_BYTES, ABSOLUTE_MAX_BYTES);
  const stat = fs.statSync(resolved);
  if (stat.size > cap)
    throw err(`jsonl_client: file too large (${stat.size} bytes; max ${cap}).`, "FILE_TOO_LARGE");

  const text  = fs.readFileSync(resolved, "utf8");
  const lines = text.split(/\r?\n/);
  const errors = [];
  let validCount   = 0;
  let invalidCount = 0;
  let blankCount   = 0;
  let lineCount    = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw     = lines[i];
    const trimmed = raw.trim();

    if (trimmed === "") { blankCount++; continue; }
    if (args.allow_comments && trimmed.startsWith("#")) continue;

    lineCount++;
    try {
      JSON.parse(raw);
      validCount++;
    } catch (e) {
      invalidCount++;
      errors.push({ lineNo: i + 1, logicalIndex: lineCount - 1, error: e.message, raw: raw.slice(0, 200) });
      if (args.max_errors && errors.length >= args.max_errors) break;
    }
  }

  return {
    path:         args.path,
    totalPhysicalLines: lines.length,
    blankLines:   blankCount,
    logicalLines: lineCount,
    validLines:   validCount,
    invalidLines: invalidCount,
    isValid:      invalidCount === 0,
    errors,
  };
}

function opStringify(args) {
  const resolved = resolvePath(args.path);
  const raw      = readFileSafe(resolved, args.max_bytes);
  const records  = parseJSONL(raw, { allowComments: args.allow_comments });

  const pretty = args.pretty === true;
  const indent = args.indent != null ? args.indent : 2;

  const lines = records.map(r =>
    pretty ? JSON.stringify(r.value, null, indent) : JSON.stringify(r.value)
  );
  const text = lines.join("\n") + (lines.length ? "\n" : "");

  if (args.output_path) {
    const outResolved = resolvePath(args.output_path);
    fs.mkdirSync(path.dirname(outResolved), { recursive: true });
    fs.writeFileSync(outResolved, text, "utf8");
    return {
      path:      args.path,
      rowCount:  records.length,
      byteCount: Buffer.byteLength(text, "utf8"),
      written:   true,
      output_path: args.output_path,
      jsonl:     text,
    };
  }
  return {
    path:      args.path,
    rowCount:  records.length,
    byteCount: Buffer.byteLength(text, "utf8"),
    written:   false,
    jsonl:     text,
  };
}

// ── Main Dispatcher ───────────────────────────────────────────────────────────
function jsonlClient(args) {
  if (!args || !args.operation)
    throw err("jsonl_client: 'operation' is required.", "INVALID_ARG");

  switch (args.operation) {
    case "read":      return opRead(args);
    case "write":     return opWrite(args);
    case "append":    return opAppend(args);
    case "get_line":  return opGetLine(args);
    case "set_line":  return opSetLine(args);
    case "delete_line": return opDeleteLine(args);
    case "filter":    return opFilter(args);
    case "map":       return opMap(args);
    case "aggregate": return opAggregate(args);
    case "validate":  return opValidate(args);
    case "stringify": return opStringify(args);
    default:
      throw err(
        `jsonl_client: unknown operation '${args.operation}'. Valid: read, write, append, get_line, set_line, delete_line, filter, map, aggregate, validate, stringify.`,
        "INVALID_ARG",
      );
  }
}

module.exports = {
  jsonlClient,
  // Exported for testing
  parseJSONL,
  serialiseJSONL,
  matchesFilter,
  applyTransforms,
  computeAggregate,
  getField,
  projectRecord,
};
