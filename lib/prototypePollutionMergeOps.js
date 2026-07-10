"use strict";
/**
 * find_prototype_pollution_via_merge
 *
 * Scans JS/TS files for prototype pollution vectors where deep-merge or
 * recursive object-assign operations are performed on objects sourced from
 * user-controlled input without sanitizing __proto__, constructor, or
 * prototype keys first.
 *
 * Three rules:
 *
 *   1. deep_merge_with_user_input (error)
 *      A deep-merge call (_.merge, lodash.merge, deepmerge, deepMerge,
 *      Object.assign in a loop, jQuery.extend(true,...)) whose source argument
 *      contains user-controlled input (req.body/query/params/headers or
 *      commonly-named input identifiers: body/input/data/payload/props/options)
 *      without a __proto__ / constructor / prototype key-sanitization guard
 *      visible on a nearby line.
 *
 *   2. recursive_assign_with_user_input (error)
 *      A custom recursive merge/assign function (named mergeDeep, deepAssign,
 *      deepExtend, recursiveMerge, extend) called with user-controlled input
 *      and no sanitization guard.
 *
 *   3. object_assign_spread_no_sanitize (warning)
 *      Object.assign({}, userInput) or spread {...userInput} where userInput
 *      comes from req.* — shallow merge doesn't pollute prototype itself but
 *      creates unexpected key collisions if the target already has those keys.
 *
 * Suppressions: same-line // safe, // sanitized, // no-pollution annotation,
 * or presence of __proto__ / hasOwnProperty / Object.create(null) / sanitize
 * in a ±5-line window.
 *
 * Returns { path, filesScanned, findingsCount, errorCount, warningCount,
 *           truncated, findings: [{file,line,rule,severity,message}] }.
 * Always available — does not require MCP_ALLOW_EXEC.
 */
const fs   = require("fs");
const path = require("path");
const { isIgnored }  = require("./roots");
const { ToolError }  = require("./errors");

const DEFAULT_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"];
const DEFAULT_MAX        = 500;
const HARD_MAX           = 5000;

// Deep-merge library calls
const DEEP_MERGE_RE = /\b(?:_\.merge|lodash\.merge|deepmerge|deepMerge|merge(?:Deep|With)?|jQuery\.extend\s*\(\s*true)\s*\(/i;

// Custom recursive merge function names
const RECURSIVE_MERGE_RE = /\b(?:mergeDeep|deepAssign|deepExtend|recursiveMerge|extend)\s*\(/;

// Object.assign
const OBJECT_ASSIGN_RE = /\bObject\.assign\s*\(/;

// Spread with user input: {...req.body}, {...body}, {...input}
const SPREAD_USER_RE = /\{\s*\.\.\.\s*(?:req\s*\.\s*(?:body|query|params|headers)|body|input|data|payload|props|options)\b/;

// User input identifiers
const USER_INPUT_RE = /\breq\s*\.\s*(?:body|query|params|headers)\b|\b(?:body|input|data|payload|props|options)\b/;

// Sanitization guard
const SANITIZE_GUARD_RE = /__proto__|hasOwnProperty|Object\.create\s*\(\s*null\s*\)|sanitize|allowedKeys|ALLOWED/;

// Safe annotations
const SAFE_ANNOT_RE = /\/\/\s*(?:safe|sanitized|no-pollution|nosec)/i;

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

function windowHasGuard(lines, i) {
  const start = Math.max(0, i - 5);
  const end   = Math.min(lines.length, i + 6);
  return lines.slice(start, end).some(l => SANITIZE_GUARD_RE.test(l));
}

function scanFile(relPath, src) {
  const findings = [];
  const lines    = src.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line   = lines[i];
    const lineNo = i + 1;

    if (SAFE_ANNOT_RE.test(line)) continue;

    // Rule 1: deep merge library with user input
    if (DEEP_MERGE_RE.test(line) && USER_INPUT_RE.test(line)) {
      if (!windowHasGuard(lines, i)) {
        findings.push({
          file: relPath, line: lineNo,
          rule: "deep_merge_with_user_input", severity: "error",
          message:
            `Deep-merge called with user-controlled input and no __proto__/` +
            `constructor/prototype key sanitization. Attacker-controlled keys ` +
            `like "__proto__", "constructor", or "prototype" in the source object ` +
            `pollute Object.prototype, affecting every object in the process. ` +
            `Sanitize: delete source['__proto__']; delete source.constructor; ` +
            `or use Object.create(null) as the merge target, or a library with ` +
            `built-in prototype pollution protection (e.g. deepmerge >=4.3).`,
        });
      }
    }

    // Rule 2: custom recursive merge with user input
    if (RECURSIVE_MERGE_RE.test(line) && USER_INPUT_RE.test(line)) {
      if (!windowHasGuard(lines, i)) {
        findings.push({
          file: relPath, line: lineNo,
          rule: "recursive_assign_with_user_input", severity: "error",
          message:
            `Custom deep-assign/extend function called with user-controlled ` +
            `input without prototype key sanitization. If the recursive merge ` +
            `walks all enumerable keys it will copy __proto__ / constructor / ` +
            `prototype onto the target, polluting Object.prototype. Add a ` +
            `key guard: if (key === '__proto__' || key === 'constructor' || ` +
            `key === 'prototype') continue; inside every recursive step.`,
        });
      }
    }

    // Rule 3: Object.assign or spread with req.* (shallow — lower severity)
    if (!DEEP_MERGE_RE.test(line) && !RECURSIVE_MERGE_RE.test(line)) {
      const hasSpread = SPREAD_USER_RE.test(line);
      const hasAssign = OBJECT_ASSIGN_RE.test(line) && /req\s*\.\s*(?:body|query|params|headers)/.test(line);
      if ((hasSpread || hasAssign) && !windowHasGuard(lines, i)) {
        findings.push({
          file: relPath, line: lineNo,
          rule: "object_assign_spread_no_sanitize", severity: "warning",
          message:
            `Shallow merge/spread of user input without key sanitization. ` +
            `While Object.assign/spread doesn't recursively pollute __proto__, ` +
            `it copies all enumerable own properties including any unexpected ` +
            `keys the client sends. Consider allowlisting the accepted keys ` +
            `explicitly rather than spreading the whole input object.`,
        });
      }
    }
  }

  return findings;
}

function findPrototypePollutionViaMerge(absPath, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absPath); }
  catch (e) {
    throw new ToolError(
      `find_prototype_pollution_via_merge: cannot access '${origPath}': ${e.message}`,
      -32602
    );
  }

  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_prototype_pollution_via_merge: extensions must be an array.", -32602);
  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_prototype_pollution_via_merge: max_results must be a number.", -32602);

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
    errorCount,
    warningCount,
    truncated,
    findings: findings.slice(0, maxResults),
  };
}

module.exports = { findPrototypePollutionViaMerge };
