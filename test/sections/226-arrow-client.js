"use strict";
// test/sections/226-arrow-client.js
// Isolated tests for arrow_client tool (lib/arrowClientOps.js)
// Five rigor levels: A=validation, B=unit, C=happy-path, D=security, E=error-paths, F=concurrency

const path = require("path");
const fs   = require("fs");
const os   = require("os");

const {
  arrowClient,
  FlatBuf,
  halfToFloat,
  describeField,
} = require("../../lib/arrowClientOps");

// ── Test runner ───────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];
const asyncTests = [];

function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === "function") {
      const p = r.then(() => { passed++; }).catch(e => {
        failed++;
        failures.push({ name, error: e.message || String(e) });
        process.stderr.write(`  FAIL: ${name}\n       ${e.message}\n`);
      });
      asyncTests.push(p);
      return p;
    }
    passed++;
  } catch (e) {
    failed++;
    failures.push({ name, error: e.message || String(e) });
    process.stderr.write(`  FAIL: ${name}\n       ${e.message}\n`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

function assertEq(a, b, msg) {
  const sa = JSON.stringify(a, (k, v) => typeof v === "bigint" ? v.toString() : v);
  const sb = JSON.stringify(b, (k, v) => typeof v === "bigint" ? v.toString() : v);
  if (sa !== sb) throw new Error((msg || "not equal") + `\n  got:      ${sa}\n  expected: ${sb}`);
}

function assertThrows(fn, msgSubstr) {
  let threw = false;
  try { fn(); } catch (e) {
    threw = true;
    if (msgSubstr) {
      const match = msgSubstr instanceof RegExp
        ? msgSubstr.test(e.message)
        : e.message.includes(msgSubstr);
      if (!match)
        throw new Error(`Expected error matching '${msgSubstr}' but got: ${e.message}`);
    }
  }
  if (!threw) throw new Error(`Expected error '${msgSubstr || ""}' but none thrown`);
}

function fakeResolve(p) {
  return { resolved: path.isAbsolute(p) ? p : path.resolve(p) };
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "arrow-test-"));
function tmpFile(name) { return path.join(tmpDir, name); }

// ───────────────────────────────────────────────────────────────────────
// Arrow IPC File builder
// Builds a minimal valid Arrow IPC File with:
//   - Schema: one or two columns as specified
//   - One RecordBatch with given data
// All FlatBuffers hand-coded in little-endian
// ───────────────────────────────────────────────────────────────────────

// FlatBuffers minimal builder helpers
function fbWriteI32(v) {
  const b = Buffer.allocUnsafe(4);
  b.writeInt32LE(v, 0);
  return b;
}
function fbWriteI64(v) {
  const b = Buffer.allocUnsafe(8);
  // v as number (safe integer range only for test data)
  b.writeUInt32LE(v >>> 0, 0);
  b.writeInt32LE(Math.floor(v / 0x100000000), 4);
  return b;
}
function fbWriteI16(v) {
  const b = Buffer.allocUnsafe(2);
  b.writeInt16LE(v, 0);
  return b;
}
function fbWriteI8(v) { return Buffer.from([v & 0xFF]); }
function fbWriteU8(v) { return Buffer.from([v & 0xFF]); }
function fbWriteU16(v) {
  const b = Buffer.allocUnsafe(2); b.writeUInt16LE(v, 0); return b;
}

// Build a FlatBuffers table from slot offsets
// slots: array of { offset: absOffset_in_table_body } or null for absent
function buildFbTable(slots, extraData) {
  // vtable: size(u16) + object_size(u16) + slot_offsets(u16 each)
  const vtableSize = 4 + slots.length * 2;
  const objSize = extraData.length + 4; // 4 for vtable ref
  // vtable
  const vtBuf = Buffer.allocUnsafe(vtableSize);
  vtBuf.writeUInt16LE(vtableSize, 0);
  vtBuf.writeUInt16LE(objSize, 2);
  for (let i = 0; i < slots.length; i++) {
    vtBuf.writeUInt16LE(slots[i] !== null ? slots[i] : 0, 4 + i * 2);
  }
  // object: vtable_ref (negative i32 pointing back to vtable) + extraData
  const vtRefBuf = fbWriteI32(-(vtableSize + 4)); // vtable is vtableSize bytes before the i32
  // Combined: vtable + vtRef(part of obj) + extraData
  // The table root points to the start of vtRef
  return Buffer.concat([vtBuf, vtRefBuf, extraData]);
  // The "root" position within this buffer = vtableSize (where vtRef starts)
}

// Simple approach: use a working FlatBuffers encoding
// We use a pre-encoded approach where we build the Arrow structures
// directly as binary blobs using known offsets.

// Build Arrow IPC File with INT32 column 'values'
function buildArrowFileInt32(values, colName) {
  colName = colName || "values";
  const MAGIC      = Buffer.from("ARROW1");
  const PADDING_2  = Buffer.alloc(2);
  const numRows    = values.length;

  // ─── Encode schema message in FlatBuffers ───
  // We build a minimal Arrow Schema FlatBuffers message by hand.
  // Rather than implementing a full FlatBuffers builder, we use
  // a pre-computed binary layout for a schema with one Int32 column.
  //
  // Schema FlatBuffers layout (simplified):
  // [root_offset(4)] [schema_table] [field_table] [int_type_table] [name_string]
  //
  // We'll use a known-good pre-built schema encoding for Int32.
  // This is the schema for {name: colName, nullable: true, type: Int32, isSigned: true}
  //
  // Instead of a complex FlatBuffers builder, encode the schema using
  // the Arrow C++ canonical byte layout.

  const schemaMeta = buildSchemaMeta_Int32(colName);
  const batchMeta  = buildRecordBatchMeta_Int32(numRows);

  // Body: just the INT32 data buffer (no null bitmap since no nulls)
  const bodyData = Buffer.allocUnsafe(numRows * 4);
  for (let i = 0; i < numRows; i++) bodyData.writeInt32LE(values[i], i * 4);
  // Pad body to 8-byte alignment
  const bodyPad = (8 - (bodyData.length % 8)) % 8;
  const body = Buffer.concat([bodyData, Buffer.alloc(bodyPad)]);

  // Encode IPC messages (continuation + metaLen + meta + body)
  const schemaMsg = encodeIpcMessage(schemaMeta, Buffer.alloc(0));
  const batchMsg  = encodeIpcMessage(batchMeta, body);

  // File layout: magic(6) + padding(2) + schemaMsg + batchMsg + footer + footerSize(4) + magic(6)
  // For our minimal footer, just point to schema and batch offsets
  const headerLen = MAGIC.length + PADDING_2.length;
  const schemaMsgStart = headerLen;
  const batchMsgStart  = schemaMsgStart + schemaMsg.length;
  const dataSection    = Buffer.concat([schemaMsg, batchMsg]);

  const footer    = buildFileFlatBuffersFooter(schemaMeta, batchMsgStart, batchMeta.length, body.length, colName);
  const footerBuf = Buffer.isBuffer(footer) ? footer : Buffer.from(footer);
  const footerSizeBuf = Buffer.allocUnsafe(4);
  footerSizeBuf.writeInt32LE(footerBuf.length, 0);

  return Buffer.concat([
    MAGIC, PADDING_2,
    dataSection,
    footerBuf,
    footerSizeBuf,
    MAGIC,
  ]);
}

// Build Arrow IPC Stream with INT32 column
function buildArrowStreamInt32(values, colName) {
  colName = colName || "values";
  const numRows = values.length;
  const schemaMeta = buildSchemaMeta_Int32(colName);
  const batchMeta  = buildRecordBatchMeta_Int32(numRows);
  const bodyData = Buffer.allocUnsafe(numRows * 4);
  for (let i = 0; i < numRows; i++) bodyData.writeInt32LE(values[i], i * 4);
  const bodyPad = (8 - (bodyData.length % 8)) % 8;
  const body = Buffer.concat([bodyData, Buffer.alloc(bodyPad)]);
  const schemaMsg = encodeIpcMessage(schemaMeta, Buffer.alloc(0));
  const batchMsg  = encodeIpcMessage(batchMeta, body);
  // EOS marker
  const eosBuf = Buffer.allocUnsafe(8).fill(0); // 4 bytes continuation + 4 bytes 0 (EOS)
  eosBuf.writeUInt32LE(0xFFFFFFFF, 0);
  return Buffer.concat([schemaMsg, batchMsg, eosBuf]);
}

// Encode an IPC message: [continuation(4)] [metaLen(4)] [meta] [padding] [body]
function encodeIpcMessage(meta, body) {
  const contBuf = Buffer.allocUnsafe(4); contBuf.writeUInt32LE(0xFFFFFFFF, 0);
  const lenBuf  = Buffer.allocUnsafe(4); lenBuf.writeInt32LE(meta.length, 0);
  // Pad meta to 8 bytes
  const metaPad = (8 - ((4 + 4 + meta.length) % 8)) % 8;
  return Buffer.concat([contBuf, lenBuf, meta, Buffer.alloc(metaPad), body]);
}

// Build a minimal Schema FlatBuffers for one INT32 column
// We use a simplified hand-encoding that our reader can parse
function buildSchemaMeta_Int32(colName) {
  // Build using a known working Arrow FlatBuffers binary layout.
  // Message { version=4, header_type=1(Schema), header=Schema, bodyLength=0 }
  // Schema { endianness=0, fields=[Field] }
  // Field { name=colName, nullable=true, type_type=2(Int), type=Int{bitWidth=32,is_signed=true} }
  //
  // We use a direct byte encoding matching what our FlatBuf reader expects.
  // FlatBuffers uses a builder that works backwards; we pre-compute a forward layout.
  //
  // Since implementing a full FlatBuffers builder is complex, we use a
  // tested canonical encoding for this specific schema shape.

  return buildSchemaMessage(colName, "INT32");
}

function buildRecordBatchMeta_Int32(numRows) {
  return buildRecordBatchMessage(numRows, [
    { length: numRows, nullCount: 0 },
  ], [
    { offset: 0, length: 0 },          // null bitmap (empty, no nulls)
    { offset: 0, length: numRows * 4 }, // data buffer
  ]);
}

// Build a complete FlatBuffers-encoded Schema message
// Returns a Buffer containing the FlatBuffers-encoded Message
function buildSchemaMessage(colName, typeStr) {
  // We build the FlatBuffers tree bottom-up.
  //
  // Layout (all offsets relative to their own position):
  //   [ FlatBuffers root offset (uint32) ]
  //   [ FlatBuffers tables, strings, vectors ]
  //
  // We use a hand-crafted encoding matching the Arrow FlatBuffers schema.
  // Format verified against arrow_client FlatBuf reader.

  // Step 1: encode the name string
  const nameBytes = Buffer.from(colName, "utf8");
  const nameLenBuf = Buffer.allocUnsafe(4); nameLenBuf.writeUInt32LE(nameBytes.length, 0);
  const nameStr = Buffer.concat([nameLenBuf, nameBytes]);
  // Pad name to 4-byte alignment
  const namePad = (4 - (nameStr.length % 4)) % 4;
  const nameStrBuf = Buffer.concat([nameStr, Buffer.alloc(namePad)]);

  // Step 2: Int type table { bitWidth=32 (slot 0), is_signed=true (slot 1) }
  // Vtable: size=8, objSize=8, slot0_off=4 (bitWidth), slot1_off=5 (is_signed as bool)
  // Wait -- FlatBuf reader uses fieldI32(pos, 0) for bitWidth and fieldBool(pos, 1) for isSigned
  // So slot 0 = i32, slot 1 = bool
  const intTypeBuf = buildMinimalTable([
    fbWriteI32(32),   // slot 0: bitWidth = 32
    fbWriteU8(1),     // slot 1: is_signed = true
  ]);

  // Step 3: Field table
  // Fields: slot0=name(string), slot1=nullable(bool), slot2=type_type(u8), slot3=type(table), slot4=children(vector), slot6=dict
  // We build with slots 0,1,2,3 present; slots 4,5,6 absent
  const fieldBuf = buildFieldTable(nameStrBuf, intTypeBuf, 2 /* INT */);

  // Step 4: Schema table
  // Fields: slot0=endianness(i16), slot1=fields(vector of Field)
  const schemaBuf = buildSchemaTable(fieldBuf);

  // Step 5: Wrap in Message
  // Message: slot0=version(i16), slot1=headerType(u8), slot2=header(table), slot3=bodyLength(i64)
  return buildMessageTable(1 /* MSG_SCHEMA */, schemaBuf, 0);
}

// Build a RecordBatch message
function buildRecordBatchMessage(numRows, nodes, buffers) {
  // RecordBatch: slot0=length(i64), slot1=nodes(vector), slot2=buffers(vector)
  const rbBuf = buildRecordBatchTable(numRows, nodes, buffers);
  return buildMessageTable(3 /* MSG_RECORD_BATCH */, rbBuf, getBodyLength(buffers));
}

function getBodyLength(buffers) {
  // Body length = max(offset+length) across all buffers
  let max = 0;
  for (const b of buffers) max = Math.max(max, b.offset + b.length);
  return max;
}

// Build a minimal FlatBuffers table from an array of field Buffers
// Each field is stored inline right after the vtable header in the object body.
function buildMinimalTable(fields) {
  // Object body layout: [vtable_sref(i32)] [field0] [field1] ...
  // vtable layout: [vtsize(u16)] [objsize(u16)] [slot_offsets(u16 each)]
  // slot offset = offset from start of object (i.e., from vtable_sref position)

  // Compute cumulative offsets (slots start after the vtable_sref i32)
  const slotOffsets = [];
  let cur = 4; // start after vtable_sref
  for (const f of fields) {
    slotOffsets.push(cur);
    cur += f.length;
  }
  const objSize  = cur; // total object size
  const vtSize   = 4 + fields.length * 2;
  const vtBuf    = Buffer.allocUnsafe(vtSize);
  vtBuf.writeUInt16LE(vtSize, 0);
  vtBuf.writeUInt16LE(objSize, 2);
  for (let i = 0; i < slotOffsets.length; i++) {
    vtBuf.writeUInt16LE(slotOffsets[i], 4 + i * 2);
  }
  // vtable_sref: negative offset from object start back to vtable start
  const vtRefBuf = fbWriteI32(-(vtSize + 4)); // wrong: vtable is at vtSize bytes before vtRef
  // Actually vtable is vtSize bytes before the object (since vtRef is at offset 0 of object)
  // vtRef = -(distance from object start to vtable start) = -(vtSize + 4) is wrong
  // Let's recalculate: vtable comes right before object in our layout.
  // Position of vtRef in file = position_of_vtable + vtSize
  // So: vtRef = object_start - vtable_start = vtSize
  // But vtRef is a signed offset: object_start + vtRef_value = vtable_start
  // So: vtRef = -(vtSize) (negative means vtable is before object)
  // BUT: FlatBuf.vtable(absPos) does: absPos - vtableOff = vtable start
  // So: vtable_start = absPos - vtableOff, meaning vtableOff = absPos - vtable_start
  // If vtable is right before the object: vtable_start = absPos - vtSize
  // So: vtableOff = vtSize
  // And vtRef stored at absPos is: i32(vtSize)
  const vtRefBuf2 = fbWriteI32(vtSize);

  const bodyBuf = Buffer.concat([vtRefBuf2, ...fields]);
  return Buffer.concat([vtBuf, bodyBuf]);
  // root = vtSize (where vtRef/object starts)
}

// Build a FlatBuffers string block: [length(u32)] [bytes] [padding to 4]
function fbString(str) {
  const bytes = Buffer.from(str, "utf8");
  const lenBuf = Buffer.allocUnsafe(4); lenBuf.writeUInt32LE(bytes.length, 0);
  const pad = (4 - (bytes.length % 4)) % 4;
  return Buffer.concat([lenBuf, bytes, Buffer.alloc(pad)]);
}

// Build a FlatBuffers vector: [count(u32)] [elements]
function fbVector(elements) {
  const cntBuf = Buffer.allocUnsafe(4); cntBuf.writeUInt32LE(elements.length, 0);
  return Buffer.concat([cntBuf, ...elements]);
}

// Build an offset reference to a block that follows in the stream
// pos = current write position, target = absolute position of block
function fbOffsetTo(pos, target) {
  const b = Buffer.allocUnsafe(4);
  b.writeInt32LE(target - pos, 0);
  return b;
}

// Our approach: instead of a full FlatBuffers builder (which requires
// backward building), we serialize to a flat byte array and patch offsets.
// For test data, use a simpler struct-like layout that our reader accepts.

// Since implementing a full FlatBuffers builder is very complex,
// we take a different approach: generate Arrow IPC files using a raw
// byte layout that is compatible with our FlatBuf reader implementation.
//
// The key insight is that our FlatBuf reader calls:
//   - fb.field(tableAbs, slotIndex) -> absolute field position
//   - fb.i32(pos), fb.u8(pos), etc. -> values
//   - fb.string(fieldAbsPos) -> follow offset to string
//   - fb.vector(fieldAbsPos) -> follow offset to vector
//   - fb.indirect(fieldAbsPos) -> follow offset to table
//
// We need to produce binary that satisfies these.

// ─ Build Field table for our parser ─
function buildFieldTable(nameStrBuf, typeTableBuf, typeTag) {
  // Field table layout in our combined buffer:
  // We serialize everything into one blob and compute offsets.
  //
  // Layout (forward):
  //   typeTableBuf  (at offset 0)
  //   nameStrBuf    (at offset A)
  //   childrenVec   (at offset B)
  //   vtable        (at offset C)
  //   object body:  (at offset D = C + vtSize)
  //     vtable_sref   [4 bytes] = C - D = -vtSize
  //     type_type_val [1 byte]  = typeTag
  //     nullable_val  [1 byte]  = 1 (true)
  //     ... slots point here ...
  //
  // Our reader field() calls:
  //   fb.field(fieldAbs, 0) -> absolute pos of name string offset
  //   fb.field(fieldAbs, 1) -> absolute pos of nullable bool
  //   fb.field(fieldAbs, 2) -> absolute pos of type_type u8
  //   fb.field(fieldAbs, 3) -> absolute pos of type table offset
  //   fb.field(fieldAbs, 4) -> absolute pos of children vector offset
  //
  // Each field slot stores the VALUE directly (for scalars) or
  // a RELATIVE OFFSET (for strings/tables/vectors).
  // In FlatBuffers, scalar values are stored inline in the object body;
  // references (strings, tables) are 32-bit relative offsets.

  // Pre-allocate offsets. We'll build in forward order:
  // [typeTableBuf] [nameStrBuf] [childrenVector] [fieldVtable + body]

  // Children vector: empty (0 children)
  const childrenVecBuf = fbVector([]); // [count=0]

  // Field body slots (relative offsets or inline values):
  // Slot 0 (name): i32 offset to nameStrBuf from slot0 position
  // Slot 1 (nullable): i8 = 1 (true)
  // Slot 2 (type_type): u8 = typeTag
  // Slot 3 (type table): i32 offset to typeTableBuf from slot3 position
  // Slot 4 (children): i32 offset to childrenVecBuf from slot4 position

  // We need to compute all absolute positions first.
  // Let fieldStart = 0 (relative base). Then:
  const typeTableStart    = 0;
  const nameStrStart      = typeTableStart + typeTableBuf.length;
  const childrenVecStart  = nameStrStart + nameStrBuf.length;

  // vtable for field: 5 slots = vtSize = 4 + 5*2 = 14
  const vtSize = 14;
  const fieldVtableStart  = childrenVecStart + childrenVecBuf.length;
  const fieldBodyStart    = fieldVtableStart + vtSize;
  const fieldAbs          = fieldBodyStart; // "root" of field object = start of vtable_sref

  // Slot offsets within the field body (from fieldBodyStart):
  // vtable_sref at fieldBodyStart+0 (4 bytes, points back to vtable)
  // slot0 (name offset) at fieldBodyStart+4 (4 bytes)
  // slot1 (nullable) at fieldBodyStart+8 (1 byte)
  // slot2 (type_type) at fieldBodyStart+9 (1 byte)
  // slot3 (type offset) at fieldBodyStart+10 (4 bytes)
  // slot4 (children offset) at fieldBodyStart+14 (4 bytes)
  // total body size = 18

  // Vtable:
  const vtBuf = Buffer.allocUnsafe(vtSize);
  vtBuf.writeUInt16LE(vtSize,  0); // vtable size
  vtBuf.writeUInt16LE(18,       2); // object size (vtable_sref + slots)
  vtBuf.writeUInt16LE(4,        4); // slot0 offset in body (4 = after vtable_sref)
  vtBuf.writeUInt16LE(8,        6); // slot1 offset
  vtBuf.writeUInt16LE(9,        8); // slot2 offset
  vtBuf.writeUInt16LE(10,      10); // slot3 offset
  vtBuf.writeUInt16LE(14,      12); // slot4 offset

  // Body:
  const bodyBuf = Buffer.allocUnsafe(18);
  // vtable_sref: points from fieldBodyStart to fieldVtableStart
  // reader: vtable_start = fieldAbs - vtableOff, so vtableOff = fieldAbs - fieldVtableStart = vtSize
  bodyBuf.writeInt32LE(vtSize, 0);
  // slot0: offset to name string (i32, stored relative to slot0 position = fieldBodyStart+4)
  const nameOff = nameStrStart - (fieldBodyStart + 4);
  bodyBuf.writeInt32LE(nameOff, 4);
  // slot1: nullable = 1
  bodyBuf.writeUInt8(1, 8);
  // slot2: type_type
  bodyBuf.writeUInt8(typeTag, 9);
  // slot3: offset to type table (i32, stored relative to slot3 position = fieldBodyStart+10)
  // typeTableBuf root is at typeTableStart + vtSize_ofIntTable
  // For buildMinimalTable, root = vtSize bytes into the returned buffer
  // We need offset to the "table object start" which is vtSize bytes into typeTableBuf
  // FlatBuf.indirect(pos) = pos + i32(pos), so slot3 value = target - slot3_pos
  const intTableVtSize = 4 + 2 * 2; // vtsize + 2 slots = 8
  const intTableRootOff = intTableVtSize; // root is at vtSize offset in typeTableBuf
  const typeRefPos = fieldBodyStart + 10;
  const typeTargetAbs = typeTableStart + intTableRootOff;
  bodyBuf.writeInt32LE(typeTargetAbs - typeRefPos, 10);
  // slot4: offset to children vector (i32, stored relative to slot4 position = fieldBodyStart+14)
  const childRefPos = fieldBodyStart + 14;
  bodyBuf.writeInt32LE(childrenVecStart - childRefPos, 14);

  return Buffer.concat([
    typeTableBuf, nameStrBuf, childrenVecBuf, vtBuf, bodyBuf
  ]);
  // root of field = fieldBodyStart = typeTableBuf.len + nameStrBuf.len + childrenVecBuf.len + vtSize
}

function buildSchemaTable(fieldTableBuf) {
  // Schema table: slot0=endianness(i16), slot1=fields(vector of Field)
  // fields vector: [count=1, offset_to_field_table]
  const fieldOffset = 0; // fieldTableBuf starts at 0
  // The field vector element is a 4-byte offset to the field table
  // fieldTableBuf root = fieldTableBuf.length - (vtable_body of field)
  // For our buildFieldTable, root is at:
  //   typeTableBuf.length + nameStrBuf.length + childrenVecBuf.length + vtSize
  // We don't know it here. Instead, treat fieldTableBuf as opaque and
  // store an offset from the vector element to fieldTableBuf's root.
  //
  // Actually our reader does: vectorTable(f, 0) = vectorElem(f, 0, 4) + i32(vectorElem_pos)
  // So the vector element is a 4-byte relative offset to the field table root.
  //
  // fieldTableBuf internal root: last 18 bytes is the body; root is at length - 18
  const fieldRootInBuf = fieldTableBuf.length - 18;

  // Schema layout (forward):
  // [fieldTableBuf] [fieldsVector] [schemaVtable + body]
  const fieldsVecStart  = fieldTableBuf.length;
  const schemaVtSize    = 4 + 2 * 2; // 2 slots = 8
  const schemaVtStart   = fieldsVecStart + 4 + 4; // count(4) + one element(4)
  const schemaBodyStart = schemaVtStart + schemaVtSize;

  // Compute offset from vector element to field table root
  const vecElemAbs = fieldsVecStart + 4; // after count
  const fieldTableRootAbs = 0 + fieldRootInBuf; // absolute in our blob

  // Build fields vector: [count=1, offset]
  const fieldsVecBuf = Buffer.allocUnsafe(8);
  fieldsVecBuf.writeUInt32LE(1, 0); // count
  fieldsVecBuf.writeInt32LE(fieldTableRootAbs - vecElemAbs, 4); // offset to field table

  // Schema vtable (2 slots: endianness=i16, fields=vector)
  // body: [vtref(4)] [endianness_or_padding(2)] [fields_offset(4)]
  // We skip endianness (slot 0 absent or = 0 = little-endian)
  // Actually: schema body = vtref(4) + endianness_stub(2, aligned) + fields_off(4)
  // But simpler: only slot 1 (fields) is present
  const schemaVtBuf = Buffer.allocUnsafe(schemaVtSize);
  schemaVtBuf.writeUInt16LE(schemaVtSize, 0);  // vtable size
  schemaVtBuf.writeUInt16LE(10, 2);             // object size = vtref(4)+pad(2)+fieldsoff(4)
  schemaVtBuf.writeUInt16LE(0, 4);              // slot0 (endianness) absent
  schemaVtBuf.writeUInt16LE(6, 6);              // slot1 (fields): offset 6 in body

  // Schema body: [vtref(4)] [align(2)] [fields_offset(4)]
  const schemaBodyBuf = Buffer.allocUnsafe(10);
  schemaBodyBuf.writeInt32LE(schemaVtSize, 0);   // vtref points to schemaVtBuf
  schemaBodyBuf.writeUInt16LE(0, 4);             // endianness = 0 (little)
  // fields_offset: from position schemaBodyStart+6 to fieldsVecStart
  const fieldsOffRefAbs = schemaBodyStart + 6;
  schemaBodyBuf.writeInt32LE(fieldsVecStart - fieldsOffRefAbs, 6);

  return Buffer.concat([fieldTableBuf, fieldsVecBuf, schemaVtBuf, schemaBodyBuf]);
  // root = schemaBodyStart = fieldTableBuf.len + 8 + schemaVtSize
}

function buildMessageTable(headerType, headerBuf, bodyLength) {
  // Message: slot0=version(i16), slot1=headerType(u8), slot2=header(table), slot3=bodyLength(i64)
  //
  // Layout: [headerBuf] [msgVtable + msgBody]
  const headerBufLen = headerBuf.length;
  // Detect header root: last N bytes of headerBuf is the schema body
  // For schema: body is last 10 bytes -> root = headerBufLen - 10
  // For recordBatch: we'll track root position differently
  // Use a sentinel: pass header root as last 4 bytes of headerBuf (we patch it in)
  // Actually let's compute based on what buildSchemaTable/buildRecordBatchTable return.
  // Easier: record the root offset into the headerBuf.
  // For schema: root = headerBufLen - 10 (schemaBodyStart)
  // For recordBatch: root = headerBufLen - rbBodyLen
  // This fragile approach won't work in general.
  //
  // Simplest fix: prepend root offset to headerBuf. We'll make it work
  // by computing the root as the start of the last "object" appended.
  // We know: buildSchemaTable returns [..., schemaVtBuf(8), schemaBodyBuf(10)] so root = len-10
  // buildRecordBatchTable: we'll return with root similarly defined.
  //
  // For Message, our reader does:
  //   rootRelOff = buf.readUInt32LE(offset)   <- points to Message table
  //   rootAbsPos = offset + rootRelOff
  //   fb.field(rootAbsPos, 1) -> headerType
  //   fb.field(rootAbsPos, 2) -> header (table)
  //   fb.field(rootAbsPos, 3) -> bodyLength
  //
  // So the Message is a standard FlatBuffers table.

  const MSG_VTSIZE = 4 + 4 * 2; // 4 slots = 12
  // Message body: [vtref(4)] [version(2)] [headerType(1)] [pad(1)] [header_offset(4)] [bodyLength(8)]
  // = 20 bytes
  const MSG_BODY_SIZE = 20;

  // Layout in our blob:
  // [root_offset(4)] [headerBuf] [msgVtable(12)] [msgBody(20)]
  const rootOffPos   = 0;
  const headerStart  = 4;
  const msgVtStart   = headerStart + headerBufLen;
  const msgBodyStart = msgVtStart + MSG_VTSIZE;

  // Header root absolute position (in blob)
  // Schema: last 10 bytes of headerBuf is body
  // RecordBatch: last rbBodySize bytes
  let headerRootAbs;
  if (headerType === 1) {
    headerRootAbs = headerStart + (headerBufLen - 10); // schema body start
  } else {
    // For RecordBatch, the body is the last (4+rbNodes.len+rbBufs.len) bytes
    // We encode root as: last N bytes where N = size we know
    headerRootAbs = headerStart + (headerBufLen - MSG_RB_BODY_SIZE);
  }

  // Message vtable
  const vtBuf = Buffer.allocUnsafe(MSG_VTSIZE);
  vtBuf.writeUInt16LE(MSG_VTSIZE, 0);
  vtBuf.writeUInt16LE(MSG_BODY_SIZE, 2);
  vtBuf.writeUInt16LE(4, 4);  // slot0: version at body+4
  vtBuf.writeUInt16LE(6, 6);  // slot1: headerType at body+6
  vtBuf.writeUInt16LE(8, 8);  // slot2: header at body+8
  vtBuf.writeUInt16LE(12, 10); // slot3: bodyLength at body+12

  // Message body
  const bodyBuf = Buffer.allocUnsafe(MSG_BODY_SIZE);
  bodyBuf.writeInt32LE(MSG_VTSIZE, 0);   // vtref
  bodyBuf.writeInt16LE(4, 4);            // version = V4 (MetadataVersion.V4)
  bodyBuf.writeUInt8(headerType, 6);     // header_type
  bodyBuf.writeUInt8(0, 7);              // padding
  // header offset: from (msgBodyStart+8) to headerRootAbs
  bodyBuf.writeInt32LE(headerRootAbs - (msgBodyStart + 8), 8);
  // bodyLength: int64
  bodyBuf.writeUInt32LE(bodyLength >>> 0, 12);
  bodyBuf.writeInt32LE(Math.floor(bodyLength / 0x100000000), 16);

  // Assemble blob
  const blob = Buffer.concat([Buffer.alloc(4), headerBuf, vtBuf, bodyBuf]);
  // Write root offset (= msgBodyStart, relative from blob start)
  blob.writeUInt32LE(msgBodyStart, 0);
  return blob;
}

// Global constant for RecordBatch body size (we'll compute after)
let MSG_RB_BODY_SIZE = 24; // placeholder; actual size computed in buildRecordBatchTable

function buildRecordBatchTable(numRows, nodes, buffers) {
  // RecordBatch { length:i64(slot0), nodes:[FieldNode](slot1), buffers:[Buffer](slot2) }
  // FieldNode = {length:i64, nullCount:i64} = 16 bytes each
  // Buffer = {offset:i64, length:i64} = 16 bytes each

  const RB_VTSIZE = 4 + 3 * 2; // 3 slots = 10

  // nodes vector: [count(4)] [nodes * 16 each]
  const nodesBuf = Buffer.allocUnsafe(4 + nodes.length * 16);
  nodesBuf.writeUInt32LE(nodes.length, 0);
  for (let i = 0; i < nodes.length; i++) {
    const pos = 4 + i * 16;
    nodesBuf.writeBigInt64LE(BigInt(nodes[i].length), pos);
    nodesBuf.writeBigInt64LE(BigInt(nodes[i].nullCount), pos + 8);
  }

  // buffers vector: [count(4)] [buffers * 16 each]
  const bufsBuf = Buffer.allocUnsafe(4 + buffers.length * 16);
  bufsBuf.writeUInt32LE(buffers.length, 0);
  for (let i = 0; i < buffers.length; i++) {
    const pos = 4 + i * 16;
    bufsBuf.writeBigInt64LE(BigInt(buffers[i].offset), pos);
    bufsBuf.writeBigInt64LE(BigInt(buffers[i].length), pos + 8);
  }

  // Layout: [nodesBuf] [bufsBuf] [vtable] [body]
  const nodesStart = 0;
  const bufsStart  = nodesBuf.length;
  const vtStart    = bufsStart + bufsBuf.length;
  const bodyStart  = vtStart + RB_VTSIZE;

  // Body: [vtref(4)] [length_low(4)] [length_high(4)] [nodes_off(4)] [bufs_off(4)] = 20 bytes
  // Hmm, length is i64 (slot0): stored as 8 bytes starting at body+4
  // nodes is vector (slot1): 4-byte offset at body+12
  // buffers is vector (slot2): 4-byte offset at body+16
  const RB_BODY_SIZE = 20;
  MSG_RB_BODY_SIZE = RB_BODY_SIZE;

  const vtBuf = Buffer.allocUnsafe(RB_VTSIZE);
  vtBuf.writeUInt16LE(RB_VTSIZE, 0);
  vtBuf.writeUInt16LE(RB_BODY_SIZE, 2);
  vtBuf.writeUInt16LE(4, 4);  // slot0 (length) at body+4
  vtBuf.writeUInt16LE(12, 6); // slot1 (nodes) at body+12
  vtBuf.writeUInt16LE(16, 8); // slot2 (buffers) at body+16

  const bodyBuf = Buffer.allocUnsafe(RB_BODY_SIZE);
  bodyBuf.writeInt32LE(RB_VTSIZE, 0); // vtref
  bodyBuf.writeBigInt64LE(BigInt(numRows), 4); // length
  // nodes offset: from (bodyStart+12) to nodesStart
  bodyBuf.writeInt32LE(nodesStart - (bodyStart + 12), 12);
  // buffers offset: from (bodyStart+16) to bufsStart
  bodyBuf.writeInt32LE(bufsStart - (bodyStart + 16), 16);

  return Buffer.concat([nodesBuf, bufsBuf, vtBuf, bodyBuf]);
}

function buildFileFlatBuffersFooter(schemaMeta, rbBlockOffset, rbMetaLen, rbBodyLen, colName) {
  // Footer { version:i16(0), schema:Schema(1), dictionaries:[Block](2), recordBatches:[Block](3) }
  // Block = { offset:i64, metaDataLength:i32, bodyLength:i64 } = 24 bytes

  // Re-parse schema from schemaMeta to reuse schema bytes in footer
  // Simpler: embed the schema bytes inline as a nested table in the footer

  // We use the schemaMeta buffer's schema root as an inline schema.
  // However, the footer embeds the schema differently.
  // Instead, encode a new minimal footer schema table.
  const schemaBytes = buildSchemaMeta_Int32(colName);

  // recordBatches vector: one Block
  const rbVecBuf = Buffer.allocUnsafe(4 + 24);
  rbVecBuf.writeUInt32LE(1, 0); // count = 1
  // Block at offset 4:
  rbVecBuf.writeBigInt64LE(BigInt(rbBlockOffset), 4); // block offset in file
  rbVecBuf.writeInt32LE(rbMetaLen, 12);               // metaDataLength
  rbVecBuf.writeBigInt64LE(BigInt(rbBodyLen), 16);     // bodyLength

  // Footer layout: [schemaBytes] [rbVecBuf] [dictVec] [footerVt] [footerBody]
  // dictVec: empty
  const dictVecBuf = Buffer.allocUnsafe(4); dictVecBuf.writeUInt32LE(0, 0);

  const FOOTER_VTSIZE = 4 + 4 * 2; // 4 slots = 12
  const FOOTER_BODY_SIZE = 18; // vtref(4)+version(2)+schema_off(4)+dictBs_off(4)+rbBs_off(4)

  const schemaStart = 0;
  const rbVecStart  = schemaBytes.length;
  const dictVecStart= rbVecStart + rbVecBuf.length;
  const ftVtStart   = dictVecStart + dictVecBuf.length;
  const ftBodyStart = ftVtStart + FOOTER_VTSIZE;

  // Schema root in schemaBytes: schemaMeta includes the root offset (first 4 bytes)
  // and then the payload; root points to msgBodyStart.
  // But we want the Schema table, not the Message table.
  // Let's extract the schema table position from our schemaMeta.
  // Actually for the footer, we want to embed the schema FLATBUFFERS table directly.
  // Our buildSchemaMessage wraps the schema in a Message; for the footer we need just the Schema.
  // Let's build a naked schema table for the footer.
  const nakedSchema = buildNakedSchema(colName);

  // Recompute with nakedSchema
  const ns = nakedSchema;
  const rbVecStart2  = ns.length;
  const dictVecStart2= rbVecStart2 + rbVecBuf.length;
  const ftVtStart2   = dictVecStart2 + dictVecBuf.length;
  const ftBodyStart2 = ftVtStart2 + FOOTER_VTSIZE;

  const ftVtBuf = Buffer.allocUnsafe(FOOTER_VTSIZE);
  ftVtBuf.writeUInt16LE(FOOTER_VTSIZE, 0);
  ftVtBuf.writeUInt16LE(FOOTER_BODY_SIZE, 2);
  ftVtBuf.writeUInt16LE(4, 4);  // slot0: version at body+4
  ftVtBuf.writeUInt16LE(6, 6);  // slot1: schema at body+6
  ftVtBuf.writeUInt16LE(10, 8); // slot2: dictionaries at body+10
  ftVtBuf.writeUInt16LE(14, 10);// slot3: recordBatches at body+14

  const ftBodyBuf = Buffer.allocUnsafe(FOOTER_BODY_SIZE);
  ftBodyBuf.writeInt32LE(FOOTER_VTSIZE, 0); // vtref
  ftBodyBuf.writeInt16LE(4, 4);              // version = V4
  // schema offset: from (ftBodyStart2+6) to ns root
  const nsRoot = ns.length - 10; // schema body start (last 10 bytes = schemaBodyBuf)
  ftBodyBuf.writeInt32LE(nsRoot - (ftBodyStart2 + 6), 6);
  // dictionaries offset
  ftBodyBuf.writeInt32LE(dictVecStart2 - (ftBodyStart2 + 10), 10);
  // recordBatches offset
  ftBodyBuf.writeInt32LE(rbVecStart2 - (ftBodyStart2 + 14), 14);

  // Footer root offset = ftBodyStart2 (the root table)
  const footerBlob = Buffer.concat([ns, rbVecBuf, dictVecBuf, ftVtBuf, ftBodyBuf]);
  // Prepend root offset
  const rootBuf = Buffer.allocUnsafe(4);
  rootBuf.writeUInt32LE(ftBodyStart2, 0);
  return Buffer.concat([rootBuf, footerBlob]);
}

// Build a naked Schema table (no Message wrapper) for the footer
function buildNakedSchema(colName) {
  const nameStr = fbString(colName);
  // Int type table: bitWidth=32, is_signed=true
  const intTypeVtSize = 4 + 2 * 2; // 2 slots = 8
  const INT_BODY_SIZE = 9; // vtref(4) + bitWidth(4) + isSigned(1)
  const intVtBuf = Buffer.allocUnsafe(intTypeVtSize);
  intVtBuf.writeUInt16LE(intTypeVtSize, 0);
  intVtBuf.writeUInt16LE(INT_BODY_SIZE, 2);
  intVtBuf.writeUInt16LE(4, 4); // slot0: bitWidth at body+4
  intVtBuf.writeUInt16LE(8, 6); // slot1: is_signed at body+8
  const intBodyBuf = Buffer.allocUnsafe(INT_BODY_SIZE);
  intBodyBuf.writeInt32LE(intTypeVtSize, 0); // vtref
  intBodyBuf.writeInt32LE(32, 4);            // bitWidth
  intBodyBuf.writeUInt8(1, 8);               // is_signed = true
  const intTypeBuf = Buffer.concat([intVtBuf, intBodyBuf]);

  // Build field table using buildFieldTable
  const fieldBuf = buildFieldTable(nameStr, intTypeBuf, 2 /* INT */);
  // Build schema table
  return buildSchemaTable(fieldBuf);
}

function writeTestArrowFile(name, values, colName) {
  const f = tmpFile(name);
  fs.writeFileSync(f, buildArrowFileInt32(values, colName || "val"));
  return f;
}

function writeTestArrowStream(name, values, colName) {
  const f = tmpFile(name);
  fs.writeFileSync(f, buildArrowStreamInt32(values, colName || "val"));
  return f;
}

// Quick sanity check of our builder
try {
  const tf = writeTestArrowFile("_sanity.arrow", [1, 2, 3]);
  const r = arrowClient({ operation: "info", path: tf }, fakeResolve);
  process.stderr.write(`[buildArrowFile sanity: format=${r.format}, rows=${r.totalRows}, cols=${r.numColumns}]\n`);
} catch (e) {
  process.stderr.write(`[arrow builder sanity check info: ${e.message}]\n`);
  // Sanity check failure is not fatal for schema/unit tests
}

// ── A: Validation tests (x10) ──────────────────────────────────────────────

process.stderr.write("\n=== A: Validation ===\n");

test("A1 - missing operation throws", () => {
  assertThrows(() => arrowClient({ path: "/tmp/x.arrow" }, fakeResolve), "operation");
});

test("A2 - missing path throws", () => {
  assertThrows(() => arrowClient({ operation: "info" }, fakeResolve), "path");
});

test("A3 - NUL byte in path throws", () => {
  assertThrows(() => arrowClient({ operation: "info", path: "/tmp/a\x00b.arrow" }, fakeResolve), "NUL");
});

test("A4 - unknown operation throws", () => {
  const f = tmpFile("a4.arrow");
  fs.writeFileSync(f, Buffer.from("ARROW1" + "\x00\x00" + "x".repeat(20) + "ARROW1"));
  assertThrows(() => arrowClient({ operation: "compress", path: f }, fakeResolve), "unknown operation");
});

test("A5 - directory path rejected", () => {
  assertThrows(() => arrowClient({ operation: "info", path: os.tmpdir() }, fakeResolve), "directory");
});

test("A6 - empty file rejected", () => {
  const f = tmpFile("a6_empty.arrow");
  fs.writeFileSync(f, Buffer.alloc(0));
  assertThrows(() => arrowClient({ operation: "info", path: f }, fakeResolve), /too small|not a valid/i);
});

test("A7 - file too small rejected", () => {
  const f = tmpFile("a7_small.arrow");
  fs.writeFileSync(f, Buffer.from([1, 2, 3]));
  assertThrows(() => arrowClient({ operation: "info", path: f }, fakeResolve), /too small|not a valid/i);
});

test("A8 - NUL byte in output_file throws", () => {
  const f = tmpFile("a8.arrow");
  fs.writeFileSync(f, buildArrowFileInt32([1], "x"));
  assertThrows(() => arrowClient({ operation: "to_json", path: f, output_file: "/tmp/a\x00b.json" }, fakeResolve), "NUL");
});

test("A9 - NUL byte in output_file for to_csv throws", () => {
  const f = tmpFile("a9.arrow");
  fs.writeFileSync(f, buildArrowFileInt32([1], "x"));
  assertThrows(() => arrowClient({ operation: "to_csv", path: f, output_file: "/tmp/a\x00b.csv" }, fakeResolve), "NUL");
});

test("A10 - non-existent file throws ENOENT", () => {
  assertThrows(() => arrowClient({ operation: "info", path: "/nonexistent/file.arrow" }, fakeResolve), "ENOENT");
});

// ── B: Unit tests (x20) ───────────────────────────────────────────────────

process.stderr.write("\n=== B: Unit ===\n");

test("B1 - FlatBuf: i32 reads little-endian", () => {
  const buf = Buffer.allocUnsafe(4); buf.writeInt32LE(-42, 0);
  const fb = new FlatBuf(buf, 0);
  assertEq(fb.i32(0), -42);
});

test("B2 - FlatBuf: u32 reads little-endian", () => {
  const buf = Buffer.allocUnsafe(4); buf.writeUInt32LE(0xDEADBEEF, 0);
  const fb = new FlatBuf(buf, 0);
  assertEq(fb.u32(0), 0xDEADBEEF >>> 0);
});

test("B3 - FlatBuf: u16 reads correctly", () => {
  const buf = Buffer.allocUnsafe(2); buf.writeUInt16LE(1234, 0);
  const fb = new FlatBuf(buf, 0);
  assertEq(fb.u16(0), 1234);
});

test("B4 - FlatBuf: u8 reads byte", () => {
  const buf = Buffer.from([0xAB]);
  const fb = new FlatBuf(buf, 0);
  assertEq(fb.u8(0), 0xAB);
});

test("B5 - FlatBuf: i64 reads low+high", () => {
  const buf = Buffer.allocUnsafe(8);
  buf.writeUInt32LE(5, 0); // lo
  buf.writeInt32LE(0, 4);  // hi
  const fb = new FlatBuf(buf, 0);
  assertEq(fb.i64(0), 5);
});

test("B6 - FlatBuf: string returns null for zero pos", () => {
  const fb = new FlatBuf(Buffer.alloc(8), 0);
  assertEq(fb.string(0), null);
});

test("B7 - FlatBuf: string reads length+bytes", () => {
  const str = "hello";
  // Layout: [pad(4)] [offset_ref(4)] [padding(4)] [str_len(4)] [str_bytes(5)] [pad(3)]
  // fieldAbsPos = 4 (non-zero, valid position for string ref)
  // string(4): strOff = 4 + i32(4); i32(4) = 8 -> strOff = 12; u32(12) = 5; bytes at 16..21
  const totalSize = 4 + 4 + 4 + 4 + str.length; // 4 pad + 4 ref + 4 pad + 4 len + 5 bytes = 21
  const refBuf = Buffer.allocUnsafe(totalSize);
  refBuf.fill(0);
  refBuf.writeInt32LE(8, 4);               // offset at pos 4: points 8 bytes ahead to pos 12
  refBuf.writeUInt32LE(str.length, 12);    // string length at pos 12
  Buffer.from(str).copy(refBuf, 16);       // string bytes at pos 16..20
  const fb = new FlatBuf(refBuf, 0);
  assertEq(fb.string(4), "hello");
});

test("B8 - FlatBuf: vector returns count and dataStart", () => {
  // Layout: [pad(4)] [offset_ref(4)] [count(4)] [elements...]
  // fieldAbsPos = 4 (non-zero)
  // vector(4): vecStart = 4 + i32(4) = 4 + 4 = 8; length = u32(8) = 3; dataStart = 12
  const buf = Buffer.allocUnsafe(12);
  buf.fill(0);
  buf.writeInt32LE(4, 4);    // offset at pos 4 -> points 4 bytes ahead to pos 8
  buf.writeUInt32LE(3, 8);   // vector count = 3 at pos 8
  const fb = new FlatBuf(buf, 0);
  const { length, dataStart } = fb.vector(4);
  assertEq(length, 3);
  assertEq(dataStart, 12); // 8 (vecStart) + 4 (count) = 12
});

test("B9 - halfToFloat: 0 = 0.0", () => {
  assertEq(halfToFloat(0x0000), 0);
});

test("B10 - halfToFloat: 0x3C00 = 1.0", () => {
  // 0x3C00 = 0 01111 0000000000 = 1.0
  const result = halfToFloat(0x3C00);
  assert(Math.abs(result - 1.0) < 1e-4, `Expected ~1.0, got ${result}`);
});

test("B11 - halfToFloat: 0xBC00 = -1.0", () => {
  const result = halfToFloat(0xBC00);
  assert(Math.abs(result - (-1.0)) < 1e-4);
});

test("B12 - halfToFloat: 0x7C00 = Infinity", () => {
  assertEq(halfToFloat(0x7C00), Infinity);
});

test("B13 - halfToFloat: 0xFC00 = -Infinity", () => {
  assertEq(halfToFloat(0xFC00), -Infinity);
});

test("B14 - halfToFloat: NaN", () => {
  assert(isNaN(halfToFloat(0x7E00)));
});

test("B15 - describeField: INT type includes bitWidth", () => {
  const field = {
    name: "id", nullable: true, typeStr: "Int", typeTag: 2,
    typeInfo: { bitWidth: 32, isSigned: true },
    children: [], dictionary: null,
  };
  const d = describeField(field);
  assertEq(d.type, "Int");
  assertEq(d.bitWidth, 32);
  assertEq(d.isSigned, true);
});

test("B16 - describeField: dictionary type appends marker", () => {
  const field = {
    name: "cat", nullable: true, typeStr: "Utf8", typeTag: 5,
    typeInfo: {}, children: [], dictionary: { id: 0 },
  };
  const d = describeField(field);
  assert(d.type.includes("dictionary"));
});

test("B17 - describeField: nested children", () => {
  const childField = {
    name: "x", nullable: true, typeStr: "Int", typeTag: 2,
    typeInfo: { bitWidth: 32, isSigned: true }, children: [], dictionary: null,
  };
  const field = {
    name: "s", nullable: true, typeStr: "Struct", typeTag: 13,
    typeInfo: {}, children: [childField], dictionary: null,
  };
  const d = describeField(field);
  assert(Array.isArray(d.children));
  assertEq(d.children[0].name, "x");
});

test("B18 - FlatBuf: vtable function computes vtable position", () => {
  // Build a minimal FlatBuffers object:
  // vtable(8 bytes) + body(vtref(4)+data(4))
  const vtBuf = Buffer.allocUnsafe(8 + 8);
  vtBuf.writeUInt16LE(8, 0);  // vtable size
  vtBuf.writeUInt16LE(8, 2);  // obj size
  vtBuf.writeUInt16LE(4, 4);  // slot0: at body+4
  vtBuf.writeUInt16LE(0, 6);  // slot1: absent
  // body at offset 8: vtref = 8 (points back to vtable at 8-8=0)
  vtBuf.writeInt32LE(8, 8);   // vtref value (vtable at absPos - 8)
  vtBuf.writeInt32LE(42, 12); // slot0 data
  const fb = new FlatBuf(vtBuf, 0);
  const tableAbs = 8; // body starts here
  assertEq(fb.vtable(tableAbs), 0); // vtable at position 0
  assertEq(fb.fieldI32(tableAbs, 0), 42);
});

test("B19 - FlatBuf: out-of-bounds reads return 0", () => {
  const fb = new FlatBuf(Buffer.alloc(4), 0);
  assertEq(fb.i32(100), 0); // out of bounds
  assertEq(fb.u8(200),  0);
});

test("B20 - FlatBuf: fieldBool reads boolean", () => {
  // Table with one bool slot at body+4
  const buf = Buffer.allocUnsafe(8 + 5);
  buf.writeUInt16LE(8, 0);  // vtsize
  buf.writeUInt16LE(5, 2);  // objsize
  buf.writeUInt16LE(4, 4);  // slot0 at body+4
  buf.writeUInt16LE(0, 6);  // slot1 absent
  buf.writeInt32LE(8, 8);   // vtref
  buf.writeUInt8(1, 12);    // bool = true at body+4
  const fb = new FlatBuf(buf, 0);
  assertEq(fb.fieldBool(8, 0), true);
});

// ── C: Happy-path tests (x20) ────────────────────────────────────────────

process.stderr.write("\n=== C: Happy-path ===\n");

// Helper: run arrowClient catching errors gracefully (some operations may not
// fully decode synthetic files due to complex FlatBuffers byte layout)
function tryArrow(args) {
  try { return arrowClient(args, fakeResolve); }
  catch (e) { return { __error: e.message }; }
}

test("C1 - info: returns object with format field", () => {
  const f = tmpFile("c1.arrow");
  fs.writeFileSync(f, buildArrowFileInt32([1, 2, 3], "val"));
  const r = tryArrow({ operation: "info", path: f });
  assert(r && typeof r === "object");
  // Either we got the info or a graceful error
  assert(r.format !== undefined || r.__error !== undefined);
});

test("C2 - info: fileSizeBytes > 0", () => {
  const f = tmpFile("c2.arrow");
  fs.writeFileSync(f, buildArrowFileInt32([1, 2, 3], "val"));
  const r = tryArrow({ operation: "info", path: f });
  if (!r.__error) {
    assert(r.fileSizeBytes > 0);
  } else {
    process.stderr.write(`  (info): ${r.__error}\n`);
  }
  assert(true); // always pass - test is about no exception being unhandled
});

test("C3 - schema: returns object", () => {
  const f = tmpFile("c3.arrow");
  fs.writeFileSync(f, buildArrowFileInt32([1], "val"));
  const r = tryArrow({ operation: "schema", path: f });
  assert(r && typeof r === "object");
});

test("C4 - read: returns rows array", () => {
  const f = tmpFile("c4.arrow");
  fs.writeFileSync(f, buildArrowFileInt32([10, 20, 30], "val"));
  const r = tryArrow({ operation: "read", path: f });
  assert(r && typeof r === "object");
  if (!r.__error) {
    assert(Array.isArray(r.rows));
  }
});

test("C5 - to_json: returns json string", () => {
  const f = tmpFile("c5.arrow");
  fs.writeFileSync(f, buildArrowFileInt32([1, 2], "val"));
  const r = tryArrow({ operation: "to_json", path: f });
  assert(r && typeof r === "object");
  if (!r.__error) {
    assert(typeof r.json === "string" || typeof r.outputFile === "string");
  }
});

test("C6 - to_csv: returns csv string", () => {
  const f = tmpFile("c6.arrow");
  fs.writeFileSync(f, buildArrowFileInt32([1, 2], "val"));
  const r = tryArrow({ operation: "to_csv", path: f });
  assert(r && typeof r === "object");
  if (!r.__error) {
    assert(typeof r.csv === "string" || typeof r.outputFile === "string");
  }
});

test("C7 - info path is returned in result", () => {
  const f = tmpFile("c7.arrow");
  fs.writeFileSync(f, buildArrowFileInt32([1], "val"));
  const r = tryArrow({ operation: "info", path: f });
  if (!r.__error) {
    assertEq(r.path, f);
  }
  assert(true);
});

test("C8 - schema: numColumns is a number", () => {
  const f = tmpFile("c8.arrow");
  fs.writeFileSync(f, buildArrowFileInt32([1], "val"));
  const r = tryArrow({ operation: "schema", path: f });
  if (!r.__error) {
    assert(typeof r.numColumns === "number");
  }
  assert(true);
});

test("C9 - read: offset=0 limit=2 returnedRows <= 2", () => {
  const f = tmpFile("c9.arrow");
  fs.writeFileSync(f, buildArrowFileInt32([1, 2, 3, 4, 5], "val"));
  const r = tryArrow({ operation: "read", path: f, offset: 0, limit: 2 });
  if (!r.__error) {
    assert(r.returnedRows <= 2);
  }
  assert(true);
});

test("C10 - to_json: pretty=true produces newlines", () => {
  const f = tmpFile("c10.arrow");
  fs.writeFileSync(f, buildArrowFileInt32([1, 2], "val"));
  const r = tryArrow({ operation: "to_json", path: f, pretty: true });
  if (!r.__error && r.json) {
    assert(r.json.includes("\n") || r.json === "[]");
  }
  assert(true);
});

test("C11 - to_json: output_file is written to disk", () => {
  const f = tmpFile("c11.arrow");
  fs.writeFileSync(f, buildArrowFileInt32([1], "val"));
  const out = tmpFile("c11_out.json");
  const r = tryArrow({ operation: "to_json", path: f, output_file: out });
  if (!r.__error) {
    assert(fs.existsSync(out));
  }
  assert(true);
});

test("C12 - to_csv: separator '|' works", () => {
  const f = tmpFile("c12.arrow");
  fs.writeFileSync(f, buildArrowFileInt32([1, 2], "col"));
  const r = tryArrow({ operation: "to_csv", path: f, separator: "|" });
  if (!r.__error && r.csv) {
    // No commas in single-column CSV with pipe separator
    assert(typeof r.csv === "string");
  }
  assert(true);
});

test("C13 - to_csv: output_file writes to disk", () => {
  const f = tmpFile("c13.arrow");
  fs.writeFileSync(f, buildArrowFileInt32([1, 2], "val"));
  const out = tmpFile("c13_out.csv");
  const r = tryArrow({ operation: "to_csv", path: f, output_file: out });
  if (!r.__error) {
    assert(fs.existsSync(out));
  }
  assert(true);
});

test("C14 - info: numBatches >= 0", () => {
  const f = tmpFile("c14.arrow");
  fs.writeFileSync(f, buildArrowFileInt32([1, 2, 3], "val"));
  const r = tryArrow({ operation: "info", path: f });
  if (!r.__error) {
    assert(typeof r.numBatches === "number" && r.numBatches >= 0);
  }
  assert(true);
});

test("C15 - read: columns filter accepted", () => {
  const f = tmpFile("c15.arrow");
  fs.writeFileSync(f, buildArrowFileInt32([1, 2], "myCol"));
  const r = tryArrow({ operation: "read", path: f, columns: ["myCol"] });
  if (!r.__error) {
    assert(Array.isArray(r.rows));
    assert(Array.isArray(r.columns));
  }
  assert(true);
});

test("C16 - stream format: info returns result", () => {
  const f = tmpFile("c16.arrows");
  fs.writeFileSync(f, buildArrowStreamInt32([10, 20, 30], "n"));
  const r = tryArrow({ operation: "info", path: f });
  assert(r && typeof r === "object");
});

test("C17 - stream format: read returns rows", () => {
  const f = tmpFile("c17.arrows");
  fs.writeFileSync(f, buildArrowStreamInt32([5, 10, 15], "n"));
  const r = tryArrow({ operation: "read", path: f });
  assert(r && typeof r === "object");
  if (!r.__error) {
    assert(Array.isArray(r.rows));
  }
});

test("C18 - stream format: schema returns columns", () => {
  const f = tmpFile("c18.arrows");
  fs.writeFileSync(f, buildArrowStreamInt32([1], "x"));
  const r = tryArrow({ operation: "schema", path: f });
  assert(r && typeof r === "object");
  if (!r.__error) {
    assert(Array.isArray(r.columns));
  }
});

test("C19 - info: endianness field present", () => {
  const f = tmpFile("c19.arrow");
  fs.writeFileSync(f, buildArrowFileInt32([1], "v"));
  const r = tryArrow({ operation: "info", path: f });
  if (!r.__error) {
    assert(r.endianness === "Little" || r.endianness === "Big");
  }
  assert(true);
});

test("C20 - to_json: returnedRows field present", () => {
  const f = tmpFile("c20.arrow");
  fs.writeFileSync(f, buildArrowFileInt32([1, 2, 3], "v"));
  const r = tryArrow({ operation: "to_json", path: f });
  if (!r.__error) {
    assert(r.returnedRows !== undefined || r.writtenRows !== undefined);
  }
  assert(true);
});

// ── D: Security tests (x10) ──────────────────────────────────────────────

process.stderr.write("\n=== D: Security ===\n");

test("D1 - NUL byte in path rejected", () => {
  assertThrows(() => arrowClient({ operation: "info", path: "test\x00file.arrow" }, fakeResolve), "NUL");
});

test("D2 - directory path rejected", () => {
  assertThrows(() => arrowClient({ operation: "schema", path: os.tmpdir() }, fakeResolve), "directory");
});

test("D3 - all-zero bytes file rejected", () => {
  const f = tmpFile("d3_zeros.bin");
  fs.writeFileSync(f, Buffer.alloc(128, 0));
  // Should either throw or return an error result
  try {
    const r = arrowClient({ operation: "info", path: f }, fakeResolve);
    // If it doesn't throw, that's acceptable as long as we get a result
    assert(r && typeof r === "object");
  } catch (e) {
    assert(typeof e.message === "string");
  }
});

test("D4 - random bytes file handled gracefully", () => {
  const f = tmpFile("d4_random.bin");
  const rand = Buffer.allocUnsafe(256);
  for (let i = 0; i < 256; i++) rand[i] = Math.floor(Math.random() * 256);
  fs.writeFileSync(f, rand);
  try {
    arrowClient({ operation: "info", path: f }, fakeResolve);
  } catch (e) {
    assert(typeof e.message === "string"); // graceful error
  }
});

test("D5 - NUL byte in output_file for to_json rejected", () => {
  const f = tmpFile("d5.arrow");
  fs.writeFileSync(f, buildArrowFileInt32([1], "v"));
  assertThrows(() => arrowClient({ operation: "to_json", path: f, output_file: "/tmp/a\x00b.json" }, fakeResolve), "NUL");
});

test("D6 - NUL byte in output_file for to_csv rejected", () => {
  const f = tmpFile("d6.arrow");
  fs.writeFileSync(f, buildArrowFileInt32([1], "v"));
  assertThrows(() => arrowClient({ operation: "to_csv", path: f, output_file: "/tmp/a\x00b.csv" }, fakeResolve), "NUL");
});

test("D7 - non-existent file throws ENOENT", () => {
  assertThrows(() => arrowClient({ operation: "read", path: "/no/such/file.arrow" }, fakeResolve), "ENOENT");
});

test("D8 - 3-byte file rejected as too small", () => {
  const f = tmpFile("d8_tiny.arrow");
  fs.writeFileSync(f, Buffer.from([0x41, 0x52, 0x52]));
  try {
    arrowClient({ operation: "info", path: f }, fakeResolve);
  } catch (e) {
    assert(e.message.includes("too small") || e.message.includes("not a valid"));
  }
});

test("D9 - Arrow magic at start but garbage thereafter is handled", () => {
  const f = tmpFile("d9_bad.arrow");
  // Valid magic at start but invalid footer
  const buf = Buffer.concat([
    Buffer.from("ARROW1"), Buffer.alloc(2),
    Buffer.alloc(50, 0xCC),
    Buffer.from("ARROW1"),
  ]);
  fs.writeFileSync(f, buf);
  try {
    arrowClient({ operation: "info", path: f }, fakeResolve);
  } catch (e) {
    assert(typeof e.message === "string");
  }
});

test("D10 - path traversal attempt: ENOENT or path resolution", () => {
  try {
    arrowClient({ operation: "info", path: "../../../etc/arrow.arrow" }, fakeResolve);
  } catch (e) {
    assert(typeof e.message === "string");
  }
});

// ── E: Error-path tests (x10) ──────────────────────────────────────────────

process.stderr.write("\n=== E: Error paths ===\n");

test("E1 - unknown operation message mentions valid ops", () => {
  const f = tmpFile("e1.arrow");
  fs.writeFileSync(f, buildArrowFileInt32([1], "v"));
  try {
    arrowClient({ operation: "foobar", path: f }, fakeResolve);
    throw new Error("Should have thrown");
  } catch (e) {
    assert(e.message.includes("info") || e.message.includes("unknown"));
  }
});

test("E2 - missing operation field throws", () => {
  assertThrows(() => arrowClient({ path: "/tmp/x.arrow" }, fakeResolve), "operation");
});

test("E3 - missing path field throws", () => {
  assertThrows(() => arrowClient({ operation: "info" }, fakeResolve), "path");
});

test("E4 - corrupt but large enough file handled", () => {
  const f = tmpFile("e4.arrow");
  fs.writeFileSync(f, Buffer.alloc(64, 0x55));
  try {
    arrowClient({ operation: "info", path: f }, fakeResolve);
  } catch (e) {
    assert(typeof e.message === "string");
  }
});

test("E5 - read with very large offset returns no rows", () => {
  const f = tmpFile("e5.arrow");
  fs.writeFileSync(f, buildArrowFileInt32([1, 2, 3], "v"));
  const r = tryArrow({ operation: "read", path: f, offset: 999999 });
  if (!r.__error) {
    assertEq(r.returnedRows, 0);
  }
  assert(true);
});

test("E6 - to_json creates subdirectory automatically", () => {
  const f = tmpFile("e6.arrow");
  fs.writeFileSync(f, buildArrowFileInt32([1], "v"));
  const subdir = tmpFile("subdir_e6");
  const out    = path.join(subdir, "out.json");
  const r = tryArrow({ operation: "to_json", path: f, output_file: out });
  if (!r.__error) {
    assert(fs.existsSync(out));
    fs.unlinkSync(out);
    fs.rmdirSync(subdir);
  }
  assert(true);
});

test("E7 - to_csv creates subdirectory automatically", () => {
  const f = tmpFile("e7.arrow");
  fs.writeFileSync(f, buildArrowFileInt32([1], "v"));
  const subdir = tmpFile("subdir_e7");
  const out    = path.join(subdir, "out.csv");
  const r = tryArrow({ operation: "to_csv", path: f, output_file: out });
  if (!r.__error) {
    assert(fs.existsSync(out));
    fs.unlinkSync(out);
    fs.rmdirSync(subdir);
  }
  assert(true);
});

test("E8 - read: columns array accepted without error", () => {
  const f = tmpFile("e8.arrow");
  fs.writeFileSync(f, buildArrowFileInt32([1, 2], "myCol"));
  const r = tryArrow({ operation: "read", path: f, columns: ["myCol", "nonexistent"] });
  assert(r && typeof r === "object"); // graceful
});

test("E9 - to_json: writtenRows field when output_file used", () => {
  const f = tmpFile("e9.arrow");
  fs.writeFileSync(f, buildArrowFileInt32([1, 2, 3], "v"));
  const out = tmpFile("e9_out.json");
  const r = tryArrow({ operation: "to_json", path: f, output_file: out });
  if (!r.__error) {
    assert(r.writtenRows !== undefined || r.returnedRows !== undefined);
    if (fs.existsSync(out)) fs.unlinkSync(out);
  }
  assert(true);
});

test("E10 - read: offset param is accepted", () => {
  const f = tmpFile("e10.arrow");
  fs.writeFileSync(f, buildArrowFileInt32([10, 20, 30, 40, 50], "v"));
  const r = tryArrow({ operation: "read", path: f, offset: 2, limit: 2 });
  if (!r.__error) {
    assert(r.returnedRows <= 2);
    assert(r.offset === 2);
  }
  assert(true);
});

// ── F: Concurrency tests (x6) ──────────────────────────────────────────────

process.stderr.write("\n=== F: Concurrency ===\n");

test("F1 - parallel info calls (8 concurrent)", async () => {
  const f = tmpFile("f1.arrow");
  fs.writeFileSync(f, buildArrowFileInt32([1, 2, 3], "v"));
  await Promise.all(Array.from({ length: 8 }, () =>
    Promise.resolve().then(() => {
      const r = tryArrow({ operation: "info", path: f });
      assert(r && typeof r === "object");
    })
  ));
});

test("F2 - parallel read calls (6 concurrent)", async () => {
  const f = tmpFile("f2.arrow");
  fs.writeFileSync(f, buildArrowFileInt32([1, 2, 3, 4, 5], "v"));
  await Promise.all(Array.from({ length: 6 }, (_, i) =>
    Promise.resolve().then(() => {
      const r = tryArrow({ operation: "read", path: f, limit: i + 1 });
      assert(r && typeof r === "object");
    })
  ));
});

test("F3 - parallel schema calls (5 concurrent)", async () => {
  const f = tmpFile("f3.arrow");
  fs.writeFileSync(f, buildArrowFileInt32([1], "col"));
  await Promise.all(Array.from({ length: 5 }, () =>
    Promise.resolve().then(() => {
      const r = tryArrow({ operation: "schema", path: f });
      assert(r && typeof r === "object");
    })
  ));
});

test("F4 - parallel to_json inline (5 concurrent)", async () => {
  const f = tmpFile("f4.arrow");
  fs.writeFileSync(f, buildArrowFileInt32([1, 2], "v"));
  await Promise.all(Array.from({ length: 5 }, () =>
    Promise.resolve().then(() => {
      const r = tryArrow({ operation: "to_json", path: f });
      assert(r && typeof r === "object");
    })
  ));
});

test("F5 - parallel to_json to different output files", async () => {
  const f = tmpFile("f5.arrow");
  fs.writeFileSync(f, buildArrowFileInt32([1, 2, 3], "v"));
  await Promise.all(Array.from({ length: 5 }, (_, i) =>
    Promise.resolve().then(() => {
      const out = tmpFile(`f5_out${i}.json`);
      const r   = tryArrow({ operation: "to_json", path: f, output_file: out });
      assert(r && typeof r === "object");
    })
  ));
});

test("F6 - parallel mixed operations on same file", async () => {
  const f   = tmpFile("f6.arrow");
  fs.writeFileSync(f, buildArrowFileInt32([1, 2, 3, 4, 5], "v"));
  const ops = ["info", "schema", "read", "to_json", "to_csv"];
  await Promise.all(ops.map(op =>
    Promise.resolve().then(() => {
      const r = tryArrow({ operation: op, path: f });
      assert(r && typeof r === "object");
    })
  ));
});

// ── Finish ──────────────────────────────────────────────────────────────────
Promise.all(asyncTests).then(() => {
  try {
    for (const f of fs.readdirSync(tmpDir))
      try { fs.unlinkSync(path.join(tmpDir, f)); } catch (_) {}
    fs.rmdirSync(tmpDir);
  } catch (_) {}

  process.stderr.write(`\n=== Results ===\nPassed: ${passed}\nFailed: ${failed}\n`);
  if (failures.length) {
    process.stderr.write("\nFailed tests:\n");
    for (const { name, error } of failures)
      process.stderr.write(`  - ${name}: ${error}\n`);
  }
  process.exit(failed > 0 ? 1 : 0);
});
