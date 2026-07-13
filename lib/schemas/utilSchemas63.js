"use strict";
// lib/schemas/utilSchemas63.js -- JSON schema for sqlite_client tool

const UTIL_SCHEMAS_63 = [
  {
    name: "sqlite_client",
    description:
      "Zero-dependency stateless SQLite 3.x file reader (pure Node.js; no npm deps, no native bindings). " +
      "Reads SQLite database files directly by parsing the binary file format — no sqlite3 module required for read operations. " +
      "Unlike the stateful sqlite_connect/sqlite_execute/sqlite_disconnect tools, sqlite_client is stateless: " +
      "each call opens the file, performs the operation, and closes it — ideal for one-shot queries, " +
      "schema inspection, and data export from .db/.sqlite/.sqlite3 files. " +
      "Operations: " +
      "info (database metadata: file size, page size, page count, encoding, SQLite version, schema cookie, " +
      "table/view/index/trigger counts and names); " +
      "tables (list tables or views in the database with their root page numbers); " +
      "schema (full schema with CREATE TABLE SQL and parsed column definitions; optionally scoped to one table); " +
      "query (execute a SELECT statement — parsed and executed in pure Node.js, " +
      "supports WHERE, ORDER BY, LIMIT, OFFSET, column list or *; " +
      "returns structured rows with column names); " +
      "execute (run INSERT/UPDATE/DELETE/CREATE TABLE/DROP TABLE SQL — requires sqlite3 CLI on PATH); " +
      "export (dump a whole table to JSON or CSV, optionally writing to an output file). " +
      "Security: 256 MB file size cap; 1,000,000 row limit for query; 100,000 row limit for export; " +
      "NUL-byte path guard; directory path rejected; execute blocks ATTACH/DETACH/DROP DATABASE.",
    inputSchema: {
      type: "object",
      required: ["operation", "path"],
      additionalProperties: false,
      properties: {
        operation: {
          type: "string",
          enum: ["info", "tables", "schema", "query", "execute", "export"],
          description:
            "Operation to perform. " +
            "'info': return database-level metadata (page size, encoding, SQLite version, schema cookie, " +
            "table/view/index/trigger counts and names). " +
            "'tables': list tables (or views/indexes/triggers if 'type' is set) with their root page numbers. " +
            "'schema': return full schema with CREATE TABLE SQL and parsed column list. " +
            "Optionally scope to a single table with 'table'. " +
            "'query': execute a SELECT statement (pure Node.js, no native deps). " +
            "Supports WHERE (col OP val AND/OR ...), ORDER BY col ASC/DESC, LIMIT n, OFFSET m, column list or *. " +
            "'execute': run a write SQL statement (INSERT/UPDATE/DELETE/CREATE TABLE/DROP TABLE/etc.). " +
            "Requires 'sqlite3' CLI installed on the system PATH. " +
            "'export': dump all rows of a table to JSON or CSV format, optionally to an output file.",
        },

        path: {
          type: "string",
          description:
            "Path to the SQLite database file (.db, .sqlite, .sqlite3, or any extension). " +
            "For 'execute', the file is written by the sqlite3 CLI and will be created if it does not exist.",
        },

        sql: {
          type: "string",
          description:
            "SQL statement to run. " +
            "For 'query': must be a SELECT statement. " +
            "For 'execute': any DML/DDL statement (INSERT, UPDATE, DELETE, CREATE TABLE, DROP TABLE, etc.). " +
            "Max length: 1 MB.",
        },

        table: {
          type: "string",
          description:
            "For 'schema': scope the result to this table name (returns the table's CREATE TABLE SQL + column list, " +
            "plus any indexes or triggers attached to it). " +
            "For 'export': the table to dump (required).",
        },

        type: {
          type: "string",
          enum: ["table", "view", "index", "trigger"],
          description:
            "For 'tables': which object type to list (default: 'table'). " +
            "Set to 'view', 'index', or 'trigger' to list those object types instead.",
        },

        max_rows: {
          type: "integer",
          minimum: 1,
          description:
            "For 'query': maximum number of rows to return (default and hard cap: 1,000,000). " +
            "For 'export': maximum rows to include (default and hard cap: 100,000).",
        },

        format: {
          type: "string",
          enum: ["json", "csv"],
          description: "For 'export': output format — 'json' (default) or 'csv'.",
        },

        header: {
          type: "boolean",
          description:
            "For 'export' with format='csv': include a header row with column names (default: true).",
        },

        pretty: {
          type: "boolean",
          description:
            "For 'export' with format='json': pretty-print the JSON output with 2-space indentation (default: true). " +
            "Set to false for compact/minified output.",
        },

        output_file: {
          type: "string",
          description:
            "For 'export': write the output to this file path instead of returning inline. " +
            "Parent directories are created automatically.",
        },

        timeout: {
          type: "integer",
          minimum: 1000,
          description:
            "For 'execute': timeout in milliseconds for the sqlite3 CLI call (default: 30000; max: 300000).",
        },
      },
    },
  },
];

module.exports = { UTIL_SCHEMAS_63 };
