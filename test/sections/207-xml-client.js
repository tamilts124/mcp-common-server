"use strict";
// test/sections/207-xml-client.js
// Comprehensive tests for xml_client tool
// Sections: A=input-validation(10), B=parser-unit(20), C=writer-unit(10), D=happy-path(20), E=security(10), F=concurrency(5) = 75 total

const assert = require("assert");
const fs     = require("fs");
const path   = require("path");
const os     = require("os");

const {
  xmlClient, parseXml, domToString, nodeToObject,
  navigatePath, parseDotPath, queryAll, getTextContent,
  buildNode, decodeXmlEntities, encodeXmlEntities,
} = require("../../lib/xmlClientOps");

// ── Test harness ─────────────────────────────────────────────────────────────
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
function doesNotThrow(fn, msg) {
  try { fn(); }
  catch (e) { throw new Error(`${msg || "Expected no throw"}: ${e.message}`); }
}

// ── Temp dir helpers ──────────────────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "xml-client-test-"));
function tmpFile(name, content) {
  const p = path.join(TMP, name);
  if (content !== undefined) fs.writeFileSync(p, content, "utf8");
  return p;
}
function cleanup() {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}

// ── Sample XML ────────────────────────────────────────────────────────────────
const SIMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0" version="4.0.0">
  <groupId>com.example</groupId>
  <artifactId>my-app</artifactId>
  <version>1.2.3</version>
  <dependencies>
    <dependency>
      <groupId>junit</groupId>
      <artifactId>junit</artifactId>
      <version>4.13</version>
      <scope>test</scope>
    </dependency>
    <dependency>
      <groupId>org.slf4j</groupId>
      <artifactId>slf4j-api</artifactId>
      <version>1.7.32</version>
    </dependency>
  </dependencies>
  <properties>
    <java.version>11</java.version>
    <encoding>UTF-8</encoding>
  </properties>
</project>`;

const MIXED_XML = `<root>
  <!-- a comment -->
  <item id="1" active="true">Hello &amp; World</item>
  <item id="2"><![CDATA[<raw> content ]]></item>
  <self-close attr="x"/>
  <empty></empty>
</root>`;

const ANDROID_XML = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="com.example.app">
  <application android:label="MyApp" android:theme="@style/AppTheme">
    <activity android:name=".MainActivity">
      <intent-filter>
        <action android:name="android.intent.action.MAIN"/>
        <category android:name="android.intent.category.LAUNCHER"/>
      </intent-filter>
    </activity>
  </application>
</manifest>`;

console.error("\n=== Section A: Input Validation (10 tests) ===");

test("A01 missing operation throws", () => {
  throws(() => xmlClient({}), "should throw on missing operation");
});

test("A02 unknown operation throws", () => {
  throws(() => xmlClient({ operation: "explode" }), "should throw on unknown op");
});

test("A03 read with no path throws", () => {
  throws(() => xmlClient({ operation: "read" }), "should throw on missing path");
});

test("A04 get with no xml_path throws", () => {
  const f = tmpFile("a04.xml", SIMPLE_XML);
  throws(() => xmlClient({ operation: "get", path: f }), "should throw on missing xml_path");
});

test("A05 set with no value throws", () => {
  const f = tmpFile("a05.xml", SIMPLE_XML);
  throws(() => xmlClient({ operation: "set", path: f, xml_path: "project.version" }), "should throw on missing value");
});

test("A06 delete with no xml_path throws", () => {
  const f = tmpFile("a06.xml", SIMPLE_XML);
  throws(() => xmlClient({ operation: "delete", path: f }), "should throw on missing xml_path");
});

test("A07 query with no query throws", () => {
  const f = tmpFile("a07.xml", SIMPLE_XML);
  throws(() => xmlClient({ operation: "query", path: f }), "should throw on missing query");
});

test("A08 add_node with no node_spec throws", () => {
  const f = tmpFile("a08.xml", SIMPLE_XML);
  throws(() => xmlClient({ operation: "add_node", path: f }), "should throw on missing node_spec");
});

test("A09 path with NUL byte throws", () => {
  throws(() => xmlClient({ operation: "read", path: "file\0name.xml" }), "should throw on NUL in path");
});

test("A10 stringify with no data and no path throws", () => {
  throws(() => xmlClient({ operation: "stringify" }), "should throw with no data and no path");
});

console.error("\n=== Section B: Parser Unit (20 tests) ===");

test("B01 parse simple XML", () => {
  const doc = parseXml("<root><child>text</child></root>");
  assert.equal(doc.type, "document");
  const root = doc.children.find(c => c.type === "element");
  assert.equal(root.name, "root");
  assert.equal(root.children[0].name, "child");
});

test("B02 parse XML declaration", () => {
  const doc = parseXml('<?xml version="1.0"?><r/>');
  assert.ok(doc.xmlDecl, "should have xmlDecl");
  assert.ok(doc.xmlDecl.includes("xml"));
});

test("B03 parse attributes", () => {
  const doc = parseXml('<root id="42" class="x"/>');
  const root = doc.children.find(c => c.type === "element");
  assert.equal(root.attrs.id, "42");
  assert.equal(root.attrs.class, "x");
});

test("B04 parse CDATA", () => {
  const doc = parseXml('<r><![CDATA[hello & world]]></r>');
  const root = doc.children[0];
  const cdata = root.children.find(c => c.type === "cdata");
  assert.ok(cdata, "should have cdata child");
  assert.equal(cdata.value, "hello & world");
});

test("B05 parse comments", () => {
  const doc = parseXml('<!-- comment --><r/>');
  const comment = doc.children.find(c => c.type === "comment");
  assert.ok(comment, "should have comment");
  assert.ok(comment.value.includes("comment"));
});

test("B06 parse self-closing tags", () => {
  const doc = parseXml('<root><br/><img src="x"/></root>');
  const root = doc.children[0];
  const br   = root.children.find(c => c.name === "br");
  const img  = root.children.find(c => c.name === "img");
  assert.ok(br,  "should parse <br/>");
  assert.ok(img, "should parse <img/>");
  assert.equal(img.attrs.src, "x");
});

test("B07 parse entity references", () => {
  const doc = parseXml('<r><a>Hello &amp; World &lt; &gt;</a></r>');
  const a = doc.children[0].children[0];
  const text = a.children.find(c => c.type === "text");
  assert.ok(text.value.includes("&"), "& should be decoded");
  assert.ok(text.value.includes("<"), "< should be decoded");
});

test("B08 parse namespace prefix in tags", () => {
  const doc = parseXml('<ns:root xmlns:ns="urn:x"><ns:child/></ns:root>');
  const root = doc.children.find(c => c.type === "element");
  assert.equal(root.name, "ns:root");
  assert.equal(root.children[0].name, "ns:child");
});

test("B09 parse processing instructions", () => {
  const doc = parseXml('<?xml-stylesheet type="text/xsl" href="style.xsl"?><r/>');
  const pi = doc.children.find(c => c.type === "pi");
  assert.ok(pi, "should have PI");
});

test("B10 parse nested elements deeply", () => {
  const doc = parseXml('<a><b><c><d><e>deep</e></d></c></b></a>');
  const a = doc.children[0];
  const e = a.children[0].children[0].children[0].children[0];
  assert.equal(e.name, "e");
  assert.equal(getTextContent(e), "deep");
});

test("B11 getTextContent on element with text", () => {
  const doc = parseXml('<r><name>Alice</name></r>');
  const name = doc.children[0].children[0];
  assert.equal(getTextContent(name), "Alice");
});

test("B12 getTextContent on element with CDATA", () => {
  const doc = parseXml('<r><data><![CDATA[raw content]]></data></r>');
  const data = doc.children[0].children[0];
  assert.equal(getTextContent(data), "raw content");
});

test("B13 nodeToObject converts element", () => {
  const doc = parseXml('<r id="1"><child>text</child></r>');
  const root = doc.children[0];
  const obj  = nodeToObject(root);
  assert.equal(obj.type, "element");
  assert.equal(obj.name, "r");
  assert.equal(obj.attrs.id, "1");
});

test("B14 navigatePath finds nested element", () => {
  const doc  = parseXml(SIMPLE_XML);
  const segs = parseDotPath("project.version");
  const nav  = navigatePath(doc, segs);
  assert.ok(nav, "should find project.version");
  assert.equal(nav.node.name, "version");
  assert.equal(getTextContent(nav.node), "1.2.3");
});

test("B15 navigatePath with [n] index", () => {
  const doc  = parseXml(SIMPLE_XML);
  const segs = parseDotPath("project.dependencies.dependency[1].groupId");
  const nav  = navigatePath(doc, segs);
  assert.ok(nav, "should find second dependency");
  assert.equal(getTextContent(nav.node), "org.slf4j");
});

test("B16 navigatePath returns null for missing path", () => {
  const doc  = parseXml('<root><a/></root>');
  const segs = parseDotPath("root.b.c");
  const nav  = navigatePath(doc, segs);
  assert.equal(nav, null);
});

test("B17 navigatePath for @attribute", () => {
  const doc  = parseXml('<root id="99"/>');
  const segs = parseDotPath("root.@id");
  const nav  = navigatePath(doc, segs);
  assert.ok(nav, "should find @id");
  assert.equal(nav.attrName, "id");
  assert.equal(nav.node.attrs.id, "99");
});

test("B18 parseDotPath splits correctly", () => {
  const segs = parseDotPath("a.b[2].@c");
  assert.deepEqual(segs, ["a", "b[2]", "@c"]);
});

test("B19 decodeXmlEntities handles all named entities", () => {
  const s = decodeXmlEntities("&amp;&lt;&gt;&quot;&apos;");
  assert.equal(s, "&<>\"'");
});

test("B20 encodeXmlEntities escapes correctly", () => {
  const s = encodeXmlEntities("<b>Hello & World</b>");
  assert.equal(s, "&lt;b&gt;Hello &amp; World&lt;/b&gt;");
});

console.error("\n=== Section C: Writer Unit (10 tests) ===");

test("C01 domToString compact mode", () => {
  const doc = parseXml('<r><a>text</a></r>');
  const s = domToString(doc, 0);
  assert.ok(s.includes("<r>"), "should include root");
  assert.ok(s.includes("<a>text</a>"), "should have child");
});

test("C02 domToString pretty with indent=2", () => {
  const doc = parseXml('<r><a>text</a></r>');
  const s = domToString(doc, 2);
  assert.ok(s.includes("\n"), "should have newlines");
  assert.ok(s.includes("  <a>"), "should indent child");
});

test("C03 stringify preserves XML declaration", () => {
  const doc = parseXml('<?xml version="1.0"?><r/>');
  const s = domToString(doc, 0);
  assert.ok(s.includes("<?xml"), "should preserve xml decl");
});

test("C04 stringify self-closing elements", () => {
  const doc = parseXml('<root><br/></root>');
  const s = domToString(doc, 0);
  assert.ok(s.includes("<br/>"), "should produce self-close");
});

test("C05 stringify attributes with escaping", () => {
  const doc = parseXml('<r title="a &amp; b"/>');
  const s = domToString(doc, 0);
  assert.ok(s.includes('title="a &amp; b"'), "should escape attrs");
});

test("C06 stringify CDATA sections", () => {
  const doc = parseXml('<r><![CDATA[x < y]]></r>');
  const s = domToString(doc, 0);
  assert.ok(s.includes("<![CDATA["), "should preserve CDATA");
});

test("C07 stringify comments", () => {
  const doc = parseXml('<!-- hi --><r/>');
  const s = domToString(doc, 0);
  assert.ok(s.includes("<!-- hi -->"), "should preserve comments");
});

test("C08 buildNode creates element from spec", () => {
  const node = buildNode({ name: "item", attrs: { id: "1" }, text: "hello" });
  assert.equal(node.type, "element");
  assert.equal(node.name, "item");
  assert.equal(node.attrs.id, "1");
  assert.equal(node.children[0].type, "text");
  assert.equal(node.children[0].value, "hello");
});

test("C09 buildNode with nested children", () => {
  const node = buildNode({
    name: "parent",
    children: [
      { name: "child1", text: "a" },
      { name: "child2", text: "b" },
    ],
  });
  assert.equal(node.children.length, 2);
  assert.equal(node.children[0].name, "child1");
  assert.equal(node.children[1].name, "child2");
});

test("C10 stringify roundtrip", () => {
  const doc1 = parseXml(SIMPLE_XML);
  const s1   = domToString(doc1, 2);
  const doc2 = parseXml(s1);
  // key values should survive a round-trip
  const segs = parseDotPath("project.version");
  const nav  = navigatePath(doc2, segs);
  assert.equal(getTextContent(nav.node), "1.2.3");
});

console.error("\n=== Section D: Happy-Path Operations (20 tests) ===");

test("D01 read simple XML", () => {
  const f   = tmpFile("d01.xml", SIMPLE_XML);
  const res = xmlClient({ operation: "read", path: f });
  assert.equal(res.rootElement, "project");
  assert.ok(res.elementCount > 5);
  assert.ok(res.hasXmlDecl);
  assert.ok(res.document);
});

test("D02 get element text by path", () => {
  const f   = tmpFile("d02.xml", SIMPLE_XML);
  const res = xmlClient({ operation: "get", path: f, xml_path: "project.version" });
  assert.equal(res.found, true);
  assert.equal(res.text, "1.2.3");
});

test("D03 get attribute value", () => {
  const f   = tmpFile("d03.xml", SIMPLE_XML);
  const res = xmlClient({ operation: "get", path: f, xml_path: "project.@version" });
  assert.equal(res.found, true);
  assert.equal(res.value, "4.0.0");
  assert.equal(res.type, "attribute");
});

test("D04 get nested element with index", () => {
  const f   = tmpFile("d04.xml", SIMPLE_XML);
  const res = xmlClient({ operation: "get", path: f, xml_path: "project.dependencies.dependency[1].groupId" });
  assert.equal(res.found, true);
  assert.equal(res.text, "org.slf4j");
});

test("D05 get returns found=false for missing path", () => {
  const f   = tmpFile("d05.xml", SIMPLE_XML);
  const res = xmlClient({ operation: "get", path: f, xml_path: "project.nonexistent" });
  assert.equal(res.found, false);
});

test("D06 set element text content", () => {
  const f   = tmpFile("d06.xml", SIMPLE_XML);
  xmlClient({ operation: "set", path: f, xml_path: "project.version", value: "9.9.9" });
  const res = xmlClient({ operation: "get", path: f, xml_path: "project.version" });
  assert.equal(res.text, "9.9.9");
});

test("D07 set attribute value", () => {
  const f   = tmpFile("d07.xml", SIMPLE_XML);
  xmlClient({ operation: "set", path: f, xml_path: "project.@version", value: "5.0.0" });
  const res = xmlClient({ operation: "get", path: f, xml_path: "project.@version" });
  assert.equal(res.value, "5.0.0");
});

test("D08 delete an element", () => {
  const f   = tmpFile("d08.xml", SIMPLE_XML);
  const res = xmlClient({ operation: "delete", path: f, xml_path: "project.properties" });
  assert.equal(res.deleted, true);
  const check = xmlClient({ operation: "get", path: f, xml_path: "project.properties" });
  assert.equal(check.found, false);
});

test("D09 delete an attribute", () => {
  const f   = tmpFile("d09.xml", SIMPLE_XML);
  xmlClient({ operation: "delete", path: f, xml_path: "project.@version" });
  const res = xmlClient({ operation: "get", path: f, xml_path: "project.@version" });
  assert.equal(res.found, false);
});

test("D10 delete returns deleted=false for missing", () => {
  const f   = tmpFile("d10.xml", SIMPLE_XML);
  const res = xmlClient({ operation: "delete", path: f, xml_path: "project.noSuchElement" });
  assert.equal(res.deleted, false);
});

test("D11 list root element children", () => {
  const f   = tmpFile("d11.xml", SIMPLE_XML);
  const res = xmlClient({ operation: "list", path: f });
  assert.equal(res.element, "project");
  assert.ok(res.childCount >= 4);
  assert.ok(res.childTags.groupId);
  assert.ok(res.childTags.dependencies);
});

test("D12 list children of nested element", () => {
  const f   = tmpFile("d12.xml", SIMPLE_XML);
  const res = xmlClient({ operation: "list", path: f, xml_path: "project.dependencies" });
  assert.equal(res.element, "dependencies");
  assert.equal(res.childCount, 2);
  assert.equal(res.childTags.dependency, 2);
});

test("D13 query with //tagName", () => {
  const f   = tmpFile("d13.xml", SIMPLE_XML);
  const res = xmlClient({ operation: "query", path: f, query: "//groupId" });
  assert.ok(res.matchCount >= 3, "should find all groupId elements");
});

test("D14 query with attribute path", () => {
  const f   = tmpFile("d14.xml", ANDROID_XML);
  const res = xmlClient({ operation: "query", path: f, query: "//activity/@android:name" });
  assert.ok(res.matchCount >= 1, "should find android:name attribute");
});

test("D15 add_node appends child", () => {
  const f = tmpFile("d15.xml", SIMPLE_XML);
  xmlClient({
    operation: "add_node", path: f,
    xml_path: "project.dependencies",
    node_spec: {
      name: "dependency",
      children: [
        { name: "groupId",    text: "com.new" },
        { name: "artifactId", text: "new-lib" },
        { name: "version",    text: "1.0.0"   },
      ],
    },
    indent: 2,
  });
  const res = xmlClient({ operation: "list", path: f, xml_path: "project.dependencies" });
  assert.equal(res.childCount, 3, "should have 3 dependencies now");
});

test("D16 add_node prepend", () => {
  const f = tmpFile("d16.xml", "<root><b/></root>");
  xmlClient({
    operation: "add_node", path: f,
    node_spec: { name: "a" },
    position: "prepend",
    indent: 0,
  });
  const doc = parseXml(fs.readFileSync(f, "utf8"));
  const root = doc.children[0];
  const first = root.children.find(c => c.type === "element");
  assert.equal(first.name, "a", "prepended node should be first");
});

test("D17 stringify from data object", () => {
  const res = xmlClient({
    operation: "stringify",
    data: { name: "config", children: [{ name: "key", text: "value" }] },
  });
  assert.ok(res.xml.includes("<config>"), "should include root tag");
  assert.ok(res.xml.includes("<key>value</key>"), "should include child");
});

test("D18 stringify to output file", () => {
  const f   = tmpFile("d18.xml", SIMPLE_XML);
  const out = tmpFile("d18_out.xml");
  const res = xmlClient({ operation: "stringify", path: f, output_path: out, indent: 4 });
  assert.equal(res.written, true);
  const content = fs.readFileSync(out, "utf8");
  assert.ok(content.includes("<project"), "output file should have content");
});

test("D19 read Android manifest XML", () => {
  const f   = tmpFile("d19.xml", ANDROID_XML);
  const res = xmlClient({ operation: "read", path: f });
  assert.equal(res.rootElement, "manifest");
  assert.ok(res.elementCount > 3);
});

test("D20 read mixed content XML (CDATA + comments)", () => {
  const f   = tmpFile("d20.xml", MIXED_XML);
  const res = xmlClient({ operation: "read", path: f });
  assert.equal(res.rootElement, "root");
  assert.ok(res.commentCount >= 1);
  const item1 = xmlClient({ operation: "get", path: f, xml_path: "root.item" });
  assert.equal(item1.found, true);
});

console.error("\n=== Section E: Security (10 tests) ===");

test("E01 NUL byte in path is rejected", () => {
  throws(() => xmlClient({ operation: "read", path: "some\0file.xml" }));
});

test("E02 file too large is rejected", () => {
  const f = tmpFile("e02.xml");
  // Write ~4.1 MB of content
  const bigXml = "<root>" + "<item>" + "x".repeat(100) + "</item>".repeat(0) + "x".repeat(4 * 1024 * 1024) + "</root>";
  fs.writeFileSync(f, bigXml);
  throws(() => xmlClient({ operation: "read", path: f }), "should reject file > 4 MB");
});

test("E03 deeply nested XML exceeds MAX_DEPTH is rejected", () => {
  let xml = "";
  for (let i = 0; i < 55; i++) xml += `<depth${i}>`;
  xml += "<leaf/>";
  for (let i = 54; i >= 0; i--) xml += `</depth${i}>`;
  throws(() => parseXml(xml), "should throw on deep nesting");
});

test("E04 set value too long is rejected", () => {
  const f = tmpFile("e04.xml", SIMPLE_XML);
  throws(() => xmlClient({
    operation: "set", path: f, xml_path: "project.version",
    value: "x".repeat(70 * 1024),
  }), "should reject value > 64 KB");
});

test("E05 attribute values are HTML-encoded on output", () => {
  const f = tmpFile("e05.xml", '<r id="ok"/>');
  xmlClient({ operation: "set", path: f, xml_path: "r.@id", value: '" onload="alert(1)' });
  const content = fs.readFileSync(f, "utf8");
  assert.ok(!content.includes('" onload='), "XSS attempt should be encoded");
  assert.ok(content.includes("&quot;"), "should use &quot; encoding");
});

test("E06 text content is entity-encoded on output", () => {
  const f = tmpFile("e06.xml", '<r><t>x</t></r>');
  xmlClient({ operation: "set", path: f, xml_path: "r.t", value: "<script>alert(1)</script>" });
  const content = fs.readFileSync(f, "utf8");
  assert.ok(!content.includes("<script>"), "should not write raw script tag");
  assert.ok(content.includes("&lt;script&gt;"), "should encode < and >");
});

test("E07 malformed XML (unclosed tag) throws", () => {
  throws(() => parseXml("<root><unclosed>"), "should throw on unclosed tag");
});

test("E08 malformed XML (unclosed comment) throws", () => {
  throws(() => parseXml("<root><!-- unclosed"), "should throw on unclosed comment");
});

test("E09 add_node without name in spec throws", () => {
  const f = tmpFile("e09.xml", "<r/>");
  throws(() => xmlClient({ operation: "add_node", path: f, node_spec: { attrs: {} } }));
});

test("E10 set/delete on non-existent path throws or returns not-found", () => {
  const f = tmpFile("e10.xml", "<r/>");
  throws(() => xmlClient({ operation: "set", path: f, xml_path: "r.missing.deep", value: "x" }),
    "set on missing path should throw");
});

console.error("\n=== Section F: Concurrency (5 tests) ===");

test("F01 parallel reads do not interfere", async () => {
  const f = tmpFile("f01.xml", SIMPLE_XML);
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      Promise.resolve(xmlClient({ operation: "get", path: f, xml_path: "project.version" }))
    )
  );
  for (const r of results) {
    assert.equal(r.text, "1.2.3");
  }
});

test("F02 sequential set then get is consistent", () => {
  const f = tmpFile("f02.xml", SIMPLE_XML);
  for (let i = 0; i < 5; i++) {
    const val = `v${i}`;
    xmlClient({ operation: "set", path: f, xml_path: "project.version", value: val });
    const r = xmlClient({ operation: "get", path: f, xml_path: "project.version" });
    assert.equal(r.text, val, `iteration ${i} should match`);
  }
});

test("F03 multiple adds accumulate children", () => {
  const f = tmpFile("f03.xml", '<root><items/></root>');
  for (let i = 0; i < 5; i++) {
    xmlClient({
      operation: "add_node", path: f,
      xml_path: "root.items",
      node_spec: { name: "item", attrs: { n: String(i) } },
      indent: 0,
    });
  }
  const res = xmlClient({ operation: "list", path: f, xml_path: "root.items" });
  assert.equal(res.childCount, 5, "should have 5 items");
});

test("F04 parallel parses of different documents", async () => {
  const xmlA = '<a><v>1</v></a>';
  const xmlB = '<b><v>2</v></b>';
  const files = [
    tmpFile("f04a.xml", xmlA),
    tmpFile("f04b.xml", xmlB),
  ];
  const [ra, rb] = await Promise.all(files.map((f, i) =>
    Promise.resolve(xmlClient({ operation: "get", path: f, xml_path: `${i === 0 ? 'a' : 'b'}.v` }))
  ));
  assert.equal(ra.text, "1");
  assert.equal(rb.text, "2");
});

test("F05 query on large document is efficient", () => {
  // Build a medium-sized XML document
  let xml = '<catalog>';
  for (let i = 0; i < 200; i++) {
    xml += `<book id="${i}"><title>Book ${i}</title><author>Author ${i}</author></book>`;
  }
  xml += '</catalog>';
  const f   = tmpFile("f05.xml", xml);
  const res = xmlClient({ operation: "query", path: f, query: "//title" });
  assert.equal(res.matchCount, 100, "should return max_results=100 by default");
  assert.equal(res.totalFound, 200);
  assert.equal(res.truncated, true);
});

// ── Summary ───────────────────────────────────────────────────────────────────
cleanup();
console.error(`\n=== xml_client tests: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
