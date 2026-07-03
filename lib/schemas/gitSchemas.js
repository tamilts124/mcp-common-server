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
    name: "git_untracked_size",
    description: "Sum the on-disk size of untracked (non-.gitignored) files in a repo, listing the largest offenders. Runs git status with --untracked-files=all so files aren't just detected but individually sized. Useful for catching accidental large-file additions (build output, datasets, binaries) before git add/commit. Returns { path, fileCount, totalBytes, totalHumanSize, largest: [{file, bytes, humanSize}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path:  { type: "string", description: "Any path inside the git repository (used to locate the repo). Defaults to first root." },
      top_n: { type: "number", description: "Number of largest untracked files to list (1–500, default 20)." },
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
    name: "find_stale_branches",
    description: "List local git branches whose last commit is older than a threshold (default 90 days), sorted oldest-first — useful for repo-cleanup audits. Set include_remote=true to also consider remote-tracking branches. Returns { thresholdDays, cutoffDate, currentBranch, totalBranches, staleCount, stale: [{name,isCurrent,isRemote,lastCommitDate,lastCommitHash,lastCommitShortHash,lastCommitSubject,lastCommitAuthor,ageDays}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path:           { type: "string",  description: "Any path inside the git repository (used to locate the repo). Defaults to first root." },
      days:           { type: "number",  description: "Age threshold in days (default: 90). Branches whose last commit is older than this are considered stale." },
      include_remote: { type: "boolean", description: "When true, also consider remote-tracking branches (refs/remotes/*). Default: false (local branches only)." },
    }},
  },
  {
    name: "git_commit_message_lint",
    description: "Lint a commit message against common conventions: non-empty subject, subject length (default max 72 chars), no trailing period on the subject, blank line separating subject from body, trailing-whitespace detection, and an optional Conventional Commits type-prefix check (feat/fix/docs/style/refactor/perf/test/chore/build/ci/revert). Provide EITHER 'message' (lint a literal string directly) OR 'ref' (look up and lint an existing commit's message via `git log -1 --pretty=%B`, defaulting to HEAD) — 'message' takes precedence if both are given. Returns { message, subject, bodyLines, issues: [{rule,severity,message}], errorCount, warningCount, valid }; ref-based calls also include the resolved 'ref'. Non-conformance is reported as structured issues, not thrown errors — only missing/invalid parameters or a failed ref lookup throw -32602. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      message:            { type: "string",  description: "A literal commit message string to lint directly. Takes precedence over 'ref' if both are given." },
      ref:                { type: "string",  description: "Commit ref to look up and lint (e.g. 'HEAD', 'HEAD~2', a branch name, a commit hash). Ignored if 'message' is given. Defaults to 'HEAD'." },
      path:               { type: "string",  description: "Any path inside the git repository (used to locate the repo when linting by 'ref'). Defaults to first root." },
      max_subject_length: { type: "number",  description: "Max recommended subject-line length before a 'subject-too-long' warning (default: 72)." },
      require_type:       { type: "boolean", description: "When true, require a Conventional Commits type prefix (e.g. 'feat: ...'); missing prefix becomes an error instead of a soft warning. Default: false." },
    }},
  },
  {
    name: "check_gitignore_coverage",
    description: "Check whether candidate paths would be ignored by a repo's actual .gitignore rule stack, via real `git check-ignore -v --no-index` (no reimplemented glob-matching — exercises git's own semantics). With no 'paths' argument, checks a built-in list of commonly-recommended-but-often-missed junk paths (node_modules/, .env, .DS_Store, Thumbs.db, dist/build output, IDE dirs, log files, a .bak file) and returns 'recommendations' for any that are NOT ignored. Supply 'paths' to check specific candidate paths instead (no recommendations are generated for custom paths, since they aren't presumed to be junk). Each result includes { path, ignored, source?, line?, pattern? } when ignored (source/line/pattern identify which rule/file matched), or { path, ignored:false } when not ignored, or { path, ignored:null, error } if git itself failed on that candidate. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path:  { type: "string", description: "Any path inside the git repository (used to locate the repo). Defaults to first root." },
      paths: { type: "array", items: { type: "string" }, description: "Optional list of specific candidate paths to check instead of the built-in default list (max 100)." },
    }},
  },
  {
    name: "git_diff_summary",
    description: "Churn/PR-style summary built on top of the git_diff stat_only data — for when an agent wants a rolled-up overview rather than a raw per-file list. Same ref/staged/file selection semantics as git_diff (default: working tree vs HEAD; staged=true diffs index vs HEAD; from_ref/to_ref for other comparisons). Reports totalFiles/additions/deletions, a byStatus breakdown (added/modified/deleted/renamed counts), a byExtension breakdown (count + additions/deletions per file extension, sorted by churn descending), a topFiles list (files sorted by churn = additions+deletions descending, capped at top_n), and a ready-to-paste 'markdown' string summarising all of the above — useful for drafting a commit message or PR description body without re-deriving this from git_diff's raw changedFiles array. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path:     { type: "string",  description: "Any path inside the git repository (used to locate the repo). Defaults to first root." },
      from_ref: { type: "string",  description: "Optional: left-side ref/commit/branch. Defaults to HEAD." },
      to_ref:   { type: "string",  description: "Optional: right-side ref/commit/branch. Only used when from_ref is also given (commit-to-commit diff)." },
      file:     { type: "string",  description: "Optional: restrict to this file or directory path (relative to repo root)." },
      staged:   { type: "boolean", description: "When true (and no refs given), summarise the staging index vs HEAD instead of the working tree vs HEAD." },
      top_n:    { type: "number",  description: "Cap on the topFiles list length (1-500, default 20)." },
    }},
  },
  {
    name: "git_blame_hotspots",
    description: "Rank files by recent-activity review risk: distinct-author count and commit count over a lookback window (single `git log --since --name-only` call, parsed client-side — O(1) git processes regardless of repo size, unlike git_ownership's per-file git-blame). Files touched by many different people recently are more collision-/regression-prone than files with a single long-term owner, even if git_ownership's all-time blame-line aggregate looks the same. Sorted by authorCount desc, then commitCount desc. Optional file/dir pathspec scopes the log to a subtree; optional extensions filter narrows by file type. Returns { path, sinceDays, filesWithActivity, truncated, hotspots: [{file, authorCount, commitCount, authors}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path:        { type: "string",  description: "Any path inside the git repository (used to locate the repo). Defaults to first root." },
      since_days:  { type: "number",  description: "Lookback window in days (1-3650, default 90)." },
      top_n:       { type: "number",  description: "Cap on the hotspots list length (1-500, default 20)." },
      file:        { type: "string",  description: "Optional: restrict the log to this file or directory path (relative to repo root)." },
      extensions:  { type: "array", items: { type: "string" }, description: "Optional: only include files with these extensions, e.g. ['.js', '.ts']." },
    }},
  },

  {
    name: "git_worktree_list",
    description: "List all worktrees attached to a repository (the main worktree plus any linked worktrees added via `git worktree add`), parsed from `git worktree list --porcelain`. Each entry reports its filesystem path, checked-out branch (or null if detached/bare), HEAD commit, and lock/prunable status — useful for an agent juggling multiple worktrees/branches of the same repo to see at a glance which path has which branch checked out before running any git commands there. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "Any path inside the git repository (used to locate the repo). Defaults to first root." },
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
    name: "git_reflog",
    description: "List reflog entries for a ref (default HEAD) — every place that ref has pointed to recently, including commits no longer reachable from any branch after a hard reset, an amend, or an interactive rebase. This is information `git_log` alone cannot show, since git_log only walks the current ancestry graph, not the ref's own history of movements. Each entry includes the reflog selector (e.g. 'HEAD@{0}'), the target commit hash, the reflog action git itself recorded (e.g. 'commit: fix bug', 'checkout: moving from main to feature', 'reset: moving to HEAD~1', 'rebase (finish): returning to refs/heads/main'), and the commit's own subject line (kept separate from the action since they can differ, e.g. after a checkout or reset). A ref with no reflog entries yet (e.g. a brand-new unborn branch) returns an empty list rather than an error. Returns { ref, count, entries: [{ selector, hash, shortHash, action, subject, author, email, date }] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path:  { type: "string", description: "Any path inside the git repository (used to locate the repo). Defaults to first root." },
      ref:   { type: "string", description: "Ref whose reflog to read (default 'HEAD'). Blank/whitespace-only also falls back to 'HEAD'." },
      limit: { type: "number", description: "Maximum number of reflog entries to return (1–500, default 30)." },
    }},
  },
  {
    name: "git_cherry",
    description: "List commits on `head` (default HEAD) that are not yet in `upstream`, using git's own patch-equivalence detection (`git cherry`) rather than plain ancestry comparison. Each commit is marked 'unmerged' (truly unique to head, not yet in upstream) or 'equivalent' (the commit object itself isn't reachable from upstream, but an identical patch already is — e.g. because it was cherry-picked or the branch was rebased). This distinction matters: a plain two-ref diff (`git_diff`/`git_log` with two refs) would misreport an already-rebased commit as still unmerged, since it only compares ancestry/tree state, not patch content. Useful for answering 'what on this feature branch still needs to land on main' without false positives from rebased/cherry-picked history. Returns { upstream, head, count, unmergedCount, equivalentCount, commits: [{ hash, shortHash, subject, status }] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", required: ["upstream"], properties: {
      path:     { type: "string", description: "Any path inside the git repository (used to locate the repo). Defaults to first root." },
      upstream: { type: "string", description: "The branch/ref to compare against (the merge target, e.g. 'main'). Required." },
      head:     { type: "string", description: "The branch/ref to inspect (default 'HEAD')." },
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
