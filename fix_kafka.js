"use strict";
const fs = require('fs');
let src = fs.readFileSync('lib/kafkaClientOps.js', 'utf8');

// Fix 1: writeInt64 low word should use writeUInt32BE
src = src.replace(
  'buf.writeInt32BE(lo >>> 0, offset + 4);',
  'buf.writeUInt32BE(lo >>> 0, offset + 4);'
);
if (!src.includes('writeUInt32BE')) {
  // Try with CRLF
  src = src.replace(
    'buf.writeInt32BE(lo >>> 0, offset + 4);',
    'buf.writeUInt32BE(lo >>> 0, offset + 4);'
  );
  console.log('Fix1 result:', src.includes('writeUInt32BE'));
} else {
  console.log('Fix1 OK');
}

// Detect line ending
const hasCRLF = src.includes('\r\n');
console.log('Has CRLF:', hasCRLF);

// Normalize to LF for pattern matching
const norm = src.replace(/\r\n/g, '\n');

const saslEnd = `  if (saslMechanism && saslMechanism !== "PLAIN")
    throw new Error(\`kafka_client: unsupported sasl_mechanism '\${saslMechanism}'. Supported: PLAIN\`);

  const elapsedMs = () => Date.now() - t0;`;

const earlyBlock = `
  // ── Early validation (before opening TCP connection) ───────────────────
  if (operation === "produce" || operation === "fetch" || operation === "list_offsets") {
    const earlyTopic = args.topic;
    if (!earlyTopic) throw new Error(\`kafka_client: 'topic' is required for \${operation}\`);
    guardTopicName(earlyTopic);
  }
  if (operation === "produce") {
    const messages = args.messages;
    if (!Array.isArray(messages) || messages.length === 0)
      throw new Error("kafka_client: 'messages' must be a non-empty array");
    if (messages.length > 1000)
      throw new Error("kafka_client: maximum 1000 messages per produce call");
    for (const msg of messages) {
      if (msg.value == null && msg.key == null)
        throw new Error("kafka_client: each message must have at least 'value' or 'key'");
      const valStr = msg.value != null ? String(msg.value) : "";
      if (Buffer.byteLength(valStr, 'utf8') > MAX_MESSAGE_BYTES)
        throw new Error(\`kafka_client: message value exceeds \${MAX_MESSAGE_BYTES} bytes\`);
    }
  }
  if (operation === "create_topics") {
    const topicsSpec = args.topics;
    if (!Array.isArray(topicsSpec) || topicsSpec.length === 0)
      throw new Error("kafka_client: 'topics' must be a non-empty array of {name, num_partitions, replication_factor} objects");
    for (const t of topicsSpec) {
      if (!t.name) throw new Error("kafka_client: each topic spec must have a 'name'");
      guardTopicName(t.name);
    }
  }
  if (operation === "delete_topics") {
    const topicsToDelete = args.topics;
    if (!Array.isArray(topicsToDelete) || topicsToDelete.length === 0)
      throw new Error("kafka_client: 'topics' must be a non-empty array of topic name strings");
    for (const t of topicsToDelete) {
      if (typeof t !== 'string') throw new Error("kafka_client: each topic in 'topics' must be a string");
      guardTopicName(t);
    }
  }
`;

const saslReplacement = `  if (saslMechanism && saslMechanism !== "PLAIN")
    throw new Error(\`kafka_client: unsupported sasl_mechanism '\${saslMechanism}'. Supported: PLAIN\`);
${earlyBlock}
  const elapsedMs = () => Date.now() - t0;`;

if (!norm.includes(saslEnd)) {
  console.error('SASL pattern not found! Dumping context...');
  const idx = norm.indexOf('unsupported sasl_mechanism');
  console.log(JSON.stringify(norm.slice(idx - 10, idx + 200)));
  process.exit(1);
}

const fixed = norm.replace(saslEnd, saslReplacement);
console.log('Fix2 OK:', fixed.includes('Early validation'));

// Restore CRLF if original had it
const out = hasCRLF ? fixed.replace(/\n/g, '\r\n') : fixed;
fs.writeFileSync('lib/kafkaClientOps.js', out);
console.log('Written.');
