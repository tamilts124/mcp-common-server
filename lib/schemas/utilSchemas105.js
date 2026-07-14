"use strict";

const TERRAFORM_CLIENT_SCHEMA = {
  name: "terraform_client",
  description: "Zero-dependency Terraform Cloud / Terraform Enterprise REST API v2 client — pure Node.js https built-ins; no npm deps. Authenticates via API token (Bearer). Default base URL: https://app.terraform.io (override with base_url for TFE). Supported operations: Organizations (org_list, org_get), Workspaces (workspace_list, workspace_get, workspace_create, workspace_update, workspace_delete, workspace_lock, workspace_unlock), Runs (run_list, run_get, run_create, run_apply, run_discard, run_cancel), State Versions (state_list, state_get, state_current), Variables (var_list, var_create, var_update, var_delete), Plans (plan_get, plan_log), Applies (apply_get, apply_log), generic authenticated request, and info.",
  inputSchema: {
    type: "object",
    required: ["operation"],
    properties: {
      operation: {
        type: "string",
        description: "Operation to perform. One of: org_list, org_get, workspace_list, workspace_get, workspace_create, workspace_update, workspace_delete, workspace_lock, workspace_unlock, run_list, run_get, run_create, run_apply, run_discard, run_cancel, state_list, state_get, state_current, var_list, var_create, var_update, var_delete, plan_get, plan_log, apply_get, apply_log, request, info.",
      },
      // ── Auth / Connection ─────────────────────────────────────────────────────
      token: {
        type: "string",
        description: "Terraform Cloud / Enterprise API token. Required for all operations except 'info'. Never returned in output or errors.",
      },
      base_url: {
        type: "string",
        description: "Base URL of the Terraform API (default: 'https://app.terraform.io'). Override for Terraform Enterprise (e.g. 'https://tfe.example.com').",
      },
      timeout: {
        type: "number",
        description: "Request timeout in milliseconds (1000–120000, default: 20000).",
      },
      reject_unauthorized: {
        type: "boolean",
        description: "Reject invalid TLS certificates (default: true). Set false for self-signed certs in dev/TFE environments.",
      },
      // ── Organization ──────────────────────────────────────────────────────
      organization: {
        type: "string",
        description: "Organization name (slug). Required for org_get, workspace_list, workspace_get (by name), workspace_create.",
      },
      // ── Workspace ─────────────────────────────────────────────────────────
      workspace: {
        type: "string",
        description: "Workspace name. Required for workspace_get (with organization), workspace_create. Also used in workspace_update and workspace_delete when workspace_id is not provided.",
      },
      workspace_id: {
        type: "string",
        description: "Workspace ID (e.g. 'ws-abc123'). Alternative to organization+workspace for workspace_get, workspace_update, workspace_delete. Required for workspace_lock, workspace_unlock, run_list, var_list, var_create.",
      },
      description: {
        type: "string",
        description: "Human-readable description. Used in workspace_create, workspace_update, var_create, var_update.",
      },
      auto_apply: {
        type: "boolean",
        description: "workspace_create/workspace_update: automatically apply successful plans without confirmation. run_create: auto-apply this specific run.",
      },
      terraform_version: {
        type: "string",
        description: "Terraform version to use (e.g. '1.5.0'). Used in workspace_create and workspace_update.",
      },
      working_directory: {
        type: "string",
        description: "Relative path within the VCS repo (or config upload) to use as root. Used in workspace_create and workspace_update.",
      },
      queue_all_runs: {
        type: "boolean",
        description: "workspace_create/workspace_update: auto-queue runs on VCS push for all branches.",
      },
      execution_mode: {
        type: "string",
        description: "workspace_create/workspace_update: execution mode — 'remote', 'local', or 'agent'.",
      },
      agent_pool_id: {
        type: "string",
        description: "workspace_create/workspace_update: agent pool ID when execution_mode is 'agent'.",
      },
      new_name: {
        type: "string",
        description: "workspace_update: rename the workspace to this value.",
      },
      reason: {
        type: "string",
        description: "workspace_lock: reason string for the lock.",
      },
      search: {
        type: "string",
        description: "workspace_list: filter workspaces by name substring.",
      },
      // ── Runs ──────────────────────────────────────────────────────────────
      run_id: {
        type: "string",
        description: "Run ID (e.g. 'run-abc123'). Required for run_get, run_apply, run_discard, run_cancel, plan_log (via plan).",
      },
      message: {
        type: "string",
        description: "run_create: optional message describing the run.",
      },
      is_destroy: {
        type: "boolean",
        description: "run_create: if true, creates a destroy run (terraform destroy).",
      },
      refresh: {
        type: "boolean",
        description: "run_create: whether to refresh state before planning (default: true).",
      },
      refresh_only: {
        type: "boolean",
        description: "run_create: perform a refresh-only run (no plan/apply).",
      },
      target_addrs: {
        type: "array",
        items: { type: "string" },
        description: "run_create: list of resource addresses to target (e.g. ['module.vpc', 'aws_instance.web']).",
      },
      replace_addrs: {
        type: "array",
        items: { type: "string" },
        description: "run_create: list of resource addresses to force replacement.",
      },
      configuration_version_id: {
        type: "string",
        description: "run_create: configuration version ID to use (default: uses latest uploaded config).",
      },
      comment: {
        type: "string",
        description: "run_apply / run_discard / run_cancel: optional comment for the action.",
      },
      // ── State ───────────────────────────────────────────────────────────────
      state_version_id: {
        type: "string",
        description: "State version ID (e.g. 'sv-abc123'). Required for state_get.",
      },
      // ── Variables ──────────────────────────────────────────────────────────
      var_id: {
        type: "string",
        description: "Variable ID (e.g. 'var-abc123'). Required for var_update, var_delete.",
      },
      key: {
        type: "string",
        description: "Variable key (name). Required for var_create. Optional for var_update (to rename).",
      },
      value: {
        type: "string",
        description: "Variable value. Used in var_create and var_update. Sensitive variables are not returned in responses.",
      },
      category: {
        type: "string",
        description: "Variable category: 'terraform' (default, Terraform input variables) or 'env' (environment variables).",
      },
      hcl: {
        type: "boolean",
        description: "var_create/var_update: if true, the value is parsed as HCL (e.g. for lists/maps). Default: false.",
      },
      sensitive: {
        type: "boolean",
        description: "var_create/var_update: if true, the variable is marked sensitive (write-only). Default: false.",
      },
      // ── Plans / Applies ──────────────────────────────────────────────────────
      plan_id: {
        type: "string",
        description: "Plan ID (e.g. 'plan-abc123'). Required for plan_get and plan_log.",
      },
      apply_id: {
        type: "string",
        description: "Apply ID (e.g. 'apply-abc123'). Required for apply_get and apply_log.",
      },
      max_lines: {
        type: "number",
        description: "plan_log / apply_log: maximum number of log lines to return (1–10000, default: 1000).",
      },
      // ── Pagination ─────────────────────────────────────────────────────────
      page_number: {
        type: "number",
        description: "Page number for paginated list operations (org_list, workspace_list, run_list, state_list). Default: 1.",
      },
      page_size: {
        type: "number",
        description: "Page size for paginated list operations (1–100, default: 20).",
      },
      // ── Generic request ─────────────────────────────────────────────────────
      path: {
        type: "string",
        description: "API path for the generic 'request' operation (e.g. '/api/v2/organizations/my-org/workspaces').",
      },
      method: {
        type: "string",
        description: "HTTP method for the generic 'request' operation: GET, POST, PUT, DELETE, HEAD, PATCH.",
      },
      body: {
        type: ["string", "object"],
        description: "Request body for the generic 'request' operation. Objects are JSON-serialized.",
      },
    },
  },
};

module.exports = { TERRAFORM_CLIENT_SCHEMA };
