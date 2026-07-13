"use strict";
// Schema for mongodb_client tool (v4.218.0)
const MONGODB_CLIENT_SCHEMA = {
  name: "mongodb_client",
  description: "Zero-dependency MongoDB Wire Protocol client (pure Node.js net/tls; no npm deps). Connect to any MongoDB 3.6+ or compatible database (Amazon DocumentDB, FerretDB) and perform CRUD, aggregation, and admin operations. Operations (16): info (server version + topology), find (query a collection with filter/projection/sort/skip/limit), find_one (first matching document), insert (single document), insert_many (batch insert), update (single document update/upsert), update_many (multi-document update), delete (single document delete), delete_many (multi-document delete), count (matching document count), aggregate (aggregation pipeline), list_collections (list collections in database), create_collection (create with optional capped/validator), drop_collection (remove collection), create_index (create index with keys/unique/sparse/TTL), list_indexes (list indexes on a collection). Auth: SCRAM-SHA-256 (default) and SCRAM-SHA-1; unauthenticated access supported. Connection: TCP or TLS; URI or host/port/db parameters. Security: 32 MB response cap; NUL-byte guards on uri/host/db/collection; timeout clamped 1-300 s; credentials never appear in error messages.",
  inputSchema: {
    type: "object",
    required: ["operation"],
    properties: {
      operation: {
        type: "string",
        enum: ["info","find","find_one","insert","insert_many","update","update_many",
               "delete","delete_many","count","aggregate","list_collections",
               "create_collection","drop_collection","create_index","list_indexes"],
        description: "Operation to perform. 'info': server version, topology, and connection details. 'find': query documents with optional filter/projection/sort/skip/limit. 'find_one': return first matching document. 'insert': insert a single document. 'insert_many': batch insert multiple documents. 'update': update first matching document (can upsert). 'update_many': update all matching documents. 'delete': delete first matching document. 'delete_many': delete all matching documents. 'count': count matching documents. 'aggregate': run an aggregation pipeline. 'list_collections': list all collections in the database. 'create_collection': create a collection with optional capped/validator settings. 'drop_collection': drop a collection. 'create_index': create an index on a collection. 'list_indexes': list all indexes on a collection.",
      },
      // Connection
      uri: {
        type: "string",
        description: "MongoDB connection URI, e.g. 'mongodb://user:pass@host:27017/mydb'. URI options: tls=true, authSource, authMechanism. Overrides host/port/db/username/password if provided.",
      },
      host: {
        type: "string",
        description: "MongoDB host (default: 'localhost'). Ignored if 'uri' is provided.",
      },
      port: {
        type: "number",
        description: "MongoDB port (default: 27017). Ignored if 'uri' is provided.",
      },
      db: {
        type: "string",
        description: "Database name to use (default: 'test'). Overrides the database in 'uri' if both are provided.",
      },
      // Auth
      username: {
        type: "string",
        description: "Username for SCRAM authentication. Omit for unauthenticated access.",
      },
      password: {
        type: "string",
        description: "Password for SCRAM authentication.",
      },
      auth_db: {
        type: "string",
        description: "Authentication database (default: 'admin' or the database in the URI authSource option).",
      },
      auth_mechanism: {
        type: "string",
        enum: ["SCRAM-SHA-256","SCRAM-SHA-1"],
        description: "SCRAM authentication mechanism (default: 'SCRAM-SHA-256'). Use 'SCRAM-SHA-1' for older MongoDB versions (<4.0).",
      },
      // TLS
      tls: {
        type: "boolean",
        description: "Connect using TLS/SSL (default: false). For Atlas or TLS-required servers.",
      },
      reject_unauthorized: {
        type: "boolean",
        description: "Reject self-signed TLS certificates (default: true). Set false for self-signed certs.",
      },
      timeout: {
        type: "number",
        description: "Connection + command timeout in milliseconds (default: 30000, range: 1000-300000).",
      },
      // Collection
      collection: {
        type: "string",
        description: "Collection name. Required for: find, find_one, insert, insert_many, update, update_many, delete, delete_many, count, aggregate, create_collection, drop_collection, create_index, list_indexes.",
      },
      // Query
      filter: {
        type: "object",
        description: "MongoDB query filter document. E.g. { age: { $gt: 18 } }, { status: 'active' }. Used by find, find_one, count, update, update_many, delete, delete_many. Defaults to {} (all documents).",
      },
      projection: {
        type: "object",
        description: "Fields to include/exclude in find results. E.g. { name: 1, email: 1, _id: 0 }. Used by find, find_one.",
      },
      sort: {
        type: "object",
        description: "Sort specification for find. E.g. { createdAt: -1 } (descending), { name: 1 } (ascending). Used by find.",
      },
      skip: {
        type: "number",
        description: "Number of documents to skip (find). Default: 0.",
      },
      limit: {
        type: "number",
        description: "Maximum documents to return (find). Default: 100; hard cap: 10,000.",
      },
      hint: {
        type: "object",
        description: "Index hint for find/find_one. E.g. { _id: 1 } or { indexName: 1 }.",
      },
      // Write
      document: {
        type: "object",
        description: "Document to insert (insert operation). Required for 'insert'.",
      },
      documents: {
        type: "array",
        items: { type: "object" },
        description: "Array of documents to insert (insert_many). Required for 'insert_many'. Must be non-empty.",
      },
      ordered: {
        type: "boolean",
        description: "For insert_many: stop on first error if true (default: true). Set false for unordered bulk insert.",
      },
      update: {
        type: "object",
        description: "Update specification (update/update_many). Required. E.g. { $set: { name: 'Alice' } }, { $inc: { count: 1 } }, or a full replacement document.",
      },
      upsert: {
        type: "boolean",
        description: "For update/update_many: insert the document if no match is found (default: false).",
      },
      // Aggregation
      pipeline: {
        type: "array",
        description: "Aggregation pipeline stages (aggregate). Required for 'aggregate'. E.g. [{ $match: { status: 'active' } }, { $group: { _id: '$city', count: { $sum: 1 } } }].",
        items: { type: "object" },
      },
      batch_size: {
        type: "number",
        description: "Cursor batch size for aggregate (default: 100; hard cap: 10,000).",
      },
      // Collection management
      capped: {
        type: "boolean",
        description: "Create a capped collection (create_collection). Requires 'size'.",
      },
      size: {
        type: "number",
        description: "Maximum size in bytes for a capped collection (create_collection).",
      },
      max: {
        type: "number",
        description: "Maximum number of documents in a capped collection (create_collection, optional).",
      },
      validator: {
        type: "object",
        description: "Schema validation expression (create_collection). E.g. { $jsonSchema: { required: ['name'], properties: { name: { type: 'string' } } } }.",
      },
      name_only: {
        type: "boolean",
        description: "Return only collection names in list_collections (default: true).",
      },
      // Index
      keys: {
        type: "object",
        description: "Index key specification (create_index). Required. E.g. { email: 1 } (ascending), { date: -1 } (descending), { location: '2dsphere' }.",
      },
      name: {
        type: "string",
        description: "Index name (create_index). Auto-generated from keys if omitted.",
      },
      unique: {
        type: "boolean",
        description: "Create a unique index (create_index). Default: false.",
      },
      sparse: {
        type: "boolean",
        description: "Create a sparse index (create_index, only index documents that have the indexed field). Default: false.",
      },
      expire_after_seconds: {
        type: "number",
        description: "TTL index: documents expire after this many seconds (create_index). The indexed field must be a BSON date.",
      },
    },
  },
};

module.exports = { MONGODB_CLIENT_SCHEMA };
