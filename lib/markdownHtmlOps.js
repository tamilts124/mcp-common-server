"use strict";
// ── MARKDOWN → HTML ─────────────────────────────────────────────────────────────
// Zero-dependency pure-JS Markdown to HTML converter.
// Block features: ATX headings (#–######), setext headings (===, ---),
//   fenced code blocks (``` or ~~~), indented code blocks (4 spaces),
//   blockquotes (>), ordered/unordered lists (nested up to 6 deep via indentation),
//   GFM tables (with alignment), thematic breaks (---, ***, ___), paragraphs,
//   hard line breaks (trailing two spaces).
// Inline features: bold (**/**__), italic (*/_), bold+italic (***), strikethrough (~~),
//   code span (`), links ([text](url)), images (![alt](src)), autolinks (<url>/<email>),
//   backslash escapes.
// Raw HTML in input is escaped by default; pass unsafe_html:true to pass it through.
// Input is capped at 1 MB. Returns { html, stats }.

const MAX_INPUT = 1 * 1024 * 1024; // 1 MB

// ── HTML escaping ─────────────────────────────────────────────────────────────

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Inline parser ─────────────────────────────────────────────────────────────
// Character-by-character scanner; longest-match-first.

const ESCAPE_CHARS = /[\\`*_{}\[\]()#+\-.!>|~]/;

function parseInline(text, unsafeHtml) {
  let out = "";
  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text[i];

    // Backslash escape
    if (c === "\\" && i + 1 < n && ESCAPE_CHARS.test(text[i + 1])) {
      out += esc(text[i + 1]);
      i += 2;
      continue;
    }

    // Code span: `` or ` (multiple backticks as opener/closer)
    if (c === "`") {
      let ticks = 0;
      while (i + ticks < n && text[i + ticks] === "`") ticks++;
      const marker = "`".repeat(ticks);
      // Find matching closer (exact same number of backticks)
      let j = i + ticks;
      let found = -1;
      while (j <= n - ticks) {
        if (text[j] === "`") {
          let ct = 0;
          while (j + ct < n && text[j + ct] === "`") ct++;
          if (ct === ticks) { found = j; break; }
          j += ct;
        } else {
          j++;
        }
      }
      if (found !== -1) {
        let code = text.slice(i + ticks, found);
        // Collapse single leading/trailing space (spec §6.3)
        if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ")) {
          code = code.slice(1, -1);
        }
        out += `<code>${esc(code)}</code>`;
        i = found + ticks;
        continue;
      }
    }

    // Image: ![alt](url) or ![alt](url "title")
    if (c === "!" && text[i + 1] === "[") {
      const m = matchLink(text, i + 1, n);
      if (m) {
        const titleAttr = m.title ? ` title="${esc(m.title)}"` : "";
        out += `<img src="${esc(m.url)}" alt="${esc(m.label)}"${titleAttr}>`;
        i = m.end;
        continue;
      }
    }

    // Link: [text](url) or [text](url "title")
    if (c === "[") {
      const m = matchLink(text, i, n);
      if (m) {
        const inner = parseInline(m.label, unsafeHtml);
        const titleAttr = m.title ? ` title="${esc(m.title)}"` : "";
        out += `<a href="${esc(m.url)}"${titleAttr}>${inner}</a>`;
        i = m.end;
        continue;
      }
    }

    // Autolink: <url> or <email>
    if (c === "<") {
      const gtIdx = text.indexOf(">", i + 1);
      if (gtIdx !== -1) {
        const inner = text.slice(i + 1, gtIdx);
        // URL autolink
        if (/^[a-zA-Z][a-zA-Z0-9+\-.]{1,31}:\/\/[^\s<>]+$/.test(inner)) {
          out += `<a href="${esc(inner)}">${esc(inner)}</a>`;
          i = gtIdx + 1;
          continue;
        }
        // Email autolink
        if (/^[^\s@"<>]+@[^\s@"<>]+\.[^\s@"<>.]+$/.test(inner)) {
          out += `<a href="mailto:${esc(inner)}">${esc(inner)}</a>`;
          i = gtIdx + 1;
          continue;
        }
        // Raw HTML tag passthrough or escape
        if (unsafeHtml && /^\/?\w/.test(inner)) {
          out += "<" + inner + ">";
          i = gtIdx + 1;
          continue;
        }
      }
      out += "&lt;";
      i++;
      continue;
    }

    // Strikethrough: ~~text~~
    if (c === "~" && text[i + 1] === "~") {
      const close = findClose(text, "~~", i + 2, n);
      if (close !== -1) {
        out += `<del>${parseInline(text.slice(i + 2, close), unsafeHtml)}</del>`;
        i = close + 2;
        continue;
      }
    }

    // Bold + italic: ***text*** or ___text___
    if ((c === "*" || c === "_") && text[i + 1] === c && text[i + 2] === c) {
      const delim = c.repeat(3);
      const close = findClose(text, delim, i + 3, n);
      if (close !== -1) {
        out += `<strong><em>${parseInline(text.slice(i + 3, close), unsafeHtml)}</em></strong>`;
        i = close + 3;
        continue;
      }
    }

    // Bold: **text** or __text__
    if ((c === "*" || c === "_") && text[i + 1] === c) {
      const delim = c.repeat(2);
      const close = findClose(text, delim, i + 2, n);
      if (close !== -1) {
        out += `<strong>${parseInline(text.slice(i + 2, close), unsafeHtml)}</strong>`;
        i = close + 2;
        continue;
      }
    }

    // Italic: *text* or _text_ (for _ require non-word char boundary)
    if (c === "*" || (c === "_" && (i === 0 || /\W/.test(text[i - 1])))) {
      const close = findInlineClose(text, c, i + 1, n);
      if (close !== -1) {
        out += `<em>${parseInline(text.slice(i + 1, close), unsafeHtml)}</em>`;
        i = close + 1;
        continue;
      }
    }

    // Default character: escape HTML specials
    if (c === "&") out += "&amp;";
    else if (c === ">") out += "&gt;";
    else if (c === '"') out += "&quot;";
    else out += c;
    i++;
  }
  return out;
}

// Find closing delimiter for bold/italic (** or __)
function findClose(text, delim, start, n) {
  let j = start;
  while (j <= n - delim.length) {
    const idx = text.indexOf(delim, j);
    if (idx === -1) return -1;
    return idx;
  }
  return -1;
}

/** Find closing single *or_ for italic, avoiding ** */
function findInlineClose(text, delim, start, n) {
  for (let j = start; j < n; j++) {
    if (text[j] === delim && text[j + 1] !== delim) {
      // for _ require non-word follows (or end)
      if (delim === "_" && j + 1 < n && /\w/.test(text[j + 1])) continue;
      return j;
    }
  }
  return -1;
}

/** Match [label](url "title") starting at '['. Returns null or { label, url, title, end }. */
function matchLink(text, start, n) {
  if (text[start] !== "[") return null;
  // Find closing ] (tracking nested brackets)
  let depth = 0;
  let j = start + 1;
  while (j < n) {
    if (text[j] === "[") depth++;
    else if (text[j] === "]") {
      if (depth === 0) break;
      depth--;
    }
    j++;
  }
  if (j >= n || text[j] !== "]") return null;
  const label = text.slice(start + 1, j);
  if (text[j + 1] !== "(") return null;

  // Find closing ) (tracking nested parens)
  let k = j + 2;
  let pdepth = 0;
  while (k < n) {
    if (text[k] === "(") pdepth++;
    else if (text[k] === ")") {
      if (pdepth === 0) break;
      pdepth--;
    }
    k++;
  }
  if (k >= n) return null;
  let dest = text.slice(j + 2, k).trim();

  // Extract optional title: "...", '...', (...)
  let url = dest;
  let title = null;
  const titleMatch = dest.match(/^(.*?)\s+(?:"(.*?)"|'(.*?)' |\((.*?)\))$/);
  if (titleMatch) {
    url = titleMatch[1].trim();
    title = titleMatch[2] ?? titleMatch[3] ?? titleMatch[4] ?? null;
  }
  // Strip optional angle-bracket wrapping on url: <url>
  if (url.startsWith("<") && url.endsWith(">")) url = url.slice(1, -1);

  return { label, url, title, end: k + 1 };
}

// ── Block parser ──────────────────────────────────────────────────────────────

function markdownToHtml(markdown, opts = {}) {
  if (typeof markdown !== "string")
    throw new Error("markdown_to_html: 'markdown' must be a string.");
  if (markdown.length > MAX_INPUT)
    throw new Error(`markdown_to_html: input exceeds 1 MB limit (${markdown.length} bytes).`);

  const unsafeHtml = !!opts.unsafe_html;
  const stats = {
    inputLength: markdown.length,
    outputLength: 0,
    headings: 0,
    codeBlocks: 0,
    tables: 0,
    blockquotes: 0,
    lists: 0,
    links: 0,
    images: 0,
    paragraphs: 0,
  };

  // Normalize line endings and split
  const lines = markdown.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const html = parseBlocks(lines, 0, lines.length, unsafeHtml, stats);

  stats.outputLength = html.length;
  // Post-count links and images from output HTML
  stats.links = (html.match(/<a /g) || []).length;
  stats.images = (html.match(/<img /g) || []).length;

  return { html, stats };
}

/** Parse a slice of lines as block-level content. Returns HTML string. */
function parseBlocks(lines, from, to, unsafeHtml, stats) {
  let out = "";
  let i = from;

  const inline = (text) => parseInline(text, unsafeHtml);

  while (i < to) {
    const line = lines[i];

    // Blank line — skip
    if (/^\s*$/.test(line)) { i++; continue; }

    // ATX heading: # to ######
    {
      const m = line.match(/^(#{1,6})(?:\s+(.+?))?\s*(?:#+\s*)?$/);
      if (m && m[1].length <= 6) {
        const level = m[1].length;
        const text = (m[2] || "").trim().replace(/\s+#+\s*$/, "").replace(/#+$/, "").trim();
        out += `<h${level}>${inline(text)}</h${level}>\n`;
        stats.headings++;
        i++;
        continue;
      }
    }

    // Thematic break: 3+ -, *, _ optionally separated by spaces (whole line)
    if (/^[ \t]{0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})[ \t]*$/.test(line)) {
      out += "<hr>\n";
      i++;
      continue;
    }

    // Fenced code block: ``` lang or ~~~ lang
    {
      const m = line.match(/^(`{3,}|~{3,})([ \t]*)(\S+)?[ \t]*$/);
      if (m) {
        const fenceChar = m[1][0];
        const fenceLen = m[1].length;
        const lang = m[3] || "";
        i++;
        const codeLines = [];
        while (i < to) {
          const fl = lines[i];
          // Closing fence: same character, >= same length, optional trailing spaces
          const close = fl.match(/^(`{3,}|~{3,})[ \t]*$/);
          if (close && close[1][0] === fenceChar && close[1].length >= fenceLen) {
            i++;
            break;
          }
          codeLines.push(fl);
          i++;
        }
        const codeHtml = esc(codeLines.join("\n"));
        const langAttr = lang ? ` class="language-${esc(lang)}"` : "";
        out += `<pre><code${langAttr}>${codeHtml}</code></pre>\n`;
        stats.codeBlocks++;
        continue;
      }
    }

    // Blockquote: > ...
    if (/^[ \t]{0,3}>/.test(line)) {
      const bqLines = [];
      while (i < to && /^[ \t]{0,3}>/.test(lines[i])) {
        bqLines.push(lines[i].replace(/^[ \t]{0,3}>[ \t]?/, ""));
        i++;
        // Allow lazy continuation lines (non-blank, non-block)
        while (i < to && !/^\s*$/.test(lines[i]) && !/^[ \t]{0,3}>/.test(lines[i]) &&
               !/^(#{1,6})\s/.test(lines[i]) && !/^(`{3,}|~{3,})/.test(lines[i])) {
          bqLines.push(lines[i]);
          i++;
        }
      }
      const innerStats = { headings: 0, codeBlocks: 0, tables: 0, blockquotes: 0, lists: 0, links: 0, images: 0, paragraphs: 0, inputLength: 0, outputLength: 0 };
      const inner = parseBlocks(bqLines, 0, bqLines.length, unsafeHtml, innerStats);
      out += `<blockquote>\n${inner}</blockquote>\n`;
      stats.blockquotes++;
      continue;
    }

    // Indented code block: 4 spaces or 1 tab
    if (/^(    |\t)/.test(line)) {
      const codeLines = [];
      while (i < to && (/^(    |\t)/.test(lines[i]) || /^\s*$/.test(lines[i]))) {
        codeLines.push(lines[i].replace(/^(    |\t)/, ""));
        i++;
      }
      // Trim trailing blank lines
      while (codeLines.length > 0 && /^\s*$/.test(codeLines[codeLines.length - 1]))
        codeLines.pop();
      out += `<pre><code>${esc(codeLines.join("\n"))}</code></pre>\n`;
      stats.codeBlocks++;
      continue;
    }

    // Setext heading: text then === or ---
    if (i + 1 < to) {
      const nextLine = lines[i + 1];
      if (/^=+[ \t]*$/.test(nextLine)) {
        out += `<h1>${inline(line.trim())}</h1>\n`;
        stats.headings++;
        i += 2;
        continue;
      }
      if (/^-+[ \t]*$/.test(nextLine) && nextLine.trim().length >= 2 && !/^[-*+]\s/.test(line)) {
        out += `<h2>${inline(line.trim())}</h2>\n`;
        stats.headings++;
        i += 2;
        continue;
      }
    }

    // Unordered list: -, *, + followed by space
    if (/^[ \t]{0,3}[-*+][ \t]/.test(line)) {
      const r = parseList(lines, i, to, 0, false, inline, stats);
      out += r.html;
      i = r.next;
      stats.lists++;
      continue;
    }

    // Ordered list: digit+ . or ) followed by space
    if (/^[ \t]{0,3}\d+[.)][ \t]/.test(line)) {
      const r = parseList(lines, i, to, 0, true, inline, stats);
      out += r.html;
      i = r.next;
      stats.lists++;
      continue;
    }

    // GFM Table: requires separator row on next line
    if (i + 1 < to && /[|]/.test(line) && /^[ \t]*\|?[ \t]*[-:]+[ \t]*(\|[ \t]*[-:]+[ \t]*)+\|?[ \t]*$/.test(lines[i + 1])) {
      const r = parseTable(lines, i, to, inline);
      if (r) {
        out += r.html;
        i = r.next;
        stats.tables++;
        continue;
      }
    }

    // Paragraph: collect until blank line or block element start
    const paraLines = [];
    while (i < to) {
      const l = lines[i];
      if (/^\s*$/.test(l)) break;
      if (/^[ \t]{0,3}(#{1,6}[ \t]|`{3,}|~{3,}|>|[-*+][ \t]|\d+[.)][ \t])/.test(l)) break;
      if (/^[ \t]{0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})[ \t]*$/.test(l)) break;
      // Setext heading check
      if (i + 1 < to && (/^=+[ \t]*$/.test(lines[i + 1]) || /^-{2,}[ \t]*$/.test(lines[i + 1]))) break;
      // Hard line break: 2+ trailing spaces → <br>
      if (/  +$/.test(l)) {
        paraLines.push(l.replace(/  +$/, "\x00BR\x00"));
      } else {
        paraLines.push(l);
      }
      i++;
    }
    if (paraLines.length > 0) {
      const paraRaw = inline(paraLines.join("\n")).replace(/\x00BR\x00/g, "<br>");
      out += `<p>${paraRaw}</p>\n`;
      stats.paragraphs++;
    }
  }

  return out;
}

/** Parse a list block (ordered or unordered). Returns { html, next }. */
function parseList(lines, startIdx, endIdx, indent, ordered, inline, stats) {
  const tag = ordered ? "ol" : "ul";
  let out = `<${tag}>\n`;
  let i = startIdx;

  while (i < endIdx) {
    const line = lines[i];

    // Blank line inside list: skip
    if (/^\s*$/.test(line)) { i++; continue; }

    // Match a list item at approximately this indent
    const lineIndent = (line.match(/^([ \t]*)/) || ["", ""])[1].length;
    if (lineIndent < indent) break; // de-indented past our level → stop

    let itemMatch;
    if (ordered) {
      itemMatch = line.match(/^([ \t]*)(\d+)[.)]([ \t]+)(.*)/);
    } else {
      itemMatch = line.match(/^([ \t]*)([-*+])([ \t]+)(.*)/);
    }
    if (!itemMatch) break; // not a list item → stop

    const itemIndent = itemMatch[1].length;
    if (itemIndent < indent) break;
    if (itemIndent > indent + 3) break; // too indented → not our level

    const markerLen = itemMatch[2].length + itemMatch[3].length;
    const firstLine = itemMatch[4];
    const childIndent = itemIndent + markerLen + 1; // continuation indent
    i++;

    // Collect item body lines (continuation)
    const bodyLines = [firstLine];
    while (i < endIdx) {
      const sl = lines[i];
      if (/^\s*$/.test(sl)) {
        // blank line — allowed inside items; include it
        bodyLines.push("");
        i++;
        // If the next non-blank is at a shallower indent, stop
        let ni = i;
        while (ni < endIdx && /^\s*$/.test(lines[ni])) ni++;
        if (ni < endIdx) {
          const nextIndent = (lines[ni].match(/^([ \t]*)/) || ["", ""])[1].length;
          if (nextIndent <= indent && !/^\s*$/.test(lines[ni])) {
            // Non-blank next line at <= our level means paragraph ended
            break;
          }
        }
        continue;
      }
      const slIndent = (sl.match(/^([ \t]*)/) || ["", ""])[1].length;
      if (slIndent < childIndent && slIndent <= indent) break; // belongs to outer
      bodyLines.push(sl.slice(childIndent > slIndent ? slIndent : childIndent));
      i++;
    }

    // Render the item body using parseBlocks (handles sub-lists recursively)
    const innerStats = { headings:0, codeBlocks:0, tables:0, blockquotes:0, lists:0, links:0, images:0, paragraphs:0, inputLength:0, outputLength:0 };
    let itemHtml = parseBlocks(bodyLines, 0, bodyLines.length, false, innerStats);
    // If item has a single <p>, unwrap it for "tight" lists
    const paraCount = (itemHtml.match(/<p>/g) || []).length;
    if (paraCount === 1 && !itemHtml.includes("<ul>") && !itemHtml.includes("<ol>") &&
        !itemHtml.includes("<blockquote>") && !itemHtml.includes("<pre>")) {
      itemHtml = itemHtml.replace(/^<p>([\s\S]*)<\/p>\n$/, "$1");
    }
    out += `<li>${itemHtml}</li>\n`;
  }

  out += `</${tag}>\n`;
  return { html: out, next: i };
}

/** Parse a GFM table. Returns { html, next } or null. */
function parseTable(lines, startIdx, endIdx, inline) {
  const headerLine = lines[startIdx];
  const sepLine = lines[startIdx + 1];

  const headers = splitTableRow(headerLine);
  const sepCells = splitTableRow(sepLine);
  if (headers.length === 0 || sepCells.length === 0) return null;

  // Parse alignment from separator cells
  const aligns = sepCells.map(c => {
    c = c.trim();
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    if (left && right) return " style=\"text-align:center\"";
    if (right)         return " style=\"text-align:right\"";
    if (left)          return " style=\"text-align:left\"";
    return "";
  });

  let html = "<table>\n<thead>\n<tr>\n";
  headers.forEach((h, idx) => {
    html += `<th${aligns[idx] ?? ""}>${inline(h.trim())}</th>\n`;
  });
  html += "</tr>\n</thead>\n<tbody>\n";

  let i = startIdx + 2;
  while (i < endIdx) {
    const l = lines[i];
    if (/^\s*$/.test(l) || !/[|]/.test(l)) break;
    const cells = splitTableRow(l);
    html += "<tr>\n";
    headers.forEach((_, idx) => {
      const cell = (cells[idx] ?? "").trim();
      html += `<td${aligns[idx] ?? ""}>${inline(cell)}</td>\n`;
    });
    html += "</tr>\n";
    i++;
  }

  html += "</tbody>\n</table>\n";
  return { html, next: i };
}

function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|"))   s = s.slice(0, -1);
  return s.split("|");
}

module.exports = { markdownToHtml };
