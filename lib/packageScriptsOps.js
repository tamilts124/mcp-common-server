"use strict";
// ── SUMMARIZE_PACKAGE_SCRIPTS — categorize package.json "scripts" by purpose ──
// Reads a package.json's `scripts` map and buckets each entry into a
// developer-facing category using name + command keyword heuristics, so an
// agent can answer "which script builds this?" / "which script runs tests?"
// without re-deriving it from scratch each time.
//
// Categories (checked in this priority order per script — first match wins):
//   test | typecheck | lint | format | build | dev | start | deploy | clean | other
//
// Pure static heuristic (regex over the script name and its command string),
// not an execution/analysis of what the command actually does.
const fs = require("fs");
const { ToolError } = require("./errors");

// Ordered [category, nameRe, cmdRe] — nameRe tested against the script key,
// cmdRe tested against the command string. Either match is sufficient.
const RULES = [
  ["test", /^test\b|^test:|:test$/i, /\b(jest|mocha|vitest|ava|tap|jasmine|karma|cypress|playwright)\b/i],
  ["typecheck", /^typecheck|^type-check|^tsc\b/i, /\btsc\b.*--noEmit/i],
  ["lint", /^lint\b|^lint:/i, /\b(eslint|tslint|stylelint)\b/i],
  ["format", /^format\b|^fmt\b|^prettier/i, /\bprettier\b/i],
  ["build", /^build\b|^build:|^compile\b/i, /\b(webpack|rollup|esbuild|vite build|next build|parcel build|babel)\b|\btsc\b(?!.*--noEmit)/i],
  ["dev", /^dev\b|^watch\b/i, /\b(nodemon|ts-node-dev|next dev|webpack-dev-server)\b|\bvite\b(?!.*build)/i],
  ["start", /^start\b|^serve\b/i, /\bnode\b|\bpm2\b/i],
  ["deploy", /^deploy\b|^publish\b|^release\b/i, /\b(npm publish|vercel|netlify|firebase deploy|serverless deploy|gh-pages)\b/i],
  ["clean", /^clean\b|^clear\b|^reset\b/i, /\brimraf\b|rm -rf/i],
];

function categorize(name, cmd) {
  for (const [category, nameRe, cmdRe] of RULES) {
    if (nameRe.test(name) || cmdRe.test(cmd)) return category;
  }
  return "other";
}

/**
 * @param {string} filePath  Absolute path to package.json.
 * @param {string} origPath  Client-relative path echoed in the result.
 * @returns {{path, scriptsCount, categories: object, scripts: Array}}
 */
function summarizePackageScripts(filePath, origPath) {
  let raw;
  try { raw = fs.readFileSync(filePath, "utf8"); }
  catch (e) { throw new ToolError(`summarize_package_scripts: cannot read '${origPath}': ${e.message}`, -32602); }

  let pkg;
  try { pkg = JSON.parse(raw); }
  catch (e) { throw new ToolError(`summarize_package_scripts: '${origPath}' is not valid JSON: ${e.message}`, -32602); }

  if (pkg === null || typeof pkg !== "object" || Array.isArray(pkg))
    throw new ToolError(`summarize_package_scripts: '${origPath}' must contain a JSON object at the top level.`, -32602);

  const scriptsObj = pkg.scripts;
  if (scriptsObj === undefined) {
    return { path: origPath, scriptsCount: 0, categories: {}, scripts: [] };
  }
  if (scriptsObj === null || typeof scriptsObj !== "object" || Array.isArray(scriptsObj))
    throw new ToolError(`summarize_package_scripts: '${origPath}' has a 'scripts' field that is not an object.`, -32602);

  const scripts = [];
  const categories = {};
  for (const [name, cmd] of Object.entries(scriptsObj)) {
    const command = typeof cmd === "string" ? cmd : String(cmd);
    const category = categorize(name, command);
    scripts.push({ name, command, category });
    (categories[category] = categories[category] || []).push(name);
  }

  return { path: origPath, scriptsCount: scripts.length, categories, scripts };
}

module.exports = { summarizePackageScripts };
