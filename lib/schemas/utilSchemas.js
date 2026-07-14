"use strict";
const UTIL_SCHEMAS_1 = [
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
    name: "dir_diff_summary",
    description: "One-call semantic diff across a whole directory: composes compare_directories (file-level added/removed/modified/unchanged classification) with a per-modified-file SEMANTIC diff auto-dispatched by extension — .json/.yaml/.yml via json_diff (structural), .csv via csv_diff (positional/by-index row diff — no single key column is knowable generically across an arbitrary directory; call csv_diff directly with key_column for an identity diff), and everything else via check_binary_file + diff_files (binary files are reported but not diffed; text files get diff_files' line-level unified diff, with full unified diff text omitted by default via include_unified_diff:false to keep the summary small). A max_files budget (default 50, hard cap 500) caps how many *modified* files get a full per-file diff computed — compare_directories' own added/removed/unchanged lists are always returned in full (cheap, just relative paths); truncated:true is set when modifiedCount exceeds filesDiffed. Returns { left, right, addedCount, removedCount, modifiedCount, unchangedCount, added, removed, filesDiffed, truncated, diffs: [{path, kind, identical?, ...per-kind fields, error?}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", required: ["left", "right"], properties: {
      left:                 { type: "string",  description: "Path to the 'before' / baseline directory." },
      right:                { type: "string",  description: "Path to the 'after' / comparison directory." },
      extensions:           { type: "array",   items: { type: "string" }, description: "Optional: only consider files with these extensions in both trees." },
      max_files:            { type: "number",  description: "Cap on the number of modified files given a full per-file diff (default 50, hard cap 500)." },
      include_unified_diff: { type: "boolean", description: "Include full unified diff text for non-JSON/YAML/CSV text files (default: false — only line/hunk counts are returned)." },
    }},
  },
  {
    name: "find_binary_diffs",
    description: "Scans two directory trees and reports binary assets (images, fonts, compiled artifacts, archives) whose content changed, skipping text-diffable files entirely — delegate those to dir_diff_summary. Composes compare_directories (added/removed/modified/unchanged classification) with check_binary_file on each modified pair: only pairs where BOTH sides are binary are reported (a file that's binary on one side and text on the other, or a check_binary_file error on either side, is counted in skippedTextOrErrored, not reported). Instead of a byte-by-byte diff (rarely meaningful for binary content), each reported entry carries a checksum (file_checksum, default sha256) and size for both sides plus an identical flag (true if only mtime/permissions differ but content hash matches). A max_files budget (default 200, hard cap 2000) caps how many modified pairs are inspected; truncated:true is set when modifiedCount exceeds inspected. Returns { left, right, algorithm, addedCount, removedCount, modifiedCount, unchangedCount, inspected, truncated, skippedTextOrErrored, changedBinaryFiles: [{path, leftHash, rightHash, leftSize, rightSize, identical}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", required: ["left", "right"], properties: {
      left:       { type: "string", description: "Path to the 'before' / baseline directory." },
      right:      { type: "string", description: "Path to the 'after' / comparison directory." },
      extensions: { type: "array", items: { type: "string" }, description: "Optional: only consider files with these extensions in both trees." },
      max_files:  { type: "number", description: "Cap on the number of modified pairs inspected for binary-ness/checksum (default 200, hard cap 2000)." },
      algorithm:  { type: "string", description: "Checksum algorithm: 'md5', 'sha1', 'sha256' (default), or 'sha512'." },
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
    name: "semver_compare",
    description: "Parse and compare SemVer 2.0.0 version strings (major.minor.patch[-prerelease][+build]), per the official precedence rules (numeric prerelease identifiers compared numerically, alphanumeric compared lexically, a version with no prerelease is always greater than one with a prerelease at the same major.minor.patch; build metadata is ignored in comparisons). Pass 'version_b' to compare two versions directly (returns -1/0/1 plus a relation label), and/or 'range' to check whether 'version_a' satisfies a package.json-style comparator range — supports ^ (caret), ~ (tilde), >=, <=, >, <, = , x-ranges ('1.2.x', '1.x'), '*', and space-separated conjunctions ('>=1.2.0 <2.0.0', all must hold). At least one of 'version_b'/'range' is required. Returns { versionA, versionB?, comparison?, relation?, range?, satisfies? }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", required: ["version_a"], properties: {
      version_a: { type: "string", description: "The primary version to parse/compare, e.g. '1.2.3', '2.0.0-beta.1'." },
      version_b: { type: "string", description: "A second version to compare version_a against. Returns comparison (-1/0/1) and relation ('less_than'/'equal'/'greater_than')." },
      range:     { type: "string", description: "A comparator range to check version_a against, e.g. '^1.2.3', '~1.2', '>=1.0.0 <2.0.0', '1.2.x'." },
    }},
  },
  {
    name: "url_parse",
    description: "Parse a URL string into structured components using Node's built-in WHATWG URL parser (URL/URLSearchParams) — no regex hand-rolling. Returns { href, origin, protocol, username, password, hostname, port, pathname, search, searchParams, hash, isRelativeResolved }. `searchParams` groups repeated query keys into an array (e.g. '?a=1&a=2' -> {a:['1','2']}) instead of silently dropping duplicates. `password` is redacted to the literal string '[redacted]' unless `show_password:true` is passed, since URLs are often pasted from logs/config and may carry live credentials. A relative URL (no scheme/host) requires `base` to resolve against, or a clear -32602 validation error is thrown. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", required: ["url"], properties: {
      url:            { type: "string",  description: "The URL to parse. Max 4000 characters. May be relative if 'base' is given." },
      base:           { type: "string",  description: "Base URL to resolve a relative 'url' against (e.g. 'https://example.com')." },
      show_password:  { type: "boolean", description: "If true, include the raw password component instead of redacting it (default: false)." },
    }},
  },
  {
    name: "jwt_decode",
    description: "Decode a JWT's header and payload (base64url-encoded JSON) for dev-time inspection. NOT a security/verification tool — the signature segment is only reported as present/length, never checked, so a decoded payload must never be trusted as authenticated without separately verifying the signature. Annotates RFC 7519 NumericDate claims (exp/iat/nbf) with both raw seconds and ISO-8601, plus computed `expired`/`notYetValid` booleans against the current time (null if the claim is absent). Returns { header, payload, signature: {present, length, verified:false}, times, expired, notYetValid }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", required: ["token"], properties: {
      token: { type: "string", description: "The raw JWT string (three dot-separated base64url segments: header.payload.signature). Max 8000 characters." },
    }},
  },
  {
    name: "jwt_sign",
    description: "Create a signed JSON Web Token (JWT) using Node.js built-in crypto — zero npm dependencies. Supports HMAC (HS256/HS384/HS512) with a shared secret string, and RSA/EC asymmetric signing (RS256/RS384/RS512, ES256/ES384/ES512) with a PEM private key. Automatically sets 'iat' (issued-at). Optional convenience fields: expires_in (e.g. '1h', '30m', '7d', '90s', or raw seconds), not_before, issuer, subject, audience, jwt_id. Merge extra_header claims into the JOSE header. Returns { token, algorithm, header, payload, issuedAt, expiresAt }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", required: ["payload", "secret"], properties: {
      payload:      { type: "object", description: "JSON claims object to embed in the token. Must be a plain object (not an array). 'iat' is auto-set; 'exp'/'nbf' are set via 'expires_in'/'not_before'." },
      secret:       { type: "string", description: "Signing key. For HS*: any string (prefer \u226556 bits of entropy). For RS*/ES*: a PEM-encoded private key string." },
      algorithm:    { type: "string", description: "Signing algorithm: HS256 (default), HS384, HS512, RS256, RS384, RS512, ES256, ES384, or ES512." },
      expires_in:   { type: ["string", "number"], description: "Token lifetime: seconds as a number, or a string like '1h', '30m', '7d', '90s', '2w'. Sets the 'exp' claim relative to now." },
      not_before:   { type: ["string", "number"], description: "Seconds (or time string like '5m') until the token becomes valid. Sets the 'nbf' claim relative to now." },
      issuer:       { type: "string", description: "Sets the 'iss' (issuer) claim." },
      subject:      { type: "string", description: "Sets the 'sub' (subject) claim." },
      audience:     { type: ["string", "array"], items: { type: "string" }, description: "Sets the 'aud' (audience) claim. Accepts a string or array of strings." },
      jwt_id:       { type: "string", description: "Sets the 'jti' (JWT ID) claim — a unique identifier for the token." },
      extra_header: { type: "object", description: "Extra key-value pairs to merge into the JOSE header (e.g. { kid: 'key-1' })." },
    }},
  },
  {
    name: "jwt_verify",
    description: "Verify a JWT's signature and standard claims using Node.js built-in crypto — zero npm dependencies. Supports HS256/HS384/HS512 (HMAC with a shared secret) and RS256/RS384/RS512/ES256/ES384/ES512 (asymmetric: pass the PEM public key as 'secret'). Constant-time comparison is used for HMAC to prevent timing attacks. Returns { valid, algorithm, header, payload, issuedAt, expiresAt, error } — 'valid:false' with a descriptive 'error' string on any failure (bad signature, expired, wrong issuer/audience, unsupported algorithm, malformed token), never throws. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", required: ["token", "secret"], properties: {
      token:             { type: "string", description: "The JWT string to verify (three dot-separated base64url segments)." },
      secret:            { type: "string", description: "Verification key. For HS*: the same shared secret used to sign. For RS*/ES*: the PEM-encoded PUBLIC key." },
      algorithms:        { type: "array", items: { type: "string" }, description: "Restrict which algorithms are accepted (e.g. ['HS256']). Defaults to all supported algorithms if omitted." },
      ignore_expiration: { type: "boolean", description: "If true, skip the 'exp' claim check (token is accepted even if expired). Default: false." },
      ignore_not_before: { type: "boolean", description: "If true, skip the 'nbf' claim check. Default: false." },
      issuer:            { type: "string", description: "Expected 'iss' value — verification fails if the token's issuer doesn't match." },
      audience:          { type: ["string", "array"], items: { type: "string" }, description: "Expected audience — verification fails unless the token's 'aud' includes at least one of these." },
    }},
  },
  {
    name: "crypto_encrypt",
    description: "Encrypt a string or file using AES-256-GCM authenticated encryption — Node.js built-in crypto only, zero npm dependencies. Two key modes: 'password' (derives a 256-bit key via PBKDF2-HMAC-SHA256, 600 000 iterations, random salt) or 'key' (caller supplies a 64-char hex AES-256 key directly). A fresh random 96-bit IV is generated per call. Output is a compact self-describing token: 'v1:<kdf>:<iv_hex>:<auth_tag_hex>:<ciphertext_base64>'. Optionally write the token to disk via 'output_path'. Returns { token, algorithm, kdf, kdfIterations, plaintextBytes, encryptedTokenLength, savedTo? }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      data:           { type: "string", description: "Plaintext string to encrypt. Provide either 'data' or 'path', not both." },
      path:           { type: "string", description: "Path to a file whose raw bytes should be encrypted. Provide either 'data' or 'path', not both." },
      password:       { type: "string", description: "Human-memorable passphrase — PBKDF2 is used to derive a strong key. Provide either 'password' or 'key', not both." },
      key:            { type: "string", description: "64-character hex AES-256 key (32 bytes). Provide either 'password' or 'key', not both." },
      input_encoding: { type: "string", description: "When 'data' is provided: 'utf8' (default) or 'base64' (to encrypt raw binary passed as base64)." },
      output_path:    { type: "string", description: "Optional path to write the encrypted token string to disk." },
    }},
  },
  {
    name: "crypto_decrypt",
    description: "Decrypt a token produced by crypto_encrypt (AES-256-GCM). Accepts the token as an inline string ('encrypted') or as a path to a file containing the token ('path'). The GCM authentication tag is verified before any plaintext is released — tampering is detected and rejected. Returns plaintext as UTF-8 string when possible, or as base64 for binary data. Optionally write raw decrypted bytes to disk via 'output_path'. Returns { data?, dataEncoding?, algorithm, kdf, plaintextBytes, savedTo? }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      encrypted:   { type: "string", description: "The encrypted token string produced by crypto_encrypt. Provide either 'encrypted' or 'path', not both." },
      path:        { type: "string", description: "Path to a file containing the encrypted token. Provide either 'encrypted' or 'path', not both." },
      password:    { type: "string", description: "The same passphrase used during encryption (PBKDF2 mode). Provide either 'password' or 'key'." },
      key:         { type: "string", description: "The same 64-char hex AES-256 key used during encryption (raw-key mode). Provide either 'password' or 'key'." },
      output_path: { type: "string", description: "Optional path to write the decrypted bytes to disk (binary files or when plaintext should not appear in the response)." },
    }},
  },
  {
    name: "regex_test",
    description: "Test a regular expression pattern against one or more sample strings and return structured match details (matched text, index, capture groups, named groups) — useful for sanity-checking a pattern before handing it to replace_in_file/search_files/search_lines's is_regex mode. The pattern is syntax-checked first (a normal validation error for bad syntax), then executed inside a `vm` sandbox with a 1-second wall-clock timeout per test string as a ReDoS guard — a pathological pattern (catastrophic backtracking) reports back { timedOut: true, matches: [] } for that string instead of hanging the server. Global/sticky-flagged patterns collect up to max_matches occurrences per string; non-global patterns return at most one match (JS RegExp#exec semantics). Returns { pattern, flags, testCount, results: [{ input, matched, matchCount, truncated, timedOut, matches: [{match, index, groups, namedGroups}] }] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", required: ["pattern", "test_strings"], properties: {
      pattern:      { type: "string", description: "Regex source, no delimiters (e.g. '\\\\d+' not '/\\\\d+/'). Max 1000 characters." },
      flags:        { type: "string", description: "Regex flags, any subset of g/i/m/s/u/y (default 'g'). Max 6 characters, no duplicates." },
      test_strings: { type: "array", items: { type: "string" }, description: "1-100 strings to test the pattern against, each up to 20000 characters." },
      max_matches:  { type: "number", description: "Max matches to collect per string for global/sticky patterns (1-1000, default 100)." },
    }},
  },
  {
    name: "check_binary_file",
    description: "Sniff whether a file is text or binary. Checks the file's header bytes against a table of known magic-byte signatures (PNG, JPEG, GIF, BMP, PDF, ZIP-family/docx-xlsx-pptx-jar, GZIP, BZIP2, 7-Zip, TAR, ELF, Windows PE, Java class, PostScript, MP3, RIFF/WAV/AVI, MP4, SQLite) and, if none match, falls back to a NUL-byte / control-byte-ratio heuristic over the first 8000 bytes. Returns { path, sizeBytes, isBinary, mimeType, detectionMethod: 'signature'|'heuristic', description, nulByteFound, controlByteRatio } — nulByteFound/controlByteRatio are null when detectionMethod is 'signature' (not computed in that path). Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", required: ["path"], properties: {
      path: { type: "string", description: "Path to the file to sniff." },
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
    name: "scan_secrets",
    description: "Recursively scan a file or directory for likely hardcoded credentials: AWS access keys, GitHub/Slack tokens, PEM private-key headers, JWTs, and generic api_key/secret/password/token assignments. Matched values are REDACTED in the response (first 4 + last 4 chars kept, middle masked) so results never leak the secret. Pattern-shape scanner, not a secrets database — a quick sweep, not a substitute for a dedicated secrets scanner. Honours MCP_IGNORE, skips binary files, optional extensions filter, max_matches cap (1–5000, default 500). Returns { path, filesScanned, totalMatches, truncated, byType, filesAffected, matches: [{file, line, type, match}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path:        { type: "string", description: "File or directory to scan (default: first root)." },
      extensions:  { type: "array", items: { type: "string" }, description: "Directory mode only: restrict to files with these extensions, e.g. ['.js', '.env']." },
      max_matches: { type: "number", description: "Maximum total matches to return (1–5000, default: 500)." },
    }},
  },
  {
    name: "check_line_endings",
    description: "Recursively scan a file or directory, classifying each text file's line endings as LF, CRLF, mixed, or none. Honours MCP_IGNORE (node_modules, .git, etc.), skips binary files (NUL-byte heuristic). Mixed-line-ending files (both CRLF and bare LF in the same file) are surfaced individually — a common source of noisy git diffs and subtle bugs on cross-platform teams. Returns { path, filesScanned, binarySkipped, byEnding: {LF,CRLF,mixed,none}, mixedTruncated, mixedFiles: [{file, lfCount, crlfCount}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path:             { type: "string", description: "File or directory to scan (default: first root)." },
      extensions:       { type: "array", items: { type: "string" }, description: "Directory mode only: restrict to files with these extensions, e.g. ['.js', '.sh']." },
      max_mixed_files:  { type: "number", description: "Maximum number of mixed-line-ending files to list in detail (1–5000, default: 500)." },
    }},
  },
  {
    name: "find_large_files",
    description: "Recursively scan a directory for files at or above a size threshold. Honours MCP_IGNORE (node_modules, .git, etc.). Results sorted descending by size, each with a human-readable size string. Useful for spotting accidentally-committed binaries, build artifacts, or bloat before a commit/push. Returns { path, filesScanned, matchCount, truncated, minBytes, files: [{path, bytes, humanSize}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path:       { type: "string", description: "Directory to scan (default: first root)." },
      min_bytes:  { type: "number", description: "Minimum file size in bytes to include (default: 1048576 = 1MB)." },
      top_n:      { type: "number", description: "Maximum number of files to return (1–2000, default: 100)." },
      extensions: { type: "array", items: { type: "string" }, description: "Optional: only consider files with these extensions, e.g. ['.zip', '.log']." },
    }},
  },
  {
    name: "find_empty_dirs",
    description: "Recursively find directories that contain no files anywhere in their subtree (only nested empty dirs, or nothing at all). Honours MCP_IGNORE (node_modules, .git, etc.). Post-order: deepest empty dirs listed first. Useful cleanup pass before packaging/zipping/committing. Returns { path, dirsScanned, emptyDirs: string[], count, truncated }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path:        { type: "string", description: "Directory to scan (default: first root)." },
      max_results: { type: "number", description: "Maximum number of empty dirs to return (1–5000, default: 500)." },
    }},
  },
  {
    name: "json_flatten",
    description: "Flatten a nested JSON or YAML document into dot-notation key/value pairs, e.g. {a:{b:[1,2]}} -> {\"a.b.0\": 1, \"a.b.1\": 2}. Literal dots inside keys are backslash-escaped so the result round-trips through json_unflatten. Empty objects/arrays are kept as empty-value leaves. Useful for env-var generation (KEY.SUB=val), config diffing (compare flat key sets), and CLI-friendly key listing. Format auto-detected from extension (.json/.yaml/.yml), or pass format explicitly. Returns { flattened: {key: value}, keyCount, format }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", required: ["path"], properties: {
      path:   { type: "string", description: "Path to the JSON or YAML file to flatten." },
      format: { type: "string", enum: ["json", "yaml"], description: "Optional explicit format override (default: detected from file extension)." },
    }},
  },
  {
    name: "json_unflatten",
    description: "Read a flat JSON file of dot-notation key/value pairs (as produced by json_flatten) and reconstruct the original nested object/array. Numeric-looking path segments (e.g. 'items.0.name') become array indices when every sibling at that level is also numeric. Returns { nested, keyCount }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", required: ["path"], properties: {
      path: { type: "string", description: "Path to a JSON file containing a flat object, e.g. {\"a.b.0\": 1}." },
    }},
  },
  {
    name: "package_json_audit",
    description: "Static structural audit of a package.json file — no network/registry calls, purely offline analysis of the file's shape. Flags: missing/non-string 'name' or 'version', non-semver-shaped version, dependencies/devDependencies/peerDependencies/optionalDependencies that aren't objects, risky/unpinned version ranges ('*', 'latest', 'x', ''), a package listed in both dependencies and devDependencies, 'main' pointing at a file that doesn't exist on disk, a default placeholder test script, and a missing 'license' on a non-private package. Returns { path, valid, errorCount, warningCount, issues: [{severity: 'error'|'warning', field, message}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", required: ["path"], properties: {
      path: { type: "string", description: "Path to the package.json file to audit." },
    }},
  },
  {
    name: "check_package_lock_sync",
    description: "Cross-checks every declared dependency/devDependency/optionalDependency range in package.json against the actual locked version in package-lock.json, catching drift from hand-editing package.json without running npm install. Supports both lockfileVersion 1 (top-level `dependencies` map) and v2/v3 (`packages[\"node_modules/<name>\"]` map, with a fallback to the legacy `dependencies` block npm still writes for backwards compatibility). Non-registry ranges (git+/git:/github:/file:/link:/workspace:/npm:/http(s): specifiers, or '*'/'latest') are not semver-checked — reported status 'skipped', not an error. Pure fs + JSON.parse, no network, no npm CLI invocation. Returns { path, lockPath, lockfileVersion, checked, inSync, missingCount, mismatchCount, skippedCount, invalidCount, issues: [{name,block,declaredRange,lockedVersion,status,message}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      pkg_path: { type: "string", description: "Path to package.json (default: 'package.json')." },
      lock_path: { type: "string", description: "Path to package-lock.json (default: 'package-lock.json')." },
      blocks: { type: "array", items: { type: "string" }, description: "Which package.json blocks to check (default: dependencies, devDependencies, optionalDependencies)." },
    }},
  },
  {
    name: "scan_dependency_licenses",
    description: "Walks node_modules top-level entries (+ one level into @scope/ namespaces — not recursive into nested node_modules) reading each installed package's package.json `license` field (falling back to the legacy `licenses: [{type}]` array shape), and classifies it: permissive, weak-copyleft (LGPL/MPL), copyleft (GPL/AGPL), custom, or unknown. SPDX 'OR' expressions resolve to the least-restrictive branch (a real choice is available); 'AND'/'WITH' or bare strings resolve to the most-restrictive token. Flags copyleft+unknown by default (configurable via flag_categories), plus any license matching a caller-supplied `disallowed` substring list regardless of category. Pure fs + JSON.parse, no npm CLI, no network. If node_modules doesn't exist, returns foundNodeModules:false with a hint, not an error. Returns { path, foundNodeModules, packagesScanned, malformed, counts, issueCount, truncated, issues: [{name,version,license,category,reason}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "Directory containing node_modules (default: '.', i.e. '<path>/node_modules')." },
      disallowed: { type: "array", items: { type: "string" }, description: "License substrings to always flag regardless of category (case-insensitive)." },
      flag_categories: { type: "array", items: { type: "string" }, description: "Categories to flag as issues (default: copyleft, unknown; valid: permissive, weak-copyleft, copyleft, custom, unknown)." },
      max_results: { type: "number", description: "Cap on returned issues (default 500, hard cap 5000)." },
    }},
  },
  {
    name: "scan_dockerfile_issues",
    description: "Static Dockerfile best-practice audit, no docker CLI/daemon needed. Handles line continuations ('\\' at end-of-line) and multi-stage builds (`FROM ... AS name`). Flags: each FROM stage with no tag/digest (implicit mutable 'latest', error) or an explicit ':latest' tag (warning); the final stage having no USER instruction (warning — runs as root at runtime); ADD used with a local (non-http/https) source instead of COPY (warning — ADD's tar-auto-extract/URL-fetch behavior is easy to trigger by accident). Returns { path, stageCount, stages: [{index,fromLine,ref,alias,image,tag,digest}], hasUserInFinalStage, addLocalCount, errorCount, warningCount, issues: [{severity,line,instruction,message}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", properties: {
      path: { type: "string", description: "Path to the Dockerfile (default: 'Dockerfile')." },
    }},
  },
  {
    name: "readme_link_check",
    description: "Scan a markdown file for links ([text](target) syntax and bare <http(s)/mailto> autolinks) and classify each: 'external' (has a URI scheme like http:/mailto: — not fetched, offline tool), 'anchor' (#section-only, not verified), or 'local' (relative/file path, resolved against the markdown file's directory and checked for existence on disk). Useful for catching broken relative links (moved/renamed files, typos) before publishing docs. Returns { path, totalLinks, external, anchors, local: [{target,line,exists}], brokenCount, broken: [{target,line}] }. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", required: ["path"], properties: {
      path: { type: "string", description: "Path to the markdown file to scan." },
    }},
  },
  {
    name: "hmac_sign",
    description: "Compute an HMAC signature for a message using a shared secret key — Node.js built-in crypto only, zero npm dependencies. Universally useful for generating webhook signatures (GitHub, Stripe, Slack, and Shopify all use HMAC-SHA256), API authentication tokens, and data integrity checks. Supported algorithms: sha256 (default), sha384, sha512, sha1, sha224. Supported output encodings: hex (default), base64, base64url. Returns { signature, algorithm, encoding, messageLength, signatureLength }. Pair with hmac_verify (constant-time comparison) to avoid timing attacks when checking received signatures. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", required: ["message", "secret"], properties: {
      message:   { type: "string", description: "Message to sign (UTF-8 string). Max 50 MB." },
      secret:    { type: "string", description: "Shared secret key string. For best security use at least 32 random bytes (e.g. hex from crypto.randomBytes(32))." },
      algorithm: { type: "string", description: "HMAC hash algorithm: sha256 (default), sha384, sha512, sha1, sha224." },
      encoding:  { type: "string", description: "Output encoding for the signature: hex (default), base64, or base64url." },
    }},
  },
  {
    name: "hmac_verify",
    description: "Verify an HMAC signature against a message and secret using constant-time comparison (crypto.timingSafeEqual) to prevent timing side-channel attacks — Node.js built-in crypto only, zero npm dependencies. Validates GitHub webhook X-Hub-Signature-256 headers, Stripe Stripe-Signature, Slack X-Slack-Signature, and any other HMAC-based webhook or API authentication scheme. Returns { valid, algorithm, encoding, messageLength } — never throws on a bad signature, always returns valid:false. Throws a ToolError only on invalid inputs (missing/wrong-type arguments). Pair with hmac_sign to generate the expected signature. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", required: ["message", "secret", "signature"], properties: {
      message:   { type: "string", description: "Original message that was signed (UTF-8 string). Max 50 MB." },
      secret:    { type: "string", description: "Shared secret key used when signing (must match the signing key exactly)." },
      signature: { type: "string", description: "Signature string to verify, in the encoding specified by 'encoding' (default: hex)." },
      algorithm: { type: "string", description: "HMAC hash algorithm: sha256 (default), sha384, sha512, sha1, sha224. Must match the algorithm used to sign." },
      encoding:  { type: "string", description: "Encoding of the provided 'signature': hex (default), base64, or base64url. Must match the encoding used to produce the signature." },
    }},
  },
  {
    name: "totp_generate",
    description: "Generate a Time-based One-Time Password (TOTP) per RFC 6238 — Node.js built-in crypto only, zero npm dependencies. Compatible with Google Authenticator, Authy, Microsoft Authenticator, and any RFC 6238 TOTP app. The 'secret' must be Base32-encoded (A-Z, 2-7; the format shown by TOTP QR code setup flows as a plain text fallback). Supports 6 or 8 digit codes, configurable time period (default 30s), and SHA-1/SHA-256/SHA-512 HMAC (SHA-1 is the most widely compatible default). Optionally accepts a fixed Unix 'time' timestamp (seconds) for deterministic testing. Returns { otp, algorithm, digits, period, counter, validFor, expiresAt, generatedAt }. Pair with totp_verify to validate codes with clock-drift tolerance. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", required: ["secret"], properties: {
      secret:    { type: "string", description: "Base32-encoded shared secret (A-Z, 2-7 characters, case-insensitive, spaces/dashes/padding stripped automatically). This is the secret shown during TOTP enrollment, e.g. 'JBSWY3DPEHPK3PXP'." },
      digits:    { type: "number", description: "Number of OTP digits: 6 (default, standard) or 8." },
      period:    { type: "number", description: "Time step in seconds (default: 30). RFC 6238 standard is 30s." },
      algorithm: { type: "string", description: "HMAC algorithm for HOTP computation: sha1 (default, most compatible), sha256, or sha512." },
      time:      { type: "number", description: "Unix timestamp in seconds to use instead of the current time (default: now). Useful for deterministic testing." },
    }},
  },
  {
    name: "totp_verify",
    description: "Verify a TOTP code against a Base32 secret with clock-drift tolerance — Node.js built-in crypto only, zero npm dependencies. Checks the provided OTP against the current time step and up to 'window' steps before/after (default: 1 step = ±30s for a 30s period) to accommodate clock skew between the server and user's device. Uses crypto.timingSafeEqual() for constant-time code comparison. Returns { valid, delta, counter, algorithm, digits, period } — 'delta' is the matched step offset (0 = current step, -1 = previous, 1 = next, null if invalid). Never throws on a wrong code, always returns valid:false. Pair with totp_generate to produce the expected code for comparison. Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: { type: "object", required: ["otp", "secret"], properties: {
      otp:       { type: "string", description: "The numeric OTP code to verify (6 or 8 digit string, e.g. '123456')." },
      secret:    { type: "string", description: "Base32-encoded shared secret (same as used by totp_generate, case-insensitive)." },
      digits:    { type: "number", description: "Expected number of digits: 6 (default) or 8. Must match the configuration used to generate the code." },
      period:    { type: "number", description: "Time step in seconds (default: 30). Must match totp_generate configuration." },
      algorithm: { type: "string", description: "HMAC algorithm: sha1 (default), sha256, or sha512. Must match totp_generate configuration." },
      window:    { type: "number", description: "Number of time steps before and after the current step to accept (default: 1, i.e. ±1 step). Set to 0 for strict current-step-only validation." },
      time:      { type: "number", description: "Unix timestamp in seconds to use instead of now (default: current time). Useful for deterministic testing." },
    }},
  },
];
const { UTIL_SCHEMAS_2 } = require("./utilSchemas2");
const { UTIL_SCHEMAS_3 } = require("./utilSchemas3");
const { UTIL_SCHEMAS_4 } = require("./utilSchemas4");
const { UTIL_SCHEMAS_5 } = require("./utilSchemas5");
const { UTIL_SCHEMAS_6 } = require("./utilSchemas6");
const { UTIL_SCHEMAS_7 } = require("./utilSchemas7");
const { UTIL_SCHEMAS_8 } = require("./utilSchemas8");
const { UTIL_SCHEMAS_9 } = require("./utilSchemas9");
const { UTIL_SCHEMAS_10 } = require("./utilSchemas10");
const { UTIL_SCHEMAS_11 } = require("./utilSchemas11");
const { UTIL_SCHEMAS_12 } = require("./utilSchemas12");
const { UTIL_SCHEMAS_13 } = require("./utilSchemas13");
const { UTIL_SCHEMAS_14 } = require("./utilSchemas14");
const { UTIL_SCHEMAS_15 } = require("./utilSchemas15");
const { UTIL_SCHEMAS_16 } = require("./utilSchemas16");
const { UTIL_SCHEMAS_17 } = require("./utilSchemas17");
const { UTIL_SCHEMAS_18 } = require("./utilSchemas18");
const { UTIL_SCHEMAS_19 } = require("./utilSchemas19");
const { UTIL_SCHEMAS_20 } = require("./utilSchemas20");
const { UTIL_SCHEMAS_21 } = require("./utilSchemas21");
const { UTIL_SCHEMAS_22 } = require("./utilSchemas22");
const { UTIL_SCHEMAS_23 } = require("./utilSchemas23");
const { UTIL_SCHEMAS_24 } = require("./utilSchemas24");
const { UTIL_SCHEMAS_25 } = require("./utilSchemas25");
const { UTIL_SCHEMAS_26 } = require("./utilSchemas26");
const { UTIL_SCHEMAS_27 } = require("./utilSchemas27");
const { UTIL_SCHEMAS_28 } = require("./utilSchemas28");
const { UTIL_SCHEMAS_29 } = require("./utilSchemas29");
const { UTIL_SCHEMAS_30 } = require("./utilSchemas30");
const { UTIL_SCHEMAS_31 } = require("./utilSchemas31");
const { UTIL_SCHEMAS_32 } = require("./utilSchemas32");
const { UTIL_SCHEMAS_33 } = require("./utilSchemas33");
const { UTIL_SCHEMAS_34 } = require("./utilSchemas34");
const { UTIL_SCHEMAS_35 } = require("./utilSchemas35");
const { UTIL_SCHEMAS_36 } = require("./utilSchemas36");
const { UTIL_SCHEMAS_37 } = require("./utilSchemas37");
const { UTIL_SCHEMAS_38 } = require("./utilSchemas38");
const { UTIL_SCHEMAS_39 } = require("./utilSchemas39");
const { UTIL_SCHEMAS_40 } = require("./utilSchemas40");
const { UTIL_SCHEMAS_41 } = require("./utilSchemas41");
const { UTIL_SCHEMAS_42 } = require("./utilSchemas42");
const { UTIL_SCHEMAS_43 } = require("./utilSchemas43");
const { UTIL_SCHEMAS_44 } = require("./utilSchemas44");
const { UTIL_SCHEMAS_45 } = require("./utilSchemas45");
const { UTIL_SCHEMAS_46 } = require("./utilSchemas46");
const { UTIL_SCHEMAS_47 } = require("./utilSchemas47");
const { UTIL_SCHEMAS_48 } = require("./utilSchemas48");
const { UTIL_SCHEMAS_49 } = require("./utilSchemas49");
const { UTIL_SCHEMAS_50 } = require("./utilSchemas50");
const { UTIL_SCHEMAS_51 } = require("./utilSchemas51");
const { UTIL_SCHEMAS_52 } = require("./utilSchemas52");
const { UTIL_SCHEMAS_53 } = require("./utilSchemas53");
const { UTIL_SCHEMAS_54 } = require("./utilSchemas54");
const { UTIL_SCHEMAS_55 } = require("./utilSchemas55");
const { UTIL_SCHEMAS_56 } = require("./utilSchemas56");
const { UTIL_SCHEMAS_57 } = require("./utilSchemas57");
const { UTIL_SCHEMAS_58 } = require("./utilSchemas58");
const { UTIL_SCHEMAS_59 } = require("./utilSchemas59");
const { UTIL_SCHEMAS_60 } = require("./utilSchemas60");
const { UTIL_SCHEMAS_61 } = require("./utilSchemas61");
const { UTIL_SCHEMAS_62 } = require("./utilSchemas62");
const { UTIL_SCHEMAS_63 } = require("./utilSchemas63");
const { UTIL_SCHEMAS_64 } = require("./utilSchemas64");
const { UTIL_SCHEMAS_65 } = require("./utilSchemas65");
const { UTIL_SCHEMAS_66 } = require("./utilSchemas66");
const { UTIL_SCHEMAS_67 } = require("./utilSchemas67");
const { UTIL_SCHEMAS_68 } = require("./utilSchemas68");
const { UTIL_SCHEMAS_69 } = require("./utilSchemas69");
const { UTIL_SCHEMAS_70 } = require("./utilSchemas70");
const { UTIL_SCHEMAS_71 } = require("./utilSchemas71");
const { UTIL_SCHEMAS_72 } = require("./utilSchemas72");
const { UTIL_SCHEMAS_73 } = require("./utilSchemas73");
const { UTIL_SCHEMAS_74 } = require("./utilSchemas74");
const { UTIL_SCHEMAS_75 } = require("./utilSchemas75");
const { PROMETHEUS_CLIENT_SCHEMA } = require("./utilSchemas76");
const { ELASTICSEARCH_CLIENT_SCHEMA } = require("./utilSchemas77");
const { MONGODB_CLIENT_SCHEMA } = require("./utilSchemas78");
const { CASSANDRA_CLIENT_SCHEMA } = require("./utilSchemas79");
const { influxdbClientSchema: INFLUXDB_CLIENT_SCHEMA } = require("./utilSchemas80");
const { ntpClientSchema: NTP_CLIENT_SCHEMA }       = require("./utilSchemas81");
const { syslogClientSchema: SYSLOG_CLIENT_SCHEMA }         = require("./utilSchemas82");
const { clickhouseClientSchema: CLICKHOUSE_CLIENT_SCHEMA } = require("./utilSchemas83");
const { modbusClientSchema: MODBUS_CLIENT_SCHEMA }         = require("./utilSchemas84");
const { coapClientSchema: COAP_CLIENT_SCHEMA }              = require("./utilSchemas85");
const { whoisClientSchema: WHOIS_CLIENT_SCHEMA }            = require("./utilSchemas86");
const { tlsClientSchema: TLS_CLIENT_SCHEMA }                 = require("./utilSchemas87");
const { dnsClientSchema: DNS_CLIENT_SCHEMA }                 = require("./utilSchemas88");
const { ircClientSchema: IRC_CLIENT_SCHEMA }                  = require("./utilSchemas89");
const { tftpClientSchema: TFTP_CLIENT_SCHEMA }                = require("./utilSchemas90");
const { rtspClientSchema: RTSP_CLIENT_SCHEMA }                 = require("./utilSchemas91");
const { sipClientSchema: SIP_CLIENT_SCHEMA }                   = require("./utilSchemas92");
const { xmppClientSchema: XMPP_CLIENT_SCHEMA }                 = require("./utilSchemas93");
const { radiusClientSchema: RADIUS_CLIENT_SCHEMA }              = require("./utilSchemas94");
const { diameterClientSchema: DIAMETER_CLIENT_SCHEMA }           = require("./utilSchemas95");
const { pop3ClientSchema: POP3_CLIENT_SCHEMA }                    = require("./utilSchemas96");
const { nntpClientSchema: NNTP_CLIENT_SCHEMA }                     = require("./utilSchemas97");
const { zookeeperClientSchema: ZOOKEEPER_CLIENT_SCHEMA }              = require("./utilSchemas98");
const { etcdClientSchema: ETCD_CLIENT_SCHEMA }                         = require("./utilSchemas99");
const { consulClientSchema: CONSUL_CLIENT_SCHEMA }                     = require("./utilSchemas100");
const { vaultClientSchema: VAULT_CLIENT_SCHEMA }                       = require("./utilSchemas101");
const { AWS_CLIENT_SCHEMA }                                            = require("./utilSchemas102");
const { GCP_CLIENT_SCHEMA }                                            = require("./utilSchemas103");
const { AZURE_CLIENT_SCHEMA }                                          = require("./utilSchemas104");
const { TERRAFORM_CLIENT_SCHEMA }                                      = require("./utilSchemas105");
const { GITHUB_CLIENT_SCHEMA }                                         = require("./utilSchemas106");
const { GITLAB_CLIENT_SCHEMA }                                         = require("./utilSchemas107");
const { BITBUCKET_CLIENT_SCHEMA }                                       = require("./utilSchemas108");
const { JIRA_CLIENT_SCHEMA }                                           = require("./utilSchemas109");
const { CONFLUENCE_CLIENT_SCHEMA }                                     = require("./utilSchemas110");
const { SLACK_CLIENT_SCHEMA }                                          = require("./utilSchemas111");
const { TEAMS_CLIENT_SCHEMA }                                          = require("./utilSchemas112");
module.exports = { UTIL_SCHEMAS: [TEAMS_CLIENT_SCHEMA, SLACK_CLIENT_SCHEMA, CONFLUENCE_CLIENT_SCHEMA, JIRA_CLIENT_SCHEMA, BITBUCKET_CLIENT_SCHEMA, GITLAB_CLIENT_SCHEMA, GITHUB_CLIENT_SCHEMA, TERRAFORM_CLIENT_SCHEMA, AZURE_CLIENT_SCHEMA, GCP_CLIENT_SCHEMA, AWS_CLIENT_SCHEMA, ...UTIL_SCHEMAS_1, ...UTIL_SCHEMAS_2, ...UTIL_SCHEMAS_3, ...UTIL_SCHEMAS_4, ...UTIL_SCHEMAS_5, ...UTIL_SCHEMAS_6, ...UTIL_SCHEMAS_7, ...UTIL_SCHEMAS_8, ...UTIL_SCHEMAS_9, ...UTIL_SCHEMAS_10, ...UTIL_SCHEMAS_11, ...UTIL_SCHEMAS_12, ...UTIL_SCHEMAS_13, ...UTIL_SCHEMAS_14, ...UTIL_SCHEMAS_15, ...UTIL_SCHEMAS_16, ...UTIL_SCHEMAS_17, ...UTIL_SCHEMAS_18, ...UTIL_SCHEMAS_19, ...UTIL_SCHEMAS_20, ...UTIL_SCHEMAS_21, ...UTIL_SCHEMAS_22, ...UTIL_SCHEMAS_23, ...UTIL_SCHEMAS_24, ...UTIL_SCHEMAS_25, ...UTIL_SCHEMAS_26, ...UTIL_SCHEMAS_27, ...UTIL_SCHEMAS_28, ...UTIL_SCHEMAS_29, ...UTIL_SCHEMAS_30, ...UTIL_SCHEMAS_31, ...UTIL_SCHEMAS_32, ...UTIL_SCHEMAS_33, ...UTIL_SCHEMAS_34, ...UTIL_SCHEMAS_35, ...UTIL_SCHEMAS_36, ...UTIL_SCHEMAS_37, ...UTIL_SCHEMAS_38, ...UTIL_SCHEMAS_39, ...UTIL_SCHEMAS_40, ...UTIL_SCHEMAS_41, ...UTIL_SCHEMAS_42, ...UTIL_SCHEMAS_43, ...UTIL_SCHEMAS_44, ...UTIL_SCHEMAS_45, ...UTIL_SCHEMAS_46, ...UTIL_SCHEMAS_47, ...UTIL_SCHEMAS_48, ...UTIL_SCHEMAS_49, ...UTIL_SCHEMAS_50, ...UTIL_SCHEMAS_51, ...UTIL_SCHEMAS_52, ...UTIL_SCHEMAS_53, ...UTIL_SCHEMAS_54, ...UTIL_SCHEMAS_55, ...UTIL_SCHEMAS_56, ...UTIL_SCHEMAS_57, ...UTIL_SCHEMAS_58, ...UTIL_SCHEMAS_59, ...UTIL_SCHEMAS_60, ...UTIL_SCHEMAS_61, ...UTIL_SCHEMAS_62, ...UTIL_SCHEMAS_63, ...UTIL_SCHEMAS_64, ...UTIL_SCHEMAS_65, ...UTIL_SCHEMAS_66, ...UTIL_SCHEMAS_67, ...UTIL_SCHEMAS_68, ...UTIL_SCHEMAS_69, ...UTIL_SCHEMAS_70, ...UTIL_SCHEMAS_71, ...UTIL_SCHEMAS_72, ...UTIL_SCHEMAS_73, ...UTIL_SCHEMAS_74, ...UTIL_SCHEMAS_75, PROMETHEUS_CLIENT_SCHEMA, ELASTICSEARCH_CLIENT_SCHEMA, MONGODB_CLIENT_SCHEMA, CASSANDRA_CLIENT_SCHEMA, INFLUXDB_CLIENT_SCHEMA, NTP_CLIENT_SCHEMA, SYSLOG_CLIENT_SCHEMA, CLICKHOUSE_CLIENT_SCHEMA, MODBUS_CLIENT_SCHEMA, COAP_CLIENT_SCHEMA, WHOIS_CLIENT_SCHEMA, TLS_CLIENT_SCHEMA, DNS_CLIENT_SCHEMA, IRC_CLIENT_SCHEMA, TFTP_CLIENT_SCHEMA, RTSP_CLIENT_SCHEMA, SIP_CLIENT_SCHEMA, XMPP_CLIENT_SCHEMA, RADIUS_CLIENT_SCHEMA, DIAMETER_CLIENT_SCHEMA, POP3_CLIENT_SCHEMA, NNTP_CLIENT_SCHEMA, ZOOKEEPER_CLIENT_SCHEMA, ETCD_CLIENT_SCHEMA, CONSUL_CLIENT_SCHEMA, VAULT_CLIENT_SCHEMA, AWS_CLIENT_SCHEMA, GCP_CLIENT_SCHEMA] };

