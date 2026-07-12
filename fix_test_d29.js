"use strict";
const fs = require('fs');
let src = fs.readFileSync('test/sections/200-kafka-client.js', 'utf8');
// D29: TOPIC_ALREADY_EXISTS is code 39, not 36
src = src.replace(
  `const buf = buildCreateTopicsResponse(0, [{ name: "t", errorCode: 36, errorMessage: null }]).slice(8);`,
  `const buf = buildCreateTopicsResponse(0, [{ name: "t", errorCode: 39, errorMessage: null }]).slice(8);`
);
if (!src.includes('errorCode: 39')) { console.error('D29 fix failed'); process.exit(1); }
fs.writeFileSync('test/sections/200-kafka-client.js', src);
console.log('D29 fixed.');
