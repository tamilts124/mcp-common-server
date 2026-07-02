"use strict";
// ── EMAIL TOOL DISPATCH HANDLERS ────────────────────────────────────────────
// Mirrors dispatchBrowser.js pattern. Both handlers are async (return
// Promises); executeTool()/executePipeline() already await results.

const { imapListMailboxes, imapSearchEmails } = require("./emailOps");
const { smtpSendEmail } = require("./emailSendOps");

const EMAIL_DISPATCH = {
  email_list_mailboxes: imapListMailboxes,
  email_search:         imapSearchEmails,
  email_send:           smtpSendEmail,
};

module.exports = { EMAIL_DISPATCH };
