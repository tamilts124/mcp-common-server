"use strict";
/**
 * terraform_client — Zero-dependency Terraform Cloud / Terraform Enterprise REST API client
 * (pure Node.js https/http built-ins; no npm deps)
 *
 * Authentication: Terraform Cloud API token (Bearer).
 * Provide 'token' for all operations (except 'info').
 *
 * Base URL: https://app.terraform.io (TFC) or a custom TFE URL via 'base_url'.
 * API version: v2 (https://developer.hashicorp.com/terraform/cloud-docs/api-docs)
 *
 * Supported operations:
 *   Organizations:
 *     org_list         — List all organizations
 *     org_get          — Get organization details
 *
 *   Workspaces:
 *     workspace_list   — List workspaces in an organization
 *     workspace_get    — Get workspace details
 *     workspace_create — Create a workspace
 *     workspace_update — Update workspace settings
 *     workspace_delete — Delete a workspace
 *     workspace_lock   — Lock a workspace
 *     workspace_unlock — Unlock a workspace
 *
 *   Runs:
 *     run_list    — List runs for a workspace
 *     run_get     — Get run details
 *     run_create  — Queue/trigger a new run
 *     run_apply   — Confirm/apply a run (when requires confirmation)
 *     run_discard — Discard a run
 *     run_cancel  — Cancel an in-progress run
 *
 *   State Versions:
 *     state_list    — List state versions for a workspace
 *     state_get     — Get a specific state version
 *     state_current — Get the current state version for a workspace
 *
 *   Variables:
 *     var_list   — List variables for a workspace
 *     var_create — Create a workspace variable
 *     var_update — Update a workspace variable
 *     var_delete — Delete a workspace variable
 *
 *   Plans:
 *     plan_get — Get plan details
 *     plan_log — Get plan log output
 *
 *   Applies:
 *     apply_get — Get apply details
 *     apply_log — Get apply log output
 *
 *   Generic:
 *     request — Generic authenticated request to any TFC/TFE API endpoint
 *     info    — Return this operation reference (no I/O)
 *
 * Security:
 *   NUL-byte guards on all string inputs.
 *   Timeout clamped 1000–120000 ms.
 *   Tokens never returned in output or errors.
 *   16 MB response cap.
 *   TLS enforced by default (reject_unauthorized).
 */

const https = require("https");
const http  = require("http");

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 20000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024; // 16 MB
const TFC_BASE_URL       = "https://app.terraform.io";
const API_V2_PREFIX      = "/api/v2";

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

function clampInt(val, def, min, max, name) {
  if (val === undefined || val === null) return def;
  const n = Number(val);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return Math.min(max, Math.max(min, Math.round(n)));
}

// ── Low-level HTTP helper ──────────────────────────────────────────────────

function tfHttpRequest(opts) {
  const { url, method, headers, body, timeoutMs, rejectUnauthorized } = opts;
  return new Promise((resolve, reject) => {
    const parsed   = new URL(url);
    const useTls   = parsed.protocol === "https:";
    const bodyBuf  = body
      ? (Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8"))
      : null;

    const reqOpts = {
      hostname: parsed.hostname,
      port:     parsed.port || (useTls ? 443 : 80),
      path:     parsed.pathname + (parsed.search || ""),
      method:   (method || "GET").toUpperCase(),
      headers:  { ...headers },
    };
    if (useTls) {
      reqOpts.rejectUnauthorized = rejectUnauthorized !== false;
      reqOpts.servername         = parsed.hostname;
    }
    if (bodyBuf) reqOpts.headers["Content-Length"] = bodyBuf.length;

    const mod    = useTls ? https : http;
    const chunks = [];
    let totalBytes = 0;
    let settled    = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new Error(`Terraform request ${method} ${url} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const req = mod.request(reqOpts, (res) => {
      res.on("data", (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          req.destroy();
          reject(new Error("Terraform response exceeded 16 MB cap"));
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
        reject(new Error(`Terraform response stream error: ${err.message}`));
      });
    });

    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Cannot connect to ${parsed.hostname}: ${err.message}`));
    });

    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

// ── Authenticated API request helper ──────────────────────────────────────

function buildConn(args) {
  const timeoutMs          = clampInt(args.timeout, DEFAULT_TIMEOUT_MS, 1000, 120000, "timeout");
  const rejectUnauthorized = args.reject_unauthorized !== false;
  const baseUrl            = (args.base_url || TFC_BASE_URL).replace(/\/$/, "");
  guardString(args.base_url, "base_url");
  if (args.base_url && args.base_url.includes("\0"))
    throw new Error("base_url must not contain NUL bytes");
  return { token: args.token || null, baseUrl, timeoutMs, rejectUnauthorized };
}

async function tfApiRequest(conn, opts) {
  const { path, method, body, isPlaintext } = opts;
  if (!conn.token)
    throw new Error("terraform_client: 'token' is required for this operation");

  const url     = `${conn.baseUrl}${path}`;
  const headers = {
    "Authorization": `Bearer ${conn.token}`,
    "Content-Type":  isPlaintext ? "text/plain" : "application/vnd.api+json",
    "Accept":        "application/vnd.api+json",
  };

  const bodyStr = body
    ? (typeof body === "string" ? body : JSON.stringify(body))
    : null;
  if (bodyStr) headers["Content-Length"] = Buffer.byteLength(bodyStr, "utf8");

  return tfHttpRequest({
    url, method: method || "GET", headers,
    body: bodyStr,
    timeoutMs: conn.timeoutMs,
    rejectUnauthorized: conn.rejectUnauthorized,
  });
}

function parseTfJson(raw, ctx) {
  try { return JSON.parse(raw); } catch (_) {
    throw new Error(`Terraform: invalid JSON response (${ctx}): ${raw.slice(0, 200)}`);
  }
}

function checkTfStatus(res, ctx) {
  if (res.statusCode < 200 || res.statusCode >= 300) {
    let extra = "";
    try {
      const j = JSON.parse(res.raw);
      const errs = j.errors;
      if (Array.isArray(errs) && errs.length > 0) {
        extra = errs.map(e => `${e.status || ""} ${e.title || ""}: ${e.detail || ""}`).join("; ").trim();
      } else {
        extra = res.raw.slice(0, 300);
      }
    } catch (_) { extra = res.raw.slice(0, 300); }
    throw new Error(`Terraform ${ctx}: HTTP ${res.statusCode} — ${extra}`);
  }
}

// ── Helper: extract pagination info ───────────────────────────────────────

function extractPagination(json) {
  const meta = json.meta || {};
  const pg   = meta.pagination || {};
  return {
    current_page: pg["current-page"] || null,
    total_pages:  pg["total-pages"]  || null,
    total_count:  pg["total-count"]  || null,
    next_page:    pg["next-page"]    || null,
  };
}

// ── Helper: build pagination query string ─────────────────────────────────

function pgQuery(args) {
  const parts = [];
  if (args.page_number) parts.push(`page%5Bnumber%5D=${args.page_number}`);
  if (args.page_size)   parts.push(`page%5Bsize%5D=${args.page_size}`);
  return parts.length ? `?${parts.join("&")}` : "";
}

// ── Organization Operations ────────────────────────────────────────────────

async function opOrgList(args, conn) {
  const qs  = pgQuery(args);
  const res = await tfApiRequest(conn, { path: `${API_V2_PREFIX}/organizations${qs}`, method: "GET" });
  checkTfStatus(res, "org_list");
  const json  = parseTfJson(res.raw, "org_list");
  const orgs  = (json.data || []).map(mapOrg);
  return { ok: true, operation: "org_list", count: orgs.length, organizations: orgs, pagination: extractPagination(json) };
}

async function opOrgGet(args, conn) {
  requireString(args.organization, "organization");
  const res = await tfApiRequest(conn, { path: `${API_V2_PREFIX}/organizations/${encodeURIComponent(args.organization)}`, method: "GET" });
  if (res.statusCode === 404) return { ok: true, operation: "org_get", organization: args.organization, exists: false };
  checkTfStatus(res, "org_get");
  const json = parseTfJson(res.raw, "org_get");
  return { ok: true, operation: "org_get", exists: true, ...mapOrg(json.data) };
}

function mapOrg(d) {
  const a = d.attributes || {};
  return {
    id:                    d.id,
    name:                  a.name,
    email:                 a.email || null,
    collaborator_auth_policy: a["collaborator-auth-policy"] || null,
    plan:                  a.plan || null,
    created_at:            a["created-at"] || null,
    permissions:           a.permissions || {},
  };
}

// ── Workspace Operations ───────────────────────────────────────────────────

async function opWorkspaceList(args, conn) {
  requireString(args.organization, "organization");
  let path = `${API_V2_PREFIX}/organizations/${encodeURIComponent(args.organization)}/workspaces`;
  const parts = [];
  if (args.search)      parts.push(`search%5Bname%5D=${encodeURIComponent(args.search)}`);
  if (args.page_number) parts.push(`page%5Bnumber%5D=${args.page_number}`);
  if (args.page_size)   parts.push(`page%5Bsize%5D=${args.page_size}`);
  if (parts.length)     path += `?${parts.join("&")}`;
  const res = await tfApiRequest(conn, { path, method: "GET" });
  checkTfStatus(res, "workspace_list");
  const json = parseTfJson(res.raw, "workspace_list");
  const wss  = (json.data || []).map(mapWorkspace);
  return { ok: true, operation: "workspace_list", organization: args.organization, count: wss.length, workspaces: wss, pagination: extractPagination(json) };
}

async function opWorkspaceGet(args, conn) {
  if (args.workspace_id) {
    requireString(args.workspace_id, "workspace_id");
    const res = await tfApiRequest(conn, { path: `${API_V2_PREFIX}/workspaces/${encodeURIComponent(args.workspace_id)}`, method: "GET" });
    if (res.statusCode === 404) return { ok: true, operation: "workspace_get", workspace_id: args.workspace_id, exists: false };
    checkTfStatus(res, "workspace_get");
    const json = parseTfJson(res.raw, "workspace_get");
    return { ok: true, operation: "workspace_get", exists: true, ...mapWorkspace(json.data) };
  }
  requireString(args.organization, "organization");
  requireString(args.workspace,    "workspace");
  const res = await tfApiRequest(conn, {
    path: `${API_V2_PREFIX}/organizations/${encodeURIComponent(args.organization)}/workspaces/${encodeURIComponent(args.workspace)}`,
    method: "GET",
  });
  if (res.statusCode === 404) return { ok: true, operation: "workspace_get", workspace: args.workspace, exists: false };
  checkTfStatus(res, "workspace_get");
  const json = parseTfJson(res.raw, "workspace_get");
  return { ok: true, operation: "workspace_get", exists: true, ...mapWorkspace(json.data) };
}

async function opWorkspaceCreate(args, conn) {
  requireString(args.organization, "organization");
  requireString(args.workspace,    "workspace");
  const attrs = { name: args.workspace };
  if (args.description         !== undefined) attrs.description              = args.description;
  if (args.auto_apply          !== undefined) attrs["auto-apply"]            = args.auto_apply;
  if (args.terraform_version   !== undefined) attrs["terraform-version"]     = args.terraform_version;
  if (args.working_directory   !== undefined) attrs["working-directory"]     = args.working_directory;
  if (args.queue_all_runs      !== undefined) attrs["queue-all-runs"]        = args.queue_all_runs;
  if (args.execution_mode      !== undefined) attrs["execution-mode"]        = args.execution_mode;
  if (args.agent_pool_id       !== undefined) {
    attrs["execution-mode"] = "agent";
    attrs["agent-pool-id"]  = args.agent_pool_id;
  }
  const body = { data: { type: "workspaces", attributes: attrs } };
  const res  = await tfApiRequest(conn, {
    path:   `${API_V2_PREFIX}/organizations/${encodeURIComponent(args.organization)}/workspaces`,
    method: "POST", body,
  });
  checkTfStatus(res, "workspace_create");
  const json = parseTfJson(res.raw, "workspace_create");
  return { ok: true, operation: "workspace_create", created: true, ...mapWorkspace(json.data) };
}

async function opWorkspaceUpdate(args, conn) {
  if (!args.workspace_id && !(args.organization && args.workspace))
    throw new Error("workspace_update: provide 'workspace_id' or 'organization' + 'workspace'");

  const attrs = {};
  if (args.description       !== undefined) attrs.description              = args.description;
  if (args.auto_apply        !== undefined) attrs["auto-apply"]            = args.auto_apply;
  if (args.terraform_version !== undefined) attrs["terraform-version"]     = args.terraform_version;
  if (args.working_directory !== undefined) attrs["working-directory"]     = args.working_directory;
  if (args.queue_all_runs    !== undefined) attrs["queue-all-runs"]        = args.queue_all_runs;
  if (args.execution_mode    !== undefined) attrs["execution-mode"]        = args.execution_mode;
  if (args.new_name          !== undefined) attrs.name                     = args.new_name;
  const body = { data: { type: "workspaces", attributes: attrs } };

  let path;
  if (args.workspace_id) {
    path = `${API_V2_PREFIX}/workspaces/${encodeURIComponent(args.workspace_id)}`;
  } else {
    path = `${API_V2_PREFIX}/organizations/${encodeURIComponent(args.organization)}/workspaces/${encodeURIComponent(args.workspace)}`;
  }
  const res = await tfApiRequest(conn, { path, method: "PATCH", body });
  checkTfStatus(res, "workspace_update");
  const json = parseTfJson(res.raw, "workspace_update");
  return { ok: true, operation: "workspace_update", updated: true, ...mapWorkspace(json.data) };
}

async function opWorkspaceDelete(args, conn) {
  if (!args.workspace_id && !(args.organization && args.workspace))
    throw new Error("workspace_delete: provide 'workspace_id' or 'organization' + 'workspace'");

  let path;
  if (args.workspace_id) {
    path = `${API_V2_PREFIX}/workspaces/${encodeURIComponent(args.workspace_id)}`;
  } else {
    path = `${API_V2_PREFIX}/organizations/${encodeURIComponent(args.organization)}/workspaces/${encodeURIComponent(args.workspace)}`;
  }
  const res = await tfApiRequest(conn, { path, method: "DELETE" });
  if (res.statusCode === 404) return { ok: true, operation: "workspace_delete", deleted: false, reason: "not_found" };
  checkTfStatus(res, "workspace_delete");
  return { ok: true, operation: "workspace_delete", deleted: true };
}

async function opWorkspaceLock(args, conn) {
  requireString(args.workspace_id, "workspace_id");
  const body = { reason: args.reason || "Locked via terraform_client MCP tool" };
  const res  = await tfApiRequest(conn, {
    path: `${API_V2_PREFIX}/workspaces/${encodeURIComponent(args.workspace_id)}/actions/lock`,
    method: "POST", body,
  });
  if (res.statusCode === 409) return { ok: true, operation: "workspace_lock", locked: false, reason: "already_locked" };
  checkTfStatus(res, "workspace_lock");
  const json = parseTfJson(res.raw, "workspace_lock");
  return { ok: true, operation: "workspace_lock", locked: true, ...mapWorkspace(json.data) };
}

async function opWorkspaceUnlock(args, conn) {
  requireString(args.workspace_id, "workspace_id");
  const res = await tfApiRequest(conn, {
    path: `${API_V2_PREFIX}/workspaces/${encodeURIComponent(args.workspace_id)}/actions/unlock`,
    method: "POST", body: {},
  });
  if (res.statusCode === 409) return { ok: true, operation: "workspace_unlock", unlocked: false, reason: "not_locked" };
  checkTfStatus(res, "workspace_unlock");
  const json = parseTfJson(res.raw, "workspace_unlock");
  return { ok: true, operation: "workspace_unlock", unlocked: true, ...mapWorkspace(json.data) };
}

function mapWorkspace(d) {
  if (!d) return {};
  const a = d.attributes || {};
  const r = d.relationships || {};
  return {
    id:                 d.id,
    name:               a.name,
    description:        a.description  || null,
    auto_apply:         a["auto-apply"] || false,
    locked:             a.locked       || false,
    terraform_version:  a["terraform-version"] || null,
    working_directory:  a["working-directory"]  || null,
    execution_mode:     a["execution-mode"]     || null,
    queue_all_runs:     a["queue-all-runs"]      || false,
    created_at:         a["created-at"]          || null,
    updated_at:         a["updated-at"]          || null,
    resource_count:     a["resource-count"]      || 0,
    run_failures:       a["run-failures"]         || 0,
    organization:       r.organization?.data?.id || null,
  };
}

// ── Run Operations ─────────────────────────────────────────────────────────

async function opRunList(args, conn) {
  requireString(args.workspace_id, "workspace_id");
  let path = `${API_V2_PREFIX}/workspaces/${encodeURIComponent(args.workspace_id)}/runs`;
  const parts = [];
  if (args.page_number) parts.push(`page%5Bnumber%5D=${args.page_number}`);
  if (args.page_size)   parts.push(`page%5Bsize%5D=${args.page_size}`);
  if (parts.length)     path += `?${parts.join("&")}`;
  const res = await tfApiRequest(conn, { path, method: "GET" });
  checkTfStatus(res, "run_list");
  const json = parseTfJson(res.raw, "run_list");
  const runs = (json.data || []).map(mapRun);
  return { ok: true, operation: "run_list", workspace_id: args.workspace_id, count: runs.length, runs, pagination: extractPagination(json) };
}

async function opRunGet(args, conn) {
  requireString(args.run_id, "run_id");
  const res = await tfApiRequest(conn, { path: `${API_V2_PREFIX}/runs/${encodeURIComponent(args.run_id)}`, method: "GET" });
  if (res.statusCode === 404) return { ok: true, operation: "run_get", run_id: args.run_id, exists: false };
  checkTfStatus(res, "run_get");
  const json = parseTfJson(res.raw, "run_get");
  return { ok: true, operation: "run_get", exists: true, ...mapRun(json.data) };
}

async function opRunCreate(args, conn) {
  requireString(args.workspace_id, "workspace_id");
  const attrs = {};
  if (args.message         !== undefined) attrs.message         = args.message;
  if (args.auto_apply      !== undefined) attrs["auto-apply"]    = args.auto_apply;
  if (args.is_destroy      !== undefined) attrs["is-destroy"]    = args.is_destroy;
  if (args.refresh         !== undefined) attrs.refresh          = args.refresh;
  if (args.refresh_only    !== undefined) attrs["refresh-only"]  = args.refresh_only;
  if (args.target_addrs    !== undefined) attrs["target-addrs"]  = args.target_addrs;
  if (args.replace_addrs   !== undefined) attrs["replace-addrs"] = args.replace_addrs;
  const body = {
    data: {
      type:         "runs",
      attributes:   attrs,
      relationships: {
        workspace: { data: { type: "workspaces", id: args.workspace_id } },
      },
    },
  };
  if (args.configuration_version_id) {
    body.data.relationships["configuration-version"] = {
      data: { type: "configuration-versions", id: args.configuration_version_id },
    };
  }
  const res = await tfApiRequest(conn, { path: `${API_V2_PREFIX}/runs`, method: "POST", body });
  checkTfStatus(res, "run_create");
  const json = parseTfJson(res.raw, "run_create");
  return { ok: true, operation: "run_create", created: true, ...mapRun(json.data) };
}

async function opRunApply(args, conn) {
  requireString(args.run_id, "run_id");
  const body = args.comment ? { comment: args.comment } : {};
  const res  = await tfApiRequest(conn, {
    path:   `${API_V2_PREFIX}/runs/${encodeURIComponent(args.run_id)}/actions/apply`,
    method: "POST", body,
  });
  if (res.statusCode === 409)
    return { ok: true, operation: "run_apply", applied: false, reason: "run_not_confirmable" };
  checkTfStatus(res, "run_apply");
  return { ok: true, operation: "run_apply", run_id: args.run_id, applied: true };
}

async function opRunDiscard(args, conn) {
  requireString(args.run_id, "run_id");
  const body = args.comment ? { comment: args.comment } : {};
  const res  = await tfApiRequest(conn, {
    path:   `${API_V2_PREFIX}/runs/${encodeURIComponent(args.run_id)}/actions/discard`,
    method: "POST", body,
  });
  if (res.statusCode === 409)
    return { ok: true, operation: "run_discard", discarded: false, reason: "run_not_discardable" };
  checkTfStatus(res, "run_discard");
  return { ok: true, operation: "run_discard", run_id: args.run_id, discarded: true };
}

async function opRunCancel(args, conn) {
  requireString(args.run_id, "run_id");
  const body = args.comment ? { comment: args.comment } : {};
  const res  = await tfApiRequest(conn, {
    path:   `${API_V2_PREFIX}/runs/${encodeURIComponent(args.run_id)}/actions/cancel`,
    method: "POST", body,
  });
  if (res.statusCode === 409)
    return { ok: true, operation: "run_cancel", cancelled: false, reason: "run_not_cancellable" };
  checkTfStatus(res, "run_cancel");
  return { ok: true, operation: "run_cancel", run_id: args.run_id, cancelled: true };
}

function mapRun(d) {
  if (!d) return {};
  const a = d.attributes || {};
  const r = d.relationships || {};
  return {
    id:             d.id,
    status:         a.status               || null,
    message:        a.message              || null,
    is_destroy:     a["is-destroy"]        || false,
    auto_apply:     a["auto-apply"]        || false,
    refresh:        a.refresh              !== undefined ? a.refresh : null,
    refresh_only:   a["refresh-only"]      || false,
    source:         a.source               || null,
    status_timestamps: a["status-timestamps"] || {},
    created_at:     a["created-at"]        || null,
    has_changes:    a["has-changes"]        || false,
    resource_additions: a["resource-additions"]    || 0,
    resource_changes:   a["resource-changes"]      || 0,
    resource_destructions: a["resource-destructions"] || 0,
    workspace_id:   r.workspace?.data?.id  || null,
    plan_id:        r.plan?.data?.id       || null,
    apply_id:       r.apply?.data?.id      || null,
  };
}

// ── State Version Operations ───────────────────────────────────────────────

async function opStateList(args, conn) {
  requireString(args.workspace_id, "workspace_id");
  let path = `${API_V2_PREFIX}/workspaces/${encodeURIComponent(args.workspace_id)}/state-versions`;
  const parts = [];
  if (args.page_number) parts.push(`page%5Bnumber%5D=${args.page_number}`);
  if (args.page_size)   parts.push(`page%5Bsize%5D=${args.page_size}`);
  if (parts.length)     path += `?${parts.join("&")}`;
  const res = await tfApiRequest(conn, { path, method: "GET" });
  checkTfStatus(res, "state_list");
  const json   = parseTfJson(res.raw, "state_list");
  const states = (json.data || []).map(mapState);
  return { ok: true, operation: "state_list", workspace_id: args.workspace_id, count: states.length, state_versions: states, pagination: extractPagination(json) };
}

async function opStateGet(args, conn) {
  requireString(args.state_version_id, "state_version_id");
  const res = await tfApiRequest(conn, { path: `${API_V2_PREFIX}/state-versions/${encodeURIComponent(args.state_version_id)}`, method: "GET" });
  if (res.statusCode === 404) return { ok: true, operation: "state_get", state_version_id: args.state_version_id, exists: false };
  checkTfStatus(res, "state_get");
  const json = parseTfJson(res.raw, "state_get");
  return { ok: true, operation: "state_get", exists: true, ...mapState(json.data) };
}

async function opStateCurrent(args, conn) {
  requireString(args.workspace_id, "workspace_id");
  const res = await tfApiRequest(conn, { path: `${API_V2_PREFIX}/workspaces/${encodeURIComponent(args.workspace_id)}/current-state-version`, method: "GET" });
  if (res.statusCode === 404) return { ok: true, operation: "state_current", workspace_id: args.workspace_id, exists: false };
  checkTfStatus(res, "state_current");
  const json = parseTfJson(res.raw, "state_current");
  return { ok: true, operation: "state_current", exists: true, ...mapState(json.data) };
}

function mapState(d) {
  if (!d) return {};
  const a = d.attributes || {};
  return {
    id:               d.id,
    serial:           a.serial              || null,
    created_at:       a["created-at"]       || null,
    size:             a.size                || null,
    hosted_state_download_url: a["hosted-state-download-url"] || null,
    terraform_version: a["terraform-version"] || null,
    modules_detected:  a["modules-detected"]  || null,
    providers_detected: a["providers-detected"] || null,
    resources_processed: a["resources-processed"] || null,
    resource_count:   a["resource-count"]    || 0,
    run_id:           (d.relationships?.run?.data?.id) || null,
  };
}

// ── Variable Operations ────────────────────────────────────────────────────

async function opVarList(args, conn) {
  requireString(args.workspace_id, "workspace_id");
  const res = await tfApiRequest(conn, {
    path: `${API_V2_PREFIX}/workspaces/${encodeURIComponent(args.workspace_id)}/vars`,
    method: "GET",
  });
  checkTfStatus(res, "var_list");
  const json = parseTfJson(res.raw, "var_list");
  const vars = (json.data || []).map(mapVar);
  return { ok: true, operation: "var_list", workspace_id: args.workspace_id, count: vars.length, variables: vars };
}

async function opVarCreate(args, conn) {
  requireString(args.workspace_id, "workspace_id");
  requireString(args.key,          "key");
  const attrs = {
    key:         args.key,
    value:       args.value       || "",
    category:    args.category    || "terraform",
    hcl:         args.hcl        !== undefined ? args.hcl        : false,
    sensitive:   args.sensitive   !== undefined ? args.sensitive  : false,
    description: args.description || "",
  };
  const body = {
    data: {
      type: "vars",
      attributes: attrs,
      relationships: {
        workspace: { data: { type: "workspaces", id: args.workspace_id } },
      },
    },
  };
  const res = await tfApiRequest(conn, { path: `${API_V2_PREFIX}/workspaces/${encodeURIComponent(args.workspace_id)}/vars`, method: "POST", body });
  checkTfStatus(res, "var_create");
  const json = parseTfJson(res.raw, "var_create");
  return { ok: true, operation: "var_create", created: true, ...mapVar(json.data) };
}

async function opVarUpdate(args, conn) {
  requireString(args.workspace_id, "workspace_id");
  requireString(args.var_id,       "var_id");
  const attrs = {};
  if (args.key         !== undefined) attrs.key         = args.key;
  if (args.value       !== undefined) attrs.value       = args.value;
  if (args.hcl        !== undefined)  attrs.hcl         = args.hcl;
  if (args.sensitive   !== undefined) attrs.sensitive   = args.sensitive;
  if (args.description !== undefined) attrs.description = args.description;
  const body = { data: { type: "vars", id: args.var_id, attributes: attrs } };
  const res  = await tfApiRequest(conn, {
    path:   `${API_V2_PREFIX}/workspaces/${encodeURIComponent(args.workspace_id)}/vars/${encodeURIComponent(args.var_id)}`,
    method: "PATCH", body,
  });
  checkTfStatus(res, "var_update");
  const json = parseTfJson(res.raw, "var_update");
  return { ok: true, operation: "var_update", updated: true, ...mapVar(json.data) };
}

async function opVarDelete(args, conn) {
  requireString(args.workspace_id, "workspace_id");
  requireString(args.var_id,       "var_id");
  const res = await tfApiRequest(conn, {
    path:   `${API_V2_PREFIX}/workspaces/${encodeURIComponent(args.workspace_id)}/vars/${encodeURIComponent(args.var_id)}`,
    method: "DELETE",
  });
  if (res.statusCode === 404) return { ok: true, operation: "var_delete", deleted: false, reason: "not_found" };
  checkTfStatus(res, "var_delete");
  return { ok: true, operation: "var_delete", var_id: args.var_id, deleted: true };
}

function mapVar(d) {
  if (!d) return {};
  const a = d.attributes || {};
  return {
    id:          d.id,
    key:         a.key,
    value:       a.sensitive ? "[sensitive]" : (a.value || null),
    sensitive:   a.sensitive  || false,
    hcl:         a.hcl        || false,
    category:    a.category   || null,
    description: a.description || null,
  };
}

// ── Plan Operations ────────────────────────────────────────────────────────

async function opPlanGet(args, conn) {
  requireString(args.plan_id, "plan_id");
  const res = await tfApiRequest(conn, { path: `${API_V2_PREFIX}/plans/${encodeURIComponent(args.plan_id)}`, method: "GET" });
  if (res.statusCode === 404) return { ok: true, operation: "plan_get", plan_id: args.plan_id, exists: false };
  checkTfStatus(res, "plan_get");
  const json = parseTfJson(res.raw, "plan_get");
  const d    = json.data || {};
  const a    = d.attributes || {};
  return {
    ok: true, operation: "plan_get", exists: true,
    id:                      d.id,
    status:                  a.status               || null,
    has_changes:             a["has-changes"]        || false,
    resource_additions:      a["resource-additions"] || 0,
    resource_changes:        a["resource-changes"]   || 0,
    resource_destructions:   a["resource-destructions"] || 0,
    log_read_url:            a["log-read-url"]       || null,
    status_timestamps:       a["status-timestamps"]  || {},
  };
}

async function opPlanLog(args, conn) {
  requireString(args.plan_id, "plan_id");
  // First fetch the plan to get the log URL
  const planRes = await tfApiRequest(conn, { path: `${API_V2_PREFIX}/plans/${encodeURIComponent(args.plan_id)}`, method: "GET" });
  if (planRes.statusCode === 404) return { ok: true, operation: "plan_log", plan_id: args.plan_id, exists: false };
  checkTfStatus(planRes, "plan_log (get plan)");
  const planJson   = parseTfJson(planRes.raw, "plan_log (get plan)");
  const logReadUrl = planJson.data?.attributes?.["log-read-url"];
  if (!logReadUrl)
    return { ok: true, operation: "plan_log", plan_id: args.plan_id, log: null, reason: "no_log_url_yet" };
  // Fetch the log (may be on different host, no auth needed)
  const logRes = await tfHttpRequest({
    url: logReadUrl, method: "GET",
    headers: { "Accept": "text/plain" },
    timeoutMs: conn.timeoutMs, rejectUnauthorized: conn.rejectUnauthorized,
  });
  if (logRes.statusCode !== 200)
    throw new Error(`Terraform plan_log: failed to fetch log (HTTP ${logRes.statusCode})`);
  const max    = args.max_lines ? Math.max(1, Math.min(10000, args.max_lines)) : 1000;
  const lines  = logRes.raw.split("\n");
  const sliced = lines.slice(0, max);
  return {
    ok: true, operation: "plan_log", plan_id: args.plan_id, exists: true,
    total_lines: lines.length, returned_lines: sliced.length,
    truncated: lines.length > max,
    log: sliced.join("\n"),
  };
}

// ── Apply Operations ───────────────────────────────────────────────────────

async function opApplyGet(args, conn) {
  requireString(args.apply_id, "apply_id");
  const res = await tfApiRequest(conn, { path: `${API_V2_PREFIX}/applies/${encodeURIComponent(args.apply_id)}`, method: "GET" });
  if (res.statusCode === 404) return { ok: true, operation: "apply_get", apply_id: args.apply_id, exists: false };
  checkTfStatus(res, "apply_get");
  const json = parseTfJson(res.raw, "apply_get");
  const d    = json.data || {};
  const a    = d.attributes || {};
  return {
    ok: true, operation: "apply_get", exists: true,
    id:                      d.id,
    status:                  a.status                 || null,
    resource_additions:      a["resource-additions"]  || 0,
    resource_changes:        a["resource-changes"]    || 0,
    resource_destructions:   a["resource-destructions"] || 0,
    log_read_url:            a["log-read-url"]         || null,
    status_timestamps:       a["status-timestamps"]   || {},
  };
}

async function opApplyLog(args, conn) {
  requireString(args.apply_id, "apply_id");
  const applyRes = await tfApiRequest(conn, { path: `${API_V2_PREFIX}/applies/${encodeURIComponent(args.apply_id)}`, method: "GET" });
  if (applyRes.statusCode === 404) return { ok: true, operation: "apply_log", apply_id: args.apply_id, exists: false };
  checkTfStatus(applyRes, "apply_log (get apply)");
  const applyJson  = parseTfJson(applyRes.raw, "apply_log (get apply)");
  const logReadUrl = applyJson.data?.attributes?.["log-read-url"];
  if (!logReadUrl)
    return { ok: true, operation: "apply_log", apply_id: args.apply_id, log: null, reason: "no_log_url_yet" };
  const logRes = await tfHttpRequest({
    url: logReadUrl, method: "GET",
    headers: { "Accept": "text/plain" },
    timeoutMs: conn.timeoutMs, rejectUnauthorized: conn.rejectUnauthorized,
  });
  if (logRes.statusCode !== 200)
    throw new Error(`Terraform apply_log: failed to fetch log (HTTP ${logRes.statusCode})`);
  const max    = args.max_lines ? Math.max(1, Math.min(10000, args.max_lines)) : 1000;
  const lines  = logRes.raw.split("\n");
  const sliced = lines.slice(0, max);
  return {
    ok: true, operation: "apply_log", apply_id: args.apply_id, exists: true,
    total_lines: lines.length, returned_lines: sliced.length,
    truncated: lines.length > max,
    log: sliced.join("\n"),
  };
}

// ── Generic request ────────────────────────────────────────────────────────

async function opRequest(args, conn) {
  requireString(args.path,   "path");
  requireString(args.method, "method");
  const validMethods = ["GET", "POST", "PUT", "DELETE", "HEAD", "PATCH"];
  const method = args.method.toUpperCase();
  if (!validMethods.includes(method))
    throw new Error(`method must be one of: ${validMethods.join(", ")}`);
  const body = args.body
    ? (typeof args.body === "string" ? args.body : JSON.stringify(args.body))
    : undefined;
  const res = await tfApiRequest(conn, { path: args.path, method, body });
  let parsedBody;
  const ct = res.headers["content-type"] || "";
  if (ct.includes("json")) {
    try { parsedBody = JSON.parse(res.raw); } catch (_) { parsedBody = res.raw; }
  } else {
    parsedBody = res.raw;
  }
  if (res.statusCode < 200 || res.statusCode >= 300)
    checkTfStatus(res, `request ${method} ${args.path}`);
  return {
    ok: true, operation: "request",
    path: args.path, method,
    status_code: res.statusCode,
    headers: res.headers,
    body: parsedBody,
  };
}

// ── Info ───────────────────────────────────────────────────────────────────

function opInfo() {
  return {
    ok:       true,
    protocol: "Terraform Cloud / Enterprise REST API v2 (HTTPS/JSON:API)",
    default_base_url: TFC_BASE_URL,
    auth:     "API token via 'token' field (Bearer in Authorization header)",
    operations: [
      { op: "org_list",          description: "List all accessible organizations" },
      { op: "org_get",           description: "Get details for an organization" },
      { op: "workspace_list",    description: "List workspaces in an organization" },
      { op: "workspace_get",     description: "Get workspace details (by name+org or workspace_id)" },
      { op: "workspace_create",  description: "Create a new workspace" },
      { op: "workspace_update",  description: "Update workspace settings" },
      { op: "workspace_delete",  description: "Delete a workspace" },
      { op: "workspace_lock",    description: "Lock a workspace (prevents runs)" },
      { op: "workspace_unlock",  description: "Unlock a workspace" },
      { op: "run_list",          description: "List runs for a workspace" },
      { op: "run_get",           description: "Get run details" },
      { op: "run_create",        description: "Queue/trigger a new Terraform run" },
      { op: "run_apply",         description: "Confirm/apply a run that requires confirmation" },
      { op: "run_discard",       description: "Discard a run" },
      { op: "run_cancel",        description: "Cancel an in-progress run" },
      { op: "state_list",        description: "List state versions for a workspace" },
      { op: "state_get",         description: "Get a specific state version" },
      { op: "state_current",     description: "Get the current state version for a workspace" },
      { op: "var_list",          description: "List variables for a workspace" },
      { op: "var_create",        description: "Create a workspace variable" },
      { op: "var_update",        description: "Update a workspace variable" },
      { op: "var_delete",        description: "Delete a workspace variable" },
      { op: "plan_get",          description: "Get plan details" },
      { op: "plan_log",          description: "Fetch plan log output (streamed text)" },
      { op: "apply_get",         description: "Get apply details" },
      { op: "apply_log",         description: "Fetch apply log output (streamed text)" },
      { op: "request",           description: "Generic authenticated request to any TFC/TFE API path" },
      { op: "info",              description: "Return this operation reference (no I/O)" },
    ],
  };
}

// ── Main entry point ───────────────────────────────────────────────────────

async function terraformClient(args) {
  if (args.timeout !== undefined && args.timeout !== null)
    clampInt(args.timeout, DEFAULT_TIMEOUT_MS, 1000, 120000, "timeout");

  const op = (args.operation || "").toLowerCase().replace(/-/g, "_");
  if (op === "info") return opInfo();

  const conn = buildConn(args);
  // Ensure token is present for all non-info ops
  if (!conn.token)
    throw new Error("terraform_client: 'token' is required. Use operation='info' to get the operation reference without credentials.");

  switch (op) {
    // Organizations
    case "org_list": return opOrgList(args, conn);
    case "org_get":  return opOrgGet(args, conn);
    // Workspaces
    case "workspace_list":   return opWorkspaceList(args, conn);
    case "workspace_get":    return opWorkspaceGet(args, conn);
    case "workspace_create": return opWorkspaceCreate(args, conn);
    case "workspace_update": return opWorkspaceUpdate(args, conn);
    case "workspace_delete": return opWorkspaceDelete(args, conn);
    case "workspace_lock":   return opWorkspaceLock(args, conn);
    case "workspace_unlock": return opWorkspaceUnlock(args, conn);
    // Runs
    case "run_list":   return opRunList(args, conn);
    case "run_get":    return opRunGet(args, conn);
    case "run_create": return opRunCreate(args, conn);
    case "run_apply":  return opRunApply(args, conn);
    case "run_discard": return opRunDiscard(args, conn);
    case "run_cancel": return opRunCancel(args, conn);
    // State
    case "state_list":    return opStateList(args, conn);
    case "state_get":     return opStateGet(args, conn);
    case "state_current": return opStateCurrent(args, conn);
    // Variables
    case "var_list":   return opVarList(args, conn);
    case "var_create": return opVarCreate(args, conn);
    case "var_update": return opVarUpdate(args, conn);
    case "var_delete": return opVarDelete(args, conn);
    // Plan
    case "plan_get": return opPlanGet(args, conn);
    case "plan_log": return opPlanLog(args, conn);
    // Apply
    case "apply_get": return opApplyGet(args, conn);
    case "apply_log": return opApplyLog(args, conn);
    // Generic
    case "request": return opRequest(args, conn);
    default:
      throw new Error(
        `Unknown terraform_client operation: '${args.operation}'. ` +
        "Valid: org_list, org_get, workspace_list, workspace_get, workspace_create, " +
        "workspace_update, workspace_delete, workspace_lock, workspace_unlock, " +
        "run_list, run_get, run_create, run_apply, run_discard, run_cancel, " +
        "state_list, state_get, state_current, var_list, var_create, var_update, var_delete, " +
        "plan_get, plan_log, apply_get, apply_log, request, info"
      );
  }
}

module.exports = {
  terraformClient,
  buildConn, requireString, guardString, clampInt,
  parseTfJson, checkTfStatus, tfHttpRequest, tfApiRequest,
  mapOrg, mapWorkspace, mapRun, mapState, mapVar,
  extractPagination,
};
