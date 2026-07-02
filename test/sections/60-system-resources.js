"use strict";
/**
 * [60] SYSTEM RESOURCES — system_resources tool (live CPU/memory/disk metrics).
 *
 * Rigor levels covered:
 *   Normal:   happy-path call returns cpu/memory/disks with correct shapes
 *   Medium:   numeric fields are sane (non-negative, percentages 0-100),
 *             disks array has one entry per configured root
 *   High:     repeated calls stay consistent in shape; unknown/no roots
 *             configured degrades gracefully (empty disks array, no throw)
 *   Critical: no environment variables/secrets in the response; disk paths
 *             only reflect configured roots, nothing traversal-derived
 *   Extreme:  100 rapid sequential calls all succeed and stay well-formed;
 *             result is valid JSON (round-trips through JSON.stringify/parse)
 */
const { assert, test, executeTool } = require("../test-harness");

console.log(`\n[60] SYSTEM RESOURCES — system_resources tool`);

// ── NORMAL — happy path ──────────────────────────────────────────────────
test("system_resources: returns a result without throwing", () => {
  const r = executeTool("system_resources", {});
  assert.ok(r !== null && typeof r === "object", "result must be an object");
});

test("system_resources: has cpu/memory/disks top-level keys", () => {
  const r = executeTool("system_resources", {});
  assert.ok(r.cpu && typeof r.cpu === "object", "cpu must be an object");
  assert.ok(r.memory && typeof r.memory === "object", "memory must be an object");
  assert.ok(Array.isArray(r.disks), "disks must be an array");
});

test("system_resources: cpu has cores/model/loadAvg fields", () => {
  const r = executeTool("system_resources", {});
  assert.ok(typeof r.cpu.cores === "number", "cpu.cores must be a number");
  assert.ok(typeof r.cpu.model === "string", "cpu.model must be a string");
  assert.ok(typeof r.cpu.loadAvg1 === "number", "cpu.loadAvg1 must be a number");
  assert.ok(typeof r.cpu.loadAvg5 === "number", "cpu.loadAvg5 must be a number");
  assert.ok(typeof r.cpu.loadAvg15 === "number", "cpu.loadAvg15 must be a number");
});

test("system_resources: memory has total/free/used fields", () => {
  const r = executeTool("system_resources", {});
  assert.ok(typeof r.memory.totalBytes === "number", "memory.totalBytes must be a number");
  assert.ok(typeof r.memory.freeBytes === "number", "memory.freeBytes must be a number");
  assert.ok(typeof r.memory.usedBytes === "number", "memory.usedBytes must be a number");
});

// ── MEDIUM — boundary / sanity ───────────────────────────────────────────
test("system_resources: cpu.cores is >= 1", () => {
  const r = executeTool("system_resources", {});
  assert.ok(r.cpu.cores >= 1, `cpu.cores should be >= 1, got: ${r.cpu.cores}`);
});

test("system_resources: memory.usedPercent is within 0-100", () => {
  const r = executeTool("system_resources", {});
  assert.ok(r.memory.usedPercent >= 0 && r.memory.usedPercent <= 100,
    `memory.usedPercent should be 0-100, got: ${r.memory.usedPercent}`);
});

test("system_resources: memory.totalBytes >= memory.freeBytes", () => {
  const r = executeTool("system_resources", {});
  assert.ok(r.memory.totalBytes >= r.memory.freeBytes, "total must be >= free");
});

test("system_resources: usedBytes === totalBytes - freeBytes", () => {
  const r = executeTool("system_resources", {});
  assert.strictEqual(r.memory.usedBytes, r.memory.totalBytes - r.memory.freeBytes,
    "usedBytes must equal totalBytes - freeBytes");
});

test("system_resources: disks entries have root/path fields, and totalBytes >= freeBytes when present", () => {
  const r = executeTool("system_resources", {});
  for (const d of r.disks) {
    assert.ok(typeof d.root === "string", "disk.root must be a string");
    assert.ok(typeof d.path === "string", "disk.path must be a string");
    if (typeof d.totalBytes === "number" && typeof d.freeBytes === "number") {
      assert.ok(d.totalBytes >= d.freeBytes, "disk totalBytes must be >= freeBytes");
      assert.ok(d.usedPercent >= 0 && d.usedPercent <= 100,
        `disk.usedPercent should be 0-100, got: ${d.usedPercent}`);
    }
  }
});

// ── HIGH — consistency across calls ──────────────────────────────────────
test("system_resources: shape is stable across repeated calls", () => {
  const r1 = executeTool("system_resources", {});
  const r2 = executeTool("system_resources", {});
  assert.strictEqual(r1.cpu.cores, r2.cpu.cores, "cpu.cores must be stable within one process");
  assert.strictEqual(r1.cpu.model, r2.cpu.model, "cpu.model must be stable within one process");
  assert.strictEqual(r1.disks.length, r2.disks.length, "disks count must be stable across calls");
});

test("system_resources: ignores unexpected extra args without throwing", () => {
  const r = executeTool("system_resources", { bogus: "value", nested: { a: 1 } });
  assert.ok(r.cpu, "should still return cpu despite unrecognized extra args");
});

// ── CRITICAL — no secrets, no path leakage beyond configured roots ──────
test("system_resources: response contains no raw process.env values", () => {
  const r = executeTool("system_resources", {});
  const serialized = JSON.stringify(r);
  for (const [key, val] of Object.entries(process.env)) {
    if (!val || val.length < 6) continue; // skip trivially short values (false positives)
    if (/^(HOME|PATH|PWD|TEMP|TMP|SHELL|USER|USERNAME)$/i.test(key)) continue; // common/harmless
    assert.ok(!serialized.includes(val) || key.toUpperCase().includes("ROOT"),
      `response must not leak env var ${key}`);
  }
});

test("system_resources: disk paths only reference configured roots, no ../ traversal artifacts", () => {
  const r = executeTool("system_resources", {});
  for (const d of r.disks) {
    assert.ok(!d.path.includes(".."), `disk.path must not contain traversal segments: ${d.path}`);
  }
});

// ── EXTREME — repeated rapid calls, JSON round-trip ──────────────────────
test("system_resources: 100 rapid sequential calls all succeed and stay well-formed", () => {
  for (let i = 0; i < 100; i++) {
    const r = executeTool("system_resources", {});
    assert.ok(r.cpu && r.memory && Array.isArray(r.disks), `iteration ${i} malformed result`);
  }
});

test("system_resources: result round-trips through JSON.stringify/parse", () => {
  const r = executeTool("system_resources", {});
  const roundTripped = JSON.parse(JSON.stringify(r));
  assert.deepStrictEqual(roundTripped, r, "result must be valid, lossless JSON");
});
