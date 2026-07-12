"use strict";
// -- UTILITY TOOL SCHEMAS -- part 32 ------------------------------------------
// Added: snmp_client (v4.171.0).

const UTIL_SCHEMAS_32 = [
  {
    name: "snmp_client",
    description:
      "Zero-dependency SNMP v1/v2c client -- pure Node.js dgram/crypto, no npm deps.\n\n" +
      "Implements RFC 1157 (SNMPv1) and RFC 1901/1905 (SNMPv2c).\n\n" +
      "Compatible with: network switches, routers, servers, UPS units, printers,\n" +
      "firewalls, IoT devices, and any SNMP-enabled infrastructure equipment.\n\n" +
      "Operations:\n" +
      "  get       -- GET one or more OID values (RFC 1157 GetRequest-PDU)\n" +
      "  get_next  -- GETNEXT: fetch the next OID after each given OID\n" +
      "  get_bulk  -- GETBULK: bulk-fetch many OIDs in one request (v2c only)\n" +
      "  walk      -- Walk an OID subtree using repeated GETNEXT/GETBULK calls\n" +
      "  set       -- SET one or more OID values (write-capable community required)\n\n" +
      "Authentication:\n" +
      "  community: SNMP community string (default: 'public' for read-only).\n" +
      "  For write operations (set), a write-enabled community is required (e.g. 'private').\n\n" +
      "OID convenience aliases (common MIB-II names are accepted):\n" +
      "  sysDescr, sysObjectID, sysUpTime, sysContact, sysName, sysLocation,\n" +
      "  sysServices, ifNumber, ifIndex, ifDescr, ifType, ifSpeed, ifAdminStatus,\n" +
      "  ifOperStatus, ifInOctets, ifOutOctets, hrSystemUptime, hrProcessorLoad,\n" +
      "  tcpConnState, udpInDatagrams\n\n" +
      "Returns decoded variable bindings with typed values:\n" +
      "  integer, octet_string, oid, ip_address, counter32, counter64, gauge32,\n" +
      "  timeticks, opaque, null, noSuchObject, noSuchInstance, endOfMibView\n\n" +
      "Security guards:\n" +
      "  NUL and CRLF injection guards on host and community fields\n" +
      "  Max 100 OIDs per request; max 256-char OIDs; max 64 KB UDP response\n" +
      "  Community string never returned in result objects\n\n" +
      "Returns { host, port, version, operation, elapsedMs, varBinds, count, ...op-specific }.\n" +
      "Always available -- does not require MCP_ALLOW_EXEC.",
    inputSchema: {
      type: "object",
      required: ["host", "operation"],
      properties: {
        host: {
          type: "string",
          description: "SNMP agent hostname or IP address.",
        },
        port: {
          type: "number",
          description: "SNMP UDP port (default: 161).",
        },
        version: {
          type: "string",
          enum: ["v1", "v2c"],
          description: "SNMP version: 'v1' (RFC 1157) or 'v2c' (RFC 1901, default). Use v2c for get_bulk and for better error handling.",
        },
        community: {
          type: "string",
          description: "SNMP community string. Use 'public' for read-only (default), 'private' for write. Never returned in results.",
        },
        timeout: {
          type: "number",
          description: "Request timeout in seconds (default: 5). Total wall-clock timeout for the UDP round-trip.",
        },
        operation: {
          type: "string",
          enum: ["get", "get_next", "get_bulk", "walk", "set"],
          description:
            "SNMP operation: get (fetch specific OIDs), get_next (next OID after each given), " +
            "get_bulk (bulk-fetch, v2c only), walk (traverse subtree), set (write OID values).",
        },
        oid: {
          type: "string",
          description:
            "Single OID to query (dot-notation, e.g. '1.3.6.1.2.1.1.1.0', or MIB alias like 'sysDescr'). " +
            "For 'walk', this is the root OID of the subtree to traverse. " +
            "Use 'oids' (array) to query multiple OIDs in one request.",
        },
        oids: {
          type: "array",
          items: { type: "string" },
          description:
            "Array of OIDs to query (dot-notation or MIB aliases). Max 100. " +
            "For get/get_next/get_bulk only; for walk use 'oid' (single root OID).",
        },
        non_repeaters: {
          type: "number",
          description: "get_bulk: Number of non-repeating OIDs at the start of the list (default: 0).",
        },
        max_repetitions: {
          type: "number",
          description: "get_bulk: Max repetitions per repeating OID (default: 10).",
        },
        max_results: {
          type: "number",
          description: "walk: Maximum number of variable bindings to collect before stopping (default: 100, max: 1000).",
        },
        set_vars: {
          type: "array",
          description: "set: Array of {oid, type, value} objects to write. Type must be one of: integer, octet_string, ip_address, counter32, gauge32, timeticks.",
          items: {
            type: "object",
            required: ["oid", "type", "value"],
            properties: {
              oid:   { type: "string", description: "OID to set (dot-notation or alias)." },
              type:  {
                type: "string",
                enum: ["integer", "octet_string", "ip_address", "counter32", "gauge32", "timeticks"],
                description: "SNMP value type.",
              },
              value: { description: "Value to set. Use a number for numeric types, string for octet_string and ip_address." },
            },
          },
        },
      },
    },
  },
];

module.exports = { UTIL_SCHEMAS_32 };
