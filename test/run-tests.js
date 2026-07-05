"use strict";
/**
 * Isolated functional test suite for mcp-common-server lib/ modules.
 * Does NOT start the HTTP server or any MCP client — imports logic directly.
 *
 * This is a thin orchestrator: each rigor-level/feature block lives in its
 * own file under test/sections/, sharing one test-harness.js instance (one
 * temp MCP_ROOTS sandbox, one pass/fail counter) so the aggregate result
 * here is identical to running everything in a single file.
 *
 * IMPORTANT — async sections must be awaited in place, not collected and
 * Promise.all'd at the end:
 *   Sections 01, 08, 29, and 29b export a Promise (their test body runs
 *   inside an async IIFE). If we just `require()` them and keep going, their
 *   promise starts running concurrently with every later *synchronous*
 *   section's `require()` call. Synchronous sections do real CPU/IO work
 *   (5000-line files, 2000-row CSVs, hashing, etc.) that blocks the event
 *   loop for tens of seconds at a stretch. Sections 29/29b make REAL network
 *   round-trips (to a local loopback test server) with a 15s timeout —
 *   if the event loop is busy running synchronous section bodies when the
 *   response arrives, Node can't service the socket until the loop frees up,
 *   and the http_fetch call can blow its 15s timeout even though the local
 *   server answered instantly. This caused a real, reproducible (not flaky)
 *   failure: `node test/run-tests.js` failed deterministically on the first
 *   http_fetch test in both [32] and [32b] every run, with "request timed
 *   out after 15s" — the synchronous sections in between (02-28) took longer
 *   than 15s combined to run, starving the in-flight request.
 *   Fix: this whole file is wrapped in an async main() that `await`s each
 *   async section's exported promise immediately, before requiring the next
 *   section. That serializes execution end-to-end (same total runtime, since
 *   it was never truly parallel work anyway — synchronous code can't
 *   overlap with itself), and guarantees no async section's network/timer
 *   activity has to compete with a synchronous section's blocking work.
 *
 * Sections:
 *   01-core-ops.js            [1]-[5] Normal/Medium/High/Critical/Extreme
 *                             file & process op tests — async section
 *                             (execute_pipeline awaits async tool handlers)
 *   02-jsonrpc-validation.js  [6] JSON-RPC schema validation / ToolError codes
 *   03-utility-tools.js       [7] file_checksum, zip_directory, query_json
 *   04-git-tools.js           [8] git_status, git_log, git_blame
 *   05-yaml-query.js          [9] query_data (JSON/YAML), lib/yamlOps.js parser
 *   06-audit-fixes.js         [10] processOps/fileOps/roots audit fixes
 *   07-block-scalars.js       [11] YAML block scalars (|/>) in lib/yamlOps.js
 *   08-stdio-protocol.js      [12] stdio transport message framing/dispatch — async section
 *   09-diff-files.js          [13] diff_files tool (pure-JS Myers diff)
 *   10-truncate-append.js     [14] truncate_file and append_file tools
 *   11-env-info.js            [15] env_info tool (read-only server environment snapshot)
 *   12-git-diff.js            [16] git_diff tool (unified diff, staged/unstaged/commit-to-commit)
 *   12b-git-diff-stat-only.js [16-B] git_diff stat_only extension (per-file add/delete counts, no unified text)
 *   13-read-archive.js        [17] read_archive tool (ZIP manifest inspection)
 *   14-git-stash-list.js     [18] git_stash_list tool (list git stash entries)
 *   15-find-duplicates.js     [19] find_duplicates tool (content-hash duplicate detection)
 *   16-compare-directories.js [20] compare_directories tool (two-tree content-hash diff)
 *   17-new-tools.js           [21] count_lines, file_tree, hash_directory tools
 *   18-encoding-text-tools.js [22] base64_encode/decode, json_format, text_transform tools
 *   19-file-stats-csv.js      [23] file_stats (directory analytics) and csv_query tools
 *   20-search-lines.js        [24] search_lines tool (grep-like line search with context)
 *   21-json-patch.js          [25-A/B] json_patch tool Normal+Medium (RFC 6902)
 *   22-json-patch-hce.js      [25-C/D/E] json_patch tool High+Critical+Extreme
 *   23-read-line-range.js     [26] read_file/read_files structured line-range output
 *   24-apply-patch.js         [27] apply_patch tool (unified diff applier)
 *   25-move-copy-ops.js       [28-ABC] move_file/copy_file audit: Normal/Medium/High
 *   25b-move-copy-ops-cde.js  [28-DE] move_file/copy_file audit: Critical/Extreme
 *   26-git-branch-list.js     [29] git_branch_list tool (list local/remote branches)
 *   27-move-copy-dir-ops.js   [30-ABC] move_directory/copy_directory: Normal/Medium/High
 *   27b-move-copy-dir-ops-de.js [30-DE] move_directory/copy_directory: Critical/Extreme
 *   28-unzip-archive.js         [31-A/B/C] unzip_archive tool Normal+Medium+High
 *   28b-unzip-archive-ce.js     [31-D/E] unzip_archive tool Critical+Extreme
 *   29-http-fetch.js            [32] http_fetch tool (outbound HTTP/HTTPS requests) — async section
 *   29b-http-fetch-pipeline.js  [32b] execute_pipeline + http_fetch async-tool integration — async section
 *   30-yaml-patch.js            [33-A/B/C] yaml_patch tool Normal+Medium+High (set/delete/insert_at/append_to)
 *   30b-yaml-patch-de.js        [33-D/E] yaml_patch tool Critical+Extreme
 *   31-yaml-merge.js            [34-A/B/C/D/E] yaml_merge tool, all 5 rigor levels (deep-merge YAML overlay)
 *   32-file-diff-dir.js         [35-A/B/C/D/E] file_diff_dir tool, all 5 rigor levels (compare_directories + diff_files combined)
 *   33-query-path.js            [36] query_path tool (JSONPath-style query with wildcards/recursive descent)
 *   33b-query-path-slice.js     [36b] query_path array slice syntax [start:end]
 *   34-find-replace-dir.js      [37] replace_in_file bulk directory mode + dry_run (find_replace_dir)
 *   35-json-diff.js             [38] json_diff tool (structural/semantic JSON+YAML document diff)
 *   36-git-show.js               [39] git_show tool (read a file's content at a specific commit/ref)
 *   37-csv-aggregate.js          [40] csv_query aggregate mode (group_by + sum/avg/count/min/max)
 *   38-git-tag-list.js           [41] git_tag_list tool (list git tags with target commit/date/message)
 *   39-dir-size-stats.js         [42] dir_size_stats tool (directory-level disk-usage rollup, like `du --max-depth=N`)
 *   40-git-log-files.js          [43] git_log include_files extension (per-commit filesChanged via a separate numstat call)
 *   41-git-ownership.js          [44] git_ownership tool (blame-aggregate code ownership by author, file or directory)
 *   42-git-nested-repo-root.js   [45] audit: git_status/log/blame/diff/stash_list/branch_list/show/tag_list nested repo-root discovery
 *   46-hash-string.js             [46] hash_string tool (cryptographic digest of an arbitrary string payload, no file I/O)
 *   47-convert-data.js            [47] convert_data tool (JSON <-> YAML document conversion)
 *   48-git-reflog.js              [48] git_reflog tool (reflog entries for HEAD/a ref, incl. unreachable commits)
 *   49-git-cherry.js              [49] git_cherry tool (commits on head not yet in upstream, patch-equivalence aware)
 *   50-csv-convert.js              [50] csv_convert tool (CSV <-> JSON document conversion)
 *   51-zip-directory-hardening.js  [51] zip_directory hardening (WRITE_TOOLS + MCP_IGNORE bug fixes, extended coverage)
 *
 * Run with: node test/run-tests.js
 */
const { fs, counters, TMP, cleanupDir } = require("./test-harness");

async function main() {
  // Section 01 is async too (execute_pipeline awaits async tool handlers —
  // see lib/executeTool.js's executePipeline()). Await its exported promise
  // immediately so it can't overlap with the synchronous sections below.
  await require("./sections/01-core-ops");
  require("./sections/02-jsonrpc-validation");
  require("./sections/03-utility-tools");

  require("./sections/04-git-tools");
  require("./sections/05-yaml-query");
  require("./sections/06-audit-fixes");
  require("./sections/07-block-scalars");
  // Section 08 is async (handleMessage awaits executeTool(), which may itself
  // be a Promise for async tools). Await it in place, same reasoning as 01.
  await require("./sections/08-stdio-protocol");
  require("./sections/09-diff-files");
  require("./sections/10-truncate-append");
  require("./sections/11-env-info");
  require("./sections/12-git-diff");
  require("./sections/12b-git-diff-stat-only");
  require("./sections/13-read-archive");
  require("./sections/14-git-stash-list");
  require("./sections/15-find-duplicates");
  require("./sections/16-compare-directories");
  require("./sections/17-new-tools");
  require("./sections/18-encoding-text-tools");
  require("./sections/19-file-stats-csv");
  require("./sections/20-search-lines");
  require("./sections/21-json-patch");
  require("./sections/22-json-patch-hce");
  require("./sections/23-read-line-range");
  require("./sections/24-apply-patch");

  require("./sections/25-move-copy-ops");
  require("./sections/25b-move-copy-ops-cde");
  require("./sections/26-git-branch-list");
  require("./sections/27-move-copy-dir-ops");
  require("./sections/27b-move-copy-dir-ops-de");
  require("./sections/28-unzip-archive");
  require("./sections/28b-unzip-archive-ce");

  // Sections 29/29b make real network round-trips (to a local loopback test
  // server) with a 15s timeout each. Awaiting them in place — instead of
  // letting them run concurrently with whatever comes next — is what
  // actually fixes the starvation bug described above (there is nothing
  // after them now, but keeping the `await` documents the requirement and
  // protects against a future section being appended below without
  // noticing these are async).
  await require("./sections/29-http-fetch");
  await require("./sections/29b-http-fetch-pipeline");

  require("./sections/30-yaml-patch");
  require("./sections/30b-yaml-patch-de");

  require("./sections/31-yaml-merge");

  require("./sections/32-file-diff-dir");

  require("./sections/33-query-path");

  require("./sections/33b-query-path-slice");

  require("./sections/34-find-replace-dir");

  require("./sections/35-json-diff");

  require("./sections/36-git-show");

  require("./sections/37-csv-aggregate");

  require("./sections/38-git-tag-list");

  require("./sections/39-dir-size-stats");

  require("./sections/40-git-log-files");

  require("./sections/41-git-ownership");

  require("./sections/42-git-nested-repo-root");

  require("./sections/46-hash-string");
  require("./sections/47-convert-data");
  require("./sections/48-git-reflog");
  require("./sections/49-git-cherry");
  require("./sections/50-csv-convert");
  require("./sections/51-zip-directory-hardening");
  require("./sections/43-docx-convert");
  require("./sections/53-pdf-convert");
  require("./sections/56-docx-to-pdf");
  require("./sections/57-pdf-to-docx");
  require("./sections/54-scan-todos");
  // Section 55 makes real (fast-failing) TCP connections; await like 29/29b.
  await require("./sections/55-email-ops");
  await require("./sections/58-email-send");
  require("./sections/59-tar-archive");
  require("./sections/60-system-resources");
  require("./sections/61-which-command");
  require("./sections/62-git-worktree-list");
  // Section 63 is async (run_command now returns a Promise); await like 55/58.
  await require("./sections/63-run-command-async");
  await require("./sections/64-search-in-document");
  require("./sections/65-env-diff");
  require("./sections/66-scan-conflict-markers");
  require("./sections/67-scan-secrets");
  require("./sections/68-json-schema-validate");
  require("./sections/69-check-line-endings");
  require("./sections/70-find-large-files");
  require("./sections/71-find-empty-dirs");
  require("./sections/72-git-untracked-size");
  require("./sections/73-json-flatten");
  require("./sections/74-package-json-audit");
  require("./sections/75-readme-link-check");
  await require("./sections/76-pipeline-op-coverage");
  require("./sections/77-find-stale-branches");
  await require("./sections/78-port-scan-range");
  await require("./sections/79-dns-lookup");
  await require("./sections/80-commit-message-lint");
  require("./sections/81-find-circular-deps");
  require("./sections/82-git-diff-summary");
  require("./sections/83-git-blame-hotspots");
  require("./sections/84-git-file-age");
  require("./sections/85-find-dead-exports");
  require("./sections/86-find-unused-dependencies");
  require("./sections/87-find-console-logs");
  require("./sections/88-find-todo-owners");
  require("./sections/89-generate-pr-description");
  require("./sections/90-find-large-git-objects");
  require("./sections/91-check-lfs-coverage");
  require("./sections/92-merge-conflict-risk");
  require("./sections/93-check-binary-file");
  require("./sections/94-find-duplicate-dependencies");
  require("./sections/95-git-contributors-summary");
  require("./sections/96-regex-test");
  require("./sections/97-json-merge");
  await require("./sections/98-http-download");
  require("./sections/99-json-path-set");
  require("./sections/100-jwt-decode");
  require("./sections/101-url-parse");
  require("./sections/102-semver-compare");
  require("./sections/103-json-patch-generate");
  require("./sections/104-csv-diff");
  require("./sections/105-dir-diff-summary");
  require("./sections/106-json-schema-generate");
  require("./sections/107-find-binary-diffs");
  require("./sections/108-git-dangling-commits");
  require("./sections/109-git-object-count");
  require("./sections/110-find-recent-force-pushes");
  require("./sections/111-check-stash-apply-risk");
  require("./sections/112-git-blame-ownership-diff");
  require("./sections/113-git-tag-annotate-audit");
  require("./sections/114-check-commit-signatures");
  require("./sections/115-git-commit-frequency");
  require("./sections/116-git-orphaned-branches");
  require("./sections/117-check-branch-protection-hints");
  require("./sections/118-git-worktree-prune-candidates");
  require("./sections/119-git-submodule-status");
  require("./sections/120-find-hardcoded-ips");
  require("./sections/121-find-env-var-usage");
  require("./sections/122-git-hooks-audit");
  require("./sections/123-check-npm-audit-cache");
  require("./sections/124-find-unreachable-modules");
  require("./sections/125-find-stale-todos");
  require("./sections/126-find-orphaned-test-files");
  require("./sections/127-find-missing-await");
  require("./sections/128-find-async-callback-in-foreach");
  require("./sections/129-find-missing-img-alt-text");
  require("./sections/130-find-missing-form-label");
require("./sections/131-find-missing-button-accessible-name");
require("./sections/132-find-duplicate-html-id");


  console.log(`\n${counters.pass} passed, ${counters.fail} failed\n`);
  cleanupDir(TMP);
  if (counters.fail > 0) process.exit(1);
}

main();
