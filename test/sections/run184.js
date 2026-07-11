"use strict";
// Wrapper: run the test and write output to a log file.
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const logPath = path.join(__dirname, "..", "tmp", "test184.log");

const r = spawnSync(
  process.execPath,
  [path.join(__dirname, "184-git-write-ops.js")],
  {
    cwd: path.join(__dirname, "..", ".."),
    encoding: "utf8",
    timeout: 90000,
    maxBuffer: 50 * 1024 * 1024,
    env: { ...process.env, MCP_ALLOW_EXEC: "true" },
  }
);

const out = [
  r.stdout || "",
  r.stderr || "",
  r.error ? `\n[WRAPPER ERROR]: ${r.error.message}` : "",
  `\n[EXIT CODE]: ${r.status}`,
].join("");

fs.writeFileSync(logPath, out, "utf8");
process.stdout.write(`Done. exitCode=${r.status}\n`);
