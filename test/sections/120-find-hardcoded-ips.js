"use strict";
/**
 * [120] FIND_HARDCODED_IPS — find_hardcoded_ips tool
 *
 * Rigor levels covered:
 *   Normal:   public IPv4 detected and classified 'public'; loopback/private
 *             excluded by default.
 *   Medium:   include_private:true surfaces loopback/private/link-local;
 *             extensions filter narrows directory-mode scan; max_matches
 *             caps results and sets truncated; non-existent path throws.
 *   High:     directory with no IP-shaped content returns zero matches, not
 *             an error; binary file skipped without crashing.
 *   Critical: path traversal / absolute-path-outside-root blocked; a
 *             version-string / non-IP numeric run (e.g. "1.2.3.4.5" out of
 *             range octet) is not falsely flagged; JSON-serialisable; no
 *             unexpected top-level keys.
 *   Extreme:  IPv6 public/link-local/loopback classification; many-match
 *             file capped by max_matches; 10 concurrent calls consistent;
 *             execute_pipeline op-enum registration; cleanup.
 */
const path = require("path");
const fs   = require("fs");

const { assert, test, TMP, executeTool } = require("../test-harness");

console.log(`\n[120] FIND_HARDCODED_IPS — find_hardcoded_ips tool`);

function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }

// ── NORMAL ────────────────────────────────────────────────────────────────────

test("find_hardcoded_ips: public IPv4 detected and classified 'public'", () => {
  const dir = path.join(TMP, "fhi-basic");
  mkdirp(dir);
  fs.writeFileSync(path.join(dir, "config.js"), 'const HOST = "203.0.113.42";\n', "utf8");
  const r = executeTool("find_hardcoded_ips", { path: path.relative(TMP, dir) });
  assert.strictEqual(r.totalMatches, 1);
  assert.strictEqual(r.matches[0].ip, "203.0.113.42");
  assert.strictEqual(r.matches[0].classification, "public");
  assert.strictEqual(r.matches[0].version, 4);
});

test("find_hardcoded_ips: loopback/private excluded by default", () => {
  const dir = path.join(TMP, "fhi-default-filter");
  mkdirp(dir);
  fs.writeFileSync(path.join(dir, "config.js"),
    'const A = "127.0.0.1";\nconst B = "192.168.1.5";\nconst C = "203.0.113.99";\n', "utf8");
  const r = executeTool("find_hardcoded_ips", { path: path.relative(TMP, dir) });
  assert.strictEqual(r.totalMatches, 1);
  assert.strictEqual(r.matches[0].ip, "203.0.113.99");
});

// ── MEDIUM — boundary & param validation ─────────────────────────────────────

test("find_hardcoded_ips: include_private surfaces loopback/private", () => {
  const dir = path.join(TMP, "fhi-include-private");
  mkdirp(dir);
  fs.writeFileSync(path.join(dir, "config.js"), 'const A = "127.0.0.1";\nconst B = "10.0.0.5";\n', "utf8");
  const r = executeTool("find_hardcoded_ips", { path: path.relative(TMP, dir), include_private: true });
  assert.strictEqual(r.totalMatches, 2);
  assert.ok(r.matches.some(m => m.classification === "loopback-or-broadcast"));
  assert.ok(r.matches.some(m => m.classification === "private"));
});

test("find_hardcoded_ips: extensions filter narrows directory scan", () => {
  const dir = path.join(TMP, "fhi-extfilter");
  mkdirp(dir);
  fs.writeFileSync(path.join(dir, "a.js"), 'const A = "203.0.113.1";\n', "utf8");
  fs.writeFileSync(path.join(dir, "b.md"), 'IP: 203.0.113.2\n', "utf8");
  const r = executeTool("find_hardcoded_ips", { path: path.relative(TMP, dir), extensions: [".js"] });
  assert.strictEqual(r.totalMatches, 1);
  assert.ok(r.matches[0].file.endsWith("a.js"));
});

test("find_hardcoded_ips: max_matches caps results and sets truncated", () => {
  const dir = path.join(TMP, "fhi-maxmatch");
  mkdirp(dir);
  let content = "";
  for (let i = 0; i < 20; i++) content += `IP ${i}: 203.0.113.${i % 254}\n`;
  fs.writeFileSync(path.join(dir, "many.txt"), content, "utf8");
  const r = executeTool("find_hardcoded_ips", { path: path.relative(TMP, dir), max_matches: 5 });
  assert.strictEqual(r.matches.length, 5);
  assert.strictEqual(r.truncated, true);
});

test("find_hardcoded_ips: non-existent path throws a descriptive error", () => {
  assert.throws(
    () => executeTool("find_hardcoded_ips", { path: "fhi-does-not-exist-xyz" }),
    /cannot access/i
  );
});

// ── HIGH — dependency / failure handling ─────────────────────────────────────

test("find_hardcoded_ips: directory with no IP-shaped content returns zero matches, not an error", () => {
  const dir = path.join(TMP, "fhi-empty");
  mkdirp(dir);
  fs.writeFileSync(path.join(dir, "readme.txt"), "hello world, no addresses here\n", "utf8");
  let r;
  assert.doesNotThrow(() => { r = executeTool("find_hardcoded_ips", { path: path.relative(TMP, dir) }); });
  assert.strictEqual(r.totalMatches, 0);
});

test("find_hardcoded_ips: binary file skipped without crashing", () => {
  const dir = path.join(TMP, "fhi-binary");
  mkdirp(dir);
  fs.writeFileSync(path.join(dir, "blob.bin"), Buffer.from([0, 1, 2, 203, 0, 113, 1, 0]));
  let r;
  assert.doesNotThrow(() => { r = executeTool("find_hardcoded_ips", { path: path.relative(TMP, dir) }); });
  assert.strictEqual(r.totalMatches, 0);
});

// ── CRITICAL — security & input sanitization ─────────────────────────────────

test("find_hardcoded_ips: path traversal via path arg is blocked", () => {
  assert.throws(
    () => executeTool("find_hardcoded_ips", { path: "../../etc" }),
    /outside.*root|traversal|not.*within/i
  );
});

test("find_hardcoded_ips: absolute path outside root is blocked", () => {
  assert.throws(
    () => executeTool("find_hardcoded_ips", { path: "C:\\Windows\\System32" }),
    /outside.*root|traversal|not.*within|invalid/i
  );
});

test("find_hardcoded_ips: out-of-range octet is not falsely flagged as an IP", () => {
  const dir = path.join(TMP, "fhi-outofrange");
  mkdirp(dir);
  fs.writeFileSync(path.join(dir, "version.txt"), "version 999.999.999.999 build\n", "utf8");
  const r = executeTool("find_hardcoded_ips", { path: path.relative(TMP, dir), include_private: true });
  assert.strictEqual(r.totalMatches, 0, `expected no matches, got: ${JSON.stringify(r.matches)}`);
});

test("find_hardcoded_ips: result is fully JSON-serialisable", () => {
  const dir = path.join(TMP, "fhi-json");
  mkdirp(dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "203.0.113.5\n", "utf8");
  const r = executeTool("find_hardcoded_ips", { path: path.relative(TMP, dir) });
  let serialised;
  assert.doesNotThrow(() => { serialised = JSON.stringify(r); });
  assert.strictEqual(JSON.parse(serialised).totalMatches, r.totalMatches);
});

test("find_hardcoded_ips: result has no unexpected top-level keys", () => {
  const dir = path.join(TMP, "fhi-keys");
  mkdirp(dir);
  const r = executeTool("find_hardcoded_ips", { path: path.relative(TMP, dir) });
  const expected = new Set(["path", "filesScanned", "totalMatches", "truncated", "byClassification", "filesAffected", "matches"]);
  for (const key of Object.keys(r)) assert.ok(expected.has(key), `unexpected top-level key: '${key}'`);
});

// ── EXTREME — stress, fuzzing & concurrency ──────────────────────────────────

test("find_hardcoded_ips: IPv6 public/link-local/loopback classified correctly", () => {
  const dir = path.join(TMP, "fhi-v6");
  mkdirp(dir);
  fs.writeFileSync(path.join(dir, "config.js"),
    'const PUB = "2001:db8:85a3::8a2e:370:7334";\nconst LL = "fe80::1";\nconst LOOP = "::1";\n', "utf8");
  const r = executeTool("find_hardcoded_ips", { path: path.relative(TMP, dir), include_private: true });
  const pub = r.matches.find(m => m.version === 6 && m.classification === "public");
  const ll  = r.matches.find(m => m.version === 6 && m.classification === "link-local");
  const loop = r.matches.find(m => m.version === 6 && m.classification === "loopback");
  assert.ok(pub, `expected a public IPv6 match among: ${JSON.stringify(r.matches)}`);
  assert.ok(ll, "expected a link-local IPv6 match");
  assert.ok(loop, "expected a loopback IPv6 match");
});

test("find_hardcoded_ips: 10 concurrent calls return consistent results", () => {
  const dir = path.join(TMP, "fhi-concurrent");
  mkdirp(dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "203.0.113.9\n203.0.113.10\n", "utf8");
  const relPath = path.relative(TMP, dir);
  const results = Array.from({ length: 10 }, () => executeTool("find_hardcoded_ips", { path: relPath }));
  const first = results[0];
  for (let i = 1; i < results.length; i++) {
    assert.strictEqual(results[i].totalMatches, first.totalMatches, `call ${i}: mismatch`);
  }
});

test("find_hardcoded_ips: is registered in the execute_pipeline op enum", () => {
  const { EXEC_SCHEMAS } = require("../../lib/schemas/execSchemas");
  const pipelineSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
  const opEnum = pipelineSchema.inputSchema.properties.steps.items.properties.op.enum;
  assert.ok(opEnum.includes("find_hardcoded_ips"), "find_hardcoded_ips missing from execute_pipeline op enum");
});

// ── CLEANUP ───────────────────────────────────────────────────────────────────

test("cleanup: remove find_hardcoded_ips fixture dirs", () => {
  const dirs = [
    "fhi-basic", "fhi-default-filter", "fhi-include-private", "fhi-extfilter", "fhi-maxmatch",
    "fhi-empty", "fhi-binary", "fhi-outofrange", "fhi-json", "fhi-keys", "fhi-v6", "fhi-concurrent",
  ];
  for (const d of dirs) {
    try { fs.rmSync(path.join(TMP, d), { recursive: true, force: true }); } catch (_) {}
  }
  assert.ok(!fs.existsSync(path.join(TMP, "fhi-basic")));
});
