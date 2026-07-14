"use strict";
/**
 * Schema for zookeeper_client tool (v4.238.0)
 */

const zookeeperClientSchema = {
  name: "zookeeper_client",
  description:
    "Zero-dependency Apache ZooKeeper client (pure Node.js net/tls; no npm deps). " +
    "Implements the ZooKeeper binary protocol (Jute serialization over TCP/TLS). " +
    "Operations: connect (session info/ping), get (read znode data+Stat), " +
    "set (write znode data, versioned), create (new znode with flags+ACL), " +
    "delete (remove znode, versioned), exists (check znode existence), " +
    "get_children (list child names), get_acl (read ACL+Stat), info (protocol reference). " +
    "Supports persistent/ephemeral/sequential znode flags, world+auth+digest ACL schemes, " +
    "and TLS (ZooKeeper 3.5+ secureClientPort). " +
    "Compatible with ZooKeeper 3.4+ (protocol version 0). " +
    "Default port: 2181 (plain TCP) or 2281 (TLS). " +
    "Security: NUL-byte guards on host/path, 1 MB data cap, 512-char path limit, " +
    "timeout clamped 1000–120000ms. Always available — does not require MCP_ALLOW_EXEC.",
  inputSchema: {
    type: "object",
    required: ["operation", "host"],
    properties: {
      operation: {
        type: "string",
        enum: ["connect", "get", "set", "create", "delete", "exists", "get_children", "get_acl", "info"],
        description:
          "Operation to perform. " +
          "connect=open session and return sessionId/negotiatedTimeout; " +
          "get=read data bytes and Stat from a znode; " +
          "set=write data to an existing znode; " +
          "create=create a new znode with data, ACL, and flags; " +
          "delete=remove a znode; " +
          "exists=check whether a znode exists (returns Stat or null); " +
          "get_children=list immediate child names; " +
          "get_acl=retrieve ACL list and Stat; " +
          "info=return protocol/config reference (no I/O).",
      },
      host: {
        type: "string",
        description: "ZooKeeper server hostname or IP address.",
      },
      port: {
        type: "number",
        description: "ZooKeeper client port (default: 2181 for plain TCP, 2281 for TLS).",
      },
      use_tls: {
        type: "boolean",
        description:
          "Connect using TLS (ZooKeeper 3.5+ secureClientPort, default port 2281). Default: false.",
      },
      reject_unauthorized: {
        type: "boolean",
        description:
          "Reject self-signed or untrusted TLS certificates (default: true). " +
          "Set false for self-signed server certificates in test environments.",
      },
      timeout: {
        type: "number",
        description: "Per-operation timeout in milliseconds (1000–120000, default 15000).",
      },
      connect_timeout: {
        type: "number",
        description: "TCP/TLS connect timeout in milliseconds (1000–60000, default 10000).",
      },
      session_timeout: {
        type: "number",
        description:
          "ZooKeeper session timeout requested from the server in milliseconds " +
          "(2000–120000, default 30000). The server may negotiate a different value.",
      },
      path: {
        type: "string",
        description:
          "ZooKeeper znode path (required for get, set, create, delete, exists, get_children, get_acl). " +
          "Must start with '/' and be at most 512 characters.",
      },
      data: {
        type: "string",
        description:
          "Data to store in the znode (UTF-8 string, max 1 MB). " +
          "Used by set and create. Pass null or omit for empty data.",
      },
      version: {
        type: "number",
        description:
          "Expected znode version for optimistic concurrency control (used by set and delete). " +
          "Pass -1 to skip version check (update any version). Default: -1.",
      },
      flags: {
        type: "number",
        enum: [0, 1, 2, 3],
        description:
          "Znode creation flags (used by create). " +
          "0=PERSISTENT (default), 1=EPHEMERAL (auto-deleted on session close), " +
          "2=PERSISTENT_SEQUENTIAL (ZK appends counter to path), " +
          "3=EPHEMERAL_SEQUENTIAL.",
      },
      acl: {
        type: "array",
        description:
          "ACL list for znode creation (used by create). Default: OPEN_ACL_UNSAFE (world:anyone, all perms=31). " +
          "Each entry: { perms (1=READ,2=WRITE,4=CREATE,8=DELETE,16=ADMIN,31=ALL), scheme, id }. " +
          "Common schemes: 'world' (id='anyone'), 'auth', 'digest' (id='user:SHA1hash'), 'ip'.",
        items: {
          type: "object",
          properties: {
            perms:  { type: "number",  description: "Permission bitmask (1=READ,2=WRITE,4=CREATE,8=DELETE,16=ADMIN,31=ALL)." },
            scheme: { type: "string",  description: "ACL scheme: 'world', 'auth', 'digest', 'ip', 'x509'." },
            id:     { type: "string",  description: "Scheme-specific ID (e.g. 'anyone' for world, 'user:hash' for digest)." },
          },
        },
      },
    },
  },
};

module.exports = { zookeeperClientSchema };
