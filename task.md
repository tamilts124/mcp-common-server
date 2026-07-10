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

- [ ] Proactive: next candidate — pick from: CSS/HTML audit tools (find_missing_viewport_meta for responsive design, find_disabled_input_label_mismatch), or split utilSchemas3.js (now ~480+ lines, approaching 500-line limit soon). — status: todo
  - notes: utilSchemas3.js is now ~480+ lines with the new schema. Consider splitting into part 4 next session. Alternative new tool: `find_missing_viewport_meta` — scans HTML for absence of `<meta name="viewport">` tag, critical for mobile responsiveness and a sibling to the accessibility/HTML tools already in the server.
