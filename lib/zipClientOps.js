"use strict";
// ── ZIP_CLIENT ─────────────────────────────────────────────────────────────────
// Fine-grained ZIP file manipulation tool (pure Node.js; zero npm deps).
// Builds on the existing ZIP infrastructure in zipDirOps.js (writer) and
// unzipOps.js (parser/extractor).
//
// Operations:
//   list     — enumerate entries with full metadata
//   read     — read a single entry's content (text or base64)
//   extract  — selectively extract entries to a destination directory
//   add      — add or replace files in an existing ZIP (or create new)
//   delete   — remove specific entries from a ZIP
//   create   — create a ZIP from an explicit list of host paths
//   info     — summary statistics for a ZIP (sizes, compression ratio, etc.)
//
// Security:
//   • Path NUL guard on all file paths
//   • 200 MB ZIP read cap
//   • 10 MB per-entry read cap for the 'read' operation
//   • Zip Slip prevention on all extract operations (reused from unzipOps.js)
//   • Entry name NUL/absolute/traversal guard on 'add'/'create'

const fs   = require("fs");
const path = require("path");
const zlib = require("zlib");
const { ToolError } = require("./errors");

// ── Re-use ZIP primitives from the existing sibling modules ──────────────────
const { crc32, collectFiles } = require("./zipDirOps");
const {
  parseCentralDirectory,
  assertSafeEntryName,
  readEntryData,
} = require("./unzipOps");

// ── Constants ────────────────────────────────────────────────────────────────
const MAX_ZIP_BYTES  = 200 * 1024 * 1024; // 200 MB
const MAX_READ_BYTES = 10  * 1024 * 1024; // 10 MB per read
const MAX_ENTRIES    = 100_000;

// ── Low-level ZIP writer helpers ──────────────────────────────────────────────
function writeUInt16LE(buf, val, offset) {
  buf[offset]     = val & 0xff;
  buf[offset + 1] = (val >> 8) & 0xff;
}
function writeUInt32LE(buf, val, offset) {
  buf[offset]     = val & 0xff;
  buf[offset + 1] = (val >> 8) & 0xff;
  buf[offset + 2] = (val >> 16) & 0xff;
  buf[offset + 3] = (val >> 24) & 0xff;
}

/** Encode a JS Date as DOS date/time pair. */
function toDosDateTime(d) {
  const year  = d.getFullYear();
  const month = d.getMonth() + 1;
  const day   = d.getDate();
  const hour  = d.getHours();
  const min   = d.getMinutes();
  const sec   = d.getSeconds();
  return {
    dosDate: ((year - 1980) << 9) | (month << 5) | day,
    dosTime: (hour << 11) | (min << 5) | (sec >> 1),
  };
}

/** Decode a DOS date/time pair to ISO-8601 string. */
function fromDosDateTime(dosDate, dosTime) {
  try {
    const year  = ((dosDate >> 9) & 0x7f) + 1980;
    const month = (dosDate >> 5) & 0x0f;
    const day   =  dosDate       & 0x1f;
    const hour  = (dosTime >> 11) & 0x1f;
    const min   = (dosTime >>  5) & 0x3f;
    const sec   = (dosTime & 0x1f) * 2;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return new Date(year, month - 1, day, hour, min, sec).toISOString();
  } catch { return null; }
}

/** Build one Local File Header + deflated data block. */
function buildLocalEntry(entryName, fileData, mtime) {
  const nameBytes    = Buffer.from(entryName, "utf8");
  const uncompressed = fileData.length;
  const deflated     = zlib.deflateRawSync(fileData, { level: 6 });
  const compressed   = deflated.length;
  const crc          = crc32(fileData);
  const dt           = toDosDateTime(mtime || new Date());

  const lhSize = 30 + nameBytes.length;
  const header = Buffer.alloc(lhSize, 0);
  writeUInt32LE(header, 0x04034b50,      0);  // LFH signature
  writeUInt16LE(header, 20,              4);  // Version needed (2.0)
  writeUInt16LE(header, 0x0800,          6);  // Flag: UTF-8
  writeUInt16LE(header, 8,              10);  // Method: DEFLATE
  writeUInt16LE(header, dt.dosTime,     10);  // Mod time
  writeUInt16LE(header, dt.dosDate,     12);  // Mod date
  writeUInt32LE(header, crc,            14);
  writeUInt32LE(header, compressed,     18);
  writeUInt32LE(header, uncompressed,   22);
  writeUInt16LE(header, nameBytes.length, 26);
  writeUInt16LE(header, 0,              28);  // No extra field
  nameBytes.copy(header, 30);

  return {
    block: Buffer.concat([header, deflated]),
    crc, compressedSize: compressed, uncompressedSize: uncompressed,
    dosDate: dt.dosDate, dosTime: dt.dosTime,
  };
}

function buildCentralDirEntry(
  entryName, crc, compressedSize, uncompressedSize,
  localHeaderOffset, dosDate, dosTime
) {
  const nameBytes = Buffer.from(entryName, "utf8");
  const cd = Buffer.alloc(46 + nameBytes.length, 0);
  writeUInt32LE(cd, 0x02014b50,        0);
  writeUInt16LE(cd, 20,                4);
  writeUInt16LE(cd, 20,                6);
  writeUInt16LE(cd, 0x0800,            8);
  writeUInt16LE(cd, 8,                10);
  writeUInt16LE(cd, dosTime || 0,     12);
  writeUInt16LE(cd, dosDate || 0,     14);
  writeUInt32LE(cd, crc,              16);
  writeUInt32LE(cd, compressedSize,   20);
  writeUInt32LE(cd, uncompressedSize, 24);
  writeUInt16LE(cd, nameBytes.length, 28);
  writeUInt16LE(cd, 0,                30);
  writeUInt16LE(cd, 0,                32);
  writeUInt16LE(cd, 0,                34);
  writeUInt16LE(cd, 0,                36);
  writeUInt32LE(cd, 0,                38);
  writeUInt32LE(cd, localHeaderOffset, 42);
  nameBytes.copy(cd, 46);
  return cd;
}

function buildEOCD(entryCount, cdSize, cdOffset) {
  const eocd = Buffer.alloc(22, 0);
  writeUInt32LE(eocd, 0x06054b50,  0);
  writeUInt16LE(eocd, 0,           4);
  writeUInt16LE(eocd, 0,           6);
  writeUInt16LE(eocd, entryCount,  8);
  writeUInt16LE(eocd, entryCount, 10);
  writeUInt32LE(eocd, cdSize,     12);
  writeUInt32LE(eocd, cdOffset,   16);
  writeUInt16LE(eocd, 0,          20);
  return eocd;
}

/** Serialise entry descriptors to a ZIP buffer. */
function buildZipBuffer(entries) {
  const localBlocks = [];
  const centralDirs = [];
  let offset = 0;

  for (const e of entries) {
    const le = buildLocalEntry(e.name, e.data, e.mtime);
    const cd = buildCentralDirEntry(
      e.name, le.crc, le.compressedSize, le.uncompressedSize,
      offset, le.dosDate, le.dosTime
    );
    localBlocks.push(le.block);
    centralDirs.push(cd);
    offset += le.block.length;
  }

  const cdBuf = Buffer.concat(centralDirs);
  const eocd  = buildEOCD(entries.length, cdBuf.length, offset);
  return Buffer.concat([...localBlocks, cdBuf, eocd]);
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

/** Read a ZIP file into a Buffer, enforcing size cap. */
function readZip(zipPath, op) {
  if (!fs.existsSync(zipPath))
    throw new ToolError(`${op}: ZIP file not found: ${zipPath}`, -32602);
  const stat = fs.statSync(zipPath);
  if (stat.isDirectory())
    throw new ToolError(`${op}: '${zipPath}' is a directory, not a ZIP file.`, -32602);
  if (stat.size > MAX_ZIP_BYTES)
    throw new ToolError(
      `${op}: ZIP file too large (${stat.size} bytes > ${MAX_ZIP_BYTES} limit).`, -32602);
  return fs.readFileSync(zipPath);
}

/** Parse central directory, enforce entry count cap. */
function parsedEntries(buf) {
  const raw = parseCentralDirectory(buf);
  if (raw.length > MAX_ENTRIES)
    throw new ToolError(
      `zip_client: too many entries (${raw.length} > ${MAX_ENTRIES} limit).`, -32602);
  return raw;
}

// ─────────────────────────────────────────────────────────────────────────────
// Operations
// ─────────────────────────────────────────────────────────────────────────────

function opList(args) {
  guardPath(args.path, "list");
  const buf     = readZip(args.path, "list");
  const entries = parsedEntries(buf);

  // Re-walk CD to collect DOS date/time + CRC for each entry
  const CDFH_SIG = 0x02014b50;
  const EOCD_SIG = 0x06054b50;
  let cdOffset = 0;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      cdOffset = buf.readUInt32LE(i + 16);
      break;
    }
  }
  const cdMeta = [];
  let pos = cdOffset;
  while (pos + 46 <= buf.length && buf.readUInt32LE(pos) === CDFH_SIG) {
    const dosTime = buf.readUInt16LE(pos + 12);
    const dosDate = buf.readUInt16LE(pos + 14);
    const crc32v  = buf.readUInt32LE(pos + 16);
    const fnLen   = buf.readUInt16LE(pos + 28);
    const efLen   = buf.readUInt16LE(pos + 30);
    const fcLen   = buf.readUInt16LE(pos + 32);
    cdMeta.push({ modTime: fromDosDateTime(dosDate, dosTime), crc32: crc32v });
    pos += 46 + fnLen + efLen + fcLen;
  }

  let totalUncompressed = 0;
  let totalCompressed   = 0;
  const filter = args.filter
    ? new RegExp(args.filter.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&").replace(/\\\*/g, ".*"), "i")
    : null;

  const result = [];
  for (let i = 0; i < entries.length; i++) {
    const e  = entries[i];
    const mt = cdMeta[i] || {};
    if (filter && !filter.test(e.name)) continue;
    totalUncompressed += e.uncompressedSize;
    totalCompressed   += e.compressedSize;
    const ratio = e.uncompressedSize > 0
      ? Math.round((1 - e.compressedSize / e.uncompressedSize) * 1000) / 1000
      : 0;
    result.push({
      name:             e.name,
      isDirectory:      !!e.isDirectory,
      method:           e.method === 0 ? "stored" : e.method === 8 ? "deflate" : `method_${e.method}`,
      uncompressedSize: e.uncompressedSize,
      compressedSize:   e.compressedSize,
      compressionRatio: ratio,
      crc32:            ((mt.crc32 || 0) >>> 0).toString(16).padStart(8, "0"),
      modifiedTime:     mt.modTime || null,
    });
  }

  return {
    path:                   args.path,
    totalEntries:           result.length,
    totalUncompressedBytes: totalUncompressed,
    totalCompressedBytes:   totalCompressed,
    overallRatio:           totalUncompressed > 0
      ? Math.round((1 - totalCompressed / totalUncompressed) * 1000) / 1000
      : 0,
    entries: result,
  };
}

function opRead(args) {
  guardPath(args.path, "read");
  if (!args.entry) throw new ToolError("read: 'entry' is required.", -32602);
  guardEntryName(args.entry, "read");

  const buf     = readZip(args.path, "read");
  const entries = parsedEntries(buf);
  const target  = entries.find(e => e.name === args.entry);
  if (!target) {
    throw new ToolError(
      `read: entry '${args.entry}' not found in '${args.path}'. ` +
      `Use zip_client list to see available entries.`, -32602);
  }
  if (target.isDirectory)
    throw new ToolError(`read: '${args.entry}' is a directory entry.`, -32602);
  if (target.uncompressedSize > MAX_READ_BYTES) {
    throw new ToolError(
      `read: entry '${args.entry}' (${target.uncompressedSize} bytes) exceeds ${MAX_READ_BYTES} read cap. ` +
      `Use zip_client extract to save it to disk.`, -32602);
  }

  const data     = readEntryData(buf, target);
  const encoding = args.encoding || "auto";

  let content, actualEncoding;
  if (encoding === "base64") {
    content = data.toString("base64");
    actualEncoding = "base64";
  } else {
    const isBinary = data.includes(0) || (() => {
      let ctrl = 0;
      const check = Math.min(data.length, 4096);
      for (let i = 0; i < check; i++) {
        const b = data[i];
        if (b < 32 && b !== 9 && b !== 10 && b !== 13) ctrl++;
      }
      return ctrl / check > 0.1;
    })();
    if (isBinary || encoding === "binary") {
      content = data.toString("base64");
      actualEncoding = "base64";
    } else {
      content = data.toString("utf8");
      actualEncoding = "utf8";
    }
  }

  return { path: args.path, entry: target.name, size: data.length, encoding: actualEncoding, content };
}

function opExtract(args) {
  guardPath(args.path, "extract");
  guardPath(args.destination, "extract");

  const buf     = readZip(args.path, "extract");
  const entries = parsedEntries(buf);

  let toExtract = entries;
  if (args.entries && args.entries.length > 0) {
    const set = new Set(args.entries);
    toExtract = entries.filter(e => set.has(e.name));
    if (toExtract.length === 0) {
      throw new ToolError(
        `extract: none of the requested entries found in '${args.path}'. ` +
        `Use zip_client list to see available entries.`, -32602);
    }
  }

  for (const e of toExtract) assertSafeEntryName(e.name);

  const destExists = fs.existsSync(args.destination);
  if (destExists && !fs.statSync(args.destination).isDirectory())
    throw new ToolError(`extract: destination '${args.destination}' exists but is not a directory.`, -32602);
  if (destExists && !args.overwrite) {
    throw new ToolError(
      `extract: destination '${args.destination}' already exists. Pass overwrite:true to extract into it.`,
      -32602);
  }

  fs.mkdirSync(args.destination, { recursive: true });

  let filesExtracted = 0, dirsCreated = 0, totalBytes = 0;
  for (const e of toExtract) {
    const destPath = path.join(args.destination, e.name);
    if (e.isDirectory) {
      fs.mkdirSync(destPath, { recursive: true });
      dirsCreated++;
      continue;
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const data = readEntryData(buf, e);
    fs.writeFileSync(destPath, data);
    filesExtracted++;
    totalBytes += data.length;
  }

  return {
    path: args.path, destination: args.destination,
    filesExtracted, dirsCreated, totalBytes,
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
      throw new ToolError(`add: '${f.source_path}' is a directory — use create for directories.`, -32602);
  }

  // Load existing entries
  let existingEntries = [];
  if (fs.existsSync(args.path)) {
    const buf = readZip(args.path, "add");
    const raw = parsedEntries(buf);
    for (const e of raw) {
      if (!e.isDirectory) {
        existingEntries.push({ name: e.name, data: readEntryData(buf, e) });
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

  const zipBuf = buildZipBuffer(existingEntries);
  fs.writeFileSync(args.path, zipBuf);

  return { path: args.path, added, replaced, totalEntries: existingEntries.length, sizeBytes: zipBuf.length };
}

function opDelete(args) {
  guardPath(args.path, "delete");
  if (!Array.isArray(args.entries) || args.entries.length === 0)
    throw new ToolError("delete: 'entries' must be a non-empty array of entry names.", -32602);

  const buf     = readZip(args.path, "delete");
  const raw     = parsedEntries(buf);
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
    if (!e.isDirectory) kept.push({ name: e.name, data: readEntryData(buf, e) });
  }

  const zipBuf = buildZipBuffer(kept);
  fs.writeFileSync(args.path, zipBuf);

  return {
    path: args.path, removed,
    notFound: args.entries.length - removed,
    totalEntries: kept.length, sizeBytes: zipBuf.length,
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
        collected.push({ name: entryName, data: fs.readFileSync(absPath), mtime: fs.statSync(absPath).mtime });
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

  const zipBuf = buildZipBuffer(deduped);
  fs.writeFileSync(args.destination, zipBuf);

  return { destination: args.destination, filesArchived: deduped.length, sizeBytes: zipBuf.length };
}

function opInfo(args) {
  guardPath(args.path, "info");
  const buf  = readZip(args.path, "info");
  const stat = fs.statSync(args.path);
  const entries = parsedEntries(buf);

  let totalUncompressed = 0, totalCompressed = 0;
  let fileCount = 0, dirCount = 0;
  let storedCount = 0, deflateCount = 0, otherCount = 0;

  for (const e of entries) {
    if (e.isDirectory) { dirCount++; continue; }
    fileCount++;
    totalUncompressed += e.uncompressedSize;
    totalCompressed   += e.compressedSize;
    if (e.method === 0) storedCount++;
    else if (e.method === 8) deflateCount++;
    else otherCount++;
  }

  return {
    path:               args.path,
    fileSizeBytes:      stat.size,
    totalEntries:       entries.length,
    fileEntries:        fileCount,
    directoryEntries:   dirCount,
    totalUncompressedBytes: totalUncompressed,
    totalCompressedBytes:   totalCompressed,
    overallRatio:           totalUncompressed > 0
      ? Math.round((1 - totalCompressed / totalUncompressed) * 1000) / 1000
      : 0,
    compressionMethods: { stored: storedCount, deflate: deflateCount, other: otherCount },
    modifiedTime:       stat.mtime.toISOString(),
  };
}

// ── Dispatcher ───────────────────────────────────────────────────────────────
function zipClient(args) {
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
        `zip_client: unknown operation '${op}'. Valid: list, read, extract, add, delete, create, info.`,
        -32602);
  }
}

module.exports = { zipClient };
