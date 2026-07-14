"use strict";
/**
 * Schema for etcd_client tool (v4.239.0)
 */

const etcdClientSchema = {
  name: "etcd_client",
  description:
    "Zero-dependency etcd v3 client (pure Node.js http/https; no npm deps). " +
    "Uses the etcd v3 gRPC-gateway REST API (HTTP/1.1 + JSON, default port 2379). " +
    "Keys and values are transparently base64-encoded on the wire. " +
    "Operations: get (read one key, range, or prefix scan), " +
    "put (write a key with optional TTL lease), " +
    "delete (remove a key, range, or prefix), " +
    "list (enumerate keys under a prefix), " +
    "watch (short-poll a key/prefix for changes), " +
    "grant_lease (create a TTL lease for ephemeral keys), " +
    "revoke_lease (cancel a lease and remove all attached keys), " +
    "keepalive (refresh a lease TTL), " +
    "lock (acquire a distributed mutex), unlock (release a mutex), " +
    "status (member status: version/db-size/raft index), " +
    "members (list cluster members), compact (trim revision history), " +
    "txn (compare-and-swap mini-transaction), " +
    "auth_enable / auth_disable, info (protocol reference). " +
    "Supports TLS (use_tls:true) and etcd token auth (username+password). " +
    "Compatible with etcd 3.3+ (v3 API). " +
    "Security: NUL-byte guards on host/key/value, 32 MB response cap, " +
    "timeout clamped 1000-120000 ms. Always available — does not require MCP_ALLOW_EXEC.",
  inputSchema: {
    type: "object",
    required: ["operation", "host"],
    properties: {
      operation: {
        type: "string",
        enum: [
          "get", "put", "delete", "list", "watch",
          "grant_lease", "revoke_lease", "keepalive",
          "lock", "unlock",
          "status", "members", "compact", "txn",
          "auth_enable", "auth_disable", "info"
        ],
        description:
          "Operation to perform. " +
          "get=read key(s); put=write key; delete=remove key(s); " +
          "list=enumerate keys under prefix; watch=short-poll for changes; " +
          "grant_lease=create TTL lease; revoke_lease=cancel lease; keepalive=refresh lease; " +
          "lock=acquire distributed mutex; unlock=release mutex; " +
          "status=member status; members=cluster members; compact=trim history; " +
          "txn=compare-and-swap transaction; " +
          "auth_enable=enable auth; auth_disable=disable auth; " +
          "info=return protocol reference (no I/O).",
      },
      host: {
        type: "string",
        description: "etcd server hostname or IP address (e.g. 'localhost' or '10.0.0.1').",
      },
      port: {
        type: "number",
        description: "etcd client port (default: 2379).",
      },
      use_tls: {
        type: "boolean",
        description: "Connect using HTTPS/TLS (default: false).",
      },
      reject_unauthorized: {
        type: "boolean",
        description:
          "Reject self-signed or untrusted TLS certificates (default: true). " +
          "Set false for self-signed certificates in test environments.",
      },
      timeout: {
        type: "number",
        description: "Request timeout in milliseconds (1000–120000, default 10000).",
      },
      username: {
        type: "string",
        description: "etcd username for token authentication (optional).",
      },
      password: {
        type: "string",
        description: "etcd password for token authentication (optional; never returned in output).",
      },
      key: {
        type: "string",
        description:
          "Key to read/write/delete (required for get, put, delete unless prefix is used, watch, unlock). " +
          "For get/delete, either key or prefix must be supplied.",
      },
      value: {
        type: "string",
        description: "Value to store (UTF-8 string, used by put). Defaults to empty string.",
      },
      prefix: {
        type: "string",
        description:
          "Key prefix for range operations (get, delete, list, watch). " +
          "All keys with this prefix are matched. Takes precedence over key for range ops.",
      },
      range_end: {
        type: "string",
        description:
          "Explicit range end key (exclusive). Combined with key to form a half-open interval [key, range_end). " +
          "Overridden by prefix if both are set.",
      },
      limit: {
        type: "number",
        description: "Maximum number of keys to return (1–100000, default 100 for get, 1000 for list).",
      },
      revision: {
        type: "number",
        description: "Read keys at a specific revision (get). Compact up to this revision (compact).",
      },
      keys_only: {
        type: "boolean",
        description: "Return only keys without values (get). Default: false.",
      },
      sort_target: {
        type: "string",
        enum: ["KEY", "VERSION", "CREATE", "MOD", "VALUE"],
        description: "Sort field for get/list results.",
      },
      sort_order: {
        type: "string",
        enum: ["NONE", "ASCEND", "DESCEND"],
        description: "Sort order for get/list results.",
      },
      prev_kv: {
        type: "boolean",
        description: "Return the previous key-value pair before put/delete (put, delete). Default: false.",
      },
      lease: {
        type: "string",
        description: "Lease ID (string) to attach to a put. Keys expire when the lease expires.",
      },
      ignore_value: {
        type: "boolean",
        description: "Do not update the value on put (only refresh the lease). Default: false.",
      },
      ignore_lease: {
        type: "boolean",
        description: "Do not attach or remove a lease on put (keep existing lease). Default: false.",
      },
      ttl: {
        type: "number",
        description: "TTL in seconds for grant_lease (1–86400, default 30).",
      },
      id: {
        type: "string",
        description: "Requested lease ID for grant_lease. Pass 0 or omit to let etcd auto-assign.",
      },
      lease_id: {
        type: "string",
        description: "Lease ID for revoke_lease, keepalive, and lock operations.",
      },
      name: {
        type: "string",
        description: "Mutex name for lock/unlock operations.",
      },
      physical: {
        type: "boolean",
        description: "Wait for physical disk compaction to finish (compact). Default: false.",
      },
      duration_ms: {
        type: "number",
        description: "How long to collect watch events in milliseconds (100–30000, default 2000).",
      },
      start_revision: {
        type: "number",
        description: "Start watching from this revision (watch). Default: latest.",
      },
      one_event: {
        type: "boolean",
        description: "Stop watching after the first event is received (watch). Default: false.",
      },
      filters: {
        type: "array",
        items: { type: "string", enum: ["NOPUT", "NODELETE"] },
        description: "Event filters for watch: NOPUT (skip put events), NODELETE (skip delete events).",
      },
      include_values: {
        type: "boolean",
        description: "Include values in list results (default: false, keys only).",
      },
      compare: {
        type: "array",
        description:
          "Compare conditions for txn. Each item: { key, target (VERSION|CREATE|MOD|VALUE), " +
          "result (EQUAL|GREATER|LESS|NOT_EQUAL), value? (for VALUE target), " +
          "version?, create_revision?, mod_revision? }.",
        items: { type: "object" },
      },
      success: {
        type: "array",
        description:
          "Operations to run if all compare conditions pass (txn). " +
          "Each item: { request_put?, request_delete_range?, request_range? }.",
        items: { type: "object" },
      },
      failure: {
        type: "array",
        description:
          "Operations to run if any compare condition fails (txn). " +
          "Each item: { request_put?, request_delete_range?, request_range? }.",
        items: { type: "object" },
      },
    },
  },
};

module.exports = { etcdClientSchema };
