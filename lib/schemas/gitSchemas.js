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
    name: "git_file_age",
    description: "Days since each tracked file's last commit, oldest-first — the inverse-recency companion to git_blame_hotspots (surfaces stale/abandoned files rather than hot ones). Single newest-first `git log --name-only` walk (SENTINEL-parsed, O(1) git processes) capped at max_commits, matched against the tracked-file list from `git ls-files`. A tracked file whose last touch falls outside the scanned commit window is reported with ageDays:null, unknown:true rather than omitted or mis-reported — widen max_commits if that matters. Returns { path, filesScanned, filesTruncated, commitsScanned, commitWindowMayBeTruncated, truncated, oldest: [{file, ageDays, unknown, lastCommitDate, lastCommitHash, lastCommitShortHash, lastCommitAuthor}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path:        { type: "string", description: "Any path inside the git repository (used to locate the repo). Defaults to first root." },
      max_files:   { type: "number", description: "Cap on tracked files enumerated (1-2000, default 300)." },
      max_commits: { type: "number", description: "Cap on commit history depth scanned (1-20000, default 3000)." },
      top_n:       { type: "number", description: "Cap on the oldest-files list length (1-500, default 20)." },
      file:        { type: "string", description: "Optional: restrict to this file or directory path (relative to repo root)." },
    }},
  },

  {
    name: "find_todo_owners",
    description: "Combine scan_todos (TODO/FIXME/HACK/XXX/BUG comment-marker detection) with a per-line git blame lookup, so each flagged comment is attributed to the person who last touched that exact line — useful for an agent that needs to @ the right owner instead of just listing markers with no ownership signal. One blame call per matched marker (bounded by max_markers), grouped by author, sorted by count descending. A marker whose line can't be blamed (uncommitted/untracked file, etc.) is listed in `unresolved` with a reason rather than aborting the scan. Requires the target to be inside a git repository. Returns { path, totalMarkers, resolvedCount, unresolvedCount, truncated, byAuthor: [{author, count, items: [{file, line, marker, text, date}]}], unresolved: [{file, line, marker, reason}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", required: ["path"], properties: {
      path:            { type: "string",  description: "File or directory (inside a git repository) to scan for TODO-style markers." },
      markers:         { type: "array", items: { type: "string" }, description: "Marker words to look for (default: TODO, FIXME, HACK, XXX, BUG)." },
      extensions:      { type: "array", items: { type: "string" }, description: "Directory mode only: restrict to files with these extensions, e.g. ['.js', '.ts']." },
      case_sensitive:  { type: "boolean", description: "Case-sensitive marker matching (default: false)." },
      max_markers:     { type: "number",  description: "Cap on markers processed — each costs one git blame call (1-1000, default 200)." },
    }},
  },

  {
    name: "generate_pr_description",
    description: "Auto-draft a markdown PR/commit description by combining git_diff_summary (churn/file stats) with git_log (commit list) — no new git plumbing, purely a composition of the two. When from_ref is given, commits are the range fromRef..(toRef||HEAD); when no from_ref is given (working-tree or staged mode, same selection semantics as git_diff/git_diff_summary), commits are simply the most recent commits on HEAD since there's no meaningful commit range for uncommitted changes. Returns { fromRef, toRef, staged, totalFiles, additions, deletions, commitCount, commits: [{shortHash, subject, author}], markdown } where markdown is a ready-to-paste '## Summary' / '## Changes' / '## Commits' document. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path:         { type: "string",  description: "Any path inside the git repository (used to locate the repo). Defaults to first root." },
      from_ref:     { type: "string",  description: "Optional: left-side ref/commit/branch. Defaults to working tree vs HEAD." },
      to_ref:       { type: "string",  description: "Optional: right-side ref/commit/branch. Only used when from_ref is also given." },
      staged:       { type: "boolean", description: "When true (and no refs given), summarise the staging index vs HEAD instead of the working tree vs HEAD." },
      top_n:        { type: "number",  description: "Cap on the top-changed-files list length (1-500, default 10)." },
      commit_limit: { type: "number",  description: "Cap on commits listed (1-200, default 20)." },
    }},
  },

  {
    name: "find_large_git_objects",
    description: "Scan a repo's *full committed history* (not just the working tree) for the largest blobs ever committed, via `git rev-list --objects --all` + `git cat-file --batch-check`. Catches accidentally-committed large files (build artifacts, media, dumps) that still bloat `.git` and every future clone even after being deleted in a later commit — complements git_untracked_size, which only sees current-working-tree bloat. Deduped by path, keeping the largest size ever seen for that path across its history (the same file can exist at multiple hashes over time). Sorted by size descending, capped at top_n. Optional min_size_bytes filters out small blobs. max_objects bounds how many objects rev-list enumerates before stopping, as a safety cap on very large histories. Returns { totalObjectsScanned, blobCount, truncated, objects: [{path, hash, sizeBytes}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path:            { type: "string", description: "Any path inside the git repository (used to locate the repo). Defaults to first root." },
      top_n:           { type: "number", description: "Cap on the returned objects list length (1-500, default 20)." },
      min_size_bytes:  { type: "number", description: "Only report blobs at or above this size in bytes (default 0 = no filter)." },
      max_objects:     { type: "number", description: "Safety cap on objects enumerated from rev-list before stopping (1000-500000, default 100000)." },
    }},
  },

  {
    name: "check_lfs_coverage",
    description: "Check whether large tracked files (or caller-supplied paths) are covered by a `filter=lfs` .gitattributes rule, via real `git check-attr` (batched through `--stdin -z`, one process for the whole check rather than one per file). With no `paths` argument: enumerates tracked files via `git ls-files`, sizes them, takes the largest ones above `min_size_bytes` (default 5MB) up to `max_files`, and checks each — files above the size threshold with no filter=lfs rule are flagged in `recommendations`. Supply `paths` to check specific candidate paths instead (no size info or recommendations, since custom paths aren't presumed to be junk/large — mirrors check_gitignore_coverage's convention). Complements find_large_git_objects: that tool finds large blobs already committed in history; this one checks whether the repo's LFS rules would actually catch a large file *before* it's committed. Returns { usingDefaults, minSizeBytes, totalTrackedScanned, candidatesOverThreshold, checked: [{path, size?, filterValue, lfsTracked}], notCoveredCount, recommendations }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path:           { type: "string", description: "Any path inside the git repository (used to locate the repo). Defaults to first root." },
      paths:          { type: "array", items: { type: "string" }, description: "Optional list of specific candidate paths to check instead of scanning tracked files by size (max 500)." },
      min_size_bytes: { type: "number", description: "Default-mode size threshold in bytes for a tracked file to be considered a candidate (default 5242880 = 5MB)." },
      max_files:      { type: "number", description: "Cap on candidates checked in default mode (1-2000, default 200)." },
    }},
  },

  {
    name: "merge_conflict_risk",
    description: "Predict merge/rebase conflict risk between two branches by finding their merge-base and diffing each branch against it — files changed on *both* sides since diverging are the actual conflict candidates (git can silently auto-merge non-overlapping changes to the same file, but overlapping files are where a real conflict is likely). This is a fast file-level signal, not a trial merge — it does not check whether the overlapping line ranges within a file actually collide, only that both branches touched the same file. Returns { branchA, branchB, mergeBase, filesChangedA, filesChangedB, overlappingCount, overlapRatio, riskLevel: 'none'|'low'|'medium'|'high', overlapping: [{path, churnA, churnB, riskScore}] } sorted by riskScore (combined churn) descending, capped at top_n. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", required: ["branch_a", "branch_b"], properties: {
      path:     { type: "string", description: "Any path inside the git repository (used to locate the repo). Defaults to first root." },
      branch_a: { type: "string", description: "First branch/ref to compare." },
      branch_b: { type: "string", description: "Second branch/ref to compare." },
      top_n:    { type: "number", description: "Cap on the overlapping-files list length (1-500, default 50)." },
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
    name: "git_dangling_commits",
    description: "List commit objects that still exist in the repository's object database but are not reachable from any branch or tag HEAD — the classic recovery scenario after an accidental `git reset --hard`, a deleted branch, or an amend that orphaned the previous commit, before `git gc` eventually prunes them. Uses `git fsck --unreachable --no-reflogs` (the direct, version-stable way to ask this exact question): fsck by DEFAULT treats reflog entries as extra reachability roots, so a commit still referenced by a reflog entry (the common post-reset/post-amend case) would NOT show up under a plain `--unreachable` run — `--no-reflogs` is required to reveal commits kept alive only by a reflog entry, not by any branch/tag, which is exactly the recoverable set this tool surfaces (once the reflog entry itself expires and `git gc` runs, these are what actually gets pruned). A limit budget (default 50, hard cap 500) caps how many of the unreachable commits get their metadata (subject/author/date) looked up via a single batched `git log --no-walk`; count always reflects the true total found by fsck, with truncated:true when count exceeds the number detailed. Returns { count, truncated, danglingCommits: [{ hash, shortHash, subject, author, email, date }] }. Read-only — does not require MCP_ALLOW_EXEC beyond running git itself.",
    inputSchema: { type: "object", properties: {
      path:  { type: "string", description: "Any path inside the git repository (used to locate the repo). Defaults to first root." },
      limit: { type: "number", description: "Maximum number of dangling commits to detail with metadata (1–500, default 50)." },
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
  {
    name: "git_contributors_summary",
    description: "Per-author rollup across a repo's (or ref range's) commit history: commit count, first/last commit date, and total lines inserted/deleted — a single `git log --numstat` call (one git process regardless of author count), complementing git_ownership's per-file blame view with a per-author activity view. Sorted by commit count descending, capped at top_n. Returns { range, authorsFound, truncated, totalCommits, authors: [{name, email, commits, insertions, deletions, firstCommit, lastCommit}] } with firstCommit/lastCommit as ISO-8601 strings. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path:  { type: "string", description: "Any path inside the git repository (used to locate the repo). Defaults to first root." },
      range: { type: "string", description: "Optional ref range/revision (e.g. 'HEAD~50..HEAD', 'main', a branch name). Defaults to all of HEAD's history." },
      since: { type: "string", description: "Optional --since date filter (e.g. '90 days ago', '2025-01-01')." },
      top_n: { type: "number", description: "Max authors to return (1–500, default 50), sorted by commit count descending." },
    }},
  },
];

module.exports = { GIT_SCHEMAS };
