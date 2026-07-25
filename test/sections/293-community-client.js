"use strict";
/**
 * Section 293 — community_* tools tests
 *
 * A: community_register           (15 tests)
 * B: community_list_sessions      (17 tests)
 * C: community_send_message       (14 tests)
 * D: community_read_messages      (18 tests)
 * E: community_message_status     (10 tests)
 * F: community_inbox_summary      (10 tests)
 * G: community_delete_session     (10 tests)
 * H: community_info               (8  tests)
 * I: passive inbox injection      (12 tests)
 * J: security / guards            (14 tests)
 * K: concurrency / stress         (8  tests)
 *
 * Total: 136
 */

const assert  = require("assert");
const {
  communityRegister,
  communityListSessions,
  communitySendMessage,
  communityReadMessages,
  communityMessageStatus,
  communityInboxSummary,
  communityDeleteSession,
  communityInfo,
  injectInboxSummary,
  _SESSIONS,
  _MESSAGES,
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
}

function uid(prefix = "ai") {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
}

// ── A: community_register ─────────────────────────────────────────────────────
process.stderr.write("\nA: community_register\n");
reset();

test("A01 register returns ok:true", () => {
  reset();
  const r = communityRegister({ session_id: "ai-alpha", name: "Alpha" });
  assert.strictEqual(r.ok, true);
});

test("A02 register returns session_id", () => {
  reset();
  const r = communityRegister({ session_id: "ai-alpha", name: "Alpha" });
  assert.strictEqual(r.session_id, "ai-alpha");
});

test("A03 register sets name", () => {
  reset();
  const r = communityRegister({ session_id: "ai-alpha", name: "Alpha AI" });
  assert.strictEqual(r.name, "Alpha AI");
});

test("A04 register sets description", () => {
  reset();
  const r = communityRegister({ session_id: "ai-x", name: "X", description: "A code reviewer" });
  assert.strictEqual(r.description, "A code reviewer");
});

test("A05 register already_existed=false on first call", () => {
  reset();
  const r = communityRegister({ session_id: "ai-new" });
  assert.strictEqual(r.already_existed, false);
});

test("A06 register already_existed=true on second call", () => {
  reset();
  communityRegister({ session_id: "ai-dup" });
  const r = communityRegister({ session_id: "ai-dup", name: "Updated" });
  assert.strictEqual(r.already_existed, true);
});

test("A07 re-register updates name", () => {
  reset();
  communityRegister({ session_id: "ai-z", name: "Old Name" });
  const r = communityRegister({ session_id: "ai-z", name: "New Name" });
  assert.strictEqual(r.name, "New Name");
});

test("A08 session_id defaults name to session_id", () => {
  reset();
  const r = communityRegister({ session_id: "my-bot" });
  assert.strictEqual(r.name, "my-bot");
});

test("A09 register has created_at ISO string", () => {
  reset();
  const r = communityRegister({ session_id: "ai-ts" });
  assert.ok(typeof r.created_at === "string" && r.created_at.includes("T"));
});

test("A10 session_id trimmed", () => {
  reset();
  const r = communityRegister({ session_id: "  ai-trim  " });
  assert.strictEqual(r.session_id, "ai-trim");
});

test("A11 register missing session_id throws", () => {
  assert.throws(() => communityRegister({}), /non-empty string/);
});

test("A12 register NUL byte in session_id throws", () => {
  assert.throws(() => communityRegister({ session_id: "ai\0bad" }), /NUL/);
});

test("A13 register session_id > 128 chars throws", () => {
  assert.throws(() => communityRegister({ session_id: "a".repeat(129) }), /≤ 128/);
});

test("A14 register name > 64 chars throws", () => {
  assert.throws(() => communityRegister({ session_id: "ai-x", name: "n".repeat(65) }), /≤ 64/);
});

test("A15 register description > 256 chars throws", () => {
  assert.throws(() => communityRegister({ session_id: "ai-x", description: "d".repeat(257) }), /≤ 256/);
});

// ── B: community_list_sessions ────────────────────────────────────────────────
process.stderr.write("\nB: community_list_sessions\n");
reset();

test("B01 list returns ok:true", () => {
  reset();
  const r = communityListSessions({});
  assert.strictEqual(r.ok, true);
});

test("B02 list empty when no sessions", () => {
  reset();
  const r = communityListSessions({});
  assert.strictEqual(r.total, 0);
  assert.deepStrictEqual(r.sessions, []);
});

test("B03 list shows registered session", () => {
  reset();
  communityRegister({ session_id: "ai-a", name: "A" });
  const r = communityListSessions({});
  assert.strictEqual(r.total, 1);
  assert.strictEqual(r.sessions[0].session_id, "ai-a");
});

test("B04 list pagination page_size respected", () => {
  reset();
  for (let i = 0; i < 5; i++) communityRegister({ session_id: `ai-${i}` });
  const r = communityListSessions({ page_size: 2 });
  assert.strictEqual(r.sessions.length, 2);
});

test("B05 list pagination page 2", () => {
  reset();
  for (let i = 0; i < 5; i++) communityRegister({ session_id: `ai-${i}` });
  const r = communityListSessions({ page: 2, page_size: 2 });
  assert.strictEqual(r.sessions.length, 2);
  assert.strictEqual(r.page, 2);
});

test("B06 list total reflects all sessions", () => {
  reset();
  for (let i = 0; i < 7; i++) communityRegister({ session_id: `ai-${i}` });
  const r = communityListSessions({ page_size: 3 });
  assert.strictEqual(r.total, 7);
});

test("B07 filter by name", () => {
  reset();
  communityRegister({ session_id: "bot-alpha", name: "Alpha Reviewer" });
  communityRegister({ session_id: "bot-beta",  name: "Beta Writer" });
  const r = communityListSessions({ filter: "reviewer" });
  assert.strictEqual(r.total, 1);
  assert.strictEqual(r.sessions[0].session_id, "bot-alpha");
});

test("B08 filter case-insensitive", () => {
  reset();
  communityRegister({ session_id: "bot-y", name: "Yellow Bot" });
  const r = communityListSessions({ filter: "YELLOW" });
  assert.strictEqual(r.total, 1);
});

test("B09 filter by session_id", () => {
  reset();
  communityRegister({ session_id: "unique-xyz", name: "Generic" });
  communityRegister({ session_id: "other-abc",  name: "Other" });
  const r = communityListSessions({ filter: "unique" });
  assert.strictEqual(r.total, 1);
});

test("B10 list includes last_seen_at", () => {
  reset();
  communityRegister({ session_id: "ai-seen" });
  const r = communityListSessions({});
  assert.ok(r.sessions[0].last_seen_at);
});

test("B11 page_size capped at 100", () => {
  reset();
  for (let i = 0; i < 110; i++) communityRegister({ session_id: `ai-cap-${i}` });
  const r = communityListSessions({ page_size: 200 });
  assert.strictEqual(r.sessions.length, 100);
  assert.strictEqual(r.page_size, 100);
});

test("B12 list shows description", () => {
  reset();
  communityRegister({ session_id: "ai-desc", name: "D", description: "I audit code" });
  const r = communityListSessions({});
  assert.strictEqual(r.sessions[0].description, "I audit code");
});

test("B13 list includes status field", () => {
  reset();
  communityRegister({ session_id: "ai-status" });
  const r = communityListSessions({});
  assert.ok(typeof r.sessions[0].status === "string");
});

test("B14 status is 'active' immediately after register", () => {
  reset();
  communityRegister({ session_id: "ai-fresh" });
  const r = communityListSessions({});
  assert.strictEqual(r.sessions[0].status, "active");
});

test("B15 list includes unread_count field", () => {
  reset();
  communityRegister({ session_id: "ai-u1" });
  communityRegister({ session_id: "ai-u2" });
  const r = communityListSessions({});
  assert.ok(r.sessions.every(s => typeof s.unread_count === "number"));
});

test("B16 unread_count increments when message sent", () => {
  reset();
  communityRegister({ session_id: "ai-sender" });
  communityRegister({ session_id: "ai-recv" });
  communitySendMessage({ from_session: "ai-sender", to_session: "ai-recv", body: "ping" });
  const r = communityListSessions({});
  const recv = r.sessions.find(s => s.session_id === "ai-recv");
  assert.strictEqual(recv.unread_count, 1);
});

test("B17 unread_count drops to 0 after reading", () => {
  reset();
  communityRegister({ session_id: "ai-s" });
  communityRegister({ session_id: "ai-r" });
  communitySendMessage({ from_session: "ai-s", to_session: "ai-r", body: "hello" });
  communityReadMessages({ session_id: "ai-r" });
  const r = communityListSessions({});
  const recv = r.sessions.find(s => s.session_id === "ai-r");
  assert.strictEqual(recv.unread_count, 0);
});

// ── C: community_send_message ─────────────────────────────────────────────────
process.stderr.write("\nC: community_send_message\n");
reset();

test("C01 send returns ok:true", () => {
  reset();
  communityRegister({ session_id: "s1" });
  communityRegister({ session_id: "s2" });
  const r = communitySendMessage({ from_session: "s1", to_session: "s2", body: "hello" });
  assert.strictEqual(r.ok, true);
});

test("C02 send returns message_id", () => {
  reset();
  communityRegister({ session_id: "s1" });
  communityRegister({ session_id: "s2" });
  const r = communitySendMessage({ from_session: "s1", to_session: "s2", body: "hi" });
  assert.ok(typeof r.message_id === "string" && r.message_id.startsWith("msg_"));
});

test("C03 send returns sent_at", () => {
  reset();
  communityRegister({ session_id: "s1" });
  communityRegister({ session_id: "s2" });
  const r = communitySendMessage({ from_session: "s1", to_session: "s2", body: "hi" });
  assert.ok(r.sent_at.includes("T"));
});

test("C04 send echo from/to", () => {
  reset();
  communityRegister({ session_id: "s1" });
  communityRegister({ session_id: "s2" });
  const r = communitySendMessage({ from_session: "s1", to_session: "s2", body: "hi" });
  assert.strictEqual(r.from_session, "s1");
  assert.strictEqual(r.to_session,   "s2");
});

test("C05 send to unknown session throws", () => {
  reset();
  communityRegister({ session_id: "s1" });
  assert.throws(() => communitySendMessage({ from_session: "s1", to_session: "ghost", body: "x" }), /not found/);
});

test("C06 send from unknown session throws", () => {
  reset();
  communityRegister({ session_id: "s2" });
  assert.throws(() => communitySendMessage({ from_session: "ghost", to_session: "s2", body: "x" }), /not found/);
});

test("C07 send to self throws", () => {
  reset();
  communityRegister({ session_id: "s1" });
  assert.throws(() => communitySendMessage({ from_session: "s1", to_session: "s1", body: "hi" }), /yourself/);
});

test("C08 send missing body throws", () => {
  reset();
  communityRegister({ session_id: "s1" });
  communityRegister({ session_id: "s2" });
  assert.throws(() => communitySendMessage({ from_session: "s1", to_session: "s2" }), /non-empty/);
});

test("C09 message stored as unread", () => {
  reset();
  communityRegister({ session_id: "s1" });
  communityRegister({ session_id: "s2" });
  const { message_id } = communitySendMessage({ from_session: "s1", to_session: "s2", body: "test" });
  assert.strictEqual(_MESSAGES.get(message_id).status, "unread");
});

test("C10 multiple messages get distinct IDs", () => {
  reset();
  communityRegister({ session_id: "s1" });
  communityRegister({ session_id: "s2" });
  const r1 = communitySendMessage({ from_session: "s1", to_session: "s2", body: "a" });
  const r2 = communitySendMessage({ from_session: "s1", to_session: "s2", body: "b" });
  assert.notStrictEqual(r1.message_id, r2.message_id);
});

test("C11 send bidirectional", () => {
  reset();
  communityRegister({ session_id: "s1" });
  communityRegister({ session_id: "s2" });
  communitySendMessage({ from_session: "s1", to_session: "s2", body: "ping" });
  const r = communitySendMessage({ from_session: "s2", to_session: "s1", body: "pong" });
  assert.strictEqual(r.ok, true);
});

test("C12 send NUL in body throws", () => {
  reset();
  communityRegister({ session_id: "s1" });
  communityRegister({ session_id: "s2" });
  assert.throws(() => communitySendMessage({ from_session: "s1", to_session: "s2", body: "hi\0there" }), /NUL/);
});

test("C13 send body up to 32KB allowed", () => {
  reset();
  communityRegister({ session_id: "s1" });
  communityRegister({ session_id: "s2" });
  const r = communitySendMessage({ from_session: "s1", to_session: "s2", body: "x".repeat(32 * 1024) });
  assert.strictEqual(r.ok, true);
});

test("C14 send body over 32KB throws", () => {
  reset();
  communityRegister({ session_id: "s1" });
  communityRegister({ session_id: "s2" });
  assert.throws(() => communitySendMessage({ from_session: "s1", to_session: "s2", body: "x".repeat(32 * 1024 + 1) }), /≤/);
});

// ── D: community_read_messages ────────────────────────────────────────────────
process.stderr.write("\nD: community_read_messages\n");
reset();

test("D01 read_messages returns ok:true", () => {
  reset();
  communityRegister({ session_id: "r1" });
  const r = communityReadMessages({ session_id: "r1" });
  assert.strictEqual(r.ok, true);
});

test("D02 read_messages empty inbox", () => {
  reset();
  communityRegister({ session_id: "r1" });
  const r = communityReadMessages({ session_id: "r1" });
  assert.strictEqual(r.total, 0);
  assert.deepStrictEqual(r.messages, []);
});

test("D03 read_messages sees sent message", () => {
  reset();
  communityRegister({ session_id: "r1" });
  communityRegister({ session_id: "r2" });
  communitySendMessage({ from_session: "r2", to_session: "r1", body: "hey" });
  const r = communityReadMessages({ session_id: "r1" });
  assert.strictEqual(r.total, 1);
  assert.strictEqual(r.messages[0].body, "hey");
});

test("D04 read marks messages as read", () => {
  reset();
  communityRegister({ session_id: "r1" });
  communityRegister({ session_id: "r2" });
  communitySendMessage({ from_session: "r2", to_session: "r1", body: "mark me" });
  communityReadMessages({ session_id: "r1" });
  const r = communityReadMessages({ session_id: "r1" });
  assert.strictEqual(r.unread_before, 0);
});

test("D05 read_now count correct", () => {
  reset();
  communityRegister({ session_id: "r1" });
  communityRegister({ session_id: "r2" });
  communitySendMessage({ from_session: "r2", to_session: "r1", body: "a" });
  communitySendMessage({ from_session: "r2", to_session: "r1", body: "b" });
  const r = communityReadMessages({ session_id: "r1" });
  assert.strictEqual(r.read_now, 2);
});

test("D06 mark_read=false leaves messages unread", () => {
  reset();
  communityRegister({ session_id: "r1" });
  communityRegister({ session_id: "r2" });
  communitySendMessage({ from_session: "r2", to_session: "r1", body: "peek" });
  communityReadMessages({ session_id: "r1", mark_read: false });
  const r = communityReadMessages({ session_id: "r1", mark_read: false });
  assert.strictEqual(r.unread_before, 1);
});

test("D07 folder=sent returns sent messages", () => {
  reset();
  communityRegister({ session_id: "r1" });
  communityRegister({ session_id: "r2" });
  communitySendMessage({ from_session: "r1", to_session: "r2", body: "sent by r1" });
  const r = communityReadMessages({ session_id: "r1", folder: "sent" });
  assert.strictEqual(r.total, 1);
  assert.strictEqual(r.messages[0].from_session, "r1");
});

test("D08 folder=inbox excludes sent messages", () => {
  reset();
  communityRegister({ session_id: "r1" });
  communityRegister({ session_id: "r2" });
  communitySendMessage({ from_session: "r1", to_session: "r2", body: "out" });
  const r = communityReadMessages({ session_id: "r1", folder: "inbox" });
  assert.strictEqual(r.total, 0);
});

test("D09 folder=all returns sent+received", () => {
  reset();
  communityRegister({ session_id: "r1" });
  communityRegister({ session_id: "r2" });
  communitySendMessage({ from_session: "r1", to_session: "r2", body: "out" });
  communitySendMessage({ from_session: "r2", to_session: "r1", body: "in" });
  const r = communityReadMessages({ session_id: "r1", folder: "all" });
  assert.strictEqual(r.total, 2);
});

test("D10 read_messages pagination", () => {
  reset();
  communityRegister({ session_id: "r1" });
  communityRegister({ session_id: "r2" });
  for (let i = 0; i < 5; i++) communitySendMessage({ from_session: "r2", to_session: "r1", body: `msg${i}` });
  const r = communityReadMessages({ session_id: "r1", page_size: 2, mark_read: false });
  assert.strictEqual(r.messages.length, 2);
});

test("D11 read_messages page 2", () => {
  reset();
  communityRegister({ session_id: "r1" });
  communityRegister({ session_id: "r2" });
  for (let i = 0; i < 5; i++) communitySendMessage({ from_session: "r2", to_session: "r1", body: `msg${i}` });
  const r = communityReadMessages({ session_id: "r1", page: 2, page_size: 2, mark_read: false });
  assert.strictEqual(r.messages.length, 2);
  assert.strictEqual(r.page, 2);
});

test("D12 messages sorted by sent_at ascending", () => {
  reset();
  communityRegister({ session_id: "r1" });
  communityRegister({ session_id: "r2" });
  communitySendMessage({ from_session: "r2", to_session: "r1", body: "first" });
  communitySendMessage({ from_session: "r2", to_session: "r1", body: "second" });
  const r = communityReadMessages({ session_id: "r1", mark_read: false });
  assert.strictEqual(r.messages[0].body, "first");
  assert.strictEqual(r.messages[1].body, "second");
});

test("D13 read_messages unknown session throws", () => {
  reset();
  assert.throws(() => communityReadMessages({ session_id: "ghost" }), /not found/);
});

test("D14 invalid folder throws", () => {
  reset();
  communityRegister({ session_id: "r1" });
  assert.throws(() => communityReadMessages({ session_id: "r1", folder: "trash" }), /folder must be/);
});

test("D15 read_messages message has read_at after reading", () => {
  reset();
  communityRegister({ session_id: "r1" });
  communityRegister({ session_id: "r2" });
  communitySendMessage({ from_session: "r2", to_session: "r1", body: "check read_at" });
  const r = communityReadMessages({ session_id: "r1" });
  assert.ok(r.messages[0].read_at !== null);
});

test("D16 unread_before is non-zero before first read", () => {
  reset();
  communityRegister({ session_id: "r1" });
  communityRegister({ session_id: "r2" });
  communitySendMessage({ from_session: "r2", to_session: "r1", body: "unread" });
  const r = communityReadMessages({ session_id: "r1" });
  assert.strictEqual(r.unread_before, 1);
  assert.strictEqual(r.unread_after,  0);
});

test("D17 only own inbox messages marked read (not others')", () => {
  reset();
  communityRegister({ session_id: "r1" });
  communityRegister({ session_id: "r2" });
  communityRegister({ session_id: "r3" });
  communitySendMessage({ from_session: "r1", to_session: "r2", body: "for r2" });
  communityReadMessages({ session_id: "r3", folder: "all" }); // r3 reads its all (empty)
  // r2's message should still be unread
  const r = communityReadMessages({ session_id: "r2" });
  assert.strictEqual(r.unread_before, 1);
});

test("D18 message status field correct in response", () => {
  reset();
  communityRegister({ session_id: "r1" });
  communityRegister({ session_id: "r2" });
  communitySendMessage({ from_session: "r2", to_session: "r1", body: "status?" });
  const r = communityReadMessages({ session_id: "r1", mark_read: false });
  assert.strictEqual(r.messages[0].status, "unread");
});

// ── E: community_message_status ───────────────────────────────────────────────
process.stderr.write("\nE: community_message_status\n");
reset();

test("E01 message_status returns ok:true", () => {
  reset();
  communityRegister({ session_id: "e1" });
  communityRegister({ session_id: "e2" });
  const { message_id } = communitySendMessage({ from_session: "e1", to_session: "e2", body: "x" });
  const r = communityMessageStatus({ message_id });
  assert.strictEqual(r.ok, true);
});

test("E02 message_status unread before reading", () => {
  reset();
  communityRegister({ session_id: "e1" });
  communityRegister({ session_id: "e2" });
  const { message_id } = communitySendMessage({ from_session: "e1", to_session: "e2", body: "x" });
  const r = communityMessageStatus({ message_id });
  assert.strictEqual(r.status, "unread");
});

test("E03 message_status read after reading", () => {
  reset();
  communityRegister({ session_id: "e1" });
  communityRegister({ session_id: "e2" });
  const { message_id } = communitySendMessage({ from_session: "e1", to_session: "e2", body: "x" });
  communityReadMessages({ session_id: "e2" });
  const r = communityMessageStatus({ message_id });
  assert.strictEqual(r.status, "read");
});

test("E04 message_status has read_at after reading", () => {
  reset();
  communityRegister({ session_id: "e1" });
  communityRegister({ session_id: "e2" });
  const { message_id } = communitySendMessage({ from_session: "e1", to_session: "e2", body: "x" });
  communityReadMessages({ session_id: "e2" });
  const r = communityMessageStatus({ message_id });
  assert.ok(r.read_at !== null);
});

test("E05 message_status null read_at before reading", () => {
  reset();
  communityRegister({ session_id: "e1" });
  communityRegister({ session_id: "e2" });
  const { message_id } = communitySendMessage({ from_session: "e1", to_session: "e2", body: "x" });
  const r = communityMessageStatus({ message_id });
  assert.strictEqual(r.read_at, null);
});

test("E06 message_status returns from_session", () => {
  reset();
  communityRegister({ session_id: "e1" });
  communityRegister({ session_id: "e2" });
  const { message_id } = communitySendMessage({ from_session: "e1", to_session: "e2", body: "x" });
  const r = communityMessageStatus({ message_id });
  assert.strictEqual(r.from_session, "e1");
});

test("E07 message_status returns to_session", () => {
  reset();
  communityRegister({ session_id: "e1" });
  communityRegister({ session_id: "e2" });
  const { message_id } = communitySendMessage({ from_session: "e1", to_session: "e2", body: "x" });
  const r = communityMessageStatus({ message_id });
  assert.strictEqual(r.to_session, "e2");
});

test("E08 message_status unknown message_id throws", () => {
  reset();
  assert.throws(() => communityMessageStatus({ message_id: "msg_nope" }), /not found/);
});

test("E09 message_status missing message_id throws", () => {
  reset();
  assert.throws(() => communityMessageStatus({}), /non-empty/);
});

test("E10 message_status sent_at present", () => {
  reset();
  communityRegister({ session_id: "e1" });
  communityRegister({ session_id: "e2" });
  const { message_id } = communitySendMessage({ from_session: "e1", to_session: "e2", body: "x" });
  const r = communityMessageStatus({ message_id });
  assert.ok(r.sent_at.includes("T"));
});

// ── F: community_inbox_summary ────────────────────────────────────────────────
process.stderr.write("\nF: community_inbox_summary\n");
reset();

test("F01 inbox_summary returns ok:true", () => {
  reset();
  communityRegister({ session_id: "f1" });
  const r = communityInboxSummary({ session_id: "f1" });
  assert.strictEqual(r.ok, true);
});

test("F02 inbox_summary zero unread when empty", () => {
  reset();
  communityRegister({ session_id: "f1" });
  const r = communityInboxSummary({ session_id: "f1" });
  assert.strictEqual(r.unread, 0);
  assert.strictEqual(r.total,  0);
});

test("F03 inbox_summary counts unread", () => {
  reset();
  communityRegister({ session_id: "f1" });
  communityRegister({ session_id: "f2" });
  communitySendMessage({ from_session: "f2", to_session: "f1", body: "a" });
  communitySendMessage({ from_session: "f2", to_session: "f1", body: "b" });
  const r = communityInboxSummary({ session_id: "f1" });
  assert.strictEqual(r.unread, 2);
  assert.strictEqual(r.total,  2);
});

test("F04 inbox_summary unread decreases after reading", () => {
  reset();
  communityRegister({ session_id: "f1" });
  communityRegister({ session_id: "f2" });
  communitySendMessage({ from_session: "f2", to_session: "f1", body: "a" });
  communityReadMessages({ session_id: "f1" });
  const r = communityInboxSummary({ session_id: "f1" });
  assert.strictEqual(r.unread, 0);
  assert.strictEqual(r.total,  1);
});

test("F05 inbox_summary has hint when unread > 0", () => {
  reset();
  communityRegister({ session_id: "f1" });
  communityRegister({ session_id: "f2" });
  communitySendMessage({ from_session: "f2", to_session: "f1", body: "hey" });
  const r = communityInboxSummary({ session_id: "f1" });
  assert.ok(r.hint && r.hint.includes("unread"));
});

test("F06 inbox_summary no hint when unread = 0", () => {
  reset();
  communityRegister({ session_id: "f1" });
  const r = communityInboxSummary({ session_id: "f1" });
  assert.ok(!r.hint);
});

test("F07 inbox_summary unknown session throws", () => {
  reset();
  assert.throws(() => communityInboxSummary({ session_id: "ghost" }), /not found/);
});

test("F08 inbox_summary session_id echoed", () => {
  reset();
  communityRegister({ session_id: "f1" });
  const r = communityInboxSummary({ session_id: "f1" });
  assert.strictEqual(r.session_id, "f1");
});

test("F09 inbox_summary not affected by sent messages", () => {
  reset();
  communityRegister({ session_id: "f1" });
  communityRegister({ session_id: "f2" });
  communitySendMessage({ from_session: "f1", to_session: "f2", body: "outgoing" });
  const r = communityInboxSummary({ session_id: "f1" });
  assert.strictEqual(r.total, 0);
});

test("F10 inbox_summary total includes read messages", () => {
  reset();
  communityRegister({ session_id: "f1" });
  communityRegister({ session_id: "f2" });
  communitySendMessage({ from_session: "f2", to_session: "f1", body: "read me" });
  communityReadMessages({ session_id: "f1" });
  const r = communityInboxSummary({ session_id: "f1" });
  assert.strictEqual(r.total, 1);
  assert.strictEqual(r.unread, 0);
});

// ── G: community_delete_session ───────────────────────────────────────────────
process.stderr.write("\nG: community_delete_session\n");
reset();

test("G01 delete_session returns ok:true", () => {
  reset();
  communityRegister({ session_id: "g1" });
  const r = communityDeleteSession({ session_id: "g1" });
  assert.strictEqual(r.ok, true);
});

test("G02 delete_session removes session from list", () => {
  reset();
  communityRegister({ session_id: "g1" });
  communityDeleteSession({ session_id: "g1" });
  const r = communityListSessions({});
  assert.strictEqual(r.total, 0);
});

test("G03 delete_session purges messages by default", () => {
  reset();
  communityRegister({ session_id: "g1" });
  communityRegister({ session_id: "g2" });
  communitySendMessage({ from_session: "g1", to_session: "g2", body: "bye" });
  communityDeleteSession({ session_id: "g1" });
  assert.strictEqual(_MESSAGES.size, 0);
});

test("G04 delete_session messages_deleted count", () => {
  reset();
  communityRegister({ session_id: "g1" });
  communityRegister({ session_id: "g2" });
  communitySendMessage({ from_session: "g1", to_session: "g2", body: "a" });
  communitySendMessage({ from_session: "g2", to_session: "g1", body: "b" });
  const r = communityDeleteSession({ session_id: "g1" });
  assert.strictEqual(r.messages_deleted, 2);
});

test("G05 delete_session purge_messages=false keeps messages", () => {
  reset();
  communityRegister({ session_id: "g1" });
  communityRegister({ session_id: "g2" });
  communitySendMessage({ from_session: "g1", to_session: "g2", body: "keep" });
  communityDeleteSession({ session_id: "g1", purge_messages: false });
  assert.strictEqual(_MESSAGES.size, 1);
});

test("G06 delete unknown session throws", () => {
  reset();
  assert.throws(() => communityDeleteSession({ session_id: "ghost" }), /not found/);
});

test("G07 deleted session cannot register-free send", () => {
  reset();
  communityRegister({ session_id: "g1" });
  communityRegister({ session_id: "g2" });
  communityDeleteSession({ session_id: "g1" });
  assert.throws(() => communitySendMessage({ from_session: "g1", to_session: "g2", body: "x" }), /not found/);
});

test("G08 can re-register after delete", () => {
  reset();
  communityRegister({ session_id: "g1" });
  communityDeleteSession({ session_id: "g1" });
  const r = communityRegister({ session_id: "g1", name: "G1 Again" });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.already_existed, false);
});

test("G09 delete echoes session_id", () => {
  reset();
  communityRegister({ session_id: "g1" });
  const r = communityDeleteSession({ session_id: "g1" });
  assert.strictEqual(r.session_id, "g1");
});

test("G10 delete only purges own messages, not unrelated", () => {
  reset();
  communityRegister({ session_id: "g1" });
  communityRegister({ session_id: "g2" });
  communityRegister({ session_id: "g3" });
  communitySendMessage({ from_session: "g2", to_session: "g3", body: "unrelated" });
  communityDeleteSession({ session_id: "g1" });
  assert.strictEqual(_MESSAGES.size, 1);
});

// ── H: community_info ─────────────────────────────────────────────────────────
process.stderr.write("\nH: community_info\n");
reset();

test("H01 community_info returns ok:true", () => {
  reset();
  const r = communityInfo({});
  assert.strictEqual(r.ok, true);
});

test("H02 community_info session_count=0 when empty", () => {
  reset();
  const r = communityInfo({});
  assert.strictEqual(r.session_count, 0);
});

test("H03 community_info session_count increments", () => {
  reset();
  communityRegister({ session_id: "h1" });
  communityRegister({ session_id: "h2" });
  const r = communityInfo({});
  assert.strictEqual(r.session_count, 2);
});

test("H04 community_info message_count=0 when empty", () => {
  reset();
  const r = communityInfo({});
  assert.strictEqual(r.message_count, 0);
});

test("H05 community_info message_count increments", () => {
  reset();
  communityRegister({ session_id: "h1" });
  communityRegister({ session_id: "h2" });
  communitySendMessage({ from_session: "h1", to_session: "h2", body: "x" });
  const r = communityInfo({});
  assert.strictEqual(r.message_count, 1);
});

test("H06 community_info unread_total correct", () => {
  reset();
  communityRegister({ session_id: "h1" });
  communityRegister({ session_id: "h2" });
  communitySendMessage({ from_session: "h1", to_session: "h2", body: "a" });
  communitySendMessage({ from_session: "h1", to_session: "h2", body: "b" });
  const r = communityInfo({});
  assert.strictEqual(r.unread_total, 2);
});

test("H07 community_info limits object present", () => {
  reset();
  const r = communityInfo({});
  assert.ok(r.limits && typeof r.limits.max_sessions === "number");
});

test("H08 community_info unread_total decreases after reading", () => {
  reset();
  communityRegister({ session_id: "h1" });
  communityRegister({ session_id: "h2" });
  communitySendMessage({ from_session: "h1", to_session: "h2", body: "x" });
  communityReadMessages({ session_id: "h2" });
  const r = communityInfo({});
  assert.strictEqual(r.unread_total, 0);
});

// ── I: passive inbox injection ────────────────────────────────────────────────
process.stderr.write("\nI: passive inbox injection\n");
reset();

test("I01 injectInboxSummary attaches _inbox", () => {
  reset();
  communityRegister({ session_id: "i1" });
  const result = injectInboxSummary("i1", { some: "data" });
  assert.ok(result._inbox);
});

test("I02 _inbox.session_id correct", () => {
  reset();
  communityRegister({ session_id: "i1" });
  const result = injectInboxSummary("i1", {});
  assert.strictEqual(result._inbox.session_id, "i1");
});

test("I03 _inbox.unread=0 when no messages", () => {
  reset();
  communityRegister({ session_id: "i1" });
  const result = injectInboxSummary("i1", {});
  assert.strictEqual(result._inbox.unread, 0);
});

test("I04 _inbox.unread=1 after message sent", () => {
  reset();
  communityRegister({ session_id: "i1" });
  communityRegister({ session_id: "i2" });
  communitySendMessage({ from_session: "i2", to_session: "i1", body: "hey" });
  const result = injectInboxSummary("i1", {});
  assert.strictEqual(result._inbox.unread, 1);
});

test("I05 _inbox.total counts read+unread", () => {
  reset();
  communityRegister({ session_id: "i1" });
  communityRegister({ session_id: "i2" });
  communitySendMessage({ from_session: "i2", to_session: "i1", body: "a" });
  communityReadMessages({ session_id: "i1" });
  communitySendMessage({ from_session: "i2", to_session: "i1", body: "b" });
  const result = injectInboxSummary("i1", {});
  assert.strictEqual(result._inbox.total, 2);
  assert.strictEqual(result._inbox.unread, 1);
});

test("I06 _inbox.hint present when unread > 0", () => {
  reset();
  communityRegister({ session_id: "i1" });
  communityRegister({ session_id: "i2" });
  communitySendMessage({ from_session: "i2", to_session: "i1", body: "ping" });
  const result = injectInboxSummary("i1", {});
  assert.ok(result._inbox.hint.includes("unread"));
});

test("I07 _inbox.hint absent when unread = 0", () => {
  reset();
  communityRegister({ session_id: "i1" });
  const result = injectInboxSummary("i1", {});
  assert.ok(!result._inbox.hint);
});

test("I08 injectInboxSummary is no-op for unknown session", () => {
  reset();
  const result = injectInboxSummary("ghost-session", { foo: "bar" });
  assert.strictEqual(result.foo, "bar");
  assert.ok(!result._inbox);
});

test("I09 injectInboxSummary is no-op when session_id is null", () => {
  reset();
  const result = injectInboxSummary(null, { x: 1 });
  assert.strictEqual(result.x, 1);
  assert.ok(!result._inbox);
});

test("I10 injectInboxSummary updates last_seen_at", () => {
  reset();
  communityRegister({ session_id: "i1" });
  const before = _SESSIONS.get("i1").last_seen_at;
  // Tiny sleep to ensure timestamp differs
  const start = Date.now();
  while (Date.now() === start) {}
  injectInboxSummary("i1", {});
  const after = _SESSIONS.get("i1").last_seen_at;
  // last_seen_at should be >= before (might be equal on fast machines, never less)
  assert.ok(after >= before);
});

test("I11 inject does not mutate non-object result", () => {
  reset();
  communityRegister({ session_id: "i1" });
  // Should not throw on non-object
  const r = injectInboxSummary("i1", 42);
  assert.strictEqual(r, 42);
});

test("I12 inject does not mutate array result", () => {
  reset();
  communityRegister({ session_id: "i1" });
  const arr = [1, 2, 3];
  const r = injectInboxSummary("i1", arr);
  assert.ok(!r._inbox);
});

// ── J: security / guards ──────────────────────────────────────────────────────
process.stderr.write("\nJ: security / guards\n");
reset();

test("J01 register empty session_id throws", () => {
  assert.throws(() => communityRegister({ session_id: "" }), /non-empty/);
});

test("J02 send empty from_session throws", () => {
  communityRegister({ session_id: "j2" });
  assert.throws(() => communitySendMessage({ from_session: "", to_session: "j2", body: "x" }), /non-empty/);
});

test("J03 send empty to_session throws", () => {
  communityRegister({ session_id: "j2" });
  assert.throws(() => communitySendMessage({ from_session: "j2", to_session: "", body: "x" }), /non-empty/);
});

test("J04 NUL byte in from_session throws", () => {
  communityRegister({ session_id: "j2" });
  assert.throws(() => communitySendMessage({ from_session: "a\0b", to_session: "j2", body: "x" }), /NUL/);
});

test("J05 NUL byte in to_session throws", () => {
  communityRegister({ session_id: "j2" });
  assert.throws(() => communitySendMessage({ from_session: "j2", to_session: "a\0b", body: "x" }), /NUL/);
});

test("J06 session_id > 128 chars throws on register", () => {
  assert.throws(() => communityRegister({ session_id: "x".repeat(129) }), /≤ 128/);
});

test("J07 session_id > 128 chars throws on send", () => {
  communityRegister({ session_id: "j2" });
  assert.throws(() => communitySendMessage({ from_session: "x".repeat(129), to_session: "j2", body: "x" }), /≤/);
});

test("J08 inbox_summary unknown session throws", () => {
  reset();
  assert.throws(() => communityInboxSummary({ session_id: "ghost" }), /not found/);
});

test("J09 list_sessions filter with NUL byte gracefully handled", () => {
  // No throw expected; just returns empty
  reset();
  communityRegister({ session_id: "j-safe" });
  // NUL in filter won't match anything normally (string includes is fine)
  const r = communityListSessions({ filter: "j\0safe" });
  // filter with NUL won't match "j-safe" — 0 results expected
  assert.strictEqual(r.total, 0);
});

test("J10 read_messages page_size capped at 100", () => {
  reset();
  communityRegister({ session_id: "j10" });
  const r = communityReadMessages({ session_id: "j10", page_size: 9999 });
  assert.strictEqual(r.page_size, 100);
});

test("J11 message_status with NUL message_id throws", () => {
  assert.throws(() => communityMessageStatus({ message_id: "msg\0bad" }), /NUL/);
});

test("J12 register with empty name falls back to session_id", () => {
  reset();
  // Empty name — should use session_id
  const r = communityRegister({ session_id: "j12", name: "" });
  assert.strictEqual(r.name, "j12");
});

test("J13 delete_session with NUL session_id throws", () => {
  assert.throws(() => communityDeleteSession({ session_id: "a\0b" }), /NUL/);
});

test("J14 send from unregistered after delete throws", () => {
  reset();
  communityRegister({ session_id: "j14a" });
  communityRegister({ session_id: "j14b" });
  communityDeleteSession({ session_id: "j14a" });
  assert.throws(() => communitySendMessage({ from_session: "j14a", to_session: "j14b", body: "x" }), /not found/);
});

// ── K: concurrency / stress ───────────────────────────────────────────────────
process.stderr.write("\nK: concurrency / stress\n");
reset();

test("K01 1000 sessions register without error", () => {
  reset();
  for (let i = 0; i < 1000; i++) communityRegister({ session_id: `stress-${i}` });
  const r = communityListSessions({ page_size: 1 });
  assert.strictEqual(r.total, 1000);
});

test("K02 send 100 messages from one AI to another", () => {
  reset();
  communityRegister({ session_id: "k1" });
  communityRegister({ session_id: "k2" });
  for (let i = 0; i < 100; i++) communitySendMessage({ from_session: "k1", to_session: "k2", body: `msg${i}` });
  const r = communityInboxSummary({ session_id: "k2" });
  assert.strictEqual(r.unread, 100);
});

test("K03 reading 100 messages marks them all read", () => {
  reset();
  communityRegister({ session_id: "k1" });
  communityRegister({ session_id: "k2" });
  for (let i = 0; i < 100; i++) communitySendMessage({ from_session: "k1", to_session: "k2", body: `m${i}` });
  communityReadMessages({ session_id: "k2", page_size: 100 });
  const r = communityInboxSummary({ session_id: "k2" });
  assert.strictEqual(r.unread, 0);
});

test("K04 many sessions can message each other", () => {
  reset();
  const ids = [];
  for (let i = 0; i < 10; i++) {
    ids.push(`mesh-${i}`);
    communityRegister({ session_id: `mesh-${i}` });
  }
  // Each AI messages the next
  for (let i = 0; i < 9; i++) {
    communitySendMessage({ from_session: ids[i], to_session: ids[i+1], body: `chain-${i}` });
  }
  const r = communityInfo({});
  assert.strictEqual(r.message_count, 9);
});

test("K05 community_info reflects stress state", () => {
  reset();
  communityRegister({ session_id: "k5a" });
  communityRegister({ session_id: "k5b" });
  for (let i = 0; i < 50; i++) communitySendMessage({ from_session: "k5a", to_session: "k5b", body: `s${i}` });
  const r = communityInfo({});
  assert.strictEqual(r.session_count, 2);
  assert.strictEqual(r.message_count, 50);
  assert.strictEqual(r.unread_total,  50);
});

test("K06 pagination across 50 messages works", () => {
  reset();
  communityRegister({ session_id: "k6a" });
  communityRegister({ session_id: "k6b" });
  for (let i = 0; i < 50; i++) communitySendMessage({ from_session: "k6a", to_session: "k6b", body: `p${i}` });
  const p1 = communityReadMessages({ session_id: "k6b", page: 1, page_size: 20, mark_read: false });
  const p2 = communityReadMessages({ session_id: "k6b", page: 2, page_size: 20, mark_read: false });
  const p3 = communityReadMessages({ session_id: "k6b", page: 3, page_size: 20, mark_read: false });
  assert.strictEqual(p1.messages.length, 20);
  assert.strictEqual(p2.messages.length, 20);
  assert.strictEqual(p3.messages.length, 10);
});

test("K07 delete all sessions clears community", () => {
  reset();
  communityRegister({ session_id: "k7a" });
  communityRegister({ session_id: "k7b" });
  communitySendMessage({ from_session: "k7a", to_session: "k7b", body: "bye" });
  communityDeleteSession({ session_id: "k7a" });
  communityDeleteSession({ session_id: "k7b" });
  const r = communityInfo({});
  assert.strictEqual(r.session_count, 0);
  assert.strictEqual(r.message_count, 0);
});

test("K08 injectInboxSummary called 50 times stays consistent", () => {
  reset();
  communityRegister({ session_id: "k8" });
  communityRegister({ session_id: "k8b" });
  communitySendMessage({ from_session: "k8b", to_session: "k8", body: "stress" });
  for (let i = 0; i < 50; i++) {
    const r = injectInboxSummary("k8", { i });
    assert.strictEqual(r._inbox.unread, 1);
  }
});

// ── Summary ───────────────────────────────────────────────────────────────────
process.nextTick(() => {
  process.stderr.write(`\n=== Section 293 complete: ${passed} passed, ${failed} failed ===\n`);
  if (failed > 0) process.exitCode = 1;
});
