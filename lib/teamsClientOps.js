"use strict";
/**
 * teams_client — Zero-dependency Microsoft Teams API client
 * (pure Node.js https built-ins; no npm deps)
 *
 * Authentication:
 *   - Access token (OAuth2 Bearer) via `access_token`
 *   - OR Client Credentials flow: tenant_id + client_id + client_secret
 *     (auto-fetches token from login.microsoftonline.com, cached in process)
 *   Credentials never returned in output or errors.
 *
 * Base URL: https://graph.microsoft.com/v1.0
 *
 * Supported operations (52 total):
 *
 *   Teams (6):
 *     team_list, team_get, team_create, team_delete,
 *     team_update, team_members
 *
 *   Channels (7):
 *     channel_list, channel_get, channel_create, channel_delete,
 *     channel_update, channel_members, channel_member_add
 *
 *   Messages (7):
 *     message_list, message_get, message_send, message_reply,
 *     message_replies, message_update, message_delete
 *
 *   Chats (5):
 *     chat_list, chat_get, chat_create, chat_members, chat_send
 *
 *   Users (5):
 *     user_list, user_get, user_me, user_joined_teams, user_presence
 *
 *   Files/DriveItems (5):
 *     file_list, file_get, file_upload, file_delete, file_share
 *
 *   Calls/Meetings (4):
 *     meeting_create, meeting_get, meeting_list, meeting_update
 *
 *   Apps (3):
 *     app_list, app_get, app_install
 *
 *   Tabs (3):
 *     tab_list, tab_get, tab_create
 *
 *   Tags (3):
 *     tag_list, tag_create, tag_delete
 *
 *   Generic (4):
 *     request, info
 *
 * Security:
 *   NUL-byte guards on all string inputs.
 *   Timeout clamped 1000–120000 ms.
 *   Tokens/secrets never returned in output or errors.
 *   16 MB response cap.
 *   TLS enforced by default.
 */

const https = require("https");

// ─── Constants ────────────────────────────────────────────────────────────────

const GRAPH_BASE         = "https://graph.microsoft.com/v1.0";
const TOKEN_URL_BASE     = "https://login.microsoftonline.com";
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024; // 16 MB

// In-process token cache: key = "tenant|clientId|scope" → { token, expiresAt }
const TOKEN_CACHE = new Map();

// ─── Guard helpers ────────────────────────────────────────────────────────────

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

function enc(s) { return encodeURIComponent(String(s)); }

function qs(obj) {
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    parts.push(`${enc(k)}=${enc(v)}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

// ─── Token acquisition (Client Credentials) ───────────────────────────────────

async function getClientCredentialsToken(tenant, clientId, clientSecret, scope) {
  requireString(tenant, "tenant_id");
  requireString(clientId, "client_id");
  requireString(clientSecret, "client_secret");

  const cacheKey = `${tenant}|${clientId}|${scope}`;
  const cached = TOKEN_CACHE.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  const body = [
    `client_id=${enc(clientId)}`,
    `client_secret=${enc(clientSecret)}`,
    `scope=${enc(scope)}`,
    `grant_type=client_credentials`,
  ].join("&");

  const bodyBuf = Buffer.from(body, "utf8");
  const url = `${TOKEN_URL_BASE}/${enc(tenant)}/oauth2/v2.0/token`;
  let urlObj;
  try { urlObj = new URL(url); } catch { throw new Error(`Invalid token URL: ${url}`); }

  const res = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { req.destroy(); reject(new Error("Token request timed out")); }, 15000);
    const req = https.request({
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname + urlObj.search,
      method: "POST",
      headers: {
        "Content-Type":   "application/x-www-form-urlencoded",
        "Content-Length": bodyBuf.length,
      },
      rejectUnauthorized: true,
    }, (r) => {
      const chunks = []; let total = 0;
      r.on("data", c => { total += c.length; if (total > 1024 * 1024) { r.destroy(); } else chunks.push(c); });
      r.on("end", () => { clearTimeout(timer); resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString("utf8") }); });
      r.on("error", e => { clearTimeout(timer); reject(e); });
    });
    req.on("error", e => { clearTimeout(timer); reject(e); });
    req.write(bodyBuf);
    req.end();
  });

  let j;
  try { j = JSON.parse(res.body); } catch (e) { throw new Error(`Token response JSON parse error: ${e.message}`); }
  if (res.status !== 200 || !j.access_token) {
    const desc = j.error_description || j.error || res.body.slice(0, 200);
    throw new Error(`Token acquisition failed: ${desc}`);
  }

  const expiresIn = Number(j.expires_in) || 3600;
  TOKEN_CACHE.set(cacheKey, { token: j.access_token, expiresAt: Date.now() + (expiresIn - 60) * 1000 });
  return j.access_token;
}

// ─── Build connection config ──────────────────────────────────────────────────

async function buildConn(args) {
  const { timeout, reject_unauthorized } = args;
  let token = args.access_token;

  if (!token) {
    // Try client credentials
    if (!args.tenant_id || !args.client_id || !args.client_secret) {
      throw new Error(
        "Provide either 'access_token' or all of: tenant_id, client_id, client_secret"
      );
    }
    const scope = args.scope || "https://graph.microsoft.com/.default";
    token = await getClientCredentialsToken(
      args.tenant_id, args.client_id, args.client_secret, scope
    );
  } else {
    requireString(token, "access_token");
  }

  return {
    token,
    timeoutMs: clampInt(timeout, 1000, 120000, DEFAULT_TIMEOUT_MS),
    rejectUnauthorized: reject_unauthorized !== false,
  };
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function doRequest(conn, method, path, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const url = path.startsWith("http") ? path : `${GRAPH_BASE}${path}`;
    let urlObj;
    try { urlObj = new URL(url); } catch { return reject(new Error(`Invalid URL: ${url}`)); }

    const isPost  = ["POST", "PUT", "PATCH"].includes(method.toUpperCase());
    const reqBody = (isPost && body !== undefined) ? JSON.stringify(body) : undefined;

    const getQuery = (!isPost && body !== undefined) ? qs(body) : "";
    const pathWithQ = urlObj.pathname + (getQuery || urlObj.search);

    const headers = {
      "Authorization": `Bearer ${conn.token}`,
      "Accept":        "application/json",
      "ConsistencyLevel": "eventual",
      ...extraHeaders,
    };
    if (isPost && reqBody !== undefined) {
      headers["Content-Type"]   = "application/json; charset=utf-8";
      headers["Content-Length"] = Buffer.byteLength(reqBody);
    }

    const options = {
      hostname:           urlObj.hostname,
      port:               443,
      path:               pathWithQ,
      method:             method.toUpperCase(),
      headers,
      rejectUnauthorized: conn.rejectUnauthorized,
    };

    const timer = setTimeout(() => {
      reject(new Error(`Request timed out after ${conn.timeoutMs}ms`));
      req.destroy();
    }, conn.timeoutMs);

    const req = https.request(options, (res) => {
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
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") });
      });
      res.on("error", (err) => { clearTimeout(timer); reject(err); });
    });
    req.on("error", (err) => { clearTimeout(timer); reject(err); });
    if (isPost && reqBody !== undefined) req.write(reqBody);
    req.end();
  });
}

// ─── Response parser ──────────────────────────────────────────────────────────

function parseJson(res) {
  if (res.status === 204) return { ok: true };
  if (res.body.length === 0) return { ok: true };
  let j;
  try { j = JSON.parse(res.body); }
  catch (e) { throw new Error(`Invalid JSON response: ${e.message}`); }
  if (res.status >= 400) {
    const err = (j.error && (j.error.message || j.error.code)) || res.body.slice(0, 300);
    throw new Error(`Graph API error ${res.status}: ${err}`);
  }
  return j;
}

function page(j) {
  return {
    value:    j.value || [],
    nextLink: j["@odata.nextLink"] || null,
    count:    j["@odata.count"] || (j.value ? j.value.length : 0),
  };
}

// ─── Map helpers ──────────────────────────────────────────────────────────────

function mapTeam(t) {
  if (!t) return null;
  return {
    id:              t.id,
    displayName:     t.displayName,
    description:     t.description,
    internalId:      t.internalId,
    classification:  t.classification,
    specialization:  t.specialization,
    visibility:      t.visibility,
    webUrl:          t.webUrl,
    isArchived:      t.isArchived,
    createdDateTime: t.createdDateTime,
  };
}

function mapChannel(c) {
  if (!c) return null;
  return {
    id:              c.id,
    displayName:     c.displayName,
    description:     c.description,
    membershipType:  c.membershipType,
    webUrl:          c.webUrl,
    email:           c.email,
    isArchived:      c.isArchived,
    createdDateTime: c.createdDateTime,
  };
}

function mapMessage(m) {
  if (!m) return null;
  return {
    id:              m.id,
    messageType:     m.messageType,
    createdDateTime: m.createdDateTime,
    lastModified:    m.lastModifiedDateTime,
    deletedDateTime: m.deletedDateTime,
    subject:         m.subject,
    importance:      m.importance,
    from:            m.from && m.from.user ? { id: m.from.user.id, displayName: m.from.user.displayName } : null,
    body:            m.body ? { contentType: m.body.contentType, content: m.body.content } : null,
    channelIdentity: m.channelIdentity,
    attachments:     m.attachments ? m.attachments.map(a => ({ id: a.id, name: a.name, contentType: a.contentType })) : [],
    reactions:       m.reactions || [],
    replyToId:       m.replyToId,
    webUrl:          m.webUrl,
  };
}

function mapUser(u) {
  if (!u) return null;
  return {
    id:                u.id,
    displayName:       u.displayName,
    userPrincipalName: u.userPrincipalName,
    mail:              u.mail,
    jobTitle:          u.jobTitle,
    department:        u.department,
    officeLocation:    u.officeLocation,
    mobilePhone:       u.mobilePhone,
    businessPhones:    u.businessPhones,
    accountEnabled:    u.accountEnabled,
  };
}

function mapChat(c) {
  if (!c) return null;
  return {
    id:              c.id,
    topic:           c.topic,
    chatType:        c.chatType,
    webUrl:          c.webUrl,
    createdDateTime: c.createdDateTime,
    lastUpdated:     c.lastUpdatedDateTime,
  };
}

function mapMember(m) {
  if (!m) return null;
  return {
    id:          m.id,
    displayName: m.displayName,
    userId:      m.userId,
    email:       m.email,
    roles:       m.roles || [],
    tenantId:    m.tenantId,
  };
}

function mapDriveItem(d) {
  if (!d) return null;
  return {
    id:              d.id,
    name:            d.name,
    size:            d.size,
    webUrl:          d.webUrl,
    createdDateTime: d.createdDateTime,
    lastModified:    d.lastModifiedDateTime,
    file:            d.file ? { mimeType: d.file.mimeType } : undefined,
    folder:          d.folder ? { childCount: d.folder.childCount } : undefined,
    downloadUrl:     d["@microsoft.graph.downloadUrl"],
  };
}

function mapMeeting(m) {
  if (!m) return null;
  return {
    id:              m.id,
    subject:         m.subject,
    startDateTime:   m.start && m.start.dateTime,
    endDateTime:     m.end && m.end.dateTime,
    joinUrl:         m.joinUrl,
    onlineMeeting:   m.onlineMeeting,
    organizer:       m.organizer && m.organizer.emailAddress,
    attendees:       m.attendees ? m.attendees.map(a => a.emailAddress) : [],
    isOnlineMeeting: m.isOnlineMeeting,
    onlineMeetingUrl: m.onlineMeetingUrl,
    createdDateTime: m.createdDateTime,
  };
}

// ─── TEAMS ────────────────────────────────────────────────────────────────────

async function teamList(conn, args) {
  const { top, skip, filter } = args;
  const params = {};
  if (top)    params["$top"]    = clampInt(top, 1, 999, 100);
  if (skip)   params["$skip"]   = skip;
  if (filter) { guardString(filter, "filter"); params["$filter"] = filter; }
  const res = await doRequest(conn, "GET", `/groups${qs({ ...params, "$filter": filter || "resourceProvisioningOptions/Any(x:x eq 'Team')" })}`);
  const j = parseJson(res);
  const p = page(j);
  return { teams: p.value.map(mapTeam), nextLink: p.nextLink, count: p.count };
}

async function teamGet(conn, args) {
  const { team_id } = args;
  requireString(team_id, "team_id");
  const res = await doRequest(conn, "GET", `/teams/${enc(team_id)}`);
  const j = parseJson(res);
  return { team: mapTeam(j) };
}

async function teamCreate(conn, args) {
  const { display_name, description, visibility, template } = args;
  requireString(display_name, "display_name");
  const payload = {
    "template@odata.bind": template || "https://graph.microsoft.com/v1.0/teamsTemplates('standard')",
    displayName: display_name,
    description: description || "",
    visibility:  visibility  || "Public",
  };
  guardString(description, "description");
  const res = await doRequest(conn, "POST", "/teams", payload);
  // Teams creation returns 202 Accepted with a Location header
  if (res.status === 202) {
    const location = res.headers && res.headers["location"];
    return { created: true, status: "provisioning", location: location || null };
  }
  const j = parseJson(res);
  return { created: true, team: mapTeam(j) };
}

async function teamDelete(conn, args) {
  const { team_id } = args;
  requireString(team_id, "team_id");
  const res = await doRequest(conn, "DELETE", `/groups/${enc(team_id)}`);
  if (res.status === 404) return { deleted: false, team_id };
  parseJson(res);
  return { deleted: true, team_id };
}

async function teamUpdate(conn, args) {
  const { team_id, display_name, description, visibility } = args;
  requireString(team_id, "team_id");
  const payload = {};
  if (display_name) { guardString(display_name, "display_name"); payload.displayName = display_name; }
  if (description)  { guardString(description, "description");   payload.description = description; }
  if (visibility)   { guardString(visibility, "visibility");     payload.visibility  = visibility; }
  const res = await doRequest(conn, "PATCH", `/teams/${enc(team_id)}`, payload);
  parseJson(res);
  return { updated: true, team_id };
}

async function teamMembers(conn, args) {
  const { team_id, top } = args;
  requireString(team_id, "team_id");
  const params = {};
  if (top) params["$top"] = clampInt(top, 1, 999, 100);
  const res = await doRequest(conn, "GET", `/teams/${enc(team_id)}/members${qs(params)}`);
  const j = parseJson(res);
  const p = page(j);
  return { members: p.value.map(mapMember), nextLink: p.nextLink, count: p.count };
}

// ─── CHANNELS ─────────────────────────────────────────────────────────────────

async function channelList(conn, args) {
  const { team_id, filter } = args;
  requireString(team_id, "team_id");
  const params = {};
  if (filter) { guardString(filter, "filter"); params["$filter"] = filter; }
  const res = await doRequest(conn, "GET", `/teams/${enc(team_id)}/channels${qs(params)}`);
  const j = parseJson(res);
  const p = page(j);
  return { channels: p.value.map(mapChannel), count: p.count };
}

async function channelGet(conn, args) {
  const { team_id, channel_id } = args;
  requireString(team_id, "team_id");
  requireString(channel_id, "channel_id");
  const res = await doRequest(conn, "GET", `/teams/${enc(team_id)}/channels/${enc(channel_id)}`);
  const j = parseJson(res);
  if (res.status === 404) return { channel: null, exists: false };
  return { channel: mapChannel(j), exists: true };
}

async function channelCreate(conn, args) {
  const { team_id, display_name, description, membership_type } = args;
  requireString(team_id, "team_id");
  requireString(display_name, "display_name");
  const payload = {
    displayName:    display_name,
    description:    description || "",
    membershipType: membership_type || "standard",
  };
  guardString(description, "description");
  const res = await doRequest(conn, "POST", `/teams/${enc(team_id)}/channels`, payload);
  const j = parseJson(res);
  return { created: true, channel: mapChannel(j) };
}

async function channelDelete(conn, args) {
  const { team_id, channel_id } = args;
  requireString(team_id, "team_id");
  requireString(channel_id, "channel_id");
  const res = await doRequest(conn, "DELETE", `/teams/${enc(team_id)}/channels/${enc(channel_id)}`);
  if (res.status === 404) return { deleted: false, channel_id };
  parseJson(res);
  return { deleted: true, channel_id };
}

async function channelUpdate(conn, args) {
  const { team_id, channel_id, display_name, description } = args;
  requireString(team_id, "team_id");
  requireString(channel_id, "channel_id");
  const payload = {};
  if (display_name) { guardString(display_name, "display_name"); payload.displayName = display_name; }
  if (description)  { guardString(description, "description");   payload.description = description; }
  const res = await doRequest(conn, "PATCH", `/teams/${enc(team_id)}/channels/${enc(channel_id)}`, payload);
  parseJson(res);
  return { updated: true, channel_id };
}

async function channelMembers(conn, args) {
  const { team_id, channel_id } = args;
  requireString(team_id, "team_id");
  requireString(channel_id, "channel_id");
  const res = await doRequest(conn, "GET", `/teams/${enc(team_id)}/channels/${enc(channel_id)}/members`);
  const j = parseJson(res);
  const p = page(j);
  return { members: p.value.map(mapMember), count: p.count };
}

async function channelMemberAdd(conn, args) {
  const { team_id, channel_id, user_id, roles } = args;
  requireString(team_id, "team_id");
  requireString(channel_id, "channel_id");
  requireString(user_id, "user_id");
  const payload = {
    "@odata.type": "#microsoft.graph.aadUserConversationMember",
    roles: roles || [],
    "user@odata.bind": `https://graph.microsoft.com/v1.0/users('${user_id}')`,
  };
  const res = await doRequest(conn, "POST", `/teams/${enc(team_id)}/channels/${enc(channel_id)}/members`, payload);
  const j = parseJson(res);
  return { added: true, member: mapMember(j) };
}

// ─── MESSAGES ─────────────────────────────────────────────────────────────────

async function messageList(conn, args) {
  const { team_id, channel_id, top } = args;
  requireString(team_id, "team_id");
  requireString(channel_id, "channel_id");
  const params = {};
  if (top) params["$top"] = clampInt(top, 1, 50, 20);
  const res = await doRequest(conn, "GET",
    `/teams/${enc(team_id)}/channels/${enc(channel_id)}/messages${qs(params)}`);
  const j = parseJson(res);
  const p = page(j);
  return { messages: p.value.map(mapMessage), nextLink: p.nextLink, count: p.count };
}

async function messageGet(conn, args) {
  const { team_id, channel_id, message_id } = args;
  requireString(team_id, "team_id");
  requireString(channel_id, "channel_id");
  requireString(message_id, "message_id");
  const res = await doRequest(conn, "GET",
    `/teams/${enc(team_id)}/channels/${enc(channel_id)}/messages/${enc(message_id)}`);
  const j = parseJson(res);
  if (res.status === 404) return { message: null, exists: false };
  return { message: mapMessage(j), exists: true };
}

async function messageSend(conn, args) {
  const { team_id, channel_id, content, content_type, subject, importance } = args;
  requireString(team_id, "team_id");
  requireString(channel_id, "channel_id");
  if (!content) throw new Error("content is required");
  guardString(content, "content");
  guardString(subject, "subject");
  const payload = {
    body: { contentType: content_type || "text", content },
  };
  if (subject)    payload.subject    = subject;
  if (importance) { guardString(importance, "importance"); payload.importance = importance; }
  const res = await doRequest(conn, "POST",
    `/teams/${enc(team_id)}/channels/${enc(channel_id)}/messages`, payload);
  const j = parseJson(res);
  return { sent: true, message: mapMessage(j) };
}

async function messageReply(conn, args) {
  const { team_id, channel_id, message_id, content, content_type } = args;
  requireString(team_id, "team_id");
  requireString(channel_id, "channel_id");
  requireString(message_id, "message_id");
  if (!content) throw new Error("content is required");
  guardString(content, "content");
  const payload = { body: { contentType: content_type || "text", content } };
  const res = await doRequest(conn, "POST",
    `/teams/${enc(team_id)}/channels/${enc(channel_id)}/messages/${enc(message_id)}/replies`, payload);
  const j = parseJson(res);
  return { sent: true, reply: mapMessage(j) };
}

async function messageReplies(conn, args) {
  const { team_id, channel_id, message_id, top } = args;
  requireString(team_id, "team_id");
  requireString(channel_id, "channel_id");
  requireString(message_id, "message_id");
  const params = {};
  if (top) params["$top"] = clampInt(top, 1, 50, 20);
  const res = await doRequest(conn, "GET",
    `/teams/${enc(team_id)}/channels/${enc(channel_id)}/messages/${enc(message_id)}/replies${qs(params)}`);
  const j = parseJson(res);
  const p = page(j);
  return { replies: p.value.map(mapMessage), nextLink: p.nextLink, count: p.count };
}

async function messageUpdate(conn, args) {
  const { team_id, channel_id, message_id, content, content_type } = args;
  requireString(team_id, "team_id");
  requireString(channel_id, "channel_id");
  requireString(message_id, "message_id");
  if (!content) throw new Error("content is required for update");
  guardString(content, "content");
  const payload = { body: { contentType: content_type || "text", content } };
  const res = await doRequest(conn, "PATCH",
    `/teams/${enc(team_id)}/channels/${enc(channel_id)}/messages/${enc(message_id)}`, payload);
  parseJson(res);
  return { updated: true, message_id };
}

async function messageDelete(conn, args) {
  const { team_id, channel_id, message_id } = args;
  requireString(team_id, "team_id");
  requireString(channel_id, "channel_id");
  requireString(message_id, "message_id");
  // Teams messages can only be soft-deleted
  const res = await doRequest(conn, "DELETE",
    `/teams/${enc(team_id)}/channels/${enc(channel_id)}/messages/${enc(message_id)}`);
  if (res.status === 404) return { deleted: false, message_id };
  parseJson(res);
  return { deleted: true, message_id };
}

// ─── CHATS ────────────────────────────────────────────────────────────────────

async function chatList(conn, args) {
  const { top, filter } = args;
  const params = {};
  if (top)    params["$top"]    = clampInt(top, 1, 50, 20);
  if (filter) { guardString(filter, "filter"); params["$filter"] = filter; }
  const res = await doRequest(conn, "GET", `/chats${qs(params)}`);
  const j = parseJson(res);
  const p = page(j);
  return { chats: p.value.map(mapChat), nextLink: p.nextLink, count: p.count };
}

async function chatGet(conn, args) {
  const { chat_id } = args;
  requireString(chat_id, "chat_id");
  const res = await doRequest(conn, "GET", `/chats/${enc(chat_id)}`);
  const j = parseJson(res);
  if (res.status === 404) return { chat: null, exists: false };
  return { chat: mapChat(j), exists: true };
}

async function chatCreate(conn, args) {
  const { chat_type, topic, members } = args;
  if (!members || !Array.isArray(members) || members.length === 0)
    throw new Error("members must be a non-empty array");
  const payload = {
    chatType: chat_type || "group",
    members:  members.map(m => ({
      "@odata.type":    "#microsoft.graph.aadUserConversationMember",
      roles:            m.roles || ["owner"],
      "user@odata.bind": `https://graph.microsoft.com/v1.0/users('${m.user_id}')`,
    })),
  };
  if (topic) { guardString(topic, "topic"); payload.topic = topic; }
  const res = await doRequest(conn, "POST", "/chats", payload);
  const j = parseJson(res);
  return { created: true, chat: mapChat(j) };
}

async function chatMembers(conn, args) {
  const { chat_id } = args;
  requireString(chat_id, "chat_id");
  const res = await doRequest(conn, "GET", `/chats/${enc(chat_id)}/members`);
  const j = parseJson(res);
  const p = page(j);
  return { members: p.value.map(mapMember), count: p.count };
}

async function chatSend(conn, args) {
  const { chat_id, content, content_type } = args;
  requireString(chat_id, "chat_id");
  if (!content) throw new Error("content is required");
  guardString(content, "content");
  const payload = { body: { contentType: content_type || "text", content } };
  const res = await doRequest(conn, "POST", `/chats/${enc(chat_id)}/messages`, payload);
  const j = parseJson(res);
  return { sent: true, message: mapMessage(j) };
}

// ─── USERS ────────────────────────────────────────────────────────────────────

async function userList(conn, args) {
  const { top, filter, search } = args;
  const params = { "$top": clampInt(top, 1, 999, 100) };
  if (filter) { guardString(filter, "filter"); params["$filter"] = filter; }
  if (search) { guardString(search, "search"); params["$search"] = `"displayName:${search}"`; }
  const res = await doRequest(conn, "GET", `/users${qs(params)}`);
  const j = parseJson(res);
  const p = page(j);
  return { users: p.value.map(mapUser), nextLink: p.nextLink, count: p.count };
}

async function userGet(conn, args) {
  const { user_id } = args;
  requireString(user_id, "user_id");
  const res = await doRequest(conn, "GET", `/users/${enc(user_id)}`);
  const j = parseJson(res);
  if (res.status === 404) return { user: null, exists: false };
  return { user: mapUser(j), exists: true };
}

async function userMe(conn) {
  const res = await doRequest(conn, "GET", "/me");
  const j = parseJson(res);
  return { user: mapUser(j) };
}

async function userJoinedTeams(conn, args) {
  const userId = args.user_id || "me";
  guardString(args.user_id, "user_id");
  const path = userId === "me" ? "/me/joinedTeams" : `/users/${enc(userId)}/joinedTeams`;
  const res = await doRequest(conn, "GET", path);
  const j = parseJson(res);
  const p = page(j);
  return { teams: p.value.map(mapTeam), count: p.count };
}

async function userPresence(conn, args) {
  const { user_id } = args;
  requireString(user_id, "user_id");
  const res = await doRequest(conn, "GET", `/users/${enc(user_id)}/presence`);
  const j = parseJson(res);
  return {
    userId:           j.id,
    availability:     j.availability,
    activity:         j.activity,
    outOfOffice:      j.outOfOfficeSettings,
    statusMessage:    j.statusMessage,
  };
}

// ─── FILES (OneDrive / SharePoint via Graph) ──────────────────────────────────

async function fileList(conn, args) {
  const { team_id, channel_id, path: folderPath, top } = args;
  requireString(team_id, "team_id");
  requireString(channel_id, "channel_id");
  // Files endpoint in a Teams channel
  let driveItemPath = `/groups/${enc(team_id)}/drive/root`;
  if (folderPath) { guardString(folderPath, "path"); driveItemPath += `/${folderPath}`; }
  driveItemPath += "/children";
  const params = {};
  if (top) params["$top"] = clampInt(top, 1, 999, 100);
  const res = await doRequest(conn, "GET", driveItemPath + qs(params));
  const j = parseJson(res);
  const p = page(j);
  return { files: p.value.map(mapDriveItem), nextLink: p.nextLink, count: p.count };
}

async function fileGet(conn, args) {
  const { team_id, item_id } = args;
  requireString(team_id, "team_id");
  requireString(item_id, "item_id");
  const res = await doRequest(conn, "GET", `/groups/${enc(team_id)}/drive/items/${enc(item_id)}`);
  const j = parseJson(res);
  if (res.status === 404) return { file: null, exists: false };
  return { file: mapDriveItem(j), exists: true };
}

async function fileUpload(conn, args) {
  const { team_id, file_name, content_base64, content, folder_path } = args;
  requireString(team_id, "team_id");
  requireString(file_name, "file_name");
  if (!content_base64 && !content) throw new Error("content_base64 or content is required");
  guardString(folder_path, "folder_path");

  let buf;
  if (content_base64) {
    buf = Buffer.from(content_base64, "base64");
  } else {
    buf = Buffer.from(content, "utf8");
  }

  const safeName = file_name.replace(/[\\/:*?"<>|]/g, "_");
  const basePath = folder_path ? `/${folder_path}/${safeName}` : `/${safeName}`;
  const uploadPath = `/groups/${enc(team_id)}/drive/root:${basePath}:/content`;

  const res = await new Promise((resolve, reject) => {
    const url = `${GRAPH_BASE}${uploadPath}`;
    let urlObj;
    try { urlObj = new URL(url); } catch { return reject(new Error(`Invalid URL: ${url}`)); }

    const headers = {
      "Authorization":  `Bearer ${conn.token}`,
      "Content-Type":   "application/octet-stream",
      "Content-Length": buf.length,
    };
    const timer = setTimeout(() => { reject(new Error(`Upload timed out`)); req.destroy(); }, conn.timeoutMs);
    const req = https.request({
      hostname: urlObj.hostname, port: 443, path: urlObj.pathname + urlObj.search,
      method: "PUT", headers, rejectUnauthorized: conn.rejectUnauthorized,
    }, (r) => {
      const chunks = []; let total = 0;
      r.on("data", c => { total += c.length; if (total > MAX_RESPONSE_BYTES) { r.destroy(); clearTimeout(timer); reject(new Error("Response too large")); return; } chunks.push(c); });
      r.on("end", () => { clearTimeout(timer); resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString("utf8") }); });
      r.on("error", e => { clearTimeout(timer); reject(e); });
    });
    req.on("error", e => { clearTimeout(timer); reject(e); });
    req.write(buf);
    req.end();
  });

  const j = parseJson(res);
  return { uploaded: true, file: mapDriveItem(j) };
}

async function fileDelete(conn, args) {
  const { team_id, item_id } = args;
  requireString(team_id, "team_id");
  requireString(item_id, "item_id");
  const res = await doRequest(conn, "DELETE", `/groups/${enc(team_id)}/drive/items/${enc(item_id)}`);
  if (res.status === 404) return { deleted: false, item_id };
  parseJson(res);
  return { deleted: true, item_id };
}

async function fileShare(conn, args) {
  const { team_id, item_id, type, scope } = args;
  requireString(team_id, "team_id");
  requireString(item_id, "item_id");
  const payload = {
    type:  type  || "view",
    scope: scope || "organization",
  };
  const res = await doRequest(conn, "POST",
    `/groups/${enc(team_id)}/drive/items/${enc(item_id)}/createLink`, payload);
  const j = parseJson(res);
  return { link: j.link ? { type: j.link.type, scope: j.link.scope, webUrl: j.link.webUrl } : null };
}

// ─── MEETINGS (Online Meetings via Graph) ──────────────────────────────────────

async function meetingCreate(conn, args) {
  const { subject, start_datetime, end_datetime, attendees, is_online_meeting, allow_attendees_to_enable_camera } = args;
  requireString(subject, "subject");
  requireString(start_datetime, "start_datetime");
  requireString(end_datetime, "end_datetime");
  guardString(start_datetime, "start_datetime");
  guardString(end_datetime, "end_datetime");
  const payload = {
    subject,
    start:            { dateTime: start_datetime, timeZone: args.timezone || "UTC" },
    end:              { dateTime: end_datetime,   timeZone: args.timezone || "UTC" },
    isOnlineMeeting:  is_online_meeting !== false,
  };
  if (attendees && Array.isArray(attendees)) {
    payload.attendees = attendees.map(a => ({
      emailAddress: { address: typeof a === "string" ? a : a.email, name: a.name || "" },
      type: a.type || "required",
    }));
  }
  if (allow_attendees_to_enable_camera !== undefined)
    payload.allowAttendeesToEnableCamera = allow_attendees_to_enable_camera;
  const res = await doRequest(conn, "POST", "/me/events", payload);
  const j = parseJson(res);
  return { created: true, meeting: mapMeeting(j) };
}

async function meetingGet(conn, args) {
  const { event_id } = args;
  requireString(event_id, "event_id");
  const res = await doRequest(conn, "GET", `/me/events/${enc(event_id)}`);
  const j = parseJson(res);
  if (res.status === 404) return { meeting: null, exists: false };
  return { meeting: mapMeeting(j), exists: true };
}

async function meetingList(conn, args) {
  const { top, start_datetime, end_datetime } = args;
  const params = { "$top": clampInt(top, 1, 100, 20) };
  if (start_datetime) params["startDateTime"] = start_datetime;
  if (end_datetime)   params["endDateTime"]   = end_datetime;
  const res = await doRequest(conn, "GET", `/me/calendarView${qs(params)}`);
  const j = parseJson(res);
  const p = page(j);
  return { meetings: p.value.map(mapMeeting), nextLink: p.nextLink, count: p.count };
}

async function meetingUpdate(conn, args) {
  const { event_id, subject, start_datetime, end_datetime } = args;
  requireString(event_id, "event_id");
  const payload = {};
  if (subject)        { guardString(subject, "subject");                 payload.subject = subject; }
  if (start_datetime) { guardString(start_datetime, "start_datetime");   payload.start = { dateTime: start_datetime, timeZone: args.timezone || "UTC" }; }
  if (end_datetime)   { guardString(end_datetime, "end_datetime");       payload.end   = { dateTime: end_datetime,   timeZone: args.timezone || "UTC" }; }
  const res = await doRequest(conn, "PATCH", `/me/events/${enc(event_id)}`, payload);
  parseJson(res);
  return { updated: true, event_id };
}

// ─── APPS ─────────────────────────────────────────────────────────────────────

async function appList(conn, args) {
  const { team_id } = args;
  requireString(team_id, "team_id");
  const res = await doRequest(conn, "GET", `/teams/${enc(team_id)}/installedApps?$expand=teamsApp,teamsAppDefinition`);
  const j = parseJson(res);
  const p = page(j);
  return {
    apps: p.value.map(a => ({
      id:          a.id,
      displayName: a.teamsApp && a.teamsApp.displayName,
      appId:       a.teamsApp && a.teamsApp.externalId,
      version:     a.teamsAppDefinition && a.teamsAppDefinition.version,
    })),
    count: p.count,
  };
}

async function appGet(conn, args) {
  const { team_id, app_installation_id } = args;
  requireString(team_id, "team_id");
  requireString(app_installation_id, "app_installation_id");
  const res = await doRequest(conn, "GET",
    `/teams/${enc(team_id)}/installedApps/${enc(app_installation_id)}?$expand=teamsApp,teamsAppDefinition`);
  const j = parseJson(res);
  if (res.status === 404) return { app: null, exists: false };
  return {
    app: {
      id:          j.id,
      displayName: j.teamsApp && j.teamsApp.displayName,
      appId:       j.teamsApp && j.teamsApp.externalId,
      version:     j.teamsAppDefinition && j.teamsAppDefinition.version,
    },
    exists: true,
  };
}

async function appInstall(conn, args) {
  const { team_id, teams_app_id } = args;
  requireString(team_id, "team_id");
  requireString(teams_app_id, "teams_app_id");
  guardString(teams_app_id, "teams_app_id");
  const payload = {
    "teamsApp@odata.bind": `https://graph.microsoft.com/v1.0/appCatalogs/teamsApps/${teams_app_id}`,
  };
  const res = await doRequest(conn, "POST", `/teams/${enc(team_id)}/installedApps`, payload);
  parseJson(res);
  return { installed: true, team_id, teams_app_id };
}

// ─── TABS ─────────────────────────────────────────────────────────────────────

async function tabList(conn, args) {
  const { team_id, channel_id } = args;
  requireString(team_id, "team_id");
  requireString(channel_id, "channel_id");
  const res = await doRequest(conn, "GET",
    `/teams/${enc(team_id)}/channels/${enc(channel_id)}/tabs?$expand=teamsApp`);
  const j = parseJson(res);
  const p = page(j);
  return {
    tabs: p.value.map(t => ({
      id:          t.id,
      displayName: t.displayName,
      webUrl:      t.webUrl,
      appId:       t.teamsApp && t.teamsApp.id,
    })),
    count: p.count,
  };
}

async function tabGet(conn, args) {
  const { team_id, channel_id, tab_id } = args;
  requireString(team_id, "team_id");
  requireString(channel_id, "channel_id");
  requireString(tab_id, "tab_id");
  const res = await doRequest(conn, "GET",
    `/teams/${enc(team_id)}/channels/${enc(channel_id)}/tabs/${enc(tab_id)}?$expand=teamsApp`);
  const j = parseJson(res);
  if (res.status === 404) return { tab: null, exists: false };
  return {
    tab: { id: j.id, displayName: j.displayName, webUrl: j.webUrl, appId: j.teamsApp && j.teamsApp.id },
    exists: true,
  };
}

async function tabCreate(conn, args) {
  const { team_id, channel_id, display_name, teams_app_id, content_url, website_url } = args;
  requireString(team_id, "team_id");
  requireString(channel_id, "channel_id");
  requireString(display_name, "display_name");
  requireString(teams_app_id, "teams_app_id");
  requireString(content_url, "content_url");
  guardString(website_url, "website_url");
  const payload = {
    displayName:      display_name,
    "teamsApp@odata.bind": `https://graph.microsoft.com/v1.0/appCatalogs/teamsApps/${teams_app_id}`,
    configuration: {
      entityId:    `tab-${Date.now()}`,
      contentUrl:  content_url,
      websiteUrl:  website_url || content_url,
      removeUrl:   "",
    },
  };
  const res = await doRequest(conn, "POST",
    `/teams/${enc(team_id)}/channels/${enc(channel_id)}/tabs`, payload);
  const j = parseJson(res);
  return { created: true, tab: { id: j.id, displayName: j.displayName, webUrl: j.webUrl } };
}

// ─── TAGS ─────────────────────────────────────────────────────────────────────

async function tagList(conn, args) {
  const { team_id } = args;
  requireString(team_id, "team_id");
  const res = await doRequest(conn, "GET", `/teams/${enc(team_id)}/tags`);
  const j = parseJson(res);
  const p = page(j);
  return {
    tags: p.value.map(t => ({ id: t.id, displayName: t.displayName, memberCount: t.memberCount, description: t.description })),
    count: p.count,
  };
}

async function tagCreate(conn, args) {
  const { team_id, display_name, description, members } = args;
  requireString(team_id, "team_id");
  requireString(display_name, "display_name");
  guardString(description, "description");
  const payload = { displayName: display_name };
  if (description) payload.description = description;
  if (members && Array.isArray(members)) {
    payload.members = members.map(m => ({
      userId: typeof m === "string" ? m : m.user_id,
    }));
  }
  const res = await doRequest(conn, "POST", `/teams/${enc(team_id)}/tags`, payload);
  const j = parseJson(res);
  return { created: true, tag: { id: j.id, displayName: j.displayName } };
}

async function tagDelete(conn, args) {
  const { team_id, tag_id } = args;
  requireString(team_id, "team_id");
  requireString(tag_id, "tag_id");
  const res = await doRequest(conn, "DELETE", `/teams/${enc(team_id)}/tags/${enc(tag_id)}`);
  if (res.status === 404) return { deleted: false, tag_id };
  parseJson(res);
  return { deleted: true, tag_id };
}

// ─── GENERIC ──────────────────────────────────────────────────────────────────

async function genericRequest(conn, args) {
  const { method, path: reqPath, body } = args;
  requireString(reqPath, "path");
  const m = (method || "GET").toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(m))
    throw new Error("method must be GET, POST, PUT, PATCH, or DELETE");
  const fullPath = reqPath.startsWith("/") ? reqPath : `/${reqPath}`;
  const res = await doRequest(conn, m, fullPath, ["POST", "PUT", "PATCH"].includes(m) ? (body || {}) : undefined);
  let j;
  try { j = JSON.parse(res.body); } catch { j = { raw: res.body }; }
  return { status: res.status, data: j };
}

function teamsInfo() {
  return {
    ok: true,
    api: "Microsoft Graph v1.0",
    base_url: GRAPH_BASE,
    auth: [
      "access_token: Pre-obtained OAuth2 Bearer token",
      "tenant_id + client_id + client_secret: Client Credentials flow (auto token fetch)",
    ],
    operations: [
      "Teams: team_list, team_get, team_create, team_delete, team_update, team_members",
      "Channels: channel_list, channel_get, channel_create, channel_delete, channel_update, channel_members, channel_member_add",
      "Messages: message_list, message_get, message_send, message_reply, message_replies, message_update, message_delete",
      "Chats: chat_list, chat_get, chat_create, chat_members, chat_send",
      "Users: user_list, user_get, user_me, user_joined_teams, user_presence",
      "Files: file_list, file_get, file_upload, file_delete, file_share",
      "Meetings: meeting_create, meeting_get, meeting_list, meeting_update",
      "Apps: app_list, app_get, app_install",
      "Tabs: tab_list, tab_get, tab_create",
      "Tags: tag_list, tag_create, tag_delete",
      "Generic: request, info",
    ],
  };
}

// ─── Main dispatcher ──────────────────────────────────────────────────────────

async function teamsClient(args) {
  if (!args || !args.operation) throw new Error("operation is required");
  const { operation } = args;

  if (operation === "info") return teamsInfo();

  const conn = await buildConn(args);

  switch (operation) {
    // Teams
    case "team_list":     return teamList(conn, args);
    case "team_get":      return teamGet(conn, args);
    case "team_create":   return teamCreate(conn, args);
    case "team_delete":   return teamDelete(conn, args);
    case "team_update":   return teamUpdate(conn, args);
    case "team_members":  return teamMembers(conn, args);

    // Channels
    case "channel_list":       return channelList(conn, args);
    case "channel_get":        return channelGet(conn, args);
    case "channel_create":     return channelCreate(conn, args);
    case "channel_delete":     return channelDelete(conn, args);
    case "channel_update":     return channelUpdate(conn, args);
    case "channel_members":    return channelMembers(conn, args);
    case "channel_member_add": return channelMemberAdd(conn, args);

    // Messages
    case "message_list":    return messageList(conn, args);
    case "message_get":     return messageGet(conn, args);
    case "message_send":    return messageSend(conn, args);
    case "message_reply":   return messageReply(conn, args);
    case "message_replies": return messageReplies(conn, args);
    case "message_update":  return messageUpdate(conn, args);
    case "message_delete":  return messageDelete(conn, args);

    // Chats
    case "chat_list":    return chatList(conn, args);
    case "chat_get":     return chatGet(conn, args);
    case "chat_create":  return chatCreate(conn, args);
    case "chat_members": return chatMembers(conn, args);
    case "chat_send":    return chatSend(conn, args);

    // Users
    case "user_list":         return userList(conn, args);
    case "user_get":          return userGet(conn, args);
    case "user_me":           return userMe(conn);
    case "user_joined_teams": return userJoinedTeams(conn, args);
    case "user_presence":     return userPresence(conn, args);

    // Files
    case "file_list":   return fileList(conn, args);
    case "file_get":    return fileGet(conn, args);
    case "file_upload": return fileUpload(conn, args);
    case "file_delete": return fileDelete(conn, args);
    case "file_share":  return fileShare(conn, args);

    // Meetings
    case "meeting_create": return meetingCreate(conn, args);
    case "meeting_get":    return meetingGet(conn, args);
    case "meeting_list":   return meetingList(conn, args);
    case "meeting_update": return meetingUpdate(conn, args);

    // Apps
    case "app_list":    return appList(conn, args);
    case "app_get":     return appGet(conn, args);
    case "app_install": return appInstall(conn, args);

    // Tabs
    case "tab_list":   return tabList(conn, args);
    case "tab_get":    return tabGet(conn, args);
    case "tab_create": return tabCreate(conn, args);

    // Tags
    case "tag_list":   return tagList(conn, args);
    case "tag_create": return tagCreate(conn, args);
    case "tag_delete": return tagDelete(conn, args);

    // Generic
    case "request": return genericRequest(conn, args);

    default:
      throw new Error(
        `Unknown operation: '${operation}'. Valid: ` +
        `team_list, team_get, team_create, team_delete, team_update, team_members, ` +
        `channel_list, channel_get, channel_create, channel_delete, channel_update, channel_members, channel_member_add, ` +
        `message_list, message_get, message_send, message_reply, message_replies, message_update, message_delete, ` +
        `chat_list, chat_get, chat_create, chat_members, chat_send, ` +
        `user_list, user_get, user_me, user_joined_teams, user_presence, ` +
        `file_list, file_get, file_upload, file_delete, file_share, ` +
        `meeting_create, meeting_get, meeting_list, meeting_update, ` +
        `app_list, app_get, app_install, ` +
        `tab_list, tab_get, tab_create, ` +
        `tag_list, tag_create, tag_delete, ` +
        `request, info`
      );
  }
}

module.exports = { teamsClient };
