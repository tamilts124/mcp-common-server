"use strict";
// ── TEXT EXTRACT OPS ───────────────────────────────────────────────────────────
// Extract structured entities (emails, URLs, IPs, phone numbers, dates, numbers,
// JSON fragments, lines, between-delimiters, custom regex) from any text string.
// Zero npm dependencies — pure Node.js built-in regex + JSON.parse.

const { ToolError } = require("./errors");

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_INPUT = 10 * 1024 * 1024; // 10 MB safety cap
const MAX_RESULTS = 10000;

const VALID_OPS = [
  "emails", "urls", "phones", "ips", "numbers", "dates",
  "json", "lines", "between", "pattern", "words",
];

// ── Regex patterns ─────────────────────────────────────────────────────────────

// RFC 5321 simplified — practical email extractor
const RE_EMAIL = /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+/g;

// URLs: http/https/ftp with optional path+query
const RE_URL = /https?:\/\/(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(?::\d{1,5})?(?:\/[^\s"'<>()[\]{}]*)?|ftp:\/\/(?:[a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}(?::\d{1,5})?(?:\/[^\s"'<>()[\]{}]*)?/g;

// Phone numbers: flexible international/US formats
const RE_PHONE = /(?:\+?\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{2,4}[\s.-]?\d{2,9}/g;

// IPv4
const RE_IPV4 = /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g;

// IPv6 — full / compressed
const RE_IPV6 = /\b(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}\b|\b(?:[0-9a-fA-F]{1,4}:){1,7}:\b|\b(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}\b|\b(?:[0-9a-fA-F]{1,4}:){1,5}(?::[0-9a-fA-F]{1,4}){1,2}\b|\b(?:[0-9a-fA-F]{1,4}:){1,4}(?::[0-9a-fA-F]{1,4}){1,3}\b|\b(?:[0-9a-fA-F]{1,4}:){1,3}(?::[0-9a-fA-F]{1,4}){1,4}\b|\b(?:[0-9a-fA-F]{1,4}:){1,2}(?::[0-9a-fA-F]{1,4}){1,5}\b|\b[0-9a-fA-F]{1,4}:(?::[0-9a-fA-F]{1,4}){1,6}\b|::1\b/g;

// Numbers: integer, decimal, negative, comma-grouped
const RE_NUMBER = /-?(?:\d{1,3}(?:,\d{3})*|\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

// Dates
const RE_DATE_SRC =
  "\\b\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])(?:T[0-9:+\\-Z.]+)?" +
  "|\\b(?:0?[1-9]|1[0-2])[/\\-](?:0?[1-9]|[12]\\d|3[01])[/\\-]\\d{2,4}\\b" +
  "|\\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b" +
  "|\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\s+\\d{4}\\b";

// ── Helpers ───────────────────────────────────────────────────────────────────

function assertString(text, label) {
  if (typeof text !== "string")
    throw new ToolError(`text_extract ${label}: 'text' must be a string.`, -32602);
  if (text.length > MAX_INPUT)
    throw new ToolError(`text_extract ${label}: input exceeds 10 MB limit (${text.length} bytes).`, -32602);
}

function clamp(arr, limit) {
  const truncated = arr.length > limit;
  return { items: truncated ? arr.slice(0, limit) : arr, truncated };
}

function dedupeStrings(arr) {
  const seen = new Set();
  return arr.filter(x => { if (seen.has(x)) return false; seen.add(x); return true; });
}

function matchAll(text, reSrc, reFlags) {
  const re = new RegExp(reSrc, reFlags);
  const results = [];
  let m;
  while ((m = re.exec(text)) !== null && results.length < MAX_RESULTS + 1) {
    results.push({ match: m[0], index: m.index });
  }
  return results;
}

// ── JSON fragment extractor ───────────────────────────────────────────────────

function extractJsonFragments(text, limit) {
  const results = [];
  const openers = new Set(["{", "["]);
  const closers = { "{": "}", "[": "]" };

  for (let i = 0; i < text.length && results.length < limit; i++) {
    const ch = text[i];
    if (!openers.has(ch)) continue;
    const close = closers[ch];
    let depth = 0, inStr = false, escaped = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (escaped)           { escaped = false; continue; }
      if (c === "\\" && inStr) { escaped = true; continue; }
      if (c === "\"")        { inStr = !inStr; continue; }
      if (inStr)             continue;
      if (c === ch)          depth++;
      if (c === close)       depth--;
      if (depth === 0) {
        const fragment = text.slice(i, j + 1);
        try {
          const parsed = JSON.parse(fragment);
          results.push({ index: i, length: fragment.length, value: parsed });
          // Advance outer scan position past this fragment
          // (mutate i via a closure-like trick — we track nextI)
          i = j; // outer loop will i++, landing at j+1
        } catch { /* not valid JSON */ }
        break;
      }
    }
  }
  return results;
}

// ── Word frequency ─────────────────────────────────────────────────────────────

function extractWords(text, { min_length = 1, top_n = 50, ignore_case = true, stop_words = [] } = {}) {
  const src = ignore_case ? text.toLowerCase() : text;
  const stopSet = new Set((stop_words || []).map(w => ignore_case ? w.toLowerCase() : w));
  const wordRe = /[a-zA-Z\u00C0-\u024F]+(?:['''][a-zA-Z]+)*/g;
  const freq = new Map();
  let m;
  while ((m = wordRe.exec(src)) !== null) {
    const w = m[0];
    if (w.length < min_length) continue;
    if (stopSet.has(w)) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  const sorted = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, Math.min(top_n || 50, MAX_RESULTS));
  return { uniqueWords: freq.size, topWords: sorted.map(([word, count]) => ({ word, count })) };
}

// ── Extractor: lines ─────────────────────────────────────────────────────────

function extractLines(text, { pattern, is_regex = false, ignore_case = false, invert = false, context = 0 } = {}) {
  const lines = text.split(/\r?\n/);
  let testFn = () => true;
  if (pattern) {
    let re;
    try {
      re = new RegExp(
        is_regex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        ignore_case ? "i" : ""
      );
    } catch (e) {
      throw new ToolError(`text_extract lines: invalid regex '${pattern}': ${e.message}`, -32602);
    }
    testFn = l => re.test(l);
  }

  const ctx = Math.max(0, Math.min(Number(context) || 0, 50));
  const matchedSet = new Set();
  for (let i = 0; i < lines.length; i++) {
    const matched = testFn(lines[i]);
    if (invert ? !matched : matched) matchedSet.add(i);
  }

  const included = new Set();
  for (const idx of matchedSet)
    for (let d = -ctx; d <= ctx; d++) {
      const j = idx + d;
      if (j >= 0 && j < lines.length) included.add(j);
    }

  const result = [...included].sort((a, b) => a - b).map(i => ({
    lineNumber: i + 1,
    text: lines[i],
    matched: matchedSet.has(i),
  }));

  const { items, truncated } = clamp(result, MAX_RESULTS);
  return { matchCount: matchedSet.size, truncated, lines: items };
}

// ── Extractor: between ────────────────────────────────────────────────────────

function extractBetween(text, { start, end, include_delimiters = false, greedy = false } = {}) {
  if (!start || !end)
    throw new ToolError("text_extract between: 'start' and 'end' delimiters are required.", -32602);

  const results = [];
  let pos = 0;
  while (pos < text.length && results.length < MAX_RESULTS) {
    const si = text.indexOf(start, pos);
    if (si === -1) break;
    const contentStart = si + start.length;
    let ei;
    if (greedy) {
      ei = text.lastIndexOf(end);
      if (ei <= si) { pos = si + 1; continue; }
    } else {
      ei = text.indexOf(end, contentStart);
      if (ei === -1) break;
    }
    const content = text.slice(contentStart, ei);
    results.push({
      index:   si,
      content,
      full:    include_delimiters ? text.slice(si, ei + end.length) : content,
    });
    pos = ei + end.length;
    if (greedy) break;
  }
  const { items, truncated } = clamp(results, MAX_RESULTS);
  return { count: results.length, truncated, matches: items };
}

// ── Main entry point ──────────────────────────────────────────────────────────

function textExtract(args) {
  const { operation } = args;
  if (!operation)
    throw new ToolError("text_extract: 'operation' is required.", -32602);
  if (!VALID_OPS.includes(operation))
    throw new ToolError(
      `text_extract: Unknown operation '${operation}'. Valid: ${VALID_OPS.join(", ")}.`,
      -32602
    );

  const text    = args.text ?? "";
  const doDedup = args.dedupe !== false; // default true
  const maxRes  = Math.min(Math.max(1, Number(args.max_results) || 1000), MAX_RESULTS);

  assertString(text, operation);

  switch (operation) {

    case "emails": {
      let raw = matchAll(text, RE_EMAIL.source, "g").map(m => m.match);
      if (doDedup) raw = dedupeStrings(raw);
      const { items, truncated } = clamp(raw, maxRes);
      return { operation, count: items.length, truncated, emails: items };
    }

    case "urls": {
      let raw = matchAll(text, RE_URL.source, "g")
        .map(m => m.match.replace(/[.,;!?)]+$/, ""));
      if (doDedup) raw = dedupeStrings(raw);
      const { items, truncated } = clamp(raw, maxRes);
      return { operation, count: items.length, truncated, urls: items };
    }

    case "phones": {
      let raw = matchAll(text, RE_PHONE.source, "g")
        .map(m => m.match.trim())
        .filter(p => p.replace(/\D/g, "").length >= 7);
      if (doDedup) raw = dedupeStrings(raw);
      const { items, truncated } = clamp(raw, maxRes);
      return { operation, count: items.length, truncated, phones: items };
    }

    case "ips": {
      const v4 = matchAll(text, RE_IPV4.source, "g")
        .map(m => ({ address: m.match, version: 4, index: m.index }));
      const v6 = matchAll(text, RE_IPV6.source, "g")
        .map(m => ({ address: m.match, version: 6, index: m.index }))
        .filter(m => m.address !== "::");
      let all = [...v4, ...v6].sort((a, b) => a.index - b.index);
      if (doDedup) {
        const seen = new Set();
        all = all.filter(x => { if (seen.has(x.address)) return false; seen.add(x.address); return true; });
      }
      const { items, truncated } = clamp(all, maxRes);
      return { operation, count: items.length, truncated, ips: items };
    }

    case "numbers": {
      const raw = matchAll(text, RE_NUMBER.source, "g")
        .map(m => ({
          raw:   m.match,
          value: parseFloat(m.match.replace(/,/g, "")),
          index: m.index,
        }))
        .filter(n => isFinite(n.value));
      const { items, truncated } = clamp(raw, maxRes);
      return { operation, count: items.length, truncated, numbers: items };
    }

    case "dates": {
      const re = new RegExp(RE_DATE_SRC, "gi");
      const raw = [];
      let m;
      while ((m = re.exec(text)) !== null && raw.length < maxRes + 1) {
        raw.push({ date: m[0].trim(), index: m.index });
      }
      let result = raw;
      if (doDedup) {
        const seen = new Set();
        result = raw.filter(x => { if (seen.has(x.date)) return false; seen.add(x.date); return true; });
      }
      const { items, truncated } = clamp(result, maxRes);
      return { operation, count: items.length, truncated, dates: items };
    }

    case "json": {
      const results = extractJsonFragments(text, maxRes);
      const { items, truncated } = clamp(results, maxRes);
      return { operation, count: items.length, truncated, fragments: items };
    }

    case "lines": {
      const r = extractLines(text, {
        pattern:     args.pattern,
        is_regex:    args.is_regex,
        ignore_case: args.ignore_case,
        invert:      args.invert,
        context:     args.context,
      });
      return { operation, ...r };
    }

    case "between": {
      const r = extractBetween(text, {
        start:              args.start,
        end:                args.end,
        include_delimiters: args.include_delimiters,
        greedy:             args.greedy,
      });
      return { operation, ...r };
    }

    case "pattern": {
      if (!args.pattern)
        throw new ToolError("text_extract pattern: 'pattern' is required.", -32602);
      let re;
      try {
        const baseFlags = args.flags || (args.ignore_case ? "gi" : "g");
        const flags = baseFlags.includes("g") ? baseFlags : baseFlags + "g";
        re = new RegExp(args.pattern, flags);
      } catch (e) {
        throw new ToolError(`text_extract pattern: invalid regex '${args.pattern}': ${e.message}`, -32602);
      }
      const raw = [];
      let m;
      while ((m = re.exec(text)) !== null && raw.length < maxRes + 1) {
        raw.push({
          match:       m[0],
          index:       m.index,
          groups:      m.length > 1 ? [...m].slice(1) : undefined,
          namedGroups: m.groups || undefined,
        });
        if (!re.flags.includes("g")) break;
      }
      const { items, truncated } = clamp(raw, maxRes);
      return { operation, pattern: args.pattern, count: items.length, truncated, matches: items };
    }

    case "words": {
      const r = extractWords(text, {
        min_length:  args.min_length,
        top_n:       args.top_n,
        ignore_case: args.ignore_case !== false,
        stop_words:  args.stop_words,
      });
      return { operation, ...r };
    }
  }
}

module.exports = { textExtract };
