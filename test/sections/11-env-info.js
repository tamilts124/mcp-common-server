"use strict";
/**
 * [15] ENV INFO — env_info tool (read-only server environment snapshot).
 *
 * Rigor levels covered:
 *   Normal:   happy-path call returns all expected fields with correct types
 *   Medium:   fields have sensible values (version format, known platforms,
 *             uptime >= 0, roots is an array, booleans are booleans)
 *   High:     calling env_info with unexpected extra args is silently ignored
 *             (no required fields); result is consistent across repeated calls
 *             in same process (nodeVersion/platform/arch never change)
 *   Critical: no environment variables or secrets in the response; env_info
 *             result must NOT contain process.env values; ensure the roots
 *             array lists only the configured root aliases (not absolute paths)
 *   Extreme:  1000 rapid sequential calls produce identical invariant fields;
 *             uptimeSeconds is non-decreasing across calls; result is valid JSON
 */
const { assert, test, executeTool } = require("../test-harness");

console.log(`\n[15] ENV INFO — env_info tool`);

// ── NORMAL — happy path ───────────────────────────────────────────────────────
test("env_info: returns a result without throwing", () => {
  const r = executeTool("env_info", {});
  assert.ok(r !== null && typeof r === "object", "result must be an object");
});

test("env_info: nodeVersion field is a string starting with 'v'", () => {
  const r = executeTool("env_info", {});
  assert.ok(typeof r.nodeVersion === "string", "nodeVersion must be a string");
  assert.ok(r.nodeVersion.startsWith("v"), `nodeVersion should start with 'v', got: ${r.nodeVersion}`);
});

test("env_info: platform field is a non-empty string", () => {
  const r = executeTool("env_info", {});
  assert.ok(typeof r.platform === "string" && r.platform.length > 0, "platform must be non-empty string");
});

test("env_info: arch field is a non-empty string", () => {
  const r = executeTool("env_info", {});
  assert.ok(typeof r.arch === "string" && r.arch.length > 0, "arch must be non-empty string");
});

test("env_info: hostname field is a non-empty string", () => {
  const r = executeTool("env_info", {});
  assert.ok(typeof r.hostname === "string" && r.hostname.length > 0, "hostname must be non-empty string");
});

test("env_info: uptimeSeconds is a non-negative number", () => {
  const r = executeTool("env_info", {});
  assert.ok(typeof r.uptimeSeconds === "number", "uptimeSeconds must be a number");
  assert.ok(r.uptimeSeconds >= 0, "uptimeSeconds must be non-negative");
});

test("env_info: roots is an array of strings", () => {
  const r = executeTool("env_info", {});
  assert.ok(Array.isArray(r.roots), "roots must be an array");
  assert.ok(r.roots.length > 0, "roots must have at least one entry");
  for (const root of r.roots) {
    assert.ok(typeof root === "string", `each root entry must be a string, got: ${typeof root}`);
  }
});

test("env_info: readOnly is a boolean", () => {
  const r = executeTool("env_info", {});
  assert.ok(typeof r.readOnly === "boolean", `readOnly must be boolean, got: ${typeof r.readOnly}`);
});

test("env_info: allowExec is a boolean", () => {
  const r = executeTool("env_info", {});
  assert.ok(typeof r.allowExec === "boolean", `allowExec must be boolean, got: ${typeof r.allowExec}`);
});

test("env_info: cmdTimeoutSeconds is a positive number", () => {
  const r = executeTool("env_info", {});
  assert.ok(typeof r.cmdTimeoutSeconds === "number", "cmdTimeoutSeconds must be a number");
  assert.ok(r.cmdTimeoutSeconds > 0, "cmdTimeoutSeconds must be positive");
});

// ── MEDIUM — field value validation ──────────────────────────────────────────
test("env_info: nodeVersion matches semver vMAJOR.MINOR.PATCH format", () => {
  const r = executeTool("env_info", {});
  assert.ok(/^v\d+\.\d+\.\d+/.test(r.nodeVersion), `nodeVersion not semver: ${r.nodeVersion}`);
});

test("env_info: platform is a known value (win32, linux, darwin, etc.)", () => {
  const knownPlatforms = ["win32", "linux", "darwin", "freebsd", "openbsd", "sunos", "aix"];
  const r = executeTool("env_info", {});
  assert.ok(knownPlatforms.includes(r.platform), `Unexpected platform: ${r.platform}`);
});

test("env_info: arch is a known value (x64, arm64, ia32, etc.)", () => {
  const knownArchs = ["x64", "arm64", "ia32", "arm", "mips", "mipsel", "ppc", "ppc64", "s390", "s390x"];
  const r = executeTool("env_info", {});
  assert.ok(knownArchs.includes(r.arch), `Unexpected arch: ${r.arch}`);
});

test("env_info: nodeVersion matches actual process.version", () => {
  const r = executeTool("env_info", {});
  assert.strictEqual(r.nodeVersion, process.version, "nodeVersion must match process.version");
});

test("env_info: allowExec is true in the test harness (MCP_ALLOW_EXEC=true)", () => {
  const r = executeTool("env_info", {});
  assert.strictEqual(r.allowExec, true, "test harness sets MCP_ALLOW_EXEC=true — allowExec should reflect this");
});

test("env_info: readOnly is false in the test harness (MCP_READ_ONLY=false)", () => {
  const r = executeTool("env_info", {});
  assert.strictEqual(r.readOnly, false, "test harness sets MCP_READ_ONLY=false — readOnly should reflect this");
});

// ── HIGH — consistency & extra-arg handling ───────────────────────────────────
test("env_info: calling with null args does not throw (no required fields)", () => {
  // env_info has no required fields — any args (or none) should work
  const r = executeTool("env_info", null);
  assert.ok(typeof r === "object" && r.nodeVersion, "should return valid result with null args");
});

test("env_info: calling with unexpected extra args is silently ignored", () => {
  const r = executeTool("env_info", { surprise: "value", another: 42 });
  assert.ok(typeof r.nodeVersion === "string", "extra args should be ignored, result still valid");
});

test("env_info: invariant fields are identical across two consecutive calls", () => {
  const r1 = executeTool("env_info", {});
  const r2 = executeTool("env_info", {});
  assert.strictEqual(r1.nodeVersion, r2.nodeVersion, "nodeVersion must be stable");
  assert.strictEqual(r1.platform,    r2.platform,    "platform must be stable");
  assert.strictEqual(r1.arch,        r2.arch,        "arch must be stable");
  assert.strictEqual(r1.hostname,    r2.hostname,    "hostname must be stable");
  // roots/readOnly/allowExec should also be stable within a process
  assert.deepStrictEqual(r1.roots,   r2.roots,       "roots must be stable");
  assert.strictEqual(r1.readOnly,    r2.readOnly,    "readOnly must be stable");
  assert.strictEqual(r1.allowExec,   r2.allowExec,   "allowExec must be stable");
});

test("env_info: uptimeSeconds is non-decreasing across two calls", () => {
  const r1 = executeTool("env_info", {});
  const r2 = executeTool("env_info", {});
  assert.ok(r2.uptimeSeconds >= r1.uptimeSeconds,
    `uptime should be non-decreasing: ${r1.uptimeSeconds} → ${r2.uptimeSeconds}`);
});

// ── CRITICAL — no secrets, no env vars ───────────────────────────────────────
test("env_info: result does not contain any process.env values (no secret leakage)", () => {
  const r = executeTool("env_info", {});
  const resultStr = JSON.stringify(r);
  // Spot-check: common sensitive env vars whose values are non-trivial (long enough
  // to be meaningful and not just a common word) should NOT appear verbatim in output.
  // We skip short values like "true"/"false"/"0" that would cause false positives
  // because they legitimately appear in the structured result as booleans/numbers.
  const sensitiveKeys = ["PATH", "HOME", "USERPROFILE", "APPDATA", "SECRET", "API_KEY", "TOKEN"];
  for (const key of sensitiveKeys) {
    const val = process.env[key];
    // Only check if the env var has a non-trivial value (> 8 chars, not a path fragment
    // that might reasonably appear in a hostname or alias name).
    if (val && val.length > 8 && !/^(true|false|\d+)$/.test(val)) {
      assert.ok(!resultStr.includes(val),
        `env var ${key} value should NOT appear in env_info output`);
    }
  }
  // Specifically verify MCP_ROOTS raw path is not in the output (roots aliases only)
  const rawRoots = process.env.MCP_ROOTS;
  if (rawRoots && rawRoots.length > 8) {
    // The raw path(s) from MCP_ROOTS env var should not appear — only aliases do
    assert.ok(!resultStr.includes(rawRoots),
      "raw MCP_ROOTS path should NOT appear verbatim in env_info output");
  }
});

test("env_info: roots array contains aliases (strings), not absolute filesystem paths", () => {
  const r = executeTool("env_info", {});
  for (const root of r.roots) {
    // A root alias should not look like an absolute path (C:\ or /)
    const looksAbsolute = /^[A-Za-z]:[\\/]/.test(root) || root.startsWith("/");
    assert.ok(!looksAbsolute, `root '${root}' looks like an absolute path — should be an alias`);
  }
});

test("env_info: result does not contain prototype-polluting keys", () => {
  const r = executeTool("env_info", {});
  // Verify __proto__, constructor, toString are not enumerable on the result
  assert.ok(!Object.prototype.hasOwnProperty.call(r, "__proto__"), "should not have __proto__");
  // The result keys should be exactly the documented set
  const expectedKeys = new Set([
    "nodeVersion", "platform", "arch", "hostname", "uptimeSeconds",
    "roots", "readOnly", "allowExec", "cmdTimeoutSeconds",
  ]);
  for (const key of Object.keys(r)) {
    assert.ok(expectedKeys.has(key), `Unexpected key in env_info result: '${key}'`);
  }
});

// ── EXTREME — stress & serialisability ───────────────────────────────────────
test("env_info: 1000 rapid sequential calls all return valid results", () => {
  let prev = null;
  for (let i = 0; i < 1000; i++) {
    const r = executeTool("env_info", {});
    assert.ok(typeof r.nodeVersion === "string", `call ${i}: nodeVersion missing`);
    if (prev !== null) {
      assert.strictEqual(r.nodeVersion, prev.nodeVersion, `call ${i}: nodeVersion changed`);
    }
    prev = r;
  }
});

test("env_info: result is fully JSON-serialisable (no circular refs, no Dates, no undefined)", () => {
  const r = executeTool("env_info", {});
  let serialised;
  assert.doesNotThrow(() => { serialised = JSON.stringify(r); }, "JSON.stringify must not throw");
  const parsed = JSON.parse(serialised);
  assert.strictEqual(parsed.nodeVersion, r.nodeVersion, "round-trip preserves nodeVersion");
  assert.ok(Array.isArray(parsed.roots), "round-trip preserves roots array");
});

test("env_info: uptimeSeconds across 10 calls stays within a reasonable range (< 60s drift)", () => {
  const times = Array.from({ length: 10 }, () => executeTool("env_info", {}).uptimeSeconds);
  const spread = Math.max(...times) - Math.min(...times);
  assert.ok(spread < 60, `uptime spread across 10 calls was ${spread}s — unexpectedly large`);
});
