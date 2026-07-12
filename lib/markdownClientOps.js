"use strict";
// lib/markdownClientOps.js — Zero-dependency Markdown parser/renderer/editor
// Operations: read, get_section, set_section, extract_links, extract_headings,
//             extract_code_blocks, convert_to_html, stringify
//
// Markdown features supported:
//   - ATX headings  (# H1 through ###### H6)
//   - Setext headings (underline with === or ---)
//   - Fenced code blocks (``` or ~~~, optional language tag)
//   - Indented code blocks (4-space / 1-tab indent)
//   - Blockquotes (> prefix, nested)
//   - Unordered lists  (- * + bullet)
//   - Ordered lists    (1. 2. N.)
//   - Horizontal rules (---, ***, ___)
//   - Links  [text](url "title") and [ref][id]
//   - Images ![alt](url)
//   - Reference link definitions [id]: url "title"
//   - Inline: **bold**, *italic*, ***bold-italic***, __bold__, _italic_
//   - Inline: ~~strikethrough~~, `code`, <http://auto-links>
//   - GFM tables (| col | col |)
//   - HTML passthrough (raw HTML blocks left as-is)
//   - Front matter (YAML --- block at top) preserved on stringify
//
// Section navigation:
//   A "section" is all content under a given heading until the next heading
//   of the same or higher level. get_section / set_section use heading text
//   matching (case-insensitive, trim).
//
// Security:
//   - path NUL guard
//   - 4 MB file cap
//   - 50,000 node limit

const fs   = require("fs");
const path = require("path");

// ── Constants ────────────────────────────────────────────────────────────────
const MAX_FILE_BYTES = 4 * 1024 * 1024; // 4 MB
const MAX_NODES      = 50_000;

// ── Error helper ─────────────────────────────────────────────────────────────
function err(msg, code) {
  return Object.assign(new Error(msg), { code });
}

// ── Path helpers ──────────────────────────────────────────────────────────────
function resolvePath(p) {
  if (typeof p !== "string" || p.length === 0)
    throw err("markdown_client: 'path' must be a non-empty string.", "INVALID_ARG");
  if (p.includes("\0"))
    throw err("markdown_client: 'path' must not contain NUL bytes.", "INVALID_ARG");
  return path.resolve(p);
}

function readFileSafe(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_FILE_BYTES)
    throw err(
      `markdown_client: file too large (${stat.size} bytes; max ${MAX_FILE_BYTES}).`,
      "FILE_TOO_LARGE",
    );
  return fs.readFileSync(filePath, "utf8");
}

// ── Normalise line endings ────────────────────────────────────────────────────
function normaliseLines(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

// ── Front-matter stripper ─────────────────────────────────────────────────────
// Returns { front, body } where front is the raw YAML block (or "") and
// body is the rest of the document.
function splitFrontMatter(text) {
  const t = normaliseLines(text);
  if (!t.startsWith("---\n") && !t.startsWith("---\r\n")) return { front: "", body: t };
  const end = t.indexOf("\n---", 3);
  if (end === -1) return { front: "", body: t };
  const front = t.slice(0, end + 4); // includes closing ---
  const body  = t.slice(end + 4);
  return { front, body };
}

// ── Block-level tokeniser ─────────────────────────────────────────────────────
// Returns an array of block tokens:
//   { type: "heading",    level, text, raw }
//   { type: "fenced_code", lang, code, raw }
//   { type: "code",       code, raw }                  (indented)
//   { type: "blockquote", raw }
//   { type: "table",      header, rows, raw }
//   { type: "hr",         raw }
//   { type: "list",       ordered, items, raw }
//   { type: "html",       raw }
//   { type: "blank",      raw }
//   { type: "paragraph",  raw }

function tokeniseBlocks(body) {
  const lines  = body.split("\n");
  const tokens = [];
  let nodeCount = 0;
  let i = 0;

  function push(tok) {
    if (++nodeCount > MAX_NODES)
      throw err(`markdown_client: document exceeds ${MAX_NODES} node limit.`, "TOO_MANY_NODES");
    tokens.push(tok);
  }

  while (i < lines.length) {
    const line = lines[i];

    // ── Fenced code block (``` or ~~~) ───────────────────────────────────────
    const fenceM = line.match(/^(`{3,}|~{3,})(.*)$/);
    if (fenceM) {
      const fence = fenceM[1];
      const lang  = fenceM[2].trim();
      const raw   = [line];
      i++;
      const codeLines = [];
      while (i < lines.length) {
        const cl = lines[i];
        // Closing fence: same or longer run of the same char, nothing after
        if (cl.trimEnd() === fence || (cl.startsWith(fence[0]) && cl.length >= fence.length && cl.slice(0, cl.length).split("").every(c => c === fence[0]) && cl.trim().split("").every(c => c === fence[0]))) {
          raw.push(cl);
          i++;
          break;
        }
        codeLines.push(cl);
        raw.push(cl);
        i++;
      }
      push({ type: "fenced_code", lang, code: codeLines.join("\n"), raw: raw.join("\n") });
      continue;
    }

    // ── ATX heading (#, ##, ...) ─────────────────────────────────────────────
    const atxM = line.match(/^(#{1,6})(?:\s+(.*))?\s*$/);
    if (atxM && (!atxM[2] || !atxM[2].startsWith("#"))) {
      const level = atxM[1].length;
      const text  = (atxM[2] || "").replace(/\s+#+\s*$/, "").trim(); // strip trailing ###
      push({ type: "heading", level, text, raw: line });
      i++;
      continue;
    }

    // ── Setext heading (=== or --- underline) ────────────────────────────────
    if (i + 1 < lines.length) {
      const next = lines[i + 1];
      if (next.match(/^=+\s*$/) && line.trim()) {
        push({ type: "heading", level: 1, text: line.trim(), raw: line + "\n" + next });
        i += 2;
        continue;
      }
      if (next.match(/^-+\s*$/) && line.trim() && !line.match(/^[-*_]{3,}\s*$/)) {
        push({ type: "heading", level: 2, text: line.trim(), raw: line + "\n" + next });
        i += 2;
        continue;
      }
    }

    // ── Horizontal rule (--- / *** / ___ with optional spaces) ───────────────
    if (line.match(/^\s*(-{3,}|\*{3,}|_{3,})\s*$/)) {
      push({ type: "hr", raw: line });
      i++;
      continue;
    }

    // ── HTML block (safe structural elements only; <script>/<style>/<iframe> etc.
    //    are NOT matched and fall through to paragraph for HTML-escaping)
    if (line.match(/^\s*<(?:\/)?(?:div|section|article|header|footer|nav|main|aside|details|summary|figure|figcaption|blockquote|pre|table|thead|tbody|tfoot|tr|th|td|ul|ol|li|form|fieldset|dl|dt|dd|p|h[1-6]|hr|br|ins|del|sup|sub|small|mark|abbr|address)(?:[\s>\/])/i)) {
      const raw = [line];
      i++;
      // Consume until blank line
      while (i < lines.length && lines[i].trim() !== "") {
        raw.push(lines[i]);
        i++;
      }
      push({ type: "html", raw: raw.join("\n") });
      continue;
    }

    // ── Blockquote (> prefix) ────────────────────────────────────────────────
    if (line.match(/^\s*>/)) {
      const raw = [line];
      i++;
      while (i < lines.length && (lines[i].match(/^\s*>/) || (lines[i].trim() !== "" && !lines[i].match(/^(#{1,6}\s|`{3}|~{3}|[-*+]\s|\d+\.\s)/)))) {
        raw.push(lines[i]);
        i++;
      }
      push({ type: "blockquote", raw: raw.join("\n") });
      continue;
    }

    // ── GFM Table (line contains | ... | and next is --- separator) ──────────
    if (line.includes("|")) {
      const next = i + 1 < lines.length ? lines[i + 1] : "";
      if (next.match(/^[|:\-\s]+$/) && next.includes("-")) {
        // Parse table
        const parseRow = r => r.replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim());
        const header = parseRow(line);
        const rawLines = [line, next];
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes("|")) {
          rows.push(parseRow(lines[i]));
          rawLines.push(lines[i]);
          i++;
        }
        push({ type: "table", header, rows, raw: rawLines.join("\n") });
        continue;
      }
    }

    // ── Unordered list (- * +) ───────────────────────────────────────────────
    if (line.match(/^\s*[-*+]\s+/)) {
      const raw   = [line];
      const items = [line.replace(/^\s*[-*+]\s+/, "")];
      i++;
      while (i < lines.length) {
        const l = lines[i];
        if (l.match(/^\s*[-*+]\s+/)) {
          raw.push(l);
          items.push(l.replace(/^\s*[-*+]\s+/, ""));
          i++;
        } else if (l.match(/^\s+/) && !l.match(/^\s*\n/)) {
          // continuation line
          raw.push(l);
          items[items.length - 1] += " " + l.trim();
          i++;
        } else {
          break;
        }
      }
      // Count each list item toward the node limit
      if ((nodeCount + items.length) > MAX_NODES)
        throw err(`markdown_client: document exceeds ${MAX_NODES} node limit.`, "TOO_MANY_NODES");
      nodeCount += items.length;
      tokens.push({ type: "list", ordered: false, items, raw: raw.join("\n") });
      continue;
    }

    // ── Ordered list (1. 2. etc.) ────────────────────────────────────────────
    if (line.match(/^\s*\d+\.\s+/)) {
      const raw   = [line];
      const items = [line.replace(/^\s*\d+\.\s+/, "")];
      i++;
      while (i < lines.length) {
        const l = lines[i];
        if (l.match(/^\s*\d+\.\s+/)) {
          raw.push(l);
          items.push(l.replace(/^\s*\d+\.\s+/, ""));
          i++;
        } else if (l.match(/^\s+/) && !l.match(/^\s*\n/)) {
          raw.push(l);
          items[items.length - 1] += " " + l.trim();
          i++;
        } else {
          break;
        }
      }
      // Count each list item toward the node limit
      if ((nodeCount + items.length) > MAX_NODES)
        throw err(`markdown_client: document exceeds ${MAX_NODES} node limit.`, "TOO_MANY_NODES");
      nodeCount += items.length;
      tokens.push({ type: "list", ordered: true, items, raw: raw.join("\n") });
      continue;
    }

    // ── Indented code block (4 spaces or 1 tab) ──────────────────────────────
    if (line.match(/^(    |\t)/)) {
      const raw  = [line];
      const code = [line.replace(/^(    |\t)/, "")];
      i++;
      while (i < lines.length && (lines[i].match(/^(    |\t)/) || lines[i].trim() === "")) {
        raw.push(lines[i]);
        code.push(lines[i].replace(/^(    |\t)/, ""));
        i++;
      }
      push({ type: "code", code: code.join("\n").trimEnd(), raw: raw.join("\n") });
      continue;
    }

    // ── Blank line ───────────────────────────────────────────────────────────
    if (line.trim() === "") {
      push({ type: "blank", raw: line });
      i++;
      continue;
    }

    // ── Paragraph (collect until blank line or block-level token) ────────────
    {
      const raw = [line];
      i++;
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim() === "") break;
        if (l.match(/^(#{1,6}\s|`{3,}|~{3,}|\s*>|\s*[-*+]\s+|\s*\d+\.\s+|\s*[-*_]{3,}\s*$)/)) break;
        raw.push(l);
        i++;
      }
      push({ type: "paragraph", raw: raw.join("\n") });
    }
  }
  return tokens;
}

// ── Inline renderer (Markdown → HTML) ────────────────────────────────────────
function htmlEscape(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderInline(text) {
  // Process inline markdown patterns
  let s = text;

  // Auto-links <http://...>
  s = s.replace(/<(https?:\/\/[^>]+)>/g, (_, url) => `<a href="${htmlEscape(url)}">${htmlEscape(url)}</a>`);

  // Images ![alt](url) - must come before links
  s = s.replace(/!\[([^\]]*)\]\(([^)"]*?)(?:\s+"([^"]*)")\)/g,
    (_, alt, url, title) => `<img src="${htmlEscape(url)}" alt="${htmlEscape(alt)}"${title ? ` title="${htmlEscape(title)}"` : ""}>`);
  s = s.replace(/!\[([^\]]*)\]\(([^)]*?)\)/g,
    (_, alt, url) => `<img src="${htmlEscape(url)}" alt="${htmlEscape(alt)}">`);

  // Links [text](url "title")
  s = s.replace(/\[([^\]]+)\]\(([^)"]*?)(?:\s+"([^"]*)")\)/g,
    (_, text, url, title) => `<a href="${htmlEscape(url)}"${title ? ` title="${htmlEscape(title)}"` : ""}>${text}</a>`);
  s = s.replace(/\[([^\]]+)\]\(([^)]*?)\)/g,
    (_, text, url) => `<a href="${htmlEscape(url)}">${text}</a>`);

  // Inline code (backtick) — must be done before bold/italic
  s = s.replace(/`([^`]+)`/g, (_, code) => `<code>${htmlEscape(code)}</code>`);

  // Bold-italic ***text*** or ___text___
  s = s.replace(/\*\*\*([^*]+)\*\*\*/g, (_, t) => `<strong><em>${t}</em></strong>`);
  s = s.replace(/___([^_]+)___/g, (_, t) => `<strong><em>${t}</em></strong>`);

  // Bold **text** or __text__
  s = s.replace(/\*\*([^*]+)\*\*/g, (_, t) => `<strong>${t}</strong>`);
  s = s.replace(/__([^_]+)__/g, (_, t) => `<strong>${t}</strong>`);

  // Italic *text* or _text_
  s = s.replace(/\*([^*]+)\*/g, (_, t) => `<em>${t}</em>`);
  s = s.replace(/_([^_]+)_/g, (_, t) => `<em>${t}</em>`);

  // Strikethrough ~~text~~
  s = s.replace(/~~([^~]+)~~/g, (_, t) => `<del>${t}</del>`);

  // Hard line breaks (2+ trailing spaces)
  s = s.replace(/  +\n/g, "<br>\n");

  return s;
}

// ── Block renderer (blocks → HTML string) ─────────────────────────────────────
function renderBlocks(tokens) {
  const parts = [];

  for (const tok of tokens) {
    switch (tok.type) {
      case "blank":
        break;

      case "heading": {
        const h = `h${tok.level}`;
        const id = tok.text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
        parts.push(`<${h} id="${id}">${renderInline(htmlEscape(tok.text))}</${h}>`);
        break;
      }

      case "fenced_code":
        parts.push(`<pre><code${tok.lang ? ` class="language-${htmlEscape(tok.lang)}"` : ""}>${htmlEscape(tok.code)}</code></pre>`);
        break;

      case "code":
        parts.push(`<pre><code>${htmlEscape(tok.code)}</code></pre>`);
        break;

      case "blockquote": {
        const inner = tok.raw.split("\n")
          .map(l => l.replace(/^\s*>\s?/, "")).join("\n");
        parts.push(`<blockquote>\n${renderInline(htmlEscape(inner))}\n</blockquote>`);
        break;
      }

      case "hr":
        parts.push("<hr>");
        break;

      case "html":
        parts.push(tok.raw); // passthrough
        break;

      case "list": {
        const tag = tok.ordered ? "ol" : "ul";
        const items = tok.items.map(item => `  <li>${renderInline(htmlEscape(item))}</li>`).join("\n");
        parts.push(`<${tag}>\n${items}\n</${tag}>`);
        break;
      }

      case "table": {
        const ths = tok.header.map(h => `<th>${renderInline(htmlEscape(h))}</th>`).join("");
        const rows = tok.rows.map(row => {
          const tds = row.map(c => `<td>${renderInline(htmlEscape(c))}</td>`).join("");
          return `  <tr>${tds}</tr>`;
        }).join("\n");
        parts.push(`<table>\n<thead><tr>${ths}</tr></thead>\n<tbody>\n${rows}\n</tbody>\n</table>`);
        break;
      }

      case "paragraph":
        parts.push(`<p>${renderInline(htmlEscape(tok.raw))}</p>`);
        break;

      default:
        parts.push(`<p>${htmlEscape(tok.raw)}</p>`);
    }
  }

  return parts.join("\n");
}

// ── Link extractor ────────────────────────────────────────────────────────────
function extractLinksFromText(text) {
  const links = [];
  const seen  = new Set();

  // Inline links [text](url)
  const inlineRe = /!?\[([^\]]*)\]\(([^)"\s]+)(?:\s+"([^"]*)")\)/g;
  let m;
  while ((m = inlineRe.exec(text)) !== null) {
    const isImage = m[0].startsWith("!");
    const entry = { type: isImage ? "image" : "link", text: m[1], url: m[2], ...(m[3] ? { title: m[3] } : {}) };
    const key = `${entry.type}:${entry.url}`;
    if (!seen.has(key)) { links.push(entry); seen.add(key); }
  }

  // Plain inline links [text](url) without title
  const plainRe = /!?\[([^\]]*)\]\(([^)"\s]+)\)/g;
  while ((m = plainRe.exec(text)) !== null) {
    const isImage = m[0].startsWith("!");
    const entry = { type: isImage ? "image" : "link", text: m[1], url: m[2] };
    const key = `${entry.type}:${entry.url}`;
    if (!seen.has(key)) { links.push(entry); seen.add(key); }
  }

  // Auto-links <http://...>
  const autoRe = /<(https?:\/\/[^>]+)>/g;
  while ((m = autoRe.exec(text)) !== null) {
    const entry = { type: "autolink", url: m[1] };
    const key = `autolink:${entry.url}`;
    if (!seen.has(key)) { links.push(entry); seen.add(key); }
  }

  // Reference-style links [id]: url "title"
  const refRe = /^\[([^\]]+)\]:\s*(\S+)(?:\s+"([^"]*)")\s*$/gm;
  while ((m = refRe.exec(text)) !== null) {
    const entry = { type: "reference", id: m[1], url: m[2], ...(m[3] ? { title: m[3] } : {}) };
    const key = `ref:${m[1]}`;
    if (!seen.has(key)) { links.push(entry); seen.add(key); }
  }

  return links;
}

// ── Document statistics ───────────────────────────────────────────────────────
function docStats(tokens, body) {
  let headings = 0, codeBlocks = 0, links = 0, images = 0, tables = 0, lists = 0;
  for (const t of tokens) {
    if (t.type === "heading")                    headings++;
    if (t.type === "fenced_code" || t.type === "code") codeBlocks++;
    if (t.type === "table")                      tables++;
    if (t.type === "list")                       lists++;
  }
  const bodyLinks = extractLinksFromText(body);
  links  = bodyLinks.filter(l => l.type === "link" || l.type === "autolink" || l.type === "reference").length;
  images = bodyLinks.filter(l => l.type === "image").length;
  const wordCount = body.replace(/```[\s\S]*?```/g, "").replace(/[^\w\s]/g, " ").split(/\s+/).filter(Boolean).length;
  return { headings, codeBlocks, links, images, tables, lists, wordCount };
}

// ── Section helpers ──────────────────────────────────────────────────────────
// Find all heading positions in token array
function findSection(tokens, headingText, level) {
  const needle = headingText.trim().toLowerCase();
  let startIdx = -1;
  let startLevel = level || null;

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== "heading") continue;
    if (tokens[i].text.toLowerCase().trim() === needle) {
      if (level && tokens[i].level !== level) continue;
      startIdx  = i;
      startLevel = tokens[i].level;
      break;
    }
  }
  if (startIdx === -1) return null;

  // Section ends at next heading of same or higher level
  let endIdx = tokens.length;
  for (let i = startIdx + 1; i < tokens.length; i++) {
    if (tokens[i].type === "heading" && tokens[i].level <= startLevel) {
      endIdx = i;
      break;
    }
  }
  return { startIdx, endIdx, level: startLevel };
}

function tokensToMarkdown(tokens) {
  return tokens.map(t => t.raw).join("\n");
}

// ── Operations ───────────────────────────────────────────────────────────────

function opRead(args) {
  const resolved = resolvePath(args.path);
  const raw      = readFileSafe(resolved);
  const { front, body } = splitFrontMatter(raw);
  const tokens   = tokeniseBlocks(body);
  const stats    = docStats(tokens, body);
  const headings = tokens
    .filter(t => t.type === "heading")
    .map(t => ({ level: t.level, text: t.text }));
  return {
    path:       args.path,
    lineCount:  raw.split("\n").length,
    hasFrontMatter: !!front,
    stats,
    headings,
    tokenCount: tokens.length,
  };
}

function opGetSection(args) {
  if (!args.heading)
    throw err("markdown_client: 'heading' is required for get_section.", "INVALID_ARG");
  const resolved = resolvePath(args.path);
  const raw      = readFileSafe(resolved);
  const { body } = splitFrontMatter(raw);
  const tokens   = tokeniseBlocks(body);
  const sec = findSection(tokens, args.heading, args.level);
  if (!sec) return { path: args.path, heading: args.heading, found: false, content: null };

  const sectionTokens = tokens.slice(sec.startIdx, sec.endIdx);
  const content = tokensToMarkdown(sectionTokens);
  return { path: args.path, heading: args.heading, found: true, level: sec.level, content };
}

function opSetSection(args) {
  if (!args.heading)
    throw err("markdown_client: 'heading' is required for set_section.", "INVALID_ARG");
  if (args.content === undefined)
    throw err("markdown_client: 'content' is required for set_section.", "INVALID_ARG");

  const resolved = resolvePath(args.path);
  const raw      = readFileSafe(resolved);
  const { front, body } = splitFrontMatter(raw);
  const tokens   = tokeniseBlocks(body);
  const sec = findSection(tokens, args.heading, args.level);

  let newBody;
  if (!sec) {
    // Append new section at end
    const heading = args.level ? "#".repeat(args.level) : "##";
    newBody = body.trimEnd() + `\n\n${heading} ${args.heading}\n\n${args.content.trimEnd()}\n`;
  } else {
    // Replace content between heading token and next heading
    const before  = tokens.slice(0, sec.startIdx + 1); // include the heading itself
    const after   = tokens.slice(sec.endIdx);
    const headingRaw  = before.map(t => t.raw).join("\n");
    const afterRaw    = after.map(t => t.raw).join("\n");
    const newContent  = args.content.trim();
    newBody = headingRaw + "\n\n" + newContent + (afterRaw ? "\n\n" + afterRaw : "\n");
  }

  const outText = front ? front + "\n" + newBody : newBody;
  const outPath = args.output_path || args.path;
  const outResolved = resolvePath(outPath);
  fs.mkdirSync(path.dirname(outResolved), { recursive: true });
  fs.writeFileSync(outResolved, outText, "utf8");
  return { path: args.path, heading: args.heading, written: true, output_path: outPath };
}

function opExtractLinks(args) {
  const resolved = resolvePath(args.path);
  const raw      = readFileSafe(resolved);
  const { body } = splitFrontMatter(raw);

  const links    = extractLinksFromText(body);
  const typeFilter = args.type; // "link" | "image" | "autolink" | "reference" | undefined
  const filtered   = typeFilter ? links.filter(l => l.type === typeFilter) : links;
  return {
    path:      args.path,
    total:     filtered.length,
    type:      typeFilter || "all",
    links:     filtered,
  };
}

function opExtractHeadings(args) {
  const resolved = resolvePath(args.path);
  const raw      = readFileSafe(resolved);
  const { body } = splitFrontMatter(raw);
  const tokens   = tokeniseBlocks(body);

  const minLevel = args.min_level || 1;
  const maxLevel = args.max_level || 6;
  const headings = tokens
    .filter(t => t.type === "heading" && t.level >= minLevel && t.level <= maxLevel)
    .map(t => ({ level: t.level, text: t.text, anchor: t.text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") }));
  return { path: args.path, count: headings.length, headings };
}

function opExtractCodeBlocks(args) {
  const resolved = resolvePath(args.path);
  const raw      = readFileSafe(resolved);
  const { body } = splitFrontMatter(raw);
  const tokens   = tokeniseBlocks(body);

  const langFilter = args.language;
  const blocks = tokens
    .filter(t => t.type === "fenced_code" || t.type === "code")
    .filter(t => !langFilter || (t.type === "fenced_code" && t.lang === langFilter))
    .map((t, idx) => ({
      index: idx,
      type:  t.type === "fenced_code" ? "fenced" : "indented",
      lang:  t.type === "fenced_code" ? (t.lang || null) : null,
      code:  t.code,
      lines: t.code.split("\n").length,
    }));
  return { path: args.path, count: blocks.length, language: langFilter || null, blocks };
}

function opConvertToHtml(args) {
  let mdText;
  if (args.path != null && args.markdown != null)
    throw err("markdown_client: provide 'path' or 'markdown', not both.", "INVALID_ARG");

  if (args.path != null) {
    const resolved = resolvePath(args.path);
    mdText = readFileSafe(resolved);
  } else if (args.markdown != null) {
    if (typeof args.markdown !== "string")
      throw err("markdown_client: 'markdown' must be a string.", "INVALID_ARG");
    mdText = args.markdown;
  } else {
    throw err("markdown_client: provide 'path' or 'markdown' for convert_to_html.", "INVALID_ARG");
  }

  const { front, body } = splitFrontMatter(mdText);
  const tokens = tokeniseBlocks(body);
  const html   = renderBlocks(tokens);

  const wrap = args.wrap !== false;
  const title = args.title || "";
  const fullHtml = wrap
    ? `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n${title ? `<title>${htmlEscape(title)}</title>\n` : ""}</head>\n<body>\n${html}\n</body>\n</html>`
    : html;

  if (args.output_path) {
    const outResolved = resolvePath(args.output_path);
    fs.mkdirSync(path.dirname(outResolved), { recursive: true });
    fs.writeFileSync(outResolved, fullHtml, "utf8");
    return { length: fullHtml.length, written: true, output_path: args.output_path, html: fullHtml };
  }
  return { length: fullHtml.length, written: false, html: fullHtml };
}

function opStringify(args) {
  const resolved = resolvePath(args.path);
  const raw      = readFileSafe(resolved);
  const { front, body } = splitFrontMatter(raw);
  const tokens   = tokeniseBlocks(body);

  // Normalise: trim trailing blank tokens, join with consistent newlines
  const cleaned = tokens.filter(t => t.type !== "blank" || true); // keep blanks for now
  let md = tokensToMarkdown(cleaned);

  // Normalise multiple blank lines to max 2
  md = md.replace(/\n{3,}/g, "\n\n");

  const outText = front ? front + "\n" + md.trim() + "\n" : md.trim() + "\n";

  if (args.output_path) {
    const outResolved = resolvePath(args.output_path);
    fs.mkdirSync(path.dirname(outResolved), { recursive: true });
    fs.writeFileSync(outResolved, outText, "utf8");
    return { length: outText.length, written: true, output_path: args.output_path, markdown: outText };
  }
  return { length: outText.length, written: false, markdown: outText };
}

// ── Main Dispatcher ───────────────────────────────────────────────────────────
function markdownClient(args) {
  if (!args || !args.operation)
    throw err("markdown_client: 'operation' is required.", "INVALID_ARG");

  switch (args.operation) {
    case "read":                return opRead(args);
    case "get_section":        return opGetSection(args);
    case "set_section":        return opSetSection(args);
    case "extract_links":      return opExtractLinks(args);
    case "extract_headings":   return opExtractHeadings(args);
    case "extract_code_blocks":return opExtractCodeBlocks(args);
    case "convert_to_html":    return opConvertToHtml(args);
    case "stringify":          return opStringify(args);
    default:
      throw err(
        `markdown_client: unknown operation '${args.operation}'. Valid: read, get_section, set_section, extract_links, extract_headings, extract_code_blocks, convert_to_html, stringify.`,
        "INVALID_ARG",
      );
  }
}

module.exports = {
  markdownClient,
  // Exported for testing
  tokeniseBlocks,
  renderBlocks,
  renderInline,
  splitFrontMatter,
  extractLinksFromText,
  htmlEscape,
  findSection,
};
