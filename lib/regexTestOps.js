"use strict";
// ── REGEX TEST OPERATIONS ───────────────────────────────────────────────────
// regex_test — compile a regex pattern and run it against one or more test
// strings, returning structured match details (index, captured groups,
// named groups). Useful for an agent to sanity-check a pattern before
// handing it to replace_in_file/search_files/search_lines (all of which
// accept is_regex + a raw pattern string) rather than discovering a bad
// regex only after it silently matches nothing (or too much) in a real edit.
//
// SECURITY — ReDoS: the pattern string is entirely caller-controlled, and a
// pathological pattern (e.g. nested quantifiers like `(a+)+b`) against a
// crafted input can cause catastrophic backtracking that blocks the Node
// event loop for a very long time — synchronously, so no per-request
// timeout/abort at the HTTP layer can interrupt it once RegExp#exec has
// started. `vm.runInNewContext(..., { timeout })` is used specifically
// because it enforces a wall-clock execution budget on *synchronous* code
// (V8's script interrupt mechanism), which normal try/catch or
// Promise-based timeouts cannot do for a blocking regex engine call. A
// pattern that blows the budget is reported back as `timedOut: true`
// instead of hanging the whole server process.
const vm = require("vm");

const MAX_PATTERN_LENGTH = 1000;
const MAX_STRING_LENGTH = 20_000;
const MAX_TEST_STRINGS = 100;
const MAX_MATCHES_PER_STRING_HARD = 1000;
const DEFAULT_MAX_MATCHES = 100;
const VM_TIMEOUT_MS = 1000;
const ALLOWED_FLAGS = new Set(["g", "i", "m", "s", "u", "y"]);

function validateFlags(flags) {
  const f = flags === undefined || flags === null ? "g" : flags;
  if (typeof f !== "string") throw new Error("regex_test: flags must be a string.");
  if (f.length > 6) throw new Error("regex_test: flags must be at most 6 characters.");
  const seen = new Set();
  for (const ch of f) {
    if (!ALLOWED_FLAGS.has(ch)) throw new Error(`regex_test: unsupported flag '${ch}' (allowed: g,i,m,s,u,y).`);
    if (seen.has(ch)) throw new Error(`regex_test: duplicate flag '${ch}'.`);
    seen.add(ch);
  }
  return f;
}

/**
 * Run one compiled-in-sandbox regex match pass against a single string,
 * bounded by a wall-clock timeout to defend against catastrophic
 * backtracking. Returns { matches, timedOut }.
 */
function execInSandbox(pattern, flags, str, maxMatches) {
  const code = `
    (function () {
      var re = new RegExp(${JSON.stringify(pattern)}, ${JSON.stringify(flags)});
      var str = ${JSON.stringify(str)};
      var out = [];
      if (re.global || re.sticky) {
        var m, guard = 0;
        while ((m = re.exec(str)) !== null && out.length < ${maxMatches}) {
          out.push({ match: m[0], index: m.index, groups: m.slice(1), namedGroups: m.groups || null });
          if (m[0] === "") re.lastIndex += 1; // avoid an infinite loop on zero-width matches
          if (++guard > 10000) break;
        }
      } else {
        var m2 = re.exec(str);
        if (m2) out.push({ match: m2[0], index: m2.index, groups: m2.slice(1), namedGroups: m2.groups || null });
      }
      return out;
    })()
  `;
  try {
    const matches = vm.runInNewContext(code, {}, { timeout: VM_TIMEOUT_MS });
    return { matches, timedOut: false };
  } catch (e) {
    if (/timed out/i.test(e.message || "")) return { matches: [], timedOut: true };
    // Any other in-sandbox error (shouldn't normally happen given the
    // pattern was already syntax-checked outside the sandbox) surfaces
    // as a thrown error rather than being silently swallowed.
    throw new Error(`regex_test: match execution failed: ${e.message}`);
  }
}

/**
 * @param {object} opts
 * @param {string} opts.pattern       Regex source (no delimiters), required.
 * @param {string} [opts.flags]       Regex flags (subset of gimsuy), default 'g'.
 * @param {string[]} opts.testStrings 1-100 strings to test against, each <=20000 chars.
 * @param {number} [opts.maxMatches]  Cap on matches returned per string (1-1000, default 100).
 * @returns {{
 *   pattern: string, flags: string, testCount: number,
 *   results: Array<{ input: string, matched: boolean, matchCount: number, truncated: boolean, timedOut: boolean, matches: Array }>
 * }}
 */
function regexTest(opts = {}) {
  const { pattern } = opts;
  if (typeof pattern !== "string" || pattern.length === 0)
    throw new Error("regex_test: 'pattern' is required and must be a non-empty string.");
  if (pattern.length > MAX_PATTERN_LENGTH)
    throw new Error(`regex_test: 'pattern' exceeds ${MAX_PATTERN_LENGTH} characters.`);

  const flags = validateFlags(opts.flags);

  // Syntax-check the pattern OUTSIDE the sandbox first, so a plain
  // SyntaxError (e.g. unbalanced parens) is reported as a normal
  // validation error rather than surfacing from inside the vm context.
  try {
    // eslint-disable-next-line no-new
    new RegExp(pattern, flags);
  } catch (e) {
    throw new Error(`regex_test: invalid regular expression: ${e.message}`);
  }

  if (!Array.isArray(opts.testStrings) || opts.testStrings.length === 0)
    throw new Error("regex_test: 'testStrings' is required and must be a non-empty array.");
  if (opts.testStrings.length > MAX_TEST_STRINGS)
    throw new Error(`regex_test: 'testStrings' exceeds ${MAX_TEST_STRINGS} entries.`);
  for (const s of opts.testStrings) {
    if (typeof s !== "string")
      throw new Error("regex_test: every entry in 'testStrings' must be a string.");
    if (s.length > MAX_STRING_LENGTH)
      throw new Error(`regex_test: a test string exceeds ${MAX_STRING_LENGTH} characters.`);
  }

  let maxMatches = parseInt(opts.maxMatches, 10);
  if (!Number.isFinite(maxMatches) || maxMatches < 1) maxMatches = DEFAULT_MAX_MATCHES;
  maxMatches = Math.min(Math.max(1, maxMatches), MAX_MATCHES_PER_STRING_HARD);

  const results = opts.testStrings.map((input) => {
    const { matches, timedOut } = execInSandbox(pattern, flags, input, maxMatches);
    return {
      input,
      matched: matches.length > 0,
      matchCount: matches.length,
      truncated: matches.length >= maxMatches,
      timedOut,
      matches,
    };
  });

  return { pattern, flags, testCount: results.length, results };
}

module.exports = { regexTest };
