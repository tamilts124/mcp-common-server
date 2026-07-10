"use strict";
/**
 * [147] find_deprecated_html_elements — all 5 rigor levels
 *
 * Tests findDeprecatedHtmlElements (lib/deprecatedHtmlOps.js).
 * Does NOT start the MCP server — imports the function directly.
 */
const assert = require("assert");
const fs   = require("fs");
const path = require("path");
const os   = require("os");
const { findDeprecatedHtmlElements } = require("../../lib/deprecatedHtmlOps");

let passed = 0, failed = 0;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "deprecated-html-test-"));

function write(name, content) {
  const fp = path.join(DIR, name);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, content, "utf8");
  return fp;
}

function check(label, cond, extra) {
  if (cond) { console.log(`  \u2713 ${label}`); passed++; }
  else { console.error(`  \u2717 FAIL: ${label}${extra ? " | " + extra : ""}`); failed++; }
}

console.log("\n[147] find_deprecated_html_elements");
console.log("  -- Level 1: Normal --");

// [147-A] Normal
const htmlDeprecated = `<!DOCTYPE html>\n<html lang="en">\n<head><title>Test</title></head>\n<body>\n  <font color="red">red text</font>\n  <center>centered</center>\n  <marquee>scrolling</marquee>\n  <b>bold</b>\n  <i>italic</i>\n  <p>normal paragraph</p>\n</body>\n</html>`;
const fileA = write("deprecated.html", htmlDeprecated);
const rA = findDeprecatedHtmlElements(fileA, "deprecated.html");
check("[147-A1] filesScanned=1", rA.filesScanned === 1);
check("[147-A2] 3 deprecated errors (font,center,marquee)", rA.errorCount === 3);
check("[147-A3] 2 discouraged warnings (b,i)", rA.warningCount === 2);
check("[147-A4] total findings=5", rA.findingsCount === 5);
check("[147-A5] first finding is font tag", rA.findings[0].tag === "<font>");
check("[147-A6] first finding rule=deprecated_html_element", rA.findings[0].rule === "deprecated_html_element");
check("[147-A7] b tag has rule=discouraged_html_element", rA.findings.find(f => f.tag === "<b>").rule === "discouraged_html_element");
check("[147-A8] b tag has alternative text", typeof rA.findings.find(f => f.tag === "<b>").alternative === "string");
check("[147-A9] not truncated", rA.truncated === false);

console.log("  -- Level 2: Boundary --");

// [147-B] Medium
const fileEmpty = write("empty.html", "");
const rEmpty = findDeprecatedHtmlElements(fileEmpty, "empty.html");
check("[147-B1] empty file → 0 findings", rEmpty.findingsCount === 0);

const htmlSafe = `<!DOCTYPE html><html lang="en"><head><title>T</title></head><body><p>Hello <strong>world</strong></p></body></html>`;
const fileSafe = write("safe.html", htmlSafe);
const rSafe = findDeprecatedHtmlElements(fileSafe, "safe.html");
check("[147-B2] safe HTML → 0 findings", rSafe.findingsCount === 0);

const rDir = findDeprecatedHtmlElements(DIR, ".");
check("[147-B3] directory scan finds ≥2 files", rDir.filesScanned >= 2);
check("[147-B4] directory scan finds ≥5 total findings", rDir.findingsCount >= 5);

const rExt = findDeprecatedHtmlElements(DIR, ".", { extensions: [".tsx"] });
check("[147-B5] wrong extension → 0 files", rExt.filesScanned === 0);

try {
  findDeprecatedHtmlElements(fileA, "x", { maxResults: 0 });
  check("[147-B6] max_results=0 should throw", false);
} catch (e) { check("[147-B6] max_results=0 throws -32602", e.code === -32602); }

try {
  findDeprecatedHtmlElements(fileA, "x", { maxResults: 9999 });
  check("[147-B7] max_results=9999 should throw", false);
} catch (e) { check("[147-B7] max_results=9999 throws -32602", e.code === -32602); }

try {
  findDeprecatedHtmlElements("/nonexistent/path", "bad");
  check("[147-B8] nonexistent path should throw", false);
} catch (e) { check("[147-B8] nonexistent path throws -32602", e.code === -32602); }

console.log("  -- Level 3: Mock failures --");

// [147-C] High
const htmlUnreadable = write("cant-read.html", "<font>x</font>");
fs.chmodSync(htmlUnreadable, 0o000);
try {
  const rBadPerm = findDeprecatedHtmlElements(htmlUnreadable, "cant-read.html");
  check("[147-C1] unreadable file graceful (0 or 1 findings)", rBadPerm.findingsCount <= 1);
} finally {
  fs.chmodSync(htmlUnreadable, 0o644);
}

const htmlFrames = `<frameset cols="50%,50%"><frame src="a.html"/><noframes><p>text</p></noframes></frameset><blink>attention</blink>`;
const fileFrames = write("frames.html", htmlFrames);
const rFrames = findDeprecatedHtmlElements(fileFrames, "frames.html");
check("[147-C2] frameset detected", rFrames.findings.some(f => f.tag === "<frameset>"));
check("[147-C3] frame detected",    rFrames.findings.some(f => f.tag === "<frame>"));
check("[147-C4] noframes detected", rFrames.findings.some(f => f.tag === "<noframes>"));
check("[147-C5] blink detected",    rFrames.findings.some(f => f.tag === "<blink>"));

const htmlSelfClose = `<basefont size="3" /><big>large</big><applet code="App.class"></applet>`;
const fileSC = write("selfclose.html", htmlSelfClose);
const rSC = findDeprecatedHtmlElements(fileSC, "selfclose.html");
check("[147-C6] basefont (self-closing) detected", rSC.findings.some(f => f.tag === "<basefont>"));
check("[147-C7] big detected",    rSC.findings.some(f => f.tag === "<big>"));
check("[147-C8] applet detected", rSC.findings.some(f => f.tag === "<applet>"));

const htmlClose = `<marquee>scrolling</marquee><center>c</center>`;
const fileClose = write("closing.html", htmlClose);
const rClose = findDeprecatedHtmlElements(fileClose, "closing.html");
check("[147-C9] closing tags not double-counted (2 findings)", rClose.findingsCount === 2);

console.log("  -- Level 4: Security --");

// [147-D] Critical
const htmlXss = `<font><center><marquee><blink><strike><tt><big><s><u><b><i></i></b></u></s>`;
const fileXss = write("xss.html", htmlXss);
const rXss = findDeprecatedHtmlElements(fileXss, "xss.html");
check("[147-D1] many tags on one line — no crash", rXss.findingsCount >= 7);
check("[147-D2] all findings have required fields",
  rXss.findings.every(f => f.file && f.line && f.tag && f.rule && f.severity && f.message));

const manyTagsLines = Array.from({ length: 100 }, () => "<font>x</font><center>y</center>").join("\n");
const fileManyTags = write("many-tags.html", manyTagsLines);
const rCapped = findDeprecatedHtmlElements(fileManyTags, "many-tags.html", { maxResults: 5 });
check("[147-D3] max_results=5 caps findings at 5", rCapped.findingsCount === 5);
check("[147-D4] truncated=true when capped", rCapped.truncated === true);

console.log("  -- Level 5: Stress --");

// [147-E] Extreme
const bigLines = Array.from({ length: 1000 }, (_, i) =>
  i % 4 === 0 ? "<font color=red>text</font>" :
  i % 4 === 1 ? "<p>normal</p>" :
  i % 4 === 2 ? "<marquee>scroll</marquee>" :
  "<b>bold</b>"
).join("\n");
const fileBig = write("big.html", bigLines);
const rBig = findDeprecatedHtmlElements(fileBig, "big.html");
check("[147-E1] large file: findings > 0", rBig.findingsCount > 0);
check("[147-E2] large file: returns structured result", typeof rBig.findingsCount === "number");
check("[147-E3] findings sorted by line asc",
  rBig.findings.every((f, i, a) => i === 0 || a[i-1].line <= f.line));

const allDeprecated = [
  "<font>","<center>","<marquee>","<blink>","<frameset>","<frame>",
  "<noframes>","<big>","<applet>","<basefont>","<dir>","<isindex>",
  "<plaintext>","<xmp>","<listing>","<spacer>","<strike>","<tt>",
].join("\n");
const fileAll = write("all-deprecated.html", allDeprecated);
const rAll = findDeprecatedHtmlElements(fileAll, "all-deprecated.html");
check("[147-E4] all 18 deprecated tags detected", rAll.errorCount === 18);
check("[147-E5] no warnings for deprecated-only file", rAll.warningCount === 0);

// Cleanup
try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) {}

console.log(`\n[147] find_deprecated_html_elements: ${passed} passed, ${failed} failed`);
module.exports = { passed, failed };
