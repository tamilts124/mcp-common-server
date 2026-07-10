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

- [ ] Next session: consider adding find_event_emitter_leak (EventEmitter with no .removeAllListeners / maxListeners check), or find_promise_constructor_antipattern (new Promise(resolve => resolve(asyncFn())) — unnecessary Promise wrapping). Both complement the memory/async leak family.
