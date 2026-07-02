"use strict";
// ── UTILITY TOOL SCHEMAS — always available, read-only unless noted ───────────
// Checksums, archives, structured-data query, diffing, directory comparison,
// metrics, and encoding/text transforms. Split out of toolsSchema.js to keep
// every file under the project's 500-line threshold.

const UTIL_SCHEMAS = [
  {
    name: "read_archive",
    description: "Inspect the contents of a ZIP file without extracting it. Reads the ZIP Central Directory to list all entries with their paths, uncompressed/compressed sizes, compression method, CRC-32, and last-modified timestamps. Returns a structured manifest plus aggregate totals. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", required: ["path"], properties: {
      path: { type: "string", description: "Path to the .zip file to inspect." },
    }},
  },
  {
    name: "find_duplicates",
    description: "Scan a directory recursively and find duplicate files by content hash (MD5/SHA-1/SHA-256/SHA-512). For performance, files are first grouped by size (cheap to stat) and only files that share an exact size with at least one sibling are actually hashed — files with a unique size in the tree are skipped entirely. Returns duplicate sets sorted by wasted disk space (largest first), each with the hash, size, file count, wastedBytes, and the list of duplicate file paths, plus aggregate totals (filesScanned, filesHashed, duplicateSetCount, totalDuplicateFiles, totalWastedBytes). Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path:       { type: "string", description: "Directory to scan recursively (default: '.' — the whole root)." },
      algorithm:  { type: "string", description: "Hash algorithm: 'md5', 'sha1', 'sha256' (default), or 'sha512'." },
      extensions: { type: "array", items: { type: "string" }, description: "Optional: only consider files with these extensions, e.g. ['.jpg', '.png']." },
      min_size:   { type: "number", description: "Optional: ignore files smaller than this many bytes (default: 0, no minimum)." },
    }},
  },
  {
    name: "compare_directories",
    description: "Recursively compare two directory trees by content hash and classify every relative file path as added (only in 'right'), removed (only in 'left'), modified (present in both but content differs), or unchanged (present in both with identical content). Relative paths are computed against each compared directory itself, so directories with different names/locations but the same internal structure compare correctly. Useful for verifying build outputs, comparing deployment artifacts, or auditing a refactor without needing git. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", required: ["left", "right"], properties: {
      left:       { type: "string", description: "Path to the 'before' / baseline directory." },
      right:      { type: "string", description: "Path to the 'after' / comparison directory." },
      algorithm:  { type: "string", description: "Hash algorithm: 'md5', 'sha1', 'sha256' (default), or 'sha512'." },
      extensions: { type: "array", items: { type: "string" }, description: "Optional: only consider files with these extensions in both trees." },
    }},
  },
  {
    name: "file_diff_dir",
    description: "Combines compare_directories (file-level classification) and diff_files (line-level unified diff) into one tool: recursively compares two directory trees by content hash, then produces a line-level unified diff for every modified file. Files only in 'right' are reported with status 'added', files only in 'left' with status 'removed' (neither has an 'other side' to line-diff against, so no unified text is computed for them). Unchanged files are omitted from the per-file list (only counted in summary), same convention as compare_directories. Because output can get very large for trees with many changed files, a max_diff_lines budget (default 500, max 5000) caps the total unified-diff lines emitted across all files combined — once exhausted, remaining modified files are still listed by relPath/status but without a computed diff, and truncated:true is set so the caller knows to diff those specific files directly with diff_files if more detail is needed. Returns { left, right, algorithm, leftFileCount, rightFileCount, summary, diffs: [{relPath, status, unified?, additions?, deletions?, hunks?}], maxDiffLines, totalDiffLinesEmitted, truncated }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", required: ["left", "right"], properties: {
      left:           { type: "string", description: "Path to the 'before' / baseline directory." },
      right:          { type: "string", description: "Path to the 'after' / comparison directory." },
      algorithm:      { type: "string", description: "Hash algorithm: 'md5', 'sha1', 'sha256' (default), or 'sha512'." },
      extensions:     { type: "array", items: { type: "string" }, description: "Optional: only consider files with these extensions in both trees." },
      max_diff_lines: { type: "number", description: "Cap on total unified-diff lines emitted across all modified files combined (default 500, max 5000)." },
      context:        { type: "number", description: "Lines of context shown around each changed hunk in each file's unified diff (default 3), passed through to diff_files' algorithm." },
    }},
  },
  {
    name: "count_lines",
    description: "Count lines, words, and bytes in one or more files (like the Unix `wc` command). Returns per-file statistics and an aggregate total. Useful for quick code metrics (how large is this file?), sanity-checking generated output, and reporting file statistics. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", required: ["paths"], properties: {
      paths: { type: "array", items: { type: "string" }, description: "One or more file paths to count. Directories and non-existent paths throw a descriptive error." },
    }},
  },
  {
    name: "file_tree",
    description: "Return a pretty-printed ASCII directory tree (like the Unix `tree` command) for a given path. Useful for quickly understanding project layout without listing each file individually. MCP_IGNORE'd directories (e.g. node_modules, .git) are excluded. Output is truncated at 500 nodes to stay readable. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path:  { type: "string",  description: "Directory to display (default: first root)." },
      depth: { type: "number",  description: "Maximum depth to recurse (1–10, default 4)." },
      sizes: { type: "boolean", description: "Annotate file entries with their byte size (default: false)." },
    }},
  },
  {
    name: "hash_directory",
    description: "Compute a single aggregate fingerprint (hash) of an entire directory tree by hashing all file contents together with their relative paths in sorted order. Any add, remove, rename, or content change in the tree produces a different hash. Useful for detecting whether a build output or deployment artifact has changed without comparing each file individually. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path:       { type: "string", description: "Directory to fingerprint (default: first root)." },
      algorithm:  { type: "string", description: "Hash algorithm: 'md5', 'sha1', 'sha256' (default), or 'sha512'." },
      extensions: { type: "array", items: { type: "string" }, description: "Optional: only include files with these extensions." },
    }},
  },
  {
    name: "base64_encode",
    description: "Read a file and return its contents encoded as a base64 string. Supports standard base64 (RFC 4648) and URL-safe base64 (- and _ instead of + and /). Useful for embedding binary files in JSON payloads, data URIs, or API requests. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", required: ["path"], properties: {
      path:     { type: "string",  description: "Path to the file to encode." },
      url_safe: { type: "boolean", description: "Use URL-safe base64 alphabet (- and _ instead of + and /). Default: false." },
    }},
  },
  {
    name: "base64_decode",
    description: "Decode a base64 (or URL-safe base64) string and write the result as a binary file. Validates that the input is properly encoded before writing. Write-gated: blocked when MCP_READ_ONLY=true.",
    inputSchema: { type: "object", required: ["data", "destination"], properties: {
      data:        { type: "string", description: "The base64-encoded string to decode." },
      destination: { type: "string", description: "Path where the decoded file will be written. Parent directories are created automatically." },
    }},
  },
  {
    name: "json_format",
    description: "Parse a JSON file and re-serialise it with consistent formatting. Can pretty-print (with configurable indent) or minify (indent: 0). Optionally writes the result back to the same file in-place. Returns the formatted JSON string plus original and new byte sizes. Write-gated when in_place=true: blocked when MCP_READ_ONLY=true.",
    inputSchema: { type: "object", required: ["path"], properties: {
      path:     { type: "string",  description: "Path to the JSON file to format." },
      indent:   { type: "number",  description: "Spaces per indent level (default: 2). Set to 0 to minify." },
      in_place: { type: "boolean", description: "Write the formatted result back to the file (default: false — just return the result)." },
    }},
  },
  {
    name: "text_transform",
    description: "Apply one or more named text transforms to a file's content in sequence. Available transforms: 'uppercase', 'lowercase', 'trim_lines' (strip leading/trailing whitespace per line), 'sort_lines', 'sort_lines_desc', 'dedupe_lines' (remove duplicate lines, first occurrence kept), 'reverse_lines', 'remove_blank_lines'. Transforms are applied in the order given. Returns the result string plus before/after line and byte counts. Write-gated when in_place=true: blocked when MCP_READ_ONLY=true.",
    inputSchema: { type: "object", required: ["path", "transforms"], properties: {
      path:       { type: "string", description: "Path to the file to transform." },
      transforms: { type: "array",  items: { type: "string" }, description: "Ordered list of transform names to apply. E.g. ['trim_lines', 'sort_lines', 'dedupe_lines']." },
      in_place:   { type: "boolean", description: "Write the result back to the file (default: false — just return the result)." },
    }},
  },
  {
    name: "file_checksum",
    description: "Compute a cryptographic digest (MD5, SHA-1, SHA-256, or SHA-512) of a file. Useful for verifying file integrity, detecting duplicates, and change detection.",
    inputSchema: { type: "object", required: ["path"], properties: {
      path:      { type: "string", description: "Path to the file to hash." },
      algorithm: { type: "string", description: "Hash algorithm: 'md5', 'sha1', 'sha256' (default), or 'sha512'." },
    }},
  },
  {
    name: "checksum_verify",
    description: "Compute a file's checksum and compare it against an expected hex digest in one call — the common 'verify a download/artifact matches its published hash' workflow, without requiring the caller to compute via file_checksum and compare client-side. Returns { path, match, algorithm, expected, actual, sizeBytes }, where 'expected' is echoed back lower-cased/trimmed and 'match' is a case-insensitive comparison against the computed digest. Throws a descriptive error if 'expected' is empty or not a valid hex string. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", required: ["path", "expected"], properties: {
      path:      { type: "string", description: "Path to the file to verify." },
      expected:  { type: "string", description: "Expected hex digest to compare against (case-insensitive, whitespace-trimmed)." },
      algorithm: { type: "string", description: "Hash algorithm: 'md5', 'sha1', 'sha256' (default), or 'sha512'. Must match the algorithm 'expected' was computed with." },
    }},
  },

  {
    name: "hash_string",
    description: "Compute a cryptographic digest (MD5, SHA-1, SHA-256, or SHA-512) of an arbitrary string payload — no file I/O involved. Sibling of file_checksum for callers that already have data in hand (an API response body, a generated config, a value read via another tool) and don't want to write it to a temp file just to hash it.",
    inputSchema: { type: "object", required: ["data"], properties: {
      data:      { type: "string", description: "The string payload to hash." },
      algorithm: { type: "string", description: "Hash algorithm: 'md5', 'sha1', 'sha256' (default), or 'sha512'." },
      encoding:  { type: "string", description: "How to interpret 'data': 'utf8' (default), 'base64', or 'hex'. Use 'base64'/'hex' to hash binary-ish payloads passed as text." },
    }},
  },
  {
    name: "zip_directory",
    description: "Archive a directory (and all its contents) into a ZIP file. Uses DEFLATE compression. The output .zip is written inside the jailed file system. Zero npm dependencies — pure Node.js built-ins.",
    inputSchema: { type: "object", required: ["path", "destination"], properties: {
      path:        { type: "string", description: "Path to the source directory to archive." },
      destination: { type: "string", description: "Path for the output .zip file (e.g. 'backups/project.zip'). Parent directories are created automatically." },
    }},
  },
  {
    name: "create_tar",
    description: "Archive a directory (and all its contents) into a .tar file, or a gzip-compressed .tar.gz/.tgz if the destination ends with that extension (or 'gzip: true' is passed explicitly). Hand-built USTAR format + Node's built-in zlib — zero npm dependencies. Companion to zip_directory for callers that specifically need a tarball (e.g. Linux/CI artifact conventions).",
    inputSchema: { type: "object", required: ["path", "destination"], properties: {
      path:        { type: "string", description: "Path to the source directory to archive." },
      destination: { type: "string", description: "Path for the output .tar/.tar.gz/.tgz file. Parent directories are created automatically." },
      gzip:        { type: "boolean", description: "Force gzip compression on/off. Default: inferred from the destination extension (.tar.gz/.tgz → gzip, .tar → plain)." },
    }},
  },
  {
    name: "query_json",
    description: "Parse a JSON file and extract a value by dot-notation path (e.g. 'dependencies.lodash', 'users.0.name'). Returns the value, its type, and the resolved path. Use an empty query to return the entire document.",
    inputSchema: { type: "object", required: ["path"], properties: {
      path:  { type: "string", description: "Path to the JSON file to parse." },
      query: { type: "string", description: "Dot-notation path into the parsed object (e.g. 'a.b.c' or 'items.0.name'). Empty or omitted = return root document." },
    }},
  },
  {
    name: "query_data",
    description: "Parse a JSON or YAML file and extract a value by dot-notation path (e.g. 'dependencies.lodash', 'services.web.ports.0'). Format is auto-detected from the file extension (.json -> JSON, .yaml/.yml -> YAML) or can be forced with the 'format' argument. YAML support covers a common subset (block/flow mappings and sequences, scalars, comments, and block scalars '|'/'>' with chomping indicators) via a zero-dependency parser — see README for the exact supported subset and unsupported constructs (anchors/aliases, multi-document streams, tags). Returns the value, its type, the resolved path, and which format was used.",
    inputSchema: { type: "object", required: ["path"], properties: {
      path:   { type: "string", description: "Path to the JSON or YAML file to parse." },
      query:  { type: "string", description: "Dot-notation path into the parsed object (e.g. 'a.b.c' or 'items.0.name'). Empty or omitted = return root document." },
      format: { type: "string", description: "Optional explicit format override: 'json' or 'yaml'. Omit to auto-detect from the file extension." },
    }},
  },
  {
    name: "diff_files",
    description: "Compute a unified diff between two text files inside the jailed file system. Uses a pure-JS Myers diff algorithm (zero npm dependencies). Returns the diff as a unified-diff string plus a structured summary (hunk count, line additions, line deletions, and whether the files are identical). Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", required: ["source", "target"], properties: {
      source:  { type: "string", description: "Path to the 'old' (left-side) file." },
      target:  { type: "string", description: "Path to the 'new' (right-side) file." },
      context: { type: "number", description: "Lines of context shown around each changed hunk (default: 3)." },
    }},
  },
  {
    name: "env_info",
    description: "Return structured, read-only information about the server environment: Node.js version, platform, architecture, OS hostname, process uptime, configured MCP roots, and the server's READ_ONLY/ALLOW_EXEC/CMD_TIMEOUT settings. No environment variables or secrets are exposed. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "system_resources",
    description: "Return live system resource metrics, complementing env_info's static facts: CPU (core count, model, 1/5/15-min load averages via os.loadavg), memory (total/free/used bytes and used percent via os.totalmem/freemem), and per-configured-root disk space (total/free bytes and used percent via fs.statfsSync — omitted with an error note per-root if unsupported on this Node/OS). No secrets or paths beyond configured roots are exposed. Returns { cpu: {cores, model, loadAvg1, loadAvg5, loadAvg15}, memory: {totalBytes, freeBytes, usedBytes, usedPercent}, disks: [{root, path, totalBytes, freeBytes, usedPercent, error?}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "which_command",
    description: "Resolve an executable's full path(s) by searching process.env.PATH (honouring PATHEXT on Windows: .COM/.EXE/.BAT/.CMD by default), so an agent can check whether a tool is installed before calling run_command/start_process with it. Zero-dependency, read-only (fs.statSync checks only — never spawns anything), so unlike run_command/start_process this does NOT require MCP_ALLOW_EXEC. On POSIX, a match must also have at least one executable bit set (mode & 0o111); on Windows any file matching a PATHEXT extension counts. 'command' must be a bare executable name with no path separators (e.g. 'node', not './node' or an absolute path) — this is a PATH lookup, not a general file-existence oracle; use file_info for a specific path. Returns { command, platform, found, resolvedPath, allMatches } where resolvedPath is the first match (the one that would actually run) and allMatches lists every match found across PATH, in search order. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Bare executable name to resolve, e.g. 'node', 'git', 'python3'. No path separators." },
      },
      required: ["command"],
    },
  },
  {
    name: "scan_todos",
    description: "Recursively scan a file or directory for TODO/FIXME/HACK/XXX/BUG-style comment markers (configurable). Honours MCP_IGNORE (node_modules, .git, etc.), skips binary files (NUL-byte heuristic), and caps results at max_matches. Case-insensitive by default. Useful for surfacing technical debt / follow-up markers left in code. Returns { path, filesScanned, totalMatches, truncated, byMarker: {MARKER: count}, matches: [{file, line, marker, text}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path:           { type: "string", description: "File or directory to scan (default: first root)." },
      markers:        { type: "array", items: { type: "string" }, description: "Marker words to search for (default: TODO, FIXME, HACK, XXX, BUG). Matched as whole words." },
      extensions:     { type: "array", items: { type: "string" }, description: "Directory mode only: restrict to files with these extensions, e.g. ['.js', '.ts']." },
      case_sensitive: { type: "boolean", description: "Match markers case-sensitively (default: false)." },
      max_matches:    { type: "number", description: "Maximum total matches to return (1–5000, default: 500)." },
    }},
  },
  {
    name: "scan_conflict_markers",
    description: "Recursively scan a file or directory for unresolved git merge-conflict markers (<<<<<<<, =======, >>>>>>>). Honours MCP_IGNORE (node_modules, .git, etc.), skips binary files (NUL-byte heuristic), and caps results at max_matches. Useful as a post-patch/post-merge safety check for agents that apply patches or merges. Returns { path, filesScanned, totalMatches, truncated, filesAffected, matches: [{file, line, markerType, text}] } where markerType is 'start'|'separator'|'end'. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path:        { type: "string", description: "File or directory to scan (default: first root)." },
      extensions:  { type: "array", items: { type: "string" }, description: "Directory mode only: restrict to files with these extensions, e.g. ['.js', '.ts']." },
      max_matches: { type: "number", description: "Maximum total matches to return (1–5000, default: 500)." },
    }},
  },
  {
    name: "file_stats",
    description: "Compute aggregate statistics for a directory tree: total file count, total/avg/max/min byte sizes, breakdown by file extension (sorted by total bytes), and a top-N list of the largest files. MCP_IGNORE'd directories (e.g. node_modules, .git) are excluded. Useful for understanding project composition, finding bloated file types, or auditing disk usage. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path:       { type: "string", description: "Directory to analyse (default: first root)." },
      top_n:      { type: "number", description: "Number of largest files to list (1–100, default: 10)." },
      extensions: { type: "array",  items: { type: "string" }, description: "Optional: only consider files with these extensions, e.g. ['.js', '.ts']." },
    }},
  },
  {
    name: "dir_size_stats",
    description: "Directory-level disk-usage rollup for a directory tree, similar in spirit to `du -h --max-depth=N`. Each reported directory's `bytes`/`fileCount` are recursive — they include everything nested beneath it, however deep — but which directories are *listed* is capped by `max_depth` levels below the scanned root. Complements `file_stats` (which lists individual largest files) by answering 'which subdirectory is eating the most disk space' without eyeballing `file_tree` with sizes:true or manually summing `file_stats` entries. The scanned root itself is never listed as a directory entry — its totals are the top-level totalBytes/totalFiles/totalDirs fields instead. Directories are sorted by bytes descending and capped at top_n. MCP_IGNORE'd directories (e.g. node_modules, .git) are excluded. Returns { path, maxDepth, totalBytes, totalFiles, totalDirs, directories: [{path, depth, bytes, fileCount}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path:      { type: "string", description: "Directory to analyse (default: first root)." },
      max_depth: { type: "number", description: "How many levels of subdirectories below the root to report individually (1–10, default: 2)." },
      top_n:     { type: "number", description: "Max number of directories to return, sorted by bytes descending (1–200, default: 20)." },
    }},
  },
  {
    name: "disk_usage_summary",
    description: "One-call disk-usage snapshot for a directory tree, combining `file_stats` and `dir_size_stats` output into a single result so a caller doesn't need two separate tool round-trips for the common 'what's using space here' workflow. Returns { path, totalBytes, totalFiles, totalDirs, avgBytes, largestFiles: [{path, bytes}], largestDirs: [{path, depth, bytes, fileCount}], byExtension: [{ext, count, bytes}] }. MCP_IGNORE'd directories (e.g. node_modules, .git) are excluded. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path:      { type: "string", description: "Directory to analyse (default: first root)." },
      top_files: { type: "number", description: "Number of largest files to list (1–100, default: 10)." },
      top_dirs:  { type: "number", description: "Number of largest subdirectories to list (1–200, default: 10)." },
      max_depth: { type: "number", description: "How many levels of subdirectories to consider for top_dirs (1–10, default: 3)." },
    }},
  },
  {
    name: "csv_query",
    description: "Parse a CSV file (RFC 4180 — handles quoted fields, embedded commas and newlines, optional BOM) and return rows as structured JSON objects, OR grouped aggregate summary rows when 'aggregate' is supplied. Non-aggregate mode supports column projection (select a subset of columns), row slicing (offset + limit), and a simple single-column equality filter — returns { path, columns, totalRows (after filtering), returnedRows, rows }. Aggregate mode is triggered by a non-empty 'aggregate' array of {column, op} entries (op: 'sum'|'avg'|'count'|'min'|'max' — 'count' may omit column to count all rows in the group, or supply column to count only its non-empty values; 'sum'/'avg'/'min'/'max' require column and throw a clear -32602 error on any non-numeric value encountered, rather than silently producing NaN); optionally group rows first via 'group_by' (a column name) — with no group_by, the whole filtered table is treated as one implicit group. Groups are sorted deterministically by group key and each result field is named '<op>_<column>' (e.g. 'sum_price'), or bare 'count' when count's column is omitted. offset/limit paginate over the returned groups in aggregate mode (instead of over raw rows). Returns { path, groupBy, aggregates: [{column, op, field}], totalRows, groupCount, returnedGroups, groups: [{group?, <op>_<column>: value, ...}] } in aggregate mode. The first row is treated as a header by default (set has_header: false for header-less files, whose synthetic columns are named col0/col1/...). Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", required: ["path"], properties: {
      path:       { type: "string",  description: "Path to the CSV file to query." },
      columns:    { type: "array",   items: { type: "string" }, description: "Column names to include in output (default: all). Ignored in aggregate mode." },
      offset:     { type: "number",  description: "Skip the first N data rows, or first N groups in aggregate mode (default: 0)." },
      limit:      { type: "number",  description: "Maximum number of rows (or groups, in aggregate mode) to return (1–10000, default: 100)." },
      filter_col: { type: "string",  description: "Column name to filter on (exact equality, case-sensitive). Applied before grouping/aggregation." },
      filter_val: { type: "string",  description: "Value that filter_col must equal for a row to be included." },
      has_header: { type: "boolean", description: "Whether the first row is a header row (default: true). Set false for header-less CSVs." },
      group_by:   { type: "string",  description: "Column name to group rows by before aggregating. Requires a non-empty 'aggregate' array. Omit to aggregate over the whole (filtered) table as a single group." },
      aggregate:  { type: "array",   items: { type: "object", properties: {
                      column: { type: "string", description: "Column to aggregate. Required for sum/avg/min/max; optional for count." },
                      op:     { type: "string", description: "Aggregate function: 'sum', 'avg', 'count', 'min', or 'max'." },
                    }, required: ["op"] },
                    description: "Non-empty array of {column, op} aggregate specs. Presence of this array (non-empty) switches csv_query into aggregate/grouped-summary mode." },
    }},
  },
  {
    name: "http_fetch",
    description: "Make an outbound HTTP or HTTPS request and return the response status, headers, and body as text. Useful for calling external APIs, health-checking URLs, triggering webhooks, or fetching remote data without needing shell execution. Only http: and https: schemes are allowed (file://, data://, ftp:// etc. are rejected). Follows up to 5 redirects automatically. Response body is returned as UTF-8 text, truncated at 100 KB to avoid flooding the MCP channel. Does NOT persist the response to disk — combine with write_file if you need to save it. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", required: ["url"], properties: {
      url:     { type: "string",  description: "The target URL (must start with http:// or https://)." },
      method:  { type: "string",  description: "HTTP method: 'GET' (default), 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'." },
      headers: { type: "object",  description: "Extra request headers as key-value pairs, e.g. { 'Authorization': 'Bearer abc', 'Accept': 'application/json' }.", additionalProperties: { type: "string" } },
      body:    { type: "string",  description: "Request body string (only sent for POST, PUT, PATCH). Set Content-Type header accordingly." },
      timeout: { type: "number",  description: "Request timeout in seconds (default: 15, max: 60)." },
    }},
  },
  {
    name: "port_check",
    description: "Probe whether a TCP port on a host is open by attempting a raw socket connect. Returns { host, port, open, timeMs, error? } — 'open' is true only on a successful TCP connect; timeouts and connection errors (ECONNREFUSED, ENOTFOUND, etc.) both resolve with open:false plus a short 'error' code, never throw. Useful for checking if a local dev server, database, or remote service is listening before running dependent steps. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", required: ["host", "port"], properties: {
      host:    { type: "string", description: "Hostname or IP address to probe." },
      port:    { type: "number", description: "TCP port number (1-65535)." },
      timeout: { type: "number", description: "Connection timeout in seconds (default: 3, max: 30)." },
    }},
  },
  {
    name: "wait_for_port",
    description: "Poll a TCP port repeatedly until it opens or an overall timeout budget is exhausted — convenience wrapper around port_check for 'wait until service is up' workflows (e.g. waiting for a dev server or database to finish starting before running dependent steps). Returns { host, port, open, attempts, elapsedMs, error? }; 'open' is true as soon as any attempt connects successfully, false if the overall timeout elapses first (with the last attempt's error code, if any). Never throws on connection failure/timeout — only on invalid parameters. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", required: ["host", "port"], properties: {
      host:            { type: "string", description: "Hostname or IP address to probe." },
      port:            { type: "number", description: "TCP port number (1-65535)." },
      timeout:         { type: "number", description: "Overall wait budget in seconds across all attempts (default: 30, max: 60)." },
      interval:        { type: "number", description: "Seconds to wait between attempts (default: 1, min: 0.1)." },
      connect_timeout: { type: "number", description: "Per-attempt TCP connect timeout in seconds (default: adaptive, shrinks to fit remaining budget)." },
    }},
  },
  {
    name: "query_path",
    description: "Query a JSON or YAML file using a JSONPath-style expression. Supports a useful safe subset: $ (root), .key (child), ['key'] (bracket notation), [N] (array index), [start:end] (array slice — either side optional, negative indices count from the end), [*] (wildcard — all direct children), and .. (recursive descent / deep scan). Multiple matches (from [*], a slice, or ..) are returned as a JSON array; a single match is returned as-is. Format is auto-detected from the file extension (.json → JSON, .yaml/.yml → YAML) or forced via the 'format' argument. Returns { path, query, format, matchCount, truncated, result }. Useful for extracting all values at a given path across nested structures without writing traversal code. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", required: ["path"], properties: {
      path:   { type: "string", description: "Path to the JSON or YAML file to query." },
      query:  { type: "string", description: "JSONPath expression (e.g. '$.store.book[*].author', '$..name', '$.items[0]'). An empty string or omission returns the entire document." },
      format: { type: "string", description: "Optional explicit format override: 'json' or 'yaml'. Omit to auto-detect from the file extension." },
    }},
  },
  {
    name: "json_diff",
    description: "Structurally (semantically) diff two JSON or YAML documents — a data-aware counterpart to diff_files/file_diff_dir which compare TEXT. Parses both sides into real JS values and recursively compares them, reporting only genuine additions, removals, and value changes at their JSON-Pointer-style path (e.g. '/a/b/0/name'), ignoring key order/whitespace/formatting noise. Objects are compared key-by-key (missing-on-left => added, missing-on-right => removed, present-on-both-but-different => changed, recursed into when both sides are objects/arrays). Arrays are compared by INDEX POSITION, not by content/set matching (not an LCS/edit-distance diff) — documented behavior, not a bug. Type mismatches (e.g. object vs scalar) are reported as a single 'changed' entry rather than recursed into. Format is auto-detected per-file from the extension ('.json' -> JSON, '.yaml'/'.yml' -> YAML) or forced for both sides via 'format'. A max_changes budget (default 2000, hard cap 20000) caps the enumerated 'changes' array; totalChanges always reflects the true count even when truncated:true. Returns { left, right, format, identical, totalChanges, addedCount, removedCount, changedCount, truncated, changes: [{path, type, oldValue?, newValue?}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", required: ["left", "right"], properties: {
      left:        { type: "string", description: "Path to the 'before' / baseline JSON or YAML file." },
      right:       { type: "string", description: "Path to the 'after' / comparison JSON or YAML file." },
      format:      { type: "string", description: "Optional explicit format override applied to BOTH files: 'json' or 'yaml'. Omit to auto-detect per-file from its extension." },
      max_changes: { type: "number", description: "Cap on the number of enumerated change entries returned (default 2000, hard cap 20000). The true total is always reported via totalChanges regardless of this cap." },
    }},
  },
];

module.exports = { UTIL_SCHEMAS };
