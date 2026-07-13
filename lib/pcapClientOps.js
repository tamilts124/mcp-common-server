"use strict";
// lib/pcapClientOps.js
// Zero-dependency PCAP / PCAPng network-capture file reader (pure Node.js; no npm deps).
// Operations: info, read, summary, filter, to_json
// Supports:
//   - PCAP (classic libpcap) format: little-endian and big-endian, nanosecond variant
//   - PCAPng (next-generation) format: SHB, IDB, EPB, SPB, OPB blocks
// Security: 500 MB file cap; 10,000,000 packet limit; NUL-byte path guard; directory path rejected

const fs   = require("fs");
const path = require("path");
const { ToolError } = require("./errors");

const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500 MB
const MAX_PACKETS   = 10_000_000;

// ─── Link-type names (PCAP DLT_*) ─────────────────────────────────────────────
const DLT_NAMES = {
  0:   "NULL",
  1:   "ETHERNET",
  6:   "TOKEN_RING",
  8:   "SLIP",
  9:   "PPP",
  10:  "FDDI",
  100: "RAW",
  105: "IEEE802_11",
  113: "LINUX_SLL",
  127: "IEEE802_11_RADIOTAP",
  187: "BLUETOOTH_HCI_H4",
  192: "PPI",
  195: "IEEE802_15_4",
  228: "IPV4",
  229: "IPV6",
  247: "INFINIBAND",
  278: "LINUX_SLL2",
};

function dltName(n) {
  return DLT_NAMES[n] || `DLT_${n}`;
}

// ─── Protocol decoders ────────────────────────────────────────────────────────

function ethToStr(buf, off) {
  const b = [];
  for (let i = 0; i < 6; i++) b.push(buf[off + i].toString(16).padStart(2, "0"));
  return b.join(":");
}

function ipToStr(buf, off) {
  return `${buf[off]}.${buf[off+1]}.${buf[off+2]}.${buf[off+3]}`;
}

function ipv6ToStr(buf, off) {
  if (buf.length < off + 16) return "::";
  const parts = [];
  for (let i = 0; i < 8; i++) {
    parts.push(((buf[off + i*2] << 8) | buf[off + i*2+1]).toString(16));
  }
  let bestStart = -1, bestLen = 0, curStart = -1, curLen = 0;
  for (let i = 0; i < 8; i++) {
    if (parts[i] === "0") {
      if (curStart < 0) { curStart = i; curLen = 1; }
      else curLen++;
      if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
    } else {
      curStart = -1; curLen = 0;
    }
  }
  if (bestLen >= 2) {
    const head = parts.slice(0, bestStart).join(":");
    const tail = parts.slice(bestStart + bestLen).join(":");
    return `${head}::${tail}`;
  }
  return parts.join(":");
}

function decodeEthernet(buf) {
  if (buf.length < 14) return { protocol: "ETHERNET", truncated: true };
  const dst  = ethToStr(buf, 0);
  const src  = ethToStr(buf, 6);
  let ethertype = (buf[12] << 8) | buf[13];
  let payloadOff = 14;
  let vlan;
  if (ethertype === 0x8100 && buf.length >= 18) {
    vlan = ((buf[14] & 0x0f) << 8) | buf[15];
    ethertype = (buf[16] << 8) | buf[17];
    payloadOff = 18;
  }
  const base = {
    protocol: "ETHERNET",
    src_mac: src,
    dst_mac: dst,
    ethertype: `0x${ethertype.toString(16).padStart(4, "0")}`,
  };
  if (vlan !== undefined) base.vlan = vlan;
  if (ethertype === 0x0800) return { ...base, ...decodeIPv4(buf, payloadOff) };
  if (ethertype === 0x86DD) return { ...base, ...decodeIPv6(buf, payloadOff) };
  if (ethertype === 0x0806) return { ...base, protocol: "ARP" };
  return base;
}

function decodeIPv4(buf, off) {
  if (buf.length < off + 20) return { ip_version: 4, truncated: true };
  const ihl   = (buf[off] & 0xf) * 4;
  const tos   = buf[off + 1];
  const tot   = (buf[off+2] << 8) | buf[off+3];
  const ttl   = buf[off + 8];
  const proto = buf[off + 9];
  const src   = ipToStr(buf, off + 12);
  const dst   = ipToStr(buf, off + 16);
  const base  = { ip_version: 4, ip_tos: tos, ip_len: tot, ip_ttl: ttl, ip_protocol: proto, src_ip: src, dst_ip: dst };
  if (proto === 6)  return { ...base, ...decodeTCP(buf, off + ihl) };
  if (proto === 17) return { ...base, ...decodeUDP(buf, off + ihl) };
  if (proto === 1)  return { ...base, ...decodeICMPv4(buf, off + ihl) };
  if (proto === 58) return { ...base, protocol: "ICMPv6" };
  if (proto === 89) return { ...base, protocol: "OSPF" };
  if (proto === 47) return { ...base, protocol: "GRE" };
  if (proto === 50) return { ...base, protocol: "ESP" };
  if (proto === 51) return { ...base, protocol: "AH" };
  return { ...base, protocol: `IP_PROTO_${proto}` };
}

function decodeIPv6(buf, off) {
  if (buf.length < off + 40) return { ip_version: 6, truncated: true };
  const nextHdr  = buf[off + 6];
  const hopLimit = buf[off + 7];
  const src = ipv6ToStr(buf, off + 8);
  const dst = ipv6ToStr(buf, off + 24);
  const base = { ip_version: 6, ip_hop_limit: hopLimit, ip_protocol: nextHdr, src_ip: src, dst_ip: dst };
  if (nextHdr === 6)  return { ...base, ...decodeTCP(buf, off + 40) };
  if (nextHdr === 17) return { ...base, ...decodeUDP(buf, off + 40) };
  if (nextHdr === 58) return { ...base, ...decodeICMPv6(buf, off + 40) };
  return { ...base, protocol: `IP6_NEXT_${nextHdr}` };
}

function decodeTCP(buf, off) {
  if (buf.length < off + 20) return { protocol: "TCP", truncated: true };
  const srcPort  = (buf[off] << 8) | buf[off+1];
  const dstPort  = (buf[off+2] << 8) | buf[off+3];
  const seq      = (buf[off+4] << 24 | buf[off+5] << 16 | buf[off+6] << 8 | buf[off+7]) >>> 0;
  const ack      = (buf[off+8] << 24 | buf[off+9] << 16 | buf[off+10] << 8 | buf[off+11]) >>> 0;
  const dataOff  = ((buf[off+12] >> 4) & 0xf) * 4;
  const flags    = buf[off + 13];
  const win      = (buf[off+14] << 8) | buf[off+15];
  const flagParts = [
    flags & 0x01 ? "FIN" : null,
    flags & 0x02 ? "SYN" : null,
    flags & 0x04 ? "RST" : null,
    flags & 0x08 ? "PSH" : null,
    flags & 0x10 ? "ACK" : null,
    flags & 0x20 ? "URG" : null,
    flags & 0x40 ? "ECE" : null,
    flags & 0x80 ? "CWR" : null,
  ].filter(Boolean);
  const payloadLen = Math.max(0, buf.length - off - dataOff);
  return {
    protocol: "TCP",
    src_port: srcPort,
    dst_port: dstPort,
    tcp_seq: seq,
    tcp_ack: ack,
    tcp_flags: flagParts.join("|") || "NONE",
    tcp_window: win,
    payload_bytes: payloadLen,
  };
}

function decodeUDP(buf, off) {
  if (buf.length < off + 8) return { protocol: "UDP", truncated: true };
  const srcPort = (buf[off] << 8) | buf[off+1];
  const dstPort = (buf[off+2] << 8) | buf[off+3];
  const length  = (buf[off+4] << 8) | buf[off+5];
  let appProto;
  if (srcPort === 53 || dstPort === 53)                       appProto = "DNS";
  else if (srcPort === 67 || dstPort === 67 || srcPort === 68 || dstPort === 68) appProto = "DHCP";
  else if (srcPort === 123 || dstPort === 123)                appProto = "NTP";
  else if (srcPort === 161 || dstPort === 161 || srcPort === 162 || dstPort === 162) appProto = "SNMP";
  else if (srcPort === 5353 || dstPort === 5353)              appProto = "mDNS";
  else if (srcPort === 4789 || dstPort === 4789)              appProto = "VXLAN";
  return {
    protocol: "UDP",
    src_port: srcPort,
    dst_port: dstPort,
    udp_length: length,
    ...(appProto ? { app_protocol: appProto } : {}),
  };
}

function decodeICMPv4(buf, off) {
  if (buf.length < off + 4) return { protocol: "ICMP", truncated: true };
  const type = buf[off];
  const code = buf[off+1];
  const TYPE_NAMES = {
    0:  "Echo Reply",
    3:  "Dest Unreachable",
    4:  "Source Quench",
    5:  "Redirect",
    8:  "Echo Request",
    11: "Time Exceeded",
    12: "Param Problem",
    13: "Timestamp",
    14: "Timestamp Reply",
  };
  return { protocol: "ICMP", icmp_type: type, icmp_code: code, icmp_type_name: TYPE_NAMES[type] || `Type ${type}` };
}

function decodeICMPv6(buf, off) {
  if (buf.length < off + 4) return { protocol: "ICMPv6", truncated: true };
  const type = buf[off];
  const code = buf[off+1];
  const TYPE6 = {
    1:   "Dest Unreachable",
    2:   "Packet Too Big",
    3:   "Time Exceeded",
    4:   "Param Problem",
    128: "Echo Request",
    129: "Echo Reply",
    133: "Router Solicitation",
    134: "Router Advertisement",
    135: "Neighbor Solicitation",
    136: "Neighbor Advertisement",
    137: "Redirect",
  };
  return { protocol: "ICMPv6", icmp_type: type, icmp_code: code, icmp_type_name: TYPE6[type] || `Type ${type}` };
}

function decodeNullLoopback(buf) {
  if (buf.length < 4) return { protocol: "LOOPBACK", truncated: true };
  const family = buf.readUInt32LE(0);
  if (family === 2)          return decodeIPv4(buf, 4);
  if (family === 24 || family === 30) return decodeIPv6(buf, 4);
  return { protocol: "LOOPBACK", family };
}

function decodeLinuxSLL(buf) {
  if (buf.length < 16) return { protocol: "LINUX_SLL", truncated: true };
  const pktType = (buf[0] << 8) | buf[1];
  const arphrd  = (buf[2] << 8) | buf[3];
  const proto   = (buf[14] << 8) | buf[15];
  const base    = { sll_pkt_type: pktType, sll_arphrd: arphrd };
  if (proto === 0x0800) return { ...base, ...decodeIPv4(buf, 16) };
  if (proto === 0x86DD) return { ...base, ...decodeIPv6(buf, 16) };
  return { protocol: "LINUX_SLL", sll_proto: `0x${proto.toString(16).padStart(4, "0")}` };
}

function decodeRaw(buf) {
  if (buf.length < 1) return { protocol: "RAW", truncated: true };
  const ver = (buf[0] >> 4) & 0xf;
  if (ver === 4) return decodeIPv4(buf, 0);
  if (ver === 6) return decodeIPv6(buf, 0);
  return { protocol: "RAW_UNKNOWN_IP_VER", ip_version: ver };
}

function decodePacket(dlt, buf) {
  try {
    if (dlt === 1)              return decodeEthernet(buf);
    if (dlt === 0 || dlt === 108) return decodeNullLoopback(buf);
    if (dlt === 113)            return decodeLinuxSLL(buf);
    if (dlt === 100 || dlt === 228 || dlt === 229) return decodeRaw(buf);
    if (dlt === 105)            return { protocol: "IEEE802_11" };
    return { protocol: dltName(dlt) };
  } catch {
    return { protocol: "DECODE_ERROR" };
  }
}

// ─── PCAP (classic) parser ─────────────────────────────────────────────────────

const PCAP_MAGIC_LE    = 0xa1b2c3d4;
const PCAP_MAGIC_BE    = 0xd4c3b2a1;
const PCAP_MAGIC_NS_LE = 0xa1b23c4d;
const PCAP_MAGIC_NS_BE = 0x4d3cb2a1;

function parsePcap(buf, opts) {
  const { maxPackets = MAX_PACKETS, filterFn = null } = opts;
  if (buf.length < 24) throw new ToolError("pcap_client: file too short to contain PCAP global header.", -32602);

  const magic = buf.readUInt32LE(0);
  let LE, ns;
  if      (magic === PCAP_MAGIC_LE)    { LE = true;  ns = false; }
  else if (magic === PCAP_MAGIC_BE)    { LE = false; ns = false; }
  else if (magic === PCAP_MAGIC_NS_LE) { LE = true;  ns = true; }
  else if (magic === PCAP_MAGIC_NS_BE) { LE = false; ns = true; }
  else throw new ToolError("pcap_client: not a valid PCAP file (bad magic number).", -32602);

  const r16 = LE ? (o) => buf.readUInt16LE(o) : (o) => buf.readUInt16BE(o);
  const r32 = LE ? (o) => buf.readUInt32LE(o) : (o) => buf.readUInt32BE(o);

  const vMaj    = r16(4);
  const vMin    = r16(6);
  const snaplen = r32(16);
  const dlt     = r32(20);

  const info = {
    format: "PCAP",
    endian: LE ? "little" : "big",
    nanosecond: ns,
    version: `${vMaj}.${vMin}`,
    snaplen,
    dlt,
    link_type: dltName(dlt),
  };

  let pos = 24;
  const packets = [];
  let totalPackets = 0;
  let truncated = false;

  while (pos + 16 <= buf.length) {
    if (totalPackets >= maxPackets) { truncated = true; break; }

    const tsSec  = r32(pos);
    const tsUsNs = r32(pos + 4);
    const inclLen = r32(pos + 8);
    const origLen = r32(pos + 12);
    pos += 16;

    if (pos + inclLen > buf.length) { truncated = true; break; }

    const tsMs = ns
      ? tsSec * 1000 + tsUsNs / 1e6
      : tsSec * 1000 + tsUsNs / 1e3;

    const pktData = buf.slice(pos, pos + inclLen);
    pos += inclLen;
    totalPackets++;

    const decoded = decodePacket(dlt, pktData);
    const pkt = {
      index: totalPackets,
      timestamp_epoch_ms: tsMs,
      timestamp: new Date(tsMs).toISOString(),
      captured_bytes: inclLen,
      original_bytes: origLen,
      truncated_packet: inclLen < origLen,
      ...decoded,
    };

    if (!filterFn || filterFn(pkt)) packets.push(pkt);
  }

  return { info, totalPackets, truncated, packets };
}

// ─── PCAPng parser ─────────────────────────────────────────────────────────────

const PCAPNG_BYTE_ORDER_MAGIC = 0x1A2B3C4D;
const PCAPNG_SHB = 0x0A0D0D0A;
const PCAPNG_IDB = 0x00000001;
const PCAPNG_EPB = 0x00000006;
const PCAPNG_SPB = 0x00000003;
const PCAPNG_OPB = 0x00000002;

function parsePcapng(buf, opts) {
  const { maxPackets = MAX_PACKETS, filterFn = null } = opts;
  if (buf.length < 28) throw new ToolError("pcap_client: file too short to contain PCAPng SHB.", -32602);
  if (buf.readUInt32LE(0) !== PCAPNG_SHB)
    throw new ToolError("pcap_client: not a valid PCAPng file (missing Section Header Block).", -32602);

  let LE;
  if      (buf.readUInt32LE(8) === PCAPNG_BYTE_ORDER_MAGIC) LE = true;
  else if (buf.readUInt32BE(8) === PCAPNG_BYTE_ORDER_MAGIC) LE = false;
  else throw new ToolError("pcap_client: PCAPng byte-order magic not found.", -32602);

  const r16 = LE ? (o) => buf.readUInt16LE(o) : (o) => buf.readUInt16BE(o);
  const r32 = LE ? (o) => buf.readUInt32LE(o) : (o) => buf.readUInt32BE(o);

  const shbTotalLen = r32(4);
  const shbMaj = r16(12);
  const shbMin = r16(14);

  const info = {
    format: "PCAPng",
    endian: LE ? "little" : "big",
    version: `${shbMaj}.${shbMin}`,
    interfaces: [],
  };

  let pos = shbTotalLen;
  const interfaces = [];
  const packets = [];
  let totalPackets = 0;
  let truncated = false;

  while (pos + 12 <= buf.length) {
    const blockType = r32(pos);
    const blockLen  = r32(pos + 4);

    if (blockLen < 12 || pos + blockLen > buf.length) { truncated = true; break; }

    if (blockType === PCAPNG_IDB) {
      const linkType = r16(pos + 8);
      const snaplen  = r32(pos + 12);
      const iface = {
        index: interfaces.length,
        link_type: linkType,
        link_type_name: dltName(linkType),
        snaplen,
        ts_resol_power: 6, // default: microseconds
      };
      // Parse if_tsresol option (code 9) from IDB options
      let optOff = pos + 20;
      while (optOff + 4 <= pos + blockLen - 4) {
        const optCode = r16(optOff);
        const optLen  = r16(optOff + 2);
        if (optCode === 0) break;
        if (optCode === 9 && optLen >= 1) {
          iface.ts_resol_power = buf[optOff + 4];
        }
        optOff += 4 + Math.ceil(optLen / 4) * 4;
      }
      interfaces.push(iface);
      info.interfaces.push({ ...iface });

    } else if (blockType === PCAPNG_EPB) {
      if (totalPackets >= maxPackets) { truncated = true; break; }
      const ifaceIdx = r32(pos + 8);
      const tsHigh   = r32(pos + 12);
      const tsLow    = r32(pos + 16);
      const captLen  = r32(pos + 20);
      const origLen  = r32(pos + 24);

      const iface = interfaces[ifaceIdx] || { link_type: 1, ts_resol_power: 6 };
      const tsRaw = tsHigh * 0x100000000 + tsLow;
      const resPow = iface.ts_resol_power;
      const tsMult = (resPow & 0x80)
        ? (1 / Math.pow(2, resPow & 0x7f)) // base-2
        : Math.pow(10, -resPow);            // base-10
      const tsMs = tsRaw * tsMult * 1000;

      const pktData = buf.slice(pos + 28, pos + 28 + captLen);
      totalPackets++;

      const decoded = decodePacket(iface.link_type, pktData);
      const pkt = {
        index: totalPackets,
        interface_id: ifaceIdx,
        timestamp_epoch_ms: tsMs,
        timestamp: new Date(tsMs).toISOString(),
        captured_bytes: captLen,
        original_bytes: origLen,
        truncated_packet: captLen < origLen,
        ...decoded,
      };

      if (!filterFn || filterFn(pkt)) packets.push(pkt);

    } else if (blockType === PCAPNG_SPB) {
      if (totalPackets >= maxPackets) { truncated = true; break; }
      const origLen = r32(pos + 8);
      const iface   = interfaces[0] || { link_type: 1 };
      const captLen = Math.min(origLen, iface.snaplen || origLen);
      const pktData = buf.slice(pos + 12, pos + 12 + captLen);
      totalPackets++;

      const decoded = decodePacket(iface.link_type, pktData);
      const pkt = {
        index: totalPackets,
        interface_id: 0,
        timestamp_epoch_ms: null,
        timestamp: null,
        captured_bytes: captLen,
        original_bytes: origLen,
        truncated_packet: captLen < origLen,
        ...decoded,
      };

      if (!filterFn || filterFn(pkt)) packets.push(pkt);

    } else if (blockType === PCAPNG_OPB) {
      if (totalPackets >= maxPackets) { truncated = true; break; }
      const ifaceIdx = r16(pos + 8);
      const captLen  = r32(pos + 16);
      const origLen  = r32(pos + 20);
      const pktData  = buf.slice(pos + 28, pos + 28 + captLen);
      totalPackets++;

      const iface = interfaces[ifaceIdx] || { link_type: 1 };
      const decoded = decodePacket(iface.link_type, pktData);
      const pkt = {
        index: totalPackets,
        interface_id: ifaceIdx,
        timestamp_epoch_ms: null,
        timestamp: null,
        captured_bytes: captLen,
        original_bytes: origLen,
        truncated_packet: captLen < origLen,
        ...decoded,
      };

      if (!filterFn || filterFn(pkt)) packets.push(pkt);
    }
    // ISB, NRB, new SHB, unknown: skip
    pos += blockLen;
  }

  return { info, totalPackets, truncated, packets };
}

// ─── Format detection ─────────────────────────────────────────────────────────

function parseCapture(buf, opts) {
  if (buf.length < 4) throw new ToolError("pcap_client: file too short.", -32602);

  const magicLE = buf.readUInt32LE(0);
  if (magicLE === PCAPNG_SHB) return parsePcapng(buf, opts);
  if (magicLE === PCAP_MAGIC_LE || magicLE === PCAP_MAGIC_BE ||
      magicLE === PCAP_MAGIC_NS_LE || magicLE === PCAP_MAGIC_NS_BE) {
    return parsePcap(buf, opts);
  }

  const magicBE = buf.readUInt32BE(0);
  if (magicBE === PCAPNG_SHB) return parsePcapng(buf, opts);

  throw new ToolError(
    "pcap_client: unrecognised file format — expected PCAP (magic 0xa1b2c3d4) or PCAPng (magic 0x0a0d0d0a).",
    -32602,
  );
}

// ─── Summary builder ──────────────────────────────────────────────────────────

function buildSummary(packets) {
  const protoCounts = {};
  const srcIps = {}, dstIps = {}, srcPorts = {}, dstPorts = {}, conversations = {};
  let totalBytes = 0, minBytes = Infinity, maxBytes = 0;
  let minTs = Infinity, maxTs = -Infinity;

  for (const p of packets) {
    const proto = p.protocol || "UNKNOWN";
    protoCounts[proto] = (protoCounts[proto] || 0) + 1;
    totalBytes += p.captured_bytes || 0;
    if ((p.captured_bytes || 0) < minBytes) minBytes = p.captured_bytes;
    if ((p.captured_bytes || 0) > maxBytes) maxBytes = p.captured_bytes;
    if (p.timestamp_epoch_ms != null) {
      if (p.timestamp_epoch_ms < minTs) minTs = p.timestamp_epoch_ms;
      if (p.timestamp_epoch_ms > maxTs) maxTs = p.timestamp_epoch_ms;
    }
    if (p.src_ip) srcIps[p.src_ip] = (srcIps[p.src_ip] || 0) + 1;
    if (p.dst_ip) dstIps[p.dst_ip] = (dstIps[p.dst_ip] || 0) + 1;
    if (p.src_port != null) srcPorts[p.src_port] = (srcPorts[p.src_port] || 0) + 1;
    if (p.dst_port != null) dstPorts[p.dst_port] = (dstPorts[p.dst_port] || 0) + 1;
    if (p.src_ip && p.dst_ip) {
      const [a, b] = p.src_ip < p.dst_ip ? [p.src_ip, p.dst_ip] : [p.dst_ip, p.src_ip];
      const key = p.src_port != null
        ? `${a}:${p.src_ip === a ? p.src_port : p.dst_port} <-> ${b}:${p.src_ip === a ? p.dst_port : p.src_port}`
        : `${a} <-> ${b}`;
      conversations[key] = (conversations[key] || 0) + 1;
    }
  }

  const topN = (obj, n = 10) =>
    Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ key: k, count: v }));

  const duration = (maxTs !== -Infinity && minTs !== Infinity && maxTs > minTs)
    ? (maxTs - minTs) / 1000
    : null;

  return {
    packet_count: packets.length,
    total_bytes: totalBytes,
    avg_bytes: packets.length ? Math.round(totalBytes / packets.length) : 0,
    min_bytes: packets.length ? minBytes : 0,
    max_bytes: packets.length ? maxBytes : 0,
    first_packet: minTs !== Infinity  ? new Date(minTs).toISOString() : null,
    last_packet:  maxTs !== -Infinity ? new Date(maxTs).toISOString() : null,
    duration_seconds: duration,
    protocols: protoCounts,
    top_src_ips: topN(srcIps),
    top_dst_ips: topN(dstIps),
    top_src_ports: topN(srcPorts),
    top_dst_ports: topN(dstPorts),
    top_conversations: topN(conversations),
  };
}

// ─── Filter expression compiler ───────────────────────────────────────────────
// Supports: field==value, field!=value, field>=N etc. combined with && / ||
// Fields: protocol, src_ip, dst_ip, src_port, dst_port, tcp_flags, app_protocol, captured_bytes, original_bytes

function compileFilter(expr) {
  if (!expr || !expr.trim()) return null;

  function parseCond(str) {
    str = str.trim();
    const m = str.match(/^(\w+)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
    if (!m) throw new ToolError(`pcap_client: invalid filter condition: '${str}'`, -32602);
    const [, field, op, rawVal] = m;
    const val    = rawVal.trim().replace(/^['"]|['"]$/g, "");
    const numVal = parseFloat(val);
    const isNum  = !isNaN(numVal) && val.trim() !== "";
    return (pkt) => {
      let lv = pkt[field];
      if (lv === undefined || lv === null) return op === "!=";
      if (isNum && typeof lv === "number") {
        if (op === "==") return lv === numVal;
        if (op === "!=") return lv !== numVal;
        if (op === ">=") return lv >= numVal;
        if (op === "<=") return lv <= numVal;
        if (op === ">")  return lv > numVal;
        if (op === "<")  return lv < numVal;
      }
      const lvStr = String(lv).toLowerCase();
      const rvStr = val.toLowerCase();
      if (op === "==") return lvStr === rvStr;
      if (op === "!=") return lvStr !== rvStr;
      return false;
    };
  }

  const orParts = expr.trim().split(/\s*\|\|\s*/);
  const orFns = orParts.map(orPart => {
    const andParts = orPart.split(/\s*&&\s*/);
    const andFns = andParts.map(parseCond);
    return (pkt) => andFns.every(f => f(pkt));
  });
  return (pkt) => orFns.some(f => f(pkt));
}

// ─── Main entry point ─────────────────────────────────────────────────────────

function pcapClient(args, resolveClientPath) {
  const {
    operation,
    path: filePath,
    offset  = 0,
    limit,
    filter,
    output_file,
    pretty = true,
  } = args;

  if (!filePath || filePath.includes("\0"))
    throw new ToolError("pcap_client: 'path' must be a non-empty string without NUL bytes.", -32602);

  const { resolved } = resolveClientPath(filePath);
  const stat = fs.statSync(resolved);
  if (stat.isDirectory())
    throw new ToolError("pcap_client: path points to a directory — provide a .pcap or .pcapng file.", -32602);
  if (stat.size > MAX_FILE_SIZE)
    throw new ToolError(`pcap_client: file too large (${stat.size} bytes; max ${MAX_FILE_SIZE}).`, -32602);

  const buf      = fs.readFileSync(resolved);
  const filterFn = filter ? compileFilter(filter) : null;

  if (operation === "info") {
    const result = parseCapture(buf, { maxPackets: MAX_PACKETS, filterFn: null });
    return {
      path: filePath,
      file_size_bytes: stat.size,
      format: result.info.format,
      ...result.info,
      total_packets: result.totalPackets,
      file_truncated: result.truncated,
    };
  }

  const parsed = parseCapture(buf, { maxPackets: MAX_PACKETS, filterFn });

  const allMatched  = parsed.packets;
  const effLimit    = limit != null ? limit : allMatched.length;
  const displayed   = allMatched.slice(offset, offset + effLimit);

  if (operation === "read") {
    return {
      path: filePath,
      format: parsed.info.format,
      link_type: parsed.info.link_type || parsed.info.interfaces?.[0]?.link_type_name,
      total_packets: parsed.totalPackets,
      matched_packets: allMatched.length,
      displayed_packets: displayed.length,
      offset,
      limit: effLimit,
      truncated: parsed.truncated,
      packets: displayed,
    };
  }

  if (operation === "summary") {
    return {
      path: filePath,
      format: parsed.info.format,
      info: parsed.info,
      file_size_bytes: stat.size,
      total_packets: parsed.totalPackets,
      matched_packets: allMatched.length,
      truncated: parsed.truncated,
      summary: buildSummary(allMatched),
    };
  }

  if (operation === "filter") {
    if (!filter)
      throw new ToolError("pcap_client: 'filter' is required for the 'filter' operation.", -32602);
    return {
      path: filePath,
      format: parsed.info.format,
      filter,
      total_packets: parsed.totalPackets,
      matched_packets: allMatched.length,
      displayed_packets: displayed.length,
      offset,
      limit: effLimit,
      truncated: parsed.truncated,
      packets: displayed,
    };
  }

  if (operation === "to_json") {
    const indent = pretty !== false ? 2 : 0;
    const obj = {
      path: filePath,
      format: parsed.info.format,
      info: parsed.info,
      total_packets: parsed.totalPackets,
      matched_packets: allMatched.length,
      displayed_packets: displayed.length,
      packets: displayed,
    };
    const jsonStr = JSON.stringify(obj, null, indent);

    if (output_file) {
      if (output_file.includes("\0"))
        throw new ToolError("pcap_client: output_file must not contain NUL bytes.", -32602);
      const { resolved: outResolved } = resolveClientPath(output_file);
      fs.mkdirSync(path.dirname(outResolved), { recursive: true });
      fs.writeFileSync(outResolved, jsonStr, "utf8");
      return {
        path: filePath,
        output_file,
        format: parsed.info.format,
        total_packets: parsed.totalPackets,
        matched_packets: allMatched.length,
        displayed_packets: displayed.length,
        truncated: parsed.truncated,
        bytes_written: Buffer.byteLength(jsonStr),
      };
    }

    return {
      path: filePath,
      format: parsed.info.format,
      total_packets: parsed.totalPackets,
      matched_packets: allMatched.length,
      displayed_packets: displayed.length,
      truncated: parsed.truncated,
      json: jsonStr,
    };
  }

  throw new ToolError(`pcap_client: unknown operation '${operation}'.`, -32602);
}

module.exports = { pcapClient };
