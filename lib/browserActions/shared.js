"use strict";
// Shared helpers for the split browserActions/* modules.
const { ToolError } = require("../errors");
const { resolveClientPath, clientRelative } = require("../roots");
const { getSession } = require("../browserLaunch");
const { BROWSER_TIMEOUT, BROWSER_TIMEOUT_MAX } = require("../config");

const DEFAULT_TIMEOUT = BROWSER_TIMEOUT;
const MAX_TIMEOUT     = BROWSER_TIMEOUT_MAX;
const MAX_CONTENT_CHARS = 200000; // guard against dumping megabytes of HTML into a tool result

function requireSessionId(args, tool) {
  if (!args || !args.session_id)
    throw new ToolError(`${tool} requires a 'session_id' field.`, -32602);
}

module.exports = {
  ToolError, resolveClientPath, clientRelative, getSession,
  DEFAULT_TIMEOUT, MAX_TIMEOUT, MAX_CONTENT_CHARS, requireSessionId,
};
