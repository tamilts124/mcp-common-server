"use strict";
// lib/schemas/utilSchemas60.js -- JSON schema for hdf5_client tool

const UTIL_SCHEMAS_60 = [
  {
    name: "hdf5_client",
    description:
      "Zero-dependency HDF5 file reader (pure Node.js; no npm deps). " +
      "Reads HDF5 (.h5, .hdf5, .he5) files produced by h5py, MATLAB, NetCDF-4, " +
      "HDF5-based scientific tools, and any HDF5-compatible library. " +
      "Supports HDF5 superblock v0-v2, B-tree v1/v2 group indexing, " +
      "symbol tables, object headers v1/v2, local/global/fractal heaps. " +
      "Datatypes: fixed-point int (int8/16/32/64 signed/unsigned), " +
      "floating-point (float32/float64), string (fixed-length/variable-length), " +
      "compound, array, vlen, opaque, enum, reference, bitfield. " +
      "Dataspaces: scalar, simple (N-D). " +
      "Filters: none, deflate/gzip (node:zlib), shuffle, fletcher32, szip (best-effort pass-through). " +
      "Operations: " +
      "info (file-level metadata: superblock version, offset/length size, root group info); " +
      "list (enumerate groups and datasets under a path with types and shapes); " +
      "attrs (read all attributes of a group or dataset); " +
      "read (read dataset data with optional row offset/limit); " +
      "to_json (convert dataset to JSON string or file); " +
      "to_csv (convert dataset to CSV string or file). " +
      "Security: 256 MB file cap; 10,000,000 element limit; NUL-byte path guard; " +
      "directory path rejected; max 64-level group depth.",
    inputSchema: {
      type: "object",
      required: ["operation", "path"],
      additionalProperties: false,
      properties: {
        operation: {
          type: "string",
          enum: ["info", "list", "attrs", "read", "to_json", "to_csv"],
          description:
            "Operation to perform. " +
            "'info': return file-level metadata (superblock version, offset/length sizes, root group info). " +
            "'list': enumerate groups and datasets under 'dataset_path' (default '/'). " +
            "'attrs': read all HDF5 attributes attached to a group or dataset at 'dataset_path'. " +
            "'read': decode dataset elements at 'dataset_path' (supports 'offset', 'limit'). " +
            "'to_json': decode dataset and return as JSON string (or write to 'output_file'). " +
            "'to_csv': decode dataset and return as CSV string (or write to 'output_file').",
        },

        path: {
          type: "string",
          description: "Path to the HDF5 file (.h5, .hdf5, .he5, or any HDF5-formatted file) to read.",
        },

        dataset_path: {
          type: "string",
          description:
            "HDF5 internal path to a group or dataset (e.g. '/', '/group/subgroup', '/group/dataset'). " +
            "For 'info': ignored. " +
            "For 'list': directory to enumerate (default '/'). " +
            "For 'attrs', 'read', 'to_json', 'to_csv': required -- path to the target dataset or group.",
        },

        offset: {
          type: "integer",
          minimum: 0,
          description: "For 'read', 'to_json', 'to_csv': skip this many elements from the start. Default: 0.",
        },

        limit: {
          type: "integer",
          minimum: 1,
          description:
            "For 'read', 'to_json', 'to_csv': maximum number of elements (or rows for N-D datasets) " +
            "to return. Default: all elements (up to 10,000,000 hard cap).",
        },

        output_file: {
          type: "string",
          description:
            "For 'to_json', 'to_csv': path to write the output file. " +
            "If omitted, the result is returned inline in the response.",
        },

        pretty: {
          type: "boolean",
          description: "For 'to_json': pretty-print the JSON output. Default: false.",
        },

        separator: {
          type: "string",
          description: "For 'to_csv': field separator character. Default: ','.",
        },
      },
    },
  },
];

module.exports = { UTIL_SCHEMAS_60 };
