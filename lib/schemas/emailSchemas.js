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
];

module.exports = { EMAIL_SCHEMAS };
