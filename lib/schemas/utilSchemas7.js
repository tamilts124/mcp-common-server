"use strict";
// ── UTILITY TOOL SCHEMAS — part 7 ──────────────────────────────────────────────────
// Added: template_render (v4.143.0), base62_encode + base62_decode (v4.143.0).

const UTIL_SCHEMAS_7 = [
  {
    name: "template_render",
    description:
      "Render a Mustache-compatible template string against a data context — " +
      "zero npm dependencies, pure Node.js. " +
      "Supported tags: " +
      "{{key}} (HTML-escaped variable), {{{key}}} / {{&key}} (unescaped), " +
      "{{#section}}...{{/section}} (truthy block — arrays loop, truthy scalars render once, " +
      "objects push their own keys into context), " +
      "{{^section}}...{{/section}} (inverted/falsy block), " +
      "{{>partial}} (inline partial lookup from the 'partials' map), " +
      "{{! comment }} (stripped). " +
      "Context access uses dot-notation paths (e.g. 'user.name', 'items.0.label'). " +
      "Template size is capped at 1 MB. Partial recursion depth is capped at 32 levels. " +
      "Always available — does not require MCP_ALLOW_EXEC. " +
      "Returns { rendered, templateLength, renderedLength }.",
    inputSchema: {
      type: "object",
      required: ["template"],
      properties: {
        template: {
          type: "string",
          description:
            "Mustache-compatible template string. Max 1 MB. " +
            "Use {{key}} for escaped output, {{{key}}} for raw output, " +
            "{{#list}}...{{/list}} for loops, {{^key}}...{{/key}} for falsy blocks.",
        },
        context: {
          type: "object",
          description:
            "Data context object whose keys are available in the template. " +
            "Nested objects are accessible via dot-notation (e.g. 'user.name'). " +
            "Default: {}.",
        },
        partials: {
          type: "object",
          description:
            "Map of partial name → template string. " +
            "Partials are referenced in the template as {{>partial_name}}. " +
            "Values must be strings. Default: {}.",
        },
      },
    },
  },
  {
    name: "base62_encode",
    description:
      "Encode a non-negative integer, hex string, or raw bytes (base64-encoded) as a " +
      "Base62 string using the standard 0-9A-Za-z alphabet. " +
      "Base62 produces URL-safe, case-sensitive compact IDs with no special characters — " +
      "useful for generating short URLs, YouTube-style video IDs, UUID shortening, " +
      "database shard tokens, and any context where a compact alphanumeric identifier is needed. " +
      "Provide exactly one of: 'number' (non-negative decimal integer, up to 40 digits), " +
      "'hex' (hexadecimal string, 0x prefix optional), or 'bytes' (base64-encoded byte array). " +
      "Optional 'min_length' pads the result with leading '0's. " +
      "Zero dependencies — pure Node.js built-ins. " +
      "Returns { encoded, base, alphabet, inputType, inputBigInt }.",
    inputSchema: {
      type: "object",
      properties: {
        number: {
          type: ["string", "number"],
          description:
            "Non-negative integer to encode (as a JS number or decimal string, up to 40 digits). " +
            "Provide exactly one of 'number', 'hex', or 'bytes'.",
        },
        hex: {
          type: "string",
          description:
            "Hexadecimal string to encode (0x prefix optional, even/odd length accepted). " +
            "Provide exactly one of 'number', 'hex', or 'bytes'.",
        },
        bytes: {
          type: "string",
          description:
            "Base64-encoded byte array to encode as Base62 (treats bytes as a big-endian unsigned integer). " +
            "Provide exactly one of 'number', 'hex', or 'bytes'.",
        },
        min_length: {
          type: "number",
          description:
            "Minimum output length (pad with leading '0's if shorter). " +
            "Useful for fixed-width identifiers.",
        },
      },
    },
  },
  {
    name: "base62_decode",
    description:
      "Decode a Base62 string (0-9A-Za-z alphabet) back to a number, hex string, or base64 bytes. " +
      "Inverse of base62_encode. Useful for expanding short URL slugs back to numeric IDs, " +
      "decoding compact token representations, or round-trip verification. " +
      "Input must use only 0-9A-Za-z characters (max 1024 chars). " +
      "Zero dependencies — pure Node.js built-ins. " +
      "Returns { decoded, base, outputFormat, decodedBigInt }.",
    inputSchema: {
      type: "object",
      required: ["encoded"],
      properties: {
        encoded: {
          type: "string",
          description:
            "Base62 string to decode (only 0-9A-Za-z characters, max 1024 chars).",
        },
        output: {
          type: "string",
          description:
            "Output format for the decoded value: " +
            "'decimal' (default, returns decimal integer string), " +
            "'hex' (lowercase hex string, always even length), " +
            "'bytes' (base64-encoded byte array of the decoded value).",
        },
      },
    },
  },
];

module.exports = { UTIL_SCHEMAS_7 };
