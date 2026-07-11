"use strict";
// ── UTILITY TOOL SCHEMAS — part 9 ────────────────────────────────────────
// Added: string_transform (v4.145.0), ip_cidr (v4.145.0).

const UTIL_SCHEMAS_9 = [
  {
    name: "string_transform",
    description:
      "Apply a named transformation to a string — zero npm dependencies. " +
      "Case conversions: camel_case (helloWorld), pascal_case (HelloWorld), " +
      "snake_case (hello_world), kebab_case (hello-world), constant_case (HELLO_WORLD), " +
      "dot_case (hello.world), path_case (hello/world), " +
      "title_case (Hello World), sentence_case (Hello world), swap_case (hElLo → HeLlO). " +
      "All case conversions use smart word-boundary tokenization that handles " +
      "camelCase, PascalCase, space/hyphen/underscore/dot/slash delimiters, and acronyms. " +
      "Simple transforms: reverse (Unicode-safe), capitalize (first char upper), " +
      "decapitalize (first char lower), trim/trim_start/trim_end (whitespace), " +
      "slugify (URL-safe slug: lowercase, replace non-alphanumeric with \u2018-\u2019), " +
      "strip_diacritics (caf\u00e9 → cafe), swap_case. " +
      "Repeat: 'count' repetitions joined by 'separator'. " +
      "Truncate: clip to 'max_length' chars with configurable 'ellipsis' (default \u2018\u2026\u2019). " +
      "Padding: pad_start/pad_end/pad_center to 'min_length' with 'pad_char' (default space). " +
      "Word wrap: wrap at 'max_width' chars per line, 'newline' separator. " +
      "Count: returns stats object {chars, bytes, words, lines} (result is null). " +
      "Input cap: 1 MB. " +
      "Always available — does not require MCP_ALLOW_EXEC. " +
      "Returns { operation, input, result, ...operation-specific fields }.",
    inputSchema: {
      type: "object",
      required: ["operation", "input"],
      properties: {
        operation: {
          type: "string",
          description:
            "Transformation to apply. One of: camel_case, pascal_case, snake_case, " +
            "kebab_case, constant_case, dot_case, path_case, title_case, sentence_case, " +
            "swap_case, reverse, capitalize, decapitalize, trim, trim_start, trim_end, " +
            "slugify, strip_diacritics, repeat, truncate, pad_start, pad_end, " +
            "pad_center, word_wrap, count.",
        },
        input: {
          type: "string",
          description: "The string to transform. Max 1 MB.",
        },
        // repeat
        count: {
          type: "number",
          description: "(repeat only) Number of repetitions (0– 10000, default 1).",
        },
        separator: {
          type: "string",
          description: "(repeat only) String to place between repetitions (default '').",
        },
        // truncate
        max_length: {
          type: "number",
          description: "(truncate only) Maximum length in characters.",
        },
        ellipsis: {
          type: "string",
          description: "(truncate only) Suffix appended when truncated (default '\u2026'). Counted in max_length.",
        },
        // pad_start / pad_end / pad_center
        min_length: {
          type: "number",
          description: "(pad_start / pad_end / pad_center) Minimum output length in characters.",
        },
        pad_char: {
          type: "string",
          description: "(pad_start / pad_end / pad_center) Character to pad with (default ' ').",
        },
        // word_wrap
        max_width: {
          type: "number",
          description: "(word_wrap only) Maximum characters per line (1–100000).",
        },
        newline: {
          type: "string",
          description: "(word_wrap only) Newline string to use between wrapped lines (default '\\n').",
        },
      },
    },
  },
  {
    name: "ip_cidr",
    description:
      "IPv4 and IPv6 subnet toolkit — zero npm dependencies, pure Node.js. " +
      "Operations: " +
      "'info' — parse a CIDR or plain IP and return network/broadcast/mask/firstHost/lastHost/hostCount, " +
      "IP type (private/public/loopback/link_local/multicast/reserved/documentation/etc.), " +
      "hex/integer/binary forms for IPv4; compressed/expanded forms and type for IPv6. " +
      "'contains' — check whether an IP address is within a CIDR block (v4 and v6). " +
      "'enumerate' — list all addresses in a CIDR block (IPv4 only; " +
      "returns up to 'max_results' addresses, default 256, hard cap 65536; truncated flag if more exist). " +
      "'convert' — convert an IPv4 address between dotted-decimal, hex, unsigned integer, and binary; " +
      "or an IPv6 address between compressed, expanded, hex, and integer. " +
      "'classify' — classify one or more IPs ('ip' string or 'ips' array up to 1000) by RFC type " +
      "(private, public, loopback, link_local, multicast, shared, reserved, documentation, benchmarking, unspecified). " +
      "'subnets' — split a CIDR into equal sub-blocks by specifying extra prefix 'bits' (1–16) " +
      "or target 'count' of subnets; returns up to 1024 sub-CIDRs. " +
      "Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: {
      type: "object",
      required: ["operation"],
      properties: {
        operation: {
          type: "string",
          description: "Operation to perform: info, contains, enumerate, convert, classify, or subnets.",
        },
        cidr: {
          type: "string",
          description:
            "CIDR notation string, e.g. '192.168.1.0/24' or '2001:db8::/32'. " +
            "A plain IP without a prefix (e.g. '10.0.0.1') is accepted and treated as /32 (v4) or /128 (v6).",
        },
        ip: {
          type: "string",
          description:
            "A single IP address string (IPv4 or IPv6). Used in 'info' (alias for cidr), " +
            "'contains' (the IP to look up inside 'cidr'), 'convert', and 'classify'.",
        },
        ips: {
          type: "array",
          items: { type: "string" },
          description: "(classify only) Array of IP address strings to classify in one call (max 1000).",
        },
        max_results: {
          type: "number",
          description: "(enumerate only) Maximum number of addresses to return (1–65536, default 256).",
        },
        bits: {
          type: "number",
          description:
            "(subnets only) Extra prefix bits to add (1–16). E.g. 'bits:2' on a /24 yields four /26 subnets.",
        },
        count: {
          type: "number",
          description:
            "(subnets only) Target number of subnets (minimum 2). The smallest prefix that covers " +
            "at least 'count' subnets is used. Mutually exclusive with 'bits'.",
        },
      },
    },
  },
];

module.exports = { UTIL_SCHEMAS_9 };
