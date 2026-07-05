"use strict";
// ── SUGGEST_NEXT_VERSION — next semver bump suggestion from git tags ────
// Scans repo tags (via gitTagList), keeps only semver-shaped ones (a
// leading non-digit prefix like 'v' or 'release-' is stripped before
// parsing — covers the common 'v1.2.3' tagging convention plus similar
// variants), finds the highest by real semver precedence (not string/date
// sort — a 'v2.0.0' tagged before 'v1.9.0' due to a backdated/rebased tag
// must still be recognised as the higher version), and proposes the next
// patch/minor/major version. Optionally cross-checks package.json's own
// 'version' field against the latest tag to flag drift (tagged a release
// but forgot to bump package.json, or vice versa) — best-effort, never
// throws if package.json is missing/unreadable, just omits that field.

const fs = require("fs");
const { gitTagList } = require("./gitTagOps");
const { parseSemver, compareSemver } = require("./semverOps");

/**
 * @param {string} repoDir Absolute, jail-validated repo directory.
 * @param {string} origPath Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {string} [opts.pkgJsonAbsPath] Absolute path to a package.json to cross-check (best-effort).
 * @returns {{path, tagCount, matchedCount, latestTag, latestVersion, suggestions, pkgJsonVersion, inSyncWithPackageJson}}
 */
function suggestNextVersion(repoDir, origPath, opts = {}) {
  const { tags } = gitTagList(repoDir); // throws "not a git repository" via gitTagList's own classification

  const matched = [];
  for (const t of tags) {
    const stripped = t.name.replace(/^[^\d]*/, "");
    let parsed;
    try { parsed = parseSemver(stripped); } catch (_) { continue; }
    matched.push({ tagName: t.name, version: parsed.raw, parsed });
  }

  const result = {
    path: origPath,
    tagCount: tags.length,
    matchedCount: matched.length,
    latestTag: null,
    latestVersion: null,
    suggestions: null,
  };

  if (matched.length > 0) {
    let latest = matched[0];
    for (const m of matched) {
      if (compareSemver(m.version, latest.version) > 0) latest = m;
    }
    const p = latest.parsed;
    result.latestTag = latest.tagName;
    result.latestVersion = latest.version;
    result.suggestions = {
      patch: `${p.major}.${p.minor}.${p.patch + 1}`,
      minor: `${p.major}.${p.minor + 1}.0`,
      major: `${p.major + 1}.0.0`,
    };
  } else {
    result.note = "No semver-shaped tags found in this repository.";
  }

  if (typeof opts.pkgJsonAbsPath === "string") {
    try {
      const pkg = JSON.parse(fs.readFileSync(opts.pkgJsonAbsPath, "utf8"));
      if (typeof pkg.version === "string") {
        result.pkgJsonVersion = pkg.version;
        result.inSyncWithPackageJson = result.latestVersion !== null
          ? (() => { try { return compareSemver(pkg.version, result.latestVersion) === 0; } catch (_) { return false; } })()
          : null;
      }
    } catch (_) { /* best-effort — omit fields if unreadable/malformed/missing */ }
  }

  return result;
}

module.exports = { suggestNextVersion };
