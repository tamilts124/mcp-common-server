"use strict";
// ── UTILITY TOOL SCHEMAS — part 8 ──────────────────────────────────────────────────
// Added: markdown_to_html (v4.144.0), xml_parse (v4.144.0).

const UTIL_SCHEMAS_8 = [
  {
    name: "markdown_to_html",
    description:
      "Convert a Markdown string to HTML — zero npm dependencies, pure Node.js. " +
      "Block features: ATX headings (# to ######), setext headings (=== / ---), " +
      "fenced code blocks (``` or ~~~, with optional language tag), " +
      "indented code blocks (4 spaces / 1 tab), blockquotes (>), " +
      "ordered lists (1.), unordered lists (- * +) with nested sub-lists, " +
      "GFM tables (with :align: support), thematic breaks (--- *** ___), " +
      "hard line breaks (trailing two spaces → <br>), and paragraphs. " +
      "Inline features: bold (**/**__), italic (*/_), bold+italic (***), " +
      "strikethrough (~~), code span (`), links ([text](url)), " +
      "images (![alt](src)), autolinks (<url> / <email@...>), " +
      "backslash escapes. " +
      "Raw HTML in the input is HTML-escaped by default (safe mode); " +
      "pass unsafe_html:true to pass it through unchanged. " +
      "Input is capped at 1 MB. " +
      "Always available — does not require MCP_ALLOW_EXEC. " +
      "Returns { html, stats: { inputLength, outputLength, headings, codeBlocks, " +
      "tables, blockquotes, lists, links, images, paragraphs } }.",
    inputSchema: {
      type: "object",
      required: ["markdown"],
      properties: {
        markdown: {
          type: "string",
          description:
            "Markdown source string to convert. Max 1 MB. " +
            "Accepts CommonMark / GFM syntax (headings, lists, tables, fenced code, etc.).",
        },
        unsafe_html: {
          type: "boolean",
          description:
            "If true, raw HTML tags embedded in the Markdown are passed through to the " +
            "output unchanged. Default: false (raw HTML is escaped — safe for untrusted input).",
        },
      },
    },
  },
  {
    name: "xml_parse",
    description:
      "Parse an XML string (or a file's contents) into a structured JSON AST — " +
      "zero npm dependencies, pure Node.js recursive-descent parser. " +
      "Supports: XML declarations (<?xml version='1.0'?>), elements, attributes " +
      "(single- and double-quoted), text nodes, CDATA sections (<![CDATA[...]]>), " +
      "comments (stripped from AST), processing instructions (stripped), self-closing tags, " +
      "namespaced names (prefix:local preserved as tag name, not resolved). " +
      "Standard HTML entities (&amp; &lt; &gt; &quot; &apos; &nbsp; &copy; etc.) " +
      "and numeric character references (&#65; &#x41;) are decoded in text and attributes. " +
      "Does NOT support: DTD validation, custom entity declarations, XML schemas, " +
      "multiple document roots (enforced), or unicode BOM stripping. " +
      "AST node shape: { tag, attrs: {key: value}, text: string, children: [...nodes] }. " +
      "'text' is the concatenated direct text content of an element (CDATA included). " +
      "Optional 'query' is a dot-notation path through the AST " +
      "(e.g. 'items.item.0.name.text' or 'root.attrs.id') — numeric segments index " +
      "into children arrays, 'text' and 'attrs' are special terminal segments. " +
      "Input cap: 4 MB (string). For files, provide 'path' instead of 'xml'. " +
      "Always available — does not require MCP_ALLOW_EXEC. " +
      "Returns { root, declaration: {version, encoding, standalone} | null, " +
      "nodeCount, maxDepth, query?, queryResult?, queryMatched? }.",
    inputSchema: {
      type: "object",
      properties: {
        xml: {
          type: "string",
          description:
            "Raw XML string to parse. Max 4 MB. " +
            "Provide either 'xml' (inline string) or 'path' (file to read), not both.",
        },
        path: {
          type: "string",
          description:
            "Path to an XML file to read and parse. " +
            "Provide either 'path' or 'xml', not both.",
        },
        query: {
          type: "string",
          description:
            "Optional dot-notation path to extract a specific node or value from the AST. " +
            "Segments: tag names (e.g. 'items'), numeric indices (e.g. '0'), " +
            "'text' (element's text content), 'attrs' (element's attribute map), " +
            "or 'attrs.ATTRNAME' to get a single attribute. " +
            "Example: 'catalog.book.1.author.text' gets the second book's author text. " +
            "Returns queryResult: matched value or null, queryMatched: bool.",
        },
      },
    },
  },
];

module.exports = { UTIL_SCHEMAS_8 };
