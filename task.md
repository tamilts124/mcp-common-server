## Status legend
todo / in-progress / done / tested / blocked

## History
Completed task entries older than the ones below are archived in task-history.md to keep this file cheap to read each session.

## Tasks

- [x] Add find_missing_try_catch_in_async + find_unhandled_rejection_patterns tools — status: tested (30/30 + 27/27, all 5 rigor levels, v4.129.0)
  - notes:
    1. find_missing_try_catch_in_async (lib/missingTryCatchAsyncOps.js, ~225 lines) — one rule: async_await_no_try_catch (error), async functions that use `await` but have no try/catch block. Brace-depth extraction to find function body. Fixed JSDoc block-comment syntax error in unhandledRejectionOps.js (nested `*/` terminated the outer comment). Test: 151 (30/30).
    2. find_unhandled_rejection_patterns (lib/unhandledRejectionOps.js, ~215 lines) — two rules: missing_global_rejection_handler (warning, entry-point files without process.on handler), noop_rejection_handler (error, empty arrow/function handler). Entry-point detection via basename regex (server, app, index, main, start, bootstrap, entry). Test: 152 (27/27).
    Both wired in dispatchScan3.js, utilSchemas4.js, execSchemas.js pipeline enum. run-tests.js sections 151+152 added. Version v4.129.0.

- [x] Add find_memory_leak_patterns + find_circular_reference_risks tools — status: tested (31/31 + 28/28, all 5 rigor levels, v4.130.0)
  - notes:
    1. find_memory_leak_patterns (lib/memoryLeakPatternsOps.js, ~230 lines) — three rules: module_scope_cache_no_eviction (warning, Map/Set at module scope with .set/.add but no .delete/.clear), dom_ref_in_module_scope (warning, document.querySelector* at module scope), accumulating_push_in_closure (warning, module-scope array with .push inside callback but no drain). Fixed two bugs: (a) resetRe incorrectly matched the array declaration itself (added declaration exclusion), (b) pushRe only matched indented lines (changed to line-number-based check covering inline callbacks). Also fixed `\w+` → `[\w$]+` in all 3 module-scope regexes to support `$` in JS identifiers. Test: 153 (31/31).
    2. find_circular_reference_risks (lib/circularReferenceOps.js, ~280 lines) — three rules: self_reference_assignment (error, obj.prop = obj), mutual_module_scope_reference (warning, A.x = B + B.y = A in same file), circular_require_risk (warning, require result name matches export name). Test: 154 (28/28).
    Both wired in dispatchScan3.js, utilSchemas4.js, execSchemas.js pipeline enum. run-tests.js sections 153+154 added. Version v4.130.0.

- [x] Add find_promise_constructor_antipattern + find_event_emitter_leak tools — status: tested (26/26 + 26/26, all 5 rigor levels, v4.131.0)
  - notes:
    1. find_promise_constructor_antipattern (lib/promiseConstructorOps.js, ~199 lines) — two rules: async_executor_in_promise_constructor (error, new Promise(async ...) loses rejection forwarding for async throws), explicit_promise_wrap (warning, new Promise((res,rej) => p.then(res,rej)) or .then(res).catch(rej) wraps an already-thenable unnecessarily). Balanced-paren executor extraction + regex detection. Test: 155 (26/26).
    2. find_event_emitter_leak (lib/eventEmitterLeakOps.js, ~195 lines) — two rules: process_listener_in_function_body (error, process.on() inside a function body — either indented line OR same-line as function opener), emitter_on_inside_loop (warning, .on()/.once() inside for/while/do loop body via 15-line lookback). Fixed bug: indentation heuristic was `^[ \t]` (leading whitespace only), missing single-line bodies like `function x() { process.on(...)  }` — added check for non-whitespace content before `process` on same line. Test: 156 (26/26).
    Both wired in dispatchScan3.js, utilSchemas4.js, execSchemas.js pipeline enum. run-tests.js sections 155+156 added. Version v4.131.0.

- [ ] Plan next tools — status: todo
  - notes: Consider: find_unchecked_return_value (functions that return errors/status codes that callers ignore), find_missing_db_transaction (multiple DB writes without transaction wrapper), find_sql_injection_risk (string-concatenated queries), find_command_injection_risk (exec/spawn with unsanitized user input).
