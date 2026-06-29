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
 * Sections:
 *   01-core-ops.js            [1]-[5] Normal/Medium/High/Critical/Extreme
 *                             file & process op tests
 *   02-jsonrpc-validation.js  [6] JSON-RPC schema validation / ToolError codes
 *   03-utility-tools.js       [7] file_checksum, zip_directory, query_json
 *   04-git-tools.js           [8] git_status, git_log, git_blame
 *   05-yaml-query.js          [9] query_data (JSON/YAML), lib/yamlOps.js parser
 *   06-audit-fixes.js         [10] processOps/fileOps/roots audit fixes
 *   07-block-scalars.js       [11] YAML block scalars (|/>) in lib/yamlOps.js
 *   08-stdio-protocol.js      [12] stdio transport message framing/dispatch
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
 *
 * Run with: node test/run-tests.js
 */
const { fs, counters, TMP, cleanupDir } = require("./test-harness");

require("./sections/01-core-ops");
require("./sections/02-jsonrpc-validation");
require("./sections/03-utility-tools");

require("./sections/04-git-tools");
require("./sections/05-yaml-query");
require("./sections/06-audit-fixes");
require("./sections/07-block-scalars");
require("./sections/08-stdio-protocol");
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

console.log(`\n${counters.pass} passed, ${counters.fail} failed\n`);

// Cleanup the shared MCP_ROOTS sandbox temp dir (best-effort — Windows can
// transiently lock files right after a child process closes; cleanupDir
// retries briefly before giving up silently).
cleanupDir(TMP);

if (counters.fail > 0) process.exit(1);
