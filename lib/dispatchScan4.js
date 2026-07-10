// ── SCAN / STATIC-ANALYSIS TOOL DISPATCH HANDLERS (part 2c) ────────────────
// Split from dispatchScan3.js when it exceeded 500 lines.
// Merged into SCAN_DISPATCH_3 by lib/dispatchScan3.js.

"use strict";
const { findTimingAttackRisk }          = require("./timingAttackOps");
const { findMissingInputValidation }     = require("./missingInputValidationOps");
const { findInsecureDeserialization }    = require("./insecureDeserializationOps");
const { findPrototypePollutionViaMerge } = require("./prototypePollutionMergeOps");
const { resolveClientPath }              = require("./roots");

const SCAN_DISPATCH_4 = {

  find_timing_attack_risk(args) {
    const { resolved } = resolveClientPath(args.path || '.');
    const origPath = args.path || '.';
    return findTimingAttackRisk(resolved, origPath, {
      extensions: args.extensions,
      maxResults: args.max_results,
    });
  },

  find_missing_input_validation(args) {
    const { resolved } = resolveClientPath(args.path || '.');
    const origPath = args.path || '.';
    return findMissingInputValidation(resolved, origPath, {
      extensions: args.extensions,
      maxResults: args.max_results,
    });
  },

  find_insecure_deserialization(args) {
    const { resolved } = resolveClientPath(args.path || '.');
    const origPath = args.path || '.';
    return findInsecureDeserialization(resolved, origPath, {
      extensions: args.extensions,
      maxResults: args.max_results,
    });
  },

  find_prototype_pollution_via_merge(args) {
    const { resolved } = resolveClientPath(args.path || '.');
    const origPath = args.path || '.';
    return findPrototypePollutionViaMerge(resolved, origPath, {
      extensions: args.extensions,
      maxResults: args.max_results,
    });
  },

};

module.exports = { SCAN_DISPATCH_4 };
