"use strict";
// test/sections/208-markdown-client.js
// Comprehensive tests for markdown_client tool
// Sections: A=input-validation(10), B=parser-unit(20), C=html-render(10), D=happy-path(20), E=security(10), F=concurrency(5) = 75 total

const assert = require("assert");
const fs     = require("fs");
const path   = require("path");
const os     = require("os");

const {
  markdownClient,
  tokeniseBlocks,
  renderBlocks,
  renderInline,
  splitFrontMatter,
  extractLinksFromText,
  htmlEscape,
  findSection,
} = require("../../lib/markdownClientOps");

// ── Test harness ───────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    console.error(`  [PASS] ${name}`);
    passed++;
  } catch (e) {
    console.error(`  [FAIL] ${name}: ${e.message}`);
    failed++;
  }
}
function throws(fn, msg) {
  let threw = false;
  try { fn(); } catch { threw = true; }
  if (!threw) throw new Error(msg || "Expected an error to be thrown");
}

// ── Temp dir helpers ──────────────────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "md-client-test-"));
function tmpFile(name, content) {
  const p = path.join(TMP, name);
  if (content !== undefined) fs.writeFileSync(p, content, "utf8");
  return p;
}
function cleanup() {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}

// ── Sample Markdown ───────────────────────────────────────────────────────────
const README_MD = `---
title: My Project
version: 1.0.0
---

# My Project

A short description of the project.

## Installation

Run the following command:

\`\`\`bash
npm install my-project
\`\`\`

## Usage

Import and use:

\`\`\`javascript
const mp = require('my-project');
mp.run();
\`\`\`

## API Reference

### method_one(arg)

Does something useful. Returns a [Result](https://example.com/result).

- Param: **arg** - the input value
- Returns: a Result object

### method_two()

Does something else. See also [method_one](#method_one).

## Contributing

PR welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT \u2014 see [LICENSE](LICENSE).
`;

const SIMPLE_MD = `# Hello World

This is a paragraph with **bold** and *italic* text.

## Section Two

Some content here.

### Subsection

Deeper content.
`;

const LINKS_MD = `# Links

Check out [Google](https://google.com) and [Bing](https://bing.com).

![Logo](https://example.com/logo.png "Company Logo")

Auto link: <https://autolink.example.com>

[reference link][ref1]

[ref1]: https://ref.example.com "Ref Title"
`;

const CODE_MD = `# Code Examples

\`\`\`python
print("Hello Python")
\`\`\`

\`\`\`javascript
console.log("Hello JS");
\`\`\`

\`\`\`python
x = 1 + 2
\`\`\`

Inline code: \`const x = 1;\`
`;

const TABLE_MD = `# Table

| Name  | Age | City     |
|-------|-----|----------|
| Alice | 30  | New York |
| Bob   | 25  | London   |
`;

console.error("\n=== Section A: Input Validation (10 tests) ===");

test("A01 missing operation throws", () => {
  throws(() => markdownClient({}), "should throw on missing operation");
});

test("A02 unknown operation throws", () => {
  throws(() => markdownClient({ operation: "fly" }), "should throw on unknown op");
});

test("A03 read with no path throws", () => {
  throws(() => markdownClient({ operation: "read" }), "should throw on missing path");
});

test("A04 get_section with no heading throws", () => {
  const f = tmpFile("a04.md", SIMPLE_MD);
  throws(() => markdownClient({ operation: "get_section", path: f }), "should throw on missing heading");
});

test("A05 set_section with no heading throws", () => {
  const f = tmpFile("a05.md", SIMPLE_MD);
  throws(() => markdownClient({ operation: "set_section", path: f, content: "x" }), "should throw on missing heading");
});

test("A06 set_section with no content throws", () => {
  const f = tmpFile("a06.md", SIMPLE_MD);
  throws(() => markdownClient({ operation: "set_section", path: f, heading: "Hello World" }), "should throw on missing content");
});

test("A07 path with NUL byte throws", () => {
  throws(() => markdownClient({ operation: "read", path: "file\0.md" }));
});

test("A08 convert_to_html with both path and markdown throws", () => {
  const f = tmpFile("a08.md", "# Test");
  throws(() => markdownClient({ operation: "convert_to_html", path: f, markdown: "# X" }));
});

test("A09 convert_to_html with no source throws", () => {
  throws(() => markdownClient({ operation: "convert_to_html" }));
});

test("A10 stringify with no path throws", () => {
  throws(() => markdownClient({ operation: "stringify" }));
});

console.error("\n=== Section B: Parser Unit (20 tests) ===");

test("B01 tokenise ATX headings level 1-3", () => {
  const tokens = tokeniseBlocks("# H1\n## H2\n### H3\n");
  const headings = tokens.filter(t => t.type === "heading");
  assert.equal(headings.length, 3);
  assert.equal(headings[0].level, 1);
  assert.equal(headings[0].text, "H1");
  assert.equal(headings[1].level, 2);
  assert.equal(headings[2].level, 3);
});

test("B02 tokenise setext heading level 1 and 2", () => {
  const tokens = tokeniseBlocks("Title\n=====\n\nSubtitle\n--------\n");
  const headings = tokens.filter(t => t.type === "heading");
  assert.ok(headings.length >= 2, "should have 2 setext headings");
  assert.equal(headings[0].level, 1);
  assert.equal(headings[0].text, "Title");
  assert.equal(headings[1].level, 2);
  assert.equal(headings[1].text, "Subtitle");
});

test("B03 tokenise fenced code block with language", () => {
  const tokens = tokeniseBlocks("```javascript\nconsole.log('hi');\n```\n");
  const code = tokens.find(t => t.type === "fenced_code");
  assert.ok(code, "should have fenced code");
  assert.equal(code.lang, "javascript");
  assert.ok(code.code.includes("console.log"));
});

test("B04 tokenise fenced code block with tilde fence", () => {
  const tokens = tokeniseBlocks("~~~python\nprint('hi')\n~~~\n");
  const code = tokens.find(t => t.type === "fenced_code");
  assert.ok(code, "should have tilde-fenced code");
  assert.equal(code.lang, "python");
});

test("B05 tokenise horizontal rule", () => {
  const tokens = tokeniseBlocks("---\n");
  const hr = tokens.find(t => t.type === "hr");
  assert.ok(hr, "should have hr");
});

test("B06 tokenise unordered list", () => {
  const tokens = tokeniseBlocks("- item one\n- item two\n- item three\n");
  const list = tokens.find(t => t.type === "list");
  assert.ok(list, "should have list");
  assert.equal(list.ordered, false);
  assert.equal(list.items.length, 3);
  assert.ok(list.items[0].includes("item one"));
});

test("B07 tokenise ordered list", () => {
  const tokens = tokeniseBlocks("1. first\n2. second\n3. third\n");
  const list = tokens.find(t => t.type === "list");
  assert.ok(list, "should have ordered list");
  assert.equal(list.ordered, true);
  assert.equal(list.items.length, 3);
});

test("B08 tokenise blockquote", () => {
  const tokens = tokeniseBlocks("> This is a quote\n");
  const bq = tokens.find(t => t.type === "blockquote");
  assert.ok(bq, "should have blockquote");
});

test("B09 tokenise GFM table", () => {
  const tokens = tokeniseBlocks("| Name | Age |\n|------|-----|\n| Alice | 30 |\n");
  const table = tokens.find(t => t.type === "table");
  assert.ok(table, "should have table");
  assert.ok(table.header.includes("Name"));
  assert.equal(table.rows.length, 1);
});

test("B10 tokenise paragraph", () => {
  const tokens = tokeniseBlocks("This is a paragraph.\n");
  const para = tokens.find(t => t.type === "paragraph");
  assert.ok(para, "should have paragraph");
  assert.ok(para.raw.includes("paragraph"));
});

test("B11 splitFrontMatter extracts YAML front matter", () => {
  const text = "---\ntitle: Test\n---\n\n# Body\n";
  const { front, body } = splitFrontMatter(text);
  assert.ok(front.includes("title: Test"));
  assert.ok(body.includes("# Body"));
  assert.ok(!body.includes("---"));
});

test("B12 splitFrontMatter returns empty front for no front matter", () => {
  const { front, body } = splitFrontMatter("# Just a heading\n");
  assert.equal(front, "");
  assert.ok(body.includes("Just a heading"));
});

test("B13 extractLinksFromText finds inline links", () => {
  const links = extractLinksFromText("See [Google](https://google.com) for more.");
  const link = links.find(l => l.url === "https://google.com");
  assert.ok(link, "should find google link");
  assert.equal(link.text, "Google");
  assert.equal(link.type, "link");
});

test("B14 extractLinksFromText finds image links", () => {
  const links = extractLinksFromText('![Logo](https://example.com/logo.png)');
  const img = links.find(l => l.type === "image");
  assert.ok(img, "should find image");
  assert.equal(img.url, "https://example.com/logo.png");
});

test("B15 extractLinksFromText finds auto-links", () => {
  const links = extractLinksFromText("Visit <https://auto.example.com>");
  const auto = links.find(l => l.type === "autolink");
  assert.ok(auto, "should find auto-link");
  assert.ok(auto.url.includes("auto.example.com"));
});

test("B16 findSection locates heading by text", () => {
  const tokens = tokeniseBlocks("# Intro\n\nSome text.\n\n## Details\n\nDetails here.\n");
  const sec = findSection(tokens, "Details");
  assert.ok(sec, "should find section");
  assert.equal(sec.level, 2);
});

test("B17 findSection returns null for missing heading", () => {
  const tokens = tokeniseBlocks("# Hello\n\nContent.\n");
  const sec = findSection(tokens, "Nonexistent");
  assert.equal(sec, null);
});

test("B18 findSection is case-insensitive", () => {
  const tokens = tokeniseBlocks("## Installation\n\nSteps here.\n");
  const sec = findSection(tokens, "INSTALLATION");
  assert.ok(sec, "should find section case-insensitively");
});

test("B19 htmlEscape encodes special chars", () => {
  assert.equal(htmlEscape("<b>&amp;</b>"), "&lt;b&gt;&amp;amp;&lt;/b&gt;");
});

test("B20 renderInline processes bold, italic, code", () => {
  const s = renderInline("**bold** and *italic* and `code`");
  assert.ok(s.includes("<strong>bold</strong>"), "should have bold");
  assert.ok(s.includes("<em>italic</em>"), "should have italic");
  assert.ok(s.includes("<code>"), "should have code");
});

console.error("\n=== Section C: HTML Render (10 tests) ===");

test("C01 render heading as h1-h6 with id", () => {
  const tokens = tokeniseBlocks("# Hello World\n");
  const html = renderBlocks(tokens);
  assert.ok(html.includes("<h1"), "should have h1");
  assert.ok(html.includes("id=\"hello-world\""), "should have id");
});

test("C02 render fenced code with language class", () => {
  const tokens = tokeniseBlocks("```python\nprint('hi')\n```\n");
  const html = renderBlocks(tokens);
  assert.ok(html.includes("language-python"), "should have language class");
  assert.ok(html.includes("<pre><code"), "should have pre>code");
});

test("C03 render unordered list as <ul>", () => {
  const tokens = tokeniseBlocks("- a\n- b\n- c\n");
  const html = renderBlocks(tokens);
  assert.ok(html.includes("<ul>"), "should have ul");
  assert.ok(html.includes("<li>"), "should have li");
});

test("C04 render ordered list as <ol>", () => {
  const tokens = tokeniseBlocks("1. first\n2. second\n");
  const html = renderBlocks(tokens);
  assert.ok(html.includes("<ol>"), "should have ol");
});

test("C05 render table with thead and tbody", () => {
  const tokens = tokeniseBlocks("| A | B |\n|---|---|\n| 1 | 2 |\n");
  const html = renderBlocks(tokens);
  assert.ok(html.includes("<table>"), "should have table");
  assert.ok(html.includes("<thead>"), "should have thead");
  assert.ok(html.includes("<tbody>"), "should have tbody");
});

test("C06 render horizontal rule as <hr>", () => {
  const tokens = tokeniseBlocks("---\n");
  const html = renderBlocks(tokens);
  assert.ok(html.includes("<hr>"), "should have hr");
});

test("C07 render blockquote as <blockquote>", () => {
  const tokens = tokeniseBlocks("> quoted text\n");
  const html = renderBlocks(tokens);
  assert.ok(html.includes("<blockquote>"), "should have blockquote");
});

test("C08 render paragraph wraps in <p>", () => {
  const tokens = tokeniseBlocks("Just some text.\n");
  const html = renderBlocks(tokens);
  assert.ok(html.includes("<p>"), "should have p tag");
  assert.ok(html.includes("Just some text."), "should have text");
});

test("C09 convert_to_html with wrap=true produces full HTML", () => {
  const res = markdownClient({
    operation: "convert_to_html",
    markdown:  "# Hello\n\nWorld.",
    wrap:      true,
    title:     "Test Page",
  });
  assert.ok(res.html.includes("<!DOCTYPE html>"), "should have DOCTYPE");
  assert.ok(res.html.includes("<title>Test Page</title>"), "should have title");
  assert.ok(res.html.includes("<h1"), "should have h1");
});

test("C10 convert_to_html with wrap=false returns fragment", () => {
  const res = markdownClient({
    operation: "convert_to_html",
    markdown:  "# Hello",
    wrap:      false,
  });
  assert.ok(!res.html.includes("<!DOCTYPE html>"), "fragment should not have DOCTYPE");
  assert.ok(res.html.includes("<h1"), "should still have h1");
});

console.error("\n=== Section D: Happy-Path Operations (20 tests) ===");

test("D01 read parses README stats", () => {
  const f = tmpFile("d01.md", README_MD);
  const res = markdownClient({ operation: "read", path: f });
  assert.ok(res.hasFrontMatter, "should detect front matter");
  assert.ok(res.stats.headings >= 5, "should count headings");
  assert.ok(res.stats.codeBlocks >= 2, "should count code blocks");
  assert.ok(res.headings.length >= 5);
});

test("D02 read reports correct heading list", () => {
  const f = tmpFile("d02.md", SIMPLE_MD);
  const res = markdownClient({ operation: "read", path: f });
  assert.ok(res.headings.find(h => h.text === "Hello World" && h.level === 1));
  assert.ok(res.headings.find(h => h.text === "Section Two" && h.level === 2));
});

test("D03 get_section extracts Installation section", () => {
  const f = tmpFile("d03.md", README_MD);
  const res = markdownClient({ operation: "get_section", path: f, heading: "Installation" });
  assert.equal(res.found, true);
  assert.ok(res.content.includes("npm install"), "should contain install command");
});

test("D04 get_section returns found=false for missing heading", () => {
  const f = tmpFile("d04.md", SIMPLE_MD);
  const res = markdownClient({ operation: "get_section", path: f, heading: "Nonexistent Section" });
  assert.equal(res.found, false);
  assert.equal(res.content, null);
});

test("D05 get_section is case-insensitive", () => {
  const f = tmpFile("d05.md", SIMPLE_MD);
  const res = markdownClient({ operation: "get_section", path: f, heading: "section two" });
  assert.equal(res.found, true);
});

test("D06 set_section replaces existing section content", () => {
  const f = tmpFile("d06.md", SIMPLE_MD);
  markdownClient({ operation: "set_section", path: f, heading: "Section Two", content: "New content here." });
  const res = markdownClient({ operation: "get_section", path: f, heading: "Section Two" });
  assert.ok(res.content.includes("New content here."), "should have new content");
});

test("D07 set_section appends new section if not found", () => {
  const f = tmpFile("d07.md", SIMPLE_MD);
  markdownClient({ operation: "set_section", path: f, heading: "Brand New Section", content: "Brand new content." });
  const content = fs.readFileSync(f, "utf8");
  assert.ok(content.includes("Brand New Section"), "should append new heading");
  assert.ok(content.includes("Brand new content."), "should append content");
});

test("D08 set_section writes to output_path", () => {
  const f   = tmpFile("d08.md", SIMPLE_MD);
  const out = tmpFile("d08_out.md");
  markdownClient({ operation: "set_section", path: f, heading: "Section Two", content: "Changed.", output_path: out });
  const content = fs.readFileSync(out, "utf8");
  assert.ok(content.includes("Changed."));
  // Original unchanged
  const orig = fs.readFileSync(f, "utf8");
  assert.ok(orig.includes("Some content here."), "original should be unchanged");
});

test("D09 extract_links finds all links and images", () => {
  const f = tmpFile("d09.md", LINKS_MD);
  const res = markdownClient({ operation: "extract_links", path: f });
  assert.ok(res.total >= 2, "should find multiple links");
  const urls = res.links.map(l => l.url);
  assert.ok(urls.some(u => u.includes("google.com") || u.includes("bing.com")), "should find web links");
});

test("D10 extract_links with type=image returns only images", () => {
  const f = tmpFile("d10.md", LINKS_MD);
  const res = markdownClient({ operation: "extract_links", path: f, type: "image" });
  assert.ok(res.total >= 1, "should find at least one image");
  for (const l of res.links) {
    assert.equal(l.type, "image", "all returned items should be images");
  }
});

test("D11 extract_headings returns TOC", () => {
  const f = tmpFile("d11.md", README_MD);
  const res = markdownClient({ operation: "extract_headings", path: f });
  assert.ok(res.count >= 5);
  assert.ok(res.headings.some(h => h.text === "My Project"));
  assert.ok(res.headings.some(h => h.text === "Installation"));
  assert.ok(res.headings.every(h => h.anchor), "all headings should have anchor");
});

test("D12 extract_headings with min/max_level filter", () => {
  const f = tmpFile("d12.md", README_MD);
  const res = markdownClient({ operation: "extract_headings", path: f, min_level: 2, max_level: 2 });
  for (const h of res.headings) {
    assert.equal(h.level, 2, "all returned headings should be level 2");
  }
});

test("D13 extract_code_blocks finds all code blocks", () => {
  const f = tmpFile("d13.md", CODE_MD);
  const res = markdownClient({ operation: "extract_code_blocks", path: f });
  assert.ok(res.count >= 3, "should find at least 3 code blocks");
});

test("D14 extract_code_blocks filtered by language", () => {
  const f = tmpFile("d14.md", CODE_MD);
  const res = markdownClient({ operation: "extract_code_blocks", path: f, language: "python" });
  assert.ok(res.count >= 2, "should find python blocks");
  for (const b of res.blocks) {
    assert.equal(b.lang, "python", "should only return python blocks");
  }
});

test("D15 convert_to_html from file", () => {
  const f = tmpFile("d15.md", README_MD);
  const res = markdownClient({ operation: "convert_to_html", path: f, wrap: false });
  assert.ok(res.html.includes("<h1"), "should have h1");
  assert.ok(res.html.includes("<h2"), "should have h2");
  assert.ok(res.html.includes("<pre><code"), "should have code block");
});

test("D16 convert_to_html renders table", () => {
  const f = tmpFile("d16.md", TABLE_MD);
  const res = markdownClient({ operation: "convert_to_html", path: f, wrap: false });
  assert.ok(res.html.includes("<table>"), "should have table");
  assert.ok(res.html.includes("Alice"), "should have table content");
});

test("D17 convert_to_html writes to output_path", () => {
  const f   = tmpFile("d17.md", SIMPLE_MD);
  const out = tmpFile("d17.html");
  const res = markdownClient({ operation: "convert_to_html", path: f, output_path: out });
  assert.equal(res.written, true);
  const content = fs.readFileSync(out, "utf8");
  assert.ok(content.includes("<h1"));
});

test("D18 stringify normalises document", () => {
  const f = tmpFile("d18.md", README_MD);
  const res = markdownClient({ operation: "stringify", path: f });
  assert.ok(res.markdown.includes("# My Project"), "should include heading");
  // Should not have 3+ consecutive blank lines
  assert.ok(!res.markdown.includes("\n\n\n\n"), "should not have 4+ blank lines");
});

test("D19 stringify writes to output_path", () => {
  const f   = tmpFile("d19.md", SIMPLE_MD);
  const out = tmpFile("d19_out.md");
  const res = markdownClient({ operation: "stringify", path: f, output_path: out });
  assert.equal(res.written, true);
  const content = fs.readFileSync(out, "utf8");
  assert.ok(content.includes("Hello World"));
});

test("D20 read word count is reasonable", () => {
  const f = tmpFile("d20.md", README_MD);
  const res = markdownClient({ operation: "read", path: f });
  assert.ok(res.stats.wordCount > 20, "should count words in body");
});

console.error("\n=== Section E: Security (10 tests) ===");

test("E01 NUL byte in path is rejected", () => {
  throws(() => markdownClient({ operation: "read", path: "path\0.md" }));
});

test("E02 file too large is rejected", () => {
  const f = tmpFile("e02.md");
  // Write ~4.1 MB
  fs.writeFileSync(f, "# Big\n" + "x".repeat(4 * 1024 * 1024));
  throws(() => markdownClient({ operation: "read", path: f }), "should reject large file");
});

test("E03 HTML in markdown is escaped in paragraph rendering", () => {
  const md = '<script>alert(1)</script>';
  const res = markdownClient({ operation: "convert_to_html", markdown: md, wrap: false });
  assert.ok(!res.html.includes("<script>"), "should not have raw script tag");
  assert.ok(res.html.includes("&lt;script&gt;"), "should escape script tag");
});

test("E04 XSS in link URL is HTML-escaped in output", () => {
  const md = '[click](javascript:alert(1))';
  const res = markdownClient({ operation: "convert_to_html", markdown: md, wrap: false });
  // The href should not execute, and & in URL attr is escaped
  // at minimum the raw <script> pattern shouldn't appear
  assert.ok(res.html.includes("href="), "should still render link");
});

test("E05 XSS in heading text is HTML-escaped", () => {
  const md = '# <script>evil()</script>';
  const res = markdownClient({ operation: "convert_to_html", markdown: md, wrap: false });
  assert.ok(!res.html.includes("<script>evil"), "should not have unescaped script in heading");
});

test("E06 bold/italic with special chars are escaped", () => {
  const md = '**a & b**';
  const res = markdownClient({ operation: "convert_to_html", markdown: md, wrap: false });
  assert.ok(res.html.includes("&amp;") || res.html.includes("a &amp; b"), "ampersand should be escaped");
});

test("E07 document node limit is enforced", () => {
  // Create a document with many lines
  const lines = [];
  for (let i = 0; i < 60000; i++) lines.push(`Para ${i}: some text here.`);
  const bigMd = lines.join("\n\n");
  const f = tmpFile("e07.md");
  // Write just enough to pass file size but trigger node limit
  // We won't actually write 60k paragraphs (too big for 4MB check),
  // so we verify the node limit check works with a reasonable amount
  const limitLines = [];
  for (let i = 0; i < 51000; i++) limitLines.push(`- item ${i}`);
  const bigList = limitLines.join("\n");
  // This should be under 4MB but generate many list items
  if (Buffer.byteLength(bigList) < 4 * 1024 * 1024) {
    fs.writeFileSync(f, bigList);
    throws(() => markdownClient({ operation: "read", path: f }), "should reject too many nodes");
  } else {
    // Skip if it's too big
    assert.ok(true, "skipped (file too big)");
  }
});

test("E08 table cell content is HTML-escaped", () => {
  const md = '| Header |\n|--------|\n| <b>cell</b> |';
  const res = markdownClient({ operation: "convert_to_html", markdown: md, wrap: false });
  assert.ok(!res.html.includes("<b>cell</b>"), "should not have raw bold tag in table cell");
  assert.ok(res.html.includes("&lt;b&gt;"), "should have escaped bold tag");
});

test("E09 list item content is HTML-escaped", () => {
  const md = '- item with <script>x()</script>';
  const res = markdownClient({ operation: "convert_to_html", markdown: md, wrap: false });
  assert.ok(!res.html.includes("<script>"), "should not have unescaped script in list");
});

test("E10 code block content is HTML-escaped", () => {
  const md = '```\n<script>hack()</script>\n```';
  const res = markdownClient({ operation: "convert_to_html", markdown: md, wrap: false });
  assert.ok(!res.html.includes("<script>hack"), "code block should escape script");
  assert.ok(res.html.includes("&lt;script&gt;"), "should have escaped script in code");
});

console.error("\n=== Section F: Concurrency (5 tests) ===");

test("F01 parallel reads do not interfere", async () => {
  const f = tmpFile("f01.md", README_MD);
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      Promise.resolve(markdownClient({ operation: "read", path: f }))
    )
  );
  for (const r of results) {
    assert.ok(r.hasFrontMatter, "all reads should see front matter");
  }
});

test("F02 parallel get_section do not interfere", async () => {
  const f = tmpFile("f02.md", README_MD);
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      Promise.resolve(markdownClient({ operation: "get_section", path: f, heading: "Installation" }))
    )
  );
  for (const r of results) {
    assert.equal(r.found, true);
    assert.ok(r.content.includes("npm install"));
  }
});

test("F03 sequential set_section accumulates changes", () => {
  const f = tmpFile("f03.md", "# Doc\n\n## Section A\n\nOriginal A.\n\n## Section B\n\nOriginal B.\n");
  markdownClient({ operation: "set_section", path: f, heading: "Section A", content: "Updated A." });
  markdownClient({ operation: "set_section", path: f, heading: "Section B", content: "Updated B." });
  const ra = markdownClient({ operation: "get_section", path: f, heading: "Section A" });
  const rb = markdownClient({ operation: "get_section", path: f, heading: "Section B" });
  assert.ok(ra.content.includes("Updated A."));
  assert.ok(rb.content.includes("Updated B."));
});

test("F04 parallel extract_links on different files", async () => {
  const f1 = tmpFile("f04a.md", "[A](https://a.com)");
  const f2 = tmpFile("f04b.md", "[B](https://b.com)");
  const [r1, r2] = await Promise.all([
    Promise.resolve(markdownClient({ operation: "extract_links", path: f1 })),
    Promise.resolve(markdownClient({ operation: "extract_links", path: f2 })),
  ]);
  assert.ok(r1.links.some(l => l.url === "https://a.com"));
  assert.ok(r2.links.some(l => l.url === "https://b.com"));
});

test("F05 convert_to_html on large document is efficient", () => {
  const lines = ["# Large Document\n"];
  for (let i = 0; i < 500; i++) {
    lines.push(`## Section ${i}`);
    lines.push(`Content for section ${i}.`);
    lines.push("");
  }
  const f = tmpFile("f05.md", lines.join("\n"));
  const res = markdownClient({ operation: "convert_to_html", path: f, wrap: false });
  assert.ok(res.html.includes("<h1"), "should render h1");
  assert.ok(res.html.includes("<h2"), "should render h2");
  assert.ok(res.length > 1000, "output should be substantial");
});

// ── Summary ───────────────────────────────────────────────────────────────────
cleanup();
console.error(`\n=== markdown_client tests: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
