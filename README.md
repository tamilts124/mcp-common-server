# 🚀 MCP Common Server (HTTP + SSE) — v3.12.0

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
- **`zip_directory`**: Archive a directory tree to a `.zip` file using DEFLATE compression. Pure Node.js — zero dependencies.
- **`read_archive`**: Inspect the contents of a ZIP file without extracting it. Returns a structured manifest (entry names, sizes, compression method, CRC-32, timestamps) plus aggregate totals. Zero dependencies — reads the ZIP Central Directory directly.
- **`query_json`**: Parse a JSON file and extract a value by dot-notation path (e.g. `dependencies.lodash`, `users.0.name`). Returns the value and its type.
- **`query_data`**: Parse a JSON *or* YAML file and extract a value by dot-notation path, with format auto-detected from the file extension (`.json` → JSON, `.yaml`/`.yml` → YAML) or forced via an optional `format` argument. YAML parsing uses a minimal, zero-dependency parser (`lib/yamlOps.js`) covering block/flow mappings and sequences, scalars (strings/numbers/booleans/null), comments, and block scalars (`|` literal / `>` folded, with `-`/`+` chomping indicators and explicit indentation digits) — enough for typical config files (package-manifest-style, docker-compose-style, simple CI configs, multi-line scripts/certs). Not supported: anchors/aliases (`&`/`*`), multi-document streams (`---`/`...`), and YAML tags (`!!str` etc.) — these throw a descriptive error rather than silently misparsing. `query_json` remains available as a JSON-only, backward-compatible entry point.
- **`diff_files`**: Compute a unified diff between two text files inside the jail. Uses a pure-JS LCS-based Myers diff (zero dependencies). Returns the diff as a unified-diff string plus a structured summary (`hunks`, `additions`, `deletions`, `identical`). The `context` parameter controls surrounding context lines (default: 3). Always available — does not require `MCP_ALLOW_EXEC`.
- **`env_info`**: Return structured, read-only information about the server environment: Node.js version, platform, architecture, OS hostname, process uptime, configured MCP root aliases, and the server's READ_ONLY/ALLOW_EXEC/CMD_TIMEOUT settings. No environment variables or secrets are exposed.
- **`find_duplicates`**: Scan a directory recursively and find duplicate files by content hash (MD5/SHA-1/SHA-256/SHA-512). Files are first grouped by size (cheap to stat) and only files that share an exact size with at least one sibling are actually hashed, so unique-sized files are skipped entirely. Returns duplicate sets sorted by wasted disk space, each with `hash`, `size`, `count`, `wastedBytes`, and the sorted list of duplicate file paths, plus aggregate totals (`filesScanned`, `filesHashed`, `duplicateSetCount`, `totalDuplicateFiles`, `totalWastedBytes`). Optional `extensions` and `min_size` filters narrow the scan. Always available — does not require `MCP_ALLOW_EXEC`.
- **`compare_directories`**: Recursively compare two directory trees (`left`/`right`) by content hash and classify every relative file path as `added` (only in `right`), `removed` (only in `left`), `modified` (present in both, content differs), or `unchanged` (present in both, identical content). Relative paths are computed against each compared directory itself, so two trees with different names/locations but the same internal layout compare correctly. Returns the four classified path arrays plus a `summary` object with counts. Useful for verifying build outputs, comparing deployment artifacts, or auditing a refactor without needing git. Always available — does not require `MCP_ALLOW_EXEC`.
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

- **`file_stats`**: Compute aggregate statistics for a directory tree: total file count, total/average/max/min byte sizes, breakdown by file extension (sorted by total bytes descending), and a configurable top-N list of the largest files (`top_n`, default 10, max 100). MCP_IGNORE'd directories are excluded. Optional `extensions` filter narrows the analysis to matching file types. Useful for understanding project composition, finding bloated file types, or auditing disk usage. Always available — does not require `MCP_ALLOW_EXEC`.
- **`csv_query`**: Parse a CSV file (RFC 4180-compliant — handles quoted fields with embedded commas and newlines, CRLF line endings, double-quote escaping `""` → `"`, optional BOM) and return rows as structured JSON objects. Supports `columns` projection (select a subset of columns), row slicing (`offset` + `limit`, max 10000), and a simple equality filter (`filter_col` + `filter_val`, exact case-sensitive string match). The first row is treated as a header by default; set `has_header: false` for header-less files (columns are named `col0`, `col1`, …). Returns `{ path, columns, totalRows, returnedRows, rows }`. Always available — does not require `MCP_ALLOW_EXEC`.
- **`http_fetch`**: Make an outbound HTTP or HTTPS request and return the response status, headers, and body as text. Useful for calling external APIs, health-checking URLs, triggering webhooks, or fetching remote data without needing shell execution. Only `http:`/`https:` schemes are allowed (`file://`, `data://`, `ftp://`, etc. are rejected). Supports `method` (GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS), `headers`, `body`, and `timeout` (seconds, default 15, max 60). Follows up to 5 redirects automatically (redirect loops and excess hops are rejected). Response body is returned as UTF-8 text, truncated at 100 KB (`truncated: true` when this happens) to avoid flooding the MCP channel. Does NOT persist the response to disk — combine with `write_file`/`create_file` if you need to save it. Returns `{ url, status, statusText, ok, redirected, headers, body, bodySize, truncated }`. `execute_pipeline` steps that call `http_fetch` are fully awaited, so chained results are real resolved values, never dangling promises. Always available — does not require `MCP_ALLOW_EXEC`.

### 1c. Git Metadata Tools (Always Available, Read-Only)
- **`git_status`**: Structured branch/tracking summary — current branch, upstream, ahead/behind counts, and staged/unstaged/untracked/conflicted file counts and entries.
- **`git_log`**: Last N commits as structured JSON (hash, short hash, author, email, ISO date, subject, body). Supports filtering by file path and reading from a specific branch/ref.
- **`git_blame`**: Per-line authorship for a file — line number, content, commit hash, author, date, and commit summary. Supports an optional `from_line`/`to_line` range.
- **`git_diff`**: Unified diff between repository states. Four modes: working tree vs HEAD (default), staging index vs HEAD (`staged: true`), working tree vs a specific ref (`from_ref` only), or commit-to-commit (`from_ref` + `to_ref`). Optional `file` argument restricts the diff to a single file/directory. Returns the unified diff text plus structured statistics (`additions`, `deletions`, `hunks`, `changedFiles` with status codes A/D/M/R). Always available — does not require `MCP_ALLOW_EXEC`.
- **`git_stash_list`**: Structured list of all `git stash` entries in the repository. Each entry includes `index`, `ref` (`stash@{N}`), `message`, `author`, `email`, and an ISO 8601 `date`. Returns `{ count: 0, stashes: [] }` when there are no stashes. Always available — does not require `MCP_ALLOW_EXEC`.
- **`git_branch_list`**: List of branches in a repository with the current-branch marker and last-commit metadata for each (`lastCommitHash`, `lastCommitShortHash`, `lastCommitDate`, `lastCommitSubject`, `lastCommitAuthor`). By default lists only local branches (`refs/heads`); set `include_remote: true` to also include remote-tracking branches (`refs/remotes`), excluding the synthetic `origin/HEAD` pointer ref. Returns `{ currentBranch, count, branches }`. Always available — does not require `MCP_ALLOW_EXEC`.

These six never require `MCP_ALLOW_EXEC` (they only read repo metadata via `git`, never modify the working tree) and are jailed through the same root/path safety as every other tool. Arguments passed through to `git` are validated against shell metacharacters before use.

### 2. Write Tools (Disabled when `MCP_READ_ONLY=true`)
- **`write_file`**: Write/overwrite files (supports partial line range replacements).
- **`write_files`**: Batch-write content updates across multiple files.
- **`create_file`**: Create a new file (fails if the file already exists).
- **`create_files`**: Batch-create multiple new files.
- **`delete_file` / `delete_files`**: Delete files.
- **`move_file` / `copy_file`**: Relocate or duplicate a file inside the jail, audited for cross-root/symlink/EXDEV safety. Works across directories and across configured roots — including across filesystems/drives, via an automatic copy+delete fallback when the OS rejects a direct cross-device rename (`EXDEV`). Rejects directory sources with a clear error (use `create_directory`/`delete_directory`/a recursive copy pipeline for directory trees instead). Fails if the destination already exists unless `overwrite: true` is passed. A symlink living inside a root that points outside it (on either the source or destination side) is detected via a realpath check and rejected, even though the lexical path itself looked jailed. Moving/copying a path to itself is a safe no-op (`{ noop: true }`) rather than relying on incidental OS rename/copy-to-self behavior.
- **`move_directory` / `copy_directory`**: Recursive-tree variants of `move_file`/`copy_file`, built on the same audited safety conventions. `move_directory` tries a fast whole-tree rename first (only when the destination doesn't already exist) and falls back to a recursive copy+delete when the OS rejects the rename as cross-device (`EXDEV`) or when merging into an existing destination (pass `overwrite: true` to merge — colliding relative paths are overwritten, non-colliding files on both sides are kept). Rejects non-directory sources. Any symlink found *anywhere inside* the source tree aborts the whole operation before anything is written — a partially-applied recursive copy/move is worse than no operation at all. Same-path moves/copies are a safe no-op (`{ noop: true }`).
- **`create_directory` / `delete_directory`**: Create and remove folders recursively.
- **`replace_in_file`**: Find-and-replace strings across files or folders.
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
| `lib/utilOps.js` | Utility helpers: `file_checksum`, `zip_directory`, `query_json`, `query_data`, `diff_files`, `env_info` |
| `lib/encodingOps.js` | Base64 encode/decode helpers: `base64Encode`, `base64Decode` |
| `lib/textOps.js` | JSON formatting and text-transform helpers: `jsonFormat`, `textTransform` |
| `lib/jsonPatchOps.js` | RFC 6902 JSON Patch engine: `jsonPatch` (all 6 ops, JSON Pointer RFC 6901, atomic apply, dry-run, indent-preserving) |
| `lib/archiveOps.js` | ZIP Central Directory reader: `read_archive` (no extraction, no deps) |
| `lib/duplicateOps.js` | Duplicate-file detection: `find_duplicates` (size-prefilter + content-hash grouping) |
| `lib/compareOps.js` | Two-directory-tree comparison: `compare_directories` (added/removed/modified/unchanged by content hash) |
| `lib/wc.js` | Word/line/byte counter: `count_lines` (like Unix `wc`) |
| `lib/treeOps.js` | ASCII directory-tree printer: `file_tree` (like Unix `tree`) |
| `lib/hashDirOps.js` | Aggregate directory fingerprinting: `hash_directory` (single hash over sorted file contents + paths) |
| `lib/yamlOps.js` | Minimal zero-dependency YAML parser used by `query_data` |
| `lib/yamlSerializeOps.js` | Minimal zero-dependency YAML serialiser used by `yaml_patch` |
| `lib/yamlPatchOps.js` | Structured YAML mutation tool: `yaml_patch` (set/delete/insert_at/append_to, dry-run, atomic apply) |
| `lib/yamlMergeOps.js` | Deep-merge tool: `yaml_merge` (recursive mapping merge, array/scalar replace, dry-run) |
| `lib/gitOps.js` | Read-only git metadata helpers: `git_status`, `git_log`, `git_blame`, `git_diff` |
| `lib/gitOpsHelpers.js` | Shared git helpers (`gitExec`, `assertSafeArg`, `q`) used by `gitOps.js`, `gitStashOps.js`, and `gitBranchOps.js` |
| `lib/gitStashOps.js` | Read-only git stash helper: `git_stash_list` |
| `lib/gitBranchOps.js` | Read-only git branch helper: `git_branch_list` (local + optional remote-tracking branches, current-branch marker, last-commit metadata) |
| `lib/fileStatsOps.js` | Directory analytics: `file_stats` (per-extension breakdown, top-N largest files) |
| `lib/csvOps.js` | CSV parser + query helper: `csv_query` (RFC 4180, projection, slicing, equality filter) |
| `lib/httpFetchOps.js` | Outbound HTTP/HTTPS request tool: `http_fetch` (zero-dep `http`/`https`, redirect following, body truncation, scheme validation) |

Isolated functional tests (no live server/inspector) live in `test/run-tests.js`, split into per-feature files under `test/sections/` sharing `test/test-harness.js` — run with `node test/run-tests.js`.

---

## 🛡️ License

This project is licensed under the MIT License - see the LICENSE file for details.
