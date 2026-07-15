"use strict";

const LINEAR_CLIENT_SCHEMA = {
  name: "linear_client",
  description:
    "Zero-dependency Linear GraphQL API client (pure Node.js https built-ins; no npm deps). " +
    "Auth: API Key via 'api_key' (Authorization: <key>) or OAuth2 Bearer via 'access_token'. " +
    "Credentials never returned in output or errors. Base URL: https://api.linear.app/graphql. " +
    "42 operations: " +
    "Issues (issue_get, issue_list, issue_create, issue_update, issue_delete, issue_search, issue_archive, issue_assign, issue_set_state, issue_set_priority); " +
    "Projects (project_get, project_list, project_create, project_update, project_delete); " +
    "Teams (team_get, team_list, team_members, team_states); " +
    "Users (user_me, user_get, user_list, user_assigned_issues); " +
    "Cycles (cycle_get, cycle_list, cycle_issues, cycle_create); " +
    "Comments (comment_get, comment_list, comment_create, comment_update); " +
    "Labels (label_list, label_create, label_update); " +
    "Workflow States (state_list, state_create, state_update); " +
    "Organization (org_info, org_members, org_teams); " +
    "Generic (graphql, info). " +
    "Response capped at 10 MB; timeout 1-120 s (default 20 s).",
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        description:
          "Operation to perform. " +
          "Issues: issue_get, issue_list, issue_create, issue_update, issue_delete, issue_search, issue_archive, issue_assign, issue_set_state, issue_set_priority. " +
          "Projects: project_get, project_list, project_create, project_update, project_delete. " +
          "Teams: team_get, team_list, team_members, team_states. " +
          "Users: user_me, user_get, user_list, user_assigned_issues. " +
          "Cycles: cycle_get, cycle_list, cycle_issues, cycle_create. " +
          "Comments: comment_get, comment_list, comment_create, comment_update. " +
          "Labels: label_list, label_create, label_update. " +
          "Workflow States: state_list, state_create, state_update. " +
          "Org: org_info, org_members, org_teams. " +
          "Generic: graphql, info.",
        enum: [
          "issue_get", "issue_list", "issue_create", "issue_update", "issue_delete",
          "issue_search", "issue_archive", "issue_assign", "issue_set_state", "issue_set_priority",
          "project_get", "project_list", "project_create", "project_update", "project_delete",
          "team_get", "team_list", "team_members", "team_states",
          "user_me", "user_get", "user_list", "user_assigned_issues",
          "cycle_get", "cycle_list", "cycle_issues", "cycle_create",
          "comment_get", "comment_list", "comment_create", "comment_update",
          "label_list", "label_create", "label_update",
          "state_list", "state_create", "state_update",
          "org_info", "org_members", "org_teams",
          "graphql", "info",
        ],
      },

      // ─── Auth ──────────────────────────────────────────────────────────────��──
      api_key: {
        type: "string",
        description:
          "Linear API Key (from Settings → API → Personal API keys). " +
          "Sent as 'Authorization: <api_key>'. " +
          "Required when not using access_token. Never echoed in output.",
      },
      access_token: {
        type: "string",
        description:
          "OAuth2 Bearer access token. Sent as 'Authorization: Bearer <token>'. " +
          "Alternative to api_key; never echoed in output.",
      },

      // ─── Connection ──────────────────────────────────────────────────────────
      timeout: {
        type: "number",
        description: "Request timeout in milliseconds (1000-120000). Default: 20000.",
      },
      reject_unauthorized: {
        type: "boolean",
        description: "Reject TLS certificates that are invalid/self-signed (default: true). Set false only for dev.",
      },

      // ─── Issue fields ────────────────────────────────────────────────────────
      issue_id: {
        type: "string",
        description:
          "[issue_get, issue_update, issue_delete, issue_archive, issue_assign, " +
          "issue_set_state, issue_set_priority, comment_list, comment_create] " +
          "Linear Issue UUID or identifier (e.g. 'ENG-42' or UUID).",
      },
      title: {
        type: "string",
        description: "[issue_create, issue_update] Issue title. [issue_list] Filter by title substring.",
      },
      description: {
        type: "string",
        description: "[issue_create, issue_update, project_create, project_update] Markdown description.",
      },
      state_id: {
        type: "string",
        description:
          "[issue_create, issue_update, issue_set_state, issue_list] Workflow state UUID to assign/filter by.",
      },
      assignee_id: {
        type: "string",
        description: "[issue_create, issue_update, issue_list] Assignee user UUID.",
      },
      priority: {
        type: "number",
        description:
          "[issue_create, issue_update, issue_set_priority, issue_list] " +
          "Priority: 0=No priority, 1=Urgent, 2=High, 3=Medium, 4=Low.",
      },
      estimate: {
        type: "number",
        description: "[issue_create, issue_update] Story point estimate.",
      },
      label_ids: {
        type: "array",
        description: "[issue_create, issue_update] Array of label UUIDs to assign to the issue.",
        items: { type: "string" },
      },
      label_id: {
        type: "string",
        description: "[issue_list] Filter issues by label UUID.",
      },
      due_date: {
        type: "string",
        description: "[issue_create, issue_update] Due date as ISO 8601 date string (YYYY-MM-DD).",
      },
      parent_id: {
        type: "string",
        description: "[issue_create] Parent issue UUID for sub-issues.",
      },

      // ─── Project fields ──────────────────────────────────────────────────────
      project_id: {
        type: "string",
        description:
          "[project_get, project_update, project_delete, issue_create, issue_update, issue_list] " +
          "Linear Project UUID.",
      },
      status: {
        type: "string",
        description:
          "[project_create, project_update] Project status: planned, inProgress, paused, completed, cancelled.",
        enum: ["planned", "inProgress", "paused", "completed", "cancelled"],
      },
      lead_id: {
        type: "string",
        description: "[project_create, project_update] Project lead user UUID.",
      },
      team_ids: {
        type: "array",
        description: "[project_create] Array of team UUIDs associated with the project.",
        items: { type: "string" },
      },
      start_date: {
        type: "string",
        description: "[project_create, project_update, cycle_create] Start date as ISO 8601 (YYYY-MM-DD).",
      },
      target_date: {
        type: "string",
        description: "[project_create, project_update] Target/due date as ISO 8601 (YYYY-MM-DD).",
      },

      // ─── Team fields ──────────────────────────────────────────────────────────
      team_id: {
        type: "string",
        description:
          "[team_get, team_members, team_states, issue_create, issue_list, " +
          "cycle_list, label_list, label_create, state_list, state_create] " +
          "Linear Team UUID.",
      },

      // ─── User fields ─────────────────────────────────────────────────────────
      user_id: {
        type: "string",
        description:
          "[user_get, user_assigned_issues, issue_assign] Linear User UUID.",
      },

      // ─── Cycle fields ────────────────────────────────────────────────────────
      cycle_id: {
        type: "string",
        description: "[cycle_get, cycle_issues, issue_create, issue_list] Linear Cycle UUID.",
      },
      end_date: {
        type: "string",
        description: "[cycle_create] Cycle end date as ISO 8601 (YYYY-MM-DD).",
      },

      // ─── Comment fields ──────────────────────────────────────────────────────
      comment_id: {
        type: "string",
        description: "[comment_get, comment_update] Linear Comment UUID.",
      },
      body: {
        type: "string",
        description: "[comment_create, comment_update] Comment body in Markdown.",
      },

      // ─── Label fields ───────────────────────────────────────────────────────
      label_id: {
        type: "string",
        description: "[label_update, issue_list] Label UUID.",
      },
      name: {
        type: "string",
        description:
          "[label_create, label_update, state_create, state_update, cycle_create] " +
          "Name for the resource.",
      },
      color: {
        type: "string",
        description: "[label_create, label_update, state_create, state_update] Color as hex string (e.g. '#FF5733').",
      },

      // ─── Workflow State fields ───────────────────────────────────────────────
      state_type: {
        type: "string",
        description: "[state_create] Workflow state type: triage, backlog, unstarted, started, completed, cancelled.",
        enum: ["triage", "backlog", "unstarted", "started", "completed", "cancelled"],
      },

      // ─── Pagination & filtering ─────────────────────────────────────────────
      limit: {
        type: "number",
        description: "Maximum number of results to return (1-250). Default: 50.",
      },
      after: {
        type: "string",
        description: "Cursor for pagination — pass endCursor from previous pageInfo.",
      },
      order_by: {
        type: "string",
        description: "[issue_list] Sort order: updatedAt (default), createdAt.",
        enum: ["updatedAt", "createdAt"],
      },

      // ─── Generic GraphQL ────────────────────────────────────────────────────
      query: {
        type: "string",
        description:
          "[graphql, issue_search] " +
          "For 'graphql': raw GraphQL query/mutation string to execute against the Linear API. " +
          "For 'issue_search': search string to match against issue titles and descriptions.",
      },
      variables: {
        type: "object",
        description: "[graphql] Variables object for the raw GraphQL query.",
      },
    },
    required: ["operation"],
  },
};

module.exports = { LINEAR_CLIENT_SCHEMA };
