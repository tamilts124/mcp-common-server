"use strict";
// lib/arrowClientOps.js — Zero-dep Apache Arrow IPC file/stream reader (pure Node.js; no npm deps)
// Supports: info, schema, read, to_json, to_csv
// Arrow IPC format: File (with magic + footer) and Stream (message-framed)
// Column types: NULL, BOOL, INT (8/16/32/64, signed/unsigned), FLOAT (16/32/64),
//               BINARY, LARGE_BINARY, UTF8, LARGE_UTF8, DATE32, DATE64,
//               TIMESTAMP, TIME32, TIME64, DURATION, INTERVAL,
//               LIST, LARGE_LIST, FIXED_SIZE_LIST, STRUCT, MAP, DICTIONARY
// Security: 200 MB file cap; 10,000,000 row limit; NUL-byte path guard; directory path rejected

const fs   = require("fs");
const path = require("path");
const { ToolError } = require("./errors");

const MAX_FILE_SIZE = 200 * 1024 * 1024; // 200 MB
const MAX_ROWS      = 10_000_000;

// Arrow IPC magic
const ARROW_MAGIC      = Buffer.from("ARROW1");
const ARROW_MAGIC_LEN  = 6;
const ARROW_PADDING    = Buffer.from([0, 0]); // 2-byte padding after magic
const CONTINUATION     = 0xFFFFFFFF; // continuation marker in stream

// ── FlatBuffers minimal reader ────────────────────────────────────────────────
// Arrow uses FlatBuffers for the Schema, RecordBatch, DictionaryBatch messages.
// We implement a minimal table+vector accessor sufficient for Arrow's layout.

class FlatBuf {
  constructor(buf, offset) {
    this.buf = buf;
    this.offset = offset >>> 0; // absolute offset into buf
  }

  // Read a 32-bit signed little-endian int at absolute pos
  i32(pos) {
    if (pos + 4 > this.buf.length) return 0;
    return this.buf.readInt32LE(pos);
  }
  // Read a 64-bit little-endian value as Number (precision limited for large values)
  i64(pos) {
    if (pos + 8 > this.buf.length) return 0;
    const lo = this.buf.readUInt32LE(pos);
    const hi = this.buf.readInt32LE(pos + 4);
    return hi * 0x100000000 + lo;
  }
  u32(pos) {
    if (pos + 4 > this.buf.length) return 0;
    return this.buf.readUInt32LE(pos);
  }
  u16(pos) {
    if (pos + 2 > this.buf.length) return 0;
    return this.buf.readUInt16LE(pos);
  }
  u8(pos) {
    if (pos >= this.buf.length) return 0;
    return this.buf[pos];
  }
  // FlatBuffers table: vtable offset, then field offsets
  // A table at absPos has an int32 offset to vtable (negative means vtable is before table)
  vtable(absPos) {
    const vtableOff = this.i32(absPos);
    return absPos - vtableOff; // vtable absolute position
  }
  // Get vtable size in bytes
  vtableSize(absPos) {
    const vt = this.vtable(absPos);
    return this.u16(vt);
  }
  // Get the absolute offset of field[index] in table at absPos; 0 if not present
  field(absPos, index) {
    const vt     = this.vtable(absPos);
    const vtSize = this.u16(vt); // vtable size
    const slot   = 4 + index * 2;
    if (slot + 2 > vtSize) return 0;
    const relOff = this.u16(vt + slot);
    if (relOff === 0) return 0;
    return absPos + relOff;
  }
  // Read a FlatBuffers string at the field offset (length-prefixed UTF-8)
  string(fieldAbsPos) {
    if (fieldAbsPos === 0) return null;
    const strOff = fieldAbsPos + this.i32(fieldAbsPos);
    const len    = this.u32(strOff);
    if (len === 0) return "";
    return this.buf.slice(strOff + 4, strOff + 4 + len).toString("utf8");
  }
  // Follow an indirect reference (union/table field is an offset to another table)
  indirect(fieldAbsPos) {
    if (fieldAbsPos === 0) return 0;
    return fieldAbsPos + this.i32(fieldAbsPos);
  }
  // FlatBuffers vector: returns { length, dataStart } where dataStart points to first element
  vector(fieldAbsPos) {
    if (fieldAbsPos === 0) return { length: 0, dataStart: 0 };
    const vecStart = fieldAbsPos + this.i32(fieldAbsPos);
    const length   = this.u32(vecStart);
    return { length, dataStart: vecStart + 4 };
  }
  // Vector element at index: each element is elemSize bytes
  vectorElem(fieldAbsPos, index, elemSize) {
    const { length, dataStart } = this.vector(fieldAbsPos);
    if (index >= length) return 0;
    return dataStart + index * elemSize;
  }
  // Vector element as table (4-byte offset)
  vectorTable(fieldAbsPos, index) {
    const pos = this.vectorElem(fieldAbsPos, index, 4);
    if (pos === 0) return 0;
    return pos + this.i32(pos);
  }
  // Read an int32 field value (with default 0)
  fieldI32(absPos, index) {
    const fp = this.field(absPos, index);
    return fp === 0 ? 0 : this.i32(fp);
  }
  // Read an int8 field value
  fieldI8(absPos, index) {
    const fp = this.field(absPos, index);
    return fp === 0 ? 0 : (this.buf[fp] << 24 >> 24); // sign-extend
  }
  fieldU8(absPos, index) {
    const fp = this.field(absPos, index);
    return fp === 0 ? 0 : this.u8(fp);
  }
  // Read an int64 field value
  fieldI64(absPos, index) {
    const fp = this.field(absPos, index);
    return fp === 0 ? 0 : this.i64(fp);
  }
  // Read a boolean field
  fieldBool(absPos, index) {
    const fp = this.field(absPos, index);
    return fp === 0 ? false : (this.u8(fp) !== 0);
  }
}

// ── Arrow FlatBuffers schema enums ────────────────────────────────────────────
const TYPE_NAMES = [
  "NONE", "Null", "Int", "FloatingPoint", "Binary", "Utf8", "Bool",
  "Decimal", "Date", "Time", "Timestamp", "Interval", "List",
  "Struct", "Union", "FixedSizeBinary", "FixedSizeList", "Map",
  "Duration", "LargeBinary", "LargeUtf8", "LargeList", "RunEndEncoded",
];

const FIELD_TYPE = {
  NONE: 0, NULL: 1, INT: 2, FLOATING_POINT: 3, BINARY: 4, UTF8: 5, BOOL: 6,
  DECIMAL: 7, DATE: 8, TIME: 9, TIMESTAMP: 10, INTERVAL: 11, LIST: 12,
  STRUCT: 13, UNION: 14, FIXED_SIZE_BINARY: 15, FIXED_SIZE_LIST: 16,
  MAP: 17, DURATION: 18, LARGE_BINARY: 19, LARGE_UTF8: 20, LARGE_LIST: 21,
};

const DATE_UNIT   = ["DAY", "MILLISECOND"];
const TIME_UNIT   = ["SECOND", "MILLISECOND", "MICROSECOND", "NANOSECOND"];
const ENDIANNESS  = ["Little", "Big"];
const INT_WIDTHS  = [8, 16, 32, 64];
const FLOAT_PREC  = ["HALF", "SINGLE", "DOUBLE"];
const INTERVAL_UNITS = ["YEAR_MONTH", "DAY_TIME", "MONTH_DAY_NANO"];

// ── Parse Arrow schema from FlatBuffers ──────────────────────────────────────
//
// Arrow Schema FlatBuffers layout:
//   Schema { endianness: int16, fields: [Field], custom_metadata: [KeyValue], features: [long] }
//   Field  { name: string, nullable: bool, type_type: uint8 (union tag), type: Table,
//             children: [Field], custom_metadata: [KeyValue], dictionary: DictionaryEncoding }
//
function parseSchema(fb, schemaAbsPos) {
  // fields vector: slot 1 in Schema table
  const fieldsField = fb.field(schemaAbsPos, 1);
  const { length: numFields, dataStart: fieldsStart } = fb.vector(fieldsField);

  const fields = [];
  for (let i = 0; i < numFields; i++) {
    const fieldAbs = fb.vectorTable(fieldsField, i);
    fields.push(parseField(fb, fieldAbs));
  }
  const endianness = fb.fieldI8(schemaAbsPos, 0) === 1 ? "Big" : "Little";
  return { endianness, fields };
}

function parseField(fb, fieldAbs) {
  if (fieldAbs === 0) return { name: null, nullable: true, typeStr: "NONE", typeTag: 0 };

  const nameField    = fb.field(fieldAbs, 0);  // name: string (slot 0)
  const nullField    = fb.field(fieldAbs, 1);  // nullable: bool
  const typeTypePos  = fb.field(fieldAbs, 2);  // type_type: uint8 (union tag)
  const typeField    = fb.field(fieldAbs, 3);  // type: union Table
  const childrenField= fb.field(fieldAbs, 4);  // children: [Field]
  const dictField    = fb.field(fieldAbs, 6);  // dictionary: DictionaryEncoding

  const name     = fb.string(nameField);
  const nullable = nullField !== 0 ? (fb.u8(nullField) !== 0) : true;
  const typeTag  = typeTypePos !== 0 ? fb.u8(typeTypePos) : 0;
  const typeAbs  = typeField  !== 0 ? (typeField + fb.i32(typeField)) : 0;
  const typeStr  = TYPE_NAMES[typeTag] || `Type_${typeTag}`;

  // Parse type-specific info
  let typeInfo = {};
  if (typeTag === FIELD_TYPE.INT && typeAbs !== 0) {
    const bitWidth = fb.fieldI32(typeAbs, 0); // Int.bitWidth
    const isSigned = fb.fieldBool(typeAbs, 1); // Int.is_signed
    typeInfo = { bitWidth: bitWidth || 32, isSigned };
  } else if (typeTag === FIELD_TYPE.FLOATING_POINT && typeAbs !== 0) {
    const prec = fb.fieldI8(typeAbs, 0); // FloatingPoint.precision
    typeInfo = { precision: FLOAT_PREC[prec] || `prec${prec}` };
  } else if (typeTag === FIELD_TYPE.DATE && typeAbs !== 0) {
    const unit = fb.fieldI8(typeAbs, 0); // Date.unit (0=DAY, 1=MILLISECOND)
    typeInfo = { unit: DATE_UNIT[unit] || "DAY" };
  } else if (typeTag === FIELD_TYPE.TIME && typeAbs !== 0) {
    const unit = fb.fieldI8(typeAbs, 0);
    typeInfo = { unit: TIME_UNIT[unit] || "MILLISECOND" };
  } else if (typeTag === FIELD_TYPE.TIMESTAMP && typeAbs !== 0) {
    const unit      = fb.fieldI8(typeAbs, 0); // Timestamp.unit
    const tzField   = fb.field(typeAbs, 1);    // Timestamp.timezone
    const timezone  = fb.string(tzField);
    typeInfo = { unit: TIME_UNIT[unit] || "MICROSECOND", timezone };
  } else if (typeTag === FIELD_TYPE.DURATION && typeAbs !== 0) {
    const unit = fb.fieldI8(typeAbs, 0);
    typeInfo = { unit: TIME_UNIT[unit] || "MILLISECOND" };
  } else if (typeTag === FIELD_TYPE.INTERVAL && typeAbs !== 0) {
    const unit = fb.fieldI8(typeAbs, 0);
    typeInfo = { unit: INTERVAL_UNITS[unit] || "DAY_TIME" };
  } else if (typeTag === FIELD_TYPE.DECIMAL && typeAbs !== 0) {
    const precision = fb.fieldI32(typeAbs, 0);
    const scale     = fb.fieldI32(typeAbs, 1);
    const bitWidth  = fb.fieldI32(typeAbs, 2) || 128;
    typeInfo = { precision, scale, bitWidth };
  } else if (typeTag === FIELD_TYPE.FIXED_SIZE_BINARY && typeAbs !== 0) {
    typeInfo = { byteWidth: fb.fieldI32(typeAbs, 0) };
  } else if (typeTag === FIELD_TYPE.FIXED_SIZE_LIST && typeAbs !== 0) {
    typeInfo = { listSize: fb.fieldI32(typeAbs, 0) };
  }

  // Parse children
  const children = [];
  if (childrenField !== 0) {
    const { length: numChildren } = fb.vector(childrenField);
    for (let i = 0; i < numChildren; i++) {
      const childAbs = fb.vectorTable(childrenField, i);
      children.push(parseField(fb, childAbs));
    }
  }

  // Dictionary encoding
  let dictionary = null;
  if (dictField !== 0) {
    const dictAbs  = dictField + fb.i32(dictField);
    const dictId   = fb.fieldI64(dictAbs, 0);
    dictionary = { id: dictId };
  }

  return { name, nullable, typeStr, typeTag, typeInfo, children, dictionary };
}

// ── Parse RecordBatch FlatBuffers message ─────────────────────────────────────
// RecordBatch { length: long, nodes: [FieldNode], buffers: [Buffer] }
// FieldNode { length: long, null_count: long }
// Buffer { offset: long, length: long }
function parseRecordBatch(fb, rbAbsPos) {
  const lengthPos  = fb.field(rbAbsPos, 0);
  const nodesField = fb.field(rbAbsPos, 1);
  const bufsField  = fb.field(rbAbsPos, 2);

  const length = lengthPos !== 0 ? fb.i64(lengthPos) : 0;

  // nodes: each FieldNode is 16 bytes (length:int64, null_count:int64)
  const { length: numNodes, dataStart: nodesStart } = fb.vector(nodesField);
  const nodes = [];
  for (let i = 0; i < numNodes; i++) {
    const pos = nodesStart + i * 16;
    nodes.push({
      length:    fb.i64(pos),
      nullCount: fb.i64(pos + 8),
    });
  }

  // buffers: each Buffer is 16 bytes (offset:int64, length:int64)
  const { length: numBufs, dataStart: bufsStart } = fb.vector(bufsField);
  const buffers = [];
  for (let i = 0; i < numBufs; i++) {
    const pos = bufsStart + i * 16;
    buffers.push({
      offset: fb.i64(pos),
      length: fb.i64(pos + 8),
    });
  }

  return { length, nodes, buffers };
}

// ── Parse a FlatBuffers Message ───────────────────────────────────────────────
// Message { version: int16, header_type: uint8, header: union, bodyLength: long }
const MSG_SCHEMA       = 1;
const MSG_DICT_BATCH   = 2;
const MSG_RECORD_BATCH = 3;

function parseMessage(buf, offset, len) {
  // Arrow FlatBuffers message: root table is at buf[offset]
  // The root offset is stored as a uint32 at the start
  const rootRelOff = buf.readUInt32LE(offset);
  const rootAbsPos = offset + rootRelOff;
  const fb = new FlatBuf(buf, 0);

  const versionField    = fb.field(rootAbsPos, 0);
  const headerTypeField = fb.field(rootAbsPos, 1);
  const headerField     = fb.field(rootAbsPos, 2);
  const bodyLenField    = fb.field(rootAbsPos, 3);

  const version    = versionField    !== 0 ? fb.u16(versionField)    : 3;
  const headerType = headerTypeField !== 0 ? fb.u8(headerTypeField)  : 0;
  const bodyLength = bodyLenField    !== 0 ? fb.i64(bodyLenField)    : 0;

  let header = null;
  if (headerField !== 0) {
    const headerAbs = headerField + fb.i32(headerField);
    if (headerType === MSG_SCHEMA) {
      header = parseSchema(fb, headerAbs);
    } else if (headerType === MSG_RECORD_BATCH) {
      header = parseRecordBatch(fb, headerAbs);
    } else if (headerType === MSG_DICT_BATCH) {
      // DictionaryBatch { id: long, data: RecordBatch, isDelta: bool }
      const idField   = fb.field(headerAbs, 0);
      const dataField = fb.field(headerAbs, 1);
      const id        = idField   !== 0 ? fb.i64(idField) : 0;
      const dataAbs   = dataField !== 0 ? (dataField + fb.i32(dataField)) : 0;
      header = { id, data: dataAbs !== 0 ? parseRecordBatch(fb, dataAbs) : null };
    }
  }

  return { version, headerType, bodyLength, header };
}

// ── Load Arrow file ───────────────────────────────────────────────────────────
function loadArrowFile(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.isDirectory())
    throw new ToolError(`arrow_client: '${filePath}' is a directory.`, -32602);
  if (stat.size > MAX_FILE_SIZE)
    throw new ToolError(`arrow_client: file too large (${stat.size} bytes; max ${MAX_FILE_SIZE}).`, -32602);

  const buf = fs.readFileSync(filePath);
  if (buf.length < ARROW_MAGIC_LEN + 2)
    throw new ToolError("arrow_client: file too small to be an Arrow IPC file.", -32602);

  // Check for Arrow IPC File format (has magic at start and end)
  const isFile = buf.slice(0, ARROW_MAGIC_LEN).equals(ARROW_MAGIC) &&
                 buf.slice(buf.length - ARROW_MAGIC_LEN).equals(ARROW_MAGIC);

  // Check for Arrow IPC Stream format (no magic, starts with continuation or message)
  const isStream = !isFile && (buf.length >= 8);

  if (!isFile && !isStream) {
    throw new ToolError("arrow_client: not a valid Arrow IPC file or stream.", -32602);
  }

  if (isFile) {
    return loadArrowIpcFile(buf, stat.size);
  } else {
    return loadArrowIpcStream(buf, stat.size);
  }
}

// ── Arrow IPC File (.arrow) loader ───────────────────────────────────────────
// Layout: ARROW1\0\0 [messages+bodies] ARROW1\0\0 footer_size(int32) ARROW1 ARROW1
// Actually: magic(6) padding(2) [message blocks] footer(N) footer_size(4) magic(6)
function loadArrowIpcFile(buf, fileSize) {
  // Footer size is stored as int32 at position (fileSize - 6 - 4)
  const footerSizePos = fileSize - ARROW_MAGIC_LEN - 4;
  const footerSize    = buf.readInt32LE(footerSizePos);
  if (footerSize <= 0 || footerSize > fileSize)
    throw new ToolError(`arrow_client: invalid Arrow file footer size ${footerSize}.`, -32602);

  const footerStart = footerSizePos - footerSize;
  if (footerStart < ARROW_MAGIC_LEN + 2)
    throw new ToolError("arrow_client: footer overlaps with header magic.", -32602);

  // Parse footer FlatBuffers:
  // Footer { version: int16, schema: Schema, dictionaries: [Block], recordBatches: [Block] }
  // Block: { offset: long, metaDataLength: int32, bodyLength: long } = 24 bytes each
  const footerRootOff = buf.readUInt32LE(footerStart);
  const footerRoot    = footerStart + footerRootOff;
  const fb            = new FlatBuf(buf, 0);

  const schemaField   = fb.field(footerRoot, 1);
  const dictBlocksF   = fb.field(footerRoot, 2);
  const rbBlocksF     = fb.field(footerRoot, 3);

  const schemaAbs = schemaField !== 0 ? (schemaField + fb.i32(schemaField)) : 0;
  const schema    = schemaAbs !== 0 ? parseSchema(fb, schemaAbs) : { endianness: "Little", fields: [] };

  // Record batch blocks
  const { length: numRbBlocks, dataStart: rbBlocksStart } = fb.vector(rbBlocksF);
  const rbBlocks = [];
  for (let i = 0; i < numRbBlocks; i++) {
    const pos = rbBlocksStart + i * 24;
    rbBlocks.push({
      offset:         fb.i64(pos),
      metaDataLength: buf.readInt32LE(pos + 8),
      bodyLength:     fb.i64(pos + 16),
    });
  }

  // Dictionary batch blocks
  const { length: numDictBlocks, dataStart: dictBlocksStart } = fb.vector(dictBlocksF);
  const dictBlocks = [];
  for (let i = 0; i < numDictBlocks; i++) {
    const pos = dictBlocksStart + i * 24;
    dictBlocks.push({
      offset:         fb.i64(pos),
      metaDataLength: buf.readInt32LE(pos + 8),
      bodyLength:     fb.i64(pos + 16),
    });
  }

  return { buf, schema, rbBlocks, dictBlocks, format: "file", fileSize };
}

// ── Arrow IPC Stream reader ───────────────────────────────────────────────────
// Layout: [continuation(4)? + metaLen(4) + meta(metaLen) + body(bodyLen)] repeated, then EOS
function loadArrowIpcStream(buf, fileSize) {
  let pos = 0;
  let schema = null;
  const rbBlocks  = [];
  const dictBlocks = [];

  while (pos < buf.length) {
    // Check for continuation marker (0xFFFFFFFF)
    const marker = buf.readUInt32LE(pos);
    if (marker === CONTINUATION) {
      pos += 4; // skip continuation marker
    }
    if (pos + 4 > buf.length) break;

    const metaLen = buf.readInt32LE(pos);
    pos += 4;
    if (metaLen === -1 || metaLen === 0) break; // EOS
    if (metaLen < 0 || pos + metaLen > buf.length) break;

    const msgStart = pos;
    const msg = parseMessage(buf, msgStart, metaLen);
    pos += metaLen;

    // Align to 8 bytes
    pos = Math.ceil(pos / 8) * 8;

    const bodyLen = msg.bodyLength;
    const bodyStart = pos;
    pos += bodyLen;
    // Align
    pos = Math.ceil(pos / 8) * 8;

    if (msg.headerType === MSG_SCHEMA) {
      schema = msg.header;
    } else if (msg.headerType === MSG_RECORD_BATCH) {
      rbBlocks.push({
        offset: bodyStart,
        metaDataLength: metaLen,
        bodyLength: bodyLen,
        _msg: msg, // cache parsed message for stream format
        _msgStart: msgStart,
      });
    } else if (msg.headerType === MSG_DICT_BATCH) {
      dictBlocks.push({
        offset: bodyStart,
        metaDataLength: metaLen,
        bodyLength: bodyLen,
        _msg: msg,
        _msgStart: msgStart,
      });
    }
  }

  if (!schema) {
    throw new ToolError("arrow_client: no schema found in Arrow IPC stream.", -32602);
  }

  return { buf, schema, rbBlocks, dictBlocks, format: "stream", fileSize };
}

// ── Read a record batch message from file ─────────────────────────────────────
function readRecordBatchFromBlock(fileData, block) {
  if (block._msg) {
    // Stream format: message was already parsed during load
    return { msg: block._msg, bodyOffset: block.offset };
  }
  // File format: read the message header from the block
  const { buf } = fileData;
  let pos = block.offset;

  // Check for continuation marker
  if (buf.readUInt32LE(pos) === CONTINUATION) pos += 4;

  const metaLen = buf.readInt32LE(pos);
  pos += 4;
  if (metaLen <= 0) return null;

  const msg = parseMessage(buf, pos, metaLen);
  pos += metaLen;
  // Align to 8
  pos = Math.ceil(pos / 8) * 8;

  return { msg, bodyOffset: pos };
}

// ── Column array decoding ─────────────────────────────────────────────────────
//
// Each Arrow column is stored as a sequence of buffers:
//   [validity_bitmap, data_buffer, offsets_buffer?, ...]
// The buffer layout depends on column type.
//
// bufIdx tracks which buffer in the RecordBatch's buffer list we're consuming.
//
function decodeColumn(field, buf, bodyOffset, rb, nodeIdx, bufIdx, dictArrays) {
  const node   = rb.nodes[nodeIdx] || { length: 0, nullCount: 0 };
  const length = node.length;
  const nullCount = node.nullCount;

  // Get validity buffer (null bitmap)
  let validityBuf = null;
  const valBufInfo = rb.buffers[bufIdx];
  bufIdx++;
  if (nullCount > 0 && valBufInfo && valBufInfo.length > 0) {
    validityBuf = buf.slice(bodyOffset + valBufInfo.offset, bodyOffset + valBufInfo.offset + valBufInfo.length);
  }

  function isValid(i) {
    if (!validityBuf) return true;
    const byteIdx = i >> 3;
    const bitIdx  = i & 7;
    if (byteIdx >= validityBuf.length) return true;
    return ((validityBuf[byteIdx] >> bitIdx) & 1) !== 0;
  }

  const typeTag = field.typeTag;
  const typeInfo = field.typeInfo || {};

  // Dictionary-encoded column
  if (field.dictionary !== null && field.dictionary !== undefined) {
    // indices are INT32 by default
    const dataBufInfo = rb.buffers[bufIdx];
    bufIdx++;
    const dict = dictArrays[field.dictionary.id] || [];
    const values = [];
    if (dataBufInfo && dataBufInfo.length > 0) {
      const dataBuf = buf.slice(bodyOffset + dataBufInfo.offset, bodyOffset + dataBufInfo.offset + dataBufInfo.length);
      for (let i = 0; i < length; i++) {
        if (!isValid(i)) { values.push(null); continue; }
        const idx = dataBuf.readInt32LE(i * 4);
        values.push(dict[idx] !== undefined ? dict[idx] : null);
      }
    }
    return { values, bufIdx, nodeIdx: nodeIdx + 1 };
  }

  // Null type
  if (typeTag === FIELD_TYPE.NULL) {
    return { values: new Array(length).fill(null), bufIdx, nodeIdx: nodeIdx + 1 };
  }

  // Boolean
  if (typeTag === FIELD_TYPE.BOOL) {
    const dataBufInfo = rb.buffers[bufIdx];
    bufIdx++;
    const values = [];
    if (dataBufInfo && dataBufInfo.length > 0) {
      const dataBuf = buf.slice(bodyOffset + dataBufInfo.offset, bodyOffset + dataBufInfo.offset + dataBufInfo.length);
      for (let i = 0; i < length; i++) {
        if (!isValid(i)) { values.push(null); continue; }
        values.push(((dataBuf[i >> 3] >> (i & 7)) & 1) !== 0);
      }
    } else {
      for (let i = 0; i < length; i++) values.push(null);
    }
    return { values, bufIdx, nodeIdx: nodeIdx + 1 };
  }

  // Int types
  if (typeTag === FIELD_TYPE.INT) {
    const dataBufInfo = rb.buffers[bufIdx];
    bufIdx++;
    const { bitWidth = 32, isSigned = true } = typeInfo;
    const byteWidth = bitWidth / 8;
    const values = [];
    if (dataBufInfo && dataBufInfo.length > 0) {
      const dataBuf = buf.slice(bodyOffset + dataBufInfo.offset, bodyOffset + dataBufInfo.offset + dataBufInfo.length);
      for (let i = 0; i < length; i++) {
        if (!isValid(i)) { values.push(null); continue; }
        const off = i * byteWidth;
        if (bitWidth === 8)  { values.push(isSigned ? dataBuf.readInt8(off)   : dataBuf.readUInt8(off)); }
        else if (bitWidth === 16) { values.push(isSigned ? dataBuf.readInt16LE(off) : dataBuf.readUInt16LE(off)); }
        else if (bitWidth === 32) { values.push(isSigned ? dataBuf.readInt32LE(off) : dataBuf.readUInt32LE(off)); }
        else if (bitWidth === 64) {
          // Read as BigInt for accuracy, but return as number if safe
          const lo = dataBuf.readUInt32LE(off);
          const hi = isSigned ? dataBuf.readInt32LE(off + 4) : dataBuf.readUInt32LE(off + 4);
          const big = isSigned
            ? (BigInt(hi) << 32n) | BigInt(lo)
            : (BigInt(hi >>> 0) << 32n) | BigInt(lo);
          // Return as number if in safe integer range, else as string
          const num = Number(big);
          values.push(Number.isSafeInteger(num) ? num : big.toString());
        }
        else { values.push(null); }
      }
    } else {
      for (let i = 0; i < length; i++) values.push(null);
    }
    return { values, bufIdx, nodeIdx: nodeIdx + 1 };
  }

  // Floating point
  if (typeTag === FIELD_TYPE.FLOATING_POINT) {
    const dataBufInfo = rb.buffers[bufIdx];
    bufIdx++;
    const { precision = "DOUBLE" } = typeInfo;
    const values = [];
    if (dataBufInfo && dataBufInfo.length > 0) {
      const dataBuf = buf.slice(bodyOffset + dataBufInfo.offset, bodyOffset + dataBufInfo.offset + dataBufInfo.length);
      for (let i = 0; i < length; i++) {
        if (!isValid(i)) { values.push(null); continue; }
        if (precision === "SINGLE") values.push(dataBuf.readFloatLE(i * 4));
        else if (precision === "HALF") {
          // IEEE 754 half-precision
          const h = dataBuf.readUInt16LE(i * 2);
          values.push(halfToFloat(h));
        }
        else values.push(dataBuf.readDoubleLE(i * 8));
      }
    } else {
      for (let i = 0; i < length; i++) values.push(null);
    }
    return { values, bufIdx, nodeIdx: nodeIdx + 1 };
  }

  // Utf8 / Binary (32-bit offsets)
  if (typeTag === FIELD_TYPE.UTF8 || typeTag === FIELD_TYPE.BINARY) {
    const offBufInfo  = rb.buffers[bufIdx];     bufIdx++;
    const dataBufInfo = rb.buffers[bufIdx];     bufIdx++;
    const values = [];
    if (offBufInfo && dataBufInfo && offBufInfo.length > 0) {
      const offBuf  = buf.slice(bodyOffset + offBufInfo.offset,  bodyOffset + offBufInfo.offset  + offBufInfo.length);
      const dataBuf = buf.slice(bodyOffset + dataBufInfo.offset, bodyOffset + dataBufInfo.offset + dataBufInfo.length);
      for (let i = 0; i < length; i++) {
        if (!isValid(i)) { values.push(null); continue; }
        const start = offBuf.readUInt32LE(i * 4);
        const end   = offBuf.readUInt32LE((i + 1) * 4);
        const slice = dataBuf.slice(start, end);
        values.push(typeTag === FIELD_TYPE.UTF8 ? slice.toString("utf8") : slice.toString("base64"));
      }
    } else {
      for (let i = 0; i < length; i++) values.push(null);
    }
    return { values, bufIdx, nodeIdx: nodeIdx + 1 };
  }

  // LargeUtf8 / LargeBinary (64-bit offsets)
  if (typeTag === FIELD_TYPE.LARGE_UTF8 || typeTag === FIELD_TYPE.LARGE_BINARY) {
    const offBufInfo  = rb.buffers[bufIdx];     bufIdx++;
    const dataBufInfo = rb.buffers[bufIdx];     bufIdx++;
    const values = [];
    if (offBufInfo && dataBufInfo && offBufInfo.length > 0) {
      const offBuf  = buf.slice(bodyOffset + offBufInfo.offset,  bodyOffset + offBufInfo.offset  + offBufInfo.length);
      const dataBuf = buf.slice(bodyOffset + dataBufInfo.offset, bodyOffset + dataBufInfo.offset + dataBufInfo.length);
      for (let i = 0; i < length; i++) {
        if (!isValid(i)) { values.push(null); continue; }
        const start = Number(offBuf.readBigInt64LE(i * 8));
        const end   = Number(offBuf.readBigInt64LE((i + 1) * 8));
        const slice = dataBuf.slice(start, end);
        values.push(typeTag === FIELD_TYPE.LARGE_UTF8 ? slice.toString("utf8") : slice.toString("base64"));
      }
    } else {
      for (let i = 0; i < length; i++) values.push(null);
    }
    return { values, bufIdx, nodeIdx: nodeIdx + 1 };
  }

  // Fixed-size binary
  if (typeTag === FIELD_TYPE.FIXED_SIZE_BINARY) {
    const dataBufInfo = rb.buffers[bufIdx];
    bufIdx++;
    const byteWidth = typeInfo.byteWidth || 1;
    const values = [];
    if (dataBufInfo && dataBufInfo.length > 0) {
      const dataBuf = buf.slice(bodyOffset + dataBufInfo.offset, bodyOffset + dataBufInfo.offset + dataBufInfo.length);
      for (let i = 0; i < length; i++) {
        if (!isValid(i)) { values.push(null); continue; }
        values.push(dataBuf.slice(i * byteWidth, (i + 1) * byteWidth).toString("base64"));
      }
    } else {
      for (let i = 0; i < length; i++) values.push(null);
    }
    return { values, bufIdx, nodeIdx: nodeIdx + 1 };
  }

  // Date (days or milliseconds since epoch)
  if (typeTag === FIELD_TYPE.DATE) {
    const dataBufInfo = rb.buffers[bufIdx];
    bufIdx++;
    const unit = typeInfo.unit || "DAY";
    const byteWidth = unit === "DAY" ? 4 : 8;
    const values = [];
    if (dataBufInfo && dataBufInfo.length > 0) {
      const dataBuf = buf.slice(bodyOffset + dataBufInfo.offset, bodyOffset + dataBufInfo.offset + dataBufInfo.length);
      for (let i = 0; i < length; i++) {
        if (!isValid(i)) { values.push(null); continue; }
        let ms;
        if (unit === "DAY") {
          ms = dataBuf.readInt32LE(i * 4) * 86400000;
        } else {
          ms = Number(dataBuf.readBigInt64LE(i * 8));
        }
        values.push(new Date(ms).toISOString().slice(0, 10));
      }
    } else {
      for (let i = 0; i < length; i++) values.push(null);
    }
    return { values, bufIdx, nodeIdx: nodeIdx + 1 };
  }

  // Timestamp
  if (typeTag === FIELD_TYPE.TIMESTAMP || typeTag === FIELD_TYPE.DURATION) {
    const dataBufInfo = rb.buffers[bufIdx];
    bufIdx++;
    const unit = typeInfo.unit || "MICROSECOND";
    const values = [];
    if (dataBufInfo && dataBufInfo.length > 0) {
      const dataBuf = buf.slice(bodyOffset + dataBufInfo.offset, bodyOffset + dataBufInfo.offset + dataBufInfo.length);
      for (let i = 0; i < length; i++) {
        if (!isValid(i)) { values.push(null); continue; }
        const raw = Number(dataBuf.readBigInt64LE(i * 8));
        let ms;
        if (unit === "SECOND")      ms = raw * 1000;
        else if (unit === "MILLISECOND") ms = raw;
        else if (unit === "MICROSECOND") ms = raw / 1000;
        else /* NANOSECOND */            ms = raw / 1_000_000;
        if (typeTag === FIELD_TYPE.DURATION) {
          values.push(raw); // return raw value for durations
        } else {
          values.push(new Date(ms).toISOString());
        }
      }
    } else {
      for (let i = 0; i < length; i++) values.push(null);
    }
    return { values, bufIdx, nodeIdx: nodeIdx + 1 };
  }

  // Time32 / Time64
  if (typeTag === FIELD_TYPE.TIME) {
    const dataBufInfo = rb.buffers[bufIdx];
    bufIdx++;
    const unit = typeInfo.unit || "MILLISECOND";
    const isTime64 = unit === "MICROSECOND" || unit === "NANOSECOND";
    const values = [];
    if (dataBufInfo && dataBufInfo.length > 0) {
      const dataBuf = buf.slice(bodyOffset + dataBufInfo.offset, bodyOffset + dataBufInfo.offset + dataBufInfo.length);
      for (let i = 0; i < length; i++) {
        if (!isValid(i)) { values.push(null); continue; }
        const raw = isTime64
          ? Number(dataBuf.readBigInt64LE(i * 8))
          : dataBuf.readInt32LE(i * 4);
        values.push(formatTime(raw, unit));
      }
    } else {
      for (let i = 0; i < length; i++) values.push(null);
    }
    return { values, bufIdx, nodeIdx: nodeIdx + 1 };
  }

  // Decimal (128 or 256 bit — stored as fixed bytes, return as string)
  if (typeTag === FIELD_TYPE.DECIMAL) {
    const dataBufInfo = rb.buffers[bufIdx];
    bufIdx++;
    const byteWidth = (typeInfo.bitWidth || 128) / 8;
    const scale = typeInfo.scale || 0;
    const values = [];
    if (dataBufInfo && dataBufInfo.length > 0) {
      const dataBuf = buf.slice(bodyOffset + dataBufInfo.offset, bodyOffset + dataBufInfo.offset + dataBufInfo.length);
      for (let i = 0; i < length; i++) {
        if (!isValid(i)) { values.push(null); continue; }
        // Read as little-endian BigInt
        const slice = dataBuf.slice(i * byteWidth, (i + 1) * byteWidth);
        let val = 0n;
        for (let b = byteWidth - 1; b >= 0; b--) val = (val << 8n) | BigInt(slice[b]);
        // Two's complement sign extension
        const signBit = 1n << BigInt(byteWidth * 8 - 1);
        if (val & signBit) val = val - (1n << BigInt(byteWidth * 8));
        if (scale === 0) {
          const num = Number(val);
          values.push(Number.isSafeInteger(num) ? num : val.toString());
        } else {
          // Format as decimal string with scale
          const absVal = val < 0n ? -val : val;
          const str    = absVal.toString().padStart(scale + 1, "0");
          const intPart = str.slice(0, str.length - scale) || "0";
          const decPart = str.slice(str.length - scale);
          values.push((val < 0n ? "-" : "") + intPart + (scale > 0 ? "." + decPart : ""));
        }
      }
    } else {
      for (let i = 0; i < length; i++) values.push(null);
    }
    return { values, bufIdx, nodeIdx: nodeIdx + 1 };
  }

  // List (variable-length list, 32-bit offsets)
  if (typeTag === FIELD_TYPE.LIST) {
    const offBufInfo = rb.buffers[bufIdx];
    bufIdx++;
    nodeIdx++; // skip this node; children have their own nodes
    const child = field.children[0];
    if (!child || !offBufInfo) {
      return { values: new Array(length).fill(null), bufIdx, nodeIdx };
    }
    const offBuf = buf.slice(bodyOffset + offBufInfo.offset, bodyOffset + offBufInfo.offset + offBufInfo.length);
    // total child elements = last offset
    const totalChildren = offBufInfo.length >= (length + 1) * 4
      ? offBuf.readUInt32LE(length * 4)
      : 0;
    // Build a fake child rb with totalChildren rows
    const childRb = buildChildRb(rb.nodes, rb.buffers, nodeIdx, totalChildren);
    const childResult = decodeColumn(child, buf, bodyOffset, childRb.rb, childRb.nodeIdx, bufIdx, dictArrays);
    const childVals = childResult.values;
    bufIdx = childResult.bufIdx;
    nodeIdx = childResult.nodeIdx;
    const values = [];
    for (let i = 0; i < length; i++) {
      if (!isValid(i)) { values.push(null); continue; }
      const start = offBuf.readUInt32LE(i * 4);
      const end   = offBuf.readUInt32LE((i + 1) * 4);
      values.push(childVals.slice(start, end));
    }
    return { values, bufIdx, nodeIdx };
  }

  // LargeList (64-bit offsets)
  if (typeTag === FIELD_TYPE.LARGE_LIST) {
    const offBufInfo = rb.buffers[bufIdx];
    bufIdx++;
    nodeIdx++;
    const child = field.children[0];
    if (!child || !offBufInfo) {
      return { values: new Array(length).fill(null), bufIdx, nodeIdx };
    }
    const offBuf = buf.slice(bodyOffset + offBufInfo.offset, bodyOffset + offBufInfo.offset + offBufInfo.length);
    const totalChildren = offBufInfo.length >= (length + 1) * 8
      ? Number(offBuf.readBigInt64LE(length * 8))
      : 0;
    const childRb = buildChildRb(rb.nodes, rb.buffers, nodeIdx, totalChildren);
    const childResult = decodeColumn(child, buf, bodyOffset, childRb.rb, childRb.nodeIdx, bufIdx, dictArrays);
    const childVals = childResult.values;
    bufIdx = childResult.bufIdx;
    nodeIdx = childResult.nodeIdx;
    const values = [];
    for (let i = 0; i < length; i++) {
      if (!isValid(i)) { values.push(null); continue; }
      const start = Number(offBuf.readBigInt64LE(i * 8));
      const end   = Number(offBuf.readBigInt64LE((i + 1) * 8));
      values.push(childVals.slice(start, end));
    }
    return { values, bufIdx, nodeIdx };
  }

  // FixedSizeList
  if (typeTag === FIELD_TYPE.FIXED_SIZE_LIST) {
    const listSize = typeInfo.listSize || 1;
    nodeIdx++; // skip this node
    const child = field.children[0];
    if (!child) {
      return { values: new Array(length).fill(null), bufIdx, nodeIdx };
    }
    const totalChildren = length * listSize;
    const childRb = buildChildRb(rb.nodes, rb.buffers, nodeIdx, totalChildren);
    const childResult = decodeColumn(child, buf, bodyOffset, childRb.rb, childRb.nodeIdx, bufIdx, dictArrays);
    const childVals = childResult.values;
    bufIdx = childResult.bufIdx;
    nodeIdx = childResult.nodeIdx;
    const values = [];
    for (let i = 0; i < length; i++) {
      if (!isValid(i)) { values.push(null); continue; }
      values.push(childVals.slice(i * listSize, (i + 1) * listSize));
    }
    return { values, bufIdx, nodeIdx };
  }

  // Struct
  if (typeTag === FIELD_TYPE.STRUCT) {
    nodeIdx++; // advance past struct node
    const childResults = {};
    for (const child of field.children) {
      const cr = decodeColumn(child, buf, bodyOffset, rb, nodeIdx, bufIdx, dictArrays);
      childResults[child.name] = cr.values;
      bufIdx = cr.bufIdx;
      nodeIdx = cr.nodeIdx;
    }
    const values = [];
    for (let i = 0; i < length; i++) {
      if (!isValid(i)) { values.push(null); continue; }
      const obj = {};
      for (const [k, v] of Object.entries(childResults)) obj[k] = v[i] ?? null;
      values.push(obj);
    }
    return { values, bufIdx, nodeIdx };
  }

  // Map (list of key+value structs)
  if (typeTag === FIELD_TYPE.MAP) {
    const offBufInfo = rb.buffers[bufIdx];
    bufIdx++;
    nodeIdx++;
    const entryField = field.children[0]; // 'entries' struct child
    if (!entryField || !offBufInfo) {
      return { values: new Array(length).fill(null), bufIdx, nodeIdx };
    }
    const offBuf = buf.slice(bodyOffset + offBufInfo.offset, bodyOffset + offBufInfo.offset + offBufInfo.length);
    const totalChildren = offBufInfo.length >= (length + 1) * 4
      ? offBuf.readUInt32LE(length * 4) : 0;
    const childRb = buildChildRb(rb.nodes, rb.buffers, nodeIdx, totalChildren);
    const childResult = decodeColumn(entryField, buf, bodyOffset, childRb.rb, childRb.nodeIdx, bufIdx, dictArrays);
    const entryVals = childResult.values; // array of {key, value} objects
    bufIdx = childResult.bufIdx;
    nodeIdx = childResult.nodeIdx;
    const values = [];
    for (let i = 0; i < length; i++) {
      if (!isValid(i)) { values.push(null); continue; }
      const start = offBuf.readUInt32LE(i * 4);
      const end   = offBuf.readUInt32LE((i + 1) * 4);
      const obj = {};
      for (let j = start; j < end; j++) {
        const entry = entryVals[j];
        if (entry) obj[String(entry.key)] = entry.value;
      }
      values.push(obj);
    }
    return { values, bufIdx, nodeIdx };
  }

  // Union (not fully implemented — skip buffers)
  if (typeTag === FIELD_TYPE.UNION) {
    bufIdx++; // type ids buffer
    bufIdx++; // offsets buffer (dense union)
    nodeIdx++;
    return { values: new Array(length).fill(null), bufIdx, nodeIdx };
  }

  // Interval
  if (typeTag === FIELD_TYPE.INTERVAL) {
    const dataBufInfo = rb.buffers[bufIdx];
    bufIdx++;
    const values = [];
    if (dataBufInfo && dataBufInfo.length > 0) {
      const dataBuf = buf.slice(bodyOffset + dataBufInfo.offset, bodyOffset + dataBufInfo.offset + dataBufInfo.length);
      const byteWidth = typeInfo.unit === "YEAR_MONTH" ? 4 : typeInfo.unit === "MONTH_DAY_NANO" ? 16 : 8;
      for (let i = 0; i < length; i++) {
        if (!isValid(i)) { values.push(null); continue; }
        if (byteWidth === 4) values.push(dataBuf.readInt32LE(i * 4));
        else if (byteWidth === 8) values.push({ days: dataBuf.readInt32LE(i * 8), ms: dataBuf.readInt32LE(i * 8 + 4) });
        else values.push(dataBuf.slice(i * 16, i * 16 + 16).toString("base64"));
      }
    } else {
      for (let i = 0; i < length; i++) values.push(null);
    }
    return { values, bufIdx, nodeIdx: nodeIdx + 1 };
  }

  // Fallback: skip one buffer
  bufIdx++;
  return { values: new Array(length).fill(null), bufIdx, nodeIdx: nodeIdx + 1 };
}

// Build a minimal RecordBatch wrapper for child column decoding
function buildChildRb(nodes, buffers, nodeIdx, length) {
  return {
    rb: { length, nodes, buffers },
    nodeIdx,
  };
}

// ── Half-precision float decoder ──────────────────────────────────────────────
function halfToFloat(h) {
  const s = (h >> 15) & 1;
  const e = (h >> 10) & 0x1F;
  const m =  h        & 0x3FF;
  if (e === 0)   return (s ? -1 : 1) * Math.pow(2, -14) * (m / 1024);
  if (e === 31)  return m ? NaN : (s ? -Infinity : Infinity);
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + m / 1024);
}

// ── Time formatter ────────────────────────────────────────────────────────────
function formatTime(raw, unit) {
  let totalSeconds;
  if (unit === "SECOND")      totalSeconds = raw;
  else if (unit === "MILLISECOND") totalSeconds = raw / 1000;
  else if (unit === "MICROSECOND") totalSeconds = raw / 1_000_000;
  else /* NANOSECOND */            totalSeconds = raw / 1_000_000_000;
  const h   = Math.floor(totalSeconds / 3600);
  const m   = Math.floor((totalSeconds % 3600) / 60);
  const s   = Math.floor(totalSeconds % 60);
  const frac = totalSeconds - Math.floor(totalSeconds);
  let str = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  if (frac > 0) str += (frac.toFixed(9)).slice(1).replace(/0+$/, "");
  return str;
}

// ── Decode all columns for a single RecordBatch ──────────────────────────────
function decodeRecordBatch(fileData, block, schemaFields, dictArrays) {
  const { buf } = fileData;
  const result = readRecordBatchFromBlock(fileData, block);
  if (!result) return { rows: [], numRows: 0 };

  const { msg, bodyOffset } = result;
  if (msg.headerType !== MSG_RECORD_BATCH) return { rows: [], numRows: 0 };

  const rb      = msg.header;  // { length, nodes, buffers }
  const numRows = rb.length;
  if (numRows === 0) return { rows: [], numRows: 0 };

  let nodeIdx = 0;
  let bufIdx  = 0;
  const columnArrays = {};

  for (const field of schemaFields) {
    try {
      const result = decodeColumn(field, buf, bodyOffset, rb, nodeIdx, bufIdx, dictArrays);
      columnArrays[field.name] = result.values;
      nodeIdx = result.nodeIdx;
      bufIdx  = result.bufIdx;
    } catch (e) {
      columnArrays[field.name] = new Array(numRows).fill(null);
      // advance bufIdx/nodeIdx best-effort
      nodeIdx++;
      bufIdx++;
    }
  }

  const rows = [];
  for (let i = 0; i < numRows; i++) {
    const row = {};
    for (const field of schemaFields) {
      const col = columnArrays[field.name];
      row[field.name] = col ? (col[i] ?? null) : null;
    }
    rows.push(row);
  }
  return { rows, numRows, columnArrays };
}

// ── Decode dictionary batches ─────────────────────────────────────────────────
function buildDictArrays(fileData, schemaFields) {
  const { buf, dictBlocks } = fileData;
  const dictArrays = {};

  // Find all dictionary-encoded fields
  const dictFields = collectDictFields(schemaFields);

  for (const block of dictBlocks) {
    let result;
    if (block._msg) {
      result = { msg: block._msg, bodyOffset: block.offset };
    } else {
      // File format
      let pos = block.offset;
      if (buf.readUInt32LE(pos) === CONTINUATION) pos += 4;
      const metaLen = buf.readInt32LE(pos); pos += 4;
      if (metaLen <= 0) continue;
      const msg = parseMessage(buf, pos, metaLen);
      pos += metaLen;
      pos = Math.ceil(pos / 8) * 8;
      result = { msg, bodyOffset: pos };
    }

    const { msg, bodyOffset } = result;
    if (msg.headerType !== MSG_DICT_BATCH || !msg.header) continue;

    const dictBatch = msg.header;
    const dictId    = dictBatch.id;
    const rb        = dictBatch.data;
    if (!rb) continue;

    // Find the field for this dictionary ID
    const dictField = dictFields[dictId];
    if (!dictField) continue;

    // Decode the dictionary values column
    try {
      const fakeField = { ...dictField, dictionary: null };
      const result = decodeColumn(fakeField, buf, bodyOffset, rb, 0, 0, {});
      dictArrays[dictId] = result.values;
    } catch (e) {
      dictArrays[dictId] = [];
    }
  }

  return dictArrays;
}

function collectDictFields(fields, out) {
  out = out || {};
  for (const f of fields) {
    if (f.dictionary !== null && f.dictionary !== undefined) {
      out[f.dictionary.id] = f;
    }
    if (f.children && f.children.length) collectDictFields(f.children, out);
  }
  return out;
}

// ── Schema description ────────────────────────────────────────────────────────
function describeField(field) {
  const info = { name: field.name, nullable: field.nullable, type: field.typeStr };
  if (field.typeInfo && Object.keys(field.typeInfo).length > 0) {
    Object.assign(info, field.typeInfo);
  }
  if (field.dictionary !== null && field.dictionary !== undefined) {
    info.dictionaryId = field.dictionary.id;
    info.type += " (dictionary-encoded)";
  }
  if (field.children && field.children.length > 0) {
    info.children = field.children.map(describeField);
  }
  return info;
}

// ── Operations ────────────────────────────────────────────────────────────────

function opInfo(args, resolved) {
  const fileData = loadArrowFile(resolved);
  const { schema, rbBlocks, dictBlocks, format, fileSize } = fileData;
  const stat = fs.statSync(resolved);

  // Count total rows by reading each batch header
  let totalRows = 0;
  for (const block of rbBlocks) {
    try {
      const r = readRecordBatchFromBlock(fileData, block);
      if (r && r.msg && r.msg.header) totalRows += r.msg.header.length || 0;
    } catch (_) {}
  }

  return {
    path:          args.path,
    format:        format === "file" ? "IPC File" : "IPC Stream",
    fileSizeBytes: stat.size,
    numColumns:    schema.fields.length,
    numBatches:    rbBlocks.length,
    numDictBatches: dictBlocks.length,
    totalRows,
    endianness:    schema.endianness,
    schema:        schema.fields.map(describeField),
  };
}

function opSchema(args, resolved) {
  const fileData = loadArrowFile(resolved);
  const { schema } = fileData;
  return {
    path:       args.path,
    numColumns: schema.fields.length,
    endianness: schema.endianness,
    columns:    schema.fields.map(describeField),
  };
}

function opRead(args, resolved) {
  const fileData  = loadArrowFile(resolved);
  const { schema, rbBlocks } = fileData;
  const dictArrays = buildDictArrays(fileData, schema.fields);

  const colFilter = args.columns && args.columns.length > 0 ? new Set(args.columns) : null;
  const filteredFields = colFilter
    ? schema.fields.filter(f => colFilter.has(f.name))
    : schema.fields;

  const targetOffset = args.offset || 0;
  const limitArg     = args.limit || MAX_ROWS;
  const allRows = [];
  let   skipped = 0;

  for (const block of rbBlocks) {
    if (allRows.length >= limitArg) break;
    let batchResult;
    try {
      batchResult = decodeRecordBatch(fileData, block, filteredFields, dictArrays);
    } catch (e) {
      continue;
    }
    const { rows, numRows } = batchResult;
    // Skip rows for offset
    if (skipped + numRows <= targetOffset) {
      skipped += numRows;
      continue;
    }
    const batchStart = Math.max(0, targetOffset - skipped);
    skipped += numRows;
    for (let i = batchStart; i < rows.length && allRows.length < limitArg; i++) {
      allRows.push(rows[i]);
    }
  }

  return {
    path:         args.path,
    numBatches:   rbBlocks.length,
    offset:       targetOffset,
    returnedRows: allRows.length,
    columns:      filteredFields.map(f => f.name),
    rows:         allRows,
  };
}

function opToJson(args, resolved) {
  if (args.output_file && args.output_file.includes("\0"))
    throw new ToolError("arrow_client: NUL byte in output_file.", -32602);
  const result = opRead(args, resolved);
  const json   = JSON.stringify(result.rows, null, args.pretty ? 2 : undefined);
  if (args.output_file) {
    const outPath = args.output_file;
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(outPath, json, "utf8");
    return { path: args.path, outputFile: outPath, writtenRows: result.rows.length, sizeBytes: Buffer.byteLength(json) };
  }
  return { path: args.path, returnedRows: result.rows.length, json };
}

function opToCsv(args, resolved) {
  if (args.output_file && args.output_file.includes("\0"))
    throw new ToolError("arrow_client: NUL byte in output_file.", -32602);
  const result  = opRead(args, resolved);
  const rows    = result.rows;
  const columns = result.columns;
  const sep     = args.separator || ",";

  function esc(val) {
    if (val === null || val === undefined) return "";
    if (typeof val === "object") return esc(JSON.stringify(val));
    const s = String(val);
    return (s.includes(sep) || s.includes('"') || s.includes("\n"))
      ? '"' + s.replace(/"/g, '""') + '"'
      : s;
  }

  const lines = [columns.map(esc).join(sep)];
  for (const row of rows) lines.push(columns.map(c => esc(row[c])).join(sep));
  const csv = lines.join("\n");

  if (args.output_file) {
    const outPath = args.output_file;
    fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
    fs.writeFileSync(outPath, csv, "utf8");
    return { path: args.path, outputFile: outPath, writtenRows: rows.length, sizeBytes: Buffer.byteLength(csv) };
  }
  return { path: args.path, returnedRows: rows.length, csv };
}

// ── Public API ────────────────────────────────────────────────────────────────
function arrowClient(args, resolveClientPath) {
  if (!args.operation) throw new ToolError("arrow_client: 'operation' is required.", -32602);
  if (!args.path)      throw new ToolError("arrow_client: 'path' is required.", -32602);
  if (args.path.includes("\0")) throw new ToolError("arrow_client: NUL byte in path.", -32602);

  const { resolved } = resolveClientPath(args.path);
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) throw new ToolError(`arrow_client: '${args.path}' is a directory.`, -32602);

  switch (args.operation) {
    case "info":    return opInfo(args, resolved);
    case "schema":  return opSchema(args, resolved);
    case "read":    return opRead(args, resolved);
    case "to_json": return opToJson(args, resolved);
    case "to_csv":  return opToCsv(args, resolved);
    default:
      throw new ToolError(
        `arrow_client: unknown operation '${args.operation}'. Valid: info, schema, read, to_json, to_csv.`,
        -32602,
      );
  }
}

module.exports = {
  arrowClient,
  // Export internals for testing
  FlatBuf,
  parseSchema,
  parseField,
  parseRecordBatch,
  parseMessage,
  halfToFloat,
  decodeColumn,
  buildDictArrays,
  describeField,
};
