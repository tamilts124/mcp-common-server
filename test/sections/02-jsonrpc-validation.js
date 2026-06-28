"use strict";
/**
 * [6] JSON-RPC SCHEMA VALIDATION — ToolError codes & validateArgs.
 */
const { assert, test, executeTool, ToolError, validateArgs, getErrorCode } = require("../test-harness");

console.log(`\n[6] JSON-RPC SCHEMA VALIDATION — ToolError codes & validateArgs`);

test("validateArgs: unknown tool name throws code -32601", () => {
  try {
    validateArgs("no_such_tool", {});
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(e instanceof ToolError);
    assert.strictEqual(e.code, -32601);
    assert.ok(e.message.includes("Unknown tool"));
  }
});

test("validateArgs: non-object args throws code -32602", () => {
  try {
    validateArgs("read_file", "not-an-object");
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(e instanceof ToolError);
    assert.strictEqual(e.code, -32602);
    assert.ok(e.message.includes("arguments must be an object"));
  }
});

test("validateArgs: array args throws code -32602", () => {
  try {
    validateArgs("read_file", ["path", "value"]);
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(e instanceof ToolError);
    assert.strictEqual(e.code, -32602);
  }
});

test("validateArgs: missing required field throws code -32602 with field name", () => {
  try {
    validateArgs("read_file", {});  // read_file requires 'path'
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(e instanceof ToolError);
    assert.strictEqual(e.code, -32602);
    assert.ok(e.message.includes("'path'"), `Expected 'path' in message: ${e.message}`);
  }
});

test("validateArgs: empty string for required field throws code -32602", () => {
  try {
    validateArgs("read_file", { path: "" });
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(e instanceof ToolError);
    assert.strictEqual(e.code, -32602);
  }
});

test("validateArgs: null for required field throws code -32602", () => {
  try {
    validateArgs("run_command", { command: null });
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(e instanceof ToolError);
    assert.strictEqual(e.code, -32602);
  }
});

test("validateArgs: valid required fields pass without throwing", () => {
  // Should not throw — path is present and non-empty
  assert.doesNotThrow(() => validateArgs("read_file", { path: "some/file.txt" }));
});

test("validateArgs: tool with no required fields passes empty args", () => {
  // list_processes has no required fields
  assert.doesNotThrow(() => validateArgs("list_processes", {}));
});

test("getErrorCode: returns .code from ToolError", () => {
  const e = new ToolError("test", -32602);
  assert.strictEqual(getErrorCode(e), -32602);
});

test("getErrorCode: returns -32603 for plain Error (no .code)", () => {
  const e = new Error("oops");
  assert.strictEqual(getErrorCode(e), -32603);
});

test("getErrorCode: returns -32603 for null/undefined", () => {
  assert.strictEqual(getErrorCode(null), -32603);
  assert.strictEqual(getErrorCode(undefined), -32603);
});

test("executeTool: unknown tool surfaces code -32601 on thrown ToolError", () => {
  try {
    executeTool("totally_fake_tool", {});
    assert.fail("should have thrown");
  } catch (e) {
    assert.strictEqual(e.code, -32601);
  }
});

test("executeTool: missing required param surfaces code -32602", () => {
  try {
    executeTool("write_file", { content: "x" }); // missing 'path'
    assert.fail("should have thrown");
  } catch (e) {
    assert.strictEqual(e.code, -32602);
  }
});
