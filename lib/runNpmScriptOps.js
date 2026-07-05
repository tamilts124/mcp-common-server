"use strict";
// ── RUN_NPM_SCRIPT ── execute a package.json script and capture output ─────────
// Actual-execution complement to the many static-scan tools in this server:
// spawns `npm run <script>` in a project directory and captures stdout/
// stderr, exit code, and timing — the "run the tests/build and tell me what
// happened" workflow a static scanner can't answer. Requires MCP_ALLOW_EXEC
// (same policy gate as run_command/start_process).
//
// Validates the script exists in package.json's `scripts` map BEFORE
// spawning anything, so a typo'd script name gets a clear -32602 error
// instead of npm's own "missing script" exit-1 noise. Async spawn (not
// execSync/spawnSync) so a long-running script (a real test suite) never
// blocks the Node event loop for its full duration — same rationale as
// run_command in processOps.js. extra_args are always passed as discrete
// argv entries after `--`, never concatenated into a shell command string,
// so they can't be used for shell injection (see spawn() call below for the
// Windows .cmd nuance this requires).

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { ALLOW_EXEC, CMD_TIMEOUT } = require("./config");
const { ToolError } = require("./errors");

const MAX_BUFFER = 5 * 1024 * 1024; // 5MB per stream, same convention as run_command

function requireExec() {
  if (!ALLOW_EXEC)
    throw new ToolError("run_npm_script is disabled. Start server with MCP_ALLOW_EXEC=true to enable.", -32001);
}

function readScripts(pkgAbsPath, pkgOrigPath) {
  let raw;
  try { raw = fs.readFileSync(pkgAbsPath, "utf8"); }
  catch (e) { throw new ToolError(`run_npm_script: cannot read '${pkgOrigPath}': ${e.message}`, -32602); }
  let pkg;
  try { pkg = JSON.parse(raw); }
  catch (e) { throw new ToolError(`run_npm_script: '${pkgOrigPath}' is not valid JSON: ${e.message.split("\n")[0]}`, -32602); }
  if (!pkg || typeof pkg !== "object" || Array.isArray(pkg))
    throw new ToolError(`run_npm_script: '${pkgOrigPath}' must contain a JSON object at the top level.`, -32602);
  const scripts = pkg.scripts;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts))
    throw new ToolError(`run_npm_script: '${pkgOrigPath}' has no 'scripts' object.`, -32602);
  return scripts;
}

/**
 * @param {string} projectAbsDir   Absolute, jail-validated project directory.
 * @param {string} projectOrigPath Client-relative path echoed in the result.
 * @param {string} scriptName      npm script name to run (must exist in package.json).
 * @param {object} [opts]
 * @param {string[]} [opts.extraArgs]  Extra argv entries appended after `--`.
 * @param {number}   [opts.timeoutSec] Timeout in seconds (default/max: MCP_CMD_TIMEOUT).
 * @param {object}   [opts.env]        Extra env vars merged into process.env.
 * @returns {Promise<{path,script,command,exitCode,signal,success,timedOut,durationMs,stdout,stderr,stdoutTruncated,stderrTruncated,error}>}
 */
function runNpmScript(projectAbsDir, projectOrigPath, scriptName, opts = {}) {
  requireExec();

  if (!scriptName || typeof scriptName !== "string")
    throw new ToolError("run_npm_script requires a 'script' string field.", -32602);

  let stat;
  try { stat = fs.statSync(projectAbsDir); }
  catch (e) { throw new ToolError(`run_npm_script: cannot access '${projectOrigPath}': ${e.message}`, -32602); }
  if (!stat.isDirectory())
    throw new ToolError(`run_npm_script: '${projectOrigPath}' is not a directory.`, -32602);

  if (opts.extraArgs !== undefined && !Array.isArray(opts.extraArgs))
    throw new ToolError("run_npm_script: extra_args must be an array of strings.", -32602);
  if (opts.timeoutSec !== undefined && typeof opts.timeoutSec !== "number")
    throw new ToolError("run_npm_script: timeout must be a number.", -32602);
  if (opts.env !== undefined && (typeof opts.env !== "object" || opts.env === null || Array.isArray(opts.env)))
    throw new ToolError("run_npm_script: env must be an object of string values.", -32602);

  const pkgAbsPath = path.join(projectAbsDir, "package.json");
  const scripts = readScripts(pkgAbsPath, path.join(projectOrigPath, "package.json"));
  if (!Object.prototype.hasOwnProperty.call(scripts, scriptName))
    throw new ToolError(
      `run_npm_script: script '${scriptName}' not found in package.json. Available: ${Object.keys(scripts).join(", ") || "(none)"}.`,
      -32602,
    );

  const extraArgs = Array.isArray(opts.extraArgs) ? opts.extraArgs.map(String) : [];
  const timeoutMs = Math.min(Math.max(opts.timeoutSec ?? CMD_TIMEOUT, 1), CMD_TIMEOUT) * 1000;
  const env = opts.env ? { ...process.env, ...opts.env } : process.env;
  const spawnArgs = ["run", scriptName, ...(extraArgs.length ? ["--", ...extraArgs] : [])];
  const displayCommand = `npm ${spawnArgs.join(" ")}`;
  const start = Date.now();
  const isWin = process.platform === "win32";

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(isWin ? "npm.cmd" : "npm", spawnArgs, {
        // On Windows, .cmd files cannot be spawned directly with shell:false
        // (Node throws EINVAL) — they must go through cmd.exe. Node's own
        // Windows spawn implementation quotes each array argument for cmd.exe
        // when shell:true is combined with an args array (not a raw command
        // string), so extra_args are still passed as discrete argv entries,
        // not concatenated into a shell-interpretable string — POSIX-style
        // shell metacharacters (;, $(), `` ` ``) have no special meaning to
        // cmd.exe either way. POSIX doesn't need a shell to exec "npm" itself.
        cwd: projectAbsDir, env, shell: isWin, stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      resolve({
        path: projectOrigPath, script: scriptName, command: displayCommand,
        exitCode: null, signal: null, success: false, timedOut: false,
        durationMs: Date.now() - start, stdout: "", stderr: "",
        stdoutTruncated: false, stderrTruncated: false, error: e.message,
      });
      return;
    }

    let stdout = "", stderr = "";
    let stdoutTruncated = false, stderrTruncated = false, settled = false, timedOut = false;

    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      // On Windows the child is cmd.exe (npm.cmd needs a shell) which in turn
      // spawns node.exe as a grandchild via npm-cli — killing only the direct
      // child leaves the grandchild running and holding the stdout/stderr
      // pipes open, so 'close' never fires and this Promise would hang
      // forever. taskkill /T kills the whole process tree. POSIX npm scripts
      // run under a real process group via the shell npm itself spawns, so a
      // plain SIGTERM to the direct child is sufficient there.
      if (isWin) {
        require("child_process").exec(`taskkill /pid ${child.pid} /T /F`, () => {});
      } else {
        child.kill("SIGTERM");
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      if (stdout.length < MAX_BUFFER) stdout += chunk.toString("utf8");
      else stdoutTruncated = true;
    });

    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_BUFFER) stderr += chunk.toString("utf8");
      else stderrTruncated = true;
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        path: projectOrigPath, script: scriptName, command: displayCommand,
        exitCode: null, signal: null, success: false, timedOut: false,
        durationMs: Date.now() - start,
        stdout: stdout.slice(0, MAX_BUFFER), stderr: stderr.slice(0, MAX_BUFFER),
        stdoutTruncated, stderrTruncated,
        error: err.code === "ENOENT" ? "npm executable not found on PATH." : err.message,
      });
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        path: projectOrigPath, script: scriptName, command: displayCommand,
        exitCode: code, signal, success: code === 0 && !timedOut, timedOut,
        durationMs: Date.now() - start,
        stdout: stdout.slice(0, MAX_BUFFER), stderr: stderr.slice(0, MAX_BUFFER),
        stdoutTruncated, stderrTruncated,
        error: null,
      });
    });
  });
}

module.exports = { runNpmScript };
