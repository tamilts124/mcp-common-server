"use strict";
// ── ip_cidr — zero-dep IP/CIDR subnet toolkit ─────────────────────────────
// Operations: info, contains, enumerate, convert, classify, subnets.
// Supports IPv4 (full) and IPv6 (info/classify/convert/contains/enumerate).

const { ToolError } = require("./errors");

// ──────────────────────── IPv4 helpers ──────────────────────────────

/** Parse a dotted-decimal IPv4 string to a 32-bit unsigned integer. */
function ipv4ToInt(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) throw new ToolError(`Invalid IPv4 address: '${ip}'`, -32602);
  let n = 0;
  for (const p of parts) {
    const b = parseInt(p, 10);
    if (isNaN(b) || b < 0 || b > 255 || String(b) !== p.trim())
      throw new ToolError(`Invalid IPv4 octet '${p}' in '${ip}'`, -32602);
    n = (n * 256 + b) >>> 0;
  }
  return n;
}

/** Convert a 32-bit unsigned integer back to dotted-decimal IPv4. */
function intToIpv4(n) {
  return [
    (n >>> 24) & 0xff,
    (n >>> 16) & 0xff,
    (n >>>  8) & 0xff,
     n         & 0xff,
  ].join(".");
}

/** Convert an integer to a zero-padded 8-hex-digit string. */
function intToHex(n) {
  return (n >>> 0).toString(16).padStart(8, "0");
}

/** Convert an integer to a 32-bit binary string. */
function intToBin(n) {
  return (n >>> 0).toString(2).padStart(32, "0");
}

/**
 * Parse a CIDR string like '192.168.1.0/24'.
 * Returns { ip, prefix, network, broadcast, mask, firstHost, lastHost, hostCount }.
 */
function parseCidrV4(cidr) {
  const slash = cidr.indexOf("/");
  let ipStr, prefix;
  if (slash === -1) {
    // Plain IP, treat as /32
    ipStr = cidr;
    prefix = 32;
  } else {
    ipStr = cidr.slice(0, slash);
    prefix = parseInt(cidr.slice(slash + 1), 10);
    if (isNaN(prefix) || prefix < 0 || prefix > 32)
      throw new ToolError(`Invalid CIDR prefix length: '${cidr.slice(slash + 1)}'`, -32602);
  }
  const ipInt  = ipv4ToInt(ipStr);
  const mask   = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  const network  = (ipInt & mask) >>> 0;
  const broadcast = (network | ~mask) >>> 0;
  const hostCount = prefix >= 31 ? Math.pow(2, 32 - prefix) : Math.max(0, broadcast - network - 1);
  const firstHost = prefix >= 31 ? network : network + 1;
  const lastHost  = prefix >= 31 ? broadcast : broadcast - 1;
  return {
    ip:        ipStr,
    ipInt,
    prefix,
    mask:      intToIpv4(mask),
    maskInt:   mask,
    network:   intToIpv4(network),
    networkInt: network,
    broadcast: intToIpv4(broadcast),
    broadcastInt: broadcast,
    firstHost: intToIpv4(firstHost),
    lastHost:  intToIpv4(lastHost),
    hostCount,
    totalAddresses: Math.pow(2, 32 - prefix),
  };
}

// ──────────────────────── IP classification ───────────────────────────

/** Classify an IPv4 integer by RFC ranges. Returns a type label. */
function classifyIpv4Int(n) {
  //  0.0.0.0/8        this-network
  if ((n & 0xff000000) >>> 0 === 0x00000000) return "this_network";
  //  10.0.0.0/8       private (RFC 1918)
  if ((n & 0xff000000) >>> 0 === 0x0a000000) return "private";
  //  100.64.0.0/10    shared address space (RFC 6598)
  if ((n & 0xffc00000) >>> 0 === 0x64400000) return "shared";
  //  127.0.0.0/8      loopback
  if ((n & 0xff000000) >>> 0 === 0x7f000000) return "loopback";
  //  169.254.0.0/16   link-local
  if ((n & 0xffff0000) >>> 0 === 0xa9fe0000) return "link_local";
  //  172.16.0.0/12    private (RFC 1918)
  if ((n & 0xfff00000) >>> 0 === 0xac100000) return "private";
  //  192.0.0.0/24     IETF protocol assignments
  if ((n & 0xffffff00) >>> 0 === 0xc0000000) return "reserved";
  //  192.0.2.0/24     TEST-NET-1 (documentation)
  if ((n & 0xffffff00) >>> 0 === 0xc0000200) return "documentation";
  //  192.88.99.0/24   6to4 relay anycast (deprecated)
  if ((n & 0xffffff00) >>> 0 === 0xc0586300) return "reserved";
  //  192.168.0.0/16   private (RFC 1918)
  if ((n & 0xffff0000) >>> 0 === 0xc0a80000) return "private";
  //  198.18.0.0/15    benchmarking
  if ((n & 0xfffe0000) >>> 0 === 0xc6120000) return "benchmarking";
  //  198.51.100.0/24  TEST-NET-2 (documentation)
  if ((n & 0xffffff00) >>> 0 === 0xc6336400) return "documentation";
  //  203.0.113.0/24   TEST-NET-3 (documentation)
  if ((n & 0xffffff00) >>> 0 === 0xcb007100) return "documentation";
  //  224.0.0.0/4      multicast
  if ((n & 0xf0000000) >>> 0 === 0xe0000000) return "multicast";
  //  240.0.0.0/4      reserved (future use)
  if ((n & 0xf0000000) >>> 0 === 0xf0000000) return "reserved";
  //  255.255.255.255  limited broadcast
  if (n === 0xffffffff) return "limited_broadcast";
  return "public";
}

// ──────────────────────── IPv6 helpers ──────────────────────────────

/** Expand a compressed IPv6 address to 8 full groups of 4 hex digits. */
function expandIpv6(ip) {
  // Handle ::1 (loopback) and other :: forms
  let addr = ip;
  // Remove zone ID (e.g. %eth0)
  const pctIdx = addr.indexOf("%");
  if (pctIdx !== -1) addr = addr.slice(0, pctIdx);

  if (addr.includes("::")) {
    const [left, right] = addr.split("::");
    const leftParts  = left  ? left.split(":")  : [];
    const rightParts = right ? right.split(":") : [];
    const missing = 8 - leftParts.length - rightParts.length;
    const middle  = Array(missing).fill("0000");
    addr = [...leftParts, ...middle, ...rightParts].join(":");
  }
  const groups = addr.split(":");
  if (groups.length !== 8) throw new ToolError(`Invalid IPv6 address: '${ip}'`, -32602);
  return groups.map(g => g.padStart(4, "0").toLowerCase()).join(":");
}

/** Parse an expanded IPv6 into a BigInt (128-bit). */
function ipv6ToBigInt(expanded) {
  return expanded.split(":").reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n);
}

/** Convert a BigInt back to an expanded IPv6 string. */
function bigIntToIpv6(n) {
  const groups = [];
  for (let i = 0; i < 8; i++) {
    groups.unshift((n & 0xffffn).toString(16).padStart(4, "0"));
    n >>= 16n;
  }
  return groups.join(":");
}

/** Compress an expanded IPv6 address using '::' for the longest run of zeros. */
function compressIpv6(expanded) {
  const groups = expanded.split(":");
  // Find longest run of consecutive "0000" groups
  let bestStart = -1, bestLen = 0, curStart = -1, curLen = 0;
  for (let i = 0; i < groups.length; i++) {
    if (groups[i] === "0000") {
      if (curStart === -1) { curStart = i; curLen = 1; }
      else curLen++;
      if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
    } else {
      curStart = -1; curLen = 0;
    }
  }
  const stripped = groups.map(g => g.replace(/^0+/, "") || "0");
  if (bestLen < 2) return stripped.join(":");
  const left  = stripped.slice(0, bestStart).join(":");
  const right = stripped.slice(bestStart + bestLen).join(":");
  return (left ? left + "::" : "::") + right;
}

/** Classify an IPv6 BigInt. */
function classifyIpv6BigInt(n, expanded) {
  if (n === 1n) return "loopback"; // ::1
  if (n === 0n) return "unspecified";
  // fe80::/10 - link-local
  if ((n >> 118n) === 0x3fan) return "link_local";
  // ff00::/8 - multicast
  if ((n >> 120n) === 0xffn) return "multicast";
  // fc00::/7 - unique local (ULA)
  if ((n >> 121n) === 0x7en) return "private";
  // 2002::/16 - 6to4
  if ((n >> 112n) === 0x2002n) return "6to4";
  // 2001::/32 - Teredo
  if ((n >> 96n) === 0x20010000n) return "teredo";
  // 0100::/64 - discard (RFC 6666): top 64 bits == 0x0100:0000:0000:0000
  if ((n >> 64n) === 0x0100_0000_0000_0000n) return "discard";
  // ::ffff:0:0/96 - IPv4-mapped (RFC 4291): top 96 bits == 0x0000ffff
  if ((n >> 32n) === 0xffffn) return "ipv4_mapped";
  return "public";
}

// ──────────────────────── detect IP version ───────────────────────────

function detectVersion(s) {
  if (!s || typeof s !== "string") return null;
  const noPrefix = s.split("/")[0];
  if (noPrefix.includes(":")) return 6;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(noPrefix)) return 4;
  return null;
}

// ──────────────────────── main export ──────────────────────────────

function ipCidr(args) {
  const op = (args.operation || "").trim();
  if (!op) throw new ToolError("ip_cidr: 'operation' is required.", -32602);

  switch (op) {

    // ———————————————————————————————————————————————————
    case "info": {
      // Parse a CIDR or plain IP and return full subnet information.
      const cidr = args.cidr || args.ip;
      if (!cidr) throw new ToolError("ip_cidr(info): provide 'cidr' or 'ip'.", -32602);
      const ver = detectVersion(cidr);
      if (ver === 4) {
        const p = parseCidrV4(cidr);
        const type = classifyIpv4Int(p.ipInt);
        return {
          operation: op, version: 4, input: cidr, type,
          ip: p.ip, prefix: p.prefix,
          network: p.network, broadcast: p.broadcast,
          mask: p.mask,
          firstHost: p.firstHost, lastHost: p.lastHost,
          hostCount: p.hostCount, totalAddresses: p.totalAddresses,
          hex: "0x" + intToHex(p.ipInt),
          integer: p.ipInt,
          binary: intToBin(p.ipInt),
          networkHex: "0x" + intToHex(p.networkInt),
          broadcastHex: "0x" + intToHex(p.broadcastInt),
        };
      } else if (ver === 6) {
        const ipStr  = cidr.split("/")[0];
        const expanded = expandIpv6(ipStr);
        const compressed = compressIpv6(expanded);
        const bigInt = ipv6ToBigInt(expanded);
        const type = classifyIpv6BigInt(bigInt, expanded);
        let prefix = 128;
        let networkBig = bigInt, lastBig = bigInt;
        let totalAddresses = 1n;
        if (cidr.includes("/")) {
          prefix = parseInt(cidr.split("/")[1], 10);
          if (isNaN(prefix) || prefix < 0 || prefix > 128)
            throw new ToolError(`Invalid IPv6 prefix: '${cidr}'`, -32602);
          const mask = prefix === 0 ? 0n : (~0n << BigInt(128 - prefix)) & ((1n << 128n) - 1n);
          networkBig = bigInt & mask;
          lastBig = networkBig | (~mask & ((1n << 128n) - 1n));
          totalAddresses = 1n << BigInt(128 - prefix);
        }
        return {
          operation: op, version: 6, input: cidr, type,
          ip: compressed, expanded, prefix,
          network: compressIpv6(bigIntToIpv6(networkBig)),
          networkExpanded: bigIntToIpv6(networkBig),
          lastAddress: compressIpv6(bigIntToIpv6(lastBig)),
          totalAddresses: totalAddresses.toString(),
          hex: "0x" + bigInt.toString(16).padStart(32, "0"),
        };
      } else {
        throw new ToolError(`ip_cidr(info): cannot determine IP version for '${cidr}'.`, -32602);
      }
    }

    // ———————————————————————————————————————————————————
    case "contains": {
      // Check whether an IP is within a CIDR block.
      const cidr = args.cidr;
      const ip   = args.ip;
      if (!cidr) throw new ToolError("ip_cidr(contains): 'cidr' is required.", -32602);
      if (!ip)   throw new ToolError("ip_cidr(contains): 'ip' is required.", -32602);
      const verCidr = detectVersion(cidr);
      const verIp   = detectVersion(ip);
      if (verCidr !== verIp)
        throw new ToolError(
          `ip_cidr(contains): CIDR version (v${verCidr}) does not match IP version (v${verIp}).`, -32602);
      if (verCidr === 4) {
        const p = parseCidrV4(cidr);
        const ipInt = ipv4ToInt(ip);
        const ipType = classifyIpv4Int(ipInt);
        const inRange = (ipInt & p.maskInt) >>> 0 === p.networkInt;
        return {
          operation: op, version: 4,
          cidr, ip, contains: inRange,
          network: p.network, broadcast: p.broadcast,
          ip_type: ipType,
        };
      } else if (verCidr === 6) {
        const ipStr = ip.split("/")[0];
        const cidrStr = cidr.split("/")[0];
        const prefix = cidr.includes("/") ? parseInt(cidr.split("/")[1], 10) : 128;
        const ipBig  = ipv6ToBigInt(expandIpv6(ipStr));
        const netBig = ipv6ToBigInt(expandIpv6(cidrStr));
        const mask = prefix === 0 ? 0n : (~0n << BigInt(128 - prefix)) & ((1n << 128n) - 1n);
        const network = netBig & mask;
        const inRange = (ipBig & mask) === network;
        return { operation: op, version: 6, cidr, ip, contains: inRange, prefix };
      } else {
        throw new ToolError("ip_cidr(contains): unsupported IP version.", -32602);
      }
    }

    // ———————————————————————————————————————————————————
    case "enumerate": {
      // List all IPs in a CIDR block (IPv4 only for large ranges).
      const cidr = args.cidr;
      if (!cidr) throw new ToolError("ip_cidr(enumerate): 'cidr' is required.", -32602);
      const maxResults = typeof args.max_results === "number"
        ? Math.min(Math.max(1, Math.floor(args.max_results)), 65536)
        : 256;
      const ver = detectVersion(cidr);
      if (ver !== 4)
        throw new ToolError("ip_cidr(enumerate): only IPv4 CIDR enumeration is supported.", -32602);
      const p = parseCidrV4(cidr);
      const ips = [];
      const limit = Math.min(p.totalAddresses, maxResults);
      for (let i = 0; i < limit; i++) {
        ips.push(intToIpv4(p.networkInt + i));
      }
      return {
        operation: op, version: 4, cidr,
        network: p.network, broadcast: p.broadcast,
        totalAddresses: p.totalAddresses,
        returned: ips.length,
        truncated: p.totalAddresses > maxResults,
        addresses: ips,
      };
    }

    // ———————————————————————————————————————————————————
    case "convert": {
      // Convert an IPv4 address between dotted-decimal, hex, integer, and binary.
      const ip = args.ip;
      if (!ip) throw new ToolError("ip_cidr(convert): 'ip' is required.", -32602);
      // Pre-check: bare integer (e.g. 3232235777) or 0x hex are IPv4 directly,
      // since detectVersion only recognises dotted-decimal and colon-notation.
      if (/^\d+$/.test(ip) || /^0[xX][0-9a-fA-F]+$/.test(ip)) {
        const n = (ip.startsWith("0x") || ip.startsWith("0X"))
          ? parseInt(ip, 16) >>> 0
          : parseInt(ip, 10) >>> 0;
        return {
          operation: op, version: 4, input: ip,
          dotted:  intToIpv4(n),
          hex:     "0x" + intToHex(n),
          integer: n,
          binary:  intToBin(n),
          type:    classifyIpv4Int(n),
        };
      }
      const ver = detectVersion(ip);
      if (ver === 4) {
        const n = ipv4ToInt(ip);
        return {
          operation: op, version: 4, input: ip,
          dotted:  intToIpv4(n),
          hex:     "0x" + intToHex(n),
          integer: n,
          binary:  intToBin(n),
          type:    classifyIpv4Int(n),
        };
      } else if (ver === 6) {
        const expanded = expandIpv6(ip);
        const compressed = compressIpv6(expanded);
        const bigInt = ipv6ToBigInt(expanded);
        return {
          operation: op, version: 6, input: ip,
          compressed,
          expanded,
          hex: "0x" + bigInt.toString(16).padStart(32, "0"),
          integer: bigInt.toString(),
          type: classifyIpv6BigInt(bigInt, expanded),
        };
      } else {
        throw new ToolError(`ip_cidr(convert): cannot parse '${ip}' as IPv4 or IPv6.`, -32602);
      }
    }

    // ———————————————————————————————————————————————————
    case "classify": {
      // Classify one or more IPs by type.
      const ips = args.ips || (args.ip ? [args.ip] : null);
      if (!ips || !Array.isArray(ips) || ips.length === 0)
        throw new ToolError("ip_cidr(classify): provide 'ip' (string) or 'ips' (array).", -32602);
      if (ips.length > 1000)
        throw new ToolError("ip_cidr(classify): 'ips' may contain at most 1000 entries.", -32602);
      const results = ips.map(addr => {
        try {
          const ver = detectVersion(addr);
          if (ver === 4) {
            const n = ipv4ToInt(addr);
            return { ip: addr, version: 4, type: classifyIpv4Int(n) };
          } else if (ver === 6) {
            const expanded = expandIpv6(addr);
            const n = ipv6ToBigInt(expanded);
            return { ip: addr, version: 6, type: classifyIpv6BigInt(n, expanded) };
          } else {
            return { ip: addr, version: null, type: null, error: "unrecognized address" };
          }
        } catch (e) {
          return { ip: addr, version: null, type: null, error: e.message };
        }
      });
      return { operation: op, results };
    }

    // ———————————————————————————————————————————————————
    case "subnets": {
      // Split a CIDR block into N equal subnets.
      const cidr = args.cidr;
      if (!cidr) throw new ToolError("ip_cidr(subnets): 'cidr' is required.", -32602);
      const ver = detectVersion(cidr);
      if (ver !== 4)
        throw new ToolError("ip_cidr(subnets): only IPv4 CIDR subnetting is supported.", -32602);
      const bits  = typeof args.bits  === "number" ? args.bits  : null;
      const count = typeof args.count === "number" ? args.count : null;
      const p = parseCidrV4(cidr);
      let newPrefix;
      if (bits !== null) {
        if (!Number.isInteger(bits) || bits < 1 || bits > 16)
          throw new ToolError("ip_cidr(subnets): 'bits' must be an integer 1-16.", -32602);
        newPrefix = p.prefix + bits;
      } else if (count !== null) {
        if (!Number.isInteger(count) || count < 2)
          throw new ToolError("ip_cidr(subnets): 'count' must be an integer >= 2.", -32602);
        // Find minimum number of extra bits to cover 'count' subnets
        const extraBits = Math.ceil(Math.log2(count));
        newPrefix = p.prefix + extraBits;
      } else {
        // Default: split into 2 (1 bit)
        newPrefix = p.prefix + 1;
      }
      if (newPrefix > 32)
        throw new ToolError(
          `ip_cidr(subnets): new prefix /${newPrefix} exceeds /32 — original CIDR too small to split further.`, -32602);
      const subnetSize = Math.pow(2, 32 - newPrefix);
      const subnetCount = Math.pow(2, newPrefix - p.prefix);
      const maxReturn = Math.min(subnetCount, 1024);
      const subnets = [];
      for (let i = 0; i < maxReturn; i++) {
        const networkInt = (p.networkInt + i * subnetSize) >>> 0;
        const broadcastInt = (networkInt + subnetSize - 1) >>> 0;
        subnets.push({
          cidr: `${intToIpv4(networkInt)}/${newPrefix}`,
          network: intToIpv4(networkInt),
          broadcast: intToIpv4(broadcastInt),
          firstHost: intToIpv4(newPrefix >= 31 ? networkInt : networkInt + 1),
          lastHost: intToIpv4(newPrefix >= 31 ? broadcastInt : broadcastInt - 1),
          hostCount: newPrefix >= 31 ? subnetSize : Math.max(0, subnetSize - 2),
        });
      }
      return {
        operation: op, version: 4,
        parent: cidr, parentPrefix: p.prefix, newPrefix,
        subnetCount, subnetSize, returned: subnets.length,
        truncated: subnetCount > 1024,
        subnets,
      };
    }

    default:
      throw new ToolError(
        `ip_cidr: unknown operation '${op}'. Valid operations: ` +
        "info, contains, enumerate, convert, classify, subnets.",
        -32602
      );
  }
}

module.exports = { ipCidr };
