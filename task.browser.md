# Browser Automation Task List

## Status legend
todo / in-progress / done / tested / blocked

## Notes
- Supersedes the zero-dep CDP-based browser design started in `task.md`
  (bottom of file, "Browser automation: ... CDP ..." entry). That design is
  abandoned per explicit new instruction: browser tools must use **Playwright**
  with a stealth setup, not raw CDP. `task.md` entry left as-is for history;
  this file (`task.browser.md`) is now the source of truth for browser work.
- Bulk test suite (`test/run-tests.js` + `test/sections/*.js`, 1417 tests) is
  **frozen/historical** — already marked complete in `task.md` by a prior
  session. Confirmed here again: it must NOT be executed or extended for
  browser work. Browser tools get their own independent script,
  `test/browser-tests.js`.

## Tasks
- [x] Install Playwright + stealth deps (playwright, playwright-extra, puppeteer-extra-plugin-stealth) — status: done
  - notes: deps in node_modules; chromium-1228 binary confirmed on disk.
- [x] Implement lib/browserLaunch.js (session table, stealth context/browser launch) — status: done
  - notes: verified complete, no stubs.
- [x] Implement lib/browserActions.js (navigate/content/evaluate/click/type/screenshot/console logs) — status: done
- [x] Implement lib/schemas/browserSchemas.js — status: done
- [x] Implement lib/dispatchBrowser.js + wire into executeTool.js/toolsSchema.js/execSchemas.js pipeline enum — status: done
  - notes: fixed toolsSchema.js corruption (prior session left WRITE_TOOLS Set
    unclosed + duplicate orphaned EXEC_TOOLS lines — syntax error). Rewrote
    file cleanly. `node -e require(...)` sanity check passes, 81 tools total.
- [x] Write test/browser-tests.js (5 rigor levels, isolated, not part of run-tests.js) — status: tested
  - notes: File found on disk (untracked) from a cut-off prior session. Ran it for real (real headless Chromium, MCP_ALLOW_EXEC=true, isolated MCP_ROOTS temp dir): found 4 failures, all in the test script itself, not the tools. Fixed: (1) 3 sync-throw validateArgs cases (missing url/selector/text) were passed as already-invoked promises into expectCode, so the sync throw escaped its try/catch — expectCode now takes a thunk `()=>...` so it catches both sync throws and async rejections; (2) path-traversal test expected a coded ToolError (-32602) but lib/roots.js's jail check throws a plain Error with no .code, same as every other tool in this codebase (confirmed via grep across test/sections/*.js — none of them assert a specific code for "outside root", only that it throws) — rewrote that one case to assert on the error message instead of a code, matching existing project convention rather than inventing a new one. Re-ran after fixes: 26/26 passed. Not part of test/run-tests.js.
- [x] Update README + package.json (test:browser script) — status: done
  - notes: README v3.33.0, added Browser Automation Tools section + code-layout rows. package.json version 3.33.0, added test:browser script.
- [x] Commit & push — status: done
  - notes: re-verified before commit — dispatchBrowser/browserActions/browserLaunch/toolsSchema all require() cleanly, no TODO/FIXME/stub matches in lib/, test/browser-tests.js re-run standalone: 26/26 passed.
- [x] Follow-up browser tools (wait_for_selector, back/forward/reload, cookies, pdf, select_option, press_key) — status: tested
  - notes: impl+dispatch+schema wiring left uncommitted by prior session verified
    complete (require()-clean, 90 tools total, all gated in EXEC_TOOLS same tier
    as other browser_* tools). Added 21 new cases to test/browser-tests.js
    covering all 9 new tools across the 5 rigor levels (happy path, param
    validation, timeout failures, path-traversal, unknown session). Full suite
    re-run: 43/43 passed.
- [x] browser_wait_for_navigation tool — status: tested
  - notes: page.waitForLoadState wrapper (load/domcontentloaded/networkidle).
    Wired in browserActions/dispatchBrowser/browserSchemas/toolsSchema
    EXEC_TOOLS (91 tools total, require()-clean). 3 new tests added
    (happy path, missing session_id, unknown session_id). Full suite: 46/46.
- [x] Concurrency/stress hardening pass on write + browser tools — status: tested
  - notes: verified prior work first (46/46 real browser-tests.js run, no
    stubs, require()-clean); cleaned stray .bak cruft (already .gitignore'd,
    from replace_in_file's auto-backup behavior — not a bug).
    Found and fixed a real race in browserLaunch.js: MAX_SESSIONS cap check
    read SESSIONS.size, but SESSIONS.set() only happens after the awaited
    chromium.launch() resolves, so N concurrent browser_launch calls all
    passed the check before any registered — cap was unenforceable under
    load. Fixed with a synchronous pendingLaunches reservation counter
    incremented/decremented around the await. Also added process exit/SIGINT/
    SIGTERM cleanup hooks to close orphaned Chromium processes. New
    MCP_MAX_BROWSER_SESSIONS env var (default 8).
    New test/stress-tests.js (not part of run-tests.js or browser-tests.js):
    parallel write_file/write_files races (no interleave/corruption), session
    cap enforcement under concurrent launches, rapid launch/close leak check,
    repeated-screenshot RSS growth check, mixed-race cap safety, 5MB fuzz
    write. 7/7 passing (caught the race above pre-fix, 4/7 failed; confirmed
    fix, now 7/7). package.json test:stress script added, v3.34.0.
- [x] Additional utility tools (archive checksum diff, git branch metadata
  helpers, JSON/YAML schema validators) — status: blocked
  - notes: OUT OF SCOPE for this session — explicit instruction restricts
    work to browser automation tools only, no general/non-browser tools.
    Not implementing. Left for a future non-browser-focused session.
- [x] browser_hover + browser_upload_file tools — status: tested
  - notes: hover (page.hover) + upload_file (page.setInputFiles, accepts
    'files' array or single 'path', jailed via resolveClientPath). Wired
    into browserActions/dispatchBrowser/browserSchemas/toolsSchema
    EXEC_TOOLS (93 tools total, require()-clean). 9 new tests added
    (happy path x2, missing selector, unknown session, timeout/missing
    element, missing files/path, path traversal). Full suite: 55/55.
    README + package.json v3.35.0 updated.

- browser_close — close page/context/browser, drop session

- browser_wait_for_selector — wait for element state (visible/hidden/attached/detached)
- browser_go_back / browser_go_forward / browser_reload — history navigation
- browser_get_cookies / browser_set_cookies — context cookie jar
- browser_pdf — render page to a jailed PDF path (chromium only)
- browser_select_option — select <select> option by value/label
- browser_press_key — keyboard key press, global or scoped to a selector
- browser_wait_for_navigation — wait for in-flight navigation to reach a load state

All tools above implemented, wired, and tested (46/46 in test/browser-tests.js).

- [x] browser_hover + browser_upload_file — status: tested (verified + committed this session; 55/55)
- [x] browser_scroll / browser_double_click / browser_right_click / browser_drag_and_drop — status: tested
  - notes: common interaction gaps (scroll-into-view/by-offset, dblclick, right-click context menus,
    DnD via page.dragAndDrop). Wired into browserActions/dispatchBrowser/browserSchemas/toolsSchema
    EXEC_TOOLS (97 tools total, require()-clean). 12 new tests added. Full suite: 67/67.
- [x] browser_download tool — status: tested
  - notes: waits for a Playwright 'download' event (triggered by clicking a
    selector) and saves the file to a jailed path via resolveClientPath.
    Wired into browserActions/dispatchBrowser/browserSchemas/toolsSchema
    EXEC_TOOLS (98 tools total, require()-clean). 6 new tests added (happy
    path, missing selector, missing path, path traversal, unknown session,
    no-download timeout). Full suite: 73/73 (one run hit a pre-existing
    flaky cdpSession crash in the unrelated concurrency test under
    heavy parallel launches — unrelated to this change, reran clean).
- [x] Element state/attribute tools (browser_get_attribute, browser_is_visible, browser_is_checked, browser_check, browser_uncheck) — status: tested
  - notes: query gaps — no way to read attribute values or checkbox/visibility
    state without evaluate(); added 5 dedicated typed tools. Wired into
    browserActions/dispatchBrowser/browserSchemas/toolsSchema EXEC_TOOLS
    (103 tools total, require()-clean). 23 new tests added across 5 rigor
    levels (normal/medium/high/critical/extreme: injection selectors, huge
    fuzz selector, non-checkbox check rejection). Full suite: 93/93 passing.
- [x] Element info batch tool (browser_get_element_info: bounding box, tag,
      text, attributes in one call) — status: tested
  - notes: reduces round-trips for agents inspecting multiple properties of
    the same element. Wired into browserActions/dispatchBrowser/browserSchemas/
    toolsSchema EXEC_TOOLS (104 tools total, require()-clean). 6 new tests
    added (normal, missing selector, unknown selector, unknown session,
    invalid-CSS injection selector -> -32603 matching existing convention,
    huge selector fuzz). Full suite: 99/99 passing.
- [x] Multi-tab support (browser_new_page, browser_switch_page,
      browser_list_pages, browser_close_page) — status: tested
  - notes: verified prior session's uncommitted work (require()-clean, 107
    tools total). Ran full suite for real: 111/111 passing (12 new multi-tab
    cases across normal/medium/high/critical/extreme). package.json v3.40.0.
- [x] Network interception / request-response inspection — status: tested
  - notes: browser_network_start/stop/get_network_requests capture request/
    response/requestfailed events into a capped (500) in-memory ring buffer
    per session, filterable by url_contains/resource_type/type, with limit
    and clear. Wired into browserActions/dispatchBrowser/browserSchemas/
    toolsSchema EXEC_TOOLS (110 tools total, require()-clean). 15 new tests
    added across 5 rigor levels (idempotent start, filters, clear, missing
    session_id, unknown session, injection-style filter, huge fuzz filter).
    Full isolated suite: 124/124 passing.
- [ ] browser_route (request mocking/interception — abort, fulfill with
      custom body/status, or continue) — status: todo
  - notes: natural follow-up to network inspection; needed for testing
    error states and mocking APIs without a live backend.
