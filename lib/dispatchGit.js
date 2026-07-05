"use strict";
// ── GIT DISPATCH HANDLERS ──────────────────────────────────────────────────
// Extracted from lib/dispatchRead.js (which had grown past the project's
// 500-line convention) so that file can stay focused on non-git read/util
// tools. Each handler is `(args) => result`, same contract as READ_DISPATCH.
const fs   = require("fs");
const path = require("path");

const { ROOTS, resolveClientPath } = require("./roots");
const { findRepoRoot } = require("./gitOpsHelpers");
const { gitStatus, gitLog, gitBlame, gitDiff, gitShow } = require("./gitOps");
const { gitStashList } = require("./gitStashOps");
const { gitBranchList } = require("./gitBranchOps");
const { gitWorktreeList } = require("./gitWorktreeOps");
const { gitTagList } = require("./gitTagOps");
const { gitReflog } = require("./gitReflogOps");
const { gitDanglingCommits } = require("./gitDanglingCommitsOps");
const { gitObjectCount } = require("./gitObjectCountOps");
const { gitCherry } = require("./gitCherryOps");
const { gitOwnership } = require("./gitOwnershipOps");
const { findTodoOwners } = require("./todoOwnersOps");
const { gitUntrackedSize } = require("./gitUntrackedSizeOps");
const { lintMessage, lintCommitRef } = require("./commitLintOps");
const { checkGitignoreCoverage } = require("./gitignoreCoverageOps");
const { gitDiffSummary } = require("./gitDiffSummaryOps");
const { gitBlameHotspots } = require("./gitBlameHotspotsOps");
const { gitFileAge } = require("./gitFileAgeOps");
const { generatePrDescription } = require("./prDescriptionOps");
const { findLargeGitObjects } = require("./gitLargeObjectsOps");
const { checkLfsCoverage } = require("./lfsCoverageOps");
const { predictMergeConflictRisk } = require("./mergeConflictRiskOps");
const { gitContributorsSummary } = require("./gitContributorsOps");
const { findRecentForcePushes } = require("./forcePushDetectOps");
const { checkStashApplyRisk } = require("./stashApplyRiskOps");
const { gitBlameOwnershipDiff } = require("./gitBlameOwnershipDiffOps");
const { gitTagAnnotateAudit } = require("./tagAnnotateAuditOps");
const { checkCommitSignatures } = require("./commitSignatureOps");



// Resolve the *real* git repo root for a git_* tool call, bounded by the
// jailed MCP root the path was validated against.
//
// Every git_* handler below used to hand gitExec() whatever directory
// resolveClientPath() resolved (or the first configured root when no path
// arg was given) and rely on git's own upward .git-discovery, bounded by
// gitOpsHelpers.gitExec's GIT_CEILING_DIRECTORIES=dirname(cwd). That only
// works when cwd is already the repo root: the ceiling is exactly one level
// above cwd, so a target nested two or more levels inside a repo (with no
// .git in its immediate parent) silently fails discovery ("not a git
// repository") even though it plainly is one. This is the same
// "cwd is a subdirectory, not the repo root" gap that git_ownership's audit
// (see lib/gitOwnershipOps.js) found and fixed with a jail-bounded
// findRepoRoot() walk-up — reused here for every other git_* tool so the
// fix isn't limited to just that one tool.
//
// findRepoRoot returning null (no .git found anywhere between the target
// and the jail boundary) falls back to the originally-resolved directory,
// so the underlying git command still runs and surfaces its own clear
// "not a git repository" error — behavior is unchanged for genuinely
// non-git paths, only genuinely-nested-but-real repos are fixed.
function resolveRepoDir(argPath) {
  if (argPath) {
    const { resolved, root } = resolveClientPath(argPath);
    return findRepoRoot(resolved, root) || resolved;
  }
  const [firstRoot] = ROOTS.values();
  return findRepoRoot(firstRoot, firstRoot) || firstRoot;
}

const GIT_DISPATCH = {
  git_status(args) {
    const repoDir = resolveRepoDir(args.path);
    return { path: args.path || ".", ...gitStatus(repoDir) };
  },

  git_untracked_size(args) {
    const repoDir = resolveRepoDir(args.path);
    return gitUntrackedSize(repoDir, args.path || ".", { topN: args.top_n });
  },

  git_log(args) {
    const repoDir = resolveRepoDir(args.path);
    return gitLog(repoDir, args.limit, args.file || null, args.branch || null, !!args.include_files);
  },

  git_blame(args) {
    const { resolved, root } = resolveClientPath(args.path);
    const repoDir = findRepoRoot(path.dirname(resolved), root) || path.dirname(resolved);
    return gitBlame(resolved, repoDir, args.from_line ?? null, args.to_line ?? null);
  },

  git_diff(args) {
    const repoDir = resolveRepoDir(args.path);
    return gitDiff(
      repoDir,
      args.from_ref  || null,
      args.to_ref    || null,
      args.file      || null,
      args.staged    || false,
      args.stat_only || false,
    );
  },

  git_stash_list(args) {
    const repoDir = resolveRepoDir(args.path);
    return gitStashList(repoDir);
  },

  git_branch_list(args) {
    const repoDir = resolveRepoDir(args.path);
    return gitBranchList(repoDir, args.include_remote || false);
  },

  find_stale_branches(args) {
    const repoDir = resolveRepoDir(args.path);
    return findStaleBranches(repoDir, args.days, args.include_remote || false);
  },

  git_commit_message_lint(args) {
    const opts = { max_subject_length: args.max_subject_length, require_type: args.require_type };
    if (args.message !== undefined) return lintMessage(args.message, opts);
    const repoDir = resolveRepoDir(args.path);
    return lintCommitRef(repoDir, args.ref, opts);
  },

  git_worktree_list(args) {
    const repoDir = resolveRepoDir(args.path);
    return gitWorktreeList(repoDir);
  },

  git_show(args) {
    const repoDir = resolveRepoDir(args.path);
    return gitShow(repoDir, args.ref || null, args.file);
  },

  git_tag_list(args) {
    const repoDir = resolveRepoDir(args.path);
    return gitTagList(repoDir);
  },

  git_reflog(args) {
    const repoDir = resolveRepoDir(args.path);
    return gitReflog(repoDir, args.ref || null, args.limit);
  },

  git_dangling_commits(args) {
    const repoDir = resolveRepoDir(args.path);
    return gitDanglingCommits(repoDir, args.limit);
  },

  git_object_count(args) {
    const repoDir = resolveRepoDir(args.path);
    return gitObjectCount(repoDir);
  },


  git_cherry(args) {
    const repoDir = resolveRepoDir(args.path);
    return gitCherry(repoDir, args.upstream, args.head || null);
  },

  git_ownership(args) {
    const { resolved, root } = resolveClientPath(args.path);
    const stat = fs.statSync(resolved);
    const isDirectory = stat.isDirectory();
    return gitOwnership(resolved, args.path, isDirectory, root, {
      maxFiles:   args.max_files,
      extensions: args.extensions,
    });
  },

  check_gitignore_coverage(args) {
    const repoDir = resolveRepoDir(args.path);
    return checkGitignoreCoverage(repoDir, args.paths);
  },

  git_diff_summary(args) {
    const repoDir = resolveRepoDir(args.path);
    return gitDiffSummary(
      repoDir,
      args.from_ref || null,
      args.to_ref   || null,
      args.file     || null,
      args.staged   || false,
      { topN: args.top_n },
    );
  },

  git_blame_hotspots(args) {
    const repoDir = resolveRepoDir(args.path);
    return gitBlameHotspots(repoDir, args.path || ".", {
      sinceDays:  args.since_days,
      topN:       args.top_n,
      scopePath:  args.file || null,
      extensions: args.extensions,
    });
  },

  git_file_age(args) {
    const repoDir = resolveRepoDir(args.path);
    return gitFileAge(repoDir, args.path || ".", {
      maxFiles:   args.max_files,
      maxCommits: args.max_commits,
      topN:       args.top_n,
      scopePath:  args.file || null,
    });
  },

  generate_pr_description(args) {
    const repoDir = resolveRepoDir(args.path);
    return generatePrDescription(
      repoDir,
      args.from_ref || null,
      args.to_ref   || null,
      args.staged   || false,
      { topN: args.top_n, commitLimit: args.commit_limit },
    );
  },

  find_todo_owners(args) {
    const { resolved, root } = resolveClientPath(args.path);
    const stat = fs.statSync(resolved);
    const isDirectory = stat.isDirectory();
    return findTodoOwners(resolved, args.path, isDirectory, root, {
      markers:       args.markers,
      extensions:    args.extensions,
      caseSensitive: args.case_sensitive,
      maxMarkers:    args.max_markers,
    });
  },

  find_large_git_objects(args) {
    const repoDir = resolveRepoDir(args.path);
    return findLargeGitObjects(repoDir, {
      topN:         args.top_n,
      minSizeBytes: args.min_size_bytes,
      maxObjects:   args.max_objects,
    });
  },

  check_lfs_coverage(args) {
    const repoDir = resolveRepoDir(args.path);
    return checkLfsCoverage(repoDir, args.paths, {
      minSizeBytes: args.min_size_bytes,
      maxFiles:     args.max_files,
    });
  },

  merge_conflict_risk(args) {
    const repoDir = resolveRepoDir(args.path);
    return predictMergeConflictRisk(repoDir, args.branch_a, args.branch_b, { topN: args.top_n });
  },

  git_contributors_summary(args) {
    const repoDir = resolveRepoDir(args.path);
    return gitContributorsSummary(repoDir, {
      range: args.range || null,
      topN:  args.top_n,
      since: args.since || null,
    });
  },

  find_recent_force_pushes(args) {
    const repoDir = resolveRepoDir(args.path);
    return findRecentForcePushes(repoDir, args.ref || null, args.limit);
  },

  check_stash_apply_risk(args) {
    const repoDir = resolveRepoDir(args.path);
    return checkStashApplyRisk(repoDir, args.stash || null);
  },

  git_blame_ownership_diff(args) {
    const { resolved, root } = resolveClientPath(args.path);
    if (fs.statSync(resolved).isDirectory()) {
      throw new Error("git_blame_ownership_diff: path must be a single file, not a directory.");
    }
    return gitBlameOwnershipDiff(resolved, args.path, root, args.ref_a, args.ref_b || null);
  },

  git_tag_annotate_audit(args) {
    const repoDir = resolveRepoDir(args.path);
    return gitTagAnnotateAudit(repoDir);
  },

  check_commit_signatures(args) {
    const repoDir = resolveRepoDir(args.path);
    return checkCommitSignatures(repoDir, args.ref || null, args.limit);
  },
};

module.exports = { GIT_DISPATCH, resolveRepoDir };
