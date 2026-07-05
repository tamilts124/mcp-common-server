"use strict";
// ── FIND_MISSING_SHEBANG_IN_BIN_SCRIPTS — package.json `bin` entry audit ──
// A `bin` script installed globally (npm link / npm i -g) is executed
// directly by the OS shell, not via `node script.js`. Without a
// `#!/usr/bin/env node` (or equivalent) shebang line as the very first
// bytes of the file, the OS either fails to exec it or misinterprets it —
// and on POSIX the file also needs its executable bit set. Both failures
// are silent until someone actually installs the package globally, so this
// is a pure static/filesystem check: parse package.json's `bin` field,
// resolve each referenced file relative to the package.json's directory,
// and inspect the target file's first line + POSIX mode bits.
//
// Findings:
//   missing_bin_field       (info)  — no `bin` field at all (nothing to check).
//   invalid_bin_field       (error) — `bin` present but not a string or object.
//   invalid_bin_entry       (error) — an object-form `bin` value is not a non-empty string.
//   bin_file_not_found      (error) — the referenced file does not exist on disk.
//   missing_shebang         (error) — target file's first line does not start with `#!`.
//   malformed_node_shebang  (warning) — shebang present but does not reference `node`
//                                       (e.g. `#!/bin/sh`) — may be intentional, flagged
//                                       for review since the common bug is a copy-paste
//                                       shebang from an unrelated script.
//   missing_executable_bit  (warning) — POSIX only: file has a valid node shebang but no
//                                        executable bit set in its mode.
const fs = require("fs");
const path = require("path");
const { ToolError } = require("./errors");

const NODE_SHEBANG_RE = /^#!.*\bnode\b/;

function readFirstLine(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(256);
    const bytesRead = fs.readSync(fd, buf, 0, 256, 0);
    const chunk = buf.toString("utf8", 0, bytesRead);
    const newlineIdx = chunk.indexOf("\n");
    return newlineIdx === -1 ? chunk : chunk.slice(0, newlineIdx);
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) { /* ignore */ } }
  }
}

/**
 * @param {string} filePath  Absolute path to package.json.
 * @param {string} origPath  Client-relative path echoed in the result.
 * @returns {{path, hasBin, binCount, findingsCount, errorCount, warningCount, infoCount, findings: Array}}
 */
function findMissingShebangInBinScripts(filePath, origPath) {
  let raw;
  try { raw = fs.readFileSync(filePath, "utf8"); }
  catch (e) { throw new ToolError(`find_missing_shebang_in_bin_scripts: cannot read '${origPath}': ${e.message}`, -32602); }

  let pkg;
  try { pkg = JSON.parse(raw); }
  catch (e) { throw new ToolError(`find_missing_shebang_in_bin_scripts: '${origPath}' is not valid JSON: ${e.message}`, -32602); }

  if (pkg === null || typeof pkg !== "object" || Array.isArray(pkg))
    throw new ToolError(`find_missing_shebang_in_bin_scripts: '${origPath}' must contain a JSON object at the top level.`, -32602);

  const findings = [];
  const bin = pkg.bin;
  let hasBin = false;
  const entries = [];

  if (bin === undefined) {
    findings.push({ rule: "missing_bin_field", severity: "info",
      message: "No 'bin' field — package installs no global executables, nothing to check." });
  } else if (typeof bin === "string") {
    if (bin.trim() === "") {
      findings.push({ rule: "invalid_bin_field", severity: "error",
        message: "'bin' is an empty string; must be a non-empty relative file path." });
    } else {
      hasBin = true;
      entries.push({ binName: pkg.name || "(default)", target: bin });
    }
  } else if (typeof bin === "object" && !Array.isArray(bin)) {
    const keys = Object.keys(bin);
    if (keys.length === 0) {
      findings.push({ rule: "invalid_bin_field", severity: "error",
        message: "'bin' object has no entries." });
    }
    for (const key of keys) {
      const target = bin[key];
      if (typeof target !== "string" || target.trim() === "") {
        findings.push({ rule: "invalid_bin_entry", severity: "error",
          message: `bin['${key}'] must be a non-empty string file path.`, binName: key });
        continue;
      }
      hasBin = true;
      entries.push({ binName: key, target });
    }
  } else {
    findings.push({ rule: "invalid_bin_field", severity: "error",
      message: "'bin' field must be a string or an object mapping command name to file path." });
  }

  const pkgDir = path.dirname(filePath);
  for (const { binName, target } of entries) {
    const resolvedTarget = path.resolve(pkgDir, target);
    let stat;
    try { stat = fs.statSync(resolvedTarget); }
    catch (_) {
      findings.push({ rule: "bin_file_not_found", severity: "error", binName, file: target,
        message: `bin['${binName}'] -> '${target}' does not exist on disk.` });
      continue;
    }
    if (!stat.isFile()) {
      findings.push({ rule: "bin_file_not_found", severity: "error", binName, file: target,
        message: `bin['${binName}'] -> '${target}' is not a regular file.` });
      continue;
    }

    let firstLine = "";
    try { firstLine = readFirstLine(resolvedTarget); }
    catch (e) {
      findings.push({ rule: "bin_file_not_found", severity: "error", binName, file: target,
        message: `bin['${binName}'] -> '${target}' could not be read: ${e.message}` });
      continue;
    }

    if (!firstLine.startsWith("#!")) {
      findings.push({ rule: "missing_shebang", severity: "error", binName, file: target,
        message: `'${target}' has no shebang line — will fail when invoked directly after global install. Add '#!/usr/bin/env node' as the first line.` });
      continue;
    }

    if (!NODE_SHEBANG_RE.test(firstLine)) {
      findings.push({ rule: "malformed_node_shebang", severity: "warning", binName, file: target,
        message: `'${target}' shebang ("${firstLine}") does not reference 'node' — confirm this is intentional.` });
    }

    if (process.platform !== "win32") {
      const executable = (stat.mode & 0o111) !== 0;
      if (!executable) {
        findings.push({ rule: "missing_executable_bit", severity: "warning", binName, file: target,
          message: `'${target}' has a shebang but no executable bit set (mode ${(stat.mode & 0o777).toString(8)}); 'npm publish' preserves the bit but a fresh checkout or CI artifact may lose it — run 'chmod +x' before publishing.` });
      }
    }
  }

  const errorCount = findings.filter(f => f.severity === "error").length;
  const warningCount = findings.filter(f => f.severity === "warning").length;
  const infoCount = findings.filter(f => f.severity === "info").length;

  return { path: origPath, hasBin, binCount: entries.length, findingsCount: findings.length, errorCount, warningCount, infoCount, findings };
}

module.exports = { findMissingShebangInBinScripts };
