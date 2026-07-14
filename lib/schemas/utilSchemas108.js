"use strict";

const BITBUCKET_CLIENT_SCHEMA = {
  name: "bitbucket_client",
  description: "Zero-dependency Bitbucket REST API 2.0 client — pure Node.js https built-ins; no npm deps. Bitbucket Cloud only. Auth: App Password (username + app_password via HTTP Basic), OAuth2 access token (Bearer), or unauthenticated for public resources. Base URL: https://api.bitbucket.org/2.0. 56 operations: Repositories (repo_get, repo_list, repo_create, repo_delete, repo_fork, repo_watchers), Issues (issue_list, issue_get, issue_create, issue_update, issue_delete, issue_comment, issue_comments), Pull Requests (pr_list, pr_get, pr_create, pr_merge, pr_decline, pr_update, pr_comments, pr_add_comment), Commits (commit_list, commit_get, commit_statuses, commit_approve), Source/Contents (src_get, src_list, src_history), Branches (branch_list, branch_get, branch_create, branch_delete), Tags (tag_list, tag_get, tag_create), Pipelines (pipeline_list, pipeline_get, pipeline_create, pipeline_stop, pipeline_steps), Workspaces (workspace_list, workspace_get, workspace_members), Users (user_get, user_me, user_repos), Webhooks (webhook_list, webhook_create, webhook_delete), Snippets (snippet_list, snippet_get), generic authenticated request, and info.",
  inputSchema: {
    type: "object",
    required: ["operation"],
    properties: {
      operation: {
        type: "string",
        description: "Operation to perform. One of: repo_get, repo_list, repo_create, repo_delete, repo_fork, repo_watchers, issue_list, issue_get, issue_create, issue_update, issue_delete, issue_comment, issue_comments, pr_list, pr_get, pr_create, pr_merge, pr_decline, pr_update, pr_comments, pr_add_comment, commit_list, commit_get, commit_statuses, commit_approve, src_get, src_list, src_history, branch_list, branch_get, branch_create, branch_delete, tag_list, tag_get, tag_create, pipeline_list, pipeline_get, pipeline_create, pipeline_stop, pipeline_steps, workspace_list, workspace_get, workspace_members, user_get, user_me, user_repos, webhook_list, webhook_create, webhook_delete, snippet_list, snippet_get, request, info.",
      },
      // ── Auth / Connection ──────────────────────────────────────────────────
      username: {
        type: "string",
        description: "Bitbucket username for App Password authentication. Required together with app_password for Basic Auth.",
      },
      app_password: {
        type: "string",
        description: "Bitbucket App Password for Basic Auth. Generate under Account Settings > App passwords. Never returned in output or errors.",
      },
      access_token: {
        type: "string",
        description: "OAuth2 Bearer access token. Alternative to username + app_password. Never returned in output or errors.",
      },
      base_url: {
        type: "string",
        description: "Base URL override (default: 'https://api.bitbucket.org/2.0'). Bitbucket Cloud only.",
      },
      timeout: {
        type: "number",
        description: "Request timeout in milliseconds (1000–120000, default: 20000).",
      },
      reject_unauthorized: {
        type: "boolean",
        description: "Whether to enforce TLS certificate verification (default: true).",
      },
      // ── Workspace / Repo identity ──────────────────────────────────────────
      workspace: {
        type: "string",
        description: "Workspace slug. Required for all repository-scoped operations (repo_get, issue_list, pr_list, etc.) and workspace_get/workspace_members. Also used as an optional filter in snippet_list.",
      },
      repo_slug: {
        type: "string",
        description: "Repository slug. Required for repository-scoped operations (issue_list, pr_list, commit_list, branch_list, etc.).",
      },
      // ── Issues ────────────────────────────────────────────────────────────
      issue_id: {
        type: ["number", "string"],
        description: "Issue ID (numeric). Required for issue_get, issue_update, issue_delete, issue_comment, issue_comments.",
      },
      title: {
        type: "string",
        description: "Issue title (issue_create), PR title (pr_create, pr_update), webhook description.",
      },
      content: {
        type: "string",
        description: "Issue body/content (issue_create, issue_update). Comment body (issue_comment, pr_add_comment).",
      },
      kind: {
        type: "string",
        description: "Issue kind: 'bug', 'enhancement', 'proposal', 'task'. Used in issue_create, issue_update, issue_list filter.",
      },
      priority: {
        type: "string",
        description: "Issue priority: 'trivial', 'minor', 'major', 'critical', 'blocker'. Used in issue_create, issue_update.",
      },
      assignee: {
        type: "string",
        description: "Assignee nickname/username. Used in issue_create, issue_update.",
      },
      status: {
        type: "string",
        description: "Issue status for issue_update ('new', 'open', 'resolved', 'on hold', 'invalid', 'duplicate', 'wontfix') or filter for issue_list.",
      },
      // ── Pull Requests ─────────────────────────────────────────────────────
      pr_id: {
        type: ["number", "string"],
        description: "Pull Request ID (numeric). Required for pr_get, pr_merge, pr_decline, pr_update, pr_comments, pr_add_comment.",
      },
      source_branch: {
        type: "string",
        description: "Source branch name. Required for pr_create.",
      },
      dest_branch: {
        type: "string",
        description: "Destination branch name. Required for pr_create. Used as update field in pr_update.",
      },
      description: {
        type: "string",
        description: "PR description (pr_create, pr_update). Repository description (repo_create). Webhook description (webhook_create).",
      },
      close_source_branch: {
        type: "boolean",
        description: "pr_create/pr_merge: close the source branch after the pull request is merged.",
      },
      reviewers: {
        type: "array",
        items: { type: "string" },
        description: "List of reviewer nicknames. Used in pr_create, pr_update.",
      },
      merge_strategy: {
        type: "string",
        description: "pr_merge: merge strategy — 'merge_commit', 'squash', or 'fast_forward'.",
      },
      message: {
        type: "string",
        description: "pr_merge: custom merge commit message. tag_create: tag annotation message.",
      },
      inline: {
        type: "object",
        description: "pr_add_comment: inline comment position. Object with 'from' (line number), 'to' (line number), and 'path' (file path).",
      },
      // ── Commits ───────────────────────────────────────────────────────────
      commit: {
        type: "string",
        description: "Commit hash (full or short). Required for commit_get, commit_statuses, commit_approve.",
      },
      branch: {
        type: "string",
        description: "Branch name. Required for branch_get, branch_create, branch_delete. Used as filter in commit_list, pipeline_list, pipeline_create (alternative to commit).",
      },
      exclude: {
        type: "string",
        description: "commit_list: exclude commits reachable from this ref.",
      },
      // ── Source / Contents ──────────────────────────────────────────────────
      path_in_repo: {
        type: "string",
        description: "Path to a file or directory inside the repository. Required for src_get, src_history. Optional for src_list (defaults to root).",
      },
      ref: {
        type: "string",
        description: "Git ref (branch, tag, or commit SHA). Used in src_get, src_list, src_history (default: HEAD).",
      },
      format: {
        type: "string",
        description: "src_get: response format — 'meta' returns file metadata instead of raw content.",
      },
      renames: {
        type: "boolean",
        description: "src_history: whether to follow file renames.",
      },
      // ── Branches / Tags ───────────────────────────────────────────────────
      target: {
        type: "string",
        description: "branch_create: commit hash or ref to base the new branch on. tag_create: commit hash to tag.",
      },
      tag: {
        type: "string",
        description: "Tag name. Required for tag_get, tag_create.",
      },
      // ── Repositories ──────────────────────────────────────────────────────
      scm: {
        type: "string",
        description: "repo_create: source control type — 'git' (default) or 'hg'.",
      },
      is_private: {
        type: "boolean",
        description: "repo_create: whether the repository is private (default: true). repo_fork: visibility of the fork.",
      },
      has_issues: {
        type: "boolean",
        description: "repo_create: enable the issue tracker.",
      },
      has_wiki: {
        type: "boolean",
        description: "repo_create: enable the wiki.",
      },
      fork_policy: {
        type: "string",
        description: "repo_create: forking policy — 'allow_forks', 'no_public_forks', or 'no_forks'.",
      },
      language: {
        type: "string",
        description: "repo_create: primary programming language.",
      },
      project_key: {
        type: "string",
        description: "repo_create: Bitbucket project key to associate the repository with.",
      },
      name: {
        type: "string",
        description: "repo_create: human-readable repository name. repo_fork: name for the forked repository.",
      },
      fork_workspace: {
        type: "string",
        description: "repo_fork: destination workspace slug for the fork (defaults to the source workspace).",
      },
      role: {
        type: "string",
        description: "repo_list: filter by role — 'owner', 'admin', 'contributor', 'member'. workspace_list: filter by role — 'owner', 'collaborator', 'member'. user_repos: filter by role.",
      },
      q: {
        type: "string",
        description: "Bitbucket query filter string. Used in repo_list, issue_list, pr_list, branch_list.",
      },
      sort: {
        type: "string",
        description: "Sort field for list operations. repo_list: '-updated_on' (default). issue_list: '-created_on' (default). tag_list: '-target.date' (default).",
      },
      // ── Pipelines ──────────────────────────────────────────────────────────
      pipeline_uuid: {
        type: "string",
        description: "Pipeline UUID (with or without curly braces). Required for pipeline_get, pipeline_stop, pipeline_steps.",
      },
      variables: {
        type: "array",
        items: { type: "object" },
        description: "pipeline_create: array of pipeline variable objects (e.g. [{ key: 'MY_VAR', value: 'hello', secured: false }]).",
      },
      // ── Users ─────────────────────────────────────────────────────────────
      account_id: {
        type: "string",
        description: "Bitbucket account ID (UUID or '~accountId' format). Used in user_get (alternative to username). user_repos as fallback identifier.",
      },
      // ── Webhooks ──────────────────────────────────────────────────────────
      url: {
        type: "string",
        description: "Webhook endpoint URL. Required for webhook_create.",
      },
      events: {
        type: "array",
        items: { type: "string" },
        description: "webhook_create: list of events to subscribe to (e.g. ['repo:push', 'pullrequest:created', 'issue:created']).",
      },
      active: {
        type: "boolean",
        description: "webhook_create: whether the webhook is active (default: true).",
      },
      secret: {
        type: "string",
        description: "webhook_create: HMAC secret for webhook payload signing.",
      },
      webhook_uid: {
        type: "string",
        description: "Webhook UID/UUID. Required for webhook_delete.",
      },
      // ── Snippets ──────────────────────────────────────────────────────────
      snippet_id: {
        type: "string",
        description: "Snippet ID. Required for snippet_get.",
      },
      // ── Generic request ───────────────────────────────────────────────────
      api_path: {
        type: "string",
        description: "API path for the generic 'request' operation (e.g. '/repositories/myworkspace/myrepo/hooks'). Must start with '/'.",
      },
      method: {
        type: "string",
        description: "HTTP method for the generic 'request' operation: GET, POST, PUT, PATCH, DELETE, HEAD.",
      },
      body: {
        type: "object",
        description: "Request body for the generic 'request' operation (serialized as JSON).",
      },
      // ── Pagination ────────────────────────────────────────────────────────
      page: {
        type: "number",
        description: "Page number (1-based, default: 1). Applies to all list operations.",
      },
      pagelen: {
        type: "number",
        description: "Number of results per page (1–100, default: 20). Applies to all list operations.",
      },
      // ── File path alias ───────────────────────────────────────────────────
      file_path: {
        type: "string",
        description: "Alias for path_in_repo (for commit_list file filter and src operations).",
      },
    },
  },
};

module.exports = { BITBUCKET_CLIENT_SCHEMA };
