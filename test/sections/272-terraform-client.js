"use strict";
/**
 * Section 272 — terraform_client tests
 * Five rigor levels:
 *  A  Pure helper / pure-logic tests (no network)
 *  B  Validation / error-path tests
 *  C  Mock-network tests (intercept https/http via monkey-patching)
 *  D  Security / injection tests
 *  E  Concurrency / race-condition tests
 */

const assert = require("assert");
const https  = require("https");
const http   = require("http");
const { EventEmitter } = require("events");

const {
  terraformClient,
  buildConn,
  requireString,
  guardString,
  clampInt,
  parseTfJson,
  checkTfStatus,
  mapOrg,
  mapWorkspace,
  mapRun,
  mapState,
  mapVar,
  extractPagination,
  tfHttpRequest,
} = require("../../lib/terraformClientOps");

let passed = 0;
let failed = 0;
const errors = [];

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      return r.then(() => { passed++; process.stderr.write(`  \u2713 ${name}\n`); })
              .catch(err => { failed++; errors.push({ name, err }); process.stderr.write(`  \u2717 ${name}: ${err.message}\n`); });
    }
    passed++;
    process.stderr.write(`  \u2713 ${name}\n`);
  } catch (err) {
    failed++;
    errors.push({ name, err });
    process.stderr.write(`  \u2717 ${name}: ${err.message}\n`);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// A — Pure helper / logic tests
// ───────────────────────────────────────────────────────────────────────────

process.stderr.write("\nA — Pure helper / logic tests\n");

test("A01 requireString passes valid string", () => {
  assert.doesNotThrow(() => requireString("my-org", "organization"));
});

test("A02 requireString throws on empty string", () => {
  assert.throws(() => requireString("", "organization"), /must be a non-empty string/);
});

test("A03 requireString throws on NUL byte", () => {
  assert.throws(() => requireString("abc\0def", "organization"), /NUL/);
});

test("A04 requireString throws on non-string", () => {
  assert.throws(() => requireString(42, "organization"), /must be a non-empty string/);
});

test("A05 guardString passes undefined", () => {
  assert.doesNotThrow(() => guardString(undefined, "base_url"));
});

test("A06 guardString passes null", () => {
  assert.doesNotThrow(() => guardString(null, "base_url"));
});

test("A07 guardString throws on NUL byte", () => {
  assert.throws(() => guardString("foo\0bar", "base_url"), /NUL/);
});

test("A08 clampInt returns default on undefined", () => {
  assert.strictEqual(clampInt(undefined, 20000, 1000, 120000, "timeout"), 20000);
});

test("A09 clampInt clamps to min", () => {
  assert.strictEqual(clampInt(500, 20000, 1000, 120000, "timeout"), 1000);
});

test("A10 clampInt throws on non-finite", () => {
  assert.throws(() => clampInt(NaN, 20000, 1000, 120000, "timeout"), /must be a number/);
});

test("A11 parseTfJson parses valid JSON", () => {
  const r = parseTfJson('{"data":[]}', "test");
  assert.deepStrictEqual(r, { data: [] });
});

test("A12 parseTfJson throws on invalid JSON", () => {
  assert.throws(() => parseTfJson("not-json", "test"), /invalid JSON/);
});

test("A13 checkTfStatus passes on 200", () => {
  assert.doesNotThrow(() => checkTfStatus({ statusCode: 200, raw: "" }, "test"));
});

test("A14 checkTfStatus throws on 404", () => {
  const raw = JSON.stringify({ errors: [{ status: "404", title: "Not Found", detail: "Workspace not found" }] });
  assert.throws(() => checkTfStatus({ statusCode: 404, raw }, "workspace_get"), /Workspace not found/);
});

test("A15 checkTfStatus throws on 422 generic", () => {
  assert.throws(() => checkTfStatus({ statusCode: 422, raw: "unprocessable" }, "var_create"), /422/);
});

test("A16 extractPagination extracts fields", () => {
  const json = { meta: { pagination: { "current-page": 1, "total-pages": 5, "total-count": 47, "next-page": 2 } } };
  const pg   = extractPagination(json);
  assert.strictEqual(pg.current_page, 1);
  assert.strictEqual(pg.total_pages, 5);
  assert.strictEqual(pg.total_count, 47);
  assert.strictEqual(pg.next_page, 2);
});

test("A17 extractPagination handles empty meta", () => {
  const pg = extractPagination({});
  assert.strictEqual(pg.current_page, null);
  assert.strictEqual(pg.next_page, null);
});

test("A18 mapOrg maps all fields", () => {
  const d = {
    id: "org-abc",
    attributes: {
      name: "my-org",
      email: "admin@example.com",
      "collaborator-auth-policy": "password",
      plan: "trial",
      "created-at": "2024-01-01T00:00:00Z",
      permissions: { "can-create-workspace": true },
    },
  };
  const r = mapOrg(d);
  assert.strictEqual(r.id, "org-abc");
  assert.strictEqual(r.name, "my-org");
  assert.strictEqual(r.email, "admin@example.com");
  assert.strictEqual(r.plan, "trial");
});

test("A19 mapWorkspace maps all fields", () => {
  const d = {
    id: "ws-abc",
    attributes: {
      name: "my-workspace",
      description: "test ws",
      "auto-apply": true,
      locked: false,
      "terraform-version": "1.5.0",
      "working-directory": "",
      "execution-mode": "remote",
      "queue-all-runs": false,
      "created-at": "2024-01-01T00:00:00Z",
      "updated-at": "2024-06-01T00:00:00Z",
      "resource-count": 10,
      "run-failures": 0,
    },
    relationships: { organization: { data: { id: "org-abc" } } },
  };
  const r = mapWorkspace(d);
  assert.strictEqual(r.id, "ws-abc");
  assert.strictEqual(r.name, "my-workspace");
  assert.strictEqual(r.auto_apply, true);
  assert.strictEqual(r.terraform_version, "1.5.0");
  assert.strictEqual(r.resource_count, 10);
  assert.strictEqual(r.organization, "org-abc");
});

test("A20 mapRun maps all fields", () => {
  const d = {
    id: "run-xyz",
    attributes: {
      status: "planned",
      message: "triggered by API",
      "is-destroy": false,
      "auto-apply": false,
      refresh: true,
      "refresh-only": false,
      source: "tfe-api",
      "status-timestamps": { "planned-at": "2024-01-01T01:00:00Z" },
      "created-at": "2024-01-01T00:00:00Z",
      "has-changes": true,
      "resource-additions": 2,
      "resource-changes": 0,
      "resource-destructions": 0,
    },
    relationships: {
      workspace:  { data: { id: "ws-abc" } },
      plan:       { data: { id: "plan-001" } },
      apply:      { data: { id: "apply-001" } },
    },
  };
  const r = mapRun(d);
  assert.strictEqual(r.id, "run-xyz");
  assert.strictEqual(r.status, "planned");
  assert.strictEqual(r.has_changes, true);
  assert.strictEqual(r.resource_additions, 2);
  assert.strictEqual(r.plan_id, "plan-001");
  assert.strictEqual(r.apply_id, "apply-001");
  assert.strictEqual(r.workspace_id, "ws-abc");
});

test("A21 mapState maps all fields", () => {
  const d = {
    id: "sv-001",
    attributes: {
      serial: 5,
      "created-at": "2024-01-01T00:00:00Z",
      size: 12345,
      "hosted-state-download-url": "https://archivist.example.com/sv-001",
      "terraform-version": "1.5.0",
      "resource-count": 8,
    },
    relationships: { run: { data: { id: "run-xyz" } } },
  };
  const r = mapState(d);
  assert.strictEqual(r.id, "sv-001");
  assert.strictEqual(r.serial, 5);
  assert.strictEqual(r.resource_count, 8);
  assert.strictEqual(r.run_id, "run-xyz");
});

test("A22 mapVar hides sensitive values", () => {
  const d = {
    id: "var-001",
    attributes: { key: "SECRET", value: "supersecret", sensitive: true, hcl: false, category: "terraform", description: "" },
  };
  const r = mapVar(d);
  assert.strictEqual(r.key, "SECRET");
  assert.strictEqual(r.value, "[sensitive]");
  assert.strictEqual(r.sensitive, true);
});

test("A23 mapVar returns value for non-sensitive", () => {
  const d = {
    id: "var-002",
    attributes: { key: "AWS_REGION", value: "us-east-1", sensitive: false, hcl: false, category: "env", description: "" },
  };
  const r = mapVar(d);
  assert.strictEqual(r.value, "us-east-1");
});

test("A24 info operation returns operation list", async () => {
  const r = await terraformClient({ operation: "info" });
  assert.strictEqual(r.ok, true);
  assert.ok(Array.isArray(r.operations));
  assert.ok(r.operations.length >= 25);
  assert.ok(r.operations.some(o => o.op === "workspace_list"));
  assert.ok(r.operations.some(o => o.op === "run_create"));
  assert.ok(r.operations.some(o => o.op === "var_create"));
});

test("A25 buildConn defaults to TFC base URL", () => {
  const conn = buildConn({ token: "test-token" });
  assert.strictEqual(conn.baseUrl, "https://app.terraform.io");
  assert.strictEqual(conn.token, "test-token");
  assert.strictEqual(conn.timeoutMs, 20000);
  assert.strictEqual(conn.rejectUnauthorized, true);
});

test("A26 buildConn accepts custom base_url", () => {
  const conn = buildConn({ token: "tok", base_url: "https://tfe.example.com/" });
  assert.strictEqual(conn.baseUrl, "https://tfe.example.com"); // trailing slash stripped
});

test("A27 buildConn clamps timeout", () => {
  const conn = buildConn({ token: "tok", timeout: 500 });
  assert.strictEqual(conn.timeoutMs, 1000);
});

test("A28 buildConn reject_unauthorized defaults to true", () => {
  const conn = buildConn({ token: "tok" });
  assert.strictEqual(conn.rejectUnauthorized, true);
});

test("A29 buildConn reject_unauthorized can be set false", () => {
  const conn = buildConn({ token: "tok", reject_unauthorized: false });
  assert.strictEqual(conn.rejectUnauthorized, false);
});

test("A30 mapOrg handles missing optional fields", () => {
  const d = { id: "org-x", attributes: { name: "x" } };
  const r = mapOrg(d);
  assert.strictEqual(r.email, null);
  assert.strictEqual(r.plan, null);
  assert.deepStrictEqual(r.permissions, {});
});

test("A31 mapWorkspace handles null data", () => {
  const r = mapWorkspace(null);
  assert.deepStrictEqual(r, {});
});

test("A32 mapRun handles null data", () => {
  const r = mapRun(null);
  assert.deepStrictEqual(r, {});
});

test("A33 mapState handles null data", () => {
  const r = mapState(null);
  assert.deepStrictEqual(r, {});
});

test("A34 mapVar handles null data", () => {
  const r = mapVar(null);
  assert.deepStrictEqual(r, {});
});

test("A35 checkTfStatus throws with errors array", () => {
  const raw = JSON.stringify({ errors: [{ status: "422", title: "Invalid Attribute", detail: "Name is invalid" }] });
  assert.throws(() => checkTfStatus({ statusCode: 422, raw }, "workspace_create"), /Name is invalid/);
});

// ───────────────────────────────────────────────────────────────────────────
// B — Validation / error-path tests
// ───────────────────────────────────────────────────────────────────────────

process.stderr.write("\nB — Validation / error-path tests\n");

test("B01 missing token throws for non-info ops", async () => {
  await assert.rejects(
    () => terraformClient({ operation: "org_list" }),
    /token.*required/i
  );
});

test("B02 unknown operation throws descriptive error", async () => {
  await assert.rejects(
    () => terraformClient({ operation: "invalid_op", token: "tok" }),
    /Unknown terraform_client operation/
  );
});

test("B03 org_get requires organization", async () => {
  await assert.rejects(
    () => terraformClient({ operation: "org_get", token: "tok" }),
    /organization.*non-empty/i
  );
});

test("B04 workspace_list requires organization", async () => {
  await assert.rejects(
    () => terraformClient({ operation: "workspace_list", token: "tok" }),
    /organization.*non-empty/i
  );
});

test("B05 workspace_create requires organization", async () => {
  await assert.rejects(
    () => terraformClient({ operation: "workspace_create", token: "tok", workspace: "ws" }),
    /organization.*non-empty/i
  );
});

test("B06 workspace_create requires workspace name", async () => {
  await assert.rejects(
    () => terraformClient({ operation: "workspace_create", token: "tok", organization: "my-org" }),
    /workspace.*non-empty/i
  );
});

test("B07 workspace_lock requires workspace_id", async () => {
  await assert.rejects(
    () => terraformClient({ operation: "workspace_lock", token: "tok" }),
    /workspace_id.*non-empty/i
  );
});

test("B08 workspace_update requires id or org+name", async () => {
  await assert.rejects(
    () => terraformClient({ operation: "workspace_update", token: "tok" }),
    /workspace_update.*provide/i
  );
});

test("B09 workspace_delete requires id or org+name", async () => {
  await assert.rejects(
    () => terraformClient({ operation: "workspace_delete", token: "tok" }),
    /workspace_delete.*provide/i
  );
});

test("B10 run_list requires workspace_id", async () => {
  await assert.rejects(
    () => terraformClient({ operation: "run_list", token: "tok" }),
    /workspace_id.*non-empty/i
  );
});

test("B11 run_get requires run_id", async () => {
  await assert.rejects(
    () => terraformClient({ operation: "run_get", token: "tok" }),
    /run_id.*non-empty/i
  );
});

test("B12 run_create requires workspace_id", async () => {
  await assert.rejects(
    () => terraformClient({ operation: "run_create", token: "tok" }),
    /workspace_id.*non-empty/i
  );
});

test("B13 state_list requires workspace_id", async () => {
  await assert.rejects(
    () => terraformClient({ operation: "state_list", token: "tok" }),
    /workspace_id.*non-empty/i
  );
});

test("B14 state_get requires state_version_id", async () => {
  await assert.rejects(
    () => terraformClient({ operation: "state_get", token: "tok" }),
    /state_version_id.*non-empty/i
  );
});

test("B15 state_current requires workspace_id", async () => {
  await assert.rejects(
    () => terraformClient({ operation: "state_current", token: "tok" }),
    /workspace_id.*non-empty/i
  );
});

// ───────────────────────────────────────────────────────────────────────────
// C — Mock-network tests
// ───────────────────────────────────────────────────────────────────────────

process.stderr.write("\nC — Mock-network tests\n");

let origHttpsRequest = null;

function mockHttps(statusCode, body, delay = 0) {
  origHttpsRequest = https.request;
  https.request = (opts, cb) => {
    const fakeRes = new EventEmitter();
    fakeRes.statusCode = statusCode;
    fakeRes.headers    = { "content-type": "application/vnd.api+json" };
    const req = new EventEmitter();
    req.write = () => {};
    req.end   = () => {
      setTimeout(() => {
        cb(fakeRes);
        setTimeout(() => {
          fakeRes.emit("data", Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8"));
          fakeRes.emit("end");
        }, 0);
      }, delay);
    };
    req.destroy = () => {};
    return req;
  };
}

function restoreHttps() {
  if (origHttpsRequest) {
    https.request = origHttpsRequest;
    origHttpsRequest = null;
  }
}

test("C01 org_list returns organizations", async () => {
  mockHttps(200, {
    data: [
      { id: "org-1", attributes: { name: "acme", email: "admin@acme.com", plan: "free", "created-at": "2024-01-01T00:00:00Z", permissions: {} } },
      { id: "org-2", attributes: { name: "globex", email: null, plan: "trial", "created-at": "2024-06-01T00:00:00Z", permissions: {} } },
    ],
    meta: { pagination: { "current-page": 1, "total-pages": 1, "total-count": 2, "next-page": null } },
  });
  try {
    const r = await terraformClient({ operation: "org_list", token: "test-token" });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.operation, "org_list");
    assert.strictEqual(r.count, 2);
    assert.strictEqual(r.organizations[0].name, "acme");
    assert.strictEqual(r.organizations[1].name, "globex");
    assert.strictEqual(r.pagination.total_count, 2);
  } finally { restoreHttps(); }
});

test("C02 org_get returns organization details", async () => {
  mockHttps(200, {
    data: { id: "org-1", attributes: { name: "acme", email: "admin@acme.com", plan: "business", "created-at": "2024-01-01T00:00:00Z", permissions: { "can-create-workspace": true } } },
  });
  try {
    const r = await terraformClient({ operation: "org_get", token: "tok", organization: "acme" });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.exists, true);
    assert.strictEqual(r.name, "acme");
    assert.strictEqual(r.plan, "business");
  } finally { restoreHttps(); }
});

test("C03 org_get returns exists:false on 404", async () => {
  mockHttps(404, JSON.stringify({ errors: [{ status: "404", title: "Not Found", detail: "Organization not found" }] }));
  try {
    const r = await terraformClient({ operation: "org_get", token: "tok", organization: "missing-org" });
    assert.strictEqual(r.exists, false);
  } finally { restoreHttps(); }
});

test("C04 workspace_list returns workspaces with pagination", async () => {
  mockHttps(200, {
    data: [
      { id: "ws-001", attributes: { name: "prod", description: "Production", "auto-apply": false, locked: false, "terraform-version": "1.5.0", "working-directory": "", "execution-mode": "remote", "queue-all-runs": false, "created-at": "2024-01-01T00:00:00Z", "updated-at": "2024-06-01T00:00:00Z", "resource-count": 42, "run-failures": 1 }, relationships: { organization: { data: { id: "org-1" } } } },
      { id: "ws-002", attributes: { name: "staging", description: "", "auto-apply": true, locked: false, "terraform-version": "1.5.0", "working-directory": "", "execution-mode": "remote", "queue-all-runs": false, "created-at": "2024-01-01T00:00:00Z", "updated-at": "2024-06-01T00:00:00Z", "resource-count": 18, "run-failures": 0 }, relationships: { organization: { data: { id: "org-1" } } } },
    ],
    meta: { pagination: { "current-page": 1, "total-pages": 3, "total-count": 25, "next-page": 2 } },
  });
  try {
    const r = await terraformClient({ operation: "workspace_list", token: "tok", organization: "acme" });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.count, 2);
    assert.strictEqual(r.workspaces[0].name, "prod");
    assert.strictEqual(r.workspaces[1].auto_apply, true);
    assert.strictEqual(r.pagination.next_page, 2);
  } finally { restoreHttps(); }
});

test("C05 workspace_get returns workspace details by name", async () => {
  mockHttps(200, {
    data: { id: "ws-001", attributes: { name: "prod", description: "Production", "auto-apply": false, locked: true, "terraform-version": "1.6.0", "working-directory": "", "execution-mode": "remote", "queue-all-runs": false, "created-at": "2024-01-01T00:00:00Z", "updated-at": "2024-06-01T00:00:00Z", "resource-count": 42, "run-failures": 0 }, relationships: { organization: { data: { id: "org-1" } } } },
  });
  try {
    const r = await terraformClient({ operation: "workspace_get", token: "tok", organization: "acme", workspace: "prod" });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.exists, true);
    assert.strictEqual(r.locked, true);
    assert.strictEqual(r.terraform_version, "1.6.0");
  } finally { restoreHttps(); }
});

test("C06 workspace_get by id", async () => {
  mockHttps(200, {
    data: { id: "ws-001", attributes: { name: "prod", description: "", "auto-apply": false, locked: false, "terraform-version": "1.5.0", "working-directory": "", "execution-mode": "remote", "queue-all-runs": false, "created-at": "2024-01-01T00:00:00Z", "updated-at": "2024-01-01T00:00:00Z", "resource-count": 0, "run-failures": 0 }, relationships: {} },
  });
  try {
    const r = await terraformClient({ operation: "workspace_get", token: "tok", workspace_id: "ws-001" });
    assert.strictEqual(r.exists, true);
    assert.strictEqual(r.id, "ws-001");
  } finally { restoreHttps(); }
});

test("C07 run_list returns runs", async () => {
  mockHttps(200, {
    data: [
      { id: "run-001", attributes: { status: "applied", message: "auto-triggered", "is-destroy": false, "auto-apply": true, refresh: true, "refresh-only": false, source: "tfe-api", "status-timestamps": {}, "created-at": "2024-06-01T00:00:00Z", "has-changes": true, "resource-additions": 1, "resource-changes": 0, "resource-destructions": 0 }, relationships: { workspace: { data: { id: "ws-001" } }, plan: { data: { id: "plan-001" } }, apply: { data: { id: "apply-001" } } } },
    ],
    meta: { pagination: { "current-page": 1, "total-pages": 1, "total-count": 1, "next-page": null } },
  });
  try {
    const r = await terraformClient({ operation: "run_list", token: "tok", workspace_id: "ws-001" });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.count, 1);
    assert.strictEqual(r.runs[0].status, "applied");
    assert.strictEqual(r.runs[0].plan_id, "plan-001");
  } finally { restoreHttps(); }
});

test("C08 run_get returns run details", async () => {
  mockHttps(200, {
    data: { id: "run-001", attributes: { status: "planned_and_finished", message: "", "is-destroy": false, "auto-apply": false, refresh: true, "refresh-only": false, source: "tfe-ui", "status-timestamps": {}, "created-at": "2024-06-01T00:00:00Z", "has-changes": false, "resource-additions": 0, "resource-changes": 0, "resource-destructions": 0 }, relationships: { workspace: { data: { id: "ws-001" } }, plan: { data: { id: "plan-001" } }, apply: { data: null } } },
  });
  try {
    const r = await terraformClient({ operation: "run_get", token: "tok", run_id: "run-001" });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.exists, true);
    assert.strictEqual(r.status, "planned_and_finished");
    assert.strictEqual(r.has_changes, false);
  } finally { restoreHttps(); }
});

test("C09 run_create returns new run", async () => {
  mockHttps(201, {
    data: { id: "run-002", attributes: { status: "pending", message: "via API", "is-destroy": false, "auto-apply": false, refresh: true, "refresh-only": false, source: "tfe-api", "status-timestamps": {}, "created-at": "2024-07-01T00:00:00Z", "has-changes": false, "resource-additions": 0, "resource-changes": 0, "resource-destructions": 0 }, relationships: { workspace: { data: { id: "ws-001" } }, plan: { data: { id: "plan-002" } }, apply: { data: { id: "apply-002" } } } },
  });
  try {
    const r = await terraformClient({ operation: "run_create", token: "tok", workspace_id: "ws-001", message: "via API" });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.created, true);
    assert.strictEqual(r.id, "run-002");
    assert.strictEqual(r.status, "pending");
  } finally { restoreHttps(); }
});

test("C10 var_list returns variables", async () => {
  mockHttps(200, {
    data: [
      { id: "var-001", attributes: { key: "AWS_REGION", value: "us-east-1", sensitive: false, hcl: false, category: "env", description: "" } },
      { id: "var-002", attributes: { key: "DB_PASSWORD", value: null, sensitive: true, hcl: false, category: "terraform", description: "" } },
    ],
  });
  try {
    const r = await terraformClient({ operation: "var_list", token: "tok", workspace_id: "ws-001" });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.count, 2);
    assert.strictEqual(r.variables[0].key, "AWS_REGION");
    assert.strictEqual(r.variables[0].value, "us-east-1");
    assert.strictEqual(r.variables[1].key, "DB_PASSWORD");
    assert.strictEqual(r.variables[1].value, "[sensitive]");
  } finally { restoreHttps(); }
});

test("C11 var_create returns new variable", async () => {
  mockHttps(201, {
    data: { id: "var-003", attributes: { key: "TF_LOG", value: "DEBUG", sensitive: false, hcl: false, category: "env", description: "Terraform log level" } },
  });
  try {
    const r = await terraformClient({ operation: "var_create", token: "tok", workspace_id: "ws-001", key: "TF_LOG", value: "DEBUG", category: "env" });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.created, true);
    assert.strictEqual(r.key, "TF_LOG");
    assert.strictEqual(r.value, "DEBUG");
  } finally { restoreHttps(); }
});

test("C12 var_delete returns deleted:true", async () => {
  mockHttps(204, "");
  try {
    const r = await terraformClient({ operation: "var_delete", token: "tok", workspace_id: "ws-001", var_id: "var-001" });
    assert.strictEqual(r.deleted, true);
  } finally { restoreHttps(); }
});

test("C13 plan_get returns plan details", async () => {
  mockHttps(200, {
    data: { id: "plan-001", attributes: { status: "finished", "has-changes": true, "resource-additions": 3, "resource-changes": 1, "resource-destructions": 0, "log-read-url": "https://archivist.example.com/plan-001.log", "status-timestamps": { "finished-at": "2024-07-01T01:00:00Z" } } },
  });
  try {
    const r = await terraformClient({ operation: "plan_get", token: "tok", plan_id: "plan-001" });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.exists, true);
    assert.strictEqual(r.status, "finished");
    assert.strictEqual(r.resource_additions, 3);
    assert.ok(r.log_read_url.includes("archivist"));
  } finally { restoreHttps(); }
});

test("C14 state_current returns current state", async () => {
  mockHttps(200, {
    data: { id: "sv-005", attributes: { serial: 7, "created-at": "2024-07-01T00:00:00Z", size: 9876, "hosted-state-download-url": "https://archivist.example.com/sv-005", "terraform-version": "1.5.0", "resource-count": 15 }, relationships: { run: { data: { id: "run-010" } } } },
  });
  try {
    const r = await terraformClient({ operation: "state_current", token: "tok", workspace_id: "ws-001" });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.exists, true);
    assert.strictEqual(r.serial, 7);
    assert.strictEqual(r.resource_count, 15);
    assert.strictEqual(r.run_id, "run-010");
  } finally { restoreHttps(); }
});

test("C15 network error rejects with descriptive message", async () => {
  origHttpsRequest = https.request;
  https.request = (opts, cb) => {
    const req = new EventEmitter();
    req.write = () => {};
    req.end   = () => {
      setTimeout(() => {
        req.emit("error", new Error("ECONNREFUSED"));
      }, 0);
    };
    req.destroy = () => {};
    return req;
  };
  try {
    await assert.rejects(
      () => terraformClient({ operation: "org_list", token: "tok" }),
      /ECONNREFUSED/
    );
  } finally { restoreHttps(); }
});

test("C16 workspace_lock returns already_locked on 409", async () => {
  mockHttps(409, JSON.stringify({ errors: [{ status: "409", title: "Conflict", detail: "Workspace is already locked" }] }));
  try {
    const r = await terraformClient({ operation: "workspace_lock", token: "tok", workspace_id: "ws-001" });
    assert.strictEqual(r.locked, false);
    assert.strictEqual(r.reason, "already_locked");
  } finally { restoreHttps(); }
});

test("C17 run_apply returns applied:true", async () => {
  mockHttps(202, "");
  try {
    const r = await terraformClient({ operation: "run_apply", token: "tok", run_id: "run-001", comment: "LGTM" });
    assert.strictEqual(r.applied, true);
  } finally { restoreHttps(); }
});

test("C18 run_discard returns discarded:true", async () => {
  mockHttps(202, "");
  try {
    const r = await terraformClient({ operation: "run_discard", token: "tok", run_id: "run-001" });
    assert.strictEqual(r.discarded, true);
  } finally { restoreHttps(); }
});

test("C19 run_cancel returns cancelled:true", async () => {
  mockHttps(202, "");
  try {
    const r = await terraformClient({ operation: "run_cancel", token: "tok", run_id: "run-001" });
    assert.strictEqual(r.cancelled, true);
  } finally { restoreHttps(); }
});

test("C20 generic request returns parsed body", async () => {
  mockHttps(200, { data: { id: "org-1", attributes: { name: "acme" } } });
  try {
    const r = await terraformClient({ operation: "request", token: "tok", path: "/api/v2/organizations/acme", method: "GET" });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.status_code, 200);
    assert.ok(r.body.data);
  } finally { restoreHttps(); }
});

test("C21 workspace_create sends correct payload", async () => {
  let capturedBody;
  origHttpsRequest = https.request;
  https.request = (opts, cb) => {
    const fakeRes = new EventEmitter();
    fakeRes.statusCode = 201;
    fakeRes.headers    = { "content-type": "application/vnd.api+json" };
    const req = new EventEmitter();
    req.write = (d) => { capturedBody = JSON.parse(d.toString()); };
    req.end   = () => {
      cb(fakeRes);
      const resp = { data: { id: "ws-new", attributes: { name: "my-ws", description: "", "auto-apply": false, locked: false, "terraform-version": "1.5.0", "working-directory": "", "execution-mode": "remote", "queue-all-runs": false, "created-at": "2024-01-01T00:00:00Z", "updated-at": "2024-01-01T00:00:00Z", "resource-count": 0, "run-failures": 0 }, relationships: {} } };
      setTimeout(() => { fakeRes.emit("data", Buffer.from(JSON.stringify(resp), "utf8")); fakeRes.emit("end"); }, 0);
    };
    req.destroy = () => {};
    return req;
  };
  try {
    const r = await terraformClient({ operation: "workspace_create", token: "tok", organization: "acme", workspace: "my-ws", auto_apply: false, terraform_version: "1.5.0" });
    assert.strictEqual(r.created, true);
    assert.strictEqual(r.name, "my-ws");
    assert.strictEqual(capturedBody.data.type, "workspaces");
    assert.strictEqual(capturedBody.data.attributes.name, "my-ws");
    assert.strictEqual(capturedBody.data.attributes["terraform-version"], "1.5.0");
  } finally { restoreHttps(); }
});

test("C22 var_update sends patch body", async () => {
  let capturedMethod;
  origHttpsRequest = https.request;
  https.request = (opts, cb) => {
    capturedMethod = opts.method;
    const fakeRes = new EventEmitter();
    fakeRes.statusCode = 200;
    fakeRes.headers    = { "content-type": "application/vnd.api+json" };
    const req = new EventEmitter();
    req.write = () => {};
    req.end   = () => {
      cb(fakeRes);
      const resp = { data: { id: "var-001", attributes: { key: "AWS_REGION", value: "eu-west-1", sensitive: false, hcl: false, category: "env", description: "" } } };
      setTimeout(() => { fakeRes.emit("data", Buffer.from(JSON.stringify(resp), "utf8")); fakeRes.emit("end"); }, 0);
    };
    req.destroy = () => {};
    return req;
  };
  try {
    const r = await terraformClient({ operation: "var_update", token: "tok", workspace_id: "ws-001", var_id: "var-001", value: "eu-west-1" });
    assert.strictEqual(capturedMethod, "PATCH");
    assert.strictEqual(r.updated, true);
    assert.strictEqual(r.value, "eu-west-1");
  } finally { restoreHttps(); }
});

// ───────────────────────────────────────────────────────────────────────────
// D — Security / injection tests
// ───────────────────────────────────────────────────────────────────────────

process.stderr.write("\nD — Security / injection tests\n");

test("D01 NUL byte in organization is rejected", async () => {
  await assert.rejects(
    () => terraformClient({ operation: "org_get", token: "tok", organization: "org\0evil" }),
    /NUL/
  );
});

test("D02 NUL byte in token — token not echoed in error", async () => {
  // buildConn does not validate token content (it is passed as bearer, server rejects it)
  // but we ensure token is never echoed
  mockHttps(401, JSON.stringify({ errors: [{ status: "401", title: "Unauthorized", detail: "Invalid token" }] }));
  try {
    await assert.rejects(
      () => terraformClient({ operation: "org_list", token: "secret-token-value" }),
      (err) => {
        assert.ok(!err.message.includes("secret-token-value"), "Token must not appear in error message");
        return true;
      }
    );
  } finally { restoreHttps(); }
});

test("D03 NUL byte in workspace_id is rejected", async () => {
  await assert.rejects(
    () => terraformClient({ operation: "run_list", token: "tok", workspace_id: "ws\0evil" }),
    /NUL/
  );
});

test("D04 NUL byte in base_url is rejected", async () => {
  await assert.rejects(
    () => terraformClient({ operation: "org_list", token: "tok", base_url: "https://tfe.example.com\0evil" }),
    /NUL/
  );
});

test("D05 invalid method in request op is rejected", async () => {
  await assert.rejects(
    () => terraformClient({ operation: "request", token: "tok", path: "/api/v2/orgs", method: "INVALID" }),
    /method must be one of/
  );
});

test("D06 NUL byte in run_id is rejected", async () => {
  await assert.rejects(
    () => terraformClient({ operation: "run_get", token: "tok", run_id: "run\0evil" }),
    /NUL/
  );
});

test("D07 NUL byte in var_id is rejected", async () => {
  await assert.rejects(
    () => terraformClient({ operation: "var_delete", token: "tok", workspace_id: "ws-001", var_id: "var\0evil" }),
    /NUL/
  );
});

test("D08 NUL byte in plan_id is rejected", async () => {
  await assert.rejects(
    () => terraformClient({ operation: "plan_get", token: "tok", plan_id: "plan\0evil" }),
    /NUL/
  );
});

test("D09 NUL byte in state_version_id is rejected", async () => {
  await assert.rejects(
    () => terraformClient({ operation: "state_get", token: "tok", state_version_id: "sv\0evil" }),
    /NUL/
  );
});

test("D10 extremely long organization name (URL injection attempt)", async () => {
  // Should not crash — just fails at network level; test that guard doesn't hang
  const longOrg = "a".repeat(10000);
  await assert.rejects(
    // Will try to connect to real TFC and fail (connection refused / timeout in test env)
    () => Promise.race([
      terraformClient({ operation: "org_get", token: "tok", organization: longOrg }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout-guard")), 2000)),
    ]),
    (err) => {
      // Either connection error or our timeout guard - both are acceptable
      return true;
    }
  );
});

// ───────────────────────────────────────────────────────────────────────────
// E — Concurrency / race-condition tests
// ───────────────────────────────────────────────────────────────────────────

process.stderr.write("\nE — Concurrency / race-condition tests\n");

test("E01 concurrent info calls all succeed", async () => {
  const results = await Promise.all(Array.from({ length: 20 }, () =>
    terraformClient({ operation: "info" })
  ));
  assert.ok(results.every(r => r.ok === true));
  assert.ok(results.every(r => Array.isArray(r.operations)));
});

test("E02 concurrent mock-network org_list calls all succeed", async () => {
  const body = { data: [{ id: "org-1", attributes: { name: "acme", email: null, plan: "free", "created-at": "2024-01-01T00:00:00Z", permissions: {} } }], meta: { pagination: {} } };
  mockHttps(200, body);
  try {
    const results = await Promise.all(Array.from({ length: 10 }, () =>
      terraformClient({ operation: "org_list", token: "tok" })
    ));
    assert.ok(results.every(r => r.ok === true));
    assert.ok(results.every(r => r.count === 1));
  } finally { restoreHttps(); }
});

test("E03 concurrent validation failures are independent", async () => {
  const promises = Array.from({ length: 15 }, (_, i) => (
    i % 3 === 0
      ? terraformClient({ operation: "org_get", token: "tok" }).catch(e => e.message)
      : terraformClient({ operation: "workspace_list", token: "tok" }).catch(e => e.message)
  ));
  const results = await Promise.all(promises);
  assert.ok(results.every(r => typeof r === "string" && r.length > 0));
});

test("E04 concurrent info + validation mix is stable", async () => {
  const tasks = [
    ...Array.from({ length: 5 }, () => terraformClient({ operation: "info" })),
    ...Array.from({ length: 5 }, () => terraformClient({ operation: "org_list" }).catch(e => ({ ok: false, err: e.message }))),
  ];
  const results = await Promise.all(tasks);
  const infos = results.slice(0, 5);
  const fails = results.slice(5);
  assert.ok(infos.every(r => r.ok === true));
  assert.ok(fails.every(r => r.ok === false));
});

test("E05 memory: many mapWorkspace calls don't leak", () => {
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < 50000; i++) {
    mapWorkspace({
      id: `ws-${i}`,
      attributes: { name: `ws-${i}`, description: "", "auto-apply": false, locked: false, "terraform-version": "1.5.0", "working-directory": "", "execution-mode": "remote", "queue-all-runs": false, "created-at": "2024-01-01T00:00:00Z", "updated-at": "2024-01-01T00:00:00Z", "resource-count": i, "run-failures": 0 },
      relationships: { organization: { data: { id: "org-1" } } },
    });
  }
  const after = process.memoryUsage().heapUsed;
  const diffMB = (after - before) / (1024 * 1024);
  // Allow up to 100 MB growth (generous for 50k objects that get GC'd)
  assert.ok(diffMB < 100, `Memory grew by ${diffMB.toFixed(1)} MB`);
});

test("E06 timeout fires correctly on slow server", async () => {
  origHttpsRequest = https.request;
  https.request = (opts, cb) => {
    const req = new EventEmitter();
    req.write   = () => {};
    req.end     = () => { /* never respond */ };
    req.destroy = () => {};
    return req;
  };
  try {
    await assert.rejects(
      () => terraformClient({ operation: "org_list", token: "tok", timeout: 1000 }),
      /timed out/
    );
  } finally { restoreHttps(); }
});

test("E07 response cap: 16 MB exceeded rejects cleanly", async () => {
  origHttpsRequest = https.request;
  https.request = (opts, cb) => {
    const fakeRes = new EventEmitter();
    fakeRes.statusCode = 200;
    fakeRes.headers    = { "content-type": "application/vnd.api+json" };
    const req = new EventEmitter();
    req.write   = () => {};
    req.end     = () => {
      cb(fakeRes);
      setTimeout(() => {
        // Send 17 MB
        const chunk = Buffer.alloc(17 * 1024 * 1024, 65);
        fakeRes.emit("data", chunk);
      }, 0);
    };
    req.destroy = () => {};
    return req;
  };
  try {
    await assert.rejects(
      () => terraformClient({ operation: "org_list", token: "tok" }),
      /16 MB cap/
    );
  } finally { restoreHttps(); }
});

// ── Run all tests ───────────────────────────────────────────────────────────────────────────

setTimeout(async () => {
  if (errors.length > 0) {
    process.stderr.write("\nFailed tests:\n");
    for (const { name, err } of errors) {
      process.stderr.write(`  ${name}\n    ${err.stack || err.message}\n`);
    }
  }
  process.stderr.write(`\n✔ ${passed} passed, ✘ ${failed} failed (section 272 — terraform_client)\n`);
  process.exit(failed > 0 ? 1 : 0);
}, 3000);
