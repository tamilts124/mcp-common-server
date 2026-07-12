"use strict";
// ── UTILITY TOOL SCHEMAS — part 27 ────────────────────────────────────────────────
// Added: amqp_client (v4.166.0).

const UTIL_SCHEMAS_27 = [
  {
    name: "amqp_client",
    description:
      "Zero-dependency AMQP 0-9-1 client — pure Node.js net/tls, no npm deps.\n\n" +
      "Compatible with: RabbitMQ, Azure Service Bus (AMQP), CloudAMQP, ActiveMQ.\n\n" +
      "Operations:\n" +
      "  connect       — TCP/TLS handshake + full AMQP handshake + channel open (connectivity probe)\n" +
      "  publish       — Publish a message to an exchange with a routing key\n" +
      "  get           — Poll a single message from a queue (basic.get)\n" +
      "  consume       — Subscribe to a queue and collect messages for a timeout window\n" +
      "  declare_queue — Declare (create/assert) a queue\n" +
      "  delete_queue  — Delete a queue\n" +
      "  purge         — Remove all undelivered messages from a queue\n" +
      "  ack           — Acknowledge a delivered message by delivery tag\n" +
      "  nack          — Negative-acknowledge a delivered message (reject / requeue)\n\n" +
      "Connection options:\n" +
      "  host, port (default 5672/5671 for TLS), tls, reject_unauthorized\n" +
      "  username, password (PLAIN SASL; credentials never echoed in results)\n" +
      "  vhost (default '/'), heartbeat (default 0), timeout (default 30s)\n\n" +
      "Security guards:\n" +
      "  NUL-byte injection guard on all string fields\n" +
      "  10 MB message body cap\n" +
      "  Credentials never included in result objects\n\n" +
      "Returns { host, port, vhost, operation, elapsedMs, ...operation-specific fields }.\n" +
      "Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: {
      type: "object",
      required: ["host", "operation"],
      properties: {
        host: {
          type: "string",
          description: "AMQP broker hostname or IP address.",
        },
        port: {
          type: "number",
          description: "AMQP broker port (default: 5672, or 5671 when tls:true).",
        },
        tls: {
          type: "boolean",
          description: "Use TLS/SSL (AMQPS). Default: false.",
        },
        reject_unauthorized: {
          type: "boolean",
          description: "Reject self-signed TLS certificates (default: true).",
        },
        username: {
          type: "string",
          description: "AMQP username for PLAIN SASL auth (default: 'guest'). Never returned in results.",
        },
        password: {
          type: "string",
          description: "AMQP password for PLAIN SASL auth (default: 'guest'). Never returned in results.",
        },
        vhost: {
          type: "string",
          description: "AMQP virtual host (default: '/').",
        },
        heartbeat: {
          type: "number",
          description: "AMQP heartbeat interval in seconds (default: 0 = disabled).",
        },
        timeout: {
          type: "number",
          description: "Total wall-clock timeout in seconds (default: 30).",
        },
        connect_timeout: {
          type: "number",
          description: "TCP connection timeout in seconds (default: min(timeout,10)).",
        },
        operation: {
          type: "string",
          enum: ["connect", "publish", "get", "consume", "declare_queue", "delete_queue", "purge", "ack", "nack"],
          description:
            "AMQP operation: connect (probe), publish (send message), get (poll one message), " +
            "consume (subscribe + collect), declare_queue, delete_queue, purge, ack, nack.",
        },
        exchange: {
          type: "string",
          description: "Exchange name to publish to (default: '' = default exchange). For: publish.",
        },
        routing_key: {
          type: "string",
          description: "Routing key for published messages (default: ''). For: publish.",
        },
        queue: {
          type: "string",
          description: "Queue name. Required for: get, consume, declare_queue, delete_queue, purge.",
        },
        body: {
          type: "string",
          description: "Message body to publish (default: ''). For: publish.",
        },
        body_encoding: {
          type: "string",
          enum: ["utf8", "base64"],
          description: "Body encoding: 'utf8' (default) or 'base64' for binary messages. For: publish.",
        },
        content_type: {
          type: "string",
          description: "MIME content type header for published messages (default: 'text/plain'). For: publish.",
        },
        persistent: {
          type: "boolean",
          description: "Set delivery-mode=2 (persistent) on published messages (default: false). For: publish.",
        },
        mandatory: {
          type: "boolean",
          description: "Set mandatory flag on published messages (default: false). For: publish.",
        },
        durable: {
          type: "boolean",
          description: "Declare queue as durable (survives broker restart). Default: false. For: declare_queue.",
        },
        exclusive: {
          type: "boolean",
          description: "Declare queue as exclusive to this connection. Default: false. For: declare_queue.",
        },
        auto_delete: {
          type: "boolean",
          description: "Auto-delete queue when last consumer disconnects. Default: false. For: declare_queue.",
        },
        passive: {
          type: "boolean",
          description: "Passive declare: check if queue exists without creating it. Default: false. For: declare_queue.",
        },
        queue_args: {
          type: "object",
          description: "Additional queue arguments (e.g. x-message-ttl, x-dead-letter-exchange). For: declare_queue.",
          additionalProperties: true,
        },
        max_messages: {
          type: "number",
          description: "Maximum number of messages to collect (1–500, default: 10). For: consume.",
        },
        consume_timeout: {
          type: "number",
          description: "Seconds to wait for incoming messages (default: 5). For: consume.",
        },
        no_ack: {
          type: "boolean",
          description: "Disable manual acknowledgement (auto-ack mode). Default: false. For: consume.",
        },
        prefetch_count: {
          type: "number",
          description: "QoS prefetch count (number of unacked messages to deliver at once). Default: 1. For: consume.",
        },
        ack_mode: {
          type: "string",
          enum: ["auto", "manual"],
          description: "Acknowledgement mode for get/consume: 'auto' (default) or 'manual'.",
        },
        delivery_tag: {
          type: "number",
          description: "Delivery tag of the message to ack/nack. Required for: ack, nack.",
        },
        multiple: {
          type: "boolean",
          description: "Ack/nack all messages up to and including delivery_tag (default: false). For: ack, nack.",
        },
        requeue: {
          type: "boolean",
          description: "Requeue the rejected message (default: true). For: nack.",
        },
      },
    },
  },
];

module.exports = { UTIL_SCHEMAS_27 };
