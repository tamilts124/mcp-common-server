"use strict";
// ── WRITE TOOL SCHEMAS — hidden when MCP_READ_ONLY=true ───────────────────────

const WRITE_SCHEMAS = [
  {
    name: "write_file",
    description: "Write content to a file. from_line/to_line=0 replaces the whole file (creates a .bak backup first). Otherwise replaces only the specified line range.",
    inputSchema: { type: "object", required: ["path", "content"], properties: {
      path:      { type: "string" },
      content:   { type: "string", description: "New content to write." },
      from_line: { type: "number", description: "Start of line range to replace (1-based). 0 = whole file." },
      to_line:   { type: "number", description: "End of line range to replace (inclusive). 0 = whole file." },
    }},
  },
  {
    name: "write_files",
    description: "Write multiple files in one call. Each item: {path, content, from_line?, to_line?}. Line ranges work the same as write_file.",
    inputSchema: { type: "object", required: ["files"], properties: {
      files: { type: "array", items: { type: "object", required: ["path", "content"], properties: {
        path:      { type: "string" },
        content:   { type: "string" },
        from_line: { type: "number" },
        to_line:   { type: "number" },
      }}},
    }},
  },
  {
    name: "create_file",
    description: "Create a new file with optional content. Fails if the file already exists.",
    inputSchema: { type: "object", required: ["path"], properties: {
      path:    { type: "string" },
      content: { type: "string", description: "Initial file content (default: empty)." },
    }},
  },
  {
    name: "create_files",
    description: "Create multiple new files in one call. Each item: {path, content?}. Fails per-file if already exists.",
    inputSchema: { type: "object", required: ["files"], properties: {
      files: { type: "array", items: { type: "object", required: ["path"], properties: {
        path:    { type: "string" },
        content: { type: "string" },
      }}},
    }},
  },
  {
    name: "delete_file",
    description: "Permanently delete a file.",
    inputSchema: { type: "object", required: ["path"], properties: {
      path: { type: "string" },
    }},
  },
  {
    name: "delete_files",
    description: "Permanently delete multiple files in one call.",
    inputSchema: { type: "object", required: ["paths"], properties: {
      paths: { type: "array", items: { type: "string" } },
    }},
  },
  {
    name: "move_file",
    description: "Move or rename a file. Works across directories and across roots (including across filesystems/drives, via an automatic copy+delete fallback when a direct rename is not possible). Rejects directory sources. Fails if the destination already exists unless overwrite: true is passed. Symlinks that would escape the source or destination root are blocked.",
    inputSchema: { type: "object", required: ["source", "destination"], properties: {
      source:      { type: "string", description: "Current path of the file." },
      destination: { type: "string", description: "New path of the file." },
      overwrite:   { type: "boolean", description: "Allow overwriting an existing destination file (default: false — throws if destination exists)." },
    }},
  },
  {
    name: "copy_file",
    description: "Copy a file to a new location. Creates destination directories if needed. Rejects directory sources. Fails if the destination already exists unless overwrite: true is passed. Symlinks that would escape the source or destination root are blocked.",
    inputSchema: { type: "object", required: ["source", "destination"], properties: {
      source:      { type: "string" },
      destination: { type: "string" },
      overwrite:   { type: "boolean", description: "Allow overwriting an existing destination file (default: false — throws if destination exists)." },
    }},
  },
  {
    name: "move_directory",
    description: "Move (or merge) an entire directory tree to a new location. Tries a fast whole-tree rename first when the destination doesn't already exist; falls back to a recursive copy+delete when the OS rejects the rename as cross-device (EXDEV) or when merging into an existing destination (pass overwrite: true to merge — files at colliding relative paths are overwritten, non-colliding files from both sides are kept). Rejects non-directory sources. Any symlink found anywhere inside the source tree aborts the whole operation before anything is written (no partial moves).",
    inputSchema: { type: "object", required: ["source", "destination"], properties: {
      source:      { type: "string", description: "Current path of the directory." },
      destination: { type: "string", description: "New path of the directory." },
      overwrite:   { type: "boolean", description: "Allow merging into an existing destination directory (default: false — throws if destination exists)." },
    }},
  },
  {
    name: "copy_directory",
    description: "Recursively copy an entire directory tree to a new location, leaving the source untouched. Creates the full destination directory structure as needed. Rejects non-directory sources. Fails if the destination directory already exists unless overwrite: true is passed (then merges — files at colliding relative paths are overwritten). Any symlink found anywhere inside the source tree aborts the whole operation before anything is written (no partial copies).",
    inputSchema: { type: "object", required: ["source", "destination"], properties: {
      source:      { type: "string", description: "Path of the directory to copy." },
      destination: { type: "string", description: "Destination path for the copied directory tree." },
      overwrite:   { type: "boolean", description: "Allow merging into an existing destination directory (default: false — throws if destination exists)." },
    }},
  },
  {
    name: "create_directory",
    description: "Create a directory, including all parent directories.",
    inputSchema: { type: "object", required: ["path"], properties: {
      path: { type: "string" },
    }},
  },
  {
    name: "delete_directory",
    description: "Delete a directory. Set recursive: true to delete non-empty directories.",
    inputSchema: { type: "object", required: ["path"], properties: {
      path:      { type: "string" },
      recursive: { type: "boolean", description: "Delete contents recursively (default: false)." },
    }},
  },
  {
    name: "replace_in_file",
    description: "Find and replace text in one file, or in bulk across every matching file under a directory tree in a single call. Supports plain string or regex substitution. When 'path' is a directory, walks it recursively (respecting MCP_IGNORE, optionally narrowed by 'extensions') and applies the same search/replace to every file, returning a per-file breakdown plus filesScanned/filesModified/totalReplacements totals. Pass dry_run: true to preview exactly what would change (per-file replacement counts and resulting sizes) without writing anything or creating .bak backups — safe to run first on a large tree before committing to the real edit. Creates a .bak backup of each modified file on a real (non-dry-run) write. Use is_regex=true and flags='g' for global regex replace.",
    inputSchema: { type: "object", required: ["search", "replace"], properties: {
      search:   { type: "string",  description: "Text string or regex pattern to find." },
      replace:  { type: "string",  description: "Replacement text. For regex mode, can use $1, $2 etc. for capture groups." },
      path:     { type: "string",  description: "File path or directory to search. If a directory, operates recursively on all matched files." },
      is_regex: { type: "boolean", description: "Treat search as a regular expression (default: false)." },
      flags:    { type: "string",  description: "Regex flags to use when is_regex=true (default: 'g'). E.g. 'gi' for case-insensitive global." },
      extensions: { type: "array", description: "When path is a directory, only process files with these extensions.",
        items: { type: "string" },
      },
      dry_run:  { type: "boolean", description: "If true, report what would change (per-file/total match counts) without writing any files or creating .bak backups (default: false)." },
    }},
  },
  {
    name: "truncate_file",
    description: "Shrink a file to its first N lines or first N bytes. Exactly one of 'lines' or 'bytes' must be supplied. If the file is already shorter than the limit, it is left unchanged. Write-gated: blocked when MCP_READ_ONLY=true.",
    inputSchema: { type: "object", required: ["path"], properties: {
      path:  { type: "string", description: "Path to the file to truncate." },
      lines: { type: "number", description: "Keep the first N lines (newline-delimited). Mutually exclusive with 'bytes'." },
      bytes: { type: "number", description: "Keep the first N bytes. Mutually exclusive with 'lines'." },
    }},
  },
  {
    name: "append_file",
    description: "Append text content to the end of a file. Creates the file (and any missing parent directories) if it does not already exist. Write-gated: blocked when MCP_READ_ONLY=true.",
    inputSchema: { type: "object", required: ["path"], properties: {
      path:    { type: "string", description: "Path to the file to append to." },
      content: { type: "string", description: "Text to append. May be empty string (no-op append)." },
    }},
  },
  {
    name: "json_patch",
    description: "Apply RFC 6902 JSON Patch operations (add, remove, replace, move, copy, test) to a JSON file. Path pointers use RFC 6901 JSON Pointer syntax (e.g. /dependencies/lodash, /scripts/build, /items/0). The file is read, all operations are applied atomically in memory, and the result is written back pretty-printed at the original indent level. Pass apply: false for a dry-run that returns the patched document without touching the file. A failed 'test' operation aborts the entire patch (no partial writes). Write-gated: blocked when MCP_READ_ONLY=true.",
    inputSchema: { type: "object", required: ["path", "ops"], properties: {
      path: { type: "string", description: "Path to the JSON file to patch (e.g. 'package.json', 'config/settings.json')." },
      ops:  { type: "array",  description: "Array of RFC 6902 patch operations. Each operation is an object with 'op' (required), 'path' (required, RFC 6901 pointer), and optionally 'value' and 'from'.",
        items: { type: "object", required: ["op", "path"], properties: {
          op:    { type: "string", description: "Operation name: 'add', 'remove', 'replace', 'move', 'copy', or 'test'." },
          path:  { type: "string", description: "RFC 6901 JSON Pointer to the target location (e.g. '/scripts/build' or '/deps/0')." },
          value: { description: "Value to use for 'add', 'replace', and 'test' operations." },
          from:  { type: "string", description: "Source pointer for 'move' and 'copy' operations." },
        }},
      },
      apply: { type: "boolean", description: "If false, perform a dry-run: return the patched document without writing the file (default: true)." },
    }},
  },
  {
    name: "unzip_archive",
    description: "Extract a ZIP file's contents into a directory inside the jail. Companion to zip_directory (creates ZIPs) and read_archive (inspects ZIPs). Validates every entry name up front — rejects the whole archive (writing nothing) if any entry contains an absolute path or '..' traversal segment (Zip Slip protection). Supports 'stored' (method 0) and 'deflate' (method 8) entries. The destination directory is created automatically if it does not exist. Pass overwrite: true to extract into an already-existing destination (colliding files are overwritten, non-colliding files on the destination side are preserved). Write-gated: blocked when MCP_READ_ONLY=true.",
    inputSchema: { type: "object", required: ["path", "destination"], properties: {
      path:        { type: "string",  description: "Client path to the source .zip file." },
      destination: { type: "string",  description: "Client path of the destination directory to extract into. Created automatically if it does not exist." },
      overwrite:   { type: "boolean", description: "If true, extract into an existing directory (colliding files overwritten). Default: false — aborts if destination already exists." },
    }},
  },
  {
    name: "apply_patch",
    description: "Apply a unified diff (as produced by diff_files, git diff, or diff -u) to a file. Hunks are applied atomically — the whole modified content is assembled in memory and written to disk only if every hunk succeeds. Strict mode (default) verifies that context lines in the patch match the actual file, so a patch intended for a different version of the file is rejected safely. Fuzzy mode (strict: false) skips context verification and applies hunks by position only — useful for offset-only patches on slightly modified files. Use dry_run: true to preview the patched text without touching the file. Write-gated: blocked when MCP_READ_ONLY=true.",
    inputSchema: { type: "object", required: ["path", "patch"], properties: {
      path:     { type: "string",  description: "Path to the file to patch." },
      patch:    { type: "string",  description: "Unified diff text (--- / +++ / @@ hunk format)." },
      strict:   { type: "boolean", description: "Verify context lines match the file exactly (default: true). Set false to skip context verification." },
      dry_run:  { type: "boolean", description: "If true, return the patched file content without writing it (default: false)." },
    }},
  },
  {
    name: "yaml_patch",
    description: "Apply structured mutation operations to a YAML file. Operations: 'set' (write a value at a dot-notation key path, creating intermediate keys as needed), 'delete' (remove a key from a mapping or splice an item from a sequence), 'insert_at' (insert a value into a sequence at a given 0-based index), 'append_to' (append a value to the end of a sequence). The file is parsed, all operations are applied atomically in memory, and the result is re-serialised and written back. Comments and original key ordering are NOT preserved (the parser is value-oriented, not a CST). Anchors/aliases and other unsupported YAML constructs are rejected at parse time. Pass apply: false for a dry-run that returns the patched document without touching the file. Write-gated: blocked when MCP_READ_ONLY=true.",
    inputSchema: { type: "object", required: ["path", "ops"], properties: {
      path: { type: "string", description: "Path to the YAML file to patch (e.g. 'config.yaml', 'docker-compose.yml')." },
      ops:  { type: "array",  description: "Array of mutation operations to apply in order. Each operation is an object with 'op' and 'path' (required), plus 'value' and/or 'index' depending on the op.",
        items: { type: "object", required: ["op", "path"], properties: {
          op:    { type: "string",  description: "Operation: 'set', 'delete', 'insert_at', or 'append_to'." },
          path:  { type: "string",  description: "Dot-notation path to the target (e.g. 'services.web.ports' or 'users.0.name'). Empty string refers to root (only valid for 'delete')." },
          value: {                  description: "Value for 'set', 'insert_at', and 'append_to' operations. May be any JSON-serialisable type." },
          index: { type: "number",  description: "0-based integer index for 'insert_at'." },
        }},
      },
      apply: { type: "boolean", description: "If false, perform a dry-run: return the patched document without writing the file (default: true)." },
    }},
  },
  {
    name: "yaml_merge",
    description: "Deep-merge a 'patch' YAML document (supplied inline as a string) onto a 'base' YAML file on disk. Mappings are merged recursively — patch keys override base keys, keys present only in base are preserved untouched. Sequences (arrays) in the patch fully REPLACE the corresponding base sequence (they are not concatenated — use yaml_patch's append_to for that). Scalars in the patch replace the corresponding base scalar. If a key's base and patch values have mismatched shapes (e.g. mapping vs scalar), the patch value wins outright. A null in the patch explicitly sets the key to null rather than being treated as absent. The base file is parsed, merged in memory, re-serialised, and written back. Comments and original key ordering are NOT preserved. Pass apply: false for a dry-run that returns the merged document without touching the file. Returns { path, apply, originalSize, newSize, result }. Write-gated: blocked when MCP_READ_ONLY=true.",
    inputSchema: { type: "object", required: ["path", "patch"], properties: {
      path:  { type: "string", description: "Path to the base YAML file to merge onto (e.g. 'config.yaml', 'values.yaml')." },
      patch: { type: "string", description: "YAML document text to deep-merge onto the base file's contents (e.g. 'replicas: 3\\nservice:\\n  port: 8080')." },
      apply: { type: "boolean", description: "If false, perform a dry-run: return the merged document without writing the file (default: true)." },
    }},
  },
  {
    name: "convert_data",
    description: "Convert a JSON document to YAML or a YAML document to JSON. Source format is auto-detected from the file's extension (.yaml/.yml → yaml, otherwise json) unless overridden with 'format'. Target format defaults to 'the other one' but can be forced with 'to' (re-serialising to the same format is allowed too, as a pretty-print/normalise operation). Always returns the converted text as 'converted' in the result. If 'destination' is supplied, the converted text is also written there — pass apply:false to preview the write without touching disk (destination is still echoed back, with written:false). Without a destination, nothing is written; this is a pure in-memory conversion/preview. Returns { path, sourceFormat, targetFormat, indent, converted, destination?, written? }. Write-gated: blocked when MCP_READ_ONLY=true (even for the no-destination preview case, for consistency with the rest of this tool family).",
    inputSchema: { type: "object", required: ["path"], properties: {
      path:        { type: "string",  description: "Path to the source JSON or YAML file." },
      format:      { type: "string",  description: "Force the source format instead of auto-detecting by extension: 'json' or 'yaml'." },
      to:          { type: "string",  description: "Target format: 'json' or 'yaml'. Defaults to whichever format the source is not." },
      indent:      { type: "number",  description: "Indent width for JSON target output (default: 2, clamped to >= 0). Ignored when the target is yaml." },
      destination: { type: "string",  description: "Optional path to write the converted text to. If omitted, the converted text is only returned, nothing is written." },
      apply:       { type: "boolean", description: "When 'destination' is given, false = dry-run preview only, no write (default: true). Ignored if 'destination' is omitted." },
    }},
  },
  {
    name: "csv_convert",
    description: "Convert a CSV file to JSON or a JSON file to CSV. Source format is auto-detected from the file's extension (.csv \u2192 csv, otherwise json) unless overridden with 'format'. Target format defaults to 'the other one' but can be forced with 'to'. CSV -> JSON: with has_header (default true), each data row becomes a {header: value} object; with has_header:false, rows are returned as raw string arrays. JSON -> CSV: the JSON value must be an array \u2014 if every element is a flat object, the output column set is the union of keys across all rows (first-seen order) and has_header controls whether a header row is emitted; if every element is itself an array, rows are written as-is. Always returns the converted text as 'converted' in the result. If 'destination' is supplied, the converted text is also written there \u2014 pass apply:false to preview the write without touching disk (destination is still echoed back, with written:false). Without a destination, nothing is written; this is a pure in-memory conversion/preview. Returns { path, sourceFormat, targetFormat, hasHeader, indent, converted, destination?, written? }. Write-gated: blocked when MCP_READ_ONLY=true (even for the no-destination preview case, for consistency with the rest of this tool family).",
    inputSchema: { type: "object", required: ["path"], properties: {
      path:        { type: "string",  description: "Path to the source CSV or JSON file." },
      format:      { type: "string",  description: "Force the source format instead of auto-detecting by extension: 'csv' or 'json'." },
      to:          { type: "string",  description: "Target format: 'csv' or 'json'. Defaults to whichever format the source is not." },
      has_header:  { type: "boolean", description: "Whether the first CSV row/JSON key set represents a header (default: true). See tool description for exact CSV<->JSON semantics." },
      indent:      { type: "number",  description: "Indent width for JSON target output (default: 2, clamped to >= 0). Ignored when the target is csv." },
      destination: { type: "string",  description: "Optional path to write the converted text to. If omitted, the converted text is only returned, nothing is written." },
      apply:       { type: "boolean", description: "When 'destination' is given, false = dry-run preview only, no write (default: true). Ignored if 'destination' is omitted." },
    }},
  },
  {
    name: "gzip_compress",
    description: "Gzip-compress a file and write the result to a destination path (zero-dependency, uses Node's built-in zlib). Returns original and compressed byte sizes plus the compression ratio (compressedBytes / originalBytes). Write-gated: blocked when MCP_READ_ONLY=true.",
    inputSchema: { type: "object", required: ["path", "destination"], properties: {
      path:        { type: "string", description: "Path to the source file to compress." },
      destination: { type: "string", description: "Path where the .gz file will be written. Parent directories are created automatically." },
      level:       { type: "number", description: "zlib compression level, 0 (none) to 9 (max) (default: 6)." },
    }},
  },
  {
    name: "gzip_decompress",
    description: "Gunzip-decompress a file and write the result to a destination path (zero-dependency, uses Node's built-in zlib). Validates the source is well-formed gzip data before writing. Returns compressed and decompressed byte sizes. Write-gated: blocked when MCP_READ_ONLY=true.",
    inputSchema: { type: "object", required: ["path", "destination"], properties: {
      path:        { type: "string", description: "Path to the source .gz file to decompress." },
      destination: { type: "string", description: "Path where the decompressed file will be written. Parent directories are created automatically." },
    }},
  },
  {
    name: "brotli_compress",
    description: "Brotli-compress a file and write the result to a destination path (zero-dependency, uses Node's built-in zlib Brotli API). Typically compresses text better than gzip at higher CPU cost. Returns original and compressed byte sizes plus the compression ratio (compressedBytes / originalBytes). Write-gated: blocked when MCP_READ_ONLY=true.",
    inputSchema: { type: "object", required: ["path", "destination"], properties: {
      path:        { type: "string", description: "Path to the source file to compress." },
      destination: { type: "string", description: "Path where the .br file will be written. Parent directories are created automatically." },
      quality:     { type: "number", description: "Brotli quality, 0 (fastest) to 11 (max compression, default)." },
    }},
  },
  {
    name: "brotli_decompress",
    description: "Brotli-decompress a file and write the result to a destination path (zero-dependency, uses Node's built-in zlib Brotli API). Validates the source is well-formed brotli data before writing. Returns compressed and decompressed byte sizes. Write-gated: blocked when MCP_READ_ONLY=true.",
    inputSchema: { type: "object", required: ["path", "destination"], properties: {
      path:        { type: "string", description: "Path to the source .br file to decompress." },
      destination: { type: "string", description: "Path where the decompressed file will be written. Parent directories are created automatically." },
    }},
  },
  {
    name: "md_to_docx",
    description: "Convert a Markdown source file into a Word .docx file (zero-dependency, hand-built minimal OOXML package). Supports headings (# .. ######), bullet list items (- / *), numbered items kept literal, and inline **bold**/*italic* formatting. Not a full CommonMark engine. Write-gated: blocked when MCP_READ_ONLY=true.",
    inputSchema: { type: "object", required: ["path", "destination"], properties: {
      path:        { type: "string", description: "Path to the source Markdown (.md) file." },
      destination: { type: "string", description: "Path where the .docx file will be written. Parent directories are created automatically." },
    }},
  },
  {
    name: "docx_to_md",
    description: "Convert a Word .docx file into a best-effort Markdown text file (zero-dependency, regex-based OOXML reading of word/document.xml). Recovers headings (via paragraph style), bold/italic runs, and bullet-prefixed paragraphs. Write-gated: blocked when MCP_READ_ONLY=true.",
    inputSchema: { type: "object", required: ["path", "destination"], properties: {
      path:        { type: "string", description: "Path to the source .docx file." },
      destination: { type: "string", description: "Path where the converted .md file will be written. Parent directories are created automatically." },
    }},
  },

];


module.exports = { WRITE_SCHEMAS };
