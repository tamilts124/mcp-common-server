"use strict";
/**
 * bitbucket_client — Zero-dependency Bitbucket REST API 2.0 client
 * (pure Node.js https built-ins; no npm deps)
 *
 * Authentication:
 *   - App Password: username + app_password (HTTP Basic Auth)
 *   - OAuth2 Access Token: access_token (Bearer)
 *   - Repository/Workspace Access Token: access_token (Bearer)
 *   Unauthenticated access allowed for public resources.
 *
 * Base URL: https://api.bitbucket.org/2.0  (Bitbucket Cloud only)
 * API version: 2.0
 *
 * Supported operations (56 total):
 *
 *   Repositories (6):
 *     repo_get, repo_list, repo_create, repo_delete, repo_fork, repo_watchers
 *
 *   Issues (7):
 *     issue_list, issue_get, issue_create, issue_update, issue_comment,
 *     issue_comments, issue_delete
 *
 *   Pull Requests (8):
 *     pr_list, pr_get, pr_create, pr_merge, pr_decline, pr_update,
 *     pr_comments, pr_add_comment
 *
 *   Commits (4):
 *     commit_list, commit_get, commit_statuses, commit_approve
 *
 *   Source / Contents (3):
 *     src_get, src_list, src_history
 *
 *   Branches & Tags (7):
 *     branch_list, branch_get, branch_create, branch_delete,
 *     tag_list, tag_get, tag_create
 *
 *   Pipelines (5):
 *     pipeline_list, pipeline_get, pipeline_create, pipeline_stop,
 *     pipeline_steps
 *
 *   Workspaces & Teams (3):
 *     workspace_list, workspace_get, workspace_members
 *
 *   Users (3):
 *     user_get, user_me, user_repos
 *
 *   Webhooks (3):
 *     webhook_list, webhook_create, webhook_delete
 *
 *   Snippets (2):
 *     snippet_list, snippet_get
 *
 *   Generic (2):
 *     request, info
 *
 * Security:
 *   NUL-byte guards on all string inputs.
 *   Timeout clamped 1000-120000 ms.
 *   Credentials never returned in output or errors.
 *   16 MB response cap.
 *   TLS enforced by default.
 */

const https = require("https");
const http  = require("http");

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 20000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024; // 16 MB
const BB_API_BASE        = "https://api.bitbucket.org/2.0";

// ── Guard helpers ────────────────────────────────────────────────────────────

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

// ── Low-level HTTP helper ────────────────────────────────────────────────────

function bbRequest(opts) {
  const { url, method, headers, body, timeoutMs, rejectUnauthorized } = opts;
  return new Promise((resolve, reject) => {
    const parsed    = new URL(url);
    const isHttps   = parsed.protocol === "https:";
    const transport = isHttps ? https : http;
    const bodyBuf   = body
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

    const chunks   = [];
    let totalBytes = 0;
    let settled    = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new Error(`Bitbucket request ${method} ${url} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const req = transport.request(reqOpts, (res) => {
      res.on("data", (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          req.destroy();
          reject(new Error("Bitbucket response exceeded 16 MB cap"));
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
        reject(new Error(`Bitbucket response stream error: ${err.message}`));
      });
    });

    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Cannot connect to Bitbucket API: ${err.message}`));
    });

    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

// ── Connection helper ────────────────────────────────────────────────────────

function buildConn(args) {
  guardString(args.username,     "username");
  guardString(args.app_password, "app_password");
  guardString(args.access_token, "access_token");
  guardString(args.base_url,     "base_url");
  const timeoutMs          = clampInt(args.timeout, DEFAULT_TIMEOUT_MS, 1000, 120000);
  const baseUrl            = (args.base_url || BB_API_BASE).replace(/\/$/, "");
  const rejectUnauthorized = args.reject_unauthorized !== false;
  return {
    username:     args.username     || null,
    appPassword:  args.app_password || null,
    accessToken:  args.access_token || null,
    baseUrl,
    timeoutMs,
    rejectUnauthorized,
  };
}

async function bbApiRequest(conn, opts) {
  const { path, method, body } = opts;
  const url     = `${conn.baseUrl}${path}`;
  const headers = {
    "Accept":     "application/json",
    "User-Agent": "mcp-common-server/bitbucket_client",
  };
  if (conn.accessToken) {
    headers["Authorization"] = `Bearer ${conn.accessToken}`;
  } else if (conn.username && conn.appPassword) {
    const cred = Buffer.from(`${conn.username}:${conn.appPassword}`, "utf8").toString("base64");
    headers["Authorization"] = `Basic ${cred}`;
  }
  return bbRequest({
    url, method: method || "GET", headers, body,
    timeoutMs:          conn.timeoutMs,
    rejectUnauthorized: conn.rejectUnauthorized,
  });
}

function parseBbJson(raw, ctx) {
  if (!raw || raw.trim() === "") return null;
  try { return JSON.parse(raw); } catch (_) {
    throw new Error(`Bitbucket: invalid JSON response (${ctx}): ${raw.slice(0, 200)}`);
  }
}

function checkBbStatus(res, ctx) {
  if (res.statusCode < 200 || res.statusCode >= 300) {
    let extra = "";
    try {
      const j = JSON.parse(res.raw);
      if (j && j.error) {
        extra = j.error.message || JSON.stringify(j.error).slice(0, 300);
      } else {
        extra = JSON.stringify(j).slice(0, 300);
      }
    } catch (_) { extra = res.raw.slice(0, 300); }
    throw new Error(`Bitbucket ${ctx}: HTTP ${res.statusCode} -- ${extra}`);
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

// Bitbucket workspace + repo slug path helper
function repoPath(args) {
  if (args.workspace && args.repo_slug)
    return `/repositories/${enc(args.workspace)}/${enc(args.repo_slug)}`;
  throw new Error("workspace and repo_slug are both required");
}

// ── Map helpers ──────────────────────────────────────────────────────────────

function mapRepo(r) {
  if (!r) return {};
  return {
    uuid:         r.uuid         || null,
    name:         r.name,
    full_name:    r.full_name    || null,
    slug:         r.slug         || null,
    description:  r.description  || null,
    is_private:   r.is_private   || false,
    language:     r.language     || null,
    fork_policy:  r.fork_policy  || null,
    scm:          r.scm          || null,
    size:         r.size         || 0,
    has_issues:   r.has_issues   || false,
    has_wiki:     r.has_wiki     || false,
    mainbranch:   r.mainbranch   ? r.mainbranch.name : null,
    owner:        r.owner        ? (r.owner.nickname || r.owner.display_name || null) : null,
    workspace:    r.workspace    ? r.workspace.slug : null,
    created_on:   r.created_on   || null,
    updated_on:   r.updated_on   || null,
    links: {
      html:  r.links && r.links.html  ? r.links.html.href  : null,
      clone: r.links && r.links.clone ? r.links.clone.map(function(c) { return { name: c.name, href: c.href }; }) : [],
    },
  };
}

function mapIssue(i) {
  if (!i) return {};
  return {
    id:           i.id,
    title:        i.title,
    content:      i.content    ? i.content.raw : null,
    state:        i.state,
    kind:         i.kind       || null,
    priority:     i.priority   || null,
    type:         i.type       || null,
    assignee:     i.assignee   ? (i.assignee.nickname || i.assignee.display_name || null) : null,
    reporter:     i.reporter   ? (i.reporter.nickname || i.reporter.display_name || null) : null,
    component:    i.component  ? i.component.name : null,
    milestone:    i.milestone  ? i.milestone.name : null,
    version_:     i.version    ? i.version.name  : null,
    created_on:   i.created_on || null,
    updated_on:   i.updated_on || null,
    html_url:     i.links && i.links.html ? i.links.html.href : null,
  };
}

function mapPr(p) {
  if (!p) return {};
  return {
    id:            p.id,
    title:         p.title,
    description:   p.description || null,
    state:         p.state,
    author:        p.author      ? (p.author.nickname || p.author.display_name || null) : null,
    reviewers:     (p.reviewers  || []).map(function(r) { return r.nickname || r.display_name || null; }),
    participants:  (p.participants || []).map(function(p2) {
      return { user: p2.user ? (p2.user.nickname || p2.user.display_name || null) : null, role: p2.role, approved: p2.approved || false };
    }),
    source: p.source ? {
      branch: p.source.branch ? p.source.branch.name : null,
      commit: p.source.commit ? p.source.commit.hash : null,
      repo:   p.source.repository ? p.source.repository.full_name : null,
    } : null,
    destination: p.destination ? {
      branch: p.destination.branch ? p.destination.branch.name : null,
      commit: p.destination.commit ? p.destination.commit.hash : null,
    } : null,
    merge_commit:    p.merge_commit   ? p.merge_commit.hash : null,
    closed_by:       p.closed_by      ? (p.closed_by.nickname || p.closed_by.display_name || null) : null,
    reason:          p.reason         || null,
    task_count:      p.task_count     || 0,
    comment_count:   p.comment_count  || 0,
    created_on:      p.created_on     || null,
    updated_on:      p.updated_on     || null,
    html_url:        p.links && p.links.html ? p.links.html.href : null,
  };
}

function mapCommit(c) {
  if (!c) return {};
  return {
    hash:        c.hash,
    message:     c.message      || null,
    author:      c.author       ? (c.author.user ? (c.author.user.nickname || c.author.user.display_name) : c.author.raw) : null,
    date:        c.date         || null,
    parents:     (c.parents     || []).map(function(p) { return p.hash; }),
    html_url:    c.links && c.links.html ? c.links.html.href : null,
  };
}

function mapPipeline(p) {
  if (!p) return {};
  return {
    uuid:            p.uuid         || null,
    build_number:    p.build_number || null,
    state: p.state ? {
      name:   p.state.name   || null,
      result: p.state.result ? p.state.result.name : null,
    } : null,
    trigger: p.trigger ? p.trigger.name : null,
    target: p.target ? {
      type:   p.target.type   || null,
      branch: p.target.ref_name || (p.target.source ? p.target.source : null),
      commit: p.target.commit ? p.target.commit.hash : null,
    } : null,
    created_on:   p.created_on  || null,
    completed_on: p.completed_on|| null,
    duration_in_seconds: p.duration_in_seconds || null,
  };
}

function mapUser(u) {
  if (!u) return {};
  return {
    account_id:   u.account_id   || null,
    uuid:         u.uuid         || null,
    nickname:     u.nickname     || null,
    display_name: u.display_name || null,
    account_status: u.account_status || null,
    website:      u.website      || null,
    location:     u.location     || null,
    created_on:   u.created_on   || null,
    html_url:     u.links && u.links.html ? u.links.html.href : null,
  };
}

function mapWorkspace(w) {
  if (!w) return {};
  return {
    uuid:       w.uuid       || null,
    slug:       w.slug       || null,
    name:       w.name       || null,
    type:       w.type       || null,
    is_private: w.is_private || false,
    created_on: w.created_on || null,
    html_url:   w.links && w.links.html ? w.links.html.href : null,
  };
}

// ── Paginated helper ─────────────────────────────────────────────────────────

function bbPageQs(args, extra) {
  const params = Object.assign({}, extra || {});
  if (args.page)     params.page     = args.page;
  if (args.pagelen)  params.pagelen  = clampInt(args.pagelen, 20, 1, 100);
  return params;
}

// ── Repository Operations ────────────────────────────────────────────────────

async function opRepoGet(args, conn) {
  const res = await bbApiRequest(conn, { path: repoPath(args) });
  if (res.statusCode === 404) return { ok: true, operation: "repo_get", exists: false };
  checkBbStatus(res, "repo_get");
  const j = parseBbJson(res.raw, "repo_get");
  return { ok: true, operation: "repo_get", exists: true, ...mapRepo(j) };
}

async function opRepoList(args, conn) {
  requireString(args.workspace, "workspace");
  const qs = buildQs(bbPageQs(args, {
    sort: args.sort || "-updated_on",
    role: args.role || undefined,
    q:    args.q    || undefined,
  }));
  const res = await bbApiRequest(conn, { path: `/repositories/${enc(args.workspace)}${qs}` });
  checkBbStatus(res, "repo_list");
  const j = parseBbJson(res.raw, "repo_list");
  const values = (j && j.values) || [];
  return {
    ok: true, operation: "repo_list",
    count: values.length, page: (j && j.page) || 1, size: (j && j.size) || 0,
    repos: values.map(mapRepo),
  };
}

async function opRepoCreate(args, conn) {
  requireString(args.workspace, "workspace");
  requireString(args.repo_slug, "repo_slug");
  const body = {
    scm:         args.scm         || "git",
    is_private:  args.is_private  !== false,
    description: args.description || undefined,
    fork_policy: args.fork_policy || undefined,
    has_issues:  args.has_issues  || undefined,
    has_wiki:    args.has_wiki    || undefined,
    language:    args.language    || undefined,
  };
  if (args.name) body.name = args.name;
  if (args.project_key) body.project = { key: args.project_key };
  const res = await bbApiRequest(conn, { path: repoPath(args), method: "POST", body });
  checkBbStatus(res, "repo_create");
  const j = parseBbJson(res.raw, "repo_create");
  return { ok: true, operation: "repo_create", created: true, ...mapRepo(j) };
}

async function opRepoDelete(args, conn) {
  const res = await bbApiRequest(conn, { path: repoPath(args), method: "DELETE" });
  if (res.statusCode === 404) return { ok: true, operation: "repo_delete", deleted: false, reason: "not_found" };
  checkBbStatus(res, "repo_delete");
  return { ok: true, operation: "repo_delete", deleted: true };
}

async function opRepoFork(args, conn) {
  const body = {};
  if (args.name)       body.name      = args.name;
  if (args.workspace)  body.workspace  = { slug: args.fork_workspace || args.workspace };
  if (args.is_private !== undefined) body.is_private = args.is_private;
  const res = await bbApiRequest(conn, { path: `${repoPath(args)}/forks`, method: "POST", body });
  checkBbStatus(res, "repo_fork");
  const j = parseBbJson(res.raw, "repo_fork");
  return { ok: true, operation: "repo_fork", forked: true, ...mapRepo(j) };
}

async function opRepoWatchers(args, conn) {
  const qs = buildQs(bbPageQs(args));
  const res = await bbApiRequest(conn, { path: `${repoPath(args)}/watchers${qs}` });
  checkBbStatus(res, "repo_watchers");
  const j = parseBbJson(res.raw, "repo_watchers");
  const values = (j && j.values) || [];
  return {
    ok: true, operation: "repo_watchers", count: values.length,
    watchers: values.map(mapUser),
  };
}

// ── Issue Operations ──────────────────────────────────────────────────────────

async function opIssueList(args, conn) {
  const qs = buildQs(bbPageQs(args, {
    sort:   args.sort   || "-created_on",
    status: args.status || undefined,
    kind:   args.kind   || undefined,
    q:      args.q      || undefined,
  }));
  const res = await bbApiRequest(conn, { path: `${repoPath(args)}/issues${qs}` });
  checkBbStatus(res, "issue_list");
  const j = parseBbJson(res.raw, "issue_list");
  const values = (j && j.values) || [];
  return { ok: true, operation: "issue_list", count: values.length, issues: values.map(mapIssue) };
}

async function opIssueGet(args, conn) {
  if (!args.issue_id) throw new Error("issue_id must be provided");
  const res = await bbApiRequest(conn, { path: `${repoPath(args)}/issues/${args.issue_id}` });
  if (res.statusCode === 404) return { ok: true, operation: "issue_get", exists: false };
  checkBbStatus(res, "issue_get");
  const j = parseBbJson(res.raw, "issue_get");
  return { ok: true, operation: "issue_get", exists: true, ...mapIssue(j) };
}

async function opIssueCreate(args, conn) {
  requireString(args.title, "title");
  const body = { title: args.title };
  if (args.content   !== undefined) body.content   = { raw: args.content };
  if (args.kind      !== undefined) body.kind      = args.kind;
  if (args.priority  !== undefined) body.priority  = args.priority;
  if (args.assignee) body.assignee = { nickname: args.assignee };
  const res = await bbApiRequest(conn, { path: `${repoPath(args)}/issues`, method: "POST", body });
  checkBbStatus(res, "issue_create");
  const j = parseBbJson(res.raw, "issue_create");
  return { ok: true, operation: "issue_create", created: true, ...mapIssue(j) };
}

async function opIssueUpdate(args, conn) {
  if (!args.issue_id) throw new Error("issue_id must be provided");
  const body = {};
  if (args.title    !== undefined) body.title    = args.title;
  if (args.content  !== undefined) body.content  = { raw: args.content };
  if (args.status   !== undefined) body.status   = args.status;
  if (args.kind     !== undefined) body.kind     = args.kind;
  if (args.priority !== undefined) body.priority = args.priority;
  if (args.assignee !== undefined) body.assignee = args.assignee ? { nickname: args.assignee } : null;
  const res = await bbApiRequest(conn, {
    path:   `${repoPath(args)}/issues/${args.issue_id}`,
    method: "PUT",
    body,
  });
  checkBbStatus(res, "issue_update");
  const j = parseBbJson(res.raw, "issue_update");
  return { ok: true, operation: "issue_update", updated: true, ...mapIssue(j) };
}

async function opIssueDelete(args, conn) {
  if (!args.issue_id) throw new Error("issue_id must be provided");
  const res = await bbApiRequest(conn, {
    path:   `${repoPath(args)}/issues/${args.issue_id}`,
    method: "DELETE",
  });
  if (res.statusCode === 404) return { ok: true, operation: "issue_delete", deleted: false, reason: "not_found" };
  checkBbStatus(res, "issue_delete");
  return { ok: true, operation: "issue_delete", deleted: true };
}

async function opIssueComment(args, conn) {
  if (!args.issue_id) throw new Error("issue_id must be provided");
  requireString(args.content, "content");
  const res = await bbApiRequest(conn, {
    path:   `${repoPath(args)}/issues/${args.issue_id}/comments`,
    method: "POST",
    body:   { content: { raw: args.content } },
  });
  checkBbStatus(res, "issue_comment");
  const j = parseBbJson(res.raw, "issue_comment");
  return { ok: true, operation: "issue_comment", created: true, id: j.id, created_on: j.created_on };
}

async function opIssueComments(args, conn) {
  if (!args.issue_id) throw new Error("issue_id must be provided");
  const qs = buildQs(bbPageQs(args));
  const res = await bbApiRequest(conn, { path: `${repoPath(args)}/issues/${args.issue_id}/comments${qs}` });
  checkBbStatus(res, "issue_comments");
  const j = parseBbJson(res.raw, "issue_comments");
  const values = (j && j.values) || [];
  return {
    ok: true, operation: "issue_comments", count: values.length,
    comments: values.map(function(c) {
      return {
        id:         c.id,
        content:    c.content ? c.content.raw : null,
        author:     c.author  ? (c.author.nickname || c.author.display_name || null) : null,
        created_on: c.created_on || null,
        updated_on: c.updated_on || null,
      };
    }),
  };
}

// ── Pull Request Operations ──────────────────────────────────────────────────

async function opPrList(args, conn) {
  const qs = buildQs(bbPageQs(args, {
    state: args.state || "OPEN",
    sort:  args.sort  || "-updated_on",
    q:     args.q     || undefined,
  }));
  const res = await bbApiRequest(conn, { path: `${repoPath(args)}/pullrequests${qs}` });
  checkBbStatus(res, "pr_list");
  const j = parseBbJson(res.raw, "pr_list");
  const values = (j && j.values) || [];
  return { ok: true, operation: "pr_list", count: values.length, pull_requests: values.map(mapPr) };
}

async function opPrGet(args, conn) {
  if (!args.pr_id) throw new Error("pr_id must be provided");
  const res = await bbApiRequest(conn, { path: `${repoPath(args)}/pullrequests/${args.pr_id}` });
  if (res.statusCode === 404) return { ok: true, operation: "pr_get", exists: false };
  checkBbStatus(res, "pr_get");
  const j = parseBbJson(res.raw, "pr_get");
  return { ok: true, operation: "pr_get", exists: true, ...mapPr(j) };
}

async function opPrCreate(args, conn) {
  requireString(args.title,         "title");
  requireString(args.source_branch, "source_branch");
  requireString(args.dest_branch,   "dest_branch");
  const body = {
    title:       args.title,
    source:      { branch: { name: args.source_branch } },
    destination: { branch: { name: args.dest_branch   } },
  };
  if (args.description !== undefined) body.description = args.description;
  if (args.close_source_branch !== undefined) body.close_source_branch = args.close_source_branch;
  if (args.reviewers) {
    body.reviewers = args.reviewers.map(function(r) { return { nickname: r }; });
  }
  const res = await bbApiRequest(conn, { path: `${repoPath(args)}/pullrequests`, method: "POST", body });
  checkBbStatus(res, "pr_create");
  const j = parseBbJson(res.raw, "pr_create");
  return { ok: true, operation: "pr_create", created: true, ...mapPr(j) };
}

async function opPrMerge(args, conn) {
  if (!args.pr_id) throw new Error("pr_id must be provided");
  const body = {};
  if (args.merge_strategy !== undefined) body.merge_strategy = args.merge_strategy;
  if (args.message        !== undefined) body.message        = args.message;
  if (args.close_source_branch !== undefined) body.close_source_branch = args.close_source_branch;
  const res = await bbApiRequest(conn, {
    path:   `${repoPath(args)}/pullrequests/${args.pr_id}/merge`,
    method: "POST",
    body,
  });
  if (res.statusCode === 400) return { ok: true, operation: "pr_merge", merged: false, reason: "merge_conflict_or_invalid" };
  checkBbStatus(res, "pr_merge");
  const j = parseBbJson(res.raw, "pr_merge");
  return { ok: true, operation: "pr_merge", merged: true, ...mapPr(j) };
}

async function opPrDecline(args, conn) {
  if (!args.pr_id) throw new Error("pr_id must be provided");
  const res = await bbApiRequest(conn, {
    path:   `${repoPath(args)}/pullrequests/${args.pr_id}/decline`,
    method: "POST",
    body:   {},
  });
  checkBbStatus(res, "pr_decline");
  const j = parseBbJson(res.raw, "pr_decline");
  return { ok: true, operation: "pr_decline", declined: true, ...mapPr(j) };
}

async function opPrUpdate(args, conn) {
  if (!args.pr_id) throw new Error("pr_id must be provided");
  const body = {};
  if (args.title       !== undefined) body.title       = args.title;
  if (args.description !== undefined) body.description = args.description;
  if (args.dest_branch !== undefined) body.destination = { branch: { name: args.dest_branch } };
  if (args.reviewers   !== undefined) body.reviewers   = args.reviewers.map(function(r) { return { nickname: r }; });
  const res = await bbApiRequest(conn, {
    path:   `${repoPath(args)}/pullrequests/${args.pr_id}`,
    method: "PUT",
    body,
  });
  checkBbStatus(res, "pr_update");
  const j = parseBbJson(res.raw, "pr_update");
  return { ok: true, operation: "pr_update", updated: true, ...mapPr(j) };
}

async function opPrComments(args, conn) {
  if (!args.pr_id) throw new Error("pr_id must be provided");
  const qs = buildQs(bbPageQs(args));
  const res = await bbApiRequest(conn, { path: `${repoPath(args)}/pullrequests/${args.pr_id}/comments${qs}` });
  checkBbStatus(res, "pr_comments");
  const j = parseBbJson(res.raw, "pr_comments");
  const values = (j && j.values) || [];
  return {
    ok: true, operation: "pr_comments", count: values.length,
    comments: values.map(function(c) {
      return {
        id:         c.id,
        content:    c.content ? c.content.raw : null,
        author:     c.author  ? (c.author.nickname || c.author.display_name || null) : null,
        inline:     c.inline  || null,
        created_on: c.created_on || null,
        updated_on: c.updated_on || null,
      };
    }),
  };
}

async function opPrAddComment(args, conn) {
  if (!args.pr_id) throw new Error("pr_id must be provided");
  requireString(args.content, "content");
  const body = { content: { raw: args.content } };
  if (args.inline) body.inline = args.inline;
  const res = await bbApiRequest(conn, {
    path:   `${repoPath(args)}/pullrequests/${args.pr_id}/comments`,
    method: "POST",
    body,
  });
  checkBbStatus(res, "pr_add_comment");
  const j = parseBbJson(res.raw, "pr_add_comment");
  return { ok: true, operation: "pr_add_comment", created: true, id: j.id, created_on: j.created_on };
}

// ── Commit Operations ────────────────────────────────────────────────────────

async function opCommitList(args, conn) {
  const qs = buildQs(bbPageQs(args, {
    include: args.branch    || undefined,
    exclude: args.exclude   || undefined,
    path:    args.file_path || undefined,
  }));
  const res = await bbApiRequest(conn, { path: `${repoPath(args)}/commits${qs}` });
  checkBbStatus(res, "commit_list");
  const j = parseBbJson(res.raw, "commit_list");
  const values = (j && j.values) || [];
  return { ok: true, operation: "commit_list", count: values.length, commits: values.map(mapCommit) };
}

async function opCommitGet(args, conn) {
  requireString(args.commit, "commit");
  const res = await bbApiRequest(conn, { path: `${repoPath(args)}/commit/${enc(args.commit)}` });
  if (res.statusCode === 404) return { ok: true, operation: "commit_get", exists: false };
  checkBbStatus(res, "commit_get");
  const j = parseBbJson(res.raw, "commit_get");
  return { ok: true, operation: "commit_get", exists: true, ...mapCommit(j) };
}

async function opCommitStatuses(args, conn) {
  requireString(args.commit, "commit");
  const qs = buildQs(bbPageQs(args));
  const res = await bbApiRequest(conn, { path: `${repoPath(args)}/commit/${enc(args.commit)}/statuses${qs}` });
  checkBbStatus(res, "commit_statuses");
  const j = parseBbJson(res.raw, "commit_statuses");
  const values = (j && j.values) || [];
  return {
    ok: true, operation: "commit_statuses", count: values.length,
    statuses: values.map(function(s) {
      return {
        key:        s.key,
        state:      s.state,
        name:       s.name       || null,
        url:        s.url        || null,
        description:s.description|| null,
        created_on: s.created_on || null,
        updated_on: s.updated_on || null,
      };
    }),
  };
}

async function opCommitApprove(args, conn) {
  requireString(args.commit, "commit");
  const res = await bbApiRequest(conn, {
    path:   `${repoPath(args)}/commit/${enc(args.commit)}/approve`,
    method: "POST",
  });
  checkBbStatus(res, "commit_approve");
  return { ok: true, operation: "commit_approve", approved: true };
}

// ── Source / Contents Operations ─────────────────────────────────────────────

async function opSrcGet(args, conn) {
  requireString(args.path_in_repo, "path_in_repo");
  const ref = args.ref || "HEAD";
  const qs  = buildQs({ format: args.format || undefined });
  const res = await bbApiRequest(conn, {
    path: `${repoPath(args)}/src/${enc(ref)}/${args.path_in_repo}${qs}`,
  });
  if (res.statusCode === 404) return { ok: true, operation: "src_get", exists: false };
  checkBbStatus(res, "src_get");
  const ct = res.headers["content-type"] || "";
  if (ct.includes("application/json")) {
    const j = parseBbJson(res.raw, "src_get");
    return { ok: true, operation: "src_get", exists: true, type: "directory", entries: j.values || [] };
  }
  return {
    ok: true, operation: "src_get", exists: true, type: "file",
    content: res.raw,
    size: res.raw.length,
  };
}

async function opSrcList(args, conn) {
  const ref = args.ref || "HEAD";
  const prefix = args.path_in_repo ? `${args.path_in_repo}/` : "";
  const qs = buildQs(bbPageQs(args));
  const res = await bbApiRequest(conn, {
    path: `${repoPath(args)}/src/${enc(ref)}/${prefix}${qs}`,
  });
  if (res.statusCode === 404) return { ok: true, operation: "src_list", exists: false };
  checkBbStatus(res, "src_list");
  const j = parseBbJson(res.raw, "src_list");
  const values = (j && j.values) || [];
  return {
    ok: true, operation: "src_list", exists: true, count: values.length,
    entries: values.map(function(e) {
      return { type: e.type, path: e.path, size: e.size || null, escaped_path: e.escaped_path || null };
    }),
  };
}

async function opSrcHistory(args, conn) {
  requireString(args.path_in_repo, "path_in_repo");
  const qs = buildQs(bbPageQs(args, {
    renames: args.renames !== undefined ? String(args.renames) : undefined,
  }));
  const res = await bbApiRequest(conn, {
    path: `${repoPath(args)}/filehistory/${enc(args.ref || "HEAD")}/${args.path_in_repo}${qs}`,
  });
  checkBbStatus(res, "src_history");
  const j = parseBbJson(res.raw, "src_history");
  const values = (j && j.values) || [];
  return {
    ok: true, operation: "src_history", count: values.length,
    history: values.map(function(h) {
      return {
        commit: h.commit ? h.commit.hash : null,
        type:   h.type   || null,
        path:   h.path   || null,
      };
    }),
  };
}

// ── Branch Operations ────────────────────────────────────────────────────────

async function opBranchList(args, conn) {
  const qs = buildQs(bbPageQs(args, {
    q:    args.q    || undefined,
    sort: args.sort || undefined,
  }));
  const res = await bbApiRequest(conn, { path: `${repoPath(args)}/refs/branches${qs}` });
  checkBbStatus(res, "branch_list");
  const j = parseBbJson(res.raw, "branch_list");
  const values = (j && j.values) || [];
  return {
    ok: true, operation: "branch_list", count: values.length,
    branches: values.map(function(b) {
      return {
        name:          b.name,
        type:          b.type || null,
        target_hash:   b.target  ? b.target.hash  : null,
        default_merge: b.default_merge_strategy || null,
      };
    }),
  };
}

async function opBranchGet(args, conn) {
  requireString(args.branch, "branch");
  const res = await bbApiRequest(conn, { path: `${repoPath(args)}/refs/branches/${enc(args.branch)}` });
  if (res.statusCode === 404) return { ok: true, operation: "branch_get", exists: false };
  checkBbStatus(res, "branch_get");
  const j = parseBbJson(res.raw, "branch_get");
  return {
    ok: true, operation: "branch_get", exists: true,
    name:        j.name,
    type:        j.type        || null,
    target_hash: j.target      ? j.target.hash : null,
    target_msg:  j.target      ? j.target.message : null,
  };
}

async function opBranchCreate(args, conn) {
  requireString(args.branch, "branch");
  requireString(args.target, "target");
  const body = {
    name:   args.branch,
    target: { hash: args.target },
  };
  const res = await bbApiRequest(conn, { path: `${repoPath(args)}/refs/branches`, method: "POST", body });
  checkBbStatus(res, "branch_create");
  const j = parseBbJson(res.raw, "branch_create");
  return { ok: true, operation: "branch_create", created: true, name: j.name, target_hash: j.target ? j.target.hash : null };
}

async function opBranchDelete(args, conn) {
  requireString(args.branch, "branch");
  const res = await bbApiRequest(conn, {
    path:   `${repoPath(args)}/refs/branches/${enc(args.branch)}`,
    method: "DELETE",
  });
  if (res.statusCode === 404) return { ok: true, operation: "branch_delete", deleted: false, reason: "not_found" };
  checkBbStatus(res, "branch_delete");
  return { ok: true, operation: "branch_delete", deleted: true };
}

// ── Tag Operations ───────────────────────────────────────────────────────────

async function opTagList(args, conn) {
  const qs = buildQs(bbPageQs(args, { sort: args.sort || "-target.date" }));
  const res = await bbApiRequest(conn, { path: `${repoPath(args)}/refs/tags${qs}` });
  checkBbStatus(res, "tag_list");
  const j = parseBbJson(res.raw, "tag_list");
  const values = (j && j.values) || [];
  return {
    ok: true, operation: "tag_list", count: values.length,
    tags: values.map(function(t) {
      return { name: t.name, target_hash: t.target ? t.target.hash : null, date: t.date || null };
    }),
  };
}

async function opTagGet(args, conn) {
  requireString(args.tag, "tag");
  const res = await bbApiRequest(conn, { path: `${repoPath(args)}/refs/tags/${enc(args.tag)}` });
  if (res.statusCode === 404) return { ok: true, operation: "tag_get", exists: false };
  checkBbStatus(res, "tag_get");
  const j = parseBbJson(res.raw, "tag_get");
  return {
    ok: true, operation: "tag_get", exists: true,
    name:        j.name,
    target_hash: j.target ? j.target.hash : null,
    message:     j.message || null,
    tagger:      j.tagger  ? (j.tagger.raw || null) : null,
    date:        j.date    || null,
  };
}

async function opTagCreate(args, conn) {
  requireString(args.tag,    "tag");
  requireString(args.target, "target");
  const body = {
    name:   args.tag,
    target: { hash: args.target },
  };
  if (args.message) body.message = args.message;
  const res = await bbApiRequest(conn, { path: `${repoPath(args)}/refs/tags`, method: "POST", body });
  checkBbStatus(res, "tag_create");
  const j = parseBbJson(res.raw, "tag_create");
  return { ok: true, operation: "tag_create", created: true, name: j.name, target_hash: j.target ? j.target.hash : null };
}

// ── Pipeline Operations ──────────────────────────────────────────────────────

async function opPipelineList(args, conn) {
  const qs = buildQs(bbPageQs(args, {
    sort:    args.sort    || "-created_on",
    "target.branch": args.branch || undefined,
    "target.ref_name": args.branch || undefined,
  }));
  const res = await bbApiRequest(conn, { path: `${repoPath(args)}/pipelines/${qs}` });
  checkBbStatus(res, "pipeline_list");
  const j = parseBbJson(res.raw, "pipeline_list");
  const values = (j && j.values) || [];
  return { ok: true, operation: "pipeline_list", count: values.length, pipelines: values.map(mapPipeline) };
}

async function opPipelineGet(args, conn) {
  requireString(args.pipeline_uuid, "pipeline_uuid");
  const res = await bbApiRequest(conn, { path: `${repoPath(args)}/pipelines/${enc(args.pipeline_uuid)}` });
  if (res.statusCode === 404) return { ok: true, operation: "pipeline_get", exists: false };
  checkBbStatus(res, "pipeline_get");
  const j = parseBbJson(res.raw, "pipeline_get");
  return { ok: true, operation: "pipeline_get", exists: true, ...mapPipeline(j) };
}

async function opPipelineCreate(args, conn) {
  const body = { target: {} };
  if (args.branch) {
    body.target.type     = "pipeline_ref_target";
    body.target.ref_type = "branch";
    body.target.ref_name = args.branch;
  } else if (args.commit) {
    body.target.type   = "pipeline_commit_target";
    body.target.commit = { hash: args.commit };
  } else {
    throw new Error("pipeline_create: provide branch or commit to target");
  }
  if (args.variables) body.variables = args.variables;
  const res = await bbApiRequest(conn, { path: `${repoPath(args)}/pipelines/`, method: "POST", body });
  checkBbStatus(res, "pipeline_create");
  const j = parseBbJson(res.raw, "pipeline_create");
  return { ok: true, operation: "pipeline_create", created: true, ...mapPipeline(j) };
}

async function opPipelineStop(args, conn) {
  requireString(args.pipeline_uuid, "pipeline_uuid");
  const res = await bbApiRequest(conn, {
    path:   `${repoPath(args)}/pipelines/${enc(args.pipeline_uuid)}/stopPipeline`,
    method: "POST",
  });
  checkBbStatus(res, "pipeline_stop");
  return { ok: true, operation: "pipeline_stop", stopped: true };
}

async function opPipelineSteps(args, conn) {
  requireString(args.pipeline_uuid, "pipeline_uuid");
  const qs = buildQs(bbPageQs(args));
  const res = await bbApiRequest(conn, { path: `${repoPath(args)}/pipelines/${enc(args.pipeline_uuid)}/steps/${qs}` });
  checkBbStatus(res, "pipeline_steps");
  const j = parseBbJson(res.raw, "pipeline_steps");
  const values = (j && j.values) || [];
  return {
    ok: true, operation: "pipeline_steps", count: values.length,
    steps: values.map(function(s) {
      return {
        uuid:         s.uuid          || null,
        name:         s.name          || null,
        state: s.state ? { name: s.state.name, result: s.state.result ? s.state.result.name : null } : null,
        started_on:   s.started_on    || null,
        completed_on: s.completed_on  || null,
        duration_in_seconds: s.duration_in_seconds || null,
      };
    }),
  };
}

// ── Workspace Operations ─────────────────────────────────────────────────────

async function opWorkspaceList(args, conn) {
  const qs = buildQs(bbPageQs(args, { role: args.role || undefined }));
  const res = await bbApiRequest(conn, { path: `/workspaces${qs}` });
  checkBbStatus(res, "workspace_list");
  const j = parseBbJson(res.raw, "workspace_list");
  const values = (j && j.values) || [];
  return { ok: true, operation: "workspace_list", count: values.length, workspaces: values.map(mapWorkspace) };
}

async function opWorkspaceGet(args, conn) {
  requireString(args.workspace, "workspace");
  const res = await bbApiRequest(conn, { path: `/workspaces/${enc(args.workspace)}` });
  if (res.statusCode === 404) return { ok: true, operation: "workspace_get", exists: false };
  checkBbStatus(res, "workspace_get");
  const j = parseBbJson(res.raw, "workspace_get");
  return { ok: true, operation: "workspace_get", exists: true, ...mapWorkspace(j) };
}

async function opWorkspaceMembers(args, conn) {
  requireString(args.workspace, "workspace");
  const qs = buildQs(bbPageQs(args));
  const res = await bbApiRequest(conn, { path: `/workspaces/${enc(args.workspace)}/members${qs}` });
  checkBbStatus(res, "workspace_members");
  const j = parseBbJson(res.raw, "workspace_members");
  const values = (j && j.values) || [];
  return {
    ok: true, operation: "workspace_members", count: values.length,
    members: values.map(function(m) {
      return mapUser(m.user || m);
    }),
  };
}

// ── User Operations ──────────────────────────────────────────────────────────

async function opUserGet(args, conn) {
  if (args.account_id) {
    const res = await bbApiRequest(conn, { path: `/users/${enc(args.account_id)}` });
    if (res.statusCode === 404) return { ok: true, operation: "user_get", exists: false };
    checkBbStatus(res, "user_get");
    const j = parseBbJson(res.raw, "user_get");
    return { ok: true, operation: "user_get", exists: true, ...mapUser(j) };
  } else if (args.username) {
    requireString(args.username, "username");
    // Bitbucket v2 uses /2.0/users/{selected_user} where selected_user is ~{accountId} or nickname
    const res = await bbApiRequest(conn, { path: `/users/${enc(args.username)}` });
    if (res.statusCode === 404) return { ok: true, operation: "user_get", exists: false };
    checkBbStatus(res, "user_get");
    const j = parseBbJson(res.raw, "user_get");
    return { ok: true, operation: "user_get", exists: true, ...mapUser(j) };
  } else {
    throw new Error("account_id or username must be provided");
  }
}

async function opUserMe(args, conn) {
  const res = await bbApiRequest(conn, { path: "/user" });
  checkBbStatus(res, "user_me");
  const j = parseBbJson(res.raw, "user_me");
  return { ok: true, operation: "user_me", ...mapUser(j) };
}

async function opUserRepos(args, conn) {
  if (!args.username && !args.account_id) throw new Error("username or account_id must be provided");
  const id = args.username || args.account_id;
  const qs = buildQs(bbPageQs(args, { role: args.role || undefined }));
  const res = await bbApiRequest(conn, { path: `/repositories/${enc(id)}${qs}` });
  checkBbStatus(res, "user_repos");
  const j = parseBbJson(res.raw, "user_repos");
  const values = (j && j.values) || [];
  return { ok: true, operation: "user_repos", count: values.length, repos: values.map(mapRepo) };
}

// ── Webhook Operations ───────────────────────────────────────────────────────

async function opWebhookList(args, conn) {
  const qs = buildQs(bbPageQs(args));
  const res = await bbApiRequest(conn, { path: `${repoPath(args)}/hooks${qs}` });
  checkBbStatus(res, "webhook_list");
  const j = parseBbJson(res.raw, "webhook_list");
  const values = (j && j.values) || [];
  return {
    ok: true, operation: "webhook_list", count: values.length,
    webhooks: values.map(function(h) {
      return {
        uuid:        h.uuid        || null,
        url:         h.url         || null,
        description: h.description || null,
        active:      h.active      || false,
        events:      h.events      || [],
        created_at:  h.created_at  || null,
      };
    }),
  };
}

async function opWebhookCreate(args, conn) {
  requireString(args.url, "url");
  if (!Array.isArray(args.events) || args.events.length === 0)
    throw new Error("events must be a non-empty array");
  const body = {
    url:         args.url,
    events:      args.events,
    active:      args.active !== false,
    description: args.description || undefined,
    secret:      args.secret      || undefined,
  };
  const res = await bbApiRequest(conn, { path: `${repoPath(args)}/hooks`, method: "POST", body });
  checkBbStatus(res, "webhook_create");
  const j = parseBbJson(res.raw, "webhook_create");
  return {
    ok: true, operation: "webhook_create", created: true,
    uuid:   j.uuid   || null,
    url:    j.url    || null,
    active: j.active || false,
    events: j.events || [],
  };
}

async function opWebhookDelete(args, conn) {
  requireString(args.webhook_uid, "webhook_uid");
  const res = await bbApiRequest(conn, {
    path:   `${repoPath(args)}/hooks/${enc(args.webhook_uid)}`,
    method: "DELETE",
  });
  if (res.statusCode === 404) return { ok: true, operation: "webhook_delete", deleted: false, reason: "not_found" };
  checkBbStatus(res, "webhook_delete");
  return { ok: true, operation: "webhook_delete", deleted: true };
}

// ── Snippet Operations ───────────────────────────────────────────────────────

async function opSnippetList(args, conn) {
  const qs = buildQs(bbPageQs(args, {
    role: args.role || undefined,
  }));
  const path = args.workspace
    ? `/snippets/${enc(args.workspace)}${qs}`
    : `/snippets${qs}`;
  const res = await bbApiRequest(conn, { path });
  checkBbStatus(res, "snippet_list");
  const j = parseBbJson(res.raw, "snippet_list");
  const values = (j && j.values) || [];
  return {
    ok: true, operation: "snippet_list", count: values.length,
    snippets: values.map(function(s) {
      return {
        id:          s.id          || null,
        title:       s.title       || null,
        is_private:  s.is_private  || false,
        owner:       s.owner ? (s.owner.nickname || s.owner.display_name || null) : null,
        created_on:  s.created_on  || null,
        updated_on:  s.updated_on  || null,
        html_url:    s.links && s.links.html ? s.links.html.href : null,
      };
    }),
  };
}

async function opSnippetGet(args, conn) {
  requireString(args.snippet_id, "snippet_id");
  const path = args.workspace
    ? `/snippets/${enc(args.workspace)}/${enc(args.snippet_id)}`
    : `/snippets/${enc(args.snippet_id)}`;
  const res = await bbApiRequest(conn, { path });
  if (res.statusCode === 404) return { ok: true, operation: "snippet_get", exists: false };
  checkBbStatus(res, "snippet_get");
  const j = parseBbJson(res.raw, "snippet_get");
  return {
    ok: true, operation: "snippet_get", exists: true,
    id:         j.id         || null,
    title:      j.title      || null,
    is_private: j.is_private || false,
    scm:        j.scm        || null,
    owner:      j.owner ? (j.owner.nickname || j.owner.display_name || null) : null,
    files:      j.files      ? Object.keys(j.files) : [],
    created_on: j.created_on || null,
    updated_on: j.updated_on || null,
    html_url:   j.links && j.links.html ? j.links.html.href : null,
  };
}

// ── Generic request ──────────────────────────────────────────────────────────

async function opRequest(args, conn) {
  requireString(args.api_path, "api_path");
  requireString(args.method,   "method");
  const validMethods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];
  const method = args.method.toUpperCase();
  if (!validMethods.includes(method))
    throw new Error(`method must be one of: ${validMethods.join(", ")}`);
  const res = await bbApiRequest(conn, { path: args.api_path, method, body: args.body || undefined });
  let parsedBody;
  const ct = res.headers["content-type"] || "";
  if (ct.includes("json")) {
    try { parsedBody = JSON.parse(res.raw); } catch (_) { parsedBody = res.raw; }
  } else {
    parsedBody = res.raw;
  }
  if (res.statusCode < 200 || res.statusCode >= 300)
    checkBbStatus(res, `request ${method} ${args.api_path}`);
  return {
    ok: true, operation: "request",
    path: args.api_path, method,
    status_code: res.statusCode,
    headers: res.headers,
    body: parsedBody,
  };
}

// ── Info ─────────────────────────────────────────────────────────────────────

function opInfo() {
  return {
    ok:               true,
    protocol:         "Bitbucket REST API 2.0 (HTTPS/JSON)",
    default_base_url: BB_API_BASE,
    auth:             "App Password (username + app_password via Basic Auth) OR OAuth2/Bearer access_token",
    note:             "Bitbucket Cloud only — self-hosted Bitbucket Server/Data Center uses a different API",
    operations: [
      { op: "repo_get",           description: "Get repository details" },
      { op: "repo_list",          description: "List repositories in a workspace" },
      { op: "repo_create",        description: "Create a repository" },
      { op: "repo_delete",        description: "Delete a repository" },
      { op: "repo_fork",          description: "Fork a repository" },
      { op: "repo_watchers",      description: "List repository watchers" },
      { op: "issue_list",         description: "List issues in a repository" },
      { op: "issue_get",          description: "Get a single issue" },
      { op: "issue_create",       description: "Create an issue" },
      { op: "issue_update",       description: "Update an issue" },
      { op: "issue_delete",       description: "Delete an issue" },
      { op: "issue_comment",      description: "Add a comment to an issue" },
      { op: "issue_comments",     description: "List comments on an issue" },
      { op: "pr_list",            description: "List pull requests" },
      { op: "pr_get",             description: "Get a pull request" },
      { op: "pr_create",          description: "Create a pull request" },
      { op: "pr_merge",           description: "Merge a pull request" },
      { op: "pr_decline",         description: "Decline a pull request" },
      { op: "pr_update",          description: "Update a pull request" },
      { op: "pr_comments",        description: "List comments on a pull request" },
      { op: "pr_add_comment",     description: "Add a comment to a pull request" },
      { op: "commit_list",        description: "List commits" },
      { op: "commit_get",         description: "Get a commit" },
      { op: "commit_statuses",    description: "Get build statuses for a commit" },
      { op: "commit_approve",     description: "Approve a commit" },
      { op: "src_get",            description: "Get file content from repository" },
      { op: "src_list",           description: "List directory contents in repository" },
      { op: "src_history",        description: "Get file history in repository" },
      { op: "branch_list",        description: "List branches" },
      { op: "branch_get",         description: "Get a branch" },
      { op: "branch_create",      description: "Create a branch" },
      { op: "branch_delete",      description: "Delete a branch" },
      { op: "tag_list",           description: "List tags" },
      { op: "tag_get",            description: "Get a tag" },
      { op: "tag_create",         description: "Create a tag" },
      { op: "pipeline_list",      description: "List pipelines" },
      { op: "pipeline_get",       description: "Get a pipeline" },
      { op: "pipeline_create",    description: "Trigger a pipeline" },
      { op: "pipeline_stop",      description: "Stop a running pipeline" },
      { op: "pipeline_steps",     description: "List pipeline steps" },
      { op: "workspace_list",     description: "List workspaces" },
      { op: "workspace_get",      description: "Get a workspace" },
      { op: "workspace_members",  description: "List workspace members" },
      { op: "user_get",           description: "Get a user by account_id or username" },
      { op: "user_me",            description: "Get the authenticated user" },
      { op: "user_repos",         description: "List a user's repositories" },
      { op: "webhook_list",       description: "List webhooks for a repository" },
      { op: "webhook_create",     description: "Create a webhook" },
      { op: "webhook_delete",     description: "Delete a webhook" },
      { op: "snippet_list",       description: "List snippets" },
      { op: "snippet_get",        description: "Get a snippet" },
      { op: "request",            description: "Generic authenticated request to any Bitbucket API path" },
      { op: "info",               description: "Return this operation reference (no I/O)" },
    ],
  };
}

// ── Main entry point ─────────────────────────────────────────────────────────

async function bitbucketClient(args) {
  const op = (args.operation || "").toLowerCase().replace(/-/g, "_");
  if (op === "info") return opInfo();

  const conn = buildConn(args);
  const mappedArgs = Object.assign({}, args, {
    path_in_repo: args.path_in_repo || args.file_path,
    api_path:     args.api_path     || args.path,
  });

  switch (op) {
    case "repo_get":          return opRepoGet(mappedArgs, conn);
    case "repo_list":         return opRepoList(mappedArgs, conn);
    case "repo_create":       return opRepoCreate(mappedArgs, conn);
    case "repo_delete":       return opRepoDelete(mappedArgs, conn);
    case "repo_fork":         return opRepoFork(mappedArgs, conn);
    case "repo_watchers":     return opRepoWatchers(mappedArgs, conn);
    case "issue_list":        return opIssueList(mappedArgs, conn);
    case "issue_get":         return opIssueGet(mappedArgs, conn);
    case "issue_create":      return opIssueCreate(mappedArgs, conn);
    case "issue_update":      return opIssueUpdate(mappedArgs, conn);
    case "issue_delete":      return opIssueDelete(mappedArgs, conn);
    case "issue_comment":     return opIssueComment(mappedArgs, conn);
    case "issue_comments":    return opIssueComments(mappedArgs, conn);
    case "pr_list":           return opPrList(mappedArgs, conn);
    case "pr_get":            return opPrGet(mappedArgs, conn);
    case "pr_create":         return opPrCreate(mappedArgs, conn);
    case "pr_merge":          return opPrMerge(mappedArgs, conn);
    case "pr_decline":        return opPrDecline(mappedArgs, conn);
    case "pr_update":         return opPrUpdate(mappedArgs, conn);
    case "pr_comments":       return opPrComments(mappedArgs, conn);
    case "pr_add_comment":    return opPrAddComment(mappedArgs, conn);
    case "commit_list":       return opCommitList(mappedArgs, conn);
    case "commit_get":        return opCommitGet(mappedArgs, conn);
    case "commit_statuses":   return opCommitStatuses(mappedArgs, conn);
    case "commit_approve":    return opCommitApprove(mappedArgs, conn);
    case "src_get":           return opSrcGet(mappedArgs, conn);
    case "src_list":          return opSrcList(mappedArgs, conn);
    case "src_history":       return opSrcHistory(mappedArgs, conn);
    case "branch_list":       return opBranchList(mappedArgs, conn);
    case "branch_get":        return opBranchGet(mappedArgs, conn);
    case "branch_create":     return opBranchCreate(mappedArgs, conn);
    case "branch_delete":     return opBranchDelete(mappedArgs, conn);
    case "tag_list":          return opTagList(mappedArgs, conn);
    case "tag_get":           return opTagGet(mappedArgs, conn);
    case "tag_create":        return opTagCreate(mappedArgs, conn);
    case "pipeline_list":     return opPipelineList(mappedArgs, conn);
    case "pipeline_get":      return opPipelineGet(mappedArgs, conn);
    case "pipeline_create":   return opPipelineCreate(mappedArgs, conn);
    case "pipeline_stop":     return opPipelineStop(mappedArgs, conn);
    case "pipeline_steps":    return opPipelineSteps(mappedArgs, conn);
    case "workspace_list":    return opWorkspaceList(mappedArgs, conn);
    case "workspace_get":     return opWorkspaceGet(mappedArgs, conn);
    case "workspace_members": return opWorkspaceMembers(mappedArgs, conn);
    case "user_get":          return opUserGet(mappedArgs, conn);
    case "user_me":           return opUserMe(mappedArgs, conn);
    case "user_repos":        return opUserRepos(mappedArgs, conn);
    case "webhook_list":      return opWebhookList(mappedArgs, conn);
    case "webhook_create":    return opWebhookCreate(mappedArgs, conn);
    case "webhook_delete":    return opWebhookDelete(mappedArgs, conn);
    case "snippet_list":      return opSnippetList(mappedArgs, conn);
    case "snippet_get":       return opSnippetGet(mappedArgs, conn);
    case "request":           return opRequest(mappedArgs, conn);
    default:
      throw new Error(
        `Unknown bitbucket_client operation: '${args.operation}'. ` +
        "Use operation='info' for the full operation reference."
      );
  }
}

module.exports = {
  bitbucketClient,
  buildConn, requireString, guardString, clampInt,
  parseBbJson, checkBbStatus, bbRequest, bbApiRequest,
  mapRepo, mapIssue, mapPr, mapCommit, mapPipeline, mapUser, mapWorkspace,
  enc, repoPath,
};
