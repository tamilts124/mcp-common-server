"use strict";
/**
 * test/sections/171-template-render-base62.js
 * Isolated functional tests for template_render and base62_encode/base62_decode.
 * Section [171] — 5 rigor levels.
 */

const { test } = require("../test-harness");
const { templateRender } = require("../../lib/templateRenderOps");
const { base62Encode, base62Decode, ALPHABET } = require("../../lib/base62Ops");
const { ToolError } = require("../../lib/errors");

function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

// ─────────────────────────────────────────────────────────────────────────────────
// [171-A] NORMAL — template_render happy paths
// ─────────────────────────────────────────────────────────────────────────────────
test("[171-A-1] template_render: simple variable interpolation", () => {
  const r = templateRender({ template: "Hello, {{name}}!", context: { name: "World" } });
  assert(r.rendered === "Hello, World!");
  assert(r.templateLength === "Hello, {{name}}!".length);
  assert(r.renderedLength === "Hello, World!".length);
});

test("[171-A-2] template_render: HTML escaping of {{var}} tags", () => {
  const r = templateRender({ template: "{{msg}}", context: { msg: "<b>bold</b> & 'quoted'" } });
  assert(r.rendered === "&lt;b&gt;bold&lt;/b&gt; &amp; &#x27;quoted&#x27;");
});

test("[171-A-3] template_render: triple-stache {{{var}}} is unescaped", () => {
  const r = templateRender({ template: "{{{html}}}", context: { html: "<b>raw</b>" } });
  assert(r.rendered === "<b>raw</b>", `got: ${r.rendered}`);
});

test("[171-A-4] template_render: {{&var}} is alias for unescaped", () => {
  const r = templateRender({ template: "{{&html}}", context: { html: "<em>x</em>" } });
  assert(r.rendered === "<em>x</em>");
});

test("[171-A-5] template_render: missing variable renders as empty string", () => {
  const r = templateRender({ template: "{{missing}}", context: {} });
  assert(r.rendered === "");
});

test("[171-A-6] template_render: comment tag {{! ... }} is stripped", () => {
  const r = templateRender({ template: "hello{{! this is a comment }}world", context: {} });
  assert(r.rendered === "helloworld");
});

test("[171-A-7] template_render: section #section renders for truthy value", () => {
  const r = templateRender({ template: "{{#show}}visible{{/show}}", context: { show: true } });
  assert(r.rendered === "visible");
});

test("[171-A-8] template_render: section #section skipped for falsy value", () => {
  const r = templateRender({ template: "{{#show}}visible{{/show}}", context: { show: false } });
  assert(r.rendered === "");
});

test("[171-A-9] template_render: inverted section ^section for falsy", () => {
  const r = templateRender({ template: "{{^empty}}fallback{{/empty}}", context: { empty: false } });
  assert(r.rendered === "fallback");
});

test("[171-A-10] template_render: inverted section ^section skipped for truthy", () => {
  const r = templateRender({ template: "{{^show}}hidden{{/show}}", context: { show: true } });
  assert(r.rendered === "");
});

test("[171-A-11] template_render: array section loops over items", () => {
  const r = templateRender({
    template: "{{#items}}{{name}},{{/items}}",
    context: { items: [{ name: "a" }, { name: "b" }, { name: "c" }] },
  });
  assert(r.rendered === "a,b,c,", `got: ${r.rendered}`);
});

test("[171-A-12] template_render: partial {{>name}} is expanded", () => {
  const r = templateRender({
    template: "{{>greeting}} World!",
    context: {},
    partials: { greeting: "Hello" },
  });
  assert(r.rendered === "Hello World!");
});

test("[171-A-13] template_render: dot-notation context access 'user.name'", () => {
  const r = templateRender({
    template: "{{user.name}} ({{user.role}})",
    context: { user: { name: "Alice", role: "admin" } },
  });
  assert(r.rendered === "Alice (admin)");
});

test("[171-A-14] template_render: empty template returns empty string", () => {
  const r = templateRender({ template: "", context: {} });
  assert(r.rendered === "" && r.renderedLength === 0);
});

test("[171-A-15] template_render: no context defaults to empty object", () => {
  const r = templateRender({ template: "{{x}}" });
  assert(r.rendered === "");
});

// ─────────────────────────────────────────────────────────────────────────────────
// [171-B] MEDIUM — template_render validation / edge cases
// ─────────────────────────────────────────────────────────────────────────────────
test("[171-B-1] template_render: non-string template → ToolError", () => {
  let threw = false;
  try { templateRender({ template: 42 }); } catch (e) { threw = true; assert(e instanceof ToolError); }
  assert(threw);
});

test("[171-B-2] template_render: array context → ToolError", () => {
  let threw = false;
  try { templateRender({ template: "x", context: [] }); } catch (e) { threw = true; assert(e instanceof ToolError); }
  assert(threw);
});

test("[171-B-3] template_render: null context → ToolError", () => {
  let threw = false;
  try { templateRender({ template: "x", context: null }); } catch (e) { threw = true; assert(e instanceof ToolError); }
  assert(threw);
});

test("[171-B-4] template_render: partial value not a string → ToolError", () => {
  let threw = false;
  try { templateRender({ template: "{{>p}}", partials: { p: 123 } }); } catch (e) { threw = true; assert(e instanceof ToolError); }
  assert(threw);
});

test("[171-B-5] template_render: unclosed tag emits literal text gracefully", () => {
  const r = templateRender({ template: "start {{unclosed", context: {} });
  assert(r.rendered.startsWith("start "), `got: ${r.rendered}`);
});

test("[171-B-6] template_render: empty array section renders nothing", () => {
  const r = templateRender({ template: "{{#list}}item{{/list}}", context: { list: [] } });
  assert(r.rendered === "");
});

test("[171-B-7] template_render: inverted section with empty array renders block", () => {
  const r = templateRender({ template: "{{^list}}no items{{/list}}", context: { list: [] } });
  assert(r.rendered === "no items");
});

test("[171-B-8] template_render: number value is stringified", () => {
  const r = templateRender({ template: "count={{n}}", context: { n: 42 } });
  assert(r.rendered === "count=42");
});

test("[171-B-9] template_render: nested object value stringifies as JSON in unescaped", () => {
  const r = templateRender({ template: "data={{{obj}}}", context: { obj: { x: 1 } } });
  assert(r.rendered.includes('"x"'), `got: ${r.rendered}`);
});

test("[171-B-10] template_render: section object merges context keys", () => {
  const r = templateRender({
    template: "{{#user}}{{name}} is {{role}}{{/user}}",
    context: { user: { name: "Bob", role: "dev" } },
  });
  assert(r.rendered === "Bob is dev", `got: ${r.rendered}`);
});

// ─────────────────────────────────────────────────────────────────────────────────
// [171-C] HIGH — complex templates, nested partials, large inputs
// ─────────────────────────────────────────────────────────────────────────────────
test("[171-C-1] template_render: partial using context variables", () => {
  const r = templateRender({
    template: "{{#items}}{{>item_row}}{{/items}}",
    context: { items: [{ id: 1, val: "x" }, { id: 2, val: "y" }] },
    partials: { item_row: "{{id}}={{val}}\n" },
  });
  assert(r.rendered === "1=x\n2=y\n", `got: ${r.rendered}`);
});

test("[171-C-2] template_render: nested partials (2 levels)", () => {
  const r = templateRender({
    template: "{{>outer}}",
    context: { name: "World" },
    partials: { outer: "Hello {{>inner}}!", inner: "{{name}}" },
  });
  assert(r.rendered === "Hello World!");
});

test("[171-C-3] template_render: multiple sections in one template", () => {
  const r = templateRender({
    template: "{{#a}}A{{/a}}{{#b}}B{{/b}}{{^c}}C{{/c}}",
    context: { a: true, b: false, c: false },
  });
  assert(r.rendered === "AC", `got: ${r.rendered}`);
});

test("[171-C-4] template_render: large context with 100 items", () => {
  const items = Array.from({ length: 100 }, (_, i) => ({ i }));
  const r = templateRender({ template: "{{#items}}{{i}},{{/items}}", context: { items } });
  assert(r.rendered === items.map(x => `${x.i},`).join(""));
});

test("[171-C-5] template_render: deep dot-notation path 'a.b.c.d'", () => {
  const r = templateRender({
    template: "{{a.b.c.d}}",
    context: { a: { b: { c: { d: "deep" } } } },
  });
  assert(r.rendered === "deep");
});

test("[171-C-6] template_render: array of primitive values with {{.}}", () => {
  const r = templateRender({ template: "{{#nums}}{{.}} {{/nums}}", context: { nums: [1, 2, 3] } });
  assert(r.rendered.trim() === "1 2 3", `got: '${r.rendered}'`);
});

// ─────────────────────────────────────────────────────────────────────────────────
// [171-D] CRITICAL — security / injection guards
// ─────────────────────────────────────────────────────────────────────────────────
test("[171-D-1] template_render: HTML special chars in {{var}} are escaped", () => {
  const xss = "<script>alert('xss')</script>";
  const r = templateRender({ template: "{{payload}}", context: { payload: xss } });
  assert(!r.rendered.includes("<script>"), `raw script tag leaked: ${r.rendered}`);
  assert(r.rendered.includes("&lt;script&gt;"));
});

test("[171-D-2] template_render: {{{var}}} unescaped is intentionally raw", () => {
  const r = templateRender({ template: "{{{html}}}", context: { html: "<b>ok</b>" } });
  assert(r.rendered === "<b>ok</b>");
});

test("[171-D-3] template_render: prototype keys not accessible via template", () => {
  const r = templateRender({ template: "{{constructor}}", context: {} });
  assert(r.rendered === "", `got: ${r.rendered}`);
});

test("[171-D-4] template_render: template > 1 MB throws ToolError", () => {
  const big = "x".repeat(1 * 1024 * 1024 + 1);
  let threw = false;
  try { templateRender({ template: big }); } catch (e) { threw = true; assert(e instanceof ToolError); }
  assert(threw);
});

test("[171-D-5] template_render: circular partial depth guard (> 32 levels)", () => {
  let threw = false;
  try {
    templateRender({ template: "{{>loop}}", context: {}, partials: { loop: "{{>loop}}" } });
  } catch (e) {
    threw = true;
    assert(e instanceof ToolError, `expected ToolError, got ${e.constructor.name}: ${e.message}`);
  }
  assert(threw, "should throw ToolError for circular partial");
});

test("[171-D-6] template_render: NUL bytes in context values handled gracefully", () => {
  const r = templateRender({ template: "{{val}}", context: { val: "hel\x00lo" } });
  assert(typeof r.rendered === "string");
});

// ─────────────────────────────────────────────────────────────────────────────────
// [171-E] EXTREME — concurrency / stress
// ─────────────────────────────────────────────────────────────────────────────────
test("[171-E-1] template_render: 50 concurrent renders produce consistent results", async () => {
  const tmpl = "Hello {{name}}, count={{count}}";
  const ctx  = { name: "Claude", count: 7 };
  const results = await Promise.all(
    Array.from({ length: 50 }, () => Promise.resolve(templateRender({ template: tmpl, context: ctx })))
  );
  for (const r of results)
    assert(r.rendered === "Hello Claude, count=7", `mismatch: ${r.rendered}`);
});

test("[171-E-2] template_render: 500-item loop produces correct output", () => {
  const items = Array.from({ length: 500 }, (_, i) => ({ n: i }));
  const r = templateRender({ template: "{{#items}}x{{/items}}", context: { items } });
  assert(r.rendered === "x".repeat(500), `length=${r.rendered.length}`);
});

// ─────────────────────────────────────────────────────────────────────────────────
// [171-F] NORMAL — base62_encode happy paths
// ─────────────────────────────────────────────────────────────────────────────────
test("[171-F-1] base62_encode: 0 → '0'", () => {
  const r = base62Encode({ number: "0" });
  assert(r.encoded === "0", `got: ${r.encoded}`);
  assert(r.base === 62);
  assert(r.inputType === "number");
});

test("[171-F-2] base62_encode: 62 → '10' (62 = 1*62 + 0)", () => {
  const r = base62Encode({ number: "62" });
  assert(r.encoded === "10", `got: ${r.encoded}`);
});

test("[171-F-3] base62_encode: 61 → 'z' (last char of alphabet)", () => {
  const r = base62Encode({ number: "61" });
  assert(r.encoded === "z", `got: ${r.encoded}`);
  assert(ALPHABET[61] === "z");
});

test("[171-F-4] base62_encode: number as JS number (not string)", () => {
  const r = base62Encode({ number: 123 });
  assert(typeof r.encoded === "string" && r.encoded.length > 0);
});

test("[171-F-5] base62_encode: hex input '0xff' = 255 matches number 255", () => {
  const r   = base62Encode({ hex: "0xff" });
  const ref = base62Encode({ number: "255" }).encoded;
  assert(r.encoded === ref, `hex: ${r.encoded}, num: ${ref}`);
  assert(r.inputType === "hex");
});

test("[171-F-6] base62_encode: min_length pads with leading zeros", () => {
  const r = base62Encode({ number: "1", min_length: 8 });
  assert(r.encoded.length === 8, `got length ${r.encoded.length}`);
  assert(r.encoded === "00000001");
});

test("[171-F-7] base62_encode: large number round-trips correctly", () => {
  const n = "9999999999999";
  const enc = base62Encode({ number: n }).encoded;
  const dec = base62Decode({ encoded: enc });
  assert(dec.decoded === n, `round-trip mismatch: ${dec.decoded} !== ${n}`);
});

test("[171-F-8] base62_encode: bytes input (base64 of 0x01) → same as number 1", () => {
  // base64("\x01") = "AQ=="
  const r   = base62Encode({ bytes: "AQ==" });
  const ref = base62Encode({ number: "1" }).encoded;
  assert(r.encoded === ref, `bytes: ${r.encoded}, num: ${ref}`);
  assert(r.inputType === "bytes");
});

test("[171-F-9] base62_encode: alphabet is 0-9A-Za-z (62 chars)", () => {
  assert(ALPHABET.length === 62);
  assert(ALPHABET[0] === "0" && ALPHABET[9] === "9");
  assert(ALPHABET[10] === "A" && ALPHABET[35] === "Z");
  assert(ALPHABET[36] === "a" && ALPHABET[61] === "z");
});

test("[171-F-10] base62_encode: inputBigInt echoed back as decimal string", () => {
  const r = base62Encode({ number: "12345" });
  assert(r.inputBigInt === "12345");
});

// ─────────────────────────────────────────────────────────────────────────────────
// [171-G] NORMAL — base62_decode happy paths
// ─────────────────────────────────────────────────────────────────────────────────
test("[171-G-1] base62_decode: '0' → 0 (decimal)", () => {
  const r = base62Decode({ encoded: "0" });
  assert(r.decoded === "0", `got: ${r.decoded}`);
  assert(r.outputFormat === "decimal");
});

test("[171-G-2] base62_decode: '10' → 62", () => {
  const r = base62Decode({ encoded: "10" });
  assert(r.decoded === "62", `got: ${r.decoded}`);
});

test("[171-G-3] base62_decode: hex output format", () => {
  const r = base62Decode({ encoded: "10", output: "hex" });
  // 62 in hex = "3e"
  assert(r.decoded === "3e", `got: ${r.decoded}`);
  assert(r.outputFormat === "hex");
});

test("[171-G-4] base62_decode: bytes output format returns base64", () => {
  const enc = base62Encode({ number: "255" }).encoded;
  const r   = base62Decode({ encoded: enc, output: "bytes" });
  assert(r.outputFormat === "bytes");
  // decode base64 and check value = 255
  const buf = Buffer.from(r.decoded, "base64");
  assert(buf.readUInt8(buf.length - 1) === 255, `last byte=${buf.readUInt8(buf.length - 1)}`);
});

test("[171-G-5] base62_decode: decodedBigInt echoed back as decimal", () => {
  // '1' in base62 is 1 (second char of alphabet is '1')
  const r = base62Decode({ encoded: "1" });
  assert(r.decodedBigInt === "1");
});

test("[171-G-6] base62_decode: round-trip for 20 random large values", () => {
  for (let i = 0; i < 20; i++) {
    const n = String(Math.floor(Math.random() * 1e12 + 1));
    const enc = base62Encode({ number: n }).encoded;
    const dec = base62Decode({ encoded: enc });
    assert(dec.decoded === n, `failed at n=${n}: dec=${dec.decoded}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────────
// [171-H] MEDIUM — base62 validation / edge inputs
// ─────────────────────────────────────────────────────────────────────────────────
test("[171-H-1] base62_encode: no input → ToolError", () => {
  let threw = false;
  try { base62Encode({}); } catch (e) { threw = true; assert(e instanceof ToolError); }
  assert(threw);
});

test("[171-H-2] base62_encode: multiple inputs → ToolError", () => {
  let threw = false;
  try { base62Encode({ number: "1", hex: "ff" }); } catch (e) { threw = true; assert(e instanceof ToolError); }
  assert(threw);
});

test("[171-H-3] base62_encode: negative number string → ToolError", () => {
  let threw = false;
  try { base62Encode({ number: "-1" }); } catch (e) { threw = true; assert(e instanceof ToolError); }
  assert(threw);
});

test("[171-H-4] base62_encode: invalid hex chars → ToolError", () => {
  let threw = false;
  try { base62Encode({ hex: "GGGG" }); } catch (e) { threw = true; assert(e instanceof ToolError); }
  assert(threw);
});

test("[171-H-5] base62_encode: empty hex → ToolError", () => {
  let threw = false;
  try { base62Encode({ hex: "" }); } catch (e) { threw = true; assert(e instanceof ToolError); }
  assert(threw);
});

test("[171-H-6] base62_decode: empty string → ToolError", () => {
  let threw = false;
  try { base62Decode({ encoded: "" }); } catch (e) { threw = true; assert(e instanceof ToolError); }
  assert(threw);
});

test("[171-H-7] base62_decode: invalid char '@' → ToolError", () => {
  let threw = false;
  try { base62Decode({ encoded: "abc@def" }); } catch (e) { threw = true; assert(e instanceof ToolError); }
  assert(threw);
});

test("[171-H-8] base62_decode: input exceeding 1024 chars → ToolError", () => {
  let threw = false;
  try { base62Decode({ encoded: "a".repeat(1025) }); } catch (e) { threw = true; assert(e instanceof ToolError); }
  assert(threw);
});

test("[171-H-9] base62_encode: odd-length hex is accepted (padded internally)", () => {
  const r   = base62Encode({ hex: "f" }); // 0x0f = 15
  const ref = base62Encode({ number: "15" }).encoded;
  assert(r.encoded === ref, `odd-hex: ${r.encoded}, num: ${ref}`);
});

// ─────────────────────────────────────────────────────────────────────────────────
// [171-I] HIGH — correctness
// ─────────────────────────────────────────────────────────────────────────────────
test("[171-I-1] base62_encode/decode: round-trip for 0..999", () => {
  for (let i = 0; i <= 999; i++) {
    const enc = base62Encode({ number: String(i) }).encoded;
    const dec = base62Decode({ encoded: enc });
    assert(dec.decoded === String(i), `fail at ${i}: enc=${enc} dec=${dec.decoded}`);
  }
});

test("[171-I-2] base62_encode: hex round-trip via decode hex mode", () => {
  const enc = base62Encode({ hex: "1a2b3c" }).encoded;
  const dec = base62Decode({ encoded: enc, output: "hex" });
  assert(dec.decoded === "1a2b3c", `got: ${dec.decoded}`);
});

test("[171-I-3] base62_encode: each alphabet char encodes correctly at [0..61]", () => {
  for (let i = 0; i < 62; i++) {
    const r = base62Encode({ number: String(i) });
    assert(r.encoded === ALPHABET[i], `i=${i}: got ${r.encoded}, expected ${ALPHABET[i]}`);
  }
});

test("[171-I-4] base62_encode: min_length no-op when encoded is longer", () => {
  const r   = base62Encode({ number: "1000000", min_length: 2 });
  const ref = base62Encode({ number: "1000000" }).encoded;
  assert(r.encoded.length > 2 && r.encoded === ref);
});

test("[171-I-5] base62_encode/decode: hex for all 256 byte values", () => {
  for (let i = 0; i <= 255; i++) {
    const hexIn = i.toString(16).padStart(2, "0");
    const enc = base62Encode({ hex: hexIn }).encoded;
    const dec = base62Decode({ encoded: enc, output: "hex" });
    assert(parseInt(dec.decoded, 16) === i, `byte ${i}: decoded '${dec.decoded}'`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────────
// [171-J] EXTREME — stress / concurrency
// ─────────────────────────────────────────────────────────────────────────────────
test("[171-J-1] base62_encode/decode: 200 concurrent round-trips are consistent", async () => {
  const nums = Array.from({ length: 200 }, (_, i) => String(i * 97 + 1));
  const results = await Promise.all(
    nums.map(n => Promise.resolve((() => {
      const enc = base62Encode({ number: n }).encoded;
      const dec = base62Decode({ encoded: enc });
      return { n, dec: dec.decoded };
    })()))
  );
  for (const { n, dec } of results)
    assert(dec === n, `concurrent mismatch: n=${n} dec=${dec}`);
});

test("[171-J-2] base62_encode: large number (30 digits) round-trips", () => {
  const big = "123456789012345678901234567890";
  const enc = base62Encode({ number: big }).encoded;
  const dec = base62Decode({ encoded: enc });
  assert(dec.decoded === big, `got: ${dec.decoded}`);
});

test("[171-J-3] template_render: 100-item loop x 50 concurrent calls", async () => {
  const items = Array.from({ length: 100 }, (_, i) => ({ n: i }));
  const results = await Promise.all(
    Array.from({ length: 50 }, () =>
      Promise.resolve(templateRender({ template: "{{#items}}{{n}}{{/items}}", context: { items } }))
    )
  );
  const expected = items.map(x => String(x.n)).join("");
  for (const r of results)
    assert(r.rendered === expected, "concurrent loop mismatch");
});

test("[171-J-4] template_render + base62_encode: composed usage in a template", () => {
  const id = base62Encode({ number: "1000000" }).encoded;
  const r  = templateRender({ template: "id={{id}}", context: { id } });
  assert(r.rendered === `id=${id}`, `got: ${r.rendered}`);
});

test("[171-J-5] base62_decode: default output 'decimal' is consistent with decode(encode(n))", () => {
  const testVals = ["0", "1", "61", "62", "3844", "999999", "1000000000"];
  for (const n of testVals) {
    const enc = base62Encode({ number: n }).encoded;
    const dec = base62Decode({ encoded: enc });
    assert(dec.decoded === n, `n=${n} dec=${dec.decoded}`);
    assert(dec.outputFormat === "decimal");
  }
});
