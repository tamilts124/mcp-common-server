"use strict";
// ── READ / GIT / UTILITY TOOL DISPATCH HANDLERS ────────────────────────────────
// Extracted from lib/executeTool.js (which had grown past the 500-line
// threshold) so that file can stay a thin validator + switch/lookup table.
// Each handler is `(args) => result` and receives the same `args` object
// the JSON-RPC caller sent (already schema-validated by validateArgs).

const fs   = require("fs");
const path = require("path");

const { ROOTS, resolveClientPath } = require("./roots");
const { ToolError } = require("./errors");
const {
  readDirRecursive, readLines, searchRecursive,
  readMultipleFiles, globToRegex, findFilesRecursive, searchLines,
} = require("./fileOps");
const { fileChecksum, checksumVerify } = require("./checksumOps");
const { zipDirectory }  = require("./zipDirOps");
const { createTar }     = require("./tarOps");
const { queryJson, queryData } = require("./queryOps");
const { diffFiles }     = require("./diffFileOps");
const { envInfo }       = require("./envInfoOps");
const { systemResources } = require("./systemResourcesOps");
const { whichCommand } = require("./whichOps");
const { hashString } = require("./hashStringOps");
const { readArchive } = require("./archiveOps");
const { gitStatus, gitLog, gitBlame, gitDiff, gitShow } = require("./gitOps");
const { gitStashList } = require("./gitStashOps");
const { gitBranchList } = require("./gitBranchOps");
const { findStaleBranches } = require("./gitStaleBranchesOps");
const { gitWorktreeList } = require("./gitWorktreeOps");
const { gitTagList } = require("./gitTagOps");
const { gitReflog } = require("./gitReflogOps");
const { gitCherry } = require("./gitCherryOps");
const { gitOwnership } = require("./gitOwnershipOps");
const { gitUntrackedSize } = require("./gitUntrackedSizeOps");
const { findRepoRoot } = require("./gitOpsHelpers");
const { searchInDocument } = require("./searchDocumentOps");
const { envDiff } = require("./envDiffOps");
const { scanConflictMarkers } = require("./scanConflictMarkersOps");
const { scanSecrets } = require("./scanSecretsOps");
const { jsonSchemaValidate } = require("./jsonSchemaValidateOps");
const { checkLineEndings } = require("./lineEndingsOps");
const { findLargeFiles } = require("./largeFilesOps");
const { findEmptyDirs } = require("./emptyDirsOps");
const { jsonFlatten, jsonUnflattenFile } = require("./jsonFlattenOps");
const { packageJsonAudit } = require("./packageJsonAuditOps");
const { readmeLinkCheck } = require("./readmeLinkCheckOps");
const { findDuplicates } = require("./duplicateOps");
const { compareDirectories } = require("./compareOps");
const { fileDiffDir } = require("./dirDiffOps");
const { countLines } = require("./wc");
const { fileTree } = require("./treeOps");
const { hashDirectory } = require("./hashDirOps");
const { base64Encode } = require("./encodingOps");
const { fileStats } = require("./fileStatsOps");
const { scanTodos } = require("./scanTodosOps");
const { diskUsageSummary } = require("./diskUsageOps");
const { dirSizeStats } = require("./dirSizeOps");
const { csvQuery } = require("./csvOps");
const { httpFetch } = require("./httpFetchOps");
const { portCheck, waitForPort } = require("./portCheckOps");
const { queryPath } = require("./jsonPathOps");
const { jsonDiff } = require("./jsonDiffOps");


// Resolve the *real* git repo root for a git_* tool call, bounded by the
// jailed MCP root the path was validated against.
//
// Every git_* handler below used to hand gitExec() whatever directory
// resolveClientPath() resolved (or the first configured root when no path
// arg was given) and rely on git's own upward .git-discovery, bounded by
// gitOpsHelpers.gitExec's GIT_CEILING_DIRECTORIES=dirname(cwd). That only
// works when cwd is already the repo root: the ceiling is exactly one level
// above cwd, so a target nested two or more levels inside a repo (with no
// .git in its immediate parent) silently fails discovery ("not a git
// repository") even though it plainly is one. This is the same
// "cwd is a subdirectory, not the repo root" gap that git_ownership's audit
// (see lib/gitOwnershipOps.js) found and fixed with a jail-bounded
// findRepoRoot() walk-up — reused here for every other git_* tool so the
// fix isn't limited to just that one tool.
//
// findRepoRoot returning null (no .git found anywhere between the target
// and the jail boundary) falls back to the originally-resolved directory,
// so the underlying git command still runs and surfaces its own clear
// "not a git repository" error — behavior is unchanged for genuinely
// non-git paths, only genuinely-nested-but-real repos are fixed.
function resolveRepoDir(argPath) {
  if (argPath) {
    const { resolved, root } = resolveClientPath(argPath);
    return findRepoRoot(resolved, root) || resolved;
  }
  const [firstRoot] = ROOTS.values();
  return findRepoRoot(firstRoot, firstRoot) || firstRoot;
}

const READ_DISPATCH = {


  read_directory(args) {
    if (!args.path) {
      const all = [];
      for (const [alias, abs] of ROOTS)
        all.push({ root: alias, entries: readDirRecursive(abs, !!args.sub_dir, alias) });
      return { roots: [...ROOTS.keys()], total: all.reduce((n, r) => n + r.entries.length, 0), result: all };
    }
    const { alias, root, resolved } = resolveClientPath(args.path);
    const entries = readDirRecursive(resolved, !!args.sub_dir, alias);
    return { root, path: args.path, sub_dir: !!args.sub_dir, total: entries.length, entries };
  },

  read_file(args) {
    const { resolved } = resolveClientPath(args.path);
    return { path: args.path, ...readLines(resolved, args.from_line ?? 0, args.to_line ?? 0) };
  },

  read_files(args) {
    return { results: readMultipleFiles(args.files) };
  },

  read_allfiles(args) {
    const { alias, resolved } = resolveClientPath(args.path || ".");
    const entries = readDirRecursive(resolved, args.sub_dir !== false, alias).filter(e => e.type === "file");
    const exts    = args.extensions?.length ? args.extensions : null;
    const files   = {};
    for (const f of entries) {
      if (exts && !exts.some(x => f.path.endsWith(x))) continue;
      try { files[f.path] = fs.readFileSync(resolveClientPath(f.path).resolved, "utf8"); }
      catch (e) { files[f.path] = `[ERROR: ${e.message}]`; }
    }
    return { path: args.path || ".", fileCount: Object.keys(files).length, files };
  },

  file_info(args) {
    const { resolved } = resolveClientPath(args.path);
    const stat = fs.statSync(resolved);
    const info = {
      path: args.path, type: stat.isDirectory() ? "directory" : "file",
      size: stat.size, created: stat.birthtime, modified: stat.mtime,
      permissions: (stat.mode & 0o777).toString(8),
    };
    if (!stat.isDirectory()) info.lineCount = fs.readFileSync(resolved, "utf8").split("\n").length;
    return info;
  },

  search_files(args) {
    const { alias, resolved } = resolveClientPath(args.path || ".");
    let results = searchRecursive(resolved, args.pattern, !!args.is_regex, alias);
    if (args.extensions?.length)
      results = results.filter(r => args.extensions.some(x => r.file.endsWith(x)));
    return { pattern: args.pattern, matchedFiles: results.length, results };
  },

  find_files(args) {
    const { alias, resolved } = resolveClientPath(args.path || ".");
    const re      = globToRegex(args.pattern);
    const results = findFilesRecursive(resolved, re, alias);
    return {
      pattern:      args.pattern,
      searchRoot:   args.path || ".",
      matchedFiles: results.length,
      files:        results,
    };
  },

  search_lines(args) {
    const { alias, resolved } = resolveClientPath(args.path);
    const origPath = args.path || alias || ".";
    return searchLines(resolved, origPath, args.pattern, {
      isRegex:    args.is_regex,
      ignoreCase: args.ignore_case,
      context:    args.context,
      maxMatches: args.max_matches,
      extensions: args.extensions,
    });
  },

  search_in_document(args) {
    const { alias, resolved } = resolveClientPath(args.path);
    const origPath = args.path || alias || ".";
    return searchInDocument(resolved, origPath, args.pattern, {
      isRegex:    args.is_regex,
      ignoreCase: args.ignore_case,
      context:    args.context,
      maxMatches: args.max_matches,
    });
  },

  // ── Git ───────────────────────────────────────────────────────────────────

  git_status(args) {
    const repoDir = resolveRepoDir(args.path);
    return { path: args.path || ".", ...gitStatus(repoDir) };
  },

  git_untracked_size(args) {
    const repoDir = resolveRepoDir(args.path);
    return gitUntrackedSize(repoDir, args.path || ".", { topN: args.top_n });
  },

  git_log(args) {
    const repoDir = resolveRepoDir(args.path);
    return gitLog(repoDir, args.limit, args.file || null, args.branch || null, !!args.include_files);
  },

  git_blame(args) {
    const { resolved, root } = resolveClientPath(args.path);
    const repoDir = findRepoRoot(path.dirname(resolved), root) || path.dirname(resolved);
    return gitBlame(resolved, repoDir, args.from_line ?? null, args.to_line ?? null);
  },

  git_diff(args) {
    const repoDir = resolveRepoDir(args.path);
    return gitDiff(
      repoDir,
      args.from_ref  || null,
      args.to_ref    || null,
      args.file      || null,
      args.staged    || false,
      args.stat_only || false,
    );
  },

  git_stash_list(args) {
    const repoDir = resolveRepoDir(args.path);
    return gitStashList(repoDir);
  },

  git_branch_list(args) {
    const repoDir = resolveRepoDir(args.path);
    return gitBranchList(repoDir, args.include_remote || false);
  },

  find_stale_branches(args) {
    const repoDir = resolveRepoDir(args.path);
    return findStaleBranches(repoDir, args.days, args.include_remote || false);
  },

  git_worktree_list(args) {
    const repoDir = resolveRepoDir(args.path);
    return gitWorktreeList(repoDir);
  },

  git_show(args) {
    const repoDir = resolveRepoDir(args.path);
    return gitShow(repoDir, args.ref || null, args.file);
  },

  git_tag_list(args) {
    const repoDir = resolveRepoDir(args.path);
    return gitTagList(repoDir);
  },

  git_reflog(args) {
    const repoDir = resolveRepoDir(args.path);
    return gitReflog(repoDir, args.ref || null, args.limit);
  },

  git_cherry(args) {
    const repoDir = resolveRepoDir(args.path);
    return gitCherry(repoDir, args.upstream, args.head || null);
  },

  git_ownership(args) {
    const { resolved, root } = resolveClientPath(args.path);
    const stat = fs.statSync(resolved);
    const isDirectory = stat.isDirectory();
    return gitOwnership(resolved, args.path, isDirectory, root, {
      maxFiles:   args.max_files,
      extensions: args.extensions,
    });
  },

  // ── Utility ───────────────────────────────────────────────────────────────

  file_checksum(args) {
    const { resolved } = resolveClientPath(args.path);
    return { path: args.path, ...fileChecksum(resolved, args.algorithm) };
  },

  checksum_verify(args) {
    const { resolved } = resolveClientPath(args.path);
    return { path: args.path, ...checksumVerify(resolved, args.expected, args.algorithm) };
  },


  hash_string(args) {
    return hashString(args.data, args.algorithm, args.encoding);
  },

  zip_directory(args) {
    const { resolved: srcResolved } = resolveClientPath(args.path);
    const { resolved: dstResolved } = resolveClientPath(args.destination);
    const stat = fs.statSync(srcResolved);
    if (!stat.isDirectory())
      throw new Error(`zip_directory: '${args.path}' is not a directory.`);
    fs.mkdirSync(path.dirname(dstResolved), { recursive: true });
    const result = zipDirectory(srcResolved, dstResolved);
    return { source: args.path, ...result, zipPath: args.destination };
  },

  create_tar(args) {
    const { resolved: srcResolved } = resolveClientPath(args.path);
    const { resolved: dstResolved } = resolveClientPath(args.destination);
    const stat = fs.statSync(srcResolved);
    if (!stat.isDirectory())
      throw new Error(`create_tar: '${args.path}' is not a directory.`);
    fs.mkdirSync(path.dirname(dstResolved), { recursive: true });
    const result = createTar(srcResolved, dstResolved, { gzip: args.gzip });
    return { source: args.path, ...result, tarPath: args.destination };
  },

  query_json(args) {
    const { resolved } = resolveClientPath(args.path);
    return { path: args.path, ...queryJson(resolved, args.query || "") };
  },

  query_data(args) {
    const { resolved } = resolveClientPath(args.path);
    return { path: args.path, ...queryData(resolved, args.query || "", args.format || "") };
  },

  json_schema_validate(args) {
    const { resolved: dataResolved } = resolveClientPath(args.path);
    const { resolved: schemaResolved } = resolveClientPath(args.schema_path);
    return jsonSchemaValidate(dataResolved, args.path, schemaResolved, args.schema_path);
  },

  diff_files(args) {
    const { resolved: aResolved } = resolveClientPath(args.source);
    const { resolved: bResolved } = resolveClientPath(args.target);
    return {
      source: args.source,
      target: args.target,
      ...diffFiles(aResolved, bResolved, args.source, args.target, args.context),
    };
  },

  env_diff(args) {
    const { resolved: aResolved } = resolveClientPath(args.path);
    const { resolved: bResolved } = resolveClientPath(args.compare_path);
    return envDiff(aResolved, args.path, bResolved, args.compare_path);
  },

  env_info() {
    return envInfo();
  },

  system_resources() {
    return systemResources();
  },

  which_command(args) {
    return whichCommand(args);
  },

  read_archive(args) {
    const { resolved } = resolveClientPath(args.path);
    return { path: args.path, ...readArchive(resolved) };
  },

  find_duplicates(args) {
    const { alias, resolved } = resolveClientPath(args.path || ".");
    return {
      path: args.path || ".",
      ...findDuplicates(resolved, alias, {
        algorithm:  args.algorithm,
        extensions: args.extensions,
        minSize:    args.min_size,
      }),
    };
  },

  compare_directories(args) {
    const { resolved: leftResolved } = resolveClientPath(args.left);
    const { resolved: rightResolved } = resolveClientPath(args.right);
    return {
      left: args.left,
      right: args.right,
      ...compareDirectories(leftResolved, rightResolved, {
        algorithm:  args.algorithm,
        extensions: args.extensions,
      }),
    };
  },

  file_diff_dir(args) {
    const { resolved: leftResolved } = resolveClientPath(args.left);
    const { resolved: rightResolved } = resolveClientPath(args.right);
    return fileDiffDir(leftResolved, rightResolved, args.left, args.right, {
      algorithm:     args.algorithm,
      extensions:    args.extensions,
      max_diff_lines: args.max_diff_lines,
      context:       args.context,
    });
  },

  count_lines(args) {
    if (!Array.isArray(args.paths) || args.paths.length === 0)
      throw new ToolError("count_lines: 'paths' must be a non-empty array.", -32602);
    const absPaths = args.paths.map(p => resolveClientPath(p).resolved);
    return countLines(absPaths, args.paths);
  },

  file_tree(args) {
    const { alias, resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || alias || ".";
    return fileTree(resolved, origPath, {
      depth: args.depth,
      sizes: args.sizes,
    });
  },

  hash_directory(args) {
    const { alias, resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || alias || ".";
    return hashDirectory(resolved, origPath, {
      algorithm:  args.algorithm,
      extensions: args.extensions,
    });
  },

  base64_encode(args) {
    const { resolved } = resolveClientPath(args.path);
    return base64Encode(resolved, args.path, { url_safe: args.url_safe });
  },

  file_stats(args) {
    const { alias, resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || alias || ".";
    return fileStats(resolved, origPath, {
      topN:       args.top_n,
      extensions: args.extensions,
    });
  },

  scan_todos(args) {
    const { alias, resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || alias || ".";
    return scanTodos(resolved, origPath, {
      markers:       args.markers,
      extensions:    args.extensions,
      caseSensitive: args.case_sensitive,
      maxMatches:    args.max_matches,
    });
  },

  scan_conflict_markers(args) {
    const { alias, resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || alias || ".";
    return scanConflictMarkers(resolved, origPath, {
      extensions: args.extensions,
      maxMatches: args.max_matches,
    });
  },

  scan_secrets(args) {
    const { alias, resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || alias || ".";
    return scanSecrets(resolved, origPath, {
      extensions: args.extensions,
      maxMatches: args.max_matches,
    });
  },

  check_line_endings(args) {
    const { alias, resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || alias || ".";
    return checkLineEndings(resolved, origPath, {
      extensions:    args.extensions,
      maxMixedFiles: args.max_mixed_files,
    });
  },

  find_large_files(args) {
    const { alias, resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || alias || ".";
    return findLargeFiles(resolved, origPath, {
      minBytes:   args.min_bytes,
      topN:       args.top_n,
      extensions: args.extensions,
    });
  },

  find_empty_dirs(args) {
    const { alias, resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || alias || ".";
    return findEmptyDirs(resolved, origPath, {
      maxResults: args.max_results,
    });
  },

  json_flatten(args) {
    const { resolved } = resolveClientPath(args.path);
    return jsonFlatten(resolved, args.format);
  },

  json_unflatten(args) {
    const { resolved } = resolveClientPath(args.path);
    return jsonUnflattenFile(resolved);
  },

  package_json_audit(args) {
    const { alias, resolved } = resolveClientPath(args.path);
    const origPath = args.path || alias;
    return packageJsonAudit(resolved, path.dirname(resolved), origPath);
  },

  readme_link_check(args) {
    const { alias, resolved } = resolveClientPath(args.path);
    const origPath = args.path || alias;
    return readmeLinkCheck(resolved, origPath);
  },



  dir_size_stats(args) {
    const { alias, resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || alias || ".";
    return dirSizeStats(resolved, origPath, {
      maxDepth: args.max_depth,
      topN:     args.top_n,
    });
  },

  disk_usage_summary(args) {
    const { alias, resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || alias || ".";
    return diskUsageSummary(resolved, origPath, {
      topFiles: args.top_files,
      topDirs:  args.top_dirs,
      maxDepth: args.max_depth,
    });
  },

  csv_query(args) {
    const { resolved } = resolveClientPath(args.path);
    return csvQuery(resolved, args.path, {
      columns:    args.columns,
      offset:     args.offset,
      limit:      args.limit,
      filter_col: args.filter_col,
      filter_val: args.filter_val,
      has_header: args.has_header,
      group_by:   args.group_by,
      aggregate:  args.aggregate,
    });
  },

  http_fetch(args) {
    // http_fetch is async — callers in executeTool.js must await the result.
    return httpFetch({
      url:     args.url,
      method:  args.method,
      headers: args.headers,
      body:    args.body,
      timeout: args.timeout,
    });
  },

  port_check(args) {
    return portCheck({ host: args.host, port: args.port, timeout: args.timeout });
  },

  wait_for_port(args) {
    return waitForPort({
      host: args.host,
      port: args.port,
      timeout: args.timeout,
      interval: args.interval,
      connect_timeout: args.connect_timeout,
    });
  },

  query_path(args) {
    const { resolved } = resolveClientPath(args.path);
    return queryPath(resolved, args.path, args.query || "", args.format || "");
  },

  json_diff(args) {
    const { resolved: leftResolved } = resolveClientPath(args.left);
    const { resolved: rightResolved } = resolveClientPath(args.right);
    return jsonDiff(leftResolved, rightResolved, args.left, args.right, {
      format:      args.format,
      max_changes: args.max_changes,
    });
  },
};

module.exports = { READ_DISPATCH };
