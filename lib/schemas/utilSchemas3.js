"use strict";
// ── UTILITY TOOL SCHEMAS — part 3 of 3 ──────────────────────────────
// Re-split from utilSchemas.js/utilSchemas2.js once they crossed 500 lines
// again (accretion since the last split). 3-way split, concatenated back
// into UTIL_SCHEMAS by utilSchemas.js. Pure move, no behavior/content change.

const UTIL_SCHEMAS_3 = [
  {
    name: "scan_npm_lifecycle_scripts",
    description: "Scan package.json's 'scripts' field for supply-chain risk patterns — real npm attacks (compromised eslint-scope, ua-parser-js, event-stream) have abused install-time lifecycle hooks (preinstall/install/postinstall/prepare/etc.) that run automatically on `npm install` with no user confirmation. Flags: curl/wget output piped directly into a shell (arbitrary remote code execution); a lifecycle hook that fetches remote content at all (curl/wget/http(s):// present, even without an obvious pipe); eval(...) usage; destructive `rm -rf /` or `rm -rf ~`. Pure text/regex heuristic, not a shell parser — no variable expansion or multi-command AST. Returns { path, scriptsScanned, hookScriptsScanned, issueCount, errorCount, warningCount, truncated, issues: [{script,command,rule,severity,message}], errors: [{script,error}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      pkg_path: { type: "string", description: "Path to package.json (default: 'package.json')." },
      max_results: { type: "number", description: "Cap on the issues[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "check_semver_range_strictness",
    description: "Classifies each package.json dependency's declared version range by risk tier: exact pin (strictest, no issue), tilde (~1.2.3, patch-level drift, info), caret (^1.2.3, minor+patch drift — npm's default, info), complex comparator/hyphen/OR ranges (>=, <=, ||, harder to reason about, warning), and unbounded (*, '', 'latest', 'x' — no real guarantee, error). git+/github:/file:/link:/workspace:/npm:/http(s): specifiers are skipped (not semver-range syntax). Returns { path, depsScanned, exactCount, issueCount, errorCount, warningCount, infoCount, truncated, issues: [{block,name,range,tier,severity,message}], tierCounts }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      pkg_path: { type: "string", description: "Path to package.json (default: 'package.json')." },
      blocks: { type: "array", items: { type: "string" }, description: "Which package.json dependency blocks to scan (default: dependencies, devDependencies, optionalDependencies, peerDependencies)." },
      max_results: { type: "number", description: "Cap on the issues[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_empty_catch_blocks",
    description: "Scans JS/TS source for `catch` blocks (both `catch (e) { ... }` and bare `catch { ... }`) whose body has no meaningful content — no statements other than comments/whitespace — a silently-swallowed error with zero trace, almost always a bug masked as error handling. Pure text-scan (brace-depth walk), not a real parser: a comment-only catch body is still flagged (hasCommentOnly:true) since the error still vanishes at runtime; does not evaluate whether logging/rethrow logic inside a non-empty catch is *correct*, only whether the block is non-empty. Returns { path, filesScanned, findingsCount, truncated, findings: [{file,line,hasCommentOnly,snippet}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan when path is a directory (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_sync_fs_in_async_context",
    description: "Flags blocking `fs.*Sync`/`execSync`/`execFileSync`/`spawnSync` calls made inside the body of an `async function` (declaration, arrow, function expression, or object/class method shorthand) — using a blocking syscall inside async code still blocks the event loop for its full duration, defeating the purpose of making the function async and delaying every other in-flight async operation on the process. Pure text-scan (brace-depth walk), not a real parser: a sync call inside a nested non-async function defined within an async function's body is still flagged (accepted heuristic tradeoff); single-expression bodyless arrow functions (`async x => f()`) are out of scope. Returns { path, filesScanned, findingsCount, truncated, findings: [{file,line,asyncFunctionName,call,text}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan when path is a directory (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_hardcoded_credentials_in_config",
    description: "Structure-aware scan of config files (JSON/YAML parsed into a real object tree, .env parsed into key=value pairs — not a regex line-scan) for keys whose name implies a credential (password/secret/token/api key/access key/private key/client secret/auth key) whose value isn't an env-var placeholder or template reference (`${VAR}`, `$VAR`, `%VAR%`, `<PLACEHOLDER>`, `{{ .Values.x }}`), a common filler word (changeme/example/xxx/placeholder/etc.), or too short to plausibly be a real secret. Complements scan_secrets (which regex-scans arbitrary text/source for secret *shapes* like AWS keys/JWTs) by catching nested YAML/JSON credentials structurally rather than line-by-line. Matched values are redacted (first 2 + last 2 chars kept) — never leaks the credential it finds. Returns { path, filesScanned, findingsCount, truncated, findings: [{file,key,value}], parseErrors: [{file,error}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "Config file extensions to scan when path is a directory (default: .json/.yml/.yaml/.env; .env.* variants always included)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_hardcoded_ports",
    description: "Scans JS/TS source for `.listen(...)` call sites (app.listen/server.listen/http.createServer(...).listen, etc.) whose first argument is a bare numeric literal rather than something sourced from `process.env` — a hardcoded port breaks portability across environments and commonly collides with other services in containerized/CI setups. Pure text-scan on the call site's first argument, not a real parser: only the first (port) argument is inspected; an identifier argument (`server.listen(port)`) is never flagged even if that variable is hardcoded a few lines earlier (no cross-line data-flow tracing); `process.env.PORT || 3000` is not flagged (literal is only a fallback) but `3000 || process.env.PORT` is (literal is checked first). Returns { path, filesScanned, findingsCount, truncated, findings: [{file,line,port,text}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan when path is a directory (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_dangling_promises",
    description: "Scans JS/TS for floating Promises used as a bare statement (not awaited/returned/assigned/`.catch`'d): (1) a call to a known same-file async function, e.g. `doThing();`, or (2) a `.then(`-chained expression, e.g. `promise.then(cb);` / `foo().then(cb);`. Flagged unless `.catch(` also appears on the same line (rejection handled; `.finally(` does not count as handling). Complements find_missing_await (which flags ANY non-awaited async call, including ones used as arguments or in conditions) by focusing on statement position — the actual unhandled-rejection risk shape. Single-line heuristic: multi-line `.then(` chains are not detected, and only same-file async declarations are tracked for shape 1 (no cross-module resolution). Returns { path, filesScanned, findingsCount, truncated, findings: [{file,line,kind,text}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan when path is a directory (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_insecure_random_usage",
    description: "Scans JS/TS for `Math.random()` calls used in a security-sensitive spot: (1) inside a function/method whose name implies token/session/password/credential generation (generateToken, resetPassword, ...), or (2) assigned directly to a variable/object-property whose name implies the same. `Math.random()` is not cryptographically secure — flag as a hint to use `crypto.randomBytes`/`crypto.randomUUID` instead. Name-based heuristic only (can mis-classify in either direction); function-name detection covers brace-bodied declarations/arrows/function-expressions/method-shorthand only; assignment/property detection is single-line only. Findings deduplicated by source line. Returns { path, filesScanned, findingsCount, truncated, findings: [{file,line,kind,name,text}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan when path is a directory (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_unbounded_recursion",
    description: "Scans JS/TS for named functions (declaration/arrow/function-expression/method shorthand) that call themselves (self-recursion) with no visible base-case guard — `if(`, `?` ternary, `&&`, `||`, `switch(`, or `return` — appearing before the first recursive call in the body. Unguarded recursion is a strong stack-overflow-risk signal. Pure text-scan: a guard token anywhere earlier in the body counts as 'guarded' (no control-flow-graph reachability analysis); only direct self-calls are detected, not mutual recursion (A calls B calls A); only brace-bodied named functions are scanned. Returns { path, filesScanned, findingsCount, truncated, findings: [{file,line,functionName,text}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan when path is a directory (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "check_dockerignore_coverage",
    description: "Checks whether candidate paths would be excluded from the Docker build context by a project's .dockerignore file. No git dependency and no docker CLI call — unlike check_gitignore_coverage (which shells out to `git check-ignore`), this implements its own simplified pattern matcher: literal segments, '*' (any chars, no '/'), '?' (one char, no '/'), '**' (zero or more path segments), and '!' negation, evaluated in file order with last-match-wins semantics. Does not implement every edge case of Docker's real patternmatcher (e.g. re-including a file under an already-excluded parent directory) — treat results as a strong heuristic, not a byte-for-byte guarantee of real `docker build` behaviour. With no `paths` argument: checks a representative default set of common build-context bloat/leak candidates (node_modules, .git, .env, dist/build output, IDE folders, OS cruft) and returns actionable recommendations for anything not covered. Supply `paths` to check specific candidate paths instead (no recommendations, since custom paths aren't presumed to be junk). Returns { path, dockerignoreFile, ruleCount, usingDefaults, totalChecked, ignoredCount, notIgnoredCount, results: [{path, ignored, matchedRule}], recommendations }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "Directory containing the .dockerignore file to check (default: first root)." },
      paths: { type: "array", items: { type: "string" }, description: "Specific candidate paths to check instead of the built-in default set (max 100)." },
      dockerignore_path: { type: "string", description: "Relative path to the ignore file if not '.dockerignore' at the given directory's root." },
    }},
  },
  {
    name: "check_test_flakiness_risk",
    description: "Scans JS/TS test files for three common causes of flaky/non-deterministic test runs: (1) bare_settimeout_wait — a `setTimeout(` call whose callback body looks like an assertion (expect(/assert(/.should) with no 'Promise' token within the preceding 60 characters, i.e. not the sanctioned `await new Promise(r => setTimeout(r, ms))` sleep idiom; (2) date_now_or_random_in_assertion — Date.now()/Math.random() used directly on the same line as an assertion call, with no fake-timer/mock hint (useFakeTimers/sinon fake clock/mockdate/jest.spyOn(Date) found anywhere in the file; (3) shared_mutable_state_across_tests — a module-level `let`/`var` (mutable, non-const) variable written inside one `it(`/`test(` callback and referenced inside a different `it(`/`test(` callback, a test-order-dependency smell. Pure text-scan, not a real parser: rule 1's Promise-token lookback is a documented heuristic over-suppression; rule 2's fake-timer detection is file-wide, not scoped to the specific test block; rule 3 does not distinguish a legitimate beforeEach reset from a real cross-test leak. Returns { path, filesScanned, findingsCount, truncated, findings: [{file,line,rule,severity,...}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan when path is a directory (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "check_missing_csp_header",
    description: "Scans JS/TS for Express apps with route registrations (app./router.get|post|put|delete|patch|all) but no Content-Security-Policy hint anywhere in the scanned files — neither the `helmet` middleware nor a manual literal 'Content-Security-Policy' header — a single project-level finding (missing_csp_header, warning). Also individually flags `helmet({ contentSecurityPolicy: false })` call sites (csp_explicitly_disabled, warning) which explicitly turn off the CSP helmet would otherwise set, easy to miss during a security review. Pure text-scan, not an AST/app-instance-aware parser: CSP-hint detection is project-wide (a CSP set in one file of the scanned tree counts as present for the whole scan); only the literal header name is recognized, so a CSP set via a custom wrapper with no literal 'Content-Security-Policy' string anywhere in the scanned files will not be detected. Returns { path, filesScanned, hasRouteRegistrations, hasCspHint, findingsCount, errorCount, warningCount, truncated, findings: [{file,line,rule,severity,message}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan when path is a directory (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_missing_sort_comparator",
    description: "Scans JS/TS for bare `.sort()` calls (no comparator argument) on arrays textually tracked as holding numbers: `const/let/var NAME = [n1, n2, ...]` where every element is a bare numeric literal, `const/let/var NAME = ....map(Number)`/`.map(parseInt)`, or a numeric-literal array chained directly into `.sort()` with no intermediate variable. Default `Array.prototype.sort()` sorts lexicographically (string order) — `[1, 2, 10].sort()` yields `[1, 10, 2]` — a classic silent bug on numeric data. Pure text-scan (regex, no data-flow/type analysis): only the declaration shapes above mark a variable as numeric; a numeric array built any other way (returned from a function, pushed to incrementally, destructured) is not tracked; a variable reassigned to a non-numeric array after the tracked declaration is still treated as numeric (no reassignment tracking); `.sort(undefined)`/`.sort(null)` are not treated as bare calls. Returns { path, filesScanned, findingsCount, truncated, findings: [{file,line,rule,severity,variable?,declaredAtLine?,message}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan when path is a directory (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_req_body_mass_assignment",
    description: "Scans JS/TS for req.body (or a bare `const/let/var NAME = req.body;` alias) passed directly into an ORM write with no visible pick/omit/sanitize step in between — classic mass-assignment: a client can set any field, including ones never meant to be client-writable (e.g. role, isAdmin). `mass_assignment_via_create` (error) — `X.create(req.body)` / `X.create({...req.body, ...})` / tracked-alias form. `mass_assignment_via_update` (error) — same argument shapes into `.update(`/`.updateOne(`/`.updateMany(`/`.findByIdAndUpdate(`/`.findOneAndUpdate(`. `mass_assignment_via_constructor` (warning, lower confidence) — `new X(req.body)`, since text-scan can't confirm X is an ORM model. A same-window sanitize hint (`pick(`, `omit(`, `sanitize`, `validate`, `Joi.`, `zod`, `.parse(`, `ALLOWED_FIELDS`, `allowlist`/`whitelist`, case-insensitive) suppresses the finding. Pure text-scan, not an AST/data-flow parser: only the exact whole-statement alias shape above marks a variable tainted; taint through any other path (function param, reassignment, spread into another var) is untracked; the sanitize hint is a nearby textual signal, not proof it reaches the tainted value. Returns { path, filesScanned, findingsCount, errorCount, warningCount, truncated, findings: [{file,line,rule,severity,callee,message}] }. Always available — does not require `MCP_ALLOW_EXEC`.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan when path is a directory (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_prototype_pollution_risk",
    description: "Scans JS/TS for unguarded deep-merge / recursive-assign prototype-pollution shapes. `prototype_pollution_via_merge` (error) — `_.merge(`/`lodash.merge(`/`deepmerge(` called with a request-input-tainted argument (`req.body`/`req.query`/`req.params`/`JSON.parse(...)`) and no `__proto__`/`constructor`/`prototype` guard hint nearby. `prototype_pollution_via_object_assign` (warning) — `Object.assign(` called with a tainted source and no guard hint nearby (Object.assign is shallow, but a source with a literal `__proto__` own key still triggers Object.prototype's accessor). `unguarded_recursive_merge_function` (warning) — a hand-rolled function whose body both iterates a source object's keys (`for...in`/`Object.keys(...).forEach(`/`for...of Object.keys(...)`) and assigns into a target via bracket notation, with no guard anywhere in the function body. Pure text-scan (regex + brace-depth function-body extraction), not an AST/data-flow parser: taint/guard checks are textual proximity signals, not proof of actual reachability; recursive-merge detection requires both sub-patterns in the same function body (no cross-function call-graph analysis). Returns { path, filesScanned, findingsCount, errorCount, warningCount, truncated, findings: [{file,line,rule,severity,functionName?,message}] }. Always available — does not require `MCP_ALLOW_EXEC`.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan when path is a directory (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "check_missing_rate_limit",
    description: "Scans JS/TS for authentication/credential-reset/token-issuing route registrations (`app.`/`router.<verb>()` with a path containing login/signin/register/signup/reset-password/forgot-password/token/otp/verify) with no rate-limiting hint anywhere in the scanned files (`express-rate-limit`, `rateLimit(`/`slowDown(` call, or rate-limiter-flexible's `RateLimiterMemory`/`RateLimiterRedis`/`RateLimiterCluster`) — brute-force/credential-stuffing exposure. Project-level check (same convention as check_missing_csp_header): a single finding is reported (file/line null) listing every matched auth-route registration site, only when auth routes exist AND no rate-limit hint exists anywhere in scope. Pure text-scan (regex), not an AST/app-instance-aware parser: the rate-limit hint is project-wide (any usage anywhere in the scanned tree counts as present for the whole scan, matching a global app.use(rateLimit()) elsewhere in the app); route detection is path-string-literal keyword matching, so a dynamically-built path or an unrecognized keyword is not detected; a rate limiter imported/configured but never wired to app.use()/router.use() still counts as present (textual presence, not proof of wiring). Returns { path, filesScanned, hasAuthRoutes, hasRateLimitHint, findingsCount, warningCount, truncated, findings: [{file,line,rule,severity,authRoutes,message}] }. Always available — does not require `MCP_ALLOW_EXEC`.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan when path is a directory (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "check_dependency_confusion_risk",
    description: "Scans package.json for dependency-confusion supply-chain risk. `unscoped_internal_looking_dependency` (error) — a dependency name matches an internal-looking prefix (explicitly supplied via `internal_package_prefixes`, or auto-derived from the scanned package.json's own scope, e.g. this project being `@acme/foo` treats `@acme/` as internal) but the dependency itself has no `@scope/` prefix — an unscoped internal-looking name can be squatted on the public registry. `scoped_dependency_missing_registry_pin` (warning) — a scoped dependency (`@scope/name`) exists but no matching `@scope:registry=` line was found in a sibling `.npmrc` — without an explicit pin, some configurations can still fall through to the public registry for that scope. Pure heuristic, zero-network: this tool never queries the public registry to confirm actual squattability, only that local configuration provides no protection against it. Returns { path, depsScanned, ownScope, internalPrefixesUsed, issueCount, errorCount, warningCount, truncated, issues: [{block,name,rule,severity,message}] }. Always available — does not require `MCP_ALLOW_EXEC`.",
    inputSchema: { type: "object", properties: {
      pkg_path: { type: "string", description: "Path to package.json (default: 'package.json')." },
      blocks: { type: "array", items: { type: "string" }, description: "Dependency blocks to scan (default: dependencies/devDependencies/peerDependencies/optionalDependencies)." },
      internal_package_prefixes: { type: "array", items: { type: "string" }, description: "Explicit unscoped internal-name prefixes to flag if found without a scope (e.g. ['acme-'])." },
      max_results: { type: "number", description: "Cap on the issues[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_error_message_leaking_internals",
    description: "Scans JS/TS for raw error objects sent directly in an HTTP response — leaking internal file paths, dependency versions, and code structure to end users (and to attackers probing for exploitable details). `error_stack_in_response` (error) — an error identifier's `.stack` passed into res.send(/res.json(/res.end(. `raw_error_object_in_response` (warning) — the bare error identifier itself passed into res.send(/res.json( (e.g. `res.json({ error: err })` — many setups serialize the full Error object including `.stack`). `error_interpolated_in_response` (warning) — the error identifier interpolated into a template-literal string passed to res.send(/res.json(. Error identifiers default to err/error/e/exc, overridable via `error_identifiers`. A nearby NODE_ENV/isProduction/isDev guard suppresses the finding (dev-only debug branches are a deliberate, accepted pattern). Pure text-scan (regex), not an AST/data-flow parser: only literal identifier names are tracked; an error object threaded into a differently-named variable before reaching the response is out of scope. Returns { path, filesScanned, findingsCount, errorCount, warningCount, truncated, findings: [{file,line,rule,severity,message}] }. Always available — does not require `MCP_ALLOW_EXEC`.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan when path is a directory (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      error_identifiers: { type: "array", items: { type: "string" }, description: "Catch-binding names to treat as raw error identifiers (default: err/error/e/exc)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_disabled_tls_verification",
    description: "Scans JS/TS for disabled TLS/SSL certificate verification — a man-in-the-middle exposure. `reject_unauthorized_false` (error) — a literal `rejectUnauthorized: false` option anywhere (https.request/https.Agent/tls.connect/axios httpsAgent config/etc.). `node_tls_reject_unauthorized_env` (error) — `process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'` or an inline `NODE_TLS_REJECT_UNAUTHORIZED=0` shape, which disables verification process-wide for every TLS connection. `insecure_https_agent` (error) — `new https.Agent({...})`/`new tls.SecureContext(...)` whose argument object contains `rejectUnauthorized: false` (paren-depth call-arg extraction), reported once per constructor call. A nearby NODE_ENV/isDev/isTest guard suppresses the finding (a scoped dev/test-only bypass against a local self-signed cert is a common, accepted pattern). Pure text-scan (regex + paren-depth extraction), not a data-flow parser: a value passed indirectly through a variable is not tracked unless the variable name itself is literally `false`. Returns { path, filesScanned, findingsCount, errorCount, truncated, findings: [{file,line,rule,severity,message}] }. Always available — does not require `MCP_ALLOW_EXEC`.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan when path is a directory (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_unpinned_docker_base_image",
    description: "Scans Dockerfiles for base images that aren't strictly pinned — a supply-chain reproducibility gap where a rebuild months later may silently pull different bytes. Complements scan_dockerfile_issues (general Dockerfile hygiene) without duplicating its checks. `missing_tag_or_digest` (error) — a FROM with no tag or digest, resolving to the mutable 'latest' tag. `explicit_latest_tag` (error) — an explicit ':latest' tag with no digest. `bare_major_version_tag` (warning) — a tag with fewer than 3 numeric segments (e.g. 'node:18') or a rolling codename (e.g. 'ubuntu:jammy') and no digest. `unresolvable_dynamic_tag` (warning) — the image ref contains a build-arg interpolation (`${...}`/`$VAR`), so pin strictness can't be determined statically. Multi-stage `FROM <earlier-stage-alias>` references are skipped (not external images). A digest pin (`@sha256:...`) always satisfies pinning regardless of tag. If `path` is a directory it's scanned recursively for files named `Dockerfile`, `Dockerfile.*`, or `*.dockerfile`; if it's a single file, only that file is scanned. Pure text-scan (regex + line-continuation joining), not a Dockerfile parser/BuildKit frontend. Returns { path, filesScanned, findingsCount, errorCount, warningCount, truncated, findings: [{file,line,rule,severity,message}] }. Always available — does not require `MCP_ALLOW_EXEC`.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "Dockerfile or directory to scan (default: '.')." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "check_missing_helmet_security_headers",
    description: "Scans JS/TS for Express apps with route registrations but no generic security-hardening header hint anywhere in scanned files. Broader sibling of check_missing_csp_header (CSP-specific only). Checks for the `helmet(` middleware call OR any of X-Content-Type-Options/X-Frame-Options/Strict-Transport-Security/X-DNS-Prefetch-Control/X-Download-Options/X-Permitted-Cross-Domain-Policies as a literal string. `missing_security_headers` (warning) — routes exist with no such hint anywhere (single project-level finding, file/line null). `helmet_module_explicitly_disabled` (warning) — a helmet built-in module explicitly turned off (`frameguard: false`, `hsts: false`, `noSniff: false`, `dnsPrefetchControl: false`, `ieNoOpen: false`, `permittedCrossDomainPolicies: false`), one finding per disabled module with the real line number. Pure text-scan (regex), not an AST/app-instance-aware parser: hint detection is project-wide, not per-app-instance; only the literal header names/option names above are recognized. Returns { path, filesScanned, hasRouteRegistrations, hasSecurityHeaderHint, findingsCount, errorCount, warningCount, truncated, findings: [{file,line,rule,severity,message}] }. Always available — does not require `MCP_ALLOW_EXEC`.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan when path is a directory (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_duplicate_route_registrations",
    description: "Scans JS/TS for Express route registrations (app./router.get|post|put|delete|patch|all) sharing the same HTTP method + literal path string more than once. Express resolves in registration order, so only the first matching handler ever runs — later duplicates are silently dead code (a common copy-paste bug). Only literal quoted paths are compared (a `${...}`-interpolated template literal path is skipped, not guessed at); aggregation is project-wide across all scanned files, not per-file. `duplicate_route_registration` (warning) — one finding per duplicate occurrence beyond the first, naming the file:line of the earlier registration it's shadowed by. Pure text-scan, not a route-table simulator: does not resolve router mount-prefix concatenation or path-parameter-name equivalence (`/users/:id` vs `/users/:userId` are textually different, not flagged). Returns { path, filesScanned, routeRegistrationsSeen, duplicateGroupsCount, findingsCount, warningCount, truncated, findings: [{file,line,rule,severity,message}] }. Always available — does not require `MCP_ALLOW_EXEC`.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan when path is a directory (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_missing_pagination_limit",
    description: "Scans JS/TS for Express GET route handlers that look like they return a full collection/query result (`res.json(`/`res.send(` plus a DB/collection list call — `.find(`/`.findAll(`/`.findMany(`/`.query(` — both within the same route-registration call) with no visible pagination hint anywhere in the handler (`limit`/`take`/`skip`/`offset`/`page`/`pageSize` as a bare word, or `.slice(`). An endpoint returning an entire table/collection with no bound grows unboundedly with the data — a common scaling/DoS-shaped bug. Restricted to `get` registrations only. Pure text-scan (regex + paren-depth extraction, same convention as find_promise_all_without_catch): does not verify the `.find(`-returned value is actually what's passed to `res.json(`/`res.send(` (both hints firing anywhere in the handler counts as a match), and a pagination hint anywhere in the handler (even unrelated) suppresses the finding. `missing_pagination_limit` (warning). Returns { path, filesScanned, getRoutesSeen, findingsCount, warningCount, truncated, findings: [{file,line,rule,severity,message}] }. Always available — does not require `MCP_ALLOW_EXEC`.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan when path is a directory (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_missing_error_boundary_in_async_route",
    description: "Scans JS/TS for Express route registrations (any of get/post/put/delete/patch/all, on `app` or `router`) whose handler is declared `async` but whose call has no `try`/`catch` anywhere in it and isn't wrapped by a known async-handler helper (`asyncHandler(`/`wrapAsync(`/`catchAsync(`). A rejected promise inside such a handler with no catch and no wrapper crashes the process or leaves the request hanging instead of reaching Express error handling. Distinct from find_promise_all_without_catch (targets Promise.all( call sites) and find_unhandled_express_error_middleware (checks whether error middleware exists at all, not per-handler coverage). Pure text-scan (regex + paren-depth extraction), same convention as find_missing_pagination_limit: `async` detection is a bare-word heuristic scoped to the route call text, and a wrapper call anywhere in the registration suppresses the finding. `missing_error_boundary_in_async_route` (warning). Returns { path, filesScanned, routesSeen, findingsCount, warningCount, truncated, findings: [{file,line,rule,severity,message}] }. Always available — does not require `MCP_ALLOW_EXEC`.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan when path is a directory (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_missing_websocket_error_handler",
    description: "Scans JS/TS for `.on('connection', ...)` registrations (ws's WebSocketServer or socket.io's `io.on('connection', ...)`) whose callback accepts a socket parameter but never registers a sibling `<socket>.on('error', ...)` listener inside the handler body. Node's EventEmitter throws (and can crash the process with no other listener) when an 'error' event is emitted with no listener attached — a single misbehaving client's socket can take down the whole server. The socket/connection parameter name is extracted from the callback's first parameter so the check is scoped to that variable, not just any `.on('error'` in the file; if the parameter name can't be extracted, the registration is skipped rather than guessed at. Pure text-scan (regex + paren-depth extraction), same convention as find_missing_pagination_limit: does not resolve error listeners attached via a helper function the socket is passed into. `missing_websocket_error_handler` (warning). Returns { path, filesScanned, connectionHandlersSeen, findingsCount, warningCount, truncated, findings: [{file,line,rule,severity,message}] }. Always available — does not require `MCP_ALLOW_EXEC`.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan when path is a directory (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_unbounded_array_push_in_loop",
    description: "Scans JS/TS for for/while loops and .forEach(/.map( calls whose body .push(es onto an array declared as an array literal (`= []`) earlier in the same file, with no visible cap anywhere in the loop body (`.length <` bound check, `.slice(`, or a bare `break`). An ever-growing in-memory array with no bound — especially one driven by external input — is a common unbounded-memory-growth shape, distinct from find_unbounded_object_growth (object key growth) and find_missing_pagination_limit (HTTP response shape). For/while loops: single-statement bodies with no `{...}` block are skipped rather than guessed at. The 'declared outside the loop' check is a whole-file heuristic (const/let/var name = [ appearing anywhere earlier), not real scope resolution — a same-named unrelated local declared earlier could false-positive. Pure text-scan (regex + paren/brace-depth extraction). `unbounded_array_push_in_loop` (warning). Returns { path, filesScanned, loopsSeen, findingsCount, warningCount, truncated, findings: [{file,line,rule,severity,message}] }. Always available — does not require `MCP_ALLOW_EXEC`.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: '.')." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan when path is a directory (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
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
];
module.exports = { UTIL_SCHEMAS_3 };
