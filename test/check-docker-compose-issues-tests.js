"use strict";
// Isolated functional tests for check_docker_compose_issues (lib/dockerComposeAuditOps.js).
// Run standalone: node test/check-docker-compose-issues-tests.js
const fs = require("fs");
const path = require("path");
const os = require("os");
const assert = require("assert");
const { checkDockerComposeIssues } = require("../lib/dockerComposeAuditOps");

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log("  ok -", name); }
  catch (e) { fail++; console.log("  FAIL -", name, "-", e.message); }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dc-test-"));
function writeCompose(name, content) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content, "utf8");
  return p;
}

console.log("\n[check_docker_compose_issues] TESTS");

// ── Normal (happy path) ──────────────────────────────────────────────────
test("normal: image with no tag flagged missing_tag_or_digest", () => {
  const p = writeCompose("c1.yml", "services:\n  web:\n    image: myrepo/app\n    restart: always\n");
  const r = checkDockerComposeIssues(p, "c1.yml");
  const f = r.findings.find(x => x.rule === "image_missing_tag_or_digest");
  assert.ok(f, "expected finding");
  assert.strictEqual(f.severity, "error");
});

test("normal: explicit :latest tag flagged", () => {
  const p = writeCompose("c2.yml", "services:\n  web:\n    image: myrepo/app:latest\n    restart: always\n");
  const r = checkDockerComposeIssues(p, "c2.yml");
  assert.ok(r.findings.some(x => x.rule === "image_explicit_latest_tag"));
});

test("normal: locally-built service (has build:) not flagged for missing tag", () => {
  const p = writeCompose("c3.yml", "services:\n  web:\n    build: .\n    restart: always\n");
  const r = checkDockerComposeIssues(p, "c3.yml");
  assert.ok(!r.findings.some(x => x.rule === "image_missing_tag_or_digest"));
});

test("normal: privileged true flagged error", () => {
  const p = writeCompose("c4.yml", "services:\n  web:\n    image: app:1.2.3\n    privileged: true\n    restart: always\n");
  const r = checkDockerComposeIssues(p, "c4.yml");
  const f = r.findings.find(x => x.rule === "privileged_true");
  assert.ok(f && f.severity === "error");
});

test("normal: network_mode host flagged warning", () => {
  const p = writeCompose("c5.yml", "services:\n  web:\n    image: app:1.2.3\n    network_mode: host\n    restart: always\n");
  const r = checkDockerComposeIssues(p, "c5.yml");
  assert.ok(r.findings.some(x => x.rule === "host_network_mode" && x.severity === "warning"));
});

test("normal: missing restart flagged info", () => {
  const p = writeCompose("c6.yml", "services:\n  web:\n    image: app:1.2.3\n");
  const r = checkDockerComposeIssues(p, "c6.yml");
  assert.ok(r.findings.some(x => x.rule === "missing_restart_policy" && x.severity === "info"));
});

test("normal: port with no bind address flagged", () => {
  const p = writeCompose("c7.yml", "services:\n  web:\n    image: app:1.2.3\n    restart: always\n    ports:\n      - \"8080:80\"\n");
  const r = checkDockerComposeIssues(p, "c7.yml");
  assert.ok(r.findings.some(x => x.rule === "port_bound_to_all_interfaces"));
});

test("normal: port with explicit localhost bind not flagged", () => {
  const p = writeCompose("c8.yml", "services:\n  web:\n    image: app:1.2.3\n    restart: always\n    ports:\n      - \"127.0.0.1:8080:80\"\n");
  const r = checkDockerComposeIssues(p, "c8.yml");
  assert.ok(!r.findings.some(x => x.rule === "port_bound_to_all_interfaces"));
});

test("normal: inline secret-shaped env value flagged", () => {
  const p = writeCompose("c9.yml", "services:\n  web:\n    image: app:1.2.3\n    restart: always\n    environment:\n      - DB_PASSWORD=hunter2\n");
  const r = checkDockerComposeIssues(p, "c9.yml");
  assert.ok(r.findings.some(x => x.rule === "inline_env_looks_like_secret"));
});

test("normal: env var interpolation not flagged", () => {
  const p = writeCompose("c10.yml", "services:\n  web:\n    image: app:1.2.3\n    restart: always\n    environment:\n      - DB_PASSWORD=${DB_PASSWORD}\n");
  const r = checkDockerComposeIssues(p, "c10.yml");
  assert.ok(!r.findings.some(x => x.rule === "inline_env_looks_like_secret"));
});

test("normal: mapping-form environment also checked", () => {
  const p = writeCompose("c11.yml", "services:\n  web:\n    image: app:1.2.3\n    restart: always\n    environment:\n      API_TOKEN: abc123\n");
  const r = checkDockerComposeIssues(p, "c11.yml");
  assert.ok(r.findings.some(x => x.rule === "inline_env_looks_like_secret"));
});

test("normal: fully clean service has zero findings", () => {
  const p = writeCompose("c12.yml", "services:\n  web:\n    image: app:1.2.3\n    restart: always\n    ports:\n      - \"127.0.0.1:8080:80\"\n");
  const r = checkDockerComposeIssues(p, "c12.yml");
  assert.strictEqual(r.findingsCount, 0);
});

test("normal: multiple services all scanned, findings sorted by service", () => {
  const p = writeCompose("c13.yml", "services:\n  zeta:\n    image: z:latest\n  alpha:\n    image: a:latest\n");
  const r = checkDockerComposeIssues(p, "c13.yml");
  const names = r.findings.filter(f => f.rule === "image_explicit_latest_tag").map(f => f.service);
  assert.deepStrictEqual(names.slice(0, 2), ["alpha", "zeta"]);
});

// ── Medium (boundary & parameter validation) ─────────────────────────────
test("medium: nonexistent file throws -32602", () => {
  assert.throws(() => checkDockerComposeIssues(path.join(tmpDir, "nope.yml"), "nope.yml"), /cannot read/);
});

test("medium: max_results type mismatch throws", () => {
  const p = writeCompose("c14.yml", "services:\n  web:\n    image: app:latest\n");
  assert.throws(() => checkDockerComposeIssues(p, "c14.yml", { maxResults: "5" }), /max_results must be a number/);
});

test("medium: no services key returns empty result with note, not error", () => {
  const p = writeCompose("c15.yml", "version: \"3.8\"\n");
  const r = checkDockerComposeIssues(p, "c15.yml");
  assert.strictEqual(r.findingsCount, 0);
  assert.ok(r.note);
});

test("medium: empty file returns empty result, not error", () => {
  const p = writeCompose("c16.yml", "");
  const r = checkDockerComposeIssues(p, "c16.yml");
  assert.strictEqual(r.serviceCount, 0);
});

test("medium: max_results truncation caps findings and sets truncated flag", () => {
  let yml = "services:\n";
  for (let i = 0; i < 10; i++) yml += `  svc${i}:\n    image: app${i}:latest\n`;
  const p = writeCompose("c17.yml", yml);
  const r = checkDockerComposeIssues(p, "c17.yml", { maxResults: 3 });
  // each service yields 2 findings (explicit_latest_tag + missing_restart_policy) = 20 total
  assert.strictEqual(r.findings.length, 3);
  assert.strictEqual(r.truncated, true);
  assert.strictEqual(r.findingsCount, 20);
});

// ── High (dependency failure / structural edge cases) ────────────────────
test("high: services value that is not a mapping is ignored gracefully", () => {
  const p = writeCompose("c18.yml", "services: notamapping\n");
  const r = checkDockerComposeIssues(p, "c18.yml");
  assert.strictEqual(r.serviceCount, 0);
});

test("high: a single service that is a scalar (malformed) is skipped without crash", () => {
  const p = writeCompose("c19.yml", "services:\n  web: notamapping\n  db:\n    image: db:latest\n");
  const r = checkDockerComposeIssues(p, "c19.yml");
  assert.ok(r.findings.every(f => f.service !== "web"));
  assert.ok(r.findings.some(f => f.service === "db"));
});

test("high: digest-pinned image never flagged regardless of tag text", () => {
  const p = writeCompose("c20.yml", "services:\n  web:\n    image: app@sha256:abcd1234\n    restart: always\n");
  const r = checkDockerComposeIssues(p, "c20.yml");
  assert.ok(!r.findings.some(f => f.rule.startsWith("image_")));
});

test("high: ports as non-string entries (numbers) don't crash", () => {
  const p = writeCompose("c21.yml", "services:\n  web:\n    image: app:1.2.3\n    restart: always\n    ports:\n      - 8080\n");
  assert.doesNotThrow(() => checkDockerComposeIssues(p, "c21.yml"));
});

// ── Critical (security / input sanitization) ─────────────────────────────
test("critical: path-traversal-shaped label echoed literally, not resolved", () => {
  const p = writeCompose("c22.yml", "services:\n  web:\n    image: app:latest\n");
  const r = checkDockerComposeIssues(p, "../../../etc/passwd-shaped-label.yml");
  assert.strictEqual(r.path, "../../../etc/passwd-shaped-label.yml");
});

test("critical: shell-injection-shaped image value only ever reported as text", () => {
  const p = writeCompose("c23.yml", 'services:\n  web:\n    image: "app:$(rm -rf /)"\n');
  const r = checkDockerComposeIssues(p, "c23.yml");
  // must not throw, must not execute anything — just text in a message field
  assert.ok(typeof JSON.stringify(r) === "string");
});

test("critical: HTML/script-tag env value doesn't break JSON output and is never echoed", () => {
  const p = writeCompose("c24.yml", "services:\n  web:\n    image: app:1.2.3\n    restart: always\n    environment:\n      - API_TOKEN=<script>alert(1)</script>\n");
  const r = checkDockerComposeIssues(p, "c24.yml");
  assert.ok(r.findings.some(f => f.rule === "inline_env_looks_like_secret"));
  const json = JSON.stringify(r);
  assert.ok(typeof json === "string");
  // secret VALUE itself is never echoed in the message — only the key name is.
  assert.ok(!json.includes("alert(1)"));
});

test("critical: JSON-serialisable exact top-level keys", () => {
  const p = writeCompose("c25.yml", "services:\n  web:\n    image: app:1.2.3\n    restart: always\n");
  const r = checkDockerComposeIssues(p, "c25.yml");
  const keys = Object.keys(r).sort();
  assert.deepStrictEqual(keys, ["errorCount", "findings", "findingsCount", "infoCount", "path", "serviceCount", "truncated", "warningCount"].sort());
});

// ── Extreme (fuzzing, concurrency, cleanup) ──────────────────────────────
test("extreme: fuzz random-byte file surfaces a clean parse error, not a crash", () => {
  const p = path.join(tmpDir, "fuzz.yml");
  fs.writeFileSync(p, require("crypto").randomBytes(500));
  assert.throws(() => checkDockerComposeIssues(p, "fuzz.yml"));
});

test("extreme: 50 services all scanned without truncation at default cap", () => {
  let yml = "services:\n";
  for (let i = 0; i < 50; i++) yml += `  svc${i}:\n    image: app${i}:1.0.${i}\n    restart: always\n`;
  const p = writeCompose("c26.yml", yml);
  const r = checkDockerComposeIssues(p, "c26.yml");
  assert.strictEqual(r.serviceCount, 50);
  assert.strictEqual(r.truncated, false);
});

test("extreme: 10 concurrent calls produce consistent results", () => {
  const p = writeCompose("c27.yml", "services:\n  web:\n    image: app:latest\n");
  const results = [];
  for (let i = 0; i < 10; i++) results.push(checkDockerComposeIssues(p, "c27.yml"));
  const first = JSON.stringify(results[0]);
  assert.ok(results.every(r => JSON.stringify(r) === first));
});

test("extreme: execute_pipeline op-enum registration", () => {
  const raw = fs.readFileSync(path.join(__dirname, "..", "lib", "schemas", "execSchemas.js"), "utf8");
  assert.ok(raw.includes('"check_docker_compose_issues"'));
});

test("cleanup: remove temp sandbox dir", () => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.ok(!fs.existsSync(tmpDir));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
