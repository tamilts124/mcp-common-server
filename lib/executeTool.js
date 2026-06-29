"use strict";
// ── TOOL DISPATCH & PIPELINE EXECUTION ─────────────────────────────────────────
const fs   = require("fs");
const path = require("path");

const { READ_ONLY, ALLOW_EXEC } = require("./config");
const { ROOTS, resolveClientPath } = require("./roots");
const { WRITE_TOOLS, EXEC_TOOLS, TOOLS_ALL } = require("./toolsSchema");
const { ToolError, getErrorCode } = require("./errors");
const {
  readDirRecursive, readLines, writeLines, searchRecursive,
  readMultipleFiles, writeMultipleFiles, deleteMultipleFiles,
  globToRegex, findFilesRecursive, replaceInSingleFile,
  truncateFile, appendFile,
} = require("./fileOps");
const {
  runCommand, startProcess, getProcessOutput, killProcess, listProcesses,
} = require("./processOps");
const { fileChecksum, zipDirectory, queryJson, queryData, diffFiles, envInfo } = require("./utilOps");
const { readArchive } = require("./archiveOps");
const { gitStatus, gitLog, gitBlame, gitDiff } = require("./gitOps");
const { gitStashList } = require("./gitStashOps");
const { findDuplicates } = require("./duplicateOps");
const { compareDirectories } = require("./compareOps");
const { countLines } = require("./wc");
const { fileTree } = require("./treeOps");
const { hashDirectory } = require("./hashDirOps");



const TOOLS = TOOLS_ALL.filter(t => {
  if (READ_ONLY && (WRITE_TOOLS.has(t.name) || EXEC_TOOLS.has(t.name))) return false;
  if (!ALLOW_EXEC && EXEC_TOOLS.has(t.name)) return false;
  return true;
});

const TOOLS_BY_NAME = new Map(TOOLS_ALL.map(t => [t.name, t]));


// Validates `args` against the tool's declared inputSchema.required before
// dispatch. Throws a ToolError (with .code) on any schema violation so
// callers (e.g. the HTTP/SSE layer) can return a proper JSON-RPC error code
// instead of a generic crash/500.
function validateArgs(name, args) {
  const schema = TOOLS_BY_NAME.get(name);
  if (!schema) throw new ToolError(`Unknown tool: ${name}`, -32601);

  const a = args || {};
  if (typeof a !== "object" || Array.isArray(a)) {
    throw new ToolError(`Invalid params for '${name}': arguments must be an object.`, -32602);
  }

  const required = schema.inputSchema?.required || [];
  for (const field of required) {
    const v = a[field];
    if (v === undefined || v === null || (typeof v === "string" && v === "")) {
      throw new ToolError(`Invalid params for '${name}': missing required field '${field}'.`, -32602);
    }
  }
}

function executeTool(name, args) {
  validateArgs(name, args);

  if (READ_ONLY && (WRITE_TOOLS.has(name) || EXEC_TOOLS.has(name)))
    throw new ToolError(`Server is in read-only mode — '${name}' is disabled.`, -32001);
  if (!ALLOW_EXEC && EXEC_TOOLS.has(name))
    throw new ToolError(`'${name}' requires MCP_ALLOW_EXEC=true on the server.`, -32001);

  switch (name) {

    // ── Read ──────────────────────────────────────────────────────────────────

    case "read_directory": {
      if (!args.path) {
        const all = [];
        for (const [alias, abs] of ROOTS)
          all.push({ root: alias, entries: readDirRecursive(abs, !!args.sub_dir, alias) });
        return { roots: [...ROOTS.keys()], total: all.reduce((n, r) => n + r.entries.length, 0), result: all };
      }
      const { alias, root, resolved } = resolveClientPath(args.path);
      const entries = readDirRecursive(resolved, !!args.sub_dir, alias);
      return { root, path: args.path, sub_dir: !!args.sub_dir, total: entries.length, entries };
    }

    case "read_file": {
      const { resolved } = resolveClientPath(args.path);
      return { path: args.path, ...readLines(resolved, args.from_line ?? 0, args.to_line ?? 0) };
    }

    case "read_files":
      return { results: readMultipleFiles(args.files) };

    case "read_allfiles": {
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
    }

    case "file_info": {
      const { resolved } = resolveClientPath(args.path);
      const stat = fs.statSync(resolved);
      const info = {
        path: args.path, type: stat.isDirectory() ? "directory" : "file",
        size: stat.size, created: stat.birthtime, modified: stat.mtime,
        permissions: (stat.mode & 0o777).toString(8),
      };
      if (!stat.isDirectory()) info.lineCount = fs.readFileSync(resolved, "utf8").split("\n").length;
      return info;
    }

    case "search_files": {
      const { alias, resolved } = resolveClientPath(args.path || ".");
      let results = searchRecursive(resolved, args.pattern, !!args.is_regex, alias);
      if (args.extensions?.length)
        results = results.filter(r => args.extensions.some(x => r.file.endsWith(x)));
      return { pattern: args.pattern, matchedFiles: results.length, results };
    }

    case "find_files": {
      const { alias, resolved } = resolveClientPath(args.path || ".");
      const re      = globToRegex(args.pattern);
      const results = findFilesRecursive(resolved, re, alias);
      return {
        pattern:      args.pattern,
        searchRoot:   args.path || ".",
        matchedFiles: results.length,
        files:        results,
      };
    }

    // ── Git ───────────────────────────────────────────────────────────────────

    case "git_status": {
      // Resolve any path inside the repo to obtain the cwd for git.
      // If no path given, use the first root.
      const repoDir = args.path
        ? resolveClientPath(args.path).resolved
        : [...ROOTS.values()][0];
      return { path: args.path || ".", ...gitStatus(repoDir) };
    }

    case "git_log": {
      const repoDir = args.path
        ? resolveClientPath(args.path).resolved
        : [...ROOTS.values()][0];
      // `file` arg (commit-filter path) is a relative path inside the repo;
      // it is validated for shell safety inside gitLog itself.
      return gitLog(repoDir, args.limit, args.file || null, args.branch || null);
    }

    case "git_blame": {
      const { resolved } = resolveClientPath(args.path);
      // For blame, git needs the file path relative to the repo root.
      // We pass the absolute resolved path; git resolves it correctly from cwd.
      const repoDir = path.dirname(resolved);
      return gitBlame(resolved, repoDir, args.from_line ?? null, args.to_line ?? null);
    }

    case "git_diff": {
      const repoDir = args.path
        ? resolveClientPath(args.path).resolved
        : [...ROOTS.values()][0];
      return gitDiff(
        repoDir,
        args.from_ref || null,
        args.to_ref   || null,
        args.file     || null,
        args.staged   || false,
      );
    }

    case "git_stash_list": {
      const repoDir = args.path
        ? resolveClientPath(args.path).resolved
        : [...ROOTS.values()][0];
      return gitStashList(repoDir);
    }

    // ── Utility ───────────────────────────────────────────────────────────────

    case "file_checksum": {
      const { resolved } = resolveClientPath(args.path);
      return { path: args.path, ...fileChecksum(resolved, args.algorithm) };
    }


    case "zip_directory": {
      const { resolved: srcResolved } = resolveClientPath(args.path);
      const { resolved: dstResolved } = resolveClientPath(args.destination);
      const stat = fs.statSync(srcResolved);
      if (!stat.isDirectory())
        throw new Error(`zip_directory: '${args.path}' is not a directory.`);
      fs.mkdirSync(path.dirname(dstResolved), { recursive: true });
      const result = zipDirectory(srcResolved, dstResolved);
      return { source: args.path, ...result, zipPath: args.destination };
    }

    case "query_json": {
      const { resolved } = resolveClientPath(args.path);
      return { path: args.path, ...queryJson(resolved, args.query || "") };
    }

    case "query_data": {
      const { resolved } = resolveClientPath(args.path);
      return { path: args.path, ...queryData(resolved, args.query || "", args.format || "") };
    }

    case "diff_files": {
      const { resolved: aResolved } = resolveClientPath(args.source);
      const { resolved: bResolved } = resolveClientPath(args.target);
      return {
        source: args.source,
        target: args.target,
        ...diffFiles(aResolved, bResolved, args.source, args.target, args.context),
      };
    }

    case "env_info":
      return envInfo();

    case "read_archive": {
      const { resolved } = resolveClientPath(args.path);
      return { path: args.path, ...readArchive(resolved) };
    }

    case "find_duplicates": {
      const { alias, resolved } = resolveClientPath(args.path || ".");
      return {
        path: args.path || ".",
        ...findDuplicates(resolved, alias, {
          algorithm:  args.algorithm,
          extensions: args.extensions,
          minSize:    args.min_size,
        }),
      };
    }

    case "compare_directories": {
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
    }

    case "count_lines": {
      if (!Array.isArray(args.paths) || args.paths.length === 0)
        throw new ToolError("count_lines: 'paths' must be a non-empty array.", -32602);
      const absPaths  = args.paths.map(p => resolveClientPath(p).resolved);
      return countLines(absPaths, args.paths);
    }

    case "file_tree": {
      const { alias, resolved } = resolveClientPath(args.path || ".");
      const origPath = args.path || alias || ".";
      return fileTree(resolved, origPath, {
        depth: args.depth,
        sizes: args.sizes,
      });
    }

    case "hash_directory": {
      const { alias, resolved } = resolveClientPath(args.path || ".");
      const origPath = args.path || alias || ".";
      return hashDirectory(resolved, origPath, {
        algorithm:  args.algorithm,
        extensions: args.extensions,
      });
    }

    // ── Write ─────────────────────────────────────────────────────────────────

    case "truncate_file": {
      const { resolved } = resolveClientPath(args.path);
      const lines = args.lines != null ? Math.trunc(args.lines) : null;
      const bytes = args.bytes != null ? Math.trunc(args.bytes) : null;
      return { path: args.path, ...truncateFile(resolved, lines, bytes) };

    }

    case "append_file": {

      const { resolved } = resolveClientPath(args.path);
      return { path: args.path, ...appendFile(resolved, args.content ?? "") };
    }

    case "write_file": {
      const { resolved } = resolveClientPath(args.path);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      return { path: args.path, ...writeLines(resolved, args.content, args.from_line ?? 0, args.to_line ?? 0) };

    }

    case "write_files":
      return { results: writeMultipleFiles(args.files) };

    case "create_file": {
      const { resolved } = resolveClientPath(args.path);
      if (fs.existsSync(resolved)) throw new Error(`File already exists: ${args.path}`);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, args.content || "", "utf8");
      return { created: args.path };
    }

    case "create_files": {
      const results = {};
      for (const item of args.files) {
        try {
          const { resolved } = resolveClientPath(item.path);
          if (fs.existsSync(resolved)) throw new Error(`File already exists: ${item.path}`);
          fs.mkdirSync(path.dirname(resolved), { recursive: true });
          fs.writeFileSync(resolved, item.content || "", "utf8");
          results[item.path] = { created: true };
        } catch (e) { results[item.path] = { error: e.message }; }
      }
      return { results };
    }

    case "delete_file": {
      const { resolved } = resolveClientPath(args.path);
      fs.unlinkSync(resolved);
      return { deleted: args.path };
    }

    case "delete_files":
      return { results: deleteMultipleFiles(args.paths) };

    case "move_file": {
      const { resolved: src } = resolveClientPath(args.source);
      const { resolved: dst } = resolveClientPath(args.destination);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.renameSync(src, dst);
      return { moved: args.source, to: args.destination };
    }

    case "copy_file": {
      const { resolved: src } = resolveClientPath(args.source);
      const { resolved: dst } = resolveClientPath(args.destination);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      return { copied: args.source, to: args.destination };
    }

    case "create_directory": {
      const { resolved } = resolveClientPath(args.path);
      fs.mkdirSync(resolved, { recursive: true });
      return { created: args.path };
    }

    case "delete_directory": {
      const { resolved } = resolveClientPath(args.path);
      fs.rmSync(resolved, { recursive: !!args.recursive, force: !!args.recursive });
      return { deleted: args.path };
    }

    case "replace_in_file": {
      const { search, replace, is_regex, flags } = args;
      if (!search) throw new Error("replace_in_file requires a 'search' field.");
      if (replace === undefined || replace === null) throw new Error("replace_in_file requires a 'replace' field.");

      const { alias, resolved } = resolveClientPath(args.path || ".");
      const stat = fs.statSync(resolved);

      if (!stat.isDirectory()) {
        const result = replaceInSingleFile(resolved, args.path, search, replace, !!is_regex, flags);
        return { filesScanned: 1, filesModified: result.replacements > 0 ? 1 : 0, results: [result] };
      }

      const entries = readDirRecursive(resolved, true, alias).filter(e => e.type === "file");
      const exts    = args.extensions?.length ? args.extensions : null;
      const results = [];
      for (const f of entries) {
        if (exts && !exts.some(x => f.path.endsWith(x))) continue;
        try {
          const { resolved: fRes } = resolveClientPath(f.path);
          results.push(replaceInSingleFile(fRes, f.path, search, replace, !!is_regex, flags));
        } catch (e) {
          results.push({ file: f.path, error: e.message });
        }
      }
      const modified = results.filter(r => r.replacements > 0).length;
      return {
        filesScanned:  results.length,
        filesModified: modified,
        totalReplacements: results.reduce((n, r) => n + (r.replacements || 0), 0),
        results,
      };
    }

    // ── Exec ──────────────────────────────────────────────────────────────────

    case "run_command":
      return runCommand(args);

    case "start_process":
      return startProcess(args);

    case "get_process_output":
      return getProcessOutput(args);

    case "kill_process":
      return killProcess(args);

    case "list_processes":
      return listProcesses();

    case "execute_pipeline":
      return executePipeline(args.steps);

    default:
      throw new ToolError(`Unknown tool: ${name}`, -32601);
  }
}

// Runs a sequence of operations (any tool) in order.
// Each step: { op, on_error?, ...tool-specific args }
function executePipeline(steps) {
  if (!Array.isArray(steps) || steps.length === 0)
    throw new Error("execute_pipeline requires a non-empty 'steps' array.");

  const results   = [];
  let stoppedAt   = null;
  let completed   = 0;

  for (let i = 0; i < steps.length; i++) {
    const step     = steps[i];
    const op       = step.op;
    const onError  = step.on_error ?? "stop";

    if (!op) {
      results.push({ index: i, op: null, status: "error", error: "Missing 'op' field in step." });
      if (onError === "stop") { stoppedAt = i; break; }
      continue;
    }

    const { op: _op, on_error: _oe, ...toolArgs } = step;

    try {
      const result = executeTool(op, toolArgs);
      results.push({ index: i, op, status: "ok", result });
      completed++;
    } catch (e) {
      results.push({ index: i, op, status: "error", error: e.message });
      if (onError === "stop") {
        stoppedAt = i;
        for (let j = i + 1; j < steps.length; j++) {
          results.push({ index: j, op: steps[j].op || null, status: "skipped" });
        }
        break;
      }
    }
  }

  return {
    total:      steps.length,
    completed,
    failed:     results.filter(r => r.status === "error").length,
    skipped:    results.filter(r => r.status === "skipped").length,
    stopped_at: stoppedAt,
    steps:      results,
  };
}

module.exports = { TOOLS, executeTool, executePipeline, ToolError, validateArgs, getErrorCode };
