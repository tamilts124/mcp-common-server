"use strict";

const GITHUB_CLIENT_SCHEMA = {
  name: "github_client",
  description: "Zero-dependency GitHub REST API v3 client — pure Node.js https built-ins; no npm deps. Authenticates via Personal Access Token (PAT) or GitHub App token (Bearer). Unauthenticated access allowed for public resources (60 req/hour); authenticated users get 5000 req/hour. Base URL: https://api.github.com (override with base_url for GitHub Enterprise). Supported operations: Repositories (repo_get, repo_list, repo_create, repo_delete, repo_fork), Issues (issue_list, issue_get, issue_create, issue_update, issue_comment, issue_comments), Pull Requests (pr_list, pr_get, pr_create, pr_merge, pr_review, pr_files), Contents (file_get, file_create, file_delete, dir_list), Branches/Refs (branch_list, branch_get, branch_create, branch_delete, branch_protect), Commits (commit_list, commit_get, commit_compare), Releases (release_list, release_get, release_create, release_latest), Actions/Workflows (workflow_list, workflow_runs, workflow_run_get, workflow_dispatch), Search (search_repos, search_issues, search_code, search_commits), Users (user_get, user_me), Organizations (org_get, org_repos, org_members), Stars (star_list, starred_list), Gists (gist_list, gist_get, gist_create), generic authenticated request, and info.",
  inputSchema: {
    type: "object",
    required: ["operation"],
    properties: {
      operation: {
        type: "string",
        description: "Operation to perform. One of: repo_get, repo_list, repo_create, repo_delete, repo_fork, issue_list, issue_get, issue_create, issue_update, issue_comment, issue_comments, pr_list, pr_get, pr_create, pr_merge, pr_review, pr_files, file_get, file_create, file_delete, dir_list, branch_list, branch_get, branch_create, branch_delete, branch_protect, commit_list, commit_get, commit_compare, release_list, release_get, release_create, release_latest, workflow_list, workflow_runs, workflow_run_get, workflow_dispatch, search_repos, search_issues, search_code, search_commits, user_get, user_me, org_get, org_repos, org_members, star_list, starred_list, gist_list, gist_get, gist_create, request, info.",
      },
      // ── Auth / Connection ─────────────────────────────────────────────────────
      token: {
        type: "string",
        description: "GitHub Personal Access Token (PAT) or GitHub App token. Used as Bearer token. Omit for unauthenticated public access (60 req/hour). Never returned in output or errors.",
      },
      base_url: {
        type: "string",
        description: "Base URL of the GitHub API (default: 'https://api.github.com'). Override for GitHub Enterprise Server (e.g. 'https://github.example.com/api/v3').",
      },
      timeout: {
        type: "number",
        description: "Request timeout in milliseconds (1000–120000, default: 20000).",
      },
      // ── Repository ────────────────────────────────────────────────────────
      owner: {
        type: "string",
        description: "Repository owner (user or organization login). Required for most repo/issue/PR/content/branch/commit/release/workflow operations.",
      },
      repo: {
        type: "string",
        description: "Repository name (without owner prefix). Required for most repo/issue/PR/content/branch/commit/release/workflow operations.",
      },
      org: {
        type: "string",
        description: "Organization login. Used in repo_list (to list org repos), repo_create (to create in org), org_get, org_repos, org_members.",
      },
      name: {
        type: "string",
        description: "Repository name for repo_create. Also used in release_create for the release title, and repo_fork for the forked repo name.",
      },
      description: {
        type: "string",
        description: "Repository description for repo_create. Also used in gist_create.",
      },
      private: {
        type: "boolean",
        description: "repo_create: whether to create a private repository (default: false).",
      },
      auto_init: {
        type: "boolean",
        description: "repo_create: initialize the repository with a README (default: false).",
      },
      gitignore_template: {
        type: "string",
        description: "repo_create: name of the .gitignore template (e.g. 'Node', 'Python').",
      },
      license_template: {
        type: "string",
        description: "repo_create: SPDX license identifier (e.g. 'mit', 'apache-2.0').",
      },
      // ── Issues ────────────────────────────────────────────────────────────
      issue_number: {
        type: "number",
        description: "Issue number. Required for issue_get, issue_update, issue_comment, issue_comments.",
      },
      title: {
        type: "string",
        description: "Issue or PR title. Required for issue_create and pr_create.",
      },
      body: {
        type: "string",
        description: "Body text for issues, PRs, PR reviews, comments, releases, and gist_create.",
      },
      labels: {
        type: "array",
        items: { type: "string" },
        description: "Label names. Used in issue_create and issue_update.",
      },
      assignees: {
        type: "array",
        items: { type: "string" },
        description: "GitHub usernames to assign. Used in issue_create and issue_update.",
      },
      milestone: {
        type: "number",
        description: "Milestone number. Used in issue_create and issue_update.",
      },
      state: {
        type: "string",
        description: "Filter state for list operations: 'open', 'closed', or 'all'. For issue_update/pr_update: 'open' or 'closed'.",
      },
      since: {
        type: "string",
        description: "ISO 8601 timestamp. Filter issues/commits created/updated after this date (e.g. '2024-01-01T00:00:00Z').",
      },
      assignee: {
        type: "string",
        description: "issue_list: filter by assignee login. Use '*' for any assigned, 'none' for unassigned.",
      },
      // ── Pull Requests ─────────────────────────────────────────────────────
      pull_number: {
        type: "number",
        description: "Pull request number. Required for pr_get, pr_merge, pr_review, pr_files.",
      },
      head: {
        type: "string",
        description: "pr_create: head branch (format: 'owner:branch' for cross-fork PRs or just 'branch'). pr_list: filter by head branch.",
      },
      base: {
        type: "string",
        description: "pr_create: base branch to merge into. pr_list: filter by base branch. commit_compare: base commit/branch.",
      },
      draft: {
        type: "boolean",
        description: "pr_create: create as draft PR (default: false).",
      },
      maintainer_can_modify: {
        type: "boolean",
        description: "pr_create: allow maintainers to modify the head branch (default: true).",
      },
      merge_method: {
        type: "string",
        description: "pr_merge: merge strategy — 'merge', 'squash', or 'rebase'.",
      },
      commit_title: {
        type: "string",
        description: "pr_merge: title for the merge commit.",
      },
      commit_message: {
        type: "string",
        description: "pr_merge: extra detail for the merge commit message.",
      },
      event: {
        type: "string",
        description: "pr_review: review event — 'APPROVE', 'REQUEST_CHANGES', or 'COMMENT'.",
      },
      comments: {
        type: "array",
        items: { type: "object" },
        description: "pr_review: inline review comment objects (path, position, body).",
      },
      // ── Contents ──────────────────────────────────────────────────────────
      path: {
        type: "string",
        description: "File or directory path within the repository. Required for file_get, file_create, file_delete, dir_list. Also used as the generic API path for the 'request' operation.",
      },
      ref: {
        type: "string",
        description: "Git ref (branch, tag, or SHA) to use for content operations (file_get, dir_list) or workflow_dispatch.",
      },
      message: {
        type: "string",
        description: "Commit message. Required for file_create and file_delete.",
      },
      content: {
        type: "string",
        description: "File content as a UTF-8 string. Required for file_create.",
      },
      sha: {
        type: "string",
        description: "file_create: SHA of the existing file blob (required for updates, omit for creates). file_delete: SHA of the file to delete. branch_create: SHA to create the branch at. commit_get: commit SHA. pr_merge: expected head SHA for idempotency.",
      },
      branch: {
        type: "string",
        description: "Branch name. Required for branch_get, branch_create, branch_delete, branch_protect. Used optionally in file_create, file_delete. workflow_runs: filter by branch.",
      },
      committer: {
        type: "object",
        description: "file_create/file_delete: committer identity ({ name, email }). Defaults to the authenticated user.",
      },
      author: {
        type: "object",
        description: "file_create: author identity ({ name, email }). Defaults to the authenticated user.",
      },
      // ── Commits ───────────────────────────────────────────────────────────
      file_path: {
        type: "string",
        description: "commit_list: filter commits touching this file path.",
      },
      until: {
        type: "string",
        description: "commit_list: ISO 8601 timestamp to filter commits before this date.",
      },
      // ── Releases ──────────────────────────────────────────────────────────
      release_id: {
        type: "number",
        description: "Release ID. Required for release_get.",
      },
      tag_name: {
        type: "string",
        description: "Git tag name. Required for release_create.",
      },
      target_commitish: {
        type: "string",
        description: "release_create: branch/commit SHA the tag is created from (default: default branch).",
      },
      prerelease: {
        type: "boolean",
        description: "release_create: mark as pre-release (default: false).",
      },
      generate_release_notes: {
        type: "boolean",
        description: "release_create: automatically generate release notes from merged PRs (default: false).",
      },
      // ── Workflows / Actions ───────────────────────────────────────────────
      workflow_id: {
        type: ["string", "number"],
        description: "Workflow ID or filename (e.g. 'ci.yml'). Required for workflow_dispatch. Optional for workflow_runs (to filter runs by workflow).",
      },
      run_id: {
        type: "number",
        description: "Workflow run ID. Required for workflow_run_get.",
      },
      status: {
        type: "string",
        description: "workflow_runs: filter by status — 'queued', 'in_progress', 'completed', 'action_required', 'cancelled', 'failure', 'neutral', 'skipped', 'stale', 'success', 'timed_out', 'waiting'.",
      },
      actor: {
        type: "string",
        description: "workflow_runs: filter by triggering actor login.",
      },
      inputs: {
        type: "object",
        description: "workflow_dispatch: key-value inputs for the workflow (must match inputs defined in the workflow YAML).",
      },
      // ── Search ────────────────────────────────────────────────────────────
      query: {
        type: "string",
        description: "Search query string. Required for search_repos, search_issues, search_code, search_commits.",
      },
      sort: {
        type: "string",
        description: "Sort field. search_repos: 'stars', 'forks', 'help-wanted-issues', 'updated'. search_issues: 'comments', 'reactions', 'created', 'updated'. repo_list/org_repos: 'created', 'updated', 'pushed', 'full_name'. issue_list: 'created', 'updated', 'comments'. pr_list: 'created', 'updated', 'popularity', 'long-running'. commit_list: 'author-date', 'committer-date'.",
      },
      order: {
        type: "string",
        description: "Sort direction for search operations: 'asc' or 'desc' (default: 'desc').",
      },
      // ── Users ─────────────────────────────────────────────────────────────
      username: {
        type: "string",
        description: "GitHub username. Required for user_get and starred_list. Optional for gist_list (to list another user's gists).",
      },
      // ── Gists ─────────────────────────────────────────────────────────────
      gist_id: {
        type: "string",
        description: "Gist ID. Required for gist_get.",
      },
      files: {
        type: "object",
        description: "gist_create: object mapping filename to file content string (e.g. { 'hello.js': 'console.log(1)' }).",
      },
      public: {
        type: "boolean",
        description: "gist_create: whether the gist is public (default: false).",
      },
      // ── Generic request ───────────────────────────────────────────────────
      method: {
        type: "string",
        description: "HTTP method for the generic 'request' operation: GET, POST, PUT, PATCH, DELETE, HEAD.",
      },
      // ── Pagination ────────────────────────────────────────────────────────
      per_page: {
        type: "number",
        description: "Number of results per page (1–100, default: 30). Applies to all list/search operations.",
      },
      page: {
        type: "number",
        description: "Page number (1-based, default: 1). Applies to all list/search operations.",
      },
      // ── Misc ──────────────────────────────────────────────────────────────
      direction: {
        type: "string",
        description: "Sort direction for list operations: 'asc' or 'desc'.",
      },
      type: {
        type: "string",
        description: "repo_list/org_repos: repository type filter — 'all', 'public', 'private', 'forks', 'sources', 'member'. org_members: role filter — 'all', 'admin', 'member'.",
      },
      role: {
        type: "string",
        description: "org_members: filter by role — 'all', 'admin', 'member' (default: 'all').",
      },
    },
  },
};

module.exports = { GITHUB_CLIENT_SCHEMA };
