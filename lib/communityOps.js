"use strict";
/**
 * communityOps.js — AI Community: zero-dependency in-memory session/messaging layer
 *
 * Enables AIs to discover each other, exchange messages, track read/unread
 * status, join rooms/channels, broadcast to multiple recipients, and thread
 * replies. Activated via  --category=community  on the CLI.
 *
 * Passive notification contract
 * ──────────────────────────────
 * Every tool call that carries a `session_id` (from any category, not just
 * community tools) goes through  injectInboxSummary(session_id, result)
 * before the result is returned to the caller.  That helper staples an
 * `_inbox` envelope onto the result object:
 *
 *   {
 *     ...originalResult,
 *     _inbox: {
 *       session_id: "...",
 *       unread:     3,
 *       total:      7,
 *       hint:       "You have 3 unread message(s). Use community_read_messages to view them."
 *     }
 *   }
 *
 * This guarantees the AI sees its inbox state on every tool response even if
 * it never explicitly polls for messages.
 *
 * Data model (all in-process Maps — no file I/O, no npm deps)
 * ─────────────────────────────────────────────────────────────
 *   SESSIONS   Map<session_id, SessionRecord>
 *   MESSAGES   Map<message_id, MessageRecord>
 *   ROOMS      Map<room_id, RoomRecord>
 *
 * SessionRecord  { session_id, name, description, created_at, last_seen_at }
 * MessageRecord  { message_id, from_session, to_session, room_id|null,
 *                  body, sent_at, expires_at|null, read_at|null,
 *                  reply_to|null, status: "unread"|"read" }
 * RoomRecord     { room_id, name, description, created_by, created_at,
 *                  members: Set<session_id> }
 *
 * Security / guards
 * ──────────────────
 *   • NUL-byte rejection on all string inputs
 *   • session_id / message_id / room_id must be non-empty strings ≤ 128 chars
 *   • body ≤ 32 KB (byte-length checked)
 *   • name ≤ 64 chars, description ≤ 256 chars
 *   • Max 1 000 sessions, 100 000 messages, 500 rooms
 *   • Pagination: page/page_size on list calls (max page_size 100)
 *   • TTL: messages with expires_at in the past are silently skipped on read
 *   • thread_of reads use "all" folder semantics so both sender and receiver
 *     see the complete thread (root + replies)
 *
 * Bug fixes (v2)
 * ──────────────
 *   • thread_of now applies "all" folder semantics: the session calling
 *     read_messages sees both messages they sent and received within the
 *     thread, not just inbox messages. This fixes the case where the root
 *     message is sent by the caller and the reply arrives from another AI —
 *     the caller now correctly sees total=2 for the thread.
 *   • body guard now checks byte-length (Buffer.byteLength) so multi-byte
 *     UTF-8 cannot silently exceed the 32 KB limit.
 *   • eviction functions now safely handle empty maps (no-op guard).
 *   • communityDeleteSession now also cleans up room membership before
 *     deleting messages, preventing ghost member references.
 *   • communityReadMessages now returns room_id on every message object.
 *   • Broadcast reply_to support: broadcast now accepts optional reply_to.
 *   • communityListRooms: member_only no longer throws if session_id is absent.
 *   • communityRoomMessage: sent_to and message_ids are parallel arrays (guaranteed).
 *   • communityInfo: message_count now reflects only non-expired messages.
 */

// ── In-memory store ───────────────────────────────────────────────────────────

const SESSIONS  = new Map(); // session_id → SessionRecord
const MESSAGES  = new Map(); // message_id → MessageRecord
const ROOMS     = new Map(); // room_id    → RoomRecord

const MAX_SESSIONS      = 1_000;
const MAX_MESSAGES      = 100_000;
const MAX_ROOMS         = 500;
const MAX_BODY_BYTES    = 32 * 1024;      // 32 KB
const MAX_ID_LEN        = 128;
const MAX_NAME_LEN      = 64;
const MAX_DESC_LEN      = 256;
const MAX_PAGE_SIZE     = 100;

// ── Guard helpers ─────────────────────────────────────────────────────────────

function requireString(val, name, maxLen = MAX_ID_LEN) {
  if (typeof val !== "string" || val.trim().length === 0)
    throw new Error(`${name} must be a non-empty string`);
  if (val.includes("\0"))
    throw new Error(`${name} must not contain NUL bytes`);
  if (val.length > maxLen)
    throw new Error(`${name} must be ≤ ${maxLen} characters`);
  return val.trim();
}

function optString(val, name, maxLen = MAX_DESC_LEN) {
  if (val === undefined || val === null) return undefined;
  return requireString(val, name, maxLen);
}

/**
 * Guard for message body — checks byte length so multi-byte UTF-8
 * characters cannot silently push past the 32 KB limit.
 */
function requireBody(val) {
  if (typeof val !== "string" || val.trim().length === 0)
    throw new Error("body must be a non-empty string");
  if (val.includes("\0"))
    throw new Error("body must not contain NUL bytes");
  const byteLen = Buffer.byteLength(val, "utf8");
  if (byteLen > MAX_BODY_BYTES)
    throw new Error(`body must be ≤ ${MAX_BODY_BYTES} bytes (got ${byteLen})`);
  return val;
}

function requireSession(session_id) {
  const id = requireString(session_id, "session_id");
  if (!SESSIONS.has(id))
    throw new Error(`Session '${id}' not found. Register with community_register first.`);
  return id;
}

function requireRoom(room_id) {
  const id = requireString(room_id, "room_id");
  if (!ROOMS.has(id))
    throw new Error(`Room '${id}' not found. Create with community_create_room first.`);
  return id;
}

function nowISO() { return new Date().toISOString(); }

// ── Session status helper ─────────────────────────────────────────────────────

/**
 * Compute a human-readable status label from last_seen_at.
 *
 *   0 – 10 s   → "active"
 *  11 – 59 s   → "20 secs ago"
 *  60 s – …    → "2 min ago — might be dead"
 *  never seen  → "never seen"
 */
function sessionStatus(last_seen_at) {
  if (!last_seen_at) return "never seen";
  const diffMs  = Date.now() - new Date(last_seen_at).getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec <= 10)  return "active";
  if (diffSec < 60)   return `${diffSec} secs ago`;
  const diffMin = Math.floor(diffSec / 60);
  return `${diffMin} min ago — might be dead`;
}

let _msgSeq = 0;
function nextMessageId() { return `msg_${Date.now()}_${++_msgSeq}`; }

let _roomSeq = 0;
function nextRoomId() { return `room_${Date.now()}_${++_roomSeq}`; }

// ── Eviction helpers ──────────────────────────────────────────────────────────

function evictOldestSession() {
  const oldest = SESSIONS.keys().next().value;
  if (oldest !== undefined) SESSIONS.delete(oldest);
}

function evictOldestMessage() {
  // Prefer evicting expired messages first; fall back to oldest
  for (const [id, msg] of MESSAGES.entries()) {
    if (isExpired(msg)) { MESSAGES.delete(id); return; }
  }
  const oldest = MESSAGES.keys().next().value;
  if (oldest !== undefined) MESSAGES.delete(oldest);
}

function evictOldestRoom() {
  const oldest = ROOMS.keys().next().value;
  if (oldest !== undefined) ROOMS.delete(oldest);
}

// ── TTL helper — filter out expired messages ──────────────────────────────────

function isExpired(msg) {
  if (!msg.expires_at) return false;
  return new Date(msg.expires_at).getTime() < Date.now();
}

// ── Inbox summary (injected onto every tool result) ───────────────────────────

/**
 * If session_id is a registered session, attach inbox stats to result.
 * Mutates result in-place and returns it.
 */
function injectInboxSummary(session_id, result) {
  if (!session_id || !SESSIONS.has(session_id)) return result;

  // Update last_seen_at passively
  const sess = SESSIONS.get(session_id);
  sess.last_seen_at = nowISO();

  let unread = 0, total = 0;
  for (const msg of MESSAGES.values()) {
    if (isExpired(msg)) continue;
    if (msg.to_session === session_id) {
      total++;
      if (msg.status === "unread") unread++;
    }
  }

  const inbox = { session_id, unread, total };
  if (unread > 0) {
    inbox.hint = `You have ${unread} unread message(s). Use community_read_messages to view them.`;
  }

  if (result && typeof result === "object" && !Array.isArray(result)) {
    result._inbox = inbox;
  }
  return result;
}

// ── Tool implementations ──────────────────────────────────────────────────────

/**
 * community_register — create or refresh a session
 * Returns: { ok, session_id, name, description, created_at, already_existed }
 */
function communityRegister(args) {
  const session_id  = requireString(args.session_id, "session_id");
  const name        = requireString(args.name || session_id, "name", MAX_NAME_LEN);
  const description = optString(args.description, "description", MAX_DESC_LEN) || "";

  const already_existed = SESSIONS.has(session_id);

  if (!already_existed) {
    if (SESSIONS.size >= MAX_SESSIONS) evictOldestSession();
    SESSIONS.set(session_id, {
      session_id,
      name,
      description,
      created_at:   nowISO(),
      last_seen_at: nowISO(),
    });
  } else {
    const s = SESSIONS.get(session_id);
    s.name        = name;
    s.description = description;
    s.last_seen_at = nowISO();
  }

  const sess = SESSIONS.get(session_id);
  return {
    ok: true,
    session_id:     sess.session_id,
    name:           sess.name,
    description:    sess.description,
    created_at:     sess.created_at,
    already_existed,
  };
}

/**
 * community_list_sessions — paginated directory of active sessions
 * Returns: { ok, total, page, page_size, sessions: [...] }
 */
function communityListSessions(args) {
  const page      = Math.max(1, args.page      || 1);
  const page_size = Math.min(MAX_PAGE_SIZE, Math.max(1, args.page_size || 20));
  const filter    = args.filter ? args.filter.toLowerCase() : null;

  let sessions = [...SESSIONS.values()];
  if (filter) {
    sessions = sessions.filter(s =>
      s.name.toLowerCase().includes(filter) ||
      s.description.toLowerCase().includes(filter) ||
      s.session_id.toLowerCase().includes(filter)
    );
  }

  const total  = sessions.length;
  const offset = (page - 1) * page_size;
  const slice  = sessions.slice(offset, offset + page_size);

  return {
    ok: true,
    total,
    page,
    page_size,
    sessions: slice.map(s => {
      // Count unread messages waiting for this session
      let unread = 0;
      for (const msg of MESSAGES.values()) {
        if (isExpired(msg)) continue;
        if (msg.to_session === s.session_id && msg.status === "unread") unread++;
      }
      return {
        session_id:    s.session_id,
        name:          s.name,
        description:   s.description,
        created_at:    s.created_at,
        last_seen_at:  s.last_seen_at,
        status:        sessionStatus(s.last_seen_at),
        unread_count:  unread,
      };
    }),
  };
}

/**
 * community_send_message — send a message from one session to another
 * Supports optional ttl_seconds and reply_to fields.
 * Returns: { ok, message_id, from_session, to_session, sent_at, expires_at? }
 */
function communitySendMessage(args) {
  const from_session = requireSession(args.from_session);
  const to_session   = requireSession(args.to_session);
  const body         = requireBody(args.body);

  if (from_session === to_session)
    throw new Error("Cannot send a message to yourself");

  // Optional: reply threading
  let reply_to = null;
  if (args.reply_to) {
    reply_to = requireString(args.reply_to, "reply_to");
    if (!MESSAGES.has(reply_to))
      throw new Error(`reply_to message '${reply_to}' not found`);
  }

  // Optional: TTL
  let expires_at = null;
  if (args.ttl_seconds !== undefined && args.ttl_seconds !== null) {
    const ttl = Number(args.ttl_seconds);
    if (!Number.isFinite(ttl) || ttl <= 0)
      throw new Error("ttl_seconds must be a positive number");
    expires_at = new Date(Date.now() + ttl * 1000).toISOString();
  }

  if (MESSAGES.size >= MAX_MESSAGES) evictOldestMessage();

  const message_id = nextMessageId();
  const sent_at    = nowISO();

  MESSAGES.set(message_id, {
    message_id,
    from_session,
    to_session,
    room_id:  null,
    body,
    sent_at,
    expires_at,
    reply_to,
    read_at: null,
    status:  "unread",
  });

  // Update sender's last_seen_at
  SESSIONS.get(from_session).last_seen_at = sent_at;

  const result = { ok: true, message_id, from_session, to_session, sent_at };
  if (expires_at) result.expires_at = expires_at;
  if (reply_to)   result.reply_to   = reply_to;
  return result;
}

/**
 * community_broadcast — send a message from one session to multiple recipients
 * (or to all registered sessions).
 * Supports optional ttl_seconds and reply_to fields.
 * Returns: { ok, from_session, sent_to: [...], message_ids: [...], failed: [...] }
 */
function communityBroadcast(args) {
  const from_session = requireSession(args.from_session);
  const body         = requireBody(args.body);

  // Optional TTL
  let expires_at = null;
  if (args.ttl_seconds !== undefined && args.ttl_seconds !== null) {
    const ttl = Number(args.ttl_seconds);
    if (!Number.isFinite(ttl) || ttl <= 0)
      throw new Error("ttl_seconds must be a positive number");
    expires_at = new Date(Date.now() + ttl * 1000).toISOString();
  }

  // Optional reply threading
  let reply_to = null;
  if (args.reply_to) {
    reply_to = requireString(args.reply_to, "reply_to");
    if (!MESSAGES.has(reply_to))
      throw new Error(`reply_to message '${reply_to}' not found`);
  }

  // Determine recipients
  let targets;
  if (args.to_sessions && Array.isArray(args.to_sessions) && args.to_sessions.length > 0) {
    targets = args.to_sessions;
  } else {
    // broadcast to all except sender
    targets = [...SESSIONS.keys()].filter(id => id !== from_session);
  }

  const sent_to    = [];
  const message_ids = [];
  const failed     = [];
  const sent_at    = nowISO();

  for (const to_session of targets) {
    if (to_session === from_session) continue;
    if (!SESSIONS.has(to_session)) {
      failed.push({ session_id: to_session, reason: "session not found" });
      continue;
    }
    if (MESSAGES.size >= MAX_MESSAGES) evictOldestMessage();
    const message_id = nextMessageId();
    MESSAGES.set(message_id, {
      message_id,
      from_session,
      to_session,
      room_id:    null,
      body,
      sent_at,
      expires_at,
      reply_to,
      read_at:    null,
      status:     "unread",
    });
    sent_to.push(to_session);
    message_ids.push(message_id);
  }

  SESSIONS.get(from_session).last_seen_at = sent_at;

  const result = { ok: true, from_session, sent_to, message_ids, failed };
  if (expires_at) result.expires_at = expires_at;
  return result;
}

/**
 * community_read_messages — fetch messages for a session (inbox or sent)
 *
 * FIX: When thread_of is specified the folder filter is widened to "all" so
 * the calling session sees both messages it sent (the root) and messages it
 * received (replies) within the thread.  Without this fix, a session that
 * sent the root message and then called read_messages with thread_of would
 * only find the reply (inbox) and miss the root (sent), returning total=1
 * instead of the expected total=2.
 *
 * Marks fetched unread messages as read (unless mark_read=false).
 * Expired messages are excluded.
 * Returns: { ok, session_id, folder, total, unread_before, unread_after,
 *             read_now, page, page_size, messages: [...] }
 */
function communityReadMessages(args) {
  const session_id = requireSession(args.session_id);
  const folder     = (args.folder || "inbox").toLowerCase();
  if (!["inbox", "sent", "all"].includes(folder))
    throw new Error("folder must be 'inbox', 'sent', or 'all'");

  const page      = Math.max(1, args.page      || 1);
  const page_size = Math.min(MAX_PAGE_SIZE, Math.max(1, args.page_size || 20));
  const mark_read = args.mark_read !== false; // default true
  const thread_of = args.thread_of ? requireString(args.thread_of, "thread_of") : null;

  let msgs = [...MESSAGES.values()].filter(m => !isExpired(m));

  // When reading a thread, always widen to "all" so both sender (root) and
  // receiver (replies) are visible to the session that initiated the thread.
  const effectiveFolder = thread_of ? "all" : folder;

  if (effectiveFolder === "inbox") {
    msgs = msgs.filter(m => m.to_session   === session_id);
  } else if (effectiveFolder === "sent") {
    msgs = msgs.filter(m => m.from_session === session_id);
  } else {
    // "all" — messages involving this session in either direction
    msgs = msgs.filter(m => m.to_session === session_id || m.from_session === session_id);
  }

  // Filter by thread if requested
  if (thread_of) {
    msgs = msgs.filter(m => m.reply_to === thread_of || m.message_id === thread_of);
  }

  // Sort by sent_at ascending
  msgs.sort((a, b) => a.sent_at.localeCompare(b.sent_at));

  const total         = msgs.length;
  const unread_before = msgs.filter(m => m.to_session === session_id && m.status === "unread").length;

  const offset = (page - 1) * page_size;
  const slice  = msgs.slice(offset, offset + page_size);

  let read_now = 0;
  if (mark_read) {
    for (const msg of slice) {
      if (msg.to_session === session_id && msg.status === "unread") {
        msg.status  = "read";
        msg.read_at = nowISO();
        read_now++;
      }
    }
  }

  const unread_after = msgs.filter(m => m.to_session === session_id && m.status === "unread").length;

  SESSIONS.get(session_id).last_seen_at = nowISO();

  return {
    ok: true,
    session_id,
    folder,           // report the folder the caller asked for
    total,
    unread_before,
    unread_after,
    read_now,
    page,
    page_size,
    messages: slice.map(m => ({
      message_id:   m.message_id,
      from_session: m.from_session,
      to_session:   m.to_session,
      room_id:      m.room_id,
      body:         m.body,
      sent_at:      m.sent_at,
      expires_at:   m.expires_at,
      reply_to:     m.reply_to,
      read_at:      m.read_at,
      status:       m.status,
    })),
  };
}

/**
 * community_message_status — check status of a specific message
 * Returns: { ok, message_id, from_session, to_session, room_id, status,
 *             sent_at, read_at, expires_at, reply_to, expired }
 */
function communityMessageStatus(args) {
  const message_id = requireString(args.message_id, "message_id");
  if (!MESSAGES.has(message_id))
    throw new Error(`Message '${message_id}' not found`);
  const m = MESSAGES.get(message_id);
  return {
    ok:           true,
    message_id:   m.message_id,
    from_session: m.from_session,
    to_session:   m.to_session,
    room_id:      m.room_id,
    status:       m.status,
    sent_at:      m.sent_at,
    expires_at:   m.expires_at,
    reply_to:     m.reply_to,
    read_at:      m.read_at,
    expired:      isExpired(m),
  };
}

/**
 * community_inbox_summary — lightweight unread/total count for a session
 * Returns: { ok, session_id, unread, total, hint? }
 */
function communityInboxSummary(args) {
  const session_id = requireSession(args.session_id);
  let unread = 0, total = 0;
  for (const msg of MESSAGES.values()) {
    if (isExpired(msg)) continue;
    if (msg.to_session === session_id) {
      total++;
      if (msg.status === "unread") unread++;
    }
  }
  const result = { ok: true, session_id, unread, total };
  if (unread > 0) {
    result.hint = `You have ${unread} unread message(s). Use community_read_messages to view them.`;
  }
  return result;
}

/**
 * community_delete_session — unregister a session and optionally its messages
 * Cleans up room membership before purging messages to prevent ghost members.
 * Returns: { ok, session_id, messages_deleted }
 */
function communityDeleteSession(args) {
  const session_id     = requireSession(args.session_id);
  const purge_messages = args.purge_messages !== false; // default true

  // Remove from all rooms first (prevents ghost member references)
  for (const room of ROOMS.values()) {
    room.members.delete(session_id);
  }

  SESSIONS.delete(session_id);

  let messages_deleted = 0;
  if (purge_messages) {
    for (const [id, msg] of MESSAGES.entries()) {
      if (msg.from_session === session_id || msg.to_session === session_id) {
        MESSAGES.delete(id);
        messages_deleted++;
      }
    }
  }

  return { ok: true, session_id, messages_deleted };
}

/**
 * community_info — meta info about the community store
 * Returns: { ok, session_count, message_count, unread_total, room_count, limits: {...} }
 *
 * message_count now counts only non-expired messages so it matches what
 * callers actually see when they call read_messages.
 */
function communityInfo(_args) {
  let unread_total   = 0;
  let message_count  = 0;
  for (const msg of MESSAGES.values()) {
    if (isExpired(msg)) continue;
    message_count++;
    if (msg.status === "unread") unread_total++;
  }
  return {
    ok:            true,
    session_count: SESSIONS.size,
    message_count,
    room_count:    ROOMS.size,
    unread_total,
    limits: {
      max_sessions:   MAX_SESSIONS,
      max_messages:   MAX_MESSAGES,
      max_rooms:      MAX_ROOMS,
      max_body_bytes: MAX_BODY_BYTES,
      max_page_size:  MAX_PAGE_SIZE,
    },
  };
}

// ── Room tools ────────────────────────────────────────────────────────────────

/**
 * community_create_room — create a named room/channel
 * Returns: { ok, room_id, name, description, created_by, created_at }
 */
function communityCreateRoom(args) {
  const created_by  = requireSession(args.session_id);
  const name        = requireString(args.name, "name", MAX_NAME_LEN);
  const description = optString(args.description, "description", MAX_DESC_LEN) || "";
  // Allow caller-supplied room_id or auto-generate
  let room_id;
  if (args.room_id) {
    room_id = requireString(args.room_id, "room_id");
    if (ROOMS.has(room_id))
      throw new Error(`Room '${room_id}' already exists`);
  } else {
    room_id = nextRoomId();
  }

  if (ROOMS.size >= MAX_ROOMS) evictOldestRoom();

  const created_at = nowISO();
  ROOMS.set(room_id, {
    room_id,
    name,
    description,
    created_by,
    created_at,
    members: new Set([created_by]), // creator auto-joins
  });

  return { ok: true, room_id, name, description, created_by, created_at };
}

/**
 * community_join_room — add a session to a room
 * Idempotent: joining an already-joined room is a no-op (uses Set).
 * Returns: { ok, room_id, session_id, member_count }
 */
function communityJoinRoom(args) {
  const session_id = requireSession(args.session_id);
  const room_id    = requireRoom(args.room_id);
  const room       = ROOMS.get(room_id);
  room.members.add(session_id);
  return { ok: true, room_id, session_id, member_count: room.members.size };
}

/**
 * community_leave_room — remove a session from a room
 * Returns: { ok, room_id, session_id, member_count }
 */
function communityLeaveRoom(args) {
  const session_id = requireSession(args.session_id);
  const room_id    = requireRoom(args.room_id);
  const room       = ROOMS.get(room_id);
  if (!room.members.has(session_id))
    throw new Error(`Session '${session_id}' is not a member of room '${room_id}'`);
  room.members.delete(session_id);
  return { ok: true, room_id, session_id, member_count: room.members.size };
}

/**
 * community_room_message — send a message to all members of a room
 * sent_to and message_ids are parallel arrays (index N in sent_to corresponds
 * to index N in message_ids).
 * Returns: { ok, room_id, from_session, sent_to: [...], message_ids: [...] }
 */
function communityRoomMessage(args) {
  const from_session = requireSession(args.from_session);
  const room_id      = requireRoom(args.room_id);
  const body         = requireBody(args.body);
  const room         = ROOMS.get(room_id);

  if (!room.members.has(from_session))
    throw new Error(`Session '${from_session}' is not a member of room '${room_id}'. Join first.`);

  // Optional TTL
  let expires_at = null;
  if (args.ttl_seconds !== undefined && args.ttl_seconds !== null) {
    const ttl = Number(args.ttl_seconds);
    if (!Number.isFinite(ttl) || ttl <= 0)
      throw new Error("ttl_seconds must be a positive number");
    expires_at = new Date(Date.now() + ttl * 1000).toISOString();
  }

  // Optional reply threading
  let reply_to = null;
  if (args.reply_to) {
    reply_to = requireString(args.reply_to, "reply_to");
    if (!MESSAGES.has(reply_to))
      throw new Error(`reply_to message '${reply_to}' not found`);
  }

  const sent_at     = nowISO();
  const sent_to     = [];
  const message_ids = [];

  for (const to_session of room.members) {
    if (to_session === from_session) continue;
    if (MESSAGES.size >= MAX_MESSAGES) evictOldestMessage();
    const message_id = nextMessageId();
    MESSAGES.set(message_id, {
      message_id,
      from_session,
      to_session,
      room_id,
      body,
      sent_at,
      expires_at,
      reply_to,
      read_at:  null,
      status:   "unread",
    });
    sent_to.push(to_session);
    message_ids.push(message_id);
  }

  SESSIONS.get(from_session).last_seen_at = sent_at;

  const result = { ok: true, room_id, from_session, sent_to, message_ids };
  if (expires_at) result.expires_at = expires_at;
  return result;
}

/**
 * community_list_rooms — list all rooms (paginated)
 * member_only: if true and session_id is provided, only return rooms the
 * session has joined. If session_id is absent, member_only is silently ignored.
 * Returns: { ok, total, page, page_size, rooms: [...] }
 */
function communityListRooms(args) {
  const page      = Math.max(1, args.page      || 1);
  const page_size = Math.min(MAX_PAGE_SIZE, Math.max(1, args.page_size || 20));
  const filter    = args.filter ? args.filter.toLowerCase() : null;

  let rooms = [...ROOMS.values()];
  if (filter) {
    rooms = rooms.filter(r =>
      r.name.toLowerCase().includes(filter) ||
      r.description.toLowerCase().includes(filter) ||
      r.room_id.toLowerCase().includes(filter)
    );
  }

  // Filter to rooms the caller is in (optional)
  if (args.member_only && args.session_id) {
    const sid = requireSession(args.session_id);
    rooms = rooms.filter(r => r.members.has(sid));
  }

  const total  = rooms.length;
  const offset = (page - 1) * page_size;
  const slice  = rooms.slice(offset, offset + page_size);

  return {
    ok: true,
    total,
    page,
    page_size,
    rooms: slice.map(r => ({
      room_id:      r.room_id,
      name:         r.name,
      description:  r.description,
      created_by:   r.created_by,
      created_at:   r.created_at,
      member_count: r.members.size,
    })),
  };
}

/**
 * community_room_info — details about a specific room
 * Returns: { ok, room_id, name, description, created_by, created_at,
 *             member_count, members: [...] }
 */
function communityRoomInfo(args) {
  const room_id = requireRoom(args.room_id);
  const room    = ROOMS.get(room_id);
  return {
    ok:           true,
    room_id:      room.room_id,
    name:         room.name,
    description:  room.description,
    created_by:   room.created_by,
    created_at:   room.created_at,
    member_count: room.members.size,
    members:      [...room.members],
  };
}

/**
 * community_delete_room — remove a room and optionally its room messages
 * Returns: { ok, room_id, messages_deleted }
 */
function communityDeleteRoom(args) {
  const room_id        = requireRoom(args.room_id);
  const purge_messages = args.purge_messages !== false;

  ROOMS.delete(room_id);

  let messages_deleted = 0;
  if (purge_messages) {
    for (const [id, msg] of MESSAGES.entries()) {
      if (msg.room_id === room_id) {
        MESSAGES.delete(id);
        messages_deleted++;
      }
    }
  }

  return { ok: true, room_id, messages_deleted };
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
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
  injectInboxSummary,
  // Expose stores for testing
  _SESSIONS: SESSIONS,
  _MESSAGES: MESSAGES,
  _ROOMS:    ROOMS,
};
