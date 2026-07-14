"use strict";
/**
 * slack_client — Zero-dependency Slack Web API client
 * (pure Node.js https built-ins; no npm deps)
 *
 * Authentication:
 *   - Bot Token (xoxb-...) — most operations, passed as `token`
 *   - User Token (xoxp-...) — some user-scoped operations
 *   Authorization: Bearer <token>
 *   Tokens never returned in output or errors.
 *
 * Base URL: https://slack.com/api/<method>
 *
 * Supported operations (51 total):
 *
 *   Messages (8):
 *     message_post, message_update, message_delete, message_reply,
 *     messages_history, message_permalink, message_search, message_scheduled_list
 *
 *   Channels/Conversations (9):
 *     channel_list, channel_get, channel_create, channel_archive,
 *     channel_unarchive, channel_invite, channel_join, channel_leave,
 *     channel_rename
 *
 *   Users (5):
 *     user_list, user_get, user_me, user_set_status, user_lookup_by_email
 *
 *   Files (5):
 *     file_list, file_get, file_upload, file_delete, file_share
 *
 *   Reactions (4):
 *     reaction_add, reaction_remove, reaction_list, reaction_get
 *
 *   Pins (2):
 *     pin_add, pin_remove
 *
 *   Reminders (3):
 *     reminder_add, reminder_list, reminder_delete
 *
 *   Usergroups (3):
 *     usergroup_list, usergroup_create, usergroup_update
 *
 *   Workspace/Meta (5):
 *     team_info, emoji_list, bot_info, app_info, auth_test
 *
 *   Bookmarks (2):
 *     bookmark_add, bookmark_list
 *
 *   Stars (2):
 *     star_add, star_remove
 *
 *   DMs (3):
 *     dm_open, dm_close, dm_history
 *
 *   Generic (1):
 *     request
 *
 * Security:
 *   NUL-byte guards on all string inputs.
 *   Timeout clamped 1000–120000 ms.
 *   Tokens never returned in output or errors.
 *   16 MB response cap.
 *   TLS enforced by default.
 */

const https = require("https");

// --- Constants ---------------------------------------------------------------

const SLACK_API_BASE      = "https://slack.com/api";
const DEFAULT_TIMEOUT_MS  = 20000;
const MAX_RESPONSE_BYTES  = 16 * 1024 * 1024; // 16 MB

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

function guardArray(val, name) {
  if (val === undefined || val === null) return;
  if (!Array.isArray(val)) throw new Error(`${name} must be an array`);
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
    if (Array.isArray(v)) {
      for (const item of v) parts.push(`${enc(k)}=${enc(item)}`);
    } else {
      parts.push(`${enc(k)}=${enc(v)}`);
    }
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

// --- Build connection config -------------------------------------------------

function buildConn(args) {
  const { token, timeout, reject_unauthorized } = args;
  requireString(token, "token");
  return {
    token,
    timeoutMs: clampInt(timeout, 1000, 120000, DEFAULT_TIMEOUT_MS),
    rejectUnauthorized: reject_unauthorized !== false,
  };
}

// --- HTTP helper -------------------------------------------------------------

function doRequest(conn, method, apiMethod, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const url  = `${SLACK_API_BASE}/${apiMethod}`;
    let urlObj;
    try { urlObj = new URL(url); } catch { return reject(new Error(`Invalid URL: ${url}`)); }

    const isPost   = method.toUpperCase() === "POST";
    const reqBody  = (isPost && body !== undefined) ? JSON.stringify(body) : undefined;

    // For GET, append body params as query string
    const getQuery = (!isPost && body !== undefined)
      ? qs(body)
      : "";
    const pathWithQ = urlObj.pathname + (getQuery || urlObj.search);

    const headers = {
      "Authorization": `Bearer ${conn.token}`,
      "Accept":        "application/json",
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
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
      res.on("error", (err) => { clearTimeout(timer); reject(err); });
    });

    req.on("error", (err) => { clearTimeout(timer); reject(err); });
    if (isPost && reqBody !== undefined) req.write(reqBody);
    req.end();
  });
}

// --- Multipart POST for file upload -----------------------------------------

function doMultipartRequest(conn, apiMethod, fields, fileBuffer, filename, mediaType) {
  return new Promise((resolve, reject) => {
    const url = `${SLACK_API_BASE}/${apiMethod}`;
    const boundary = `----SlackBoundary${Date.now().toString(36)}`;
    const parts = [];

    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || v === null) continue;
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`
      ));
    }

    if (fileBuffer) {
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: ${mediaType || "application/octet-stream"}\r\n\r\n`
      ));
      parts.push(fileBuffer);
      parts.push(Buffer.from("\r\n"));
    }

    parts.push(Buffer.from(`--${boundary}--\r\n`));
    const bodyBuf = Buffer.concat(parts);

    let urlObj;
    try { urlObj = new URL(url); } catch { return reject(new Error(`Invalid URL: ${url}`)); }

    const headers = {
      "Authorization":  `Bearer ${conn.token}`,
      "Content-Type":   `multipart/form-data; boundary=${boundary}`,
      "Content-Length": bodyBuf.length,
    };

    const options = {
      hostname: urlObj.hostname, port: 443,
      path: urlObj.pathname, method: "POST",
      headers, rejectUnauthorized: conn.rejectUnauthorized,
    };

    const timer = setTimeout(() => { reject(new Error(`Upload timed out after ${conn.timeoutMs}ms`)); req.destroy(); }, conn.timeoutMs);
    const req = https.request(options, (res) => {
      const chunks = []; let total = 0;
      res.on("data", c => { total += c.length; if (total > MAX_RESPONSE_BYTES) { res.destroy(); clearTimeout(timer); reject(new Error("Response exceeded 16 MB")); return; } chunks.push(c); });
      res.on("end", () => { clearTimeout(timer); resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }); });
      res.on("error", e => { clearTimeout(timer); reject(e); });
    });
    req.on("error", e => { clearTimeout(timer); reject(e); });
    req.write(bodyBuf);
    req.end();
  });
}

// --- Slack response checker --------------------------------------------------

function parseAndCheck(res) {
  if (res.status !== 200) {
    throw new Error(`HTTP ${res.status}: ${res.body.slice(0, 300)}`);
  }
  let j;
  try { j = JSON.parse(res.body); }
  catch (e) { throw new Error(`Invalid JSON response: ${e.message}`); }
  if (!j.ok) {
    const detail = j.error || j.warning || JSON.stringify(j).slice(0, 300);
    throw new Error(`Slack API error: ${detail}`);
  }
  return j;
}

// --- Map helpers -------------------------------------------------------------

function mapChannel(c) {
  if (!c) return null;
  return {
    id:          c.id,
    name:        c.name,
    is_channel:  c.is_channel,
    is_private:  c.is_private,
    is_archived: c.is_archived,
    is_member:   c.is_member,
    topic:       (c.topic && c.topic.value) || null,
    purpose:     (c.purpose && c.purpose.value) || null,
    num_members: c.num_members,
    created:     c.created,
  };
}

function mapUser(u) {
  if (!u) return null;
  return {
    id:          u.id,
    name:        u.name,
    real_name:   u.real_name,
    display_name: (u.profile && u.profile.display_name) || null,
    email:       (u.profile && u.profile.email) || null,
    is_bot:      u.is_bot,
    is_admin:    u.is_admin,
    deleted:     u.deleted,
    status_text: (u.profile && u.profile.status_text) || null,
    status_emoji:(u.profile && u.profile.status_emoji) || null,
    tz:          u.tz,
  };
}

function mapMessage(m) {
  if (!m) return null;
  return {
    type:      m.type,
    ts:        m.ts,
    user:      m.user,
    bot_id:    m.bot_id,
    text:      m.text,
    thread_ts: m.thread_ts,
    reply_count: m.reply_count,
    reactions:   m.reactions,
    files:       m.files ? m.files.map(f => ({ id: f.id, name: f.name, mimetype: f.mimetype })) : undefined,
  };
}

function mapFile(f) {
  if (!f) return null;
  return {
    id:        f.id,
    name:      f.name,
    title:     f.title,
    filetype:  f.filetype,
    mimetype:  f.mimetype,
    size:      f.size,
    url_private: f.url_private,
    permalink: f.permalink,
    created:   f.created,
    user:      f.user,
  };
}

// --- MESSAGES ----------------------------------------------------------------

async function messagePost(conn, args) {
  const { channel, text, blocks, thread_ts, mrkdwn, username, icon_emoji, icon_url, reply_broadcast } = args;
  requireString(channel, "channel");
  if (!text && !blocks) throw new Error("text or blocks is required");
  guardString(text, "text");
  guardString(thread_ts, "thread_ts");
  const payload = {
    channel,
    text: text || "",
    mrkdwn: mrkdwn !== false,
  };
  if (blocks)         payload.blocks = blocks;
  if (thread_ts)      payload.thread_ts = thread_ts;
  if (username)       { guardString(username, "username"); payload.username = username; }
  if (icon_emoji)     { guardString(icon_emoji, "icon_emoji"); payload.icon_emoji = icon_emoji; }
  if (icon_url)       { guardString(icon_url, "icon_url"); payload.icon_url = icon_url; }
  if (reply_broadcast) payload.reply_broadcast = true;

  const res = await doRequest(conn, "POST", "chat.postMessage", payload);
  const j   = parseAndCheck(res);
  return { posted: true, channel: j.channel, ts: j.ts, message: mapMessage(j.message) };
}

async function messageUpdate(conn, args) {
  const { channel, ts, text, blocks } = args;
  requireString(channel, "channel");
  requireString(ts, "ts");
  if (!text && !blocks) throw new Error("text or blocks is required");
  const payload = { channel, ts, text: text || "" };
  if (blocks) payload.blocks = blocks;
  const res = await doRequest(conn, "POST", "chat.update", payload);
  const j   = parseAndCheck(res);
  return { updated: true, channel: j.channel, ts: j.ts, text: j.text };
}

async function messageDelete(conn, args) {
  const { channel, ts } = args;
  requireString(channel, "channel");
  requireString(ts, "ts");
  const res = await doRequest(conn, "POST", "chat.delete", { channel, ts });
  parseAndCheck(res);
  return { deleted: true, channel, ts };
}

async function messageReply(conn, args) {
  const { channel, thread_ts, text, blocks, reply_broadcast } = args;
  requireString(channel, "channel");
  requireString(thread_ts, "thread_ts");
  if (!text && !blocks) throw new Error("text or blocks is required");
  const payload = { channel, thread_ts, text: text || "" };
  if (blocks)          payload.blocks = blocks;
  if (reply_broadcast) payload.reply_broadcast = true;
  const res = await doRequest(conn, "POST", "chat.postMessage", payload);
  const j   = parseAndCheck(res);
  return { posted: true, channel: j.channel, ts: j.ts, thread_ts };
}

async function messagesHistory(conn, args) {
  const { channel, limit, oldest, latest, inclusive, cursor } = args;
  requireString(channel, "channel");
  const params = {
    channel,
    limit: clampInt(limit, 1, 999, 100),
    oldest, latest,
    inclusive: inclusive ? "true" : undefined,
    cursor,
  };
  const res = await doRequest(conn, "GET", "conversations.history", params);
  const j   = parseAndCheck(res);
  return {
    messages: ((j.messages) || []).map(mapMessage),
    has_more: j.has_more,
    cursor:   j.response_metadata && j.response_metadata.next_cursor,
  };
}

async function messagePermalink(conn, args) {
  const { channel, message_ts } = args;
  requireString(channel, "channel");
  requireString(message_ts, "message_ts");
  const res = await doRequest(conn, "GET", "chat.getPermalink", { channel, message_ts });
  const j   = parseAndCheck(res);
  return { channel: j.channel, permalink: j.permalink };
}

async function messageSearch(conn, args) {
  const { query, sort, sort_dir, count, page, highlight } = args;
  requireString(query, "query");
  const params = {
    query,
    sort:      sort || "score",
    sort_dir:  sort_dir || "desc",
    count:     clampInt(count, 1, 100, 20),
    page:      page || 1,
    highlight: highlight ? "1" : undefined,
  };
  const res = await doRequest(conn, "GET", "search.messages", params);
  const j   = parseAndCheck(res);
  const matches = (j.messages && j.messages.matches) || [];
  return {
    total:   j.messages && j.messages.total,
    page:    j.messages && j.messages.pagination && j.messages.pagination.page,
    matches: matches.map(m => ({
      ts:        m.ts,
      channel:   m.channel && m.channel.id,
      text:      m.text,
      permalink: m.permalink,
      user:      m.user,
    })),
  };
}

async function messageScheduledList(conn, args) {
  const { channel, cursor, limit } = args;
  guardString(channel, "channel");
  const params = { limit: clampInt(limit, 1, 100, 100), cursor };
  if (channel) params.channel = channel;
  const res = await doRequest(conn, "GET", "chat.scheduledMessages.list", params);
  const j   = parseAndCheck(res);
  return {
    scheduled_messages: (j.scheduled_messages || []),
    cursor: j.response_metadata && j.response_metadata.next_cursor,
  };
}

// --- CHANNELS/CONVERSATIONS --------------------------------------------------

async function channelList(conn, args) {
  const { types, limit, cursor, exclude_archived } = args;
  const params = {
    types:            types || "public_channel,private_channel",
    limit:            clampInt(limit, 1, 1000, 200),
    cursor,
    exclude_archived: exclude_archived ? "true" : undefined,
  };
  const res = await doRequest(conn, "GET", "conversations.list", params);
  const j   = parseAndCheck(res);
  return {
    channels: ((j.channels) || []).map(mapChannel),
    cursor:   j.response_metadata && j.response_metadata.next_cursor,
  };
}

async function channelGet(conn, args) {
  const { channel } = args;
  requireString(channel, "channel");
  const res = await doRequest(conn, "GET", "conversations.info", { channel, include_num_members: "true" });
  const j   = parseAndCheck(res);
  return { channel: mapChannel(j.channel) };
}

async function channelCreate(conn, args) {
  const { name, is_private, team_id } = args;
  requireString(name, "name");
  const payload = { name, is_private: is_private === true };
  if (team_id) { guardString(team_id, "team_id"); payload.team_id = team_id; }
  const res = await doRequest(conn, "POST", "conversations.create", payload);
  const j   = parseAndCheck(res);
  return { created: true, channel: mapChannel(j.channel) };
}

async function channelArchive(conn, args) {
  const { channel } = args;
  requireString(channel, "channel");
  const res = await doRequest(conn, "POST", "conversations.archive", { channel });
  parseAndCheck(res);
  return { archived: true, channel };
}

async function channelUnarchive(conn, args) {
  const { channel } = args;
  requireString(channel, "channel");
  const res = await doRequest(conn, "POST", "conversations.unarchive", { channel });
  parseAndCheck(res);
  return { unarchived: true, channel };
}

async function channelInvite(conn, args) {
  const { channel, users } = args;
  requireString(channel, "channel");
  if (!users || (Array.isArray(users) && users.length === 0))
    throw new Error("users must be a non-empty array or comma-separated string");
  const userList = Array.isArray(users) ? users.join(",") : users;
  guardString(userList, "users");
  const res = await doRequest(conn, "POST", "conversations.invite", { channel, users: userList });
  const j   = parseAndCheck(res);
  return { invited: true, channel: mapChannel(j.channel) };
}

async function channelJoin(conn, args) {
  const { channel } = args;
  requireString(channel, "channel");
  const res = await doRequest(conn, "POST", "conversations.join", { channel });
  const j   = parseAndCheck(res);
  return { joined: true, channel: mapChannel(j.channel) };
}

async function channelLeave(conn, args) {
  const { channel } = args;
  requireString(channel, "channel");
  const res = await doRequest(conn, "POST", "conversations.leave", { channel });
  parseAndCheck(res);
  return { left: true, channel };
}

async function channelRename(conn, args) {
  const { channel, name } = args;
  requireString(channel, "channel");
  requireString(name, "name");
  const res = await doRequest(conn, "POST", "conversations.rename", { channel, name });
  const j   = parseAndCheck(res);
  return { renamed: true, channel: mapChannel(j.channel) };
}

// --- USERS -------------------------------------------------------------------

async function userList(conn, args) {
  const { limit, cursor, team_id } = args;
  const params = { limit: clampInt(limit, 1, 200, 200), cursor };
  if (team_id) { guardString(team_id, "team_id"); params.team_id = team_id; }
  const res = await doRequest(conn, "GET", "users.list", params);
  const j   = parseAndCheck(res);
  return {
    users:  ((j.members) || []).map(mapUser),
    cursor: j.response_metadata && j.response_metadata.next_cursor,
  };
}

async function userGet(conn, args) {
  const { user } = args;
  requireString(user, "user");
  const res = await doRequest(conn, "GET", "users.info", { user, include_locale: "true" });
  const j   = parseAndCheck(res);
  return { user: mapUser(j.user) };
}

async function userMe(conn) {
  const res = await doRequest(conn, "GET", "auth.test", {});
  const j   = parseAndCheck(res);
  // auth.test returns user/bot info, then we fetch full user profile
  return {
    user_id: j.user_id,
    user:    j.user,
    team:    j.team,
    team_id: j.team_id,
    bot_id:  j.bot_id,
    is_enterprise_install: j.is_enterprise_install,
  };
}

async function userSetStatus(conn, args) {
  const { status_text, status_emoji, status_expiration } = args;
  guardString(status_text, "status_text");
  guardString(status_emoji, "status_emoji");
  const profile = {
    status_text:  status_text  || "",
    status_emoji: status_emoji || "",
  };
  if (status_expiration !== undefined) {
    profile.status_expiration = Number(status_expiration) || 0;
  }
  const res = await doRequest(conn, "POST", "users.profile.set", { profile });
  parseAndCheck(res);
  return { updated: true, status_text, status_emoji };
}

async function userLookupByEmail(conn, args) {
  const { email } = args;
  requireString(email, "email");
  const res = await doRequest(conn, "GET", "users.lookupByEmail", { email });
  const j   = parseAndCheck(res);
  return { user: mapUser(j.user) };
}

// --- FILES -------------------------------------------------------------------

async function fileList(conn, args) {
  const { channel, user, types, count, page, ts_from, ts_to } = args;
  guardString(channel, "channel");
  guardString(user, "user");
  const params = {
    count:   clampInt(count, 1, 100, 20),
    page:    page || 1,
    types,
    channel,
    user,
    ts_from,
    ts_to,
  };
  const res = await doRequest(conn, "GET", "files.list", params);
  const j   = parseAndCheck(res);
  return {
    files: ((j.files) || []).map(mapFile),
    total: j.paging && j.paging.total,
    page:  j.paging && j.paging.page,
  };
}

async function fileGet(conn, args) {
  const { file } = args;
  requireString(file, "file");
  const res = await doRequest(conn, "GET", "files.info", { file });
  const j   = parseAndCheck(res);
  return { file: mapFile(j.file), comments: j.comments || [] };
}

async function fileUpload(conn, args) {
  const { filename, content_base64, content, channels, title, filetype, media_type } = args;
  requireString(filename, "filename");
  if (!content_base64 && !content)
    throw new Error("content_base64 or content (text) is required");
  guardString(channels, "channels");
  guardString(title, "title");

  const fields = { filename };
  if (channels) fields.channels = channels;
  if (title)    fields.title    = title;
  if (filetype) { guardString(filetype, "filetype"); fields.filetype = filetype; }

  let fileBuffer;
  if (content_base64) {
    fileBuffer = Buffer.from(content_base64, "base64");
  } else {
    // text content: use content param directly as form field
    fields.content = content;
    fileBuffer = null;
  }

  if (fileBuffer) {
    const res = await doMultipartRequest(conn, "files.upload", fields, fileBuffer, filename, media_type);
    let j;
    try { j = JSON.parse(res.body); } catch (e) { throw new Error(`Invalid JSON: ${e.message}`); }
    if (!j.ok) throw new Error(`Slack API error: ${j.error || JSON.stringify(j).slice(0, 200)}`);
    return { uploaded: true, file: mapFile(j.file) };
  } else {
    // Text content via form fields
    const res = await doMultipartRequest(conn, "files.upload", fields, null, null, null);
    let j;
    try { j = JSON.parse(res.body); } catch (e) { throw new Error(`Invalid JSON: ${e.message}`); }
    if (!j.ok) throw new Error(`Slack API error: ${j.error || JSON.stringify(j).slice(0, 200)}`);
    return { uploaded: true, file: mapFile(j.file) };
  }
}

async function fileDelete(conn, args) {
  const { file } = args;
  requireString(file, "file");
  const res = await doRequest(conn, "POST", "files.delete", { file });
  parseAndCheck(res);
  return { deleted: true, file };
}

async function fileShare(conn, args) {
  const { file, channels } = args;
  requireString(file, "file");
  requireString(channels, "channels");
  const res = await doRequest(conn, "POST", "files.sharedPublicURL", { file });
  const j   = parseAndCheck(res);
  return { shared: true, file: mapFile(j.file) };
}

// --- REACTIONS ---------------------------------------------------------------

async function reactionAdd(conn, args) {
  const { name, channel, timestamp } = args;
  requireString(name, "name");
  requireString(channel, "channel");
  requireString(timestamp, "timestamp");
  const res = await doRequest(conn, "POST", "reactions.add", { name, channel, timestamp });
  parseAndCheck(res);
  return { added: true, name, channel, timestamp };
}

async function reactionRemove(conn, args) {
  const { name, channel, timestamp } = args;
  requireString(name, "name");
  requireString(channel, "channel");
  requireString(timestamp, "timestamp");
  const res = await doRequest(conn, "POST", "reactions.remove", { name, channel, timestamp });
  parseAndCheck(res);
  return { removed: true, name, channel, timestamp };
}

async function reactionList(conn, args) {
  const { user, full, count, page, cursor, limit } = args;
  guardString(user, "user");
  const params = {
    full:   full ? "true" : undefined,
    count:  clampInt(count, 1, 100, 100),
    page:   page || 1,
    cursor,
    limit:  clampInt(limit, 1, 200, undefined),
    user,
  };
  const res = await doRequest(conn, "GET", "reactions.list", params);
  const j   = parseAndCheck(res);
  return {
    items:  (j.items || []),
    cursor: j.response_metadata && j.response_metadata.next_cursor,
  };
}

async function reactionGet(conn, args) {
  const { channel, timestamp, full } = args;
  requireString(channel, "channel");
  requireString(timestamp, "timestamp");
  const params = { channel, timestamp, full: full ? "true" : undefined };
  const res = await doRequest(conn, "GET", "reactions.get", params);
  const j   = parseAndCheck(res);
  return { type: j.type, message: j.message && mapMessage(j.message) };
}

// --- PINS --------------------------------------------------------------------

async function pinAdd(conn, args) {
  const { channel, timestamp } = args;
  requireString(channel, "channel");
  requireString(timestamp, "timestamp");
  const res = await doRequest(conn, "POST", "pins.add", { channel, timestamp });
  parseAndCheck(res);
  return { pinned: true, channel, timestamp };
}

async function pinRemove(conn, args) {
  const { channel, timestamp } = args;
  requireString(channel, "channel");
  requireString(timestamp, "timestamp");
  const res = await doRequest(conn, "POST", "pins.remove", { channel, timestamp });
  parseAndCheck(res);
  return { unpinned: true, channel, timestamp };
}

// --- REMINDERS ---------------------------------------------------------------

async function reminderAdd(conn, args) {
  const { text, time, user } = args;
  requireString(text, "text");
  requireString(time, "time");
  const payload = { text, time };
  if (user) { guardString(user, "user"); payload.user = user; }
  const res = await doRequest(conn, "POST", "reminders.add", payload);
  const j   = parseAndCheck(res);
  return { added: true, reminder: j.reminder };
}

async function reminderList(conn) {
  const res = await doRequest(conn, "GET", "reminders.list", {});
  const j   = parseAndCheck(res);
  return { reminders: j.reminders || [] };
}

async function reminderDelete(conn, args) {
  const { reminder } = args;
  requireString(reminder, "reminder");
  const res = await doRequest(conn, "POST", "reminders.delete", { reminder });
  parseAndCheck(res);
  return { deleted: true, reminder };
}

// --- USERGROUPS --------------------------------------------------------------

async function usergroupList(conn, args) {
  const { include_disabled, include_count, include_users } = args;
  const params = {
    include_disabled: include_disabled ? "true" : undefined,
    include_count:    include_count    ? "true" : undefined,
    include_users:    include_users    ? "true" : undefined,
  };
  const res = await doRequest(conn, "GET", "usergroups.list", params);
  const j   = parseAndCheck(res);
  return { usergroups: j.usergroups || [] };
}

async function usergroupCreate(conn, args) {
  const { name, handle, description, channels } = args;
  requireString(name, "name");
  const payload = { name };
  if (handle)      { guardString(handle, "handle"); payload.handle = handle; }
  if (description) { guardString(description, "description"); payload.description = description; }
  if (channels)    {
    const ch = Array.isArray(channels) ? channels.join(",") : channels;
    guardString(ch, "channels"); payload.channels = ch;
  }
  const res = await doRequest(conn, "POST", "usergroups.create", payload);
  const j   = parseAndCheck(res);
  return { created: true, usergroup: j.usergroup };
}

async function usergroupUpdate(conn, args) {
  const { usergroup, name, handle, description, channels } = args;
  requireString(usergroup, "usergroup");
  const payload = { usergroup };
  if (name)        { guardString(name, "name"); payload.name = name; }
  if (handle)      { guardString(handle, "handle"); payload.handle = handle; }
  if (description) { guardString(description, "description"); payload.description = description; }
  if (channels)    {
    const ch = Array.isArray(channels) ? channels.join(",") : channels;
    guardString(ch, "channels"); payload.channels = ch;
  }
  const res = await doRequest(conn, "POST", "usergroups.update", payload);
  const j   = parseAndCheck(res);
  return { updated: true, usergroup: j.usergroup };
}

// --- WORKSPACE / META --------------------------------------------------------

async function teamInfo(conn, args) {
  const { team_id } = args || {};
  const params = {};
  if (team_id) { guardString(team_id, "team_id"); params.team = team_id; }
  const res = await doRequest(conn, "GET", "team.info", params);
  const j   = parseAndCheck(res);
  const t   = j.team;
  return t ? {
    id:     t.id,
    name:   t.name,
    domain: t.domain,
    email_domain: t.email_domain,
    icon:   t.icon,
    plan:   t.plan,
  } : { team: null };
}

async function emojiList(conn) {
  const res = await doRequest(conn, "GET", "emoji.list", {});
  const j   = parseAndCheck(res);
  const emoji = j.emoji || {};
  return { count: Object.keys(emoji).length, emoji };
}

async function botInfo(conn, args) {
  const { bot } = args || {};
  const params = {};
  if (bot) { guardString(bot, "bot"); params.bot = bot; }
  const res = await doRequest(conn, "GET", "bots.info", params);
  const j   = parseAndCheck(res);
  return { bot: j.bot };
}

async function appInfo(conn) {
  const res = await doRequest(conn, "GET", "apps.connections.open", {});
  // May not be available for all token types; return raw
  let j;
  try { j = JSON.parse(res.body); } catch (e) { throw new Error(`Invalid JSON: ${e.message}`); }
  return { ok: j.ok, url: j.url, error: j.error };
}

async function authTest(conn) {
  const res = await doRequest(conn, "GET", "auth.test", {});
  const j   = parseAndCheck(res);
  return {
    ok:      j.ok,
    url:     j.url,
    team:    j.team,
    user:    j.user,
    team_id: j.team_id,
    user_id: j.user_id,
    bot_id:  j.bot_id,
    is_enterprise_install: j.is_enterprise_install,
  };
}

// --- BOOKMARKS ---------------------------------------------------------------

async function bookmarkAdd(conn, args) {
  const { channel_id, title, type, link, emoji, entity_id } = args;
  requireString(channel_id, "channel_id");
  requireString(title, "title");
  requireString(type, "type");
  const payload = { channel_id, title, type };
  if (link)      { guardString(link, "link"); payload.link = link; }
  if (emoji)     { guardString(emoji, "emoji"); payload.emoji = emoji; }
  if (entity_id) { guardString(entity_id, "entity_id"); payload.entity_id = entity_id; }
  const res = await doRequest(conn, "POST", "bookmarks.add", payload);
  const j   = parseAndCheck(res);
  return { added: true, bookmark: j.bookmark };
}

async function bookmarkList(conn, args) {
  const { channel_id } = args;
  requireString(channel_id, "channel_id");
  const res = await doRequest(conn, "GET", "bookmarks.list", { channel_id });
  const j   = parseAndCheck(res);
  return { bookmarks: j.bookmarks || [] };
}

// --- STARS -------------------------------------------------------------------

async function starAdd(conn, args) {
  const { channel, timestamp, file, file_comment } = args;
  const payload = {};
  if (channel)      { guardString(channel, "channel"); payload.channel = channel; }
  if (timestamp)    { guardString(timestamp, "timestamp"); payload.timestamp = timestamp; }
  if (file)         { guardString(file, "file"); payload.file = file; }
  if (file_comment) { guardString(file_comment, "file_comment"); payload.file_comment = file_comment; }
  if (Object.keys(payload).length === 0)
    throw new Error("At least one of channel/timestamp/file/file_comment is required");
  const res = await doRequest(conn, "POST", "stars.add", payload);
  parseAndCheck(res);
  return { starred: true };
}

async function starRemove(conn, args) {
  const { channel, timestamp, file, file_comment } = args;
  const payload = {};
  if (channel)      { guardString(channel, "channel"); payload.channel = channel; }
  if (timestamp)    { guardString(timestamp, "timestamp"); payload.timestamp = timestamp; }
  if (file)         { guardString(file, "file"); payload.file = file; }
  if (file_comment) { guardString(file_comment, "file_comment"); payload.file_comment = file_comment; }
  if (Object.keys(payload).length === 0)
    throw new Error("At least one of channel/timestamp/file/file_comment is required");
  const res = await doRequest(conn, "POST", "stars.remove", payload);
  parseAndCheck(res);
  return { unstarred: true };
}

// --- DMs (Direct Messages) ---------------------------------------------------

async function dmOpen(conn, args) {
  const { users, return_im } = args;
  if (!users || (Array.isArray(users) && users.length === 0))
    throw new Error("users must be a non-empty array or string");
  const userList = Array.isArray(users) ? users.join(",") : users;
  guardString(userList, "users");
  const payload = { users: userList };
  if (return_im) payload.return_im = true;
  const res = await doRequest(conn, "POST", "conversations.open", payload);
  const j   = parseAndCheck(res);
  return { channel: mapChannel(j.channel), already_open: j.already_open };
}

async function dmClose(conn, args) {
  const { channel } = args;
  requireString(channel, "channel");
  const res = await doRequest(conn, "POST", "conversations.close", { channel });
  parseAndCheck(res);
  return { closed: true, channel };
}

async function dmHistory(conn, args) {
  const { channel, limit, oldest, latest, cursor } = args;
  requireString(channel, "channel");
  const params = {
    channel,
    limit: clampInt(limit, 1, 999, 100),
    oldest, latest, cursor,
  };
  const res = await doRequest(conn, "GET", "conversations.history", params);
  const j   = parseAndCheck(res);
  return {
    messages: ((j.messages) || []).map(mapMessage),
    has_more: j.has_more,
    cursor:   j.response_metadata && j.response_metadata.next_cursor,
  };
}

// --- GENERIC -----------------------------------------------------------------

async function genericRequest(conn, args) {
  const { method, api_method, body } = args;
  requireString(api_method, "api_method");
  const m = (method || "GET").toUpperCase();
  if (m !== "GET" && m !== "POST")
    throw new Error("method must be GET or POST");
  const res = await doRequest(conn, m, api_method, body || (m === "GET" ? {} : undefined));
  let j;
  try { j = JSON.parse(res.body); }
  catch (e) { throw new Error(`Invalid JSON: ${e.message}`); }
  return { ok: j.ok, data: j, error: j.error };
}

// --- Main dispatcher ---------------------------------------------------------

async function slackClient(args) {
  if (!args || !args.operation) throw new Error("operation is required");
  if (!args.token) throw new Error("token is required (xoxb-... bot token or xoxp-... user token)");
  const { operation } = args;
  const conn = buildConn(args);

  switch (operation) {
    // Messages
    case "message_post":            return messagePost(conn, args);
    case "message_update":          return messageUpdate(conn, args);
    case "message_delete":          return messageDelete(conn, args);
    case "message_reply":           return messageReply(conn, args);
    case "messages_history":        return messagesHistory(conn, args);
    case "message_permalink":       return messagePermalink(conn, args);
    case "message_search":          return messageSearch(conn, args);
    case "message_scheduled_list":  return messageScheduledList(conn, args);

    // Channels
    case "channel_list":     return channelList(conn, args);
    case "channel_get":      return channelGet(conn, args);
    case "channel_create":   return channelCreate(conn, args);
    case "channel_archive":  return channelArchive(conn, args);
    case "channel_unarchive":return channelUnarchive(conn, args);
    case "channel_invite":   return channelInvite(conn, args);
    case "channel_join":     return channelJoin(conn, args);
    case "channel_leave":    return channelLeave(conn, args);
    case "channel_rename":   return channelRename(conn, args);

    // Users
    case "user_list":            return userList(conn, args);
    case "user_get":             return userGet(conn, args);
    case "user_me":              return userMe(conn);
    case "user_set_status":      return userSetStatus(conn, args);
    case "user_lookup_by_email": return userLookupByEmail(conn, args);

    // Files
    case "file_list":   return fileList(conn, args);
    case "file_get":    return fileGet(conn, args);
    case "file_upload": return fileUpload(conn, args);
    case "file_delete": return fileDelete(conn, args);
    case "file_share":  return fileShare(conn, args);

    // Reactions
    case "reaction_add":    return reactionAdd(conn, args);
    case "reaction_remove": return reactionRemove(conn, args);
    case "reaction_list":   return reactionList(conn, args);
    case "reaction_get":    return reactionGet(conn, args);

    // Pins
    case "pin_add":    return pinAdd(conn, args);
    case "pin_remove": return pinRemove(conn, args);

    // Reminders
    case "reminder_add":    return reminderAdd(conn, args);
    case "reminder_list":   return reminderList(conn);
    case "reminder_delete": return reminderDelete(conn, args);

    // Usergroups
    case "usergroup_list":   return usergroupList(conn, args);
    case "usergroup_create": return usergroupCreate(conn, args);
    case "usergroup_update": return usergroupUpdate(conn, args);

    // Workspace/Meta
    case "team_info":  return teamInfo(conn, args);
    case "emoji_list": return emojiList(conn);
    case "bot_info":   return botInfo(conn, args);
    case "app_info":   return appInfo(conn);
    case "auth_test":  return authTest(conn);

    // Bookmarks
    case "bookmark_add":  return bookmarkAdd(conn, args);
    case "bookmark_list": return bookmarkList(conn, args);

    // Stars
    case "star_add":    return starAdd(conn, args);
    case "star_remove": return starRemove(conn, args);

    // DMs
    case "dm_open":    return dmOpen(conn, args);
    case "dm_close":   return dmClose(conn, args);
    case "dm_history": return dmHistory(conn, args);

    // Generic
    case "request": return genericRequest(conn, args);

    default:
      throw new Error(
        `Unknown operation: '${operation}'. Valid: message_post, message_update, message_delete, ` +
        `message_reply, messages_history, message_permalink, message_search, message_scheduled_list, ` +
        `channel_list, channel_get, channel_create, channel_archive, channel_unarchive, channel_invite, ` +
        `channel_join, channel_leave, channel_rename, user_list, user_get, user_me, user_set_status, ` +
        `user_lookup_by_email, file_list, file_get, file_upload, file_delete, file_share, ` +
        `reaction_add, reaction_remove, reaction_list, reaction_get, pin_add, pin_remove, ` +
        `reminder_add, reminder_list, reminder_delete, usergroup_list, usergroup_create, usergroup_update, ` +
        `team_info, emoji_list, bot_info, app_info, auth_test, bookmark_add, bookmark_list, ` +
        `star_add, star_remove, dm_open, dm_close, dm_history, request`
      );
  }
}

module.exports = { slackClient };
