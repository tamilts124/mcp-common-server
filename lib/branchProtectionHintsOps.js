"use strict";
// ── CHECK_BRANCH_PROTECTION_HINTS ────────────────────────────────────────────
// GitHub branch-protection rules themselves live server-side (not in the
// repo), so there's no way to read the *actual* rule set from a checkout.
// This tool is a heuristic proxy: it looks at the repo-local signals that
// commonly accompany (or drive) branch protection —
//   - CODEOWNERS file (root, .github/, or docs/) — required-reviewers proxy.
//   - .github/workflows/*.yml|.yaml — PR-triggered workflows; their job
//     names are the conventional "required status check" names configured
//     in GitHub's branch-protection UI.
//   - .github/settings.yml (the probot "Settings" app format) — can
//     directly declare `branches: [{ protection: {...} }]`; parsed with the
//     project's existing zero-dependency YAML parser when present.
// Read-only, filesystem-only — does not touch git at all.
const fs = require("fs");
const path = require("path");
const { parseYaml } = require("./yamlOps");

const CODEOWNERS_LOCATIONS = ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"];
const WORKFLOWS_DIR = ".github/workflows";
const SETTINGS_FILE = ".github/settings.yml";

function findCodeowners(rootDir) {
  for (const rel of CODEOWNERS_LOCATIONS) {
    const p = path.join(rootDir, rel);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return rel.replace(/\\/g, "/");
  }
  return null;
}

// Very small heuristic YAML "on:" trigger sniff — workflow files are highly
// variable in shape (on: push / on: [push, pull_request] / on:\n  pull_request:)
// so rather than depend on parseYaml() getting every workflow's on: block
// exactly right, just check whether the literal token "pull_request" appears
// under an "on:" section via a scoped regex. False positives (e.g. a comment)
// are an acceptable risk for a heuristic, non-authoritative tool.
function workflowRunsOnPR(raw) {
  return /^on:[\s\S]*?pull_request/m.test(raw) || /^on:\s*\[[^\]]*pull_request/m.test(raw);
}

function listWorkflowJobNames(raw) {
  let doc;
  try { doc = parseYaml(raw); } catch (_) { return null; } // best-effort; not every workflow parses with the minimal parser
  if (!doc || typeof doc !== "object" || !doc.jobs || typeof doc.jobs !== "object") return null;
  return Object.keys(doc.jobs);
}

function readSettingsBranchProtection(rootDir) {
  const p = path.join(rootDir, SETTINGS_FILE);
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return null;
  let raw;
  try { raw = fs.readFileSync(p, "utf8"); } catch (_) { return null; }
  let doc;
  try { doc = parseYaml(raw); } catch (e) {
    return { parsed: false, error: e.message.split("\n")[0] };
  }
  const branches = Array.isArray(doc && doc.branches) ? doc.branches : [];
  const withProtection = branches
    .filter(b => b && typeof b === "object" && b.protection)
    .map(b => ({ name: b.name || null, protection: b.protection }));
  return { parsed: true, branchesDeclared: branches.length, branchesWithProtection: withProtection };
}

/**
 * @param {string} rootDir  Absolute directory to scan (the repo root, or any directory — no git dependency).
 * @param {string} origPath Client-relative path echoed in the result.
 * @returns {{
 *   path: string, hasCodeowners: boolean, codeownersPath: string|null,
 *   workflowsDir: string|null,
 *   workflows: Array<{file, runsOnPR: boolean, jobNames: string[]|null}>,
 *   anyWorkflowRunsOnPR: boolean,
 *   settingsYml: {present: boolean, parsed?: boolean, error?: string, branchesDeclared?: number, branchesWithProtection?: Array},
 *   hints: string[],
 * }}
 */
function checkBranchProtectionHints(rootDir, origPath) {
  let stat;
  try { stat = fs.statSync(rootDir); }
  catch (e) { throw new Error(`check_branch_protection_hints: cannot access '${origPath}': ${e.message}`); }
  if (!stat.isDirectory()) throw new Error(`check_branch_protection_hints: '${origPath}' is not a directory.`);

  const codeownersPath = findCodeowners(rootDir);

  const workflowsAbsDir = path.join(rootDir, WORKFLOWS_DIR);
  let workflows = [];
  let workflowsDirExists = false;
  try {
    if (fs.statSync(workflowsAbsDir).isDirectory()) {
      workflowsDirExists = true;
      const entries = fs.readdirSync(workflowsAbsDir)
        .filter(f => /\.ya?ml$/i.test(f))
        .sort();
      for (const f of entries) {
        let raw;
        try { raw = fs.readFileSync(path.join(workflowsAbsDir, f), "utf8"); }
        catch (_) { continue; }
        workflows.push({
          file: `${WORKFLOWS_DIR}/${f}`,
          runsOnPR: workflowRunsOnPR(raw),
          jobNames: listWorkflowJobNames(raw),
        });
      }
    }
  } catch (_) { /* no .github/workflows dir — not an error, just absent */ }

  const anyWorkflowRunsOnPR = workflows.some(w => w.runsOnPR);
  const settingsYml = { present: false, ...(readSettingsBranchProtection(rootDir) || {}) };
  settingsYml.present = fs.existsSync(path.join(rootDir, SETTINGS_FILE));

  const hints = [];
  if (!codeownersPath) hints.push("No CODEOWNERS file found — required-reviewer rules (if any) aren't declared in-repo.");
  if (!workflowsDirExists) hints.push("No .github/workflows directory — no CI-based status checks detected.");
  else if (!anyWorkflowRunsOnPR) hints.push(".github/workflows exists but no workflow appears to trigger on pull_request — status checks likely won't gate PRs.");
  if (settingsYml.present && settingsYml.parsed && settingsYml.branchesWithProtection && settingsYml.branchesWithProtection.length > 0) {
    hints.push(`${SETTINGS_FILE} declares explicit branch protection for ${settingsYml.branchesWithProtection.length} branch(es).`);
  }
  if (codeownersPath && anyWorkflowRunsOnPR) {
    hints.push("Both CODEOWNERS and a PR-triggered workflow are present — commonly paired with required-reviews + required-status-checks branch protection.");
  }

  return {
    path: origPath,
    hasCodeowners: !!codeownersPath,
    codeownersPath,
    workflowsDir: workflowsDirExists ? WORKFLOWS_DIR : null,
    workflows,
    anyWorkflowRunsOnPR,
    settingsYml,
    hints,
  };
}

module.exports = { checkBranchProtectionHints };
