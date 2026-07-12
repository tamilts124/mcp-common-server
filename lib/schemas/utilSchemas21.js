"use strict";
// ── UTILITY TOOL SCHEMAS — part 21 ────────────────────────────────────────────
// Added: udp_client (v4.159.0).

const UTIL_SCHEMAS_21 = [
  {
    name: "udp_client",
    description:
      "Send UDP datagrams to any host:port, optionally receive replies, and return structured results. " +
      "Zero npm dependencies — pure Node.js dgram module. " +
      "\n\nIdeal for:\n" +
      "  \u2022 DNS queries (port 53 \u2014 send a raw DNS wire-format question)\n" +
      "  \u2022 NTP queries (port 123 \u2014 send an NTP request, read the timestamp)\n" +
      "  \u2022 Syslog probes (port 514 \u2014 inject RFC 5424 messages)\n" +
      "  \u2022 SNMP GET (port 161 \u2014 send SNMP v1/v2c PDUs)\n" +
      "  \u2022 TFTP handshake (port 69)\n" +
      "  \u2022 Statsd metric injection (port 8125)\n" +
      "  \u2022 Game server / IoT UDP protocol testing\n" +
      "  \u2022 Network reachability probes\n\n" +
      "Each entry in 'messages' specifies a datagram payload ('data' string, UTF-8 by default " +
      "or base64/hex for binary), an optional 'delay_ms' before sending, and an optional " +
      "'wait_replies' count (wait for this many datagrams from the server before sending the next " +
      "message — useful for request-response UDP protocols). " +
      "\n\nReceived datagrams are returned as an array with per-datagram source address, source port, " +
      "elapsed time, byte count, and data. A total byte budget ('max_recv_bytes', default 256 KB) " +
      "and datagram count cap ('max_datagrams', default 100) prevent runaway reads. " +
      "\n\nReturns { host, resolvedIp, port, family, localPort, messagesSent, datagramsReceived, " +
      "totalReceivedBytes, truncated, datagrams: [{index,remoteAddr,remotePort,elapsedMs,sizeBytes,data,encoding}], " +
      "elapsedMs, error? }. " +
      "Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: {
      type: "object",
      required: ["host", "port"],
      properties: {
        host: {
          type: "string",
          description: "Target hostname or IP address (e.g. '8.8.8.8', 'localhost', 'ntp.example.com').",
        },
        port: {
          type: "number",
          description: "Target UDP port (1–65535). E.g. 53 (DNS), 123 (NTP), 514 (syslog), 161 (SNMP).",
        },
        family: {
          type: "string",
          enum: ["ipv4", "ipv6"],
          description: "IP address family for the socket (default: 'ipv4'). Use 'ipv6' for IPv6-only targets.",
        },
        messages: {
          type: "array",
          description: "Ordered list of datagrams to send after binding the socket (max 20). " +
            "If omitted or empty, the tool binds and listens for incoming datagrams only " +
            "(useful for receiving UDP broadcasts or multicast streams).",
          items: {
            type: "object",
            required: ["data"],
            properties: {
              data: {
                type: "string",
                description: "Payload to send. Interpreted as UTF-8 text by default; " +
                  "set 'encoding' to 'base64' or 'hex' for binary payloads.",
              },
              encoding: {
                type: "string",
                enum: ["utf8", "base64", "hex"],
                description: "Encoding of the 'data' field (default: 'utf8').",
              },
              delay_ms: {
                type: "number",
                description: "Milliseconds to wait before sending this datagram (0–30000, default 0).",
              },
              wait_replies: {
                type: "number",
                description: "Number of reply datagrams to wait for before sending the next message " +
                  "(default 0 = don't wait). Useful for request-response protocols like DNS.",
              },
            },
          },
        },
        recv_timeout: {
          type: "number",
          description: "Idle-receive timeout in seconds: if no new datagram arrives within this window " +
            "after sending all messages, the session ends (default 3, max 30). " +
            "This is normal end-of-response behavior — not an error.",
        },
        timeout: {
          type: "number",
          description: "Total wall-clock timeout for the entire session in seconds (default 15, max 120).",
        },
        max_recv_bytes: {
          type: "number",
          description: "Maximum total bytes to accept across all received datagrams " +
            "(default 262144 = 256 KB, max 4 MB). When exceeded, 'truncated' is set and the session ends.",
        },
        max_datagrams: {
          type: "number",
          description: "Maximum number of datagrams to record (default 100, max 1000). " +
            "Extra datagrams are dropped and 'truncated' is set.",
        },
        recv_encoding: {
          type: "string",
          enum: ["utf8", "base64", "hex"],
          description: "How to encode received datagram bytes in 'datagrams[].data' (default: 'utf8'). " +
            "Use 'base64' or 'hex' when the server sends binary data (e.g. DNS wire format).",
        },
        bind_port: {
          type: "number",
          description: "Local UDP port to bind to (0–65535; default 0 = OS-assigned ephemeral port). " +
            "Useful when the remote server requires replies to arrive at a specific source port.",
        },
      },
    },
  },
];

module.exports = { UTIL_SCHEMAS_21 };
