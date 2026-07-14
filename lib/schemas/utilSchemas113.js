"use strict";

const NOTION_CLIENT_SCHEMA = {
  name: "notion_client",
  description:
    "Zero-dependency Notion REST API client (pure Node.js https built-ins; no npm deps). " +
    "Auth: Notion Integration Token (Bearer) via 'token'. " +
    "API version: 2022-06-28. Base URL: https://api.notion.com/v1. " +
    "50 operations: " +
    "Pages (page_get, page_create, page_update, page_archive, page_restore, page_retrieve_property, page_get_property_item); " +
    "Databases (database_list, database_get, database_create, database_update, database_query, database_filter, database_restore); " +
    "Blocks (block_get, block_update, block_delete, block_children_list, block_children_append, block_restore); " +
    "Comments (comment_list, comment_create, comment_get); " +
    "Users (user_list, user_get, user_me); " +
    "Search (search, search_filter); " +
    "Properties (property_get, property_list); " +
    "Workspace (workspace_info); " +
    "Content helpers (page_content_get, page_content_append, page_title_set, page_icon_set, page_cover_set, page_properties_set); " +
    "Generic (request, info, version).",
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        description:
          "Operation to perform. " +
          "Pages: page_get, page_create, page_update, page_archive, page_restore, page_retrieve_property, page_get_property_item. " +
          "Databases: database_list, database_get, database_create, database_update, database_query, database_filter, database_restore. " +
          "Blocks: block_get, block_update, block_delete, block_children_list, block_children_append, block_restore. " +
          "Comments: comment_list, comment_create, comment_get. " +
          "Users: user_list, user_get, user_me. " +
          "Search: search, search_filter. " +
          "Properties: property_get, property_list. " +
          "Workspace: workspace_info. " +
          "Content: page_content_get, page_content_append, page_title_set, page_icon_set, page_cover_set, page_properties_set. " +
          "Generic: request, info, version.",
        enum: [
          "page_get", "page_create", "page_update", "page_archive", "page_restore",
          "page_retrieve_property", "page_get_property_item",
          "database_list", "database_get", "database_create", "database_update",
          "database_query", "database_filter", "database_restore",
          "block_get", "block_update", "block_delete",
          "block_children_list", "block_children_append", "block_restore",
          "comment_list", "comment_create", "comment_get",
          "user_list", "user_get", "user_me",
          "search", "search_filter",
          "property_get", "property_list",
          "workspace_info",
          "page_content_get", "page_content_append",
          "page_title_set", "page_icon_set", "page_cover_set", "page_properties_set",
          "request", "info", "version",
        ],
      },

      // ── Auth ───────────────────────────────────────────────────────────────────
      token: {
        type: "string",
        description:
          "Notion Integration Token (secret_xxx format). " +
          "Create at https://www.notion.so/my-integrations. " +
          "Required for all operations except 'info' and 'version'. Never echoed in output.",
      },

      // ── Connection ────────────────────────────────────────────────────────────
      timeout: {
        type: "number",
        description: "Request timeout in milliseconds (1000–120000). Default: 20000.",
      },
      reject_unauthorized: {
        type: "boolean",
        description: "Reject TLS certificates with invalid/self-signed certs (default: true). Set false only for dev.",
      },

      // ── Page fields ───────────────────────────────────────────────────────────
      page_id: {
        type: "string",
        description:
          "[page_get, page_update, page_archive, page_restore, page_retrieve_property, page_get_property_item, " +
          "page_content_get, page_content_append, page_title_set, page_icon_set, page_cover_set, page_properties_set] " +
          "Notion page UUID (with or without dashes).",
      },
      parent: {
        type: "object",
        description:
          "[page_create, database_create] Parent object. " +
          "For page in page: {type: 'page_id', page_id: 'uuid'}. " +
          "For page in database: {type: 'database_id', database_id: 'uuid'}. " +
          "For database: {type: 'page_id', page_id: 'uuid'}.",
      },
      properties: {
        type: "object",
        description:
          "[page_create, page_update, page_properties_set, database_create, database_update] " +
          "Notion property values object. For pages, keys are property names; values follow Notion's property value schema. " +
          "For databases, keys define the schema (e.g. {Name: {title: {}}, Status: {select: {options: [{name: 'Active'}]}}}).",
      },
      children: {
        type: "array",
        description:
          "[page_create, page_content_append, block_children_append] " +
          "Array of block objects to add as children. Each follows Notion's block schema (e.g. {object:'block', type:'paragraph', paragraph:{rich_text:[{type:'text',text:{content:'Hello'}}]}}).",
      },
      icon: {
        type: "object",
        description:
          "[page_create, page_update, database_create, database_update] " +
          "Icon object: {type:'emoji', emoji:'\ud83d\udcc3'} or {type:'external', external:{url:'https://...'}}.",
      },
      cover: {
        type: "object",
        description:
          "[page_create, page_update, database_create, database_update] " +
          "Cover object: {type:'external', external:{url:'https://...'}}.",
      },
      archived: {
        type: "boolean",
        description: "[page_update, block_update] Set to true to archive, false to restore.",
      },

      // ── Database fields ───────────────────────────────────────────────────────
      database_id: {
        type: "string",
        description:
          "[database_get, database_update, database_query, database_filter, database_restore, property_list] " +
          "Notion database UUID (with or without dashes).",
      },
      title: {
        type: "string",
        description:
          "[database_create, database_update] Database title as a plain string (auto-wrapped in rich_text). " +
          "[page_title_set] New title for the page.",
      },
      description: {
        type: "string",
        description: "[database_update] Database description.",
      },
      is_inline: {
        type: "boolean",
        description: "[database_create] Create as an inline database. Default: false.",
      },
      filter: {
        type: "object",
        description:
          "[database_query, database_filter] Notion filter object. " +
          "Example: {property: 'Status', select: {equals: 'Active'}}.",
      },
      sorts: {
        type: "array",
        description:
          "[database_query, database_filter] Array of sort objects. " +
          "Example: [{property: 'Name', direction: 'ascending'}].",
      },

      // ── Block fields ─────────────────────────────────────────────────────────
      block_id: {
        type: "string",
        description:
          "[block_get, block_update, block_delete, block_children_list, block_children_append, block_restore, " +
          "comment_list, comment_get] " +
          "Notion block UUID.",
      },
      content: {
        type: "object",
        description:
          "[block_update] Block-type-specific content object (e.g. {paragraph: {rich_text: [...]}}).",
      },

      // ── Comment fields ───────────────────────────────────────────────────────
      discussion_id: {
        type: "string",
        description: "[comment_create] Existing discussion thread ID to reply to.",
      },
      rich_text: {
        type: "array",
        description:
          "[comment_create] Rich text array for the comment body. " +
          "Example: [{type: 'text', text: {content: 'Great work!'}}].",
      },

      // ── User fields ─────────────────────────────────────────────────────────
      user_id: {
        type: "string",
        description: "[user_get] Notion user UUID.",
      },

      // ── Search fields ────────────────────────────────────────────────────────
      query: {
        type: "string",
        description: "[search, search_filter] Text query to search for page/database titles.",
      },
      sort: {
        type: "object",
        description:
          "[search] Sort order: {direction: 'ascending'|'descending', timestamp: 'last_edited_time'}.",
      },
      object_type: {
        type: "string",
        description: "[search_filter] Filter results by type: 'page' or 'database'.",
        enum: ["page", "database"],
      },

      // ── Property fields ───────────────────────────────────────────────────────
      property_id: {
        type: "string",
        description:
          "[page_retrieve_property, page_get_property_item, property_get] " +
          "Property ID or name from the database schema.",
      },
      property_name: {
        type: "string",
        description:
          "[page_title_set] Name of the title property to update (default: 'title').",
      },

      // ── Content helper fields ───────────────────────────────────────────────
      title_text: {
        type: "string",
        description: "Alias — use 'title' for page_title_set.",
      },
      icon_type: {
        type: "string",
        description: "[page_icon_set] Type of icon: 'emoji' or 'external'.",
        enum: ["emoji", "external"],
      },
      icon_value: {
        type: "string",
        description:
          "[page_icon_set] Emoji character (e.g. '\ud83d\udcc4') for icon_type='emoji', " +
          "or image URL for icon_type='external'.",
      },
      cover_url: {
        type: "string",
        description: "[page_cover_set] Public image URL for the page cover.",
      },

      // ── Pagination ────────────────────────────────────────────────────────────
      start_cursor: {
        type: "string",
        description: "Pagination cursor (next_cursor from previous response).",
      },
      page_size: {
        type: "number",
        description: "Maximum results per page (1–100). Default: 100.",
      },

      // ── Generic request ──────────────────────────────────────────────────────
      method: {
        type: "string",
        description: "[request] HTTP method: GET, POST, PUT, PATCH, or DELETE. Default: GET.",
        enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      },
      path: {
        type: "string",
        description:
          "[request] Notion API path relative to /v1 (e.g. '/pages/uuid'). Must start with '/'.",
      },
      body: {
        type: "object",
        description: "[request] Request body for POST/PUT/PATCH operations.",
      },
    },
    required: ["operation"],
  },
};

module.exports = { NOTION_CLIENT_SCHEMA };
