"use strict";
// lib/schemas/utilSchemas39.js — JSON schema for ini_client tool

const UTIL_SCHEMAS_39 = [
  {
    name: "ini_client",
    description: "Zero-dependency INI/CFG file parser and writer (pure Node.js fs; no npm deps). Read, query, modify, and create INI configuration files such as php.ini, smb.conf, git config, desktop launchers (.desktop), Python configparser files, and any classic [section]/key=value format. Supports: '=' and ':' key separators, '#' and ';' comments (full-line and inline), line continuation with trailing backslash, single/double-quoted values, global (pre-section) keys stored under __global__. Operations: read (parse file to object), get (get value at section.key path), set (set value and rewrite), delete (remove key or section and rewrite), list_keys (list keys in root or a section), list_sections (list all sections), merge (deep-merge source INI over base file), stringify (convert JS object to INI string). Security: path NUL guard; 4 MB file cap; 50,000-key limit; section/key name length cap (256 chars). Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: {
      type: "object",
      required: ["operation"],
      properties: {
        operation: {
          type: "string",
          enum: ["read", "get", "set", "delete", "list_keys", "list_sections", "merge", "stringify"],
          description: "Operation: read=parse INI file to object, get=get value at key path, set=set value at key path and rewrite, delete=remove key or section and rewrite, list_keys=list keys in root or a section, list_sections=list all section names, merge=deep-merge source over base, stringify=convert JS object or file to INI string.",
        },
        path: {
          type: "string",
          description: "Path to the INI file. Required for read, get, set, delete, list_keys, list_sections, merge (base file). Optional for stringify (when using 'data').",
        },
        key_path: {
          type: "string",
          description: "Key path in the form 'section.key' (e.g. 'database.host', 'php.memory_limit'). For global (pre-section) keys use just the key name (e.g. 'timeout'). For get, passing just a section name returns the whole section. Required for get, set, delete.",
        },
        value: {
          description: "Value to set. Converted to string. Required for set.",
        },
        section: {
          type: "string",
          description: "For list_keys: section name to list keys of (e.g. 'database'). Omit or use '__global__' to list global keys.",
        },
        source_path: {
          type: "string",
          description: "Path to the source INI file to merge onto the base file ('path'). Source keys/sections override base recursively. Required for merge.",
        },
        output_path: {
          type: "string",
          description: "For merge: output path to write merged result (defaults to 'path', i.e. overwrites base). For stringify: path to write the INI output file.",
        },
        data: {
          type: "object",
          description: "Plain JS object to convert to INI. Top-level keys are section names; their values are objects of key/value pairs. Use '__global__' as a section name for pre-section global keys. Required for stringify when 'path' is not given.",
        },
      },
      additionalProperties: false,
    },
  },
];

module.exports = { UTIL_SCHEMAS_39 };
