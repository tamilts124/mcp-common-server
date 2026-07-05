"use strict";
// ── SCAN / STATIC-ANALYSIS TOOL DISPATCH HANDLERS (part 2a) ────────────────
// First half of the former lib/dispatchScan2.js (which itself was part 2 of
// the original lib/dispatchScan.js), split further to stay under the
// project's 500-line-file convention. Second half now lives in
// lib/dispatchScan3.js, merged back via Object.assign below.

const { resolveClientPath } = require("./roots");
const { findCircularDeps } = require("./circularDepsOps");
const { findDeadExports } = require("./deadExportsOps");
const { findUnusedDependencies } = require("./unusedDepsOps");
const { findConsoleLogs } = require("./consoleLogsOps");
const { findDuplicateDependencies } = require("./duplicateDepsOps");
const { findOrphanedTestFiles } = require("./orphanedTestFilesOps");
const { checkTestCoverageGaps } = require("./coverageGapsOps");
const { findEmptyCatchBlocks } = require("./emptyCatchBlocksOps");
const { findSyncFsInAsyncContext } = require("./syncFsInAsyncOps");
const { findHardcodedCredentialsInConfig } = require("./hardcodedCredentialsConfigOps");
const { findHardcodedPorts } = require("./hardcodedPortsOps");
const { findDanglingPromises } = require("./danglingPromisesOps");
const { findInsecureRandomUsage } = require("./insecureRandomOps");
const { findUnboundedRecursion } = require("./unboundedRecursionOps");
const { checkDockerignoreCoverage } = require("./dockerignoreCoverageOps");
const { checkTestFlakinessRisk } = require("./testFlakinessRiskOps");
const { checkMissingCspHeader } = require("./cspHeaderOps");
const { findMissingSortComparator } = require("./missingSortComparatorOps");
const { findReqBodyMassAssignment } = require("./reqBodyMassAssignmentOps");
const { findPrototypePollutionRisk } = require("./prototypePollutionOps");
const { checkMissingRateLimit } = require("./rateLimitHintOps");
const { checkDependencyConfusionRisk } = require("./dependencyConfusionOps");
const { findErrorMessageLeakingInternals } = require("./errorLeakOps");
const { findDisabledTlsVerification } = require("./tlsVerificationOps");
const { SCAN_DISPATCH_3 } = require("./dispatchScan3");

const SCAN_DISPATCH_2 = {
  find_empty_catch_blocks(args) {
    const { resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || ".";
    return findEmptyCatchBlocks(resolved, origPath, {
      extensions: args.extensions,
      maxResults: args.max_results,
    });
  },

  find_sync_fs_in_async_context(args) {
    const { resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || ".";
    return findSyncFsInAsyncContext(resolved, origPath, {
      extensions: args.extensions,
      maxResults: args.max_results,
    });
  },

  find_hardcoded_credentials_in_config(args) {
    const { resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || ".";
    return findHardcodedCredentialsInConfig(resolved, origPath, {
      extensions: args.extensions,
      maxResults: args.max_results,
    });
  },

  find_hardcoded_ports(args) {
    const { resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || ".";
    return findHardcodedPorts(resolved, origPath, {
      extensions: args.extensions,
      maxResults: args.max_results,
    });
  },

  find_dangling_promises(args) {
    const { resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || ".";
    return findDanglingPromises(resolved, origPath, {
      extensions: args.extensions,
      maxResults: args.max_results,
    });
  },

  find_insecure_random_usage(args) {
    const { resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || ".";
    return findInsecureRandomUsage(resolved, origPath, {
      extensions: args.extensions,
      maxResults: args.max_results,
    });
  },

  find_unbounded_recursion(args) {
    const { resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || ".";
    return findUnboundedRecursion(resolved, origPath, {
      extensions: args.extensions,
      maxResults: args.max_results,
    });
  },

  check_dockerignore_coverage(args) {
    const { resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || ".";
    return checkDockerignoreCoverage(resolved, origPath, args.paths, args.dockerignore_path);
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

  check_test_flakiness_risk(args) {
    const { resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || ".";
    return checkTestFlakinessRisk(resolved, origPath, {
      extensions: args.extensions,
      maxResults: args.max_results,
    });
  },

  check_missing_csp_header(args) {
    const { resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || ".";
    return checkMissingCspHeader(resolved, origPath, {
      extensions: args.extensions,
      maxResults: args.max_results,
    });
  },

  find_missing_sort_comparator(args) {
    const { resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || ".";
    return findMissingSortComparator(resolved, origPath, {
      extensions: args.extensions,
      maxResults: args.max_results,
    });
  },

  find_req_body_mass_assignment(args) {
    const { resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || ".";
    return findReqBodyMassAssignment(resolved, origPath, {
      extensions: args.extensions,
      maxResults: args.max_results,
    });
  },

  find_prototype_pollution_risk(args) {
    const { resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || ".";
    return findPrototypePollutionRisk(resolved, origPath, {
      extensions: args.extensions,
      maxResults: args.max_results,
    });
  },

  check_missing_rate_limit(args) {
    const { resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || ".";
    return checkMissingRateLimit(resolved, origPath, {
      extensions: args.extensions,
      maxResults: args.max_results,
    });
  },

  check_dependency_confusion_risk(args) {
    const pkgClientPath = args.pkg_path || "package.json";
    const { resolved } = resolveClientPath(pkgClientPath);
    return checkDependencyConfusionRisk(resolved, pkgClientPath, {
      blocks: args.blocks,
      internalPackagePrefixes: args.internal_package_prefixes,
      maxResults: args.max_results,
    });
  },

  find_error_message_leaking_internals(args) {
    const { resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || ".";
    return findErrorMessageLeakingInternals(resolved, origPath, {
      extensions: args.extensions,
      errorIdentifiers: args.error_identifiers,
      maxResults: args.max_results,
    });
  },

  find_disabled_tls_verification(args) {
    const { resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || ".";
    return findDisabledTlsVerification(resolved, origPath, {
      extensions: args.extensions,
      maxResults: args.max_results,
    });
  },

};

Object.assign(SCAN_DISPATCH_2, SCAN_DISPATCH_3);

module.exports = { SCAN_DISPATCH_2 };
