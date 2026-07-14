"use strict";

const SLACK_CLIENT_SCHEMA = {
  name: "slack_client",
  description:
    "Zero-dependency Slack Web API client (pure Node.js https built-ins; no npm deps). " +
    "Auth: Bot Token (xoxb-...) or User Token (xoxp-...) via Bearer. " +
    "51 operations: " +
    "Messages (message_post, message_update, message_delete, message_reply, messages_history, " +
    "message_permalink, message_search, message_scheduled_list); " +
    "Channels (channel_list, channel_get, channel_create, channel_archive, channel_unarchive, " +
    "channel_invite, channel_join, channel_leave, channel_rename); " +
    "Users (user_list, user_get, user_me, user_set_status, user_lookup_by_email); " +
    "Files (file_list, file_get, file_upload, file_delete, file_share); " +
    "Reactions (reaction_add, reaction_remove, reaction_list, reaction_get); " +
    "Pins (pin_add, pin_remove); " +
    "Reminders (reminder_add, reminder_list, reminder_delete); " +
    "Usergroups (usergroup_list, usergroup_create, usergroup_update); " +
    "Workspace (team_info, emoji_list, bot_info, app_info, auth_test); " +
    "Bookmarks (bookmark_add, bookmark_list); Stars (star_add, star_remove); " +
    "DMs (dm_open, dm_close, dm_history); Generic (request).",
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        description:
          "Operation to perform. " +
          "Messages: message_post, message_update, message_delete, message_reply, messages_history, " +
          "message_permalink, message_search, message_scheduled_list. " +
          "Channels: channel_list, channel_get, channel_create, channel_archive, channel_unarchive, " +
          "channel_invite, channel_join, channel_leave, channel_rename. " +
          "Users: user_list, user_get, user_me, user_set_status, user_lookup_by_email. " +
          "Files: file_list, file_get, file_upload, file_delete, file_share. " +
          "Reactions: reaction_add, reaction_remove, reaction_list, reaction_get. " +
          "Pins: pin_add, pin_remove. " +
          "Reminders: reminder_add, reminder_list, reminder_delete. " +
          "Usergroups: usergroup_list, usergroup_create, usergroup_update. " +
          "Workspace: team_info, emoji_list, bot_info, app_info, auth_test. " +
          "Bookmarks: bookmark_add, bookmark_list. Stars: star_add, star_remove. " +
          "DMs: dm_open, dm_close, dm_history. Generic: request.",
        enum: [
          "message_post", "message_update", "message_delete", "message_reply",
          "messages_history", "message_permalink", "message_search", "message_scheduled_list",
          "channel_list", "channel_get", "channel_create", "channel_archive",
          "channel_unarchive", "channel_invite", "channel_join", "channel_leave", "channel_rename",
          "user_list", "user_get", "user_me", "user_set_status", "user_lookup_by_email",
          "file_list", "file_get", "file_upload", "file_delete", "file_share",
          "reaction_add", "reaction_remove", "reaction_list", "reaction_get",
          "pin_add", "pin_remove",
          "reminder_add", "reminder_list", "reminder_delete",
          "usergroup_list", "usergroup_create", "usergroup_update",
          "team_info", "emoji_list", "bot_info", "app_info", "auth_test",
          "bookmark_add", "bookmark_list",
          "star_add", "star_remove",
          "dm_open", "dm_close", "dm_history",
          "request",
        ],
      },
      token: {
        type: "string",
        description:
          "Slack API token. Bot Token (xoxb-...) for most operations; " +
          "User Token (xoxp-...) for user-scoped operations (search, stars, reactions.list). " +
          "Never echoed in output.",
      },
      timeout: {
        type: "number",
        description: "Request timeout in milliseconds (1000-120000). Default: 20000.",
      },
      reject_unauthorized: {
        type: "boolean",
        description: "Reject TLS certificates with invalid/self-signed certs. Default: true.",
      },

      // --- Message fields ---
      channel: {
        type: "string",
        description:
          "[message_post, message_update, message_delete, message_reply, messages_history, " +
          "message_permalink, channel_get, channel_archive, channel_unarchive, channel_invite, " +
          "channel_join, channel_leave, channel_rename, reaction_add, reaction_remove, reaction_get, " +
          "pin_add, pin_remove, dm_close, dm_history] " +
          "Slack channel ID (e.g. C012AB3CD) or DM ID (D...). Use channel_list to find IDs.",
      },
      text: {
        type: "string",
        description:
          "[message_post, message_update, message_reply] Message text. Supports Slack mrkdwn " +
          "(*bold*, _italic_, `code`, <URL|label>, <!channel>, <@user>). " +
          "Required if blocks not provided.",
      },
      ts: {
        type: "string",
        description:
          "[message_update, message_delete, reaction_add, reaction_remove, reaction_get, " +
          "pin_add, pin_remove] Message timestamp (e.g. '1512085950.000216'). " +
          "Identifies a specific message in a channel.",
      },
      thread_ts: {
        type: "string",
        description:
          "[message_post, message_reply] Thread timestamp — set to the parent message's ts " +
          "to post as a threaded reply.",
      },
      blocks: {
        type: "array",
        items: { type: "object" },
        description:
          "[message_post, message_update, message_reply] Slack Block Kit blocks array " +
          "(https://api.slack.com/block-kit). Alternative/complement to text for rich layouts.",
      },
      mrkdwn: {
        type: "boolean",
        description: "[message_post] Enable Slack mrkdwn formatting in text. Default: true.",
      },
      username: {
        type: "string",
        description: "[message_post] Override bot display name for this message.",
      },
      icon_emoji: {
        type: "string",
        description: "[message_post] Override bot icon with an emoji, e.g. ':robot_face:'.",
      },
      icon_url: {
        type: "string",
        description: "[message_post] Override bot icon with an image URL.",
      },
      reply_broadcast: {
        type: "boolean",
        description:
          "[message_reply] Also post the reply to the channel (shows in both channel and thread). Default: false.",
      },
      message_ts: {
        type: "string",
        description: "[message_permalink] Timestamp of the message to get a permalink for.",
      },

      // --- History/pagination ---
      oldest: {
        type: "string",
        description: "[messages_history, dm_history] Start of time range as Unix timestamp.",
      },
      latest: {
        type: "string",
        description: "[messages_history, dm_history] End of time range as Unix timestamp. Default: now.",
      },
      inclusive: {
        type: "boolean",
        description: "[messages_history, dm_history] Include messages with oldest/latest timestamps. Default: false.",
      },
      cursor: {
        type: "string",
        description: "Pagination cursor from previous response's response_metadata.next_cursor.",
      },
      limit: {
        type: "number",
        description: "Maximum number of results per page. Varies by operation (default varies 20-200).",
      },

      // --- Search ---
      query: {
        type: "string",
        description: "[message_search] Full-text search query. Supports modifiers like 'in:#channel', 'from:@user', 'before:YYYY-MM-DD'.",
      },
      sort: {
        type: "string",
        description: "[message_search] Sort field: 'score' (default) or 'timestamp'.",
        enum: ["score", "timestamp"],
      },
      sort_dir: {
        type: "string",
        description: "[message_search] Sort direction: 'desc' (default) or 'asc'.",
        enum: ["desc", "asc"],
      },
      count: {
        type: "number",
        description: "[message_search, file_list] Number of results per page (default: 20, max: 100).",
      },
      page: {
        type: "number",
        description: "[message_search, file_list] Page number (default: 1).",
      },
      highlight: {
        type: "boolean",
        description: "[message_search] Include highlighting markers in results. Default: false.",
      },

      // --- Channel fields ---
      types: {
        type: "string",
        description:
          "[channel_list] Comma-separated channel types to include. " +
          "Default: 'public_channel,private_channel'. Options: public_channel, private_channel, mpim, im.",
      },
      exclude_archived: {
        type: "boolean",
        description: "[channel_list] Exclude archived channels. Default: false.",
      },
      name: {
        type: "string",
        description: "[channel_create, channel_rename, usergroup_create, usergroup_update] Channel or usergroup name.",
      },
      is_private: {
        type: "boolean",
        description: "[channel_create] Create as private channel. Default: false (public).",
      },

      // --- User fields ---
      user: {
        type: "string",
        description:
          "[user_get, reaction_list, file_list] Slack user ID (e.g. U012AB3CD). " +
          "Use user_list or user_lookup_by_email to find IDs.",
      },
      email: {
        type: "string",
        description: "[user_lookup_by_email] Email address to look up.",
      },
      status_text: {
        type: "string",
        description: "[user_set_status] Status text (max 100 chars). Empty string clears status.",
      },
      status_emoji: {
        type: "string",
        description: "[user_set_status] Status emoji, e.g. ':working_from_home:'. Empty string clears.",
      },
      status_expiration: {
        type: "number",
        description: "[user_set_status] Unix timestamp when status expires. 0 = never expires.",
      },
      users: {
        type: ["string", "array"],
        items: { type: "string" },
        description:
          "[channel_invite, dm_open] User ID(s) to invite or open DM with. " +
          "String (comma-separated) or array of user IDs.",
      },

      // --- File fields ---
      file: {
        type: "string",
        description: "[file_get, file_delete, file_share, star_add] File ID (e.g. F012AB3CD).",
      },
      filename: {
        type: "string",
        description: "[file_upload] Filename for the upload (e.g. 'report.pdf').",
      },
      content_base64: {
        type: "string",
        description: "[file_upload] File content as base64-encoded string (binary files).",
      },
      content: {
        type: "string",
        description: "[file_upload] File content as plain text (text files). Alternative to content_base64.",
      },
      channels: {
        type: "string",
        description:
          "[file_upload, usergroup_create, usergroup_update] " +
          "Comma-separated channel IDs to share file/usergroup with.",
      },
      title: {
        type: "string",
        description: "[file_upload] Title for the uploaded file.",
      },
      filetype: {
        type: "string",
        description: "[file_upload, file_list] File type override or filter (e.g. 'pdf', 'png', 'text').",
      },
      media_type: {
        type: "string",
        description: "[file_upload] MIME type (e.g. 'application/pdf'). Default: application/octet-stream.",
      },
      ts_from: {
        type: "string",
        description: "[file_list] Filter files created after this timestamp.",
      },
      ts_to: {
        type: "string",
        description: "[file_list] Filter files created before this timestamp.",
      },

      // --- Reaction fields ---
      name: {
        type: "string",
        description:
          "[reaction_add, reaction_remove] Reaction emoji name without colons (e.g. 'thumbsup', '+1', 'heart').",
      },
      timestamp: {
        type: "string",
        description:
          "[reaction_add, reaction_remove, reaction_get, pin_add, pin_remove, star_add, star_remove] " +
          "Message timestamp to react to / pin / star.",
      },
      full: {
        type: "boolean",
        description: "[reaction_get, reaction_list] If true, return full reaction details including user lists.",
      },

      // --- Reminder fields ---
      reminder: {
        type: "string",
        description: "[reminder_delete] Reminder ID (Rm...).",
      },
      time: {
        type: "string",
        description:
          "[reminder_add] When the reminder fires. Unix timestamp, relative offset (e.g. 'in 20 minutes'), " +
          "or natural language ('every Monday at 9am').",
      },

      // --- Usergroup fields ---
      usergroup: {
        type: "string",
        description: "[usergroup_update] Usergroup ID (S...).",
      },
      handle: {
        type: "string",
        description: "[usergroup_create, usergroup_update] @handle for the usergroup (no @).",
      },
      description: {
        type: "string",
        description: "[usergroup_create, usergroup_update, channel_create] Description text.",
      },
      include_disabled: {
        type: "boolean",
        description: "[usergroup_list] Include disabled usergroups. Default: false.",
      },
      include_count: {
        type: "boolean",
        description: "[usergroup_list] Include user count per group. Default: false.",
      },
      include_users: {
        type: "boolean",
        description: "[usergroup_list] Include user lists per group. Default: false.",
      },

      // --- Workspace fields ---
      team_id: {
        type: "string",
        description: "[team_info, channel_create, user_list] Slack team/workspace ID for Enterprise Grid.",
      },
      bot: {
        type: "string",
        description: "[bot_info] Bot user ID or app ID to look up. Omit for the calling bot.",
      },

      // --- Bookmark fields ---
      channel_id: {
        type: "string",
        description: "[bookmark_add, bookmark_list] Channel ID to manage bookmarks for.",
      },
      type: {
        type: "string",
        description:
          "[bookmark_add] Bookmark type: 'link' for a URL, 'message' for a message reference.",
        enum: ["link", "message"],
      },
      link: {
        type: "string",
        description: "[bookmark_add] URL for a link-type bookmark.",
      },
      emoji: {
        type: "string",
        description: "[bookmark_add] Emoji for the bookmark (e.g. ':bookmark:').",
      },
      entity_id: {
        type: "string",
        description: "[bookmark_add] Entity (message) ts for message-type bookmarks.",
      },

      // --- Star fields ---
      file_comment: {
        type: "string",
        description: "[star_add, star_remove] File comment ID to star/unstar.",
      },

      // --- DM fields ---
      return_im: {
        type: "boolean",
        description: "[dm_open] Include IM channel object in response even if already open. Default: false.",
      },

      // --- Generic request ---
      method: {
        type: "string",
        description: "[request] HTTP method: GET or POST. Default: GET.",
        enum: ["GET", "POST"],
      },
      api_method: {
        type: "string",
        description:
          "[request] Slack API method name (e.g. 'conversations.list', 'chat.postMessage'). " +
          "See https://api.slack.com/methods for full list.",
      },
      body: {
        type: "object",
        description: "[request] Request body/params object for the generic request.",
      },
    },
    required: ["operation", "token"],
  },
};

module.exports = { SLACK_CLIENT_SCHEMA };
