"use strict";
// tests/screenCapture.test.js
// Isolated functional tests for lib/screenCaptureOps.js
//
// Groups:
//   A: parseKeyCombo unit tests        (15 tests)
//   B: Input validation                (10 tests)
//   C: Quality parameter               ( 8 tests)
//   D: Operation dispatch (no-op mock) ( 7 tests)
//   E: Security / edge cases           ( 5 tests)
//
// Total: 45 tests
//
// NOTE: Groups C/D that call the actual capture/click/sendKeys functions
//       require a Windows environment with PowerShell available. Tests in
//       those groups that would invoke PowerShell are marked as skipped on
//       non-Windows so the suite remains runnable on CI / Mac / Linux for
//       the pure-logic groups (A, B, E).

const { screenCapture, parseKeyCombo } = require("../lib/screenCaptureOps");

// ── Simple test harness ────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];

function test(label, fn) {
  try {
    fn();
    process.stderr.write(`  ✓ ${label}\n`);
    passed++;
  } catch (e) {
    process.stderr.write(`  ✗ ${label}: ${e.message}\n`);
    failures.push({ label, error: e.message });
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "Assertion failed");
}

function assertThrows(fn, pattern, label) {
  let threw = false;
  try { fn(); }
  catch (e) {
    threw = true;
    if (pattern && !e.message.includes(pattern))
      throw new Error(`Expected error containing '${pattern}', got: ${e.message}`);
  }
  if (!threw) throw new Error(`${label || "Expected"}: should have thrown but did not`);
}

const isWindows = process.platform === "win32";
function skipUnlessWindows(label, fn) {
  if (!isWindows) {
    process.stderr.write(`  - ${label} [SKIP — non-Windows]\n`);
    return;
  }
  test(label, fn);
}

// ─────────────────────────────────────────────────────────────────────────────
// GROUP A: parseKeyCombo unit tests (15 tests)
// ─────────────────────────────────────────────────────────────────────────────
process.stderr.write("\n[A] parseKeyCombo unit tests\n");

test("A01 single char passthrough", () => {
  assert(parseKeyCombo("a") === "a", "plain char unchanged");
});

test("A02 raw SendKeys passthrough (no modifiers)", () => {
  assert(parseKeyCombo("{ENTER}") === "{ENTER}", "braced key unchanged");
});

test("A03 Ctrl+C → ^C", () => {
  assert(parseKeyCombo("Ctrl+C") === "^C", `got: ${parseKeyCombo("Ctrl+C")}`);
});

test("A04 Control+C → ^C (alias)", () => {
  assert(parseKeyCombo("Control+C") === "^C");
});

test("A05 Shift+A → +A", () => {
  assert(parseKeyCombo("Shift+A") === "+A");
});

test("A06 Alt+F4 → %{F4}", () => {
  assert(parseKeyCombo("Alt+F4") === "%{F4}", `got: ${parseKeyCombo("Alt+F4")}`);
});

test("A07 Shift+Ctrl+C → +^C", () => {
  const result = parseKeyCombo("Shift+Ctrl+C");
  assert(result === "+^C" || result === "^+C",
    `Expected +^C or ^+C, got: ${result}`);
});

test("A08 Ctrl+Alt+Delete → ^%{DELETE}", () => {
  const result = parseKeyCombo("Ctrl+Alt+Delete");
  assert(result.includes("^") && result.includes("%") && result.includes("DELETE"),
    `got: ${result}`);
});

test("A09 Ctrl+Z → ^Z", () => {
  assert(parseKeyCombo("Ctrl+Z") === "^Z");
});

test("A10 already-SendKeys string passes through", () => {
  // No modifier keyword → raw passthrough
  assert(parseKeyCombo("^C") === "^C");
});

test("A11 Ctrl+{TAB} → ^{TAB}", () => {
  const result = parseKeyCombo("Ctrl+{TAB}");
  assert(result === "^{TAB}", `got: ${result}`);
});

test("A12 Shift+Enter → +{ENTER}", () => {
  const result = parseKeyCombo("Shift+Enter");
  assert(result === "+{ENTER}", `got: ${result}`);
});

test("A13 multi-char key upcased and braced", () => {
  const result = parseKeyCombo("Ctrl+Home");
  assert(result === "^{HOME}", `got: ${result}`);
});

test("A14 single modifier key alone → treated as key not modifier", () => {
  // 'Ctrl' alone — no + separator, not a combo — raw passthrough
  const result = parseKeyCombo("Ctrl");
  assert(typeof result === "string" && result.length > 0);
});

test("A15 empty string returns empty string", () => {
  assert(parseKeyCombo("") === "");
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP B: Input validation (10 tests)
// ─────────────────────────────────────────────────────────────────────────────
process.stderr.write("\n[B] Input validation\n");

test("B01 invalid quality throws -32602", () => {
  assertThrows(
    () => screenCapture({ operation: "capture", quality: "ultra" }),
    "quality", "B01"
  );
});

test("B02 mouse_click missing x throws", () => {
  assertThrows(
    () => screenCapture({ operation: "mouse_click", y: 100 }),
    "x and y", "B02"
  );
});

test("B03 mouse_click missing y throws", () => {
  assertThrows(
    () => screenCapture({ operation: "mouse_click", x: 100 }),
    "x and y", "B03"
  );
});

test("B04 mouse_move missing x throws", () => {
  assertThrows(
    () => screenCapture({ operation: "mouse_move", y: 200 }),
    "x and y", "B04"
  );
});

test("B05 mouse_move missing y throws", () => {
  assertThrows(
    () => screenCapture({ operation: "mouse_move", x: 200 }),
    "x and y", "B05"
  );
});

test("B06 send_keys missing keys throws", () => {
  assertThrows(
    () => screenCapture({ operation: "send_keys" }),
    "keys", "B06"
  );
});

test("B07 quality 'low' is accepted (no throw)", () => {
  if (!isWindows) {
    // On non-Windows, it will throw "only supported on Windows" for mouse_click
    // but not for capture — test that quality param itself doesn't reject it
    try { screenCapture({ operation: "capture", quality: "low" }); }
    catch (e) {
      // Any error here is from platform-specific capture, not quality validation
      assert(!e.message.toLowerCase().includes("quality"), "quality param should not throw: " + e.message);
    }
    return;
  }
  // On Windows we'd need PowerShell — just verify no -32602 for quality
  try { screenCapture({ operation: "capture", quality: "low" }); }
  catch (e) { assert(!e.message.includes("quality"), "quality rejected: " + e.message); }
});

test("B08 quality 'medium' is accepted", () => {
  try { screenCapture({ operation: "capture", quality: "medium" }); }
  catch (e) { assert(!e.message.toLowerCase().includes("quality"), "quality rejected: " + e.message); }
});

test("B09 quality 'high' is accepted", () => {
  try { screenCapture({ operation: "capture", quality: "high" }); }
  catch (e) { assert(!e.message.toLowerCase().includes("quality"), "quality rejected: " + e.message); }
});

test("B10 unknown operation defaults to capture path (no specific-op error)", () => {
  // No explicit 'operation' → defaults to 'capture'
  try { screenCapture({}); }
  catch (e) {
    // Should fail with platform or exec error, not an operation-unknown error
    assert(!e.message.includes("unknown operation"), "should default to capture: " + e.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP C: Quality QUALITY_SCALE values (no platform I/O, pure constants check)
// ─────────────────────────────────────────────────────────────────────────────
process.stderr.write("\n[C] Quality scale constants\n");

// Re-require internal constants via module
const screenCaptureModule = require("../lib/screenCaptureOps");

test("C01 module exports screenCapture function", () => {
  assert(typeof screenCaptureModule.screenCapture === "function");
});

test("C02 module exports parseKeyCombo function", () => {
  assert(typeof screenCaptureModule.parseKeyCombo === "function");
});

test("C03 quality 'invalid' in direct call → throws with quality in message", () => {
  assertThrows(
    () => screenCapture({ operation: "capture", quality: "4k" }),
    "quality", "C03"
  );
});

test("C04 quality case-insensitive check — 'LOW' rejected as not lowercase 'low'", () => {
  // The implementation does .toLowerCase() so 'LOW' becomes 'low' → accepted
  try { screenCapture({ operation: "capture", quality: "LOW" }); }
  catch (e) { assert(!e.message.toLowerCase().includes("quality"), "should accept 'LOW': " + e.message); }
});

test("C05 quality=undefined defaults to medium (no quality error)", () => {
  try { screenCapture({ operation: "capture" }); }
  catch (e) { assert(!e.message.toLowerCase().includes("quality"), "default quality error: " + e.message); }
});

test("C06 parseKeyCombo is pure (no side effects)", () => {
  const r1 = parseKeyCombo("Ctrl+C");
  const r2 = parseKeyCombo("Ctrl+C");
  assert(r1 === r2, "same input → same output");
});

test("C07 parseKeyCombo handles empty parts gracefully", () => {
  // 'Ctrl++C' has an empty part between the two '+'
  const result = parseKeyCombo("Ctrl++C");
  assert(typeof result === "string");
});

test("C08 save_path param is accepted without error (no throw from param check)", () => {
  try { screenCapture({ operation: "capture", save_path: "/tmp/test.png" }); }
  catch (e) { assert(!e.message.includes("save_path"), "save_path rejected: " + e.message); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP D: Platform-gated live tests (Windows only)
// ─────────────────────────────────────────────────────────────────────────────
process.stderr.write("\n[D] Platform-gated live tests (skip on non-Windows)\n");

skipUnlessWindows("D01 capture returns base64 image string", () => {
  const result = screenCapture({ operation: "capture", quality: "low" });
  assert(result.ok === true, "ok flag");
  assert(typeof result.image === "string" && result.image.length > 100, "image base64 present");
  assert(result.format === "png", "format=png");
  assert(result.encoding === "base64", "encoding=base64");
  assert(result.quality === "low", "quality reflected");
});

skipUnlessWindows("D02 capture medium quality returns scale=0.75", () => {
  const result = screenCapture({ operation: "capture", quality: "medium" });
  assert(result.scale === 0.75, `scale: ${result.scale}`);
});

skipUnlessWindows("D03 capture high quality returns scale=1.0", () => {
  const result = screenCapture({ operation: "capture", quality: "high" });
  assert(result.scale === 1.0, `scale: ${result.scale}`);
});

skipUnlessWindows("D04 capture with region returns region in response", () => {
  const result = screenCapture({ operation: "capture", x: 0, y: 0, width: 100, height: 100 });
  assert(result.ok === true);
  assert(result.region && result.region.x === 0 && result.region.width === 100, "region returned");
});

skipUnlessWindows("D05 mouse_move to 0,0 succeeds", () => {
  const result = screenCapture({ operation: "mouse_move", x: 0, y: 0 });
  assert(result.ok === true);
  assert(result.operation === "mouse_move");
});

skipUnlessWindows("D06 send_keys Ctrl+C returns resolved_sendkeys ^C", () => {
  const result = screenCapture({ operation: "send_keys", keys: "Ctrl+C" });
  assert(result.ok === true);
  assert(result.resolved_sendkeys === "^C", `got: ${result.resolved_sendkeys}`);
});

skipUnlessWindows("D07 send_keys raw SendKeys passes through unchanged", () => {
  const result = screenCapture({ operation: "send_keys", keys: "{ESC}" });
  assert(result.ok === true);
  assert(result.resolved_sendkeys === "{ESC}", `got: ${result.resolved_sendkeys}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// GROUP E: Security / edge cases (5 tests)
// ─────────────────────────────────────────────────────────────────────────────
process.stderr.write("\n[E] Security / edge cases\n");

test("E01 send_keys on non-Windows throws informative error", () => {
  if (isWindows) {
    process.stderr.write("  - E01 [SKIP — Windows]\n");
    return;
  }
  assertThrows(
    () => screenCapture({ operation: "send_keys", keys: "Ctrl+C" }),
    "Windows", "E01"
  );
});

test("E02 mouse_click on non-Windows throws informative error", () => {
  if (isWindows) {
    process.stderr.write("  - E02 [SKIP — Windows]\n");
    return;
  }
  assertThrows(
    () => screenCapture({ operation: "mouse_click", x: 10, y: 10 }),
    "Windows", "E02"
  );
});

test("E03 mouse_move on non-Windows throws informative error", () => {
  if (isWindows) {
    process.stderr.write("  - E03 [SKIP — Windows]\n");
    return;
  }
  assertThrows(
    () => screenCapture({ operation: "mouse_move", x: 10, y: 10 }),
    "Windows", "E03"
  );
});

test("E04 parseKeyCombo 1000-char input does not hang", () => {
  const longInput = "A".repeat(1000);
  const t0 = Date.now();
  const result = parseKeyCombo(longInput);
  const elapsed = Date.now() - t0;
  assert(elapsed < 500, `took too long: ${elapsed}ms`);
  assert(typeof result === "string");
});

test("E05 parseKeyCombo with braces containing + not split incorrectly", () => {
  // {Ctrl+C} as a brace group → entire thing is one token, not split on +
  const result = parseKeyCombo("{Ctrl+C}");
  assert(result === "{Ctrl+C}", `got: ${result} — brace content should not be split`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────
const total = passed + failed;
process.stderr.write(`\n=== screenCapture.test.js Results: ${passed}/${total} passed` +
  (failed ? ` — ${failed} FAILED` : "") + " ===\n");

if (failures.length) {
  process.stderr.write("\nFailed tests:\n");
  for (const f of failures)
    process.stderr.write(`  • ${f.label}: ${f.error}\n`);
}

if (failed > 0) process.exit(1);
