"use strict";
// ── FIND_CONSOLE_LOGS — leftover debug console.*/debugger statement scanner ─
// Same MCP_IGNORE-aware walk + binary-skip heuristic as scan_todos. Regex
// per line (no comment-aware parsing — same pragmatic tradeoff as
// scan_todos/scan_secrets: a `// console.log(...)` inside a comment still
// matches, since distinguishing "already commented out, safe to ignore" from
// "still live" needs a real parser). Flags console.log/debug/info/warn/error/
// trace(...) calls and bare `debugger;` statements — the leftover-debug-code
// class of dev-debt, distinct from scan_todos (comment markers like TODO) and
// scan_secrets (hardcoded credentials).
const fs   = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_METHODS = ["log", "debug", "info", "warn", "error", "trace"];
const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];

function looksBinary(buf) {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}

function scanFileInto(absPath, relPath, consoleRe, debuggerRe, maxMatches, results) {
  let buf;
  try { buf = fs.readFileSync(absPath); } catch (e) { return; }
  if (looksBinary(buf)) return;
  const lines = buf.toString("utf8").split(/\r\n|\n/);
  for (let i = 0; i < lines.length; i++) {
    if (results.length >= maxMatches) return;
    consoleRe.lastIndex = 0;
    const cm = consoleRe.exec(lines[i]);
    if (cm) {
      results.push({ file: relPath, line: i + 1, method: `console.${cm[1]}`, text: lines[i].trim().slice(0, 400) });
      continue;
    }
    if (debuggerRe.test(lines[i])) {
      results.push({ file: relPath, line: i + 1, method: "debugger", text: lines[i].trim().slice(0, 400) });
    }
  }
}

/**
 * Scan a file or directory tree for leftover console.* / debugger debug statements.
 * @returns {{ path, filesScanned, totalMatches, truncated, byMethod, matches }}
 */
function findConsoleLogs(absPath, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absPath); }
  catch (e) { throw new ToolError(`find_console_logs: cannot access '${origPath}': ${e.message}`, -32602); }

  const rawMethods = (opts.methods && opts.methods.length ? opts.methods : DEFAULT_METHODS)
    .map(m => String(m).trim()).filter(Boolean);
  if (rawMethods.length === 0) throw new ToolError("find_console_logs: 'methods' must not be an empty array.", -32602);
  const validMethods = rawMethods.filter(m => DEFAULT_METHODS.includes(m));
  if (validMethods.length === 0)
    throw new ToolError(`find_console_logs: 'methods' contained no valid console methods (valid: ${DEFAULT_METHODS.join(", ")}).`, -32602);
  const consoleRe = new RegExp(`console\\s*\\.\\s*(${validMethods.join("|")})\\s*\\(`, "g");
  const debuggerRe = /\bdebugger\s*;/;

  const maxMatches = Math.min(Math.max(1, Math.trunc(opts.maxMatches ?? 500)), 5000);
  const exts = (opts.extensions?.length ? opts.extensions : DEFAULT_EXTENSIONS)
    .map(e => e.startsWith(".") ? e.toLowerCase() : "." + e.toLowerCase());

  const results = [];
  let filesScanned = 0;

  if (stat.isFile()) {
    filesScanned = 1;
    scanFileInto(absPath, origPath, consoleRe, debuggerRe, maxMatches, results);
  } else if (stat.isDirectory()) {
    (function walk(dir, relDir) {
      if (results.length >= maxMatches) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch (e) { return; }
      for (const ent of entries) {
        if (results.length >= maxMatches) return;
        if (isIgnored(ent.name)) continue;
        const relPath = relDir ? relDir + "/" + ent.name : ent.name;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          walk(full, relPath);
        } else if (ent.isFile()) {
          if (!exts.includes(path.extname(ent.name).toLowerCase())) continue;
          filesScanned++;
          scanFileInto(full, origPath ? origPath + "/" + relPath : relPath, consoleRe, debuggerRe, maxMatches, results);
        }
      }
    })(absPath, "");
  } else {
    throw new ToolError(`find_console_logs: '${origPath}' is neither a regular file nor a directory.`, -32602);
  }

  const byMethod = {};
  for (const r of results) byMethod[r.method] = (byMethod[r.method] || 0) + 1;

  return {
    path: origPath,
    filesScanned,
    totalMatches: results.length,
    truncated: results.length >= maxMatches,
    byMethod,
    matches: results,
  };
}

module.exports = { findConsoleLogs };
