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

  console.log(`\n${counters.pass} passed, ${counters.fail} failed\n`);
  cleanupDir(TMP);
  if (counters.fail > 0) process.exit(1);
}

main();
