"use strict";
/**
 * find_missing_input_validation
 *
 * Scans JS/TS files for Express routes that access req.body, req.query, or
 * req.params without a visible validation middleware guard. Unvalidated external
 * input is a leading cause of injection attacks, type confusion bugs, and
 * unexpected server crashes.
 *
 * Two rules:
 *
 *   1. route_body_no_validation (error)
 *      An Express route handler (app.post/put/patch, or router.post/put/patch)
 *      whose callback body accesses `req.body` but the file has no visible
 *      validation library usage (Joi, Zod, express-validator, yup, ajv,
 *      celebrate, typebox, valibot) and no call to a validate/schema/sanitize
 *      helper within the file.
 *
 *   2. route_query_no_validation (warning)
 *      Same for GET routes that use `req.query` or `req.params` without
 *      any validation hint.
 *
 * Suppressions: if the file contains any of: Joi.object, z.object, z.string,
 * body()/query()/param() from express-validator, checkSchema, validate(,
 * ajv.compile, sanitize(, yup.object, or `// validated` annotation anywhere,
 * the whole file is considered protected (crude but avoids excessive false
 * positives in well-structured codebases).
 *
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

// Express mutating routes (POST/PUT/PATCH/DELETE accept bodies)
const MUTATING_ROUTE_RE = /(?:app|router)\s*\.\s*(?:post|put|patch|delete)\s*\(/gi;
// GET routes (for query/params)
const GET_ROUTE_RE      = /(?:app|router)\s*\.\s*get\s*\(/gi;

// Input access patterns
const REQ_BODY_RE  = /\breq\s*\.\s*body\b/;
const REQ_QUERY_RE = /\breq\s*\.\s*(?:query|params)\b/;

// Validation library hints — if any of these appear in the file, suppress all findings
const VALIDATION_HINT_RE = /Joi\.(?:object|string|number|array|boolean|validate)|z\.(?:object|string|number|array|boolean|enum|union|literal|infer)|\bvalidateSchema\b|\bcheckSchema\b|express-validator|\bbody\s*\(\s*['"]|\bquery\s*\(\s*['"]|\bparam\s*\(\s*['"]|\bcheck\s*\(|ajv\.compile|\bnew\s+Ajv\b|yup\.object|\bvalidate\s*\(|\bsanitize\s*\(|\bcelebrate\b|\bvalibot\b|\/\/\s*validated/i;

// Safe annotation suppression per-line
const SAFE_ANNOT_RE = /\/\/\s*(?:safe|no-validate|validated)/i;

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

function scanFile(relPath, src) {
  // If file has any validation library usage, skip all checks for this file
  if (VALIDATION_HINT_RE.test(src)) return [];

  const findings = [];
  const lines    = src.split("\n");

  // Rule 1: POST/PUT/PATCH routes with req.body and no validation
  {
    let m;
    MUTATING_ROUTE_RE.lastIndex = 0;
    while ((m = MUTATING_ROUTE_RE.exec(src)) !== null) {
      const lineNo = lineOf(src, m.index);
      // Extract ~30 lines after the route registration to check for req.body
      const endIdx  = Math.min(src.length, m.index + 2000);
      const snippet = src.slice(m.index, endIdx);
      if (!REQ_BODY_RE.test(snippet)) continue;
      // Check for per-line safe annotation near the route
      const lineStr = lines[lineNo - 1] || "";
      if (SAFE_ANNOT_RE.test(lineStr)) continue;
      findings.push({
        file:     relPath,
        line:     lineNo,
        rule:     "route_body_no_validation",
        severity: "error",
        message:
          `Express route accesses req.body without visible input validation. ` +
          `Unvalidated body data can contain unexpected types, missing required fields, ` +
          `or malicious payloads. Add a validation layer: Joi.object().validate(req.body), ` +
          `Zod schema.parse(req.body), or express-validator body() chains before the handler.`,
      });
    }
  }

  // Rule 2: GET routes with req.query/params and no validation
  {
    let m;
    GET_ROUTE_RE.lastIndex = 0;
    while ((m = GET_ROUTE_RE.exec(src)) !== null) {
      const lineNo = lineOf(src, m.index);
      const endIdx  = Math.min(src.length, m.index + 2000);
      const snippet = src.slice(m.index, endIdx);
      if (!REQ_QUERY_RE.test(snippet)) continue;
      const lineStr = lines[lineNo - 1] || "";
      if (SAFE_ANNOT_RE.test(lineStr)) continue;
      findings.push({
        file:     relPath,
        line:     lineNo,
        rule:     "route_query_no_validation",
        severity: "warning",
        message:
          `Express GET route accesses req.query/params without visible validation. ` +
          `Query parameters are always strings — type coercion bugs (e.g. {id: '99999999999'}) ` +
          `or unexpected keys can cause downstream errors. Validate and sanitize before use.`,
      });
    }
  }

  return findings;
}

function findMissingInputValidation(absPath, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absPath); }
  catch (e) {
    throw new ToolError(
      `find_missing_input_validation: cannot access '${origPath}': ${e.message}`,
      -32602
    );
  }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_missing_input_validation: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_missing_input_validation: extensions must be an array.", -32602);

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

module.exports = { findMissingInputValidation };
