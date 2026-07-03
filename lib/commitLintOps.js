"use strict";
// ── GIT_COMMIT_MESSAGE_LINT — validate commit messages against common
// conventions ──────────────────────────────────────────────────────────────
// Lints a literal message string, or the message of an existing commit
// (via `git log -1 --pretty=%B <ref>`). Pure text-rule linter, no network,
// no external deps. The ref-lookup path uses the same gitExec/assertSafeArg
// pattern as the other read-only git_* tools.

const { gitExec, assertSafeArg } = require("./gitOpsHelpers");
const { ToolError } = require("./errors");

const DEFAULT_MAX_SUBJECT = 72;
const CONVENTIONAL_TYPES = ["feat", "fix", "docs", "style", "refactor", "perf", "test", "chore", "build", "ci", "revert"];
const CONVENTIONAL_RE = new RegExp(`^(${CONVENTIONAL_TYPES.join("|")})(\\([\\w.\\-/]+\\))?(!)?: .+`);

/**
 * Lint a raw commit message string against common conventions.
 * @param {string} message
 * @param {object} [opts]
 * @param {number} [opts.max_subject_length] default 72
 * @param {boolean} [opts.require_type] require a Conventional Commits type prefix (default false)
 * @returns {{message:string, subject:string, bodyLines:string[], issues:Array<{rule:string,severity:string,message:string}>, errorCount:number, warningCount:number, valid:boolean}}
 */
function lintMessage(message, opts = {}) {
  if (typeof message !== "string") {
    throw new ToolError("git_commit_message_lint: 'message' must be a string.", -32602);
  }
  const maxSubject = Number.isFinite(opts.max_subject_length) && opts.max_subject_length > 0
    ? Math.floor(opts.max_subject_length) : DEFAULT_MAX_SUBJECT;
  const requireType = !!opts.require_type;

  const issues = [];
  const push = (rule, severity, msg) => issues.push({ rule, severity, message: msg });

  const trimmedTrailing = message.replace(/[\r\n]+$/, "");
  const lines = trimmedTrailing.split(/\r\n|\r|\n/);
  const subject = lines[0] || "";
  const bodyLines = lines.slice(1);

  if (trimmedTrailing.trim() === "") {
    push("empty-message", "error", "Commit message is empty.");
    return { message, subject: "", bodyLines: [], issues, errorCount: 1, warningCount: 0, valid: false };
  }

  if (subject.trim() === "") {
    push("empty-subject", "error", "Subject line (first line) is empty.");
  }

  if (subject.length > maxSubject) {
    push("subject-too-long", "warning", `Subject line is ${subject.length} chars, exceeds recommended max of ${maxSubject}.`);
  }

  if (/[.]$/.test(subject.trim())) {
    push("subject-trailing-period", "warning", "Subject line should not end with a period.");
  }

  if (requireType && !CONVENTIONAL_RE.test(subject)) {
    push("missing-conventional-type", "error", `Subject must start with a Conventional Commits type (${CONVENTIONAL_TYPES.join(", ")}), e.g. "feat: add x".`);
  } else if (!requireType && !CONVENTIONAL_RE.test(subject) && /^[a-z]/.test(subject.trim())) {
    push("subject-lowercase-start", "warning", "Subject line starts with a lowercase letter and has no type prefix; consider capitalizing or using a Conventional Commits type.");
  }

  if (bodyLines.length > 0 && bodyLines[0].trim() !== "") {
    push("missing-blank-line-before-body", "error", "Body must be separated from the subject line by a blank line.");
  }

  lines.forEach((line, i) => {
    if (/[ \t]+$/.test(line)) {
      push("trailing-whitespace", "warning", `Line ${i + 1} has trailing whitespace.`);
    }
  });

  const errorCount = issues.filter((x) => x.severity === "error").length;
  const warningCount = issues.filter((x) => x.severity === "warning").length;
  return { message, subject, bodyLines, issues, errorCount, warningCount, valid: errorCount === 0 };
}

/**
 * Look up a commit's full message by ref and lint it.
 * @param {string} repoDir absolute path inside/at the git working tree
 * @param {string} ref commit ref (default HEAD)
 * @param {object} [opts] same as lintMessage
 */
function lintCommitRef(repoDir, ref, opts = {}) {
  const safeRef = ref || "HEAD";
  try {
    assertSafeArg(safeRef, "ref");
  } catch (e) {
    throw new ToolError(`git_commit_message_lint: ${e.message}`, -32602);
  }
  let message;
  try {
    message = gitExec(`log -1 --pretty=%B ${safeRef}`, repoDir);
  } catch (e) {
    throw new ToolError(`git_commit_message_lint: failed to read commit '${safeRef}': ${e.message.split("\n")[0]}`, -32602);
  }
  const result = lintMessage(message, opts);
  result.ref = safeRef;
  return result;
}

module.exports = { lintMessage, lintCommitRef, CONVENTIONAL_TYPES };
