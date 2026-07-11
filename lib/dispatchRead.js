"use strict";
// ── READ / GIT / UTILITY TOOL DISPATCH HANDLERS ────────────────────────────────
// Extracted from lib/executeTool.js (which had grown past the 500-line
// threshold) so that file can stay a thin validator + switch/lookup table.
// Each handler is `(args) => result` and receives the same `args` object
// the JSON-RPC caller sent (already schema-validated by validateArgs).

const fs   = require("fs");
const path = require("path");

const { ROOTS, resolveClientPath } = require("./roots");
const { ToolError } = require("./errors");
const {
  readDirRecursive, readLines, searchRecursive,
  readMultipleFiles, globToRegex, findFilesRecursive, searchLines,
} = require("./fileOps");
const { fileChecksum, checksumVerify } = require("./checksumOps");
const { zipDirectory }  = require("./zipDirOps");
const { createTar }     = require("./tarOps");
const { queryJson, queryData } = require("./queryOps");
const { diffFiles }     = require("./diffFileOps");
const { envInfo }       = require("./envInfoOps");
const { systemResources } = require("./systemResourcesOps");
const { whichCommand } = require("./whichOps");
const { hashString } = require("./hashStringOps");
const { regexTest } = require("./regexTestOps");
const { jwtDecode } = require("./jwtDecodeOps");
const { jwtSign, jwtVerify } = require("./jwtSignOps");
const { cryptoEncryptBuffer, cryptoDecryptToken } = require("./cryptoAesOps");
const { hmacSign, hmacVerify } = require("./hmacSignOps");
const { totpGenerate, totpVerify } = require("./totpOps");
const { uuidGenerate } = require("./uuidGenerateOps");
const { nextOccurrences } = require("./cronNextOps");
const { diffStrings } = require("./diffStringsOps");
const { generatePasswords } = require("./passwordGenerateOps");
const { urlParse } = require("./urlParseOps");
const { parseSemver, compareSemver, satisfiesRange } = require("./semverOps");
const { jsonPatchGenerate } = require("./jsonPatchGenerateOps");
const { checkBinaryFile } = require("./binaryFileOps");
const { readArchive } = require("./archiveOps");
const { GIT_DISPATCH } = require("./dispatchGit");
const { SCAN_DISPATCH } = require("./dispatchScan");
const { searchInDocument } = require("./searchDocumentOps");
const { envDiff } = require("./envDiffOps");
const { jsonSchemaValidate } = require("./jsonSchemaValidateOps");
const { jsonSchemaGenerate } = require("./jsonSchemaGenerateOps");
const { jsonFlatten, jsonUnflattenFile } = require("./jsonFlattenOps");
const { findDuplicates } = require("./duplicateOps");
const { compareDirectories } = require("./compareOps");
const { fileDiffDir } = require("./dirDiffOps");
const { countLines } = require("./wc");
const { fileTree } = require("./treeOps");
const { hashDirectory } = require("./hashDirOps");
const { base64Encode } = require("./encodingOps");
const { fileStats } = require("./fileStatsOps");
const { diskUsageSummary } = require("./diskUsageOps");
const { dirSizeStats } = require("./dirSizeOps");
const { csvQuery } = require("./csvOps");
const { csvDiff } = require("./csvDiffOps");
const { httpFetch } = require("./httpFetchOps");
const { portCheck, waitForPort, portScanRange } = require("./portCheckOps");
const { dnsLookup } = require("./dnsLookupOps");
const { queryPath } = require("./jsonPathOps");
const { jsonDiff } = require("./jsonDiffOps");


const READ_DISPATCH = {
  ...GIT_DISPATCH,
  ...SCAN_DISPATCH,


  read_directory(args) {
    if (!args.path) {
      const all = [];
      for (const [alias, abs] of ROOTS)
        all.push({ root: alias, entries: readDirRecursive(abs, !!args.sub_dir, alias) });
      return { roots: [...ROOTS.keys()], total: all.reduce((n, r) => n + r.entries.length, 0), result: all };
    }
    const { alias, root, resolved } = resolveClientPath(args.path);
    const entries = readDirRecursive(resolved, !!args.sub_dir, alias);
    return { root, path: args.path, sub_dir: !!args.sub_dir, total: entries.length, entries };
  },

  read_file(args) {
    const { resolved } = resolveClientPath(args.path);
    return { path: args.path, ...readLines(resolved, args.from_line ?? 0, args.to_line ?? 0) };
  },

  read_files(args) {
    return { results: readMultipleFiles(args.files) };
  },

  read_allfiles(args) {
    const { alias, resolved } = resolveClientPath(args.path || ".");
    const entries = readDirRecursive(resolved, args.sub_dir !== false, alias).filter(e => e.type === "file");
    const exts    = args.extensions?.length ? args.extensions : null;
    const files   = {};
    for (const f of entries) {
      if (exts && !exts.some(x => f.path.endsWith(x))) continue;
      try { files[f.path] = fs.readFileSync(resolveClientPath(f.path).resolved, "utf8"); }
      catch (e) { files[f.path] = `[ERROR: ${e.message}]`; }
    }
    return { path: args.path || ".", fileCount: Object.keys(files).length, files };
  },

  file_info(args) {
    const { resolved } = resolveClientPath(args.path);
    const stat = fs.statSync(resolved);
    const info = {
      path: args.path, type: stat.isDirectory() ? "directory" : "file",
      size: stat.size, created: stat.birthtime, modified: stat.mtime,
      permissions: (stat.mode & 0o777).toString(8),
    };
    if (!stat.isDirectory()) info.lineCount = fs.readFileSync(resolved, "utf8").split("\n").length;
    return info;
  },

  search_files(args) {
    const { alias, resolved } = resolveClientPath(args.path || ".");
    let results = searchRecursive(resolved, args.pattern, !!args.is_regex, alias);
    if (args.extensions?.length)
      results = results.filter(r => args.extensions.some(x => r.file.endsWith(x)));
    return { pattern: args.pattern, matchedFiles: results.length, results };
  },

  find_files(args) {
    const { alias, resolved } = resolveClientPath(args.path || ".");
    const re      = globToRegex(args.pattern);
    const results = findFilesRecursive(resolved, re, alias);
    return {
      pattern:      args.pattern,
      searchRoot:   args.path || ".",
      matchedFiles: results.length,
      files:        results,
    };
  },

  search_lines(args) {
    const { alias, resolved } = resolveClientPath(args.path);
    const origPath = args.path || alias || ".";
    return searchLines(resolved, origPath, args.pattern, {
      isRegex:    args.is_regex,
      ignoreCase: args.ignore_case,
      context:    args.context,
      maxMatches: args.max_matches,
      extensions: args.extensions,
    });
  },

  search_in_document(args) {
    const { alias, resolved } = resolveClientPath(args.path);
    const origPath = args.path || alias || ".";
    return searchInDocument(resolved, origPath, args.pattern, {
      isRegex:    args.is_regex,
      ignoreCase: args.ignore_case,
      context:    args.context,
      maxMatches: args.max_matches,
    });
  },

  // ── Utility ───────────────────────────────────────────────────────────────

  file_checksum(args) {
    const { resolved } = resolveClientPath(args.path);
    return { path: args.path, ...fileChecksum(resolved, args.algorithm) };
  },

  checksum_verify(args) {
    const { resolved } = resolveClientPath(args.path);
    return { path: args.path, ...checksumVerify(resolved, args.expected, args.algorithm) };
  },


  hash_string(args) {
    return hashString(args.data, args.algorithm, args.encoding);
  },

  semver_compare(args) {
    const versionA = parseSemver(args.version_a);
    const result = { versionA };
    if (args.version_b !== undefined) {
      const versionB = parseSemver(args.version_b);
      const cmp = compareSemver(args.version_a, args.version_b);
      result.versionB = versionB;
      result.comparison = cmp;
      result.relation = cmp < 0 ? "less_than" : cmp > 0 ? "greater_than" : "equal";
    }
    if (args.range !== undefined) {
      result.range = args.range;
      result.satisfies = satisfiesRange(args.version_a, args.range);
    }
    if (result.versionB === undefined && result.range === undefined) {
      throw new ToolError("semver_compare: provide 'version_b' and/or 'range' to compare against.", -32602);
    }
    return result;
  },

  url_parse(args) {
    return urlParse(args.url, { base: args.base, showPassword: args.show_password });
  },

  jwt_decode(args) {
    return jwtDecode(args.token);
  },

  jwt_sign(args) {
    return jwtSign({
      payload:      args.payload,
      secret:       args.secret,
      algorithm:    args.algorithm,
      expires_in:   args.expires_in,
      not_before:   args.not_before,
      issuer:       args.issuer,
      subject:      args.subject,
      audience:     args.audience,
      jwt_id:       args.jwt_id,
      extra_header: args.extra_header,
    });
  },

  jwt_verify(args) {
    return jwtVerify({
      token:              args.token,
      secret:             args.secret,
      algorithms:         args.algorithms,
      ignore_expiration:  args.ignore_expiration,
      ignore_not_before:  args.ignore_not_before,
      issuer:             args.issuer,
      audience:           args.audience,
    });
  },

  crypto_encrypt(args) {
    // Accepts data (string) or path (file). File I/O done here; pure crypto in cryptoAesOps.
    let plainBuf;
    if (args.data != null && args.path != null)
      throw new (require('./errors').ToolError)("crypto_encrypt: provide 'data' or 'path', not both.", -32602);
    if (args.data != null) {
      if (typeof args.data !== "string")
        throw new (require('./errors').ToolError)("crypto_encrypt: 'data' must be a string.", -32602);
      plainBuf = Buffer.from(args.data, args.input_encoding === "base64" ? "base64" : "utf8");
    } else if (args.path != null) {
      const { resolved } = resolveClientPath(args.path);
      plainBuf = fs.readFileSync(resolved);
    } else {
      throw new (require('./errors').ToolError)("crypto_encrypt: provide either 'data' (string) or 'path' (file to encrypt).", -32602);
    }
    const result = cryptoEncryptBuffer(plainBuf, { password: args.password, key: args.key });
    if (args.output_path) {
      const { resolved } = resolveClientPath(args.output_path);
      fs.mkdirSync(require('path').dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, result.token, "utf8");
      return { ...result, savedTo: args.output_path };
    }
    return result;
  },

  crypto_decrypt(args) {
    // Accepts encrypted token string or path to file containing the token.
    let token;
    if (args.encrypted != null && args.path != null)
      throw new (require('./errors').ToolError)("crypto_decrypt: provide 'encrypted' or 'path', not both.", -32602);
    if (args.encrypted != null) {
      if (typeof args.encrypted !== "string")
        throw new (require('./errors').ToolError)("crypto_decrypt: 'encrypted' must be a string.", -32602);
      token = args.encrypted;
    } else if (args.path != null) {
      const { resolved } = resolveClientPath(args.path);
      token = fs.readFileSync(resolved, "utf8").trim();
    } else {
      throw new (require('./errors').ToolError)("crypto_decrypt: provide either 'encrypted' (token string) or 'path' (file containing token).", -32602);
    }
    const result = cryptoDecryptToken(token, { password: args.password, key: args.key });
    if (args.output_path) {
      // Write raw bytes (supports binary files)
      const { resolved } = resolveClientPath(args.output_path);
      fs.mkdirSync(require('path').dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, result.plaintext);
      const { plaintext, ...rest } = result;
      return { ...rest, savedTo: args.output_path };
    }
    // Return as string: try UTF-8 first, fall back to base64
    let data, dataEncoding;
    try {
      data = result.plaintext.toString("utf8");
      // Sanity check: re-encode and compare to catch garbled UTF-8
      if (Buffer.from(data, "utf8").equals(result.plaintext)) {
        dataEncoding = "utf8";
      } else {
        data = result.plaintext.toString("base64");
        dataEncoding = "base64";
      }
    } catch {
      data = result.plaintext.toString("base64");
      dataEncoding = "base64";
    }
    const { plaintext, ...rest } = result;
    return { ...rest, data, dataEncoding };
  },

  regex_test(args) {
    return regexTest({
      pattern:     args.pattern,
      flags:       args.flags,
      testStrings: args.test_strings,
      maxMatches:  args.max_matches,
    });
  },

  check_binary_file(args) {
    const { resolved } = resolveClientPath(args.path);
    return checkBinaryFile(resolved, args.path);
  },

  zip_directory(args) {
    const { resolved: srcResolved } = resolveClientPath(args.path);
    const { resolved: dstResolved } = resolveClientPath(args.destination);
    const stat = fs.statSync(srcResolved);
    if (!stat.isDirectory())
      throw new Error(`zip_directory: '${args.path}' is not a directory.`);
    fs.mkdirSync(path.dirname(dstResolved), { recursive: true });
    const result = zipDirectory(srcResolved, dstResolved);
    return { source: args.path, ...result, zipPath: args.destination };
  },

  create_tar(args) {
    const { resolved: srcResolved } = resolveClientPath(args.path);
    const { resolved: dstResolved } = resolveClientPath(args.destination);
    const stat = fs.statSync(srcResolved);
    if (!stat.isDirectory())
      throw new Error(`create_tar: '${args.path}' is not a directory.`);
    fs.mkdirSync(path.dirname(dstResolved), { recursive: true });
    const result = createTar(srcResolved, dstResolved, { gzip: args.gzip });
    return { source: args.path, ...result, tarPath: args.destination };
  },

  query_json(args) {
    const { resolved } = resolveClientPath(args.path);
    return { path: args.path, ...queryJson(resolved, args.query || "") };
  },

  query_data(args) {
    const { resolved } = resolveClientPath(args.path);
    return { path: args.path, ...queryData(resolved, args.query || "", args.format || "") };
  },

  json_schema_validate(args) {
    const { resolved: dataResolved } = resolveClientPath(args.path);
    const { resolved: schemaResolved } = resolveClientPath(args.schema_path);
    return jsonSchemaValidate(dataResolved, args.path, schemaResolved, args.schema_path);
  },

  json_schema_generate(args) {
    const { resolved } = resolveClientPath(args.path);
    return jsonSchemaGenerate(resolved, args.path, {
      format:           args.format,
      max_array_sample: args.max_array_sample,
    });
  },

  diff_files(args) {
    const { resolved: aResolved } = resolveClientPath(args.source);
    const { resolved: bResolved } = resolveClientPath(args.target);
    return {
      source: args.source,
      target: args.target,
      ...diffFiles(aResolved, bResolved, args.source, args.target, args.context),
    };
  },

  env_diff(args) {
    const { resolved: aResolved } = resolveClientPath(args.path);
    const { resolved: bResolved } = resolveClientPath(args.compare_path);
    return envDiff(aResolved, args.path, bResolved, args.compare_path);
  },

  env_info() {
    return envInfo();
  },

  system_resources() {
    return systemResources();
  },

  which_command(args) {
    return whichCommand(args);
  },

  read_archive(args) {
    const { resolved } = resolveClientPath(args.path);
    return { path: args.path, ...readArchive(resolved) };
  },


  count_lines(args) {
    if (!Array.isArray(args.paths) || args.paths.length === 0)
      throw new ToolError("count_lines: 'paths' must be a non-empty array.", -32602);
    const absPaths = args.paths.map(p => resolveClientPath(p).resolved);
    return countLines(absPaths, args.paths);
  },

  file_tree(args) {
    const { alias, resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || alias || ".";
    return fileTree(resolved, origPath, {
      depth: args.depth,
      sizes: args.sizes,
    });
  },

  hash_directory(args) {
    const { alias, resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || alias || ".";
    return hashDirectory(resolved, origPath, {
      algorithm:  args.algorithm,
      extensions: args.extensions,
    });
  },

  base64_encode(args) {
    const { resolved } = resolveClientPath(args.path);
    return base64Encode(resolved, args.path, { url_safe: args.url_safe });
  },

  file_stats(args) {
    const { alias, resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || alias || ".";
    return fileStats(resolved, origPath, {
      topN:       args.top_n,
      extensions: args.extensions,
    });
  },



  json_flatten(args) {
    const { resolved } = resolveClientPath(args.path);
    return jsonFlatten(resolved, args.format);
  },

  json_unflatten(args) {
    const { resolved } = resolveClientPath(args.path);
    return jsonUnflattenFile(resolved);
  },




  dir_size_stats(args) {
    const { alias, resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || alias || ".";
    return dirSizeStats(resolved, origPath, {
      maxDepth: args.max_depth,
      topN:     args.top_n,
    });
  },

  disk_usage_summary(args) {
    const { alias, resolved } = resolveClientPath(args.path || ".");
    const origPath = args.path || alias || ".";
    return diskUsageSummary(resolved, origPath, {
      topFiles: args.top_files,
      topDirs:  args.top_dirs,
      maxDepth: args.max_depth,
    });
  },

  csv_query(args) {
    const { resolved } = resolveClientPath(args.path);
    return csvQuery(resolved, args.path, {
      columns:    args.columns,
      offset:     args.offset,
      limit:      args.limit,
      filter_col: args.filter_col,
      filter_val: args.filter_val,
      has_header: args.has_header,
      group_by:   args.group_by,
      aggregate:  args.aggregate,
    });
  },

  csv_diff(args) {
    const { resolved: leftResolved } = resolveClientPath(args.left);
    const { resolved: rightResolved } = resolveClientPath(args.right);
    return csvDiff(leftResolved, rightResolved, args.left, args.right, {
      key_column: args.key_column,
      has_header: args.has_header,
      max_rows:   args.max_rows,
    });
  },


  http_fetch(args) {
    // http_fetch is async — callers in executeTool.js must await the result.
    return httpFetch({
      url:     args.url,
      method:  args.method,
      headers: args.headers,
      body:    args.body,
      timeout: args.timeout,
    });
  },

  port_check(args) {
    return portCheck({ host: args.host, port: args.port, timeout: args.timeout });
  },

  wait_for_port(args) {
    return waitForPort({
      host: args.host,
      port: args.port,
      timeout: args.timeout,
      interval: args.interval,
      connect_timeout: args.connect_timeout,
    });
  },

  port_scan_range(args) {
    return portScanRange({
      host: args.host,
      start_port: args.start_port,
      end_port: args.end_port,
      timeout: args.timeout,
      concurrency: args.concurrency,
    });
  },

  dns_lookup(args) {
    return dnsLookup({ host: args.host, type: args.type, timeout: args.timeout });
  },

  query_path(args) {
    const { resolved } = resolveClientPath(args.path);
    return queryPath(resolved, args.path, args.query || "", args.format || "");
  },

  json_patch_generate(args) {
    const { resolved: leftResolved } = resolveClientPath(args.left);
    const { resolved: rightResolved } = resolveClientPath(args.right);
    return jsonPatchGenerate(leftResolved, rightResolved, args.left, args.right, {
      format: args.format,
      max_ops: args.max_ops,
    });
  },

  json_diff(args) {
    const { resolved: leftResolved } = resolveClientPath(args.left);
    const { resolved: rightResolved } = resolveClientPath(args.right);
    return jsonDiff(leftResolved, rightResolved, args.left, args.right, {
      format:      args.format,
      max_changes: args.max_changes,
    });
  },

  hmac_sign(args) {
    return hmacSign({
      message:   args.message,
      secret:    args.secret,
      algorithm: args.algorithm,
      encoding:  args.encoding,
    });
  },

  hmac_verify(args) {
    return hmacVerify({
      message:   args.message,
      secret:    args.secret,
      signature: args.signature,
      algorithm: args.algorithm,
      encoding:  args.encoding,
    });
  },

  totp_generate(args) {
    return totpGenerate({
      secret:    args.secret,
      digits:    args.digits,
      period:    args.period,
      algorithm: args.algorithm,
      time:      args.time,
    });
  },

  totp_verify(args) {
    return totpVerify({
      otp:       args.otp,
      secret:    args.secret,
      digits:    args.digits,
      period:    args.period,
      algorithm: args.algorithm,
      window:    args.window,
      time:      args.time,
    });
  },

  uuid_generate(args) {
    return uuidGenerate({
      version:   args.version,
      count:     args.count,
      name:      args.name,
      namespace: args.namespace,
      uppercase: args.uppercase,
    });
  },

  cron_next(args) {
    return nextOccurrences(args.expression, {
      count:  args.count,
      from:   args.from,
      format: args.format,
    });
  },

  diff_strings(args) {
    return diffStrings(args.a, args.b, {
      label_a: args.label_a,
      label_b: args.label_b,
      context: args.context,
      format:  args.format,
    });
  },

  password_generate(args) {
    return generatePasswords({
      mode:              args.mode,
      count:             args.count,
      length:            args.length,
      include_lowercase: args.include_lowercase,
      include_uppercase: args.include_uppercase,
      include_digits:    args.include_digits,
      include_symbols:   args.include_symbols,
      symbols:           args.symbols,
      exclude_chars:     args.exclude_chars,
      word_count:        args.word_count,
      word_separator:    args.word_separator,
      capitalize_words:  args.capitalize_words,
      add_number:        args.add_number,
    });
  },

};

module.exports = { READ_DISPATCH };
