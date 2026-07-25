"use strict";
/**
 * Section 294 — community extended tools tests
 *
 * A: community_broadcast              (16 tests)
 * B: community_send_message threading (12 tests)
 * C: community_send_message TTL       (10 tests)
 * D: community_create_room            (14 tests)
 * E: community_join_room              (10 tests)
 * F: community_leave_room             (10 tests)
 * G: community_room_message           (16 tests)
 * H: community_list_rooms             (12 tests)
 * I: community_room_info              (10 tests)
 * J: community_delete_room            (10 tests)
 * K: community_message_status (extended fields) (8 tests)
 * L: community_read_messages (thread_of)        (10 tests)
 * M: community_info (room_count)               (6 tests)
 * N: integration / stress                      (10 tests)
 *
 * Total: 154
 */

const assert = require("assert");
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
  injectInboxSummary,
  _SESSIONS,
  _MESSAGES,
  _ROOMS,
} = require("../../lib/communityOps");

// ── Test runner ───────────────────────────────────────────────────────────────
let passed = 0, failed = 0, total = 0;
function test(name, fn) {
  total++;
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      return r
        .then(() => { passed++; process.stderr.write(`  ✓ ${name}\n`); })
        .catch(err => { failed++; process.stderr.write(`  ✗ ${name}: ${err.message}\n`); });
    }
    passed++;
    process.stderr.write(`  ✓ ${name}\n`);
    return Promise.resolve();
  } catch (err) {
    failed++;
    process.stderr.write(`  ✗ ${name}: ${err.message}\n`);
    return Promise.resolve();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function reset() {
  _SESSIONS.clear();
  _MESSAGES.clear();
  _ROOMS.clear();
}

function reg(id, name) {
  return communityRegister({ session_id: id, name: name || id });
}

// ── A: community_broadcast ────────────────────────────────────────────────────
process.stderr.write("\nA: community_broadcast\n");
reset();

test("A01 broadcast returns ok:true", () => {
  reset();
  reg("a1"); reg("a2");
  const r = communityBroadcast({ from_session: "a1", body: "hello all" });
  assert.strictEqual(r.ok, true);
});

test("A02 broadcast to all: sent_to excludes sender", () => {
  reset();
  reg("a1"); reg("a2"); reg("a3");
  const r = communityBroadcast({ from_session: "a1", body: "hi" });
  assert.ok(!r.sent_to.includes("a1"));
  assert.ok(r.sent_to.includes("a2"));
  assert.ok(r.sent_to.includes("a3"));
});

test("A03 broadcast to all: message_ids has one per recipient", () => {
  reset();
  reg("a1"); reg("a2"); reg("a3");
  const r = communityBroadcast({ from_session: "a1", body: "hi" });
  assert.strictEqual(r.message_ids.length, 2);
  assert.strictEqual(r.sent_to.length, 2);
});

test("A04 broadcast to specific sessions", () => {
  reset();
  reg("a1"); reg("a2"); reg("a3"); reg("a4");
  const r = communityBroadcast({ from_session: "a1", to_sessions: ["a2", "a3"], body: "targeted" });
  assert.strictEqual(r.sent_to.length, 2);
  assert.ok(r.sent_to.includes("a2"));
  assert.ok(r.sent_to.includes("a3"));
  assert.ok(!r.sent_to.includes("a4"));
});

test("A05 broadcast: recipients see message in inbox", () => {
  reset();
  reg("a1"); reg("a2");
  communityBroadcast({ from_session: "a1", body: "broadcast body" });
  const r = communityReadMessages({ session_id: "a2", mark_read: false });
  assert.strictEqual(r.total, 1);
  assert.strictEqual(r.messages[0].body, "broadcast body");
});

test("A06 broadcast: unknown to_session goes to failed array", () => {
  reset();
  reg("a1"); reg("a2");
  const r = communityBroadcast({ from_session: "a1", to_sessions: ["a2", "ghost"], body: "hi" });
  assert.strictEqual(r.sent_to.length, 1);
  assert.strictEqual(r.failed.length, 1);
  assert.strictEqual(r.failed[0].session_id, "ghost");
});

test("A07 broadcast: from_session unknown throws", () => {
  reset();
  assert.throws(() => communityBroadcast({ from_session: "ghost", body: "x" }), /not found/);
});

test("A08 broadcast: missing body throws", () => {
  reset();
  reg("a1");
  assert.throws(() => communityBroadcast({ from_session: "a1" }), /non-empty/);
});

test("A09 broadcast: each recipient gets unique message_id", () => {
  reset();
  reg("a1"); reg("a2"); reg("a3");
  const r = communityBroadcast({ from_session: "a1", body: "ids" });
  assert.strictEqual(new Set(r.message_ids).size, r.message_ids.length);
});

test("A10 broadcast: messages stored as unread", () => {
  reset();
  reg("a1"); reg("a2");
  const r = communityBroadcast({ from_session: "a1", body: "unread?" });
  const msg = _MESSAGES.get(r.message_ids[0]);
  assert.strictEqual(msg.status, "unread");
});

test("A11 broadcast with ttl_seconds sets expires_at", () => {
  reset();
  reg("a1"); reg("a2");
  const r = communityBroadcast({ from_session: "a1", body: "ttl test", ttl_seconds: 3600 });
  assert.ok(r.expires_at);
  const msg = _MESSAGES.get(r.message_ids[0]);
  assert.ok(msg.expires_at);
});

test("A12 broadcast with no other sessions: empty sent_to", () => {
  reset();
  reg("a1");
  const r = communityBroadcast({ from_session: "a1", body: "alone" });
  assert.strictEqual(r.sent_to.length, 0);
  assert.strictEqual(r.message_ids.length, 0);
});

test("A13 broadcast: sender inbox not incremented", () => {
  reset();
  reg("a1"); reg("a2");
  communityBroadcast({ from_session: "a1", body: "hi" });
  const r = communityInboxSummary({ session_id: "a1" });
  assert.strictEqual(r.unread, 0);
});

test("A14 broadcast: inbox summary reflects broadcast messages", () => {
  reset();
  reg("a1"); reg("a2"); reg("a3");
  communityBroadcast({ from_session: "a1", body: "check" });
  const r2 = communityInboxSummary({ session_id: "a2" });
  const r3 = communityInboxSummary({ session_id: "a3" });
  assert.strictEqual(r2.unread, 1);
  assert.strictEqual(r3.unread, 1);
});

test("A15 broadcast negative ttl_seconds throws", () => {
  reset();
  reg("a1");
  assert.throws(() => communityBroadcast({ from_session: "a1", body: "x", ttl_seconds: -1 }), /positive/);
});

test("A16 broadcast: from_session last_seen_at updated", () => {
  reset();
  reg("a1"); reg("a2");
  const before = _SESSIONS.get("a1").last_seen_at;
  const start = Date.now();
  while (Date.now() === start) {}
  communityBroadcast({ from_session: "a1", body: "timing" });
  const after = _SESSIONS.get("a1").last_seen_at;
  assert.ok(after >= before);
});

// ── B: threading via reply_to ─────────────────────────────────────────────────
process.stderr.write("\nB: community_send_message threading\n");
reset();

test("B01 send with reply_to stores reply_to field", () => {
  reset();
  reg("b1"); reg("b2");
  const orig = communitySendMessage({ from_session: "b1", to_session: "b2", body: "original" });
  const reply = communitySendMessage({ from_session: "b2", to_session: "b1", body: "reply", reply_to: orig.message_id });
  assert.ok(reply.reply_to === orig.message_id);
});

test("B02 send with reply_to: stored in MESSAGES", () => {
  reset();
  reg("b1"); reg("b2");
  const orig = communitySendMessage({ from_session: "b1", to_session: "b2", body: "original" });
  const reply = communitySendMessage({ from_session: "b2", to_session: "b1", body: "reply", reply_to: orig.message_id });
  const stored = _MESSAGES.get(reply.message_id);
  assert.strictEqual(stored.reply_to, orig.message_id);
});

test("B03 send with unknown reply_to throws", () => {
  reset();
  reg("b1"); reg("b2");
  assert.throws(() => communitySendMessage({ from_session: "b1", to_session: "b2", body: "reply", reply_to: "msg_nope" }), /not found/);
});

test("B04 reply_to returned in message_status", () => {
  reset();
  reg("b1"); reg("b2");
  const orig  = communitySendMessage({ from_session: "b1", to_session: "b2", body: "o" });
  const reply = communitySendMessage({ from_session: "b2", to_session: "b1", body: "r", reply_to: orig.message_id });
  const status = communityMessageStatus({ message_id: reply.message_id });
  assert.strictEqual(status.reply_to, orig.message_id);
});

test("B05 reply_to returned in read_messages", () => {
  reset();
  reg("b1"); reg("b2");
  const orig  = communitySendMessage({ from_session: "b1", to_session: "b2", body: "o" });
  communitySendMessage({ from_session: "b2", to_session: "b1", body: "r", reply_to: orig.message_id });
  const r = communityReadMessages({ session_id: "b1", mark_read: false });
  assert.strictEqual(r.messages[0].reply_to, orig.message_id);
});

test("B06 message without reply_to has null reply_to", () => {
  reset();
  reg("b1"); reg("b2");
  const m = communitySendMessage({ from_session: "b1", to_session: "b2", body: "o" });
  assert.strictEqual(m.reply_to, undefined); // not returned when null
  const stored = _MESSAGES.get(m.message_id);
  assert.strictEqual(stored.reply_to, null);
});

test("B07 thread: multiple replies to same original", () => {
  reset();
  reg("b1"); reg("b2"); reg("b3");
  const orig = communitySendMessage({ from_session: "b1", to_session: "b2", body: "question" });
  communitySendMessage({ from_session: "b2", to_session: "b1", body: "answer1", reply_to: orig.message_id });
  communitySendMessage({ from_session: "b2", to_session: "b1", body: "answer2", reply_to: orig.message_id });
  const r = communityReadMessages({ session_id: "b1", mark_read: false });
  const replies = r.messages.filter(m => m.reply_to === orig.message_id);
  assert.strictEqual(replies.length, 2);
});

test("B08 NUL byte in reply_to throws", () => {
  reset();
  reg("b1"); reg("b2");
  assert.throws(() => communitySendMessage({ from_session: "b1", to_session: "b2", body: "r", reply_to: "msg\0bad" }), /NUL/);
});

test("B09 reply chain depth: reply to a reply", () => {
  reset();
  reg("b1"); reg("b2");
  const m1 = communitySendMessage({ from_session: "b1", to_session: "b2", body: "root" });
  const m2 = communitySendMessage({ from_session: "b2", to_session: "b1", body: "child", reply_to: m1.message_id });
  const m3 = communitySendMessage({ from_session: "b1", to_session: "b2", body: "grandchild", reply_to: m2.message_id });
  const stored = _MESSAGES.get(m3.message_id);
  assert.strictEqual(stored.reply_to, m2.message_id);
});

test("B10 reply_to included in broadcast-sent message_status", () => {
  // broadcast messages currently don't support reply_to (it's a 1-to-1 concept)
  // verify that broadcast message has null reply_to
  reset();
  reg("b1"); reg("b2");
  const br = communityBroadcast({ from_session: "b1", body: "no reply" });
  const status = communityMessageStatus({ message_id: br.message_ids[0] });
  assert.strictEqual(status.reply_to, null);
});

test("B11 reply_to response field absent when null (send)", () => {
  reset();
  reg("b1"); reg("b2");
  const r = communitySendMessage({ from_session: "b1", to_session: "b2", body: "x" });
  assert.ok(!("reply_to" in r));
});

test("B12 reply_to response field present when set (send)", () => {
  reset();
  reg("b1"); reg("b2");
  const orig  = communitySendMessage({ from_session: "b1", to_session: "b2", body: "orig" });
  const reply = communitySendMessage({ from_session: "b2", to_session: "b1", body: "rep", reply_to: orig.message_id });
  assert.ok("reply_to" in reply);
});

// ── C: TTL / message expiry ───────────────────────────────────────────────────
process.stderr.write("\nC: community_send_message TTL\n");
reset();

test("C01 send with ttl_seconds sets expires_at", () => {
  reset();
  reg("c1"); reg("c2");
  const r = communitySendMessage({ from_session: "c1", to_session: "c2", body: "ttl", ttl_seconds: 3600 });
  assert.ok(r.expires_at);
});

test("C02 send without ttl: no expires_at in response", () => {
  reset();
  reg("c1"); reg("c2");
  const r = communitySendMessage({ from_session: "c1", to_session: "c2", body: "notty" });
  assert.ok(!r.expires_at);
});

test("C03 expires_at in future: message visible", () => {
  reset();
  reg("c1"); reg("c2");
  communitySendMessage({ from_session: "c1", to_session: "c2", body: "future", ttl_seconds: 3600 });
  const r = communityReadMessages({ session_id: "c2", mark_read: false });
  assert.strictEqual(r.total, 1);
});

test("C04 expires_at in past: message excluded from reads", () => {
  reset();
  reg("c1"); reg("c2");
  // Manually insert an already-expired message
  const message_id = "msg_expired_test";
  _MESSAGES.set(message_id, {
    message_id, from_session: "c1", to_session: "c2", room_id: null,
    body: "expired", sent_at: new Date().toISOString(),
    expires_at: new Date(Date.now() - 1000).toISOString(), // 1 second ago
    reply_to: null, read_at: null, status: "unread",
  });
  const r = communityReadMessages({ session_id: "c2", mark_read: false });
  assert.strictEqual(r.total, 0);
});

test("C05 expired message excluded from inbox_summary count", () => {
  reset();
  reg("c1"); reg("c2");
  _MESSAGES.set("msg_exp2", {
    message_id: "msg_exp2", from_session: "c1", to_session: "c2", room_id: null,
    body: "gone", sent_at: new Date().toISOString(),
    expires_at: new Date(Date.now() - 5000).toISOString(),
    reply_to: null, read_at: null, status: "unread",
  });
  const r = communityInboxSummary({ session_id: "c2" });
  assert.strictEqual(r.unread, 0);
  assert.strictEqual(r.total, 0);
});

test("C06 expired message excluded from _inbox injection", () => {
  reset();
  reg("c1"); reg("c2");
  _MESSAGES.set("msg_exp3", {
    message_id: "msg_exp3", from_session: "c1", to_session: "c2", room_id: null,
    body: "gone", sent_at: new Date().toISOString(),
    expires_at: new Date(Date.now() - 1000).toISOString(),
    reply_to: null, read_at: null, status: "unread",
  });
  const result = injectInboxSummary("c2", {});
  assert.strictEqual(result._inbox.unread, 0);
});

test("C07 negative ttl_seconds throws", () => {
  reset();
  reg("c1"); reg("c2");
  assert.throws(() => communitySendMessage({ from_session: "c1", to_session: "c2", body: "x", ttl_seconds: 0 }), /positive/);
});

test("C08 message_status shows expired=true for expired message", () => {
  reset();
  reg("c1"); reg("c2");
  _MESSAGES.set("msg_exp4", {
    message_id: "msg_exp4", from_session: "c1", to_session: "c2", room_id: null,
    body: "old", sent_at: new Date().toISOString(),
    expires_at: new Date(Date.now() - 1000).toISOString(),
    reply_to: null, read_at: null, status: "unread",
  });
  const r = communityMessageStatus({ message_id: "msg_exp4" });
  assert.strictEqual(r.expired, true);
});

test("C09 message_status shows expired=false for valid message", () => {
  reset();
  reg("c1"); reg("c2");
  const { message_id } = communitySendMessage({ from_session: "c1", to_session: "c2", body: "x", ttl_seconds: 3600 });
  const r = communityMessageStatus({ message_id });
  assert.strictEqual(r.expired, false);
});

test("C10 non-numeric ttl_seconds throws", () => {
  reset();
  reg("c1"); reg("c2");
  assert.throws(() => communitySendMessage({ from_session: "c1", to_session: "c2", body: "x", ttl_seconds: "soon" }), /positive/);
});

// ── D: community_create_room ──────────────────────────────────────────────────
process.stderr.write("\nD: community_create_room\n");
reset();

test("D01 create_room returns ok:true", () => {
  reset();
  reg("d1");
  const r = communityCreateRoom({ session_id: "d1", name: "Test Room" });
  assert.strictEqual(r.ok, true);
});

test("D02 create_room returns room_id", () => {
  reset();
  reg("d1");
  const r = communityCreateRoom({ session_id: "d1", name: "Room A" });
  assert.ok(typeof r.room_id === "string" && r.room_id.length > 0);
});

test("D03 create_room with custom room_id", () => {
  reset();
  reg("d1");
  const r = communityCreateRoom({ session_id: "d1", name: "Room B", room_id: "my-room" });
  assert.strictEqual(r.room_id, "my-room");
});

test("D04 create_room: duplicate room_id throws", () => {
  reset();
  reg("d1");
  communityCreateRoom({ session_id: "d1", name: "R1", room_id: "dup" });
  assert.throws(() => communityCreateRoom({ session_id: "d1", name: "R2", room_id: "dup" }), /already exists/);
});

test("D05 create_room: creator auto-joins", () => {
  reset();
  reg("d1");
  const r = communityCreateRoom({ session_id: "d1", name: "AutoJoin" });
  const info = communityRoomInfo({ room_id: r.room_id });
  assert.ok(info.members.includes("d1"));
});

test("D06 create_room returns created_by", () => {
  reset();
  reg("d1");
  const r = communityCreateRoom({ session_id: "d1", name: "Creator" });
  assert.strictEqual(r.created_by, "d1");
});

test("D07 create_room returns created_at", () => {
  reset();
  reg("d1");
  const r = communityCreateRoom({ session_id: "d1", name: "Ts" });
  assert.ok(r.created_at && r.created_at.includes("T"));
});

test("D08 create_room sets description", () => {
  reset();
  reg("d1");
  const r = communityCreateRoom({ session_id: "d1", name: "Desc Room", description: "for testing" });
  assert.strictEqual(r.description, "for testing");
});

test("D09 create_room: unknown session_id throws", () => {
  reset();
  assert.throws(() => communityCreateRoom({ session_id: "ghost", name: "R" }), /not found/);
});

test("D10 create_room: missing name throws", () => {
  reset();
  reg("d1");
  assert.throws(() => communityCreateRoom({ session_id: "d1" }), /non-empty/);
});

test("D11 create_room: name > 64 chars throws", () => {
  reset();
  reg("d1");
  assert.throws(() => communityCreateRoom({ session_id: "d1", name: "n".repeat(65) }), /≤ 64/);
});

test("D12 create_room: description > 256 chars throws", () => {
  reset();
  reg("d1");
  assert.throws(() => communityCreateRoom({ session_id: "d1", name: "R", description: "d".repeat(257) }), /≤ 256/);
});

test("D13 create_room: NUL in name throws", () => {
  reset();
  reg("d1");
  assert.throws(() => communityCreateRoom({ session_id: "d1", name: "ab\0cd" }), /NUL/);
});

test("D14 create_room: stored in _ROOMS", () => {
  reset();
  reg("d1");
  const { room_id } = communityCreateRoom({ session_id: "d1", name: "Store" });
  assert.ok(_ROOMS.has(room_id));
});

// ── E: community_join_room ────────────────────────────────────────────────────
process.stderr.write("\nE: community_join_room\n");
reset();

test("E01 join_room returns ok:true", () => {
  reset();
  reg("e1"); reg("e2");
  const { room_id } = communityCreateRoom({ session_id: "e1", name: "Join Me" });
  const r = communityJoinRoom({ session_id: "e2", room_id });
  assert.strictEqual(r.ok, true);
});

test("E02 join_room returns member_count", () => {
  reset();
  reg("e1"); reg("e2");
  const { room_id } = communityCreateRoom({ session_id: "e1", name: "MC" });
  const r = communityJoinRoom({ session_id: "e2", room_id });
  assert.strictEqual(r.member_count, 2);
});

test("E03 join_room: member appears in room_info.members", () => {
  reset();
  reg("e1"); reg("e2");
  const { room_id } = communityCreateRoom({ session_id: "e1", name: "Vis" });
  communityJoinRoom({ session_id: "e2", room_id });
  const info = communityRoomInfo({ room_id });
  assert.ok(info.members.includes("e2"));
});

test("E04 join_room: joining twice is idempotent (Set)", () => {
  reset();
  reg("e1"); reg("e2");
  const { room_id } = communityCreateRoom({ session_id: "e1", name: "Idem" });
  communityJoinRoom({ session_id: "e2", room_id });
  communityJoinRoom({ session_id: "e2", room_id });
  const info = communityRoomInfo({ room_id });
  assert.strictEqual(info.member_count, 2);
});

test("E05 join_room: unknown session_id throws", () => {
  reset();
  reg("e1");
  const { room_id } = communityCreateRoom({ session_id: "e1", name: "R" });
  assert.throws(() => communityJoinRoom({ session_id: "ghost", room_id }), /not found/);
});

test("E06 join_room: unknown room_id throws", () => {
  reset();
  reg("e1");
  assert.throws(() => communityJoinRoom({ session_id: "e1", room_id: "no-room" }), /not found/);
});

test("E07 join_room: NUL in room_id throws", () => {
  reset();
  reg("e1");
  assert.throws(() => communityJoinRoom({ session_id: "e1", room_id: "ab\0cd" }), /NUL/);
});

test("E08 join_room: multiple AIs join", () => {
  reset();
  ["e1","e2","e3","e4","e5"].forEach(id => reg(id));
  const { room_id } = communityCreateRoom({ session_id: "e1", name: "Multi" });
  ["e2","e3","e4","e5"].forEach(id => communityJoinRoom({ session_id: id, room_id }));
  const info = communityRoomInfo({ room_id });
  assert.strictEqual(info.member_count, 5);
});

test("E09 join_room echoes session_id and room_id", () => {
  reset();
  reg("e1"); reg("e2");
  const { room_id } = communityCreateRoom({ session_id: "e1", name: "E" });
  const r = communityJoinRoom({ session_id: "e2", room_id });
  assert.strictEqual(r.session_id, "e2");
  assert.strictEqual(r.room_id, room_id);
});

test("E10 join_room: missing room_id throws", () => {
  reset();
  reg("e1");
  assert.throws(() => communityJoinRoom({ session_id: "e1" }), /non-empty/);
});

// ── F: community_leave_room ───────────────────────────────────────────────────
process.stderr.write("\nF: community_leave_room\n");
reset();

test("F01 leave_room returns ok:true", () => {
  reset();
  reg("f1"); reg("f2");
  const { room_id } = communityCreateRoom({ session_id: "f1", name: "Leave" });
  communityJoinRoom({ session_id: "f2", room_id });
  const r = communityLeaveRoom({ session_id: "f2", room_id });
  assert.strictEqual(r.ok, true);
});

test("F02 leave_room: member_count decrements", () => {
  reset();
  reg("f1"); reg("f2");
  const { room_id } = communityCreateRoom({ session_id: "f1", name: "Leave2" });
  communityJoinRoom({ session_id: "f2", room_id });
  const r = communityLeaveRoom({ session_id: "f2", room_id });
  assert.strictEqual(r.member_count, 1);
});

test("F03 leave_room: member removed from room_info.members", () => {
  reset();
  reg("f1"); reg("f2");
  const { room_id } = communityCreateRoom({ session_id: "f1", name: "Gone" });
  communityJoinRoom({ session_id: "f2", room_id });
  communityLeaveRoom({ session_id: "f2", room_id });
  const info = communityRoomInfo({ room_id });
  assert.ok(!info.members.includes("f2"));
});

test("F04 leave_room: non-member throws", () => {
  reset();
  reg("f1"); reg("f2");
  const { room_id } = communityCreateRoom({ session_id: "f1", name: "NM" });
  assert.throws(() => communityLeaveRoom({ session_id: "f2", room_id }), /not a member/);
});

test("F05 leave_room: unknown session throws", () => {
  reset();
  reg("f1");
  const { room_id } = communityCreateRoom({ session_id: "f1", name: "UK" });
  assert.throws(() => communityLeaveRoom({ session_id: "ghost", room_id }), /not found/);
});

test("F06 leave_room: unknown room throws", () => {
  reset();
  reg("f1");
  assert.throws(() => communityLeaveRoom({ session_id: "f1", room_id: "no-room" }), /not found/);
});

test("F07 leave_room: can re-join after leaving", () => {
  reset();
  reg("f1"); reg("f2");
  const { room_id } = communityCreateRoom({ session_id: "f1", name: "Rejoin" });
  communityJoinRoom({ session_id: "f2", room_id });
  communityLeaveRoom({ session_id: "f2", room_id });
  const r = communityJoinRoom({ session_id: "f2", room_id });
  assert.strictEqual(r.member_count, 2);
});

test("F08 leave_room echoes session_id", () => {
  reset();
  reg("f1"); reg("f2");
  const { room_id } = communityCreateRoom({ session_id: "f1", name: "Echo" });
  communityJoinRoom({ session_id: "f2", room_id });
  const r = communityLeaveRoom({ session_id: "f2", room_id });
  assert.strictEqual(r.session_id, "f2");
});

test("F09 leave_room: delete_session removes from room", () => {
  reset();
  reg("f1"); reg("f2");
  const { room_id } = communityCreateRoom({ session_id: "f1", name: "Del" });
  communityJoinRoom({ session_id: "f2", room_id });
  communityDeleteSession({ session_id: "f2" });
  const info = communityRoomInfo({ room_id });
  assert.ok(!info.members.includes("f2"));
});

test("F10 leave_room: after leaving, no longer receives room messages", () => {
  reset();
  reg("f1"); reg("f2");
  const { room_id } = communityCreateRoom({ session_id: "f1", name: "NoMsg" });
  communityJoinRoom({ session_id: "f2", room_id });
  communityLeaveRoom({ session_id: "f2", room_id });
  communityRoomMessage({ from_session: "f1", room_id, body: "you left" });
  const r = communityReadMessages({ session_id: "f2", mark_read: false });
  assert.strictEqual(r.total, 0);
});

// ── G: community_room_message ─────────────────────────────────────────────────
process.stderr.write("\nG: community_room_message\n");
reset();

test("G01 room_message returns ok:true", () => {
  reset();
  reg("g1"); reg("g2");
  const { room_id } = communityCreateRoom({ session_id: "g1", name: "G" });
  communityJoinRoom({ session_id: "g2", room_id });
  const r = communityRoomMessage({ from_session: "g1", room_id, body: "hello room" });
  assert.strictEqual(r.ok, true);
});

test("G02 room_message: sent_to has all members except sender", () => {
  reset();
  reg("g1"); reg("g2"); reg("g3");
  const { room_id } = communityCreateRoom({ session_id: "g1", name: "G" });
  communityJoinRoom({ session_id: "g2", room_id });
  communityJoinRoom({ session_id: "g3", room_id });
  const r = communityRoomMessage({ from_session: "g1", room_id, body: "msg" });
  assert.ok(r.sent_to.includes("g2"));
  assert.ok(r.sent_to.includes("g3"));
  assert.ok(!r.sent_to.includes("g1"));
});

test("G03 room_message: recipients see message in inbox", () => {
  reset();
  reg("g1"); reg("g2");
  const { room_id } = communityCreateRoom({ session_id: "g1", name: "G" });
  communityJoinRoom({ session_id: "g2", room_id });
  communityRoomMessage({ from_session: "g1", room_id, body: "room body" });
  const r = communityReadMessages({ session_id: "g2", mark_read: false });
  assert.strictEqual(r.total, 1);
  assert.strictEqual(r.messages[0].body, "room body");
});

test("G04 room_message: message has room_id set", () => {
  reset();
  reg("g1"); reg("g2");
  const { room_id } = communityCreateRoom({ session_id: "g1", name: "G" });
  communityJoinRoom({ session_id: "g2", room_id });
  communityRoomMessage({ from_session: "g1", room_id, body: "rID" });
  const r = communityReadMessages({ session_id: "g2", mark_read: false });
  assert.strictEqual(r.messages[0].room_id, room_id);
});

test("G05 room_message: non-member cannot send", () => {
  reset();
  reg("g1"); reg("g2");
  const { room_id } = communityCreateRoom({ session_id: "g1", name: "G" });
  assert.throws(() => communityRoomMessage({ from_session: "g2", room_id, body: "x" }), /not a member/);
});

test("G06 room_message: unknown room throws", () => {
  reset();
  reg("g1");
  assert.throws(() => communityRoomMessage({ from_session: "g1", room_id: "ghost-room", body: "x" }), /not found/);
});

test("G07 room_message: missing body throws", () => {
  reset();
  reg("g1");
  const { room_id } = communityCreateRoom({ session_id: "g1", name: "G" });
  assert.throws(() => communityRoomMessage({ from_session: "g1", room_id }), /non-empty/);
});

test("G08 room_message: returns message_ids per recipient", () => {
  reset();
  reg("g1"); reg("g2"); reg("g3");
  const { room_id } = communityCreateRoom({ session_id: "g1", name: "G" });
  communityJoinRoom({ session_id: "g2", room_id });
  communityJoinRoom({ session_id: "g3", room_id });
  const r = communityRoomMessage({ from_session: "g1", room_id, body: "ids" });
  assert.strictEqual(r.message_ids.length, 2);
});

test("G09 room_message with ttl_seconds", () => {
  reset();
  reg("g1"); reg("g2");
  const { room_id } = communityCreateRoom({ session_id: "g1", name: "G" });
  communityJoinRoom({ session_id: "g2", room_id });
  const r = communityRoomMessage({ from_session: "g1", room_id, body: "ttl", ttl_seconds: 60 });
  assert.ok(r.expires_at);
});

test("G10 room_message with reply_to", () => {
  reset();
  reg("g1"); reg("g2");
  const { room_id } = communityCreateRoom({ session_id: "g1", name: "G" });
  communityJoinRoom({ session_id: "g2", room_id });
  const orig = communityRoomMessage({ from_session: "g1", room_id, body: "original" });
  // g2 reads to get message_id
  const msgs = communityReadMessages({ session_id: "g2", mark_read: false });
  const origId = msgs.messages[0].message_id;
  // g2 replies
  const reply = communityRoomMessage({ from_session: "g2", room_id, body: "reply", reply_to: origId });
  assert.ok(reply.ok);
});

test("G11 room_message: only 1 member (just sender): empty sent_to", () => {
  reset();
  reg("g1");
  const { room_id } = communityCreateRoom({ session_id: "g1", name: "Solo" });
  const r = communityRoomMessage({ from_session: "g1", room_id, body: "alone" });
  assert.strictEqual(r.sent_to.length, 0);
});

test("G12 room_message: unknown from_session throws", () => {
  reset();
  reg("g1");
  const { room_id } = communityCreateRoom({ session_id: "g1", name: "G" });
  assert.throws(() => communityRoomMessage({ from_session: "ghost", room_id, body: "x" }), /not found/);
});

test("G13 room_message: NUL in body throws", () => {
  reset();
  reg("g1"); reg("g2");
  const { room_id } = communityCreateRoom({ session_id: "g1", name: "G" });
  communityJoinRoom({ session_id: "g2", room_id });
  assert.throws(() => communityRoomMessage({ from_session: "g1", room_id, body: "hi\0there" }), /NUL/);
});

test("G14 room_message echoes room_id", () => {
  reset();
  reg("g1");
  const { room_id } = communityCreateRoom({ session_id: "g1", name: "G" });
  const r = communityRoomMessage({ from_session: "g1", room_id, body: "hi" });
  assert.strictEqual(r.room_id, room_id);
});

test("G15 room_message echoes from_session", () => {
  reset();
  reg("g1");
  const { room_id } = communityCreateRoom({ session_id: "g1", name: "G" });
  const r = communityRoomMessage({ from_session: "g1", room_id, body: "hi" });
  assert.strictEqual(r.from_session, "g1");
});

test("G16 room_message: invalid reply_to throws", () => {
  reset();
  reg("g1");
  const { room_id } = communityCreateRoom({ session_id: "g1", name: "G" });
  assert.throws(() => communityRoomMessage({ from_session: "g1", room_id, body: "x", reply_to: "msg_nope" }), /not found/);
});

// ── H: community_list_rooms ───────────────────────────────────────────────────
process.stderr.write("\nH: community_list_rooms\n");
reset();

test("H01 list_rooms returns ok:true", () => {
  reset();
  const r = communityListRooms({});
  assert.strictEqual(r.ok, true);
});

test("H02 list_rooms empty when no rooms", () => {
  reset();
  const r = communityListRooms({});
  assert.strictEqual(r.total, 0);
});

test("H03 list_rooms shows created room", () => {
  reset();
  reg("h1");
  communityCreateRoom({ session_id: "h1", name: "Visible" });
  const r = communityListRooms({});
  assert.strictEqual(r.total, 1);
  assert.strictEqual(r.rooms[0].name, "Visible");
});

test("H04 list_rooms pagination page_size", () => {
  reset();
  reg("h1");
  for (let i = 0; i < 5; i++) communityCreateRoom({ session_id: "h1", name: `R${i}` });
  const r = communityListRooms({ page_size: 2 });
  assert.strictEqual(r.rooms.length, 2);
});

test("H05 list_rooms filter by name", () => {
  reset();
  reg("h1");
  communityCreateRoom({ session_id: "h1", name: "Alpha Room" });
  communityCreateRoom({ session_id: "h1", name: "Beta Room" });
  const r = communityListRooms({ filter: "alpha" });
  assert.strictEqual(r.total, 1);
  assert.strictEqual(r.rooms[0].name, "Alpha Room");
});

test("H06 list_rooms member_only: only rooms caller joined", () => {
  reset();
  reg("h1"); reg("h2");
  communityCreateRoom({ session_id: "h1", name: "Room1" }); // h1 is member
  const { room_id: r2 } = communityCreateRoom({ session_id: "h2", name: "Room2" });
  communityJoinRoom({ session_id: "h1", room_id: r2 }); // h1 also joins r2
  const r = communityListRooms({ session_id: "h1", member_only: true });
  assert.strictEqual(r.total, 2);
});

test("H07 list_rooms includes member_count", () => {
  reset();
  reg("h1"); reg("h2");
  const { room_id } = communityCreateRoom({ session_id: "h1", name: "MC" });
  communityJoinRoom({ session_id: "h2", room_id });
  const r = communityListRooms({});
  assert.strictEqual(r.rooms[0].member_count, 2);
});

test("H08 list_rooms page_size capped at 100", () => {
  reset();
  reg("h1");
  for (let i = 0; i < 110; i++) communityCreateRoom({ session_id: "h1", name: `R${i}` });
  const r = communityListRooms({ page_size: 200 });
  assert.strictEqual(r.rooms.length, 100);
});

test("H09 list_rooms page 2", () => {
  reset();
  reg("h1");
  for (let i = 0; i < 5; i++) communityCreateRoom({ session_id: "h1", name: `R${i}` });
  const r = communityListRooms({ page: 2, page_size: 2 });
  assert.strictEqual(r.rooms.length, 2);
  assert.strictEqual(r.page, 2);
});

test("H10 list_rooms filter case-insensitive", () => {
  reset();
  reg("h1");
  communityCreateRoom({ session_id: "h1", name: "UPPERCASE ROOM" });
  const r = communityListRooms({ filter: "uppercase" });
  assert.strictEqual(r.total, 1);
});

test("H11 list_rooms includes created_by", () => {
  reset();
  reg("h1");
  communityCreateRoom({ session_id: "h1", name: "By" });
  const r = communityListRooms({});
  assert.strictEqual(r.rooms[0].created_by, "h1");
});

test("H12 list_rooms includes created_at", () => {
  reset();
  reg("h1");
  communityCreateRoom({ session_id: "h1", name: "At" });
  const r = communityListRooms({});
  assert.ok(r.rooms[0].created_at && r.rooms[0].created_at.includes("T"));
});

// ── I: community_room_info ────────────────────────────────────────────────────
process.stderr.write("\nI: community_room_info\n");
reset();

test("I01 room_info returns ok:true", () => {
  reset();
  reg("i1");
  const { room_id } = communityCreateRoom({ session_id: "i1", name: "Info" });
  const r = communityRoomInfo({ room_id });
  assert.strictEqual(r.ok, true);
});

test("I02 room_info returns name", () => {
  reset();
  reg("i1");
  const { room_id } = communityCreateRoom({ session_id: "i1", name: "Named" });
  const r = communityRoomInfo({ room_id });
  assert.strictEqual(r.name, "Named");
});

test("I03 room_info returns members array", () => {
  reset();
  reg("i1");
  const { room_id } = communityCreateRoom({ session_id: "i1", name: "M" });
  const r = communityRoomInfo({ room_id });
  assert.ok(Array.isArray(r.members));
  assert.ok(r.members.includes("i1"));
});

test("I04 room_info member_count matches members.length", () => {
  reset();
  reg("i1"); reg("i2");
  const { room_id } = communityCreateRoom({ session_id: "i1", name: "MC" });
  communityJoinRoom({ session_id: "i2", room_id });
  const r = communityRoomInfo({ room_id });
  assert.strictEqual(r.member_count, r.members.length);
});

test("I05 room_info: unknown room throws", () => {
  reset();
  assert.throws(() => communityRoomInfo({ room_id: "no-room" }), /not found/);
});

test("I06 room_info returns description", () => {
  reset();
  reg("i1");
  const { room_id } = communityCreateRoom({ session_id: "i1", name: "D", description: "desc here" });
  const r = communityRoomInfo({ room_id });
  assert.strictEqual(r.description, "desc here");
});

test("I07 room_info returns created_by", () => {
  reset();
  reg("i1");
  const { room_id } = communityCreateRoom({ session_id: "i1", name: "C" });
  const r = communityRoomInfo({ room_id });
  assert.strictEqual(r.created_by, "i1");
});

test("I08 room_info echoes room_id", () => {
  reset();
  reg("i1");
  const { room_id } = communityCreateRoom({ session_id: "i1", name: "E" });
  const r = communityRoomInfo({ room_id });
  assert.strictEqual(r.room_id, room_id);
});

test("I09 room_info: NUL in room_id throws", () => {
  reset();
  assert.throws(() => communityRoomInfo({ room_id: "ab\0cd" }), /NUL/);
});

test("I10 room_info: after leave, member removed", () => {
  reset();
  reg("i1"); reg("i2");
  const { room_id } = communityCreateRoom({ session_id: "i1", name: "L" });
  communityJoinRoom({ session_id: "i2", room_id });
  communityLeaveRoom({ session_id: "i2", room_id });
  const r = communityRoomInfo({ room_id });
  assert.ok(!r.members.includes("i2"));
});

// ── J: community_delete_room ──────────────────────────────────────────────────
process.stderr.write("\nJ: community_delete_room\n");
reset();

test("J01 delete_room returns ok:true", () => {
  reset();
  reg("j1");
  const { room_id } = communityCreateRoom({ session_id: "j1", name: "Del" });
  const r = communityDeleteRoom({ room_id });
  assert.strictEqual(r.ok, true);
});

test("J02 delete_room removes from _ROOMS", () => {
  reset();
  reg("j1");
  const { room_id } = communityCreateRoom({ session_id: "j1", name: "Del" });
  communityDeleteRoom({ room_id });
  assert.ok(!_ROOMS.has(room_id));
});

test("J03 delete_room purges room messages by default", () => {
  reset();
  reg("j1"); reg("j2");
  const { room_id } = communityCreateRoom({ session_id: "j1", name: "Del" });
  communityJoinRoom({ session_id: "j2", room_id });
  communityRoomMessage({ from_session: "j1", room_id, body: "bye" });
  communityDeleteRoom({ room_id });
  assert.strictEqual(_MESSAGES.size, 0);
});

test("J04 delete_room messages_deleted count", () => {
  reset();
  reg("j1"); reg("j2");
  const { room_id } = communityCreateRoom({ session_id: "j1", name: "Del" });
  communityJoinRoom({ session_id: "j2", room_id });
  communityRoomMessage({ from_session: "j1", room_id, body: "msg1" });
  communityRoomMessage({ from_session: "j1", room_id, body: "msg2" });
  const r = communityDeleteRoom({ room_id });
  assert.strictEqual(r.messages_deleted, 2); // j2 got 2 messages
});

test("J05 delete_room purge_messages=false keeps messages", () => {
  reset();
  reg("j1"); reg("j2");
  const { room_id } = communityCreateRoom({ session_id: "j1", name: "Del" });
  communityJoinRoom({ session_id: "j2", room_id });
  communityRoomMessage({ from_session: "j1", room_id, body: "keep" });
  communityDeleteRoom({ room_id, purge_messages: false });
  assert.strictEqual(_MESSAGES.size, 1);
});

test("J06 delete_room: unknown room throws", () => {
  reset();
  assert.throws(() => communityDeleteRoom({ room_id: "no-room" }), /not found/);
});

test("J07 delete_room doesn't remove unrelated messages", () => {
  reset();
  reg("j1"); reg("j2");
  const { room_id } = communityCreateRoom({ session_id: "j1", name: "Del" });
  communitySendMessage({ from_session: "j1", to_session: "j2", body: "unrelated" });
  communityDeleteRoom({ room_id });
  assert.strictEqual(_MESSAGES.size, 1);
});

test("J08 delete_room echoes room_id", () => {
  reset();
  reg("j1");
  const { room_id } = communityCreateRoom({ session_id: "j1", name: "E" });
  const r = communityDeleteRoom({ room_id });
  assert.strictEqual(r.room_id, room_id);
});

test("J09 delete_room: deleted room no longer in list", () => {
  reset();
  reg("j1");
  const { room_id } = communityCreateRoom({ session_id: "j1", name: "Gone" });
  communityDeleteRoom({ room_id });
  const r = communityListRooms({});
  assert.strictEqual(r.total, 0);
});

test("J10 delete_room: NUL in room_id throws", () => {
  reset();
  assert.throws(() => communityDeleteRoom({ room_id: "ab\0cd" }), /NUL/);
});

// ── K: community_message_status extended ─────────────────────────────────────
process.stderr.write("\nK: community_message_status (extended fields)\n");
reset();

test("K01 message_status has room_id for room message", () => {
  reset();
  reg("k1"); reg("k2");
  const { room_id } = communityCreateRoom({ session_id: "k1", name: "R" });
  communityJoinRoom({ session_id: "k2", room_id });
  const rm = communityRoomMessage({ from_session: "k1", room_id, body: "rtest" });
  const status = communityMessageStatus({ message_id: rm.message_ids[0] });
  assert.strictEqual(status.room_id, room_id);
});

test("K02 message_status has null room_id for 1-1 message", () => {
  reset();
  reg("k1"); reg("k2");
  const { message_id } = communitySendMessage({ from_session: "k1", to_session: "k2", body: "x" });
  const status = communityMessageStatus({ message_id });
  assert.strictEqual(status.room_id, null);
});

test("K03 message_status returns expires_at for TTL message", () => {
  reset();
  reg("k1"); reg("k2");
  const { message_id } = communitySendMessage({ from_session: "k1", to_session: "k2", body: "x", ttl_seconds: 3600 });
  const status = communityMessageStatus({ message_id });
  assert.ok(status.expires_at);
});

test("K04 message_status returns null expires_at for no-TTL message", () => {
  reset();
  reg("k1"); reg("k2");
  const { message_id } = communitySendMessage({ from_session: "k1", to_session: "k2", body: "x" });
  const status = communityMessageStatus({ message_id });
  assert.strictEqual(status.expires_at, null);
});

test("K05 message_status expired=false for valid message", () => {
  reset();
  reg("k1"); reg("k2");
  const { message_id } = communitySendMessage({ from_session: "k1", to_session: "k2", body: "x" });
  const status = communityMessageStatus({ message_id });
  assert.strictEqual(status.expired, false);
});

test("K06 message_status has reply_to for threaded message", () => {
  reset();
  reg("k1"); reg("k2");
  const orig  = communitySendMessage({ from_session: "k1", to_session: "k2", body: "o" });
  const reply = communitySendMessage({ from_session: "k2", to_session: "k1", body: "r", reply_to: orig.message_id });
  const status = communityMessageStatus({ message_id: reply.message_id });
  assert.strictEqual(status.reply_to, orig.message_id);
});

test("K07 message_status null reply_to for non-threaded", () => {
  reset();
  reg("k1"); reg("k2");
  const { message_id } = communitySendMessage({ from_session: "k1", to_session: "k2", body: "x" });
  const status = communityMessageStatus({ message_id });
  assert.strictEqual(status.reply_to, null);
});

test("K08 message_status: broadcast message has correct to_session", () => {
  reset();
  reg("k1"); reg("k2");
  const br = communityBroadcast({ from_session: "k1", body: "bc" });
  const status = communityMessageStatus({ message_id: br.message_ids[0] });
  assert.strictEqual(status.to_session, "k2");
});

// ── L: community_read_messages thread_of ─────────────────────────────────────
process.stderr.write("\nL: community_read_messages (thread_of)\n");
reset();

test("L01 thread_of returns original message", () => {
  reset();
  reg("l1"); reg("l2");
  const orig = communitySendMessage({ from_session: "l2", to_session: "l1", body: "root" });
  const r = communityReadMessages({ session_id: "l1", thread_of: orig.message_id, mark_read: false });
  assert.ok(r.messages.some(m => m.message_id === orig.message_id));
});

test("L02 thread_of returns replies", () => {
  reset();
  reg("l1"); reg("l2");
  const orig  = communitySendMessage({ from_session: "l2", to_session: "l1", body: "root" });
  const reply = communitySendMessage({ from_session: "l2", to_session: "l1", body: "reply", reply_to: orig.message_id });
  const r = communityReadMessages({ session_id: "l1", thread_of: orig.message_id, mark_read: false });
  assert.ok(r.messages.some(m => m.message_id === reply.message_id));
});

test("L03 thread_of excludes non-thread messages", () => {
  reset();
  reg("l1"); reg("l2");
  const orig     = communitySendMessage({ from_session: "l2", to_session: "l1", body: "root" });
  communitySendMessage({ from_session: "l2", to_session: "l1", body: "other" });
  const r = communityReadMessages({ session_id: "l1", thread_of: orig.message_id, mark_read: false });
  assert.strictEqual(r.total, 1); // only root (no replies yet)
});

test("L04 thread_of with multiple replies", () => {
  reset();
  reg("l1"); reg("l2");
  const orig = communitySendMessage({ from_session: "l2", to_session: "l1", body: "q" });
  communitySendMessage({ from_session: "l2", to_session: "l1", body: "r1", reply_to: orig.message_id });
  communitySendMessage({ from_session: "l2", to_session: "l1", body: "r2", reply_to: orig.message_id });
  const r = communityReadMessages({ session_id: "l1", thread_of: orig.message_id, mark_read: false });
  assert.strictEqual(r.total, 3); // root + 2 replies
});

test("L05 thread_of: NUL byte throws", () => {
  reset();
  reg("l1");
  assert.throws(() => communityReadMessages({ session_id: "l1", thread_of: "msg\0bad" }), /NUL/);
});

test("L06 thread_of with no replies: only root returned", () => {
  reset();
  reg("l1"); reg("l2");
  const orig = communitySendMessage({ from_session: "l2", to_session: "l1", body: "solo" });
  const r = communityReadMessages({ session_id: "l1", thread_of: orig.message_id, mark_read: false });
  assert.strictEqual(r.total, 1);
  assert.strictEqual(r.messages[0].message_id, orig.message_id);
});

test("L07 thread_of marks replies as read", () => {
  reset();
  reg("l1"); reg("l2");
  const orig  = communitySendMessage({ from_session: "l2", to_session: "l1", body: "root" });
  communitySendMessage({ from_session: "l2", to_session: "l1", body: "reply", reply_to: orig.message_id });
  communityReadMessages({ session_id: "l1", thread_of: orig.message_id, mark_read: true });
  const summary = communityInboxSummary({ session_id: "l1" });
  assert.strictEqual(summary.unread, 0);
});

test("L08 thread_of with mark_read=false leaves unread", () => {
  reset();
  reg("l1"); reg("l2");
  const orig = communitySendMessage({ from_session: "l2", to_session: "l1", body: "root" });
  communityReadMessages({ session_id: "l1", thread_of: orig.message_id, mark_read: false });
  const summary = communityInboxSummary({ session_id: "l1" });
  assert.strictEqual(summary.unread, 1);
});

test("L09 thread_of doesn't return expired messages", () => {
  reset();
  reg("l1"); reg("l2");
  const orig = communitySendMessage({ from_session: "l2", to_session: "l1", body: "root" });
  _MESSAGES.set("msg_exp_thread", {
    message_id: "msg_exp_thread", from_session: "l2", to_session: "l1", room_id: null,
    body: "expired reply", sent_at: new Date().toISOString(),
    expires_at: new Date(Date.now() - 1000).toISOString(),
    reply_to: orig.message_id, read_at: null, status: "unread",
  });
  const r = communityReadMessages({ session_id: "l1", thread_of: orig.message_id, mark_read: false });
  // root + 0 valid replies (expired one excluded)
  assert.ok(!r.messages.some(m => m.message_id === "msg_exp_thread"));
});

test("L10 thread_of: non-existent thread_of returns empty", () => {
  reset();
  reg("l1"); reg("l2");
  communitySendMessage({ from_session: "l2", to_session: "l1", body: "unrelated" });
  const r = communityReadMessages({ session_id: "l1", thread_of: "msg_nonexistent", mark_read: false });
  assert.strictEqual(r.total, 0);
});

// ── M: community_info room_count ──────────────────────────────────────────────
process.stderr.write("\nM: community_info (room_count)\n");
reset();

test("M01 community_info has room_count", () => {
  reset();
  const r = communityInfo({});
  assert.ok("room_count" in r);
});

test("M02 community_info room_count=0 when empty", () => {
  reset();
  const r = communityInfo({});
  assert.strictEqual(r.room_count, 0);
});

test("M03 community_info room_count increments", () => {
  reset();
  reg("m1");
  communityCreateRoom({ session_id: "m1", name: "R1" });
  communityCreateRoom({ session_id: "m1", name: "R2" });
  const r = communityInfo({});
  assert.strictEqual(r.room_count, 2);
});

test("M04 community_info room_count decrements on delete", () => {
  reset();
  reg("m1");
  const { room_id } = communityCreateRoom({ session_id: "m1", name: "R" });
  communityDeleteRoom({ room_id });
  const r = communityInfo({});
  assert.strictEqual(r.room_count, 0);
});

test("M05 community_info limits has max_rooms", () => {
  reset();
  const r = communityInfo({});
  assert.ok(typeof r.limits.max_rooms === "number" && r.limits.max_rooms > 0);
});

test("M06 community_info unread_total excludes expired messages", () => {
  reset();
  reg("m1"); reg("m2");
  communitySendMessage({ from_session: "m1", to_session: "m2", body: "valid" });
  _MESSAGES.set("msg_exp_info", {
    message_id: "msg_exp_info", from_session: "m1", to_session: "m2", room_id: null,
    body: "exp", sent_at: new Date().toISOString(),
    expires_at: new Date(Date.now() - 1000).toISOString(),
    reply_to: null, read_at: null, status: "unread",
  });
  const r = communityInfo({});
  assert.strictEqual(r.unread_total, 1); // only the valid one
});

// ── N: integration / stress ───────────────────────────────────────────────────
process.stderr.write("\nN: integration / stress\n");
reset();

test("N01 full workflow: register, create room, join, send, read", () => {
  reset();
  reg("n1"); reg("n2"); reg("n3");
  const { room_id } = communityCreateRoom({ session_id: "n1", name: "General" });
  communityJoinRoom({ session_id: "n2", room_id });
  communityJoinRoom({ session_id: "n3", room_id });
  communityRoomMessage({ from_session: "n1", room_id, body: "Welcome everyone!" });
  const r2 = communityReadMessages({ session_id: "n2", mark_read: false });
  const r3 = communityReadMessages({ session_id: "n3", mark_read: false });
  assert.strictEqual(r2.total, 1);
  assert.strictEqual(r3.total, 1);
  assert.strictEqual(r2.messages[0].body, "Welcome everyone!");
});

test("N02 broadcast + room message both in inbox", () => {
  reset();
  reg("n1"); reg("n2");
  const { room_id } = communityCreateRoom({ session_id: "n1", name: "R" });
  communityJoinRoom({ session_id: "n2", room_id });
  communityBroadcast({ from_session: "n1", body: "broadcast" });
  communityRoomMessage({ from_session: "n1", room_id, body: "room msg" });
  const r = communityReadMessages({ session_id: "n2", mark_read: false });
  assert.strictEqual(r.total, 2);
});

test("N03 thread: send, reply via room, read thread", () => {
  reset();
  reg("n1"); reg("n2");
  const { room_id } = communityCreateRoom({ session_id: "n1", name: "T" });
  communityJoinRoom({ session_id: "n2", room_id });
  communityRoomMessage({ from_session: "n1", room_id, body: "question" });
  const msgs = communityReadMessages({ session_id: "n2", mark_read: false });
  const rootId = msgs.messages[0].message_id;
  communityRoomMessage({ from_session: "n2", room_id, body: "answer", reply_to: rootId });
  const thread = communityReadMessages({ session_id: "n1", thread_of: rootId, mark_read: false });
  assert.strictEqual(thread.total, 2);
});

test("N04 10 AIs join room and broadcast; each gets 9 messages", () => {
  reset();
  const ids = [];
  for (let i = 0; i < 10; i++) { ids.push(`stress-${i}`); reg(`stress-${i}`); }
  const { room_id } = communityCreateRoom({ session_id: ids[0], name: "Stress" });
  ids.slice(1).forEach(id => communityJoinRoom({ session_id: id, room_id }));
  // each AI sends one room message
  ids.forEach(id => communityRoomMessage({ from_session: id, room_id, body: `hi from ${id}` }));
  // each AI should have 9 messages (from the other 9)
  const r = communityReadMessages({ session_id: ids[0], mark_read: false });
  assert.strictEqual(r.total, 9);
});

test("N05 TTL + broadcast: expired broadcasts not in inbox", () => {
  reset();
  reg("n1"); reg("n2");
  const br = communityBroadcast({ from_session: "n1", body: "ephemeral", ttl_seconds: 1 });
  // Manually expire
  const msg = _MESSAGES.get(br.message_ids[0]);
  msg.expires_at = new Date(Date.now() - 1000).toISOString();
  const r = communityReadMessages({ session_id: "n2", mark_read: false });
  assert.strictEqual(r.total, 0);
});

test("N06 delete session removes from room member list", () => {
  reset();
  reg("n1"); reg("n2");
  const { room_id } = communityCreateRoom({ session_id: "n1", name: "R" });
  communityJoinRoom({ session_id: "n2", room_id });
  communityDeleteSession({ session_id: "n2" });
  const info = communityRoomInfo({ room_id });
  assert.ok(!info.members.includes("n2"));
});

test("N07 community_info reflects all new tools state", () => {
  reset();
  reg("n1"); reg("n2");
  communityCreateRoom({ session_id: "n1", name: "R1" });
  communityCreateRoom({ session_id: "n1", name: "R2" });
  communityBroadcast({ from_session: "n1", body: "hi" });
  const r = communityInfo({});
  assert.strictEqual(r.session_count, 2);
  assert.strictEqual(r.room_count, 2);
  assert.strictEqual(r.unread_total, 1); // n2 got 1 broadcast
});

test("N08 read room messages via folder=all with room_id set", () => {
  reset();
  reg("n1"); reg("n2");
  const { room_id } = communityCreateRoom({ session_id: "n1", name: "R" });
  communityJoinRoom({ session_id: "n2", room_id });
  communityRoomMessage({ from_session: "n1", room_id, body: "room" });
  communitySendMessage({ from_session: "n1", to_session: "n2", body: "direct" });
  const r = communityReadMessages({ session_id: "n2", folder: "all", mark_read: false });
  assert.strictEqual(r.total, 2);
  const roomMsgs = r.messages.filter(m => m.room_id === room_id);
  assert.strictEqual(roomMsgs.length, 1);
});

test("N09 passive inbox injection reflects room messages", () => {
  reset();
  reg("n1"); reg("n2");
  const { room_id } = communityCreateRoom({ session_id: "n1", name: "R" });
  communityJoinRoom({ session_id: "n2", room_id });
  communityRoomMessage({ from_session: "n1", room_id, body: "ping" });
  const result = injectInboxSummary("n2", { tool: "some_other_tool" });
  assert.strictEqual(result._inbox.unread, 1);
  assert.ok(result._inbox.hint.includes("unread"));
});

test("N10 member_only filter + join status consistent after leave", () => {
  reset();
  reg("n1"); reg("n2");
  const { room_id: r1 } = communityCreateRoom({ session_id: "n1", name: "R1" });
  const { room_id: r2 } = communityCreateRoom({ session_id: "n2", name: "R2" });
  communityJoinRoom({ session_id: "n1", room_id: r2 });
  communityLeaveRoom({ session_id: "n1", room_id: r2 });
  const list = communityListRooms({ session_id: "n1", member_only: true });
  // n1 is member of r1 (own) but left r2
  assert.strictEqual(list.total, 1);
  assert.strictEqual(list.rooms[0].room_id, r1);
});

// ── Summary ───────────────────────────────────────────────────────────────────
process.nextTick(() => {
  process.stderr.write(`\n=== Section 294 complete: ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exitCode = 1;
});
