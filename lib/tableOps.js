"use strict";
// ── TABLE OPS ─────────────────────────────────────────────────────────────────────────────
// In-memory relational table operations on arrays of JSON objects.
// Zero npm dependencies — pure Node.js.

const { ToolError } = require("./errors");

const MAX_ROWS    = 100_000;
const MAX_RESULTS = 10_000;

const VALID_OPS      = ["info","filter","sort","select","rename","derive","group_by","join","distinct","limit","pivot","unpivot"];
const COMPARE_OPS    = ["eq","ne","lt","gt","le","ge","contains","starts_with","ends_with","regex","is_null","not_null","in","not_in"];
const AGG_OPS        = ["sum","avg","count","min","max","first","last","list","count_distinct","concat_agg"];
const DERIVE_OPS     = ["add","sub","mul","div","concat","upper","lower","trim","cast_number","cast_string","cast_boolean","length","coalesce","template"];
const JOIN_TYPES     = ["inner","left","right","full"];

// ── Validation helpers ─────────────────────────────────────────────────────────────────────

function validateRows(rows, label) {
  if (!Array.isArray(rows))
    throw new ToolError(`table_ops ${label}: 'rows' must be an array of objects.`, -32602);
  if (rows.length > MAX_ROWS)
    throw new ToolError(`table_ops ${label}: too many rows (max ${MAX_ROWS}, got ${rows.length}).`, -32602);
  return rows;
}

function truncate(arr) {
  const truncated = arr.length > MAX_RESULTS;
  return { rows: truncated ? arr.slice(0, MAX_RESULTS) : arr, truncated };
}

// ── filter ───────────────────────────────────────────────────────────────────────────────

function testCondition(row, cond) {
  const { field, op } = cond;
  const value = cond.value;
  const cell  = row[field];
  switch (op) {
    case "eq":          return cell == value;   // loose equality to allow "42" == 42
    case "ne":          return cell != value;
    case "lt":          return Number(cell) < Number(value);
    case "gt":          return Number(cell) > Number(value);
    case "le":          return Number(cell) <= Number(value);
    case "ge":          return Number(cell) >= Number(value);
    case "contains":    return String(cell ?? "").includes(String(value));
    case "starts_with": return String(cell ?? "").startsWith(String(value));
    case "ends_with":   return String(cell ?? "").endsWith(String(value));
    case "regex":       try { return new RegExp(value).test(String(cell ?? "")); } catch { return false; }
    case "is_null":     return cell == null;
    case "not_null":    return cell != null;
    case "in":          return Array.isArray(value) && value.includes(cell);
    case "not_in":      return Array.isArray(value) && !value.includes(cell);
    default: throw new ToolError(`table_ops filter: unknown condition op '${op}'. Valid: ${COMPARE_OPS.join(", ")}.`, -32602);
  }
}

function applyFilter(rows, conditions, logic) {
  return rows.filter(row => {
    const results = conditions.map(c => testCondition(row, c));
    return logic === "or" ? results.some(Boolean) : results.every(Boolean);
  });
}

// ── sort ─────────────────────────────────────────────────────────────────────────────────

function applySort(rows, by) {
  const keys = Array.isArray(by)
    ? by.map(k => typeof k === "string" ? { field: k, dir: "asc" } : k)
    : [{ field: by, dir: "asc" }];
  return [...rows].sort((a, b) => {
    for (const { field, dir } of keys) {
      const mul = dir === "desc" ? -1 : 1;
      const av = a[field], bv = b[field];
      if (av == null && bv == null) continue;
      if (av == null) return 1 * mul;
      if (bv == null) return -1 * mul;
      const cmp = (typeof av === "number" && typeof bv === "number")
        ? av - bv
        : String(av).localeCompare(String(bv));
      if (cmp !== 0) return cmp * mul;
    }
    return 0;
  });
}

// ── select ──────────────────────────────────────────────────────────────────────────────

function applySelect(rows, fields, drop) {
  const fieldSet = new Set(fields);
  return rows.map(row => {
    const out = {};
    for (const [k, v] of Object.entries(row)) {
      if (drop ? !fieldSet.has(k) : fieldSet.has(k)) out[k] = v;
    }
    return out;
  });
}

// ── rename ─────────────────────────────────────────────────────────────────────────────

function applyRename(rows, mapping) {
  return rows.map(row => {
    const out = {};
    for (const [k, v] of Object.entries(row)) out[mapping[k] ?? k] = v;
    return out;
  });
}

// ── derive ─────────────────────────────────────────────────────────────────────────────

function applyDerive(rows, name, op, field, field2, value) {
  if (!DERIVE_OPS.includes(op))
    throw new ToolError(`table_ops derive: unknown op '${op}'. Valid: ${DERIVE_OPS.join(", ")}.`, -32602);
  return rows.map(row => {
    const a = row[field];
    const b = field2 != null ? row[field2] : value;
    let result;
    switch (op) {
      case "add":          result = Number(a) + Number(b); break;
      case "sub":          result = Number(a) - Number(b); break;
      case "mul":          result = Number(a) * Number(b); break;
      case "div":          result = Number(b) !== 0 ? Number(a) / Number(b) : null; break;
      case "concat":       result = String(a ?? "") + String(b ?? ""); break;
      case "upper":        result = a == null ? null : String(a).toUpperCase(); break;
      case "lower":        result = a == null ? null : String(a).toLowerCase(); break;
      case "trim":         result = a == null ? null : String(a).trim(); break;
      case "cast_number":  result = a == null ? null : Number(a); break;
      case "cast_string":  result = a == null ? null : String(a); break;
      case "cast_boolean": result = a == null ? null : Boolean(a); break;
      case "length":       result = a == null ? null : String(a).length; break;
      case "coalesce": {
        const fields = Array.isArray(value) ? value : (field ? [field] : []);
        result = null;
        for (const f of fields) if (row[f] != null) { result = row[f]; break; }
        break;
      }
      case "template":
        result = String(value ?? "").replace(/\{(\w+)\}/g, (_, f) => row[f] ?? "");
        break;
    }
    return { ...row, [name]: result };
  });
}

// ── group_by ───────────────────────────────────────────────────────────────────────────

function applyGroupBy(rows, by, aggregations) {
  const byFields = Array.isArray(by) ? by : [by];
  const groups   = new Map();
  for (const row of rows) {
    const key = byFields.map(f => JSON.stringify(row[f])).join("\0");
    if (!groups.has(key)) {
      groups.set(key, {
        keyObj: byFields.reduce((o, f) => ({ ...o, [f]: row[f] }), {}),
        rows:   [],
      });
    }
    groups.get(key).rows.push(row);
  }
  const result = [];
  for (const { keyObj, rows: gRows } of groups.values()) {
    const out = { ...keyObj };
    for (const agg of aggregations) {
      const { field, op, alias, separator } = agg;
      const outName = alias || `${op}_${field}`;
      const vals    = gRows.map(r => r[field]);
      switch (op) {
        case "count":          out[outName] = gRows.length; break;
        case "count_distinct": out[outName] = new Set(vals.filter(v => v != null)).size; break;
        case "sum":            out[outName] = vals.reduce((a, v) => a + (Number(v) || 0), 0); break;
        case "avg": {
          const nums = vals.filter(v => v != null);
          out[outName] = nums.length ? nums.reduce((a, v) => a + Number(v), 0) / nums.length : null;
          break;
        }
        case "min":            out[outName] = vals.filter(v => v != null).reduce((a, v) => (a == null || v < a) ? v : a, null); break;
        case "max":            out[outName] = vals.filter(v => v != null).reduce((a, v) => (a == null || v > a) ? v : a, null); break;
        case "first":          out[outName] = gRows[0][field] ?? null; break;
        case "last":           out[outName] = gRows[gRows.length - 1][field] ?? null; break;
        case "list":           out[outName] = vals; break;
        case "concat_agg":     out[outName] = vals.filter(v => v != null).join(separator ?? ","); break;
        default: throw new ToolError(`table_ops group_by: unknown agg op '${op}'. Valid: ${AGG_OPS.join(", ")}.`, -32602);
      }
    }
    result.push(out);
  }
  return result;
}

// ── join ────────────────────────────────────────────────────────────────────────────────

function applyJoin(left, right, on, type) {
  const rightIndex = new Map();
  for (const row of right) {
    const k = JSON.stringify(row[on]);
    if (!rightIndex.has(k)) rightIndex.set(k, []);
    rightIndex.get(k).push(row);
  }
  const result          = [];
  const matchedRightKeys = new Set();
  for (const lrow of left) {
    const k     = JSON.stringify(lrow[on]);
    const rrows = rightIndex.get(k);
    if (rrows && rrows.length > 0) {
      for (const rrow of rrows) {
        result.push({ ...rrow, ...lrow }); // left wins on column name conflict
        matchedRightKeys.add(k);
      }
    } else if (type === "left" || type === "full") {
      result.push({ ...lrow });
    }
  }
  if (type === "right" || type === "full") {
    for (const row of right) {
      const k = JSON.stringify(row[on]);
      if (!matchedRightKeys.has(k)) result.push({ ...row });
    }
  }
  return result;
}

// ── pivot ─────────────────────────────────────────────────────────────────────────────

function applyPivot(rows, indexField, keyField, valueField, aggOp) {
  const pivotKeys = [...new Set(rows.map(r => r[keyField]).filter(k => k != null))]
    .sort((a, b) => String(a).localeCompare(String(b)));
  const groups = new Map();
  for (const row of rows) {
    const idx = JSON.stringify(row[indexField]);
    if (!groups.has(idx)) groups.set(idx, { [indexField]: row[indexField], _vals: {} });
    const g    = groups.get(idx);
    const pKey = String(row[keyField]);
    if (!g._vals[pKey]) g._vals[pKey] = [];
    g._vals[pKey].push(row[valueField]);
  }
  const pivotRows = [];
  const op = aggOp || "first";
  for (const g of groups.values()) {
    const out = { [indexField]: g[indexField] };
    for (const pk of pivotKeys) {
      const vals = g._vals[String(pk)] || [];
      switch (op) {
        case "first": out[pk] = vals[0] ?? null; break;
        case "last":  out[pk] = vals[vals.length - 1] ?? null; break;
        case "sum":   out[pk] = vals.reduce((a, v) => a + (Number(v) || 0), 0); break;
        case "count": out[pk] = vals.length; break;
        case "avg":   out[pk] = vals.length ? vals.reduce((a, v) => a + Number(v), 0) / vals.length : null; break;
        case "list":  out[pk] = vals; break;
        default:      out[pk] = vals[0] ?? null;
      }
    }
    pivotRows.push(out);
  }
  return { rows: pivotRows, pivotKeys };
}

// ── unpivot ────────────────────────────────────────────────────────────────────────────

function applyUnpivot(rows, idFields, valueFields, keyName, valueName) {
  const idSet  = new Set(idFields);
  const kName  = keyName   || "key";
  const vName  = valueName || "value";
  const result = [];
  for (const row of rows) {
    const idPart = {};
    for (const [k, v] of Object.entries(row)) if (idSet.has(k)) idPart[k] = v;
    const cols = valueFields && valueFields.length > 0
      ? valueFields
      : Object.keys(row).filter(k => !idSet.has(k));
    for (const col of cols) {
      result.push({ ...idPart, [kName]: col, [vName]: row[col] ?? null });
    }
  }
  return result;
}

// ── info ────────────────────────────────────────────────────────────────────────────────

function tableInfo(rows) {
  if (rows.length === 0) return { rowCount: 0, columnCount: 0, columns: [] };
  const allKeys = new Set();
  for (const row of rows) for (const k of Object.keys(row)) allKeys.add(k);
  const columns = [...allKeys].map(name => {
    const vals  = rows.map(r => r[name]);
    const nVals = vals.filter(v => v != null);
    const types = [...new Set(nVals.map(v => typeof v))];
    return {
      name,
      type:      types.length === 1 ? types[0] : types.length === 0 ? "unknown" : "mixed",
      nullCount: rows.length - nVals.length,
      sample:    nVals.slice(0, 3),
    };
  });
  return { rowCount: rows.length, columnCount: columns.length, columns };
}

// ── Main entry point ──────────────────────────────────────────────────────────────────────

function tableOps(args) {
  const { operation } = args;
  if (!operation) throw new ToolError("table_ops: 'operation' is required.", -32602);
  if (!VALID_OPS.includes(operation))
    throw new ToolError(`table_ops: Unknown operation '${operation}'. Valid: ${VALID_OPS.join(", ")}.`, -32602);

  const rows = validateRows(args.rows || [], operation);

  switch (operation) {

    case "info":
      return { operation, ...tableInfo(rows) };

    case "filter": {
      const { conditions, logic } = args;
      if (!Array.isArray(conditions) || conditions.length === 0)
        throw new ToolError("table_ops filter: 'conditions' array is required and must be non-empty.", -32602);
      for (const c of conditions) {
        if (!c.field) throw new ToolError("table_ops filter: each condition must have a 'field'.", -32602);
        if (!c.op)    throw new ToolError("table_ops filter: each condition must have an 'op'.", -32602);
      }
      const result = applyFilter(rows, conditions, logic);
      const { rows: out, truncated } = truncate(result);
      return { operation, rowCount: result.length, truncated, rows: out };
    }

    case "sort": {
      if (args.by == null) throw new ToolError("table_ops sort: 'by' is required.", -32602);
      const result = applySort(rows, args.by);
      const { rows: out, truncated } = truncate(result);
      return { operation, rowCount: result.length, truncated, rows: out };
    }

    case "select": {
      if (!Array.isArray(args.fields))
        throw new ToolError("table_ops select: 'fields' array is required.", -32602);
      const result = applySelect(rows, args.fields, args.drop === true);
      const { rows: out, truncated } = truncate(result);
      return { operation, rowCount: result.length, truncated, rows: out };
    }

    case "rename": {
      if (!args.mapping || typeof args.mapping !== "object" || Array.isArray(args.mapping))
        throw new ToolError("table_ops rename: 'mapping' object is required ({oldName: newName}).", -32602);
      const result = applyRename(rows, args.mapping);
      const { rows: out, truncated } = truncate(result);
      return { operation, rowCount: result.length, truncated, rows: out };
    }

    case "derive": {
      if (!args.name) throw new ToolError("table_ops derive: 'name' (new column name) is required.", -32602);
      if (!args.op)   throw new ToolError("table_ops derive: 'op' is required.", -32602);
      const result = applyDerive(rows, args.name, args.op, args.field, args.field2, args.value);
      const { rows: out, truncated } = truncate(result);
      return { operation, rowCount: result.length, truncated, rows: out };
    }

    case "group_by": {
      if (args.by == null)
        throw new ToolError("table_ops group_by: 'by' (field or array of fields) is required.", -32602);
      if (!Array.isArray(args.aggregations) || args.aggregations.length === 0)
        throw new ToolError("table_ops group_by: 'aggregations' array is required and must be non-empty.", -32602);
      for (const agg of args.aggregations) {
        if (!agg.field) throw new ToolError("table_ops group_by: each aggregation must have a 'field'.", -32602);
        if (!agg.op)    throw new ToolError("table_ops group_by: each aggregation must have an 'op'.", -32602);
      }
      const result = applyGroupBy(rows, args.by, args.aggregations);
      const { rows: out, truncated } = truncate(result);
      return { operation, groupCount: result.length, truncated, rows: out };
    }

    case "join": {
      if (!Array.isArray(args.right_rows))
        throw new ToolError("table_ops join: 'right_rows' array is required.", -32602);
      if (!args.on)
        throw new ToolError("table_ops join: 'on' (join key field name) is required.", -32602);
      const joinType = args.type || "inner";
      if (!JOIN_TYPES.includes(joinType))
        throw new ToolError(`table_ops join: 'type' must be one of: ${JOIN_TYPES.join(", ")}.`, -32602);
      const rightRows = validateRows(args.right_rows, "join.right_rows");
      const result    = applyJoin(rows, rightRows, args.on, joinType);
      const { rows: out, truncated } = truncate(result);
      return { operation, joinType, rowCount: result.length, truncated, rows: out };
    }

    case "distinct": {
      const seen   = new Set();
      const fields = args.fields;
      const result = rows.filter(row => {
        const key = fields
          ? JSON.stringify(fields.map(f => row[f]))
          : JSON.stringify(row);
        if (seen.has(key)) return false;
        seen.add(key); return true;
      });
      const { rows: out, truncated } = truncate(result);
      return { operation, rowCount: result.length, truncated, rows: out };
    }

    case "limit": {
      const n = Number(args.count);
      if (!isFinite(n) || n < 0)
        throw new ToolError("table_ops limit: 'count' must be a non-negative number.", -32602);
      const offset = Math.max(0, Number(args.offset) || 0);
      const result = rows.slice(offset, offset + n);
      return { operation, rowCount: result.length, totalRows: rows.length, rows: result };
    }

    case "pivot": {
      if (!args.index_field) throw new ToolError("table_ops pivot: 'index_field' is required.", -32602);
      if (!args.key_field)   throw new ToolError("table_ops pivot: 'key_field' is required.", -32602);
      if (!args.value_field) throw new ToolError("table_ops pivot: 'value_field' is required.", -32602);
      const { rows: pRows, pivotKeys } = applyPivot(rows, args.index_field, args.key_field, args.value_field, args.agg_op);
      const { rows: out, truncated } = truncate(pRows);
      return { operation, pivotKeys, rowCount: pRows.length, truncated, rows: out };
    }

    case "unpivot": {
      if (!Array.isArray(args.id_fields))
        throw new ToolError("table_ops unpivot: 'id_fields' array is required.", -32602);
      const result = applyUnpivot(rows, args.id_fields, args.value_fields, args.key_name, args.value_name);
      const { rows: out, truncated } = truncate(result);
      return { operation, rowCount: result.length, truncated, rows: out };
    }
  }
}

module.exports = { tableOps };
