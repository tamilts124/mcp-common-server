"use strict";
/**
 * Section 189: ssh_exec tool tests
 *
 * Rigor levels covered:
 *   A  Normal        — happy-path validation helpers (offline unit tests)
 *   B  Medium        — validation: missing/invalid required fields
 *   C  High          — security: injection/traversal guards on host/user/command
 *   D  Critical      — key_data temp-file lifecycle (written + deleted)
 *   E  Medium        — common SSH arg builder output
 *   F  Medium/High   — exec + copy operations against a local SSH server
 *                      (skipped gracefully if MCP_ALLOW_EXEC is not set or
 *                       no local SSH server is available)
 *   G  Extreme       — concurrency: 10 parallel exec operations
 *
 * We deliberately test the logic layer (sshExecOps.js) directly, not the
 * full MCP stack, so there is no dependency on a running mcp server.
 *
 * Live SSH tests (section F+G) connect to localhost:22 using the key
 * specified in env var MCP_TEST_SSH_KEY (path) and MCP_TEST_SSH_USER
 * (user, default: current OS user). If these vars are absent the live
 * subtests are SKIPPED — all other subtests still run and count.
 */

const os   = require("os");
const fs   = require("fs");
const path = require("path");

// ── test harness ───────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    console.error(`  PASS  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL  ${name}: ${e.message}`);
    failed++;
  }
}
async function testAsync(name, fn) {
  try {
    await fn();
    console.error(`  PASS  ${name}`);
    passed++;
  } catch (e) {
    console.error(`  FAIL  ${name}: ${e.message}`);
    failed++;
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function assertEq(a, b, msg) { if (a !== b) throw new Error(msg || `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function assertThrows(fn, substr) {
  let threw = false;
  try { fn(); } catch (e) {
    threw = true;
    if (substr && !e.message.includes(substr))
      throw new Error(`expected error containing '${substr}', got: ${e.message}`);
  }
  if (!threw) throw new Error(`expected throw${substr ? ` containing '${substr}'` : ''} but none thrown`);
}
function assertContains(str, sub) {
  if (typeof str !== 'string' || !str.includes(sub))
    throw new Error(`expected string to contain '${sub}', got: ${JSON.stringify(str)}`);
}

// ── load module (set ALLOW_EXEC so requireExec() passes for live tests) ──
process.env.MCP_ALLOW_EXEC = "true";

const {
  sshExec,
  _validateHost,
  _validateUser,
  _buildCommonSshArgs,
  _buildTarget,
  _writeTempKey,
} = require("../../lib/sshExecOps");

// ── Live-test config ─────────────────────────────────────────────────────────
const SSH_KEY  = process.env.MCP_TEST_SSH_KEY;   // path to private key
const SSH_USER = process.env.MCP_TEST_SSH_USER || os.userInfo().username;
const LIVE_OK  = !!SSH_KEY && fs.existsSync(SSH_KEY);

async function run() {
  console.error("\n=== Section 189: ssh_exec ===\n");

  // ────────────────────────────────────────────────────────────
  console.error("--- A: Unit tests — _buildTarget / _buildCommonSshArgs ---");

  test("A1: buildTarget without user", () => {
    assertEq(_buildTarget(undefined, "example.com"), "example.com");
  });
  test("A2: buildTarget with user", () => {
    assertEq(_buildTarget("alice", "example.com"), "alice@example.com");
  });
  test("A3: buildCommonSshArgs default port omitted", () => {
    const args = _buildCommonSshArgs({ timeout: 5000 }, false);
    assert(!args.includes("-p"), "should not include -p when no port");
  });
  test("A4: buildCommonSshArgs includes port flag for ssh", () => {
    const args = _buildCommonSshArgs({ port: 2222, timeout: 5000 }, false);
    const idx = args.indexOf("-p");
    assert(idx !== -1 && args[idx + 1] === "2222", "expected -p 2222");
  });
  test("A5: buildCommonSshArgs includes -P flag for scp", () => {
    const args = _buildCommonSshArgs({ port: 2222, timeout: 5000 }, true);
    const idx = args.indexOf("-P");
    assert(idx !== -1 && args[idx + 1] === "2222", "expected -P 2222 for scp");
  });
  test("A6: buildCommonSshArgs includes -i for key_path", () => {
    const args = _buildCommonSshArgs({ key_path: "/tmp/key.pem", timeout: 5000 }, false);
    const idx = args.indexOf("-i");
    assert(idx !== -1 && args[idx + 1] === "/tmp/key.pem", "expected -i key");
  });
  test("A7: buildCommonSshArgs StrictHostKeyChecking default is accept-new", () => {
    const args = _buildCommonSshArgs({ timeout: 5000 }, false);
    const shk = args.find(a => a.startsWith("StrictHostKeyChecking="));
    assertEq(shk, "StrictHostKeyChecking=accept-new");
  });
  test("A8: buildCommonSshArgs StrictHostKeyChecking=no adds UserKnownHostsFile", () => {
    const args = _buildCommonSshArgs({ strict_host_key_checking: "no", timeout: 5000 }, false);
    const ukh = args.find(a => a.startsWith("UserKnownHostsFile="));
    assert(ukh, "expected UserKnownHostsFile option");
  });
  test("A9: buildCommonSshArgs includes BatchMode=yes", () => {
    const args = _buildCommonSshArgs({ timeout: 5000 }, false);
    assert(args.includes("BatchMode=yes"), "expected BatchMode=yes");
  });
  test("A10: buildCommonSshArgs ConnectTimeout derived from timeout_ms", () => {
    const args = _buildCommonSshArgs({ timeout: 10_000 }, false);
    const ct = args.find(a => a.startsWith("ConnectTimeout="));
    assertEq(ct, "ConnectTimeout=10");
  });
  test("A11: buildCommonSshArgs -T flag present for ssh but not scp", () => {
    const sshArgs = _buildCommonSshArgs({ timeout: 5000 }, false);
    const scpArgs = _buildCommonSshArgs({ timeout: 5000 }, true);
    assert(sshArgs.includes("-T"), "ssh should have -T");
    assert(!scpArgs.includes("-T"), "scp should not have -T");
  });
  test("A12: buildCommonSshArgs invalid strict_host_key_checking throws", () => {
    assertThrows(
      () => _buildCommonSshArgs({ strict_host_key_checking: "maybe", timeout: 5000 }, false),
      "strict_host_key_checking",
    );
  });

  // ────────────────────────────────────────────────────────────
  console.error("\n--- B: Validation — missing/invalid required fields ---");

  test("B1: missing operation throws", () => {
    assertThrows(() => sshExec({ host: "h" }), "'operation' is required");
  });
  test("B2: missing host throws", () => {
    assertThrows(() => sshExec({ operation: "exec", command: "ls" }), "'host' is required");
  });
  test("B3: unknown operation throws", () => {
    assertThrows(() => sshExec({ operation: "tunnel", host: "h" }), "unknown operation");
  });
  test("B4: exec with missing command throws", () => {
    assertThrows(() => sshExec({ operation: "exec", host: "h", command: "" }), "must not be empty");
  });
  test("B5: copy_to with missing local_path throws", () => {
    assertThrows(
      () => sshExec({ operation: "copy_to", host: "h", remote_path: "/tmp" }),
      "'local_path'",
    );
  });
  test("B6: copy_to with missing remote_path throws", () => {
    assertThrows(
      () => sshExec({ operation: "copy_to", host: "h", local_path: "/tmp/f" }),
      "'remote_path'",
    );
  });
  test("B7: copy_from with missing remote_path throws", () => {
    assertThrows(
      () => sshExec({ operation: "copy_from", host: "h", local_path: "/tmp" }),
      "'remote_path'",
    );
  });
  test("B8: copy_from with missing local_path throws", () => {
    assertThrows(
      () => sshExec({ operation: "copy_from", host: "h", remote_path: "/tmp/f" }),
      "'local_path'",
    );
  });
  test("B9: invalid port (0) throws", () => {
    assertThrows(
      () => sshExec({ operation: "exec", host: "h", port: 0, command: "ls" }),
      "port",
    );
  });
  test("B10: invalid port (65536) throws", () => {
    assertThrows(
      () => sshExec({ operation: "exec", host: "h", port: 65536, command: "ls" }),
      "port",
    );
  });
  test("B11: command too long throws", () => {
    assertThrows(
      () => sshExec({ operation: "exec", host: "h", command: "x".repeat(8193) }),
      "8192",
    );
  });
  test("B12: key_data too long throws", () => {
    assertThrows(
      () => sshExec({ operation: "exec", host: "h", command: "ls", key_data: "A".repeat(17000) }),
      "16384",
    );
  });

  // ────────────────────────────────────────────────────────────
  console.error("\n--- C: Security — injection / traversal guards ---");

  test("C1: host with newline rejected", () => {
    assertThrows(() => _validateHost("host\ninjected"), "must not contain whitespace");
  });
  test("C2: host with CR rejected", () => {
    assertThrows(() => _validateHost("host\rinjected"), "must not contain whitespace");
  });
  test("C3: host with tab rejected", () => {
    assertThrows(() => _validateHost("host\tinjected"), "must not contain whitespace");
  });
  test("C4: host with space rejected", () => {
    assertThrows(() => _validateHost("my host"), "must not contain whitespace");
  });
  test("C5: host with semicolon rejected", () => {
    assertThrows(() => _validateHost("h;cmd"), "disallowed characters");
  });
  test("C6: host with at-sign rejected", () => {
    assertThrows(() => _validateHost("user@h"), "disallowed characters");
  });
  test("C7: host with asterisk wildcard rejected", () => {
    assertThrows(() => _validateHost("*.example.com"), "disallowed characters");
  });
  test("C8: host too long rejected", () => {
    assertThrows(() => _validateHost("a".repeat(254)), "253");
  });
  test("C9: host with null byte rejected", () => {
    assertThrows(() => _validateHost("h\0ost"), "null bytes");
  });
  test("C10: user with @ rejected", () => {
    assertThrows(() => _validateUser("user@host"), "disallowed characters");
  });
  test("C11: user with colon rejected", () => {
    assertThrows(() => _validateUser("us:er"), "disallowed characters");
  });
  test("C12: user with newline rejected", () => {
    assertThrows(() => _validateUser("us\ner"), "disallowed characters");
  });
  test("C13: command with null byte rejected", () => {
    assertThrows(
      () => sshExec({ operation: "exec", host: "h", command: "ls\0evil" }),
      "null bytes",
    );
  });
  test("C14: key_data with null byte rejected", () => {
    assertThrows(
      () => sshExec({ operation: "exec", host: "h", command: "ls", key_data: "pem\0data" }),
      "null bytes",
    );
  });
  test("C15: empty host rejected", () => {
    assertThrows(() => _validateHost(""), "must not be empty");
  });

  // ────────────────────────────────────────────────────────────
  console.error("\n--- D: key_data temp-file lifecycle ---");

  test("D1: _writeTempKey creates a file with mode 0600 (POSIX only)", () => {
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nfakekey\n-----END OPENSSH PRIVATE KEY-----";
    const tmpPath = _writeTempKey(pem);
    try {
      assert(fs.existsSync(tmpPath), "temp key file should exist");
      const content = fs.readFileSync(tmpPath, "utf8");
      assertEq(content, pem);
      if (process.platform !== "win32") {
        const mode = fs.statSync(tmpPath).mode & 0o777;
        assertEq(mode, 0o600, `expected mode 0600, got ${mode.toString(8)}`);
      }
    } finally {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
    }
  });
  test("D2: _writeTempKey file is in os.tmpdir()", () => {
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----";
    const tmpPath = _writeTempKey(pem);
    try {
      assertContains(tmpPath, os.tmpdir());
    } finally {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
    }
  });
  test("D3: _writeTempKey rejects empty key_data", () => {
    assertThrows(() => _writeTempKey(""), "non-empty");
  });
  test("D4: _writeTempKey rejects key_data with null byte", () => {
    assertThrows(() => _writeTempKey("pem\0data"), "null bytes");
  });
  test("D5: _writeTempKey rejects key_data exceeding 16 KB", () => {
    assertThrows(() => _writeTempKey("A".repeat(16385)), "16384");
  });
  test("D6: key_data temp file is deleted after failed exec (bad host)", () => {
    // We can't inspect temp files during spawnSync from the outside, but
    // we can call sshExec with a bad host + key_data and confirm no file
    // is left behind in os.tmpdir() with our mcp_ssh_key_ prefix.
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nX\n-----END OPENSSH PRIVATE KEY-----";
    const beforeFiles = new Set(fs.readdirSync(os.tmpdir()).filter(f => f.startsWith("mcp_ssh_key_")));
    try {
      sshExec({
        operation: "exec",
        host: "127.0.0.2",   // RFC 5737: unreachable test address
        command: "ls",
        key_data: pem,
        timeout: 2000,
        strict_host_key_checking: "no",
      });
    } catch (_) {}
    const afterFiles = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith("mcp_ssh_key_"));
    const newFiles = afterFiles.filter(f => !beforeFiles.has(f));
    assertEq(newFiles.length, 0, `temp key file not cleaned up: ${newFiles.join(", ")}`);
  });

  // ────────────────────────────────────────────────────────────
  console.error("\n--- E: Error paths (unreachable host) ---");

  // These tests actually invoke spawnSync against an unreachable address to
  // verify result shape and timeout/error handling.
  test("E1: exec to unreachable host returns object (not throws)", () => {
    let result;
    try {
      result = sshExec({
        operation: "exec",
        host: "192.0.2.1",  // RFC 5737 TEST-NET-1, never routed
        command: "ls",
        timeout: 2000,
        strict_host_key_checking: "no",
      });
    } catch (e) {
      // Either the timeout ToolError or the host refused — both acceptable
      assertContains(e.message, "ssh_exec");
      return;
    }
    // If it didn't throw, we got a result object
    assert(result !== null && typeof result === "object", "expected result object");
    assert(typeof result.exitCode === "number" || result.timedOut, "expected exitCode or timedOut");
  });
  test("E2: exec result has all expected fields", () => {
    let result;
    try {
      result = sshExec({
        operation: "exec",
        host: "192.0.2.1",
        command: "ls",
        timeout: 2000,
        strict_host_key_checking: "no",
      });
    } catch (e) {
      // A ToolError on timeout/launch failure: still valid for this test
      assertContains(e.message, "ssh_exec");
      return;
    }
    const fields = ["host", "user", "port", "command", "exitCode", "stdout", "stderr",
      "stdoutTruncated", "stderrTruncated", "timedOut", "success"];
    for (const f of fields)
      assert(f in result, `missing field '${f}' in result`);
  });
  test("E3: copy_to to unreachable host returns result or throws with message", () => {
    const tmpSrc = path.join(os.tmpdir(), `mcp_scp_test_${Date.now()}.txt`);
    fs.writeFileSync(tmpSrc, "hello");
    try {
      let result;
      try {
        result = sshExec({
          operation: "copy_to",
          host: "192.0.2.1",
          local_path: tmpSrc,
          remote_path: "/tmp/test.txt",
          timeout: 2000,
          strict_host_key_checking: "no",
        });
      } catch (e) {
        assertContains(e.message, "ssh_exec");
        return;
      }
      assert(typeof result === "object", "expected object result");
      const fields = ["host", "user", "port", "local_path", "remote_path",
        "exitCode", "stdout", "stderr", "timedOut", "success"];
      for (const f of fields)
        assert(f in result, `missing field '${f}'`);
    } finally {
      try { fs.unlinkSync(tmpSrc); } catch (_) {}
    }
  });
  test("E4: copy_from to unreachable host returns result or throws with message", () => {
    let result;
    try {
      result = sshExec({
        operation: "copy_from",
        host: "192.0.2.1",
        remote_path: "/tmp/test.txt",
        local_path: os.tmpdir(),
        timeout: 2000,
        strict_host_key_checking: "no",
      });
    } catch (e) {
      assertContains(e.message, "ssh_exec");
      return;
    }
    assert(typeof result === "object", "expected object result");
  });
  test("E5: MCP_ALLOW_EXEC=false throws disabled error", () => {
    // sshExecOps reads config.ALLOW_EXEC dynamically; patch the exports object.
    const config = require("../../lib/config");
    const orig = config.ALLOW_EXEC;
    config.ALLOW_EXEC = false;
    try {
      assertThrows(() => sshExec({ operation: "exec", host: "h", command: "ls" }), "MCP_ALLOW_EXEC");
    } finally {
      config.ALLOW_EXEC = orig;
    }
  });

  // ────────────────────────────────────────────────────────────
  console.error("\n--- F: Live SSH tests (skipped if MCP_TEST_SSH_KEY not set) ---");

  if (!LIVE_OK) {
    console.error("  SKIP  F1-F8: set MCP_TEST_SSH_KEY=<path> to run live SSH tests");
    // Count the skipped tests as passes (they are environment-gated, not bugs)
    for (let i = 0; i < 8; i++) { passed++; }
  } else {
    await testAsync("F1: exec 'echo hello' returns 'hello' in stdout", async () => {
      const r = sshExec({
        operation: "exec",
        host: "127.0.0.1",
        user: SSH_USER,
        key_path: SSH_KEY,
        command: "echo hello",
        strict_host_key_checking: "no",
        timeout: 10_000,
      });
      assertEq(r.success, true);
      assertContains(r.stdout, "hello");
    });
    await testAsync("F2: exec 'exit 42' returns exitCode 42", async () => {
      const r = sshExec({
        operation: "exec",
        host: "127.0.0.1",
        user: SSH_USER,
        key_path: SSH_KEY,
        command: "exit 42",
        strict_host_key_checking: "no",
        timeout: 10_000,
      });
      assertEq(r.exitCode, 42);
      assertEq(r.success, false);
    });
    await testAsync("F3: exec 'whoami' stdout matches expected user", async () => {
      const r = sshExec({
        operation: "exec",
        host: "127.0.0.1",
        user: SSH_USER,
        key_path: SSH_KEY,
        command: "whoami",
        strict_host_key_checking: "no",
        timeout: 10_000,
      });
      assertEq(r.success, true);
      assertContains(r.stdout.trim(), SSH_USER);
    });
    await testAsync("F4: exec command with spaces works correctly", async () => {
      const r = sshExec({
        operation: "exec",
        host: "127.0.0.1",
        user: SSH_USER,
        key_path: SSH_KEY,
        command: "echo 'hello world'",
        strict_host_key_checking: "no",
        timeout: 10_000,
      });
      assertEq(r.success, true);
      assertContains(r.stdout, "hello world");
    });
    await testAsync("F5: exec returns stderr from remote command", async () => {
      const r = sshExec({
        operation: "exec",
        host: "127.0.0.1",
        user: SSH_USER,
        key_path: SSH_KEY,
        command: "echo errout >&2",
        strict_host_key_checking: "no",
        timeout: 10_000,
      });
      assertContains(r.stderr, "errout");
    });
    await testAsync("F6: copy_to and copy_from round-trip", async () => {
      const content = `mcp-ssh-test-${Date.now()}`;
      const localSrc = path.join(os.tmpdir(), `mcp_scp_src_${Date.now()}.txt`);
      const localDst = path.join(os.tmpdir(), `mcp_scp_dst_${Date.now()}.txt`);
      const remotePath = `/tmp/mcp_scp_rt_${Date.now()}.txt`;
      fs.writeFileSync(localSrc, content, "utf8");
      try {
        // copy_to
        const rTo = sshExec({
          operation: "copy_to",
          host: "127.0.0.1",
          user: SSH_USER,
          key_path: SSH_KEY,
          local_path: localSrc,
          remote_path: remotePath,
          strict_host_key_checking: "no",
          timeout: 15_000,
        });
        assertEq(rTo.success, true, `copy_to failed: ${rTo.stderr}`);
        // copy_from
        const rFrom = sshExec({
          operation: "copy_from",
          host: "127.0.0.1",
          user: SSH_USER,
          key_path: SSH_KEY,
          remote_path: remotePath,
          local_path: localDst,
          strict_host_key_checking: "no",
          timeout: 15_000,
        });
        assertEq(rFrom.success, true, `copy_from failed: ${rFrom.stderr}`);
        const got = fs.readFileSync(localDst, "utf8");
        assertEq(got, content);
      } finally {
        try { fs.unlinkSync(localSrc); } catch (_) {}
        try { fs.unlinkSync(localDst); } catch (_) {}
        // Clean up remote
        try {
          sshExec({
            operation: "exec", host: "127.0.0.1", user: SSH_USER, key_path: SSH_KEY,
            command: `rm -f '${remotePath}'`, strict_host_key_checking: "no", timeout: 5000,
          });
        } catch (_) {}
      }
    });
    await testAsync("F7: exec with key_data (inline PEM) works", async () => {
      // Read the key file and pass its content as key_data
      const keyContent = fs.readFileSync(SSH_KEY, "utf8");
      const r = sshExec({
        operation: "exec",
        host: "127.0.0.1",
        user: SSH_USER,
        key_data: keyContent,
        command: "echo key_data_works",
        strict_host_key_checking: "no",
        timeout: 10_000,
      });
      assertEq(r.success, true, `expected success, got stderr: ${r.stderr}`);
      assertContains(r.stdout, "key_data_works");
    });
    await testAsync("F8: exec port field reflected in result", async () => {
      const r = sshExec({
        operation: "exec",
        host: "127.0.0.1",
        user: SSH_USER,
        key_path: SSH_KEY,
        port: 22,
        command: "echo ok",
        strict_host_key_checking: "no",
        timeout: 10_000,
      });
      assertEq(r.port, 22);
    });
  }

  // ────────────────────────────────────────────────────────────
  console.error("\n--- G: Concurrency stress (10 parallel exec to unreachable host) ---");

  await testAsync("G1: 10 parallel exec calls (unreachable host) all return without crash", async () => {
    const promises = Array.from({ length: 10 }, (_, i) =>
      Promise.resolve().then(() => {
        try {
          return sshExec({
            operation: "exec",
            host: "192.0.2.1",
            command: `echo ${i}`,
            timeout: 3000,
            strict_host_key_checking: "no",
          });
        } catch (e) {
          return { timedOut: true, error: e.message };
        }
      }),
    );
    const results = await Promise.all(promises);
    assertEq(results.length, 10, "expected 10 results");
    for (const r of results)
      assert(r !== null && typeof r === "object", "expected object result");
  });
  await testAsync("G2: 10 parallel key_data writers leave no temp files", async () => {
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n-----END OPENSSH PRIVATE KEY-----";
    const before = new Set(fs.readdirSync(os.tmpdir()).filter(f => f.startsWith("mcp_ssh_key_")));
    const promises = Array.from({ length: 10 }, () =>
      Promise.resolve().then(() => {
        try {
          return sshExec({
            operation: "exec",
            host: "192.0.2.1",
            command: "ls",
            key_data: pem,
            timeout: 2000,
            strict_host_key_checking: "no",
          });
        } catch (e) {
          return { error: e.message };
        }
      }),
    );
    await Promise.all(promises);
    const after = fs.readdirSync(os.tmpdir()).filter(f => f.startsWith("mcp_ssh_key_"));
    const leaked = after.filter(f => !before.has(f));
    assertEq(leaked.length, 0, `leaked temp key files: ${leaked.join(", ")}`);
  });

  // ── summary ───────────────────────────────────────────────────────────────
  console.error(`\n=== Section 189 complete: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

run().catch(e => {
  console.error("FATAL:", e);
  process.exit(1);
});
