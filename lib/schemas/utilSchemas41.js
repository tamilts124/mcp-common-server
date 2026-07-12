"use strict";
// lib/schemas/utilSchemas41.js — JSON schema for markdown_client tool

const UTIL_SCHEMAS_41 = [
  {
    name: "markdown_client",
    description: "Zero-dependency Markdown file parser, editor, and HTML renderer (pure Node.js fs; no npm deps). Read, navigate, and modify Markdown files such as README.md, changelogs, wikis, documentation, and blog posts. Operations: read (parse Markdown to document stats and heading list), get_section (extract content under a heading), set_section (update/insert section content and rewrite file), extract_links (find all links and images), extract_headings (table of contents), extract_code_blocks (find all code examples by optional language), convert_to_html (render Markdown to HTML with optional full page wrapper), stringify (normalise and reformat the file). Supports: ATX/setext headings, fenced/indented code blocks, blockquotes, ordered/unordered lists, GFM tables, inline bold/italic/strikethrough/code, links, images, auto-links, HTML passthrough, YAML front matter. Security: path NUL guard; 4 MB file cap; 50,000 node limit. Always available \u2014 does not require MCP_ALLOW_EXEC.",
    inputSchema: {
      type: "object",
      required: ["operation"],
      properties: {
        operation: {
          type: "string",
          enum: ["read", "get_section", "set_section", "extract_links", "extract_headings", "extract_code_blocks", "convert_to_html", "stringify"],
          description: "Operation to perform. read=parse file and return stats/headings; get_section=extract content under a named heading; set_section=replace or append a named section; extract_links=find all hyperlinks and images; extract_headings=return table of contents; extract_code_blocks=find all fenced/indented code blocks; convert_to_html=render Markdown to HTML; stringify=normalise and clean up the document.",
        },
        path: {
          type: "string",
          description: "Path to the Markdown file. Required for read, get_section, set_section, extract_links, extract_headings, extract_code_blocks, stringify. Optional for convert_to_html (use 'markdown' instead for inline text).",
        },
        heading: {
          type: "string",
          description: "Heading text to search for (case-insensitive, trimmed). Required for get_section and set_section. Examples: 'Installation', 'API Reference', 'Getting Started'.",
        },
        level: {
          type: "number",
          description: "Heading level (1-6) to restrict the heading search. Optional for get_section/set_section (any level if omitted).",
        },
        content: {
          type: "string",
          description: "New content for the section (Markdown text). Required for set_section. Replaces everything between the named heading and the next heading of equal or higher level.",
        },
        type: {
          type: "string",
          enum: ["link", "image", "autolink", "reference"],
          description: "Filter for extract_links: 'link' (inline hyperlinks), 'image' (images), 'autolink' (bare <url> links), 'reference' (reference-style definitions). Omit to return all types.",
        },
        min_level: {
          type: "number",
          description: "Minimum heading level to include (1-6) for extract_headings. Default: 1.",
        },
        max_level: {
          type: "number",
          description: "Maximum heading level to include (1-6) for extract_headings. Default: 6.",
        },
        language: {
          type: "string",
          description: "Language filter for extract_code_blocks (e.g. 'javascript', 'python', 'bash'). Omit to return all fenced and indented code blocks.",
        },
        markdown: {
          type: "string",
          description: "Inline Markdown string for convert_to_html (alternative to 'path'). Must not be used together with 'path'.",
        },
        wrap: {
          type: "boolean",
          description: "For convert_to_html: if true (default), wrap output in a full HTML document (DOCTYPE, html, head, body). Set false to return fragment only.",
        },
        title: {
          type: "string",
          description: "For convert_to_html: <title> element content when 'wrap' is true.",
        },
        output_path: {
          type: "string",
          description: "Optional file path to write output to. For set_section: defaults to overwriting 'path'. For convert_to_html/stringify: if omitted, returns content as string without writing.",
        },
      },
      additionalProperties: false,
    },
  },
];

module.exports = { UTIL_SCHEMAS_41 };
