"use strict";

const DISCORD_CLIENT_SCHEMA = {
  name: "discord_client",
  description:
    "Zero-dependency Discord REST API v10 client (pure Node.js https built-ins; no npm deps). " +
    "Auth: Bot Token via 'token' (Authorization: Bot <token>) or OAuth2 Bearer via 'bearer_token'. " +
    "Tokens never returned in output or errors. Base URL: https://discord.com/api/v10. " +
    "52 operations: " +
    "Guilds (guild_get, guild_create, guild_modify, guild_delete, guild_list, guild_channels, guild_members, guild_roles, guild_bans); " +
    "Channels (channel_get, channel_modify, channel_delete, channel_messages, channel_invites, channel_pins, channel_create_dm, channel_webhooks, channel_typing); " +
    "Messages (message_get, message_send, message_edit, message_delete, message_bulk_delete, message_pin, message_unpin, message_reactions); " +
    "Members (member_get, member_list, member_modify, member_kick, member_ban); " +
    "Roles (role_create, role_modify, role_delete, role_assign); " +
    "Users (user_me, user_get, user_guilds, user_dms); " +
    "Webhooks (webhook_create, webhook_get, webhook_modify, webhook_execute); " +
    "Reactions (reaction_add, reaction_remove, reaction_get); " +
    "Interactions (interaction_respond, interaction_followup); " +
    "Voice (voice_regions, voice_move); " +
    "Generic (request, info). " +
    "Rate-limit headers parsed and returned in _rateLimit field.",
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        description:
          "Operation to perform. " +
          "Guilds: guild_get, guild_create, guild_modify, guild_delete, guild_list, guild_channels, guild_members, guild_roles, guild_bans. " +
          "Channels: channel_get, channel_modify, channel_delete, channel_messages, channel_invites, channel_pins, channel_create_dm, channel_webhooks, channel_typing. " +
          "Messages: message_get, message_send, message_edit, message_delete, message_bulk_delete, message_pin, message_unpin, message_reactions. " +
          "Members: member_get, member_list, member_modify, member_kick, member_ban. " +
          "Roles: role_create, role_modify, role_delete, role_assign. " +
          "Users: user_me, user_get, user_guilds, user_dms. " +
          "Webhooks: webhook_create, webhook_get, webhook_modify, webhook_execute. " +
          "Reactions: reaction_add, reaction_remove, reaction_get. " +
          "Interactions: interaction_respond, interaction_followup. " +
          "Voice: voice_regions, voice_move. " +
          "Generic: request, info.",
        enum: [
          "guild_get", "guild_create", "guild_modify", "guild_delete", "guild_list",
          "guild_channels", "guild_members", "guild_roles", "guild_bans",
          "channel_get", "channel_modify", "channel_delete", "channel_messages",
          "channel_invites", "channel_pins", "channel_create_dm", "channel_webhooks", "channel_typing",
          "message_get", "message_send", "message_edit", "message_delete",
          "message_bulk_delete", "message_pin", "message_unpin", "message_reactions",
          "member_get", "member_list", "member_modify", "member_kick", "member_ban",
          "role_create", "role_modify", "role_delete", "role_assign",
          "user_me", "user_get", "user_guilds", "user_dms",
          "webhook_create", "webhook_get", "webhook_modify", "webhook_execute",
          "reaction_add", "reaction_remove", "reaction_get",
          "interaction_respond", "interaction_followup",
          "voice_regions", "voice_move",
          "request", "info",
        ],
      },

      // ── Auth ───────────────────────────────────────────────────────────────
      token: {
        type: "string",
        description:
          "Discord Bot Token (from Discord Developer Portal). " +
          "Sent as 'Authorization: Bot <token>'. " +
          "Required for most operations when not using bearer_token. Never echoed in output.",
      },
      bearer_token: {
        type: "string",
        description:
          "OAuth2 Bearer access token for user-context operations. " +
          "Sent as 'Authorization: Bearer <token>'. " +
          "Alternative to bot token; never echoed in output.",
      },

      // ── Connection ────────────────────────────────────────────────────────
      timeout: {
        type: "number",
        description: "Request timeout in milliseconds (1000-120000). Default: 20000.",
      },
      reject_unauthorized: {
        type: "boolean",
        description: "Reject TLS certificates that are invalid/self-signed (default: true). Set false only for dev.",
      },

      // ── Guild fields ──────────────────────────────────────────────────────
      guild_id: {
        type: "string",
        description:
          "[guild_get, guild_modify, guild_delete, guild_channels, guild_members, guild_roles, guild_bans, " +
          "member_get, member_list, member_modify, member_kick, member_ban, " +
          "role_create, role_modify, role_delete, role_assign, voice_regions, voice_move] " +
          "Discord Guild (server) ID (Snowflake).",
      },
      name: {
        type: "string",
        description:
          "[guild_create, guild_modify] Guild name (2-100 chars). " +
          "[webhook_create] Webhook name (1-80 chars). " +
          "[role_create, role_modify] Role name.",
      },
      verification_level: {
        type: "number",
        description: "[guild_create, guild_modify] Guild verification level: 0=NONE, 1=LOW, 2=MEDIUM, 3=HIGH, 4=VERY_HIGH.",
      },
      default_message_notifications: {
        type: "number",
        description: "[guild_create, guild_modify] Default message notifications: 0=ALL_MESSAGES, 1=ONLY_MENTIONS.",
      },
      explicit_content_filter: {
        type: "number",
        description: "[guild_create, guild_modify] Explicit content filter: 0=DISABLED, 1=MEMBERS_WITHOUT_ROLES, 2=ALL_MEMBERS.",
      },
      afk_channel_id: {
        type: "string",
        description: "[guild_create, guild_modify] AFK channel ID.",
      },
      afk_timeout: {
        type: "number",
        description: "[guild_create, guild_modify] AFK timeout in seconds: 60, 300, 900, 1800, or 3600.",
      },
      system_channel_id: {
        type: "string",
        description: "[guild_create, guild_modify] System channel ID for system messages.",
      },
      rules_channel_id: {
        type: "string",
        description: "[guild_modify] Rules channel ID.",
      },
      description: {
        type: "string",
        description: "[guild_modify] Guild description.",
      },
      roles: {
        type: "array",
        description: "[guild_create] Array of role objects to create with the guild.",
      },
      channels: {
        type: "array",
        description: "[guild_create] Array of channel objects to create with the guild.",
      },
      region: {
        type: "string",
        description: "[guild_create, guild_modify] Voice region ID (deprecated in favor of per-channel region overrides).",
      },

      // ── Channel fields ────────────────────────────────────────────────────
      channel_id: {
        type: "string",
        description:
          "[channel_get, channel_modify, channel_delete, channel_messages, channel_invites, " +
          "channel_pins, channel_webhooks, channel_typing, " +
          "message_get, message_send, message_edit, message_delete, message_bulk_delete, " +
          "message_pin, message_unpin, message_reactions, " +
          "webhook_create, reaction_add, reaction_remove, reaction_get] " +
          "Discord Channel ID (Snowflake). " +
          "[member_modify, voice_move] Target voice channel ID (null to disconnect).",
      },
      topic: {
        type: "string",
        description: "[channel_modify] Channel topic (0-1024 chars).",
      },
      nsfw: {
        type: "boolean",
        description: "[channel_modify] Whether the channel is age-restricted.",
      },
      rate_limit_per_user: {
        type: "number",
        description: "[channel_modify] Slowmode cooldown in seconds (0-21600).",
      },
      bitrate: {
        type: "number",
        description: "[channel_modify] Voice channel bitrate in bits (8000-128000).",
      },
      user_limit: {
        type: "number",
        description: "[channel_modify] Voice channel user limit (0=no limit, 1-99).",
      },
      position: {
        type: "number",
        description: "[channel_modify, role_modify] Sorting position.",
      },
      parent_id: {
        type: "string",
        description: "[channel_modify] Category channel ID to place channel under.",
      },
      recipient_id: {
        type: "string",
        description: "[channel_create_dm] User ID of the DM recipient.",
      },

      // ── Message fields ────────────────────────────────────────────────────
      message_id: {
        type: "string",
        description:
          "[message_get, message_edit, message_delete, message_pin, message_unpin, " +
          "message_reactions, reaction_add, reaction_remove, reaction_get] " +
          "Discord Message ID (Snowflake).",
      },
      content: {
        type: "string",
        description: "[message_send, message_edit, webhook_execute, interaction_followup] Message content (max 2000 chars).",
      },
      tts: {
        type: "boolean",
        description: "[message_send, webhook_execute] Whether to use TTS for the message.",
      },
      embeds: {
        type: "array",
        description:
          "[message_send, message_edit, webhook_execute, interaction_followup] " +
          "Array of embed objects. Each: {title, description, url, color, fields, author, footer, image, thumbnail}.",
      },
      components: {
        type: "array",
        description:
          "[message_send, message_edit, webhook_execute, interaction_followup] " +
          "Array of message component objects (buttons, select menus).",
      },
      message_reference: {
        type: "object",
        description: "[message_send] Reference to reply to another message: {message_id, channel_id?, guild_id?}.",
      },
      allowed_mentions: {
        type: "object",
        description: "[message_send] Control which mentions trigger notifications: {parse?, roles?, users?, replied_user?}.",
      },
      flags: {
        type: "number",
        description: "[message_send, message_edit] Message flags bitfield (e.g. 64 = EPHEMERAL).",
      },
      message_ids: {
        type: "array",
        description: "[message_bulk_delete] Array of 2-100 message IDs to delete (must be <14 days old).",
      },
      around: {
        type: "string",
        description: "[channel_messages] Get messages around this message ID.",
      },

      // ── Member fields ─────────────────────────────────────────────────────
      user_id: {
        type: "string",
        description:
          "[member_get, member_modify, member_kick, member_ban, " +
          "role_assign, reaction_remove, user_get, voice_move] " +
          "Discord User ID (Snowflake).",
      },
      nick: {
        type: "string",
        description: "[member_modify] New nickname for the member (null to remove).",
      },
      mute: {
        type: "boolean",
        description: "[member_modify] Whether the member is server muted.",
      },
      deaf: {
        type: "boolean",
        description: "[member_modify] Whether the member is server deafened.",
      },
      communication_disabled_until: {
        type: "string",
        description: "[member_modify] ISO8601 timestamp for timeout end (null to remove timeout).",
      },
      delete_message_seconds: {
        type: "number",
        description: "[member_ban] Number of seconds of messages to delete on ban (0-604800, i.e. 0-7 days).",
      },
      reason: {
        type: "string",
        description: "[member_ban] Audit log reason for the ban (sent in X-Audit-Log-Reason header).",
      },

      // ── Role fields ───────────────────────────────────────────────────────
      role_id: {
        type: "string",
        description: "[role_modify, role_delete, role_assign] Discord Role ID (Snowflake).",
      },
      permissions: {
        type: "string",
        description: "[role_create, role_modify] Permission bitfield string (e.g. '8' for ADMINISTRATOR).",
      },
      color: {
        type: "number",
        description: "[role_create, role_modify] Role color as integer (e.g. 0xFF0000 for red).",
      },
      hoist: {
        type: "boolean",
        description: "[role_create, role_modify] Whether the role is displayed separately in the member list.",
      },
      mentionable: {
        type: "boolean",
        description: "[role_create, role_modify] Whether the role can be mentioned.",
      },

      // ── Webhook fields ────────────────────────────────────────────────────
      webhook_id: {
        type: "string",
        description: "[webhook_get, webhook_modify, webhook_execute] Discord Webhook ID (Snowflake).",
      },
      webhook_token: {
        type: "string",
        description: "[webhook_execute] Webhook token (from webhook creation). Never echoed in output.",
      },
      avatar: {
        type: "string",
        description: "[webhook_create, webhook_modify] Avatar image as base64 data URI or null to remove.",
      },
      username: {
        type: "string",
        description: "[webhook_execute] Override the webhook's username for this execution.",
      },
      avatar_url: {
        type: "string",
        description: "[webhook_execute] Override the webhook's avatar URL for this execution.",
      },
      wait: {
        type: "boolean",
        description: "[webhook_execute] Wait for server confirmation and return the created message. Default: false.",
      },
      thread_id: {
        type: "string",
        description: "[webhook_execute] Send the message to a thread within the channel.",
      },

      // ── Reaction fields ───────────────────────────────────────────────────
      emoji: {
        type: "string",
        description:
          "[reaction_add, reaction_remove, reaction_get, message_reactions] " +
          "Emoji to react with. For standard emoji: the character (e.g. 'thumbsup'). " +
          "For custom emoji: name:id (e.g. 'myemoji:123456789').",
      },

      // ── Interaction fields ───────────────────────────────────────��─────────
      interaction_id: {
        type: "string",
        description: "[interaction_respond] Discord interaction ID.",
      },
      interaction_token: {
        type: "string",
        description: "[interaction_respond, interaction_followup] Interaction token (valid 15 minutes). Never echoed in output.",
      },
      type: {
        type: "number",
        description:
          "[interaction_respond] Interaction response type: " +
          "1=PONG, 4=CHANNEL_MESSAGE_WITH_SOURCE, 5=DEFERRED_CHANNEL_MESSAGE, " +
          "6=DEFERRED_UPDATE_MESSAGE, 7=UPDATE_MESSAGE.",
      },
      data: {
        type: "object",
        description: "[interaction_respond] Interaction response data object (message content, embeds, etc.).",
      },
      application_id: {
        type: "string",
        description: "[interaction_followup] Discord application/bot ID.",
      },
      ephemeral: {
        type: "boolean",
        description: "[interaction_followup] Whether the follow-up message should be ephemeral (visible only to the user).",
      },

      // ── Pagination & filtering ─────────────────────────────────────────────
      limit: {
        type: "number",
        description: "Maximum number of results to return. Max varies by operation (e.g. 100 for messages, 1000 for members).",
      },
      before: {
        type: "string",
        description: "Snowflake ID — return results before this ID (for pagination).",
      },
      after: {
        type: "string",
        description: "Snowflake ID — return results after this ID (for pagination).",
      },

      // ── Generic request ───────────────────────────────────────────────────
      method: {
        type: "string",
        description: "[request] HTTP method: GET, POST, PUT, PATCH, or DELETE. Default: GET.",
        enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      },
      path: {
        type: "string",
        description: "[request] Discord API path relative to /api/v10 (e.g. '/guilds/123/channels'). Must start with '/'.",
      },
      body: {
        type: "object",
        description: "[request] Request body for POST/PUT/PATCH operations.",
      },
    },
    required: ["operation"],
  },
};

module.exports = { DISCORD_CLIENT_SCHEMA };
