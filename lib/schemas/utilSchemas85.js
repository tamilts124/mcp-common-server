"use strict";

const coapClientSchema = {
  name: "coap_client",
  description: "Zero-dependency CoAP (Constrained Application Protocol, RFC 7252) client (pure Node.js dgram; no npm deps). Communicates with IoT devices, embedded sensors, M2M gateways, and any CoAP-capable endpoint over UDP. Supports confirmable (CON) and non-confirmable (NON) messages with automatic retransmission per RFC 7252 \u00a74.2. Operations: get (read resource), post (create/execute), put (update), delete, discover (RFC 6690 /.well-known/core resource listing), observe (RFC 7641 event subscription), ping (Empty CON reachability check), info (config/protocol reference). URI parsing supports coap://host[:port]/path?query and bare paths. Content-Format and Accept options settable by name or numeric ID. Modbus response codes decoded to human-readable strings. Security: NUL-byte guard on host/URI; timeout clamped 500ms-60s; payload capped 256 KB; no credentials (DTLS out of scope).",
  inputSchema: {
    type: "object",
    required: ["operation"],
    properties: {
      operation: {
        type: "string",
        enum: ["get", "post", "put", "delete", "discover", "observe", "ping", "info"],
        description: "Operation to perform. get=CoAP GET (read resource), post=CoAP POST (create/execute), put=CoAP PUT (update), delete=CoAP DELETE, discover=GET /.well-known/core for resource listing (RFC 6690), observe=subscribe to resource notifications (RFC 7641), ping=Empty CON reachability check, info=show config without connecting.",
      },
      host: {
        type: "string",
        description: "Hostname or IP address of the CoAP server (default: '127.0.0.1'). Overridden by host in 'uri' if a full coap:// URI is given.",
      },
      port: {
        type: "number",
        description: "UDP port of the CoAP server (default: 5683, the standard CoAP port).",
      },
      uri: {
        type: "string",
        description: "CoAP URI of the resource, e.g. 'coap://192.168.1.10/sensors/temp' or '/sensors/temp'. Overrides host/port/path if a full coap:// URI is provided. For discover, defaults to /.well-known/core.",
      },
      path: {
        type: "string",
        description: "Resource path, e.g. '/sensors/temperature'. Alternative to 'uri'. Ignored if 'uri' is set. Defaults to '/'.",
      },
      payload: {
        description: "Request payload for POST/PUT. String values are UTF-8 encoded; objects are JSON-serialised. Binary not supported here (use a string with pre-encoded content).",
      },
      content_format: {
        description: "Content-Format option for the request payload. Accepts numeric ID (e.g. 50) or name: 'text/plain' (0), 'application/link-format' (40), 'application/xml' (41), 'application/octet-stream' (42), 'application/json' (50), 'application/cbor' (60). If omitted, no Content-Format option is sent.",
      },
      accept: {
        description: "Accept option: the content-format the client prefers in the response. Same values as content_format. If omitted, server chooses.",
      },
      confirmable: {
        type: "boolean",
        description: "If true (default), send as CON (Confirmable) message; server must ACK. If false, send as NON (Non-Confirmable). CON is more reliable but NON is lower latency for best-effort telemetry.",
      },
      timeout: {
        type: "number",
        description: "Total timeout in milliseconds (default: 5000, range: 500-60000). For CON messages this covers all retransmit attempts.",
      },
      max_notifications: {
        type: "number",
        description: "For 'observe' only: maximum number of notifications to collect before deregistering (default: 3, max: 20). Observation ends when this count is reached or the timeout fires.",
      },
    },
  },
};

module.exports = { coapClientSchema };
