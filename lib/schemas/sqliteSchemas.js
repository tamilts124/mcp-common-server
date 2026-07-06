"use strict";
// ── SQLITE TOOL SCHEMAS — EXEC-gated (arbitrary SQL execution) ──────────────

const SQLITE_SCHEMAS = [
  {
    name: "sqlite_create",
    description: "Create a new SQLite database file (or ':memory:'), optionally applying schema_sql. Uses Node's built-in node:sqlite (requires Node 22.5+).",
    inputSchema: { type: "object", required: ["path"], properties: {
      path: { type: "string", description: "Client path to the database file, or ':memory:'." },
      schema_sql: { type: "string", description: "Optional SQL to execute immediately after creation (e.g. CREATE TABLE statements)." },
    }},
  },
  {
    name: "sqlite_connect",
    description: "Open a connection to a SQLite database file (or ':memory:') and return a connection_id for use with sqlite_execute/sqlite_tables/sqlite_disconnect.",
    inputSchema: { type: "object", required: ["path"], properties: {
      path: { type: "string", description: "Client path to the database file, or ':memory:'." },
      read_only: { type: "boolean", description: "Open read-only (file must already exist). Default: false." },
    }},
  },
  {
    name: "sqlite_execute",
    description: "Execute SQL against an open connection. SELECT/PRAGMA/EXPLAIN/WITH statements return rows; others return changes/lastInsertRowid. Supports 'params' (array or object) for a single statement, or 'params_list' (array of params) to run the same statement as a batch.",
    inputSchema: { type: "object", required: ["connection_id", "sql"], properties: {
      connection_id: { type: "string", description: "Connection id from sqlite_connect." },
      sql: { type: "string", description: "SQL statement to execute." },
      params: { description: "Positional (array) or named (object) parameters for the statement.", oneOf: [{ type: "array" }, { type: "object" }] },
      params_list: { type: "array", description: "Array of params to run the same statement once per entry (batch mode)." },
    }},
  },
  {
    name: "sqlite_disconnect",
    description: "Close an open SQLite connection and free its handle.",
    inputSchema: { type: "object", required: ["connection_id"], properties: {
      connection_id: { type: "string", description: "Connection id from sqlite_connect." },
    }},
  },
  {
    name: "sqlite_connections",
    description: "List all currently open SQLite connections managed by this server.",
    inputSchema: { type: "object", required: [], properties: {} },
  },
  {
    name: "sqlite_tables",
    description: "List tables/views (and their columns) visible on an open connection.",
    inputSchema: { type: "object", required: ["connection_id"], properties: {
      connection_id: { type: "string", description: "Connection id from sqlite_connect." },
    }},
  },
];

module.exports = { SQLITE_SCHEMAS };
