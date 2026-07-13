"use strict";
/**
 * ntp_client — Zero-dependency NTP/SNTP client.
 * Pure Node.js (dgram built-in only; no npm deps).
 *
 * Supported operations:
 *   query       — Query an NTP server and return the current time + offset/delay
 *   sync_check  — Check whether the local clock is within an acceptable skew window
 *   servers     — Return a curated list of well-known public NTP servers
 *   stratum     — Query and return NTP stratum / reference-ID detail
 *
 * Protocol:
 *   SNTPv4 / NTPv4 (RFC 4330 / RFC 5905)
 *   48-byte request packet: LI=0, VN=4, Mode=3 (client)
 *   Response parsed: stratum, reference ID, root delay, root dispersion,
 *   timestamps (reference, originate, receive, transmit)
 *
 * Security:
 *   - NUL-byte guard on host
 *   - Timeout clamped 500 ms – 30 s
 *   - No credentials ever logged
 */

const dgram = require("dgram");

// ── Constants ──────────────────────────────────────────────────────────────────
const NTP_PORT            = 123;
const NTP_PACKET_SIZE     = 48;
const NTP_EPOCH_OFFSET    = 2208988800; // seconds between 1900-01-01 and 1970-01-01
const DEFAULT_TIMEOUT_MS  = 5_000;
const MIN_TIMEOUT_MS      = 500;
const MAX_TIMEOUT_MS      = 30_000;

// Well-known public NTP servers
const PUBLIC_NTP_SERVERS = [
  { host: "pool.ntp.org",           description: "NTP Pool Project (global round-robin)" },
  { host: "time.cloudflare.com",    description: "Cloudflare NTP (Roughtime compatible)" },
  { host: "time.google.com",        description: "Google Public NTP" },
  { host: "time.apple.com",         description: "Apple NTP" },
  { host: "time.windows.com",       description: "Microsoft NTP" },
  { host: "ntp.ubuntu.com",         description: "Ubuntu NTP" },
  { host: "0.pool.ntp.org",         description: "NTP Pool Project — zone 0" },
  { host: "1.pool.ntp.org",         description: "NTP Pool Project — zone 1" },
  { host: "2.pool.ntp.org",         description: "NTP Pool Project — zone 2" },
  { host: "3.pool.ntp.org",         description: "NTP Pool Project — zone 3" },
  { host: "time1.google.com",       description: "Google Public NTP — server 1" },
  { host: "time2.google.com",       description: "Google Public NTP — server 2" },
  { host: "time3.google.com",       description: "Google Public NTP — server 3" },
  { host: "time4.google.com",       description: "Google Public NTP — server 4" },
];

// ── NUL guard ────────────────────────────────────────────────────────────────
function guardNul(value, name) {
  if (typeof value === "string" && value.includes("\0"))
    throw new Error(`ntp_client: '${name}' must not contain NUL bytes.`);
}

function clampTimeout(t) {
  const n = typeof t === "number" ? t : DEFAULT_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.trunc(n)));
}

// ── Build NTP request packet (SNTPv4) ──────────────────────────────────────
function buildNtpPacket() {
  const buf = Buffer.alloc(NTP_PACKET_SIZE, 0);
  // Byte 0: LI=0 (no leap), VN=4 (NTPv4), Mode=3 (client)
  // LI(2 bits)=00, VN(3 bits)=100, Mode(3 bits)=011 => 0b00_100_011 = 0x23
  buf[0] = 0x23;
  return buf;
}

// ── Parse NTP timestamp (64-bit fixed-point: 32-bit seconds + 32-bit fraction)
//    Returns seconds since Unix epoch (float)
function parseNtpTimestamp(buf, offset) {
  const seconds  = buf.readUInt32BE(offset);
  const fraction = buf.readUInt32BE(offset + 4);
  if (seconds === 0 && fraction === 0) return null; // zero timestamp
  // Convert from NTP epoch (1900) to Unix epoch (1970)
  const unixSec = (seconds - NTP_EPOCH_OFFSET) + (fraction / 0x100000000);
  return unixSec;
}

// ── Parse reference ID (depends on stratum) ───────────────────────────────
function parseRefId(buf, stratum) {
  // bytes 12-15
  if (stratum <= 1) {
    // Primary server: ASCII string (e.g. 'GPS\0', 'PPS\0', 'LOCL')
    let s = "";
    for (let i = 12; i < 16; i++) {
      const c = buf[i];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s || "(empty)";
  }
  // Stratum 2+: IPv4 address of reference source
  return `${buf[12]}.${buf[13]}.${buf[14]}.${buf[15]}`;
}

// ── Convert fixed-point 32-bit (16.16) to float seconds ──────────────────
function parseFixed16_16(buf, offset) {
  const hi = buf.readUInt16BE(offset);
  const lo = buf.readUInt16BE(offset + 2);
  return hi + lo / 65536;
}

// ── Stratum descriptions ──────────────────────────────────────────────────
function stratumDesc(s) {
  if (s === 0)  return "unspecified / unavailable";
  if (s === 1)  return "primary reference (GPS/atomic clock)";
  if (s <= 15)  return `secondary reference (${s} hops from primary)`;
  if (s === 16) return "unsynchronized";
  return "reserved";
}

// ── Send NTP query and return parsed response ─────────────────────────────
function queryNtp({ host, port = NTP_PORT, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    let settled = false;

    const done = (errOrResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.close(); } catch (_) { /* ignore */ }
      if (errOrResult instanceof Error) reject(errOrResult);
      else resolve(errOrResult);
    };

    const timer = setTimeout(() => {
      done(new Error(`ntp_client: query to ${host}:${port} timed out after ${timeoutMs} ms.`));
    }, timeoutMs);

    socket.on("error", (err) => {
      done(new Error(`ntp_client: UDP socket error querying ${host}: ${err.message}`));
    });

    const requestPacket = buildNtpPacket();
    // Record t1 = client transmit time (just before send)
    const t1 = Date.now() / 1000;

    socket.send(requestPacket, 0, NTP_PACKET_SIZE, port, host, (sendErr) => {
      if (sendErr) {
        done(new Error(`ntp_client: failed to send UDP packet to ${host}: ${sendErr.message}`));
        return;
      }

      socket.on("message", (msg) => {
        // t4 = client receive time
        const t4 = Date.now() / 1000;

        if (msg.length < NTP_PACKET_SIZE) {
          done(new Error(`ntp_client: response too short (${msg.length} bytes; expected ${NTP_PACKET_SIZE}).`));
          return;
        }

        // Parse response fields
        const byte0    = msg[0];
        const li       = (byte0 >> 6) & 0x03;  // Leap Indicator
        const vn       = (byte0 >> 3) & 0x07;  // Version Number
        const mode     = byte0 & 0x07;          // Mode (4=server, 5=broadcast)
        const stratum  = msg[1];
        const poll     = msg[2];                // poll interval (log2 seconds)
        const prec     = msg[3] << 24 >> 24;   // precision (signed int8, log2 seconds)

        const rootDelayRaw      = parseFixed16_16(msg, 4);
        const rootDispersionRaw = parseFixed16_16(msg, 8);
        const referenceId       = parseRefId(msg, stratum);

        const tRef = parseNtpTimestamp(msg, 16); // reference timestamp
        const t2   = parseNtpTimestamp(msg, 32); // receive timestamp (server)
        const t3   = parseNtpTimestamp(msg, 40); // transmit timestamp (server)

        if (t2 === null || t3 === null) {
          done(new Error("ntp_client: server returned zero receive/transmit timestamps."));
          return;
        }

        // Compute offset and round-trip delay (RFC 5905 §8)
        // offset = ((t2 - t1) + (t3 - t4)) / 2
        // delay  = (t4 - t1) - (t3 - t2)
        const offset  = ((t2 - t1) + (t3 - t4)) / 2;
        const delay   = (t4 - t1) - (t3 - t2);

        const serverTimeMs = (t3 + offset) * 1000;
        const serverDate   = new Date(serverTimeMs).toISOString();

        const liDesc = ["no warning", "last minute has 61 seconds",
                        "last minute has 59 seconds", "clock unsynchronized"][li];

        done({
          host,
          port,
          // NTP header fields
          leapIndicator:     li,
          leapDescription:   liDesc,
          versionNumber:     vn,
          mode,
          stratum,
          stratumDescription: stratumDesc(stratum),
          pollInterval:      Math.pow(2, poll),
          precisionExp:      prec,
          precisionSec:      Math.pow(2, prec),
          rootDelayMs:       rootDelayRaw * 1000,
          rootDispersionMs:  rootDispersionRaw * 1000,
          referenceId,
          // Computed timing (all in milliseconds for readability)
          serverTime:        serverDate,
          serverTimeMs,
          offsetMs:          offset * 1000,
          roundTripDelayMs:  delay * 1000,
          // Raw timestamps (Unix seconds, null if zero)
          timestamps: {
            reference: tRef ? new Date(tRef * 1000).toISOString() : null,
            originate: t1 ? new Date(t1  * 1000).toISOString() : null,
            receive:   t2 ? new Date(t2  * 1000).toISOString() : null,
            transmit:  t3 ? new Date(t3  * 1000).toISOString() : null,
          },
        });
      });
    });
  });
}

// ── Operations ────────────────────────────────────────────────────────────────

/** query — query an NTP server, return time + offset + delay */
async function opQuery(args) {
  const host      = args.host || "pool.ntp.org";
  const port      = (args.port !== undefined && args.port !== null) ? args.port : NTP_PORT;
  const timeoutMs = clampTimeout(args.timeout);
  guardNul(host, "host");

  if (port < 1 || port > 65535)
    throw new Error(`ntp_client: 'port' must be 1–65535 (got ${port}).`);

  const result = await queryNtp({ host, port, timeoutMs });
  return {
    ok:               true,
    operation:        "query",
    host:             result.host,
    port:             result.port,
    serverTime:       result.serverTime,
    serverTimeMs:     result.serverTimeMs,
    offsetMs:         result.offsetMs,
    roundTripDelayMs: result.roundTripDelayMs,
    stratum:          result.stratum,
    stratumDescription: result.stratumDescription,
    leapIndicator:    result.leapIndicator,
    leapDescription:  result.leapDescription,
    referenceId:      result.referenceId,
    rootDelayMs:      result.rootDelayMs,
    rootDispersionMs: result.rootDispersionMs,
    versionNumber:    result.versionNumber,
    pollInterval:     result.pollInterval,
    precisionSec:     result.precisionSec,
    timestamps:       result.timestamps,
  };
}

/** sync_check — verify local clock is within acceptable skew */
async function opSyncCheck(args) {
  const host         = args.host || "pool.ntp.org";
  const port         = (args.port !== undefined && args.port !== null) ? args.port : NTP_PORT;
  const timeoutMs    = clampTimeout(args.timeout);
  const maxSkewMs    = typeof args.max_skew_ms === "number" ? args.max_skew_ms : 1000;
  guardNul(host, "host");

  if (port < 1 || port > 65535)
    throw new Error(`ntp_client: 'port' must be 1–65535 (got ${port}).`);
  if (maxSkewMs <= 0)
    throw new Error(`ntp_client: 'max_skew_ms' must be > 0 (got ${maxSkewMs}).`);

  const result = await queryNtp({ host, port, timeoutMs });
  const absOffsetMs = Math.abs(result.offsetMs);
  const inSync      = absOffsetMs <= maxSkewMs;

  return {
    ok:               true,
    operation:        "sync_check",
    host:             result.host,
    inSync,
    offsetMs:         result.offsetMs,
    absOffsetMs,
    maxSkewMs,
    roundTripDelayMs: result.roundTripDelayMs,
    stratum:          result.stratum,
    stratumDescription: result.stratumDescription,
    serverTime:       result.serverTime,
    message: inSync
      ? `Clock is in sync (offset ${absOffsetMs.toFixed(3)} ms ≤ ${maxSkewMs} ms threshold).`
      : `Clock is OUT OF SYNC: offset ${absOffsetMs.toFixed(3)} ms exceeds ${maxSkewMs} ms threshold.`,
  };
}

/** servers — return list of well-known public NTP servers */
function opServers() {
  return {
    ok:        true,
    operation: "servers",
    count:     PUBLIC_NTP_SERVERS.length,
    servers:   PUBLIC_NTP_SERVERS.map(s => ({ ...s })),
  };
}

/** stratum — query NTP and return stratum / reference detail */
async function opStratum(args) {
  const host      = args.host || "pool.ntp.org";
  const port      = (args.port !== undefined && args.port !== null) ? args.port : NTP_PORT;
  const timeoutMs = clampTimeout(args.timeout);
  guardNul(host, "host");

  if (port < 1 || port > 65535)
    throw new Error(`ntp_client: 'port' must be 1–65535 (got ${port}).`);

  const result = await queryNtp({ host, port, timeoutMs });
  return {
    ok:                 true,
    operation:          "stratum",
    host:               result.host,
    stratum:            result.stratum,
    stratumDescription: result.stratumDescription,
    referenceId:        result.referenceId,
    leapIndicator:      result.leapIndicator,
    leapDescription:    result.leapDescription,
    rootDelayMs:        result.rootDelayMs,
    rootDispersionMs:   result.rootDispersionMs,
    versionNumber:      result.versionNumber,
    pollInterval:       result.pollInterval,
    precisionExp:       result.precisionExp,
    precisionSec:       result.precisionSec,
    referenceTime:      result.timestamps.reference,
    serverTime:         result.serverTime,
    offsetMs:           result.offsetMs,
  };
}

// ── Main entry point ─────────────────────────────────────────────────────────

async function ntpClient(args) {
  const op = args.operation;
  if (!op) throw new Error("ntp_client: 'operation' is required.");

  switch (op) {
    case "query":       return opQuery(args);
    case "sync_check":  return opSyncCheck(args);
    case "servers":     return opServers();
    case "stratum":     return opStratum(args);
    default:
      throw new Error(
        `ntp_client: unknown operation '${op}'. ` +
        `Valid: query, sync_check, servers, stratum.`
      );
  }
}

module.exports = { ntpClient };
