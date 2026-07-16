"use strict";
/**
 * mailchimpClientOps.js
 * Zero-dependency Mailchimp Marketing API v3 client (pure Node.js https built-ins; no npm deps).
 * Auth: api_key (Basic: "anystring:<api_key>") or oauth_token (Bearer).
 * Base URL: https://<dc>.api.mailchimp.com/3.0 (dc = datacenter from api_key, e.g. "us6")
 * All credentials are scrubbed from error messages.
 * Response capped at 16 MB; timeout clamped 1–120 s (default 20 s).
 */

const https = require("https");

// ── Constants ─────────────────────────────────────────────────────────────────
const DEFAULT_TIMEOUT   = 20_000;
const MIN_TIMEOUT       = 1_000;
const MAX_TIMEOUT       = 120_000;
const MAX_RESPONSE_BODY = 16 * 1024 * 1024; // 16 MB
const NUL_RE            = /\x00/;

// ── Helpers ───────────────────────────────────────────────────────────────────
function scrubCreds(str, apiKey, oauthToken) {
  let s = String(str);
  if (apiKey)      s = s.split(apiKey).join("[api_key]");
  if (oauthToken)  s = s.split(oauthToken).join("[oauth_token]");
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
 * Extract the Mailchimp datacenter from an API key.
 * Mailchimp API keys end in "-usXX" e.g. "abc123def456-us6"
 */
function extractDc(apiKey) {
  const m = apiKey.match(/-([a-z]+\d+)$/);
  if (!m) throw new Error("api_key does not contain a datacenter suffix (e.g. -us6). Ensure you are using a full Mailchimp API key.");
  return m[1];
}

/**
 * Low-level HTTPS request to Mailchimp REST API v3.
 * Auth: Basic "anystring:<api_key>" or Bearer <oauth_token>
 */
function mcRequest({
  hostname, apiKey, oauthToken, method, path, body, params, timeout, rejectUnauthorized,
}) {
  return new Promise((resolve, reject) => {
    const ms = clampTimeout(timeout);

    let fullPath = `/3.0${path}`;
    let bodyStr  = null;

    // Build query string
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
      Accept: "application/json",
      "User-Agent": "mcp-common-server/mailchimp_client",
    };

    if (oauthToken) {
      headers["Authorization"] = `Bearer ${oauthToken}`;
    } else {
      // Basic auth: "anystring:<api_key>"
      const encoded = Buffer.from(`mcp:${apiKey}`).toString("base64");
      headers["Authorization"] = `Basic ${encoded}`;
    }

    if (bodyStr) {
      headers["Content-Type"]   = "application/json";
      headers["Content-Length"] = Buffer.byteLength(bodyStr);
    }

    const options = {
      hostname,
      port: 443,
      path: fullPath,
      method: method || "GET",
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
        reject(new Error(scrubCreds(err.message, apiKey, oauthToken)));
      });
    });

    timer = setTimeout(() => {
      reject(new Error(`Mailchimp request timed out after ${ms} ms`));
      req.destroy();
    }, ms);

    req.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(scrubCreds(err.message, apiKey, oauthToken)));
    });

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function mcReq(ctx, method, path, body, params, allowedStatuses) {
  const res = await mcRequest({
    hostname:           ctx.hostname,
    apiKey:             ctx.apiKey,
    oauthToken:         ctx.oauthToken,
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
    const scrubbed = scrubCreds(errBody, ctx.apiKey, ctx.oauthToken);
    throw new Error(`Mailchimp API error ${res.status}: ${scrubbed}`);
  }
  return res;
}

function buildCtx(args) {
  const apiKey     = optStr(args.api_key, "api_key");
  const oauthToken = optStr(args.oauth_token, "oauth_token");

  if (!apiKey && !oauthToken)
    throw new Error("api_key or oauth_token is required");
  if (apiKey) validateNul(apiKey, "api_key");
  if (oauthToken) validateNul(oauthToken, "oauth_token");

  let hostname;
  if (args.server_prefix) {
    validateNul(args.server_prefix, "server_prefix");
    hostname = `${args.server_prefix}.api.mailchimp.com`;
  } else if (apiKey) {
    const dc = extractDc(apiKey);
    hostname = `${dc}.api.mailchimp.com`;
  } else {
    throw new Error("server_prefix is required when using oauth_token (e.g. 'us6')");
  }

  return {
    hostname,
    apiKey,
    oauthToken,
    timeout:            args.timeout,
    rejectUnauthorized: args.reject_unauthorized,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LISTS / AUDIENCES
// ═══════════════════════════════════════════════════════════════════════════════

async function listCreate(ctx, args) {
  const name         = requireString(args.name, "name");
  const company      = requireString(args.company, "company");
  const address1     = requireString(args.address1, "address1");
  const city         = requireString(args.city, "city");
  const country      = requireString(args.country, "country");
  const from_name    = requireString(args.from_name, "from_name");
  const from_email   = requireString(args.from_email, "from_email");
  const subject      = requireString(args.subject, "subject");
  const language     = optStr(args.language, "language") ?? "en";
  const permission_reminder = requireString(args.permission_reminder, "permission_reminder");

  const body = {
    name,
    contact: { company, address1, city, country,
      address2: optStr(args.address2, "address2"),
      state:    optStr(args.state, "state"),
      zip:      optStr(args.zip, "zip"),
      phone:    optStr(args.phone, "phone"),
    },
    permission_reminder,
    campaign_defaults: { from_name, from_email, subject, language },
    email_type_option: args.email_type_option ?? false,
  };
  if (args.double_optin != null)       body.double_optin       = args.double_optin;
  if (args.marketing_permissions != null) body.marketing_permissions = args.marketing_permissions;
  const res = await mcReq(ctx, "POST", "/lists", body, null, [200]);
  return res.body;
}

async function listGet(ctx, args) {
  const list_id = requireString(args.list_id, "list_id");
  const res = await mcReq(ctx, "GET", `/lists/${encodeURIComponent(list_id)}`,
    null, null, [200, 404]);
  if (res.status === 404) return { exists: false, list_id };
  return res.body;
}

async function listGetAll(ctx, args) {
  const params = {};
  if (args.count)    params.count   = Math.min(1000, Math.max(1, Number(args.count)));
  if (args.offset)   params.offset  = Math.max(0, Number(args.offset));
  if (args.sort_field) params.sort_field = args.sort_field;
  if (args.sort_dir)   params.sort_dir   = args.sort_dir;
  const res = await mcReq(ctx, "GET", "/lists", null,
    Object.keys(params).length ? params : null, [200]);
  return res.body;
}

async function listUpdate(ctx, args) {
  const list_id = requireString(args.list_id, "list_id");
  const body = {};
  if (args.name)    body.name    = args.name;
  if (args.contact) body.contact = args.contact;
  if (args.campaign_defaults) body.campaign_defaults = args.campaign_defaults;
  if (args.permission_reminder) body.permission_reminder = args.permission_reminder;
  if (args.email_type_option != null) body.email_type_option = args.email_type_option;
  const res = await mcReq(ctx, "PATCH", `/lists/${encodeURIComponent(list_id)}`,
    body, null, [200]);
  return res.body;
}

async function listDelete(ctx, args) {
  const list_id = requireString(args.list_id, "list_id");
  const res = await mcReq(ctx, "DELETE", `/lists/${encodeURIComponent(list_id)}`,
    null, null, [204, 404]);
  if (res.status === 404) return { deleted: false, list_id };
  return { deleted: true, list_id };
}

async function listStats(ctx, args) {
  const list_id = requireString(args.list_id, "list_id");
  const res = await mcReq(ctx, "GET", `/lists/${encodeURIComponent(list_id)}/growth-history`,
    null, null, [200]);
  return res.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MEMBERS (List Members)
// ═══════════════════════════════════════════════════════════════════════════════

function memberHash(email) {
  // Mailchimp uses MD5 of lowercase email as member ID
  const crypto = require("crypto");
  return crypto.createHash("md5").update(email.toLowerCase()).digest("hex");
}

async function memberAdd(ctx, args) {
  const list_id       = requireString(args.list_id, "list_id");
  const email_address = requireString(args.email_address, "email_address");
  const status        = requireString(args.status, "status");
  const allowed = ["subscribed", "unsubscribed", "cleaned", "pending", "transactional"];
  if (!allowed.includes(status))
    throw new Error(`status must be one of: ${allowed.join(", ")}`);

  const body = { email_address, status };
  if (args.email_type)        body.email_type        = args.email_type;
  if (args.merge_fields)      body.merge_fields      = args.merge_fields;
  if (args.interests)         body.interests         = args.interests;
  if (args.language)          body.language          = args.language;
  if (args.vip != null)       body.vip               = args.vip;
  if (args.location)          body.location          = args.location;
  if (args.tags)              body.tags              = args.tags;

  const res = await mcReq(ctx, "POST", `/lists/${encodeURIComponent(list_id)}/members`,
    body, null, [200]);
  return res.body;
}

async function memberUpsert(ctx, args) {
  const list_id       = requireString(args.list_id, "list_id");
  const email_address = requireString(args.email_address, "email_address");
  const status_if_new = requireString(args.status_if_new, "status_if_new");
  const hash          = memberHash(email_address);

  const body = { email_address, status_if_new };
  if (args.status)        body.status        = args.status;
  if (args.email_type)    body.email_type    = args.email_type;
  if (args.merge_fields)  body.merge_fields  = args.merge_fields;
  if (args.interests)     body.interests     = args.interests;
  if (args.language)      body.language      = args.language;
  if (args.vip != null)   body.vip           = args.vip;
  if (args.location)      body.location      = args.location;

  const res = await mcReq(ctx, "PUT",
    `/lists/${encodeURIComponent(list_id)}/members/${hash}`, body, null, [200]);
  return res.body;
}

async function memberGet(ctx, args) {
  const list_id       = requireString(args.list_id, "list_id");
  const email_address = requireString(args.email_address, "email_address");
  const hash          = memberHash(email_address);
  const res = await mcReq(ctx, "GET",
    `/lists/${encodeURIComponent(list_id)}/members/${hash}`, null, null, [200, 404]);
  if (res.status === 404) return { exists: false, email_address };
  return res.body;
}

async function memberUpdate(ctx, args) {
  const list_id       = requireString(args.list_id, "list_id");
  const email_address = requireString(args.email_address, "email_address");
  const hash          = memberHash(email_address);
  const body = {};
  if (args.status)       body.status       = args.status;
  if (args.email_type)   body.email_type   = args.email_type;
  if (args.merge_fields) body.merge_fields = args.merge_fields;
  if (args.interests)    body.interests    = args.interests;
  if (args.language)     body.language     = args.language;
  if (args.vip != null)  body.vip          = args.vip;
  if (args.location)     body.location     = args.location;
  const res = await mcReq(ctx, "PATCH",
    `/lists/${encodeURIComponent(list_id)}/members/${hash}`, body, null, [200]);
  return res.body;
}

async function memberDelete(ctx, args) {
  const list_id       = requireString(args.list_id, "list_id");
  const email_address = requireString(args.email_address, "email_address");
  const hash          = memberHash(email_address);
  const res = await mcReq(ctx, "DELETE",
    `/lists/${encodeURIComponent(list_id)}/members/${hash}`, null, null, [204, 404]);
  if (res.status === 404) return { deleted: false, email_address };
  return { deleted: true, email_address };
}

async function memberDeletePermanent(ctx, args) {
  const list_id       = requireString(args.list_id, "list_id");
  const email_address = requireString(args.email_address, "email_address");
  const hash          = memberHash(email_address);
  const res = await mcReq(ctx, "POST",
    `/lists/${encodeURIComponent(list_id)}/members/${hash}/actions/delete-permanent`,
    {}, null, [204]);
  return { permanently_deleted: true, email_address };
}

async function memberList(ctx, args) {
  const list_id = requireString(args.list_id, "list_id");
  const params = {};
  if (args.status)        params.status        = args.status;
  if (args.count)         params.count         = Math.min(1000, Math.max(1, Number(args.count)));
  if (args.offset)        params.offset        = Math.max(0, Number(args.offset));
  if (args.since_timestamp_opt) params.since_timestamp_opt = args.since_timestamp_opt;
  if (args.before_timestamp_opt) params.before_timestamp_opt = args.before_timestamp_opt;
  if (args.email_address) params.email_address = args.email_address;
  const res = await mcReq(ctx, "GET", `/lists/${encodeURIComponent(list_id)}/members`,
    null, Object.keys(params).length ? params : null, [200]);
  return res.body;
}

async function memberTagsUpdate(ctx, args) {
  const list_id       = requireString(args.list_id, "list_id");
  const email_address = requireString(args.email_address, "email_address");
  const hash          = memberHash(email_address);
  const tags          = args.tags;
  if (!Array.isArray(tags) || !tags.length)
    throw new Error("tags (array of {name, status} objects) is required");
  const res = await mcReq(ctx, "POST",
    `/lists/${encodeURIComponent(list_id)}/members/${hash}/tags`,
    { tags }, null, [204]);
  return { tags_updated: true, email_address };
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEGMENTS (Tags / Groups in old terminology)
// ═══════════════════════════════════════════════════════════════════════════════

async function segmentCreate(ctx, args) {
  const list_id = requireString(args.list_id, "list_id");
  const name    = requireString(args.name, "name");
  const body    = { name };
  if (args.static_segment) body.static_segment = args.static_segment; // array of emails
  if (args.options) body.options = args.options; // for saved segments
  const res = await mcReq(ctx, "POST", `/lists/${encodeURIComponent(list_id)}/segments`,
    body, null, [200]);
  return res.body;
}

async function segmentGet(ctx, args) {
  const list_id    = requireString(args.list_id, "list_id");
  const segment_id = requireString(String(args.segment_id), "segment_id");
  const res = await mcReq(ctx, "GET",
    `/lists/${encodeURIComponent(list_id)}/segments/${encodeURIComponent(segment_id)}`,
    null, null, [200, 404]);
  if (res.status === 404) return { exists: false, segment_id };
  return res.body;
}

async function segmentList(ctx, args) {
  const list_id = requireString(args.list_id, "list_id");
  const params = {};
  if (args.count)  params.count  = Math.min(1000, Math.max(1, Number(args.count)));
  if (args.offset) params.offset = Math.max(0, Number(args.offset));
  if (args.type)   params.type   = args.type;
  const res = await mcReq(ctx, "GET", `/lists/${encodeURIComponent(list_id)}/segments`,
    null, Object.keys(params).length ? params : null, [200]);
  return res.body;
}

async function segmentDelete(ctx, args) {
  const list_id    = requireString(args.list_id, "list_id");
  const segment_id = requireString(String(args.segment_id), "segment_id");
  const res = await mcReq(ctx, "DELETE",
    `/lists/${encodeURIComponent(list_id)}/segments/${encodeURIComponent(segment_id)}`,
    null, null, [204, 404]);
  if (res.status === 404) return { deleted: false, segment_id };
  return { deleted: true, segment_id };
}

async function segmentMemberAdd(ctx, args) {
  const list_id       = requireString(args.list_id, "list_id");
  const segment_id    = requireString(String(args.segment_id), "segment_id");
  const email_address = requireString(args.email_address, "email_address");
  const res = await mcReq(ctx, "POST",
    `/lists/${encodeURIComponent(list_id)}/segments/${encodeURIComponent(segment_id)}/members`,
    { email_address }, null, [200]);
  return res.body;
}

async function segmentMemberDelete(ctx, args) {
  const list_id       = requireString(args.list_id, "list_id");
  const segment_id    = requireString(String(args.segment_id), "segment_id");
  const email_address = requireString(args.email_address, "email_address");
  const hash          = memberHash(email_address);
  const res = await mcReq(ctx, "DELETE",
    `/lists/${encodeURIComponent(list_id)}/segments/${encodeURIComponent(segment_id)}/members/${hash}`,
    null, null, [204, 404]);
  if (res.status === 404) return { deleted: false, email_address };
  return { deleted: true, email_address };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CAMPAIGNS
// ═══════════════════════════════════════════════════════════════════════════════

async function campaignCreate(ctx, args) {
  const type = requireString(args.type, "type");
  const allowed = ["regular", "plaintext", "absplit", "rss", "variate"];
  if (!allowed.includes(type))
    throw new Error(`campaign type must be one of: ${allowed.join(", ")}`);
  const body = { type };
  if (args.recipients)       body.recipients       = args.recipients;
  if (args.settings)         body.settings         = args.settings;
  if (args.variate_settings) body.variate_settings = args.variate_settings;
  if (args.tracking)         body.tracking         = args.tracking;
  if (args.rss_opts)         body.rss_opts         = args.rss_opts;
  if (args.social_card)      body.social_card      = args.social_card;
  const res = await mcReq(ctx, "POST", "/campaigns", body, null, [200]);
  return res.body;
}

async function campaignGet(ctx, args) {
  const campaign_id = requireString(args.campaign_id, "campaign_id");
  const res = await mcReq(ctx, "GET", `/campaigns/${encodeURIComponent(campaign_id)}`,
    null, null, [200, 404]);
  if (res.status === 404) return { exists: false, campaign_id };
  return res.body;
}

async function campaignList(ctx, args) {
  const params = {};
  if (args.status)        params.status        = args.status;
  if (args.type)          params.type          = args.type;
  if (args.list_id)       params.list_id       = args.list_id;
  if (args.count)         params.count         = Math.min(1000, Math.max(1, Number(args.count)));
  if (args.offset)        params.offset        = Math.max(0, Number(args.offset));
  if (args.sort_field)    params.sort_field    = args.sort_field;
  if (args.sort_dir)      params.sort_dir      = args.sort_dir;
  if (args.since_create_time) params.since_create_time = args.since_create_time;
  const res = await mcReq(ctx, "GET", "/campaigns", null,
    Object.keys(params).length ? params : null, [200]);
  return res.body;
}

async function campaignUpdate(ctx, args) {
  const campaign_id = requireString(args.campaign_id, "campaign_id");
  const body = {};
  if (args.recipients)  body.recipients  = args.recipients;
  if (args.settings)    body.settings    = args.settings;
  if (args.tracking)    body.tracking    = args.tracking;
  if (args.rss_opts)    body.rss_opts    = args.rss_opts;
  if (args.social_card) body.social_card = args.social_card;
  const res = await mcReq(ctx, "PATCH", `/campaigns/${encodeURIComponent(campaign_id)}`,
    body, null, [200]);
  return res.body;
}

async function campaignDelete(ctx, args) {
  const campaign_id = requireString(args.campaign_id, "campaign_id");
  const res = await mcReq(ctx, "DELETE", `/campaigns/${encodeURIComponent(campaign_id)}`,
    null, null, [204, 404]);
  if (res.status === 404) return { deleted: false, campaign_id };
  return { deleted: true, campaign_id };
}

async function campaignSend(ctx, args) {
  const campaign_id = requireString(args.campaign_id, "campaign_id");
  const res = await mcReq(ctx, "POST", `/campaigns/${encodeURIComponent(campaign_id)}/actions/send`,
    {}, null, [204]);
  return { sent: true, campaign_id };
}

async function campaignSchedule(ctx, args) {
  const campaign_id   = requireString(args.campaign_id, "campaign_id");
  const schedule_time = requireString(args.schedule_time, "schedule_time");
  const body = { schedule_time };
  if (args.timewarp != null)    body.timewarp    = args.timewarp;
  if (args.batch_delivery)      body.batch_delivery = args.batch_delivery;
  const res = await mcReq(ctx, "POST",
    `/campaigns/${encodeURIComponent(campaign_id)}/actions/schedule`,
    body, null, [204]);
  return { scheduled: true, campaign_id, schedule_time };
}

async function campaignUnschedule(ctx, args) {
  const campaign_id = requireString(args.campaign_id, "campaign_id");
  const res = await mcReq(ctx, "POST",
    `/campaigns/${encodeURIComponent(campaign_id)}/actions/unschedule`,
    {}, null, [204]);
  return { unscheduled: true, campaign_id };
}

async function campaignSendTest(ctx, args) {
  const campaign_id = requireString(args.campaign_id, "campaign_id");
  const test_emails = args.test_emails;
  if (!Array.isArray(test_emails) || !test_emails.length)
    throw new Error("test_emails (array of email addresses) is required");
  const body = { test_emails };
  if (args.send_type) body.send_type = args.send_type;
  const res = await mcReq(ctx, "POST",
    `/campaigns/${encodeURIComponent(campaign_id)}/actions/test`,
    body, null, [204]);
  return { test_sent: true, campaign_id, test_emails };
}

async function campaignCancel(ctx, args) {
  const campaign_id = requireString(args.campaign_id, "campaign_id");
  const res = await mcReq(ctx, "POST",
    `/campaigns/${encodeURIComponent(campaign_id)}/actions/cancel-send`,
    {}, null, [204]);
  return { cancelled: true, campaign_id };
}

async function campaignReplicate(ctx, args) {
  const campaign_id = requireString(args.campaign_id, "campaign_id");
  const res = await mcReq(ctx, "POST",
    `/campaigns/${encodeURIComponent(campaign_id)}/actions/replicate`,
    {}, null, [200]);
  return res.body;
}

async function campaignContentGet(ctx, args) {
  const campaign_id = requireString(args.campaign_id, "campaign_id");
  const res = await mcReq(ctx, "GET",
    `/campaigns/${encodeURIComponent(campaign_id)}/content`, null, null, [200]);
  return res.body;
}

async function campaignContentSet(ctx, args) {
  const campaign_id = requireString(args.campaign_id, "campaign_id");
  const body = {};
  if (args.plain_text)   body.plain_text   = args.plain_text;
  if (args.html)         body.html         = args.html;
  if (args.url)          body.url          = args.url;
  if (args.template)     body.template     = args.template;
  if (args.sections)     body.sections     = args.sections;
  if (!Object.keys(body).length)
    throw new Error("At least one of plain_text, html, url, template, or sections is required");
  const res = await mcReq(ctx, "PUT",
    `/campaigns/${encodeURIComponent(campaign_id)}/content`, body, null, [200]);
  return res.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEMPLATES
// ═══════════════════════════════════════════════════════════════════════════════

async function templateCreate(ctx, args) {
  const name = requireString(args.name, "name");
  const html = requireString(args.html, "html");
  const body = { name, html };
  if (args.folder_id) body.folder_id = args.folder_id;
  const res = await mcReq(ctx, "POST", "/templates", body, null, [200]);
  return res.body;
}

async function templateGet(ctx, args) {
  const template_id = requireString(String(args.template_id), "template_id");
  const res = await mcReq(ctx, "GET", `/templates/${encodeURIComponent(template_id)}`,
    null, null, [200, 404]);
  if (res.status === 404) return { exists: false, template_id };
  return res.body;
}

async function templateList(ctx, args) {
  const params = {};
  if (args.type)       params.type       = args.type;
  if (args.category)   params.category   = args.category;
  if (args.count)      params.count      = Math.min(1000, Math.max(1, Number(args.count)));
  if (args.offset)     params.offset     = Math.max(0, Number(args.offset));
  if (args.sort_field) params.sort_field = args.sort_field;
  if (args.sort_dir)   params.sort_dir   = args.sort_dir;
  const res = await mcReq(ctx, "GET", "/templates", null,
    Object.keys(params).length ? params : null, [200]);
  return res.body;
}

async function templateUpdate(ctx, args) {
  const template_id = requireString(String(args.template_id), "template_id");
  const body = {};
  if (args.name)      body.name      = args.name;
  if (args.html)      body.html      = args.html;
  if (args.folder_id) body.folder_id = args.folder_id;
  const res = await mcReq(ctx, "PATCH", `/templates/${encodeURIComponent(template_id)}`,
    body, null, [200]);
  return res.body;
}

async function templateDelete(ctx, args) {
  const template_id = requireString(String(args.template_id), "template_id");
  const res = await mcReq(ctx, "DELETE", `/templates/${encodeURIComponent(template_id)}`,
    null, null, [204, 404]);
  if (res.status === 404) return { deleted: false, template_id };
  return { deleted: true, template_id };
}

// ═══════════════════════════════════════════════════════════════════════════════
// REPORTS
// ═══════════════════════════════════════════════════════════════════════════════

async function reportGet(ctx, args) {
  const campaign_id = requireString(args.campaign_id, "campaign_id");
  const res = await mcReq(ctx, "GET", `/reports/${encodeURIComponent(campaign_id)}`,
    null, null, [200, 404]);
  if (res.status === 404) return { exists: false, campaign_id };
  return res.body;
}

async function reportList(ctx, args) {
  const params = {};
  if (args.type)               params.type               = args.type;
  if (args.count)              params.count              = Math.min(1000, Math.max(1, Number(args.count)));
  if (args.offset)             params.offset             = Math.max(0, Number(args.offset));
  if (args.since_send_time)    params.since_send_time    = args.since_send_time;
  if (args.before_send_time)   params.before_send_time   = args.before_send_time;
  const res = await mcReq(ctx, "GET", "/reports", null,
    Object.keys(params).length ? params : null, [200]);
  return res.body;
}

async function reportClickDetails(ctx, args) {
  const campaign_id = requireString(args.campaign_id, "campaign_id");
  const params = {};
  if (args.count)  params.count  = Math.min(1000, Math.max(1, Number(args.count)));
  if (args.offset) params.offset = Math.max(0, Number(args.offset));
  const res = await mcReq(ctx, "GET",
    `/reports/${encodeURIComponent(campaign_id)}/click-details`,
    null, Object.keys(params).length ? params : null, [200]);
  return res.body;
}

async function reportOpenDetails(ctx, args) {
  const campaign_id = requireString(args.campaign_id, "campaign_id");
  const params = {};
  if (args.count)  params.count  = Math.min(1000, Math.max(1, Number(args.count)));
  if (args.offset) params.offset = Math.max(0, Number(args.offset));
  if (args.since)  params.since  = args.since;
  const res = await mcReq(ctx, "GET",
    `/reports/${encodeURIComponent(campaign_id)}/open-details`,
    null, Object.keys(params).length ? params : null, [200]);
  return res.body;
}

async function reportUnsubscribes(ctx, args) {
  const campaign_id = requireString(args.campaign_id, "campaign_id");
  const params = {};
  if (args.count)  params.count  = Math.min(1000, Math.max(1, Number(args.count)));
  if (args.offset) params.offset = Math.max(0, Number(args.offset));
  const res = await mcReq(ctx, "GET",
    `/reports/${encodeURIComponent(campaign_id)}/unsubscribed`,
    null, Object.keys(params).length ? params : null, [200]);
  return res.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUTOMATIONS (Classic)
// ═══════════════════════════════════════════════════════════════════════════════

async function automationList(ctx, _args) {
  const res = await mcReq(ctx, "GET", "/automations", null, null, [200]);
  return res.body;
}

async function automationGet(ctx, args) {
  const workflow_id = requireString(args.workflow_id, "workflow_id");
  const res = await mcReq(ctx, "GET", `/automations/${encodeURIComponent(workflow_id)}`,
    null, null, [200, 404]);
  if (res.status === 404) return { exists: false, workflow_id };
  return res.body;
}

async function automationStart(ctx, args) {
  const workflow_id = requireString(args.workflow_id, "workflow_id");
  const res = await mcReq(ctx, "POST",
    `/automations/${encodeURIComponent(workflow_id)}/actions/start-all-emails`,
    {}, null, [204]);
  return { started: true, workflow_id };
}

async function automationPause(ctx, args) {
  const workflow_id = requireString(args.workflow_id, "workflow_id");
  const res = await mcReq(ctx, "POST",
    `/automations/${encodeURIComponent(workflow_id)}/actions/pause-all-emails`,
    {}, null, [204]);
  return { paused: true, workflow_id };
}

async function automationEmailList(ctx, args) {
  const workflow_id = requireString(args.workflow_id, "workflow_id");
  const res = await mcReq(ctx, "GET",
    `/automations/${encodeURIComponent(workflow_id)}/emails`, null, null, [200]);
  return res.body;
}

async function automationSubscriberAdd(ctx, args) {
  const workflow_id   = requireString(args.workflow_id, "workflow_id");
  const email_address = requireString(args.email_address, "email_address");
  const res = await mcReq(ctx, "POST",
    `/automations/${encodeURIComponent(workflow_id)}/queue`,
    { email_address }, null, [200]);
  return res.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// PING / ACCOUNT INFO
// ═══════════════════════════════════════════════════════════════════════════════

async function ping(ctx, _args) {
  const res = await mcReq(ctx, "GET", "/ping", null, null, [200]);
  return res.body;
}

async function accountInfo(ctx, _args) {
  const res = await mcReq(ctx, "GET", "/", null, null, [200]);
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
  const body   = (method !== "GET" && method !== "DELETE") ? (args.body   || {}) : null;
  const params = (method === "GET"  || method === "DELETE") ? (args.params || null) : null;
  const res = await mcReq(ctx, method, path, body, params);
  return res.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN DISPATCHER
// ═══════════════════════════════════════════════════════════════════════════════

async function mailchimpClient(args) {
  const op  = requireString(args.operation, "operation");
  const ctx = buildCtx(args);

  switch (op) {
    // Lists
    case "list_create":          return listCreate(ctx, args);
    case "list_get":             return listGet(ctx, args);
    case "list_get_all":         return listGetAll(ctx, args);
    case "list_update":          return listUpdate(ctx, args);
    case "list_delete":          return listDelete(ctx, args);
    case "list_stats":           return listStats(ctx, args);
    // Members
    case "member_add":           return memberAdd(ctx, args);
    case "member_upsert":        return memberUpsert(ctx, args);
    case "member_get":           return memberGet(ctx, args);
    case "member_update":        return memberUpdate(ctx, args);
    case "member_delete":        return memberDelete(ctx, args);
    case "member_delete_permanent": return memberDeletePermanent(ctx, args);
    case "member_list":          return memberList(ctx, args);
    case "member_tags_update":   return memberTagsUpdate(ctx, args);
    // Segments
    case "segment_create":       return segmentCreate(ctx, args);
    case "segment_get":          return segmentGet(ctx, args);
    case "segment_list":         return segmentList(ctx, args);
    case "segment_delete":       return segmentDelete(ctx, args);
    case "segment_member_add":   return segmentMemberAdd(ctx, args);
    case "segment_member_delete": return segmentMemberDelete(ctx, args);
    // Campaigns
    case "campaign_create":      return campaignCreate(ctx, args);
    case "campaign_get":         return campaignGet(ctx, args);
    case "campaign_list":        return campaignList(ctx, args);
    case "campaign_update":      return campaignUpdate(ctx, args);
    case "campaign_delete":      return campaignDelete(ctx, args);
    case "campaign_send":        return campaignSend(ctx, args);
    case "campaign_schedule":    return campaignSchedule(ctx, args);
    case "campaign_unschedule":  return campaignUnschedule(ctx, args);
    case "campaign_send_test":   return campaignSendTest(ctx, args);
    case "campaign_cancel":      return campaignCancel(ctx, args);
    case "campaign_replicate":   return campaignReplicate(ctx, args);
    case "campaign_content_get": return campaignContentGet(ctx, args);
    case "campaign_content_set": return campaignContentSet(ctx, args);
    // Templates
    case "template_create":      return templateCreate(ctx, args);
    case "template_get":         return templateGet(ctx, args);
    case "template_list":        return templateList(ctx, args);
    case "template_update":      return templateUpdate(ctx, args);
    case "template_delete":      return templateDelete(ctx, args);
    // Reports
    case "report_get":           return reportGet(ctx, args);
    case "report_list":          return reportList(ctx, args);
    case "report_click_details": return reportClickDetails(ctx, args);
    case "report_open_details":  return reportOpenDetails(ctx, args);
    case "report_unsubscribes":  return reportUnsubscribes(ctx, args);
    // Automations
    case "automation_list":      return automationList(ctx, args);
    case "automation_get":       return automationGet(ctx, args);
    case "automation_start":     return automationStart(ctx, args);
    case "automation_pause":     return automationPause(ctx, args);
    case "automation_email_list": return automationEmailList(ctx, args);
    case "automation_subscriber_add": return automationSubscriberAdd(ctx, args);
    // Ping / Info
    case "ping":                 return ping(ctx, args);
    case "account_info":         return accountInfo(ctx, args);
    // Generic
    case "request":              return genericRequest(ctx, args);
    default:
      throw new Error(
        `Unknown operation: ${op}. Supported: list_create, list_get, list_get_all, ` +
        `list_update, list_delete, list_stats, member_add, member_upsert, member_get, ` +
        `member_update, member_delete, member_delete_permanent, member_list, ` +
        `member_tags_update, segment_create, segment_get, segment_list, segment_delete, ` +
        `segment_member_add, segment_member_delete, campaign_create, campaign_get, ` +
        `campaign_list, campaign_update, campaign_delete, campaign_send, ` +
        `campaign_schedule, campaign_unschedule, campaign_send_test, campaign_cancel, ` +
        `campaign_replicate, campaign_content_get, campaign_content_set, ` +
        `template_create, template_get, template_list, template_update, template_delete, ` +
        `report_get, report_list, report_click_details, report_open_details, ` +
        `report_unsubscribes, automation_list, automation_get, automation_start, ` +
        `automation_pause, automation_email_list, automation_subscriber_add, ` +
        `ping, account_info, request`
      );
  }
}

module.exports = { mailchimpClient };
