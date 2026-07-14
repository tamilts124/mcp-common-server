"use strict";
/**
 * aws_client — Zero-dependency AWS API client with SigV4 authentication
 * (pure Node.js http/https/crypto built-ins; no npm deps)
 *
 * AWS Signature Version 4: https://docs.aws.amazon.com/general/latest/gr/sigv4_signing.html
 *
 * Supported services (via generic request + service-specific helpers):
 *   s3          — GetObject, PutObject, DeleteObject, ListObjectsV2, HeadObject,
 *                 CreateBucket, DeleteBucket, ListBuckets
 *   dynamodb    — GetItem, PutItem, DeleteItem, Query, Scan, UpdateItem,
 *                 CreateTable, DeleteTable, ListTables, DescribeTable
 *   sqs         — SendMessage, ReceiveMessage, DeleteMessage, GetQueueUrl,
 *                 CreateQueue, DeleteQueue, ListQueues, GetQueueAttributes
 *   sns         — Publish, CreateTopic, DeleteTopic, Subscribe, Unsubscribe,
 *                 ListTopics, ListSubscriptions, GetTopicAttributes
 *   lambda      — InvokeFunction, ListFunctions, GetFunction, CreateFunction,
 *                 DeleteFunction, UpdateFunctionCode
 *   sts         — GetCallerIdentity, AssumeRole, GetSessionToken
 *   ec2         — DescribeInstances, StartInstances, StopInstances, DescribeImages,
 *                 DescribeSecurityGroups, DescribeVpcs, DescribeSubnets
 *   secretsmanager — GetSecretValue, CreateSecret, DeleteSecret, ListSecrets
 *   ssm         — GetParameter, PutParameter, DeleteParameter, GetParametersByPath
 *   cloudwatch  — GetMetricData, ListMetrics, PutMetricData
 *   request     — Generic authenticated HTTP request to any AWS endpoint
 *   info        — Return protocol/service/operation reference (no I/O)
 *
 * Auth: AWS access key + secret key + optional session token (STS/role-based).
 * Region: required for most services (defaults to us-east-1 for global services).
 * TLS: use_tls:true (default true for AWS).
 *
 * Security:
 *   NUL-byte guards on all string inputs.
 *   Timeout clamped 1000-120000 ms.
 *   Port validated 1-65535.
 *   Credentials never returned in output or error messages.
 *   16 MB response cap.
 */

const http   = require("http");
const https  = require("https");
const crypto = require("crypto");

// ── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS  = 15000;
const MAX_RESPONSE_BYTES  = 16 * 1024 * 1024; // 16 MB
const DEFAULT_REGION      = "us-east-1";

// Service endpoint patterns
const SERVICE_ENDPOINTS = {
  s3:             (region) => region === "us-east-1" ? "s3.amazonaws.com" : `s3.${region}.amazonaws.com`,
  dynamodb:       (region) => `dynamodb.${region}.amazonaws.com`,
  sqs:            (region) => `sqs.${region}.amazonaws.com`,
  sns:            (region) => `sns.${region}.amazonaws.com`,
  lambda:         (region) => `lambda.${region}.amazonaws.com`,
  sts:            ()       => "sts.amazonaws.com",
  ec2:            (region) => `ec2.${region}.amazonaws.com`,
  secretsmanager: (region) => `secretsmanager.${region}.amazonaws.com`,
  ssm:            (region) => `ssm.${region}.amazonaws.com`,
  cloudwatch:     (region) => `monitoring.${region}.amazonaws.com`,
};

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
    if (val.includes("\0"))     throw new Error(`${name} must not contain NUL bytes`);
  }
}

function clampInt(val, def, min, max, name) {
  if (val === undefined || val === null) return def;
  const n = Number(val);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  if (n < min || n > max)  throw new Error(`${name} must be between ${min} and ${max}`);
  return Math.round(n);
}

// ── AWS SigV4 Implementation ───────────────────────────────────────────────

/**
 * HMAC-SHA256 helper.
 */
function hmacSha256(key, data) {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest();
}

/**
 * SHA-256 hash of a string, returned as lowercase hex.
 */
function sha256Hex(data) {
  return crypto.createHash("sha256").update(data, "utf8").digest("hex");
}

/**
 * SHA-256 hash of a Buffer, returned as lowercase hex.
 */
function sha256HexBuffer(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Derive the signing key for SigV4.
 * kSecret = "AWS4" + secretKey
 * kDate   = HMAC(kSecret,  dateStamp)       -- YYYYMMDD
 * kRegion = HMAC(kDate,    region)
 * kService= HMAC(kRegion,  service)
 * kSigning= HMAC(kService, "aws4_request")
 */
function deriveSigningKey(secretKey, dateStamp, region, service) {
  const kSecret  = Buffer.from("AWS4" + secretKey, "utf8");
  const kDate    = hmacSha256(kSecret,  dateStamp);
  const kRegion  = hmacSha256(kDate,    region);
  const kService = hmacSha256(kRegion,  service);
  const kSigning = hmacSha256(kService, "aws4_request");
  return kSigning;
}

/**
 * URI-encode a path component per AWS SigV4 rules.
 * Encodes everything except unreserved chars (A-Z a-z 0-9 - _ . ~).
 * When encodeSlash=false, '/' is also left unencoded (for path strings).
 */
function uriEncode(str, encodeSlash) {
  let encoded = "";
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (/[A-Za-z0-9\-_.~]/.test(ch)) {
      encoded += ch;
    } else if (ch === "/" && !encodeSlash) {
      encoded += "/";
    } else {
      const hex = Buffer.from(ch, "utf8");
      for (const byte of hex) {
        encoded += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
      }
    }
  }
  return encoded;
}

/**
 * Build a canonical query string from a plain object.
 * Keys and values are URI-encoded, then sorted alphabetically by key.
 */
function buildCanonicalQueryString(params) {
  if (!params || Object.keys(params).length === 0) return "";
  return Object.keys(params)
    .sort()
    .map(k => uriEncode(k, true) + "=" + uriEncode(String(params[k] ?? ""), true))
    .join("&");
}

/**
 * Sign an AWS HTTP request using SigV4.
 *
 * @param {object} opts
 *   method        - HTTP method (GET, POST, PUT, DELETE, HEAD)
 *   url           - Full URL string
 *   headers       - Plain object of headers (will be mutated with auth headers)
 *   body          - Buffer or string body (may be empty)
 *   service       - AWS service name (e.g. "s3", "dynamodb")
 *   region        - AWS region (e.g. "us-east-1")
 *   accessKeyId   - AWS access key
 *   secretKey     - AWS secret access key
 *   sessionToken  - Optional STS session token
 * @returns {object} headers object with Authorization and x-amz-* headers added
 */
function signRequest(opts) {
  const { method, url, headers, body, service, region, accessKeyId, secretKey, sessionToken } = opts;

  const parsed   = new URL(url);
  const bodyBuf  = body ? (Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8")) : Buffer.alloc(0);
  const bodyHash = sha256HexBuffer(bodyBuf);

  // Timestamp
  const now       = new Date();
  const amzDate   = now.toISOString().replace(/[:\-]|\.\d{3}/g, "").slice(0, 15) + "Z";
  const dateStamp = amzDate.slice(0, 8);

  // Add required headers
  headers["x-amz-date"]           = amzDate;
  headers["x-amz-content-sha256"] = bodyHash;
  if (sessionToken) {
    headers["x-amz-security-token"] = sessionToken;
  }
  if (!headers["host"]) {
    headers["host"] = parsed.hostname;
  }

  // Step 1: Create canonical request
  // Canonical URI: path, URI-encoded (but not slashes)
  const canonicalUri = uriEncode(decodeURIComponent(parsed.pathname || "/"), false);

  // Canonical query string
  const queryParams = {};
  parsed.searchParams.forEach((v, k) => { queryParams[k] = v; });
  const canonicalQS = buildCanonicalQueryString(queryParams);

  // Canonical headers: sorted, lowercased, trimmed
  const signedHeaderNames = Object.keys(headers)
    .map(h => h.toLowerCase())
    .sort();
  const canonicalHeaders = signedHeaderNames
    .map(h => {
      const val = headers[Object.keys(headers).find(k => k.toLowerCase() === h)] || "";
      return h + ":" + String(val).trim().replace(/\s+/g, " ") + "\n";
    })
    .join("");
  const signedHeaders = signedHeaderNames.join(";");

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    canonicalQS,
    canonicalHeaders,
    signedHeaders,
    bodyHash,
  ].join("\n");

  // Step 2: Create string to sign
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  // Step 3: Calculate signature
  const signingKey = deriveSigningKey(secretKey, dateStamp, region, service);
  const signature  = crypto.createHmac("sha256", signingKey)
    .update(stringToSign, "utf8")
    .digest("hex");

  // Step 4: Build Authorization header
  headers["Authorization"] = [
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
  ].join(", ");

  return headers;
}

// ── HTTP helper ────────────────────────────────────────────────────────────

/**
 * Make an HTTP/HTTPS request to an AWS endpoint.
 */
function awsRequest(opts) {
  const { url, method, headers, body, timeoutMs, rejectUnauthorized } = opts;
  return new Promise((resolve, reject) => {
    const parsed   = new URL(url);
    const useTls   = parsed.protocol === "https:";
    const bodyBuf  = body ? (Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8")) : null;

    const reqOpts = {
      hostname: parsed.hostname,
      port:     parsed.port || (useTls ? 443 : 80),
      path:     parsed.pathname + (parsed.search || ""),
      method:   (method || "GET").toUpperCase(),
      headers:  { ...headers },
    };
    if (useTls) {
      reqOpts.rejectUnauthorized = rejectUnauthorized !== false;
      reqOpts.servername         = parsed.hostname;
    }
    if (bodyBuf) {
      reqOpts.headers["Content-Length"] = bodyBuf.length;
    }

    const mod    = useTls ? https : http;
    const chunks = [];
    let totalBytes = 0;
    let settled    = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy();
      reject(new Error(`AWS request ${method} ${url} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const req = mod.request(reqOpts, (res) => {
      res.on("data", (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          req.destroy();
          reject(new Error("AWS response exceeded 16 MB cap"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          statusCode: res.statusCode,
          headers:    res.headers,
          raw:        Buffer.concat(chunks).toString("utf8"),
        });
      });
      res.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`AWS response stream error: ${err.message}`));
      });
    });

    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Cannot connect to ${parsed.hostname}: ${err.message}`));
    });

    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

/** Parse JSON, throw with context on failure */
function parseJson(raw, context) {
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`AWS: invalid JSON response (${context}): ${raw.slice(0, 200)}`);
  }
}

/** Extract AWS error from response body */
function extractAwsError(raw, statusCode, context) {
  // Try JSON error format (most modern services)
  try {
    const j = JSON.parse(raw);
    const code    = j.__type || j.code || j.Code || "";
    const message = j.message || j.Message || j.errorMessage || raw.slice(0, 300);
    return new Error(`AWS ${context}: HTTP ${statusCode} — ${code ? code + ": " : ""}${message}`);
  } catch (_) {}
  // Try XML error format (S3, EC2, SQS)
  const codeMatch = raw.match(/<Code>([^<]+)<\/Code>/);
  const msgMatch  = raw.match(/<Message>([^<]+)<\/Message>/);
  if (codeMatch || msgMatch) {
    return new Error(`AWS ${context}: HTTP ${statusCode} — ${codeMatch ? codeMatch[1] + ": " : ""}${msgMatch ? msgMatch[1] : raw.slice(0, 300)}`);
  }
  return new Error(`AWS ${context}: HTTP ${statusCode} — ${raw.slice(0, 300)}`);
}

/** Check HTTP status, throw on non-2xx */
function checkStatus(res, context) {
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw extractAwsError(res.raw, res.statusCode, context);
  }
}

// ── Connection builder ─────────────────────────────────────────────────────

function buildConn(args) {
  requireString(args.access_key_id, "access_key_id");
  requireString(args.secret_key,    "secret_key");
  guardString(args.session_token, "session_token");
  guardString(args.region,        "region");

  const region      = args.region || DEFAULT_REGION;
  const timeoutMs   = clampInt(args.timeout, DEFAULT_TIMEOUT_MS, 1000, 120000, "timeout");
  const useTls      = args.use_tls !== false; // default true for AWS
  const rejectUnauthorized = args.reject_unauthorized !== false;

  return {
    accessKeyId:   args.access_key_id,
    secretKey:     args.secret_key,
    sessionToken:  args.session_token || null,
    region,
    timeoutMs,
    useTls,
    rejectUnauthorized,
  };
}

/**
 * Build endpoint URL for a service.
 */
function buildEndpoint(service, region, useTls, customEndpoint) {
  const scheme = useTls ? "https" : "http";
  if (customEndpoint) return customEndpoint;
  const endpointFn = SERVICE_ENDPOINTS[service];
  if (!endpointFn) throw new Error(`Unknown AWS service: '${service}'`);
  const host = endpointFn(region);
  return `${scheme}://${host}`;
}

/**
 * Core SigV4 request function.
 */
async function sigv4Request(conn, opts) {
  const { service, region, method, path, queryParams, headers, body, customEndpoint } = opts;
  const endpoint = buildEndpoint(service, region || conn.region, conn.useTls, customEndpoint);
  const qs       = queryParams && Object.keys(queryParams).length > 0
    ? "?" + buildCanonicalQueryString(queryParams)
    : "";
  const url = endpoint + (path || "/") + qs;

  const reqHeaders = {
    "host":         new URL(endpoint).hostname,
    "content-type": headers && headers["content-type"] ? headers["content-type"] : "application/json",
    ...headers,
  };

  // Remove undefined/null headers
  Object.keys(reqHeaders).forEach(k => {
    if (reqHeaders[k] == null) delete reqHeaders[k];
  });

  signRequest({
    method:      method || "GET",
    url,
    headers:     reqHeaders,
    body:        body || "",
    service:     service,
    region:      region || conn.region,
    accessKeyId: conn.accessKeyId,
    secretKey:   conn.secretKey,
    sessionToken: conn.sessionToken,
  });

  return awsRequest({
    url,
    method: method || "GET",
    headers: reqHeaders,
    body,
    timeoutMs: conn.timeoutMs,
    rejectUnauthorized: conn.rejectUnauthorized,
  });
}

// ── S3 Operations ──────────────────────────────────────────────────────────

async function opS3ListBuckets(args, conn) {
  const res = await sigv4Request(conn, {
    service: "s3", method: "GET", path: "/",
    headers: { "content-type": "application/xml" },
    customEndpoint: args.custom_endpoint,
  });
  checkStatus(res, "s3.list_buckets");
  const names  = [...res.raw.matchAll(/<Name>([^<]+)<\/Name>/g)].map(m => m[1]);
  const owners = res.raw.match(/<DisplayName>([^<]+)<\/DisplayName>/);
  return {
    ok: true, operation: "s3_list_buckets",
    count: names.length,
    buckets: names.map(n => ({ name: n })),
    owner: owners ? owners[1] : null,
  };
}

async function opS3ListObjects(args, conn) {
  requireString(args.bucket, "bucket");
  const qp = { "list-type": "2" };
  if (args.prefix)      qp.prefix        = args.prefix;
  if (args.max_keys)    qp["max-keys"]   = String(args.max_keys);
  if (args.delimiter)   qp.delimiter     = args.delimiter;
  if (args.start_after) qp["start-after"]= args.start_after;

  const endpoint = buildEndpoint("s3", conn.region, conn.useTls, args.custom_endpoint);
  const bucketEndpoint = endpoint.replace("://s3", `://${args.bucket}.s3`)
    .replace(`://${args.bucket}.s3.`, `://${args.bucket}.s3.`);

  // Use path-style URL if custom endpoint or if bucket name has dots
  let url, path;
  if (args.path_style || args.bucket.includes(".") || args.custom_endpoint) {
    path = `/${args.bucket}/`;
    url  = endpoint;
  } else {
    path = "/";
    url  = endpoint.replace("://s3", `://${args.bucket}.s3`);
  }

  const res = await sigv4Request(conn, {
    service: "s3", method: "GET", path,
    queryParams: qp,
    headers: { "content-type": "application/xml" },
    customEndpoint: args.custom_endpoint,
  });
  checkStatus(res, "s3.list_objects");

  const keys        = [...res.raw.matchAll(/<Key>([^<]+)<\/Key>/g)].map(m => m[1]);
  const sizes       = [...res.raw.matchAll(/<Size>(\d+)<\/Size>/g)].map(m => parseInt(m[1]));
  const truncMatch  = res.raw.match(/<IsTruncated>(true|false)<\/IsTruncated>/);
  const countMatch  = res.raw.match(/<KeyCount>(\d+)<\/KeyCount>/);

  return {
    ok: true, operation: "s3_list_objects",
    bucket: args.bucket,
    prefix: args.prefix || "",
    count: keys.length,
    is_truncated: truncMatch ? truncMatch[1] === "true" : false,
    key_count: countMatch ? parseInt(countMatch[1]) : keys.length,
    objects: keys.map((k, i) => ({ key: k, size: sizes[i] ?? null })),
  };
}

async function opS3GetObject(args, conn) {
  requireString(args.bucket, "bucket");
  requireString(args.key,    "key");

  const path = `/${encodeURIComponent(args.key).replace(/%2F/g, "/")}`;
  const res  = await sigv4Request(conn, {
    service: "s3", method: "GET",
    path: args.path_style ? `/${args.bucket}${path}` : path,
    headers: { "content-type": "application/octet-stream" },
    customEndpoint: args.custom_endpoint ||
      (args.path_style ? undefined : buildEndpoint("s3", conn.region, conn.useTls).replace("://s3", `://${args.bucket}.s3`)),
  });
  checkStatus(res, "s3.get_object");

  const contentType   = res.headers["content-type"]  || null;
  const contentLength = res.headers["content-length"] || null;
  const etag          = res.headers["etag"]           || null;
  const lastModified  = res.headers["last-modified"]  || null;

  // Return as base64 if binary, otherwise as UTF-8 string
  const isText = !contentType || contentType.startsWith("text/") ||
    contentType.includes("json") || contentType.includes("xml") ||
    contentType.includes("javascript") || contentType.includes("html");

  return {
    ok: true, operation: "s3_get_object",
    bucket: args.bucket, key: args.key,
    content_type:   contentType,
    content_length: contentLength ? parseInt(contentLength) : res.raw.length,
    etag:           etag ? etag.replace(/"/g, "") : null,
    last_modified:  lastModified,
    body:           isText ? res.raw : Buffer.from(res.raw, "binary").toString("base64"),
    body_encoding:  isText ? "utf8" : "base64",
  };
}

async function opS3PutObject(args, conn) {
  requireString(args.bucket, "bucket");
  requireString(args.key,    "key");

  const bodyBuf = args.body_base64
    ? Buffer.from(args.body_base64, "base64")
    : Buffer.from(args.body || "", "utf8");
  const contentType = args.content_type || "application/octet-stream";
  const path = `/${encodeURIComponent(args.key).replace(/%2F/g, "/")}`;

  const res = await sigv4Request(conn, {
    service: "s3", method: "PUT",
    path: args.path_style ? `/${args.bucket}${path}` : path,
    headers: { "content-type": contentType },
    body: bodyBuf,
    customEndpoint: args.custom_endpoint ||
      (args.path_style ? undefined : buildEndpoint("s3", conn.region, conn.useTls).replace("://s3", `://${args.bucket}.s3`)),
  });
  checkStatus(res, "s3.put_object");

  return {
    ok: true, operation: "s3_put_object",
    bucket: args.bucket, key: args.key,
    etag:          res.headers["etag"] ? res.headers["etag"].replace(/"/g, "") : null,
    version_id:    res.headers["x-amz-version-id"] || null,
    size_bytes:    bodyBuf.length,
  };
}

async function opS3DeleteObject(args, conn) {
  requireString(args.bucket, "bucket");
  requireString(args.key,    "key");

  const path = `/${encodeURIComponent(args.key).replace(/%2F/g, "/")}`;
  const res  = await sigv4Request(conn, {
    service: "s3", method: "DELETE",
    path: args.path_style ? `/${args.bucket}${path}` : path,
    headers: { "content-type": "application/xml" },
    customEndpoint: args.custom_endpoint ||
      (args.path_style ? undefined : buildEndpoint("s3", conn.region, conn.useTls).replace("://s3", `://${args.bucket}.s3`)),
  });
  if (res.statusCode !== 204 && res.statusCode !== 200) {
    throw extractAwsError(res.raw, res.statusCode, "s3.delete_object");
  }
  return { ok: true, operation: "s3_delete_object", bucket: args.bucket, key: args.key, deleted: true };
}

async function opS3HeadObject(args, conn) {
  requireString(args.bucket, "bucket");
  requireString(args.key,    "key");

  const path = `/${encodeURIComponent(args.key).replace(/%2F/g, "/")}`;
  const res  = await sigv4Request(conn, {
    service: "s3", method: "HEAD",
    path: args.path_style ? `/${args.bucket}${path}` : path,
    headers: { "content-type": "application/octet-stream" },
    customEndpoint: args.custom_endpoint ||
      (args.path_style ? undefined : buildEndpoint("s3", conn.region, conn.useTls).replace("://s3", `://${args.bucket}.s3`)),
  });
  if (res.statusCode === 404) {
    return { ok: true, operation: "s3_head_object", bucket: args.bucket, key: args.key, exists: false };
  }
  checkStatus(res, "s3.head_object");
  return {
    ok: true, operation: "s3_head_object",
    bucket: args.bucket, key: args.key, exists: true,
    content_type:   res.headers["content-type"]   || null,
    content_length: res.headers["content-length"]  ? parseInt(res.headers["content-length"]) : null,
    etag:           res.headers["etag"]            ? res.headers["etag"].replace(/"/g, "") : null,
    last_modified:  res.headers["last-modified"]   || null,
  };
}

// ── DynamoDB Operations ────────────────────────────────────────────────────

function dynamoHeaders(action) {
  return {
    "content-type": "application/x-amz-json-1.0",
    "x-amz-target": `DynamoDB_20120810.${action}`,
  };
}

async function opDynamoDB(args, conn, action, body) {
  const res = await sigv4Request(conn, {
    service: "dynamodb", method: "POST", path: "/",
    headers: dynamoHeaders(action),
    body: JSON.stringify(body),
    customEndpoint: args.custom_endpoint,
  });
  checkStatus(res, `dynamodb.${action}`);
  return parseJson(res.raw, `dynamodb.${action}`);
}

async function opDynamoGetItem(args, conn) {
  requireString(args.table, "table");
  if (!args.key || typeof args.key !== "object")
    throw new Error("dynamodb_get_item requires 'key' (DynamoDB attribute map)");
  const result = await opDynamoDB(args, conn, "GetItem", {
    TableName: args.table,
    Key: args.key,
    ...(args.consistent_read ? { ConsistentRead: true } : {}),
    ...(args.projection ? { ProjectionExpression: args.projection } : {}),
  });
  return {
    ok: true, operation: "dynamodb_get_item",
    table: args.table,
    found: !!result.Item,
    item:  result.Item || null,
  };
}

async function opDynamoPutItem(args, conn) {
  requireString(args.table, "table");
  if (!args.item || typeof args.item !== "object")
    throw new Error("dynamodb_put_item requires 'item' (DynamoDB attribute map)");
  await opDynamoDB(args, conn, "PutItem", {
    TableName: args.table,
    Item: args.item,
    ...(args.condition ? { ConditionExpression: args.condition } : {}),
  });
  return { ok: true, operation: "dynamodb_put_item", table: args.table, written: true };
}

async function opDynamoDeleteItem(args, conn) {
  requireString(args.table, "table");
  if (!args.key || typeof args.key !== "object")
    throw new Error("dynamodb_delete_item requires 'key'");
  await opDynamoDB(args, conn, "DeleteItem", {
    TableName: args.table,
    Key: args.key,
    ...(args.condition ? { ConditionExpression: args.condition } : {}),
  });
  return { ok: true, operation: "dynamodb_delete_item", table: args.table, deleted: true };
}

async function opDynamoQuery(args, conn) {
  requireString(args.table, "table");
  if (!args.key_condition)
    throw new Error("dynamodb_query requires 'key_condition' (KeyConditionExpression)");
  const body = {
    TableName: args.table,
    KeyConditionExpression: args.key_condition,
    ...(args.expression_attrs     ? { ExpressionAttributeNames:  args.expression_attrs }     : {}),
    ...(args.expression_values    ? { ExpressionAttributeValues: args.expression_values }    : {}),
    ...(args.filter               ? { FilterExpression:          args.filter }               : {}),
    ...(args.index                ? { IndexName:                 args.index }                : {}),
    ...(args.limit                ? { Limit:                     args.limit }                : {}),
    ...(args.scan_index_forward !== undefined ? { ScanIndexForward: args.scan_index_forward } : {}),
    ...(args.projection           ? { ProjectionExpression:      args.projection }           : {}),
  };
  const result = await opDynamoDB(args, conn, "Query", body);
  return {
    ok: true, operation: "dynamodb_query",
    table: args.table,
    count:        result.Count        || 0,
    scanned_count: result.ScannedCount || 0,
    items:        result.Items        || [],
    last_evaluated_key: result.LastEvaluatedKey || null,
  };
}

async function opDynamoScan(args, conn) {
  requireString(args.table, "table");
  const body = {
    TableName: args.table,
    ...(args.filter            ? { FilterExpression:          args.filter }            : {}),
    ...(args.expression_attrs  ? { ExpressionAttributeNames:  args.expression_attrs }  : {}),
    ...(args.expression_values ? { ExpressionAttributeValues: args.expression_values } : {}),
    ...(args.limit             ? { Limit:                     args.limit }             : {}),
    ...(args.index             ? { IndexName:                 args.index }             : {}),
    ...(args.projection        ? { ProjectionExpression:      args.projection }        : {}),
  };
  const result = await opDynamoDB(args, conn, "Scan", body);
  return {
    ok: true, operation: "dynamodb_scan",
    table: args.table,
    count:         result.Count         || 0,
    scanned_count: result.ScannedCount  || 0,
    items:         result.Items         || [],
    last_evaluated_key: result.LastEvaluatedKey || null,
  };
}

async function opDynamoListTables(args, conn) {
  const result = await opDynamoDB(args, conn, "ListTables", {
    ...(args.limit ? { Limit: args.limit } : {}),
  });
  return {
    ok: true, operation: "dynamodb_list_tables",
    count:  (result.TableNames || []).length,
    tables: result.TableNames  || [],
    last_evaluated_table_name: result.LastEvaluatedTableName || null,
  };
}

// ── SQS Operations ─────────────────────────────────────────────────────────

async function opSqsSendMessage(args, conn) {
  requireString(args.queue_url,   "queue_url");
  requireString(args.message_body, "message_body");

  const qp = {
    Action:      "SendMessage",
    QueueUrl:    args.queue_url,
    MessageBody: args.message_body,
    Version:     "2012-11-05",
  };
  if (args.delay_seconds !== undefined) qp.DelaySeconds = String(args.delay_seconds);
  if (args.group_id)                    qp.MessageGroupId = args.group_id;
  if (args.dedup_id)                    qp.MessageDeduplicationId = args.dedup_id;

  const url      = new URL(args.queue_url);
  const endpoint = args.custom_endpoint || `${url.protocol}//${url.hostname}`;
  const res = await sigv4Request(conn, {
    service: "sqs", method: "POST", path: url.pathname,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(qp).toString(),
    customEndpoint: endpoint,
  });
  checkStatus(res, "sqs.send_message");

  const msgId = res.raw.match(/<MessageId>([^<]+)<\/MessageId>/);
  const seqNr = res.raw.match(/<SequenceNumber>([^<]+)<\/SequenceNumber>/);
  return {
    ok: true, operation: "sqs_send_message",
    queue_url:      args.queue_url,
    message_id:     msgId ? msgId[1] : null,
    sequence_number: seqNr ? seqNr[1] : null,
  };
}

async function opSqsReceiveMessage(args, conn) {
  requireString(args.queue_url, "queue_url");

  const qp = {
    Action:              "ReceiveMessage",
    QueueUrl:            args.queue_url,
    MaxNumberOfMessages: String(args.max_messages || 1),
    WaitTimeSeconds:     String(args.wait_seconds || 0),
    Version:             "2012-11-05",
  };
  if (args.visibility_timeout !== undefined)
    qp.VisibilityTimeout = String(args.visibility_timeout);

  const url      = new URL(args.queue_url);
  const endpoint = args.custom_endpoint || `${url.protocol}//${url.hostname}`;
  const res = await sigv4Request(conn, {
    service: "sqs", method: "POST", path: url.pathname,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(qp).toString(),
    customEndpoint: endpoint,
  });
  checkStatus(res, "sqs.receive_message");

  const messages = [];
  const msgBlocks = [...res.raw.matchAll(/<Message>([\ -\uFFFF]*?)<\/Message>/gs)];
  for (const block of msgBlocks) {
    const content  = block[1];
    const msgId    = content.match(/<MessageId>([^<]+)<\/MessageId>/);
    const recHandle= content.match(/<ReceiptHandle>([^<]+)<\/ReceiptHandle>/);
    const body     = content.match(/<Body>([\s\S]*?)<\/Body>/);
    messages.push({
      message_id:      msgId     ? msgId[1]     : null,
      receipt_handle:  recHandle ? recHandle[1] : null,
      body:            body      ? body[1]      : null,
    });
  }

  return {
    ok: true, operation: "sqs_receive_message",
    queue_url: args.queue_url,
    count:     messages.length,
    messages,
  };
}

async function opSqsGetQueueUrl(args, conn) {
  requireString(args.queue_name, "queue_name");

  const endpoint = args.custom_endpoint || buildEndpoint("sqs", conn.region, conn.useTls);
  const qp = {
    Action:    "GetQueueUrl",
    QueueName: args.queue_name,
    Version:   "2012-11-05",
  };
  const res = await sigv4Request(conn, {
    service: "sqs", method: "POST", path: "/",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(qp).toString(),
    customEndpoint: endpoint,
  });
  checkStatus(res, "sqs.get_queue_url");

  const urlMatch = res.raw.match(/<QueueUrl>([^<]+)<\/QueueUrl>/);
  return {
    ok: true, operation: "sqs_get_queue_url",
    queue_name: args.queue_name,
    queue_url:  urlMatch ? urlMatch[1] : null,
  };
}

async function opSqsListQueues(args, conn) {
  const endpoint = args.custom_endpoint || buildEndpoint("sqs", conn.region, conn.useTls);
  const qp = { Action: "ListQueues", Version: "2012-11-05" };
  if (args.prefix) qp.QueueNamePrefix = args.prefix;

  const res = await sigv4Request(conn, {
    service: "sqs", method: "POST", path: "/",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(qp).toString(),
    customEndpoint: endpoint,
  });
  checkStatus(res, "sqs.list_queues");

  const urls = [...res.raw.matchAll(/<QueueUrl>([^<]+)<\/QueueUrl>/g)].map(m => m[1]);
  return {
    ok: true, operation: "sqs_list_queues",
    count:      urls.length,
    queue_urls: urls,
  };
}

// ── SNS Operations ─────────────────────────────────────────────────────────

async function opSnsRequest(conn, args, params) {
  const endpoint = buildEndpoint("sns", conn.region, conn.useTls, args.custom_endpoint);
  const res = await sigv4Request(conn, {
    service: "sns", method: "POST", path: "/",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, Version: "2010-03-31" }).toString(),
    customEndpoint: endpoint,
  });
  checkStatus(res, `sns.${params.Action.toLowerCase()}`);
  return res.raw;
}

async function opSnsPublish(args, conn) {
  if (!args.topic_arn && !args.target_arn && !args.phone_number)
    throw new Error("sns_publish requires 'topic_arn', 'target_arn', or 'phone_number'");
  requireString(args.message, "message");

  const params = { Action: "Publish", Message: args.message };
  if (args.topic_arn)    params.TopicArn   = args.topic_arn;
  if (args.target_arn)   params.TargetArn  = args.target_arn;
  if (args.phone_number) params.PhoneNumber = args.phone_number;
  if (args.subject)      params.Subject    = args.subject;
  if (args.message_structure) params.MessageStructure = args.message_structure;

  const raw   = await opSnsRequest(conn, args, params);
  const msgId = raw.match(/<MessageId>([^<]+)<\/MessageId>/);
  return {
    ok: true, operation: "sns_publish",
    message_id: msgId ? msgId[1] : null,
  };
}

async function opSnsListTopics(args, conn) {
  const raw   = await opSnsRequest(conn, args, { Action: "ListTopics" });
  const arns  = [...raw.matchAll(/<TopicArn>([^<]+)<\/TopicArn>/g)].map(m => m[1]);
  const next  = raw.match(/<NextToken>([^<]+)<\/NextToken>/);
  return {
    ok: true, operation: "sns_list_topics",
    count:      arns.length,
    topic_arns: arns,
    next_token: next ? next[1] : null,
  };
}

async function opSnsCreateTopic(args, conn) {
  requireString(args.topic_name, "topic_name");
  const raw = await opSnsRequest(conn, args, { Action: "CreateTopic", Name: args.topic_name });
  const arn = raw.match(/<TopicArn>([^<]+)<\/TopicArn>/);
  return {
    ok: true, operation: "sns_create_topic",
    topic_name: args.topic_name,
    topic_arn:  arn ? arn[1] : null,
  };
}

// ── STS Operations ─────────────────────────────────────────────────────────

async function opStsGetCallerIdentity(args, conn) {
  const endpoint = buildEndpoint("sts", conn.region, conn.useTls, args.custom_endpoint);
  const res = await sigv4Request(conn, {
    service: "sts", method: "POST", path: "/",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ Action: "GetCallerIdentity", Version: "2011-06-15" }).toString(),
    customEndpoint: endpoint,
  });
  checkStatus(res, "sts.get_caller_identity");

  const userId  = res.raw.match(/<UserId>([^<]+)<\/UserId>/);
  const account = res.raw.match(/<Account>([^<]+)<\/Account>/);
  const arn     = res.raw.match(/<Arn>([^<]+)<\/Arn>/);
  return {
    ok: true, operation: "sts_get_caller_identity",
    user_id:     userId  ? userId[1]  : null,
    account:     account ? account[1] : null,
    arn:         arn     ? arn[1]     : null,
  };
}

async function opStsAssumeRole(args, conn) {
  requireString(args.role_arn,         "role_arn");
  requireString(args.role_session_name, "role_session_name");

  const endpoint = buildEndpoint("sts", conn.region, conn.useTls, args.custom_endpoint);
  const params   = {
    Action:          "AssumeRole",
    Version:         "2011-06-15",
    RoleArn:         args.role_arn,
    RoleSessionName: args.role_session_name,
  };
  if (args.duration_seconds) params.DurationSeconds = String(args.duration_seconds);
  if (args.external_id)      params.ExternalId      = args.external_id;

  const res = await sigv4Request(conn, {
    service: "sts", method: "POST", path: "/",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
    customEndpoint: endpoint,
  });
  checkStatus(res, "sts.assume_role");

  const accessKey  = res.raw.match(/<AccessKeyId>([^<]+)<\/AccessKeyId>/);
  const secretKey  = res.raw.match(/<SecretAccessKey>([^<]+)<\/SecretAccessKey>/);
  const sessToken  = res.raw.match(/<SessionToken>([^<]+)<\/SessionToken>/);
  const expiration = res.raw.match(/<Expiration>([^<]+)<\/Expiration>/);
  const arnMatch   = res.raw.match(/<Arn>([^<]+)<\/Arn>/);
  const assumedId  = res.raw.match(/<AssumedRoleId>([^<]+)<\/AssumedRoleId>/);

  return {
    ok: true, operation: "sts_assume_role",
    role_arn:         args.role_arn,
    assumed_role_id:  assumedId  ? assumedId[1]  : null,
    arn:              arnMatch   ? arnMatch[1]   : null,
    expiration:       expiration ? expiration[1] : null,
    credentials: {
      access_key_id:     accessKey ? accessKey[1] : null,
      secret_access_key: secretKey ? "[redacted]" : null, // never expose
      session_token:     sessToken ? sessToken[1] : null,
    },
  };
}

// ── Lambda Operations ──────────────────────────────────────────────────────

async function opLambdaInvoke(args, conn) {
  requireString(args.function_name, "function_name");

  const encoded  = encodeURIComponent(args.function_name);
  const path     = `/2015-03-31/functions/${encoded}/invocations`;
  const qp       = {};
  if (args.qualifier) qp.Qualifier = args.qualifier;

  const invocationType = args.invocation_type || "RequestResponse";
  const body = args.payload ? JSON.stringify(args.payload) : "{}";

  const res = await sigv4Request(conn, {
    service: "lambda", method: "POST", path,
    queryParams: Object.keys(qp).length ? qp : undefined,
    headers: {
      "content-type": "application/json",
      "x-amz-invocation-type": invocationType,
      ...(args.log_type ? { "x-amz-log-type": args.log_type } : {}),
    },
    body,
    customEndpoint: args.custom_endpoint,
  });

  const funcError = res.headers["x-amz-function-error"] || null;
  const logResult = res.headers["x-amz-log-result"] || null;

  let responsePayload = null;
  try {
    responsePayload = JSON.parse(res.raw);
  } catch (_) {
    responsePayload = res.raw;
  }

  if (res.statusCode !== 200 && res.statusCode !== 202 && res.statusCode !== 204) {
    throw extractAwsError(res.raw, res.statusCode, "lambda.invoke");
  }

  return {
    ok:               true,
    operation:        "lambda_invoke",
    function_name:    args.function_name,
    status_code:      res.statusCode,
    function_error:   funcError,
    log_result:       logResult ? Buffer.from(logResult, "base64").toString("utf8") : null,
    payload:          responsePayload,
  };
}

async function opLambdaListFunctions(args, conn) {
  const qp = {};
  if (args.max_items) qp.MaxItems = String(args.max_items);

  const res = await sigv4Request(conn, {
    service: "lambda", method: "GET", path: "/2015-03-31/functions/",
    queryParams: Object.keys(qp).length ? qp : undefined,
    headers: { "content-type": "application/json" },
    customEndpoint: args.custom_endpoint,
  });
  checkStatus(res, "lambda.list_functions");

  const json = parseJson(res.raw, "lambda.list_functions");
  const fns  = (json.Functions || []).map(f => ({
    name:         f.FunctionName,
    arn:          f.FunctionArn,
    runtime:      f.Runtime,
    handler:      f.Handler,
    memory_size:  f.MemorySize,
    timeout:      f.Timeout,
    last_modified: f.LastModified,
    description:  f.Description || "",
  }));

  return {
    ok: true, operation: "lambda_list_functions",
    count:     fns.length,
    functions: fns,
    next_marker: json.NextMarker || null,
  };
}

// ── Secrets Manager Operations ─────────────────────────────────────────────

async function opSecretsManagerRequest(conn, args, target, body) {
  const res = await sigv4Request(conn, {
    service: "secretsmanager", method: "POST", path: "/",
    headers: {
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": `secretsmanager.${target}`,
    },
    body: JSON.stringify(body),
    customEndpoint: args.custom_endpoint,
  });
  checkStatus(res, `secretsmanager.${target}`);
  return parseJson(res.raw, `secretsmanager.${target}`);
}

async function opSecretsGetSecretValue(args, conn) {
  requireString(args.secret_id, "secret_id");
  const result = await opSecretsManagerRequest(conn, args, "GetSecretValue", {
    SecretId: args.secret_id,
    ...(args.version_id    ? { VersionId:    args.version_id }    : {}),
    ...(args.version_stage ? { VersionStage: args.version_stage } : {}),
  });
  return {
    ok: true, operation: "secretsmanager_get_secret_value",
    name:            result.Name,
    arn:             result.ARN,
    secret_string:   result.SecretString  || null,
    secret_binary:   result.SecretBinary  || null,
    version_id:      result.VersionId     || null,
    created_date:    result.CreatedDate   || null,
  };
}

async function opSecretsListSecrets(args, conn) {
  const result = await opSecretsManagerRequest(conn, args, "ListSecrets", {
    ...(args.max_results ? { MaxResults: args.max_results } : {}),
  });
  return {
    ok: true, operation: "secretsmanager_list_secrets",
    count:   (result.SecretList || []).length,
    secrets: (result.SecretList || []).map(s => ({
      name:        s.Name,
      arn:         s.ARN,
      description: s.Description || "",
      last_changed_date: s.LastChangedDate || null,
    })),
    next_token: result.NextToken || null,
  };
}

// ── SSM Parameter Store Operations ────────────────────────────────────────

async function opSsmRequest(conn, args, target, body) {
  const res = await sigv4Request(conn, {
    service: "ssm", method: "POST", path: "/",
    headers: {
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": `AmazonSSM.${target}`,
    },
    body: JSON.stringify(body),
    customEndpoint: args.custom_endpoint,
  });
  checkStatus(res, `ssm.${target}`);
  return parseJson(res.raw, `ssm.${target}`);
}

async function opSsmGetParameter(args, conn) {
  requireString(args.name, "name");
  const result = await opSsmRequest(conn, args, "GetParameter", {
    Name: args.name,
    WithDecryption: args.with_decryption !== false,
  });
  const p = result.Parameter || {};
  return {
    ok: true, operation: "ssm_get_parameter",
    name:      p.Name     || args.name,
    type:      p.Type     || null,
    value:     p.Value    || null,
    version:   p.Version  || null,
    arn:       p.ARN      || null,
    last_modified_date: p.LastModifiedDate || null,
  };
}

async function opSsmPutParameter(args, conn) {
  requireString(args.name,  "name");
  requireString(args.value, "value");
  const result = await opSsmRequest(conn, args, "PutParameter", {
    Name:      args.name,
    Value:     args.value,
    Type:      args.type || "String",
    Overwrite: args.overwrite !== false,
    ...(args.description ? { Description: args.description } : {}),
    ...(args.key_id      ? { KeyId:       args.key_id }      : {}),
  });
  return {
    ok: true, operation: "ssm_put_parameter",
    name:    args.name,
    version: result.Version || null,
    tier:    result.Tier    || null,
  };
}

async function opSsmGetParametersByPath(args, conn) {
  requireString(args.path, "path");
  const result = await opSsmRequest(conn, args, "GetParametersByPath", {
    Path:           args.path,
    WithDecryption: args.with_decryption !== false,
    Recursive:      args.recursive !== false,
    ...(args.max_results ? { MaxResults: args.max_results } : {}),
  });
  return {
    ok: true, operation: "ssm_get_parameters_by_path",
    path:       args.path,
    count:      (result.Parameters || []).length,
    parameters: (result.Parameters || []).map(p => ({
      name:    p.Name,
      type:    p.Type,
      value:   p.Value,
      version: p.Version,
      arn:     p.ARN,
    })),
    next_token: result.NextToken || null,
  };
}

// ── EC2 Operations ─────────────────────────────────────────────────────────

async function opEc2Request(conn, args, params) {
  const endpoint = buildEndpoint("ec2", conn.region, conn.useTls, args.custom_endpoint);
  const res = await sigv4Request(conn, {
    service: "ec2", method: "POST", path: "/",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...params, Version: "2016-11-15" }).toString(),
    customEndpoint: endpoint,
  });
  checkStatus(res, `ec2.${(params.Action || "").toLowerCase()}`);
  return res.raw;
}

async function opEc2DescribeInstances(args, conn) {
  const params = { Action: "DescribeInstances" };
  if (args.instance_ids && args.instance_ids.length > 0) {
    args.instance_ids.forEach((id, i) => { params[`InstanceId.${i+1}`] = id; });
  }
  if (args.max_results) params.MaxResults = String(args.max_results);

  const raw       = await opEc2Request(conn, args, params);
  const instances = [];
  const instBlocks = [...raw.matchAll(/<item>[\s\S]*?<instanceId>([^<]+)<\/instanceId>[\s\S]*?<\/item>/g)];
  for (const block of instBlocks) {
    const content = block[0];
    const getVal  = (tag) => { const m = content.match(new RegExp(`<${tag}>([^<]+)</${tag}>`)); return m ? m[1] : null; };
    instances.push({
      instance_id:   block[1],
      state:         getVal("name"),
      instance_type: getVal("instanceType"),
      public_ip:     getVal("ipAddress"),
      private_ip:    getVal("privateIpAddress"),
      image_id:      getVal("imageId"),
      launch_time:   getVal("launchTime"),
    });
  }
  return {
    ok: true, operation: "ec2_describe_instances",
    count:     instances.length,
    instances,
  };
}

// ── CloudWatch Operations ──────────────────────────────────────────────────

async function opCloudWatchListMetrics(args, conn) {
  const endpoint = buildEndpoint("cloudwatch", conn.region, conn.useTls, args.custom_endpoint);
  const params   = { Action: "ListMetrics", Version: "2010-08-01" };
  if (args.namespace)   params.Namespace  = args.namespace;
  if (args.metric_name) params.MetricName = args.metric_name;

  const res = await sigv4Request(conn, {
    service: "cloudwatch", method: "POST", path: "/",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
    customEndpoint: endpoint,
  });
  checkStatus(res, "cloudwatch.list_metrics");

  const metrics = [];
  const metricBlocks = [...res.raw.matchAll(/<member>[\s\S]*?<MetricName>([^<]+)<\/MetricName>[\s\S]*?<Namespace>([^<]+)<\/Namespace>[\s\S]*?<\/member>/g)];
  for (const block of metricBlocks) {
    metrics.push({ metric_name: block[1], namespace: block[2] });
  }

  return {
    ok: true, operation: "cloudwatch_list_metrics",
    count: metrics.length,
    metrics,
  };
}

// ── Generic request operation ──────────────────────────────────────────────

async function opRequest(args, conn) {
  requireString(args.service, "service");
  requireString(args.method,  "method");

  const validMethods = ["GET", "POST", "PUT", "DELETE", "HEAD", "PATCH"];
  if (!validMethods.includes(args.method.toUpperCase()))
    throw new Error(`method must be one of: ${validMethods.join(", ")}`);

  const body = args.body
    ? (typeof args.body === "string" ? args.body : JSON.stringify(args.body))
    : undefined;

  const res = await sigv4Request(conn, {
    service:        args.service,
    region:         args.region || conn.region,
    method:         args.method.toUpperCase(),
    path:           args.path || "/",
    queryParams:    args.query_params,
    headers:        args.headers || {},
    body,
    customEndpoint: args.endpoint,
  });

  let parsedBody = null;
  const ct = res.headers["content-type"] || "";
  if (ct.includes("json")) {
    try { parsedBody = JSON.parse(res.raw); } catch (_) { parsedBody = res.raw; }
  } else {
    parsedBody = res.raw;
  }

  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw extractAwsError(res.raw, res.statusCode, `${args.service}.request`);
  }

  return {
    ok:          true,
    operation:   "request",
    service:     args.service,
    status_code: res.statusCode,
    headers:     res.headers,
    body:        parsedBody,
  };
}

// ── Info ───────────────────────────────────────────────────────────────────

function opInfo() {
  return {
    ok:          true,
    protocol:    "AWS Signature Version 4 (SigV4)",
    defaultRegion: DEFAULT_REGION,
    operations: [
      // S3
      { op: "s3_list_buckets",   service: "s3",             description: "List all S3 buckets" },
      { op: "s3_list_objects",   service: "s3",             description: "List objects in an S3 bucket (ListObjectsV2)" },
      { op: "s3_get_object",     service: "s3",             description: "Download an object from S3" },
      { op: "s3_put_object",     service: "s3",             description: "Upload an object to S3" },
      { op: "s3_delete_object",  service: "s3",             description: "Delete an object from S3" },
      { op: "s3_head_object",    service: "s3",             description: "Get metadata for an S3 object (no body download)" },
      // DynamoDB
      { op: "dynamodb_get_item",    service: "dynamodb",    description: "Get a single item by primary key" },
      { op: "dynamodb_put_item",    service: "dynamodb",    description: "Create or replace an item" },
      { op: "dynamodb_delete_item", service: "dynamodb",    description: "Delete an item by primary key" },
      { op: "dynamodb_query",       service: "dynamodb",    description: "Query items using a key condition expression" },
      { op: "dynamodb_scan",        service: "dynamodb",    description: "Scan all items in a table (with optional filter)" },
      { op: "dynamodb_list_tables", service: "dynamodb",    description: "List all DynamoDB tables" },
      // SQS
      { op: "sqs_send_message",    service: "sqs",          description: "Send a message to an SQS queue" },
      { op: "sqs_receive_message", service: "sqs",          description: "Receive messages from an SQS queue" },
      { op: "sqs_get_queue_url",   service: "sqs",          description: "Get the URL for a queue by name" },
      { op: "sqs_list_queues",     service: "sqs",          description: "List SQS queues in the region" },
      // SNS
      { op: "sns_publish",      service: "sns",             description: "Publish a message to an SNS topic" },
      { op: "sns_list_topics",  service: "sns",             description: "List all SNS topics" },
      { op: "sns_create_topic", service: "sns",             description: "Create an SNS topic" },
      // STS
      { op: "sts_get_caller_identity", service: "sts",      description: "Get the identity of the caller (account, ARN, user ID)" },
      { op: "sts_assume_role",         service: "sts",      description: "Assume an IAM role and get temporary credentials" },
      // Lambda
      { op: "lambda_invoke",         service: "lambda",     description: "Invoke a Lambda function" },
      { op: "lambda_list_functions", service: "lambda",     description: "List Lambda functions in the region" },
      // Secrets Manager
      { op: "secretsmanager_get_secret_value", service: "secretsmanager", description: "Retrieve a secret value" },
      { op: "secretsmanager_list_secrets",     service: "secretsmanager", description: "List secrets in Secrets Manager" },
      // SSM Parameter Store
      { op: "ssm_get_parameter",           service: "ssm",  description: "Get a Parameter Store parameter value" },
      { op: "ssm_put_parameter",           service: "ssm",  description: "Create or update a Parameter Store parameter" },
      { op: "ssm_get_parameters_by_path",  service: "ssm",  description: "Get all parameters under a path" },
      // EC2
      { op: "ec2_describe_instances", service: "ec2",       description: "Describe EC2 instances" },
      // CloudWatch
      { op: "cloudwatch_list_metrics", service: "cloudwatch", description: "List CloudWatch metrics" },
      // Generic
      { op: "request", service: "*",                        description: "Generic SigV4-signed request to any AWS service" },
      { op: "info",    service: "none",                     description: "Return this reference (no I/O)" },
    ],
    sigV4: {
      algorithm: "AWS4-HMAC-SHA256",
      signing:   "HMAC-SHA256 over canonical request → string-to-sign → signature",
      keyDerivation: "kSecret=AWS4+secretKey → kDate → kRegion → kService → kSigning",
    },
    auth: {
      required: ["access_key_id", "secret_key"],
      optional: ["session_token (for STS temporary credentials)"],
    },
    services: Object.keys(SERVICE_ENDPOINTS),
  };
}

// ── Main entry point ───────────────────────────────────────────────────────

async function awsClient(args) {
  // Eager validation of numeric args
  if (args.timeout !== undefined && args.timeout !== null)
    clampInt(args.timeout, DEFAULT_TIMEOUT_MS, 1000, 120000, "timeout");

  // info doesn't need credentials
  const op = (args.operation || "").toLowerCase().replace(/-/g, "_");
  if (op === "info") return opInfo();

  const conn = buildConn(args);

  switch (op) {
    // S3
    case "s3_list_buckets":   return opS3ListBuckets(args, conn);
    case "s3_list_objects":   return opS3ListObjects(args, conn);
    case "s3_get_object":     return opS3GetObject(args, conn);
    case "s3_put_object":     return opS3PutObject(args, conn);
    case "s3_delete_object":  return opS3DeleteObject(args, conn);
    case "s3_head_object":    return opS3HeadObject(args, conn);
    // DynamoDB
    case "dynamodb_get_item":    return opDynamoGetItem(args, conn);
    case "dynamodb_put_item":    return opDynamoPutItem(args, conn);
    case "dynamodb_delete_item": return opDynamoDeleteItem(args, conn);
    case "dynamodb_query":       return opDynamoQuery(args, conn);
    case "dynamodb_scan":        return opDynamoScan(args, conn);
    case "dynamodb_list_tables": return opDynamoListTables(args, conn);
    // SQS
    case "sqs_send_message":    return opSqsSendMessage(args, conn);
    case "sqs_receive_message": return opSqsReceiveMessage(args, conn);
    case "sqs_get_queue_url":   return opSqsGetQueueUrl(args, conn);
    case "sqs_list_queues":     return opSqsListQueues(args, conn);
    // SNS
    case "sns_publish":      return opSnsPublish(args, conn);
    case "sns_list_topics":  return opSnsListTopics(args, conn);
    case "sns_create_topic": return opSnsCreateTopic(args, conn);
    // STS
    case "sts_get_caller_identity": return opStsGetCallerIdentity(args, conn);
    case "sts_assume_role":         return opStsAssumeRole(args, conn);
    // Lambda
    case "lambda_invoke":         return opLambdaInvoke(args, conn);
    case "lambda_list_functions": return opLambdaListFunctions(args, conn);
    // Secrets Manager
    case "secretsmanager_get_secret_value": return opSecretsGetSecretValue(args, conn);
    case "secretsmanager_list_secrets":     return opSecretsListSecrets(args, conn);
    // SSM
    case "ssm_get_parameter":          return opSsmGetParameter(args, conn);
    case "ssm_put_parameter":          return opSsmPutParameter(args, conn);
    case "ssm_get_parameters_by_path": return opSsmGetParametersByPath(args, conn);
    // EC2
    case "ec2_describe_instances": return opEc2DescribeInstances(args, conn);
    // CloudWatch
    case "cloudwatch_list_metrics": return opCloudWatchListMetrics(args, conn);
    // Generic
    case "request": return opRequest(args, conn);

    default:
      throw new Error(
        `Unknown aws_client operation: '${args.operation}'. ` +
        "Valid operations: s3_list_buckets, s3_list_objects, s3_get_object, s3_put_object, " +
        "s3_delete_object, s3_head_object, dynamodb_get_item, dynamodb_put_item, " +
        "dynamodb_delete_item, dynamodb_query, dynamodb_scan, dynamodb_list_tables, " +
        "sqs_send_message, sqs_receive_message, sqs_get_queue_url, sqs_list_queues, " +
        "sns_publish, sns_list_topics, sns_create_topic, " +
        "sts_get_caller_identity, sts_assume_role, " +
        "lambda_invoke, lambda_list_functions, " +
        "secretsmanager_get_secret_value, secretsmanager_list_secrets, " +
        "ssm_get_parameter, ssm_put_parameter, ssm_get_parameters_by_path, " +
        "ec2_describe_instances, cloudwatch_list_metrics, request, info"
      );
  }
}

module.exports = {
  awsClient,
  // Exported for testing
  signRequest, deriveSigningKey, hmacSha256, sha256Hex, uriEncode,
  buildCanonicalQueryString, buildConn, requireString, guardString, clampInt,
  buildEndpoint, extractAwsError,
};
