"use strict";
// ── UTILITY TOOL SCHEMAS — part 30 ──────────────────────────────────────────────
// Added: ldap_client (v4.169.0).

const UTIL_SCHEMAS_30 = [
  {
    name: "ldap_client",
    description:
      "Zero-dependency LDAP v3 client — pure Node.js net/tls, no npm deps.\n\n" +
      "Implements RFC 4511 (LDAPv3) with BER (Basic Encoding Rules) codec.\n\n" +
      "Compatible with: OpenLDAP, Microsoft Active Directory, FreeIPA, 389 Directory Server,\n" +
      "Oracle Directory Server, Apache Directory Server, Novell eDirectory.\n\n" +
      "Operations:\n" +
      "  bind     — Authenticate a DN with a password (or anonymous bind)\n" +
      "  search   — LDAP search with filter, scope, and attribute selection\n" +
      "  add      — Add a new directory entry with attributes\n" +
      "  modify   — Modify attributes of an existing entry (add/delete/replace)\n" +
      "  delete   — Delete a directory entry by DN\n" +
      "  compare  — Compare an attribute value against the directory value\n" +
      "  whoami   — RFC 4532 LDAP Who Am I? extended operation\n\n" +
      "Connection options:\n" +
      "  host, port (default 389 / 636 for TLS), tls, reject_unauthorized\n" +
      "  bind_dn, bind_password (LDAP simple bind; credentials never echoed)\n" +
      "  sasl_mechanism, sasl_credentials (for SASL auth)\n" +
      "  timeout (default 30s), connect_timeout\n\n" +
      "Security guards:\n" +
      "  NUL-byte injection guards on all DN, attribute, filter fields\n" +
      "  Max DN length: 1024 chars; max attribute value: 8192 chars\n" +
      "  8 MB incoming data cap\n" +
      "  Credentials never included in result objects\n\n" +
      "Returns { host, port, operation, elapsedMs, ...op-specific fields }.\n" +
      "Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: {
      type: "object",
      required: ["host", "operation"],
      properties: {
        host: {
          type: "string",
          description: "LDAP server hostname or IP address.",
        },
        port: {
          type: "number",
          description: "LDAP server port (default: 389, or 636 when tls:true).",
        },
        tls: {
          type: "boolean",
          description: "Use LDAPS (TLS). Default: false.",
        },
        reject_unauthorized: {
          type: "boolean",
          description: "Reject self-signed TLS certificates (default: true).",
        },
        bind_dn: {
          type: "string",
          description: "Distinguished Name (DN) to bind as (e.g. 'cn=admin,dc=example,dc=com'). Leave empty for anonymous bind.",
        },
        bind_password: {
          type: "string",
          description: "Password for simple bind. Never returned in results.",
        },
        sasl_mechanism: {
          type: "string",
          description: "SASL mechanism name (e.g. 'EXTERNAL', 'GSSAPI'). When set, sasl_credentials may be provided.",
        },
        sasl_credentials: {
          type: "string",
          description: "Base64-encoded SASL credentials (mechanism-specific).",
        },
        timeout: {
          type: "number",
          description: "Total wall-clock timeout in seconds (default: 30).",
        },
        connect_timeout: {
          type: "number",
          description: "TCP connection timeout in seconds (default: min(timeout, 10)).",
        },
        operation: {
          type: "string",
          enum: ["bind", "search", "add", "modify", "delete", "compare", "whoami"],
          description:
            "LDAP operation: bind (authenticate), search (query entries), " +
            "add (create entry), modify (change attributes), delete (remove entry), " +
            "compare (check attribute value), whoami (RFC 4532 identity query).",
        },
        base_dn: {
          type: "string",
          description: "Search base DN (e.g. 'dc=example,dc=com'). For: search.",
        },
        scope: {
          type: ["string", "number"],
          description: "Search scope: 'base' (0), 'one' (1), or 'sub' (2, default). For: search.",
        },
        filter: {
          type: "string",
          description: "RFC 4515 LDAP filter string (e.g. '(objectClass=*)', '(&(uid=jdoe)(active=TRUE))'). Default: '(objectClass=*)'. For: search.",
        },
        attributes: {
          type: "array",
          items: { type: "string" },
          description: "Attribute names to return (empty = all). E.g. ['cn', 'mail', 'uid']. For: search.",
        },
        size_limit: {
          type: "number",
          description: "Maximum number of entries to return (0 = server default). For: search.",
        },
        time_limit: {
          type: "number",
          description: "Server-side time limit in seconds (0 = no limit). For: search.",
        },
        types_only: {
          type: "boolean",
          description: "Return attribute types only, not values (default: false). For: search.",
        },
        dn: {
          type: "string",
          description: "Target entry DN for add/modify/delete/compare operations.",
        },
        entry_attributes: {
          type: "object",
          description: "Attributes to set on the new entry. Keys are attribute names; values are strings or arrays of strings. For: add.",
          additionalProperties: {
            oneOf: [
              { type: "string" },
              { type: "array", items: { type: "string" } },
            ],
          },
        },
        modifications: {
          type: "array",
          description: "List of attribute modifications to apply. For: modify.",
          items: {
            type: "object",
            required: ["operation", "attribute"],
            properties: {
              operation: {
                type: "string",
                enum: ["add", "delete", "replace"],
                description: "Modify operation: add (add values), delete (remove values), replace (set values).",
              },
              attribute: {
                type: "string",
                description: "LDAP attribute type name (e.g. 'mail', 'sn').",
              },
              values: {
                oneOf: [
                  { type: "string" },
                  { type: "array", items: { type: "string" } },
                ],
                description: "Attribute values to add/replace (omit or empty array for delete-all). For: modify.",
              },
            },
          },
        },
        attribute: {
          type: "string",
          description: "Attribute type name to compare. For: compare.",
        },
        value: {
          type: ["string", "number", "boolean"],
          description: "Value to compare against the directory entry's attribute value. For: compare.",
        },
      },
    },
  },
];

module.exports = { UTIL_SCHEMAS_30 };
