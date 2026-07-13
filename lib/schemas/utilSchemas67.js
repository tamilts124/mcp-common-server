"use strict";
// utilSchemas67: epub_client

const UTIL_SCHEMAS_67 = [
  {
    name: "epub_client",
    description:
      "Zero-dependency EPUB 2/3 ebook reader (pure Node.js; no npm deps). " +
      "Reads .epub files without extraction. " +
      "Operations: info (summary), metadata (Dublin Core title/author/ISBN/publisher/…), " +
      "toc (table of contents from NCX or nav), chapters (spine order with titles), " +
      "read (content of a chapter or asset), images (cover + embedded images). " +
      "Security: 200 MB file cap; 5 MB per-read cap; NUL-byte and directory guards.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["info", "metadata", "toc", "chapters", "read", "images"],
          description:
            "info: summary (version, title, author, counts). " +
            "metadata: full Dublin Core + OPF meta fields, extracts ISBN. " +
            "toc: table of contents (EPUB3 nav or EPUB2 NCX). " +
            "chapters: spine-ordered chapters with titles and sizes. " +
            "read: read a chapter or asset by path or manifest ID. " +
            "images: list all images, identifies cover.",
        },
        path: {
          type: "string",
          description: "Absolute path to the .epub file.",
        },
        // read
        item: {
          type: "string",
          description:
            "[read] ZIP entry path (e.g. 'OEBPS/chapter1.xhtml') or manifest ID (e.g. 'chapter1'). " +
            "Use chapters op to discover valid hrefs.",
        },
        encoding: {
          type: "string",
          enum: ["auto", "utf8", "base64"],
          description:
            "[read] Output encoding. auto=detect (text→utf8, binary→base64). Default: auto.",
        },
        // toc
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 1000,
          description:
            "[toc, images] Maximum items to return. Default: 200 (toc), 100 (images).",
        },
        // chapters
        linear_only: {
          type: "boolean",
          description:
            "[chapters] If true (default), only return linear=yes spine items. " +
            "Set false to include auxiliary items (e.g. cover pages, notes).",
        },
      },
      required: ["operation", "path"],
    },
  },
];

module.exports = { UTIL_SCHEMAS_67 };
