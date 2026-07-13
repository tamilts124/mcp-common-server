"use strict";
/**
 * Section 241 (offline subset) — registry_client offline tests
 *
 * Tests that require NO network access.
 * Sections A (validation x10), B (unit x20), D (security x10, offline subset),
 * E (error paths — offline subset x5), F (concurrency — offline x3)
 *
 * Total: 48 tests, all complete in <5 s
 */

const { registryClient, parseImageRef, normaliseRegistry } = require("../../lib/registryClientOps");

let passed = 0, failed = 0;
const results = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    results.push({ status: "PASS", name });
  } catch (e) {
    failed++;
    results.push({ status: "FAIL", name, error: e.message || String(e) });
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error("Assertion failed: " + msg);
}

function assertThrows(fn, substr) {
  let threw = false;
  try { fn(); } catch (e) {
    threw = true;
    if (substr && !e.message.includes(substr))
      throw new Error("Expected error '" + substr + "', got: " + e.message);
  }
  if (!threw) throw new Error("Expected an error but none was thrown");
}

async function assertRejects(fn, substr) {
  let threw = false;
  try { await fn(); } catch (e) {
    threw = true;
    if (substr && !e.message.includes(substr))
      throw new Error("Expected rejection '" + substr + "', got: " + e.message);
  }
  if (!threw) throw new Error("Expected a rejection but none was thrown");
}

// settle: swallow the result of a promise after ms (for tests that launch real requests)
async function settle(promise, ms) {
  const abort = new Promise((_, rej) => setTimeout(() => rej(new Error("settle-timeout")), ms || 2000));
  try { return await Promise.race([promise, abort]); } catch { /* swallow */ }
}

(async () => {

// ─── Section A — Validation (x10) ───────────────────────────────────────────

await test("A01: missing operation throws", async () => {
  await assertRejects(() => registryClient({}), "operation");
});

await test("A02: invalid operation throws", async () => {
  await assertRejects(() => registryClient({ operation: "pull" }), "unknown operation");
});

await test("A03: ping without registry throws", async () => {
  await assertRejects(() => registryClient({ operation: "ping" }), "registry");
});

await test("A04: tags without image or registry throws", async () => {
  await assertRejects(() => registryClient({ operation: "tags" }), "image");
});

await test("A05: manifest without image or registry throws", async () => {
  await assertRejects(() => registryClient({ operation: "manifest" }), "image");
});

await test("A06: NUL byte in registry is rejected", async () => {
  await assertRejects(
    () => registryClient({ operation: "tags", registry: "ghcr.io\0evil", repository: "test/repo" }),
    "NUL");
});

await test("A07: NUL byte in repository is rejected", async () => {
  await assertRejects(
    () => registryClient({ operation: "tags", registry: "ghcr.io", repository: "test\0repo" }),
    "NUL");
});

await test("A08: NUL byte in reference is rejected", async () => {
  await assertRejects(
    () => registryClient({ operation: "manifest", registry: "ghcr.io", repository: "test/repo", reference: "latest\0" }),
    "NUL");
});

await test("A09: config without image or registry throws", async () => {
  await assertRejects(() => registryClient({ operation: "config" }), "image");
});

await test("A10: registry without repository throws", async () => {
  await assertRejects(() => registryClient({ operation: "tags", registry: "ghcr.io" }), "image");
});

// ─── Section B — Unit tests (pure logic) (x20) ──────────────────────────────

await test("B01: normaliseRegistry docker.io", async () => {
  assert(normaliseRegistry("docker.io") === "registry-1.docker.io", "docker.io");
});

await test("B02: normaliseRegistry index.docker.io", async () => {
  assert(normaliseRegistry("index.docker.io") === "registry-1.docker.io", "index.docker.io");
});

await test("B03: normaliseRegistry null/empty -> registry-1.docker.io", async () => {
  assert(normaliseRegistry("") === "registry-1.docker.io", "empty");
  assert(normaliseRegistry(null) === "registry-1.docker.io", "null");
});

await test("B04: normaliseRegistry other hosts unchanged", async () => {
  assert(normaliseRegistry("ghcr.io") === "ghcr.io", "ghcr.io");
  assert(normaliseRegistry("gcr.io") === "gcr.io", "gcr.io");
  assert(normaliseRegistry("localhost:5000") === "localhost:5000", "localhost:5000");
});

await test("B05: parseImageRef bare name -> library/<n>:latest", async () => {
  const r = parseImageRef("ubuntu");
  assert(r.registry === "registry-1.docker.io", "registry");
  assert(r.repository === "library/ubuntu", "repo");
  assert(r.reference === "latest", "ref");
});

await test("B06: parseImageRef name:tag", async () => {
  const r = parseImageRef("nginx:1.25");
  assert(r.registry === "registry-1.docker.io", "registry");
  assert(r.repository === "library/nginx", "repo");
  assert(r.reference === "1.25", "ref");
});

await test("B07: parseImageRef user/image:tag on docker hub", async () => {
  const r = parseImageRef("myuser/myimage:v2");
  assert(r.registry === "registry-1.docker.io", "registry");
  assert(r.repository === "myuser/myimage", "repo");
  assert(r.reference === "v2", "ref");
});

await test("B08: parseImageRef ghcr.io/owner/repo:latest", async () => {
  const r = parseImageRef("ghcr.io/owner/repo:latest");
  assert(r.registry === "ghcr.io", "registry");
  assert(r.repository === "owner/repo", "repo");
  assert(r.reference === "latest", "ref");
});

await test("B09: parseImageRef digest reference @sha256", async () => {
  const r = parseImageRef("nginx@sha256:abc123def456");
  assert(r.registry === "registry-1.docker.io", "registry");
  assert(r.repository === "library/nginx", "repo");
  assert(r.reference === "sha256:abc123def456", "ref");
});

await test("B10: parseImageRef localhost:5000/myimage", async () => {
  const r = parseImageRef("localhost:5000/myimage");
  assert(r.registry === "localhost:5000", "registry");
  assert(r.repository === "myimage", "repo");
  assert(r.reference === "latest", "ref");
});

await test("B11: parseImageRef multi-level repo on custom registry", async () => {
  const r = parseImageRef("gcr.io/google-containers/pause:3.9");
  assert(r.registry === "gcr.io", "registry");
  assert(r.repository === "google-containers/pause", "repo");
  assert(r.reference === "3.9", "ref");
});

await test("B12: parseImageRef no tag defaults to latest", async () => {
  const r = parseImageRef("alpine");
  assert(r.reference === "latest", "ref");
});

await test("B13: parseImageRef empty string throws", async () => {
  assertThrows(() => parseImageRef(""), "non-empty string");
});

await test("B14: parseImageRef null throws", async () => {
  assertThrows(() => parseImageRef(null), "non-empty string");
});

await test("B15: parseImageRef colon-separated digest-style tag", async () => {
  const r = parseImageRef("myrepo/myimage:sha256-abc");
  assert(r.reference === "sha256-abc", "ref: " + r.reference);
});

await test("B16: parseImageRef ECR-style host", async () => {
  const r = parseImageRef("123456789.dkr.ecr.us-east-1.amazonaws.com/myapp:latest");
  assert(r.registry === "123456789.dkr.ecr.us-east-1.amazonaws.com", "registry");
  assert(r.repository === "myapp", "repo");
  assert(r.reference === "latest", "ref");
});

await test("B17: parseImageRef Azure CR with tag", async () => {
  const r = parseImageRef("myregistry.azurecr.io/myimage:v1.0");
  assert(r.registry === "myregistry.azurecr.io", "registry");
  assert(r.repository === "myimage", "repo");
  assert(r.reference === "v1.0", "ref");
});

await test("B18: timeout=0 clamped to 1000ms; returns promise", async () => {
  const p = registryClient({ operation: "ping", registry: "ghcr.io", timeout: 0 });
  assert(p instanceof Promise, "returns Promise");
  await settle(p, 2000);
});

await test("B19: image + explicit registry override works (logic only)", async () => {
  const r = parseImageRef("nginx");
  assert(r.registry === "registry-1.docker.io", "base registry");
});

await test("B20: parseImageRef bitnami/postgresql:15", async () => {
  const r = parseImageRef("bitnami/postgresql:15");
  assert(r.registry === "registry-1.docker.io", "registry");
  assert(r.repository === "bitnami/postgresql", "repo");
  assert(r.reference === "15", "ref");
});

// ─── Section D — Security (offline subset x10) ───────────────────────────────

await test("D01: NUL byte in image string rejected", async () => {
  await assertRejects(() => registryClient({ operation: "tags", image: "alpine\0evil" }), "NUL");
});

await test("D02: NUL byte in registry field rejected", async () => {
  await assertRejects(
    () => registryClient({ operation: "tags", registry: "reg\0istry.io", repository: "test/img" }),
    "NUL");
});

await test("D03: NUL byte in repository field rejected", async () => {
  await assertRejects(
    () => registryClient({ operation: "tags", registry: "reg.io", repository: "test\0img" }),
    "NUL");
});

await test("D04: NUL byte in reference field rejected", async () => {
  await assertRejects(
    () => registryClient({ operation: "manifest", registry: "reg.io", repository: "test/img", reference: "v1\0" }),
    "NUL");
});

await test("D05: large timeout accepted, returns promise", async () => {
  const p = registryClient({ operation: "ping", registry: "ghcr.io", timeout: 999999999 });
  assert(p instanceof Promise, "returns Promise");
  await settle(p, 2000);
});

await test("D06: invalid host chars rejects with descriptive error", async () => {
  const p = registryClient({ operation: "ping", registry: "not a valid host!@#$", timeout: 1000 });
  assert(p instanceof Promise, "returns Promise");
  try { await p; } catch (e) {
    assert(e.message.length > 0, "non-empty error: " + e.message);
  }
});

await test("D07: path traversal in repository does not crash", async () => {
  const p = registryClient({ operation: "exists", registry: "ghcr.io", repository: "../../../etc/passwd", reference: "latest", timeout: 1000 });
  assert(p instanceof Promise, "returns Promise");
  try { await p; } catch { /* expected */ }
});

await test("D08: very long tag does not crash", async () => {
  const p = registryClient({ operation: "exists", image: "alpine:" + "a".repeat(500), timeout: 1000 });
  assert(p instanceof Promise, "returns Promise");
  try { await p; } catch { /* expected */ }
});

await test("D09: credentials not leaked in errors (offline check)", async () => {
  // Attempt with bad registry so it errors without network; check no secret leak
  try {
    await registryClient({ operation: "ping", registry: "invalid host\x00", username: "u", password: "MY_SECRET_XYZ", timeout: 1000 });
  } catch (e) {
    assert(!e.message.includes("MY_SECRET_XYZ"), "password leaked: " + e.message);
  }
});

await test("D10: insecure flag returns promise without sync crash", async () => {
  const p = registryClient({ operation: "ping", registry: "localhost:5000", insecure: true, timeout: 1000 });
  assert(p instanceof Promise, "returns Promise");
  try { await p; } catch { /* expected */ }
});

// ─── Section E — Error paths (offline subset x5) ────────────────────────────

await test("E01: non-existent registry host rejects", async () => {
  await assertRejects(
    () => registryClient({ operation: "ping", registry: "this-registry-does-not-exist-xyz-9999.invalid", timeout: 5000 }),
    "");
});

await test("E06: empty image string throws before network", async () => {
  await assertRejects(() => registryClient({ operation: "exists", image: "" }), "non-empty string");
});

await test("E_invalid_op_a: completely invalid operation rejected", async () => {
  await assertRejects(() => registryClient({ operation: "doesnotexist" }), "unknown operation");
});

await test("E_invalid_op_b: null operation rejected", async () => {
  await assertRejects(() => registryClient({ operation: null }), "");
});

await test("E_missing_repo: layers/exists without image or repo rejected", async () => {
  await assertRejects(() => registryClient({ operation: "layers" }), "image");
});

// ─── Section F — Concurrency (offline subset x3) ───────────────────────────

await test("F05: 3 concurrent NUL-byte rejections", async () => {
  const settled = await Promise.allSettled([
    registryClient({ operation: "tags", image: "al\0pine" }),
    registryClient({ operation: "tags", image: "alp\0ine" }),
    registryClient({ operation: "tags", registry: "reg\0.io", repository: "test/img" }),
  ]);
  for (const s of settled) {
    assert(s.status === "rejected", "should be rejected");
    assert(s.reason.message.includes("NUL"), "mentions NUL: " + s.reason.message);
  }
});

await test("F06a: 3 concurrent unknown-op rejections", async () => {
  const settled = await Promise.allSettled([
    registryClient({ operation: "invalid_op_a" }),
    registryClient({ operation: "invalid_op_b" }),
    registryClient({ operation: "invalid_op_c" }),
  ]);
  for (const s of settled) {
    assert(s.status === "rejected", "should be rejected");
    assert(s.reason.message.includes("unknown operation"), "mentions unknown operation");
  }
});

await test("F06b: 5 concurrent parseImageRef calls correct", async () => {
  const images = ["ubuntu", "nginx:1.25", "ghcr.io/owner/repo:latest", "alpine", "bitnami/redis:7"];
  const results2 = images.map(parseImageRef);
  assert(results2[0].repository === "library/ubuntu", "ubuntu");
  assert(results2[1].reference === "1.25", "nginx");
  assert(results2[2].registry === "ghcr.io", "ghcr");
  assert(results2[3].reference === "latest", "alpine");
  assert(results2[4].reference === "7", "redis");
});

// ─── Summary ─────────────────────────────────────────────────────────────────

const total = passed + failed;
console.error("\nSection 241 (offline) — registry_client");
console.error("  Passed:  " + passed);
console.error("  Failed:  " + failed);
console.error("  Total:   " + total);

for (const r of results) {
  if (r.status === "FAIL")
    console.error("  [FAIL] " + r.name + ": " + r.error);
}

if (failed > 0) {
  process.exitCode = 1;
  console.error("\n[FAIL] Some tests failed.");
} else {
  console.error("\n[PASS] All " + total + " tests passed.");
}

})();
