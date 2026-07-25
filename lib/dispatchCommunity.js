"use strict";
// ── COMMUNITY TOOL DISPATCH HANDLERS ─────────────────────────────────────────
// Thin adapter layer: validates/extracts args, calls communityOps.js,
// and returns the result (which already has _inbox stapled on by callers
// in executeTool.js via injectInboxSummary).

const {
  communityRegister,
  communityListSessions,
  communitySendMessage,
  communityBroadcast,
  communityReadMessages,
  communityMessageStatus,
  communityInboxSummary,
  communityDeleteSession,
  communityInfo,
  communityCreateRoom,
  communityJoinRoom,
  communityLeaveRoom,
  communityRoomMessage,
  communityListRooms,
  communityRoomInfo,
  communityDeleteRoom,
} = require("./communityOps");

const COMMUNITY_DISPATCH = {

  community_register(args) {
    return communityRegister(args);
  },

  community_list_sessions(args) {
    return communityListSessions(args);
  },

  community_send_message(args) {
    return communitySendMessage(args);
  },

  community_broadcast(args) {
    return communityBroadcast(args);
  },

  community_read_messages(args) {
    return communityReadMessages(args);
  },

  community_message_status(args) {
    return communityMessageStatus(args);
  },

  community_inbox_summary(args) {
    return communityInboxSummary(args);
  },

  community_delete_session(args) {
    return communityDeleteSession(args);
  },

  community_info(args) {
    return communityInfo(args);
  },

  community_create_room(args) {
    return communityCreateRoom(args);
  },

  community_join_room(args) {
    return communityJoinRoom(args);
  },

  community_leave_room(args) {
    return communityLeaveRoom(args);
  },

  community_room_message(args) {
    return communityRoomMessage(args);
  },

  community_list_rooms(args) {
    return communityListRooms(args);
  },

  community_room_info(args) {
    return communityRoomInfo(args);
  },

  community_delete_room(args) {
    return communityDeleteRoom(args);
  },

};

module.exports = { COMMUNITY_DISPATCH };
