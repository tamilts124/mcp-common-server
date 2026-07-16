"use strict";
/**
 * utilSchemas120.js
 * JSON Schema for the sendgrid_client tool.
 */

const SENDGRID_CLIENT_SCHEMA = {
  name: "sendgrid_client",
  description: [
    "Zero-dependency SendGrid Web API v3 client (pure Node.js https built-ins; no npm deps).",
    "Auth: api_key (Bearer SG.*). Credentials are never returned in output or errors.",
    "",
    "Operations (52 total):",
    "  Email (1): mail_send (transactional + marketing email, templates, attachments, scheduling)",
    "  Contacts (5): contact_upsert, contact_search, contact_get, contact_delete, contact_count",
    "  Lists (7): list_create, list_get, list_get_all, list_update, list_delete,",
    "    list_add_contacts, list_remove_contacts",
    "  Templates (6): template_create, template_get, template_list, template_delete,",
    "    template_version_create, template_version_activate",
    "  Suppressions (6): suppression_get, suppression_delete,",
    "    unsubscribe_group_create, unsubscribe_group_list, unsubscribe_group_get,",
    "    unsubscribe_group_delete",
    "  Senders (5): sender_create, sender_list, sender_get, sender_delete, sender_verify",
    "  Statistics (3): stats_global, stats_category, stats_template",
    "  API Keys (4): api_key_create, api_key_list, api_key_get, api_key_delete",
    "  Scheduled Sends (4): scheduled_send_create, scheduled_send_list,",
    "    scheduled_send_delete, batch_id_generate",
    "  User/Account (2): user_get, account_get",
    "  Generic (2): request, info",
    "",
    "Security: NUL-byte guards on all string inputs; timeout clamped 1000-120000ms;",
    "api_key scrubbed from ALL error messages; 16 MB response cap; TLS enforced by default.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        description: [
          "Operation to perform.",
          "mail_send=send email (plain/HTML/template/attachments/scheduling);",
          "contact_upsert=add or update marketing contacts (async job);",
          "contact_search=search contacts by SGQL query;",
          "contact_get=get contact by ID;",
          "contact_delete=delete contacts by IDs or all;",
          "contact_count=get total contact count;",
          "list_create=create a contact list;",
          "list_get=get list by ID;",
          "list_get_all=list all contact lists;",
          "list_update=rename a list;",
          "list_delete=delete a list;",
          "list_add_contacts=add contacts to a list;",
          "list_remove_contacts=remove contacts from a list;",
          "template_create=create a transactional template;",
          "template_get=get template by ID;",
          "template_list=list templates;",
          "template_delete=delete a template;",
          "template_version_create=create a template version;",
          "template_version_activate=activate a template version;",
          "suppression_get=list suppressed emails (bounces/spam/blocks/unsubscribes/invalid);",
          "suppression_delete=remove an email from a suppression list;",
          "unsubscribe_group_create=create unsubscribe group;",
          "unsubscribe_group_list=list unsubscribe groups;",
          "unsubscribe_group_get=get unsubscribe group by ID;",
          "unsubscribe_group_delete=delete unsubscribe group;",
          "sender_create=create a verified sender identity;",
          "sender_list=list sender identities;",
          "sender_get=get sender by ID;",
          "sender_delete=delete sender;",
          "sender_verify=resend sender verification email;",
          "stats_global=global email statistics;",
          "stats_category=category-level statistics;",
          "stats_template=template-level statistics;",
          "api_key_create=create API key;",
          "api_key_list=list API keys;",
          "api_key_get=get API key by ID;",
          "api_key_delete=delete API key;",
          "scheduled_send_create=cancel or pause a scheduled send by batch_id;",
          "scheduled_send_list=list scheduled send cancellations/pauses;",
          "scheduled_send_delete=delete a scheduled send cancellation;",
          "batch_id_generate=generate a new batch ID for scheduled sends;",
          "user_get=get user profile;",
          "account_get=get account details;",
          "request=generic HTTP request to any SendGrid API endpoint;",
          "info=connection and account info.",
        ].join(" "),
        enum: [
          "mail_send",
          "contact_upsert", "contact_search", "contact_get", "contact_delete", "contact_count",
          "list_create", "list_get", "list_get_all", "list_update", "list_delete",
          "list_add_contacts", "list_remove_contacts",
          "template_create", "template_get", "template_list", "template_delete",
          "template_version_create", "template_version_activate",
          "suppression_get", "suppression_delete",
          "unsubscribe_group_create", "unsubscribe_group_list",
          "unsubscribe_group_get", "unsubscribe_group_delete",
          "sender_create", "sender_list", "sender_get", "sender_delete", "sender_verify",
          "stats_global", "stats_category", "stats_template",
          "api_key_create", "api_key_list", "api_key_get", "api_key_delete",
          "scheduled_send_create", "scheduled_send_list",
          "scheduled_send_delete", "batch_id_generate",
          "user_get", "account_get",
          "request", "info",
        ],
      },
      api_key: {
        type: "string",
        description: "SendGrid API key (SG.*). Required for all operations. Never returned in output or errors.",
      },
      // mail_send
      to: {
        description: "Recipient(s). String email, {email, name} object, or array of either. Required for mail_send.",
        oneOf: [
          { type: "string" },
          { type: "object", properties: { email: { type: "string" }, name: { type: "string" } }, required: ["email"] },
          { type: "array", items: { oneOf: [
            { type: "string" },
            { type: "object", properties: { email: { type: "string" }, name: { type: "string" } }, required: ["email"] },
          ]}},
        ],
      },
      from: {
        description: "Sender address. String email or {email, name} object. Required for mail_send.",
        oneOf: [
          { type: "string" },
          { type: "object", properties: { email: { type: "string" }, name: { type: "string" } }, required: ["email"] },
        ],
      },
      subject: {
        type: "string",
        description: "Email subject line. Required for mail_send unless template_id is provided.",
      },
      text: {
        type: "string",
        description: "Plain-text email body (mail_send). Provide at least one of text, html, or template_id.",
      },
      html: {
        type: "string",
        description: "HTML email body (mail_send).",
      },
      template_id: {
        type: "string",
        description: "SendGrid dynamic template ID (d-xxxxxxxx). For mail_send, template_get, template_delete, template_version_create, template_version_activate.",
      },
      dynamic_template_data: {
        type: "object",
        description: "Template variable substitution data for dynamic transactional templates (mail_send). Keys map to {{variable}} in template.",
      },
      cc: {
        description: "CC recipient(s). String, {email, name}, or array. (mail_send)",
        oneOf: [
          { type: "string" },
          { type: "object" },
          { type: "array" },
        ],
      },
      bcc: {
        description: "BCC recipient(s). String, {email, name}, or array. (mail_send)",
        oneOf: [
          { type: "string" },
          { type: "object" },
          { type: "array" },
        ],
      },
      reply_to: {
        description: "Reply-To address. String or {email, name}. (mail_send)",
        oneOf: [
          { type: "string" },
          { type: "object" },
        ],
      },
      attachments: {
        type: "array",
        description: "File attachments for mail_send. Each: {content: base64, type: mime, filename, disposition?, content_id?}.",
        items: {
          type: "object",
          properties: {
            content:      { type: "string", description: "Base64-encoded file content." },
            type:         { type: "string", description: "MIME type, e.g. 'application/pdf'." },
            filename:     { type: "string", description: "Filename shown to recipient." },
            disposition:  { type: "string", description: "'attachment' (default) or 'inline'." },
            content_id:   { type: "string", description: "Content-ID for inline attachments." },
          },
          required: ["content", "filename"],
        },
      },
      categories: {
        description: "Email categories for tracking. String or array of strings. (mail_send)",
        oneOf: [
          { type: "string" },
          { type: "array", items: { type: "string" } },
        ],
      },
      send_at: {
        type: "integer",
        description: "Unix timestamp to schedule email delivery (mail_send). Use batch_id_generate first if you want to cancel/pause later.",
      },
      batch_id: {
        type: "string",
        description: "Batch ID from batch_id_generate for scheduled sends. Required for scheduled_send_create/delete. Optional for mail_send to allow cancellation.",
      },
      unsubscribe_group_id: {
        type: "integer",
        description: "ASM unsubscribe group ID to associate with email (mail_send). Overrides default unsubscribe group.",
      },
      ip_pool_name: {
        type: "string",
        description: "IP pool name to use for this email (mail_send).",
      },
      substitutions: {
        type: "object",
        description: "Legacy template substitution map for non-dynamic templates. (mail_send personalizations)",
      },
      // contacts
      contacts: {
        type: "array",
        description: "Array of contact objects for contact_upsert. Each: {email, first_name?, last_name?, phone_number?, custom_fields?}.",
        items: {
          type: "object",
          properties: {
            email:        { type: "string" },
            first_name:   { type: "string" },
            last_name:    { type: "string" },
            phone_number: { type: "string" },
            custom_fields: { type: "object" },
          },
          required: ["email"],
        },
      },
      list_ids: {
        type: "array",
        items: { type: "string" },
        description: "List IDs to add contacts to when upserting (contact_upsert).",
      },
      contact_id: {
        type: "string",
        description: "Contact ID for contact_get.",
      },
      ids: {
        description: "Contact IDs to delete (array or string 'all_active_contacts'). Required for contact_delete.",
        oneOf: [
          { type: "string" },
          { type: "array", items: { type: "string" } },
        ],
      },
      query: {
        type: "string",
        description: "SGQL query string for contact_search. Example: \"email LIKE 'user@example.com' AND CONTAINS(list_ids, 'abc123')\".",
      },
      // lists
      list_id: {
        type: "string",
        description: "Contact list ID. Required for list_get, list_update, list_delete, list_add_contacts, list_remove_contacts.",
      },
      name: {
        type: "string",
        description: "Name for list_create, list_update, template_create, unsubscribe_group_create, api_key_create, sender_create.",
      },
      contact_ids: {
        type: "array",
        items: { type: "string" },
        description: "Array of contact IDs. Required for list_add_contacts and list_remove_contacts.",
      },
      delete_contacts: {
        type: "boolean",
        description: "If true, also delete all contacts in the list when deleting a list (list_delete). Default: false.",
      },
      contact_sample: {
        type: "boolean",
        description: "Include a contact sample in list_get response. Default: true.",
      },
      // templates
      generation: {
        type: "string",
        description: "Template generation: 'legacy' or 'dynamic' (default). Used in template_create and template_list.",
        enum: ["legacy", "dynamic"],
      },
      generations: {
        description: "Filter by generation in template_list. String or array: 'legacy', 'dynamic'.",
        oneOf: [
          { type: "string" },
          { type: "array", items: { type: "string" } },
        ],
      },
      version_id: {
        type: "string",
        description: "Template version ID. Required for template_version_activate.",
      },
      html_content: {
        type: "string",
        description: "HTML content for template_version_create.",
      },
      plain_content: {
        type: "string",
        description: "Plain text content for template_version_create.",
      },
      generate_plain_content: {
        type: "boolean",
        description: "Auto-generate plain content from HTML (template_version_create). Default: true.",
      },
      active: {
        type: "integer",
        description: "Set template version as active (template_version_create): 0=inactive, 1=active.",
        enum: [0, 1],
      },
      test_data: {
        type: "string",
        description: "JSON string of test data for template preview (template_version_create).",
      },
      // suppressions
      suppression_type: {
        type: "string",
        description: "Type of suppression list. Required for suppression_get and suppression_delete.",
        enum: ["unsubscribes", "global_unsubscribes", "bounces", "spam_reports", "blocks", "invalid_emails"],
      },
      email: {
        type: "string",
        description: "Email address. Required for suppression_delete.",
      },
      description: {
        type: "string",
        description: "Description for unsubscribe_group_create. Explain what emails are in this group.",
      },
      is_default: {
        type: "boolean",
        description: "Whether this is the default unsubscribe group (unsubscribe_group_create).",
      },
      group_id: {
        type: "integer",
        description: "Unsubscribe group ID. Required for unsubscribe_group_get and unsubscribe_group_delete.",
      },
      groups_to_display: {
        type: "array",
        items: { type: "integer" },
        description: "List of group IDs to display on the unsubscribe page (mail_send with unsubscribe_group_id).",
      },
      // senders
      sender_id: {
        type: "integer",
        description: "Sender identity ID. Required for sender_get, sender_delete, sender_verify.",
      },
      from_email: {
        type: "string",
        description: "From email address for sender_create.",
      },
      from_name: {
        type: "string",
        description: "From display name for sender_create.",
      },
      reply_to_email: {
        type: "string",
        description: "Reply-To email address for sender_create.",
      },
      reply_to_name: {
        type: "string",
        description: "Reply-To display name for sender_create.",
      },
      nickname: {
        type: "string",
        description: "Internal nickname for the sender identity (sender_create).",
      },
      address: {
        type: "string",
        description: "Street address for sender_create (required by CAN-SPAM).",
      },
      city: { type: "string", description: "City for sender_create." },
      state: { type: "string", description: "State for sender_create." },
      zip: { type: "string", description: "Postal code for sender_create." },
      country: { type: "string", description: "Country for sender_create." },
      // stats
      start_date: {
        type: "string",
        description: "Start date in YYYY-MM-DD format. Required for stats_global, stats_category, stats_template.",
      },
      end_date: {
        type: "string",
        description: "End date in YYYY-MM-DD format (stats operations).",
      },
      aggregated_by: {
        type: "string",
        description: "Time grouping for stats: 'day' (default), 'week', or 'month'.",
        enum: ["day", "week", "month"],
      },
      categories: {
        description: "Category name(s) for stats_category. String or array.",
        oneOf: [
          { type: "string" },
          { type: "array", items: { type: "string" } },
        ],
      },
      template_ids: {
        description: "Template ID(s) for stats_template. String or array.",
        oneOf: [
          { type: "string" },
          { type: "array", items: { type: "string" } },
        ],
      },
      // api keys
      api_key_id: {
        type: "string",
        description: "API key ID for api_key_get, api_key_delete.",
      },
      scopes: {
        type: "array",
        items: { type: "string" },
        description: "Permission scopes for api_key_create. Empty = full access. Example: ['mail.send', 'stats.read'].",
      },
      // scheduled sends
      status: {
        type: "string",
        description: "Status for scheduled_send_create: 'cancel' or 'pause'.",
        enum: ["cancel", "pause"],
      },
      // generic request
      method: {
        type: "string",
        description: "HTTP method for generic request operation: GET, POST, PUT, PATCH, DELETE.",
        enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      },
      path: {
        type: "string",
        description: "API path for generic request (without /v3 prefix, e.g. '/mail/send', '/stats').",
      },
      body: {
        type: "object",
        description: "Request body for generic request (POST/PUT/PATCH).",
      },
      params: {
        type: "object",
        description: "Query parameters for generic request (GET/DELETE).",
      },
      // pagination
      page_size: {
        type: "integer",
        description: "Number of results per page. Used by list_get_all (max 1000) and template_list (max 200).",
        minimum: 1,
        maximum: 1000,
      },
      page_token: {
        type: "string",
        description: "Pagination token for list_get_all and template_list.",
      },
      limit: {
        type: "integer",
        description: "Max records to return in suppression_get and stats operations. Default: 100, max: 500.",
        minimum: 1,
        maximum: 500,
      },
      offset: {
        type: "integer",
        description: "Pagination offset for suppression_get and stats operations.",
        minimum: 0,
      },
      start_time: {
        type: "integer",
        description: "Unix timestamp for suppression_get filtering (start of range).",
      },
      end_time: {
        type: "integer",
        description: "Unix timestamp for suppression_get filtering (end of range).",
      },
      versions_summaries: {
        type: "boolean",
        description: "Include version summaries in template_get. Default: true.",
      },
      // connection
      timeout: {
        type: "integer",
        description: "Request timeout in milliseconds (1000-120000, default 20000).",
        minimum: 1000,
        maximum: 120000,
      },
      reject_unauthorized: {
        type: "boolean",
        description: "Reject TLS connections with invalid certificates (default true). Set false only for testing.",
      },
    },
    required: ["operation", "api_key"],
  },
};

module.exports = { SENDGRID_CLIENT_SCHEMA };
