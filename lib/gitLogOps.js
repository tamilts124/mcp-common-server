"use strict";
// ── GIT LOG — commit history, optionally with per-commit files-changed ─────────
// Extracted from lib/gitOps.js (which had grown past the 500-line threshold)
// so gitOps.js can stay a thin collection of the other git metadata tools.
//
// git_log's optional `include_files` extension attaches a
// `filesChanged: [{path, additions, deletions}]` array to each commit,
// letting an agent see what the last N commits touched without a separate
// git_show/git_diff call per commit.

const { gitExec, assertSafeArg, q } = require("./gitOpsHelpers");

// Parses the per-commit `--numstat` block produced by a *separate*, minimal
// `git log --numstat --format=%H<REC>` invocation (see gitLog's includeFiles
// branch below) into a hash -> files[] map.
//
// Deliberately run as its own gitExec call with a bare %H format (no %b body
// field) rather than folding --numstat into the main metadata command:
// commit bodies can contain arbitrary newlines, which would make it
// ambiguous where one commit's interleaved numstat block ends and the next
// commit's formatted header begins. A 40-hex-char hash has no such
// ambiguity, so the two commands are combined by matching on hash instead.
function parseNumstatByHash(raw) {
  const byHash = new Map();
  // Matches "<40-hex-hash><REC>" — each occurrence marks where the previous
  // commit's numstat block ends and this commit's block begins.
  const hashRe = /([0-9a-f]{40})\x1e/g;
  const matches = [];
  let m;
  while ((m = hashRe.exec(raw)) !== null) {
    matches.push({ hash: m[1], blockStart: hashRe.lastIndex });
  }
  for (let i = 0; i < matches.length; i++) {
    const blockStart = matches[i].blockStart;
    const blockEnd = i + 1 < matches.length ? matches[i + 1].blockStart - matches[i + 1].hash.length - 1 : raw.length;
    const block = raw.slice(blockStart, Math.max(blockStart, blockEnd));
    const files = [];
    for (const line of block.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split("\t");
      if (parts.length < 3) continue; // not a numstat row
      const [addRaw, delRaw, path] = parts;
      const isBinary = addRaw.trim() === "-" || delRaw.trim() === "-";
      files.push({
        path,
        additions: isBinary ? null : (parseInt(addRaw, 10) || 0),
        deletions: isBinary ? null : (parseInt(delRaw, 10) || 0),
      });
    }
    byHash.set(matches[i].hash, files);
  }
  return byHash;
}

/**
 * Return the last `limit` commits reachable from HEAD (or filtered by `filePath`).
 *
 * @param {string}      repoDir      Absolute path inside the git working tree.
 * @param {number}      limit        Max commits to return (1–200, default 20).
 * @param {string|null} filePath     Optional: only show commits touching this path.
 * @param {string|null} branch       Optional: ref/branch to read log from (default HEAD).
 * @param {boolean}     [includeFiles=false]  When true, each commit also gets a
 *                                    `filesChanged: [{path, additions, deletions}]`
 *                                    array (additions/deletions are `null` for
 *                                    binary files, matching git_diff's stat_only
 *                                    convention). Costs a second `git log` call.
 * @returns {{
 *   ref: string,
 *   count: number,
 *   commits: Array<{
 *     hash: string, shortHash: string,
 *     author: string, email: string,
 *     date: string,      // ISO 8601
 *     subject: string,
 *     body: string,      // may be empty
 *     filesChanged?: Array<{ path: string, additions: number|null, deletions: number|null }>
 *   }>
 * }}
 */
function gitLog(repoDir, limit, filePath, branch, includeFiles) {
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

  if (includeFiles && commits.length > 0) {
    let filesRaw;
    try {
      let filesCmd = `log -n ${n} --numstat --format=%H${REC}`;
      if (ref !== "HEAD") filesCmd += ` ${q(ref)}`;
      if (filePath) filesCmd += ` -- ${q(filePath)}`;
      filesRaw = gitExec(filesCmd, repoDir);
    } catch (e) {
      throw new Error(`git log --numstat failed: ${e.message.split("\n")[0]}`);
    }
    const byHash = parseNumstatByHash(filesRaw);
    for (const c of commits) {
      c.filesChanged = byHash.get(c.hash) || [];
    }
  }

  return { ref, count: commits.length, commits };
}

module.exports = { gitLog, parseNumstatByHash };
