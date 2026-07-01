"use strict";
// ── GIT CHERRY OPERATIONS ────────────────────────────────────────────────────
// git_cherry — list commits on `head` that are not yet in `upstream`,
// distinguishing truly-unique commits ("+") from commits whose *patch* is
// already present in upstream ("-") even though the commit object itself
// isn't reachable there (e.g. because it was cherry-picked or the branch
// was rebased). This is exactly what `git cherry` was built for, and it is
// NOT the same question `git_diff`/`git_log` with two refs answers — those
// tools compare ancestry/tree state, not patch-equivalence, so a rebased
// commit would misleadingly show up as "still unmerged" under a pure
// ancestry diff even though its actual change is already upstream.
//
// Read-only — does not require MCP_ALLOW_EXEC=true.
const { gitExec, assertSafeArg, q } = require("./gitOpsHelpers");

// ── GIT CHERRY ────────────────────────────────────────────────────────────────
/**
 * Return a structured list of commits unique to `head` relative to
 * `upstream`, using git's own patch-equivalence detection.
 *
 * @param {string} repoDir   Absolute path inside (or at) the git working tree.
 * @param {string} upstream  The branch/ref to compare against (the merge target).
 * @param {string} [head]    The branch/ref to inspect (default "HEAD").
 * @returns {{
 *   upstream: string,
 *   head: string,
 *   count: number,
 *   unmergedCount: number,
 *   equivalentCount: number,
 *   commits: Array<{
 *     hash: string,
 *     shortHash: string,
 *     subject: string,
 *     status: "unmerged" | "equivalent",
 *   }>
 * }}
 */
function gitCherry(repoDir, upstream, head) {
  if (typeof upstream !== "string" || upstream.trim() === "") {
    throw new Error("git_cherry: 'upstream' is required and must be a non-empty string.");
  }
  const u = upstream.trim();
  const h = (head && head.trim()) ? head.trim() : "HEAD";
  assertSafeArg(u, "upstream");
  assertSafeArg(h, "head");

  let raw;
  try {
    // -v also prints the subject line so we don't need a second call.
    raw = gitExec(`cherry -v ${q(u)} ${q(h)}`, repoDir);
  } catch (e) {
    // NOTE: check the *full* error message here, not just its first line —
    // execSync's thrown error message is "Command failed: <cmd>\n<stderr>",
    // so the actual git error text (e.g. "fatal: unknown commit ...") is on
    // a later line, not the first.
    const fullMsg = e.message || "";
    const firstLine = fullMsg.split("\n")[0];
    try { gitExec("rev-parse --is-inside-work-tree", repoDir); }
    catch (_) { throw new Error("git cherry failed: not a git repository."); }
    if (/unknown revision|bad revision|ambiguous argument|unknown commit/i.test(fullMsg)) {
      throw new Error(`git cherry failed: unknown ref (upstream '${u}' or head '${h}').`);
    }
    throw new Error(`git cherry failed: ${firstLine}`);
  }

  const commits = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const marker = trimmed[0]; // "+" or "-"
    if (marker !== "+" && marker !== "-") continue; // defensive; git cherry always prefixes one of these
    const rest = trimmed.slice(1).trim();
    const spaceIdx = rest.indexOf(" ");
    const hash = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
    const subject = spaceIdx === -1 ? "" : rest.slice(spaceIdx + 1).trim();
    commits.push({
      hash,
      shortHash: hash.slice(0, 7),
      subject,
      status: marker === "+" ? "unmerged" : "equivalent",
    });
  }

  const unmergedCount = commits.filter((c) => c.status === "unmerged").length;
  const equivalentCount = commits.length - unmergedCount;

  return { upstream: u, head: h, count: commits.length, unmergedCount, equivalentCount, commits };
}

module.exports = { gitCherry };
