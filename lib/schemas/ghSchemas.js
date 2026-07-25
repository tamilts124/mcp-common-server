'use strict';
// ── GH CLIENT TOOL SCHEMA ──────────────────────────────────────────────────

const GH_SCHEMAS = [
  {
    name: 'gh_client',
    description:
      'Run any GitHub CLI (gh) command. Reads GH_TOKEN from .env and executes the given ' +
      'gh subcommand. Use this to create repos, list PRs, manage issues, trigger workflows, ' +
      'view releases, and anything else the gh CLI supports. ' +
      'Examples: args_str="repo create my-repo --public --description Hello World", ' +
      'args_str="repo list", args_str="pr list --repo owner/repo", ' +
      'args_str="issue create --title Bug --body Details --repo owner/repo", ' +
      'args_str="release create v1.0 --repo owner/repo --notes Changes", ' +
      'args_str="auth status".',
    inputSchema: {
      type: 'object',
      required: ['args_str'],
      properties: {
        args_str: {
          type: 'string',
          description:
            'The gh subcommand and all its flags as a single string. ' +
            'Examples: "repo create my-app --public", "repo list", ' +
            '"pr list --repo owner/repo", "issue view 42 --repo owner/repo", ' +
            '"auth status", "release create v1.0 --repo owner/repo --notes Notes".',
        },
        cwd: {
          type: 'string',
          description: 'Working directory for the command (optional). Useful for repo-relative operations.',
        },
        timeout_ms: {
          type: 'number',
          description: 'Timeout in milliseconds (default: 30000, max: 120000).',
        },
      },
    },
  },
];

module.exports = { GH_SCHEMAS };
