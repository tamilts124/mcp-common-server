const { execSync } = require('child_process');
try {
  const out = execSync('node test/sections/196-nats-client.js', { encoding: 'utf8', timeout: 180000 });
  require('fs').writeFileSync('test/sections/196-out.txt', out);
} catch(e) {
  require('fs').writeFileSync('test/sections/196-out.txt', (e.stdout || '') + (e.stderr || '') + '\nEXIT:' + e.status);
}
