"use strict";

const pop3ClientSchema = {
  name: "pop3_client",
  description: "Zero-dependency POP3 (Post Office Protocol v3) email client (pure Node.js net/tls built-ins; no npm deps). Implements RFC 1939 (POP3 base protocol), RFC 2449 (CAPA capability extension), RFC 2595 (STLS/TLS upgrade), and RFC 5034 (SASL AUTH). Completes the email trifecta alongside smtp_client and imap_client. POP3 is the classic protocol for downloading email from a mailbox — it downloads messages and optionally deletes them from the server, making it ideal for offline access and email archiving workflows. Operations: stat (STAT — mailbox message count and total byte size), list (LIST — enumerate all messages with per-message byte sizes), uidl (UIDL — unique message identifiers persistent across sessions for deduplication), retrieve (RETR — download one or more full messages with optional RFC 2822 header parsing), top (TOP N — retrieve headers + first N body lines without downloading full message), delete (DELE — mark messages for deletion, committed on QUIT), reset (RSET — unmark all pending deletions), capa (CAPA RFC 2449 — list server capability extensions without authentication), info (return protocol/config table, no I/O). Transport: plain TCP (port 110) or direct TLS (port 995, use_tls:true) or STARTTLS upgrade (use_stls:true). Authentication: USER/PASS (standard) or APOP MD5 challenge-response. Use for testing Dovecot, Cyrus, Exchange, Gmail, Outlook, Yahoo, and any RFC 1939-compliant POP3 server.",
  inputSchema: {
    type: "object",
    required: ["operation"],
    properties: {
      operation: {
        type: "string",
        enum: ["stat", "list", "uidl", "retrieve", "top", "delete", "reset", "capa", "info"],
        description: "Operation to perform. stat=STAT (message count + total size). list=LIST (per-message sizes). uidl=UIDL (unique IDs). retrieve=RETR (download full messages). top=TOP (headers + N body lines). delete=DELE (mark for deletion). reset=RSET (unmark all deletions). capa=CAPA (server capabilities, no auth needed). info=protocol table (no I/O).",
      },
      host: {
        type: "string",
        description: "POP3 server hostname or IP address. Required for all operations except info. E.g. 'pop.gmail.com', 'mail.example.com', '127.0.0.1'.",
      },
      port: {
        type: "number",
        description: "TCP port (default: 110 for plain, 995 for TLS). Range: 1-65535.",
      },
      username: {
        type: "string",
        description: "POP3 username (mailbox name). Required for stat, list, uidl, retrieve, top, delete, reset. E.g. 'alice', 'alice@example.com'.",
      },
      password: {
        type: "string",
        description: "POP3 password. Required for stat, list, uidl, retrieve, top, delete, reset. Never logged or returned in results.",
      },
      use_tls: {
        type: "boolean",
        description: "Connect with direct TLS (implicit TLS, POP3S) on port 995. Default: false.",
      },
      use_stls: {
        type: "boolean",
        description: "Upgrade plain TCP connection to TLS via STLS command (RFC 2595) before authenticating. Default: false. Requires server STLS capability.",
      },
      reject_unauthorized: {
        type: "boolean",
        description: "Reject TLS connections with invalid/self-signed certificates. Default: true. Set to false for self-signed test servers.",
      },
      auth_method: {
        type: "string",
        enum: ["userpass", "apop"],
        description: "Authentication method. userpass (default) = USER + PASS commands. apop = APOP MD5 challenge-response (RFC 1939 §7, requires server to include timestamp in greeting).",
      },
      timeout: {
        type: "number",
        description: "Connection + per-command timeout in milliseconds (default: 15000, range: 1000-120000).",
      },
      msg_num: {
        type: "number",
        description: "Message number for list, uidl, retrieve, top, delete (single-message operations). POP3 message numbers start at 1 and are session-local (may differ between sessions — use UIDL for persistence). Range: 1-999999.",
      },
      msg_nums: {
        type: "array",
        items: { type: "number" },
        description: "Array of message numbers for retrieve or delete (multi-message operations). E.g. [1, 2, 3]. Capped at max_messages (default 10).",
      },
      lines: {
        type: "number",
        description: "Number of body lines to retrieve for the top operation (default: 10, range: 0-1000). 0 returns headers only.",
      },
      include_raw: {
        type: "boolean",
        description: "Include the raw message text in retrieve results. Default: true. Set to false to only return parsed headers and body preview.",
      },
      parse_headers: {
        type: "boolean",
        description: "Parse RFC 2822 message headers in retrieve results into a structured object. Default: true.",
      },
      max_messages: {
        type: "number",
        description: "Maximum number of messages to retrieve in a single retrieve or delete call (default: 10, range: 1-100).",
      },
    },
  },
};

module.exports = { pop3ClientSchema };
