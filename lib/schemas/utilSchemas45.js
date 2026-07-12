"use strict";
// lib/schemas/utilSchemas45.js — JSON schema for graphql_client tool

const UTIL_SCHEMAS_45 = [
  {
    name: "graphql_client",
    description: "GraphQL HTTP/HTTPS client (pure Node.js; zero npm deps). Sends queries, mutations, and introspection requests to any GraphQL endpoint. Operations: query (execute a GraphQL query); mutate (execute a mutation); introspect (full schema introspection — types, fields, directives, summarised for readability); introspect_type (inspect a single named type); batch (send multiple operations in one HTTP request, using the standard JSON array batch format); subscribe_poll (poll a subscription query at a fixed interval and collect results, useful for long-poll GraphQL subscriptions). All operations send a POST with Content-Type: application/json and return { data, errors, hasErrors, extensions, statusCode }. Security: SSRF guard blocks private/loopback IPs by default; header injection prevention; response body size cap (default 10 MB, hard 50 MB). Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: {
      type: "object",
      required: ["operation", "url"],
      properties: {
        // ── Core ──────────────────────────────────────────────────────────────
        operation: {
          type: "string",
          enum: ["query", "mutate", "introspect", "introspect_type", "batch", "subscribe_poll"],
          description: "Operation to perform. 'query' and 'mutate' both POST a GraphQL document; 'introspect' fetches the full schema; 'introspect_type' inspects one named type; 'batch' sends an array of operations in one request; 'subscribe_poll' polls a query at an interval.",
        },
        url: {
          type: "string",
          description: "GraphQL endpoint URL. Must be http:// or https://.",
        },

        // ── Query payload ────────────────────────────────────────────────────
        query: {
          type: "string",
          description: "GraphQL query or mutation document string. Required for query, mutate, and subscribe_poll. Example: 'query { user(id: 1) { name email } }'.",
        },
        variables: {
          type: "object",
          description: "GraphQL variables object (key-value pairs). Passed as the 'variables' field in the request body.",
          additionalProperties: {},
        },
        operation_name: {
          type: "string",
          description: "GraphQL operationName: selects which named operation to execute when the document contains multiple operations.",
        },

        // ── Introspection specific ────────────────────────────────────────────
        type_name: {
          type: "string",
          description: "Name of the GraphQL type to inspect (required for introspect_type). Example: 'User', 'Query', 'CreatePostInput'.",
        },
        raw: {
          type: "boolean",
          description: "For introspect: return the raw __schema response instead of the summarised/cleaned-up version (default: false).",
        },

        // ── Batch specific ─────────────────────────────────────────────────
        operations: {
          type: "array",
          description: "Array of GraphQL operations for batch requests. Each item: { query, variables?, operation_name? }. Maximum 50 operations per batch.",
          items: {
            type: "object",
            required: ["query"],
            properties: {
              query:          { type: "string",  description: "GraphQL document string for this batch item." },
              variables:      { type: "object",  description: "Variables for this batch item.", additionalProperties: {} },
              operation_name: { type: "string",  description: "Operation name for this batch item." },
            },
            additionalProperties: false,
          },
          maxItems: 50,
        },

        // ── subscribe_poll specific ───────────────────────────────────────────
        max_polls: {
          type: "number",
          description: "Maximum number of poll iterations for subscribe_poll (default: 10, max: 100).",
        },
        poll_interval_ms: {
          type: "number",
          description: "Milliseconds between poll iterations for subscribe_poll (default: 2000, min: 100).",
        },
        stop_on_data: {
          type: "boolean",
          description: "For subscribe_poll: stop polling as soon as a successful data response (non-null, no errors) is received (default: true).",
        },

        // ── Auth ──────────────────────────────────────────────────────────────
        auth: {
          type: "object",
          description: "Authentication configuration.",
          properties: {
            type: {
              type: "string",
              enum: ["bearer", "basic", "api_key"],
              description: "Auth scheme: 'bearer' (Authorization: Bearer <token>), 'basic' (Base64 username:password), 'api_key' (custom header).",
            },
            token:    { type: "string", description: "Bearer token (required for type='bearer')." },
            username: { type: "string", description: "Username for Basic auth." },
            password: { type: "string", description: "Password for Basic auth (default: empty string)." },
            header:   { type: "string", description: "Header name for api_key auth (e.g. 'X-API-Key')." },
            value:    { type: "string", description: "Header value for api_key auth." },
          },
          required: ["type"],
        },

        // ── Request options ────────────────────────────────────────────────────
        headers: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Additional HTTP headers to include in every request (e.g. { 'X-Request-ID': 'abc' }). These are merged with Content-Type and any auth headers.",
        },
        timeout: {
          type: "number",
          description: "Request timeout in milliseconds per attempt (default: 30000).",
        },
        retry_count: {
          type: "number",
          description: "Number of retries on network error (default: 0). Uses exponential backoff.",
        },
        retry_delay_ms: {
          type: "number",
          description: "Base retry delay in milliseconds (default: 500). Actual delay = retry_delay_ms * 2^(attempt-1).",
        },

        // ── Security ───────────────────────────────────────────────────────────
        ssrf_guard: {
          type: "boolean",
          description: "Block requests to private/loopback IPs (default: true). Set to false to allow intranet GraphQL endpoints.",
        },
        max_response_bytes: {
          type: "number",
          description: "Maximum response body size in bytes (default: 10485760 = 10 MB; hard cap: 52428800 = 50 MB).",
        },

        // ── TLS ────────────────────────────────────────────────────────────────
        reject_unauthorized: {
          type: "boolean",
          description: "Reject TLS certificates that fail validation (default: true). Set to false to allow self-signed certificates.",
        },
        ca:   { type: "string", description: "Optional custom CA certificate (PEM string) for TLS verification." },
        cert: { type: "string", description: "Optional client TLS certificate (PEM string) for mutual TLS." },
        key:  { type: "string", description: "Optional client TLS private key (PEM string) for mutual TLS." },
      },
      additionalProperties: false,
    },
  },
];

module.exports = { UTIL_SCHEMAS_45 };
