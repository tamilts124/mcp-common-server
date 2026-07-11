"use strict";
// ── UTILITY TOOL SCHEMAS — part 16 ────────────────────────────────────────────────────
// Added: multipart_upload (v4.152.0), http_serve (v4.152.0).

const UTIL_SCHEMAS_16 = [
  // ── multipart_upload ──────────────────────────────────────────────────────────────────
  {
    name: "multipart_upload",
    description:
      "Send an HTTP multipart/form-data request (POST/PUT/PATCH) to any URL. " +
      "Zero npm dependencies — builds the MIME boundary and encodes all parts in pure Node.js. " +
      "Typical use cases: upload files to a REST API, send webhook payloads with attachments, " +
      "submit HTML forms programmatically. " +
      "'fields': key-value pairs encoded as text form fields (Content-Disposition: form-data; name=\"...\"). " +
      "'files': files read from disk; each entry needs 'name' (field name) and 'path' (server-side file path); " +
      "  optional 'filename' (overrides the basename of path) and 'content_type'. " +
      "'inline_files': in-memory data sent as a file part without touching disk; " +
      "  each entry needs 'name', 'data' (string or base64), 'filename'; optional 'encoding' and 'content_type'. " +
      "At least one of fields/files/inline_files must be non-empty. " +
      "Response body is truncated at 100 KB to avoid flooding the MCP response channel — " +
      "use http_download to save large responses to disk instead. " +
      "Returns { url, method, status, ok, headers, body, bodySize, truncated, boundary, partCount, requestBodySize }. " +
      "Requires MCP_ALLOW_EXEC (outbound HTTP).",
    inputSchema: {
      type: "object",
      required: ["url"],
      properties: {
        url: {
          type: "string",
          description: "Target URL for the upload (http or https only). E.g. 'https://api.example.com/upload'.",
        },
        method: {
          type: "string",
          description: "HTTP method: 'POST' (default), 'PUT', or 'PATCH'.",
        },
        fields: {
          type: "object",
          description:
            "Plain key-value pairs to include as text form fields. " +
            "Values are stringified. Max 100 fields.",
        },
        files: {
          type: "array",
          description:
            "Files to read from disk and attach as form-data file parts. " +
            "Each entry: { name (required), path (required), filename?, content_type? }. " +
            "'name' is the HTML form field name; 'path' is the server-side file path.",
          items: {
            type: "object",
            required: ["name", "path"],
            properties: {
              name:         { type: "string", description: "Form field name for this file part." },
              path:         { type: "string", description: "Server-side path to the file." },
              filename:     { type: "string", description: "Filename sent in Content-Disposition (default: basename of path)." },
              content_type: { type: "string", description: "MIME type (default: application/octet-stream)." },
            },
          },
        },
        inline_files: {
          type: "array",
          description:
            "In-memory data sent as file parts without reading from disk. " +
            "Each entry: { name (required), data (required), filename (required), encoding?, content_type? }. " +
            "'encoding' is 'utf8' (default) or 'base64'. Max 50 MB per part.",
          items: {
            type: "object",
            required: ["name", "data", "filename"],
            properties: {
              name:         { type: "string", description: "Form field name." },
              data:         { type: "string", description: "File content as a string (UTF-8 or base64)." },
              filename:     { type: "string", description: "Filename to report in Content-Disposition." },
              encoding:     { type: "string", description: "Data encoding: 'utf8' (default) or 'base64'." },
              content_type: { type: "string", description: "MIME type (default: application/octet-stream)." },
            },
          },
        },
        headers: {
          type: "object",
          description: "Extra HTTP headers to include in the request (e.g. Authorization). Content-Type is set automatically.",
        },
        timeout: {
          type: "number",
          description: "Request timeout in seconds (default: 30, max: 300).",
        },
      },
    },
  },

  // ── http_serve ────────────────────────────────────────────────────────────────────────────
  {
    name: "http_serve",
    description:
      "Start and manage temporary in-process HTTP mock servers — Node.js http module only, zero npm dependencies. " +
      "Each server is a 'session' identified by a session_id UUID. " +
      "Typical use cases: " +
      "(1) Webhook receiver — start a server, trigger the external service, poll with operation:'requests'. " +
      "(2) API mock for browser/CLI automation — configure fixed routes before running tests. " +
      "(3) Integration helper — capture what an outbound run_command/http_fetch sends. " +
      "Servers listen on 127.0.0.1 only (loopback). Must be explicitly stopped with operation:'stop' to free the port. " +
      "Does NOT require MCP_ALLOW_EXEC. " +
      "\n\nOperations:\n" +
      "'start': Start a new mock server. Params: port? (0=OS-assigned), routes? (array of route objects). " +
      "  Returns: { session_id, url, port, routes_count, startedAt }. " +
      "'stop': Stop a session's server and release the port. Params: session_id. " +
      "'status': List all active server sessions (no params). " +
      "'requests': Get requests captured by a session. Params: session_id, limit?, clear?. " +
      "  Returns: { session_id, total_captured, returned, cleared, requests }. " +
      "'add_route': Prepend a route to an active session (higher priority than existing routes). " +
      "  Params: session_id, route. " +
      "'clear_requests': Clear the captured request log. Params: session_id. " +
      "'wait': Block until a matching request arrives or timeout. " +
      "  Params: session_id, path_match?, method_match?, timeout? (seconds, max 60, default 10). " +
      "  Returns: { found, request?, waited_ms, timed_out? }. " +
      "\n\nRoute definition: { method (default '*'), path (required; '*' matches all; '/prefix/*' prefix), " +
      "  status? (default 200), headers? (object), body? (string), delay_ms? (0–5000) }. " +
      "Routes are matched top-to-bottom; first match wins. Unmatched requests get a 404 JSON response. " +
      "Incoming request bodies are captured up to 1 MB per request (1000 requests max per session).",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          description:
            "Operation: 'start' (default), 'stop', 'status', 'requests', 'add_route', 'clear_requests', 'wait'.",
        },
        session_id: {
          type: "string",
          description: "Session UUID returned by operation:'start'. Required for all operations except 'start' and 'status'.",
        },
        port: {
          type: "number",
          description:
            "For 'start': port to listen on (default 0 = OS-assigned random port). " +
            "Use 0 to avoid port conflicts in CI environments.",
        },
        routes: {
          type: "array",
          description:
            "For 'start': initial route definitions. Applied in order; first match wins. Max 200 routes.",
          items: {
            type: "object",
            required: ["path"],
            properties: {
              method:   { type: "string",  description: "HTTP method to match: 'GET', 'POST', etc., or '*' to match any method (default: '*')." },
              path:     { type: "string",  description: "Path to match. Exact (e.g. '/api/data'), prefix (e.g. '/api/*'), or '*' for any path." },
              status:   { type: "number",  description: "Response status code (default: 200)." },
              headers:  { type: "object",  description: "Extra response headers (e.g. { 'x-foo': 'bar' })." },
              body:     { type: "string",  description: "Response body string (default: empty string)." },
              delay_ms: { type: "number",  description: "Artificial response delay in ms (0–5000, default: 0)." },
            },
          },
        },
        route: {
          type: "object",
          description: "For 'add_route': a single route definition to prepend to the session's route list.",
          required: ["path"],
          properties: {
            method:   { type: "string" },
            path:     { type: "string" },
            status:   { type: "number" },
            headers:  { type: "object" },
            body:     { type: "string" },
            delay_ms: { type: "number" },
          },
        },
        limit: {
          type: "number",
          description: "For 'requests': maximum number of requests to return (default: all captured, up to 1000).",
        },
        clear: {
          type: "boolean",
          description: "For 'requests': if true, clear the captured request log after returning results.",
        },
        path_match: {
          type: "string",
          description: "For 'wait': match requests whose path starts with this prefix. Supports same pattern syntax as route.path.",
        },
        method_match: {
          type: "string",
          description: "For 'wait': match requests with this HTTP method (case-insensitive). Omit to match any method.",
        },
        timeout: {
          type: "number",
          description: "For 'wait': seconds to wait for a matching request before returning timed_out:true (max: 60, default: 10).",
        },
      },
    },
  },
];

module.exports = { UTIL_SCHEMAS_16 };
