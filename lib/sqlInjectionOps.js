"use strict";
/**
 * find_sql_injection_risk
 *
 * Scans JS/TS files for SQL query strings built by concatenating or
 * interpolating user-controlled values — the classic SQL injection footgun.
 *
 * Three rules:
 *
 *   1. sql_string_concat (error)
 *      A string beginning with a SQL keyword (SELECT/INSERT/UPDATE/DELETE/
 *      CREATE/DROP/ALTER/REPLACE/MERGE/TRUNCATE/EXEC/EXECUTE/CALL/WITH)
 *      is concatenated with `+` where the right-hand side references a
 *      request-input variable (req.body/req.query/req.params/req.headers)
 *      or a variable whose name contains id/name/user/email/input/param/
 *      value/data/search/filter/query/where on the same or adjacent lines.
 *
 *   2. sql_template_literal (error)
 *      A template literal `...${expr}...` contains a SQL keyword and
 *      interpolates any expression that looks like it might be user input
 *      (req.X, or identifiers matching the sensitive-name heuristic above).
 *      Suppressed if the next line contains a parameterised-query hint.
 *
 *   3. sql_dynamic_query_variable (warning)
 *      A variable whose name ends with `Sql`/`Query`/`Statement`/`SQL` is
 *      built by string concatenation (`+=` or `+`) anywhere in the file —
 *      even without a visible req.* taint, dynamic SQL assembly is a risk
 *      worth reviewing.
 *
 * Suppressions: a same-line `// safe` or `// nosql` or a parameterised-query
 * hint (`.query(sql, [`, `db.execute(`, `stmt.run(`, `prepare(`) on the
 * same line OR the immediately following line suppresses the finding.
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

// User-taint: req.body/query/params/headers or sensitive-name identifiers
const REQ_TAINT_RE = /\breq\s*\.\s*(?:body|query|params|headers)\b/;
const SENSITIVE_NAME_RE =
  /\b(?:id|name|user|email|input|param(?:eter)?|value|data|search|filter|query|where)\b/i;

// Parameterized-query hint suppresses the finding
const PARAM_HINT_RE = /\.query\s*\(\s*\w+\s*,\s*\[|\.execute\s*\(|\.prepare\s*\(|stmt\.run\s*\(|[?$]\d/;

// Safe-annotation suppression
const SAFE_ANNOT_RE = /\/\/\s*(?:safe|nosql|no-sql)/i;

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

// Regex for sql_string_concat: SQL keyword in a string followed by + someExpr
const SQL_CONCAT_RE = /(['"`])(?:[^'"`\\]|\\.)*(?:SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|REPLACE|MERGE|TRUNCATE|EXEC(?:UTE)?|CALL|WITH)(?:[^'"`\\]|\\.)*\1\s*\+/gi;

// Template literal with SQL keyword and interpolation
const SQL_TEMPLATE_RE = /`[^`]*(?:SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|REPLACE|MERGE|TRUNCATE|EXEC(?:UTE)?|CALL|WITH)[^`]*\$\{[^}]+\}[^`]*`/gi;

// Dynamic SQL variable: sqlVar += ... or sqlVar = sqlVar + ...
const SQL_VAR_RE = /\b([\w$]*(?:sql|query|statement|SQL|Query|Statement)[\w$]*)\s*(?:\+=|=\s*[\w$]*\s*\+)/gi;

function scanFile(relPath, src) {
  const findings = [];
  const lines    = src.split("\n");

  // ── Rule 1: sql_string_concat ──────────────────────────────────────────────
  SQL_CONCAT_RE.lastIndex = 0;
  let m;
  while ((m = SQL_CONCAT_RE.exec(src)) !== null) {
    const lineNo  = lineOf(src, m.index);
    const lineStr = lines[lineNo - 1] || "";
    if (SAFE_ANNOT_RE.test(lineStr) || PARAM_HINT_RE.test(lineStr)) continue;
    // Check this line + 2 surrounding lines for taint
    const window = lines.slice(Math.max(0, lineNo - 2), lineNo + 2).join(" ");
    if (!REQ_TAINT_RE.test(window) && !SENSITIVE_NAME_RE.test(window)) continue;
    findings.push({
      file:     relPath,
      line:     lineNo,
      rule:     "sql_string_concat",
      severity: "error",
      message:
        `SQL string concatenation with user-controlled value detected. ` +
        `String-building SQL queries by concatenation allows an attacker to ` +
        `break out of the intended query structure (SQL injection). ` +
        `Use parameterised queries / prepared statements instead: ` +
        `db.query(sql, [param1, param2]) or db.prepare(sql).run(params).`,
    });
  }

  // ── Rule 2: sql_template_literal ─────────────────────────────────────────
  SQL_TEMPLATE_RE.lastIndex = 0;
  while ((m = SQL_TEMPLATE_RE.exec(src)) !== null) {
    const lineNo   = lineOf(src, m.index);
    const lineStr  = lines[lineNo - 1] || "";
    const nextLine = lines[lineNo] || "";
    if (SAFE_ANNOT_RE.test(lineStr) || PARAM_HINT_RE.test(lineStr) || PARAM_HINT_RE.test(nextLine)) continue;
    // Extract interpolated expressions and check for taint / sensitive names
    const interpolations = [];
    const iRe = /\$\{([^}]+)\}/g;
    let iM;
    iRe.lastIndex = 0;
    while ((iM = iRe.exec(m[0])) !== null) interpolations.push(iM[1]);
    const exprStr = interpolations.join(" ");
    if (!REQ_TAINT_RE.test(exprStr) && !SENSITIVE_NAME_RE.test(exprStr)) continue;
    findings.push({
      file:     relPath,
      line:     lineNo,
      rule:     "sql_template_literal",
      severity: "error",
      message:
        `SQL template literal with interpolated user-controlled value. ` +
        `Template literals build the SQL string at runtime, giving an attacker ` +
        `the same injection surface as string concatenation. ` +
        `Use parameterised queries: db.query('SELECT * FROM t WHERE id = ?', [id]).`,
    });
  }

  // ── Rule 3: sql_dynamic_query_variable ───────────────────────────────────
  SQL_VAR_RE.lastIndex = 0;
  while ((m = SQL_VAR_RE.exec(src)) !== null) {
    const lineNo  = lineOf(src, m.index);
    const lineStr = lines[lineNo - 1] || "";
    if (SAFE_ANNOT_RE.test(lineStr) || PARAM_HINT_RE.test(lineStr)) continue;
    const varName = m[1];
    findings.push({
      file:     relPath,
      line:     lineNo,
      rule:     "sql_dynamic_query_variable",
      severity: "warning",
      message:
        `SQL query string '${varName}' is built by dynamic concatenation. ` +
        `Dynamically assembled SQL is a common injection vector even when the ` +
        `individual fragments seem safe — a future change can introduce tainted ` +
        `input. Consider parameterised queries or a query builder (Knex, Drizzle) ` +
        `that safely escapes all values.`,
    });
  }

  return findings;
}

function findSqlInjectionRisk(absPath, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absPath); }
  catch (e) {
    throw new ToolError(
      `find_sql_injection_risk: cannot access '${origPath}': ${e.message}`,
      -32602
    );
  }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_sql_injection_risk: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_sql_injection_risk: extensions must be an array.", -32602);

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

module.exports = { findSqlInjectionRisk };
