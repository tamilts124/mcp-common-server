"use strict";
/**
 * find_race_condition_risk
 *
 * Scans JS/TS files for non-atomic read-then-write sequences on shared
 * module-scope mutable state inside async handlers or callbacks, where
 * concurrent invocations can interleave and corrupt data.
 *
 * Three rules:
 *
 *  1. non_atomic_readwrite_in_async (error)
 *     A module-scope variable is read (used as expression value) and then
 *     written (assigned, incremented, decremented, or mutated via push/
 *     splice/delete/pop) within the same async function / Promise callback /
 *     setTimeout/setInterval callback body, with no mutex/lock/semaphore
 *     guard visible in a ±8-line window.
 *
 *  2. check_then_act_race (error)
 *     An `if (sharedVar)` / `if (!sharedVar)` guard followed within 12 lines
 *     by an assignment or mutation of that same sharedVar, all inside an async
 *     function or callback body. The classic TOCTOU (time-of-check /
 *     time-of-use) pattern: between the check and the act another concurrent
 *     invocation can change the value.
 *
 *  3. shared_counter_no_lock (warning)
 *     A module-scope numeric counter (name contains count/counter/seq/
 *     sequence/index/idx/hits/requests/connections/pending) that is incremented
 *     (++/+= 1/+= N) inside a function body without any lock/mutex/semaphore
 *     guard. Even a simple ++ is non-atomic in event-loop concurrency when the
 *     increment consists of a read + compute + write, and an await between two
 *     operations on the same counter can race.
 *
 * Suppressions:
 *   - same-line `// safe`, `// atomic`, `// no-race`, `// nosec`
 *   - presence of `mutex`/`lock`/`semaphore`/`Semaphore`/`Mutex`/`AsyncLock`/
 *     `async-lock`/`p-queue`/`p-limit`/`sequelize.transaction` in a ±8-line
 *     window
 *
 * Returns { path, filesScanned, findingsCount, errorCount, warningCount,
 *           truncated, findings: [{file,line,variable,rule,severity,message}] }
 * Always available — does not require MCP_ALLOW_EXEC.
 */
const fs   = require("fs");
const path = require("path");
const { isIgnored }  = require("./roots");
const { ToolError }  = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX        = 500;
const HARD_MAX           = 5000;

// Module-scope declaration: starts at column 0
const MODULE_SCOPE_DECL_RE = /^(?:const|let|var)\s+(\w+)\s*=\s*(?:0|""|\'\'\'|\[|\{|null|undefined|false|true|new\s+\w+|\w+)/;
// Async contexts (function headers)
const ASYNC_FN_RE = /\basync\s+(?:function\b|\(|\w+\s*(?:=>|\())|setTimeout\s*\(|setInterval\s*\(|\.then\s*\(|\.catch\s*\(|new\s+Promise\s*\(/;
// Write on a variable: VAR = , VAR++, VAR--, ++VAR, VAR += , VAR -= , VAR.push(, VAR.splice(, VAR.pop(, delete VAR
function buildWriteRE(name) {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `(?:^|[^.\\w])${n}\\s*(?:[+\\-*/]?=(?!=)|\\+\\+|--)|` +
    `\\+\\+\\s*${n}|--\\s*${n}|` +
    `${n}\\.(?:push|pop|splice|shift|unshift|delete|set|clear|fill)\\s*\\(|` +
    `delete\\s+${n}\\b`
  );
}
// Read (use as expression value)
function buildReadRE(name) {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^.\\w])${n}(?:[^\\w(]|$)`);
}
// Counter name heuristic
const COUNTER_NAME_RE = /count|counter|seq(?:uence)?|index|idx|hits|request|connection|pending/i;
// Increment pattern
const INCREMENT_RE = /(?:\+\+|--)\s*\w+|\w+\s*(?:\+\+|--)|\w+\s*\+=\s*\d+/;
// Lock/mutex guard
const LOCK_GUARD_RE = /mutex|lock|semaphore|Semaphore|Mutex|AsyncLock|async-lock|p-queue|p-limit|sequelize\.transaction|transaction\s*\(/i;
// Safe annotations
const SAFE_ANNOT_RE = /\/\/\s*(?:safe|atomic|no-race|nosec)/i;
// Check-then-act: if (VAR) or if (!VAR)
function buildCheckRE(name) {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\bif\\s*\\(\\s*!?\\s*${n}\\b`);
}

function looksBinary(buf) {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
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

function windowHasGuard(lines, i, radius) {
  const start = Math.max(0, i - radius);
  const end   = Math.min(lines.length, i + radius + 1);
  return lines.slice(start, end).some(l => LOCK_GUARD_RE.test(l));
}

function isInsideAsyncContext(lines, targetIdx) {
  // Walk backward up to 30 lines for an async fn header, tracking brace depth
  let depth = 0;
  for (let i = targetIdx; i >= Math.max(0, targetIdx - 30); i--) {
    const l = lines[i];
    // Count braces in reverse
    for (let c = l.length - 1; c >= 0; c--) {
      if (l[c] === '}') depth++;
      else if (l[c] === '{') {
        if (depth > 0) depth--;
        else if (ASYNC_FN_RE.test(lines[i])) return { found: true, line: i };
      }
    }
    if (i < targetIdx && ASYNC_FN_RE.test(l) && /\{\s*$/.test(l)) return { found: true, line: i };
  }
  return { found: false };
}

function scanFile(relPath, src) {
  const findings = [];
  const lines    = src.split(/\r?\n/);

  // Collect module-scope mutable variable names (zero-indentation)
  const moduleVars = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(MODULE_SCOPE_DECL_RE);
    if (m && /^(?:let|var)\s/.test(line)) {  // only mutable: let/var
      moduleVars.push({ name: m[1], declLine: i });
    }
    // Also track let/var without initializer
    const m2 = line.match(/^(?:let|var)\s+(\w+)\s*;/);
    if (m2) moduleVars.push({ name: m2[1], declLine: i });
  }

  const reported = new Set();

  for (const { name, declLine } of moduleVars) {
    const writeRE  = buildWriteRE(name);
    const readRE   = buildReadRE(name);
    const checkRE  = buildCheckRE(name);

    for (let i = 0; i < lines.length; i++) {
      if (i === declLine) continue;  // skip the declaration itself
      const line = lines[i];
      if (SAFE_ANNOT_RE.test(line)) continue;

      // Rule 1: non-atomic read-then-write
      if (readRE.test(line) && !writeRE.test(line)) {
        // Look ahead for a write within 10 lines, inside same async context
        for (let j = i + 1; j < Math.min(lines.length, i + 10); j++) {
          const nextLine = lines[j];
          if (SAFE_ANNOT_RE.test(nextLine)) break;
          if (writeRE.test(nextLine)) {
            const key = `${name}:r1:${i}`;
            if (!reported.has(key) && isInsideAsyncContext(lines, i).found && !windowHasGuard(lines, i, 8)) {
              reported.add(key);
              findings.push({
                file: relPath, line: i + 1, variable: name,
                rule: "non_atomic_readwrite_in_async", severity: "error",
                message:
                  `Shared module-scope variable '${name}' is read on line ${i + 1} then ` +
                  `written on line ${j + 1} inside an async function/callback with no ` +
                  `mutex/lock guard. Concurrent invocations can interleave between the ` +
                  `read and the write, causing lost updates or corrupt state. ` +
                  `Fix: use a mutex library (async-lock, p-limit) or restructure to ` +
                  `avoid shared mutable state across await points.`,
              });
            }
            break;
          }
        }
      }

      // Rule 2: check-then-act
      if (checkRE.test(line)) {
        for (let j = i + 1; j < Math.min(lines.length, i + 12); j++) {
          const nextLine = lines[j];
          if (SAFE_ANNOT_RE.test(nextLine)) break;
          if (writeRE.test(nextLine)) {
            const key = `${name}:r2:${i}`;
            if (!reported.has(key) && isInsideAsyncContext(lines, i).found && !windowHasGuard(lines, i, 8)) {
              reported.add(key);
              findings.push({
                file: relPath, line: i + 1, variable: name,
                rule: "check_then_act_race", severity: "error",
                message:
                  `TOCTOU race: '${name}' is checked on line ${i + 1} and modified on ` +
                  `line ${j + 1} inside an async context with no lock. Another concurrent ` +
                  `invocation may modify '${name}' between the check and the act, ` +
                  `bypassing the guard. Use atomic compare-and-swap or a lock/mutex ` +
                  `that covers both the check and the act.`,
              });
            }
            break;
          }
        }
      }

      // Rule 3: shared counter no lock
      if (COUNTER_NAME_RE.test(name) && INCREMENT_RE.test(line) && writeRE.test(line)) {
        const key = `${name}:r3:${i}`;
        if (!reported.has(key) && !windowHasGuard(lines, i, 8)) {
          // Only flag if inside a function body (indented)
          if (line.match(/^\s{2,}/)) {
            reported.add(key);
            findings.push({
              file: relPath, line: i + 1, variable: name,
              rule: "shared_counter_no_lock", severity: "warning",
              message:
                `Module-scope counter '${name}' is incremented/decremented inside a ` +
                `function body without a lock. Concurrent async invocations make ` +
                `++ / += non-atomic: read + compute + write can interleave. ` +
                `Use an atomic counter pattern or Atomics (SharedArrayBuffer) for ` +
                `correctness under concurrency. If concurrency is not a concern, ` +
                `annotate with // atomic or restructure to local scope.`,
            });
          }
        }
      }
    }
  }

  return findings;
}

function findRaceConditionRisk(absPath, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absPath); }
  catch (e) {
    throw new ToolError(
      `find_race_condition_risk: cannot access '${origPath}': ${e.message}`,
      -32602
    );
  }

  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_race_condition_risk: extensions must be an array.", -32602);
  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_race_condition_risk: max_results must be a number.", -32602);

  const extensions = Array.isArray(opts.extensions) && opts.extensions.length
    ? opts.extensions : DEFAULT_EXTENSIONS;
  const maxResults = Math.min(
    Math.max(1, Math.trunc(opts.maxResults ?? DEFAULT_MAX)),
    HARD_MAX
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
    errorCount: Math.min(errorCount, maxResults),
    warningCount: Math.min(warningCount, maxResults),
    truncated,
    findings: findings.slice(0, maxResults),
  };
}

module.exports = { findRaceConditionRisk };
