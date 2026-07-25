"use strict";
/**
 * Section 295 - gh_client tests
 * Five rigor levels:
 *  A  Pure logic tests (no spawn)
 *  B  Validation / error-path tests
 *  C  Mock-spawn tests (patch child_process via require.cache)
 *  D  Security / injection tests
 *  E  Edge-case tests
 *
 * Mocking strategy: patch require.cache for child_process so that
 * ghClientOps.js (which does `const { spawnSync } = require('child_process')`)
 * picks up our mock. We delete and re-require ghClientOps between mocks.
 */

const assert  = require("assert");
const path    = require("path");
const Module  = require("module");

const OPS_PATH = require.resolve("../../lib/ghClientOps");
const CP_PATH  = require.resolve("child_process");

const ORIG_CP = require("child_process");

let passed = 0;
let failed = 0;
const errors = [];

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      return r
        .then(() => { passed++; process.stderr.write(`  \u2713 ${name}\n`); })
        .catch(err => { failed++; errors.push({ name, err }); process.stderr.write(`  \u2717 ${name}: ${err.message}\n`); });
    }
    passed++;
    process.stderr.write(`  \u2713 ${name}\n`);
  } catch (err) {
    failed++;
    errors.push({ name, err });
    process.stderr.write(`  \u2717 ${name}: ${err.message}\n`);
  }
}

/** Replace child_process in module cache with a fake, re-require ghClientOps. */
function withMockSpawn(spawnFn, cb) {
  // Save originals
  const origCpCache  = require.cache[CP_PATH];
  const origOpsCache = require.cache[OPS_PATH];

  // Install fake child_process
  require.cache[CP_PATH] = {
    id: CP_PATH, filename: CP_PATH, loaded: true,
    exports: Object.assign({}, ORIG_CP, { spawnSync: spawnFn }),
    parent: null, children: [], paths: [],
  };
  // Force re-require of ops module
  delete require.cache[OPS_PATH];
  const { ghRun } = require(OPS_PATH);

  try {
    return cb(ghRun);
  } finally {
    // Restore
    require.cache[CP_PATH]  = origCpCache;
    require.cache[OPS_PATH] = origOpsCache;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// A – Pure logic tests (token missing, empty args)
// ─────────────────────────────────────────────────────────────────────────────

process.stderr.write("\nA – Pure logic tests\n");

test("A01 ghRun returns error when GH_TOKEN not set", () => {
  const saved = process.env.GH_TOKEN;
  delete process.env.GH_TOKEN;
  // Re-require fresh copy without token
  delete require.cache[OPS_PATH];
  const { ghRun } = require(OPS_PATH);
  try {
    const r = ghRun({ args_str: "repo list" });
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes("GH_TOKEN"), `Expected GH_TOKEN mention, got: ${r.error}`);
  } finally {
    if (saved !== undefined) process.env.GH_TOKEN = saved;
    delete require.cache[OPS_PATH];
  }
});

test("A02 ghRun returns error when args_str is empty string", () => {
  withMockSpawn(() => ({ stdout: "", stderr: "", status: 0 }), ghRun => {
    const saved = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "ghp_test";
    try {
      const r = ghRun({ args_str: "" });
      assert.strictEqual(r.ok, false);
      assert.ok(r.error.includes("args_str is empty"));
    } finally {
      if (saved !== undefined) process.env.GH_TOKEN = saved;
      else delete process.env.GH_TOKEN;
    }
  });
});

test("A03 ghRun returns error when args_str is whitespace only", () => {
  withMockSpawn(() => ({ stdout: "", stderr: "", status: 0 }), ghRun => {
    const saved = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "ghp_test";
    try {
      const r = ghRun({ args_str: "   " });
      assert.strictEqual(r.ok, false);
      assert.ok(r.error.includes("args_str is empty"));
    } finally {
      if (saved !== undefined) process.env.GH_TOKEN = saved;
      else delete process.env.GH_TOKEN;
    }
  });
});

test("A04 ghRun returns error when gh CLI not found (ENOENT)", () => {
  withMockSpawn(() => ({ error: { code: "ENOENT" }, stdout: "", stderr: "", status: null }), ghRun => {
    const saved = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "ghp_test";
    try {
      const r = ghRun({ args_str: "repo list" });
      assert.strictEqual(r.ok, false);
      assert.ok(r.error.includes("gh CLI not found"), `Expected 'gh CLI not found', got: ${r.error}`);
    } finally {
      if (saved !== undefined) process.env.GH_TOKEN = saved;
      else delete process.env.GH_TOKEN;
    }
  });
});

test("A05 ghRun returns error when command times out (ETIMEDOUT)", () => {
  withMockSpawn(() => ({ error: { code: "ETIMEDOUT" }, stdout: "", stderr: "", status: null }), ghRun => {
    const saved = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "ghp_test";
    try {
      const r = ghRun({ args_str: "repo list" });
      assert.strictEqual(r.ok, false);
      assert.ok(r.error.includes("timed out"), `Expected 'timed out', got: ${r.error}`);
    } finally {
      if (saved !== undefined) process.env.GH_TOKEN = saved;
      else delete process.env.GH_TOKEN;
    }
  });
});

test("A06 ghRun returns error for generic spawn error", () => {
  withMockSpawn(() => ({ error: new Error("some spawn error"), stdout: "", stderr: "", status: null }), ghRun => {
    const saved = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "ghp_test";
    try {
      const r = ghRun({ args_str: "repo list" });
      assert.strictEqual(r.ok, false);
      assert.ok(r.error.includes("some spawn error"), `got: ${r.error}`);
    } finally {
      if (saved !== undefined) process.env.GH_TOKEN = saved;
      else delete process.env.GH_TOKEN;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B – Validation tests (timeout clamping, env vars)
// ─────────────────────────────────────────────────────────────────────────────

process.stderr.write("\nB – Validation tests\n");

test("B01 ghRun with undefined args_str treated as empty", () => {
  withMockSpawn(() => ({ stdout: "", stderr: "", status: 0 }), ghRun => {
    const saved = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "ghp_test";
    try {
      const r = ghRun({ args_str: undefined });
      assert.strictEqual(r.ok, false);
      assert.ok(r.error.includes("args_str is empty"));
    } finally {
      if (saved !== undefined) process.env.GH_TOKEN = saved;
      else delete process.env.GH_TOKEN;
    }
  });
});

test("B02 timeout_ms is clamped to minimum 1000", () => {
  let capturedTimeout;
  withMockSpawn((_cmd, _argv, opts) => { capturedTimeout = opts.timeout; return { stdout: "ok", stderr: "", status: 0 }; }, ghRun => {
    const saved = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "ghp_test";
    try {
      ghRun({ args_str: "repo list", timeout_ms: 500 });
      assert.strictEqual(capturedTimeout, 1000);
    } finally {
      if (saved !== undefined) process.env.GH_TOKEN = saved;
      else delete process.env.GH_TOKEN;
    }
  });
});

test("B03 timeout_ms is clamped to maximum 120000", () => {
  let capturedTimeout;
  withMockSpawn((_cmd, _argv, opts) => { capturedTimeout = opts.timeout; return { stdout: "ok", stderr: "", status: 0 }; }, ghRun => {
    const saved = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "ghp_test";
    try {
      ghRun({ args_str: "repo list", timeout_ms: 9999999 });
      assert.strictEqual(capturedTimeout, 120000);
    } finally {
      if (saved !== undefined) process.env.GH_TOKEN = saved;
      else delete process.env.GH_TOKEN;
    }
  });
});

test("B04 default timeout_ms is 30000", () => {
  let capturedTimeout;
  withMockSpawn((_cmd, _argv, opts) => { capturedTimeout = opts.timeout; return { stdout: "ok", stderr: "", status: 0 }; }, ghRun => {
    const saved = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "ghp_test";
    try {
      ghRun({ args_str: "repo list" });
      assert.strictEqual(capturedTimeout, 30000);
    } finally {
      if (saved !== undefined) process.env.GH_TOKEN = saved;
      else delete process.env.GH_TOKEN;
    }
  });
});

test("B05 GH_TOKEN is passed in env to spawnSync", () => {
  let capturedEnv;
  withMockSpawn((_cmd, _argv, opts) => { capturedEnv = opts.env; return { stdout: "ok", stderr: "", status: 0 }; }, ghRun => {
    const saved = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "ghp_mytoken";
    try {
      ghRun({ args_str: "repo list" });
      assert.strictEqual(capturedEnv.GH_TOKEN, "ghp_mytoken");
    } finally {
      if (saved !== undefined) process.env.GH_TOKEN = saved;
      else delete process.env.GH_TOKEN;
    }
  });
});

test("B06 NO_COLOR=1 and GH_PROMPT_DISABLED=1 are set in env", () => {
  let capturedEnv;
  withMockSpawn((_cmd, _argv, opts) => { capturedEnv = opts.env; return { stdout: "ok", stderr: "", status: 0 }; }, ghRun => {
    const saved = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "ghp_test";
    try {
      ghRun({ args_str: "repo list" });
      assert.strictEqual(capturedEnv.NO_COLOR, "1");
      assert.strictEqual(capturedEnv.GH_PROMPT_DISABLED, "1");
    } finally {
      if (saved !== undefined) process.env.GH_TOKEN = saved;
      else delete process.env.GH_TOKEN;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C – Mock-spawn tests (result shape, stdout/stderr trimming)
// ─────────────────────────────────────────────────────────────────────────────

process.stderr.write("\nC – Mock-spawn tests\n");

test("C01 successful command returns ok:true with exit_code 0", () => {
  withMockSpawn(() => ({ stdout: "repo1\nrepo2", stderr: "", status: 0 }), ghRun => {
    const saved = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "ghp_test";
    try {
      const r = ghRun({ args_str: "repo list" });
      assert.strictEqual(r.ok, true);
      assert.strictEqual(r.exit_code, 0);
      assert.strictEqual(r.stdout, "repo1\nrepo2");
      assert.strictEqual(r.stderr, null);
    } finally {
      if (saved !== undefined) process.env.GH_TOKEN = saved;
      else delete process.env.GH_TOKEN;
    }
  });
});

test("C02 failed command (exit_code 1) returns ok:false", () => {
  withMockSpawn(() => ({ stdout: "", stderr: "error: Not Found", status: 1 }), ghRun => {
    const saved = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "ghp_test";
    try {
      const r = ghRun({ args_str: "repo view nonexistent" });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.exit_code, 1);
      assert.strictEqual(r.stderr, "error: Not Found");
      assert.strictEqual(r.stdout, null);
    } finally {
      if (saved !== undefined) process.env.GH_TOKEN = saved;
      else delete process.env.GH_TOKEN;
    }
  });
});

test("C03 command field is reconstructed from argv tokens", () => {
  let capturedArgv;
  withMockSpawn((_cmd, argv) => { capturedArgv = argv; return { stdout: "ok", stderr: "", status: 0 }; }, ghRun => {
    const saved = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "ghp_test";
    try {
      const r = ghRun({ args_str: "issue create --title Bug --body Details" });
      assert.strictEqual(r.command, "gh issue create --title Bug --body Details");
      assert.deepStrictEqual(capturedArgv, ["issue", "create", "--title", "Bug", "--body", "Details"]);
    } finally {
      if (saved !== undefined) process.env.GH_TOKEN = saved;
      else delete process.env.GH_TOKEN;
    }
  });
});

test("C04 double-quoted arguments are parsed as single tokens", () => {
  let capturedArgv;
  withMockSpawn((_cmd, argv) => { capturedArgv = argv; return { stdout: "ok", stderr: "", status: 0 }; }, ghRun => {
    const saved = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "ghp_test";
    try {
      ghRun({ args_str: 'issue create --title "My Bug Report" --body "See attached"' });
      assert.ok(capturedArgv.includes("My Bug Report"), `Expected 'My Bug Report' as single token, got: ${JSON.stringify(capturedArgv)}`);
      assert.ok(capturedArgv.includes("See attached"));
    } finally {
      if (saved !== undefined) process.env.GH_TOKEN = saved;
      else delete process.env.GH_TOKEN;
    }
  });
});

test("C05 single-quoted arguments are parsed as single tokens", () => {
  let capturedArgv;
  withMockSpawn((_cmd, argv) => { capturedArgv = argv; return { stdout: "ok", stderr: "", status: 0 }; }, ghRun => {
    const saved = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "ghp_test";
    try {
      ghRun({ args_str: "repo create 'my new repo' --public" });
      assert.ok(capturedArgv.includes("my new repo"), `Expected 'my new repo' as single token, got: ${JSON.stringify(capturedArgv)}`);
    } finally {
      if (saved !== undefined) process.env.GH_TOKEN = saved;
      else delete process.env.GH_TOKEN;
    }
  });
});

test("C06 stdout and stderr are trimmed", () => {
  withMockSpawn(() => ({ stdout: "  output with spaces  ", stderr: "  warning  ", status: 0 }), ghRun => {
    const saved = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "ghp_test";
    try {
      const r = ghRun({ args_str: "repo list" });
      assert.strictEqual(r.stdout, "output with spaces");
      assert.strictEqual(r.stderr, "warning");
    } finally {
      if (saved !== undefined) process.env.GH_TOKEN = saved;
      else delete process.env.GH_TOKEN;
    }
  });
});

test("C07 empty stdout/stderr return null", () => {
  withMockSpawn(() => ({ stdout: "", stderr: "", status: 0 }), ghRun => {
    const saved = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "ghp_test";
    try {
      const r = ghRun({ args_str: "repo delete old-repo --yes" });
      assert.strictEqual(r.stdout, null);
      assert.strictEqual(r.stderr, null);
    } finally {
      if (saved !== undefined) process.env.GH_TOKEN = saved;
      else delete process.env.GH_TOKEN;
    }
  });
});

test("C08 null status is returned as exit_code -1 and ok:false", () => {
  withMockSpawn(() => ({ stdout: "", stderr: "", status: null }), ghRun => {
    const saved = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "ghp_test";
    try {
      const r = ghRun({ args_str: "repo list" });
      assert.strictEqual(r.exit_code, -1);
      assert.strictEqual(r.ok, false);
    } finally {
      if (saved !== undefined) process.env.GH_TOKEN = saved;
      else delete process.env.GH_TOKEN;
    }
  });
});

test("C09 gh is invoked as the command (not shell)", () => {
  let capturedCmd;
  withMockSpawn((cmd) => { capturedCmd = cmd; return { stdout: "ok", stderr: "", status: 0 }; }, ghRun => {
    const saved = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "ghp_test";
    try {
      ghRun({ args_str: "auth status" });
      assert.strictEqual(capturedCmd, "gh");
    } finally {
      if (saved !== undefined) process.env.GH_TOKEN = saved;
      else delete process.env.GH_TOKEN;
    }
  });
});

test("C10 custom cwd is passed to spawnSync", () => {
  let capturedCwd;
  withMockSpawn((_cmd, _argv, opts) => { capturedCwd = opts.cwd; return { stdout: "ok", stderr: "", status: 0 }; }, ghRun => {
    const saved = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "ghp_test";
    try {
      ghRun({ args_str: "repo list", cwd: "D:\\MyProject" });
      assert.strictEqual(capturedCwd, "D:\\MyProject");
    } finally {
      if (saved !== undefined) process.env.GH_TOKEN = saved;
      else delete process.env.GH_TOKEN;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D – Security / injection tests
// ─────────────────────────────────────────────────────────────────────────────

process.stderr.write("\nD – Security / injection tests\n");

test("D01 shell metacharacters are argv tokens (not shell-interpreted)", () => {
  let capturedArgv;
  withMockSpawn((_cmd, argv) => { capturedArgv = argv; return { stdout: "ok", stderr: "", status: 0 }; }, ghRun => {
    const saved = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "ghp_test";
    try {
      ghRun({ args_str: "repo create test && rm -rf /" });
      assert.ok(capturedArgv.includes("&&"), "&& should be a literal token");
      assert.ok(capturedArgv.includes("rm"), "rm should be a literal token");
    } finally {
      if (saved !== undefined) process.env.GH_TOKEN = saved;
      else delete process.env.GH_TOKEN;
    }
  });
});

test("D02 semicolon is passed as argv token, not shell-separated", () => {
  let capturedArgv;
  withMockSpawn((_cmd, argv) => { capturedArgv = argv; return { stdout: "ok", stderr: "", status: 0 }; }, ghRun => {
    const saved = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "ghp_test";
    try {
      ghRun({ args_str: "repo list; echo hacked" });
      const hasListSemi = capturedArgv.some(t => t === "list;" || t === ";");
      assert.ok(hasListSemi || capturedArgv.includes(";"), `semicolon should be literal, got: ${JSON.stringify(capturedArgv)}`);
    } finally {
      if (saved !== undefined) process.env.GH_TOKEN = saved;
      else delete process.env.GH_TOKEN;
    }
  });
});

test("D03 pipe character is a literal argv token", () => {
  let capturedArgv;
  withMockSpawn((_cmd, argv) => { capturedArgv = argv; return { stdout: "ok", stderr: "", status: 0 }; }, ghRun => {
    const saved = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "ghp_test";
    try {
      ghRun({ args_str: "repo list | cat /etc/passwd" });
      assert.ok(capturedArgv.includes("|"), `| should be a literal argv token, got: ${JSON.stringify(capturedArgv)}`);
    } finally {
      if (saved !== undefined) process.env.GH_TOKEN = saved;
      else delete process.env.GH_TOKEN;
    }
  });
});

test("D04 GH_TOKEN is not leaked in ENOENT error message", () => {
  withMockSpawn(() => ({ error: { code: "ENOENT" }, stdout: "", stderr: "", status: null }), ghRun => {
    const saved = process.env.GH_TOKEN;
    const secretToken = "ghp_SUPERSECRETTOKEN12345";
    process.env.GH_TOKEN = secretToken;
    try {
      const r = ghRun({ args_str: "repo list" });
      assert.strictEqual(r.ok, false);
      assert.ok(!r.error.includes(secretToken), `Token should not appear in error: ${r.error}`);
    } finally {
      if (saved !== undefined) process.env.GH_TOKEN = saved;
      else delete process.env.GH_TOKEN;
    }
  });
});

test("D05 GH_TOKEN is not included in the returned command string", () => {
  withMockSpawn(() => ({ stdout: "ok", stderr: "", status: 0 }), ghRun => {
    const saved = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "ghp_SECRETTOKEN";
    try {
      const r = ghRun({ args_str: "repo list" });
      assert.ok(!r.command.includes("ghp_SECRETTOKEN"), `Token should not appear in command: ${r.command}`);
    } finally {
      if (saved !== undefined) process.env.GH_TOKEN = saved;
      else delete process.env.GH_TOKEN;
    }
  });
});

test("D06 windowsHide:true is set in spawn options", () => {
  let capturedOpts;
  withMockSpawn((_cmd, _argv, opts) => { capturedOpts = opts; return { stdout: "ok", stderr: "", status: 0 }; }, ghRun => {
    const saved = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "ghp_test";
    try {
      ghRun({ args_str: "repo list" });
      assert.strictEqual(capturedOpts.windowsHide, true);
    } finally {
      if (saved !== undefined) process.env.GH_TOKEN = saved;
      else delete process.env.GH_TOKEN;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E – Edge-case tests
// ─────────────────────────────────────────────────────────────────────────────

process.stderr.write("\nE – Edge-case tests\n");

test("E01 many tokens in args_str are all passed correctly", () => {
  let capturedArgv;
  withMockSpawn((_cmd, argv) => { capturedArgv = argv; return { stdout: "ok", stderr: "", status: 0 }; }, ghRun => {
    const saved = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "ghp_test";
    try {
      ghRun({ args_str: "pr create --title Fix --body Desc --base main --head feature --label bug --reviewer alice" });
      assert.ok(capturedArgv.length >= 12, `Expected 12+ tokens, got ${capturedArgv.length}`);
      assert.strictEqual(capturedArgv[0], "pr");
      assert.strictEqual(capturedArgv[1], "create");
    } finally {
      if (saved !== undefined) process.env.GH_TOKEN = saved;
      else delete process.env.GH_TOKEN;
    }
  });
});

test("E02 tabs in args_str are treated as whitespace", () => {
  let capturedArgv;
  withMockSpawn((_cmd, argv) => { capturedArgv = argv; return { stdout: "ok", stderr: "", status: 0 }; }, ghRun => {
    const saved = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "ghp_test";
    try {
      ghRun({ args_str: "repo\tlist" });
      assert.deepStrictEqual(capturedArgv, ["repo", "list"]);
    } finally {
      if (saved !== undefined) process.env.GH_TOKEN = saved;
      else delete process.env.GH_TOKEN;
    }
  });
});

test("E03 multiple consecutive spaces are collapsed between tokens", () => {
  let capturedArgv;
  withMockSpawn((_cmd, argv) => { capturedArgv = argv; return { stdout: "ok", stderr: "", status: 0 }; }, ghRun => {
    const saved = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "ghp_test";
    try {
      ghRun({ args_str: "repo   list" });
      assert.deepStrictEqual(capturedArgv, ["repo", "list"]);
    } finally {
      if (saved !== undefined) process.env.GH_TOKEN = saved;
      else delete process.env.GH_TOKEN;
    }
  });
});

test("E04 successful result includes all expected keys", () => {
  withMockSpawn(() => ({ stdout: "output", stderr: "", status: 0 }), ghRun => {
    const saved = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "ghp_test";
    try {
      const r = ghRun({ args_str: "repo list" });
      assert.ok("ok"        in r, "missing ok");
      assert.ok("exit_code" in r, "missing exit_code");
      assert.ok("stdout"    in r, "missing stdout");
      assert.ok("stderr"    in r, "missing stderr");
      assert.ok("command"   in r, "missing command");
    } finally {
      if (saved !== undefined) process.env.GH_TOKEN = saved;
      else delete process.env.GH_TOKEN;
    }
  });
});

test("E05 error result has ok and error keys (no exit_code)", () => {
  const saved = process.env.GH_TOKEN;
  delete process.env.GH_TOKEN;
  delete require.cache[OPS_PATH];
  const { ghRun } = require(OPS_PATH);
  try {
    const r = ghRun({ args_str: "repo list" });
    assert.ok("ok"    in r, "missing ok");
    assert.ok("error" in r, "missing error");
    assert.ok(!("exit_code" in r), "exit_code should not be present on token error");
  } finally {
    if (saved !== undefined) process.env.GH_TOKEN = saved;
    delete require.cache[OPS_PATH];
  }
});

test("E06 encoding is set to utf8 in spawn options", () => {
  let capturedOpts;
  withMockSpawn((_cmd, _argv, opts) => { capturedOpts = opts; return { stdout: "ok", stderr: "", status: 0 }; }, ghRun => {
    const saved = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "ghp_test";
    try {
      ghRun({ args_str: "repo list" });
      assert.strictEqual(capturedOpts.encoding, "utf8");
    } finally {
      if (saved !== undefined) process.env.GH_TOKEN = saved;
      else delete process.env.GH_TOKEN;
    }
  });
});

test("E07 maxBuffer is set to 4 MB in spawn options", () => {
  let capturedOpts;
  withMockSpawn((_cmd, _argv, opts) => { capturedOpts = opts; return { stdout: "ok", stderr: "", status: 0 }; }, ghRun => {
    const saved = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "ghp_test";
    try {
      ghRun({ args_str: "repo list" });
      assert.strictEqual(capturedOpts.maxBuffer, 4 * 1024 * 1024);
    } finally {
      if (saved !== undefined) process.env.GH_TOKEN = saved;
      else delete process.env.GH_TOKEN;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

setTimeout(() => {
  if (failed > 0) {
    process.stderr.write(`\n✗ ${failed} test(s) FAILED:\n`);
    for (const { name, err } of errors) {
      process.stderr.write(`  - ${name}: ${err.message}\n`);
    }
  }
  process.stderr.write(`\n✓ ${passed} passed, ✗ ${failed} failed out of ${passed + failed} tests\n\n`);
  process.exit(failed > 0 ? 1 : 0);
}, 500);
