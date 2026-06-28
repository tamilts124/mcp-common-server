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
- [x] Add utility tools: zip/archive directory, file checksum (MD5/SHA256), JSON/YAML parse-and-query — status: tested
  - notes: Added 3 new always-available tools in lib/utilOps.js: (1) `file_checksum` — MD5/SHA-1/SHA-256/SHA-512 via built-in `crypto`; (2) `zip_directory` — pure-Node ZIP writer (DEFLATE via zlib, correct Local File Header + Central Directory + EOCD structure, CRC-32 table); (3) `query_json` — dot-path extraction from JSON files with null/array/object type reporting. Schemas added to toolsSchema.js, dispatch cases added to executeTool.js, execute_pipeline enum updated. 23 new tests in block [7] (65/65 total passing). README updated with new tool section and code layout row.
- [x] Add git metadata tools: current branch, last N commits, file blame summary — status: tested
  - notes: Verified at start of this session (previous session was cut off after implementing but before committing). lib/gitOps.js — `git_status`, `git_log`, `git_blame`, all calling `git` via `execSync` with shell-metacharacter sanitization (`assertSafeArg`), 15s timeout, GIT_CEILING_DIRECTORIES set to prevent climbing above cwd. Always available (read-only, no MCP_ALLOW_EXEC needed) — added to toolsSchema.js, dispatched in executeTool.js, added to execute_pipeline enum. 25 new tests in block [8] (90/90 total passing) covering happy path, malformed/missing branch refs, shell-injection rejection (`;`, backtick, pipe), 4096-char arg limit, non-git directories, and commit-count capping. README "Git Metadata Tools" section added (was missing — completed this session) plus lib/gitOps.js row in Code Layout table. Committed as new file (was untracked from the cut-off session) + integration diffs.
- [ ] Split test/run-tests.js into modular files (>500 line rule) — status: in-progress
  - notes: run-tests.js had grown to 726 lines (over the 500-line threshold) across 4 prior feature additions. Splitting into test/test-harness.js (shared TMP dir / env setup / test() counter / cleanupDir helper) + test/sections/01-core-ops.js (blocks 1-5), 02-jsonrpc-validation.js (block 6), 03-utility-tools.js (block 7), 04-git-tools.js (block 8), with a thin test/run-tests.js orchestrator that requires each section in order and prints the final pass/fail summary + exit code. Also fixes a latent leftover mid-script "X passed, Y failed" console.log that was printing an intermediate summary after block 6 from incremental edits in a past session.
