"use strict";
// ── UTILITY TOOL SCHEMAS — part 2 of 3 ──────────────────────────────
// Re-split from utilSchemas.js/utilSchemas2.js once they crossed 500 lines
// again (accretion since the last split). 3-way split, concatenated back
// into UTIL_SCHEMAS by utilSchemas.js. Pure move, no behavior/content change.

const UTIL_SCHEMAS_2 = [
  {
    name: "check_branch_protection_hints",
    description: "Heuristic scan for repo-local signals that commonly accompany GitHub branch protection — the actual rules live server-side on GitHub, not in the checkout, so this is a proxy, not a definitive check. Looks for: a CODEOWNERS file (root, .github/, or docs/) as a required-reviewers proxy; .github/workflows/*.yml|.yaml files, flagging which ones trigger on pull_request (their job names are the conventional 'required status check' names in GitHub's UI); and .github/settings.yml (the probot 'Settings' app format), parsed for an explicit branches[].protection block when present. Returns { path, hasCodeowners, codeownersPath, workflowsDir, workflows: [{file, runsOnPR, jobNames}], anyWorkflowRunsOnPR, settingsYml: {present, parsed, branchesDeclared, branchesWithProtection}, hints: string[] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "Directory to scan (default: first root)." },
    }},
  },
  {
    name: "find_hardcoded_ips",
    description: "Scan a file or directory tree for hardcoded IPv4/IPv6 literals — a lightweight config/secrets-hygiene companion to scan_secrets. Pattern-shape scanner, not a semantic one: cannot distinguish a real network address from a version-number/UUID-segment lookalike, and never touches the network (no DNS/reachability checks). Each match is classified: 'loopback-or-broadcast' (127.0.0.1/0.0.0.0/255.255.255.255/::1), 'private' (RFC1918/link-local/unique-local), or 'public' (everything else — the actual signal this tool exists to surface). By default only 'public' addresses are reported (loopback/private are near-always noise — dev defaults, docker-compose IPs); pass include_private:true to see everything. Same MCP_IGNORE-aware walk and binary-skip heuristic as scan_secrets/scan_todos. Returns { path, filesScanned, totalMatches, truncated, byClassification, filesAffected, matches: [{file, line, ip, version, classification}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: first root)." },
      extensions: { type: "array", items: { type: "string" }, description: "Directory mode only: restrict to files with these extensions." },
      max_matches: { type: "number", description: "Cap on total matches returned (1-5000, default 500)." },
      include_private: { type: "boolean", description: "Also report loopback/private/link-local addresses (default false — only 'public' addresses are reported)." },
    }},
  },
  {
    name: "find_env_var_usage",
    description: "Scan a source tree for environment-variable references (`process.env.X`/`process.env['X']`, `os.environ['X']`/`os.environ.get('X')`, `os.getenv('X')`) and cross-check the referenced names against one or more env-example files (default: .env.example then .env, missing files skipped silently — not an error). Flags names referenced in code but not documented in any env file ('undocumented' — likely a new var a contributor forgot to add to the example) and names documented but never referenced ('unused' — stale config, or only referenced dynamically in a way this text-scan can't see). SECRET-SAFETY: only key names are ever extracted from env files — values are read only to locate the `=` separator and are never included in the output, even for a real `.env` containing live secrets. Pure text-scan, same MCP_IGNORE-aware walk as find_unused_dependencies/find_circular_deps. Returns { scanPath, filesScanned, envFilesRead, documentedCount, referencedCount, undocumented: string[], unused: string[] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "Directory to scan for env-var references (default: first root)." },
      env_files: { type: "array", items: { type: "string" }, description: "Env file paths to cross-check against, in order (default: ['.env.example', '.env']). Missing files are skipped, not an error." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan (default: .js/.jsx/.ts/.tsx/.mjs/.cjs/.py)." },
    }},
  },
  {
    name: "check_npm_audit_cache",
    description: "Summarise npm-audit vulnerability counts by severity. Reads a pre-generated `npm audit --json` report — either an explicit cache_path, or one of the conventional default filenames (npm-audit.json, .npm-audit-cache.json, audit-report.json) inside `path` — and normalises it (supports both the npm v7+ shape and the legacy npm v6 `advisories` shape) into a severity breakdown. If no cached report is found, returns found:false with a hint rather than erroring, unless run_live:true is set, in which case it spawns `npm audit --json` in `path` directly (requires network access to the npm registry; not the default, since cached-report reading is deterministic and offline-friendly). Returns { path, source, cacheFile, found, totalVulnerabilities, bySeverity: {info,low,moderate,high,critical}, dependenciesAudited, advisories: [{name, severity, fixAvailable}], truncated, hints }. Requires MCP_ALLOW_EXEC only when run_live:true; reading a cache file does not.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "Project directory to scan for a default-named audit cache file, or to run `npm audit` in if run_live is set (default: first root)." },
      cache_path: { type: "string", description: "Explicit path to a pre-generated `npm audit --json` report to read, overriding the default-filename search." },
      run_live: { type: "boolean", description: "If true and no cache file is found, actually spawn `npm audit --json` in `path` (default false — requires network access to the npm registry)." },
      timeout_ms: { type: "number", description: "Timeout in ms for a live npm audit run (1000-60000, default 20000). Ignored when reading a cache file." },
      max_results: { type: "number", description: "Cap on the advisories[] list length (1-500, default 20)." },
    }},
  },
  {
    name: "git_hooks_audit",
    description: "Heuristic, filesystem-only audit (no git binary calls) of Git hook tooling: cross-checks .husky/ hook scripts (husky v6+ layout), .git/hooks/ locally-configured hooks (not version-controlled — invisible to other clones/CI), and package.json's husky/lint-staged config and dependencies. Flags: husky dependency present but no .husky hooks wired; legacy husky v4 package.json \"husky.hooks\" config that's dead in v6+; lint-staged configured/installed but not invoked by any .husky hook; non-portable .git/hooks/* entries; and total absence of hook tooling. Returns { path, pkgPath, huskyDirPresent, huskyHooks, gitHooksDirLocalHooks, packageJsonLegacyHuskyHooks, lintStagedConfigured, dependsOnHusky, dependsOnLintStaged, lintStagedWiredInHook, hints }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "Repo-root-ish directory to scan for .husky/.git/hooks (default: first root)." },
      pkg_path: { type: "string", description: "Path to package.json to read husky/lint-staged config from (default: 'package.json' inside `path`)." },
    }},
  },
  {
    name: "file_stats",
    description: "Compute aggregate statistics for a directory tree: total file count, total/avg/max/min byte sizes, breakdown by file extension (sorted by total bytes), and a top-N list of the largest files. MCP_IGNORE'd directories (e.g. node_modules, .git) are excluded. Useful for understanding project composition, finding bloated file types, or auditing disk usage. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path:       { type: "string", description: "Directory to analyse (default: first root)." },
      top_n:      { type: "number", description: "Number of largest files to list (1–100, default: 10)." },
      extensions: { type: "array",  items: { type: "string" }, description: "Optional: only consider files with these extensions, e.g. ['.js', '.ts']." },
    }},
  },
  {
    name: "dir_size_stats",
    description: "Directory-level disk-usage rollup for a directory tree, similar in spirit to `du -h --max-depth=N`. Each reported directory's `bytes`/`fileCount` are recursive — they include everything nested beneath it, however deep — but which directories are *listed* is capped by `max_depth` levels below the scanned root. Complements `file_stats` (which lists individual largest files) by answering 'which subdirectory is eating the most disk space' without eyeballing `file_tree` with sizes:true or manually summing `file_stats` entries. The scanned root itself is never listed as a directory entry — its totals are the top-level totalBytes/totalFiles/totalDirs fields instead. Directories are sorted by bytes descending and capped at top_n. MCP_IGNORE'd directories (e.g. node_modules, .git) are excluded. Returns { path, maxDepth, totalBytes, totalFiles, totalDirs, directories: [{path, depth, bytes, fileCount}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path:      { type: "string", description: "Directory to analyse (default: first root)." },
      max_depth: { type: "number", description: "How many levels of subdirectories below the root to report individually (1–10, default: 2)." },
      top_n:     { type: "number", description: "Max number of directories to return, sorted by bytes descending (1–200, default: 20)." },
    }},
  },
  {
    name: "disk_usage_summary",
    description: "One-call disk-usage snapshot for a directory tree, combining `file_stats` and `dir_size_stats` output into a single result so a caller doesn't need two separate tool round-trips for the common 'what's using space here' workflow. Returns { path, totalBytes, totalFiles, totalDirs, avgBytes, largestFiles: [{path, bytes}], largestDirs: [{path, depth, bytes, fileCount}], byExtension: [{ext, count, bytes}] }. MCP_IGNORE'd directories (e.g. node_modules, .git) are excluded. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path:      { type: "string", description: "Directory to analyse (default: first root)." },
      top_files: { type: "number", description: "Number of largest files to list (1–100, default: 10)." },
      top_dirs:  { type: "number", description: "Number of largest subdirectories to list (1–200, default: 10)." },
      max_depth: { type: "number", description: "How many levels of subdirectories to consider for top_dirs (1–10, default: 3)." },
    }},
  },
  {
    name: "csv_query",
    description: "Parse a CSV file (RFC 4180 — handles quoted fields, embedded commas and newlines, optional BOM) and return rows as structured JSON objects, OR grouped aggregate summary rows when 'aggregate' is supplied. Non-aggregate mode supports column projection (select a subset of columns), row slicing (offset + limit), and a simple single-column equality filter — returns { path, columns, totalRows (after filtering), returnedRows, rows }. Aggregate mode is triggered by a non-empty 'aggregate' array of {column, op} entries (op: 'sum'|'avg'|'count'|'min'|'max' — 'count' may omit column to count all rows in the group, or supply column to count only its non-empty values; 'sum'/'avg'/'min'/'max' require column and throw a clear -32602 error on any non-numeric value encountered, rather than silently producing NaN); optionally group rows first via 'group_by' (a column name) — with no group_by, the whole filtered table is treated as one implicit group. Groups are sorted deterministically by group key and each result field is named '<op>_<column>' (e.g. 'sum_price'), or bare 'count' when count's column is omitted. offset/limit paginate over the returned groups in aggregate mode (instead of over raw rows). Returns { path, groupBy, aggregates: [{column, op, field}], totalRows, groupCount, returnedGroups, groups: [{group?, <op>_<column>: value, ...}] } in aggregate mode. The first row is treated as a header by default (set has_header: false for header-less files, whose synthetic columns are named col0/col1/...). Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", required: ["path"], properties: {
      path:       { type: "string",  description: "Path to the CSV file to query." },
      columns:    { type: "array",   items: { type: "string" }, description: "Column names to include in output (default: all). Ignored in aggregate mode." },
      offset:     { type: "number",  description: "Skip the first N data rows, or first N groups in aggregate mode (default: 0)." },
      limit:      { type: "number",  description: "Maximum number of rows (or groups, in aggregate mode) to return (1–10000, default: 100)." },
      filter_col: { type: "string",  description: "Column name to filter on (exact equality, case-sensitive). Applied before grouping/aggregation." },
      filter_val: { type: "string",  description: "Value that filter_col must equal for a row to be included." },
      has_header: { type: "boolean", description: "Whether the first row is a header row (default: true). Set false for header-less CSVs." },
      group_by:   { type: "string",  description: "Column name to group rows by before aggregating. Requires a non-empty 'aggregate' array. Omit to aggregate over the whole (filtered) table as a single group." },
      aggregate:  { type: "array",   items: { type: "object", properties: {
                      column: { type: "string", description: "Column to aggregate. Required for sum/avg/min/max; optional for count." },
                      op:     { type: "string", description: "Aggregate function: 'sum', 'avg', 'count', 'min', or 'max'." },
                    }, required: ["op"] },
                    description: "Non-empty array of {column, op} aggregate specs. Presence of this array (non-empty) switches csv_query into aggregate/grouped-summary mode." },
    }},
  },
  {
    name: "csv_diff",
    description: "Row-level diff of two CSV files — a read-only companion to csv_query/csv_convert (no CSV comparison tool existed previously). Two modes: if 'key_column' is given, rows are matched by that column's value (a real identity diff — row order/position doesn't matter); if omitted, rows are matched by POSITION/index (documented by-index convention, same as json_diff/json_patch_generate, not an LCS/edit-distance diff) — extra right-side rows are 'added' at ascending indices, extra left-side rows are 'removed' at descending (highest-first) indices. Column sets may differ between the two files; the diff runs over the UNION of both files' headers (a missing cell reads as \"\", matching csv_query's convention) so an added/removed column surfaces as a per-cell change rather than being silently ignored. Duplicate key values within either file's key_column throw a clear -32602 error rather than silently picking one. The first row is treated as a header by default (has_header: false for header-less files, whose synthetic columns are named col0/col1/...). A max_rows budget (default 2000, hard cap 20000) caps the combined added+removed+changed entries enumerated; addedCount/removedCount/changedCount always reflect the true totals even when truncated:true. Returns { left, right, keyColumn, hasHeader, totalLeftRows, totalRightRows, identical, addedCount, removedCount, changedCount, truncated, added: [{key, row}], removed: [{key, row}], changed: [{key, cells: [{column, oldValue, newValue}]}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", required: ["left", "right"], properties: {
      left:       { type: "string",  description: "Path to the 'before' / baseline CSV file." },
      right:      { type: "string",  description: "Path to the 'after' / target CSV file." },
      key_column: { type: "string",  description: "Column name to match rows by (identity diff). Omit to match rows by position/index instead." },
      has_header: { type: "boolean", description: "Whether the first row is a header row in BOTH files (default: true)." },
      max_rows:   { type: "number",  description: "Cap on the number of added+removed+changed entries enumerated (default 2000, hard cap 20000). The *Count fields reflect the true totals regardless." },
    }},
  },
  {
    name: "http_fetch",
    description: "Make an outbound HTTP or HTTPS request and return the response status, headers, and body as text. Useful for calling external APIs, health-checking URLs, triggering webhooks, or fetching remote data without needing shell execution. Only http: and https: schemes are allowed (file://, data://, ftp:// etc. are rejected). Follows up to 5 redirects automatically. Response body is returned as UTF-8 text, truncated at 100 KB to avoid flooding the MCP channel. Does NOT persist the response to disk — combine with write_file if you need to save it. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", required: ["url"], properties: {
      url:     { type: "string",  description: "The target URL (must start with http:// or https://)." },
      method:  { type: "string",  description: "HTTP method: 'GET' (default), 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'." },
      headers: { type: "object",  description: "Extra request headers as key-value pairs, e.g. { 'Authorization': 'Bearer abc', 'Accept': 'application/json' }.", additionalProperties: { type: "string" } },
      body:    { type: "string",  description: "Request body string (only sent for POST, PUT, PATCH). Set Content-Type header accordingly." },
      timeout: { type: "number",  description: "Request timeout in seconds (default: 15, max: 60)." },
    }},
  },
  {
    name: "port_check",
    description: "Probe whether a TCP port on a host is open by attempting a raw socket connect. Returns { host, port, open, timeMs, error? } — 'open' is true only on a successful TCP connect; timeouts and connection errors (ECONNREFUSED, ENOTFOUND, etc.) both resolve with open:false plus a short 'error' code, never throw. Useful for checking if a local dev server, database, or remote service is listening before running dependent steps. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", required: ["host", "port"], properties: {
      host:    { type: "string", description: "Hostname or IP address to probe." },
      port:    { type: "number", description: "TCP port number (1-65535)." },
      timeout: { type: "number", description: "Connection timeout in seconds (default: 3, max: 30)." },
    }},
  },
  {
    name: "wait_for_port",
    description: "Poll a TCP port repeatedly until it opens or an overall timeout budget is exhausted — convenience wrapper around port_check for 'wait until service is up' workflows (e.g. waiting for a dev server or database to finish starting before running dependent steps). Returns { host, port, open, attempts, elapsedMs, error? }; 'open' is true as soon as any attempt connects successfully, false if the overall timeout elapses first (with the last attempt's error code, if any). Never throws on connection failure/timeout — only on invalid parameters. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", required: ["host", "port"], properties: {
      host:            { type: "string", description: "Hostname or IP address to probe." },
      port:            { type: "number", description: "TCP port number (1-65535)." },
      timeout:         { type: "number", description: "Overall wait budget in seconds across all attempts (default: 30, max: 60)." },
      interval:        { type: "number", description: "Seconds to wait between attempts (default: 1, min: 0.1)." },
      connect_timeout: { type: "number", description: "Per-attempt TCP connect timeout in seconds (default: adaptive, shrinks to fit remaining budget)." },
    }},
  },
  {
    name: "port_scan_range",
    description: "Scan a contiguous range of TCP ports on a host concurrently, reusing port_check's raw-socket probe per port. Useful for discovering which ports a dev machine or remote host has listening (e.g. finding a free port, or checking what's up on a box) without issuing port_check calls one at a time. Range is capped at 1000 ports per call (narrow start_port/end_port for larger sweeps) to keep scans fast and bounded. Probes run with bounded concurrency (default 50, max 200 in-flight) rather than sequentially. Returns { host, startPort, endPort, totalPorts, openPorts: number[], closedCount, elapsedMs }. Never throws on individual port timeouts/connection errors (only on invalid parameters). Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", required: ["host", "start_port", "end_port"], properties: {
      host:        { type: "string", description: "Hostname or IP address to scan." },
      start_port:  { type: "number", description: "First port in the range, inclusive (1-65535)." },
      end_port:    { type: "number", description: "Last port in the range, inclusive (1-65535). Must be >= start_port. Range span capped at 1000 ports." },
      timeout:     { type: "number", description: "Per-port connect timeout in seconds (default: 1, max: 10)." },
      concurrency: { type: "number", description: "Max in-flight port probes at once (default: 50, max: 200)." },
    }},
  },
  {
    name: "dns_lookup",
    description: "Resolve a hostname's DNS records (A/AAAA/CNAME/MX/TXT/NS/SRV), or reverse-resolve an IP address to hostname(s) (PTR) — pure Node dns module, no exec. Type is auto-selected when omitted: PTR for IP-shaped host values, A otherwise; passing a mismatched type (e.g. PTR for a non-IP host, or A for an IP) throws a descriptive -32602 rather than a confusing resolver error. Returns { host, type, records, elapsedMs, error? } — records is an empty array with an 'error' code (e.g. 'ENOTFOUND', 'timeout') on resolution failure, never throws for a legitimate lookup that simply fails. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", required: ["host"], properties: {
      host:    { type: "string", description: "Hostname to resolve, or IP address for reverse (PTR) lookup." },
      type:    { type: "string", description: "Record type: 'A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SRV', or 'PTR'. Auto-selected from host shape when omitted." },
      timeout: { type: "number", description: "Lookup timeout in seconds (default: 5, max: 30)." },
    }},
  },
  {
    name: "query_path",
    description: "Query a JSON or YAML file using a JSONPath-style expression. Supports a useful safe subset: $ (root), .key (child), ['key'] (bracket notation), [N] (array index), [start:end] (array slice — either side optional, negative indices count from the end), [*] (wildcard — all direct children), and .. (recursive descent / deep scan). Multiple matches (from [*], a slice, or ..) are returned as a JSON array; a single match is returned as-is. Format is auto-detected from the file extension (.json → JSON, .yaml/.yml → YAML) or forced via the 'format' argument. Returns { path, query, format, matchCount, truncated, result }. Useful for extracting all values at a given path across nested structures without writing traversal code. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", required: ["path"], properties: {
      path:   { type: "string", description: "Path to the JSON or YAML file to query." },
      query:  { type: "string", description: "JSONPath expression (e.g. '$.store.book[*].author', '$..name', '$.items[0]'). An empty string or omission returns the entire document." },
      format: { type: "string", description: "Optional explicit format override: 'json' or 'yaml'. Omit to auto-detect from the file extension." },
    }},
  },
  {
    name: "json_patch_generate",
    description: "Diff two JSON or YAML files and emit an RFC 6902 JSON Patch (add/remove/replace operations with RFC 6901 pointers) describing how to turn 'left' into 'right' — a read-only counterpart to json_diff whose output is directly consumable by the json_patch tool's 'ops' argument (diff-then-apply workflow). Objects are compared key-by-key (missing-on-left => add, missing-on-right => remove, present-on-both-but-different => recursed into or replaced). Arrays are compared by INDEX POSITION, not content/set matching (documented behavior, same convention as json_diff, not an LCS/edit-distance diff): overlapping indices are recursed into, extra right-side elements are appended via 'add' in ascending order, extra left-side elements are removed via 'remove' starting from the HIGHEST index first so applying the ops sequentially never invalidates an unprocessed index. A type mismatch (e.g. object vs scalar) at a path is emitted as a single 'replace'. Format is auto-detected per-file from the extension or forced for both sides via 'format'. A max_ops budget (default 2000, hard cap 20000) caps the enumerated 'ops' array; opCount always reflects the true total even when truncated:true. Returns { left, right, format, identical, opCount, truncated, ops: [{op, path, value?}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", required: ["left", "right"], properties: {
      left:    { type: "string", description: "Path to the 'before' / baseline JSON or YAML file." },
      right:   { type: "string", description: "Path to the 'after' / target JSON or YAML file." },
      format:  { type: "string", description: "Force the format for BOTH files instead of auto-detecting per-file by extension: 'json' or 'yaml'." },
      max_ops: { type: "number", description: "Cap on the number of ops enumerated in the result (default 2000, hard cap 20000). opCount reflects the true total regardless." },
    }},
  },
  {
    name: "json_diff",
    description: "Structurally (semantically) diff two JSON or YAML documents — a data-aware counterpart to diff_files/file_diff_dir which compare TEXT. Parses both sides into real JS values and recursively compares them, reporting only genuine additions, removals, and value changes at their JSON-Pointer-style path (e.g. '/a/b/0/name'), ignoring key order/whitespace/formatting noise. Objects are compared key-by-key (missing-on-left => added, missing-on-right => removed, present-on-both-but-different => changed, recursed into when both sides are objects/arrays). Arrays are compared by INDEX POSITION, not by content/set matching (not an LCS/edit-distance diff) — documented behavior, not a bug. Type mismatches (e.g. object vs scalar) are reported as a single 'changed' entry rather than recursed into. Format is auto-detected per-file from the extension ('.json' -> JSON, '.yaml'/'.yml' -> YAML) or forced for both sides via 'format'. A max_changes budget (default 2000, hard cap 20000) caps the enumerated 'changes' array; totalChanges always reflects the true count even when truncated:true. Returns { left, right, format, identical, totalChanges, addedCount, removedCount, changedCount, truncated, changes: [{path, type, oldValue?, newValue?}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", required: ["left", "right"], properties: {
      left:        { type: "string", description: "Path to the 'before' / baseline JSON or YAML file." },
      right:       { type: "string", description: "Path to the 'after' / comparison JSON or YAML file." },
      format:      { type: "string", description: "Optional explicit format override applied to BOTH files: 'json' or 'yaml'. Omit to auto-detect per-file from its extension." },
      max_changes: { type: "number", description: "Cap on the number of enumerated change entries returned (default 2000, hard cap 20000). The true total is always reported via totalChanges regardless of this cap." },
    }},
  },
  {
    name: "find_unreachable_modules",
    description: "Deeper reachability analysis than find_dead_exports: builds the actual import/require graph from one or more entry-point files and BFS-traverses it, reporting every scanned file the traversal never reaches at all (not just files nobody happens to import a specific name from — a genuine 'no path back to how the program starts' check). Entry points default to package.json's \"main\" field plus common filesystem-convention filenames (index.js, src/index.js, server.js, app.js, main.js) found in `path`; pass entry_points explicitly for anything else (CLI bin scripts, test-runner-loaded files, framework filesystem-routing conventions). Pure text-scan (regex-extracted import/export/require/dynamic-import specifiers), not a real module resolver — no path aliases, no dynamically-constructed specifiers; treat unreachable[] as a review starting point, not an authoritative kill list. Returns { path, entryPoints, entryPointsSource, filesScanned, reachableCount, unreachableCount, truncated, unreachable: string[] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "Directory to scan (default: first root)." },
      entry_points: { type: "array", items: { type: "string" }, description: "Entry-point file paths, relative to `path` (default: auto-discovered from package.json \"main\" or common filenames)." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      max_results: { type: "number", description: "Cap on the unreachable[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_case_sensitive_import_mismatches",
    description: "Scans JS/TS files for relative import/require specifiers and flags any that resolve to a real on-disk file/directory ONLY when compared case-insensitively (e.g. `import './Utils'` resolving to an actual file named `utils.js`). These work fine on macOS/Windows (case-insensitive/preserving filesystems) but fail with a hard 'module not found' on Linux CI/production — one of the most common 'works on my machine' bug classes. Pure text-scan (regex-extracted import/export/require/dynamic-import specifiers), not a real module resolver — no path aliases, no dynamically-constructed specifiers; a specifier that doesn't resolve at all (missing file, bare package, alias) is silently skipped, not reported, since that's a different failure mode this tool isn't checking for. Also separately reports on-disk case COLLISIONS: two real scanned entries whose relative paths differ only in case, a landmine independent of any import statement. Returns { path, filesScanned, specifiersChecked, mismatchCount, truncated, mismatches: [{file,line,specifier,actualPath}], collisionCount, collisions: [{lower,paths}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "Directory to scan (default: first root)." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      max_results: { type: "number", description: "Cap on the mismatches[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "scan_cors_misconfig",
    description: "Scans JS/TS files for common CORS misconfiguration patterns: a hardcoded wildcard Access-Control-Allow-Origin header ('*'); the express `cors` package called with an explicit origin:'*'; that same wildcard combined with credentials:true in the same options object (invalid per the Fetch spec and a common credentialed cross-origin leak when a server doesn't itself enforce the spec); bare `cors()` with no options (defaults to allowing/reflecting all origins); and the Origin request header being reflected straight back into Access-Control-Allow-Origin with no allow-list check. Pure line-oriented text-scan (regex), not an AST parser — no cross-file/variable-alias tracking (options built in a separate variable then passed to cors() aren't followed). Accepts a file or a directory (recursively scanned). Returns { path, filesScanned, issueCount, errorCount, warningCount, infoCount, truncated, issues: [{file,line,rule,severity,message}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: first root)." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      max_results: { type: "number", description: "Cap on the issues[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_unbounded_object_growth",
    description: "Scans JS/TS files for module-level Map/Set/plain-object caches (const/let/var NAME = new Map()/new Set()/{} on an unindented, top-of-file line — used as a low-cost proxy for module scope) that are populated (NAME.set(/NAME.add( for Map/Set, dynamic NAME[key]=/NAME.key= assignment for plain objects) inside what looks like a request handler ((req, res / app.|router.<verb>() route registration) or a loop (for(/while(/.forEach(/.map() within a 30-line lookback window, with no corresponding NAME.delete(/NAME.clear()/delete NAME[...] anywhere in the same file and no generic TTL/eviction keyword hint (ttl/expire/evict/maxSize/LRU, case-insensitive) anywhere in the file either. One finding per flagged cache (not per population call) to avoid duplicate spam across a hot loop. Pure text-scan (regex + fixed lookback window), not an AST/scope parser — the module-level heuristic is indentation-based (column 0), so a cache declared inside an IIFE or wrapped in an extra brace level will not be detected; a real scope analysis would need a full parser. Accepts a file or a directory (recursively scanned). Returns { path, filesScanned, findingsCount, truncated, findings: [{file,line,name,kind,rule,severity,message}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: first root)." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_promise_all_without_catch",
    description: "Scans JS/TS files for Promise.all([...])/Promise.allSettled([...]) calls with no .catch( chained directly onto the call and not textually inside a try { } block. For Promise.all, one rejected member rejects the whole aggregate; allSettled itself never rejects but is included since callers commonly assume the same handling shape and copy-paste between the two. With no .catch and no enclosing try, a rejection here becomes an unhandled promise rejection with no code path to observe it. .catch( is only recognized when chained immediately onto the call's closing paren (whitespace/newlines allowed in between) — a .catch( on an unrelated later expression is not mistaken for this call's handler. Pure text-scan (regex + paren/brace-depth extraction), not an AST/scope parser — the call site itself must be inside try{} braces to count as handled; a call outside any try whose result is only awaited inside one later is still flagged (the tool's stated scope is the call site, not the eventual await site). Accepts a file or a directory (recursively scanned). Returns { path, filesScanned, findingsCount, errorCount, truncated, findings: [{file,line,method,rule,severity,message}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: first root)." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_missing_null_checks_after_regex_exec",
    description: "Scans JS/TS files for the regex-match-can-be-null footgun: RegExp.exec(str)/str.match(re) return null on no match, so indexing (`[0]`/`[1]`/`.groups`) or destructuring the result with no guard throws a TypeError. Two detection shapes: (1) chained_index_no_guard — the result is indexed directly on the call with no intermediate variable (`re.exec(s)[0]`), always flagged since no guard is structurally possible there; (2) missing_null_check_after_regex_exec — `const m = re.exec(s)`/`str.match(re)` followed within a 6-line lookahead by `m[0]`/`m.groups` or a destructure of `m`, flagged UNLESS a guard (`if (m)`/`if (!m)`/`m?.`/`m &&`/`m === null`/`m !== null`) appears anywhere between the assignment and the use. One finding per assigned variable (first unguarded use only). Pure text-scan (regex + fixed lookahead window), not an AST/scope parser — no cross-function data-flow tracking, and a use more than 6 lines past the assignment is not detected. Accepts a file or a directory (recursively scanned). Returns { path, filesScanned, findingsCount, truncated, findings: [{file,line,name?,rule,severity,message}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: first root)." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_regex_denial_of_service_in_route_params",
    description: "Pairs find_unsafe_regex's catastrophic-backtracking pattern shapes with request-input taint tracking (like find_open_redirect_risks' req.query/req.body sourcing). Three rules: (1) regex_pattern_from_request_input (error) — `new RegExp(ARG)` where the PATTERN argument itself is sourced from req.params/query/body (or a variable tainted from one) — a regex-injection footgun, always flagged regardless of the searched value, since the attacker controls the whole pattern. (2) unsafe_regex_against_request_input (error) — a regex literal or `new RegExp(\"literal\")` with a catastrophic-backtracking shape (nested quantifier / quantified overlapping alternation) applied via .test(/.exec(/.match(/.replace( to a request-input-tainted value. (3) dynamic_regex_against_request_input (warning) — a `new RegExp(VAR)` built from a non-literal, non-tainted expression (pattern safety unverifiable) applied to a request-input-tainted value. A same-line or 10-line-lookback length-cap hint referencing the tainted name (`.slice(0,`/`.substring(0,`/a `.length` comparison), including a cap applied directly on the req.* member before assignment, suppresses the finding. Pure text-scan (regex + small line window + single-pass taint tracking of simple `const/let/var NAME = req.X[.Y]` assignments and one-level destructures), not an AST/data-flow parser — no cross-function tracking. Accepts a file or a directory (recursively scanned). Returns { path, filesScanned, findingsCount, errorCount, warningCount, truncated, findings: [{file,line,rule,severity,message}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: first root)." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_open_redirect_risks",
    description: "Scans JS/TS files for likely open-redirect vulnerabilities: res.redirect()/response.redirect() called with a target built directly from req.query/req.body/req.params/req.headers with no visible allow-list/host check on the same line; res.writeHead(30x, { Location: ... }) where the Location header is built from the same request-input sources (multi-line window scan); and window.location/location.href assigned directly from request input (client-side variant). A same-line allow-list hint (startsWith(, includes(, allowlist/whitelist/ALLOWED) suppresses the finding to cut obvious false positives. Pure line-oriented text-scan (regex), not an AST parser — no data-flow tracking, so a variable sanitized several lines earlier reads the same as one used raw. Accepts a file or a directory (recursively scanned). Returns { path, filesScanned, issueCount, errorCount, warningCount, truncated, issues: [{file,line,rule,severity,message}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: first root)." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      max_results: { type: "number", description: "Cap on the issues[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_blocking_child_process_calls",
    description: "Scans JS/TS files for execSync/execFileSync/spawnSync (including fully-qualified child_process.execSync(...)) calls anywhere in the file — not gated on being inside an async function, unlike find_sync_fs_in_async_context, since a blocking child_process call freezes the single-threaded event loop for its full duration regardless of the containing function's async-ness. Each finding is upgraded to severity 'error' with rule blocking_call_in_request_handler when a request-handler signature hint (`(req, res` or an app./router. get/post/put/delete/patch/all/use(...) route registration) appears within a 40-line lookback window — otherwise severity 'warning' with rule blocking_child_process_call, since a one-off CLI/build/startup script using a sync call is often fine. Pure text-scan (regex + fixed line lookback), not an AST/scope parser — the lookback is a fixed window, not a real brace-scoped enclosing-function search. Accepts a file or a directory (recursively scanned). Returns { path, filesScanned, findingsCount, errorCount, warningCount, truncated, findings: [{file,line,call,severity,rule,message}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: first root)." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_missing_json_response_content_type",
    description: "Scans JS/TS files for res.send(JSON.stringify(...)) / res.end(JSON.stringify(...)) call shapes — a common footgun where the response body is JSON but the Content-Type header ends up wrong (text/html for res.send, since a string body isn't auto-detected as JSON the way passing the object directly would be; no header at all for the raw res.end). Suppressed when an explicit Content-Type: application/json hint (res.type('json'), res.set/header('Content-Type','application/json')) appears within a 15-line lookback window on the same file. res.end(...) findings are severity 'error' (rule missing_content_type_res_end, no header at all); res.send(...) findings are severity 'warning' (rule missing_content_type_res_send, wrong-but-present header). Pure text-scan (regex + fixed line lookback), not an AST/scope parser — a JSON string built in an earlier variable and passed to send/end by reference is not tracked across statements. Accepts a file or a directory (recursively scanned). Returns { path, filesScanned, findingsCount, errorCount, warningCount, truncated, findings: [{file,line,method,rule,severity,message}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: first root)." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_unhandled_express_error_middleware",
    description: "Two checks over a scanned Express-style project: (1) project-level — if any file registers routes (app./router. get/post/put/delete/patch/all(...)) but NO file in the scan defines Express's 4-argument error-handling middleware signature ((err, req, res, next) passed to .use()), a single finding is reported (rule no_error_handling_middleware, warning) — thrown/forwarded errors have nowhere centralized to go, and a rejected promise in an async handler is never auto-forwarded by Express. (2) per-catch-block — every catch(e){...} block that neither calls next(err) nor touches res.* nor re-throws is flagged (rule silent_catch_swallows_error, error) since the request just hangs until the client times out. Pure text-scan (regex + brace-depth body extraction, same convention as find_sync_fs_in_async_context), not an AST/scope parser — middleware detection is project-wide, not per-file/per-app-instance. Accepts a file or a directory (recursively scanned). Returns { path, filesScanned, hasRouteRegistrations, hasErrorMiddleware, findingsCount, errorCount, warningCount, truncated, findings: [{file,line,rule,severity,message}] } (the project-level finding has file/line: null). Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: first root)." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "scan_dangerous_code_patterns",
    description: "Scans JS/TS files for dynamic-code and injection footguns: eval(...); new Function(...); exec()/execSync() built from a template literal with ${..} or string concatenation (command injection risk — execFile/spawn with an argv array are NOT flagged); setTimeout/setInterval called with a string literal as the first arg (implicit eval); .innerHTML assigned from a non-literal value or dangerouslySetInnerHTML (XSS risk); and Math.random() used to build something named token/secret/password/apiKey/sessionId (cryptographically weak — use crypto.randomBytes/randomUUID instead). Pure line-oriented text-scan (regex), not an AST parser — no data-flow tracking, so a variable built from a literal several lines earlier reads the same as one built from user input. Accepts a file or a directory (recursively scanned). Returns { path, filesScanned, issueCount, errorCount, warningCount, truncated, issues: [{file,line,rule,severity,message}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: first root)." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      max_results: { type: "number", description: "Cap on the issues[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_missing_await",
    description: "Per-file heuristic: collects names declared async in the file (async function declarations, async arrow/function expressions assigned to a variable, object/class method shorthand), then flags every call to one of those names that isn't preceded by `await` and isn't `return name(...)` (returning a promise from an async function needs no await — it's auto-unwrapped for the caller). Pure text-scan, not a parser/type-checker — does not verify the call site is itself inside an async function (a flagged call in non-async code usually means the surrounding function should itself be async, not a false alarm to ignore); only same-file declarations are tracked, so calls to async functions imported from elsewhere are never flagged; `.then(`-chained calls are still flagged today. Treat findings as a review starting point. Accepts a file or a directory (recursively scanned). Returns { path, filesScanned, findingsCount, truncated, findings: [{file, line, functionName, text}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: first root)." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan (default: .js/.jsx/.ts/.tsx/.mjs/.cjs)." },
      max_results: { type: "number", description: "Cap on the findings[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_orphaned_test_files",
    description: "Convention-based scan for test files whose corresponding source file no longer exists. Recognises JS/TS *.test.*/*.spec.* (checked against .js/.jsx/.ts/.tsx/.mjs/.cjs), Python test_*.py/*_test.py, and Go *_test.go naming conventions. For each test file, derives candidate source path(s): same directory + same base name against each source extension, plus (if the test file sits under a conventional test-directory segment — test/tests/__tests__/spec/specs) the same candidates with that segment swapped for a conventional source-directory segment (src/lib), mirroring projects that place tests/foo.test.js next to src/foo.js. A test file is orphaned only if none of its candidates exist. Not a real import/test-runner analysis — a test that imports its subject under an unconventional name, or an intentionally source-less integration test, is a false positive; treat orphaned[] as a review starting point. Returns { path, filesScanned, testFilesScanned, orphanedCount, truncated, orphaned: [{file, expectedSourceCandidates}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "Directory to scan (default: first root)." },
      max_results: { type: "number", description: "Cap on the orphaned[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "check_test_coverage_gaps",
    description: "Inverse of find_orphaned_test_files: flags source files that have no corresponding test file at all, using the exact same naming-convention detection (JS/TS *.test.*/*.spec.*, Python test_*.py/*_test.py, Go *_test.go; same-directory + test-dir-to-src-dir segment swap). Convention-based text/path matching, not real import analysis — a source file legitimately tested only via an integration/e2e suite, or one with no dedicated unit test by design (barrel index.js, type-only file, CLI entry point), will be a false positive; use exclude_filenames to suppress known-intentional gaps. Returns { path, filesScanned, sourceFilesScanned, testFilesScanned, gapCount, truncated, gaps: string[] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "Directory to scan (default: first root)." },
      exclude_filenames: { type: "array", items: { type: "string" }, description: "Exact basenames to skip (e.g. ['index.js'])." },
      max_results: { type: "number", description: "Cap on the gaps[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_circular_deps",
    description: "Detect circular import/require dependency cycles across JS/TS source files in a directory tree. Pure static text-scan (no bundler, no real module resolution): extracts `require(...)`, `import ... from '...'`, `export ... from '...'`, and dynamic `import('...')` specifiers per file via regex, resolves *relative* specifiers ('./x', '../y') against the importing file's directory with extension-probing (.js/.jsx/.ts/.tsx/.mjs/.cjs/.json) and index-file fallback, builds a directed dependency graph keyed by root-relative path, then runs DFS with a recursion stack to find every unique cycle. Bare specifiers (npm packages, node builtins, path aliases like '@/x') are intentionally skipped — this only detects cycles among files inside the scanned tree, not cross-package cycles. Each cycle is reported as an ordered array of root-relative paths (first and last entries equal, showing the full loop). A max_cycles budget caps how many unique cycles are returned once truncated:true is set. Returns { path, filesScanned, edgesFound, cycles: string[][], cycleCount, truncated }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path:       { type: "string", description: "Directory to scan recursively (default: '.' — the whole root)." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan (default: ['.js','.jsx','.ts','.tsx','.mjs','.cjs'])." },
      max_cycles: { type: "number", description: "Cap on the number of unique cycles returned (1-1000, default 200)." },
    }},
  },
  {
    name: "find_dead_exports",
    description: "Find JS/TS named/default exports never imported anywhere else in a directory tree. Pure static text-scan (no bundler/type-checker), same file collection and relative-specifier resolution as find_circular_deps. Recognises ESM (`export const/function/class NAME`, `export default`, `export {a as b}`, `export {a} from './x'`) and CJS (`module.exports.NAME=`, `module.exports={a,b}`) export forms, and ESM (`import {a}`, `import Def`, `import * as ns`) and CJS (`const {a}=require()`, `const x=require()`) usage forms. Conservative by design: anything not cleanly resolvable to a specific named import (namespace import, whole-module require, `export * from`) marks the ENTIRE target file as used rather than risking a false positive — so this under-reports rather than over-reports dead code. Only intra-tree relative imports count as usage (same scope convention as find_circular_deps) — a file whose only importer is outside the scanned tree (e.g. an entry point referenced from package.json) will have its exports reported dead; this is expected, not a bug. Returns { path, filesScanned, exportsFound, deadCount, truncated, dead: [{file, name, line}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path:        { type: "string", description: "Directory to scan recursively (default: '.' — the whole root)." },
      extensions:  { type: "array", items: { type: "string" }, description: "File extensions to scan (default: ['.js','.jsx','.ts','.tsx','.mjs','.cjs'])." },
      max_results: { type: "number", description: "Cap on the number of dead exports returned (1-5000, default 500)." },
    }},
  },
  {
    name: "find_unused_dependencies",
    description: "Cross-reference a package.json's dependencies/devDependencies against actual require()/import usage across a source tree, flagging configured deps never referenced anywhere. Pure static text-scan (no bundler, no npm-registry calls), same file-collection convention as find_circular_deps/find_dead_exports. Extracts bare (non-relative, non-absolute) specifiers from `require(...)`, `import ... from '...'`, side-effect `import '...'`, dynamic `import('...')`, and `export ... from '...'`, then normalises each to its top-level package name (scoped: '@scope/pkg/sub' -> '@scope/pkg'; unscoped: 'lodash/fp' -> 'lodash') for comparison. Known false-positive class: devDependencies referenced only from config files (.eslintrc, jest.config.js) or invoked purely via npm scripts/CLI (never require()'d from source) will be reported unused even though they're legitimately needed — treat results as a review lead, not an automatic prune list. Returns { path, scanPath, filesScanned, dependenciesChecked, unusedCount, unused: [{name, block}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      pkg_path:   { type: "string", description: "Path to the package.json file to check (default: 'package.json' at the root)." },
      path:       { type: "string", description: "Directory to scan for usage (default: '.' — the whole root)." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan (default: ['.js','.jsx','.ts','.tsx','.mjs','.cjs'])." },
      blocks:     { type: "array", items: { type: "string" }, description: "Which package.json dependency blocks to check (default ['dependencies','devDependencies']; valid: dependencies, devDependencies, peerDependencies, optionalDependencies)." },
    }},
  },
  {
    name: "find_console_logs",
    description: "Scan JS/TS source for leftover debug statements — console.log/debug/info/warn/error/trace(...) calls and bare `debugger;` statements — the kind of dev-debt an agent should catch before a commit/PR. Distinct from scan_todos (comment markers like TODO/FIXME) and scan_secrets (hardcoded credentials). Same MCP_IGNORE-aware walk and binary-file-skip heuristic as scan_todos. Pragmatic per-line regex, not comment-aware: a `// console.log(...)` left inside a comment still matches (distinguishing 'already commented out' from 'still live' needs a real parser, same tradeoff as scan_todos/scan_secrets). Returns { path, filesScanned, totalMatches, truncated, byMethod, matches: [{file, line, method, text}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path:        { type: "string", description: "File or directory to scan (default: '.' — the whole root)." },
      methods:     { type: "array", items: { type: "string" }, description: "Which console methods to flag (default: ['log','debug','info','warn','error','trace'])." },
      extensions:  { type: "array", items: { type: "string" }, description: "File extensions to scan (default: ['.js','.jsx','.ts','.tsx','.mjs','.cjs'])." },
      max_matches: { type: "number", description: "Cap on the number of matches returned (1-5000, default 500)." },
    }},
  },
  {
    name: "find_duplicate_dependencies",
    description: "Recursively find every package.json under a directory tree (monorepo-style workspaces, nested packages) and flag dependency names declared with more than one distinct version-range string across the tree. Pure JSON/text scan — no npm-registry calls and no semver-range intersection (a literal string mismatch like '^1.2.0' vs '^1.2.3' is flagged even though both could resolve compatibly) — treat results as a review lead, not a guaranteed real conflict. Malformed/unreadable package.json files are skipped and listed separately rather than aborting the scan. Returns { path, packagesScanned, malformed: string[], dependenciesChecked, conflictCount, conflicts: [{name, versionCount, versions: [{version, packages: [{package, block}]}]}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path:   { type: "string", description: "Directory to scan recursively for package.json files (default: '.' — the whole root)." },
      blocks: { type: "array", items: { type: "string" }, description: "Which dependency blocks to check (default ['dependencies','devDependencies']; valid: dependencies, devDependencies, peerDependencies, optionalDependencies)." },
    }},
  },
  {
    name: "find_duplicate_json_keys",
    description: "Scan JSON files for objects with duplicate keys. Duplicate keys are valid per the JSON spec but JSON.parse silently keeps only the last value (a silent last-value-wins data-loss bug) — every other JSON tool in this server (json_schema_validate, json_diff, query_json/query_data, json_patch, ...) parses through JSON.parse first, so duplicates are already gone by the time any of them see the document. This tool walks the raw source text with a hand-rolled recursive-descent scanner instead, so every occurrence and its line number is preserved. Malformed JSON in a file is reported per-file as a parse error, not a scan-wide abort. Accepts a file or a directory (recursively scanned, default extension .json). Returns { path, filesScanned, filesWithErrors, duplicateKeyCount, truncated, issues: [{file, path, key, firstLine, duplicateLine}], errors: [{file, error}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: first root)." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan (default: ['.json'])." },
      max_results: { type: "number", description: "Cap on the issues[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_duplicate_yaml_keys",
    description: "Scan YAML files for block mappings with duplicate keys at the same indentation level. Duplicate keys are commonly allowed to slip through — most YAML loaders (js-yaml, PyYAML, etc.) silently keep only the last value, the same last-value-wins data-loss bug find_duplicate_json_keys catches for JSON. This is a line-oriented heuristic scanner (indentation + regex tracking a stack of open mapping levels), NOT a real YAML parser: it does not understand flow-style mappings ('{a: 1, a: 2}' on one line), block scalar (|, >) content lines that merely resemble 'key: value', anchors/aliases, or tags. For typical hand-written block-style YAML (configs, CI workflows, k8s manifests) this catches the common case cleanly — treat findings as a strong lead, not a guaranteed real parser error. Supports multi-document files (--- separators reset scanning per document). Accepts a file or a directory (recursively scanned, default extensions .yml/.yaml). Returns { path, filesScanned, filesWithErrors, duplicateKeyCount, truncated, issues: [{file, doc, path, key, firstLine, duplicateLine}], errors: [{file, error}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: first root)." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan (default: ['.yml','.yaml'])." },
      max_results: { type: "number", description: "Cap on the issues[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_unsafe_regex",
    description: "Scan JS/TS regex literals and new RegExp(...) string patterns for two classic catastrophic-backtracking (ReDoS) shapes: nested quantifiers (e.g. (a+)+, (\\d*)*) and quantified alternation with overlapping branches (e.g. (a|a)+, (foo|foobar)+). Pure text/regex heuristic, NOT a real regex engine or parser — no lookahead-based safety analysis, no cross-branch analysis beyond simple prefix overlap, and regex-literal extraction can rarely false-positive on division operators. Skips lines that look like comments. Accepts a file or a directory (recursively scanned, default extensions .js/.jsx/.ts/.tsx/.mjs/.cjs). Returns { path, filesScanned, filesWithErrors, issueCount, errorCount, warningCount, truncated, issues: [{file,line,pattern,rule,severity,message}], errors: [{file,error}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: first root)." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan (default: ['.js','.jsx','.ts','.tsx','.mjs','.cjs'])." },
      max_results: { type: "number", description: "Cap on the issues[] list length (1-5000, default 500)." },
    }},
  },
  {
    name: "find_unpinned_github_actions",
    description: "Scan .github/workflows/*.yml|*.yaml for 'uses: owner/action@ref' lines and flag refs not pinned to a full 40-hex-char commit SHA — a supply-chain risk since floating tags (@v4) can be moved by the action owner and floating branches (@main/@master) or @latest are mutable at any time (the vector behind real incidents like tj-actions/changed-files in 2024). Pure line-oriented text scan, NOT a YAML parser — does not resolve anchors/aliases. Local actions (./path) and Docker refs (docker://...) are out of scope and skipped. Accepts a file or a directory (recursively scanned, default path .github/workflows, default extensions .yml/.yaml). Returns { path, filesScanned, filesWithErrors, actionsFound, pinnedCount, issueCount, errorCount, warningCount, truncated, issues: [{file,line,action,ref,rule,severity,message}], errors: [{file,error}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "File or directory to scan (default: .github/workflows)." },
      extensions: { type: "array", items: { type: "string" }, description: "File extensions to scan (default: ['.yml','.yaml'])." },
      max_results: { type: "number", description: "Cap on the issues[] list length (1-5000, default 500)." },
    }},
  },
];
module.exports = { UTIL_SCHEMAS_2 };
