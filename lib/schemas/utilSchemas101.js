"use strict";
/**
 * Schema for vault_client tool (v4.241.0)
 */

const vaultClientSchema = {
  name: "vault_client",
  description:
    "Zero-dependency HashiCorp Vault HTTP API client (pure Node.js http/https; no npm deps). " +
    "Vault HTTP API v1 — default port 8200. " +
    "Operations: " +
    "kv_get (read a secret from KV v1 or KV v2; supports versioning in v2), " +
    "kv_put (write a secret to KV v1 or KV v2; wraps data in {data:{}} for v2), " +
    "kv_delete (soft-delete latest or specific versions of a KV v2 secret; DELETE for v1), " +
    "kv_list (list secret keys under a path; works for both KV v1 and v2), " +
    "kv_metadata (read KV v2 secret metadata: versions, timestamps, cas_required, custom_metadata), " +
    "kv_destroy (permanently destroy specific versions of a KV v2 secret), " +
    "token_lookup (look up current or a specified token's properties and TTL), " +
    "token_renew (renew a token's TTL, optionally with increment), " +
    "token_revoke (revoke the current or a specified token), " +
    "auth_userpass (authenticate with username+password auth method), " +
    "auth_approle (authenticate with AppRole role_id + optional secret_id), " +
    "auth_token (validate current token via lookup-self), " +
    "pki_issue (issue a TLS certificate from a PKI secrets engine role), " +
    "pki_sign (sign a CSR using a PKI role), " +
    "transit_encrypt (encrypt plaintext using Transit secrets engine key), " +
    "transit_decrypt (decrypt ciphertext using Transit secrets engine key), " +
    "transit_sign (sign data using Transit secrets engine signing key), " +
    "transit_verify (verify a Transit signature), " +
    "sys_health (get Vault cluster health status, no auth required), " +
    "sys_seal_status (get Vault seal status, no auth required), " +
    "sys_mounts (list all mounted secrets engines), " +
    "sys_policies (list all ACL policies), " +
    "sys_capabilities (check token capabilities on given paths), " +
    "unwrap (unwrap a wrapped response token), " +
    "info (protocol/operation reference, no I/O). " +
    "Auth: Vault token via X-Vault-Token header. " +
    "Supports TLS (use_tls:true), Vault Enterprise namespaces, KV v1 and v2. " +
    "Tokens/passwords never returned in output. " +
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
          "kv_metadata", "kv_destroy",
          "token_lookup", "token_renew", "token_revoke",
          "auth_userpass", "auth_approle", "auth_token",
          "pki_issue", "pki_sign",
          "transit_encrypt", "transit_decrypt",
          "transit_sign", "transit_verify",
          "sys_health", "sys_seal_status", "sys_mounts",
          "sys_policies", "sys_capabilities",
          "unwrap", "info",
        ],
        description:
          "Operation to perform. " +
          "kv_get/kv_put/kv_delete/kv_list=KV secrets CRUD (v1/v2); " +
          "kv_metadata=KV v2 metadata; kv_destroy=permanent version destroy; " +
          "token_lookup/renew/revoke=token lifecycle; " +
          "auth_userpass/approle/token=authentication; " +
          "pki_issue/sign=certificate issuance; " +
          "transit_encrypt/decrypt/sign/verify=encryption-as-a-service; " +
          "sys_health/seal_status/mounts/policies/capabilities=system info; " +
          "unwrap=unwrap response token; info=reference (no I/O).",
      },
      host: {
        type: "string",
        description: "Vault server hostname or IP address (e.g. 'localhost' or '10.0.0.1').",
      },
      port: {
        type: "number",
        description: "Vault HTTP API port (default: 8200).",
      },
      use_tls: {
        type: "boolean",
        description: "Connect using HTTPS/TLS (default: false).",
      },
      reject_unauthorized: {
        type: "boolean",
        description:
          "Reject self-signed or untrusted TLS certificates (default: true). " +
          "Set false for self-signed certificates in test/dev environments.",
      },
      timeout: {
        type: "number",
        description: "Request timeout in milliseconds (1000-120000, default 10000).",
      },
      token: {
        type: "string",
        description:
          "Vault token for authentication (X-Vault-Token header). " +
          "Required for most operations except sys_health, sys_seal_status, and info. " +
          "Never returned in output or error messages.",
      },
      namespace: {
        type: "string",
        description:
          "Vault Enterprise namespace (X-Vault-Namespace header). " +
          "Omit for open-source Vault or the root namespace.",
      },
      // ── KV params ──────────────────────────────────────────────────────
      path: {
        type: "string",
        description:
          "Secret path within the mount (required for kv_get/put/delete/list/metadata/destroy). " +
          "Do not include the mount name — that is supplied via 'mount'. " +
          "Example: 'myapp/db' for a secret at 'secret/myapp/db'.",
      },
      mount: {
        type: "string",
        description:
          "KV secrets engine mount path (default: 'secret'). " +
          "This is the mount name configured in Vault (e.g. 'kv', 'secret', 'apps').",
      },
      kv_version: {
        type: "number",
        enum: [1, 2],
        description:
          "KV secrets engine version: 1 (legacy) or 2 (default, supports versioning). " +
          "KV v2 secrets are wrapped in {data:{}} and stored at /data/ path internally. " +
          "Must match the mount's configured version.",
      },
      data: {
        type: "object",
        description:
          "Secret key/value pairs to write (required for kv_put). " +
          "Values must be strings or JSON-serialisable primitives. " +
          "Example: { username: 'admin', password: 'secret' }.",
      },
      version: {
        type: "number",
        description:
          "Secret version to read (kv_get with kv_version=2). " +
          "Omit to read the latest version.",
      },
      versions: {
        type: "array",
        items: { type: "number" },
        description:
          "List of version numbers to delete (kv_delete with kv_version=2) or destroy (kv_destroy). " +
          "For kv_delete without versions, the latest version is soft-deleted. " +
          "For kv_destroy, versions are permanently removed and cannot be recovered.",
      },
      options: {
        type: "object",
        description:
          "KV v2 write options (kv_put). Supported keys: " +
          "cas (number, check-and-set: 0 to only create if not exists, or current version number to update atomically).",
        properties: {
          cas: { type: "number", description: "Check-and-set version — 0 to create only if absent, or current version to update atomically." },
        },
      },
      // ── Token params ────────────────────────────────────────────────────
      lookup_token: {
        type: "string",
        description:
          "Token to look up (token_lookup). Omit to look up the token configured in 'token'. " +
          "Requires sudo or manage capability on auth/token/lookup.",
      },
      renew_token: {
        type: "string",
        description:
          "Token to renew (token_renew). Omit to renew the token in 'token'. " +
          "Requires sudo or manage capability on auth/token/renew.",
      },
      increment: {
        type: "string",
        description:
          "Renewal duration increment (token_renew), e.g. '1h', '30m'. " +
          "Vault may cap this to the token's max_ttl.",
      },
      revoke_token: {
        type: "string",
        description:
          "Token to revoke (token_revoke). Omit to revoke the token in 'token' (self-revoke). " +
          "Requires sudo or manage capability on auth/token/revoke.",
      },
      // ── Auth params ─────────────────────────────────────────────────────
      username: {
        type: "string",
        description: "Username for auth_userpass authentication.",
      },
      password: {
        type: "string",
        description:
          "Password for auth_userpass authentication. Never returned in output or errors.",
      },
      role_id: {
        type: "string",
        description: "AppRole RoleID for auth_approle authentication.",
      },
      secret_id: {
        type: "string",
        description:
          "AppRole SecretID for auth_approle authentication. " +
          "Optional if the AppRole is configured with bind_secret_id=false.",
      },
      // ── PKI params ───────────────────────────────────────────────────────
      role: {
        type: "string",
        description:
          "PKI role name for pki_issue and pki_sign. " +
          "Determines allowed domains, key type, TTL, and other certificate constraints.",
      },
      common_name: {
        type: "string",
        description: "Certificate common name (CN) for pki_issue and pki_sign.",
      },
      alt_names: {
        type: "string",
        description:
          "Comma-separated list of DNS SANs for pki_issue and pki_sign " +
          "(e.g. 'api.example.com,www.example.com').",
      },
      ip_sans: {
        type: "string",
        description: "Comma-separated list of IP SANs for pki_issue and pki_sign (e.g. '127.0.0.1,10.0.0.1').",
      },
      uri_sans: {
        type: "string",
        description: "Comma-separated list of URI SANs for pki_issue (e.g. 'spiffe://example.com/myservice').",
      },
      ttl: {
        type: "string",
        description:
          "Certificate or lease TTL for pki_issue, pki_sign (e.g. '24h', '30m'). " +
          "Vault may cap this to the role's max_ttl.",
      },
      format: {
        type: "string",
        enum: ["pem", "der", "pem_bundle"],
        description: "Certificate output format for pki_issue and pki_sign (default: pem).",
      },
      private_key_format: {
        type: "string",
        enum: ["der", "pkcs8"],
        description: "Private key format for pki_issue (default: der — PEM-encoded DER).",
      },
      csr: {
        type: "string",
        description: "PEM-encoded Certificate Signing Request for pki_sign.",
      },
      // ── Transit params ──────────────────────────────────────────────────
      key: {
        type: "string",
        description:
          "Transit key name for transit_encrypt, transit_decrypt, transit_sign, transit_verify. " +
          "Must be a key that already exists in the Transit secrets engine.",
      },
      plaintext: {
        type: "string",
        description:
          "Plaintext string to encrypt (transit_encrypt). " +
          "Automatically base64-encoded before sending to Vault.",
      },
      ciphertext: {
        type: "string",
        description:
          "Ciphertext string to decrypt (transit_decrypt). " +
          "Must be a 'vault:v1:...' ciphertext produced by transit_encrypt.",
      },
      input: {
        type: "string",
        description:
          "Input data to sign or verify (transit_sign, transit_verify). " +
          "Automatically base64-encoded before sending to Vault.",
      },
      signature: {
        type: "string",
        description: "Signature to verify (transit_verify). Produced by transit_sign.",
      },
      context: {
        type: "string",
        description:
          "Convergent encryption/signing context (transit_encrypt, transit_decrypt, transit_sign, transit_verify). " +
          "Base64-encoded context for derived keys or convergent encryption.",
      },
      nonce: {
        type: "string",
        description:
          "Nonce for convergent encryption (transit_encrypt, transit_decrypt). " +
          "Required with convergent_encryption=true; must be the same for encrypt/decrypt.",
      },
      key_version: {
        type: "number",
        description: "Key version to use for encryption or signing (transit_encrypt, transit_sign). Default: current version.",
      },
      hash_algorithm: {
        type: "string",
        description:
          "Hash algorithm for transit_sign and transit_verify " +
          "(e.g. 'sha2-256', 'sha2-384', 'sha2-512'). Default depends on key type.",
      },
      signature_algorithm: {
        type: "string",
        description:
          "Signature algorithm for RSA keys (transit_sign, transit_verify): " +
          "'pss' (RSA-PSS) or 'pkcs1v15' (RSASSA-PKCS1-v1_5). Default: pss.",
      },
      prehashed: {
        type: "boolean",
        description:
          "Whether 'input' is pre-hashed (transit_sign, transit_verify). " +
          "If true, input must already be the hash (base64-encoded). Default: false.",
      },
      convergent_encryption: {
        type: "boolean",
        description:
          "Enable convergent encryption (transit_encrypt). " +
          "Requires the key to have convergent_encryption=true. Default: false.",
      },
      // ── Sys params ──────────────────────────────────────────────────────
      paths: {
        type: "array",
        items: { type: "string" },
        description:
          "Paths to check capabilities for (sys_capabilities, required). " +
          "Returns the token's capabilities (create/read/update/delete/list/sudo) for each path.",
      },
      // ── Unwrap ──────────────────────────────────────────────────────────
      wrap_token: {
        type: "string",
        description:
          "Wrapping token to unwrap (unwrap). " +
          "Single-use token that wraps a response from a Vault operation.",
      },
    },
  },
};

module.exports = { vaultClientSchema };
