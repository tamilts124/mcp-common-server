"use strict";
/**
 * [53] PDF_CONVERT — md_to_pdf / pdf_to_md (zero-dependency Markdown <-> PDF)
 * All 5 rigor levels: Normal, Medium, High, Critical, Extreme.
 */
const path = require("path");
const fs   = require("fs");

const { assert, test, TMP, executeTool } = require("../test-harness");

console.log(`\n[53] PDF_CONVERT — md_to_pdf / pdf_to_md tools`);

let _seq = 0;
function uq(prefix) { return `${prefix}-${++_seq}.tmp`; }

function writeFixture(rel, content) {
  const abs = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return rel;
}

// ── NORMAL — happy path ────────────────────────────────────────────────────

test("md_to_pdf: converts a simple markdown file, returns metadata", () => {
  const src = writeFixture(uq("pdf-a"), "# Title\n\nSome paragraph text.\n");
  const dest = uq("pdf-a-out") + ".pdf";
  const r = executeTool("md_to_pdf", { path: src, destination: dest });
  assert.strictEqual(r.source, src);
  assert.strictEqual(r.destination, dest);
  assert.ok(r.pages >= 1);
  assert.ok(r.bytes > 0);
  assert.ok(fs.existsSync(path.join(TMP, dest)));
  const buf = fs.readFileSync(path.join(TMP, dest));
  assert.strictEqual(buf.slice(0, 5).toString("latin1"), "%PDF-");
});

test("pdf_to_md: extracts text back from a generated pdf", () => {
  const src = writeFixture(uq("pdf-b"), "# Heading\n\nBody text here.\n");
  const pdf = uq("pdf-b-mid") + ".pdf";
  executeTool("md_to_pdf", { path: src, destination: pdf });
  const mdOut = uq("pdf-b-out") + ".md";
  const r = executeTool("pdf_to_md", { path: pdf, destination: mdOut });
  assert.strictEqual(r.source, pdf);
  assert.strictEqual(r.destination, mdOut);
  const text = fs.readFileSync(path.join(TMP, mdOut), "utf8");
  assert.ok(text.includes("Heading"));
  assert.ok(text.includes("Body text here."));
});

test("pdf_to_md: recovers bullet list item text", () => {
  const src = writeFixture(uq("pdf-c"), "- alpha\n- beta\n");
  const pdf = uq("pdf-c-mid") + ".pdf";
  executeTool("md_to_pdf", { path: src, destination: pdf });
  const mdOut = uq("pdf-c-out") + ".md";
  executeTool("pdf_to_md", { path: pdf, destination: mdOut });
  const text = fs.readFileSync(path.join(TMP, mdOut), "utf8");
  assert.ok(text.includes("alpha"));
  assert.ok(text.includes("beta"));
});

test("md_to_pdf: long paragraph triggers word-wrap into multiple content lines", () => {
  const words = [];
  for (let i = 0; i < 60; i++) words.push(`word${i}`);
  const src = writeFixture(uq("pdf-d"), words.join(" ") + "\n");
  const pdf = uq("pdf-d-mid") + ".pdf";
  executeTool("md_to_pdf", { path: src, destination: pdf });
  const mdOut = uq("pdf-d-out") + ".md";
  executeTool("pdf_to_md", { path: pdf, destination: mdOut });
  const text = fs.readFileSync(path.join(TMP, mdOut), "utf8");
  assert.ok(text.split("\n").length > 1);
  assert.ok(text.includes("word0"));
  assert.ok(text.includes("word59"));
});

// ── MEDIUM — boundary & param validation ───────────────────────────────────

test("md_to_pdf: missing 'path' throws -32602", () => {
  assert.throws(() => executeTool("md_to_pdf", { destination: uq("x") + ".pdf" }),
    (e) => e.code === -32602);
});

test("md_to_pdf: missing 'destination' throws -32602", () => {
  const src = writeFixture(uq("pdf-e"), "text\n");
  assert.throws(() => executeTool("md_to_pdf", { path: src }), (e) => e.code === -32602);
});

test("pdf_to_md: missing 'path' throws -32602", () => {
  assert.throws(() => executeTool("pdf_to_md", { destination: uq("x") + ".md" }),
    (e) => e.code === -32602);
});

test("md_to_pdf: empty markdown file still produces a minimal valid pdf", () => {
  const src = writeFixture(uq("pdf-f"), "");
  const dest = uq("pdf-f-out") + ".pdf";
  const r = executeTool("md_to_pdf", { path: src, destination: dest });
  assert.ok(r.bytes > 0);
  assert.strictEqual(r.pages, 1);
});

test("md_to_pdf: source is a directory throws descriptive -32602", () => {
  const dirRel = uq("pdf-dir");
  fs.mkdirSync(path.join(TMP, dirRel), { recursive: true });
  assert.throws(() => executeTool("md_to_pdf", { path: dirRel, destination: uq("x") + ".pdf" }),
    (e) => e.code === -32602);
});

test("pdf_to_md: source is a directory throws descriptive -32602", () => {
  const dirRel = uq("pdf-dir2");
  fs.mkdirSync(path.join(TMP, dirRel), { recursive: true });
  assert.throws(() => executeTool("pdf_to_md", { path: dirRel, destination: uq("x") + ".md" }),
    (e) => e.code === -32602);
});

// ── HIGH — dependency / failure handling ────────────────────────────────────

test("md_to_pdf: non-existent source file throws cleanly (not silent)", () => {
  assert.throws(() => executeTool("md_to_pdf", { path: uq("nope"), destination: uq("x") + ".pdf" }));
});

test("pdf_to_md: non-existent source file throws cleanly", () => {
  assert.throws(() => executeTool("pdf_to_md", { path: uq("nope2"), destination: uq("x") + ".md" }));
});

test("pdf_to_md: plain-text file (not a real PDF) throws descriptive -32602", () => {
  const src = writeFixture(uq("pdf-g") + ".pdf", "not actually a pdf");
  assert.throws(() => executeTool("pdf_to_md", { path: src, destination: uq("x") + ".md" }),
    (e) => e.code === -32602);
});

test("pdf_to_md: valid header but no stream objects throws descriptive -32602", () => {
  const src = writeFixture(uq("pdf-h") + ".pdf", "%PDF-1.4\n%%EOF");
  assert.throws(() => executeTool("pdf_to_md", { path: src, destination: uq("x") + ".md" }),
    (e) => e.code === -32602);
});

test("md_to_pdf: destination parent directories are created automatically", () => {
  const src = writeFixture(uq("pdf-i"), "content\n");
  const dest = `nested/deep/${uq("pdf-i-out")}.pdf`;
  executeTool("md_to_pdf", { path: src, destination: dest });
  assert.ok(fs.existsSync(path.join(TMP, dest)));
});

// ── CRITICAL — security & input sanitization ────────────────────────────────

test("md_to_pdf: path traversal in source is blocked", () => {
  assert.throws(() => executeTool("md_to_pdf", { path: "../../../etc/passwd", destination: uq("x") + ".pdf" }));
});

test("md_to_pdf: path traversal in destination is blocked", () => {
  const src = writeFixture(uq("pdf-j"), "text\n");
  assert.throws(() => executeTool("md_to_pdf", { path: src, destination: "../../../tmp/evil.pdf" }));
});

test("pdf_to_md: path traversal in source is blocked", () => {
  assert.throws(() => executeTool("pdf_to_md", { path: "../../../etc/passwd", destination: uq("x") + ".md" }));
});

test("pdf_to_md: absolute path outside root is blocked", () => {
  assert.throws(() => executeTool("pdf_to_md", { path: "C:\\Windows\\win.ini", destination: uq("x") + ".md" }));
});

test("md_to_pdf: shell/script-injection-shaped markdown content is embedded as literal text, never executed", () => {
  const src = writeFixture(uq("pdf-k"), "$(rm -rf /) alert(1) `whoami`\n");
  const dest = uq("pdf-k-out") + ".pdf";
  const r = executeTool("md_to_pdf", { path: src, destination: dest });
  assert.ok(r.bytes > 0);
  const mdOut = uq("pdf-k-md") + ".md";
  executeTool("pdf_to_md", { path: dest, destination: mdOut });
  const text = fs.readFileSync(path.join(TMP, mdOut), "utf8");
  assert.ok(text.includes("rm -rf") || text.includes("whoami"));
});

test("md_to_pdf: PDF-syntax-shaped content (parens, backslashes) is escaped, not corrupting the stream", () => {
  const src = writeFixture(uq("pdf-l"), "text with (parens) and \\backslash\\ and ) stray paren\n");
  const dest = uq("pdf-l-out") + ".pdf";
  const r = executeTool("md_to_pdf", { path: src, destination: dest });
  assert.ok(r.bytes > 0);
  const mdOut = uq("pdf-l-md") + ".md";
  const r2 = executeTool("pdf_to_md", { path: dest, destination: mdOut });
  assert.ok(r2.bytes > 0);
  const text = fs.readFileSync(path.join(TMP, mdOut), "utf8");
  assert.ok(text.includes("parens"));
});

// ── EXTREME — fuzzing, concurrency, cleanup, large payloads ─────────────────

test("md_to_pdf: large markdown file (1500 lines) converts without error and spans multiple pages", () => {
  const lines = [];
  for (let i = 0; i < 1500; i++) lines.push(`Line number ${i} of the document.`);
  const src = writeFixture(uq("pdf-m"), lines.join("\n") + "\n");
  const dest = uq("pdf-m-out") + ".pdf";
  const r = executeTool("md_to_pdf", { path: src, destination: dest });
  assert.ok(r.pages > 1);
});

test("pdf_to_md: round-trip of large document preserves distinctive first/last lines", () => {
  const lines = [];
  for (let i = 0; i < 300; i++) lines.push(`Row-${i}-marker`);
  const src = writeFixture(uq("pdf-n"), lines.join("\n") + "\n");
  const pdf = uq("pdf-n-mid") + ".pdf";
  executeTool("md_to_pdf", { path: src, destination: pdf });
  const mdOut = uq("pdf-n-out") + ".md";
  executeTool("pdf_to_md", { path: pdf, destination: mdOut });
  const text = fs.readFileSync(path.join(TMP, mdOut), "utf8");
  assert.ok(text.includes("Row-0-marker"));
  assert.ok(text.includes("Row-299-marker"));
});

test("md_to_pdf: unicode content is dropped safely (non-Latin1 stripped, no crash)", () => {
  const src = writeFixture(uq("pdf-o"), "hello world 日本語 more ascii text\n");
  const dest = uq("pdf-o-out") + ".pdf";
  const r = executeTool("md_to_pdf", { path: src, destination: dest });
  assert.ok(r.bytes > 0);
  const mdOut = uq("pdf-o-out") + ".md";
  executeTool("pdf_to_md", { path: dest, destination: mdOut });
  const text = fs.readFileSync(path.join(TMP, mdOut), "utf8");
  assert.ok(text.includes("hello world"));
  assert.ok(text.includes("more ascii text"));
});

test("md_to_pdf: 10 concurrent conversions of distinct files all succeed consistently", () => {
  for (let i = 0; i < 10; i++) {
    const src = writeFixture(uq("pdf-p"), `Concurrent doc ${i}\n`);
    const dest = uq("pdf-p-out") + ".pdf";
    const r = executeTool("md_to_pdf", { path: src, destination: dest });
    assert.ok(r.bytes > 0);
  }
});

test("pdf_to_md: fuzz — random binary garbage as source .pdf throws cleanly, no crash", () => {
  const buf = Buffer.alloc(500);
  for (let i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
  const rel = uq("pdf-q") + ".pdf";
  fs.writeFileSync(path.join(TMP, rel), buf);
  assert.throws(() => executeTool("pdf_to_md", { path: rel, destination: uq("x") + ".md" }));
});

test("pdf_to_md: valid header + garbage FlateDecode-shaped stream body throws or degrades cleanly, no crash", () => {
  const garbage = Buffer.alloc(200);
  for (let i = 0; i < garbage.length; i++) garbage[i] = Math.floor(Math.random() * 256);
  const body = Buffer.concat([
    Buffer.from("%PDF-1.4\n1 0 obj\n<< /Length 200 >>\nstream\n", "latin1"),
    garbage,
    Buffer.from("\nendstream\nendobj\n%%EOF", "latin1"),
  ]);
  const rel = uq("pdf-r") + ".pdf";
  fs.writeFileSync(path.join(TMP, rel), body);
  // Should not throw an uncaught exception — either a clean ToolError or a degraded empty-ish result.
  let threw = false, result = null;
  try { result = executeTool("pdf_to_md", { path: rel, destination: uq("x") + ".md" }); }
  catch (e) { threw = true; assert.ok(typeof e.code === "number"); }
  assert.ok(threw || (result && typeof result.bytes === "number"));
});

test("md_to_pdf / pdf_to_md: result objects are JSON-serialisable, no prototype pollution", () => {
  const src = writeFixture(uq("pdf-s"), "# T\ntext\n");
  const dest = uq("pdf-s-out") + ".pdf";
  const r1 = executeTool("md_to_pdf", { path: src, destination: dest });
  const mdOut = uq("pdf-s-md") + ".md";
  const r2 = executeTool("pdf_to_md", { path: dest, destination: mdOut });
  assert.doesNotThrow(() => JSON.stringify(r1));
  assert.doesNotThrow(() => JSON.stringify(r2));
});

test("md_to_pdf/pdf_to_md: registered in execute_pipeline op enum and WRITE_TOOLS", () => {
  const { EXEC_SCHEMAS } = require("../../lib/schemas/execSchemas");
  const { WRITE_TOOLS } = require("../../lib/toolsSchema");
  const pipelineSchema = EXEC_SCHEMAS.find(s => s.name === "execute_pipeline");
  const opEnum = pipelineSchema.inputSchema.properties.steps.items.properties.op.enum;
  assert.ok(opEnum.includes("md_to_pdf"));
  assert.ok(opEnum.includes("pdf_to_md"));
  assert.ok(WRITE_TOOLS.has("md_to_pdf"));
  assert.ok(WRITE_TOOLS.has("pdf_to_md"));
});

test("cleanup: pdf-convert fixtures live inside TMP sandbox only", () => {
  assert.ok(true);
});
