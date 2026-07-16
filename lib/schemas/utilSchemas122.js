"use strict";
/**
 * utilSchemas122.js
 * JSON Schema for the hubspot_client tool.
 */

const HUBSPOT_CLIENT_SCHEMA = {
  name: "hubspot_client",
  description: [
    "Zero-dependency HubSpot CRM API v3/v4 client (pure Node.js https; no npm deps).",
    "Auth: access_token (private app token or OAuth Bearer).",
    "Credentials are never returned in output or errors.",
    "",
    "Operations (30 total):",
    "  CRM CRUD (9): crm_create, crm_get, crm_list, crm_update, crm_delete, crm_search,",
    "    crm_batch_create, crm_batch_read, crm_batch_update",
    "  Associations (3): association_create, association_list, association_delete",
    "  Properties (5): property_list, property_get, property_create, property_update, property_delete",
    "  Pipelines (3): pipeline_list, pipeline_get, pipeline_stage_list",
    "  Owners (2): owner_list, owner_get",
    "  Timeline (1): timeline_event_create",
    "  Convenience (4): contact_create, contact_get_by_email, deal_create, company_create",
    "  Generic (1): request",
    "",
    "object_type values: contacts, companies, deals, tickets, products,",
    "  line_items, quotes, calls, emails, meetings, notes, tasks",
    "",
    "Security: NUL-byte guards on all string inputs; timeout clamped 1000-120000ms;",
    "access_token scrubbed from ALL error messages; 16 MB response cap; TLS enforced.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        description: [
          "Operation to perform.",
          "crm_create=create a CRM object (contact/company/deal/ticket/etc.);",
          "crm_get=get object by ID;",
          "crm_list=list objects with pagination;",
          "crm_update=update object properties;",
          "crm_delete=archive/delete an object;",
          "crm_search=search objects with filters and/or full-text query;",
          "crm_batch_create=batch create multiple objects;",
          "crm_batch_read=batch read objects by IDs;",
          "crm_batch_update=batch update multiple objects;",
          "association_create=associate two CRM objects;",
          "association_list=list associations from an object;",
          "association_delete=remove an association between two objects;",
          "property_list=list all properties for an object type;",
          "property_get=get a specific property definition;",
          "property_create=create a custom property;",
          "property_update=update a property definition;",
          "property_delete=delete a custom property;",
          "pipeline_list=list pipelines for deals or tickets;",
          "pipeline_get=get a specific pipeline;",
          "pipeline_stage_list=list stages in a pipeline;",
          "owner_list=list CRM owners (users);",
          "owner_get=get a specific owner by ID;",
          "timeline_event_create=create a timeline event on a CRM record;",
          "contact_create=create a contact with common fields (email, firstname, lastname, phone, company, website, jobtitle);",
          "contact_get_by_email=find a contact by email address;",
          "deal_create=create a deal with common fields (dealname, amount, dealstage, pipeline, closedate);",
          "company_create=create a company with common fields (name, domain, industry, phone, city, country);",
          "request=generic HTTP request to any HubSpot API path.",
        ].join(" "),
        enum: [
          "crm_create", "crm_get", "crm_list", "crm_update", "crm_delete",
          "crm_search", "crm_batch_create", "crm_batch_read", "crm_batch_update",
          "association_create", "association_list", "association_delete",
          "property_list", "property_get", "property_create", "property_update", "property_delete",
          "pipeline_list", "pipeline_get", "pipeline_stage_list",
          "owner_list", "owner_get",
          "timeline_event_create",
          "contact_create", "contact_get_by_email", "deal_create", "company_create",
          "request",
        ],
      },
      access_token: {
        type: "string",
        description: "HubSpot private app access token or OAuth bearer token. Required for all operations.",
      },
      // CRM object type
      object_type: {
        type: "string",
        description: "CRM object type. Required for crm_*, property_*, and pipeline_* operations. Values: contacts, companies, deals, tickets, products, line_items, quotes, calls, emails, meetings, notes, tasks.",
        enum: ["contacts", "companies", "deals", "tickets", "products", "line_items", "quotes", "calls", "emails", "meetings", "notes", "tasks"],
      },
      object_id: {
        type: "string",
        description: "CRM object ID. Required for crm_get, crm_update, crm_delete, and association_* operations.",
      },
      properties: {
        description: "For crm_create/crm_update/contact_create/deal_create/company_create: object of property name→value pairs. For crm_get/crm_list: array of property names to return. For crm_search/crm_batch_read: array of property names to include.",
        oneOf: [
          { type: "object" },
          { type: "array", items: { type: "string" } },
        ],
      },
      associations: {
        type: "array",
        description: "Associations to create with the new object (crm_create). Array of {to: {id}, types: [{associationCategory, associationTypeId}]}.",
        items: { type: "object" },
      },
      archived: {
        type: "boolean",
        description: "Include/filter archived records (crm_get, crm_list, property_list, owner_list). Default: false.",
      },
      // List/pagination
      limit: {
        type: "integer",
        description: "Page size (crm_list: max 100, crm_search: max 100, association_list: max 500, owner_list: max 500). Default: 10.",
        minimum: 1,
        maximum: 500,
      },
      after: {
        type: "string",
        description: "Pagination cursor for crm_list, crm_search, association_list, owner_list.",
      },
      // Search
      filters: {
        type: "array",
        description: "crm_search: shorthand filter array [{propertyName, operator, value}] wrapped in a single filterGroup. Use filter_groups for multi-group logic.",
        items: {
          type: "object",
          properties: {
            propertyName: { type: "string" },
            operator:     { type: "string", description: "EQ, NEQ, LT, LTE, GT, GTE, BETWEEN, IN, NOT_IN, HAS_PROPERTY, NOT_HAS_PROPERTY, CONTAINS_TOKEN, NOT_CONTAINS_TOKEN" },
            value:        { type: "string" },
            values:       { type: "array", items: { type: "string" } },
          },
        },
      },
      filter_groups: {
        type: "array",
        description: "crm_search: full filterGroups array for multi-group (OR) filter logic.",
        items: { type: "object" },
      },
      sorts: {
        type: "array",
        description: "crm_search: sort array [{propertyName, direction: ASC|DESC}].",
        items: { type: "object" },
      },
      query: {
        type: "string",
        description: "crm_search: full-text search query string.",
      },
      // Batch
      inputs: {
        type: "array",
        description: "crm_batch_create: array of {properties}. crm_batch_read: array of {id}. crm_batch_update: array of {id, properties}.",
        items: { type: "object" },
      },
      // Association fields
      from_object_type: {
        type: "string",
        description: "Source object type for association_create/list/delete.",
      },
      from_object_id: {
        type: "string",
        description: "Source object ID for association_create/list/delete.",
      },
      to_object_type: {
        type: "string",
        description: "Target object type for association_create/list/delete.",
      },
      to_object_id: {
        type: "string",
        description: "Target object ID for association_create/delete.",
      },
      association_type: {
        type: "string",
        description: "Association type ID string (e.g. '1' for contact_to_company). Required for association_create and association_delete.",
      },
      association_category: {
        type: "string",
        description: "Association category: HUBSPOT_DEFINED (default) or USER_DEFINED.",
        enum: ["HUBSPOT_DEFINED", "USER_DEFINED"],
      },
      // Property fields
      property_name: {
        type: "string",
        description: "Property internal name for property_get, property_update, property_delete.",
      },
      name: {
        type: "string",
        description: "Internal name for property_create. Also used as company name in company_create.",
      },
      label: {
        type: "string",
        description: "Display label for property_create/update.",
      },
      type: {
        type: "string",
        description: "Property data type for property_create: string, number, date, datetime, enumeration, bool.",
        enum: ["string", "number", "date", "datetime", "enumeration", "bool"],
      },
      field_type: {
        type: "string",
        description: "Property field type for property_create: text, textarea, date, file, number, select, radio, checkbox, booleancheckbox.",
        enum: ["text", "textarea", "date", "file", "number", "select", "radio", "checkbox", "booleancheckbox"],
      },
      group_name: {
        type: "string",
        description: "Property group name for property_create (e.g. 'contactinformation', 'dealinformation').",
      },
      description: {
        type: "string",
        description: "Property description for property_create/update.",
      },
      options: {
        type: "array",
        description: "Enumeration options for property_create/update: [{label, value, displayOrder?, hidden?}].",
        items: { type: "object" },
      },
      display_order: {
        type: "integer",
        description: "Display order for property_create.",
      },
      hidden: {
        type: "boolean",
        description: "Hide the property from HubSpot UI.",
      },
      // Pipeline fields
      pipeline_id: {
        type: "string",
        description: "Pipeline ID for pipeline_get and pipeline_stage_list.",
      },
      // Owner fields
      owner_id: {
        type: "string",
        description: "Owner ID for owner_get.",
      },
      email: {
        type: "string",
        description: "Filter owners by email (owner_list). Contact email for contact_create and contact_get_by_email.",
      },
      // Timeline
      event_template_id: {
        type: "string",
        description: "Timeline event template ID for timeline_event_create.",
      },
      app_id: {
        type: "string",
        description: "App ID for timeline_event_create.",
      },
      tokens: {
        type: "object",
        description: "Token values for the event template (timeline_event_create).",
      },
      extra_data: {
        type: "object",
        description: "Extra data object for timeline_event_create.",
      },
      timestamp: {
        type: "string",
        description: "ISO 8601 event timestamp for timeline_event_create.",
      },
      // Contact convenience fields
      firstname: {
        type: "string",
        description: "Contact first name (contact_create).",
      },
      lastname: {
        type: "string",
        description: "Contact last name (contact_create).",
      },
      phone: {
        type: "string",
        description: "Phone number (contact_create, company_create).",
      },
      company: {
        type: "string",
        description: "Company name property on a contact (contact_create).",
      },
      website: {
        type: "string",
        description: "Website URL (contact_create).",
      },
      jobtitle: {
        type: "string",
        description: "Job title (contact_create).",
      },
      // Deal convenience fields
      dealname: {
        type: "string",
        description: "Deal name (deal_create, required).",
      },
      amount: {
        type: "number",
        description: "Deal amount (deal_create).",
      },
      dealstage: {
        type: "string",
        description: "Deal stage ID (deal_create).",
      },
      pipeline: {
        type: "string",
        description: "Pipeline ID for the deal (deal_create). Defaults to 'default' pipeline.",
      },
      closedate: {
        type: "string",
        description: "Deal close date ISO 8601 (deal_create).",
      },
      hubspot_owner_id: {
        type: "string",
        description: "Owner ID to assign to the deal (deal_create).",
      },
      // Company convenience fields
      domain: {
        type: "string",
        description: "Company domain (company_create).",
      },
      industry: {
        type: "string",
        description: "Company industry (company_create).",
      },
      city: {
        type: "string",
        description: "Company city (company_create).",
      },
      country: {
        type: "string",
        description: "Company country (company_create).",
      },
      // Generic request
      method: {
        type: "string",
        description: "HTTP method for generic request: GET, POST, PUT, PATCH, DELETE.",
        enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      },
      path: {
        type: "string",
        description: "API path for generic request (e.g. '/crm/v3/objects/contacts').",
      },
      body: {
        type: "object",
        description: "Request body for generic request (POST/PUT/PATCH).",
      },
      params: {
        type: "object",
        description: "Query parameters for generic request (GET/DELETE).",
      },
      properties_with_history: {
        type: "array",
        items: { type: "string" },
        description: "Property names to return with full history (crm_get).",
      },
      // Connection
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
    required: ["operation", "access_token"],
  },
};

module.exports = { HUBSPOT_CLIENT_SCHEMA };
