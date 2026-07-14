"use strict";
/**
 * confluence_client — Zero-dependency Confluence REST API client
 * (pure Node.js https built-ins; no npm deps)
 *
 * Authentication:
 *   - API Token (email + api_token via HTTP Basic Auth) — Confluence Cloud
 *     Base64-encodes "email:api_token" -> Authorization: Basic ...
 *   - Personal Access Token / Bearer token (pat) — Confluence Server/DC
 *     Authorization: Bearer <pat>
 *   Unauthenticated access allowed for public Confluence instances.
 *   Credentials never returned in output or errors.
 *
 * Base URL:
 *   For Confluence Cloud: https://<your-domain>.atlassian.net
 *   For Confluence Server/Data Center: https://<your-host>
 *   Pass base_url to override.
 *
 * API used:
 *   Cloud:         /wiki/api/v2  (Confluence Cloud v2 REST API)
 *   Server/DC:     /rest/api     (Confluence Server REST API)
 *   cloud:true (default) selects v2; cloud:false selects server REST API.
 *
 * Supported operations (54 total):
 *
 *   Spaces (5):
 *     space_list, space_get, space_create, space_delete, space_permissions
 *
 *   Pages (9):
 *     page_list, page_get, page_create, page_update, page_delete,
 *     page_children, page_ancestors, page_search, page_move
 *
 *   Blog Posts (5):
 *     blog_list, blog_get, blog_create, blog_update, blog_delete
 *
 *   Comments (5):
 *     comment_list, comment_get, comment_create, comment_update, comment_delete
 *
 *   Attachments (5):
 *     attachment_list, attachment_get, attachment_upload,
 *     attachment_delete, attachment_download_url
 *
 *   Labels (4):
 *     label_list, label_add, label_remove, label_search
 *
 *   Search (2):
 *     search, search_user
 *
 *   Users (4):
 *     user_get, user_me, user_groups, user_watch_list
 *
 *   Watchers (2):
 *     watcher_list, watcher_add
 *
 *   Tasks (3):
 *     task_list, task_get, task_update
 *
 *   Versions (4):
 *     version_list, version_get, version_restore, page_history
 *
 *   Templates (3):
 *     template_list, template_get, template_create
 *
 *   Generic (3):
 *     request, info, space_content
 *
 * Security:
 *   NUL-byte guards on all string inputs.
 *   Timeout clamped 1000–120000 ms.
 *   Credentials never returned in output or errors.
 *   16 MB response cap.
 *   TLS enforced by default (reject_unauthorized).
 */

const https = require("https");
const http  = require("http");

// --- Constants ---------------------------------------------------------------

const DEFAULT_TIMEOUT_MS   = 20000;
const MAX_RESPONSE_BYTES   = 16 * 1024 * 1024; // 16 MB
const CONFLUENCE_API_V2    = "/wiki/api/v2";
const CONFLUENCE_API_REST  = "/rest/api";
const CONFLUENCE_WIKI_REST = "/wiki/rest/api"; // Cloud also supports this legacy path

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

function guardInt(val, name) {
  if (val === undefined || val === null) return;
  if (!Number.isFinite(Number(val))) throw new Error(`${name} must be a number`);
}

function clampInt(val, min, max, def) {
  if (val === undefined || val === null) return def;
  const n = Number(val);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function enc(s) {
  return encodeURIComponent(String(s));
}

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

// --- Build connection config --------------------------------------------------

function buildConn(args) {
  const {
    base_url,
    email,
    api_token,
    pat,
    timeout,
    reject_unauthorized,
    cloud,
  } = args;

  guardString(base_url, "base_url");
  guardString(email, "email");
  guardString(api_token, "api_token");
  guardString(pat, "pat");

  // Determine auth header
  let authHeader = null;
  if (pat) {
    authHeader = `Bearer ${pat}`;
  } else if (email && api_token) {
    const creds = Buffer.from(`${email}:${api_token}`).toString("base64");
    authHeader = `Basic ${creds}`;
  }

  const rawBase = (base_url || "").replace(/\/+$/, "");
  if (rawBase && rawBase.includes("\0"))
    throw new Error("base_url must not contain NUL bytes");

  // Determine API prefix: Cloud v2 vs Server/DC REST
  const isCloud = cloud !== false; // default true
  const apiPrefix = isCloud ? CONFLUENCE_API_V2 : CONFLUENCE_API_REST;
  // Legacy REST path used for some Cloud operations (search, templates)
  const legacyPrefix = isCloud ? CONFLUENCE_WIKI_REST : CONFLUENCE_API_REST;

  return {
    baseUrl: rawBase || "",
    authHeader,
    timeoutMs: clampInt(timeout, 1000, 120000, DEFAULT_TIMEOUT_MS),
    rejectUnauthorized: reject_unauthorized !== false,
    isCloud,
    apiPrefix,
    legacyPrefix,
  };
}

// --- HTTP helper -------------------------------------------------------------

function doRequest(conn, method, path, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const fullUrl = `${conn.baseUrl}${path}`;
    let urlObj;
    try { urlObj = new URL(fullUrl); }
    catch { return reject(new Error(`Invalid URL: ${fullUrl}`)); }

    const isHttps = urlObj.protocol === "https:";
    const transport = isHttps ? https : http;
    const port = urlObj.port
      ? Number(urlObj.port)
      : isHttps ? 443 : 80;

    const reqBody = body !== undefined ? JSON.stringify(body) : undefined;

    const headers = {
      "Accept":       "application/json",
      "Content-Type": "application/json",
      ...extraHeaders,
    };
    if (conn.authHeader) headers["Authorization"] = conn.authHeader;
    if (reqBody !== undefined) headers["Content-Length"] = Buffer.byteLength(reqBody);

    const options = {
      hostname:           urlObj.hostname,
      port,
      path:               urlObj.pathname + urlObj.search,
      method:             method.toUpperCase(),
      headers,
      rejectUnauthorized: conn.rejectUnauthorized,
    };

    const timer = setTimeout(() => {
      req.destroy();
      reject(new Error(`Request timed out after ${conn.timeoutMs}ms`));
    }, conn.timeoutMs);

    const req = transport.request(options, (res) => {
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
    if (reqBody !== undefined) req.write(reqBody);
    req.end();
  });
}

function parseJson(text) {
  if (!text || !text.trim()) return null;
  try { return JSON.parse(text); }
  catch (e) { throw new Error(`Invalid JSON response: ${e.message}`); }
}

async function checkStatus(res, allow204 = false, allow404 = false) {
  if (allow204 && (res.status === 204 || res.status === 200)) return null;
  if (allow404 && res.status === 404) return null;
  if (res.status >= 200 && res.status < 300) return parseJson(res.body);
  // Parse Confluence error format
  let detail = "";
  try {
    const j = JSON.parse(res.body);
    if (j && j.message) detail = j.message;
    else if (j && j.errors && Array.isArray(j.errors) && j.errors.length)
      detail = j.errors.map(e => e.message || JSON.stringify(e)).join("; ");
    else if (j && j.errorMessages && Array.isArray(j.errorMessages))
      detail = j.errorMessages.join("; ");
    else if (j) detail = JSON.stringify(j).slice(0, 300);
  } catch { detail = res.body.slice(0, 300); }
  throw new Error(`HTTP ${res.status}${detail ? ": " + detail : ""}`);
}

// --- Map helpers -------------------------------------------------------------

function mapPage(p) {
  if (!p) return null;
  return {
    id:          p.id,
    title:       p.title,
    status:      p.status,
    spaceId:     p.spaceId || (p.space && p.space.key),
    parentId:    p.parentId,
    authorId:    (p.version && p.version.authorId) || (p.history && p.history.createdBy && p.history.createdBy.accountId),
    version:     (p.version && p.version.number) || (p.history && p.history.latest && p.history.lastUpdated && p.history.lastUpdated.number),
    createdAt:   (p.createdAt) || (p.history && p.history.createdDate),
    updatedAt:   (p.version && p.version.createdAt),
    url:         (p._links && (p._links.webui || p._links.base + p._links.webui)) || null,
    bodyType:    p.body ? Object.keys(p.body)[0] : undefined,
  };
}

function mapSpace(s) {
  if (!s) return null;
  return {
    id:          s.id,
    key:         s.key,
    name:        s.name,
    type:        s.type,
    status:      s.status,
    description: (s.description && (s.description.plain && s.description.plain.value)) || s.description || "",
    url:         (s._links && s._links.webui) || null,
    homepageId:  s.homepageId,
  };
}

function mapBlogPost(b) {
  if (!b) return null;
  return {
    id:       b.id,
    title:    b.title,
    status:   b.status,
    spaceId:  b.spaceId || (b.space && b.space.key),
    authorId: (b.version && b.version.authorId),
    version:  (b.version && b.version.number),
    createdAt: b.createdAt,
    url:       (b._links && b._links.webui) || null,
  };
}

function mapComment(c) {
  if (!c) return null;
  return {
    id:        c.id,
    pageId:    c.pageId,
    status:    c.status,
    authorId:  (c.version && c.version.authorId),
    version:   (c.version && c.version.number),
    createdAt: c.createdAt,
    body:      (c.body && (c.body.atlas_doc_format || c.body.storage)) || undefined,
  };
}

function mapAttachment(a) {
  if (!a) return null;
  return {
    id:          a.id,
    title:       a.title,
    fileSize:    a.fileSize,
    mediaType:   a.mediaType,
    comment:     a.comment,
    downloadUrl: (a._links && a._links.download) || null,
    createdAt:   a.createdAt,
    authorId:    (a.version && a.version.authorId),
  };
}

function mapUser(u) {
  if (!u) return null;
  return {
    accountId:   u.accountId || u.userKey,
    displayName: u.displayName,
    email:       u.email,
    type:        u.type || u.accountType,
    url:         (u._links && u._links.self) || null,
  };
}

function mapLabel(l) {
  if (!l) return null;
  return { id: l.id, name: l.name, prefix: l.prefix };
}

// --- Operations --------------------------------------------------------------

// SPACES

async function spaceList(conn, args) {
  const { limit, cursor, type, status, keys } = args;
  const q = qs({
    limit:  clampInt(limit, 1, 250, 25),
    cursor,
    type,
    status,
    keys,
  });
  const res = await doRequest(conn, "GET", `${conn.apiPrefix}/spaces${q}`);
  if (res.status === 404) return { spaces: [], total: 0, _note: "No spaces found" };
  const j = await checkStatus(res);
  const results = (j && (j.results || j.spaces)) || [];
  return {
    spaces: results.map(mapSpace),
    total:  j && (j.size !== undefined ? j.size : results.length),
    cursor: j && j._links && j._links.next ? j._links.next : null,
  };
}

async function spaceGet(conn, args) {
  const { space_id, space_key } = args;
  if (!space_id && !space_key) throw new Error("space_id or space_key is required");
  guardString(space_id, "space_id");
  guardString(space_key, "space_key");
  let path;
  if (conn.isCloud) {
    path = space_id
      ? `${conn.apiPrefix}/spaces/${enc(space_id)}`
      : `${conn.legacyPrefix}/space/${enc(space_key)}`;
  } else {
    path = `${conn.apiPrefix}/space/${enc(space_key || space_id)}`;
  }
  const res = await doRequest(conn, "GET", path);
  if (res.status === 404) return { exists: false, space_id, space_key };
  const j = await checkStatus(res);
  return { exists: true, space: mapSpace(j) };
}

async function spaceCreate(conn, args) {
  const { key, name, description, type } = args;
  requireString(key, "key");
  requireString(name, "name");
  guardString(description, "description");
  const body = { key, name, type: type || "global" };
  if (description) body.description = { plain: { value: description, representation: "plain" } };
  const path = conn.isCloud ? `${conn.legacyPrefix}/space` : `${conn.apiPrefix}/space`;
  const res = await doRequest(conn, "POST", path, body);
  const j = await checkStatus(res);
  return { created: true, space: mapSpace(j) };
}

async function spaceDelete(conn, args) {
  const { space_key } = args;
  requireString(space_key, "space_key");
  const path = conn.isCloud ? `${conn.legacyPrefix}/space/${enc(space_key)}` : `${conn.apiPrefix}/space/${enc(space_key)}`;
  const res = await doRequest(conn, "DELETE", path);
  if (res.status === 404) return { deleted: false, space_key };
  await checkStatus(res, true);
  return { deleted: true, space_key };
}

async function spacePermissions(conn, args) {
  const { space_key } = args;
  requireString(space_key, "space_key");
  const path = conn.isCloud
    ? `${conn.legacyPrefix}/space/${enc(space_key)}/permission`
    : `${conn.apiPrefix}/space/${enc(space_key)}/permission`;
  const res = await doRequest(conn, "GET", path);
  if (res.status === 404) return { exists: false, space_key };
  const j = await checkStatus(res);
  const results = Array.isArray(j) ? j : (j && (j.results || j.permissions)) || [];
  return { space_key, permissions: results };
}

async function spaceContent(conn, args) {
  const { space_key, type, limit, start, expand } = args;
  requireString(space_key, "space_key");
  guardString(type, "type");
  const q = qs({ type: type || "page", limit: clampInt(limit, 1, 50, 25), start: start || 0, expand });
  const path = conn.isCloud
    ? `${conn.legacyPrefix}/space/${enc(space_key)}/content${q}`
    : `${conn.apiPrefix}/space/${enc(space_key)}/content${q}`;
  const res = await doRequest(conn, "GET", path);
  if (res.status === 404) return { exists: false, space_key };
  const j = await checkStatus(res);
  const pages = (j && j.page && j.page.results) || [];
  const blogs = (j && j.blogpost && j.blogpost.results) || [];
  return { space_key, pages: pages.map(mapPage), blogs: blogs.map(mapBlogPost) };
}

// PAGES

async function pageList(conn, args) {
  const { space_id, space_key, limit, cursor, status, title } = args;
  guardString(space_id, "space_id");
  guardString(space_key, "space_key");
  if (conn.isCloud) {
    const q = qs({ spaceId: space_id, limit: clampInt(limit, 1, 250, 25), cursor, status, title });
    const res = await doRequest(conn, "GET", `${conn.apiPrefix}/pages${q}`);
    if (res.status === 404) return { pages: [], total: 0 };
    const j = await checkStatus(res);
    const results = (j && j.results) || [];
    return { pages: results.map(mapPage), total: results.length, cursor: j && j._links && j._links.next };
  } else {
    const key = space_key || space_id;
    if (!key) throw new Error("space_key is required for Server/DC mode");
    const q = qs({ spaceKey: key, limit: clampInt(limit, 1, 50, 25), start: 0, status, title, type: "page" });
    const res = await doRequest(conn, "GET", `${conn.apiPrefix}/content${q}`);
    if (res.status === 404) return { pages: [], total: 0 };
    const j = await checkStatus(res);
    const results = (j && j.results) || [];
    return { pages: results.map(mapPage), total: j && j.size };
  }
}

async function pageGet(conn, args) {
  const { page_id, include_body } = args;
  requireString(page_id, "page_id");
  let path;
  if (conn.isCloud) {
    const q = qs({ "body-format": include_body ? "storage" : undefined });
    path = `${conn.apiPrefix}/pages/${enc(page_id)}${q}`;
  } else {
    const expand = ["version", "space", "history"];
    if (include_body) expand.push("body.storage");
    path = `${conn.apiPrefix}/content/${enc(page_id)}${qs({ expand: expand.join(",") })}`;
  }
  const res = await doRequest(conn, "GET", path);
  if (res.status === 404) return { exists: false, page_id };
  const j = await checkStatus(res);
  const page = mapPage(j);
  if (include_body && j.body) {
    page.body = (j.body.storage && j.body.storage.value) ||
                (j.body.atlas_doc_format && j.body.atlas_doc_format.value) ||
                JSON.stringify(j.body);
  }
  return { exists: true, page };
}

async function pageCreate(conn, args) {
  const { space_id, space_key, title, body, parent_id, status } = args;
  requireString(title, "title");
  requireString(body, "body");
  guardString(space_id, "space_id");
  guardString(space_key, "space_key");
  guardString(parent_id, "parent_id");
  if (conn.isCloud) {
    if (!space_id) throw new Error("space_id is required for Cloud mode");
    const payload = {
      spaceId: space_id,
      title,
      status: status || "current",
      body: { representation: "storage", value: body },
    };
    if (parent_id) payload.parentId = parent_id;
    const res = await doRequest(conn, "POST", `${conn.apiPrefix}/pages`, payload);
    const j = await checkStatus(res);
    return { created: true, page: mapPage(j) };
  } else {
    const key = space_key || space_id;
    if (!key) throw new Error("space_key is required for Server/DC mode");
    const payload = {
      type: "page",
      title,
      space: { key },
      status: status || "current",
      body: { storage: { value: body, representation: "storage" } },
    };
    if (parent_id) payload.ancestors = [{ id: parent_id }];
    const res = await doRequest(conn, "POST", `${conn.apiPrefix}/content`, payload);
    const j = await checkStatus(res);
    return { created: true, page: mapPage(j) };
  }
}

async function pageUpdate(conn, args) {
  const { page_id, title, body, version, status } = args;
  requireString(page_id, "page_id");
  requireString(title, "title");
  requireString(body, "body");
  if (version === undefined || version === null) throw new Error("version is required (current page version number)");
  const verNum = Number(version);
  if (!Number.isFinite(verNum)) throw new Error("version must be a number");
  if (conn.isCloud) {
    const payload = {
      id: page_id,
      title,
      status: status || "current",
      body: { representation: "storage", value: body },
      version: { number: verNum + 1 },
    };
    const res = await doRequest(conn, "PUT", `${conn.apiPrefix}/pages/${enc(page_id)}`, payload);
    const j = await checkStatus(res);
    return { updated: true, page: mapPage(j) };
  } else {
    const payload = {
      type: "page",
      title,
      status: status || "current",
      body: { storage: { value: body, representation: "storage" } },
      version: { number: verNum + 1 },
    };
    const res = await doRequest(conn, "PUT", `${conn.apiPrefix}/content/${enc(page_id)}`, payload);
    const j = await checkStatus(res);
    return { updated: true, page: mapPage(j) };
  }
}

async function pageDelete(conn, args) {
  const { page_id } = args;
  requireString(page_id, "page_id");
  const path = conn.isCloud
    ? `${conn.apiPrefix}/pages/${enc(page_id)}`
    : `${conn.apiPrefix}/content/${enc(page_id)}`;
  const res = await doRequest(conn, "DELETE", path);
  if (res.status === 404) return { deleted: false, page_id };
  await checkStatus(res, true);
  return { deleted: true, page_id };
}

async function pageChildren(conn, args) {
  const { page_id, limit, cursor } = args;
  requireString(page_id, "page_id");
  if (conn.isCloud) {
    const q = qs({ limit: clampInt(limit, 1, 250, 25), cursor });
    const res = await doRequest(conn, "GET", `${conn.apiPrefix}/pages/${enc(page_id)}/children${q}`);
    if (res.status === 404) return { exists: false, page_id };
    const j = await checkStatus(res);
    const results = (j && j.results) || [];
    return { page_id, children: results.map(mapPage), cursor: j && j._links && j._links.next };
  } else {
    const q = qs({ limit: clampInt(limit, 1, 50, 25), expand: "version,space" });
    const res = await doRequest(conn, "GET", `${conn.apiPrefix}/content/${enc(page_id)}/child/page${q}`);
    if (res.status === 404) return { exists: false, page_id };
    const j = await checkStatus(res);
    return { page_id, children: ((j && j.results) || []).map(mapPage) };
  }
}

async function pageAncestors(conn, args) {
  const { page_id } = args;
  requireString(page_id, "page_id");
  const path = conn.isCloud
    ? `${conn.apiPrefix}/pages/${enc(page_id)}/ancestors`
    : `${conn.apiPrefix}/content/${enc(page_id)}${qs({ expand: "ancestors" })}`;
  const res = await doRequest(conn, "GET", path);
  if (res.status === 404) return { exists: false, page_id };
  const j = await checkStatus(res);
  const ancestors = conn.isCloud
    ? ((j && j.results) || []).map(mapPage)
    : ((j && j.ancestors) || []).map(mapPage);
  return { page_id, ancestors };
}

async function pageSearch(conn, args) {
  const { cql, space_key, title, limit, start } = args;
  guardString(cql, "cql");
  guardString(space_key, "space_key");
  guardString(title, "title");
  let query = cql || "";
  if (!query) {
    const parts = ["type=page"];
    if (space_key) parts.push(`space.key='${space_key}'`);
    if (title) parts.push(`title~'${title}'`);
    query = parts.join(" AND ");
  }
  const path = conn.isCloud ? `${conn.legacyPrefix}/content/search` : `${conn.apiPrefix}/content/search`;
  const q = qs({ cql: query, limit: clampInt(limit, 1, 50, 25), start: start || 0, expand: "version,space" });
  const res = await doRequest(conn, "GET", `${path}${q}`);
  if (res.status === 404) return { pages: [], total: 0 };
  const j = await checkStatus(res);
  const results = (j && j.results) || [];
  return { pages: results.map(mapPage), total: j && j.totalSize };
}

async function pageMove(conn, args) {
  const { page_id, target_parent_id, position } = args;
  requireString(page_id, "page_id");
  requireString(target_parent_id, "target_parent_id");
  // Cloud v2 move endpoint
  const path = conn.isCloud
    ? `${conn.apiPrefix}/pages/${enc(page_id)}/move/${enc(position || "append")}/${enc(target_parent_id)}`
    : `${conn.apiPrefix}/content/${enc(page_id)}/pagehierarchy/move`;
  const body = conn.isCloud ? undefined : { targetId: target_parent_id, position: position || "append" };
  const res = await doRequest(conn, conn.isCloud ? "PUT" : "PUT", path, body);
  await checkStatus(res, true);
  return { moved: true, page_id, target_parent_id };
}

async function pageHistory(conn, args) {
  const { page_id, limit, start } = args;
  requireString(page_id, "page_id");
  if (conn.isCloud) {
    const q = qs({ limit: clampInt(limit, 1, 200, 25), cursor: start });
    const res = await doRequest(conn, "GET", `${conn.apiPrefix}/pages/${enc(page_id)}/versions${q}`);
    if (res.status === 404) return { exists: false, page_id };
    const j = await checkStatus(res);
    return { page_id, versions: (j && j.results) || [], cursor: j && j._links && j._links.next };
  } else {
    const q = qs({ limit: clampInt(limit, 1, 200, 25), start: start || 0, expand: "content" });
    const res = await doRequest(conn, "GET", `${conn.apiPrefix}/content/${enc(page_id)}/history${q}`);
    if (res.status === 404) return { exists: false, page_id };
    const j = await checkStatus(res);
    return { page_id, history: j };
  }
}

// BLOG POSTS

async function blogList(conn, args) {
  const { space_id, space_key, limit, cursor, status } = args;
  guardString(space_id, "space_id");
  guardString(space_key, "space_key");
  if (conn.isCloud) {
    const q = qs({ spaceId: space_id, limit: clampInt(limit, 1, 250, 25), cursor, status });
    const res = await doRequest(conn, "GET", `${conn.apiPrefix}/blogposts${q}`);
    if (res.status === 404) return { blogposts: [], total: 0 };
    const j = await checkStatus(res);
    const results = (j && j.results) || [];
    return { blogposts: results.map(mapBlogPost), cursor: j && j._links && j._links.next };
  } else {
    const key = space_key || space_id;
    if (!key) throw new Error("space_key is required for Server/DC mode");
    const q = qs({ spaceKey: key, limit: clampInt(limit, 1, 50, 25), type: "blogpost" });
    const res = await doRequest(conn, "GET", `${conn.apiPrefix}/content${q}`);
    if (res.status === 404) return { blogposts: [], total: 0 };
    const j = await checkStatus(res);
    return { blogposts: ((j && j.results) || []).map(mapBlogPost) };
  }
}

async function blogGet(conn, args) {
  const { blog_id, include_body } = args;
  requireString(blog_id, "blog_id");
  let path;
  if (conn.isCloud) {
    const q = qs({ "body-format": include_body ? "storage" : undefined });
    path = `${conn.apiPrefix}/blogposts/${enc(blog_id)}${q}`;
  } else {
    const expand = ["version", "space", "history"];
    if (include_body) expand.push("body.storage");
    path = `${conn.apiPrefix}/content/${enc(blog_id)}${qs({ expand: expand.join(",") })}`;
  }
  const res = await doRequest(conn, "GET", path);
  if (res.status === 404) return { exists: false, blog_id };
  const j = await checkStatus(res);
  const bp = mapBlogPost(j);
  if (include_body && j.body) {
    bp.body = (j.body.storage && j.body.storage.value) ||
              (j.body.atlas_doc_format && j.body.atlas_doc_format.value) ||
              JSON.stringify(j.body);
  }
  return { exists: true, blogpost: bp };
}

async function blogCreate(conn, args) {
  const { space_id, space_key, title, body, status } = args;
  requireString(title, "title");
  requireString(body, "body");
  if (conn.isCloud) {
    if (!space_id) throw new Error("space_id is required for Cloud mode");
    const payload = {
      spaceId: space_id,
      title,
      status: status || "current",
      body: { representation: "storage", value: body },
    };
    const res = await doRequest(conn, "POST", `${conn.apiPrefix}/blogposts`, payload);
    const j = await checkStatus(res);
    return { created: true, blogpost: mapBlogPost(j) };
  } else {
    const key = space_key || space_id;
    if (!key) throw new Error("space_key is required for Server/DC mode");
    const payload = {
      type: "blogpost",
      title,
      space: { key },
      status: status || "current",
      body: { storage: { value: body, representation: "storage" } },
    };
    const res = await doRequest(conn, "POST", `${conn.apiPrefix}/content`, payload);
    const j = await checkStatus(res);
    return { created: true, blogpost: mapBlogPost(j) };
  }
}

async function blogUpdate(conn, args) {
  const { blog_id, title, body, version, status } = args;
  requireString(blog_id, "blog_id");
  requireString(title, "title");
  requireString(body, "body");
  if (version === undefined) throw new Error("version is required");
  const verNum = Number(version);
  if (conn.isCloud) {
    const payload = {
      id: blog_id,
      title,
      status: status || "current",
      body: { representation: "storage", value: body },
      version: { number: verNum + 1 },
    };
    const res = await doRequest(conn, "PUT", `${conn.apiPrefix}/blogposts/${enc(blog_id)}`, payload);
    const j = await checkStatus(res);
    return { updated: true, blogpost: mapBlogPost(j) };
  } else {
    const payload = {
      type: "blogpost",
      title,
      status: status || "current",
      body: { storage: { value: body, representation: "storage" } },
      version: { number: verNum + 1 },
    };
    const res = await doRequest(conn, "PUT", `${conn.apiPrefix}/content/${enc(blog_id)}`, payload);
    const j = await checkStatus(res);
    return { updated: true, blogpost: mapBlogPost(j) };
  }
}

async function blogDelete(conn, args) {
  const { blog_id } = args;
  requireString(blog_id, "blog_id");
  const path = conn.isCloud
    ? `${conn.apiPrefix}/blogposts/${enc(blog_id)}`
    : `${conn.apiPrefix}/content/${enc(blog_id)}`;
  const res = await doRequest(conn, "DELETE", path);
  if (res.status === 404) return { deleted: false, blog_id };
  await checkStatus(res, true);
  return { deleted: true, blog_id };
}

// COMMENTS

async function commentList(conn, args) {
  const { page_id, limit, cursor, status } = args;
  requireString(page_id, "page_id");
  if (conn.isCloud) {
    const q = qs({ limit: clampInt(limit, 1, 250, 25), cursor, status });
    const res = await doRequest(conn, "GET", `${conn.apiPrefix}/pages/${enc(page_id)}/footer-comments${q}`);
    if (res.status === 404) return { comments: [], page_id };
    const j = await checkStatus(res);
    return { page_id, comments: ((j && j.results) || []).map(mapComment), cursor: j && j._links && j._links.next };
  } else {
    const q = qs({ limit: clampInt(limit, 1, 50, 25), expand: "version,body.storage" });
    const res = await doRequest(conn, "GET", `${conn.apiPrefix}/content/${enc(page_id)}/child/comment${q}`);
    if (res.status === 404) return { comments: [], page_id };
    const j = await checkStatus(res);
    return { page_id, comments: ((j && j.results) || []).map(mapComment) };
  }
}

async function commentGet(conn, args) {
  const { comment_id } = args;
  requireString(comment_id, "comment_id");
  const path = conn.isCloud
    ? `${conn.apiPrefix}/footer-comments/${enc(comment_id)}`
    : `${conn.apiPrefix}/content/${enc(comment_id)}${qs({ expand: "version,body.storage" })}`;
  const res = await doRequest(conn, "GET", path);
  if (res.status === 404) return { exists: false, comment_id };
  const j = await checkStatus(res);
  return { exists: true, comment: mapComment(j) };
}

async function commentCreate(conn, args) {
  const { page_id, body } = args;
  requireString(page_id, "page_id");
  requireString(body, "body");
  if (conn.isCloud) {
    const payload = {
      pageId: page_id,
      body: { representation: "storage", value: body },
    };
    const res = await doRequest(conn, "POST", `${conn.apiPrefix}/footer-comments`, payload);
    const j = await checkStatus(res);
    return { created: true, comment: mapComment(j) };
  } else {
    const payload = {
      type: "comment",
      container: { id: page_id, type: "page" },
      body: { storage: { value: body, representation: "storage" } },
    };
    const res = await doRequest(conn, "POST", `${conn.apiPrefix}/content`, payload);
    const j = await checkStatus(res);
    return { created: true, comment: mapComment(j) };
  }
}

async function commentUpdate(conn, args) {
  const { comment_id, body, version } = args;
  requireString(comment_id, "comment_id");
  requireString(body, "body");
  if (version === undefined) throw new Error("version is required");
  const verNum = Number(version);
  if (conn.isCloud) {
    const payload = {
      id: comment_id,
      body: { representation: "storage", value: body },
      version: { number: verNum + 1 },
    };
    const res = await doRequest(conn, "PUT", `${conn.apiPrefix}/footer-comments/${enc(comment_id)}`, payload);
    const j = await checkStatus(res);
    return { updated: true, comment: mapComment(j) };
  } else {
    const payload = {
      type: "comment",
      version: { number: verNum + 1 },
      body: { storage: { value: body, representation: "storage" } },
    };
    const res = await doRequest(conn, "PUT", `${conn.apiPrefix}/content/${enc(comment_id)}`, payload);
    const j = await checkStatus(res);
    return { updated: true, comment: mapComment(j) };
  }
}

async function commentDelete(conn, args) {
  const { comment_id } = args;
  requireString(comment_id, "comment_id");
  const path = conn.isCloud
    ? `${conn.apiPrefix}/footer-comments/${enc(comment_id)}`
    : `${conn.apiPrefix}/content/${enc(comment_id)}`;
  const res = await doRequest(conn, "DELETE", path);
  if (res.status === 404) return { deleted: false, comment_id };
  await checkStatus(res, true);
  return { deleted: true, comment_id };
}

// ATTACHMENTS

async function attachmentList(conn, args) {
  const { page_id, limit, cursor } = args;
  requireString(page_id, "page_id");
  if (conn.isCloud) {
    const q = qs({ limit: clampInt(limit, 1, 250, 25), cursor });
    const res = await doRequest(conn, "GET", `${conn.apiPrefix}/pages/${enc(page_id)}/attachments${q}`);
    if (res.status === 404) return { attachments: [], page_id };
    const j = await checkStatus(res);
    return { page_id, attachments: ((j && j.results) || []).map(mapAttachment) };
  } else {
    const q = qs({ limit: clampInt(limit, 1, 50, 25), expand: "version" });
    const res = await doRequest(conn, "GET", `${conn.apiPrefix}/content/${enc(page_id)}/child/attachment${q}`);
    if (res.status === 404) return { attachments: [], page_id };
    const j = await checkStatus(res);
    return { page_id, attachments: ((j && j.results) || []).map(mapAttachment) };
  }
}

async function attachmentGet(conn, args) {
  const { attachment_id } = args;
  requireString(attachment_id, "attachment_id");
  const path = conn.isCloud
    ? `${conn.apiPrefix}/attachments/${enc(attachment_id)}`
    : `${conn.apiPrefix}/content/${enc(attachment_id)}${qs({ expand: "version" })}`;
  const res = await doRequest(conn, "GET", path);
  if (res.status === 404) return { exists: false, attachment_id };
  const j = await checkStatus(res);
  return { exists: true, attachment: mapAttachment(j) };
}

async function attachmentDelete(conn, args) {
  const { attachment_id } = args;
  requireString(attachment_id, "attachment_id");
  const path = conn.isCloud
    ? `${conn.apiPrefix}/attachments/${enc(attachment_id)}`
    : `${conn.apiPrefix}/content/${enc(attachment_id)}`;
  const res = await doRequest(conn, "DELETE", path);
  if (res.status === 404) return { deleted: false, attachment_id };
  await checkStatus(res, true);
  return { deleted: true, attachment_id };
}

async function attachmentDownloadUrl(conn, args) {
  const { attachment_id } = args;
  requireString(attachment_id, "attachment_id");
  const path = conn.isCloud
    ? `${conn.apiPrefix}/attachments/${enc(attachment_id)}`
    : `${conn.apiPrefix}/content/${enc(attachment_id)}`;
  const res = await doRequest(conn, "GET", path);
  if (res.status === 404) return { exists: false, attachment_id };
  const j = await checkStatus(res);
  const downloadUrl = (j && j._links && j._links.download) || null;
  return { attachment_id, downloadUrl: downloadUrl ? `${conn.baseUrl}${downloadUrl}` : null };
}

async function attachmentUpload(conn, args) {
  // Note: actual multipart/form-data upload requires special handling
  // We return a note about the limitation and the endpoint
  const { page_id, filename, content_base64, media_type, comment } = args;
  requireString(page_id, "page_id");
  requireString(filename, "filename");
  requireString(content_base64, "content_base64");
  guardString(comment, "comment");
  // Build multipart body manually
  const boundary = `----FormBoundary${Date.now().toString(36)}`;
  const fileContent = Buffer.from(content_base64, "base64");
  const mtype = media_type || "application/octet-stream";
  let bodyParts = [];
  bodyParts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mtype}\r\n\r\n`));
  bodyParts.push(fileContent);
  bodyParts.push(Buffer.from(`\r\n`));
  if (comment) {
    bodyParts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="comment"\r\n\r\n${comment}\r\n`));
  }
  bodyParts.push(Buffer.from(`--${boundary}--\r\n`));
  const multipartBody = Buffer.concat(bodyParts);

  const path = conn.isCloud
    ? `${conn.apiPrefix}/pages/${enc(page_id)}/attachments`
    : `${conn.apiPrefix}/content/${enc(page_id)}/child/attachment`;

  const headers = {
    "Content-Type": `multipart/form-data; boundary=${boundary}`,
    "Content-Length": multipartBody.length,
    "X-Atlassian-Token": "no-check",
  };

  // Use a raw upload approach
  const uploaded = await new Promise((resolve, reject) => {
    const fullUrl = `${conn.baseUrl}${path}`;
    let urlObj;
    try { urlObj = new URL(fullUrl); } catch { return reject(new Error(`Invalid URL: ${fullUrl}`)); }
    const isHttps = urlObj.protocol === "https:";
    const transport = isHttps ? https : http;
    const port = urlObj.port ? Number(urlObj.port) : isHttps ? 443 : 80;
    const finalHeaders = { ...headers };
    if (conn.authHeader) finalHeaders["Authorization"] = conn.authHeader;
    const options = {
      hostname: urlObj.hostname, port,
      path: urlObj.pathname + urlObj.search,
      method: "POST", headers: finalHeaders,
      rejectUnauthorized: conn.rejectUnauthorized,
    };
    const timer = setTimeout(() => { req.destroy(); reject(new Error(`Request timed out after ${conn.timeoutMs}ms`)); }, conn.timeoutMs);
    const req = transport.request(options, (res) => {
      const chunks = []; let total = 0;
      res.on("data", c => { total += c.length; if (total > MAX_RESPONSE_BYTES) { res.destroy(); clearTimeout(timer); reject(new Error("Response exceeded 16 MB")); return; } chunks.push(c); });
      res.on("end", () => { clearTimeout(timer); resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }); });
      res.on("error", e => { clearTimeout(timer); reject(e); });
    });
    req.on("error", e => { clearTimeout(timer); reject(e); });
    req.write(multipartBody);
    req.end();
  });

  if (uploaded.status === 404) return { uploaded: false, page_id };
  const j = await checkStatus(uploaded);
  const results = (j && (j.results || [j])) || [];
  return { uploaded: true, attachments: results.map(mapAttachment) };
}

// LABELS

async function labelList(conn, args) {
  const { page_id, blog_id, limit, cursor } = args;
  const contentId = page_id || blog_id;
  if (!contentId) throw new Error("page_id or blog_id is required");
  requireString(contentId, "page_id or blog_id");
  if (conn.isCloud) {
    const resourceType = blog_id ? "blogposts" : "pages";
    const q = qs({ limit: clampInt(limit, 1, 250, 25), cursor });
    const res = await doRequest(conn, "GET", `${conn.apiPrefix}/${resourceType}/${enc(contentId)}/labels${q}`);
    if (res.status === 404) return { labels: [], content_id: contentId };
    const j = await checkStatus(res);
    return { content_id: contentId, labels: ((j && j.results) || []).map(mapLabel) };
  } else {
    const q = qs({ limit: clampInt(limit, 1, 50, 25) });
    const res = await doRequest(conn, "GET", `${conn.apiPrefix}/content/${enc(contentId)}/label${q}`);
    if (res.status === 404) return { labels: [], content_id: contentId };
    const j = await checkStatus(res);
    return { content_id: contentId, labels: ((j && j.results) || []).map(mapLabel) };
  }
}

async function labelAdd(conn, args) {
  const { page_id, blog_id, labels } = args;
  const contentId = page_id || blog_id;
  if (!contentId) throw new Error("page_id or blog_id is required");
  if (!Array.isArray(labels) || labels.length === 0) throw new Error("labels must be a non-empty array");
  for (const l of labels) guardString(l, "label");
  if (conn.isCloud) {
    const resourceType = blog_id ? "blogposts" : "pages";
    const payload = labels.map(name => ({ name, prefix: "global" }));
    const res = await doRequest(conn, "POST", `${conn.apiPrefix}/${resourceType}/${enc(contentId)}/labels`, payload);
    const j = await checkStatus(res);
    return { added: true, labels: ((j && j.results) || []).map(mapLabel) };
  } else {
    const payload = labels.map(name => ({ name, prefix: "global" }));
    const res = await doRequest(conn, "POST", `${conn.apiPrefix}/content/${enc(contentId)}/label`, payload);
    const j = await checkStatus(res);
    return { added: true, labels: ((j && j.results) || []).map(mapLabel) };
  }
}

async function labelRemove(conn, args) {
  const { page_id, blog_id, label } = args;
  const contentId = page_id || blog_id;
  if (!contentId) throw new Error("page_id or blog_id is required");
  requireString(label, "label");
  if (conn.isCloud) {
    const resourceType = blog_id ? "blogposts" : "pages";
    const res = await doRequest(conn, "DELETE", `${conn.apiPrefix}/${resourceType}/${enc(contentId)}/labels/${enc(label)}`);
    if (res.status === 404) return { removed: false, label };
    await checkStatus(res, true);
    return { removed: true, label };
  } else {
    const q = qs({ name: label });
    const res = await doRequest(conn, "DELETE", `${conn.apiPrefix}/content/${enc(contentId)}/label${q}`);
    if (res.status === 404) return { removed: false, label };
    await checkStatus(res, true);
    return { removed: true, label };
  }
}

async function labelSearch(conn, args) {
  const { label, limit, start } = args;
  requireString(label, "label");
  const path = conn.isCloud ? conn.legacyPrefix : conn.apiPrefix;
  const q = qs({ cql: `label='${label}' AND type IN (page,blogpost)`, limit: clampInt(limit, 1, 50, 25), start: start || 0 });
  const res = await doRequest(conn, "GET", `${path}/content/search${q}`);
  if (res.status === 404) return { results: [] };
  const j = await checkStatus(res);
  return { label, results: ((j && j.results) || []).map(p => ({ id: p.id, title: p.title, type: p.type })), total: j && j.totalSize };
}

// SEARCH

async function search(conn, args) {
  const { cql, limit, start, include_archived } = args;
  requireString(cql, "cql");
  const path = conn.isCloud
    ? `${conn.legacyPrefix}/content/search`
    : `${conn.apiPrefix}/content/search`;
  const q = qs({
    cql,
    limit: clampInt(limit, 1, 50, 25),
    start: start || 0,
    includeArchivedSpaces: include_archived || false,
    expand: "version,space",
  });
  const res = await doRequest(conn, "GET", `${path}${q}`);
  if (res.status === 404) return { results: [], total: 0 };
  const j = await checkStatus(res);
  return {
    results: (j && j.results) || [],
    total:   j && j.totalSize,
    start:   j && j.start,
    limit:   j && j.limit,
  };
}

async function searchUser(conn, args) {
  const { query, limit } = args;
  requireString(query, "query");
  const q = qs({ query, limit: clampInt(limit, 1, 200, 25) });
  const path = conn.isCloud
    ? `${conn.legacyPrefix}/search/user${q}`
    : `${conn.apiPrefix}/search/user${q}`;
  const res = await doRequest(conn, "GET", path);
  if (res.status === 404) return { users: [] };
  const j = await checkStatus(res);
  const results = (j && j.results) || (Array.isArray(j) ? j : []);
  return { users: results.map(u => mapUser(u.user || u)), total: j && j.totalSize };
}

// USERS

async function userGet(conn, args) {
  const { account_id, username } = args;
  guardString(account_id, "account_id");
  guardString(username, "username");
  if (!account_id && !username) throw new Error("account_id or username is required");
  let path;
  if (conn.isCloud) {
    const q = qs({ accountId: account_id });
    path = `${conn.legacyPrefix}/user${q}`;
  } else {
    const q = qs({ username });
    path = `${conn.apiPrefix}/user${q}`;
  }
  const res = await doRequest(conn, "GET", path);
  if (res.status === 404) return { exists: false, account_id, username };
  const j = await checkStatus(res);
  return { exists: true, user: mapUser(j) };
}

async function userMe(conn) {
  const path = conn.isCloud
    ? `${conn.legacyPrefix}/user/current`
    : `${conn.apiPrefix}/user/current`;
  const res = await doRequest(conn, "GET", path);
  const j = await checkStatus(res);
  return { user: mapUser(j) };
}

async function userGroups(conn, args) {
  const { account_id, username, limit, start } = args;
  guardString(account_id, "account_id");
  guardString(username, "username");
  if (!account_id && !username) throw new Error("account_id or username is required");
  let path;
  if (conn.isCloud) {
    const q = qs({ accountId: account_id, limit: clampInt(limit, 1, 200, 25), start: start || 0 });
    path = `${conn.legacyPrefix}/user/memberof${q}`;
  } else {
    const q = qs({ username, limit: clampInt(limit, 1, 200, 25), start: start || 0 });
    path = `${conn.apiPrefix}/user/memberof${q}`;
  }
  const res = await doRequest(conn, "GET", path);
  if (res.status === 404) return { groups: [] };
  const j = await checkStatus(res);
  const results = (j && j.results) || [];
  return { groups: results.map(g => ({ type: g.type, name: g.name })) };
}

async function userWatchList(conn, args) {
  const { account_id } = args;
  requireString(account_id, "account_id");
  const q = qs({ accountId: account_id });
  const path = conn.isCloud
    ? `${conn.legacyPrefix}/user/watches${q}`
    : `${conn.apiPrefix}/user/watches${q}`;
  const res = await doRequest(conn, "GET", path);
  if (res.status === 404) return { watches: [] };
  const j = await checkStatus(res);
  return { account_id, watches: (j && j.results) || [] };
}

// WATCHERS

async function watcherList(conn, args) {
  const { page_id } = args;
  requireString(page_id, "page_id");
  const path = conn.isCloud
    ? `${conn.legacyPrefix}/content/${enc(page_id)}/notification/child-created`
    : `${conn.apiPrefix}/content/${enc(page_id)}/notification/child-created`;
  // Use the watches endpoint
  const watchPath = conn.isCloud
    ? `${conn.legacyPrefix}/content/${enc(page_id)}/notification/created`
    : `${conn.apiPrefix}/content/${enc(page_id)}/notification/created`;
  const res = await doRequest(conn, "GET", watchPath);
  if (res.status === 404) return { watchers: [], page_id };
  const j = await checkStatus(res);
  const watchers = (j && (j.results || j.watches)) || [];
  return { page_id, watchers };
}

async function watcherAdd(conn, args) {
  const { page_id, account_id } = args;
  requireString(page_id, "page_id");
  requireString(account_id, "account_id");
  const q = qs({ accountId: account_id });
  const path = conn.isCloud
    ? `${conn.legacyPrefix}/user/watch/content/${enc(page_id)}${q}`
    : `${conn.apiPrefix}/user/watch/content/${enc(page_id)}${q}`;
  const res = await doRequest(conn, "POST", path);
  await checkStatus(res, true);
  return { watching: true, page_id, account_id };
}

// TASKS

async function taskList(conn, args) {
  const { page_id, limit, cursor, status } = args;
  guardString(page_id, "page_id");
  const q = qs({ pageId: page_id, limit: clampInt(limit, 1, 250, 25), cursor, status });
  const path = conn.isCloud
    ? `${conn.apiPrefix}/tasks${q}`
    : `${conn.legacyPrefix}/task${q}`;
  const res = await doRequest(conn, "GET", path);
  if (res.status === 404) return { tasks: [] };
  const j = await checkStatus(res);
  return { tasks: (j && j.results) || [], cursor: j && j._links && j._links.next };
}

async function taskGet(conn, args) {
  const { task_id } = args;
  requireString(task_id, "task_id");
  const path = conn.isCloud
    ? `${conn.apiPrefix}/tasks/${enc(task_id)}`
    : `${conn.legacyPrefix}/task/${enc(task_id)}`;
  const res = await doRequest(conn, "GET", path);
  if (res.status === 404) return { exists: false, task_id };
  const j = await checkStatus(res);
  return { exists: true, task: j };
}

async function taskUpdate(conn, args) {
  const { task_id, status, due_date } = args;
  requireString(task_id, "task_id");
  requireString(status, "status");
  const payload = { status };
  if (due_date) { guardString(due_date, "due_date"); payload.dueAt = due_date; }
  const path = conn.isCloud
    ? `${conn.apiPrefix}/tasks/${enc(task_id)}`
    : `${conn.legacyPrefix}/task/${enc(task_id)}`;
  const res = await doRequest(conn, "PUT", path, payload);
  const j = await checkStatus(res);
  return { updated: true, task: j };
}

// VERSIONS

async function versionList(conn, args) {
  const { page_id, limit, start } = args;
  requireString(page_id, "page_id");
  if (conn.isCloud) {
    const q = qs({ limit: clampInt(limit, 1, 200, 25), cursor: start });
    const res = await doRequest(conn, "GET", `${conn.apiPrefix}/pages/${enc(page_id)}/versions${q}`);
    if (res.status === 404) return { exists: false, page_id };
    const j = await checkStatus(res);
    return { page_id, versions: (j && j.results) || [], cursor: j && j._links && j._links.next };
  } else {
    const q = qs({ limit: clampInt(limit, 1, 200, 25), start: start || 0 });
    const res = await doRequest(conn, "GET", `${conn.apiPrefix}/content/${enc(page_id)}/version${q}`);
    if (res.status === 404) return { exists: false, page_id };
    const j = await checkStatus(res);
    return { page_id, versions: (j && j.results) || [] };
  }
}

async function versionGet(conn, args) {
  const { page_id, version_number } = args;
  requireString(page_id, "page_id");
  if (version_number === undefined) throw new Error("version_number is required");
  if (conn.isCloud) {
    const res = await doRequest(conn, "GET", `${conn.apiPrefix}/pages/${enc(page_id)}/versions/${enc(version_number)}`);
    if (res.status === 404) return { exists: false, page_id, version_number };
    const j = await checkStatus(res);
    return { exists: true, version: j };
  } else {
    const res = await doRequest(conn, "GET", `${conn.apiPrefix}/content/${enc(page_id)}/version/${enc(version_number)}`);
    if (res.status === 404) return { exists: false, page_id, version_number };
    const j = await checkStatus(res);
    return { exists: true, version: j };
  }
}

async function versionRestore(conn, args) {
  const { page_id, version_number, message } = args;
  requireString(page_id, "page_id");
  if (version_number === undefined) throw new Error("version_number is required");
  guardString(message, "message");
  const path = conn.isCloud
    ? `${conn.apiPrefix}/pages/${enc(page_id)}/versions`
    : `${conn.apiPrefix}/content/${enc(page_id)}/version`;
  const payload = { versionNumber: Number(version_number), ...(message ? { message } : {}) };
  const res = await doRequest(conn, "POST", path, payload);
  await checkStatus(res, true);
  return { restored: true, page_id, version_number };
}

// TEMPLATES

async function templateList(conn, args) {
  const { space_key, limit, start } = args;
  guardString(space_key, "space_key");
  const path = conn.isCloud ? conn.legacyPrefix : conn.apiPrefix;
  const q = qs({ spaceKey: space_key, limit: clampInt(limit, 1, 200, 25), start: start || 0, expand: "space" });
  const res = await doRequest(conn, "GET", `${path}/template/page${q}`);
  if (res.status === 404) return { templates: [] };
  const j = await checkStatus(res);
  return { templates: (j && j.results) || [], total: j && j.size };
}

async function templateGet(conn, args) {
  const { template_id } = args;
  requireString(template_id, "template_id");
  const path = conn.isCloud ? conn.legacyPrefix : conn.apiPrefix;
  const res = await doRequest(conn, "GET", `${path}/template/${enc(template_id)}`);
  if (res.status === 404) return { exists: false, template_id };
  const j = await checkStatus(res);
  return { exists: true, template: j };
}

async function templateCreate(conn, args) {
  const { space_key, name, description, body } = args;
  requireString(space_key, "space_key");
  requireString(name, "name");
  requireString(body, "body");
  guardString(description, "description");
  const payload = {
    name,
    templateType: "page",
    space: { key: space_key },
    body: { storage: { value: body, representation: "storage" } },
    ...(description ? { description: { plain: { value: description, representation: "plain" } } } : {}),
  };
  const path = conn.isCloud ? conn.legacyPrefix : conn.apiPrefix;
  const res = await doRequest(conn, "POST", `${path}/template`, payload);
  const j = await checkStatus(res);
  return { created: true, template: j };
}

// INFO / GENERIC

async function getInfo(conn) {
  const path = conn.isCloud ? `${conn.legacyPrefix}/settings` : `${conn.apiPrefix}/settings`;
  const res = await doRequest(conn, "GET", path);
  const j = await checkStatus(res);
  return { settings: j, baseUrl: conn.baseUrl, cloud: conn.isCloud };
}

async function genericRequest(conn, args) {
  const { method, api_path, body } = args;
  requireString(api_path, "api_path");
  if (!api_path.startsWith("/")) throw new Error("api_path must start with /");
  const m = (method || "GET").toUpperCase();
  const res = await doRequest(conn, m, api_path, body !== undefined ? body : undefined);
  const j = await checkStatus(res);
  return { status: res.status, data: j };
}

// --- Main dispatcher ---------------------------------------------------------

async function confluenceClient(args) {
  if (!args || !args.operation) throw new Error("operation is required");
  if (!args.base_url) throw new Error("base_url is required (e.g. https://yourteam.atlassian.net)");
  const { operation } = args;
  const conn = buildConn(args);

  switch (operation) {
    // Spaces
    case "space_list":        return spaceList(conn, args);
    case "space_get":         return spaceGet(conn, args);
    case "space_create":      return spaceCreate(conn, args);
    case "space_delete":      return spaceDelete(conn, args);
    case "space_permissions": return spacePermissions(conn, args);
    case "space_content":     return spaceContent(conn, args);

    // Pages
    case "page_list":         return pageList(conn, args);
    case "page_get":          return pageGet(conn, args);
    case "page_create":       return pageCreate(conn, args);
    case "page_update":       return pageUpdate(conn, args);
    case "page_delete":       return pageDelete(conn, args);
    case "page_children":     return pageChildren(conn, args);
    case "page_ancestors":    return pageAncestors(conn, args);
    case "page_search":       return pageSearch(conn, args);
    case "page_move":         return pageMove(conn, args);
    case "page_history":      return pageHistory(conn, args);

    // Blog posts
    case "blog_list":         return blogList(conn, args);
    case "blog_get":          return blogGet(conn, args);
    case "blog_create":       return blogCreate(conn, args);
    case "blog_update":       return blogUpdate(conn, args);
    case "blog_delete":       return blogDelete(conn, args);

    // Comments
    case "comment_list":      return commentList(conn, args);
    case "comment_get":       return commentGet(conn, args);
    case "comment_create":    return commentCreate(conn, args);
    case "comment_update":    return commentUpdate(conn, args);
    case "comment_delete":    return commentDelete(conn, args);

    // Attachments
    case "attachment_list":         return attachmentList(conn, args);
    case "attachment_get":          return attachmentGet(conn, args);
    case "attachment_upload":       return attachmentUpload(conn, args);
    case "attachment_delete":       return attachmentDelete(conn, args);
    case "attachment_download_url": return attachmentDownloadUrl(conn, args);

    // Labels
    case "label_list":    return labelList(conn, args);
    case "label_add":     return labelAdd(conn, args);
    case "label_remove":  return labelRemove(conn, args);
    case "label_search":  return labelSearch(conn, args);

    // Search
    case "search":        return search(conn, args);
    case "search_user":   return searchUser(conn, args);

    // Users
    case "user_get":       return userGet(conn, args);
    case "user_me":        return userMe(conn);
    case "user_groups":    return userGroups(conn, args);
    case "user_watch_list":return userWatchList(conn, args);

    // Watchers
    case "watcher_list":  return watcherList(conn, args);
    case "watcher_add":   return watcherAdd(conn, args);

    // Tasks
    case "task_list":     return taskList(conn, args);
    case "task_get":      return taskGet(conn, args);
    case "task_update":   return taskUpdate(conn, args);

    // Versions
    case "version_list":    return versionList(conn, args);
    case "version_get":     return versionGet(conn, args);
    case "version_restore": return versionRestore(conn, args);

    // Templates
    case "template_list":   return templateList(conn, args);
    case "template_get":    return templateGet(conn, args);
    case "template_create": return templateCreate(conn, args);

    // Info / Generic
    case "info":     return getInfo(conn);
    case "request":  return genericRequest(conn, args);

    default:
      throw new Error(`Unknown operation: '${operation}'. Valid operations: space_list, space_get, space_create, space_delete, space_permissions, space_content, page_list, page_get, page_create, page_update, page_delete, page_children, page_ancestors, page_search, page_move, page_history, blog_list, blog_get, blog_create, blog_update, blog_delete, comment_list, comment_get, comment_create, comment_update, comment_delete, attachment_list, attachment_get, attachment_upload, attachment_delete, attachment_download_url, label_list, label_add, label_remove, label_search, search, search_user, user_get, user_me, user_groups, user_watch_list, watcher_list, watcher_add, task_list, task_get, task_update, version_list, version_get, version_restore, template_list, template_get, template_create, info, request`);
  }
}

module.exports = { confluenceClient };
