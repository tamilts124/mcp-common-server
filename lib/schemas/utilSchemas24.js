"use strict";
// ── UTILITY TOOL SCHEMAS — part 24 ──────────────────────────────────────────────────
// Added: imap_client (v4.163.0).

const UTIL_SCHEMAS_24 = [
  {
    name: "imap_client",
    description:
      "Direct IMAP4rev1 protocol client — zero npm dependencies, pure Node.js net/tls. " +
      "Goes beyond email_search (which is a higher-level IMAP wrapper): this tool speaks raw " +
      "IMAP4rev1 so you can list mailboxes, select folders, search with any RFC 3501 criteria, " +
      "fetch headers/body/flags, append new messages, store flags, copy messages, and expunge.\n\n" +
      "Operations:\n" +
      "  • list     — LIST mailboxes matching a reference/pattern (e.g. \"*\" for all, \"INBOX*\").\n" +
      "  • select   — SELECT (read-write) or EXAMINE (read-only) a mailbox; returns exists/recent/unseen counts.\n" +
      "  • status   — STATUS a mailbox without selecting it (messages/unseen/recent/uidnext counts).\n" +
      "  • search   — SEARCH with any RFC 3501 criteria (ALL, UNSEEN, FROM x, SINCE date, SUBJECT x, etc.).\n" +
      "  • fetch    — FETCH headers/body/flags for a sequence set (e.g. \"1:10\", \"1,3,5\", \"*\").\n" +
      "  • append   — APPEND a raw RFC 2822 message string into a mailbox.\n" +
      "  • store    — STORE flags on messages (+FLAGS, -FLAGS, FLAGS).\n" +
      "  • copy     — COPY messages to another mailbox.\n" +
      "  • expunge  — EXPUNGE permanently deletes \\Deleted messages from the selected mailbox.\n\n" +
      "TLS modes:\n" +
      "  • secure:true          — implicit TLS from the start (IMAPS, port 993).\n" +
      "  • starttls:true        — plaintext → STARTTLS upgrade (default when secure=false).\n" +
      "  • starttls:false       — no TLS at all (local server testing).\n\n" +
      "Auth: LOGIN (most widely supported) or AUTHENTICATE PLAIN.\n" +
      "Credentials are never echoed in the result.\n\n" +
      "Returns { host, port, secure, operation, connected, authenticated, starttlsUpgraded, " +
      "capabilities, greeting, success, elapsedMs, transcript?, error? } plus operation-specific " +
      "fields: mailboxes/count (list), mailbox (select), status (status), " +
      "ids/count/truncated/criteria (search), messages/count/truncated (fetch), " +
      "appended/size (append), responses (store), copied (copy), expunged/count (expunge).\n\n" +
      "Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: {
      type: "object",
      required: ["host"],
      properties: {
        operation: {
          type: "string",
          enum: ["list", "select", "search", "fetch", "status", "append", "store", "copy", "expunge"],
          description:
            "IMAP operation to perform. Default: 'list'.\n" +
            "  list: LIST mailboxes. select: SELECT/EXAMINE a folder. status: STATUS counts. " +
            "  search: SEARCH messages. fetch: FETCH message data. append: APPEND a message. " +
            "  store: STORE flags. copy: COPY to another folder. expunge: EXPUNGE deleted messages.",
        },
        host: {
          type: "string",
          description: "IMAP server hostname or IP address (e.g. 'imap.gmail.com', '127.0.0.1').",
        },
        port: {
          type: "number",
          description: "IMAP port. Default: 993 when secure=true (IMAPS), 143 otherwise.",
        },
        secure: {
          type: "boolean",
          description:
            "Use implicit TLS from the start (IMAPS / port 993 style). " +
            "Default: false. When false, STARTTLS upgrade is attempted if server advertises it.",
        },
        starttls: {
          type: "boolean",
          description:
            "Attempt STARTTLS upgrade after CAPABILITY if the server advertises it (default: true). " +
            "Set false to disable (e.g. local plaintext IMAP server testing). Ignored when secure=true.",
        },
        reject_unauthorized: {
          type: "boolean",
          description:
            "Reject TLS certificates that are self-signed or from an unknown CA (default: false). " +
            "Set true for strict validation in production.",
        },
        timeout: {
          type: "number",
          description: "Total session wall-clock timeout in seconds (default: 30, max: 120).",
        },
        connect_timeout: {
          type: "number",
          description: "TCP connection timeout in seconds (default: 10, max: 30).",
        },
        auth: {
          type: "object",
          description: "IMAP authentication credentials. Omit to connect anonymously (if server allows).",
          required: ["user", "password"],
          properties: {
            method: {
              type: "string",
              enum: ["LOGIN", "PLAIN"],
              description: "Auth mechanism: 'LOGIN' (default, most compatible) or 'PLAIN' (AUTHENTICATE PLAIN base64).",
            },
            user: {
              type: "string",
              description: "IMAP username / email address.",
            },
            password: {
              type: "string",
              description: "IMAP password. Never returned in results.",
            },
          },
        },
        // ── list-specific ─────────────────────────────────────────────────────────────────
        reference: {
          type: "string",
          description: "LIST reference name (default: '' = root). Used to namespace the search.",
        },
        pattern: {
          type: "string",
          description:
            "LIST mailbox pattern (default: '*' = all). Supports '*' (any sequence) and '%' (one level). " +
            "Examples: '*' = all, 'INBOX' = exact match, 'INBOX*' = INBOX and sub-folders, '%' = top-level only.",
        },
        // ── select/search/fetch/store/copy/expunge-specific ────────────────────────────
        mailbox: {
          type: "string",
          description:
            "Mailbox name to operate on. Required for: select, status, search, fetch, append, store, copy (source), expunge. " +
            "Use 'INBOX' for the main inbox. Case-sensitive on some servers.",
        },
        readonly: {
          type: "boolean",
          description: "For 'select': use EXAMINE (read-only) instead of SELECT (read-write). Default: false.",
        },
        // ── status-specific ──────────────────────────────────────────────────────────────
        status_items: {
          type: "array",
          items: { type: "string" },
          description:
            "STATUS data items to request (default: [MESSAGES, UNSEEN, RECENT, UIDNEXT, UIDVALIDITY]). " +
            "Valid values: MESSAGES, UNSEEN, RECENT, UIDNEXT, UIDVALIDITY.",
        },
        // ── search-specific ──────────────────────────────────────────────────────────────
        criteria: {
          type: "string",
          description:
            "RFC 3501 SEARCH criteria string (required for 'search'). " +
            "Examples: 'ALL', 'UNSEEN', 'FROM \"alice@example.com\"', " +
            "'SUBJECT \"Invoice\"', 'SINCE 01-Jan-2024', 'UNSEEN FROM \"boss@corp.com\"'. " +
            "Multiple criteria are ANDed together.",
        },
        max_results: {
          type: "number",
          description: "Maximum number of search result IDs to return (1–5000, default: 500).",
        },
        use_uid: {
          type: "boolean",
          description:
            "Use UID-based commands (UID SEARCH, UID FETCH, UID STORE, UID COPY) instead of sequence numbers. " +
            "UIDs persist across sessions; sequence numbers may change. Default: false.",
        },
        // ── fetch-specific ──────────────────────────────────────────────────────────────
        sequence_set: {
          type: "string",
          description:
            "Message sequence set (required for fetch/store/copy). " +
            "Examples: '1' (single), '1:5' (range), '1,3,5' (list), '1:*' (all), '*' (last message). " +
            "Only digits, ':', ',', and '*' are allowed.",
        },
        fetch_items: {
          type: "string",
          description:
            "IMAP FETCH data items (default: '(FLAGS RFC822.HEADER)'). " +
            "Common macros: 'ALL' (FLAGS INTERNALDATE RFC822.SIZE ENVELOPE), " +
            "'FULL' (ALL + BODY), 'FAST' (FLAGS INTERNALDATE RFC822.SIZE). " +
            "Individual items: FLAGS, UID, RFC822.HEADER, RFC822.TEXT, RFC822, " +
            "RFC822.SIZE, INTERNALDATE, ENVELOPE, BODY[], BODY.PEEK[HEADER].",
        },
        // ── append-specific ──────────────────────────────────────────────────────────────
        message: {
          type: "string",
          description:
            "Raw RFC 2822 message string to append (required for 'append'). " +
            "Must include headers followed by a blank line and body. Max 10 MB.",
        },
        flags: {
          oneOf: [
            { type: "array", items: { type: "string" } },
            { type: "string" },
          ],
          description:
            "IMAP flags. For 'append': initial flags on the stored message (e.g. ['\\\\Seen']). " +
            "For 'store': the flags to set/add/remove (e.g. ['\\\\Deleted', '\\\\Seen']).",
        },
        internal_date: {
          type: "string",
          description:
            "INTERNALDATE for 'append' — RFC 2822 date string (e.g. '12 Jul 2024 10:00:00 +0000'). " +
            "Omit to let the server assign the current time.",
        },
        // ── store-specific ──────────────────────────────────────────────────────────────
        store_operation: {
          type: "string",
          enum: ["+FLAGS", "-FLAGS", "FLAGS", "+FLAGS.SILENT", "-FLAGS.SILENT", "FLAGS.SILENT"],
          description:
            "STORE operation for the 'store' command (default: '+FLAGS'). " +
            "'+FLAGS' adds flags, '-FLAGS' removes flags, 'FLAGS' replaces the flag set. " +
            "'.SILENT' variants suppress the updated flags echo from the server.",
        },
        // ── copy-specific ──────────────────────────────────────────────────────────────
        dest_mailbox: {
          type: "string",
          description: "Destination mailbox for 'copy' operation. E.g. 'Archive' or 'INBOX.Processed'.",
        },
        // ── shared ──────────────────────────────────────────────────────────────────────
        include_transcript: {
          type: "boolean",
          description:
            "Include the full IMAP session transcript (client commands + server responses) in the result. " +
            "Credentials are redacted in the transcript. Useful for debugging. Default: false.",
        },
      },
    },
  },
];

module.exports = { UTIL_SCHEMAS_24 };
