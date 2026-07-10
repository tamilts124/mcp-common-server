"use strict";
/**
 * find_event_emitter_leak
 *
 * Scans JS/TS files for patterns that cause EventEmitter listener accumulation
 * in long-running Node.js processes:
 *
 *   1. process_listener_in_function_body (error)
 *      A `process.on(event, handler)` call is found inside a function body —
 *      either on an indented line OR on the same line as a function/block
 *      opener (single-line body). Each time the function runs, a new permanent
 *      listener is added to `process`, accumulating indefinitely. Node.js
 *      warns once >10 listeners are attached (MaxListenersExceededWarning),
 *      and the listeners themselves are never GC'd. Most common offender:
 *      adding uncaughtException/unhandledRejection handlers inside express
 *      middleware or request handlers.
 *
 *   2. emitter_on_inside_loop (warning)
 *      An `.on(event, handler)` call is found inside a `for`/`while`/`do`
 *      loop body (detected by a `for(`/`while(`/`do {` header appearing within
 *      a 15-line lookback). Each loop iteration attaches a new listener to the
 *      emitter without removing the previous one, so the listener count grows
 *      with the loop iterations.
 *
 * Siblings: find_missing_remove_event_listener, find_setinterval_without_clear,
 *   find_memory_leak_patterns
 */
const fs   = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS    = 5000;
const LOOP_LOOKBACK       = 15; // lines to look back for a loop header

function looksBinary(buf) {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}

function lineOf(src, idx) {
  let n = 1;
  for (let i = 0; i < idx && i < src.length; i++) if (src[i] === "\n") n++;
  return n;
}

function collectFiles(absDir, extensions, relBase) {
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

// Matches `process.on(` or `process.once(`
const PROCESS_ON_RE = /\bprocess\s*\.\s*on(?:ce)?\s*\(/g;

// Matches any `.on(` or `.once(` call — but NOT `process.on` (that's Rule 1)
const EMITTER_ON_RE = /(?<!process)\s*\.\s*on(?:ce)?\s*\(/g;

// Loop headers on a line (for/while/do)
const LOOP_HEADER_RE = /^[ \t]*(?:for\s*\(|while\s*\(|do\s*\{)/m;

/**
 * Returns true when `process.on` at `matchIndex` in `src` appears inside a
 * function body — either:
 *   (a) the line has leading whitespace (typical multi-line indented block), or
 *   (b) there is non-whitespace content BEFORE `process` on the same line
 *       (single-line body: `function x() { process.on(...); }`).
 */
function isInsideFunctionBody(lineStr) {
  if (/^[ \t]/.test(lineStr)) return true;          // (a) indented line
  const idx = lineStr.indexOf("process");
  if (idx > 0 && /\S/.test(lineStr.slice(0, idx))) return true; // (b) inline
  return false;
}

function scanFile(relPath, src) {
  const findings = [];
  const lines    = src.split("\n");

  // ── Rule 1: process.on inside a function body ────────────────────────────
  PROCESS_ON_RE.lastIndex = 0;
  let m;
  while ((m = PROCESS_ON_RE.exec(src)) !== null) {
    const lineNo  = lineOf(src, m.index);
    const lineIdx = lineNo - 1;
    const lineStr = lines[lineIdx] || "";
    if (!isInsideFunctionBody(lineStr)) continue;
    // Extract the event name for a better error message
    const rest = src.slice(m.index + m[0].length);
    const eventMatch = rest.match(/^['"`]([^'"`]+)['"`]/);
    const eventName  = eventMatch ? eventMatch[1] : "<event>";
    findings.push({
      file:     relPath,
      line:     lineNo,
      event:    eventName,
      rule:     "process_listener_in_function_body",
      severity: "error",
      message:
        `process.on('${eventName}', handler) called inside a function/callback ` +
        `(not at module scope). Each invocation permanently adds a new listener ` +
        `to the process EventEmitter. After 10 calls Node.js emits ` +
        `MaxListenersExceededWarning and the listeners accumulate for the ` +
        `life of the process. Move process.on('${eventName}') to module ` +
        `scope (called exactly once at startup).`,
    });
  }

  // ── Rule 2: .on() / .once() inside a loop ────────────────────────────────
  EMITTER_ON_RE.lastIndex = 0;
  while ((m = EMITTER_ON_RE.exec(src)) !== null) {
    const lineNo  = lineOf(src, m.index);
    const lineIdx = lineNo - 1;
    const lineStr = lines[lineIdx] || "";

    // Must be on an indented line (inside some block)
    if (!/^[ \t]/.test(lineStr)) continue;

    // Look back up to LOOP_LOOKBACK lines for a loop header
    const lookbackStart = Math.max(0, lineIdx - LOOP_LOOKBACK);
    const priorText = lines.slice(lookbackStart, lineIdx).join("\n");
    if (!LOOP_HEADER_RE.test(priorText)) continue;

    // Extract emitter and event name for the message
    const lineText = lineStr.trim();
    const rest     = src.slice(m.index + m[0].length);
    const eventMatch = rest.match(/^['"`]([^'"`]+)['"`]/);
    const eventName  = eventMatch ? eventMatch[1] : "<event>";
    // Extract receiver (the identifier before .on)
    const receiverMatch = lineText.match(/([\w$]+)\s*\.\s*on(?:ce)?\s*\($/);
    const receiver      = receiverMatch ? receiverMatch[1] : "emitter";

    findings.push({
      file:     relPath,
      line:     lineNo,
      event:    eventName,
      emitter:  receiver,
      rule:     "emitter_on_inside_loop",
      severity: "warning",
      message:
        `${receiver}.on('${eventName}', ...) called inside a loop body. ` +
        `Each iteration attaches a new listener without removing the previous ` +
        `one — after enough iterations Node.js fires MaxListenersExceededWarning ` +
        `and the listener count grows without bound. Attach the listener once ` +
        `before the loop, or call ${receiver}.removeAllListeners('${eventName}') ` +
        `at the start of each iteration if listener refresh is intentional.`,
    });
  }

  return findings;
}

function findEventEmitterLeak(absPath, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absPath); }
  catch (e) {
    throw new ToolError(
      `find_event_emitter_leak: cannot access '${origPath}': ${e.message}`,
      -32602
    );
  }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_event_emitter_leak: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_event_emitter_leak: extensions must be an array.", -32602);

  const extensions = Array.isArray(opts.extensions) && opts.extensions.length
    ? opts.extensions : DEFAULT_EXTENSIONS;
  const maxResults = Math.min(
    Math.max(1, Math.trunc(opts.maxResults ?? DEFAULT_MAX_RESULTS)),
    HARD_MAX_RESULTS
  );

  const files   = stat.isDirectory() ? collectFiles(absPath, extensions, "") : [path.basename(absPath)];
  const baseDir = stat.isDirectory() ? absPath : path.dirname(absPath);

  const findings = [];
  for (const rel of files) {
    let buf;
    try { buf = fs.readFileSync(path.join(baseDir, rel)); }
    catch (_) { continue; }
    if (looksBinary(buf)) continue;
    findings.push(...scanFile(rel, buf.toString("utf8")));
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const truncated    = findings.length > maxResults;
  const errorCount   = findings.filter(f => f.severity === "error").length;
  const warningCount = findings.filter(f => f.severity === "warning").length;

  return {
    path: origPath,
    filesScanned: files.length,
    findingsCount: Math.min(findings.length, maxResults),
    errorCount,
    warningCount,
    truncated,
    findings: findings.slice(0, maxResults),
  };
}

module.exports = { findEventEmitterLeak };
