"use strict";
/**
 * consul_client — Zero-dependency HashiCorp Consul HTTP API client
 * (pure Node.js http/https built-ins; no npm deps)
 *
 * Consul HTTP API v1 — https://developer.hashicorp.com/consul/api-docs
 *
 * Default port: 8500 (HTTP), 8501 (HTTPS)
 *
 * Operations:
 *   kv_get          — Read one key or all keys under a prefix from the KV store
 *   kv_put          — Write a key+value into the KV store (with optional flags/CAS)
 *   kv_delete       — Delete a key or all keys under a prefix
 *   kv_list         — List all keys under a prefix (no values)
 *   services        — List registered services (with optional filter)
 *   service_health  — Return health checks for a named service
 *   nodes           — List all nodes in the datacenter
 *   node_health     — Return health checks for a specific node
 *   members         — Return cluster gossip members (wan or lan)
 *   leader          — Return the current Raft leader
 *   peers           — Return the list of Raft peers
 *   status          — Return agent self info (node name, datacenter, config)
 *   register        — Register a service on the local agent
 *   deregister      — Deregister a service from the local agent
 *   checks          — List all health checks (with optional filter)
 *   session_create  — Create a session (for distributed locking)
 *   session_destroy — Destroy a session
 *   session_info    — Get session info by ID
 *   lock            — Acquire a lock on a KV key using a session
 *   unlock          — Release a lock on a KV key using a session
 *   catalog_datacenters — List all known datacenters
 *   info            — Return protocol / operation reference (no I/O)
 *
 * Auth: Consul ACL tokens via X-Consul-Token header.
 * TLS:  use_tls:true uses https; reject_unauthorized configures cert validation.
 *
 * Security:
 *   NUL-byte guards on host, key, value, service names, session IDs.
 *   Timeout clamped 1000-120000 ms.
 *   Port validated 1-65535.
 *   ACL tokens never returned in output.
 *   16 MB response cap.
 */

const http  = require("http");
const https = require("https");

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_PORT       = 8500;
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024; // 16 MB
const API_V1             = "/v1";

// ── Guard helpers ──────────────────────────────────────────────────────────

function requireString(val, name) {
  if (typeof val !== "string" || val.length === 0)
    throw new Error(`${name} must be a non-empty string`);
  if (val.includes("\0"))
    throw new Error(`${name} must not contain NUL bytes`);
}

function guardString(val, name) {
  if (val !== undefined && val !== null) {
    if (typeof val !== "string") throw new Error(`${name} must be a string`);
    if (val.includes("\0")) throw new Error(`${name} must not contain NUL bytes`);
  }
}

function clampInt(val, def, min, max, name) {
  if (val === undefined || val === null) return def;
  const n = Number(val);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  if (n < min || n > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return Math.round(n);
}

// ── Build connection options ───────────────────────────────────────────────

function buildConn(args) {
  requireString(args.host, "host");
  guardString(args.token,      "token");
  guardString(args.datacenter, "datacenter");
  guardString(args.namespace,  "namespace");

  const host      = args.host.trim();
  const port      = clampInt(args.port, DEFAULT_PORT, 1, 65535, "port");
  const timeoutMs = clampInt(args.timeout, DEFAULT_TIMEOUT_MS, 1000, 120000, "timeout");
  const useTls    = !!args.use_tls;
  const rejectUnauthorized = args.reject_unauthorized !== false;
  const token = args.token || null;
  const dc    = args.datacenter || null;
  const ns    = args.namespace  || null;

  return { host, port, timeoutMs, useTls, rejectUnauthorized, token, dc, ns };
}

// ── HTTP helper ────────────────────────────────────────────────────────────

/**
 * Perform an HTTP/HTTPS request to the Consul API.
 * method:  GET | PUT | DELETE
 * apiPath: e.g. "/v1/kv/mykey"
 * query:   additional query params (dc/ns/token added from conn)
 * body:    JS object (for JSON PUT) or null
 */
function consulRequest(conn, method, apiPath, query, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    // Build query string (token goes in query for simplicity; also in header)
    const qs = {};
    if (conn.dc) qs.dc = conn.dc;
    if (conn.ns) qs.ns = conn.ns;
    Object.assign(qs, query || {});
    const qStr = Object.entries(qs)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
    const fullPath = apiPath + (qStr ? "?" + qStr : "");

    const reqBodyStr = body != null ? JSON.stringify(body) : null;
    const headers    = {};
    if (conn.token) headers["X-Consul-Token"] = conn.token;
    if (reqBodyStr != null) {
      headers["Content-Type"]   = "application/json";
      headers["Content-Length"] = Buffer.byteLength(reqBodyStr);
    } else {
      headers["Content-Length"] = 0;
    }

    const reqOpts = {
      hostname: conn.host,
      port:     conn.port,
      path:     fullPath,
      method,
      headers,
    };
    if (conn.useTls) {
      reqOpts.rejectUnauthorized = conn.rejectUnauthorized;
      reqOpts.servername         = conn.host;
    }

    const mod      = conn.useTls ? https : http;
    const chunks   = [];
    let totalBytes = 0;
    let settled    = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new Error(`Consul request ${method} ${apiPath} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const req = mod.request(reqOpts, (res) => {
      res.on("data", (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          req.destroy();
          reject(new Error("Consul response exceeded 16 MB cap"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve({ statusCode: res.statusCode, headers: res.headers, raw });
      });
      res.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Consul response stream error: ${err.message}`));
      });
    });

    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Cannot connect to Consul ${conn.host}:${conn.port}: ${err.message}`));
    });

    if (reqBodyStr != null) req.write(reqBodyStr);
    req.end();
  });
}

/**
 * Special PUT for raw (non-JSON) body bytes — used by KV put/lock/unlock
 * where the Consul API expects a raw value body, not JSON.
 */
function consulPutRaw(conn, apiPath, query, bodyBuf, timeoutMs) {
  return new Promise((resolve, reject) => {
    const qs = {};
    if (conn.dc) qs.dc = conn.dc;
    if (conn.ns) qs.ns = conn.ns;
    Object.assign(qs, query || {});
    const qStr = Object.entries(qs)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
    const fullPath = apiPath + (qStr ? "?" + qStr : "");

    const headers = {
      "Content-Type":   "text/plain",
      "Content-Length": bodyBuf.length,
    };
    if (conn.token) headers["X-Consul-Token"] = conn.token;

    const reqOpts = {
      hostname: conn.host,
      port:     conn.port,
      path:     fullPath,
      method:   "PUT",
      headers,
    };
    if (conn.useTls) {
      reqOpts.rejectUnauthorized = conn.rejectUnauthorized;
      reqOpts.servername         = conn.host;
    }

    const mod      = conn.useTls ? https : http;
    const chunks   = [];
    let totalBytes = 0;
    let settled    = false;

    const tm = timeoutMs || conn.timeoutMs;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new Error(`Consul PUT to ${apiPath} timed out after ${tm}ms`));
    }, tm);

    const req = mod.request(reqOpts, (res) => {
      res.on("data", (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          req.destroy();
          reject(new Error("Consul PUT response exceeded 16 MB cap"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ statusCode: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks).toString("utf8") });
      });
      res.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Consul PUT stream error: ${err.message}`));
      });
    });

    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Cannot connect to Consul ${conn.host}:${conn.port}: ${err.message}`));
    });

    req.write(bodyBuf);
    req.end();
  });
}

/** Parse JSON from response; throw helpful error on failure */
function parseJson(raw, context) {
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Consul: invalid JSON response (${context}): ${raw.slice(0, 200)}`);
  }
}

/** Throw on non-2xx responses */
function checkStatus(res, context) {
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(
      `Consul ${context}: HTTP ${res.statusCode} — ${res.raw.slice(0, 300).trim()}`
    );
  }
}

/** Encode a KV key path preserving internal slashes */
function encodeKey(key) {
  return key.split("/").map(s => encodeURIComponent(s)).join("/");
}

/** Decode a raw KV entry from Consul API response */
function decodeKvEntry(entry) {
  const value = entry.Value ? Buffer.from(entry.Value, "base64").toString("utf8") : "";
  return {
    key:          entry.Key,
    value,
    flags:        entry.Flags        || 0,
    create_index: entry.CreateIndex  || 0,
    modify_index: entry.ModifyIndex  || 0,
    lock_index:   entry.LockIndex    || 0,
    session:      entry.Session      || null,
  };
}

// ── KV operations ──────────────────────────────────────────────────────────

async function opKvGet(args) {
  const conn = buildConn(args);
  if (!args.key) throw new Error("kv_get requires 'key'");
  guardString(args.key, "key");

  const query = {};
  if (args.recurse)    query.recurse   = "";
  if (args.raw)        query.raw       = "";
  if (args.keys)       query.keys      = "";
  if (args.separator)  query.separator = args.separator;
  if (args.index)      query.index     = String(args.index);
  if (args.wait)       query.wait      = String(args.wait);

  const res = await consulRequest(conn, "GET", `${API_V1}/kv/${encodeKey(args.key)}`, query, null, conn.timeoutMs);

  if (res.statusCode === 404) {
    return { ok: true, operation: "kv_get", server: `${conn.host}:${conn.port}`, found: false, key: args.key };
  }
  checkStatus(res, "kv_get");

  if (args.raw) {
    return { ok: true, operation: "kv_get", server: `${conn.host}:${conn.port}`, found: true, key: args.key, value: res.raw };
  }
  if (args.keys) {
    const keys = parseJson(res.raw, "kv_get keys");
    return { ok: true, operation: "kv_get", server: `${conn.host}:${conn.port}`, found: true, count: keys.length, keys };
  }

  const items = parseJson(res.raw, "kv_get");
  if (!Array.isArray(items)) throw new Error("Consul kv_get: unexpected response shape");

  const decoded = items.map(decodeKvEntry);
  const xIndex  = res.headers["x-consul-index"] || null;

  if (!args.recurse && decoded.length === 1) {
    return { ok: true, operation: "kv_get", server: `${conn.host}:${conn.port}`, found: true, index: xIndex, ...decoded[0] };
  }
  return {
    ok:        true,
    operation: "kv_get",
    server:    `${conn.host}:${conn.port}`,
    found:     true,
    index:     xIndex,
    count:     decoded.length,
    items:     decoded,
  };
}

async function opKvPut(args) {
  const conn = buildConn(args);
  if (!args.key) throw new Error("kv_put requires 'key'");
  guardString(args.key,   "key");
  guardString(args.value, "value");

  const query = {};
  if (args.flags   != null) query.flags   = String(args.flags);
  if (args.cas     != null) query.cas     = String(args.cas);
  if (args.acquire != null) query.acquire = String(args.acquire);
  if (args.release != null) query.release = String(args.release);

  const valueStr = args.value != null ? String(args.value) : "";
  const bodyBuf  = Buffer.from(valueStr, "utf8");
  const res      = await consulPutRaw(conn, `${API_V1}/kv/${encodeKey(args.key)}`, query, bodyBuf, conn.timeoutMs);
  checkStatus(res, "kv_put");

  const result = parseJson(res.raw, "kv_put");
  return {
    ok:        true,
    operation: "kv_put",
    server:    `${conn.host}:${conn.port}`,
    key:       args.key,
    written:   result === true,
  };
}

async function opKvDelete(args) {
  const conn = buildConn(args);
  if (!args.key) throw new Error("kv_delete requires 'key'");
  guardString(args.key, "key");

  const query = {};
  if (args.recurse)  query.recurse = "";
  if (args.cas != null) query.cas  = String(args.cas);

  const res = await consulRequest(conn, "DELETE", `${API_V1}/kv/${encodeKey(args.key)}`, query, null, conn.timeoutMs);
  checkStatus(res, "kv_delete");

  return {
    ok:        true,
    operation: "kv_delete",
    server:    `${conn.host}:${conn.port}`,
    key:       args.key,
    recurse:   !!args.recurse,
    deleted:   parseJson(res.raw, "kv_delete"),
  };
}

async function opKvList(args) {
  const conn   = buildConn(args);
  const prefix = args.prefix || "";
  guardString(prefix, "prefix");

  const query = { keys: "" };
  if (args.separator) query.separator = args.separator;

  const res = await consulRequest(conn, "GET", `${API_V1}/kv/${encodeKey(prefix)}`, query, null, conn.timeoutMs);

  if (res.statusCode === 404) {
    return { ok: true, operation: "kv_list", server: `${conn.host}:${conn.port}`, prefix, count: 0, keys: [] };
  }
  checkStatus(res, "kv_list");

  const keys = parseJson(res.raw, "kv_list");
  return {
    ok:        true,
    operation: "kv_list",
    server:    `${conn.host}:${conn.port}`,
    prefix,
    count:     keys.length,
    keys,
  };
}

// ── Catalog / Services ─────────────────────────────────────────────────────

async function opServices(args) {
  const conn  = buildConn(args);
  const query = {};
  if (args.node_meta) query.node_meta = args.node_meta;
  if (args.filter)    query.filter    = args.filter;

  const res = await consulRequest(conn, "GET", `${API_V1}/catalog/services`, query, null, conn.timeoutMs);
  checkStatus(res, "services");

  const svcMap   = parseJson(res.raw, "services");
  const services = Object.entries(svcMap).map(([name, tags]) => ({ name, tags: tags || [] }));

  return {
    ok:        true,
    operation: "services",
    server:    `${conn.host}:${conn.port}`,
    count:     services.length,
    services,
    index:     res.headers["x-consul-index"] || null,
  };
}

async function opServiceHealth(args) {
  const conn = buildConn(args);
  if (!args.service) throw new Error("service_health requires 'service'");
  guardString(args.service, "service");

  const query = {};
  if (args.passing) query.passing = "";
  if (args.tag)     query.tag     = args.tag;
  if (args.near)    query.near    = args.near;
  if (args.filter)  query.filter  = args.filter;

  const res = await consulRequest(conn, "GET", `${API_V1}/health/service/${encodeURIComponent(args.service)}`, query, null, conn.timeoutMs);
  checkStatus(res, "service_health");

  const entries = parseJson(res.raw, "service_health");
  const items   = entries.map(e => ({
    node:    e.Node    ? { name: e.Node.Node, address: e.Node.Address, dc: e.Node.Datacenter } : null,
    service: e.Service ? { id: e.Service.ID, name: e.Service.Service, tags: e.Service.Tags || [], address: e.Service.Address, port: e.Service.Port } : null,
    checks:  (e.Checks || []).map(c => ({ name: c.Name, checkId: c.CheckID, status: c.Status, output: c.Output })),
  }));

  return {
    ok:        true,
    operation: "service_health",
    server:    `${conn.host}:${conn.port}`,
    service:   args.service,
    passing:   !!args.passing,
    count:     items.length,
    entries:   items,
    index:     res.headers["x-consul-index"] || null,
  };
}

async function opNodes(args) {
  const conn  = buildConn(args);
  const query = {};
  if (args.near)      query.near      = args.near;
  if (args.filter)    query.filter    = args.filter;
  if (args.node_meta) query.node_meta = args.node_meta;

  const res = await consulRequest(conn, "GET", `${API_V1}/catalog/nodes`, query, null, conn.timeoutMs);
  checkStatus(res, "nodes");

  const nodes = parseJson(res.raw, "nodes");
  return {
    ok:        true,
    operation: "nodes",
    server:    `${conn.host}:${conn.port}`,
    count:     nodes.length,
    nodes:     nodes.map(n => ({
      name:             n.Node,
      address:          n.Address,
      datacenter:       n.Datacenter,
      tagged_addresses: n.TaggedAddresses || {},
      meta:             n.Meta || {},
    })),
    index:     res.headers["x-consul-index"] || null,
  };
}

async function opNodeHealth(args) {
  const conn = buildConn(args);
  if (!args.node) throw new Error("node_health requires 'node'");
  guardString(args.node, "node");

  const query = {};
  if (args.filter) query.filter = args.filter;

  const res = await consulRequest(conn, "GET", `${API_V1}/health/node/${encodeURIComponent(args.node)}`, query, null, conn.timeoutMs);

  if (res.statusCode === 404) {
    return { ok: true, operation: "node_health", server: `${conn.host}:${conn.port}`, node: args.node, found: false };
  }
  checkStatus(res, "node_health");

  const checks = parseJson(res.raw, "node_health");
  return {
    ok:        true,
    operation: "node_health",
    server:    `${conn.host}:${conn.port}`,
    node:      args.node,
    count:     checks.length,
    checks:    checks.map(c => ({ name: c.Name, checkId: c.CheckID, node: c.Node, status: c.Status, output: c.Output })),
    index:     res.headers["x-consul-index"] || null,
  };
}

// ── Cluster status ─────────────────────────────────────────────────────────

async function opMembers(args) {
  const conn  = buildConn(args);
  const query = {};
  if (args.wan)     query.wan     = "";
  if (args.segment) query.segment = args.segment;

  const res = await consulRequest(conn, "GET", `${API_V1}/agent/members`, query, null, conn.timeoutMs);
  checkStatus(res, "members");

  const members = parseJson(res.raw, "members");
  return {
    ok:        true,
    operation: "members",
    server:    `${conn.host}:${conn.port}`,
    wan:       !!args.wan,
    count:     members.length,
    members:   members.map(m => ({ name: m.Name, addr: m.Addr, port: m.Port, status: m.Status, tags: m.Tags || {} })),
  };
}

async function opLeader(args) {
  const conn   = buildConn(args);
  const res    = await consulRequest(conn, "GET", `${API_V1}/status/leader`, {}, null, conn.timeoutMs);
  checkStatus(res, "leader");
  const leader = parseJson(res.raw, "leader");
  return { ok: true, operation: "leader", server: `${conn.host}:${conn.port}`, leader: leader || null };
}

async function opPeers(args) {
  const conn  = buildConn(args);
  const res   = await consulRequest(conn, "GET", `${API_V1}/status/peers`, {}, null, conn.timeoutMs);
  checkStatus(res, "peers");
  const peers = parseJson(res.raw, "peers");
  return { ok: true, operation: "peers", server: `${conn.host}:${conn.port}`, count: peers.length, peers };
}

async function opStatus(args) {
  const conn = buildConn(args);
  const res  = await consulRequest(conn, "GET", `${API_V1}/agent/self`, {}, null, conn.timeoutMs);
  checkStatus(res, "status");

  const self = parseJson(res.raw, "status");
  const cfg  = self.Config || {};
  const info = self.Stats  || {};
  return {
    ok:           true,
    operation:    "status",
    server:       `${conn.host}:${conn.port}`,
    node:         cfg.NodeName   || null,
    datacenter:   cfg.Datacenter || null,
    version:      (self.Meta && self.Meta["consul-version"]) ? self.Meta["consul-version"]
                  : (info.consul && info.consul.version ? info.consul.version : null),
    server_mode:  cfg.ServerMode || false,
    bootstrap:    cfg.Bootstrap  || false,
    raft_state:   info.raft && info.raft.state         ? info.raft.state         : null,
    last_log_index: info.raft && info.raft.last_log_index ? info.raft.last_log_index : null,
  };
}

// ── Service Registration ───────────────────────────────────────────────────

async function opRegister(args) {
  const conn = buildConn(args);
  if (!args.service) throw new Error("register requires 'service' (service name)");
  guardString(args.service,    "service");
  guardString(args.service_id, "service_id");
  guardString(args.address,    "address");

  const body = {
    Name:    args.service,
    ID:      args.service_id || args.service,
    Tags:    args.tags    || [],
    Address: args.address || "",
    Port:    args.service_port != null ? Number(args.service_port) : undefined,
    Meta:    args.meta    || {},
  };

  if (args.check) {
    body.Check = {
      HTTP:      args.check.http     || undefined,
      TCP:       args.check.tcp      || undefined,
      Interval:  args.check.interval || "10s",
      Timeout:   args.check.timeout  || "3s",
      TLSSkipVerify: args.check.tls_skip_verify || false,
      DeregisterCriticalServiceAfter: args.check.deregister_after || undefined,
    };
    // Remove undefined check fields
    Object.keys(body.Check).forEach(k => body.Check[k] === undefined && delete body.Check[k]);
  }
  // Remove undefined top-level fields
  Object.keys(body).forEach(k => body[k] === undefined && delete body[k]);

  const res = await consulRequest(conn, "PUT", `${API_V1}/agent/service/register`, {}, body, conn.timeoutMs);
  checkStatus(res, "register");

  return {
    ok:         true,
    operation:  "register",
    server:     `${conn.host}:${conn.port}`,
    service:    args.service,
    service_id: body.ID,
    registered: true,
  };
}

async function opDeregister(args) {
  const conn = buildConn(args);
  if (!args.service_id) throw new Error("deregister requires 'service_id'");
  guardString(args.service_id, "service_id");

  const res = await consulRequest(conn, "PUT", `${API_V1}/agent/service/deregister/${encodeURIComponent(args.service_id)}`, {}, null, conn.timeoutMs);
  checkStatus(res, "deregister");

  return {
    ok:           true,
    operation:    "deregister",
    server:       `${conn.host}:${conn.port}`,
    service_id:   args.service_id,
    deregistered: true,
  };
}

async function opChecks(args) {
  const conn  = buildConn(args);
  const query = {};
  if (args.filter) query.filter = args.filter;

  const res = await consulRequest(conn, "GET", `${API_V1}/agent/checks`, query, null, conn.timeoutMs);
  checkStatus(res, "checks");

  const checksMap = parseJson(res.raw, "checks");
  const checks    = Object.values(checksMap).map(c => ({
    id:      c.CheckID,
    name:    c.Name,
    service: c.ServiceName || null,
    status:  c.Status,
    output:  c.Output,
    type:    c.Type,
  }));

  return {
    ok:        true,
    operation: "checks",
    server:    `${conn.host}:${conn.port}`,
    count:     checks.length,
    checks,
  };
}

// ── Sessions ───────────────────────────────────────────────────────────────

async function opSessionCreate(args) {
  const conn = buildConn(args);
  guardString(args.session_name, "session_name");
  guardString(args.node,         "node");

  const body = {
    Name:      args.session_name || "mcp-session",
    TTL:       args.ttl          || undefined,
    Behavior:  args.behavior     || "release",
    LockDelay: args.lock_delay   || undefined,
    Checks:    args.checks       || [],
  };
  if (args.node) body.Node = args.node;
  Object.keys(body).forEach(k => body[k] === undefined && delete body[k]);

  const res = await consulRequest(conn, "PUT", `${API_V1}/session/create`, {}, body, conn.timeoutMs);
  checkStatus(res, "session_create");

  const result = parseJson(res.raw, "session_create");
  return {
    ok:         true,
    operation:  "session_create",
    server:     `${conn.host}:${conn.port}`,
    session_id: result.ID,
  };
}

async function opSessionDestroy(args) {
  const conn = buildConn(args);
  if (!args.session_id) throw new Error("session_destroy requires 'session_id'");
  guardString(args.session_id, "session_id");

  const res = await consulRequest(conn, "PUT", `${API_V1}/session/destroy/${encodeURIComponent(args.session_id)}`, {}, null, conn.timeoutMs);
  checkStatus(res, "session_destroy");

  return {
    ok:         true,
    operation:  "session_destroy",
    server:     `${conn.host}:${conn.port}`,
    session_id: args.session_id,
    destroyed:  true,
  };
}

async function opSessionInfo(args) {
  const conn = buildConn(args);
  if (!args.session_id) throw new Error("session_info requires 'session_id'");
  guardString(args.session_id, "session_id");

  const res = await consulRequest(conn, "GET", `${API_V1}/session/info/${encodeURIComponent(args.session_id)}`, {}, null, conn.timeoutMs);
  checkStatus(res, "session_info");

  const sessions = parseJson(res.raw, "session_info");
  if (!sessions || sessions.length === 0) {
    return { ok: true, operation: "session_info", server: `${conn.host}:${conn.port}`, session_id: args.session_id, found: false };
  }

  const s = sessions[0];
  return {
    ok:           true,
    operation:    "session_info",
    server:       `${conn.host}:${conn.port}`,
    found:        true,
    session_id:   s.ID,
    name:         s.Name,
    node:         s.Node,
    checks:       s.Checks      || [],
    behavior:     s.Behavior,
    ttl:          s.TTL,
    lock_delay:   s.LockDelay,
    create_index: s.CreateIndex,
    modify_index: s.ModifyIndex,
  };
}

// ── Distributed Locking ────────────────────────────────────────────────────

async function opLock(args) {
  const conn = buildConn(args);
  if (!args.key)        throw new Error("lock requires 'key'");
  if (!args.session_id) throw new Error("lock requires 'session_id'");
  guardString(args.key,        "key");
  guardString(args.session_id, "session_id");
  guardString(args.value,      "value");

  const query  = { acquire: args.session_id };
  if (args.flags != null) query.flags = String(args.flags);

  const bodyBuf = Buffer.from(args.value != null ? String(args.value) : "", "utf8");
  const res     = await consulPutRaw(conn, `${API_V1}/kv/${encodeKey(args.key)}`, query, bodyBuf, conn.timeoutMs);
  checkStatus(res, "lock");

  const acquired = parseJson(res.raw, "lock");
  return {
    ok:         true,
    operation:  "lock",
    server:     `${conn.host}:${conn.port}`,
    key:        args.key,
    session_id: args.session_id,
    acquired:   acquired === true,
  };
}

async function opUnlock(args) {
  const conn = buildConn(args);
  if (!args.key)        throw new Error("unlock requires 'key'");
  if (!args.session_id) throw new Error("unlock requires 'session_id'");
  guardString(args.key,        "key");
  guardString(args.session_id, "session_id");

  const query   = { release: args.session_id };
  const bodyBuf = Buffer.from("", "utf8");
  const res     = await consulPutRaw(conn, `${API_V1}/kv/${encodeKey(args.key)}`, query, bodyBuf, conn.timeoutMs);
  checkStatus(res, "unlock");

  const released = parseJson(res.raw, "unlock");
  return {
    ok:         true,
    operation:  "unlock",
    server:     `${conn.host}:${conn.port}`,
    key:        args.key,
    session_id: args.session_id,
    released:   released === true,
  };
}

// ── Catalog ────────────────────────────────────────────────────────────────

async function opCatalogDatacenters(args) {
  const conn = buildConn(args);
  const res  = await consulRequest(conn, "GET", `${API_V1}/catalog/datacenters`, {}, null, conn.timeoutMs);
  checkStatus(res, "catalog_datacenters");

  const dcs = parseJson(res.raw, "catalog_datacenters");
  return {
    ok:          true,
    operation:   "catalog_datacenters",
    server:      `${conn.host}:${conn.port}`,
    count:       dcs.length,
    datacenters: dcs,
  };
}

// ── Info ───────────────────────────────────────────────────────────────────

function opInfo() {
  return {
    ok:          true,
    protocol:    "HashiCorp Consul HTTP API v1",
    defaultPort: DEFAULT_PORT,
    apiBase:     "http[s]://<host>:<port>/v1/...",
    operations: [
      { op: "kv_get",              description: "Read a key (or recurse/list under prefix) from the KV store" },
      { op: "kv_put",              description: "Write a key+value into the KV store (optional flags/CAS)" },
      { op: "kv_delete",           description: "Delete a key or recursively all keys under a prefix" },
      { op: "kv_list",             description: "List all keys under a prefix (names only)" },
      { op: "services",            description: "List all registered services in the catalog" },
      { op: "service_health",      description: "Return health checks for a named service" },
      { op: "nodes",               description: "List all nodes in the datacenter" },
      { op: "node_health",         description: "Return health checks for a specific node" },
      { op: "members",             description: "Return gossip members (WAN or LAN)" },
      { op: "leader",              description: "Return the current Raft leader address" },
      { op: "peers",               description: "Return the list of Raft peers" },
      { op: "status",              description: "Return local agent self info (node, dc, version, raft state)" },
      { op: "register",            description: "Register a service on the local agent" },
      { op: "deregister",          description: "Deregister a service from the local agent" },
      { op: "checks",              description: "List all health checks known to the agent" },
      { op: "session_create",      description: "Create a session (for distributed locking with TTL/behavior)" },
      { op: "session_destroy",     description: "Destroy a session by ID" },
      { op: "session_info",        description: "Get info about a session by ID" },
      { op: "lock",                description: "Acquire a distributed lock on a KV key using a session" },
      { op: "unlock",              description: "Release a distributed lock on a KV key using a session" },
      { op: "catalog_datacenters", description: "List all known datacenters" },
      { op: "info",                description: "Return this protocol/config reference (no I/O)" },
    ],
    auth: {
      method:   "ACL token via X-Consul-Token request header",
      usage:    "Pass 'token' parameter with a valid ACL token",
      aclGuide: "https://developer.hashicorp.com/consul/api-docs/access-control",
    },
    blockingQueries: {
      description: "Consul supports long-polling via index + wait parameters",
      usage:       "Pass 'index' (X-Consul-Index from prior response) and 'wait' (e.g. '30s') to kv_get",
    },
    sessions: {
      description:  "Sessions underpin Consul's distributed locking mechanism",
      lockWorkflow: "session_create → lock (key + session_id) → ... → unlock → session_destroy",
      behavior:     "'release' (default) releases lock on session expiry; 'delete' removes the key",
    },
    kvEncoding: {
      wire:   "Values are base64-encoded in KV GET responses",
      decode: "This client decodes values to UTF-8 strings automatically",
    },
    useCases: [
      "Service discovery and health checking in microservices",
      "Distributed configuration management via KV store",
      "Distributed locking using sessions (leader election)",
      "Cluster membership and datacenter topology discovery",
      "Service registration and deregistration automation",
      "Feature flags and dynamic configuration",
      "Key/value store for lightweight distributed state",
    ],
  };
}

// ── Main entry point ───────────────────────────────────────────────────────

async function consulClient(args) {
  // Validate common numeric args eagerly (even for info)
  if (args.timeout !== undefined && args.timeout !== null)
    clampInt(args.timeout, DEFAULT_TIMEOUT_MS, 1000, 120000, "timeout");
  if (args.port !== undefined && args.port !== null)
    clampInt(args.port, DEFAULT_PORT, 1, 65535, "port");

  const op = (args.operation || "").toLowerCase().replace(/-/g, "_");

  switch (op) {
    case "kv_get":              return opKvGet(args);
    case "kv_put":              return opKvPut(args);
    case "kv_delete":           return opKvDelete(args);
    case "kv_list":             return opKvList(args);
    case "services":            return opServices(args);
    case "service_health":      return opServiceHealth(args);
    case "nodes":               return opNodes(args);
    case "node_health":         return opNodeHealth(args);
    case "members":             return opMembers(args);
    case "leader":              return opLeader(args);
    case "peers":               return opPeers(args);
    case "status":              return opStatus(args);
    case "register":            return opRegister(args);
    case "deregister":          return opDeregister(args);
    case "checks":              return opChecks(args);
    case "session_create":      return opSessionCreate(args);
    case "session_destroy":     return opSessionDestroy(args);
    case "session_info":        return opSessionInfo(args);
    case "lock":                return opLock(args);
    case "unlock":              return opUnlock(args);
    case "catalog_datacenters": return opCatalogDatacenters(args);
    case "info":                return opInfo();
    default:
      throw new Error(
        `Unknown consul_client operation: '${args.operation}'. ` +
        "Valid: kv_get, kv_put, kv_delete, kv_list, services, service_health, nodes, " +
        "node_health, members, leader, peers, status, register, deregister, checks, " +
        "session_create, session_destroy, session_info, lock, unlock, catalog_datacenters, info"
      );
  }
}

module.exports = {
  consulClient,
  // Exported for testing
  encodeKey, decodeKvEntry,
  requireString, guardString, clampInt, buildConn,
};
