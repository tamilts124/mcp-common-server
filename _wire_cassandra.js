"use strict";
const fs = require('fs');

// 1. Wire utilSchemas.js
let s = fs.readFileSync('lib/schemas/utilSchemas.js', 'utf8');
const NEEDLE1 = 'const { MONGODB_CLIENT_SCHEMA } = require("./utilSchemas78");';
if (s.includes(NEEDLE1) && !s.includes('utilSchemas79')) {
  s = s.replace(NEEDLE1, NEEDLE1 + '\nconst { CASSANDRA_CLIENT_SCHEMA } = require("./utilSchemas79");');
  console.log('schemas: added require');
} else { console.log('schemas: require already present or needle not found'); }
if (!s.includes('CASSANDRA_CLIENT_SCHEMA]')) {
  s = s.replace(', MONGODB_CLIENT_SCHEMA] };', ', MONGODB_CLIENT_SCHEMA, CASSANDRA_CLIENT_SCHEMA] };');
  console.log('schemas: added to exports');
} else { console.log('schemas: already in exports'); }
fs.writeFileSync('lib/schemas/utilSchemas.js', s);

// 2. Wire dispatchRead.js
let d = fs.readFileSync('lib/dispatchRead.js', 'utf8');
const DN1 = 'const { mongodbClient }       = require("./mongodbClientOps");';
if (d.includes(DN1) && !d.includes('cassandraClientOps')) {
  d = d.replace(DN1, DN1 + '\nconst { cassandraClient }     = require("./cassandraClientOps");');
  console.log('dispatch: added require');
} else { console.log('dispatch: require already present, dn1found=', d.includes(DN1)); }
const MONGO_HANDLER_CRLF = 'return mongodbClient(args);\r\n  },';
const MONGO_HANDLER_LF   = 'return mongodbClient(args);\n  },';
const CASSANDRA_HANDLER = '\n\n  cassandra_client(args) {\n    // Async -- callers in executeTool.js must await the result.\n    return cassandraClient(args);\n  },';
if (!d.includes('cassandra_client')) {
  if (d.includes(MONGO_HANDLER_CRLF)) {
    d = d.replace(MONGO_HANDLER_CRLF, MONGO_HANDLER_CRLF + CASSANDRA_HANDLER);
    console.log('dispatch: added handler (CRLF)');
  } else if (d.includes(MONGO_HANDLER_LF)) {
    d = d.replace(MONGO_HANDLER_LF, MONGO_HANDLER_LF + CASSANDRA_HANDLER);
    console.log('dispatch: added handler (LF)');
  } else { console.log('dispatch: mongo handler not found, hasCRLF=', d.includes('\r\n')); }
} else { console.log('dispatch: cassandra_client already present'); }
fs.writeFileSync('lib/dispatchRead.js', d);
console.log('ALL DONE');
