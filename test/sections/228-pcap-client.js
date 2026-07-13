"use strict";
// test/sections/228-pcap-client.js
// Isolated tests for pcap_client tool (lib/pcapClientOps.js)
// Five rigor levels: A=validation, B=unit, C=happy-path, D=security, E=error-paths, F=concurrency

const path = require("path");
const fs   = require("fs");
const os   = require("os");

const { pcapClient } = require("../../lib/pcapClientOps");

// ── Test runner ─────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];
const asyncTests = [];

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      const p = r.then(() => { passed++; }).catch(e => {
        failed++;
        failures.push({ name, error: e.message || String(e) });
        process.stderr.write(`  FAIL: ${name}\n       ${e.message}\n`);
      });
      asyncTests.push(p);
      return p;
    }
    passed++;
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message || String(e) });
    process.stderr.write(`  FAIL: ${name}\n       ${e.message}\n`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

function assertEq(a, b, msg) {
  const sa = JSON.stringify(a);
  const sb = JSON.stringify(b);
  if (sa !== sb) throw new Error((msg || "not equal") + `\n  got:      ${sa}\n  expected: ${sb}`);
}

function assertIncludes(str, sub, msg) {
  if (!String(str).includes(sub)) throw new Error((msg || `expected to include '${sub}'`) + `\n  got: ${str}`);
}

function assertThrows(fn, msgMatch) {
  let threw = false;
  try { fn(); } catch (e) {
    threw = true;
    if (msgMatch && !e.message.includes(msgMatch))
      throw new Error(`Expected error containing '${msgMatch}' but got: ${e.message}`);
  }
  if (!threw) throw new Error(`Expected an error but none was thrown`);
}

// Fake resolveClientPath — just returns { resolved: absPath }
function resolve(p) {
  return { resolved: path.resolve(p) };
}

// ── PCAP binary builder ─────────────────────────────────────────────────────
// Classic PCAP: global header (24 bytes) + per-packet records (16 + caplen bytes)
//   Global header: magic(4) vMaj(2) vMin(2) thiszone(4) sigfigs(4) snaplen(4) dlt(4)
//   Packet record: ts_sec(4) ts_usec(4) incl_len(4) orig_len(4) + data

const PCAP_MAGIC_LE = 0xa1b2c3d4;

function buildGlobalHeader(opts = {}) {
  const magic   = opts.magic   !== undefined ? opts.magic   : PCAP_MAGIC_LE;
  const snaplen = opts.snaplen !== undefined ? opts.snaplen : 65535;
  const dlt     = opts.dlt    !== undefined ? opts.dlt    : 1;  // ETHERNET
  const buf = Buffer.alloc(24);
  buf.writeUInt32LE(magic,   0);
  buf.writeUInt16LE(2,       4); // version major
  buf.writeUInt16LE(4,       6); // version minor
  buf.writeInt32LE(0,        8); // thiszone
  buf.writeUInt32LE(0,       12); // sigfigs
  buf.writeUInt32LE(snaplen, 16);
  buf.writeUInt32LE(dlt,     20);
  return buf;
}

function buildPcapPacketRecord(data, tsMs = 0, origLen) {
  const inclLen = data.length;
  if (origLen === undefined) origLen = inclLen;
  const tsSec  = Math.floor(tsMs / 1000);
  const tsUsec = ((tsMs % 1000) * 1000) | 0;
  const hdr = Buffer.alloc(16);
  hdr.writeUInt32LE(tsSec,   0);
  hdr.writeUInt32LE(tsUsec,  4);
  hdr.writeUInt32LE(inclLen, 8);
  hdr.writeUInt32LE(origLen, 12);
  return Buffer.concat([hdr, data]);
}

function buildPcapFile(packets, opts = {}) {
  const hdr = buildGlobalHeader(opts);
  const recs = packets.map(p => buildPcapPacketRecord(p.data || Buffer.alloc(0), p.ts || 0, p.orig));
  return Buffer.concat([hdr, ...recs]);
}

// Build a minimal Ethernet + IPv4 + TCP packet buffer
function buildEthIPv4TCPPacket(opts = {}) {
  const srcMac = opts.srcMac || [0x00, 0x11, 0x22, 0x33, 0x44, 0x55];
  const dstMac = opts.dstMac || [0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb];
  const srcIP  = opts.srcIP  || [10, 0, 0, 1];
  const dstIP  = opts.dstIP  || [10, 0, 0, 2];
  const srcPort = opts.srcPort || 1234;
  const dstPort = opts.dstPort || 80;
  const flags   = opts.flags  || 0x02; // SYN

  // Ethernet header (14)
  const eth = Buffer.alloc(14);
  dstMac.forEach((b, i) => eth.writeUInt8(b, i));
  srcMac.forEach((b, i) => eth.writeUInt8(b, 6 + i));
  eth.writeUInt16BE(0x0800, 12); // IPv4

  // IPv4 header (20)
  const ip = Buffer.alloc(20);
  ip.writeUInt8(0x45, 0);   // version=4, IHL=5
  ip.writeUInt8(0, 1);      // TOS
  ip.writeUInt16BE(40, 2);  // total length = 20+20
  ip.writeUInt16BE(0, 4);   // ID
  ip.writeUInt16BE(0, 6);   // flags+fragment
  ip.writeUInt8(64, 8);     // TTL
  ip.writeUInt8(6, 9);      // TCP
  ip.writeUInt16BE(0, 10);  // checksum (0 ok for test)
  srcIP.forEach((b, i) => ip.writeUInt8(b, 12 + i));
  dstIP.forEach((b, i) => ip.writeUInt8(b, 16 + i));

  // TCP header (20)
  const tcp = Buffer.alloc(20);
  tcp.writeUInt16BE(srcPort, 0);
  tcp.writeUInt16BE(dstPort, 2);
  tcp.writeUInt32BE(1000, 4);  // seq
  tcp.writeUInt32BE(0, 8);     // ack
  tcp.writeUInt8(0x50, 12);    // data offset = 5 (20 bytes)
  tcp.writeUInt8(flags, 13);
  tcp.writeUInt16BE(65535, 14); // window
  tcp.writeUInt16BE(0, 16);    // checksum
  tcp.writeUInt16BE(0, 18);    // urgent

  return Buffer.concat([eth, ip, tcp]);
}

function buildEthIPv4UDPPacket(srcPort, dstPort) {
  const eth = Buffer.alloc(14);
  eth.writeUInt16BE(0x0800, 12);
  const ip = Buffer.alloc(20);
  ip.writeUInt8(0x45, 0);
  ip.writeUInt8(17, 9); // UDP
  const udp = Buffer.alloc(8);
  udp.writeUInt16BE(srcPort, 0);
  udp.writeUInt16BE(dstPort, 2);
  udp.writeUInt16BE(8, 4);
  return Buffer.concat([eth, ip, udp]);
}

function buildEthARPPacket() {
  const buf = Buffer.alloc(28);
  buf.writeUInt16BE(0x0806, 12); // ethertype ARP (in the 14-byte eth header at offset 12)
  // Actually build properly: eth (14) + ARP (28) total 42 bytes
  const eth = Buffer.alloc(14);
  eth.writeUInt16BE(0x0806, 12);
  const arp = Buffer.alloc(28);
  return Buffer.concat([eth, arp]);
}

// Build a minimal PCAPng file (SHB + IDB + EPB)
const PCAPNG_SHB = 0x0a0d0d0a;
const PCAPNG_IDB = 0x00000001;
const PCAPNG_EPB = 0x00000006;

function buildPcapngFile(packets, opts = {}) {
  const dlt = opts.dlt !== undefined ? opts.dlt : 1; // ETHERNET

  // SHB: type(4) + totalLen(4) + BOM(4) + vMaj(2) + vMin(2) + sectionLen(8) + totalLen(4)
  const shbBody = Buffer.alloc(16);
  shbBody.writeUInt32LE(0x1A2B3C4D, 0); // byte-order magic
  shbBody.writeUInt16LE(1, 4);           // version major
  shbBody.writeUInt16LE(0, 6);           // version minor
  shbBody.writeBigInt64LE(-1n, 8);       // section length = -1 (unspecified)
  const shbLen = 12 + shbBody.length;
  const shb = Buffer.alloc(shbLen);
  shb.writeUInt32LE(PCAPNG_SHB, 0);
  shb.writeUInt32LE(shbLen, 4);
  shbBody.copy(shb, 8);
  shb.writeUInt32LE(shbLen, shbLen - 4);

  // IDB: type(4) + totalLen(4) + linkType(2) + reserved(2) + snaplen(4) + totalLen(4)
  const idbLen = 20;
  const idb = Buffer.alloc(idbLen);
  idb.writeUInt32LE(PCAPNG_IDB, 0);
  idb.writeUInt32LE(idbLen, 4);
  idb.writeUInt16LE(dlt, 8);
  idb.writeUInt16LE(0, 10); // reserved
  idb.writeUInt32LE(65535, 12); // snaplen
  idb.writeUInt32LE(idbLen, 16);

  const blocks = [shb, idb];

  for (const pkt of packets) {
    const pktData = pkt.data || Buffer.alloc(0);
    const captLen = pktData.length;
    // EPB body: ifaceIdx(4) tsHigh(4) tsLow(4) captLen(4) origLen(4) + pktData + padding
    const padLen = (4 - (captLen % 4)) % 4;
    const epbBodyLen = 20 + captLen + padLen;
    const epbLen = 12 + epbBodyLen;
    const epb = Buffer.alloc(epbLen, 0);
    epb.writeUInt32LE(PCAPNG_EPB, 0);
    epb.writeUInt32LE(epbLen, 4);
    epb.writeUInt32LE(0, 8);  // interface index
    const tsMs = pkt.ts || 0;
    const tsUs = BigInt(Math.round(tsMs * 1000));
    epb.writeUInt32LE(Number(tsUs >> 32n), 12); // ts high
    epb.writeUInt32LE(Number(tsUs & 0xFFFFFFFFn), 16); // ts low
    epb.writeUInt32LE(captLen, 20);
    epb.writeUInt32LE(captLen, 24);
    pktData.copy(epb, 28);
    epb.writeUInt32LE(epbLen, epbLen - 4);
    blocks.push(epb);
  }

  return Buffer.concat(blocks);
}

function writeTmp(buf, ext = ".pcap") {
  const f = path.join(os.tmpdir(), `pcap-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  fs.writeFileSync(f, buf);
  return f;
}

// ── Section A: Input validation (10 tests) ──────────────────────────────────
process.stderr.write("\nSection A: validation\n");

test("A01 missing operation throws", () => {
  const tmp = writeTmp(buildPcapFile([]));
  try {
    assertThrows(() => pcapClient({ path: tmp }, resolve), "operation");
  } finally { fs.unlinkSync(tmp); }
});

test("A02 missing path throws", () => {
  assertThrows(() => pcapClient({ operation: "info" }, resolve), "path");
});

test("A03 empty path throws", () => {
  assertThrows(() => pcapClient({ operation: "info", path: "" }, resolve), "path");
});

test("A04 NUL-byte in path throws", () => {
  assertThrows(() => pcapClient({ operation: "info", path: "foo\0bar" }, resolve), "NUL");
});

test("A05 directory path throws", () => {
  assertThrows(() => pcapClient({ operation: "info", path: os.tmpdir() }, resolve), "directory");
});

test("A06 nonexistent file throws", () => {
  assertThrows(() => pcapClient({ operation: "info", path: "/nonexistent/abc.pcap" }, resolve));
});

test("A07 invalid magic throws", () => {
  const tmp = writeTmp(Buffer.from("not-a-pcap-file!"));
  try {
    assertThrows(() => pcapClient({ operation: "info", path: tmp }, resolve), "unrecognised");
  } finally { fs.unlinkSync(tmp); }
});

test("A08 file too short for PCAP global header throws", () => {
  const tmp = writeTmp(Buffer.from([0xd4, 0xc3, 0xb2, 0xa1, 0x01]));
  try {
    // big-endian magic but only 5 bytes
    assertThrows(() => pcapClient({ operation: "info", path: tmp }, resolve));
  } finally { fs.unlinkSync(tmp); }
});

test("A09 filter operation without filter expression throws", () => {
  const pktData = buildEthIPv4TCPPacket();
  const pcapBuf = buildPcapFile([{ data: pktData }]);
  const tmp = writeTmp(pcapBuf);
  try {
    assertThrows(
      () => pcapClient({ operation: "filter", path: tmp }, resolve),
      "filter"
    );
  } finally { fs.unlinkSync(tmp); }
});

test("A10 invalid filter expression throws", () => {
  const pcapBuf = buildPcapFile([{ data: buildEthIPv4TCPPacket() }]);
  const tmp = writeTmp(pcapBuf);
  try {
    assertThrows(
      () => pcapClient({ operation: "filter", path: tmp, filter: "!!!invalid" }, resolve)
    );
  } finally { fs.unlinkSync(tmp); }
});

// ── Section B: Unit / parser correctness (20 tests) ─────────────────────────
process.stderr.write("\nSection B: unit\n");

test("B01 PCAP info: correct format and link type", () => {
  const buf = buildPcapFile([]);
  const tmp = writeTmp(buf);
  try {
    const r = pcapClient({ operation: "info", path: tmp }, resolve);
    assertEq(r.format, "PCAP");
    assertEq(r.link_type, "ETHERNET");
    assertEq(r.endian, "little");
    assertEq(r.dlt, 1);
    assertEq(r.total_packets, 0);
  } finally { fs.unlinkSync(tmp); }
});

test("B02 PCAP read: one TCP SYN packet decoded correctly", () => {
  const pktData = buildEthIPv4TCPPacket({ srcPort: 54321, dstPort: 443, flags: 0x02 });
  const buf = buildPcapFile([{ data: pktData, ts: 1000 }]);
  const tmp = writeTmp(buf);
  try {
    const r = pcapClient({ operation: "read", path: tmp }, resolve);
    assertEq(r.total_packets, 1);
    assertEq(r.packets.length, 1);
    const p = r.packets[0];
    assertEq(p.protocol, "TCP");
    assertEq(p.src_port, 54321);
    assertEq(p.dst_port, 443);
    assertEq(p.tcp_flags, "SYN");
    assertEq(p.src_ip, "10.0.0.1");
    assertEq(p.dst_ip, "10.0.0.2");
    assertEq(p.ip_version, 4);
    assertEq(p.index, 1);
    assertEq(p.captured_bytes, pktData.length);
  } finally { fs.unlinkSync(tmp); }
});

test("B03 PCAP read: TCP SYN-ACK flags decoded", () => {
  const pktData = buildEthIPv4TCPPacket({ flags: 0x12 }); // SYN + ACK
  const buf = buildPcapFile([{ data: pktData }]);
  const tmp = writeTmp(buf);
  try {
    const r = pcapClient({ operation: "read", path: tmp }, resolve);
    assertEq(r.packets[0].tcp_flags, "SYN|ACK");
  } finally { fs.unlinkSync(tmp); }
});

test("B04 PCAP read: UDP DNS packet app_protocol detected", () => {
  const pktData = buildEthIPv4UDPPacket(1234, 53);
  const buf = buildPcapFile([{ data: pktData }]);
  const tmp = writeTmp(buf);
  try {
    const r = pcapClient({ operation: "read", path: tmp }, resolve);
    const p = r.packets[0];
    assertEq(p.protocol, "UDP");
    assertEq(p.dst_port, 53);
    assertEq(p.app_protocol, "DNS");
  } finally { fs.unlinkSync(tmp); }
});

test("B05 PCAP read: UDP DHCP app_protocol detected", () => {
  const pktData = buildEthIPv4UDPPacket(68, 67); // DHCP
  const buf = buildPcapFile([{ data: pktData }]);
  const tmp = writeTmp(buf);
  try {
    const r = pcapClient({ operation: "read", path: tmp }, resolve);
    assertEq(r.packets[0].app_protocol, "DHCP");
  } finally { fs.unlinkSync(tmp); }
});

test("B06 PCAP read: ARP packet identified", () => {
  const pktData = buildEthARPPacket();
  const buf = buildPcapFile([{ data: pktData }]);
  const tmp = writeTmp(buf);
  try {
    const r = pcapClient({ operation: "read", path: tmp }, resolve);
    assertEq(r.packets[0].protocol, "ARP");
  } finally { fs.unlinkSync(tmp); }
});

test("B07 PCAP read: offset and limit work correctly", () => {
  const pkts = [0, 1, 2, 3, 4].map(i => ({ data: buildEthIPv4TCPPacket({ srcPort: 1000 + i }) }));
  const buf  = buildPcapFile(pkts);
  const tmp  = writeTmp(buf);
  try {
    const r = pcapClient({ operation: "read", path: tmp, offset: 1, limit: 2 }, resolve);
    assertEq(r.total_packets, 5);
    assertEq(r.displayed_packets, 2);
    assertEq(r.packets[0].src_port, 1001);
    assertEq(r.packets[1].src_port, 1002);
  } finally { fs.unlinkSync(tmp); }
});

test("B08 PCAP read: timestamps are iso strings and epoch_ms correct", () => {
  const buf = buildPcapFile([{ data: buildEthIPv4TCPPacket(), ts: 1_000_000 }]); // 1000 seconds
  const tmp = writeTmp(buf);
  try {
    const r = pcapClient({ operation: "read", path: tmp }, resolve);
    const p = r.packets[0];
    assert(typeof p.timestamp === "string", "timestamp should be string");
    assert(p.timestamp.endsWith("Z"), "timestamp should be ISO UTC");
    assertEq(p.timestamp_epoch_ms, 1_000_000);
  } finally { fs.unlinkSync(tmp); }
});

test("B09 PCAP info: nanosecond variant detected", () => {
  // Nanosecond magic LE: 0xa1b23c4d
  const buf = buildPcapFile([], { magic: 0xa1b23c4d });
  const tmp = writeTmp(buf);
  try {
    const r = pcapClient({ operation: "info", path: tmp }, resolve);
    assertEq(r.nanosecond, true);
  } finally { fs.unlinkSync(tmp); }
});

test("B10 PCAP info: big-endian variant detected", () => {
  // Big-endian PCAP: parser reads buf.readUInt32LE(0) === PCAP_MAGIC_BE(0xd4c3b2a1).
  // So bytes on disk must be [a1,b2,c3,d4] => buf.writeUInt32LE(0xd4c3b2a1).
  // All other header fields follow big-endian byte order.
  const buf = Buffer.alloc(24);
  buf.writeUInt32LE(0xd4c3b2a1, 0); // BE magic: bytes [a1,b2,c3,d4] on disk
  buf.writeUInt16BE(2, 4);
  buf.writeUInt16BE(4, 6);
  buf.writeInt32BE(0, 8);
  buf.writeUInt32BE(0, 12);
  buf.writeUInt32BE(65535, 16);
  buf.writeUInt32BE(1, 20);
  const tmp = writeTmp(buf);
  try {
    const r = pcapClient({ operation: "info", path: tmp }, resolve);
    assertEq(r.endian, "big");
    assertEq(r.format, "PCAP");
  } finally { fs.unlinkSync(tmp); }
});

test("B11 PCAPng info: format, version, interface list", () => {
  const buf = buildPcapngFile([]);
  const tmp = writeTmp(buf, ".pcapng");
  try {
    const r = pcapClient({ operation: "info", path: tmp }, resolve);
    assertEq(r.format, "PCAPng");
    assertEq(r.version, "1.0");
    assert(Array.isArray(r.interfaces), "interfaces should be array");
    assertEq(r.interfaces.length, 1);
    assertEq(r.interfaces[0].link_type_name, "ETHERNET");
  } finally { fs.unlinkSync(tmp); }
});

test("B12 PCAPng read: EPB packet decoded", () => {
  const pktData = buildEthIPv4TCPPacket({ srcPort: 9000, dstPort: 22, flags: 0x02 });
  const buf = buildPcapngFile([{ data: pktData, ts: 5000 }]);
  const tmp = writeTmp(buf, ".pcapng");
  try {
    const r = pcapClient({ operation: "read", path: tmp }, resolve);
    assertEq(r.total_packets, 1);
    assertEq(r.packets[0].protocol, "TCP");
    assertEq(r.packets[0].src_port, 9000);
    assertEq(r.packets[0].dst_port, 22);
    assertEq(r.packets[0].tcp_flags, "SYN");
  } finally { fs.unlinkSync(tmp); }
});

test("B13 PCAP summary: protocol counts and byte totals", () => {
  const pktTCP = buildEthIPv4TCPPacket();
  const pktUDP = buildEthIPv4UDPPacket(1234, 5678);
  const buf = buildPcapFile([
    { data: pktTCP }, { data: pktTCP }, { data: pktUDP },
  ]);
  const tmp = writeTmp(buf);
  try {
    const r = pcapClient({ operation: "summary", path: tmp }, resolve);
    const s = r.summary;
    assertEq(s.packet_count, 3);
    assertEq(s.protocols.TCP, 2);
    assertEq(s.protocols.UDP, 1);
    assert(s.total_bytes > 0, "total_bytes should be positive");
  } finally { fs.unlinkSync(tmp); }
});

test("B14 PCAP filter: protocol==TCP returns only TCP packets", () => {
  const pktTCP = buildEthIPv4TCPPacket();
  const pktUDP = buildEthIPv4UDPPacket(1234, 5678);
  const buf = buildPcapFile([{ data: pktTCP }, { data: pktUDP }, { data: pktTCP }]);
  const tmp = writeTmp(buf);
  try {
    const r = pcapClient({ operation: "filter", path: tmp, filter: "protocol==TCP" }, resolve);
    assertEq(r.matched_packets, 2);
    r.packets.forEach(p => assertEq(p.protocol, "TCP"));
  } finally { fs.unlinkSync(tmp); }
});

test("B15 PCAP filter: dst_port==80 filter matches correctly", () => {
  const p80 = buildEthIPv4TCPPacket({ dstPort: 80 });
  const p443 = buildEthIPv4TCPPacket({ dstPort: 443 });
  const buf = buildPcapFile([{ data: p80 }, { data: p443 }, { data: p80 }]);
  const tmp = writeTmp(buf);
  try {
    const r = pcapClient({ operation: "filter", path: tmp, filter: "dst_port==80" }, resolve);
    assertEq(r.matched_packets, 2);
    r.packets.forEach(p => assertEq(p.dst_port, 80));
  } finally { fs.unlinkSync(tmp); }
});

test("B16 PCAP filter: compound && filter", () => {
  const pktTCP80  = buildEthIPv4TCPPacket({ dstPort: 80 });
  const pktTCP443 = buildEthIPv4TCPPacket({ dstPort: 443 });
  const pktUDP80  = buildEthIPv4UDPPacket(1234, 80);
  const buf = buildPcapFile([{ data: pktTCP80 }, { data: pktTCP443 }, { data: pktUDP80 }]);
  const tmp = writeTmp(buf);
  try {
    const r = pcapClient({ operation: "filter", path: tmp, filter: "protocol==TCP && dst_port==80" }, resolve);
    assertEq(r.matched_packets, 1);
    assertEq(r.packets[0].protocol, "TCP");
    assertEq(r.packets[0].dst_port, 80);
  } finally { fs.unlinkSync(tmp); }
});

test("B17 PCAP filter: || OR filter", () => {
  const pktTCP = buildEthIPv4TCPPacket({ dstPort: 80 });
  const pktUDP = buildEthIPv4UDPPacket(1234, 53);
  const pktARP = buildEthARPPacket();
  const buf = buildPcapFile([{ data: pktTCP }, { data: pktUDP }, { data: pktARP }]);
  const tmp = writeTmp(buf);
  try {
    const r = pcapClient({ operation: "filter", path: tmp, filter: "protocol==TCP || protocol==UDP" }, resolve);
    assertEq(r.matched_packets, 2);
  } finally { fs.unlinkSync(tmp); }
});

test("B18 PCAP to_json: returns json string inline", () => {
  const buf = buildPcapFile([{ data: buildEthIPv4TCPPacket() }]);
  const tmp = writeTmp(buf);
  try {
    const r = pcapClient({ operation: "to_json", path: tmp }, resolve);
    assert(typeof r.json === "string", "json should be a string");
    const obj = JSON.parse(r.json);
    assertEq(obj.total_packets, 1);
    assertEq(obj.packets.length, 1);
  } finally { fs.unlinkSync(tmp); }
});

test("B19 PCAP to_json: writes output_file when specified", () => {
  const buf = buildPcapFile([{ data: buildEthIPv4TCPPacket() }]);
  const tmp = writeTmp(buf);
  const out = tmp + ".json";
  try {
    const r = pcapClient({ operation: "to_json", path: tmp, output_file: out }, resolve);
    assert(r.bytes_written > 0, "bytes_written should be positive");
    assert(fs.existsSync(out), "output file should exist");
    const obj = JSON.parse(fs.readFileSync(out, "utf8"));
    assertEq(obj.total_packets, 1);
  } finally {
    fs.unlinkSync(tmp);
    if (fs.existsSync(out)) fs.unlinkSync(out);
  }
});

test("B20 PCAP read: truncated_packet flag set when incl_len < orig_len", () => {
  const data = buildEthIPv4TCPPacket();
  // Build pcap file and manually set orig_len larger than incl_len
  const ghdr = buildGlobalHeader();
  const pktHdr = Buffer.alloc(16);
  pktHdr.writeUInt32LE(0, 0);           // ts_sec
  pktHdr.writeUInt32LE(0, 4);           // ts_usec
  pktHdr.writeUInt32LE(data.length, 8); // incl_len
  pktHdr.writeUInt32LE(data.length + 100, 12); // orig_len > incl_len
  const buf = Buffer.concat([ghdr, pktHdr, data]);
  const tmp = writeTmp(buf);
  try {
    const r = pcapClient({ operation: "read", path: tmp }, resolve);
    assertEq(r.packets[0].truncated_packet, true);
  } finally { fs.unlinkSync(tmp); }
});

// ── Section C: Happy-path / multiple-packet (20 tests) ──────────────────────
process.stderr.write("\nSection C: happy-path\n");

test("C01 PCAP with 100 TCP packets: info returns correct count", () => {
  const pkts = Array.from({ length: 100 }, (_, i) => ({ data: buildEthIPv4TCPPacket(), ts: i * 10 }));
  const buf = buildPcapFile(pkts);
  const tmp = writeTmp(buf);
  try {
    const r = pcapClient({ operation: "info", path: tmp }, resolve);
    assertEq(r.total_packets, 100);
  } finally { fs.unlinkSync(tmp); }
});

test("C02 PCAP read with limit: limit respected for large file", () => {
  const pkts = Array.from({ length: 50 }, (_, i) => ({ data: buildEthIPv4TCPPacket({ srcPort: 2000 + i }) }));
  const buf = buildPcapFile(pkts);
  const tmp = writeTmp(buf);
  try {
    const r = pcapClient({ operation: "read", path: tmp, limit: 10 }, resolve);
    assertEq(r.displayed_packets, 10);
    assertEq(r.total_packets, 50);
    assertEq(r.packets.length, 10);
  } finally { fs.unlinkSync(tmp); }
});

test("C03 PCAP summary: top src/dst IPs populated", () => {
  const pkt = buildEthIPv4TCPPacket({ srcIP: [192, 168, 1, 1], dstIP: [8, 8, 8, 8] });
  const buf = buildPcapFile(Array(5).fill({ data: pkt }));
  const tmp = writeTmp(buf);
  try {
    const r = pcapClient({ operation: "summary", path: tmp }, resolve);
    assert(r.summary.top_src_ips.length > 0, "top_src_ips should be populated");
    assertEq(r.summary.top_src_ips[0].key, "192.168.1.1");
    assertEq(r.summary.top_src_ips[0].count, 5);
  } finally { fs.unlinkSync(tmp); }
});

test("C04 PCAP summary: top conversations populated", () => {
  const pkt = buildEthIPv4TCPPacket({ srcIP: [10, 0, 0, 1], dstIP: [10, 0, 0, 2] });
  const buf = buildPcapFile(Array(3).fill({ data: pkt }));
  const tmp = writeTmp(buf);
  try {
    const r = pcapClient({ operation: "summary", path: tmp }, resolve);
    assert(r.summary.top_conversations.length > 0, "conversations should be populated");
  } finally { fs.unlinkSync(tmp); }
});

test("C05 PCAP summary: duration_seconds computed from timestamps", () => {
  const pkts = [
    { data: buildEthIPv4TCPPacket(), ts: 0 },
    { data: buildEthIPv4TCPPacket(), ts: 5000 }, // 5 seconds later
  ];
  const buf = buildPcapFile(pkts);
  const tmp = writeTmp(buf);
  try {
    const r = pcapClient({ operation: "summary", path: tmp }, resolve);
    assertEq(r.summary.duration_seconds, 5);
  } finally { fs.unlinkSync(tmp); }
});

test("C06 PCAP summary: min/avg/max bytes computed", () => {
  const small = Buffer.alloc(14 + 20 + 8); // eth+ip+udp = 42
  const large = buildEthIPv4TCPPacket();
  const buf = buildPcapFile([{ data: small }, { data: large }]);
  const tmp = writeTmp(buf);
  try {
    const r = pcapClient({ operation: "summary", path: tmp }, resolve);
    assertEq(r.summary.min_bytes, small.length);
    assertEq(r.summary.max_bytes, large.length);
    assert(r.summary.avg_bytes > 0, "avg_bytes should be positive");
  } finally { fs.unlinkSync(tmp); }
});

test("C07 PCAP to_json: pretty=false produces compact JSON", () => {
  const buf = buildPcapFile([{ data: buildEthIPv4TCPPacket() }]);
  const tmp = writeTmp(buf);
  try {
    const r = pcapClient({ operation: "to_json", path: tmp, pretty: false }, resolve);
    assert(!r.json.includes("\n"), "compact JSON should not contain newlines");
  } finally { fs.unlinkSync(tmp); }
});

test("C08 PCAP to_json: filter is applied before export", () => {
  const pktTCP = buildEthIPv4TCPPacket();
  const pktUDP = buildEthIPv4UDPPacket(1111, 2222);
  const buf = buildPcapFile([{ data: pktTCP }, { data: pktUDP }]);
  const tmp = writeTmp(buf);
  try {
    const r = pcapClient({ operation: "to_json", path: tmp, filter: "protocol==TCP" }, resolve);
    const obj = JSON.parse(r.json);
    assertEq(obj.packets.length, 1);
    assertEq(obj.packets[0].protocol, "TCP");
  } finally { fs.unlinkSync(tmp); }
});

test("C09 PCAPng read: multiple EPBs decoded correctly", () => {
  const pkts = Array.from({ length: 5 }, (_, i) => ({
    data: buildEthIPv4TCPPacket({ srcPort: 3000 + i }), ts: i * 100,
  }));
  const buf = buildPcapngFile(pkts);
  const tmp = writeTmp(buf, ".pcapng");
  try {
    const r = pcapClient({ operation: "read", path: tmp }, resolve);
    assertEq(r.total_packets, 5);
    assertEq(r.packets.length, 5);
    r.packets.forEach((p, i) => assertEq(p.src_port, 3000 + i));
  } finally { fs.unlinkSync(tmp); }
});

test("C10 PCAPng info: packet count from EPBs", () => {
  const pkts = Array.from({ length: 10 }, () => ({ data: buildEthIPv4TCPPacket() }));
  const buf = buildPcapngFile(pkts);
  const tmp = writeTmp(buf, ".pcapng");
  try {
    const r = pcapClient({ operation: "info", path: tmp }, resolve);
    assertEq(r.total_packets, 10);
  } finally { fs.unlinkSync(tmp); }
});

test("C11 PCAP filter: captured_bytes >= comparison", () => {
  const big  = buildEthIPv4TCPPacket();
  const small = Buffer.alloc(14); // just ethernet header
  const buf  = buildPcapFile([{ data: big }, { data: small }]);
  const tmp  = writeTmp(buf);
  try {
    const threshold = big.length;
    const r = pcapClient({ operation: "filter", path: tmp, filter: `captured_bytes>=${threshold}` }, resolve);
    assertEq(r.matched_packets, 1);
    assertEq(r.packets[0].captured_bytes, big.length);
  } finally { fs.unlinkSync(tmp); }
});

test("C12 PCAP read: index field starts at 1 and increments", () => {
  const pkts = Array.from({ length: 5 }, () => ({ data: buildEthIPv4TCPPacket() }));
  const buf = buildPcapFile(pkts);
  const tmp = writeTmp(buf);
  try {
    const r = pcapClient({ operation: "read", path: tmp }, resolve);
    r.packets.forEach((p, i) => assertEq(p.index, i + 1));
  } finally { fs.unlinkSync(tmp); }
});

test("C13 PCAP read: packets have timestamp ISO string", () => {
  const pkts = Array.from({ length: 3 }, (_, i) => ({ data: buildEthIPv4TCPPacket(), ts: i * 500 }));
  const buf = buildPcapFile(pkts);
  const tmp = writeTmp(buf);
  try {
    const r = pcapClient({ operation: "read", path: tmp }, resolve);
    r.packets.forEach(p => {
      assert(typeof p.timestamp === "string");
      assert(!isNaN(Date.parse(p.timestamp)), "timestamp should parse as a date");
    });
  } finally { fs.unlinkSync(tmp); }
});

test("C14 PCAP read: filter combined with offset+limit", () => {
  // 10 TCP packets src_port 1000..1009
  const pkts = Array.from({ length: 10 }, (_, i) => ({ data: buildEthIPv4TCPPacket({ srcPort: 1000 + i }) }));
  const buf = buildPcapFile(pkts);
  const tmp = writeTmp(buf);
  try {
    // All TCP matched (10), skip first 3, take 4
    const r = pcapClient({ operation: "read", path: tmp, filter: "protocol==TCP", offset: 3, limit: 4 }, resolve);
    assertEq(r.matched_packets, 10);
    assertEq(r.displayed_packets, 4);
    assertEq(r.packets[0].src_port, 1003);
    assertEq(r.packets[3].src_port, 1006);
  } finally { fs.unlinkSync(tmp); }
});

test("C15 PCAP summary: NTP UDP app_protocol appears in protocols", () => {
  const pkt = buildEthIPv4UDPPacket(1234, 123); // NTP
  const buf = buildPcapFile([{ data: pkt }]);
  const tmp = writeTmp(buf);
  try {
    const r = pcapClient({ operation: "read", path: tmp }, resolve);
    assertEq(r.packets[0].app_protocol, "NTP");
  } finally { fs.unlinkSync(tmp); }
});

test("C16 PCAP filter: src_ip filter matches correctly", () => {
  const pkt1 = buildEthIPv4TCPPacket({ srcIP: [10, 0, 0, 1] });
  const pkt2 = buildEthIPv4TCPPacket({ srcIP: [10, 0, 0, 2] });
  const buf = buildPcapFile([{ data: pkt1 }, { data: pkt2 }, { data: pkt1 }]);
  const tmp = writeTmp(buf);
  try {
    const r = pcapClient({ operation: "filter", path: tmp, filter: "src_ip==10.0.0.1" }, resolve);
    assertEq(r.matched_packets, 2);
    r.packets.forEach(p => assertEq(p.src_ip, "10.0.0.1"));
  } finally { fs.unlinkSync(tmp); }
});

test("C17 PCAP summary: top_dst_ports populated", () => {
  const pktHTTP = buildEthIPv4TCPPacket({ dstPort: 80 });
  const buf = buildPcapFile(Array(5).fill({ data: pktHTTP }));
  const tmp = writeTmp(buf);
  try {
    const r = pcapClient({ operation: "summary", path: tmp }, resolve);
    assert(r.summary.top_dst_ports.length > 0);
    assertEq(r.summary.top_dst_ports[0].key, "80");
    assertEq(r.summary.top_dst_ports[0].count, 5);
  } finally { fs.unlinkSync(tmp); }
});

test("C18 PCAP read: empty PCAP with 0 packets is valid", () => {
  const buf = buildPcapFile([]);
  const tmp = writeTmp(buf);
  try {
    const r = pcapClient({ operation: "read", path: tmp }, resolve);
    assertEq(r.total_packets, 0);
    assertEq(r.packets.length, 0);
  } finally { fs.unlinkSync(tmp); }
});

test("C19 PCAPng summary: protocol stats from EPBs", () => {
  const pkts = [
    { data: buildEthIPv4TCPPacket() },
    { data: buildEthIPv4UDPPacket(53, 1024) },
    { data: buildEthIPv4TCPPacket() },
  ];
  const buf = buildPcapngFile(pkts);
  const tmp = writeTmp(buf, ".pcapng");
  try {
    const r = pcapClient({ operation: "summary", path: tmp }, resolve);
    assertEq(r.summary.protocols.TCP, 2);
    assertEq(r.summary.protocols.UDP, 1);
  } finally { fs.unlinkSync(tmp); }
});

test("C20 PCAP to_json: matched_packets and displayed_packets in output", () => {
  const buf = buildPcapFile(Array.from({ length: 5 }, () => ({ data: buildEthIPv4TCPPacket() })));
  const tmp = writeTmp(buf);
  try {
    const r = pcapClient({ operation: "to_json", path: tmp, limit: 3 }, resolve);
    const obj = JSON.parse(r.json);
    assertEq(obj.matched_packets, 5);
    assertEq(obj.displayed_packets, 3);
    assertEq(obj.packets.length, 3);
  } finally { fs.unlinkSync(tmp); }
});

// ── Section D: Security (10 tests) ──────────────────────────────────────────
process.stderr.write("\nSection D: security\n");

test("D01 path with NUL byte is rejected", () => {
  assertThrows(() => pcapClient({ operation: "info", path: "/tmp/foo\0.pcap" }, resolve), "NUL");
});

test("D02 directory path is rejected", () => {
  assertThrows(() => pcapClient({ operation: "info", path: os.tmpdir() }, resolve), "directory");
});

test("D03 output_file NUL byte rejected in to_json", () => {
  const buf = buildPcapFile([{ data: buildEthIPv4TCPPacket() }]);
  const tmp = writeTmp(buf);
  try {
    assertThrows(
      () => pcapClient({ operation: "to_json", path: tmp, output_file: "/tmp/out\0.json" }, resolve),
      "NUL"
    );
  } finally { fs.unlinkSync(tmp); }
});

test("D04 filter injection via field name doesn't crash", () => {
  const buf = buildPcapFile([{ data: buildEthIPv4TCPPacket() }]);
  const tmp = writeTmp(buf);
  try {
    // Unusual field names just evaluate to undefined (no match), not crash
    const r = pcapClient({ operation: "filter", path: tmp, filter: "__proto__==TCP" }, resolve);
    assertEq(r.matched_packets, 0);
  } finally { fs.unlinkSync(tmp); }
});

test("D05 very long filter string doesn't crash", () => {
  const buf = buildPcapFile([{ data: buildEthIPv4TCPPacket() }]);
  const tmp = writeTmp(buf);
  const longFilter = Array.from({ length: 100 }, (_, i) => `protocol==TCP`).join(" || ");
  try {
    const r = pcapClient({ operation: "filter", path: tmp, filter: longFilter }, resolve);
    assertEq(r.matched_packets, 1);
  } finally { fs.unlinkSync(tmp); }
});

test("D06 path traversal in path argument doesn't bypass security", () => {
  // resolveClientPath resolves paths - path must still be a valid file
  assertThrows(
    () => pcapClient({ operation: "info", path: "../../etc/passwd" }, resolve)
  );
});

test("D07 empty filter string treated as no filter", () => {
  const buf = buildPcapFile([{ data: buildEthIPv4TCPPacket() }]);
  const tmp = writeTmp(buf);
  try {
    const r = pcapClient({ operation: "read", path: tmp, filter: "" }, resolve);
    assertEq(r.total_packets, 1); // empty filter = no filtering
    assertEq(r.packets.length, 1);
  } finally { fs.unlinkSync(tmp); }
});

test("D08 malformed PCAP packet record (incl_len exceeds buffer) is handled", () => {
  const ghdr = buildGlobalHeader();
  const pktHdr = Buffer.alloc(16);
  pktHdr.writeUInt32LE(0, 0);
  pktHdr.writeUInt32LE(0, 4);
  pktHdr.writeUInt32LE(0xFFFFFF, 8);  // incl_len way too large
  pktHdr.writeUInt32LE(0xFFFFFF, 12);
  const buf = Buffer.concat([ghdr, pktHdr, Buffer.alloc(20)]); // only 20 bytes of data
  const tmp = writeTmp(buf);
  try {
    // Should not throw — just truncate
    const r = pcapClient({ operation: "info", path: tmp }, resolve);
    assertEq(r.total_packets, 0); // truncated immediately
    assertEq(r.file_truncated, true);
  } finally { fs.unlinkSync(tmp); }
});

test("D09 PCAP with packet data that triggers decoder truncation returns decode-error-safe result", () => {
  // Ethernet packet too short (only 13 bytes, needs 14)
  const short = Buffer.alloc(13, 0);
  const buf = buildPcapFile([{ data: short }]);
  const tmp = writeTmp(buf);
  try {
    const r = pcapClient({ operation: "read", path: tmp }, resolve);
    assertEq(r.total_packets, 1);
    // Should decode without throwing (truncated or fallback)
    assert(r.packets.length === 1);
    assert(r.packets[0].protocol !== undefined);
  } finally { fs.unlinkSync(tmp); }
});

test("D10 filter != operator works correctly", () => {
  const pktTCP = buildEthIPv4TCPPacket();
  const pktUDP = buildEthIPv4UDPPacket(1234, 5678);
  const buf = buildPcapFile([{ data: pktTCP }, { data: pktUDP }]);
  const tmp = writeTmp(buf);
  try {
    const r = pcapClient({ operation: "filter", path: tmp, filter: "protocol!=TCP" }, resolve);
    assertEq(r.matched_packets, 1);
    assertEq(r.packets[0].protocol, "UDP");
  } finally { fs.unlinkSync(tmp); }
});

// ── Section E: Error paths (10 tests) ───────────────────────────────────────
process.stderr.write("\nSection E: error-paths\n");

test("E01 completely empty file throws", () => {
  const tmp = writeTmp(Buffer.alloc(0));
  try {
    assertThrows(() => pcapClient({ operation: "info", path: tmp }, resolve));
  } finally { fs.unlinkSync(tmp); }
});

test("E02 3-byte file (too short) throws", () => {
  const tmp = writeTmp(Buffer.alloc(3));
  try {
    assertThrows(() => pcapClient({ operation: "info", path: tmp }, resolve));
  } finally { fs.unlinkSync(tmp); }
});

test("E03 PCAP with truncated global header throws", () => {
  // Magic is valid but header is only 20 bytes (needs 24)
  const buf = Buffer.alloc(20);
  buf.writeUInt32LE(PCAP_MAGIC_LE, 0);
  const tmp = writeTmp(buf);
  try {
    assertThrows(() => pcapClient({ operation: "info", path: tmp }, resolve), "too short");
  } finally { fs.unlinkSync(tmp); }
});

test("E04 PCAPng file missing byte-order magic throws", () => {
  const buf = Buffer.alloc(28);
  buf.writeUInt32LE(0x0a0d0d0a, 0); // SHB block type
  buf.writeUInt32LE(28, 4);          // block length
  buf.writeUInt32LE(0xDEADBEEF, 8);  // BAD byte-order magic
  const tmp = writeTmp(buf, ".pcapng");
  try {
    assertThrows(() => pcapClient({ operation: "info", path: tmp }, resolve));
  } finally { fs.unlinkSync(tmp); }
});

test("E05 read on file with only global header returns 0 packets (no error)", () => {
  const buf = buildPcapFile([]);
  const tmp = writeTmp(buf);
  try {
    const r = pcapClient({ operation: "read", path: tmp }, resolve);
    assertEq(r.packets.length, 0);
    assertEq(r.total_packets, 0);
  } finally { fs.unlinkSync(tmp); }
});

test("E06 summary on empty pcap returns zero packet_count", () => {
  const buf = buildPcapFile([]);
  const tmp = writeTmp(buf);
  try {
    const r = pcapClient({ operation: "summary", path: tmp }, resolve);
    assertEq(r.summary.packet_count, 0);
    assertEq(r.summary.total_bytes, 0);
    assertEq(r.summary.duration_seconds, null);
  } finally { fs.unlinkSync(tmp); }
});

test("E07 unknown operation throws", () => {
  const buf = buildPcapFile([{ data: buildEthIPv4TCPPacket() }]);
  const tmp = writeTmp(buf);
  try {
    assertThrows(() => pcapClient({ operation: "sniff", path: tmp }, resolve), "unknown operation");
  } finally { fs.unlinkSync(tmp); }
});

test("E08 filter with malformed condition throws", () => {
  const buf = buildPcapFile([{ data: buildEthIPv4TCPPacket() }]);
  const tmp = writeTmp(buf);
  try {
    assertThrows(
      () => pcapClient({ operation: "filter", path: tmp, filter: "nooperator" }, resolve),
      "filter"
    );
  } finally { fs.unlinkSync(tmp); }
});

test("E09 offset larger than matched_packets returns empty packets array", () => {
  const buf = buildPcapFile([{ data: buildEthIPv4TCPPacket() }]);
  const tmp = writeTmp(buf);
  try {
    const r = pcapClient({ operation: "read", path: tmp, offset: 999 }, resolve);
    assertEq(r.matched_packets, 1);
    assertEq(r.displayed_packets, 0);
    assertEq(r.packets.length, 0);
  } finally { fs.unlinkSync(tmp); }
});

test("E10 to_json on empty pcap produces valid JSON with empty packets", () => {
  const buf = buildPcapFile([]);
  const tmp = writeTmp(buf);
  try {
    const r = pcapClient({ operation: "to_json", path: tmp }, resolve);
    const obj = JSON.parse(r.json);
    assertEq(obj.total_packets, 0);
    assertEq(obj.packets.length, 0);
  } finally { fs.unlinkSync(tmp); }
});

// ── Section F: Concurrency (6 tests) ────────────────────────────────────────
process.stderr.write("\nSection F: concurrency\n");

test("F01 10 concurrent info calls on same file", async () => {
  const buf = buildPcapFile(Array.from({ length: 5 }, () => ({ data: buildEthIPv4TCPPacket() })));
  const tmp = writeTmp(buf);
  try {
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        Promise.resolve(pcapClient({ operation: "info", path: tmp }, resolve))
      )
    );
    results.forEach(r => {
      assertEq(r.format, "PCAP");
      assertEq(r.total_packets, 5);
    });
  } finally { fs.unlinkSync(tmp); }
});

test("F02 10 concurrent read calls on different files", async () => {
  const tmps = Array.from({ length: 10 }, (_, i) => {
    const buf = buildPcapFile([{ data: buildEthIPv4TCPPacket({ srcPort: 9000 + i }) }]);
    return writeTmp(buf);
  });
  try {
    const results = await Promise.all(
      tmps.map((tmp, i) =>
        Promise.resolve(pcapClient({ operation: "read", path: tmp }, resolve))
      )
    );
    results.forEach((r, i) => {
      assertEq(r.total_packets, 1);
      assertEq(r.packets[0].src_port, 9000 + i);
    });
  } finally {
    tmps.forEach(t => fs.unlinkSync(t));
  }
});

test("F03 20 concurrent filter evaluations are thread-safe", async () => {
  const pkts = Array.from({ length: 20 }, (_, i) => ({
    data: i % 2 === 0 ? buildEthIPv4TCPPacket() : buildEthIPv4UDPPacket(1234, 5678)
  }));
  const buf = buildPcapFile(pkts);
  const tmp = writeTmp(buf);
  try {
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        Promise.resolve(pcapClient({ operation: "filter", path: tmp, filter: "protocol==TCP" }, resolve))
      )
    );
    results.forEach(r => assertEq(r.matched_packets, 10));
  } finally { fs.unlinkSync(tmp); }
});

test("F04 10 concurrent summary operations are consistent", async () => {
  const pkts = Array.from({ length: 10 }, () => ({ data: buildEthIPv4TCPPacket() }));
  const buf = buildPcapFile(pkts);
  const tmp = writeTmp(buf);
  try {
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        Promise.resolve(pcapClient({ operation: "summary", path: tmp }, resolve))
      )
    );
    results.forEach(r => {
      assertEq(r.summary.packet_count, 10);
      assertEq(r.summary.protocols.TCP, 10);
    });
  } finally { fs.unlinkSync(tmp); }
});

test("F05 5 concurrent to_json writes to different output files", async () => {
  const buf = buildPcapFile([{ data: buildEthIPv4TCPPacket() }]);
  const tmp = writeTmp(buf);
  const outs = Array.from({ length: 5 }, (_, i) => tmp + `.out${i}.json`);
  try {
    const results = await Promise.all(
      outs.map(out =>
        Promise.resolve(pcapClient({ operation: "to_json", path: tmp, output_file: out }, resolve))
      )
    );
    results.forEach(r => assert(r.bytes_written > 0));
    outs.forEach(o => {
      assert(fs.existsSync(o));
      const obj = JSON.parse(fs.readFileSync(o, "utf8"));
      assertEq(obj.total_packets, 1);
    });
  } finally {
    fs.unlinkSync(tmp);
    outs.forEach(o => { if (fs.existsSync(o)) fs.unlinkSync(o); });
  }
});

test("F06 mixed concurrent operations on same file are consistent", async () => {
  const pkts = Array.from({ length: 5 }, (_, i) => ({ data: buildEthIPv4TCPPacket({ srcPort: 2000 + i }) }));
  const buf = buildPcapFile(pkts);
  const tmp = writeTmp(buf);
  try {
    const [infoR, readR, summR, filtR] = await Promise.all([
      Promise.resolve(pcapClient({ operation: "info",    path: tmp }, resolve)),
      Promise.resolve(pcapClient({ operation: "read",    path: tmp }, resolve)),
      Promise.resolve(pcapClient({ operation: "summary", path: tmp }, resolve)),
      Promise.resolve(pcapClient({ operation: "filter",  path: tmp, filter: "protocol==TCP" }, resolve)),
    ]);
    assertEq(infoR.total_packets, 5);
    assertEq(readR.total_packets, 5);
    assertEq(summR.summary.packet_count, 5);
    assertEq(filtR.matched_packets, 5);
  } finally { fs.unlinkSync(tmp); }
});

// ── Summary ─────────────────────────────────────────────────────────────────
Promise.all(asyncTests).then(() => {
  const total = passed + failed;
  process.stderr.write(`\n228-pcap-client: ${passed}/${total} tests passed`);
  if (failures.length) {
    process.stderr.write("\nFailed tests:\n");
    failures.forEach(f => process.stderr.write(`  - ${f.name}: ${f.error}\n`));
  }
  process.stderr.write("\n");
  process.exitCode = failed > 0 ? 1 : 0;
});
