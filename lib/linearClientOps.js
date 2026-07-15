"use strict";
/**
 * linear_client — Zero-dependency Linear GraphQL API client
 * (pure Node.js https built-ins; no npm deps)
 *
 * Authentication:
 *   - API Key via 'api_key' (Authorization: <api_key>)
 *   - OAuth2 Bearer token via 'access_token' (Authorization: Bearer <token>)
 *   Credentials never returned in output or errors.
 *
 * Base URL: https://api.linear.app/graphql
 *
 * Supported operations (42 total):
 *
 *   Issues (10):
 *     issue_get, issue_list, issue_create, issue_update, issue_delete,
 *     issue_search, issue_archive, issue_assign, issue_set_state, issue_set_priority
 *
 *   Projects (5):
 *     project_get, project_list, project_create, project_update, project_delete
 *
 *   Teams (4):
 *     team_get, team_list, team_members, team_states
 *
 *   Users (4):
 *     user_me, user_get, user_list, user_assigned_issues
 *
 *   Cycles (4):
 *     cycle_get, cycle_list, cycle_issues, cycle_create
 *
 *   Comments (4):
 *     comment_get, comment_list, comment_create, comment_update
 *
 *   Labels (3):
 *     label_list, label_create, label_update
 *
 *   Workflow States (3):
 *     state_list, state_create, state_update
 *
 *   Organization (3):
 *     org_info, org_members, org_teams
 *
 *   Generic (2):
 *     graphql, info
 *
 * Security:
 *   - Credentials never echoed in responses or error messages
 *   - All string inputs NUL-byte guarded
 *   - Response capped at 10 MB
 *   - Timeout clamped 1-120 s (default 20 s)
 */

const https = require("https");
const http  = require("http");

const LINEAR_BASE_URL = "https://api.linear.app/graphql";
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB

// ─── helpers ──────────────────────────────────────────────────────────────────

function nulGuard(val, name) {
  if (typeof val === "string" && val.includes("\0"))
    throw new Error(`${name} must not contain NUL bytes`);
}

function scrubCreds(msg, api_key, access_token) {
  let s = String(msg);
  if (api_key)      s = s.split(api_key).join("[REDACTED]");
  if (access_token) s = s.split(access_token).join("[REDACTED]");
  return s;
}

function buildAuthHeader(api_key, access_token) {
  if (access_token) return `Bearer ${access_token}`;
  if (api_key)      return api_key; // Linear API key is sent bare
  return null;
}

/**
 * Perform a GraphQL POST to Linear's API.
 */
async function linearGraphQL({ api_key, access_token, query, variables, timeout, reject_unauthorized }) {
  const authHeader = buildAuthHeader(api_key, access_token);
  if (!authHeader) throw new Error("Either 'api_key' or 'access_token' is required.");

  const body = JSON.stringify({ query, variables: variables || {} });
  const url  = new URL(LINEAR_BASE_URL);

  const options = {
    hostname: url.hostname,
    port: url.port || 443,
    path: url.pathname,
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Content-Length": Buffer.byteLength(body),
      "Authorization": authHeader,
    },
    timeout: Math.min(120000, Math.max(1000, (timeout || 20000))),
    rejectUnauthorized: reject_unauthorized !== false,
  };

  return new Promise((resolve, reject) => {
    const proto = url.protocol === "http:" ? http : https;
    const req = proto.request(options, (res) => {
      let raw = "";
      let bytes = 0;
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_RESPONSE_BYTES) {
          req.destroy();
          return reject(new Error("Response exceeded 10 MB limit"));
        }
        raw += chunk;
      });
      res.on("end", () => {
        let parsed;
        try { parsed = JSON.parse(raw); }
        catch (e) {
          return reject(new Error(
            scrubCreds(`Failed to parse Linear response (HTTP ${res.statusCode}): ${raw.slice(0, 200)}`, api_key, access_token)
          ));
        }
        if (res.statusCode >= 400) {
          const errMsg = parsed?.errors?.[0]?.message || parsed?.error || raw.slice(0, 300);
          return reject(new Error(
            scrubCreds(`Linear API error (HTTP ${res.statusCode}): ${errMsg}`, api_key, access_token)
          ));
        }
        if (parsed.errors?.length) {
          const errMsg = parsed.errors.map(e => e.message).join("; ");
          return reject(new Error(scrubCreds(`Linear GraphQL error: ${errMsg}`, api_key, access_token)));
        }
        resolve(parsed.data);
      });
    });
    req.on("timeout",  () => { req.destroy(); reject(new Error("Linear request timed out")); });
    req.on("error",    (e) => reject(new Error(scrubCreds(e.message, api_key, access_token))));
    req.write(body);
    req.end();
  });
}

// ─── query fragments ───────────────────────────────────────────────────────────

const ISSUE_FIELDS = `
  id identifier title description url priority priorityLabel
  estimate dueDate trashed canceledAt completedAt startedAt createdAt updatedAt
  state { id name type color }
  team { id name key }
  assignee { id name email displayName }
  creator { id name email displayName }
  labels { nodes { id name color } }
  project { id name }
  cycle { id number name }
  parent { id identifier title }
  comments { nodes { id body createdAt } }
`;

const PROJECT_FIELDS = `
  id name description url status startDate targetDate createdAt updatedAt
  teams { nodes { id name key } }
  members { nodes { id name email } }
  lead { id name email displayName }
`;

const TEAM_FIELDS = `
  id name key description timezone createdAt updatedAt
  members { nodes { id name email displayName } }
`;

const USER_FIELDS = `
  id name email displayName url avatarUrl active admin guest
  createdAt updatedAt
`;

const STATE_FIELDS = `
  id name type color position description team { id name key }
`;

const LABEL_FIELDS = `
  id name color description createdAt updatedAt
  team { id name key }
`;

const CYCLE_FIELDS = `
  id number name description startDate endDate createdAt updatedAt completedAt
  team { id name key }
  progress completedIssueCountHistory issueCountHistory
`;

const COMMENT_FIELDS = `
  id body url createdAt updatedAt
  user { id name email displayName }
  issue { id identifier title }
`;

// ─── operation handlers ────────────────────────────────────────────────────────

async function issue_get(args) {
  const q = `query IssueGet($id: String!) {
    issue(id: $id) { ${ISSUE_FIELDS} }
  }`;
  const data = await linearGraphQL({ ...args, query: q, variables: { id: args.issue_id } });
  return data.issue;
}

async function issue_list(args) {
  const filter = buildIssueFilter(args);
  const q = `query IssueList($filter: IssueFilter, $first: Int, $after: String, $orderBy: PaginationOrderBy) {
    issues(filter: $filter, first: $first, after: $after, orderBy: $orderBy) {
      pageInfo { hasNextPage endCursor }
      nodes { ${ISSUE_FIELDS} }
    }
  }`;
  const vars = {
    filter,
    first: Math.min(250, args.limit || 50),
    after: args.after || undefined,
    orderBy: args.order_by || "updatedAt",
  };
  const data = await linearGraphQL({ ...args, query: q, variables: vars });
  return data.issues;
}

async function issue_create(args) {
  const q = `mutation IssueCreate($input: IssueCreateInput!) {
    issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } }
  }`;
  const input = buildIssueInput(args);
  const data = await linearGraphQL({ ...args, query: q, variables: { input } });
  return data.issueCreate;
}

async function issue_update(args) {
  const q = `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) { success issue { ${ISSUE_FIELDS} } }
  }`;
  const input = buildIssueUpdateInput(args);
  const data = await linearGraphQL({ ...args, query: q, variables: { id: args.issue_id, input } });
  return data.issueUpdate;
}

async function issue_delete(args) {
  const q = `mutation IssueDelete($id: String!) {
    issueDelete(id: $id) { success }
  }`;
  const data = await linearGraphQL({ ...args, query: q, variables: { id: args.issue_id } });
  return data.issueDelete;
}

async function issue_search(args) {
  const q = `query IssueSearch($query: String!, $first: Int) {
    issueSearch(query: $query, first: $first) {
      pageInfo { hasNextPage endCursor }
      nodes { ${ISSUE_FIELDS} }
    }
  }`;
  const data = await linearGraphQL({
    ...args,
    query: q,
    variables: { query: args.query, first: Math.min(250, args.limit || 50) },
  });
  return data.issueSearch;
}

async function issue_archive(args) {
  const q = `mutation IssueArchive($id: String!) {
    issueArchive(id: $id) { success }
  }`;
  const data = await linearGraphQL({ ...args, query: q, variables: { id: args.issue_id } });
  return data.issueArchive;
}

async function issue_assign(args) {
  const q = `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) { success issue { id identifier title assignee { id name email } } }
  }`;
  const data = await linearGraphQL({
    ...args,
    query: q,
    variables: { id: args.issue_id, input: { assigneeId: args.user_id || null } },
  });
  return data.issueUpdate;
}

async function issue_set_state(args) {
  const q = `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) { success issue { id identifier title state { id name type } } }
  }`;
  const data = await linearGraphQL({
    ...args,
    query: q,
    variables: { id: args.issue_id, input: { stateId: args.state_id } },
  });
  return data.issueUpdate;
}

async function issue_set_priority(args) {
  const priority = args.priority;
  if (![0, 1, 2, 3, 4].includes(priority))
    throw new Error("priority must be 0 (No priority), 1 (Urgent), 2 (High), 3 (Medium), or 4 (Low)");
  const q = `mutation IssueUpdate($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) { success issue { id identifier title priority priorityLabel } }
  }`;
  const data = await linearGraphQL({
    ...args,
    query: q,
    variables: { id: args.issue_id, input: { priority } },
  });
  return data.issueUpdate;
}

async function project_get(args) {
  const q = `query ProjectGet($id: String!) {
    project(id: $id) { ${PROJECT_FIELDS} }
  }`;
  const data = await linearGraphQL({ ...args, query: q, variables: { id: args.project_id } });
  return data.project;
}

async function project_list(args) {
  const q = `query ProjectList($first: Int, $after: String) {
    projects(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { ${PROJECT_FIELDS} }
    }
  }`;
  const data = await linearGraphQL({
    ...args,
    query: q,
    variables: { first: Math.min(250, args.limit || 50), after: args.after || undefined },
  });
  return data.projects;
}

async function project_create(args) {
  const q = `mutation ProjectCreate($input: ProjectCreateInput!) {
    projectCreate(input: $input) { success project { ${PROJECT_FIELDS} } }
  }`;
  const input = {};
  if (args.name)        input.name        = args.name;
  if (args.team_ids)    input.teamIds     = args.team_ids;
  if (args.description) input.description = args.description;
  if (args.status)      input.status      = args.status;
  if (args.lead_id)     input.leadId      = args.lead_id;
  if (args.start_date)  input.startDate   = args.start_date;
  if (args.target_date) input.targetDate  = args.target_date;
  const data = await linearGraphQL({ ...args, query: q, variables: { input } });
  return data.projectCreate;
}

async function project_update(args) {
  const q = `mutation ProjectUpdate($id: String!, $input: ProjectUpdateInput!) {
    projectUpdate(id: $id, input: $input) { success project { ${PROJECT_FIELDS} } }
  }`;
  const input = {};
  if (args.name        !== undefined) input.name        = args.name;
  if (args.description !== undefined) input.description = args.description;
  if (args.status      !== undefined) input.status      = args.status;
  if (args.lead_id     !== undefined) input.leadId      = args.lead_id;
  if (args.start_date  !== undefined) input.startDate   = args.start_date;
  if (args.target_date !== undefined) input.targetDate  = args.target_date;
  const data = await linearGraphQL({ ...args, query: q, variables: { id: args.project_id, input } });
  return data.projectUpdate;
}

async function project_delete(args) {
  const q = `mutation ProjectDelete($id: String!) {
    projectDelete(id: $id) { success }
  }`;
  const data = await linearGraphQL({ ...args, query: q, variables: { id: args.project_id } });
  return data.projectDelete;
}

async function team_get(args) {
  const q = `query TeamGet($id: String!) {
    team(id: $id) { ${TEAM_FIELDS} }
  }`;
  const data = await linearGraphQL({ ...args, query: q, variables: { id: args.team_id } });
  return data.team;
}

async function team_list(args) {
  const q = `query TeamList($first: Int) {
    teams(first: $first) {
      pageInfo { hasNextPage endCursor }
      nodes { ${TEAM_FIELDS} }
    }
  }`;
  const data = await linearGraphQL({ ...args, query: q, variables: { first: Math.min(250, args.limit || 50) } });
  return data.teams;
}

async function team_members(args) {
  const q = `query TeamMembers($id: String!, $first: Int) {
    team(id: $id) { members(first: $first) { nodes { ${USER_FIELDS} } } }
  }`;
  const data = await linearGraphQL({ ...args, query: q, variables: { id: args.team_id, first: Math.min(250, args.limit || 100) } });
  return data.team?.members;
}

async function team_states(args) {
  const q = `query TeamStates($id: String!) {
    team(id: $id) { states { nodes { ${STATE_FIELDS} } } }
  }`;
  const data = await linearGraphQL({ ...args, query: q, variables: { id: args.team_id } });
  return data.team?.states;
}

async function user_me(args) {
  const q = `query UserMe { viewer { ${USER_FIELDS} } }`;
  const data = await linearGraphQL({ ...args, query: q });
  return data.viewer;
}

async function user_get(args) {
  const q = `query UserGet($id: String!) { user(id: $id) { ${USER_FIELDS} } }`;
  const data = await linearGraphQL({ ...args, query: q, variables: { id: args.user_id } });
  return data.user;
}

async function user_list(args) {
  const q = `query UserList($first: Int) {
    users(first: $first) { nodes { ${USER_FIELDS} } }
  }`;
  const data = await linearGraphQL({ ...args, query: q, variables: { first: Math.min(250, args.limit || 50) } });
  return data.users;
}

async function user_assigned_issues(args) {
  const q = `query UserAssignedIssues($id: String!, $first: Int) {
    user(id: $id) { assignedIssues(first: $first) { nodes { ${ISSUE_FIELDS} } } }
  }`;
  const data = await linearGraphQL({ ...args, query: q, variables: { id: args.user_id, first: Math.min(250, args.limit || 50) } });
  return data.user?.assignedIssues;
}

async function cycle_get(args) {
  const q = `query CycleGet($id: String!) { cycle(id: $id) { ${CYCLE_FIELDS} } }`;
  const data = await linearGraphQL({ ...args, query: q, variables: { id: args.cycle_id } });
  return data.cycle;
}

async function cycle_list(args) {
  const q = `query CycleList($teamId: ID!, $first: Int) {
    team(id: $teamId) { cycles(first: $first) { nodes { ${CYCLE_FIELDS} } } }
  }`;
  const data = await linearGraphQL({ ...args, query: q, variables: { teamId: args.team_id, first: Math.min(250, args.limit || 50) } });
  return data.team?.cycles;
}

async function cycle_issues(args) {
  const q = `query CycleIssues($id: String!, $first: Int) {
    cycle(id: $id) { issues(first: $first) { nodes { ${ISSUE_FIELDS} } } }
  }`;
  const data = await linearGraphQL({ ...args, query: q, variables: { id: args.cycle_id, first: Math.min(250, args.limit || 50) } });
  return data.cycle?.issues;
}

async function cycle_create(args) {
  const q = `mutation CycleCreate($input: CycleCreateInput!) {
    cycleCreate(input: $input) { success cycle { ${CYCLE_FIELDS} } }
  }`;
  const input = { teamId: args.team_id };
  if (args.name)       input.name      = args.name;
  if (args.start_date) input.startsAt  = args.start_date;
  if (args.end_date)   input.endsAt    = args.end_date;
  const data = await linearGraphQL({ ...args, query: q, variables: { input } });
  return data.cycleCreate;
}

async function comment_get(args) {
  const q = `query CommentGet($id: String!) { comment(id: $id) { ${COMMENT_FIELDS} } }`;
  const data = await linearGraphQL({ ...args, query: q, variables: { id: args.comment_id } });
  return data.comment;
}

async function comment_list(args) {
  const q = `query CommentList($issueId: String!, $first: Int) {
    issue(id: $issueId) { comments(first: $first) { nodes { ${COMMENT_FIELDS} } } }
  }`;
  const data = await linearGraphQL({ ...args, query: q, variables: { issueId: args.issue_id, first: Math.min(250, args.limit || 50) } });
  return data.issue?.comments;
}

async function comment_create(args) {
  const q = `mutation CommentCreate($input: CommentCreateInput!) {
    commentCreate(input: $input) { success comment { ${COMMENT_FIELDS} } }
  }`;
  const data = await linearGraphQL({
    ...args,
    query: q,
    variables: { input: { issueId: args.issue_id, body: args.body } },
  });
  return data.commentCreate;
}

async function comment_update(args) {
  const q = `mutation CommentUpdate($id: String!, $input: CommentUpdateInput!) {
    commentUpdate(id: $id, input: $input) { success comment { ${COMMENT_FIELDS} } }
  }`;
  const data = await linearGraphQL({
    ...args,
    query: q,
    variables: { id: args.comment_id, input: { body: args.body } },
  });
  return data.commentUpdate;
}

async function label_list(args) {
  const filter = args.team_id ? `(filter: { team: { id: { eq: "${args.team_id}" } } })` : "";
  const q = `query LabelList {
    issueLabels${filter} { nodes { ${LABEL_FIELDS} } }
  }`;
  const data = await linearGraphQL({ ...args, query: q });
  return data.issueLabels;
}

async function label_create(args) {
  const q = `mutation LabelCreate($input: IssueLabelCreateInput!) {
    issueLabelCreate(input: $input) { success issueLabel { ${LABEL_FIELDS} } }
  }`;
  const input = { name: args.name, teamId: args.team_id };
  if (args.color)       input.color       = args.color;
  if (args.description) input.description = args.description;
  const data = await linearGraphQL({ ...args, query: q, variables: { input } });
  return data.issueLabelCreate;
}

async function label_update(args) {
  const q = `mutation LabelUpdate($id: String!, $input: IssueLabelUpdateInput!) {
    issueLabelUpdate(id: $id, input: $input) { success issueLabel { ${LABEL_FIELDS} } }
  }`;
  const input = {};
  if (args.name        !== undefined) input.name        = args.name;
  if (args.color       !== undefined) input.color       = args.color;
  if (args.description !== undefined) input.description = args.description;
  const data = await linearGraphQL({ ...args, query: q, variables: { id: args.label_id, input } });
  return data.issueLabelUpdate;
}

async function state_list(args) {
  const q = `query StateList($teamId: ID!, $first: Int) {
    team(id: $teamId) { states(first: $first) { nodes { ${STATE_FIELDS} } } }
  }`;
  const data = await linearGraphQL({ ...args, query: q, variables: { teamId: args.team_id, first: 250 } });
  return data.team?.states;
}

async function state_create(args) {
  const q = `mutation StateCreate($input: WorkflowStateCreateInput!) {
    workflowStateCreate(input: $input) { success workflowState { ${STATE_FIELDS} } }
  }`;
  const input = { name: args.name, teamId: args.team_id, type: args.state_type || "started", color: args.color || "#6b6f76" };
  if (args.description) input.description = args.description;
  const data = await linearGraphQL({ ...args, query: q, variables: { input } });
  return data.workflowStateCreate;
}

async function state_update(args) {
  const q = `mutation StateUpdate($id: String!, $input: WorkflowStateUpdateInput!) {
    workflowStateUpdate(id: $id, input: $input) { success workflowState { ${STATE_FIELDS} } }
  }`;
  const input = {};
  if (args.name        !== undefined) input.name        = args.name;
  if (args.color       !== undefined) input.color       = args.color;
  if (args.description !== undefined) input.description = args.description;
  const data = await linearGraphQL({ ...args, query: q, variables: { id: args.state_id, input } });
  return data.workflowStateUpdate;
}

async function org_info(args) {
  const q = `query OrgInfo {
    organization {
      id name urlKey createdAt updatedAt logoUrl
      subscription { type seats }
    }
  }`;
  const data = await linearGraphQL({ ...args, query: q });
  return data.organization;
}

async function org_members(args) {
  const q = `query OrgMembers($first: Int) {
    users(first: $first) { nodes { ${USER_FIELDS} } }
  }`;
  const data = await linearGraphQL({ ...args, query: q, variables: { first: Math.min(250, args.limit || 50) } });
  return data.users;
}

async function org_teams(args) {
  const q = `query OrgTeams($first: Int) {
    teams(first: $first) { nodes { id name key description } }
  }`;
  const data = await linearGraphQL({ ...args, query: q, variables: { first: Math.min(250, args.limit || 50) } });
  return data.teams;
}

async function op_graphql(args) {
  if (!args.query) throw new Error("'query' (GraphQL query string) is required for 'graphql' operation");
  const data = await linearGraphQL({ ...args, variables: args.variables || {} });
  return data;
}

async function op_info(args) {
  const q = `query Info {
    viewer { id name email displayName }
    organization { id name urlKey }
  }`;
  const data = await linearGraphQL({ ...args, query: q });
  return { viewer: data.viewer, organization: data.organization, api: "Linear GraphQL API v2" };
}

// ─── input builders ────────────────────────────────────────────────────────────

function buildIssueFilter(args) {
  const filter = {};
  if (args.team_id)   filter.team       = { id: { eq: args.team_id } };
  if (args.state_id)  filter.state      = { id: { eq: args.state_id } };
  if (args.assignee_id) filter.assignee = { id: { eq: args.assignee_id } };
  if (args.project_id)  filter.project  = { id: { eq: args.project_id } };
  if (args.label_id)    filter.labels   = { id: { eq: args.label_id } };
  if (args.cycle_id)    filter.cycle    = { id: { eq: args.cycle_id } };
  if (args.priority !== undefined) filter.priority = { eq: args.priority };
  if (args.title)       filter.title    = { containsIgnoreCase: args.title };
  return Object.keys(filter).length ? filter : undefined;
}

function buildIssueInput(args) {
  const input = {};
  if (!args.team_id) throw new Error("'team_id' is required for issue_create");
  input.teamId = args.team_id;
  if (args.title)        input.title       = args.title;
  if (args.description)  input.description = args.description;
  if (args.state_id)     input.stateId     = args.state_id;
  if (args.assignee_id)  input.assigneeId  = args.assignee_id;
  if (args.priority !== undefined) input.priority = args.priority;
  if (args.estimate !== undefined) input.estimate = args.estimate;
  if (args.label_ids)    input.labelIds    = args.label_ids;
  if (args.project_id)   input.projectId   = args.project_id;
  if (args.due_date)     input.dueDate     = args.due_date;
  if (args.cycle_id)     input.cycleId     = args.cycle_id;
  if (args.parent_id)    input.parentId    = args.parent_id;
  return input;
}

function buildIssueUpdateInput(args) {
  const input = {};
  if (args.title        !== undefined) input.title       = args.title;
  if (args.description  !== undefined) input.description = args.description;
  if (args.state_id     !== undefined) input.stateId     = args.state_id;
  if (args.assignee_id  !== undefined) input.assigneeId  = args.assignee_id;
  if (args.priority     !== undefined) input.priority    = args.priority;
  if (args.estimate     !== undefined) input.estimate    = args.estimate;
  if (args.label_ids    !== undefined) input.labelIds    = args.label_ids;
  if (args.project_id   !== undefined) input.projectId   = args.project_id;
  if (args.due_date     !== undefined) input.dueDate     = args.due_date;
  if (args.cycle_id     !== undefined) input.cycleId     = args.cycle_id;
  return input;
}

// ─── main dispatcher ───────────────────────────────────────────────────────────

const OPERATIONS = {
  // Issues
  issue_get, issue_list, issue_create, issue_update, issue_delete,
  issue_search, issue_archive, issue_assign, issue_set_state, issue_set_priority,
  // Projects
  project_get, project_list, project_create, project_update, project_delete,
  // Teams
  team_get, team_list, team_members, team_states,
  // Users
  user_me, user_get, user_list, user_assigned_issues,
  // Cycles
  cycle_get, cycle_list, cycle_issues, cycle_create,
  // Comments
  comment_get, comment_list, comment_create, comment_update,
  // Labels
  label_list, label_create, label_update,
  // States
  state_list, state_create, state_update,
  // Org
  org_info, org_members, org_teams,
  // Generic
  graphql: op_graphql,
  info: op_info,
};

async function linearClient(args) {
  const { operation, api_key, access_token } = args;
  if (!operation) throw new Error("'operation' is required");

  // NUL guards
  ["api_key", "access_token", "team_id", "issue_id", "project_id", "user_id",
   "state_id", "cycle_id", "comment_id", "label_id", "query", "title",
   "description", "body", "name"].forEach(k => {
    if (args[k] !== undefined) nulGuard(args[k], k);
  });

  const handler = OPERATIONS[operation];
  if (!handler) throw new Error(`Unknown operation: '${operation}'. Valid operations: ${Object.keys(OPERATIONS).join(", ")}`);

  try {
    const result = await handler(args);
    return { operation, result };
  } catch (err) {
    throw new Error(scrubCreds(err.message, api_key, access_token));
  }
}

module.exports = { linearClient };
