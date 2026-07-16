"use strict";
/**
 * sendgridClientOps.js
 * Zero-dependency SendGrid Web API v3 client (pure Node.js https built-ins; no npm deps).
 * Auth: api_key (Authorization: Bearer SG.*)
 * Base URL: https://api.sendgrid.com/v3
 * All credentials are scrubbed from error messages.
 * Response capped at 16 MB; timeout clamped 1–120 s (default 20 s).
 */

const https = require("https");

// ── Constants ────────────────────────────────────────────────────────────────
const DEFAULT_TIMEOUT   = 20_000;
const MIN_TIMEOUT       = 1_000;
const MAX_TIMEOUT       = 120_000;
const MAX_RESPONSE_BODY = 16 * 1024 * 1024; // 16 MB
const API_HOSTNAME      = "api.sendgrid.com";
const NUL_RE            = /\x00/;

// ── Helpers ──────────────────────────────────────────────────────────────────
function scrubCreds(str, apiKey) {
  let s = String(str);
  if (apiKey) s = s.split(apiKey).join("[api_key]");
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
 * Low-level HTTPS request to SendGrid REST API v3.
 * SendGrid uses Bearer token auth and JSON bodies.
 */
function sgRequest({
  apiKey, method, path, body, params, timeout, rejectUnauthorized,
}) {
  return new Promise((resolve, reject) => {
    const ms = clampTimeout(timeout);

    let fullPath = `/v3${path}`;
    let bodyStr  = null;

    // Build query string for GET/DELETE
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
      Authorization:  `Bearer ${apiKey}`,
      Accept:         "application/json",
      "User-Agent":   "mcp-common-server/sendgrid_client",
    };
    if (bodyStr) {
      headers["Content-Type"]   = "application/json";
      headers["Content-Length"] = Buffer.byteLength(bodyStr);
    }

    const options = {
      hostname:           API_HOSTNAME,
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
        reject(new Error(scrubCreds(err.message, apiKey)));
      });
    });

    timer = setTimeout(() => {
      reject(new Error(`SendGrid request timed out after ${ms} ms`));
      req.destroy();
    }, ms);

    req.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(scrubCreds(err.message, apiKey)));
    });

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function sgReq(ctx, method, path, body, params, allowedStatuses) {
  const res = await sgRequest({
    apiKey:             ctx.apiKey,
    method, path, body, params,
    timeout:            ctx.timeout,
    rejectUnauthorized: ctx.rejectUnauthorized,
  });
  const ok = allowedStatuses
    ? allowedStatuses.includes(res.status)
    : res.status >= 200 && res.status < 300;
  if (!ok) {
    const errBody = res.body
      ? JSON.stringify(res.body)
      : "(empty)";
    const scrubbed = scrubCreds(errBody, ctx.apiKey);
    throw new Error(`SendGrid API error ${res.status}: ${scrubbed}`);
  }
  return res;
}

function buildCtx(args) {
  const apiKey = requireString(args.api_key, "api_key");
  if (!apiKey.startsWith("SG."))
    throw new Error("api_key must start with 'SG.' (SendGrid API key)");
  return {
    apiKey,
    timeout:            args.timeout,
    rejectUnauthorized: args.reject_unauthorized,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// EMAIL SEND
// ═══════════════════════════════════════════════════════════════════════════════

function buildPersonalization(args) {
  // Build the personalizations array for the /mail/send endpoint
  const to = args.to;
  let toArr;
  if (typeof to === "string") {
    toArr = [{ email: to }];
  } else if (Array.isArray(to)) {
    toArr = to.map(t => typeof t === "string" ? { email: t } : t);
  } else if (to && typeof to === "object") {
    toArr = [to];
  } else {
    throw new Error("to is required (string, {email, name}, or array)");
  }

  const p = { to: toArr };
  if (args.cc) {
    const ccArr = Array.isArray(args.cc) ? args.cc : [args.cc];
    p.cc = ccArr.map(c => typeof c === "string" ? { email: c } : c);
  }
  if (args.bcc) {
    const bccArr = Array.isArray(args.bcc) ? args.bcc : [args.bcc];
    p.bcc = bccArr.map(c => typeof c === "string" ? { email: c } : c);
  }
  if (args.subject) p.subject = args.subject; // per-personalization override
  if (args.dynamic_template_data) p.dynamic_template_data = args.dynamic_template_data;
  if (args.substitutions) p.substitutions = args.substitutions;
  if (args.headers) p.headers = args.headers;
  return [p];
}

async function mailSend(ctx, args) {
  const personalizations = buildPersonalization(args);

  // from
  let from;
  if (typeof args.from === "string") {
    from = { email: args.from };
  } else if (args.from && typeof args.from === "object") {
    from = args.from;
  } else {
    throw new Error("from is required (string email or {email, name})");
  }

  const body = { personalizations, from };

  // subject — required unless using a template
  if (args.subject) body.subject = args.subject;
  else if (!args.template_id) throw new Error("subject or template_id is required");

  // content
  if (args.text) {
    body.content = body.content || [];
    body.content.push({ type: "text/plain", value: args.text });
  }
  if (args.html) {
    body.content = body.content || [];
    body.content.push({ type: "text/html", value: args.html });
  }
  if (args.content) {
    body.content = args.content; // full [{type, value}] array
  }

  // template
  if (args.template_id) body.template_id = args.template_id;

  // reply_to
  if (args.reply_to) {
    body.reply_to = typeof args.reply_to === "string"
      ? { email: args.reply_to }
      : args.reply_to;
  }

  // optional fields
  if (args.attachments)      body.attachments      = args.attachments;
  if (args.categories)       body.categories       = Array.isArray(args.categories) ? args.categories : [args.categories];
  if (args.custom_args)      body.custom_args      = args.custom_args;
  if (args.send_at != null)  body.send_at          = args.send_at;
  if (args.batch_id)         body.batch_id         = args.batch_id;
  if (args.unsubscribe_group_id) {
    body.asm = { group_id: args.unsubscribe_group_id };
    if (args.groups_to_display) body.asm.groups_to_display = args.groups_to_display;
  }
  if (args.ip_pool_name) body.ip_pool_name = args.ip_pool_name;
  if (args.mail_settings) body.mail_settings = args.mail_settings;
  if (args.tracking_settings) body.tracking_settings = args.tracking_settings;

  // Content check: must have content or template_id
  if (!body.content && !body.template_id)
    throw new Error("text, html, content, or template_id is required");

  const res = await sgReq(ctx, "POST", "/mail/send", body, null, [200, 202]);
  const messageId = res.body?.message_id ||
    (res.status === 202 ? "queued" : undefined);
  return {
    sent:       true,
    status:     res.status,
    message_id: messageId,
    to:         personalizations[0].to.map(t => t.email).join(", "),
    from:       from.email,
    subject:    body.subject || "(template)",
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONTACTS (Marketing Contacts v3)
// ═══════════════════════════════════════════════════════════════════════════════

async function contactUpsert(ctx, args) {
  // PUT /marketing/contacts
  if (!Array.isArray(args.contacts) || !args.contacts.length)
    throw new Error("contacts (array of contact objects) is required");
  const body = { contacts: args.contacts };
  if (args.list_ids) body.list_ids = args.list_ids;
  const res = await sgReq(ctx, "PUT", "/marketing/contacts", body, null, [200, 202]);
  return res.body ?? { queued: true };
}

async function contactSearch(ctx, args) {
  // POST /marketing/contacts/search
  const query = requireString(args.query, "query"); // SGQL query
  const res = await sgReq(ctx, "POST", "/marketing/contacts/search",
    { query }, null, [200]);
  return res.body;
}

async function contactGet(ctx, args) {
  // GET /marketing/contacts/{id}
  const id = requireString(args.contact_id, "contact_id");
  const res = await sgReq(ctx, "GET", `/marketing/contacts/${encodeURIComponent(id)}`,
    null, null, [200, 404]);
  if (res.status === 404) return { exists: false, contact_id: id };
  return res.body;
}

async function contactDelete(ctx, args) {
  // DELETE /marketing/contacts?ids=...
  const ids = args.ids;
  if (!ids) throw new Error("ids (array of contact IDs or string 'all_active_contacts') is required");
  const params = {};
  if (ids === "all_active_contacts") {
    params.delete_all_contacts = true;
  } else {
    const idArr = Array.isArray(ids) ? ids : [ids];
    params.ids = idArr.join(",");
  }
  const res = await sgReq(ctx, "DELETE", "/marketing/contacts", null, params, [200, 202, 404]);
  if (res.status === 404) return { deleted: false };
  return res.body ?? { queued: true };
}

async function contactCount(ctx, _args) {
  // GET /marketing/contacts/count
  const res = await sgReq(ctx, "GET", "/marketing/contacts/count", null, null, [200]);
  return res.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// LISTS (Marketing Contact Lists)
// ═══════════════════════════════════════════════════════════════════════════════

async function listCreate(ctx, args) {
  const name = requireString(args.name, "name");
  const res = await sgReq(ctx, "POST", "/marketing/lists", { name }, null, [200]);
  return res.body;
}

async function listGet(ctx, args) {
  const id = requireString(args.list_id, "list_id");
  const params = {};
  if (args.contact_sample != null) params.contact_sample = args.contact_sample;
  const res = await sgReq(ctx, "GET", `/marketing/lists/${encodeURIComponent(id)}`,
    null, Object.keys(params).length ? params : null, [200, 404]);
  if (res.status === 404) return { exists: false, list_id: id };
  return res.body;
}

async function listGetAll(ctx, args) {
  const params = {};
  if (args.page_size)   params.page_size   = Math.min(1000, Math.max(1, Number(args.page_size)));
  if (args.page_token)  params.page_token  = args.page_token;
  const res = await sgReq(ctx, "GET", "/marketing/lists", null,
    Object.keys(params).length ? params : null, [200]);
  return res.body;
}

async function listUpdate(ctx, args) {
  const id   = requireString(args.list_id, "list_id");
  const name = requireString(args.name,    "name");
  const res = await sgReq(ctx, "PATCH", `/marketing/lists/${encodeURIComponent(id)}`,
    { name }, null, [200]);
  return res.body;
}

async function listDelete(ctx, args) {
  const id = requireString(args.list_id, "list_id");
  const params = {};
  if (args.delete_contacts != null) params.delete_contacts = args.delete_contacts;
  const res = await sgReq(ctx, "DELETE", `/marketing/lists/${encodeURIComponent(id)}`,
    null, Object.keys(params).length ? params : null, [200, 202, 404]);
  if (res.status === 404) return { deleted: false, list_id: id };
  return res.body ?? { queued: true };
}

async function listAddContacts(ctx, args) {
  const id      = requireString(args.list_id, "list_id");
  const contact_ids = args.contact_ids;
  if (!Array.isArray(contact_ids) || !contact_ids.length)
    throw new Error("contact_ids (array) is required");
  const res = await sgReq(ctx, "POST",
    `/marketing/lists/${encodeURIComponent(id)}/contacts`, { contact_ids }, null, [200]);
  return res.body;
}

async function listRemoveContacts(ctx, args) {
  const id          = requireString(args.list_id, "list_id");
  const contact_ids = args.contact_ids;
  if (!Array.isArray(contact_ids) || !contact_ids.length)
    throw new Error("contact_ids (array) is required");
  const params = { contact_ids: contact_ids.join(",") };
  const res = await sgReq(ctx, "DELETE",
    `/marketing/lists/${encodeURIComponent(id)}/contacts`, null, params, [200, 202]);
  return res.body ?? { queued: true };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEMPLATES (Dynamic Transactional Templates)
// ═══════════════════════════════════════════════════════════════════════════════

async function templateCreate(ctx, args) {
  const name = requireString(args.name, "name");
  const generation = optStr(args.generation, "generation") ?? "dynamic";
  const res = await sgReq(ctx, "POST", "/templates",
    { name, generation }, null, [200, 201]);
  return res.body;
}

async function templateGet(ctx, args) {
  const id = requireString(args.template_id, "template_id");
  const params = {};
  if (args.versions_summaries != null) params.versions_summaries = args.versions_summaries;
  const res = await sgReq(ctx, "GET", `/templates/${encodeURIComponent(id)}`,
    null, Object.keys(params).length ? params : null, [200, 404]);
  if (res.status === 404) return { exists: false, template_id: id };
  return res.body;
}

async function templateList(ctx, args) {
  const params = {};
  if (args.generations) params.generations = Array.isArray(args.generations) ? args.generations.join(",") : args.generations;
  if (args.page_size)   params.page_size   = Math.min(200, Math.max(1, Number(args.page_size)));
  if (args.page_token)  params.page_token  = args.page_token;
  const res = await sgReq(ctx, "GET", "/templates", null,
    Object.keys(params).length ? params : null, [200]);
  return res.body;
}

async function templateDelete(ctx, args) {
  const id = requireString(args.template_id, "template_id");
  const res = await sgReq(ctx, "DELETE", `/templates/${encodeURIComponent(id)}`,
    null, null, [204, 404]);
  if (res.status === 404) return { deleted: false, template_id: id };
  return { deleted: true, template_id: id };
}

async function templateVersionCreate(ctx, args) {
  const template_id = requireString(args.template_id, "template_id");
  const name        = requireString(args.name, "name");
  const body = { name };
  if (args.subject)       body.subject       = args.subject;
  if (args.html_content)  body.html_content  = args.html_content;
  if (args.plain_content) body.plain_content = args.plain_content;
  if (args.generate_plain_content != null) body.generate_plain_content = args.generate_plain_content;
  if (args.active != null) body.active       = args.active;
  if (args.editor)        body.editor        = args.editor;
  if (args.test_data)     body.test_data     = args.test_data;
  const res = await sgReq(ctx, "POST",
    `/templates/${encodeURIComponent(template_id)}/versions`, body, null, [200, 201]);
  return res.body;
}

async function templateVersionActivate(ctx, args) {
  const template_id = requireString(args.template_id, "template_id");
  const version_id  = requireString(args.version_id,  "version_id");
  const res = await sgReq(ctx, "POST",
    `/templates/${encodeURIComponent(template_id)}/versions/${encodeURIComponent(version_id)}/activate`,
    {}, null, [200]);
  return res.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SUPPRESSIONS (Unsubscribes, Bounces, Spam Reports, Blocks, Invalid Emails)
// ═══════════════════════════════════════════════════════════════════════════════

async function suppressionGet(ctx, args) {
  const type  = requireString(args.suppression_type, "suppression_type");
  const endpoint = suppressionEndpoint(type);
  const params = {};
  if (args.start_time != null) params.start_time = args.start_time;
  if (args.end_time   != null) params.end_time   = args.end_time;
  if (args.limit      != null) params.limit      = Math.min(500, Math.max(1, Number(args.limit)));
  if (args.offset     != null) params.offset     = Math.max(0, Number(args.offset));
  const res = await sgReq(ctx, "GET", endpoint, null,
    Object.keys(params).length ? params : null, [200]);
  return res.body;
}

async function suppressionDelete(ctx, args) {
  const type  = requireString(args.suppression_type, "suppression_type");
  const email = requireString(args.email, "email");
  const endpoint = suppressionEndpoint(type);
  const res = await sgReq(ctx, "DELETE", `${endpoint}/${encodeURIComponent(email)}`,
    null, null, [204, 404]);
  if (res.status === 404) return { deleted: false, email };
  return { deleted: true, email };
}

function suppressionEndpoint(type) {
  const map = {
    unsubscribes:    "/suppression/unsubscribes",
    global_unsubscribes: "/asm/suppressions/global",
    bounces:         "/suppression/bounces",
    spam_reports:    "/suppression/spam_reports",
    blocks:          "/suppression/blocks",
    invalid_emails:  "/suppression/invalid_emails",
  };
  if (!map[type])
    throw new Error(`suppression_type must be one of: ${Object.keys(map).join(", ")}`);
  return map[type];
}

async function unsubscribeGroupCreate(ctx, args) {
  const name        = requireString(args.name, "name");
  const description = requireString(args.description, "description");
  const body = { name, description };
  if (args.is_default != null) body.is_default = args.is_default;
  const res = await sgReq(ctx, "POST", "/asm/groups", body, null, [200, 201]);
  return res.body;
}

async function unsubscribeGroupList(ctx, _args) {
  const res = await sgReq(ctx, "GET", "/asm/groups", null, null, [200]);
  return res.body;
}

async function unsubscribeGroupGet(ctx, args) {
  const id = requireString(String(args.group_id), "group_id");
  const res = await sgReq(ctx, "GET", `/asm/groups/${encodeURIComponent(id)}`,
    null, null, [200, 404]);
  if (res.status === 404) return { exists: false, group_id: id };
  return res.body;
}

async function unsubscribeGroupDelete(ctx, args) {
  const id = requireString(String(args.group_id), "group_id");
  const res = await sgReq(ctx, "DELETE", `/asm/groups/${encodeURIComponent(id)}`,
    null, null, [204, 404]);
  if (res.status === 404) return { deleted: false, group_id: id };
  return { deleted: true, group_id: id };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SENDERS (Verified Sender Identities)
// ═══════════════════════════════════════════════════════════════════════════════

async function senderCreate(ctx, args) {
  const from_email = requireString(args.from_email, "from_email");
  const from_name  = requireString(args.from_name,  "from_name");
  const reply_to   = optStr(args.reply_to_email, "reply_to_email");
  const body = {
    from: { email: from_email, name: from_name },
  };
  if (reply_to) body.reply_to = { email: reply_to, name: optStr(args.reply_to_name, "reply_to_name") };
  if (args.address)   body.address   = args.address;
  if (args.address_2) body.address_2 = args.address_2;
  if (args.city)      body.city      = args.city;
  if (args.state)     body.state     = args.state;
  if (args.zip)       body.zip       = args.zip;
  if (args.country)   body.country   = args.country;
  if (args.nickname)  body.nickname  = args.nickname;
  const res = await sgReq(ctx, "POST", "/senders", body, null, [200, 201]);
  return res.body;
}

async function senderList(ctx, _args) {
  const res = await sgReq(ctx, "GET", "/senders", null, null, [200]);
  return res.body;
}

async function senderGet(ctx, args) {
  const id = requireString(String(args.sender_id), "sender_id");
  const res = await sgReq(ctx, "GET", `/senders/${encodeURIComponent(id)}`,
    null, null, [200, 404]);
  if (res.status === 404) return { exists: false, sender_id: id };
  return res.body;
}

async function senderDelete(ctx, args) {
  const id = requireString(String(args.sender_id), "sender_id");
  const res = await sgReq(ctx, "DELETE", `/senders/${encodeURIComponent(id)}`,
    null, null, [204, 404]);
  if (res.status === 404) return { deleted: false, sender_id: id };
  return { deleted: true, sender_id: id };
}

async function senderVerify(ctx, args) {
  const id = requireString(String(args.sender_id), "sender_id");
  const res = await sgReq(ctx, "POST", `/senders/${encodeURIComponent(id)}/resend_verification`,
    {}, null, [204]);
  return { verification_sent: true, sender_id: id };
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATISTICS
// ═══════════════════════════════════════════════════════════════════════════════

async function statsGlobal(ctx, args) {
  const start_date = requireString(args.start_date, "start_date");
  const params = { start_date };
  if (args.end_date)    params.end_date    = args.end_date;
  if (args.aggregated_by) params.aggregated_by = args.aggregated_by;
  if (args.limit)       params.limit       = Math.min(500, Math.max(1, Number(args.limit)));
  if (args.offset)      params.offset      = Math.max(0, Number(args.offset));
  const res = await sgReq(ctx, "GET", "/stats", null, params, [200]);
  return res.body;
}

async function statsCategory(ctx, args) {
  const start_date = requireString(args.start_date, "start_date");
  const categories = args.categories;
  if (!categories) throw new Error("categories (string or array) is required");
  const params = {
    start_date,
    categories: Array.isArray(categories) ? categories.join(",") : categories,
  };
  if (args.end_date)      params.end_date      = args.end_date;
  if (args.aggregated_by) params.aggregated_by = args.aggregated_by;
  const res = await sgReq(ctx, "GET", "/categories/stats", null, params, [200]);
  return res.body;
}

async function statsTemplate(ctx, args) {
  const start_date    = requireString(args.start_date, "start_date");
  const template_ids  = args.template_ids;
  if (!template_ids) throw new Error("template_ids (string or array) is required");
  const params = {
    start_date,
    template_ids: Array.isArray(template_ids) ? template_ids.join(",") : template_ids,
  };
  if (args.end_date)      params.end_date      = args.end_date;
  if (args.aggregated_by) params.aggregated_by = args.aggregated_by;
  const res = await sgReq(ctx, "GET", "/templates/stats", null, params, [200]);
  return res.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// API KEYS
// ═══════════════════════════════════════════════════════════════════════════════

async function apiKeyCreate(ctx, args) {
  const name = requireString(args.name, "name");
  const body = { name };
  if (args.scopes) body.scopes = args.scopes;
  const res = await sgReq(ctx, "POST", "/api_keys", body, null, [201]);
  return res.body;
}

async function apiKeyList(ctx, _args) {
  const res = await sgReq(ctx, "GET", "/api_keys", null, null, [200]);
  return res.body;
}

async function apiKeyGet(ctx, args) {
  const id = requireString(args.api_key_id, "api_key_id");
  const res = await sgReq(ctx, "GET", `/api_keys/${encodeURIComponent(id)}`,
    null, null, [200, 404]);
  if (res.status === 404) return { exists: false, api_key_id: id };
  return res.body;
}

async function apiKeyDelete(ctx, args) {
  const id = requireString(args.api_key_id, "api_key_id");
  const res = await sgReq(ctx, "DELETE", `/api_keys/${encodeURIComponent(id)}`,
    null, null, [204, 404]);
  if (res.status === 404) return { deleted: false, api_key_id: id };
  return { deleted: true, api_key_id: id };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SCHEDULED SENDS
// ═══════════════════════════════════════════════════════════════════════════════

async function scheduledSendCreate(ctx, args) {
  const batch_id    = requireString(args.batch_id, "batch_id");
  const status      = requireString(args.status, "status");
  const allowed = ["cancel", "pause"];
  if (!allowed.includes(status))
    throw new Error(`status must be one of: ${allowed.join(", ")}`);
  const res = await sgReq(ctx, "POST", "/user/scheduled_sends",
    { batch_id, status }, null, [201]);
  return res.body;
}

async function scheduledSendList(ctx, _args) {
  const res = await sgReq(ctx, "GET", "/user/scheduled_sends", null, null, [200]);
  return res.body;
}

async function scheduledSendDelete(ctx, args) {
  const batch_id = requireString(args.batch_id, "batch_id");
  const res = await sgReq(ctx, "DELETE",
    `/user/scheduled_sends/${encodeURIComponent(batch_id)}`, null, null, [204, 404]);
  if (res.status === 404) return { deleted: false, batch_id };
  return { deleted: true, batch_id };
}

async function batchIdGenerate(ctx, _args) {
  const res = await sgReq(ctx, "POST", "/mail/batch", {}, null, [200, 201]);
  return res.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// USER / ACCOUNT INFO
// ═══════════════════════════════════════════════════════════════════════════════

async function userGet(ctx, _args) {
  const res = await sgReq(ctx, "GET", "/user/profile", null, null, [200]);
  return res.body;
}

async function accountGet(ctx, _args) {
  const res = await sgReq(ctx, "GET", "/user/account", null, null, [200]);
  return res.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GENERIC / INFO
// ═══════════════════════════════════════════════════════════════════════════════

async function genericRequest(ctx, args) {
  const method = requireString(args.method, "method").toUpperCase();
  const path   = requireString(args.path, "path");
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method))
    throw new Error(`Unsupported method: ${method}`);
  const body   = (method !== "GET" && method !== "DELETE") ? (args.body   || {}) : null;
  const params = (method === "GET"  || method === "DELETE") ? (args.params || null) : null;
  const res = await sgReq(ctx, method, path, body, params);
  return res.body;
}

async function infoGet(ctx, _args) {
  const profile = await userGet(ctx, {});
  const account = await accountGet(ctx, {});
  return {
    username:  profile.username,
    email:     profile.email,
    first_name: profile.first_name,
    last_name:  profile.last_name,
    type:       account.type,
    reputation: account.reputation,
    api_version: "v3",
    base_url:    `https://${API_HOSTNAME}/v3`,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN DISPATCHER
// ═══════════════════════════════════════════════════════════════════════════════

async function sendgridClient(args) {
  const op  = requireString(args.operation, "operation");
  const ctx = buildCtx(args);

  switch (op) {
    // Email Send
    case "mail_send":              return mailSend(ctx, args);
    // Contacts
    case "contact_upsert":         return contactUpsert(ctx, args);
    case "contact_search":         return contactSearch(ctx, args);
    case "contact_get":            return contactGet(ctx, args);
    case "contact_delete":         return contactDelete(ctx, args);
    case "contact_count":          return contactCount(ctx, args);
    // Lists
    case "list_create":            return listCreate(ctx, args);
    case "list_get":               return listGet(ctx, args);
    case "list_get_all":           return listGetAll(ctx, args);
    case "list_update":            return listUpdate(ctx, args);
    case "list_delete":            return listDelete(ctx, args);
    case "list_add_contacts":      return listAddContacts(ctx, args);
    case "list_remove_contacts":   return listRemoveContacts(ctx, args);
    // Templates
    case "template_create":            return templateCreate(ctx, args);
    case "template_get":               return templateGet(ctx, args);
    case "template_list":              return templateList(ctx, args);
    case "template_delete":            return templateDelete(ctx, args);
    case "template_version_create":    return templateVersionCreate(ctx, args);
    case "template_version_activate":  return templateVersionActivate(ctx, args);
    // Suppressions
    case "suppression_get":            return suppressionGet(ctx, args);
    case "suppression_delete":         return suppressionDelete(ctx, args);
    case "unsubscribe_group_create":   return unsubscribeGroupCreate(ctx, args);
    case "unsubscribe_group_list":     return unsubscribeGroupList(ctx, args);
    case "unsubscribe_group_get":      return unsubscribeGroupGet(ctx, args);
    case "unsubscribe_group_delete":   return unsubscribeGroupDelete(ctx, args);
    // Senders
    case "sender_create":          return senderCreate(ctx, args);
    case "sender_list":            return senderList(ctx, args);
    case "sender_get":             return senderGet(ctx, args);
    case "sender_delete":          return senderDelete(ctx, args);
    case "sender_verify":          return senderVerify(ctx, args);
    // Statistics
    case "stats_global":           return statsGlobal(ctx, args);
    case "stats_category":         return statsCategory(ctx, args);
    case "stats_template":         return statsTemplate(ctx, args);
    // API Keys
    case "api_key_create":         return apiKeyCreate(ctx, args);
    case "api_key_list":           return apiKeyList(ctx, args);
    case "api_key_get":            return apiKeyGet(ctx, args);
    case "api_key_delete":         return apiKeyDelete(ctx, args);
    // Scheduled Sends
    case "scheduled_send_create":  return scheduledSendCreate(ctx, args);
    case "scheduled_send_list":    return scheduledSendList(ctx, args);
    case "scheduled_send_delete":  return scheduledSendDelete(ctx, args);
    case "batch_id_generate":      return batchIdGenerate(ctx, args);
    // User / Account
    case "user_get":               return userGet(ctx, args);
    case "account_get":            return accountGet(ctx, args);
    // Generic / Info
    case "request":                return genericRequest(ctx, args);
    case "info":                   return infoGet(ctx, args);
    default:
      throw new Error(
        `Unknown operation: ${op}. Supported: mail_send, contact_upsert, contact_search, ` +
        `contact_get, contact_delete, contact_count, list_create, list_get, list_get_all, ` +
        `list_update, list_delete, list_add_contacts, list_remove_contacts, template_create, ` +
        `template_get, template_list, template_delete, template_version_create, ` +
        `template_version_activate, suppression_get, suppression_delete, ` +
        `unsubscribe_group_create, unsubscribe_group_list, unsubscribe_group_get, ` +
        `unsubscribe_group_delete, sender_create, sender_list, sender_get, sender_delete, ` +
        `sender_verify, stats_global, stats_category, stats_template, api_key_create, ` +
        `api_key_list, api_key_get, api_key_delete, scheduled_send_create, ` +
        `scheduled_send_list, scheduled_send_delete, batch_id_generate, ` +
        `user_get, account_get, request, info`
      );
  }
}

module.exports = { sendgridClient };
