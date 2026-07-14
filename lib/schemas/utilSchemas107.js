"use strict";

const GITLAB_CLIENT_SCHEMA = {
  name: "gitlab_client",
  description: "Zero-dependency GitLab REST API v4 client — pure Node.js https built-ins; no npm deps. Authenticates via Personal Access Token (PAT), OAuth2 token, or Project/Group Access Token via 'token' field (PRIVATE-TOKEN header). Unauthenticated access allowed for public resources. Base URL: https://gitlab.com/api/v4 (override with base_url for self-hosted instances). 68 operations: Projects (project_get, project_list, project_create, project_delete, project_fork, project_members, project_search), Issues (issue_list, issue_get, issue_create, issue_update, issue_close, issue_comment, issue_comments), Merge Requests (mr_list, mr_get, mr_create, mr_merge, mr_update, mr_notes, mr_add_note, mr_changes), Repository/Contents (file_get, file_create, file_update, file_delete, tree_list), Branches (branch_list, branch_get, branch_create, branch_delete, branch_protect, branch_unprotect), Commits (commit_list, commit_get, commit_diff, commit_statuses), Tags/Releases (tag_list, tag_get, tag_create, tag_delete, release_list, release_get, release_create), Pipelines/CI/CD (pipeline_list, pipeline_get, pipeline_create, pipeline_cancel, pipeline_retry, pipeline_jobs, job_get, job_log), Users (user_get, user_me, user_list), Groups (group_get, group_list, group_projects, group_members), Namespaces (namespace_list), Labels (label_list, label_create), Milestones (milestone_list, milestone_get, milestone_create), Snippets (snippet_list, snippet_get, snippet_create), generic authenticated request, and info.",
  inputSchema: {
    type: "object",
    required: ["operation"],
    properties: {
      operation: {
        type: "string",
        description: "Operation to perform. One of: project_get, project_list, project_create, project_delete, project_fork, project_members, project_search, issue_list, issue_get, issue_create, issue_update, issue_close, issue_comment, issue_comments, mr_list, mr_get, mr_create, mr_merge, mr_update, mr_notes, mr_add_note, mr_changes, file_get, file_create, file_update, file_delete, tree_list, branch_list, branch_get, branch_create, branch_delete, branch_protect, branch_unprotect, commit_list, commit_get, commit_diff, commit_statuses, tag_list, tag_get, tag_create, tag_delete, release_list, release_get, release_create, pipeline_list, pipeline_get, pipeline_create, pipeline_cancel, pipeline_retry, pipeline_jobs, job_get, job_log, user_get, user_me, user_list, group_get, group_list, group_projects, group_members, namespace_list, label_list, label_create, milestone_list, milestone_get, milestone_create, snippet_list, snippet_get, snippet_create, request, info.",
      },
      // ── Auth / Connection ──────────────────────────────────────────────────
      token: {
        type: "string",
        description: "GitLab Personal Access Token (PAT), OAuth2 token, or Project/Group Access Token. Sent as PRIVATE-TOKEN header. Omit for unauthenticated access to public resources. Never returned in output or errors.",
      },
      base_url: {
        type: "string",
        description: "Base URL of the GitLab API (default: 'https://gitlab.com/api/v4'). Override for self-hosted GitLab instances (e.g. 'https://gitlab.example.com/api/v4').",
      },
      timeout: {
        type: "number",
        description: "Request timeout in milliseconds (1000–120000, default: 20000).",
      },
      reject_unauthorized: {
        type: "boolean",
        description: "Whether to enforce TLS certificate verification (default: true). Set false only for self-hosted instances with self-signed certificates.",
      },
      // ── Project ───────────────────────────────────────────────────────────
      project_id: {
        type: ["number", "string"],
        description: "Numeric GitLab project ID. Alternative to 'project'. Required (with 'project') for most project-scoped operations.",
      },
      project: {
        type: "string",
        description: "Project namespace and name in 'namespace/project-name' format (URL-encoded automatically). Alternative to 'project_id'.",
      },
      name: {
        type: "string",
        description: "Project name for project_create. Label name for label_create. Milestone title for milestone_create. Tag name context.",
      },
      description: {
        type: "string",
        description: "Project description for project_create. Snippet description for snippet_create. Label description for label_create. Release description.",
      },
      visibility: {
        type: "string",
        description: "Visibility level: 'private', 'internal', or 'public'. Used in project_create, project_fork, snippet_create.",
      },
      namespace_id: {
        type: "number",
        description: "project_create: namespace ID to create the project in.",
      },
      initialize_with_readme: {
        type: "boolean",
        description: "project_create: initialize the project with a README file (default: false).",
      },
      namespace: {
        type: "string",
        description: "project_fork: namespace path to fork into. namespace_list: search filter.",
      },
      // ── Issues ────────────────────────────────────────────────────────────
      issue_iid: {
        type: "number",
        description: "Issue internal ID (iid, project-scoped). Required for issue_get, issue_update, issue_close, issue_comment, issue_comments.",
      },
      title: {
        type: "string",
        description: "Issue title (issue_create), MR title (mr_create, mr_update), milestone title (milestone_create).",
      },
      body: {
        type: "string",
        description: "Note/comment body for issue_comment, mr_add_note. Snippet content for snippet_create.",
      },
      labels: {
        type: ["array", "string"],
        description: "Label names (comma-separated string or array). Used in issue_create, issue_update, mr_create, mr_update.",
      },
      assignee_ids: {
        type: "array",
        items: { type: "number" },
        description: "Array of user IDs to assign. Used in issue_create, issue_update, mr_create, mr_update.",
      },
      milestone_id: {
        type: "number",
        description: "Milestone ID. Used in issue_create, issue_update, mr_create, mr_update.",
      },
      confidential: {
        type: "boolean",
        description: "issue_create: mark issue as confidential (default: false).",
      },
      due_date: {
        type: "string",
        description: "Due date in 'YYYY-MM-DD' format. Used in issue_create, issue_update, milestone_create.",
      },
      state_event: {
        type: "string",
        description: "State transition event. issue_update: 'close' or 'reopen'. mr_update: 'close', 'reopen', or 'merge'.",
      },
      state: {
        type: "string",
        description: "Filter by state: 'opened', 'closed', or 'all'. Used in issue_list, mr_list, milestone_list.",
      },
      // ── Merge Requests ────────────────────────────────────────────────────
      mr_iid: {
        type: "number",
        description: "Merge Request internal ID (iid, project-scoped). Required for mr_get, mr_merge, mr_update, mr_notes, mr_add_note, mr_changes.",
      },
      source_branch: {
        type: "string",
        description: "Source branch name. Required for mr_create. Used as filter in mr_list.",
      },
      target_branch: {
        type: "string",
        description: "Target branch name. Required for mr_create. Used as filter in mr_list and mr_update.",
      },
      reviewer_ids: {
        type: "array",
        items: { type: "number" },
        description: "Array of reviewer user IDs. Used in mr_create, mr_update.",
      },
      remove_source_branch_after_merge: {
        type: "boolean",
        description: "mr_create: automatically delete the source branch after merge.",
      },
      squash: {
        type: "boolean",
        description: "mr_create/mr_update: squash commits on merge. mr_merge: squash commits during this merge.",
      },
      draft: {
        type: "boolean",
        description: "mr_create/mr_update: mark as draft MR.",
      },
      merge_commit_message: {
        type: "string",
        description: "mr_merge: custom commit message for the merge.",
      },
      should_remove_source_branch: {
        type: "boolean",
        description: "mr_merge: remove the source branch after merging.",
      },
      sha: {
        type: "string",
        description: "mr_merge: expected HEAD SHA (guards against concurrent pushes). commit_get/commit_diff/commit_statuses: commit SHA.",
      },
      // ── Repository / File Contents ─────────────────────────────────────────
      file_path: {
        type: "string",
        description: "File path within the repository. Required for file_get, file_create, file_update, file_delete. commit_list: filter by file path.",
      },
      ref: {
        type: "string",
        description: "Git ref (branch name, tag, or commit SHA). Used in file_get (default: HEAD), tree_list (default: HEAD), branch_create (source ref), commit_list filter.",
      },
      content: {
        type: "string",
        description: "File content as UTF-8 string. Required for file_create, file_update, snippet_create.",
      },
      commit_message: {
        type: "string",
        description: "Commit message. Required for file_create, file_update, file_delete.",
      },
      encoding: {
        type: "string",
        description: "file_create/file_update: content encoding — 'text' (default) or 'base64'.",
      },
      last_commit_id: {
        type: "string",
        description: "file_update: last known commit ID for the file (optimistic locking).",
      },
      author_email: {
        type: "string",
        description: "Commit author email for file_create, file_update, file_delete.",
      },
      author_name: {
        type: "string",
        description: "Commit author name for file_create, file_update, file_delete.",
      },
      recursive: {
        type: "boolean",
        description: "tree_list: list directory tree recursively.",
      },
      // ── Branches ──────────────────────────────────────────────────────────
      branch: {
        type: "string",
        description: "Branch name. Required for branch_get, branch_create, branch_delete, branch_protect, branch_unprotect.",
      },
      push_access_level: {
        type: "number",
        description: "branch_protect: minimum access level for push (0=No access, 30=Developer, 40=Maintainer, 60=Admin). Default: 40.",
      },
      merge_access_level: {
        type: "number",
        description: "branch_protect: minimum access level for merge (0=No access, 30=Developer, 40=Maintainer, 60=Admin). Default: 40.",
      },
      allow_force_push: {
        type: "boolean",
        description: "branch_protect: allow force pushes (default: false).",
      },
      code_owner_approval_required: {
        type: "boolean",
        description: "branch_protect: require code owner approval (default: false).",
      },
      // ── Commits ───────────────────────────────────────────────────────────
      since: {
        type: "string",
        description: "commit_list: only commits after this date/time (ISO 8601).",
      },
      until: {
        type: "string",
        description: "commit_list: only commits before this date/time (ISO 8601).",
      },
      author: {
        type: "string",
        description: "commit_list: filter by author login/email.",
      },
      // ── Tags ──────────────────────────────────────────────────────────────
      tag_name: {
        type: "string",
        description: "Tag name. Required for tag_get, tag_create, tag_delete, release_get, release_create.",
      },
      message: {
        type: "string",
        description: "Tag annotation message for tag_create. Also used in release context.",
      },
      // ── Releases ──────────────────────────────────────────────────────────
      released_at: {
        type: "string",
        description: "release_create: ISO 8601 datetime for the release date.",
      },
      milestones: {
        type: "array",
        items: { type: "string" },
        description: "release_create: milestone titles to associate with the release.",
      },
      // ── Pipelines / CI/CD ─────────────────────────────────────────────────
      pipeline_id: {
        type: "number",
        description: "Pipeline ID. Required for pipeline_get, pipeline_cancel, pipeline_retry, pipeline_jobs.",
      },
      variables: {
        type: "array",
        items: { type: "object" },
        description: "pipeline_create: pipeline variables array (e.g. [{ key: 'VAR', value: 'val', variable_type: 'env_var' }]).",
      },
      source: {
        type: "string",
        description: "pipeline_list: filter by pipeline source (e.g. 'push', 'web', 'trigger', 'schedule', 'api', 'merge_request_event').",
      },
      scope: {
        type: "string",
        description: "pipeline_jobs: filter jobs by scope — 'created', 'pending', 'running', 'failed', 'success', 'canceled', 'skipped', 'waiting_for_resource', 'manual'.",
      },
      job_id: {
        type: "number",
        description: "Job ID. Required for job_get, job_log.",
      },
      // ── Users ─────────────────────────────────────────────────────────────
      user_id: {
        type: "number",
        description: "User numeric ID. Used in user_get (alternative to username).",
      },
      username: {
        type: "string",
        description: "GitLab username. Used in user_get (alternative to user_id).",
      },
      // ── Groups ────────────────────────────────────────────────────────────
      group_id: {
        type: "number",
        description: "Group numeric ID. Alternative to group_path. Required (with group_path) for group_get, group_projects, group_members.",
      },
      group_path: {
        type: "string",
        description: "Full group path (e.g. 'myorg/subgroup'). Alternative to group_id.",
      },
      // ── Labels ────────────────────────────────────────────────────────────
      color: {
        type: "string",
        description: "label_create: label color in hex format (e.g. '#FF0000') or a named CSS color.",
      },
      // ── Milestones ────────────────────────────────────────────────────────
      milestone: {
        type: "number",
        description: "milestone_get: milestone numeric ID. Also used as issue filter in issue_list.",
      },
      start_date: {
        type: "string",
        description: "milestone_create: milestone start date in 'YYYY-MM-DD' format.",
      },
      // ── Snippets ──────────────────────────────────────────────────────────
      snippet_id: {
        type: "number",
        description: "Snippet ID. Required for snippet_get.",
      },
      file_name: {
        type: "string",
        description: "snippet_create: filename for the snippet (default: 'snippet.txt').",
      },
      // ── Generic request ───────────────────────────────────────────────────
      path: {
        type: "string",
        description: "API path for the generic 'request' operation (e.g. '/projects/123/hooks'). Must start with '/'.",
      },
      method: {
        type: "string",
        description: "HTTP method for the generic 'request' operation: GET, POST, PUT, PATCH, DELETE, HEAD.",
      },
      // ── Pagination & Sorting ──────────────────────────────────────────────
      per_page: {
        type: "number",
        description: "Number of results per page (1–100, default: 20). Applies to all list operations.",
      },
      page: {
        type: "number",
        description: "Page number (1-based, default: 1). Applies to all list operations.",
      },
      order_by: {
        type: "string",
        description: "Sort field. project_list: 'id', 'name', 'path', 'created_at', 'updated_at', 'star_count' (default: 'updated_at'). issue_list: 'created_at', 'updated_at', 'priority'. mr_list: 'created_at', 'updated_at', 'title'.",
      },
      sort: {
        type: "string",
        description: "Sort direction: 'asc' or 'desc' (default: 'desc' for most operations, 'asc' for group_list).",
      },
      search: {
        type: "string",
        description: "Search/filter string. Used in project_search (required), project_list, issue_list, mr_list, branch_list, tag_list, user_list, group_list, namespace_list.",
      },
      // ── Misc Filters ──────────────────────────────────────────────────────
      membership: {
        type: "boolean",
        description: "project_list: if true, return only projects where the current user is a member.",
      },
      owned: {
        type: "boolean",
        description: "project_list: if true, return only projects owned by the current user. group_list: only owned groups.",
      },
      min_access_level: {
        type: "number",
        description: "group_list: filter groups by minimum access level (10=Guest, 20=Reporter, 30=Developer, 40=Maintainer, 50=Owner).",
      },
      assignee: {
        type: "string",
        description: "issue_list: filter by assignee username. mr_list: filter by assignee username.",
      },
      reviewer: {
        type: "string",
        description: "mr_list: filter by reviewer username.",
      },
      active: {
        type: "boolean",
        description: "user_list: filter active users only.",
      },
      blocked: {
        type: "boolean",
        description: "user_list: filter blocked users only.",
      },
      external: {
        type: "boolean",
        description: "user_list: filter external users only.",
      },
      query: {
        type: "string",
        description: "project_members/group_members: search query for members. Also used in namespace_list search.",
      },
    },
  },
};

module.exports = { GITLAB_CLIENT_SCHEMA };
