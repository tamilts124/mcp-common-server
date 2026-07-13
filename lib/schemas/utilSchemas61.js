"use strict";
// lib/schemas/utilSchemas61.js -- JSON schema for pcap_client tool

const UTIL_SCHEMAS_61 = [
  {
    name: "pcap_client",
    description:
      "Zero-dependency PCAP / PCAPng network-capture file reader (pure Node.js; no npm deps). " +
      "Reads .pcap files produced by tcpdump, Wireshark, tshark, and compatible tools, " +
      "and .pcapng (next-generation) files produced by Wireshark/tshark/dumpcap. " +
      "Automatically detects format from file magic (PCAP little/big/nanosecond variants, PCAPng). " +
      "Decodes Ethernet, NULL/loopback, Linux SLL, and Raw IP link layers. " +
      "Decodes IPv4 and IPv6 headers (including TTL, TOS, hop limit). " +
      "Decodes TCP (flags, seq/ack, window), UDP (with DNS/DHCP/NTP/SNMP/mDNS app-protocol detection), " +
      "ICMPv4, ICMPv6, ARP, OSPF, GRE, ESP, AH. " +
      "Operations: " +
      "info (file-level metadata: format, link type, packet count, endianness, snaplen); " +
      "read (return decoded packets with optional offset/limit/filter); " +
      "summary (traffic statistics: protocol breakdown, top IPs/ports, conversations, duration, byte counts); " +
      "filter (return only packets matching a filter expression); " +
      "to_json (export packets to a JSON string or file). " +
      "Filter expression syntax: field==value, field!=value, field>=N combined with && and ||. " +
      "Filterable fields: protocol, src_ip, dst_ip, src_port, dst_port, tcp_flags, app_protocol, captured_bytes. " +
      "Security: 500 MB file cap; 10,000,000 packet limit; NUL-byte path guard; directory path rejected.",
    inputSchema: {
      type: "object",
      required: ["operation", "path"],
      additionalProperties: false,
      properties: {
        operation: {
          type: "string",
          enum: ["info", "read", "summary", "filter", "to_json"],
          description:
            "Operation to perform. " +
            "'info': return file-level metadata (format, link type, packet count, endianness, snaplen, interface list for PCAPng). " +
            "'read': decode and return packets; supports offset/limit/filter. " +
            "'summary': compute traffic statistics over matched packets (protocol breakdown, top IPs/ports, conversations, duration, byte totals); supports filter. " +
            "'filter': like 'read' but requires a filter expression; same output shape. " +
            "'to_json': export decoded packets to a JSON string or write to output_file; supports offset/limit/filter.",
        },

        path: {
          type: "string",
          description:
            "Path to the .pcap or .pcapng capture file to read. " +
            "Both classic libpcap format and PCAPng are supported and auto-detected.",
        },

        offset: {
          type: "integer",
          minimum: 0,
          description:
            "For 'read', 'filter', 'to_json': skip this many (matched) packets from the start. Default: 0.",
        },

        limit: {
          type: "integer",
          minimum: 1,
          description:
            "For 'read', 'filter', 'to_json': maximum number of (matched) packets to return/export. " +
            "Default: all matched packets.",
        },

        filter: {
          type: "string",
          description:
            "Filter expression to select a subset of packets. " +
            "Syntax: field OPERATOR value, combined with && (AND) and || (OR). " +
            "Operators: == (equal), != (not equal), >= <= > < (numeric comparison). " +
            "Filterable fields: protocol (e.g. 'TCP', 'UDP', 'ICMP', 'ARP'), " +
            "src_ip, dst_ip (e.g. '192.168.1.1'), " +
            "src_port, dst_port (integer), " +
            "tcp_flags (e.g. 'SYN', 'SYN|ACK'), " +
            "app_protocol (e.g. 'DNS', 'DHCP', 'NTP'), " +
            "captured_bytes, original_bytes. " +
            "Examples: 'protocol==TCP && dst_port==443', " +
            "'src_ip==10.0.0.1 || dst_ip==10.0.0.1', " +
            "'protocol==UDP && (src_port==53 || dst_port==53)', " +
            "'captured_bytes>=1400'.",
        },

        output_file: {
          type: "string",
          description:
            "For 'to_json': path to write the JSON output file. " +
            "If omitted, the JSON is returned inline in the response.",
        },

        pretty: {
          type: "boolean",
          description:
            "For 'to_json': pretty-print the JSON output with 2-space indentation. Default: true.",
        },
      },
    },
  },
];

module.exports = { UTIL_SCHEMAS_61 };
