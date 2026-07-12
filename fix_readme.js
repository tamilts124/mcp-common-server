"use strict";
const fs = require('fs');
let src = fs.readFileSync('README.md', 'utf8');

// Update tool counts
src = src.replace('**273 tools**', '**274 tools**');
src = src.replace('| 7 | Network & Messaging | 18 |', '| 7 | Network & Messaging | 19 |');
src = src.replace('| | **Total** | **273** |', '| | **Total** | **274** |');

// Add kafka_client to the Network & Messaging tool list
src = src.replace(
  '`snmp_client`, `ftp_client`, `amqp_client`, `stomp_client`, `ldap_client`, `nats_client`',
  '`snmp_client`, `ftp_client`, `kafka_client`, `amqp_client`, `stomp_client`, `ldap_client`, `nats_client`'
);

console.log('274 tools:', src.includes('**274 tools**'));
console.log('Network 19:', src.includes('Network & Messaging | 19'));
console.log('kafka_client listed:', src.includes('kafka_client'));

fs.writeFileSync('README.md', src);
console.log('README.md updated.');
