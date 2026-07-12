"use strict";
// ── UTILITY TOOL SCHEMAS — part 25 ────────────────────────────────────────────────
// Added: redis_client (v4.164.0).

const UTIL_SCHEMAS_25 = [
  {
    name: "redis_client",
    description:
      "Zero-dependency Redis client — pure Node.js net/tls, RESP2 protocol.\n\n" +
      "Supports all common Redis data types and operations:\n" +
      "  • Server:  ping, info, dbsize, select, flushdb\n" +
      "  • Strings: get, set (EX/PX/NX/XX/GET), del, exists, expire, pexpire, ttl, pttl,\n" +
      "             persist, keys, type, rename, incr, decr, incrby, decrby, incrbyfloat,\n" +
      "             append_str, getrange, setrange, mget, mset\n" +
      "  • Hashes:  hget, hset, hmget, hmset, hdel, hgetall, hkeys, hvals, hlen, hexists\n" +
      "  • Lists:   lpush, rpush, lpop, rpop, llen, lrange, lindex, lset, ltrim\n" +
      "  • Sets:    sadd, smembers, srem, sismember, scard, sinter, sunion, sdiff\n" +
      "  • ZSets:   zadd, zrange, zrangebyscore, zrank, zscore, zrem, zcard, zincrby\n" +
      "  • Pub/Sub: publish (fire-and-forget; no subscribe loop)\n" +
      "  • Pipeline: send up to 500 raw Redis commands in a single round-trip\n\n" +
      "Connection options:\n" +
      "  host, port (default 6379), tls (boolean), password, username (ACL), db, timeout\n\n" +
      "Returns { host, port, operation, elapsedMs, ...operation-specific fields }.\n" +
      "Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: {
      type: "object",
      required: ["host", "operation"],
      properties: {
        // ── Connection ─────────────────────────────────────────────────
        host: {
          type: "string",
          description: "Redis server hostname or IP address (e.g. 'localhost', '127.0.0.1', 'redis.example.com').",
        },
        port: {
          type: "number",
          description: "Redis port (default: 6379).",
        },
        tls: {
          type: "boolean",
          description: "Use TLS/SSL for the connection (e.g. Redis Cloud, ElastiCache with TLS). Default: false.",
        },
        reject_unauthorized: {
          type: "boolean",
          description: "Reject self-signed or untrusted TLS certificates (default: true). Set false for dev/self-signed certs.",
        },
        password: {
          type: "string",
          description: "Redis AUTH password. For ACL auth, also set 'username'. Never returned in results.",
        },
        username: {
          type: "string",
          description: "Redis ACL username (Redis 6+). Used with 'password' for 'AUTH username password'.",
        },
        db: {
          type: "number",
          description: "Redis database index to SELECT after connecting (default: 0).",
        },
        timeout: {
          type: "number",
          description: "Total operation wall-clock timeout in seconds (default: 30). Includes connection + command time.",
        },
        connect_timeout: {
          type: "number",
          description: "TCP connection timeout in seconds (default: min(timeout, 10)).",
        },
        // ── Operation ────────────────────────────────────────────────
        operation: {
          type: "string",
          enum: [
            "ping", "info", "dbsize", "select", "flushdb",
            "get", "set", "del", "exists", "expire", "pexpire", "ttl", "pttl",
            "keys", "type", "rename", "persist",
            "incr", "decr", "incrby", "decrby", "incrbyfloat",
            "append_str", "getrange", "setrange",
            "mget", "mset",
            "hget", "hset", "hmget", "hmset", "hdel",
            "hgetall", "hkeys", "hvals", "hlen", "hexists",
            "lpush", "rpush", "lpop", "rpop", "llen", "lrange",
            "lindex", "lset", "ltrim",
            "sadd", "smembers", "srem", "sismember", "scard",
            "sinter", "sunion", "sdiff",
            "zadd", "zrange", "zrangebyscore", "zrank", "zscore",
            "zrem", "zcard", "zincrby",
            "publish", "pipeline",
          ],
          description:
            "Redis operation to perform. See tool description for per-operation field requirements.\n" +
            "  Server:  ping, info, dbsize, select, flushdb\n" +
            "  Strings: get, set, del, exists, expire, pexpire, ttl, pttl, persist, keys, type,\n" +
            "           rename, incr, decr, incrby, decrby, incrbyfloat, append_str, getrange,\n" +
            "           setrange, mget, mset\n" +
            "  Hashes:  hget, hset, hmget, hmset, hdel, hgetall, hkeys, hvals, hlen, hexists\n" +
            "  Lists:   lpush, rpush, lpop, rpop, llen, lrange, lindex, lset, ltrim\n" +
            "  Sets:    sadd, smembers, srem, sismember, scard, sinter, sunion, sdiff\n" +
            "  ZSets:   zadd, zrange, zrangebyscore, zrank, zscore, zrem, zcard, zincrby\n" +
            "  Pub/Sub: publish\n" +
            "  Batch:   pipeline",
        },
        // ── Key / value ───────────────────────────────────────────────
        key: {
          type: "string",
          description:
            "Redis key name. Required for single-key operations: get, set, del, exists, expire, " +
            "pexpire, ttl, pttl, persist, type, rename, incr, decr, incrby, decrby, incrbyfloat, " +
            "append_str, getrange, setrange, hget, hset, hmget, hmset, hdel, hgetall, hkeys, " +
            "hvals, hlen, hexists, lpush, rpush, lpop, rpop, llen, lrange, lindex, lset, ltrim, " +
            "sadd, smembers, srem, sismember, scard, zadd, zrange, zrangebyscore, zrank, zscore, " +
            "zrem, zcard, zincrby. For 'keys', used as glob pattern (default '*').",
        },
        keys: {
          type: "array",
          items: { type: "string" },
          description:
            "Array of Redis key names. Required for: del (multi-key), exists (multi-key), mget, " +
            "sinter, sunion, sdiff.",
        },
        value: {
          type: "string",
          description:
            "String value to set or use as element/member. Required for: set, append_str, setrange, " +
            "lset; used as default element for: lpush, rpush, sadd, srem, sismember, zadd, " +
            "zrank, zscore, zrem, zincrby.",
        },
        new_key: {
          type: "string",
          description: "Destination key name for 'rename' operation.",
        },
        // ── Hash-specific ─────────────────────────────────────────────
        field: {
          type: "string",
          description: "Hash field name. Required for: hget, hset (single), hexists, hmget (single).",
        },
        fields: {
          type: "array",
          items: { type: "string" },
          description: "Array of hash field names. Used for: hmget (multi), hdel (multi).",
        },
        field_values: {
          type: "object",
          additionalProperties: true,
          description:
            "Mapping of field/member names to values or scores.\n" +
            "  hset/hmset: { fieldName: value, ... }\n" +
            "  mset:       { keyName: value, ... }\n" +
            "  zadd:       { memberName: score, ... }",
        },
        // ── TTL / expiry ──────────────────────────────────────────────
        ex: {
          type: "number",
          description:
            "Expiry in seconds. For 'set': SET EX option. For 'expire': EXPIRE seconds.",
        },
        px: {
          type: "number",
          description: "Expiry in milliseconds. For 'set': SET PX option. For 'pexpire': PEXPIRE milliseconds.",
        },
        nx: {
          type: "boolean",
          description:
            "SET NX (only set if key does not exist). Also applies to ZADD NX. Default: false.",
        },
        xx: {
          type: "boolean",
          description: "SET XX (only set if key exists). Also applies to ZADD XX. Default: false.",
        },
        get_old: {
          type: "boolean",
          description: "For 'set': also return the old value (SET ... GET, Redis 6.2+). Default: false.",
        },
        // ── List-specific ─────────────────────────────────────────────
        elements: {
          type: "array",
          items: { type: "string" },
          description: "Array of elements to push. Used for: lpush, rpush (multi-element push).",
        },
        index: {
          type: "number",
          description: "List index. Used for: lindex, lset.",
        },
        start: {
          type: "number",
          description: "Start index (0-based) or rank for lrange/ltrim/zrange (default: 0). Negative = from end.",
        },
        stop: {
          type: "number",
          description: "Stop index for lrange/ltrim/zrange (default: -1 = last element). Negative = from end.",
        },
        count: {
          type: "number",
          description: "Number of elements to pop for lpop/rpop (Redis 6.2+ supports count argument).",
        },
        // ── Set-specific ──────────────────────────────────────────────
        members: {
          type: "array",
          items: { type: "string" },
          description: "Array of set members. Used for: sadd, srem (multi-member).",
        },
        member: {
          type: "string",
          description: "Single set/sorted-set member. Used for: sismember, zadd, zrank, zscore, zrem, zincrby.",
        },
        // ── Sorted set ───────────────────────────────────────────────
        score: {
          type: "number",
          description: "Score for ZADD (single member). Use 'field_values' for multi-member ZADD.",
        },
        min: {
          type: "string",
          description: "Minimum score for zrangebyscore (default: '-inf'). Supports '(' exclusive prefix.",
        },
        max: {
          type: "string",
          description: "Maximum score for zrangebyscore (default: '+inf'). Supports '(' exclusive prefix.",
        },
        with_scores: {
          type: "boolean",
          description: "For zrange/zrangebyscore: include scores in the result. Default: false.",
        },
        rev: {
          type: "boolean",
          description:
            "For zrangebyscore: use ZREVRANGEBYSCORE (descending). For zrank: use ZREVRANK. Default: false.",
        },
        // ── Numeric ops ───────────────────────────────────────────────
        amount: {
          type: "number",
          description: "Increment/decrement amount for: incrby, decrby (integer), incrbyfloat, zincrby (float).",
        },
        // ── String range ops ──────────────────────────────────────────
        range_start: {
          type: "number",
          description: "Byte offset start for getrange.",
        },
        range_end: {
          type: "number",
          description: "Byte offset end for getrange (-1 = last byte).",
        },
        offset: {
          type: "number",
          description: "Byte offset for setrange, or LIMIT offset for zrangebyscore.",
        },
        limit: {
          type: "number",
          description: "LIMIT count for zrangebyscore LIMIT offset count.",
        },
        // ── Server ops ───────────────────────────────────────────────
        message: {
          type: "string",
          description:
            "For 'ping': optional message to echo back (PING message). " +
            "For 'publish': message payload to publish.",
        },
        channel: {
          type: "string",
          description: "Channel name for 'publish' operation.",
        },
        info_section: {
          type: "string",
          description:
            "INFO section to request (default: all sections). " +
            "Examples: 'server', 'clients', 'memory', 'stats', 'replication', 'cpu', 'keyspace'.",
        },
        select_db: {
          type: "number",
          description: "Database index to select (0–15 typically). Used for 'select' operation.",
        },
        async_flush: {
          type: "boolean",
          description: "For 'flushdb': use FLUSHDB ASYNC (non-blocking). Default: false (synchronous).",
        },
        // ── Pipeline ────────────────────────────────────────────────
        commands: {
          type: "array",
          description:
            "For 'pipeline': array of Redis commands, each as an array of strings. " +
            "Example: [[\"SET\",\"k\",\"v\"], [\"GET\",\"k\"], [\"DEL\",\"k\"]]. Max 500 commands.",
          items: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
          },
        },
      },
    },
  },
];

module.exports = { UTIL_SCHEMAS_25 };
