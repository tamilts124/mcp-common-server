"use strict";
// ── BROWSER TOOL SCHEMAS — only present when MCP_ALLOW_EXEC=true and MCP_READ_ONLY=false ──
// Browser tools spawn a real Chromium process, so they are gated the same
// way as run_command/start_process (see toolsSchema.js EXEC_TOOLS set).
//
// Barrel: concatenates schema groups split out of this file (which had grown past the
// 500-line threshold) from lib/schemas/browserSchemas/{session,interaction,pageState,advanced}.js
// (pure refactor — no schema content change).
const { SESSION_SCHEMAS } = require("./browserSchemas/session");
const { INTERACTION_SCHEMAS } = require("./browserSchemas/interaction");
const { PAGE_STATE_SCHEMAS } = require("./browserSchemas/pageState");
const { ADVANCED_SCHEMAS } = require("./browserSchemas/advanced");

const BROWSER_SCHEMAS = [
  ...SESSION_SCHEMAS,
  ...INTERACTION_SCHEMAS,
  ...PAGE_STATE_SCHEMAS,
  ...ADVANCED_SCHEMAS,
];

module.exports = { BROWSER_SCHEMAS };
