"use strict";
const fs = require('fs');
const p = 'lib/dispatchScan3.js';
let c = fs.readFileSync(p, 'utf8');

const newHandlers = `
  find_deprecated_html_elements(args) {
    const { resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || ".";
    return findDeprecatedHtmlElements(resolved, origPath, {
      extensions: args.extensions,
      maxResults: args.max_results,
    });
  },

  find_eval_usage(args) {
    const { resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || ".";
    return findEvalUsage(resolved, origPath, {
      extensions: args.extensions,
      maxResults: args.max_results,
    });
  },

`;

// Insert before the closing of SCAN_DISPATCH_3
// The end is:  ...  },\n\n};\r\n\r\nmodule.exports
const endMarker = /\n};[\r\n]+module\.exports = \{ SCAN_DISPATCH_3 \};/;
if (endMarker.test(c)) {
  c = c.replace(endMarker, newHandlers + '};\r\n\r\nmodule.exports = { SCAN_DISPATCH_3 };\r\n');
  fs.writeFileSync(p, c);
  console.log('Added handlers. New size:', c.length);
} else {
  console.log('End marker not found!');
  // Show last 200 chars
  console.log('Last 200:', JSON.stringify(c.slice(-200)));
}
