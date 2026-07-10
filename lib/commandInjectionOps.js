"use strict";
/**
 * find_command_injection_risk
 *
 * Scans JS/TS files for shell command execution calls that include
 * user-controlled values — the command injection vulnerability.
 *
 * Three rules:
 *
 *   1. exec_with_concat (error)
 *      `exec(`, `execSync(`, `spawnSync(`, `spawn(`, `execFile(`,
 *      `execFileSync(` called with a string that is built by concatenation
 *      or template-literal interpolation, where the interpolated/concatenated
 *      value looks like user input (req.body/query/params, or a sensitive-
 *      name heuristic: input/param/value/data/arg/cmd/command/path/file/name).
 *
 *   2. shell_true_spawn_with_input (error)
 *      `spawn(` / `spawnSync(` with `{ shell: true }` on the same or adjacent
 *      line AND a template-literal or concatenated first argument containing
 *      user-supplied identifiers. `shell: true` means the first argument is
 *      passed to `/bin/sh -c`, making injection trivially exploitable.
 *
 *   3. unvalidated_path_exec (warning)
 *      `exec(`, `execSync(`, `require('child_process')` where the command
 *      string contains a variable with a path-like name (file/dir/path/
 *      filename/filepath) without a same-line validation hint (startsWith,
 *      resolve, normalize, allowlist, ALLOWED).
 *
 * Suppressions: `// safe`, `// noexec`, or `// no-exec` on the same line.
 *
 * Pure text-scan (regex), not an AST/data-flow parser.
 * Returns { path, filesScanned, findingsCount, errorCount, warningCount,
 *           truncated, findings: [{file,line,rule,severity,message}] }.
 * Always available — does not require MCP_ALLOW_EXEC.
 */
const fs   = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS    = 5000;

// Exec call family
const EXEC_CALL_RE = /\b(exec(?:File)?(?:Sync)?|spawnSync?)\s*\(/g;

// User taint: req.* or sensitive identifier names
const REQ_TAINT_RE  = /\breq\s*\.\s*(?:body|query|params|headers)\b/;
const USER_INPUT_RE = /\b(?:input|param(?:eter)?|value|data|arg(?:ument)?s?|cmd|command|shell|file(?:name|path)?|dir(?:ectory)?|folder|path|user(?:input)?|search)\b/i;

// Template literal or concat in first argument
const TEMPLATE_ARG_RE = /`[^`]*\$\{/;
const CONCAT_ARG_RE   = /['"][^'"]*['"]\s*\+|\+\s*['"][^'"]*['"]/;

// shell: true option
const SHELL_TRUE_RE   = /shell\s*:\s*true/;

// Validation hints that suppress unvalidated-path warning
const VALIDATION_HINT_RE = /startsWith|path\.resolve|path\.normalize|allowlist|whitelist|ALLOW(?:ED|LIST)/i;

// Safe annotation suppression
const SAFE_ANNOT_RE = /\/\/\s*(?:safe|noexec|no-exec)/i;

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

/**
 * Extract the first argument string (up to ~200 chars) of a call starting at
 * `openParenIdx` in `src`. Returns the raw text between the opening paren and
 * its logical end (next comma at depth-0 or closing paren).
 */
function extractFirstArg(src, openParenIdx) {
  let i = openParenIdx + 1; // skip '('
  let depth = 0;
  let inStr = null;
  const end = Math.min(src.length, openParenIdx + 200);
  const buf = [];
  while (i < end) {
    const c = src[i];
    if (inStr) {
      buf.push(c);
      if (c === "\\" && i + 1 < end) { buf.push(src[++i]); }
      else if (c === inStr) inStr = null;
    } else if (c === "'" || c === '"' || c === "`") {
      inStr = c; buf.push(c);
    } else if (c === "(" || c === "[" || c === "{") {
      depth++; buf.push(c);
    } else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) break;
      depth--; buf.push(c);
    } else if (c === "," && depth === 0) {
      break;
    } else {
      buf.push(c);
    }
    i++;
  }
  return buf.join("");
}

function scanFile(relPath, src) {
  const findings = [];
  const lines    = src.split("\n");

  EXEC_CALL_RE.lastIndex = 0;
  let m;
  while ((m = EXEC_CALL_RE.exec(src)) !== null) {
    const callName = m[1];
    const lineNo   = lineOf(src, m.index);
    const lineIdx  = lineNo - 1;
    const lineStr  = lines[lineIdx] || "";
    if (SAFE_ANNOT_RE.test(lineStr)) continue;

    // Extract first argument
    const openParen = m.index + m[0].length - 1; // position of '('
    const firstArg  = extractFirstArg(src, openParen);

    const hasTemplate = TEMPLATE_ARG_RE.test(firstArg);
    const hasConcat   = CONCAT_ARG_RE.test(firstArg);

    if (!hasTemplate && !hasConcat) {
      // Rule 3: unvalidated path variable in exec argument
      if (USER_INPUT_RE.test(firstArg) && !VALIDATION_HINT_RE.test(lineStr)) {
        // Check surrounding 2 lines for path-like variable names that look unvalidated
        const window2 = lines.slice(Math.max(0, lineIdx - 1), lineIdx + 2).join(" ");
        if (/\b(?:file(?:name|path)?|dir(?:ectory)?|folder|userPath|filePath|dirPath)\b/i.test(window2)
            && !VALIDATION_HINT_RE.test(window2)) {
          findings.push({
            file:     relPath,
            line:     lineNo,
            rule:     "unvalidated_path_exec",
            severity: "warning",
            message:
              `${callName}() called with a path-like variable that has no visible ` +
              `allow-list or normalisation check (path.resolve/normalize/startsWith). ` +
              `An attacker who controls the path can traverse to arbitrary executables ` +
              `or escape the intended directory. Validate and normalise paths before ` +
              `passing them to child_process functions.`,
          });
        }
      }
      continue;
    }

    // Look back 3 lines for taint context
    const window3 = lines.slice(Math.max(0, lineIdx - 2), lineIdx + 2).join(" ");
    const hasTaint = REQ_TAINT_RE.test(firstArg) || REQ_TAINT_RE.test(window3)
                  || USER_INPUT_RE.test(firstArg);
    if (!hasTaint) continue;

    // Rule 2: shell: true + dynamic argument
    const win5 = lines.slice(Math.max(0, lineIdx - 1), lineIdx + 4).join(" ");
    if ((callName === "spawn" || callName === "spawnSync") && SHELL_TRUE_RE.test(win5)) {
      findings.push({
        file:     relPath,
        line:     lineNo,
        rule:     "shell_true_spawn_with_input",
        severity: "error",
        message:
          `${callName}() called with { shell: true } and a dynamic argument containing ` +
          `user-controlled input. With shell:true the first argument is passed to ` +
          `'/bin/sh -c', making command injection trivially exploitable via shell ` +
          `metacharacters (; | & $ \`). Remove shell:true and pass the command ` +
          `and args as separate array elements, or sanitize with shlex/shell-quote.`,
      });
      continue;
    }

    // Rule 1: exec with concat/template and user taint
    findings.push({
      file:     relPath,
      line:     lineNo,
      rule:     "exec_with_concat",
      severity: "error",
      message:
        `${callName}() called with a ${hasTemplate ? "template-literal" : "concatenated"} ` +
        `argument containing user-controlled input. An attacker can inject shell ` +
        `metacharacters (; | & $ \`) to execute arbitrary commands. ` +
        `Pass the command and arguments as separate array elements to spawn/execFile, ` +
        `or sanitize and escape all user values before building the command string.`,
    });
  }

  return findings;
}

function findCommandInjectionRisk(absPath, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absPath); }
  catch (e) {
    throw new ToolError(
      `find_command_injection_risk: cannot access '${origPath}': ${e.message}`,
      -32602
    );
  }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_command_injection_risk: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_command_injection_risk: extensions must be an array.", -32602);

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

module.exports = { findCommandInjectionRisk };
