"use strict";
// ── ENV_DIFF — compare two .env-style files (e.g. .env vs .env.example) ────
// Parses KEY=VALUE lines (ignoring comments/blank lines, stripping optional
// quotes), and reports keys only on one side plus keys with empty values on
// the primary side — the two mistakes agents most commonly need to catch
// when auditing environment configuration. Read-only, no MCP_ALLOW_EXEC.

const fs = require("fs");
const { ToolError } = require("./errors");

// Parses a .env-style buffer into an ordered Map<key, value>. Duplicate keys
// keep the last occurrence (matches real dotenv-loader semantics).
function parseEnvFile(absPath, origPath, toolName) {
  let stat;
  try { stat = fs.statSync(absPath); }
  catch (e) { throw new ToolError(`${toolName}: cannot access '${origPath}': ${e.message}`, -32602); }
  if (!stat.isFile()) throw new ToolError(`${toolName}: '${origPath}' is not a regular file.`, -32602);

  const text = fs.readFileSync(absPath, "utf8");
  const map = new Map();
  const lines = text.split(/\r\n|\r|\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue; // malformed line — not a KEY=VALUE pair, skip
    let key = line.slice(0, eq).trim();
    if (key.startsWith("export ")) key = key.slice(7).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2) {
      const first = value[0], last = value[value.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        value = value.slice(1, -1);
      }
    }
    map.set(key, value);
  }
  return map;
}

/**
 * Compare two .env-style files. `path` is the primary/live file, `comparePath`
 * is the reference (typically an .env.example / .env.template).
 *
 * @returns {{ path, comparePath, onlyInPath, onlyInComparePath, emptyInPath,
 *   commonKeyCount, totalPathKeys, totalCompareKeys }}
 */
function envDiff(absPath, origPath, absComparePath, origComparePath) {
  const primary = parseEnvFile(absPath, origPath, "env_diff");
  const compare = parseEnvFile(absComparePath, origComparePath, "env_diff");

  const onlyInPath = [];
  const emptyInPath = [];
  const onlyInComparePath = [];
  let commonKeyCount = 0;

  for (const [key, value] of primary) {
    if (compare.has(key)) {
      commonKeyCount++;
      if (value === "") emptyInPath.push(key);
    } else {
      onlyInPath.push(key);
    }
  }
  for (const key of compare.keys()) {
    if (!primary.has(key)) onlyInComparePath.push(key);
  }

  return {
    path:              origPath,
    comparePath:       origComparePath,
    onlyInPath:        onlyInPath.sort(),
    onlyInComparePath: onlyInComparePath.sort(),
    emptyInPath:       emptyInPath.sort(),
    commonKeyCount,
    totalPathKeys:     primary.size,
    totalCompareKeys:  compare.size,
  };
}

module.exports = { envDiff, parseEnvFile };
