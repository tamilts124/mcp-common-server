"use strict";

const PAGERDUTY_CLIENT_SCHEMA = {
  name: "pagerduty_client",
  description:
    "Zero-dependency PagerDuty REST API v2 client (pure Node.js https built-ins; no npm deps). " +
    "Auth: api_key (Token token=<key>) or OAuth2 Bearer access_token. " +
    "Base URL: https://api.pagerduty.com. " +
    "Credentials never returned in output or errors. " +
    "40 operations: " +
    "Incidents (incident_get, incident_list, incident_create, incident_update, incident_acknowledge, incident_resolve, incident_merge); " +
    "Notes (note_list, note_create); " +
    "Services (service_get, service_list, service_create, service_update, service_delete); " +
    "Escalation Policies (escalation_policy_get, escalation_policy_list, escalation_policy_create, escalation_policy_delete); " +
    "Users (user_get, user_list, user_create, user_update, user_delete); " +
    "Teams (team_get, team_list, team_create, team_delete, team_members); " +
    "Schedules/On-call (schedule_get, schedule_list, oncall_list); " +
    "Alerts (alert_list); " +
    "Log Entries (log_entry_get, log_entry_list); " +
    "Abilities (abilities_list); " +
    "Generic (request, info). " +
    "Response capped at 16 MB; timeout 1-120 s (default 20 s).",
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        description:
          "Operation to perform. " +
          "Incidents: incident_get, incident_list, incident_create, incident_update, incident_acknowledge, incident_resolve, incident_merge. " +
          "Notes: note_list, note_create. " +
          "Services: service_get, service_list, service_create, service_update, service_delete. " +
          "Escalation Policies: escalation_policy_get, escalation_policy_list, escalation_policy_create, escalation_policy_delete. " +
          "Users: user_get, user_list, user_create, user_update, user_delete. " +
          "Teams: team_get, team_list, team_create, team_delete, team_members. " +
          "Schedules/On-call: schedule_get, schedule_list, oncall_list. " +
          "Alerts: alert_list. " +
          "Log Entries: log_entry_get, log_entry_list. " +
          "Abilities: abilities_list. " +
          "Generic: request, info.",
        enum: [
          // Incidents
          "incident_get", "incident_list", "incident_create", "incident_update",
          "incident_acknowledge", "incident_resolve", "incident_merge",
          // Notes
          "note_list", "note_create",
          // Services
          "service_get", "service_list", "service_create", "service_update", "service_delete",
          // Escalation Policies
          "escalation_policy_get", "escalation_policy_list",
          "escalation_policy_create", "escalation_policy_delete",
          // Users
          "user_get", "user_list", "user_create", "user_update", "user_delete",
          // Teams
          "team_get", "team_list", "team_create", "team_delete", "team_members",
          // Schedules / On-call
          "schedule_get", "schedule_list", "oncall_list",
          // Alerts
          "alert_list",
          // Log Entries
          "log_entry_get", "log_entry_list",
          // Abilities
          "abilities_list",
          // Generic
          "request", "info",
        ],
      },

      // ─── Auth ───────────────────────────────────────────────────────────────────────
      api_key: {
        type: "string",
        description:
          "PagerDuty API key (REST API key from Configuration → API Access Keys). " +
          "Used as: Authorization: Token token=<api_key>. Never echoed in output.",
      },
      access_token: {
        type: "string",
        description:
          "OAuth2 Bearer access token. Alternative to api_key. Never echoed in output.",
      },
      from_email: {
        type: "string",
        description:
          "[incident_create, incident_update, incident_acknowledge, incident_resolve, note_create] " +
          "Email address of the PagerDuty user performing the action. Required by PagerDuty API for write operations on incidents.",
      },

      // ─── Connection ───────────────────────────────────────────────────────────
      timeout: {
        type: "number",
        description: "Request timeout in milliseconds (1000-120000). Default: 20000.",
      },
      reject_unauthorized: {
        type: "boolean",
        description: "Reject TLS certificates that are invalid/self-signed (default: true). Set false only for dev.",
      },

      // ─── Incident fields ─────────────────────────────────────────────────────────
      incident_id: {
        type: "string",
        description:
          "[incident_get, incident_update, incident_acknowledge, incident_resolve, incident_merge, " +
          "note_list, note_create, alert_list] PagerDuty incident ID string.",
      },
      title: {
        type: "string",
        description: "[incident_create, incident_update] Incident title/summary.",
      },
      status: {
        type: "string",
        description: "[incident_update, incident_list] Incident status: triggered, acknowledged, resolved.",
        enum: ["triggered", "acknowledged", "resolved"],
      },
      statuses: {
        type: "array",
        items: { type: "string" },
        description: "[incident_list, alert_list] Filter by statuses array, e.g. ['triggered', 'acknowledged'].",
      },
      urgency: {
        type: "string",
        description: "[incident_create, incident_update, incident_list] Incident urgency: high or low.",
        enum: ["high", "low"],
      },
      body_details: {
        type: "string",
        description: "[incident_create] Detailed description of the incident body.",
      },
      resolution: {
        type: "string",
        description: "[incident_update, incident_resolve] Resolution notes/message.",
      },
      incident_key: {
        type: "string",
        description: "[incident_create] Deduplication key for the incident.",
      },
      assignments: {
        type: "array",
        items: { type: "string" },
        description: "[incident_create, incident_update] Array of user IDs to assign the incident to.",
      },
      source_ids: {
        type: "array",
        items: { type: "string" },
        description: "[incident_merge] Array of source incident IDs to merge into the target incident_id.",
      },
      sort_by: {
        type: "string",
        description: "[incident_list, service_list, user_list] Sort field.",
      },
      date_range: {
        type: "string",
        description: "[incident_list] Date range: 'all' to override the default 30-day range.",
      },

      // ─── Note fields ─────────────────────────────────────────────────────────────────────
      content: {
        type: "string",
        description: "[note_create] Note content text.",
      },

      // ─── Service fields ──────────────────────────────────────────────────────────────────
      service_id: {
        type: "string",
        description:
          "[service_get, service_update, service_delete, incident_create, incident_list] " +
          "PagerDuty service ID string.",
      },
      service_ids: {
        type: "array",
        items: { type: "string" },
        description: "[incident_list] Filter incidents by service IDs.",
      },
      description: {
        type: "string",
        description: "[service_create, service_update, team_create, user_create, user_update] Description.",
      },
      auto_resolve_timeout: {
        type: "number",
        description: "[service_create, service_update] Auto-resolve timeout in seconds. null to disable.",
      },
      acknowledgement_timeout: {
        type: "number",
        description: "[service_create, service_update] Acknowledgement timeout in seconds. null to disable.",
      },
      alert_creation: {
        type: "string",
        description: "[service_create] Alert creation: 'create_incidents' or 'create_alerts_and_incidents'.",
        enum: ["create_incidents", "create_alerts_and_incidents"],
      },

      // ─── Escalation Policy fields ────────────────────────────────────────────────────
      escalation_policy_id: {
        type: "string",
        description:
          "[escalation_policy_get, escalation_policy_delete, service_create, service_update, " +
          "incident_create, incident_update] PagerDuty escalation policy ID.",
      },
      escalation_policy_ids: {
        type: "array",
        items: { type: "string" },
        description: "[oncall_list] Filter on-calls by escalation policy IDs.",
      },
      escalation_rules: {
        type: "array",
        items: { type: "object" },
        description:
          "[escalation_policy_create] Array of escalation rule objects per PagerDuty API spec, " +
          "e.g. [{escalation_delay_in_minutes: 30, targets: [{id: 'USER_ID', type: 'user_reference'}]}].",
      },
      num_loops: {
        type: "number",
        description: "[escalation_policy_create] Number of times to loop the policy (0 = no looping).",
      },

      // ─── User fields ────────────────────────────────────────────────────────────────────
      user_id: {
        type: "string",
        description: "[user_get, user_update, user_delete] PagerDuty user ID string.",
      },
      user_ids: {
        type: "array",
        items: { type: "string" },
        description: "[user_list, oncall_list] Filter by user IDs.",
      },
      name: {
        type: "string",
        description: "[user_create, user_update, team_create] Name of the resource.",
      },
      email: {
        type: "string",
        description: "[user_create, user_update] User email address.",
      },
      role: {
        type: "string",
        description: "[user_create, user_update] User role: admin, user, limited_user, read_only_user, observer, restricted_access.",
        enum: ["admin", "user", "limited_user", "read_only_user", "observer", "restricted_access"],
      },
      time_zone: {
        type: "string",
        description: "[user_create, user_update, schedule_get, schedule_list, oncall_list] IANA timezone string.",
      },

      // ─── Team fields ─────────────────────────────────────────────────────────────────────
      team_id: {
        type: "string",
        description: "[team_get, team_delete, team_members] PagerDuty team ID string.",
      },
      team_ids: {
        type: "array",
        items: { type: "string" },
        description: "[incident_list, service_list, user_list, escalation_policy_list] Filter by team IDs.",
      },

      // ─── Schedule fields ───────────────────────────────────────────────────────────────
      schedule_id: {
        type: "string",
        description: "[schedule_get] PagerDuty schedule ID string.",
      },
      schedule_ids: {
        type: "array",
        items: { type: "string" },
        description: "[oncall_list] Filter on-calls by schedule IDs.",
      },

      // ─── Log Entry fields ────────────────────────────────────────────────────────────
      log_entry_id: {
        type: "string",
        description: "[log_entry_get] PagerDuty log entry ID string.",
      },
      is_overview: {
        type: "boolean",
        description: "[log_entry_list] If true, return only high-level details (overview entries).",
      },

      // ─── Shared / Pagination / Filter ────────────────────────────────────────────────
      limit: {
        type: "number",
        description: "Maximum results per page (1-100). Default: varies by operation.",
      },
      offset: {
        type: "number",
        description: "Pagination offset (0-based).",
      },
      query: {
        type: "string",
        description: "[service_list, user_list, team_list, schedule_list, escalation_policy_list] Text search query.",
      },
      since: {
        type: "string",
        description: "[incident_list, log_entry_list, oncall_list, schedule_get] Start date/time as ISO 8601 string.",
      },
      until: {
        type: "string",
        description: "[incident_list, log_entry_list, oncall_list, schedule_get] End date/time as ISO 8601 string.",
      },
      include: {
        type: "array",
        items: { type: "string" },
        description: "[various] Array of additional resources to include (sideloads), e.g. ['services', 'users'].",
      },
      alert_key: {
        type: "string",
        description: "[alert_list] Filter alerts by deduplication key.",
      },

      // ─── Generic request ──────────────────────────────────────────────────────────
      method: {
        type: "string",
        description: "[request] HTTP method: GET, POST, PUT, PATCH, DELETE. Default: GET.",
        enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      },
      path: {
        type: "string",
        description: "[request] API path (e.g. '/incidents/P123456'). Used as-is against https://api.pagerduty.com.",
      },
      body: {
        type: "object",
        description: "[request] Request body object for POST/PUT/PATCH operations.",
      },
    },
    required: ["operation"],
  },
};

module.exports = { PAGERDUTY_CLIENT_SCHEMA };
