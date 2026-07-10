## Status legend
todo / in-progress / done / tested / blocked

## History
Completed task entries older than the ones below are archived in task-history.md to keep this file cheap to read each session.

## Tasks

- [x] Add find_missing_try_catch_in_async + find_unhandled_rejection_patterns tools — status: tested (v4.129.0)
- [x] Add find_memory_leak_patterns + find_circular_reference_risks tools — status: tested (v4.130.0)
- [x] Add find_promise_constructor_antipattern + find_event_emitter_leak tools — status: tested (v4.131.0)
- [x] Add find_sql_injection_risk + find_command_injection_risk tools — status: tested (26/26 + 21/21, v4.132.0)
  - notes: Fixed previous-session dispatchScan3.js + run-tests.js corruption (backtick-r-backtick-n literals). Both tools wired, tested, pushed.
- [x] Add find_xss_risk + find_path_traversal_risk tools — status: tested (9/9 + 10/10, v4.133.0)
  - notes: xssRiskOps.js + pathTraversalOps.js existed from prev session; wired dispatch handlers + schemas; all tests pass.
