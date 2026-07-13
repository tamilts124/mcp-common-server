"use strict";
/**
 * dns_client — Zero-dependency DNS client.
 * Pure Node.js (dgram, net, http, https built-ins; no npm deps).
 *
 * Implements:
 *   Classic DNS: UDP (with TCP fallback on truncation) per RFC 1035
 *   DNS-over-HTTPS (DoH): RFC 8484 (application/dns-message)
 *
 * Operations:
 *   query   — Query one or more record types for a name
 *   reverse — PTR lookup for an IP address
 *   batch   — Multiple queries in parallel
 *   resolvers — Return built-in resolver presets
 *   info    — Return config/record-type table (no I/O)
 *
 * Record types: A, AAAA, MX, TXT, NS, SOA, CNAME, PTR, SRV,
 *               CAA, DNSKEY, DS, NAPTR, HTTPS, SVCB
 *
 * Resolver presets:
 *   cloudflare — 1.1.1.1 / 1.0.0.1  (DoH: cloudflare-dns.com)
 *   google     — 8.8.8.8 / 8.8.4.4  (DoH: dns.google)
 *   quad9      — 9.9.9.9             (DoH: dns.quad9.net)
 *   system     — Node.js built-in dns.resolve* (uses OS resolver)
 *
 * Security:
 *   - NUL-byte guards on all user-supplied strings
 *   - Timeout clamped 1 s – 30 s
 *   - Max UDP response 65535 bytes; TCP response 8 MB
 *   - Domain name validated (RFC 1123 + RFC 5891 basics)
 *   - No credentials involved
 *   - Transaction ID randomised per query
 */

const dgram  = require("dgram");
const net    = require("net");
const https  = require("https");
const http   = require("http");
const dns    = require("dns");

// ── Constants ─────────────────────────────────────────────────────────────────
const DEFAULT_TIMEOUT_MS = 5_000;
const MIN_TIMEOUT_MS     = 1_000;
const MAX_TIMEOUT_MS     = 30_000;
const MAX_BATCH_QUERIES  = 20;
const MAX_TCP_BYTES      = 8 * 1024 * 1024; // 8 MB

// ── DNS record type table ─────────────────────────────────────────────────────
const RTYPE = {
  A:      1,
  NS:     2,
  CNAME:  5,
  SOA:    6,
  PTR:    12,
  MX:     15,
  TXT:    16,
  AAAA:   28,
  SRV:    33,
  NAPTR:  35,
  DS:     43,
  DNSKEY: 48,
  SVCB:   64,
  HTTPS:  65,
  CAA:    257,
};

const RTYPE_REVERSE = Object.fromEntries(Object.entries(RTYPE).map(([k, v]) => [v, k]));

const RCLASS_IN = 1;

// RCODE meanings
const RCODE_NAMES = {
  0: "NOERROR",
  1: "FORMERR",
  2: "SERVFAIL",
  3: "NXDOMAIN",
  4: "NOTIMP",
  5: "REFUSED",
  6: "YXDOMAIN",
  7: "YXRRSET",
  8: "NXRRSET",
  9: "NOTAUTH",
  10: "NOTZONE",
};

// ── Resolver presets ──────────────────────────────────────────────────────────
const RESOLVER_PRESETS = {
  cloudflare: {
    name:      "Cloudflare",
    ipv4:      ["1.1.1.1", "1.0.0.1"],
    ipv6:      ["2606:4700:4700::1111", "2606:4700:4700::1001"],
    doh:       "https://cloudflare-dns.com/dns-query",
    port:      53,
    description: "Cloudflare public DNS (privacy-first, fast)",
  },
  google: {
    name:      "Google",
    ipv4:      ["8.8.8.8", "8.8.4.4"],
    ipv6:      ["2001:4860:4860::8888", "2001:4860:4860::8844"],
    doh:       "https://dns.google/dns-query",
    port:      53,
    description: "Google Public DNS",
  },
  quad9: {
    name:      "Quad9",
    ipv4:      ["9.9.9.9", "149.112.112.112"],
    ipv6:      ["2620:fe::fe", "2620:fe::9"],
    doh:       "https://dns.quad9.net/dns-query",
    port:      53,
    description: "Quad9 public DNS (security-filtering)",
  },
  system: {
    name:      "System",
    ipv4:      [],
    ipv6:      [],
    doh:       null,
    port:      53,
    description: "OS default resolver (via Node.js dns module)",
  },
};

// ── Validation helpers ────────────────────────────────────────────────────────
function guardNul(value, name) {
  if (typeof value === "string" && value.includes("\0"))
    throw new Error(`dns_client: '${name}' must not contain NUL bytes.`);
}

function clampTimeout(t) {
  const n = typeof t === "number" ? t : DEFAULT_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.trunc(n)));
}

function validatePort(port, def = 53) {
  const p = port ?? def;
  if (!Number.isInteger(p) || p < 1 || p > 65535)
    throw new Error(`dns_client: 'port' must be an integer 1–65535 (got ${p}).`);
  return p;
}

/** Very basic domain validation — not an exhaustive RFC 5891 IDNA check */
function validateDomain(name) {
  // Allow trailing dot (FQDN); remove for check
  const n = name.replace(/\.$/, "");
  if (!n) return true; // root is valid
  if (n.length > 253) return false;
  // Each label: 1-63 chars, alphanumeric + hyphen, not start/end with hyphen
  const labels = n.split(".");
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) return false;
    if (!/^[a-zA-Z0-9_*-]+$/.test(label)) return false;
    if (label.startsWith("-") || label.endsWith("-")) return false;
  }
  return true;
}

function resolveRtype(type) {
  if (typeof type === "number") return type;
  const upper = String(type).toUpperCase();
  if (RTYPE[upper] !== undefined) return RTYPE[upper];
  throw new Error(
    `dns_client: unknown record type '${type}'. ` +
    `Supported: ${Object.keys(RTYPE).join(", ")}.`
  );
}

// ── Wire-format encoder ───────────────────────────────────────────────────────

/**
 * Encode a domain name as DNS wire-format labels.
 * foo.bar.com → \x03foo\x03bar\x03com\x00
 */
function encodeDomainName(name) {
  // Root label is just \x00
  if (name === "." || name === "") return Buffer.alloc(1, 0);
  const fqdn = name.endsWith(".") ? name : name + ".";
  const parts = [];
  for (const label of fqdn.split(".")) {
    if (label === "") {
      parts.push(Buffer.alloc(1, 0)); // root label
    } else {
      const lb = Buffer.from(label, "ascii");
      const lh = Buffer.alloc(1, lb.length);
      parts.push(lh, lb);
    }
  }
  return Buffer.concat(parts);
}

/**
 * Build a DNS query message (RFC 1035 §4.1).
 * Returns a Buffer containing the full query.
 */
function buildQuery(name, qtype, id) {
  const txId = id !== undefined ? id : Math.floor(Math.random() * 65536);
  const header = Buffer.alloc(12);
  // ID
  header.writeUInt16BE(txId, 0);
  // Flags: QR=0 (query), Opcode=0 (QUERY), RD=1 (recursion desired)
  header.writeUInt16BE(0x0100, 2);
  // QDCOUNT=1
  header.writeUInt16BE(1, 4);
  // ANCOUNT=NSCOUNT=ARCOUNT=0
  header.writeUInt16BE(0, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);

  const qname   = encodeDomainName(name);
  const qtypeAR = Buffer.alloc(4);
  qtypeAR.writeUInt16BE(qtype, 0);
  qtypeAR.writeUInt16BE(RCLASS_IN, 2);

  return { buf: Buffer.concat([header, qname, qtypeAR]), txId };
}

// ── Wire-format decoder ───────────────────────────────────────────────────────

/** Read a DNS name from a message buffer at offset, with pointer support */
function readName(buf, offset, depth = 0) {
  if (depth > 10) return { name: "<max-ptr-depth>", end: offset };
  const labels = [];
  let pos = offset;
  let jumped = false;
  let end = offset;

  while (pos < buf.length) {
    const len = buf[pos];
    if (len === 0) {
      if (!jumped) end = pos + 1;
      break;
    } else if ((len & 0xC0) === 0xC0) {
      // Pointer
      if (pos + 1 >= buf.length) break;
      const ptr = ((len & 0x3F) << 8) | buf[pos + 1];
      if (!jumped) end = pos + 2;
      jumped = true;
      pos = ptr;
      depth++;
      if (depth > 10) break;
    } else {
      pos++;
      if (pos + len > buf.length) break;
      labels.push(buf.slice(pos, pos + len).toString("ascii"));
      pos += len;
      if (!jumped) end = pos;
    }
  }

  return { name: labels.join(".") || ".", end };
}

/** Parse one RR RDATA section */
function parseRdata(buf, rdataStart, rdLen, rtype) {
  const end = rdataStart + rdLen;
  try {
    switch (rtype) {
      case RTYPE.A: {
        if (rdLen < 4) return { raw: buf.slice(rdataStart, end).toString("hex") };
        const ip = [];
        for (let i = 0; i < 4; i++) ip.push(buf[rdataStart + i]);
        return { address: ip.join(".") };
      }
      case RTYPE.AAAA: {
        if (rdLen < 16) return { raw: buf.slice(rdataStart, end).toString("hex") };
        const groups = [];
        for (let i = 0; i < 16; i += 2)
          groups.push(buf.readUInt16BE(rdataStart + i).toString(16));
        return { address: groups.join(":") };
      }
      case RTYPE.NS:
      case RTYPE.CNAME:
      case RTYPE.PTR: {
        const { name } = readName(buf, rdataStart);
        return { target: name };
      }
      case RTYPE.MX: {
        if (rdLen < 3) return { raw: buf.slice(rdataStart, end).toString("hex") };
        const preference = buf.readUInt16BE(rdataStart);
        const { name: exchange } = readName(buf, rdataStart + 2);
        return { preference, exchange };
      }
      case RTYPE.TXT: {
        const strings = [];
        let pos = rdataStart;
        while (pos < end) {
          const slen = buf[pos++];
          if (pos + slen > end) break;
          strings.push(buf.slice(pos, pos + slen).toString("utf8"));
          pos += slen;
        }
        return { strings, text: strings.join("") };
      }
      case RTYPE.SOA: {
        const { name: mname, end: e1 } = readName(buf, rdataStart);
        const { name: rname, end: e2 } = readName(buf, e1);
        if (e2 + 20 > buf.length) return { mname, rname };
        const serial  = buf.readUInt32BE(e2);
        const refresh = buf.readUInt32BE(e2 + 4);
        const retry   = buf.readUInt32BE(e2 + 8);
        const expire  = buf.readUInt32BE(e2 + 12);
        const minimum = buf.readUInt32BE(e2 + 16);
        return { mname, rname, serial, refresh, retry, expire, minimum };
      }
      case RTYPE.SRV: {
        if (rdLen < 7) return { raw: buf.slice(rdataStart, end).toString("hex") };
        const priority = buf.readUInt16BE(rdataStart);
        const weight   = buf.readUInt16BE(rdataStart + 2);
        const port     = buf.readUInt16BE(rdataStart + 4);
        const { name: target } = readName(buf, rdataStart + 6);
        return { priority, weight, port, target };
      }
      case RTYPE.CAA: {
        if (rdLen < 2) return { raw: buf.slice(rdataStart, end).toString("hex") };
        const flags   = buf[rdataStart];
        const tagLen  = buf[rdataStart + 1];
        const tag     = buf.slice(rdataStart + 2, rdataStart + 2 + tagLen).toString("ascii");
        const value   = buf.slice(rdataStart + 2 + tagLen, end).toString("utf8");
        return { flags, tag, value };
      }
      case RTYPE.DS: {
        if (rdLen < 4) return { raw: buf.slice(rdataStart, end).toString("hex") };
        const keyTag    = buf.readUInt16BE(rdataStart);
        const algorithm = buf[rdataStart + 2];
        const digestType = buf[rdataStart + 3];
        const digest    = buf.slice(rdataStart + 4, end).toString("hex");
        return { keyTag, algorithm, digestType, digest };
      }
      case RTYPE.DNSKEY: {
        if (rdLen < 4) return { raw: buf.slice(rdataStart, end).toString("hex") };
        const flags     = buf.readUInt16BE(rdataStart);
        const protocol  = buf[rdataStart + 2];
        const algorithm = buf[rdataStart + 3];
        const publicKey = buf.slice(rdataStart + 4, end).toString("base64");
        const zoneKey   = !!(flags & 0x0100);
        const sep       = !!(flags & 0x0001);
        return { flags, protocol, algorithm, publicKey, zoneKey, sep };
      }
      case RTYPE.NAPTR: {
        if (rdLen < 5) return { raw: buf.slice(rdataStart, end).toString("hex") };
        const order       = buf.readUInt16BE(rdataStart);
        const preference  = buf.readUInt16BE(rdataStart + 2);
        let pos = rdataStart + 4;
        const readStr = () => {
          if (pos >= end) return "";
          const slen = buf[pos++];
          if (pos + slen > end) return "";
          const s = buf.slice(pos, pos + slen).toString("ascii");
          pos += slen;
          return s;
        };
        const flags       = readStr();
        const service     = readStr();
        const regexp      = readStr();
        const { name: replacement } = pos < end ? readName(buf, pos) : { name: "." };
        return { order, preference, flags, service, regexp, replacement };
      }
      case RTYPE.HTTPS:
      case RTYPE.SVCB: {
        if (rdLen < 3) return { raw: buf.slice(rdataStart, end).toString("hex") };
        const priority = buf.readUInt16BE(rdataStart);
        const { name: target, end: nameEnd } = readName(buf, rdataStart + 2);
        // Remaining bytes are SvcParams (key-value pairs) — parse key IDs
        const params = {};
        let pos = nameEnd;
        while (pos + 4 <= end) {
          const key   = buf.readUInt16BE(pos);
          const vlen  = buf.readUInt16BE(pos + 2);
          pos += 4;
          const vbuf  = buf.slice(pos, pos + vlen);
          pos += vlen;
          // Well-known SvcParam keys
          const KEY_NAMES = { 0: "mandatory", 1: "alpn", 2: "no-default-alpn",
                              3: "port", 4: "ipv4hint", 5: "ech", 6: "ipv6hint" };
          const kname = KEY_NAMES[key] || `key${key}`;
          if (key === 1) {
            // alpn: list of length-prefixed strings
            const alpns = [];
            let ap = 0;
            while (ap < vbuf.length) {
              const al = vbuf[ap++];
              alpns.push(vbuf.slice(ap, ap + al).toString("ascii"));
              ap += al;
            }
            params[kname] = alpns;
          } else if (key === 3) {
            params[kname] = vbuf.readUInt16BE(0);
          } else if (key === 4) {
            const addrs = [];
            for (let i = 0; i + 4 <= vbuf.length; i += 4)
              addrs.push([...vbuf.slice(i, i + 4)].join("."));
            params[kname] = addrs;
          } else {
            params[kname] = vbuf.toString("hex");
          }
        }
        return { priority, target, params };
      }
      default:
        return { raw: buf.slice(rdataStart, end).toString("hex") };
    }
  } catch {
    return { raw: buf.slice(rdataStart, end).toString("hex") };
  }
}

/** Parse a full DNS response message */
function parseResponse(buf) {
  if (buf.length < 12) throw new Error("dns_client: response too short.");

  const id      = buf.readUInt16BE(0);
  const flags   = buf.readUInt16BE(2);
  const qr      = (flags >> 15) & 1;
  const opcode  = (flags >> 11) & 0xF;
  const aa      = (flags >> 10) & 1;
  const tc      = (flags >> 9)  & 1;  // truncated
  const rd      = (flags >> 8)  & 1;
  const ra      = (flags >> 7)  & 1;
  const rcode   = flags & 0xF;

  const qdCount = buf.readUInt16BE(4);
  const anCount = buf.readUInt16BE(6);
  const nsCount = buf.readUInt16BE(8);
  const arCount = buf.readUInt16BE(10);

  let pos = 12;

  // Skip question section
  const questions = [];
  for (let i = 0; i < qdCount && pos < buf.length; i++) {
    const { name, end } = readName(buf, pos);
    pos = end;
    if (pos + 4 > buf.length) break;
    const qtype  = buf.readUInt16BE(pos);
    const qclass = buf.readUInt16BE(pos + 2);
    pos += 4;
    questions.push({ name, qtype, qtypeName: RTYPE_REVERSE[qtype] || String(qtype), qclass });
  }

  const parseRRSection = (count) => {
    const rrs = [];
    for (let i = 0; i < count && pos < buf.length; i++) {
      const { name, end: nameEnd } = readName(buf, pos);
      pos = nameEnd;
      if (pos + 10 > buf.length) break;
      const rtype  = buf.readUInt16BE(pos);
      const rclass = buf.readUInt16BE(pos + 2);
      const ttl    = buf.readUInt32BE(pos + 4);
      const rdLen  = buf.readUInt16BE(pos + 8);
      pos += 10;
      const rdataStart = pos;
      pos += rdLen;
      const rdata = parseRdata(buf, rdataStart, rdLen, rtype);
      rrs.push({
        name,
        type:     RTYPE_REVERSE[rtype] || String(rtype),
        typeCode: rtype,
        class:    rclass === RCLASS_IN ? "IN" : String(rclass),
        ttl,
        rdata,
      });
    }
    return rrs;
  };

  const answers    = parseRRSection(anCount);
  const authority  = parseRRSection(nsCount);
  const additional = parseRRSection(arCount);

  return {
    id,
    flags: { qr, opcode, aa: !!aa, tc: !!tc, rd: !!rd, ra: !!ra, rcode },
    rcode,
    rcodeName:  RCODE_NAMES[rcode] || `RCODE${rcode}`,
    truncated:  !!tc,
    questions,
    answers,
    authority,
    additional,
    rawLength:  buf.length,
  };
}

// ── Transport: UDP ────────────────────────────────────────────────────────────

/**
 * Send a DNS query over UDP and return the raw response Buffer.
 * If the response is truncated (TC=1), caller should retry over TCP.
 */
function queryUdp(server, port, queryBuf, txId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket("udp4");
    let done = false;

    const cleanup = (err, result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.close(() => {});
      if (err) reject(err);
      else resolve(result);
    };

    const timer = setTimeout(() => {
      cleanup(new Error(
        `dns_client: UDP query to ${server}:${port} timed out after ${timeoutMs} ms.`
      ));
    }, timeoutMs);

    sock.on("error", (err) => {
      cleanup(new Error(`dns_client: UDP error querying ${server}:${port}: ${err.message}`));
    });

    sock.on("message", (msg) => {
      // Verify transaction ID
      if (msg.length < 2) return;
      const respId = msg.readUInt16BE(0);
      if (respId !== txId) return; // Not our reply
      cleanup(null, msg);
    });

    sock.send(queryBuf, 0, queryBuf.length, port, server, (err) => {
      if (err) cleanup(new Error(`dns_client: UDP send to ${server}:${port} failed: ${err.message}`));
    });
  });
}

// ── Transport: TCP ────────────────────────────────────────────────────────────

/**
 * Send a DNS query over TCP and return the raw response Buffer.
 * DNS over TCP: 2-byte length prefix before the message.
 */
function queryTcp(server, port, queryBuf, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: server, port, family: 0 });
    sock.setTimeout(timeoutMs);
    let done = false;
    const chunks = [];
    let expectedLen = -1;
    let received = 0;

    const cleanup = (err, result) => {
      if (done) return;
      done = true;
      sock.destroy();
      if (err) reject(err);
      else resolve(result);
    };

    sock.on("connect", () => {
      // Prefix with 2-byte length
      const lenBuf = Buffer.alloc(2);
      lenBuf.writeUInt16BE(queryBuf.length, 0);
      sock.write(Buffer.concat([lenBuf, queryBuf]));
    });

    sock.on("data", (chunk) => {
      chunks.push(chunk);
      received += chunk.length;
      if (received > MAX_TCP_BYTES) {
        cleanup(new Error(`dns_client: TCP response too large (>${MAX_TCP_BYTES} bytes).`));
        return;
      }
      // Parse 2-byte length prefix if we haven't yet
      const combined = Buffer.concat(chunks);
      if (expectedLen === -1 && combined.length >= 2) {
        expectedLen = combined.readUInt16BE(0);
      }
      if (expectedLen >= 0 && combined.length >= expectedLen + 2) {
        cleanup(null, combined.slice(2, 2 + expectedLen));
      }
    });

    sock.on("end",   () => {
      const combined = Buffer.concat(chunks);
      if (combined.length >= 2) cleanup(null, combined.slice(2));
      else cleanup(new Error("dns_client: TCP connection closed before response received."));
    });
    sock.on("close", () => cleanup(new Error("dns_client: TCP connection closed unexpectedly.")));
    sock.on("timeout", () =>
      cleanup(new Error(`dns_client: TCP query to ${server}:${port} timed out after ${timeoutMs} ms.`)));
    sock.on("error", (err) =>
      cleanup(new Error(`dns_client: TCP error querying ${server}:${port}: ${err.message}`)));
  });
}

// ── Transport: DNS-over-HTTPS (DoH) ──────────────────────────────────────────

/**
 * Send a DNS query over HTTPS (RFC 8484 application/dns-message).
 * Returns the raw DNS response Buffer.
 */
function queryDoh(dohUrl, queryBuf, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const cleanup = (err, result) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else resolve(result);
    };

    const url   = new URL(dohUrl);
    const isHttps = url.protocol === "https:";
    const lib   = isHttps ? https : http;
    const body  = queryBuf;
    const opts  = {
      hostname: url.hostname,
      port:     url.port || (isHttps ? 443 : 80),
      path:     url.pathname + (url.search || ""),
      method:   "POST",
      headers:  {
        "Content-Type":   "application/dns-message",
        "Accept":         "application/dns-message",
        "Content-Length": body.length,
      },
    };

    const timer = setTimeout(() => {
      cleanup(new Error(`dns_client: DoH query to ${dohUrl} timed out after ${timeoutMs} ms.`));
    }, timeoutMs);

    const req = lib.request(opts, (res) => {
      const chunks = [];
      let total = 0;
      res.on("data", (chunk) => {
        total += chunk.length;
        if (total > 65535 + 100) {
          cleanup(new Error("dns_client: DoH response too large."));
          res.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        if (res.statusCode !== 200) {
          cleanup(new Error(
            `dns_client: DoH server returned HTTP ${res.statusCode}.`
          ));
          return;
        }
        cleanup(null, Buffer.concat(chunks));
      });
      res.on("error", (err) =>
        cleanup(new Error(`dns_client: DoH response error: ${err.message}`)));
    });

    req.on("error", (err) =>
      cleanup(new Error(`dns_client: DoH request error: ${err.message}`)));
    req.end(body);
  });
}

// ── System resolver via built-in dns module ───────────────────────────────────

/** Use Node.js built-in dns module for system resolver queries */
async function querySystem(name, rtype) {
  const dnsP = dns.promises;
  const rtypeName = RTYPE_REVERSE[rtype] || String(rtype);

  try {
    switch (rtypeName) {
      case "A":      return (await dnsP.resolve4(name)).map(a => ({ rdata: { address: a }, type: "A" }));
      case "AAAA":   return (await dnsP.resolve6(name)).map(a => ({ rdata: { address: a }, type: "AAAA" }));
      case "MX":     return (await dnsP.resolveMx(name)).map(r => ({ rdata: { preference: r.priority, exchange: r.exchange }, type: "MX" }));
      case "TXT":    return (await dnsP.resolveTxt(name)).map(r => ({ rdata: { strings: r, text: r.join("") }, type: "TXT" }));
      case "NS":     return (await dnsP.resolveNs(name)).map(r => ({ rdata: { target: r }, type: "NS" }));
      case "CNAME":  return (await dnsP.resolveCname(name)).map(r => ({ rdata: { target: r }, type: "CNAME" }));
      case "PTR":    return (await dnsP.resolvePtr(name)).map(r => ({ rdata: { target: r }, type: "PTR" }));
      case "SOA":  {
        const r = await dnsP.resolveSoa(name);
        return [{ rdata: { mname: r.nsname, rname: r.hostmaster, serial: r.serial,
          refresh: r.refresh, retry: r.retry, expire: r.expire, minimum: r.minttl }, type: "SOA" }];
      }
      case "SRV":    return (await dnsP.resolveSrv(name)).map(r => ({ rdata: { priority: r.priority, weight: r.weight, port: r.port, target: r.name }, type: "SRV" }));
      case "NAPTR":  return (await dnsP.resolveNaptr(name)).map(r => ({ rdata: { order: r.order, preference: r.preference, flags: r.flags, service: r.service, regexp: r.regexp, replacement: r.replacement }, type: "NAPTR" }));
      case "CAA":    return (await dnsP.resolveCaa(name)).map(r => ({ rdata: { flags: r.critical ? 128 : 0, tag: r.issue ? "issue" : (r.issuewild ? "issuewild" : "iodef"), value: r.issue || r.issuewild || r.iodef || "" }, type: "CAA" }));
      default:       return [];
    }
  } catch (err) {
    const e = err;
    if (e.code === "ENOTFOUND" || e.code === "ENODATA") return [];
    throw new Error(`dns_client: system resolver error for '${name}' (${rtypeName}): ${e.message}`);
  }
}

// ── Core query function ───────────────────────────────────────────────────────

/**
 * Perform a single DNS query and return parsed results.
 * @param {string} name        - Domain name to query
 * @param {number} rtype       - Numeric record type
 * @param {object} opts        - { server, port, protocol, dohUrl, timeoutMs }
 * @returns {object}           - { answers, authority, additional, rcode, rcodeName, truncated, transport }
 */
async function dnsQuery(name, rtype, opts = {}) {
  const { server, port = 53, protocol = "udp", dohUrl, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;

  if (protocol === "system") {
    const answers = await querySystem(name, rtype);
    return {
      answers,
      authority:  [],
      additional: [],
      rcode:      0,
      rcodeName:  "NOERROR",
      truncated:  false,
      transport:  "system",
    };
  }

  const { buf: queryBuf, txId } = buildQuery(name, rtype);

  if (protocol === "doh" || protocol === "https") {
    const url = dohUrl || RESOLVER_PRESETS.cloudflare.doh;
    const respBuf = await queryDoh(url, queryBuf, timeoutMs);
    const parsed  = parseResponse(respBuf);
    return { ...parsed, transport: "doh" };
  }

  if (protocol === "tcp") {
    const respBuf = await queryTcp(server, port, queryBuf, timeoutMs);
    const parsed  = parseResponse(respBuf);
    return { ...parsed, transport: "tcp" };
  }

  // Default: UDP with TCP fallback on truncation
  const udpBuf = await queryUdp(server, port, queryBuf, txId, timeoutMs);
  const parsed  = parseResponse(udpBuf);
  if (parsed.truncated) {
    // Retry over TCP
    const tcpBuf    = await queryTcp(server, port, queryBuf, timeoutMs);
    const tcpParsed = parseResponse(tcpBuf);
    return { ...tcpParsed, transport: "tcp", udpTruncated: true };
  }
  return { ...parsed, transport: "udp" };
}

// ── Resolver resolution ───────────────────────────────────────────────────────

/** Resolve resolver preset name or IP/URL into { server, port, protocol, dohUrl } */
function resolveResolver(args) {
  const preset = (args.resolver || "cloudflare").toLowerCase();
  const protocol = args.protocol || null;

  if (preset === "system") {
    return { server: null, port: 53, protocol: "system", dohUrl: null };
  }

  if (preset === "doh" || protocol === "doh" || protocol === "https") {
    const url = args.doh_url || args.server || RESOLVER_PRESETS.cloudflare.doh;
    return { server: null, port: 53, protocol: "doh", dohUrl: url };
  }

  if (RESOLVER_PRESETS[preset]) {
    const p = RESOLVER_PRESETS[preset];
    if (preset === "system") return { server: null, port: 53, protocol: "system", dohUrl: null };
    // Use DoH if requested or if protocol is doh
    if (protocol === "doh" || protocol === "https") {
      return { server: null, port: 53, protocol: "doh", dohUrl: p.doh };
    }
    const server = args.server || p.ipv4[0];
    const port   = validatePort(args.port, p.port);
    const proto  = protocol || "udp";
    return { server, port, protocol: proto, dohUrl: null };
  }

  // Treat as custom IP or DoH URL
  if (args.server && (args.server.startsWith("https://") || args.server.startsWith("http://"))) {
    return { server: null, port: 53, protocol: "doh", dohUrl: args.server };
  }

  const server = args.server || RESOLVER_PRESETS.cloudflare.ipv4[0];
  const port   = validatePort(args.port, 53);
  const proto  = protocol || "udp";
  return { server, port, protocol: proto, dohUrl: null };
}

// ── Format a reverse PTR name ─────────────────────────────────────────────────

function reverseName(ip) {
  // IPv4: 1.2.3.4 → 4.3.2.1.in-addr.arpa
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    return ip.split(".").reverse().join(".") + ".in-addr.arpa";
  }
  // Must look like IPv6 (contains at least one colon)
  if (!ip.includes(":")) {
    throw new Error(`dns_client: invalid IP address '${ip}' for reverse lookup.`);
  }
  // IPv6: expand and reverse nibbles → x.x.x....ip6.arpa
  // Expand :: first
  const expandIPv6 = (addr) => {
    const groups = addr.split(":");
    const emptyIdx = groups.indexOf("");
    if (emptyIdx !== -1) {
      const fill = 8 - groups.filter(g => g !== "").length;
      groups.splice(emptyIdx, emptyIdx + 1 < groups.length && groups[emptyIdx + 1] === "" ? 2 : 1,
        ...Array(fill).fill("0000"));
    }
    return groups.map(g => g.padStart(4, "0")).join("");
  };
  try {
    const hex = expandIPv6(ip);
    if (hex.length !== 32) throw new Error("invalid length");
    return hex.split("").reverse().join(".") + ".ip6.arpa";
  } catch {
    throw new Error(`dns_client: invalid IP address '${ip}' for reverse lookup.`);
  }
}

// ── Operations ────────────────────────────────────────────────────────────────

/** query — Resolve one or more record types for a domain */
async function opQuery(args) {
  const name = (args.name || "").trim();
  if (!name) throw new Error("dns_client: 'name' is required for operation 'query'.");
  guardNul(name, "name");
  if (!validateDomain(name))
    throw new Error(`dns_client: invalid domain name '${name}'.`);

  // Normalise type(s)
  const rawTypes = args.type
    ? (Array.isArray(args.type) ? args.type : [args.type])
    : ["A"];
  const rtypes = rawTypes.map(resolveRtype);

  const timeoutMs   = clampTimeout(args.timeout);
  const resolverOpts = resolveResolver(args);
  const queryOpts   = { ...resolverOpts, timeoutMs };

  if (resolverOpts.server) guardNul(resolverOpts.server, "server");
  if (resolverOpts.dohUrl) guardNul(resolverOpts.dohUrl, "doh_url");

  const t0 = Date.now();

  // Query each type (in parallel for multi-type)
  const results = await Promise.all(
    rtypes.map(async (rtype) => {
      const rt0 = Date.now();
      try {
        const res = await dnsQuery(name, rtype, queryOpts);
        return {
          type:       RTYPE_REVERSE[rtype] || String(rtype),
          ok:         res.rcode === 0,
          rcode:      res.rcode,
          rcodeName:  res.rcodeName,
          truncated:  res.truncated,
          transport:  res.transport,
          elapsedMs:  Date.now() - rt0,
          answers:    res.answers,
          authority:  res.authority,
          additional: res.additional,
        };
      } catch (err) {
        return {
          type:      RTYPE_REVERSE[rtype] || String(rtype),
          ok:        false,
          error:     err.message,
          elapsedMs: Date.now() - rt0,
          answers: [], authority: [], additional: [],
        };
      }
    })
  );

  const totalElapsed = Date.now() - t0;
  const resolver = resolverOpts.server || resolverOpts.dohUrl || resolverOpts.protocol;

  // If single type, flatten
  if (rtypes.length === 1) {
    const r = results[0];
    return {
      ok:        r.ok,
      operation: "query",
      name,
      type:      r.type,
      resolver,
      transport: r.transport,
      rcode:     r.rcode,
      rcodeName: r.rcodeName,
      elapsedMs: totalElapsed,
      answers:   r.answers,
      authority:  r.authority,
      additional: r.additional,
      error:     r.error,
    };
  }

  return {
    ok:        results.every(r => r.ok),
    operation: "query",
    name,
    types:     rawTypes,
    resolver,
    elapsedMs: totalElapsed,
    results,
  };
}

/** reverse — PTR lookup for an IP */
async function opReverse(args) {
  const ip = (args.ip || "").trim();
  if (!ip) throw new Error("dns_client: 'ip' is required for operation 'reverse'.");
  guardNul(ip, "ip");

  const ptrName = reverseName(ip);

  const timeoutMs    = clampTimeout(args.timeout);
  const resolverOpts = resolveResolver(args);
  const queryOpts    = { ...resolverOpts, timeoutMs };

  if (resolverOpts.server) guardNul(resolverOpts.server, "server");

  const t0  = Date.now();
  let result;
  try {
    result = await dnsQuery(ptrName, RTYPE.PTR, queryOpts);
  } catch (err) {
    return {
      ok:        false,
      operation: "reverse",
      ip,
      ptrName,
      error:     err.message,
      elapsedMs: Date.now() - t0,
    };
  }

  const hostnames = result.answers
    .filter(rr => rr.type === "PTR")
    .map(rr => rr.rdata.target);

  return {
    ok:        result.rcode === 0,
    operation: "reverse",
    ip,
    ptrName,
    rcode:     result.rcode,
    rcodeName: result.rcodeName,
    transport: result.transport,
    elapsedMs: Date.now() - t0,
    hostnames,
    answers:   result.answers,
  };
}

/** batch — Multiple queries in parallel */
async function opBatch(args) {
  if (!Array.isArray(args.queries) || args.queries.length === 0)
    throw new Error("dns_client: 'queries' is required and must be a non-empty array for operation 'batch'.");
  if (args.queries.length > MAX_BATCH_QUERIES)
    throw new Error(
      `dns_client: 'queries' length exceeds maximum (${args.queries.length} > ${MAX_BATCH_QUERIES}).`
    );

  const timeoutMs    = clampTimeout(args.timeout);
  const resolverOpts = resolveResolver(args);

  const t0 = Date.now();
  const results = await Promise.all(
    args.queries.map(async (q, idx) => {
      const name = (q.name || "").trim();
      if (!name) return { index: idx, ok: false, error: "'name' is required", name, type: q.type || "A" };
      if (!validateDomain(name)) return { index: idx, ok: false, error: `invalid domain '${name}'`, name, type: q.type || "A" };
      const rtype = resolveRtype(q.type || "A");
      const qOpts = { ...resolverOpts, timeoutMs };
      const qt0   = Date.now();
      try {
        const res = await dnsQuery(name, rtype, qOpts);
        return {
          index:     idx,
          ok:        res.rcode === 0,
          name,
          type:      RTYPE_REVERSE[rtype] || String(rtype),
          rcode:     res.rcode,
          rcodeName: res.rcodeName,
          transport: res.transport,
          elapsedMs: Date.now() - qt0,
          answers:   res.answers,
        };
      } catch (err) {
        return {
          index:     idx,
          ok:        false,
          name,
          type:      RTYPE_REVERSE[rtype] || String(rtype),
          error:     err.message,
          elapsedMs: Date.now() - qt0,
          answers:   [],
        };
      }
    })
  );

  return {
    ok:        results.every(r => r.ok),
    operation: "batch",
    resolver:  resolverOpts.server || resolverOpts.dohUrl || resolverOpts.protocol,
    totalElapsedMs: Date.now() - t0,
    queryCount: args.queries.length,
    results,
  };
}

/** resolvers — Return resolver preset info */
function opResolvers(args) {
  return {
    ok:        true,
    operation: "resolvers",
    resolvers: RESOLVER_PRESETS,
    defaultResolver: "cloudflare",
    note: "Pass resolver='cloudflare'|'google'|'quad9'|'system' to query ops. " +
          "For DoH use protocol='doh' or pass a doh_url or https:// server URL.",
  };
}

/** info — Return tool config and record type table */
function opInfo(args) {
  return {
    ok:         true,
    operation:  "info",
    protocols:  ["udp", "tcp", "doh", "system"],
    defaultProtocol: "udp",
    defaultResolver: "cloudflare",
    defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
    maxBatchQueries: MAX_BATCH_QUERIES,
    recordTypes: Object.fromEntries(
      Object.entries(RTYPE).map(([name, code]) => [name, { code, description: RTYPE_DESCRIPTIONS[name] || "" }])
    ),
    resolverPresets: Object.fromEntries(
      Object.entries(RESOLVER_PRESETS).map(([k, v]) => [k, { name: v.name, description: v.description }])
    ),
    rcodes: RCODE_NAMES,
    notes: [
      "UDP is used by default with automatic TCP fallback on truncation.",
      "DoH (DNS-over-HTTPS) encrypts DNS traffic; use protocol='doh' or pass an https:// doh_url.",
      "'system' protocol uses the OS resolver via Node.js dns.promises (no custom server/port).",
      "batch supports up to 20 queries in parallel.",
      "All record types: A AAAA MX TXT NS SOA CNAME PTR SRV CAA DNSKEY DS NAPTR HTTPS SVCB.",
    ],
  };
}

const RTYPE_DESCRIPTIONS = {
  A:      "IPv4 host address",
  AAAA:   "IPv6 host address",
  NS:     "Authoritative name server",
  CNAME:  "Canonical name (alias)",
  SOA:    "Start of authority",
  PTR:    "Pointer (reverse DNS)",
  MX:     "Mail exchange",
  TXT:    "Text record",
  SRV:    "Service location",
  CAA:    "Certification authority authorization",
  DS:     "Delegation signer (DNSSEC)",
  DNSKEY: "DNS public key (DNSSEC)",
  NAPTR:  "Naming authority pointer",
  HTTPS:  "HTTPS service binding",
  SVCB:   "Service binding",
};

// ── Main entry point ──────────────────────────────────────────────────────────
async function dnsClient(args) {
  const op = args.operation;
  if (!op) throw new Error("dns_client: 'operation' is required.");

  switch (op) {
    case "query":     return opQuery(args);
    case "reverse":   return opReverse(args);
    case "batch":     return opBatch(args);
    case "resolvers": return opResolvers(args);
    case "info":      return opInfo(args);
    default:
      throw new Error(
        `dns_client: unknown operation '${op}'. ` +
        `Valid: query, reverse, batch, resolvers, info.`
      );
  }
}

module.exports = {
  dnsClient,
  // Exported for testing
  buildQuery,
  parseResponse,
  encodeDomainName,
  readName,
  parseRdata,
  reverseName,
  validateDomain,
  resolveRtype,
  RTYPE,
  RTYPE_REVERSE,
  RCODE_NAMES,
  RESOLVER_PRESETS,
};
