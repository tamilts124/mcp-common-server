"use strict";
// ── SCAN_DOCKERFILE_ISSUES — static Dockerfile best-practice audit ───────
// Pure text-scan, no docker CLI/daemon needed. Handles line continuations
// (trailing '\'), '#'-comments (but not the leading '# syntax=' directive,
// which is preserved as a comment — not parsed as an instruction), and
// multi-stage builds (`FROM ... AS name`, later `FROM name` stage refs).
// Checks:
//   - each FROM's tag: missing tag/digest (implicit 'latest', error) vs
//     an explicit ':latest' tag (warning) vs a pinned tag/digest (clean)
//   - final stage has no USER instruction before its last instruction
//     (warning — container likely runs as root at runtime)
//   - ADD used where the source is a local path (not an http(s):// URL) —
//     COPY is the recommended instruction for local sources; ADD's extra
//     tar-auto-extract/URL-fetch behavior is easy to trigger by accident

const fs = require("fs");
const { ToolError } = require("./errors");

const FROM_RE = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?\s*$/i;
const USER_RE = /^USER\s+\S/i;
const ADD_RE = /^ADD\s+(?:\[.*\]|(\S+))/i;

function joinContinuations(raw) {
  const rawLines = raw.split(/\r\n|\r|\n/);
  const lines = []; // { text, line } after stripping continuations
  let buf = null, startLine = 0;
  for (let i = 0; i < rawLines.length; i++) {
    const ln = rawLines[i];
    if (buf === null) { buf = ln; startLine = i + 1; }
    else { buf += " " + ln.replace(/\\\s*$/, "").trim(); }
    if (/\\\s*$/.test(ln)) continue; // continues to next line
    lines.push({ text: buf, line: startLine });
    buf = null;
  }
  if (buf !== null) lines.push({ text: buf, line: startLine });
  return lines;
}

function parseImageRef(ref) {
  // name[:tag][@digest] — digest (@sha256:...) takes precedence over tag for pin detection.
  const atIdx = ref.indexOf("@");
  const digest = atIdx !== -1 ? ref.slice(atIdx + 1) : null;
  const beforeDigest = atIdx !== -1 ? ref.slice(0, atIdx) : ref;
  // Tag is the last ':' segment that isn't part of a registry host:port prefix.
  const lastSlash = beforeDigest.lastIndexOf("/");
  const lastColon = beforeDigest.lastIndexOf(":");
  const tag = lastColon > lastSlash ? beforeDigest.slice(lastColon + 1) : null;
  const image = lastColon > lastSlash ? beforeDigest.slice(0, lastColon) : beforeDigest;
  return { image, tag, digest };
}

/**
 * @param {string} filePath Absolute path to the Dockerfile.
 * @param {string} origPath Client-relative path echoed in the result.
 * @returns {{path, stageCount, stages, hasUserInFinalStage, addLocalCount, errorCount, warningCount, issues}}
 */
function scanDockerfileIssues(filePath, origPath) {
  let raw;
  try { raw = fs.readFileSync(filePath, "utf8"); }
  catch (e) { throw new ToolError(`scan_dockerfile_issues: cannot read '${origPath}': ${e.message}`, -32602); }

  const lines = joinContinuations(raw).filter(l => l.text.trim() !== "" && !l.text.trim().startsWith("#"));

  const issues = [];
  const stages = []; // { index, fromLine, ref, alias, image, tag, digest }
  let addLocalCount = 0;
  let lastUserLine = -1;
  let lastFromIndex = -1;

  for (const { text, line } of lines) {
    const trimmed = text.trim();
    const fromM = FROM_RE.exec(trimmed);
    if (fromM) {
      const ref = fromM[1];
      const alias = fromM[2] || null;
      const { image, tag, digest } = parseImageRef(ref);
      const stage = { index: stages.length, fromLine: line, ref, alias, image, tag, digest };
      stages.push(stage);
      lastFromIndex = stages.length - 1;
      lastUserLine = -1; // USER tracking resets per stage

      if (!digest && !tag) {
        issues.push({ severity: "error", line, instruction: "FROM", message: `Stage ${stage.index} ('${ref}') has no tag or digest — resolves to the mutable 'latest' tag, hurting reproducibility.` });
      } else if (!digest && tag === "latest") {
        issues.push({ severity: "warning", line, instruction: "FROM", message: `Stage ${stage.index} ('${ref}') explicitly pins the mutable ':latest' tag — consider a specific version or digest.` });
      }
      continue;
    }
    if (USER_RE.test(trimmed)) { lastUserLine = line; continue; }
    const addM = ADD_RE.exec(trimmed);
    if (addM) {
      const src = addM[1];
      if (src && !/^https?:\/\//i.test(src)) {
        addLocalCount++;
        issues.push({ severity: "warning", line, instruction: "ADD", message: `ADD used for a local source ('${src}') — prefer COPY unless ADD's tar-auto-extract/URL-fetch behavior is intentional.` });
      }
    }
  }

  const hasUserInFinalStage = lastFromIndex !== -1 && lastUserLine !== -1;
  if (lastFromIndex !== -1 && !hasUserInFinalStage) {
    issues.push({ severity: "warning", line: stages[lastFromIndex].fromLine, instruction: "USER", message: `Final stage (index ${lastFromIndex}) has no USER instruction — the container will run as root at runtime.` });
  }
  if (stages.length === 0) {
    issues.push({ severity: "error", line: 0, instruction: "FROM", message: "No FROM instruction found — not a valid Dockerfile." });
  }

  const errorCount = issues.filter(i => i.severity === "error").length;
  const warningCount = issues.filter(i => i.severity === "warning").length;

  return {
    path: origPath,
    stageCount: stages.length,
    stages,
    hasUserInFinalStage,
    addLocalCount,
    errorCount,
    warningCount,
    issues,
  };
}

module.exports = { scanDockerfileIssues };
