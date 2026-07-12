"use strict";
const { extractRichDocument } = require("./pdfRichExtractOps");
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
const { templateRender } = require("./templateRenderOps");
const { base62Encode, base62Decode } = require("./base62Ops");
const { markdownToHtml } = require("./markdownHtmlOps");
const { xmlParse } = require("./xmlParseOps");
const { stringTransform } = require("./stringTransformOps");
const { ipCidr } = require("./ipCidrOps");
const { urlParse } = require("./urlParseOps");
const { colorConvert } = require("./colorConvertOps");
const { numberFormat } = require("./numberFormatOps");
const { dateCalc } = require("./dateCalcOps");
const { textExtract } = require("./textExtractOps");
const { strSimilarity } = require("./strSimilarityOps");
const { tableOps } = require("./tableOps");
const { graphqlQuery } = require("./graphqlQueryOps");
const { jsonlOps } = require("./jsonlOps");
const { tlsCertInspect } = require("./tlsCertInspectOps");
const { httpMultiFetch } = require("./httpMultiFetchOps");
const { keyGenerate } = require("./keyGenerateOps");
const { oauth2Token } = require("./oauth2TokenOps");
const { parseSemver, compareSemver, satisfiesRange } = require("./semverOps");
const { multipartUpload } = require("./multipartUploadOps");
const { httpServe } = require("./httpServeOps");
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
const { websocketClient } = require("./websocketClientOps");
const { sseClient }       = require("./sseClientOps");
const { tcpClient }       = require("./tcpClientOps");
const { udpClient }       = require("./udpClientOps");
const { sshExec }         = require("./sshExecOps");
const { smtpClient }      = require("./smtpClientOps");
const { imapClient }      = require("./imapClientOps");
const { redisClient }     = require("./redisClientOps");
const { mqttClient }      = require("./mqttClientOps");
const { amqpClient }      = require("./amqpClientOps");
const { stompClient }     = require("./stompClientOps");
const { natsClient }      = require("./natsClientOps");
const { ldapClient }      = require("./ldapClientOps");
const { ftpClient }       = require("./ftpClientOps");
const { snmpClient }      = require("./snmpClientOps");
const { grpcClient }      = require("./grpcClientOps");
const { kafkaClient }     = require("./kafkaClientOps");
const { memcachedClient } = require("./memcachedClientOps");
const { dotenvClient }    = require("./dotenvClientOps");
const { tomlClient }      = require("./tomlClientOps");
const { yamlClient }      = require("./yamlClientOps");
const { iniClient }       = require("./iniClientOps");
const { xmlClient }       = require("./xmlClientOps");
const { markdownClient }  = require("./markdownClientOps");
const { csvClient }       = require("./csvClientOps");
const { jsonlClient }     = require("./jsonlClientOps");
const { httpClient }      = require("./httpClientOps");
const { graphqlClient }   = require("./graphqlClientOps");
const { queryPath } = require("./jsonPathOps");
const {
  MAX_IMAGE_FILE_SIZE,
  detectImageFormat,
  imageInfo,
  imagePngResize,
  imagePngCrop,
  imagePngRotate,
  imagePngFlip,
  imagePngGrayscale,
} = require("./imageOps");
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

  template_render(args) {
    return templateRender({
      template: args.template,
      context:  args.context,
      partials: args.partials,
    });
  },

  base62_encode(args) {
    return base62Encode({
      number:     args.number,
      hex:        args.hex,
      bytes:      args.bytes,
      min_length: args.min_length,
    });
  },

  base62_decode(args) {
    return base62Decode({
      encoded: args.encoded,
      output:  args.output,
    });
  },


  markdown_to_html(args) {
    return markdownToHtml(args.markdown, { unsafe_html: args.unsafe_html });
  },

  string_transform(args) {
    return stringTransform({
      operation: args.operation,
      input:     args.input,
      // repeat
      count:     args.count,
      separator: args.separator,
      // truncate
      max_length: args.max_length,
      ellipsis:   args.ellipsis,
      // pad_*
      min_length: args.min_length,
      pad_char:   args.pad_char,
      // word_wrap
      max_width: args.max_width,
      newline:   args.newline,
    });
  },

  ip_cidr(args) {
    return ipCidr({
      operation:   args.operation,
      cidr:        args.cidr,
      ip:          args.ip,
      ips:         args.ips,
      max_results: args.max_results,
      bits:        args.bits,
      count:       args.count,
    });
  },

  xml_parse(args) {
    if (args.xml != null && args.path != null)
      throw new (require('./errors').ToolError)("xml_parse: provide 'xml' or 'path', not both.", -32602);
    let xmlStr;
    if (args.path != null) {
      const { resolved } = resolveClientPath(args.path);
      xmlStr = fs.readFileSync(resolved, 'utf8');
    } else if (args.xml != null) {
      if (typeof args.xml !== 'string')
        throw new (require('./errors').ToolError)("xml_parse: 'xml' must be a string.", -32602);
      xmlStr = args.xml;
    } else {
      throw new (require('./errors').ToolError)("xml_parse: provide either 'xml' (string) or 'path' (file).", -32602);
    }
    return xmlParse(xmlStr, { query: args.query });
  },

  color_convert(args) {
    return colorConvert({
      operation: args.operation,
      color:     args.color,
      color2:    args.color2,
      to:        args.to,
      weight:    args.weight,
      type:      args.type,
    });
  },

  number_format(args) {
    return numberFormat(args);
  },

  date_calc(args) {
    return dateCalc(args);
  },

  text_extract(args) {
    return textExtract(args);
  },

  str_similarity(args) {
    return strSimilarity(args);
  },

  table_ops(args) {
    return tableOps(args);
  },

  graphql_query(args) {
    // Async — callers in executeTool.js must await the result.
    return graphqlQuery({
      url:            args.url,
      query:          args.query,
      variables:      args.variables,
      headers:        args.headers,
      operation_name: args.operation_name,
      timeout:        args.timeout,
    });
  },

  jsonl_ops(args) {
    return jsonlOps(args, resolveClientPath);
  },

  tls_cert_inspect(args) {
    // Async — callers in executeTool.js must await the result.
    return tlsCertInspect({
      operation:  args.operation,
      host:       args.host,
      port:       args.port,
      timeout:    args.timeout,
      servername: args.servername,
      warn_days:  args.warn_days,
    });
  },

  http_multi_fetch(args) {
    // Async — callers in executeTool.js must await the result.
    return httpMultiFetch({
      requests:    args.requests,
      concurrency: args.concurrency,
      timeout:     args.timeout,
      fail_fast:   args.fail_fast,
    });
  },

  key_generate(args) {
    return keyGenerate({
      type:            args.type,
      bits:            args.bits,
      public_exponent: args.public_exponent,
      curve:           args.curve,
      size:            args.size,
      encoding:        args.encoding,
    });
  },

  oauth2_token(args) {
    // Async — callers in executeTool.js must await the result.
    return oauth2Token(args);
  },

  async multipart_upload(args) {
    // Read disk files here (file I/O) before handing off to pure-logic layer.
    const files = [];
    for (const f of (args.files || [])) {
      if (!f.name) throw new ToolError("multipart_upload: each file entry must have a 'name'.", -32602);
      if (!f.path) throw new ToolError(`multipart_upload: file '${f.name}' must have a 'path'.`, -32602);
      const { resolved } = resolveClientPath(f.path);
      const data = fs.readFileSync(resolved);
      files.push({
        name:        f.name,
        filename:    f.filename || path.basename(f.path),
        contentType: f.content_type || "application/octet-stream",
        data,
      });
    }
    // inline_files arrive as strings; convert encoding here.
    const inlineFiles = (args.inline_files || []).map(f => ({
      name:        f.name,
      filename:    f.filename,
      data:        f.data,
      encoding:    f.encoding,
      contentType: f.content_type,
    }));
    return multipartUpload({
      url:         args.url,
      method:      args.method,
      fields:      args.fields,
      files,
      inlineFiles,
      headers:     args.headers,
      timeout:     args.timeout,
    });
  },

  http_serve(args) {
    // httpServe handles all operations (start/stop/status/requests/add_route/
    // clear_requests/wait). Some are async (start/stop/wait); callers in
    // executeTool.js must await the result.
    return httpServe(args);
  },

  websocket_client(args) {
    // Async — callers in executeTool.js must await the result.
    return websocketClient({
      url:          args.url,
      messages:     args.messages,
      timeout:      args.timeout,
      max_messages: args.max_messages,
      headers:      args.headers,
      subprotocol:  args.subprotocol,
    });
  },

  sse_client(args) {
    // Async — callers in executeTool.js must await the result.
    return sseClient({
      url:           args.url,
      headers:       args.headers,
      timeout:       args.timeout,
      max_events:    args.max_events,
      event_types:   args.event_types,
      last_event_id: args.last_event_id,
    });
  },

  tcp_client(args) {
    // Async — callers in executeTool.js must await the result.
    return tcpClient({
      host:           args.host,
      port:           args.port,
      secure:         args.secure,
      servername:     args.servername,
      messages:       args.messages,
      connect_timeout: args.connect_timeout,
      recv_timeout:   args.recv_timeout,
      timeout:        args.timeout,
      max_recv_bytes: args.max_recv_bytes,
      max_chunks:     args.max_chunks,
      recv_encoding:  args.recv_encoding,
    });
  },

  udp_client(args) {
    // Async — callers in executeTool.js must await the result.
    return udpClient({
      host:           args.host,
      port:           args.port,
      family:         args.family,
      messages:       args.messages,
      recv_timeout:   args.recv_timeout,
      timeout:        args.timeout,
      max_recv_bytes: args.max_recv_bytes,
      max_datagrams:  args.max_datagrams,
      recv_encoding:  args.recv_encoding,
      bind_port:      args.bind_port,
    });
  },


  image_ops(args) {
    const VALID_OPS = ["info", "resize", "crop", "rotate", "flip", "grayscale"];
    if (!args.operation)
      throw new ToolError("image_ops: 'operation' is required.", -32602);
    if (!VALID_OPS.includes(args.operation))
      throw new ToolError(
        `image_ops: unknown operation '${args.operation}'. Valid: ${VALID_OPS.join(", ")}.`,
        -32602,
      );

    // ── Load source image bytes ────────────────────────────────────────────────
    if (args.path != null && args.data != null)
      throw new ToolError("image_ops: provide 'path' or 'data', not both.", -32602);
    let srcBuf;
    if (args.path != null) {
      const { resolved } = resolveClientPath(args.path);
      const stat = fs.statSync(resolved);
      if (stat.size > MAX_IMAGE_FILE_SIZE)
        throw new ToolError(
          `image_ops: file too large (${stat.size} bytes; max ${MAX_IMAGE_FILE_SIZE}).`,
          -32602,
        );
      srcBuf = fs.readFileSync(resolved);
    } else if (args.data != null) {
      if (typeof args.data !== "string")
        throw new ToolError("image_ops: 'data' must be a base64-encoded string.", -32602);
      srcBuf = Buffer.from(args.data, "base64");
      if (srcBuf.length > MAX_IMAGE_FILE_SIZE)
        throw new ToolError("image_ops: 'data' too large (max 50 MB decoded).", -32602);
    } else {
      throw new ToolError(
        "image_ops: provide either 'path' (file path) or 'data' (base64 image bytes).",
        -32602,
      );
    }

    // ── info: header-only, all formats ─────────────────────────────────────────
    if (args.operation === "info") {
      return imageInfo(srcBuf);
    }

    // ── Pixel operations (PNG in → PNG out) ──────────────────────────────────
    let outBuf;
    switch (args.operation) {
      case "resize":
        outBuf = imagePngResize(srcBuf, {
          width:       args.width,
          height:      args.height,
          keep_aspect: args.keep_aspect,
        });
        break;
      case "crop":
        outBuf = imagePngCrop(srcBuf, {
          x:           args.x,
          y:           args.y,
          crop_width:  args.crop_width,
          crop_height: args.crop_height,
        });
        break;
      case "rotate":
        outBuf = imagePngRotate(srcBuf, { degrees: args.degrees });
        break;
      case "flip":
        outBuf = imagePngFlip(srcBuf, { axis: args.axis });
        break;
      case "grayscale":
        outBuf = imagePngGrayscale(srcBuf);
        break;
      default:
        throw new ToolError(`image_ops: unhandled operation '${args.operation}'.`, -32603);
    }

    // ── Output: disk or base64 ───────────────────────────────────────────────
    const meta = imageInfo(outBuf);
    if (args.output_path) {
      const { resolved: outResolved } = resolveClientPath(args.output_path);
      fs.mkdirSync(path.dirname(outResolved), { recursive: true });
      fs.writeFileSync(outResolved, outBuf);
      return { ...meta, savedTo: args.output_path, sizeBytes: outBuf.length };
    }
    return {
      ...meta,
      data:     outBuf.toString("base64"),
      encoding: "base64",
      sizeBytes: outBuf.length,
    };
  },
  pdf_rich_extract(args) {
    const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
    const MAX_BLOCKS = Math.min(
      Math.max(1, Math.trunc(args.max_blocks ?? 10000)),
      50000,
    );
    const includeImages = args.include_images !== false;

    if (!args.path)
      throw new ToolError(
        "pdf_rich_extract: 'path' is required.",
        -32602,
      );
    const { resolved } = resolveClientPath(args.path);
    const stat = fs.statSync(resolved);
    if (stat.size > MAX_FILE_SIZE)
      throw new ToolError(
        `pdf_rich_extract: file too large (${stat.size} bytes; max ${MAX_FILE_SIZE}).`,
        -32602,
      );
    const buf = fs.readFileSync(resolved);
    const { blocks: rawBlocks, imagesEmbedded } = extractRichDocument(buf);

    // Optionally strip image data; always cap block count.
    let blocks = includeImages
      ? rawBlocks
      : rawBlocks.map(b => b.kind === "image" ? { kind: "image", width: b.width, height: b.height, imageKind: b.imageKind } : b);
    const truncated = blocks.length > MAX_BLOCKS;
    if (truncated) blocks = blocks.slice(0, MAX_BLOCKS);

    // Serialize image data as base64 strings for JSON transport.
    blocks = blocks.map(b => {
      if (b.kind !== "image" || !b.data) return b;
      const { data, ...rest } = b;
      return { ...rest, imageData: Buffer.isBuffer(data) ? data.toString("base64") : data };
    });

    return {
      path: args.path,
      blockCount: blocks.length,
      truncated,
      imagesEmbedded,
      blocks,
    };
  },

  smtp_client(args) {
    // Async — callers in executeTool.js must await the result.
    return smtpClient({
      operation:          args.operation,
      host:               args.host,
      port:               args.port,
      secure:             args.secure,
      starttls:           args.starttls,
      reject_unauthorized: args.reject_unauthorized,
      helo_name:          args.helo_name,
      timeout:            args.timeout,
      connect_timeout:    args.connect_timeout,
      auth:               args.auth,
      from:               args.from,
      to:                 args.to,
      cc:                 args.cc,
      bcc:                args.bcc,
      subject:            args.subject,
      body_text:          args.body_text,
      body_html:          args.body_html,
      extra_headers:      args.extra_headers,
      target:             args.target,
      vrfy_mode:          args.vrfy_mode,
    });
  },

  imap_client(args) {
    // Async — callers in executeTool.js must await the result.
    return imapClient(args);
  },

  ssh_exec(args) {
    // sshExec is synchronous (spawnSync) — no await needed.
    return sshExec({
      operation:                args.operation,
      host:                     args.host,
      user:                     args.user,
      port:                     args.port,
      key_path:                 args.key_path,
      key_data:                 args.key_data,
      strict_host_key_checking: args.strict_host_key_checking,
      timeout:                  args.timeout,
      command:                  args.command,
      local_path:               args.local_path,
      remote_path:              args.remote_path,
      recursive:                args.recursive,
    });
  },

  redis_client(args) {
    // Async — callers in executeTool.js must await the result.
    return redisClient(args);
  },

  mqtt_client(args) {
    // Async — callers in executeTool.js must await the result.
    return mqttClient(args);
  },

  amqp_client(args) {
    // Async — callers in executeTool.js must await the result.
    return amqpClient(args);
  },

  stomp_client(args) {
    // Async — callers in executeTool.js must await the result.
    return stompClient(args);
  },

  nats_client(args) {
    // Async — callers in executeTool.js must await the result.
    return natsClient(args);
  },

  ldap_client(args) {
    // Async — callers in executeTool.js must await the result.
    return ldapClient(args);
  },

  snmp_client(args) {
    // Async - callers in executeTool.js must await the result.
    return snmpClient(args);
  },

  ftp_client(args) {
    // Async — callers in executeTool.js must await the result.
    return ftpClient({
      host:               args.host,
      port:               args.port,
      ftps:               args.ftps,
      reject_unauthorized: args.reject_unauthorized,
      username:           args.username,
      password:           args.password,
      timeout:            args.timeout,
      connect_timeout:    args.connect_timeout,
      operation:          args.operation,
      path:               args.path,
      new_name:           args.new_name,
      data:               args.data,
      encoding:           args.encoding,
      binary:             args.binary,
    });
  },

  kafka_client(args) {
    // Async — callers in executeTool.js must await the result.
    return kafkaClient(args);
  },

  memcached_client(args) {
    // Async — callers in executeTool.js must await the result.
    return memcachedClient(args);
  },

  grpc_client(args) {
    // Async — callers in executeTool.js must await the result.
    return grpcClient(args);
  },

  dotenv_client(args) {
    // Pure sync fs — no await needed.
    return dotenvClient(args);
  },

  toml_client(args) {
    // Pure sync fs — no await needed.
    return tomlClient(args);
  },

  yaml_client(args) {
    // Pure sync fs — no await needed.
    return yamlClient(args);
  },

  ini_client(args) {
    // Pure sync fs — no await needed.
    return iniClient(args);
  },

  xml_client(args) {
    // Pure sync fs — no await needed.
    return xmlClient(args);
  },

  markdown_client(args) {
    // Pure sync fs — no await needed.
    return markdownClient(args);
  },

  csv_client(args) {
    // Pure sync fs — no await needed.
    return csvClient(args);
  },

  jsonl_client(args) {
    // Pure sync fs — no await needed.
    return jsonlClient(args);
  },

  http_client(args) {
    // Async — callers in executeTool.js must await the result.
    return httpClient(args);
  },

  graphql_client(args) {
    // Async — callers in executeTool.js must await the result.
    return graphqlClient(args);
  },

};

module.exports = { READ_DISPATCH };
