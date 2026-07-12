"use strict";
// lib/schemas/utilSchemas35.js — JSON schema for grpc_client tool

const UTIL_SCHEMAS_35 = [
  {
    name: "grpc_client",
    description: "Zero-dependency gRPC client using Node.js built-in `http2`. Implements the gRPC-over-HTTP/2 wire protocol with a hand-built proto3 varint/wire-type codec (no protobufjs required). Operations: unary (single request/response RPC), server_stream (collect all server-streaming RPC messages), health_check (gRPC Health Protocol v1 — grpc.health.v1.Health/Check), list_services (gRPC Server Reflection v1alpha — list available services). Request encoding: pass request_base64 for raw proto bytes, or request_json for a best-effort generic encoding (encodes as field 1 string). Response decoding: returns structured field list + base64 by default; use response_encoding='base64' for raw bytes only. Security: host NUL/CRLF guards; method path format validation; 16 MB per-message cap; TLS support with configurable reject_unauthorized. Requires MCP_ALLOW_EXEC.",
    inputSchema: {
      type: "object",
      required: ["operation"],
      properties: {
        operation: {
          type: "string",
          enum: ["unary", "server_stream", "health_check", "list_services"],
          description: "Operation to perform. unary=single request/response, server_stream=collect all streaming responses, health_check=gRPC Health Protocol v1, list_services=gRPC Server Reflection (list services).",
        },
        host: {
          type: "string",
          description: "gRPC server hostname or IP address (default: '127.0.0.1').",
        },
        port: {
          type: "number",
          description: "gRPC server TCP port (default: 50051).",
        },
        secure: {
          type: "boolean",
          description: "Use TLS (https) instead of plaintext (http). Default: false.",
        },
        reject_unauthorized: {
          type: "boolean",
          description: "Reject self-signed or invalid TLS certificates (default: true). Set false to allow self-signed certs.",
        },
        timeout: {
          type: "number",
          description: "Operation timeout in seconds (default: 30). Sent as grpc-timeout header.",
        },
        metadata: {
          type: "object",
          description: "Extra gRPC metadata (HTTP/2 headers) to include in the request, e.g. { 'authorization': 'Bearer token' }.",
        },

        // ── unary / server_stream ───────────────────────────────────────────
        method: {
          type: "string",
          description: "gRPC method path in the form '/package.Service/MethodName', e.g. '/helloworld.Greeter/SayHello'. Required for unary and server_stream.",
        },
        request_base64: {
          type: "string",
          description: "Raw proto3-encoded request message bytes as base64. Takes precedence over request_json. For exact wire-format control.",
        },
        request_json: {
          type: ["string", "object"],
          description: "Request payload to encode as a best-effort proto3 message (encodes JSON string/object as field 1 length-delimited string). For unary/server_stream when you don't have pre-encoded proto bytes.",
        },
        response_encoding: {
          type: "string",
          enum: ["fields", "base64", "raw"],
          description: "How to return the response bytes. 'fields' (default): decode proto fields + return base64. 'base64'/'raw': return base64-encoded bytes only.",
        },
        max_messages: {
          type: "number",
          description: "Maximum number of messages to collect in server_stream (default: 1000, hard cap: 1000).",
        },

        // ── health_check ───────────────────────────────────────────────────
        service: {
          type: "string",
          description: "Service name to check health for (e.g. 'helloworld.Greeter'). Omit or pass empty string to check overall server health (grpc.health.v1.Health/Check with empty service field).",
        },
      },
    },
  },
];

module.exports = { UTIL_SCHEMAS_35 };
