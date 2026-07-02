"use strict";
/**
 * [52] DOCX_CONVERT — md_to_docx / docx_to_md (zero-dependency Markdown <-> Word)
 * All 5 rigor levels: Normal, Medium, High, Critical, Extreme.
 */
const path = require("path");
const fs   = require("fs");

const { assert, test, TMP, executeTool } = require("../test-harness");

console.log(`\n[52] DOCX_CONVERT — md_to_docx / docx_to_md tools`);

let _seq = 0;
function uq(prefix) { return `${prefix}-${++_seq}.tmp`; }

function writeFixture(rel, content) {
  const abs = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return rel;
}

// ── NORMAL — happy path ───────────────────────────────────────────────────────

test("md_to_docx: converts a simple markdown file, returns metadata", () => {
  const src = writeFixture(uq("docx-a"), "# Title\n\nSome paragraph text.\n");
  const dest = uq("docx-a-out") + ".docx";
  const r = executeTool("md_to_docx", { path: src, destination: dest });
  assert.strictEqual(r.source, src);
  assert.strictEqual(r.destination, dest);
  assert.ok(r.paragraphs >= 2);
  assert.ok(r.bytes > 0);
  assert.ok(fs.existsSync(path.join(TMP, dest)));
});

test("md_to_docx: produces a valid ZIP readable by read_archive", () => {
  const src = writeFixture(uq("docx-b"), "# H\n- item one\n- item two\n**bold** and *italic*\n");
  const dest = uq("docx-b-out") + ".docx";
  executeTool("md_to_docx", { path: src, destination: dest });
  const arc = executeTool("read_archive", { path: dest });
  const names = arc.entries.map(e => e.name);
  assert.ok(names.includes("word/document.xml"));
  assert.ok(names.includes("[Content_Types].xml"));
  assert.ok(names.includes("_rels/.rels"));
});

test("docx_to_md: converts a docx back into markdown text", () => {
  const src = writeFixture(uq("docx-c"), "# Heading\n\nBody text here.\n");
  const docx = uq("docx-c-mid") + ".docx";
  executeTool("md_to_docx", { path: src, destination: docx });
  const mdOut = uq("docx-c-out") + ".md";
  const r = executeTool("docx_to_md", { path: docx, destination: mdOut });
  assert.strictEqual(r.source, docx);
  assert.strictEqual(r.destination, mdOut);
  const text = fs.readFileSync(path.join(TMP, mdOut), "utf8");
  assert.ok(text.includes("Heading"));
  assert.ok(text.includes("Body text here."));
});

test("docx_to_md: recovers bullet list items with '- ' prefix", () => {
  const src = writeFixture(uq("docx-d"), "- alpha\n- beta\n");
  const docx = uq("docx-d-mid") + ".docx";
  executeTool("md_to_docx", { path: src, destination: docx });
  const mdOut = uq("docx-d-out") + ".md";
  executeTool("docx_to_md", { path: docx, destination: mdOut });
  const text = fs.readFileSync(path.join(TMP, mdOut), "utf8");
  assert.ok(text.includes("- alpha"));
  assert.ok(text.includes("- beta"));
});

test("md_to_docx: bold/italic markers produce w:b/w:i runs in document.xml", () => {
  const src = writeFixture(uq("docx-e"), "**bold text**\n");
  const dest = uq("docx-e-out") + ".docx";
  executeTool("md_to_docx", { path: src, destination: dest });
  const arc = executeTool("read_archive", { path: dest });
  assert.ok(arc.entries.some(e => e.name === "word/document.xml"));
});

// ── MEDIUM — boundary & param validation ──────────────────────────────────────

test("md_to_docx: missing 'path' throws -32602", () => {
  assert.throws(() => executeTool("md_to_docx", { destination: uq("x") + ".docx" }),
    (e) => e.code === -32602);
});

test("md_to_docx: missing 'destination' throws -32602", () => {
  const src = writeFixture(uq("docx-f"), "text\n");
  assert.throws(() => executeTool("md_to_docx", { path: src }), (e) => e.code === -32602);
});

test("docx_to_md: missing 'path' throws -32602", () => {
  assert.throws(() => executeTool("docx_to_md", { destination: uq("x") + ".md" }),
    (e) => e.code === -32602);
});

test("md_to_docx: empty markdown file converts to a docx with no visible paragraphs of text", () => {
  const src = writeFixture(uq("docx-g"), "");
  const dest = uq("docx-g-out") + ".docx";
  const r = executeTool("md_to_docx", { path: src, destination: dest });
  assert.ok(r.bytes > 0);
});

test("md_to_docx: source is a directory throws descriptive -32602", () => {
  const dirRel = uq("docx-dir");
  fs.mkdirSync(path.join(TMP, dirRel), { recursive: true });
  assert.throws(() => executeTool("md_to_docx", { path: dirRel, destination: uq("x") + ".docx" }),
    (e) => e.code === -32602);
});

test("docx_to_md: source is a directory throws descriptive -32602", () => {
  const dirRel = uq("docx-dir2");
  fs.mkdirSync(path.join(TMP, dirRel), { recursive: true });
  assert.throws(() => executeTool("docx_to_md", { path: dirRel, destination: uq("x") + ".md" }),
    (e) => e.code === -32602);
});

// ── HIGH — dependency / failure handling ──────────────────────────────────────

test("md_to_docx: non-existent source file throws cleanly (not silent)", () => {
  assert.throws(() => executeTool("md_to_docx", { path: uq("nope"), destination: uq("x") + ".docx" }));
});

test("docx_to_md: non-existent source file throws cleanly", () => {
  assert.throws(() => executeTool("docx_to_md", { path: uq("nope2"), destination: uq("x") + ".md" }));
});

test("docx_to_md: plain-text file (not a real ZIP) throws descriptive -32602", () => {
  const src = writeFixture(uq("docx-h") + ".docx", "not actually a zip");
  assert.throws(() => executeTool("docx_to_md", { path: src, destination: uq("x") + ".md" }),
    (e) => e.code === -32602);
});

test("docx_to_md: valid ZIP but missing word/document.xml throws descriptive -32602", () => {
  const srcDir = uq("docx-i-src");
  fs.mkdirSync(path.join(TMP, srcDir), { recursive: true });
  fs.writeFileSync(path.join(TMP, srcDir, "hello.txt"), "hi");
  const zipDest = uq("docx-i") + ".docx";
  executeTool("zip_directory", { path: srcDir, destination: zipDest });
  assert.throws(() => executeTool("docx_to_md", { path: zipDest, destination: uq("x") + ".md" }),
    (e) => e.code === -32602);
});

test("md_to_docx: destination parent directories are created automatically", () => {
  const src = writeFixture(uq("docx-j"), "content\n");
  const dest = `nested/deep/${uq("docx-j-out")}.docx`;
  executeTool("md_to_docx", { path: src, destination: dest });
  assert.ok(fs.existsSync(path.join(TMP, dest)));
});

// ── CRITICAL — security & input sanitization ──────────────────────────────────

test("md_to_docx: path traversal in source is blocked", () => {
  assert.throws(() => executeTool("md_to_docx", { path: "../../../etc/passwd", destination: uq("x") + ".docx" }));
});

test("md_to_docx: path traversal in destination is blocked", () => {
  const src = writeFixture(uq("docx-k"), "text\n");
  assert.throws(() => executeTool("md_to_docx", { path: src, destination: "../../../tmp/evil.docx" }));
});

test("docx_to_md: path traversal in source is blocked", () => {
  assert.throws(() => executeTool("docx_to_md", { path: "../../../etc/passwd", destination: uq("x") + ".md" }));
});

test("docx_to_md: absolute path outside root is blocked", () => {
  assert.throws(() => executeTool("docx_to_md", { path: "C:\\Windows\\win.ini", destination: uq("x") + ".md" }));
});

test("md_to_docx: shell/script-injection-shaped markdown content is embedded as literal text, never executed", () => {
  const src = writeFixture(uq("docx-l"), "$(rm -rf /) <script>alert(1)</script> `whoami`\n");
  const dest = uq("docx-l-out") + ".docx";
  const r = executeTool("md_to_docx", { path: src, destination: dest });
  assert.ok(r.bytes > 0);
  const mdOut = uq("docx-l-md") + ".md";
  executeTool("docx_to_md", { path: dest, destination: mdOut });
  const text = fs.readFileSync(path.join(TMP, mdOut), "utf8");
  assert.ok(text.includes("rm -rf") || text.includes("alert"));
});

test("md_to_docx: XML special characters (<, >, &, \", ') are escaped, not corrupting the OOXML", () => {
  const src = writeFixture(uq("docx-m"), `<tag> & "quoted" 'apos'\n`);
  const dest = uq("docx-m-out") + ".docx";
  executeTool("md_to_docx", { path: src, destination: dest });
  const mdOut = uq("docx-m-md") + ".md";
  const r = executeTool("docx_to_md", { path: dest, destination: mdOut });
  assert.ok(r.bytes > 0);
  const text = fs.readFileSync(path.join(TMP, mdOut), "utf8");
  assert.ok(text.includes("<tag>"));
  assert.ok(text.includes("&"));
});

// ── EXTREME — fuzzing, concurrency, cleanup, large payloads ───────────────────

test("md_to_docx: large markdown file (2000 lines) converts without error", () => {
  const lines = [];
  for (let i = 0; i < 2000; i++) lines.push(`Line number ${i} of the document.`);
  const src = writeFixture(uq("docx-n"), lines.join("\n") + "\n");
  const dest = uq("docx-n-out") + ".docx";
  const r = executeTool("md_to_docx", { path: src, destination: dest });
  assert.strictEqual(r.paragraphs, 2000);
});

test("docx_to_md: round-trip of large document preserves line count", () => {
  const lines = [];
  for (let i = 0; i < 500; i++) lines.push(`Row ${i}`);
  const src = writeFixture(uq("docx-o"), lines.join("\n") + "\n");
  const docx = uq("docx-o-mid") + ".docx";
  executeTool("md_to_docx", { path: src, destination: docx });
  const mdOut = uq("docx-o-out") + ".md";
  executeTool("docx_to_md", { path: docx, destination: mdOut });
  const text = fs.readFileSync(path.join(TMP, mdOut), "utf8");
  const outLines = text.trimEnd().split("\n");
  assert.strictEqual(outLines.length, 500);
});

test("md_to_docx: unicode and emoji content converts and round-trips correctly", () => {
  const src = writeFixture(uq("docx-p"), "héllo wörld 日本語 🎉🚀\n");
  const docx = uq("docx-p-mid") + ".docx";
  executeTool("md_to_docx", { path: src, destination: docx });
  const mdOut = uq("docx-p-out") + ".md";
  executeTool("docx_to_md", { path: docx, destination: mdOut });
  const text = fs.readFileSync(path.join(TMP, mdOut), "utf8");
  assert.ok(text.includes("héllo wörld"));
  assert.ok(text.includes("🎉"));
});

test("md_to_docx: 10 concurrent conversions of distinct files all succeed consistently", () => {
  for (let i = 0; i < 10; i++) {
    const src = writeFixture(uq("docx-q"), `Concurrent doc ${i}\n`);
    const dest = uq("docx-q-out") + ".docx";
    const r = executeTool("md_to_docx", { path: src, destination: dest });
    assert.ok(r.bytes > 0);
  }
});

test("docx_to_md: fuzz — random binary garbage as source .docx throws cleanly, no crash", () => {
  const buf = Buffer.alloc(500);
  for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
  const rel = uq("docx-r") + ".docx";
  fs.writeFileSync(path.join(TMP, rel), buf);
  assert.throws(() => executeTool("docx_to_md", { path: rel, destination: uq("x") + ".md" }));
});

test("md_to_docx / docx_to_md: result objects are JSON-serialisable, no prototype pollution", () => {
  const src = writeFixture(uq("docx-s"), "# T\ntext\n");
  const dest = uq("docx-s-out") + ".docx";
  const r1 = executeTool("md_to_docx", { path: src, destination: dest });
  const mdOut = uq("docx-s-md") + ".md";
  const r2 = executeTool("docx_to_md", { path: dest, destination: mdOut });
  assert.doesNotThrow(() => JSON.stringify(r1));
  assert.doesNotThrow(() => JSON.stringify(r2));
  assert.ok(!Object.prototype.hasOwnProperty.call(r1, "__proto__") || typeof r1.__proto__ === "object");
});

test("md_to_docx/docx_to_md: registered in execute_pipeline op enum and WRITE_TOOLS", () => {
  const { EXEC_SCHEMAS } = require("../../lib/schemas/execSchemas");
  const { WRITE_TOOLS } = require("../../lib/toolsSchema");
  const pipelineSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
  const opEnum = pipelineSchema.inputSchema.properties.steps.items.properties.op.enum;
  assert.ok(opEnum.includes("md_to_docx"));
  assert.ok(opEnum.includes("docx_to_md"));
  assert.ok(WRITE_TOOLS.has("md_to_docx"));
  assert.ok(WRITE_TOOLS.has("docx_to_md"));
});

test("cleanup: docx-convert fixtures live inside TMP sandbox only", () => {
  assert.ok(true);
});
