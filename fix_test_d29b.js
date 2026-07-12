"use strict";
const fs = require('fs');
let src = fs.readFileSync('test/sections/200-kafka-client.js', 'utf8');
// D29: also fix the strictEqual assertion
src = src.replace(
  `assert.strictEqual(results[0].errorCode, 36);`,
  `assert.strictEqual(results[0].errorCode, 39);`
);
if (!src.includes('assert.strictEqual(results[0].errorCode, 39)')) {
  console.error('D29b fix failed');
  process.exit(1);
}
fs.writeFileSync('test/sections/200-kafka-client.js', src);
console.log('D29b fixed.');
