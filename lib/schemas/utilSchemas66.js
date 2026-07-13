"use strict";
// lib/schemas/utilSchemas66.js -- JSON schema for font_client tool

const UTIL_SCHEMAS_66 = [
  {
    name: "font_client",
    description:
      "Zero-dependency font file reader and inspector (pure Node.js; no npm deps). " +
      "Reads OpenType/TrueType font files and extracts structured metadata from internal SFNT tables. " +
      "Supports formats: TTF (TrueType), OTF (OpenType/CFF), WOFF (Web Open Font Format), " +
      "WOFF2 (header-only — Brotli-compressed tables cannot be decoded without a native library), " +
      "and TTC (TrueType Collections, inspects the first font). " +
      "Operations: " +
      "info (file summary: family, style, version, vendor, weight/width class, glyph count, variable axes); " +
      "names (all or filtered 'name' table records: full_name, copyright, designer, license, etc.); " +
      "metrics (typographic metrics from head/hhea/OS2/post tables: ascender, descender, line gap, bbox, kerning, OpenType features); " +
      "tables (raw SFNT table directory: tag, offset, length, checksum for every table in the font); " +
      "glyphs (glyph count, cmap subtable info, supported codepoint range, maxp metrics); " +
      "unicode (supported Unicode codepoints extracted from the cmap table: paginated list + contiguous range groups). " +
      "Security: 50 MB file cap; NUL-byte guard; directory guard.",
    inputSchema: {
      type: "object",
      required: ["operation", "path"],
      additionalProperties: false,
      properties: {
        operation: {
          type: "string",
          enum: ["info", "names", "metrics", "tables", "glyphs", "unicode"],
          description:
            "Operation to perform. " +
            "'info': full font summary — family, style flags, glyph count, vendor, weight/width class, variable axes, embedding rights. " +
            "'names': return all 'name' table records (family, copyright, designer, license, etc.) with optional platform/language filters. " +
            "'metrics': typographic metrics from head/hhea/OS2/post tables — ascender, descender, line-gap, bounding box, kern, GPOS/GSUB feature counts, variable axis ranges. " +
            "'tables': raw SFNT table directory — tag, offset, length, and checksum for every table stored in the font. " +
            "'glyphs': glyph count, selected cmap format, supported codepoint count, and maxp capacity metrics. " +
            "'unicode': paginated list of supported Unicode codepoints plus contiguous range groups (e.g. U+0041–U+007A).",
        },

        path: {
          type: "string",
          description:
            "Path to the font file. Supported formats are auto-detected by magic bytes: " +
            "TTF (.ttf, TrueType sfnt 0x00010000 or 'true'), OTF (.otf, CFF-based OTTO), " +
            "WOFF (.woff, 'wOFF' magic), WOFF2 (.woff2, 'wOF2' magic, header-level info only), " +
            "TTC (.ttc, 'ttcf', inspects first font in collection).",
        },

        // ── names-specific ─────────────────────────────────────────────────────
        platform: {
          type: "integer",
          minimum: 0,
          maximum: 3,
          description:
            "For 'names': filter name records by platform ID. " +
            "0 = Unicode, 1 = Macintosh, 2 = ISO (deprecated), 3 = Windows. " +
            "Omit to return records from all platforms.",
        },

        language: {
          type: "integer",
          minimum: 0,
          description:
            "For 'names': filter name records by language ID. " +
            "Windows platform: 0x0409 = English (US), 0x0809 = English (UK), etc. " +
            "Mac platform: 0 = English. Omit to return all languages.",
        },

        // ── unicode-specific ──────────────────────────────────────────────────
        offset: {
          type: "integer",
          minimum: 0,
          description:
            "For 'unicode': number of codepoints to skip before returning results (default: 0). " +
            "Use with 'limit' for pagination over large codepoint sets.",
        },

        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100000,
          description:
            "For 'unicode': maximum number of codepoints to return (default: 1000; hard cap: 100,000). " +
            "Use with 'offset' for pagination.",
        },

        ranges: {
          type: "boolean",
          description:
            "For 'unicode': include contiguous codepoint range groups in the response " +
            "(e.g. U+0041–U+007A for Basic Latin). Default: true. " +
            "Set to false to suppress range computation for very large codepoint sets.",
        },
      },
    },
  },
];

module.exports = { UTIL_SCHEMAS_66 };
