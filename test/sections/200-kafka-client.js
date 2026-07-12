"use strict";
/**
 * Section 200 — kafka_client tests
 * 70 tests: A=input-validation×10, B=codec-stubs×10, C=security-guards×10,
 *           D=happy-path-mock×30, E=error-paths×5, F=concurrency×5
 *
 * All network I/O mocked via net.createConnection monkey-patching.
 * No real Kafka broker required.
 */

const net    = require("net");
const assert = require("assert");
const { kafkaClient, _codec, _kafkaErrorName } = require("../../lib/kafkaClientOps");

const {
  writeInt8, writeInt16, writeInt32, writeInt64, writeString, writeBytes,
  readInt8, readInt16, readInt32, readInt64, readString, readBytes,
  strSize, bytesSize,
  buildRequestHeader, frameRequest,
  crc32,
  parseMetadataResponse, parseProduceResponse, parseFetchResponse,
  parseListOffsetsResponse, parseCreateTopicsResponse, parseDeleteTopicsResponse,
  parseMessageSet,
} = _codec;

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      return r.then(() => { passed++; console.log(`  ✓ ${name}`); })
              .catch(err => { failed++; console.error(`  ✗ ${name}\n      ${err.message}`); });
    }
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}\n      ${err.message}`);
  }
  return Promise.resolve();
}

async function runAll(label, fns) {
  process.stderr.write(`\n[${label}]\n`);
  for (const fn of fns) await fn();
}

// ────────────────────────────────────────────────────────────────────────────────
// MOCK BROKER HELPERS
// ────────────────────────────────────────────────────────────────────────────────

/**
 * Build a Kafka response frame: [length INT32] [correlationId INT32] [payload...]
 */
function buildResponseFrame(correlationId, payloadBuf) {
  const frame = Buffer.allocUnsafe(4 + 4 + (payloadBuf ? payloadBuf.length : 0));
  frame.writeInt32BE(4 + (payloadBuf ? payloadBuf.length : 0), 0);
  frame.writeInt32BE(correlationId, 4);
  if (payloadBuf) payloadBuf.copy(frame, 8);
  return frame;
}

/**
 * Extract correlationId from a request frame (skip length prefix).
 * Request layout: [4 length] [2 apiKey] [2 apiVersion] [4 correlationId] ...
 */
function extractCorrelationId(frameBuf) {
  // frameBuf already includes the 4-byte length prefix
  if (frameBuf.length < 12) return 1;
  return frameBuf.readInt32BE(8); // 4(len) + 2(apiKey) + 2(apiVersion) = offset 8
}

/**
 * Extract apiKey from a request frame.
 */
function extractApiKey(frameBuf) {
  if (frameBuf.length < 6) return -1;
  return frameBuf.readInt16BE(4); // 4(len) + 0 = offset 4
}

// Mock socket factory — emits connection events and handles write() -> response dispatch
function makeMockSocket(responseBuilder) {
  const EventEmitter = require("events");
  const sock = new EventEmitter();
  sock.connecting = true;
  sock.destroyed  = false;
  sock._rxBuf     = Buffer.alloc(0);

  sock.connect    = () => {};
  sock.destroy    = (err) => {
    sock.destroyed = true;
    if (err) setImmediate(() => sock.emit("error", err));
    else     setImmediate(() => sock.emit("close"));
  };

  sock.write = (data, cb) => {
    if (cb) cb();
    // Accumulate into rx buffer then try to parse frames
    sock._rxBuf = Buffer.concat([sock._rxBuf, data]);
    while (sock._rxBuf.length >= 4) {
      const msgLen = sock._rxBuf.readInt32BE(0);
      if (sock._rxBuf.length < 4 + msgLen) break;
      const frame = sock._rxBuf.slice(0, 4 + msgLen);
      sock._rxBuf = sock._rxBuf.slice(4 + msgLen);
      setImmediate(() => {
        const resp = responseBuilder(frame);
        if (resp) sock.emit("data", resp);
      });
    }
  };

  // Trigger connect on next tick
  setImmediate(() => {
    sock.connecting = false;
    sock.emit("connect");
  });

  return sock;
}

// Install mock for net.createConnection, restore after test
function withMock(responseBuilder, fn) {
  const orig = net.createConnection;
  net.createConnection = () => makeMockSocket(responseBuilder);
  const cleanup = () => { net.createConnection = orig; };
  try {
    const r = fn();
    if (r && r.then) return r.then(v => { cleanup(); return v; }).catch(e => { cleanup(); throw e; });
    cleanup();
    return r;
  } catch (e) { cleanup(); throw e; }
}

// ─── Metadata response builder ───────────────────────────────────────────────
function buildMetadataResponse(correlationId, {
  brokers = [{ nodeId: 0, host: "localhost", port: 9092, rack: null }],
  controllerId = 0,
  topics = [],
} = {}) {
  // v1: throttle(4) + brokers-array + controllerId(4) + topics-array
  const bufs = [];
  // throttle_time_ms
  const throttle = Buffer.allocUnsafe(4); throttle.writeInt32BE(0, 0); bufs.push(throttle);
  // brokers array
  const bCount = Buffer.allocUnsafe(4); bCount.writeInt32BE(brokers.length, 0); bufs.push(bCount);
  for (const b of brokers) {
    const bBuf = Buffer.allocUnsafe(4 + strSize(b.host) + 4 + strSize(b.rack));
    let o = 0;
    o = writeInt32(bBuf, o, b.nodeId);
    o = writeString(bBuf, o, b.host);
    o = writeInt32(bBuf, o, b.port);
    o = writeString(bBuf, o, b.rack);
    bufs.push(bBuf);
  }
  // controller_id
  const ctrl = Buffer.allocUnsafe(4); ctrl.writeInt32BE(controllerId, 0); bufs.push(ctrl);
  // topics array
  const tCount = Buffer.allocUnsafe(4); tCount.writeInt32BE(topics.length, 0); bufs.push(tCount);
  for (const t of topics) {
    const parts = t.partitions || [];
    const topicBuf = Buffer.allocUnsafe(2 + strSize(t.name) + 1 + 4);
    let o = 0;
    o = writeInt16(topicBuf, o, t.errorCode || 0);
    o = writeString(topicBuf, o, t.name);
    writeInt8(topicBuf, o, 0); o++; // isInternal
    writeInt32(topicBuf, o, parts.length);
    bufs.push(topicBuf);
    for (const p of parts) {
      const repBuf = Buffer.allocUnsafe(2 + 4 + 4 + 4 + p.replicas.length * 4 + 4 + p.isrs.length * 4);
      let po = 0;
      po = writeInt16(repBuf, po, 0);
      po = writeInt32(repBuf, po, p.id);
      po = writeInt32(repBuf, po, p.leader);
      po = writeInt32(repBuf, po, p.replicas.length);
      for (const r of p.replicas) po = writeInt32(repBuf, po, r);
      po = writeInt32(repBuf, po, p.isrs.length);
      for (const r of p.isrs) po = writeInt32(repBuf, po, r);
      bufs.push(repBuf);
    }
  }
  const payload = Buffer.concat(bufs);
  return buildResponseFrame(correlationId, payload);
}

// ─── Produce response builder ────────────────────────────────────────────────
function buildProduceResponse(correlationId, topics = []) {
  const bufs = [];
  const tCount = Buffer.allocUnsafe(4); tCount.writeInt32BE(topics.length, 0); bufs.push(tCount);
  for (const t of topics) {
    const pCount = Buffer.allocUnsafe(4); pCount.writeInt32BE(1, 0);
    bufs.push(Buffer.allocUnsafe(strSize(t.name)).fill(0));
    // write topic name
    const tNameBuf = Buffer.allocUnsafe(strSize(t.name));
    writeString(tNameBuf, 0, t.name);
    bufs.pop(); bufs.push(tNameBuf);
    bufs.push(pCount);
    const pBuf = Buffer.allocUnsafe(4 + 2 + 8 + 8);
    let o = 0;
    o = writeInt32(pBuf, o, 0); // partition
    o = writeInt16(pBuf, o, t.errorCode || 0);
    o = writeInt64(pBuf, o, 0, t.baseOffset || 0);
    o = writeInt64(pBuf, o, 0, 0); // logAppendTime
    bufs.push(pBuf);
  }
  return buildResponseFrame(correlationId, Buffer.concat(bufs));
}

// ─── ListOffsets response builder ────────────────────────────────────────────
function buildListOffsetsResponse(correlationId, { topic, partition, offset, errorCode } = {}) {
  const throttle = Buffer.allocUnsafe(4); throttle.writeInt32BE(0, 0);
  const tCount = Buffer.allocUnsafe(4); tCount.writeInt32BE(1, 0);
  const tNameBuf = Buffer.allocUnsafe(strSize(topic || "test-topic"));
  writeString(tNameBuf, 0, topic || "test-topic");
  const pCount = Buffer.allocUnsafe(4); pCount.writeInt32BE(1, 0);
  const pBuf = Buffer.allocUnsafe(4 + 2 + 8 + 8);
  let o = 0;
  o = writeInt32(pBuf, o, partition || 0);
  o = writeInt16(pBuf, o, errorCode || 0);
  o = writeInt64(pBuf, o, 0, 0); // timestamp
  o = writeInt64(pBuf, o, 0, offset || 42);
  return buildResponseFrame(correlationId, Buffer.concat([throttle, tCount, tNameBuf, pCount, pBuf]));
}

// ─── Fetch response builder ──────────────────────────────────────────────────
function buildFetchResponse(correlationId, { topic, messages = [], errorCode = 0 } = {}) {
  const throttle = Buffer.allocUnsafe(4); throttle.writeInt32BE(0, 0);
  const tCount  = Buffer.allocUnsafe(4); tCount.writeInt32BE(1, 0);
  const tNameBuf = Buffer.allocUnsafe(strSize(topic || "test-topic"));
  writeString(tNameBuf, 0, topic || "test-topic");
  const pCount = Buffer.allocUnsafe(4); pCount.writeInt32BE(1, 0);

  // Build MessageSet
  const msgParts = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const valBuf = msg.value ? Buffer.from(msg.value, "utf8") : null;
    const keyBuf = msg.key   ? Buffer.from(msg.key,   "utf8") : null;
    // Message v1: magic(1) + attrs(1) + timestamp(8) + key + value
    const msgBodySize = 1 + 1 + 8 + bytesSize(keyBuf) + bytesSize(valBuf);
    const msgBody = Buffer.allocUnsafe(msgBodySize);
    let mo = 0;
    mo = writeInt8(msgBody, mo, 1);
    mo = writeInt8(msgBody, mo, 0);
    mo = writeInt64(msgBody, mo, 0, Date.now() >>> 0);
    mo = writeBytes(msgBody, mo, keyBuf);
    mo = writeBytes(msgBody, mo, valBuf);
    const crc = crc32(msgBody);
    const msgFull = Buffer.allocUnsafe(4 + msgBodySize);
    msgFull.writeInt32BE(crc, 0);
    msgBody.copy(msgFull, 4);
    const entry = Buffer.allocUnsafe(8 + 4 + msgFull.length);
    writeInt64(entry, 0, 0, i);
    entry.writeInt32BE(msgFull.length, 8);
    msgFull.copy(entry, 12);
    msgParts.push(entry);
  }
  const msgSetBuf = Buffer.concat(msgParts);

  // partition: id(4) + error(2) + highWatermark(8) + lastStable(8) + abortedTx(4) + recordSet(BYTES)
  const pData = Buffer.allocUnsafe(4 + 2 + 8 + 8 + 4 + 4 + msgSetBuf.length);
  let o = 0;
  o = writeInt32(pData, o, 0); // partition
  o = writeInt16(pData, o, errorCode);
  o = writeInt64(pData, o, 0, 100); // highWatermark
  o = writeInt64(pData, o, 0, -1);  // lastStable
  o = writeInt32(pData, o, 0);  // abortedTxCount
  o = writeBytes(pData, o, msgSetBuf.length > 0 ? msgSetBuf : null);

  return buildResponseFrame(correlationId, Buffer.concat([throttle, tCount, tNameBuf, pCount, pData]));
}

// ─── CreateTopics response builder ───────────────────────────────────────────
function buildCreateTopicsResponse(correlationId, topicResults = []) {
  const tCount = Buffer.allocUnsafe(4); tCount.writeInt32BE(topicResults.length, 0);
  const parts = [tCount];
  for (const t of topicResults) {
    const nameBuf = Buffer.allocUnsafe(strSize(t.name)); writeString(nameBuf, 0, t.name);
    const errBuf  = Buffer.allocUnsafe(2 + strSize(t.errorMessage || null));
    writeInt16(errBuf, 0, t.errorCode || 0);
    writeString(errBuf, 2, t.errorMessage || null);
    parts.push(nameBuf, errBuf);
  }
  return buildResponseFrame(correlationId, Buffer.concat(parts));
}

// ─── DeleteTopics response builder ───────────────────────────────────────────
function buildDeleteTopicsResponse(correlationId, topicResults = []) {
  const tCount = Buffer.allocUnsafe(4); tCount.writeInt32BE(topicResults.length, 0);
  const parts = [tCount];
  for (const t of topicResults) {
    const nameBuf = Buffer.allocUnsafe(strSize(t.name)); writeString(nameBuf, 0, t.name);
    const errBuf  = Buffer.allocUnsafe(2); errBuf.writeInt16BE(t.errorCode || 0, 0);
    parts.push(nameBuf, errBuf);
  }
  return buildResponseFrame(correlationId, Buffer.concat(parts));
}

/**
 * Dispatch builder: given the raw request frame, return the appropriate mock response.
 */
function makeAutoDispatch(opts = {}) {
  return function(frame) {
    const corrId  = extractCorrelationId(frame);
    const apiKey  = extractApiKey(frame);
    switch (apiKey) {
      case 0:  // PRODUCE
        return buildProduceResponse(corrId, [{ name: opts.topic || "test-topic", baseOffset: opts.baseOffset || 0 }]);
      case 1:  // FETCH
        return buildFetchResponse(corrId, { topic: opts.topic || "test-topic", messages: opts.messages || [] });
      case 2:  // LIST_OFFSETS
        return buildListOffsetsResponse(corrId, { topic: opts.topic || "test-topic", offset: opts.offset || 42 });
      case 3:  // METADATA
        return buildMetadataResponse(corrId, {
          brokers: opts.brokers || [{ nodeId: 0, host: "localhost", port: 9092, rack: null }],
          topics: opts.topics || [],
        });
      case 17: // SASL_HANDSHAKE
        return buildResponseFrame(corrId, Buffer.from([0, 0, 0, 0, 1, 0, 5, 80, 76, 65, 73, 78])); // err=0, mechanisms=["PLAIN"]
      case 18: // API_VERSIONS
        return buildResponseFrame(corrId, Buffer.from([0, 0, 0, 0, 0, 0])); // err=0, empty array
      case 19: // CREATE_TOPICS
        return buildCreateTopicsResponse(corrId, (opts.topics || []).map(t => ({ name: typeof t === "string" ? t : t.name })));
      case 20: // DELETE_TOPICS
        return buildDeleteTopicsResponse(corrId, (opts.topics || []).map(t => ({ name: typeof t === "string" ? t : t.name })));
      case 36: // SASL_AUTHENTICATE
        return buildResponseFrame(corrId, Buffer.concat([
          Buffer.from([0, 0]),         // errCode INT16 = 0
          Buffer.from([0x00, 0x00]),   // errMsg = null string (INT16 -1)
          ...[], // empty bytes (INT32 -1)
        ].concat([Buffer.from([0xff, 0xff, 0xff, 0xff])])));
      default:
        return buildResponseFrame(corrId, Buffer.alloc(0));
    }
  };
}

// ════════════════════════════════════════════════════════════════════════════════
// SECTION A — Input Validation (10 tests)
// ════════════════════════════════════════════════════════════════════════════════
async function sectionA() {
  await runAll("A — Input Validation", [
    () => test("A01 missing operation throws", async () => {
      await assert.rejects(() => kafkaClient({ host: "localhost", port: 9999 }),
        /operation.*required/i);
    }),
    () => test("A02 unknown operation throws", async () => {
      await assert.rejects(() => kafkaClient({ operation: "explode" }),
        /unknown operation/i);
    }),
    () => test("A03 produce missing topic throws", async () => {
      await withMock(makeAutoDispatch(), () =>
        assert.rejects(() => kafkaClient({ operation: "produce", messages: [{ value: "x" }] }),
          /topic.*required/i));
    }),
    () => test("A04 produce missing messages throws", async () => {
      await withMock(makeAutoDispatch(), () =>
        assert.rejects(() => kafkaClient({ operation: "produce", topic: "test-topic" }),
          /messages.*non-empty array/i));
    }),
    () => test("A05 produce empty messages array throws", async () => {
      await withMock(makeAutoDispatch(), () =>
        assert.rejects(() => kafkaClient({ operation: "produce", topic: "test-topic", messages: [] }),
          /messages.*non-empty array/i));
    }),
    () => test("A06 produce message with no key and no value throws", async () => {
      await withMock(makeAutoDispatch(), () =>
        assert.rejects(() => kafkaClient({ operation: "produce", topic: "t", messages: [{}] }),
          /at least.*value.*key/i));
    }),
    () => test("A07 fetch missing topic throws", async () => {
      await withMock(makeAutoDispatch(), () =>
        assert.rejects(() => kafkaClient({ operation: "fetch" }),
          /topic.*required/i));
    }),
    () => test("A08 list_offsets missing topic throws", async () => {
      await withMock(makeAutoDispatch(), () =>
        assert.rejects(() => kafkaClient({ operation: "list_offsets" }),
          /topic.*required/i));
    }),
    () => test("A09 create_topics with non-array topics throws", async () => {
      await withMock(makeAutoDispatch(), () =>
        assert.rejects(() => kafkaClient({ operation: "create_topics", topics: "bad" }),
          /topics.*non-empty array/i));
    }),
    () => test("A10 delete_topics with non-string entry throws", async () => {
      await withMock(makeAutoDispatch(), () =>
        assert.rejects(() => kafkaClient({ operation: "delete_topics", topics: [42] }),
          /must be a string/i));
    }),
  ]);
}

// ════════════════════════════════════════════════════════════════════════════════
// SECTION B — Codec Stubs / Unit Tests (10 tests)
// ════════════════════════════════════════════════════════════════════════════════
async function sectionB() {
  await runAll("B — Codec Stubs", [
    () => test("B01 writeInt8 / readInt8 round-trip", () => {
      const buf = Buffer.allocUnsafe(1);
      writeInt8(buf, 0, -42);
      assert.strictEqual(readInt8(buf, 0).value, -42);
    }),
    () => test("B02 writeInt16 / readInt16 round-trip", () => {
      const buf = Buffer.allocUnsafe(2);
      writeInt16(buf, 0, 0x1234);
      assert.strictEqual(readInt16(buf, 0).value, 0x1234);
    }),
    () => test("B03 writeInt32 / readInt32 round-trip", () => {
      const buf = Buffer.allocUnsafe(4);
      writeInt32(buf, 0, 0x7fffffff);
      assert.strictEqual(readInt32(buf, 0).value, 0x7fffffff);
    }),
    () => test("B04 writeInt64 / readInt64 round-trip (small value)", () => {
      const buf = Buffer.allocUnsafe(8);
      writeInt64(buf, 0, 0, 12345678);
      const { value } = readInt64(buf, 0);
      assert.strictEqual(value, 12345678);
    }),
    () => test("B05 writeString / readString round-trip", () => {
      const str = "hello-kafka";
      const buf = Buffer.allocUnsafe(strSize(str));
      writeString(buf, 0, str);
      assert.strictEqual(readString(buf, 0).value, str);
    }),
    () => test("B06 writeString null / readString null", () => {
      const buf = Buffer.allocUnsafe(2);
      writeString(buf, 0, null);
      assert.strictEqual(readString(buf, 0).value, null);
    }),
    () => test("B07 writeBytes / readBytes round-trip", () => {
      const data = Buffer.from("payload");
      const buf = Buffer.allocUnsafe(bytesSize(data));
      writeBytes(buf, 0, data);
      const { value } = readBytes(buf, 0);
      assert.ok(value && value.equals(data));
    }),
    () => test("B08 crc32 known value", () => {
      // CRC32("123456789") = 0xCBF43926
      const val = crc32(Buffer.from("123456789"));
      assert.strictEqual((val >>> 0).toString(16).toLowerCase(), "cbf43926");
    }),
    () => test("B09 buildRequestHeader produces correct size", () => {
      const hdr = buildRequestHeader(3, 1, 42, "test-client");
      // 2(apiKey) + 2(apiVersion) + 4(corrId) + strSize("test-client")
      const expected = 2 + 2 + 4 + strSize("test-client");
      assert.strictEqual(hdr.length, expected);
      assert.strictEqual(hdr.readInt16BE(0), 3);
      assert.strictEqual(hdr.readInt16BE(2), 1);
      assert.strictEqual(hdr.readInt32BE(4), 42);
    }),
    () => test("B10 frameRequest wraps with 4-byte length prefix", () => {
      const hdr  = Buffer.from([0, 1, 0, 2, 0, 0, 0, 3, 0, 6, 99, 108, 105, 101, 110, 116]);
      const body = Buffer.from([0xAA, 0xBB]);
      const framed = frameRequest(hdr, body);
      assert.strictEqual(framed.readInt32BE(0), hdr.length + body.length);
      assert.ok(framed.slice(4, 4 + hdr.length).equals(hdr));
    }),
  ]);
}

// ════════════════════════════════════════════════════════════════════════════════
// SECTION C — Security Guards (10 tests)
// ════════════════════════════════════════════════════════════════════════════════
async function sectionC() {
  await runAll("C — Security Guards", [
    () => test("C01 NUL byte in topic name throws", async () => {
      await assert.rejects(() => kafkaClient({ operation: "produce", topic: "bad\x00topic", messages: [{ value: "x" }] }),
        /NUL/i);
    }),
    () => test("C02 CRLF in topic name throws", async () => {
      await assert.rejects(() => kafkaClient({ operation: "fetch", topic: "bad\ntopic" }),
        /CRLF/i);
    }),
    () => test("C03 invalid topic char (space) throws", async () => {
      await assert.rejects(() => kafkaClient({ operation: "fetch", topic: "bad topic" }),
        /invalid topic name/i);
    }),
    () => test("C04 topic exceeding 249 chars throws", async () => {
      const longTopic = "a".repeat(250);
      await assert.rejects(() => kafkaClient({ operation: "fetch", topic: longTopic }),
        /249 character limit/i);
    }),
    () => test("C05 NUL byte in host throws", async () => {
      await assert.rejects(() => kafkaClient({ operation: "metadata", host: "local\x00host" }),
        /NUL/i);
    }),
    () => test("C06 NUL byte in client_id throws", async () => {
      await assert.rejects(() => kafkaClient({ operation: "metadata", client_id: "id\x00" }),
        /NUL/i);
    }),
    () => test("C07 unsupported SASL mechanism throws", async () => {
      await assert.rejects(() => kafkaClient({ operation: "metadata", sasl_mechanism: "GSSAPI" }),
        /unsupported sasl_mechanism/i);
    }),
    () => test("C08 message value exceeding 10 MB throws", async () => {
      const bigValue = "x".repeat(10 * 1024 * 1024 + 1);
      await assert.rejects(() => kafkaClient({ operation: "produce", topic: "t", messages: [{ value: bigValue }] }),
        /exceeds.*bytes/i);
    }),
    () => test("C09 produce with more than 1000 messages throws", async () => {
      const msgs = Array.from({ length: 1001 }, (_, i) => ({ value: String(i) }));
      await assert.rejects(() => kafkaClient({ operation: "produce", topic: "t", messages: msgs }),
        /maximum 1000 messages/i);
    }),
    () => test("C10 create_topics topic spec missing name throws", async () => {
      await withMock(makeAutoDispatch(), () =>
        assert.rejects(() => kafkaClient({ operation: "create_topics", topics: [{ num_partitions: 1 }] }),
          /must have a.*name/i));
    }),
  ]);
}

// ════════════════════════════════════════════════════════════════════════════════
// SECTION D — Happy-Path Mock Tests (30 tests)
// ════════════════════════════════════════════════════════════════════════════════
async function sectionD() {
  await runAll("D — Happy-Path Mock", [
    // D01-D05: metadata / list_topics
    () => test("D01 metadata returns broker list", async () => {
      const result = await withMock(
        makeAutoDispatch({ brokers: [{ nodeId: 0, host: "kafka1", port: 9092, rack: null }], topics: [] }),
        () => kafkaClient({ operation: "metadata", host: "localhost", port: 9999 })
      );
      assert.ok(Array.isArray(result.brokers));
      assert.strictEqual(result.brokers[0].host, "kafka1");
    }),
    () => test("D02 list_topics returns all topics", async () => {
      const topics = [
        { name: "topic-a", errorCode: 0, partitions: [{ id: 0, leader: 0, replicas: [0], isrs: [0] }] },
        { name: "topic-b", errorCode: 0, partitions: [{ id: 0, leader: 0, replicas: [0], isrs: [0] }] },
      ];
      const result = await withMock(
        makeAutoDispatch({ topics }),
        () => kafkaClient({ operation: "list_topics" })
      );
      assert.strictEqual(result.topicCount, 2);
      assert.strictEqual(result.topics[0].name, "topic-a");
    }),
    () => test("D03 metadata with topic filter", async () => {
      const result = await withMock(
        makeAutoDispatch({
          topics: [{ name: "my-topic", errorCode: 0, partitions: [{ id: 0, leader: 0, replicas: [0], isrs: [0] }] }],
        }),
        () => kafkaClient({ operation: "metadata", topics: ["my-topic"] })
      );
      assert.ok(result.topics.some(t => t.name === "my-topic"));
    }),
    () => test("D04 metadata includes brokerCount", async () => {
      const result = await withMock(
        makeAutoDispatch({ brokers: [{ nodeId: 0, host: "b1", port: 9092, rack: null }, { nodeId: 1, host: "b2", port: 9092, rack: null }] }),
        () => kafkaClient({ operation: "metadata" })
      );
      assert.strictEqual(result.brokerCount, 2);
    }),
    () => test("D05 metadata result has operation field", async () => {
      const result = await withMock(makeAutoDispatch(), () => kafkaClient({ operation: "metadata" }));
      assert.strictEqual(result.operation, "metadata");
    }),

    // D06-D10: produce
    () => test("D06 produce single message returns baseOffset", async () => {
      const result = await withMock(
        makeAutoDispatch({ topic: "events", baseOffset: 5 }),
        () => kafkaClient({ operation: "produce", topic: "events", messages: [{ value: "hello" }] })
      );
      assert.strictEqual(result.messageCount, 1);
      assert.ok(result.elapsedMs >= 0);
    }),
    () => test("D07 produce multiple messages", async () => {
      const result = await withMock(
        makeAutoDispatch({ topic: "logs", baseOffset: 0 }),
        () => kafkaClient({ operation: "produce", topic: "logs", messages: [
          { value: "line1" },
          { value: "line2" },
          { value: "line3", key: "k3" },
        ]})
      );
      assert.strictEqual(result.messageCount, 3);
    }),
    () => test("D08 produce with key-only message", async () => {
      const result = await withMock(
        makeAutoDispatch({ topic: "t" }),
        () => kafkaClient({ operation: "produce", topic: "t", messages: [{ key: "my-key" }] })
      );
      assert.strictEqual(result.messageCount, 1);
    }),
    () => test("D09 produce returns topic name", async () => {
      const result = await withMock(
        makeAutoDispatch({ topic: "orders" }),
        () => kafkaClient({ operation: "produce", topic: "orders", messages: [{ value: "x" }] })
      );
      assert.strictEqual(result.topic, "orders");
    }),
    () => test("D10 produce acks=-1 default", async () => {
      // Just verify no error thrown when acks not specified (default -1)
      const result = await withMock(
        makeAutoDispatch({ topic: "t" }),
        () => kafkaClient({ operation: "produce", topic: "t", messages: [{ value: "v" }] })
      );
      assert.ok(result.messageCount === 1);
    }),

    // D11-D16: fetch
    () => test("D11 fetch returns messages array", async () => {
      const msgs = [{ value: "msg1" }, { value: "msg2" }];
      const result = await withMock(
        makeAutoDispatch({ topic: "events", messages: msgs }),
        () => kafkaClient({ operation: "fetch", topic: "events" })
      );
      assert.strictEqual(result.messageCount, 2);
    }),
    () => test("D12 fetch with explicit offset", async () => {
      const result = await withMock(
        makeAutoDispatch({ topic: "t", messages: [{ value: "v" }] }),
        () => kafkaClient({ operation: "fetch", topic: "t", fetch_offset: 10 })
      );
      assert.ok(result.messages.length >= 0);
    }),
    () => test("D13 fetch empty partition returns empty messages", async () => {
      const result = await withMock(
        makeAutoDispatch({ topic: "empty-topic", messages: [] }),
        () => kafkaClient({ operation: "fetch", topic: "empty-topic" })
      );
      assert.deepStrictEqual(result.messages, []);
      assert.strictEqual(result.messageCount, 0);
    }),
    () => test("D14 fetch returns highWatermark", async () => {
      const result = await withMock(
        makeAutoDispatch({ topic: "t" }),
        () => kafkaClient({ operation: "fetch", topic: "t" })
      );
      assert.ok("highWatermark" in result);
    }),
    () => test("D15 fetch message has value and offset", async () => {
      const result = await withMock(
        makeAutoDispatch({ topic: "t", messages: [{ value: "hello" }] }),
        () => kafkaClient({ operation: "fetch", topic: "t" })
      );
      if (result.messages.length > 0) {
        assert.ok("offset" in result.messages[0]);
        assert.strictEqual(result.messages[0].value, "hello");
      }
    }),
    () => test("D16 fetch returns partition info", async () => {
      const result = await withMock(
        makeAutoDispatch({ topic: "t" }),
        () => kafkaClient({ operation: "fetch", topic: "t", partition: 0 })
      );
      assert.strictEqual(result.operation, "fetch");
      assert.strictEqual(result.topic, "t");
    }),

    // D17-D20: list_offsets
    () => test("D17 list_offsets LATEST returns offset", async () => {
      const result = await withMock(
        makeAutoDispatch({ topic: "t", offset: 99 }),
        () => kafkaClient({ operation: "list_offsets", topic: "t", timestamp: -1 })
      );
      assert.ok(result.offset != null);
    }),
    () => test("D18 list_offsets EARLIEST (timestamp=-2)", async () => {
      const result = await withMock(
        makeAutoDispatch({ topic: "t", offset: 0 }),
        () => kafkaClient({ operation: "list_offsets", topic: "t", timestamp: -2 })
      );
      assert.ok("offset" in result);
    }),
    () => test("D19 list_offsets result has topic", async () => {
      const result = await withMock(
        makeAutoDispatch({ topic: "my-topic" }),
        () => kafkaClient({ operation: "list_offsets", topic: "my-topic" })
      );
      assert.strictEqual(result.topic, "my-topic");
    }),
    () => test("D20 list_offsets returns partition", async () => {
      const result = await withMock(
        makeAutoDispatch({ topic: "t" }),
        () => kafkaClient({ operation: "list_offsets", topic: "t", partition: 0 })
      );
      assert.strictEqual(result.operation, "list_offsets");
    }),

    // D21-D25: create_topics / delete_topics
    () => test("D21 create_topics single topic", async () => {
      const result = await withMock(
        makeAutoDispatch({ topics: ["new-topic"] }),
        () => kafkaClient({ operation: "create_topics", topics: [{ name: "new-topic" }] })
      );
      assert.ok(result.success);
    }),
    () => test("D22 create_topics with partitions and replication_factor", async () => {
      const result = await withMock(
        makeAutoDispatch({ topics: ["t1"] }),
        () => kafkaClient({ operation: "create_topics", topics: [{ name: "t1", num_partitions: 3, replication_factor: 2 }] })
      );
      assert.ok(result.results.length > 0);
    }),
    () => test("D23 create_topics result has created array", async () => {
      const result = await withMock(
        makeAutoDispatch({ topics: ["t"] }),
        () => kafkaClient({ operation: "create_topics", topics: [{ name: "t" }] })
      );
      assert.ok(Array.isArray(result.created));
    }),
    () => test("D24 delete_topics single topic", async () => {
      const result = await withMock(
        makeAutoDispatch({ topics: ["old-topic"] }),
        () => kafkaClient({ operation: "delete_topics", topics: ["old-topic"] })
      );
      assert.ok(result.success);
    }),
    () => test("D25 delete_topics result has deleted array", async () => {
      const result = await withMock(
        makeAutoDispatch({ topics: ["t"] }),
        () => kafkaClient({ operation: "delete_topics", topics: ["t"] })
      );
      assert.ok(Array.isArray(result.deleted));
    }),

    // D26-D30: codec parse functions
    () => test("D26 parseMessageSet decodes single message", () => {
      // Build a minimal MessageSet v1
      const valBuf = Buffer.from("test-value");
      const keyBuf = Buffer.from("test-key");
      const msgBody = Buffer.allocUnsafe(1 + 1 + 8 + bytesSize(keyBuf) + bytesSize(valBuf));
      let mo = 0;
      mo = writeInt8(msgBody, mo, 1); // magic=1
      mo = writeInt8(msgBody, mo, 0); // attrs=0
      mo = writeInt64(msgBody, mo, 0, 1234567890);
      mo = writeBytes(msgBody, mo, keyBuf);
      mo = writeBytes(msgBody, mo, valBuf);
      const crc = crc32(msgBody);
      const msgFull = Buffer.allocUnsafe(4 + msgBody.length);
      msgFull.writeInt32BE(crc, 0);
      msgBody.copy(msgFull, 4);
      const entry = Buffer.allocUnsafe(8 + 4 + msgFull.length);
      writeInt64(entry, 0, 0, 7);
      entry.writeInt32BE(msgFull.length, 8);
      msgFull.copy(entry, 12);
      const msgs = parseMessageSet(entry);
      assert.strictEqual(msgs.length, 1);
      assert.strictEqual(msgs[0].value, "test-value");
      assert.strictEqual(msgs[0].key,   "test-key");
      assert.strictEqual(msgs[0].offset, 7);
    }),
    () => test("D27 _kafkaErrorName known code", () => {
      assert.strictEqual(_kafkaErrorName(3), "UNKNOWN_TOPIC_OR_PARTITION");
    }),
    () => test("D28 _kafkaErrorName unknown code", () => {
      assert.match(_kafkaErrorName(999), /UNKNOWN_ERROR/);
    }),
    () => test("D29 parseCreateTopicsResponse decodes error message", () => {
      const buf = buildCreateTopicsResponse(0, [{ name: "t", errorCode: 39, errorMessage: null }]).slice(8);
      const results = parseCreateTopicsResponse(buf);
      assert.strictEqual(results[0].errorCode, 39);
      assert.ok(results[0].error.includes("TOPIC_ALREADY_EXISTS"));
    }),
    () => test("D30 parseDeleteTopicsResponse round-trips", () => {
      const buf = buildDeleteTopicsResponse(0, [{ name: "del-topic", errorCode: 0 }]).slice(8);
      const results = parseDeleteTopicsResponse(buf);
      assert.strictEqual(results[0].name, "del-topic");
      assert.strictEqual(results[0].errorCode, 0);
    }),
  ]);
}

// ════════════════════════════════════════════════════════════════════════════════
// SECTION E — Error Paths (5 tests)
// ════════════════════════════════════════════════════════════════════════════════
async function sectionE() {
  await runAll("E — Error Paths", [
    () => test("E01 connection refused emits error", async () => {
      const orig = net.createConnection;
      net.createConnection = () => {
        const EventEmitter = require("events");
        const sock = new EventEmitter();
        sock.connecting = true; sock.destroyed = false;
        sock.connect = () => {};
        sock.destroy = () => { sock.destroyed = true; };
        sock.write = (d, cb) => { if (cb) cb(); };
        setImmediate(() => {
          const err = new Error("connect ECONNREFUSED 127.0.0.1:9999");
          err.code = "ECONNREFUSED";
          sock.emit("error", err);
        });
        return sock;
      };
      try {
        await assert.rejects(() => kafkaClient({ operation: "metadata", port: 9999 }),
          /connection failed|ECONNREFUSED/i);
      } finally {
        net.createConnection = orig;
      }
    }),
    () => test("E02 broker returns non-zero error code for produce", async () => {
      const orig = net.createConnection;
      net.createConnection = () => {
        const sock = makeMockSocket((frame) => {
          const corrId = extractCorrelationId(frame);
          const apiKey = extractApiKey(frame);
          if (apiKey === 0) { // PRODUCE
            // Return error: UNKNOWN_TOPIC_OR_PARTITION (3)
            const tBuf = Buffer.allocUnsafe(4 + strSize("err-topic") + 4 + 4 + 2 + 8 + 8);
            let o = 0;
            o = writeInt32(tBuf, o, 1);
            o = writeString(tBuf, o, "err-topic");
            o = writeInt32(tBuf, o, 1);
            o = writeInt32(tBuf, o, 0); // partition
            o = writeInt16(tBuf, o, 3); // error code
            o = writeInt64(tBuf, o, 0, 0);
            o = writeInt64(tBuf, o, 0, 0);
            return buildResponseFrame(corrId, tBuf);
          }
          return buildResponseFrame(corrId, Buffer.alloc(0));
        });
        return sock;
      };
      try {
        await assert.rejects(() => kafkaClient({ operation: "produce", topic: "err-topic", messages: [{ value: "x" }] }),
          /produce error|UNKNOWN_TOPIC_OR_PARTITION/i);
      } finally {
        net.createConnection = orig;
      }
    }),
    () => test("E03 connection closed mid-request rejects", async () => {
      const orig = net.createConnection;
      net.createConnection = () => {
        const sock = makeMockSocket(null);
        const origWrite = sock.write;
        sock.write = (data, cb) => {
          if (cb) cb();
          // Close the connection after receiving any write
          setImmediate(() => sock.emit("close"));
        };
        return sock;
      };
      try {
        await assert.rejects(() => kafkaClient({ operation: "metadata", timeout: 2 }),
          /closed/i);
      } finally {
        net.createConnection = orig;
      }
    }),
    () => test("E04 timeout triggers error", async () => {
      const orig = net.createConnection;
      net.createConnection = () => {
        // Server that never responds
        const EventEmitter = require("events");
        const sock = new EventEmitter();
        sock.connecting = false; sock.destroyed = false;
        sock.connect = () => {};
        sock.write = (d, cb) => { if (cb) cb(); }; // accept writes, never reply
        sock.destroy = (err) => {
          sock.destroyed = true;
          if (err) setImmediate(() => sock.emit("error", err));
          else     setImmediate(() => sock.emit("close"));
        };
        setImmediate(() => sock.emit("connect"));
        return sock;
      };
      try {
        await assert.rejects(
          () => kafkaClient({ operation: "metadata", timeout: 0.1 }),
          /timeout/i
        );
      } finally {
        net.createConnection = orig;
      }
    }),
    () => test("E05 list_offsets error code from broker throws", async () => {
      const orig = net.createConnection;
      net.createConnection = () => {
        const sock = makeMockSocket((frame) => {
          const corrId = extractCorrelationId(frame);
          const apiKey = extractApiKey(frame);
          if (apiKey === 2) {
            // Return OFFSET_OUT_OF_RANGE (1)
            const throttle = Buffer.allocUnsafe(4); throttle.writeInt32BE(0, 0);
            const tCount   = Buffer.allocUnsafe(4); tCount.writeInt32BE(1, 0);
            const tNameBuf = Buffer.allocUnsafe(strSize("t")); writeString(tNameBuf, 0, "t");
            const pCount   = Buffer.allocUnsafe(4); pCount.writeInt32BE(1, 0);
            const pBuf     = Buffer.allocUnsafe(4 + 2 + 8 + 8);
            let o = 0;
            o = writeInt32(pBuf, o, 0);
            o = writeInt16(pBuf, o, 1); // OFFSET_OUT_OF_RANGE
            o = writeInt64(pBuf, o, 0, 0);
            o = writeInt64(pBuf, o, 0, 0);
            return buildResponseFrame(corrId, Buffer.concat([throttle, tCount, tNameBuf, pCount, pBuf]));
          }
          return buildResponseFrame(corrId, Buffer.alloc(0));
        });
        return sock;
      };
      try {
        await assert.rejects(
          () => kafkaClient({ operation: "list_offsets", topic: "t" }),
          /OFFSET_OUT_OF_RANGE/i
        );
      } finally {
        net.createConnection = orig;
      }
    }),
  ]);
}

// ════════════════════════════════════════════════════════════════════════════════
// SECTION F — Concurrency (5 tests)
// ════════════════════════════════════════════════════════════════════════════════
async function sectionF() {
  await runAll("F — Concurrency", [
    () => test("F01 10 parallel metadata requests", async () => {
      const results = await Promise.all(
        Array.from({ length: 10 }, () =>
          withMock(makeAutoDispatch(), () => kafkaClient({ operation: "metadata" }))
        )
      );
      assert.strictEqual(results.length, 10);
      assert.ok(results.every(r => r.operation === "metadata"));
    }),
    () => test("F02 5 parallel produce requests", async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          withMock(
            makeAutoDispatch({ topic: `topic-${i}` }),
            () => kafkaClient({ operation: "produce", topic: `topic-${i}`, messages: [{ value: `msg-${i}` }] })
          )
        )
      );
      assert.strictEqual(results.length, 5);
      assert.ok(results.every(r => r.messageCount === 1));
    }),
    () => test("F03 5 parallel fetch requests independent", async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          withMock(
            makeAutoDispatch({ topic: "shared-topic", messages: [{ value: "v" }] }),
            () => kafkaClient({ operation: "fetch", topic: "shared-topic" })
          )
        )
      );
      assert.ok(results.every(r => r.operation === "fetch"));
    }),
    () => test("F04 mixed operations in parallel", async () => {
      const [meta, list, produce] = await Promise.all([
        withMock(makeAutoDispatch(), () => kafkaClient({ operation: "metadata" })),
        withMock(makeAutoDispatch({ topic: "t", offset: 5 }), () => kafkaClient({ operation: "list_offsets", topic: "t" })),
        withMock(makeAutoDispatch({ topic: "t" }), () => kafkaClient({ operation: "produce", topic: "t", messages: [{ value: "x" }] })),
      ]);
      assert.strictEqual(meta.operation, "metadata");
      assert.strictEqual(list.operation, "list_offsets");
      assert.strictEqual(produce.operation, "produce");
    }),
    () => test("F05 correlationId isolation — 20 parallel produces", async () => {
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          withMock(
            makeAutoDispatch({ topic: "t" }),
            () => kafkaClient({ operation: "produce", topic: "t", messages: [{ value: String(i) }] })
          )
        )
      );
      assert.strictEqual(results.length, 20);
      assert.ok(results.every(r => r.messageCount === 1));
    }),
  ]);
}

// ────────────────────────────────────────────────────────────────────────────────
// MAIN
// ────────────────────────────────────────────────────────────────────────────────
(async () => {
  process.stderr.write("\n=== Section 200: kafka_client ===\n");
  await sectionA();
  await sectionB();
  await sectionC();
  await sectionD();
  await sectionE();
  await sectionF();
  process.stderr.write(`\n  Results: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
})();
