"use strict";
// ── MULTI-ROOT SETUP, PATH SAFETY, IGNORE CHECK ───────────────────────────────
const fs   = require("fs");
const path = require("path");
const { IGNORE_PATTERNS } = require("./config");

const ROOTS = new Map(); // alias → absPath

function buildRoots() {
  ROOTS.clear();
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

/**
 * Returns true if `resolved` is equal to `root`, or is a path *inside* `root`
 * (i.e. nested under it with a path separator boundary).
 *
 * IMPORTANT: a naive `resolved.startsWith(root)` string check is NOT safe —
 * it would incorrectly allow a sibling directory whose name happens to share
 * `root` as a string prefix (e.g. root "/data/proj1" vs sibling
 * "/data/proj1-evil"), since "/data/proj1-evil".startsWith("/data/proj1") is
 * true even though proj1-evil is not nested inside proj1. Requiring an exact
 * match OR a trailing path-separator boundary closes that escape.
 */
function isWithinRoot(resolved, root) {
  if (resolved === root) return true;
  const withSep = root.endsWith(path.sep) ? root : root + path.sep;
  return resolved.startsWith(withSep);
}

function resolveClientPath(clientPath) {
  const normalized = (clientPath || "").replace(/\\/g, "/").replace(/^\/+/, "");

  for (const [alias, abs] of ROOTS) {
    if (normalized === alias || normalized.startsWith(alias + "/")) {
      const rel      = normalized.slice(alias.length).replace(/^\/+/, "") || ".";
      const resolved = path.resolve(abs, rel);
      if (!isWithinRoot(resolved, abs))
        throw new Error(`Access denied: outside root [${alias}]`);
      return { alias, root: abs, resolved };
    }
  }

  // No alias match — fall back to first root
  const [firstAlias, firstAbs] = ROOTS.entries().next().value;
  const resolved = path.resolve(firstAbs, normalized || ".");
  if (!isWithinRoot(resolved, firstAbs))
    throw new Error(`Access denied: outside root [${firstAlias}]`);
  return { alias: firstAlias, root: firstAbs, resolved };
}

function clientRelative(alias, absPath) {
  const root = ROOTS.get(alias);
  const rel  = path.relative(root, absPath).replace(/\\/g, "/");
  return ROOTS.size > 1 ? `${alias}/${rel}` : rel;
}

function isIgnored(name) {
  return IGNORE_PATTERNS.some(p => name === p || name.startsWith(p));
}

module.exports = { ROOTS, buildRoots, resolveClientPath, clientRelative, isIgnored };
