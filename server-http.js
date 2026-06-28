#!/usr/bin/env node

/**
 * MCP File Server — HTTP + SSE Transport  v3.1.0
 * For Claude Web (claude.ai) via ngrok or any public HTTPS URL
 * Zero npm dependencies — pure Node.js built-ins only
 *
 * ── Quick start ───────────────────────────────────────────────────────────────
 *
 *   # Single root, no auth, no exec
 *   MCP_ROOT_DIR=D:/myproject node server-http.js
 *
 *   # Multiple roots
 *   MCP_ROOTS=D:/proj1,D:/proj2 node server-http.js
 *
 *   # With auth token
 *   MCP_AUTH_TOKEN=mysecret MCP_ROOTS=D:/proj1,D:/proj2 node server-http.js
 *
 *   # With shell command execution enabled
 *   MCP_ALLOW_EXEC=true MCP_ROOT_DIR=D:/myproject node server-http.js
 *
 *   # Or just put everything in a .env file next to this script and run:
 *   node server-http.js
 *

 * ── All environment variables ─────────────────────────────────────────────────
 *
 *   PORT              HTTP port (default: 3000)
 *   MCP_ROOT_DIR      Single root directory (backwards compat)
 *   MCP_ROOTS         Comma-separated list of root directories
 *   MCP_AUTH_TOKEN    Bearer token for auth. Omit = open access (default)
 *   MCP_READ_ONLY     true = disable all write/delete/exec tools (default: false)
 *   MCP_ALLOW_EXEC    true = enable run_command, execute_pipeline, start_process,
 *                     get_process_output, kill_process exec steps
 *                     (default: false — exec tools hidden from tools/list)
 *   MCP_CMD_TIMEOUT   Max seconds a run_command may run (default: 60)
 *   MCP_IGNORE        Comma-separated dir/file names to skip in listings
 *                     (default: node_modules,.git,__pycache__,.nyc_output,dist,build)
 */

const http         = require("http");
const fs           = require("fs");
const path         = require("path");
const crypto       = require("crypto");
const childProcess = require("child_process");

// ── .ENV FILE SUPPORT (zero-dependency) ────────────────────────────────────────
// Loads a .env file (if present) from the same folder as this script.
// Real environment variables (shell, CLI, Docker, etc.) always win over .env.
function loadEnvFile(file) {
  try {
    const txt = fs.readFileSync(file, "utf8");
    for (const raw of txt.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
        val = val.slice(1, -1);
      if (!(key in process.env)) process.env[key] = val; // existing env vars always win
    }
  } catch (_) { /* no .env file present — fine, rely on real env vars */ }
}
loadEnvFile(path.join(__dirname, ".env"));


const PORT        = parseInt(process.env.PORT || "3000");
const AUTH_TOKEN  = process.env.MCP_AUTH_TOKEN  || null;
const READ_ONLY   = process.env.MCP_READ_ONLY   === "true";
const ALLOW_EXEC  = process.env.MCP_ALLOW_EXEC  === "true" && !READ_ONLY;
const CMD_TIMEOUT = parseInt(process.env.MCP_CMD_TIMEOUT || "60");
const IGNORE_PATTERNS = (
  process.env.MCP_IGNORE || "node_modules,.git,__pycache__,.nyc_output,dist,build"
).split(",").map(s => s.trim()).filter(Boolean);

// ── MULTI-ROOT SETUP ──────────────────────────────────────────────────────────
// Each root gets a short alias derived from its folder name.
// Paths Claude sends look like:  "alias/relative/file.py"
// With a single root, the alias prefix is optional (backwards compat).
const ROOTS = new Map(); // alias → absPath

function buildRoots() {
  const rawList = process.env.MCP_ROOTS
    ? process.env.MCP_ROOTS.split(",").map(s => s.trim()).filter(Boolean)
    : process.env.MCP_ROOT_DIR
      ? [process.env.MCP_ROOT_DIR.trim()]
      : ["."];

  const aliasCounts = {};
  for (const raw of rawList) {
    const abs = path.resolve(raw);
    if (!fs.existsSync(abs)) {
      console.warn(`[WARN] Root not found, skipping: ${abs}`);
      continue;
    }
    let alias = path.basename(abs).toLowerCase().replace(/[^a-z0-9_-]/g, "_");
    if (aliasCounts[alias]) {
      aliasCounts[alias]++;
      alias = `${alias}_${aliasCounts[alias]}`;
    } else {
      aliasCounts[alias] = 1;
    }
    ROOTS.set(alias, abs);
  }
  if (ROOTS.size === 0) throw new Error("No valid roots configured.");
}

buildRoots();

console.log(`MCP File Server (HTTP+SSE) v3.1.0`);
console.log(`Roots:`);
for (const [alias, abs] of ROOTS) console.log(`  [${alias}] ${abs}`);
console.log(`Auth      : ${AUTH_TOKEN ? "enabled (token set)" : "disabled (open)"}`);
console.log(`ReadOnly  : ${READ_ONLY}`);
console.log(`Exec      : ${ALLOW_EXEC ? `enabled (timeout: ${CMD_TIMEOUT}s)` : "disabled"}`);
console.log(`Ignore    : ${IGNORE_PATTERNS.join(", ")}`);
console.log(`Port      : ${PORT}`);
console.log("---");

// ── AUTH ──────────────────────────────────────────────────────────────────────
function checkAuth(req) {
  if (!AUTH_TOKEN) return true;
  const header = req.headers["authorization"] || "";
  return header === `Bearer ${AUTH_TOKEN}`;
}

// ── PATH SAFETY ───────────────────────────────────────────────────────────────
function resolveClientPath(clientPath) {
  const normalized = (clientPath || "").replace(/\\/g, "/").replace(/^\/+/, "");

  for (const [alias, abs] of ROOTS) {
    if (normalized === alias || normalized.startsWith(alias + "/")) {
      const rel      = normalized.slice(alias.length).replace(/^\/+/, "") || ".";
      const resolved = path.resolve(abs, rel);
      if (!resolved.startsWith(abs))
        throw new Error(`Access denied: outside root [${alias}]`);
      return { alias, root: abs, resolved };
    }
  }

  // No alias match — fall back to first root
  const [firstAlias, firstAbs] = ROOTS.entries().next().value;
  const resolved = path.resolve(firstAbs, normalized || ".");
  if (!resolved.startsWith(firstAbs))
    throw new Error(`Access denied: outside root [${firstAlias}]`);
  return { alias: firstAlias, root: firstAbs, resolved };
}

function clientRelative(alias, absPath) {
  const root = ROOTS.get(alias);
  const rel  = path.relative(root, absPath).replace(/\\/g, "/");
  return ROOTS.size > 1 ? `${alias}/${rel}` : rel;
}

// ── IGNORE CHECK ──────────────────────────────────────────────────────────────
function isIgnored(name) {
  return IGNORE_PATTERNS.some(p => name === p || name.startsWith(p));
}

// ── FILE HELPERS ──────────────────────────────────────────────────────────────
function readDirRecursive(dirPath, subDir, alias) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const result  = [];
  for (const e of entries) {
    if (isIgnored(e.name)) continue;
    const full = path.join(dirPath, e.name);
    const rel  = clientRelative(alias, full);
    if (e.isDirectory()) {
      result.push({ type: "dir", path: rel });
      if (subDir) result.push(...readDirRecursive(full, true, alias));
    } else {
      const stat = fs.statSync(full);
      result.push({ type: "file", path: rel, size: stat.size });
    }
  }
  return result;
}

function readLines(filePath, from, to) {
  const content = fs.readFileSync(filePath, "utf8");
  const lines   = content.split("\n");
  if (from === 0 && to === 0) return { content, totalLines: lines.length };
  const start = Math.max(0, from - 1);
  const end   = to === 0 ? lines.length : Math.min(to, lines.length);
  return {
    content:      lines.slice(start, end).join("\n"),
    totalLines:   lines.length,
    returnedLines: `${from}-${end}`,
  };
}

function writeLines(filePath, newContent, from, to) {
  if (from === 0 && to === 0) {
    if (fs.existsSync(filePath)) fs.copyFileSync(filePath, filePath + ".bak");
    fs.writeFileSync(filePath, newContent, "utf8");
    return { written: "entire file" };
  }
  let lines   = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8").split("\n") : [];
  const start = Math.max(0, from - 1);
  const end   = Math.min(to, lines.length);
  lines.splice(start, end - start, ...newContent.split("\n"));
  fs.writeFileSync(filePath, lines.join("\n"), "utf8");
  return { written: `lines ${from}-${to} replaced`, totalLines: lines.length };
}

function searchRecursive(dirPath, pattern, isRegex, alias, results = []) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const e of entries) {
    if (isIgnored(e.name)) continue;
    const full = path.join(dirPath, e.name);
    if (e.isDirectory()) { searchRecursive(full, pattern, isRegex, alias, results); continue; }
    try {
      const lines = fs.readFileSync(full, "utf8").split("\n");
      const re    = isRegex ? new RegExp(pattern, "gi") : null;
      const matches = [];
      lines.forEach((line, i) => {
        const hit = re ? re.test(line) : line.toLowerCase().includes(pattern.toLowerCase());
        if (hit) matches.push({ line: i + 1, content: line });
      });
      if (matches.length) results.push({ file: clientRelative(alias, full), matches });
    } catch (_) {}
  }
  return results;
}

// ── MULTI-FILE HELPERS ────────────────────────────────────────────────────────
function readMultipleFiles(items) {
  const results = {};
  for (const item of items) {
    const p = typeof item === "string" ? item : item.path;
    try {
      const { resolved } = resolveClientPath(p);
      results[p] = readLines(resolved, item.from_line ?? 0, item.to_line ?? 0);
    } catch (e) {
      results[p] = { error: e.message };
    }
  }
  return results;
}

function writeMultipleFiles(items) {
  const results = {};
  for (const item of items) {
    try {
      const { resolved } = resolveClientPath(item.path);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      results[item.path] = writeLines(resolved, item.content, item.from_line ?? 0, item.to_line ?? 0);
    } catch (e) {
      results[item.path] = { error: e.message };
    }
  }
  return results;
}

function deleteMultipleFiles(paths) {
  const results = {};
  for (const p of paths) {
    try {
      const { resolved } = resolveClientPath(p);
      fs.unlinkSync(resolved);
      results[p] = { deleted: true };
    } catch (e) {
      results[p] = { error: e.message };
    }
  }
  return results;
}

// ── GLOB HELPER ───────────────────────────────────────────────────────────────
// Converts a glob pattern to a RegExp.
// Supports: * (any chars except /), ** (any chars including /), ? (single char),
//           [abc] character classes, {a,b} alternation, and literal escaping.
function globToRegex(pattern) {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "**") {
      re += ".*";
      i += 2;
    } else if (c === "*") {
      re += "[^/]*";
      i++;
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else if (c === "[") {
      const close = pattern.indexOf("]", i);
      if (close === -1) { re += "\\["; i++; }
      else { re += pattern.slice(i, close + 1); i = close + 1; }
    } else if (c === "{") {
      const close = pattern.indexOf("}", i);
      if (close === -1) { re += "\\{"; i++; }
      else {
        const alts = pattern.slice(i + 1, close).split(",").map(a => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
        re += `(?:${alts})`;
        i = close + 1;
      }
    } else if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  return new RegExp(`^${re}$`, "i");
}

// ── FIND FILES (glob) ─────────────────────────────────────────────────────────
function findFilesRecursive(dirPath, rePattern, alias, results = []) {
  let entries;
  try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); }
  catch (_) { return results; }
  for (const e of entries) {
    if (isIgnored(e.name)) continue;
    const full    = path.join(dirPath, e.name);
    const relPath = clientRelative(alias, full);
    if (e.isDirectory()) {
      findFilesRecursive(full, rePattern, alias, results);
    } else {
      // Test against both the full relative path and just the filename
      if (rePattern.test(e.name) || rePattern.test(relPath)) {
        const stat = fs.statSync(full);
        results.push({ path: relPath, size: stat.size });
      }
    }
  }
  return results;
}

// ── REPLACE IN FILE ───────────────────────────────────────────────────────────
// Returns { file, replacements, originalSize, newSize } or { file, error }
function replaceInSingleFile(resolvedPath, clientPath, search, replace, isRegex, flags) {
  try {
    const original = fs.readFileSync(resolvedPath, "utf8");
    let modified;
    let count = 0;
    if (isRegex) {
      const re = new RegExp(search, flags || "g");
      modified = original.replace(re, (...args) => { count++; return replace; });
    } else {
      // Plain string — replace all occurrences
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(escaped, "g");
      modified = original.replace(re, () => { count++; return replace; });
    }
    if (count === 0) return { file: clientPath, replacements: 0, note: "no matches found, file unchanged" };
    fs.copyFileSync(resolvedPath, resolvedPath + ".bak");
    fs.writeFileSync(resolvedPath, modified, "utf8");
    return {
      file:         clientPath,
      replacements: count,
      originalSize: Buffer.byteLength(original, "utf8"),
      newSize:      Buffer.byteLength(modified, "utf8"),
    };
  } catch (e) {
    return { file: clientPath, error: e.message };
  }
}

// ── RUN COMMAND ───────────────────────────────────────────────────────────────
function runCommand(args) {
  if (!ALLOW_EXEC)
    throw new Error("Command execution is disabled. Start server with MCP_ALLOW_EXEC=true to enable.");

  const command = args.command;
  if (!command) throw new Error("run_command requires a 'command' field.");

  // Resolve cwd: alias path or absolute, must stay inside a root
  let cwd;
  if (args.cwd) {
    const { resolved } = resolveClientPath(args.cwd);
    cwd = resolved;
  } else {
    cwd = ROOTS.values().next().value; // first root
  }

  const timeoutMs = Math.min(args.timeout ?? CMD_TIMEOUT, CMD_TIMEOUT) * 1000;
  const env       = args.env ? { ...process.env, ...args.env } : process.env;

  const start = Date.now();
  try {
    const stdout = childProcess.execSync(command, {
      cwd,
      env,
      timeout:  timeoutMs,
      maxBuffer: 10 * 1024 * 1024, // 10 MB
    }).toString();
    return {
      exitCode:    0,
      stdout:      stdout.trimEnd(),
      stderr:      "",
      duration_ms: Date.now() - start,
      command,
      cwd,
    };
  } catch (e) {
    return {
      exitCode:    e.status ?? 1,
      stdout:      (e.stdout || "").toString().trimEnd(),
      stderr:      (e.stderr || e.message || "").toString().trimEnd(),
      duration_ms: Date.now() - start,
      command,
      cwd,
    };
  }
}

// ── BACKGROUND PROCESS STORE ──────────────────────────────────────────────────
// Keyed by process ID (UUID). Stores spawned child process + buffered output.
const BG_PROCESSES = new Map();
// { pid, process, stdout, stderr, startedAt, command, cwd, exitCode, exitedAt }

function startProcess(args) {
  if (!ALLOW_EXEC)
    throw new Error("Process execution is disabled. Start server with MCP_ALLOW_EXEC=true to enable.");

  const command = args.command;
  if (!command) throw new Error("start_process requires a 'command' field.");

  let cwd;
  if (args.cwd) {
    const { resolved } = resolveClientPath(args.cwd);
    cwd = resolved;
  } else {
    cwd = ROOTS.values().next().value;
  }

  const env = args.env ? { ...process.env, ...args.env } : process.env;
  const id  = crypto.randomUUID();

  const child = childProcess.spawn(command, {
    cwd,
    env,
    shell: true,
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const entry = {
    id,
    process:   child,
    stdout:    "",
    stderr:    "",
    startedAt: new Date().toISOString(),
    command,
    cwd,
    exitCode:  null,
    exitedAt:  null,
    pid:       child.pid,
  };

  const MAX_BUF = 2 * 1024 * 1024; // 2 MB per stream
  child.stdout.on("data", d => {
    entry.stdout += d.toString();
    if (entry.stdout.length > MAX_BUF) entry.stdout = entry.stdout.slice(-MAX_BUF);
  });
  child.stderr.on("data", d => {
    entry.stderr += d.toString();
    if (entry.stderr.length > MAX_BUF) entry.stderr = entry.stderr.slice(-MAX_BUF);
  });
  child.on("exit", (code) => {
    entry.exitCode = code ?? 0;
    entry.exitedAt = new Date().toISOString();
    console.log(`[PROC] Process ${id} (pid ${child.pid}) exited with code ${entry.exitCode}`);
  });

  BG_PROCESSES.set(id, entry);
  console.log(`[PROC] Started process ${id} (pid ${child.pid}): ${command}`);

  return {
    id,
    pid:       child.pid,
    command,
    cwd,
    startedAt: entry.startedAt,
    status:    "running",
  };
}

function getProcessOutput(args) {
  if (!ALLOW_EXEC)
    throw new Error("Process management is disabled. Start server with MCP_ALLOW_EXEC=true to enable.");

  const id    = args.id;
  const entry = BG_PROCESSES.get(id);
  if (!entry) throw new Error(`No process with id: ${id}`);

  // tail: return only the last N bytes if specified
  const tail = args.tail_bytes ?? 0;
  let stdout = entry.stdout;
  let stderr = entry.stderr;
  if (tail > 0) {
    stdout = stdout.length > tail ? stdout.slice(-tail) : stdout;
    stderr = stderr.length > tail ? stderr.slice(-tail) : stderr;
  }

  // clear: reset buffers after reading (like tail -f pattern)
  if (args.clear) {
    entry.stdout = "";
    entry.stderr = "";
  }

  const running = entry.exitCode === null;
  return {
    id,
    pid:       entry.pid,
    command:   entry.command,
    cwd:       entry.cwd,
    status:    running ? "running" : "exited",
    exitCode:  entry.exitCode,
    startedAt: entry.startedAt,
    exitedAt:  entry.exitedAt,
    stdout,
    stderr,
    bufferCleared: !!args.clear,
  };
}

function killProcess(args) {
  if (!ALLOW_EXEC)
    throw new Error("Process management is disabled. Start server with MCP_ALLOW_EXEC=true to enable.");

  const id    = args.id;
  const entry = BG_PROCESSES.get(id);
  if (!entry) throw new Error(`No process with id: ${id}`);

  if (entry.exitCode !== null) {
    BG_PROCESSES.delete(id);
    return { id, status: "already_exited", exitCode: entry.exitCode };
  }

  try {
    entry.process.kill(args.signal || "SIGTERM");
  } catch (e) {
    throw new Error(`Failed to kill process ${id}: ${e.message}`);
  }

  if (args.remove !== false) BG_PROCESSES.delete(id);

  return {
    id,
    pid:    entry.pid,
    status: "killed",
    signal: args.signal || "SIGTERM",
  };
}

function listProcesses() {
  if (!ALLOW_EXEC)
    throw new Error("Process management is disabled. Start server with MCP_ALLOW_EXEC=true to enable.");

  const list = [];
  for (const [id, e] of BG_PROCESSES) {
    list.push({
      id,
      pid:       e.pid,
      command:   e.command,
      cwd:       e.cwd,
      status:    e.exitCode === null ? "running" : "exited",
      exitCode:  e.exitCode,
      startedAt: e.startedAt,
      exitedAt:  e.exitedAt,
      stdoutBytes: e.stdout.length,
      stderrBytes: e.stderr.length,
    });
  }
  return { processes: list, count: list.length };
}

// ── EXECUTE PIPELINE ──────────────────────────────────────────────────────────
// Runs a sequence of operations (any tool) in order.
// Each step: { op, on_error?, ...tool-specific args }
//   op        — name of any existing tool (e.g. "move_file", "run_command")
//   on_error  — "stop" (default) | "continue"
//   ...args   — same args as if calling that tool directly
//
// Returns a summary with per-step status so Claude knows exactly what ran.
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

    // Strip pipeline-only keys before passing args to the tool
    const { op: _op, on_error: _oe, ...toolArgs } = step;

    try {
      const result = executeTool(op, toolArgs);
      results.push({ index: i, op, status: "ok", result });
      completed++;
    } catch (e) {
      results.push({ index: i, op, status: "error", error: e.message });
      if (onError === "stop") {
        stoppedAt = i;
        // Mark remaining steps as skipped
        for (let j = i + 1; j < steps.length; j++) {
          results.push({ index: j, op: steps[j].op || null, status: "skipped" });
        }
        break;
      }
      // on_error: "continue" — keep going, don't count as completed
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

// ── TOOL DEFINITIONS ──────────────────────────────────────────────────────────
const TOOLS_ALL = [

  // ════════════════════════════════════════════════════════════════════════════
  //  READ TOOLS — always available
  // ════════════════════════════════════════════════════════════════════════════

  {
    name: "read_directory",
    description: "List files and folders in a root or subdirectory. Omit path to list all roots.",
    inputSchema: { type: "object", properties: {
      path:    { type: "string",  description: "Root alias or subdirectory path. Omit to list all roots." },
      sub_dir: { type: "boolean", description: "Recurse into subdirectories (default: false)." },
    }},
  },
  {
    name: "read_file",
    description: "Read a file's content. Use from_line/to_line to limit to a line range (both 0 = entire file).",
    inputSchema: { type: "object", required: ["path"], properties: {
      path:      { type: "string" },
      from_line: { type: "number", description: "First line to return (1-based). 0 = start." },
      to_line:   { type: "number", description: "Last line to return (inclusive). 0 = end." },
    }},
  },
  {
    name: "read_files",
    description: "Read multiple files in one call. Each item is a path string or {path, from_line?, to_line?}.",
    inputSchema: { type: "object", required: ["files"], properties: {
      files: { type: "array", description: "Array of path strings or {path, from_line?, to_line?} objects.",
        items: { oneOf: [
          { type: "string" },
          { type: "object", required: ["path"], properties: {
            path:      { type: "string" },
            from_line: { type: "number" },
            to_line:   { type: "number" },
          }},
        ]},
      },
    }},
  },
  {
    name: "read_allfiles",
    description: "Read every file in a directory at once. Filter by extensions if needed.",
    inputSchema: { type: "object", properties: {
      path:       { type: "string",  description: "Directory to read (default: first root)." },
      sub_dir:    { type: "boolean", description: "Include subdirectories (default: true)." },
      extensions: { type: "array",   description: "Only include files with these extensions, e.g. [\".py\", \".js\"].",
        items: { type: "string" },
      },
    }},
  },
  {
    name: "file_info",
    description: "Get metadata for a file or directory: size, created, modified, permissions, line count.",
    inputSchema: { type: "object", required: ["path"], properties: {
      path: { type: "string" },
    }},
  },
  {
    name: "search_files",
    description: "Search for a text string or regex pattern across files. Returns matching lines with line numbers.",
    inputSchema: { type: "object", required: ["pattern"], properties: {
      path:       { type: "string",  description: "Directory to search (default: first root)." },
      pattern:    { type: "string",  description: "Text string or regex pattern to search for." },
      is_regex:   { type: "boolean", description: "Treat pattern as a regular expression (default: false)." },
      sub_dir:    { type: "boolean", description: "Search recursively (default: true)." },
      extensions: { type: "array",   description: "Limit search to these file extensions.",
        items: { type: "string" },
      },
    }},
  },
  {
    name: "find_files",
    description: "Find files by name or path glob pattern (e.g. '*.test.js', '**/*.config.*', 'src/{a,b}.ts'). Searches filenames and relative paths. Supports *, **, ?, [abc], {a,b} glob syntax.",
    inputSchema: { type: "object", required: ["pattern"], properties: {
      pattern:  { type: "string",  description: "Glob pattern to match against filenames or relative paths. Examples: '*.py', '**/*.test.js', 'src/**/*.{ts,tsx}', 'config*.json'." },
      path:     { type: "string",  description: "Directory to search (default: first root)." },
      sub_dir:  { type: "boolean", description: "Search recursively (default: true)." },
    }},
  },

  // ════════════════════════════════════════════════════════════════════════════
  //  WRITE TOOLS — hidden when MCP_READ_ONLY=true
  // ════════════════════════════════════════════════════════════════════════════

  {
    name: "write_file",
    description: "Write content to a file. from_line/to_line=0 replaces the whole file (creates a .bak backup first). Otherwise replaces only the specified line range.",
    inputSchema: { type: "object", required: ["path", "content"], properties: {
      path:      { type: "string" },
      content:   { type: "string", description: "New content to write." },
      from_line: { type: "number", description: "Start of line range to replace (1-based). 0 = whole file." },
      to_line:   { type: "number", description: "End of line range to replace (inclusive). 0 = whole file." },
    }},
  },
  {
    name: "write_files",
    description: "Write multiple files in one call. Each item: {path, content, from_line?, to_line?}. Line ranges work the same as write_file.",
    inputSchema: { type: "object", required: ["files"], properties: {
      files: { type: "array", items: { type: "object", required: ["path", "content"], properties: {
        path:      { type: "string" },
        content:   { type: "string" },
        from_line: { type: "number" },
        to_line:   { type: "number" },
      }}},
    }},
  },
  {
    name: "create_file",
    description: "Create a new file with optional content. Fails if the file already exists.",
    inputSchema: { type: "object", required: ["path"], properties: {
      path:    { type: "string" },
      content: { type: "string", description: "Initial file content (default: empty)." },
    }},
  },
  {
    name: "create_files",
    description: "Create multiple new files in one call. Each item: {path, content?}. Fails per-file if already exists.",
    inputSchema: { type: "object", required: ["files"], properties: {
      files: { type: "array", items: { type: "object", required: ["path"], properties: {
        path:    { type: "string" },
        content: { type: "string" },
      }}},
    }},
  },
  {
    name: "delete_file",
    description: "Permanently delete a file.",
    inputSchema: { type: "object", required: ["path"], properties: {
      path: { type: "string" },
    }},
  },
  {
    name: "delete_files",
    description: "Permanently delete multiple files in one call.",
    inputSchema: { type: "object", required: ["paths"], properties: {
      paths: { type: "array", items: { type: "string" } },
    }},
  },
  {
    name: "move_file",
    description: "Move or rename a file. Works across directories within the same root.",
    inputSchema: { type: "object", required: ["source", "destination"], properties: {
      source:      { type: "string", description: "Current path of the file." },
      destination: { type: "string", description: "New path of the file." },
    }},
  },
  {
    name: "copy_file",
    description: "Copy a file to a new location. Creates destination directories if needed.",
    inputSchema: { type: "object", required: ["source", "destination"], properties: {
      source:      { type: "string" },
      destination: { type: "string" },
    }},
  },
  {
    name: "create_directory",
    description: "Create a directory, including all parent directories.",
    inputSchema: { type: "object", required: ["path"], properties: {
      path: { type: "string" },
    }},
  },
  {
    name: "delete_directory",
    description: "Delete a directory. Set recursive: true to delete non-empty directories.",
    inputSchema: { type: "object", required: ["path"], properties: {
      path:      { type: "string" },
      recursive: { type: "boolean", description: "Delete contents recursively (default: false)." },
    }},
  },
  {
    name: "replace_in_file",
    description: "Find and replace text in one or more files. Supports plain string or regex substitution. Creates a .bak backup of each modified file. Use is_regex=true and flags='g' for global regex replace.",
    inputSchema: { type: "object", required: ["search", "replace"], properties: {
      search:   { type: "string",  description: "Text string or regex pattern to find." },
      replace:  { type: "string",  description: "Replacement text. For regex mode, can use $1, $2 etc. for capture groups." },
      path:     { type: "string",  description: "File path or directory to search. If a directory, operates on all matched files." },
      is_regex: { type: "boolean", description: "Treat search as a regular expression (default: false)." },
      flags:    { type: "string",  description: "Regex flags to use when is_regex=true (default: 'g'). E.g. 'gi' for case-insensitive global." },
      extensions: { type: "array", description: "When path is a directory, only process files with these extensions.",
        items: { type: "string" },
      },
    }},
  },

  // ════════════════════════════════════════════════════════════════════════════
  //  EXEC TOOLS — only present when MCP_ALLOW_EXEC=true and MCP_READ_ONLY=false
  // ════════════════════════════════════════════════════════════════════════════

  {
    name: "run_command",
    description: "Execute a shell command inside a root directory and return stdout, stderr, and exit code. Requires MCP_ALLOW_EXEC=true on the server.",
    inputSchema: { type: "object", required: ["command"], properties: {
      command: { type: "string",  description: "Shell command to run, e.g. 'python main.py' or 'npm test'." },
      cwd:     { type: "string",  description: "Working directory — root alias or path inside a root (default: first root)." },
      timeout: { type: "number",  description: `Seconds before the command is killed (default: ${CMD_TIMEOUT}, max: ${CMD_TIMEOUT}).` },
      env:     { type: "object",  description: "Extra environment variables to merge in, e.g. {\"DEBUG\": \"1\"}.",
        additionalProperties: { type: "string" },
      },
    }},
  },
  {
    name: "start_process",
    description: "Start a long-running background process (e.g. 'npm run dev', 'python server.py'). Returns a process id. Use get_process_output to read its stdout/stderr and kill_process to stop it. Requires MCP_ALLOW_EXEC=true.",
    inputSchema: { type: "object", required: ["command"], properties: {
      command: { type: "string",  description: "Shell command to run in the background." },
      cwd:     { type: "string",  description: "Working directory — root alias or path inside a root (default: first root)." },
      env:     { type: "object",  description: "Extra environment variables to merge in.",
        additionalProperties: { type: "string" },
      },
    }},
  },
  {
    name: "get_process_output",
    description: "Read buffered stdout and stderr from a background process started with start_process. Optionally clear the buffer after reading (for polling patterns).",
    inputSchema: { type: "object", required: ["id"], properties: {
      id:         { type: "string",  description: "Process id returned by start_process." },
      tail_bytes: { type: "number",  description: "Return only the last N bytes of each stream (0 = all, default: 0)." },
      clear:      { type: "boolean", description: "Clear the buffer after reading so next call only shows new output (default: false)." },
    }},
  },
  {
    name: "kill_process",
    description: "Stop a background process started with start_process.",
    inputSchema: { type: "object", required: ["id"], properties: {
      id:     { type: "string",  description: "Process id returned by start_process." },
      signal: { type: "string",  description: "Signal to send (default: 'SIGTERM'). Use 'SIGKILL' to force-kill." },
      remove: { type: "boolean", description: "Remove the process entry after killing (default: true)." },
    }},
  },
  {
    name: "list_processes",
    description: "List all background processes started with start_process, their status, and buffered output sizes.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "execute_pipeline",
    description: `Run an ordered sequence of operations (any tool) in a single call.
Each step is an object with an 'op' field (tool name) plus the same arguments that tool takes directly.
Steps run in order. If a step fails and on_error is 'stop' (default), remaining steps are skipped.
Set on_error: 'continue' on a step to keep going even if it fails.
Returns a summary with per-step status, result, and error details.
Use this to chain dependent operations: rename then test, write then run, delete old then create new, etc.`,
    inputSchema: { type: "object", required: ["steps"], properties: {
      steps: {
        type: "array",
        description: "Ordered list of operations to run.",
        items: {
          type: "object",
          required: ["op"],
          properties: {
            op: {
              type: "string",
              description: "Tool name to run for this step. Any tool available on this server is valid.",
              enum: [
                "read_directory", "read_file", "read_files", "read_allfiles",
                "file_info", "search_files", "find_files",
                "write_file", "write_files", "create_file", "create_files",
                "delete_file", "delete_files", "move_file", "copy_file",
                "create_directory", "delete_directory", "replace_in_file",
                "run_command", "start_process", "get_process_output",
                "kill_process", "list_processes",
              ],
            },
            on_error: {
              type: "string",
              enum: ["stop", "continue"],
              description: "What to do if this step fails. 'stop' (default) skips remaining steps. 'continue' keeps going.",
            },
          },
          additionalProperties: true,
        },
      },
    }},
  },
];

// Tool category sets
const WRITE_TOOLS = new Set([
  "write_file", "write_files", "create_file", "create_files",
  "delete_file", "delete_files", "move_file", "copy_file",
  "create_directory", "delete_directory", "replace_in_file",
]);
const EXEC_TOOLS = new Set([
  "run_command", "execute_pipeline",
  "start_process", "get_process_output", "kill_process", "list_processes",
]);

const TOOLS = TOOLS_ALL.filter(t => {
  if (READ_ONLY && (WRITE_TOOLS.has(t.name) || EXEC_TOOLS.has(t.name))) return false;
  if (!ALLOW_EXEC && EXEC_TOOLS.has(t.name)) return false;
  return true;
});

// ── TOOL EXECUTION ────────────────────────────────────────────────────────────
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
      const subDir  = args.sub_dir !== false;
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

      // Single file
      if (!stat.isDirectory()) {
        const result = replaceInSingleFile(resolved, args.path, search, replace, !!is_regex, flags);
        return { filesScanned: 1, filesModified: result.replacements > 0 ? 1 : 0, results: [result] };
      }

      // Directory — recurse and replace in all matching files
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

// ── SSE SESSION STORE ─────────────────────────────────────────────────────────
const sessions = new Map(); // sessionId → { res, lastSeen }

setInterval(() => {
  const cutoff = Date.now() - 5 * 60 * 1000;
  for (const [id, s] of sessions) {
    if (s.lastSeen < cutoff) {
      console.log(`[SSE] Pruning stale session: ${id}`);
      sessions.delete(id);
    }
  }
}, 60_000);

// ── HTTP SERVER ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost`);

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (!checkAuth(req)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized — invalid or missing Bearer token" }));
    return;
  }

  // ── GET /sse ───────────────────────────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/sse") {
    const sessionId = crypto.randomUUID();
    res.writeHead(200, {
      "Content-Type":      "text/event-stream",
      "Cache-Control":     "no-cache",
      "Connection":        "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(`event: endpoint\ndata: /message?sessionId=${sessionId}\n\n`);
    sessions.set(sessionId, { res, lastSeen: Date.now() });
    console.log(`[SSE] Client connected: ${sessionId}`);

    const keepalive = setInterval(() => {
      try { res.write(": ping\n\n"); } catch { clearInterval(keepalive); }
    }, 20_000);

    req.on("close", () => {
      clearInterval(keepalive);
      sessions.delete(sessionId);
      console.log(`[SSE] Client disconnected: ${sessionId}`);
    });
    return;
  }

  // ── POST /message ──────────────────────────────────────────────────────────
  if (req.method === "POST" && url.pathname === "/message") {
    const sessionId = url.searchParams.get("sessionId");
    const session   = sessions.get(sessionId);
    if (session) session.lastSeen = Date.now();

    let body = "";
    req.on("data", d => body += d);
    req.on("end", () => {
      let msg;
      try { msg = JSON.parse(body); } catch {
        res.writeHead(400); res.end("Bad JSON"); return;
      }

      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));

      const respond = (payload) => {
        if (!session) return;
        session.res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
      };

      const { id, method, params } = msg;

      if (method === "initialize") {
        return respond({ jsonrpc: "2.0", id, result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "mcp-file-server", version: "3.1.0" },
        }});
      }
      if (method === "notifications/initialized") return;
      if (method === "ping") return respond({ jsonrpc: "2.0", id, result: {} });

      if (method === "tools/list")
        return respond({ jsonrpc: "2.0", id, result: { tools: TOOLS } });

      if (method === "tools/call") {
        const { name, arguments: args } = params;
        try {
          const result = executeTool(name, args || {});
          console.log(`[TOOL] ${name}`, args?.path || args?.command || args?.id || (args?.files?.length ? `(${args.files.length} files)` : "") || (args?.steps?.length ? `(${args.steps.length} steps)` : "") || "");
          return respond({ jsonrpc: "2.0", id, result: {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          }});
        } catch (e) {
          console.error(`[TOOL ERROR] ${name}: ${e.message}`);
          return respond({ jsonrpc: "2.0", id, result: {
            content: [{ type: "text", text: `Error: ${e.message}` }],
            isError: true,
          }});
        }
      }

      if (id !== undefined)
        respond({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
    });
    return;
  }

  // ── GET / — Health check ───────────────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status:    "ok",
      server:    "mcp-file-server",
      version:   "3.1.0",
      readOnly:  READ_ONLY,
      auth:      !!AUTH_TOKEN,
      execEnabled: ALLOW_EXEC,
      roots:     Object.fromEntries(ROOTS),
      tools:     TOOLS.map(t => t.name),
    }));
    return;
  }

  res.writeHead(404); res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  console.log(`   SSE endpoint : http://localhost:${PORT}/sse`);
  console.log(`   Health check : http://localhost:${PORT}/`);
  console.log(`\nNow run: ngrok http ${PORT}`);
  console.log(`Then add https://xxxx.ngrok-free.app/sse to Claude Web integrations\n`);
});
