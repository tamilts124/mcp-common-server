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
  if (from === 0 && to === 0) return { content, totalLines: lines.length };
  const start = Math.max(0, from - 1);
  const end   = to === 0 ? lines.length : Math.min(to, lines.length);
  return {
    content:      lines.slice(start, end).join("\n"),
    totalLines:   lines.length,
    returnedLines: `${from}-${end}`,
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
    if (c === "**") {
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
function replaceInSingleFile(resolvedPath, clientPath, search, replace, isRegex, flags) {
  try {
    const original = fs.readFileSync(resolvedPath, "utf8");
    let modified;
    let count = 0;
    if (isRegex) {
      const re = new RegExp(search, flags || "g");
      modified = original.replace(re, (...args) => { count++; return replace; });
    } else {
      const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(escaped, "g");
      modified = original.replace(re, () => { count++; return replace; });
    }
    if (count === 0) return { file: clientPath, replacements: 0, note: "no matches found, file unchanged" };
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

module.exports = {
  readDirRecursive, readLines, writeLines, searchRecursive,
  readMultipleFiles, writeMultipleFiles, deleteMultipleFiles,
  globToRegex, findFilesRecursive, replaceInSingleFile,
};
