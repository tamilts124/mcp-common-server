"use strict";
// ── UTILITY TOOL SCHEMAS — part 13 ────────────────────────────────────────────────────
// Added: graphql_query (v4.149.0), jsonl_ops (v4.149.0).

const UTIL_SCHEMAS_13 = [
  {
    name: "graphql_query",
    description:
      "Send a GraphQL request (query or mutation) to any HTTP/HTTPS endpoint and return the structured " +
      "response. Zero npm dependencies — uses Node.js built-in http/https modules. " +
      "Supports variables, custom request headers (e.g. Authorization tokens, API keys), " +
      "multi-operation documents via operation_name, and configurable timeouts. " +
      "Automatically detects the operation type (query/mutation/subscription) from the document. " +
      "Returns { statusCode, operationType, operationName, data, errors, extensions, hasErrors }. " +
      "'hasErrors' is true when the response contains GraphQL errors (even if data is also present). " +
      "The request body is sent as application/json with Content-Type and Content-Length set automatically; " +
      "response bodies exceeding 10 MB are rejected. Requires MCP_ALLOW_EXEC (network I/O).",
    inputSchema: {
      type: "object",
      required: ["url", "query"],
      properties: {
        url: {
          type: "string",
          description:
            "GraphQL endpoint URL. Must use http:// or https://. " +
            "Example: 'https://api.example.com/graphql'.",
        },
        query: {
          type: "string",
          description:
            "GraphQL document string (query, mutation, or subscription). " +
            "Max 100 KB. Example: '{ user(id: \"1\") { name email } }'.",
        },
        variables: {
          type: "object",
          description:
            "Optional variables object to accompany the document. " +
            "Sent as the 'variables' field in the JSON body.",
        },
        headers: {
          type: "object",
          description:
            "Optional extra HTTP headers to include in the request. " +
            "Keys are lowercased automatically. " +
            "Use this for authentication: { \"authorization\": \"Bearer TOKEN\" }. " +
            "Caller headers take precedence over defaults (content-type, accept).",
        },
        operation_name: {
          type: "string",
          description:
            "Optional operationName: specifies which operation to run when the " +
            "document contains multiple named operations.",
        },
        timeout: {
          type: "number",
          description:
            "Request timeout in milliseconds (default: 30 000). " +
            "The connection attempt and full response must complete within this window.",
        },
      },
    },
  },
  {
    name: "jsonl_ops",
    description:
      "Operations on JSONL (newline-delimited JSON / .jsonl) files — zero npm dependencies, pure Node.js. " +
      "JSONL is one JSON value per line; blank lines are skipped, invalid lines are tracked. " +
      "Input: a file path ('path') or an inline array of objects ('rows'). " +
      "Input limits: 100 000 valid lines per file, files up to 50 MB; output truncated at 10 000 rows. " +
      "Operations: " +
      "'parse' — load the file and return all rows with stats (validCount, invalidCount, blankCount, parseErrors). " +
      "'count' — count total/valid/invalid/blank lines without returning row data. " +
      "'head' — return the first N rows (param: count, default 10). " +
      "'tail' — return the last N rows (param: count, default 10). " +
      "'sample' — reservoir-sample N rows (params: count, seed for reproducibility). " +
      "'validate' — report every invalid line with its parse error (file path required). " +
      "'filter' — keep rows matching conditions (same op/field/value schema as table_ops filter; " +
      "params: conditions, logic ['and'/'or']). " +
      "'transform' — project/drop/rename columns (params: fields, drop, mapping). " +
      "'sort' — sort by a single field ascending or descending (params: field, dir ['asc'/'desc']). " +
      "'merge' — combine multiple JSONL files into one row array (param: paths array, max 50 files). " +
      "'to_json' — parse a JSONL file and return the rows as a plain JSON array under key 'json'. " +
      "Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: {
      type: "object",
      required: ["operation"],
      properties: {
        operation: {
          type: "string",
          description:
            "Operation to perform: parse, count, head, tail, sample, validate, " +
            "filter, transform, sort, merge, to_json.",
        },
        // ── Input source
        path: {
          type: "string",
          description:
            "Path to a .jsonl file. Required for validate; used by all other operations " +
            "as an alternative to 'rows'. Provide 'path' OR 'rows', not both.",
        },
        paths: {
          type: "array",
          items: { type: "string" },
          description: "(merge) Array of .jsonl file paths to merge. Required for the 'merge' operation. Max 50 files.",
        },
        rows: {
          type: "array",
          items: { type: "object" },
          description:
            "Inline array of JSON objects (rows) instead of reading a file. " +
            "Ignored by 'validate' and 'merge' (which require file paths). Max 100 000 entries.",
        },
        // ── head / tail / sample
        count: {
          type: "number",
          description: "(head/tail/sample) Number of rows to return (default 10).",
        },
        seed: {
          type: "number",
          description: "(sample) Optional integer seed for reproducible reservoir sampling.",
        },
        // ── filter
        conditions: {
          type: "array",
          items: { type: "object" },
          description:
            "(filter) Array of condition objects: {field, op, value?}. " +
            "op values: eq/ne/lt/gt/le/ge/contains/starts_with/ends_with/regex/is_null/not_null/in/not_in. " +
            "'in'/'not_in' require value to be an array.",
        },
        logic: {
          type: "string",
          description: "(filter) 'and' (default — all conditions must match) or 'or' (any must match).",
        },
        // ── transform
        fields: {
          type: "array",
          items: { type: "string" },
          description:
            "(transform) Column names to include; when 'drop' is true, these columns are excluded instead.",
        },
        drop: {
          type: "boolean",
          description: "(transform) If true, 'fields' is a drop-list (exclude these columns). Default: false.",
        },
        mapping: {
          type: "object",
          description: "(transform) {oldColumnName: newColumnName} rename pairs.",
        },
        // ── sort
        field: {
          type: "string",
          description: "(sort) Field name to sort by.",
        },
        dir: {
          type: "string",
          description: "(sort) Sort direction: 'asc' (default) or 'desc'.",
        },
      },
    },
  },
];

module.exports = { UTIL_SCHEMAS_13 };
