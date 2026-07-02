"use strict";
/**
 * Standalone tests for gzip_compress / gzip_decompress. NOT added to frozen
 * test/run-tests.js. Run: node test/gzip-tests.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-gzip-test-"));
process.env.MCP_ROOTS = TMP;
process.env.MCP_ALLOW_EXEC = "true";
process.env.MCP_READ_ONLY = "false";

const { buildRoots } = require("../lib/roots");
buildRoots();
const { executeTool } = require("../lib/executeTool");

const counters = { pass: 0, fail: 0 };
async function test(name, fn) {
  try { await fn(); counters.pass++; console.log(`  ok - ${name}`); }
  catch (e) { counters.fail++; console.log(`  FAIL - ${name}\n      ${e.message}`); }
}
function assertEq(a, b, msg) { if (a !== b) throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
async function expectThrow(fn, codeOrMsgFrag) {
  try { await fn(); throw new Error("expected throw, none occurred"); }
  catch (e) {
    if (e.message === "expected throw, none occurred") throw e;
    if (typeof codeOrMsgFrag === "number" && e.code !== codeOrMsgFrag)
      throw new Error(`expected code ${codeOrMsgFrag}, got ${e.code}: ${e.message}`);
    if (typeof codeOrMsgFrag === "string" && !e.message.includes(codeOrMsgFrag))
      throw new Error(`expected message to include '${codeOrMsgFrag}', got: ${e.message}`);
  }
}

function writeSrc(name, content) {
  const p = path.join(TMP, name);
  fs.writeFileSync(p, content);
  return name;
}

(async () => {
  console.log("== gzip-tests.js ==");

  // ── Normal (happy path) ──────────────────────────────────────────────
  await test("gzip_compress: compresses a text file", async () => {
    writeSrc("hello.txt", "hello world ".repeat(200));
    const r = await executeTool("gzip_compress", { path: "hello.txt", destination: "hello.txt.gz" });
    assertEq(r.source, "hello.txt");
    assertEq(r.destination, "hello.txt.gz");
    if (r.compressedBytes >= r.originalBytes) throw new Error("expected compression to shrink repetitive text");
    if (!fs.existsSync(path.join(TMP, "hello.txt.gz"))) throw new Error("destination not written");
  });

  await test("gzip_decompress: round-trips back to original bytes", async () => {
    const r = await executeTool("gzip_decompress", { path: "hello.txt.gz", destination: "hello.out.txt" });
    const original = fs.readFileSync(path.join(TMP, "hello.txt"));
    const restored = fs.readFileSync(path.join(TMP, "hello.out.txt"));
    assertEq(restored.equals(original), true, "round-trip content mismatch");
    assertEq(r.decompressedBytes, original.length);
  });

  await test("gzip_compress: respects explicit level", async () => {
    writeSrc("lvl.txt", "abcabcabcabc".repeat(500));
    const r0 = await executeTool("gzip_compress", { path: "lvl.txt", destination: "lvl0.gz", level: 0 });
    const r9 = await executeTool("gzip_compress", { path: "lvl.txt", destination: "lvl9.gz", level: 9 });
    if (r9.compressedBytes > r0.compressedBytes) throw new Error("level 9 should compress at least as well as level 0");
  });

  await test("gzip_compress: creates nested destination directories", async () => {
    writeSrc("nest-src.txt", "nested dir test");
    const r = await executeTool("gzip_compress", { path: "nest-src.txt", destination: "a/b/c/nest.gz" });
    if (!fs.existsSync(path.join(TMP, "a/b/c/nest.gz"))) throw new Error("nested destination not created");
  });

  // ── Medium (boundary & parameter validation) ─────────────────────────
  await test("gzip_compress: missing 'path' -> -32602", async () => {
    await expectThrow(() => executeTool("gzip_compress", { destination: "x.gz" }), -32602);
  });

  await test("gzip_compress: missing 'destination' -> -32602", async () => {
    await expectThrow(() => executeTool("gzip_compress", { path: "hello.txt" }), -32602);
  });

  await test("gzip_decompress: missing 'path' -> -32602", async () => {
    await expectThrow(() => executeTool("gzip_decompress", { destination: "x" }), -32602);
  });

  await test("gzip_compress: nonexistent source file -> clean error", async () => {
    await expectThrow(() => executeTool("gzip_compress", { path: "does-not-exist.txt", destination: "x.gz" }), "cannot access");
  });

  await test("gzip_compress: level out of range (10) -> clean error", async () => {
    writeSrc("range.txt", "x");
    await expectThrow(() => executeTool("gzip_compress", { path: "range.txt", destination: "range.gz", level: 10 }), "level");
  });

  await test("gzip_compress: level wrong type (string) -> clean error", async () => {
    await expectThrow(() => executeTool("gzip_compress", { path: "range.txt", destination: "range2.gz", level: "fast" }), "level");
  });

  await test("gzip_compress: source is a directory, not a file -> clean error", async () => {
    fs.mkdirSync(path.join(TMP, "adir"), { recursive: true });
    await expectThrow(() => executeTool("gzip_compress", { path: "adir", destination: "adir.gz" }), "not a regular file");
  });

  // ── High (dependency-failure equivalent) ──────────────────────────────
  await test("gzip_decompress: corrupted/non-gzip source -> clean error, no crash", async () => {
    writeSrc("notgzip.gz", "this is plain text, not gzip data at all");
    await expectThrow(() => executeTool("gzip_decompress", { path: "notgzip.gz", destination: "bad-out.txt" }), "not valid gzip data");
  });

  await test("gzip_decompress: truncated real gzip stream -> clean error, no crash", async () => {
    const real = zlib.gzipSync(Buffer.from("a".repeat(5000)));
    fs.writeFileSync(path.join(TMP, "truncated.gz"), real.subarray(0, real.length - 5));
    await expectThrow(() => executeTool("gzip_decompress", { path: "truncated.gz", destination: "trunc-out.txt" }), "not valid gzip data");
  });

  // ── Critical (security / path traversal) ──────────────────────────────
  await test("gzip_compress: path traversal in 'path' rejected", async () => {
    await expectThrow(() => executeTool("gzip_compress", { path: "../../../../etc/passwd", destination: "x.gz" }), "Access denied");
  });

  await test("gzip_compress: path traversal in 'destination' rejected", async () => {
    writeSrc("trav-src.txt", "data");
    await expectThrow(() => executeTool("gzip_compress", { path: "trav-src.txt", destination: "../../../../tmp/evil.gz" }), "Access denied");
  });

  await test("gzip_decompress: path traversal in 'destination' rejected", async () => {
    await expectThrow(() => executeTool("gzip_decompress", { path: "hello.txt.gz", destination: "../../evil-out.txt" }), "Access denied");
  });

  await test("gzip_compress: shell-injection-shaped filename treated as literal, not executed", async () => {
    writeSrc("safe.txt", "data");
    // A destination name containing shell metacharacters must be treated as a
    // literal filename (fs.writeFileSync), never passed to a shell.
    const r = await executeTool("gzip_compress", { path: "safe.txt", destination: "evil$(whoami);.gz" });
    if (!fs.existsSync(path.join(TMP, "evil$(whoami);.gz"))) throw new Error("literal filename not written as-is");
  });

  // ── Extreme (fuzzing, concurrency, large payloads) ─────────────────────
  await test("gzip_compress/decompress: large random-byte fuzz payload round-trips", async () => {
    const big = require("crypto").randomBytes(2_000_000); // 2MB incompressible random data
    fs.writeFileSync(path.join(TMP, "fuzz.bin"), big);
    await executeTool("gzip_compress", { path: "fuzz.bin", destination: "fuzz.bin.gz" });
    await executeTool("gzip_decompress", { path: "fuzz.bin.gz", destination: "fuzz.out.bin" });
    const restored = fs.readFileSync(path.join(TMP, "fuzz.out.bin"));
    if (!restored.equals(big)) throw new Error("large fuzz payload round-trip mismatch");
  });

  await test("gzip_compress: empty file (0 bytes) handled cleanly", async () => {
    writeSrc("empty.txt", "");
    const r = await executeTool("gzip_compress", { path: "empty.txt", destination: "empty.gz" });
    assertEq(r.originalBytes, 0);
    assertEq(r.ratio, 0);
  });

  await test("concurrency: 10 parallel gzip_compress calls on distinct files, no cross-contamination", async () => {
    const jobs = [];
    for (let i = 0; i < 10; i++) {
      writeSrc(`c${i}.txt`, `content-${i}-`.repeat(1000));
      jobs.push(executeTool("gzip_compress", { path: `c${i}.txt`, destination: `c${i}.gz` }));
    }
    await Promise.all(jobs);
    for (let i = 0; i < 10; i++) {
      const out = await executeTool("gzip_decompress", { path: `c${i}.gz`, destination: `c${i}.out.txt` });
      const restored = fs.readFileSync(path.join(TMP, `c${i}.out.txt`), "utf8");
      if (restored !== `content-${i}-`.repeat(1000)) throw new Error(`cross-contamination detected at index ${i}`);
    }
  });

  console.log(`\n${counters.pass} passed, ${counters.fail} failed`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(counters.fail > 0 ? 1 : 0);
})();
