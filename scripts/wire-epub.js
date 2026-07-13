'use strict';
const fs = require('fs');
let content = fs.readFileSync('lib/dispatchRead.js', 'utf8');
// The font_client block ends with },\r\n\r\n}; (CRLF endings)
// We need to insert epub_client before the closing };
const needle = 'font_client(args) {';
const idx = content.lastIndexOf(needle);
if (idx === -1) { process.stderr.write('ERROR: font_client not found\n'); process.exit(1); }
// Find end of this method block: find the closing },
let depth = 0;
let i = content.indexOf('{', idx);
while (i < content.length) {
  if (content[i] === '{') depth++;
  else if (content[i] === '}') { depth--; if (depth === 0) break; }
  i++;
}
// i points to closing }
// Now find the comma after it
let endOfHandler = i + 1; // after }
while (endOfHandler < content.length && content[endOfHandler] === ',') endOfHandler++;
// endOfHandler is now right after the closing },
const insertPt = endOfHandler;
const epubBlock = ',\r\n\r\n  epub_client(args) {\r\n    // Pure sync fs -- no await needed.\r\n    return epubClient(args);\r\n  }';
// But we need to NOT double the comma we're after, so:
// Actually find exact end of '  font_client ... },' and insert after it
const searchClose = content.indexOf('},', content.indexOf('{', idx));
if (searchClose === -1) { process.stderr.write('ERROR: could not find },\n'); process.exit(1); }
const insertAfter = content.indexOf('\n', searchClose) + 1;
const before = content.slice(0, insertAfter);
const after  = content.slice(insertAfter);
const newContent = before + '\r\n  epub_client(args) {\r\n    // Pure sync fs -- no await needed.\r\n    return epubClient(args);\r\n  },\r\n' + after;
fs.writeFileSync('lib/dispatchRead.js', newContent);
process.stderr.write('Done. epub_client inserted at line ~' + (before.split('\n').length) + '\n');
