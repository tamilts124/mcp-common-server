"use strict";
/**
 * zendeskClientOps.js
 * Zero-dependency Zendesk REST API client (pure Node.js https built-ins; no npm deps).
 * Auth: email + api_token (HTTP Basic: email/token:api_token) or oauth Bearer access_token.
 * Base URL: https://{subdomain}.zendesk.com/api/v2
 * All credentials are scrubbed from error messages.
 */

const https = require("https");

// ── Constants ────────────────────────────────────────────────────────────────
const DEFAULT_TIMEOUT   = 20_000;
const MIN_TIMEOUT       = 1_000;
const MAX_TIMEOUT       = 120_000;
const MAX_RESPONSE_BODY = 16 * 1024 * 1024; // 16 MB
const NUL_RE            = /\x00/;

// ── Helpers ──────────────────────────────────────────────────────────────────
function scrubCreds(str, email, apiToken, accessToken) {
  let s = String(str);
  if (email)       s = s.split(email).join("[email]");
  if (apiToken)    s = s.split(apiToken).join("[api_token]");
  if (accessToken) s = s.split(accessToken).join("[access_token]");
  return s;
}

function validateNul(val, name) {
  if (typeof val === "string" && NUL_RE.test(val))
    throw new Error(`${name} must not contain NUL bytes`);
}

function clampTimeout(t) {
  if (t == null) return DEFAULT_TIMEOUT;
  const n = Number(t);
  if (!isFinite(n)) return DEFAULT_TIMEOUT;
  return Math.max(MIN_TIMEOUT, Math.min(MAX_TIMEOUT, Math.round(n)));
}

/**
 * Low-level HTTPS request.
 * Returns parsed JSON or throws with scrubbed message.
 */
function zendeskRequest({
  subdomain, email, apiToken, accessToken,
  method, path, body, timeout, rejectUnauthorized,
}) {
  return new Promise((resolve, reject) => {
    const host = `${subdomain}.zendesk.com`;
    const ms   = clampTimeout(timeout);

    // Build Authorization header
    let authHeader;
    if (accessToken) {
      authHeader = `Bearer ${accessToken}`;
    } else {
      // email/token:api_token format required by Zendesk
      const cred = Buffer.from(`${email}/token:${apiToken}`).toString("base64");
      authHeader = `Basic ${cred}`;
    }

    const headers = {
      Authorization: authHeader,
      Accept:        "application/json",
      "User-Agent":  "mcp-common-server/zendesk_client",
    };

    let bodyBuf = null;
    if (body !== undefined && body !== null) {
      bodyBuf = Buffer.from(JSON.stringify(body), "utf8");
      headers["Content-Type"]   = "application/json";
      headers["Content-Length"] = bodyBuf.length;
    }

    const options = {
      hostname: host,
      port:     443,
      path,
      method:   method || "GET",
      headers,
      rejectUnauthorized: rejectUnauthorized !== false,
    };

    let timer;
    const req = https.request(options, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BODY) {
          req.destroy();
          clearTimeout(timer);
          reject(new Error("Response body exceeds 16 MB limit"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        clearTimeout(timer);
        const raw = Buffer.concat(chunks).toString("utf8");
        const status = res.statusCode;

        // 204 No Content
        if (status === 204) { resolve({ status, body: null }); return; }

        let parsed;
        try { parsed = JSON.parse(raw); } catch (_) { parsed = { _raw: raw }; }
        resolve({ status, body: parsed });
      });
      res.on("error", (err) => {
        clearTimeout(timer);
        reject(new Error(scrubCreds(err.message, email, apiToken, accessToken)));
      });
    });

    timer = setTimeout(() => {
      reject(new Error(`Zendesk request timed out after ${ms} ms`));
      req.destroy();
    }, ms);

    req.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(scrubCreds(err.message, email, apiToken, accessToken)));
    });

    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

/**
 * Convenience wrapper: executes zendeskRequest and maps HTTP errors to thrown
 * exceptions. Non-2xx responses are thrown unless caller passes allowedStatuses.
 */
async function zReq(ctx, method, path, body, allowedStatuses) {
  const { subdomain, email, apiToken, accessToken, timeout, rejectUnauthorized } = ctx;
  const res = await zendeskRequest({
    subdomain, email, apiToken, accessToken,
    method, path, body, timeout, rejectUnauthorized,
  });
  const ok = allowedStatuses
    ? allowedStatuses.includes(res.status)
    : res.status >= 200 && res.status < 300;
  if (!ok) {
    const errBody = res.body ? JSON.stringify(res.body) : "(empty)";
    const scrubbed = scrubCreds(errBody, email, apiToken, accessToken);
    throw new Error(`Zendesk API error ${res.status}: ${scrubbed}`);
  }
  return res;
}

// ── Validation helpers ────────────────────────────────────────────────────────
function requireString(val, name) {
  if (typeof val !== "string" || !val.trim())
    throw new Error(`${name} is required and must be a non-empty string`);
  validateNul(val, name);
  return val.trim();
}

function requireNumber(val, name) {
  const n = Number(val);
  if (!isFinite(n)) throw new Error(`${name} is required and must be a number`);
  return n;
}

function optStr(val, name) {
  if (val == null) return undefined;
  if (typeof val !== "string") throw new Error(`${name} must be a string`);
  validateNul(val, name);
  return val;
}

function buildCtx(args) {
  const subdomain    = requireString(args.subdomain, "subdomain");
  const accessToken  = optStr(args.access_token, "access_token");
  let   email        = optStr(args.email, "email");
  let   apiToken     = optStr(args.api_token, "api_token");

  if (!accessToken) {
    if (!email)    throw new Error("email is required when not using access_token");
    if (!apiToken) throw new Error("api_token is required when not using access_token");
  }

  return {
    subdomain,
    email,
    apiToken,
    accessToken,
    timeout:           args.timeout,
    rejectUnauthorized: args.reject_unauthorized,
    base:              `/api/v2`,
  };
}

function apiPath(ctx, suffix) {
  return `${ctx.base}${suffix}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TICKETS
// ═══════════════════════════════════════════════════════════════════════════════

async function ticketGet(ctx, args) {
  const id = requireNumber(args.ticket_id, "ticket_id");
  const res = await zReq(ctx, "GET", apiPath(ctx, `/tickets/${id}.json`));
  return res.body.ticket;
}

async function ticketList(ctx, args) {
  const params = new URLSearchParams();
  if (args.limit)    params.set("per_page", Math.min(100, Math.max(1, Number(args.limit))));
  if (args.page)     params.set("page", Number(args.page));
  if (args.status)   params.set("status", args.status);
  if (args.assignee_id) params.set("assignee_id", args.assignee_id);
  const qs = params.toString();
  const res = await zReq(ctx, "GET", apiPath(ctx, `/tickets.json${qs ? "?" + qs : ""}`));
  return { tickets: res.body.tickets, count: res.body.count, next_page: res.body.next_page };
}

async function ticketCreate(ctx, args) {
  const subject = requireString(args.subject, "subject");
  const ticket = { subject };
  if (args.comment_body)   ticket.comment   = { body: args.comment_body };
  if (args.priority)       ticket.priority   = args.priority;
  if (args.status)         ticket.status     = args.status;
  if (args.type)           ticket.type       = args.type;
  if (args.requester_id)   ticket.requester_id = Number(args.requester_id);
  if (args.assignee_id)    ticket.assignee_id  = Number(args.assignee_id);
  if (args.group_id)       ticket.group_id     = Number(args.group_id);
  if (args.tags)           ticket.tags         = args.tags;
  if (args.custom_fields)  ticket.custom_fields = args.custom_fields;
  if (args.due_at)         ticket.due_at       = args.due_at;
  if (args.external_id)    ticket.external_id  = args.external_id;
  const res = await zReq(ctx, "POST", apiPath(ctx, "/tickets.json"), { ticket });
  return res.body.ticket;
}

async function ticketUpdate(ctx, args) {
  const id = requireNumber(args.ticket_id, "ticket_id");
  const ticket = {};
  if (args.subject)       ticket.subject      = args.subject;
  if (args.status)        ticket.status       = args.status;
  if (args.priority)      ticket.priority     = args.priority;
  if (args.type)          ticket.type         = args.type;
  if (args.assignee_id != null) ticket.assignee_id = Number(args.assignee_id);
  if (args.group_id != null)    ticket.group_id    = Number(args.group_id);
  if (args.tags)          ticket.tags         = args.tags;
  if (args.due_at)        ticket.due_at       = args.due_at;
  if (args.custom_fields) ticket.custom_fields = args.custom_fields;
  if (args.comment_body) {
    ticket.comment = { body: args.comment_body, public: args.comment_public !== false };
  }
  const res = await zReq(ctx, "PUT", apiPath(ctx, `/tickets/${id}.json`), { ticket });
  return res.body.ticket;
}

async function ticketDelete(ctx, args) {
  const id = requireNumber(args.ticket_id, "ticket_id");
  const res = await zReq(ctx, "DELETE", apiPath(ctx, `/tickets/${id}.json`), undefined, [200, 204, 404]);
  return { deleted: res.status !== 404, ticket_id: id };
}

async function ticketSearch(ctx, args) {
  const q = requireString(args.query, "query");
  const params = new URLSearchParams({ query: `type:ticket ${q}` });
  if (args.limit)  params.set("per_page", Math.min(100, Math.max(1, Number(args.limit))));
  if (args.page)   params.set("page", Number(args.page));
  const res = await zReq(ctx, "GET", apiPath(ctx, `/search.json?${params.toString()}`));
  return { results: res.body.results, count: res.body.count, next_page: res.body.next_page };
}

async function ticketAssign(ctx, args) {
  const id         = requireNumber(args.ticket_id, "ticket_id");
  const ticket = {};
  if (args.assignee_id != null) ticket.assignee_id = Number(args.assignee_id);
  if (args.group_id != null)    ticket.group_id    = Number(args.group_id);
  if (!Object.keys(ticket).length) throw new Error("assignee_id or group_id required for ticket_assign");
  const res = await zReq(ctx, "PUT", apiPath(ctx, `/tickets/${id}.json`), { ticket });
  return res.body.ticket;
}

async function ticketSetStatus(ctx, args) {
  const id     = requireNumber(args.ticket_id, "ticket_id");
  const status = requireString(args.status, "status");
  const allowed = ["new", "open", "pending", "hold", "solved", "closed"];
  if (!allowed.includes(status))
    throw new Error(`status must be one of: ${allowed.join(", ")}`);
  const res = await zReq(ctx, "PUT", apiPath(ctx, `/tickets/${id}.json`), { ticket: { status } });
  return res.body.ticket;
}

async function ticketBulkUpdate(ctx, args) {
  if (!Array.isArray(args.ticket_ids) || !args.ticket_ids.length)
    throw new Error("ticket_ids must be a non-empty array");
  const ids    = args.ticket_ids.map(id => Number(id));
  const update = {};
  if (args.status)        update.status       = args.status;
  if (args.priority)      update.priority     = args.priority;
  if (args.assignee_id != null) update.assignee_id = Number(args.assignee_id);
  if (args.group_id != null)    update.group_id    = Number(args.group_id);
  if (args.tags)          update.tags         = args.tags;
  if (args.comment_body) {
    update.comment = { body: args.comment_body, public: args.comment_public !== false };
  }
  const qs = `ids=${ids.join(",")}`;
  const res = await zReq(ctx, "PUT", apiPath(ctx, `/tickets/update_many.json?${qs}`), { ticket: update });
  return res.body.job_status || res.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMMENTS
// ═══════════════════════════════════════════════════════════════════════════════

async function commentList(ctx, args) {
  const id = requireNumber(args.ticket_id, "ticket_id");
  const params = new URLSearchParams();
  if (args.limit) params.set("per_page", Math.min(100, Math.max(1, Number(args.limit))));
  if (args.page)  params.set("page", Number(args.page));
  const qs = params.toString();
  const res = await zReq(ctx, "GET", apiPath(ctx, `/tickets/${id}/comments.json${qs ? "?" + qs : ""}`));
  return { comments: res.body.comments, count: res.body.count };
}

async function commentCreate(ctx, args) {
  const id   = requireNumber(args.ticket_id, "ticket_id");
  const body = requireString(args.body, "body");
  const comment = {
    body,
    public: args.public_comment !== false,
  };
  if (args.author_id) comment.author_id = Number(args.author_id);
  const res = await zReq(ctx, "PUT", apiPath(ctx, `/tickets/${id}.json`), { ticket: { comment } });
  return res.body.ticket;
}

// ═══════════════════════════════════════════════════════════════════════════════
// USERS
// ═══════════════════════════════════════════════════════════════════════════════

async function userGet(ctx, args) {
  const id = requireNumber(args.user_id, "user_id");
  const res = await zReq(ctx, "GET", apiPath(ctx, `/users/${id}.json`), undefined, [200, 404]);
  if (res.status === 404) return { exists: false, user_id: id };
  return res.body.user;
}

async function userMe(ctx) {
  const res = await zReq(ctx, "GET", apiPath(ctx, "/users/me.json"));
  return res.body.user;
}

async function userList(ctx, args) {
  const params = new URLSearchParams();
  if (args.limit) params.set("per_page", Math.min(100, Math.max(1, Number(args.limit))));
  if (args.page)  params.set("page", Number(args.page));
  if (args.role)  params.set("role", args.role);
  const qs = params.toString();
  const res = await zReq(ctx, "GET", apiPath(ctx, `/users.json${qs ? "?" + qs : ""}`));
  return { users: res.body.users, count: res.body.count, next_page: res.body.next_page };
}

async function userSearch(ctx, args) {
  const q = requireString(args.query, "query");
  const params = new URLSearchParams({ query: q });
  if (args.limit) params.set("per_page", Math.min(100, Math.max(1, Number(args.limit))));
  const res = await zReq(ctx, "GET", apiPath(ctx, `/users/search.json?${params.toString()}`));
  return { users: res.body.users, count: res.body.count };
}

async function userCreate(ctx, args) {
  const name  = requireString(args.name, "name");
  const email = requireString(args.email_address || args.email, "email/email_address");
  const user  = { name, email };
  if (args.role)         user.role         = args.role;
  if (args.phone)        user.phone        = args.phone;
  if (args.organization_id) user.organization_id = Number(args.organization_id);
  if (args.external_id)  user.external_id  = args.external_id;
  if (args.verified != null) user.verified = args.verified;
  const res = await zReq(ctx, "POST", apiPath(ctx, "/users.json"), { user }, [200, 201]);
  return res.body.user;
}

async function userUpdate(ctx, args) {
  const id   = requireNumber(args.user_id, "user_id");
  const user = {};
  if (args.name)          user.name          = args.name;
  if (args.email_address) user.email         = args.email_address;
  if (args.role)          user.role          = args.role;
  if (args.phone)         user.phone         = args.phone;
  if (args.organization_id != null) user.organization_id = Number(args.organization_id);
  if (args.external_id)   user.external_id   = args.external_id;
  if (args.verified != null) user.verified   = args.verified;
  if (args.suspended != null) user.suspended = args.suspended;
  const res = await zReq(ctx, "PUT", apiPath(ctx, `/users/${id}.json`), { user });
  return res.body.user;
}

async function userDelete(ctx, args) {
  const id = requireNumber(args.user_id, "user_id");
  const res = await zReq(ctx, "DELETE", apiPath(ctx, `/users/${id}.json`), undefined, [200, 204, 404]);
  return { deleted: res.status !== 404, user_id: id };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ORGANIZATIONS
// ═══════════════════════════════════════════════════════════════════════════════

async function orgGet(ctx, args) {
  const id = requireNumber(args.organization_id, "organization_id");
  const res = await zReq(ctx, "GET", apiPath(ctx, `/organizations/${id}.json`), undefined, [200, 404]);
  if (res.status === 404) return { exists: false, organization_id: id };
  return res.body.organization;
}

async function orgList(ctx, args) {
  const params = new URLSearchParams();
  if (args.limit) params.set("per_page", Math.min(100, Math.max(1, Number(args.limit))));
  if (args.page)  params.set("page", Number(args.page));
  const qs = params.toString();
  const res = await zReq(ctx, "GET", apiPath(ctx, `/organizations.json${qs ? "?" + qs : ""}`));
  return { organizations: res.body.organizations, count: res.body.count, next_page: res.body.next_page };
}

async function orgCreate(ctx, args) {
  const name = requireString(args.name, "name");
  const organization = { name };
  if (args.external_id)  organization.external_id  = args.external_id;
  if (args.domain_names) organization.domain_names = args.domain_names;
  if (args.tags)         organization.tags         = args.tags;
  if (args.notes)        organization.notes        = args.notes;
  const res = await zReq(ctx, "POST", apiPath(ctx, "/organizations.json"), { organization }, [200, 201]);
  return res.body.organization;
}

async function orgUpdate(ctx, args) {
  const id           = requireNumber(args.organization_id, "organization_id");
  const organization = {};
  if (args.name)          organization.name         = args.name;
  if (args.external_id)   organization.external_id  = args.external_id;
  if (args.domain_names)  organization.domain_names = args.domain_names;
  if (args.tags)          organization.tags         = args.tags;
  if (args.notes)         organization.notes        = args.notes;
  const res = await zReq(ctx, "PUT", apiPath(ctx, `/organizations/${id}.json`), { organization });
  return res.body.organization;
}

async function orgDelete(ctx, args) {
  const id = requireNumber(args.organization_id, "organization_id");
  const res = await zReq(ctx, "DELETE", apiPath(ctx, `/organizations/${id}.json`), undefined, [200, 204, 404]);
  return { deleted: res.status !== 404, organization_id: id };
}

// ═══════════════════════════════════════════════════════════════════════════════
// GROUPS
// ═══════════════════════════════════════════════════════════════════════════════

async function groupGet(ctx, args) {
  const id = requireNumber(args.group_id, "group_id");
  const res = await zReq(ctx, "GET", apiPath(ctx, `/groups/${id}.json`), undefined, [200, 404]);
  if (res.status === 404) return { exists: false, group_id: id };
  return res.body.group;
}

async function groupList(ctx, args) {
  const params = new URLSearchParams();
  if (args.limit) params.set("per_page", Math.min(100, Math.max(1, Number(args.limit))));
  if (args.page)  params.set("page", Number(args.page));
  const qs = params.toString();
  const res = await zReq(ctx, "GET", apiPath(ctx, `/groups.json${qs ? "?" + qs : ""}`));
  return { groups: res.body.groups, count: res.body.count, next_page: res.body.next_page };
}

async function groupCreate(ctx, args) {
  const name  = requireString(args.name, "name");
  const group = { name };
  if (args.description) group.description = args.description;
  const res = await zReq(ctx, "POST", apiPath(ctx, "/groups.json"), { group }, [200, 201]);
  return res.body.group;
}

async function groupUpdate(ctx, args) {
  const id    = requireNumber(args.group_id, "group_id");
  const group = {};
  if (args.name)        group.name        = args.name;
  if (args.description) group.description = args.description;
  const res = await zReq(ctx, "PUT", apiPath(ctx, `/groups/${id}.json`), { group });
  return res.body.group;
}

async function groupDelete(ctx, args) {
  const id = requireNumber(args.group_id, "group_id");
  const res = await zReq(ctx, "DELETE", apiPath(ctx, `/groups/${id}.json`), undefined, [200, 204, 404]);
  return { deleted: res.status !== 404, group_id: id };
}

async function groupMembers(ctx, args) {
  const id = requireNumber(args.group_id, "group_id");
  const params = new URLSearchParams();
  if (args.limit) params.set("per_page", Math.min(100, Math.max(1, Number(args.limit))));
  if (args.page)  params.set("page", Number(args.page));
  const qs = params.toString();
  const res = await zReq(ctx, "GET", apiPath(ctx, `/groups/${id}/memberships.json${qs ? "?" + qs : ""}`));
  return { memberships: res.body.group_memberships, count: res.body.count };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAGS
// ═══════════════════════════════════════════════════════════════════════════════

async function tagList(ctx, args) {
  const params = new URLSearchParams();
  if (args.limit) params.set("per_page", Math.min(100, Math.max(1, Number(args.limit))));
  if (args.page)  params.set("page", Number(args.page));
  const qs = params.toString();
  const res = await zReq(ctx, "GET", apiPath(ctx, `/tags.json${qs ? "?" + qs : ""}`));
  return { tags: res.body.tags, count: res.body.count };
}

async function tagAdd(ctx, args) {
  const id   = requireNumber(args.ticket_id, "ticket_id");
  if (!Array.isArray(args.tags) || !args.tags.length)
    throw new Error("tags must be a non-empty array");
  const res = await zReq(ctx, "POST", apiPath(ctx, `/tickets/${id}/tags.json`), { tags: args.tags });
  return { tags: res.body.tags };
}

async function tagRemove(ctx, args) {
  const id = requireNumber(args.ticket_id, "ticket_id");
  if (!Array.isArray(args.tags) || !args.tags.length)
    throw new Error("tags must be a non-empty array");
  // Zendesk DELETE /tickets/:id/tags expects JSON body with tags array
  const res = await zReq(ctx, "DELETE", apiPath(ctx, `/tickets/${id}/tags.json`), { tags: args.tags }, [200, 204]);
  return { removed: true, ticket_id: id };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ATTACHMENTS
// ═══════════════════════════════════════════════════════════════════════════════

async function attachmentUpload(ctx, args) {
  const filename    = requireString(args.filename, "filename");
  const contentB64  = requireString(args.content_base64, "content_base64");
  const mimeType    = args.mime_type || "application/octet-stream";

  let fileBuffer;
  try { fileBuffer = Buffer.from(contentB64, "base64"); }
  catch (_) { throw new Error("content_base64 is not valid base64"); }

  const { subdomain, email, apiToken, accessToken, timeout, rejectUnauthorized } = ctx;
  const ms   = clampTimeout(timeout);
  const host = `${subdomain}.zendesk.com`;

  let authHeader;
  if (accessToken) {
    authHeader = `Bearer ${accessToken}`;
  } else {
    const cred = Buffer.from(`${email}/token:${apiToken}`).toString("base64");
    authHeader = `Basic ${cred}`;
  }

  const encodedFilename = encodeURIComponent(filename);
  const path = `/api/v2/uploads.json?filename=${encodedFilename}`;

  return new Promise((resolve, reject) => {
    const options = {
      hostname: host,
      port:     443,
      path,
      method:   "POST",
      headers: {
        Authorization:   authHeader,
        "Content-Type":  mimeType,
        "Content-Length": fileBuffer.length,
        "Accept":        "application/json",
        "User-Agent":    "mcp-common-server/zendesk_client",
      },
      rejectUnauthorized: rejectUnauthorized !== false,
    };

    let timer;
    const req = https.request(options, (res) => {
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BODY) {
          req.destroy(); clearTimeout(timer);
          reject(new Error("Response body exceeds 16 MB"));
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        clearTimeout(timer);
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsed;
        try { parsed = JSON.parse(raw); } catch (_) { parsed = { _raw: raw }; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const scrubbed = scrubCreds(raw, email, apiToken, accessToken);
          reject(new Error(`Zendesk upload error ${res.statusCode}: ${scrubbed}`));
          return;
        }
        resolve(parsed.upload);
      });
      res.on("error", (err) => { clearTimeout(timer); reject(err); });
    });
    timer = setTimeout(() => { reject(new Error(`Upload timed out after ${ms} ms`)); req.destroy(); }, ms);
    req.on("error", (err) => { clearTimeout(timer); reject(err); });
    req.write(fileBuffer);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// VIEWS
// ═══════════════════════════════════════════════════════════════════════════════

async function viewList(ctx, args) {
  const params = new URLSearchParams();
  if (args.limit) params.set("per_page", Math.min(100, Math.max(1, Number(args.limit))));
  if (args.page)  params.set("page", Number(args.page));
  const qs = params.toString();
  const res = await zReq(ctx, "GET", apiPath(ctx, `/views.json${qs ? "?" + qs : ""}`));
  return { views: res.body.views, count: res.body.count };
}

async function viewGet(ctx, args) {
  const id = requireNumber(args.view_id, "view_id");
  const res = await zReq(ctx, "GET", apiPath(ctx, `/views/${id}.json`), undefined, [200, 404]);
  if (res.status === 404) return { exists: false, view_id: id };
  return res.body.view;
}

async function viewTickets(ctx, args) {
  const id = requireNumber(args.view_id, "view_id");
  const params = new URLSearchParams();
  if (args.limit) params.set("per_page", Math.min(100, Math.max(1, Number(args.limit))));
  if (args.page)  params.set("page", Number(args.page));
  const qs = params.toString();
  const res = await zReq(ctx, "GET", apiPath(ctx, `/views/${id}/tickets.json${qs ? "?" + qs : ""}`));
  return { tickets: res.body.tickets, count: res.body.count, next_page: res.body.next_page };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MACROS
// ═══════════════════════════════════════════════════════════════════════════════

async function macroList(ctx, args) {
  const params = new URLSearchParams();
  if (args.limit) params.set("per_page", Math.min(100, Math.max(1, Number(args.limit))));
  if (args.page)  params.set("page", Number(args.page));
  const qs = params.toString();
  const res = await zReq(ctx, "GET", apiPath(ctx, `/macros.json${qs ? "?" + qs : ""}`));
  return { macros: res.body.macros, count: res.body.count };
}

async function macroApply(ctx, args) {
  const ticketId = requireNumber(args.ticket_id, "ticket_id");
  const macroId  = requireNumber(args.macro_id, "macro_id");
  const res = await zReq(ctx, "GET", apiPath(ctx, `/tickets/${ticketId}/macros/${macroId}/apply.json`));
  return res.body.result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SATISFACTION RATINGS
// ═══════════════════════════════════════════════════════════════════════════════

async function satisfactionList(ctx, args) {
  const params = new URLSearchParams();
  if (args.limit)  params.set("per_page", Math.min(100, Math.max(1, Number(args.limit))));
  if (args.page)   params.set("page", Number(args.page));
  if (args.score)  params.set("score", args.score);
  const qs = params.toString();
  const res = await zReq(ctx, "GET", apiPath(ctx, `/satisfaction_ratings.json${qs ? "?" + qs : ""}`));
  return { satisfaction_ratings: res.body.satisfaction_ratings, count: res.body.count };
}

async function satisfactionGet(ctx, args) {
  const id = requireNumber(args.satisfaction_rating_id, "satisfaction_rating_id");
  const res = await zReq(ctx, "GET", apiPath(ctx, `/satisfaction_ratings/${id}.json`), undefined, [200, 404]);
  if (res.status === 404) return { exists: false, satisfaction_rating_id: id };
  return res.body.satisfaction_rating;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GENERIC / INFO
// ═══════════════════════════════════════════════════════════════════════════════

async function genericRequest(ctx, args) {
  const method   = (args.method || "GET").toUpperCase();
  const apiPath_ = requireString(args.path, "path");
  const body     = args.body;
  const path     = `/api/v2${apiPath_.startsWith("/") ? apiPath_ : "/" + apiPath_}`;
  const res = await zendeskRequest({
    subdomain: ctx.subdomain, email: ctx.email,
    apiToken: ctx.apiToken, accessToken: ctx.accessToken,
    method, path, body,
    timeout: ctx.timeout, rejectUnauthorized: ctx.rejectUnauthorized,
  });
  return { status: res.status, body: res.body };
}

async function info(ctx) {
  const user = await userMe(ctx);
  return {
    subdomain:    ctx.subdomain,
    base_url:     `https://${ctx.subdomain}.zendesk.com/api/v2`,
    authenticated_as: { id: user.id, name: user.name, email: user.email, role: user.role },
    api_version:  "v2",
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN DISPATCHER
// ═══════════════════════════════════════════════════════════════════════════════

async function zendeskClient(args) {
  const { operation } = args;
  if (!operation) throw new Error("operation is required");

  // Validate common NUL-sensitive fields
  for (const f of ["subdomain","email","api_token","access_token"]) {
    if (args[f]) validateNul(args[f], f);
  }

  const ctx = buildCtx(args);

  try {
    switch (operation) {
      // Tickets
      case "ticket_get":       return await ticketGet(ctx, args);
      case "ticket_list":      return await ticketList(ctx, args);
      case "ticket_create":    return await ticketCreate(ctx, args);
      case "ticket_update":    return await ticketUpdate(ctx, args);
      case "ticket_delete":    return await ticketDelete(ctx, args);
      case "ticket_search":    return await ticketSearch(ctx, args);
      case "ticket_assign":    return await ticketAssign(ctx, args);
      case "ticket_set_status": return await ticketSetStatus(ctx, args);
      case "ticket_bulk_update": return await ticketBulkUpdate(ctx, args);
      // Comments
      case "comment_list":     return await commentList(ctx, args);
      case "comment_create":   return await commentCreate(ctx, args);
      // Users
      case "user_get":         return await userGet(ctx, args);
      case "user_me":          return await userMe(ctx);
      case "user_list":        return await userList(ctx, args);
      case "user_search":      return await userSearch(ctx, args);
      case "user_create":      return await userCreate(ctx, args);
      case "user_update":      return await userUpdate(ctx, args);
      case "user_delete":      return await userDelete(ctx, args);
      // Organizations
      case "org_get":          return await orgGet(ctx, args);
      case "org_list":         return await orgList(ctx, args);
      case "org_create":       return await orgCreate(ctx, args);
      case "org_update":       return await orgUpdate(ctx, args);
      case "org_delete":       return await orgDelete(ctx, args);
      // Groups
      case "group_get":        return await groupGet(ctx, args);
      case "group_list":       return await groupList(ctx, args);
      case "group_create":     return await groupCreate(ctx, args);
      case "group_update":     return await groupUpdate(ctx, args);
      case "group_delete":     return await groupDelete(ctx, args);
      case "group_members":    return await groupMembers(ctx, args);
      // Tags
      case "tag_list":         return await tagList(ctx, args);
      case "tag_add":          return await tagAdd(ctx, args);
      case "tag_remove":       return await tagRemove(ctx, args);
      // Attachments
      case "attachment_upload": return await attachmentUpload(ctx, args);
      // Views
      case "view_list":        return await viewList(ctx, args);
      case "view_get":         return await viewGet(ctx, args);
      case "view_tickets":     return await viewTickets(ctx, args);
      // Macros
      case "macro_list":       return await macroList(ctx, args);
      case "macro_apply":      return await macroApply(ctx, args);
      // Satisfaction
      case "satisfaction_list": return await satisfactionList(ctx, args);
      case "satisfaction_get":  return await satisfactionGet(ctx, args);
      // Generic
      case "request":          return await genericRequest(ctx, args);
      case "info":             return await info(ctx);
      default:
        throw new Error(`Unknown zendesk_client operation: ${operation}`);
    }
  } catch (err) {
    // Scrub credentials from all error messages
    const msg = scrubCreds(
      err.message || String(err),
      args.email, args.api_token, args.access_token
    );
    const out = new Error(msg);
    out.stack = scrubCreds(err.stack || "", args.email, args.api_token, args.access_token);
    throw out;
  }
}

module.exports = { zendeskClient };
