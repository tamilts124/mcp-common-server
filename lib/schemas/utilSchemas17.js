"use strict";
// ── UTILITY TOOL SCHEMAS — part 17 ──────────────────────────────────────────────────────
// Added: websocket_client (v4.154.0), sse_client (v4.154.0).

const UTIL_SCHEMAS_17 = [
  // ── websocket_client ───────────────────────────────────────────────────────────────
  {
    name: "websocket_client",
    description:
      "Connect to a WebSocket server, send messages, receive responses, and close — " +
      "all in one tool call. Zero npm dependencies: implements the full RFC 6455 WebSocket " +
      "handshake and frame protocol using Node.js built-in net/tls/crypto modules. " +
      "Supports ws:// (plain TCP) and wss:// (TLS). " +
      "Supports text frames (UTF-8 string) and binary frames (base64-encoded). " +
      "Handles fragmented WebSocket messages (continuation frames) transparently. " +
      "Auto-responds to server Ping frames with Pong (keep-alive compliance). " +
      "Typical use cases: test WebSocket APIs, inspect real-time server messages, " +
      "automate WS-based RPC/chat/event-streaming workflows. " +
      "'messages' is an optional array of frames to send after the handshake; " +
      "  each entry must have exactly one of 'text' (string) or 'data' (base64 string + optional encoding). " +
      "'timeout' caps the total connection lifetime. " +
      "Connection closes when: max_messages is reached, the server sends a Close frame, " +
      "  timeout elapses, or after all messages are sent (if max_messages not yet hit). " +
      "Returns { url, connected, handshakeMs, messagesSent, messagesReceived, messages, " +
      "closed, closeCode, closeReason, elapsedMs, error? }. " +
      "Each received message: { index, type, data, dataEncoding, elapsedMs, sizeBytes }. " +
      "'error' is present only on connection or protocol failures; partial results are still returned. " +
      "Requires MCP_ALLOW_EXEC (outbound TCP/TLS).",
    inputSchema: {
      type: "object",
      required: ["url"],
      properties: {
        url: {
          type: "string",
          description:
            "WebSocket server URL. Must start with 'ws://' (plain TCP) or 'wss://' (TLS/SSL). " +
            "E.g. 'ws://localhost:8080/chat' or 'wss://stream.example.com/events'.",
        },
        messages: {
          type: "array",
          description:
            "Frames to send to the server after the handshake. Optional — omit to connect " +
            "and only receive. Max 100 frames per call. " +
            "Each entry: { text?: string, data?: string, encoding?: string, delay_ms?: number }. " +
            "Exactly one of 'text' or 'data' must be present. " +
            "'text' sends a UTF-8 text frame. " +
            "'data' sends a binary frame; encoding defaults to 'base64'. " +
            "'delay_ms' waits before sending this frame (0–60000 ms, default 0).",
          items: {
            type: "object",
            properties: {
              text:     { type: "string",  description: "UTF-8 text payload to send as a text frame. Max 512 KB." },
              data:     { type: "string",  description: "Binary payload as a base64 (or other encoding) string. Max 512 KB encoded." },
              encoding: { type: "string",  description: "Encoding of 'data': 'base64' (default), 'hex', or 'utf8'." },
              delay_ms: { type: "number",  description: "Milliseconds to wait before sending this frame (0–60000, default 0)." },
            },
          },
        },
        timeout: {
          type: "number",
          description:
            "Total connection lifetime in seconds. Connection is closed (with a Close frame) " +
            "once this elapses. Default: 10, max: 120.",
        },
        max_messages: {
          type: "number",
          description:
            "Maximum number of data frames to collect from the server before closing " +
            "(default: 50, max: 1000). Once reached, a Close frame is sent and the " +
            "connection is terminated.",
        },
        headers: {
          type: "object",
          description:
            "Extra HTTP headers to include in the WebSocket Upgrade request " +
            "(e.g. { 'Authorization': 'Bearer token123' }). " +
            "Cannot override WebSocket protocol headers (Upgrade, Connection, " +
            "Sec-WebSocket-Key, Sec-WebSocket-Version). Max 30 headers.",
        },
        subprotocol: {
          type: "string",
          description:
            "Requested WebSocket sub-protocol (Sec-WebSocket-Protocol header value). " +
            "E.g. 'chat', 'graphql-ws', 'v10.stomp'. Max 200 characters.",
        },
      },
    },
  },

  // ── sse_client ─────────────────────────────────────────────────────────────────────────
  {
    name: "sse_client",
    description:
      "Connect to a Server-Sent Events (SSE) endpoint, collect events, and return them. " +
      "Zero npm dependencies: uses Node.js built-in http/https modules and a " +
      "spec-compliant RFC 8895 SSE parser (handles data:, event:, id:, retry: fields; " +
      "multi-line data fields; CRLF/LF/CR line endings; comment lines). " +
      "Typical use cases: consume real-time server push feeds, test SSE APIs, " +
      "monitor event-driven dashboards, capture webhook fan-out notifications, " +
      "read AI streaming chat completions. " +
      "The stream is read for 'timeout' seconds (or until 'max_events' is reached), " +
      "then the connection is closed and results are returned synchronously. " +
      "'event_types' optionally filters events by their 'event' field " +
      "(default: include all; unnamed server events have event='message'). " +
      "'last_event_id' sends a Last-Event-ID header to resume an interrupted stream. " +
      "Returns { url, connected, status, eventCount, events, truncated, elapsedMs, error? }. " +
      "Each event: { index, id, event, data, timestamp }. " +
      "'truncated:true' when max_events was reached before the stream ended. " +
      "Requires MCP_ALLOW_EXEC (outbound HTTP).",
    inputSchema: {
      type: "object",
      required: ["url"],
      properties: {
        url: {
          type: "string",
          description:
            "Full URL of the SSE endpoint. Must start with 'http://' or 'https://'. " +
            "E.g. 'https://api.example.com/v1/events' or 'http://localhost:3000/stream'.",
        },
        headers: {
          type: "object",
          description:
            "Extra HTTP request headers (e.g. { 'Authorization': 'Bearer <token>' }). " +
            "'Accept' and 'Cache-Control' are set automatically. Max 30 headers.",
        },
        timeout: {
          type: "number",
          description:
            "Seconds to collect events before closing the connection (default: 10, max: 120). " +
            "Once elapsed, any partially buffered event is discarded and collected " +
            "events are returned.",
        },
        max_events: {
          type: "number",
          description:
            "Maximum number of SSE events to collect before closing (default: 100, max: 5000). " +
            "When reached, 'truncated:true' is set in the response.",
        },
        event_types: {
          type: "array",
          items: { type: "string" },
          description:
            "Filter: only include events whose 'event' field matches one of these values. " +
            "Unnamed server events (no 'event:' line) have event='message'. " +
            "Omit to collect all event types.",
        },
        last_event_id: {
          type: "string",
          description:
            "Value to send as the Last-Event-ID HTTP header, allowing resumption of an " +
            "interrupted stream at the last received event (the server must support this).",
        },
      },
    },
  },
];

module.exports = { UTIL_SCHEMAS_17 };
