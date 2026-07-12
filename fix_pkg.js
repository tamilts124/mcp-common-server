"use strict";
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = '4.172.0';
pkg.scripts['test:kafka-client'] = 'node test/sections/200-kafka-client.js';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
console.log('Done:', pkg.version, pkg.scripts['test:kafka-client']);
