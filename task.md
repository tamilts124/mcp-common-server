# MCP Server Task List

## Status legend
todo / in-progress / done / tested / blocked

## Tasks
- [x] Orient & verify codebase against task.md — status: done
  - notes: No task.md existed; git tree clean (single "initial commit"); server-http.js (1274 lines) was a complete, working zero-dep MCP HTTP+SSE server. No stubs/TODOs found.
- [x] Split server-http.js into modular lib/ files (>500 line rule) — status: tested
  - notes: lib/config.js, lib/roots.js, lib/fileOps.js, lib/processOps.js, lib/toolsSchema.js, lib/executeTool.js (incl. pipeline). server-http.js now ~220 lines, HTTP/SSE transport only. Behavior preserved exactly (logic copied verbatim, only console.log→console.error for [PROC] lifecycle logs to keep stdout clean of non-JSON-RPC noise — server is HTTP-based so this was already safe, done out of caution per stdout-guard convention).
- [x] Verify split server boots and matches original behavior — status: tested
  - notes: `node -c` syntax-checked all modules. Booted server-http.js with a temp port (3999) via start_process, curled `/` health endpoint — returned correct tool list/config, then killed cleanly.
- [x] Write isolated functional tests (5 rigor levels) for fileOps/roots/processOps/executeTool — status: tested
  - notes: test/run-tests.js — 29 tests across Normal/Medium/High/Critical/Extreme levels (happy path, param validation, dependency-failure handling, path-traversal & injection safety, fuzzing/concurrency/large-payload/cleanup). All 29 passed, exit code 0. No live server or MCP inspector used — pure function-level testing against a temp MCP_ROOTS sandbox dir.
- [x] Clean up temp test/debug files / .gitignore — status: done
  - notes: .gitignore already covered *.bak; deleted stray README.md.bak, server-http.js.bak, test/run-tests.js.bak that accumulated from write_file's auto-backup behavior during this session. Test suite cleans its own temp sandbox dir on exit.
- [x] Update README for new module layout — status: done
  - notes: Added "Code Layout" section documenting lib/ responsibilities and how to run tests.
- [x] Commit & push to GitHub — status: done
  - notes: Committed (8c64981) and pushed to origin/main. Working tree clean, branch up to date.
- [x] Re-verify stability (3 follow-up sessions) — status: done
  - notes: Three subsequent sessions re-ran git status/log, node -c syntax checks, and the full 29-test suite — all clean/passing each time, no drift, no leftover artifacts (one stray gitignored README.md.bak was found and deleted once).
- [x] Add formal JSON-RPC schema validation + error codes (-32602/-32603) — status: tested
  - notes: (1) `ToolError` class with `.code` field added to lib/executeTool.js; (2) `validateArgs(name, args)` checks required fields from TOOLS_ALL inputSchema before dispatch, throws -32602 on missing/empty field, -32601 for unknown tool; (3) policy refusals (read-only, exec disabled) throw -32001; (4) `getErrorCode(err)` helper returns err.code or -32603 fallback; (5) server-http.js tools/call catch block now includes both `error: { code, message }` (proper JSON-RPC error envelope) and the MCP `result.content isError` envelope for backward compat; (6) test suite extended with 13 new tests in block [6] covering all code paths — 42/42 passing.
- [ ] Add utility tools: zip/archive directory, file checksum (MD5/SHA256), JSON/YAML parse-and-query — status: todo
  - notes: Common developer-agent needs not yet covered. zip via Node.js built-in zlib (deflate), checksum via built-in crypto, JSON via JSON.parse, YAML parser (zero-dep hand-rolled or skip YAML for now). Each needs inputSchema + validateArgs coverage + tests.
- [ ] Add git metadata tools: current branch, last N commits, file blame summary — status: todo
  - notes: Useful for agents navigating repos. Implemented via `run_command` subprocess calls to `git` (requires git in PATH). Output structured as JSON. gated behind MCP_ALLOW_EXEC=true like other exec tools (or expose as read-only since they're non-destructive).
