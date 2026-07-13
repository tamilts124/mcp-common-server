"use strict";

const tlsClientSchema = {
  name: "tls_client",
  description: "Zero-dependency live TLS/SSL inspector (pure Node.js tls built-in; no npm deps). Connects to a server and returns the full certificate chain, negotiated protocol/cipher, ALPN, SANs, validity, fingerprints, key usage, and a security grade. Operations: inspect (full TLS session details + cert chain + security assessment), chain (certificate chain in PEM + parsed form), ciphers (probe which TLS 1.2 cipher suites the server accepts), verify (check cert validity against system roots or a custom CA PEM; reports hostname match), scan (probe multiple ports concurrently for TLS presence), info (return tool config without I/O). Security: NUL-byte guards; timeout clamped 1s–30s; port 1–65535; SNI sent by default; never logs credentials or key material.",
  inputSchema: {
    type: "object",
    required: ["operation"],
    properties: {
      operation: {
        type: "string",
        enum: ["inspect", "chain", "ciphers", "verify", "scan", "info"],
        description: "Operation to perform. inspect=full TLS session + cert chain + security grade. chain=certificate chain PEM + parsed fields. ciphers=probe TLS 1.2 cipher suite support. verify=validate cert chain against system roots or custom CA. scan=probe multiple ports for TLS. info=return config without connecting.",
      },
      host: {
        type: "string",
        description: "Hostname or IP address to connect to. Required for all operations except 'info'. Example: 'example.com', '93.184.216.34'.",
      },
      port: {
        type: "number",
        description: "TCP port to connect to (default: 443, range: 1–65535).",
      },
      servername: {
        type: "string",
        description: "TLS SNI server name override. Defaults to 'host'. Set to '' to disable SNI (useful for IP-only servers).",
      },
      verify_certificate: {
        type: "boolean",
        description: "If true (default), the TLS handshake validates the server certificate against system roots. Set to false to connect to servers with self-signed or expired certificates — the certificate data is still returned for inspection.",
      },
      ca_pem: {
        type: "string",
        description: "PEM-encoded CA certificate bundle to use for certificate verification (for operation 'verify'). If omitted, the system's default trusted roots are used.",
      },
      ports: {
        type: "array",
        items: { type: "number" },
        description: "Array of TCP port numbers to probe (for operation 'scan'). If omitted, a built-in list of 12 well-known TLS ports is used (443, 8443, 465, 587, 636, 993, 995, 3389, 5671, 5986, 8883, 9093). Maximum 50 ports.",
      },
      timeout: {
        type: "number",
        description: "Connection timeout in milliseconds (default: 10000, range: 1000–30000).",
      },
    },
  },
};

module.exports = { tlsClientSchema };
