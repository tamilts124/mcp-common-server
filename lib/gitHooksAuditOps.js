"use strict";
// ── GIT_HOOKS_AUDIT — .husky / .git/hooks vs package.json config ───────────
// Heuristic, filesystem-only audit (no git binary calls) that cross-checks:
//   - .husky/ directory hook scripts (husky v6+ layout: one file per hook
//     name, no ".sample" suffix, executable).
//   - .git/hooks/ directory — real hooks are files WITHOUT the ".sample"
//     suffix that ship as templates; anything else present is a live,
//     locally-configured hook that (unlike .husky) is NOT version-controlled
//     and so is invisible to every other clone of the repo.
//   - package.json's "husky" field (v4 config-in-package.json style, e.g.
//     `"husky": { "hooks": { "pre-commit": "..." } }`) and "lint-staged"
//     field, plus whether husky/lint-staged appear as dependencies.
// Flags mismatches: husky dependency present but no .husky hooks wired,
// lint-staged configured but no hook actually invokes it, non-portable
// .git/hooks/* present alongside (or instead of) .husky, and a legacy-style
// package.json "husky.hooks" config sitting unused alongside modern .husky.
const fs   = require("fs");
const path = require("path");

const HUSKY_DIR = ".husky";
const GIT_HOOKS_DIR = path.join(".git", "hooks");
const KNOWN_HOOK_NAMES = new Set([
  "applypatch-msg", "pre-applypatch", "post-applypatch",
  "pre-commit", "prepare-commit-msg", "commit-msg", "post-commit",
  "pre-rebase", "post-checkout", "post-merge", "pre-push",
  "pre-receive", "update", "post-receive", "post-update",
  "push-to-checkout", "pre-auto-gc", "post-rewrite", "sendemail-validate",
]);

function listHuskyHooks(rootDir) {
  const dir = path.join(rootDir, HUSKY_DIR);
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (_) { return null; } // no .husky dir — not an error, just absent
  return entries
    .filter(e => e.isFile() && KNOWN_HOOK_NAMES.has(e.name))
    .map(e => e.name)
    .sort();
}

function listGitHooks(rootDir) {
  const dir = path.join(rootDir, GIT_HOOKS_DIR);
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (_) { return []; } // no .git/hooks dir (unusual, but not fatal)
  return entries
    .filter(e => e.isFile() && !e.name.endsWith(".sample") && KNOWN_HOOK_NAMES.has(e.name))
    .map(e => e.name)
    .sort();
}

function readPackageJson(pkgAbsPath, pkgOrigPath) {
  let raw;
  try { raw = fs.readFileSync(pkgAbsPath, "utf8"); }
  catch (e) { throw new Error(`git_hooks_audit: cannot read '${pkgOrigPath}': ${e.message}`); }
  try { return JSON.parse(raw); }
  catch (e) { throw new Error(`git_hooks_audit: '${pkgOrigPath}' is not valid JSON: ${e.message.split("\n")[0]}`); }
}

function huskyHookInvokesLintStaged(rootDir, hookName) {
  const p = path.join(rootDir, HUSKY_DIR, hookName);
  let raw;
  try { raw = fs.readFileSync(p, "utf8"); }
  catch (_) { return false; }
  return /lint-staged/.test(raw);
}

/**
 * @param {string} rootAbsDir  Absolute repo-root-ish directory to scan (contains .husky/.git, no git dependency).
 * @param {string} rootOrigPath Client-relative path echoed in the result.
 * @param {string} pkgAbsPath  Absolute path to package.json.
 * @param {string} pkgOrigPath Client-relative package.json path echoed in the result.
 * @returns {{
 *   path: string, pkgPath: string,
 *   huskyDirPresent: boolean, huskyHooks: string[],
 *   gitHooksDirLocalHooks: string[],
 *   packageJsonLegacyHuskyHooks: string[],
 *   lintStagedConfigured: boolean,
 *   dependsOnHusky: boolean, dependsOnLintStaged: boolean,
 *   lintStagedWiredInHook: boolean,
 *   hints: string[],
 * }}
 */
function gitHooksAudit(rootAbsDir, rootOrigPath, pkgAbsPath, pkgOrigPath) {
  let stat;
  try { stat = fs.statSync(rootAbsDir); }
  catch (e) { throw new Error(`git_hooks_audit: cannot access '${rootOrigPath}': ${e.message}`); }
  if (!stat.isDirectory()) throw new Error(`git_hooks_audit: '${rootOrigPath}' is not a directory.`);

  const pkg = readPackageJson(pkgAbsPath, pkgOrigPath);
  const deps = Object.assign({}, pkg.dependencies, pkg.devDependencies);
  const dependsOnHusky = Object.prototype.hasOwnProperty.call(deps, "husky");
  const dependsOnLintStaged = Object.prototype.hasOwnProperty.call(deps, "lint-staged");

  const legacyHuskyHooks = (pkg.husky && typeof pkg.husky === "object" && pkg.husky.hooks
    && typeof pkg.husky.hooks === "object") ? Object.keys(pkg.husky.hooks).sort() : [];
  const lintStagedConfigured = Object.prototype.hasOwnProperty.call(pkg, "lint-staged")
    || Object.prototype.hasOwnProperty.call(pkg, "lintStaged");

  const huskyHooksList = listHuskyHooks(rootAbsDir);
  const huskyDirPresent = huskyHooksList !== null;
  const huskyHooks = huskyHooksList || [];
  const gitHooksDirLocalHooks = listGitHooks(rootAbsDir);

  const lintStagedWiredInHook = huskyHooks.some(h => huskyHookInvokesLintStaged(rootAbsDir, h));

  const hints = [];
  if (dependsOnHusky && !huskyDirPresent) {
    hints.push("husky is a dependency but no .husky directory was found — hooks likely not installed (run `npx husky init` / check the 'prepare' script).");
  }
  if (huskyDirPresent && huskyHooks.length === 0) {
    hints.push(".husky directory exists but contains no recognised hook scripts.");
  }
  if (legacyHuskyHooks.length > 0 && huskyDirPresent) {
    hints.push("package.json has legacy husky v4-style \"husky.hooks\" config alongside a modern .husky directory — the legacy config is ignored by husky v6+ and can be removed.");
  }
  if (legacyHuskyHooks.length > 0 && !huskyDirPresent) {
    hints.push("package.json declares legacy husky v4-style \"husky.hooks\" config but husky v4 was removed in 2021 — this config is very likely dead.");
  }
  if (dependsOnLintStaged && lintStagedConfigured && huskyDirPresent && !lintStagedWiredInHook) {
    hints.push("lint-staged is configured and installed, but no .husky hook script appears to invoke it.");
  }
  if (dependsOnLintStaged && !lintStagedConfigured) {
    hints.push("lint-staged is a dependency but no \"lint-staged\" config block was found in package.json (it may live in a separate .lintstagedrc file, which this tool doesn't check).");
  }
  if (gitHooksDirLocalHooks.length > 0) {
    hints.push(`.git/hooks has ${gitHooksDirLocalHooks.length} locally-configured hook(s) (${gitHooksDirLocalHooks.join(", ")}) — these are NOT version-controlled and won't exist for other clones/CI; prefer .husky.`);
  }
  if (!dependsOnHusky && !huskyDirPresent && gitHooksDirLocalHooks.length === 0 && legacyHuskyHooks.length === 0) {
    hints.push("No hook tooling detected at all (no husky, no .git/hooks, no legacy config).");
  }

  return {
    path: rootOrigPath,
    pkgPath: pkgOrigPath,
    huskyDirPresent,
    huskyHooks,
    gitHooksDirLocalHooks,
    packageJsonLegacyHuskyHooks: legacyHuskyHooks,
    lintStagedConfigured,
    dependsOnHusky,
    dependsOnLintStaged,
    lintStagedWiredInHook,
    hints,
  };
}

module.exports = { gitHooksAudit };
