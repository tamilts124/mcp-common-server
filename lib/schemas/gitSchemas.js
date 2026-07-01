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
    description: "Return the last N commits from a git repository as structured JSON (hash, author, email, ISO date, subject, body). Optionally filter to commits that touch a specific file or directory, or read from a specific branch/ref. Set include_files:true to also attach a filesChanged: [{path, additions, deletions}] array per commit (additions/deletions are null for binary files) — costs a second git log call, useful for seeing what each of the last N commits touched without a separate git_show/git_diff call per commit. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path:           { type: "string",  description: "Any path inside the git repository (used to locate the repo). Defaults to first root." },
      limit:          { type: "number",  description: "Maximum number of commits to return (1–200, default 20)." },
      file:           { type: "string",  description: "Optional: restrict log to commits that modified this file or directory path (relative to repo root)." },
      branch:         { type: "string",  description: "Optional: branch or ref to read the log from (default: HEAD)." },
      include_files:  { type: "boolean", description: "When true, each commit also gets a filesChanged: [{path, additions, deletions}] array (default: false)." },
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
    description: "Compute the diff between two states of a git repository. Returns a unified diff string plus structured statistics (additions, deletions, hunk count, changed files with status codes). Modes: default = working tree vs HEAD (unstaged changes); staged=true = index vs HEAD (staged changes); from_ref only = working tree vs that ref; from_ref + to_ref = commit-to-commit diff. Optionally restrict to a specific file or directory with the 'file' argument. Set stat_only=true to skip the full unified diff text and get back only per-file added/deleted line counts (unified is null in that mode) — useful for a quick 'what changed and how much' overview before pulling the full diff. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path:      { type: "string",  description: "Any path inside the git repository (used to locate the repo). Defaults to first root." },
      from_ref:  { type: "string",  description: "Optional: left-side ref/commit/branch. Defaults to HEAD." },
      to_ref:    { type: "string",  description: "Optional: right-side ref/commit/branch. Only used when from_ref is also given (commit-to-commit diff)." },
      file:      { type: "string",  description: "Optional: restrict diff to this file or directory path (relative to repo root)." },
      staged:    { type: "boolean", description: "When true (and no refs given), diff the staging index vs HEAD instead of the working tree vs HEAD." },
      stat_only: { type: "boolean", description: "When true, return only per-file added/deleted line counts and status (changedFiles[].additions/deletions) with unified set to null — skips generating the full unified diff text. Default: false (full unified diff, unchanged behavior)." },
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
  {
    name: "git_show",
    description: "Return the content of a file as it existed at a specific commit/ref, without checking it out into the working tree. Useful for reading historical versions of a file — e.g. 'what did this config look like 3 commits ago', or reading a file from another branch without switching to it. The ref is resolved to a full commit hash first, so the result is unambiguous even for relative refs (HEAD~2, a branch name, a tag) and so an unknown ref surfaces a clear error rather than a raw git failure. Also distinguishes a path that does not exist at that ref from a path that is a directory (tree) rather than a file (blob) at that ref. Binary content is detected via a NUL-byte-in-first-8000-bytes heuristic and is not returned as text — isBinary is true and content is null in that case (the file's byte size is still reported via 'size'). Returns { ref, resolvedHash, file, size, isBinary, content }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", required: ["file"], properties: {
      path: { type: "string", description: "Any path inside the git repository (used to locate the repo). Defaults to first root." },
      file: { type: "string", description: "Path to the file, relative to the repository root (e.g. 'src/index.js')." },
      ref:  { type: "string", description: "Commit/branch/tag ref to read the file from (e.g. 'HEAD', 'HEAD~2', 'main', a commit hash). Defaults to 'HEAD' when omitted." },
    }},
  },
  {
    name: "git_tag_list",
    description: "List all tags in a git repository with their target commit hash, date, and message, most recent first. Handles both lightweight tags (a plain ref pointing directly at a commit — hash/date/message describe that commit) and annotated tags (a ref pointing at a tag object, which carries its own tagger date and message and points at a target commit — isAnnotated is true and the reported hash/date/message describe the tag's dereferenced target/tagger metadata). Returns an empty list when the repository has no tags. Returns { count, tags: [{ name, hash, isAnnotated, date, message }] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "Any path inside the git repository (used to locate the repo). Defaults to first root." },
    }},
  },
  {
    name: "git_ownership",
    description: "Aggregate git-blame line counts by author for a single file or an entire directory tree — a 'who owns this code' query. For a directory, enumerates tracked files via `git ls-files` (respects .gitignore, only tracked files are considered) up to max_files, blames each one, and sums line counts per author across the whole set. Files git blame can't process (e.g. binary) are listed in filesSkipped with a reason rather than aborting the scan. Returns { path, filesScanned, filesSkipped: [{path, reason}], truncated, totalLines, authors: [{name, lines, percentage}] } sorted by lines descending. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", required: ["path"], properties: {
      path:       { type: "string", description: "Path to the file or directory to compute ownership for (must be tracked by git)." },
      max_files:  { type: "number", description: "Maximum number of files to blame in directory mode (1–500, default 100). Ignored for single-file mode." },
      extensions: { type: "array", items: { type: "string" }, description: "Optional: only consider files with these extensions in directory mode, e.g. ['.js', '.ts']." },
    }},
  },
];

module.exports = { GIT_SCHEMAS };
