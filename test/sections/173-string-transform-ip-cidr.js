"use strict";
/**
 * test/sections/173-string-transform-ip-cidr.js
 * Isolated functional tests for string_transform and ip_cidr.
 * Section [173] — 5 rigor levels (A-E) per tool, 10 sub-sections total.
 */

const { test } = require("../test-harness");
const { stringTransform } = require("../../lib/stringTransformOps");
const { ipCidr } = require("../../lib/ipCidrOps");

function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function assertThrows(fn, check) {
  let threw = false, err;
  try { fn(); } catch (e) { threw = true; err = e; }
  assert(threw, "expected an error to be thrown");
  if (check) check(err);
}

// ─────────────────────────────────────────────────────────────────────────────
// [173-A] NORMAL — string_transform happy paths
// ─────────────────────────────────────────────────────────────────────────────

test("[173-A-1] string_transform: camel/pascal/snake/kebab/constant_case", () => {
  assert(stringTransform({ operation: "camel_case",    input: "hello-world-foo" }).result === "helloWorldFoo");
  assert(stringTransform({ operation: "pascal_case",   input: "hello-world-foo" }).result === "HelloWorldFoo");
  assert(stringTransform({ operation: "snake_case",    input: "helloWorldFoo"   }).result === "hello_world_foo");
  assert(stringTransform({ operation: "kebab_case",    input: "HelloWorldFoo"   }).result === "hello-world-foo");
  assert(stringTransform({ operation: "constant_case", input: "hello world"     }).result === "HELLO_WORLD");
});

test("[173-A-2] string_transform: dot_case, path_case, title_case, sentence_case, swap_case", () => {
  assert(stringTransform({ operation: "dot_case",      input: "hello world"  }).result === "hello.world");
  assert(stringTransform({ operation: "path_case",     input: "Hello World"  }).result === "hello/world");
  assert(stringTransform({ operation: "title_case",    input: "hello world"  }).result === "Hello World");
  assert(stringTransform({ operation: "sentence_case", input: "HELLO WORLD"  }).result === "Hello world");
  assert(stringTransform({ operation: "swap_case",     input: "Hello World"  }).result === "hELLO wORLD");
});

test("[173-A-3] string_transform: reverse, capitalize, decapitalize, trim variants", () => {
  assert(stringTransform({ operation: "reverse",      input: "hello"      }).result === "olleh");
  assert(stringTransform({ operation: "capitalize",   input: "hello world" }).result === "Hello world");
  assert(stringTransform({ operation: "decapitalize", input: "HELLO"       }).result === "hELLO");
  assert(stringTransform({ operation: "trim",         input: "  hello  "   }).result === "hello");
  assert(stringTransform({ operation: "trim_start",   input: "  hello  "   }).result === "hello  ");
  assert(stringTransform({ operation: "trim_end",     input: "  hello  "   }).result === "  hello");
});

test("[173-A-4] string_transform: slugify and strip_diacritics", () => {
  assert(stringTransform({ operation: "slugify",          input: "Hello, World! 2024" }).result === "hello-world-2024");
  assert(stringTransform({ operation: "strip_diacritics", input: "caf\u00e9 r\u00e9sum\u00e9" }).result === "cafe resume");
});

test("[173-A-5] string_transform: repeat with count and separator", () => {
  const r = stringTransform({ operation: "repeat", input: "ab", count: 3, separator: "-" });
  assert(r.result === "ab-ab-ab");
});

test("[173-A-6] string_transform: truncate", () => {
  const r1 = stringTransform({ operation: "truncate", input: "Hello, World!", max_length: 8 });
  assert(r1.result === "Hello, \u2026" && r1.truncated === true);
  const r2 = stringTransform({ operation: "truncate", input: "Hi", max_length: 10 });
  assert(r2.truncated === false);
});

test("[173-A-7] string_transform: pad_start, pad_end, pad_center", () => {
  assert(stringTransform({ operation: "pad_start",  input: "hi", min_length: 6                    }).result === "    hi");
  assert(stringTransform({ operation: "pad_end",    input: "hi", min_length: 6, pad_char: "-"     }).result === "hi----");
  assert(stringTransform({ operation: "pad_center", input: "hi", min_length: 6, pad_char: "*"     }).result === "**hi**");
});

test("[173-A-8] string_transform: word_wrap respects max_width", () => {
  const r = stringTransform({ operation: "word_wrap", input: "The quick brown fox jumps over the lazy dog", max_width: 15 });
  assert(r.result.split("\n").every(l => l.length <= 15));
});

test("[173-A-9] string_transform: count returns chars, words, lines", () => {
  const r = stringTransform({ operation: "count", input: "hello world" });
  assert(r.stats.chars === 11 && r.stats.words === 2 && r.stats.lines === 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// [173-A] NORMAL — ip_cidr happy paths
// ─────────────────────────────────────────────────────────────────────────────

test("[173-A-10] ip_cidr: info IPv4 /24 subnet", () => {
  const p = ipCidr({ operation: "info", cidr: "192.168.1.0/24" });
  assert(p.version === 4, "version");
  assert(p.network === "192.168.1.0", "network");
  assert(p.broadcast === "192.168.1.255", "broadcast");
  assert(p.mask === "255.255.255.0", "mask");
  assert(p.hostCount === 254, "hostCount");
  assert(p.type === "private", "type");
});

test("[173-A-11] ip_cidr: info plain IPv4 — public, /32", () => {
  const p = ipCidr({ operation: "info", ip: "8.8.8.8" });
  assert(p.type === "public" && p.prefix === 32);
});

test("[173-A-12] ip_cidr: contains IPv4", () => {
  assert(ipCidr({ operation: "contains", cidr: "10.0.0.0/8",  ip: "10.1.2.3"    }).contains === true);
  assert(ipCidr({ operation: "contains", cidr: "10.0.0.0/8",  ip: "172.16.0.1"  }).contains === false);
});

test("[173-A-13] ip_cidr: enumerate /30 block", () => {
  const p = ipCidr({ operation: "enumerate", cidr: "192.168.1.0/30", max_results: 10 });
  assert(p.totalAddresses === 4 && p.addresses.length === 4);
  assert(p.addresses[0] === "192.168.1.0" && p.addresses[3] === "192.168.1.3");
});

test("[173-A-14] ip_cidr: convert IPv4 dotted → hex/integer/binary", () => {
  const p = ipCidr({ operation: "convert", ip: "192.168.1.1" });
  assert(p.dotted === "192.168.1.1");
  assert(p.hex === "0xc0a80101");
  assert(p.integer === 3232235777);
  assert(p.binary.length === 32);
});

test("[173-A-15] ip_cidr: classify IPv4 — private/public/loopback/multicast", () => {
  assert(ipCidr({ operation: "classify", ip: "10.0.0.1"   }).results[0].type === "private");
  const r = ipCidr({ operation: "classify", ips: ["8.8.8.8", "127.0.0.1", "224.0.0.1"] });
  assert(r.results[0].type === "public" && r.results[1].type === "loopback" && r.results[2].type === "multicast");
});

test("[173-A-16] ip_cidr: subnets splits /24 into 4×/26", () => {
  const p = ipCidr({ operation: "subnets", cidr: "192.168.0.0/24", bits: 2 });
  assert(p.subnetCount === 4 && p.newPrefix === 26);
  assert(p.subnets[0].cidr === "192.168.0.0/26");
  assert(p.subnets[3].cidr === "192.168.0.192/26");
});

// ─────────────────────────────────────────────────────────────────────────────
// [173-B] MEDIUM — validation and edge cases
// ─────────────────────────────────────────────────────────────────────────────

test("[173-B-1] string_transform: empty string inputs for case ops", () => {
  assert(stringTransform({ operation: "camel_case", input: "" }).result === "");
  assert(stringTransform({ operation: "snake_case", input: "---" }).result === "");
  assert(stringTransform({ operation: "slugify",    input: "!!!" }).result === "");
});

test("[173-B-2] string_transform: repeat edge cases (empty/zero)", () => {
  assert(stringTransform({ operation: "repeat", input: "",  count: 5 }).result === "");
  assert(stringTransform({ operation: "repeat", input: "x", count: 0 }).result === "");
});

test("[173-B-3] string_transform: truncate with custom ellipsis", () => {
  const r = stringTransform({ operation: "truncate", input: "Hello World", max_length: 7, ellipsis: "..." });
  assert(r.result === "Hell...");
});

test("[173-B-4] string_transform: pad_start noop when already long enough", () => {
  assert(stringTransform({ operation: "pad_start", input: "hello", min_length: 3 }).result === "hello");
});

test("[173-B-5] string_transform: word_wrap preserves single long word", () => {
  assert(stringTransform({ operation: "word_wrap", input: "superlongword", max_width: 5 }).result === "superlongword");
});

test("[173-B-6] string_transform: count on empty string", () => {
  const r = stringTransform({ operation: "count", input: "" });
  assert(r.stats.chars === 0 && r.stats.words === 0);
});

test("[173-B-7] string_transform: snake_case splits camelCase acronym (HTMLParser)", () => {
  assert(stringTransform({ operation: "snake_case", input: "HTMLParser" }).result === "html_parser");
});

test("[173-B-8] ip_cidr: /32 and /31 edge cases", () => {
  const p32 = ipCidr({ operation: "info", cidr: "10.0.0.1/32" });
  assert(p32.totalAddresses === 1);
  const p31 = ipCidr({ operation: "info", cidr: "192.168.1.0/31" });
  assert(p31.totalAddresses === 2);
  const p0 = ipCidr({ operation: "info", cidr: "0.0.0.0/0" });
  assert(p0.totalAddresses === 4294967296);
});

test("[173-B-9] ip_cidr: classify loopback and link_local", () => {
  assert(ipCidr({ operation: "info",     ip:  "127.0.0.1"  }).type === "loopback");
  assert(ipCidr({ operation: "classify", ip:  "169.254.1.1" }).results[0].type === "link_local");
});

test("[173-B-10] ip_cidr: subnets with count=3 yields 4 subnets", () => {
  const p = ipCidr({ operation: "subnets", cidr: "10.0.0.0/24", count: 3 });
  assert(p.subnetCount === 4 && p.newPrefix === 26);
});

test("[173-B-11] ip_cidr: enumerate truncation and convert from integer/hex", () => {
  const pe = ipCidr({ operation: "enumerate", cidr: "192.168.0.0/16", max_results: 5 });
  assert(pe.addresses.length === 5 && pe.truncated === true);
  assert(ipCidr({ operation: "convert", ip: "3232235777" }).dotted === "192.168.1.1");
  assert(ipCidr({ operation: "convert", ip: "0xc0a80101" }).dotted === "192.168.1.1");
});

// ─────────────────────────────────────────────────────────────────────────────
// [173-C] HIGH — Unicode, IPv6, structural correctness
// ─────────────────────────────────────────────────────────────────────────────

test("[173-C-1] string_transform: reverse handles surrogate pairs correctly", () => {
  const r = stringTransform({ operation: "reverse", input: "\uD83D\uDE00abc" });
  assert(r.result === "cba\uD83D\uDE00");
});

test("[173-C-2] string_transform: strip_diacritics converts all to ASCII", () => {
  const r = stringTransform({ operation: "strip_diacritics", input: "\u00e9\u00e0\u00fc\u00f1" });
  assert(/^[a-z]+$/.test(r.result));
});

test("[173-C-3] string_transform: word_wrap with existing newlines", () => {
  const r = stringTransform({ operation: "word_wrap", input: "Line one\nLine two words here", max_width: 8 });
  assert(r.result.includes("Line one"));
});

test("[173-C-4] string_transform: truncate clamps when ellipsis longer than max", () => {
  const r = stringTransform({ operation: "truncate", input: "Hello", max_length: 2, ellipsis: "..." });
  assert(r.result.length <= 2);
});

test("[173-C-5] string_transform: count handles CRLF lines", () => {
  assert(stringTransform({ operation: "count", input: "a\r\nb\r\nc" }).stats.lines === 3);
});

test("[173-C-6] string_transform: camel_case with mixed delimiters", () => {
  assert(stringTransform({ operation: "camel_case", input: "foo_bar-baz.qux/quux" }).result === "fooBarBazQuxQuux");
});

test("[173-C-7] ip_cidr: IPv6 info /32", () => {
  const p = ipCidr({ operation: "info", cidr: "2001:db8::/32" });
  assert(p.version === 6 && p.prefix === 32);
  assert(typeof p.network === "string" && p.network.length > 0);
});

test("[173-C-8] ip_cidr: IPv6 contains", () => {
  assert(ipCidr({ operation: "contains", cidr: "fe80::/10", ip: "fe80::1"     }).contains === true);
  assert(ipCidr({ operation: "contains", cidr: "fe80::/10", ip: "2001:db8::1" }).contains === false);
});

test("[173-C-9] ip_cidr: IPv6 convert — compress loopback and full address", () => {
  const p1 = ipCidr({ operation: "convert", ip: "::1" });
  assert(p1.version === 6 && p1.compressed === "::1");
  const p2 = ipCidr({ operation: "convert", ip: "2001:0db8:0000:0000:0000:0000:0000:0001" });
  assert(p2.compressed === "2001:db8::1");
});

test("[173-C-10] ip_cidr: IPv6 classify loopback and subnets /16→256 subnets", () => {
  assert(ipCidr({ operation: "classify", ip: "::1" }).results[0].type === "loopback");
  const p = ipCidr({ operation: "subnets", cidr: "10.0.0.0/16", bits: 8 });
  assert(p.subnetCount === 256 && p.subnets.length === 256);
});

// ─────────────────────────────────────────────────────────────────────────────
// [173-D] CRITICAL — invalid inputs and error propagation
// ─────────────────────────────────────────────────────────────────────────────

test("[173-D-1] string_transform: throws on missing 'input'", () => {
  assertThrows(
    () => stringTransform({ operation: "camel_case" }),
    e => assert(e.message.includes("input"))
  );
});

test("[173-D-2] string_transform: throws on missing 'operation'", () => {
  assertThrows(
    () => stringTransform({ input: "hello" }),
    e => assert(e.message.includes("operation"))
  );
});

test("[173-D-3] string_transform: throws on unknown operation", () => {
  assertThrows(
    () => stringTransform({ operation: "fly_to_the_moon", input: "test" }),
    e => assert(e.message.includes("unknown operation"))
  );
});

test("[173-D-4] string_transform: truncate rejects negative max_length", () => {
  assertThrows(
    () => stringTransform({ operation: "truncate", input: "hi", max_length: -1 }),
    e => assert(e.code === -32602 || e.message.includes("max_length"))
  );
});

test("[173-D-5] string_transform: repeat rejects count > 10000", () => {
  assertThrows(
    () => stringTransform({ operation: "repeat", input: "x", count: 99999 }),
    e => assert(e.message.includes("count"))
  );
});

test("[173-D-6] string_transform: word_wrap requires max_width", () => {
  assertThrows(
    () => stringTransform({ operation: "word_wrap", input: "hello" }),
    e => assert(e.message.includes("max_width"))
  );
});

test("[173-D-7] ip_cidr: bad IPv4 octet throws", () => {
  assertThrows(
    () => ipCidr({ operation: "info", cidr: "999.0.0.1" }),
    e => assert(e.message.includes("999") || e.message.includes("IPv4"))
  );
});

test("[173-D-8] ip_cidr: prefix > 32 throws", () => {
  assertThrows(
    () => ipCidr({ operation: "info", cidr: "10.0.0.0/33" }),
    e => assert(e.message.includes("prefix") || e.message.includes("33"))
  );
});

test("[173-D-9] ip_cidr: version mismatch in contains throws", () => {
  assertThrows(
    () => ipCidr({ operation: "contains", cidr: "10.0.0.0/8", ip: "::1" }),
    e => assert(e.message.includes("version"))
  );
});

test("[173-D-10] ip_cidr: empty operation throws, subnets overflow throws, classify >1000 throws", () => {
  assertThrows(() => ipCidr({ operation: "" }),
    e => assert(e.message.includes("operation")));
  assertThrows(() => ipCidr({ operation: "subnets", cidr: "10.0.0.0/30", bits: 8 }),
    e => assert(e.message.includes("32") || e.message.includes("prefix")));
  assertThrows(() => ipCidr({ operation: "classify", ips: Array(1001).fill("8.8.8.8") }),
    e => assert(e.message.includes("1000")));
});

// ─────────────────────────────────────────────────────────────────────────────
// [173-E] EXTREME — large inputs and stress
// ─────────────────────────────────────────────────────────────────────────────

test("[173-E-1] string_transform: count near-1MB string", () => {
  const bigStr = "a".repeat(500_000);
  assert(stringTransform({ operation: "count", input: bigStr }).stats.chars === 500_000);
});

test("[173-E-2] string_transform: 100 rapid snake_case conversions", () => {
  const INPUTS = ["helloWorld", "foo_bar", "BazQux", "lorem-ipsum-dolor", "THE_QUICK_BROWN_FOX"];
  let passed = 0;
  for (let i = 0; i < 100; i++) {
    const res = stringTransform({ operation: "snake_case", input: INPUTS[i % INPUTS.length] });
    if (typeof res.result === "string") passed++;
  }
  assert(passed === 100);
});

test("[173-E-3] string_transform: word_wrap on 1000-word line — all lines ≤ 40", () => {
  const longLine = "word ".repeat(1000).trim();
  const r = stringTransform({ operation: "word_wrap", input: longLine, max_width: 40 });
  assert(r.result.split("\n").every(l => l.length <= 40));
});

test("[173-E-4] ip_cidr: enumerate /16 up to 65536 addresses", () => {
  // /15 has 131072 addresses; hard-capped at 65536 => truncated=true
  const p = ipCidr({ operation: "enumerate", cidr: "10.0.0.0/15", max_results: 65536 });
  assert(p.addresses.length === 65536 && p.truncated === true);
});

test("[173-E-5] ip_cidr: 1000 sequential classify calls", () => {
  let passed = 0;
  for (let i = 0; i < 1000; i++) {
    const ip = `${(i >> 8) & 0xff}.${i & 0xff}.0.1`;
    const res = ipCidr({ operation: "classify", ip });
    if (res.results[0].type) passed++;
  }
  assert(passed === 1000);
});

test("[173-E-6] ip_cidr: 100 sequential subnet splits", () => {
  let passed = 0;
  for (let i = 0; i < 100; i++) {
    const res = ipCidr({ operation: "subnets", cidr: "192.168.0.0/24", bits: 2 });
    if (res.subnetCount === 4) passed++;
  }
  assert(passed === 100);
});
