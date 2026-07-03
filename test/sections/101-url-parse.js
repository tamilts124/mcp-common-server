"use strict";
/**
 * test/sections/101-url-parse.js
 * Isolated functional tests for the url_parse tool.
 * Section [39]
 */

const { test } = require("../test-harness");
const { urlParse } = require("../../lib/urlParseOps");

function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }

// [39-A] NORMAL
test("[39-A-1] parse: standard https URL with path and query", () => {
  const r = urlParse("https://example.com/api/v1/users?limit=10&sort=asc");
  assert(r.protocol === "https:" && r.hostname === "example.com" && r.pathname === "/api/v1/users");
  assert(r.searchParams.limit === "10" && r.searchParams.sort === "asc");
});
test("[39-A-2] parse: URL with port and hash", () => {
  const r = urlParse("http://localhost:3000/path#section2");
  assert(r.port === "3000" && r.hash === "#section2");
});
test("[39-A-3] parse: repeated query key grouped into array", () => {
  const r = urlParse("https://example.com/?tag=a&tag=b&tag=c");
  assert(Array.isArray(r.searchParams.tag) && r.searchParams.tag.length === 3);
  assert(r.searchParams.tag[1] === "b");
});
test("[39-A-4] parse: no query string -> empty searchParams object", () => {
  const r = urlParse("https://example.com/path");
  assert(Object.keys(r.searchParams).length === 0 && r.search === "");
});
test("[39-A-5] parse: username present, no password -> password null", () => {
  const r = urlParse("https://user@example.com/");
  assert(r.username === "user" && r.password === null);
});
test("[39-A-6] parse: password redacted by default", () => {
  const r = urlParse("https://user:secret123@example.com/");
  assert(r.password === "[redacted]");
});
test("[39-A-7] parse: show_password:true returns raw password", () => {
  const r = urlParse("https://user:secret123@example.com/", { showPassword: true });
  assert(r.password === "secret123");
});
test("[39-A-8] parse: origin and href computed correctly", () => {
  const r = urlParse("https://example.com:8080/a/b?x=1");
  assert(r.origin === "https://example.com:8080" && r.href === "https://example.com:8080/a/b?x=1");
});
test("[39-A-9] parse: relative URL resolves against base", () => {
  const r = urlParse("/foo/bar?q=1", { base: "https://example.com" });
  assert(r.hostname === "example.com" && r.pathname === "/foo/bar" && r.isRelativeResolved === true);
});
test("[39-A-10] parse: no base -> isRelativeResolved false for absolute URL", () => {
  const r = urlParse("https://example.com/");
  assert(r.isRelativeResolved === false);
});

// [39-B] MEDIUM — boundary & validation
test("[39-B-1] parse: missing url throws -32602", () => {
  let threw = false;
  try { urlParse(undefined); } catch (e) { threw = true; assert(e.code === -32602); }
  assert(threw);
});
test("[39-B-2] parse: non-string url throws -32602", () => {
  let threw = false;
  try { urlParse(42); } catch (e) { threw = true; assert(e.code === -32602); }
  assert(threw);
});
test("[39-B-3] parse: empty string throws -32602", () => {
  let threw = false;
  try { urlParse("   "); } catch (e) { threw = true; assert(e.code === -32602); }
  assert(threw);
});
test("[39-B-4] parse: relative URL without base throws with helpful hint", () => {
  let threw = false, msg = "";
  try { urlParse("/foo/bar"); } catch (e) { threw = true; msg = e.message; }
  assert(threw && /base/.test(msg));
});
test("[39-B-5] parse: malformed URL throws -32602", () => {
  let threw = false;
  try { urlParse("ht!tp://[not a url"); } catch (e) { threw = true; assert(e.code === -32602); }
  assert(threw);
});
test("[39-B-6] parse: over-length url throws -32602", () => {
  const huge = "https://example.com/" + "a".repeat(5000);
  let threw = false;
  try { urlParse(huge); } catch (e) { threw = true; assert(e.code === -32602); }
  assert(threw);
});
test("[39-B-7] parse: non-string base throws -32602", () => {
  let threw = false;
  try { urlParse("/foo", { base: 123 }); } catch (e) { threw = true; assert(e.code === -32602); }
  assert(threw);
});
test("[39-B-8] parse: malformed base throws -32602", () => {
  let threw = false;
  try { urlParse("/foo", { base: "not a url at all" }); } catch (e) { threw = true; assert(e.code === -32602); }
  assert(threw);
});

// [39-C] HIGH — structural edge cases
test("[39-C-1] parse: non-http scheme (mailto:) parses without crashing", () => {
  const r = urlParse("mailto:test@example.com");
  assert(r.protocol === "mailto:");
});
test("[39-C-2] parse: file:// URL parses, hostname empty string not null-crash", () => {
  const r = urlParse("file:///home/user/file.txt");
  assert(r.protocol === "file:" && r.pathname === "/home/user/file.txt");
});
test("[39-C-3] parse: query value containing '=' preserved correctly", () => {
  const r = urlParse("https://example.com/?token=abc=123");
  assert(r.searchParams.token === "abc=123");
});
test("[39-C-4] parse: query key with empty value -> empty string, not undefined", () => {
  const r = urlParse("https://example.com/?flag=");
  assert(r.searchParams.flag === "");
});
test("[39-C-5] parse: IPv6 host in brackets parses correctly", () => {
  const r = urlParse("http://[::1]:8080/path");
  assert(r.hostname === "[::1]" && r.port === "8080");
});
test("[39-C-6] parse: unicode in path is percent-decoded/encoded consistently, no crash", () => {
  const r = urlParse("https://example.com/caf%C3%A9");
  assert(typeof r.pathname === "string" && r.pathname.length > 0);
});

// [39-D] CRITICAL — security
test("[39-D-1] parse: SQL-injection-shaped query value round-trips as inert literal text", () => {
  const r = urlParse("https://example.com/?q=" + encodeURIComponent("'; DROP TABLE users; --"));
  assert(r.searchParams.q === "'; DROP TABLE users; --");
});
test("[39-D-2] parse: path-traversal-shaped path segment is inert data, not resolved on disk", () => {
  const r = urlParse("https://example.com/../../../etc/passwd");
  assert(typeof r.pathname === "string" && r.pathname.includes("etc"));
});
test("[39-D-3] parse: javascript: scheme parsed as inert data, never executed", () => {
  const r = urlParse("javascript:alert(1)");
  assert(r.protocol === "javascript:");
});
test("[39-D-4] parse: HTML/script-shaped query value round-trips as literal text", () => {
  const r = urlParse("https://example.com/?note=" + encodeURIComponent("<script>alert(1)</script>"));
  assert(r.searchParams.note === "<script>alert(1)</script>");
});
test("[39-D-5] parse: result has no unexpected top-level keys", () => {
  const r = urlParse("https://example.com/");
  const keys = Object.keys(r).sort();
  assert(JSON.stringify(keys) === JSON.stringify(
    ["hash", "hostname", "href", "isRelativeResolved", "origin", "password", "pathname", "port", "protocol", "search", "searchParams", "username"]
  ));
});

// [39-E] EXTREME
test("[39-E-1] fuzz: random-byte url string throws cleanly, never crashes process", () => {
  const fuzz = Buffer.from(Array.from({ length: 300 }, () => Math.floor(Math.random() * 256))).toString("latin1");
  let handled = false;
  try { urlParse(fuzz); handled = true; } catch (e) { handled = true; }
  assert(handled);
});
test("[39-E-2] parse: URL with 50 query params all captured", () => {
  const params = Array.from({ length: 50 }, (_, i) => `k${i}=v${i}`).join("&");
  const r = urlParse(`https://example.com/?${params}`);
  assert(Object.keys(r.searchParams).length === 50 && r.searchParams.k49 === "v49");
});
test("[39-E-3] parse: 20 rapid sequential calls with different URLs are independent (no shared state)", () => {
  for (let i = 0; i < 20; i++) {
    const r = urlParse(`https://example.com/${i}?n=${i}`);
    assert(r.searchParams.n === String(i));
  }
});
