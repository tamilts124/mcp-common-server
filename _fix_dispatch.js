"use strict";
const fs = require('fs');
const p = 'lib/dispatchScan3.js';
let c = fs.readFileSync(p, 'utf8');
// Remove the stray orphaned line between the requires
const before = c.length;
c = c.replace(/\n  find_deprecated_html_elements\(args\) \{\n/, '\n');
if (c.length !== before) {
  fs.writeFileSync(p, c);
  console.log('Removed stray line. Size: ' + before + ' -> ' + c.length);
} else {
  // Try with CRLF mixed
  const c2 = c.replace(/\r?\n  find_deprecated_html_elements\(args\) \{\r?\n/, '\r\n');
  if (c2.length !== before) {
    fs.writeFileSync(p, c2);
    console.log('Removed stray line (CRLF). Size: ' + before + ' -> ' + c2.length);
  } else {
    console.log('Stray line not found. Checking line 13:');
    const lines = c.split('\n');
    console.log('Line 12:', JSON.stringify(lines[11]));
    console.log('Line 13:', JSON.stringify(lines[12]));
    console.log('Line 14:', JSON.stringify(lines[13]));
  }
}
