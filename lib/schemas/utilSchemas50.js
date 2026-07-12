"use strict";
// lib/schemas/utilSchemas50.js — JSON schema for pdf_client tool

const UTIL_SCHEMAS_50 = [
  {
    name: "pdf_client",
    description:
      "Zero-dependency PDF reader, writer, and manipulator (pure Node.js; no npm deps). " +
      "Provides 9 operations for reading, transforming, and protecting PDF files: " +
      "info (metadata: page count, version, size, encryption, page sizes); " +
      "get_text (extract plain text from all or selected pages); " +
      "merge (concatenate two or more PDFs into a single output PDF); " +
      "split (split a PDF into individual-page or multi-page-chunk files in an output directory); " +
      "rotate (rotate all or selected pages by 90, 180, or 270 degrees); " +
      "remove_pages (delete specified pages and save the result); " +
      "add_watermark (stamp diagonal text on all or selected pages); " +
      "encrypt (add password protection using RC4-40-bit Standard Security); " +
      "decrypt (remove encryption and rebuild a clean PDF). " +
      "Security: 100 MB file cap; 10,000 page limit; NUL-byte path guard; .pdf header validation. " +
      "Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: {
      type: "object",
      required: ["operation"],
      additionalProperties: false,
      properties: {
        operation: {
          type: "string",
          enum: ["info", "get_text", "merge", "split", "rotate",
                 "remove_pages", "add_watermark", "encrypt", "decrypt"],
          description:
            "Operation to perform. " +
            "'info': return metadata about the PDF (page count, version, encryption, page sizes). " +
            "'get_text': extract plain text from the PDF (optionally limited to a page range). " +
            "'merge': concatenate two or more PDFs into one output file. " +
            "'split': split a PDF into separate files (one per page by default, or pages_per_file chunks). " +
            "'rotate': rotate all or selected pages by 90, 180, or 270 degrees. " +
            "'remove_pages': delete specified pages and write the result to output. " +
            "'add_watermark': stamp diagonal text on all or selected pages. " +
            "'encrypt': add RC4-40-bit password protection. " +
            "'decrypt': remove Standard encryption and write a clean PDF.",
        },

        // Single-file input (all ops except merge)
        path: {
          type: "string",
          description:
            "Path to the input PDF file. Required for all operations except 'merge' (which uses 'files').",
        },

        // Output file path (all ops except info, get_text, split)
        output: {
          type: "string",
          description:
            "Path for the output PDF. Required for rotate, remove_pages, add_watermark, encrypt, " +
            "decrypt, and merge. The file is created or overwritten; parent directories are created automatically.",
        },

        // merge: list of input files
        files: {
          type: "array",
          items: { type: "string" },
          minItems: 2,
          description:
            "For 'merge': array of ≥ 2 PDF file paths to concatenate in order.",
        },

        // split: output directory
        output_directory: {
          type: "string",
          description:
            "For 'split': directory path where the split PDF files will be written. Created automatically.",
        },
        pages_per_file: {
          type: "integer",
          minimum: 1,
          description:
            "For 'split': number of pages per output file (default: 1 — one file per page).",
        },

        // get_text: page range
        from_page: {
          type: "integer",
          minimum: 1,
          description: "For 'get_text': first page to extract text from (1-based, default: 1).",
        },
        to_page: {
          type: "integer",
          minimum: 1,
          description: "For 'get_text': last page to extract text from (1-based, default: last page).",
        },

        // rotate
        degrees: {
          type: "integer",
          enum: [90, 180, 270],
          description: "For 'rotate': clockwise rotation to apply (90, 180, or 270 degrees).",
        },

        // pages (rotate / remove_pages / add_watermark)
        pages: {
          type: "array",
          items: { type: "integer", minimum: 1 },
          minItems: 1,
          description:
            "For 'rotate', 'remove_pages', and 'add_watermark': 1-based page numbers to act on. " +
            "Omit to apply to all pages.",
        },

        // add_watermark
        text: {
          type: "string",
          description: "For 'add_watermark': text string to stamp on pages.",
        },
        font_size: {
          type: "number",
          minimum: 6,
          maximum: 200,
          description: "For 'add_watermark': font size in points (default: 48).",
        },
        opacity: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description: "For 'add_watermark': opacity 0.0 (invisible) to 1.0 (opaque) (default: 0.3).",
        },
        angle: {
          type: "number",
          description: "For 'add_watermark': rotation angle in degrees counter-clockwise (default: 45).",
        },

        // encrypt
        user_password: {
          type: "string",
          description:
            "For 'encrypt': password required to open the PDF (empty string = no open password, " +
            "document opens freely but editing is restricted by owner_password).",
        },
        owner_password: {
          type: "string",
          description:
            "For 'encrypt': owner password granting full access. Defaults to user_password if omitted.",
        },

        // decrypt
        password: {
          type: "string",
          description: "For 'decrypt': the user or owner password. Optional for PDFs encrypted by this tool.",
        },
      },
    },
  },
];

module.exports = { UTIL_SCHEMAS_50 };
