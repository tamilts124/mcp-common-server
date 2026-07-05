"use strict";
// ── CHECK_TEST_FLAKINESS_RISK — non-deterministic test-suite hygiene scan ──
// Scans JS/TS test files for three common causes of flaky/non-deterministic
// test runs:
//   (1) bare_settimeout_wait — a `setTimeout(` call whose callback body looks
//       like an assertion (expect(/assert(/.should) with no nearby "Promise"
//       token, i.e. not the sanctioned `await new Promise(r => setTimeout(r,
//       ms))` sleep idiom. A bare setTimeout-based wait races the runner's
//       own timeout/teardown and is a classic flake source.
//   (2) date_now_or_random_in_assertion — Date.now()/Math.random() used
//       directly on the same line as an assertion call, with no fake-timer
//       or mock hint (jest.useFakeTimers/sinon fake clock/mockdate) found
//       anywhere in the file — an assertion against real wall-clock time or
//       real randomness is inherently non-reproducible.
//   (3) shared_mutable_state_across_tests — a module-level `let`/`var`
//       (mutable, non-const) variable that is written inside one `it(`/
//       `test(` callback and also referenced inside a *different* `it(`/
//       `test(` callback — a classic test-order-dependency smell (tests
//       pass in file order, fail under `--shuffle`/parallel runners).
//
// Pure text-scan (brace-depth body extraction + regex), not a real parser:
//   CAVEATS:
//     - rule 1 treats ANY "Promise" token within the 60 chars preceding the
//       setTimeout( call as sanctioning it — a documented heuristic
//       over-suppression, same tradeoff spirit as this tool family's peers.
//     - rule 2's fake-timer/mock detection is file-wide, not scoped to the
//       specific test block — a file that fakes timers in one test but not
//       another will under-report for the un-faked test.
//     - rule 3 does not distinguish a legitimate `beforeEach` reset from a
//       real cross-test leak; a variable reset in `beforeEach` between every
//       test can still trip this heuristic. Documented tradeoff: a real
//       fix would require full control-flow analysis this tool family
//       intentionally does not attempt.
const fs = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

const ASSERTION_RE = /\bexpect\s*\(|\bassert\s*\(|\.should\b/;
const FAKE_TIMER_HINT_RE = /useFakeTimers|mockdate|sinon[\s\S]{0,20}clock|jest\.spyOn\s*\(\s*Date/i;
const SETTIMEOUT_RE = /setTimeout\s*\(/g;
const TEST_BLOCK_RE = /\b(?:it|test)\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1\s*,\s*(?:async\s*)?(?:function\s*\([^)]*\)|\([^)]*\)\s*=>)\s*\{/g;
const MODULE_LEVEL_MUTABLE_RE = /^(?:let|var)\s+(\w+)\s*=/gm;
const WRITE_RE_TMPL = (name) => new RegExp("\\b" + name + "\\s*(?:=(?!=)|\\+\\+|--|\\+=|-=)");
const USAGE_RE_TMPL = (name) => new RegExp("\\b" + name + "\\b");

function collectFiles(absDir, extensions, relBase = "") {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); }
  catch (_) { return out; }
  for (const ent of entries) {
    if (isIgnored(ent.name)) continue;
    const abs = path.join(absDir, ent.name);
    const rel = relBase ? relBase + "/" + ent.name : ent.name;
    if (ent.isDirectory()) out.push(...collectFiles(abs, extensions, rel));
    else if (ent.isFile() && extensions.some(e => ent.name.endsWith(e))) out.push(rel);
  }
  return out;
}

function extractBody(source, openBraceIdx) {
  let depth = 1;
  let i = openBraceIdx + 1;
  for (; i < source.length; i++) {
    const c = source[i];
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) break; }
  }
  return { body: source.slice(openBraceIdx + 1, i), endIdx: i };
}

function lineOf(source, idx) {
  return source.slice(0, idx).split("\n").length;
}

function findTestSpans(source) {
  const spans = [];
  TEST_BLOCK_RE.lastIndex = 0;
  let m;
  while ((m = TEST_BLOCK_RE.exec(source)) !== null) {
    const name = m[2];
    const openBraceIdx = m.index + m[0].length - 1;
    const { body, endIdx } = extractBody(source, openBraceIdx);
    spans.push({ name, bodyStart: openBraceIdx + 1, bodyEnd: endIdx, body });
    TEST_BLOCK_RE.lastIndex = endIdx;
  }
  return spans;
}

function scanBareSetTimeout(relPath, source) {
  const findings = [];
  SETTIMEOUT_RE.lastIndex = 0;
  let m;
  while ((m = SETTIMEOUT_RE.exec(source)) !== null) {
    const lookback = source.slice(Math.max(0, m.index - 60), m.index);
    if (/promise/i.test(lookback)) continue; // sanctioned `await new Promise(...)` sleep idiom
    // Find the callback's body: setTimeout(cb, ms) — locate first '{' after the match, if the
    // first argument is a brace-bodied function/arrow. If no '{' immediately follows (e.g. a
    // named function reference is passed), fall back to a short forward window instead.
    let windowText;
    const braceIdx = source.indexOf("{", m.index);
    const parenCloseIdx = source.indexOf(")", m.index);
    if (braceIdx !== -1 && (parenCloseIdx === -1 || braceIdx < parenCloseIdx + 400)) {
      windowText = extractBody(source, braceIdx).body;
    } else {
      windowText = source.slice(m.index, Math.min(source.length, m.index + 200));
    }
    if (!ASSERTION_RE.test(windowText)) continue;
    const line = lineOf(source, m.index);
    findings.push({
      file: relPath,
      line,
      rule: "bare_settimeout_wait",
      severity: "warning",
      text: source.slice(source.lastIndexOf("\n", m.index) + 1, (source.indexOf("\n", m.index) + 1 || source.length) - 1).trim(),
    });
  }
  return findings;
}

function scanDateNowOrRandomInAssertion(relPath, source) {
  if (FAKE_TIMER_HINT_RE.test(source)) return [];
  const findings = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!ASSERTION_RE.test(line)) continue;
    if (!/Date\.now\s*\(\s*\)|Math\.random\s*\(\s*\)/.test(line)) continue;
    findings.push({
      file: relPath,
      line: i + 1,
      rule: "date_now_or_random_in_assertion",
      severity: "warning",
      text: line.trim(),
    });
  }
  return findings;
}

function scanSharedMutableState(relPath, source) {
  const findings = [];
  const testSpans = findTestSpans(source);
  if (testSpans.length < 2) return findings;

  MODULE_LEVEL_MUTABLE_RE.lastIndex = 0;
  let m;
  while ((m = MODULE_LEVEL_MUTABLE_RE.exec(source)) !== null) {
    const varName = m[1];
    const writeRe = WRITE_RE_TMPL(varName);
    const usageRe = USAGE_RE_TMPL(varName);
    const writtenIn = [];
    const usedIn = [];
    for (const span of testSpans) {
      if (writeRe.test(span.body)) writtenIn.push(span.name);
      if (usageRe.test(span.body)) usedIn.push(span.name);
    }
    if (writtenIn.length >= 1 && usedIn.length >= 2) {
      const declLine = lineOf(source, m.index);
      findings.push({
        file: relPath,
        line: declLine,
        rule: "shared_mutable_state_across_tests",
        severity: "warning",
        variable: varName,
        writtenIn,
        usedIn,
      });
    }
  }
  return findings;
}

function scanFileForFlakinessRisk(relPath, source) {
  return [
    ...scanBareSetTimeout(relPath, source),
    ...scanDateNowOrRandomInAssertion(relPath, source),
    ...scanSharedMutableState(relPath, source),
  ];
}

/**
 * @param {string} absTarget  Absolute, jail-validated file or directory.
 * @param {string} origPath   Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {string[]} [opts.extensions]
 * @param {number}   [opts.maxResults] Cap on findings[] length (1-5000, default 500).
 * @returns {{path, filesScanned, findingsCount, truncated, findings: Array}}
 */
function checkTestFlakinessRisk(absTarget, origPath, opts = {}) {
  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("check_test_flakiness_risk: max_results must be a number.", -32602);
  const maxResults = Math.min(Math.max(1, Math.trunc(opts.maxResults ?? DEFAULT_MAX_RESULTS)), HARD_MAX_RESULTS);
  const extensions = Array.isArray(opts.extensions) && opts.extensions.length
    ? opts.extensions : DEFAULT_EXTENSIONS;

  const stat = fs.statSync(absTarget);
  const isDirectory = stat.isDirectory();

  let files;
  if (isDirectory) {
    files = collectFiles(absTarget, extensions);
  } else {
    if (!extensions.some(e => absTarget.endsWith(e)))
      throw new ToolError(`check_test_flakiness_risk: '${origPath}' does not match any scanned extension.`, -32602);
    files = [path.basename(absTarget)];
  }

  const findings = [];
  for (const rel of files) {
    const abs = isDirectory ? path.join(absTarget, rel) : absTarget;
    let source;
    try { source = fs.readFileSync(abs, "utf8"); }
    catch (_) { continue; }
    findings.push(...scanFileForFlakinessRisk(rel, source));
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const truncated = findings.length > maxResults;

  return {
    path: origPath,
    filesScanned: files.length,
    findingsCount: findings.length,
    truncated,
    findings: findings.slice(0, maxResults),
  };
}

module.exports = { checkTestFlakinessRisk };
