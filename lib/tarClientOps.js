"use strict";
// ── TAR_CLIENT ──────────────────────────────────────────────────────────────────
// Fine-grained TAR file manipulation tool (pure Node.js; zero npm deps).
// Builds on the existing TAR infrastructure in tarOps.js (USTAR reader/writer).
//
// Supported formats (auto-detected on read):
//   .tar          — plain USTAR
//   .tar.gz/.tgz  — gzip-compressed
//   .tar.bz2      — bzip2 header detected (rejects with clear message; no pure-JS bzip2)
//   .tar.xz       — xz header detected (rejects with clear message; no pure-JS xz)
//
// Operations:
//   list     — enumerate entries with full metadata
//   read     — read a single entry's content (text or base64)
//   extract  — selectively extract entries to a destination directory
//   add      — add or replace files in an existing TAR (or create new)
//   delete   — remove specific entries from a TAR
//   create   — create a TAR from an explicit list of host paths
//   info     — summary statistics for a TAR archive
//
// Security:
//   • Path NUL guard on all file paths
//   • 500 MB TAR read cap (uncompressed)
//   • 10 MB per-entry read cap for the 'read' operation
//   • Tar Slip prevention on all extract operations (reused from tarOps.js)
//   • Entry name NUL/absolute/traversal guard on 'add'/'create'
//   • Symlink/hardlink/device/fifo entries rejected on extract

const fs   = require("fs");
const path = require("path");
const zlib = require("zlib");
const { ToolError } = require("./errors");

// ── Re-use TAR primitives from tarOps.js ─────────────────────────────────────
const {
  parseTar,
  assertSafeEntryName,
  splitName,
} = require("./tarOps");

// Re-use collectFiles from zipDirOps (already used by tarOps.js)
const { collectFiles } = require("./zipDirOps");

// ── Constants ─────────────────────────────────────────────────────────────────
const MAX_TAR_BYTES  = 500 * 1024 * 1024; // 500 MB (uncompressed)
const MAX_READ_BYTES = 10  * 1024 * 1024; // 10 MB per-entry read
const MAX_ENTRIES    = 100_000;
const BLOCK_SIZE     = 512;

// ── Magic bytes for compression format detection ─────────────────────────────
const GZIP_MAGIC  = Buffer.from([0x1f, 0x8b]);
const BZ2_MAGIC   = Buffer.from([0x42, 0x5a, 0x68]);     // BZh
const XZ_MAGIC    = Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]); // \xfd7zXZ\x00

// ── Low-level USTAR header writer (mirrors tarOps.js buildHeader) ────────────
function writeOctalField(buf, offset, len, value) {
  const oct = Math.max(0, Math.trunc(value)).toString(8);
  if (oct.length > len - 1)
    throw new ToolError(`tar_client: value ${value} too large for USTAR header field.`, -32602);
  buf.write(oct.padStart(len - 1, "0"), offset, len - 1, "ascii");
  buf[offset + len - 1] = 0;
}

function buildHeader(relPath, size, mtimeSec) {
  const { prefix, name } = splitName(relPath);
  const buf = Buffer.alloc(BLOCK_SIZE, 0);
  buf.write(name, 0, 100, "utf8");
  writeOctalField(buf, 100, 8, 0o644);       // mode
  writeOctalField(buf, 108, 8, 0);           // uid
  writeOctalField(buf, 116, 8, 0);           // gid
  writeOctalField(buf, 124, 12, size);       // size
  writeOctalField(buf, 136, 12, mtimeSec);   // mtime
  buf.fill(0x20, 148, 156);                  // chksum placeholder (spaces)
  buf[156] = 0x30;                           // typeflag '0' = regular file
  buf.write("ustar", 257, 6, "ascii");       // magic
  buf.write("00", 263, 2, "ascii");          // version
  if (prefix) buf.write(prefix, 345, 155, "utf8");

  // Compute and write checksum
  let sum = 0;
  for (let i = 0; i < BLOCK_SIZE; i++) sum += buf[i];
  buf.write(sum.toString(8).padStart(6, "0"), 148, 6, "ascii");
  buf[154] = 0;
  buf[155] = 0x20;
  return buf;
}

function padBlock(size) {
  const pad = (BLOCK_SIZE - (size % BLOCK_SIZE)) % BLOCK_SIZE;
  return pad === 0 ? Buffer.alloc(0) : Buffer.alloc(pad, 0);
}

/** Serialise entry descriptors to a TAR buffer. */
function buildTarBuffer(entries) {
  const blocks = [];
  for (const e of entries) {
    const data     = e.data;
    const mtimeSec = e.mtime ? Math.floor(e.mtime.getTime() / 1000) : Math.floor(Date.now() / 1000);
    blocks.push(buildHeader(e.name, data.length, mtimeSec));
    blocks.push(data, padBlock(data.length));
  }
  // Two zero blocks = end of archive
  blocks.push(Buffer.alloc(BLOCK_SIZE * 2, 0));
  return Buffer.concat(blocks);
}

// ── Path / entry-name validation ─────────────────────────────────────────────
function guardPath(p, label) {
  if (typeof p !== "string" || p.length === 0)
    throw new ToolError(`${label}: path must be a non-empty string.`, -32602);
  if (p.indexOf("\0") !== -1)
    throw new ToolError(`${label}: path contains a NUL byte.`, -32602);
}

function guardEntryName(name, label) {
  if (typeof name !== "string" || name.length === 0)
    throw new ToolError(`${label}: entry name must be a non-empty string.`, -32602);
  if (name.indexOf("\0") !== -1)
    throw new ToolError(`${label}: entry name contains a NUL byte.`, -32602);
  if (name.startsWith("/") || name.startsWith("\\") || /^[A-Za-z]:/.test(name))
    throw new ToolError(`${label}: entry name is an absolute path — not allowed.`, -32602);
  if (name.split(/[/\\]/).some(s => s === ".."))
    throw new ToolError(`${label}: entry name contains a '..' segment — not allowed.`, -32602);
}

/** Detect compression format from magic bytes, then decompress. */
function readAndDecompress(tarPath, op) {
  if (!fs.existsSync(tarPath))
    throw new ToolError(`${op}: TAR file not found: ${tarPath}`, -32602);
  const stat = fs.statSync(tarPath);
  if (stat.isDirectory())
    throw new ToolError(`${op}: '${tarPath}' is a directory, not a TAR file.`, -32602);

  let buf = fs.readFileSync(tarPath);

  // gzip
  if (buf.length >= 2 && buf[0] === GZIP_MAGIC[0] && buf[1] === GZIP_MAGIC[1]) {
    try {
      buf = zlib.gunzipSync(buf);
    } catch (e) {
      throw new ToolError(`${op}: gzip decompression failed — ${e.message}`, -32602);
    }
  }
  // bzip2 (no pure-JS impl — reject with clear message)
  else if (buf.length >= 3 && buf[0] === BZ2_MAGIC[0] && buf[1] === BZ2_MAGIC[1] && buf[2] === BZ2_MAGIC[2]) {
    throw new ToolError(
      `${op}: bzip2-compressed TAR (.tar.bz2/.tbz2) is not supported. ` +
      `Please decompress with bzip2 first, or use a .tar.gz/.tgz archive.`,
      -32602);
  }
  // xz (no pure-JS impl — reject with clear message)
  else if (buf.length >= 6 && buf.slice(0, 6).equals(XZ_MAGIC)) {
    throw new ToolError(
      `${op}: xz-compressed TAR (.tar.xz/.txz) is not supported. ` +
      `Please decompress with xz first, or use a .tar.gz/.tgz archive.`,
      -32602);
  }

  if (buf.length > MAX_TAR_BYTES)
    throw new ToolError(
      `${op}: TAR too large (${buf.length} bytes > ${MAX_TAR_BYTES} limit after decompression).`,
      -32602);

  return buf;
}

/** Parse TAR buffer and enforce entry count cap. */
function parsedEntries(buf) {
  const raw = parseTar(buf);
  if (raw.length > MAX_ENTRIES)
    throw new ToolError(
      `tar_client: too many entries (${raw.length} > ${MAX_ENTRIES} limit).`, -32602);
  return raw;
}

// ── helpers ───────────────────────────────────────────────────────────────────

/** Read raw bytes for one entry out of already-decompressed tar buffer. */
function readEntryBytes(buf, entry) {
  return buf.subarray(entry.dataStart, entry.dataEnd);
}

/** Build a glob-style filter regex from a pattern that supports * wildcard. */
function makeFilter(pattern) {
  if (!pattern) return null;
  // Escape all regex metacharacters EXCEPT *, then replace escaped \* with .*
  const escaped = pattern
    .replace(/[-[\]{}()+?.,\\^$|#\s]/g, "\\$&") // escape metacharacters (not *)
    .replace(/\*/g, ".*");                         // * → .* (after escaping, * is untouched)
  return new RegExp("^" + escaped + "$", "i");
}

/** Read tar mtime octal field and return ISO string (best-effort). */
function readModifiedTime(buf, entry) {
  // The parseTar function does not return mtime; we need to re-read the raw header.
  // Entry.dataStart points AFTER the 512-byte header block, so header is at dataStart - 512 - padding_before.
  // Instead we derive it: header block = dataStart - BLOCK_SIZE (for 0-size entries) or
  // more precisely it's always dataStart - BLOCK_SIZE since parseTar advances pos += BLOCK_SIZE then sets dataStart=pos.
  try {
    const headerOffset = entry.dataStart - BLOCK_SIZE;
    if (headerOffset < 0) return null;
    const headerBlock = buf.subarray(headerOffset, headerOffset + BLOCK_SIZE);
    const mtimeSec = parseInt(headerBlock.toString("ascii", 136, 148).replace(/\0.*$/s, "").trim(), 8);
    if (!Number.isFinite(mtimeSec) || mtimeSec === 0) return null;
    return new Date(mtimeSec * 1000).toISOString();
  } catch { return null; }
}

/** Read uid/gid/mode from raw header. */
function readHeaderMeta(buf, entry) {
  try {
    const headerOffset = entry.dataStart - BLOCK_SIZE;
    if (headerOffset < 0) return {};
    const h = buf.subarray(headerOffset, headerOffset + BLOCK_SIZE);
    const mode = parseInt(h.toString("ascii", 100, 108).replace(/\0.*$/s, "").trim(), 8);
    const uid  = parseInt(h.toString("ascii", 108, 116).replace(/\0.*$/s, "").trim(), 8);
    const gid  = parseInt(h.toString("ascii", 116, 124).replace(/\0.*$/s, "").trim(), 8);
    const uname = h.toString("utf8", 265, 297).replace(/\0.*$/s, "");
    const gname = h.toString("utf8", 297, 329).replace(/\0.*$/s, "");
    return {
      mode: Number.isNaN(mode) ? null : "0" + mode.toString(8),
      uid:  Number.isNaN(uid)  ? null : uid,
      gid:  Number.isNaN(gid)  ? null : gid,
      uname: uname || null,
      gname: gname || null,
    };
  } catch { return {}; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Operations
// ─────────────────────────────────────────────────────────────────────────────

function opList(args) {
  guardPath(args.path, "list");
  const buf     = readAndDecompress(args.path, "list");
  const entries = parsedEntries(buf);
  const filter  = makeFilter(args.filter);

  let totalBytes = 0;
  const result = [];
  for (const e of entries) {
    if (filter && !filter.test(e.name)) continue;
    const isDir = e.typeflag === "5";
    if (!isDir) totalBytes += e.size;
    const meta = readHeaderMeta(buf, e);
    result.push({
      name:         e.name,
      isDirectory:  isDir,
      size:         e.size,
      modifiedTime: readModifiedTime(buf, e),
      mode:         meta.mode  || null,
      uid:          meta.uid   ?? null,
      gid:          meta.gid   ?? null,
      uname:        meta.uname || null,
      gname:        meta.gname || null,
      typeflag:     e.typeflag === "0" || e.typeflag === "\0" ? "file" : e.typeflag === "5" ? "directory" : e.typeflag,
    });
  }

  return {
    path:        args.path,
    totalEntries: result.length,
    totalBytes,
    entries:     result,
  };
}

function opRead(args) {
  guardPath(args.path, "read");
  if (!args.entry) throw new ToolError("read: 'entry' is required.", -32602);
  guardEntryName(args.entry, "read");

  const buf     = readAndDecompress(args.path, "read");
  const entries = parsedEntries(buf);
  const target  = entries.find(e => e.name === args.entry);
  if (!target) {
    throw new ToolError(
      `read: entry '${args.entry}' not found in '${args.path}'. ` +
      `Use tar_client list to see available entries.`, -32602);
  }
  if (target.typeflag === "5")
    throw new ToolError(`read: '${args.entry}' is a directory entry.`, -32602);
  if (target.size > MAX_READ_BYTES) {
    throw new ToolError(
      `read: entry '${args.entry}' (${target.size} bytes) exceeds ${MAX_READ_BYTES} read cap. ` +
      `Use tar_client extract to save it to disk.`, -32602);
  }

  const data     = readEntryBytes(buf, target);
  const encoding = args.encoding || "auto";

  let content, actualEncoding;
  if (encoding === "base64") {
    content = data.toString("base64");
    actualEncoding = "base64";
  } else {
    // Binary detection: NUL byte in first 4096 bytes, or >10% low control chars
    const isBinary = data.includes(0) || (() => {
      let ctrl = 0;
      const check = Math.min(data.length, 4096);
      for (let i = 0; i < check; i++) {
        const b = data[i];
        if (b < 32 && b !== 9 && b !== 10 && b !== 13) ctrl++;
      }
      return check > 0 && ctrl / check > 0.1;
    })();
    if (isBinary || encoding === "binary") {
      content = data.toString("base64");
      actualEncoding = "base64";
    } else {
      content = data.toString("utf8");
      actualEncoding = "utf8";
    }
  }

  return {
    path:     args.path,
    entry:    target.name,
    size:     target.size,
    encoding: actualEncoding,
    content,
  };
}

function opExtract(args) {
  guardPath(args.path, "extract");
  guardPath(args.destination, "extract");

  const buf     = readAndDecompress(args.path, "extract");
  const entries = parsedEntries(buf);

  // Filter to requested entries if specified
  let toExtract = entries;
  if (args.entries && args.entries.length > 0) {
    const set = new Set(args.entries);
    toExtract = entries.filter(e => set.has(e.name));
    if (toExtract.length === 0) {
      throw new ToolError(
        `extract: none of the requested entries found in '${args.path}'. ` +
        `Use tar_client list to see available entries.`, -32602);
    }
  }

  // Validate all entry names up front (Tar Slip prevention)
  for (const e of toExtract) {
    assertSafeEntryName(e.name);
    // Reject dangerous type flags (symlinks, hardlinks, device files, fifos)
    const SAFE = new Set(["0", "\0", "5"]);
    if (!SAFE.has(e.typeflag)) {
      throw new ToolError(
        `extract: entry '${e.name}' has an unsafe type '${e.typeflag}' ` +
        `(symlink/hardlink/device/fifo entries are rejected).`, -32001);
    }
  }

  const destExists = fs.existsSync(args.destination);
  if (destExists && !fs.statSync(args.destination).isDirectory())
    throw new ToolError(
      `extract: destination '${args.destination}' exists but is not a directory.`, -32602);
  if (destExists && !args.overwrite) {
    throw new ToolError(
      `extract: destination '${args.destination}' already exists. Pass overwrite:true to extract into it.`,
      -32602);
  }

  fs.mkdirSync(args.destination, { recursive: true });

  let filesExtracted = 0, dirsCreated = 0, totalBytes = 0;
  for (const e of toExtract) {
    const destPath = path.join(args.destination, e.name);
    if (e.typeflag === "5") {
      fs.mkdirSync(destPath, { recursive: true });
      dirsCreated++;
      continue;
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const data = readEntryBytes(buf, e);
    fs.writeFileSync(destPath, data);
    filesExtracted++;
    totalBytes += data.length;
  }

  return {
    path: args.path,
    destination: args.destination,
    filesExtracted,
    dirsCreated,
    totalBytes,
    entriesRequested: args.entries ? args.entries.length : entries.length,
  };
}

function opAdd(args) {
  guardPath(args.path, "add");
  if (!Array.isArray(args.files) || args.files.length === 0)
    throw new ToolError("add: 'files' must be a non-empty array of {entry, source_path}.", -32602);

  for (const f of args.files) {
    if (!f.entry || !f.source_path)
      throw new ToolError("add: each item must have 'entry' and 'source_path'.", -32602);
    guardEntryName(f.entry, "add");
    guardPath(f.source_path, "add");
    if (!fs.existsSync(f.source_path))
      throw new ToolError(`add: source file not found: '${f.source_path}'.`, -32602);
    if (fs.statSync(f.source_path).isDirectory())
      throw new ToolError(
        `add: '${f.source_path}' is a directory — use create for directories.`, -32602);
  }

  // Load existing entries (if TAR exists)
  let existingEntries = [];
  if (fs.existsSync(args.path)) {
    const buf = readAndDecompress(args.path, "add");
    const raw = parsedEntries(buf);
    for (const e of raw) {
      if (e.typeflag !== "5") { // skip directory entries
        existingEntries.push({
          name:  e.name,
          data:  readEntryBytes(buf, e),
          mtime: (() => {
            try {
              const hOff = e.dataStart - BLOCK_SIZE;
              if (hOff < 0) return new Date();
              const mtimeSec = parseInt(
                buf.subarray(hOff, hOff + BLOCK_SIZE).toString("ascii", 136, 148).replace(/\0.*$/s, "").trim(), 8);
              return Number.isFinite(mtimeSec) ? new Date(mtimeSec * 1000) : new Date();
            } catch { return new Date(); }
          })(),
        });
      }
    }
  }

  const nameMap = new Map(existingEntries.map((e, i) => [e.name, i]));
  let added = 0, replaced = 0;

  for (const f of args.files) {
    const data  = fs.readFileSync(f.source_path);
    const mtime = fs.statSync(f.source_path).mtime;
    const entry = { name: f.entry, data, mtime };
    const idx   = nameMap.get(f.entry);
    if (idx !== undefined) {
      existingEntries[idx] = entry;
      replaced++;
    } else {
      nameMap.set(f.entry, existingEntries.length);
      existingEntries.push(entry);
      added++;
    }
  }

  const tarBuf = buildTarBuffer(existingEntries);
  // Write as plain .tar (even if source was .tar.gz — add rebuilds uncompressed)
  fs.writeFileSync(args.path, tarBuf);

  return {
    path: args.path,
    added,
    replaced,
    totalEntries: existingEntries.length,
    sizeBytes: tarBuf.length,
  };
}

function opDelete(args) {
  guardPath(args.path, "delete");
  if (!Array.isArray(args.entries) || args.entries.length === 0)
    throw new ToolError("delete: 'entries' must be a non-empty array of entry names.", -32602);

  const buf      = readAndDecompress(args.path, "delete");
  const raw      = parsedEntries(buf);
  const toRemove = new Set(args.entries);

  if (!args.ignore_missing) {
    const existing = new Set(raw.map(e => e.name));
    for (const n of toRemove) {
      if (!existing.has(n))
        throw new ToolError(
          `delete: entry '${n}' not found. Pass ignore_missing:true to skip.`, -32602);
    }
  }

  const kept = [];
  let removed = 0;
  for (const e of raw) {
    if (toRemove.has(e.name)) { removed++; continue; }
    if (e.typeflag !== "5") {
      kept.push({
        name:  e.name,
        data:  readEntryBytes(buf, e),
        mtime: (() => {
          try {
            const hOff = e.dataStart - BLOCK_SIZE;
            if (hOff < 0) return new Date();
            const mtimeSec = parseInt(
              buf.subarray(hOff, hOff + BLOCK_SIZE).toString("ascii", 136, 148).replace(/\0.*$/s, "").trim(), 8);
            return Number.isFinite(mtimeSec) ? new Date(mtimeSec * 1000) : new Date();
          } catch { return new Date(); }
        })(),
      });
    }
  }

  const tarBuf = buildTarBuffer(kept);
  fs.writeFileSync(args.path, tarBuf);

  return {
    path: args.path,
    removed,
    notFound: args.entries.length - removed,
    totalEntries: kept.length,
    sizeBytes: tarBuf.length,
  };
}

function opCreate(args) {
  guardPath(args.destination, "create");
  if (!Array.isArray(args.files) || args.files.length === 0)
    throw new ToolError("create: 'files' must be a non-empty array of {source_path, entry?}.", -32602);

  const collected = [];
  for (const f of args.files) {
    guardPath(f.source_path, "create");
    if (!fs.existsSync(f.source_path))
      throw new ToolError(`create: source not found: '${f.source_path}'.`, -32602);
    const stat = fs.statSync(f.source_path);
    if (stat.isDirectory()) {
      const base  = (f.entry || path.basename(f.source_path)).replace(/\\/g, "/");
      const files = collectFiles(f.source_path, base, []);
      for (const { absPath, relPath } of files) {
        const entryName = relPath.replace(/\\/g, "/");
        guardEntryName(entryName, "create");
        collected.push({
          name:  entryName,
          data:  fs.readFileSync(absPath),
          mtime: fs.statSync(absPath).mtime,
        });
      }
    } else {
      const entryName = (f.entry || path.basename(f.source_path)).replace(/\\/g, "/");
      guardEntryName(entryName, "create");
      collected.push({ name: entryName, data: fs.readFileSync(f.source_path), mtime: stat.mtime });
    }
  }

  if (collected.length === 0)
    throw new ToolError("create: no files collected (source directories may be empty).", -32602);

  // Deduplicate: last occurrence wins
  const nameMap = new Map();
  for (const e of collected) nameMap.set(e.name, e);
  const deduped = [...nameMap.values()];

  const destDir = path.dirname(args.destination);
  if (destDir) fs.mkdirSync(destDir, { recursive: true });

  let tarBuf = buildTarBuffer(deduped);

  // Optional gzip compression based on destination extension or gzip flag
  const useGzip = args.gzip !== undefined
    ? !!args.gzip
    : /\.(?:tar\.gz|tgz)$/i.test(args.destination);

  if (useGzip) tarBuf = zlib.gzipSync(tarBuf, { level: 6 });

  fs.writeFileSync(args.destination, tarBuf);

  return {
    destination:  args.destination,
    filesArchived: deduped.length,
    sizeBytes:    tarBuf.length,
    compressed:   useGzip,
  };
}

function opInfo(args) {
  guardPath(args.path, "info");
  const stat = fs.statSync(args.path);
  if (!stat) throw new ToolError(`info: TAR file not found: ${args.path}`, -32602);

  const buf     = readAndDecompress(args.path, "info");
  const entries = parsedEntries(buf);

  let totalBytes = 0, fileCount = 0, dirCount = 0;
  let oldestMtime = null, newestMtime = null;

  for (const e of entries) {
    if (e.typeflag === "5") {
      dirCount++;
    } else {
      fileCount++;
      totalBytes += e.size;
      const mt = readModifiedTime(buf, e);
      if (mt) {
        const ts = new Date(mt).getTime();
        if (oldestMtime === null || ts < new Date(oldestMtime).getTime()) oldestMtime = mt;
        if (newestMtime === null || ts > new Date(newestMtime).getTime()) newestMtime = mt;
      }
    }
  }

  // Detect whether the on-disk file is compressed
  const rawBuf = fs.readFileSync(args.path);
  const isGzip = rawBuf.length >= 2 && rawBuf[0] === GZIP_MAGIC[0] && rawBuf[1] === GZIP_MAGIC[1];

  return {
    path:              args.path,
    fileSizeBytes:     stat.size,
    compressed:        isGzip,
    compressionFormat: isGzip ? "gzip" : "none",
    totalEntries:      entries.length,
    fileEntries:       fileCount,
    directoryEntries:  dirCount,
    totalUncompressedBytes: totalBytes,
    compressionRatio:  isGzip && totalBytes > 0
      ? Math.round((1 - stat.size / totalBytes) * 1000) / 1000
      : null,
    oldestModifiedTime: oldestMtime,
    newestModifiedTime: newestMtime,
    modifiedTime:       stat.mtime.toISOString(),
  };
}

// ── Dispatcher ────────────────────────────────────────────────────────────────
function tarClient(args) {
  const op = args.operation;
  switch (op) {
    case "list":    return opList(args);
    case "read":    return opRead(args);
    case "extract": return opExtract(args);
    case "add":     return opAdd(args);
    case "delete":  return opDelete(args);
    case "create":  return opCreate(args);
    case "info":    return opInfo(args);
    default:
      throw new ToolError(
        `tar_client: unknown operation '${op}'. Valid: list, read, extract, add, delete, create, info.`,
        -32602);
  }
}

module.exports = { tarClient };
