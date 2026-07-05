"use strict";
// ── FIND_UNPINNED_GITHUB_ACTIONS — supply-chain pin audit for workflows ─────
// Scans .github/workflows/*.yml|*.yaml for `uses: owner/action@ref` lines and
// flags refs that are not pinned to a full 40-hex-char commit SHA. Floating
// tags (e.g. @v4) can be moved by the action owner; floating branches
// (@main/@master) or @latest are the highest-risk (mutable at any time,
// classic supply-chain attack vector — see the 2024 tj-actions/changed-files
// incident). Pure line-oriented text scan, NOT a YAML parser: does not
// resolve YAML anchors/aliases, reusable-workflow `uses:` targets pointing at
// another repo's .github/workflows/*.yml file are scanned the same way as
// action refs. Local actions (`./path`) and Docker refs (`docker://...`) are
// out of scope (different risk model, no @ref versioning) and skipped.
// Zero-dependency, read-only.
const fs = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_EXTENSIONS = [".yml", ".yaml"];
const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;
const SHA_RE = /^[0-9a-f]{40}$/i;
const TAG_RE = /^v?\d+(\.\d+){0,2}$/i;
const USES_RE = /^\s*(?:-\s*)?uses:\s*([^\s#]+)/;

function looksBinary(buf) {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}

function collectFiles(absDir, extensions, relBase = "") {
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

function classifyRef(action, ref) {
  if (!ref) return { rule: "missing_ref", severity: "error", message: `'${action}' has no @ref at all — resolves to whatever the default branch currently points to.` };
  if (SHA_RE.test(ref)) return null; // pinned, no issue
  if (ref === "main" || ref === "master" || ref === "latest" || ref === "HEAD") {
    return { rule: "mutable_branch_ref", severity: "error", message: `'${action}@${ref}' floats on a mutable branch/alias — highest supply-chain risk.` };
  }
  if (TAG_RE.test(ref)) {
    return { rule: "tag_not_sha", severity: "warning", message: `'${action}@${ref}' is a tag, which can be moved by the action owner — pin to the tag's full commit SHA instead.` };
  }
  return { rule: "unrecognized_ref", severity: "info", message: `'${action}@${ref}' is not a recognizable tag or full commit SHA — verify it's intentional.` };
}

function scanFileForUnpinnedActions(absPath, relPath) {
  let buf;
  try { buf = fs.readFileSync(absPath); }
  catch (e) { return { file: relPath, error: `cannot read: ${e.message}`, issues: [], actionsFound: 0 }; }
  if (looksBinary(buf)) return { file: relPath, skipped: true, issues: [], actionsFound: 0 };
  const lines = buf.toString("utf8").split(/\r?\n/);
  const issues = [];
  let actionsFound = 0;
  try {
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(USES_RE);
      if (!m) continue;
      const target = m[1].replace(/^["']|["']$/g, "");
      if (target.startsWith("./") || target.startsWith("docker://")) continue;
      actionsFound++;
      const at = target.lastIndexOf("@");
      const action = at === -1 ? target : target.slice(0, at);
      const ref = at === -1 ? "" : target.slice(at + 1);
      const issue = classifyRef(action, ref);
      if (issue) issues.push({ file: relPath, line: i + 1, action, ref: ref || null, ...issue });
    }
    return { file: relPath, error: null, issues, actionsFound };
  } catch (e) {
    return { file: relPath, error: e.message, issues: [], actionsFound };
  }
}

/**
 * @param {string} absDir   Absolute, jail-validated file or directory to scan.
 * @param {string} origPath Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {string[]} [opts.extensions]
 * @param {number}   [opts.maxResults]
 * @returns {{path, filesScanned, filesWithErrors, actionsFound, pinnedCount, issueCount, errorCount, warningCount, truncated, issues, errors}}
 */
function scanUnpinnedActions(absDir, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absDir); }
  catch (e) { throw new ToolError(`find_unpinned_github_actions: cannot access '${origPath}': ${e.message}`, -32602); }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_unpinned_github_actions: max_results must be a number.", -32602);
  if (opts.extensions !== undefined && !Array.isArray(opts.extensions))
    throw new ToolError("find_unpinned_github_actions: extensions must be an array of strings.", -32602);

  const extensions = Array.isArray(opts.extensions) && opts.extensions.length ? opts.extensions : DEFAULT_EXTENSIONS;
  const maxResults = Math.min(Math.max(1, Math.trunc(opts.maxResults ?? DEFAULT_MAX_RESULTS)), HARD_MAX_RESULTS);

  const files = stat.isDirectory() ? collectFiles(absDir, extensions) : [path.basename(absDir)];
  const baseDir = stat.isDirectory() ? absDir : path.dirname(absDir);

  const allIssues = [];
  const errors = [];
  let filesScanned = 0;
  let actionsFound = 0;

  for (const rel of files) {
    const abs = path.join(baseDir, rel);
    const result = scanFileForUnpinnedActions(abs, rel);
    if (result.skipped) continue;
    filesScanned++;
    actionsFound += result.actionsFound;
    if (result.error) { errors.push({ file: rel, error: result.error }); continue; }
    for (const issue of result.issues) allIssues.push(issue);
  }

  allIssues.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const truncated = allIssues.length > maxResults;
  const finalIssues = allIssues.slice(0, maxResults);

  return {
    path: origPath,
    filesScanned,
    filesWithErrors: errors.length,
    actionsFound,
    pinnedCount: actionsFound - allIssues.length,
    issueCount: allIssues.length,
    errorCount: finalIssues.filter(i => i.severity === "error").length,
    warningCount: finalIssues.filter(i => i.severity === "warning").length,
    truncated,
    issues: finalIssues,
    errors,
  };
}

module.exports = { scanUnpinnedActions };
