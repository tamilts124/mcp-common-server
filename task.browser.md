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
- [ ] Write test/browser-tests.js (5 rigor levels, isolated, not part of run-tests.js) — status: todo
- [ ] Update README + package.json (test:browser script) — status: todo
- [ ] Commit & push — status: todo

## Complete tool list (target)
- browser_launch — launch a stealth Chromium context/page, returns session id
- browser_navigate — goto(url), waits for load
- browser_get_content — outerHTML / innerText, optional selector scope
- browser_evaluate — page.evaluate(js)
- browser_click — click(selector)
- browser_type — fill/type(selector, text)
- browser_screenshot — page.screenshot() to a jailed path
- browser_get_console_logs — buffered console messages for a session
- browser_list_sessions — list active sessions
- browser_close — close page/context/browser, drop session

Follow-ups (todo, not v1): browser_wait_for_selector, browser_go_back/forward/reload,
browser_get_cookies/set_cookies, browser_pdf, browser_select_option, browser_press_key.
