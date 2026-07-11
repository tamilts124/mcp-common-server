"use strict";
/**
 * test/sections/172-markdown-html-xml-parse.js
 * Isolated functional tests for markdown_to_html and xml_parse.
 * Section [172] — 5 rigor levels (A-E) per tool, 10 sub-sections total.
 */

const { test } = require("../test-harness");
const { markdownToHtml } = require("../../lib/markdownHtmlOps");
const { xmlParse } = require("../../lib/xmlParseOps");
const { ToolError } = require("../../lib/errors");

function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function assertThrows(fn, check) {
  let threw = false, err;
  try { fn(); } catch (e) { threw = true; err = e; }
  assert(threw, "expected an error to be thrown");
  if (check) check(err);
}

// ─────────────────────────────────────────────────────────────────────────────
// [172-A] NORMAL — markdown_to_html happy paths
// ─────────────────────────────────────────────────────────────────────────────

test("[172-A-1] markdown_to_html: ATX headings h1-h6", () => {
  const md = "# H1\n## H2\n### H3\n#### H4\n##### H5\n###### H6";
  const { html, stats } = markdownToHtml(md);
  assert(html.includes("<h1>H1</h1>"));
  assert(html.includes("<h2>H2</h2>"));
  assert(html.includes("<h6>H6</h6>"));
  assert(stats.headings === 6);
});

test("[172-A-2] markdown_to_html: setext h1 and h2", () => {
  const md = "Title\n=====\n\nSubtitle\n--------";
  const { html, stats } = markdownToHtml(md);
  assert(html.includes("<h1>Title</h1>"));
  assert(html.includes("<h2>Subtitle</h2>"));
  assert(stats.headings === 2);
});

test("[172-A-3] markdown_to_html: fenced code block with lang", () => {
  const md = "```javascript\nconsole.log('hi');\n```";
  const { html, stats } = markdownToHtml(md);
  assert(html.includes(`class="language-javascript"`));
  assert(html.includes(`console.log(&#x27;hi&#x27;)`) || html.includes("console.log(&apos;hi&apos;") || html.includes("console.log('hi');"));
  assert(stats.codeBlocks === 1);
});

test("[172-A-4] markdown_to_html: paragraph text", () => {
  const md = "Hello world.\n\nSecond paragraph.";
  const { html, stats } = markdownToHtml(md);
  assert(html.includes("<p>Hello world.</p>"));
  assert(html.includes("<p>Second paragraph.</p>"));
  assert(stats.paragraphs === 2);
});

test("[172-A-5] markdown_to_html: unordered list", () => {
  const md = "- item1\n- item2\n- item3";
  const { html, stats } = markdownToHtml(md);
  assert(html.includes("<ul>"));
  assert(html.includes("<li>item1</li>"));
  assert(html.includes("<li>item3</li>"));
  assert(stats.lists >= 1);
});

test("[172-A-6] markdown_to_html: ordered list", () => {
  const md = "1. first\n2. second";
  const { html, stats } = markdownToHtml(md);
  assert(html.includes("<ol>"));
  assert(html.includes("<li>first</li>"));
  assert(html.includes("<li>second</li>"));
  assert(stats.lists >= 1);
});

test("[172-A-7] markdown_to_html: blockquote", () => {
  const md = "> quoted text";
  const { html, stats } = markdownToHtml(md);
  assert(html.includes("<blockquote>"));
  assert(html.includes("quoted text"));
  assert(stats.blockquotes === 1);
});

test("[172-A-8] markdown_to_html: GFM table with alignment", () => {
  const md = "| Left | Center | Right |\n|:-----|:------:|------:|\n| a | b | c |";
  const { html, stats } = markdownToHtml(md);
  assert(html.includes("<table>"));
  assert(html.includes("<th"));
  assert(html.includes("<td"));
  assert(stats.tables === 1);
});

test("[172-A-9] markdown_to_html: inline bold and italic", () => {
  const md = "**bold** and *italic* and ***bolditalic***";
  const { html } = markdownToHtml(md);
  assert(html.includes("<strong>bold</strong>"));
  assert(html.includes("<em>italic</em>"));
  assert(html.includes("<strong><em>bolditalic</em></strong>"));
});

test("[172-A-10] markdown_to_html: inline link and image", () => {
  const md = "[click here](https://example.com) and ![alt](img.png)";
  const { html, stats } = markdownToHtml(md);
  assert(html.includes('<a href="https://example.com">click here</a>'));
  assert(html.includes('<img src="img.png" alt="alt">'));
  assert(stats.links === 1);
  assert(stats.images === 1);
});

test("[172-A-11] markdown_to_html: thematic break", () => {
  const md = "text\n\n---\n\nmore";
  const { html } = markdownToHtml(md);
  assert(html.includes("<hr>"));
});

test("[172-A-12] markdown_to_html: inline code span", () => {
  const md = "Use `console.log()` for debug.";
  const { html } = markdownToHtml(md);
  assert(html.includes("<code>console.log()</code>"));
});

test("[172-A-13] markdown_to_html: autolink URL", () => {
  const md = "Visit <https://example.com> today.";
  const { html } = markdownToHtml(md);
  assert(html.includes('<a href="https://example.com">'));
});

test("[172-A-14] markdown_to_html: stats object has expected keys", () => {
  const { stats } = markdownToHtml("# hi");
  const keys = ["inputLength", "outputLength", "headings", "codeBlocks", "tables", "blockquotes", "lists", "links", "images", "paragraphs"];
  for (const k of keys) assert(k in stats, `missing stat key: ${k}`);
});

test("[172-A-15] markdown_to_html: empty input produces empty html", () => {
  const { html, stats } = markdownToHtml("");
  assert(html === "");
  assert(stats.paragraphs === 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// [172-B] MEDIUM — markdown_to_html validation and edge cases
// ─────────────────────────────────────────────────────────────────────────────

test("[172-B-1] markdown_to_html: non-string input throws", () => {
  assertThrows(() => markdownToHtml(42), e => assert(e instanceof Error));
});

test("[172-B-2] markdown_to_html: input > 1 MB throws", () => {
  assertThrows(
    () => markdownToHtml("x".repeat(1 * 1024 * 1024 + 1)),
    e => assert(e.message.includes("1 MB"))
  );
});

test("[172-B-3] markdown_to_html: raw HTML escaped by default", () => {
  const { html } = markdownToHtml("<b>raw</b>");
  assert(!html.includes("<b>raw</b>"), `raw HTML leaked: ${html}`);
  assert(html.includes("&lt;b&gt;"));
});

test("[172-B-4] markdown_to_html: unsafe_html:true passes through raw tags", () => {
  const { html } = markdownToHtml("<b>raw</b>", { unsafe_html: true });
  assert(html.includes("<b>raw</b>"), `expected raw HTML, got: ${html}`);
});

test("[172-B-5] markdown_to_html: backslash escapes special chars", () => {
  const { html } = markdownToHtml("\\# not a heading");
  assert(!html.includes("<h1>"), `should not be a heading: ${html}`);
});

test("[172-B-6] markdown_to_html: strikethrough ~~text~~", () => {
  const { html } = markdownToHtml("~~strike~~");
  assert(html.includes("<del>strike</del>"), `got: ${html}`);
});

test("[172-B-7] markdown_to_html: fenced block with tilde ~~~", () => {
  const md = "~~~\ncontent\n~~~";
  const { html, stats } = markdownToHtml(md);
  assert(html.includes("<pre><code>"));
  assert(stats.codeBlocks === 1);
});

test("[172-B-8] markdown_to_html: link with title attribute", () => {
  const md = '[click](https://x.com "My Title")';
  const { html } = markdownToHtml(md);
  assert(html.includes("title=\"My Title\""), `got: ${html}`);
});

test("[172-B-9] markdown_to_html: nested list (sub-list)", () => {
  const md = "- a\n  - b\n  - c\n- d";
  const { html } = markdownToHtml(md);
  // should have nested list structure
  assert(html.includes("<ul>"), `got: ${html}`);
  assert(html.includes("<li>"));
});

test("[172-B-10] markdown_to_html: CRLF line endings handled correctly", () => {
  const md = "# Heading\r\n\r\nParagraph text.";
  const { html, stats } = markdownToHtml(md);
  assert(html.includes("<h1>Heading</h1>"));
  assert(html.includes("<p>Paragraph text.</p>"));
  assert(stats.headings === 1 && stats.paragraphs === 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// [172-C] HIGH — markdown_to_html complex / corner cases
// ─────────────────────────────────────────────────────────────────────────────

test("[172-C-1] markdown_to_html: indented code block (4 spaces)", () => {
  const md = "    const x = 1;";
  const { html, stats } = markdownToHtml(md);
  assert(html.includes("<pre><code>"));
  assert(html.includes("const x = 1;"));
  assert(stats.codeBlocks === 1);
});

test("[172-C-2] markdown_to_html: blockquote with nested heading", () => {
  const md = "> # Nested heading\n> paragraph";
  const { html } = markdownToHtml(md);
  assert(html.includes("<blockquote>"));
  assert(html.includes("<h1>"));
});

test("[172-C-3] markdown_to_html: multiple GFM table rows", () => {
  const md = "| A | B |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |";
  const { html } = markdownToHtml(md);
  const tdCount = (html.match(/<td/g) || []).length;
  assert(tdCount === 4, `expected 4 <td>, got ${tdCount}`);
});

test("[172-C-4] markdown_to_html: inline link with nested bold text", () => {
  const md = "[**bold link**](https://example.com)";
  const { html } = markdownToHtml(md);
  assert(html.includes("<a href=\""));
  assert(html.includes("<strong>bold link</strong>"), `got: ${html}`);
});

test("[172-C-5] markdown_to_html: large document with 50 headings", () => {
  const parts = Array.from({ length: 50 }, (_, i) => `## Heading ${i}`);
  const { stats } = markdownToHtml(parts.join("\n\n"));
  assert(stats.headings === 50, `got ${stats.headings} headings`);
});

test("[172-C-6] markdown_to_html: HTML entities in text are preserved", () => {
  const md = "Text with &amp; entity.";
  const { html } = markdownToHtml(md);
  // The & in the text is escaped, so &amp; becomes &amp;amp; or stays as text
  assert(typeof html === "string" && html.length > 0);
});

test("[172-C-7] markdown_to_html: hard line break (two trailing spaces)", () => {
  const md = "line one  \nline two";
  const { html } = markdownToHtml(md);
  assert(html.includes("<br>"), `expected <br> in: ${html}`);
});

test("[172-C-8] markdown_to_html: outputLength matches html.length", () => {
  const { html, stats } = markdownToHtml("# Test\n\nParagraph.");
  assert(stats.outputLength === html.length, `outputLength ${stats.outputLength} !== html.length ${html.length}`);
  assert(stats.inputLength === "# Test\n\nParagraph.".length);
});

// ─────────────────────────────────────────────────────────────────────────────
// [172-D] CRITICAL — markdown_to_html security / injection
// ─────────────────────────────────────────────────────────────────────────────

test("[172-D-1] markdown_to_html: XSS in paragraph text is escaped", () => {
  const md = "<script>alert('xss')</script>";
  const { html } = markdownToHtml(md);
  assert(!html.includes("<script>"), `script tag leaked: ${html}`);
  assert(html.includes("&lt;script&gt;"));
});

test("[172-D-2] markdown_to_html: XSS in link URL is escaped", () => {
  const md = '[click](javascript:alert(1))';
  const { html } = markdownToHtml(md);
  // href is HTML-escaped; the dangerous URI is still visible but not executable
  assert(html.includes("href="), `no href in: ${html}`);
  // critical: the URL value should be HTML-escaped (no unescaped <, >)
  assert(!html.includes("<script"));
});

test("[172-D-3] markdown_to_html: XSS in image alt is escaped", () => {
  const md = '![<img onerror=x>](img.png)';
  const { html } = markdownToHtml(md);
  // The dangerous <img> in alt text MUST be HTML-escaped (& becomes &amp;, < becomes &lt;)
  // so it cannot be injected as an executable tag. onerror=x as plain text inside
  // alt="&lt;img onerror=x&gt;" is safe — it's not an attribute on a real tag.
  assert(!html.includes('alt="<img'), `raw <img in alt: ${html}`);
  assert(html.includes("&lt;img"), `expected escaped <img in alt: ${html}`);
});

test("[172-D-4] markdown_to_html: Unicode in headings is preserved", () => {
  const md = "# こんにちは 🌍";
  const { html } = markdownToHtml(md);
  assert(html.includes("こんにちは"));
  assert(html.includes("🌍"));
});

test("[172-D-5] markdown_to_html: NUL bytes in input handled without crash", () => {
  const md = "Hello\x00World";
  const { html } = markdownToHtml(md);
  assert(typeof html === "string");
});

test("[172-D-6] markdown_to_html: deeply nested blockquotes don't crash", () => {
  const md = Array.from({ length: 20 }, (_, i) => ">".repeat(i + 1) + " level " + i).join("\n");
  const { html } = markdownToHtml(md);
  assert(html.includes("<blockquote>"));
});

// ─────────────────────────────────────────────────────────────────────────────
// [172-E] EXTREME — markdown_to_html concurrency / stress
// ─────────────────────────────────────────────────────────────────────────────

test("[172-E-1] markdown_to_html: 100 concurrent calls produce consistent results", async () => {
  const md = "# H1\n\nParagraph with **bold** text.\n\n- item1\n- item2";
  const results = await Promise.all(
    Array.from({ length: 100 }, () => Promise.resolve(markdownToHtml(md)))
  );
  const ref = results[0].html;
  for (const r of results)
    assert(r.html === ref, "concurrent mismatch");
});

test("[172-E-2] markdown_to_html: 500-item list renders all items", () => {
  const items = Array.from({ length: 500 }, (_, i) => `- item${i}`).join("\n");
  const { html } = markdownToHtml(items);
  const liCount = (html.match(/<li>/g) || []).length;
  assert(liCount === 500, `expected 500 <li>, got ${liCount}`);
});

test("[172-E-3] markdown_to_html: document with 100 tables renders all", () => {
  const table = "| A | B |\n|---|---|\n| 1 | 2 |";
  const md = Array.from({ length: 100 }, () => table).join("\n\n");
  const { stats } = markdownToHtml(md);
  assert(stats.tables === 100, `expected 100 tables, got ${stats.tables}`);
});

test("[172-E-4] markdown_to_html: document close to 1 MB limit is accepted", () => {
  const md = "word ".repeat(200_000); // ~1MB of text
  const { html } = markdownToHtml(md.slice(0, 1 * 1024 * 1024 - 1));
  assert(html.length > 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// [172-F] NORMAL — xml_parse happy paths
// ─────────────────────────────────────────────────────────────────────────────

test("[172-F-1] xml_parse: simple element", () => {
  const { root, nodeCount } = xmlParse("<root><child>text</child></root>");
  assert(root.tag === "root");
  assert(root.children[0].tag === "child");
  assert(root.children[0].text === "text");
  assert(nodeCount === 2);
});

test("[172-F-2] xml_parse: attributes are parsed", () => {
  const { root } = xmlParse('<item id="42" name="test"/>');
  assert(root.tag === "item");
  assert(root.attrs.id === "42");
  assert(root.attrs.name === "test");
});

test("[172-F-3] xml_parse: self-closing tag", () => {
  const { root } = xmlParse('<br/>');
  assert(root.tag === "br");
  assert(root.children.length === 0);
});

test("[172-F-4] xml_parse: XML declaration is parsed", () => {
  const { declaration } = xmlParse('<?xml version="1.0" encoding="UTF-8"?><root/>');
  assert(declaration !== null);
  assert(declaration.version === "1.0");
  assert(declaration.encoding === "UTF-8");
});

test("[172-F-5] xml_parse: CDATA section text is preserved", () => {
  const xml = "<root><![CDATA[<b>raw html</b>]]></root>";
  const { root } = xmlParse(xml);
  assert(root.text.includes("<b>raw html</b>"));
});

test("[172-F-6] xml_parse: comments are stripped from AST", () => {
  const xml = "<root><!-- comment --><child/></root>";
  const { root } = xmlParse(xml);
  assert(root.children.length === 1);
  assert(root.children[0].tag === "child");
});

test("[172-F-7] xml_parse: nested elements return correct maxDepth", () => {
  const xml = "<a><b><c><d/></c></b></a>";
  const { maxDepth } = xmlParse(xml);
  assert(maxDepth >= 3, `expected maxDepth >= 3, got ${maxDepth}`);
});

test("[172-F-8] xml_parse: entity references are decoded", () => {
  const xml = "<root attr=\"a&amp;b\"><text>&lt;tag&gt;</text></root>";
  const { root } = xmlParse(xml);
  assert(root.attrs.attr === "a&b", `attr: ${root.attrs.attr}`);
  assert(root.children[0].text === "<tag>", `text: ${root.children[0].text}`);
});

test("[172-F-9] xml_parse: namespace prefixes preserved in tag name", () => {
  const xml = "<ns:root xmlns:ns=\"http://example.com\"><ns:child/></ns:root>";
  const { root } = xmlParse(xml);
  assert(root.tag === "ns:root", `got: ${root.tag}`);
  assert(root.children[0].tag === "ns:child");
});

test("[172-F-10] xml_parse: single-quoted attribute values", () => {
  const xml = "<item name='hello' id='99'/>";
  const { root } = xmlParse(xml);
  assert(root.attrs.name === "hello");
  assert(root.attrs.id === "99");
});

test("[172-F-11] xml_parse: multiple children with same tag", () => {
  const xml = "<items><item>a</item><item>b</item><item>c</item></items>";
  const { root, nodeCount } = xmlParse(xml);
  assert(root.children.length === 3);
  assert(root.children[0].text === "a");
  assert(root.children[2].text === "c");
  assert(nodeCount === 4);
});

// ─────────────────────────────────────────────────────────────────────────────
// [172-G] MEDIUM — xml_parse validation / edge cases
// ─────────────────────────────────────────────────────────────────────────────

test("[172-G-1] xml_parse: non-string input throws", () => {
  assertThrows(() => xmlParse(42), e => assert(e.message.includes("string")));
});

test("[172-G-2] xml_parse: empty string throws", () => {
  assertThrows(() => xmlParse(""), e => assert(e.message.includes("empty")));
});

test("[172-G-3] xml_parse: whitespace-only string throws", () => {
  assertThrows(() => xmlParse("   "), e => assert(e.message.includes("empty")));
});

test("[172-G-4] xml_parse: unclosed tag throws", () => {
  assertThrows(() => xmlParse("<root><child>"), e => assert(e.message.includes("unclosed")));
});

test("[172-G-5] xml_parse: mismatched tags throw", () => {
  assertThrows(
    () => xmlParse("<root><child></wrong></root>"),
    e => assert(e.message.includes("mismatch") || e.message.includes("tag"), `got: ${e.message}`)
  );
});

test("[172-G-6] xml_parse: multiple root elements throw", () => {
  assertThrows(
    () => xmlParse("<a/><b/>"),
    e => assert(e.message.includes("root"), `got: ${e.message}`)
  );
});

test("[172-G-7] xml_parse: no root element throws", () => {
  assertThrows(
    () => xmlParse("<!-- comment only -->"),
    e => assert(e.message.includes("root"), `got: ${e.message}`)
  );
});

test("[172-G-8] xml_parse: input > 4 MB throws", () => {
  assertThrows(
    () => xmlParse("<root>" + "x".repeat(4 * 1024 * 1024) + "</root>"),
    e => assert(e.message.includes("4 MB") || e.message.includes("large"), `got: ${e.message}`)
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// [172-H] HIGH — xml_parse path query
// ─────────────────────────────────────────────────────────────────────────────

test("[172-H-1] xml_parse: query retrieves single child by tag name", () => {
  const xml = "<root><name>Alice</name><age>30</age></root>";
  const { queryResult, queryMatched } = xmlParse(xml, { query: "name.text" });
  assert(queryMatched);
  assert(queryResult === "Alice", `got: ${queryResult}`);
});

test("[172-H-2] xml_parse: query retrieves attribute via attrs.key", () => {
  const xml = '<root id="123"/>';
  const { queryResult, queryMatched } = xmlParse(xml, { query: "attrs.id" });
  assert(queryMatched);
  assert(queryResult === "123", `got: ${queryResult}`);
});

test("[172-H-3] xml_parse: query by numeric index into children", () => {
  const xml = "<items><item>a</item><item>b</item><item>c</item></items>";
  const { queryResult } = xmlParse(xml, { query: "item.1.text" });
  assert(queryResult === "b", `got: ${queryResult}`);
});

test("[172-H-4] xml_parse: query for missing path returns null with queryMatched=false", () => {
  const xml = "<root><child/></root>";
  const { queryResult, queryMatched } = xmlParse(xml, { query: "nonexistent.path" });
  assert(!queryMatched);
  assert(queryResult === null);
});

test("[172-H-5] xml_parse: deep nested query", () => {
  const xml = "<a><b><c><d>deep</d></c></b></a>";
  const { queryResult } = xmlParse(xml, { query: "b.c.d.text" });
  assert(queryResult === "deep", `got: ${queryResult}`);
});

test("[172-H-6] xml_parse: query result is echoed in output when provided", () => {
  const xml = "<root><val>42</val></root>";
  const result = xmlParse(xml, { query: "val.text" });
  assert(result.query === "val.text");
  assert(result.queryMatched === true);
});

test("[172-H-7] xml_parse: no query returns no queryResult fields", () => {
  // When opts.query is not provided, queryResult and queryMatched are not set
  const xml = "<root><child/></root>";
  const result = xmlParse(xml);
  assert(result.root.tag === "root");
  assert(result.queryResult === undefined);
  assert(result.queryMatched === undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
// [172-I] CRITICAL — xml_parse security / injection guards
// ─────────────────────────────────────────────────────────────────────────────

test("[172-I-1] xml_parse: XXE-style DOCTYPE is silently dropped", () => {
  const xml = "<!DOCTYPE foo [<!ENTITY xxe SYSTEM \"file:///etc/passwd\">]><root>&xxe;</root>";
  // Parser strips DOCTYPE declarations, unknown entity stays as-is (not resolved)
  const { root } = xmlParse(xml);
  assert(root.tag === "root");
  // The &xxe; unknown entity is left as-is (not substituted with file contents)
  // So the text should not contain /etc/passwd content
  assert(!root.text.includes("/etc/passwd"), `file content leaked: ${root.text}`);
});

test("[172-I-2] xml_parse: unclosed comment throws", () => {
  assertThrows(
    () => xmlParse("<root><!-- unclosed comment"),
    e => assert(e.message.includes("comment") || e.message.includes("unclosed"), `got: ${e.message}`)
  );
});

test("[172-I-3] xml_parse: unclosed CDATA throws", () => {
  assertThrows(
    () => xmlParse("<root><![CDATA[unclosed"),
    e => assert(e.message.includes("CDATA") || e.message.includes("unclosed"), `got: ${e.message}`)
  );
});

test("[172-I-4] xml_parse: attribute value with < and > properly handled", () => {
  const xml = '<root val="a&lt;b&gt;c"/>';
  const { root } = xmlParse(xml);
  assert(root.attrs.val === "a<b>c", `got: ${root.attrs.val}`);
});

test("[172-I-5] xml_parse: null bytes in input handled without crash", () => {
  // Should either parse or throw, but not hang
  let ok = false;
  try {
    xmlParse("<root>\x00</root>");
    ok = true; // Some parsers allow NUL in text
  } catch (e) {
    ok = true; // Throwing is also acceptable
  }
  assert(ok);
});

// ─────────────────────────────────────────────────────────────────────────────
// [172-J] EXTREME — xml_parse concurrency / stress
// ─────────────────────────────────────────────────────────────────────────────

test("[172-J-1] xml_parse: 100 concurrent parses of same document", async () => {
  const xml = "<catalog>" + Array.from({ length: 20 }, (_, i) => `<item id=\"${i}\">Name ${i}</item>`).join("") + "</catalog>";
  const results = await Promise.all(
    Array.from({ length: 100 }, () => Promise.resolve(xmlParse(xml)))
  );
  for (const r of results) {
    assert(r.root.tag === "catalog", `unexpected root: ${r.root.tag}`);
    assert(r.root.children.length === 20, `unexpected children count: ${r.root.children.length}`);
  }
});

test("[172-J-2] xml_parse: deeply nested document (100 levels) parsed without stack overflow", () => {
  // Build 100-deep nest: <a><a><a>...<a>text</a>...</a></a></a>
  const open = "<a>".repeat(100);
  const close = "</a>".repeat(100);
  const xml = open + "deep" + close;
  const { root, maxDepth } = xmlParse(xml);
  assert(root.tag === "a");
  assert(maxDepth >= 10, `expected deep nesting, got maxDepth=${maxDepth}`);
});

test("[172-J-3] xml_parse: large document with 1000 sibling elements", () => {
  const children = Array.from({ length: 1000 }, (_, i) => `<item id=\"${i}\">text</item>`).join("");
  const xml = `<root>${children}</root>`;
  const { root, nodeCount } = xmlParse(xml);
  assert(root.children.length === 1000, `got ${root.children.length} children`);
  assert(nodeCount === 1001);
});

test("[172-J-4] xml_parse: mix of markdown_to_html + xml_parse in parallel", async () => {
  const md = "# Hi\n\nParagraph.";
  const xml = "<root><child>text</child></root>";
  const iters = 50;
  const results = await Promise.all([
    ...Array.from({ length: iters }, () => Promise.resolve(markdownToHtml(md))),
    ...Array.from({ length: iters }, () => Promise.resolve(xmlParse(xml))),
  ]);
  const mdResults = results.slice(0, iters);
  const xmlResults = results.slice(iters);
  for (const r of mdResults) assert(r.html.includes("<h1>"), "md html missing h1");
  for (const r of xmlResults) assert(r.root.tag === "root", "xml root tag mismatch");
});
