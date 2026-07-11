"use strict";
// ── UUID / ULID generation ─────────────────────────────────────────────────────
// Implements uuid_generate: v1 (time-based), v4 (crypto.randomUUID),
// v5 (name-based SHA-1, RFC 4122 appendix C), and ULID (Crockford Base32).
// Zero npm dependencies — Node.js built-in crypto only.

const crypto = require("crypto");
const { ToolError } = require("./errors");

// ── UUID v4 ──────────────────────────────────────────────────────────────────
function uuidV4() {
  // stable in Node 14.17+; always available in Node 18+ (our minimum)
  return crypto.randomUUID();
}

// ── UUID v1 (time-based) ─────────────────────────────────────────────────────
// RFC 4122 §4.2: 60-bit timestamp (100-ns ticks since Oct 15, 1582),
// 14-bit monotonic clock sequence, 48-bit random node (multicast bit set per §4.5).
let _v1Seq = (crypto.randomBytes(2).readUInt16BE(0) & 0x3fff);
let _v1LastMs = -1;

function uuidV1() {
  const now = Date.now();
  if (now <= _v1LastMs) {
    _v1Seq = (_v1Seq + 1) & 0x3fff;
  } else {
    _v1LastMs = now;
  }

  // Gregorian epoch offset: 1582-10-15 → JS epoch (1970-01-01) in ms
  const GREG_OFFSET_MS = 12219292800000n;
  const ts100ns = (BigInt(now) + GREG_OFFSET_MS) * 10000n;

  const timeLow = Number(ts100ns & 0xffffffffn);
  const timeMid = Number((ts100ns >> 32n) & 0xffffn);
  const timeHiV = Number((ts100ns >> 48n) & 0x0fffn) | 0x1000; // version 1

  const clockSeq = (_v1Seq & 0x3fff) | 0x8000; // RFC 4122 variant 10xx

  const node = crypto.randomBytes(6);
  node[0] |= 0x01; // multicast bit required for random-node per §4.5

  const b = Buffer.allocUnsafe(16);
  b.writeUInt32BE(timeLow, 0);
  b.writeUInt16BE(timeMid, 4);
  b.writeUInt16BE(timeHiV, 6);
  b.writeUInt16BE(clockSeq, 8);
  node.copy(b, 10);
  return bufToUuid(b);
}

// ── UUID v5 (name-based, SHA-1) ──────────────────────────────────────────────
// RFC 4122 §4.3 + Appendix C predefined namespaces.
const NS_MAP = {
  dns:  Buffer.from("6ba7b8109dad11d180b400c04fd430c8", "hex"),
  url:  Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex"),
  oid:  Buffer.from("6ba7b8129dad11d180b400c04fd430c8", "hex"),
  x500: Buffer.from("6ba7b8149dad11d180b400c04fd430c8", "hex"),
};

function resolveNamespace(ns) {
  if (!ns || ns === "dns") return NS_MAP.dns;
  const key = String(ns).toLowerCase();
  if (NS_MAP[key]) return NS_MAP[key];
  const hex = String(ns).replace(/-/g, "");
  if (/^[0-9a-f]{32}$/i.test(hex)) return Buffer.from(hex, "hex");
  throw new ToolError(
    `uuid_generate: invalid namespace '${ns}'. ` +
      `Use 'dns', 'url', 'oid', 'x500', or a UUID string.`,
    -32602
  );
}

function uuidV5(name, namespace) {
  const nsBuf = resolveNamespace(namespace);
  const hash = crypto.createHash("sha1")
    .update(nsBuf)
    .update(Buffer.from(name, "utf8"))
    .digest();
  hash[6] = (hash[6] & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8] & 0x3f) | 0x80; // RFC 4122 variant
  return bufToUuid(hash.subarray(0, 16));
}

// ── ULID ─────────────────────────────────────────────────────────────────────
// Spec: https://github.com/ulid/spec
// 48-bit ms timestamp + 80-bit crypto-random → 26 Crockford Base32 chars
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function ulidGenerate() {
  const now = Date.now();
  let t = now;
  let ts = "";
  for (let i = 0; i < 10; i++) {
    ts = CROCKFORD[t & 31] + ts;
    t = Math.floor(t / 32);
  }
  const randBytes = crypto.randomBytes(10);
  let r = 0n;
  for (const byte of randBytes) r = (r << 8n) | BigInt(byte);
  let randStr = "";
  for (let i = 0; i < 16; i++) {
    randStr = CROCKFORD[Number(r & 31n)] + randStr;
    r >>= 5n;
  }
  return ts + randStr;
}

// ── Shared helper ─────────────────────────────────────────────────────────────
function bufToUuid(buf) {
  const h = buf.toString("hex");
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
}

// ── Public API ────────────────────────────────────────────────────────────────
/**
 * @param {object}  opts
 * @param {"v1"|"v4"|"v5"|"ulid"} [opts.version="v4"]
 * @param {number}  [opts.count=1]    1–100
 * @param {string}  [opts.name]       required for v5
 * @param {string}  [opts.namespace]  v5 namespace: 'dns'|'url'|'oid'|'x500'|<uuid-string>
 * @param {boolean} [opts.uppercase]  uppercase hex for UUID variants (not ULID, already caps)
 */
function uuidGenerate({ version = "v4", count = 1, name, namespace, uppercase = false } = {}) {
  const VALID = ["v1", "v4", "v5", "ulid"];
  if (!VALID.includes(version))
    throw new ToolError(
      `uuid_generate: invalid version '${version}'. Use one of: ${VALID.join(", ")}.`,
      -32602
    );

  count = Number(count);
  if (!Number.isInteger(count) || count < 1 || count > 100)
    throw new ToolError("uuid_generate: 'count' must be an integer between 1 and 100.", -32602);

  if (version === "v5") {
    if (name == null || typeof name !== "string" || name.length === 0)
      throw new ToolError(
        "uuid_generate: 'name' is required and must be a non-empty string for v5.", -32602
      );
  }

  const ids = [];
  for (let i = 0; i < count; i++) {
    let id;
    switch (version) {
      case "v1":   id = uuidV1(); break;
      case "v4":   id = uuidV4(); break;
      case "v5":   id = uuidV5(name, namespace); break;
      case "ulid": id = ulidGenerate(); break;
    }
    if (uppercase && version !== "ulid") id = id.toUpperCase();
    ids.push(id);
  }

  const out = { version, count: ids.length, ids };
  if (count === 1) out.id = ids[0];
  if (version === "v5") { out.name = name; out.namespace = namespace || "dns"; }
  return out;
}

module.exports = { uuidGenerate };
