"use strict";
/**
 * utilSchemas81.js — JSON Schema for ntp_client tool.
 */

const ntpClientSchema = {
  name: "ntp_client",
  description:
    "Zero-dependency NTP/SNTP client (pure Node.js dgram; no npm deps). " +
    "Queries NTP servers using SNTPv4/NTPv4 (RFC 4330 / RFC 5905) and computes " +
    "clock offset, round-trip delay, stratum, and leap-indicator fields. " +
    "Operations: query (get server time + offset/delay), " +
    "sync_check (verify local clock is within acceptable skew), " +
    "servers (list well-known public NTP servers), " +
    "stratum (get NTP stratum and reference-source detail). " +
    "Security: NUL-byte guard on host; timeout clamped 500 ms–30 s.",
  inputSchema: {
    type: "object",
    required: ["operation"],
    additionalProperties: false,
    properties: {
      operation: {
        type: "string",
        enum: ["query", "sync_check", "servers", "stratum"],
        description:
          "Operation to perform. " +
          "'query': query an NTP server and return the current time, clock offset, and round-trip delay. " +
          "'sync_check': verify the local clock is within max_skew_ms of the NTP server. " +
          "'servers': return a curated list of well-known public NTP servers. " +
          "'stratum': query an NTP server and return stratum, reference ID, and timing detail.",
      },
      host: {
        type: "string",
        description:
          "NTP server hostname or IP address (default: 'pool.ntp.org'). " +
          "Examples: 'time.cloudflare.com', 'time.google.com', '0.pool.ntp.org'.",
      },
      port: {
        type: "integer",
        minimum: 1,
        maximum: 65535,
        description: "UDP port to query (default: 123, the standard NTP port).",
      },
      timeout: {
        type: "integer",
        minimum: 500,
        maximum: 30000,
        description: "Query timeout in milliseconds (default: 5000, min: 500, max: 30000).",
      },
      max_skew_ms: {
        type: "number",
        description:
          "Maximum acceptable clock skew in milliseconds for 'sync_check' (default: 1000). " +
          "Returns inSync:false if |offsetMs| exceeds this threshold.",
      },
    },
  },
};

module.exports = { ntpClientSchema };
