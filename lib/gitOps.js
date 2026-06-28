"use strict";
// ── GIT METADATA OPERATIONS ──────────────────────────────────────────────────
// git_status  — branch, tracking info, working-tree state (staged/unstaged/untracked)
// git_log     — last N commits (hash, author, date, subject); optional file filter
// git_blame   — per-line authorship for a file; optional line range
//
// All three call `git` via child_process.execSync with a strict timeout.
// They are READ-ONLY (no writes to the repo) so they do NOT require
// MCP_ALLOW_EXEC=true — they are always available alongside other read tools.
//
// Security: the working-directory is always resolved through the MCP root jail
// (resolveClientPath) by the executeTool dispatcher before being passed here,
// so path traversal outside configured roots is blocked at dispatch time.
// Additional sanitisation is applied inside each function to prevent shell
// metacharacter injection in arguments that are passed to git.

const { execSync } = require("child_process");

// Maximum milliseconds any git subprocess may run before being killed.
const GIT_TIMEOUT_MS = 15_000;

// ── SHARED HELPERS ────────────────────────────────────────────────────────────

/**
 * Run a git command synchronously in `cwd`.
 * Returns stdout as a trimmed string.
 * Throws on non-zero exit code (execSync default).
 *
 * GIT_CEILING_DIRECTORIES is set to the parent of `cwd` so that git does NOT
 * traverse up into ancestor directories looking for a .git folder. This means
 * the tool only succeeds if `cwd` itself (or a descendant of it chosen by git
 * normal repo-discovery rules) is a git repository — consistent with the
 * user's intent of operating on a specific project root.
 */
function gitExec(args, cwd) {
  const cmd = `git ${args}`;
  const parent = require("path").dirname(cwd);
  const out = execSync(cmd, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      // Stop git from climbing above cwd when looking for .git
      GIT_CEILING_DIRECTORIES: parent,
    },
  });
  return (out || "").trimEnd();
}

/**
 * Assert that a string is safe to embed in a git argument position:
 * no shell metacharacters, no NUL bytes, max 4096 chars.
 * Throws a descriptive Error on violation.
 */
function assertSafeArg(value, label) {
  if (typeof value !== "string")
    throw new Error(`git_ops: ${label} must be a string, got ${typeof value}.`);
  if (value.length > 4096)
    throw new Error(`git_ops: ${label} exceeds 4096 characters.`);
  // Block shell metacharacters that could escape the argument in all shells.
  // We use double-quoting below, so only `"`, backtick, $, NUL are dangerous.
  if (/[\0`$"\\!|&;<>(){}\n\r]/.test(value))
    throw new Error(`git_ops: ${label} contains disallowed characters.`);
}

/**
 * Wrap a git argument in double quotes for the shell command string.
 * The caller must have already validated the arg with assertSafeArg.
 */
function q(s) { return `"${s}"`; }

// ── GIT STATUS ────────────────────────────────────────────────────────────────
/**
 * Return a structured summary of the repository state at `repoDir`.
 *
 * @param {string} repoDir  Absolute path inside (or at) the git working tree.
 * @returns {{
 *   branch: string,
 *   upstream: string|null,
 *   ahead: number,
 *   behind: number,
 *   staged: number,
 *   unstaged: number,
 *   untracked: number,
 *   conflicted: number,
 *   clean: boolean,
 *   files: Array<{ status: string, path: string }>
 * }}
 */
function gitStatus(repoDir) {
  // --porcelain=v2 with branch info gives us a machine-readable, stable format
  const raw = gitExec("status --porcelain=v2 --branch", repoDir);
  const lines = raw.split("\n");

  let branch = "HEAD";
  let upstream = null;
  let ahead = 0;
  let behind = 0;
  const files = [];

  for (const line of lines) {
    if (!line) continue;

    // Branch header lines start with "# branch."
    if (line.startsWith("# branch.head ")) {
      branch = line.slice("# branch.head ".length).trim();
      continue;
    }
    if (line.startsWith("# branch.upstream ")) {
      upstream = line.slice("# branch.upstream ".length).trim();
      continue;
    }
    if (line.startsWith("# branch.ab ")) {
      // Format: "+<ahead> -<behind>"
      const m = line.match(/\+(\d+)\s+-(\d+)/);
      if (m) { ahead = parseInt(m[1]); behind = parseInt(m[2]); }
      continue;
    }
    // Skip other # header lines
    if (line.startsWith("#")) continue;

    // Changed-entry lines: "1 XY ..." for ordinary, "2 XY ..." for renamed,
    // "u XY ..." for unmerged, "? ..." for untracked
    const type = line[0];
    if (type === "1" || type === "2") {
      // Field 2 (index 2 after split by space) is XY status code
      const parts = line.split(" ");
      const xy = parts[1]; // e.g. ".M", "M.", "MM", "A.", etc.
      // For renames (type 2) the path is at the end (after tab): "orig\tnew"
      let filePath;
      if (type === "2") {
        const tabIdx = line.lastIndexOf("\t");
        filePath = tabIdx !== -1 ? line.slice(tabIdx + 1) : parts[parts.length - 1];
      } else {
        filePath = parts[parts.length - 1];
      }
      files.push({ status: xy, path: filePath });
    } else if (type === "u") {
      const parts = line.split(" ");
      files.push({ status: "UU", path: parts[parts.length - 1] });
    } else if (type === "?") {
      files.push({ status: "??", path: line.slice(2) });
    }
  }

  // Derive counts from XY codes:
  // X = index (staged), Y = worktree (unstaged)
  // "?" = untracked, "U" = unmerged/conflicted
  let staged = 0, unstaged = 0, untracked = 0, conflicted = 0;
  for (const f of files) {
    const xy = f.status;
    if (xy === "??") { untracked++; continue; }
    if (xy === "UU" || xy.includes("U") || xy === "AA" || xy === "DD") {
      conflicted++; continue;
    }
    if (xy[0] !== "." && xy[0] !== " ") staged++;
    if (xy[1] !== "." && xy[1] !== " ") unstaged++;
  }

  return {
    branch,
    upstream,
    ahead,
    behind,
    staged,
    unstaged,
    untracked,
    conflicted,
    clean: files.length === 0,
    files,
  };
}

// ── GIT LOG ───────────────────────────────────────────────────────────────────
/**
 * Return the last `limit` commits reachable from HEAD (or filtered by `filePath`).
 *
 * @param {string}      repoDir   Absolute path inside the git working tree.
 * @param {number}      limit     Max commits to return (1–200, default 20).
 * @param {string|null} filePath  Optional: only show commits touching this path.
 * @param {string|null} branch    Optional: ref/branch to read log from (default HEAD).
 * @returns {{
 *   ref: string,
 *   count: number,
 *   commits: Array<{
 *     hash: string, shortHash: string,
 *     author: string, email: string,
 *     date: string,      // ISO 8601
 *     subject: string,
 *     body: string       // may be empty
 *   }>
 * }}
 */
function gitLog(repoDir, limit, filePath, branch) {
  const n = Math.min(Math.max(1, parseInt(limit) || 20), 200);
  const ref = (branch && branch.trim()) ? branch.trim() : "HEAD";

  // Validate ref and optional filePath for shell-safety
  assertSafeArg(ref, "branch/ref");
  if (filePath) assertSafeArg(filePath, "filePath");

  // Use a unique record separator that won't appear in commit metadata
  const SEP = "\x1f"; // ASCII unit-separator
  const REC = "\x1e"; // ASCII record-separator

  // Format: hash SEP shortHash SEP author SEP email SEP isoDate SEP subject SEP body REC
  const fmt = `%H${SEP}%h${SEP}%an${SEP}%ae${SEP}%aI${SEP}%s${SEP}%b${REC}`;

  let cmd = `log -n ${n} --format=${q(fmt)}`;
  if (ref !== "HEAD") cmd += ` ${q(ref)}`;
  if (filePath) cmd += ` -- ${q(filePath)}`;

  let raw;
  try {
    raw = gitExec(cmd, repoDir);
  } catch (e) {
    // git log on a branch that doesn't exist throws; give a clean error
    throw new Error(`git log failed: ${e.message.split("\n")[0]}`);
  }

  const commits = [];
  for (const record of raw.split(REC)) {
    const trimmed = record.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(SEP);
    if (parts.length < 6) continue;
    commits.push({
      hash:      parts[0].trim(),
      shortHash: parts[1].trim(),
      author:    parts[2].trim(),
      email:     parts[3].trim(),
      date:      parts[4].trim(),
      subject:   parts[5].trim(),
      body:      (parts[6] || "").trim(),
    });
  }

  return { ref, count: commits.length, commits };
}

// ── GIT BLAME ────────────────────────────────────────────────────────────────
/**
 * Return per-line blame information for a file.
 *
 * @param {string}      filePath    Absolute path to the file to blame.
 * @param {string}      repoDir     Absolute path to the repo root (or any dir inside).
 * @param {number|null} fromLine    First line to include (1-based, inclusive).
 * @param {number|null} toLine      Last line to include (1-based, inclusive).
 * @returns {{
 *   file: string,
 *   lineCount: number,
 *   lines: Array<{
 *     line: number,
 *     content: string,
 *     hash: string,
 *     shortHash: string,
 *     author: string,
 *     date: string,     // ISO 8601
 *     summary: string
 *   }>
 * }}
 */
function gitBlame(filePath, repoDir, fromLine, toLine) {
  // Validate fromLine/toLine before building the -L range argument
  let lineRange = "";
  if (fromLine != null || toLine != null) {
    const from = fromLine != null ? Math.max(1, parseInt(fromLine) || 1) : 1;
    const to   = toLine   != null ? Math.max(from, parseInt(toLine) || from) : from;
    lineRange = `-L ${from},${to} `;
  }

  // --line-porcelain emits a full header block per line — easy to parse,
  // no ambiguity with content lines (they start with TAB).
  // We pass filePath as a relative or absolute path; git resolves it from cwd.
  // filePath has already been jailed+validated by the dispatcher.
  let cmd = `blame --line-porcelain ${lineRange}-- ${q(filePath)}`;

  let raw;
  try {
    raw = gitExec(cmd, repoDir);
  } catch (e) {
    throw new Error(`git blame failed: ${e.message.split("\n")[0]}`);
  }

  // Parse --line-porcelain output
  // Each line's block looks like:
  //   <40-char-hash> <orig-line> <result-line> [<groupcount>]
  //   author <name>
  //   author-mail <email>
  //   author-time <unix-timestamp>
  //   author-tz <tz>
  //   committer <name>
  //   ...
  //   summary <message>
  //   filename <filename>
  //   \t<line content>
  const blameLines = [];
  const rawLines = raw.split("\n");
  let current = null;

  for (const l of rawLines) {
    if (!l) continue;

    // A new commit block starts with a 40-char hex string followed by numbers
    const commitMatch = l.match(/^([0-9a-f]{40}) \d+ (\d+)(?:\s+\d+)?$/);
    if (commitMatch) {
      current = {
        hash:    commitMatch[1],
        shortHash: commitMatch[1].slice(0, 7),
        lineNum: parseInt(commitMatch[2]),
        author:  "",
        date:    "",
        summary: "",
        content: "",
      };
      continue;
    }

    if (!current) continue;

    if (l.startsWith("author ") && !l.startsWith("author-")) {
      current.author = l.slice("author ".length);
    } else if (l.startsWith("author-time ")) {
      // Convert Unix timestamp to ISO 8601
      const ts = parseInt(l.slice("author-time ".length));
      current.date = new Date(ts * 1000).toISOString();
    } else if (l.startsWith("summary ")) {
      current.summary = l.slice("summary ".length);
    } else if (l.startsWith("\t")) {
      // Content line — completes this entry
      current.content = l.slice(1); // strip the leading TAB
      blameLines.push({
        line:      current.lineNum,
        content:   current.content,
        hash:      current.hash,
        shortHash: current.shortHash,
        author:    current.author,
        date:      current.date,
        summary:   current.summary,
      });
      current = null;
    }
  }

  return {
    file:      filePath,
    lineCount: blameLines.length,
    lines:     blameLines,
  };
}

// ── GIT DIFF ──────────────────────────────────────────────────────────────────
/**
 * Return the diff between two states in a git repository.
 *
 * Modes (controlled by `staged`, `fromRef`, `toRef`):
 *   - default (staged=false, no refs): working tree vs HEAD (unstaged changes)
 *   - staged=true (no refs):           index vs HEAD (staged changes)
 *   - fromRef only:                    working tree vs <fromRef>
 *   - fromRef + toRef:                 <fromRef> vs <toRef> (commit-to-commit)
 *
 * Optionally filter to a specific file/directory with `filePath`.
 *
 * @param {string}      repoDir   Absolute path inside (or at) the git working tree.
 * @param {string|null} fromRef   Optional: left-side ref/commit/branch (default HEAD).
 * @param {string|null} toRef     Optional: right-side ref/commit/branch. When
 *                                combined with fromRef gives a commit-to-commit diff.
 * @param {string|null} filePath  Optional: restrict diff to this file/dir path
 *                                (relative to repo root). Validated for safety.
 * @param {boolean}     staged    When true and no refs given, diff index vs HEAD.
 * @returns {{
 *   fromRef: string,
 *   toRef: string|null,
 *   staged: boolean,
 *   file: string|null,
 *   unified: string,
 *   additions: number,
 *   deletions: number,
 *   hunks: number,
 *   changedFiles: Array<{ status: string, path: string }>
 * }}
 */
function gitDiff(repoDir, fromRef, toRef, filePath, staged) {
  // Validate refs and optional file path for shell safety
  if (fromRef) assertSafeArg(fromRef, "from_ref");
  if (toRef)   assertSafeArg(toRef,   "to_ref");
  if (filePath) assertSafeArg(filePath, "file");

  // Build the git diff command
  // --unified=3 ensures 3 lines of context (standard unified diff)
  let cmd = "diff --unified=3";

  if (staged) {
    cmd += " --cached";
  }

  if (fromRef && toRef) {
    // Commit-to-commit diff
    cmd += ` ${q(fromRef)} ${q(toRef)}`;
  } else if (fromRef) {
    // Working tree vs a specific ref
    cmd += ` ${q(fromRef)}`;
  } else if (!staged) {
    // Default: working tree vs HEAD
    cmd += " HEAD";
  }
  // For staged=true with no refs, --cached alone diffs index vs HEAD

  if (filePath) {
    cmd += ` -- ${q(filePath)}`;
  }

  let unified = "";
  try {
    unified = gitExec(cmd, repoDir);
  } catch (e) {
    // git diff exits 0 when no changes, 1 when there are changes (with --exit-code),
    // but without --exit-code it always exits 0 unless an error occurs.
    // Real errors (bad ref, not a repo) will throw.
    throw new Error(`git diff failed: ${e.message.split("\n")[0]}`);
  }

  // Parse the unified diff to extract statistics and changed file list
  let additions = 0;
  let deletions = 0;
  let hunks = 0;
  const changedFiles = [];
  let currentStatus = "M"; // default status if we can't determine from diff header

  const lines = unified.split("\n");
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      // e.g. "diff --git a/path/to/file b/path/to/file"
      // Extract the new-side filename (after " b/")
      const m = line.match(/^diff --git a\/.+ b\/(.+)$/);
      if (m) changedFiles.push({ status: currentStatus, path: m[1] });
      currentStatus = "M"; // reset to modified for next file
    } else if (line.startsWith("new file mode")) {
      // Next "diff --git" line's file is newly added
      if (changedFiles.length > 0) changedFiles[changedFiles.length - 1].status = "A";
    } else if (line.startsWith("deleted file mode")) {
      if (changedFiles.length > 0) changedFiles[changedFiles.length - 1].status = "D";
    } else if (line.startsWith("rename from ") || line.startsWith("rename to ")) {
      if (changedFiles.length > 0) changedFiles[changedFiles.length - 1].status = "R";
    } else if (line.startsWith("@@")) {
      hunks++;
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      additions++;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      deletions++;
    }
  }

  return {
    fromRef:      fromRef || (staged ? "HEAD (staged)" : "HEAD"),
    toRef:        toRef   || null,
    staged:       !!staged,
    file:         filePath || null,
    unified,
    additions,
    deletions,
    hunks,
    changedFiles,
  };
}

module.exports = { gitStatus, gitLog, gitBlame, gitDiff };
