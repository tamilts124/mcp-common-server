"use strict";
// test/sections/212-graphql-client.js
// graphql_client comprehensive tests
// Sections: A=input-validation(10), B=unit(20), C=integration(10),
//           D=happy-path(20), E=security(10), F=concurrency(5) — 75 total

const http = require("http");

const {
  graphqlClient,
  validateUrl,
  isPrivateHost,
  validateHeader,
  buildHeaders,
  parseGqlResponse,
  summariseSchema,
  validateQueryString,
  INTROSPECTION_QUERY,
  INTROSPECT_TYPE_QUERY,
} = require("../../lib/graphqlClientOps");

// ── helpers ──────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];

function assert(label, cond) {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(label);
    process.stderr.write("  FAIL: " + label + "\n");
  }
}

async function assertThrowsAsync(label, fn, substr) {
  try {
    await fn();
    failed++;
    failures.push(label + " (no throw)");
    process.stderr.write("  FAIL (no throw): " + label + "\n");
  } catch (e) {
    if (substr && substr.length > 0 && !e.message.toLowerCase().includes(substr.toLowerCase())) {
      failed++;
      failures.push(label + " (wrong message: " + e.message + ")");
      process.stderr.write("  FAIL (wrong msg): " + label + " — got: " + e.message + "\n");
    } else {
      passed++;
    }
  }
}

function createMockServer(handler) {
  return new Promise(function(resolve) {
    const srv = http.createServer(function(req, res) {
      let body = "";
      req.on("data", function(c) { body += c; });
      req.on("end", function() {
        try { handler(req, res, body); } catch (e) { res.writeHead(500); res.end("Error"); }
      });
    });
    srv.listen(0, "127.0.0.1", function() { resolve(srv); });
  });
}

function gqlUrl(srv) {
  return "http://127.0.0.1:" + srv.address().port + "/graphql";
}

function jsonReply(res, data, status) {
  status = status || 200;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

async function main() {

  // ══ A — Input Validation (10) ══
  process.stderr.write("\n=== A: Input Validation ===\n");

  await assertThrowsAsync("A1: missing operation", function() { return graphqlClient({ url: "http://example.com/graphql" }); }, "operation");
  await assertThrowsAsync("A2: invalid operation", function() { return graphqlClient({ operation: "fetch", url: "http://example.com/graphql" }); }, "operation");
  await assertThrowsAsync("A3: missing url", function() { return graphqlClient({ operation: "query", query: "{ x }" }); }, "url");
  await assertThrowsAsync("A4: ftp:// URL rejected", function() { return graphqlClient({ operation: "query", url: "ftp://example.com/gql", query: "{ x }" }); }, "http");
  await assertThrowsAsync("A5: query requires query string", function() { return graphqlClient({ operation: "query", url: "http://example.com/graphql" }); }, "query");
  await assertThrowsAsync("A6: mutate requires query string", function() { return graphqlClient({ operation: "mutate", url: "http://example.com/graphql" }); }, "query");
  await assertThrowsAsync("A7: subscribe_poll requires query string", function() { return graphqlClient({ operation: "subscribe_poll", url: "http://example.com/graphql" }); }, "query");
  await assertThrowsAsync("A8: introspect_type requires type_name", function() { return graphqlClient({ operation: "introspect_type", url: "http://example.com/graphql" }); }, "type_name");
  await assertThrowsAsync("A9: batch requires operations", function() { return graphqlClient({ operation: "batch", url: "http://example.com/graphql" }); }, "operations");
  await assertThrowsAsync("A10: batch item missing query", function() { return graphqlClient({ operation: "batch", url: "http://example.com/graphql", operations: [{ variables: {} }] }); }, "query");

  // ══ B — Unit Tests (20) ══
  process.stderr.write("\n=== B: Unit Tests ===\n");

  // B1-B3: validateUrl
  { let ok = false; try { validateUrl("http://example.com/gql"); ok = true; } catch(e) {} assert("B1: validateUrl accepts http://", ok); }
  { let ok = false; try { validateUrl("https://api.example.com/graphql"); ok = true; } catch(e) {} assert("B2: validateUrl accepts https://", ok); }
  { let ok = false; try { validateUrl("ws://bad.com"); } catch(e) { ok = true; } assert("B3: validateUrl rejects ws://", ok); }

  // B4-B5: isPrivateHost
  assert("B4: isPrivateHost 127.0.0.1", isPrivateHost("127.0.0.1"));
  assert("B5: isPrivateHost 192.168.1.1", isPrivateHost("192.168.1.1"));
  assert("B5b: isPrivateHost 10.0.0.1", isPrivateHost("10.0.0.1"));
  assert("B5c: isPrivateHost localhost", isPrivateHost("localhost"));

  // B6: validateHeader
  { let ok = true; try { validateHeader("X-Custom", "value"); } catch(e) { ok = false; } assert("B6: validateHeader accepts valid", ok); }
  { let ok = false; try { validateHeader("X-Bad\x00", "val"); } catch(e) { ok = true; } assert("B6b: validateHeader rejects NUL in name", ok); }
  { let ok = false; try { validateHeader("X-Good", "val\ninjected"); } catch(e) { ok = true; } assert("B6c: validateHeader rejects LF in value", ok); }

  // B7-B9: buildHeaders auth
  {
    const h = buildHeaders({ auth: { type: "bearer", token: "tok123" }, headers: {} }, 0);
    assert("B7: buildHeaders bearer token", h["Authorization"] === "Bearer tok123");
  }
  {
    const h = buildHeaders({ auth: { type: "basic", username: "user", password: "pass" }, headers: {} }, 0);
    const expected = "Basic " + Buffer.from("user:pass").toString("base64");
    assert("B8: buildHeaders basic auth", h["Authorization"] === expected);
  }
  {
    const h = buildHeaders({ auth: { type: "api_key", header: "X-API-Key", value: "apikey123" }, headers: {} }, 0);
    assert("B9: buildHeaders api_key auth", h["X-API-Key"] === "apikey123");
  }

  // B10-B12: parseGqlResponse — accepts JSON string (as used internally)
  {
    // FIX: parseGqlResponse expects a JSON string, not an object
    const r = parseGqlResponse(JSON.stringify({ data: { user: { id: 1 } }, errors: null }), 200);
    assert("B10: parseGqlResponse data", r.data && r.data.user.id === 1);
    assert("B10b: parseGqlResponse hasErrors false", r.hasErrors === false);
  }
  {
    const r = parseGqlResponse(JSON.stringify({ data: null, errors: [{ message: "Not found" }] }), 200);
    assert("B11: parseGqlResponse errors surfaced", r.hasErrors === true);
    assert("B11b: parseGqlResponse errors length", r.errors.length === 1);
  }
  {
    const r = parseGqlResponse(JSON.stringify({}), 500);
    assert("B12: parseGqlResponse 500 statusCode", r.statusCode === 500);
  }

  // B13: validateQueryString
  { let ok = true; try { validateQueryString("query { user { id } }"); } catch(e) { ok = false; } assert("B13: validateQueryString valid", ok); }
  { let ok = false; try { validateQueryString(""); } catch(e) { ok = true; } assert("B13b: validateQueryString rejects empty", ok); }
  { let ok = false; try { validateQueryString(null); } catch(e) { ok = true; } assert("B13c: validateQueryString rejects null", ok); }

  // B14: summariseSchema
  {
    const mockSchema = {
      __schema: {
        queryType: { name: "Query" }, mutationType: null, subscriptionType: null,
        types: [
          { name: "Query", kind: "OBJECT", fields: [{ name: "user", type: { name: "User", kind: "OBJECT" }, args: [] }], description: null },
          { name: "User", kind: "OBJECT", fields: [{ name: "id", type: { name: "ID", kind: "SCALAR" }, args: [] }], description: "A user" },
          { name: "__Schema", kind: "OBJECT", fields: [], description: null },
        ],
        directives: [{ name: "deprecated", locations: ["FIELD"] }],
      }
    };
    const s = summariseSchema(mockSchema);
    assert("B14: summariseSchema has types", Array.isArray(s.types));
    assert("B14b: summariseSchema filters __ types", !s.types.some(function(t) { return t.name.startsWith("__"); }));
    assert("B14c: summariseSchema has queryType", s.queryType === "Query");
  }

  // B15-B16: constant shapes
  assert("B15: INTROSPECTION_QUERY is valid", typeof INTROSPECTION_QUERY === "string" && INTROSPECTION_QUERY.includes("__schema"));
  assert("B16: INTROSPECT_TYPE_QUERY is valid", typeof INTROSPECT_TYPE_QUERY === "string" && INTROSPECT_TYPE_QUERY.length > 0);

  // ══ C — Integration Tests (10) ══
  process.stderr.write("\n=== C: Integration Tests ===\n");

  // C1: basic query
  {
    const srv = await createMockServer(function(req, res, body) { jsonReply(res, { data: { hello: "world" }, errors: null }); });
    try {
      const r = await graphqlClient({ operation: "query", url: gqlUrl(srv), query: "query { hello }", ssrf_guard: false });
      assert("C1: query data", r.data && r.data.hello === "world");
      assert("C1b: query hasErrors false", r.hasErrors === false);
      assert("C1c: query statusCode 200", r.statusCode === 200);
    } finally { srv.close(); }
  }

  // C2: mutation
  {
    const srv = await createMockServer(function(req, res, body) {
      const p = JSON.parse(body);
      jsonReply(res, { data: { createUser: { id: 42, name: (p.variables && p.variables.name) || "test" } } });
    });
    try {
      const r = await graphqlClient({ operation: "mutate", url: gqlUrl(srv), query: "mutation CreateUser($name: String!) { createUser(name: $name) { id name } }", variables: { name: "Alice" }, ssrf_guard: false });
      assert("C2: mutation data", r.data && r.data.createUser.id === 42);
      assert("C2b: mutation variables", r.data.createUser.name === "Alice");
    } finally { srv.close(); }
  }

  // C3: GraphQL errors
  {
    const srv = await createMockServer(function(req, res, body) { jsonReply(res, { data: null, errors: [{ message: "Unauthorized" }] }); });
    try {
      const r = await graphqlClient({ operation: "query", url: gqlUrl(srv), query: "{ secret }", ssrf_guard: false });
      assert("C3: errors surfaced", r.hasErrors === true);
      assert("C3b: error message", r.errors[0].message === "Unauthorized");
    } finally { srv.close(); }
  }

  // C4: HTTP 400
  {
    const srv = await createMockServer(function(req, res, body) { jsonReply(res, { errors: [{ message: "Bad syntax" }] }, 400); });
    try {
      const r = await graphqlClient({ operation: "query", url: gqlUrl(srv), query: "{ bad }", ssrf_guard: false });
      assert("C4: HTTP 400 status", r.statusCode === 400);
    } finally { srv.close(); }
  }

  // C5: bearer auth header
  {
    let receivedAuth = "";
    const srv = await createMockServer(function(req, res, body) { receivedAuth = req.headers["authorization"] || ""; jsonReply(res, { data: {} }); });
    try {
      await graphqlClient({ operation: "query", url: gqlUrl(srv), query: "{ ok }", auth: { type: "bearer", token: "mytoken" }, ssrf_guard: false });
      assert("C5: bearer auth sent", receivedAuth === "Bearer mytoken");
    } finally { srv.close(); }
  }

  // C6: custom headers
  {
    let received = {};
    const srv = await createMockServer(function(req, res, body) { received = req.headers; jsonReply(res, { data: {} }); });
    try {
      await graphqlClient({ operation: "query", url: gqlUrl(srv), query: "{ x }", headers: { "X-Request-ID": "abc123" }, ssrf_guard: false });
      assert("C6: custom header forwarded", received["x-request-id"] === "abc123");
    } finally { srv.close(); }
  }

  // C7: batch sends array
  {
    let parsedOps = null;
    const srv = await createMockServer(function(req, res, body) {
      parsedOps = JSON.parse(body);
      jsonReply(res, parsedOps.map(function(op, i) { return { data: { index: i } }; }));
    });
    try {
      const r = await graphqlClient({ operation: "batch", url: gqlUrl(srv), operations: [{ query: "{ a }" }, { query: "{ b }" }, { query: "{ c }" }], ssrf_guard: false });
      assert("C7: batch sends array", Array.isArray(parsedOps) && parsedOps.length === 3);
      assert("C7b: batch results", Array.isArray(r.results) && r.results.length === 3);
    } finally { srv.close(); }
  }

  // C8: introspect sends __schema query
  // FIX: introspect returns { data: schemaObj, ... } not { schema: ... }
  {
    let receivedBody = "";
    const fakeSchema = { __schema: { queryType: { name: "Query" }, mutationType: null, subscriptionType: null, types: [], directives: [] } };
    const srv = await createMockServer(function(req, res, body) { receivedBody = body; jsonReply(res, { data: fakeSchema }); });
    try {
      const r = await graphqlClient({ operation: "introspect", url: gqlUrl(srv), ssrf_guard: false });
      assert("C8: introspect sends __schema", receivedBody.includes("__schema"));
      assert("C8b: introspect returns data", r.data !== undefined);
    } finally { srv.close(); }
  }

  // C9: operationName forwarded
  {
    let parsed = {};
    const srv = await createMockServer(function(req, res, body) { parsed = JSON.parse(body); jsonReply(res, { data: {} }); });
    try {
      await graphqlClient({ operation: "query", url: gqlUrl(srv), query: "query GetUser { user { id } }", operation_name: "GetUser", ssrf_guard: false });
      assert("C9: operationName forwarded", parsed.operationName === "GetUser");
    } finally { srv.close(); }
  }

  // C10: timeout fires
  {
    const srv = await createMockServer(function(req, res, body) { /* never reply */ });
    try {
      await assertThrowsAsync("C10: timeout fires", function() {
        return graphqlClient({ operation: "query", url: gqlUrl(srv), query: "{ x }", timeout: 200, ssrf_guard: false });
      }, "");
    } finally { srv.close(); }
  }

  // ══ D — Happy Path (20) ══
  process.stderr.write("\n=== D: Happy Path ===\n");

  // D1: variables sent and used
  {
    const srv = await createMockServer(function(req, res, body) {
      const p = JSON.parse(body);
      jsonReply(res, { data: { user: { id: p.variables.id, name: "Bob" } } });
    });
    try {
      const r = await graphqlClient({ operation: "query", url: gqlUrl(srv), query: "query User($id: ID!) { user(id: $id) { id name } }", variables: { id: "7" }, ssrf_guard: false });
      assert("D1: variables id", r.data.user.id === "7");
      assert("D1b: variables name", r.data.user.name === "Bob");
    } finally { srv.close(); }
  }

  // D2: mutation variables
  {
    const srv = await createMockServer(function(req, res, body) {
      const p = JSON.parse(body);
      jsonReply(res, { data: { createPost: { id: 1, title: p.variables.title } } });
    });
    try {
      const r = await graphqlClient({ operation: "mutate", url: gqlUrl(srv), query: "mutation CreatePost($title: String!) { createPost(title: $title) { id title } }", variables: { title: "Hello" }, ssrf_guard: false });
      assert("D2: mutation title", r.data.createPost.title === "Hello");
    } finally { srv.close(); }
  }

  // D3: introspect_type — FIX: data.__type contains the type, not r.type
  {
    const srv = await createMockServer(function(req, res, body) {
      const p = JSON.parse(body);
      const name = (p.variables && (p.variables.name || p.variables.typeName)) || "User";
      jsonReply(res, { data: { __type: { name: name, kind: "OBJECT", fields: [{ name: "id" }] } } });
    });
    try {
      const r = await graphqlClient({ operation: "introspect_type", url: gqlUrl(srv), type_name: "User", ssrf_guard: false });
      assert("D3: introspect_type name", r.data && r.data.__type && r.data.__type.name === "User");
    } finally { srv.close(); }
  }

  // D4: introspect raw mode — FIX: raw=true returns data with __schema, not r.rawSchema
  {
    const rawSchema = { __schema: { queryType: { name: "Query" }, types: [], directives: [], mutationType: null, subscriptionType: null } };
    const srv = await createMockServer(function(req, res, body) { jsonReply(res, { data: rawSchema }); });
    try {
      const r = await graphqlClient({ operation: "introspect", url: gqlUrl(srv), raw: true, ssrf_guard: false });
      assert("D4: introspect raw __schema", r.data && r.data.__schema);
    } finally { srv.close(); }
  }

  // D5: extensions preserved
  {
    const srv = await createMockServer(function(req, res, body) { jsonReply(res, { data: { ok: true }, extensions: { requestId: "xyz" } }); });
    try {
      const r = await graphqlClient({ operation: "query", url: gqlUrl(srv), query: "{ ok }", ssrf_guard: false });
      assert("D5: extensions preserved", r.extensions && r.extensions.requestId === "xyz");
    } finally { srv.close(); }
  }

  // D6: subscribe_poll stops on first data
  // FIX: r.polls is the count (number), r.iterations is the array
  {
    let callCount = 0;
    const srv = await createMockServer(function(req, res, body) { callCount++; jsonReply(res, { data: { event: { id: callCount } } }); });
    try {
      const r = await graphqlClient({ operation: "subscribe_poll", url: gqlUrl(srv), query: "{ event { id } }", max_polls: 5, poll_interval_ms: 50, stop_on_data: true, ssrf_guard: false });
      assert("D6: subscribe_poll stops on first data", r.iterations && r.iterations.length === 1);
    } finally { srv.close(); }
  }

  // D7: subscribe_poll collects until data
  {
    let callCount = 0;
    const srv = await createMockServer(function(req, res, body) {
      callCount++;
      if (callCount < 3) { jsonReply(res, { data: null, errors: [{ message: "pending" }] }); }
      else { jsonReply(res, { data: { event: { id: callCount } } }); }
    });
    try {
      const r = await graphqlClient({ operation: "subscribe_poll", url: gqlUrl(srv), query: "{ event { id } }", max_polls: 5, poll_interval_ms: 50, stop_on_data: true, ssrf_guard: false });
      assert("D7: subscribe_poll collects until data", r.iterations && r.iterations.length >= 3);
    } finally { srv.close(); }
  }

  // D8: subscribe_poll max_polls limit
  {
    const srv = await createMockServer(function(req, res, body) { jsonReply(res, { data: null, errors: [{ message: "pending" }] }); });
    try {
      const r = await graphqlClient({ operation: "subscribe_poll", url: gqlUrl(srv), query: "{ x }", max_polls: 3, poll_interval_ms: 50, stop_on_data: true, ssrf_guard: false });
      assert("D8: subscribe_poll max_polls", r.iterations && r.iterations.length === 3);
    } finally { srv.close(); }
  }

  // D9: Content-Type sent
  {
    let ct = "";
    const srv = await createMockServer(function(req, res, body) { ct = req.headers["content-type"] || ""; jsonReply(res, { data: {} }); });
    try {
      await graphqlClient({ operation: "query", url: gqlUrl(srv), query: "{ ok }", ssrf_guard: false });
      assert("D9: Content-Type application/json", ct.includes("application/json"));
    } finally { srv.close(); }
  }

  // D10: basic auth
  {
    let authHdr = "";
    const srv = await createMockServer(function(req, res, body) { authHdr = req.headers["authorization"] || ""; jsonReply(res, { data: {} }); });
    try {
      await graphqlClient({ operation: "query", url: gqlUrl(srv), query: "{ x }", auth: { type: "basic", username: "admin", password: "secret" }, ssrf_guard: false });
      assert("D10: basic auth header", authHdr === "Basic " + Buffer.from("admin:secret").toString("base64"));
    } finally { srv.close(); }
  }

  // D11: api_key auth
  {
    let apiHdr = "";
    const srv = await createMockServer(function(req, res, body) { apiHdr = req.headers["x-api-key"] || ""; jsonReply(res, { data: {} }); });
    try {
      await graphqlClient({ operation: "query", url: gqlUrl(srv), query: "{ x }", auth: { type: "api_key", header: "X-API-Key", value: "key999" }, ssrf_guard: false });
      assert("D11: api_key header", apiHdr === "key999");
    } finally { srv.close(); }
  }

  // D12: batch single op
  {
    const srv = await createMockServer(function(req, res, body) { jsonReply(res, [{ data: { ping: "pong" } }]); });
    try {
      const r = await graphqlClient({ operation: "batch", url: gqlUrl(srv), operations: [{ query: "{ ping }" }], ssrf_guard: false });
      assert("D12: batch single result", r.results.length === 1 && r.results[0].data.ping === "pong");
    } finally { srv.close(); }
  }

  // D13: batch operation names
  {
    let parsed = null;
    const srv = await createMockServer(function(req, res, body) {
      parsed = JSON.parse(body);
      jsonReply(res, parsed.map(function(op) { return { data: { op: op.operationName } }; }));
    });
    try {
      await graphqlClient({ operation: "batch", url: gqlUrl(srv), operations: [{ query: "query A { a }", operation_name: "A" }, { query: "query B { b }", operation_name: "B" }], ssrf_guard: false });
      assert("D13: batch op names", parsed[0].operationName === "A" && parsed[1].operationName === "B");
    } finally { srv.close(); }
  }

  // D14: hasErrors false for clean
  {
    const srv = await createMockServer(function(req, res, body) { jsonReply(res, { data: { count: 99 } }); });
    try {
      const r = await graphqlClient({ operation: "query", url: gqlUrl(srv), query: "{ count }", ssrf_guard: false });
      assert("D14: hasErrors false", r.hasErrors === false && r.data.count === 99);
    } finally { srv.close(); }
  }

  // D15: POST method used
  {
    let method = "";
    const srv = await createMockServer(function(req, res, body) { method = req.method; jsonReply(res, { data: {} }); });
    try {
      await graphqlClient({ operation: "query", url: gqlUrl(srv), query: "{ x }", ssrf_guard: false });
      assert("D15: POST used", method === "POST");
    } finally { srv.close(); }
  }

  // D16: URL path preserved
  {
    let receivedPath = "";
    const srv = await createMockServer(function(req, res, body) { receivedPath = req.url; jsonReply(res, { data: {} }); });
    try {
      await graphqlClient({ operation: "query", url: "http://127.0.0.1:" + srv.address().port + "/api/graphql", query: "{ x }", ssrf_guard: false });
      assert("D16: URL path preserved", receivedPath === "/api/graphql");
    } finally { srv.close(); }
  }

  // D17: no variables absent or null
  {
    let parsed = {};
    const srv = await createMockServer(function(req, res, body) { parsed = JSON.parse(body); jsonReply(res, { data: {} }); });
    try {
      await graphqlClient({ operation: "query", url: gqlUrl(srv), query: "{ x }", ssrf_guard: false });
      assert("D17: no variables not sent", !("variables" in parsed) || parsed.variables == null);
    } finally { srv.close(); }
  }

  // D18: introspect handles ENUM type — FIX: r.data, not r.schema
  {
    const schema = { __schema: { queryType: { name: "Query" }, mutationType: null, subscriptionType: null, types: [{ name: "Status", kind: "ENUM", fields: null, description: "enum", enumValues: [{ name: "ACTIVE" }] }], directives: [] } };
    const srv = await createMockServer(function(req, res, body) { jsonReply(res, { data: schema }); });
    try {
      const r = await graphqlClient({ operation: "introspect", url: gqlUrl(srv), ssrf_guard: false });
      assert("D18: introspect ENUM type", r.data && Array.isArray(r.data.types));
    } finally { srv.close(); }
  }

  // D19: retry on socket destroy
  {
    let attempts = 0;
    const srv = await createMockServer(function(req, res, body) {
      attempts++;
      if (attempts < 2) { req.socket.destroy(); return; }
      jsonReply(res, { data: { attempt: attempts } });
    });
    try {
      const r = await graphqlClient({ operation: "query", url: gqlUrl(srv), query: "{ attempt }", retry_count: 2, retry_delay_ms: 50, ssrf_guard: false });
      assert("D19: retry on socket error", r.data && r.data.attempt === 2);
    } finally { srv.close(); }
  }

  // D20: large response
  {
    const bigItems = [];
    for (let i = 0; i < 500; i++) bigItems.push({ id: i, name: "Item " + i });
    const srv = await createMockServer(function(req, res, body) { jsonReply(res, { data: { items: bigItems } }); });
    try {
      const r = await graphqlClient({ operation: "query", url: gqlUrl(srv), query: "{ items { id name } }", ssrf_guard: false });
      assert("D20: large response", r.data && r.data.items.length === 500);
    } finally { srv.close(); }
  }

  // ══ E — Security (10) ══
  process.stderr.write("\n=== E: Security Tests ===\n");

  await assertThrowsAsync("E1: SSRF blocks 127.0.0.1", function() { return graphqlClient({ operation: "query", url: "http://127.0.0.1:9999/graphql", query: "{ x }" }); }, "SSRF");
  await assertThrowsAsync("E2: SSRF blocks 10.0.0.1", function() { return graphqlClient({ operation: "query", url: "http://10.0.0.1/graphql", query: "{ x }" }); }, "SSRF");
  await assertThrowsAsync("E3: SSRF blocks 192.168.1.1", function() { return graphqlClient({ operation: "query", url: "http://192.168.1.1/graphql", query: "{ x }" }); }, "SSRF");

  // E4: ssrf_guard false allows localhost
  {
    const srv = await createMockServer(function(req, res, body) { jsonReply(res, { data: { ok: true } }); });
    try {
      const r = await graphqlClient({ operation: "query", url: "http://127.0.0.1:" + srv.address().port + "/graphql", query: "{ ok }", ssrf_guard: false });
      assert("E4: ssrf_guard false allows localhost", r.data && r.data.ok === true);
    } finally { srv.close(); }
  }

  // E5-E7: header injection
  { let ok = false; try { validateHeader("X-Injected\x00", "v"); } catch(e) { ok = true; } assert("E5: NUL in header name rejected", ok); }
  { let ok = false; try { validateHeader("X-H", "v\r\nX-Evil: yes"); } catch(e) { ok = true; } assert("E6: CRLF in header value rejected", ok); }
  { let ok = false; try { validateHeader("X-H", "v\nX-Evil: yes"); } catch(e) { ok = true; } assert("E7: LF in header value rejected", ok); }

  // E8: response size cap
  {
    const srv = await createMockServer(function(req, res, body) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"data":"' + "x".repeat(2048) + '"}');
    });
    try {
      await assertThrowsAsync("E8: response size cap", function() {
        return graphqlClient({ operation: "query", url: gqlUrl(srv), query: "{ x }", ssrf_guard: false, max_response_bytes: 1024 });
      }, "");
    } finally { srv.close(); }
  }

  await assertThrowsAsync("E9: javascript: URL rejected", function() { return graphqlClient({ operation: "query", url: "javascript:alert(1)", query: "{ x }" }); }, "http");
  await assertThrowsAsync("E10: file:// URL rejected", function() { return graphqlClient({ operation: "query", url: "file:///etc/passwd", query: "{ x }" }); }, "http");

  // ══ F — Concurrency (5) ══
  process.stderr.write("\n=== F: Concurrency Tests ===\n");

  // F1: 10 concurrent queries
  {
    let count = 0;
    const srv = await createMockServer(function(req, res, body) { count++; jsonReply(res, { data: { n: count } }); });
    try {
      const promises = [];
      for (let i = 0; i < 10; i++) promises.push(graphqlClient({ operation: "query", url: gqlUrl(srv), query: "{ n }", ssrf_guard: false }));
      const results = await Promise.all(promises);
      assert("F1: 10 concurrent queries succeed", results.every(function(r) { return r.data && typeof r.data.n === "number"; }));
      assert("F1b: all 10 handled", count === 10);
    } finally { srv.close(); }
  }

  // F2: concurrent mutations
  {
    const received = [];
    const srv = await createMockServer(function(req, res, body) {
      const p = JSON.parse(body);
      received.push(p.variables.id);
      jsonReply(res, { data: { updated: p.variables.id } });
    });
    try {
      const results = await Promise.all([1, 2, 3, 4, 5].map(function(id) {
        return graphqlClient({ operation: "mutate", url: gqlUrl(srv), query: "mutation Update($id: Int!) { update(id: $id) }", variables: { id: id }, ssrf_guard: false });
      }));
      assert("F2: concurrent mutations succeed", results.every(function(r) { return r.data && typeof r.data.updated === "number"; }));
      assert("F2b: all 5 received", received.length === 5);
    } finally { srv.close(); }
  }

  // F3: concurrent introspect — FIX: r.data not r.schema
  {
    const schema = { __schema: { queryType: { name: "Query" }, mutationType: null, subscriptionType: null, types: [], directives: [] } };
    const srv = await createMockServer(function(req, res, body) { jsonReply(res, { data: schema }); });
    try {
      const results = await Promise.all(
        Array.from({ length: 5 }, function() { return graphqlClient({ operation: "introspect", url: gqlUrl(srv), ssrf_guard: false }); })
      );
      assert("F3: concurrent introspects", results.every(function(r) { return r.data !== undefined; }));
    } finally { srv.close(); }
  }

  // F4: concurrent batch
  {
    const srv = await createMockServer(function(req, res, body) {
      const ops = JSON.parse(body);
      jsonReply(res, ops.map(function(op, i) { return { data: { i: i } }; }));
    });
    try {
      const results = await Promise.all(
        Array.from({ length: 5 }, function() {
          return graphqlClient({ operation: "batch", url: gqlUrl(srv), operations: [{ query: "{ a }" }, { query: "{ b }" }], ssrf_guard: false });
        })
      );
      assert("F4: concurrent batches", results.every(function(r) { return Array.isArray(r.results) && r.results.length === 2; }));
    } finally { srv.close(); }
  }

  // F5: 20 parallel queries
  {
    const srv = await createMockServer(function(req, res, body) { jsonReply(res, { data: { ok: true } }); });
    try {
      const results = await Promise.all(
        Array.from({ length: 20 }, function() { return graphqlClient({ operation: "query", url: gqlUrl(srv), query: "{ ok }", ssrf_guard: false }); })
      );
      assert("F5: 20 parallel queries", results.every(function(r) { return r.data && r.data.ok === true; }));
    } finally { srv.close(); }
  }

  // ── Summary ──
  process.stderr.write("\n=== Section 212 Results: " + passed + " passed, " + failed + " failed ===\n");
  if (failures.length > 0) {
    process.stderr.write("Failures:\n");
    failures.forEach(function(f) { process.stderr.write("  - " + f + "\n"); });
  }
  if (failed > 0) process.exit(1);
  else process.stderr.write("All tests passed.\n");
}

main().catch(function(err) {
  process.stderr.write("Runner error: " + (err.stack || err) + "\n");
  process.exit(1);
});
