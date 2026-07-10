"use strict";
// ── UTILITY TOOL SCHEMAS — part 4 of 4 ──────────────────────────────
// Split from utilSchemas3.js when it grew to 86 KB / 52 schemas.
// Part 4 holds schemas 27-52 of that batch plus any new tools added after
// the split. Concatenated back into UTIL_SCHEMAS by utilSchemas.js.

const UTIL_SCHEMAS_4 = [
  {
    name: "find_env_var_default_fallback_masking_errors",
    description: "Scans JS/TS for `process.env.VAR`/`process.env['VAR']` reads immediately followed by a `||`/`??` fallback where VAR's name looks security-sensitive (SECRET/KEY/TOKEN/PASSWORD/CREDENTIAL, case-insensitive). A missing required secret that silently falls back to a hardcoded or empty value instead of failing fast at startup is a common misconfiguration-masking bug (e.g. `process.env.JWT_SECRET || 'dev'`). Distinct from scan_secrets (literal hardcoded secret values anywhere) and find_hardcoded_credentials_in_config (config files specifically) — this tool flags the *fallback pattern* regardless of what the fallback value looks like. Pure text-scan (regex): does not check whether the read sits inside startup validation that would otherwise throw, and does not evaluate the fallback expression itself. `env_var_default_fallback_masking_errors` (warning). Returns { path, filesScanned, envReadsSeen, findingsCount, warningCount, truncated, findings: [{file,line,rule,severity,message}] }. Always available — does not require `MCP_ALLOW_EXEC`.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan when path is a directory (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_hardcoded_localhost_urls",
    description: "Scans JS/TS for literal `http(s)://localhost`, `http://127.0.0.1`, and `ws(s)://localhost` URLs (with optional :port). A dev-only base URL hardcoded into source instead of read from configuration silently breaks in any deployed environment. Distinct from find_hardcoded_ips (any IP literal, no URL-scheme/localhost focus) and find_hardcoded_ports (bare `.listen(N)` port literals, not URLs). Files whose path contains test/spec/mock/fixture/__tests__/__mocks__ segments are skipped by default — set include_test_files to scan them too. Pure text-scan (regex): does not check for a NODE_ENV guard or whether the literal is only a `||` fallback after an env read. `hardcoded_localhost_url` (warning). Returns { path, filesScanned, filesSkippedAsTest, findingsCount, warningCount, truncated, findings: [{file,line,rule,severity,message}] }. Always available — does not require `MCP_ALLOW_EXEC`.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan when path is a directory (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
      include_test_files: { type: "boolean", description: "If true, also scan test/spec/mock/fixture paths (default false)." },
    }},
  },
  {
    name: "find_json_parse_without_try_catch",
    description: "Scans JS/TS for `JSON.parse(` call sites not enclosed in a `try{}` block that has a matching `catch` clause immediately after its closing brace — malformed input (uploads, API responses, config files, localStorage, query params) throws a SyntaxError that propagates uncaught. A `try{}` with only `finally` (no `catch`) does NOT count as guarded. Distinct from find_missing_error_boundary_in_async_route (route-level, only fires inside Express route registrations) — this is call-site-level and fires anywhere, including plain scripts/config loaders. Pure text-scan: guard detection is positional only (call site index falls within a qualifying try-body range), does not trace cross-function guards. `unguarded_json_parse` (warning). Returns { path, filesScanned, findingsCount, truncated, findings: [{file,line,rule,severity,text}] }. Always available — does not require `MCP_ALLOW_EXEC`.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan when path is a directory (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_missing_findindex_check",
    description: "Scans JS/TS for the `Array.prototype.findIndex()` no-match footgun: findIndex() returns -1 when nothing matches, so using that result as a subscript with no guard reads the wrong element or throws on further property access. Two shapes: `chained_findindex_no_guard` (error) — `arr[arr.findIndex(...)]`, the call is inline inside the subscript with no intermediate variable, so no guard is structurally possible. `missing_findindex_guard` (error) — `const idx = arr.findIndex(...)` followed within a 6-line lookahead by `arr[idx]`, unless a guard (`if (idx...)`, `idx !== -1`/`=== -1`/`>= 0`/`< 0`, or a ternary `idx ? `) appears in between. Analogous to find_missing_null_checks_after_regex_exec (same 'result can signal no-match' shape, different sentinel: -1 vs null). One finding per assigned variable (first unguarded use only). Pure text-scan with a fixed lookahead window, not an AST/scope parser — no cross-function data-flow tracking. Returns { path, filesScanned, findingsCount, truncated, findings: [{file,line,name?,rule,severity,message}] }. Always available — does not require `MCP_ALLOW_EXEC`.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan when path is a directory (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_missing_null_check_on_optional_chaining_default",
    description: "Scans JS/TS for the optional-chaining-default shared-mutable-state footgun: `obj?.prop ?? DEFAULT` / `obj?.prop || DEFAULT` is safe when DEFAULT is an inline literal (`?? []`, `?? {}` — a fresh value every call) but becomes a shared-state bug when DEFAULT is a bare identifier pointing at an array/object literal declared once at module (top) level: every call site that falls through to the fallback receives the SAME instance, so mutating the result corrupts state across unrelated calls. Two shapes: `chained_shared_default_mutation` (error) — `(expr?.prop ?? DEFAULT).push(...)`, mutation happens in the same expression, always flagged when DEFAULT resolves to a top-level literal declaration. `assigned_shared_default_mutation` (error) — `const x = expr?.prop ?? DEFAULT;` followed within a 6-line lookahead by a mutation of `x` (`.push(`/`.splice(`/etc., an index assignment, or a property assignment). 'Top-level literal declaration' is approximated as `const NAME = [`/`{` with zero leading indentation, a scope heuristic, not a real resolver — a same-named local shadowing a module-level literal can produce a false positive/negative. Pure text-scan, not an AST/scope parser. Returns { path, filesScanned, findingsCount, truncated, findings: [{file,line,name?,rule,severity,message}] }. Always available — does not require `MCP_ALLOW_EXEC`.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan when path is a directory (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_missing_cleanup_on_early_return",
    description: "Scans JS/TS for resource-leak-on-early-exit: a function acquires a resource — `fs.openSync(` (fd), `setInterval(`/`setTimeout(` assigned to a var (interval/timeout), or `<expr>.lock(` assigned to a var (lock) — and releases it later in the same enclosing block (`fs.closeSync(VAR)`/`clearInterval(VAR)`/`clearTimeout(VAR)`/`VAR.unlock(`), but a `return`/`throw` sits between acquisition and release with no `finally` in between to guarantee the release still runs. Two rules: `missing_cleanup_on_early_return` (error) — release call exists but an unguarded early exit sits before it. `resource_never_released` (warning) — no release call for the acquired resource is visible anywhere in the enclosing block at all. Enclosing block is found via brace-depth matching, not an AST/function-boundary parser — a stray brace inside a string/comment can misplace the boundary; a `finally` anywhere between acquire and release is treated as sufficient regardless of what it actually cleans up; no cross-function tracking (handing the resource to a helper for cleanup reads as never-released). Returns { path, filesScanned, findingsCount, truncated, findings: [{file,line,name,kind,rule,severity,message}] }. Always available — does not require `MCP_ALLOW_EXEC`.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan when path is a directory (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_inconsistent_error_response_shape",
    description: "Scans JS/TS for Express error responses (`res.status(4xx|5xx).json({ KEY: ... })`) whose top-level JSON key varies across the same file — one handler sends `{ error: '...' }`, a sibling sends `{ message: '...' }` — a common source of brittle client-facing error contracts. The first error-response call seen in a file establishes that file's baseline key; every later call in the same file using a different key is flagged `inconsistent_error_response_shape` (warning). Only the `res.status(N).json({...})` call shape is recognised (a bare `res.json()` with no explicit status, or a shape built via an intermediate variable, is invisible to this scan); only the object literal's first key is read; baseline is per-file, not per-router-mount. Pure text-scan, not an AST parser. Returns { path, filesScanned, findingsCount, truncated, findings: [{file,line,key,rule,severity,message}] }. Always available — does not require `MCP_ALLOW_EXEC`.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan when path is a directory (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_hardcoded_jwt_secret",
    description: "Scans JS/TS for `jwt.sign(payload, SECRET, ...)` / `jwt.verify(token, SECRET, ...)` calls (jsonwebtoken's conventional `jwt` import name, or any identifier bound via `require('jsonwebtoken')`/`import ... from 'jsonwebtoken'`) whose SECRET argument is a string or template literal instead of a variable/property access (e.g. `process.env.JWT_SECRET`)/function call. A hardcoded signing secret compromises every token ever issued and can't be rotated without a code change — distinct from scan_secrets (generic entropy/pattern scan over arbitrary text) and find_hardcoded_credentials_in_config (config files only, not JS/TS call-sites). Flags `hardcoded_jwt_secret` (error) for every matching call site. Pure text-scan with balanced-paren argument extraction, not an AST parser: only jsonwebtoken's positional 2nd-argument convention is checked (a `{ secret: 'literal' }` options-object shape used by some other JWT libraries is out of scope); any string/template literal is flagged unconditionally, with no entropy/length heuristic. Returns { path, filesScanned, findingsCount, truncated, findings: [{file,line,method,secretPreview,text}] }. Always available — does not require `MCP_ALLOW_EXEC`.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan when path is a directory (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "check_insecure_cookie_flags",
    description: "Scans JS/TS for two cookie-configuration shapes missing standard browser-cookie hardening flags: (1) `res.cookie(name, value[, options])` (Express) — checks the 3rd positional options-object argument; (2) a `cookie: { ... }` sub-object (express-session/cookie-session config, e.g. `session({ cookie: { ... } })`) — checks the object body directly. Flags per-shape: `missing_http_only`/`http_only_disabled`, `missing_secure`/`secure_disabled`, `missing_same_site`, or a single `cookie_no_options` when `res.cookie()` is called with no options object at all. Pure text-scan (regex + balanced-paren/brace extraction), not an AST parser: an options object built via an intermediate variable is invisible to this scan (same tradeoff as scan_cors_misconfig); conditional expressions like `secure: process.env.NODE_ENV === 'production'` are treated as 'present' (key-presence check only, not expression evaluation). Returns { path, filesScanned, findingsCount, errorCount, warningCount, infoCount, truncated, findings: [{file,line,rule,severity,message}] }. Always available — does not require `MCP_ALLOW_EXEC`.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan when path is a directory (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "summarize_package_scripts",
    description: "Reads a package.json's `scripts` map and categorizes each entry by developer purpose — test, typecheck, lint, format, build, dev, start, deploy, clean, or other — using regex heuristics over the script name and its command string (e.g. a name starting with `test` or a command invoking jest/mocha/vitest is categorized `test`). Useful for an agent that needs to answer 'which script runs the tests/builds the project?' without guessing from raw script text. Pure static heuristic, not an execution or AST analysis of what the command actually does — an atypically-named script with no recognizable keyword falls into `other`. Returns { path, scriptsCount, categories: {category: [scriptNames]}, scripts: [{name,command,category}] }. A missing `scripts` field returns an empty summary rather than an error. Always available — does not require `MCP_ALLOW_EXEC`.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "Path to package.json (default: 'package.json')." },
    }},
  },
  {
    name: "check_missing_engines_field",
    description: "Audits a package.json's `engines` field, whose absence or looseness lets CI/deploy/dev machines silently drift onto incompatible Node/npm versions. Pure structural check on the parsed JSON object — no semver-range evaluation beyond a 'looks risky' literal match. Findings: `missing_engines_field` (warning, no `engines` key at all), `invalid_engines_field` (error, `engines` present but not an object), `missing_engines_node` (warning, no `node` entry), `risky_engines_node_range` (warning, `engines.node` is `*`/`''`/`latest` — accepts anything), `missing_engines_npm` (info, no `npm` entry — optional). Returns { path, hasEngines, hasEnginesNode, findingsCount, errorCount, warningCount, infoCount, findings: [{rule,severity,message}] }. Always available — does not require `MCP_ALLOW_EXEC`.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "Path to package.json (default: 'package.json')." },
    }},
  },
  {
    name: "find_missing_shebang_in_bin_scripts",
    description: "Audits a package.json's `bin` field (global-executable entries) for the shebang + executable-bit requirements that npm's global install/link relies on. A bin script invoked directly by the OS shell after global install needs `#!/usr/bin/env node` (or similar) as its literal first line, and on POSIX needs its executable bit set — both failures are silent until someone actually installs the package globally. Findings: `missing_bin_field` (info, no `bin` key — nothing to check), `invalid_bin_field`/`invalid_bin_entry` (error, malformed `bin` value), `bin_file_not_found` (error, referenced file missing or unreadable), `missing_shebang` (error, target's first line doesn't start with `#!`), `malformed_node_shebang` (warning, shebang present but doesn't reference `node` — may be intentional), `missing_executable_bit` (warning, POSIX only, valid shebang but no exec bit in the file mode). Pure filesystem/string check — no execution of the target file. Returns { path, hasBin, binCount, findingsCount, errorCount, warningCount, infoCount, findings: [{binName,file,rule,severity,message}] }. Always available — does not require `MCP_ALLOW_EXEC`.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "Path to package.json (default: 'package.json')." },
    }},
  },
  {
    name: "find_missing_return_after_res_send",
    description: "Scans Express/http handler code for res.send/json/end/redirect calls (optionally chained after `.status(...)`) that aren't `return`ed, then checks the innermost enclosing `{...}` block for what follows. Findings: `double_response_send` (error) — a second response-sending call is textually visible later in the same block — will throw 'Cannot set headers after they are sent' if reached. `missing_return_after_res_send` (warning) — some other non-trivial statement follows in the same block (not just closing braces/comments/a bare `return;`) — code runs after the response is already committed. Pure text-scan + brace-depth block extraction, not an AST/CFG analyzer: scoped to the innermost block (a second call in a sibling block one level up is not cross-block-detected — deliberate false-positive tradeoff), ignores string/template contents when matching braces/parens, only tracks literal `res`/`response` receivers, and treats an arrow function whose entire body is the call as an implicit return (never flagged). Returns { path, filesScanned, findingsCount, errorCount, warningCount, truncated, findings: [{file,line,method,rule,severity,message}] }. Always available — does not require `MCP_ALLOW_EXEC`.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan when path is a directory (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "check_missing_rate_limit_headers",
    description: "Sibling of check_missing_rate_limit (which flags the absence of any rate-limiting middleware). Assumes limiting is already present and checks the *shape* of what it emits. `missing_retry_after_header` (warning) — a rate-limit hint was found (`rateLimit(`, or a literal X-RateLimit-*/RateLimit-* header) and route registrations exist, but no 'Retry-After' header exists anywhere in the scanned files. `rate_limit_header_explicitly_disabled` (info) — express-rate-limit's `standardHeaders: false` or `legacyHeaders: false` found in a `rateLimit({...})` call, one finding per disabled option with the real line number. Pure text-scan (regex), not an AST/app-instance-aware parser: hint detection is project-wide, not per-app-instance; only the literal header/option names above are recognized. Returns { path, filesScanned, hasRouteRegistrations, hasRateLimitHint, hasRetryAfterHint, findingsCount, errorCount, warningCount, infoCount, truncated, findings: [{file,line,rule,severity,message}] }. Always available — does not require `MCP_ALLOW_EXEC`.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan when path is a directory (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "check_docker_compose_issues",
    description: "Audit a docker-compose.yml/yaml file's service definitions for common hygiene/security issues — distinct from scan_dockerfile_issues (Dockerfile instructions) and find_unpinned_docker_base_image (FROM tag pin-strictness inside a Dockerfile), neither of which look at compose files. Reuses the project's zero-dependency YAML parser (same parseYaml as query_data/json_flatten). Per service: image_missing_tag_or_digest/image_explicit_latest_tag (error, image: with no digest resolves to or explicitly pins mutable 'latest', skipped for locally-built services with a sibling build: key), privileged_true (error, full host device/kernel access), host_network_mode (warning, network_mode: host bypasses network namespace isolation), missing_restart_policy (info, no restart: key), port_bound_to_all_interfaces (warning, a ports: entry with no explicit host bind address binds to 0.0.0.0 not just localhost), inline_env_looks_like_secret (warning, an environment entry whose key matches SECRET/KEY/TOKEN/PASSWORD/CREDENTIAL has a literal, non-${VAR} value). Not a full Compose-spec validator — unsupported YAML constructs (anchors/aliases, multi-doc streams) surface as a clear parse error rather than a silent partial read. Returns { path, serviceCount, findingsCount, errorCount, warningCount, infoCount, truncated, findings: [{service,rule,severity,message}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "Path to the docker-compose file (default: 'docker-compose.yml')." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_missing_stream_error_handler",
    description: "Scans JS/TS for fs.createReadStream/createWriteStream and http(s).request/get calls whose result is never given a sibling '.on(\"error\", ...)' listener. These are EventEmitters — an 'error' event emitted with zero listeners throws and, with no process-level uncaughtException handler, can crash the whole process (a single bad path, disk-full write, or network reset takes down more than the one operation). Detection: `const/let/var NAME = fs.createReadStream(...)` (or the other 3 call forms) followed by a scan of the enclosing {...} block (brace-depth extraction, same technique as find_missing_cleanup_on_early_return) for a literal `NAME.on('error'`/`NAME.once('error'`; unassigned calls are checked for an inline chained `.on('error', ...)` before being skipped. Calls textually inside a `pipeline(...)` wrapper are not flagged — stream.pipeline() auto-forwards every stream's errors to its own callback. Pure text-scan, not an AST parser: only literal `fs.`/`http.`/`https.` receivers are matched (destructured imports aren't), and calls with neither an extractable variable name nor a visible inline handler are skipped rather than guessed at. Returns { path, filesScanned, findingsCount, warningCount, truncated, findings: [{file,line,variable,type,rule,severity,message}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan when path is a directory (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_setinterval_without_clear",
    description: "Scans JS/TS for setInterval(...) calls whose handle is never cleared — a running interval keeps firing (and keeps the event loop alive unless .unref()'d) for the life of the process, a classic long-running-server memory/zombie-timer leak. Detection: `const/let/var NAME = setInterval(...)` then a whole-file textual search for `clearInterval(NAME`. Findings: `unassigned_interval_handle` (error) — the call result isn't assigned to a variable at all, so it could never be cleared even if someone wanted to. `interval_never_cleared` (warning) — a variable exists but no matching `clearInterval(NAME` appears anywhere in the file. An inline chained `.unref()` immediately after the call (assigned or not) is treated as an intentional 'let this die with the process' idiom and is never flagged. Pure text-scan, not an AST/CFG analyzer: the clearInterval search is whole-file and not scope-aware (a same-named variable cleared in an unrelated scope suppresses a genuine finding — a deliberate false-negative tradeoff), and member-expression assignment targets (`obj.prop = setInterval(...)`) have no extractable variable name and are treated as unassigned. Returns { path, filesScanned, findingsCount, errorCount, warningCount, truncated, findings: [{file,line,variable?,rule,severity,message}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan when path is a directory (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_async_callback_in_foreach",
    description: "Scans JS/TS for the async-callback-in-.forEach() footgun: Array.prototype.forEach() ignores its callback's return value and never awaits it, so an `async` callback's promise (and any await inside it) is never waited on by the enclosing function — a rejection becomes an unhandled promise rejection instead of a catchable error, and 'wait for all iterations to finish' code silently runs before the loop body actually completes. Distinct from find_missing_await (flags a call site missing a preceding `await` — an await *inside* the forEach callback body defeats that check entirely) and find_dangling_promises (statement-position floating promise, not forEach-specific). Two rules: `foreach_inline_async_callback` (error) — `.forEach(async (...) => ...)` / `.forEach(async function...)` with the callback written inline. `foreach_named_async_callback` (warning, lower confidence) — `.forEach(NAME)` where NAME was declared `async` elsewhere in the same file (function declaration, arrow/function expression assigned to a variable, or method shorthand — same name-collection technique as find_missing_await). Pure text-scan, not an AST/data-flow parser: only `.forEach(` is in scope (`.map(async ...)`/`.filter(async ...)` etc. are a different, uncovered shape); a `.forEach(name)` where `name` isn't found among this file's collected async declarations is skipped rather than guessed at (could be async elsewhere/imported). Returns { path, filesScanned, findingsCount, errorCount, warningCount, truncated, findings: [{file,line,callback?,rule,severity,message}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan when path is a directory (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_missing_img_alt_text",
    description: "Scans HTML/JSX for <img> tags missing accessibility alt text — the first tool in this server to inspect front-end markup accessibility rather than backend/security/git concerns. `missing_alt_attribute` (error) — no `alt=` attribute at all on the tag; screen readers fall back to announcing the raw file path/URL. `non_descriptive_alt_text` (warning) — alt text present but looks like a bare filename (ends in .png/.jpg/.jpeg/.gif/.svg/.webp/.bmp/.avif/.ico), a common copy-paste anti-pattern that gives screen-reader users no more information than a missing alt. `alt=\"\"` (or JSX `alt={''}`/`alt={\"\"}`) is NOT flagged — empty alt is the correct, intentional marker for a purely decorative image. A JSX expression alt value (`alt={someVar}`) is treated as present/dynamic and not inspected further (avoids false positives on legitimately dynamic alt text). Pure text-scan (regex over `<img\\b[^>]*>` tag bodies), not an HTML/JSX parser: only the literal `<img` tag name is matched (component wrappers like Next.js `<Image>` are out of scope), and a stray `>` inside a JSX expression attribute value can misplace a tag boundary. Returns { path, filesScanned, findingsCount, errorCount, warningCount, truncated, findings: [{file,line,altText?,rule,severity,message}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan when path is a directory (default: .html/.htm/.jsx/.tsx)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_missing_form_label",
    description: "Scans HTML/JSX for <input>/<textarea>/<select> elements with no accessible name — a screen reader announces such a control as just its element type ('edit text', 'combo box') with no indication of purpose. Sibling to find_missing_img_alt_text, extending this server's front-end-accessibility coverage. An accessible name is considered present if ANY of: (1) non-empty `aria-label=\"...\"` (or JSX `aria-label={...}` dynamic expression, assumed fine); (2) `aria-labelledby=` present at all (referenced id's existence/text is not verified — trusted at face value); (3) the tag has `id=\"X\"` and a `<label for=\"X\">` (or JSX `htmlFor=\"X\"`) is found anywhere else in the file; (4) the tag sits textually inside a `<label>...</label>` span found anywhere in the file (implicit wrapping). `type=\"hidden\"/\"submit\"/\"button\"/\"reset\"` inputs are skipped (never rendered, or use their own value/text as the name — a different, unchecked shape). `missing_form_label` (error) for everything else. Pure text-scan (regex over opening tags + a non-greedy `<label>...</label>` span match), not an HTML/JSX parser: nested/overlapping `<label>` tags can misassociate a control with the wrong label text, and custom component wrappers (e.g. `<TextField />`) that render a real `<input>` under the hood are invisible to this scan. Returns { path, filesScanned, findingsCount, truncated, findings: [{file,line,tag,rule,severity,message}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan when path is a directory (default: .html/.htm/.jsx/.tsx)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_missing_button_accessible_name",
    description: "Scans HTML/JSX for <button>/<a> elements with no accessible name — announced by screen readers as just 'button'/'link' with zero indication of purpose (the classic icon-only-button/icon-only-link bug). Third sibling in this server's front-end-accessibility family, after find_missing_img_alt_text and find_missing_form_label. An accessible name is considered present if ANY of: (1) non-empty visible text content between the opening/closing tag after stripping nested markup; (2) non-empty `aria-label=\"...\"` (or JSX `aria-label={...}` dynamic expression, assumed fine); (3) `aria-labelledby=` present at all (trusted at face value, not resolved); (4) a nested <img>/<svg> child carrying its own alt text or aria-label (the icon itself supplies the name). A `title=\"...\"` attribute alone is reported separately as `title_only_accessible_name` (warning, not error) — technically valid but a broadly-discouraged weak substitute for a real label. `missing_accessible_name` (error) for everything else. Pure text-scan (non-greedy regex tag-content match), not an HTML/JSX parser: deeply nested same-name tags or a stray '>' inside a JSX expression attribute can misplace a tag boundary, and custom component wrappers (e.g. <Button icon=\"...\" />) rendering a real <button>/<a> under the hood are invisible to this scan. Returns { path, filesScanned, findingsCount, truncated, findings: [{file,line,tag,rule,severity,message}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan when path is a directory (default: .html/.htm/.jsx/.tsx)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_duplicate_html_id",
    description: "Scans HTML/JSX for duplicate id=\"...\" attribute values within the same file — HTML requires ids to be unique: document.getElementById/CSS #selectors only ever match the first occurrence, and (directly relevant to this server's own find_missing_form_label tool) a <label for=\"x\"> associates with whichever id=\"x\" comes first, silently orphaning every later duplicate. Distinct from find_duplicate_json_keys/find_duplicate_yaml_keys, which cover data-file key duplication, not markup attribute duplication. Collects every literal id=\"value\"/id='value' (and JSX id={`value`}/id={\"value\"}/id={'value'} literal-template forms) per file, grouped by value; any value occurring 2+ times -> `duplicate_id` (error) listing every line it appears on. A JSX dynamic expression id (id={someVar}) is skipped entirely — can't statically determine whether two dynamic ids ever collide at runtime. Checked per-file only, not across a whole app/bundle — the same id in two separate partial templates is not itself a bug until both are mounted on the same page, which this static scan can't know. Pure text-scan (regex over generic id= attributes, not scoped to any tag name), not an HTML/JSX parser — an id= inside a comment or unrelated string literal can produce a false positive. Returns { path, filesScanned, findingsCount, truncated, findings: [{file,line,id,occurrences,lines,rule,severity,message}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan when path is a directory (default: .html/.htm/.jsx/.tsx)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_positive_tabindex",
    description: "Scans HTML/JSX for tabindex/tabIndex attribute values greater than 0 — a well-known WCAG 2.4.3 anti-pattern. A positive tabindex pulls an element out of the natural DOM tab order and forces it to be visited, in ascending numeric order, before every tabindex=\"0\"/unset element on the page; once two independent components on the same page each use positive tabindex, authors can no longer reason about the resulting order at all. Fourth sibling in this server's front-end-accessibility family, after find_missing_img_alt_text, find_missing_form_label, find_missing_button_accessible_name, and find_duplicate_html_id. Recognizes HTML `tabindex=\"N\"`/`tabindex='N'` and JSX `tabIndex={N}`/`tabIndex=\"N\"`/`tabIndex='N'`. `tabindex=\"0\"` (adds an element to the natural tab order) and `tabindex=\"-1\"` (programmatic-focus-only, removes from tab order) are the two well-established legitimate values and are never flagged. Non-integer/malformed values are skipped (invalid markup, not a tab-order bug). A JSX dynamic expression (`tabIndex={someVar}`) is skipped entirely — can't statically know the runtime value. `positive_tabindex` (warning) for every value > 0 found. Pure text-scan (regex over tabindex/tabIndex attributes, not scoped to any tag name), not an HTML/JSX parser — a matching attribute name inside a comment or unrelated string literal can produce a false positive. Returns { path, filesScanned, findingsCount, truncated, findings: [{file,line,value,rule,severity,message}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan when path is a directory (default: .html/.htm/.jsx/.tsx)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_missing_rel_noopener",
    description: "Scans HTML/JSX for <a target=\"_blank\"> links with no rel=\"noopener\"/\"noreferrer\" — the reverse-tabnabbing security anti-pattern (mirrors the standard eslint-plugin-react rule react/jsx-no-target-blank as a static, dependency-free scan). Without noopener, the destination page keeps a window.opener handle back to the originating tab and can silently repoint it to a phishing URL while the user looks at the new tab. Sibling to find_open_redirect_risks/scan_cors_misconfig in this server's security-scan family (a security concern, not a screen-reader concern, so it is NOT part of the front-end-accessibility family alongside find_missing_img_alt_text/find_missing_form_label/find_missing_button_accessible_name/find_duplicate_html_id/find_positive_tabindex). Only a literal target=\"_blank\"/target='_blank' (or JSX target={\"_blank\"}/target={'_blank'}) puts a tag in scope; a JSX dynamic target (target={someVar}) is skipped — can't statically resolve the runtime value. A rel= containing \"noopener\" or \"noreferrer\" (case-insensitive) marks the tag safe. A dynamic rel={someVar} or a spread ({...props}) is treated as possibly-already-safe and NOT flagged — can't statically prove otherwise, and a false positive here is worse than a false negative for a review-aid scan. `missing_rel_noopener` (error) for everything else. Pure text-scan (non-greedy regex over <a ...> tag bodies), not an HTML/JSX parser — a stray '>' inside a JSX expression attribute value can misplace a tag boundary, same documented caveat as this server's other markup-scanning tools. Returns { path, filesScanned, findingsCount, truncated, findings: [{file,line,rule,severity,message}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan when path is a directory (default: .html/.htm/.jsx/.tsx)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_missing_remove_event_listener",
    description: "Scans JS/TS for target.addEventListener(type, handler, opts?) calls whose listener is never cleaned up. Two rules: inline_handler_uncleanable (error) — the handler argument is an inline function/arrow expression, not a named reference, so removeEventListener() can never target it (a new function object is created on every call); event_listener_never_removed (warning) — the handler is a bare identifier but no matching target.removeEventListener(type, handler) appears anywhere in the file. addEventListener calls with once:true in options are not flagged (the browser auto-removes after one fire — same intentional self-cleanup idiom as .unref() for setInterval). Sibling to find_setinterval_without_clear. Returns { path, filesScanned, findingsCount, errorCount, warningCount, truncated, findings: [{file,line,target,eventType,handler?,rule,severity,message}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan when path is a directory (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_inline_event_handlers",
    description: "Scans HTML/JSX/JS/TS files for inline event handler attributes (onclick=\"...\", onload=\"...\", onerror=\"...\", etc.) and javascript: href values — both of which violate Content-Security-Policy (CSP) directives that block unsafe-inline script execution, are a maintenance burden (mixing structure and behavior), and make code harder to audit. Security complement to check_missing_csp_header (which checks whether a CSP header is present at all) and find_missing_rel_noopener (another markup-security scan). Two rules: `inline_event_handler` (error) — a literal `on<event>=\"<JS>\"` or `on<event>='<JS>'` attribute with a non-empty JavaScript expression value; suppresses `on<event>=\"\"` empty placeholders. `javascript_href` (error) — an `href=\"javascript:...\"` / `href='javascript:...'` value, which violates CSP and is a semantic anti-pattern (use a <button> with an event listener instead). JSX `on<Event>={expr}` curly-brace form is NOT flagged — that is the correct JSX pattern. Pure text-scan (regex, line-by-line), not an HTML/JSX/DOM parser: a string literal containing `onclick=\"...\"` text (e.g., inside a comment or string value) can produce a false positive. Returns { path, filesScanned, findingsCount, errorCount, warningCount, truncated, findings: [{file,line,attr,value,rule,severity,message}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan when path is a directory (default: .html/.htm/.jsx/.tsx/.js/.ts)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_missing_viewport_meta",
    description: "Scans HTML files for the absence of a `<meta name=\"viewport\">` tag — the single most important tag for mobile responsiveness. Without it, mobile browsers apply a desktop layout at full width then shrink the result, making text unreadable and touch targets too small. Sixth sibling in this server's front-end accessibility/quality family (after find_missing_img_alt_text, find_missing_form_label, find_missing_button_accessible_name, find_duplicate_html_id, find_positive_tabindex). Checks for both a missing viewport meta entirely (`missing_viewport_meta`, error — no `<meta ... name=\"viewport\"` or `<meta ... name='viewport'` found in the file) and a viewport meta present but missing the critical `width=device-width` value (`viewport_missing_width_device_width`, warning — the tag is there but the content attribute has no `width=device-width` token, which skips the key scaling hint). Only `.html`/`.htm` files are scanned by default (unlike JSX tools, viewport meta belongs in base HTML templates — component files are out of scope). Pure text-scan (regex, case-insensitive), not an HTML parser — a meta tag inside a comment or conditional comment is still matched. Returns { path, filesScanned, findingsCount, errorCount, warningCount, truncated, findings: [{file,line,rule,severity,message}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan when path is a directory (default: .html/.htm)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_missing_lang_attribute",
    description: "Scans HTML files for <html> tags missing a `lang=` attribute — WCAG 2.0 Success Criterion 3.1.1 (Level A, the lowest bar for accessibility). Without a declared language, screen readers fall back to a default language, often mispronouncing words and making the page unusable for vision-impaired users who rely on audio output. Seventh sibling in this server's front-end accessibility family (after find_missing_img_alt_text, find_missing_form_label, find_missing_button_accessible_name, find_duplicate_html_id, find_positive_tabindex, find_missing_viewport_meta). Three rules: `missing_lang_attribute` (error) — no lang= on the <html> tag at all; `empty_lang_attribute` (error) — lang=\"\" (blank string, which is semantically equivalent to absent); `invalid_lang_value` (warning) — a lang value that doesn't match the BCP 47 pattern (2-8 alpha letters, optional subtags, e.g. 'en', 'en-US', 'zh-Hant'). JSX files are out of scope — the lang attribute belongs on the <html> element of a base HTML template, not inside a component. Only .html/.htm files are scanned by default. Pure text-scan (regex), not an HTML parser — a <html> tag inside a comment is still matched. Returns { path, filesScanned, findingsCount, errorCount, warningCount, truncated, findings: [{file,line,rule,severity,message}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan when path is a directory (default: .html/.htm)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_missing_meta_charset",
    description: "Scans HTML files for the absence of a charset declaration: the short-form `<meta charset=\"UTF-8\">` (HTML5) or the legacy `<meta http-equiv=\"Content-Type\" content=\"text/html; charset=UTF-8\">`. Without an explicit charset the browser sniffs the encoding — historically enabling UTF-7/charset-sniffing XSS attacks (CVE class), and in the present day causing mojibake (garbled text) whenever the server omits a Content-Type header charset or the file contains non-ASCII characters. Pairs with find_missing_viewport_meta (both belong as early <head> meta tags) in this server's front-end quality/accessibility family. Two rules: `missing_meta_charset` (error) — no charset meta found anywhere in the file; `charset_not_utf8` (warning) — charset declared but the value (after stripping hyphens, case-folded) is not utf8 — modern HTML documents should use UTF-8. Only .html/.htm files are scanned by default. Pure text-scan (regex, case-insensitive), not an HTML parser — a charset meta inside a comment is still matched; the legacy http-equiv form with attributes in either order is recognised. Returns { path, filesScanned, findingsCount, errorCount, warningCount, truncated, findings: [{file,line,rule,severity,message}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan when path is a directory (default: .html/.htm)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_missing_aria_role",
    description: "Scans HTML/HTM/JSX/TSX files for interactive <div> or <span> elements (those with onclick/onClick/onkeydown/onKeyDown/onkeypress/onKeyPress handlers) that lack a role= attribute — a screen-reader accessibility anti-pattern. Two rules: `missing_aria_role` (error) — interactive div/span with no role, announced as a generic container by screen readers; `role_without_tabindex` (warning) — role present but no tabIndex attribute, making the element unreachable via keyboard Tab navigation. Does NOT flag <button>/<a>/<input> (semantically interactive already). Pure text-scan (regex over tag bodies), not an HTML/JSX parser. Returns { path, filesScanned, findingsCount, errorCount, warningCount, truncated, findings: [{file,line,tag,rule,severity,message}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan (default: .html/.htm/.jsx/.tsx)." },
      max_results: { type: "number", description: "Cap on findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_hardcoded_color_literals",
    description: "Scans CSS/SCSS/LESS files for hardcoded color literals (hex #rgb/#rrggbb, rgb()/rgba()/hsl()/hsla()) used directly in property values outside :root{} / :host{} token-declaration blocks. The design-token pattern defines all colors as CSS custom properties in :root{} and references them via var(--color-name), making theming a single-location change. One rule: `hardcoded_color_literal` (warning). Skips: :root/:host blocks (token declarations), --custom-property lines (var definitions), lines already using var(), CSS comment text. Pure text-scan (line-by-line regex + brace-depth tracking for :root detection), not a CSS parser. Returns { path, filesScanned, findingsCount, warningCount, truncated, findings: [{file,line,color,rule,severity,message}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan (default: .css/.scss/.less)." },
      max_results: { type: "number", description: "Cap on findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_missing_doctype",
    description: "Scans HTML/HTM files for a missing or non-standard DOCTYPE declaration. Without <!DOCTYPE html>, browsers enter quirks mode, changing layout, box model, and CSS behaviour unpredictably. Two rules: `missing_doctype` (error) — no <!DOCTYPE ...> at all; `non_html5_doctype` (warning) — DOCTYPE present but not the simple HTML5 form. Only .html/.htm scanned by default. Returns { path, filesScanned, findingsCount, errorCount, warningCount, truncated, findings: [{file,line,rule,severity,message}] }. Always available.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan (default: .html/.htm)." },
      max_results: { type: "number", description: "Cap on findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_unused_css_variables",
    description: "Scans a project for CSS custom property (--var-name) declarations never referenced via var(--var-name). Two-phase cross-file analysis: declaration scan over CSS/SCSS/LESS/HTML, usage scan over CSS/SCSS/LESS/HTML/JSX/TSX/JS/TS. One rule: `unused_css_variable` (warning). Returns { path, filesScanned, totalDeclaredVariables, unusedCount, findingsCount, warningCount, truncated, findings: [{file,line,variable,declarationCount,rule,severity,message}] }. Always available.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      decl_extensions: { type: "array", items: { type: "string" }, description: "Override extensions for declaration scan (default: .css/.scss/.less/.html/.htm)." },
      usage_extensions: { type: "array", items: { type: "string" }, description: "Override extensions for usage scan (default: .css/.scss/.less/.html/.htm/.jsx/.tsx/.js/.ts/.mjs/.cjs)." },
      max_results: { type: "number", description: "Cap on findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_magic_numbers",
    description: "Scans JS/TS files for numeric literals used directly in expressions rather than extracted as named constants — the 'magic number' anti-pattern. Numbers 0, 1, 2, -1, -2 (and values at or below the configurable `threshold`, default 2) are exempt as universally understood literals. Named const/let/var assignments are skipped (those are the correct fix). One rule: `magic_number` (warning). Returns { path, filesScanned, findingsCount, warningCount, truncated, findings: [{file,line,value,rule,severity,message}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path:       { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array",  items: { type: "string" }, description: "File extensions to scan (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      threshold:  { type: "number", description: "Numeric values with absolute value <= threshold are exempt in addition to the always-allowed set {0,1,2,-1,-2} (default: 2)." },
      max_results:{ type: "number", description: "Cap on findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_long_functions",
    description: "Scans JS/TS files for function declarations, arrow functions, and method definitions whose body exceeds a configurable line threshold (default 50 lines). Long functions are hard to test and review — candidates for extraction into smaller, focused helpers. Detection is brace-depth-based (regex, not AST): stray braces inside strings/comments may misplace a boundary; arrow functions without `{}` block bodies are not counted. Results sorted by line count descending (worst offenders first). One rule: `long_function` (warning). Returns { path, filesScanned, threshold, findingsCount, warningCount, truncated, findings: [{file,line,name,lineCount,rule,severity,message}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path:       { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array",  items: { type: "string" }, description: "File extensions to scan (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      threshold:  { type: "number", description: "Line count threshold: functions longer than this are flagged (default: 50, min: 5, max: 10000)." },
      max_results:{ type: "number", description: "Cap on findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_deprecated_html_elements",
    description: "Scans HTML/HTM/JSX/TSX files for deprecated or discouraged HTML elements. Two rules: deprecated_html_element (error) — element removed or deprecated in HTML5 including font, center, marquee, blink, frameset, frame, noframes, big, applet, basefont, dir, isindex, plaintext, xmp, listing, spacer, strike, tt; discouraged_html_element (warning) — still valid but superseded: b (prefer strong), i (prefer em), s (prefer del), u (prefer CSS text-decoration). Sibling to find_missing_doctype, find_missing_lang_attribute, find_missing_meta_charset. Pure text-scan (regex over opening tags); closing tags not double-counted. Returns { path, filesScanned, findingsCount, errorCount, warningCount, truncated, findings: [{file,line,tag,rule,severity,alternative?,message}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan (default: .html/.htm/.jsx/.tsx)." },
      max_results: { type: "number", description: "Cap on findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_eval_usage",
    description: "Scans JS/TS/JSX/TSX/.mjs/.cjs files for dynamic code-execution patterns that violate Content Security Policy and introduce XSS/RCE risk. Three rules: direct_eval (error) — bare eval() call (not a method call); new_function_constructor (error) — new Function() constructor, compiles a string as JS at runtime; settimeout_string_arg (warning) — setTimeout or setInterval with a string literal as the first argument (implicit eval path). Security sibling of check_missing_csp_header, find_inline_event_handlers, find_insecure_random_usage. Pure text-scan (regex, line-by-line). Returns { path, filesScanned, findingsCount, errorCount, warningCount, truncated, findings: [{file,line,rule,severity,text,message}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      max_results: { type: "number", description: "Cap on findings[] list length (1-5000, default 500)." },
    }},
  },
,
  {
    name: 'find_missing_error_context',
    description: 'Scans JS/TS catch blocks for two error-re-throw patterns that destroy debugging information. rethrow_without_cause (error) — throw new SomeError(msg) inside a catch block without a { cause: err } second argument: the original error is completely discarded, breaking error-chain inspection in Node.js 16+/modern browsers. bare_rethrow (warning) — throw catchVar; re-throws the same object unchanged: correct but misses the opportunity to add context at the current layer. Distinct from find_empty_catch_blocks (catches that swallow errors entirely) — this targets catches that propagate but lose information. Pure text-scan (regex + brace-depth block extraction, not an AST parser): catch variable name extracted from catch(VAR), then the enclosing block scanned for throw patterns. Returns { path, filesScanned, findingsCount, errorCount, warningCount, truncated, findings: [{file,line,catchVar,rule,severity,text,message}] }. Always available — does not require MCP_ALLOW_EXEC.',
    inputSchema: { type: 'object', properties: {
      path:       { type: 'string', description: "File or directory to scan (default: '.')." },
      extensions: { type: 'array', items: { type: 'string' }, description: 'File extensions to scan (default: .js/.jsx/.ts/.tsx/.mjs/.cjs).' },
      max_results:{ type: 'number', description: 'Cap on findings[] list length (1-5000, default 500).' },
    }},
  },
  {
    name: 'find_promise_race_without_timeout',
    description: 'Scans JS/TS for Promise.race([...]) calls that lack a timeout competitor promise. Without a timeout, Promise.race() only chooses the fastest of concurrent operations — it provides no protection if ALL of them hang indefinitely (network failure, slow DB query, external API down). Two rules: promise_race_no_timeout (error) — Promise.race() array has no visible setTimeout, AbortSignal.timeout, AbortController, or common timeout-helper naming (withTimeout, raceTimeout, deadline, timeoutPromise); promise_race_single_item (warning) — the array appears to contain only one element, making the race a no-op. Inspection window: up to 15 lines following the call. Siblings: find_promise_all_without_catch, find_dangling_promises, find_missing_stream_error_handler. Pure text-scan (regex + balanced-bracket extraction), not an AST parser. Returns { path, filesScanned, findingsCount, errorCount, warningCount, truncated, findings: [{file,line,rule,severity,text,message}] }. Always available — does not require MCP_ALLOW_EXEC.',
    inputSchema: { type: 'object', properties: {
      path:       { type: 'string', description: "File or directory to scan (default: '.')." },
      extensions: { type: 'array', items: { type: 'string' }, description: 'File extensions to scan (default: .js/.jsx/.ts/.tsx/.mjs/.cjs).' },
      max_results:{ type: 'number', description: 'Cap on findings[] list length (1-5000, default 500).' },
    }},
  },
  ,
  {
    name: 'find_missing_try_catch_in_async',
    description: 'Scans JS/TS/JSX/TSX/.mjs/.cjs files for async functions that contain at least one `await` expression but have no try/catch block wrapping the body. An un-caught rejection inside an async function becomes an unhandled promise rejection. In Node.js 15+ this crashes the process (the default mode changed from a deprecation warning to a fatal crash). One rule: async_await_no_try_catch (error) — a named async function / async arrow function with >=1 `await` in its body and no `try {` anywhere in its brace-delimited body. Siblings: find_missing_error_context, find_empty_catch_blocks, find_dangling_promises, find_unhandled_rejection_patterns. Pure text-scan (regex + brace-depth extraction), not an AST parser. Returns { path, filesScanned, findingsCount, errorCount, warningCount, truncated, findings: [{file,line,name,rule,severity,message}] }. Always available — does not require MCP_ALLOW_EXEC.',
    inputSchema: { type: 'object', properties: {
      path:       { type: 'string', description: "File or directory to scan (default: '.')." },
      extensions: { type: 'array', items: { type: 'string' }, description: 'File extensions to scan (default: .js/.jsx/.ts/.tsx/.mjs/.cjs).' },
      max_results:{ type: 'number', description: 'Cap on findings[] list length (1-5000, default 500).' },
    }},
  },
  {
    name: 'find_unhandled_rejection_patterns',
    description: 'Scans JS/TS entry-point files and project-wide for common patterns that indicate unhandled promise rejections could crash the server. Two rules: missing_global_rejection_handler (warning) — entry-point-like files (server.js, app.js, index.js, main.js, start.js, bootstrap.js, entry.js) have no `process.on(\'unhandledRejection\', ...)` call. In Node.js 15+ unhandled promise rejections crash the process. noop_rejection_handler (error) — `process.on(\'unhandledRejection\', () => {})` or similar no-op arrow/function handler that explicitly swallows errors silently — worse than none, hides real bugs. Siblings: find_missing_try_catch_in_async, find_dangling_promises, find_empty_catch_blocks. Pure text-scan (regex, project-wide for noop check; entry-point files only for missing-handler check). Returns { path, filesScanned, findingsCount, errorCount, warningCount, truncated, findings: [{file,line,rule,severity,message}] }. Always available — does not require MCP_ALLOW_EXEC.',
    inputSchema: { type: 'object', properties: {
      path:       { type: 'string', description: "File or directory to scan (default: '.')." },
      extensions: { type: 'array', items: { type: 'string' }, description: 'File extensions to scan (default: .js/.jsx/.ts/.tsx/.mjs/.cjs).' },
      max_results:{ type: 'number', description: 'Cap on findings[] list length (1-5000, default 500).' },
    }},
  },
];

module.exports = { UTIL_SCHEMAS_4 };

