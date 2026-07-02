# 🚀 MCP Common Server (HTTP + SSE) — v3.40.0

[![Protocol](https://img.shields.io/badge/MCP-Protocol-orange.svg)](https://modelcontextprotocol.io/)
[![Runtime](https://img.shields.io/badge/node-%3E%3D18.0.0-green.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Dependencies](https://img.shields.io/badge/dependencies-zero-brightgreen.svg)](package.json)

A high-performance, **zero-dependency** Model Context Protocol (MCP) server that gives AI models (like Claude Web, Claude Desktop, or custom developer agents) secure **read/write/exec** access to local files and directories over **HTTP + Server-Sent Events (SSE)**.

It is designed to be tunneled via `ngrok` (or any HTTPS reverse proxy) so that the online **Claude Web Client (claude.ai)** can interact directly with your local workspace as a custom Integration/Connector.

```
┌───────────┐    HTTPS/SSE Tunnel     ┌──────────────┐    Local File Access    ┌───────────────┐
│           │ ──────────────────────> │  mcp-common- │ ──────────────────────> │  Local Files  │
│ Claude.ai │                         │    Server    │                         │  & Subshells  │
│           │ <────────────────────── │ (Port 3000)  │ <────────────────────── │               │
└───────────┘    Server-Sent Events   └──────────────┘    Stdio Pipe Execution └───────────────┘
```

---

## 💎 Features

- **Zero Dependencies**: Pure Node.js built-ins. Extremely lightweight and fast to launch.
- **HTTP + SSE Transport**: Exposes a standard Server-Sent Events endpoint so it can be reached over the internet (via ngrok) from the browser client at `claude.ai`.
- **Multi-Root Workspace Mapping**: Jails the model into one or more named directory trees (aliases).
- **Synchronous & Persistent Subprocesses**: Allows models to execute shell commands (`run_command`) or spawn long-running background daemons (`start_process`, e.g. watchers, compilers) and poll stdout/stderr.
- **Advanced Jailing & Safety**: Enforces secure paths, prevents directory traversal (`../` escapes), and blocks write/execute capabilities entirely via environment configurations.
- **Batched Pipeline Operations**: Supports atomic step execution chains via `execute_pipeline` to group operations and save round-trip delays.

---

## ⚡ Quick Start

### 1. Configure the Environment
Copy the example configuration template to `.env` and adjust the variables for your setup:
```bash
cp .env.example .env
```
Open the `.env` file and configure your local workspace paths in `MCP_ROOTS` (e.g. `MCP_ROOTS=D:/proj1,D:/proj2`) and toggle execution permissions (`MCP_ALLOW_EXEC=true`) as needed.

### 2. Start the Server
Start the server using Node.js (Node 18+ required):
```bash
# Starts the server loading variables from your .env
node server-http.js
```
Alternatively, you can start the server inline by specifying environment variables directly:
```bash
# Multi-root mapping with command execution enabled
MCP_ALLOW_EXEC=true MCP_ROOTS=D:/proj1,D:/proj2 node server-http.js
```

### Exposing to Claude Web (claude.ai)
To let the browser client at `claude.ai` reach your local server:
1. Run `ngrok http 3000` to create a public HTTPS tunnel.
2. Copy your public ngrok URL (e.g. `https://xxxx.ngrok-free.app`).
3. Add `https://xxxx.ngrok-free.app/sse` as a **Custom Developer Connector** inside your Claude settings.

---

## ⚡ Using the stdio Transport

The stdio transport is ideal for **local MCP clients** that launch the server as a child process and communicate over stdin/stdout — including **Claude Desktop**, **Claude Code**, and any `"command" + "args"` style MCP launcher.

### Start the stdio Server
```bash
# Single root, no exec (read-only exploration)
MCP_ROOT_DIR=D:/myproject node server-stdio.js

# Multi-root, exec enabled
MCP_ALLOW_EXEC=true MCP_ROOTS=D:/proj1,D:/proj2 node server-stdio.js

# Or rely on your .env file
node server-stdio.js
```

### Claude Desktop / Code config (`claude_desktop_config.json`)
```json
{
  "mcpServers": {
    "local-files": {
      "command": "node",
      "args": ["D:/ClaudeDir/mcp-common-server/server-stdio.js"],
      "env": {
        "MCP_ROOTS": "D:/myproject",
        "MCP_ALLOW_EXEC": "true"
      }
    }
  }
}
```

---

## ⚙️ Environment Variables

Configure the server behavior by setting these variables:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port the server listens on |
| `MCP_ROOT_DIR` | — | Single root directory path (legacy fallback) |
| `MCP_ROOTS` | — | Comma-separated list of roots (highly recommended for multi-project workspaces) |
| `MCP_AUTH_TOKEN` | unset | Header requirement: `Authorization: Bearer <token>`. Unset = public |
| `MCP_READ_ONLY` | `false` | `true` hides and disables all modifying (write/create/delete) and shell execution tools |
| `MCP_ALLOW_EXEC` | `false` | `true` activates `run_command`, `execute_pipeline`, and background process tracking |
| `MCP_CMD_TIMEOUT` | `60` | Maximum timeout in seconds allowed for any single synchronous subshell command |
| `MCP_IGNORE` | `node_modules,.git,__pycache__,.nyc_output,dist,build` | Comma-separated patterns excluded from listings and search operations |

---

## 🗂️ Multi-Root Paths & Path Jailing

Each folder mapped in `MCP_ROOTS` is assigned a lowercased **alias** (derived from its folder name):
- **Single Root**: The prefix is optional (`src/index.js` and `myproject/src/index.js` resolve to the same file).
- **Multi-Root**: Mapped paths must use the alias prefix: e.g., `proj1/package.json` or `proj2/src/main.py`.
- **Security Jailing**: Any attempts to escape the root boundaries (e.g. using `../` traversal or absolute paths outside the configured mappings) are immediately rejected with an `Access denied` exception.

---

## 🛠️ Tool Reference

### 1. Read Tools (Always Available)
- **`read_directory`**: List folder contents recursively or shallowly.
- **`read_file`**: Read file contents with support for line-range pagination (`from_line` to `to_line`).
- **`read_files`**: Batch-read multiple files in a single request.
- **`read_allfiles`**: Bulk dump full contents of files matching specific extensions (e.g. `[".js", ".ts"]`).
- **`file_info`**: Fetch detailed metadata (size, permissions, timestamps, line counts).
- **`search_files`**: Run fast text search patterns (similar to grep/ripgrep) across files.
- **`search_lines`**: Grep-like line-level search — for each matching line in a file (or recursively in a directory), returns the 1-based line number, the matching line text, and optional surrounding context lines (`context` param, 0–10). Complements `search_files` (which returns file names) by pinpointing exact lines. Supports literal substring or regex matching, case-insensitive mode (`ignore_case`), extension filtering in directory mode, and a configurable result cap (`max_matches`, default 200). MCP_IGNORE'd directories are skipped automatically. Always available — does not require `MCP_ALLOW_EXEC`.
- **`find_files`**: Glob-based file finder.

### 1b. Utility Tools (Always Available)
- **`file_checksum`**: Compute MD5, SHA-1, SHA-256 (default), or SHA-512 digest of any file. Useful for integrity checks, change detection, and deduplication.
- **`hash_string`**: Compute MD5, SHA-1, SHA-256 (default), or SHA-512 digest of an arbitrary string payload — no file I/O involved. Sibling of `file_checksum` for callers that already have data in hand (an API response body, a generated config, a value read via another tool) and don't want to write it to a temp file just to hash it. Accepts `encoding: 'utf8' | 'base64' | 'hex'` for binary-ish payloads passed as text.
- **`zip_directory`**: Archive a directory tree to a `.zip` file using DEFLATE compression. Pure Node.js — zero dependencies. MCP_IGNORE'd entries (e.g. `node_modules`, `.git`, `dist`, `build`) are excluded automatically, same convention as every other directory-walking tool in this codebase. Write-gated: blocked when `MCP_READ_ONLY=true`.
- **`read_archive`**: Inspect the contents of a ZIP file without extracting it. Returns a structured manifest (entry names, sizes, compression method, CRC-32, timestamps) plus aggregate totals. Zero dependencies — reads the ZIP Central Directory directly.
- **`query_json`**: Parse a JSON file and extract a value by dot-notation path (e.g. `dependencies.lodash`, `users.0.name`). Returns the value and its type.
- **`query_data`**: Parse a JSON *or* YAML file and extract a value by dot-notation path, with format auto-detected from the file extension (`.json` → JSON, `.yaml`/`.yml` → YAML) or forced via an optional `format` argument. YAML parsing uses a minimal, zero-dependency parser (`lib/yamlOps.js`) covering block/flow mappings and sequences, scalars (strings/numbers/booleans/null), comments, and block scalars (`|` literal / `>` folded, with `-`/`+` chomping indicators and explicit indentation digits) — enough for typical config files (package-manifest-style, docker-compose-style, simple CI configs, multi-line scripts/certs). Not supported: anchors/aliases (`&`/`*`), multi-document streams (`---`/`...`), and YAML tags (`!!str` etc.) — these throw a descriptive error rather than silently misparsing. `query_json` remains available as a JSON-only, backward-compatible entry point.
- **`diff_files`**: Compute a unified diff between two text files inside the jail. Uses a pure-JS LCS-based Myers diff (zero dependencies). Returns the diff as a unified-diff string plus a structured summary (`hunks`, `additions`, `deletions`, `identical`). The `context` parameter controls surrounding context lines (default: 3). Always available — does not require `MCP_ALLOW_EXEC`.
- **`env_info`**: Return structured, read-only information about the server environment: Node.js version, platform, architecture, OS hostname, process uptime, configured MCP root aliases, and the server's READ_ONLY/ALLOW_EXEC/CMD_TIMEOUT settings. No environment variables or secrets are exposed.
- **`find_duplicates`**: Scan a directory recursively and find duplicate files by content hash (MD5/SHA-1/SHA-256/SHA-512). Files are first grouped by size (cheap to stat) and only files that share an exact size with at least one sibling are actually hashed, so unique-sized files are skipped entirely. Returns duplicate sets sorted by wasted disk space, each with `hash`, `size`, `count`, `wastedBytes`, and the sorted list of duplicate file paths, plus aggregate totals (`filesScanned`, `filesHashed`, `duplicateSetCount`, `totalDuplicateFiles`, `totalWastedBytes`). Optional `extensions` and `min_size` filters narrow the scan. Always available — does not require `MCP_ALLOW_EXEC`.
- **`compare_directories`**: Recursively compare two directory trees (`left`/`right`) by content hash and classify every relative file path as `added` (only in `right`), `removed` (only in `left`), `modified` (present in both, content differs), or `unchanged` (present in both, identical content). Relative paths are computed against each compared directory itself, so two trees with different names/locations but the same internal layout compare correctly. Returns the four classified path arrays plus a `summary` object with counts. Useful for verifying build outputs, comparing deployment artifacts, or auditing a refactor without needing git. Always available — does not require `MCP_ALLOW_EXEC`.
- **`query_path`**: Query a JSON or YAML file using a JSONPath-style expression — a more powerful sibling of `query_json`/`query_data`. Supports a useful, safe subset of JSONPath: `$` (root), `.key` (dot-notation child access), `['key']`/`["key"]` (bracket notation, for keys with spaces/specials), `[N]` (array index), `[start:end]` (array slice — either side optional, negative indices count from the end, always returns the standard single-match-unwraps-to-scalar shape), `[*]` (wildcard — all direct children of an object or array), and `..` (recursive descent / deep-scan, finds matching keys at any depth). Format is auto-detected from the file extension (`.json` → JSON, `.yaml`/`.yml` → YAML) or forced via an explicit `format` argument. Multiple matches (from `[*]` or `..`) are returned as a JSON array; a single match is returned as-is to mirror `query_json`'s single-result ergonomics. Zero npm deps — a hand-rolled tokenizer + recursive evaluator with a max recursion depth of 50 and a max result count of 10,000 to guard against pathological input. Returns `{ path, query, format, matchCount, truncated, result }`. Always available — does not require `MCP_ALLOW_EXEC`.
- **`file_diff_dir`**: Combines `compare_directories` (file-level classification) and `diff_files` (line-level unified diff) into one tool: recursively compares two directory trees by content hash, then produces a line-level unified diff for every `modified` file. `added`/`removed` files are reported by status only (no "other side" to diff against); `unchanged` files are omitted from the per-file list entirely (only counted in `summary`). A `max_diff_lines` budget (default 500, hard cap 5000 — clamped, not rejected, above the cap) caps the total unified-diff lines emitted across all files combined; once exhausted, remaining modified files are listed bare (`relPath` + `status`, no `unified` text) and `truncated: true` is set so callers can fall back to `diff_files` for those specific files. Optional `extensions` filter, optional `context` lines (default 3). Returns `{ left, right, algorithm, leftFileCount, rightFileCount, summary, diffs: [{relPath, status, unified?, additions?, deletions?, hunks?}], maxDiffLines, totalDiffLinesEmitted, truncated }`. Always available — does not require `MCP_ALLOW_EXEC`.
- **`json_diff`**: Structurally (semantically) diff two JSON or YAML documents — a data-aware counterpart to `diff_files`/`file_diff_dir`, which compare TEXT. Parses both sides into real JS values and recursively compares them, reporting only genuine additions, removals, and value changes at their JSON-Pointer-style path (e.g. `/a/b/0/name`), ignoring key order/whitespace/formatting noise. Objects are compared key-by-key (missing-on-left → `added`, missing-on-right → `removed`, present-on-both-but-different → `changed`, recursed into when both sides are objects/arrays). Arrays are compared by **index position**, not by content/set matching (documented behavior, not an LCS/edit-distance diff — that's what `diff_files` is for on serialised text). Type mismatches (e.g. object vs scalar) are reported as a single `changed` entry rather than recursed into. Format is auto-detected per-file from the extension (`.json` → JSON, `.yaml`/`.yml` → YAML) or forced for both sides via `format` (reports `"mixed"` when the two sides' auto-detected formats differ and no override is given). A `max_changes` budget (default 2000, hard cap 20000) caps the enumerated `changes` array; `totalChanges` always reflects the true count even when `truncated: true`. Returns `{ left, right, format, identical, totalChanges, addedCount, removedCount, changedCount, truncated, changes: [{path, type, oldValue?, newValue?}] }`. Complements `json_patch`/`yaml_patch`/`yaml_merge` (which apply structured changes) as the read-only counterpart that discovers what changed. Always available — does not require `MCP_ALLOW_EXEC`.
- **`count_lines`**: Count lines, words, and bytes in one or more files (like the Unix `wc` command). Returns per-file statistics and an aggregate `total`. Useful for quick code metrics, sanity-checking generated output, and reporting file statistics. Always available — does not require `MCP_ALLOW_EXEC`.
- **`file_tree`**: Pretty-print an ASCII directory tree (like the Unix `tree` command) for a given path. MCP_IGNORE'd directories (e.g. `node_modules`, `.git`) are excluded automatically. Supports a `depth` limit (1–10, default 4) and an optional `sizes` flag to annotate each file with its byte count. Output is truncated at 500 nodes to keep responses readable. Always available — does not require `MCP_ALLOW_EXEC`.
- **`hash_directory`**: Compute a single aggregate fingerprint of an entire directory tree by hashing all file contents together with their relative paths in sorted order. Any add, remove, rename, or content change in the tree produces a different hash. Useful for detecting whether a build output or deployment artifact has changed without comparing individual files. Supports MD5/SHA-1/SHA-256 (default)/SHA-512 and an optional `extensions` filter. Always available — does not require `MCP_ALLOW_EXEC`.
- **`base64_encode`**: Read a file and return its contents as a base64 string (standard RFC 4648 or URL-safe alphabet via `url_safe: true`). Useful for embedding binary files in JSON payloads, data URIs, or API requests. Always available — does not require `MCP_ALLOW_EXEC`.
- **`json_format`**: Parse a JSON file and re-serialise it with consistent formatting — pretty-print with a configurable `indent` (default 2) or minify (`indent: 0`). Returns the formatted string plus original/new byte sizes. Read-only by default; pass `in_place: true` to write the result back to the file (write-gated, see below).
- **`text_transform`**: Apply one or more named transforms to a file's text in sequence — `uppercase`, `lowercase`, `trim_lines`, `sort_lines`, `sort_lines_desc`, `dedupe_lines` (keeps first occurrence), `reverse_lines`, `remove_blank_lines`. Returns the transformed text plus before/after line and byte counts. Read-only by default; pass `in_place: true` to write the result back to the file (write-gated, see below).
- **`json_patch`**: Apply RFC 6902 JSON Patch operations (`add`, `remove`, `replace`, `move`, `copy`, `test`) to a JSON file. Path pointers use RFC 6901 JSON Pointer syntax (e.g. `/dependencies/lodash`, `/scripts/build`, `/items/0`). All operations are applied atomically in memory; a failing `test` op aborts the entire patch (no partial writes). Pass `apply: false` for a dry-run that returns the patched document without touching the file. The file is written back pretty-printed at the original indent level. Write-gated: blocked when `MCP_READ_ONLY=true`.
- **`apply_patch`**: Apply a unified diff (as produced by `diff_files`, `git diff`, or `diff -u`) to a file. Hunks are parsed from `@@ -L,C +L,C @@` headers and applied atomically — the whole modified content is assembled in memory and written to disk only if every hunk succeeds. Strict mode (default, `strict: true`) verifies that each context line in the patch matches the file exactly, so a patch meant for a different file version is safely rejected; fuzzy mode (`strict: false`) skips context verification and applies by position only. Pass `dry_run: true` to preview the patched text without writing. Returns `{ path, hunksApplied, additions, deletions, originalSize, newSize }` (plus `patched` text in dry-run mode). Write-gated: blocked when `MCP_READ_ONLY=true`.
- **`unzip_archive`**: Extract a ZIP file's contents into a directory inside the jail. Companion to `zip_directory` (creates ZIPs) and `read_archive` (inspects ZIPs). Validates every entry name **before any file is written** — rejects the whole archive if any entry contains an absolute path (`/etc/passwd`, `C:\…`) or a `..` traversal segment (Zip Slip protection). Supports `stored` (method 0) and `deflate` (method 8) entries. The destination directory is created automatically; pass `overwrite: true` to extract into an already-existing destination (colliding files are overwritten, non-colliding destination files are preserved — merge semantics). Returns `{ extracted, merged, filesExtracted, directoriesCreated, totalBytes }`. Write-gated: blocked when `MCP_READ_ONLY=true`.
- **`yaml_patch`**: Apply structured mutation operations to a YAML file without requiring the caller to hand-write a serializer. Operations: `set` (write a value at a dot-notation key path such as `services.web.ports`, creating intermediate mapping keys automatically), `delete` (remove a key from a mapping or splice an item from a sequence by index), `insert_at` (insert a value into a sequence at a given 0-based index), `append_to` (append a value to the end of a sequence). The file is parsed using the existing zero-dependency `lib/yamlOps.js` parser, all operations are applied atomically in memory, and the result is re-serialised using `lib/yamlSerializeOps.js` and written back. Comments and original key ordering are **not** preserved (the parser is value-oriented, not a CST). Anchors/aliases and other unsupported YAML constructs are rejected at parse time. Pass `apply: false` for a dry-run that returns the patched document without touching the file. Returns `{ path, operationsApplied, apply, originalSize, newSize, result }`. Write-gated: blocked when `MCP_READ_ONLY=true`.
- **`yaml_merge`**: Deep-merge a `patch` YAML document (supplied inline as a string) onto a `base` YAML file on disk. Companion to `yaml_patch` (single-path structured mutations) — `yaml_merge` is for overlaying a whole config fragment at once, the way Helm values files or Kustomize overlays work. Mappings merge recursively (patch keys override base keys, keys present only in base are preserved); sequences in the patch fully **replace** the corresponding base sequence (not concatenated — use `yaml_patch`'s `append_to` for that); scalars in the patch replace the base scalar; if base/patch values have mismatched shapes (e.g. mapping vs scalar) the patch value wins outright; a `null` in the patch explicitly sets the key to `null` rather than being treated as absent. The base file is parsed, merged in memory with a pure (non-mutating) deep-merge function, re-serialised, and written back. Comments and original key ordering are **not** preserved. Pass `apply: false` for a dry-run that returns the merged document without touching the file. Returns `{ path, apply, originalSize, newSize, result }`. Write-gated: blocked when `MCP_READ_ONLY=true`.
- **`convert_data`**: Convert a JSON document to YAML or a YAML document to JSON, using the existing zero-dependency `lib/yamlOps.js`/`lib/yamlSerializeOps.js` parser/serialiser pair (or the built-in `JSON` object for the JSON side). Source format is auto-detected from the file's extension (`.yaml`/`.yml` → yaml, otherwise json), same convention as `query_data`/`query_path`, or forced via `format`. Target format defaults to "the other one" but can be forced with `to` — including re-serialising to the *same* format, a legitimate pretty-print/normalise use case rather than an error. `indent` controls JSON target spacing (default 2). Without a `destination`, this is a pure in-memory conversion/preview — nothing is written, so it works even under `MCP_READ_ONLY` for the no-destination case. With `destination`, the converted text is also written there (pass `apply: false` to preview the write without touching disk; the destination write itself is what's write-gated, blocked when `MCP_READ_ONLY=true`). Returns `{ path, sourceFormat, targetFormat, indent, converted, destination?, written? }`. Always returns `converted` regardless of whether a destination was given.
- **`csv_convert`**: Convert a CSV file to JSON or a JSON file to CSV, complementing `convert_data` (JSON ↔ YAML) and `csv_query` (read-only CSV querying). Reuses the same zero-dependency RFC-4180-compliant `parseCsvText` from `lib/csvOps.js` for the CSV-parsing side. Source format is auto-detected from the file's extension (`.csv` → csv, otherwise json), or forced via `format`; target format defaults to "the other one" but can be forced with `to` (same format on both sides is rejected — nothing to convert). CSV → JSON: with `has_header` (default true), each data row becomes a `{header: value}` object; with `has_header:false`, rows are returned as raw string arrays. JSON → CSV: the JSON value must be an array — if every element is a flat object, the output column set is the union of keys across all rows (first-seen order) and `has_header` controls whether a header row is emitted; if every element is itself an array, rows are written as-is; mixed/invalid shapes (a stray primitive, or a mix of objects and arrays) are rejected with a descriptive error rather than silently coerced. Same destination/apply/dry-run contract as `convert_data` — without a `destination`, this is a pure in-memory conversion/preview (works even under `MCP_READ_ONLY`); with `destination`, pass `apply: false` to preview the write without touching disk. Returns `{ path, sourceFormat, targetFormat, hasHeader, indent, converted, destination?, written? }`. Write-gated: blocked when `MCP_READ_ONLY=true` (even for the no-destination preview case, for consistency with the rest of this tool family).

- **`gzip_compress`** / **`gzip_decompress`**: Zero-dependency gzip compression using Node's built-in `zlib` (sync API). `gzip_compress` reads a source file and writes a gzipped destination file, returning `{ source, destination, originalBytes, compressedBytes, ratio }` (`level` 0-9, default 6). `gzip_decompress` reads a gzipped source and writes the decompressed bytes to a destination, returning `{ source, destination, compressedBytes, decompressedBytes }`; malformed/non-gzip input throws a descriptive error rather than crashing. Unlike `base64_encode`, both tools always write a real file to disk, so both are write-gated: blocked when `MCP_READ_ONLY=true`.

- **`brotli_compress`** / **`brotli_decompress`**: Zero-dependency Brotli compression using Node's built-in `zlib` Brotli API (sync). Mirrors `gzip_compress`/`gzip_decompress` exactly, but typically achieves better ratios on text at higher CPU cost. `brotli_compress` returns `{ source, destination, originalBytes, compressedBytes, ratio }` (`quality` 0-11, default 11). `brotli_decompress` returns `{ source, destination, compressedBytes, decompressedBytes }`; malformed/non-brotli input throws a descriptive error. Write-gated: blocked when `MCP_READ_ONLY=true`.


- **`file_stats`**: Compute aggregate statistics for a directory tree: total file count, total/average/max/min byte sizes, breakdown by file extension (sorted by total bytes descending), and a configurable top-N list of the largest files (`top_n`, default 10, max 100). MCP_IGNORE'd directories are excluded. Optional `extensions` filter narrows the analysis to matching file types. Useful for understanding project composition, finding bloated file types, or auditing disk usage. Always available — does not require `MCP_ALLOW_EXEC`.
- **`dir_size_stats`**: Directory-level disk-usage rollup for a directory tree, similar in spirit to `du -h --max-depth=N`. Each reported directory's `bytes`/`fileCount` are recursive (include everything nested beneath it, however deep), but which directories are *listed* is capped by `max_depth` levels below the scanned root (1–10, default 2). Complements `file_stats` (which lists individual largest files) by answering "which subdirectory is eating the most disk space" without eyeballing `file_tree` with `sizes:true` or manually summing `file_stats` entries. The scanned root itself is never listed as a directory entry — its totals are the top-level `totalBytes`/`totalFiles`/`totalDirs` fields instead. Directories are sorted by bytes descending and capped at `top_n` (1–200, default 20). MCP_IGNORE'd directories are excluded. Returns `{ path, maxDepth, totalBytes, totalFiles, totalDirs, directories: [{path, depth, bytes, fileCount}] }`. Always available — does not require `MCP_ALLOW_EXEC`.
- **`csv_query`**: Parse a CSV file (RFC 4180-compliant — handles quoted fields with embedded commas and newlines, CRLF line endings, double-quote escaping `""` → `"`, optional BOM) and return rows as structured JSON objects, OR grouped aggregate summary rows when `aggregate` is supplied. Non-aggregate mode supports `columns` projection (select a subset of columns), row slicing (`offset` + `limit`, max 10000), and a simple equality filter (`filter_col` + `filter_val`, exact case-sensitive string match) — returns `{ path, columns, totalRows, returnedRows, rows }`. Aggregate mode is triggered by a non-empty `aggregate` array of `{column, op}` entries (`op`: `sum`/`avg`/`count`/`min`/`max` — `count` may omit `column` to count all rows in the group, or supply `column` to count only its non-empty values; `sum`/`avg`/`min`/`max` require `column` and throw a clear -32602 error on any non-numeric value rather than silently producing NaN); optionally group rows first via `group_by` (a column name) — with no `group_by`, the whole filtered table is treated as one implicit group. Groups are sorted deterministically by group key, and each result field is named `<op>_<column>` (e.g. `sum_price`), or bare `count` when count's column is omitted. `offset`/`limit` paginate over the returned groups in aggregate mode (instead of over raw rows). Returns `{ path, groupBy, aggregates: [{column, op, field}], totalRows, groupCount, returnedGroups, groups }` in aggregate mode. The first row is treated as a header by default; set `has_header: false` for header-less files (columns are named `col0`, `col1`, …). Always available — does not require `MCP_ALLOW_EXEC`.
- **`http_fetch`**: Make an outbound HTTP or HTTPS request and return the response status, headers, and body as text. Useful for calling external APIs, health-checking URLs, triggering webhooks, or fetching remote data without needing shell execution. Only `http:`/`https:` schemes are allowed (`file://`, `data://`, `ftp://`, etc. are rejected). Supports `method` (GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS), `headers`, `body`, and `timeout` (seconds, default 15, max 60). Follows up to 5 redirects automatically (redirect loops and excess hops are rejected). Response body is returned as UTF-8 text, truncated at 100 KB (`truncated: true` when this happens) to avoid flooding the MCP channel. Does NOT persist the response to disk — combine with `write_file`/`create_file` if you need to save it. Returns `{ url, status, statusText, ok, redirected, headers, body, bodySize, truncated }`. `execute_pipeline` steps that call `http_fetch` are fully awaited, so chained results are real resolved values, never dangling promises. Always available — does not require `MCP_ALLOW_EXEC`.

### 1c. Git Metadata Tools (Always Available, Read-Only)
- **`git_status`**: Structured branch/tracking summary — current branch, upstream, ahead/behind counts, and staged/unstaged/untracked/conflicted file counts and entries.
- **`git_log`**: Last N commits as structured JSON (hash, short hash, author, email, ISO date, subject, body). Supports filtering by file path and reading from a specific branch/ref. Optional `include_files: true` attaches a `filesChanged: [{path, additions, deletions}]` array to each commit (additions/deletions are `null` for binary files) — costs a second `git log --numstat` call, useful for seeing what each of the last N commits touched without a separate `git_show`/`git_diff` call per commit.
- **`git_blame`**: Per-line authorship for a file — line number, content, commit hash, author, date, and commit summary. Supports an optional `from_line`/`to_line` range.
- **`git_diff`**: Unified diff between repository states. Four modes: working tree vs HEAD (default), staging index vs HEAD (`staged: true`), working tree vs a specific ref (`from_ref` only), or commit-to-commit (`from_ref` + `to_ref`). Optional `file` argument restricts the diff to a single file/directory. Returns the unified diff text plus structured statistics (`additions`, `deletions`, `hunks`, `changedFiles` with status codes A/D/M/R). Set `stat_only: true` to skip generating the unified diff text entirely and get back only per-file added/deleted line counts (`unified` is `null`, `changedFiles[].additions`/`.deletions` populated instead) — useful for a quick "what changed and how much" overview before deciding whether to pull the full diff; binary files report `additions`/`deletions` as `null` rather than a bogus 0. Always available — does not require `MCP_ALLOW_EXEC`.
- **`git_stash_list`**: Structured list of all `git stash` entries in the repository. Each entry includes `index`, `ref` (`stash@{N}`), `message`, `author`, `email`, and an ISO 8601 `date`. Returns `{ count: 0, stashes: [] }` when there are no stashes. Always available — does not require `MCP_ALLOW_EXEC`.
- **`git_branch_list`**: List of branches in a repository with the current-branch marker and last-commit metadata for each (`lastCommitHash`, `lastCommitShortHash`, `lastCommitDate`, `lastCommitSubject`, `lastCommitAuthor`). By default lists only local branches (`refs/heads`); set `include_remote: true` to also include remote-tracking branches (`refs/remotes`), excluding the synthetic `origin/HEAD` pointer ref. Returns `{ currentBranch, count, branches }`. Always available — does not require `MCP_ALLOW_EXEC`.
- **`git_show`**: Return the content of a file as it existed at a specific commit/ref, without checking it out into the working tree — reads historical file content directly from git's object store. The `ref` (defaults to `HEAD` when omitted/blank) is resolved to a full 40-char commit hash first, so the result is unambiguous even for relative refs (`HEAD~2`, a branch name, a tag) and an unknown ref surfaces a clear error instead of a raw git failure. Distinguishes a path that does not exist at that ref from a path that is a directory (tree) rather than a file (blob) at that ref. Binary content is detected via a NUL-byte-in-first-8000-bytes heuristic — `isBinary: true` and `content: null` in that case, while `size` is still reported. Returns `{ ref, resolvedHash, file, size, isBinary, content }`. Always available — does not require `MCP_ALLOW_EXEC`.
- **`git_tag_list`**: List all tags in a git repository with their target commit hash, date, and message, most recent first. Handles both lightweight tags (a plain ref pointing directly at a commit — the reported hash/date/message describe that commit) and annotated tags (a ref pointing at a tag object with its own tagger date and message — `isAnnotated: true`, and `hash` is dereferenced to the tag's target commit). Returns an empty list (not an error) for a repository with no tags. Returns `{ count, tags: [{ name, hash, isAnnotated, date, message }] }`. Always available — does not require `MCP_ALLOW_EXEC`.
- **`git_reflog`**: List reflog entries for a ref (default `HEAD`) — every place that ref has pointed to recently, including commits no longer reachable from any branch after a hard reset, an amend, or an interactive rebase. This is information `git_log` alone cannot show, since `git_log` only walks the current ancestry graph, not the ref's own history of movements. Each entry includes the reflog selector (e.g. `HEAD@{0}`), the target commit hash, the reflog action git itself recorded (e.g. `commit: fix bug`, `checkout: moving from main to feature`, `reset: moving to HEAD~1`), and the commit's own subject line (kept separate from the action since they can differ, e.g. after a checkout or reset). `limit` caps the number of entries returned (1–500, default 30). A ref with no reflog entries yet returns an empty list rather than an error. Returns `{ ref, count, entries: [{ selector, hash, shortHash, action, subject, author, email, date }] }`. Always available — does not require `MCP_ALLOW_EXEC`.
- **`git_cherry`**: List commits on `head` (default `HEAD`) that are not yet in `upstream`, using git's own patch-equivalence detection (`git cherry -v`) rather than plain ancestry comparison. Each commit is marked `unmerged` (truly unique to head, not yet in upstream) or `equivalent` (the commit object itself isn't reachable from upstream, but an identical patch already is — e.g. because it was cherry-picked or the branch was rebased). This distinction matters: a plain two-ref diff (`git_diff`/`git_log` with two refs) would misreport an already-rebased or already-cherry-picked commit as still unmerged, since it only compares ancestry/tree state, not patch content. `upstream` is required (the merge target is ambiguous otherwise); `head` defaults to `HEAD`. Returns `{ upstream, head, count, unmergedCount, equivalentCount, commits: [{ hash, shortHash, subject, status }] }`. Always available — does not require `MCP_ALLOW_EXEC`.
- **`git_ownership`**: Aggregate `git blame` line counts by author for a single file or an entire directory tree — a "who owns this code" query. For a directory, enumerates tracked files via `git ls-files` (respects `.gitignore`, only tracked files considered) up to `max_files` (1–500, default 100 — remaining files are omitted with `truncated: true` rather than erroring), blames each one using the compact `git blame --porcelain` format (not `--line-porcelain`, so headers aren't repeated per line), and sums line counts per author across the whole set. In directory mode, a file `git blame` can't process (e.g. binary) is recorded in `filesSkipped: [{path, reason}]` rather than aborting the scan; in single-file mode a blame failure is surfaced directly, since the caller named exactly that file. Optional `extensions` filter narrows directory-mode scans. Repo-root discovery walks upward from the target looking for `.git`, but never ascends above the jailed MCP root the path was resolved against — this prevents an unrelated ancestor repository outside the sandbox (e.g. a dotfiles repo in the user's home directory) from ever being silently adopted. Returns `{ path, filesScanned, filesSkipped, truncated, totalLines, authors: [{name, lines, percentage}] }` sorted by lines descending. Always available — does not require `MCP_ALLOW_EXEC`.

These eleven never require `MCP_ALLOW_EXEC` (they only read repo metadata via `git`, never modify the working tree) and are jailed through the same root/path safety as every other tool. Arguments passed through to `git` are validated against shell metacharacters before use.

All eleven tools resolve the true repository root via a jail-bounded upward `.git` search (`findRepoRoot` in `lib/gitOpsHelpers.js`) before running any `git` command — a `path` argument nested two or more levels inside a repo (with no `.git` in its immediate parent) is correctly discovered rather than silently reporting "not a git repository", while the search still never ascends above the jailed MCP root the path was resolved against (originally hardened for `git_ownership`, now shared by `git_status`/`git_log`/`git_blame`/`git_diff`/`git_stash_list`/`git_branch_list`/`git_show`/`git_tag_list`/`git_reflog`/`git_cherry` too).

### 2. Write Tools (Disabled when `MCP_READ_ONLY=true`)
- **`write_file`**: Write/overwrite files (supports partial line range replacements).
- **`write_files`**: Batch-write content updates across multiple files.
- **`create_file`**: Create a new file (fails if the file already exists).
- **`create_files`**: Batch-create multiple new files.
- **`delete_file` / `delete_files`**: Delete files.
- **`move_file` / `copy_file`**: Relocate or duplicate a file inside the jail, audited for cross-root/symlink/EXDEV safety. Works across directories and across configured roots — including across filesystems/drives, via an automatic copy+delete fallback when the OS rejects a direct cross-device rename (`EXDEV`). Rejects directory sources with a clear error (use `create_directory`/`delete_directory`/a recursive copy pipeline for directory trees instead). Fails if the destination already exists unless `overwrite: true` is passed. A symlink living inside a root that points outside it (on either the source or destination side) is detected via a realpath check and rejected, even though the lexical path itself looked jailed. Moving/copying a path to itself is a safe no-op (`{ noop: true }`) rather than relying on incidental OS rename/copy-to-self behavior.
- **`move_directory` / `copy_directory`**: Recursive-tree variants of `move_file`/`copy_file`, built on the same audited safety conventions. `move_directory` tries a fast whole-tree rename first (only when the destination doesn't already exist) and falls back to a recursive copy+delete when the OS rejects the rename as cross-device (`EXDEV`) or when merging into an existing destination (pass `overwrite: true` to merge — colliding relative paths are overwritten, non-colliding files on both sides are kept). Rejects non-directory sources. Any symlink found *anywhere inside* the source tree aborts the whole operation before anything is written — a partially-applied recursive copy/move is worse than no operation at all. Same-path moves/copies are a safe no-op (`{ noop: true }`).
- **`create_directory` / `delete_directory`**: Create and remove folders recursively.
- **`replace_in_file`**: Find-and-replace strings in one file, or in bulk across every matching file under a directory tree in a single call. Supports plain string or regex substitution (`is_regex: true`, with real `$1`/`$2` capture-group support in the replacement string). When `path` is a directory, walks it recursively (respecting `MCP_IGNORE`, optionally narrowed by `extensions`) and applies the same search/replace to every file, returning a per-file breakdown plus `filesScanned`/`filesModified`/`totalReplacements` totals. Pass `dry_run: true` to preview exactly what would change (per-file replacement counts and resulting sizes) without writing anything or creating `.bak` backups — safe to run first on a large tree before committing to the real edit. Creates a `.bak` backup of each modified file on a real (non-dry-run) write.
- **`truncate_file`**: Shrink a file to its first N lines (`lines` param) or first N bytes (`bytes` param). Exactly one must be supplied. If the file is already shorter than the limit it is left untouched (`truncated: false`).
- **`append_file`**: Append text to the end of a file. Creates the file (and any missing parent directories) if it does not exist.
- **`base64_decode`**: Decode a base64 (or URL-safe base64) string and write the result as a binary file. Tolerant of whitespace/line-wrapped input (e.g. MIME-style 76-char wrapping). Validates the input is genuinely valid base64 before writing — rejects malformed input with a descriptive error rather than writing garbage. Parent directories of the destination are created automatically.

### 3. Execution Tools (Enabled when `MCP_ALLOW_EXEC=true`)
- **`run_command`**: Runs a shell command synchronously and returns `exitCode`, `stdout`, and `stderr`.
- **`start_process`**: Spawns a persistent background process (e.g. dev server, bundler, watcher).
- **`get_process_output`**: Read buffered output from a background process and optionally clear the buffer.
- **`kill_process`**: Send termination signals (e.g. `SIGTERM`, `SIGKILL`) to a running background process.
- **`list_processes`**: Track, monitor, and list all active background processes.
- **`execute_pipeline`**: Chained execution of sequential operations (e.g. write file, run build command, clean up temp files) in a single request.

### 4. Browser Automation Tools (Enabled when `MCP_ALLOW_EXEC=true`)
Stealth Playwright (Chromium) sessions — `playwright-extra` + `puppeteer-extra-plugin-stealth`.
- **`browser_launch`**: Launch a stealth Chromium context/page. Returns `session_id`.
- **`browser_navigate`**: Navigate a session's page to a URL, waits for load.
- **`browser_get_content`**: Return page/element `outerHTML` or `innerText` (`mode`), optional CSS `selector` scope.
- **`browser_evaluate`**: Run JS in the page context via `page.evaluate`, returns the JSON-safe result.
- **`browser_click`**: Click an element by CSS selector.
- **`browser_type`**: Fill/type text into an element by CSS selector.
- **`browser_screenshot`**: Capture a PNG screenshot to a jailed path.
- **`browser_get_console_logs`**: Return a session's buffered browser console messages.
- **`browser_list_sessions`**: List active browser sessions.
- **`browser_close`**: Close a session's page/context/browser and free it.
- **`browser_wait_for_selector`**, **`browser_go_back`/`browser_go_forward`/`browser_reload`**, **`browser_get_cookies`/`browser_set_cookies`**, **`browser_pdf`**, **`browser_select_option`**, **`browser_press_key`**, **`browser_wait_for_navigation`**: follow-up navigation/interaction tools.
- **`browser_hover`**: Move the mouse over an element without clicking.
- **`browser_upload_file`**: Set file(s) on a `<input type=file>` element via `files`/`path`.
- **`browser_scroll`**, **`browser_double_click`**, **`browser_right_click`**, **`browser_drag_and_drop`**: extra interaction tools.
- **`browser_download`**: Click a selector that triggers a download and save it to a jailed path.
- **`browser_get_attribute`**: Read a named HTML attribute from an element.
- **`browser_is_visible`**, **`browser_is_checked`**: query element visibility/checkbox state.
- **`browser_check`**, **`browser_uncheck`**: set checkbox/radio state.
- **`browser_get_element_info`**: bounding box, tag, text, and attributes of an element in one call.
- **`browser_new_page`**, **`browser_switch_page`**, **`browser_list_pages`**, **`browser_close_page`**: multi-tab support within a session.
- **`browser_network_start`/`browser_network_stop`/`browser_get_network_requests`**: capture and inspect request/response/failure events.
- **`browser_route`/`browser_unroute`**: intercept requests — abort, fulfill with a custom response, or continue.
- **`browser_emulate`**: runtime-change viewport, geolocation, color-scheme, or offline state (`browser_launch` also takes `device_scale_factor`/`timezone_id`/`locale` for values Playwright can only set at launch).
- **`browser_set_viewport`**: thin dedicated wrapper for just the viewport-resize slice of `browser_emulate`, for callers who want a narrower schema.
- **`browser_set_extra_headers`**: set custom per-request HTTP headers for a session's context.
- **`browser_get_local_storage`**/**`browser_set_local_storage`**: read/write `window.localStorage` (requires a real http/https page origin).
- **`browser_add_init_script`**: register JS source to run before page scripts on every navigation in the session (context.addInitScript).
- **`browser_get_page_metrics`**: navigation timing (DOMContentLoaded/load/TTFB), transfer size, resource count, JS heap usage.
- **`browser_expose_function`**/**`browser_get_exposed_calls`**: bind a Node-reachable callback on `window`, read recorded calls (no live channel back to the caller).
- **`browser_wait_for_response`**: block until a matching network response (by URL substring, optional status) arrives or times out.
- **`browser_get_storage_state`**: snapshot cookies + per-origin localStorage as a portable object; pass to `browser_launch`'s `storage_state` to resume a logged-in session in a fresh browser.
- **`browser_accessibility_snapshot`**: YAML-style accessibility tree of the page or a selector subtree (via Playwright's `ariaSnapshot`; the older `page.accessibility` API is gone from this Playwright version).
- **`browser_find_by_role`**: locate elements by ARIA role + optional accessible name (`page.getByRole`), returning bounding box/text/visibility per match.
- **`browser_handle_next_dialog`**/**`browser_get_dialog_log`**/**`browser_wait_for_dialog`**: arm a one-shot accept/dismiss (with optional `prompt_text`) for the next alert/confirm/prompt/beforeunload dialog — pass `queue: true` to pre-arm a FIFO sequence of N actions instead of just one; read the per-session dialog log (auto-dismissed and logged by default when unarmed); or block until the next dialog fires with `browser_wait_for_dialog` (`timeout_ms`, default 5000, max 30000).
- **`browser_list_frames`**, **`browser_frame_click`**, **`browser_frame_type`**, **`browser_frame_get_content`**, **`browser_frame_evaluate`**: enumerate and interact inside `<iframe>` boundaries via `page.frameLocator(frame_selector)`, since `page.locator()` can't pierce them. `browser_frame_evaluate` runs arbitrary JS inside the frame's own document (via its resolved Playwright `Frame`), mirroring `browser_evaluate` but scoped to the frame.

Tested via `npm run test:browser` (`test/browser-tests.js`, 209/209), independent of the frozen bulk suite below.

---

## 🧩 Code Layout

The server logic is split into small, single-purpose modules under `lib/`:

| File | Responsibility |
|---|---|
| `server-http.js` | HTTP + SSE transport, JSON-RPC routing (entry point) |
| `server-stdio.js` | stdio transport — newline-delimited JSON-RPC over stdin/stdout (for Claude Desktop/Code) |
| `lib/config.js` | `.env` loading and environment variable config |
| `lib/roots.js` | Multi-root setup, path jailing/safety, ignore-pattern checks |
| `lib/errors.js` | Shared `ToolError` class + `getErrorCode` helper (no circular deps) |
| `lib/toolsSchema.js` | Thin aggregator: concatenates schema groups from `lib/schemas/` |
| `lib/schemas/coreSchemas.js` | JSON-RPC input schemas for core read tools |
| `lib/schemas/gitSchemas.js` | JSON-RPC input schemas for git metadata tools |
| `lib/schemas/utilSchemas.js` | JSON-RPC input schemas for utility tools (checksums, archive, encoding, transforms, etc.) |
| `lib/schemas/writeSchemas.js` | JSON-RPC input schemas for write tools |
| `lib/schemas/execSchemas.js` | JSON-RPC input schemas for exec tools + `execute_pipeline` enum |
| `lib/executeTool.js` | Tool dispatch coordinator: validates args, enforces policy, delegates to dispatch modules |
| `lib/dispatchRead.js` | Handler functions for all read/git/utility tools |
| `lib/dispatchWrite.js` | Handler functions for all write/exec tools |
| `lib/moveOps.js` | Audited `move_file`/`copy_file` helpers: symlink-escape detection (realpath check), EXDEV cross-device fallback, overwrite-safety, directory-source rejection, same-path no-op |
| `lib/moveDirOps.js` | Recursive-tree `move_directory`/`copy_directory` helpers built on `lib/moveOps.js`'s safety primitives: whole-tree symlink rejection, fast-rename-first with copy+delete EXDEV/merge fallback, overwrite-gated merging, same-path no-op |
| `lib/unzipOps.js` | `unzip_archive` — extracts ZIP contents into a jailed destination: pure-JS Central Directory + LFH parser, Zip Slip prevention (all entry names validated before any write), DEFLATE (zlib.inflateRawSync) and stored methods, overwrite-gated merge semantics |
| `lib/stdioProtocol.js` | Pure (no I/O) stdio message-framing/dispatch logic shared by `server-stdio.js` |
| `lib/fileOps.js` | File/directory read, write, search, glob-find, replace, truncate, append helpers |
| `lib/processOps.js` | `run_command` and background process management |
| `lib/checksumOps.js` | `file_checksum` — MD5/SHA-1/SHA-256/SHA-512 digest of a file |
| `lib/zipDirOps.js` | `zip_directory` — pure-Node ZIP writer (LFH + Central Directory + EOCD, DEFLATE via zlib), MCP_IGNORE-aware, companion to `lib/unzipOps.js` |
| `lib/queryOps.js` | `query_json`/`query_data` — dot-path extraction from JSON/YAML files, plus the shared `traverseByPath` helper |
| `lib/diffFileOps.js` | `diff_files` — pure-JS LCS-based unified diff between two files (`diffFiles`/`computeEdits`) |
| `lib/envInfoOps.js` | `env_info` — read-only, secret-free snapshot of the server's runtime environment |
| `lib/hashStringOps.js` | `hash_string` — cryptographic digest of an arbitrary string payload, no file I/O |
| `lib/encodingOps.js` | Base64 encode/decode helpers: `base64Encode`, `base64Decode` |
| `lib/textOps.js` | JSON formatting and text-transform helpers: `jsonFormat`, `textTransform` |
| `lib/jsonPatchOps.js` | RFC 6902 JSON Patch engine: `jsonPatch` (all 6 ops, JSON Pointer RFC 6901, atomic apply, dry-run, indent-preserving) |
| `lib/archiveOps.js` | ZIP Central Directory reader: `read_archive` (no extraction, no deps) |
| `lib/duplicateOps.js` | Duplicate-file detection: `find_duplicates` (size-prefilter + content-hash grouping) |
| `lib/compareOps.js` | Two-directory-tree comparison: `compare_directories` (added/removed/modified/unchanged by content hash) |
| `lib/jsonPathOps.js` | JSONPath-style query engine: `query_path` — `$`, `.key`, `['key']`, `[N]`, `[start:end]` slice, `[*]` wildcard, `..` recursive descent, on JSON/YAML files |
| `lib/dirDiffOps.js` | Combined directory diff: `file_diff_dir` — wraps compareOps + diffFileOps diffFiles to produce file-level classification + per-modified-file unified diff with a `max_diff_lines` budget |
| `lib/jsonDiffOps.js` | Structural (semantic) document diff: `json_diff` — recursively compares two parsed JSON/YAML documents by JSON-Pointer-style path (added/removed/changed), array comparison by index, `max_changes` budget |
| `lib/wc.js` | Word/line/byte counter: `count_lines` (like Unix `wc`) |
| `lib/treeOps.js` | ASCII directory-tree printer: `file_tree` (like Unix `tree`) |
| `lib/hashDirOps.js` | Aggregate directory fingerprinting: `hash_directory` (single hash over sorted file contents + paths) |
| `lib/yamlOps.js` | Minimal zero-dependency YAML parser used by `query_data` |
| `lib/yamlSerializeOps.js` | Minimal zero-dependency YAML serialiser used by `yaml_patch` |
| `lib/yamlPatchOps.js` | Structured YAML mutation tool: `yaml_patch` (set/delete/insert_at/append_to, dry-run, atomic apply) |
| `lib/yamlMergeOps.js` | Deep-merge tool: `yaml_merge` (recursive mapping merge, array/scalar replace, dry-run) |
| `lib/convertOps.js` | Format conversion tool: `convert_data` (JSON ↔ YAML, auto-detect by extension, optional destination write) |
| `lib/csvConvertOps.js` | Format conversion tool: `csv_convert` (CSV ↔ JSON, auto-detect by extension, optional destination write) |
| `lib/gzipOps.js` | Compression tools: `gzip_compress` / `gzip_decompress` (zero-dep Node `zlib`, write-gated) |
| `lib/brotliOps.js` | Compression tools: `brotli_compress` / `brotli_decompress` (zero-dep Node `zlib` Brotli API, write-gated) |
| `lib/browserLaunch.js` | Stealth Playwright/Chromium session table: launch, session lookup, close |
| `lib/browserActions.js` | Thin barrel re-exporting `lib/browserActions/{core,storage,network,a11y}.js` |
| `lib/browserActions/core.js` | navigate/content/evaluate/click/type/interaction/element-state/scripting tools |
| `lib/browserActions/storage.js` | cookies/localStorage/storageState/headers/emulate tools |
| `lib/browserActions/network.js` | request/response capture + route/unroute interception tools |
| `lib/browserActions/a11y.js` | accessibility snapshot + find-by-role tools |
| `lib/dispatchBrowser.js` | `browser_*` tool name → handler map |
| `lib/schemas/browserSchemas.js` | JSON schemas for all `browser_*` tools |
| `lib/gitOps.js` | Read-only git metadata helpers: `git_status`, `git_blame`, `git_diff`, `git_show` (`git_log` moved to `lib/gitLogOps.js`) |
| `lib/gitLogOps.js` | `git_log`: commit history, with an optional `include_files` extension attaching a `filesChanged: [{path, additions, deletions}]` array per commit via a second numstat-based `git log` call matched back to each commit by hash |
| `lib/gitDiffStatOps.js` | `git_diff`'s `stat_only` mode — per-file added/deleted line counts via `git diff --numstat`, no unified diff text generated |
| `lib/gitTagOps.js` | Read-only git metadata helper: `git_tag_list` (lightweight + annotated tags, most-recent-first) |
| `lib/gitReflogOps.js` | Read-only git metadata helper: `git_reflog` (reflog entries for a ref, incl. commits unreachable via git_log) |
| `lib/gitCherryOps.js` | Read-only git metadata helper: `git_cherry` (commits on head not yet in upstream, patch-equivalence aware) |
| `lib/gitOpsHelpers.js` | Shared git helpers (`gitExec`, `gitExecBuffer`, `assertSafeArg`, `q`) used by `gitOps.js`, `gitStashOps.js`, and `gitBranchOps.js` — `gitExecBuffer` returns raw stdout as a Buffer (no utf8 coercion) for `git_show`'s binary-safe content reads |
| `lib/gitStashOps.js` | Read-only git stash helper: `git_stash_list` |
| `lib/gitBranchOps.js` | Read-only git branch helper: `git_branch_list` (local + optional remote-tracking branches, current-branch marker, last-commit metadata) |
| `lib/fileStatsOps.js` | Directory analytics: `file_stats` (per-extension breakdown, top-N largest files) |
| `lib/dirSizeOps.js` | Directory-level disk-usage rollup: `dir_size_stats` (recursive per-directory byte/file-count totals, depth-capped listing, like `du --max-depth=N`) |
| `lib/csvOps.js` | CSV parser + query helper: `csv_query` (RFC 4180, projection, slicing, equality filter, group_by/aggregate summary mode) |
| `lib/httpFetchOps.js` | Outbound HTTP/HTTPS request tool: `http_fetch` (zero-dep `http`/`https`, redirect following, body truncation, scheme validation) |
| `lib/gitOwnershipOps.js` | Read-only git metadata helper: `git_ownership` (blame-aggregate line counts by author for a file or directory tree, jail-bounded repo-root discovery) |

Isolated functional tests (no live server/inspector) live in `test/run-tests.js`, split into per-feature files under `test/sections/` sharing `test/test-harness.js` — run with `node test/run-tests.js`.

---

## 🛡️ License

This project is licensed under the MIT License - see the LICENSE file for details.
