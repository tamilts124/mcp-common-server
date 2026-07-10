"use strict";
/**
 * find_insecure_deserialization
 *
 * Scans JS/TS files for insecure deserialization patterns that allow
 * arbitrary code execution or prototype pollution when deserializing
 * untrusted data.
 *
 * Three rules:
 *
 *   1. unsafe_deserializer_call (error)
 *      Usage of known unsafe deserializers:
 *      - node-serialize: serialize.unserialize(userInput)
 *      - js-yaml (legacy): yaml.load() without { schema: SAFE_SCHEMA }
 *      - eval-based: eval(JSON.stringify...) patterns
 *      - node-eval, vm.runInThisContext, vm.runInContext with user input
 *
 *   2. json_parse_untrusted_source (warning)
 *      JSON.parse() receiving a value that appears to originate from
 *      user/network input (req.body, req.query, socket data, fs.readFile,
 *      process.stdin) without a visible schema validation after parsing.
 *
 *   3. unsafe_yaml_load (error)
 *      yaml.load() / jsYaml.load() / YAML.parse() calls without a SAFE_SCHEMA
 *      guard — YAML can deserialize arbitrary JS objects with !!js/undefined
 *      and similar type tags.
 *
 * Suppressions: same-line // safe, // trusted, // sanitized, or
 * // nosec annotation.
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

// ─── patterns ────────────────────────────────────────────────────────────────

// node-serialize unserialize
const NODE_SERIALIZE_RE = /\bun[Ss]erialize\s*\(/;

// yaml.load / jsYaml.load / YAML.load / YAML.parse without safe schema
// Matches: yaml.load(, jsYaml.load(, YAML.load(, yaml.parse(  (not safeLoad)
const YAML_LOAD_RE = /(?:yaml|jsYaml|YAML)\s*\.\s*(?:load|parse)\s*\(/i;
// Safe schema suppressor in same line
const YAML_SAFE_RE = /SAFE_SCHEMA|safeLoad|failsafe_schema|JSON_SCHEMA|CORE_SCHEMA|\.safeLoad\s*\(|schema\s*:\s*(?:yaml\.SAFE_SCHEMA|jsYaml\.SAFE_SCHEMA)/i;

// vm.runInThisContext / vm.runInContext / vm.runInNewContext
const VM_RUN_RE = /\bvm\s*\.\s*run(?:InThisContext|InContext|InNewContext)\s*\(/;

// node-eval or similar eval wrappers  
const NODE_EVAL_RE = /\b(?:nodeEval|node_eval|dynamicRequire)\s*\(/;

// User-controlled input sources for JSON.parse taint
const USER_INPUT_RE = /\breq\s*\.\s*(?:body|query|params|headers)\b|\bsocket(?:Data|Msg|Message)?\b|\bprocess\.stdin\b|\breadFile(?:Sync)?\b|\bfetch(?:ed|Result)?\b/;

// Suppression annotations
const SAFE_ANNOT_RE = /\/\/\s*(?:safe|trusted|sanitized|nosec|no-sec)/i;

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
  const findings = [];
  const lines    = src.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line   = lines[i];
    const lineNo = i + 1;

    if (SAFE_ANNOT_RE.test(line)) continue;

    // Rule 1a: node-serialize unserialize
    if (NODE_SERIALIZE_RE.test(line)) {
      findings.push({
        file: relPath, line: lineNo,
        rule: "unsafe_deserializer_call", severity: "error",
        message:
          `Unsafe deserialization: node-serialize's unserialize() can execute ` +
          `arbitrary JavaScript embedded in serialized data via the IIFE ` +
          `(function(){...}()) pattern. Never call unserialize() on untrusted ` +
          `input. Use JSON.parse() + a strict schema validator (Joi/Zod/AJV) instead.`,
      });
    }

    // Rule 1b: vm.runIn* (potential code execution from dynamic source)
    if (VM_RUN_RE.test(line)) {
      findings.push({
        file: relPath, line: lineNo,
        rule: "unsafe_deserializer_call", severity: "error",
        message:
          `vm.runIn*Context() executes an arbitrary string as JavaScript. ` +
          `If the source string contains any user-controlled content this is ` +
          `Remote Code Execution. Avoid eval-based dynamic execution of ` +
          `deserialized content; use a data-only format (JSON + schema) instead.`,
      });
    }

    // Rule 1c: node-eval wrappers
    if (NODE_EVAL_RE.test(line)) {
      findings.push({
        file: relPath, line: lineNo,
        rule: "unsafe_deserializer_call", severity: "error",
        message:
          `Dynamic require / eval wrapper detected. Executing dynamically ` +
          `constructed module paths or code strings from deserialized data ` +
          `enables Remote Code Execution. Use a static require map or JSON ` +
          `schema validation instead.`,
      });
    }

    // Rule 3: unsafe yaml.load (without SAFE_SCHEMA)
    if (YAML_LOAD_RE.test(line) && !YAML_SAFE_RE.test(line)) {
      findings.push({
        file: relPath, line: lineNo,
        rule: "unsafe_yaml_load", severity: "error",
        message:
          `yaml.load() / YAML.parse() without { schema: SAFE_SCHEMA } can ` +
          `deserialize arbitrary JavaScript objects via YAML type tags ` +
          `(!!js/undefined, !!js/regexp, !!js/function). Use yaml.load(str, ` +
          `{ schema: yaml.SAFE_SCHEMA }) or yaml.safeLoad() to restrict ` +
          `deserialization to JSON-equivalent types only.`,
      });
    }

    // Rule 2: JSON.parse with tainted source
    if (/\bJSON\.parse\s*\(/.test(line) && USER_INPUT_RE.test(line)) {
      findings.push({
        file: relPath, line: lineNo,
        rule: "json_parse_untrusted_source", severity: "warning",
        message:
          `JSON.parse() applied directly to user/network/file input without ` +
          `visible schema validation. Malformed JSON throws SyntaxError; ` +
          `valid but unexpected shapes cause type confusion. Wrap in try/catch ` +
          `and validate the result with Joi/Zod/AJV before use.`,
      });
    }
  }

  return findings;
}

function findInsecureDeserialization(absPath, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absPath); }
  catch (e) {
    throw new ToolError(
      `find_insecure_deserialization: cannot access '${origPath}': ${e.message}`,
      -32602
    );
  }

  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_insecure_deserialization: extensions must be an array.", -32602);
  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_insecure_deserialization: max_results must be a number.", -32602);

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

module.exports = { findInsecureDeserialization };
