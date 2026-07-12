"use strict";
// ── UTILITY TOOL SCHEMAS — part 23 ───────────────────────────────────────────────────
// Added: smtp_client (v4.162.0).

const UTIL_SCHEMAS_23 = [
  {
    name: "smtp_client",
    description:
      "Direct SMTP protocol client — zero npm dependencies, pure Node.js net/tls. " +
      "Goes beyond email_send (which is a black-box mailer): this tool speaks the raw " +
      "SMTP dialogue so you can debug mail servers, test relay configurations, verify " +
      "addresses, inspect server capabilities (EHLO extensions), and deliver mail with " +
      "full visibility into every command and response.\n\n" +
      "Operations:\n" +
      "  • probe   — Connect, grab banner, EHLO, return capabilities. No mail sent.\n" +
      "  • send    — Full SMTP delivery: EHLO → (STARTTLS) → (AUTH) → MAIL FROM → RCPT TO → DATA → QUIT.\n" +
      "  • verify  — VRFY or EXPN a mailbox (server permitting).\n" +
      "  • noop    — EHLO + NOOP: connectivity and latency check.\n\n" +
      "TLS modes:\n" +
      "  • secure:true         — native TLS from the start (SMTPS, port 465).\n" +
      "  • starttls:true       — plaintext → STARTTLS upgrade (default when secure=false).\n" +
      "  • starttls:false      — no TLS at all (port 25 relay testing, internal networks).\n\n" +
      "Auth: PLAIN (\\0user\\0pass, base64) or LOGIN (two-round challenge/response). " +
      "Credentials are never echoed in the result; AUTH lines are redacted in the transcript.\n\n" +
      "For 'send': builds a proper RFC 5321/2822 message with Date/From/To/Cc/Subject, " +
      "MIME-Version, quoted-printable content encoding, and dot-stuffing. " +
      "Supports text-only, HTML-only, or multipart/alternative (text+HTML) bodies.\n\n" +
      "Returns { host, port, secure, operation, connected, starttlsUpgraded, authenticated, " +
      "banner, capabilities, success, elapsedMs, transcript, error? } plus operation-specific " +
      "fields: rcptResults/rcptAccepted/rcptRejected/messageId (send), " +
      "vrfyCode/vrfyLines/target (verify), noopResponse (noop). " +
      "Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: {
      type: "object",
      required: ["host"],
      properties: {
        operation: {
          type: "string",
          enum: ["probe", "send", "verify", "noop"],
          description:
            "What to do: 'probe' (banner+EHLO only), 'send' (deliver an email), " +
            "'verify' (VRFY/EXPN a mailbox), 'noop' (connectivity check). Default: 'probe'.",
        },
        host: {
          type: "string",
          description: "SMTP server hostname or IP (e.g. 'smtp.gmail.com', '127.0.0.1').",
        },
        port: {
          type: "number",
          description:
            "SMTP port. Default: 465 when secure=true (SMTPS), 25 otherwise. " +
            "Common ports: 25 (server-to-server), 465 (SMTPS), 587 (submission+STARTTLS).",
        },
        secure: {
          type: "boolean",
          description:
            "Use native TLS from the start (SMTPS / port 465 style). " +
            "Default: false. When false, STARTTLS upgrade is attempted if the server advertises it.",
        },
        starttls: {
          type: "boolean",
          description:
            "Attempt STARTTLS upgrade after EHLO if the server advertises it (default: true). " +
            "Set false to force plaintext (e.g. internal relay testing). Ignored when secure=true.",
        },
        reject_unauthorized: {
          type: "boolean",
          description:
            "Reject TLS certificates that are self-signed or from an unknown CA (default: false). " +
            "Set true for strict certificate validation in production.",
        },
        helo_name: {
          type: "string",
          description:
            "Hostname to advertise in EHLO/HELO (default: 'mcp-client'). " +
            "Some servers validate this against PTR records; use your actual FQDN in production.",
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
          description:
            "SMTP authentication credentials. Omit to skip AUTH. " +
            "PLAIN and LOGIN mechanisms supported.",
          required: ["user", "password"],
          properties: {
            method: {
              type: "string",
              enum: ["PLAIN", "LOGIN"],
              description: "Auth mechanism: 'PLAIN' (default) or 'LOGIN'.",
            },
            user: {
              type: "string",
              description: "SMTP username / email address.",
            },
            password: {
              type: "string",
              description: "SMTP password. Never returned in the result.",
            },
          },
        },
        // ── send-specific ───────────────────────────────────────────────────────────────
        from: {
          type: "string",
          description:
            "Envelope sender address (used in MAIL FROM). Required for 'send'. " +
            "Example: 'alice@example.com'.",
        },
        to: {
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" }, maxItems: 50 },
          ],
          description:
            "Recipient address(es) for RCPT TO and the To: header. Required for 'send'. " +
            "String or array of strings (max 50 combined with cc/bcc).",
        },
        cc: {
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
          description: "Cc: address(es). Optional. Also sent as RCPT TO on the wire.",
        },
        bcc: {
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
          description:
            "Bcc: address(es). Optional. Sent as RCPT TO on the wire but NOT included in headers.",
        },
        subject: {
          type: "string",
          description: "Email subject line. Must not contain CR or LF. Optional.",
        },
        body_text: {
          type: "string",
          description:
            "Plain-text body. At least one of 'body_text' or 'body_html' is required for 'send'. " +
            "When both are provided, a multipart/alternative MIME structure is built.",
        },
        body_html: {
          type: "string",
          description:
            "HTML body. At least one of 'body_text' or 'body_html' is required for 'send'. " +
            "When both are provided, a multipart/alternative MIME structure is built.",
        },
        extra_headers: {
          type: "object",
          description:
            "Additional RFC 5322 headers to include in the message (e.g. { 'Reply-To': 'bob@example.com' }). " +
            "Keys and values must not contain CR, LF, or ':' in keys.",
          additionalProperties: { type: "string" },
        },
        // ── verify-specific ────────────────────────────────────────────────────────────────
        target: {
          type: "string",
          description:
            "Mailbox address or username to verify (for 'verify' operation). " +
            "Many public servers disable VRFY for anti-spam reasons; private/internal servers usually allow it.",
        },
        vrfy_mode: {
          type: "string",
          enum: ["vrfy", "expn"],
          description:
            "SMTP command to use for verification: 'vrfy' (VRFY, verifies a single address, default) " +
            "or 'expn' (EXPN, expands a mailing list alias).",
        },
      },
    },
  },
];

module.exports = { UTIL_SCHEMAS_23 };
