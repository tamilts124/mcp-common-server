"use strict";
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const rootDir = path.resolve(__dirname);
const outFile = path.join(rootDir, 'test246_result.txt');

const result = spawnSync(process.execPath, ['test/sections/246-cassandra-client.js'], {
  cwd: rootDir,
  timeout: 90000,
  encoding: 'utf8',
});

fs.writeFileSync(outFile,
  'EXIT:' + result.status + '\n' +
  'SIGNAL:' + (result.signal || '') + '\n' +
  'STDOUT:\n' + (result.stdout || '') +
  '\nSTDERR:\n' + (result.stderr || ''));

console.log('done, exit=' + result.status);
