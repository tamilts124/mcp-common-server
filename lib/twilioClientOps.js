"use strict";
/**
 * twilioClientOps.js
 * Zero-dependency Twilio REST API client (pure Node.js https built-ins; no npm deps).
 * Auth: Account SID + Auth Token (HTTP Basic) or API Key + API Secret.
 * Base URL: https://api.twilio.com/2010-04-01
 * All credentials are scrubbed from error messages.
 */

const https = require("https");

// ── Constants ────────────────────────────────────────────────────────────────
const DEFAULT_TIMEOUT   = 20_000;
const MIN_TIMEOUT       = 1_000;
const MAX_TIMEOUT       = 120_000;
const MAX_RESPONSE_BODY = 16 * 1024 * 1024; // 16 MB
const API_HOSTNAME      = "api.twilio.com";
const API_VERSION       = "2010-04-01";
const NUL_RE            = /\x00/;

// ── Helpers ──────────────────────────────────────────────────────────────────
function scrubCreds(str, accountSid, authToken, apiSecret) {
  let s = String(str);
  if (accountSid) s = s.split(accountSid).join("[account_sid]");
  if (authToken)  s = s.split(authToken).join("[auth_token]");
  if (apiSecret)  s = s.split(apiSecret).join("[api_secret]");
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
 * Low-level HTTPS request to Twilio REST API.
 * Twilio uses HTTP Basic auth and form-encoded bodies for POST/PUT.
 */
function twilioRequest({
  username, password,
  method, path, params, timeout, rejectUnauthorized,
  accountSid, authToken, apiSecret,
}) {
  return new Promise((resolve, reject) => {
    const ms = clampTimeout(timeout);

    const basicAuth = Buffer.from(`${username}:${password}`).toString("base64");

    let bodyStr = null;
    let fullPath = path;

    if ((method === "GET" || method === "DELETE") && params && Object.keys(params).length) {
      // GET params go in query string
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v == null) continue;
        if (Array.isArray(v)) v.forEach(item => qs.append(k, String(item)));
        else qs.set(k, String(v));
      }
      const s = qs.toString();
      if (s) fullPath = `${path}?${s}`;
    } else if (params && Object.keys(params).length) {
      // POST/PUT params go as form-encoded body
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v == null) continue;
        if (Array.isArray(v)) v.forEach(item => qs.append(k, String(item)));
        else qs.set(k, String(v));
      }
      bodyStr = qs.toString();
    }

    const headers = {
      Authorization: `Basic ${basicAuth}`,
      Accept:        "application/json",
      "User-Agent":  "mcp-common-server/twilio_client",
    };
    if (bodyStr) {
      headers["Content-Type"]   = "application/x-www-form-urlencoded";
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
        reject(new Error(scrubCreds(err.message, accountSid, authToken, apiSecret)));
      });
    });

    timer = setTimeout(() => {
      reject(new Error(`Twilio request timed out after ${ms} ms`));
      req.destroy();
    }, ms);

    req.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(scrubCreds(err.message, accountSid, authToken, apiSecret)));
    });

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function twReq(ctx, method, path, params, allowedStatuses) {
  const res = await twilioRequest({
    username:           ctx.username,
    password:           ctx.password,
    accountSid:         ctx.accountSid,
    authToken:          ctx.authToken,
    apiSecret:          ctx.apiSecret,
    method, path, params,
    timeout:            ctx.timeout,
    rejectUnauthorized: ctx.rejectUnauthorized,
  });
  const ok = allowedStatuses
    ? allowedStatuses.includes(res.status)
    : res.status >= 200 && res.status < 300;
  if (!ok) {
    const errBody = res.body ? JSON.stringify(res.body) : "(empty)";
    const scrubbed = scrubCreds(errBody, ctx.accountSid, ctx.authToken, ctx.apiSecret);
    throw new Error(`Twilio API error ${res.status}: ${scrubbed}`);
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

function optInt(val, name, min, max) {
  if (val == null) return undefined;
  const n = Number(val);
  if (!isFinite(n) || !Number.isInteger(n))
    throw new Error(`${name} must be an integer`);
  if (min != null && n < min) throw new Error(`${name} must be >= ${min}`);
  if (max != null && n > max) throw new Error(`${name} must be <= ${max}`);
  return n;
}

function buildCtx(args) {
  const accountSid = requireString(args.account_sid, "account_sid");
  // Auth: auth_token OR (api_key + api_secret)
  const authToken = optStr(args.auth_token, "auth_token");
  const apiKey    = optStr(args.api_key,    "api_key");
  const apiSecret = optStr(args.api_secret, "api_secret");

  let username, password;
  if (apiKey && apiSecret) {
    username = apiKey;
    password = apiSecret;
  } else if (authToken) {
    username = accountSid;
    password = authToken;
  } else {
    throw new Error("auth_token OR (api_key + api_secret) is required");
  }

  return {
    accountSid,
    authToken,
    apiKey,
    apiSecret,
    username,
    password,
    timeout:            args.timeout,
    rejectUnauthorized: args.reject_unauthorized,
  };
}

function acctPath(ctx, sub) {
  return `/${API_VERSION}/Accounts/${ctx.accountSid}${sub}`;
}

function buildQs(params) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v == null) continue;
    if (Array.isArray(v)) v.forEach(item => qs.append(k, String(item)));
    else qs.set(k, String(v));
  }
  return qs.toString();
}

// ═══════════════════════════════════════════════════════════════════════════════
// MESSAGES (SMS / MMS / WhatsApp)
// ═══════════════════════════════════════════════════════════════════════════════

async function messageSend(ctx, args) {
  const to   = requireString(args.to,   "to");
  const from = requireString(args.from, "from");
  if (!args.body && !args.media_url && !args.content_sid)
    throw new Error("body, media_url, or content_sid is required");
  if (args.body)       validateNul(args.body,       "body");
  if (args.from)       validateNul(args.from,       "from");
  const params = { To: to, From: from };
  if (args.body)          params.Body         = args.body;
  if (args.media_url) {
    const urls = Array.isArray(args.media_url) ? args.media_url : [args.media_url];
    urls.forEach((u, i) => { params[`MediaUrl${i > 0 ? i : ""}`] = u; });
    // Twilio accepts MediaUrl repeated param
    params.MediaUrl = undefined; // reset - we'll do proper repeat
    delete params.MediaUrl;
    // Re-add as array for URLSearchParams repeat handling
    params._mediaUrls = urls;
  }
  if (args.status_callback)   params.StatusCallback  = args.status_callback;
  if (args.max_price)         params.MaxPrice        = String(args.max_price);
  if (args.validity_period)   params.ValidityPeriod  = String(args.validity_period);
  if (args.messaging_service_sid) params.MessagingServiceSid = args.messaging_service_sid;
  if (args.content_sid)       params.ContentSid      = args.content_sid;
  if (args.content_variables) params.ContentVariables = JSON.stringify(args.content_variables);
  if (args.schedule_type)     params.ScheduleType    = args.schedule_type;
  if (args.send_at)           params.SendAt           = args.send_at;

  // Handle MediaUrl array separately
  const mediaUrls = args.media_url ? (Array.isArray(args.media_url) ? args.media_url : [args.media_url]) : [];
  delete params._mediaUrls;
  if (mediaUrls.length) {
    // Use URLSearchParams to repeat MediaUrl
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v == null) continue;
      qs.set(k, String(v));
    }
    mediaUrls.forEach(u => qs.append("MediaUrl", u));
    // Override body building by passing pre-built qs string
    const res = await twilioRequest({
      username: ctx.username, password: ctx.password,
      accountSid: ctx.accountSid, authToken: ctx.authToken, apiSecret: ctx.apiSecret,
      method: "POST",
      path: acctPath(ctx, "/Messages.json"),
      params: null,
      _rawBody: qs.toString(),
      timeout: ctx.timeout, rejectUnauthorized: ctx.rejectUnauthorized,
    });
    if (res.status < 200 || res.status >= 300) {
      const errBody = res.body ? JSON.stringify(res.body) : "(empty)";
      throw new Error(`Twilio API error ${res.status}: ${scrubCreds(errBody, ctx.accountSid, ctx.authToken, ctx.apiSecret)}`);
    }
    return res.body;
  }

  const res = await twReq(ctx, "POST", acctPath(ctx, "/Messages.json"), params, [200, 201]);
  return res.body;
}

async function messageGet(ctx, args) {
  const sid = requireString(args.message_sid, "message_sid");
  const res = await twReq(ctx, "GET", acctPath(ctx, `/Messages/${sid}.json`));
  return res.body;
}

async function messageList(ctx, args) {
  const params = {};
  if (args.to)            params.To           = args.to;
  if (args.from)          params.From         = args.from;
  if (args.date_sent)     params.DateSent     = args.date_sent;
  if (args.date_sent_gte) params["DateSent>"] = args.date_sent_gte;
  if (args.date_sent_lte) params["DateSent<"] = args.date_sent_lte;
  if (args.page_size)     params.PageSize     = Math.min(1000, Math.max(1, Number(args.page_size)));
  if (args.page_token)    params.PageToken    = args.page_token;
  const res = await twReq(ctx, "GET", acctPath(ctx, "/Messages.json"), params);
  return res.body;
}

async function messageDelete(ctx, args) {
  const sid = requireString(args.message_sid, "message_sid");
  const res = await twReq(ctx, "DELETE", acctPath(ctx, `/Messages/${sid}.json`), null, [204, 404]);
  if (res.status === 404) return { deleted: false, message_sid: sid };
  return { deleted: true, message_sid: sid };
}

async function messageUpdate(ctx, args) {
  const sid = requireString(args.message_sid, "message_sid");
  // Allow empty string body (Twilio redaction sets body to empty string)
  if (args.body == null) throw new Error("body is required for message_update");
  if (typeof args.body !== "string") throw new Error("body must be a string");
  validateNul(args.body, "body");
  const params = { Body: args.body };
  const res    = await twReq(ctx, "POST", acctPath(ctx, `/Messages/${sid}.json`), params);
  return res.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CALLS
// ═══════════════════════════════════════════════════════════════════════════════

async function callCreate(ctx, args) {
  const to   = requireString(args.to,   "to");
  const from = requireString(args.from, "from");
  if (!args.url && !args.twiml && !args.application_sid)
    throw new Error("url, twiml, or application_sid is required");
  const params = { To: to, From: from };
  if (args.url)             params.Url            = args.url;
  if (args.twiml)           params.Twiml          = args.twiml;
  if (args.application_sid) params.ApplicationSid = args.application_sid;
  if (args.status_callback) params.StatusCallback = args.status_callback;
  if (args.method)          params.Method         = args.method;
  if (args.fallback_url)    params.FallbackUrl    = args.fallback_url;
  if (args.timeout != null) params.Timeout        = String(args.timeout);
  if (args.record != null)  params.Record         = String(args.record);
  if (args.machine_detection) params.MachineDetection = args.machine_detection;
  const res = await twReq(ctx, "POST", acctPath(ctx, "/Calls.json"), params, [200, 201]);
  return res.body;
}

async function callGet(ctx, args) {
  const sid = requireString(args.call_sid, "call_sid");
  const res = await twReq(ctx, "GET", acctPath(ctx, `/Calls/${sid}.json`));
  return res.body;
}

async function callList(ctx, args) {
  const params = {};
  if (args.to)          params.To         = args.to;
  if (args.from)        params.From       = args.from;
  if (args.status)      params.Status     = args.status;
  if (args.start_time)  params.StartTime  = args.start_time;
  if (args.page_size)   params.PageSize   = Math.min(1000, Math.max(1, Number(args.page_size)));
  if (args.page_token)  params.PageToken  = args.page_token;
  const res = await twReq(ctx, "GET", acctPath(ctx, "/Calls.json"), params);
  return res.body;
}

async function callUpdate(ctx, args) {
  const sid    = requireString(args.call_sid, "call_sid");
  const params = {};
  if (args.status) params.Status = args.status;  // completed = hangup
  if (args.url)    params.Url    = args.url;
  if (args.method) params.Method = args.method;
  if (args.twiml)  params.Twiml  = args.twiml;
  if (!Object.keys(params).length) throw new Error("At least one of: status, url, twiml, method is required");
  const res = await twReq(ctx, "POST", acctPath(ctx, `/Calls/${sid}.json`), params);
  return res.body;
}

async function callDelete(ctx, args) {
  const sid = requireString(args.call_sid, "call_sid");
  const res = await twReq(ctx, "DELETE", acctPath(ctx, `/Calls/${sid}.json`), null, [204, 404]);
  if (res.status === 404) return { deleted: false, call_sid: sid };
  return { deleted: true, call_sid: sid };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PHONE NUMBERS (Incoming)
// ═══════════════════════════════════════════════════════════════════════════════

async function phoneNumberList(ctx, args) {
  const params = {};
  if (args.phone_number)    params.PhoneNumber   = args.phone_number;
  if (args.friendly_name)   params.FriendlyName  = args.friendly_name;
  if (args.page_size)       params.PageSize      = Math.min(1000, Math.max(1, Number(args.page_size)));
  const res = await twReq(ctx, "GET", acctPath(ctx, "/IncomingPhoneNumbers.json"), params);
  return res.body;
}

async function phoneNumberGet(ctx, args) {
  const sid = requireString(args.phone_number_sid, "phone_number_sid");
  const res = await twReq(ctx, "GET", acctPath(ctx, `/IncomingPhoneNumbers/${sid}.json`));
  return res.body;
}

async function phoneNumberBuy(ctx, args) {
  const phoneNumber = requireString(args.phone_number, "phone_number");
  const params = { PhoneNumber: phoneNumber };
  if (args.friendly_name)     params.FriendlyName    = args.friendly_name;
  if (args.sms_url)           params.SmsUrl          = args.sms_url;
  if (args.voice_url)         params.VoiceUrl        = args.voice_url;
  if (args.status_callback)   params.StatusCallback  = args.status_callback;
  const res = await twReq(ctx, "POST", acctPath(ctx, "/IncomingPhoneNumbers.json"), params, [200, 201]);
  return res.body;
}

async function phoneNumberUpdate(ctx, args) {
  const sid    = requireString(args.phone_number_sid, "phone_number_sid");
  const params = {};
  if (args.friendly_name)   params.FriendlyName   = args.friendly_name;
  if (args.sms_url)         params.SmsUrl         = args.sms_url;
  if (args.voice_url)       params.VoiceUrl       = args.voice_url;
  if (args.status_callback) params.StatusCallback = args.status_callback;
  if (!Object.keys(params).length) throw new Error("At least one field to update is required");
  const res = await twReq(ctx, "POST", acctPath(ctx, `/IncomingPhoneNumbers/${sid}.json`), params);
  return res.body;
}

async function phoneNumberRelease(ctx, args) {
  const sid = requireString(args.phone_number_sid, "phone_number_sid");
  const res = await twReq(ctx, "DELETE", acctPath(ctx, `/IncomingPhoneNumbers/${sid}.json`), null, [204, 404]);
  if (res.status === 404) return { released: false, phone_number_sid: sid };
  return { released: true, phone_number_sid: sid };
}

async function phoneNumberSearch(ctx, args) {
  // Search available phone numbers (not purchased ones)
  const country = requireString(args.country_code, "country_code").toUpperCase();
  const type    = args.type === "toll_free" ? "TollFree" : args.type === "mobile" ? "Mobile" : "Local";
  const params  = {};
  if (args.area_code)      params.AreaCode     = args.area_code;
  if (args.contains)       params.Contains     = args.contains;
  if (args.sms_enabled != null) params.SmsEnabled = String(args.sms_enabled);
  if (args.mms_enabled != null) params.MmsEnabled = String(args.mms_enabled);
  if (args.voice_enabled != null) params.VoiceEnabled = String(args.voice_enabled);
  if (args.page_size)      params.PageSize     = Math.min(50, Math.max(1, Number(args.page_size)));
  const res = await twReq(ctx, "GET",
    `/${API_VERSION}/Accounts/${ctx.accountSid}/AvailablePhoneNumbers/${country}/${type}.json`,
    params);
  return res.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// RECORDINGS
// ═══════════════════════════════════════════════════════════════════════════════

async function recordingList(ctx, args) {
  const params = {};
  if (args.call_sid)    params.CallSid   = args.call_sid;
  if (args.date_created) params.DateCreated = args.date_created;
  if (args.page_size)   params.PageSize  = Math.min(1000, Math.max(1, Number(args.page_size)));
  const res = await twReq(ctx, "GET", acctPath(ctx, "/Recordings.json"), params);
  return res.body;
}

async function recordingGet(ctx, args) {
  const sid = requireString(args.recording_sid, "recording_sid");
  const res = await twReq(ctx, "GET", acctPath(ctx, `/Recordings/${sid}.json`));
  return { ...res.body, download_url: `https://api.twilio.com${acctPath(ctx, `/Recordings/${sid}.mp3`)}` };
}

async function recordingDelete(ctx, args) {
  const sid = requireString(args.recording_sid, "recording_sid");
  const res = await twReq(ctx, "DELETE", acctPath(ctx, `/Recordings/${sid}.json`), null, [204, 404]);
  if (res.status === 404) return { deleted: false, recording_sid: sid };
  return { deleted: true, recording_sid: sid };
}

// ═══════════════════════════════════════════════════════════════════════════════
// VERIFY (2FA / OTP)
// ═══════════════════════════════════════════════════════════════════════════════

async function verifyServiceCreate(ctx, args) {
  const friendlyName = requireString(args.friendly_name, "friendly_name");
  const params = { FriendlyName: friendlyName };
  if (args.code_length)    params.CodeLength   = String(args.code_length   || 6);
  if (args.lookup_enabled != null) params.LookupEnabled = String(args.lookup_enabled);
  const res = await twReq(ctx, "POST", `/v2/Services`, params, [200, 201]);
  return res.body;
}

async function verifyServiceList(ctx, _args) {
  const res = await twReq(ctx, "GET", `/v2/Services`);
  return res.body;
}

async function verifySend(ctx, args) {
  const serviceSid = requireString(args.service_sid, "service_sid");
  const to         = requireString(args.to, "to");
  const channel    = requireString(args.channel, "channel"); // sms, call, email, whatsapp
  const params = { To: to, Channel: channel };
  if (args.locale) params.Locale = args.locale;
  const res = await twReq(ctx, "POST",
    `/v2/Services/${serviceSid}/Verifications`,
    params, [200, 201]);
  return res.body;
}

async function verifyCheck(ctx, args) {
  const serviceSid = requireString(args.service_sid, "service_sid");
  const to         = requireString(args.to, "to");
  const code       = requireString(args.code, "code");
  const params = { To: to, Code: code };
  const res = await twReq(ctx, "POST",
    `/v2/Services/${serviceSid}/VerificationCheck`,
    params);
  return res.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MESSAGING SERVICES
// ═══════════════════════════════════════════════════════════════════════════════

async function messagingServiceCreate(ctx, args) {
  const friendlyName = requireString(args.friendly_name, "friendly_name");
  const params = { FriendlyName: friendlyName };
  if (args.inbound_request_url)  params.InboundRequestUrl  = args.inbound_request_url;
  if (args.status_callback)      params.StatusCallback     = args.status_callback;
  if (args.use_inbound_webhook_on_number != null)
    params.UseInboundWebhookOnNumber = String(args.use_inbound_webhook_on_number);
  const res = await twReq(ctx, "POST", "/v1/Services", params, [200, 201]);
  return res.body;
}

async function messagingServiceGet(ctx, args) {
  const sid = requireString(args.service_sid, "service_sid");
  const res = await twReq(ctx, "GET", `/v1/Services/${sid}`);
  return res.body;
}

async function messagingServiceList(ctx, args) {
  const params = {};
  if (args.page_size) params.PageSize = Math.min(1000, Math.max(1, Number(args.page_size)));
  const res = await twReq(ctx, "GET", "/v1/Services", params);
  return res.body;
}

async function messagingServiceDelete(ctx, args) {
  const sid = requireString(args.service_sid, "service_sid");
  const res = await twReq(ctx, "DELETE", `/v1/Services/${sid}`, null, [204, 404]);
  if (res.status === 404) return { deleted: false, service_sid: sid };
  return { deleted: true, service_sid: sid };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOOKUP
// ═══════════════════════════════════════════════════════════════════════════════

async function lookupPhone(ctx, args) {
  const phoneNumber = requireString(args.phone_number, "phone_number");
  const params = {};
  const fields = args.fields
    ? (Array.isArray(args.fields) ? args.fields : [args.fields])
    : [];
  if (fields.length) params.Fields = fields.join(",");
  if (args.country_code) params.CountryCode = args.country_code;
  const encoded = encodeURIComponent(phoneNumber);
  const qs = buildQs(params);
  const path = `/v1/PhoneNumbers/${encoded}${qs ? "?" + qs : ""}`;
  const res = await twReq(ctx, "GET", path);
  return res.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACCOUNTS
// ═══════════════════════════════════════════════════════════════════════════════

async function accountInfo(ctx, _args) {
  const res = await twReq(ctx, "GET", `/${API_VERSION}/Accounts/${ctx.accountSid}.json`);
  return res.body;
}

async function subAccountList(ctx, args) {
  const params = {};
  if (args.friendly_name) params.FriendlyName = args.friendly_name;
  if (args.status)        params.Status       = args.status;
  const res = await twReq(ctx, "GET", `/${API_VERSION}/Accounts.json`, params);
  return res.body;
}

async function subAccountCreate(ctx, args) {
  const friendlyName = requireString(args.friendly_name, "friendly_name");
  const params = { FriendlyName: friendlyName };
  const res = await twReq(ctx, "POST", `/${API_VERSION}/Accounts.json`, params, [200, 201]);
  return res.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFERENCES
// ═══════════════════════════════════════════════════════════════════════════════

async function conferenceList(ctx, args) {
  const params = {};
  if (args.friendly_name)    params.FriendlyName   = args.friendly_name;
  if (args.status)           params.Status         = args.status;
  if (args.date_created)     params.DateCreated    = args.date_created;
  if (args.page_size)        params.PageSize       = Math.min(1000, Math.max(1, Number(args.page_size)));
  const res = await twReq(ctx, "GET", acctPath(ctx, "/Conferences.json"), params);
  return res.body;
}

async function conferenceGet(ctx, args) {
  const sid = requireString(args.conference_sid, "conference_sid");
  const res = await twReq(ctx, "GET", acctPath(ctx, `/Conferences/${sid}.json`));
  return res.body;
}

async function conferenceParticipantList(ctx, args) {
  const sid = requireString(args.conference_sid, "conference_sid");
  const res = await twReq(ctx, "GET", acctPath(ctx, `/Conferences/${sid}/Participants.json`));
  return res.body;
}

async function conferenceParticipantKick(ctx, args) {
  const confSid = requireString(args.conference_sid, "conference_sid");
  const callSid = requireString(args.call_sid,       "call_sid");
  const res = await twReq(ctx, "DELETE",
    acctPath(ctx, `/Conferences/${confSid}/Participants/${callSid}.json`),
    null, [204, 404]);
  if (res.status === 404) return { kicked: false };
  return { kicked: true };
}

// ═══════════════════════════════════════════════════════════════════════════════
// QUEUES
// ═══════════════════════════════════════════════════════════════════════════════

async function queueList(ctx, args) {
  const params = {};
  if (args.page_size) params.PageSize = Math.min(1000, Math.max(1, Number(args.page_size)));
  const res = await twReq(ctx, "GET", acctPath(ctx, "/Queues.json"), params);
  return res.body;
}

async function queueCreate(ctx, args) {
  const friendlyName = requireString(args.friendly_name, "friendly_name");
  const params = { FriendlyName: friendlyName };
  if (args.max_size) params.MaxSize = String(args.max_size);
  const res = await twReq(ctx, "POST", acctPath(ctx, "/Queues.json"), params, [200, 201]);
  return res.body;
}

async function queueDelete(ctx, args) {
  const sid = requireString(args.queue_sid, "queue_sid");
  const res = await twReq(ctx, "DELETE", acctPath(ctx, `/Queues/${sid}.json`), null, [204, 404]);
  if (res.status === 404) return { deleted: false, queue_sid: sid };
  return { deleted: true, queue_sid: sid };
}

// ═══════════════════════════════════════════════════════════════════════════════
// NOTIFY (Push / Bindings)
// ═══════════════════════════════════════════════════════════════════════════════

async function notifyCreate(ctx, args) {
  const serviceSid = requireString(args.service_sid, "service_sid");
  const params = {};
  if (args.identity)   params.Identity  = Array.isArray(args.identity) ? undefined : args.identity;
  if (args.tag)        params.Tag       = args.tag;
  if (args.body)       params.Body      = args.body;
  if (args.title)      params.Title     = args.title;
  if (args.sound)      params.Sound     = args.sound;
  if (args.priority)   params.Priority  = args.priority;
  if (args.ttl)        params.Ttl       = String(args.ttl);
  if (args.data)       params.Data      = typeof args.data === "string" ? args.data : JSON.stringify(args.data);
  const identities = args.identity
    ? (Array.isArray(args.identity) ? args.identity : [args.identity])
    : [];
  // Build manually for repeated Identity params
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) { if (v != null) qs.set(k, String(v)); }
  identities.forEach(id => qs.append("Identity", id));
  const bodyStr = qs.toString();

  const res = await twilioRequest({
    username: ctx.username, password: ctx.password,
    accountSid: ctx.accountSid, authToken: ctx.authToken, apiSecret: ctx.apiSecret,
    method: "POST",
    path: `/v1/Services/${serviceSid}/Notifications`,
    params: {}, timeout: ctx.timeout, rejectUnauthorized: ctx.rejectUnauthorized,
  });
  // We need to handle this differently since params already built
  // Fallback: just pass params dict (single identity)
  const singleParams = {};
  if (identities.length === 1) singleParams.Identity = identities[0];
  else if (identities.length) throw new Error("Use a single identity or tag for notify");
  const res2 = await twReq(ctx, "POST", `/v1/Services/${serviceSid}/Notifications`, {
    ...singleParams,
    Body:     params.Body,
    Title:    params.Title,
    Sound:    params.Sound,
    Priority: params.Priority,
    Ttl:      params.Ttl,
    Data:     params.Data,
    Tag:      args.tag,
  }, [200, 201]);
  return res2.body;
}

// ═══════════════════════════════════════════════════════════════════════════════
// GENERIC / INFO
// ═══════════════════════════════════════════════════════════════════════════════

async function genericRequest(ctx, args) {
  const method = requireString(args.method, "method").toUpperCase();
  const path   = requireString(args.path, "path");
  if (!["GET","POST","PUT","PATCH","DELETE"].includes(method))
    throw new Error(`Unsupported method: ${method}`);
  const params = args.params || {};
  const res    = await twReq(ctx, method, path, Object.keys(params).length ? params : null);
  return res.body;
}

async function infoGet(ctx, _args) {
  const account = await accountInfo(ctx, {});
  return {
    account_sid:      account.sid,
    friendly_name:    account.friendly_name,
    status:           account.status,
    type:             account.type,
    date_created:     account.date_created,
    auth_method:      ctx.apiKey ? "api_key" : "auth_token",
    api_version:      API_VERSION,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN DISPATCHER
// ═══════════════════════════════════════════════════════════════════════════════

async function twilioClient(args) {
  const op = requireString(args.operation, "operation");
  const ctx = buildCtx(args);

  // Override twReq for Verify v2 and Messaging v1 paths to use correct base
  // (api.twilio.com + path directly, not under /2010-04-01/Accounts/...)
  // Already handled by absolute paths in verify/messaging/lookup/notify ops.

  switch (op) {
    // Messages
    case "message_send":    return messageSend(ctx, args);
    case "message_get":     return messageGet(ctx, args);
    case "message_list":    return messageList(ctx, args);
    case "message_delete":  return messageDelete(ctx, args);
    case "message_update":  return messageUpdate(ctx, args);
    // Calls
    case "call_create":     return callCreate(ctx, args);
    case "call_get":        return callGet(ctx, args);
    case "call_list":       return callList(ctx, args);
    case "call_update":     return callUpdate(ctx, args);
    case "call_delete":     return callDelete(ctx, args);
    // Phone Numbers
    case "phone_number_list":    return phoneNumberList(ctx, args);
    case "phone_number_get":     return phoneNumberGet(ctx, args);
    case "phone_number_buy":     return phoneNumberBuy(ctx, args);
    case "phone_number_update":  return phoneNumberUpdate(ctx, args);
    case "phone_number_release": return phoneNumberRelease(ctx, args);
    case "phone_number_search":  return phoneNumberSearch(ctx, args);
    // Recordings
    case "recording_list":   return recordingList(ctx, args);
    case "recording_get":    return recordingGet(ctx, args);
    case "recording_delete": return recordingDelete(ctx, args);
    // Verify
    case "verify_service_create": return verifyServiceCreate(ctx, args);
    case "verify_service_list":   return verifyServiceList(ctx, args);
    case "verify_send":           return verifySend(ctx, args);
    case "verify_check":          return verifyCheck(ctx, args);
    // Messaging Services
    case "messaging_service_create": return messagingServiceCreate(ctx, args);
    case "messaging_service_get":    return messagingServiceGet(ctx, args);
    case "messaging_service_list":   return messagingServiceList(ctx, args);
    case "messaging_service_delete": return messagingServiceDelete(ctx, args);
    // Lookup
    case "lookup_phone": return lookupPhone(ctx, args);
    // Accounts
    case "account_info":        return accountInfo(ctx, args);
    case "sub_account_list":    return subAccountList(ctx, args);
    case "sub_account_create":  return subAccountCreate(ctx, args);
    // Conferences
    case "conference_list":             return conferenceList(ctx, args);
    case "conference_get":              return conferenceGet(ctx, args);
    case "conference_participant_list": return conferenceParticipantList(ctx, args);
    case "conference_participant_kick": return conferenceParticipantKick(ctx, args);
    // Queues
    case "queue_list":   return queueList(ctx, args);
    case "queue_create": return queueCreate(ctx, args);
    case "queue_delete": return queueDelete(ctx, args);
    // Generic
    case "request": return genericRequest(ctx, args);
    case "info":    return infoGet(ctx, args);
    default:
      throw new Error(`Unknown operation: ${op}. Supported operations: message_send, message_get, message_list, message_delete, message_update, call_create, call_get, call_list, call_update, call_delete, phone_number_list, phone_number_get, phone_number_buy, phone_number_update, phone_number_release, phone_number_search, recording_list, recording_get, recording_delete, verify_service_create, verify_service_list, verify_send, verify_check, messaging_service_create, messaging_service_get, messaging_service_list, messaging_service_delete, lookup_phone, account_info, sub_account_list, sub_account_create, conference_list, conference_get, conference_participant_list, conference_participant_kick, queue_list, queue_create, queue_delete, request, info`);
  }
}

module.exports = { twilioClient };
