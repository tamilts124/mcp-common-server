"use strict";
// ── UTILITY TOOL SCHEMAS — part 6 ────────────────────────────────────────────
// Added: diff_strings (v4.142.0), password_generate (v4.142.0).

const UTIL_SCHEMAS_6 = [
  {
    name: "diff_strings",
    description:
      "Compute a unified or structured diff of two in-memory strings — no file I/O required. " +
      "Uses the same pure-JS Myers LCS algorithm as diff_files (zero npm dependencies), but " +
      "accepts raw string values directly so callers can compare API responses, generated output, " +
      "config values, clipboard text, or any two strings without writing temp files. " +
      "Two output formats: 'unified' (default) returns the classic diff header + @@ hunks text " +
      "suitable for display or further processing with patch tools; 'json' returns a structured " +
      "array of change blocks, each with per-line op ('+'/'-'/' '), text, and 1-based line numbers " +
      "— useful for programmatic post-processing. " +
      "Custom labels ('label_a'/'label_b') are used in the unified diff header and echoed back in " +
      "both formats — set them to 'expected'/'actual', 'old config'/'new config', etc. " +
      "Context (lines of unchanged text surrounding each hunk) is configurable, default 3. " +
      "Input size is capped at 4 MB per string. " +
      "Returns { labelA, labelB, hunks, additions, deletions, identical, aLines, bLines, " +
      "unified? (format='unified') | changes? (format='json') }. " +
      "Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: {
      type: "object",
      required: ["a", "b"],
      properties: {
        a: {
          type: "string",
          description:
            "The 'old' / left-side string to diff. Max 4 MB. " +
            "Multi-line strings are split on '\\n'. Can be empty.",
        },
        b: {
          type: "string",
          description:
            "The 'new' / right-side string to diff. Max 4 MB. " +
            "Multi-line strings are split on '\\n'. Can be empty.",
        },
        label_a: {
          type: "string",
          description:
            "Display label for the left side in the diff header (default: 'a'). " +
            "E.g. 'expected', 'v1.0', 'original'.",
        },
        label_b: {
          type: "string",
          description:
            "Display label for the right side in the diff header (default: 'b'). " +
            "E.g. 'actual', 'v1.1', 'modified'.",
        },
        context: {
          type: "number",
          description:
            "Lines of unchanged context to show around each changed hunk (default: 3). " +
            "Set to 0 for minimal diffs showing only changed lines.",
        },
        format: {
          type: "string",
          description:
            "'unified' (default): classic unified diff text with --- / +++ header and @@ hunks. " +
            "'json': structured array of change blocks, each block an array of " +
            "{ op: '+' | '-' | ' ', text, aLine?, bLine? } entries.",
        },
      },
    },
  },
  {
    name: "password_generate",
    description:
      "Generate cryptographically secure passwords or passphrases — Node.js built-in crypto only, " +
      "zero npm dependencies. Uses crypto.randomBytes with rejection sampling to avoid modulo bias. " +
      "\n\nPassword mode (default): builds a character pool from optional include/exclude filters, then " +
      "draws each character uniformly at random. Supported charset classes: " +
      "include_lowercase (a-z, on by default), include_uppercase (A-Z, on), include_digits (0-9, on), " +
      "include_symbols (off by default — configurable symbol string). Use exclude_chars to remove " +
      "ambiguous glyphs like '0', 'O', 'l', '1', 'I'. Length 4–512, count 1–100. " +
      "\n\nPassphrase mode (mode='passphrase'): selects N words from an embedded 512-word list of " +
      "common short English words (9 bits of entropy per word), joined by a separator. " +
      "3 words → 27 bits; 4 words → 36 bits; 6 words → 54 bits. " +
      "Optional capitalize_words (Title Case each word) and add_number (append a random digit). " +
      "\n\nAlways returns entropyBits (log2 of the total password space) so callers can enforce " +
      "strength policies. When count=1 a top-level 'password'/'passphrase' convenience key is " +
      "included alongside the array. " +
      "\n\nReturns (password mode): " +
      "{ mode, count, length, charsetSize, entropyBits, passwords, password? } " +
      "\nReturns (passphrase mode): " +
      "{ mode, count, wordCount, separator, entropyBits, wordlistSize, passphrases, passphrase? }. " +
      "\nAlways available — does not require MCP_ALLOW_EXEC.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          description:
            "Generation mode: 'password' (random character string, default) or " +
            "'passphrase' (random word sequence from embedded 512-word list).",
        },
        count: {
          type: "number",
          description: "Number of passwords/passphrases to generate (1–100, default 1).",
        },
        // ── Password-mode options ──────────────────────────────────────────
        length: {
          type: "number",
          description:
            "Password character count (4–512, default 16). Only used in password mode.",
        },
        include_lowercase: {
          type: "boolean",
          description: "Include lowercase letters a–z in the pool (default: true). Password mode only.",
        },
        include_uppercase: {
          type: "boolean",
          description: "Include uppercase letters A–Z in the pool (default: true). Password mode only.",
        },
        include_digits: {
          type: "boolean",
          description: "Include digits 0–9 in the pool (default: true). Password mode only.",
        },
        include_symbols: {
          type: "boolean",
          description:
            "Include symbol characters in the pool (default: false). " +
            "The default symbol set is '!@#$%^&*()-_=+[]{}|;:,.<>?'. " +
            "Override with the 'symbols' param. Password mode only.",
        },
        symbols: {
          type: "string",
          description:
            "Custom symbol string to use when include_symbols=true (e.g. '!@#$%'). " +
            "Defaults to '!@#$%^&*()-_=+[]{}|;:,.<>?'. Password mode only.",
        },
        exclude_chars: {
          type: "string",
          description:
            "Characters to remove from the generated pool (e.g. '0Ol1I' to remove ambiguous glyphs). " +
            "Applied after include_* options. Password mode only.",
        },
        // ── Passphrase-mode options ────────────────────────────────────────
        word_count: {
          type: "number",
          description:
            "Number of words per passphrase (3–10, default 4). Passphrase mode only.",
        },
        word_separator: {
          type: "string",
          description:
            "String placed between words (default: '-'). " +
            "Use '' for no separator, ' ' for spaces, or any custom string. Passphrase mode only.",
        },
        capitalize_words: {
          type: "boolean",
          description:
            "Title-case each word's first letter (default: false). Passphrase mode only.",
        },
        add_number: {
          type: "boolean",
          description:
            "Append a single random digit (0–9) at the end of the passphrase (default: false). " +
            "Adds ~3.32 bits of entropy. Passphrase mode only.",
        },
      },
    },
  },
];

module.exports = { UTIL_SCHEMAS_6 };
