"use strict";
/**
 * utilSchemas126.js
 * JSON Schema for the airtable_client tool.
 */

const AIRTABLE_CLIENT_SCHEMA = {
  name: "airtable_client",
  description: [
    "Zero-dependency Airtable REST API client (pure Node.js https; no npm deps).",
    "Auth: Personal Access Token or legacy API Key (passed as api_key).",
    "Supports reading and writing records, managing bases/tables/fields/views,",
    "webhooks, and record comments.",
    "",
    "Operations (25 total):",
    "  Records (8): record_list, record_get, record_create, record_update,",
    "    record_upsert, record_delete, record_bulk_create, record_bulk_delete",
    "  Bases (3): base_list, base_schema, base_create",
    "  Tables (3): table_create, table_update, table_delete",
    "  Fields (2): field_create, field_update",
    "  Views (1): view_list",
    "  Webhooks (4): webhook_list, webhook_create, webhook_delete, webhook_payloads",
    "  Comments (3): comment_list, comment_create, comment_delete",
    "  Generic (1): request",
    "",
    "Security: API token scrubbed from ALL error messages; NUL-byte guards;",
    "16 MB response cap; timeout clamped 1000-120000ms; TLS enforced.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        description: [
          "Operation to perform.",
          "record_list=list records (filterable/paginated/sortable);",
          "record_get=get single record by ID;",
          "record_create=create a single record;",
          "record_update=update a record (PATCH merge or PUT replace);",
          "record_upsert=upsert up to 10 records by merge field(s);",
          "record_delete=delete a single record;",
          "record_bulk_create=create up to 10 records at once;",
          "record_bulk_delete=delete up to 10 records at once;",
          "base_list=list all accessible bases;",
          "base_schema=get schema (tables/fields) of a base;",
          "base_create=create a new base;",
          "table_create=create a new table in a base;",
          "table_update=update table name/description;",
          "table_delete=delete a table;",
          "field_create=create a new field in a table;",
          "field_update=update field name/description/options;",
          "view_list=list views in a table;",
          "webhook_list=list webhooks on a base;",
          "webhook_create=create a webhook;",
          "webhook_delete=delete a webhook;",
          "webhook_payloads=get payloads for a webhook;",
          "comment_list=list comments on a record;",
          "comment_create=create a comment on a record;",
          "comment_delete=delete a comment;",
          "request=generic HTTP request to any Airtable API path.",
        ].join(" "),
        enum: [
          "record_list", "record_get", "record_create", "record_update",
          "record_upsert", "record_delete", "record_bulk_create", "record_bulk_delete",
          "base_list", "base_schema", "base_create",
          "table_create", "table_update", "table_delete",
          "field_create", "field_update",
          "view_list",
          "webhook_list", "webhook_create", "webhook_delete", "webhook_payloads",
          "comment_list", "comment_create", "comment_delete",
          "request",
        ],
      },
      // ── Auth ──────────────────────────────────────────────────────────────
      api_key: {
        type: "string",
        description: "Airtable Personal Access Token (recommended) or legacy API Key. Required.",
      },
      token: {
        type: "string",
        description: "Alias for api_key. Either api_key or token must be provided.",
      },
      timeout: {
        type: "integer",
        description: "Request timeout in milliseconds (1000-120000, default 20000).",
        minimum: 1000,
        maximum: 120000,
      },
      // ── Resource IDs ──────────────────────────────────────────────────────
      base_id: {
        type: "string",
        description: "Airtable Base ID (starts with 'app', e.g. 'appXXXXXXXXXXXXXX'). Required for most operations.",
      },
      table_id: {
        type: "string",
        description: "Table ID or name (e.g. 'tblXXXXXXXXXXXXXX' or 'My Table'). Required for record/table/field/view operations.",
      },
      record_id: {
        type: "string",
        description: "Record ID (starts with 'rec', e.g. 'recXXXXXXXXXXXXXX'). Required for record_get/update/delete/comment operations.",
      },
      field_id: {
        type: "string",
        description: "Field ID (starts with 'fld'). Required for field_update.",
      },
      webhook_id: {
        type: "string",
        description: "Webhook ID. Required for webhook_delete and webhook_payloads.",
      },
      comment_id: {
        type: "string",
        description: "Comment ID. Required for comment_delete.",
      },
      // ── record_list params ─────────────────────────────────────────────────
      fields: {
        description: "For record_list: array of field names/IDs to include in response. For record_create: object of field name/ID → value.",
      },
      filter_formula: {
        type: "string",
        description: "Airtable formula to filter records, e.g. \"AND({Status}='Active', {Budget}>1000)\".",
      },
      max_records: {
        type: "integer",
        description: "Maximum total records to return (record_list). Default: all.",
        minimum: 1,
      },
      page_size: {
        type: "integer",
        description: "Records per page (1-100, default 100) for record_list.",
        minimum: 1,
        maximum: 100,
      },
      offset: {
        type: "string",
        description: "Pagination cursor returned in previous record_list response.",
      },
      sort: {
        type: "array",
        description: "Sort spec for record_list: array of {field, direction} objects. direction: 'asc' or 'desc'.",
        items: {
          type: "object",
          properties: {
            field: { type: "string", description: "Field name or ID to sort by." },
            direction: { type: "string", enum: ["asc", "desc"] },
          },
        },
      },
      view: {
        type: "string",
        description: "View name or ID to use for record_list (applies view's filter/sort).",
      },
      cell_format: {
        type: "string",
        description: "Cell format for record_list: 'json' (default) or 'string'.",
        enum: ["json", "string"],
      },
      time_zone: {
        type: "string",
        description: "IANA timezone name for date fields (e.g. 'America/New_York'). Used with cell_format='string'.",
      },
      user_locale: {
        type: "string",
        description: "User locale for date formatting (e.g. 'en-us'). Used with cell_format='string'.",
      },
      return_fields_by_field_id: {
        type: "boolean",
        description: "If true, return field IDs instead of names in record responses.",
      },
      // ── record_create / update ─────────────────────────────────────────────
      typecast: {
        type: "boolean",
        description: "If true, Airtable will auto-convert string values to appropriate types.",
      },
      replace: {
        type: "boolean",
        description: "For record_update: if true, use PUT (destructive replace). Default false = PATCH (merge).",
      },
      // ── record_upsert ──────────────────────────────────────────────────────
      records: {
        type: "array",
        description: [
          "For record_upsert: array of {fields: {...}} objects (max 10).",
          "For record_bulk_create: array of {fields: {...}} objects (max 10).",
        ].join(" "),
      },
      fields_to_merge_on: {
        type: "array",
        description: "For record_upsert: field name(s) to match on for upsert logic.",
        items: { type: "string" },
      },
      // ── record_bulk_delete ─────────────────────────────────────────────────
      record_ids: {
        type: "array",
        description: "For record_bulk_delete: array of record IDs to delete (max 10).",
        items: { type: "string" },
      },
      // ── base_create ─────────────────────────────────────────────────────────
      name: {
        type: "string",
        description: "Name for base_create (base name), table_create (table name), field_create (field name), or table_update.",
      },
      workspace_id: {
        type: "string",
        description: "Workspace ID for base_create (e.g. 'wspcXXXXXXXXXXXXXX').",
      },
      tables: {
        type: "array",
        description: "For base_create: array of table definitions (each with name, fields array).",
      },
      // ── table fields ────────────────────────────────────────────────────────
      description: {
        type: "string",
        description: "Description for table_create, table_update, field_create, or field_update.",
      },
      // ── field_create ────────────────────────────────────────────────────────
      type: {
        type: "string",
        description: [
          "Field type for field_create. Examples: singleLineText, multilineText, email,",
          "url, number, currency, percent, duration, rating, checkbox, singleSelect,",
          "multipleSelects, date, dateTime, phoneNumber, multipleAttachments,",
          "multipleRecordLinks, autoNumber, count, rollup, formula, lookup,",
          "multipleLookupValues, createdTime, lastModifiedTime, createdBy, lastModifiedBy.",
        ].join(" "),
      },
      options: {
        type: "object",
        description: "Field-type-specific options for field_create/field_update (e.g. {choices: [{name:'A'},{name:'B'}]} for singleSelect).",
      },
      include: {
        type: "string",
        description: "For base_schema: comma-separated list of extra properties to include (e.g. 'visibleFieldIds').",
      },
      // ── webhook_create ─────────────────────────────────────────────────────
      notification_url: {
        type: "string",
        description: "HTTPS URL to receive webhook POST payloads. Required for webhook_create.",
      },
      specification: {
        type: "object",
        description: [
          "Webhook specification for webhook_create.",
          "E.g. { options: { filters: { fromSources: ['client'], dataTypes: ['tableData'] } } }",
        ].join(" "),
      },
      cursor_for_next_payload: {
        type: "integer",
        description: "Starting cursor for webhook_create (optional).",
        minimum: 1,
      },
      cursor: {
        type: "integer",
        description: "Cursor for webhook_payloads pagination.",
        minimum: 1,
      },
      // ── comment_create ─────────────────────────────────────────────────────
      text: {
        type: "string",
        description: "Comment text for comment_create.",
      },
      // ── generic request ────────────────────────────────────────────────────
      method: {
        type: "string",
        description: "HTTP method for generic request operation.",
        enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"],
      },
      path: {
        type: "string",
        description: "Full API path for generic request (e.g. '/v0/appXXX/TableName' or '/v0/meta/bases').",
      },
      body: {
        type: "object",
        description: "Request body for generic request (POST/PUT/PATCH).",
      },
      params: {
        type: "object",
        description: "Query parameters for generic request (GET/DELETE).",
      },
    },
    required: ["operation", "api_key"],
  },
};

module.exports = { AIRTABLE_CLIENT_SCHEMA };
