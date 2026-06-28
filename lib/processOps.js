"use strict";
// ── SHELL EXECUTION: run_command / start_process / get_process_output / kill_process / list_processes ──
const childProcess = require("child_process");
const crypto       = require("crypto");
const { ALLOW_EXEC, CMD_TIMEOUT } = require("./config");
const { resolveClientPath, ROOTS } = require("./roots");
const { ToolError } = require("./errors");

// Throws a -32001 ToolError when exec is disabled (server policy refusal).
// -32001 is in the JSON-RPC app-reserved range; it is used throughout this
// server for explicit policy denials (read-only mode, exec disabled), distinct
// from invalid-params (-32602) or internal error (-32603).
function requireExec(what) {
  if (!ALLOW_EXEC)
    throw new ToolError(
      `${what} is disabled. Start server with MCP_ALLOW_EXEC=true to enable.`,
      -32001,
    );
}

function runCommand(args) {
  requireExec("Command execution");

  const command = args.command;
  if (!command) throw new ToolError("run_command requires a 'command' field.", -32602);

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

// Keyed by process ID (UUID). Stores spawned child process + buffered output.
const BG_PROCESSES = new Map();

function startProcess(args) {
  requireExec("Process execution");

  const command = args.command;
  if (!command) throw new ToolError("start_process requires a 'command' field.", -32602);

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
    console.error(`[PROC] Process ${id} (pid ${child.pid}) exited with code ${entry.exitCode}`);
  });

  BG_PROCESSES.set(id, entry);
  console.error(`[PROC] Started process ${id} (pid ${child.pid}): ${command}`);

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
  requireExec("Process management");

  const id    = args.id;
  const entry = BG_PROCESSES.get(id);
  // Unknown id is an invalid-params error (-32602): the caller passed a process
  // id that doesn't exist in this session's process table.
  if (!entry) throw new ToolError(`No process with id: ${id}`, -32602);

  const tail = args.tail_bytes ?? 0;
  let stdout = entry.stdout;
  let stderr = entry.stderr;
  if (tail > 0) {
    stdout = stdout.length > tail ? stdout.slice(-tail) : stdout;
    stderr = stderr.length > tail ? stderr.slice(-tail) : stderr;
  }

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
  requireExec("Process management");

  const id    = args.id;
  const entry = BG_PROCESSES.get(id);
  // Unknown id is an invalid-params error (-32602).
  if (!entry) throw new ToolError(`No process with id: ${id}`, -32602);

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
  requireExec("Process management");

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

module.exports = {
  BG_PROCESSES, runCommand, startProcess, getProcessOutput, killProcess, listProcesses,
};
