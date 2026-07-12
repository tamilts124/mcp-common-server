"use strict";
// lib/schemas/utilSchemas43.js — JSON schema for jsonl_client tool

const FILTER_SCHEMA = {
  description: "Filter condition or array of conditions (AND logic). Each condition: { field, operator, value, ignore_case }. Operators: eq, neq, gt, gte, lt, lte, contains, not_contains, starts_with, ends_with, regex, exists, not_exists, is_null, is_number, is_string, is_boolean, is_array, is_object. 'field' supports dot-notation for nested fields (e.g. 'user.name'). Omit 'field' to compare the whole record value.",
};

const UTIL_SCHEMAS_43 = [
  {
    name: "jsonl_client",
    description: "Zero-dependency JSONL/NDJSON file reader, writer, and editor (pure Node.js fs; no npm deps). Read, query, filter, transform, and aggregate JSON Lines files — the standard format for structured logs, AI training data, data pipeline outputs, and event streams. Each line is a complete, valid JSON value (typically an object). Operations: read (parse and return records with optional offset/limit/filter/projection), write (create or overwrite from a rows array), append (add records to existing or new file), get_line (fetch a single record by zero-based index), set_line (replace or insert a record at an index), delete_line (remove one or more records by index), filter (return records matching conditions), map (apply field transforms to all records), aggregate (count/sum/avg/min/max/distinct/stats with optional group_by), validate (check every line parses as valid JSON, report errors), stringify (re-serialise the file, normalising whitespace, optionally pretty-printing). Security: path NUL guard; 4 MB default file cap (configurable up to 50 MB); 1,000,000 line limit. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: {
      type: "object",
      required: ["operation"],
      properties: {
        operation: {
          type: "string",
          enum: [
            "read", "write", "append", "get_line", "set_line", "delete_line",
            "filter", "map", "aggregate", "validate", "stringify",
          ],
          description: "Operation to perform. read=parse and return records; write=create/overwrite from rows array; append=add records to file; get_line=fetch one record by index; set_line=replace/insert record at index; delete_line=remove records by index; filter=return matching records; map=apply transforms to records and write back; aggregate=compute statistics; validate=check all lines are valid JSON; stringify=re-serialise with normalised whitespace.",
        },
        path: {
          type: "string",
          description: "Path to the JSONL/NDJSON file. Required for all operations.",
        },
        // Pagination (read, filter)
        offset: {
          type: "number",
          description: "For read/filter: zero-based record offset. Default: 0.",
        },
        limit: {
          type: "number",
          description: "For read/filter: maximum records to return. Default: all.",
        },
        // Projection (read, filter)
        select: {
          type: "array",
          items: { type: "string" },
          description: "For read/filter: include only these fields in returned records (applies to object records). Mutually exclusive with 'exclude'.",
        },
        exclude: {
          type: "array",
          items: { type: "string" },
          description: "For read/filter: exclude these fields from returned records (applies to object records). Mutually exclusive with 'select'.",
        },
        // Filtering (read, filter, map, aggregate)
        filter: {
          description: FILTER_SCHEMA.description,
        },
        // write / append
        rows: {
          type: "array",
          description: "For write/append: array of JSON values (objects, arrays, primitives) to write. Each element becomes one line in the output file.",
          items: {},
        },
        // get_line / set_line / delete_line
        line_index: {
          type: "number",
          description: "Zero-based logical record index (blank lines not counted). Required for get_line, set_line. Also used by delete_line for single-line removal.",
        },
        line_indices: {
          type: "array",
          items: { type: "number" },
          description: "List of zero-based record indices to delete. Use with delete_line to remove multiple records in one call.",
        },
        value: {
          description: "JSON value (object, array, string, number, boolean, null) to write at the specified index. Required for set_line.",
        },
        // map
        transforms: {
          type: "array",
          description: "For map: array of transform operations to apply to each record in sequence. Each transform: { op, field, value, from, to }. Ops: set_field, delete_field, rename_field, copy_field, uppercase_field, lowercase_field, trim_field, add_number, multiply_number.",
          items: {
            type: "object",
            properties: {
              op:    { type: "string", description: "Transform operation name." },
              field: { type: "string", description: "Target field path (dot-notation, e.g. 'user.name')." },
              value: { description: "Value to set (for set_field, add_number, multiply_number)." },
              from:  { type: "string", description: "Source field path (for rename_field, copy_field)." },
              to:    { type: "string", description: "Destination field path (for rename_field, copy_field)." },
            },
          },
        },
        // aggregate
        aggregate_op: {
          type: "string",
          enum: ["count", "sum", "avg", "min", "max", "distinct", "stats"],
          description: "For aggregate: operation to perform. count=total records, sum/avg/min/max=numeric on 'field', distinct=unique values of 'field', stats=full statistics (count+sum+avg+min+max+stddev).",
        },
        field: {
          type: "string",
          description: "For aggregate: dot-notation field path to aggregate (required for sum/avg/min/max/distinct/stats; optional for count). Also used by some filter conditions.",
        },
        group_by: {
          type: "string",
          description: "For aggregate: dot-notation field path to group by. Returns per-group results alongside each group key.",
        },
        // validate
        max_errors: {
          type: "number",
          description: "For validate: maximum number of parse errors to report before stopping (default: report all errors).",
        },
        // stringify
        pretty: {
          type: "boolean",
          description: "For write/append/stringify: pretty-print each JSON value with indentation (default: false — compact single-line per record). Note: pretty-printed multi-line objects still produce one logical record per line in the written file, not valid JSONL for multi-line values. Use only for human-readable output files.",
        },
        indent: {
          type: "number",
          description: "Indentation spaces for pretty-print mode (default: 2). Only used when pretty: true.",
        },
        // shared options
        allow_comments: {
          type: "boolean",
          description: "Skip lines starting with '#' (treated as comments). Default: false (strict JSONL — '#' lines cause parse errors).",
        },
        max_bytes: {
          type: "number",
          description: "Maximum file size to read in bytes (default: 4194304 = 4 MB; hard cap: 52428800 = 50 MB). Increase for larger JSONL files.",
        },
        output_path: {
          type: "string",
          description: "Optional path to write output JSONL to. For set_line/delete_line/map: defaults to overwriting 'path'. For filter/stringify: if omitted, returns content without writing.",
        },
      },
      additionalProperties: false,
    },
  },
];

module.exports = { UTIL_SCHEMAS_43 };
