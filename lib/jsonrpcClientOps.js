"use strict";
// lib/jsonrpcClientOps.js — jsonrpc_client tool
// Zero-dependency JSON-RPC 2.0 client (pure Node.js; no npm deps).
// Reference: https://www.jsonrpc.org/specification
//
// Transports:
//   http / https  — HTTP POST (most common; Ethereum, language servers, etc.)
//   tcp           — TCP socket framing (newline-delimited JSON)
//   unix          — Unix domain socket (same framing as TCP)
//
// Operations:
//   call          — single request + response (HTTP/HTTPS)
//   notify        — fire-and-forget notification (HTTP/HTTPS, no id)
//   batch         — batch array of calls in one HTTP request
//   call_tcp      — single call over TCP socket
//   call_unix     — single call over Unix domain socket

const http  = require("http");
const https = require("https");
const net   = require("net");
const { ToolError } = require("./errors");

// ── Constants ─────────────────────────────────────────────────────────────────
const DEFAULT_HTTP_TIMEOUT  = 30_000;   // ms
const DEFAULT_SOCK_TIMEOUT  = 30_000;   // ms
const MAX_RESPONSE_BYTES    = 10 * 1024 * 1024; // 10 MB
const MAX_BATCH_SIZE        = 100;
const JSON_RPC_VERSION      = "2.0";

// ── ID generator ─────────────────────────────────────────────────────────────
let _nextId = 1;
function nextId() { return _nextId++; }

// ── Request builders ──────────────────────────────────────────────────────────

function buildRequest(method, params, id) {
  const req = { jsonrpc: JSON_RPC_VERSION, method };
  if (params !== undefined) req.params = params;
  if (id !== undefined) req.id = id;
  return req;
}

function buildNotification(method, params) {
  // Notifications have no id — server must not reply
  const req = { jsonrpc: JSON_RPC_VERSION, method };
  if (params !== undefined) req.params = params;
  return req;
}

// ── HTTP/HTTPS transport ──────────────────────────────────────────────────────

function httpPost(url, body, opts) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : http;
    const port = parsed.port
      ? parseInt(parsed.port, 10)
      : (isHttps ? 443 : 80);

    const bodyBuf = Buffer.from(JSON.stringify(body), "utf8");

    const reqOpts = {
      hostname: parsed.hostname,
      port,
      path:     parsed.pathname + (parsed.search || ""),
      method:   "POST",
      headers:  {
        "Content-Type":   "application/json",
        "Content-Length": bodyBuf.length,
        ...(opts.headers || {}),
      },
    };

    if (isHttps) {
      reqOpts.rejectUnauthorized = opts.reject_unauthorized !== false;
    }

    const timeout = (typeof opts.timeout === "number" && opts.timeout > 0)
      ? opts.timeout
      : DEFAULT_HTTP_TIMEOUT;

    const req = lib.request(reqOpts, (res) => {
      const chunks = [];
      let total = 0;
      res.on("data", (chunk) => {
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) {
          req.destroy();
          reject(new ToolError(
            "jsonrpc_client: response too large (> " + MAX_RESPONSE_BYTES + " bytes).",
            -32603
          ));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve({ statusCode: res.statusCode, headers: res.headers, raw });
      });
      res.on("error", reject);
    });

    req.setTimeout(timeout, () => {
      req.destroy();
      reject(new ToolError(
        "jsonrpc_client: HTTP request timed out after " + timeout + " ms.",
        -32603
      ));
    });

    req.on("error", (err) => {
      reject(new ToolError(
        "jsonrpc_client: HTTP error — " + err.message,
        -32603
      ));
    });

    req.write(bodyBuf);
    req.end();
  });
}

function parseJsonRpcResponse(raw, isNotification) {
  // Notifications expect no response — but server may send one anyway
  if (isNotification && (!raw || !raw.trim())) {
    return { notified: true };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new ToolError(
      "jsonrpc_client: server returned invalid JSON — " + e.message +
      ". Raw (first 200 chars): " + raw.slice(0, 200),
      -32700
    );
  }

  return parsed;
}

function extractResult(rpcResp) {
  // For a standard response, validate structure and extract result/error
  if (Array.isArray(rpcResp)) {
    // Batch response — return as-is
    return rpcResp;
  }

  if (typeof rpcResp !== "object" || rpcResp === null) {
    throw new ToolError(
      "jsonrpc_client: unexpected response type '" + typeof rpcResp + "'.",
      -32603
    );
  }

  if (rpcResp.error) {
    const err = rpcResp.error;
    throw new ToolError(
      "jsonrpc_client: JSON-RPC error " + (err.code || "?") +
      " — " + (err.message || JSON.stringify(err)),
      err.code || -32603
    );
  }

  return rpcResp.result !== undefined ? rpcResp.result : null;
}

// ── TCP / Unix socket transport ───────────────────────────────────────────────

function socketRpc(connectOpts, body, timeout) {
  return new Promise((resolve, reject) => {
    const ms = (typeof timeout === "number" && timeout > 0) ? timeout : DEFAULT_SOCK_TIMEOUT;
    const bodyStr = JSON.stringify(body) + "\n"; // newline-delimited JSON
    const bodyBuf = Buffer.from(bodyStr, "utf8");

    const chunks = [];
    let total = 0;
    let settled = false;

    const sock = net.createConnection(connectOpts, () => {
      sock.write(bodyBuf);
    });

    sock.setTimeout(ms);

    sock.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_RESPONSE_BYTES) {
        if (!settled) { settled = true; sock.destroy(); }
        reject(new ToolError(
          "jsonrpc_client: socket response too large (> " + MAX_RESPONSE_BYTES + " bytes).",
          -32603
        ));
        return;
      }
      chunks.push(chunk);
      // Try parsing after every chunk — end on valid JSON line
      const raw = Buffer.concat(chunks).toString("utf8");
      const newline = raw.indexOf("\n");
      if (newline !== -1) {
        if (!settled) {
          settled = true;
          sock.destroy();
          resolve(raw.slice(0, newline).trim());
        }
      }
    });

    sock.on("end", () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks).toString("utf8").trim());
      }
    });

    sock.on("timeout", () => {
      if (!settled) {
        settled = true;
        sock.destroy();
        reject(new ToolError(
          "jsonrpc_client: socket timed out after " + ms + " ms.",
          -32603
        ));
      }
    });

    sock.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(new ToolError(
          "jsonrpc_client: socket error — " + err.message,
          -32603
        ));
      }
    });
  });
}

// ── Operations ────────────────────────────────────────────────────────────────

async function opCall(args) {
  if (!args.url)    throw new ToolError("jsonrpc_client call: 'url' is required.", -32602);
  if (!args.method) throw new ToolError("jsonrpc_client call: 'method' is required.", -32602);

  const id = args.id !== undefined ? args.id : nextId();
  const request = buildRequest(args.method, args.params, id);

  const { statusCode, raw } = await httpPost(args.url, request, {
    headers:              args.headers,
    timeout:              args.timeout,
    reject_unauthorized:  args.reject_unauthorized,
  });

  const rpcResp = parseJsonRpcResponse(raw, false);
  const result  = extractResult(rpcResp);

  return {
    operation:  "call",
    url:        args.url,
    method:     args.method,
    id,
    statusCode,
    result,
    raw:        args.include_raw ? raw : undefined,
  };
}

async function opNotify(args) {
  if (!args.url)    throw new ToolError("jsonrpc_client notify: 'url' is required.", -32602);
  if (!args.method) throw new ToolError("jsonrpc_client notify: 'method' is required.", -32602);

  const request = buildNotification(args.method, args.params);

  const { statusCode, raw } = await httpPost(args.url, request, {
    headers:              args.headers,
    timeout:              args.timeout,
    reject_unauthorized:  args.reject_unauthorized,
  });

  // Notifications should get no response body; server may return 204 or empty 200
  return {
    operation:  "notify",
    url:        args.url,
    method:     args.method,
    statusCode,
    notified:   true,
    raw:        args.include_raw ? raw : undefined,
  };
}

async function opBatch(args) {
  if (!args.url)     throw new ToolError("jsonrpc_client batch: 'url' is required.", -32602);
  if (!Array.isArray(args.calls) || args.calls.length === 0)
    throw new ToolError("jsonrpc_client batch: 'calls' must be a non-empty array.", -32602);
  if (args.calls.length > MAX_BATCH_SIZE)
    throw new ToolError(
      "jsonrpc_client batch: 'calls' exceeds limit (" + args.calls.length +
      " > " + MAX_BATCH_SIZE + ").",
      -32602
    );

  const requests = args.calls.map((call, i) => {
    if (!call.method)
      throw new ToolError(
        "jsonrpc_client batch: calls[" + i + "] must have a 'method'.",
        -32602
      );
    if (call.notify) {
      return buildNotification(call.method, call.params);
    }
    const id = call.id !== undefined ? call.id : nextId();
    return buildRequest(call.method, call.params, id);
  });

  const { statusCode, raw } = await httpPost(args.url, requests, {
    headers:              args.headers,
    timeout:              args.timeout,
    reject_unauthorized:  args.reject_unauthorized,
  });

  let responses;
  try {
    responses = JSON.parse(raw);
  } catch (e) {
    throw new ToolError(
      "jsonrpc_client batch: server returned invalid JSON — " + e.message,
      -32700
    );
  }

  if (!Array.isArray(responses)) {
    // Server may return a single error object for the whole batch
    if (responses && responses.error) {
      throw new ToolError(
        "jsonrpc_client batch: server error " + (responses.error.code || "?") +
        " — " + (responses.error.message || JSON.stringify(responses.error)),
        responses.error.code || -32603
      );
    }
    // Wrap in array for uniform handling
    responses = [responses];
  }

  // Build an id→response map
  const byId = new Map();
  for (const r of responses) {
    if (r && r.id != null) byId.set(String(r.id), r);
  }

  // Build results aligned with request order
  const results = requests.map((req, i) => {
    if (!req.id) {
      // Notification — no response expected
      return { index: i, method: req.method, notify: true, notified: true };
    }
    const resp = byId.get(String(req.id));
    if (!resp) {
      return { index: i, method: req.method, id: req.id, error: "no response for this id" };
    }
    if (resp.error) {
      return {
        index:  i,
        method: req.method,
        id:     req.id,
        error:  resp.error,
      };
    }
    return {
      index:  i,
      method: req.method,
      id:     req.id,
      result: resp.result !== undefined ? resp.result : null,
    };
  });

  return {
    operation:  "batch",
    url:        args.url,
    statusCode,
    callCount:  requests.length,
    results,
    raw:        args.include_raw ? raw : undefined,
  };
}

async function opCallTcp(args) {
  if (!args.host)   throw new ToolError("jsonrpc_client call_tcp: 'host' is required.", -32602);
  if (!args.port)   throw new ToolError("jsonrpc_client call_tcp: 'port' is required.", -32602);
  if (!args.method) throw new ToolError("jsonrpc_client call_tcp: 'method' is required.", -32602);

  const id = args.id !== undefined ? args.id : nextId();
  const request = buildRequest(args.method, args.params, id);

  const raw = await socketRpc(
    { host: args.host, port: args.port },
    request,
    args.timeout
  );

  const rpcResp = parseJsonRpcResponse(raw, false);
  const result  = extractResult(rpcResp);

  return {
    operation:  "call_tcp",
    host:       args.host,
    port:       args.port,
    method:     args.method,
    id,
    result,
    raw:        args.include_raw ? raw : undefined,
  };
}

async function opCallUnix(args) {
  if (!args.socket_path) throw new ToolError("jsonrpc_client call_unix: 'socket_path' is required.", -32602);
  if (!args.method)      throw new ToolError("jsonrpc_client call_unix: 'method' is required.", -32602);
  if (args.socket_path.includes("\0"))
    throw new ToolError("jsonrpc_client call_unix: 'socket_path' contains NUL byte.", -32602);

  const id = args.id !== undefined ? args.id : nextId();
  const request = buildRequest(args.method, args.params, id);

  const raw = await socketRpc(
    { path: args.socket_path },
    request,
    args.timeout
  );

  const rpcResp = parseJsonRpcResponse(raw, false);
  const result  = extractResult(rpcResp);

  return {
    operation:   "call_unix",
    socket_path: args.socket_path,
    method:      args.method,
    id,
    result,
    raw:         args.include_raw ? raw : undefined,
  };
}

// ── Main dispatcher ───────────────────────────────────────────────────────────

async function jsonrpcClient(args) {
  const op = args.operation;
  if (!op) throw new ToolError("jsonrpc_client: 'operation' is required.", -32602);

  const VALID_OPS = ["call", "notify", "batch", "call_tcp", "call_unix"];
  if (!VALID_OPS.includes(op))
    throw new ToolError(
      "jsonrpc_client: unknown operation '" + op + "'. Valid: " + VALID_OPS.join(", ") + ".",
      -32602
    );

  switch (op) {
    case "call":       return opCall(args);
    case "notify":     return opNotify(args);
    case "batch":      return opBatch(args);
    case "call_tcp":   return opCallTcp(args);
    case "call_unix":  return opCallUnix(args);
  }
}

module.exports = { jsonrpcClient, buildRequest, buildNotification, parseJsonRpcResponse };
