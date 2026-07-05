"use strict";
// ── SCAN / STATIC-ANALYSIS TOOL DISPATCH HANDLERS ──────────────────────────
// Extracted from lib/dispatchRead.js (which had grown past the 500-line
// convention again after #85/#86) — same extraction pattern as
// lib/dispatchGit.js (#84). Pure move, no behavior change. Covers the
// directory-scan / static-analysis tool family: content scanners
// (scan_todos, scan_conflict_markers, scan_secrets, check_line_endings),
// filesystem analysis (find_large_files, find_empty_dirs, find_duplicates,
// compare_directories, file_diff_dir), and JS/TS + package.json static
// analysis (find_circular_deps, find_dead_exports, find_unused_dependencies,
// package_json_audit, readme_link_check).

const path = require("path");
const { resolveClientPath } = require("./roots");
const { scanTodos } = require("./scanTodosOps");
const { scanConflictMarkers } = require("./scanConflictMarkersOps");
const { scanSecrets } = require("./scanSecretsOps");
const { checkLineEndings } = require("./lineEndingsOps");
const { findLargeFiles } = require("./largeFilesOps");
const { findEmptyDirs } = require("./emptyDirsOps");
const { findDuplicates } = require("./duplicateOps");
const { compareDirectories } = require("./compareOps");
const { fileDiffDir } = require("./dirDiffOps");
const { dirDiffSummary } = require("./dirDiffSummaryOps");
const { findBinaryDiffs } = require("./findBinaryDiffsOps");
const { packageJsonAudit } = require("./packageJsonAuditOps");
const { checkPackageLockSync } = require("./packageLockSyncOps");
const { scanDockerfileIssues } = require("./dockerfileAuditOps");
const { readmeLinkCheck } = require("./readmeLinkCheckOps");
const { findCircularDeps } = require("./circularDepsOps");
const { findDeadExports } = require("./deadExportsOps");
const { findUnusedDependencies } = require("./unusedDepsOps");
const { findConsoleLogs } = require("./consoleLogsOps");
const { findDuplicateDependencies } = require("./duplicateDepsOps");
const { checkBranchProtectionHints } = require("./branchProtectionHintsOps");
const { findHardcodedIps } = require("./findHardcodedIpsOps");
const { findEnvVarUsage } = require("./findEnvVarUsageOps");
const { gitHooksAudit } = require("./gitHooksAuditOps");
const { checkNpmAuditCache } = require("./npmAuditCacheOps");
const { findUnreachableModules } = require("./unreachableModulesOps");
const { scanDependencyLicenses } = require("./dependencyLicensesOps");
const { findOrphanedTestFiles } = require("./orphanedTestFilesOps");
const { checkTestCoverageGaps } = require("./coverageGapsOps");
const { findMissingAwait } = require("./missingAwaitOps");

const SCAN_DISPATCH = {

  find_duplicates(args) {
    const { alias, resolved } = resolveClientPath(args.path || ".");
    return {
      path: args.path || ".",
      ...findDuplicates(resolved, alias, {
        algorithm:  args.algorithm,
        extensions: args.extensions,
        minSize:    args.min_size,
      }),
    };
  },

  compare_directories(args) {
    const { resolved: leftResolved } = resolveClientPath(args.left);
    const { resolved: rightResolved } = resolveClientPath(args.right);
    return {
      left: args.left,
      right: args.right,
      ...compareDirectories(leftResolved, rightResolved, {
        algorithm:  args.algorithm,
        extensions: args.extensions,
      }),
    };
  },

  file_diff_dir(args) {
    const { resolved: leftResolved } = resolveClientPath(args.left);
    const { resolved: rightResolved } = resolveClientPath(args.right);
    return fileDiffDir(leftResolved, rightResolved, args.left, args.right, {
      algorithm:     args.algorithm,
      extensions:    args.extensions,
      max_diff_lines: args.max_diff_lines,
      context:       args.context,
    });
  },

  dir_diff_summary(args) {
    const { resolved: leftResolved } = resolveClientPath(args.left);
    const { resolved: rightResolved } = resolveClientPath(args.right);
    return dirDiffSummary(leftResolved, rightResolved, args.left, args.right, {
      extensions:           args.extensions,
      max_files:            args.max_files,
      include_unified_diff: args.include_unified_diff,
    });
  },

  find_binary_diffs(args) {
    const { resolved: leftResolved } = resolveClientPath(args.left);
    const { resolved: rightResolved } = resolveClientPath(args.right);
    return findBinaryDiffs(leftResolved, rightResolved, args.left, args.right, {
      extensions: args.extensions,
      max_files:  args.max_files,
      algorithm:  args.algorithm,
    });
  },

  scan_todos(args) {
    const { alias, resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || alias || ".";
    return scanTodos(resolved, origPath, {
      markers:       args.markers,
      extensions:    args.extensions,
      caseSensitive: args.case_sensitive,
      maxMatches:    args.max_matches,
    });
  },

  scan_conflict_markers(args) {
    const { alias, resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || alias || ".";
    return scanConflictMarkers(resolved, origPath, {
      extensions: args.extensions,
      maxMatches: args.max_matches,
    });
  },

  scan_secrets(args) {
    const { alias, resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || alias || ".";
    return scanSecrets(resolved, origPath, {
      extensions: args.extensions,
      maxMatches: args.max_matches,
    });
  },

  check_line_endings(args) {
    const { alias, resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || alias || ".";
    return checkLineEndings(resolved, origPath, {
      extensions:    args.extensions,
      maxMixedFiles: args.max_mixed_files,
    });
  },

  find_large_files(args) {
    const { alias, resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || alias || ".";
    return findLargeFiles(resolved, origPath, {
      minBytes:   args.min_bytes,
      topN:       args.top_n,
      extensions: args.extensions,
    });
  },

  find_empty_dirs(args) {
    const { alias, resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || alias || ".";
    return findEmptyDirs(resolved, origPath, {
      maxResults: args.max_results,
    });
  },

  package_json_audit(args) {
    const { alias, resolved } = resolveClientPath(args.path);
    const origPath = args.path || alias;
    return packageJsonAudit(resolved, path.dirname(resolved), origPath);
  },

  check_package_lock_sync(args) {
    const pkgClientPath = args.pkg_path || "package.json";
    const lockClientPath = args.lock_path || "package-lock.json";
    const { resolved: pkgResolved } = resolveClientPath(pkgClientPath);
    const { resolved: lockResolved } = resolveClientPath(lockClientPath);
    return checkPackageLockSync(pkgResolved, lockResolved, pkgClientPath, lockClientPath, {
      blocks: args.blocks,
    });
  },

  scan_dependency_licenses(args) {
    const clientPath = args.path ? path.join(args.path, "node_modules") : "node_modules";
    const { resolved } = resolveClientPath(clientPath);
    return scanDependencyLicenses(resolved, clientPath, {
      disallowed: args.disallowed,
      flag_categories: args.flag_categories,
      max_results: args.max_results,
    });
  },

  scan_dockerfile_issues(args) {
    const clientPath = args.path || "Dockerfile";
    const { resolved } = resolveClientPath(clientPath);
    return scanDockerfileIssues(resolved, clientPath);
  },

  readme_link_check(args) {
    const { alias, resolved } = resolveClientPath(args.path);
    const origPath = args.path || alias;
    return readmeLinkCheck(resolved, origPath);
  },

  check_branch_protection_hints(args) {
    const { alias, resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || alias || ".";
    return checkBranchProtectionHints(resolved, origPath);
  },

  find_hardcoded_ips(args) {
    const { alias, resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || alias || ".";
    return findHardcodedIps(resolved, origPath, {
      extensions: args.extensions,
      maxMatches: args.max_matches,
      includePrivate: args.include_private,
    });
  },

  find_env_var_usage(args) {
    const { alias, resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || alias || ".";
    const scanPath = args.path || ".";
    const envFileArgs = Array.isArray(args.env_files) && args.env_files.length
      ? args.env_files : [path.join(scanPath, ".env.example"), path.join(scanPath, ".env")];
    const envFiles = envFileArgs.map((p) => {
      const r = resolveClientPath(p);
      return { absPath: r.resolved, origPath: p };
    });
    return findEnvVarUsage(resolved, origPath, envFiles, { extensions: args.extensions });
  },

  git_hooks_audit(args) {
    const { alias, resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || alias || ".";
    const defaultPkgPath = path.join(args.path || ".", "package.json");
    const pkgClientPath = args.pkg_path || defaultPkgPath;
    const pkgRes = resolveClientPath(pkgClientPath);
    const pkgOrigPath = pkgClientPath;
    return gitHooksAudit(resolved, origPath, pkgRes.resolved, pkgOrigPath);
  },

  check_npm_audit_cache(args) {
    const { alias, resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || alias || ".";
    let cachePath;
    if (args.cache_path) {
      const r = resolveClientPath(args.cache_path);
      cachePath = { absPath: r.resolved, origPath: args.cache_path };
    }
    return checkNpmAuditCache(resolved, origPath, {
      cachePath,
      runLive:    args.run_live,
      timeoutMs:  args.timeout_ms,
      maxResults: args.max_results,
    });
  },

  find_unreachable_modules(args) {
    const { alias, resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || alias || ".";
    return findUnreachableModules(resolved, origPath, {
      entryPoints: args.entry_points,
      extensions:  args.extensions,
      maxResults:  args.max_results,
    });
  },

  find_missing_await(args) {
    const { resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || ".";
    return findMissingAwait(resolved, origPath, {
      extensions: args.extensions,
      maxResults: args.max_results,
    });
  },

  find_orphaned_test_files(args) {
    const { resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || ".";
    return findOrphanedTestFiles(resolved, origPath, {
      maxResults: args.max_results,
    });
  },

  check_test_coverage_gaps(args) {
    const { resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || ".";
    return checkTestCoverageGaps(resolved, origPath, {
      excludeFilenames: args.exclude_filenames,
      maxResults: args.max_results,
    });
  },

  find_circular_deps(args) {
    const { alias, resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || alias || ".";
    return findCircularDeps(resolved, origPath, {
      extensions: args.extensions,
      maxCycles:  args.max_cycles,
    });
  },

  find_dead_exports(args) {
    const { alias, resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || alias || ".";
    return findDeadExports(resolved, origPath, {
      extensions: args.extensions,
      maxResults: args.max_results,
    });
  },

  find_unused_dependencies(args) {
    const pkgRes = resolveClientPath(args.pkg_path || "package.json");
    const pkgOrigPath = args.pkg_path || pkgRes.alias || "package.json";
    const scanRes = resolveClientPath(args.path || ".");
    const scanOrigPath = args.path || scanRes.alias || ".";
    return findUnusedDependencies(pkgRes.resolved, pkgOrigPath, scanRes.resolved, scanOrigPath, {
      extensions: args.extensions,
      blocks: args.blocks,
    });
  },

  find_console_logs(args) {
    const { alias, resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || alias || ".";
    return findConsoleLogs(resolved, origPath, {
      methods:    args.methods,
      extensions: args.extensions,
      maxMatches: args.max_matches,
    });
  },

  find_duplicate_dependencies(args) {
    const { alias, resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || alias || ".";
    return findDuplicateDependencies(resolved, origPath, {
      blocks: args.blocks,
    });
  },

};

module.exports = { SCAN_DISPATCH };
