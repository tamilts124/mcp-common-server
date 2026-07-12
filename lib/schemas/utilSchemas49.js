"use strict";
// lib/schemas/utilSchemas49.js — JSON schema for excel_client tool

const UTIL_SCHEMAS_49 = [
  {
    name: "excel_client",
    description:
      "Zero-dependency XLSX file reader, writer, and editor (pure Node.js; no npm deps). " +
      "Supports Office Open XML (.xlsx) only — not legacy .xls BIFF format. " +
      "Provides 11 operations for reading, navigating, and mutating spreadsheets: " +
      "list_sheets (list all sheets with row/col counts); " +
      "read (return rows from a sheet as arrays, with optional offset/limit); " +
      "get_cell (retrieve a single cell value by address like 'A1'); " +
      "set_cell (write a single cell value; creates file if missing); " +
      "get_range (retrieve a rectangular range as a 2D array, e.g. 'A1:C10'); " +
      "set_range (write a 2D array of values into a range; creates file if missing); " +
      "add_sheet (add a new empty sheet to the workbook; creates file if missing); " +
      "delete_sheet (remove a sheet by name or index; refuses to delete the last sheet); " +
      "append_rows (append an array of row arrays after the last non-empty row); " +
      "delete_rows (remove one or more rows by 0-based index); " +
      "stringify (export a sheet as a CSV string). " +
      "Sheets are referenced by name (string) or 0-based index (number); omit to use the first sheet. " +
      "Security: 50 MB file cap; 1,000,000 row limit; 16,384 column limit; NUL-byte path guard. " +
      "Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: {
      type: "object",
      required: ["operation", "path"],
      additionalProperties: false,
      properties: {
        operation: {
          type: "string",
          enum: ["read", "get_cell", "set_cell", "get_range", "set_range",
                 "add_sheet", "delete_sheet", "list_sheets", "append_rows",
                 "delete_rows", "stringify"],
          description:
            "Operation to perform. " +
            "'list_sheets': list all worksheets in the workbook. " +
            "'read': read rows from a sheet (supports offset/limit). " +
            "'get_cell': read a single cell by address (e.g. 'A1'). " +
            "'set_cell': write a value to a single cell (creates file if missing). " +
            "'get_range': read a rectangular range (e.g. 'A1:C10') as rows of cells. " +
            "'set_range': write a 2D array of values into a range starting at the top-left address. " +
            "'add_sheet': add a new empty worksheet. " +
            "'delete_sheet': remove a worksheet by name or index. " +
            "'append_rows': append rows after the last non-empty row. " +
            "'delete_rows': delete rows starting at a 0-based row index. " +
            "'stringify': export a sheet as a CSV-formatted string.",
        },

        path: {
          type: "string",
          description: "Path to the .xlsx file. Must end in '.xlsx'. Required for all operations.",
        },

        sheet: {
          description:
            "Sheet to operate on. Provide a string name (e.g. 'Sheet1') or a 0-based integer index. " +
            "Omit to use the first sheet (index 0). Required for delete_sheet.",
          oneOf: [{ type: "string" }, { type: "integer", minimum: 0 }],
        },

        // read-specific
        offset: {
          type: "integer",
          minimum: 0,
          description: "For 'read': number of non-empty rows to skip before returning (default: 0).",
        },
        limit: {
          type: "integer",
          minimum: 1,
          description: "For 'read': maximum number of rows to return (default: all rows).",
        },
        raw: {
          type: "boolean",
          description:
            "For 'read' and 'get_range': if true, return raw cell objects (including formula and value). " +
            "Default: false — returns the display value only.",
        },

        // get_cell / set_cell
        cell: {
          type: "string",
          description:
            "For 'get_cell' and 'set_cell': cell address in A1 notation (e.g. 'A1', 'BC42'). " +
            "Column letters are case-insensitive.",
        },

        value: {
          description:
            "For 'set_cell': the value to write. May be a string, number, or boolean. " +
            "Null clears the cell.",
        },

        // get_range / set_range
        range: {
          type: "string",
          description:
            "For 'get_range' and 'set_range': rectangular range in A1:C10 notation. " +
            "'get_range' reads all cells in that rectangle. " +
            "'set_range' writes a 2D 'values' array starting at the top-left corner of the range.",
        },
        values: {
          type: "array",
          description:
            "For 'set_range': 2D array of values (array of row arrays). " +
            "Each inner array is a row; elements may be string, number, boolean, or null (skipped).",
          items: {
            type: "array",
            items: {},
          },
        },

        // add_sheet
        name: {
          type: "string",
          description:
            "For 'add_sheet': name of the new worksheet. Must be ≤ 31 characters and unique within the workbook.",
        },
        index: {
          type: "integer",
          minimum: 0,
          description:
            "For 'add_sheet': 0-based position to insert the new sheet. Omit to append at the end.",
        },

        // delete_rows
        row: {
          type: "integer",
          minimum: 0,
          description: "For 'delete_rows': 0-based index of the first row to delete.",
        },
        count: {
          type: "integer",
          minimum: 1,
          description: "For 'delete_rows': number of rows to delete starting at 'row' (default: 1).",
        },

        // append_rows
        rows: {
          type: "array",
          description:
            "For 'append_rows': array of row arrays to append after the last non-empty row. " +
            "Each inner array is a row; elements may be string, number, boolean, or null.",
          items: {
            type: "array",
            items: {},
          },
        },

        // stringify
        separator: {
          type: "string",
          description: "For 'stringify': field separator character for the CSV output (default: ',').",
        },
      },
    },
  },
];

module.exports = { UTIL_SCHEMAS_49 };
