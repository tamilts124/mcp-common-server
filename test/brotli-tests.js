"use strict";
/**
 * Standalone tests for brotli_compress / brotli_decompress. NOT added to
 * frozen test/run-tests.js. Run: node test/brotli-tests.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-brotli-test-"));
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
  console.log("== brotli-tests.js ==");

  // ── Normal (happy path) ──────────────────────────────────────────────
  await test("brotli_compress: compresses a text file", async () => {
    writeSrc("hello.txt", "hello world ".repeat(200));
    const r = await executeTool("brotli_compress", { path: "hello.txt", destination: "hello.txt.br" });
    assertEq(r.source, "hello.txt");
    assertEq(r.destination, "hello.txt.br");
    if (r.compressedBytes >= r.originalBytes) throw new Error("expected compression to shrink repetitive text");
    if (!fs.existsSync(path.join(TMP, "hello.txt.br"))) throw new Error("destination not written");
  });

  await test("brotli_decompress: round-trips back to original bytes", async () => {
    const r = await executeTool("brotli_decompress", { path: "hello.txt.br", destination: "hello.out.txt" });
    const original = fs.readFileSync(path.join(TMP, "hello.txt"));
    const restored = fs.readFileSync(path.join(TMP, "hello.out.txt"));
    assertEq(restored.equals(original), true, "round-trip content mismatch");
    assertEq(r.decompressedBytes, original.length);
  });

  await test("brotli_compress: respects explicit quality (0 vs 11)", async () => {
    writeSrc("lvl.txt", "abcabcabcabc".repeat(500));
    const r0  = await executeTool("brotli_compress", { path: "lvl.txt", destination: "q0.br", quality: 0 });
    const r11 = await executeTool("brotli_compress", { path: "lvl.txt", destination: "q11.br", quality: 11 });
    if (r11.compressedBytes > r0.compressedBytes) throw new Error("quality 11 should compress at least as well as quality 0");
  });

  await test("brotli_compress: outperforms gzip on highly repetitive text (sanity)", async () => {
    writeSrc("rep.txt", "the quick brown fox ".repeat(2000));
    const br = await executeTool("brotli_compress", { path: "rep.txt", destination: "rep.br" });
    const gz = zlib.gzipSync(fs.readFileSync(path.join(TMP, "rep.txt")));
    if (br.compressedBytes > gz.length) throw new Error(`expected brotli (${br.compressedBytes}) <= gzip (${gz.length}) on repetitive text`);
  });

  await test("brotli_compress: creates nested destination directories", async () => {
    writeSrc("nest-src.txt", "nested dir test");
    await executeTool("brotli_compress", { path: "nest-src.txt", destination: "a/b/c/nest.br" });
    if (!fs.existsSync(path.join(TMP, "a/b/c/nest.br"))) throw new Error("nested destination not created");
  });

  // ── Medium (boundary & parameter validation) ─────────────────────────
  await test("brotli_compress: missing 'path' -> -32602", async () => {
    await expectThrow(() => executeTool("brotli_compress", { destination: "x.br" }), -32602);
  });

  await test("brotli_compress: missing 'destination' -> -32602", async () => {
    await expectThrow(() => executeTool("brotli_compress", { path: "hello.txt" }), -32602);
  });

  await test("brotli_decompress: missing 'path' -> -32602", async () => {
    await expectThrow(() => executeTool("brotli_decompress", { destination: "x" }), -32602);
  });

  await test("brotli_compress: nonexistent source file -> clean error", async () => {
    await expectThrow(() => executeTool("brotli_compress", { path: "does-not-exist.txt", destination: "x.br" }), "cannot access");
  });

  await test("brotli_compress: quality out of range (12) -> clean error", async () => {
    writeSrc("range.txt", "x");
    await expectThrow(() => executeTool("brotli_compress", { path: "range.txt", destination: "range.br", quality: 12 }), "quality");
  });

  await test("brotli_compress: quality wrong type (string) -> clean error", async () => {
    await expectThrow(() => executeTool("brotli_compress", { path: "range.txt", destination: "range2.br", quality: "max" }), "quality");
  });

  await test("brotli_compress: source is a directory, not a file -> clean error", async () => {
    fs.mkdirSync(path.join(TMP, "adir"), { recursive: true });
    await expectThrow(() => executeTool("brotli_compress", { path: "adir", destination: "adir.br" }), "not a regular file");
  });

  // ── High (dependency-failure equivalent) ──────────────────────────────
  await test("brotli_decompress: corrupted/non-brotli source -> clean error, no crash", async () => {
    writeSrc("notbrotli.br", "this is plain text, not brotli data at all, hopefully long enough to be unambiguous");
    await expectThrow(() => executeTool("brotli_decompress", { path: "notbrotli.br", destination: "bad-out.txt" }), "not valid brotli data");
  });

  await test("brotli_decompress: truncated real brotli stream -> clean error, no crash", async () => {
    const real = zlib.brotliCompressSync(Buffer.from("a".repeat(5000)));
    fs.writeFileSync(path.join(TMP, "truncated.br"), real.subarray(0, real.length - 5));
    await expectThrow(() => executeTool("brotli_decompress", { path: "truncated.br", destination: "trunc-out.txt" }), "not valid brotli data");
  });

  // ── Critical (security / path traversal) ──────────────────────────────
  await test("brotli_compress: path traversal in 'path' rejected", async () => {
    await expectThrow(() => executeTool("brotli_compress", { path: "../../../../etc/passwd", destination: "x.br" }), "Access denied");
  });

  await test("brotli_compress: path traversal in 'destination' rejected", async () => {
    writeSrc("trav-src.txt", "data");
    await expectThrow(() => executeTool("brotli_compress", { path: "trav-src.txt", destination: "../../../../tmp/evil.br" }), "Access denied");
  });

  await test("brotli_decompress: path traversal in 'destination' rejected", async () => {
    await expectThrow(() => executeTool("brotli_decompress", { path: "hello.txt.br", destination: "../../evil-out.txt" }), "Access denied");
  });

  await test("brotli_compress: shell-injection-shaped filename treated as literal, not executed", async () => {
    writeSrc("safe.txt", "data");
    const r = await executeTool("brotli_compress", { path: "safe.txt", destination: "evil$(whoami);.br" });
    if (!fs.existsSync(path.join(TMP, "evil$(whoami);.br"))) throw new Error("literal filename not written as-is");
  });

  // ── Extreme (fuzzing, concurrency, large payloads) ─────────────────────
  await test("brotli_compress/decompress: large random-byte fuzz payload round-trips", async () => {
    const big = require("crypto").randomBytes(2_000_000); // 2MB incompressible random data
    fs.writeFileSync(path.join(TMP, "fuzz.bin"), big);
    await executeTool("brotli_compress", { path: "fuzz.bin", destination: "fuzz.bin.br", quality: 5 });
    await executeTool("brotli_decompress", { path: "fuzz.bin.br", destination: "fuzz.out.bin" });
    const restored = fs.readFileSync(path.join(TMP, "fuzz.out.bin"));
    if (!restored.equals(big)) throw new Error("large fuzz payload round-trip mismatch");
  });

  await test("brotli_compress: empty file (0 bytes) handled cleanly", async () => {
    writeSrc("empty.txt", "");
    const r = await executeTool("brotli_compress", { path: "empty.txt", destination: "empty.br" });
    assertEq(r.originalBytes, 0);
    assertEq(r.ratio, 0);
  });

  await test("concurrency: 10 parallel brotli_compress calls on distinct files, no cross-contamination", async () => {
    const jobs = [];
    for (let i = 0; i < 10; i++) {
      writeSrc(`c${i}.txt`, `content-${i}-`.repeat(1000));
      jobs.push(executeTool("brotli_compress", { path: `c${i}.txt`, destination: `c${i}.br`, quality: 4 }));
    }
    await Promise.all(jobs);
    for (let i = 0; i < 10; i++) {
      await executeTool("brotli_decompress", { path: `c${i}.br`, destination: `c${i}.out.txt` });
      const restored = fs.readFileSync(path.join(TMP, `c${i}.out.txt`), "utf8");
      if (restored !== `content-${i}-`.repeat(1000)) throw new Error(`cross-contamination detected at index ${i}`);
    }
  });

  console.log(`\n${counters.pass} passed, ${counters.fail} failed`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  process.exit(counters.fail > 0 ? 1 : 0);
})();
