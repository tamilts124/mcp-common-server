"use strict";
// ── URL_PARSE — parse a URL into structured components ────────────────────
// Pure computation, no fs/exec. Thin wrapper around Node's built-in URL /
// URLSearchParams (WHATWG URL spec) so callers don't have to hand-roll
// regex-based query-string splitting. Password is redacted by default since
// URLs are often pasted from logs/config and may carry live credentials.

const { ToolError } = require("./errors");

const MAX_URL_LENGTH = 4000;

/**
 * Build a plain object from URLSearchParams, grouping repeated keys into
 * arrays (e.g. '?a=1&a=2' -> { a: ["1","2"] }) instead of the last value
 * silently winning.
 */
function searchParamsToObject(sp) {
  const out = {};
  for (const key of sp.keys()) {
    if (Object.prototype.hasOwnProperty.call(out, key)) continue; // handled on first sighting
    const values = sp.getAll(key);
    out[key] = values.length > 1 ? values : values[0];
  }
  return out;
}

/**
 * Parse a URL string into its structured components.
 *
 * @param {string} input           The URL to parse (absolute, or relative if `base` is given).
 * @param {object} [opts]
 * @param {string}  [opts.base]        Base URL to resolve a relative `input` against.
 * @param {boolean} [opts.showPassword] If true, include the raw password component (default false — redacted).
 */
function urlParse(input, opts = {}) {
  if (typeof input !== "string" || input.trim() === "") {
    throw new ToolError("url_parse: 'url' is required and must be a non-empty string.", -32602);
  }
  if (input.length > MAX_URL_LENGTH) {
    throw new ToolError(`url_parse: url exceeds max length of ${MAX_URL_LENGTH} characters.`, -32602);
  }
  if (opts.base !== undefined && (typeof opts.base !== "string" || opts.base.length > MAX_URL_LENGTH)) {
    throw new ToolError(`url_parse: 'base', if given, must be a string up to ${MAX_URL_LENGTH} characters.`, -32602);
  }

  let u;
  try {
    u = opts.base ? new URL(input, opts.base) : new URL(input);
  } catch (e) {
    const hint = opts.base ? "" : " If this is a relative URL, pass a 'base'.";
    throw new ToolError(`url_parse: could not parse url: ${e.message}.${hint}`, -32602);
  }

  const showPassword = opts.showPassword === true;

  return {
    href: u.href,
    origin: u.origin,
    protocol: u.protocol,
    username: u.username || null,
    password: showPassword ? (u.password || null) : (u.password ? "[redacted]" : null),
    hostname: u.hostname || null,
    port: u.port || null,
    pathname: u.pathname,
    search: u.search,
    searchParams: searchParamsToObject(u.searchParams),
    hash: u.hash || null,
    isRelativeResolved: !!opts.base,
  };
}

module.exports = { urlParse };
