"use strict";

const TEAMS_CLIENT_SCHEMA = {
  name: "teams_client",
  description:
    "Zero-dependency Microsoft Teams API client (pure Node.js https built-ins; no npm deps). " +
    "Auth: Pre-obtained OAuth2 access_token OR Client Credentials flow (tenant_id + client_id + client_secret → auto-fetches token from login.microsoftonline.com, cached in process). " +
    "Base URL: https://graph.microsoft.com/v1.0. " +
    "52 operations: " +
    "Teams (team_list, team_get, team_create, team_delete, team_update, team_members); " +
    "Channels (channel_list, channel_get, channel_create, channel_delete, channel_update, channel_members, channel_member_add); " +
    "Messages (message_list, message_get, message_send, message_reply, message_replies, message_update, message_delete); " +
    "Chats (chat_list, chat_get, chat_create, chat_members, chat_send); " +
    "Users (user_list, user_get, user_me, user_joined_teams, user_presence); " +
    "Files (file_list, file_get, file_upload, file_delete, file_share); " +
    "Meetings (meeting_create, meeting_get, meeting_list, meeting_update); " +
    "Apps (app_list, app_get, app_install); " +
    "Tabs (tab_list, tab_get, tab_create); " +
    "Tags (tag_list, tag_create, tag_delete); " +
    "Generic (request, info).",
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        description:
          "Operation to perform. " +
          "Teams: team_list, team_get, team_create, team_delete, team_update, team_members. " +
          "Channels: channel_list, channel_get, channel_create, channel_delete, channel_update, channel_members, channel_member_add. " +
          "Messages: message_list, message_get, message_send, message_reply, message_replies, message_update, message_delete. " +
          "Chats: chat_list, chat_get, chat_create, chat_members, chat_send. " +
          "Users: user_list, user_get, user_me, user_joined_teams, user_presence. " +
          "Files: file_list, file_get, file_upload, file_delete, file_share. " +
          "Meetings: meeting_create, meeting_get, meeting_list, meeting_update. " +
          "Apps: app_list, app_get, app_install. " +
          "Tabs: tab_list, tab_get, tab_create. " +
          "Tags: tag_list, tag_create, tag_delete. " +
          "Generic: request, info.",
        enum: [
          "team_list", "team_get", "team_create", "team_delete", "team_update", "team_members",
          "channel_list", "channel_get", "channel_create", "channel_delete", "channel_update",
          "channel_members", "channel_member_add",
          "message_list", "message_get", "message_send", "message_reply", "message_replies",
          "message_update", "message_delete",
          "chat_list", "chat_get", "chat_create", "chat_members", "chat_send",
          "user_list", "user_get", "user_me", "user_joined_teams", "user_presence",
          "file_list", "file_get", "file_upload", "file_delete", "file_share",
          "meeting_create", "meeting_get", "meeting_list", "meeting_update",
          "app_list", "app_get", "app_install",
          "tab_list", "tab_get", "tab_create",
          "tag_list", "tag_create", "tag_delete",
          "request", "info",
        ],
      },

      // ── Auth ────────────────────────────────────────────────────────────────
      access_token: {
        type: "string",
        description:
          "Pre-obtained OAuth2 Bearer access token for Microsoft Graph. " +
          "Provide this OR the client credentials triple (tenant_id + client_id + client_secret). " +
          "Never echoed in output.",
      },
      tenant_id: {
        type: "string",
        description:
          "Azure AD tenant ID (UUID). Required for Client Credentials flow (with client_id + client_secret).",
      },
      client_id: {
        type: "string",
        description: "Azure AD application (client) ID. Required for Client Credentials flow.",
      },
      client_secret: {
        type: "string",
        description: "Azure AD application client secret. Required for Client Credentials flow. Never echoed in output.",
      },
      scope: {
        type: "string",
        description:
          "OAuth2 scope for Client Credentials token fetch. " +
          "Default: 'https://graph.microsoft.com/.default'.",
      },

      // ── Connection ──────────────────────────────────────────────────────────
      timeout: {
        type: "number",
        description: "Request timeout in milliseconds (1000–120000). Default: 20000.",
      },
      reject_unauthorized: {
        type: "boolean",
        description: "Reject TLS certificates with invalid/self-signed certs (default: true). Set false only for dev.",
      },

      // ── Team fields ─────────────────────────────────────────────────────────
      team_id: {
        type: "string",
        description:
          "[team_get, team_delete, team_update, team_members, " +
          "channel_list, channel_get, channel_create, channel_delete, channel_update, channel_members, channel_member_add, " +
          "message_list, message_get, message_send, message_reply, message_replies, message_update, message_delete, " +
          "file_list, file_get, file_upload, file_delete, file_share, " +
          "app_list, app_get, app_install, tab_list, tab_get, tab_create, tag_list, tag_create, tag_delete] " +
          "Team ID (UUID).",
      },
      display_name: {
        type: "string",
        description:
          "[team_create, team_update, channel_create, channel_update, tab_create] Display name.",
      },
      description: {
        type: "string",
        description:
          "[team_create, team_update, channel_create, channel_update, tag_create] Description text.",
      },
      visibility: {
        type: "string",
        description: "[team_create, team_update] 'Public' or 'Private'. Default: 'Public'.",
        enum: ["Public", "Private"],
      },
      template: {
        type: "string",
        description:
          "[team_create] Teams template @odata.bind URL. " +
          "Default: 'https://graph.microsoft.com/v1.0/teamsTemplates(\'standard\')'.",
      },

      // ── Channel fields ──────────────────────────────────────────────────────
      channel_id: {
        type: "string",
        description:
          "[channel_get, channel_delete, channel_update, channel_members, channel_member_add, " +
          "message_list, message_get, message_send, message_reply, message_replies, message_update, message_delete, " +
          "file_list, tab_list, tab_get, tab_create] " +
          "Channel ID.",
      },
      membership_type: {
        type: "string",
        description: "[channel_create] 'standard', 'private', or 'shared'. Default: 'standard'.",
        enum: ["standard", "private", "shared"],
      },

      // ── Member fields ───────────────────────────────────────────────────────
      user_id: {
        type: "string",
        description:
          "[channel_member_add, user_get, user_joined_teams, user_presence] " +
          "Azure AD user ID or UPN. For user_joined_teams, omit for 'me'.",
      },
      roles: {
        type: "array",
        items: { type: "string" },
        description: "[channel_member_add] Roles to assign: [] (member) or ['owner'].",
      },

      // ── Message fields ──────────────────────────────────────────────────────
      message_id: {
        type: "string",
        description:
          "[message_get, message_reply, message_replies, message_update, message_delete] " +
          "Message ID.",
      },
      content: {
        type: "string",
        description:
          "[message_send, message_reply, message_update, chat_send] Message body content.",
      },
      content_type: {
        type: "string",
        description: "[message_send, message_reply, message_update, chat_send] 'text' (default) or 'html'.",
        enum: ["text", "html"],
      },
      subject: {
        type: "string",
        description: "[message_send, meeting_create, meeting_update] Subject line.",
      },
      importance: {
        type: "string",
        description: "[message_send] 'normal', 'high', or 'urgent'.",
        enum: ["normal", "high", "urgent"],
      },

      // ── Chat fields ─────────────────────────────────────────────────────────
      chat_id: {
        type: "string",
        description: "[chat_get, chat_members, chat_send] Chat ID.",
      },
      chat_type: {
        type: "string",
        description: "[chat_create] 'oneOnOne', 'group', or 'meeting'. Default: 'group'.",
        enum: ["oneOnOne", "group", "meeting"],
      },
      topic: {
        type: "string",
        description: "[chat_create] Chat topic/title.",
      },
      members: {
        type: "array",
        items: {
          type: "object",
          properties: {
            user_id: { type: "string", description: "Azure AD user ID." },
            roles:   { type: "array", items: { type: "string" }, description: "[] (member) or ['owner']." },
          },
          required: ["user_id"],
        },
        description:
          "[chat_create] Array of {user_id, roles?} objects defining chat members. " +
          "[tag_create] Array of {user_id} objects to tag.",
      },

      // ── Pagination / filter ─────────────────────────────────────────────────
      top: {
        type: "number",
        description: "Maximum items to return per page (varies by operation, default 20–100).",
      },
      skip: {
        type: "number",
        description: "[team_list] Number of items to skip for pagination.",
      },
      filter: {
        type: "string",
        description: "[team_list, channel_list, chat_list] OData $filter expression.",
      },
      search: {
        type: "string",
        description: "[user_list] Display name search substring.",
      },

      // ── File fields ─────────────────────────────────────────────────────────
      item_id: {
        type: "string",
        description: "[file_get, file_delete, file_share] OneDrive drive item ID.",
      },
      file_name: {
        type: "string",
        description: "[file_upload] Destination filename in Teams/SharePoint drive.",
      },
      folder_path: {
        type: "string",
        description: "[file_list, file_upload] Relative folder path within the channel root.",
      },
      content_base64: {
        type: "string",
        description: "[file_upload] File content as base64-encoded string (binary files).",
      },
      // 'content' field already declared above for messages; reused for file_upload (text files)
      type: {
        type: "string",
        description: "[file_share] Link type: 'view' (default) or 'edit'.",
        enum: ["view", "edit"],
      },
      scope: {
        type: "string",
        description: "[file_share] Link scope: 'organization' (default) or 'anonymous'.",
        enum: ["organization", "anonymous"],
      },

      // ── Meeting fields ──────────────────────────────────────────────────────
      event_id: {
        type: "string",
        description: "[meeting_get, meeting_update] Calendar event ID.",
      },
      start_datetime: {
        type: "string",
        description: "[meeting_create, meeting_update, meeting_list] ISO-8601 datetime string (e.g. '2024-01-15T14:00:00').",
      },
      end_datetime: {
        type: "string",
        description: "[meeting_create, meeting_update, meeting_list] ISO-8601 datetime string.",
      },
      timezone: {
        type: "string",
        description: "[meeting_create, meeting_update] Timezone string (default: 'UTC').",
      },
      attendees: {
        type: "array",
        description:
          "[meeting_create] Array of attendees. Each element is a string email address, " +
          "or an object {email, name?, type?} where type is 'required'|'optional'|'resource'.",
      },
      is_online_meeting: {
        type: "boolean",
        description: "[meeting_create] Create as online Teams meeting (default: true).",
      },
      allow_attendees_to_enable_camera: {
        type: "boolean",
        description: "[meeting_create] Allow attendees to enable their camera (default: not set).",
      },

      // ── App fields ──────────────────────────────────────────────────────────
      app_installation_id: {
        type: "string",
        description: "[app_get] Installed app ID within the team.",
      },
      teams_app_id: {
        type: "string",
        description: "[app_install, tab_create] Teams app catalog ID to install or create tab for.",
      },

      // ── Tab fields ──────────────────────────────────────────────────────────
      tab_id: {
        type: "string",
        description: "[tab_get] Tab ID.",
      },
      content_url: {
        type: "string",
        description: "[tab_create] Content URL for the tab iframe.",
      },
      website_url: {
        type: "string",
        description: "[tab_create] Website URL fallback for the tab. Defaults to content_url.",
      },

      // ── Tag fields ──────────────────────────────────────────────────────────
      tag_id: {
        type: "string",
        description: "[tag_delete] Tag ID to delete.",
      },

      // ── Generic request ─────────────────────────────────────────────────────
      method: {
        type: "string",
        description: "[request] HTTP method: GET, POST, PUT, PATCH, or DELETE. Default: GET.",
        enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      },
      path: {
        type: "string",
        description:
          "[request] Graph API path relative to /v1.0 (e.g. '/me/profile'). " +
          "Must start with '/'.",
      },
      body: {
        type: "object",
        description: "[request] Request body for POST/PUT/PATCH operations.",
      },
    },
    required: ["operation"],
  },
};

module.exports = { TEAMS_CLIENT_SCHEMA };
