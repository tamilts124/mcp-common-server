## Status legend
todo / in-progress / done / tested / blocked

## History
Completed task entries older than the ones below are archived in task-history.md to keep this file cheap to read each session.

## Tasks

- [x] Add find_missing_try_catch_in_async + find_unhandled_rejection_patterns tools — status: tested (30/30 + 27/27, all 5 rigor levels, v4.129.0)
  - notes:
    1. find_missing_try_catch_in_async (lib/missingTryCatchAsyncOps.js) — async functions with await but no try/catch. Test: 151 (30/30).
    2. find_unhandled_rejection_patterns (lib/unhandledRejectionOps.js) — missing global rejection handler + noop handlers. Test: 152 (27/27).

- [x] Add find_memory_leak_patterns + find_circular_reference_risks tools — status: tested (31/31 + 28/28, all 5 rigor levels, v4.130.0)
  - notes:
    1. find_memory_leak_patterns (lib/memoryLeakPatternsOps.js) — module-scope caches, DOM refs, accumulating push. Test: 153 (31/31).
    2. find_circular_reference_risks (lib/circularReferenceOps.js) — self-ref, mutual-ref, circular-require. Test: 154 (28/28).

- [x] Add find_promise_constructor_antipattern + find_event_emitter_leak tools — status: tested (26/26 + 26/26, all 5 rigor levels, v4.131.0)
  - notes:
    1. find_promise_constructor_antipattern (lib/promiseConstructorOps.js) — async executor + explicit promise wrap. Test: 155 (26/26).
    2. find_event_emitter_leak (lib/eventEmitterLeakOps.js) — process.on inside function body + emitter.on inside loop. Test: 156 (26/26).

- [x] Add find_sql_injection_risk + find_command_injection_risk tools — status: tested (26/26 + 21/21, all 5 rigor levels, v4.132.0)
  - notes:
    1. find_sql_injection_risk (lib/sqlInjectionOps.js, ~200 lines) — 3 rules: sql_string_concat (error, SQL string + concat with req.* or sensitive-name vars), sql_template_literal (error, template literal with SQL keyword + user-controlled interpolation; suppressed if next line has parameterised-query hint), sql_dynamic_query_variable (warning, *Sql/*Query/*Statement variable built by +=). Suppressions: // safe, // nosql, .query(sql,[), .prepare(), stmt.run(). Test: 157 (26/26).
    2. find_command_injection_risk (lib/commandInjectionOps.js, ~265 lines) — 3 rules: exec_with_concat (error, exec/execSync/spawn/spawnSync/execFile called with template-literal or string-concat arg containing user taint), shell_true_spawn_with_input (error, spawn with {shell:true} + dynamic arg), unvalidated_path_exec (warning, exec with path-like variable and no path.resolve/normalize/allowlist validation). Suppressions: // safe, // noexec, // no-exec. Test: 158 (21/21).
    Both wired in dispatchScan3.js, utilSchemas4.js, execSchemas.js pipeline enum. run-tests.js sections 157+158 added. Fixed previous-session corruption (backtick-r-backtick-n literal in dispatchScan3.js and run-tests.js). Version v4.132.0.
