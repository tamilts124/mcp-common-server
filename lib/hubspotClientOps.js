"use strict";
/**
 * hubspotClientOps.js
 * Zero-dependency HubSpot CRM API v3 client (pure Node.js https; no npm deps).
 * Auth: access_token (private app token or OAuth Bearer).
 * Base URL: https://api.hubapi.com
 * Credentials are scrubbed from all error messages.
 * Response capped at 16 MB; timeout clamped 1–120 s (default 20 s).
 */

const https = require("https");

// ── Constants ─────────────────────────────────────────────────────────────────
const DEFAULT_TIMEOUT   = 20_000;
const MIN_TIMEOUT       = 1_000;
const MAX_TIMEOUT       = 120_000;
const MAX_RESPONSE_BODY = 16 * 1024 * 1024; // 16 MB
const BASE_HOST         = "api.hubapi.com";
const NUL_RE            = /\x00/;

// ── Helpers ───────────────────────────────────────────────────────────────────
function scrubCreds(str, token) {
  let s = String(str);
  if (token) s = s.split(token).join("[access_token]");
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

function optInt(val, name, min, max) {
  if (val == null) return undefined;
  const n = Number(val);
  if (!isFinite(n) || !Number.isInteger(n))
    throw new Error(`${name} must be an integer`);
  if (min != null && n < min) throw new Error(`${name} must be >= ${min}`);
  if (max != null && n > max) throw new Error(`${name} must be <= ${max}`);
  return n;
}

/**
 * Low-level HTTPS request to HubSpot API v3.
 */
function hubRequest({ token, method, path, body, params, timeout, rejectUnauthorized }) {
  return new Promise((resolve, reject) => {
    const ms = clampTimeout(timeout);

    let fullPath = path;
    let bodyStr  = null;

    if ((method === "GET" || method === "DELETE") && params && Object.keys(params).length) {
      const qs = Object.entries(params)
        .filter(([, v]) => v != null)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join("&");
      if (qs) fullPath = `${fullPath}?${qs}`;
    } else if (body != null) {
      bodyStr = JSON.stringify(body);
    }

    const headers = {
      "Authorization": `Bearer ${token}`,
      "Accept":        "application/json",
      "User-Agent":    "mcp-common-server/hubspot_client",
    };
    if (bodyStr) {
      headers["Content-Type"]   = "application/json";
      headers["Content-Length"] = Buffer.byteLength(bodyStr);
    }

    const options = {
      hostname:           BASE_HOST,
      port:               443,
      path:               fullPath,
      method:             method || "GET",
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
        if (!raw.trim()) { resolve({ status, body: null }); return; }
        let parsed;
        try { parsed = JSON.parse(raw); } catch (_) { parsed = { _raw: raw }; }
        resolve({ status, body: parsed });
      });
      res.on("error", (err) => {
        clearTimeout(timer);
        reject(new Error(scrubCreds(err.message, token)));
      });
    });

    timer = setTimeout(() => {
      reject(new Error(`HubSpot request timed out after ${ms} ms`));
      req.destroy();
    }, ms);

    req.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(scrubCreds(err.message, token)));
    });

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function hubReq(ctx, method, path, body, params, allowedStatuses) {
  const res = await hubRequest({
    token:              ctx.token,
    method, path, body, params,
    timeout:            ctx.timeout,
    rejectUnauthorized: ctx.rejectUnauthorized,
  });
  const ok = allowedStatuses
    ? allowedStatuses.includes(res.status)
    : res.status >= 200 && res.status < 300;
  if (!ok) {
    const errBody = res.body ? JSON.stringify(res.body) : "(empty)";
    const scrubbed = scrubCreds(errBody, ctx.token);
    throw new Error(`HubSpot API error ${res.status}: ${scrubbed}`);
  }
  return res;
}

function buildCtx(args) {
  const token = requireString(args.access_token, "access_token");
  return {
    token,
    timeout:            args.timeout,
    rejectUnauthorized: args.reject_unauthorized,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CRM OBJECTS — generic CRUD for contacts, companies, deals, tickets, etc.
// ═══════════════════════════════════════════════════════════════════════════════

const VALID_OBJECTS = new Set([
  "contacts", "companies", "deals", "tickets", "products",
  "line_items", "quotes", "calls", "emails", "meetings", "notes", "tasks",
]);

function requireObjectType(val) {
  const t = requireString(val, "object_type");
  if (!VALID_OBJECTS.has(t))
    throw new Error(`object_type must be one of: ${[...VALID_OBJECTS].join(", ")}`);
  return t;
}

async function crmCreate(ctx, args) {
  const obj    = requireObjectType(args.object_type);
  const props  = args.properties;
  if (!props || typeof props !== "object" || Array.isArray(props))
    throw new Error("properties (object) is required for crm_create");
  const body = { properties: props };
  if (args.associations) body.associations = args.associations;
  const res = await hubReq(ctx, "POST", `/crm/v3/objects/${obj}`, body, null, [201]);
  return res.body;
}

async function crmGet(ctx, args) {
  const obj = requireObjectType(args.object_type);
  if (args.object_id == null) throw new Error("object_id is required and must be a non-empty string");
  const id  = requireString(String(args.object_id), "object_id");
  const params = {};
  if (args.properties)         params.properties         = Array.isArray(args.properties) ? args.properties.join(",") : args.properties;
  if (args.properties_with_history) params.propertiesWithHistory = Array.isArray(args.properties_with_history) ? args.properties_with_history.join(",") : args.properties_with_history;
  if (args.associations)       params.associations       = Array.isArray(args.associations) ? args.associations.join(",") : args.associations;
  if (args.archived != null)   params.archived           = args.archived;
  const res = await hubReq(ctx, "GET", `/crm/v3/objects/${obj}/${encodeURIComponent(id)}`,
    null, Object.keys(params).length ? params : null, [200, 404]);
  if (res.status === 404) return { exists: false, object_id: id, object_type: obj };
  return res.body;
}

async function crmList(ctx, args) {
  const obj = requireObjectType(args.object_type);
  const params = {};
  if (args.limit)      params.limit      = Math.min(100, Math.max(1, Number(args.limit)));
  if (args.after)      params.after      = args.after;
  if (args.properties) params.properties = Array.isArray(args.properties) ? args.properties.join(",") : args.properties;
  if (args.archived != null) params.archived = args.archived;
  const res = await hubReq(ctx, "GET", `/crm/v3/objects/${obj}`,
    null, Object.keys(params).length ? params : null, [200]);
  return res.body;
}

async function crmUpdate(ctx, args) {
  const obj  = requireObjectType(args.object_type);
  if (args.object_id == null) throw new Error("object_id is required and must be a non-empty string");
  const id   = requireString(String(args.object_id), "object_id");
  const props = args.properties;
  if (!props || typeof props !== "object" || Array.isArray(props))
    throw new Error("properties (object) is required for crm_update");
  const res = await hubReq(ctx, "PATCH", `/crm/v3/objects/${obj}/${encodeURIComponent(id)}`,
    { properties: props }, null, [200]);
  return res.body;
}

async function crmDelete(ctx, args) {
  const obj = requireObjectType(args.object_type);
  if (args.object_id == null) throw new Error("object_id is required and must be a non-empty string");
  const id  = requireString(String(args.object_id), "object_id");
  const res = await hubReq(ctx, "DELETE", `/crm/v3/objects/${obj}/${encodeURIComponent(id)}`,
    null, null, [204, 404]);
  if (res.status === 404) return { deleted: false, object_id: id };
  return { deleted: true, object_id: id };
}

async function crmSearch(ctx, args) {
  const obj = requireObjectType(args.object_type);
  const body = {};
  if (args.filters)       body.filterGroups = [{ filters: args.filters }];
  if (args.filter_groups) body.filterGroups = args.filter_groups;
  if (args.sorts)         body.sorts        = args.sorts;
  if (args.properties)    body.properties   = args.properties;
  if (args.limit)         body.limit        = Math.min(100, Math.max(1, Number(args.limit)));
  if (args.after)         body.after        = args.after;
  if (args.query)         body.query        = args.query;
  const res = await hubReq(ctx, "POST", `/crm/v3/objects/${obj}/search`, body, null, [200]);
  return res.body;
}

async function crmBatchCreate(ctx, args) {
  const obj    = requireObjectType(args.object_type);
  const inputs = args.inputs;
  if (!Array.isArray(inputs) || !inputs.length)
    throw new Error("inputs (array of {properties} objects) is required for crm_batch_create");
  const res = await hubReq(ctx, "POST", `/crm/v3/objects/${obj}/batch/create`,
    { inputs }, null, [201]);
  return res.body;
}

async function crmBatchRead(ctx, args) {
  const obj       = requireObjectType(args.object_type);
  const inputs    = args.inputs;
  if (!Array.isArray(inputs) || !inputs.length)
    throw new Error("inputs (array of {id} objects) is required for crm_batch_read");
  const body = { inputs };
  if (args.properties) body.properties = args.properties;
  const res = await hubReq(ctx, "POST", `/crm/v3/objects/${obj}/batch/read`,
    body, null, [200]);
  return res.body;
}

async function crmBatchUpdate(ctx, args) {
  const obj    = requireObjectType(args.object_type);
  const inputs = args.inputs;
  if (!Array.isArray(inputs) || !inputs.length)
    throw new Error("inputs (array of {id, properties} objects) is required for crm_batch_update");
  const res = await hubReq(ctx, "POST", `/crm/v3/objects/${obj}/batch/update`,
    { inputs }, null, [200]);
  return res.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ASSOCIATIONS
// ═══════════════════════════════════════════════════════════════════════════════

async function associationCreate(ctx, args) {
  const fromObj = requireString(args.from_object_type, "from_object_type");
  if (args.from_object_id == null) throw new Error("from_object_id is required and must be a non-empty string");
  const fromId  = requireString(String(args.from_object_id), "from_object_id");
  const toObj   = requireString(args.to_object_type, "to_object_type");
  if (args.to_object_id == null) throw new Error("to_object_id is required and must be a non-empty string");
  const toId    = requireString(String(args.to_object_id), "to_object_id");
  const assocType = requireString(args.association_type, "association_type");
  const path = `/crm/v4/objects/${encodeURIComponent(fromObj)}/${encodeURIComponent(fromId)}/associations/${encodeURIComponent(toObj)}/${encodeURIComponent(toId)}`;
  const res = await hubReq(ctx, "PUT", path,
    [{ associationCategory: args.association_category || "HUBSPOT_DEFINED", associationTypeId: assocType }],
    null, [200, 201]);
  return res.body || { associated: true };
}

async function associationList(ctx, args) {
  const fromObj = requireString(args.from_object_type, "from_object_type");
  const fromId  = requireString(String(args.from_object_id), "from_object_id");
  const toObj   = requireString(args.to_object_type, "to_object_type");
  const params = {};
  if (args.limit) params.limit = Math.min(500, Math.max(1, Number(args.limit)));
  if (args.after) params.after = args.after;
  const path = `/crm/v4/objects/${encodeURIComponent(fromObj)}/${encodeURIComponent(fromId)}/associations/${encodeURIComponent(toObj)}`;
  const res = await hubReq(ctx, "GET", path,
    null, Object.keys(params).length ? params : null, [200]);
  return res.body;
}

async function associationDelete(ctx, args) {
  const fromObj = requireString(args.from_object_type, "from_object_type");
  const fromId  = requireString(String(args.from_object_id), "from_object_id");
  const toObj   = requireString(args.to_object_type, "to_object_type");
  const toId    = requireString(String(args.to_object_id), "to_object_id");
  const assocType = requireString(args.association_type, "association_type");
  const path = `/crm/v4/objects/${encodeURIComponent(fromObj)}/${encodeURIComponent(fromId)}/associations/${encodeURIComponent(toObj)}/${encodeURIComponent(toId)}`;
  const res = await hubReq(ctx, "DELETE", path,
    [{ associationCategory: args.association_category || "HUBSPOT_DEFINED", associationTypeId: assocType }],
    null, [204]);
  return { deleted: true, from_object_id: fromId, to_object_id: toId };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROPERTIES
// ═══════════════════════════════════════════════════════════════════════════════

async function propertyList(ctx, args) {
  const obj = requireObjectType(args.object_type);
  const params = {};
  if (args.archived != null)    params.archived    = args.archived;
  if (args.properties)          params.properties  = args.properties;
  const res = await hubReq(ctx, "GET", `/crm/v3/properties/${encodeURIComponent(obj)}`,
    null, Object.keys(params).length ? params : null, [200]);
  return res.body;
}

async function propertyGet(ctx, args) {
  const obj       = requireObjectType(args.object_type);
  const propName  = requireString(args.property_name, "property_name");
  const res = await hubReq(ctx, "GET",
    `/crm/v3/properties/${encodeURIComponent(obj)}/${encodeURIComponent(propName)}`,
    null, null, [200, 404]);
  if (res.status === 404) return { exists: false, property_name: propName };
  return res.body;
}

async function propertyCreate(ctx, args) {
  const obj   = requireObjectType(args.object_type);
  const name  = requireString(args.name, "name");
  const label = requireString(args.label, "label");
  const type  = requireString(args.type, "type");
  const fieldType = requireString(args.field_type, "field_type");
  const groupName = requireString(args.group_name, "group_name");
  const body = { name, label, type, fieldType, groupName };
  if (args.description)   body.description   = args.description;
  if (args.options)       body.options       = args.options;
  if (args.display_order != null) body.displayOrder = args.display_order;
  if (args.hidden != null)        body.hidden       = args.hidden;
  const res = await hubReq(ctx, "POST",
    `/crm/v3/properties/${encodeURIComponent(obj)}`, body, null, [201]);
  return res.body;
}

async function propertyUpdate(ctx, args) {
  const obj      = requireObjectType(args.object_type);
  const propName = requireString(args.property_name, "property_name");
  const body = {};
  if (args.label)       body.label       = args.label;
  if (args.description) body.description = args.description;
  if (args.options)     body.options     = args.options;
  if (args.hidden != null) body.hidden   = args.hidden;
  const res = await hubReq(ctx, "PATCH",
    `/crm/v3/properties/${encodeURIComponent(obj)}/${encodeURIComponent(propName)}`,
    body, null, [200]);
  return res.body;
}

async function propertyDelete(ctx, args) {
  const obj      = requireObjectType(args.object_type);
  const propName = requireString(args.property_name, "property_name");
  const res = await hubReq(ctx, "DELETE",
    `/crm/v3/properties/${encodeURIComponent(obj)}/${encodeURIComponent(propName)}`,
    null, null, [204, 404]);
  if (res.status === 404) return { deleted: false, property_name: propName };
  return { deleted: true, property_name: propName };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PIPELINES
// ═══════════════════════════════════════════════════════════════════════════════

async function pipelineList(ctx, args) {
  const obj = requireString(args.object_type, "object_type");
  const res = await hubReq(ctx, "GET",
    `/crm/v3/pipelines/${encodeURIComponent(obj)}`, null, null, [200]);
  return res.body;
}

async function pipelineGet(ctx, args) {
  const obj        = requireString(args.object_type, "object_type");
  const pipelineId = requireString(args.pipeline_id, "pipeline_id");
  const res = await hubReq(ctx, "GET",
    `/crm/v3/pipelines/${encodeURIComponent(obj)}/${encodeURIComponent(pipelineId)}`,
    null, null, [200, 404]);
  if (res.status === 404) return { exists: false, pipeline_id: pipelineId };
  return res.body;
}

async function pipelineStageList(ctx, args) {
  const obj        = requireString(args.object_type, "object_type");
  const pipelineId = requireString(args.pipeline_id, "pipeline_id");
  const res = await hubReq(ctx, "GET",
    `/crm/v3/pipelines/${encodeURIComponent(obj)}/${encodeURIComponent(pipelineId)}/stages`,
    null, null, [200]);
  return res.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// OWNERS
// ═══════════════════════════════════════════════════════════════════════════════

async function ownerList(ctx, args) {
  const params = {};
  if (args.email)      params.email   = args.email;
  if (args.limit)      params.limit   = Math.min(500, Math.max(1, Number(args.limit)));
  if (args.after)      params.after   = args.after;
  if (args.archived != null) params.archived = args.archived;
  const res = await hubReq(ctx, "GET", "/crm/v3/owners",
    null, Object.keys(params).length ? params : null, [200]);
  return res.body;
}

async function ownerGet(ctx, args) {
  const ownerId = requireString(String(args.owner_id), "owner_id");
  const res = await hubReq(ctx, "GET",
    `/crm/v3/owners/${encodeURIComponent(ownerId)}`, null, null, [200, 404]);
  if (res.status === 404) return { exists: false, owner_id: ownerId };
  return res.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TIMELINE EVENTS
// ═══════════════════════════════════════════════════════════════════════════════

async function timelineEventCreate(ctx, args) {
  const eventTemplateId = requireString(args.event_template_id, "event_template_id");
  const objectId        = requireString(String(args.object_id), "object_id");
  const appId           = requireString(String(args.app_id), "app_id");
  const body = { eventTemplateId, objectId, tokens: args.tokens || {}, extraData: args.extra_data };
  if (args.timestamp)    body.timestamp    = args.timestamp;
  if (args.domain)       body.domain       = args.domain;
  if (args.id)           body.id           = args.id;
  const res = await hubReq(ctx, "POST",
    `/crm/v3/timeline/events`, body, null, [201, 200]);
  return res.body || { created: true };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONTACTS — convenience wrappers
// ═══════════════════════════════════════════════════════════════════════════════

async function contactCreate(ctx, args) {
  const props = {};
  if (args.email)       props.email       = args.email;
  if (args.firstname)   props.firstname   = args.firstname;
  if (args.lastname)    props.lastname    = args.lastname;
  if (args.phone)       props.phone       = args.phone;
  if (args.company)     props.company     = args.company;
  if (args.website)     props.website     = args.website;
  if (args.jobtitle)    props.jobtitle    = args.jobtitle;
  if (args.properties)  Object.assign(props, args.properties);
  if (!Object.keys(props).length)
    throw new Error("At least one contact property (email, firstname, lastname, etc.) is required");
  const body = { properties: props };
  if (args.associations) body.associations = args.associations;
  const res = await hubReq(ctx, "POST", "/crm/v3/objects/contacts", body, null, [201]);
  return res.body;
}

async function contactGetByEmail(ctx, args) {
  const email = requireString(args.email, "email");
  const body = {
    filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
    properties: args.properties || ["email", "firstname", "lastname", "phone", "company"],
    limit: 1,
  };
  const res = await hubReq(ctx, "POST", "/crm/v3/objects/contacts/search", body, null, [200]);
  const results = res.body?.results || [];
  if (!results.length) return { exists: false, email };
  return results[0];
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEALS — convenience wrappers
// ═══════════════════════════════════════════════════════════════════════════════

async function dealCreate(ctx, args) {
  const dealname = requireString(args.dealname, "dealname");
  const props = { dealname };
  if (args.amount)       props.amount       = String(args.amount);
  if (args.dealstage)    props.dealstage    = args.dealstage;
  if (args.pipeline)     props.pipeline     = args.pipeline;
  if (args.closedate)    props.closedate    = args.closedate;
  if (args.hubspot_owner_id) props.hubspot_owner_id = String(args.hubspot_owner_id);
  if (args.properties)   Object.assign(props, args.properties);
  const body = { properties: props };
  if (args.associations) body.associations = args.associations;
  const res = await hubReq(ctx, "POST", "/crm/v3/objects/deals", body, null, [201]);
  return res.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPANIES — convenience wrappers
// ═══════════════════════════════════════════════════════════════════════════════

async function companyCreate(ctx, args) {
  const name = requireString(args.name, "name");
  const props = { name };
  if (args.domain)       props.domain       = args.domain;
  if (args.industry)     props.industry     = args.industry;
  if (args.phone)        props.phone        = args.phone;
  if (args.city)         props.city         = args.city;
  if (args.country)      props.country      = args.country;
  if (args.properties)   Object.assign(props, args.properties);
  const body = { properties: props };
  if (args.associations) body.associations = args.associations;
  const res = await hubReq(ctx, "POST", "/crm/v3/objects/companies", body, null, [201]);
  return res.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GENERIC REQUEST
// ═══════════════════════════════════════════════════════════════════════════════

async function genericRequest(ctx, args) {
  const method = requireString(args.method, "method").toUpperCase();
  const path   = requireString(args.path, "path");
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method))
    throw new Error(`Unsupported method: ${method}`);
  const body   = (method !== "GET" && method !== "DELETE") ? (args.body   ?? {}) : null;
  const params = (method === "GET"  || method === "DELETE") ? (args.params ?? null) : null;
  const res = await hubReq(ctx, method, path, body, params);
  return res.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN DISPATCHER
// ═══════════════════════════════════════════════════════════════════════════════

async function hubspotClient(args) {
  const op  = requireString(args.operation, "operation");
  const ctx = buildCtx(args);

  switch (op) {
    // Generic CRM object CRUD
    case "crm_create":        return crmCreate(ctx, args);
    case "crm_get":           return crmGet(ctx, args);
    case "crm_list":          return crmList(ctx, args);
    case "crm_update":        return crmUpdate(ctx, args);
    case "crm_delete":        return crmDelete(ctx, args);
    case "crm_search":        return crmSearch(ctx, args);
    case "crm_batch_create":  return crmBatchCreate(ctx, args);
    case "crm_batch_read":    return crmBatchRead(ctx, args);
    case "crm_batch_update":  return crmBatchUpdate(ctx, args);
    // Associations
    case "association_create": return associationCreate(ctx, args);
    case "association_list":   return associationList(ctx, args);
    case "association_delete": return associationDelete(ctx, args);
    // Properties
    case "property_list":     return propertyList(ctx, args);
    case "property_get":      return propertyGet(ctx, args);
    case "property_create":   return propertyCreate(ctx, args);
    case "property_update":   return propertyUpdate(ctx, args);
    case "property_delete":   return propertyDelete(ctx, args);
    // Pipelines
    case "pipeline_list":     return pipelineList(ctx, args);
    case "pipeline_get":      return pipelineGet(ctx, args);
    case "pipeline_stage_list": return pipelineStageList(ctx, args);
    // Owners
    case "owner_list":        return ownerList(ctx, args);
    case "owner_get":         return ownerGet(ctx, args);
    // Timeline
    case "timeline_event_create": return timelineEventCreate(ctx, args);
    // Convenience wrappers
    case "contact_create":        return contactCreate(ctx, args);
    case "contact_get_by_email":  return contactGetByEmail(ctx, args);
    case "deal_create":           return dealCreate(ctx, args);
    case "company_create":        return companyCreate(ctx, args);
    // Generic
    case "request":           return genericRequest(ctx, args);
    default:
      throw new Error(
        `Unknown operation: ${op}. Supported: crm_create, crm_get, crm_list, crm_update, ` +
        `crm_delete, crm_search, crm_batch_create, crm_batch_read, crm_batch_update, ` +
        `association_create, association_list, association_delete, ` +
        `property_list, property_get, property_create, property_update, property_delete, ` +
        `pipeline_list, pipeline_get, pipeline_stage_list, ` +
        `owner_list, owner_get, timeline_event_create, ` +
        `contact_create, contact_get_by_email, deal_create, company_create, request`
      );
  }
}

module.exports = { hubspotClient };
