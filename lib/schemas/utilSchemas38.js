"use strict";
// lib/schemas/utilSchemas38.js — JSON schema for yaml_client tool

const UTIL_SCHEMAS_38 = [
  {
    name: "yaml_client",
    description: "Zero-dependency YAML 1.2 subset parser and writer (pure Node.js fs; no npm deps). Read, query, modify, and create YAML configuration files such as .github/workflows/*.yml, docker-compose.yml, kubernetes manifests, Ansible playbooks, and any YAML config. Supports the common YAML 1.2 subset: block/flow mappings and sequences, quoted scalars (single/double with escape sequences), block scalars (| literal and > folded with chomping indicators), implicit typing (null/bool/int/float/string), and # comments. Operations: read (parse file to JS object), get (get value at dotted key path), set (set value at dotted key path and rewrite), delete (remove key at dotted key path and rewrite), list_keys (list keys at root or a section), list_sections (list all mapping/array section paths), merge (deep-merge source YAML over base file), stringify (convert JS object to YAML). Security: path NUL guard; 4 MB file cap; nesting depth limit (max 20); 50,000-key limit. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: {
      type: "object",
      required: ["operation"],
      properties: {
        operation: {
          type: "string",
          enum: ["read", "get", "set", "delete", "list_keys", "list_sections", "merge", "stringify"],
          description: "Operation: read=parse YAML file to object, get=get value at key path, set=set value at key path and rewrite, delete=remove key and rewrite, list_keys=list root or section keys, list_sections=list all nested section paths, merge=deep-merge source over base, stringify=convert JS object or file to YAML string.",
        },
        path: {
          type: "string",
          description: "Path to the YAML file. Required for all operations except stringify (when using 'data' without output). For merge, this is the base file.",
        },
        key_path: {
          type: "string",
          description: "Dotted key path (e.g. 'spec.containers.0.image', 'services.web.ports'). Required for get, set, delete. Array elements addressed by numeric index.",
        },
        value: {
          description: "Value to set. Can be a string, number, boolean, null, array, or object. Required for set.",
        },
        section: {
          type: "string",
          description: "For list_keys: dotted key path to a sub-mapping or sub-sequence to list keys of (e.g. 'services', 'spec.containers'). If omitted, lists root-level keys.",
        },
        source_path: {
          type: "string",
          description: "Path to the source YAML file to merge onto the base file ('path'). Source keys override base keys recursively. Required for merge.",
        },
        output_path: {
          type: "string",
          description: "For merge: output path to write the merged YAML (defaults to 'path', i.e. overwrites base). For stringify: path to write the YAML output file.",
        },
        data: {
          type: "object",
          description: "JS object to convert to YAML. Required for stringify when 'path' is not given.",
        },
      },
      additionalProperties: false,
    },
  },
];

module.exports = { UTIL_SCHEMAS_38 };
