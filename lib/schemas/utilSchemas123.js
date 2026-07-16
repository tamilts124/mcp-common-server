"use strict";
/**
 * utilSchemas123.js
 * JSON Schema for the salesforce_client tool.
 */

const SALESFORCE_CLIENT_SCHEMA = {
  name: "salesforce_client",
  description: [
    "Zero-dependency Salesforce REST API client (pure Node.js https; no npm deps).",
    "Auth: provide access_token + instance_url (pre-obtained), OR",
    "      username + password + client_id + client_secret (Resource Owner Password flow).",
    "Optional: security_token (appended to password), sandbox (uses test.salesforce.com).",
    "Credentials are never returned in output or errors.",
    "",
    "Operations (14 total):",
    "  SObject CRUD (6): sobject_create, sobject_get, sobject_update, sobject_delete,",
    "    sobject_describe, sobject_list",
    "  SOQL (2): query, query_more",
    "  SOSL (1): search",
    "  Composite (2): composite, composite_batch",
    "  Metadata (2): get_limits, get_api_versions",
    "  Generic (1): request",
    "",
    "Security: NUL-byte guards on all string inputs; timeout clamped 1000-120000ms;",
    "all credentials scrubbed from ALL error messages; 16 MB response cap; TLS enforced.",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        description: [
          "Operation to perform.",
          "sobject_create=create a Salesforce record (e.g. Contact, Account, Opportunity);",
          "sobject_get=get record by ID (with optional field list);",
          "sobject_update=update record fields by ID;",
          "sobject_delete=delete a record by ID;",
          "sobject_describe=get full field/relationship metadata for an sObject type;",
          "sobject_list=list all available sObject types in the org;",
          "query=run a SOQL query (SELECT ... FROM ...);",
          "query_more=fetch next page of SOQL results using nextRecordsUrl;",
          "search=run a SOSL search (FIND {term} IN ALL FIELDS RETURNING ...);",
          "composite=send up to 25 subrequests in one HTTP call (supports allOrNone);",
          "composite_batch=send up to 25 independent subrequests in one HTTP call;",
          "get_limits=get org API limits and usage;",
          "get_api_versions=list all available REST API versions for this org;",
          "request=generic HTTP request to any Salesforce REST API path.",
        ].join(" "),
        enum: [
          "sobject_create", "sobject_get", "sobject_update", "sobject_delete",
          "sobject_describe", "sobject_list",
          "query", "query_more",
          "search",
          "composite", "composite_batch",
          "get_limits", "get_api_versions",
          "request",
        ],
      },
      // Auth: bearer token mode
      access_token: {
        type: "string",
        description: "Salesforce OAuth access token (Bearer). Required if NOT using username+password flow.",
      },
      instance_url: {
        type: "string",
        description: "Salesforce instance URL (e.g. 'https://yourorg.my.salesforce.com'). Required if using access_token.",
      },
      // Auth: username+password flow
      username: {
        type: "string",
        description: "Salesforce username. Required for username+password auth flow.",
      },
      password: {
        type: "string",
        description: "Salesforce password. Required for username+password auth flow.",
      },
      security_token: {
        type: "string",
        description: "Salesforce security token (appended to password). Often required for IP-restricted orgs.",
      },
      client_id: {
        type: "string",
        description: "Connected App consumer key (client_id). Required for username+password auth flow.",
      },
      client_secret: {
        type: "string",
        description: "Connected App consumer secret (client_secret). Required for username+password auth flow.",
      },
      sandbox: {
        type: "boolean",
        description: "Set true to authenticate against a sandbox org (test.salesforce.com). Default: false.",
      },
      // API version
      api_version: {
        type: "string",
        description: "Salesforce REST API version (e.g. 'v59.0'). Default: 'v59.0'.",
      },
      // SObject fields
      sobject: {
        type: "string",
        description: "Salesforce sObject API name (e.g. 'Contact', 'Account', 'Opportunity', 'Lead'). Required for sobject_* operations.",
      },
      id: {
        type: "string",
        description: "Salesforce record ID (15 or 18-character). Required for sobject_get, sobject_update, sobject_delete.",
      },
      fields: {
        description: "For sobject_create/update: object of field name→value pairs to set. For sobject_get: array of field names to return.",
        oneOf: [
          { type: "object" },
          { type: "array", items: { type: "string" } },
        ],
      },
      // SOQL
      query: {
        type: "string",
        description: "SOQL query string (e.g. 'SELECT Id, Name FROM Account WHERE Industry = \\\"Technology\\\" LIMIT 10'). Required for query operation.",
      },
      all_rows: {
        type: "boolean",
        description: "Include deleted and archived records in query results (uses queryAll endpoint). Default: false.",
      },
      next_records_url: {
        type: "string",
        description: "nextRecordsUrl from a previous SOQL query result (e.g. '/services/data/v59.0/query/01gXXX-500'). Required for query_more.",
      },
      // SOSL
      // (uses query field too)
      // Composite
      composite_request: {
        type: "array",
        description: "Array of subrequest objects for composite operation. Each: {method, url, referenceId, body?}. Max 25.",
        items: {
          type: "object",
          properties: {
            method:      { type: "string", enum: ["GET", "POST", "PATCH", "DELETE"] },
            url:         { type: "string" },
            referenceId: { type: "string" },
            body:        { type: "object" },
          },
        },
      },
      all_or_none: {
        type: "boolean",
        description: "composite: if true, roll back all on any failure. Default: true.",
      },
      batch_requests: {
        type: "array",
        description: "Array of subrequest objects for composite_batch. Each: {method, url, richInput?}. Max 25.",
        items: {
          type: "object",
          properties: {
            method:     { type: "string", enum: ["GET", "POST", "PATCH", "DELETE"] },
            url:        { type: "string" },
            richInput:  { type: "object" },
          },
        },
      },
      halt_on_error: {
        type: "boolean",
        description: "composite_batch: stop processing on first error. Default: false.",
      },
      // Generic request
      method: {
        type: "string",
        description: "HTTP method for generic request: GET, POST, PUT, PATCH, DELETE, HEAD.",
        enum: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"],
      },
      path: {
        type: "string",
        description: "API path for generic request (e.g. '/services/data/v59.0/limits').",
      },
      body: {
        type: "object",
        description: "Request body for generic request (POST/PUT/PATCH).",
      },
      params: {
        type: "object",
        description: "Query parameters for generic request (GET/DELETE).",
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
    required: ["operation"],
  },
};

module.exports = { SALESFORCE_CLIENT_SCHEMA };
