"use strict";

const AWS_CLIENT_SCHEMA = {
  name: "aws_client",
  description: "Zero-dependency AWS API client with SigV4 (Signature Version 4) authentication — pure Node.js http/https/crypto built-ins; no npm deps. Supports S3, DynamoDB, SQS, SNS, STS, Lambda, Secrets Manager, SSM Parameter Store, EC2, CloudWatch, and a generic signed-request fallback for any AWS service. All requests are authenticated using AWS4-HMAC-SHA256. Credentials (access key, secret key, optional session token) are never returned in output or error messages. TLS enabled by default. Operations: s3_list_buckets, s3_list_objects, s3_get_object, s3_put_object, s3_delete_object, s3_head_object, dynamodb_get_item, dynamodb_put_item, dynamodb_delete_item, dynamodb_query, dynamodb_scan, dynamodb_list_tables, sqs_send_message, sqs_receive_message, sqs_get_queue_url, sqs_list_queues, sns_publish, sns_list_topics, sns_create_topic, sts_get_caller_identity, sts_assume_role, lambda_invoke, lambda_list_functions, secretsmanager_get_secret_value, secretsmanager_list_secrets, ssm_get_parameter, ssm_put_parameter, ssm_get_parameters_by_path, ec2_describe_instances, cloudwatch_list_metrics, request (generic), info.",
  inputSchema: {
    type: "object",
    required: ["operation"],
    properties: {
      operation: {
        type: "string",
        description: "Operation to perform. One of: s3_list_buckets, s3_list_objects, s3_get_object, s3_put_object, s3_delete_object, s3_head_object, dynamodb_get_item, dynamodb_put_item, dynamodb_delete_item, dynamodb_query, dynamodb_scan, dynamodb_list_tables, sqs_send_message, sqs_receive_message, sqs_get_queue_url, sqs_list_queues, sns_publish, sns_list_topics, sns_create_topic, sts_get_caller_identity, sts_assume_role, lambda_invoke, lambda_list_functions, secretsmanager_get_secret_value, secretsmanager_list_secrets, ssm_get_parameter, ssm_put_parameter, ssm_get_parameters_by_path, ec2_describe_instances, cloudwatch_list_metrics, request, info.",
      },
      // ── Credentials (required for all ops except info) ──
      access_key_id: {
        type: "string",
        description: "AWS access key ID (e.g. AKIAIOSFODNN7EXAMPLE). Required for all operations except 'info'.",
      },
      secret_key: {
        type: "string",
        description: "AWS secret access key. Required for all operations except 'info'. Never returned in output.",
      },
      session_token: {
        type: "string",
        description: "Optional STS session token for temporary credentials (AssumeRole / GetSessionToken).",
      },
      region: {
        type: "string",
        description: "AWS region (e.g. 'us-east-1', 'eu-west-1'). Default: 'us-east-1'. STS always uses global endpoint.",
      },
      use_tls: {
        type: "boolean",
        description: "Use HTTPS (default: true). Set false only for local testing (e.g. LocalStack HTTP).",
      },
      reject_unauthorized: {
        type: "boolean",
        description: "Reject invalid TLS certificates (default: true). Set false for self-signed certs in dev.",
      },
      timeout: {
        type: "number",
        description: "Request timeout in milliseconds (1000–120000, default: 15000).",
      },
      custom_endpoint: {
        type: "string",
        description: "Override the AWS endpoint URL (e.g. 'http://localhost:4566' for LocalStack). Overrides service endpoint resolution.",
      },
      // ── S3 ─────────────────────────────────────────────
      bucket: {
        type: "string",
        description: "S3 bucket name. Required for: s3_list_objects, s3_get_object, s3_put_object, s3_delete_object, s3_head_object.",
      },
      key: {
        type: "string",
        description: "S3 object key (path within bucket). Required for: s3_get_object, s3_put_object, s3_delete_object, s3_head_object.",
      },
      prefix: {
        type: "string",
        description: "S3 key prefix filter for s3_list_objects; queue name prefix for sqs_list_queues.",
      },
      max_keys: {
        type: "number",
        description: "Maximum objects to return in s3_list_objects (default: AWS default 1000).",
      },
      delimiter: {
        type: "string",
        description: "S3 delimiter for s3_list_objects (e.g. '/' to list top-level keys only).",
      },
      start_after: {
        type: "string",
        description: "S3 s3_list_objects: start after this key (for pagination).",
      },
      path_style: {
        type: "boolean",
        description: "Use S3 path-style URLs (/{bucket}/{key}) instead of virtual-hosted style. Required for LocalStack and some non-AWS S3-compatible stores.",
      },
      body: {
        type: "string",
        description: "s3_put_object: UTF-8 body string to upload. Use 'body_base64' for binary data.",
      },
      body_base64: {
        type: "string",
        description: "s3_put_object: base64-encoded binary body. Preferred over 'body' for non-text objects.",
      },
      content_type: {
        type: "string",
        description: "s3_put_object: Content-Type header (default: 'application/octet-stream').",
      },
      // ── DynamoDB ────────────────────────────────────────
      table: {
        type: "string",
        description: "DynamoDB table name. Required for: dynamodb_get_item, dynamodb_put_item, dynamodb_delete_item, dynamodb_query, dynamodb_scan.",
      },
      item: {
        type: "object",
        description: "DynamoDB attribute map for dynamodb_put_item. Keys are attribute names, values are DynamoDB typed values e.g. {\"id\": {\"S\": \"123\"}, \"count\": {\"N\": \"5\"}}.",
      },
      key_condition: {
        type: "string",
        description: "DynamoDB KeyConditionExpression for dynamodb_query (e.g. 'pk = :pk').",
      },
      filter: {
        type: "string",
        description: "DynamoDB FilterExpression for dynamodb_query / dynamodb_scan.",
      },
      expression_attrs: {
        type: "object",
        description: "DynamoDB ExpressionAttributeNames map (e.g. {\"#n\": \"name\"}).",
      },
      expression_values: {
        type: "object",
        description: "DynamoDB ExpressionAttributeValues map (e.g. {\":pk\": {\"S\": \"user#123\"}}).",
      },
      index: {
        type: "string",
        description: "DynamoDB GSI/LSI name for dynamodb_query or dynamodb_scan.",
      },
      limit: {
        type: "number",
        description: "DynamoDB max items per call for dynamodb_query, dynamodb_scan; or Lambda max_items for lambda_list_functions.",
      },
      scan_index_forward: {
        type: "boolean",
        description: "DynamoDB dynamodb_query: ascending (true, default) or descending (false) sort order.",
      },
      projection: {
        type: "string",
        description: "DynamoDB ProjectionExpression for dynamodb_get_item, dynamodb_query, dynamodb_scan.",
      },
      consistent_read: {
        type: "boolean",
        description: "DynamoDB dynamodb_get_item: use strongly consistent reads (default: false).",
      },
      condition: {
        type: "string",
        description: "DynamoDB ConditionExpression for dynamodb_put_item or dynamodb_delete_item.",
      },
      // ── SQS ─────────────────────────────────────────────
      queue_url: {
        type: "string",
        description: "SQS queue URL. Required for: sqs_send_message, sqs_receive_message.",
      },
      queue_name: {
        type: "string",
        description: "SQS queue name for sqs_get_queue_url.",
      },
      message_body: {
        type: "string",
        description: "SQS message body string for sqs_send_message.",
      },
      delay_seconds: {
        type: "number",
        description: "SQS sqs_send_message: message delivery delay in seconds (0–900).",
      },
      group_id: {
        type: "string",
        description: "SQS FIFO queue MessageGroupId for sqs_send_message.",
      },
      dedup_id: {
        type: "string",
        description: "SQS FIFO queue MessageDeduplicationId for sqs_send_message.",
      },
      max_messages: {
        type: "number",
        description: "SQS sqs_receive_message: max messages to receive (1–10, default: 1).",
      },
      wait_seconds: {
        type: "number",
        description: "SQS sqs_receive_message: long-poll wait time in seconds (0–20, default: 0).",
      },
      visibility_timeout: {
        type: "number",
        description: "SQS sqs_receive_message: visibility timeout in seconds.",
      },
      // ── SNS ─────────────────────────────────────────────
      topic_arn: {
        type: "string",
        description: "SNS topic ARN. Required for sns_publish (or use target_arn/phone_number), sns_create_topic reads topic_name instead.",
      },
      target_arn: {
        type: "string",
        description: "SNS target ARN (mobile push endpoint) for sns_publish.",
      },
      phone_number: {
        type: "string",
        description: "SNS phone number in E.164 format for SMS publish (e.g. '+15555551234').",
      },
      message: {
        type: "string",
        description: "SNS message string for sns_publish.",
      },
      subject: {
        type: "string",
        description: "SNS email subject for sns_publish (optional).",
      },
      message_structure: {
        type: "string",
        description: "SNS sns_publish: set to 'json' to send per-protocol messages.",
      },
      topic_name: {
        type: "string",
        description: "SNS topic name for sns_create_topic.",
      },
      // ── STS ─────────────────────────────────────────────
      role_arn: {
        type: "string",
        description: "IAM role ARN to assume. Required for sts_assume_role.",
      },
      role_session_name: {
        type: "string",
        description: "Session name for sts_assume_role (alphanumeric + =,.@-).",
      },
      duration_seconds: {
        type: "number",
        description: "sts_assume_role: session duration in seconds (900–43200, default: AWS default 3600).",
      },
      external_id: {
        type: "string",
        description: "sts_assume_role: ExternalId condition key (for cross-account assume-role).",
      },
      // ── Lambda ──────────────────────────────────────────
      function_name: {
        type: "string",
        description: "Lambda function name or ARN. Required for lambda_invoke, lambda_list_functions (optional).",
      },
      payload: {
        type: "object",
        description: "Lambda invocation payload object for lambda_invoke (serialised to JSON).",
      },
      invocation_type: {
        type: "string",
        description: "Lambda lambda_invoke: 'RequestResponse' (sync, default), 'Event' (async), or 'DryRun'.",
      },
      qualifier: {
        type: "string",
        description: "Lambda function version or alias for lambda_invoke.",
      },
      log_type: {
        type: "string",
        description: "Lambda lambda_invoke: 'Tail' to include last 4 KB of logs in response.",
      },
      max_items: {
        type: "number",
        description: "Lambda lambda_list_functions: max functions to return.",
      },
      // ── Secrets Manager ─────────────────────────────────
      secret_id: {
        type: "string",
        description: "Secrets Manager secret ID or ARN. Required for secretsmanager_get_secret_value.",
      },
      version_id: {
        type: "string",
        description: "Secrets Manager secret version ID for secretsmanager_get_secret_value.",
      },
      version_stage: {
        type: "string",
        description: "Secrets Manager version stage label (default: 'AWSCURRENT').",
      },
      max_results: {
        type: "number",
        description: "Max results for secretsmanager_list_secrets or ssm_get_parameters_by_path.",
      },
      // ── SSM Parameter Store ──────────────────────────────
      name: {
        type: "string",
        description: "SSM parameter name. Required for ssm_get_parameter and ssm_put_parameter.",
      },
      value: {
        type: "string",
        description: "SSM parameter value for ssm_put_parameter.",
      },
      type: {
        type: "string",
        description: "SSM parameter type for ssm_put_parameter: 'String' (default), 'StringList', or 'SecureString'.",
      },
      overwrite: {
        type: "boolean",
        description: "SSM ssm_put_parameter: overwrite existing parameter (default: true).",
      },
      description: {
        type: "string",
        description: "SSM ssm_put_parameter: parameter description.",
      },
      key_id: {
        type: "string",
        description: "SSM ssm_put_parameter: KMS key ID for SecureString parameters.",
      },
      path: {
        type: "string",
        description: "SSM path prefix for ssm_get_parameters_by_path (e.g. '/myapp/prod/').",
      },
      with_decryption: {
        type: "boolean",
        description: "SSM: decrypt SecureString values (default: true).",
      },
      recursive: {
        type: "boolean",
        description: "SSM ssm_get_parameters_by_path: include sub-path parameters (default: true).",
      },
      // ── EC2 ─────────────────────────────────────────────
      instance_ids: {
        type: "array",
        items: { type: "string" },
        description: "EC2 instance IDs to filter for ec2_describe_instances.",
      },
      // ── CloudWatch ───────────────────────────────────────
      namespace: {
        type: "string",
        description: "CloudWatch metric namespace filter for cloudwatch_list_metrics (e.g. 'AWS/EC2').",
      },
      metric_name: {
        type: "string",
        description: "CloudWatch metric name filter for cloudwatch_list_metrics.",
      },
      // ── Generic request ──────────────────────────────────
      service: {
        type: "string",
        description: "AWS service name for the generic 'request' operation (e.g. 's3', 'dynamodb', 'iam', 'logs').",
      },
      method: {
        type: "string",
        description: "HTTP method for the generic 'request' operation: GET, POST, PUT, DELETE, HEAD, PATCH.",
      },
      headers: {
        type: "object",
        description: "Additional HTTP headers for the generic 'request' operation.",
      },
      query_params: {
        type: "object",
        description: "Query string parameters for the generic 'request' operation.",
      },
      endpoint: {
        type: "string",
        description: "Full endpoint URL override for the generic 'request' operation.",
      },
    },
  },
};

module.exports = { AWS_CLIENT_SCHEMA };
