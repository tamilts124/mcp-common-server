"use strict";

const JIRA_CLIENT_SCHEMA = {
  name: "jira_client",
  description: "Zero-dependency Jira REST API v3 client — pure Node.js https built-ins; no npm deps. Supports Jira Cloud (https://<org>.atlassian.net) and Jira Server/Data Center. Auth: email + api_token (Basic Auth) or PAT/Bearer token; unauthenticated for public instances. 58 operations: Issues (issue_get, issue_create, issue_update, issue_delete, issue_assign, issue_transition, issue_transitions, issue_comment, issue_comments, issue_search, issue_bulk_create), Projects (project_get, project_list, project_create, project_delete, project_components, project_versions), Boards (board_list, board_get, board_sprints, board_issues), Sprints (sprint_get, sprint_create, sprint_update, sprint_issues), Users (user_get, user_search, user_me, user_assignable), Fields (field_list, field_search, field_create), Attachments (issue_attachments, attachment_get, attachment_delete), Watchers (issue_watchers, issue_add_watcher), Votes (issue_votes, issue_add_vote), label_list, Priorities (priority_list, priority_get), Issue Types (issuetype_list, issuetype_get), Worklogs (issue_worklog_list, issue_worklog_add, issue_worklog_delete), Links (issue_link, issue_link_get, issue_link_delete), Filters (filter_list, filter_get, filter_create), and generic authenticated request.",
  inputSchema: {
    type: "object",
    required: ["operation", "base_url"],
    properties: {
      operation: {
        type: "string",
        description: "Operation to perform. One of: issue_get, issue_create, issue_update, issue_delete, issue_assign, issue_transition, issue_transitions, issue_comment, issue_comments, issue_search, issue_bulk_create, project_get, project_list, project_create, project_delete, project_components, project_versions, board_list, board_get, board_sprints, board_issues, sprint_get, sprint_create, sprint_update, sprint_issues, user_get, user_search, user_me, user_assignable, field_list, field_search, field_create, issue_attachments, attachment_get, attachment_delete, issue_watchers, issue_add_watcher, issue_votes, issue_add_vote, label_list, priority_list, priority_get, issuetype_list, issuetype_get, issue_worklog_list, issue_worklog_add, issue_worklog_delete, issue_link, issue_link_get, issue_link_delete, filter_list, filter_get, filter_create, request, info.",
      },
      // ── Auth / Connection ────────────────────────────────────────────────
      base_url: {
        type: "string",
        description: "Jira base URL. For Cloud: 'https://yourorg.atlassian.net'. For Server: 'https://jira.yourcompany.com'. Required. Trailing slash is stripped automatically.",
      },
      email: {
        type: "string",
        description: "Atlassian account email. Required together with api_token for Cloud Basic Auth. Never returned in output or errors.",
      },
      api_token: {
        type: "string",
        description: "Atlassian API token. Generate at https://id.atlassian.com/manage-profile/security/api-tokens. Used with email for Basic Auth. Never returned in output or errors.",
      },
      pat: {
        type: "string",
        description: "Personal Access Token (Jira Server 8.14+) or OAuth2 Bearer token. Used as Authorization: Bearer <pat>. Alternative to email + api_token. Never returned in output or errors.",
      },
      timeout: {
        type: "number",
        description: "Request timeout in milliseconds (1000-120000, default: 20000).",
      },
      reject_unauthorized: {
        type: "boolean",
        description: "Whether to enforce TLS certificate verification (default: true). Set false only for self-signed certs in dev environments.",
      },
      // ── Issue fields ─────────────────────────────────────────────────────
      issue_key: {
        type: "string",
        description: "Jira issue key (e.g. 'PROJ-123'). Required for issue_get, issue_update, issue_delete, issue_assign, issue_transition, issue_transitions, issue_comment, issue_comments, issue_attachments, issue_watchers, issue_add_watcher, issue_votes, issue_add_vote, issue_worklog_list, issue_worklog_add, issue_worklog_delete.",
      },
      project_key: {
        type: "string",
        description: "Project key (e.g. 'PROJ'). Required for issue_create, project_get, project_delete, project_components, project_versions, project_create. Optional filter for user_assignable.",
      },
      summary: {
        type: "string",
        description: "Issue summary/title. Required for issue_create. Optional for issue_update.",
      },
      issuetype: {
        type: "string",
        description: "Issue type name (e.g. 'Bug', 'Task', 'Story', 'Epic'). Required for issue_create.",
      },
      description: {
        type: "string",
        description: "Issue description body. Used in issue_create, issue_update.",
      },
      priority: {
        type: "string",
        description: "Priority name (e.g. 'High', 'Medium', 'Low', 'Critical'). Used in issue_create, issue_update.",
      },
      assignee_id: {
        type: "string",
        description: "Assignee Atlassian account ID. Used in issue_create, issue_update, issue_assign. Pass null in issue_assign to unassign.",
      },
      labels: {
        type: "array",
        items: { type: "string" },
        description: "Array of label strings. Used in issue_create, issue_update.",
      },
      components: {
        type: "array",
        items: { type: "string" },
        description: "Array of component names. Used in issue_create, issue_update.",
      },
      fix_versions: {
        type: "array",
        items: { type: "string" },
        description: "Array of fix version names. Used in issue_create, issue_update.",
      },
      due_date: {
        type: "string",
        description: "Due date in YYYY-MM-DD format. Used in issue_create, issue_update.",
      },
      parent_key: {
        type: "string",
        description: "Parent issue key for subtask creation. Used in issue_create.",
      },
      delete_subtasks: {
        type: "boolean",
        description: "issue_delete: also delete subtasks (default: false).",
      },
      fields: {
        type: "array",
        items: { type: "string" },
        description: "Array of field names to include in issue_get or issue_search responses (e.g. ['summary','status','assignee']). Defaults to common fields.",
      },
      fields_extra: {
        type: "object",
        description: "issue_create / issue_update: additional field key-value pairs to merge into the fields object. issue_transition: fields to set during the transition.",
      },
      expand: {
        type: ["string", "array"],
        description: "issue_get / issue_search: expand options (e.g. 'renderedFields', 'changelog').",
      },
      // ── Search ───────────────────────────────────────────────────────────
      jql: {
        type: "string",
        description: "JQL query string. Required for issue_search. Optional for board_issues, sprint_issues. Example: 'project = PROJ AND status = Open ORDER BY created DESC'.",
      },
      // ── Transitions ──────────────────────────────────────────────────────
      transition_id: {
        type: ["string", "number"],
        description: "issue_transition: Jira transition ID. Use issue_transitions to list available transitions and their IDs.",
      },
      transition_name: {
        type: "string",
        description: "issue_transition: Transition name (case-insensitive) as alternative to transition_id. If both are provided, transition_id takes precedence.",
      },
      comment: {
        type: "string",
        description: "issue_transition: comment to add during transition. issue_comment: comment body text. issue_worklog_add: worklog comment.",
      },
      body: {
        type: "string",
        description: "issue_comment: comment body text. Required for issue_comment.",
      },
      // ── Projects ─────────────────────────────────────────────────────────
      name: {
        type: "string",
        description: "project_create: project name. sprint_create / sprint_update: sprint name. field_create: field name.",
      },
      project_type: {
        type: "string",
        description: "project_create: project type key (e.g. 'software', 'business', 'service_desk').",
      },
      lead_account_id: {
        type: "string",
        description: "project_create: Atlassian account ID of the project lead.",
      },
      assignee_type: {
        type: "string",
        description: "project_create: default assignee type — 'PROJECT_LEAD' or 'UNASSIGNED'.",
      },
      template_key: {
        type: "string",
        description: "project_create: project template key (e.g. 'com.pyxis.greenhopper.jira:gh-scrum-template').",
      },
      order_by: {
        type: "string",
        description: "project_list: sort order (e.g. 'name', '-name', 'lastIssueUpdatedDate'). project_versions: sort order.",
      },
      query: {
        type: "string",
        description: "project_list: filter projects by name/key text. user_search: search query string. field_search: filter fields by name.",
      },
      type_key: {
        type: "string",
        description: "project_list: filter by project type key ('software', 'business', 'service_desk').",
      },
      // ── Boards ───────────────────────────────────────────────────────────
      board_id: {
        type: ["number", "string"],
        description: "Board ID. Required for board_get, board_sprints, board_issues, sprint_create.",
      },
      project_key_or_id: {
        type: "string",
        description: "board_list: filter boards by project key or ID.",
      },
      type: {
        type: "string",
        description: "board_list: board type filter ('scrum', 'kanban', 'simple'). field_search: field type filter.",
      },
      state: {
        type: "string",
        description: "board_sprints: sprint state filter ('active', 'closed', 'future'). sprint_update: new sprint state.",
      },
      // ── Sprints ──────────────────────────────────────────────────────────
      sprint_id: {
        type: ["number", "string"],
        description: "Sprint ID. Required for sprint_get, sprint_update, sprint_issues.",
      },
      goal: {
        type: "string",
        description: "sprint_create / sprint_update: sprint goal description.",
      },
      start_date: {
        type: "string",
        description: "sprint_create / sprint_update: sprint start date (ISO 8601 format, e.g. '2025-01-15T09:00:00.000Z').",
      },
      end_date: {
        type: "string",
        description: "sprint_create / sprint_update: sprint end date (ISO 8601 format).",
      },
      // ── Users ────────────────────────────────────────────────────────────
      account_id: {
        type: "string",
        description: "Atlassian account ID. Required for user_get, issue_add_watcher.",
      },
      // ── Fields ───────────────────────────────────────────────────────────
      description: {
        type: "string",
        description: "Project/field/sprint description.",
      },
      searcher_key: {
        type: "string",
        description: "field_create: searcher key for the custom field (e.g. 'com.atlassian.jira.plugin.system.customfieldtypes:textsearcher').",
      },
      // ── Attachments ──────────────────────────────────────────────────────
      attachment_id: {
        type: "string",
        description: "Attachment ID. Required for attachment_get, attachment_delete.",
      },
      // ── Priorities / Issue Types ──────────────────────────────────────────
      priority_id: {
        type: "string",
        description: "Priority ID. Required for priority_get.",
      },
      issuetype_id: {
        type: "string",
        description: "Issue type ID. Required for issuetype_get.",
      },
      // ── Worklogs ─────────────────────────────────────────────────────────
      worklog_id: {
        type: "string",
        description: "Worklog ID. Required for issue_worklog_delete.",
      },
      time_spent: {
        type: "string",
        description: "issue_worklog_add: time spent in Jira duration format (e.g. '2h', '30m', '1d 4h'). Required.",
      },
      started: {
        type: "string",
        description: "issue_worklog_add: start date/time in ISO 8601 format (e.g. '2025-01-15T09:00:00.000+0000').",
      },
      // ── Issue Links ──────────────────────────────────────────────────────
      inward_key: {
        type: "string",
        description: "issue_link: key of the inward (source) issue (e.g. 'PROJ-123').",
      },
      outward_key: {
        type: "string",
        description: "issue_link: key of the outward (target) issue (e.g. 'PROJ-456').",
      },
      link_type: {
        type: "string",
        description: "issue_link: link type name (e.g. 'Blocks', 'Cloners', 'Duplicate', 'Relates').",
      },
      link_id: {
        type: "string",
        description: "Issue link ID. Required for issue_link_get, issue_link_delete.",
      },
      // ── Filters ──────────────────────────────────────────────────────────
      filter_id: {
        type: "string",
        description: "Filter ID. Required for filter_get.",
      },
      jql: {
        type: "string",
        description: "filter_create: JQL string for the filter.",
      },
      favourite: {
        type: "boolean",
        description: "filter_create: whether to mark the filter as a favourite.",
      },
      // ── Generic request ──────────────────────────────────────────────────
      api_path: {
        type: "string",
        description: "request: API path relative to the base API prefix (e.g. '/issue/PROJ-1/remotelink'). Must start with '/'.",
      },
      method: {
        type: "string",
        description: "request: HTTP method (GET, POST, PUT, PATCH, DELETE). Default: GET.",
      },
      use_agile: {
        type: "boolean",
        description: "request: if true, use the Agile API prefix (/rest/agile/1.0) instead of the standard API (/rest/api/3).",
      },
      // ── Pagination ───────────────────────────────────────────────────────
      max_results: {
        type: "number",
        description: "Maximum results per page (default varies by operation: 20 for most, 50 for project_list/board_list, 200 for label_list). Capped by Jira server limits.",
      },
      start_at: {
        type: "number",
        description: "0-based offset for pagination (default: 0). Use with max_results to page through results.",
      },
      // ── Bulk create ──────────────────────────────────────────────────────
      issues: {
        type: "array",
        items: {
          type: "object",
          required: ["project_key", "summary"],
          properties: {
            project_key: { type: "string" },
            summary:     { type: "string" },
            issuetype:   { type: "string" },
            description: { type: "string" },
            priority:    { type: "string" },
            assignee_id: { type: "string" },
            labels:      { type: "array", items: { type: "string" } },
          },
        },
        description: "issue_bulk_create: array of issue objects to create. Each requires project_key and summary.",
      },
    },
  },
};

module.exports = { JIRA_CLIENT_SCHEMA };
