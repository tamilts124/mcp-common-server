"use strict";

const CONFLUENCE_CLIENT_SCHEMA = {
  name: "confluence_client",
  description:
    "Zero-dependency Confluence REST API client (pure Node.js https built-ins; no npm deps). " +
    "Supports Confluence Cloud (API v2 + legacy REST) and Confluence Server/Data Center. " +
    "Auth: Email + API Token (Cloud) via HTTP Basic, or PAT via Bearer. " +
    "54 operations: Spaces (space_list, space_get, space_create, space_delete, space_permissions, space_content); " +
    "Pages (page_list, page_get, page_create, page_update, page_delete, page_children, page_ancestors, page_search, page_move, page_history); " +
    "Blog Posts (blog_list, blog_get, blog_create, blog_update, blog_delete); " +
    "Comments (comment_list, comment_get, comment_create, comment_update, comment_delete); " +
    "Attachments (attachment_list, attachment_get, attachment_upload, attachment_delete, attachment_download_url); " +
    "Labels (label_list, label_add, label_remove, label_search); " +
    "Search (search, search_user); Users (user_get, user_me, user_groups, user_watch_list); " +
    "Watchers (watcher_list, watcher_add); Tasks (task_list, task_get, task_update); " +
    "Versions (version_list, version_get, version_restore); " +
    "Templates (template_list, template_get, template_create); Generic (info, request).",
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        description:
          "Operation to perform. " +
          "Spaces: space_list, space_get, space_create, space_delete, space_permissions, space_content. " +
          "Pages: page_list, page_get, page_create, page_update, page_delete, page_children, page_ancestors, page_search, page_move, page_history. " +
          "Blog Posts: blog_list, blog_get, blog_create, blog_update, blog_delete. " +
          "Comments: comment_list, comment_get, comment_create, comment_update, comment_delete. " +
          "Attachments: attachment_list, attachment_get, attachment_upload, attachment_delete, attachment_download_url. " +
          "Labels: label_list, label_add, label_remove, label_search. " +
          "Search: search, search_user. " +
          "Users: user_get, user_me, user_groups, user_watch_list. " +
          "Watchers: watcher_list, watcher_add. " +
          "Tasks: task_list, task_get, task_update. " +
          "Versions: version_list, version_get, version_restore. " +
          "Templates: template_list, template_get, template_create. " +
          "Generic: info, request.",
        enum: [
          "space_list", "space_get", "space_create", "space_delete", "space_permissions", "space_content",
          "page_list", "page_get", "page_create", "page_update", "page_delete",
          "page_children", "page_ancestors", "page_search", "page_move", "page_history",
          "blog_list", "blog_get", "blog_create", "blog_update", "blog_delete",
          "comment_list", "comment_get", "comment_create", "comment_update", "comment_delete",
          "attachment_list", "attachment_get", "attachment_upload", "attachment_delete", "attachment_download_url",
          "label_list", "label_add", "label_remove", "label_search",
          "search", "search_user",
          "user_get", "user_me", "user_groups", "user_watch_list",
          "watcher_list", "watcher_add",
          "task_list", "task_get", "task_update",
          "version_list", "version_get", "version_restore",
          "template_list", "template_get", "template_create",
          "info", "request",
        ],
      },
      base_url: {
        type: "string",
        description:
          "Base URL of your Confluence instance. " +
          "Cloud: https://<workspace>.atlassian.net  " +
          "Server/DC: https://<your-host>",
      },
      email: {
        type: "string",
        description: "[Cloud] Atlassian account email address for API Token authentication.",
      },
      api_token: {
        type: "string",
        description: "[Cloud] Atlassian API Token (from https://id.atlassian.com/manage-profile/security/api-tokens). Used with email.",
      },
      pat: {
        type: "string",
        description: "[Server/DC] Personal Access Token for Bearer authentication. Alternative to email+api_token.",
      },
      cloud: {
        type: "boolean",
        description: "Set to false for Confluence Server/Data Center (uses /rest/api). Default: true (Confluence Cloud, uses /wiki/api/v2).",
      },
      timeout: {
        type: "number",
        description: "Request timeout in milliseconds (1000-120000). Default: 20000.",
      },
      reject_unauthorized: {
        type: "boolean",
        description: "Reject TLS connections with invalid/self-signed certificates. Default: true. Set false only for development.",
      },

      // Space fields
      space_id: {
        type: "string",
        description: "[space_get, page_list, blog_list, page_create, blog_create] Confluence space numeric ID (Cloud v2 API).",
      },
      space_key: {
        type: "string",
        description: "[space_get, space_create, space_delete, space_permissions, space_content, page_list, blog_list, page_create, blog_create, label_search, template_list, template_create] Space key (e.g. 'ENG', '~accountId').",
      },
      key: {
        type: "string",
        description: "[space_create] New space key (e.g. 'NEWTEAM'). Must be unique.",
      },
      name: {
        type: "string",
        description: "[space_create, template_create] Name for the new space or template.",
      },
      type: {
        type: "string",
        description: "[space_create] Space type: 'global' (default) or 'personal'.",
        enum: ["global", "personal"],
      },

      // Page/Blog fields
      page_id: {
        type: "string",
        description: "[page_get, page_update, page_delete, page_children, page_ancestors, page_move, page_history, comment_list, attachment_list, label_list, label_add, label_remove, version_list, version_get, version_restore, watcher_list, watcher_add] Page numeric ID.",
      },
      blog_id: {
        type: "string",
        description: "[blog_get, blog_update, blog_delete, label_list, label_add, label_remove] Blog post numeric ID.",
      },
      title: {
        type: "string",
        description: "[page_create, page_update, page_search, blog_create, blog_update, template_create] Page, blog, or template title.",
      },
      body: {
        type: "string",
        description: "[page_create, page_update, blog_create, blog_update, comment_create, comment_update, template_create] Content body in Confluence Storage Format (XHTML-like). For page/blog updates, required alongside version.",
      },
      parent_id: {
        type: "string",
        description: "[page_create] Parent page ID (for nested pages).",
      },
      target_parent_id: {
        type: "string",
        description: "[page_move] Target parent page ID to move the page under.",
      },
      position: {
        type: "string",
        description: "[page_move] Position relative to target: 'append' (default), 'prepend', 'before', 'after'.",
        enum: ["append", "prepend", "before", "after"],
      },
      status: {
        type: "string",
        description: "[page_create, page_update, blog_create, blog_update, page_list, blog_list, comment_list] Content status. 'current' (published, default), 'draft', or 'archived'.",
      },
      include_body: {
        type: "boolean",
        description: "[page_get, blog_get] If true, includes the page/blog body in storage format in the response. Default: false.",
      },

      // Comment fields
      comment_id: {
        type: "string",
        description: "[comment_get, comment_update, comment_delete] Comment numeric ID.",
      },

      // Attachment fields
      attachment_id: {
        type: "string",
        description: "[attachment_get, attachment_delete, attachment_download_url] Attachment ID.",
      },
      filename: {
        type: "string",
        description: "[attachment_upload] Original filename for the attachment (e.g. 'report.pdf').",
      },
      content_base64: {
        type: "string",
        description: "[attachment_upload] File content as a base64-encoded string.",
      },
      media_type: {
        type: "string",
        description: "[attachment_upload] MIME type of the file (e.g. 'application/pdf', 'image/png'). Default: 'application/octet-stream'.",
      },
      comment: {
        type: "string",
        description: "[attachment_upload] Optional comment/description for the attachment.",
      },

      // Label fields
      label: {
        type: "string",
        description: "[label_remove, label_search] Label name to remove or search for.",
      },
      labels: {
        type: "array",
        items: { type: "string" },
        description: "[label_add] Array of label names to add to the content.",
      },

      // Search fields
      cql: {
        type: "string",
        description: "[search, page_search] Confluence Query Language (CQL) expression. Example: 'space.key=ENG AND type=page AND text~\"deploy\"'.",
      },
      include_archived: {
        type: "boolean",
        description: "[search] Include archived spaces in search results. Default: false.",
      },

      // User fields
      account_id: {
        type: "string",
        description: "[user_get, user_groups, user_watch_list, watcher_add] Atlassian account ID (Cloud) or user account ID.",
      },
      username: {
        type: "string",
        description: "[user_get (Server/DC), user_groups (Server/DC)] Username for Server/DC authentication.",
      },

      // Task fields
      task_id: {
        type: "string",
        description: "[task_get, task_update] Task numeric ID.",
      },
      due_date: {
        type: "string",
        description: "[task_update] Due date for the task in ISO 8601 format (e.g. '2025-12-31T00:00:00.000Z').",
      },

      // Version fields
      version: {
        type: "number",
        description: "[page_update, blog_update, comment_update] Current version number of the content (required for updates; the API auto-increments to number+1).",
      },
      version_number: {
        type: "number",
        description: "[version_get, version_restore] The specific version number to retrieve or restore.",
      },
      message: {
        type: "string",
        description: "[version_restore] Optional message/comment for the version restore operation.",
      },

      // Template fields
      template_id: {
        type: "string",
        description: "[template_get] Template numeric ID.",
      },
      description: {
        type: "string",
        description: "[space_create, template_create] Optional description.",
      },

      // Pagination
      limit: {
        type: "number",
        description: "Maximum number of results to return per page (default: 25). Cloud APIs accept up to 250; Server/DC up to 50.",
      },
      start: {
        type: "number",
        description: "[Server/DC] Zero-based offset for paginating results. For Cloud APIs use cursor instead.",
      },
      cursor: {
        type: "string",
        description: "[Cloud] Pagination cursor token from the previous response's _links.next field.",
      },

      // Generic request
      method: {
        type: "string",
        description: "[request] HTTP method: GET, POST, PUT, DELETE, PATCH. Default: GET.",
        enum: ["GET", "POST", "PUT", "DELETE", "PATCH"],
      },
      api_path: {
        type: "string",
        description: "[request] Full API path starting with / (e.g. '/wiki/api/v2/spaces'). Used for custom or undocumented endpoints.",
      },
      query: {
        type: "string",
        description: "[search_user] Text to search for in user display names or usernames.",
      },
    },
    required: ["operation", "base_url"],
  },
};

module.exports = { CONFLUENCE_CLIENT_SCHEMA };
