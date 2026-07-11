"use strict";
// ── graphql_query: zero-dep GraphQL HTTP client ─────────────────────────────────
// Sends a POST request to a GraphQL endpoint. Handles both http:// and https://.
// Supports query, mutation, and subscription (request-response only for SSE).
// Returns { statusCode, operationType, operationName, data, errors, extensions, hasErrors }.

const http  = require("http");
const https = require("https");
const { ToolError } = require("./errors");

const MAX_QUERY_LEN     = 100_000;        // 100 KB
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB
const DEFAULT_TIMEOUT   = 30_000;         // 30 s

/**
 * Send a GraphQL request.
 *
 * @param {object} opts
 * @param {string}  opts.url            GraphQL endpoint URL (http or https)
 * @param {string}  opts.query           GraphQL document (query/mutation/subscription)
 * @param {object}  [opts.variables]     Variables object
 * @param {object}  [opts.headers]       Extra HTTP headers (e.g. { Authorization: 'Bearer …' })
 * @param {string}  [opts.operation_name] operationName for multi-operation documents
 * @param {number}  [opts.timeout]       Request timeout in ms (default 30 000)
 * @returns {Promise<object>}
 */
function graphqlQuery(opts) {
  const {
    url,
    query,
    variables,
    headers     = {},
    operation_name,
    timeout     = DEFAULT_TIMEOUT,
  } = opts || {};

  // ── Validation ──────────────────────────────────────────────────────────────
  if (!url || typeof url !== "string")
    throw new ToolError("graphql_query: 'url' is required (string).", -32602);
  if (!query || typeof query !== "string")
    throw new ToolError("graphql_query: 'query' is required (string GraphQL document).", -32602);
  if (query.length > MAX_QUERY_LEN)
    throw new ToolError(`graphql_query: 'query' exceeds ${MAX_QUERY_LEN / 1024} KB limit.`, -32602);
  if (variables !== undefined && (typeof variables !== "object" || Array.isArray(variables) || variables === null))
    throw new ToolError("graphql_query: 'variables' must be a plain object if provided.", -32602);
  if (headers !== null && typeof headers !== "object")
    throw new ToolError("graphql_query: 'headers' must be a plain object if provided.", -32602);
  if (timeout !== undefined && (typeof timeout !== "number" || timeout <= 0))
    throw new ToolError("graphql_query: 'timeout' must be a positive number (milliseconds).", -32602);

  // ── Parse URL ───────────────────────────────────────────────────────────────
  let parsed;
  try { parsed = new URL(url); }
  catch { throw new ToolError(`graphql_query: invalid URL '${url}'.`, -32602); }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    throw new ToolError("graphql_query: URL must use http:// or https://.", -32602);

  // ── Build request body ──────────────────────────────────────────────────────
  const bodyObj = { query };
  if (variables    !== undefined) bodyObj.variables      = variables;
  if (operation_name)             bodyObj.operationName  = operation_name;

  const bodyStr = JSON.stringify(bodyObj);
  const bodyBuf = Buffer.from(bodyStr, "utf8");

  // ── Detect operation type from the document ─────────────────────────────────
  // Strips block comments (/* … */) and line comments (# …), then looks at
  // the first keyword.  Defaults to 'query' when ambiguous (anonymous shorthand).
  function detectOpType(doc) {
    const stripped = doc
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/#[^\n]*/g, "")
      .trim();
    const m = stripped.match(/^(query|mutation|subscription)\b/i);
    return m ? m[1].toLowerCase() : "query";
  }

  // ── Merge headers ───────────────────────────────────────────────────────────
  const reqHeaders = Object.assign(
    {
      "content-type":   "application/json",
      "content-length": String(bodyBuf.length),
      "accept":         "application/json",
    },
    // Caller headers take precedence (allow overriding content-type, auth, etc.)
    Object.fromEntries(
      Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)])
    )
  );

  const mod = parsed.protocol === "https:" ? https : http;

  // ── Make request ────────────────────────────────────────────────────────────
  return new Promise((resolve, reject) => {
    const reqOpts = {
      hostname: parsed.hostname,
      port:     parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === "https:" ? 443 : 80),
      path:     (parsed.pathname || "/") + (parsed.search || ""),
      method:   "POST",
      headers:  reqHeaders,
    };

    const req = mod.request(reqOpts, (res) => {
      const chunks = [];
      let totalBytes = 0;
      let aborted = false;

      res.on("data", (chunk) => {
        if (aborted) return;
        totalBytes += chunk.length;
        if (totalBytes > MAX_RESPONSE_BYTES) {
          aborted = true;
          req.destroy(new ToolError(
            `graphql_query: response body exceeds ${MAX_RESPONSE_BYTES / 1024 / 1024} MB limit.`,
            -32603
          ));
          return;
        }
        chunks.push(chunk);
      });

      res.on("end", () => {
        if (aborted) return;
        const rawBody = Buffer.concat(chunks).toString("utf8");

        // Parse response JSON
        let parsed_;
        try {
          parsed_ = JSON.parse(rawBody);
        } catch (e) {
          reject(new ToolError(
            `graphql_query: response is not valid JSON (status ${res.statusCode}): ${
              rawBody.slice(0, 300)}`,
            -32603
          ));
          return;
        }

        const errors     = parsed_.errors ?? null;
        const hasErrors  = !!(errors && errors.length > 0);

        resolve({
          statusCode:    res.statusCode,
          operationType: detectOpType(query),
          operationName: operation_name || null,
          data:          parsed_.data       ?? null,
          errors,
          extensions:    parsed_.extensions ?? null,
          hasErrors,
        });
      });

      res.on("error", (e) => reject(new ToolError(`graphql_query: response stream error: ${e.message}`, -32603)));
    });

    // Timeout
    req.setTimeout(typeof timeout === "number" ? timeout : DEFAULT_TIMEOUT, () => {
      req.destroy(new ToolError(
        `graphql_query: request timed out after ${timeout} ms.`,
        -32603
      ));
    });

    req.on("error", (e) => reject(new ToolError(`graphql_query: request error: ${e.message}`, -32603)));

    req.write(bodyBuf);
    req.end();
  });
}

module.exports = { graphqlQuery };
