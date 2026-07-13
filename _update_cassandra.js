"use strict";
const fs = require('fs');

// 1. package.json: add test script + bump version
let pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.scripts['test:cassandra-client'] = 'node test/sections/246-cassandra-client.js';
pkg.version = '4.219.0';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
console.log('package.json updated, version=' + pkg.version);

// 2. README.md: bump version in title, update tool count, add cassandra_client
let r = fs.readFileSync('README.md', 'utf8');
// Update total count line
r = r.replace('**437 tools**', '**438 tools**');
// Update Read & File System count from 89 to 90
r = r.replace('| 1 | Read & File System | 89 |', '| 1 | Read & File System | 90 |');
// Update total row (the table shows 434 but README says 437 — align to 438)
r = r.replace('| | **Total** | **434** |', '| | **Total** | **438** |');
// Add cassandra_client after mongodb_client in the tool list
r = r.replace('`mongodb_client`, `semver_compare`', '`mongodb_client`, `cassandra_client`, `semver_compare`');
fs.writeFileSync('README.md', r);
console.log('README.md updated');

console.log('ALL DONE');
