# 🚀 MCP Common Server (HTTP + SSE) — v3.1.0

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
    "my-workspace": {
      "command": "node",
      "args": ["D:/ClaudeDir/mcp-common-server/server-stdio.js"],
      "env": {
        "MCP_ROOTS": "D:/proj1,D:/proj2",
        "MCP_ALLOW_EXEC": "true"
      }
    }
  }
}
```

The stdio transport **never** writes anything non-JSON-RPC to stdout (logs go to stderr only), so it is safe to pipe directly into any MCP client. It supports the full tool set — all tools available on the HTTP transport are equally available here, dispatched through the same `lib/executeTool.js` logic.

> **Note:** `PORT` and `MCP_AUTH_TOKEN` are not used by the stdio transport — authentication is handled by OS-level process ownership (only processes that can spawn `server-stdio.js` get access).

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
- **`find_files`**: Glob-based file finder.

### 1b. Utility Tools (Always Available)
- **`file_checksum`**: Compute MD5, SHA-1, SHA-256 (default), or SHA-512 digest of any file. Useful for integrity checks, change detection, and deduplication.
- **`zip_directory`**: Archive a directory tree to a `.zip` file using DEFLATE compression. Pure Node.js — zero dependencies.
- **`query_json`**: Parse a JSON file and extract a value by dot-notation path (e.g. `dependencies.lodash`, `users.0.name`). Returns the value and its type.
- **`query_data`**: Parse a JSON *or* YAML file and extract a value by dot-notation path, with format auto-detected from the file extension (`.json` → JSON, `.yaml`/`.yml` → YAML) or forced via an optional `format` argument. YAML parsing uses a minimal, zero-dependency parser (`lib/yamlOps.js`) covering block/flow mappings and sequences, scalars (strings/numbers/booleans/null), comments, and block scalars (`|` literal / `>` folded, with `-`/`+` chomping indicators and explicit indentation digits) — enough for typical config files (package-manifest-style, docker-compose-style, simple CI configs, multi-line scripts/certs). Not supported: anchors/aliases (`&`/`*`), multi-document streams (`---`/`...`), and YAML tags (`!!str` etc.) — these throw a descriptive error rather than silently misparsing. `query_json` remains available as a JSON-only, backward-compatible entry point.
- **`diff_files`**: Compute a unified diff between two text files inside the jail. Uses a pure-JS LCS-based Myers diff (zero dependencies). Returns the diff as a unified-diff string plus a structured summary (`hunks`, `additions`, `deletions`, `identical`). The `context` parameter controls surrounding context lines (default: 3). Always available — does not require `MCP_ALLOW_EXEC`.

### 1c. Git Metadata Tools (Always Available, Read-Only)
- **`git_status`**: Structured branch/tracking summary — current branch, upstream, ahead/behind counts, and staged/unstaged/untracked/conflicted file counts and entries.
- **`git_log`**: Last N commits as structured JSON (hash, short hash, author, email, ISO date, subject, body). Supports filtering by file path and reading from a specific branch/ref.
- **`git_blame`**: Per-line authorship for a file — line number, content, commit hash, author, date, and commit summary. Supports an optional `from_line`/`to_line` range.

These three never require `MCP_ALLOW_EXEC` (they only read repo metadata via `git`, never modify the working tree) and are jailed through the same root/path safety as every other tool. Arguments passed through to `git` are validated against shell metacharacters before use.

### 2. Write Tools (Disabled when `MCP_READ_ONLY=true`)
- **`write_file`**: Write/overwrite files (supports partial line range replacements).
- **`write_files`**: Batch-write content updates across multiple files.
- **`create_file`**: Create a new file (fails if the file already exists).
- **`create_files`**: Batch-create multiple new files.
- **`delete_file` / `delete_files`**: Delete files.
- **`move_file` / `copy_file`**: Relocate or duplicate files inside the jail.
- **`create_directory` / `delete_directory`**: Create and remove folders recursively.
- **`replace_in_file`**: Find-and-replace strings across files or folders.

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
| `lib/fileOps.js` | File/directory read, write, search, glob-find, replace helpers |
| `lib/processOps.js` | `run_command` and background process management |
| `lib/utilOps.js` | Utility helpers: `file_checksum`, `zip_directory`, `query_json`, `query_data`, `diff_files` |
| `lib/yamlOps.js` | Minimal zero-dependency YAML parser used by `query_data` |
| `lib/gitOps.js` | Read-only git metadata helpers: `git_status`, `git_log`, `git_blame` |
| `lib/toolsSchema.js` | JSON-RPC tool schema declarations (`TOOLS_ALL`) |
| `lib/errors.js` | Shared `ToolError` class + `getErrorCode` helper (no circular deps) |
| `lib/executeTool.js` | Tool dispatch switch + `execute_pipeline` |
| `lib/stdioProtocol.js` | Pure (no I/O) stdio message-framing/dispatch logic shared by `server-stdio.js` |

Isolated functional tests (no live server/inspector) live in `test/run-tests.js`, split into per-feature files under `test/sections/` sharing `test/test-harness.js` — run with `node test/run-tests.js`.

---

## 🛡️ License

This project is licensed under the MIT License - see the LICENSE file for details.
