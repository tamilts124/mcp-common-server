"use strict";
const { spawnSync } = require('child_process');
const result = spawnSync('node', ['test/sections/246-cassandra-client.js'], {
  cwd: 'D:\\ClaudeDir\\mcp-common-server',
  timeout: 120000,
  encoding: 'utf8',
});
const fs = require('fs');
fs.writeFileSync('D:\\ClaudeDir\\mcp-common-server\\tmp\\test246_out.txt',
  'EXIT:' + result.status + '\nSTDOUT:\n' + (result.stdout||'') + '\nSTDERR:\n' + (result.stderr||''));
