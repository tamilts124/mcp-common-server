"use strict";
// utilSchemas72: wasm_client

const UTIL_SCHEMAS_72 = [
  {
    name: "wasm_client",
    description:
      "Zero-dependency WebAssembly binary inspector (pure Node.js; no npm deps). " +
      "Reads and decodes .wasm files in the WebAssembly Binary Format (MVP v1) without any external libraries. " +
      "Operations: " +
      "info (file metadata, section layout, counts of types/functions/imports/exports/memories/tables/globals/data segments, custom section names, start function index); " +
      "imports (all import entries with module+name, kind=function/memory/table/global, type index + signature for function imports, limits for memory/table, type+mutable for globals); " +
      "exports (all export entries with name, kind, item index, and type signature for exported functions); " +
      "types (all type definitions — function signatures with parameter and result value types: i32/i64/f32/f64/v128/funcref/externref); " +
      "functions (paginated list of all functions — both imported and defined — with type index, signature, body size, and local variable declarations); " +
      "memory (all memory definitions including imported memories, page counts, byte sizes, and shared/64-bit flags); " +
      "validate (structural integrity check — magic/version, type index validity for functions and imports, function/code count consistency, start function range, trailing bytes, multi-memory warning). " +
      "Security: 50 MB file cap; NUL-byte path guard; directory guard.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["info", "imports", "exports", "types", "functions", "memory", "validate"],
          description:
            "info: section layout, counts, custom section names, start function index. " +
            "imports: all import entries (functions with signature, memories/tables with limits, globals with type+mutable). " +
            "exports: all export entries (functions with type signature). " +
            "types: all function type definitions (params and results). " +
            "functions: paginated list of all functions with typeIndex, signature, bodySize, locals. " +
            "memory: all memory definitions with page counts, byte sizes, shared/64-bit flags. " +
            "validate: structural integrity — type refs, function/code count, start index, trailing bytes.",
        },
        path: {
          type: "string",
          description: "Absolute path to the .wasm file to inspect.",
        },
        limit: {
          type: "number",
          description: "[functions] Maximum number of functions to return (1–1000, default 200).",
        },
        offset: {
          type: "number",
          description: "[functions] Zero-based offset into the combined (imported + defined) function list (default 0).",
        },
      },
      required: ["operation", "path"],
    },
  },
];

module.exports = { UTIL_SCHEMAS_72 };
