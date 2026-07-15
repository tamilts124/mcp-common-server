"use strict";
/**
 * pagerdutyClientOps.js
 * Zero-dependency PagerDuty REST API v2 client (pure Node.js https built-ins; no npm deps).
 * Auth: API key (Token auth header) or OAuth2 Bearer access_token.
 * Base URL: https://api.pagerduty.com
 * All credentials are scrubbed from error messages.
 */

const https = require("https");

// ── Constants ────────────────────────────────────────────────────────────────
const DEFAULT_TIMEOUT   = 20_000;
const MIN_TIMEOUT       = 1_000;
const MAX_TIMEOUT       = 120_000;
const MAX_RESPONSE_BODY = 16 * 1024 * 1024; // 16 MB
const API_BASE          = "api.pagerduty.com";
const NUL_RE            = /\x00/;

// ── Helpers ──────────────────────────────────────────────────────────────────
function scrubCreds(str, apiKey, accessToken) {
  let s = String(str);
  if (apiKey)      s = s.split(apiKey).join("[api_key]");
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
 * Low-level HTTPS request to PagerDuty API.
 */
function pdRequest({
  apiKey, accessToken,
  method, path, body, timeout, rejectUnauthorized, from,
}) {
  return new Promise((resolve, reject) => {
    const ms = clampTimeout(timeout);
    let authHeader;
    if (accessToken) {
      authHeader = `Bearer ${accessToken}`;
    } else {
      authHeader = `Token token=${apiKey}`;
    }

    const headers = {
      Authorization: authHeader,
      Accept:        "application/vnd.pagerduty+json;version=2",
      "Content-Type": "application/json",
      "User-Agent":  "mcp-common-server/pagerduty_client",
    };
    // PagerDuty requires From header for incident create/update
    if (from) headers["From"] = from;

    let bodyBuf = null;
    if (body !== undefined && body !== null) {
      bodyBuf = Buffer.from(JSON.stringify(body), "utf8");
      headers["Content-Length"] = bodyBuf.length;
    }

    const options = {
      hostname: API_BASE,
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
        if (status === 204 || !raw.trim()) { resolve({ status, body: null }); return; }
        let parsed;
        try { parsed = JSON.parse(raw); } catch (_) { parsed = { _raw: raw }; }
        resolve({ status, body: parsed });
      });
      res.on("error", (err) => {
        clearTimeout(timer);
        reject(new Error(scrubCreds(err.message, apiKey, accessToken)));
      });
    });

    timer = setTimeout(() => {
      reject(new Error(`PagerDuty request timed out after ${ms} ms`));
      req.destroy();
    }, ms);

    req.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(scrubCreds(err.message, apiKey, accessToken)));
    });

    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

async function pdReq(ctx, method, path, body, allowedStatuses) {
  const res = await pdRequest({
    apiKey:            ctx.apiKey,
    accessToken:       ctx.accessToken,
    method, path, body,
    timeout:           ctx.timeout,
    rejectUnauthorized: ctx.rejectUnauthorized,
    from:              ctx.from,
  });
  const ok = allowedStatuses
    ? allowedStatuses.includes(res.status)
    : res.status >= 200 && res.status < 300;
  if (!ok) {
    const errBody = res.body ? JSON.stringify(res.body) : "(empty)";
    const scrubbed = scrubCreds(errBody, ctx.apiKey, ctx.accessToken);
    throw new Error(`PagerDuty API error ${res.status}: ${scrubbed}`);
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

function optStr(val, name) {
  if (val == null) return undefined;
  if (typeof val !== "string") throw new Error(`${name} must be a string`);
  validateNul(val, name);
  return val;
}

function buildCtx(args) {
  const apiKey      = optStr(args.api_key, "api_key");
  const accessToken = optStr(args.access_token, "access_token");
  if (!apiKey && !accessToken)
    throw new Error("api_key or access_token is required");

  return {
    apiKey,
    accessToken,
    timeout:            args.timeout,
    rejectUnauthorized: args.reject_unauthorized,
    from:               optStr(args.from_email, "from_email"),
  };
}

function buildQs(params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    if (Array.isArray(v)) v.forEach(item => p.append(k, item));
    else p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

// ═══════════════════════════════════════════════════════════════════════════════
// INCIDENTS
// ═══════════════════════════════════════════════════════════════════════════════

async function incidentGet(ctx, args) {
  const id = requireString(args.incident_id, "incident_id");
  const res = await pdReq(ctx, "GET", `/incidents/${encodeURIComponent(id)}`);
  return res.body.incident;
}

async function incidentList(ctx, args) {
  const qs = buildQs({
    limit:         args.limit  ? Math.min(100, Math.max(1, Number(args.limit)))  : undefined,
    offset:        args.offset ? Number(args.offset) : undefined,
    statuses:      args.statuses,      // array: triggered,acknowledged,resolved
    sort_by:       args.sort_by,
    service_ids:   args.service_ids,
    team_ids:      args.team_ids,
    urgency:       args.urgency,
    "date_range":  args.date_range,
    since:         args.since,
    until:         args.until,
    include:       args.include,
  });
  const res = await pdReq(ctx, "GET", `/incidents${qs}`);
  return { incidents: res.body.incidents, total: res.body.total, limit: res.body.limit, offset: res.body.offset, more: res.body.more };
}

async function incidentCreate(ctx, args) {
  const title   = requireString(args.title, "title");
  const service = requireString(args.service_id, "service_id");
  const incident = {
    type:    "incident",
    title,
    service: { id: service, type: "service_reference" },
  };
  if (args.urgency)       incident.urgency       = args.urgency;
  if (args.body_details)  incident.body          = { type: "incident_body", details: args.body_details };
  if (args.escalation_policy_id) incident.escalation_policy = { id: args.escalation_policy_id, type: "escalation_policy_reference" };
  if (args.assignments) {
    incident.assignments = args.assignments.map(id => ({ assignee: { id, type: "user_reference" } }));
  }
  if (args.incident_key)  incident.incident_key  = args.incident_key;
  const res = await pdReq(ctx, "POST", "/incidents", { incident }, [201]);
  return res.body.incident;
}

async function incidentUpdate(ctx, args) {
  const id = requireString(args.incident_id, "incident_id");
  const incident = { type: "incident" };
  if (args.title)    incident.title    = args.title;
  if (args.status)   incident.status   = args.status;
  if (args.urgency)  incident.urgency  = args.urgency;
  if (args.resolution) incident.resolution = args.resolution;
  if (args.assignments) {
    incident.assignments = args.assignments.map(id => ({ assignee: { id, type: "user_reference" } }));
  }
  if (args.escalation_policy_id) incident.escalation_policy = { id: args.escalation_policy_id, type: "escalation_policy_reference" };
  const res = await pdReq(ctx, "PUT", `/incidents/${encodeURIComponent(id)}`, { incident });
  return res.body.incident;
}

async function incidentAcknowledge(ctx, args) {
  const id = requireString(args.incident_id, "incident_id");
  const res = await pdReq(ctx, "PUT", `/incidents/${encodeURIComponent(id)}`, { incident: { type: "incident", status: "acknowledged" } });
  return res.body.incident;
}

async function incidentResolve(ctx, args) {
  const id = requireString(args.incident_id, "incident_id");
  const incident = { type: "incident", status: "resolved" };
  if (args.resolution) incident.resolution = args.resolution;
  const res = await pdReq(ctx, "PUT", `/incidents/${encodeURIComponent(id)}`, { incident });
  return res.body.incident;
}

async function incidentMerge(ctx, args) {
  const id = requireString(args.incident_id, "incident_id");
  if (!Array.isArray(args.source_ids) || !args.source_ids.length)
    throw new Error("source_ids must be a non-empty array");
  const source_incidents = args.source_ids.map(sid => ({ id: sid, type: "incident_reference" }));
  const res = await pdReq(ctx, "PUT", `/incidents/${encodeURIComponent(id)}/merge`, { source_incidents });
  return res.body.incident;
}

// ═══════════════════════════════════════════════════════════════════════════════
// INCIDENT NOTES
// ═══════════════════════════════════════════════════════════════════════════════

async function noteList(ctx, args) {
  const id = requireString(args.incident_id, "incident_id");
  const res = await pdReq(ctx, "GET", `/incidents/${encodeURIComponent(id)}/notes`);
  return { notes: res.body.notes };
}

async function noteCreate(ctx, args) {
  const id      = requireString(args.incident_id, "incident_id");
  const content = requireString(args.content, "content");
  const res = await pdReq(ctx, "POST", `/incidents/${encodeURIComponent(id)}/notes`, { note: { content } }, [201]);
  return res.body.note;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SERVICES
// ═══════════════════════════════════════════════════════════════════════════════

async function serviceGet(ctx, args) {
  const id = requireString(args.service_id, "service_id");
  const qs = buildQs({ include: args.include });
  const res = await pdReq(ctx, "GET", `/services/${encodeURIComponent(id)}${qs}`, undefined, [200, 404]);
  if (res.status === 404) return { exists: false, service_id: id };
  return res.body.service;
}

async function serviceList(ctx, args) {
  const qs = buildQs({
    limit:    args.limit ? Math.min(100, Math.max(1, Number(args.limit))) : undefined,
    offset:   args.offset ? Number(args.offset) : undefined,
    query:    args.query,
    team_ids: args.team_ids,
    include:  args.include,
    sort_by:  args.sort_by,
  });
  const res = await pdReq(ctx, "GET", `/services${qs}`);
  return { services: res.body.services, total: res.body.total, limit: res.body.limit, offset: res.body.offset, more: res.body.more };
}

async function serviceCreate(ctx, args) {
  const name = requireString(args.name, "name");
  const ep   = requireString(args.escalation_policy_id, "escalation_policy_id");
  const service = {
    name,
    escalation_policy: { id: ep, type: "escalation_policy_reference" },
  };
  if (args.description)    service.description    = args.description;
  if (args.auto_resolve_timeout != null) service.auto_resolve_timeout = Number(args.auto_resolve_timeout);
  if (args.acknowledgement_timeout != null) service.acknowledgement_timeout = Number(args.acknowledgement_timeout);
  if (args.alert_creation) service.alert_creation = args.alert_creation;
  const res = await pdReq(ctx, "POST", "/services", { service }, [201]);
  return res.body.service;
}

async function serviceUpdate(ctx, args) {
  const id = requireString(args.service_id, "service_id");
  const service = {};
  if (args.name)        service.name        = args.name;
  if (args.description) service.description = args.description;
  if (args.status)      service.status      = args.status;
  if (args.auto_resolve_timeout != null) service.auto_resolve_timeout = Number(args.auto_resolve_timeout);
  if (args.acknowledgement_timeout != null) service.acknowledgement_timeout = Number(args.acknowledgement_timeout);
  if (args.escalation_policy_id) service.escalation_policy = { id: args.escalation_policy_id, type: "escalation_policy_reference" };
  const res = await pdReq(ctx, "PUT", `/services/${encodeURIComponent(id)}`, { service });
  return res.body.service;
}

async function serviceDelete(ctx, args) {
  const id = requireString(args.service_id, "service_id");
  const res = await pdReq(ctx, "DELETE", `/services/${encodeURIComponent(id)}`, undefined, [200, 204, 404]);
  return { deleted: res.status !== 404, service_id: id };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ESCALATION POLICIES
// ═══════════════════════════════════════════════════════════════════════════════

async function escalationPolicyGet(ctx, args) {
  const id = requireString(args.escalation_policy_id, "escalation_policy_id");
  const res = await pdReq(ctx, "GET", `/escalation_policies/${encodeURIComponent(id)}`, undefined, [200, 404]);
  if (res.status === 404) return { exists: false, escalation_policy_id: id };
  return res.body.escalation_policy;
}

async function escalationPolicyList(ctx, args) {
  const qs = buildQs({
    limit:    args.limit ? Math.min(100, Math.max(1, Number(args.limit))) : undefined,
    offset:   args.offset ? Number(args.offset) : undefined,
    query:    args.query,
    team_ids: args.team_ids,
    sort_by:  args.sort_by,
    include:  args.include,
  });
  const res = await pdReq(ctx, "GET", `/escalation_policies${qs}`);
  return { escalation_policies: res.body.escalation_policies, total: res.body.total, more: res.body.more };
}

async function escalationPolicyCreate(ctx, args) {
  const name = requireString(args.name, "name");
  if (!Array.isArray(args.escalation_rules) || !args.escalation_rules.length)
    throw new Error("escalation_rules must be a non-empty array");
  const escalation_policy = { name, escalation_rules: args.escalation_rules };
  if (args.description) escalation_policy.description = args.description;
  if (args.num_loops != null) escalation_policy.num_loops = Number(args.num_loops);
  const res = await pdReq(ctx, "POST", "/escalation_policies", { escalation_policy }, [201]);
  return res.body.escalation_policy;
}

async function escalationPolicyDelete(ctx, args) {
  const id = requireString(args.escalation_policy_id, "escalation_policy_id");
  const res = await pdReq(ctx, "DELETE", `/escalation_policies/${encodeURIComponent(id)}`, undefined, [200, 204, 404]);
  return { deleted: res.status !== 404, escalation_policy_id: id };
}

// ═══════════════════════════════════════════════════════════════════════════════
// USERS
// ═══════════════════════════════════════════════════════════════════════════════

async function userGet(ctx, args) {
  const id = requireString(args.user_id, "user_id");
  const qs = buildQs({ include: args.include });
  const res = await pdReq(ctx, "GET", `/users/${encodeURIComponent(id)}${qs}`, undefined, [200, 404]);
  if (res.status === 404) return { exists: false, user_id: id };
  return res.body.user;
}

async function userList(ctx, args) {
  const qs = buildQs({
    limit:    args.limit ? Math.min(100, Math.max(1, Number(args.limit))) : undefined,
    offset:   args.offset ? Number(args.offset) : undefined,
    query:    args.query,
    team_ids: args.team_ids,
    include:  args.include,
  });
  const res = await pdReq(ctx, "GET", `/users${qs}`);
  return { users: res.body.users, total: res.body.total, more: res.body.more };
}

async function userCreate(ctx, args) {
  const name  = requireString(args.name, "name");
  const email = requireString(args.email, "email");
  const role  = args.role || "user";
  const user  = { name, email, role, type: "user" };
  if (args.description) user.description = args.description;
  if (args.time_zone)   user.time_zone   = args.time_zone;
  const res = await pdReq(ctx, "POST", "/users", { user }, [201]);
  return res.body.user;
}

async function userUpdate(ctx, args) {
  const id = requireString(args.user_id, "user_id");
  const user = {};
  if (args.name)        user.name        = args.name;
  if (args.email)       user.email       = args.email;
  if (args.role)        user.role        = args.role;
  if (args.description) user.description = args.description;
  if (args.time_zone)   user.time_zone   = args.time_zone;
  const res = await pdReq(ctx, "PUT", `/users/${encodeURIComponent(id)}`, { user });
  return res.body.user;
}

async function userDelete(ctx, args) {
  const id = requireString(args.user_id, "user_id");
  const res = await pdReq(ctx, "DELETE", `/users/${encodeURIComponent(id)}`, undefined, [200, 204, 404]);
  return { deleted: res.status !== 404, user_id: id };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEAMS
// ═══════════════════════════════════════════════════════════════════════════════

async function teamGet(ctx, args) {
  const id = requireString(args.team_id, "team_id");
  const res = await pdReq(ctx, "GET", `/teams/${encodeURIComponent(id)}`, undefined, [200, 404]);
  if (res.status === 404) return { exists: false, team_id: id };
  return res.body.team;
}

async function teamList(ctx, args) {
  const qs = buildQs({
    limit:  args.limit ? Math.min(100, Math.max(1, Number(args.limit))) : undefined,
    offset: args.offset ? Number(args.offset) : undefined,
    query:  args.query,
  });
  const res = await pdReq(ctx, "GET", `/teams${qs}`);
  return { teams: res.body.teams, total: res.body.total, more: res.body.more };
}

async function teamCreate(ctx, args) {
  const name = requireString(args.name, "name");
  const team = { name, type: "team" };
  if (args.description) team.description = args.description;
  const res = await pdReq(ctx, "POST", "/teams", { team }, [201]);
  return res.body.team;
}

async function teamDelete(ctx, args) {
  const id = requireString(args.team_id, "team_id");
  const res = await pdReq(ctx, "DELETE", `/teams/${encodeURIComponent(id)}`, undefined, [200, 204, 404]);
  return { deleted: res.status !== 404, team_id: id };
}

async function teamMembers(ctx, args) {
  const id = requireString(args.team_id, "team_id");
  const qs = buildQs({
    limit:  args.limit ? Math.min(100, Math.max(1, Number(args.limit))) : undefined,
    offset: args.offset ? Number(args.offset) : undefined,
    include: args.include,
  });
  const res = await pdReq(ctx, "GET", `/teams/${encodeURIComponent(id)}/members${qs}`);
  return { members: res.body.members, total: res.body.total, more: res.body.more };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ON-CALL SCHEDULES
// ═══════════════════════════════════════════════════════════════════════════════

async function scheduleGet(ctx, args) {
  const id = requireString(args.schedule_id, "schedule_id");
  const qs = buildQs({ since: args.since, until: args.until, time_zone: args.time_zone });
  const res = await pdReq(ctx, "GET", `/schedules/${encodeURIComponent(id)}${qs}`, undefined, [200, 404]);
  if (res.status === 404) return { exists: false, schedule_id: id };
  return res.body.schedule;
}

async function scheduleList(ctx, args) {
  const qs = buildQs({
    limit:     args.limit ? Math.min(100, Math.max(1, Number(args.limit))) : undefined,
    offset:    args.offset ? Number(args.offset) : undefined,
    query:     args.query,
    time_zone: args.time_zone,
  });
  const res = await pdReq(ctx, "GET", `/schedules${qs}`);
  return { schedules: res.body.schedules, total: res.body.total, more: res.body.more };
}

async function onCallList(ctx, args) {
  const qs = buildQs({
    limit:                  args.limit ? Math.min(100, Math.max(1, Number(args.limit))) : undefined,
    offset:                 args.offset ? Number(args.offset) : undefined,
    since:                  args.since,
    until:                  args.until,
    schedule_ids:           args.schedule_ids,
    user_ids:               args.user_ids,
    escalation_policy_ids:  args.escalation_policy_ids,
    include:                args.include,
    time_zone:              args.time_zone,
  });
  const res = await pdReq(ctx, "GET", `/oncalls${qs}`);
  return { oncalls: res.body.oncalls, total: res.body.total, more: res.body.more };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ALERTS
// ═══════════════════════════════════════════════════════════════════════════════

async function alertList(ctx, args) {
  const id = requireString(args.incident_id, "incident_id");
  const qs = buildQs({
    limit:       args.limit ? Math.min(100, Math.max(1, Number(args.limit))) : undefined,
    offset:      args.offset ? Number(args.offset) : undefined,
    alert_key:   args.alert_key,
    statuses:    args.statuses,
    sort_by:     args.sort_by,
    include:     args.include,
  });
  const res = await pdReq(ctx, "GET", `/incidents/${encodeURIComponent(id)}/alerts${qs}`);
  return { alerts: res.body.alerts, total: res.body.total, more: res.body.more };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOG ENTRIES
// ═══════════════════════════════════════════════════════════════════════════════

async function logEntryGet(ctx, args) {
  const id = requireString(args.log_entry_id, "log_entry_id");
  const qs = buildQs({ include: args.include, time_zone: args.time_zone });
  const res = await pdReq(ctx, "GET", `/log_entries/${encodeURIComponent(id)}${qs}`, undefined, [200, 404]);
  if (res.status === 404) return { exists: false, log_entry_id: id };
  return res.body.log_entry;
}

async function logEntryList(ctx, args) {
  const qs = buildQs({
    limit:     args.limit ? Math.min(100, Math.max(1, Number(args.limit))) : undefined,
    offset:    args.offset ? Number(args.offset) : undefined,
    since:     args.since,
    until:     args.until,
    is_overview: args.is_overview,
    include:   args.include,
    time_zone: args.time_zone,
  });
  const res = await pdReq(ctx, "GET", `/log_entries${qs}`);
  return { log_entries: res.body.log_entries, total: res.body.total, more: res.body.more };
}

// ═══════════════════════════════════════════════════════════════════════════════
// ABILITIES (account capabilities)
// ═══════════════════════════════════════════════════════════════════════════════

async function abilitiesList(ctx) {
  const res = await pdReq(ctx, "GET", "/abilities");
  return { abilities: res.body.abilities };
}

// ═══════════════════════════════════════════════════════════════════════════════
// GENERIC / INFO
// ═══════════════════════════════════════════════════════════════════════════════

async function genericRequest(ctx, args) {
  const method   = (args.method || "GET").toUpperCase();
  const apiPath  = requireString(args.path, "path");
  const body     = args.body;
  const fullPath = apiPath.startsWith("/") ? apiPath : `/${apiPath}`;
  const res = await pdRequest({
    apiKey:            ctx.apiKey,
    accessToken:       ctx.accessToken,
    method, path: fullPath, body,
    timeout:           ctx.timeout,
    rejectUnauthorized: ctx.rejectUnauthorized,
    from:              ctx.from,
  });
  return { status: res.status, body: res.body };
}

async function info(ctx) {
  // Fetch current user to confirm auth + get account info
  const usersRes = await pdReq(ctx, "GET", "/users/me", undefined, [200, 404]);
  let currentUser = null;
  if (usersRes.status === 200) currentUser = usersRes.body.user;
  const abilitiesRes = await pdReq(ctx, "GET", "/abilities");
  return {
    api_base:     `https://${API_BASE}`,
    api_version:  "v2",
    current_user: currentUser,
    abilities:    abilitiesRes.body.abilities,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN DISPATCHER
// ═══════════════════════════════════════════════════════════════════════════════

async function pagerdutyClient(args) {
  const { operation } = args;
  if (!operation) throw new Error("operation is required");

  for (const f of ["api_key", "access_token", "from_email"]) {
    if (args[f]) validateNul(args[f], f);
  }

  const ctx = buildCtx(args);

  try {
    switch (operation) {
      // Incidents
      case "incident_get":         return await incidentGet(ctx, args);
      case "incident_list":        return await incidentList(ctx, args);
      case "incident_create":      return await incidentCreate(ctx, args);
      case "incident_update":      return await incidentUpdate(ctx, args);
      case "incident_acknowledge": return await incidentAcknowledge(ctx, args);
      case "incident_resolve":     return await incidentResolve(ctx, args);
      case "incident_merge":       return await incidentMerge(ctx, args);
      // Notes
      case "note_list":            return await noteList(ctx, args);
      case "note_create":          return await noteCreate(ctx, args);
      // Services
      case "service_get":          return await serviceGet(ctx, args);
      case "service_list":         return await serviceList(ctx, args);
      case "service_create":       return await serviceCreate(ctx, args);
      case "service_update":       return await serviceUpdate(ctx, args);
      case "service_delete":       return await serviceDelete(ctx, args);
      // Escalation Policies
      case "escalation_policy_get":    return await escalationPolicyGet(ctx, args);
      case "escalation_policy_list":   return await escalationPolicyList(ctx, args);
      case "escalation_policy_create": return await escalationPolicyCreate(ctx, args);
      case "escalation_policy_delete": return await escalationPolicyDelete(ctx, args);
      // Users
      case "user_get":             return await userGet(ctx, args);
      case "user_list":            return await userList(ctx, args);
      case "user_create":          return await userCreate(ctx, args);
      case "user_update":          return await userUpdate(ctx, args);
      case "user_delete":          return await userDelete(ctx, args);
      // Teams
      case "team_get":             return await teamGet(ctx, args);
      case "team_list":            return await teamList(ctx, args);
      case "team_create":          return await teamCreate(ctx, args);
      case "team_delete":          return await teamDelete(ctx, args);
      case "team_members":         return await teamMembers(ctx, args);
      // Schedules / On-call
      case "schedule_get":         return await scheduleGet(ctx, args);
      case "schedule_list":        return await scheduleList(ctx, args);
      case "oncall_list":          return await onCallList(ctx, args);
      // Alerts
      case "alert_list":           return await alertList(ctx, args);
      // Log entries
      case "log_entry_get":        return await logEntryGet(ctx, args);
      case "log_entry_list":       return await logEntryList(ctx, args);
      // Abilities
      case "abilities_list":       return await abilitiesList(ctx);
      // Generic
      case "request":              return await genericRequest(ctx, args);
      case "info":                 return await info(ctx);
      default:
        throw new Error(`Unknown pagerduty_client operation: ${operation}`);
    }
  } catch (err) {
    const msg = scrubCreds(err.message || String(err), args.api_key, args.access_token);
    const out = new Error(msg);
    out.stack = scrubCreds(err.stack || "", args.api_key, args.access_token);
    throw out;
  }
}

module.exports = { pagerdutyClient };
