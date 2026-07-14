"use strict";
/**
 * gitlab_client — Zero-dependency GitLab REST API v4 client
 * (pure Node.js https built-ins; no npm deps)
 *
 * Authentication: Personal Access Token (PAT), OAuth2 token, or
 *   Project/Group Access Token via 'token' field.
 *   Unauthenticated access is allowed for public resources.
 *
 * Base URL: https://gitlab.com/api/v4  (override with base_url for self-hosted)
 * API version: v4 (GitLab REST API)
 *
 * Supported operations (68 total):
 *
 *   Projects (7):
 *     project_get, project_list, project_create, project_delete,
 *     project_fork, project_members, project_search
 *
 *   Issues (7):
 *     issue_list, issue_get, issue_create, issue_update, issue_close,
 *     issue_comment, issue_comments
 *
 *   Merge Requests (8):
 *     mr_list, mr_get, mr_create, mr_merge, mr_update,
 *     mr_notes, mr_add_note, mr_changes
 *
 *   Repository / Contents (5):
 *     file_get, file_create, file_update, file_delete, tree_list
 *
 *   Branches (6):
 *     branch_list, branch_get, branch_create, branch_delete,
 *     branch_protect, branch_unprotect
 *
 *   Commits (4):
 *     commit_list, commit_get, commit_diff, commit_statuses
 *
 *   Tags / Releases (7):
 *     tag_list, tag_get, tag_create, tag_delete,
 *     release_list, release_get, release_create
 *
 *   Pipelines / CI/CD (8):
 *     pipeline_list, pipeline_get, pipeline_create, pipeline_cancel,
 *     pipeline_retry, pipeline_jobs, job_get, job_log
 *
 *   Users (3): user_get, user_me, user_list
 *   Groups (4): group_get, group_list, group_projects, group_members
 *   Namespaces (1): namespace_list
 *   Labels (2): label_list, label_create
 *   Milestones (3): milestone_list, milestone_get, milestone_create
 *   Snippets (3): snippet_list, snippet_get, snippet_create
 *   Generic (2): request, info
 *
 * Security:
 *   NUL-byte guards on all string inputs.
 *   Timeout clamped 1000-120000 ms.
 *   Tokens never returned in output or errors.
 *   16 MB response cap.
 *   TLS enforced by default (rejectUnauthorized: true).
 */

const https = require("https");
const http  = require("http");

// -- Constants ---------------------------------------------------------------

const DEFAULT_TIMEOUT_MS  = 20000;
const MAX_RESPONSE_BYTES  = 16 * 1024 * 1024; // 16 MB
const GITLAB_API_BASE     = "https://gitlab.com/api/v4";

// -- Guard helpers -----------------------------------------------------------

function requireString(val, name) {
  if (typeof val !== "string" || val.length === 0)
    throw new Error(`${name} must be a non-empty string`);
  if (val.includes("\0"))
    throw new Error(`${name} must not contain NUL bytes`);
}

function guardString(val, name) {
  if (val !== undefined && val !== null) {
    if (typeof val !== "string") throw new Error(`${name} must be a string`);
    if (val.includes("\0"))     throw new Error(`${name} must not contain NUL bytes`);
  }
}

function clampInt(val, def, min, max) {
  if (val === undefined || val === null) return def;
  const n = Number(val);
  if (!Number.isFinite(n)) throw new Error(`must be a finite number`);
  return Math.min(max, Math.max(min, Math.round(n)));
}

// -- Low-level HTTP helper ---------------------------------------------------

function glRequest(opts) {
  const { url, method, headers, body, timeoutMs, rejectUnauthorized } = opts;
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const isHttps = parsed.protocol === "https:";
    const transport = isHttps ? https : http;
    const bodyBuf = body
      ? (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), "utf8"))
      : null;

    const reqOpts = {
      hostname:           parsed.hostname,
      port:               parsed.port || (isHttps ? 443 : 80),
      path:               parsed.pathname + (parsed.search || ""),
      method:             (method || "GET").toUpperCase(),
      headers:            { ...headers },
      rejectUnauthorized: rejectUnauthorized !== false,
      servername:         parsed.hostname,
    };
    if (bodyBuf) {
      reqOpts.headers["Content-Length"] = bodyBuf.length;
      reqOpts.headers["Content-Type"]   = "application/json";
    }

    const chunks    = [];
    let totalBytes  = 0;
    let settled     = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new Error(`GitLab request ${method} ${url} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const req = transport.request(reqOpts, (res) => {
      res.on("data", (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          req.destroy();
          reject(new Error("GitLab response exceeded 16 MB cap"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          statusCode: res.statusCode,
          headers:    res.headers,
          raw:        Buffer.concat(chunks).toString("utf8"),
        });
      });
      res.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`GitLab response stream error: ${err.message}`));
      });
    });

    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Cannot connect to GitLab API: ${err.message}`));
    });

    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

// -- Connection helper -------------------------------------------------------

function buildConn(args) {
  guardString(args.token,    "token");
  guardString(args.base_url, "base_url");
  const timeoutMs          = clampInt(args.timeout, DEFAULT_TIMEOUT_MS, 1000, 120000);
  const baseUrl            = (args.base_url || GITLAB_API_BASE).replace(/\/$/, "");
  const rejectUnauthorized = args.reject_unauthorized !== false;
  return { token: args.token || null, baseUrl, timeoutMs, rejectUnauthorized };
}

async function glApiRequest(conn, opts) {
  const { path, method, body } = opts;
  const url     = `${conn.baseUrl}${path}`;
  const headers = {
    "Accept":     "application/json",
    "User-Agent": "mcp-common-server/gitlab_client",
  };
  if (conn.token) {
    headers["PRIVATE-TOKEN"] = conn.token;
  }
  return glRequest({ url, method: method || "GET", headers, body, timeoutMs: conn.timeoutMs, rejectUnauthorized: conn.rejectUnauthorized });
}

function parseGlJson(raw, ctx) {
  if (!raw || raw.trim() === "") return null;
  try { return JSON.parse(raw); } catch (_) {
    throw new Error(`GitLab: invalid JSON response (${ctx}): ${raw.slice(0, 200)}`);
  }
}

function checkGlStatus(res, ctx) {
  if (res.statusCode < 200 || res.statusCode >= 300) {
    let extra = "";
    try {
      const j = JSON.parse(res.raw);
      extra = j.message || j.error_description || j.error || JSON.stringify(j).slice(0, 300);
    } catch (_) { extra = res.raw.slice(0, 300); }
    throw new Error(`GitLab ${ctx}: HTTP ${res.statusCode} -- ${extra}`);
  }
}

function buildQs(params) {
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

function enc(s) { return encodeURIComponent(s); }
function encPath(s) {
  return s.split("/").map(seg => encodeURIComponent(seg)).join("/");
}

// GitLab accepts numeric ID or "namespace/project" (URL-encoded)
function projId(args) {
  if (args.project_id != null) return enc(String(args.project_id));
  if (args.project)            return enc(args.project);
  throw new Error("project_id (numeric) or project ('namespace/name') is required");
}

// -- Map helpers ------------------------------------------------------------

function mapProject(p) {
  if (!p) return {};
  return {
    id:                p.id,
    name:              p.name,
    name_with_namespace: p.name_with_namespace || null,
    path:              p.path              || null,
    path_with_namespace: p.path_with_namespace || null,
    description:       p.description       || null,
    visibility:        p.visibility        || null,
    namespace:         p.namespace ? p.namespace.full_path : null,
    default_branch:    p.default_branch    || null,
    ssh_url:           p.ssh_url_to_repo   || null,
    http_url:          p.http_url_to_repo  || null,
    web_url:           p.web_url           || null,
    forks_count:       p.forks_count       || 0,
    star_count:        p.star_count        || 0,
    open_issues_count: p.open_issues_count || 0,
    archived:          p.archived          || false,
    topics:            p.topics            || [],
    created_at:        p.created_at        || null,
    last_activity_at:  p.last_activity_at  || null,
  };
}

function mapIssue(i) {
  if (!i) return {};
  return {
    id:           i.id,
    iid:          i.iid,
    title:        i.title,
    description:  i.description   || null,
    state:        i.state,
    author:       i.author ? i.author.username : null,
    assignees:    (i.assignees || []).map(function(a) { return a.username; }),
    labels:       i.labels        || [],
    milestone:    i.milestone ? i.milestone.title : null,
    confidential: i.confidential  || false,
    web_url:      i.web_url       || null,
    created_at:   i.created_at    || null,
    updated_at:   i.updated_at    || null,
    closed_at:    i.closed_at     || null,
  };
}

function mapMr(m) {
  if (!m) return {};
  return {
    id:            m.id,
    iid:           m.iid,
    title:         m.title,
    description:   m.description    || null,
    state:         m.state,
    author:        m.author ? m.author.username : null,
    assignees:     (m.assignees || []).map(function(a) { return a.username; }),
    reviewers:     (m.reviewers || []).map(function(r) { return r.username; }),
    labels:        m.labels         || [],
    source_branch: m.source_branch  || null,
    target_branch: m.target_branch  || null,
    sha:           m.sha            || null,
    merge_status:  m.merge_status   || null,
    draft:         m.draft          || false,
    merged_by:     m.merged_by ? m.merged_by.username : null,
    merged_at:     m.merged_at      || null,
    web_url:       m.web_url        || null,
    changes_count: m.changes_count  || null,
    created_at:    m.created_at     || null,
    updated_at:    m.updated_at     || null,
    closed_at:     m.closed_at      || null,
  };
}

function mapCommit(c) {
  if (!c) return {};
  return {
    id:              c.id,
    short_id:        c.short_id       || null,
    title:           c.title          || null,
    message:         c.message        || null,
    author_name:     c.author_name    || null,
    author_email:    c.author_email   || null,
    authored_date:   c.authored_date  || null,
    committer_name:  c.committer_name || null,
    committer_email: c.committer_email || null,
    committed_date:  c.committed_date || null,
    parent_ids:      c.parent_ids     || [],
    web_url:         c.web_url        || null,
  };
}

function mapPipeline(p) {
  if (!p) return {};
  return {
    id:          p.id,
    iid:         p.iid        || null,
    status:      p.status,
    ref:         p.ref        || null,
    sha:         p.sha        || null,
    source:      p.source     || null,
    created_at:  p.created_at || null,
    updated_at:  p.updated_at || null,
    started_at:  p.started_at || null,
    finished_at: p.finished_at|| null,
    duration:    p.duration   || null,
    web_url:     p.web_url    || null,
  };
}

function mapJob(j) {
  if (!j) return {};
  return {
    id:            j.id,
    name:          j.name        || null,
    status:        j.status,
    stage:         j.stage       || null,
    ref:           j.ref         || null,
    tag:           j.tag         || false,
    allow_failure: j.allow_failure || false,
    started_at:    j.started_at  || null,
    finished_at:   j.finished_at || null,
    duration:      j.duration    || null,
    pipeline:      j.pipeline    ? { id: j.pipeline.id, status: j.pipeline.status } : null,
    web_url:       j.web_url     || null,
    runner:        j.runner      ? { id: j.runner.id, name: j.runner.name } : null,
  };
}

function mapUser(u) {
  if (!u) return {};
  return {
    id:          u.id,
    username:    u.username,
    name:        u.name        || null,
    state:       u.state       || null,
    email:       u.email       || null,
    bio:         u.bio         || null,
    location:    u.location    || null,
    website_url: u.website_url || null,
    avatar_url:  u.avatar_url  || null,
    web_url:     u.web_url     || null,
    created_at:  u.created_at  || null,
    is_admin:    u.is_admin    || false,
  };
}

function mapGroup(g) {
  if (!g) return {};
  return {
    id:          g.id,
    name:        g.name,
    path:        g.path        || null,
    full_path:   g.full_path   || null,
    description: g.description || null,
    visibility:  g.visibility  || null,
    full_name:   g.full_name   || null,
    parent_id:   g.parent_id   || null,
    web_url:     g.web_url     || null,
    created_at:  g.created_at  || null,
  };
}

// -- Project Operations -----------------------------------------------------

async function opProjectGet(args, conn) {
  const res = await glApiRequest(conn, { path: `/projects/${projId(args)}` });
  if (res.statusCode === 404) return { ok: true, operation: "project_get", exists: false };
  checkGlStatus(res, "project_get");
  const j = parseGlJson(res.raw, "project_get");
  return { ok: true, operation: "project_get", exists: true, ...mapProject(j) };
}

async function opProjectList(args, conn) {
  const qs = buildQs({
    membership:   args.membership   || undefined,
    owned:        args.owned        || undefined,
    visibility:   args.visibility   || undefined,
    search:       args.search       || undefined,
    order_by:     args.order_by     || "updated_at",
    sort:         args.sort         || "desc",
    per_page:     clampInt(args.per_page, 20, 1, 100),
    page:         args.page         || 1,
    simple:       true,
  });
  const res = await glApiRequest(conn, { path: `/projects${qs}` });
  checkGlStatus(res, "project_list");
  const j = parseGlJson(res.raw, "project_list");
  return { ok: true, operation: "project_list", count: (j || []).length, projects: (j || []).map(mapProject) };
}

async function opProjectCreate(args, conn) {
  requireString(args.name, "name");
  const body = {
    name:        args.name,
    description: args.description  || undefined,
    visibility:  args.visibility   || "private",
    namespace_id:args.namespace_id || undefined,
    initialize_with_readme: args.initialize_with_readme || false,
  };
  if (args.path_) body.path = args.path_;
  if (args.default_branch) body.default_branch = args.default_branch;
  const res = await glApiRequest(conn, { path: "/projects", method: "POST", body });
  checkGlStatus(res, "project_create");
  const j = parseGlJson(res.raw, "project_create");
  return { ok: true, operation: "project_create", created: true, ...mapProject(j) };
}

async function opProjectDelete(args, conn) {
  const res = await glApiRequest(conn, { path: `/projects/${projId(args)}`, method: "DELETE" });
  if (res.statusCode === 404) return { ok: true, operation: "project_delete", deleted: false, reason: "not_found" };
  checkGlStatus(res, "project_delete");
  return { ok: true, operation: "project_delete", deleted: true };
}

async function opProjectFork(args, conn) {
  const body = {};
  if (args.namespace)   body.namespace   = args.namespace;
  if (args.name)        body.name        = args.name;
  if (args.path_)       body.path        = args.path_;
  if (args.description) body.description = args.description;
  if (args.visibility)  body.visibility  = args.visibility;
  const res = await glApiRequest(conn, { path: `/projects/${projId(args)}/fork`, method: "POST", body });
  checkGlStatus(res, "project_fork");
  const j = parseGlJson(res.raw, "project_fork");
  return { ok: true, operation: "project_fork", forked: true, ...mapProject(j) };
}

async function opProjectMembers(args, conn) {
  const qs = buildQs({ per_page: clampInt(args.per_page, 20, 1, 100), page: args.page || 1, query: args.query || undefined });
  const res = await glApiRequest(conn, { path: `/projects/${projId(args)}/members${qs}` });
  checkGlStatus(res, "project_members");
  const j = parseGlJson(res.raw, "project_members");
  return {
    ok: true, operation: "project_members", count: (j || []).length,
    members: (j || []).map(function(m) { return { id: m.id, username: m.username, name: m.name, access_level: m.access_level, state: m.state }; }),
  };
}

async function opProjectSearch(args, conn) {
  requireString(args.search, "search");
  const qs = buildQs({
    search:   args.search,
    per_page: clampInt(args.per_page, 20, 1, 100),
    page:     args.page || 1,
    simple:   true,
  });
  const res = await glApiRequest(conn, { path: `/projects${qs}` });
  checkGlStatus(res, "project_search");
  const j = parseGlJson(res.raw, "project_search");
  return { ok: true, operation: "project_search", count: (j || []).length, projects: (j || []).map(mapProject) };
}

// -- Issue Operations -------------------------------------------------------

async function opIssueList(args, conn) {
  const qs = buildQs({
    state:     args.state     || "opened",
    labels:    args.labels    || undefined,
    milestone: args.milestone || undefined,
    search:    args.search    || undefined,
    order_by:  args.order_by  || "created_at",
    sort:      args.sort      || "desc",
    per_page:  clampInt(args.per_page, 20, 1, 100),
    page:      args.page      || 1,
    assignee_username: args.assignee || undefined,
  });
  const path = (args.project_id || args.project)
    ? `/projects/${projId(args)}/issues${qs}`
    : `/issues${qs}`;
  const res = await glApiRequest(conn, { path });
  checkGlStatus(res, "issue_list");
  const j = parseGlJson(res.raw, "issue_list");
  return { ok: true, operation: "issue_list", count: (j || []).length, issues: (j || []).map(mapIssue) };
}

async function opIssueGet(args, conn) {
  if (!args.issue_iid) throw new Error("issue_iid must be provided");
  const res = await glApiRequest(conn, { path: `/projects/${projId(args)}/issues/${args.issue_iid}` });
  if (res.statusCode === 404) return { ok: true, operation: "issue_get", exists: false };
  checkGlStatus(res, "issue_get");
  const j = parseGlJson(res.raw, "issue_get");
  return { ok: true, operation: "issue_get", exists: true, ...mapIssue(j) };
}

async function opIssueCreate(args, conn) {
  requireString(args.title, "title");
  const body = { title: args.title };
  if (args.description !== undefined) body.description = args.description;
  if (args.labels      !== undefined) body.labels = Array.isArray(args.labels) ? args.labels.join(",") : args.labels;
  if (args.assignee_ids!== undefined) body.assignee_ids = args.assignee_ids;
  if (args.milestone_id!== undefined) body.milestone_id = args.milestone_id;
  if (args.confidential!== undefined) body.confidential = args.confidential;
  if (args.due_date    !== undefined) body.due_date = args.due_date;
  const res = await glApiRequest(conn, { path: `/projects/${projId(args)}/issues`, method: "POST", body });
  checkGlStatus(res, "issue_create");
  const j = parseGlJson(res.raw, "issue_create");
  return { ok: true, operation: "issue_create", created: true, ...mapIssue(j) };
}

async function opIssueUpdate(args, conn) {
  if (!args.issue_iid) throw new Error("issue_iid must be provided");
  const body = {};
  if (args.title       !== undefined) body.title       = args.title;
  if (args.description !== undefined) body.description = args.description;
  if (args.state_event !== undefined) body.state_event = args.state_event;
  if (args.labels      !== undefined) body.labels      = Array.isArray(args.labels) ? args.labels.join(",") : args.labels;
  if (args.assignee_ids!== undefined) body.assignee_ids= args.assignee_ids;
  if (args.milestone_id!== undefined) body.milestone_id= args.milestone_id;
  if (args.due_date    !== undefined) body.due_date    = args.due_date;
  const res = await glApiRequest(conn, { path: `/projects/${projId(args)}/issues/${args.issue_iid}`, method: "PUT", body });
  checkGlStatus(res, "issue_update");
  const j = parseGlJson(res.raw, "issue_update");
  return { ok: true, operation: "issue_update", updated: true, ...mapIssue(j) };
}

async function opIssueClose(args, conn) {
  if (!args.issue_iid) throw new Error("issue_iid must be provided");
  const res = await glApiRequest(conn, {
    path:   `/projects/${projId(args)}/issues/${args.issue_iid}`,
    method: "PUT",
    body:   { state_event: "close" },
  });
  checkGlStatus(res, "issue_close");
  const j = parseGlJson(res.raw, "issue_close");
  return { ok: true, operation: "issue_close", closed: true, ...mapIssue(j) };
}

async function opIssueComment(args, conn) {
  if (!args.issue_iid) throw new Error("issue_iid must be provided");
  requireString(args.body, "body");
  const res = await glApiRequest(conn, {
    path:   `/projects/${projId(args)}/issues/${args.issue_iid}/notes`,
    method: "POST",
    body:   { body: args.body },
  });
  checkGlStatus(res, "issue_comment");
  const j = parseGlJson(res.raw, "issue_comment");
  return { ok: true, operation: "issue_comment", created: true, id: j.id, created_at: j.created_at };
}

async function opIssueComments(args, conn) {
  if (!args.issue_iid) throw new Error("issue_iid must be provided");
  const qs = buildQs({ per_page: clampInt(args.per_page, 20, 1, 100), page: args.page || 1 });
  const res = await glApiRequest(conn, { path: `/projects/${projId(args)}/issues/${args.issue_iid}/notes${qs}` });
  checkGlStatus(res, "issue_comments");
  const j = parseGlJson(res.raw, "issue_comments");
  return {
    ok: true, operation: "issue_comments", count: (j || []).length,
    notes: (j || []).map(function(n) { return { id: n.id, author: n.author ? n.author.username : null, body: n.body, system: n.system || false, created_at: n.created_at, updated_at: n.updated_at }; }),
  };
}

// -- Merge Request Operations -----------------------------------------------

async function opMrList(args, conn) {
  const qs = buildQs({
    state:         args.state         || "opened",
    labels:        args.labels        || undefined,
    milestone:     args.milestone     || undefined,
    source_branch: args.source_branch || undefined,
    target_branch: args.target_branch || undefined,
    search:        args.search        || undefined,
    order_by:      args.order_by      || "created_at",
    sort:          args.sort          || "desc",
    per_page:      clampInt(args.per_page, 20, 1, 100),
    page:          args.page          || 1,
    author_username:   args.author   || undefined,
    assignee_username: args.assignee || undefined,
    reviewer_username: args.reviewer || undefined,
  });
  const path = (args.project_id || args.project)
    ? `/projects/${projId(args)}/merge_requests${qs}`
    : `/merge_requests${qs}`;
  const res = await glApiRequest(conn, { path });
  checkGlStatus(res, "mr_list");
  const j = parseGlJson(res.raw, "mr_list");
  return { ok: true, operation: "mr_list", count: (j || []).length, merge_requests: (j || []).map(mapMr) };
}

async function opMrGet(args, conn) {
  if (!args.mr_iid) throw new Error("mr_iid must be provided");
  const res = await glApiRequest(conn, { path: `/projects/${projId(args)}/merge_requests/${args.mr_iid}` });
  if (res.statusCode === 404) return { ok: true, operation: "mr_get", exists: false };
  checkGlStatus(res, "mr_get");
  const j = parseGlJson(res.raw, "mr_get");
  return { ok: true, operation: "mr_get", exists: true, ...mapMr(j) };
}

async function opMrCreate(args, conn) {
  requireString(args.source_branch, "source_branch");
  requireString(args.target_branch, "target_branch");
  requireString(args.title,         "title");
  const body = {
    source_branch: args.source_branch,
    target_branch: args.target_branch,
    title:         args.title,
  };
  if (args.description !== undefined) body.description = args.description;
  if (args.labels      !== undefined) body.labels      = args.labels;
  if (args.assignee_ids!== undefined) body.assignee_ids= args.assignee_ids;
  if (args.reviewer_ids!== undefined) body.reviewer_ids= args.reviewer_ids;
  if (args.milestone_id!== undefined) body.milestone_id= args.milestone_id;
  if (args.remove_source_branch_after_merge !== undefined) body.remove_source_branch_after_merge = args.remove_source_branch_after_merge;
  if (args.squash      !== undefined) body.squash = args.squash;
  if (args.draft       !== undefined) body.draft  = args.draft;
  const res = await glApiRequest(conn, { path: `/projects/${projId(args)}/merge_requests`, method: "POST", body });
  checkGlStatus(res, "mr_create");
  const j = parseGlJson(res.raw, "mr_create");
  return { ok: true, operation: "mr_create", created: true, ...mapMr(j) };
}

async function opMrMerge(args, conn) {
  if (!args.mr_iid) throw new Error("mr_iid must be provided");
  const body = {};
  if (args.merge_commit_message !== undefined) body.merge_commit_message = args.merge_commit_message;
  if (args.squash               !== undefined) body.squash               = args.squash;
  if (args.should_remove_source_branch !== undefined) body.should_remove_source_branch = args.should_remove_source_branch;
  if (args.sha                  !== undefined) body.sha                  = args.sha;
  const res = await glApiRequest(conn, { path: `/projects/${projId(args)}/merge_requests/${args.mr_iid}/merge`, method: "PUT", body });
  if (res.statusCode === 405) return { ok: true, operation: "mr_merge", merged: false, reason: "not_mergeable" };
  if (res.statusCode === 406) return { ok: true, operation: "mr_merge", merged: false, reason: "already_merged_or_closed" };
  checkGlStatus(res, "mr_merge");
  const j = parseGlJson(res.raw, "mr_merge");
  return { ok: true, operation: "mr_merge", merged: true, sha: (j && j.sha) || null, ...mapMr(j) };
}

async function opMrUpdate(args, conn) {
  if (!args.mr_iid) throw new Error("mr_iid must be provided");
  const body = {};
  if (args.title         !== undefined) body.title         = args.title;
  if (args.description   !== undefined) body.description   = args.description;
  if (args.state_event   !== undefined) body.state_event   = args.state_event;
  if (args.target_branch !== undefined) body.target_branch = args.target_branch;
  if (args.labels        !== undefined) body.labels        = args.labels;
  if (args.assignee_ids  !== undefined) body.assignee_ids  = args.assignee_ids;
  if (args.reviewer_ids  !== undefined) body.reviewer_ids  = args.reviewer_ids;
  if (args.milestone_id  !== undefined) body.milestone_id  = args.milestone_id;
  if (args.squash        !== undefined) body.squash        = args.squash;
  if (args.draft         !== undefined) body.draft         = args.draft;
  const res = await glApiRequest(conn, { path: `/projects/${projId(args)}/merge_requests/${args.mr_iid}`, method: "PUT", body });
  checkGlStatus(res, "mr_update");
  const j = parseGlJson(res.raw, "mr_update");
  return { ok: true, operation: "mr_update", updated: true, ...mapMr(j) };
}

async function opMrNotes(args, conn) {
  if (!args.mr_iid) throw new Error("mr_iid must be provided");
  const qs = buildQs({ per_page: clampInt(args.per_page, 20, 1, 100), page: args.page || 1 });
  const res = await glApiRequest(conn, { path: `/projects/${projId(args)}/merge_requests/${args.mr_iid}/notes${qs}` });
  checkGlStatus(res, "mr_notes");
  const j = parseGlJson(res.raw, "mr_notes");
  return {
    ok: true, operation: "mr_notes", count: (j || []).length,
    notes: (j || []).map(function(n) { return { id: n.id, author: n.author ? n.author.username : null, body: n.body, system: n.system || false, created_at: n.created_at, updated_at: n.updated_at }; }),
  };
}

async function opMrAddNote(args, conn) {
  if (!args.mr_iid) throw new Error("mr_iid must be provided");
  requireString(args.body, "body");
  const res = await glApiRequest(conn, {
    path:   `/projects/${projId(args)}/merge_requests/${args.mr_iid}/notes`,
    method: "POST",
    body:   { body: args.body },
  });
  checkGlStatus(res, "mr_add_note");
  const j = parseGlJson(res.raw, "mr_add_note");
  return { ok: true, operation: "mr_add_note", created: true, id: j.id, created_at: j.created_at };
}

async function opMrChanges(args, conn) {
  if (!args.mr_iid) throw new Error("mr_iid must be provided");
  const res = await glApiRequest(conn, { path: `/projects/${projId(args)}/merge_requests/${args.mr_iid}/changes` });
  if (res.statusCode === 404) return { ok: true, operation: "mr_changes", exists: false };
  checkGlStatus(res, "mr_changes");
  const j = parseGlJson(res.raw, "mr_changes");
  return {
    ok: true, operation: "mr_changes", exists: true,
    iid: j.iid, title: j.title,
    changes_count: j.changes_count || (j.changes || []).length,
    changes: (j.changes || []).map(function(c) {
      return { old_path: c.old_path, new_path: c.new_path, new_file: c.new_file || false, deleted_file: c.deleted_file || false, renamed_file: c.renamed_file || false, diff: c.diff || null };
    }),
  };
}

// -- Repository / Contents Operations ---------------------------------------

async function opFileGet(args, conn) {
  requireString(args.file_path, "file_path");
  const ref = args.ref || "HEAD";
  const qs  = buildQs({ ref });
  const res = await glApiRequest(conn, {
    path: `/projects/${projId(args)}/repository/files/${encPath(args.file_path)}${qs}`,
  });
  if (res.statusCode === 404) return { ok: true, operation: "file_get", exists: false, file_path: args.file_path };
  checkGlStatus(res, "file_get");
  const j = parseGlJson(res.raw, "file_get");
  const content = j.content
    ? Buffer.from(j.content, j.encoding === "base64" ? "base64" : "utf8").toString("utf8")
    : null;
  return {
    ok: true, operation: "file_get", exists: true,
    file_name:      j.file_name,
    file_path:      j.file_path,
    size:           j.size,
    encoding:       j.encoding,
    content,
    content_sha256: j.content_sha256 || null,
    ref:            j.ref,
    blob_id:        j.blob_id        || null,
    commit_id:      j.commit_id      || null,
    last_commit_id: j.last_commit_id || null,
  };
}

async function opFileCreate(args, conn) {
  requireString(args.file_path,      "file_path");
  requireString(args.branch,         "branch");
  requireString(args.content,        "content");
  requireString(args.commit_message, "commit_message");
  const body = {
    branch:         args.branch,
    content:        args.content,
    commit_message: args.commit_message,
    encoding:       args.encoding     || "text",
  };
  if (args.author_email) body.author_email = args.author_email;
  if (args.author_name)  body.author_name  = args.author_name;
  const res = await glApiRequest(conn, {
    path:   `/projects/${projId(args)}/repository/files/${encPath(args.file_path)}`,
    method: "POST",
    body,
  });
  checkGlStatus(res, "file_create");
  const j = parseGlJson(res.raw, "file_create");
  return { ok: true, operation: "file_create", created: true, file_path: j.file_path, branch: j.branch };
}

async function opFileUpdate(args, conn) {
  requireString(args.file_path,      "file_path");
  requireString(args.branch,         "branch");
  requireString(args.content,        "content");
  requireString(args.commit_message, "commit_message");
  const body = {
    branch:         args.branch,
    content:        args.content,
    commit_message: args.commit_message,
    encoding:       args.encoding || "text",
  };
  if (args.last_commit_id) body.last_commit_id = args.last_commit_id;
  if (args.author_email)   body.author_email   = args.author_email;
  if (args.author_name)    body.author_name    = args.author_name;
  const res = await glApiRequest(conn, {
    path:   `/projects/${projId(args)}/repository/files/${encPath(args.file_path)}`,
    method: "PUT",
    body,
  });
  checkGlStatus(res, "file_update");
  const j = parseGlJson(res.raw, "file_update");
  return { ok: true, operation: "file_update", updated: true, file_path: j.file_path, branch: j.branch };
}

async function opFileDelete(args, conn) {
  requireString(args.file_path,      "file_path");
  requireString(args.branch,         "branch");
  requireString(args.commit_message, "commit_message");
  const body = { branch: args.branch, commit_message: args.commit_message };
  if (args.author_email) body.author_email = args.author_email;
  if (args.author_name)  body.author_name  = args.author_name;
  const res = await glApiRequest(conn, {
    path:   `/projects/${projId(args)}/repository/files/${encPath(args.file_path)}`,
    method: "DELETE",
    body,
  });
  if (res.statusCode === 404) return { ok: true, operation: "file_delete", deleted: false, reason: "not_found" };
  checkGlStatus(res, "file_delete");
  return { ok: true, operation: "file_delete", deleted: true };
}

async function opTreeList(args, conn) {
  const qs = buildQs({
    ref:       args.ref       || "HEAD",
    path:      args.path_     || undefined,
    recursive: args.recursive || undefined,
    per_page:  clampInt(args.per_page, 20, 1, 100),
    page:      args.page || 1,
  });
  const res = await glApiRequest(conn, { path: `/projects/${projId(args)}/repository/tree${qs}` });
  if (res.statusCode === 404) return { ok: true, operation: "tree_list", exists: false };
  checkGlStatus(res, "tree_list");
  const j = parseGlJson(res.raw, "tree_list");
  return {
    ok: true, operation: "tree_list", exists: true, count: (j || []).length,
    entries: (j || []).map(function(e) { return { id: e.id, name: e.name, type: e.type, path: e.path, mode: e.mode }; }),
  };
}

// -- Branch Operations -------------------------------------------------------

async function opBranchList(args, conn) {
  const qs = buildQs({
    search:   args.search   || undefined,
    per_page: clampInt(args.per_page, 20, 1, 100),
    page:     args.page || 1,
  });
  const res = await glApiRequest(conn, { path: `/projects/${projId(args)}/repository/branches${qs}` });
  checkGlStatus(res, "branch_list");
  const j = parseGlJson(res.raw, "branch_list");
  return {
    ok: true, operation: "branch_list", count: (j || []).length,
    branches: (j || []).map(function(b) { return { name: b.name, protected: b.protected || false, default: b.default || false, merged: b.merged || false, commit_id: b.commit ? b.commit.id : null }; }),
  };
}

async function opBranchGet(args, conn) {
  requireString(args.branch, "branch");
  const res = await glApiRequest(conn, { path: `/projects/${projId(args)}/repository/branches/${enc(args.branch)}` });
  if (res.statusCode === 404) return { ok: true, operation: "branch_get", exists: false };
  checkGlStatus(res, "branch_get");
  const j = parseGlJson(res.raw, "branch_get");
  return {
    ok: true, operation: "branch_get", exists: true,
    name:           j.name,
    protected:      j.protected || false,
    default:        j.default   || false,
    merged:         j.merged    || false,
    commit_id:      j.commit ? j.commit.id : null,
    commit_message: j.commit ? j.commit.title : null,
  };
}

async function opBranchCreate(args, conn) {
  requireString(args.branch, "branch");
  requireString(args.ref,    "ref");
  const res = await glApiRequest(conn, {
    path: `/projects/${projId(args)}/repository/branches`,
    method: "POST",
    body: { branch: args.branch, ref: args.ref },
  });
  checkGlStatus(res, "branch_create");
  const j = parseGlJson(res.raw, "branch_create");
  return { ok: true, operation: "branch_create", created: true, name: j.name, commit_id: j.commit ? j.commit.id : null };
}

async function opBranchDelete(args, conn) {
  requireString(args.branch, "branch");
  const res = await glApiRequest(conn, {
    path:   `/projects/${projId(args)}/repository/branches/${enc(args.branch)}`,
    method: "DELETE",
  });
  if (res.statusCode === 404) return { ok: true, operation: "branch_delete", deleted: false, reason: "not_found" };
  checkGlStatus(res, "branch_delete");
  return { ok: true, operation: "branch_delete", deleted: true };
}

async function opBranchProtect(args, conn) {
  requireString(args.branch, "branch");
  const body = {
    name:               args.branch,
    push_access_level:  args.push_access_level  != null ? args.push_access_level  : 40,
    merge_access_level: args.merge_access_level != null ? args.merge_access_level : 40,
    allow_force_push:   args.allow_force_push   != null ? args.allow_force_push   : false,
    code_owner_approval_required: args.code_owner_approval_required != null ? args.code_owner_approval_required : false,
  };
  const res = await glApiRequest(conn, { path: `/projects/${projId(args)}/protected_branches`, method: "POST", body });
  if (res.statusCode === 409) return { ok: true, operation: "branch_protect", protected: false, reason: "already_protected" };
  checkGlStatus(res, "branch_protect");
  const j = parseGlJson(res.raw, "branch_protect");
  return { ok: true, operation: "branch_protect", protected: true, name: j.name, push_access_levels: j.push_access_levels, merge_access_levels: j.merge_access_levels };
}

async function opBranchUnprotect(args, conn) {
  requireString(args.branch, "branch");
  const res = await glApiRequest(conn, {
    path:   `/projects/${projId(args)}/protected_branches/${enc(args.branch)}`,
    method: "DELETE",
  });
  if (res.statusCode === 404) return { ok: true, operation: "branch_unprotect", unprotected: false, reason: "not_found" };
  checkGlStatus(res, "branch_unprotect");
  return { ok: true, operation: "branch_unprotect", unprotected: true };
}

// -- Commit Operations -------------------------------------------------------

async function opCommitList(args, conn) {
  const qs = buildQs({
    ref_name:  args.ref       || undefined,
    since:     args.since     || undefined,
    until:     args.until     || undefined,
    author:    args.author    || undefined,
    path:      args.file_path || undefined,
    per_page:  clampInt(args.per_page, 20, 1, 100),
    page:      args.page || 1,
  });
  const res = await glApiRequest(conn, { path: `/projects/${projId(args)}/repository/commits${qs}` });
  checkGlStatus(res, "commit_list");
  const j = parseGlJson(res.raw, "commit_list");
  return { ok: true, operation: "commit_list", count: (j || []).length, commits: (j || []).map(mapCommit) };
}

async function opCommitGet(args, conn) {
  requireString(args.sha, "sha");
  const res = await glApiRequest(conn, { path: `/projects/${projId(args)}/repository/commits/${enc(args.sha)}` });
  if (res.statusCode === 404) return { ok: true, operation: "commit_get", exists: false };
  checkGlStatus(res, "commit_get");
  const j = parseGlJson(res.raw, "commit_get");
  return { ok: true, operation: "commit_get", exists: true, ...mapCommit(j), stats: j.stats || null };
}

async function opCommitDiff(args, conn) {
  requireString(args.sha, "sha");
  const qs = buildQs({ per_page: clampInt(args.per_page, 20, 1, 100), page: args.page || 1 });
  const res = await glApiRequest(conn, { path: `/projects/${projId(args)}/repository/commits/${enc(args.sha)}/diff${qs}` });
  if (res.statusCode === 404) return { ok: true, operation: "commit_diff", exists: false };
  checkGlStatus(res, "commit_diff");
  const j = parseGlJson(res.raw, "commit_diff");
  return {
    ok: true, operation: "commit_diff", exists: true, count: (j || []).length,
    diffs: (j || []).map(function(d) { return { old_path: d.old_path, new_path: d.new_path, new_file: d.new_file || false, deleted_file: d.deleted_file || false, renamed_file: d.renamed_file || false, diff: d.diff || null }; }),
  };
}

async function opCommitStatuses(args, conn) {
  requireString(args.sha, "sha");
  const qs = buildQs({ ref: args.ref || undefined, per_page: clampInt(args.per_page, 20, 1, 100), page: args.page || 1 });
  const res = await glApiRequest(conn, { path: `/projects/${projId(args)}/repository/commits/${enc(args.sha)}/statuses${qs}` });
  if (res.statusCode === 404) return { ok: true, operation: "commit_statuses", exists: false };
  checkGlStatus(res, "commit_statuses");
  const j = parseGlJson(res.raw, "commit_statuses");
  return {
    ok: true, operation: "commit_statuses", exists: true, count: (j || []).length,
    statuses: (j || []).map(function(s) { return { id: s.id, status: s.status, name: s.name, ref: s.ref, sha: s.sha, description: s.description || null, target_url: s.target_url || null, created_at: s.created_at, updated_at: s.updated_at }; }),
  };
}

// -- Tag Operations ---------------------------------------------------------

async function opTagList(args, conn) {
  const qs = buildQs({ search: args.search || undefined, per_page: clampInt(args.per_page, 20, 1, 100), page: args.page || 1 });
  const res = await glApiRequest(conn, { path: `/projects/${projId(args)}/repository/tags${qs}` });
  checkGlStatus(res, "tag_list");
  const j = parseGlJson(res.raw, "tag_list");
  return {
    ok: true, operation: "tag_list", count: (j || []).length,
    tags: (j || []).map(function(t) { return { name: t.name, message: t.message || null, commit_id: t.commit ? t.commit.id : null, commit_message: t.commit ? t.commit.title : null, protected: t.protected || false, created_at: t.created_at || (t.commit ? t.commit.created_at : null) }; }),
  };
}

async function opTagGet(args, conn) {
  requireString(args.tag_name, "tag_name");
  const res = await glApiRequest(conn, { path: `/projects/${projId(args)}/repository/tags/${enc(args.tag_name)}` });
  if (res.statusCode === 404) return { ok: true, operation: "tag_get", exists: false };
  checkGlStatus(res, "tag_get");
  const j = parseGlJson(res.raw, "tag_get");
  return {
    ok: true, operation: "tag_get", exists: true,
    name: j.name, message: j.message || null,
    commit_id: j.commit ? j.commit.id : null, protected: j.protected || false,
    release: j.release ? { description: j.release.description } : null,
  };
}

async function opTagCreate(args, conn) {
  requireString(args.tag_name, "tag_name");
  requireString(args.ref,      "ref");
  const body = { tag_name: args.tag_name, ref: args.ref };
  if (args.message) body.message = args.message;
  const res = await glApiRequest(conn, { path: `/projects/${projId(args)}/repository/tags`, method: "POST", body });
  checkGlStatus(res, "tag_create");
  const j = parseGlJson(res.raw, "tag_create");
  return { ok: true, operation: "tag_create", created: true, name: j.name, commit_id: j.commit ? j.commit.id : null };
}

async function opTagDelete(args, conn) {
  requireString(args.tag_name, "tag_name");
  const res = await glApiRequest(conn, {
    path:   `/projects/${projId(args)}/repository/tags/${enc(args.tag_name)}`,
    method: "DELETE",
  });
  if (res.statusCode === 404) return { ok: true, operation: "tag_delete", deleted: false, reason: "not_found" };
  checkGlStatus(res, "tag_delete");
  return { ok: true, operation: "tag_delete", deleted: true };
}

// -- Release Operations -----------------------------------------------------

async function opReleaseList(args, conn) {
  const qs = buildQs({ per_page: clampInt(args.per_page, 20, 1, 100), page: args.page || 1 });
  const res = await glApiRequest(conn, { path: `/projects/${projId(args)}/releases${qs}` });
  checkGlStatus(res, "release_list");
  const j = parseGlJson(res.raw, "release_list");
  return {
    ok: true, operation: "release_list", count: (j || []).length,
    releases: (j || []).map(function(r) { return { tag_name: r.tag_name, name: r.name || null, description: r.description || null, author: r.author ? r.author.username : null, created_at: r.created_at, released_at: r.released_at || null }; }),
  };
}

async function opReleaseGet(args, conn) {
  requireString(args.tag_name, "tag_name");
  const res = await glApiRequest(conn, { path: `/projects/${projId(args)}/releases/${enc(args.tag_name)}` });
  if (res.statusCode === 404) return { ok: true, operation: "release_get", exists: false };
  checkGlStatus(res, "release_get");
  const j = parseGlJson(res.raw, "release_get");
  return {
    ok: true, operation: "release_get", exists: true,
    tag_name:    j.tag_name, name: j.name || null,
    description: j.description || null, author: j.author ? j.author.username : null,
    created_at:  j.created_at, released_at: j.released_at || null,
    assets:      j.assets ? { count: j.assets.count, links: j.assets.links || [] } : null,
  };
}

async function opReleaseCreate(args, conn) {
  requireString(args.tag_name, "tag_name");
  const body = { tag_name: args.tag_name };
  if (args.name)        body.name        = args.name;
  if (args.description) body.description = args.description;
  if (args.ref)         body.ref         = args.ref;
  if (args.released_at) body.released_at = args.released_at;
  if (args.milestones)  body.milestones  = args.milestones;
  const res = await glApiRequest(conn, { path: `/projects/${projId(args)}/releases`, method: "POST", body });
  checkGlStatus(res, "release_create");
  const j = parseGlJson(res.raw, "release_create");
  return { ok: true, operation: "release_create", created: true, tag_name: j.tag_name, name: j.name || null };
}

// -- Pipeline / CI/CD Operations --------------------------------------------

async function opPipelineList(args, conn) {
  const qs = buildQs({
    status:   args.status   || undefined,
    ref:      args.ref      || undefined,
    sha:      args.sha      || undefined,
    source:   args.source   || undefined,
    order_by: args.order_by || "id",
    sort:     args.sort     || "desc",
    per_page: clampInt(args.per_page, 20, 1, 100),
    page:     args.page || 1,
  });
  const res = await glApiRequest(conn, { path: `/projects/${projId(args)}/pipelines${qs}` });
  checkGlStatus(res, "pipeline_list");
  const j = parseGlJson(res.raw, "pipeline_list");
  return { ok: true, operation: "pipeline_list", count: (j || []).length, pipelines: (j || []).map(mapPipeline) };
}

async function opPipelineGet(args, conn) {
  if (!args.pipeline_id) throw new Error("pipeline_id must be provided");
  const res = await glApiRequest(conn, { path: `/projects/${projId(args)}/pipelines/${args.pipeline_id}` });
  if (res.statusCode === 404) return { ok: true, operation: "pipeline_get", exists: false };
  checkGlStatus(res, "pipeline_get");
  const j = parseGlJson(res.raw, "pipeline_get");
  return { ok: true, operation: "pipeline_get", exists: true, ...mapPipeline(j) };
}

async function opPipelineCreate(args, conn) {
  requireString(args.ref, "ref");
  const body = { ref: args.ref };
  if (args.variables && Array.isArray(args.variables)) body.variables = args.variables;
  const res = await glApiRequest(conn, { path: `/projects/${projId(args)}/pipeline`, method: "POST", body });
  checkGlStatus(res, "pipeline_create");
  const j = parseGlJson(res.raw, "pipeline_create");
  return { ok: true, operation: "pipeline_create", created: true, ...mapPipeline(j) };
}

async function opPipelineCancel(args, conn) {
  if (!args.pipeline_id) throw new Error("pipeline_id must be provided");
  const res = await glApiRequest(conn, {
    path:   `/projects/${projId(args)}/pipelines/${args.pipeline_id}/cancel`,
    method: "POST",
  });
  if (res.statusCode === 403) return { ok: true, operation: "pipeline_cancel", cancelled: false, reason: "forbidden" };
  checkGlStatus(res, "pipeline_cancel");
  const j = parseGlJson(res.raw, "pipeline_cancel");
  return { ok: true, operation: "pipeline_cancel", cancelled: true, ...mapPipeline(j) };
}

async function opPipelineRetry(args, conn) {
  if (!args.pipeline_id) throw new Error("pipeline_id must be provided");
  const res = await glApiRequest(conn, {
    path:   `/projects/${projId(args)}/pipelines/${args.pipeline_id}/retry`,
    method: "POST",
  });
  checkGlStatus(res, "pipeline_retry");
  const j = parseGlJson(res.raw, "pipeline_retry");
  return { ok: true, operation: "pipeline_retry", retried: true, ...mapPipeline(j) };
}

async function opPipelineJobs(args, conn) {
  if (!args.pipeline_id) throw new Error("pipeline_id must be provided");
  const qs = buildQs({ scope: args.scope || undefined, per_page: clampInt(args.per_page, 20, 1, 100), page: args.page || 1 });
  const res = await glApiRequest(conn, { path: `/projects/${projId(args)}/pipelines/${args.pipeline_id}/jobs${qs}` });
  checkGlStatus(res, "pipeline_jobs");
  const j = parseGlJson(res.raw, "pipeline_jobs");
  return { ok: true, operation: "pipeline_jobs", count: (j || []).length, jobs: (j || []).map(mapJob) };
}

async function opJobGet(args, conn) {
  if (!args.job_id) throw new Error("job_id must be provided");
  const res = await glApiRequest(conn, { path: `/projects/${projId(args)}/jobs/${args.job_id}` });
  if (res.statusCode === 404) return { ok: true, operation: "job_get", exists: false };
  checkGlStatus(res, "job_get");
  const j = parseGlJson(res.raw, "job_get");
  return { ok: true, operation: "job_get", exists: true, ...mapJob(j) };
}

async function opJobLog(args, conn) {
  if (!args.job_id) throw new Error("job_id must be provided");
  const res = await glApiRequest(conn, { path: `/projects/${projId(args)}/jobs/${args.job_id}/trace` });
  if (res.statusCode === 404) return { ok: true, operation: "job_log", exists: false };
  checkGlStatus(res, "job_log");
  const log = res.raw;
  const maxLog = 100000;
  const truncated = log.length > maxLog;
  return { ok: true, operation: "job_log", exists: true, log: truncated ? log.slice(0, maxLog) : log, truncated, size: log.length };
}

// -- User Operations ---------------------------------------------------------

async function opUserGet(args, conn) {
  let path;
  if (args.user_id) {
    path = `/users/${enc(String(args.user_id))}`;
    const res = await glApiRequest(conn, { path });
    if (res.statusCode === 404) return { ok: true, operation: "user_get", exists: false };
    checkGlStatus(res, "user_get");
    const j = parseGlJson(res.raw, "user_get");
    return { ok: true, operation: "user_get", exists: true, ...mapUser(j) };
  } else if (args.username) {
    requireString(args.username, "username");
    const qs = buildQs({ username: args.username });
    const res = await glApiRequest(conn, { path: `/users${qs}` });
    checkGlStatus(res, "user_get");
    const j = parseGlJson(res.raw, "user_get");
    const users = j || [];
    if (users.length === 0) return { ok: true, operation: "user_get", exists: false };
    return { ok: true, operation: "user_get", exists: true, ...mapUser(users[0]) };
  } else {
    throw new Error("user_id or username must be provided");
  }
}

async function opUserMe(args, conn) {
  const res = await glApiRequest(conn, { path: "/user" });
  checkGlStatus(res, "user_me");
  const j = parseGlJson(res.raw, "user_me");
  return { ok: true, operation: "user_me", ...mapUser(j) };
}

async function opUserList(args, conn) {
  const qs = buildQs({
    search:   args.search   || undefined,
    active:   args.active   || undefined,
    blocked:  args.blocked  || undefined,
    external: args.external || undefined,
    per_page: clampInt(args.per_page, 20, 1, 100),
    page:     args.page || 1,
  });
  const res = await glApiRequest(conn, { path: `/users${qs}` });
  checkGlStatus(res, "user_list");
  const j = parseGlJson(res.raw, "user_list");
  return { ok: true, operation: "user_list", count: (j || []).length, users: (j || []).map(mapUser) };
}

// -- Group Operations --------------------------------------------------------

function groupId(args) {
  if (args.group_id)   return enc(String(args.group_id));
  if (args.group_path) return enc(args.group_path);
  throw new Error("group_id or group_path must be provided");
}

async function opGroupGet(args, conn) {
  const res = await glApiRequest(conn, { path: `/groups/${groupId(args)}` });
  if (res.statusCode === 404) return { ok: true, operation: "group_get", exists: false };
  checkGlStatus(res, "group_get");
  const j = parseGlJson(res.raw, "group_get");
  return { ok: true, operation: "group_get", exists: true, ...mapGroup(j) };
}

async function opGroupList(args, conn) {
  const qs = buildQs({
    search:   args.search   || undefined,
    owned:    args.owned    || undefined,
    order_by: args.order_by || "name",
    sort:     args.sort     || "asc",
    per_page: clampInt(args.per_page, 20, 1, 100),
    page:     args.page     || 1,
    min_access_level: args.min_access_level || undefined,
  });
  const res = await glApiRequest(conn, { path: `/groups${qs}` });
  checkGlStatus(res, "group_list");
  const j = parseGlJson(res.raw, "group_list");
  return { ok: true, operation: "group_list", count: (j || []).length, groups: (j || []).map(mapGroup) };
}

async function opGroupProjects(args, conn) {
  const qs = buildQs({
    search:   args.search   || undefined,
    order_by: args.order_by || "updated_at",
    sort:     args.sort     || "desc",
    per_page: clampInt(args.per_page, 20, 1, 100),
    page:     args.page     || 1,
    simple:   true,
  });
  const res = await glApiRequest(conn, { path: `/groups/${groupId(args)}/projects${qs}` });
  checkGlStatus(res, "group_projects");
  const j = parseGlJson(res.raw, "group_projects");
  return { ok: true, operation: "group_projects", count: (j || []).length, projects: (j || []).map(mapProject) };
}

async function opGroupMembers(args, conn) {
  const qs = buildQs({ query: args.query || undefined, per_page: clampInt(args.per_page, 20, 1, 100), page: args.page || 1 });
  const res = await glApiRequest(conn, { path: `/groups/${groupId(args)}/members${qs}` });
  checkGlStatus(res, "group_members");
  const j = parseGlJson(res.raw, "group_members");
  return {
    ok: true, operation: "group_members", count: (j || []).length,
    members: (j || []).map(function(m) { return { id: m.id, username: m.username, name: m.name, access_level: m.access_level, state: m.state }; }),
  };
}

// -- Namespace Operations ----------------------------------------------------

async function opNamespaceList(args, conn) {
  const qs = buildQs({ search: args.search || undefined, per_page: clampInt(args.per_page, 20, 1, 100), page: args.page || 1 });
  const res = await glApiRequest(conn, { path: `/namespaces${qs}` });
  checkGlStatus(res, "namespace_list");
  const j = parseGlJson(res.raw, "namespace_list");
  return {
    ok: true, operation: "namespace_list", count: (j || []).length,
    namespaces: (j || []).map(function(n) { return { id: n.id, name: n.name, path: n.path, kind: n.kind, full_path: n.full_path }; }),
  };
}

// -- Label Operations --------------------------------------------------------

async function opLabelList(args, conn) {
  const qs = buildQs({ per_page: clampInt(args.per_page, 20, 1, 100), page: args.page || 1 });
  const res = await glApiRequest(conn, { path: `/projects/${projId(args)}/labels${qs}` });
  checkGlStatus(res, "label_list");
  const j = parseGlJson(res.raw, "label_list");
  return {
    ok: true, operation: "label_list", count: (j || []).length,
    labels: (j || []).map(function(l) { return { id: l.id, name: l.name, color: l.color, description: l.description || null, open_issues_count: l.open_issues_count || 0 }; }),
  };
}

async function opLabelCreate(args, conn) {
  requireString(args.name,  "name");
  requireString(args.color, "color");
  const body = { name: args.name, color: args.color };
  if (args.description) body.description = args.description;
  const res = await glApiRequest(conn, { path: `/projects/${projId(args)}/labels`, method: "POST", body });
  checkGlStatus(res, "label_create");
  const j = parseGlJson(res.raw, "label_create");
  return { ok: true, operation: "label_create", created: true, id: j.id, name: j.name, color: j.color };
}

// -- Milestone Operations ----------------------------------------------------

async function opMilestoneList(args, conn) {
  const qs = buildQs({ state: args.state || undefined, search: args.search || undefined, per_page: clampInt(args.per_page, 20, 1, 100), page: args.page || 1 });
  const res = await glApiRequest(conn, { path: `/projects/${projId(args)}/milestones${qs}` });
  checkGlStatus(res, "milestone_list");
  const j = parseGlJson(res.raw, "milestone_list");
  return {
    ok: true, operation: "milestone_list", count: (j || []).length,
    milestones: (j || []).map(function(m) { return { id: m.id, iid: m.iid, title: m.title, state: m.state, description: m.description || null, due_date: m.due_date || null, created_at: m.created_at, updated_at: m.updated_at }; }),
  };
}

async function opMilestoneGet(args, conn) {
  if (!args.milestone_id) throw new Error("milestone_id must be provided");
  const res = await glApiRequest(conn, { path: `/projects/${projId(args)}/milestones/${args.milestone_id}` });
  if (res.statusCode === 404) return { ok: true, operation: "milestone_get", exists: false };
  checkGlStatus(res, "milestone_get");
  const m = parseGlJson(res.raw, "milestone_get");
  return { ok: true, operation: "milestone_get", exists: true, id: m.id, iid: m.iid, title: m.title, state: m.state, description: m.description || null, due_date: m.due_date || null };
}

async function opMilestoneCreate(args, conn) {
  requireString(args.title, "title");
  const body = { title: args.title };
  if (args.description) body.description = args.description;
  if (args.due_date)    body.due_date    = args.due_date;
  if (args.start_date)  body.start_date  = args.start_date;
  const res = await glApiRequest(conn, { path: `/projects/${projId(args)}/milestones`, method: "POST", body });
  checkGlStatus(res, "milestone_create");
  const m = parseGlJson(res.raw, "milestone_create");
  return { ok: true, operation: "milestone_create", created: true, id: m.id, iid: m.iid, title: m.title };
}

// -- Snippet Operations -------------------------------------------------------

async function opSnippetList(args, conn) {
  const qs = buildQs({ per_page: clampInt(args.per_page, 20, 1, 100), page: args.page || 1 });
  const res = await glApiRequest(conn, { path: `/snippets${qs}` });
  checkGlStatus(res, "snippet_list");
  const j = parseGlJson(res.raw, "snippet_list");
  return {
    ok: true, operation: "snippet_list", count: (j || []).length,
    snippets: (j || []).map(function(s) { return { id: s.id, title: s.title, description: s.description || null, visibility: s.visibility || null, author: s.author ? s.author.username : null, file_name: s.file_name || null, web_url: s.web_url || null, created_at: s.created_at, updated_at: s.updated_at }; }),
  };
}

async function opSnippetGet(args, conn) {
  if (!args.snippet_id) throw new Error("snippet_id must be provided");
  const res = await glApiRequest(conn, { path: `/snippets/${args.snippet_id}` });
  if (res.statusCode === 404) return { ok: true, operation: "snippet_get", exists: false };
  checkGlStatus(res, "snippet_get");
  const s = parseGlJson(res.raw, "snippet_get");
  const rawRes = await glApiRequest(conn, { path: `/snippets/${args.snippet_id}/raw` });
  const content = rawRes.statusCode === 200 ? rawRes.raw : null;
  return {
    ok: true, operation: "snippet_get", exists: true,
    id: s.id, title: s.title, description: s.description || null,
    visibility: s.visibility || null, author: s.author ? s.author.username : null,
    file_name: s.file_name || null, web_url: s.web_url || null,
    content, created_at: s.created_at, updated_at: s.updated_at,
  };
}

async function opSnippetCreate(args, conn) {
  requireString(args.title,   "title");
  requireString(args.content, "content");
  const body = {
    title:      args.title,
    content:    args.content,
    visibility: args.visibility || "private",
    file_name:  args.file_name  || "snippet.txt",
  };
  if (args.description) body.description = args.description;
  const res = await glApiRequest(conn, { path: "/snippets", method: "POST", body });
  checkGlStatus(res, "snippet_create");
  const s = parseGlJson(res.raw, "snippet_create");
  return { ok: true, operation: "snippet_create", created: true, id: s.id, title: s.title, web_url: s.web_url || null };
}

// -- Generic request ---------------------------------------------------------

async function opRequest(args, conn) {
  requireString(args.path_, "path");
  requireString(args.method,"method");
  const validMethods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];
  const method = args.method.toUpperCase();
  if (!validMethods.includes(method))
    throw new Error(`method must be one of: ${validMethods.join(", ")}`);
  const res = await glApiRequest(conn, { path: args.path_, method, body: args.body || undefined });
  let parsedBody;
  const ct = res.headers["content-type"] || "";
  if (ct.includes("json")) {
    try { parsedBody = JSON.parse(res.raw); } catch (_) { parsedBody = res.raw; }
  } else {
    parsedBody = res.raw;
  }
  if (res.statusCode < 200 || res.statusCode >= 300)
    checkGlStatus(res, `request ${method} ${args.path_}`);
  return {
    ok: true, operation: "request",
    path: args.path_, method,
    status_code: res.statusCode,
    headers: res.headers,
    body: parsedBody,
  };
}

// -- Info -------------------------------------------------------------------

function opInfo() {
  return {
    ok:               true,
    protocol:         "GitLab REST API v4 (HTTPS/JSON)",
    default_base_url: GITLAB_API_BASE,
    auth:             "Personal Access Token (PAT) or OAuth2 token via 'token' field (PRIVATE-TOKEN header)",
    note:             "Override base_url for self-hosted GitLab instances",
    operations: [
      { op: "project_get",       description: "Get project details" },
      { op: "project_list",      description: "List projects" },
      { op: "project_create",    description: "Create a project" },
      { op: "project_delete",    description: "Delete a project" },
      { op: "project_fork",      description: "Fork a project" },
      { op: "project_members",   description: "List project members" },
      { op: "project_search",    description: "Search for projects" },
      { op: "issue_list",        description: "List issues" },
      { op: "issue_get",         description: "Get a single issue" },
      { op: "issue_create",      description: "Create an issue" },
      { op: "issue_update",      description: "Update an issue" },
      { op: "issue_close",       description: "Close an issue" },
      { op: "issue_comment",     description: "Add a comment to an issue" },
      { op: "issue_comments",    description: "List comments on an issue" },
      { op: "mr_list",           description: "List merge requests" },
      { op: "mr_get",            description: "Get a merge request" },
      { op: "mr_create",         description: "Create a merge request" },
      { op: "mr_merge",          description: "Merge a merge request" },
      { op: "mr_update",         description: "Update a merge request" },
      { op: "mr_notes",          description: "List notes on a merge request" },
      { op: "mr_add_note",       description: "Add a note to a merge request" },
      { op: "mr_changes",        description: "Get diff/changes of a merge request" },
      { op: "file_get",          description: "Get file content from repository" },
      { op: "file_create",       description: "Create a file in repository" },
      { op: "file_update",       description: "Update a file in repository" },
      { op: "file_delete",       description: "Delete a file from repository" },
      { op: "tree_list",         description: "List directory tree in repository" },
      { op: "branch_list",       description: "List branches" },
      { op: "branch_get",        description: "Get a branch" },
      { op: "branch_create",     description: "Create a branch" },
      { op: "branch_delete",     description: "Delete a branch" },
      { op: "branch_protect",    description: "Protect a branch (push/merge access levels)" },
      { op: "branch_unprotect",  description: "Unprotect a branch" },
      { op: "commit_list",       description: "List commits" },
      { op: "commit_get",        description: "Get a commit" },
      { op: "commit_diff",       description: "Get diff for a commit" },
      { op: "commit_statuses",   description: "Get CI statuses for a commit" },
      { op: "tag_list",          description: "List tags" },
      { op: "tag_get",           description: "Get a tag" },
      { op: "tag_create",        description: "Create a tag" },
      { op: "tag_delete",        description: "Delete a tag" },
      { op: "release_list",      description: "List releases" },
      { op: "release_get",       description: "Get a release" },
      { op: "release_create",    description: "Create a release" },
      { op: "pipeline_list",     description: "List pipelines" },
      { op: "pipeline_get",      description: "Get a pipeline" },
      { op: "pipeline_create",   description: "Trigger a new pipeline" },
      { op: "pipeline_cancel",   description: "Cancel a pipeline" },
      { op: "pipeline_retry",    description: "Retry a pipeline" },
      { op: "pipeline_jobs",     description: "List jobs in a pipeline" },
      { op: "job_get",           description: "Get a job" },
      { op: "job_log",           description: "Get job log/trace (truncated to 100 KB)" },
      { op: "user_get",          description: "Get a user by ID or username" },
      { op: "user_me",           description: "Get the authenticated user" },
      { op: "user_list",         description: "List/search users" },
      { op: "group_get",         description: "Get a group" },
      { op: "group_list",        description: "List groups" },
      { op: "group_projects",    description: "List projects in a group" },
      { op: "group_members",     description: "List members of a group" },
      { op: "namespace_list",    description: "List namespaces" },
      { op: "label_list",        description: "List labels in a project" },
      { op: "label_create",      description: "Create a label" },
      { op: "milestone_list",    description: "List milestones" },
      { op: "milestone_get",     description: "Get a milestone" },
      { op: "milestone_create",  description: "Create a milestone" },
      { op: "snippet_list",      description: "List personal snippets" },
      { op: "snippet_get",       description: "Get a snippet with content" },
      { op: "snippet_create",    description: "Create a snippet" },
      { op: "request",           description: "Generic authenticated request to any GitLab API path" },
      { op: "info",              description: "Return this operation reference (no I/O)" },
    ],
  };
}

// -- Main entry point -------------------------------------------------------

async function gitlabClient(args) {
  const op = (args.operation || "").toLowerCase().replace(/-/g, "_");
  if (op === "info") return opInfo();

  const conn = buildConn(args);
  const mappedArgs = Object.assign({}, args, { path_: args.path });

  switch (op) {
    case "project_get":      return opProjectGet(mappedArgs, conn);
    case "project_list":     return opProjectList(mappedArgs, conn);
    case "project_create":   return opProjectCreate(mappedArgs, conn);
    case "project_delete":   return opProjectDelete(mappedArgs, conn);
    case "project_fork":     return opProjectFork(mappedArgs, conn);
    case "project_members":  return opProjectMembers(mappedArgs, conn);
    case "project_search":   return opProjectSearch(mappedArgs, conn);
    case "issue_list":       return opIssueList(mappedArgs, conn);
    case "issue_get":        return opIssueGet(mappedArgs, conn);
    case "issue_create":     return opIssueCreate(mappedArgs, conn);
    case "issue_update":     return opIssueUpdate(mappedArgs, conn);
    case "issue_close":      return opIssueClose(mappedArgs, conn);
    case "issue_comment":    return opIssueComment(mappedArgs, conn);
    case "issue_comments":   return opIssueComments(mappedArgs, conn);
    case "mr_list":          return opMrList(mappedArgs, conn);
    case "mr_get":           return opMrGet(mappedArgs, conn);
    case "mr_create":        return opMrCreate(mappedArgs, conn);
    case "mr_merge":         return opMrMerge(mappedArgs, conn);
    case "mr_update":        return opMrUpdate(mappedArgs, conn);
    case "mr_notes":         return opMrNotes(mappedArgs, conn);
    case "mr_add_note":      return opMrAddNote(mappedArgs, conn);
    case "mr_changes":       return opMrChanges(mappedArgs, conn);
    case "file_get":         return opFileGet(mappedArgs, conn);
    case "file_create":      return opFileCreate(mappedArgs, conn);
    case "file_update":      return opFileUpdate(mappedArgs, conn);
    case "file_delete":      return opFileDelete(mappedArgs, conn);
    case "tree_list":        return opTreeList(mappedArgs, conn);
    case "branch_list":      return opBranchList(mappedArgs, conn);
    case "branch_get":       return opBranchGet(mappedArgs, conn);
    case "branch_create":    return opBranchCreate(mappedArgs, conn);
    case "branch_delete":    return opBranchDelete(mappedArgs, conn);
    case "branch_protect":   return opBranchProtect(mappedArgs, conn);
    case "branch_unprotect": return opBranchUnprotect(mappedArgs, conn);
    case "commit_list":      return opCommitList(mappedArgs, conn);
    case "commit_get":       return opCommitGet(mappedArgs, conn);
    case "commit_diff":      return opCommitDiff(mappedArgs, conn);
    case "commit_statuses":  return opCommitStatuses(mappedArgs, conn);
    case "tag_list":         return opTagList(mappedArgs, conn);
    case "tag_get":          return opTagGet(mappedArgs, conn);
    case "tag_create":       return opTagCreate(mappedArgs, conn);
    case "tag_delete":       return opTagDelete(mappedArgs, conn);
    case "release_list":     return opReleaseList(mappedArgs, conn);
    case "release_get":      return opReleaseGet(mappedArgs, conn);
    case "release_create":   return opReleaseCreate(mappedArgs, conn);
    case "pipeline_list":    return opPipelineList(mappedArgs, conn);
    case "pipeline_get":     return opPipelineGet(mappedArgs, conn);
    case "pipeline_create":  return opPipelineCreate(mappedArgs, conn);
    case "pipeline_cancel":  return opPipelineCancel(mappedArgs, conn);
    case "pipeline_retry":   return opPipelineRetry(mappedArgs, conn);
    case "pipeline_jobs":    return opPipelineJobs(mappedArgs, conn);
    case "job_get":          return opJobGet(mappedArgs, conn);
    case "job_log":          return opJobLog(mappedArgs, conn);
    case "user_get":         return opUserGet(mappedArgs, conn);
    case "user_me":          return opUserMe(mappedArgs, conn);
    case "user_list":        return opUserList(mappedArgs, conn);
    case "group_get":        return opGroupGet(mappedArgs, conn);
    case "group_list":       return opGroupList(mappedArgs, conn);
    case "group_projects":   return opGroupProjects(mappedArgs, conn);
    case "group_members":    return opGroupMembers(mappedArgs, conn);
    case "namespace_list":   return opNamespaceList(mappedArgs, conn);
    case "label_list":       return opLabelList(mappedArgs, conn);
    case "label_create":     return opLabelCreate(mappedArgs, conn);
    case "milestone_list":   return opMilestoneList(mappedArgs, conn);
    case "milestone_get":    return opMilestoneGet(mappedArgs, conn);
    case "milestone_create": return opMilestoneCreate(mappedArgs, conn);
    case "snippet_list":     return opSnippetList(mappedArgs, conn);
    case "snippet_get":      return opSnippetGet(mappedArgs, conn);
    case "snippet_create":   return opSnippetCreate(mappedArgs, conn);
    case "request":          return opRequest(mappedArgs, conn);
    default:
      throw new Error(
        `Unknown gitlab_client operation: '${args.operation}'. ` +
        "Use operation='info' for the full operation reference."
      );
  }
}

module.exports = {
  gitlabClient,
  buildConn, requireString, guardString, clampInt,
  parseGlJson, checkGlStatus, glRequest, glApiRequest,
  mapProject, mapIssue, mapMr, mapCommit, mapPipeline, mapJob, mapUser, mapGroup,
  enc, encPath, projId,
};
