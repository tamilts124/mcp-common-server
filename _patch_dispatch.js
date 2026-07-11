const fs = require('fs');

// Fix 1: utilSchemas.js - add require for UTIL_SCHEMAS_16 before module.exports
let c = fs.readFileSync('lib/schemas/utilSchemas.js', 'utf8');
const TARGET = 'module.exports = { UTIL_SCHEMAS:';
const idx = c.indexOf(TARGET);
if (idx === -1) { console.error('TARGET not found!'); process.exit(1); }
const hasReq16 = c.includes('UTIL_SCHEMAS_16 } = require');
if (!hasReq16) {
  const insertStr = 'const { UTIL_SCHEMAS_16 } = require("./utilSchemas16");\n';
  c = c.slice(0, idx) + insertStr + c.slice(idx);
  fs.writeFileSync('lib/schemas/utilSchemas.js', c, 'utf8');
  console.log('utilSchemas.js: require added');
} else {
  console.log('utilSchemas.js: already ok');
}

// Fix 2: dispatchRead.js - add multipart_upload + http_serve handlers
let d = fs.readFileSync('lib/dispatchRead.js', 'utf8');
const MARKER = '\n};\n\nmodule.exports = { READ_DISPATCH };';
const didx = d.lastIndexOf(MARKER);
if (didx === -1) {
  // check for CRLF variant
  const altMARKER = '\r\n};\r\n\r\nmodule.exports = { READ_DISPATCH };';
  const didx2 = d.lastIndexOf(altMARKER);
  if (didx2 === -1) {
    console.error('dispatchRead.js: MARKER not found (tried LF and CRLF)');
    // print last 300 bytes as hex for debugging
    const tail = d.slice(-300);
    for (let i=0;i<tail.length;i++) process.stdout.write(tail.charCodeAt(i).toString(16).padStart(2,'0')+' ');
    console.log();
    process.exit(1);
  }
  // use CRLF
  const newHandlers = '\r\n\r\n  multipart_upload(args) {\r\n    // Read file bytes from disk, then delegate to multipartUpload.\r\n    const fileParts = (args.files || []).map(f => {\r\n      const { resolved } = resolveClientPath(f.path);\r\n      return {\r\n        name:        f.name,\r\n        filename:    f.filename || require(\'path\').basename(resolved),\r\n        contentType: f.content_type,\r\n        data:        require(\'fs\').readFileSync(resolved),\r\n      };\r\n    });\r\n    const inlineParts = (args.inline_files || []).map(f => ({\r\n      name:        f.name,\r\n      filename:    f.filename,\r\n      data:        f.data,\r\n      encoding:    f.encoding,\r\n      contentType: f.content_type,\r\n    }));\r\n    return multipartUpload({\r\n      url:         args.url,\r\n      method:      args.method,\r\n      fields:      args.fields,\r\n      files:       fileParts,\r\n      inlineFiles: inlineParts,\r\n      headers:     args.headers,\r\n      timeout:     args.timeout,\r\n    });\r\n  },\r\n\r\n  http_serve(args) {\r\n    return httpServe(args);\r\n  },';
  d = d.slice(0, didx2) + newHandlers + d.slice(didx2);
  fs.writeFileSync('lib/dispatchRead.js', d, 'utf8');
  console.log('dispatchRead.js: handlers added (CRLF path)');
  process.exit(0);
}
if (d.includes('multipart_upload')) {
  console.log('dispatchRead.js: already has handlers');
  process.exit(0);
}
const newHandlers2 = '\n\n  multipart_upload(args) {\n    // Read file bytes from disk, then delegate to multipartUpload.\n    const fileParts = (args.files || []).map(f => {\n      const { resolved } = resolveClientPath(f.path);\n      return {\n        name:        f.name,\n        filename:    f.filename || require(\'path\').basename(resolved),\n        contentType: f.content_type,\n        data:        require(\'fs\').readFileSync(resolved),\n      };\n    });\n    const inlineParts = (args.inline_files || []).map(f => ({\n      name:        f.name,\n      filename:    f.filename,\n      data:        f.data,\n      encoding:    f.encoding,\n      contentType: f.content_type,\n    }));\n    return multipartUpload({\n      url:         args.url,\n      method:      args.method,\n      fields:      args.fields,\n      files:       fileParts,\n      inlineFiles: inlineParts,\n      headers:     args.headers,\n      timeout:     args.timeout,\n    });\n  },\n\n  http_serve(args) {\n    return httpServe(args);\n  },';
d = d.slice(0, didx) + newHandlers2 + d.slice(didx);
fs.writeFileSync('lib/dispatchRead.js', d, 'utf8');
console.log('dispatchRead.js: handlers added (LF path) at index', didx);
