"use strict";
// ── TOOL DISPATCH & PIPELINE EXECUTION ─────────────────────────────────────────
const fs   = require("fs");
const path = require("path");

const { READ_ONLY, ALLOW_EXEC } = require("./config");
const { ROOTS, resolveClientPath } = require("./roots");
const { WRITE_TOOLS, EXEC_TOOLS, TOOLS_ALL } = require("./toolsSchema");
const {
  readDirRecursive, readLines, writeLines, searchRecursive,
  readMultipleFiles, writeMultipleFiles, deleteMultipleFiles,
  globToRegex, findFilesRecursive, replaceInSingleFile,
} = require("./fileOps");
const {
  runCommand, startProcess, getProcessOutput, killProcess, listProcesses,
} = require("./processOps");

const TOOLS = TOOLS_ALL.filter(t => {
  if (READ_ONLY && (WRITE_TOOLS.has(t.name) || EXEC_TOOLS.has(t.name))) return false;
  if (!ALLOW_EXEC && EXEC_TOOLS.has(t.name)) return false;
  return true;
});

function executeTool(name, args) {
  if (READ_ONLY && (WRITE_TOOLS.has(name) || EXEC_TOOLS.has(name)))
    throw new Error(`Server is in read-only mode — '${name}' is disabled.`);
  if (!ALLOW_EXEC && EXEC_TOOLS.has(name))
    throw new Error(`'${name}' requires MCP_ALLOW_EXEC=true on the server.`);

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

    // ── Write ─────────────────────────────────────────────────────────────────

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
      throw new Error(`Unknown tool: ${name}`);
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

module.exports = { TOOLS, executeTool, executePipeline };
