"use strict";
// ── FIND_UNPINNED_DOCKER_BASE_IMAGE — base-image pin-strictness scan ──────
// Distinct from scan_dockerfile_issues: that tool covers general Dockerfile
// hygiene (USER, ADD-vs-COPY, missing tag -> latest). This tool focuses
// solely on *how strictly* each FROM's base image is pinned, for supply-chain
// reproducibility — a rebuild six months from now should pull the exact same
// bytes.
//
// Rules (per FROM instruction, stage-alias references like `FROM builder`
// skipped since they aren't external base images):
//   - missing_tag_or_digest (error) — no tag, no digest -> implicit 'latest'.
//   - explicit_latest_tag (error) — an explicit ':latest' tag, no digest.
//   - bare_major_version_tag (warning) — a tag with no digest that is just
//     digits (`node:18`) or major.minor (`node:18.4`) with no further patch
//     segment, or a bare distro codename (`ubuntu:jammy`) — still mutable,
//     just less so than 'latest'. A tag with 3+ dot-separated numeric
//     segments (`node:18.20.4`) or any digest is treated as sufficiently
//     pinned and not flagged.
//   - unresolvable_dynamic_tag (warning) — the ref contains a `${...}`/`$VAR`
//     build-arg interpolation; pin strictness can't be determined statically,
//     surfaced as a lower-confidence heads-up rather than silently skipped.
//
// Pure text-scan (regex + line-continuation joining), not a Dockerfile
// parser/BuildKit frontend.
const fs = require("fs");
const path = require("path");
const { isIgnored } = require("./roots");
const { ToolError } = require("./errors");

const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;
const DOCKERFILE_NAME_RE = /^Dockerfile(\..+)?$|\.dockerfile$/i;
const FROM_RE = /^FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?\s*$/i;
const CODENAME_TAG_RE = /^[a-zA-Z][a-zA-Z0-9._-]*$/; // non-numeric tag, e.g. 'jammy', 'alpine'
const NUMERIC_SEGMENTS_RE = /^\d+(?:\.\d+)*$/;

function joinContinuations(raw) {
  const rawLines = raw.split(/\r\n|\r|\n/);
  const lines = [];
  let buf = null, startLine = 0;
  for (let i = 0; i < rawLines.length; i++) {
    const ln = rawLines[i];
    const continues = /\\\s*$/.test(ln);
    const stripped = continues ? ln.replace(/\\\s*$/, "").trim() : ln;
    if (buf === null) { buf = stripped; startLine = i + 1; }
    else { buf += " " + stripped; }
    if (continues) continue;
    lines.push({ text: buf, line: startLine });
    buf = null;
  }
  if (buf !== null) lines.push({ text: buf, line: startLine });
  return lines;
}

function parseImageRef(ref) {
  const atIdx = ref.indexOf("@");
  const digest = atIdx !== -1 ? ref.slice(atIdx + 1) : null;
  const beforeDigest = atIdx !== -1 ? ref.slice(0, atIdx) : ref;
  const lastSlash = beforeDigest.lastIndexOf("/");
  const lastColon = beforeDigest.lastIndexOf(":");
  const tag = lastColon > lastSlash ? beforeDigest.slice(lastColon + 1) : null;
  const image = lastColon > lastSlash ? beforeDigest.slice(0, lastColon) : beforeDigest;
  return { image, tag, digest };
}

function collectDockerfiles(absDir, relBase = "") {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); }
  catch (_) { return out; }
  for (const ent of entries) {
    if (isIgnored(ent.name)) continue;
    const abs = path.join(absDir, ent.name);
    const rel = relBase ? relBase + "/" + ent.name : ent.name;
    if (ent.isDirectory()) out.push(...collectDockerfiles(abs, rel));
    else if (ent.isFile() && DOCKERFILE_NAME_RE.test(ent.name)) out.push(rel);
  }
  return out;
}

function classifyTag(tag, digest) {
  if (digest) return null; // digest pin always sufficient regardless of tag
  if (!tag) return { rule: "missing_tag_or_digest", severity: "error",
    message: "No tag or digest — resolves to the mutable 'latest' tag, hurting build reproducibility." };
  if (tag === "latest") return { rule: "explicit_latest_tag", severity: "error",
    message: "Explicitly pins the mutable ':latest' tag — has no reproducibility benefit over omitting the tag." };
  if (NUMERIC_SEGMENTS_RE.test(tag)) {
    const segments = tag.split(".").length;
    if (segments < 3) return { rule: "bare_major_version_tag", severity: "warning",
      message: `Tag '${tag}' pins only ${segments} version segment${segments === 1 ? "" : "s"} — the maintainer can still push a new image under this tag. Pin a full patch version or a digest for a fully reproducible build.` };
    return null;
  }
  if (CODENAME_TAG_RE.test(tag)) return { rule: "bare_major_version_tag", severity: "warning",
    message: `Tag '${tag}' is a rolling codename/alias, not a fixed version — the image behind it can change. Pin a digest for a fully reproducible build.` };
  return null;
}

/**
 * @param {string} absPath  Absolute, jail-validated file or directory to scan.
 * @param {string} origPath Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {number} [opts.maxResults]
 * @returns {{path, filesScanned, findingsCount, errorCount, warningCount, truncated, findings}}
 */
function findUnpinnedDockerBaseImage(absPath, origPath, opts = {}) {
  let stat;
  try { stat = fs.statSync(absPath); }
  catch (e) { throw new ToolError(`find_unpinned_docker_base_image: cannot access '${origPath}': ${e.message}`, -32602); }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("find_unpinned_docker_base_image: max_results must be a number.", -32602);

  const maxResults = Math.min(Math.max(1, Math.trunc(opts.maxResults ?? DEFAULT_MAX_RESULTS)), HARD_MAX_RESULTS);

  const files = stat.isDirectory() ? collectDockerfiles(absPath) : [path.basename(absPath)];
  const baseDir = stat.isDirectory() ? absPath : path.dirname(absPath);

  const findings = [];
  let filesScanned = 0;

  for (const rel of files) {
    let raw;
    try { raw = fs.readFileSync(path.join(baseDir, rel), "utf8"); }
    catch (_) { continue; }
    filesScanned++;

    const lines = joinContinuations(raw).filter(l => l.text.trim() !== "" && !l.text.trim().startsWith("#"));
    const stageAliases = new Set();

    for (const { text, line } of lines) {
      const m = FROM_RE.exec(text.trim());
      if (!m) continue;
      const ref = m[1];
      const alias = m[2] || null;
      if (alias) stageAliases.add(alias);

      if (stageAliases.has(ref)) continue; // FROM <earlier-stage-alias>, not an external image

      if (/\$\{?[A-Za-z_]/.test(ref)) {
        findings.push({ file: rel, line, rule: "unresolvable_dynamic_tag", severity: "warning",
          message: `Base image ref '${ref}' contains a build-arg interpolation — pin strictness cannot be determined statically.` });
        continue;
      }

      const { tag, digest } = parseImageRef(ref);
      const verdict = classifyTag(tag, digest);
      if (verdict) findings.push({ file: rel, line, rule: verdict.rule, severity: verdict.severity, message: verdict.message });
    }
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const truncated = findings.length > maxResults;
  const errorCount = findings.filter(f => f.severity === "error").length;
  const warningCount = findings.filter(f => f.severity === "warning").length;

  return {
    path: origPath,
    filesScanned,
    findingsCount: findings.length,
    errorCount,
    warningCount,
    truncated,
    findings: findings.slice(0, maxResults),
  };
}

module.exports = { findUnpinnedDockerBaseImage };
