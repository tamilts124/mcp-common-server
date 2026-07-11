"use strict";
// ── TEMPLATE RENDER ───────────────────────────────────────────────────────────
// template_render — lightweight Mustache-compatible string interpolation.
// Zero dependencies — pure Node.js built-ins (no file I/O, no network).
//
// Supported tags:
//   {{key}}          — HTML-escaped interpolation
//   {{{key}}}        — unescaped (raw) interpolation
//   {{&key}}         — unescaped alias
//   {{#section}}...{{/section}}   — truthy block (arrays → loop; truthy scalars → render once)
//   {{^section}}...{{/section}}   — inverted/falsy block
//   {{! comment }}   — comment (stripped)
//   {{>partial_name}} — partial lookup by name from the 'partials' map
//
// Context access: dot-notation paths ("user.name", "items.0.value").
// Not implemented (by design, to stay zero-dep): lambdas, set delimiters.

const { ToolError } = require("./errors");

const MAX_TEMPLATE_BYTES = 1 * 1024 * 1024; // 1 MB
const MAX_DEPTH          = 32;               // recursion depth guard (partials + sections)

// ── HTML escape ──────────────────────────────────────────────────────────────
const HTML_ESCAPE = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" };
function htmlEscape(s) {
  return String(s).replace(/[&<>"']/g, c => HTML_ESCAPE[c]);
}

// ── Dot-path context lookup ──────────────────────────────────────────────────
/**
 * Look up `key` in `ctx` with dot-notation support.
 * Returns the value (possibly undefined) and a boolean `found` to
 * distinguish a key whose value is `undefined` from a missing key.
 *
 * Special case: `key === "."` means "the current item" (Mustache convention).
 * When iterating a primitive array the loop body stores the scalar under the
 * literal key "." in the merged context.  We prefer that explicit value over
 * returning the whole context object.
 */
function lookup(key, ctx) {
  if (key === ".") {
    // Primitive-loop marker: prefer ctx["."] when set by the array-loop path.
    if (ctx !== null && typeof ctx === "object" &&
        Object.prototype.hasOwnProperty.call(ctx, "."))
      return { value: ctx["."], found: true };
    return { value: ctx, found: true };
  }
  const parts = key.split(".");
  let cur = ctx;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object" && typeof cur !== "string") return { value: undefined, found: false };
    if (!Object.prototype.hasOwnProperty.call(Object(cur), p)) return { value: undefined, found: false };
    cur = cur[p];
  }
  return { value: cur, found: true };
}

// ── Core render (recursive) ────────────────────────────────────────────���──────
/**
 * @param {string}   template   Raw template text.
 * @param {object}   ctx        Data context.
 * @param {object}   partials   Map of partial name → template string.
 * @param {number}   depth      Recursion depth counter.
 * @returns {string}
 */
function renderCore(template, ctx, partials, depth) {
  if (depth > MAX_DEPTH)
    throw new ToolError("template_render: maximum recursion depth exceeded (circular partial or deeply nested sections).", -32602);

  // We process the template left-to-right, consuming tags as we find them.
  let result = "";
  let pos    = 0;
  const len  = template.length;

  while (pos < len) {
    // Find next '{{'
    const tagStart = template.indexOf("{{", pos);
    if (tagStart === -1) {
      result += template.slice(pos);
      break;
    }

    // Emit literal text before the tag
    result += template.slice(pos, tagStart);

    // Check for triple-stache {{{
    let tripleStache = template[tagStart + 2] === "{";
    const innerStart = tagStart + (tripleStache ? 3 : 2);
    const closeBrace = tripleStache ? "}}}" : "}}";
    const tagEnd     = template.indexOf(closeBrace, innerStart);

    if (tagEnd === -1) {
      // Unclosed tag — emit literally and stop
      result += template.slice(tagStart);
      break;
    }

    const inner = template.slice(innerStart, tagEnd).trim();
    pos = tagEnd + closeBrace.length;

    // Determine tag type
    const firstChar = inner[0];

    // ── Comment ──────────────────────────────────────────────────────────────
    if (firstChar === "!") {
      // skip
      continue;
    }

    // ── Partial ──────────────────────────────────────────────────────────────
    if (firstChar === ">") {
      const partialName = inner.slice(1).trim();
      const partialSrc  = partials[partialName];
      if (typeof partialSrc === "string") {
        result += renderCore(partialSrc, ctx, partials, depth + 1);
      }
      continue;
    }

    // ── Section / inverted section ────────────────────────────────────────────
    if (firstChar === "#" || firstChar === "^") {
      const inverted   = firstChar === "^";
      const sectionKey = inner.slice(1).trim();
      // Find closing tag {{/sectionKey}}
      const closeTag   = `{{/${sectionKey}}}`;
      const closePos   = template.indexOf(closeTag, pos);
      if (closePos === -1) {
        // Unclosed section — skip gracefully
        result += `[unclosed section: ${sectionKey}]`;
        break;
      }
      const sectionBody = template.slice(pos, closePos);
      pos = closePos + closeTag.length;

      const { value } = lookup(sectionKey, ctx);
      const isFalsy   = !value || (Array.isArray(value) && value.length === 0);

      if (inverted) {
        // {{^key}} renders when value is falsy
        if (isFalsy) result += renderCore(sectionBody, ctx, partials, depth + 1);
      } else {
        // {{#key}} renders when value is truthy
        if (!isFalsy) {
          if (Array.isArray(value)) {
            // Loop over array items.
            // For object items:   push their own keys into context.
            // For primitive items: store the scalar under the literal "." key
            //   so that {{.}} inside the loop body resolves to the item value
            //   (lookup() gives preference to ctx["."] when it exists).
            for (const item of value) {
              const itemCtx = (item !== null && typeof item === "object")
                ? { ...ctx, ...item, ".": item }
                : { ...ctx, ".": item };
              result += renderCore(sectionBody, itemCtx, partials, depth + 1);
            }
          } else if (typeof value === "object" && value !== null) {
            result += renderCore(sectionBody, { ...ctx, ...value }, partials, depth + 1);
          } else {
            result += renderCore(sectionBody, ctx, partials, depth + 1);
          }
        }
      }
      continue;
    }

    // ── Closing tag (reached without opening — skip) ──────────────────────────
    if (firstChar === "/") {
      // Orphan closing tag; ignore
      continue;
    }

    // ── Variable interpolation ────────────────────────────────────────────────
    const unescaped = tripleStache || firstChar === "&";
    const varKey    = (firstChar === "&") ? inner.slice(1).trim() : inner;
    const { value, found } = lookup(varKey, ctx);
    if (found && value != null) {
      const str = typeof value === "object" ? JSON.stringify(value) : String(value);
      result += unescaped ? str : htmlEscape(str);
    }
    // Missing or null/undefined → empty string (Mustache standard behaviour)
  }

  return result;
}

/**
 * Main entry point for template_render.
 *
 * @param {object} opts
 * @param {string}  opts.template  Template string.
 * @param {object}  [opts.context] Data context (default {}).
 * @param {object}  [opts.partials] Map of partial name → template string.
 * @returns {{ rendered, templateLength, renderedLength }}
 */
function templateRender({ template, context = {}, partials = {} } = {}) {
  if (typeof template !== "string")
    throw new ToolError("template_render: 'template' must be a string.", -32602);

  const byteLen = Buffer.byteLength(template, "utf8");
  if (byteLen > MAX_TEMPLATE_BYTES)
    throw new ToolError(
      `template_render: template exceeds ${MAX_TEMPLATE_BYTES / 1024} KB limit ` +
      `(got ${(byteLen / 1024).toFixed(1)} KB).`,
      -32602
    );

  if (context === null || typeof context !== "object" || Array.isArray(context))
    throw new ToolError("template_render: 'context' must be a plain object.", -32602);

  if (partials === null || typeof partials !== "object" || Array.isArray(partials))
    throw new ToolError("template_render: 'partials' must be a plain object.", -32602);

  // Validate partials values are strings
  for (const [k, v] of Object.entries(partials)) {
    if (typeof v !== "string")
      throw new ToolError(`template_render: partials['${k}'] must be a string.`, -32602);
  }

  const rendered = renderCore(template, context, partials, 0);
  return {
    rendered,
    templateLength: template.length,
    renderedLength: rendered.length,
  };
}

module.exports = { templateRender, htmlEscape, lookup, renderCore };
