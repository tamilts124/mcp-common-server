"use strict";
// ── GIT METADATA TOOL SCHEMAS — always available, read-only ───────────────────
// These never require MCP_ALLOW_EXEC — they only read repo metadata via `git`,
// never modify the working tree. Args passed through to `git` are validated
// against shell metacharacters in lib/gitOpsHelpers.js before use.

const GIT_SCHEMAS = [
  {
    name: "git_status",
    description: "Return the current git branch, upstream tracking info (ahead/behind counts), and a structured summary of staged, unstaged, untracked, and conflicted file counts for the repository that contains the given path. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "Any path inside the git repository (file or directory). Defaults to the first configured root." },
    }},
  },
  {
    name: "git_log",
    description: "Return the last N commits from a git repository as structured JSON (hash, author, email, ISO date, subject, body). Optionally filter to commits that touch a specific file or directory, or read from a specific branch/ref. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path:   { type: "string", description: "Any path inside the git repository (used to locate the repo). Defaults to first root." },
      limit:  { type: "number", description: "Maximum number of commits to return (1–200, default 20)." },
      file:   { type: "string", description: "Optional: restrict log to commits that modified this file or directory path (relative to repo root)." },
      branch: { type: "string", description: "Optional: branch or ref to read the log from (default: HEAD)." },
    }},
  },
  {
    name: "git_blame",
    description: "Return per-line authorship information for a file: line number, content, commit hash, author name, commit date, and commit summary. Optionally restrict to a line range. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", required: ["path"], properties: {
      path:      { type: "string", description: "Path to the file to blame (must be tracked by git)." },
      from_line: { type: "number", description: "First line to include (1-based, inclusive). Omit for the whole file." },
      to_line:   { type: "number", description: "Last line to include (1-based, inclusive). Omit for the whole file." },
    }},
  },
  {
    name: "git_diff",
    description: "Compute the diff between two states of a git repository. Returns a unified diff string plus structured statistics (additions, deletions, hunk count, changed files with status codes). Modes: default = working tree vs HEAD (unstaged changes); staged=true = index vs HEAD (staged changes); from_ref only = working tree vs that ref; from_ref + to_ref = commit-to-commit diff. Optionally restrict to a specific file or directory with the 'file' argument. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path:     { type: "string",  description: "Any path inside the git repository (used to locate the repo). Defaults to first root." },
      from_ref: { type: "string",  description: "Optional: left-side ref/commit/branch. Defaults to HEAD." },
      to_ref:   { type: "string",  description: "Optional: right-side ref/commit/branch. Only used when from_ref is also given (commit-to-commit diff)." },
      file:     { type: "string",  description: "Optional: restrict diff to this file or directory path (relative to repo root)." },
      staged:   { type: "boolean", description: "When true (and no refs given), diff the staging index vs HEAD instead of the working tree vs HEAD." },
    }},
  },
  {
    name: "git_stash_list",
    description: "Return a structured list of all stash entries in the repository. Each entry includes its stash index, ref name (stash@{N}), description message, author name, author email, and ISO 8601 commit date. Returns an empty list when there are no stashes. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "Any path inside the git repository (used to locate the repo). Defaults to first root." },
    }},
  },
  {
    name: "git_branch_list",
    description: "List branches in a git repository with the current-branch marker and last-commit metadata for each (hash, short hash, ISO date, subject, author). By default lists only local branches (refs/heads); set include_remote=true to also include remote-tracking branches (refs/remotes), excluding the synthetic origin/HEAD pointer. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path:           { type: "string",  description: "Any path inside the git repository (used to locate the repo). Defaults to first root." },
      include_remote: { type: "boolean", description: "When true, also include remote-tracking branches (refs/remotes/*). Default: false (local branches only)." },
    }},
  },
];

module.exports = { GIT_SCHEMAS };
