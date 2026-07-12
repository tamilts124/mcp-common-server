"use strict";
// lib/schemas/utilSchemas42.js — JSON schema for csv_client tool

const UTIL_SCHEMAS_42 = [
  {
    name: "csv_client",
    description: "Zero-dependency CSV file reader, writer, and editor (pure Node.js fs; no npm deps). Read, query, modify, and transform CSV and TSV files including spreadsheet exports, data logs, and tabular config files. Operations: read (parse CSV and return rows with optional offset/limit), write (create or overwrite a CSV from row arrays or objects), get_row (fetch a single row by index), set_row (replace or insert a row at an index), delete_row (remove one or more rows by index), append_rows (add rows to an existing file or create it), filter (return rows matching a column condition), sort (sort rows by a column), update_column (set or transform all values in a column), add_column (insert a new column with a default value), delete_column (remove a column), stringify (re-serialise the file, normalising quoting and line endings, optionally converting delimiter). Supports: RFC 4180 CSV, custom delimiters (comma/tab/semicolon/pipe/space), optional header row, quoted fields with embedded delimiters and newlines, CRLF/LF/CR normalisation. Security: path NUL guard; 4 MB file cap; 500,000 row limit; 1,000 column limit per row. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: {
      type: "object",
      required: ["operation"],
      properties: {
        operation: {
          type: "string",
          enum: [
            "read", "write", "get_row", "set_row", "delete_row", "append_rows",
            "filter", "sort", "update_column", "add_column", "delete_column", "stringify",
          ],
          description: "Operation to perform. read=parse CSV and return rows; write=create/overwrite file from rows array; get_row=fetch one row by index; set_row=replace/insert row at index; delete_row=remove rows by index; append_rows=add rows to existing/new file; filter=return rows matching a column condition; sort=sort rows by column; update_column=set or transform all values in a column; add_column=insert new column; delete_column=remove column; stringify=re-serialise with normalised quoting and optional delimiter change.",
        },
        path: {
          type: "string",
          description: "Path to the CSV file. Required for all operations except where noted.",
        },
        delimiter: {
          type: "string",
          enum: ["comma", "tab", "semicolon", "pipe", "space", ",", "\t", ";", "|", " "],
          description: "Field delimiter for parsing the input file. Default: 'comma'. Accepts keyword names ('comma', 'tab', 'semicolon', 'pipe', 'space') or the literal character.",
        },
        has_header: {
          type: "boolean",
          description: "Whether the first row is a header row. Default: true. When true, read/filter/sort return objects keyed by column name; when false, they return raw arrays.",
        },
        // read
        offset: {
          type: "number",
          description: "For read: zero-based row offset into the data rows (after header). Default: 0.",
        },
        limit: {
          type: "number",
          description: "For read: maximum number of data rows to return. Default: all rows.",
        },
        // write / append_rows
        rows: {
          type: "array",
          description: "Array of rows to write or append. Each element may be an array of field values (strings/numbers) or an object mapping column names to values.",
          items: {},
        },
        headers: {
          type: "array",
          items: { type: "string" },
          description: "Explicit header row for write/append_rows when 'rows' contains objects and you want a specific column order. If omitted, keys of the first object are used.",
        },
        // get_row / set_row / delete_row
        row_index: {
          type: "number",
          description: "Zero-based index into data rows (after header). Required for get_row and set_row. Also accepted by delete_row when deleting a single row.",
        },
        row_indices: {
          type: "array",
          items: { type: "number" },
          description: "List of zero-based row indices to delete. Use with delete_row to remove multiple rows in one call.",
        },
        row: {
          description: "Row data for set_row. May be an array of field strings or an object mapping header names to values.",
        },
        // filter
        column: {
          description: "Column to operate on. May be a column name (string, requires has_header=true) or a zero-based column index (number). Required for filter, sort, update_column, add_column, delete_column.",
        },
        operator: {
          type: "string",
          enum: ["eq", "neq", "contains", "not_contains", "starts_with", "ends_with", "gt", "gte", "lt", "lte", "regex"],
          description: "Comparison operator for filter. eq=equal, neq=not equal, contains=substring, not_contains=absent substring, starts_with/ends_with=prefix/suffix, gt/gte/lt/lte=numeric comparisons, regex=ECMAScript regular expression.",
        },
        value: {
          description: "Value to compare against for filter, or literal replacement value for update_column.",
        },
        ignore_case: {
          type: "boolean",
          description: "For filter (eq/neq/contains/not_contains/starts_with/ends_with/regex) and update_column (transform): perform case-insensitive comparison. Default: false.",
        },
        // sort
        direction: {
          type: "string",
          enum: ["asc", "desc"],
          description: "Sort direction for sort operation. Default: 'asc'.",
        },
        numeric: {
          type: "boolean",
          description: "For sort: compare column values as numbers instead of strings. Default: false.",
        },
        // update_column
        transform: {
          type: "string",
          description: "For update_column: transformation to apply to each cell. One of: 'uppercase', 'lowercase', 'trim', 'prefix:<str>', 'suffix:<str>'. Mutually exclusive with 'value'.",
        },
        // add_column
        default_value: {
          type: "string",
          description: "Default cell value for new column in add_column. Default: '' (empty string).",
        },
        position: {
          type: "number",
          description: "Zero-based column insertion index for add_column. Default: appends after the last column.",
        },
        // stringify
        output_delimiter: {
          type: "string",
          enum: ["comma", "tab", "semicolon", "pipe", "space", ",", "\t", ";", "|", " "],
          description: "Output delimiter for stringify (convert delimiter). If omitted, uses the same delimiter as the input.",
        },
        // shared output
        output_path: {
          type: "string",
          description: "Optional path to write output CSV to. For set_row/delete_row/sort/update_column/add_column/delete_column: defaults to overwriting 'path'. For filter/stringify: if omitted, returns content without writing.",
        },
      },
      additionalProperties: false,
    },
  },
];

module.exports = { UTIL_SCHEMAS_42 };
