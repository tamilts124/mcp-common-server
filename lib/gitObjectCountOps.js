"use strict";
// ── GIT_OBJECT_COUNT — repo object-database health via `git count-objects -v`
// Single read-only git call. Reports loose-object count/size, pack
// count/size, and prune/garbage candidates — a fast signal for whether an
// agent should suggest `git gc` before larger operations (clone, push,
// bundle). All *size* fields git reports are in KiB (git's own convention
// for this command, not bytes) — kept as sizeKb to avoid silently implying
// bytes; humanSize helpers are also included for readability.
// Read-only — does not require MCP_ALLOW_EXEC beyond running git itself,
// consistent with every other git*Ops.js tool in this codebase.

const { gitExec } = require("./gitOpsHelpers");

const FIELDS = [
  "count", "size", "in-pack", "packs", "size-pack",
  "prune-packable", "garbage", "size-garbage",
];

function humanSize(kb) {
  const bytes = kb * 1024;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let val = bytes / 1024, i = 0;
  while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
  return `${val.toFixed(2)} ${units[i]}`;
}

/**
 * @param {string} repoDir  Absolute, jail-bounded repo root (already resolved via findRepoRoot).
 * @returns {{count, sizeKb, sizeHuman, inPack, packs, sizePackKb, sizePackHuman,
 *            prunePackable, garbage, sizeGarbageKb, sizeGarbageHuman,
 *            gcRecommended, raw}}
 */
function gitObjectCount(repoDir) {
  let out;
  try {
    out = gitExec("count-objects -v", repoDir);
  } catch (e) {
    const msg = e.message || "";
    try { gitExec("rev-parse --is-inside-work-tree", repoDir); }
    catch (_) { throw new Error("git_object_count failed: not a git repository."); }
    throw new Error(`git_object_count failed: ${msg.split("\n")[0]}`);
  }

  // Git only emits a field line when it has a value for it — older git
  // versions omit prune-packable/garbage/size-garbage entirely. Missing
  // fields default to 0 rather than throwing, per the tool's own contract.
  const raw = {};
  for (const line of out.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (FIELDS.includes(key)) raw[key] = val;
  }

  const num = (key) => {
    const v = parseInt(raw[key], 10);
    return Number.isFinite(v) ? v : 0;
  };

  const count          = num("count");
  const sizeKb          = num("size");
  const inPack          = num("in-pack");
  const packs           = num("packs");
  const sizePackKb      = num("size-pack");
  const prunePackable   = num("prune-packable");
  const garbage         = num("garbage");
  const sizeGarbageKb   = num("size-garbage");

  // Heuristic, not a hard rule: many loose objects relative to pack count,
  // or any prunable/garbage objects, are the classic "a git gc would help"
  // signals. Threshold picked to avoid flagging freshly-init'd repos.
  const gcRecommended = count > 200 || prunePackable > 0 || garbage > 0;

  return {
    count,
    sizeKb,
    sizeHuman: humanSize(sizeKb),
    inPack,
    packs,
    sizePackKb,
    sizePackHuman: humanSize(sizePackKb),
    prunePackable,
    garbage,
    sizeGarbageKb,
    sizeGarbageHuman: humanSize(sizeGarbageKb),
    gcRecommended,
    raw,
  };
}

module.exports = { gitObjectCount };
