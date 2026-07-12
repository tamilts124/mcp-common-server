"use strict";
// lib/schemas/utilSchemas34.js — JSON schema for memcached_client tool

const UTIL_SCHEMAS_34 = [
  {
    name: "memcached_client",
    description: "Zero-dependency Memcached client using Node.js built-in `net`. Implements the Memcached ASCII text protocol (RFC-compatible). Operations: get (retrieve one or many keys), set (unconditional store), add (store only if absent), replace (store only if present), append (append data to existing value), prepend (prepend data to existing value), delete (remove key), increment (atomic counter incr), decrement (atomic counter decr), flush_all (invalidate all items, optional delay), stats (server statistics, optional subcommand), version (server version string). Security: key validation (no whitespace/control chars, max 250 bytes); host NUL/CRLF injection guards; 1 MB value cap; 32 MB response cap; 100-key multi-get limit. Wall-clock timeout (default 30s) + connect_timeout (default min(timeout,10s)). Requires MCP_ALLOW_EXEC.",
    inputSchema: {
      type: "object",
      required: ["operation"],
      properties: {
        operation: {
          type: "string",
          enum: ["get", "set", "add", "replace", "append", "prepend", "delete", "increment", "decrement", "flush_all", "stats", "version"],
          description: "Operation to perform. get=retrieve, set=unconditional store, add=store-if-absent, replace=store-if-present, append/prepend=extend value, delete=remove, increment/decrement=atomic counter ops, flush_all=invalidate all, stats=server stats, version=server version.",
        },
        host: {
          type: "string",
          description: "Memcached server hostname or IP address (default: '127.0.0.1').",
        },
        port: {
          type: "number",
          description: "Memcached server TCP port (default: 11211).",
        },
        timeout: {
          type: "number",
          description: "Total operation timeout in seconds (default: 30).",
        },
        connect_timeout: {
          type: "number",
          description: "TCP connection timeout in seconds (default: min(timeout, 10)).",
        },

        // ── get ────────────────────────────────────────────────────────────
        key: {
          type: "string",
          description: "Single key to operate on (for get/set/add/replace/append/prepend/delete/increment/decrement). Max 250 chars, no whitespace/control chars.",
        },
        keys: {
          type: "array",
          items: { type: "string" },
          description: "Multiple keys for a batch get (multi-get). Max 100 keys. Use instead of 'key' for multi-get.",
        },

        // ── set / add / replace / append / prepend ─────────────────────────
        value: {
          type: "string",
          description: "Value to store (for set/add/replace/append/prepend). UTF-8 string; max 1 MB.",
        },
        flags: {
          type: "number",
          description: "Opaque 16-bit integer stored with the value (default: 0). Application-defined; commonly used for serialization hints.",
        },
        exptime: {
          type: "number",
          description: "Expiration time in seconds from now (0 = never expire, default: 0). Values > 30 days (2592000s) are interpreted as Unix timestamps by Memcached.",
        },

        // ── increment / decrement ──────────────────────────────────────────
        delta: {
          type: "number",
          description: "Amount to increment or decrement (default: 1). Must be a non-negative integer. The counter value is treated as an unsigned 64-bit integer by the server.",
        },

        // ── flush_all ──────────────────────────────────────────────────────
        delay: {
          type: "number",
          description: "Seconds to delay the flush_all invalidation (default: 0, immediate). Allows a graceful rollover.",
        },

        // ── stats ──────────────────────────────────────────────────────────
        subcommand: {
          type: "string",
          description: "Optional stats subcommand: 'items' (slab class item counts), 'slabs' (slab class statistics), 'sizes' (item size histogram), 'conns' (connection details), 'settings' (server configuration). Omit for general server statistics.",
        },
      },
    },
  },
];

module.exports = { UTIL_SCHEMAS_34 };
