"use strict";
// lib/schemas/utilSchemas54.js — JSON schema for jsonrpc_client tool

const UTIL_SCHEMAS_54 = [
  {
    name: "jsonrpc_client",
    description:
      "Zero-dependency JSON-RPC 2.0 client (pure Node.js; no npm deps). " +
      "Supports HTTP, HTTPS, TCP, and Unix domain socket transports. " +
      "Implements the full JSON-RPC 2.0 specification: single calls, fire-and-forget notifications, " +
      "and batch requests. Useful for Ethereum/blockchain nodes (eth_getBalance, eth_blockNumber), " +
      "language servers (LSP), JSON-RPC APIs, and local dev servers. " +
      "All responses are validated; RPC-level errors are surfaced as tool errors with the JSON-RPC error code. " +
      "Operations: " +
      "call (single HTTP/HTTPS JSON-RPC request + response); " +
      "notify (HTTP/HTTPS fire-and-forget, no response expected); " +
      "batch (send multiple calls in a single HTTP/HTTPS request, responses aligned by id); " +
      "call_tcp (single call over TCP socket with newline-delimited JSON framing); " +
      "call_unix (single call over Unix domain socket). " +
      "Security: 10 MB response cap; 100-call batch limit; NUL-byte path guard for Unix sockets. " +
      "Requires MCP_ALLOW_EXEC=true or network access to be enabled.",
    inputSchema: {
      type: "object",
      required: ["operation"],
      additionalProperties: false,
      properties: {
        operation: {
          type: "string",
          enum: ["call", "notify", "batch", "call_tcp", "call_unix"],
          description:
            "Operation to perform. " +
            "'call': send a single JSON-RPC request over HTTP/HTTPS and return the result. " +
            "'notify': send a JSON-RPC notification (no id, no response expected) over HTTP/HTTPS. " +
            "'batch': send an array of JSON-RPC calls in a single HTTP/HTTPS request. " +
            "'call_tcp': send a single JSON-RPC call over a TCP socket (newline-delimited JSON). " +
            "'call_unix': send a single JSON-RPC call over a Unix domain socket.",
        },

        // ---- HTTP/HTTPS transport (call, notify, batch) ----
        url: {
          type: "string",
          description:
            "For 'call', 'notify', 'batch': the HTTP or HTTPS endpoint URL (e.g. 'http://localhost:8545'). Required.",
        },

        // ---- TCP transport (call_tcp) ----
        host: {
          type: "string",
          description: "For 'call_tcp': TCP host or IP address (e.g. '127.0.0.1'). Required.",
        },
        port: {
          type: "integer",
          minimum: 1,
          maximum: 65535,
          description: "For 'call_tcp': TCP port number. Required.",
        },

        // ---- Unix socket transport (call_unix) ----
        socket_path: {
          type: "string",
          description:
            "For 'call_unix': absolute path to the Unix domain socket file (e.g. '/var/run/app.sock'). Required.",
        },

        // ---- Single call / notify ----
        method: {
          type: "string",
          description:
            "For 'call', 'notify', 'call_tcp', 'call_unix': the JSON-RPC method name (e.g. 'eth_blockNumber', 'initialize'). Required.",
        },
        params: {
          description:
            "For 'call', 'notify', 'call_tcp', 'call_unix': the method parameters. " +
            "May be an array (positional) or object (named), per the JSON-RPC 2.0 spec. " +
            "Omit or set to null for methods with no parameters.",
        },
        id: {
          description:
            "For 'call', 'call_tcp', 'call_unix': explicit request id (string or integer). " +
            "If omitted, an auto-incrementing integer is used.",
        },

        // ---- Batch calls ----
        calls: {
          type: "array",
          description:
            "For 'batch': array of call descriptors (up to 100). Each descriptor has: " +
            "'method' (string, required), 'params' (any, optional), 'id' (string|number, optional), " +
            "'notify' (boolean, optional — if true, no id is sent and no response is expected). " +
            "Example: [{ \"method\": \"eth_blockNumber\" }, { \"method\": \"eth_chainId\" }].",
          items: {
            type: "object",
            required: ["method"],
            additionalProperties: false,
            properties: {
              method: { type: "string", description: "JSON-RPC method name." },
              params: { description: "Method parameters (array or object)." },
              id:     { description: "Explicit request id (string or integer)." },
              notify: {
                type: "boolean",
                description: "If true, send as a notification (no id, no response expected).",
              },
            },
          },
          maxItems: 100,
        },

        // ---- Common options ----
        headers: {
          type: "object",
          description:
            "For 'call', 'notify', 'batch': additional HTTP request headers " +
            "(e.g. { \"Authorization\": \"Bearer token123\" }). Default Content-Type is application/json.",
          additionalProperties: { type: "string" },
        },
        timeout: {
          type: "integer",
          minimum: 100,
          maximum: 300_000,
          description:
            "Request timeout in milliseconds. Default: 30000 (30 seconds).",
        },
        reject_unauthorized: {
          type: "boolean",
          description:
            "For HTTPS: whether to reject invalid/self-signed TLS certificates. Default: true. " +
            "Set to false to allow self-signed certs (useful for local dev).",
        },
        include_raw: {
          type: "boolean",
          description:
            "If true, include the raw response body string in the result (useful for debugging). Default: false.",
        },
      },
    },
  },
];

module.exports = { UTIL_SCHEMAS_54 };
