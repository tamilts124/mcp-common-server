"use strict";
// ── UTILITY TOOL SCHEMAS — part 26 ────────────────────────────────────────────────
// Added: mqtt_client (v4.165.0).

const UTIL_SCHEMAS_26 = [
  {
    name: "mqtt_client",
    description:
      "Zero-dependency MQTT v3.1.1 client — pure Node.js net/tls, no npm deps.\n\n" +
      "Operations:\n" +
      "  connect   — TCP/TLS handshake + CONNECT → CONNACK (connectivity probe)\n" +
      "  ping      — CONNECT + PINGREQ → PINGRESP latency check\n" +
      "  publish   — Publish a message to a topic (QoS 0 fire-and-forget or QoS 1 acknowledged)\n" +
      "  subscribe — Subscribe to topic filters and collect arriving messages for a timeout window\n" +
      "  pubsub    — Subscribe to a topic, publish to it, then wait to receive the echoed message\n\n" +
      "Connection options:\n" +
      "  host, port (default 1883/8883), tls, reject_unauthorized\n" +
      "  username, password (AUTH credentials, never echoed in results)\n" +
      "  keep_alive (default 60s), clean_session (default true)\n" +
      "  timeout (default 30s), connect_timeout (default min(timeout,10s))\n\n" +
      "Security guards:\n" +
      "  NUL-byte injection guard on all topic, filter, username, password fields\n" +
      "  1 MB payload cap per message\n" +
      "  Topic length capped at 65535 bytes (MQTT spec)\n\n" +
      "Will message (Last Will and Testament):\n" +
      "  will_topic, will_payload, will_qos (0/1), will_retain\n\n" +
      "Returns { host, port, operation, clientId, elapsedMs, ...operation-specific fields }.\n" +
      "Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: {
      type: "object",
      required: ["host", "operation"],
      properties: {
        host: {
          type: "string",
          description: "MQTT broker hostname or IP address.",
        },
        port: {
          type: "number",
          description: "MQTT broker port (default: 1883, or 8883 when tls:true).",
        },
        tls: {
          type: "boolean",
          description: "Use TLS/SSL (MQTTS). Default: false.",
        },
        reject_unauthorized: {
          type: "boolean",
          description: "Reject self-signed TLS certificates (default: true).",
        },
        username: {
          type: "string",
          description: "MQTT CONNECT username. Never returned in results.",
        },
        password: {
          type: "string",
          description: "MQTT CONNECT password. Never returned in results.",
        },
        client_id: {
          type: "string",
          description: "MQTT client identifier (max 23 chars; auto-generated if omitted).",
        },
        keep_alive: {
          type: "number",
          description: "CONNECT keep-alive interval in seconds (default: 60).",
        },
        clean_session: {
          type: "boolean",
          description: "CONNECT CleanSession flag (default: true).",
        },
        timeout: {
          type: "number",
          description: "Total wall-clock timeout in seconds (default: 30).",
        },
        connect_timeout: {
          type: "number",
          description: "TCP connection timeout in seconds (default: min(timeout,10)).",
        },
        will_topic: {
          type: "string",
          description: "Last Will and Testament topic.",
        },
        will_payload: {
          type: "string",
          description: "LWT payload string (default: empty).",
        },
        will_qos: {
          type: "number",
          description: "LWT QoS level: 0 (default) or 1.",
        },
        will_retain: {
          type: "boolean",
          description: "LWT retain flag (default: false).",
        },
        operation: {
          type: "string",
          enum: ["connect", "ping", "publish", "subscribe", "pubsub"],
          description:
            "MQTT operation: connect (probe), ping (latency), publish (send message), " +
            "subscribe (collect messages), pubsub (publish then verify receipt).",
        },
        topic: {
          type: "string",
          description: "Topic name to publish to. Required for: publish, pubsub.",
        },
        payload: {
          type: "string",
          description: "Message payload (default: empty). For publish, pubsub.",
        },
        payload_encoding: {
          type: "string",
          enum: ["utf8", "base64"],
          description: "Payload encoding: 'utf8' (default) or 'base64' for binary.",
        },
        qos: {
          type: "number",
          description: "Publish QoS: 0 (fire-and-forget, default) or 1 (acknowledged).",
        },
        retain: {
          type: "boolean",
          description: "Set retain flag on published messages (default: false).",
        },
        topic_filters: {
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" }, minItems: 1 },
          ],
          description:
            "Topic filter or array of filters. Wildcards: '+' (single level), '#' (multi-level). Required for: subscribe.",
        },
        subscribe_qos: {
          type: "number",
          description: "Subscribe QoS level: 0 (default) or 1.",
        },
        max_messages: {
          type: "number",
          description: "Max messages to collect during subscribe (1–500, default: 10).",
        },
        subscribe_timeout: {
          type: "number",
          description: "Seconds to wait for incoming messages (default: 5). For subscribe, pubsub.",
        },
        wait_for_own: {
          type: "boolean",
          description: "pubsub: match echoed message by payload (default: true). Set false to accept any message on the topic.",
        },
      },
    },
  },
];

module.exports = { UTIL_SCHEMAS_26 };
