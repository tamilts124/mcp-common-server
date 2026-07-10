## Status legend
todo / in-progress / done / tested / blocked

## History
Completed task entries older than the ones below are archived in task-history.md to keep this file cheap to read each session.

## Tasks

- [x] Add find_missing_try_catch_in_async + find_unhandled_rejection_patterns tools — status: tested (v4.129.0)
- [x] Add find_memory_leak_patterns + find_circular_reference_risks tools — status: tested (v4.130.0)
- [x] Add find_promise_constructor_antipattern + find_event_emitter_leak tools — status: tested (v4.131.0)
- [x] Add find_sql_injection_risk + find_command_injection_risk tools — status: tested (26/26 + 21/21, v4.132.0)
  - notes: Fixed previous-session dispatchScan3.js + run-tests.js corruption. Both tools wired, tested, pushed.
- [x] Add find_xss_risk + find_path_traversal_risk tools — status: tested (9/9 + 10/10, v4.133.0)
  - notes: xssRiskOps.js + pathTraversalOps.js existed from prev session; wired dispatch handlers + schemas; all tests pass.
- [x] Add find_timing_attack_risk + find_missing_input_validation tools — status: tested (25/25, v4.134.0)
  - notes: timingAttackOps.js + missingInputValidationOps.js + dispatchScan4.js existed; wired dispatchScan4 into dispatchScan3 chain; fixed multiline /xi regex in missingInputValidationOps.js; added schemas to utilSchemas4.js; 25/25 tests pass.
- [x] Add find_insecure_deserialization + find_prototype_pollution_via_merge tools — status: tested (24/24, v4.135.0)
  - notes: insecureDeserializationOps.js + prototypePollutionMergeOps.js created; wired into dispatchScan4.js; schemas added to utilSchemas4.js; 24/24 tests pass.

- [ ] Proactive: add find_race_condition_risk + find_unvalidated_redirect tools — status: todo
  - notes: find_race_condition_risk: non-atomic read-then-write sequences on shared mutable state (module-scope vars written inside async handlers without locking/atomic ops); find_unvalidated_redirect: res.redirect() / location.href / window.location assignments with dynamic values from req.* without an allowlist or origin check (complements find_open_redirect_risks but focused on internal redirect patterns).
