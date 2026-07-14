"use strict";

const AZURE_CLIENT_SCHEMA = {
  name: "azure_client",
  description: "Zero-dependency Microsoft Azure REST API client — pure Node.js https/http/crypto built-ins; no npm deps. Authenticates via Azure AD / Entra ID OAuth2 Client Credentials (tenant_id + client_id + client_secret) with in-process token caching, or a pre-obtained access_token. Supported services: Blob Storage (list_containers, create_container, delete_container, list_blobs, get_blob, put_blob, delete_blob, head_blob), Key Vault (kv_get_secret, kv_list_secrets, kv_set_secret, kv_delete_secret, kv_get_key, kv_list_keys, kv_encrypt, kv_decrypt), Service Bus (sb_send_message, sb_receive_message, sb_peek_message, sb_delete_message, sb_list_queues), Cosmos DB SQL API (cosmos_list_databases, cosmos_list_collections, cosmos_query_documents, cosmos_get_document, cosmos_upsert_document, cosmos_delete_document), Azure Resource Manager (arm_list_subscriptions, arm_list_resource_groups, arm_get_resource_group, arm_list_resources), Azure Monitor (monitor_list_metrics, monitor_query_logs), generic authenticated request, and info.",
  inputSchema: {
    type: "object",
    required: ["operation"],
    properties: {
      operation: {
        type: "string",
        description: "Operation to perform. One of: blob_list_containers, blob_create_container, blob_delete_container, blob_list_blobs, blob_get_blob, blob_put_blob, blob_delete_blob, blob_head_blob, kv_get_secret, kv_list_secrets, kv_set_secret, kv_delete_secret, kv_get_key, kv_list_keys, kv_encrypt, kv_decrypt, sb_send_message, sb_receive_message, sb_peek_message, sb_delete_message, sb_list_queues, cosmos_list_databases, cosmos_list_collections, cosmos_query_documents, cosmos_get_document, cosmos_upsert_document, cosmos_delete_document, arm_list_subscriptions, arm_list_resource_groups, arm_get_resource_group, arm_list_resources, monitor_list_metrics, monitor_query_logs, request, info.",
      },
      // ── Auth: OAuth2 Client Credentials ──────────────────────────────────
      tenant_id: {
        type: "string",
        description: "Azure AD tenant ID (GUID or domain). Required (with client_id + client_secret) for OAuth2 Client Credentials flow.",
      },
      client_id: {
        type: "string",
        description: "Azure AD application (client) ID. Required with tenant_id + client_secret.",
      },
      client_secret: {
        type: "string",
        description: "Azure AD client secret. Required with tenant_id + client_id. Never returned in output or errors.",
      },
      // ── Auth: pre-obtained token ──────────────────────────────────────────
      access_token: {
        type: "string",
        description: "Pre-obtained Azure Bearer token. Provide this instead of tenant_id/client_id/client_secret if you already have a valid token.",
      },
      // ── Common ────────────────────────────────────────────────────────────
      subscription_id: {
        type: "string",
        description: "Azure subscription ID (GUID). Required for ARM operations (arm_list_resource_groups, arm_get_resource_group, arm_list_resources).",
      },
      scope: {
        type: "string",
        description: "OAuth2 scope for token request (default: 'https://management.azure.com/.default'). Override for Key Vault ('https://vault.azure.net/.default') or other services.",
      },
      timeout: {
        type: "number",
        description: "Request timeout in milliseconds (1000–120000, default: 20000).",
      },
      reject_unauthorized: {
        type: "boolean",
        description: "Reject invalid TLS certificates (default: true). Set false for self-signed certs in dev environments.",
      },
      // ── Blob Storage ──────────────────────────────────────────────────────
      storage_account: {
        type: "string",
        description: "Azure Storage account name (e.g. 'mystorageaccount'). Used to build the endpoint 'https://{account}.blob.core.windows.net'. Required for Blob operations unless custom_endpoint is set.",
      },
      custom_endpoint: {
        type: "string",
        description: "Override the storage endpoint URL (e.g. 'http://127.0.0.1:10000/devstoreaccount1' for Azurite emulator).",
      },
      container: {
        type: "string",
        description: "Blob container name. Required for blob_list_blobs, blob_get_blob, blob_put_blob, blob_delete_blob, blob_head_blob, blob_create_container, blob_delete_container.",
      },
      blob: {
        type: "string",
        description: "Blob name (object path within the container). Required for blob_get_blob, blob_put_blob, blob_delete_blob, blob_head_blob.",
      },
      prefix: {
        type: "string",
        description: "Prefix filter for blob_list_blobs (e.g. 'logs/2024/').",
      },
      max_results: {
        type: "number",
        description: "Maximum items to return for blob_list_blobs, kv_list_secrets, kv_list_keys, cosmos_query_documents, arm_list_resources.",
      },
      body: {
        type: "string",
        description: "UTF-8 body for blob_put_blob. Use body_base64 for binary data.",
      },
      body_base64: {
        type: "string",
        description: "base64-encoded binary body for blob_put_blob. Takes precedence over 'body'.",
      },
      content_type: {
        type: "string",
        description: "Content-Type for blob_put_blob (default: 'application/octet-stream') or kv_set_secret (secret content type label).",
      },
      public_access: {
        type: "string",
        description: "blob_create_container: public access level — 'blob' (public blob), 'container' (full public), or omit for private.",
      },
      // ── Key Vault ─────────────────────────────────────────────────────────
      vault_name: {
        type: "string",
        description: "Key Vault name (e.g. 'mykeyvault'). Used to build endpoint 'https://{vault_name}.vault.azure.net'. Provide vault_name or vault_url.",
      },
      vault_url: {
        type: "string",
        description: "Full Key Vault URL (e.g. 'https://mykeyvault.vault.azure.net'). Takes precedence over vault_name.",
      },
      secret_name: {
        type: "string",
        description: "Key Vault secret name. Required for kv_get_secret, kv_set_secret, kv_delete_secret.",
      },
      secret_value: {
        type: "string",
        description: "Secret value string. Required for kv_set_secret.",
      },
      secret_version: {
        type: "string",
        description: "Key Vault secret version (empty string = latest). Optional for kv_get_secret.",
      },
      enabled: {
        type: "boolean",
        description: "Key Vault secret/key enabled attribute for kv_set_secret.",
      },
      key_name: {
        type: "string",
        description: "Key Vault key name. Required for kv_get_key, kv_list_keys, kv_encrypt, kv_decrypt.",
      },
      key_version: {
        type: "string",
        description: "Key Vault key version (empty = latest). Optional for kv_get_key, kv_encrypt, kv_decrypt.",
      },
      algorithm: {
        type: "string",
        description: "Encryption algorithm for kv_encrypt/kv_decrypt (default: 'RSA-OAEP'). Also supports RSA-OAEP-256, RSA1_5.",
      },
      plaintext: {
        type: "string",
        description: "Plaintext string to encrypt for kv_encrypt. Encoded to UTF-8 then base64url before sending.",
      },
      plaintext_base64: {
        type: "string",
        description: "base64url-encoded plaintext for kv_encrypt. Use instead of 'plaintext' for binary data.",
      },
      ciphertext: {
        type: "string",
        description: "base64url-encoded ciphertext value returned by kv_encrypt, to be passed to kv_decrypt.",
      },
      // ── Service Bus ───────────────────────────────────────────────────────
      namespace_name: {
        type: "string",
        description: "Service Bus namespace name (e.g. 'mysbnamespace'). Builds endpoint 'https://{name}.servicebus.windows.net'. Provide namespace_name or namespace_url.",
      },
      namespace_url: {
        type: "string",
        description: "Full Service Bus namespace URL. Takes precedence over namespace_name.",
      },
      queue_name: {
        type: "string",
        description: "Service Bus queue name. Required for sb_send_message, sb_receive_message, sb_peek_message, sb_delete_message.",
      },
      message: {
        type: ["string", "object"],
        description: "Message body for sb_send_message. Strings are sent as-is; objects are JSON.stringified.",
      },
      message_id: {
        type: "string",
        description: "Service Bus message ID (BrokerProperties.MessageId) for sb_send_message.",
      },
      correlation_id: {
        type: "string",
        description: "Service Bus correlation ID (BrokerProperties.CorrelationId) for sb_send_message.",
      },
      session_id: {
        type: "string",
        description: "Service Bus session ID (BrokerProperties.SessionId) for sb_send_message.",
      },
      time_to_live: {
        type: "string",
        description: "Service Bus TimeToLiveTimeSpan for sb_send_message (e.g. '00:01:00' for 1 minute).",
      },
      timeout_seconds: {
        type: "number",
        description: "sb_receive_message long-poll timeout in seconds (max 60, default 5).",
      },
      lock_token: {
        type: "string",
        description: "Service Bus message lock token (from sb_receive_message) for sb_delete_message.",
      },
      sequence_number: {
        type: "string",
        description: "Service Bus message sequence number (from sb_receive_message) for sb_delete_message.",
      },
      // ── Cosmos DB ─────────────────────────────────────────────────────────
      cosmos_account: {
        type: "string",
        description: "Cosmos DB account name (e.g. 'mycosmosaccount'). Builds endpoint 'https://{account}.documents.azure.com'. Provide cosmos_account or cosmos_url.",
      },
      cosmos_url: {
        type: "string",
        description: "Full Cosmos DB account endpoint URL. Takes precedence over cosmos_account.",
      },
      cosmos_master_key: {
        type: "string",
        description: "Cosmos DB master key (primary or secondary, base64-encoded). Required for all cosmos_ operations. Used for HMAC-SHA256 request signing.",
      },
      database: {
        type: "string",
        description: "Cosmos DB database ID. Required for cosmos_list_collections, cosmos_query_documents, cosmos_get_document, cosmos_upsert_document, cosmos_delete_document.",
      },
      collection: {
        type: "string",
        description: "Cosmos DB collection (container) ID. Required for cosmos_query_documents, cosmos_get_document, cosmos_upsert_document, cosmos_delete_document.",
      },
      query: {
        type: "string",
        description: "SQL API query string for cosmos_query_documents (e.g. 'SELECT * FROM c WHERE c.type = @type').",
      },
      parameters: {
        type: "array",
        items: { type: "object" },
        description: "cosmos_query_documents: SQL query parameter array (e.g. [{\"name\": \"@type\", \"value\": \"user\"}]).",
      },
      document_id: {
        type: "string",
        description: "Cosmos DB document ID. Required for cosmos_get_document and cosmos_delete_document.",
      },
      document: {
        type: "object",
        description: "Cosmos DB document object to upsert. Required for cosmos_upsert_document.",
      },
      partition_key: {
        description: "Cosmos DB partition key value for cosmos_get_document, cosmos_upsert_document, cosmos_delete_document.",
      },
      // ── ARM (Azure Resource Manager) ──────────────────────────────────────
      resource_group: {
        type: "string",
        description: "Resource group name for arm_get_resource_group and arm_list_resources (optional filter).",
      },
      filter: {
        type: "string",
        description: "OData $filter expression for arm_list_resources (e.g. \"resourceType eq 'Microsoft.Storage/storageAccounts'\").",
      },
      // ── Monitor ───────────────────────────────────────────────────────────
      resource_id: {
        type: "string",
        description: "Azure resource ID path for monitor_list_metrics (e.g. '/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.Storage/storageAccounts/{account}').",
      },
      metric_names: {
        type: "string",
        description: "Comma-separated metric names for monitor_list_metrics (e.g. 'Transactions,Egress').",
      },
      timespan: {
        type: "string",
        description: "ISO 8601 timespan for monitor_list_metrics / monitor_query_logs (e.g. '2024-01-01T00:00:00Z/2024-01-02T00:00:00Z' or 'PT1H').",
      },
      interval: {
        type: "string",
        description: "monitor_list_metrics: aggregation granularity (e.g. 'PT1M', 'PT1H').",
      },
      aggregation: {
        type: "string",
        description: "monitor_list_metrics: aggregation type (e.g. 'Average', 'Total', 'Count').",
      },
      workspace_id: {
        type: "string",
        description: "Log Analytics workspace ID for monitor_query_logs.",
      },
      // ── Generic request ───────────────────────────────────────────────────
      url: {
        type: "string",
        description: "Full URL for the generic 'request' operation.",
      },
      method: {
        type: "string",
        description: "HTTP method for the generic 'request' operation: GET, POST, PUT, DELETE, HEAD, PATCH.",
      },
      extra_headers: {
        type: "object",
        description: "Additional HTTP headers for the generic 'request' operation (merged with Authorization + Content-Type).",
      },
    },
  },
};

module.exports = { AZURE_CLIENT_SCHEMA };
