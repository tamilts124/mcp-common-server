"use strict";
// ── CHECK_COMMIT_SIGNATURES — GPG/SSH signature status for recent commits ──
// Reports git's own recorded signature-verification status (%G? from
// `git log`) for the most recent commits on a ref — supply-chain-conscious
// repos/branch-protection rules often require signed commits, and no
// existing tool here surfaces that. A single `git log` call classifies
// every commit's status without invoking `git verify-commit` per commit
// (which would mean N git processes instead of 1).
// Read-only — does not require MCP_ALLOW_EXEC=true.
const { gitExec, assertSafeArg, q } = require("./gitOpsHelpers");

const DEFAULT_LIMIT = 20;
const HARD_MAX_LIMIT = 200;

// git's own %G? codes (see git-log(1), PRETTY FORMATS -> %G?).
const STATUS_MEANINGS = {
  G: "good signature",
  B: "bad signature",
  U: "good signature, unknown validity",
  X: "good signature that has expired",
  Y: "good signature made by an expired key",
  R: "good signature made by a revoked key",
  E: "signature could not be checked (e.g. missing key)",
  N: "no signature",
};
const SIGNED_STATUSES = new Set(["G", "U", "X", "Y"]); // has a cryptographically valid signature, even if the key/expiry itself is imperfect
const BAD_STATUSES = new Set(["B", "R"]); // actively bad — do not trust

/**
 * @param {string} repoDir  Absolute path inside (or at) the git working tree.
 * @param {string} [ref]    Ref to walk (default "HEAD").
 * @param {number} [limit]  Max commits to scan (1-200, default 20).
 * @returns {{
 *   ref: string, totalScanned: number,
 *   signedCount: number, unsignedCount: number, badCount: number,
 *   commits: Array<{ hash, shortHash, status, statusMeaning, signed, bad, signer, subject }>
 * }}
 */
function checkCommitSignatures(repoDir, ref, limit) {
  const targetRef = (ref && ref.trim()) ? ref.trim() : "HEAD";
  assertSafeArg(targetRef, "ref");

  let n = parseInt(limit, 10);
  if (!Number.isFinite(n) || n < 1) n = DEFAULT_LIMIT;
  n = Math.min(Math.max(1, n), HARD_MAX_LIMIT);

  const SEP = "\x1f";
  const REC = "\x1e";
  const fmt = `%H${SEP}%h${SEP}%G?${SEP}%GS${SEP}%s${REC}`;

  let raw;
  try {
    raw = gitExec(`log --pretty=format:${q(fmt)} -n ${n} ${q(targetRef)}`, repoDir);
  } catch (e) {
    const fullMsg = e.message || "";
    if (/unknown revision|bad revision|ambiguous argument/i.test(fullMsg)) {
      try { gitExec("rev-parse --is-inside-work-tree", repoDir); }
      catch (_) { throw new Error("check_commit_signatures: not a git repository."); }
      throw new Error(`check_commit_signatures: unknown ref '${targetRef}'.`);
    }
    if (/does not have any commits yet|unborn/i.test(fullMsg)) {
      return { ref: targetRef, totalScanned: 0, signedCount: 0, unsignedCount: 0, badCount: 0, commits: [] };
    }
    try { gitExec("rev-parse --is-inside-work-tree", repoDir); }
    catch (_) { throw new Error("check_commit_signatures: not a git repository."); }
    throw new Error(`check_commit_signatures: ${fullMsg.split("\n")[0]}`);
  }

  const commits = [];
  let signedCount = 0, unsignedCount = 0, badCount = 0;

  for (const record of raw.split(REC)) {
    const trimmed = record.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(SEP);
    if (parts.length < 5) continue;

    const status = parts[2].trim() || "N";
    const signed = SIGNED_STATUSES.has(status);
    const bad = BAD_STATUSES.has(status);
    if (bad) badCount++;
    else if (signed) signedCount++;
    else unsignedCount++;

    commits.push({
      hash: parts[0].trim(),
      shortHash: parts[1].trim(),
      status,
      statusMeaning: STATUS_MEANINGS[status] || "unrecognized status code",
      signed,
      bad,
      signer: parts[3].trim() || null,
      subject: parts[4].trim(),
    });
  }

  return {
    ref: targetRef,
    totalScanned: commits.length,
    signedCount,
    unsignedCount,
    badCount,
    commits,
  };
}

module.exports = { checkCommitSignatures };
