"use strict";
/**
 * github_client — Zero-dependency GitHub REST API v3 client
 * (pure Node.js https built-ins; no npm deps)
 *
 * Authentication: Personal Access Token (PAT) or GitHub App token.
 * Provide 'token' for authenticated operations (higher rate limits,
 * private repos, write operations). Unauthenticated access is allowed
 * for public resources but rate-limited to 60 req/hour.
 *
 * Base URL: https://api.github.com
 * API version: 2022-11-28 (GitHub REST API)
 *
 * Supported operations:
 *
 *   Repositories:
 *     repo_get            — Get repository details
 *     repo_list           — List repos for authenticated user or org
 *     repo_create         — Create a repository
 *     repo_delete         — Delete a repository
 *     repo_fork           — Fork a repository
 *
 *   Issues:
 *     issue_list          — List issues for a repository
 *     issue_get           — Get a single issue
 *     issue_create        — Create an issue
 *     issue_update        — Update an issue (title, body, state, labels)
 *     issue_comment       — Add a comment to an issue
 *     issue_comments      — List comments on an issue
 *
 *   Pull Requests:
 *     pr_list             — List pull requests
 *     pr_get              — Get a pull request
 *     pr_create           — Create a pull request
 *     pr_merge            — Merge a pull request
 *     pr_review           — Create a PR review (approve/request changes/comment)
 *     pr_files            — List files changed in a PR
 *
 *   Contents:
 *     file_get            — Get file contents (decoded from base64)
 *     file_create         — Create or update a file
 *     file_delete         — Delete a file
 *     dir_list            — List directory contents
 *
 *   Branches / Refs:
 *     branch_list         — List branches
 *     branch_get          — Get a branch
 *     branch_create       — Create a branch
 *     branch_delete       — Delete a branch
 *     branch_protect      — Get branch protection rules
 *
 *   Commits:
 *     commit_list         — List commits
 *     commit_get          — Get a single commit
 *     commit_compare      — Compare two commits/branches
 *
 *   Releases:
 *     release_list        — List releases
 *     release_get         — Get a release
 *     release_create      — Create a release
 *     release_latest      — Get the latest release
 *
 *   Actions / Workflows:
 *     workflow_list       — List workflows
 *     workflow_runs       — List workflow runs
 *     workflow_run_get    — Get a workflow run
 *     workflow_dispatch   — Trigger a workflow dispatch event
 *
 *   Search:
 *     search_repos        — Search repositories
 *     search_issues       — Search issues and pull requests
 *     search_code         — Search code
 *     search_commits      — Search commits
 *
 *   Users:
 *     user_get            — Get a user's public profile
 *     user_me             — Get the authenticated user
 *
 *   Organizations:
 *     org_get             — Get an organization
 *     org_repos           — List organization repositories
 *     org_members         — List organization members
 *
 *   Stars / Watchers:
 *     star_list           — List stargazers for a repo
 *     starred_list        — List repos starred by a user
 *
 *   Gists:
 *     gist_list           — List gists for authenticated user or a user
 *     gist_get            — Get a gist
 *     gist_create         — Create a gist
 *
 *   Generic:
 *     request             — Generic authenticated request to any GitHub API endpoint
 *     info                — Return this operation reference (no I/O)
 *
 * Security:
 *   NUL-byte guards on all string inputs.
 *   Timeout clamped 1000–120000 ms.
 *   Tokens never returned in output or errors.
 *   16 MB response cap.
 *   TLS enforced (GitHub API is HTTPS only).
 */

const https = require("https");

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS  = 20000;
const MAX_RESPONSE_BYTES  = 16 * 1024 * 1024; // 16 MB
const GITHUB_API_BASE     = "https://api.github.com";
const GITHUB_API_VERSION  = "2022-11-28";

// ── Guard helpers ──────────────────────────────────────────────────────────

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

// ── Low-level HTTP helper ──────────────────────────────────────────────────

function ghRequest(opts) {
  const { url, method, headers, body, timeoutMs } = opts;
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const bodyBuf = body
      ? (Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body), "utf8"))
      : null;

    const reqOpts = {
      hostname:           parsed.hostname,
      port:               parsed.port || 443,
      path:               parsed.pathname + (parsed.search || ""),
      method:             (method || "GET").toUpperCase(),
      headers:            { ...headers },
      rejectUnauthorized: true,
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
      reject(new Error(`GitHub request ${method} ${url} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const req = https.request(reqOpts, (res) => {
      res.on("data", (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          req.destroy();
          reject(new Error("GitHub response exceeded 16 MB cap"));
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
        reject(new Error(`GitHub response stream error: ${err.message}`));
      });
    });

    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Cannot connect to api.github.com: ${err.message}`));
    });

    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

// ── Connection / auth helper ───────────────────────────────────────────────

function buildConn(args) {
  guardString(args.token,    "token");
  guardString(args.base_url, "base_url");
  const timeoutMs = clampInt(args.timeout, DEFAULT_TIMEOUT_MS, 1000, 120000);
  const baseUrl   = (args.base_url || GITHUB_API_BASE).replace(/\/$/, "");
  return {
    token:     args.token || null,
    baseUrl,
    timeoutMs,
  };
}

async function ghApiRequest(conn, opts) {
  const { path, method, body, accept } = opts;
  const url     = `${conn.baseUrl}${path}`;
  const headers = {
    "Accept":               accept || "application/vnd.github+json",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    "User-Agent":           "mcp-common-server/github_client",
  };
  if (conn.token) {
    headers["Authorization"] = `Bearer ${conn.token}`;
  }

  return ghRequest({
    url,
    method: method || "GET",
    headers,
    body,
    timeoutMs: conn.timeoutMs,
  });
}

function parseGhJson(raw, ctx) {
  if (!raw || raw.trim() === "") return null;
  try { return JSON.parse(raw); } catch (_) {
    throw new Error(`GitHub: invalid JSON response (${ctx}): ${raw.slice(0, 200)}`);
  }
}

function checkGhStatus(res, ctx) {
  if (res.statusCode < 200 || res.statusCode >= 300) {
    let extra = "";
    try {
      const j = JSON.parse(res.raw);
      extra = j.message || j.error_description || JSON.stringify(j).slice(0, 300);
    } catch (_) { extra = res.raw.slice(0, 300); }
    throw new Error(`GitHub ${ctx}: HTTP ${res.statusCode} — ${extra}`);
  }
}

// ── Pagination helper ──────────────────────────────────────────────────────

function buildQs(params) {
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

// ── Repository Operations ──────────────────────────────────────────────────

async function opRepoGet(args, conn) {
  requireString(args.owner, "owner");
  requireString(args.repo,  "repo");
  const res  = await ghApiRequest(conn, { path: `/repos/${enc(args.owner)}/${enc(args.repo)}` });
  if (res.statusCode === 404) return { ok: true, operation: "repo_get", exists: false, owner: args.owner, repo: args.repo };
  checkGhStatus(res, "repo_get");
  const j = parseGhJson(res.raw, "repo_get");
  return { ok: true, operation: "repo_get", exists: true, ...mapRepo(j) };
}

async function opRepoList(args, conn) {
  let path;
  if (args.org) {
    requireString(args.org, "org");
    path = `/orgs/${enc(args.org)}/repos`;
  } else {
    path = "/user/repos";
  }
  const qs = buildQs({
    type:      args.type      || undefined,
    sort:      args.sort      || "updated",
    direction: args.direction || undefined,
    per_page:  clampInt(args.per_page, 30, 1, 100),
    page:      args.page      || 1,
  });
  const res  = await ghApiRequest(conn, { path: path + qs });
  checkGhStatus(res, "repo_list");
  const j = parseGhJson(res.raw, "repo_list");
  return { ok: true, operation: "repo_list", count: (j || []).length, repos: (j || []).map(mapRepo) };
}

async function opRepoCreate(args, conn) {
  requireString(args.name, "name");
  const body = {
    name:        args.name,
    description: args.description || undefined,
    private:     args.private !== undefined ? args.private : false,
    auto_init:   args.auto_init   || undefined,
    gitignore_template: args.gitignore_template || undefined,
    license_template:   args.license_template   || undefined,
  };
  let path;
  if (args.org) {
    requireString(args.org, "org");
    path = `/orgs/${enc(args.org)}/repos`;
  } else {
    path = "/user/repos";
  }
  const res = await ghApiRequest(conn, { path, method: "POST", body });
  checkGhStatus(res, "repo_create");
  const j = parseGhJson(res.raw, "repo_create");
  return { ok: true, operation: "repo_create", created: true, ...mapRepo(j) };
}

async function opRepoDelete(args, conn) {
  requireString(args.owner, "owner");
  requireString(args.repo,  "repo");
  const res = await ghApiRequest(conn, {
    path:   `/repos/${enc(args.owner)}/${enc(args.repo)}`,
    method: "DELETE",
  });
  if (res.statusCode === 404) return { ok: true, operation: "repo_delete", deleted: false, reason: "not_found" };
  checkGhStatus(res, "repo_delete");
  return { ok: true, operation: "repo_delete", deleted: true };
}

async function opRepoFork(args, conn) {
  requireString(args.owner, "owner");
  requireString(args.repo,  "repo");
  const body = {};
  if (args.org) body.organization = args.org;
  if (args.name) body.name = args.name;
  const res = await ghApiRequest(conn, {
    path:   `/repos/${enc(args.owner)}/${enc(args.repo)}/forks`,
    method: "POST",
    body,
  });
  checkGhStatus(res, "repo_fork");
  const j = parseGhJson(res.raw, "repo_fork");
  return { ok: true, operation: "repo_fork", forked: true, ...mapRepo(j) };
}

function mapRepo(r) {
  if (!r) return {};
  return {
    id:              r.id,
    name:            r.name,
    full_name:       r.full_name,
    owner:           r.owner?.login || null,
    private:         r.private,
    description:     r.description  || null,
    fork:            r.fork         || false,
    url:             r.html_url     || null,
    clone_url:       r.clone_url    || null,
    ssh_url:         r.ssh_url      || null,
    default_branch:  r.default_branch || null,
    stars:           r.stargazers_count || 0,
    forks:           r.forks_count     || 0,
    open_issues:     r.open_issues_count || 0,
    language:        r.language || null,
    topics:          r.topics   || [],
    archived:        r.archived  || false,
    disabled:        r.disabled  || false,
    visibility:      r.visibility || null,
    created_at:      r.created_at || null,
    updated_at:      r.updated_at || null,
    pushed_at:       r.pushed_at  || null,
    size:            r.size       || 0,
  };
}

// ── Issue Operations ───────────────────────────────────────────────────────

async function opIssueList(args, conn) {
  requireString(args.owner, "owner");
  requireString(args.repo,  "repo");
  const qs = buildQs({
    state:    args.state    || "open",
    labels:   args.labels   || undefined,
    sort:     args.sort     || "created",
    direction:args.direction|| "desc",
    since:    args.since    || undefined,
    per_page: clampInt(args.per_page, 30, 1, 100),
    page:     args.page     || 1,
    assignee: args.assignee || undefined,
  });
  const res = await ghApiRequest(conn, { path: `/repos/${enc(args.owner)}/${enc(args.repo)}/issues${qs}` });
  checkGhStatus(res, "issue_list");
  const j = parseGhJson(res.raw, "issue_list");
  return { ok: true, operation: "issue_list", count: (j || []).length, issues: (j || []).map(mapIssue) };
}

async function opIssueGet(args, conn) {
  requireString(args.owner,       "owner");
  requireString(args.repo,        "repo");
  if (!args.issue_number) throw new Error("issue_number must be provided");
  const res = await ghApiRequest(conn, {
    path: `/repos/${enc(args.owner)}/${enc(args.repo)}/issues/${args.issue_number}`,
  });
  if (res.statusCode === 404) return { ok: true, operation: "issue_get", exists: false };
  checkGhStatus(res, "issue_get");
  const j = parseGhJson(res.raw, "issue_get");
  return { ok: true, operation: "issue_get", exists: true, ...mapIssue(j) };
}

async function opIssueCreate(args, conn) {
  requireString(args.owner, "owner");
  requireString(args.repo,  "repo");
  requireString(args.title, "title");
  const body = {
    title:     args.title,
    body:      args.body      || undefined,
    labels:    args.labels    || undefined,
    assignees: args.assignees || undefined,
    milestone: args.milestone || undefined,
  };
  const res = await ghApiRequest(conn, {
    path:   `/repos/${enc(args.owner)}/${enc(args.repo)}/issues`,
    method: "POST",
    body,
  });
  checkGhStatus(res, "issue_create");
  const j = parseGhJson(res.raw, "issue_create");
  return { ok: true, operation: "issue_create", created: true, ...mapIssue(j) };
}

async function opIssueUpdate(args, conn) {
  requireString(args.owner,       "owner");
  requireString(args.repo,        "repo");
  if (!args.issue_number) throw new Error("issue_number must be provided");
  const body = {};
  if (args.title     !== undefined) body.title     = args.title;
  if (args.body      !== undefined) body.body       = args.body;
  if (args.state     !== undefined) body.state      = args.state;
  if (args.labels    !== undefined) body.labels     = args.labels;
  if (args.assignees !== undefined) body.assignees  = args.assignees;
  if (args.milestone !== undefined) body.milestone  = args.milestone;
  const res = await ghApiRequest(conn, {
    path:   `/repos/${enc(args.owner)}/${enc(args.repo)}/issues/${args.issue_number}`,
    method: "PATCH",
    body,
  });
  checkGhStatus(res, "issue_update");
  const j = parseGhJson(res.raw, "issue_update");
  return { ok: true, operation: "issue_update", updated: true, ...mapIssue(j) };
}

async function opIssueComment(args, conn) {
  requireString(args.owner, "owner");
  requireString(args.repo,  "repo");
  requireString(args.body,  "body");
  if (!args.issue_number) throw new Error("issue_number must be provided");
  const res = await ghApiRequest(conn, {
    path:   `/repos/${enc(args.owner)}/${enc(args.repo)}/issues/${args.issue_number}/comments`,
    method: "POST",
    body:   { body: args.body },
  });
  checkGhStatus(res, "issue_comment");
  const j = parseGhJson(res.raw, "issue_comment");
  return { ok: true, operation: "issue_comment", created: true, id: j.id, url: j.html_url, created_at: j.created_at };
}

async function opIssueComments(args, conn) {
  requireString(args.owner, "owner");
  requireString(args.repo,  "repo");
  if (!args.issue_number) throw new Error("issue_number must be provided");
  const qs = buildQs({ per_page: clampInt(args.per_page, 30, 1, 100), page: args.page || 1 });
  const res = await ghApiRequest(conn, {
    path: `/repos/${enc(args.owner)}/${enc(args.repo)}/issues/${args.issue_number}/comments${qs}`,
  });
  checkGhStatus(res, "issue_comments");
  const j = parseGhJson(res.raw, "issue_comments");
  return {
    ok: true, operation: "issue_comments", count: (j || []).length,
    comments: (j || []).map(c => ({
      id: c.id, user: c.user?.login || null,
      body: c.body, created_at: c.created_at, updated_at: c.updated_at, url: c.html_url,
    })),
  };
}

function mapIssue(i) {
  if (!i) return {};
  return {
    id:          i.id,
    number:      i.number,
    title:       i.title,
    body:        i.body         || null,
    state:       i.state,
    user:        i.user?.login  || null,
    labels:      (i.labels || []).map(l => l.name),
    assignees:   (i.assignees || []).map(a => a.login),
    comments:    i.comments     || 0,
    is_pr:       !!i.pull_request,
    milestone:   i.milestone?.title || null,
    url:         i.html_url     || null,
    created_at:  i.created_at   || null,
    updated_at:  i.updated_at   || null,
    closed_at:   i.closed_at    || null,
  };
}

// ── Pull Request Operations ────────────────────────────────────────────────

async function opPrList(args, conn) {
  requireString(args.owner, "owner");
  requireString(args.repo,  "repo");
  const qs = buildQs({
    state:    args.state    || "open",
    head:     args.head     || undefined,
    base:     args.base     || undefined,
    sort:     args.sort     || "created",
    direction:args.direction|| "desc",
    per_page: clampInt(args.per_page, 30, 1, 100),
    page:     args.page     || 1,
  });
  const res = await ghApiRequest(conn, { path: `/repos/${enc(args.owner)}/${enc(args.repo)}/pulls${qs}` });
  checkGhStatus(res, "pr_list");
  const j = parseGhJson(res.raw, "pr_list");
  return { ok: true, operation: "pr_list", count: (j || []).length, pull_requests: (j || []).map(mapPr) };
}

async function opPrGet(args, conn) {
  requireString(args.owner, "owner");
  requireString(args.repo,  "repo");
  if (!args.pull_number) throw new Error("pull_number must be provided");
  const res = await ghApiRequest(conn, {
    path: `/repos/${enc(args.owner)}/${enc(args.repo)}/pulls/${args.pull_number}`,
  });
  if (res.statusCode === 404) return { ok: true, operation: "pr_get", exists: false };
  checkGhStatus(res, "pr_get");
  const j = parseGhJson(res.raw, "pr_get");
  return { ok: true, operation: "pr_get", exists: true, ...mapPr(j) };
}

async function opPrCreate(args, conn) {
  requireString(args.owner, "owner");
  requireString(args.repo,  "repo");
  requireString(args.title, "title");
  requireString(args.head,  "head");
  requireString(args.base,  "base");
  const body = {
    title:                  args.title,
    head:                   args.head,
    base:                   args.base,
    body:                   args.body    || undefined,
    draft:                  args.draft   || false,
    maintainer_can_modify:  args.maintainer_can_modify !== undefined ? args.maintainer_can_modify : true,
  };
  const res = await ghApiRequest(conn, {
    path:   `/repos/${enc(args.owner)}/${enc(args.repo)}/pulls`,
    method: "POST",
    body,
  });
  checkGhStatus(res, "pr_create");
  const j = parseGhJson(res.raw, "pr_create");
  return { ok: true, operation: "pr_create", created: true, ...mapPr(j) };
}

async function opPrMerge(args, conn) {
  requireString(args.owner, "owner");
  requireString(args.repo,  "repo");
  if (!args.pull_number) throw new Error("pull_number must be provided");
  const body = {};
  if (args.commit_title   !== undefined) body.commit_title   = args.commit_title;
  if (args.commit_message !== undefined) body.commit_message = args.commit_message;
  if (args.merge_method   !== undefined) body.merge_method   = args.merge_method;  // merge|squash|rebase
  if (args.sha            !== undefined) body.sha            = args.sha;
  const res = await ghApiRequest(conn, {
    path:   `/repos/${enc(args.owner)}/${enc(args.repo)}/pulls/${args.pull_number}/merge`,
    method: "PUT",
    body,
  });
  if (res.statusCode === 405) return { ok: true, operation: "pr_merge", merged: false, reason: "not_mergeable" };
  if (res.statusCode === 409) return { ok: true, operation: "pr_merge", merged: false, reason: "head_modified" };
  checkGhStatus(res, "pr_merge");
  const j = parseGhJson(res.raw, "pr_merge");
  return { ok: true, operation: "pr_merge", merged: j?.merged || true, sha: j?.sha || null, message: j?.message || null };
}

async function opPrReview(args, conn) {
  requireString(args.owner, "owner");
  requireString(args.repo,  "repo");
  if (!args.pull_number) throw new Error("pull_number must be provided");
  requireString(args.event, "event"); // APPROVE | REQUEST_CHANGES | COMMENT
  const body = { event: args.event.toUpperCase() };
  if (args.body)     body.body     = args.body;
  if (args.comments) body.comments = args.comments;
  const res = await ghApiRequest(conn, {
    path:   `/repos/${enc(args.owner)}/${enc(args.repo)}/pulls/${args.pull_number}/reviews`,
    method: "POST",
    body,
  });
  checkGhStatus(res, "pr_review");
  const j = parseGhJson(res.raw, "pr_review");
  return { ok: true, operation: "pr_review", id: j?.id, state: j?.state, submitted_at: j?.submitted_at };
}

async function opPrFiles(args, conn) {
  requireString(args.owner, "owner");
  requireString(args.repo,  "repo");
  if (!args.pull_number) throw new Error("pull_number must be provided");
  const qs = buildQs({ per_page: clampInt(args.per_page, 30, 1, 100), page: args.page || 1 });
  const res = await ghApiRequest(conn, {
    path: `/repos/${enc(args.owner)}/${enc(args.repo)}/pulls/${args.pull_number}/files${qs}`,
  });
  checkGhStatus(res, "pr_files");
  const j = parseGhJson(res.raw, "pr_files");
  return {
    ok: true, operation: "pr_files", count: (j || []).length,
    files: (j || []).map(f => ({
      filename:    f.filename,
      status:      f.status,
      additions:   f.additions,
      deletions:   f.deletions,
      changes:     f.changes,
      patch:       f.patch || null,
    })),
  };
}

function mapPr(p) {
  if (!p) return {};
  return {
    id:           p.id,
    number:       p.number,
    title:        p.title,
    body:         p.body         || null,
    state:        p.state,
    draft:        p.draft        || false,
    merged:       p.merged       || false,
    mergeable:    p.mergeable    ?? null,
    user:         p.user?.login  || null,
    head:         p.head?.label  || null,
    head_sha:     p.head?.sha    || null,
    base:         p.base?.label  || null,
    labels:       (p.labels || []).map(l => l.name),
    assignees:    (p.assignees || []).map(a => a.login),
    reviewers:    (p.requested_reviewers || []).map(r => r.login),
    commits:      p.commits      || 0,
    additions:    p.additions    || 0,
    deletions:    p.deletions    || 0,
    changed_files:p.changed_files || 0,
    url:          p.html_url     || null,
    created_at:   p.created_at   || null,
    updated_at:   p.updated_at   || null,
    merged_at:    p.merged_at    || null,
    closed_at:    p.closed_at    || null,
    merge_commit_sha: p.merge_commit_sha || null,
  };
}

// ── Contents Operations ────────────────────────────────────────────────────

async function opFileGet(args, conn) {
  requireString(args.owner, "owner");
  requireString(args.repo,  "repo");
  requireString(args.path_,  "path");
  const qs  = args.ref ? buildQs({ ref: args.ref }) : "";
  const res = await ghApiRequest(conn, {
    path: `/repos/${enc(args.owner)}/${enc(args.repo)}/contents/${encPath(args.path_)}${qs}`,
  });
  if (res.statusCode === 404) return { ok: true, operation: "file_get", exists: false, path: args.path_ };
  checkGhStatus(res, "file_get");
  const j = parseGhJson(res.raw, "file_get");
  // Decode base64 content
  const content = j.content
    ? Buffer.from(j.content.replace(/\n/g, ""), "base64").toString("utf8")
    : null;
  return {
    ok: true, operation: "file_get", exists: true,
    name:        j.name,
    path:        j.path,
    sha:         j.sha,
    size:        j.size,
    content,
    encoding:    j.encoding,
    html_url:    j.html_url || null,
    download_url:j.download_url || null,
  };
}

async function opFileCreate(args, conn) {
  requireString(args.owner,   "owner");
  requireString(args.repo,    "repo");
  requireString(args.path_,   "path");
  requireString(args.message, "message");
  requireString(args.content, "content");
  const body = {
    message: args.message,
    content: Buffer.from(args.content, "utf8").toString("base64"),
  };
  if (args.branch)    body.branch    = args.branch;
  if (args.sha)       body.sha       = args.sha; // required for updates
  if (args.committer) body.committer = args.committer;
  if (args.author)    body.author    = args.author;
  const res = await ghApiRequest(conn, {
    path:   `/repos/${enc(args.owner)}/${enc(args.repo)}/contents/${encPath(args.path_)}`,
    method: "PUT",
    body,
  });
  checkGhStatus(res, "file_create");
  const j = parseGhJson(res.raw, "file_create");
  return {
    ok: true, operation: "file_create",
    path:       j.content?.path    || args.path_,
    sha:        j.content?.sha     || null,
    html_url:   j.content?.html_url || null,
    commit_sha: j.commit?.sha      || null,
  };
}

async function opFileDelete(args, conn) {
  requireString(args.owner,   "owner");
  requireString(args.repo,    "repo");
  requireString(args.path_,   "path");
  requireString(args.message, "message");
  requireString(args.sha,     "sha");
  const body = { message: args.message, sha: args.sha };
  if (args.branch)    body.branch    = args.branch;
  if (args.committer) body.committer = args.committer;
  const res = await ghApiRequest(conn, {
    path:   `/repos/${enc(args.owner)}/${enc(args.repo)}/contents/${encPath(args.path_)}`,
    method: "DELETE",
    body,
  });
  if (res.statusCode === 404) return { ok: true, operation: "file_delete", deleted: false, reason: "not_found" };
  checkGhStatus(res, "file_delete");
  const j = parseGhJson(res.raw, "file_delete");
  return { ok: true, operation: "file_delete", deleted: true, commit_sha: j?.commit?.sha || null };
}

async function opDirList(args, conn) {
  requireString(args.owner, "owner");
  requireString(args.repo,  "repo");
  const dirPath = args.path_ || "";
  const qs = args.ref ? buildQs({ ref: args.ref }) : "";
  const apiPath = dirPath
    ? `/repos/${enc(args.owner)}/${enc(args.repo)}/contents/${encPath(dirPath)}${qs}`
    : `/repos/${enc(args.owner)}/${enc(args.repo)}/contents${qs}`;
  const res = await ghApiRequest(conn, { path: apiPath });
  if (res.statusCode === 404) return { ok: true, operation: "dir_list", exists: false, path: dirPath };
  checkGhStatus(res, "dir_list");
  const j = parseGhJson(res.raw, "dir_list");
  const items = Array.isArray(j) ? j : [j];
  return {
    ok: true, operation: "dir_list", exists: true, path: dirPath,
    count: items.length,
    entries: items.map(e => ({
      name: e.name, path: e.path, type: e.type, size: e.size, sha: e.sha, url: e.html_url,
    })),
  };
}

// ── Branch Operations ──────────────────────────────────────────────────────

async function opBranchList(args, conn) {
  requireString(args.owner, "owner");
  requireString(args.repo,  "repo");
  const qs = buildQs({
    protected: args.protected || undefined,
    per_page:  clampInt(args.per_page, 30, 1, 100),
    page:      args.page || 1,
  });
  const res = await ghApiRequest(conn, { path: `/repos/${enc(args.owner)}/${enc(args.repo)}/branches${qs}` });
  checkGhStatus(res, "branch_list");
  const j = parseGhJson(res.raw, "branch_list");
  return {
    ok: true, operation: "branch_list", count: (j || []).length,
    branches: (j || []).map(b => ({ name: b.name, sha: b.commit?.sha || null, protected: b.protected || false })),
  };
}

async function opBranchGet(args, conn) {
  requireString(args.owner,  "owner");
  requireString(args.repo,   "repo");
  requireString(args.branch, "branch");
  const res = await ghApiRequest(conn, {
    path: `/repos/${enc(args.owner)}/${enc(args.repo)}/branches/${enc(args.branch)}`,
  });
  if (res.statusCode === 404) return { ok: true, operation: "branch_get", exists: false };
  checkGhStatus(res, "branch_get");
  const j = parseGhJson(res.raw, "branch_get");
  return {
    ok: true, operation: "branch_get", exists: true,
    name:       j.name,
    sha:        j.commit?.sha    || null,
    protected:  j.protected      || false,
    commit_url: j.commit?.url    || null,
  };
}

async function opBranchCreate(args, conn) {
  requireString(args.owner,  "owner");
  requireString(args.repo,   "repo");
  requireString(args.branch, "branch");
  requireString(args.sha,    "sha");
  const res = await ghApiRequest(conn, {
    path:   `/repos/${enc(args.owner)}/${enc(args.repo)}/git/refs`,
    method: "POST",
    body:   { ref: `refs/heads/${args.branch}`, sha: args.sha },
  });
  checkGhStatus(res, "branch_create");
  const j = parseGhJson(res.raw, "branch_create");
  return { ok: true, operation: "branch_create", created: true, ref: j?.ref, sha: j?.object?.sha };
}

async function opBranchDelete(args, conn) {
  requireString(args.owner,  "owner");
  requireString(args.repo,   "repo");
  requireString(args.branch, "branch");
  const res = await ghApiRequest(conn, {
    path:   `/repos/${enc(args.owner)}/${enc(args.repo)}/git/refs/heads/${enc(args.branch)}`,
    method: "DELETE",
  });
  if (res.statusCode === 404 || res.statusCode === 422)
    return { ok: true, operation: "branch_delete", deleted: false, reason: "not_found" };
  checkGhStatus(res, "branch_delete");
  return { ok: true, operation: "branch_delete", deleted: true };
}

async function opBranchProtect(args, conn) {
  requireString(args.owner,  "owner");
  requireString(args.repo,   "repo");
  requireString(args.branch, "branch");
  const res = await ghApiRequest(conn, {
    path: `/repos/${enc(args.owner)}/${enc(args.repo)}/branches/${enc(args.branch)}/protection`,
  });
  if (res.statusCode === 404) return { ok: true, operation: "branch_protect", exists: false };
  checkGhStatus(res, "branch_protect");
  const j = parseGhJson(res.raw, "branch_protect");
  return {
    ok: true, operation: "branch_protect", exists: true,
    required_status_checks:          j.required_status_checks || null,
    enforce_admins:                  j.enforce_admins?.enabled || false,
    required_pull_request_reviews:   j.required_pull_request_reviews || null,
    restrictions:                    j.restrictions || null,
    required_linear_history:         j.required_linear_history?.enabled || false,
    allow_force_pushes:              j.allow_force_pushes?.enabled || false,
    allow_deletions:                 j.allow_deletions?.enabled || false,
  };
}

// ── Commit Operations ──────────────────────────────────────────────────────

async function opCommitList(args, conn) {
  requireString(args.owner, "owner");
  requireString(args.repo,  "repo");
  const qs = buildQs({
    sha:      args.sha      || undefined,
    path:     args.file_path || undefined,
    author:   args.author   || undefined,
    since:    args.since    || undefined,
    until:    args.until    || undefined,
    per_page: clampInt(args.per_page, 30, 1, 100),
    page:     args.page     || 1,
  });
  const res = await ghApiRequest(conn, { path: `/repos/${enc(args.owner)}/${enc(args.repo)}/commits${qs}` });
  checkGhStatus(res, "commit_list");
  const j = parseGhJson(res.raw, "commit_list");
  return { ok: true, operation: "commit_list", count: (j || []).length, commits: (j || []).map(mapCommit) };
}

async function opCommitGet(args, conn) {
  requireString(args.owner, "owner");
  requireString(args.repo,  "repo");
  requireString(args.sha,   "sha");
  const res = await ghApiRequest(conn, {
    path: `/repos/${enc(args.owner)}/${enc(args.repo)}/commits/${enc(args.sha)}`,
  });
  if (res.statusCode === 404) return { ok: true, operation: "commit_get", exists: false };
  checkGhStatus(res, "commit_get");
  const j = parseGhJson(res.raw, "commit_get");
  const c = mapCommit(j);
  // Include file changes if present
  c.files = (j.files || []).map(f => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.changes }));
  return { ok: true, operation: "commit_get", exists: true, ...c };
}

async function opCommitCompare(args, conn) {
  requireString(args.owner, "owner");
  requireString(args.repo,  "repo");
  requireString(args.base,  "base");
  requireString(args.head,  "head");
  const res = await ghApiRequest(conn, {
    path: `/repos/${enc(args.owner)}/${enc(args.repo)}/compare/${enc(args.base)}...${enc(args.head)}`,
  });
  checkGhStatus(res, "commit_compare");
  const j = parseGhJson(res.raw, "commit_compare");
  return {
    ok: true, operation: "commit_compare",
    status:         j.status,
    ahead_by:       j.ahead_by,
    behind_by:      j.behind_by,
    total_commits:  j.total_commits,
    commits:        (j.commits || []).map(mapCommit),
    files:          (j.files   || []).map(f => ({ filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions })),
    merge_base_commit: j.merge_base_commit?.sha || null,
  };
}

function mapCommit(c) {
  if (!c) return {};
  return {
    sha:        c.sha,
    message:    c.commit?.message  || null,
    author:     c.commit?.author?.name || c.author?.login || null,
    author_date:c.commit?.author?.date || null,
    committer:  c.commit?.committer?.name || null,
    commit_date:c.commit?.committer?.date || null,
    url:        c.html_url || null,
    parents:    (c.parents || []).map(p => p.sha),
  };
}

// ── Release Operations ─────────────────────────────────────────────────────

async function opReleaseList(args, conn) {
  requireString(args.owner, "owner");
  requireString(args.repo,  "repo");
  const qs  = buildQs({ per_page: clampInt(args.per_page, 30, 1, 100), page: args.page || 1 });
  const res = await ghApiRequest(conn, { path: `/repos/${enc(args.owner)}/${enc(args.repo)}/releases${qs}` });
  checkGhStatus(res, "release_list");
  const j = parseGhJson(res.raw, "release_list");
  return { ok: true, operation: "release_list", count: (j || []).length, releases: (j || []).map(mapRelease) };
}

async function opReleaseGet(args, conn) {
  requireString(args.owner, "owner");
  requireString(args.repo,  "repo");
  if (!args.release_id) throw new Error("release_id must be provided");
  const res = await ghApiRequest(conn, {
    path: `/repos/${enc(args.owner)}/${enc(args.repo)}/releases/${args.release_id}`,
  });
  if (res.statusCode === 404) return { ok: true, operation: "release_get", exists: false };
  checkGhStatus(res, "release_get");
  const j = parseGhJson(res.raw, "release_get");
  return { ok: true, operation: "release_get", exists: true, ...mapRelease(j) };
}

async function opReleaseCreate(args, conn) {
  requireString(args.owner,   "owner");
  requireString(args.repo,    "repo");
  requireString(args.tag_name,"tag_name");
  const body = {
    tag_name:         args.tag_name,
    target_commitish: args.target_commitish || undefined,
    name:             args.name             || undefined,
    body:             args.body             || undefined,
    draft:            args.draft            || false,
    prerelease:       args.prerelease       || false,
    generate_release_notes: args.generate_release_notes || false,
  };
  const res = await ghApiRequest(conn, {
    path:   `/repos/${enc(args.owner)}/${enc(args.repo)}/releases`,
    method: "POST",
    body,
  });
  checkGhStatus(res, "release_create");
  const j = parseGhJson(res.raw, "release_create");
  return { ok: true, operation: "release_create", created: true, ...mapRelease(j) };
}

async function opReleaseLatest(args, conn) {
  requireString(args.owner, "owner");
  requireString(args.repo,  "repo");
  const res = await ghApiRequest(conn, {
    path: `/repos/${enc(args.owner)}/${enc(args.repo)}/releases/latest`,
  });
  if (res.statusCode === 404) return { ok: true, operation: "release_latest", exists: false };
  checkGhStatus(res, "release_latest");
  const j = parseGhJson(res.raw, "release_latest");
  return { ok: true, operation: "release_latest", exists: true, ...mapRelease(j) };
}

function mapRelease(r) {
  if (!r) return {};
  return {
    id:          r.id,
    tag_name:    r.tag_name,
    name:        r.name        || null,
    body:        r.body        || null,
    draft:       r.draft       || false,
    prerelease:  r.prerelease  || false,
    author:      r.author?.login || null,
    url:         r.html_url    || null,
    tarball_url: r.tarball_url || null,
    zipball_url: r.zipball_url || null,
    assets:      (r.assets || []).map(a => ({ id: a.id, name: a.name, size: a.size, download_url: a.browser_download_url })),
    created_at:  r.created_at  || null,
    published_at:r.published_at || null,
    target_commitish: r.target_commitish || null,
  };
}

// ── Actions / Workflow Operations ──────────────────────────────────────────

async function opWorkflowList(args, conn) {
  requireString(args.owner, "owner");
  requireString(args.repo,  "repo");
  const qs  = buildQs({ per_page: clampInt(args.per_page, 30, 1, 100), page: args.page || 1 });
  const res = await ghApiRequest(conn, { path: `/repos/${enc(args.owner)}/${enc(args.repo)}/actions/workflows${qs}` });
  checkGhStatus(res, "workflow_list");
  const j = parseGhJson(res.raw, "workflow_list");
  return {
    ok: true, operation: "workflow_list",
    total_count: j?.total_count || 0,
    workflows:   (j?.workflows || []).map(w => ({
      id: w.id, name: w.name, path: w.path, state: w.state,
      created_at: w.created_at, updated_at: w.updated_at,
    })),
  };
}

async function opWorkflowRuns(args, conn) {
  requireString(args.owner, "owner");
  requireString(args.repo,  "repo");
  let basePath;
  if (args.workflow_id) {
    basePath = `/repos/${enc(args.owner)}/${enc(args.repo)}/actions/workflows/${enc(String(args.workflow_id))}/runs`;
  } else {
    basePath = `/repos/${enc(args.owner)}/${enc(args.repo)}/actions/runs`;
  }
  const qs = buildQs({
    status:   args.status    || undefined,
    branch:   args.branch    || undefined,
    actor:    args.actor     || undefined,
    per_page: clampInt(args.per_page, 30, 1, 100),
    page:     args.page || 1,
  });
  const res = await ghApiRequest(conn, { path: basePath + qs });
  checkGhStatus(res, "workflow_runs");
  const j = parseGhJson(res.raw, "workflow_runs");
  return {
    ok: true, operation: "workflow_runs",
    total_count: j?.total_count || 0,
    workflow_runs: (j?.workflow_runs || []).map(mapWorkflowRun),
  };
}

async function opWorkflowRunGet(args, conn) {
  requireString(args.owner, "owner");
  requireString(args.repo,  "repo");
  if (!args.run_id) throw new Error("run_id must be provided");
  const res = await ghApiRequest(conn, {
    path: `/repos/${enc(args.owner)}/${enc(args.repo)}/actions/runs/${args.run_id}`,
  });
  if (res.statusCode === 404) return { ok: true, operation: "workflow_run_get", exists: false };
  checkGhStatus(res, "workflow_run_get");
  const j = parseGhJson(res.raw, "workflow_run_get");
  return { ok: true, operation: "workflow_run_get", exists: true, ...mapWorkflowRun(j) };
}

async function opWorkflowDispatch(args, conn) {
  requireString(args.owner,       "owner");
  requireString(args.repo,        "repo");
  requireString(args.workflow_id, "workflow_id");
  requireString(args.ref,         "ref");
  const body = { ref: args.ref };
  if (args.inputs) body.inputs = args.inputs;
  const res = await ghApiRequest(conn, {
    path:   `/repos/${enc(args.owner)}/${enc(args.repo)}/actions/workflows/${enc(args.workflow_id)}/dispatches`,
    method: "POST",
    body,
  });
  checkGhStatus(res, "workflow_dispatch");
  return { ok: true, operation: "workflow_dispatch", dispatched: true };
}

function mapWorkflowRun(r) {
  if (!r) return {};
  return {
    id:           r.id,
    name:         r.name         || null,
    workflow_id:  r.workflow_id  || null,
    head_branch:  r.head_branch  || null,
    head_sha:     r.head_sha     || null,
    status:       r.status       || null,
    conclusion:   r.conclusion   || null,
    event:        r.event        || null,
    run_number:   r.run_number   || null,
    run_attempt:  r.run_attempt  || null,
    actor:        r.actor?.login || null,
    url:          r.html_url     || null,
    created_at:   r.created_at   || null,
    updated_at:   r.updated_at   || null,
  };
}

// ── Search Operations ──────────────────────────────────────────────────────

async function opSearchRepos(args, conn) {
  requireString(args.query, "query");
  const qs = buildQs({
    q:        args.query,
    sort:     args.sort     || undefined,
    order:    args.order    || "desc",
    per_page: clampInt(args.per_page, 10, 1, 100),
    page:     args.page || 1,
  });
  const res = await ghApiRequest(conn, { path: `/search/repositories${qs}` });
  checkGhStatus(res, "search_repos");
  const j = parseGhJson(res.raw, "search_repos");
  return {
    ok: true, operation: "search_repos",
    total_count:         j?.total_count || 0,
    incomplete_results:  j?.incomplete_results || false,
    items:               (j?.items || []).map(mapRepo),
  };
}

async function opSearchIssues(args, conn) {
  requireString(args.query, "query");
  const qs = buildQs({
    q:        args.query,
    sort:     args.sort     || undefined,
    order:    args.order    || "desc",
    per_page: clampInt(args.per_page, 10, 1, 100),
    page:     args.page || 1,
  });
  const res = await ghApiRequest(conn, { path: `/search/issues${qs}` });
  checkGhStatus(res, "search_issues");
  const j = parseGhJson(res.raw, "search_issues");
  return {
    ok: true, operation: "search_issues",
    total_count:         j?.total_count || 0,
    incomplete_results:  j?.incomplete_results || false,
    items:               (j?.items || []).map(mapIssue),
  };
}

async function opSearchCode(args, conn) {
  requireString(args.query, "query");
  const qs = buildQs({
    q:        args.query,
    sort:     args.sort     || undefined,
    order:    args.order    || "desc",
    per_page: clampInt(args.per_page, 10, 1, 100),
    page:     args.page || 1,
  });
  const res = await ghApiRequest(conn, { path: `/search/code${qs}` });
  checkGhStatus(res, "search_code");
  const j = parseGhJson(res.raw, "search_code");
  return {
    ok: true, operation: "search_code",
    total_count:         j?.total_count || 0,
    incomplete_results:  j?.incomplete_results || false,
    items: (j?.items || []).map(i => ({
      name:     i.name,
      path:     i.path,
      sha:      i.sha,
      url:      i.html_url,
      repo:     i.repository?.full_name || null,
      score:    i.score,
    })),
  };
}

async function opSearchCommits(args, conn) {
  requireString(args.query, "query");
  const qs = buildQs({
    q:        args.query,
    sort:     args.sort  || undefined,
    order:    args.order || "desc",
    per_page: clampInt(args.per_page, 10, 1, 100),
    page:     args.page  || 1,
  });
  const res = await ghApiRequest(conn, {
    path:   `/search/commits${qs}`,
    accept: "application/vnd.github.cloak-preview+json",
  });
  checkGhStatus(res, "search_commits");
  const j = parseGhJson(res.raw, "search_commits");
  return {
    ok: true, operation: "search_commits",
    total_count:        j?.total_count || 0,
    incomplete_results: j?.incomplete_results || false,
    items: (j?.items || []).map(mapCommit),
  };
}

// ── User Operations ────────────────────────────────────────────────────────

async function opUserGet(args, conn) {
  requireString(args.username, "username");
  const res = await ghApiRequest(conn, { path: `/users/${enc(args.username)}` });
  if (res.statusCode === 404) return { ok: true, operation: "user_get", exists: false };
  checkGhStatus(res, "user_get");
  const j = parseGhJson(res.raw, "user_get");
  return { ok: true, operation: "user_get", exists: true, ...mapUser(j) };
}

async function opUserMe(args, conn) {
  const res = await ghApiRequest(conn, { path: "/user" });
  checkGhStatus(res, "user_me");
  const j = parseGhJson(res.raw, "user_me");
  return { ok: true, operation: "user_me", ...mapUser(j) };
}

function mapUser(u) {
  if (!u) return {};
  return {
    id:          u.id,
    login:       u.login,
    name:        u.name        || null,
    email:       u.email       || null,
    bio:         u.bio         || null,
    company:     u.company     || null,
    location:    u.location    || null,
    blog:        u.blog        || null,
    twitter:     u.twitter_username || null,
    type:        u.type        || null,
    public_repos:u.public_repos || 0,
    followers:   u.followers   || 0,
    following:   u.following   || 0,
    url:         u.html_url    || null,
    avatar_url:  u.avatar_url  || null,
    created_at:  u.created_at  || null,
    updated_at:  u.updated_at  || null,
  };
}

// ── Organization Operations ────────────────────────────────────────────────

async function opOrgGet(args, conn) {
  requireString(args.org, "org");
  const res = await ghApiRequest(conn, { path: `/orgs/${enc(args.org)}` });
  if (res.statusCode === 404) return { ok: true, operation: "org_get", exists: false };
  checkGhStatus(res, "org_get");
  const j = parseGhJson(res.raw, "org_get");
  return {
    ok: true, operation: "org_get", exists: true,
    id:           j.id,
    login:        j.login,
    name:         j.name          || null,
    description:  j.description   || null,
    email:        j.email         || null,
    blog:         j.blog          || null,
    location:     j.location      || null,
    public_repos: j.public_repos  || 0,
    members:      j.members_count || null,
    url:          j.html_url      || null,
    created_at:   j.created_at    || null,
  };
}

async function opOrgRepos(args, conn) {
  requireString(args.org, "org");
  const qs = buildQs({
    type:     args.type      || undefined,
    sort:     args.sort      || "updated",
    per_page: clampInt(args.per_page, 30, 1, 100),
    page:     args.page      || 1,
  });
  const res = await ghApiRequest(conn, { path: `/orgs/${enc(args.org)}/repos${qs}` });
  checkGhStatus(res, "org_repos");
  const j = parseGhJson(res.raw, "org_repos");
  return { ok: true, operation: "org_repos", count: (j || []).length, repos: (j || []).map(mapRepo) };
}

async function opOrgMembers(args, conn) {
  requireString(args.org, "org");
  const qs = buildQs({
    role:     args.role     || undefined,
    per_page: clampInt(args.per_page, 30, 1, 100),
    page:     args.page     || 1,
  });
  const res = await ghApiRequest(conn, { path: `/orgs/${enc(args.org)}/members${qs}` });
  checkGhStatus(res, "org_members");
  const j = parseGhJson(res.raw, "org_members");
  return {
    ok: true, operation: "org_members", count: (j || []).length,
    members: (j || []).map(m => ({ id: m.id, login: m.login, type: m.type, url: m.html_url })),
  };
}

// ── Stars / Watchers ──────────────────────────────────────────────────────

async function opStarList(args, conn) {
  requireString(args.owner, "owner");
  requireString(args.repo,  "repo");
  const qs  = buildQs({ per_page: clampInt(args.per_page, 30, 1, 100), page: args.page || 1 });
  const res = await ghApiRequest(conn, { path: `/repos/${enc(args.owner)}/${enc(args.repo)}/stargazers${qs}` });
  checkGhStatus(res, "star_list");
  const j = parseGhJson(res.raw, "star_list");
  return {
    ok: true, operation: "star_list", count: (j || []).length,
    stargazers: (j || []).map(u => ({ id: u.id, login: u.login, url: u.html_url })),
  };
}

async function opStarredList(args, conn) {
  requireString(args.username, "username");
  const qs  = buildQs({ per_page: clampInt(args.per_page, 30, 1, 100), page: args.page || 1 });
  const res = await ghApiRequest(conn, { path: `/users/${enc(args.username)}/starred${qs}` });
  checkGhStatus(res, "starred_list");
  const j = parseGhJson(res.raw, "starred_list");
  return { ok: true, operation: "starred_list", count: (j || []).length, repos: (j || []).map(mapRepo) };
}

// ── Gist Operations ───────────────────────────────────────────────────────

async function opGistList(args, conn) {
  let path = "/gists";
  if (args.username) {
    requireString(args.username, "username");
    path = `/users/${enc(args.username)}/gists`;
  }
  const qs  = buildQs({ per_page: clampInt(args.per_page, 30, 1, 100), page: args.page || 1 });
  const res = await ghApiRequest(conn, { path: path + qs });
  checkGhStatus(res, "gist_list");
  const j = parseGhJson(res.raw, "gist_list");
  return {
    ok: true, operation: "gist_list", count: (j || []).length,
    gists: (j || []).map(g => ({
      id: g.id, description: g.description, public: g.public,
      files: Object.keys(g.files || {}),
      url: g.html_url, created_at: g.created_at, updated_at: g.updated_at,
    })),
  };
}

async function opGistGet(args, conn) {
  requireString(args.gist_id, "gist_id");
  const res = await ghApiRequest(conn, { path: `/gists/${enc(args.gist_id)}` });
  if (res.statusCode === 404) return { ok: true, operation: "gist_get", exists: false };
  checkGhStatus(res, "gist_get");
  const j = parseGhJson(res.raw, "gist_get");
  const files = {};
  for (const [name, f] of Object.entries(j.files || {})) {
    files[name] = { filename: f.filename, type: f.type, size: f.size, content: f.content || null };
  }
  return {
    ok: true, operation: "gist_get", exists: true,
    id: j.id, description: j.description, public: j.public,
    owner: j.owner?.login || null,
    files, url: j.html_url,
    created_at: j.created_at, updated_at: j.updated_at,
  };
}

async function opGistCreate(args, conn) {
  requireString(args.description, "description");
  if (!args.files || typeof args.files !== "object" || Object.keys(args.files).length === 0)
    throw new Error("files must be a non-empty object mapping filename to content");
  const filesBody = {};
  for (const [name, content] of Object.entries(args.files)) {
    filesBody[name] = { content: String(content) };
  }
  const res = await ghApiRequest(conn, {
    path:   "/gists",
    method: "POST",
    body:   { description: args.description, public: args.public || false, files: filesBody },
  });
  checkGhStatus(res, "gist_create");
  const j = parseGhJson(res.raw, "gist_create");
  return {
    ok: true, operation: "gist_create", created: true,
    id: j.id, url: j.html_url, description: j.description, public: j.public,
  };
}

// ── Generic request ────────────────────────────────────────────────────────

async function opRequest(args, conn) {
  requireString(args.path_,  "path");
  requireString(args.method, "method");
  const validMethods = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];
  const method = args.method.toUpperCase();
  if (!validMethods.includes(method))
    throw new Error(`method must be one of: ${validMethods.join(", ")}`);
  const res = await ghApiRequest(conn, { path: args.path_, method, body: args.body || undefined });
  let parsedBody;
  const ct = res.headers["content-type"] || "";
  if (ct.includes("json")) {
    try { parsedBody = JSON.parse(res.raw); } catch (_) { parsedBody = res.raw; }
  } else {
    parsedBody = res.raw;
  }
  if (res.statusCode < 200 || res.statusCode >= 300)
    checkGhStatus(res, `request ${method} ${args.path_}`);
  return {
    ok: true, operation: "request",
    path: args.path_, method,
    status_code: res.statusCode,
    headers: res.headers,
    body: parsedBody,
  };
}

// ── Info ───────────────────────────────────────────────────────────────────

function opInfo() {
  return {
    ok:       true,
    protocol: "GitHub REST API v3 (HTTPS/JSON)",
    api_version: GITHUB_API_VERSION,
    default_base_url: GITHUB_API_BASE,
    auth: "Personal Access Token (PAT) or GitHub App token via 'token' field (Bearer)",
    rate_limits: "Authenticated: 5000 req/hour; Unauthenticated: 60 req/hour",
    operations: [
      { op: "repo_get",           description: "Get repository details" },
      { op: "repo_list",          description: "List repos for authenticated user or org" },
      { op: "repo_create",        description: "Create a repository" },
      { op: "repo_delete",        description: "Delete a repository" },
      { op: "repo_fork",          description: "Fork a repository" },
      { op: "issue_list",         description: "List issues for a repository" },
      { op: "issue_get",          description: "Get a single issue" },
      { op: "issue_create",       description: "Create an issue" },
      { op: "issue_update",       description: "Update an issue" },
      { op: "issue_comment",      description: "Add a comment to an issue" },
      { op: "issue_comments",     description: "List comments on an issue" },
      { op: "pr_list",            description: "List pull requests" },
      { op: "pr_get",             description: "Get a pull request" },
      { op: "pr_create",          description: "Create a pull request" },
      { op: "pr_merge",           description: "Merge a pull request" },
      { op: "pr_review",          description: "Create a PR review" },
      { op: "pr_files",           description: "List files changed in a PR" },
      { op: "file_get",           description: "Get file contents (decoded)" },
      { op: "file_create",        description: "Create or update a file" },
      { op: "file_delete",        description: "Delete a file" },
      { op: "dir_list",           description: "List directory contents" },
      { op: "branch_list",        description: "List branches" },
      { op: "branch_get",         description: "Get a branch" },
      { op: "branch_create",      description: "Create a branch from a SHA" },
      { op: "branch_delete",      description: "Delete a branch" },
      { op: "branch_protect",     description: "Get branch protection rules" },
      { op: "commit_list",        description: "List commits" },
      { op: "commit_get",         description: "Get a single commit" },
      { op: "commit_compare",     description: "Compare two commits or branches" },
      { op: "release_list",       description: "List releases" },
      { op: "release_get",        description: "Get a release" },
      { op: "release_create",     description: "Create a release" },
      { op: "release_latest",     description: "Get the latest release" },
      { op: "workflow_list",      description: "List GitHub Actions workflows" },
      { op: "workflow_runs",      description: "List workflow runs" },
      { op: "workflow_run_get",   description: "Get a workflow run" },
      { op: "workflow_dispatch",  description: "Trigger a workflow dispatch event" },
      { op: "search_repos",       description: "Search repositories" },
      { op: "search_issues",      description: "Search issues and pull requests" },
      { op: "search_code",        description: "Search code" },
      { op: "search_commits",     description: "Search commits" },
      { op: "user_get",           description: "Get a user's public profile" },
      { op: "user_me",            description: "Get the authenticated user" },
      { op: "org_get",            description: "Get an organization" },
      { op: "org_repos",          description: "List organization repositories" },
      { op: "org_members",        description: "List organization members" },
      { op: "star_list",          description: "List stargazers for a repo" },
      { op: "starred_list",       description: "List repos starred by a user" },
      { op: "gist_list",          description: "List gists" },
      { op: "gist_get",           description: "Get a gist" },
      { op: "gist_create",        description: "Create a gist" },
      { op: "request",            description: "Generic authenticated request to any GitHub API path" },
      { op: "info",               description: "Return this operation reference (no I/O)" },
    ],
  };
}

// ── URL encoding helpers ───────────────────────────────────────────────────

function enc(s) { return encodeURIComponent(s); }
function encPath(s) {
  // Encode path segments but preserve slashes
  return s.split("/").map(seg => encodeURIComponent(seg)).join("/");
}

// ── Main entry point ───────────────────────────────────────────────────────

async function githubClient(args) {
  const op = (args.operation || "").toLowerCase().replace(/-/g, "_");
  if (op === "info") return opInfo();

  const conn = buildConn(args);

  // Map path param (avoid shadowing JS 'path' module)
  const mappedArgs = { ...args, path_: args.path };

  switch (op) {
    // Repositories
    case "repo_get":     return opRepoGet(mappedArgs, conn);
    case "repo_list":    return opRepoList(mappedArgs, conn);
    case "repo_create":  return opRepoCreate(mappedArgs, conn);
    case "repo_delete":  return opRepoDelete(mappedArgs, conn);
    case "repo_fork":    return opRepoFork(mappedArgs, conn);
    // Issues
    case "issue_list":     return opIssueList(mappedArgs, conn);
    case "issue_get":      return opIssueGet(mappedArgs, conn);
    case "issue_create":   return opIssueCreate(mappedArgs, conn);
    case "issue_update":   return opIssueUpdate(mappedArgs, conn);
    case "issue_comment":  return opIssueComment(mappedArgs, conn);
    case "issue_comments": return opIssueComments(mappedArgs, conn);
    // Pull Requests
    case "pr_list":    return opPrList(mappedArgs, conn);
    case "pr_get":     return opPrGet(mappedArgs, conn);
    case "pr_create":  return opPrCreate(mappedArgs, conn);
    case "pr_merge":   return opPrMerge(mappedArgs, conn);
    case "pr_review":  return opPrReview(mappedArgs, conn);
    case "pr_files":   return opPrFiles(mappedArgs, conn);
    // Contents
    case "file_get":    return opFileGet(mappedArgs, conn);
    case "file_create": return opFileCreate(mappedArgs, conn);
    case "file_delete": return opFileDelete(mappedArgs, conn);
    case "dir_list":    return opDirList(mappedArgs, conn);
    // Branches
    case "branch_list":    return opBranchList(mappedArgs, conn);
    case "branch_get":     return opBranchGet(mappedArgs, conn);
    case "branch_create":  return opBranchCreate(mappedArgs, conn);
    case "branch_delete":  return opBranchDelete(mappedArgs, conn);
    case "branch_protect": return opBranchProtect(mappedArgs, conn);
    // Commits
    case "commit_list":    return opCommitList(mappedArgs, conn);
    case "commit_get":     return opCommitGet(mappedArgs, conn);
    case "commit_compare": return opCommitCompare(mappedArgs, conn);
    // Releases
    case "release_list":   return opReleaseList(mappedArgs, conn);
    case "release_get":    return opReleaseGet(mappedArgs, conn);
    case "release_create": return opReleaseCreate(mappedArgs, conn);
    case "release_latest": return opReleaseLatest(mappedArgs, conn);
    // Workflows
    case "workflow_list":     return opWorkflowList(mappedArgs, conn);
    case "workflow_runs":     return opWorkflowRuns(mappedArgs, conn);
    case "workflow_run_get":  return opWorkflowRunGet(mappedArgs, conn);
    case "workflow_dispatch": return opWorkflowDispatch(mappedArgs, conn);
    // Search
    case "search_repos":   return opSearchRepos(mappedArgs, conn);
    case "search_issues":  return opSearchIssues(mappedArgs, conn);
    case "search_code":    return opSearchCode(mappedArgs, conn);
    case "search_commits": return opSearchCommits(mappedArgs, conn);
    // Users
    case "user_get": return opUserGet(mappedArgs, conn);
    case "user_me":  return opUserMe(mappedArgs, conn);
    // Organizations
    case "org_get":     return opOrgGet(mappedArgs, conn);
    case "org_repos":   return opOrgRepos(mappedArgs, conn);
    case "org_members": return opOrgMembers(mappedArgs, conn);
    // Stars
    case "star_list":    return opStarList(mappedArgs, conn);
    case "starred_list": return opStarredList(mappedArgs, conn);
    // Gists
    case "gist_list":   return opGistList(mappedArgs, conn);
    case "gist_get":    return opGistGet(mappedArgs, conn);
    case "gist_create": return opGistCreate(mappedArgs, conn);
    // Generic
    case "request": return opRequest(mappedArgs, conn);
    default:
      throw new Error(
        `Unknown github_client operation: '${args.operation}'. ` +
        "Use operation='info' for the full operation reference."
      );
  }
}

module.exports = {
  githubClient,
  buildConn, requireString, guardString, clampInt,
  parseGhJson, checkGhStatus, ghRequest, ghApiRequest,
  mapRepo, mapIssue, mapPr, mapCommit, mapRelease, mapWorkflowRun, mapUser,
  enc, encPath,
};
