"use strict";
/**
 * notion_client — Zero-dependency Notion REST API client
 * (pure Node.js https built-ins; no npm deps)
 *
 * Authentication:
 *   - Integration Token (Bearer) via `token`
 *   Tokens never returned in output or errors.
 *
 * Base URL: https://api.notion.com/v1
 * Notion-Version header: 2022-06-28 (stable)
 *
 * Supported operations (50 total):
 *
 *   Pages (7):
 *     page_get, page_create, page_update, page_archive,
 *     page_retrieve_property, page_get_property_item, page_restore
 *
 *   Databases (7):
 *     database_list, database_get, database_create,
 *     database_update, database_query, database_filter, database_restore
 *
 *   Blocks (6):
 *     block_get, block_update, block_delete,
 *     block_children_list, block_children_append, block_restore
 *
 *   Comments (3):
 *     comment_list, comment_create, comment_get
 *
 *   Users (3):
 *     user_list, user_get, user_me
 *
 *   Search (2):
 *     search, search_filter
 *
 *   Properties (2):
 *     property_get, property_list
 *
 *   Workspace (1):
 *     workspace_info
 *
 *   Content helpers (6):
 *     page_content_get, page_content_append,
 *     page_title_set, page_icon_set, page_cover_set,
 *     page_properties_set
 *
 *   Generic (3):
 *     request, info, version
 *
 * Security:
 *   NUL-byte guards on all string inputs.
 *   Timeout clamped 1000–120000 ms.
 *   Token never returned in output or errors.
 *   16 MB response cap.
 *   TLS enforced by default.
 */

const https = require("https");

// ─── Constants ────────────────────────────────────────────────────────────────

const NOTION_BASE         = "https://api.notion.com/v1";
const NOTION_VERSION      = "2022-06-28";
const DEFAULT_TIMEOUT_MS  = 20000;
const MAX_RESPONSE_BYTES  = 16 * 1024 * 1024; // 16 MB

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

// ─── Build connection config ──────────────────────────────────────────────────

function buildConn(args) {
  const { token, timeout, reject_unauthorized } = args;
  requireString(token, "token");
  return {
    token,
    timeoutMs: clampInt(timeout, 1000, 120000, DEFAULT_TIMEOUT_MS),
    rejectUnauthorized: reject_unauthorized !== false,
  };
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function doRequest(conn, method, path, body) {
  return new Promise((resolve, reject) => {
    const url = path.startsWith("http") ? path : `${NOTION_BASE}${path}`;
    let urlObj;
    try { urlObj = new URL(url); } catch { return reject(new Error(`Invalid URL: ${url}`)); }

    const M = method.toUpperCase();
    const isWrite = ["POST", "PUT", "PATCH"].includes(M);
    const reqBody = (isWrite && body !== undefined) ? JSON.stringify(body) : undefined;

    const headers = {
      "Authorization":   `Bearer ${conn.token}`,
      "Notion-Version": NOTION_VERSION,
      "Accept":          "application/json",
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
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") });
      });
      res.on("error", (err) => { clearTimeout(timer); reject(err); });
    });
    req.on("error", (err) => { clearTimeout(timer); reject(err); });
    if (isWrite && reqBody !== undefined) req.write(reqBody);
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
    const msg = (j.message) || (j.code) || res.body.slice(0, 300);
    throw new Error(`Notion API error ${res.status}: ${msg}`);
  }
  return j;
}

// ─── Map helpers ──────────────────────────────────────────────────────────────

function mapPage(p) {
  if (!p) return null;
  return {
    id:             p.id,
    object:         p.object,
    url:            p.url,
    createdTime:    p.created_time,
    lastEdited:     p.last_edited_time,
    archived:       p.archived,
    inTrash:        p.in_trash,
    parent:         p.parent,
    icon:           p.icon,
    cover:          p.cover,
    properties:     p.properties,
    publicUrl:      p.public_url,
  };
}

function mapDatabase(d) {
  if (!d) return null;
  return {
    id:             d.id,
    object:         d.object,
    url:            d.url,
    title:          d.title,
    description:    d.description,
    createdTime:    d.created_time,
    lastEdited:     d.last_edited_time,
    archived:       d.archived,
    inTrash:        d.in_trash,
    parent:         d.parent,
    icon:           d.icon,
    cover:          d.cover,
    properties:     d.properties,
    publicUrl:      d.public_url,
    isInline:       d.is_inline,
  };
}

function mapBlock(b) {
  if (!b) return null;
  const out = {
    id:             b.id,
    object:         b.object,
    type:           b.type,
    createdTime:    b.created_time,
    lastEdited:     b.last_edited_time,
    archived:       b.archived,
    inTrash:        b.in_trash,
    hasChildren:    b.has_children,
    parent:         b.parent,
  };
  if (b.type && b[b.type] !== undefined) out.content = b[b.type];
  return out;
}

function mapUser(u) {
  if (!u) return null;
  return {
    id:         u.id,
    object:     u.object,
    type:       u.type,
    name:       u.name,
    avatarUrl:  u.avatar_url,
    person:     u.person,
    bot:        u.bot,
  };
}

function mapComment(c) {
  if (!c) return null;
  return {
    id:           c.id,
    object:       c.object,
    parent:       c.parent,
    discussionId: c.discussion_id,
    createdTime:  c.created_time,
    lastEdited:   c.last_edited_time,
    createdBy:    c.created_by,
    richText:     c.rich_text,
  };
}

function pageResult(j) {
  return {
    results:    j.results || [],
    hasMore:    j.has_more || false,
    nextCursor: j.next_cursor || null,
    type:       j.type,
  };
}

// ─── PAGES ────────────────────────────────────────────────────────────────────

async function pageGet(conn, args) {
  const { page_id } = args;
  requireString(page_id, "page_id");
  const res = await doRequest(conn, "GET", `/pages/${enc(page_id)}`);
  if (res.status === 404) return { page: null, exists: false };
  const j = parseJson(res);
  return { page: mapPage(j), exists: true };
}

async function pageCreate(conn, args) {
  const { parent, properties, children, icon, cover } = args;
  if (!parent || typeof parent !== "object")
    throw new Error("parent must be an object with type (page_id or database_id)");
  if (!properties || typeof properties !== "object")
    throw new Error("properties must be an object");
  const payload = { parent, properties };
  if (children && Array.isArray(children)) payload.children = children;
  if (icon)  payload.icon  = icon;
  if (cover) payload.cover = cover;
  const res = await doRequest(conn, "POST", "/pages", payload);
  const j = parseJson(res);
  return { created: true, page: mapPage(j) };
}

async function pageUpdate(conn, args) {
  const { page_id, properties, icon, cover, archived } = args;
  requireString(page_id, "page_id");
  const payload = {};
  if (properties) payload.properties = properties;
  if (icon !== undefined) payload.icon = icon;
  if (cover !== undefined) payload.cover = cover;
  if (archived !== undefined) payload.archived = archived;
  const res = await doRequest(conn, "PATCH", `/pages/${enc(page_id)}`, payload);
  const j = parseJson(res);
  return { updated: true, page: mapPage(j) };
}

async function pageArchive(conn, args) {
  const { page_id } = args;
  requireString(page_id, "page_id");
  const res = await doRequest(conn, "PATCH", `/pages/${enc(page_id)}`, { archived: true });
  const j = parseJson(res);
  return { archived: true, page: mapPage(j) };
}

async function pageRestore(conn, args) {
  const { page_id } = args;
  requireString(page_id, "page_id");
  const res = await doRequest(conn, "PATCH", `/pages/${enc(page_id)}`, { archived: false, in_trash: false });
  const j = parseJson(res);
  return { restored: true, page: mapPage(j) };
}

async function pageRetrieveProperty(conn, args) {
  const { page_id, property_id } = args;
  requireString(page_id, "page_id");
  requireString(property_id, "property_id");
  const res = await doRequest(conn, "GET", `/pages/${enc(page_id)}/properties/${enc(property_id)}`);
  const j = parseJson(res);
  return { property: j };
}

async function pageGetPropertyItem(conn, args) {
  const { page_id, property_id, start_cursor, page_size } = args;
  requireString(page_id, "page_id");
  requireString(property_id, "property_id");
  const params = {};
  if (start_cursor) params.start_cursor = start_cursor;
  if (page_size) params.page_size = clampInt(page_size, 1, 100, 100);
  const qstr = qs(params);
  const res = await doRequest(conn, "GET", `/pages/${enc(page_id)}/properties/${enc(property_id)}${qstr}`);
  const j = parseJson(res);
  return { propertyItem: j };
}

// ─── Page content helpers ─────────────────────────────────────────────────────

async function pageContentGet(conn, args) {
  const { page_id, start_cursor, page_size } = args;
  requireString(page_id, "page_id");
  const params = {};
  if (start_cursor) params.start_cursor = start_cursor;
  if (page_size) params.page_size = clampInt(page_size, 1, 100, 100);
  const qstr = qs(params);
  const res = await doRequest(conn, "GET", `/blocks/${enc(page_id)}/children${qstr}`);
  const j = parseJson(res);
  const pr = pageResult(j);
  return { blocks: pr.results.map(mapBlock), hasMore: pr.hasMore, nextCursor: pr.nextCursor };
}

async function pageContentAppend(conn, args) {
  const { page_id, children } = args;
  requireString(page_id, "page_id");
  if (!Array.isArray(children) || children.length === 0)
    throw new Error("children must be a non-empty array of block objects");
  const res = await doRequest(conn, "PATCH", `/blocks/${enc(page_id)}/children`, { children });
  const j = parseJson(res);
  const pr = pageResult(j);
  return { appended: true, blocks: pr.results.map(mapBlock) };
}

async function pageTitleSet(conn, args) {
  const { page_id, title, property_name } = args;
  requireString(page_id, "page_id");
  requireString(title, "title");
  const propName = property_name || "title";
  const properties = {
    [propName]: { title: [{ type: "text", text: { content: title } }] },
  };
  const res = await doRequest(conn, "PATCH", `/pages/${enc(page_id)}`, { properties });
  const j = parseJson(res);
  return { updated: true, page: mapPage(j) };
}

async function pageIconSet(conn, args) {
  const { page_id, icon_type, icon_value } = args;
  requireString(page_id, "page_id");
  requireString(icon_type, "icon_type");
  requireString(icon_value, "icon_value");
  let icon;
  if (icon_type === "emoji") {
    icon = { type: "emoji", emoji: icon_value };
  } else if (icon_type === "external") {
    icon = { type: "external", external: { url: icon_value } };
  } else {
    throw new Error("icon_type must be 'emoji' or 'external'");
  }
  const res = await doRequest(conn, "PATCH", `/pages/${enc(page_id)}`, { icon });
  const j = parseJson(res);
  return { updated: true, icon: j.icon };
}

async function pageCoverSet(conn, args) {
  const { page_id, cover_url } = args;
  requireString(page_id, "page_id");
  requireString(cover_url, "cover_url");
  const cover = { type: "external", external: { url: cover_url } };
  const res = await doRequest(conn, "PATCH", `/pages/${enc(page_id)}`, { cover });
  const j = parseJson(res);
  return { updated: true, cover: j.cover };
}

async function pagePropertiesSet(conn, args) {
  const { page_id, properties } = args;
  requireString(page_id, "page_id");
  if (!properties || typeof properties !== "object")
    throw new Error("properties must be an object");
  const res = await doRequest(conn, "PATCH", `/pages/${enc(page_id)}`, { properties });
  const j = parseJson(res);
  return { updated: true, page: mapPage(j) };
}

// ─── DATABASES ────────────────────────────────────────────────────────────────

async function databaseList(conn, args) {
  // Notion doesn't have a list-databases endpoint directly — use search
  const { start_cursor, page_size } = args;
  const payload = { filter: { value: "database", property: "object" } };
  if (start_cursor) payload.start_cursor = start_cursor;
  if (page_size)   payload.page_size = clampInt(page_size, 1, 100, 100);
  const res = await doRequest(conn, "POST", "/search", payload);
  const j = parseJson(res);
  const pr = pageResult(j);
  return { databases: pr.results.map(mapDatabase), hasMore: pr.hasMore, nextCursor: pr.nextCursor };
}

async function databaseGet(conn, args) {
  const { database_id } = args;
  requireString(database_id, "database_id");
  const res = await doRequest(conn, "GET", `/databases/${enc(database_id)}`);
  if (res.status === 404) return { database: null, exists: false };
  const j = parseJson(res);
  return { database: mapDatabase(j), exists: true };
}

async function databaseCreate(conn, args) {
  const { parent, title, properties, icon, cover, is_inline } = args;
  if (!parent || typeof parent !== "object")
    throw new Error("parent must be an object with page_id");
  if (!properties || typeof properties !== "object")
    throw new Error("properties must be an object defining database schema");
  const payload = { parent, properties };
  if (title) {
    payload.title = Array.isArray(title)
      ? title
      : [{ type: "text", text: { content: String(title) } }];
  }
  if (icon)      payload.icon      = icon;
  if (cover)     payload.cover     = cover;
  if (is_inline !== undefined) payload.is_inline = is_inline;
  const res = await doRequest(conn, "POST", "/databases", payload);
  const j = parseJson(res);
  return { created: true, database: mapDatabase(j) };
}

async function databaseUpdate(conn, args) {
  const { database_id, title, description, properties, icon, cover } = args;
  requireString(database_id, "database_id");
  const payload = {};
  if (title) {
    payload.title = Array.isArray(title)
      ? title
      : [{ type: "text", text: { content: String(title) } }];
  }
  if (description !== undefined) payload.description = description;
  if (properties)  payload.properties = properties;
  if (icon)        payload.icon       = icon;
  if (cover)       payload.cover      = cover;
  const res = await doRequest(conn, "PATCH", `/databases/${enc(database_id)}`, payload);
  const j = parseJson(res);
  return { updated: true, database: mapDatabase(j) };
}

async function databaseQuery(conn, args) {
  const { database_id, filter, sorts, start_cursor, page_size } = args;
  requireString(database_id, "database_id");
  const payload = {};
  if (filter)       payload.filter       = filter;
  if (sorts)        payload.sorts        = sorts;
  if (start_cursor) payload.start_cursor = start_cursor;
  if (page_size)    payload.page_size    = clampInt(page_size, 1, 100, 100);
  const res = await doRequest(conn, "POST", `/databases/${enc(database_id)}/query`, payload);
  const j = parseJson(res);
  const pr = pageResult(j);
  return { results: pr.results.map(mapPage), hasMore: pr.hasMore, nextCursor: pr.nextCursor, count: pr.results.length };
}

async function databaseFilter(conn, args) {
  // Alias for databaseQuery with cleaner parameter name
  return databaseQuery(conn, args);
}

async function databaseRestore(conn, args) {
  const { database_id } = args;
  requireString(database_id, "database_id");
  const res = await doRequest(conn, "PATCH", `/databases/${enc(database_id)}`, { archived: false, in_trash: false });
  const j = parseJson(res);
  return { restored: true, database: mapDatabase(j) };
}

// ─── BLOCKS ───────────────────────────────────────────────────────────────────

async function blockGet(conn, args) {
  const { block_id } = args;
  requireString(block_id, "block_id");
  const res = await doRequest(conn, "GET", `/blocks/${enc(block_id)}`);
  if (res.status === 404) return { block: null, exists: false };
  const j = parseJson(res);
  return { block: mapBlock(j), exists: true };
}

async function blockUpdate(conn, args) {
  const { block_id, content, archived } = args;
  requireString(block_id, "block_id");
  if (content === undefined && archived === undefined)
    throw new Error("At least one of content or archived must be provided");
  const payload = {};
  if (content !== undefined)  payload.content  = content;   // raw block-type content
  if (archived !== undefined) payload.archived = archived;
  const res = await doRequest(conn, "PATCH", `/blocks/${enc(block_id)}`, payload);
  const j = parseJson(res);
  return { updated: true, block: mapBlock(j) };
}

async function blockDelete(conn, args) {
  const { block_id } = args;
  requireString(block_id, "block_id");
  const res = await doRequest(conn, "DELETE", `/blocks/${enc(block_id)}`);
  if (res.status === 404) return { deleted: false, block_id };
  parseJson(res);
  return { deleted: true, block_id };
}

async function blockChildrenList(conn, args) {
  const { block_id, start_cursor, page_size } = args;
  requireString(block_id, "block_id");
  const params = {};
  if (start_cursor) params.start_cursor = start_cursor;
  if (page_size) params.page_size = clampInt(page_size, 1, 100, 100);
  const res = await doRequest(conn, "GET", `/blocks/${enc(block_id)}/children${qs(params)}`);
  const j = parseJson(res);
  const pr = pageResult(j);
  return { blocks: pr.results.map(mapBlock), hasMore: pr.hasMore, nextCursor: pr.nextCursor };
}

async function blockChildrenAppend(conn, args) {
  const { block_id, children } = args;
  requireString(block_id, "block_id");
  if (!Array.isArray(children) || children.length === 0)
    throw new Error("children must be a non-empty array of block objects");
  const res = await doRequest(conn, "PATCH", `/blocks/${enc(block_id)}/children`, { children });
  const j = parseJson(res);
  const pr = pageResult(j);
  return { appended: true, blocks: pr.results.map(mapBlock) };
}

async function blockRestore(conn, args) {
  const { block_id } = args;
  requireString(block_id, "block_id");
  const res = await doRequest(conn, "PATCH", `/blocks/${enc(block_id)}`, { archived: false, in_trash: false });
  const j = parseJson(res);
  return { restored: true, block: mapBlock(j) };
}

// ─── COMMENTS ─────────────────────────────────────────────────────────────────

async function commentList(conn, args) {
  const { block_id, start_cursor, page_size } = args;
  requireString(block_id, "block_id");
  const params = { block_id };
  if (start_cursor) params.start_cursor = start_cursor;
  if (page_size)    params.page_size    = clampInt(page_size, 1, 100, 100);
  const res = await doRequest(conn, "GET", `/comments${qs(params)}`);
  const j = parseJson(res);
  const pr = pageResult(j);
  return { comments: pr.results.map(mapComment), hasMore: pr.hasMore, nextCursor: pr.nextCursor };
}

async function commentCreate(conn, args) {
  const { parent, discussion_id, rich_text } = args;
  if (!rich_text || !Array.isArray(rich_text) || rich_text.length === 0)
    throw new Error("rich_text must be a non-empty array of rich text objects");
  if (!parent && !discussion_id)
    throw new Error("Either parent (page_id) or discussion_id must be provided");
  const payload = { rich_text };
  if (parent)        payload.parent        = parent;
  if (discussion_id) payload.discussion_id = discussion_id;
  const res = await doRequest(conn, "POST", "/comments", payload);
  const j = parseJson(res);
  return { created: true, comment: mapComment(j) };
}

async function commentGet(conn, args) {
  // Get comments for a page (alias for comment_list with page_id as block_id)
  return commentList(conn, args);
}

// ─── USERS ────────────────────────────────────────────────────────────────────

async function userList(conn, args) {
  const { start_cursor, page_size } = args;
  const params = {};
  if (start_cursor) params.start_cursor = start_cursor;
  if (page_size)    params.page_size    = clampInt(page_size, 1, 100, 100);
  const res = await doRequest(conn, "GET", `/users${qs(params)}`);
  const j = parseJson(res);
  const pr = pageResult(j);
  return { users: pr.results.map(mapUser), hasMore: pr.hasMore, nextCursor: pr.nextCursor };
}

async function userGet(conn, args) {
  const { user_id } = args;
  requireString(user_id, "user_id");
  const res = await doRequest(conn, "GET", `/users/${enc(user_id)}`);
  if (res.status === 404) return { user: null, exists: false };
  const j = parseJson(res);
  return { user: mapUser(j), exists: true };
}

async function userMe(conn) {
  const res = await doRequest(conn, "GET", "/users/me");
  const j = parseJson(res);
  return { user: mapUser(j) };
}

// ─── SEARCH ───────────────────────────────────────────────────────────────────

async function search(conn, args) {
  const { query, sort, filter, start_cursor, page_size } = args;
  const payload = {};
  if (query)        { guardString(query, "query"); payload.query = query; }
  if (sort)         payload.sort         = sort;
  if (filter)       payload.filter       = filter;
  if (start_cursor) payload.start_cursor = start_cursor;
  if (page_size)    payload.page_size    = clampInt(page_size, 1, 100, 100);
  const res = await doRequest(conn, "POST", "/search", payload);
  const j = parseJson(res);
  const pr = pageResult(j);
  return {
    results:    pr.results,
    hasMore:    pr.hasMore,
    nextCursor: pr.nextCursor,
    count:      pr.results.length,
  };
}

async function searchFilter(conn, args) {
  const { query, object_type, start_cursor, page_size } = args;
  guardString(query, "query");
  if (!object_type) throw new Error("object_type must be 'page' or 'database'");
  if (!["page", "database"].includes(object_type))
    throw new Error("object_type must be 'page' or 'database'");
  const payload = {
    filter: { value: object_type, property: "object" },
  };
  if (query)        payload.query        = query;
  if (start_cursor) payload.start_cursor = start_cursor;
  if (page_size)    payload.page_size    = clampInt(page_size, 1, 100, 100);
  const res = await doRequest(conn, "POST", "/search", payload);
  const j = parseJson(res);
  const pr = pageResult(j);
  return {
    results:    pr.results,
    hasMore:    pr.hasMore,
    nextCursor: pr.nextCursor,
    count:      pr.results.length,
    objectType: object_type,
  };
}

// ─── PROPERTIES ───────────────────────────────────────────────────────────────

async function propertyGet(conn, args) {
  const { page_id, property_id } = args;
  requireString(page_id, "page_id");
  requireString(property_id, "property_id");
  const res = await doRequest(conn, "GET", `/pages/${enc(page_id)}/properties/${enc(property_id)}`);
  const j = parseJson(res);
  return { property: j };
}

async function propertyList(conn, args) {
  const { database_id } = args;
  requireString(database_id, "database_id");
  const res = await doRequest(conn, "GET", `/databases/${enc(database_id)}`);
  const j = parseJson(res);
  return { properties: j.properties || {}, databaseId: database_id };
}

// ─── WORKSPACE ────────────────────────────────────────────────────────────────

async function workspaceInfo(conn) {
  // Get the bot user which includes workspace info
  const res = await doRequest(conn, "GET", "/users/me");
  const j = parseJson(res);
  return {
    bot:       j.bot,
    workspace: j.bot && j.bot.workspace_name ? { name: j.bot.workspace_name } : null,
    user:      mapUser(j),
  };
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

function notionInfo() {
  return {
    ok: true,
    api: "Notion REST API",
    version: NOTION_VERSION,
    base_url: NOTION_BASE,
    auth: ["token: Notion Integration Token (Bearer)"],
    operations: [
      "Pages: page_get, page_create, page_update, page_archive, page_restore, page_retrieve_property, page_get_property_item",
      "Databases: database_list, database_get, database_create, database_update, database_query, database_filter, database_restore",
      "Blocks: block_get, block_update, block_delete, block_children_list, block_children_append, block_restore",
      "Comments: comment_list, comment_create, comment_get",
      "Users: user_list, user_get, user_me",
      "Search: search, search_filter",
      "Properties: property_get, property_list",
      "Workspace: workspace_info",
      "Content helpers: page_content_get, page_content_append, page_title_set, page_icon_set, page_cover_set, page_properties_set",
      "Generic: request, info, version",
    ],
  };
}

function notionVersion() {
  return { notionVersion: NOTION_VERSION, sdkVersion: null, apiBaseUrl: NOTION_BASE };
}

// ─── Main dispatcher ──────────────────────────────────────────────────────────

async function notionClient(args) {
  if (!args || !args.operation) throw new Error("operation is required");
  const { operation } = args;

  if (operation === "info")    return notionInfo();
  if (operation === "version") return notionVersion();

  const conn = buildConn(args);

  switch (operation) {
    // Pages
    case "page_get":               return pageGet(conn, args);
    case "page_create":            return pageCreate(conn, args);
    case "page_update":            return pageUpdate(conn, args);
    case "page_archive":           return pageArchive(conn, args);
    case "page_restore":           return pageRestore(conn, args);
    case "page_retrieve_property": return pageRetrieveProperty(conn, args);
    case "page_get_property_item": return pageGetPropertyItem(conn, args);

    // Databases
    case "database_list":    return databaseList(conn, args);
    case "database_get":     return databaseGet(conn, args);
    case "database_create":  return databaseCreate(conn, args);
    case "database_update":  return databaseUpdate(conn, args);
    case "database_query":   return databaseQuery(conn, args);
    case "database_filter":  return databaseFilter(conn, args);
    case "database_restore": return databaseRestore(conn, args);

    // Blocks
    case "block_get":              return blockGet(conn, args);
    case "block_update":           return blockUpdate(conn, args);
    case "block_delete":           return blockDelete(conn, args);
    case "block_children_list":    return blockChildrenList(conn, args);
    case "block_children_append":  return blockChildrenAppend(conn, args);
    case "block_restore":          return blockRestore(conn, args);

    // Comments
    case "comment_list":   return commentList(conn, args);
    case "comment_create": return commentCreate(conn, args);
    case "comment_get":    return commentGet(conn, args);

    // Users
    case "user_list": return userList(conn, args);
    case "user_get":  return userGet(conn, args);
    case "user_me":   return userMe(conn);

    // Search
    case "search":        return search(conn, args);
    case "search_filter": return searchFilter(conn, args);

    // Properties
    case "property_get":  return propertyGet(conn, args);
    case "property_list": return propertyList(conn, args);

    // Workspace
    case "workspace_info": return workspaceInfo(conn);

    // Content helpers
    case "page_content_get":    return pageContentGet(conn, args);
    case "page_content_append": return pageContentAppend(conn, args);
    case "page_title_set":      return pageTitleSet(conn, args);
    case "page_icon_set":       return pageIconSet(conn, args);
    case "page_cover_set":      return pageCoverSet(conn, args);
    case "page_properties_set": return pagePropertiesSet(conn, args);

    // Generic
    case "request": return genericRequest(conn, args);

    default:
      throw new Error(
        `Unknown operation: '${operation}'. Valid operations: ` +
        `page_get, page_create, page_update, page_archive, page_restore, page_retrieve_property, page_get_property_item, ` +
        `database_list, database_get, database_create, database_update, database_query, database_filter, database_restore, ` +
        `block_get, block_update, block_delete, block_children_list, block_children_append, block_restore, ` +
        `comment_list, comment_create, comment_get, ` +
        `user_list, user_get, user_me, ` +
        `search, search_filter, ` +
        `property_get, property_list, ` +
        `workspace_info, ` +
        `page_content_get, page_content_append, page_title_set, page_icon_set, page_cover_set, page_properties_set, ` +
        `request, info, version`
      );
  }
}

module.exports = { notionClient };
