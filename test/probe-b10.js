const { pcapClient } = require('./lib/pcapClientOps');
const fs = require('fs');
const os = require('os');
const path = require('path');

// What does writeUInt32LE(0xd4c3b2a1) produce on disk?
const probe = Buffer.alloc(4);
probe.writeUInt32LE(0xd4c3b2a1, 0);
console.log('bytes from writeUInt32LE(0xd4c3b2a1):', probe[0].toString(16), probe[1].toString(16), probe[2].toString(16), probe[3].toString(16));
console.log('readUInt32LE result:', probe.readUInt32LE(0).toString(16));

// Now the parser logic - what constant is 0xd4c3b2a1?
// PCAP_MAGIC_BE = 0xd4c3b2a1 means: readUInt32LE(buf) === 0xd4c3b2a1
// => bytes on disk are [a1, b2, c3, d4] when read LE? NO.
// LE order: lowest byte first. 0xd4c3b2a1 stored LE = [a1, b2, c3, d4]
// YES! writeUInt32LE(0xd4c3b2a1) writes [a1, b2, c3, d4]
console.log('writeUInt32LE(0xd4c3b2a1) bytes:', [...probe].map(b=>b.toString(16)).join(' '));
// readUInt32LE([a1,b2,c3,d4]) = a1 + b2*256 + c3*65536 + d4*16777216 = 0xd4c3b2a1 ✓

// So the test is correct: writeUInt32LE(0xd4c3b2a1) is right. Let's make a full file:
const buf = Buffer.alloc(24);
buf.writeUInt32LE(0xd4c3b2a1, 0);
buf.writeUInt16BE(2, 4);
buf.writeUInt16BE(4, 6);
buf.writeInt32BE(0, 8);
buf.writeUInt32BE(0, 12);
buf.writeUInt32BE(65535, 16);
buf.writeUInt32BE(1, 20);
console.log('magic bytes:', [...buf.slice(0,4)].map(b=>b.toString(16)).join(' '));
const tmp = path.join(os.tmpdir(), 'probe-b10.pcap');
fs.writeFileSync(tmp, buf);
try {
  const r = pcapClient({ operation: 'info', path: tmp }, (p) => ({ resolved: path.resolve(p) }));
  console.log('result:', JSON.stringify(r, null, 2));
} catch(e) {
  console.error('ERROR:', e.message);
} finally {
  fs.unlinkSync(tmp);
}
