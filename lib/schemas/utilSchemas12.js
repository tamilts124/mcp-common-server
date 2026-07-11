"use strict";
// ── UTILITY TOOL SCHEMAS — part 12 ──────────────────────────────────────────────
// Added: str_similarity (v4.148.0), table_ops (v4.148.0).

const UTIL_SCHEMAS_12 = [
  {
    name: "str_similarity",
    description:
      "String distance metrics and fuzzy search — zero npm dependencies, pure Node.js. " +
      "Five algorithms: levenshtein (edit distance), jaro_winkler (transposition-aware, prefix-boosted), " +
      "dice (bigram overlap), hamming (same-length substitution count), " +
      "longest_common_subsequence (LCS length normalized). " +
      "Operations: " +
      "'distance' — compute pairwise similarity (0–1) and raw distance between strings 'a' and 'b'. " +
      "'search' — fuzzy-search a 'query' against a 'candidates' array, returning top-N results sorted by similarity. " +
      "'cluster' — group a 'strings' array by similarity threshold using union-find (Levenshtein default). " +
      "'dedupe' — remove near-duplicate strings from a list using similarity threshold; keeps first occurrence. " +
      "'normalize' — pre-process one or more strings (lowercase, trim, collapse whitespace, strip punctuation/diacritics) " +
      "for consistent downstream comparison. " +
      "Input limits: 10 000 chars per string, 50 000 candidates for search, 5 000 strings for cluster/dedupe. " +
      "Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: {
      type: "object",
      required: ["operation"],
      properties: {
        operation: {
          type: "string",
          description:
            "Operation: distance, search, cluster, dedupe, normalize.",
        },
        metric: {
          type: "string",
          description:
            "Similarity metric: levenshtein (default), jaro_winkler, dice, hamming, longest_common_subsequence. " +
            "'hamming' requires equal-length strings.",
        },
        // distance
        a: {
          type: "string",
          description: "(distance) First string to compare. Max 10 000 chars.",
        },
        b: {
          type: "string",
          description: "(distance) Second string to compare. Max 10 000 chars.",
        },
        // search
        query: {
          type: "string",
          description: "(search) Query string to search for.",
        },
        candidates: {
          type: "array",
          items: { type: "string" },
          description: "(search) List of candidate strings to score against 'query'. Max 50 000 items.",
        },
        top_n: {
          type: "number",
          description: "(search) Maximum number of top results to return (1–1000, default 10).",
        },
        threshold: {
          type: "number",
          description:
            "(search/cluster/dedupe) Minimum similarity score to include (0–1). " +
            "Default: 0 for search, 0.8 for cluster, 0.9 for dedupe.",
        },
        // cluster / dedupe
        strings: {
          type: "array",
          items: { type: "string" },
          description: "(cluster/dedupe/normalize) List of strings to cluster, dedupe, or normalize. Max 5 000 items.",
        },
        // normalize
        string: {
          type: "string",
          description: "(normalize) Single string to normalize (alternative to 'strings' array).",
        },
        lower: {
          type: "boolean",
          description: "(normalize) Convert to lowercase (default: true).",
        },
        trim: {
          type: "boolean",
          description: "(normalize) Strip leading/trailing whitespace (default: true).",
        },
        collapse_whitespace: {
          type: "boolean",
          description: "(normalize) Replace sequences of whitespace with a single space (default: true).",
        },
        strip_punctuation: {
          type: "boolean",
          description: "(normalize) Remove punctuation characters (default: false).",
        },
        strip_diacritics: {
          type: "boolean",
          description: "(normalize) Remove diacritical marks (accents) via Unicode NFD decomposition (default: false).",
        },
        // shared
        ignore_case: {
          type: "boolean",
          description: "(distance/search/cluster/dedupe) Perform case-insensitive comparison (default: false).",
        },
      },
    },
  },
  {
    name: "table_ops",
    description:
      "In-memory relational table operations on arrays of JSON objects — zero npm dependencies, pure Node.js. " +
      "Operates on plain JSON arrays (rows) and returns structured results. " +
      "Operations: " +
      "'info' — schema summary: column names, types, null counts, samples. " +
      "'filter' — keep rows matching one or more conditions " +
      "(eq/ne/lt/gt/le/ge/contains/starts_with/ends_with/regex/is_null/not_null/in/not_in; AND or OR logic). " +
      "'sort' — sort rows by one or more fields, each with asc/desc direction. " +
      "'select' — project a subset of columns (or drop specified columns). " +
      "'rename' — rename column names via a {oldName: newName} mapping. " +
      "'derive' — add a computed column from arithmetic, string, cast, coalesce, or template ops. " +
      "'group_by' — aggregate rows by key field(s) using sum/avg/count/min/max/first/last/list/count_distinct/concat_agg. " +
      "'join' — merge two row arrays on a shared key field; inner/left/right/full join types. " +
      "'distinct' — deduplicate rows (optionally scoped to a subset of key fields). " +
      "'limit' — return a page of rows (count + optional offset). " +
      "'pivot' — reshape rows from long to wide: one row per index value, one column per unique key-field value. " +
      "'unpivot' — reshape rows from wide to long: one output row per value column. " +
      "Input limit: 100 000 rows; output truncated at 10 000 rows. " +
      "Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: {
      type: "object",
      required: ["operation", "rows"],
      properties: {
        operation: {
          type: "string",
          description:
            "Operation: info, filter, sort, select, rename, derive, group_by, join, distinct, limit, pivot, unpivot.",
        },
        rows: {
          type: "array",
          items: { type: "object" },
          description: "Input array of JSON objects (table rows). Max 100 000 rows.",
        },
        // filter
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
          description: "(filter) How to combine conditions: 'and' (default — all must match) or 'or' (any must match).",
        },
        // sort
        by: {
          description:
            "(sort) Field name string for a single-field ascending sort, " +
            "or array of {field, dir} objects for multi-key sorts (dir: 'asc'/'desc').",
          oneOf: [
            { type: "string" },
            {
              type: "array",
              items: { type: "object" },
            },
          ],
        },
        // select
        fields: {
          type: "array",
          items: { type: "string" },
          description:
            "(select/distinct) Column names to include (select). " +
            "When 'drop' is true, these columns are excluded instead. " +
            "(distinct) Scope deduplication to these fields only.",
        },
        drop: {
          type: "boolean",
          description: "(select) If true, 'fields' is a drop-list (exclude these columns). Default: false.",
        },
        // rename
        mapping: {
          type: "object",
          description: "(rename) {oldColumnName: newColumnName} pairs.",
        },
        // derive
        name: {
          type: "string",
          description: "(derive) Name of the new column to add.",
        },
        op: {
          type: "string",
          description:
            "(derive) Derive operation: add/sub/mul/div (numeric), concat/upper/lower/trim (string), " +
            "cast_number/cast_string/cast_boolean, length, coalesce (first non-null from a field list), " +
            "template ('{field}' interpolation in a value string).",
        },
        field: {
          type: "string",
          description: "(derive) Primary source column name.",
        },
        field2: {
          type: "string",
          description: "(derive) Second source column (for binary ops: add/sub/mul/div/concat).",
        },
        value: {
          description:
            "(derive) Literal value (used when field2 is absent): a number for arithmetic, " +
            "a string for concat/template, or an array of field names for coalesce.",
        },
        // group_by
        aggregations: {
          type: "array",
          items: { type: "object" },
          description:
            "(group_by) Array of {field, op, alias?, separator?} objects. " +
            "op: sum/avg/count/min/max/first/last/list/count_distinct/concat_agg. " +
            "'concat_agg' joins values with 'separator' (default ',').",
        },
        // join
        right_rows: {
          type: "array",
          items: { type: "object" },
          description: "(join) The right-side table rows to join against. Max 100 000 rows.",
        },
        on: {
          type: "string",
          description: "(join) Field name to join on (must exist in both 'rows' and 'right_rows').",
        },
        type: {
          type: "string",
          description: "(join) Join type: inner (default), left, right, or full.",
        },
        // limit
        count: {
          type: "number",
          description: "(limit) Number of rows to return.",
        },
        offset: {
          type: "number",
          description: "(limit) Number of rows to skip before returning (default: 0).",
        },
        // pivot
        index_field: {
          type: "string",
          description: "(pivot) Field whose unique values become row identifiers.",
        },
        key_field: {
          type: "string",
          description: "(pivot) Field whose unique values become the new column headers.",
        },
        value_field: {
          type: "string",
          description: "(pivot) Field whose values fill the pivot cells.",
        },
        agg_op: {
          type: "string",
          description:
            "(pivot) Aggregation when multiple rows share the same index+key: " +
            "first (default), last, sum, avg, count, list.",
        },
        // unpivot
        id_fields: {
          type: "array",
          items: { type: "string" },
          description: "(unpivot) Columns to keep as row identifiers (not unpivoted).",
        },
        value_fields: {
          type: "array",
          items: { type: "string" },
          description: "(unpivot) Columns to melt into rows. Defaults to all non-id columns.",
        },
        key_name: {
          type: "string",
          description: "(unpivot) Name for the column that holds the original column name (default: 'key').",
        },
        value_name: {
          type: "string",
          description: "(unpivot) Name for the column that holds the original cell value (default: 'value').",
        },
      },
    },
  },
];

module.exports = { UTIL_SCHEMAS_12 };
