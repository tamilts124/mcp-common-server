"use strict";
// ── Elasticsearch/OpenSearch Client ─────────────────────────────────────────
// Zero-dependency pure Node.js https client.
// Supports Elasticsearch 7.x/8.x and OpenSearch 1.x/2.x.
// Operations: info, search, get, index, delete, create_index, delete_index,
//             indices, mapping, bulk, count, cluster_health
// Auth: API key (apiKey), Basic (username+password), Bearer token.
// Security: 32 MB response cap; NUL-byte guards; timeout clamp 1-300s;
//           no credentials in error messages.

const https = require("https");
const http  = require("http");
const { URL } = require("url");

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024; // 32 MB
const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 300_000;

// ── Helpers ──────────────────────────────────────────────────────────────────

function clampTimeout(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(Math.trunc(n), MIN_TIMEOUT_MS), MAX_TIMEOUT_MS);
}

function guardNul(v, name) {
  if (typeof v === "string" && v.includes("\0"))
    throw new Error(`elasticsearch_client: '${name}' must not contain NUL bytes.`);
}

function buildAuthHeader(auth) {
  // auth: { type: 'apikey'|'basic'|'bearer', apiKey?, username?, password?, token? }
  if (!auth) return null;
  const t = (auth.type || "").toLowerCase();
  if (t === "apikey" && auth.api_key) {
    // ES8 format: "ApiKey <base64(id:api_key)>" or just the encoded string
    // Allow either a raw key string or id+api_key pair
    if (auth.id && auth.api_key) {
      const encoded = Buffer.from(`${auth.id}:${auth.api_key}`).toString("base64");
      return `ApiKey ${encoded}`;
    }
    return `ApiKey ${auth.api_key}`;
  }
  if (t === "basic" && auth.username) {
    const encoded = Buffer.from(`${auth.username}:${auth.password || ""}`).toString("base64");
    return `Basic ${encoded}`;
  }
  if (t === "bearer" && auth.token) {
    return `Bearer ${auth.token}`;
  }
  return null;
}

function httpRequest(opts) {
  // Returns Promise<{ status, headers, body (Buffer) }>
  return new Promise((resolve, reject) => {
    const lib = opts.protocol === "http:" ? http : https;
    const reqOpts = {
      hostname: opts.hostname,
      port:     opts.port,
      path:     opts.path,
      method:   opts.method || "GET",
      headers:  opts.headers || {},
      rejectUnauthorized: opts.rejectUnauthorized !== false,
    };
    const req = lib.request(reqOpts, (res) => {
      const chunks = [];
      let total = 0;
      res.on("data", (chunk) => {
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) {
          req.destroy();
          reject(new Error(`elasticsearch_client: response too large (>${MAX_RESPONSE_BYTES} bytes).`));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
      });
      res.on("error", reject);
    });
    req.setTimeout(opts.timeout || DEFAULT_TIMEOUT_MS, () => {
      req.destroy(new Error(`elasticsearch_client: request timed out after ${opts.timeout || DEFAULT_TIMEOUT_MS}ms.`));
    });
    req.on("error", (err) => {
      // Redact credentials from error message
      const msg = err.message.replace(/:[^@/]+@/, ":***@");
      reject(new Error(`elasticsearch_client: ${msg}`));
    });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function parseBody(buf) {
  try { return JSON.parse(buf.toString("utf8")); }
  catch { return buf.toString("utf8"); }
}

// ── Core request builder ─────────────────────────────────────────────────────

async function esRequest(baseUrl, { method = "GET", path = "/", body, auth, timeout, rejectUnauthorized }) {
  const url = new URL(baseUrl);
  const headers = {
    "Content-Type": "application/json",
    "Accept":       "application/json",
    "User-Agent":   "mcp-common-server/elasticsearch_client",
  };
  const authHeader = buildAuthHeader(auth);
  if (authHeader) headers["Authorization"] = authHeader;

  let bodyStr;
  if (body != null) {
    bodyStr = typeof body === "string" ? body : JSON.stringify(body);
    headers["Content-Length"] = Buffer.byteLength(bodyStr, "utf8").toString();
  }

  const res = await httpRequest({
    protocol:           url.protocol,
    hostname:           url.hostname,
    port:               url.port || (url.protocol === "https:" ? 443 : 9200),
    path:               url.pathname.replace(/\/$/, "") + path,
    method,
    headers,
    body:               bodyStr,
    timeout:            clampTimeout(timeout),
    rejectUnauthorized,
  });

  const parsed = parseBody(res.body);
  return { status: res.status, data: parsed };
}

// ── Operations ───────────────────────────────────────────────────────────────

async function opInfo(baseUrl, opts) {
  const r = await esRequest(baseUrl, { method: "GET", path: "/", ...opts });
  if (r.status >= 400) {
    throw new Error(`elasticsearch_client info: HTTP ${r.status} - ${JSON.stringify(r.data).slice(0, 400)}`);
  }
  const d = r.data;
  return {
    operation:   "info",
    name:        d.name,
    clusterName: d.cluster_name,
    clusterUuid: d.cluster_uuid,
    version:     d.version,
    tagline:     d.tagline,
  };
}

async function opClusterHealth(baseUrl, { index, level, ...opts }) {
  const qs = [];
  if (level) qs.push(`level=${encodeURIComponent(level)}`);
  const qstr = qs.length ? `?${qs.join("&")}` : "";
  const path = index ? `/_cluster/health/${encodeURIComponent(index)}${qstr}` : `/_cluster/health${qstr}`;
  const r = await esRequest(baseUrl, { method: "GET", path, ...opts });
  if (r.status >= 400) {
    throw new Error(`elasticsearch_client cluster_health: HTTP ${r.status} - ${JSON.stringify(r.data).slice(0, 400)}`);
  }
  return { operation: "cluster_health", ...r.data };
}

async function opIndices(baseUrl, { pattern, include_hidden, ...opts }) {
  const pat = pattern || "*";
  const qs = [];
  if (include_hidden) qs.push("expand_wildcards=all");
  else qs.push("expand_wildcards=open");
  qs.push("h=index,health,status,pri,rep,docs.count,docs.deleted,store.size,creation.date.string");
  qs.push("format=json");
  qs.push("s=index");
  const qstr = `?${qs.join("&")}`;
  const path = `/_cat/indices/${encodeURIComponent(pat)}${qstr}`;
  const r = await esRequest(baseUrl, { method: "GET", path, ...opts });
  if (r.status >= 400) {
    throw new Error(`elasticsearch_client indices: HTTP ${r.status} - ${JSON.stringify(r.data).slice(0, 400)}`);
  }
  const list = Array.isArray(r.data) ? r.data : [];
  return {
    operation:  "indices",
    pattern:    pat,
    count:      list.length,
    indices:    list.map(i => ({
      index:       i.index,
      health:      i.health,
      status:      i.status,
      primaryShards: Number(i.pri) || 0,
      replicaShards: Number(i.rep) || 0,
      docsCount:   Number(i["docs.count"]) || 0,
      docsDeleted: Number(i["docs.deleted"]) || 0,
      storeSize:   i["store.size"],
      created:     i["creation.date.string"],
    })),
  };
}

async function opMapping(baseUrl, { index, field, ...opts }) {
  if (!index) throw new Error("elasticsearch_client mapping: 'index' is required.");
  const qs = field ? `?filter_path=*.mappings` : "";
  const path = `/${encodeURIComponent(index)}/_mapping${qs}`;
  const r = await esRequest(baseUrl, { method: "GET", path, ...opts });
  if (r.status >= 400) {
    throw new Error(`elasticsearch_client mapping: HTTP ${r.status} - ${JSON.stringify(r.data).slice(0, 400)}`);
  }
  // r.data is { <index>: { mappings: { properties: {...} } } }
  const indexData = r.data[index] || Object.values(r.data)[0] || {};
  const mappings = indexData.mappings || {};
  if (field) {
    // Extract specific field mapping
    const properties = mappings.properties || {};
    const parts = field.split(".");
    let node = properties;
    for (const part of parts) {
      node = node[part]?.properties || node[part] || null;
      if (!node) break;
    }
    return { operation: "mapping", index, field, mapping: node };
  }
  return { operation: "mapping", index, properties: mappings.properties || {}, dynamic: mappings.dynamic, mappings };
}

async function opCount(baseUrl, { index, query, ...opts }) {
  const path = index ? `/${encodeURIComponent(index)}/_count` : "/_count";
  const body = query ? { query } : {};
  const r = await esRequest(baseUrl, { method: "POST", path, body, ...opts });
  if (r.status >= 400) {
    throw new Error(`elasticsearch_client count: HTTP ${r.status} - ${JSON.stringify(r.data).slice(0, 400)}`);
  }
  return {
    operation: "count",
    index:     index || "_all",
    count:     r.data.count,
    shards:    r.data._shards,
  };
}

async function opSearch(baseUrl, {
  index, query, size, from, sort, source_includes, source_excludes,
  aggs, highlight, track_total_hits, explain, scroll, ...opts
}) {
  const path = index ? `/${encodeURIComponent(index)}/_search` : "/_search";
  const body = {};
  if (query)             body.query = query;
  if (size   != null)   body.size = size;
  if (from   != null)   body.from = from;
  if (sort)             body.sort = sort;
  if (aggs)             body.aggs = aggs;
  if (highlight)        body.highlight = highlight;
  if (track_total_hits != null) body.track_total_hits = track_total_hits;
  if (explain)          body.explain = true;
  if (source_includes?.length || source_excludes?.length) {
    body._source = {};
    if (source_includes?.length) body._source.includes = source_includes;
    if (source_excludes?.length) body._source.excludes = source_excludes;
  }
  const r = await esRequest(baseUrl, { method: "POST", path, body, ...opts });
  if (r.status >= 400) {
    throw new Error(`elasticsearch_client search: HTTP ${r.status} - ${JSON.stringify(r.data).slice(0, 400)}`);
  }
  const d = r.data;
  const total = typeof d.hits?.total === "object" ? d.hits.total.value : (d.hits?.total ?? 0);
  const hits = (d.hits?.hits ?? []).map(h => ({
    index:  h._index,
    id:     h._id,
    score:  h._score,
    source: h._source,
    sort:   h.sort,
    explanation: h._explanation,
    highlight: h.highlight,
  }));
  return {
    operation:    "search",
    index:        index || "_all",
    total,
    maxScore:     d.hits?.max_score,
    took:         d.took,
    timedOut:     d.timed_out,
    hits,
    aggregations: d.aggregations,
    shards:       d._shards,
  };
}

async function opGet(baseUrl, { index, id, source_includes, source_excludes, ...opts }) {
  if (!index) throw new Error("elasticsearch_client get: 'index' is required.");
  if (!id)    throw new Error("elasticsearch_client get: 'id' is required.");
  const qs = [];
  if (source_includes?.length) qs.push(`_source_includes=${encodeURIComponent(source_includes.join(","))}`);
  if (source_excludes?.length) qs.push(`_source_excludes=${encodeURIComponent(source_excludes.join(","))}`);
  const qstr = qs.length ? `?${qs.join("&")}` : "";
  const path = `/${encodeURIComponent(index)}/_doc/${encodeURIComponent(id)}${qstr}`;
  const r = await esRequest(baseUrl, { method: "GET", path, ...opts });
  if (r.status === 404) return { operation: "get", index, id, found: false, source: null };
  if (r.status >= 400) {
    throw new Error(`elasticsearch_client get: HTTP ${r.status} - ${JSON.stringify(r.data).slice(0, 400)}`);
  }
  return {
    operation: "get",
    index:     r.data._index,
    id:        r.data._id,
    version:   r.data._version,
    seqNo:     r.data._seq_no,
    found:     r.data.found,
    source:    r.data._source,
  };
}

async function opIndex(baseUrl, { index, id, document, pipeline, refresh, ...opts }) {
  if (!index)    throw new Error("elasticsearch_client index: 'index' is required.");
  if (!document) throw new Error("elasticsearch_client index: 'document' is required.");
  const qs = [];
  if (pipeline) qs.push(`pipeline=${encodeURIComponent(pipeline)}`);
  if (refresh)  qs.push(`refresh=${encodeURIComponent(refresh)}`);
  const qstr = qs.length ? `?${qs.join("&")}` : "";
  // id is optional (POST auto-generates, PUT requires)
  const method = id ? "PUT" : "POST";
  const pathSuffix = id ? `/${encodeURIComponent(id)}` : "";
  const path = `/${encodeURIComponent(index)}/_doc${pathSuffix}${qstr}`;
  const r = await esRequest(baseUrl, { method, path, body: document, ...opts });
  if (r.status >= 400) {
    throw new Error(`elasticsearch_client index: HTTP ${r.status} - ${JSON.stringify(r.data).slice(0, 400)}`);
  }
  return {
    operation: "index",
    index:     r.data._index,
    id:        r.data._id,
    version:   r.data._version,
    result:    r.data.result,
    seqNo:     r.data._seq_no,
    shards:    r.data._shards,
  };
}

async function opDelete(baseUrl, { index, id, refresh, ...opts }) {
  if (!index) throw new Error("elasticsearch_client delete: 'index' is required.");
  if (!id)    throw new Error("elasticsearch_client delete: 'id' is required.");
  const qs = refresh ? [`refresh=${encodeURIComponent(refresh)}`] : [];
  const qstr = qs.length ? `?${qs.join("&")}` : "";
  const path = `/${encodeURIComponent(index)}/_doc/${encodeURIComponent(id)}${qstr}`;
  const r = await esRequest(baseUrl, { method: "DELETE", path, ...opts });
  if (r.status === 404) return { operation: "delete", index, id, result: "not_found", found: false };
  if (r.status >= 400) {
    throw new Error(`elasticsearch_client delete: HTTP ${r.status} - ${JSON.stringify(r.data).slice(0, 400)}`);
  }
  return {
    operation: "delete",
    index:     r.data._index,
    id:        r.data._id,
    version:   r.data._version,
    result:    r.data.result,
    found:     r.data.result !== "not_found",
  };
}

async function opCreateIndex(baseUrl, { index, settings, mappings, aliases, ...opts }) {
  if (!index) throw new Error("elasticsearch_client create_index: 'index' is required.");
  const body = {};
  if (settings) body.settings = settings;
  if (mappings) body.mappings = mappings;
  if (aliases)  body.aliases  = aliases;
  const path = `/${encodeURIComponent(index)}`;
  const r = await esRequest(baseUrl, { method: "PUT", path, body: Object.keys(body).length ? body : undefined, ...opts });
  if (r.status >= 400) {
    throw new Error(`elasticsearch_client create_index: HTTP ${r.status} - ${JSON.stringify(r.data).slice(0, 400)}`);
  }
  return {
    operation:    "create_index",
    index,
    acknowledged: r.data.acknowledged,
    shardsAcknowledged: r.data.shards_acknowledged,
    indexName:    r.data.index,
  };
}

async function opDeleteIndex(baseUrl, { index, ...opts }) {
  if (!index) throw new Error("elasticsearch_client delete_index: 'index' is required.");
  const path = `/${encodeURIComponent(index)}`;
  const r = await esRequest(baseUrl, { method: "DELETE", path, ...opts });
  if (r.status === 404) return { operation: "delete_index", index, acknowledged: false, found: false };
  if (r.status >= 400) {
    throw new Error(`elasticsearch_client delete_index: HTTP ${r.status} - ${JSON.stringify(r.data).slice(0, 400)}`);
  }
  return {
    operation:    "delete_index",
    index,
    acknowledged: r.data.acknowledged,
    found:        true,
  };
}

async function opBulk(baseUrl, { index, operations, refresh, ...opts }) {
  if (!Array.isArray(operations) || operations.length === 0)
    throw new Error("elasticsearch_client bulk: 'operations' must be a non-empty array.");
  // Each operation is { action: 'index'|'create'|'update'|'delete', id?, index?, document?, doc?, doc_as_upsert? }
  const lines = [];
  for (const op of operations) {
    const action = op.action || "index";
    if (!["index","create","update","delete"].includes(action))
      throw new Error(`elasticsearch_client bulk: unknown action '${action}'.`);
    const meta = { _index: op.index || index, _id: op.id };
    // Remove undefined keys
    if (!meta._index) delete meta._index;
    if (!meta._id)    delete meta._id;
    lines.push(JSON.stringify({ [action]: meta }));
    if (action === "index" || action === "create") {
      if (!op.document) throw new Error(`elasticsearch_client bulk: '${action}' operation requires 'document'.`);
      lines.push(JSON.stringify(op.document));
    } else if (action === "update") {
      const updateBody = {};
      if (op.doc)            updateBody.doc = op.doc;
      if (op.doc_as_upsert) updateBody.doc_as_upsert = true;
      if (op.script)        updateBody.script = op.script;
      lines.push(JSON.stringify(updateBody));
    }
    // delete: no body line needed
  }
  const ndjson = lines.join("\n") + "\n";
  const qs = refresh ? `?refresh=${encodeURIComponent(refresh)}` : "";
  const path = index ? `/${encodeURIComponent(index)}/_bulk${qs}` : `/_bulk${qs}`;

  // Bulk uses application/x-ndjson content type
  const url = new URL(opts._baseUrl || baseUrl);
  const authHeader = buildAuthHeader(opts.auth);
  const headers = {
    "Content-Type": "application/x-ndjson",
    "Accept":       "application/json",
    "User-Agent":   "mcp-common-server/elasticsearch_client",
    "Content-Length": Buffer.byteLength(ndjson, "utf8").toString(),
  };
  if (authHeader) headers["Authorization"] = authHeader;

  const res = await httpRequest({
    protocol:           url.protocol,
    hostname:           url.hostname,
    port:               url.port || (url.protocol === "https:" ? 443 : 9200),
    path:               url.pathname.replace(/\/$/, "") + path,
    method:             "POST",
    headers,
    body:               ndjson,
    timeout:            clampTimeout(opts.timeout),
    rejectUnauthorized: opts.rejectUnauthorized !== false,
  });
  const d = parseBody(res.body);
  if (res.status >= 400) {
    throw new Error(`elasticsearch_client bulk: HTTP ${res.status} - ${JSON.stringify(d).slice(0, 400)}`);
  }
  const items  = d.items || [];
  const errors = items.filter(item => {
    const r = Object.values(item)[0];
    return r?.error != null;
  });
  return {
    operation:   "bulk",
    took:        d.took,
    errors:      d.errors,
    total:       items.length,
    errorCount:  errors.length,
    errorItems:  errors.slice(0, 20).map(item => {
      const [action, r] = Object.entries(item)[0];
      return { action, index: r._index, id: r._id, error: r.error };
    }),
    items: items.slice(0, 100).map(item => {
      const [action, r] = Object.entries(item)[0];
      return { action, index: r._index, id: r._id, result: r.result, status: r.status };
    }),
  };
}

// ── Main entry ───────────────────────────────────────────────────────────────

async function elasticsearchClient(args) {
  const {
    operation, url: baseUrl, auth, timeout,
    reject_unauthorized,
    // per-operation args
    index, id, query, document, size, from, sort,
    source_includes, source_excludes, aggs, highlight,
    track_total_hits, explain, settings, mappings, aliases,
    operations, refresh, field, pipeline, pattern, include_hidden,
    level,
  } = args;

  // Validate required fields
  if (!operation)
    throw new Error("elasticsearch_client: 'operation' is required.");
  const VALID_OPS = ["info","search","get","index","delete","create_index",
    "delete_index","indices","mapping","bulk","count","cluster_health"];
  if (!VALID_OPS.includes(operation))
    throw new Error(`elasticsearch_client: unknown operation '${operation}'. Valid: ${VALID_OPS.join(", ")}.`);
  if (!baseUrl)
    throw new Error("elasticsearch_client: 'url' is required (e.g. 'http://localhost:9200').");

  // NUL-byte guards
  guardNul(baseUrl, "url");
  if (index) guardNul(index, "index");
  if (id)    guardNul(id, "id");

  // Validate URL
  let parsedUrl;
  try { parsedUrl = new URL(baseUrl); }
  catch { throw new Error(`elasticsearch_client: invalid 'url': ${baseUrl}`); }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:")
    throw new Error(`elasticsearch_client: 'url' must use http or https protocol.`);

  const commonOpts = {
    auth: auth || null,
    timeout: clampTimeout(timeout),
    rejectUnauthorized: reject_unauthorized !== false,
    _baseUrl: baseUrl, // used by bulk which does its own httpRequest
  };

  switch (operation) {
    case "info":           return opInfo(baseUrl, commonOpts);
    case "cluster_health": return opClusterHealth(baseUrl, { level, index, ...commonOpts });
    case "indices":        return opIndices(baseUrl, { pattern, include_hidden, ...commonOpts });
    case "mapping":        return opMapping(baseUrl, { index, field, ...commonOpts });
    case "count":          return opCount(baseUrl, { index, query, ...commonOpts });
    case "search":         return opSearch(baseUrl, {
      index, query, size, from, sort, source_includes, source_excludes,
      aggs, highlight, track_total_hits, explain, ...commonOpts
    });
    case "get":            return opGet(baseUrl, { index, id, source_includes, source_excludes, ...commonOpts });
    case "index":          return opIndex(baseUrl, { index, id, document, pipeline, refresh, ...commonOpts });
    case "delete":         return opDelete(baseUrl, { index, id, refresh, ...commonOpts });
    case "create_index":   return opCreateIndex(baseUrl, { index, settings, mappings, aliases, ...commonOpts });
    case "delete_index":   return opDeleteIndex(baseUrl, { index, ...commonOpts });
    case "bulk":           return opBulk(baseUrl, { index, operations, refresh, ...commonOpts });
    default:
      throw new Error(`elasticsearch_client: unhandled operation '${operation}'.`);
  }
}

module.exports = { elasticsearchClient };
