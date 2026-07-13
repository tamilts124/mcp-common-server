"use strict";

const CASSANDRA_CLIENT_SCHEMA = {
  name: "cassandra_client",
  description: "Zero-dependency Apache Cassandra CQL Native Protocol v4 client — pure Node.js net/tls, no npm deps. Compatible with Apache Cassandra 2.2+, ScyllaDB, DataStax Enterprise, and AstraDB. Supports SASL PLAIN authentication (username/password) and unauthenticated connections, optional TLS. Operations: info (server version, cluster name, CQL version, data center), keyspaces (list all keyspaces with replication settings), tables (list tables in a keyspace), describe (full column/primary-key schema for a table), query (execute any CQL statement and decode rows), execute (prepare then execute a parameterised statement in one call), batch (LOGGED/UNLOGGED/COUNTER batch of DML statements), use_keyspace (switch the active keyspace). Row values are decoded to native JS types: text/varchar→string, int/smallint/tinyint→number, bigint/counter→number or string, double→number, float→number, boolean→boolean, timestamp→ISO-8601 string, uuid/timeuuid→UUID string, inet→dotted/colon notation, date→YYYY-MM-DD, blob→base64, list/set→array, map→object. Security: NUL-byte guards; 32 MB response cap per frame; 10,000-row cap (configurable via page_size); credentials never appear in error messages; timeout clamped 1–300 s.",
  inputSchema: {
    type: "object",
    required: ["operation", "host"],
    properties: {
      operation: {
        type: "string",
        enum: ["info", "keyspaces", "tables", "describe", "query", "execute", "batch", "use_keyspace"],
        description: "Operation to perform. info=cluster info & options; keyspaces=list all keyspaces; tables=list tables in a keyspace; describe=table schema; query=execute CQL; execute=prepare+execute parameterised CQL; batch=batch DML; use_keyspace=switch keyspace.",
      },
      host: {
        type: "string",
        description: "Cassandra host (IP or hostname). Default: '127.0.0.1'.",
      },
      port: {
        type: "number",
        description: "CQL native protocol port (default: 9042).",
      },
      username: {
        type: "string",
        description: "Username for SASL PLAIN authentication. Omit for unauthenticated access.",
      },
      password: {
        type: "string",
        description: "Password for SASL PLAIN authentication.",
      },
      keyspace: {
        type: "string",
        description: "Keyspace to connect to (optional initial keyspace). Also used as the filter for 'tables' and 'describe'.",
      },
      use_keyspace: {
        type: "string",
        description: "Issue a USE <keyspace> before the main operation (query/execute/batch). Useful when no initial keyspace is set.",
      },
      tls: {
        type: "boolean",
        description: "Use TLS/SSL for the connection (default: false). Required for AstraDB and some managed Cassandra services.",
      },
      reject_unauthorized: {
        type: "boolean",
        description: "Reject TLS connections with invalid/self-signed certificates (default: true). Set false only for development.",
      },
      timeout: {
        type: "number",
        description: "Connection + operation timeout in milliseconds (1000–300000, default: 10000).",
      },
      cql: {
        type: "string",
        description: "CQL statement to execute (required for query/execute). Max 1 MB.",
      },
      values: {
        type: "array",
        description: "Positional bind values for the 'execute' operation (prepared statement '?' placeholders). Each element is a JS string, number, boolean, or null.",
        items: {},
      },
      consistency: {
        type: "string",
        enum: ["any", "one", "two", "three", "quorum", "all", "local_quorum", "each_quorum", "serial", "local_serial", "local_one"],
        description: "CQL consistency level for query/execute/batch (default: 'one').",
      },
      page_size: {
        type: "number",
        description: "Maximum number of rows per page for 'query' (1–10000, default: all rows up to 10000 cap).",
      },
      table: {
        type: "string",
        description: "Table name for the 'describe' operation.",
      },
      statements: {
        type: "array",
        description: "Array of CQL statements for the 'batch' operation. Each element: { cql: string, values?: any[] }.",
        items: {
          type: "object",
          required: ["cql"],
          properties: {
            cql:    { type: "string", description: "CQL DML statement (INSERT/UPDATE/DELETE)." },
            values: { type: "array",  items: {}, description: "Positional bind values." },
          },
        },
      },
      batch_type: {
        type: "string",
        enum: ["logged", "unlogged", "counter"],
        description: "Batch type for the 'batch' operation (default: 'logged'). 'logged'=atomic; 'unlogged'=best-effort; 'counter'=counter mutations.",
      },
    },
  },
};

module.exports = { CASSANDRA_CLIENT_SCHEMA };
