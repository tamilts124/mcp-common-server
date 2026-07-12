"use strict";
// lib/csvClientOps.js -- Zero-dependency CSV file reader/writer/editor
// Operations: read, write, get_row, set_row, delete_row, append_rows,
//             filter, sort, update_column, add_column, delete_column, stringify
//
// CSV features supported:
//   - RFC 4180 compliant parsing
//   - Custom delimiters: comma (default), tab (\t), semicolon (;), pipe (|), space
//   - Optional header row
//   - Quoted fields with embedded delimiters, newlines, and double-quote escaping
//   - CRLF / LF / CR line-ending normalisation
//   - Trailing newline handling
//
// Security:
//   - path NUL guard
//   - 4 MB file cap
//   - 500,000 row limit
//   - 1,000 column limit per row

const fs   = require("fs");
const path = require("path");

// Constants
const MAX_FILE_BYTES = 4 * 1024 * 1024; // 4 MB
const MAX_ROWS       = 500_000;
const MAX_COLS       = 1_000;

// Error helper
function err(msg, code) {
  return Object.assign(new Error(msg), { code });
}

// Path helpers
function resolvePath(p) {
  if (typeof p !== "string" || p.length === 0)
    throw err("csv_client: 'path' must be a non-empty string.", "INVALID_ARG");
  if (p.includes("\0"))
    throw err("csv_client: 'path' must not contain NUL bytes.", "INVALID_ARG");
  return path.resolve(p);
}

function readFileSafe(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_FILE_BYTES)
    throw err(
      `csv_client: file too large (${stat.size} bytes; max ${MAX_FILE_BYTES}).`,
      "FILE_TOO_LARGE",
    );
  return fs.readFileSync(filePath, "utf8");
}

// Delimiter normalisation
const DELIMITER_MAP = {
  comma:     ",",
  tab:       "\t",
  semicolon: ";",
  pipe:      "|",
  space:     " ",
  ",":       ",",
  "\t":      "\t",
  ";": ";",
  "|": "|",
  " ": " ",
};

function resolveDelimiter(d) {
  if (d == null) return ",";
  const resolved = DELIMITER_MAP[d];
  if (!resolved)
    throw err(
      `csv_client: unknown delimiter '${d}'. Valid: comma, tab, semicolon, pipe, space (or the character itself).`,
      "INVALID_ARG",
    );
  return resolved;
}

// CSV Parser
// RFC 4180 compliant. Handles:
//   - Quoted fields ("...") with embedded delimiter, newline, double-quote ("")
//   - CRLF / LF / CR line endings
//   - Trailing newline (does not produce a spurious empty row)
//   - Blank lines (skipped)
// Returns array of string arrays (rows of fields).
function parseCSV(text, delim) {
  const rows = [];
  const n    = text.length;
  let   i    = 0;
  let   rowCount = 0;

  while (i < n) {
    // Skip blank lines (empty or whitespace-only lines between records)
    if (text[i] === "\n") { i++; continue; }
    if (text[i] === "\r") {
      if (text[i + 1] === "\n") i++;
      i++;
      continue;
    }

    const row = [];
    let   col = 0;

    // Parse one record (one logical row)
    while (i < n) {
      // Parse one field
      let field;
      if (text[i] === '"') {
        // Quoted field
        i++; // skip opening quote
        let buf = "";
        while (i < n) {
          if (text[i] === '"') {
            if (text[i + 1] === '"') { buf += '"'; i += 2; } // escaped quote
            else                      { i++; break; }          // closing quote
          } else {
            buf += text[i++];
          }
        }
        field = buf;
      } else {
        // Unquoted field -- read until delimiter or line ending
        const start = i;
        while (i < n && text[i] !== delim && text[i] !== "\n" && text[i] !== "\r") i++;
        field = text.slice(start, i);
      }

      if (++col > MAX_COLS)
        throw err(`csv_client: row ${rowCount + 1} exceeds ${MAX_COLS} column limit.`, "TOO_MANY_COLS");
      row.push(field);

      // After field: delimiter (more fields) or record terminator / EOF
      if (i < n && text[i] === delim) {
        i++; // consume delimiter; next iteration parses next field
      } else {
        // Newline or EOF -- consume newline and end record
        if (i < n && text[i] === "\r") {
          if (text[i + 1] === "\n") i++; // CRLF
          i++;
        } else if (i < n && text[i] === "\n") {
          i++;
        }
        break;
      }
    }

    if (row.length === 0) continue;

    if (++rowCount > MAX_ROWS)
      throw err(`csv_client: file exceeds ${MAX_ROWS} row limit.`, "TOO_MANY_ROWS");
    rows.push(row);
  }

  return rows;
}

// CSV Serialiser
// Serialises an array of string arrays to CSV text.
// A field is quoted if it contains the delimiter, a quote, a newline, or CR.
function serialiseCSV(rows, delim) {
  const lines = [];
  for (const row of rows) {
    const fields = row.map(field => {
      const s = String(field ?? "");
      if (s.includes(delim) || s.includes('"') || s.includes("\n") || s.includes("\r")) {
        return '"' + s.replace(/"/g, '""') + '"';
      }
      return s;
    });
    lines.push(fields.join(delim));
  }
  return lines.join("\n") + "\n";
}

// Header helpers
function splitHeaderData(rows, hasHeader) {
  if (!hasHeader || rows.length === 0) return { headers: null, data: rows };
  return { headers: rows[0], data: rows.slice(1) };
}

function joinHeaderData(headers, data) {
  if (!headers) return data;
  return [headers, ...data];
}

function headerIndex(headers, col) {
  if (typeof col === "number") {
    if (!Number.isInteger(col) || col < 0)
      throw err("csv_client: column index must be a non-negative integer.", "INVALID_ARG");
    return col;
  }
  if (typeof col === "string") {
    if (!headers)
      throw err("csv_client: cannot look up column by name when has_header is false.", "INVALID_ARG");
    const idx = headers.indexOf(col);
    if (idx === -1)
      throw err(`csv_client: column '${col}' not found in headers.`, "NOT_FOUND");
    return idx;
  }
  throw err("csv_client: 'column' must be a string (name) or number (index).", "INVALID_ARG");
}

// Operations

function opRead(args) {
  const delim     = resolveDelimiter(args.delimiter);
  const resolved  = resolvePath(args.path);
  const raw       = readFileSafe(resolved);
  const hasHeader = args.has_header !== false; // default true
  const rows      = parseCSV(raw, delim);
  const { headers, data } = splitHeaderData(rows, hasHeader);

  const offset = Math.max(0, args.offset || 0);
  const limit  = args.limit != null ? Math.max(0, args.limit) : data.length;
  const slice  = data.slice(offset, offset + limit);

  let result;
  if (hasHeader && headers) {
    result = slice.map(row => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = row[i] ?? ""; });
      return obj;
    });
  } else {
    result = slice;
  }

  return {
    path:        args.path,
    delimiter:   args.delimiter || "comma",
    hasHeader,
    headers:     headers || null,
    totalRows:   data.length,
    offset,
    returned:    slice.length,
    rows:        result,
  };
}

function opWrite(args) {
  if (!Array.isArray(args.rows))
    throw err("csv_client: 'rows' must be an array for write.", "INVALID_ARG");

  const resolved  = resolvePath(args.path);
  const delim     = resolveDelimiter(args.delimiter);
  const hasHeader = args.has_header !== false;

  let rawRows;
  if (args.rows.length === 0) {
    rawRows = [];
  } else if (Array.isArray(args.rows[0])) {
    rawRows = args.rows.map(r => r.map(String));
  } else if (typeof args.rows[0] === "object" && args.rows[0] !== null) {
    const headers = args.headers || Object.keys(args.rows[0]);
    const dataRows = args.rows.map(obj => headers.map(h => String(obj[h] ?? "")));
    rawRows = hasHeader ? [headers, ...dataRows] : dataRows;
  } else {
    throw err("csv_client: 'rows' must contain arrays or objects.", "INVALID_ARG");
  }

  const text = serialiseCSV(rawRows, delim);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, text, "utf8");
  return {
    path:      args.path,
    written:   true,
    rowCount:  rawRows.length,
    byteCount: Buffer.byteLength(text, "utf8"),
  };
}

function opGetRow(args) {
  if (args.row_index == null)
    throw err("csv_client: 'row_index' is required for get_row.", "INVALID_ARG");
  const resolved  = resolvePath(args.path);
  const raw       = readFileSafe(resolved);
  const delim     = resolveDelimiter(args.delimiter);
  const hasHeader = args.has_header !== false;
  const rows      = parseCSV(raw, delim);
  const { headers, data } = splitHeaderData(rows, hasHeader);

  const idx = args.row_index;
  if (!Number.isInteger(idx) || idx < 0)
    throw err("csv_client: 'row_index' must be a non-negative integer.", "INVALID_ARG");
  if (idx >= data.length)
    return { path: args.path, row_index: idx, found: false, row: null };

  const row = data[idx];
  let result;
  if (hasHeader && headers) {
    result = {};
    headers.forEach((h, i) => { result[h] = row[i] ?? ""; });
  } else {
    result = row;
  }
  return { path: args.path, row_index: idx, found: true, row: result };
}

function opSetRow(args) {
  if (args.row_index == null)
    throw err("csv_client: 'row_index' is required for set_row.", "INVALID_ARG");
  if (args.row == null)
    throw err("csv_client: 'row' is required for set_row.", "INVALID_ARG");

  const resolved  = resolvePath(args.path);
  const raw       = readFileSafe(resolved);
  const delim     = resolveDelimiter(args.delimiter);
  const hasHeader = args.has_header !== false;
  const rows      = parseCSV(raw, delim);
  const { headers, data } = splitHeaderData(rows, hasHeader);

  const idx = args.row_index;
  if (!Number.isInteger(idx) || idx < 0)
    throw err("csv_client: 'row_index' must be a non-negative integer.", "INVALID_ARG");

  let newRow;
  if (Array.isArray(args.row)) {
    newRow = args.row.map(String);
  } else if (typeof args.row === "object" && args.row !== null) {
    if (!headers)
      throw err("csv_client: cannot use object row without headers.", "INVALID_ARG");
    newRow = headers.map(h => String(args.row[h] ?? ""));
  } else {
    throw err("csv_client: 'row' must be an array or object.", "INVALID_ARG");
  }

  const created = idx >= data.length;
  while (data.length <= idx) data.push([]);
  data[idx] = newRow;

  const outRows = joinHeaderData(headers, data);
  const text = serialiseCSV(outRows, delim);
  const outPath = args.output_path || args.path;
  const outResolved = resolvePath(outPath);
  fs.mkdirSync(path.dirname(outResolved), { recursive: true });
  fs.writeFileSync(outResolved, text, "utf8");
  return { path: args.path, row_index: idx, created, written: true, output_path: outPath };
}

function opDeleteRow(args) {
  if (args.row_index == null && args.row_indices == null)
    throw err("csv_client: 'row_index' or 'row_indices' is required for delete_row.", "INVALID_ARG");

  const resolved  = resolvePath(args.path);
  const raw       = readFileSafe(resolved);
  const delim     = resolveDelimiter(args.delimiter);
  const hasHeader = args.has_header !== false;
  const rows      = parseCSV(raw, delim);
  const { headers, data } = splitHeaderData(rows, hasHeader);

  const toDelete = new Set(
    args.row_indices != null ? args.row_indices : [args.row_index]
  );
  const before  = data.length;
  const newData = data.filter((_, i) => !toDelete.has(i));
  const deleted = before - newData.length;

  const outRows = joinHeaderData(headers, newData);
  const text    = serialiseCSV(outRows, delim);
  const outPath = args.output_path || args.path;
  const outResolved = resolvePath(outPath);
  fs.mkdirSync(path.dirname(outResolved), { recursive: true });
  fs.writeFileSync(outResolved, text, "utf8");
  return { path: args.path, deleted, remaining: newData.length, written: true, output_path: outPath };
}

function opAppendRows(args) {
  if (!Array.isArray(args.rows) || args.rows.length === 0)
    throw err("csv_client: 'rows' must be a non-empty array for append_rows.", "INVALID_ARG");

  const resolved  = resolvePath(args.path);
  const delim     = resolveDelimiter(args.delimiter);
  const hasHeader = args.has_header !== false;

  let existingRows = [];
  let headers = null;
  try {
    const raw = readFileSafe(resolved);
    existingRows = parseCSV(raw, delim);
    ({ headers } = splitHeaderData(existingRows, hasHeader));
  } catch (e) {
    if (e.code !== "ENOENT" && !String(e.message).includes("ENOENT")) throw e;
    existingRows = [];
  }

  let newRawRows;
  if (Array.isArray(args.rows[0])) {
    newRawRows = args.rows.map(r => r.map(String));
  } else if (typeof args.rows[0] === "object" && args.rows[0] !== null) {
    const hdrs = headers || (hasHeader ? Object.keys(args.rows[0]) : null);
    if (hdrs) {
      newRawRows = args.rows.map(obj => hdrs.map(h => String(obj[h] ?? "")));
    } else {
      newRawRows = args.rows.map(obj => Object.values(obj).map(String));
    }
  } else {
    throw err("csv_client: 'rows' must contain arrays or objects.", "INVALID_ARG");
  }

  if (existingRows.length === 0 && hasHeader && args.headers) {
    existingRows = [args.headers];
    headers = args.headers;
  }

  const { data: existingData } = splitHeaderData(existingRows, hasHeader);
  const allData = [...existingData, ...newRawRows];
  const outRows = joinHeaderData(headers, allData);
  const text    = serialiseCSV(outRows, delim);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, text, "utf8");
  return {
    path:      args.path,
    appended:  newRawRows.length,
    totalRows: allData.length,
    written:   true,
  };
}

function opFilter(args) {
  if (!args.column)
    throw err("csv_client: 'column' is required for filter.", "INVALID_ARG");
  if (!args.operator)
    throw err("csv_client: 'operator' is required for filter.", "INVALID_ARG");

  const resolved  = resolvePath(args.path);
  const raw       = readFileSafe(resolved);
  const delim     = resolveDelimiter(args.delimiter);
  const hasHeader = args.has_header !== false;
  const rows      = parseCSV(raw, delim);
  const { headers, data } = splitHeaderData(rows, hasHeader);

  const colIdx   = headerIndex(headers, args.column);
  const value    = String(args.value ?? "");
  const operator = args.operator;
  const icase    = args.ignore_case === true;

  function compare(fieldVal) {
    let a = fieldVal;
    let b = value;
    if (icase) { a = a.toLowerCase(); b = b.toLowerCase(); }
    switch (operator) {
      case "eq":           return a === b;
      case "neq":          return a !== b;
      case "contains":     return a.includes(b);
      case "not_contains": return !a.includes(b);
      case "starts_with":  return a.startsWith(b);
      case "ends_with":    return a.endsWith(b);
      case "gt":  return parseFloat(a) >  parseFloat(b);
      case "gte": return parseFloat(a) >= parseFloat(b);
      case "lt":  return parseFloat(a) <  parseFloat(b);
      case "lte": return parseFloat(a) <= parseFloat(b);
      case "regex": {
        const flags = icase ? "i" : "";
        return new RegExp(value, flags).test(fieldVal);
      }
      default:
        throw err(
          `csv_client: unknown operator '${operator}'. Valid: eq, neq, contains, not_contains, starts_with, ends_with, gt, gte, lt, lte, regex.`,
          "INVALID_ARG",
        );
    }
  }

  const filtered = data.filter(row => compare(row[colIdx] ?? ""));

  let result;
  if (hasHeader && headers) {
    result = filtered.map(row => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = row[i] ?? ""; });
      return obj;
    });
  } else {
    result = filtered;
  }

  if (args.output_path) {
    const outRows = joinHeaderData(headers, filtered);
    const text    = serialiseCSV(outRows, delim);
    const outResolved = resolvePath(args.output_path);
    fs.mkdirSync(path.dirname(outResolved), { recursive: true });
    fs.writeFileSync(outResolved, text, "utf8");
  }

  return {
    path:     args.path,
    column:   args.column,
    operator,
    value,
    matched:  filtered.length,
    rows:     result,
    ...(args.output_path ? { written: true, output_path: args.output_path } : { written: false }),
  };
}

function opSort(args) {
  if (!args.column)
    throw err("csv_client: 'column' is required for sort.", "INVALID_ARG");

  const resolved  = resolvePath(args.path);
  const raw       = readFileSafe(resolved);
  const delim     = resolveDelimiter(args.delimiter);
  const hasHeader = args.has_header !== false;
  const rows      = parseCSV(raw, delim);
  const { headers, data } = splitHeaderData(rows, hasHeader);

  const colIdx  = headerIndex(headers, args.column);
  const dir     = (args.direction || "asc").toLowerCase();
  const numeric = args.numeric === true;

  const sorted = [...data].sort((a, b) => {
    const va = a[colIdx] ?? "";
    const vb = b[colIdx] ?? "";
    let cmp;
    if (numeric) {
      cmp = (parseFloat(va) || 0) - (parseFloat(vb) || 0);
    } else {
      cmp = va.localeCompare(vb);
    }
    return dir === "desc" ? -cmp : cmp;
  });

  const outRows = joinHeaderData(headers, sorted);
  const text    = serialiseCSV(outRows, delim);
  const outPath = args.output_path || args.path;
  const outResolved = resolvePath(outPath);
  fs.mkdirSync(path.dirname(outResolved), { recursive: true });
  fs.writeFileSync(outResolved, text, "utf8");
  return { path: args.path, column: args.column, direction: dir, rowCount: sorted.length, written: true, output_path: outPath };
}

function opUpdateColumn(args) {
  if (!args.column)
    throw err("csv_client: 'column' is required for update_column.", "INVALID_ARG");
  if (args.value === undefined && args.transform === undefined)
    throw err("csv_client: 'value' or 'transform' is required for update_column.", "INVALID_ARG");

  const resolved  = resolvePath(args.path);
  const raw       = readFileSafe(resolved);
  const delim     = resolveDelimiter(args.delimiter);
  const hasHeader = args.has_header !== false;
  const rows      = parseCSV(raw, delim);
  const { headers, data } = splitHeaderData(rows, hasHeader);

  const colIdx = headerIndex(headers, args.column);

  function applyTransform(val) {
    if (args.value !== undefined) return String(args.value);
    const t = args.transform || "";
    if (t === "uppercase")       return val.toUpperCase();
    if (t === "lowercase")       return val.toLowerCase();
    if (t === "trim")            return val.trim();
    if (t.startsWith("prefix:")) return t.slice(7) + val;
    if (t.startsWith("suffix:")) return val + t.slice(7);
    throw err(
      `csv_client: unknown transform '${t}'. Valid: uppercase, lowercase, trim, prefix:<str>, suffix:<str>.`,
      "INVALID_ARG",
    );
  }

  const updated = data.map(row => {
    const newRow = [...row];
    while (newRow.length <= colIdx) newRow.push("");
    newRow[colIdx] = applyTransform(newRow[colIdx] ?? "");
    return newRow;
  });

  const outRows = joinHeaderData(headers, updated);
  const text    = serialiseCSV(outRows, delim);
  const outPath = args.output_path || args.path;
  const outResolved = resolvePath(outPath);
  fs.mkdirSync(path.dirname(outResolved), { recursive: true });
  fs.writeFileSync(outResolved, text, "utf8");
  return { path: args.path, column: args.column, rowsUpdated: updated.length, written: true, output_path: outPath };
}

function opAddColumn(args) {
  if (!args.column)
    throw err("csv_client: 'column' is required for add_column.", "INVALID_ARG");

  const resolved  = resolvePath(args.path);
  const raw       = readFileSafe(resolved);
  const delim     = resolveDelimiter(args.delimiter);
  const hasHeader = args.has_header !== false;
  const rows      = parseCSV(raw, delim);
  const { headers, data } = splitHeaderData(rows, hasHeader);

  const defaultVal = String(args.default_value ?? "");
  const insertAt   = args.position != null
    ? args.position
    : (headers ? headers.length : (data[0]?.length ?? 0));

  let newHeaders = null;
  if (hasHeader && headers) {
    if (headers.includes(args.column))
      throw err(`csv_client: column '${args.column}' already exists.`, "DUPLICATE_COLUMN");
    newHeaders = [...headers];
    newHeaders.splice(insertAt, 0, args.column);
  }

  const newData = data.map(row => {
    const nr = [...row];
    nr.splice(insertAt, 0, defaultVal);
    return nr;
  });

  const outRows = joinHeaderData(newHeaders, newData);
  const text    = serialiseCSV(outRows, delim);
  const outPath = args.output_path || args.path;
  const outResolved = resolvePath(outPath);
  fs.mkdirSync(path.dirname(outResolved), { recursive: true });
  fs.writeFileSync(outResolved, text, "utf8");
  return { path: args.path, column: args.column, position: insertAt, rowCount: newData.length, written: true, output_path: outPath };
}

function opDeleteColumn(args) {
  if (!args.column)
    throw err("csv_client: 'column' is required for delete_column.", "INVALID_ARG");

  const resolved  = resolvePath(args.path);
  const raw       = readFileSafe(resolved);
  const delim     = resolveDelimiter(args.delimiter);
  const hasHeader = args.has_header !== false;
  const rows      = parseCSV(raw, delim);
  const { headers, data } = splitHeaderData(rows, hasHeader);

  const colIdx = headerIndex(headers, args.column);

  let newHeaders = null;
  if (hasHeader && headers) {
    newHeaders = headers.filter((_, i) => i !== colIdx);
  }

  const newData = data.map(row => row.filter((_, i) => i !== colIdx));

  const outRows = joinHeaderData(newHeaders, newData);
  const text    = serialiseCSV(outRows, delim);
  const outPath = args.output_path || args.path;
  const outResolved = resolvePath(outPath);
  fs.mkdirSync(path.dirname(outResolved), { recursive: true });
  fs.writeFileSync(outResolved, text, "utf8");
  return { path: args.path, column: args.column, rowCount: newData.length, written: true, output_path: outPath };
}

function opStringify(args) {
  const resolved = resolvePath(args.path);
  const raw      = readFileSafe(resolved);
  const delim    = resolveDelimiter(args.delimiter);
  const outDelim = resolveDelimiter(args.output_delimiter || args.delimiter);
  const rows     = parseCSV(raw, delim);

  const text = serialiseCSV(rows, outDelim);

  if (args.output_path) {
    const outResolved = resolvePath(args.output_path);
    fs.mkdirSync(path.dirname(outResolved), { recursive: true });
    fs.writeFileSync(outResolved, text, "utf8");
    return { path: args.path, rowCount: rows.length, byteCount: Buffer.byteLength(text, "utf8"), written: true, output_path: args.output_path, csv: text };
  }
  return { path: args.path, rowCount: rows.length, byteCount: Buffer.byteLength(text, "utf8"), written: false, csv: text };
}

// Main Dispatcher
function csvClient(args) {
  if (!args || !args.operation)
    throw err("csv_client: 'operation' is required.", "INVALID_ARG");

  switch (args.operation) {
    case "read":          return opRead(args);
    case "write":         return opWrite(args);
    case "get_row":       return opGetRow(args);
    case "set_row":       return opSetRow(args);
    case "delete_row":    return opDeleteRow(args);
    case "append_rows":   return opAppendRows(args);
    case "filter":        return opFilter(args);
    case "sort":          return opSort(args);
    case "update_column": return opUpdateColumn(args);
    case "add_column":    return opAddColumn(args);
    case "delete_column": return opDeleteColumn(args);
    case "stringify":     return opStringify(args);
    default:
      throw err(
        `csv_client: unknown operation '${args.operation}'. Valid: read, write, get_row, set_row, delete_row, append_rows, filter, sort, update_column, add_column, delete_column, stringify.`,
        "INVALID_ARG",
      );
  }
}

module.exports = {
  csvClient,
  // Exported for testing
  parseCSV,
  serialiseCSV,
  resolveDelimiter,
  splitHeaderData,
  headerIndex,
};
