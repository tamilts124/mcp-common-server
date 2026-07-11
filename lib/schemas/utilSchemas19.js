"use strict";
// ── UTILITY TOOL SCHEMAS — part 19 ────────────────────────────────────────────────────
// Added: pdf_rich_extract (v4.156.0).

const UTIL_SCHEMAS_19 = [
  {
    name: "pdf_rich_extract",
    description:
      "Extract rich structured content from a PDF file — zero npm dependencies, pure Node built-ins. " +
      "Goes beyond pdf_to_md's plain-text output by returning structured blocks: " +
      "'para' (text runs with per-run font size, bold/italic heuristic via BaseFont name, " +
      "fill color as [r,g,b] 0-1 or null for black), " +
      "'table' (pipe-delimited or geometric/ruled-line tables with rows[][] or merged-cell cells[]), " +
      "'image' (embedded JPEG bytes or FlateDecode 8-bit DeviceRGB/Gray re-encoded as PNG, " +
      "returned as base64 in imageData with width/height/imageKind). " +
      "Limitations: resource-name maps are built globally across the file rather than per-page " +
      "(works for the common single-shared-resource-dict case); cross-reference streams " +
      "(compressed object streams) yield no BaseFont/XObject match and fall back to defaults. " +
      "Max file size: 50 MB. Returns { path, blockCount, imagesEmbedded, blocks: [{kind, ...}] }. " +
      "Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: {
          type: "string",
          description: "Path to the PDF file to extract content from.",
        },
        include_images: {
          type: "boolean",
          description:
            "Include embedded images as base64 imageData in image blocks (default: true). " +
            "Set false to skip image extraction for faster processing of text-heavy PDFs.",
        },
        max_blocks: {
          type: "number",
          description:
            "Maximum number of content blocks to return (1–50000, default: 10000). " +
            "Blocks beyond this cap are dropped and truncated:true is set.",
        },
      },
    },
  },
];

module.exports = { UTIL_SCHEMAS_19 };
