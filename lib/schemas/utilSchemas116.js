"use strict";

const ZENDESK_CLIENT_SCHEMA = {
  name: "zendesk_client",
  description:
    "Zero-dependency Zendesk REST API client (pure Node.js https built-ins; no npm deps). " +
    "Auth: email + api_token (HTTP Basic: email/token:api_token) or oauth Bearer access_token. " +
    "Base URL: https://{subdomain}.zendesk.com/api/v2. " +
    "Credentials never returned in output or errors. " +
    "44 operations: " +
    "Tickets (ticket_get, ticket_list, ticket_create, ticket_update, ticket_delete, ticket_search, ticket_assign, ticket_set_status, ticket_bulk_update); " +
    "Comments (comment_list, comment_create); " +
    "Users (user_get, user_me, user_list, user_search, user_create, user_update, user_delete); " +
    "Organizations (org_get, org_list, org_create, org_update, org_delete); " +
    "Groups (group_get, group_list, group_create, group_update, group_delete, group_members); " +
    "Tags (tag_list, tag_add, tag_remove); " +
    "Attachments (attachment_upload); " +
    "Views (view_list, view_get, view_tickets); " +
    "Macros (macro_list, macro_apply); " +
    "Satisfaction (satisfaction_list, satisfaction_get); " +
    "Generic (request, info). " +
    "Response capped at 16 MB; timeout 1-120 s (default 20 s).",
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        description:
          "Operation to perform. " +
          "Tickets: ticket_get, ticket_list, ticket_create, ticket_update, ticket_delete, ticket_search, ticket_assign, ticket_set_status, ticket_bulk_update. " +
          "Comments: comment_list, comment_create. " +
          "Users: user_get, user_me, user_list, user_search, user_create, user_update, user_delete. " +
          "Organizations: org_get, org_list, org_create, org_update, org_delete. " +
          "Groups: group_get, group_list, group_create, group_update, group_delete, group_members. " +
          "Tags: tag_list, tag_add, tag_remove. " +
          "Attachments: attachment_upload. " +
          "Views: view_list, view_get, view_tickets. " +
          "Macros: macro_list, macro_apply. " +
          "Satisfaction: satisfaction_list, satisfaction_get. " +
          "Generic: request, info.",
        enum: [
          // Tickets
          "ticket_get", "ticket_list", "ticket_create", "ticket_update", "ticket_delete",
          "ticket_search", "ticket_assign", "ticket_set_status", "ticket_bulk_update",
          // Comments
          "comment_list", "comment_create",
          // Users
          "user_get", "user_me", "user_list", "user_search", "user_create", "user_update", "user_delete",
          // Organizations
          "org_get", "org_list", "org_create", "org_update", "org_delete",
          // Groups
          "group_get", "group_list", "group_create", "group_update", "group_delete", "group_members",
          // Tags
          "tag_list", "tag_add", "tag_remove",
          // Attachments
          "attachment_upload",
          // Views
          "view_list", "view_get", "view_tickets",
          // Macros
          "macro_list", "macro_apply",
          // Satisfaction
          "satisfaction_list", "satisfaction_get",
          // Generic
          "request", "info",
        ],
      },

      // ─── Auth ──────────────────────────────────────────────────────────────
      subdomain: {
        type: "string",
        description:
          "Zendesk subdomain (e.g. 'mycompany' for mycompany.zendesk.com). Required for all operations.",
      },
      email: {
        type: "string",
        description:
          "Agent email address for API Token auth (required when not using access_token). Never echoed in output.",
      },
      api_token: {
        type: "string",
        description:
          "Zendesk API Token (from Admin → Apps & Integrations → APIs → Zendesk API → Settings). " +
          "Used together with email as HTTP Basic: email/token:api_token. Never echoed in output.",
      },
      access_token: {
        type: "string",
        description:
          "OAuth2 Bearer access token. Alternative to email+api_token. Never echoed in output.",
      },

      // ─── Connection ────────────────────────────────────────────────────────
      timeout: {
        type: "number",
        description: "Request timeout in milliseconds (1000-120000). Default: 20000.",
      },
      reject_unauthorized: {
        type: "boolean",
        description: "Reject TLS certificates that are invalid/self-signed (default: true). Set false only for dev.",
      },

      // ─── Ticket fields ─────────────────────────────────────────────────────
      ticket_id: {
        type: "number",
        description:
          "[ticket_get, ticket_update, ticket_delete, ticket_assign, ticket_set_status, " +
          "comment_list, comment_create, tag_add, tag_remove] Zendesk ticket ID (numeric).",
      },
      ticket_ids: {
        type: "array",
        items: { type: "number" },
        description: "[ticket_bulk_update] Array of ticket IDs to update in bulk.",
      },
      subject: {
        type: "string",
        description: "[ticket_create, ticket_update] Ticket subject/title.",
      },
      comment_body: {
        type: "string",
        description:
          "[ticket_create, ticket_update, ticket_bulk_update] " +
          "Comment body text to add with the ticket create/update.",
      },
      comment_public: {
        type: "boolean",
        description:
          "[ticket_update, ticket_bulk_update] Whether comment is public (true) or internal note (false). Default: true.",
      },
      status: {
        type: "string",
        description:
          "[ticket_create, ticket_update, ticket_set_status, ticket_bulk_update, ticket_list] " +
          "Ticket status: new, open, pending, hold, solved, closed.",
        enum: ["new", "open", "pending", "hold", "solved", "closed"],
      },
      priority: {
        type: "string",
        description: "[ticket_create, ticket_update, ticket_bulk_update] Ticket priority: low, normal, high, urgent.",
        enum: ["low", "normal", "high", "urgent"],
      },
      type: {
        type: "string",
        description: "[ticket_create, ticket_update] Ticket type: problem, incident, question, task.",
        enum: ["problem", "incident", "question", "task"],
      },
      requester_id: {
        type: "number",
        description: "[ticket_create] Requester user ID.",
      },
      assignee_id: {
        type: "number",
        description:
          "[ticket_create, ticket_update, ticket_assign, ticket_bulk_update] " +
          "Assignee agent user ID. Pass null to unassign.",
      },
      group_id: {
        type: "number",
        description:
          "[ticket_create, ticket_update, ticket_assign, ticket_bulk_update] Group ID to assign the ticket to.",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description:
          "[ticket_create, ticket_update, ticket_bulk_update] Array of tags to set on the ticket. " +
          "[tag_add, tag_remove] Tags to add/remove on a specific ticket.",
      },
      due_at: {
        type: "string",
        description: "[ticket_create, ticket_update] Due date as ISO 8601 string (task tickets).",
      },
      external_id: {
        type: "string",
        description: "[ticket_create, user_create, user_update] External/third-party identifier.",
      },
      custom_fields: {
        type: "array",
        items: { type: "object" },
        description:
          "[ticket_create, ticket_update] Array of custom field objects, e.g. [{id: 123, value: 'foo'}].",
      },

      // ─── Comment fields ────────────────────────────────────────────────────
      body: {
        type: "string",
        description: "[comment_create] Comment body text.",
      },
      public_comment: {
        type: "boolean",
        description: "[comment_create] Whether comment is public (true, default) or internal note (false).",
      },
      author_id: {
        type: "number",
        description: "[comment_create] Author user ID for the comment.",
      },

      // ─── User fields ───────────────────────────────────────────────────────
      user_id: {
        type: "number",
        description: "[user_get, user_update, user_delete] Zendesk user ID (numeric).",
      },
      name: {
        type: "string",
        description:
          "[user_create, user_update, group_create, group_update, org_create, org_update] " +
          "Name for the resource.",
      },
      email_address: {
        type: "string",
        description: "[user_create, user_update] User email address.",
      },
      role: {
        type: "string",
        description: "[user_create, user_update, user_list] User role: end-user, agent, admin.",
        enum: ["end-user", "agent", "admin"],
      },
      phone: {
        type: "string",
        description: "[user_create, user_update] User phone number.",
      },
      organization_id: {
        type: "number",
        description: "[user_create, user_update, org_get, org_update, org_delete] Organization ID.",
      },
      verified: {
        type: "boolean",
        description: "[user_create, user_update] Whether user's email is verified.",
      },
      suspended: {
        type: "boolean",
        description: "[user_update] Whether to suspend the user.",
      },

      // ─── Organization fields ───────────────────────────────────────────────
      domain_names: {
        type: "array",
        items: { type: "string" },
        description: "[org_create, org_update] Domain names associated with the organization.",
      },
      notes: {
        type: "string",
        description: "[org_create, org_update] Notes about the organization.",
      },

      // ─── Group fields ─────────────────────────────────────────────────────
      group_id: {
        type: "number",
        description: "[group_get, group_update, group_delete, group_members] Zendesk group ID (numeric).",
      },
      description: {
        type: "string",
        description: "[group_create, group_update] Group description.",
      },

      // ─── View / Macro fields ──────────────────────────────────────────────
      view_id: {
        type: "number",
        description: "[view_get, view_tickets] Zendesk view ID (numeric).",
      },
      macro_id: {
        type: "number",
        description: "[macro_apply] Macro ID to apply to a ticket.",
      },

      // ─── Satisfaction fields ───────────────────────────────────────────────
      satisfaction_rating_id: {
        type: "number",
        description: "[satisfaction_get] Satisfaction rating ID (numeric).",
      },
      score: {
        type: "string",
        description: "[satisfaction_list] Filter by score: offered, unoffered, received, received_with_comment, received_without_comment, good, bad, good_with_comment, bad_with_comment.",
      },

      // ─── Attachment fields ────────────────────────────────────────────────
      filename: {
        type: "string",
        description: "[attachment_upload] Filename for the uploaded attachment.",
      },
      content_base64: {
        type: "string",
        description: "[attachment_upload] Base64-encoded file content to upload.",
      },
      mime_type: {
        type: "string",
        description: "[attachment_upload] MIME type of the file (default: application/octet-stream).",
      },

      // ─── Pagination & search ──────────────────────────────────────────────
      query: {
        type: "string",
        description:
          "[ticket_search, user_search] Search query string. " +
          "For ticket_search: Zendesk search syntax appended to 'type:ticket'. " +
          "For user_search: searches user name, email, etc.",
      },
      limit: {
        type: "number",
        description: "Maximum results per page (1-100). Default: varies by operation.",
      },
      page: {
        type: "number",
        description: "Page number for paginated results (1-based).",
      },

      // ─── Generic request ─────────────────────────────────────────────────
      method: {
        type: "string",
        description: "[request] HTTP method: GET, POST, PUT, PATCH, DELETE. Default: GET.",
        enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      },
      path: {
        type: "string",
        description: "[request] API v2 path (e.g. '/tickets/123.json'). Prepends /api/v2 automatically.",
      },
      body: {
        type: "object",
        description: "[request] Request body object for POST/PUT/PATCH operations.",
      },
    },
    required: ["operation", "subdomain"],
  },
};

module.exports = { ZENDESK_CLIENT_SCHEMA };
