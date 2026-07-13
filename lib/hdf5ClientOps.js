"use strict";
// lib/hdf5ClientOps.js — Zero-dep HDF5 file reader (pure Node.js; no npm deps)
// Supports HDF5 superblock v0-v2, B-tree v1/v2, symbol tables, data objects
// Datatypes: fixed-point (int8/16/32/64), float (float32/float64),
//            string (fixed/variable), compound, array, vlen, opaque,
//            enum, reference, bitfield
// Dataspaces: scalar, simple (N-D)
// Filters: none, deflate/gzip, shuffle, fletcher32, szip (best-effort)
// Operations: info, list, attrs, read, to_json, to_csv
// Security: 256 MB file cap; 10,000,000 element limit; NUL-byte path guard;
//           directory path rejected; max 64-level group depth

const fs   = require("fs");
const path = require("path");
const zlib = require("zlib");
const { ToolError } = require("./errors");

const MAX_FILE_SIZE = 256 * 1024 * 1024; // 256 MB
const MAX_ELEMENTS  = 10_000_000;
const MAX_DEPTH     = 64;

// ── HDF5 Signatures ──────────────────────────────────────────────────────────
const HDF5_SIGNATURE = Buffer.from([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a]);

// ── Undefined Address (depends on offset size) ───────────────────────────────
const UNDEF32 = 0xFFFFFFFF;
const UNDEF64 = 0xFFFFFFFFFFFFFFFFn;

// ────────────────────────────────────────────────────────────────────────────
// Buffer helpers
// ────────────────────────────────────────────────────────────────────────────
function readUInt(buf, offset, size) {
  if (size === 1) return buf.readUInt8(offset);
  if (size === 2) return buf.readUInt16LE(offset);
  if (size === 4) return buf.readUInt32LE(offset);
  if (size === 8) {
    const lo = buf.readUInt32LE(offset);
    const hi = buf.readUInt32LE(offset + 4);
    // Return as number if safe, else BigInt
    const big = (BigInt(hi) << 32n) | BigInt(lo);
    return big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big;
  }
  return 0;
}

function readOffset(buf, offset, offsetSize) {
  return readUInt(buf, offset, offsetSize);
}

function readLength(buf, offset, lengthSize) {
  return readUInt(buf, offset, lengthSize);
}

function isUndefined(addr, offsetSize) {
  if (offsetSize === 4) return addr === UNDEF32;
  if (offsetSize === 8) return typeof addr === 'bigint' ? addr === UNDEF64 : addr === 0xFFFFFFFF;
  return false;
}

function toNumber(v) {
  if (typeof v === 'bigint') return Number(v);
  return v;
}

// ────────────────────────────────────────────────────────────────────────────
// Superblock parsing
// ────────────────────────────────────────────────────────────────────────────
function parseSuperblock(buf) {
  // Find signature (may not be at offset 0 — can be at 0, 512, 1024, 2048...)
  let sigOff = -1;
  const searchOffsets = [0, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072];
  for (const off of searchOffsets) {
    if (off + 8 <= buf.length && buf.slice(off, off + 8).equals(HDF5_SIGNATURE)) {
      sigOff = off;
      break;
    }
  }
  if (sigOff < 0) throw new ToolError("hdf5_client: HDF5 signature not found.", -32602);

  let pos = sigOff + 8;
  const sbVersion = buf.readUInt8(pos); pos++;

  if (sbVersion === 0 || sbVersion === 1) {
    return parseSuperblockV0(buf, pos, sigOff, sbVersion);
  } else if (sbVersion === 2 || sbVersion === 3) {
    return parseSuperblockV2(buf, pos, sigOff, sbVersion);
  } else {
    throw new ToolError(`hdf5_client: unsupported superblock version ${sbVersion}.`, -32602);
  }
}

function parseSuperblockV0(buf, pos, sigOff, version) {
  const freeSpaceVersion = buf.readUInt8(pos); pos++;
  const rootSymTableVersion = buf.readUInt8(pos); pos++;
  pos++; // reserved
  const sharedHeaderVersion = buf.readUInt8(pos); pos++;
  const offsetSize = buf.readUInt8(pos); pos++;
  const lengthSize = buf.readUInt8(pos); pos++;
  pos++; // reserved
  const groupLeafNodeK    = buf.readUInt16LE(pos); pos += 2;
  const groupInternalNodeK = buf.readUInt16LE(pos); pos += 2;
  const fileConsistencyFlags = buf.readUInt32LE(pos); pos += 4;
  if (version === 1) {
    const indexedStorageInternalNodeK = buf.readUInt16LE(pos); pos += 2;
    pos += 2; // reserved
  }
  const baseAddress = readOffset(buf, pos, offsetSize); pos += offsetSize;
  const freeSpaceAddress = readOffset(buf, pos, offsetSize); pos += offsetSize;
  const eofAddress = readOffset(buf, pos, offsetSize); pos += offsetSize;
  const driverInfoAddress = readOffset(buf, pos, offsetSize); pos += offsetSize;
  // Root group symbol table entry
  const rootSymEntry = parseSymbolTableEntry(buf, pos, offsetSize, lengthSize);
  const rootAddress = rootSymEntry.objectHeaderAddress;

  return { version, offsetSize, lengthSize, baseAddress, eofAddress, rootAddress, groupLeafNodeK, groupInternalNodeK };
}

function parseSuperblockV2(buf, pos, sigOff, version) {
  const offsetSize = buf.readUInt8(pos); pos++;
  const lengthSize = buf.readUInt8(pos); pos++;
  const fileConsistencyFlags = buf.readUInt8(pos); pos++;
  const baseAddress = readOffset(buf, pos, offsetSize); pos += offsetSize;
  const sohAddress  = readOffset(buf, pos, offsetSize); pos += offsetSize; // superblock ext
  const eofAddress  = readOffset(buf, pos, offsetSize); pos += offsetSize;
  const rootAddress = readOffset(buf, pos, offsetSize); pos += offsetSize;
  // superblock checksum: 4 bytes (ignored)

  return { version, offsetSize, lengthSize, baseAddress, eofAddress, rootAddress, groupLeafNodeK: 4, groupInternalNodeK: 16 };
}

// ────────────────────────────────────────────────────────────────────────────
// Symbol Table Entry
// ────────────────────────────────────────────────────────────────────────────
function parseSymbolTableEntry(buf, pos, offsetSize, lengthSize) {
  const nameOffset           = readOffset(buf, pos, offsetSize); pos += offsetSize;
  const objectHeaderAddress  = readOffset(buf, pos, offsetSize); pos += offsetSize;
  const cacheType            = buf.readUInt32LE(pos); pos += 4;
  pos += 4; // reserved
  // Cache: depends on cacheType
  let btreeAddress = null, nameHeapAddress = null, linkValue = null;
  if (cacheType === 1) {
    btreeAddress    = readOffset(buf, pos, offsetSize);
    nameHeapAddress = readOffset(buf, pos + offsetSize, offsetSize);
  }
  pos += 16; // scratch (always 16 bytes)
  return { nameOffset, objectHeaderAddress, cacheType, btreeAddress, nameHeapAddress, linkValue };
}

// ────────────────────────────────────────────────────────────────────────────
// Local Heap
// ────────────────────────────────────────────────────────────────────────────
function parseLocalHeap(buf, heapAddr, offsetSize, lengthSize) {
  if (isUndefined(heapAddr, offsetSize)) return null;
  const addr = toNumber(heapAddr);
  // Signature: HEAP
  if (buf.slice(addr, addr + 4).toString('ascii') !== 'HEAP') return null;
  const version   = buf.readUInt8(addr + 4);
  let pos = addr + 8; // skip signature(4) + version(1) + reserved(3)
  const dataSegmentSize = readLength(buf, pos, lengthSize); pos += lengthSize;
  const freeListOffset  = readLength(buf, pos, lengthSize); pos += lengthSize;
  const dataSegmentAddr = readOffset(buf, pos, offsetSize);
  const dataStart = toNumber(dataSegmentAddr);
  return {
    readString(nameOff) {
      if (nameOff === 0) return '';
      let end = dataStart + nameOff;
      while (end < buf.length && buf[end] !== 0) end++;
      return buf.slice(dataStart + nameOff, end).toString('utf8');
    },
    readBytes(off, len) {
      return buf.slice(dataStart + off, dataStart + off + len);
    }
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Fractal Heap (v2 objects)
// ────────────────────────────────────────────────────────────────────────────
function parseFractalHeap(buf, addr, offsetSize, lengthSize) {
  if (isUndefined(addr, offsetSize)) return null;
  const a = toNumber(addr);
  if (buf.length < a + 4 || buf.slice(a, a + 4).toString('ascii') !== 'FRHP') return null;

  let pos = a + 4;
  const version = buf.readUInt8(pos); pos++;
  const heapIdLen = buf.readUInt16LE(pos); pos += 2;
  const ioFilterEncodedLen = buf.readUInt16LE(pos); pos += 2;
  const flags = buf.readUInt8(pos); pos++;
  const maxSizeOfManagedObjects = buf.readUInt32LE(pos); pos += 4;
  const nextHugeObjId = readLength(buf, pos, lengthSize); pos += lengthSize;
  const btreeHugeObjsAddr = readOffset(buf, pos, offsetSize); pos += offsetSize;
  const freeSpaceAmt = readLength(buf, pos, lengthSize); pos += lengthSize;
  const freeSpaceMgrAddr = readOffset(buf, pos, offsetSize); pos += offsetSize;
  const managedSpaceAmt = readLength(buf, pos, lengthSize); pos += lengthSize;
  const allocManagedSpaceAmt = readLength(buf, pos, lengthSize); pos += lengthSize;
  const directBlockAllocIterOffset = readLength(buf, pos, lengthSize); pos += lengthSize;
  const managedObjsCount = readLength(buf, pos, lengthSize); pos += lengthSize;
  const hugeObjsSize = readLength(buf, pos, lengthSize); pos += lengthSize;
  const hugeObjsCount = readLength(buf, pos, lengthSize); pos += lengthSize;
  const tinyObjsSize = readLength(buf, pos, lengthSize); pos += lengthSize;
  const tinyObjsCount = readLength(buf, pos, lengthSize); pos += lengthSize;
  const tableWidth = buf.readUInt16LE(pos); pos += 2;
  const startingBlockSize = readLength(buf, pos, lengthSize); pos += lengthSize;
  const maxDirectBlockSize = readLength(buf, pos, lengthSize); pos += lengthSize;
  const maxHeapSize = buf.readUInt16LE(pos); pos += 2;
  const rowsInRootIndirectBlock = buf.readUInt16LE(pos); pos += 2;
  const rootBlockAddr = readOffset(buf, pos, offsetSize); pos += offsetSize;
  const curRowsInRootIndirectBlock = buf.readUInt16LE(pos); pos += 2;

  return {
    heapIdLen, tableWidth, startingBlockSize: toNumber(startingBlockSize),
    maxDirectBlockSize: toNumber(maxDirectBlockSize), maxHeapSize,
    rootBlockAddr, rowsInRootIndirectBlock, curRowsInRootIndirectBlock,
    flags,
    // Read an object by fractal heap ID (offset+length encoding)
    readObject(heapId) {
      // HDF5 fractal heap ID: first byte type, then offset (variable), then length (variable)
      if (!heapId || heapId.length < 1) return null;
      const idType = (heapId[0] >> 4) & 0x3;
      if (idType !== 0) return null; // only managed objects

      // Compute offset/length bit sizes from heap params
      const maxDirect = toNumber(maxDirectBlockSize);
      const startSz   = toNumber(startingBlockSize);
      // offset bits = ceil(log2(max_heap_size))
      const offsetBits = maxHeapSize;
      // length bits = bits needed for maxDirectBlockSize
      let lenBits = 0;
      let tmp = maxDirect;
      while (tmp > 1) { lenBits++; tmp >>= 1; }

      // Parse offset and length from heapId bytes (skipping first byte)
      const offsetBytes = Math.ceil(offsetBits / 8);
      const lenBytes    = Math.ceil(lenBits / 8);
      if (heapId.length < 1 + offsetBytes + lenBytes) return null;

      let objOffset = 0n;
      for (let i = 0; i < offsetBytes; i++) objOffset |= BigInt(heapId[1 + i]) << BigInt(i * 8);
      let objLen = 0n;
      for (let i = 0; i < lenBytes; i++) objLen |= BigInt(heapId[1 + offsetBytes + i]) << BigInt(i * 8);

      // Traverse direct blocks to find the object
      const rootAddr = toNumber(rootBlockAddr);
      if (isUndefined(rootBlockAddr, offsetSize)) return null;
      return readFromDirectBlock(buf, rootAddr, Number(objOffset), Number(objLen), startSz, maxDirect, tableWidth, offsetSize, lengthSize);
    }
  };
}

function readFromDirectBlock(buf, blockAddr, objOffset, objLen, blockSize, maxDirect, tableWidth, offsetSize, lengthSize) {
  if (blockAddr + 4 > buf.length) return null;
  const sig = buf.slice(blockAddr, blockAddr + 4).toString('ascii');
  if (sig === 'FHDB') {
    // Direct block: data starts after header
    // FHDB: sig(4) + version(1) + heapHeaderAddr(offsetSize) + blockOffset(var) + checksum(4)
    let hpos = blockAddr + 4 + 1 + offsetSize;
    // block offset encoded in ceil(maxHeapSize/8) bytes -- skip
    const blockOffsetBytes = Math.ceil(/* maxHeapSize */ 8 / 8); // rough
    hpos += blockOffsetBytes;
    // Optionally: checksum
    hpos += 4; // checksum
    // Data starts here
    const dataStart = hpos;
    if (dataStart + objOffset + objLen > buf.length) return null;
    return buf.slice(dataStart + objOffset, dataStart + objOffset + objLen);
  } else if (sig === 'FHIB') {
    // Indirect block: array of child block addresses
    let hpos = blockAddr + 4 + 1 + offsetSize;
    const blockOffsetBytes = Math.ceil(8 / 8);
    hpos += blockOffsetBytes;
    // Child blocks: read addresses
    const nrows = tableWidth;
    let remaining = objOffset;
    let curBlockSize = blockSize;
    for (let row = 0; row < 16 && hpos + offsetSize <= buf.length; row++) {
      for (let col = 0; col < tableWidth && hpos + offsetSize <= buf.length; col++) {
        const childAddr = readOffset(buf, hpos, offsetSize); hpos += offsetSize;
        if (!isUndefined(childAddr, offsetSize)) {
          if (remaining < curBlockSize) {
            return readFromDirectBlock(buf, toNumber(childAddr), remaining, objLen, curBlockSize, maxDirect, tableWidth, offsetSize, lengthSize);
          }
          remaining -= curBlockSize;
        }
      }
      if (row > 0 && curBlockSize < maxDirect) curBlockSize *= 2;
    }
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Object Header parsing
// ────────────────────────────────────────────────────────────────────────────
function parseObjectHeader(buf, addr, offsetSize, lengthSize) {
  const a = toNumber(addr);
  if (a + 4 > buf.length) return null;

  const sig = buf.slice(a, a + 4);
  // v1: no signature, starts with version byte
  // v2: 'OHDR' signature
  if (sig.toString('ascii') === 'OHDR') {
    return parseObjectHeaderV2(buf, a, offsetSize, lengthSize);
  } else {
    return parseObjectHeaderV1(buf, a, offsetSize, lengthSize);
  }
}

function parseObjectHeaderV1(buf, a, offsetSize, lengthSize) {
  const version = buf.readUInt8(a);
  if (version !== 1) return null;
  // reserved: 1 byte
  const numMessages = buf.readUInt16LE(a + 2);
  const refCount    = buf.readUInt32LE(a + 4);
  const headerSize  = buf.readUInt32LE(a + 8);
  let pos = a + 12; // start of messages
  const messages = [];
  const end = pos + headerSize;
  let count = 0;
  while (pos < end && pos < buf.length && count < 1000) {
    if (pos + 8 > buf.length) break;
    const msgType = buf.readUInt16LE(pos);
    const msgSize = buf.readUInt16LE(pos + 2);
    const msgFlags = buf.readUInt8(pos + 4);
    pos += 8; // type(2) + size(2) + flags(1) + reserved(3)
    if (msgType === 0 && msgSize === 0) break; // NIL message = end
    const data = buf.slice(pos, pos + msgSize);
    messages.push({ type: msgType, flags: msgFlags, data });
    pos += msgSize;
    // Align to 8 bytes
    const rem = pos % 8;
    if (rem !== 0) pos += 8 - rem;
    count++;
  }
  return { version: 1, messages };
}

function parseObjectHeaderV2(buf, a, offsetSize, lengthSize) {
  // 'OHDR' + version(1) + flags(1)
  const version = buf.readUInt8(a + 4);
  const flags   = buf.readUInt8(a + 5);
  let pos = a + 6;

  // Optional timestamps (flags bit 2)
  if (flags & 0x04) pos += 16; // 4 x uint32 timestamps
  // Optional phase change values (flags bit 4)
  if (flags & 0x10) pos += 4;

  // Size of chunk 0 (1, 2, 4, or 8 bytes based on flags bits 0-1)
  const chunk0SzBits = flags & 0x03;
  const chunk0Sz = readUInt(buf, pos, 1 << chunk0SzBits); pos += (1 << chunk0SzBits);

  const messages = [];
  const msgEnd   = pos + chunk0Sz;
  let count = 0;
  while (pos < msgEnd && pos < buf.length && count < 1000) {
    if (pos + 4 > buf.length) break;
    const msgType  = buf.readUInt8(pos); pos++;
    const msgSize  = buf.readUInt16LE(pos); pos += 2;
    const msgFlags = buf.readUInt8(pos); pos++;
    if (version === 2) {
      if (msgFlags & 0x04) pos += 2; // creation order
    }
    if (msgType === 0 && msgSize === 0) break;
    const data = buf.slice(pos, pos + msgSize);
    messages.push({ type: msgType, flags: msgFlags, data });
    pos += msgSize;
    count++;
  }
  return { version: 2, messages };
}

// ────────────────────────────────────────────────────────────────────────────
// Message parsers
// ────────────────────────────────────────────────────────────────────────────

// Message type 1: Dataspace
function parseDataspace(data) {
  if (!data || data.length < 4) return { rank: 0, dims: [], maxDims: [], type: 0 };
  const version = data.readUInt8(0);
  const rank    = data.readUInt8(1);
  const flags   = data.readUInt8(2);
  const type    = version === 1 ? data.readUInt8(3) : 0; // v1: space type; v2: at byte 3 for rank>0
  let pos = version === 1 ? 8 : 4;
  const dims = [];
  for (let i = 0; i < rank; i++) {
    dims.push(toNumber(readLength(data, pos, 8))); pos += 8;
  }
  const maxDims = [];
  if (flags & 0x01) {
    for (let i = 0; i < rank; i++) {
      maxDims.push(toNumber(readLength(data, pos, 8))); pos += 8;
    }
  } else {
    for (let i = 0; i < rank; i++) maxDims.push(dims[i]);
  }
  return { rank, dims, maxDims, type };
}

// Message type 3: Datatype
function parseDatatypeMsg(data) {
  if (!data || data.length < 8) return { class: 0, size: 4 };
  return parseDatatype(data, 0);
}

function parseDatatype(data, offset) {
  if (offset + 8 > data.length) return { class: 0, size: 0 };
  const classAndVer = data.readUInt8(offset);
  const dtClass  = classAndVer & 0x0F;
  const version  = (classAndVer >> 4) & 0x0F;
  const classBits = data.readUInt8(offset + 1) | (data.readUInt8(offset + 2) << 8) | (data.readUInt8(offset + 3) << 16);
  const size = data.readUInt32LE(offset + 4);
  const props = data.slice(offset + 8, offset + 8 + size > data.length ? data.length : offset + 8 + Math.min(size, 256));

  const dt = { class: dtClass, version, size, classBits };

  if (dtClass === 0) {
    // Fixed-point (integer)
    dt.name = 'integer';
    dt.byteOrder  = (classBits & 0x01) ? 'BE' : 'LE';
    dt.signed     = (classBits & 0x08) ? true : false;
    dt.bitOffset  = data.length > offset + 8 + 1 ? data.readUInt16LE(offset + 8) : 0;
    dt.bitPrecision = data.length > offset + 10 + 1 ? data.readUInt16LE(offset + 10) : size * 8;
  } else if (dtClass === 1) {
    // Floating-point
    dt.name = 'float';
    dt.byteOrder = (classBits & 0x01) ? 'BE' : 'LE';
  } else if (dtClass === 2) {
    // Time (deprecated, treat like integer)
    dt.name = 'time';
    dt.bitPrecision = data.length > offset + 9 ? data.readUInt16LE(offset + 8) : 16;
  } else if (dtClass === 3) {
    // String
    dt.name = 'string';
    dt.paddingType  = classBits & 0x0F;
    dt.charSet      = (classBits >> 4) & 0x0F;
    dt.fixedLength  = size;
  } else if (dtClass === 4) {
    // Bitfield
    dt.name = 'bitfield';
    dt.byteOrder = (classBits & 0x01) ? 'BE' : 'LE';
  } else if (dtClass === 5) {
    // Opaque
    dt.name = 'opaque';
    dt.tag  = data.slice(offset + 8, offset + 8 + (classBits & 0xFF)).toString('ascii').replace(/\0/g, '');
  } else if (dtClass === 6) {
    // Compound
    dt.name = 'compound';
    dt.members = parseCompoundMembers(data, offset + 8, size, data.slice(offset).length - 8, version);
  } else if (dtClass === 7) {
    // Reference
    dt.name = 'reference';
    dt.refType = classBits & 0x0F;
  } else if (dtClass === 8) {
    // Enum
    dt.name = 'enum';
    const baseType = parseDatatype(data, offset + 8);
    dt.baseType = baseType;
    const nMembers = classBits & 0xFFFF;
    dt.members = {};
    // enum member names follow base type, then values
    let epos = offset + 8 + baseType.size + 8;
    const names = [];
    for (let i = 0; i < nMembers; i++) {
      let end = epos;
      while (end < data.length && data[end] !== 0) end++;
      names.push(data.slice(epos, end).toString('utf8'));
      epos = end + 1;
      epos = Math.ceil(epos / 8) * 8;
    }
    for (let i = 0; i < nMembers; i++) {
      const val = readUInt(data, epos, baseType.size || 4);
      epos += (baseType.size || 4);
      dt.members[names[i]] = val;
    }
  } else if (dtClass === 9) {
    // Variable-length
    dt.name = 'vlen';
    dt.vlenType = classBits & 0x0F; // 0=sequence, 1=string
    dt.baseType = parseDatatype(data, offset + 8);
  } else if (dtClass === 10) {
    // Array
    dt.name = 'array';
    const ndims = data.readUInt8(offset + 8);
    dt.dims = [];
    let dpos = offset + 10; // skip ndims(1) + reserved(1)
    if (version <= 2) dpos += 1; // v1/v2 has extra reserved byte
    for (let i = 0; i < ndims; i++) {
      dt.dims.push(data.readUInt32LE(dpos)); dpos += 4;
    }
    if (version <= 2) dpos += ndims * 4; // permutation indices (v1/v2)
    dt.baseType = parseDatatype(data, dpos);
  } else {
    dt.name = `class_${dtClass}`;
  }

  return dt;
}

function parseCompoundMembers(data, start, dtSize, available, version) {
  const members = [];
  let pos = start;
  const nMembers = (data.readUInt8(start - 8 + 2) | (data.readUInt8(start - 8 + 3) << 8) | (data.readUInt8(start - 8 + 4) << 16)) & 0xFFFF;
  // Actually, nMembers is encoded in classBits which we don't have here.
  // Use heuristic: parse until we reach dtSize
  let safety = 0;
  while (pos < start + available && safety++ < 64) {
    // Member name: null-terminated, padded to multiple of 8 (v1) or not padded (v3)
    let nameEnd = pos;
    while (nameEnd < data.length && data[nameEnd] !== 0) nameEnd++;
    if (nameEnd >= data.length || nameEnd === pos) break;
    const name = data.slice(pos, nameEnd).toString('utf8');
    let mpos;
    if (version <= 2) {
      mpos = Math.ceil((nameEnd + 1) / 8) * 8 + pos; // name padded to 8
      // Actually offset from start of name block:
      mpos = pos + Math.ceil((nameEnd - pos + 1) / 8) * 8;
    } else {
      mpos = nameEnd + 1;
    }
    if (mpos + 4 > data.length) break;
    const memberOffset = data.readUInt32LE(mpos); mpos += 4;
    // v1/v2 has additional dimensionality fields before dtype
    if (version <= 2) mpos += 16; // dims, dim permutations
    const memberDtype = parseDatatype(data, mpos);
    if (!memberDtype || memberDtype.size === 0) break;
    members.push({ name, offset: memberOffset, dtype: memberDtype });
    pos = mpos + 8 + memberDtype.size;
  }
  return members;
}

// Message type 8: Layout
function parseLayout(data, offsetSize, lengthSize) {
  if (!data || data.length < 4) return null;
  const version = data.readUInt8(0);
  const layoutClass = version >= 3 ? data.readUInt8(1) : data.readUInt8(1);

  if (version <= 2) {
    // v1/v2: layoutClass 0=compact, 1=contiguous, 2=chunked
    const rank = data.readUInt8(2);
    const dataOffset = readOffset(data, 4, offsetSize);
    if (layoutClass === 0) {
      // Compact: data is inline
      return { class: 0, version, compactData: data.slice(4 + offsetSize) };
    } else if (layoutClass === 1) {
      // Contiguous
      const dataSize = readLength(data, 4 + offsetSize, lengthSize);
      return { class: 1, version, dataAddress: dataOffset, dataSize: toNumber(dataSize) };
    } else if (layoutClass === 2) {
      // Chunked: array of chunk dims
      const dims = [];
      let dpos = 4 + offsetSize;
      for (let i = 0; i < rank; i++) { dims.push(data.readUInt32LE(dpos)); dpos += 4; }
      const chunkBtreeAddr = readOffset(data, dpos, offsetSize);
      return { class: 2, version, dims, chunkBtreeAddr };
    }
  } else {
    // v3/v4
    if (layoutClass === 0) {
      // Compact: size(2) + data
      const dataSize = data.readUInt16LE(2);
      return { class: 0, version, compactData: data.slice(4, 4 + dataSize) };
    } else if (layoutClass === 1) {
      // Contiguous
      const dataAddress = readOffset(data, 2, offsetSize);
      const dataSize    = readLength(data, 2 + offsetSize, lengthSize);
      return { class: 1, version, dataAddress, dataSize: toNumber(dataSize) };
    } else if (layoutClass === 2) {
      // Chunked v3
      const rank    = data.readUInt8(2);
      const btreeAddr = readOffset(data, 3, offsetSize);
      const dims    = [];
      let dpos = 3 + offsetSize;
      for (let i = 0; i < rank; i++) { dims.push(data.readUInt32LE(dpos)); dpos += 4; }
      const dataElemSize = data.readUInt32LE(dpos);
      return { class: 2, version, rank, chunkBtreeAddr: btreeAddr, dims, dataElemSize };
    } else if (layoutClass === 2 && version === 4) {
      // Chunked v4 (more complex, partial support)
      return { class: 2, version, chunkBtreeAddr: null };
    }
  }
  return null;
}

// Message type 11: Pipeline (filters)
function parsePipeline(data) {
  if (!data || data.length < 6) return [];
  const version    = data.readUInt8(0);
  const nFilters   = data.readUInt8(1);
  const filters    = [];
  let pos = version === 1 ? 8 : 2;
  for (let i = 0; i < nFilters && pos < data.length; i++) {
    const filterId  = data.readUInt16LE(pos); pos += 2;
    let nameLen, flags2, nClientVals;
    if (version === 1) {
      nameLen = data.readUInt16LE(pos); pos += 2;
      flags2  = data.readUInt16LE(pos); pos += 2;
      nClientVals = data.readUInt16LE(pos); pos += 2;
      const name = data.slice(pos, pos + nameLen).toString('ascii').replace(/\0/g, '');
      pos += nameLen;
      pos = Math.ceil(pos / 8) * 8; // pad to 8 bytes
      const clientData = [];
      for (let j = 0; j < nClientVals; j++) { clientData.push(data.readUInt32LE(pos)); pos += 4; }
      if (nClientVals % 2 !== 0) pos += 4; // pad
      filters.push({ id: filterId, name, flags: flags2, clientData });
    } else {
      flags2 = data.readUInt8(pos); pos++;
      nClientVals = data.readUInt8(pos); pos++;
      let name = '';
      if (filterId >= 256 || version === 2) {
        // name is present for non-built-in filters in v2
        if (data[pos] !== 0) {
          let end = pos; while (end < data.length && data[end] !== 0) end++;
          name = data.slice(pos, end).toString('ascii');
          pos = end + 1;
        }
      } else {
        name = FILTER_NAMES[filterId] || `filter_${filterId}`;
      }
      const clientData = [];
      for (let j = 0; j < nClientVals; j++) { clientData.push(data.readUInt32LE(pos)); pos += 4; }
      filters.push({ id: filterId, name, flags: flags2, clientData });
    }
  }
  return filters;
}

const FILTER_NAMES = {
  1: 'deflate', 2: 'shuffle', 3: 'fletcher32', 4: 'szip',
  5: 'nbit', 6: 'scaleoffset', 32001: 'blosc', 32004: 'lz4',
  32013: 'zstd', 32015: 'bitshuffle',
};

// Message type 12: Attribute
function parseAttribute(data, offsetSize, lengthSize) {
  if (!data || data.length < 8) return null;
  const version   = data.readUInt8(0);
  let pos = 1;
  let nameSize, datatypeSize, dataspaceSize, name;

  if (version === 1) {
    pos++; // reserved
    nameSize      = data.readUInt16LE(pos); pos += 2;
    datatypeSize  = data.readUInt16LE(pos); pos += 2;
    dataspaceSize = data.readUInt16LE(pos); pos += 2;
    // name: null-terminated, padded to 8 bytes
    const nameRaw = data.slice(pos, pos + nameSize);
    name = nameRaw.toString('utf8').replace(/\0/g, '');
    pos += Math.ceil(nameSize / 8) * 8;
    const dtMsg  = data.slice(pos, pos + datatypeSize);
    const dt     = parseDatatypeMsg(dtMsg);
    pos += Math.ceil(datatypeSize / 8) * 8;
    const dsMsg  = data.slice(pos, pos + dataspaceSize);
    const ds     = parseDataspace(dsMsg);
    pos += Math.ceil(dataspaceSize / 8) * 8;
    const attrData = data.slice(pos);
    return { name, dtype: dt, dataspace: ds, data: attrData };
  } else if (version === 2) {
    const flags = data.readUInt8(pos); pos++;
    nameSize      = data.readUInt16LE(pos); pos += 2;
    datatypeSize  = data.readUInt16LE(pos); pos += 2;
    dataspaceSize = data.readUInt16LE(pos); pos += 2;
    const charEncoding = data.readUInt8(pos); pos++;
    const nameRaw = data.slice(pos, pos + nameSize);
    name = nameRaw.toString('utf8').replace(/\0/g, '');
    pos += nameSize;
    const dtMsg  = data.slice(pos, pos + datatypeSize);
    const dt     = parseDatatypeMsg(dtMsg);
    pos += datatypeSize;
    const dsMsg  = data.slice(pos, pos + dataspaceSize);
    const ds     = parseDataspace(dsMsg);
    pos += dataspaceSize;
    const attrData = data.slice(pos);
    return { name, dtype: dt, dataspace: ds, data: attrData };
  } else if (version === 3) {
    const flags = data.readUInt8(pos); pos++;
    nameSize      = data.readUInt16LE(pos); pos += 2;
    datatypeSize  = data.readUInt16LE(pos); pos += 2;
    dataspaceSize = data.readUInt16LE(pos); pos += 2;
    const charEncoding = data.readUInt8(pos); pos++;
    const nameRaw = data.slice(pos, pos + nameSize);
    name = nameRaw.toString('utf8').replace(/\0/g, '');
    pos += nameSize;
    const dtMsg  = data.slice(pos, pos + datatypeSize);
    const dt     = parseDatatypeMsg(dtMsg);
    pos += datatypeSize;
    const dsMsg  = data.slice(pos, pos + dataspaceSize);
    const ds     = parseDataspace(dsMsg);
    pos += dataspaceSize;
    const attrData = data.slice(pos);
    return { name, dtype: dt, dataspace: ds, data: attrData };
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// B-tree v1 (group node traversal)
// ────────────────────────────────────────────────────────────────────────────
function traverseBtreeV1Group(buf, nodeAddr, heap, offsetSize, lengthSize, leafNodeK, depth) {
  if (depth > MAX_DEPTH) return [];
  if (isUndefined(nodeAddr, offsetSize)) return [];
  const a = toNumber(nodeAddr);
  if (a + 8 > buf.length) return [];
  const sig = buf.slice(a, a + 4).toString('ascii');
  if (sig !== 'TREE') return [];

  const nodeType = buf.readUInt8(a + 4);
  const nodeLevel = buf.readUInt8(a + 5);
  const entriesUsed = buf.readUInt16LE(a + 6);
  const leftSiblingAddr  = readOffset(buf, a + 8, offsetSize);
  const rightSiblingAddr = readOffset(buf, a + 8 + offsetSize, offsetSize);

  let pos = a + 8 + offsetSize * 2;

  const entries = [];
  if (nodeType === 0) {
    // Group node: keys and child addresses interleaved
    // key0, child0, key1, child1, ... keyN, childN, keyN+1
    const keys = [];
    const children = [];
    for (let i = 0; i <= entriesUsed; i++) {
      keys.push(readLength(buf, pos, lengthSize)); pos += lengthSize;
      if (i < entriesUsed) {
        children.push(readOffset(buf, pos, offsetSize)); pos += offsetSize;
      }
    }
    for (const childAddr of children) {
      if (nodeLevel === 0) {
        // Leaf: symbol table node
        const syms = parseSymbolTableNode(buf, childAddr, offsetSize, lengthSize, heap);
        entries.push(...syms);
      } else {
        // Internal: recurse
        entries.push(...traverseBtreeV1Group(buf, childAddr, heap, offsetSize, lengthSize, leafNodeK, depth + 1));
      }
    }
  }
  return entries;
}

function parseSymbolTableNode(buf, nodeAddr, offsetSize, lengthSize, heap) {
  if (isUndefined(nodeAddr, offsetSize)) return [];
  const a = toNumber(nodeAddr);
  if (a + 8 > buf.length) return [];
  const sig = buf.slice(a, a + 4).toString('ascii');
  if (sig !== 'SNOD') return [];
  const version      = buf.readUInt8(a + 4);
  const numSymbols   = buf.readUInt16LE(a + 6);
  let pos = a + 8;
  const entrySize = offsetSize * 2 + 4 + 4 + 16; // nameOff + headerAddr + cacheType + reserved + scratch
  const entries = [];
  for (let i = 0; i < numSymbols; i++) {
    if (pos + entrySize > buf.length) break;
    const nameOff    = readLength(buf, pos, lengthSize); pos += lengthSize;
    const headerAddr = readOffset(buf, pos, offsetSize); pos += offsetSize;
    const cacheType  = buf.readUInt32LE(pos); pos += 4;
    pos += 4; // reserved
    let btreeAddr = null, nameHeapAddr = null, symlink = null;
    if (cacheType === 1) {
      btreeAddr    = readOffset(buf, pos, offsetSize);
      nameHeapAddr = readOffset(buf, pos + offsetSize, offsetSize);
    } else if (cacheType === 2) {
      const linkOff = buf.readUInt32LE(pos);
      if (heap) symlink = heap.readString(linkOff);
    }
    pos += 16; // scratch
    const name = heap ? heap.readString(toNumber(nameOff)) : '';
    entries.push({ name, headerAddr, cacheType, btreeAddr, nameHeapAddr, symlink });
  }
  return entries;
}

// ────────────────────────────────────────────────────────────────────────────
// B-tree v1 for chunked datasets
// ────────────────────────────────────────────────────────────────────────────
function readChunkedDataBtreeV1(buf, nodeAddr, offsetSize, lengthSize, ndims, depth) {
  if (depth > 8 || isUndefined(nodeAddr, offsetSize)) return [];
  const a = toNumber(nodeAddr);
  if (a + 8 > buf.length) return [];
  const sig = buf.slice(a, a + 4).toString('ascii');
  if (sig !== 'TREE') return [];
  const nodeType   = buf.readUInt8(a + 4);
  if (nodeType !== 1) return []; // must be raw data chunk node
  const nodeLevel  = buf.readUInt8(a + 5);
  const entriesUsed = buf.readUInt16LE(a + 6);
  let pos = a + 8 + offsetSize * 2; // skip sibling pointers

  // Key size = (ndims + 1) * 4 bytes per key (chunk coords + chunk size)
  const keySize = (ndims + 1) * 4;
  const chunks = [];
  for (let i = 0; i < entriesUsed; i++) {
    // key: (chunkSize, dim0, dim1, ...)
    const chunkSize = buf.readUInt32LE(pos);
    const coords = [];
    for (let d = 0; d < ndims; d++) coords.push(buf.readUInt32LE(pos + 4 + d * 4));
    pos += keySize;
    const childAddr = readOffset(buf, pos, offsetSize); pos += offsetSize;
    if (nodeLevel === 0) {
      // Leaf: points to raw chunk data
      chunks.push({ coords, size: chunkSize, addr: childAddr });
    } else {
      chunks.push(...readChunkedDataBtreeV1(buf, childAddr, offsetSize, lengthSize, ndims, depth + 1));
      // Also consume the last key
    }
  }
  // Consume final key
  pos += keySize;
  return chunks;
}

// ────────────────────────────────────────────────────────────────────────────
// Link Info / Group Info messages (v2 groups)
// ────────────────────────────────────────────────────────────────────────────
function parseLinkInfoMsg(data, offsetSize) {
  if (!data || data.length < 2) return {};
  const version = data.readUInt8(0);
  const flags   = data.readUInt8(1);
  let pos = 2;
  if (flags & 0x01) pos += 8; // maximum creation order
  const fractalHeapAddr = readOffset(data, pos, offsetSize); pos += offsetSize;
  const nameIndexBtreeAddr = readOffset(data, pos, offsetSize); pos += offsetSize;
  let creationOrderBtreeAddr = null;
  if (flags & 0x02) {
    creationOrderBtreeAddr = readOffset(data, pos, offsetSize); pos += offsetSize;
  }
  return { fractalHeapAddr, nameIndexBtreeAddr, creationOrderBtreeAddr };
}

// ────────────────────────────────────────────────────────────────────────────
// Link message (v2 format)
// ────────────────────────────────────────────────────────────────────────────
function parseLinkMsg(data, offsetSize) {
  if (!data || data.length < 4) return null;
  const version   = data.readUInt8(0);
  const flags     = data.readUInt8(1);
  let pos = 2;
  const linkType = (flags & 0x08) ? data.readUInt8(pos++) : 0; // 0=hard, 1=soft, 64=external
  if (flags & 0x04) pos += 8; // creation order
  const nameCharSet = (flags & 0x10) ? data.readUInt8(pos++) : 0;
  const nameLen = (flags & 0x03) === 0 ? data.readUInt8(pos++) :
                  (flags & 0x03) === 1 ? data.readUInt16LE(pos += 0, pos += 2, pos - 2) :
                  (flags & 0x03) === 2 ? data.readUInt32LE(pos += 0, pos += 4, pos - 4) :
                  Number(readLength(data, pos += 0, pos += 8, 8));
  const name = data.slice(pos, pos + nameLen).toString('utf8');
  pos += nameLen;
  let targetAddr = null, targetName = null;
  if (linkType === 0) {
    // Hard link: object header address
    targetAddr = readOffset(data, pos, offsetSize);
  } else if (linkType === 1) {
    // Soft link: target name
    const targetLen = data.readUInt16LE(pos); pos += 2;
    targetName = data.slice(pos, pos + targetLen).toString('utf8');
  }
  return { name, linkType, targetAddr, targetName };
}

// ────────────────────────────────────────────────────────────────────────────
// B-tree v2 traversal (v2 name index)
// ────────────────────────────────────────────────────────────────────────────
function traverseBtreeV2(buf, rootAddr, fractalHeap, offsetSize, lengthSize, heapIdLen, depth) {
  if (depth > MAX_DEPTH || isUndefined(rootAddr, offsetSize)) return [];
  const a = toNumber(rootAddr);
  if (a + 4 > buf.length) return [];
  const sig = buf.slice(a, a + 4).toString('ascii');
  if (sig !== 'BTHD') return [];

  // B-tree v2 header
  const version   = buf.readUInt8(a + 4);
  const nodeType  = buf.readUInt8(a + 5);
  const nodeSize  = buf.readUInt32LE(a + 6);
  const recSize   = buf.readUInt16LE(a + 10);
  const depth2    = buf.readUInt16LE(a + 12);
  const splitPerc = buf.readUInt8(a + 14);
  const mergePerc = buf.readUInt8(a + 15);
  const rootNodeAddr = readOffset(buf, a + 16, offsetSize);
  const numRecInRoot = buf.readUInt16LE(a + 16 + offsetSize);
  const numRecTotal  = readLength(buf, a + 18 + offsetSize, lengthSize);

  return traverseBtreeV2Node(buf, rootNodeAddr, depth2, recSize, nodeType, fractalHeap, offsetSize, lengthSize, heapIdLen, 0);
}

function traverseBtreeV2Node(buf, nodeAddr, level, recSize, nodeType, fractalHeap, offsetSize, lengthSize, heapIdLen, depth) {
  if (depth > MAX_DEPTH || isUndefined(nodeAddr, offsetSize)) return [];
  const a = toNumber(nodeAddr);
  if (a + 4 > buf.length) return [];
  const sig = buf.slice(a, a + 4).toString('ascii');
  const isLeaf = (sig === 'BTLF');
  const isInternal = (sig === 'BTIN');
  if (!isLeaf && !isInternal) return [];

  const version     = buf.readUInt8(a + 4);
  const nodeTypeB   = buf.readUInt8(a + 5);
  const numRecs     = buf.readUInt16LE(a + 6);
  let pos = a + 8;

  const links = [];
  for (let i = 0; i < numRecs && pos + recSize <= buf.length; i++) {
    const recBuf = buf.slice(pos, pos + recSize);
    pos += recSize;
    // Type 8 record: name-indexed link
    if (nodeType === 8 || nodeType === 9) {
      const heapId = recBuf.slice(0, heapIdLen);
      // Read the link message from the fractal heap
      if (fractalHeap) {
        const linkData = fractalHeap.readObject(heapId);
        if (linkData) {
          const link = parseLinkMsg(linkData, offsetSize);
          if (link) links.push(link);
        }
      }
    }
  }

  if (isInternal) {
    // Internal node: has child node pointers after records
    for (let i = 0; i <= numRecs; i++) {
      if (pos + offsetSize > buf.length) break;
      const childAddr = readOffset(buf, pos, offsetSize); pos += offsetSize;
      if (pos + 8 > buf.length) break;
      pos += 8; // numRecordsInChild + totalRecords (variable size, use 8 as estimate)
      if (!isUndefined(childAddr, offsetSize)) {
        links.push(...traverseBtreeV2Node(buf, childAddr, level - 1, recSize, nodeType, fractalHeap, offsetSize, lengthSize, heapIdLen, depth + 1));
      }
    }
  }

  return links;
}

// ────────────────────────────────────────────────────────────────────────────
// Object exploration: extract info from an object header
// ────────────────────────────────────────────────────────────────────────────
function extractObjectInfo(buf, addr, offsetSize, lengthSize) {
  const header = parseObjectHeader(buf, addr, offsetSize, lengthSize);
  if (!header) return null;

  let datatype = null;
  let dataspace = null;
  let layout = null;
  let pipeline = [];
  const attributes = [];

  for (const msg of header.messages) {
    try {
      if (msg.type === 1)  dataspace = parseDataspace(msg.data);
      if (msg.type === 3)  datatype  = parseDatatypeMsg(msg.data);
      if (msg.type === 8)  layout    = parseLayout(msg.data, offsetSize, lengthSize);
      if (msg.type === 11) pipeline  = parsePipeline(msg.data);
      if (msg.type === 12) {
        const attr = parseAttribute(msg.data, offsetSize, lengthSize);
        if (attr) attributes.push(attr);
      }
    } catch (_) {}
  }

  return { datatype, dataspace, layout, pipeline, attributes };
}

// ────────────────────────────────────────────────────────────────────────────
// Determine if an object is a group or dataset
// ────────────────────────────────────────────────────────────────────────────
function objectType(header) {
  if (!header) return 'unknown';
  for (const msg of header.messages) {
    if (msg.type === 1)  return 'dataset'; // has dataspace
  }
  return 'group';
}

// ────────────────────────────────────────────────────────────────────────────
// Decode attribute value
// ────────────────────────────────────────────────────────────────────────────
function decodeAttrValue(attr, buf, offsetSize, lengthSize) {
  const ds  = attr.dataspace;
  const dt  = attr.dtype;
  const data = attr.data;
  if (!data || data.length === 0) return null;

  const nElems = ds.dims.reduce((a, b) => a * b, 1) || 1;
  try {
    const vals = decodeData(data, dt, nElems, buf, offsetSize, lengthSize);
    if (nElems === 1 && ds.rank === 0) return vals[0];
    if (nElems === 1) return vals[0];
    return vals;
  } catch (_) {
    return data.slice(0, Math.min(64, data.length)).toString('hex');
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Data decoding
// ────────────────────────────────────────────────────────────────────────────
function decodeData(data, dt, nElems, globalBuf, offsetSize, lengthSize) {
  if (!dt || !data) return new Array(nElems).fill(null);
  const cls = dt.class;
  const sz  = dt.size || 1;
  const vals = [];

  if (cls === 0) {
    // Fixed-point (integer)
    const isSigned = dt.signed !== false;
    const byteOrder = dt.byteOrder || 'LE';
    for (let i = 0; i < nElems && (i + 1) * sz <= data.length; i++) {
      const off = i * sz;
      let v;
      if (sz === 1) v = isSigned ? data.readInt8(off) : data.readUInt8(off);
      else if (sz === 2) v = byteOrder === 'BE' ? (isSigned ? data.readInt16BE(off) : data.readUInt16BE(off)) : (isSigned ? data.readInt16LE(off) : data.readUInt16LE(off));
      else if (sz === 4) v = byteOrder === 'BE' ? (isSigned ? data.readInt32BE(off) : data.readUInt32BE(off)) : (isSigned ? data.readInt32LE(off) : data.readUInt32LE(off));
      else if (sz === 8) {
        const lo = data.readUInt32LE(off);
        const hi = byteOrder === 'BE' ? data.readUInt32BE(off + 4) : data.readUInt32LE(off + 4);
        const big = isSigned
          ? (BigInt(hi) << 32n) | BigInt(lo)
          : (BigInt(hi >>> 0) << 32n) | BigInt(lo);
        v = Number.isSafeInteger(Number(big)) ? Number(big) : big.toString();
      } else v = data.readUInt8(off);
      vals.push(v);
    }
  } else if (cls === 1) {
    // Float
    const byteOrder = dt.byteOrder || 'LE';
    for (let i = 0; i < nElems && (i + 1) * sz <= data.length; i++) {
      const off = i * sz;
      let v;
      if (sz === 4) v = byteOrder === 'BE' ? data.readFloatBE(off) : data.readFloatLE(off);
      else if (sz === 8) v = byteOrder === 'BE' ? data.readDoubleBE(off) : data.readDoubleLE(off);
      else v = 0;
      vals.push(v);
    }
  } else if (cls === 3) {
    // Fixed-length string
    for (let i = 0; i < nElems && (i + 1) * sz <= data.length; i++) {
      const slice = data.slice(i * sz, (i + 1) * sz);
      let end = slice.indexOf(0);
      if (end < 0) end = slice.length;
      vals.push(slice.slice(0, end).toString('utf8'));
    }
  } else if (cls === 9) {
    // Variable-length
    const vlenType = dt.vlenType || 0;
    // VLen on disk: {length(4), globalHeapAddr(offsetSize), heapIndex(4)} = 4+offsetSize+4
    const vlenSz = 4 + offsetSize + 4; // approximate
    // For strings, size is typically 16 bytes (pointer-like)
    const elemSz = sz || vlenSz;
    for (let i = 0; i < nElems && (i + 1) * elemSz <= data.length; i++) {
      const off = i * elemSz;
      const len = data.readUInt32LE(off);
      if (vlenType === 1) {
        // VLen string: follow global heap
        const heapAddr = readOffset(data, off + 4, offsetSize);
        const heapIdx  = data.readUInt32LE(off + 4 + offsetSize);
        if (globalBuf && !isUndefined(heapAddr, offsetSize)) {
          const str = readGlobalHeapObject(globalBuf, toNumber(heapAddr), heapIdx, len);
          vals.push(str);
        } else {
          vals.push(null);
        }
      } else {
        vals.push(`<vlen:len=${len}>`);
      }
    }
  } else if (cls === 6) {
    // Compound
    const members = dt.members || [];
    for (let i = 0; i < nElems && (i + 1) * sz <= data.length; i++) {
      const off = i * sz;
      const obj = {};
      for (const m of members) {
        const mData = data.slice(off + m.offset, off + m.offset + (m.dtype.size || 0));
        const mVals = decodeData(mData, m.dtype, 1, globalBuf, offsetSize, lengthSize);
        obj[m.name] = mVals[0] ?? null;
      }
      vals.push(obj);
    }
  } else if (cls === 8) {
    // Enum
    const baseVals = decodeData(data, dt.baseType || { class: 0, size: 4, signed: false }, nElems, globalBuf, offsetSize, lengthSize);
    const reverseMap = {};
    for (const [k, v] of Object.entries(dt.members || {})) reverseMap[v] = k;
    for (const v of baseVals) vals.push(reverseMap[v] !== undefined ? reverseMap[v] : v);
  } else if (cls === 10) {
    // Array
    const arrDims = dt.dims || [1];
    const arrElems = arrDims.reduce((a, b) => a * b, 1);
    const baseSz = dt.baseType ? dt.baseType.size : (sz / arrElems);
    for (let i = 0; i < nElems; i++) {
      const off = i * sz;
      const slice = data.slice(off, off + sz);
      const subVals = decodeData(slice, dt.baseType || { class: 0, size: baseSz }, arrElems, globalBuf, offsetSize, lengthSize);
      vals.push(subVals);
    }
  } else if (cls === 4) {
    // Bitfield: return as hex string
    for (let i = 0; i < nElems && (i + 1) * sz <= data.length; i++) {
      vals.push(data.slice(i * sz, (i + 1) * sz).toString('hex'));
    }
  } else if (cls === 5) {
    // Opaque: return as hex
    for (let i = 0; i < nElems && (i + 1) * sz <= data.length; i++) {
      vals.push(data.slice(i * sz, (i + 1) * sz).toString('hex'));
    }
  } else {
    // Unknown: return hex
    for (let i = 0; i < nElems && (i + 1) * sz <= data.length; i++) {
      vals.push(data.slice(i * sz, (i + 1) * sz).toString('hex'));
    }
  }

  return vals;
}

// ────────────────────────────────────────────────────────────────────────────
// Global Heap
// ────────────────────────────────────────────────────────────────────────────
function readGlobalHeapObject(buf, heapAddr, idx, len) {
  if (heapAddr + 8 > buf.length) return null;
  const sig = buf.slice(heapAddr, heapAddr + 4).toString('ascii');
  if (sig !== 'GCOL') return null;
  const version  = buf.readUInt8(heapAddr + 4);
  const collSize = Number(readLength(buf, heapAddr + 8, 8)); // size always 8
  let pos = heapAddr + 16;
  while (pos + 8 < heapAddr + collSize && pos + 8 < buf.length) {
    const objIdx  = buf.readUInt16LE(pos);
    const refCount = buf.readUInt16LE(pos + 2);
    const objSize = Number(readLength(buf, pos + 8, 8));
    const dataStart = pos + 16;
    if (objIdx === idx) {
      return buf.slice(dataStart, dataStart + (len || objSize)).toString('utf8').replace(/\0/g, '');
    }
    pos = dataStart + objSize;
    // Align to 8 bytes
    const rem = pos % 8;
    if (rem !== 0) pos += 8 - rem;
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Filter/decompression pipeline
// ────────────────────────────────────────────────────────────────────────────
function applyFilters(data, pipeline) {
  if (!pipeline || pipeline.length === 0) return data;
  let result = data;
  // Apply in reverse order (last filter first for decompression)
  for (let i = pipeline.length - 1; i >= 0; i--) {
    const f = pipeline[i];
    try {
      if (f.id === 1) {
        // deflate/gzip
        result = zlib.inflateRawSync(result);
      } else if (f.id === 2) {
        // shuffle: unapply (byte-interleaving)
        // Requires knowing element size from client data
        const elemSz = f.clientData && f.clientData[0] ? f.clientData[0] : 1;
        result = unshuffleData(result, elemSz);
      } else if (f.id === 3) {
        // fletcher32: strip last 4 bytes (checksum)
        result = result.slice(0, result.length - 4);
      }
      // szip, nbit, scaleoffset: skip (complex)
    } catch (_) {
      // Return what we have on filter error
    }
  }
  return result;
}

function unshuffleData(buf, elemSz) {
  if (elemSz <= 1) return buf;
  const nElems = Math.floor(buf.length / elemSz);
  const out = Buffer.allocUnsafe(buf.length);
  for (let b = 0; b < elemSz; b++) {
    for (let e = 0; e < nElems; e++) {
      out[e * elemSz + b] = buf[b * nElems + e];
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// Dataset reading
// ────────────────────────────────────────────────────────────────────────────
function readDataset(buf, objInfo, offsetSize, lengthSize, maxElems) {
  const { datatype, dataspace, layout, pipeline } = objInfo;
  if (!datatype || !dataspace || !layout) return [];

  const totalElems = dataspace.dims.reduce((a, b) => a * b, 1) || 0;
  const nElems = Math.min(totalElems, maxElems || MAX_ELEMENTS);
  if (nElems === 0) return [];

  let rawData;
  if (layout.class === 0) {
    // Compact: data inline
    rawData = layout.compactData || Buffer.alloc(0);
  } else if (layout.class === 1) {
    // Contiguous
    const addr = toNumber(layout.dataAddress);
    if (isUndefined(layout.dataAddress, offsetSize) || addr >= buf.length) return [];
    rawData = buf.slice(addr, addr + layout.dataSize);
  } else if (layout.class === 2) {
    // Chunked: read via B-tree
    rawData = readChunkedData(buf, layout, dataspace, datatype, pipeline, offsetSize, lengthSize, nElems);
    if (!rawData) return [];
    return decodeData(rawData, datatype, nElems, buf, offsetSize, lengthSize);
  } else {
    return [];
  }

  // Apply filters (for contiguous and compact)
  if (pipeline && pipeline.length > 0) {
    rawData = applyFilters(rawData, pipeline);
  }

  return decodeData(rawData, datatype, nElems, buf, offsetSize, lengthSize);
}

function readChunkedData(buf, layout, dataspace, datatype, pipeline, offsetSize, lengthSize, nElems) {
  const btreeAddr = layout.chunkBtreeAddr;
  if (!btreeAddr || isUndefined(btreeAddr, offsetSize)) return null;

  const ndims = (dataspace.rank || 1);
  const chunkDims = layout.dims ? layout.dims.slice(0, ndims) : [1];

  // Get all chunk descriptors from B-tree v1
  const chunks = readChunkedDataBtreeV1(buf, btreeAddr, offsetSize, lengthSize, ndims, 0);
  if (chunks.length === 0) return null;

  const elemSz = datatype.size || 1;
  const totalElems = dataspace.dims.reduce((a, b) => a * b, 1);
  const out = Buffer.allocUnsafe(Math.min(nElems, totalElems) * elemSz);
  let written = 0;

  // Sort chunks by first coord
  chunks.sort((a, b) => {
    for (let d = 0; d < Math.min(a.coords.length, b.coords.length); d++) {
      if (a.coords[d] !== b.coords[d]) return a.coords[d] - b.coords[d];
    }
    return 0;
  });

  for (const chunk of chunks) {
    if (written >= out.length) break;
    const addr = toNumber(chunk.addr);
    if (isUndefined(chunk.addr, offsetSize) || addr >= buf.length) continue;
    let chunkData = buf.slice(addr, addr + chunk.size);
    // Apply filters
    try { chunkData = applyFilters(chunkData, pipeline); } catch (_) { continue; }

    // Write chunk data into output buffer
    const toCopy = Math.min(chunkData.length, out.length - written);
    chunkData.copy(out, written, 0, toCopy);
    written += toCopy;
  }

  return out.slice(0, written);
}

// ────────────────────────────────────────────────────────────────────────────
// Group traversal
// ────────────────────────────────────────────────────────────────────────────
function traverseGroup(buf, groupAddr, offsetSize, lengthSize, depth, parentPath) {
  if (depth > MAX_DEPTH) return [];
  const header = parseObjectHeader(buf, groupAddr, offsetSize, lengthSize);
  if (!header) return [];

  const items = [];
  let linkInfoMsg = null;
  let groupInfoMsg = null;
  let hasV2Links = false;

  // Look for v2 link info message
  for (const msg of header.messages) {
    if (msg.type === 10) { linkInfoMsg = parseLinkInfoMsg(msg.data, offsetSize); hasV2Links = true; }
    if (msg.type === 4)  { groupInfoMsg = msg; }
    if (msg.type === 6)  {
      // Link message (type 6)
      try {
        const link = parseLinkMsg(msg.data, offsetSize);
        if (link && link.name) {
          const itemPath = parentPath ? `${parentPath}/${link.name}` : link.name;
          if (link.linkType === 0 && link.targetAddr !== null && !isUndefined(link.targetAddr, offsetSize)) {
            const childHeader = parseObjectHeader(buf, link.targetAddr, offsetSize, lengthSize);
            const objT = childHeader ? objectType(childHeader) : 'unknown';
            const objInfo = objT === 'dataset' ? extractObjectInfo(buf, link.targetAddr, offsetSize, lengthSize) : null;
            items.push(makeItem(itemPath, link.name, objT, objInfo, link.targetAddr));
            if (objT === 'group') {
              items.push(...traverseGroup(buf, link.targetAddr, offsetSize, lengthSize, depth + 1, itemPath));
            }
          } else if (link.linkType === 1) {
            items.push({ path: itemPath, name: link.name, type: 'softlink', target: link.targetName });
          }
        }
      } catch (_) {}
    }
  }

  if (hasV2Links && linkInfoMsg) {
    // v2 group: use fractal heap + name index B-tree
    const { fractalHeapAddr, nameIndexBtreeAddr } = linkInfoMsg;
    let fh = null;
    if (!isUndefined(fractalHeapAddr, offsetSize)) {
      fh = parseFractalHeap(buf, fractalHeapAddr, offsetSize, lengthSize);
    }
    const heapIdLen = fh ? fh.heapIdLen : 7;
    if (!isUndefined(nameIndexBtreeAddr, offsetSize)) {
      const links = traverseBtreeV2(buf, nameIndexBtreeAddr, fh, offsetSize, lengthSize, heapIdLen, 0);
      for (const link of links) {
        if (!link || !link.name) continue;
        const itemPath = parentPath ? `${parentPath}/${link.name}` : link.name;
        if (link.linkType === 0 && link.targetAddr !== null && !isUndefined(link.targetAddr, offsetSize)) {
          const childHeader = parseObjectHeader(buf, link.targetAddr, offsetSize, lengthSize);
          const objT = childHeader ? objectType(childHeader) : 'unknown';
          const objInfo = objT === 'dataset' ? extractObjectInfo(buf, link.targetAddr, offsetSize, lengthSize) : null;
          items.push(makeItem(itemPath, link.name, objT, objInfo, link.targetAddr));
          if (objT === 'group') {
            items.push(...traverseGroup(buf, link.targetAddr, offsetSize, lengthSize, depth + 1, itemPath));
          }
        } else if (link.linkType === 1) {
          items.push({ path: itemPath, name: link.name, type: 'softlink', target: link.targetName });
        }
      }
    }
    return items;
  }

  // v1 group: B-tree + local heap
  for (const msg of header.messages) {
    if (msg.type === 17 || msg.type === 1 + 16) {
      // Symbol table message (type 17 = 0x11)
      try {
        const btreeAddr  = readOffset(msg.data, 0, offsetSize);
        const heapAddr   = readOffset(msg.data, offsetSize, offsetSize);
        const heap = parseLocalHeap(buf, heapAddr, offsetSize, lengthSize);
        const entries = traverseBtreeV1Group(buf, btreeAddr, heap, offsetSize, lengthSize, 4, depth + 1);
        for (const entry of entries) {
          if (!entry || !entry.name || entry.name === '.' || entry.name === '') continue;
          const itemPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
          const childHeader = parseObjectHeader(buf, entry.headerAddr, offsetSize, lengthSize);
          const objT = childHeader ? objectType(childHeader) : 'unknown';
          const objInfo = objT === 'dataset' ? extractObjectInfo(buf, entry.headerAddr, offsetSize, lengthSize) : null;
          items.push(makeItem(itemPath, entry.name, objT, objInfo, entry.headerAddr));
          if (objT === 'group') {
            items.push(...traverseGroup(buf, entry.headerAddr, offsetSize, lengthSize, depth + 1, itemPath));
          }
          if (entry.cacheType === 1) {
            // This entry IS the group (has embedded btree/heap pointers)
          }
        }
      } catch (_) {}
    }
  }

  return items;
}

function makeItem(itemPath, name, objType, objInfo, addr) {
  const item = { path: itemPath, name, type: objType };
  if (objType === 'dataset' && objInfo) {
    const ds = objInfo.dataspace;
    const dt = objInfo.datatype;
    item.dims    = ds ? ds.dims : [];
    item.rank    = ds ? ds.rank : 0;
    item.dtype   = dt ? describeDtype(dt) : 'unknown';
    item.size    = ds ? ds.dims.reduce((a, b) => a * b, 1) : 0;
    item.filters = objInfo.pipeline ? objInfo.pipeline.map(f => f.name || `filter_${f.id}`) : [];
    item.numAttrs = objInfo.attributes ? objInfo.attributes.length : 0;
  } else if (objType === 'group') {
    item.numAttrs = objInfo ? (objInfo.attributes || []).length : 0;
  }
  item._addr = addr;
  return item;
}

function describeDtype(dt) {
  if (!dt) return 'unknown';
  const cls = dt.class;
  if (cls === 0) return `${dt.signed !== false ? 'int' : 'uint'}${(dt.size || 1) * 8}`;
  if (cls === 1) return `float${(dt.size || 4) * 8}`;
  if (cls === 3) return 'string';
  if (cls === 9) return dt.vlenType === 1 ? 'vlen_string' : 'vlen';
  if (cls === 6) return `compound(${(dt.members || []).map(m => m.name).join(',')})`;
  if (cls === 8) return 'enum';
  if (cls === 10) return `array[${(dt.dims || []).join('x')}]`;
  if (cls === 4) return 'bitfield';
  if (cls === 5) return 'opaque';
  return dt.name || `class_${cls}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Load HDF5 file
// ────────────────────────────────────────────────────────────────────────────
function loadHdf5(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) throw new ToolError(`hdf5_client: '${filePath}' is a directory.`, -32602);
  if (stat.size > MAX_FILE_SIZE) throw new ToolError(`hdf5_client: file too large (${stat.size} bytes; max ${MAX_FILE_SIZE}).`, -32602);

  const buf = fs.readFileSync(filePath);
  const sb  = parseSuperblock(buf);
  return { buf, sb };
}

// ────────────────────────────────────────────────────────────────────────────
// Resolve dataset path
// ────────────────────────────────────────────────────────────────────────────
function resolveDatasetPath(buf, sb, dsPath) {
  const parts = dsPath.replace(/^\//, '').split('/').filter(Boolean);
  let curAddr = sb.rootAddress;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const header = parseObjectHeader(buf, curAddr, sb.offsetSize, sb.lengthSize);
    if (!header) throw new ToolError(`hdf5_client: path '${dsPath}' not found (no header at depth ${i}).`, -32602);
    // Look for the child in this group
    let found = null;
    // Check link messages directly
    for (const msg of header.messages) {
      if (msg.type === 6) {
        try {
          const link = parseLinkMsg(msg.data, sb.offsetSize);
          if (link && link.name === part) { found = link; break; }
        } catch (_) {}
      }
    }
    if (!found) {
      // Check v2 group via fractal heap
      for (const msg of header.messages) {
        if (msg.type === 10) {
          const linkInfo = parseLinkInfoMsg(msg.data, sb.offsetSize);
          if (linkInfo.fractalHeapAddr && !isUndefined(linkInfo.fractalHeapAddr, sb.offsetSize)) {
            const fh = parseFractalHeap(buf, linkInfo.fractalHeapAddr, sb.offsetSize, sb.lengthSize);
            if (fh && !isUndefined(linkInfo.nameIndexBtreeAddr, sb.offsetSize)) {
              const links = traverseBtreeV2(buf, linkInfo.nameIndexBtreeAddr, fh, sb.offsetSize, sb.lengthSize, fh.heapIdLen, 0);
              for (const link of links) {
                if (link && link.name === part) { found = link; break; }
              }
            }
          }
        }
        if (found) break;
      }
    }
    if (!found) {
      // v1 group
      for (const msg of header.messages) {
        if (msg.type === 17) {
          const btreeAddr = readOffset(msg.data, 0, sb.offsetSize);
          const heapAddr  = readOffset(msg.data, sb.offsetSize, sb.offsetSize);
          const heap = parseLocalHeap(buf, heapAddr, sb.offsetSize, sb.lengthSize);
          const entries = traverseBtreeV1Group(buf, btreeAddr, heap, sb.offsetSize, sb.lengthSize, 4, 0);
          for (const e of entries) {
            if (e.name === part) { found = { linkType: 0, targetAddr: e.headerAddr }; break; }
          }
        }
        if (found) break;
      }
    }
    if (!found) throw new ToolError(`hdf5_client: path component '${part}' not found in '${dsPath}'.`, -32602);
    if (found.linkType === 0) curAddr = found.targetAddr;
    else throw new ToolError(`hdf5_client: soft links not supported in path resolution.`, -32602);
  }
  return curAddr;
}

// ────────────────────────────────────────────────────────────────────────────
// Format values for output
// ────────────────────────────────────────────────────────────────────────────
function reshapeToRows(vals, dims) {
  if (!dims || dims.length === 0) return vals;
  if (dims.length === 1) return vals;
  // For 2-D: return array of arrays
  if (dims.length === 2) {
    const rows = [];
    const ncols = dims[1];
    for (let r = 0; r < dims[0]; r++) {
      rows.push(vals.slice(r * ncols, (r + 1) * ncols));
    }
    return rows;
  }
  // Higher-D: flatten to nested arrays recursively
  const stride = dims.slice(1).reduce((a, b) => a * b, 1);
  const rows = [];
  for (let r = 0; r < dims[0]; r++) {
    rows.push(reshapeToRows(vals.slice(r * stride, (r + 1) * stride), dims.slice(1)));
  }
  return rows;
}

// ────────────────────────────────────────────────────────────────────────────
// Operations
// ────────────────────────────────────────────────────────────────────────────

function opInfo(args, resolved) {
  const { buf, sb } = loadHdf5(resolved);
  const stat = fs.statSync(resolved);
  const items = traverseGroup(buf, sb.rootAddress, sb.offsetSize, sb.lengthSize, 0, '');
  const datasets = items.filter(i => i.type === 'dataset');
  const groups   = items.filter(i => i.type === 'group');

  return {
    path:           args.path,
    fileSizeBytes:  stat.size,
    superblockVersion: sb.version,
    offsetSize:     sb.offsetSize,
    lengthSize:     sb.lengthSize,
    numDatasets:    datasets.length,
    numGroups:      groups.length + 1, // +1 for root
    datasets:       datasets.map(d => ({
      path:    d.path,
      dims:    d.dims,
      dtype:   d.dtype,
      size:    d.size,
      filters: d.filters,
    })),
    groups: groups.map(g => g.path),
  };
}

function opList(args, resolved) {
  const { buf, sb } = loadHdf5(resolved);
  const groupPath = args.group_path || '/';
  let groupAddr = sb.rootAddress;
  if (groupPath !== '/' && groupPath !== '') {
    groupAddr = resolveDatasetPath(buf, sb, groupPath);
  }

  const items = traverseGroup(buf, groupAddr, sb.offsetSize, sb.lengthSize, 0, groupPath === '/' ? '' : groupPath);
  // Only return immediate children (depth 1)
  const basePath = groupPath === '/' ? '' : groupPath.replace(/\/$/, '');
  const direct = items.filter(item => {
    const rel = item.path.slice(basePath.length).replace(/^\//, '');
    return !rel.includes('/');
  });

  return {
    path:       args.path,
    groupPath,
    items:      direct.map(i => ({
      name:  i.name,
      path:  `/${i.path}`.replace('//', '/'),
      type:  i.type,
      dims:  i.dims,
      dtype: i.dtype,
      size:  i.size,
      filters: i.filters,
      numAttrs: i.numAttrs,
      target: i.target,
    })),
    count: direct.length,
  };
}

function opAttrs(args, resolved) {
  const { buf, sb } = loadHdf5(resolved);
  const dsPath = args.dataset_path || '/';
  let objAddr = sb.rootAddress;
  if (dsPath !== '/' && dsPath !== '') {
    objAddr = resolveDatasetPath(buf, sb, dsPath);
  }
  const objInfo = extractObjectInfo(buf, objAddr, sb.offsetSize, sb.lengthSize);
  if (!objInfo) throw new ToolError(`hdf5_client: could not read object at '${dsPath}'.`, -32602);

  const attrs = {};
  for (const attr of objInfo.attributes) {
    try {
      attrs[attr.name] = decodeAttrValue(attr, buf, sb.offsetSize, sb.lengthSize);
    } catch (_) {
      attrs[attr.name] = null;
    }
  }

  return {
    path:         args.path,
    datasetPath:  dsPath,
    numAttributes: objInfo.attributes.length,
    attributes:    attrs,
  };
}

function opRead(args, resolved) {
  const { buf, sb } = loadHdf5(resolved);
  const dsPath = args.dataset_path;
  if (!dsPath) throw new ToolError("hdf5_client: 'dataset_path' is required for 'read'.", -32602);

  const objAddr = resolveDatasetPath(buf, sb, dsPath);
  const objInfo = extractObjectInfo(buf, objAddr, sb.offsetSize, sb.lengthSize);
  if (!objInfo || !objInfo.dataspace) throw new ToolError(`hdf5_client: '${dsPath}' is not a dataset.`, -32602);

  const ds = objInfo.dataspace;
  const totalElems = ds.dims.reduce((a, b) => a * b, 1) || 0;
  const offset = args.offset || 0;
  const limit  = Math.min(args.limit || totalElems, MAX_ELEMENTS);

  let vals = readDataset(buf, objInfo, sb.offsetSize, sb.lengthSize, totalElems);
  vals = vals.slice(offset, offset + limit);

  const reshaped = (args.flat || ds.rank <= 1) ? vals : reshapeToRows(vals, ds.dims);

  return {
    path:        args.path,
    datasetPath: dsPath,
    dims:        ds.dims,
    rank:        ds.rank,
    dtype:       describeDtype(objInfo.datatype),
    totalElements: totalElems,
    offset,
    returnedElements: vals.length,
    data: reshaped,
  };
}

function opToJson(args, resolved) {
  if (args.output_file && args.output_file.includes('\0'))
    throw new ToolError('hdf5_client: NUL byte in output_file.', -32602);
  const result = opRead(args, resolved);
  const json   = JSON.stringify(result.data, null, args.pretty ? 2 : undefined);
  if (args.output_file) {
    const outPath = args.output_file;
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(outPath, json, 'utf8');
    return { path: args.path, datasetPath: args.dataset_path, outputFile: outPath, writtenElements: result.returnedElements, sizeBytes: Buffer.byteLength(json) };
  }
  return { path: args.path, datasetPath: args.dataset_path, dims: result.dims, dtype: result.dtype, returnedElements: result.returnedElements, json };
}

function opToCsv(args, resolved) {
  if (args.output_file && args.output_file.includes('\0'))
    throw new ToolError('hdf5_client: NUL byte in output_file.', -32602);
  const result = opRead(args, resolved);
  const sep = args.separator || ',';
  const data = result.data;

  function esc(val) {
    if (val === null || val === undefined) return '';
    if (Array.isArray(val)) return esc(JSON.stringify(val));
    if (typeof val === 'object') return esc(JSON.stringify(val));
    const s = String(val);
    return (s.includes(sep) || s.includes('"') || s.includes('\n')) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  // For 2-D: row-per-line with column header indices
  let lines;
  const dims = result.dims;
  if (dims.length >= 2 && Array.isArray(data[0])) {
    const ncols = dims[1];
    const header = Array.from({ length: ncols }, (_, i) => `col_${i}`).join(sep);
    lines = [header, ...data.map(row => Array.isArray(row) ? row.map(esc).join(sep) : esc(row))];
  } else {
    lines = ['value', ...data.map(esc)];
  }
  const csv = lines.join('\n');

  if (args.output_file) {
    const outPath = args.output_file;
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(outPath, csv, 'utf8');
    return { path: args.path, datasetPath: args.dataset_path, outputFile: outPath, writtenElements: result.returnedElements, sizeBytes: Buffer.byteLength(csv) };
  }
  return { path: args.path, datasetPath: args.dataset_path, dims: result.dims, dtype: result.dtype, returnedElements: result.returnedElements, csv };
}

// ── Public API ───────────────────────────────────────────────────────────────
function hdf5Client(args, resolveClientPath) {
  if (!args.operation) throw new ToolError("hdf5_client: 'operation' is required.", -32602);
  if (!args.path)      throw new ToolError("hdf5_client: 'path' is required.", -32602);
  if (args.path.includes('\0')) throw new ToolError('hdf5_client: NUL byte in path.', -32602);

  const { resolved } = resolveClientPath(args.path);
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) throw new ToolError(`hdf5_client: '${args.path}' is a directory.`, -32602);

  switch (args.operation) {
    case 'info':    return opInfo(args, resolved);
    case 'list':    return opList(args, resolved);
    case 'attrs':   return opAttrs(args, resolved);
    case 'read':    return opRead(args, resolved);
    case 'to_json': return opToJson(args, resolved);
    case 'to_csv':  return opToCsv(args, resolved);
    default:
      throw new ToolError(
        `hdf5_client: unknown operation '${args.operation}'. Valid: info, list, attrs, read, to_json, to_csv.`,
        -32602,
      );
  }
}

module.exports = {
  hdf5Client,
  // Exported internals for testing
  parseSuperblock,
  parseObjectHeader,
  parseDataspace,
  parseDatatypeMsg,
  parseDatatype,
  parseAttribute,
  parseLayout,
  parsePipeline,
  parseLocalHeap,
  decodeData,
  applyFilters,
  unshuffleData,
  describeDtype,
  reshapeToRows,
  readGlobalHeapObject,
  HDF5_SIGNATURE,
};
