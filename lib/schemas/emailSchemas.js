"use strict";
// ── EMAIL (IMAP) TOOL SCHEMAS — always available (network only, no exec/write) ─

const EMAIL_SCHEMAS = [
  {
    name: "email_list_mailboxes",
    description: "Connect to an IMAP mailbox and list all available folders (e.g. INBOX, Sent, Drafts). username/password may be passed per call, or omitted to fall back to EMAIL_USERNAME/EMAIL_APP_PASSWORD in .env (host/port likewise fall back to EMAIL_HOST/EMAIL_PORT). Credentials are never stored server-side beyond the .env file the operator controls.",
    inputSchema: { type: "object", required: [], properties: {
      username: { type: "string", description: "IMAP account email address / login. Falls back to EMAIL_USERNAME env var if omitted." },
      password: { type: "string", description: "IMAP password or app-specific password. Falls back to EMAIL_APP_PASSWORD env var if omitted." },
      host:     { type: "string", description: "IMAP server hostname. Falls back to EMAIL_HOST env var, then imap.gmail.com." },
      port:     { type: "number", description: "IMAP TLS port. Falls back to EMAIL_PORT env var, then 993." },
    }},
  },
  {
    name: "email_search",
    description: "Connect to an IMAP mailbox, search/filter messages by subject keyword, sender, and/or date, and return the newest matches with decoded subject/sender/body/date. Uses BODY.PEEK so messages are not marked as read. username/password may be passed per call, or omitted to fall back to EMAIL_USERNAME/EMAIL_APP_PASSWORD in .env (host/port likewise fall back to EMAIL_HOST/EMAIL_PORT).",
    inputSchema: { type: "object", required: [], properties: {
      username:        { type: "string", description: "IMAP account email address / login. Falls back to EMAIL_USERNAME env var if omitted." },
      password:        { type: "string", description: "IMAP password or app-specific password. Falls back to EMAIL_APP_PASSWORD env var if omitted." },
      host:            { type: "string", description: "IMAP server hostname. Falls back to EMAIL_HOST env var, then imap.gmail.com." },
      port:            { type: "number", description: "IMAP TLS port. Falls back to EMAIL_PORT env var, then 993." },
      mailbox:         { type: "string", description: "Mailbox/folder to search (default: INBOX)." },
      limit:           { type: "number", description: "Max number of newest matching emails to return (1-50, default: 10)." },
      subject_keyword: { type: "string", description: "Only return emails whose Subject contains this substring (case-insensitive)." },
      sender:          { type: "string", description: "Only return emails whose From header contains this substring." },
      date:            { type: "string", description: "Only return emails received on this date (YYYY-MM-DD)." },
    }},
  },
  {
    name: "email_send",
    description: "Send an email via SMTP (implicit TLS, e.g. port 465). username/password may be passed per call, or omitted to fall back to EMAIL_USERNAME/EMAIL_APP_PASSWORD in .env (host falls back to SMTP_HOST then EMAIL_HOST; port falls back to SMTP_PORT then 465). Sends From the authenticated account. Provide 'body' (plain text), 'body_html', or both (sent as multipart/alternative).",
    inputSchema: { type: "object", required: ["to"], properties: {
      username:  { type: "string", description: "SMTP account email address / login. Falls back to EMAIL_USERNAME env var if omitted." },
      password:  { type: "string", description: "SMTP password or app-specific password. Falls back to EMAIL_APP_PASSWORD env var if omitted." },
      host:      { type: "string", description: "SMTP server hostname. Falls back to SMTP_HOST, then EMAIL_HOST env var, then smtp.gmail.com." },
      port:      { type: "number", description: "SMTP TLS port. Falls back to SMTP_PORT env var, then 465." },
      to:        { description: "Recipient address, or array/comma-separated list of addresses. Required.", oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
      cc:        { description: "CC address(es), same format as 'to'.", oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
      bcc:       { description: "BCC address(es), same format as 'to'.", oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
      subject:   { type: "string", description: "Email subject line." },
      body:      { type: "string", description: "Plain-text body. Required unless body_html is given." },
      body_html: { type: "string", description: "HTML body. Required unless body is given. If both are given, sent as multipart/alternative." },
    }},
  },
];

module.exports = { EMAIL_SCHEMAS };
