"use strict";
// ── README_LINK_CHECK — find broken relative links in a markdown file ─────
// Scans markdown link syntax [text](target) and bare autolinks <target>,
// classifies each target as external (http/https/mailto/etc — not fetched,
// offline tool), anchor-only (#section — not verified), or local/relative
// (resolved against the markdown file's directory and checked for existence
// on disk). Read-only, zero dependencies.

const fs   = require("fs");
const path = require("path");

// Matches [text](target "optional title") and [text](target) — captures target.
const MD_LINK_RE = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
// Bare autolinks: <http://...> or <mailto:...>
const AUTOLINK_RE = /<((?:https?|mailto):[^\s>]+)>/g;

function classify(target) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return "external"; // has a URI scheme (http:, mailto:, ftp:, etc.)
  if (target.startsWith("#")) return "anchor";
  return "local";
}

/**
 * Scan a markdown file for links and verify local/relative link targets
 * resolve to existing files on disk.
 * @param {string} absPath   Absolute path to the markdown file.
 * @param {string} origPath  Client-relative path echoed in the result.
 * @returns {{ path, totalLinks, external:[], anchors:[], local:[{target,line,exists}], brokenCount, broken:[{target,line}] }}
 */
function readmeLinkCheck(absPath, origPath) {
  let stat;
  try { stat = fs.statSync(absPath); }
  catch (e) { throw new Error(`readme_link_check: cannot access '${origPath}': ${e.message}`); }
  if (!stat.isFile()) throw new Error(`readme_link_check: '${origPath}' is not a regular file.`);

  const text = fs.readFileSync(absPath, "utf8");
  const lines = text.split(/\r\n|\r|\n/);
  const baseDir = path.dirname(absPath);

  const external = [];
  const anchors = [];
  const local = [];
  const seen = new Set(); // dedupe identical (target, line) pairs from overlapping regexes

  function record(target, lineNo, col) {
    const key = `${target}\u0000${lineNo}\u0000${col}`;
    if (seen.has(key)) return;
    seen.add(key);
    const kind = classify(target);
    if (kind === "external") { external.push({ target, line: lineNo }); return; }
    if (kind === "anchor") { anchors.push({ target, line: lineNo }); return; }
    // local: strip a trailing #anchor before checking existence
    const filePart = target.split("#")[0];
    let exists = false;
    if (filePart) {
      const resolved = path.resolve(baseDir, filePart);
      // Only report existence for targets that don't escape upward out of
      // reasonable bounds via excessive '..' — still just an fs.existsSync
      // check (read-only), no write/exec risk either way.
      try { exists = fs.existsSync(resolved); } catch (e) { exists = false; }
    }
    local.push({ target, line: lineNo, exists });
  }

  lines.forEach((lineText, idx) => {
    let m;
    MD_LINK_RE.lastIndex = 0;
    while ((m = MD_LINK_RE.exec(lineText))) record(m[2], idx + 1, m.index);
    AUTOLINK_RE.lastIndex = 0;
    while ((m = AUTOLINK_RE.exec(lineText))) record(m[1], idx + 1, m.index);
  });

  const broken = local.filter(l => !l.exists).map(l => ({ target: l.target, line: l.line }));

  return {
    path: origPath,
    totalLinks: external.length + anchors.length + local.length,
    external,
    anchors,
    local,
    brokenCount: broken.length,
    broken,
  };
}

module.exports = { readmeLinkCheck };
