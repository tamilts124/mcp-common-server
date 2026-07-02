"use strict";
// ── EMAIL TOOL DISPATCH HANDLERS ────────────────────────────────────────────
// Mirrors dispatchBrowser.js pattern. Both handlers are async (return
// Promises); executeTool()/executePipeline() already await results.

const { imapListMailboxes, imapSearchEmails } = require("./emailOps");

const EMAIL_DISPATCH = {
  email_list_mailboxes: imapListMailboxes,
  email_search:         imapSearchEmails,
};

module.exports = { EMAIL_DISPATCH };
