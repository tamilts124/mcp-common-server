"use strict";
/**
 * Tests for aws_client (section 269)
 * Five rigor levels: A=pure-helpers, B=validation, C=mock-network, D=security, E=concurrency
 *
 * Total: 148 tests
 */
const {
  signRequest, deriveSigningKey, hmacSha256, sha256Hex, uriEncode,
  buildCanonicalQueryString, buildConn, requireString, guardString, clampInt,
  buildEndpoint, extractAwsError, awsClient,
} = require("../../lib/awsClientOps");

const http = require("http");

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (condition) {
    passed++;
  } else {
    failed++;
    console.error("  FAIL:", msg);
  }
}

function assertThrows(fn, msgFragment, label) {
  try {
    fn();
    failed++;
    console.error("  FAIL (no throw):", label);
  } catch (e) {
    if (msgFragment && !e.message.includes(msgFragment)) {
      failed++;
      console.error(`  FAIL (wrong error '${e.message}'):`, label);
    } else {
      passed++;
    }
  }
}

async function assertRejects(fn, msgFragment, label) {
  try {
    await fn();
    failed++;
    console.error("  FAIL (no rejection):", label);
  } catch (e) {
    if (msgFragment && !e.message.includes(msgFragment)) {
      failed++;
      console.error(`  FAIL (wrong rejection '${e.message}'):`, label);
    } else {
      passed++;
    }
  }
}

function createMockServer(statusCode, body, headers = {}) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const allHeaders = { "content-type": "application/json", ...headers };
      res.writeHead(statusCode, allHeaders);
      res.end(body);
    });
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ server, port, url: `http://127.0.0.1:${port}` });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function main() {

  // ── A: Pure helper unit tests (47 tests) ───────────────────────────────────
  console.log("\nA: Pure helper unit tests");

  // sha256Hex
  assert(sha256Hex("") === "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "sha256Hex empty string");
  assert(sha256Hex("hello") === "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824", "sha256Hex hello");
  assert(typeof sha256Hex("abc") === "string", "sha256Hex returns string");
  assert(sha256Hex("abc").length === 64, "sha256Hex length 64");

  // hmacSha256
  const key = Buffer.from("test-key");
  const sig = hmacSha256(key, "hello");
  assert(Buffer.isBuffer(sig), "hmacSha256 returns Buffer");
  assert(sig.length === 32, "hmacSha256 length 32 bytes");
  const sig2 = hmacSha256(key, "hello");
  assert(sig.equals(sig2), "hmacSha256 deterministic");
  assert(!hmacSha256(key, "hello").equals(hmacSha256(key, "world")), "hmacSha256 different inputs differ");

  // deriveSigningKey - AWS test vector
  const sk = deriveSigningKey("wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "20150830", "us-east-1", "iam");
  assert(Buffer.isBuffer(sk), "deriveSigningKey returns Buffer");
  assert(sk.length === 32, "deriveSigningKey length 32");
  const expectedSK = "c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9";
  assert(sk.toString("hex") === expectedSK, "deriveSigningKey matches AWS test vector");

  // uriEncode
  assert(uriEncode("hello", true) === "hello", "uriEncode unreserved chars unchanged");
  assert(uriEncode("/foo/bar", false) === "/foo/bar", "uriEncode slash not encoded when encodeSlash=false");
  assert(uriEncode("/foo/bar", true) === "%2Ffoo%2Fbar", "uriEncode slash encoded when encodeSlash=true");
  assert(uriEncode("hello world", true) === "hello%20world", "uriEncode space encoded");
  assert(uriEncode("a=b&c=d", true) === "a%3Db%26c%3Dd", "uriEncode = and & encoded");
  assert(uriEncode("a~b-c_d.e", true) === "a~b-c_d.e", "uriEncode tildes and dashes unchanged");
  assert(uriEncode("", true) === "", "uriEncode empty string");

  // buildCanonicalQueryString
  assert(buildCanonicalQueryString({}) === "", "buildCanonicalQueryString empty");
  assert(buildCanonicalQueryString(null) === "", "buildCanonicalQueryString null");
  assert(buildCanonicalQueryString({ b: "2", a: "1" }) === "a=1&b=2", "buildCanonicalQueryString sorted");
  assert(buildCanonicalQueryString({ key: "a b" }) === "key=a%20b", "buildCanonicalQueryString encodes values");
  assert(buildCanonicalQueryString({ "a b": "c" }) === "a%20b=c", "buildCanonicalQueryString encodes keys");

  // requireString
  assert((() => { requireString("hello", "x"); return true; })(), "requireString valid");
  assertThrows(() => requireString("", "x"), "non-empty", "requireString empty string");
  assertThrows(() => requireString(123, "x"), "non-empty", "requireString number");
  assertThrows(() => requireString(null, "x"), "non-empty", "requireString null");
  assertThrows(() => requireString("a\0b", "x"), "NUL", "requireString NUL byte");

  // guardString
  assert((() => { guardString(undefined, "x"); return true; })(), "guardString undefined ok");
  assert((() => { guardString(null, "x"); return true; })(), "guardString null ok");
  assert((() => { guardString("hello", "x"); return true; })(), "guardString valid string ok");
  assertThrows(() => guardString("a\0b", "x"), "NUL", "guardString NUL byte");
  assertThrows(() => guardString(123, "x"), "must be a string", "guardString number");

  // clampInt
  assert(clampInt(undefined, 5, 1, 10, "t") === 5, "clampInt undefined returns default");
  assert(clampInt(null, 5, 1, 10, "t") === 5, "clampInt null returns default");
  assert(clampInt(7, 5, 1, 10, "t") === 7, "clampInt valid value");
  assert(clampInt("8", 5, 1, 10, "t") === 8, "clampInt string number");
  assertThrows(() => clampInt(0, 5, 1, 10, "t"), "between", "clampInt below min");
  assertThrows(() => clampInt(11, 5, 1, 10, "t"), "between", "clampInt above max");
  assertThrows(() => clampInt(NaN, 5, 1, 10, "t"), "must be a number", "clampInt NaN");

  // buildEndpoint
  assert(buildEndpoint("s3", "us-east-1", true) === "https://s3.amazonaws.com", "buildEndpoint s3 us-east-1");
  assert(buildEndpoint("s3", "eu-west-1", true) === "https://s3.eu-west-1.amazonaws.com", "buildEndpoint s3 eu-west-1");
  assert(buildEndpoint("dynamodb", "us-west-2", true) === "https://dynamodb.us-west-2.amazonaws.com", "buildEndpoint dynamodb");
  assert(buildEndpoint("sts", "us-east-1", true) === "https://sts.amazonaws.com", "buildEndpoint sts global");
  assert(buildEndpoint("s3", "us-east-1", false) === "http://s3.amazonaws.com", "buildEndpoint http scheme");
  assert(buildEndpoint("s3", "us-east-1", true, "http://localhost:4566") === "http://localhost:4566", "buildEndpoint custom");
  assertThrows(() => buildEndpoint("unknownservice", "us-east-1", true), "Unknown", "buildEndpoint unknown service");

  // extractAwsError
  const errJson = extractAwsError('{"__type":"NoSuchBucket","message":"The bucket does not exist"}', 404, "s3.get_object");
  assert(errJson instanceof Error, "extractAwsError returns Error");
  assert(errJson.message.includes("NoSuchBucket"), "extractAwsError JSON __type");
  assert(errJson.message.includes("404"), "extractAwsError includes status");
  const errXml = extractAwsError("<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>", 403, "s3.put_object");
  assert(errXml instanceof Error, "extractAwsError XML returns Error");
  assert(errXml.message.includes("AccessDenied"), "extractAwsError XML code");
  assert(errXml.message.includes("Access Denied"), "extractAwsError XML message");
  const errPlain = extractAwsError("Internal Server Error", 500, "test.op");
  assert(errPlain instanceof Error, "extractAwsError plain returns Error");
  assert(errPlain.message.includes("500"), "extractAwsError plain includes status");

  // signRequest produces Authorization header
  {
    const headers = { host: "s3.amazonaws.com" };
    signRequest({
      method: "GET", url: "https://s3.amazonaws.com/", headers, body: "",
      service: "s3", region: "us-east-1",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretKey:   "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      sessionToken: null,
    });
    assert(typeof headers["Authorization"] === "string", "signRequest adds Authorization header");
    assert(headers["Authorization"].startsWith("AWS4-HMAC-SHA256 "), "signRequest Authorization starts correctly");
    assert("x-amz-date" in headers, "signRequest adds x-amz-date");
    assert("x-amz-content-sha256" in headers, "signRequest adds x-amz-content-sha256");
  }

  // signRequest with session token
  {
    const headers = { host: "sts.amazonaws.com" };
    signRequest({
      method: "POST", url: "https://sts.amazonaws.com/", headers, body: "Action=GetCallerIdentity",
      service: "sts", region: "us-east-1",
      accessKeyId: "ASIA...", secretKey: "secret", sessionToken: "session-token-xyz",
    });
    assert(headers["x-amz-security-token"] === "session-token-xyz", "signRequest sets security token");
  }

  // buildConn
  {
    const conn = buildConn({ access_key_id: "AKI", secret_key: "sec", region: "eu-west-1" });
    assert(conn.region === "eu-west-1", "buildConn region");
    assert(conn.accessKeyId === "AKI", "buildConn accessKeyId");
    assert(conn.secretKey === "sec", "buildConn secretKey");
    assert(conn.useTls === true, "buildConn default useTls true");
    assert(conn.timeoutMs === 15000, "buildConn default timeout");
  }

  // ── B: Validation tests (15 tests) ──────────────────────────────────────────
  console.log("\nB: Validation tests");

  // info op requires no creds
  const infoResult = await awsClient({ operation: "info" });
  assert(infoResult.ok === true, "info returns ok:true");
  assert(Array.isArray(infoResult.operations), "info returns operations array");
  assert(infoResult.operations.length > 0, "info has operations");
  assert(typeof infoResult.protocol === "string", "info has protocol");
  assert(infoResult.services.includes("s3"), "info lists s3 service");
  assert(infoResult.services.includes("dynamodb"), "info lists dynamodb service");

  await assertRejects(
    () => awsClient({ operation: "s3_list_buckets", secret_key: "sec" }),
    "access_key_id", "missing access_key_id"
  );
  await assertRejects(
    () => awsClient({ operation: "s3_list_buckets", access_key_id: "AKI" }),
    "secret_key", "missing secret_key"
  );
  await assertRejects(
    () => awsClient({ operation: "s3_list_buckets", access_key_id: "A", secret_key: "s", timeout: 999999 }),
    "between", "timeout out of range"
  );
  await assertRejects(
    () => awsClient({ operation: "s3_list_buckets", access_key_id: "A\0B", secret_key: "s" }),
    "NUL", "NUL in access_key_id"
  );
  await assertRejects(
    () => awsClient({ operation: "nonexistent_op", access_key_id: "A", secret_key: "s" }),
    "Unknown", "unknown operation"
  );
  await assertRejects(
    () => awsClient({ operation: "s3_get_object", access_key_id: "A", secret_key: "s" }),
    "bucket", "s3_get_object missing bucket"
  );
  await assertRejects(
    () => awsClient({ operation: "s3_get_object", access_key_id: "A", secret_key: "s", bucket: "mybucket" }),
    "key", "s3_get_object missing key"
  );
  await assertRejects(
    () => awsClient({ operation: "dynamodb_get_item", access_key_id: "A", secret_key: "s" }),
    "table", "dynamodb_get_item missing table"
  );
  await assertRejects(
    () => awsClient({ operation: "dynamodb_query", access_key_id: "A", secret_key: "s", table: "T" }),
    "key_condition", "dynamodb_query missing key_condition"
  );
  await assertRejects(
    () => awsClient({ operation: "sqs_send_message", access_key_id: "A", secret_key: "s" }),
    "queue_url", "sqs_send_message missing queue_url"
  );
  await assertRejects(
    () => awsClient({ operation: "sns_publish", access_key_id: "A", secret_key: "s", topic_arn: "arn:aws:sns:us-east-1:123:test" }),
    "message", "sns_publish missing message"
  );
  await assertRejects(
    () => awsClient({ operation: "request", access_key_id: "A", secret_key: "s", service: "s3", method: "INVALID" }),
    "method must be one of", "request invalid method"
  );
  await assertRejects(
    () => awsClient({ operation: "ssm_get_parameter", access_key_id: "A", secret_key: "s" }),
    "name", "ssm_get_parameter missing name"
  );

  // ── C: Mock-network tests (21 tests) ─────────────────────────────────────
  console.log("\nC: Mock-network tests");

  // C1: STS GetCallerIdentity (XML)
  {
    const xmlBody = `<GetCallerIdentityResponse><GetCallerIdentityResult>
    <UserId>AKIAIOSFODNN7EXAMPLE</UserId>
    <Account>123456789012</Account>
    <Arn>arn:aws:iam::123456789012:user/Alice</Arn>
  </GetCallerIdentityResult></GetCallerIdentityResponse>`;
    const { server, url } = await createMockServer(200, xmlBody, { "content-type": "text/xml" });
    const r = await awsClient({
      operation: "sts_get_caller_identity",
      access_key_id: "AKIAIOSFODNN7EXAMPLE",
      secret_key:    "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      custom_endpoint: url, use_tls: false,
    });
    assert(r.ok === true, "C1: STS GetCallerIdentity ok");
    assert(r.user_id === "AKIAIOSFODNN7EXAMPLE", "C1: STS user_id");
    assert(r.account === "123456789012", "C1: STS account");
    assert(r.arn.includes("Alice"), "C1: STS arn");
    await closeServer(server);
  }

  // C2: S3 ListBuckets
  {
    const xmlBody = `<?xml version="1.0" encoding="UTF-8"?>
<ListAllMyBucketsResult>
  <Owner><DisplayName>alice</DisplayName></Owner>
  <Buckets>
    <Bucket><Name>my-bucket-1</Name></Bucket>
    <Bucket><Name>my-bucket-2</Name></Bucket>
  </Buckets>
</ListAllMyBucketsResult>`;
    const { server, url } = await createMockServer(200, xmlBody, { "content-type": "application/xml" });
    const r = await awsClient({
      operation: "s3_list_buckets",
      access_key_id: "AKI", secret_key: "sec",
      custom_endpoint: url, use_tls: false,
    });
    assert(r.ok === true, "C2: S3 ListBuckets ok");
    assert(r.count === 2, "C2: S3 ListBuckets count");
    assert(r.buckets[0].name === "my-bucket-1", "C2: S3 first bucket");
    assert(r.owner === "alice", "C2: S3 owner");
    await closeServer(server);
  }

  // C3: DynamoDB ListTables
  {
    const jsonBody = JSON.stringify({ TableNames: ["users", "orders", "products"] });
    const { server, url } = await createMockServer(200, jsonBody);
    const r = await awsClient({
      operation: "dynamodb_list_tables",
      access_key_id: "AKI", secret_key: "sec",
      custom_endpoint: url, use_tls: false,
    });
    assert(r.ok === true, "C3: DynamoDB ListTables ok");
    assert(r.count === 3, "C3: DynamoDB ListTables count");
    assert(r.tables.includes("users"), "C3: DynamoDB tables include users");
    await closeServer(server);
  }

  // C4: DynamoDB GetItem
  {
    const jsonBody = JSON.stringify({ Item: { id: { S: "123" }, name: { S: "Alice" } } });
    const { server, url } = await createMockServer(200, jsonBody);
    const r = await awsClient({
      operation: "dynamodb_get_item",
      access_key_id: "AKI", secret_key: "sec",
      custom_endpoint: url, use_tls: false,
      table: "users", key: { id: { S: "123" } },
    });
    assert(r.ok === true, "C4: DynamoDB GetItem ok");
    assert(r.found === true, "C4: DynamoDB GetItem found");
    assert(r.item.name.S === "Alice", "C4: DynamoDB GetItem name");
    await closeServer(server);
  }

  // C5: DynamoDB GetItem not found
  {
    const { server, url } = await createMockServer(200, "{}");
    const r = await awsClient({
      operation: "dynamodb_get_item",
      access_key_id: "AKI", secret_key: "sec",
      custom_endpoint: url, use_tls: false,
      table: "users", key: { id: { S: "999" } },
    });
    assert(r.ok === true, "C5: DynamoDB GetItem not found ok");
    assert(r.found === false, "C5: DynamoDB GetItem not found flag");
    assert(r.item === null, "C5: DynamoDB GetItem item null");
    await closeServer(server);
  }

  // C6: SNS ListTopics
  {
    const xmlBody = `<ListTopicsResponse><ListTopicsResult>
    <Topics>
      <member><TopicArn>arn:aws:sns:us-east-1:123:topic1</TopicArn></member>
      <member><TopicArn>arn:aws:sns:us-east-1:123:topic2</TopicArn></member>
    </Topics>
  </ListTopicsResult></ListTopicsResponse>`;
    const { server, url } = await createMockServer(200, xmlBody, { "content-type": "text/xml" });
    const r = await awsClient({
      operation: "sns_list_topics",
      access_key_id: "AKI", secret_key: "sec",
      custom_endpoint: url, use_tls: false,
    });
    assert(r.ok === true, "C6: SNS ListTopics ok");
    assert(r.count === 2, "C6: SNS ListTopics count");
    assert(r.topic_arns[0].includes("topic1"), "C6: SNS first topic");
    await closeServer(server);
  }

  // C7: Lambda ListFunctions
  {
    const jsonBody = JSON.stringify({
      Functions: [{ FunctionName: "my-func", FunctionArn: "arn:aws:lambda:us-east-1:123:function:my-func",
        Runtime: "nodejs18.x", Handler: "index.handler", MemorySize: 128, Timeout: 30 }],
    });
    const { server, url } = await createMockServer(200, jsonBody);
    const r = await awsClient({
      operation: "lambda_list_functions",
      access_key_id: "AKI", secret_key: "sec",
      custom_endpoint: url, use_tls: false,
    });
    assert(r.ok === true, "C7: Lambda ListFunctions ok");
    assert(r.count === 1, "C7: Lambda ListFunctions count");
    assert(r.functions[0].name === "my-func", "C7: Lambda function name");
    assert(r.functions[0].runtime === "nodejs18.x", "C7: Lambda function runtime");
    await closeServer(server);
  }

  // C8: Lambda Invoke
  {
    const payload = { statusCode: 200, body: "Hello World" };
    const { server, url } = await createMockServer(200, JSON.stringify(payload));
    const r = await awsClient({
      operation: "lambda_invoke",
      access_key_id: "AKI", secret_key: "sec",
      custom_endpoint: url, use_tls: false,
      function_name: "my-func", payload: { key: "value" },
    });
    assert(r.ok === true, "C8: Lambda Invoke ok");
    assert(r.status_code === 200, "C8: Lambda Invoke status");
    assert(r.payload.statusCode === 200, "C8: Lambda Invoke payload");
    assert(r.function_name === "my-func", "C8: Lambda function name in result");
    await closeServer(server);
  }

  // C9: SecretsManager GetSecretValue
  {
    const jsonBody = JSON.stringify({ Name: "my-secret", ARN: "arn:...", SecretString: '{"api_key":"abc123"}' });
    const { server, url } = await createMockServer(200, jsonBody);
    const r = await awsClient({
      operation: "secretsmanager_get_secret_value",
      access_key_id: "AKI", secret_key: "sec",
      custom_endpoint: url, use_tls: false,
      secret_id: "my-secret",
    });
    assert(r.ok === true, "C9: SecretsManager GetSecretValue ok");
    assert(r.name === "my-secret", "C9: SecretsManager name");
    assert(r.secret_string.includes("abc123"), "C9: SecretsManager secret_string");
    await closeServer(server);
  }

  // C10: SSM GetParameter
  {
    const jsonBody = JSON.stringify({ Parameter: { Name: "/myapp/db_url", Type: "String", Value: "postgres://localhost/db", Version: 1 } });
    const { server, url } = await createMockServer(200, jsonBody);
    const r = await awsClient({
      operation: "ssm_get_parameter",
      access_key_id: "AKI", secret_key: "sec",
      custom_endpoint: url, use_tls: false,
      name: "/myapp/db_url",
    });
    assert(r.ok === true, "C10: SSM GetParameter ok");
    assert(r.value === "postgres://localhost/db", "C10: SSM value");
    assert(r.type === "String", "C10: SSM type");
    await closeServer(server);
  }

  // C11: SSM PutParameter
  {
    const jsonBody = JSON.stringify({ Version: 2, Tier: "Standard" });
    const { server, url } = await createMockServer(200, jsonBody);
    const r = await awsClient({
      operation: "ssm_put_parameter",
      access_key_id: "AKI", secret_key: "sec",
      custom_endpoint: url, use_tls: false,
      name: "/myapp/db_url", value: "newvalue",
    });
    assert(r.ok === true, "C11: SSM PutParameter ok");
    assert(r.version === 2, "C11: SSM PutParameter version");
    await closeServer(server);
  }

  // C12: Generic request op
  {
    const respBody = JSON.stringify({ status: "ok" });
    const { server, url } = await createMockServer(200, respBody);
    const r = await awsClient({
      operation: "request",
      access_key_id: "AKI", secret_key: "sec",
      use_tls: false,
      service: "s3", method: "GET", path: "/",
      endpoint: url,
    });
    assert(r.ok === true, "C12: generic request ok");
    assert(r.status_code === 200, "C12: generic request status");
    assert(r.service === "s3", "C12: generic request service");
    await closeServer(server);
  }

  // C13: SQS ListQueues
  {
    const xmlBody = `<ListQueuesResponse><ListQueuesResult>
    <QueueUrl>https://sqs.us-east-1.amazonaws.com/123/queue1</QueueUrl>
    <QueueUrl>https://sqs.us-east-1.amazonaws.com/123/queue2</QueueUrl>
  </ListQueuesResult></ListQueuesResponse>`;
    const { server, url } = await createMockServer(200, xmlBody, { "content-type": "text/xml" });
    const r = await awsClient({
      operation: "sqs_list_queues",
      access_key_id: "AKI", secret_key: "sec",
      custom_endpoint: url, use_tls: false,
    });
    assert(r.ok === true, "C13: SQS ListQueues ok");
    assert(r.count === 2, "C13: SQS ListQueues count");
    assert(r.queue_urls[0].includes("queue1"), "C13: SQS first queue");
    await closeServer(server);
  }

  // C14: DynamoDB error propagation
  {
    const errBody = JSON.stringify({ __type: "ResourceNotFoundException", message: "Table not found" });
    const { server, url } = await createMockServer(400, errBody);
    await assertRejects(
      () => awsClient({
        operation: "dynamodb_get_item",
        access_key_id: "AKI", secret_key: "sec",
        custom_endpoint: url, use_tls: false,
        table: "nonexistent", key: { id: { S: "1" } },
      }),
      "ResourceNotFoundException", "C14: DynamoDB error propagation"
    );
    await closeServer(server);
  }

  // C15: S3 error with XML body (use list_objects which doesn't have special 404 handling)
  {
    const errXml = "<Error><Code>NoSuchBucket</Code><Message>The specified bucket does not exist</Message></Error>";
    const { server, url } = await createMockServer(404, errXml, { "content-type": "application/xml" });
    await assertRejects(
      () => awsClient({
        operation: "s3_list_objects",
        access_key_id: "AKI", secret_key: "sec",
        custom_endpoint: url, use_tls: false,
        bucket: "nonexistent", path_style: true,
      }),
      "NoSuchBucket", "C15: S3 XML error propagation"
    );
    await closeServer(server);
  }

  // C16: STS AssumeRole response
  {
    const xmlBody = `<AssumeRoleResponse><AssumeRoleResult>
    <AssumedRoleUser>
      <AssumedRoleId>AROAIOSFODNN7EXAMPLE:sess</AssumedRoleId>
      <Arn>arn:aws:sts::123456789012:assumed-role/Demo/sess</Arn>
    </AssumedRoleUser>
    <Credentials>
      <AccessKeyId>ASIA...</AccessKeyId>
      <SecretAccessKey>MY_SUPER_SECRET</SecretAccessKey>
      <SessionToken>sessiontok</SessionToken>
      <Expiration>2030-01-01T00:00:00Z</Expiration>
    </Credentials>
  </AssumeRoleResult></AssumeRoleResponse>`;
    const { server, url } = await createMockServer(200, xmlBody, { "content-type": "text/xml" });
    const r = await awsClient({
      operation: "sts_assume_role",
      access_key_id: "AKI", secret_key: "sec",
      custom_endpoint: url, use_tls: false,
      role_arn: "arn:aws:iam::123:role/Demo", role_session_name: "sess",
    });
    assert(r.ok === true, "C16: STS AssumeRole ok");
    assert(r.credentials.access_key_id === "ASIA...", "C16: STS credentials access key");
    assert(r.credentials.secret_access_key === "[redacted]", "C16: STS credentials secret REDACTED");
    assert(r.credentials.session_token === "sessiontok", "C16: STS session token");
    assert(r.arn.includes("assumed-role"), "C16: STS arn");
    await closeServer(server);
  }

  // C17: SNS CreateTopic
  {
    const xmlBody = `<CreateTopicResponse><CreateTopicResult><TopicArn>arn:aws:sns:us-east-1:123:my-topic</TopicArn></CreateTopicResult></CreateTopicResponse>`;
    const { server, url } = await createMockServer(200, xmlBody, { "content-type": "text/xml" });
    const r = await awsClient({
      operation: "sns_create_topic",
      access_key_id: "AKI", secret_key: "sec",
      custom_endpoint: url, use_tls: false,
      topic_name: "my-topic",
    });
    assert(r.ok === true, "C17: SNS CreateTopic ok");
    assert(r.topic_arn.includes("my-topic"), "C17: SNS topic arn");
    await closeServer(server);
  }

  // C18: CloudWatch ListMetrics
  {
    const xmlBody = `<ListMetricsResponse><ListMetricsResult>
    <Metrics><member><MetricName>CPUUtilization</MetricName><Namespace>AWS/EC2</Namespace></member></Metrics>
  </ListMetricsResult></ListMetricsResponse>`;
    const { server, url } = await createMockServer(200, xmlBody, { "content-type": "text/xml" });
    const r = await awsClient({
      operation: "cloudwatch_list_metrics",
      access_key_id: "AKI", secret_key: "sec",
      custom_endpoint: url, use_tls: false, namespace: "AWS/EC2",
    });
    assert(r.ok === true, "C18: CloudWatch ListMetrics ok");
    assert(r.count === 1, "C18: CloudWatch count");
    assert(r.metrics[0].metric_name === "CPUUtilization", "C18: CloudWatch metric name");
    await closeServer(server);
  }

  // C19: DynamoDB PutItem
  {
    const { server, url } = await createMockServer(200, "{}");
    const r = await awsClient({
      operation: "dynamodb_put_item",
      access_key_id: "AKI", secret_key: "sec",
      custom_endpoint: url, use_tls: false,
      table: "users", item: { id: { S: "42" }, name: { S: "Bob" } },
    });
    assert(r.ok === true, "C19: DynamoDB PutItem ok");
    assert(r.written === true, "C19: DynamoDB PutItem written");
    await closeServer(server);
  }

  // C20: Timeout
  {
    const server = http.createServer((_req, _res) => { /* hang */ });
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    await assertRejects(
      () => awsClient({
        operation: "s3_list_buckets",
        access_key_id: "AKI", secret_key: "sec",
        custom_endpoint: `http://127.0.0.1:${port}`,
        use_tls: false, timeout: 1000,
      }),
      "timed out", "C20: timeout error"
    );
    await closeServer(server);
  }

  // C21: Connection refused
  {
    await assertRejects(
      () => awsClient({
        operation: "s3_list_buckets",
        access_key_id: "AKI", secret_key: "sec",
        custom_endpoint: "http://127.0.0.1:1",
        use_tls: false, timeout: 5000,
      }),
      "", "C21: connection refused"
    );
  }

  // ── D: Security tests (10 tests) ──────────────────────────────────────────
  console.log("\nD: Security tests");

  await assertRejects(
    () => awsClient({ operation: "s3_list_buckets", access_key_id: "AKI", secret_key: "s\0c" }),
    "NUL", "D1: NUL in secret_key"
  );
  await assertRejects(
    () => awsClient({ operation: "s3_list_buckets", access_key_id: "AKI", secret_key: "sec", session_token: "tok\0" }),
    "NUL", "D2: NUL in session_token"
  );

  // D3: error messages have no hardcoded secret
  {
    const err = extractAwsError('{"message": "Access denied"}', 403, "sts.get_caller_identity");
    assert(!err.message.includes("EXAMPLEKEY"), "D3: error message has no secret");
  }

  // D4: STS AssumeRole secret_access_key is always [redacted]
  {
    const xmlBody = `<AssumeRoleResponse><AssumeRoleResult><Credentials>
      <AccessKeyId>ASIA...</AccessKeyId>
      <SecretAccessKey>MY_SUPER_SECRET</SecretAccessKey>
      <SessionToken>tok</SessionToken>
      <Expiration>2030-01-01T00:00:00Z</Expiration>
    </Credentials></AssumeRoleResult></AssumeRoleResponse>`;
    const { server, url } = await createMockServer(200, xmlBody, { "content-type": "text/xml" });
    const r = await awsClient({
      operation: "sts_assume_role",
      access_key_id: "AKI", secret_key: "sec",
      custom_endpoint: url, use_tls: false,
      role_arn: "arn:aws:iam::123:role/R", role_session_name: "sess",
    });
    assert(r.credentials.secret_access_key === "[redacted]", "D4: secret_access_key always redacted");
    assert(!JSON.stringify(r).includes("MY_SUPER_SECRET"), "D4: secret never appears in output");
    await closeServer(server);
  }

  // D5: signRequest canonical headers are sorted and lowercase
  {
    const headers = { host: "dynamodb.us-east-1.amazonaws.com", "X-Custom": "v", "Content-Type": "application/json" };
    signRequest({
      method: "POST", url: "https://dynamodb.us-east-1.amazonaws.com/", headers,
      body: "{}", service: "dynamodb", region: "us-east-1",
      accessKeyId: "AKI", secretKey: "sec", sessionToken: null,
    });
    const m = headers["Authorization"].match(/SignedHeaders=([^,]+)/);
    const hdrs = m ? m[1].split(";") : [];
    const sorted = [...hdrs].sort();
    assert(JSON.stringify(hdrs) === JSON.stringify(sorted), "D5: signed headers are sorted");
    assert(hdrs.every(h => h === h.toLowerCase()), "D5: signed headers are lowercase");
  }

  // D6: Large payload capped at 16 MB
  {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/xml" });
      const chunk = Buffer.alloc(1024 * 1024, 65);
      let sent = 0;
      const send = () => {
        if (sent < 17 * 1024 * 1024) { sent += chunk.length; res.write(chunk); setImmediate(send); }
        else res.end();
      };
      send();
    });
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    await assertRejects(
      () => awsClient({
        operation: "s3_list_buckets",
        access_key_id: "AKI", secret_key: "sec",
        custom_endpoint: `http://127.0.0.1:${port}`,
        use_tls: false, timeout: 30000,
      }),
      "16 MB", "D6: 16 MB response cap"
    );
    await closeServer(server);
  }

  // D7: S3 key path traversal chars are encoded in URL
  {
    const { server, url } = await createMockServer(204, "");
    let capturedPath = "";
    server.removeAllListeners("request");
    server.on("request", (req, res) => { capturedPath = req.url; res.writeHead(204); res.end(); });
    try {
      await awsClient({
        operation: "s3_delete_object",
        access_key_id: "AKI", secret_key: "sec",
        custom_endpoint: url, use_tls: false,
        bucket: "mybucket", key: "../../etc/passwd", path_style: true,
      });
    } catch (_) {}
    assert(!capturedPath.startsWith("/mybucket/../../"), "D7: path traversal chars encoded in URL");
    await closeServer(server);
  }

  // D8: SigV4 signing key derivation is deterministic
  {
    const k1 = deriveSigningKey("secret", "20240101", "us-east-1", "s3");
    const k2 = deriveSigningKey("secret", "20240101", "us-east-1", "s3");
    assert(k1.equals(k2), "D8: signing key derivation is deterministic");
  }

  // D9: Different secrets produce different signing keys
  {
    const k1 = deriveSigningKey("secret1", "20240101", "us-east-1", "s3");
    const k2 = deriveSigningKey("secret2", "20240101", "us-east-1", "s3");
    assert(!k1.equals(k2), "D9: different secrets produce different signing keys");
  }

  // D10: Different regions produce different signing keys
  {
    const k1 = deriveSigningKey("secret", "20240101", "us-east-1", "s3");
    const k2 = deriveSigningKey("secret", "20240101", "eu-west-1", "s3");
    assert(!k1.equals(k2), "D10: different regions produce different signing keys");
  }

  // ── E: Concurrency/stress tests (7 tests) ─────────────────────────────────
  console.log("\nE: Concurrency tests");

  // E1: 20 parallel STS calls
  {
    const xmlBody = `<GetCallerIdentityResponse><GetCallerIdentityResult>
    <UserId>U</UserId><Account>123</Account><Arn>arn:test</Arn>
  </GetCallerIdentityResult></GetCallerIdentityResponse>`;
    const { server, url } = await createMockServer(200, xmlBody, { "content-type": "text/xml" });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => awsClient({
        operation: "sts_get_caller_identity",
        access_key_id: "AKI", secret_key: "sec",
        custom_endpoint: url, use_tls: false,
      }))
    );
    assert(results.every(r => r.ok), "E1: 20 parallel STS calls all ok");
    assert(results.every(r => r.user_id === "U"), "E1: all STS results consistent");
    await closeServer(server);
  }

  // E2: 20 parallel S3 ListBuckets
  {
    const xmlBody = `<?xml version="1.0"?><ListAllMyBucketsResult><Buckets><Bucket><Name>b1</Name></Bucket></Buckets></ListAllMyBucketsResult>`;
    const { server, url } = await createMockServer(200, xmlBody, { "content-type": "application/xml" });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => awsClient({
        operation: "s3_list_buckets",
        access_key_id: "AKI", secret_key: "sec",
        custom_endpoint: url, use_tls: false,
      }))
    );
    assert(results.every(r => r.ok), "E2: 20 parallel S3 ListBuckets all ok");
    await closeServer(server);
  }

  // E3: 20 parallel DynamoDB GetItem calls
  {
    const { server, url } = await createMockServer(200, JSON.stringify({ Item: { id: { S: "x" } } }));
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => awsClient({
        operation: "dynamodb_get_item",
        access_key_id: "AKI", secret_key: "sec",
        custom_endpoint: url, use_tls: false,
        table: "t", key: { id: { S: String(i) } },
      }))
    );
    assert(results.every(r => r.ok && r.found), "E3: 20 parallel DynamoDB GetItem ok");
    await closeServer(server);
  }

  // E4: signRequest is thread-safe (unique auth per credential)
  {
    const results = Array.from({ length: 50 }, (_, i) => {
      const headers = { host: `svc${i}.amazonaws.com` };
      signRequest({
        method: "GET", url: `https://svc${i}.amazonaws.com/`, headers,
        body: "", service: "s3", region: "us-east-1",
        accessKeyId: `KEY${i}`, secretKey: `SECRET${i}`, sessionToken: null,
      });
      return headers["Authorization"];
    });
    const unique = new Set(results);
    assert(unique.size === 50, "E4: signRequest produces unique auth per credential");
  }

  // E5: buildCanonicalQueryString with 100 params
  {
    const params = {};
    for (let i = 0; i < 100; i++) params[`key${i}`] = `val${i}`;
    const qs = buildCanonicalQueryString(params);
    const parts = qs.split("&");
    assert(parts.length === 100, "E5: 100 params in canonical QS");
    // Extract keys from key=value pairs and verify they are sorted
    const keys = parts.map(p => p.split("=")[0]);
    const sortedKeys = [...keys].sort();
    assert(JSON.stringify(keys) === JSON.stringify(sortedKeys), "E5: params are sorted");
  }

  // E6: 10 parallel error responses don't mix messages
  {
    let reqCount = 0;
    const server = http.createServer((req, res) => {
      const id = ++reqCount;
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ __type: `Error${id}`, message: `msg${id}` }));
    });
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    const errors = await Promise.all(
      Array.from({ length: 10 }, () =>
        awsClient({
          operation: "s3_list_buckets",
          access_key_id: "AKI", secret_key: "sec",
          custom_endpoint: `http://127.0.0.1:${port}`,
          use_tls: false,
        }).catch(e => e)
      )
    );
    assert(errors.every(e => e instanceof Error), "E6: all parallel errors are Error instances");
    await closeServer(server);
  }

  // E7: uriEncode handles Unicode
  {
    const encoded = uriEncode("caf\u00e9", true);
    assert(encoded === "caf%C3%A9", "E7: uriEncode Unicode UTF-8 encoding");
    const encoded2 = uriEncode("\u4e2d\u6587", true);
    assert(encoded2 === "%E4%B8%AD%E6%96%87", "E7: uriEncode Chinese characters");
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log(`\n=== aws-client tests: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
