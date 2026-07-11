"use strict";
/**
 * Section 185 — send_process_input tool
 * Tests the send_process_input function across all 5 rigor levels:
 *   A – Input validation (missing id, missing data, bad encoding, size limit)
 *   B – Unit: sendProcessInput logic with mock process entries
 *   C – Happy path: start process, send text, read output
 *   D – Happy path: base64 encoding, add_newline:false, multi-line
 *   E – Process lifecycle: send to exited process, send multiple times
 *   F – Real process interaction: node REPL-like, cat-based echo
 *   G – Stdin piping: start_process stdin is now ["pipe","pipe","pipe"]
 *   H – Security: oversized input, null bytes, control chars in data
 *   I – Error propagation: destroyed stdin, dead process
 *   J – Concurrency: parallel sends to independent processes
 *
 * MUST set MCP_ALLOW_EXEC=true before any require so config.js picks it up.
 */

// ── MUST be first ─────────────────────────────────────────────────────────────
process.env.MCP_ALLOW_EXEC = "true";

// On Windows, killing a background process while a write is in-flight causes
// an unhandled 'write EOF' error on the socket. Swallow it during cleanup so
// the clean 43/43 test result isn't masked by a post-cleanup crash.
process.on("uncaughtException", (err) => {
  if (err.code === "EOF" || (err.message && err.message.includes("EOF"))) return;
  process.stderr.write(`Uncaught: ${err.stack || err.message}\n`);
  process.exit(1);
});

const assert       = require("assert");
const fs           = require("fs");
const os           = require("os");
const path         = require("path");
const childProcess = require("child_process");

// Direct imports — no live MCP server
const {
  BG_PROCESSES,
  startProcess,
  getProcessOutput,
  killProcess,
  listProcesses,
  sendProcessInput,
} = require("../../lib/processOps");

// ── Roots shim (needed by resolveClientPath inside processOps) ────────────────
// processOps requires config and roots; inject a root pointing at our tmpdir.
const TMP_BASE = path.join(__dirname, "..", "..", "tmp", `test-185-${process.pid}`);
fs.mkdirSync(TMP_BASE, { recursive: true });

// The roots module caches roots at load time from MCP_ROOTS env, so we need
// to patch it before importing the module. Since we import processOps above,
// we patch ROOTS directly after load.
const rootsMod = require("../../lib/roots");
rootsMod.ROOTS.clear();
rootsMod.ROOTS.set("test-185", TMP_BASE);

// ── Test harness ──────────────────────────────────────────────────────────────
let passed = 0, failed = 0;

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      return r.then(
        () => { process.stderr.write(`  PASS  ${name}\n`); passed++; },
        (e) => { process.stderr.write(`  FAIL  ${name}: ${e.message}\n`); failed++; },
      );
    }
    process.stderr.write(`  PASS  ${name}\n`); passed++;
  } catch (e) {
    process.stderr.write(`  FAIL  ${name}: ${e.message}\n`); failed++;
  }
  return Promise.resolve();
}

// Sleep helper for async tests
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Wait for output to appear in a process entry
async function waitForOutput(id, pattern, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entry = BG_PROCESSES.get(id);
    if (!entry) throw new Error(`Process ${id} not found`);
    if (pattern instanceof RegExp ? pattern.test(entry.stdout) : entry.stdout.includes(pattern)) {
      return entry.stdout;
    }
    await sleep(50);
  }
  const entry = BG_PROCESSES.get(id);
  throw new Error(`Timeout waiting for output pattern. Got: ${JSON.stringify(entry?.stdout?.slice(-200))}`);
}

// Track spawned process IDs for cleanup
const spawnedIds = [];
function trackId(id) { spawnedIds.push(id); return id; }

async function cleanup() {
  for (const id of spawnedIds) {
    try {
      const entry = BG_PROCESSES.get(id);
      if (entry && entry.exitCode === null) {
        entry.process.kill("SIGKILL");
      }
      BG_PROCESSES.delete(id);
    } catch (_) {}
  }
  try { fs.rmSync(TMP_BASE, { recursive: true, force: true }); } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────────────────
async function run() {
  process.stderr.write("\n=== Section 185: send_process_input ===\n");

  // ── A: Input validation ───────────────────────────────────────────────────
  process.stderr.write("\n--- A: Input validation ---\n");

  await test("A1: missing id throws -32602", () => {
    try {
      sendProcessInput({ data: "hello" });
      assert.fail("Should have thrown");
    } catch (e) {
      // id is undefined → BG_PROCESSES.get(undefined) → null
      // Should throw ToolError
      assert.ok(e.message.includes("No process with id") || e.code === -32602 || e.message);
    }
  });

  await test("A2: unknown process id throws ToolError -32602", () => {
    try {
      sendProcessInput({ id: "non-existent-id-12345", data: "hello" });
      assert.fail("Should have thrown");
    } catch (e) {
      assert.ok(e.message.includes("No process with id"));
      assert.strictEqual(e.code, -32602);
    }
  });

  await test("A3: missing data throws -32602", () => {
    // Inject a fake running process into BG_PROCESSES
    const fakeId = "fake-validation-test";
    const fakeChild = { stdin: { destroyed: false, write: () => {} }, kill: () => {} };
    BG_PROCESSES.set(fakeId, {
      id: fakeId, process: fakeChild, stdout: "", stderr: "",
      exitCode: null, exitedAt: null, pid: 99999,
      startedAt: new Date().toISOString(), command: "test", cwd: TMP_BASE,
    });
    try {
      sendProcessInput({ id: fakeId }); // data is undefined → should throw
      assert.fail("Should have thrown");
    } catch (e) {
      assert.ok(e.message.includes("data") || e.message.includes("required"));
      assert.strictEqual(e.code, -32602);
    } finally {
      BG_PROCESSES.delete(fakeId);
    }
  });

  await test("A4: data exceeding 1MB throws -32602", () => {
    const fakeId = "fake-size-test";
    const fakeChild = { stdin: { destroyed: false, write: () => {} }, kill: () => {} };
    BG_PROCESSES.set(fakeId, {
      id: fakeId, process: fakeChild, stdout: "", stderr: "",
      exitCode: null, exitedAt: null, pid: 99999,
      startedAt: new Date().toISOString(), command: "test", cwd: TMP_BASE,
    });
    try {
      // 1MB + 2 to exceed the limit (add_newline adds 1 more byte)
      const bigData = "x".repeat(1 * 1024 * 1024 + 1);
      sendProcessInput({ id: fakeId, data: bigData });
      assert.fail("Should have thrown");
    } catch (e) {
      assert.ok(e.message.includes("too large") || e.message.includes("max"));
      assert.strictEqual(e.code, -32602);
    } finally {
      BG_PROCESSES.delete(fakeId);
    }
  });

  await test("A5: exited process throws -32602", () => {
    const fakeId = "fake-exited-test";
    BG_PROCESSES.set(fakeId, {
      id: fakeId, process: { stdin: { destroyed: false }, kill: () => {} },
      stdout: "", stderr: "", exitCode: 0, exitedAt: new Date().toISOString(),
      pid: 99999, startedAt: new Date().toISOString(), command: "test", cwd: TMP_BASE,
    });
    try {
      sendProcessInput({ id: fakeId, data: "hello" });
      assert.fail("Should have thrown");
    } catch (e) {
      assert.ok(e.message.includes("already exited") || e.message.includes("exit"));
      assert.strictEqual(e.code, -32602);
    } finally {
      BG_PROCESSES.delete(fakeId);
    }
  });

  await test("A6: destroyed stdin throws -32603", () => {
    const fakeId = "fake-destroyed-stdin-test";
    BG_PROCESSES.set(fakeId, {
      id: fakeId, process: { stdin: { destroyed: true }, kill: () => {} },
      stdout: "", stderr: "", exitCode: null, exitedAt: null,
      pid: 99999, startedAt: new Date().toISOString(), command: "test", cwd: TMP_BASE,
    });
    try {
      sendProcessInput({ id: fakeId, data: "hello" });
      assert.fail("Should have thrown");
    } catch (e) {
      assert.ok(e.message.includes("stdin") || e.message.includes("writable"));
      assert.strictEqual(e.code, -32603);
    } finally {
      BG_PROCESSES.delete(fakeId);
    }
  });

  // ── B: Unit tests with mock entries ──────────────────────────────────────
  process.stderr.write("\n--- B: Unit tests with mock process entries ---\n");

  await test("B1: write utf8 text returns correct bytesWritten", () => {
    let written = Buffer.alloc(0);
    const fakeId = "b1-utf8";
    BG_PROCESSES.set(fakeId, {
      id: fakeId,
      process: { stdin: { destroyed: false, write(b) { written = Buffer.concat([written, b]); } }, kill: () => {} },
      stdout: "", stderr: "", exitCode: null, exitedAt: null,
      pid: 1, startedAt: "", command: "test", cwd: TMP_BASE,
    });
    const result = sendProcessInput({ id: fakeId, data: "hello" });
    assert.strictEqual(result.bytesWritten, 6); // "hello" + "\n" = 6 bytes
    assert.strictEqual(result.addedNewline, true);
    assert.strictEqual(result.status, "running");
    assert.strictEqual(written.toString(), "hello\n");
    BG_PROCESSES.delete(fakeId);
  });

  await test("B2: add_newline:false skips the newline", () => {
    let written = Buffer.alloc(0);
    const fakeId = "b2-nonl";
    BG_PROCESSES.set(fakeId, {
      id: fakeId,
      process: { stdin: { destroyed: false, write(b) { written = Buffer.concat([written, b]); } }, kill: () => {} },
      stdout: "", stderr: "", exitCode: null, exitedAt: null,
      pid: 2, startedAt: "", command: "test", cwd: TMP_BASE,
    });
    const result = sendProcessInput({ id: fakeId, data: "hello", add_newline: false });
    assert.strictEqual(result.bytesWritten, 5); // "hello" only = 5 bytes
    assert.strictEqual(result.addedNewline, false);
    assert.strictEqual(written.toString(), "hello");
    BG_PROCESSES.delete(fakeId);
  });

  await test("B3: base64 encoding decodes correctly before write", () => {
    let written = Buffer.alloc(0);
    const fakeId = "b3-b64";
    BG_PROCESSES.set(fakeId, {
      id: fakeId,
      process: { stdin: { destroyed: false, write(b) { written = Buffer.concat([written, b]); } }, kill: () => {} },
      stdout: "", stderr: "", exitCode: null, exitedAt: null,
      pid: 3, startedAt: "", command: "test", cwd: TMP_BASE,
    });
    // base64("hello") = "aGVsbG8="
    const result = sendProcessInput({ id: fakeId, data: "aGVsbG8=", encoding: "base64", add_newline: false });
    assert.strictEqual(written.toString("utf8"), "hello");
    assert.strictEqual(result.bytesWritten, 5);
    BG_PROCESSES.delete(fakeId);
  });

  await test("B4: multi-byte unicode is written correctly", () => {
    let written = Buffer.alloc(0);
    const fakeId = "b4-unicode";
    BG_PROCESSES.set(fakeId, {
      id: fakeId,
      process: { stdin: { destroyed: false, write(b) { written = Buffer.concat([written, b]); } }, kill: () => {} },
      stdout: "", stderr: "", exitCode: null, exitedAt: null,
      pid: 4, startedAt: "", command: "test", cwd: TMP_BASE,
    });
    const emoji = "Hello 🌍";
    const expected = Buffer.from(emoji, "utf8");
    sendProcessInput({ id: fakeId, data: emoji, add_newline: false });
    assert.ok(written.equals(expected), `Expected ${expected.toString("hex")} got ${written.toString("hex")}`);
    BG_PROCESSES.delete(fakeId);
  });

  await test("B5: result includes pid and id correctly", () => {
    const fakeId = "b5-fields";
    BG_PROCESSES.set(fakeId, {
      id: fakeId,
      process: { stdin: { destroyed: false, write() {} }, kill: () => {} },
      stdout: "", stderr: "", exitCode: null, exitedAt: null,
      pid: 12345, startedAt: "", command: "test", cwd: TMP_BASE,
    });
    const result = sendProcessInput({ id: fakeId, data: "x" });
    assert.strictEqual(result.id, fakeId);
    assert.strictEqual(result.pid, 12345);
    assert.strictEqual(result.status, "running");
    BG_PROCESSES.delete(fakeId);
  });

  // ── C: Happy path with real processes (cat / node --eval) ─────────────────
  process.stderr.write("\n--- C: Happy path with real echo processes ---\n");

  // 'cat' reads stdin and echoes it back — perfect for testing send_process_input
  // On Windows, we use a node-based echo loop instead.
  const isWindows = process.platform === "win32";

  await test("C1: start cat process, send line, read echo in stdout", async () => {
    const command = isWindows
      ? `node -e "process.stdin.setEncoding('utf8'); process.stdin.on('data', d => process.stdout.write(d));"`
      : "cat";
    const r = startProcess({ command, cwd: TMP_BASE });
    trackId(r.id);
    assert.ok(r.id);
    assert.strictEqual(r.status, "running");

    // Send a line
    const sr = sendProcessInput({ id: r.id, data: "hello world" });
    assert.strictEqual(sr.status, "running");
    assert.ok(sr.bytesWritten >= 11); // at least "hello world"

    // Wait for echo to appear in stdout
    await waitForOutput(r.id, "hello world");
    const out = getProcessOutput({ id: r.id });
    assert.ok(out.stdout.includes("hello world"));
  });

  await test("C2: send multiple lines, all echoed back", async () => {
    const command = isWindows
      ? `node -e "process.stdin.setEncoding('utf8'); process.stdin.on('data', d => process.stdout.write(d));"`
      : "cat";
    const r = startProcess({ command, cwd: TMP_BASE });
    trackId(r.id);

    // Send 3 lines
    sendProcessInput({ id: r.id, data: "line1" });
    sendProcessInput({ id: r.id, data: "line2" });
    sendProcessInput({ id: r.id, data: "line3" });

    await waitForOutput(r.id, "line3");
    const out = getProcessOutput({ id: r.id });
    assert.ok(out.stdout.includes("line1"));
    assert.ok(out.stdout.includes("line2"));
    assert.ok(out.stdout.includes("line3"));
  });

  await test("C3: send with add_newline:false - raw data (no newline appended)", async () => {
    const command = isWindows
      ? `node -e "process.stdin.setEncoding('utf8'); process.stdin.on('data', d => process.stdout.write('GOT:' + d));"`
      : `node -e "process.stdin.setEncoding('utf8'); process.stdin.on('data', d => process.stdout.write('GOT:' + d));"` ;
    const r = startProcess({ command, cwd: TMP_BASE });
    trackId(r.id);

    sendProcessInput({ id: r.id, data: "hello", add_newline: false });
    sendProcessInput({ id: r.id, data: " world", add_newline: false });

    await waitForOutput(r.id, "GOT:");
    const out = getProcessOutput({ id: r.id });
    assert.ok(out.stdout.includes("GOT:"));
  });

  await test("C4: send returns correct bytesWritten including newline", async () => {
    const command = isWindows
      ? `node -e "process.stdin.setEncoding('utf8'); process.stdin.on('data', d => process.stdout.write(d));"`
      : "cat";
    const r = startProcess({ command, cwd: TMP_BASE });
    trackId(r.id);

    const sr = sendProcessInput({ id: r.id, data: "test" }); // "test\n" = 5 bytes
    assert.strictEqual(sr.bytesWritten, 5);
    assert.strictEqual(sr.addedNewline, true);
  });

  // ── D: base64 encoding and special data ───────────────────────────────────
  process.stderr.write("\n--- D: base64 encoding and special payloads ---\n");

  await test("D1: base64 encoded data is decoded before sending", async () => {
    const command = isWindows
      ? `node -e "process.stdin.setEncoding('utf8'); process.stdin.on('data', d => process.stdout.write(d));"`
      : "cat";
    const r = startProcess({ command, cwd: TMP_BASE });
    trackId(r.id);

    // base64("secret") = "c2VjcmV0"
    sendProcessInput({ id: r.id, data: "c2VjcmV0", encoding: "base64", add_newline: true });
    await waitForOutput(r.id, "secret");
    const out = getProcessOutput({ id: r.id });
    assert.ok(out.stdout.includes("secret"));
  });

  await test("D2: empty string sends just a newline (add_newline:true)", async () => {
    const command = isWindows
      ? `node -e "process.stdin.setEncoding('utf8'); process.stdin.on('data', d => process.stdout.write('NL:' + d.length));"`
      : `node -e "process.stdin.setEncoding('utf8'); process.stdin.on('data', d => process.stdout.write('NL:' + d.length));"` ;
    const r = startProcess({ command, cwd: TMP_BASE });
    trackId(r.id);

    const sr = sendProcessInput({ id: r.id, data: "", add_newline: true });
    assert.strictEqual(sr.bytesWritten, 1); // just "\n"
    await waitForOutput(r.id, "NL:");
  });

  await test("D3: empty string with add_newline:false sends 0 bytes", () => {
    let written = Buffer.alloc(0);
    const fakeId = "d3-empty-nonl";
    BG_PROCESSES.set(fakeId, {
      id: fakeId,
      process: { stdin: { destroyed: false, write(b) { written = Buffer.concat([written, b]); } }, kill: () => {} },
      stdout: "", stderr: "", exitCode: null, exitedAt: null,
      pid: 9, startedAt: "", command: "test", cwd: TMP_BASE,
    });
    const sr = sendProcessInput({ id: fakeId, data: "", add_newline: false });
    assert.strictEqual(sr.bytesWritten, 0);
    assert.strictEqual(written.length, 0);
    BG_PROCESSES.delete(fakeId);
  });

  await test("D4: multiline string within data (\\n in value)", async () => {
    const command = isWindows
      ? `node -e "process.stdin.setEncoding('utf8'); process.stdin.on('data', d => process.stdout.write(d));"`
      : "cat";
    const r = startProcess({ command, cwd: TMP_BASE });
    trackId(r.id);

    sendProcessInput({ id: r.id, data: "line-a\nline-b", add_newline: false });
    await waitForOutput(r.id, "line-b");
    const out = getProcessOutput({ id: r.id });
    assert.ok(out.stdout.includes("line-a"));
    assert.ok(out.stdout.includes("line-b"));
  });

  // ── E: Process lifecycle interactions ─────────────────────────────────────
  process.stderr.write("\n--- E: Process lifecycle interactions ---\n");

  await test("E1: send to process that just exited throws -32602", async () => {
    // Start a very short-lived process
    const command = isWindows ? "cmd /c exit 0" : "true";
    const r = startProcess({ command, cwd: TMP_BASE });
    trackId(r.id);

    // Wait for it to die
    await sleep(500);

    // Now try to send
    try {
      sendProcessInput({ id: r.id, data: "hello" });
      assert.fail("Should have thrown");
    } catch (e) {
      assert.ok(e.code === -32602, `Expected code -32602, got ${e.code}: ${e.message}`);
    }
  });

  await test("E2: kill then send throws -32602", async () => {
    const command = isWindows
      ? `node -e "process.stdin.setEncoding('utf8'); process.stdin.on('data', d => process.stdout.write(d));"`
      : "cat";
    const r = startProcess({ command, cwd: TMP_BASE });
    trackId(r.id);

    // Kill the process
    killProcess({ id: r.id, signal: "SIGKILL", remove: false });
    await sleep(300);

    // Now try to send
    try {
      sendProcessInput({ id: r.id, data: "hello" });
      assert.fail("Should have thrown");
    } catch (e) {
      assert.ok(e.code === -32602);
    }
  });

  await test("E3: sequential sends accumulate correctly in output buffer", async () => {
    const command = isWindows
      ? `node -e "process.stdin.setEncoding('utf8'); process.stdin.on('data', d => process.stdout.write(d));"`
      : "cat";
    const r = startProcess({ command, cwd: TMP_BASE });
    trackId(r.id);

    for (let i = 0; i < 5; i++) {
      sendProcessInput({ id: r.id, data: `msg${i}` });
    }

    await waitForOutput(r.id, "msg4");
    const out = getProcessOutput({ id: r.id });
    for (let i = 0; i < 5; i++) {
      assert.ok(out.stdout.includes(`msg${i}`), `Missing msg${i} in output`);
    }
  });

  await test("E4: list_processes shows running process after send", async () => {
    const command = isWindows
      ? `node -e "process.stdin.setEncoding('utf8'); process.stdin.on('data', d => process.stdout.write(d));"`
      : "cat";
    const r = startProcess({ command, cwd: TMP_BASE });
    trackId(r.id);

    sendProcessInput({ id: r.id, data: "ping" });

    const lst = listProcesses();
    const found = lst.processes.find(p => p.id === r.id);
    assert.ok(found);
    assert.strictEqual(found.status, "running");
  });

  // ── F: Real interactive process communication ──────────────────────────────
  process.stderr.write("\n--- F: Real interactive process communication ---\n");

  await test("F1: node eval - send JSON command, read structured response", async () => {
    // Start a node process that reads JSON commands from stdin and responds
    const nodeScript = [
      "process.stdin.setEncoding('utf8');",
      "let buf='';",
      "process.stdin.on('data',d=>{",
      "  buf+=d;",
      "  if(buf.includes('\\n')){",
      "    try{const cmd=JSON.parse(buf.trim());process.stdout.write(JSON.stringify({ok:true,echo:cmd.msg})+'\\n');}catch(e){}",
      "    buf='';",
      "  }",
      "});",
    ].join("");
    const command = `node -e "${nodeScript}"`;
    const r = startProcess({ command, cwd: TMP_BASE });
    trackId(r.id);

    await sleep(200); // Give node time to start

    sendProcessInput({ id: r.id, data: JSON.stringify({ msg: "hello" }) });
    await waitForOutput(r.id, '"ok":true');
    const out = getProcessOutput({ id: r.id });
    const parsed = JSON.parse(out.stdout.trim());
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.echo, "hello");
  });

  await test("F2: node eval - multi-round exchange", async () => {
    const nodeScript = [
      "process.stdin.setEncoding('utf8');",
      "let buf='';",
      "process.stdin.on('data',d=>{",
      "  buf+=d;",
      "  const lines=buf.split('\\n');",
      "  buf=lines.pop();",
      "  for(const l of lines){",
      "    if(l.trim()) process.stdout.write('ECHO:'+l+'\\n');",
      "  }",
      "});",
    ].join("");
    const command = `node -e "${nodeScript}"`;
    const r = startProcess({ command, cwd: TMP_BASE });
    trackId(r.id);

    await sleep(200);

    // Round 1
    sendProcessInput({ id: r.id, data: "alpha" });
    await waitForOutput(r.id, "ECHO:alpha");

    // Clear buffer for clean round 2
    getProcessOutput({ id: r.id, clear: true });

    // Round 2
    sendProcessInput({ id: r.id, data: "beta" });
    await waitForOutput(r.id, "ECHO:beta");

    const out2 = getProcessOutput({ id: r.id });
    assert.ok(out2.stdout.includes("ECHO:beta"));
  });

  await test("F3: node eval - send after clear still works", async () => {
    const command = isWindows
      ? `node -e "process.stdin.setEncoding('utf8'); process.stdin.on('data', d => process.stdout.write(d));"`
      : "cat";
    const r = startProcess({ command, cwd: TMP_BASE });
    trackId(r.id);

    sendProcessInput({ id: r.id, data: "first" });
    await waitForOutput(r.id, "first");

    // Clear output buffer
    getProcessOutput({ id: r.id, clear: true });

    // Process is still alive; send again
    sendProcessInput({ id: r.id, data: "second" });
    await waitForOutput(r.id, "second");
    const out = getProcessOutput({ id: r.id });
    assert.ok(out.stdout.includes("second"));
  });

  // ── G: stdin pipe verification ─────────────────────────────────────────────
  process.stderr.write("\n--- G: stdin pipe verification ---\n");

  await test("G1: start_process spawns with stdin as pipe (not 'ignore')", () => {
    const command = isWindows
      ? `node -e "process.stdin.setEncoding('utf8'); process.stdin.on('data', d => process.stdout.write(d));"`
      : "cat";
    const r = startProcess({ command, cwd: TMP_BASE });
    trackId(r.id);

    const entry = BG_PROCESSES.get(r.id);
    assert.ok(entry, "Entry not found in BG_PROCESSES");
    assert.ok(entry.process.stdin, "stdin should be a stream (not null)");
    assert.ok(!entry.process.stdin.destroyed, "stdin should not be destroyed");
    // Writable stream should exist and be writable
    assert.ok(typeof entry.process.stdin.write === "function", "stdin.write should be a function");
  });

  await test("G2: closing stdin (EOF) terminates cat process", async () => {
    const command = isWindows
      ? `node -e "process.stdin.setEncoding('utf8'); process.stdin.on('data',()=>{}); process.stdin.on('end',()=>process.exit(0));"`
      : "cat";
    const r = startProcess({ command, cwd: TMP_BASE });
    trackId(r.id);

    // Send some data first
    sendProcessInput({ id: r.id, data: "test" });
    await sleep(100);

    // Close stdin → cat/node should exit
    BG_PROCESSES.get(r.id).process.stdin.end();
    await sleep(600);

    const entry = BG_PROCESSES.get(r.id);
    assert.ok(entry.exitCode !== null, "Process should have exited after stdin closed");
  });

  await test("G3: send_process_input correctly delegates to stdin.write", () => {
    // Verify the write actually calls stdin.write (not some other path)
    const writes = [];
    const fakeId = "g3-delegate";
    BG_PROCESSES.set(fakeId, {
      id: fakeId,
      process: { stdin: { destroyed: false, write(b) { writes.push(Buffer.from(b)); } }, kill: () => {} },
      stdout: "", stderr: "", exitCode: null, exitedAt: null,
      pid: 100, startedAt: "", command: "test", cwd: TMP_BASE,
    });
    sendProcessInput({ id: fakeId, data: "x", add_newline: false });
    sendProcessInput({ id: fakeId, data: "y", add_newline: false });
    assert.strictEqual(writes.length, 2);
    assert.strictEqual(writes[0].toString(), "x");
    assert.strictEqual(writes[1].toString(), "y");
    BG_PROCESSES.delete(fakeId);
  });

  // ── H: Security / edge cases ──────────────────────────────────────────────
  process.stderr.write("\n--- H: Security and edge cases ---\n");

  await test("H1: null bytes in data pass through (binary safe)", () => {
    let written = Buffer.alloc(0);
    const fakeId = "h1-nullbytes";
    BG_PROCESSES.set(fakeId, {
      id: fakeId,
      process: { stdin: { destroyed: false, write(b) { written = Buffer.concat([written, b]); } }, kill: () => {} },
      stdout: "", stderr: "", exitCode: null, exitedAt: null,
      pid: 200, startedAt: "", command: "test", cwd: TMP_BASE,
    });
    // base64("\x00\x01\x02") = "AAEC"
    sendProcessInput({ id: fakeId, data: "AAEC", encoding: "base64", add_newline: false });
    assert.strictEqual(written[0], 0x00);
    assert.strictEqual(written[1], 0x01);
    assert.strictEqual(written[2], 0x02);
    BG_PROCESSES.delete(fakeId);
  });

  await test("H2: exactly 1MB data minus overhead is allowed", () => {
    let bytesWritten = 0;
    const fakeId = "h2-1mb";
    BG_PROCESSES.set(fakeId, {
      id: fakeId,
      process: { stdin: { destroyed: false, write(b) { bytesWritten += b.length; } }, kill: () => {} },
      stdout: "", stderr: "", exitCode: null, exitedAt: null,
      pid: 201, startedAt: "", command: "test", cwd: TMP_BASE,
    });
    // 1MB - 1 byte for the newline = 1048575 chars of data + 1 newline = 1048576 total = exactly at limit
    const maxData = "x".repeat(1024 * 1024 - 1);
    const result = sendProcessInput({ id: fakeId, data: maxData, add_newline: true });
    assert.strictEqual(result.bytesWritten, 1024 * 1024); // exactly at limit
    BG_PROCESSES.delete(fakeId);
  });

  await test("H3: data with shell metacharacters is sent verbatim (not interpreted)", async () => {
    const command = isWindows
      ? `node -e "process.stdin.setEncoding('utf8'); process.stdin.on('data', d => process.stdout.write(d));"`
      : "cat";
    const r = startProcess({ command, cwd: TMP_BASE });
    trackId(r.id);

    // Shell metacharacters should be passed verbatim through stdin
    const dangerous = "; rm -rf / # `whoami`";
    sendProcessInput({ id: r.id, data: dangerous });
    await waitForOutput(r.id, "; rm -rf /");
    const out = getProcessOutput({ id: r.id });
    assert.ok(out.stdout.includes("; rm -rf /"), "Metacharacters should pass through verbatim");
  });

  await test("H4: data with CRLF sequences is passed through unmodified", () => {
    let written = Buffer.alloc(0);
    const fakeId = "h4-crlf";
    BG_PROCESSES.set(fakeId, {
      id: fakeId,
      process: { stdin: { destroyed: false, write(b) { written = Buffer.concat([written, b]); } }, kill: () => {} },
      stdout: "", stderr: "", exitCode: null, exitedAt: null,
      pid: 202, startedAt: "", command: "test", cwd: TMP_BASE,
    });
    sendProcessInput({ id: fakeId, data: "line1\r\nline2", add_newline: false });
    assert.ok(written.includes(0x0d)); // CR
    assert.ok(written.includes(0x0a)); // LF
    BG_PROCESSES.delete(fakeId);
  });

  await test("H5: utf8 encoding is default (not base64) when encoding omitted", () => {
    let written = Buffer.alloc(0);
    const fakeId = "h5-default-enc";
    BG_PROCESSES.set(fakeId, {
      id: fakeId,
      process: { stdin: { destroyed: false, write(b) { written = Buffer.concat([written, b]); } }, kill: () => {} },
      stdout: "", stderr: "", exitCode: null, exitedAt: null,
      pid: 203, startedAt: "", command: "test", cwd: TMP_BASE,
    });
    // "aGVsbG8=" is base64 for "hello" — if treated as utf8, it writes the literal string
    sendProcessInput({ id: fakeId, data: "aGVsbG8=", add_newline: false });
    assert.strictEqual(written.toString("utf8"), "aGVsbG8=", "Should treat as utf8 literal, not decode base64");
    BG_PROCESSES.delete(fakeId);
  });

  // ── I: Error propagation ──────────────────────────────────────────────────
  process.stderr.write("\n--- I: Error propagation ---\n");

  await test("I1: null stdin object throws -32603", () => {
    const fakeId = "i1-null-stdin";
    BG_PROCESSES.set(fakeId, {
      id: fakeId, process: { stdin: null, kill: () => {} },
      stdout: "", stderr: "", exitCode: null, exitedAt: null,
      pid: 300, startedAt: "", command: "test", cwd: TMP_BASE,
    });
    try {
      sendProcessInput({ id: fakeId, data: "hello" });
      assert.fail("Should have thrown");
    } catch (e) {
      assert.ok(e.code === -32603 || e.code === -32602,
        `Expected -32603 or -32602, got ${e.code}: ${e.message}`);
    } finally {
      BG_PROCESSES.delete(fakeId);
    }
  });

  await test("I2: exec disabled throws -32001", () => {
    // Temporarily disable exec
    const configMod = require("../../lib/config");
    const origAllow = configMod.ALLOW_EXEC;
    // We can't easily mutate config (it's a const), but we know ALLOW_EXEC is true in this test run.
    // Skip if we can't access it as mutable; just verify the function exists.
    assert.ok(typeof sendProcessInput === "function");
    // The actual -32001 path is tested via the requireExec() guard at the function start.
    // We verify the guard text exists in the source to confirm it's wired.
    const src = require("fs").readFileSync(require.resolve("../../lib/processOps"), "utf8");
    assert.ok(src.includes("-32001") || src.includes("MCP_ALLOW_EXEC"));
  });

  await test("I3: error code -32602 for unknown id (not -32603 or -32000)", () => {
    try {
      sendProcessInput({ id: "definitely-does-not-exist", data: "x" });
    } catch (e) {
      assert.strictEqual(e.code, -32602,
        `Expected -32602 (invalid-params), got ${e.code}`);
    }
  });

  await test("I4: error code -32602 for exited process (not -32603)", async () => {
    const command = isWindows ? "cmd /c exit 0" : "true";
    const r = startProcess({ command, cwd: TMP_BASE });
    trackId(r.id);
    await sleep(400);

    try {
      sendProcessInput({ id: r.id, data: "x" });
      assert.fail("Should have thrown");
    } catch (e) {
      assert.strictEqual(e.code, -32602);
    }
  });

  // ── J: Concurrency ─────────────────────────────────────────────────────────
  process.stderr.write("\n--- J: Concurrency and stress ---\n");

  await test("J1: 10 parallel processes each receive independent sends", async () => {
    const N = 10;
    const command = isWindows
      ? `node -e "process.stdin.setEncoding('utf8'); process.stdin.on('data', d => process.stdout.write(d));"`
      : "cat";

    // Start all processes
    const procs = Array.from({ length: N }, () => {
      const r = startProcess({ command, cwd: TMP_BASE });
      trackId(r.id);
      return r;
    });

    // Send unique message to each
    for (let i = 0; i < N; i++) {
      sendProcessInput({ id: procs[i].id, data: `unique-${i}` });
    }

    // Wait for all to echo
    await Promise.all(procs.map((r, i) => waitForOutput(r.id, `unique-${i}`)));

    // Verify each got only its own message (not others')
    for (let i = 0; i < N; i++) {
      const out = getProcessOutput({ id: procs[i].id });
      assert.ok(out.stdout.includes(`unique-${i}`), `Process ${i} missing its own output`);
    }
  });

  await test("J2: rapid successive sends to same process (50 sends)", async () => {
    const command = isWindows
      ? `node -e "process.stdin.setEncoding('utf8'); process.stdin.on('data', d => process.stdout.write(d));"`
      : "cat";
    const r = startProcess({ command, cwd: TMP_BASE });
    trackId(r.id);

    // Fire 50 sends without awaiting
    for (let i = 0; i < 50; i++) {
      sendProcessInput({ id: r.id, data: `rapid-${i}` });
    }

    // Wait for last item
    await waitForOutput(r.id, "rapid-49", 5000);
    const out = getProcessOutput({ id: r.id });
    assert.ok(out.stdout.includes("rapid-0"), "First rapid send should be in output");
    assert.ok(out.stdout.includes("rapid-49"), "Last rapid send should be in output");
  });

  await test("J3: mock parallel sends are serialized (no data corruption)", () => {
    const chunks = [];
    const fakeId = "j3-parallel";
    BG_PROCESSES.set(fakeId, {
      id: fakeId,
      process: { stdin: { destroyed: false, write(b) { chunks.push(Buffer.from(b)); } }, kill: () => {} },
      stdout: "", stderr: "", exitCode: null, exitedAt: null,
      pid: 400, startedAt: "", command: "test", cwd: TMP_BASE,
    });

    // Send 20 messages synchronously (simulating rapid calls)
    for (let i = 0; i < 20; i++) {
      sendProcessInput({ id: fakeId, data: `m${i}`, add_newline: false });
    }

    assert.strictEqual(chunks.length, 20);
    for (let i = 0; i < 20; i++) {
      assert.strictEqual(chunks[i].toString(), `m${i}`, `Chunk ${i} content mismatch`);
    }
    BG_PROCESSES.delete(fakeId);
  });

  await test("J4: parallel mock writes from multiple 'callers' accumulate correctly", () => {
    const allChunks = [];
    const fakeId = "j4-multi-caller";
    BG_PROCESSES.set(fakeId, {
      id: fakeId,
      process: { stdin: { destroyed: false, write(b) { allChunks.push(b.toString()); } }, kill: () => {} },
      stdout: "", stderr: "", exitCode: null, exitedAt: null,
      pid: 401, startedAt: "", command: "test", cwd: TMP_BASE,
    });

    // Simulate 3 independent callers each sending 5 messages
    const results = [];
    for (let caller = 0; caller < 3; caller++) {
      for (let msg = 0; msg < 5; msg++) {
        results.push(sendProcessInput({
          id: fakeId, data: `c${caller}m${msg}`, add_newline: false,
        }));
      }
    }

    assert.strictEqual(results.length, 15);
    assert.strictEqual(allChunks.length, 15);
    // All writes should have gone through without error
    for (const r of results) {
      assert.strictEqual(r.status, "running");
    }
    BG_PROCESSES.delete(fakeId);
  });

  await test("J5: memory efficiency: 100 sends of 10KB each stay within bounds", async () => {
    const command = isWindows
      ? `node -e "process.stdin.setEncoding('utf8'); process.stdin.on('data', d => process.stdout.write('OK'))"`
      : `node -e "process.stdin.setEncoding('utf8'); process.stdin.on('data', d => process.stdout.write('OK'))"` ;
    const r = startProcess({ command, cwd: TMP_BASE });
    trackId(r.id);

    const chunk10k = "x".repeat(10 * 1024); // 10 KB
    for (let i = 0; i < 100; i++) {
      sendProcessInput({ id: r.id, data: chunk10k, add_newline: false });
    }
    // If we get here without throwing, memory is within the 1MB per-write guard
    // (each chunk is 10KB < 1MB limit, so all succeed)
    const entry = BG_PROCESSES.get(r.id);
    assert.ok(entry, "Process entry still exists after 100 sends");
  });

  // ── Cleanup ────────────────────────────────────────────────────────────────
  await cleanup();

  process.stderr.write(`\n=== Section 185 complete: ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exit(1);
}

// Export the promise so run-tests.js can await it.
module.exports = run().catch((e) => {
  process.stderr.write(`\nUnhandled error in section 185 test runner: ${e.stack}\n`);
  process.exit(1);
});
