"use strict";
// ── SYSTEM RESOURCES ────────────────────────────────────────────────────────
// system_resources — read-only, secret-free live resource snapshot.
// Complements env_info (static facts) with dynamic metrics: CPU load, memory,
// and per-root disk free/total space. Zero-dependency (os + fs.statfsSync).

/**
 * Return live system resource metrics.
 * @returns {{
 *   cpu: { cores: number, model: string, loadAvg1: number, loadAvg5: number, loadAvg15: number },
 *   memory: { totalBytes: number, freeBytes: number, usedBytes: number, usedPercent: number },
 *   disks: Array<{ root: string, path: string, totalBytes: number|null, freeBytes: number|null, usedPercent: number|null, error?: string }>
 * }}
 */
function systemResources() {
  const os = require("os");
  const fs = require("fs");
  const { ROOTS } = require("./roots");

  const cpus = os.cpus() || [];
  const [loadAvg1, loadAvg5, loadAvg15] = os.loadavg();
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = totalBytes - freeBytes;

  const disks = [...ROOTS.entries()].map(([alias, rootPath]) => {
    try {
      if (typeof fs.statfsSync !== "function") {
        return { root: alias, path: rootPath, totalBytes: null, freeBytes: null, usedPercent: null, error: "fs.statfsSync unsupported on this Node version" };
      }
      const s = fs.statfsSync(rootPath);
      const total = s.blocks * s.bsize;
      const free = s.bavail * s.bsize;
      const used = total - free;
      return {
        root: alias,
        path: rootPath,
        totalBytes: total,
        freeBytes: free,
        usedPercent: total > 0 ? Math.round((used / total) * 10000) / 100 : null,
      };
    } catch (err) {
      return { root: alias, path: rootPath, totalBytes: null, freeBytes: null, usedPercent: null, error: err.message };
    }
  });

  return {
    cpu: {
      cores: cpus.length,
      model: cpus[0] ? cpus[0].model : "unknown",
      loadAvg1, loadAvg5, loadAvg15,
    },
    memory: {
      totalBytes, freeBytes, usedBytes,
      usedPercent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 10000) / 100 : null,
    },
    disks,
  };
}

module.exports = { systemResources };
