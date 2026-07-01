"use strict";
// ── FILE / DIRECTORY / SEARCH HELPERS ──────────────────────────────────────────
const fs = require("fs");
const path = require("path");
const { resolveClientPath, clientRelative, isIgnored } = require("./roots");

function readDirRecursive(dirPath, subDir, alias) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const result  = [];
  for (const e of entries) {
    if (isIgnored(e.name)) continue;
    const full = path.join(dirPath, e.name);
    const rel  = clientRelative(alias, full);
    if (e.isDirectory()) {
      result.push({ type: "dir", path: rel });
      if (subDir) result.push(...readDirRecursive(full, true, alias));
    } else {
      const stat = fs.statSync(full);
      result.push({ type: "file", path: rel, size: stat.size });
    }
  }
  return result;
}

function readLines(filePath, from, to) {
  const content = fs.readFileSync(filePath, "utf8");
  const lines   = content.split("\n");
  const total   = lines.length;
  if (from === 0 && to === 0) return { content, totalLines: total };

  // Normalise: from<=0 means "start of file"; to<=0 means "end of file".
  // Returned as structured numeric fields (fromLine/toLine/returnedLines as a
  // count) rather than a formatted string, so callers (AI agents in
  // particular) can consume the range without re-parsing it.
  const fromLine = from <= 0 ? 1 : from;
  const toLine   = to   <= 0 ? total : Math.min(to, total);

  if (fromLine > total) {
    return { content: "", totalLines: total, fromLine, toLine, returnedLines: 0 };
  }
  const slice = lines.slice(fromLine - 1, toLine);
  return {
    content:       slice.join("\n"),
    totalLines:    total,
    fromLine,
    toLine:        Math.min(toLine, total),
    returnedLines: slice.length,
  };
}

function writeLines(filePath, newContent, from, to) {
  if (from === 0 && to === 0) {
    if (fs.existsSync(filePath)) fs.copyFileSync(filePath, filePath + ".bak");
    fs.writeFileSync(filePath, newContent, "utf8");
    return { written: "entire file" };
  }
  let lines   = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8").split("\n") : [];
  const start = Math.max(0, from - 1);
  const end   = Math.min(to, lines.length);
  lines.splice(start, end - start, ...newContent.split("\n"));
  fs.writeFileSync(filePath, lines.join("\n"), "utf8");
  return { written: `lines ${from}-${to} replaced`, totalLines: lines.length };
}

function searchRecursive(dirPath, pattern, isRegex, alias, results = []) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const e of entries) {
    if (isIgnored(e.name)) continue;
    const full = path.join(dirPath, e.name);
    if (e.isDirectory()) { searchRecursive(full, pattern, isRegex, alias, results); continue; }
    try {
      const lines = fs.readFileSync(full, "utf8").split("\n");
      const re    = isRegex ? new RegExp(pattern, "gi") : null;
      const matches = [];
      lines.forEach((line, i) => {
        const hit = re ? re.test(line) : line.toLowerCase().includes(pattern.toLowerCase());
        if (hit) matches.push({ line: i + 1, content: line });
      });
      if (matches.length) results.push({ file: clientRelative(alias, full), matches });
    } catch (_) {}
  }
  return results;
}

function readMultipleFiles(items) {
  const results = {};
  for (const item of items) {
    const p = typeof item === "string" ? item : item.path;
    try {
      const { resolved } = resolveClientPath(p);
      results[p] = readLines(resolved, item.from_line ?? 0, item.to_line ?? 0);
    } catch (e) {
      results[p] = { error: e.message };
    }
  }
  return results;
}

function writeMultipleFiles(items) {
  const results = {};
  for (const item of items) {
    try {
      const { resolved } = resolveClientPath(item.path);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      results[item.path] = writeLines(resolved, item.content, item.from_line ?? 0, item.to_line ?? 0);
    } catch (e) {
      results[item.path] = { error: e.message };
    }
  }
  return results;
}

function deleteMultipleFiles(paths) {
  const results = {};
  for (const p of paths) {
    try {
      const { resolved } = resolveClientPath(p);
      fs.unlinkSync(resolved);
      results[p] = { deleted: true };
    } catch (e) {
      results[p] = { error: e.message };
    }
  }
  return results;
}

// Converts a glob pattern to a RegExp.
// Supports: * (any chars except /), ** (any chars including /), ? (single char),
//           [abc] character classes, {a,b} alternation, and literal escaping.
function globToRegex(pattern) {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    // Check for ** before * so the two-char token wins over the single-char one.
    if (pattern.slice(i, i + 2) === "**") {
      re += ".*";
      i += 2;
    } else if (c === "*") {
      re += "[^/]*";
      i++;
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else if (c === "[") {
      const close = pattern.indexOf("]", i);
      if (close === -1) { re += "\\["; i++; }
      else { re += pattern.slice(i, close + 1); i = close + 1; }
    } else if (c === "{") {
      const close = pattern.indexOf("}", i);
      if (close === -1) { re += "\\{"; i++; }
      else {
        const alts = pattern.slice(i + 1, close).split(",").map(a => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
        re += `(?:${alts})`;
        i = close + 1;
      }
    } else if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  return new RegExp(`^${re}$`, "i");
}

function findFilesRecursive(dirPath, rePattern, alias, results = []) {
  let entries;
  try { entries = fs.readdirSync(dirPath, { withFileTypes: true }); }
  catch (_) { return results; }
  for (const e of entries) {
    if (isIgnored(e.name)) continue;
    const full    = path.join(dirPath, e.name);
    const relPath = clientRelative(alias, full);
    if (e.isDirectory()) {
      findFilesRecursive(full, rePattern, alias, results);
    } else {
      if (rePattern.test(e.name) || rePattern.test(relPath)) {
        const stat = fs.statSync(full);
        results.push({ path: relPath, size: stat.size });
      }
    }
  }
  return results;
}

// Returns { file, replacements, originalSize, newSize } or { file, error }
// opts.dryRun: when true, computes the would-be result but never touches disk
// (no .bak backup, no write) — used by find/replace-across-a-tree previews.
function replaceInSingleFile(resolvedPath, clientPath, search, replace, isRegex, flags, opts = {}) {
  const dryRun = !!opts.dryRun;
  try {
    const original = fs.readFileSync(resolvedPath, "utf8");
    let modified;
    let count = 0;
    if (isRegex) {
      // Use the native String#replace(RegExp, replacementString) form (not a
      // callback) so $1/$2/$&-style capture-group references in `replace`
      // are substituted by the engine itself, matching the documented
      // "$1, $2 etc. for capture groups" schema behavior. Count matches
      // separately via String#match against the same RegExp/flags so the
      // reported count reflects exactly what was (or would be) replaced —
      // including the flags-dependent case where 'g' is not set and only
      // the first match is replaced.
      const re = new RegExp(search, flags || "g");
      const found = original.match(re);
      count = found ? found.length : 0;
      modified = count > 0 ? original.replace(re, replace) : original;
    } else {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(escaped, "g");
      modified = original.replace(re, () => { count++; return replace; });
    }
    if (count === 0) return { file: clientPath, replacements: 0, note: "no matches found, file unchanged" };
    if (dryRun) {
      return {
        file:         clientPath,
        replacements: count,
        originalSize: Buffer.byteLength(original, "utf8"),
        newSize:      Buffer.byteLength(modified, "utf8"),
        dryRun:       true,
      };
    }
    fs.copyFileSync(resolvedPath, resolvedPath + ".bak");
    fs.writeFileSync(resolvedPath, modified, "utf8");
    return {
      file:         clientPath,
      replacements: count,
      originalSize: Buffer.byteLength(original, "utf8"),
      newSize:      Buffer.byteLength(modified, "utf8"),
    };
  } catch (e) {
    return { file: clientPath, error: e.message };
  }
}

// ── TRUNCATE FILE ────────────────────────────────────────────────────────────
/**
 * Shrink a file to its first `lines` lines or first `bytes` bytes.
 * Exactly one of `lines` or `bytes` must be provided (non-zero positive integer).
 * If the file is already shorter than the requested size, it is left unchanged.
 *
 * @param {string} resolvedPath  Absolute path to the file (already jail-checked).
 * @param {number|null} lines    Keep the first N lines (newline-delimited).
 * @param {number|null} bytes    Keep the first N bytes.
 * @returns {{ path: string, originalSize: number, newSize: number, truncated: boolean }}
 */
function truncateFile(resolvedPath, lines, bytes) {
  const { ToolError } = require("./errors");
  if ((lines == null) === (bytes == null)) {
    throw new ToolError("Exactly one of 'lines' or 'bytes' must be provided.", -32602);
  }
  if (lines != null) {
    if (!Number.isInteger(lines) || lines < 0) {
      throw new ToolError("'lines' must be a non-negative integer.", -32602);
    }
  }
  if (bytes != null) {
    if (!Number.isInteger(bytes) || bytes < 0) {
      throw new ToolError("'bytes' must be a non-negative integer.", -32602);
    }
  }

  const original = fs.readFileSync(resolvedPath);
  const originalSize = original.length;

  let kept;
  if (lines != null) {
    if (lines === 0) {
      kept = Buffer.alloc(0);
    } else {
      // Find the byte offset of the end of line number `lines`.
      let lineCount = 0;
      let i = 0;
      for (; i < original.length; i++) {
        if (original[i] === 0x0a /* \n */) {
          lineCount++;
          if (lineCount >= lines) { i++; break; }
        }
      }
      kept = original.slice(0, i);
    }
  } else {
    // bytes mode
    kept = original.slice(0, bytes);
  }

  const newSize = kept.length;
  if (newSize >= originalSize) {
    // Already shorter or equal — nothing to do.
    return { originalSize, newSize: originalSize, truncated: false };
  }

  fs.writeFileSync(resolvedPath, kept);
  return { originalSize, newSize, truncated: true };
}

// ── APPEND FILE ──────────────────────────────────────────────────────────────
/**
 * Append `content` (a string) to the end of a file.
 * Creates the file if it does not already exist.
 *
 * @param {string} resolvedPath  Absolute path (already jail-checked).
 * @param {string} content       Text to append.
 * @returns {{ path: string, bytesAppended: number, newSize: number }}
 */
function appendFile(resolvedPath, content) {
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  fs.appendFileSync(resolvedPath, content, "utf8");
  const newSize = fs.statSync(resolvedPath).size;
  return { bytesAppended: Buffer.byteLength(content, "utf8"), newSize };
}

// ── SEARCH LINES — grep-like line-number search with context ──────────────────
/**
 * Search a single file (or walk a directory recursively) for lines matching
 * a pattern and return each match with its 1-based line number, the matching
 * line text, and optional surrounding context lines.
 *
 * @param {string}   absSrc      Absolute path to a file or directory (jail-validated by caller).
 * @param {string}   origPath    Client-relative path echoed in the result.
 * @param {string}   pattern     Search pattern (literal string or regex).
 * @param {object}   [opts]
 * @param {boolean}  [opts.isRegex]   Treat `pattern` as a RegExp (default: false).
 * @param {boolean}  [opts.ignoreCase] Case-insensitive matching (default: false).
 * @param {number}   [opts.context]   Number of surrounding context lines (default: 0, max: 10).
 * @param {number}   [opts.maxMatches] Maximum total matches to return (default: 200, max: 2000).
 * @param {string[]} [opts.extensions] Restrict to files with these extensions (directory mode).
 * @returns {object}  { path, pattern, isRegex, ignoreCase, matchedFiles, totalMatches, truncated, matches }
 *
 * Each `match` object: { file, line, content, context: { before: string[], after: string[] } }
 *   - `file`    : client-relative file path
 *   - `line`    : 1-based line number of the matching line
 *   - `content` : text of the matching line (trailing CR stripped)
 *   - `context.before`: up to `context` lines immediately before the match
 *   - `context.after` : up to `context` lines immediately after the match
 */
function searchLines(absSrc, origPath, pattern, opts = {}) {
  const isRegex    = !!opts.isRegex;
  const ignoreCase = !!opts.ignoreCase;
  const ctxLines   = Math.min(Math.max(0, Math.trunc(opts.context ?? 0)), 10);
  const maxMatches = Math.min(Math.max(1, Math.trunc(opts.maxMatches ?? 200)), 2000);
  const exts       = opts.extensions?.length ? opts.extensions.map(e => e.startsWith(".") ? e.toLowerCase() : "." + e.toLowerCase()) : null;

  // Build the RegExp used for matching.
  // Safety: for regex mode the caller's pattern is used as-is (they opted in);
  // for literal mode we escape every metacharacter so the string is matched verbatim.
  let re;
  try {
    const flags = ignoreCase ? "i" : "";
    re = isRegex
      ? new RegExp(pattern, flags)
      : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
  } catch (e) {
    throw new Error(`search_lines: invalid regex pattern: ${e.message}`);
  }

  const matches = [];
  let truncated = false;

  function searchFile(absFile, relFile) {
    if (truncated) return;
    let text;
    try { text = fs.readFileSync(absFile, "utf8"); }
    catch (_) { return; } // binary / unreadable — skip silently

    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (truncated) break;
      const line = lines[i].replace(/\r$/, ""); // normalise CRLF
      re.lastIndex = 0; // reset stateful regex
      if (!re.test(line)) continue;
      re.lastIndex = 0;

      const before = [];
      for (let b = Math.max(0, i - ctxLines); b < i; b++)
        before.push(lines[b].replace(/\r$/, ""));
      const after = [];
      for (let a = i + 1; a <= Math.min(lines.length - 1, i + ctxLines); a++)
        after.push(lines[a].replace(/\r$/, ""));

      matches.push({ file: relFile, line: i + 1, content: line, context: { before, after } });
      if (matches.length >= maxMatches) { truncated = true; break; }
    }
  }

  const stat = fs.statSync(absSrc);
  if (stat.isDirectory()) {
    (function walk(dir, relDir) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
      catch (_) { return; }
      for (const ent of entries) {
        if (isIgnored(ent.name)) continue;
        const relPath = relDir ? relDir + "/" + ent.name : (origPath ? origPath + "/" + ent.name : ent.name);
        const absPath = path.join(dir, ent.name);
        if (ent.isDirectory()) { walk(absPath, relPath); }
        else if (ent.isFile()) {
          const ext = path.extname(ent.name).toLowerCase();
          if (exts && !exts.includes(ext)) continue;
          searchFile(absPath, relPath);
        }
      }
    })(absSrc, origPath || "");
  } else {
    searchFile(absSrc, origPath);
  }

  // Count unique files that contributed matches
  const matchedFilesSet = new Set(matches.map(m => m.file));

  return {
    path:        origPath,
    pattern,
    isRegex,
    ignoreCase,
    matchedFiles: matchedFilesSet.size,
    totalMatches: matches.length,
    truncated,
    matches,
  };
}

module.exports = {
  readDirRecursive, readLines, writeLines, searchRecursive,
  readMultipleFiles, writeMultipleFiles, deleteMultipleFiles,
  globToRegex, findFilesRecursive, replaceInSingleFile,
  truncateFile, appendFile, searchLines,
};
