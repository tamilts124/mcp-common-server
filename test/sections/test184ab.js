"use strict";
process.env.MCP_ALLOW_EXEC = "true";
const assert = require("assert");
const { gitWriteOps } = require("../../lib/gitWriteOps");
const os = require("os");
const fakeDir = os.tmpdir();
const mockRcp = (p) => ({ resolved: p });
const gwo = (args) => gitWriteOps(args, fakeDir, mockRcp);
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); process.stderr.write("PASS " + name + "\n"); passed++; }
  catch (e) { process.stderr.write("FAIL " + name + ": " + e.message + "\n"); failed++; }
}

test("A1 missing op",            () => assert.throws(() => gwo({}), /operation.*required/i));
test("A2 unknown op",            () => assert.throws(() => gwo({ operation: "squash" }), /unknown operation/i));
test("A3 add no paths",          () => assert.throws(() => gwo({ operation: "add", all: false }), /paths.*array.*all/i));
test("A4 commit no msg",         () => assert.throws(() => gwo({ operation: "commit" }), /message.*required/i));
test("A5 commit bad author",     () => assert.throws(() => gwo({ operation: "commit", message: "x", author: "bad" }), /author.*Name.*email/i));
test("A6 checkout no branch",    () => assert.throws(() => gwo({ operation: "checkout" }), /branch.*required/i));
test("A7 branch rename no tgt",  () => assert.throws(() => gwo({ operation: "branch", action: "rename", name: "old" }), /target.*required/i));
test("A8 branch bad action",     () => assert.throws(() => gwo({ operation: "branch", action: "explode", name: "x" }), /unknown action/i));
test("A9 reset bad mode",        () => assert.throws(() => gwo({ operation: "reset", mode: "nuclear" }), /unknown mode/i));
test("A10 stash bad subop",      () => assert.throws(() => gwo({ operation: "stash", subop: "teleport" }), /unknown subop/i));
test("A11 merge no branch",      () => assert.throws(() => gwo({ operation: "merge" }), /branch.*required/i));
test("A12 rebase bad action",    () => assert.throws(() => gwo({ operation: "rebase", action: "explode" }), /unknown action/i));
test("A13 cherry_pick bad act",  () => assert.throws(() => gwo({ operation: "cherry_pick", action: "teleport" }), /unknown action/i));
test("A14 tag bad action",       () => assert.throws(() => gwo({ operation: "tag", action: "destroy" }), /unknown action/i));
test("A15 tag no name",          () => assert.throws(() => gwo({ operation: "tag" }), /name.*required/i));
test("A16 cherry_pick no ref",   () => assert.throws(() => gwo({ operation: "cherry_pick" }), /ref.*required/i));
test("A17 rebase no branch",     () => assert.throws(() => gwo({ operation: "rebase" }), /branch.*required/i));
test("B1 null byte msg",         () => assert.throws(() => gwo({ operation: "commit", message: "hello\x00world" }), /null bytes/i));
test("B2 msg too long",          () => assert.throws(() => gwo({ operation: "commit", message: "x".repeat(10001) }), /exceeds.*10000|10000.*characters/i));
test("B3 null byte tag",         () => assert.throws(() => gwo({ operation: "tag", name: "v1\x00.0" }), /null bytes/i));
test("B4 null byte remote",      () => assert.throws(() => gwo({ operation: "push", remote: "ori\x00gin" }), /null bytes/i));
test("B5 mainline 0",            () => assert.throws(() => gwo({ operation: "cherry_pick", ref: "HEAD", mainline: 0 }), /positive integer/i));
test("B6 mainline float",        () => assert.throws(() => gwo({ operation: "cherry_pick", ref: "HEAD", mainline: 1.5 }), /positive integer/i));
test("B7 ALLOW_EXEC true",       () => { const { ALLOW_EXEC } = require("../../lib/config"); assert.strictEqual(ALLOW_EXEC, true); });

process.stderr.write("\n=== A+B: " + passed + " passed, " + failed + " failed ===\n");
process.exit(failed > 0 ? 1 : 0);
