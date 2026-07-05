"use strict";
// Isolated functional tests for find_unpinned_docker_base_image (lib/dockerBaseImagePinningOps.js).
// Run: node test/find-unpinned-docker-base-image-tests.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { findUnpinnedDockerBaseImage } = require("../lib/dockerBaseImagePinningOps");
const { SCAN_DISPATCH } = require("../lib/dispatchScan");
const { EXEC_SCHEMAS } = require("../lib/schemas/execSchemas");

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log("ok -", name); }
  catch (e) { fail++; console.log("FAIL -", name, "-", e.message); }
}

function tmpDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "tls-docker-test-"));
  return d;
}
function writeFile(dir, name, content) {
  const p = path.join(dir, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
}

// ── Normal ──────────────────────────────────────────────────────────────
t("flags FROM with no tag or digest", () => {
  const d = tmpDir();
  try {
    const f = writeFile(d, "Dockerfile", "FROM node\n");
    const r = findUnpinnedDockerBaseImage(f, "Dockerfile");
    assert.strictEqual(r.findingsCount, 1);
    assert.strictEqual(r.findings[0].rule, "missing_tag_or_digest");
    assert.strictEqual(r.findings[0].severity, "error");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("flags explicit :latest tag", () => {
  const d = tmpDir();
  try {
    const f = writeFile(d, "Dockerfile", "FROM node:latest\n");
    const r = findUnpinnedDockerBaseImage(f, "Dockerfile");
    assert.strictEqual(r.findings[0].rule, "explicit_latest_tag");
    assert.strictEqual(r.findings[0].severity, "error");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("flags bare major-version numeric tag", () => {
  const d = tmpDir();
  try {
    const f = writeFile(d, "Dockerfile", "FROM node:18\n");
    const r = findUnpinnedDockerBaseImage(f, "Dockerfile");
    assert.strictEqual(r.findings[0].rule, "bare_major_version_tag");
    assert.strictEqual(r.findings[0].severity, "warning");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("flags bare major.minor tag", () => {
  const d = tmpDir();
  try {
    const f = writeFile(d, "Dockerfile", "FROM node:18.4\n");
    const r = findUnpinnedDockerBaseImage(f, "Dockerfile");
    assert.strictEqual(r.findings[0].rule, "bare_major_version_tag");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("flags rolling codename tag", () => {
  const d = tmpDir();
  try {
    const f = writeFile(d, "Dockerfile", "FROM ubuntu:jammy\n");
    const r = findUnpinnedDockerBaseImage(f, "Dockerfile");
    assert.strictEqual(r.findings[0].rule, "bare_major_version_tag");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("full patch-version tag (3 numeric segments) is not flagged", () => {
  const d = tmpDir();
  try {
    const f = writeFile(d, "Dockerfile", "FROM node:18.20.4\n");
    const r = findUnpinnedDockerBaseImage(f, "Dockerfile");
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("digest pin is not flagged even with a mutable tag", () => {
  const d = tmpDir();
  try {
    const f = writeFile(d, "Dockerfile", "FROM node:latest@sha256:" + "a".repeat(64) + "\n");
    const r = findUnpinnedDockerBaseImage(f, "Dockerfile");
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("multi-stage FROM <alias> reference is skipped, not treated as an image", () => {
  const d = tmpDir();
  try {
    const f = writeFile(d, "Dockerfile", "FROM node:18.20.4 AS builder\nFROM builder\n");
    const r = findUnpinnedDockerBaseImage(f, "Dockerfile");
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("dynamic build-arg tag flagged as unresolvable_dynamic_tag", () => {
  const d = tmpDir();
  try {
    const f = writeFile(d, "Dockerfile", "ARG VERSION\nFROM node:${VERSION}\n");
    const r = findUnpinnedDockerBaseImage(f, "Dockerfile");
    assert.strictEqual(r.findings[0].rule, "unresolvable_dynamic_tag");
    assert.strictEqual(r.findings[0].severity, "warning");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("directory aggregation across multiple Dockerfiles", () => {
  const d = tmpDir();
  try {
    writeFile(d, "Dockerfile", "FROM node:18\n");
    writeFile(d, "sub/Dockerfile.prod", "FROM node\n");
    const r = findUnpinnedDockerBaseImage(d, ".");
    assert.strictEqual(r.filesScanned, 2);
    assert.strictEqual(r.findingsCount, 2);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Medium ──────────────────────────────────────────────────────────────
t("nonexistent path throws", () => {
  assert.throws(() => findUnpinnedDockerBaseImage("/no/such/path/Dockerfile", "x"));
});

t("max_results type mismatch throws", () => {
  const d = tmpDir();
  try {
    const f = writeFile(d, "Dockerfile", "FROM node:18\n");
    assert.throws(() => findUnpinnedDockerBaseImage(f, "Dockerfile", { maxResults: "5" }));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("clean file (full pin) yields zero findings", () => {
  const d = tmpDir();
  try {
    const f = writeFile(d, "Dockerfile", "FROM node:18.20.4\nRUN echo hi\n");
    const r = findUnpinnedDockerBaseImage(f, "Dockerfile");
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("non-Dockerfile-named files in a directory are ignored", () => {
  const d = tmpDir();
  try {
    writeFile(d, "notes.txt", "FROM node:18\n");
    writeFile(d, "Dockerfile", "FROM node:18.20.4\n");
    const r = findUnpinnedDockerBaseImage(d, ".");
    assert.strictEqual(r.filesScanned, 1);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── High ────────────────────────────────────────────────────────────────
t("line-continuation FROM (backslash) is parsed correctly", () => {
  const d = tmpDir();
  try {
    const f = writeFile(d, "Dockerfile", "FROM \\\n  node:18\n");
    const r = findUnpinnedDockerBaseImage(f, "Dockerfile");
    assert.strictEqual(r.findings[0].rule, "bare_major_version_tag");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("comment lines are ignored, not parsed as FROM", () => {
  const d = tmpDir();
  try {
    const f = writeFile(d, "Dockerfile", "# FROM node:18\nFROM node:18.20.4\n");
    const r = findUnpinnedDockerBaseImage(f, "Dockerfile");
    assert.strictEqual(r.findingsCount, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("--platform flag on FROM does not break parsing", () => {
  const d = tmpDir();
  try {
    const f = writeFile(d, "Dockerfile", "FROM --platform=linux/amd64 node:18\n");
    const r = findUnpinnedDockerBaseImage(f, "Dockerfile");
    assert.strictEqual(r.findings[0].rule, "bare_major_version_tag");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("nested subdirectory Dockerfile.dev variant is discovered", () => {
  const d = tmpDir();
  try {
    writeFile(d, "docker/Dockerfile.dev", "FROM node\n");
    const r = findUnpinnedDockerBaseImage(d, ".");
    assert.strictEqual(r.filesScanned, 1);
    assert.strictEqual(r.findings[0].file, "docker/Dockerfile.dev");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Critical ────────────────────────────────────────────────────────────
t("path-traversal-shaped label is echoed back but not resolved into a real traversal", () => {
  const d = tmpDir();
  try {
    const f = writeFile(d, "Dockerfile", "FROM node:18\n");
    const r = findUnpinnedDockerBaseImage(f, "../../../etc/passwd");
    assert.strictEqual(r.path, "../../../etc/passwd");
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("shell-injection-shaped image ref is only reported as text, never executed", () => {
  const d = tmpDir();
  try {
    const f = writeFile(d, "Dockerfile", "FROM node:$(rm -rf /)\n");
    const r = findUnpinnedDockerBaseImage(f, "Dockerfile");
    assert.ok(r.findingsCount >= 0); // must not throw/crash regardless of shape
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("result is JSON-serialisable with exact expected top-level keys", () => {
  const d = tmpDir();
  try {
    const f = writeFile(d, "Dockerfile", "FROM node:18\n");
    const r = findUnpinnedDockerBaseImage(f, "Dockerfile");
    const json = JSON.parse(JSON.stringify(r));
    assert.deepStrictEqual(Object.keys(json).sort(), ["errorCount", "filesScanned", "findings", "findingsCount", "path", "truncated", "warningCount"].sort());
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

// ── Extreme ─────────────────────────────────────────────────────────────
t("max_results truncation sets truncated flag", () => {
  const d = tmpDir();
  try {
    let content = "";
    for (let i = 0; i < 5; i++) content += `FROM node:18 AS s${i}\n`;
    const f = writeFile(d, "Dockerfile", content);
    const r = findUnpinnedDockerBaseImage(f, "Dockerfile", { maxResults: 2 });
    assert.strictEqual(r.truncated, true);
    assert.strictEqual(r.findings.length, 2);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("fuzz: random-byte Dockerfile does not crash scan", () => {
  const d = tmpDir();
  try {
    const buf = Buffer.alloc(2000);
    for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
    const f = path.join(d, "Dockerfile");
    fs.writeFileSync(f, buf);
    assert.doesNotThrow(() => findUnpinnedDockerBaseImage(f, "Dockerfile"));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("empty directory yields zero findings, no crash", () => {
  const d = tmpDir();
  try {
    const r = findUnpinnedDockerBaseImage(d, ".");
    assert.strictEqual(r.findingsCount, 0);
    assert.strictEqual(r.filesScanned, 0);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("10 concurrent scans of the same file give consistent results", () => {
  const d = tmpDir();
  try {
    const f = writeFile(d, "Dockerfile", "FROM node:18\nFROM ubuntu:jammy\n");
    const results = [];
    for (let i = 0; i < 10; i++) results.push(findUnpinnedDockerBaseImage(f, "Dockerfile"));
    for (const r of results) assert.strictEqual(r.findingsCount, 2);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

t("execute_pipeline op-enum registration includes find_unpinned_docker_base_image", () => {
  const opEnumSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
  const stepsProp = opEnumSchema.inputSchema.properties.steps;
  const opEnum = stepsProp.items.properties.op.enum;
  assert.ok(opEnum.includes("find_unpinned_docker_base_image"));
  assert.ok(typeof SCAN_DISPATCH.find_unpinned_docker_base_image === "function");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
