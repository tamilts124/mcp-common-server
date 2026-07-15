"use strict";
/**
 * discord_client — Zero-dependency Discord REST API v10 client
 * (pure Node.js https built-ins; no npm deps)
 *
 * Authentication:
 *   - Bot Token via 'token' (Authorization: Bot <token>)
 *   - OAuth2 Bearer token via 'bearer_token' (Authorization: Bearer <token>)
 *   Tokens never returned in output or errors.
 *
 * Base URL: https://discord.com/api/v10
 *
 * Supported operations (52 total):
 *
 *   Guilds (9):
 *     guild_get, guild_create, guild_modify, guild_delete,
 *     guild_list, guild_channels, guild_members, guild_roles,
 *     guild_bans
 *
 *   Channels (9):
 *     channel_get, channel_modify, channel_delete, channel_messages,
 *     channel_invites, channel_pins, channel_create_dm, channel_webhooks,
 *     channel_typing
 *
 *   Messages (8):
 *     message_get, message_send, message_edit, message_delete,
 *     message_bulk_delete, message_pin, message_unpin, message_reactions
 *
 *   Members (5):
 *     member_get, member_list, member_modify, member_kick, member_ban
 *
 *   Roles (4):
 *     role_create, role_modify, role_delete, role_assign
 *
 *   Users (4):
 *     user_me, user_get, user_guilds, user_dms
 *
 *   Webhooks (4):
 *     webhook_create, webhook_get, webhook_modify, webhook_execute
 *
 *   Reactions (3):
 *     reaction_add, reaction_remove, reaction_get
 *
 *   Interactions (2):
 *     interaction_respond, interaction_followup
 *
 *   Voice (2):
 *     voice_regions, voice_move
 *
 *   Generic (2):
 *     request, info
 *
 * Security:
 *   NUL-byte guards on all string inputs.
 *   Timeout clamped 1000-120000 ms.
 *   Token never returned in output or errors.
 *   16 MB response cap.
 *   TLS enforced by default.
 *   Rate limit headers parsed and returned.
 */

const https = require("https");

// --- Constants ---

const DISCORD_BASE        = "https://discord.com/api/v10";
const DEFAULT_TIMEOUT_MS  = 20000;
const MAX_RESPONSE_BYTES  = 16 * 1024 * 1024; // 16 MB

// --- Guard helpers ---

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

// --- Build connection config ---

function buildConn(args) {
  const { token, bearer_token, timeout, reject_unauthorized } = args;
  if (!token && !bearer_token)
    throw new Error("Either 'token' (Bot token) or 'bearer_token' (OAuth2 Bearer) is required");
  if (token)        requireString(token, "token");
  if (bearer_token) requireString(bearer_token, "bearer_token");
  return {
    authHeader: bearer_token
      ? `Bearer ${bearer_token}`
      : `Bot ${token}`,
    timeoutMs:          clampInt(timeout, 1000, 120000, DEFAULT_TIMEOUT_MS),
    rejectUnauthorized: reject_unauthorized !== false,
  };
}

// --- HTTP helper ---

function doRequest(conn, method, path, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const url = path.startsWith("http") ? path : `${DISCORD_BASE}${path}`;
    let urlObj;
    try { urlObj = new URL(url); } catch { return reject(new Error(`Invalid URL: ${url}`)); }

    const M = method.toUpperCase();
    const isWrite = ["POST", "PUT", "PATCH"].includes(M);
    const reqBody = (isWrite && body !== undefined) ? JSON.stringify(body) : undefined;

    const headers = {
      "Authorization": conn.authHeader,
      "Accept":        "application/json",
      "User-Agent":    "DiscordBot (mcp-common-server, 1.0)",
      ...(extraHeaders || {}),
    };
    if (isWrite) {
      headers["Content-Type"] = "application/json; charset=utf-8";
      if (reqBody !== undefined)
        headers["Content-Length"] = Buffer.byteLength(reqBody);
    }

    const options = {
      hostname:           urlObj.hostname,
      port:               443,
      path:               urlObj.pathname + urlObj.search,
      method:             M,
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
          status:  res.statusCode,
          headers: res.headers,
          body:    Buffer.concat(chunks).toString("utf8"),
        });
      });
      res.on("error", (err) => { clearTimeout(timer); reject(err); });
    });
    req.on("error", (err) => { clearTimeout(timer); reject(err); });
    if (isWrite && reqBody !== undefined) req.write(reqBody);
    req.end();
  });
}

// --- Response parser ---

function parseJson(res, allowNotFound) {
  // 204 No Content
  if (res.status === 204) return { ok: true };
  // 404 opt-in
  if (res.status === 404 && allowNotFound) return null;
  if (res.body.length === 0) return { ok: true };
  let j;
  try { j = JSON.parse(res.body); }
  catch (e) { throw new Error(`Invalid JSON response (HTTP ${res.status}): ${e.message}`); }
  if (res.status === 429) {
    const retryAfter = (j.retry_after) || (res.headers && res.headers["retry-after"]) || "unknown";
    throw new Error(`Discord rate-limited (429). retry_after: ${retryAfter}s. message: ${j.message || ""}`);
  }
  if (res.status >= 400) {
    const code = j.code || "";
    const msg  = j.message || res.body.slice(0, 300);
    throw new Error(`Discord API error ${res.status}${code ? ` (code ${code})` : ""}: ${msg}`);
  }
  // Attach rate limit metadata if present
  const rateLimitInfo = {};
  if (res.headers && res.headers["x-ratelimit-limit"])
    rateLimitInfo.limit = Number(res.headers["x-ratelimit-limit"]);
  if (res.headers && res.headers["x-ratelimit-remaining"])
    rateLimitInfo.remaining = Number(res.headers["x-ratelimit-remaining"]);
  if (res.headers && res.headers["x-ratelimit-reset"])
    rateLimitInfo.reset = Number(res.headers["x-ratelimit-reset"]);
  if (Object.keys(rateLimitInfo).length) j._rateLimit = rateLimitInfo;
  return j;
}

// --- Map helpers ---

function mapGuild(g) {
  if (!g) return null;
  return {
    id:              g.id,
    name:            g.name,
    icon:            g.icon,
    description:     g.description,
    ownerId:         g.owner_id,
    afkTimeout:      g.afk_timeout,
    verificationLevel: g.verification_level,
    memberCount:     g.member_count,
    approximatePresenceCount: g.approximate_presence_count,
    features:        g.features,
    premiumTier:     g.premium_tier,
    systemChannelId: g.system_channel_id,
    rulesChannelId:  g.rules_channel_id,
  };
}

function mapChannel(c) {
  if (!c) return null;
  return {
    id:         c.id,
    type:       c.type,
    guildId:    c.guild_id,
    name:       c.name,
    topic:      c.topic,
    nsfw:       c.nsfw,
    position:   c.position,
    parentId:   c.parent_id,
    lastMessageId: c.last_message_id,
    rateLimitPerUser: c.rate_limit_per_user,
    permissions: c.permissions,
  };
}

function mapMessage(m) {
  if (!m) return null;
  return {
    id:          m.id,
    channelId:   m.channel_id,
    guildId:     m.guild_id,
    content:     m.content,
    timestamp:   m.timestamp,
    editedAt:    m.edited_timestamp,
    tts:         m.tts,
    mentionAll:  m.mention_everyone,
    pinned:      m.pinned,
    type:        m.type,
    author:      m.author ? {
      id:            m.author.id,
      username:      m.author.username,
      discriminator: m.author.discriminator,
      globalName:    m.author.global_name,
      bot:           m.author.bot,
    } : null,
    attachments: m.attachments,
    embeds:      m.embeds,
    reactions:   m.reactions,
    components:  m.components,
    referencedMessage: m.referenced_message ? mapMessage(m.referenced_message) : null,
  };
}

function mapMember(m) {
  if (!m) return null;
  return {
    user:       m.user ? {
      id:            m.user.id,
      username:      m.user.username,
      discriminator: m.user.discriminator,
      globalName:    m.user.global_name,
      bot:           m.user.bot,
      avatar:        m.user.avatar,
    } : null,
    nick:       m.nick,
    avatar:     m.avatar,
    roles:      m.roles,
    joinedAt:   m.joined_at,
    premiumSince: m.premium_since,
    deaf:       m.deaf,
    mute:       m.mute,
    pending:    m.pending,
    permissions: m.permissions,
  };
}

function mapRole(r) {
  if (!r) return null;
  return {
    id:          r.id,
    name:        r.name,
    color:       r.color,
    hoist:       r.hoist,
    position:    r.position,
    permissions: r.permissions,
    managed:     r.managed,
    mentionable: r.mentionable,
  };
}

function mapUser(u) {
  if (!u) return null;
  return {
    id:            u.id,
    username:      u.username,
    discriminator: u.discriminator,
    globalName:    u.global_name,
    avatar:        u.avatar,
    bot:           u.bot,
    system:        u.system,
    mfaEnabled:    u.mfa_enabled,
    verified:      u.verified,
    email:         u.email,
    flags:         u.flags,
    premiumType:   u.premium_type,
  };
}

function mapWebhook(w) {
  if (!w) return null;
  return {
    id:          w.id,
    type:        w.type,
    guildId:     w.guild_id,
    channelId:   w.channel_id,
    name:        w.name,
    avatar:      w.avatar,
    // token intentionally omitted — never return webhook tokens
    url:         w.url,
    applicationId: w.application_id,
  };
}

function mapInvite(inv) {
  if (!inv) return null;
  return {
    code:       inv.code,
    guildId:    inv.guild ? inv.guild.id : undefined,
    channelId:  inv.channel ? inv.channel.id : undefined,
    inviter:    inv.inviter ? { id: inv.inviter.id, username: inv.inviter.username } : null,
    maxAge:     inv.max_age,
    maxUses:    inv.max_uses,
    uses:       inv.uses,
    temporary:  inv.temporary,
    createdAt:  inv.created_at,
  };
}

// --- GUILDS ---

async function guildGet(conn, args) {
  const { guild_id } = args;
  requireString(guild_id, "guild_id");
  const res = await doRequest(conn, "GET", `/guilds/${enc(guild_id)}?with_counts=true`);
  const j = parseJson(res, true);
  if (j === null) return { guild: null, exists: false };
  return { guild: mapGuild(j), exists: true };
}

async function guildCreate(conn, args) {
  const { name, region, verification_level, default_message_notifications,
          explicit_content_filter, roles, channels, afk_channel_id,
          afk_timeout, system_channel_id } = args;
  requireString(name, "name");
  if (name.length < 2 || name.length > 100)
    throw new Error("name must be between 2 and 100 characters");
  const payload = { name };
  if (region !== undefined)                        payload.region = region;
  if (verification_level !== undefined)            payload.verification_level = verification_level;
  if (default_message_notifications !== undefined) payload.default_message_notifications = default_message_notifications;
  if (explicit_content_filter !== undefined)       payload.explicit_content_filter = explicit_content_filter;
  if (Array.isArray(roles))                        payload.roles = roles;
  if (Array.isArray(channels))                     payload.channels = channels;
  if (afk_channel_id !== undefined)                payload.afk_channel_id = afk_channel_id;
  if (afk_timeout !== undefined)                   payload.afk_timeout = afk_timeout;
  if (system_channel_id !== undefined)             payload.system_channel_id = system_channel_id;
  const res = await doRequest(conn, "POST", "/guilds", payload);
  const j = parseJson(res);
  return { created: true, guild: mapGuild(j) };
}

async function guildModify(conn, args) {
  const { guild_id, name, region, verification_level, default_message_notifications,
          explicit_content_filter, afk_channel_id, afk_timeout,
          system_channel_id, rules_channel_id, description } = args;
  requireString(guild_id, "guild_id");
  const payload = {};
  if (name !== undefined)                          payload.name = name;
  if (region !== undefined)                        payload.region = region;
  if (verification_level !== undefined)            payload.verification_level = verification_level;
  if (default_message_notifications !== undefined) payload.default_message_notifications = default_message_notifications;
  if (explicit_content_filter !== undefined)       payload.explicit_content_filter = explicit_content_filter;
  if (afk_channel_id !== undefined)                payload.afk_channel_id = afk_channel_id;
  if (afk_timeout !== undefined)                   payload.afk_timeout = afk_timeout;
  if (system_channel_id !== undefined)             payload.system_channel_id = system_channel_id;
  if (rules_channel_id !== undefined)              payload.rules_channel_id = rules_channel_id;
  if (description !== undefined)                   payload.description = description;
  const res = await doRequest(conn, "PATCH", `/guilds/${enc(guild_id)}`, payload);
  const j = parseJson(res);
  return { modified: true, guild: mapGuild(j) };
}

async function guildDelete(conn, args) {
  const { guild_id } = args;
  requireString(guild_id, "guild_id");
  const res = await doRequest(conn, "DELETE", `/guilds/${enc(guild_id)}`);
  parseJson(res);
  return { deleted: true, guild_id };
}

async function guildList(conn, args) {
  const { before, after, limit } = args;
  const params = {};
  if (before !== undefined) params.before = before;
  if (after  !== undefined) params.after  = after;
  if (limit  !== undefined) params.limit  = clampInt(limit, 1, 200, 200);
  const res = await doRequest(conn, "GET", `/users/@me/guilds${qs(params)}`);
  const j = parseJson(res);
  const guilds = Array.isArray(j) ? j : [];
  return { guilds: guilds.map(mapGuild), count: guilds.length };
}

async function guildChannels(conn, args) {
  const { guild_id } = args;
  requireString(guild_id, "guild_id");
  const res = await doRequest(conn, "GET", `/guilds/${enc(guild_id)}/channels`);
  const j = parseJson(res);
  const channels = Array.isArray(j) ? j : [];
  return { channels: channels.map(mapChannel), count: channels.length };
}

async function guildMembers(conn, args) {
  const { guild_id, limit, after } = args;
  requireString(guild_id, "guild_id");
  const params = {};
  if (limit !== undefined) params.limit = clampInt(limit, 1, 1000, 100);
  if (after !== undefined) params.after = after;
  const res = await doRequest(conn, "GET", `/guilds/${enc(guild_id)}/members${qs(params)}`);
  const j = parseJson(res);
  const members = Array.isArray(j) ? j : [];
  return { members: members.map(mapMember), count: members.length };
}

async function guildRoles(conn, args) {
  const { guild_id } = args;
  requireString(guild_id, "guild_id");
  const res = await doRequest(conn, "GET", `/guilds/${enc(guild_id)}/roles`);
  const j = parseJson(res);
  const roles = Array.isArray(j) ? j : [];
  return { roles: roles.map(mapRole), count: roles.length };
}

async function guildBans(conn, args) {
  const { guild_id, limit, before, after } = args;
  requireString(guild_id, "guild_id");
  const params = {};
  if (limit  !== undefined) params.limit  = clampInt(limit, 1, 1000, 1000);
  if (before !== undefined) params.before = before;
  if (after  !== undefined) params.after  = after;
  const res = await doRequest(conn, "GET", `/guilds/${enc(guild_id)}/bans${qs(params)}`);
  const j = parseJson(res);
  const bans = Array.isArray(j) ? j : [];
  return {
    bans: bans.map(b => ({
      reason: b.reason,
      user:   b.user ? { id: b.user.id, username: b.user.username, discriminator: b.user.discriminator } : null,
    })),
    count: bans.length,
  };
}

// --- CHANNELS ---

async function channelGet(conn, args) {
  const { channel_id } = args;
  requireString(channel_id, "channel_id");
  const res = await doRequest(conn, "GET", `/channels/${enc(channel_id)}`);
  const j = parseJson(res, true);
  if (j === null) return { channel: null, exists: false };
  return { channel: mapChannel(j), exists: true };
}

async function channelModify(conn, args) {
  const { channel_id, name, topic, nsfw, rate_limit_per_user,
          bitrate, user_limit, position, parent_id } = args;
  requireString(channel_id, "channel_id");
  const payload = {};
  if (name               !== undefined) payload.name               = name;
  if (topic              !== undefined) payload.topic              = topic;
  if (nsfw               !== undefined) payload.nsfw               = nsfw;
  if (rate_limit_per_user !== undefined) payload.rate_limit_per_user = rate_limit_per_user;
  if (bitrate            !== undefined) payload.bitrate            = bitrate;
  if (user_limit         !== undefined) payload.user_limit         = user_limit;
  if (position           !== undefined) payload.position           = position;
  if (parent_id          !== undefined) payload.parent_id          = parent_id;
  const res = await doRequest(conn, "PATCH", `/channels/${enc(channel_id)}`, payload);
  const j = parseJson(res);
  return { modified: true, channel: mapChannel(j) };
}

async function channelDelete(conn, args) {
  const { channel_id } = args;
  requireString(channel_id, "channel_id");
  const res = await doRequest(conn, "DELETE", `/channels/${enc(channel_id)}`);
  const j = parseJson(res);
  return { deleted: true, channel: mapChannel(j) };
}

async function channelMessages(conn, args) {
  const { channel_id, around, before, after, limit } = args;
  requireString(channel_id, "channel_id");
  const params = {};
  if (around !== undefined) params.around = around;
  if (before !== undefined) params.before = before;
  if (after  !== undefined) params.after  = after;
  if (limit  !== undefined) params.limit  = clampInt(limit, 1, 100, 50);
  const res = await doRequest(conn, "GET", `/channels/${enc(channel_id)}/messages${qs(params)}`);
  const j = parseJson(res);
  const messages = Array.isArray(j) ? j : [];
  return { messages: messages.map(mapMessage), count: messages.length };
}

async function channelInvites(conn, args) {
  const { channel_id } = args;
  requireString(channel_id, "channel_id");
  const res = await doRequest(conn, "GET", `/channels/${enc(channel_id)}/invites`);
  const j = parseJson(res);
  const invites = Array.isArray(j) ? j : [];
  return { invites: invites.map(mapInvite), count: invites.length };
}

async function channelPins(conn, args) {
  const { channel_id } = args;
  requireString(channel_id, "channel_id");
  const res = await doRequest(conn, "GET", `/channels/${enc(channel_id)}/pins`);
  const j = parseJson(res);
  const messages = Array.isArray(j) ? j : [];
  return { pins: messages.map(mapMessage), count: messages.length };
}

async function channelCreateDm(conn, args) {
  const { recipient_id } = args;
  requireString(recipient_id, "recipient_id");
  const res = await doRequest(conn, "POST", "/users/@me/channels", { recipient_id });
  const j = parseJson(res);
  return { channel: mapChannel(j) };
}

async function channelWebhooks(conn, args) {
  const { channel_id } = args;
  requireString(channel_id, "channel_id");
  const res = await doRequest(conn, "GET", `/channels/${enc(channel_id)}/webhooks`);
  const j = parseJson(res);
  const webhooks = Array.isArray(j) ? j : [];
  return { webhooks: webhooks.map(mapWebhook), count: webhooks.length };
}

async function channelTyping(conn, args) {
  const { channel_id } = args;
  requireString(channel_id, "channel_id");
  const res = await doRequest(conn, "POST", `/channels/${enc(channel_id)}/typing`, {});
  parseJson(res);
  return { ok: true, channel_id };
}

// --- MESSAGES ---

async function messageGet(conn, args) {
  const { channel_id, message_id } = args;
  requireString(channel_id, "channel_id");
  requireString(message_id, "message_id");
  const res = await doRequest(conn, "GET", `/channels/${enc(channel_id)}/messages/${enc(message_id)}`);
  const j = parseJson(res, true);
  if (j === null) return { message: null, exists: false };
  return { message: mapMessage(j), exists: true };
}

async function messageSend(conn, args) {
  const { channel_id, content, tts, embeds, components,
          message_reference, allowed_mentions, flags } = args;
  requireString(channel_id, "channel_id");
  if (!content && !embeds && !components)
    throw new Error("At least one of content, embeds, or components must be provided");
  const payload = {};
  if (content !== undefined)                       { guardString(content, "content"); payload.content = content; }
  if (tts     !== undefined)                       payload.tts = tts;
  if (embeds && Array.isArray(embeds))             payload.embeds = embeds;
  if (components && Array.isArray(components))     payload.components = components;
  if (message_reference !== undefined)             payload.message_reference = message_reference;
  if (allowed_mentions  !== undefined)             payload.allowed_mentions  = allowed_mentions;
  if (flags !== undefined)                         payload.flags = flags;
  const res = await doRequest(conn, "POST", `/channels/${enc(channel_id)}/messages`, payload);
  const j = parseJson(res);
  return { sent: true, message: mapMessage(j) };
}

async function messageEdit(conn, args) {
  const { channel_id, message_id, content, embeds, components, flags } = args;
  requireString(channel_id, "channel_id");
  requireString(message_id, "message_id");
  const payload = {};
  if (content !== undefined)                   { guardString(content, "content"); payload.content = content; }
  if (embeds && Array.isArray(embeds))         payload.embeds     = embeds;
  if (components && Array.isArray(components)) payload.components = components;
  if (flags !== undefined)                     payload.flags      = flags;
  const res = await doRequest(conn, "PATCH", `/channels/${enc(channel_id)}/messages/${enc(message_id)}`, payload);
  const j = parseJson(res);
  return { edited: true, message: mapMessage(j) };
}

async function messageDelete(conn, args) {
  const { channel_id, message_id } = args;
  requireString(channel_id, "channel_id");
  requireString(message_id, "message_id");
  const res = await doRequest(conn, "DELETE", `/channels/${enc(channel_id)}/messages/${enc(message_id)}`);
  if (res.status === 404) return { deleted: false, message_id };
  parseJson(res);
  return { deleted: true, message_id };
}

async function messageBulkDelete(conn, args) {
  const { channel_id, message_ids } = args;
  requireString(channel_id, "channel_id");
  if (!Array.isArray(message_ids) || message_ids.length < 2 || message_ids.length > 100)
    throw new Error("message_ids must be an array of 2-100 message IDs");
  const res = await doRequest(conn, "POST",
    `/channels/${enc(channel_id)}/messages/bulk-delete`,
    { messages: message_ids });
  parseJson(res);
  return { deleted: true, count: message_ids.length };
}

async function messagePin(conn, args) {
  const { channel_id, message_id } = args;
  requireString(channel_id, "channel_id");
  requireString(message_id, "message_id");
  const res = await doRequest(conn, "PUT", `/channels/${enc(channel_id)}/pins/${enc(message_id)}`);
  parseJson(res);
  return { pinned: true, message_id };
}

async function messageUnpin(conn, args) {
  const { channel_id, message_id } = args;
  requireString(channel_id, "channel_id");
  requireString(message_id, "message_id");
  const res = await doRequest(conn, "DELETE", `/channels/${enc(channel_id)}/pins/${enc(message_id)}`);
  parseJson(res);
  return { unpinned: true, message_id };
}

async function messageReactions(conn, args) {
  const { channel_id, message_id, emoji, after, limit } = args;
  requireString(channel_id, "channel_id");
  requireString(message_id, "message_id");
  requireString(emoji, "emoji");
  const params = {};
  if (after !== undefined) params.after = after;
  if (limit !== undefined) params.limit = clampInt(limit, 1, 100, 25);
  const res = await doRequest(conn, "GET",
    `/channels/${enc(channel_id)}/messages/${enc(message_id)}/reactions/${enc(emoji)}${qs(params)}`);
  const j = parseJson(res);
  const users = Array.isArray(j) ? j : [];
  return {
    users: users.map(u => ({ id: u.id, username: u.username, discriminator: u.discriminator, bot: u.bot })),
    count: users.length,
  };
}

// --- MEMBERS ---

async function memberGet(conn, args) {
  const { guild_id, user_id } = args;
  requireString(guild_id, "guild_id");
  requireString(user_id, "user_id");
  const res = await doRequest(conn, "GET", `/guilds/${enc(guild_id)}/members/${enc(user_id)}`);
  const j = parseJson(res, true);
  if (j === null) return { member: null, exists: false };
  return { member: mapMember(j), exists: true };
}

async function memberList(conn, args) {
  const { guild_id, limit, after } = args;
  requireString(guild_id, "guild_id");
  const params = {};
  if (limit !== undefined) params.limit = clampInt(limit, 1, 1000, 100);
  if (after !== undefined) params.after = after;
  const res = await doRequest(conn, "GET", `/guilds/${enc(guild_id)}/members${qs(params)}`);
  const j = parseJson(res);
  const members = Array.isArray(j) ? j : [];
  return { members: members.map(mapMember), count: members.length };
}

async function memberModify(conn, args) {
  const { guild_id, user_id, nick, roles, mute, deaf, channel_id,
          communication_disabled_until } = args;
  requireString(guild_id, "guild_id");
  requireString(user_id, "user_id");
  const payload = {};
  if (nick       !== undefined) payload.nick       = nick;
  if (roles      !== undefined) payload.roles      = roles;
  if (mute       !== undefined) payload.mute       = mute;
  if (deaf       !== undefined) payload.deaf       = deaf;
  if (channel_id !== undefined) payload.channel_id = channel_id;
  if (communication_disabled_until !== undefined)
    payload.communication_disabled_until = communication_disabled_until;
  const res = await doRequest(conn, "PATCH", `/guilds/${enc(guild_id)}/members/${enc(user_id)}`, payload);
  const j = parseJson(res);
  return { modified: true, member: mapMember(j) };
}

async function memberKick(conn, args) {
  const { guild_id, user_id } = args;
  requireString(guild_id, "guild_id");
  requireString(user_id, "user_id");
  const res = await doRequest(conn, "DELETE", `/guilds/${enc(guild_id)}/members/${enc(user_id)}`);
  if (res.status === 404) return { kicked: false, user_id };
  parseJson(res);
  return { kicked: true, user_id };
}

async function memberBan(conn, args) {
  const { guild_id, user_id, delete_message_seconds, reason } = args;
  requireString(guild_id, "guild_id");
  requireString(user_id, "user_id");
  const payload = {};
  if (delete_message_seconds !== undefined)
    payload.delete_message_seconds = clampInt(delete_message_seconds, 0, 604800, 0);
  const extraHeaders = {};
  if (reason) { guardString(reason, "reason"); extraHeaders["X-Audit-Log-Reason"] = reason; }
  const res = await doRequest(conn, "PUT",
    `/guilds/${enc(guild_id)}/bans/${enc(user_id)}`, payload, extraHeaders);
  parseJson(res);
  return { banned: true, user_id };
}

// --- ROLES ---

async function roleCreate(conn, args) {
  const { guild_id, name, permissions, color, hoist, mentionable } = args;
  requireString(guild_id, "guild_id");
  const payload = {};
  if (name        !== undefined) payload.name        = name;
  if (permissions !== undefined) payload.permissions = permissions;
  if (color       !== undefined) payload.color       = color;
  if (hoist       !== undefined) payload.hoist       = hoist;
  if (mentionable !== undefined) payload.mentionable = mentionable;
  const res = await doRequest(conn, "POST", `/guilds/${enc(guild_id)}/roles`, payload);
  const j = parseJson(res);
  return { created: true, role: mapRole(j) };
}

async function roleModify(conn, args) {
  const { guild_id, role_id, name, permissions, color, hoist, mentionable, position } = args;
  requireString(guild_id, "guild_id");
  requireString(role_id, "role_id");
  const payload = {};
  if (name        !== undefined) payload.name        = name;
  if (permissions !== undefined) payload.permissions = permissions;
  if (color       !== undefined) payload.color       = color;
  if (hoist       !== undefined) payload.hoist       = hoist;
  if (mentionable !== undefined) payload.mentionable = mentionable;
  if (position    !== undefined) payload.position    = position;
  const res = await doRequest(conn, "PATCH", `/guilds/${enc(guild_id)}/roles/${enc(role_id)}`, payload);
  const j = parseJson(res);
  return { modified: true, role: mapRole(j) };
}

async function roleDelete(conn, args) {
  const { guild_id, role_id } = args;
  requireString(guild_id, "guild_id");
  requireString(role_id, "role_id");
  const res = await doRequest(conn, "DELETE", `/guilds/${enc(guild_id)}/roles/${enc(role_id)}`);
  if (res.status === 404) return { deleted: false, role_id };
  parseJson(res);
  return { deleted: true, role_id };
}

async function roleAssign(conn, args) {
  const { guild_id, user_id, role_id } = args;
  requireString(guild_id, "guild_id");
  requireString(user_id, "user_id");
  requireString(role_id, "role_id");
  const res = await doRequest(conn, "PUT",
    `/guilds/${enc(guild_id)}/members/${enc(user_id)}/roles/${enc(role_id)}`);
  parseJson(res);
  return { assigned: true, user_id, role_id };
}

// --- USERS ---

async function userMe(conn) {
  const res = await doRequest(conn, "GET", "/users/@me");
  const j = parseJson(res);
  return { user: mapUser(j) };
}

async function userGet(conn, args) {
  const { user_id } = args;
  requireString(user_id, "user_id");
  const res = await doRequest(conn, "GET", `/users/${enc(user_id)}`);
  const j = parseJson(res, true);
  if (j === null) return { user: null, exists: false };
  return { user: mapUser(j), exists: true };
}

async function userGuilds(conn, args) {
  const { before, after, limit } = args;
  const params = {};
  if (before !== undefined) params.before = before;
  if (after  !== undefined) params.after  = after;
  if (limit  !== undefined) params.limit  = clampInt(limit, 1, 200, 200);
  const res = await doRequest(conn, "GET", `/users/@me/guilds${qs(params)}`);
  const j = parseJson(res);
  const guilds = Array.isArray(j) ? j : [];
  return {
    guilds: guilds.map(g => ({ id: g.id, name: g.name, owner: g.owner, permissions: g.permissions })),
    count: guilds.length,
  };
}

async function userDms(conn) {
  const res = await doRequest(conn, "GET", "/users/@me/channels");
  const j = parseJson(res);
  const channels = Array.isArray(j) ? j : [];
  return { channels: channels.map(mapChannel), count: channels.length };
}

// --- WEBHOOKS ---

async function webhookCreate(conn, args) {
  const { channel_id, name, avatar } = args;
  requireString(channel_id, "channel_id");
  requireString(name, "name");
  if (name.length < 1 || name.length > 80)
    throw new Error("name must be 1-80 characters");
  const payload = { name };
  if (avatar !== undefined) payload.avatar = avatar;
  const res = await doRequest(conn, "POST", `/channels/${enc(channel_id)}/webhooks`, payload);
  const j = parseJson(res);
  return { created: true, webhook: mapWebhook(j) };
}

async function webhookGet(conn, args) {
  const { webhook_id } = args;
  requireString(webhook_id, "webhook_id");
  const res = await doRequest(conn, "GET", `/webhooks/${enc(webhook_id)}`);
  const j = parseJson(res, true);
  if (j === null) return { webhook: null, exists: false };
  return { webhook: mapWebhook(j), exists: true };
}

async function webhookModify(conn, args) {
  const { webhook_id, name, avatar, channel_id } = args;
  requireString(webhook_id, "webhook_id");
  const payload = {};
  if (name       !== undefined) payload.name       = name;
  if (avatar     !== undefined) payload.avatar     = avatar;
  if (channel_id !== undefined) payload.channel_id = channel_id;
  const res = await doRequest(conn, "PATCH", `/webhooks/${enc(webhook_id)}`, payload);
  const j = parseJson(res);
  return { modified: true, webhook: mapWebhook(j) };
}

async function webhookExecute(conn, args) {
  const { webhook_id, webhook_token, content, username, avatar_url,
          tts, embeds, components, wait, thread_id } = args;
  requireString(webhook_id, "webhook_id");
  requireString(webhook_token, "webhook_token");
  if (!content && !embeds)
    throw new Error("At least one of content or embeds must be provided");
  const payload = {};
  if (content    !== undefined) { guardString(content, "content"); payload.content = content; }
  if (username   !== undefined) payload.username   = username;
  if (avatar_url !== undefined) payload.avatar_url = avatar_url;
  if (tts        !== undefined) payload.tts        = tts;
  if (embeds && Array.isArray(embeds))         payload.embeds     = embeds;
  if (components && Array.isArray(components)) payload.components = components;
  const params = {};
  if (wait)      params.wait      = "true";
  if (thread_id) params.thread_id = thread_id;
  const res = await doRequest(conn, "POST",
    `/webhooks/${enc(webhook_id)}/${enc(webhook_token)}${qs(params)}`, payload);
  if (res.status === 204) return { executed: true, message: null };
  const j = parseJson(res);
  return { executed: true, message: mapMessage(j) };
}

// --- REACTIONS ---

async function reactionAdd(conn, args) {
  const { channel_id, message_id, emoji } = args;
  requireString(channel_id, "channel_id");
  requireString(message_id, "message_id");
  requireString(emoji, "emoji");
  const res = await doRequest(conn, "PUT",
    `/channels/${enc(channel_id)}/messages/${enc(message_id)}/reactions/${enc(emoji)}/@me`);
  parseJson(res);
  return { added: true, emoji };
}

async function reactionRemove(conn, args) {
  const { channel_id, message_id, emoji, user_id } = args;
  requireString(channel_id, "channel_id");
  requireString(message_id, "message_id");
  requireString(emoji, "emoji");
  const userPath = user_id ? enc(user_id) : "@me";
  const res = await doRequest(conn, "DELETE",
    `/channels/${enc(channel_id)}/messages/${enc(message_id)}/reactions/${enc(emoji)}/${userPath}`);
  parseJson(res);
  return { removed: true, emoji };
}

async function reactionGet(conn, args) {
  return messageReactions(conn, args);
}

// --- INTERACTIONS ---

async function interactionRespond(conn, args) {
  const { interaction_id, interaction_token, type, data } = args;
  requireString(interaction_id, "interaction_id");
  requireString(interaction_token, "interaction_token");
  if (type === undefined || typeof type !== "number")
    throw new Error("type must be a number (interaction response type: 1=PONG, 4=CHANNEL_MESSAGE, 5=DEFERRED, etc.)");
  const payload = { type };
  if (data !== undefined) payload.data = data;
  const res = await doRequest(conn, "POST",
    `/interactions/${enc(interaction_id)}/${enc(interaction_token)}/callback`, payload);
  parseJson(res);
  return { responded: true, type };
}

async function interactionFollowup(conn, args) {
  const { application_id, interaction_token, content, embeds, components, ephemeral } = args;
  requireString(application_id, "application_id");
  requireString(interaction_token, "interaction_token");
  if (!content && !embeds)
    throw new Error("At least one of content or embeds must be provided");
  const payload = {};
  if (content !== undefined)                       { guardString(content, "content"); payload.content = content; }
  if (embeds && Array.isArray(embeds))             payload.embeds     = embeds;
  if (components && Array.isArray(components))     payload.components = components;
  if (ephemeral)                                   payload.flags      = 64; // EPHEMERAL flag
  const res = await doRequest(conn, "POST",
    `/webhooks/${enc(application_id)}/${enc(interaction_token)}`, payload);
  const j = parseJson(res);
  return { sent: true, message: mapMessage(j) };
}

// --- VOICE ---

async function voiceRegions(conn, args) {
  const { guild_id } = args || {};
  let path = "/voice/regions";
  if (guild_id) {
    requireString(guild_id, "guild_id");
    path = `/guilds/${enc(guild_id)}/regions`;
  }
  const res = await doRequest(conn, "GET", path);
  const j = parseJson(res);
  const regions = Array.isArray(j) ? j : [];
  return {
    regions: regions.map(r => ({
      id:         r.id,
      name:       r.name,
      optimal:    r.optimal,
      deprecated: r.deprecated,
      custom:     r.custom,
    })),
    count: regions.length,
  };
}

async function voiceMove(conn, args) {
  const { guild_id, user_id, channel_id } = args;
  requireString(guild_id, "guild_id");
  requireString(user_id, "user_id");
  const res = await doRequest(conn, "PATCH",
    `/guilds/${enc(guild_id)}/members/${enc(user_id)}`,
    { channel_id: channel_id || null });
  const j = parseJson(res);
  return { moved: true, member: mapMember(j), channel_id: channel_id || null };
}

// --- GENERIC ---

async function genericRequest(conn, args) {
  const { method, path: reqPath, body } = args;
  requireString(reqPath, "path");
  const m = (method || "GET").toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(m))
    throw new Error("method must be GET, POST, PUT, PATCH, or DELETE");
  const fullPath = reqPath.startsWith("/") ? reqPath : `/${reqPath}`;
  const res = await doRequest(conn, m, fullPath,
    ["POST", "PUT", "PATCH"].includes(m) ? (body || {}) : undefined);
  let j;
  try { j = JSON.parse(res.body); } catch { j = { raw: res.body }; }
  return { status: res.status, data: j };
}

function discordInfo() {
  return {
    ok: true,
    api: "Discord REST API v10",
    base_url: DISCORD_BASE,
    auth: [
      "token: Bot Token (Authorization: Bot <token>)",
      "bearer_token: OAuth2 Bearer Token (Authorization: Bearer <token>)",
    ],
    operations: [
      "Guilds (9): guild_get, guild_create, guild_modify, guild_delete, guild_list, guild_channels, guild_members, guild_roles, guild_bans",
      "Channels (9): channel_get, channel_modify, channel_delete, channel_messages, channel_invites, channel_pins, channel_create_dm, channel_webhooks, channel_typing",
      "Messages (8): message_get, message_send, message_edit, message_delete, message_bulk_delete, message_pin, message_unpin, message_reactions",
      "Members (5): member_get, member_list, member_modify, member_kick, member_ban",
      "Roles (4): role_create, role_modify, role_delete, role_assign",
      "Users (4): user_me, user_get, user_guilds, user_dms",
      "Webhooks (4): webhook_create, webhook_get, webhook_modify, webhook_execute",
      "Reactions (3): reaction_add, reaction_remove, reaction_get",
      "Interactions (2): interaction_respond, interaction_followup",
      "Voice (2): voice_regions, voice_move",
      "Generic (2): request, info",
    ],
  };
}

// --- Main dispatcher ---

async function discordClient(args) {
  if (!args || !args.operation) throw new Error("operation is required");
  const { operation } = args;

  if (operation === "info") return discordInfo();

  const conn = buildConn(args);

  switch (operation) {
    // Guilds
    case "guild_get":      return guildGet(conn, args);
    case "guild_create":   return guildCreate(conn, args);
    case "guild_modify":   return guildModify(conn, args);
    case "guild_delete":   return guildDelete(conn, args);
    case "guild_list":     return guildList(conn, args);
    case "guild_channels": return guildChannels(conn, args);
    case "guild_members":  return guildMembers(conn, args);
    case "guild_roles":    return guildRoles(conn, args);
    case "guild_bans":     return guildBans(conn, args);

    // Channels
    case "channel_get":       return channelGet(conn, args);
    case "channel_modify":    return channelModify(conn, args);
    case "channel_delete":    return channelDelete(conn, args);
    case "channel_messages":  return channelMessages(conn, args);
    case "channel_invites":   return channelInvites(conn, args);
    case "channel_pins":      return channelPins(conn, args);
    case "channel_create_dm": return channelCreateDm(conn, args);
    case "channel_webhooks":  return channelWebhooks(conn, args);
    case "channel_typing":    return channelTyping(conn, args);

    // Messages
    case "message_get":         return messageGet(conn, args);
    case "message_send":        return messageSend(conn, args);
    case "message_edit":        return messageEdit(conn, args);
    case "message_delete":      return messageDelete(conn, args);
    case "message_bulk_delete": return messageBulkDelete(conn, args);
    case "message_pin":         return messagePin(conn, args);
    case "message_unpin":       return messageUnpin(conn, args);
    case "message_reactions":   return messageReactions(conn, args);

    // Members
    case "member_get":    return memberGet(conn, args);
    case "member_list":   return memberList(conn, args);
    case "member_modify": return memberModify(conn, args);
    case "member_kick":   return memberKick(conn, args);
    case "member_ban":    return memberBan(conn, args);

    // Roles
    case "role_create": return roleCreate(conn, args);
    case "role_modify": return roleModify(conn, args);
    case "role_delete": return roleDelete(conn, args);
    case "role_assign": return roleAssign(conn, args);

    // Users
    case "user_me":     return userMe(conn);
    case "user_get":    return userGet(conn, args);
    case "user_guilds": return userGuilds(conn, args);
    case "user_dms":    return userDms(conn);

    // Webhooks
    case "webhook_create":  return webhookCreate(conn, args);
    case "webhook_get":     return webhookGet(conn, args);
    case "webhook_modify":  return webhookModify(conn, args);
    case "webhook_execute": return webhookExecute(conn, args);

    // Reactions
    case "reaction_add":    return reactionAdd(conn, args);
    case "reaction_remove": return reactionRemove(conn, args);
    case "reaction_get":    return reactionGet(conn, args);

    // Interactions
    case "interaction_respond":  return interactionRespond(conn, args);
    case "interaction_followup": return interactionFollowup(conn, args);

    // Voice
    case "voice_regions": return voiceRegions(conn, args);
    case "voice_move":    return voiceMove(conn, args);

    // Generic
    case "request": return genericRequest(conn, args);

    default:
      throw new Error(
        `Unknown operation: '${operation}'. Valid operations: ` +
        `guild_get, guild_create, guild_modify, guild_delete, guild_list, guild_channels, guild_members, guild_roles, guild_bans, ` +
        `channel_get, channel_modify, channel_delete, channel_messages, channel_invites, channel_pins, channel_create_dm, channel_webhooks, channel_typing, ` +
        `message_get, message_send, message_edit, message_delete, message_bulk_delete, message_pin, message_unpin, message_reactions, ` +
        `member_get, member_list, member_modify, member_kick, member_ban, ` +
        `role_create, role_modify, role_delete, role_assign, ` +
        `user_me, user_get, user_guilds, user_dms, ` +
        `webhook_create, webhook_get, webhook_modify, webhook_execute, ` +
        `reaction_add, reaction_remove, reaction_get, ` +
        `interaction_respond, interaction_followup, ` +
        `voice_regions, voice_move, ` +
        `request, info`
      );
  }
}

module.exports = { discordClient };
