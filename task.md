# MCP Server Task List

## Status legend
todo / in-progress / done / tested / blocked

## History
Completed task entries older than the ones below are archived in task-history.md to keep this file cheap to read each session.

## Tasks

- [x] Add SQLite lifecycle tool family: sqlite_create, sqlite_connect, sqlite_execute, sqlite_disconnect, sqlite_connections, sqlite_tables — status: tested (43/43 tests, all 5 rigor levels, v4.119.0)
  - notes: Zero-dep (Node v22+ built-in `node:sqlite` DatabaseSync). lib/sqliteOps.js (connection Map, mirrors browserLaunch.js session-table pattern), lib/dispatchSqlite.js, lib/schemas/sqliteSchemas.js. Wired into lib/toolsSchema.js (TOOLS_ALL + EXEC_TOOLS), lib/executeTool.js, lib/schemas/execSchemas.js. All 6 tools gated behind MCP_ALLOW_EXEC. Test: test/sections/135-sqlite-tools.js (43/43 passing). Committed as part of v4.119.0.

- [x] Add find_missing_remove_event_listener tool (addEventListener cleanup scan) — status: tested (23/23 sections tests, all 5 rigor levels, v4.119.0)
  - notes: lib/eventListenerLeakOps.js (210 lines). Two rules: inline_handler_uncleanable (error), event_listener_never_removed (warning). once:true suppressed. Sibling to find_setinterval_without_clear. Wired in dispatchScan3.js, utilSchemas3.js, execSchemas.js. Test: test/sections/136-find-missing-remove-event-listener.js (23/23 passing, generated from standalone test which is now gitignored). Committed v4.120.0.

- [ ] Add find_inline_event_handlers tool (HTML inline event handler CSP violation scan) — status: in-progress
  - notes: Scans HTML/JSX/HTML-in-JS for inline event handler attributes (onclick, onload, onmouseover, etc.). Two rules: inline_event_handler (error) — a literal `on<event>="..."` / `on<event>='...'` attribute with a JavaScript expression value (not empty); inline_event_handler_with_href_javascript (error) — `href="javascript:..."` which is also CSP-violating. Suppresses `on<event>=""` / `on<event>={}` empty handlers. Security complement to check_missing_csp_header and find_missing_rel_noopener. Planned: lib/inlineEventHandlerOps.js, wired in dispatchScan3.js + utilSchemas3.js + execSchemas.js. Test: test/sections/137-find-inline-event-handlers.js. Version: v4.120.0.
