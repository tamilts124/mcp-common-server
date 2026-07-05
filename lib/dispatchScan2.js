"use strict";
// ── SCAN / STATIC-ANALYSIS TOOL DISPATCH HANDLERS (part 2) ─────────────────
// Second half of lib/dispatchScan.js, split out to stay under the project's
// 500-line-file convention. Merged into SCAN_DISPATCH by dispatchScan.js.

const { resolveClientPath } = require("./roots");
const { summarizePackageScripts } = require("./packageScriptsOps");
const { checkMissingEnginesField } = require("./enginesFieldOps");
const { findMissingShebangInBinScripts } = require("./shebangCheckOps");
const { findMissingReturnAfterResSend } = require("./missingReturnAfterResSendOps");
const { checkDockerComposeIssues } = require("./dockerComposeAuditOps");
const { findMissingStreamErrorHandler } = require("./streamErrorHandlerOps");
const { findSetIntervalWithoutClear } = require("./setIntervalLeakOps");
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
const { findJsonParseWithoutTryCatch } = require("./jsonParseTryCatchOps");
const { findMissingFindIndexCheck } = require("./findIndexGuardOps");
const { findSharedDefaultMutation } = require("./sharedDefaultMutationOps");
const { findMissingCleanupOnEarlyReturn } = require("./cleanupEarlyReturnOps");
const { findInconsistentErrorResponseShape } = require("./inconsistentErrorShapeOps");
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
const { findUnpinnedDockerBaseImage } = require("./dockerBaseImagePinningOps");
const { checkMissingHelmetSecurityHeaders } = require("./helmetSecurityHeadersOps");
const { checkMissingRateLimitHeaders } = require("./rateLimitHeaderOps");
const { findDuplicateRouteRegistrations } = require("./duplicateRouteOps");
const { findMissingPaginationLimit } = require("./paginationLimitOps");
const { findMissingErrorBoundaryInAsyncRoute } = require("./asyncErrorBoundaryOps");
const { findMissingWebsocketErrorHandler } = require("./websocketErrorHandlerOps");
const { findUnboundedArrayPushInLoop } = require("./arrayPushLoopOps");
const { findEnvVarDefaultFallbackMaskingErrors } = require("./envFallbackSecretOps");
const { findHardcodedLocalhostUrls } = require("./localhostUrlOps");
const { findHardcodedJwtSecret } = require("./jwtSecretOps");
const { checkInsecureCookieFlags } = require("./cookieFlagsOps");

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

  find_unpinned_docker_base_image(args) {
    const { resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || ".";
    return findUnpinnedDockerBaseImage(resolved, origPath, {
      maxResults: args.max_results,
    });
  },

  check_missing_helmet_security_headers(args) {
    const { resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || ".";
    return checkMissingHelmetSecurityHeaders(resolved, origPath, {
      extensions: args.extensions,
      maxResults: args.max_results,
    });
  },

  check_missing_rate_limit_headers(args) {
    const { resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || ".";
    return checkMissingRateLimitHeaders(resolved, origPath, {
      extensions: args.extensions,
      maxResults: args.max_results,
    });
  },

  find_duplicate_route_registrations(args) {
    const { resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || ".";
    return findDuplicateRouteRegistrations(resolved, origPath, {
      extensions: args.extensions,
      maxResults: args.max_results,
    });
  },

  find_missing_pagination_limit(args) {
    const { resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || ".";
    return findMissingPaginationLimit(resolved, origPath, {
      extensions: args.extensions,
      maxResults: args.max_results,
    });
  },

  find_missing_error_boundary_in_async_route(args) {
    const { resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || ".";
    return findMissingErrorBoundaryInAsyncRoute(resolved, origPath, {
      extensions: args.extensions,
      maxResults: args.max_results,
    });
  },

  find_missing_websocket_error_handler(args) {
    const { resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || ".";
    return findMissingWebsocketErrorHandler(resolved, origPath, {
      extensions: args.extensions,
      maxResults: args.max_results,
    });
  },

  find_unbounded_array_push_in_loop(args) {
    const { resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || ".";
    return findUnboundedArrayPushInLoop(resolved, origPath, {
      extensions: args.extensions,
      maxResults: args.max_results,
    });
  },

  find_env_var_default_fallback_masking_errors(args) {
    const { resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || ".";
    return findEnvVarDefaultFallbackMaskingErrors(resolved, origPath, {
      extensions: args.extensions,
      maxResults: args.max_results,
    });
  },

  find_hardcoded_localhost_urls(args) {
    const { resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || ".";
    return findHardcodedLocalhostUrls(resolved, origPath, {
      extensions: args.extensions,
      maxResults: args.max_results,
      includeTestFiles: args.include_test_files,
    });
  },

  find_json_parse_without_try_catch(args) {
    const { resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || ".";
    return findJsonParseWithoutTryCatch(resolved, origPath, {
      extensions: args.extensions,
      maxResults: args.max_results,
    });
  },

  find_missing_findindex_check(args) {
    const { resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || ".";
    return findMissingFindIndexCheck(resolved, origPath, {
      extensions: args.extensions,
      maxResults: args.max_results,
    });
  },

  find_missing_null_check_on_optional_chaining_default(args) {
    const { resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || ".";
    return findSharedDefaultMutation(resolved, origPath, {
      extensions: args.extensions,
      maxResults: args.max_results,
    });
  },

  find_missing_cleanup_on_early_return(args) {
    const { resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || ".";
    return findMissingCleanupOnEarlyReturn(resolved, origPath, {
      extensions: args.extensions,
      maxResults: args.max_results,
    });
  },

  find_inconsistent_error_response_shape(args) {
    const { resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || ".";
    return findInconsistentErrorResponseShape(resolved, origPath, {
      extensions: args.extensions,
      maxResults: args.max_results,
    });
  },

  find_hardcoded_jwt_secret(args) {
    const { resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || ".";
    return findHardcodedJwtSecret(resolved, origPath, {
      extensions: args.extensions,
      maxResults: args.max_results,
    });
  },

  check_insecure_cookie_flags(args) {
    const { resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || ".";
    return checkInsecureCookieFlags(resolved, origPath, {
      extensions: args.extensions,
      maxResults: args.max_results,
    });
  },

  summarize_package_scripts(args) {
    const clientPath = args.path || "package.json";
    const { resolved } = resolveClientPath(clientPath);
    return summarizePackageScripts(resolved, clientPath);
  },

  check_missing_engines_field(args) {
    const clientPath = args.path || "package.json";
    const { resolved } = resolveClientPath(clientPath);
    return checkMissingEnginesField(resolved, clientPath);
  },

  find_missing_shebang_in_bin_scripts(args) {
    const clientPath = args.path || "package.json";
    const { resolved } = resolveClientPath(clientPath);
    return findMissingShebangInBinScripts(resolved, clientPath);
  },

  find_missing_return_after_res_send(args) {
    const { resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || ".";
    return findMissingReturnAfterResSend(resolved, origPath, {
      extensions: args.extensions,
      maxResults: args.max_results,
    });
  },

  check_docker_compose_issues(args) {
    const clientPath = args.path || "docker-compose.yml";
    const { resolved } = resolveClientPath(clientPath);
    return checkDockerComposeIssues(resolved, clientPath, {
      maxResults: args.max_results,
    });
  },

  find_missing_stream_error_handler(args) {
    const { resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || ".";
    return findMissingStreamErrorHandler(resolved, origPath, {
      extensions: args.extensions,
      maxResults: args.max_results,
    });
  },

  find_setinterval_without_clear(args) {
    const { resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || ".";
    return findSetIntervalWithoutClear(resolved, origPath, {
      extensions: args.extensions,
      maxResults: args.max_results,
    });
  },

};

module.exports = { SCAN_DISPATCH_2 };
