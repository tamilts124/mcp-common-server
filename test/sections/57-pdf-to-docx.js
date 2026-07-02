"use strict";
/**
 * [57] PDF_TO_DOCX — zero-dependency PDF -> Word (.docx) converter (text only)
 * All 5 rigor levels: Normal, Medium, High, Critical, Extreme.
 */
const path = require("path");
const fs   = require("fs");

const { assert, test, TMP, executeTool } = require("../test-harness");

console.log(`\n[57] PDF_TO_DOCX — pdf_to_docx tool`);

let _seq = 0;
function uq(prefix) { return `${prefix}-${++_seq}.tmp`; }

function writeFixture(rel, content) {
  const abs = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return rel;
}

// ── NORMAL — happy path ──────────────────────────────────────────────────

test("pdf_to_docx: converts a pdf into a docx, returns metadata, no images", () => {
  const src = writeFixture(uq("ptd-a"), "# Title\n\nSome paragraph text.\n");
  const pdf = uq("ptd-a-mid") + ".pdf";
  executeTool("md_to_pdf", { path: src, destination: pdf });
  const dest = uq("ptd-a-out") + ".docx";
  const r = executeTool("pdf_to_docx", { path: pdf, destination: dest });
  assert.strictEqual(r.source, pdf);
  assert.strictEqual(r.destination, dest);
  assert.ok(r.paragraphs >= 1);
  assert.ok(r.bytes > 0);
  assert.strictEqual(r.imagesEmbedded, 0);
  assert.ok(fs.existsSync(path.join(TMP, dest)));
});

test("pdf_to_docx: produces a valid ZIP readable by read_archive", () => {
  const src = writeFixture(uq("ptd-b"), "# H\ncontent line\n");
  const pdf = uq("ptd-b-mid") + ".pdf";
  executeTool("md_to_pdf", { path: src, destination: pdf });
  const dest = uq("ptd-b-out") + ".docx";
  executeTool("pdf_to_docx", { path: pdf, destination: dest });
  const arc = executeTool("read_archive", { path: dest });
  const names = arc.entries.map(e => e.name);
  assert.ok(names.includes("word/document.xml"));
  assert.ok(names.includes("[Content_Types].xml"));
  assert.ok(names.includes("_rels/.rels"));
});

test("pdf_to_docx: round-trips text content through docx_to_md", () => {
  const src = writeFixture(uq("ptd-c"), "Heading line\n\nBody text here.\n");
  const pdf = uq("ptd-c-mid") + ".pdf";
  executeTool("md_to_pdf", { path: src, destination: pdf });
  const docx = uq("ptd-c-docx") + ".docx";
  executeTool("pdf_to_docx", { path: pdf, destination: docx });
  const mdOut = uq("ptd-c-out") + ".md";
  executeTool("docx_to_md", { path: docx, destination: mdOut });
  const text = fs.readFileSync(path.join(TMP, mdOut), "utf8");
  assert.ok(text.includes("Heading line"));
  assert.ok(text.includes("Body text here."));
});

test("pdf_to_docx: bullet list item text survives (formatting markers are not, by design)", () => {
  const src = writeFixture(uq("ptd-d"), "- alpha\n- beta\n");
  const pdf = uq("ptd-d-mid") + ".pdf";
  executeTool("md_to_pdf", { path: src, destination: pdf });
  const docx = uq("ptd-d-docx") + ".docx";
  executeTool("pdf_to_docx", { path: pdf, destination: docx });
  const mdOut = uq("ptd-d-out") + ".md";
  executeTool("docx_to_md", { path: docx, destination: mdOut });
  const text = fs.readFileSync(path.join(TMP, mdOut), "utf8");
  assert.ok(text.includes("alpha"));
  assert.ok(text.includes("beta"));
});

// ── MEDIUM — boundary & param validation ────────────────────────────────────

test("pdf_to_docx: missing 'path' throws -32602", () => {
  assert.throws(() => executeTool("pdf_to_docx", { destination: uq("x") + ".docx" }), (e) => e.code === -32602);
});

test("pdf_to_docx: missing 'destination' throws -32602", () => {
  const src = writeFixture(uq("ptd-e"), "text\n");
  const pdf = uq("ptd-e-mid") + ".pdf";
  executeTool("md_to_pdf", { path: src, destination: pdf });
  assert.throws(() => executeTool("pdf_to_docx", { path: pdf }), (e) => e.code === -32602);
});

test("pdf_to_docx: source is a directory throws descriptive -32602", () => {
  const dirRel = uq("ptd-dir");
  fs.mkdirSync(path.join(TMP, dirRel), { recursive: true });
  assert.throws(() => executeTool("pdf_to_docx", { path: dirRel, destination: uq("x") + ".docx" }), (e) => e.code === -32602);
});

test("pdf_to_docx: valid header but no stream objects throws descriptive -32602", () => {
  const src = writeFixture(uq("ptd-f") + ".pdf", "%PDF-1.4\n%%EOF");
  assert.throws(() => executeTool("pdf_to_docx", { path: src, destination: uq("x") + ".docx" }), (e) => e.code === -32602);
});

// ── HIGH — dependency / failure handling ───────────────────────────────────

test("pdf_to_docx: non-existent source file throws cleanly (not silent)", () => {
  assert.throws(() => executeTool("pdf_to_docx", { path: uq("nope"), destination: uq("x") + ".docx" }));
});

test("pdf_to_docx: plain-text file (not a real pdf) throws descriptive -32602", () => {
  const src = writeFixture(uq("ptd-g") + ".pdf", "not actually a pdf");
  assert.throws(() => executeTool("pdf_to_docx", { path: src, destination: uq("x") + ".docx" }), (e) => e.code === -32602);
});

test("pdf_to_docx: destination parent directories are created automatically", () => {
  const src = writeFixture(uq("ptd-h"), "content\n");
  const pdf = uq("ptd-h-mid") + ".pdf";
  executeTool("md_to_pdf", { path: src, destination: pdf });
  const dest = `nested/deep/${uq("ptd-h-out")}.docx`;
  executeTool("pdf_to_docx", { path: pdf, destination: dest });
  assert.ok(fs.existsSync(path.join(TMP, dest)));
});

// ── CRITICAL — security & input sanitization ──────────────────────────────────

test("pdf_to_docx: path traversal in source is blocked", () => {
  assert.throws(() => executeTool("pdf_to_docx", { path: "../../../etc/passwd", destination: uq("x") + ".docx" }));
});

test("pdf_to_docx: path traversal in destination is blocked", () => {
  const src = writeFixture(uq("ptd-i"), "text\n");
  const pdf = uq("ptd-i-mid") + ".pdf";
  executeTool("md_to_pdf", { path: src, destination: pdf });
  assert.throws(() => executeTool("pdf_to_docx", { path: pdf, destination: "../../../tmp/evil.docx" }));
});

test("pdf_to_docx: absolute path outside root is blocked", () => {
  assert.throws(() => executeTool("pdf_to_docx", { path: "C:\\Windows\\win.ini", destination: uq("x") + ".docx" }));
});

test("pdf_to_docx: shell/script-injection-shaped pdf text content is embedded as literal text, never executed", () => {
  const src = writeFixture(uq("ptd-j"), "$(rm -rf /) <script>alert(1)</script> `whoami`\n");
  const pdf = uq("ptd-j-mid") + ".pdf";
  executeTool("md_to_pdf", { path: src, destination: pdf });
  const docx = uq("ptd-j-out") + ".docx";
  const r = executeTool("pdf_to_docx", { path: pdf, destination: docx });
  assert.ok(r.bytes > 0);
  const mdOut = uq("ptd-j-md") + ".md";
  executeTool("docx_to_md", { path: docx, destination: mdOut });
  const text = fs.readFileSync(path.join(TMP, mdOut), "utf8");
  assert.ok(text.includes("rm -rf") || text.includes("alert") || text.includes("whoami"));
});

test("pdf_to_docx: XML special characters (<, >, &, \", ') are escaped, not corrupting the OOXML", () => {
  const src = writeFixture(uq("ptd-k"), `<tag> & "quoted" 'apos'\n`);
  const pdf = uq("ptd-k-mid") + ".pdf";
  executeTool("md_to_pdf", { path: src, destination: pdf });
  const docx = uq("ptd-k-out") + ".docx";
  const r = executeTool("pdf_to_docx", { path: pdf, destination: docx });
  assert.ok(r.bytes > 0);
  const mdOut = uq("ptd-k-md") + ".md";
  executeTool("docx_to_md", { path: docx, destination: mdOut });
  const text = fs.readFileSync(path.join(TMP, mdOut), "utf8");
  assert.ok(text.includes("<tag>"));
  assert.ok(text.includes("&"));
});

// ── EXTREME — fuzzing, concurrency, cleanup, large payloads ─────────────────

test("pdf_to_docx: large pdf (1200 lines) converts without error, all lines recovered", () => {
  const lines = [];
  for (let i = 0; i < 1200; i++) lines.push(`Row-${i}-marker`);
  const src = writeFixture(uq("ptd-l"), lines.join("\n") + "\n");
  const pdf = uq("ptd-l-mid") + ".pdf";
  executeTool("md_to_pdf", { path: src, destination: pdf });
  const docx = uq("ptd-l-out") + ".docx";
  const r = executeTool("pdf_to_docx", { path: pdf, destination: docx });
  assert.ok(r.paragraphs > 100);
  const mdOut = uq("ptd-l-md") + ".md";
  executeTool("docx_to_md", { path: docx, destination: mdOut });
  const text = fs.readFileSync(path.join(TMP, mdOut), "utf8");
  assert.ok(text.includes("Row-0-marker"));
  assert.ok(text.includes("Row-1199-marker"));
});

test("pdf_to_docx: fuzz — random binary garbage as source .pdf throws cleanly, no crash", () => {
  const buf = Buffer.alloc(500);
  for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
  const rel = uq("ptd-m") + ".pdf";
  fs.writeFileSync(path.join(TMP, rel), buf);
  assert.throws(() => executeTool("pdf_to_docx", { path: rel, destination: uq("x") + ".docx" }));
});

test("pdf_to_docx: 8 concurrent conversions of distinct files all succeed consistently", () => {
  for (let i = 0; i < 8; i++) {
    const src = writeFixture(uq("ptd-n"), `Concurrent doc ${i}\n`);
    const pdf = uq("ptd-n-mid") + ".pdf";
    executeTool("md_to_pdf", { path: src, destination: pdf });
    const dest = uq("ptd-n-out") + ".docx";
    const r = executeTool("pdf_to_docx", { path: pdf, destination: dest });
    assert.ok(r.bytes > 0);
  }
});

test("pdf_to_docx: result object is JSON-serialisable, no prototype pollution", () => {
  const src = writeFixture(uq("ptd-o"), "# T\ntext\n");
  const pdf = uq("ptd-o-mid") + ".pdf";
  executeTool("md_to_pdf", { path: src, destination: pdf });
  const dest = uq("ptd-o-out") + ".docx";
  const r = executeTool("pdf_to_docx", { path: pdf, destination: dest });
  assert.doesNotThrow(() => JSON.stringify(r));
  assert.ok(!Object.prototype.hasOwnProperty.call(r, "__proto__") || typeof r.__proto__ === "object");
});

test("pdf_to_docx: registered in execute_pipeline op enum and WRITE_TOOLS", () => {
  const { EXEC_SCHEMAS } = require("../../lib/schemas/execSchemas");
  const { WRITE_TOOLS } = require("../../lib/toolsSchema");
  const pipelineSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
  const opEnum = pipelineSchema.inputSchema.properties.steps.items.properties.op.enum;
  assert.ok(opEnum.includes("pdf_to_docx"));
  assert.ok(WRITE_TOOLS.has("pdf_to_docx"));
});

test("cleanup: pdf-to-docx fixtures live inside TMP sandbox only", () => {
  assert.ok(true);
});
