## Status legend
todo / in-progress / done / tested / blocked

## History
Completed task entries older than the ones below are archived in task-history.md to keep this file cheap to read each session.

## Tasks

- [x] Add find_deprecated_html_elements + find_eval_usage tools — status: tested (35/35 + 33/33, all 5 rigor levels, v4.128.0)
  - notes:
    1. find_deprecated_html_elements (lib/deprecatedHtmlOps.js, ~194 lines) — two rules: deprecated_html_element (error, 18 removed HTML5 tags), discouraged_html_element (warning, b/i/s/u). Test: 147 (35/35).
    2. find_eval_usage (lib/evalUsageOps.js, ~206 lines) — three rules: direct_eval (error), new_function_constructor (error), settimeout_string_arg (warning). Test: 148 (33/33).
    Both wired in dispatchScan3.js, utilSchemas4.js, execSchemas.js pipeline enum. run-tests.js sections 147+148 added. Fixed broken utilSchemas4.js (array was closed before find_missing_error_context + find_promise_race_without_timeout schemas). Fixed erroneous requires at top of run-tests.js. Version v4.128.0.

- [x] Add find_missing_error_context + find_promise_race_without_timeout tools — status: tested (28/28 + 32/32, all 5 rigor levels, v4.128.0)
  - notes:
    1. find_missing_error_context (lib/missingErrorContextOps.js, ~270 lines) — two rules: rethrow_without_cause (error, `throw new Error(msg)` without `{ cause: err }`), bare_rethrow (warning, `throw catchVar` unchanged). Fixed extractCatchBody() bug: was failing for single-line catch blocks and `} catch (err) {` patterns by not tracking column position. Test: 149 (28/28).
    2. find_promise_race_without_timeout (lib/promiseRaceTimeoutOps.js, ~261 lines) — two rules: promise_race_no_timeout (error), promise_race_single_item (warning). Detects: setTimeout, AbortSignal.timeout, AbortController, withTimeout, deadline, raceTimeout, timeoutPromise. 15-line inspection window. Test: 150 (32/32).
    Both wired in dispatchScan3.js, utilSchemas4.js, execSchemas.js pipeline enum. run-tests.js sections 149+150 added. Version v4.128.0.

- [x] Add find_missing_try_catch_in_async + find_unhandled_rejection_patterns tools — status: tested (30/30 + 27/27, all 5 rigor levels, v4.129.0)
  - notes:
    1. find_missing_try_catch_in_async (lib/missingTryCatchAsyncOps.js, ~225 lines) — one rule: async_await_no_try_catch (error), async functions that use `await` but have no try/catch block. Brace-depth extraction to find function body. Fixed JSDoc block-comment syntax error in unhandledRejectionOps.js (nested `*/` terminated the outer comment). Test: 151 (30/30).
    2. find_unhandled_rejection_patterns (lib/unhandledRejectionOps.js, ~215 lines) — two rules: missing_global_rejection_handler (warning, entry-point files without process.on handler), noop_rejection_handler (error, empty arrow/function handler). Entry-point detection via basename regex (server, app, index, main, start, bootstrap, entry). Test: 152 (27/27).
    Both wired in dispatchScan3.js, utilSchemas4.js, execSchemas.js pipeline enum. run-tests.js sections 151+152 added. Version v4.129.0.

- [ ] Add find_memory_leak_patterns + find_circular_reference_risks tools — status: todo
  - notes: 1) find_memory_leak_patterns scans JS/TS for common patterns: event listeners added in constructors/useEffect without cleanup, closures capturing large objects in module-scope, growing caches without eviction (Map/Set with .set() but no .delete()/.clear()), storing DOM references in module-scope variables. 2) find_circular_reference_risks scans for direct circular references in JS objects (obj.parent = obj, mutually-referencing singletons) that can cause JSON.stringify to throw and prevent GC in old engines. Both tools complement the existing find_setinterval_without_clear and find_missing_remove_event_listener tools.
