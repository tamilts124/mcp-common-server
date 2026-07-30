"use strict";
// ── READ DISPATCH — thin merger ─────────────────────────────────────────────────
// This file used to contain all read/utility/client tool handlers (~1 800 lines).
// It has been split into two focused modules:
//   • dispatchReadCore.js    – file I/O, search, crypto, hashing, diff, HTTP …
//   • dispatchReadClients.js – protocol/format/cloud client handlers
//
// External callers (`executeTool.js`, tests) continue to `require("./dispatchRead")`
// and destructure `{ READ_DISPATCH }` — nothing changes on the outside.

const { CORE_DISPATCH }    = require("./dispatchReadCore");
const { CLIENTS_DISPATCH } = require("./dispatchReadClients");

const READ_DISPATCH = Object.assign(Object.create(null), CORE_DISPATCH, CLIENTS_DISPATCH);

module.exports = { READ_DISPATCH };
