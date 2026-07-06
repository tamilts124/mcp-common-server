"use strict";
// ── SQLITE TOOL DISPATCH HANDLERS ───────────────────────────────────────────
// Mirrors dispatchBrowser.js/dispatchEmail.js pattern.

const {
  createDatabase, connect, execute, disconnect, listConnections, listTables,
} = require("./sqliteOps");

const SQLITE_DISPATCH = {
  sqlite_create: createDatabase,
  sqlite_connect: connect,
  sqlite_execute: execute,
  sqlite_disconnect: disconnect,
  sqlite_connections: listConnections,
  sqlite_tables: listTables,
};

module.exports = { SQLITE_DISPATCH };
