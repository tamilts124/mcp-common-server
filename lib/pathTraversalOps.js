"use strict";
/**
 * find_path_traversal_risk
 *
 * Scans JS/TS files for path traversal vulnerabilities — cases where user-
 * controlled input flows into file system operations without adequate
 * validation or normalization.
 *
 * Three rules:
 *
 *   1. path_join_with_user_input (error)
 *      `path.join(`, `path.resolve(`, or `path.normalize(` called with an
 *      argument that contains user-controlled input (req.body/query/params/
 *      headers or a sensitive-name identifier: file/dir/path/filename/
 *      filepath/folder/directory) without a visible containment guard
 *      (startsWith, includes, allowlist, ALLOWED, /^[a-z]/i check, or
 *      path.relative validation).
 *
 *   2. fs_readwrite_with_user_input (error)
 *      `fs.readFile`, `fs.writeFile`, `fs.appendFile`, `fs.readFileSync`,
 *      `fs.writeFileSync`, `fs.createReadStream`, `fs.createWriteStream`,
 *      `fs.unlink`, `fs.rename` called where the first argument (the path)
 *      contains user-tainted input without validation.
 *
 *   3. send_file_with_user_input (warning)
 *      Express `res.sendFile(` or `res.download(` where the path argument
 *      contains user-tainted input. These serve arbitrary files from the
 *      filesystem and must be restricted to a safe root.
 *
 * Suppressions: same-line `// safe`, `// path-safe`, or presence of a
 * containment guard (`startsWith`, `allowlist`, `ALLOWED`, `path.relative`)
 * on the same line or within 3 lines above suppresses the finding.
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

// User taint: req.* or path-like identifier names
const REQ_TAINT_RE   = /\breq\s*\.\s*(?:body|query|params|headers)\b/;
const PATH_NAME_RE   = /\b(?:file(?:name|path)?|dir(?:ectory|Path)?|folder|userPath|filePath|dirPath|uploadPath|basePath|targetPath|destPath)\b/i;
const SENSITIVE_ID_RE = /\b(?:input|param(?:eter)?|value|data|query|search)\b/i;

// Containment / validation guards suppress findings
const GUARD_RE = /startsWith|path\.relative|allowlist|whitelist|ALLOW(?:ED|LIST)|\/\^|sanitize|normalize.*join|join.*normalize/i;

// Safe annotation suppression
const SAFE_ANNOT_RE = /\/\/\s*(?:safe|path-safe)/i;

function isTainted(str) {
  return REQ_TAINT_RE.test(str) || PATH_NAME_RE.test(str) || SENSITIVE_ID_RE.test(str);
}

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

function extractArgs(src, openParenIdx) {
  let i = openParenIdx + 1;
  const end = Math.min(src.length, openParenIdx + 300);
  let depth = 0;
  let inStr = null;
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
    } else {
      buf.push(c);
    }
    i++;
  }
  return buf.join("");
}

// Rule 1: path.join / path.resolve / path.normalize with user input
const PATH_CALL_RE = /\bpath\.(join|resolve|normalize)\s*\(/g;

// Rule 2: fs read/write/stream ops
const FS_OP_RE = /\bfs\.(readFile|writeFile|appendFile|readFileSync|writeFileSync|createReadStream|createWriteStream|unlink|rename)\s*\(/g;

// Rule 3: res.sendFile / res.download
const SEND_FILE_RE = /\bres\.(sendFile|download)\s*\(/g;

function scanFile(relPath, src) {
  const findings = [];
  const lines    = src.split("\n");

  // ── Rule 1: path.join / path.resolve / path.normalize ─────────────────────
  PATH_CALL_RE.lastIndex = 0;
  let m;
  while ((m = PATH_CALL_RE.exec(src)) !== null) {
    const callName = `path.${m[1]}`;
    const lineNo   = lineOf(src, m.index);
    const lineIdx  = lineNo - 1;
    const lineStr  = lines[lineIdx] || "";
    if (SAFE_ANNOT_RE.test(lineStr)) continue;
    const openParen = m.index + m[0].length - 1;
    const args      = extractArgs(src, openParen);
    // Check args + 3 surrounding lines for taint
    const win = lines.slice(Math.max(0, lineIdx - 2), lineIdx + 2).join(" ");
    if (!isTainted(args) && !isTainted(win)) continue;
    // Check for guard within 3 lines above
    const guard = lines.slice(Math.max(0, lineIdx - 3), lineIdx + 1).join(" ");
    if (GUARD_RE.test(lineStr) || GUARD_RE.test(guard)) continue;
    findings.push({
      file:     relPath,
      line:     lineNo,
      rule:     "path_join_with_user_input",
      severity: "error",
      message:
        `${callName}() called with user-controlled input without a containment ` +
        `guard. An attacker can supply '../../../etc/passwd' to escape the ` +
        `intended directory. Validate the resolved path starts with the safe ` +
        `root: const safe = path.resolve(ROOT, input); if (!safe.startsWith(ROOT + path.sep)) throw err;`,
    });
  }

  // ── Rule 2: fs read/write ops ──────────────────────────────────────────────
  FS_OP_RE.lastIndex = 0;
  while ((m = FS_OP_RE.exec(src)) !== null) {
    const callName = `fs.${m[1]}`;
    const lineNo   = lineOf(src, m.index);
    const lineIdx  = lineNo - 1;
    const lineStr  = lines[lineIdx] || "";
    if (SAFE_ANNOT_RE.test(lineStr)) continue;
    const openParen = m.index + m[0].length - 1;
    const args      = extractArgs(src, openParen);
    const win = lines.slice(Math.max(0, lineIdx - 2), lineIdx + 2).join(" ");
    if (!isTainted(args) && !isTainted(win)) continue;
    const guard = lines.slice(Math.max(0, lineIdx - 3), lineIdx + 1).join(" ");
    if (GUARD_RE.test(lineStr) || GUARD_RE.test(guard)) continue;
    findings.push({
      file:     relPath,
      line:     lineNo,
      rule:     "fs_readwrite_with_user_input",
      severity: "error",
      message:
        `${callName}() called with user-controlled path argument without ` +
        `visible validation. A path traversal attack can read sensitive ` +
        `files (e.g. /etc/passwd, .env, private keys) or overwrite arbitrary ` +
        `files. Resolve the path and verify it falls within the intended root ` +
        `before passing it to any fs function.`,
    });
  }

  // ── Rule 3: res.sendFile / res.download ───────────────────────────────────
  SEND_FILE_RE.lastIndex = 0;
  while ((m = SEND_FILE_RE.exec(src)) !== null) {
    const callName = `res.${m[1]}`;
    const lineNo   = lineOf(src, m.index);
    const lineIdx  = lineNo - 1;
    const lineStr  = lines[lineIdx] || "";
    if (SAFE_ANNOT_RE.test(lineStr)) continue;
    const openParen = m.index + m[0].length - 1;
    const args      = extractArgs(src, openParen);
    const win = lines.slice(Math.max(0, lineIdx - 2), lineIdx + 2).join(" ");
    if (!isTainted(args) && !isTainted(win)) continue;
    const guard = lines.slice(Math.max(0, lineIdx - 3), lineIdx + 1).join(" ");
    if (GUARD_RE.test(lineStr) || GUARD_RE.test(guard)) continue;
    findings.push({
      file:     relPath,
      line:     lineNo,
      rule:     "send_file_with_user_input",
      severity: "warning",
      message:
        `${callName}() serves a file whose path is user-controlled. ` +
        `Without validation, any file on the server filesystem can be ` +
        `served to the client. Use the Express root option or validate that ` +
        `the resolved path starts within the intended directory.`,
    });
  }

  return findings;
}

function findPathTraversalRisk(absPath, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absPath); }
  catch (e) {
    throw new ToolError(
      `find_path_traversal_risk: cannot access '${origPath}': ${e.message}`,
      -32602
    );
  }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_path_traversal_risk: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_path_traversal_risk: extensions must be an array.", -32602);

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

module.exports = { findPathTraversalRisk };
