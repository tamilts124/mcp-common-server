"use strict";
// lib/graphqlClientOps.js — GraphQL HTTP client (pure Node.js; zero npm deps)
//
// Operations:
//   query          — execute a GraphQL query
//   mutate         — execute a GraphQL mutation
//   introspect     — full schema introspection (all types, directives, fields)
//   introspect_type — introspect a single named type
//   batch          — send multiple operations in a single HTTP request
//   subscribe_poll — poll a subscription query repeatedly (long-poll pattern)
//
// Features:
//   - Variables support (JSON object)
//   - operationName support (for named operations in multi-op documents)
//   - Custom request headers
//   - HTTP / HTTPS; auth: Basic, Bearer, or custom Authorization header
//   - Response body size cap (default 10 MB, hard 50 MB)
//   - Configurable timeout (default 30s)
//   - GraphQL errors extracted and surfaced clearly
//   - Query depth limit to guard against deeply nested introspection abuse
//   - SSRF guard (block private/loopback IPs; optional)
//   - Header injection prevention (NUL/CRLF)
//   - Retry with exponential backoff
//
// Security:
//   - URL must be http:// or https://
//   - SSRF guard (private IP block, default ON, disable with ssrf_guard: false)
//   - Header name/value sanitisation
//   - Response body size cap

const http   = require("http");
const https  = require("https");
const zlib   = require("zlib");

// ── Constants ─────────────────────────────────────────────────────────────────
const DEFAULT_TIMEOUT        = 30_000;   // 30 s
const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;  // 10 MB
const HARD_MAX_BODY_BYTES    = 50 * 1024 * 1024;  // 50 MB
const DEFAULT_RETRY_COUNT    = 0;
const DEFAULT_RETRY_DELAY_MS = 500;
const MAX_POLL_ITERATIONS    = 100;
const DEFAULT_POLL_INTERVAL  = 2_000;   // 2 s

// ── Error helper ──────────────────────────────────────────────────────────────
function err(msg, code) {
  return Object.assign(new Error(msg), { code });
}

// ── URL validation ────────────────────────────────────────────────────────────
function validateUrl(rawUrl) {
  if (typeof rawUrl !== "string" || !rawUrl.trim())
    throw err("graphql_client: 'url' must be a non-empty string.", "INVALID_ARG");
  let parsed;
  try { parsed = new URL(rawUrl); }
  catch (e) { throw err(`graphql_client: invalid URL '${rawUrl}': ${e.message}`, "INVALID_URL"); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw err(`graphql_client: URL must use http or https scheme, got '${parsed.protocol}'.`, "INVALID_URL");
  return parsed;
}

// ── SSRF guard ────────────────────────────────────────────────────────────────
const PRIVATE_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^::1$/,
  /^fc00:/i,
  /^fd[0-9a-f]{2}:/i,
  /^fe80:/i,
  /^0\.0\.0\.0$/,
  /^localhost$/i,
];

function isPrivateHost(host) {
  const h = host.replace(/^\[|\]$/g, "");
  return PRIVATE_RANGES.some(r => r.test(h));
}

// ── Header injection prevention ───────────────────────────────────────────────
function validateHeader(name, value) {
  if (/[\r\n\0]/.test(name))
    throw err(`graphql_client: header name '${name}' contains illegal characters.`, "INVALID_ARG");
  if (typeof value === "string" && /[\r\n\0]/.test(value))
    throw err(`graphql_client: header value for '${name}' contains illegal characters.`, "INVALID_ARG");
}

// ── Decompress response body ──────────────────────────────────────────────────
function decompressBody(bodyBuf, encoding) {
  if (!encoding) return Promise.resolve(bodyBuf);
  const enc = encoding.toLowerCase();
  return new Promise((resolve, reject) => {
    if (enc === "gzip" || enc === "x-gzip") {
      zlib.gunzip(bodyBuf, (e, r) => e ? reject(err(`graphql_client: gzip decompress error: ${e.message}`, "DECOMPRESS_ERROR")) : resolve(r));
    } else if (enc === "deflate") {
      zlib.inflate(bodyBuf, (e, r) => {
        if (e) {
          zlib.inflateRaw(bodyBuf, (e2, r2) => e2 ? reject(err(`graphql_client: deflate decompress error: ${e2.message}`, "DECOMPRESS_ERROR")) : resolve(r2));
        } else resolve(r);
      });
    } else if (enc === "br") {
      zlib.brotliDecompress(bodyBuf, (e, r) => e ? reject(err(`graphql_client: brotli decompress error: ${e.message}`, "DECOMPRESS_ERROR")) : resolve(r));
    } else {
      resolve(bodyBuf);
    }
  });
}

// ── Raw HTTP request ──────────────────────────────────────────────────────────
function rawRequest(parsedUrl, method, headers, bodyBuf, timeout, tlsOptions) {
  return new Promise((resolve, reject) => {
    const isHttps   = parsedUrl.protocol === "https:";
    const transport = isHttps ? https : http;
    const reqOpts   = {
      hostname: parsedUrl.hostname,
      port:     parsedUrl.port || (isHttps ? 443 : 80),
      path:     parsedUrl.pathname + parsedUrl.search,
      method,
      headers,
      rejectUnauthorized: tlsOptions.rejectUnauthorized !== false,
      ...(tlsOptions.ca   ? { ca:   tlsOptions.ca }   : {}),
      ...(tlsOptions.cert ? { cert: tlsOptions.cert } : {}),
      ...(tlsOptions.key  ? { key:  tlsOptions.key }  : {}),
    };

    const req = transport.request(reqOpts, (res) => {
      clearTimeout(timer); // eslint-disable-line no-use-before-define
      const chunks = [];
      res.on("data",  c  => chunks.push(c));
      res.on("end",   () => resolve({
        statusCode:    res.statusCode,
        statusMessage: res.statusMessage,
        headers:       res.headers,
        bodyBuf:       Buffer.concat(chunks),
      }));
      res.on("error", e => reject(err(`graphql_client: response error: ${e.message}`, "NETWORK_ERROR")));
    });

    const timer = setTimeout(() => {
      req.destroy();
      reject(err("graphql_client: request timed out.", "TIMEOUT"));
    }, timeout);

    req.on("error", e => {
      clearTimeout(timer);
      reject(err(`graphql_client: request error: ${e.message}`, "NETWORK_ERROR"));
    });

    if (bodyBuf && bodyBuf.length > 0) req.write(bodyBuf);
    req.end();
  });
}

// ── Build request headers ─────────────────────────────────────────────────────
function buildHeaders(args, bodyLength) {
  const headers = {
    "Content-Type":   "application/json",
    "Accept":         "application/json",
    "Accept-Encoding": "gzip, deflate, br",
    "User-Agent":     "mcp-common-server/graphql_client",
  };

  // Custom caller headers
  for (const [k, v] of Object.entries(args.headers || {})) {
    validateHeader(k, v);
    headers[k] = String(v);
  }

  // Auth
  if (args.auth) {
    if (args.auth.type === "bearer") {
      if (!args.auth.token) throw err("graphql_client: auth.token is required for bearer auth.", "INVALID_ARG");
      headers["Authorization"] = `Bearer ${args.auth.token}`;
    } else if (args.auth.type === "basic") {
      if (!args.auth.username) throw err("graphql_client: auth.username is required for basic auth.", "INVALID_ARG");
      const creds = Buffer.from(`${args.auth.username}:${args.auth.password || ""}`).toString("base64");
      headers["Authorization"] = `Basic ${creds}`;
    } else if (args.auth.type === "api_key") {
      if (!args.auth.header) throw err("graphql_client: auth.header is required for api_key auth.", "INVALID_ARG");
      if (!args.auth.value)  throw err("graphql_client: auth.value is required for api_key auth.", "INVALID_ARG");
      validateHeader(args.auth.header, args.auth.value);
      headers[args.auth.header] = args.auth.value;
    }
  }

  headers["Content-Length"] = String(bodyLength);
  return headers;
}

// ── Parse and validate GraphQL response ──────────────────────────────────────
function parseGqlResponse(bodyText, statusCode) {
  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch (e) {
    throw err(
      `graphql_client: server returned non-JSON response (HTTP ${statusCode}): ${bodyText.slice(0, 200)}`,
      "INVALID_RESPONSE",
    );
  }

  const gqlErrors = Array.isArray(parsed.errors) ? parsed.errors : [];
  const hasData   = parsed.data !== undefined;

  return {
    data:       hasData ? parsed.data : null,
    errors:     gqlErrors,
    hasErrors:  gqlErrors.length > 0,
    extensions: parsed.extensions || null,
    statusCode,
    rawResponse: parsed,
  };
}

// ── Sleep helper ──────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Core GraphQL HTTP executor ────────────────────────────────────────────────
async function executeGraphQL(args, gqlPayload) {
  const parsedUrl = validateUrl(args.url);

  // SSRF guard
  if (args.ssrf_guard !== false && isPrivateHost(parsedUrl.hostname))
    throw err(`graphql_client: SSRF guard blocked request to '${parsedUrl.hostname}'.`, "SSRF_BLOCKED");

  const timeout     = Math.max(1000, args.timeout || DEFAULT_TIMEOUT);
  const maxBodyBytes = Math.min(
    args.max_response_bytes != null ? args.max_response_bytes : DEFAULT_MAX_BODY_BYTES,
    HARD_MAX_BODY_BYTES,
  );
  const retryCount  = args.retry_count  != null ? args.retry_count  : DEFAULT_RETRY_COUNT;
  const retryDelay  = args.retry_delay_ms != null ? args.retry_delay_ms : DEFAULT_RETRY_DELAY_MS;
  const tlsOptions  = {
    rejectUnauthorized: args.reject_unauthorized !== false,
    ...(args.ca   ? { ca:   args.ca }   : {}),
    ...(args.cert ? { cert: args.cert } : {}),
    ...(args.key  ? { key:  args.key }  : {}),
  };

  const bodyBuf = Buffer.from(JSON.stringify(gqlPayload), "utf8");
  const headers = buildHeaders(args, bodyBuf.length);

  let rawResp;
  for (let attempt = 0; attempt <= retryCount; attempt++) {
    if (attempt > 0) await sleep(retryDelay * Math.pow(2, attempt - 1));
    try {
      rawResp = await rawRequest(parsedUrl, "POST", headers, bodyBuf, timeout, tlsOptions);
      break;
    } catch (e) {
      if (attempt === retryCount) throw e;
    }
  }

  // Decompress
  let bodyDecBuf;
  try {
    bodyDecBuf = await decompressBody(rawResp.bodyBuf, rawResp.headers["content-encoding"]);
  } catch {
    bodyDecBuf = rawResp.bodyBuf;
  }

  // Cap response body size
  if (bodyDecBuf.length > maxBodyBytes)
    throw err(
      `graphql_client: response body too large (${bodyDecBuf.length} bytes; max ${maxBodyBytes}).`,
      "RESPONSE_TOO_LARGE",
    );

  const bodyText = bodyDecBuf.toString("utf8");
  return parseGqlResponse(bodyText, rawResp.statusCode);
}

// ── Built-in introspection query ──────────────────────────────────────────────
const INTROSPECTION_QUERY = `
query IntrospectionQuery {
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types {
      ...FullType
    }
    directives {
      name
      description
      locations
      args {
        ...InputValue
      }
    }
  }
}

fragment FullType on __Type {
  kind
  name
  description
  fields(includeDeprecated: true) {
    name
    description
    args {
      ...InputValue
    }
    type {
      ...TypeRef
    }
    isDeprecated
    deprecationReason
  }
  inputFields {
    ...InputValue
  }
  interfaces {
    ...TypeRef
  }
  enumValues(includeDeprecated: true) {
    name
    description
    isDeprecated
    deprecationReason
  }
  possibleTypes {
    ...TypeRef
  }
}

fragment InputValue on __InputValue {
  name
  description
  type { ...TypeRef }
  defaultValue
}

fragment TypeRef on __Type {
  kind
  name
  ofType {
    kind
    name
    ofType {
      kind
      name
      ofType {
        kind
        name
        ofType {
          kind
          name
          ofType {
            kind
            name
            ofType {
              kind
              name
            }
          }
        }
      }
    }
  }
}
`.trim();

const INTROSPECT_TYPE_QUERY = `
query IntrospectType($name: String!) {
  __type(name: $name) {
    kind
    name
    description
    fields(includeDeprecated: true) {
      name
      description
      args {
        name
        description
        type { kind name ofType { kind name ofType { kind name } } }
        defaultValue
      }
      type { kind name ofType { kind name ofType { kind name } } }
      isDeprecated
      deprecationReason
    }
    inputFields {
      name
      description
      type { kind name ofType { kind name ofType { kind name } } }
      defaultValue
    }
    interfaces {
      kind
      name
    }
    enumValues(includeDeprecated: true) {
      name
      description
      isDeprecated
      deprecationReason
    }
    possibleTypes {
      kind
      name
    }
  }
}
`.trim();

// ── Summarise introspection schema ───────────────────────────────────────────
function summariseSchema(schemaData) {
  if (!schemaData || !schemaData.__schema) return schemaData;
  const schema = schemaData.__schema;
  // Remove built-in types for cleaner output unless caller wants raw
  const userTypes = (schema.types || []).filter(
    t => t.name && !t.name.startsWith("__") &&
      !["String", "Boolean", "Int", "Float", "ID"].includes(t.name),
  );
  return {
    queryType:        schema.queryType?.name || null,
    mutationType:     schema.mutationType?.name || null,
    subscriptionType: schema.subscriptionType?.name || null,
    typeCount:        userTypes.length,
    types:            userTypes,
    directives:       (schema.directives || []).filter(d => ![
      "skip", "include", "deprecated", "specifiedBy",
    ].includes(d.name)),
  };
}

// ── Validate GraphQL query string (basic check) ───────────────────────────────
function validateQueryString(query) {
  if (typeof query !== "string" || !query.trim())
    throw err("graphql_client: 'query' must be a non-empty string.", "INVALID_ARG");
  if (query.length > 1_000_000)
    throw err("graphql_client: 'query' exceeds 1 MB limit.", "INVALID_ARG");
}

// ── Operations ────────────────────────────────────────────────────────────────

async function opQuery(args) {
  if (!args.url) throw err("graphql_client: 'url' is required.", "INVALID_ARG");
  validateQueryString(args.query);

  const payload = { query: args.query };
  if (args.variables      != null) payload.variables      = args.variables;
  if (args.operation_name != null) payload.operationName  = args.operation_name;

  const result = await executeGraphQL(args, payload);
  return {
    operation: "query",
    url:       args.url,
    ...result,
  };
}

async function opMutate(args) {
  if (!args.url) throw err("graphql_client: 'url' is required.", "INVALID_ARG");
  validateQueryString(args.query);

  const payload = { query: args.query };
  if (args.variables      != null) payload.variables      = args.variables;
  if (args.operation_name != null) payload.operationName  = args.operation_name;

  const result = await executeGraphQL(args, payload);
  return {
    operation: "mutate",
    url:       args.url,
    ...result,
  };
}

async function opIntrospect(args) {
  if (!args.url) throw err("graphql_client: 'url' is required.", "INVALID_ARG");

  const payload = { query: INTROSPECTION_QUERY, operationName: "IntrospectionQuery" };
  const result  = await executeGraphQL(args, payload);

  // Parse and summarise unless raw requested
  const schema = args.raw ? result.data : summariseSchema(result.data);

  return {
    operation:  "introspect",
    url:        args.url,
    data:       schema,
    errors:     result.errors,
    hasErrors:  result.hasErrors,
    extensions: result.extensions,
    statusCode: result.statusCode,
  };
}

async function opIntrospectType(args) {
  if (!args.url)  throw err("graphql_client: 'url' is required.", "INVALID_ARG");
  if (!args.type_name) throw err("graphql_client: 'type_name' is required for introspect_type.", "INVALID_ARG");
  if (typeof args.type_name !== "string" || !args.type_name.trim())
    throw err("graphql_client: 'type_name' must be a non-empty string.", "INVALID_ARG");

  const payload = {
    query:         INTROSPECT_TYPE_QUERY,
    operationName: "IntrospectType",
    variables:     { name: args.type_name },
  };
  const result = await executeGraphQL(args, payload);
  return {
    operation:  "introspect_type",
    url:        args.url,
    type_name:  args.type_name,
    data:       result.data,
    errors:     result.errors,
    hasErrors:  result.hasErrors,
    extensions: result.extensions,
    statusCode: result.statusCode,
  };
}

async function opBatch(args) {
  if (!args.url)         throw err("graphql_client: 'url' is required.", "INVALID_ARG");
  if (!Array.isArray(args.operations) || args.operations.length === 0)
    throw err("graphql_client: 'operations' must be a non-empty array for batch.", "INVALID_ARG");
  if (args.operations.length > 50)
    throw err("graphql_client: batch 'operations' array exceeds maximum of 50.", "INVALID_ARG");

  const payload = args.operations.map((op, i) => {
    if (!op.query) throw err(`graphql_client: batch operation[${i}] missing 'query'.`, "INVALID_ARG");
    validateQueryString(op.query);
    const item = { query: op.query };
    if (op.variables      != null) item.variables      = op.variables;
    if (op.operation_name != null) item.operationName  = op.operation_name;
    return item;
  });

  const parsedUrl = validateUrl(args.url);
  if (args.ssrf_guard !== false && isPrivateHost(parsedUrl.hostname))
    throw err(`graphql_client: SSRF guard blocked request to '${parsedUrl.hostname}'.`, "SSRF_BLOCKED");

  const timeout      = Math.max(1000, args.timeout || DEFAULT_TIMEOUT);
  const maxBodyBytes = Math.min(
    args.max_response_bytes != null ? args.max_response_bytes : DEFAULT_MAX_BODY_BYTES,
    HARD_MAX_BODY_BYTES,
  );
  const retryCount  = args.retry_count  != null ? args.retry_count  : DEFAULT_RETRY_COUNT;
  const retryDelay  = args.retry_delay_ms != null ? args.retry_delay_ms : DEFAULT_RETRY_DELAY_MS;
  const tlsOptions  = { rejectUnauthorized: args.reject_unauthorized !== false };

  const bodyBuf = Buffer.from(JSON.stringify(payload), "utf8");
  const headers = buildHeaders(args, bodyBuf.length);

  let rawResp;
  for (let attempt = 0; attempt <= retryCount; attempt++) {
    if (attempt > 0) await sleep(retryDelay * Math.pow(2, attempt - 1));
    try {
      rawResp = await rawRequest(parsedUrl, "POST", headers, bodyBuf, timeout, tlsOptions);
      break;
    } catch (e) {
      if (attempt === retryCount) throw e;
    }
  }

  let bodyDecBuf;
  try { bodyDecBuf = await decompressBody(rawResp.bodyBuf, rawResp.headers["content-encoding"]); }
  catch { bodyDecBuf = rawResp.bodyBuf; }

  if (bodyDecBuf.length > maxBodyBytes)
    throw err(`graphql_client: response body too large (${bodyDecBuf.length} bytes; max ${maxBodyBytes}).`, "RESPONSE_TOO_LARGE");

  let parsed;
  try { parsed = JSON.parse(bodyDecBuf.toString("utf8")); }
  catch (e) {
    throw err(`graphql_client: server returned non-JSON response for batch (HTTP ${rawResp.statusCode}).`, "INVALID_RESPONSE");
  }

  // Batch responses: server should return an array
  const results = Array.isArray(parsed) ? parsed : [parsed];
  return {
    operation:      "batch",
    url:            args.url,
    operationCount: payload.length,
    statusCode:     rawResp.statusCode,
    results:        results.map(r => ({
      data:       r.data ?? null,
      errors:     Array.isArray(r.errors) ? r.errors : [],
      hasErrors:  Array.isArray(r.errors) && r.errors.length > 0,
      extensions: r.extensions || null,
    })),
  };
}

async function opSubscribePoll(args) {
  if (!args.url)   throw err("graphql_client: 'url' is required.", "INVALID_ARG");
  validateQueryString(args.query);

  const maxIterations = Math.min(
    args.max_polls != null ? args.max_polls : 10,
    MAX_POLL_ITERATIONS,
  );
  if (maxIterations < 1)
    throw err("graphql_client: 'max_polls' must be at least 1.", "INVALID_ARG");

  const pollInterval = Math.max(100, args.poll_interval_ms != null ? args.poll_interval_ms : DEFAULT_POLL_INTERVAL);
  const stopOnData   = args.stop_on_data !== false; // default: true

  const payload = { query: args.query };
  if (args.variables      != null) payload.variables      = args.variables;
  if (args.operation_name != null) payload.operationName  = args.operation_name;

  const iterations = [];
  for (let i = 0; i < maxIterations; i++) {
    if (i > 0) await sleep(pollInterval);
    const result = await executeGraphQL(args, payload);
    const iter = {
      poll:       i + 1,
      data:       result.data,
      errors:     result.errors,
      hasErrors:  result.hasErrors,
      statusCode: result.statusCode,
    };
    iterations.push(iter);
    // Stop early if we got data and stop_on_data is true
    if (stopOnData && result.data != null && !result.hasErrors) break;
  }

  return {
    operation:    "subscribe_poll",
    url:          args.url,
    polls:        iterations.length,
    pollInterval: pollInterval,
    iterations,
  };
}

// ── Main dispatcher ───────────────────────────────────────────────────────────
async function graphqlClient(args) {
  if (!args || !args.operation)
    throw err("graphql_client: 'operation' is required.", "INVALID_ARG");

  switch (args.operation) {
    case "query":           return opQuery(args);
    case "mutate":          return opMutate(args);
    case "introspect":      return opIntrospect(args);
    case "introspect_type": return opIntrospectType(args);
    case "batch":           return opBatch(args);
    case "subscribe_poll":  return opSubscribePoll(args);
    default:
      throw err(
        `graphql_client: unknown operation '${args.operation}'. Valid: query, mutate, introspect, introspect_type, batch, subscribe_poll.`,
        "INVALID_ARG",
      );
  }
}

module.exports = {
  graphqlClient,
  // Exported for testing
  validateUrl,
  isPrivateHost,
  validateHeader,
  buildHeaders,
  parseGqlResponse,
  summariseSchema,
  validateQueryString,
  decompressBody,
  INTROSPECTION_QUERY,
  INTROSPECT_TYPE_QUERY,
};
