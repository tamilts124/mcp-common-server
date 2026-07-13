"use strict";

const dnsClientSchema = {
  name: "dns_client",
  description: "Zero-dependency DNS client (pure Node.js dgram/net/https built-ins; no npm deps). Supports classic DNS over UDP (with automatic TCP fallback on truncation) and DNS-over-HTTPS (DoH, RFC 8484), plus the OS system resolver. Queries all common DNS record types: A, AAAA, MX, TXT, NS, SOA, CNAME, PTR, SRV, CAA, DNSKEY, DS, NAPTR, HTTPS, SVCB. Operations: query (resolve one or more record types for a name), reverse (PTR lookup for an IP address), batch (multiple queries in parallel, max 20), resolvers (list built-in resolver presets), info (return record-type table and config without I/O). Resolver presets: cloudflare (1.1.1.1), google (8.8.8.8), quad9 (9.9.9.9), system (OS default). Security: NUL-byte guards; timeout clamped 1s\u201330s; domain name validated; no credentials involved.",
  inputSchema: {
    type: "object",
    required: ["operation"],
    properties: {
      operation: {
        type: "string",
        enum: ["query", "reverse", "batch", "resolvers", "info"],
        description: "Operation to perform. query=resolve DNS record types for a domain. reverse=PTR lookup for an IP. batch=parallel multi-query (up to 20). resolvers=list built-in resolver presets. info=return record-type table and config.",
      },
      name: {
        type: "string",
        description: "Domain name to query (required for 'query'). Examples: 'example.com', 'mail.example.org', '_http._tcp.example.com'. Trailing dot accepted.",
      },
      type: {
        description: "DNS record type(s) to query (for 'query'). String or array of strings. Default: 'A'. Supported: A, AAAA, MX, TXT, NS, SOA, CNAME, PTR, SRV, CAA, DNSKEY, DS, NAPTR, HTTPS, SVCB.",
        oneOf: [
          { type: "string" },
          { type: "array", items: { type: "string" } },
        ],
      },
      ip: {
        type: "string",
        description: "IP address for reverse PTR lookup (required for 'reverse'). IPv4 (e.g. '8.8.8.8') or IPv6 (e.g. '2001:4860:4860::8888').",
      },
      queries: {
        type: "array",
        description: "Array of query objects for 'batch' operation (max 20). Each: { name, type }.",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Domain name to query." },
            type: { type: "string", description: "Record type (default 'A')." },
          },
          required: ["name"],
        },
      },
      resolver: {
        type: "string",
        description: "Resolver preset or custom IP. Presets: 'cloudflare' (1.1.1.1, default), 'google' (8.8.8.8), 'quad9' (9.9.9.9), 'system' (OS default resolver, ignores server/port). For custom: pass an IP address and set 'server' instead.",
      },
      server: {
        type: "string",
        description: "Custom DNS server IP address (e.g. '192.168.1.1') or DoH URL (e.g. 'https://my-dns.example.com/dns-query'). Overrides 'resolver' IP. Use with protocol='udp', 'tcp', or 'doh'.",
      },
      port: {
        type: "number",
        description: "DNS server port (default: 53, range: 1\u201365535). Ignored for DoH and system resolvers.",
      },
      protocol: {
        type: "string",
        enum: ["udp", "tcp", "doh", "system"],
        description: "Transport protocol. 'udp' (default): classic DNS over UDP with TCP fallback on truncation. 'tcp': DNS over TCP. 'doh': DNS-over-HTTPS (RFC 8484, encrypted). 'system': use OS resolver via Node.js dns module.",
      },
      doh_url: {
        type: "string",
        description: "Custom DoH endpoint URL for protocol='doh' (e.g. 'https://dns.example.com/dns-query'). Overrides resolver's built-in DoH URL.",
      },
      timeout: {
        type: "number",
        description: "Query timeout in milliseconds (default: 5000, range: 1000\u201330000).",
      },
    },
  },
};

module.exports = { dnsClientSchema };
