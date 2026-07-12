"use strict";
const fs = require('fs');
let src = fs.readFileSync('lib/kafkaClientOps.js', 'utf8');

// Fix writeInt64: both hi and lo words must use writeUInt32BE
// hi | 0 gives a signed int32 but writeInt32BE expects -2147483648..2147483647
// writeUInt32BE handles the full 0..4294967295 range
src = src.replace(
  'buf.writeInt32BE(hi >>> 0, offset);',
  'buf.writeUInt32BE(hi >>> 0, offset);'
);

if (!src.includes('buf.writeUInt32BE(hi >>> 0, offset);')) {
  console.error('Fix failed!');
  process.exit(1);
}

// Fix guardTopicName: check NUL and CRLF explicitly BEFORE the regex,
// so the error message says 'NUL' or 'CRLF' rather than 'invalid topic name'
const oldGuard = `function guardTopicName(topic) {
  if (typeof topic !== "string" || topic.length === 0)
    throw new Error("kafka_client: 'topic' must be a non-empty string");
  if (!/^[a-zA-Z0-9.\\-]+$/.test(topic))
    throw new Error(\`kafka_client: invalid topic name '\${topic}'. Only letters, digits, '.', '_', '-' are allowed\`);
  if (topic.length > 249)
    throw new Error("kafka_client: topic name exceeds 249 character limit");
}`;

const newGuard = `function guardTopicName(topic) {
  if (typeof topic !== "string" || topic.length === 0)
    throw new Error("kafka_client: 'topic' must be a non-empty string");
  if (topic.includes("\\x00"))
    throw new Error(\`kafka_client: topic name must not contain NUL bytes\`);
  if (topic.includes("\\r") || topic.includes("\\n"))
    throw new Error(\`kafka_client: topic name must not contain CRLF characters\`);
  if (!/^[a-zA-Z0-9._\\-]+$/.test(topic))
    throw new Error(\`kafka_client: invalid topic name '\${topic}'. Only letters, digits, '.', '_', '-' are allowed\`);
  if (topic.length > 249)
    throw new Error("kafka_client: topic name exceeds 249 character limit");
}`;

// Find the actual guard function text
const guardIdx = src.indexOf('function guardTopicName(topic)');
if (guardIdx < 0) { console.error('guardTopicName not found'); process.exit(1); }
const endIdx = src.indexOf('\n}', guardIdx) + 2;
const existingGuard = src.slice(guardIdx, endIdx);
console.log('Existing guard:', JSON.stringify(existingGuard));
src = src.slice(0, guardIdx) + newGuard + src.slice(endIdx);

console.log('Fix2 OK:', src.includes('NUL bytes'));

fs.writeFileSync('lib/kafkaClientOps.js', src);
console.log('Written.');
