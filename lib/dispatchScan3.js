"use strict";
// ── SCAN / STATIC-ANALYSIS TOOL DISPATCH HANDLERS (part 2b) ────────────────
// Second half of the former lib/dispatchScan2.js, split out to stay under
// the project's 500-line-file convention. Merged into SCAN_DISPATCH_2 by
// lib/dispatchScan2.js.

const { resolveClientPath } = require("./roots");
const { summarizePackageScripts } = require("./packageScriptsOps");
const { checkMissingEnginesField } = require("./enginesFieldOps");
const { findMissingShebangInBinScripts } = require("./shebangCheckOps");
const { findMissingReturnAfterResSend } = require("./missingReturnAfterResSendOps");
const { checkDockerComposeIssues } = require("./dockerComposeAuditOps");
const { findMissingStreamErrorHandler } = require("./streamErrorHandlerOps");
const { findSetIntervalWithoutClear } = require("./setIntervalLeakOps");
const { findJsonParseWithoutTryCatch } = require("./jsonParseTryCatchOps");
const { findMissingFindIndexCheck } = require("./findIndexGuardOps");
const { findSharedDefaultMutation } = require("./sharedDefaultMutationOps");
const { findMissingCleanupOnEarlyReturn } = require("./cleanupEarlyReturnOps");
const { findInconsistentErrorResponseShape } = require("./inconsistentErrorShapeOps");
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
const { findAsyncCallbackInForEach } = require("./asyncForEachOps");
const { findMissingImgAltText } = require("./imgAltTextOps");
const { findMissingFormLabel } = require("./formLabelOps");
const { findMissingButtonAccessibleName } = require("./buttonLinkAccessibleNameOps");
const { findDuplicateHtmlId } = require("./duplicateIdOps");

const SCAN_DISPATCH_3 = {
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

  find_async_callback_in_foreach(args) {
    const { resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || ".";
    return findAsyncCallbackInForEach(resolved, origPath, {
      extensions: args.extensions,
      maxResults: args.max_results,
    });
  },

  find_missing_img_alt_text(args) {
    const { resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || ".";
    return findMissingImgAltText(resolved, origPath, {
      extensions: args.extensions,
      maxResults: args.max_results,
    });
  },

  find_missing_form_label(args) {
    const { resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || ".";
    return findMissingFormLabel(resolved, origPath, {
      extensions: args.extensions,
      maxResults: args.max_results,
    });
  },

  find_missing_button_accessible_name(args) {
    const { resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || ".";
    return findMissingButtonAccessibleName(resolved, origPath, {
      extensions: args.extensions,
      maxResults: args.max_results,
    });
  },

  find_duplicate_html_id(args) {
    const { resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || ".";
    return findDuplicateHtmlId(resolved, origPath, {
      extensions: args.extensions,
      maxResults: args.max_results,
    });
  },

};

module.exports = { SCAN_DISPATCH_3 };
