"use strict";
/**
 * Schema for consul_client tool (v4.240.0)
 */

const consulClientSchema = {
  name: "consul_client",
  description:
    "Zero-dependency HashiCorp Consul HTTP API client (pure Node.js http/https; no npm deps). " +
    "Consul HTTP API v1 — default port 8500. " +
    "Operations: kv_get (read one key or recurse/list under prefix), " +
    "kv_put (write key+value with optional flags/CAS/acquire/release), " +
    "kv_delete (delete key or recurse under prefix), " +
    "kv_list (list keys under prefix, names only), " +
    "services (list all registered services in catalog), " +
    "service_health (health checks for a named service, optional passing filter), " +
    "nodes (list all nodes in datacenter), " +
    "node_health (health checks for a specific node), " +
    "members (gossip members, WAN or LAN), " +
    "leader (current Raft leader address), " +
    "peers (Raft peers list), " +
    "status (agent self info: node name, datacenter, version, raft state), " +
    "register (register a service on the local agent with optional health check), " +
    "deregister (deregister a service by service_id), " +
    "checks (list all health checks known to the agent), " +
    "session_create (create a session for distributed locking), " +
    "session_destroy (destroy a session by ID), " +
    "session_info (get session info by ID), " +
    "lock (acquire distributed lock on KV key using session), " +
    "unlock (release distributed lock on KV key using session), " +
    "catalog_datacenters (list all known datacenters), " +
    "info (protocol/operation reference, no I/O). " +
    "Auth: ACL token via X-Consul-Token header. " +
    "Supports TLS (use_tls:true), datacenter selection, Consul namespaces. " +
    "KV values base64-decoded to UTF-8 strings automatically. " +
    "Security: NUL-byte guards, 16 MB response cap, timeout 1000-120000 ms. " +
    "Always available — does not require MCP_ALLOW_EXEC.",
  inputSchema: {
    type: "object",
    required: ["operation", "host"],
    properties: {
      operation: {
        type: "string",
        enum: [
          "kv_get", "kv_put", "kv_delete", "kv_list",
          "services", "service_health", "nodes", "node_health",
          "members", "leader", "peers", "status",
          "register", "deregister", "checks",
          "session_create", "session_destroy", "session_info",
          "lock", "unlock",
          "catalog_datacenters", "info",
        ],
        description:
          "Operation to perform. " +
          "kv_get=read key(s); kv_put=write key; kv_delete=delete key(s); kv_list=list keys under prefix; " +
          "services=list services; service_health=health checks for service; " +
          "nodes=list nodes; node_health=health checks for node; " +
          "members=gossip members; leader=raft leader; peers=raft peers; status=agent self info; " +
          "register=register service; deregister=deregister service; checks=list health checks; " +
          "session_create=create session; session_destroy=destroy session; session_info=get session info; " +
          "lock=acquire KV lock; unlock=release KV lock; " +
          "catalog_datacenters=list datacenters; info=protocol reference (no I/O).",
      },
      host: {
        type: "string",
        description: "Consul server hostname or IP address (e.g. 'localhost' or '10.0.0.1').",
      },
      port: {
        type: "number",
        description: "Consul HTTP API port (default: 8500; HTTPS default: 8501).",
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
        description: "Request timeout in milliseconds (1000-120000, default 10000).",
      },
      token: {
        type: "string",
        description: "Consul ACL token for authentication (X-Consul-Token header). Never returned in output.",
      },
      datacenter: {
        type: "string",
        description: "Target datacenter for the request (default: agent's datacenter).",
      },
      namespace: {
        type: "string",
        description: "Consul namespace (Consul Enterprise only). Omit for open-source Consul.",
      },
      // KV params
      key: {
        type: "string",
        description:
          "KV key path (required for kv_get, kv_put, kv_delete, lock, unlock). " +
          "Use forward slashes for hierarchy (e.g. 'config/app/db_url').",
      },
      prefix: {
        type: "string",
        description: "Key prefix for kv_list. Lists all keys starting with this prefix.",
      },
      value: {
        type: "string",
        description: "Value to store (UTF-8 string). Used by kv_put and lock.",
      },
      recurse: {
        type: "boolean",
        description: "Recursively read/delete all keys under the key prefix (kv_get, kv_delete). Default: false.",
      },
      raw: {
        type: "boolean",
        description: "Return raw value bytes without JSON envelope (kv_get). Default: false.",
      },
      keys: {
        type: "boolean",
        description: "Return only key names (no values) for kv_get with a prefix. Default: false.",
      },
      separator: {
        type: "string",
        description: "Separator for kv_get keys mode and kv_list to list keys up to a delimiter (e.g. '/').",
      },
      flags: {
        type: "number",
        description: "Arbitrary 64-bit unsigned integer flags to store with a KV entry (kv_put, lock). Default: 0.",
      },
      cas: {
        type: "number",
        description:
          "Check-and-set index for optimistic concurrency (kv_put, kv_delete). " +
          "Set to 0 to only create if key does not exist; use ModifyIndex to update atomically.",
      },
      // Blocking query params
      index: {
        type: "number",
        description:
          "Blocking query: last known X-Consul-Index value (kv_get). " +
          "Request will block until the index changes or 'wait' expires.",
      },
      wait: {
        type: "string",
        description: "Blocking query max wait time (e.g. '30s', '5m'). Used with 'index' (kv_get).",
      },
      // Service params
      service: {
        type: "string",
        description: "Service name for service_health. Must match a registered service name.",
      },
      tag: {
        type: "string",
        description: "Filter service_health results to nodes running instances with this tag.",
      },
      passing: {
        type: "boolean",
        description: "Filter service_health to only return healthy (passing) instances. Default: false.",
      },
      near: {
        type: "string",
        description: "Sort nodes/services by network latency relative to this node (service_health, nodes).",
      },
      filter: {
        type: "string",
        description:
          "Consul API filter expression (services, service_health, nodes, node_health, checks). " +
          "Uses Consul's filtering syntax: https://developer.hashicorp.com/consul/api-docs/features/filtering",
      },
      node_meta: {
        type: "string",
        description: "Filter services/nodes by node metadata key:value pair (e.g. 'env:prod').",
      },
      // Members params
      wan: {
        type: "boolean",
        description: "Return WAN gossip members instead of LAN (members). Default: false.",
      },
      segment: {
        type: "string",
        description: "Return members in a specific network segment (members).",
      },
      // Node params
      node: {
        type: "string",
        description: "Node name for node_health. Must match a node registered in the catalog.",
      },
      // Registration params
      service_id: {
        type: "string",
        description:
          "Unique service ID for register (defaults to service name) and deregister (required). " +
          "Allows multiple instances of the same service on one agent.",
      },
      address: {
        type: "string",
        description: "Service IP address override for register (default: agent's address).",
      },
      service_port: {
        type: "number",
        description: "Service port for register (the port the registered service listens on, distinct from the Consul API port).",
      },
      tags: {
        type: "array",
        items: { type: "string" },
        description: "Tags to attach to the registered service (register).",
      },
      meta: {
        type: "object",
        additionalProperties: { type: "string" },
        description: "Key/value metadata map for the registered service (register).",
      },
      check: {
        type: "object",
        description:
          "Health check definition for the registered service (register). " +
          "Supported fields: http (URL), tcp (host:port), interval (e.g. '10s'), " +
          "timeout (e.g. '3s'), tls_skip_verify, deregister_after.",
        properties: {
          http:             { type: "string" },
          tcp:              { type: "string" },
          interval:         { type: "string" },
          timeout:          { type: "string" },
          tls_skip_verify:  { type: "boolean" },
          deregister_after: { type: "string" },
        },
      },
      // Session params
      session_id: {
        type: "string",
        description: "Session ID for session_destroy, session_info, lock, and unlock operations.",
      },
      session_name: {
        type: "string",
        description: "Human-readable name for the session (session_create, default: 'mcp-session').",
      },
      ttl: {
        type: "string",
        description:
          "Session TTL (session_create, e.g. '30s', '5m'). " +
          "Session expires if not renewed within this interval. Min: 10s, Max: 86400s.",
      },
      behavior: {
        type: "string",
        enum: ["release", "delete"],
        description:
          "Session invalidation behavior (session_create). " +
          "'release' (default) releases locks held by the session. " +
          "'delete' deletes all KV entries locked by this session.",
      },
      lock_delay: {
        type: "string",
        description:
          "Lock delay period after session expiry (session_create, e.g. '15s'). " +
          "Prevents another session from re-acquiring the lock for this duration.",
      },
      checks: {
        type: "array",
        items: { type: "string" },
        description: "Health check IDs to associate with the session (session_create). Default: ['serfHealth'].",
      },
      acquire: {
        type: "string",
        description: "Session ID to acquire the lock on a KV key (kv_put ?acquire). Prefer using the 'lock' operation.",
      },
      release: {
        type: "string",
        description: "Session ID to release the lock on a KV key (kv_put ?release). Prefer using the 'unlock' operation.",
      },
    },
  },
};

module.exports = { consulClientSchema };
