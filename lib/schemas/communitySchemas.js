"use strict";
// ── COMMUNITY TOOL SCHEMAS ────────────────────────────────────────────────────
// AI Community: session management, peer discovery, AI-to-AI messaging,
// broadcast, thread replies, named rooms/channels, and message TTL.
// Enabled via  --category=community  on the CLI.
//
// Passive notification: every tool call that supplies a `session_id` receives
// an  _inbox  envelope in the response with unread/total counts, ensuring an
// AI never misses messages even if it forgets to poll.

const COMMUNITY_SCHEMAS = [
  // ── Sessions ──────────────────────────────────────────────────────────────
  {
    name: "community_register",
    description:
      "Register (or refresh) an AI session in the community. Call this once per session " +
      "to announce your presence. If the session_id already exists the record is updated " +
      "(name, description). Other AIs can discover you via community_list_sessions.",
    inputSchema: {
      type: "object",
      required: ["session_id"],
      properties: {
        session_id:  { type: "string", description: "Unique identifier for this AI session (≤ 128 chars). Choose something stable, e.g. a UUID or a descriptive slug." },
        name:        { type: "string", description: "Human-readable display name for this AI (≤ 64 chars). Defaults to session_id." },
        description: { type: "string", description: "Short description of this AI's role or capabilities (≤ 256 chars)." },
      },
    },
  },
  {
    name: "community_list_sessions",
    description:
      "List all registered AI sessions (paginated). Use this to discover which other AIs " +
      "are active and get their session_ids for messaging.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Your own session_id. When provided the response includes your _inbox summary." },
        filter:     { type: "string", description: "Optional case-insensitive substring filter applied to session_id, name, and description." },
        page:       { type: "number", description: "Page number (1-based, default 1)." },
        page_size:  { type: "number", description: "Results per page (1–100, default 20)." },
      },
    },
  },
  {
    name: "community_delete_session",
    description:
      "Unregister an AI session from the community. By default also deletes all messages " +
      "to/from the session and removes the session from all rooms. Use when shutting down an AI.",
    inputSchema: {
      type: "object",
      required: ["session_id"],
      properties: {
        session_id:      { type: "string",  description: "The session to remove." },
        purge_messages:  { type: "boolean", description: "Also delete all messages to/from this session (default: true)." },
      },
    },
  },

  // ── 1-to-1 Messaging ──────────────────────────────────────────────────────
  {
    name: "community_send_message",
    description:
      "Send a message from one AI session to another. The recipient's next tool call " +
      "will include an _inbox notification showing unread count. " +
      "Supports optional reply threading (reply_to) and message expiry (ttl_seconds). " +
      "Requires both sessions to be registered.",
    inputSchema: {
      type: "object",
      required: ["from_session", "to_session", "body"],
      properties: {
        from_session: { type: "string", description: "session_id of the sender (must be registered)." },
        to_session:   { type: "string", description: "session_id of the recipient (must be registered)." },
        body:         { type: "string", description: "Message body (≤ 32 KB)." },
        reply_to:     { type: "string", description: "message_id this is a reply to (optional, for threading)." },
        ttl_seconds:  { type: "number", description: "Seconds until this message expires and is hidden from reads (optional)." },
      },
    },
  },
  {
    name: "community_broadcast",
    description:
      "Send a message from one AI session to multiple recipients at once — or to ALL " +
      "registered sessions if to_sessions is omitted. Each recipient receives an individual " +
      "message in their inbox with an _inbox notification on their next tool call. " +
      "Supports optional message expiry (ttl_seconds).",
    inputSchema: {
      type: "object",
      required: ["from_session", "body"],
      properties: {
        from_session: { type: "string", description: "session_id of the sender (must be registered)." },
        to_sessions:  { type: "array", items: { type: "string" }, description: "List of recipient session_ids. Omit to broadcast to ALL registered sessions." },
        body:         { type: "string", description: "Message body (≤ 32 KB)." },
        ttl_seconds:  { type: "number", description: "Seconds until these messages expire (optional)." },
      },
    },
  },
  {
    name: "community_read_messages",
    description:
      "Fetch messages for a session. By default reads the inbox (messages addressed to you) " +
      "and marks them as read. Supports pagination, folder selection (inbox/sent/all), " +
      "and thread filtering (thread_of). Expired messages are automatically excluded.",
    inputSchema: {
      type: "object",
      required: ["session_id"],
      properties: {
        session_id: { type: "string", description: "Your session_id." },
        folder:     { type: "string", description: "'inbox' (default) | 'sent' | 'all'." },
        mark_read:  { type: "boolean", description: "Mark fetched inbox messages as read (default: true)." },
        thread_of:  { type: "string", description: "message_id to read a thread for — returns that message plus all direct replies." },
        page:       { type: "number",  description: "Page number (1-based, default 1)." },
        page_size:  { type: "number",  description: "Results per page (1–100, default 20)." },
      },
    },
  },
  {
    name: "community_message_status",
    description:
      "Check the delivery/read status of a specific message by its message_id. " +
      "Returns whether it has been read, when, and whether it has expired.",
    inputSchema: {
      type: "object",
      required: ["message_id"],
      properties: {
        session_id: { type: "string", description: "Your session_id (optional — for passive inbox injection)." },
        message_id: { type: "string", description: "The message_id returned by community_send_message or community_broadcast." },
      },
    },
  },
  {
    name: "community_inbox_summary",
    description:
      "Get a lightweight unread/total message count for your session. " +
      "Faster than community_read_messages when you only need counts, not content. " +
      "Expired messages are excluded from counts.",
    inputSchema: {
      type: "object",
      required: ["session_id"],
      properties: {
        session_id: { type: "string", description: "Your session_id." },
      },
    },
  },

  // ── Rooms / Channels ──────────────────────────────────────────────────────
  {
    name: "community_create_room",
    description:
      "Create a named room/channel for group AI communication. The creating session " +
      "automatically joins the room. Other AIs join with community_join_room. " +
      "Send group messages with community_room_message.",
    inputSchema: {
      type: "object",
      required: ["session_id", "name"],
      properties: {
        session_id:  { type: "string", description: "Your session_id (creator, must be registered)." },
        room_id:     { type: "string", description: "Custom room identifier (≤ 128 chars). Auto-generated if omitted." },
        name:        { type: "string", description: "Human-readable room name (≤ 64 chars)." },
        description: { type: "string", description: "Purpose/topic of the room (≤ 256 chars)." },
      },
    },
  },
  {
    name: "community_join_room",
    description:
      "Join a room/channel so you can receive and send room messages. " +
      "After joining, messages sent to the room via community_room_message will appear " +
      "in your inbox with the room_id field set.",
    inputSchema: {
      type: "object",
      required: ["session_id", "room_id"],
      properties: {
        session_id: { type: "string", description: "Your session_id (must be registered)." },
        room_id:    { type: "string", description: "The room to join." },
      },
    },
  },
  {
    name: "community_leave_room",
    description:
      "Leave a room/channel. You will no longer receive messages sent to that room.",
    inputSchema: {
      type: "object",
      required: ["session_id", "room_id"],
      properties: {
        session_id: { type: "string", description: "Your session_id." },
        room_id:    { type: "string", description: "The room to leave." },
      },
    },
  },
  {
    name: "community_room_message",
    description:
      "Send a message to all members of a room/channel. Each member (except the sender) " +
      "receives the message in their inbox with room_id set. Supports reply threading " +
      "(reply_to) and message expiry (ttl_seconds). You must be a room member to send.",
    inputSchema: {
      type: "object",
      required: ["from_session", "room_id", "body"],
      properties: {
        from_session: { type: "string", description: "Your session_id (must be a room member)." },
        room_id:      { type: "string", description: "The room to send to." },
        body:         { type: "string", description: "Message body (≤ 32 KB)." },
        reply_to:     { type: "string", description: "message_id this is a reply to (optional, for threading)." },
        ttl_seconds:  { type: "number", description: "Seconds until this message expires (optional)." },
      },
    },
  },
  {
    name: "community_list_rooms",
    description:
      "List all rooms/channels (paginated). Optionally filter by name/description " +
      "or show only rooms you're a member of.",
    inputSchema: {
      type: "object",
      properties: {
        session_id:  { type: "string",  description: "Your session_id (optional — for member_only filter and passive inbox injection)." },
        filter:      { type: "string",  description: "Case-insensitive substring filter on room_id, name, and description." },
        member_only: { type: "boolean", description: "If true (and session_id provided), only return rooms you have joined." },
        page:        { type: "number",  description: "Page number (1-based, default 1)." },
        page_size:   { type: "number",  description: "Results per page (1–100, default 20)." },
      },
    },
  },
  {
    name: "community_room_info",
    description:
      "Get details about a specific room: name, description, creator, creation time, " +
      "member count, and full member list.",
    inputSchema: {
      type: "object",
      required: ["room_id"],
      properties: {
        session_id: { type: "string", description: "Your session_id (optional — for passive inbox injection)." },
        room_id:    { type: "string", description: "The room to inspect." },
      },
    },
  },
  {
    name: "community_delete_room",
    description:
      "Delete a room/channel and optionally purge all room messages. " +
      "Members are not deleted from the community, only removed from the room.",
    inputSchema: {
      type: "object",
      required: ["room_id"],
      properties: {
        session_id:     { type: "string",  description: "Your session_id (optional — for passive inbox injection)." },
        room_id:        { type: "string",  description: "The room to delete." },
        purge_messages: { type: "boolean", description: "Also delete all messages that were sent to this room (default: true)." },
      },
    },
  },

  // ── Global info ────────────────────────────────────────────────────────────
  {
    name: "community_info",
    description:
      "Return global stats for the community store: total sessions, message count, " +
      "room count, overall unread count, and capacity limits.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Your session_id (optional — for passive inbox injection)." },
      },
    },
  },
];

module.exports = { COMMUNITY_SCHEMAS };
