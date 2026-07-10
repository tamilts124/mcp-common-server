# MCP Server Task List

## Status legend
todo / in-progress / done / tested / blocked

## History
Completed task entries older than the ones below are archived in task-history.md to keep this file cheap to read each session.

## Tasks

- [x] Add SQLite lifecycle tool family: sqlite_create, sqlite_connect, sqlite_execute, sqlite_disconnect, sqlite_connections, sqlite_tables — status: tested (43/43 tests, all 5 rigor levels, v4.119.0)
  - notes: Zero-dep (Node v22+ built-in `node:sqlite` DatabaseSync). lib/sqliteOps.js (connection Map, mirrors browserLaunch.js session-table pattern), lib/dispatchSqlite.js, lib/schemas/sqliteSchemas.js. Wired into lib/toolsSchema.js (TOOLS_ALL + EXEC_TOOLS), lib/executeTool.js, lib/schemas/execSchemas.js. All 6 tools gated behind MCP_ALLOW_EXEC. Test: test/sections/135-sqlite-tools.js (43/43 passing). Committed as part of v4.119.0.

- [x] Add find_missing_remove_event_listener tool (addEventListener cleanup scan) — status: tested (23/23 sections tests, all 5 rigor levels, v4.120.0)
  - notes: lib/eventListenerLeakOps.js (210 lines). Two rules: inline_handler_uncleanable (error), event_listener_never_removed (warning). once:true suppressed. Sibling to find_setinterval_without_clear. Wired in dispatchScan3.js, utilSchemas3.js, execSchemas.js. Test: test/sections/136-find-missing-remove-event-listener.js (23/23 passing). Committed v4.120.0 (also fixed .gitignore to exclude node_modules and .env).

- [x] Add find_inline_event_handlers tool (HTML inline event handler CSP violation scan) — status: tested (24/24 tests, all 5 rigor levels, v4.121.0)
  - notes: lib/inlineEventHandlerOps.js (~150 lines). Two rules: inline_event_handler (error) — literal on<event>="<JS>" attribute; javascript_href (error) — href="javascript:...". Empty handlers suppressed. JSX {expr} form not flagged. Security sibling of check_missing_csp_header and find_missing_rel_noopener. Wired in dispatchScan3.js, utilSchemas3.js (schema appended), execSchemas.js (pipeline enum). Test: test/sections/137-find-inline-event-handlers.js (24/24 passing). Version v4.121.0.

- [x] Split utilSchemas3.js → utilSchemas3+4, add find_missing_viewport_meta tool — status: tested (25/25 tests, all 5 rigor levels, v4.122.0)
  - notes: utilSchemas3.js was 86KB/52 schemas — split at schema #26 (find_unbounded_array_push_in_loop). Part 3 holds schemas 1-26 (26 schemas, 244 lines), Part 4 holds schemas 27-52 plus find_missing_viewport_meta (28 schemas total). Fixed aggregator: lib/schemas/utilSchemas.js now imports UTIL_SCHEMAS_4. Created lib/viewportMetaOps.js (~160 lines, two rules: missing_viewport_meta error, viewport_missing_width_device_width warning). Wired in dispatchScan3.js, execSchemas.js pipeline enum. Test: test/sections/138-find-missing-viewport-meta.js (25/25 passing). UTIL_SCHEMAS count: 137 total schemas. Version v4.122.0.

- [x] Add find_missing_lang_attribute + find_missing_meta_charset HTML quality tools — status: tested (22/22 + 23/23, all 5 rigor levels, v4.123.0)
  - notes:
    1. find_missing_lang_attribute (lib/langAttributeOps.js, ~120 lines) — three rules: missing_lang_attribute (error), empty_lang_attribute (error), invalid_lang_value (warning, BCP47 check). Eighth sibling in front-end accessibility family. Only .html/.htm scanned by default.
    2. find_missing_meta_charset (lib/metaCharsetOps.js, ~130 lines) — two rules: missing_meta_charset (error), charset_not_utf8 (warning). Handles HTML5 short-form and legacy http-equiv Content-Type form. Only .html/.htm by default.
    Wired in dispatchScan3.js, utilSchemas4.js (2 schemas appended), execSchemas.js (pipeline enum). Tests: 139 (22/22), 140 (23/23). run-tests.js sections list updated. Version v4.123.0.
