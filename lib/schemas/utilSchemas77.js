"use strict";
// Schema for elasticsearch_client tool (v4.217.0)
const ELASTICSEARCH_CLIENT_SCHEMA = {
  name: "elasticsearch_client",
  description: "Zero-dependency Elasticsearch/OpenSearch client (pure Node.js https; no npm deps). Connect to any Elasticsearch 7.x/8.x or OpenSearch 1.x/2.x cluster and perform document CRUD, search, index management, and cluster operations. Operations (12): info (cluster info + version), search (full-text search with DSL query, aggregations, sorting, highlights), get (fetch a document by ID), index (create or update a document), delete (remove a document), create_index (create an index with optional settings/mappings/aliases), delete_index, indices (list indices via _cat/indices), mapping (retrieve index field mappings), bulk (efficient batch index/create/update/delete via _bulk API), count (count matching documents), cluster_health (cluster health status + shard counts). Auth: API key (type='apikey', id+api_key or api_key), Basic (type='basic', username+password), Bearer token (type='bearer', token). Security: 32 MB response cap; NUL-byte guards on url/index/id; timeout clamped 1-300 s; no credentials in error messages.",
  inputSchema: {
    type: "object",
    required: ["operation", "url"],
    properties: {
      operation: {
        type: "string",
        enum: ["info","search","get","index","delete","create_index",
               "delete_index","indices","mapping","bulk","count","cluster_health"],
        description: "Operation to perform. 'info': cluster name, version, and tagline. 'search': DSL query against an index or all indices. 'get': fetch a single document by ID. 'index': create or replace a document (PUT with id, POST without). 'delete': remove a document by ID. 'create_index': create an index with optional settings, mappings, aliases. 'delete_index': delete an index. 'indices': list all indices (_cat/indices). 'mapping': retrieve field mappings for an index. 'bulk': batch index/create/update/delete via _bulk API. 'count': count matching documents. 'cluster_health': cluster health status, shard counts, number of nodes.",
      },
      url: {
        type: "string",
        description: "Base URL of the Elasticsearch/OpenSearch cluster, e.g. 'http://localhost:9200' or 'https://my-cluster.es.io'. No trailing slash needed.",
      },
      auth: {
        type: "object",
        description: "Authentication credentials. Omit for unauthenticated (e.g. local dev). One of: type='apikey' with api_key (and optional id for ES8 format); type='basic' with username+password; type='bearer' with token.",
        properties: {
          type:     { type: "string", enum: ["apikey","basic","bearer"], description: "Auth type." },
          api_key:  { type: "string", description: "API key string (type='apikey'). For ES8 encoded format: provide both id and api_key." },
          id:       { type: "string", description: "API key ID for ES8 format (type='apikey'). Combined with api_key as Base64(id:api_key)." },
          username: { type: "string", description: "Username for Basic auth (type='basic')." },
          password: { type: "string", description: "Password for Basic auth (type='basic'). May be empty." },
          token:    { type: "string", description: "Bearer token string (type='bearer')." },
        },
      },
      timeout: {
        type: "number",
        description: "Request timeout in milliseconds (default: 30000, range: 1000-300000).",
      },
      reject_unauthorized: {
        type: "boolean",
        description: "If false, skip TLS certificate validation (for self-signed certs). Default: true.",
      },
      // Index/doc targeting
      index: {
        type: "string",
        description: "Index name. Required for: get, index, delete, create_index, delete_index, mapping. Optional for search/count (defaults to _all).",
      },
      id: {
        type: "string",
        description: "Document ID. Required for get and delete. Optional for index (omit to auto-generate).",
      },
      // Search params
      query: {
        type: "object",
        description: "Elasticsearch Query DSL object, e.g. { match: { title: 'hello' } } or { match_all: {} }. Used by search and count.",
      },
      size: {
        type: "number",
        description: "Number of hits to return (search). Default: 10.",
      },
      from: {
        type: "number",
        description: "Offset for pagination (search). Default: 0.",
      },
      sort: {
        description: "Sort specification (search). Array of sort objects, e.g. [{ 'date': 'desc' }, '_score']. Or a single sort object.",
      },
      source_includes: {
        type: "array",
        items: { type: "string" },
        description: "Fields to include in _source (search, get). E.g. ['title', 'author']. Supports wildcards: ['metadata.*'].",
      },
      source_excludes: {
        type: "array",
        items: { type: "string" },
        description: "Fields to exclude from _source (search, get). E.g. ['body', '*.large_field'].",
      },
      aggs: {
        type: "object",
        description: "Aggregations DSL (search). E.g. { by_tag: { terms: { field: 'tags', size: 10 } } }.",
      },
      highlight: {
        type: "object",
        description: "Highlighting spec (search). E.g. { fields: { title: {}, body: {} } }.",
      },
      track_total_hits: {
        description: "Set to true to always track total hits accurately (search). Default: ES cluster default.",
      },
      explain: {
        type: "boolean",
        description: "Include score explanation in each hit (search). Default: false.",
      },
      // Document
      document: {
        type: "object",
        description: "Document body to index (index operation). Required for 'index'.",
      },
      pipeline: {
        type: "string",
        description: "Ingest pipeline to process the document through (index operation).",
      },
      refresh: {
        type: "string",
        description: "Refresh policy for write operations (index, delete, bulk): 'true', 'false', 'wait_for'. Default: 'false' (ES cluster default).",
      },
      // Create index
      settings: {
        type: "object",
        description: "Index settings for create_index. E.g. { number_of_shards: 1, number_of_replicas: 1 }.",
      },
      mappings: {
        type: "object",
        description: "Index mappings for create_index. E.g. { properties: { title: { type: 'text' }, date: { type: 'date' } } }.",
      },
      aliases: {
        type: "object",
        description: "Index aliases for create_index. E.g. { my_alias: {} }.",
      },
      // Bulk
      operations: {
        type: "array",
        description: "Bulk operations (bulk operation). Array of objects, each with: action ('index'|'create'|'update'|'delete'), id (optional), index (optional, overrides top-level index), document (for index/create), doc (for update), doc_as_upsert (boolean, for update), script (for update).",
        items: {
          type: "object",
          properties: {
            action:        { type: "string", enum: ["index","create","update","delete"] },
            id:            { type: "string" },
            index:         { type: "string" },
            document:      { type: "object" },
            doc:           { type: "object" },
            doc_as_upsert: { type: "boolean" },
            script:        { type: "object" },
          },
        },
      },
      // Mapping
      field: {
        type: "string",
        description: "Specific field path to fetch from the mapping (mapping operation). Dot-notation for nested fields, e.g. 'user.address.city'. Omit to return all mappings.",
      },
      // Indices
      pattern: {
        type: "string",
        description: "Index name pattern for 'indices' operation. Supports wildcards: 'my-logs-*', 'app_*,system_*'. Default: '*' (all indices).",
      },
      include_hidden: {
        type: "boolean",
        description: "Include hidden/system indices (starting with .) in 'indices' listing. Default: false.",
      },
      // Cluster health
      level: {
        type: "string",
        enum: ["cluster","indices","shards"],
        description: "Level of detail for cluster_health. 'cluster' (default): cluster-level stats only. 'indices': per-index stats. 'shards': per-shard stats.",
      },
    },
  },
};

module.exports = { ELASTICSEARCH_CLIENT_SCHEMA };
