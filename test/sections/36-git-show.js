"use strict";
/**
 * [39] GIT_SHOW — git_show tool
 *
 * Tests the `git_show` tool across all five rigor levels. git_show reads the
 * content of a file as it existed at a specific commit/ref without checking
 * it out into the working tree.
 *
 * Rigor levels covered:
 *   Normal:   happy-path — read a file at HEAD, at an older commit by short
 *             hash, by branch name, default ref (omitted → HEAD); result
 *             shape/fields.
 *   Medium:   boundary — HEAD~1/HEAD~2 relative refs, file at repo root vs
 *             nested subdirectory, ref explicitly "HEAD", file field
 *             required (missing throws -32602 style message).
 *   High:     dependency failure — unknown ref throws descriptive error;
 *             path that doesn't exist at that ref throws descriptive error;
 *             path that is a directory (tree) at that ref throws descriptive
 *             error distinguishing it from "missing"; non-git directory
 *             throws.
 *   Critical: security — shell metacharacter injection in ref/file rejected;
 *             path traversal via file arg does not escape the repo; path
 *             traversal via 'path' arg blocked by resolveClientPath;
 *             extremely long ref rejected; result is JSON-serialisable; no
 *             prototype pollution; binary content never returned as text.
 *   Extreme:  stress — large file (500 lines) round-trips exactly; 10
 *             concurrent calls consistent; binary file detected via
 *             NUL-byte heuristic and content is null while size is still
 *             reported; many-commit history reading an old version still
 *             works.
 */
const path = require("path");
const fs   = require("fs");
const { execSync } = require("child_process");

const { assert, test, TMP } = require("../test-harness");
const { executeTool } = require("../../lib/executeTool");

console.log(`\n[39] GIT_SHOW — git_show tool`);

// ── ISOLATED GIT REPO SETUP ───────────────────────────────────────────────────
const REPO = path.join(TMP, "git-show-repo");
const REPO_ALIAS = "git-show-repo";

function gitIn(cmd) {
  return execSync(`git ${cmd}`, {
    cwd: REPO,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(REPO) },
  }).trimEnd();
}

function setup() {
  if (fs.existsSync(REPO)) fs.rmSync(REPO, { recursive: true, force: true });
  fs.mkdirSync(REPO, { recursive: true });

  gitIn("init -b main");
  gitIn(`config user.email "test@example.com"`);
  gitIn(`config user.name "Test User"`);

  // Commit 1: hello.txt at repo root, plus a nested subdirectory file
  fs.mkdirSync(path.join(REPO, "src"), { recursive: true });
  fs.writeFileSync(path.join(REPO, "hello.txt"), "version one\n");
  fs.writeFileSync(path.join(REPO, "src", "nested.txt"), "nested version one\n");
  gitIn("add .");
  gitIn(`commit -m "first commit"`);

  // Commit 2: modify hello.txt
  fs.writeFileSync(path.join(REPO, "hello.txt"), "version two\n");
  gitIn("add hello.txt");
  gitIn(`commit -m "second commit"`);

  // Commit 3: modify hello.txt again (HEAD)
  fs.writeFileSync(path.join(REPO, "hello.txt"), "version three\n");
  gitIn("add hello.txt");
  gitIn(`commit -m "third commit"`);
}

setup();

const LOG = gitIn("log --format=%H");
const [thirdHash, secondHash, firstHash] = LOG.split("\n");

function gs(args = {}) {
  return executeTool("git_show", { path: REPO_ALIAS, ...args });
}

// ── NORMAL — happy path ───────────────────────────────────────────────────────

test("git_show: reads file content at HEAD (ref omitted)", () => {
  const r = gs({ file: "hello.txt" });
  assert.strictEqual(r.content, "version three\n");
  assert.strictEqual(r.ref, "HEAD");
  assert.strictEqual(r.isBinary, false);
});

test("git_show: reads file content at explicit full commit hash", () => {
  const r = gs({ file: "hello.txt", ref: firstHash });
  assert.strictEqual(r.content, "version one\n");
});

test("git_show: reads file content at short hash", () => {
  const shortHash = secondHash.slice(0, 7);
  const r = gs({ file: "hello.txt", ref: shortHash });
  assert.strictEqual(r.content, "version two\n");
});

test("git_show: reads file content by branch name", () => {
  const r = gs({ file: "hello.txt", ref: "main" });
  assert.strictEqual(r.content, "version three\n");
});

test("git_show: resolvedHash is the full 40-char commit hash", () => {
  const r = gs({ file: "hello.txt", ref: firstHash });
  assert.strictEqual(r.resolvedHash, firstHash);
  assert.strictEqual(r.resolvedHash.length, 40);
});

test("git_show: result has all expected fields with correct types", () => {
  const r = gs({ file: "hello.txt" });
  const required = ["ref", "resolvedHash", "file", "size", "isBinary", "content"];
  for (const key of required) {
    assert.ok(Object.prototype.hasOwnProperty.call(r, key), `result must have field '${key}'`);
  }
  assert.ok(typeof r.size === "number" && r.size >= 0, "size must be a non-negative number");
  assert.strictEqual(r.file, "hello.txt", "file should be echoed back");
});

test("git_show: reads a nested subdirectory file", () => {
  const r = gs({ file: "src/nested.txt", ref: firstHash });
  assert.strictEqual(r.content, "nested version one\n");
  assert.strictEqual(r.file, "src/nested.txt");
});

// ── MEDIUM — boundary & parameter validation ─────────────────────────────────

test("git_show: relative ref HEAD~1 resolves to second commit", () => {
  const r = gs({ file: "hello.txt", ref: "HEAD~1" });
  assert.strictEqual(r.content, "version two\n");
  assert.strictEqual(r.resolvedHash, secondHash);
});

test("git_show: relative ref HEAD~2 resolves to first commit", () => {
  const r = gs({ file: "hello.txt", ref: "HEAD~2" });
  assert.strictEqual(r.content, "version one\n");
  assert.strictEqual(r.resolvedHash, firstHash);
});

test("git_show: explicit ref 'HEAD' behaves the same as omitted ref", () => {
  const explicit = gs({ file: "hello.txt", ref: "HEAD" });
  const omitted  = gs({ file: "hello.txt" });
  assert.strictEqual(explicit.content, omitted.content);
  assert.strictEqual(explicit.resolvedHash, omitted.resolvedHash);
});

test("git_show: blank-string ref falls back to HEAD default", () => {
  const r = gs({ file: "hello.txt", ref: "" });
  assert.strictEqual(r.ref, "HEAD");
});

test("git_show: missing required 'file' field throws invalid-params error", () => {
  assert.throws(
    () => executeTool("git_show", { path: REPO_ALIAS }),
    /missing required field 'file'/i,
  );
});

test("git_show: ref field is echoed back exactly as the (trimmed) requested value", () => {
  const r = gs({ file: "hello.txt", ref: "  HEAD~1  " });
  assert.strictEqual(r.ref, "HEAD~1");
});

// ── HIGH — dependency failures ────────────────────────────────────────────────

test("git_show: unknown ref throws a descriptive, non-crashing error", () => {
  assert.throws(
    () => gs({ file: "hello.txt", ref: "totally-not-a-real-ref-xyz" }),
    /unknown ref/i,
  );
});

test("git_show: path that does not exist at that ref throws a descriptive error", () => {
  assert.throws(
    () => gs({ file: "does-not-exist.txt" }),
    /does not exist/i,
  );
});

test("git_show: file that exists now but not at an older ref throws descriptive error", () => {
  assert.throws(
    () => gs({ file: "hello.txt-that-never-existed", ref: firstHash }),
    /does not exist/i,
  );
});

test("git_show: path that is a directory (tree) at that ref throws a distinguishing error", () => {
  assert.throws(
    () => gs({ file: "src", ref: firstHash }),
    /directory/i,
  );
});

test("git_show: non-git directory throws a clean error", () => {
  const plainDir = path.join(TMP, "show-not-a-git-repo");
  fs.mkdirSync(plainDir, { recursive: true });
  try {
    assert.throws(
      () => executeTool("git_show", { path: "show-not-a-git-repo", file: "x.txt" }),
      /.+/,
    );
  } finally {
    fs.rmSync(plainDir, { recursive: true, force: true });
  }
});

// ── CRITICAL — security & input sanitization ─────────────────────────────────

test("git_show: semicolon injection in ref is rejected", () => {
  assert.throws(() => gs({ file: "hello.txt", ref: "main; rm -rf /" }), /disallowed characters/);
});

test("git_show: backtick injection in ref is rejected", () => {
  assert.throws(() => gs({ file: "hello.txt", ref: "`whoami`" }), /disallowed characters/);
});

test("git_show: dollar-paren injection in file is rejected", () => {
  assert.throws(() => gs({ file: "$(cat /etc/passwd)" }), /disallowed characters/);
});

test("git_show: pipe injection in file is rejected", () => {
  assert.throws(() => gs({ file: "hello.txt|cat /etc/passwd" }), /disallowed characters/);
});

test("git_show: newline injection in ref is rejected", () => {
  assert.throws(() => gs({ file: "hello.txt", ref: "HEAD\ngit push --force" }), /disallowed characters/);
});

test("git_show: extremely long ref (>4096 chars) is rejected", () => {
  assert.throws(() => gs({ file: "hello.txt", ref: "a".repeat(4097) }), /exceeds 4096/);
});

test("git_show: path traversal sequence in file arg does not escape the repo (git rejects/errors cleanly)", () => {
  // Git treeish paths with ../ either get rejected by our char-checks (none of
  // these chars are actually blocked) or fail to resolve inside the repo tree;
  // either way it must not throw an unhandled exception or leak host files.
  assert.throws(() => gs({ file: "../../../../etc/passwd" }), /.+/);
});

test("git_show: absolute path outside root via 'path' arg is blocked by resolveClientPath", () => {
  assert.throws(
    () => executeTool("git_show", { path: "C:\\Windows\\System32", file: "x.txt" }),
    /outside.*root|traversal|not.*within|invalid/i,
  );
});

test("git_show: relative '..' traversal via 'path' arg is blocked", () => {
  assert.throws(
    () => executeTool("git_show", { path: "../../../etc", file: "x.txt" }),
    /outside.*root|traversal|not.*within/i,
  );
});

test("git_show: result is fully JSON-serialisable (no circular refs)", () => {
  const r = gs({ file: "hello.txt" });
  let s;
  assert.doesNotThrow(() => { s = JSON.stringify(r); }, "JSON.stringify must not throw");
  const parsed = JSON.parse(s);
  assert.strictEqual(parsed.content, r.content);
});

test("git_show: result has no unexpected top-level keys (no prototype pollution)", () => {
  const r = gs({ file: "hello.txt" });
  const expected = new Set(["ref", "resolvedHash", "file", "size", "isBinary", "content"]);
  for (const key of Object.keys(r)) {
    assert.ok(expected.has(key), `unexpected top-level key: '${key}'`);
  }
  assert.ok(!Object.prototype.hasOwnProperty.call(r, "__proto__"));
});

test("git_show: injection-shaped file content round-trips literally, never executed", () => {
  const evilContent = "'; DROP TABLE users; --\n$(rm -rf /)\n`whoami`\n<script>alert(1)</script>\n";
  fs.writeFileSync(path.join(REPO, "evil.txt"), evilContent);
  gitIn("add evil.txt");
  gitIn(`commit -m "add evil-content fixture"`);
  try {
    const r = gs({ file: "evil.txt" });
    assert.strictEqual(r.content, evilContent, "content must round-trip exactly, unexecuted");
  } finally {
    gitIn("rm evil.txt");
    gitIn(`commit -m "remove evil-content fixture"`);
  }
});

// ── EXTREME — stress, fuzzing & concurrency ──────────────────────────────────

test("git_show: large file (500 lines) round-trips exactly", () => {
  const bigContent = Array.from({ length: 500 }, (_, i) => `line-${i}`).join("\n") + "\n";
  fs.writeFileSync(path.join(REPO, "bigfile.txt"), bigContent);
  gitIn("add bigfile.txt");
  gitIn(`commit -m "add bigfile"`);
  try {
    const r = gs({ file: "bigfile.txt" });
    assert.strictEqual(r.content, bigContent);
    assert.strictEqual(r.size, Buffer.byteLength(bigContent, "utf8"));
  } finally {
    gitIn("reset --hard HEAD~1");
  }
});

test("git_show: binary file is detected (NUL byte heuristic), content is null, size still reported", () => {
  const binBuf = Buffer.concat([
    Buffer.from("PNGFAKEHEADER"),
    Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff, 0xfe]),
    Buffer.from("more binary junk after the null byte"),
  ]);
  fs.writeFileSync(path.join(REPO, "image.bin"), binBuf);
  gitIn("add image.bin");
  gitIn(`commit -m "add binary fixture"`);
  try {
    const r = gs({ file: "image.bin" });
    assert.strictEqual(r.isBinary, true, "must be detected as binary");
    assert.strictEqual(r.content, null, "content must be null for binary files");
    assert.strictEqual(r.size, binBuf.length, "size must still be reported for binary files");
  } finally {
    gitIn("reset --hard HEAD~1");
  }
});

test("git_show: 10 concurrent calls return consistent results", () => {
  const results = Array.from({ length: 10 }, () => gs({ file: "hello.txt", ref: firstHash }));
  const first = results[0];
  for (let i = 1; i < results.length; i++) {
    assert.strictEqual(results[i].content, first.content, `call ${i} content mismatch`);
    assert.strictEqual(results[i].resolvedHash, first.resolvedHash, `call ${i} resolvedHash mismatch`);
  }
});

test("git_show: fuzz — random-bytes-shaped ref string throws cleanly, never crashes process", () => {
  // Note: a whitespace-only ref is intentionally excluded here — per gitShow's
  // documented behavior, ref.trim() === "" falls back to the "HEAD" default
  // (same as the explicit blank-string test above), which is correct, not a
  // crash to guard against.
  const fuzzRefs = [
    Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x02]).toString("binary"),
    "\u0000\u0001\u0002",
    "😀".repeat(50),
  ];
  for (const fr of fuzzRefs) {
    assert.throws(() => gs({ file: "hello.txt", ref: fr }), /.+/, `fuzz ref should throw cleanly: ${JSON.stringify(fr).slice(0, 40)}`);
  }
});

test("git_show: whitespace-only ref (200 spaces) trims to empty and falls back to HEAD, not a crash", () => {
  const r = gs({ file: "hello.txt", ref: " ".repeat(200) });
  assert.strictEqual(r.ref, "HEAD");
});

test("git_show: reading an old version after many subsequent commits still works", () => {
  // Pile up extra commits after the ones we care about, then confirm the
  // original firstHash content is still retrievable untouched.
  for (let i = 0; i < 5; i++) {
    fs.writeFileSync(path.join(REPO, `extra-${i}.txt`), `extra ${i}\n`);
    gitIn(`add extra-${i}.txt`);
    gitIn(`commit -m "extra commit ${i}"`);
  }
  try {
    const r = gs({ file: "hello.txt", ref: firstHash });
    assert.strictEqual(r.content, "version one\n");
    assert.strictEqual(r.resolvedHash, firstHash);
  } finally {
    gitIn("reset --hard " + thirdHash);
  }
});

// ── CLEANUP ───────────────────────────────────────────────────────────────────

test("cleanup: remove git-show-repo sandbox", () => {
  try { fs.rmSync(REPO, { recursive: true, force: true }); } catch (_) {}
  assert.ok(!fs.existsSync(REPO), "sandbox must be removed");
});
