"use strict";
// ── FIND_HARDCODED_CREDENTIALS_IN_CONFIG — config-file credential audit ───
// Complements scan_secrets (which regex-scans arbitrary text/source files
// for secret *shapes* like AWS keys/JWTs/PEM headers) with a structure-aware
// scan of config files specifically: parses JSON/YAML into a real object
// tree (reusing yamlOps.js's parseYaml) or .env files into key=value pairs,
// then flags any key whose NAME implies a credential (password/secret/
// token/api key/etc.) whose VALUE is a plausible real secret rather than an
// env-var placeholder/template reference (`${DB_PASS}`, `$DB_PASS`,
// `%DB_PASS%`, `<PLACEHOLDER>`, empty string, or common non-secret
// filler words like "changeme"/"example"/"xxx"/"your-api-key-here").
//
// Read-only, zero-dependency. Matched values are REDACTED in the output
// (first 2 + last 2 chars kept, middle masked, same spirit as scan_secrets'
// redact()) so the tool itself never leaks the credential it finds.
//
//   CAVEATS:
//     - a structural parser catches nested YAML/JSON credentials scan_secrets'
//       line-regex approach can miss (e.g. multi-line values, keys nested
//       several levels deep) — but only for the 3 formats explicitly
//       supported (JSON, YAML, .env-shaped KEY=VALUE). Other config formats
//       (TOML, INI, XML) are out of scope.
//     - placeholder detection is a fixed heuristic list, not exhaustive —
//       an unusual templating syntax not in PLACEHOLDER_RE will still be
//       flagged as a false positive, to be reviewed not blindly trusted.
const fs = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");
const { parseYaml } = require("./yamlOps");

const DEFAULT_EXTENSIONS = [".json", ".yml", ".yaml", ".env"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;

const CRED_KEY_RE = /(password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?key)/i;

const PLACEHOLDER_RE = [
  /^\$\{[^}]+\}$/,           // ${DB_PASS}
  /^\$[A-Za-z_][A-Za-z0-9_]*$/, // $DB_PASS
  /^%[^%]+%$/,               // %DB_PASS%
  /^<[^>]+>$/,               // <PLACEHOLDER>
  /^\{\{[^}]+\}\}$/,         // {{ .Values.dbPass }} (Helm-style)
];
const PLACEHOLDER_WORDS = /^(changeme|change_me|change-me|example|xxx+|todo|fixme|your[-_]?.*here|placeholder|password|secret|redacted|dummy|fake|test)$/i;

function isPlaceholderValue(v) {
  if (v === "" || v === null || v === undefined) return true;
  const s = String(v).trim();
  if (s.length === 0) return true;
  if (PLACEHOLDER_RE.some(re => re.test(s))) return true;
  if (PLACEHOLDER_WORDS.test(s)) return true;
  if (s.length < 4) return true; // too short to be a real credential
  return false;
}

function redact(s) {
  s = String(s);
  if (s.length <= 6) return s.slice(0, 1) + "***";
  return s.slice(0, 2) + "***" + s.slice(-2);
}

function collectFiles(absDir, extensions, includeEnvAlways, relBase = "") {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); }
  catch (_) { return out; }
  for (const ent of entries) {
    if (isIgnored(ent.name)) continue;
    const abs = path.join(absDir, ent.name);
    const rel = relBase ? relBase + "/" + ent.name : ent.name;
    if (ent.isDirectory()) out.push(...collectFiles(abs, extensions, includeEnvAlways, rel));
    else if (ent.isFile() && (extensions.some(e => ent.name.toLowerCase().endsWith(e)) || (includeEnvAlways && /\.env(\..+)?$/i.test(ent.name))))
      out.push(rel);
  }
  return out;
}

function detectFormat(filename) {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "yaml";
  if (/\.env(\..+)?$/.test(lower) || lower === ".env") return "env";
  return null;
}

function walkObject(obj, keyPath, cb) {
  if (obj === null || typeof obj !== "object") return;
  for (const [k, v] of Object.entries(obj)) {
    const nextPath = keyPath ? keyPath + "." + k : k;
    if (v !== null && typeof v === "object") walkObject(v, nextPath, cb);
    else cb(nextPath, k, v);
  }
}

function parseEnvFile(text) {
  const pairs = [];
  for (const rawLine of text.split(/\r\n|\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const noExport = line.startsWith("export ") ? line.slice(7) : line;
    const eqIdx = noExport.indexOf("=");
    if (eqIdx === -1) continue;
    const key = noExport.slice(0, eqIdx).trim();
    let value = noExport.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      value = value.slice(1, -1);
    pairs.push([key, value]);
  }
  return pairs;
}

function scanFile(relPath, absPath, findings) {
  let raw;
  try { raw = fs.readFileSync(absPath, "utf8"); }
  catch (_) { return { error: null }; } // unreadable, skip silently

  const format = detectFormat(path.basename(absPath));
  if (!format) return { error: null };

  if (format === "env") {
    for (const [key, value] of parseEnvFile(raw)) {
      if (CRED_KEY_RE.test(key) && !isPlaceholderValue(value)) {
        findings.push({ file: relPath, key, value: redact(value) });
      }
    }
    return { error: null };
  }

  let doc;
  try {
    doc = format === "json" ? JSON.parse(raw) : parseYaml(raw);
  } catch (e) {
    return { error: e.message };
  }
  walkObject(doc, "", (keyPath, lastKey, value) => {
    if (typeof value !== "string") return;
    if (CRED_KEY_RE.test(lastKey) && !isPlaceholderValue(value)) {
      findings.push({ file: relPath, key: keyPath, value: redact(value) });
    }
  });
  return { error: null };
}

/**
 * @param {string} absTarget  Absolute, jail-validated file or directory.
 * @param {string} origPath   Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {string[]} [opts.extensions]
 * @param {number}   [opts.maxResults]
 * @returns {{path, filesScanned, findingsCount, truncated, findings, parseErrors}}
 */
function findHardcodedCredentialsInConfig(absTarget, origPath, opts = {}) {
  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_hardcoded_credentials_in_config: max_results must be a number.", -32602);
  const maxResults = Math.min(Math.max(1, Math.trunc(opts.maxResults ?? DEFAULT_MAX_RESULTS)), HARD_MAX_RESULTS);
  const usingDefaults = !(Array.isArray(opts.extensions) && opts.extensions.length);
  const extensions = usingDefaults ? DEFAULT_EXTENSIONS : opts.extensions;

  const stat = fs.statSync(absTarget);
  const isDirectory = stat.isDirectory();

  let files;
  if (isDirectory) {
    files = collectFiles(absTarget, extensions, usingDefaults);
  } else {
    if (!detectFormat(path.basename(absTarget)))
      throw new ToolError(`find_hardcoded_credentials_in_config: '${origPath}' is not a recognized config format (.json/.yml/.yaml/.env).`, -32602);
    files = [path.basename(absTarget)];
  }

  const findings = [];
  const parseErrors = [];
  for (const rel of files) {
    const abs = isDirectory ? path.join(absTarget, rel) : absTarget;
    const { error } = scanFile(rel, abs, findings);
    if (error) parseErrors.push({ file: rel, error });
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.key.localeCompare(b.key));
  const truncated = findings.length > maxResults;

  return {
    path: origPath,
    filesScanned: files.length,
    findingsCount: findings.length,
    truncated,
    findings: findings.slice(0, maxResults),
    parseErrors,
  };
}

module.exports = { findHardcodedCredentialsInConfig };
