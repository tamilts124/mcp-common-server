"use strict";
/**
 * utilSchemas83.js — JSON Schema for clickhouse_client tool.
 */

const clickhouseClientSchema = {
  name: "clickhouse_client",
  description:
    "Zero-dependency ClickHouse HTTP API client (pure Node.js http/https; no npm deps). " +
    "Connects to ClickHouse via its native HTTP interface (default port 8123 for HTTP, 8443 for HTTPS). " +
    "Operations: ping (check server liveness), info (server version and uptime), " +
    "query (execute SELECT/SHOW/DESCRIBE/EXPLAIN), insert (write rows in JSONEachRow or CSV format), " +
    "databases (SHOW DATABASES), tables (SHOW TABLES), " +
    "create_table (CREATE TABLE with schema and engine), drop_table (DROP TABLE). " +
    "Auth: X-ClickHouse-User / X-ClickHouse-Key headers (username/password). " +
    "Formats: JSONEachRow (default, one JSON object per line), JSON (full metadata), CSV, TSVWithNames. " +
    "Security: NUL-byte guards; timeout clamped 1s–300s; response capped at 32 MB; credentials not logged.",
  inputSchema: {
    type: "object",
    required: ["operation"],
    additionalProperties: false,
    properties: {
      operation: {
        type: "string",
        enum: ["ping", "info", "query", "insert", "databases", "tables", "create_table", "drop_table"],
        description:
          "Operation to perform. " +
          "'ping': check server liveness (GET /ping). " +
          "'info': return server version, uptime, and current database. " +
          "'query': execute a SELECT/SHOW/DESCRIBE/EXPLAIN SQL statement and return rows. " +
          "'insert': insert an array of row objects into a table. " +
          "'databases': list all databases (SHOW DATABASES). " +
          "'tables': list tables in a database (SHOW TABLES). " +
          "'create_table': create a new table with a column schema and engine. " +
          "'drop_table': drop a table (optionally IF EXISTS).",
      },
      // ── Connection ──
      host: {
        type: "string",
        description:
          "ClickHouse server hostname or IP address (default: '127.0.0.1'). " +
          "Examples: '10.0.0.5', 'clickhouse.example.com'.",
      },
      port: {
        type: "integer",
        minimum: 1,
        maximum: 65535,
        description:
          "HTTP port (default: 8123 for HTTP, 8443 for HTTPS). " +
          "ClickHouse default HTTP port is 8123; HTTPS is 8443.",
      },
      secure: {
        type: "boolean",
        description: "Use HTTPS instead of HTTP (default: false). Set true for TLS-secured ClickHouse instances.",
      },
      reject_unauthorized: {
        type: "boolean",
        description:
          "HTTPS only: reject servers with invalid/self-signed certificates (default: true). " +
          "Set false only in dev/test environments with self-signed certs.",
      },
      database: {
        type: "string",
        description:
          "Target database name (default: 'default'). " +
          "Sent as X-ClickHouse-Database header.",
      },
      username: {
        type: "string",
        description: "ClickHouse username (default: 'default'). Sent as X-ClickHouse-User header.",
      },
      password: {
        type: "string",
        description: "ClickHouse password (default: ''). Sent as X-ClickHouse-Key header.",
      },
      timeout: {
        type: "integer",
        minimum: 1000,
        maximum: 300000,
        description: "Request timeout in milliseconds (default: 30000, min: 1000, max: 300000).",
      },
      // ── query ──
      sql: {
        type: "string",
        description:
          "'query' operation: the SQL statement to execute. " +
          "Examples: 'SELECT * FROM system.tables LIMIT 10', 'SHOW DATABASES', 'DESCRIBE TABLE my_table'. " +
          "Use LIMIT to control result size (response capped at 32 MB).",
      },
      format: {
        type: "string",
        enum: ["JSONEachRow", "JSON", "CSV", "TSVWithNames", "TabSeparatedWithNames"],
        description:
          "Output format for 'query' operation (default: 'JSONEachRow'). " +
          "'JSONEachRow': one JSON object per line (easy parsing, default). " +
          "'JSON': full ClickHouse JSON envelope with meta/data/statistics. " +
          "'CSV': comma-separated values. " +
          "'TSVWithNames': tab-separated with header row.",
      },
      max_rows: {
        type: "integer",
        minimum: 1,
        maximum: 100000,
        description: "Maximum rows to return for 'query' operation (default: 10000, max: 100000).",
      },
      // ── insert ──
      table: {
        type: "string",
        description:
          "'insert', 'create_table', 'drop_table': target table name. " +
          "Examples: 'events', 'logs', 'metrics'.",
      },
      rows: {
        type: "array",
        description:
          "'insert' operation: array of row objects to insert. " +
          "Each element must be a plain object with column names as keys. " +
          "Maximum 100,000 rows per call. " +
          "Example: [{id: 1, name: 'Alice'}, {id: 2, name: 'Bob'}].",
        maxItems: 100000,
        items: { type: "object" },
      },
      // ── create_table ──
      schema: {
        type: "string",
        description:
          "'create_table': column definitions string (without outer parentheses). " +
          "Examples: 'id UInt64, name String, created_at DateTime', " +
          "'event_id UUID, ts DateTime64(3), payload String'.",
      },
      engine: {
        type: "string",
        description:
          "'create_table': ClickHouse table engine clause (without ENGINE =). " +
          "Examples: 'MergeTree() ORDER BY id', " +
          "'ReplacingMergeTree() ORDER BY (id, ts) PARTITION BY toYYYYMM(ts)', " +
          "'Memory()', 'Log()'.",
      },
      if_not_exists: {
        type: "boolean",
        description: "'create_table': add IF NOT EXISTS clause (default: true).",
      },
      // ── drop_table ──
      if_exists: {
        type: "boolean",
        description: "'drop_table': add IF EXISTS clause to avoid error if table doesn't exist (default: true).",
      },
    },
  },
};

module.exports = { clickhouseClientSchema };
