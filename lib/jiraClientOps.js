"use strict";
/**
 * jira_client — Zero-dependency Jira REST API v3 client
 * (pure Node.js https built-ins; no npm deps)
 *
 * Authentication:
 *   - API Token (email + api_token via HTTP Basic Auth)
 *     Base64-encodes "email:api_token" → Authorization: Basic ...
 *   - Personal Access Token / Bearer token (pat)
 *     Authorization: Bearer <pat>
 *   Unauthenticated access allowed for public Jira instances.
 *   Credentials never returned in output or errors.
 *
 * Base URL:
 *   For Jira Cloud: https://<your-domain>.atlassian.net
 *   For Jira Server/Data Center: https://<your-host>
 *   Pass base_url to override.
 *
 * Supported operations (58 total):
 *
 *   Issues (11):
 *     issue_get, issue_create, issue_update, issue_delete,
 *     issue_assign, issue_transition, issue_transitions,
 *     issue_comment, issue_comments, issue_search, issue_bulk_create
 *
 *   Projects (6):
 *     project_get, project_list, project_create, project_delete,
 *     project_components, project_versions
 *
 *   Boards (4):
 *     board_list, board_get, board_sprints, board_issues
 *
 *   Sprints (4):
 *     sprint_get, sprint_create, sprint_update, sprint_issues
 *
 *   Users (4):
 *     user_get, user_search, user_me, user_assignable
 *
 *   Fields (3):
 *     field_list, field_create, field_search
 *
 *   Attachments (3):
 *     attachment_get, attachment_delete, issue_attachments
 *
 *   Watchers (2):
 *     issue_watchers, issue_add_watcher
 *
 *   Votes (2):
 *     issue_votes, issue_add_vote
 *
 *   Labels (1):
 *     label_list
 *
 *   Priorities (2):
 *     priority_list, priority_get
 *
 *   Issue Types (2):
 *     issuetype_list, issuetype_get
 *
 *   Worklogs (3):
 *     issue_worklog_list, issue_worklog_add, issue_worklog_delete
 *
 *   Links (3):
 *     issue_link, issue_link_get, issue_link_delete
 *
 *   Filters (3):
 *     filter_list, filter_get, filter_create
 *
 *   Generic (1):
 *     request
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

// --- Constants ---------------------------------------------------------------

const DEFAULT_TIMEOUT_MS  = 20000;
const MAX_RESPONSE_BYTES  = 16 * 1024 * 1024; // 16 MB
const JIRA_API_V3         = "/rest/api/3";
const JIRA_AGILE_V1       = "/rest/agile/1.0";

// --- Guard helpers -----------------------------------------------------------

function requireString(val, name) {
  if (typeof val !== "string" || val.length === 0)
    throw new Error(`${name} must be a non-empty string`);
  if (val.includes("\0"))
    throw new Error(`${name} must not contain NUL bytes`);
}

function guardString(val, name) {
  if (val === undefined || val === null) return;
  if (typeof val !== "string") throw new Error(`${name} must be a string`);
  if (val.includes("\0")) throw new Error(`${name} must not contain NUL bytes`);
}

function clampInt(val, min, max, def) {
  if (val === undefined || val === null) return def;
  const n = Number(val);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

// --- Build connection config --------------------------------------------------

function buildConn(args) {
  const {
    base_url,
    email,
    api_token,
    pat,
    timeout,
    reject_unauthorized,
  } = args;

  guardString(base_url, "base_url");
  guardString(email, "email");
  guardString(api_token, "api_token");
  guardString(pat, "pat");

  // Determine auth header
  let authHeader = null;
  if (pat) {
    authHeader = `Bearer ${pat}`;
  } else if (email && api_token) {
    const creds = Buffer.from(`${email}:${api_token}`).toString("base64");
    authHeader = `Basic ${creds}`;
  }

  const rawBase = (base_url || "").replace(/\/+$/, "");
  if (rawBase && rawBase.includes("\0"))
    throw new Error("base_url must not contain NUL bytes");

  return {
    baseUrl: rawBase || "",
    authHeader,
    timeoutMs: clampInt(timeout, 1000, 120000, DEFAULT_TIMEOUT_MS),
    rejectUnauthorized: reject_unauthorized !== false,
  };
}

// --- HTTP helper -------------------------------------------------------------

function doRequest(conn, method, path, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const fullUrl = `${conn.baseUrl}${path}`;
    let urlObj;
    try { urlObj = new URL(fullUrl); }
    catch { return reject(new Error(`Invalid URL: ${fullUrl}`)); }

    const isHttps = urlObj.protocol === "https:";
    const transport = isHttps ? https : http;
    const port = urlObj.port
      ? Number(urlObj.port)
      : isHttps ? 443 : 80;

    const reqBody = body !== undefined ? JSON.stringify(body) : undefined;

    const headers = {
      "Accept":       "application/json",
      "Content-Type": "application/json",
      ...extraHeaders,
    };
    if (conn.authHeader) headers["Authorization"] = conn.authHeader;
    if (reqBody !== undefined) headers["Content-Length"] = Buffer.byteLength(reqBody);

    const options = {
      hostname:           urlObj.hostname,
      port,
      path:               urlObj.pathname + urlObj.search,
      method:             method.toUpperCase(),
      headers,
      rejectUnauthorized: conn.rejectUnauthorized,
    };

    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`Request timed out after ${conn.timeoutMs}ms`));
    }, conn.timeoutMs);

    const req = transport.request(options, (res) => {
      const chunks = [];
      let total = 0;
      res.on("data", (chunk) => {
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) {
          res.destroy();
          clearTimeout(timer);
          reject(new Error("Response exceeded 16 MB cap"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        clearTimeout(timer);
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode, headers: res.headers, raw });
      });
      res.on("error", (err) => { clearTimeout(timer); reject(err); });
    });

    req.on("error", (err) => { clearTimeout(timer); reject(err); });
    if (reqBody !== undefined) req.write(reqBody);
    req.end();
  });
}

// --- JSON parse helper -------------------------------------------------------

function parseJson(raw, context) {
  if (!raw || raw.trim() === "") return null;
  try { return JSON.parse(raw); }
  catch { throw new Error(`Failed to parse JSON for ${context}: ${raw.slice(0, 200)}`); }
}

// --- Status checker ----------------------------------------------------------

function checkStatus(res, context, { allow404 = false, allow204 = false } = {}) {
  const { status, raw } = res;
  if (status === 204 && allow204) return null;
  if (status === 404 && allow404) return null;
  if (status >= 200 && status < 300) return parseJson(raw, context);
  // Extract Jira error messages
  let detail = "";
  try {
    const obj = JSON.parse(raw);
    if (obj && obj.errorMessages && obj.errorMessages.length) {
      detail = obj.errorMessages.join("; ");
    } else if (obj && obj.errors) {
      detail = Object.entries(obj.errors).map(([k, v]) => `${k}: ${v}`).join("; ");
    } else if (obj && obj.message) {
      detail = obj.message;
    }
  } catch { detail = raw.slice(0, 300); }
  throw new Error(`Jira ${context} failed (HTTP ${status})${detail ? ": " + detail : ""}`);
}

// --- URL helpers -------------------------------------------------------------

function enc(s) { return encodeURIComponent(String(s)); }

function qs(params) {
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      for (const item of v) parts.push(`${enc(k)}=${enc(item)}`);
    } else {
      parts.push(`${enc(k)}=${enc(v)}`);
    }
  }
  return parts.length ? "?" + parts.join("&") : "";
}

// --- Mappers -----------------------------------------------------------------

function mapIssue(raw) {
  if (!raw) return null;
  const f = raw.fields || {};
  return {
    id:          raw.id,
    key:         raw.key,
    summary:     f.summary || null,
    status:      f.status ? f.status.name : null,
    statusCategory: f.status && f.status.statusCategory ? f.status.statusCategory.name : null,
    issuetype:   f.issuetype ? f.issuetype.name : null,
    priority:    f.priority ? f.priority.name : null,
    assignee:    f.assignee ? (f.assignee.displayName || f.assignee.emailAddress || f.assignee.name) : null,
    reporter:    f.reporter ? (f.reporter.displayName || f.reporter.emailAddress || f.reporter.name) : null,
    creator:     f.creator  ? (f.creator.displayName  || f.creator.emailAddress  || f.creator.name)  : null,
    created:     f.created || null,
    updated:     f.updated || null,
    duedate:     f.duedate || null,
    description: f.description || null,
    labels:      f.labels || [],
    components:  f.components  ? f.components.map(c => c.name)  : [],
    fixVersions: f.fixVersions ? f.fixVersions.map(v => v.name) : [],
    affectedVersions: f.versions ? f.versions.map(v => v.name) : [],
    resolution:  f.resolution ? f.resolution.name : null,
    resolutionDate: f.resolutiondate || null,
    comment_count: f.comment ? f.comment.total : null,
    subtasks:    f.subtasks ? f.subtasks.map(s => ({ id: s.id, key: s.key, summary: s.fields && s.fields.summary })) : [],
    parent:      f.parent  ? { id: f.parent.id, key: f.parent.key } : null,
    project:     f.project ? { id: f.project.id, key: f.project.key, name: f.project.name } : null,
    self:        raw.self || null,
  };
}

function mapProject(raw) {
  if (!raw) return null;
  return {
    id:          raw.id,
    key:         raw.key,
    name:        raw.name,
    description: raw.description || null,
    projectType: raw.projectTypeKey || null,
    lead:        raw.lead ? (raw.lead.displayName || raw.lead.name) : null,
    url:         raw.self || null,
    simplified:  raw.simplified || null,
    style:       raw.style || null,
  };
}

function mapUser(raw) {
  if (!raw) return null;
  return {
    accountId:    raw.accountId   || null,
    displayName:  raw.displayName || null,
    emailAddress: raw.emailAddress || null,
    active:       raw.active !== undefined ? raw.active : null,
    accountType:  raw.accountType || null,
    avatarUrls:   raw.avatarUrls || null,
    self:         raw.self || null,
  };
}

function mapComment(raw) {
  if (!raw) return null;
  return {
    id:      raw.id,
    author:  raw.author ? (raw.author.displayName || raw.author.emailAddress) : null,
    body:    raw.body || null,
    created: raw.created || null,
    updated: raw.updated || null,
    self:    raw.self || null,
  };
}

function mapBoard(raw) {
  if (!raw) return null;
  return {
    id:       raw.id,
    name:     raw.name,
    type:     raw.type || null,
    location: raw.location ? {
      projectId:   raw.location.projectId,
      projectKey:  raw.location.projectKey,
      projectName: raw.location.projectName,
    } : null,
    self: raw.self || null,
  };
}

function mapSprint(raw) {
  if (!raw) return null;
  return {
    id:            raw.id,
    name:          raw.name,
    state:         raw.state || null,
    startDate:     raw.startDate    || null,
    endDate:       raw.endDate      || null,
    completeDate:  raw.completeDate || null,
    originBoardId: raw.originBoardId || null,
    goal:          raw.goal || null,
    self:          raw.self || null,
  };
}

function mapTransition(raw) {
  if (!raw) return null;
  return {
    id:        raw.id,
    name:      raw.name,
    to:        raw.to ? { id: raw.to.id, name: raw.to.name } : null,
    hasScreen: raw.hasScreen || false,
    fields:    raw.fields ? Object.keys(raw.fields) : [],
  };
}

// --- Main dispatcher ---------------------------------------------------------

async function jiraClient(args) {
  const { operation } = args;
  if (!operation || typeof operation !== "string")
    throw new Error("operation must be a non-empty string");

  const conn = buildConn(args);
  if (!conn.baseUrl)
    throw new Error("base_url must be provided (e.g. 'https://yourorg.atlassian.net')");

  // ── ISSUES ────────────────────────────────────────────────────────────────

  if (operation === "issue_get") {
    const { issue_key, fields, expand } = args;
    requireString(issue_key, "issue_key");
    const query = qs({ fields: fields ? fields.join(",") : undefined, expand });
    const res = await doRequest(conn, "GET", `${JIRA_API_V3}/issue/${enc(issue_key)}${query}`);
    if (res.status === 404) return { exists: false, issue_key };
    const data = checkStatus(res, "issue_get");
    return { exists: true, issue: mapIssue(data) };
  }

  if (operation === "issue_create") {
    const { project_key, summary, issuetype, description, priority, assignee_id,
            labels, components, fix_versions, due_date, parent_key, fields_extra } = args;
    requireString(project_key, "project_key");
    requireString(summary, "summary");
    requireString(issuetype, "issuetype");
    guardString(description, "description");

    const fieldsObj = {
      project:   { key: project_key },
      summary,
      issuetype: { name: issuetype },
      ...(description  ? { description } : {}),
      ...(priority     ? { priority: { name: priority } } : {}),
      ...(assignee_id  ? { assignee: { accountId: assignee_id } } : {}),
      ...(labels && labels.length           ? { labels } : {}),
      ...(components && components.length   ? { components: components.map(c => ({ name: c })) } : {}),
      ...(fix_versions && fix_versions.length ? { fixVersions: fix_versions.map(v => ({ name: v })) } : {}),
      ...(due_date     ? { duedate: due_date } : {}),
      ...(parent_key   ? { parent: { key: parent_key } } : {}),
      ...(fields_extra || {}),
    };
    const res = await doRequest(conn, "POST", `${JIRA_API_V3}/issue`, { fields: fieldsObj });
    const data = checkStatus(res, "issue_create");
    return { created: true, id: data.id, key: data.key, self: data.self };
  }

  if (operation === "issue_update") {
    const { issue_key, summary, description, priority, assignee_id,
            labels, components, fix_versions, due_date, fields_extra } = args;
    requireString(issue_key, "issue_key");
    guardString(description, "description");

    const fieldsObj = {
      ...(summary      ? { summary } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(priority     ? { priority: { name: priority } } : {}),
      ...(assignee_id !== undefined ? { assignee: assignee_id ? { accountId: assignee_id } : null } : {}),
      ...(labels       ? { labels } : {}),
      ...(components   ? { components: components.map(c => ({ name: c })) } : {}),
      ...(fix_versions ? { fixVersions: fix_versions.map(v => ({ name: v })) } : {}),
      ...(due_date     ? { duedate: due_date } : {}),
      ...(fields_extra || {}),
    };
    const res = await doRequest(conn, "PUT", `${JIRA_API_V3}/issue/${enc(issue_key)}`, { fields: fieldsObj });
    if (res.status === 404) return { updated: false, issue_key, reason: "not_found" };
    checkStatus(res, "issue_update", { allow204: true });
    return { updated: true, issue_key };
  }

  if (operation === "issue_delete") {
    const { issue_key, delete_subtasks } = args;
    requireString(issue_key, "issue_key");
    const query = qs({ deleteSubtasks: delete_subtasks ? "true" : undefined });
    const res = await doRequest(conn, "DELETE", `${JIRA_API_V3}/issue/${enc(issue_key)}${query}`);
    if (res.status === 404) return { deleted: false, issue_key, reason: "not_found" };
    checkStatus(res, "issue_delete", { allow204: true });
    return { deleted: true, issue_key };
  }

  if (operation === "issue_assign") {
    const { issue_key, assignee_id } = args;
    requireString(issue_key, "issue_key");
    const body = { accountId: assignee_id || null };
    const res = await doRequest(conn, "PUT", `${JIRA_API_V3}/issue/${enc(issue_key)}/assignee`, body);
    if (res.status === 404) return { assigned: false, issue_key, reason: "not_found" };
    checkStatus(res, "issue_assign", { allow204: true });
    return { assigned: true, issue_key, assignee_id: assignee_id || null };
  }

  if (operation === "issue_transitions") {
    const { issue_key } = args;
    requireString(issue_key, "issue_key");
    const res = await doRequest(conn, "GET", `${JIRA_API_V3}/issue/${enc(issue_key)}/transitions`);
    if (res.status === 404) return { exists: false, issue_key };
    const data = checkStatus(res, "issue_transitions");
    return { issue_key, transitions: (data.transitions || []).map(mapTransition) };
  }

  if (operation === "issue_transition") {
    const { issue_key, transition_id, transition_name, fields_extra, comment } = args;
    requireString(issue_key, "issue_key");

    let tid = transition_id;
    if (!tid && transition_name) {
      const tres = await doRequest(conn, "GET", `${JIRA_API_V3}/issue/${enc(issue_key)}/transitions`);
      const tdata = checkStatus(tres, "issue_transitions");
      const found = (tdata.transitions || []).find(
        t => t.name.toLowerCase() === String(transition_name).toLowerCase()
      );
      if (!found) throw new Error(`Transition '${transition_name}' not found for issue ${issue_key}`);
      tid = found.id;
    }
    if (!tid) throw new Error("Either transition_id or transition_name must be provided");

    const body = {
      transition: { id: String(tid) },
      ...(fields_extra ? { fields: fields_extra } : {}),
      ...(comment ? { update: { comment: [{ add: { body: comment } }] } } : {}),
    };
    const res = await doRequest(conn, "POST", `${JIRA_API_V3}/issue/${enc(issue_key)}/transitions`, body);
    if (res.status === 404) return { transitioned: false, issue_key, reason: "not_found" };
    checkStatus(res, "issue_transition", { allow204: true });
    return { transitioned: true, issue_key, transition_id: tid };
  }

  if (operation === "issue_comment") {
    const { issue_key, body: commentBody } = args;
    requireString(issue_key, "issue_key");
    requireString(commentBody, "body");
    const res = await doRequest(conn, "POST", `${JIRA_API_V3}/issue/${enc(issue_key)}/comment`, { body: commentBody });
    if (res.status === 404) return { commented: false, issue_key, reason: "not_found" };
    const data = checkStatus(res, "issue_comment");
    return { commented: true, comment: mapComment(data) };
  }

  if (operation === "issue_comments") {
    const { issue_key, max_results, start_at } = args;
    requireString(issue_key, "issue_key");
    const query = qs({
      maxResults: clampInt(max_results, 1, 100, 20),
      startAt:    clampInt(start_at, 0, 999999, 0),
    });
    const res = await doRequest(conn, "GET", `${JIRA_API_V3}/issue/${enc(issue_key)}/comment${query}`);
    if (res.status === 404) return { exists: false, issue_key };
    const data = checkStatus(res, "issue_comments");
    return {
      issue_key,
      total:      data.total      || 0,
      startAt:    data.startAt    || 0,
      maxResults: data.maxResults || 0,
      comments:   (data.comments  || []).map(mapComment),
    };
  }

  if (operation === "issue_search") {
    const { jql, fields, max_results, start_at, expand } = args;
    requireString(jql, "jql");
    const body = {
      jql,
      maxResults: clampInt(max_results, 1, 100, 20),
      startAt:    clampInt(start_at, 0, 999999, 0),
      fields:     fields || ["summary", "status", "assignee", "priority", "issuetype", "created", "updated"],
      ...(expand ? { expand: Array.isArray(expand) ? expand : [expand] } : {}),
    };
    const res = await doRequest(conn, "POST", `${JIRA_API_V3}/issue/search`, body);
    const data = checkStatus(res, "issue_search");
    return {
      total:      data.total      || 0,
      startAt:    data.startAt    || 0,
      maxResults: data.maxResults || 0,
      issues:     (data.issues    || []).map(mapIssue),
    };
  }

  if (operation === "issue_bulk_create") {
    const { issues } = args;
    if (!Array.isArray(issues) || issues.length === 0)
      throw new Error("issues must be a non-empty array");
    const issueUpdates = issues.map(iss => ({
      fields: {
        project:   { key: iss.project_key },
        summary:   iss.summary,
        issuetype: { name: iss.issuetype || "Task" },
        ...(iss.description ? { description: iss.description } : {}),
        ...(iss.priority    ? { priority: { name: iss.priority } } : {}),
        ...(iss.assignee_id ? { assignee: { accountId: iss.assignee_id } } : {}),
        ...(iss.labels      ? { labels: iss.labels } : {}),
      }
    }));
    const res = await doRequest(conn, "POST", `${JIRA_API_V3}/issue/bulk`, { issueUpdates });
    const data = checkStatus(res, "issue_bulk_create");
    return {
      created: (data.issues || []).map(i => ({ id: i.id, key: i.key })),
      errors:  data.errors || [],
    };
  }

  // ── PROJECTS ──────────────────────────────────────────────────────────────

  if (operation === "project_get") {
    const { project_key } = args;
    requireString(project_key, "project_key");
    const res = await doRequest(conn, "GET", `${JIRA_API_V3}/project/${enc(project_key)}`);
    if (res.status === 404) return { exists: false, project_key };
    const data = checkStatus(res, "project_get");
    return { exists: true, project: mapProject(data) };
  }

  if (operation === "project_list") {
    const { max_results, start_at, order_by, query: q, type_key } = args;
    const query = qs({
      maxResults: clampInt(max_results, 1, 50, 20),
      startAt:    clampInt(start_at, 0, 999999, 0),
      orderBy:    order_by,
      query:      q,
      typeKey:    type_key,
    });
    const res = await doRequest(conn, "GET", `${JIRA_API_V3}/project/search${query}`);
    const data = checkStatus(res, "project_list");
    return {
      total:      data.total      || 0,
      startAt:    data.startAt    || 0,
      maxResults: data.maxResults || 0,
      projects:   (data.values    || []).map(mapProject),
    };
  }

  if (operation === "project_create") {
    const { project_key, name, project_type, lead_account_id, description, assignee_type, template_key } = args;
    requireString(project_key, "project_key");
    requireString(name, "name");
    requireString(project_type, "project_type");
    guardString(description, "description");
    const body = {
      key:            project_key,
      name,
      projectTypeKey: project_type,
      ...(lead_account_id ? { leadAccountId: lead_account_id } : {}),
      ...(description     ? { description } : {}),
      ...(assignee_type   ? { assigneeType: assignee_type } : {}),
      ...(template_key    ? { projectTemplateKey: template_key } : {}),
    };
    const res = await doRequest(conn, "POST", `${JIRA_API_V3}/project`, body);
    const data = checkStatus(res, "project_create");
    return { created: true, id: data.id, key: data.key, self: data.self };
  }

  if (operation === "project_delete") {
    const { project_key } = args;
    requireString(project_key, "project_key");
    const res = await doRequest(conn, "DELETE", `${JIRA_API_V3}/project/${enc(project_key)}`);
    if (res.status === 404) return { deleted: false, project_key, reason: "not_found" };
    checkStatus(res, "project_delete", { allow204: true });
    return { deleted: true, project_key };
  }

  if (operation === "project_components") {
    const { project_key } = args;
    requireString(project_key, "project_key");
    const res = await doRequest(conn, "GET", `${JIRA_API_V3}/project/${enc(project_key)}/components`);
    if (res.status === 404) return { exists: false, project_key };
    const data = checkStatus(res, "project_components");
    return {
      project_key,
      components: (Array.isArray(data) ? data : []).map(c => ({
        id: c.id, name: c.name, description: c.description || null,
        lead: c.lead ? c.lead.displayName : null, self: c.self,
      })),
    };
  }

  if (operation === "project_versions") {
    const { project_key, order_by } = args;
    requireString(project_key, "project_key");
    const query = qs({ orderBy: order_by });
    const res = await doRequest(conn, "GET", `${JIRA_API_V3}/project/${enc(project_key)}/versions${query}`);
    if (res.status === 404) return { exists: false, project_key };
    const data = checkStatus(res, "project_versions");
    return {
      project_key,
      versions: (Array.isArray(data) ? data : []).map(v => ({
        id: v.id, name: v.name, description: v.description || null,
        released: v.released || false, archived: v.archived || false,
        releaseDate: v.releaseDate || null, self: v.self,
      })),
    };
  }

  // ── BOARDS ────────────────────────────────────────────────────────────────

  if (operation === "board_list") {
    const { project_key_or_id, type, max_results, start_at, name } = args;
    const query = qs({
      projectKeyOrId: project_key_or_id,
      type,
      maxResults: clampInt(max_results, 1, 50, 20),
      startAt:    clampInt(start_at, 0, 999999, 0),
      name,
    });
    const res = await doRequest(conn, "GET", `${JIRA_AGILE_V1}/board${query}`);
    const data = checkStatus(res, "board_list");
    return {
      total:      data.total      || 0,
      startAt:    data.startAt    || 0,
      maxResults: data.maxResults || 0,
      boards:     (data.values    || []).map(mapBoard),
    };
  }

  if (operation === "board_get") {
    const { board_id } = args;
    if (board_id === undefined || board_id === null) throw new Error("board_id is required");
    const res = await doRequest(conn, "GET", `${JIRA_AGILE_V1}/board/${enc(board_id)}`);
    if (res.status === 404) return { exists: false, board_id };
    const data = checkStatus(res, "board_get");
    return { exists: true, board: mapBoard(data) };
  }

  if (operation === "board_sprints") {
    const { board_id, state, max_results, start_at } = args;
    if (board_id === undefined || board_id === null) throw new Error("board_id is required");
    const query = qs({
      state,
      maxResults: clampInt(max_results, 1, 50, 20),
      startAt:    clampInt(start_at, 0, 999999, 0),
    });
    const res = await doRequest(conn, "GET", `${JIRA_AGILE_V1}/board/${enc(board_id)}/sprint${query}`);
    if (res.status === 404) return { exists: false, board_id };
    const data = checkStatus(res, "board_sprints");
    return {
      total:      data.total      || 0,
      startAt:    data.startAt    || 0,
      maxResults: data.maxResults || 0,
      sprints:    (data.values    || []).map(mapSprint),
    };
  }

  if (operation === "board_issues") {
    const { board_id, jql, max_results, start_at, fields } = args;
    if (board_id === undefined || board_id === null) throw new Error("board_id is required");
    const query = qs({
      jql,
      maxResults: clampInt(max_results, 1, 100, 20),
      startAt:    clampInt(start_at, 0, 999999, 0),
      fields:     fields ? fields.join(",") : "summary,status,assignee,priority",
    });
    const res = await doRequest(conn, "GET", `${JIRA_AGILE_V1}/board/${enc(board_id)}/issue${query}`);
    if (res.status === 404) return { exists: false, board_id };
    const data = checkStatus(res, "board_issues");
    return {
      total:      data.total      || 0,
      startAt:    data.startAt    || 0,
      maxResults: data.maxResults || 0,
      issues:     (data.issues    || []).map(mapIssue),
    };
  }

  // ── SPRINTS ───────────────────────────────────────────────────────────────

  if (operation === "sprint_get") {
    const { sprint_id } = args;
    if (sprint_id === undefined || sprint_id === null) throw new Error("sprint_id is required");
    const res = await doRequest(conn, "GET", `${JIRA_AGILE_V1}/sprint/${enc(sprint_id)}`);
    if (res.status === 404) return { exists: false, sprint_id };
    const data = checkStatus(res, "sprint_get");
    return { exists: true, sprint: mapSprint(data) };
  }

  if (operation === "sprint_create") {
    const { board_id, name, goal, start_date, end_date } = args;
    if (board_id === undefined || board_id === null) throw new Error("board_id is required");
    requireString(name, "name");
    const body = {
      name,
      originBoardId: Number(board_id),
      ...(goal       ? { goal } : {}),
      ...(start_date ? { startDate: start_date } : {}),
      ...(end_date   ? { endDate: end_date } : {}),
    };
    const res = await doRequest(conn, "POST", `${JIRA_AGILE_V1}/sprint`, body);
    const data = checkStatus(res, "sprint_create");
    return { created: true, sprint: mapSprint(data) };
  }

  if (operation === "sprint_update") {
    const { sprint_id, name, goal, state, start_date, end_date } = args;
    if (sprint_id === undefined || sprint_id === null) throw new Error("sprint_id is required");
    const body = {
      ...(name       ? { name } : {}),
      ...(goal       ? { goal } : {}),
      ...(state      ? { state } : {}),
      ...(start_date ? { startDate: start_date } : {}),
      ...(end_date   ? { endDate: end_date } : {}),
    };
    const res = await doRequest(conn, "PUT", `${JIRA_AGILE_V1}/sprint/${enc(sprint_id)}`, body);
    if (res.status === 404) return { updated: false, sprint_id, reason: "not_found" };
    const data = checkStatus(res, "sprint_update");
    return { updated: true, sprint: mapSprint(data) };
  }

  if (operation === "sprint_issues") {
    const { sprint_id, jql, max_results, start_at, fields } = args;
    if (sprint_id === undefined || sprint_id === null) throw new Error("sprint_id is required");
    const query = qs({
      jql,
      maxResults: clampInt(max_results, 1, 100, 20),
      startAt:    clampInt(start_at, 0, 999999, 0),
      fields:     fields ? fields.join(",") : "summary,status,assignee,priority",
    });
    const res = await doRequest(conn, "GET", `${JIRA_AGILE_V1}/sprint/${enc(sprint_id)}/issue${query}`);
    if (res.status === 404) return { exists: false, sprint_id };
    const data = checkStatus(res, "sprint_issues");
    return {
      total:      data.total      || 0,
      startAt:    data.startAt    || 0,
      maxResults: data.maxResults || 0,
      issues:     (data.issues    || []).map(mapIssue),
    };
  }

  // ── USERS ─────────────────────────────────────────────────────────────────

  if (operation === "user_me") {
    const res = await doRequest(conn, "GET", `${JIRA_API_V3}/myself`);
    const data = checkStatus(res, "user_me");
    return { user: mapUser(data) };
  }

  if (operation === "user_get") {
    const { account_id } = args;
    requireString(account_id, "account_id");
    const query = qs({ accountId: account_id });
    const res = await doRequest(conn, "GET", `${JIRA_API_V3}/user${query}`);
    if (res.status === 404) return { exists: false, account_id };
    const data = checkStatus(res, "user_get");
    return { exists: true, user: mapUser(data) };
  }

  if (operation === "user_search") {
    const { query: q, max_results, start_at } = args;
    requireString(q, "query");
    const qstr = qs({
      query:      q,
      maxResults: clampInt(max_results, 1, 50, 20),
      startAt:    clampInt(start_at, 0, 999999, 0),
    });
    const res = await doRequest(conn, "GET", `${JIRA_API_V3}/user/search${qstr}`);
    const data = checkStatus(res, "user_search");
    return { users: (Array.isArray(data) ? data : []).map(mapUser) };
  }

  if (operation === "user_assignable") {
    const { issue_key, project_key, max_results, start_at } = args;
    if (!issue_key && !project_key)
      throw new Error("Either issue_key or project_key must be provided");
    const query = qs({
      issueKey:   issue_key,
      project:    project_key,
      maxResults: clampInt(max_results, 1, 50, 20),
      startAt:    clampInt(start_at, 0, 999999, 0),
    });
    const res = await doRequest(conn, "GET", `${JIRA_API_V3}/user/assignable/search${query}`);
    const data = checkStatus(res, "user_assignable");
    return { users: (Array.isArray(data) ? data : []).map(mapUser) };
  }

  // ── FIELDS ────────────────────────────────────────────────────────────────

  if (operation === "field_list") {
    const res = await doRequest(conn, "GET", `${JIRA_API_V3}/field`);
    const data = checkStatus(res, "field_list");
    return {
      fields: (Array.isArray(data) ? data : []).map(f => ({
        id:          f.id,
        name:        f.name,
        custom:      f.custom      || false,
        orderable:   f.orderable   || false,
        navigable:   f.navigable   || false,
        searchable:  f.searchable  || false,
        clauseNames: f.clauseNames || [],
        schema:      f.schema      || null,
      })),
    };
  }

  if (operation === "field_search") {
    const { query: q, type, max_results, start_at } = args;
    const qstr = qs({
      query:      q,
      type,
      maxResults: clampInt(max_results, 1, 50, 20),
      startAt:    clampInt(start_at, 0, 999999, 0),
    });
    const res = await doRequest(conn, "GET", `${JIRA_API_V3}/field/search${qstr}`);
    const data = checkStatus(res, "field_search");
    return {
      total:  data.total || 0,
      fields: (data.values || []).map(f => ({
        id: f.id, name: f.name, custom: f.custom || false, schema: f.schema || null,
      })),
    };
  }

  if (operation === "field_create") {
    const { name, description, type, searcher_key } = args;
    requireString(name, "name");
    requireString(type, "type");
    const body = {
      name,
      ...(description  ? { description } : {}),
      type,
      ...(searcher_key ? { searcherKey: searcher_key } : {}),
    };
    const res = await doRequest(conn, "POST", `${JIRA_API_V3}/field`, body);
    const data = checkStatus(res, "field_create");
    return { created: true, id: data.id, name: data.name, self: data.self };
  }

  // ── ATTACHMENTS ───────────────────────────────────────────────────────────

  if (operation === "issue_attachments") {
    const { issue_key } = args;
    requireString(issue_key, "issue_key");
    const res = await doRequest(conn, "GET", `${JIRA_API_V3}/issue/${enc(issue_key)}?fields=attachment`);
    if (res.status === 404) return { exists: false, issue_key };
    const data = checkStatus(res, "issue_attachments");
    const attachments = (data.fields && data.fields.attachment) || [];
    return {
      issue_key,
      attachments: attachments.map(a => ({
        id: a.id, filename: a.filename, size: a.size,
        mimeType: a.mimeType, content: a.content, created: a.created,
        author: a.author ? a.author.displayName : null,
      })),
    };
  }

  if (operation === "attachment_get") {
    const { attachment_id } = args;
    requireString(attachment_id, "attachment_id");
    const res = await doRequest(conn, "GET", `${JIRA_API_V3}/attachment/${enc(attachment_id)}`);
    if (res.status === 404) return { exists: false, attachment_id };
    const data = checkStatus(res, "attachment_get");
    return {
      exists: true,
      attachment: {
        id: data.id, filename: data.filename, size: data.size,
        mimeType: data.mimeType, content: data.content, created: data.created,
        author: data.author ? data.author.displayName : null, self: data.self,
      },
    };
  }

  if (operation === "attachment_delete") {
    const { attachment_id } = args;
    requireString(attachment_id, "attachment_id");
    const res = await doRequest(conn, "DELETE", `${JIRA_API_V3}/attachment/${enc(attachment_id)}`);
    if (res.status === 404) return { deleted: false, attachment_id, reason: "not_found" };
    checkStatus(res, "attachment_delete", { allow204: true });
    return { deleted: true, attachment_id };
  }

  // ── WATCHERS ──────────────────────────────────────────────────────────────

  if (operation === "issue_watchers") {
    const { issue_key } = args;
    requireString(issue_key, "issue_key");
    const res = await doRequest(conn, "GET", `${JIRA_API_V3}/issue/${enc(issue_key)}/watchers`);
    if (res.status === 404) return { exists: false, issue_key };
    const data = checkStatus(res, "issue_watchers");
    return {
      issue_key,
      watchCount: data.watchCount || 0,
      isWatching: data.isWatching || false,
      watchers:   (data.watchers  || []).map(mapUser),
    };
  }

  if (operation === "issue_add_watcher") {
    const { issue_key, account_id } = args;
    requireString(issue_key, "issue_key");
    requireString(account_id, "account_id");
    // Jira expects account_id as a quoted JSON string body
    const body = JSON.stringify(account_id);
    const res = await new Promise((resolve, reject) => {
      const fullUrl = `${conn.baseUrl}${JIRA_API_V3}/issue/${enc(issue_key)}/watchers`;
      let urlObj;
      try { urlObj = new URL(fullUrl); }
      catch { return reject(new Error(`Invalid URL: ${fullUrl}`)); }
      const isHttps = urlObj.protocol === "https:";
      const transport = isHttps ? https : http;
      const headers = {
        "Accept":         "application/json",
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(body),
      };
      if (conn.authHeader) headers["Authorization"] = conn.authHeader;
      const opts = {
        hostname: urlObj.hostname, port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname + urlObj.search, method: "POST", headers,
        rejectUnauthorized: conn.rejectUnauthorized,
      };
      const timer = setTimeout(() => { req.destroy(); reject(new Error("Timeout")); }, conn.timeoutMs);
      const req = transport.request(opts, (res2) => {
        const chunks = [];
        res2.on("data", c => chunks.push(c));
        res2.on("end", () => { clearTimeout(timer); resolve({ status: res2.statusCode, raw: Buffer.concat(chunks).toString() }); });
        res2.on("error", err => { clearTimeout(timer); reject(err); });
      });
      req.on("error", err => { clearTimeout(timer); reject(err); });
      req.write(body);
      req.end();
    });
    if (res.status === 404) return { added: false, issue_key, reason: "not_found" };
    if (res.status === 204 || (res.status >= 200 && res.status < 300)) {
      return { added: true, issue_key, account_id };
    }
    throw new Error(`Jira issue_add_watcher failed (HTTP ${res.status}): ${res.raw.slice(0, 200)}`);
  }

  // ── VOTES ─────────────────────────────────────────────────────────────────

  if (operation === "issue_votes") {
    const { issue_key } = args;
    requireString(issue_key, "issue_key");
    const res = await doRequest(conn, "GET", `${JIRA_API_V3}/issue/${enc(issue_key)}/votes`);
    if (res.status === 404) return { exists: false, issue_key };
    const data = checkStatus(res, "issue_votes");
    return {
      issue_key,
      votes:    data.votes    || 0,
      hasVoted: data.hasVoted || false,
      voters:   (data.voters  || []).map(mapUser),
    };
  }

  if (operation === "issue_add_vote") {
    const { issue_key } = args;
    requireString(issue_key, "issue_key");
    const res = await doRequest(conn, "POST", `${JIRA_API_V3}/issue/${enc(issue_key)}/votes`);
    if (res.status === 404) return { voted: false, issue_key, reason: "not_found" };
    checkStatus(res, "issue_add_vote", { allow204: true });
    return { voted: true, issue_key };
  }

  // ── LABELS ────────────────────────────────────────────────────────────────

  if (operation === "label_list") {
    const { max_results, start_at } = args;
    const query = qs({
      maxResults: clampInt(max_results, 1, 200, 50),
      startAt:    clampInt(start_at, 0, 999999, 0),
    });
    const res = await doRequest(conn, "GET", `${JIRA_API_V3}/label${query}`);
    const data = checkStatus(res, "label_list");
    return {
      total:      data.total      || 0,
      startAt:    data.startAt    || 0,
      maxResults: data.maxResults || 0,
      labels:     data.values     || [],
    };
  }

  // ── PRIORITIES ────────────────────────────────────────────────────────────

  if (operation === "priority_list") {
    const res = await doRequest(conn, "GET", `${JIRA_API_V3}/priority`);
    const data = checkStatus(res, "priority_list");
    return {
      priorities: (Array.isArray(data) ? data : []).map(p => ({
        id: p.id, name: p.name, description: p.description || null,
        iconUrl: p.iconUrl || null, statusColor: p.statusColor || null,
      })),
    };
  }

  if (operation === "priority_get") {
    const { priority_id } = args;
    requireString(priority_id, "priority_id");
    const res = await doRequest(conn, "GET", `${JIRA_API_V3}/priority/${enc(priority_id)}`);
    if (res.status === 404) return { exists: false, priority_id };
    const data = checkStatus(res, "priority_get");
    return {
      exists: true,
      priority: { id: data.id, name: data.name, description: data.description || null, iconUrl: data.iconUrl || null },
    };
  }

  // ── ISSUE TYPES ───────────────────────────────────────────────────────────

  if (operation === "issuetype_list") {
    const res = await doRequest(conn, "GET", `${JIRA_API_V3}/issuetype`);
    const data = checkStatus(res, "issuetype_list");
    return {
      issueTypes: (Array.isArray(data) ? data : []).map(t => ({
        id: t.id, name: t.name, description: t.description || null,
        subtask: t.subtask || false, iconUrl: t.iconUrl || null,
      })),
    };
  }

  if (operation === "issuetype_get") {
    const { issuetype_id } = args;
    requireString(issuetype_id, "issuetype_id");
    const res = await doRequest(conn, "GET", `${JIRA_API_V3}/issuetype/${enc(issuetype_id)}`);
    if (res.status === 404) return { exists: false, issuetype_id };
    const data = checkStatus(res, "issuetype_get");
    return {
      exists: true,
      issuetype: { id: data.id, name: data.name, description: data.description || null, subtask: data.subtask || false },
    };
  }

  // ── WORKLOGS ──────────────────────────────────────────────────────────────

  if (operation === "issue_worklog_list") {
    const { issue_key, max_results, start_at } = args;
    requireString(issue_key, "issue_key");
    const query = qs({
      maxResults: clampInt(max_results, 1, 100, 20),
      startAt:    clampInt(start_at, 0, 999999, 0),
    });
    const res = await doRequest(conn, "GET", `${JIRA_API_V3}/issue/${enc(issue_key)}/worklog${query}`);
    if (res.status === 404) return { exists: false, issue_key };
    const data = checkStatus(res, "issue_worklog_list");
    return {
      issue_key,
      total:      data.total      || 0,
      startAt:    data.startAt    || 0,
      maxResults: data.maxResults || 0,
      worklogs:   (data.worklogs  || []).map(w => ({
        id:               w.id,
        author:           w.author ? w.author.displayName : null,
        comment:          w.comment  || null,
        started:          w.started  || null,
        timeSpent:        w.timeSpent || null,
        timeSpentSeconds: w.timeSpentSeconds || 0,
        created:          w.created || null,
        updated:          w.updated || null,
      })),
    };
  }

  if (operation === "issue_worklog_add") {
    const { issue_key, time_spent, started, comment } = args;
    requireString(issue_key, "issue_key");
    requireString(time_spent, "time_spent");
    const body = {
      timeSpent: time_spent,
      ...(started ? { started } : {}),
      ...(comment ? { comment } : {}),
    };
    const res = await doRequest(conn, "POST", `${JIRA_API_V3}/issue/${enc(issue_key)}/worklog`, body);
    if (res.status === 404) return { added: false, issue_key, reason: "not_found" };
    const data = checkStatus(res, "issue_worklog_add");
    return { added: true, worklog_id: data.id, timeSpent: data.timeSpent, started: data.started };
  }

  if (operation === "issue_worklog_delete") {
    const { issue_key, worklog_id } = args;
    requireString(issue_key, "issue_key");
    requireString(worklog_id, "worklog_id");
    const res = await doRequest(conn, "DELETE", `${JIRA_API_V3}/issue/${enc(issue_key)}/worklog/${enc(worklog_id)}`);
    if (res.status === 404) return { deleted: false, issue_key, worklog_id, reason: "not_found" };
    checkStatus(res, "issue_worklog_delete", { allow204: true });
    return { deleted: true, issue_key, worklog_id };
  }

  // ── ISSUE LINKS ───────────────────────────────────────────────────────────

  if (operation === "issue_link") {
    const { inward_key, outward_key, link_type } = args;
    requireString(inward_key,  "inward_key");
    requireString(outward_key, "outward_key");
    requireString(link_type,   "link_type");
    const body = {
      type:         { name: link_type },
      inwardIssue:  { key: inward_key },
      outwardIssue: { key: outward_key },
    };
    const res = await doRequest(conn, "POST", `${JIRA_API_V3}/issueLink`, body);
    checkStatus(res, "issue_link", { allow204: true });
    return { linked: true, inward_key, outward_key, link_type };
  }

  if (operation === "issue_link_get") {
    const { link_id } = args;
    requireString(link_id, "link_id");
    const res = await doRequest(conn, "GET", `${JIRA_API_V3}/issueLink/${enc(link_id)}`);
    if (res.status === 404) return { exists: false, link_id };
    const data = checkStatus(res, "issue_link_get");
    return {
      exists: true,
      link: {
        id:           data.id,
        type:         data.type ? { id: data.type.id, name: data.type.name, inward: data.type.inward, outward: data.type.outward } : null,
        inwardIssue:  data.inwardIssue  ? { id: data.inwardIssue.id,  key: data.inwardIssue.key }  : null,
        outwardIssue: data.outwardIssue ? { id: data.outwardIssue.id, key: data.outwardIssue.key } : null,
      },
    };
  }

  if (operation === "issue_link_delete") {
    const { link_id } = args;
    requireString(link_id, "link_id");
    const res = await doRequest(conn, "DELETE", `${JIRA_API_V3}/issueLink/${enc(link_id)}`);
    if (res.status === 404) return { deleted: false, link_id, reason: "not_found" };
    checkStatus(res, "issue_link_delete", { allow204: true });
    return { deleted: true, link_id };
  }

  // ── FILTERS ───────────────────────────────────────────────────────────────

  if (operation === "filter_list") {
    const { max_results, start_at } = args;
    const query = qs({
      maxResults: clampInt(max_results, 1, 50, 20),
      startAt:    clampInt(start_at, 0, 999999, 0),
    });
    const res = await doRequest(conn, "GET", `${JIRA_API_V3}/filter/my${query}`);
    const data = checkStatus(res, "filter_list");
    return {
      total:   data.total || (Array.isArray(data) ? data.length : 0),
      filters: (Array.isArray(data) ? data : data.values || []).map(f => ({
        id: f.id, name: f.name, description: f.description || null,
        jql: f.jql, self: f.self, sharePermissions: f.sharePermissions || [],
      })),
    };
  }

  if (operation === "filter_get") {
    const { filter_id } = args;
    requireString(filter_id, "filter_id");
    const res = await doRequest(conn, "GET", `${JIRA_API_V3}/filter/${enc(filter_id)}`);
    if (res.status === 404) return { exists: false, filter_id };
    const data = checkStatus(res, "filter_get");
    return {
      exists: true,
      filter: { id: data.id, name: data.name, description: data.description || null, jql: data.jql, self: data.self },
    };
  }

  if (operation === "filter_create") {
    const { name, jql, description, favourite } = args;
    requireString(name, "name");
    requireString(jql,  "jql");
    const body = {
      name,
      jql,
      ...(description ? { description } : {}),
      ...(favourite !== undefined ? { favourite } : {}),
    };
    const res = await doRequest(conn, "POST", `${JIRA_API_V3}/filter`, body);
    const data = checkStatus(res, "filter_create");
    return { created: true, id: data.id, name: data.name, jql: data.jql, self: data.self };
  }

  // ── GENERIC REQUEST ───────────────────────────────────────────────────────

  if (operation === "request") {
    const { api_path, method: m = "GET", body: reqBody, use_agile } = args;
    requireString(api_path, "api_path");
    if (!api_path.startsWith("/"))
      throw new Error("api_path must start with '/'");
    const prefix = use_agile ? JIRA_AGILE_V1 : JIRA_API_V3;
    const res = await doRequest(conn, m, `${prefix}${api_path}`, reqBody);
    const data = res.status === 204 ? null : parseJson(res.raw, "request");
    return { status: res.status, data };
  }

  // ── INFO ──────────────────────────────────────────────────────────────────

  if (operation === "info") {
    const res = await doRequest(conn, "GET", `${JIRA_API_V3}/serverInfo`);
    const data = checkStatus(res, "info");
    return {
      baseUrl:       conn.baseUrl,
      authenticated: !!conn.authHeader,
      serverInfo: {
        baseUrl:        data.baseUrl,
        version:        data.version,
        versionNumbers: data.versionNumbers,
        buildNumber:    data.buildNumber,
        deploymentType: data.deploymentType,
        serverTitle:    data.serverTitle,
        scmInfo:        data.scmInfo,
      },
    };
  }

  throw new Error(`Unknown operation: ${operation}`);
}

module.exports = {
  jiraClient,
  buildConn,
  requireString,
  guardString,
  clampInt,
  parseJson,
  checkStatus,
  mapIssue,
  mapProject,
  mapUser,
  mapComment,
  mapBoard,
  mapSprint,
  mapTransition,
  enc,
  qs,
  JIRA_API_V3,
  JIRA_AGILE_V1,
};
