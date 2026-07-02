"use strict";
// ── WRITE / EXEC TOOL DISPATCH HANDLERS ────────────────────────────────────────
// Extracted from lib/executeTool.js (which had grown past the 500-line
// threshold) so that file can stay a thin validator + switch/lookup table.
// Each handler is `(args) => result` and receives the same `args` object
// the JSON-RPC caller sent (already schema-validated by validateArgs).

const fs   = require("fs");
const path = require("path");

const { resolveClientPath } = require("./roots");
const {
  readDirRecursive, writeLines, writeMultipleFiles, deleteMultipleFiles,
  replaceInSingleFile, truncateFile, appendFile,
} = require("./fileOps");
const {
  runCommand, startProcess, getProcessOutput, killProcess, listProcesses,
} = require("./processOps");
const { base64Decode } = require("./encodingOps");
const { jsonPatch }     = require("./jsonPatchOps");
const { jsonFormat, textTransform } = require("./textOps");
const { applyPatch }   = require("./patchOps");
const { moveFile, copyFile } = require("./moveOps");
const { moveDirectory, copyDirectory } = require("./moveDirOps");
const { unzipArchive } = require("./unzipOps");
const { yamlPatch }    = require("./yamlPatchOps");
const { yamlMerge }    = require("./yamlMergeOps");
const { convertData }  = require("./convertOps");
const { csvConvert }   = require("./csvConvertOps");
const { gzipCompress, gzipDecompress } = require("./gzipOps");
const { brotliCompress, brotliDecompress } = require("./brotliOps");
const { mdToDocx, docxToMd } = require("./docxConvertOps");
const { mdToPdf, pdfToMd } = require("./pdfConvertOps");
const { docxToPdf } = require("./docxToPdfOps");
const { pdfToDocx } = require("./pdfToDocxOps");

const WRITE_DISPATCH = {

  truncate_file(args) {
    const { resolved } = resolveClientPath(args.path);
    const lines = args.lines != null ? Math.trunc(args.lines) : null;
    const bytes = args.bytes != null ? Math.trunc(args.bytes) : null;
    return { path: args.path, ...truncateFile(resolved, lines, bytes) };
  },

  append_file(args) {
    const { resolved } = resolveClientPath(args.path);
    return { path: args.path, ...appendFile(resolved, args.content ?? "") };
  },

  base64_decode(args) {
    const { resolved: dstResolved } = resolveClientPath(args.destination);
    return base64Decode(args.data, dstResolved, args.destination);
  },

  json_format(args) {
    const { resolved } = resolveClientPath(args.path);
    return jsonFormat(resolved, args.path, {
      indent:   args.indent,
      in_place: args.in_place,
    });
  },

  text_transform(args) {
    const { resolved } = resolveClientPath(args.path);
    return textTransform(resolved, args.path, args.transforms, {
      in_place: args.in_place,
    });
  },

  write_file(args) {
    const { resolved } = resolveClientPath(args.path);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    return { path: args.path, ...writeLines(resolved, args.content, args.from_line ?? 0, args.to_line ?? 0) };
  },

  write_files(args) {
    return { results: writeMultipleFiles(args.files) };
  },

  create_file(args) {
    const { resolved } = resolveClientPath(args.path);
    if (fs.existsSync(resolved)) throw new Error(`File already exists: ${args.path}`);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, args.content || "", "utf8");
    return { created: args.path };
  },

  create_files(args) {
    const results = {};
    for (const item of args.files) {
      try {
        const { resolved } = resolveClientPath(item.path);
        if (fs.existsSync(resolved)) throw new Error(`File already exists: ${item.path}`);
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, item.content || "", "utf8");
        results[item.path] = { created: true };
      } catch (e) { results[item.path] = { error: e.message }; }
    }
    return { results };
  },

  delete_file(args) {
    const { resolved } = resolveClientPath(args.path);
    fs.unlinkSync(resolved);
    return { deleted: args.path };
  },

  delete_files(args) {
    return { results: deleteMultipleFiles(args.paths) };
  },

  move_file(args) {
    const { root: srcRoot, resolved: src } = resolveClientPath(args.source);
    const { root: dstRoot, resolved: dst } = resolveClientPath(args.destination);
    const result = moveFile(src, srcRoot, dst, dstRoot, { overwrite: !!args.overwrite });
    return { moved: args.source, to: args.destination, ...result };
  },

  copy_file(args) {
    const { root: srcRoot, resolved: src } = resolveClientPath(args.source);
    const { root: dstRoot, resolved: dst } = resolveClientPath(args.destination);
    const result = copyFile(src, srcRoot, dst, dstRoot, { overwrite: !!args.overwrite });
    return { copied: args.source, to: args.destination, ...result };
  },

  move_directory(args) {
    const { root: srcRoot, resolved: src } = resolveClientPath(args.source);
    const { root: dstRoot, resolved: dst } = resolveClientPath(args.destination);
    const result = moveDirectory(src, srcRoot, dst, dstRoot, { overwrite: !!args.overwrite });
    return { moved: args.source, to: args.destination, ...result };
  },

  copy_directory(args) {
    const { root: srcRoot, resolved: src } = resolveClientPath(args.source);
    const { root: dstRoot, resolved: dst } = resolveClientPath(args.destination);
    const result = copyDirectory(src, srcRoot, dst, dstRoot, { overwrite: !!args.overwrite });
    return { copied: args.source, to: args.destination, ...result };
  },

  create_directory(args) {
    const { resolved } = resolveClientPath(args.path);
    fs.mkdirSync(resolved, { recursive: true });
    return { created: args.path };
  },

  delete_directory(args) {
    const { resolved } = resolveClientPath(args.path);
    fs.rmSync(resolved, { recursive: !!args.recursive, force: !!args.recursive });
    return { deleted: args.path };
  },

  replace_in_file(args) {
    const { search, replace, is_regex, flags } = args;
    if (!search) throw new Error("replace_in_file requires a 'search' field.");
    if (replace === undefined || replace === null) throw new Error("replace_in_file requires a 'replace' field.");

    const dryRun = !!args.dry_run;
    const { alias, resolved } = resolveClientPath(args.path || ".");
    const stat = fs.statSync(resolved);

    if (!stat.isDirectory()) {
      const result = replaceInSingleFile(resolved, args.path, search, replace, !!is_regex, flags, { dryRun });
      return { filesScanned: 1, filesModified: result.replacements > 0 ? 1 : 0, dryRun, results: [result] };
    }

    const entries = readDirRecursive(resolved, true, alias).filter(e => e.type === "file");
    const exts    = args.extensions?.length ? args.extensions : null;
    const results = [];
    for (const f of entries) {
      if (exts && !exts.some(x => f.path.endsWith(x))) continue;
      try {
        const { resolved: fRes } = resolveClientPath(f.path);
        results.push(replaceInSingleFile(fRes, f.path, search, replace, !!is_regex, flags, { dryRun }));
      } catch (e) {
        results.push({ file: f.path, error: e.message });
      }
    }
    const modified = results.filter(r => r.replacements > 0).length;
    return {
      filesScanned:  results.length,
      filesModified: modified,
      dryRun,
      totalReplacements: results.reduce((n, r) => n + (r.replacements || 0), 0),
      results,
    };
  },

  // ── Exec ──────────────────────────────────────────────────────────────────

  run_command(args) {
    return runCommand(args);
  },

  start_process(args) {
    return startProcess(args);
  },

  get_process_output(args) {
    return getProcessOutput(args);
  },

  kill_process(args) {
    return killProcess(args);
  },

  list_processes() {
    return listProcesses();
  },

  unzip_archive(args) {
    const { resolved: zipResolved } = resolveClientPath(args.path);
    const { resolved: destResolved } = resolveClientPath(args.destination);
    const result = unzipArchive(zipResolved, destResolved, { overwrite: !!args.overwrite });
    return { source: args.path, destination: args.destination, ...result };
  },

  json_patch(args) {
    const { resolved } = resolveClientPath(args.path);
    return jsonPatch(resolved, args.path, args.ops, { apply: args.apply });
  },

  apply_patch(args) {
    const { resolved } = resolveClientPath(args.path);
    return applyPatch(resolved, args.path, args.patch, {
      strict:  args.strict,
      dry_run: args.dry_run,
    });
  },

  yaml_patch(args) {
    const { resolved } = resolveClientPath(args.path);
    return yamlPatch(resolved, args.path, args.ops, { apply: args.apply });
  },

  yaml_merge(args) {
    const { resolved } = resolveClientPath(args.path);
    return yamlMerge(resolved, args.path, args.patch, { apply: args.apply });
  },

  convert_data(args) {
    const { resolved } = resolveClientPath(args.path);
    const opts = { format: args.format, to: args.to, indent: args.indent, apply: args.apply };
    if (args.destination) {
      const { resolved: destResolved } = resolveClientPath(args.destination);
      opts.destinationResolved = destResolved;
      opts.destinationClientPath = args.destination;
    }
    return convertData(resolved, args.path, opts);
  },

  csv_convert(args) {
    const { resolved } = resolveClientPath(args.path);
    const opts = {
      format: args.format, to: args.to, has_header: args.has_header,
      indent: args.indent, apply: args.apply,
    };
    if (args.destination) {
      const { resolved: destResolved } = resolveClientPath(args.destination);
      opts.destinationResolved = destResolved;
      opts.destinationClientPath = args.destination;
    }
    return csvConvert(resolved, args.path, opts);
  },

  gzip_compress(args) {
    const { resolved: srcResolved } = resolveClientPath(args.path);
    const { resolved: dstResolved } = resolveClientPath(args.destination);
    return gzipCompress(srcResolved, args.path, dstResolved, args.destination, { level: args.level });
  },

  gzip_decompress(args) {
    const { resolved: srcResolved } = resolveClientPath(args.path);
    const { resolved: dstResolved } = resolveClientPath(args.destination);
    return gzipDecompress(srcResolved, args.path, dstResolved, args.destination);
  },

  brotli_compress(args) {
    const { resolved: srcResolved } = resolveClientPath(args.path);
    const { resolved: dstResolved } = resolveClientPath(args.destination);
    return brotliCompress(srcResolved, args.path, dstResolved, args.destination, { quality: args.quality });
  },

  brotli_decompress(args) {
    const { resolved: srcResolved } = resolveClientPath(args.path);
    const { resolved: dstResolved } = resolveClientPath(args.destination);
    return brotliDecompress(srcResolved, args.path, dstResolved, args.destination);
  },

  md_to_docx(args) {
    const { resolved: srcResolved } = resolveClientPath(args.path);
    const { resolved: dstResolved } = resolveClientPath(args.destination);
    return mdToDocx(srcResolved, args.path, dstResolved, args.destination);
  },

  docx_to_md(args) {
    const { resolved: srcResolved } = resolveClientPath(args.path);
    const { resolved: dstResolved } = resolveClientPath(args.destination);
    return docxToMd(srcResolved, args.path, dstResolved, args.destination);
  },

  md_to_pdf(args) {
    const { resolved: srcResolved } = resolveClientPath(args.path);
    const { resolved: dstResolved } = resolveClientPath(args.destination);
    return mdToPdf(srcResolved, args.path, dstResolved, args.destination);
  },

  pdf_to_md(args) {
    const { resolved: srcResolved } = resolveClientPath(args.path);
    const { resolved: dstResolved } = resolveClientPath(args.destination);
    return pdfToMd(srcResolved, args.path, dstResolved, args.destination);
  },

  docx_to_pdf(args) {
    const { resolved: srcResolved } = resolveClientPath(args.path);
    const { resolved: dstResolved } = resolveClientPath(args.destination);
    return docxToPdf(srcResolved, args.path, dstResolved, args.destination);
  },

  pdf_to_docx(args) {
    const { resolved: srcResolved } = resolveClientPath(args.path);
    const { resolved: dstResolved } = resolveClientPath(args.destination);
    return pdfToDocx(srcResolved, args.path, dstResolved, args.destination);
  },


  // execute_pipeline is dispatched directly in executeTool.js since it
  // needs to call back into executeTool() itself (circular within-module
  // call, not a clean standalone handler).
};

module.exports = { WRITE_DISPATCH };
