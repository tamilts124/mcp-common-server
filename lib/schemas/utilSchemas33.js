"use strict";
// -- UTILITY TOOL SCHEMAS -- part 33 ------------------------------------------
// Added: kafka_client (v4.172.0).

const UTIL_SCHEMAS_33 = [
  {
    name: "kafka_client",
    description:
      "Zero-dependency Apache Kafka client — pure Node.js net, no npm deps.\n\n" +
      "Implements the Kafka binary wire protocol (KIP-compatible, API versions for Kafka 0.10+).\n\n" +
      "Operations:\n" +
      "  produce       -- Publish messages to a topic/partition\n" +
      "  fetch         -- Consume messages from a topic/partition at a given offset\n" +
      "  list_offsets  -- Get the earliest/latest offset (or a specific timestamp) for a partition\n" +
      "  metadata      -- Describe brokers, topics, and partition assignments\n" +
      "  list_topics   -- Alias for metadata (returns all topics when no filter given)\n" +
      "  create_topics -- Create one or more new topics\n" +
      "  delete_topics -- Delete one or more topics\n\n" +
      "Authentication:\n" +
      "  SASL PLAIN (sasl_mechanism: 'PLAIN', sasl_username, sasl_password).\n" +
      "  Unauthenticated brokers: omit sasl_* fields.\n\n" +
      "Message format:\n" +
      "  Messages are raw UTF-8 strings. Each message may have an optional key.\n" +
      "  Compression: none (raw bytes/UTF-8). Max 10 MB per message value.\n\n" +
      "Security guards:\n" +
      "  NUL/CRLF guards on topic names, client_id, and host.\n" +
      "  Topic name length ≤ 249 chars; only letters, digits, '.', '_', '-' allowed.\n" +
      "  Max 1000 messages per produce call; 10 MB message value cap; 50 MB fetch cap.\n" +
      "  SASL credentials never returned in results.\n\n" +
      "Returns { host, port, operation, elapsedMs, ...op-specific fields }.\n" +
      "Requires MCP_ALLOW_EXEC (uses net.createConnection).",
    inputSchema: {
      type: "object",
      required: ["operation"],
      properties: {
        host: {
          type: "string",
          description: "Kafka broker hostname or IP address (default: 'localhost').",
        },
        port: {
          type: "number",
          description: "Kafka broker port (default: 9092).",
        },
        operation: {
          type: "string",
          enum: ["produce", "fetch", "list_offsets", "metadata", "list_topics", "create_topics", "delete_topics"],
          description:
            "Kafka operation: produce (publish messages), fetch (consume messages), " +
            "list_offsets (get partition offsets), metadata (broker/topic/partition info), " +
            "list_topics (alias for metadata — all topics), create_topics, delete_topics.",
        },
        timeout: {
          type: "number",
          description: "Total wall-clock timeout in seconds for the entire operation (default: 30).",
        },
        connect_timeout: {
          type: "number",
          description: "TCP connect timeout in seconds (default: min(timeout, 10)).",
        },
        client_id: {
          type: "string",
          description: "Kafka client.id sent in every request header (default: 'kafka_client').",
        },
        sasl_mechanism: {
          type: "string",
          enum: ["PLAIN"],
          description: "SASL authentication mechanism. Currently only 'PLAIN' is supported. Omit for unauthenticated brokers.",
        },
        sasl_username: {
          type: "string",
          description: "SASL PLAIN username. Required when sasl_mechanism is set.",
        },
        sasl_password: {
          type: "string",
          description: "SASL PLAIN password. Required when sasl_mechanism is set. Never returned in results.",
        },
        // ── produce ─────────────────────────────────────────────────────────
        topic: {
          type: "string",
          description:
            "Topic name (required for produce, fetch, list_offsets). " +
            "For metadata, use 'topics' (array) to filter; omit for all topics.",
        },
        partition: {
          type: "number",
          description: "Partition index (default: 0). Used by produce, fetch, and list_offsets.",
        },
        messages: {
          type: "array",
          description: "produce: Array of message objects to publish. Max 1000 per call.",
          items: {
            type: "object",
            properties: {
              value:     { description: "Message value (string; converted to UTF-8 bytes). At least one of 'value' or 'key' must be set." },
              key:       { type: "string", description: "Optional message key (string; converted to UTF-8)." },
              timestamp: { type: "number", description: "Optional Unix timestamp in milliseconds (default: Date.now())." },
            },
          },
        },
        acks: {
          type: "number",
          description: "produce: Required acknowledgements: -1 = all ISRs (default), 0 = none, 1 = leader only.",
        },
        // ── fetch ───────────────────────────────────────────────────────────
        fetch_offset: {
          type: "number",
          description: "fetch: Starting offset to consume from (default: 0). Use list_offsets to find EARLIEST/LATEST.",
        },
        max_bytes: {
          type: "number",
          description: "fetch: Maximum bytes to fetch in the response (default: 1 MB, max: 50 MB).",
        },
        max_wait_ms: {
          type: "number",
          description: "fetch: Max milliseconds the broker waits before returning even if min_bytes not met (default: 500).",
        },
        min_bytes: {
          type: "number",
          description: "fetch: Minimum bytes the broker should accumulate before returning (default: 1).",
        },
        // ── list_offsets ────────────────────────────────────────────────────
        timestamp: {
          type: "number",
          description:
            "list_offsets: Timestamp in ms to look up offset for, or:\n" +
            "  -1 = LATEST (default) — offset of the next message to be produced\n" +
            "  -2 = EARLIEST — smallest available offset",
        },
        // ── metadata / list_topics ─────────────────────────────────────────
        topics: {
          type: "array",
          items: { type: "string" },
          description:
            "metadata/list_topics: Filter by these topic names. Omit (or pass empty array) for all topics.\n" +
            "create_topics: Array of topic-spec objects {name, num_partitions?, replication_factor?, configs?}.\n" +
            "delete_topics: Array of topic name strings to delete.",
        },
        // ── create_topics ───────────────────────────────────────────────────
        // (topics array items for create use num_partitions / replication_factor / configs sub-fields)
      },
    },
  },
];

module.exports = { UTIL_SCHEMAS_33 };
