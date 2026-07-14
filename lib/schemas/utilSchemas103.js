"use strict";

const GCP_CLIENT_SCHEMA = {
  name: "gcp_client",
  description: "Zero-dependency Google Cloud Platform (GCP) API client — pure Node.js http/https/crypto built-ins; no npm deps. Supports GCS (Cloud Storage), BigQuery, Pub/Sub, Compute Engine, Cloud Run, IAM, Secret Manager, Cloud KMS, Cloud Monitoring, and a generic authenticated-request fallback. Auth: service account JSON key (RS256-signed JWT → OAuth2 Bearer token) or pre-obtained access_token. Credentials never returned in output or error messages. TLS enabled by default. Operations: gcs_list_buckets, gcs_list_objects, gcs_get_object, gcs_put_object, gcs_delete_object, gcs_head_object, gcs_get_bucket_metadata, bigquery_list_datasets, bigquery_list_tables, bigquery_query, bigquery_get_table_schema, bigquery_insert_rows, pubsub_list_topics, pubsub_create_topic, pubsub_delete_topic, pubsub_publish, pubsub_list_subscriptions, pubsub_create_subscription, pubsub_pull, pubsub_acknowledge, compute_list_instances, compute_get_instance, compute_list_zones, cloudrun_list_services, cloudrun_get_service, iam_list_service_accounts, iam_get_service_account, secretmgr_list_secrets, secretmgr_get_secret, secretmgr_access_secret_version, secretmgr_add_secret_version, kms_list_key_rings, kms_list_crypto_keys, kms_encrypt, kms_decrypt, monitoring_list_metric_descriptors, monitoring_list_time_series, request (generic), info.",
  inputSchema: {
    type: "object",
    required: ["operation"],
    properties: {
      operation: {
        type: "string",
        description: "Operation to perform. One of: gcs_list_buckets, gcs_list_objects, gcs_get_object, gcs_put_object, gcs_delete_object, gcs_head_object, gcs_get_bucket_metadata, bigquery_list_datasets, bigquery_list_tables, bigquery_query, bigquery_get_table_schema, bigquery_insert_rows, pubsub_list_topics, pubsub_create_topic, pubsub_delete_topic, pubsub_publish, pubsub_list_subscriptions, pubsub_create_subscription, pubsub_pull, pubsub_acknowledge, compute_list_instances, compute_get_instance, compute_list_zones, cloudrun_list_services, cloudrun_get_service, iam_list_service_accounts, iam_get_service_account, secretmgr_list_secrets, secretmgr_get_secret, secretmgr_access_secret_version, secretmgr_add_secret_version, kms_list_key_rings, kms_list_crypto_keys, kms_encrypt, kms_decrypt, monitoring_list_metric_descriptors, monitoring_list_time_series, request, info.",
      },
      // ── Auth (required for all ops except info) ──
      service_account_key: {
        type: "object",
        description: "GCP service account key as a JSON object (parsed) or JSON string. Must contain 'private_key' and 'client_email'. Optionally contains 'project_id'. The key is used to sign a JWT which is exchanged for an OAuth2 access token. Credentials are never returned in output.",
      },
      access_token: {
        type: "string",
        description: "Pre-obtained OAuth2 Bearer access token. Alternative to 'service_account_key'. Use this when you already have a valid token (e.g. from Workload Identity or Application Default Credentials obtained externally).",
      },
      project_id: {
        type: "string",
        description: "GCP project ID (e.g. 'my-project-123'). Required for most operations. If using service_account_key that contains 'project_id', it is used as default.",
      },
      scopes: {
        type: "array",
        items: { type: "string" },
        description: "OAuth2 scopes to request when obtaining an access token from a service account key. Default: ['https://www.googleapis.com/auth/cloud-platform'] (full access). Only relevant when using 'service_account_key'.",
      },
      reject_unauthorized: {
        type: "boolean",
        description: "Reject invalid TLS certificates (default: true). Set false only for testing with self-signed certs.",
      },
      timeout: {
        type: "number",
        description: "Request timeout in milliseconds (1000–120000, default: 20000).",
      },
      // ── GCS ─────────────────────────────────────────────
      bucket: {
        type: "string",
        description: "GCS bucket name. Required for: gcs_list_objects, gcs_get_object, gcs_put_object, gcs_delete_object, gcs_head_object, gcs_get_bucket_metadata.",
      },
      object: {
        type: "string",
        description: "GCS object name (path within bucket). Required for: gcs_get_object, gcs_put_object, gcs_delete_object, gcs_head_object.",
      },
      prefix: {
        type: "string",
        description: "GCS prefix filter for gcs_list_objects (e.g. 'folder/').",
      },
      delimiter: {
        type: "string",
        description: "GCS delimiter for gcs_list_objects (e.g. '/' to list top-level keys only).",
      },
      body: {
        type: "string",
        description: "gcs_put_object: UTF-8 body string to upload.",
      },
      body_base64: {
        type: "string",
        description: "gcs_put_object: base64-encoded binary body. Use for non-text objects.",
      },
      content_type: {
        type: "string",
        description: "gcs_put_object: Content-Type header (default: 'application/octet-stream').",
      },
      versions: {
        type: "boolean",
        description: "gcs_list_objects: include all object versions (default: false).",
      },
      // ── BigQuery ────────────────────────────────────────
      dataset: {
        type: "string",
        description: "BigQuery dataset ID. Required for: bigquery_list_tables, bigquery_query (optional), bigquery_get_table_schema, bigquery_insert_rows.",
      },
      table: {
        type: "string",
        description: "BigQuery table ID. Required for: bigquery_get_table_schema, bigquery_insert_rows.",
      },
      query: {
        type: "string",
        description: "SQL query string for bigquery_query.",
      },
      use_legacy_sql: {
        type: "boolean",
        description: "bigquery_query: use legacy SQL syntax (default: false — uses standard SQL).",
      },
      max_results: {
        type: "number",
        description: "Maximum results for bigquery_query (default: 1000), gcs_list_objects, bigquery_list_tables, gcs_list_buckets.",
      },
      query_timeout_ms: {
        type: "number",
        description: "bigquery_query: server-side timeout in milliseconds (default: 30000).",
      },
      default_dataset: {
        type: "string",
        description: "bigquery_query: default dataset ID for unqualified table names.",
      },
      location: {
        type: "string",
        description: "bigquery_query: location of the query job (e.g. 'US', 'EU'). Also used for kms_list_key_rings and kms_list_crypto_keys.",
      },
      rows: {
        type: "array",
        items: { type: "object" },
        description: "bigquery_insert_rows: array of row objects to insert (each key is a column name).",
      },
      insert_ids: {
        type: "array",
        items: { type: "string" },
        description: "bigquery_insert_rows: optional per-row deduplication insert IDs.",
      },
      skip_invalid_rows: {
        type: "boolean",
        description: "bigquery_insert_rows: skip rows with schema errors instead of failing (default: false).",
      },
      ignore_unknown_values: {
        type: "boolean",
        description: "bigquery_insert_rows: ignore unknown column names (default: false).",
      },
      all: {
        type: "boolean",
        description: "bigquery_list_datasets: include hidden datasets (default: false).",
      },
      // ── Pub/Sub ─────────────────────────────────────────
      topic: {
        type: "string",
        description: "Pub/Sub topic name (short name like 'my-topic' or FQN 'projects/PROJECT/topics/TOPIC'). Required for: pubsub_create_topic, pubsub_delete_topic, pubsub_publish, pubsub_create_subscription.",
      },
      subscription: {
        type: "string",
        description: "Pub/Sub subscription name (short or FQN). Required for: pubsub_create_subscription, pubsub_pull, pubsub_acknowledge.",
      },
      messages: {
        type: "array",
        items: {
          type: "object",
          properties: {
            data: { description: "Message payload (string, object serialised to JSON, or Buffer). Will be base64-encoded." },
            attributes: { type: "object", description: "Key-value string attributes for the message." },
            ordering_key: { type: "string", description: "Ordering key for ordered subscriptions." },
          },
        },
        description: "pubsub_publish: array of messages to publish.",
      },
      ack_ids: {
        type: "array",
        items: { type: "string" },
        description: "pubsub_acknowledge: list of ack_id values from pubsub_pull to acknowledge.",
      },
      max_messages: {
        type: "number",
        description: "pubsub_pull: maximum messages to return (default: 10).",
      },
      return_immediately: {
        type: "boolean",
        description: "pubsub_pull: return immediately if no messages (default: true).",
      },
      ack_deadline_seconds: {
        type: "number",
        description: "pubsub_create_subscription: ack deadline in seconds (default: 10).",
      },
      retain_acked_messages: {
        type: "boolean",
        description: "pubsub_create_subscription: retain acknowledged messages (default: false).",
      },
      message_retention_duration: {
        type: "string",
        description: "pubsub_create_subscription: message retention duration (e.g. '600s', '7d'). Default: 7 days.",
      },
      push_endpoint: {
        type: "string",
        description: "pubsub_create_subscription: HTTPS push endpoint URL. If omitted, pull subscription is created.",
      },
      page_size: {
        type: "number",
        description: "Page size for list operations (pubsub_list_topics, pubsub_list_subscriptions, secretmgr_list_secrets, iam_list_service_accounts, monitoring_list_metric_descriptors, monitoring_list_time_series).",
      },
      page_token: {
        type: "string",
        description: "Pagination token for gcs_list_buckets, gcs_list_objects, pubsub_list_topics.",
      },
      // ── Compute Engine ───────────────────────────────────
      zone: {
        type: "string",
        description: "GCP zone name (e.g. 'us-central1-a'). Required for compute_get_instance. Optional for compute_list_instances (default: all zones).",
      },
      instance: {
        type: "string",
        description: "Compute Engine instance name. Required for compute_get_instance.",
      },
      filter: {
        type: "string",
        description: "Filter expression for compute_list_instances (e.g. 'status=RUNNING'), compute_list_zones, or monitoring_list_metric_descriptors (e.g. 'metric.type=starts_with(\"compute.googleapis.com\")').",
      },
      // ── Cloud Run ────────────────────────────────────────
      region: {
        type: "string",
        description: "GCP region name (e.g. 'us-central1'). Required for cloudrun_list_services, cloudrun_get_service.",
      },
      service: {
        type: "string",
        description: "Cloud Run service name. Required for cloudrun_get_service.",
      },
      // ── IAM ──────────────────────────────────────────────
      email: {
        type: "string",
        description: "IAM service account email (e.g. 'my-sa@project.iam.gserviceaccount.com'). Required for iam_get_service_account.",
      },
      // ── Secret Manager ───────────────────────────────────
      secret: {
        type: "string",
        description: "Secret Manager secret name (short name or FQN). Required for secretmgr_get_secret, secretmgr_access_secret_version, secretmgr_add_secret_version.",
      },
      version: {
        type: "string",
        description: "Secret Manager secret version (e.g. '1', '2', 'latest'). Default: 'latest'. Used by secretmgr_access_secret_version.",
      },
      secret_value: {
        type: "string",
        description: "The secret string value to store. Required for secretmgr_add_secret_version.",
      },
      // ── Cloud KMS ────────────────────────────────────────
      key_ring: {
        type: "string",
        description: "Cloud KMS key ring name. Required for kms_list_crypto_keys, kms_encrypt, kms_decrypt.",
      },
      crypto_key: {
        type: "string",
        description: "Cloud KMS crypto key name. Required for kms_encrypt, kms_decrypt.",
      },
      plaintext: {
        type: "string",
        description: "kms_encrypt: plaintext string to encrypt. Mutually exclusive with 'plaintext_base64'.",
      },
      plaintext_base64: {
        type: "string",
        description: "kms_encrypt: base64-encoded plaintext bytes to encrypt. Use for binary data.",
      },
      ciphertext: {
        type: "string",
        description: "kms_decrypt: base64-encoded ciphertext to decrypt. Required for kms_decrypt.",
      },
      additional_auth: {
        type: "string",
        description: "kms_encrypt/kms_decrypt: additional authenticated data (AAD) string for AEAD symmetric keys.",
      },
      // ── Monitoring ───────────────────────────────────────
      start_time: {
        type: "string",
        description: "monitoring_list_time_series: start of time interval (ISO 8601, e.g. '2024-01-01T00:00:00Z'). Default: 1 hour ago.",
      },
      end_time: {
        type: "string",
        description: "monitoring_list_time_series: end of time interval (ISO 8601). Default: now.",
      },
      view: {
        type: "string",
        description: "monitoring_list_time_series: data granularity — 'FULL' (default) or 'HEADERS'.",
      },
      aggregation_alignment_period: {
        type: "string",
        description: "monitoring_list_time_series: alignment period for aggregation (e.g. '60s', '3600s').",
      },
      aggregation_cross_series_reducer: {
        type: "string",
        description: "monitoring_list_time_series: reducer for cross-series aggregation (e.g. 'REDUCE_MEAN', 'REDUCE_SUM').",
      },
      // ── Generic request ──────────────────────────────────
      url: {
        type: "string",
        description: "Full URL for the generic 'request' operation (e.g. 'https://cloudresourcemanager.googleapis.com/v1/projects').",
      },
      method: {
        type: "string",
        description: "HTTP method for the generic 'request' operation: GET, POST, PUT, DELETE, HEAD, PATCH.",
      },
      body: {
        description: "Request body for 'request', 'bigquery_query', etc. Object is serialised to JSON automatically.",
      },
      extra_headers: {
        type: "object",
        description: "Additional HTTP headers for the generic 'request' operation.",
      },
    },
  },
};

module.exports = { GCP_CLIENT_SCHEMA };
