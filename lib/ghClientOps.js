'use strict';
/**
 * gh_client — GitHub CLI wrapper
 * Reads GH_TOKEN from .env and executes gh CLI commands.
 * GH_TOKEN is injected as an env var, which gh honours automatically.
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs   = require('fs');

function loadEnvOnce() {
  const envFile = path.join(__dirname, '..', '.env');
  try {
    const txt = fs.readFileSync(envFile, 'utf8');
    for (const raw of txt.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
        val = val.slice(1, -1);
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch (_) {}
}
loadEnvOnce();

// Simple argv tokeniser — splits on whitespace, respects single/double quotes
function parseArgs(str) {
  const tokens = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (quote) {
      if (ch === quote) { quote = null; }
      else { cur += ch; }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ' ' || ch === '\t') {
      if (cur) { tokens.push(cur); cur = ''; }
    } else {
      cur += ch;
    }
  }
  if (cur) tokens.push(cur);
  return tokens;
}

function ghRun({ args_str, cwd, timeout_ms }) {
  const token = process.env.GH_TOKEN;
  if (!token) {
    return {
      ok: false,
      error: 'GH_TOKEN is not set. Add GH_TOKEN=<your_pat> to D:/ClaudeDir/mcp-common-server/.env and restart the server.',
    };
  }

  const argv = parseArgs(args_str || '');
  if (argv.length === 0) {
    return { ok: false, error: "args_str is empty. Example: \"repo create my-repo --public\"" };
  }

  const env = Object.assign({}, process.env, { GH_TOKEN: token, NO_COLOR: '1', GH_PROMPT_DISABLED: '1' });
  const timeoutMs = Math.min(Math.max(timeout_ms || 30000, 1000), 120000);

  const result = spawnSync('gh', argv, {
    env,
    cwd: cwd || process.cwd(),
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
    encoding: 'utf8',
    windowsHide: true,
  });

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      return { ok: false, error: 'gh CLI not found on PATH. Install from https://cli.github.com' };
    }
    if (result.error.code === 'ETIMEDOUT') {
      return { ok: false, error: `gh command timed out after ${timeoutMs}ms` };
    }
    return { ok: false, error: result.error.message };
  }

  const stdout   = (result.stdout || '').trim();
  const stderr   = (result.stderr || '').trim();
  const exitCode = result.status ?? -1;

  return {
    ok: exitCode === 0,
    exit_code: exitCode,
    stdout: stdout || null,
    stderr: stderr || null,
    command: 'gh ' + argv.join(' '),
  };
}

module.exports = { ghRun };
