"use strict";

const whoisClientSchema = {
  name: "whois_client",
  description: "Zero-dependency WHOIS client (RFC 3912, pure Node.js net; no npm deps). Queries domain registration, IP ownership, ASN routing, and TLD data from public WHOIS servers. Automatically routes domain queries to the correct TLD WHOIS server (250+ ccTLDs and gTLDs built-in; falls back to whois.iana.org for others). Routes IP queries to the appropriate RIR (ARIN, RIPE, APNIC, LACNIC, AFRINIC) based on address block. Follows referrals (e.g. from registry WHOIS to registrar WHOIS) for richer registrant data. Operations: domain (query a domain name), ip (query an IPv4/IPv6 address), asn (query an Autonomous System Number), tld (query a TLD at IANA), raw (direct query to any WHOIS server), info (config/routing reference without I/O). Security: NUL-byte guards; timeout clamped 1s-30s; response capped 128KB; referral depth capped at 3 hops.",
  inputSchema: {
    type: "object",
    required: ["operation"],
    properties: {
      operation: {
        type: "string",
        enum: ["domain", "ip", "asn", "tld", "raw", "info"],
        description: "Operation to perform. domain=query a domain name (e.g. 'example.com'), ip=query an IPv4 or IPv6 address, asn=query an Autonomous System Number (e.g. 'AS15169' or 15169), tld=query a TLD at IANA (e.g. 'com'), raw=send a custom query to any WHOIS server, info=show routing table and config without connecting.",
      },
      domain: {
        type: "string",
        description: "Domain name to query (for operation 'domain'). Example: 'example.com', 'subdomain.example.co.uk'. The TLD is used to route to the correct WHOIS server automatically.",
      },
      ip: {
        type: "string",
        description: "IPv4 or IPv6 address to query (for operation 'ip'). Examples: '8.8.8.8', '2001:4860:4860::8888'. Routed to the appropriate RIR automatically.",
      },
      asn: {
        description: "Autonomous System Number to query (for operation 'asn'). Accepts numeric (15169), 'AS15169', or 'ASN15169' format. Range: 0\u20134294967295.",
      },
      tld: {
        type: "string",
        description: "Top-Level Domain to query at IANA (for operation 'tld'). Examples: 'com', 'uk', 'io'. Leading dot is stripped automatically.",
      },
      query: {
        type: "string",
        description: "Raw query string to send to the WHOIS server (for operation 'raw'). Sent verbatim followed by \\r\\n.",
      },
      server: {
        type: "string",
        description: "WHOIS server hostname to query. Auto-detected for domain/ip/asn/tld operations. Required for 'raw'. Can override auto-detection for other operations (e.g. force a specific RIR or registrar).",
      },
      port: {
        type: "number",
        description: "TCP port of the WHOIS server (default: 43, the standard WHOIS port). Use only if the server runs on a non-standard port.",
      },
      timeout: {
        type: "number",
        description: "Query timeout in milliseconds (default: 10000, range: 1000-30000).",
      },
      follow_referrals: {
        type: "boolean",
        description: "If true (default), follow WHOIS referrals to get registrar-level data (e.g. from Verisign to the registrar's WHOIS). Adds one extra network hop. Set to false for registry-only data.",
      },
    },
  },
};

module.exports = { whoisClientSchema };
