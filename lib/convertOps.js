"use strict";
// ── convert_data — convert a JSON document to YAML or vice versa ─────────────
// Thin glue over the existing zero-dep parser/serialiser pair:
//   lib/yamlOps.js          parseYaml(text)      → JS value
//   lib/yamlSerializeOps.js serializeYaml(value) → YAML text
// JSON parsing/serialisation uses the built-in JSON object.
//
// Source format is auto-detected from the source file's extension (.yaml/.yml
// → yaml, everything else → json), same convention as query_data/query_path,
// and can be overridden with an explicit `format` argument. Target format
// defaults to "the other one" but can be forced with `to` (including
// re-serialising the same format, which is a legitimate pretty-print/
// normalise use case, not an error).
//
// If a `destinationResolved`/`destinationClientPath` pair is supplied, the
// converted text is written there (respecting `apply: false` for a dry-run
// preview). Without a destination, the converted text is simply returned —
// no write occurs, so a read-only caller can still use this for pure format
// inspection/preview even under MCP_READ_ONLY (the destination-writing path
// is what's gated, via WRITE_TOOLS, same convention as apply_patch/json_patch
// always being gated regardless of their own dry_run/apply flag).

const fs   = require("fs");
const path = require("path");

const { parseYaml }     = require("./yamlOps");
const { serializeYaml } = require("./yamlSerializeOps");
const { ToolError }     = require("./errors");

const VALID_FORMATS = new Set(["json", "yaml"]);

function detectFormat(clientPath) {
  const ext = path.extname(clientPath || "").toLowerCase();
  return (ext === ".yaml" || ext === ".yml") ? "yaml" : "json";
}

function parseByFormat(raw, format) {
  if (format === "yaml") return parseYaml(raw);
  return JSON.parse(raw);
}

function serializeByFormat(value, format, indent) {
  if (format === "yaml") return serializeYaml(value);
  return JSON.stringify(value, null, indent) + "\n";
}

/**
 * @param {string} srcResolved       absolute path to the source file on disk
 * @param {string} srcClientPath     original client-facing path (for echo + format detection)
 * @param {object} opts
 * @param {string} [opts.format]     force source format ("json"|"yaml") instead of auto-detecting by extension
 * @param {string} [opts.to]         target format ("json"|"yaml"); defaults to the format that isn't the source's
 * @param {number} [opts.indent]     JSON output indent (default 2, clamped to >= 0); ignored for yaml target
 * @param {string} [opts.destinationResolved]   absolute path to write the converted text to
 * @param {string} [opts.destinationClientPath] client-facing destination path (echoed back)
 * @param {boolean}[opts.apply]      when a destination is given, false = dry-run preview only (default true)
 * @returns {{path, sourceFormat, targetFormat, indent, converted, destination?, written?}}
 */
function convertData(srcResolved, srcClientPath, opts = {}) {
  const sourceFormat = opts.format || detectFormat(srcClientPath);
  if (!VALID_FORMATS.has(sourceFormat)) {
    throw new ToolError(`convert_data: unsupported source format '${sourceFormat}'. Must be 'json' or 'yaml'.`, -32602);
  }

  const targetFormat = opts.to || (sourceFormat === "yaml" ? "json" : "yaml");
  if (!VALID_FORMATS.has(targetFormat)) {
    throw new ToolError(`convert_data: unsupported target format '${targetFormat}'. Must be 'json' or 'yaml'.`, -32602);
  }

  const stat = fs.statSync(srcResolved);
  if (stat.isDirectory()) {
    throw new ToolError(`convert_data: '${srcClientPath}' is a directory, not a file.`, -32602);
  }

  const raw = fs.readFileSync(srcResolved, "utf8");
  let value;
  try {
    value = parseByFormat(raw, sourceFormat);
  } catch (e) {
    throw new Error(`convert_data: failed to parse source as ${sourceFormat}: ${e.message}`);
  }

  let indent = opts.indent != null ? Math.trunc(opts.indent) : 2;
  if (!Number.isFinite(indent) || indent < 0) indent = 2;

  const converted = serializeByFormat(value, targetFormat, indent);

  const result = {
    path: srcClientPath,
    sourceFormat,
    targetFormat,
    indent: targetFormat === "json" ? indent : undefined,
    converted,
  };

  if (opts.destinationResolved) {
    const apply = opts.apply !== false;
    result.destination = opts.destinationClientPath;
    result.written = false;
    if (apply) {
      fs.mkdirSync(path.dirname(opts.destinationResolved), { recursive: true });
      fs.writeFileSync(opts.destinationResolved, converted, "utf8");
      result.written = true;
    }
  }

  return result;
}

module.exports = { convertData, detectFormat };
