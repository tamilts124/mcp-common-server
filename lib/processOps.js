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

// Async, non-blocking implementation (spawn + Promise) rather than execSync.
// execSync blocks the entire Node event loop for the command's whole
// duration — on the HTTP/SSE transport this starves any concurrent request
// handling (e.g. SSE keepalive) for that whole span, which can surface as a
// *client-side* transport failure for commands that take more than a few
// seconds even though the command itself would have succeeded within its
// timeout server-side. spawn+Promise preserves the old return shape/
// semantics but never blocks the loop, so long-but-legitimate commands
// (multi-second git operations, test suites, etc.) no longer race the
// transport. Handler may return a Promise — executeTool()'s dispatch
// already supports that (see lib/executeTool.js).
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

  const timeoutMs  = Math.min(args.timeout ?? CMD_TIMEOUT, CMD_TIMEOUT) * 1000;
  const env        = args.env ? { ...process.env, ...args.env } : process.env;
  const MAX_BUFFER = 10 * 1024 * 1024; // 10 MB per stream, matches old execSync cap
  const start      = Date.now();

  return new Promise((resolve) => {
    const child = childProcess.spawn(command, {
      cwd, env, shell: true, stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "", stderr = "";
    let stdoutTruncated = false, stderrTruncated = false, settled = false, timedOut = false;

    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      // On Windows, shell:true spawns cmd.exe as the direct child; SIGTERM
      // to that PID does not propagate to its own child (e.g. the real
      // `node`/`git` process being run), so the command silently outlives
      // its timeout. taskkill /T (tree) /F (force) kills the whole subtree.
      // On POSIX, child.kill() is sufficient since cmd.exe isn't in the mix.
      if (process.platform === "win32") {
        try { childProcess.execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"]); }
        catch (_) { /* process may have already exited */ }
      } else {
        try { child.kill("SIGTERM"); } catch (_) {}
      }
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      if (stdout.length < MAX_BUFFER) stdout += d.toString();
      else stdoutTruncated = true;
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < MAX_BUFFER) stderr += d.toString();
      else stderrTruncated = true;
    });

    function finish(exitCode, stderrOverride) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode:    exitCode ?? 1,
        stdout:      (stdoutTruncated ? stdout + "\n...[truncated]" : stdout).trimEnd(),
        stderr:      (stderrOverride ?? (stderrTruncated ? stderr + "\n...[truncated]" : stderr)).trimEnd(),
        duration_ms: Date.now() - start,
        command,
        cwd,
      });
    }

    child.on("error", (e) => finish(1, e.message));
    child.on("close", (code) => {
      if (timedOut) {
        finish(124, stderr || `Command timed out after ${timeoutMs / 1000}s.`);
      } else {
        finish(code ?? 0);
      }
    });
  });
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
    stdio: ["pipe", "pipe", "pipe"],
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

// Send a line (or raw bytes) to a background process's stdin.
// Useful for interactive CLIs, REPLs, and any tool that reads from stdin.
function sendProcessInput(args) {
  requireExec("Process management");

  const id    = args.id;
  const entry = BG_PROCESSES.get(id);
  if (!entry) throw new ToolError(`No process with id: ${id}`, -32602);

  if (entry.exitCode !== null)
    throw new ToolError(
      `Process ${id} has already exited (exit code ${entry.exitCode}) — cannot send input.`,
      -32602,
    );

  if (!entry.process.stdin || entry.process.stdin.destroyed)
    throw new ToolError(
      `Process ${id} has no writable stdin — it was started with stdin closed.`,
      -32603,
    );

  // Build the data buffer from either text or base64.
  let buf;
  if (args.data != null) {
    const encoding = args.encoding === "base64" ? "base64" : "utf8";
    buf = Buffer.from(args.data, encoding);
  } else {
    throw new ToolError("send_process_input: 'data' is required.", -32602);
  }

  // Optionally append a newline (the common "press Enter" pattern for CLIs).
  if (args.add_newline !== false) {
    const nl = Buffer.from("\n");
    buf = Buffer.concat([buf, nl]);
  }

  // Guard against giant writes.
  const MAX_INPUT = 1 * 1024 * 1024; // 1 MB
  if (buf.length > MAX_INPUT)
    throw new ToolError(
      `send_process_input: data too large (${buf.length} bytes; max ${MAX_INPUT}).`,
      -32602,
    );

  entry.process.stdin.write(buf);

  return {
    id,
    pid:       entry.pid,
    bytesWritten: buf.length,
    addedNewline: args.add_newline !== false,
    status:    entry.exitCode === null ? "running" : "exited",
  };
}

module.exports = {
  BG_PROCESSES, runCommand, startProcess, getProcessOutput, killProcess, listProcesses,
  sendProcessInput,
};
