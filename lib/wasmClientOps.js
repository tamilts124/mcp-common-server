"use strict";
// ── wasm_client — zero-dependency WebAssembly binary inspector ────────────────
// Pure Node.js (fs + Buffer); no npm deps.
// Operations: info, imports, exports, types, functions, memory, validate
// Formats: .wasm (WebAssembly Binary Format 1.0)
// Security: 50 MB file cap; NUL-byte path guard; directory guard

const fs   = require("fs");
const path = require("path");

// ── Constants ──────────────────────────────────────────────────────────────────
const MAX_FILE_SIZE   = 50 * 1024 * 1024; // 50 MB
const WASM_MAGIC      = 0x6D736100;        // "\0asm" as LE uint32
const WASM_VERSION    = 1;
const MAX_ITEMS       = 10000;             // cap on any decoded list

// Section IDs per WebAssembly spec §5.5
const SEC = {
  CUSTOM:   0,
  TYPE:     1,
  IMPORT:   2,
  FUNCTION: 3,
  TABLE:    4,
  MEMORY:   5,
  GLOBAL:   6,
  EXPORT:   7,
  START:    8,
  ELEMENT:  9,
  CODE:     10,
  DATA:     11,
  DATACOUNT:12,
};

const SEC_NAMES = {
  0:"custom",1:"type",2:"import",3:"function",4:"table",
  5:"memory",6:"global",7:"export",8:"start",9:"element",
  10:"code",11:"data",12:"datacount",
};

// Import/export kinds
const KIND = { 0:"function", 1:"table", 2:"memory", 3:"global" };

// ValType
const VALTYPE = {
  0x7F:"i32", 0x7E:"i64", 0x7D:"f32", 0x7C:"f64",
  0x7B:"v128", 0x70:"funcref", 0x6F:"externref",
};

// ── Utility ────────────────────────────────────────────────────────────────────
function readFile(filePath) {
  if (filePath.includes("\0")) throw new Error("wasm_client: path contains NUL byte.");
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) throw new Error("wasm_client: path is a directory.");
  if (stat.size > MAX_FILE_SIZE)
    throw new Error(`wasm_client: file too large (${stat.size} B; max ${MAX_FILE_SIZE} B).`);
  return { buf: fs.readFileSync(filePath), fileSize: stat.size };
}

// ── LEB128 decoders ────────────────────────────────────────────────────────────
function readULEB128(buf, pos) {
  let result = 0, shift = 0;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result |= (byte & 0x7F) << shift;
    shift += 7;
    if (!(byte & 0x80)) break;
    if (shift > 35) throw new Error("wasm_client: LEB128 overflow.");
  }
  return { value: result >>> 0, pos };
}

function readSLEB128(buf, pos) {
  let result = 0, shift = 0;
  let byte;
  while (pos < buf.length) {
    byte = buf[pos++];
    result |= (byte & 0x7F) << shift;
    shift += 7;
    if (!(byte & 0x80)) break;
    if (shift > 35) throw new Error("wasm_client: SLEB128 overflow.");
  }
  if (shift < 32 && (byte & 0x40)) result |= -(1 << shift);
  return { value: result | 0, pos };
}

// ── String decoder ────────────────────────────────────────────────────────────
function readName(buf, pos) {
  const { value: len, pos: p1 } = readULEB128(buf, pos);
  const name = buf.slice(p1, p1 + len).toString("utf8");
  return { name, pos: p1 + len };
}

// ── ValType reader ────────────────────────────────────────────────────────────
function readValType(buf, pos) {
  const byte = buf[pos];
  return { type: VALTYPE[byte] || `0x${byte.toString(16)}`, pos: pos + 1 };
}

// ── Section scanner ────────────────────────────────────────────────────────────
function scanSections(buf) {
  if (buf.length < 8)
    throw new Error("wasm_client: file too short to be a valid Wasm module (< 8 bytes).");
  const magic   = buf.readUInt32LE(0);
  const version = buf.readUInt32LE(4);
  if (magic !== WASM_MAGIC)
    throw new Error(`wasm_client: not a WebAssembly file (magic bytes 0x${magic.toString(16).padStart(8, "0")}, expected 0x6d736100 [\\0asm]).`);
  if (version !== WASM_VERSION)
    throw new Error(`wasm_client: unsupported WebAssembly version ${version} (only v1 supported).`);
  if (version !== WASM_VERSION)
    throw new Error(`wasm_client: unsupported WebAssembly version ${version} (only v1 supported).`);

  const sections = [];
  let pos = 8;
  while (pos < buf.length) {
    if (pos >= buf.length) break;
    const id = buf[pos++];
    const { value: size, pos: p1 } = readULEB128(buf, pos);
    pos = p1;
    sections.push({ id, size, dataStart: pos, dataEnd: pos + size });
    pos += size;
    if (sections.length > 1000) break; // sanity guard
  }
  return { sections, version };
}

// ── Type section ──────────────────────────────────────────────────────────────
function parseTypeSection(buf, sec) {
  const types = [];
  let pos = sec.dataStart;
  const { value: count, pos: p1 } = readULEB128(buf, pos);
  pos = p1;
  for (let i = 0; i < Math.min(count, MAX_ITEMS) && pos < sec.dataEnd; i++) {
    if (buf[pos] !== 0x60)
      throw new Error(`wasm_client: type[${i}] not a function type (0x${buf[pos].toString(16)}).`);
    pos++;
    const params = [];
    const { value: pc, pos: p2 } = readULEB128(buf, pos); pos = p2;
    for (let j = 0; j < pc && pos < sec.dataEnd; j++) {
      const { type, pos: p3 } = readValType(buf, pos); pos = p3;
      params.push(type);
    }
    const results = [];
    const { value: rc, pos: p4 } = readULEB128(buf, pos); pos = p4;
    for (let j = 0; j < rc && pos < sec.dataEnd; j++) {
      const { type, pos: p5 } = readValType(buf, pos); pos = p5;
      results.push(type);
    }
    types.push({ index: i, params, results,
      signature: `(${params.join(", ")}) -> (${results.join(", ")})` });
  }
  return types;
}

// ── Import section ────────────────────────────────────────────────────────────
function parseImportSection(buf, sec) {
  const imports = [];
  let pos = sec.dataStart;
  const { value: count, pos: p1 } = readULEB128(buf, pos); pos = p1;
  for (let i = 0; i < Math.min(count, MAX_ITEMS) && pos < sec.dataEnd; i++) {
    const { name: module, pos: p2 } = readName(buf, pos); pos = p2;
    const { name,         pos: p3 } = readName(buf, pos); pos = p3;
    const kind = buf[pos++];
    const entry = { index: i, module, name, kind: KIND[kind] || `unknown(${kind})` };
    if (kind === 0) { // function
      const { value: typeIdx, pos: p4 } = readULEB128(buf, pos); pos = p4;
      entry.typeIndex = typeIdx;
    } else if (kind === 1) { // table
      const refType = buf[pos++];
      entry.refType = VALTYPE[refType] || `0x${refType.toString(16)}`;
      const { value: flags, pos: p4 } = readULEB128(buf, pos); pos = p4;
      const { value: min,   pos: p5 } = readULEB128(buf, p4); pos = p5;
      entry.limits = { flags, min };
      if (flags & 1) { const { value: max, pos: p6 } = readULEB128(buf, pos); pos = p6; entry.limits.max = max; }
    } else if (kind === 2) { // memory
      const { value: flags, pos: p4 } = readULEB128(buf, pos); pos = p4;
      const { value: min,   pos: p5 } = readULEB128(buf, p4); pos = p5;
      entry.limits = { flags, min, minPages: min, minBytes: min * 65536 };
      if (flags & 1) { const { value: max, pos: p6 } = readULEB128(buf, pos); pos = p6; entry.limits.max = max; entry.limits.maxBytes = max * 65536; }
    } else if (kind === 3) { // global
      const { type: gType, pos: p4 } = readValType(buf, pos); pos = p4;
      entry.globalType = gType;
      entry.mutable    = buf[pos++] === 1;
    } else {
      break; // unknown kind — stop
    }
    imports.push(entry);
  }
  return imports;
}

// ── Export section ────────────────────────────────────────────────────────────
function parseExportSection(buf, sec) {
  const exports_ = [];
  let pos = sec.dataStart;
  const { value: count, pos: p1 } = readULEB128(buf, pos); pos = p1;
  for (let i = 0; i < Math.min(count, MAX_ITEMS) && pos < sec.dataEnd; i++) {
    const { name, pos: p2 } = readName(buf, pos); pos = p2;
    const kind  = buf[pos++];
    const { value: idx, pos: p3 } = readULEB128(buf, pos); pos = p3;
    exports_.push({ index: i, name, kind: KIND[kind] || `unknown(${kind})`, itemIndex: idx });
  }
  return exports_;
}

// ── Function section ──────────────────────────────────────────────────────────
function parseFunctionSection(buf, sec) {
  const indices = [];
  let pos = sec.dataStart;
  const { value: count, pos: p1 } = readULEB128(buf, pos); pos = p1;
  for (let i = 0; i < Math.min(count, MAX_ITEMS) && pos < sec.dataEnd; i++) {
    const { value: typeIdx, pos: p2 } = readULEB128(buf, pos); pos = p2;
    indices.push(typeIdx);
  }
  return indices;
}

// ── Memory section ────────────────────────────────────────────────────────────
function parseMemorySection(buf, sec) {
  const memories = [];
  let pos = sec.dataStart;
  const { value: count, pos: p1 } = readULEB128(buf, pos); pos = p1;
  for (let i = 0; i < Math.min(count, MAX_ITEMS) && pos < sec.dataEnd; i++) {
    const { value: flags, pos: p2 } = readULEB128(buf, pos); pos = p2;
    const { value: min,   pos: p3 } = readULEB128(buf, p2); pos = p3;
    const mem = {
      index: i, flags, minPages: min, minBytes: min * 65536,
      shared: !!(flags & 2), is64: !!(flags & 4),
    };
    if (flags & 1) {
      const { value: max, pos: p4 } = readULEB128(buf, pos); pos = p4;
      mem.maxPages = max; mem.maxBytes = max * 65536;
    }
    memories.push(mem);
  }
  return memories;
}

// ── Global section ────────────────────────────────────────────────────────────
function parseGlobalSection(buf, sec) {
  const globals = [];
  let pos = sec.dataStart;
  const { value: count, pos: p1 } = readULEB128(buf, pos); pos = p1;
  for (let i = 0; i < Math.min(count, MAX_ITEMS) && pos < sec.dataEnd; i++) {
    const { type, pos: p2 } = readValType(buf, pos); pos = p2;
    const mutable = buf[pos++] === 1;
    // Skip init expression (opcodes until 0x0B end)
    const initStart = pos;
    let depth = 0;
    while (pos < sec.dataEnd) {
      const op = buf[pos++];
      if (op === 0x0B && depth === 0) break;
      if (op === 0x02 || op === 0x03 || op === 0x04) depth++;
      if (op === 0x0B) depth--;
    }
    const initBytes = buf.slice(initStart, pos - 1);
    globals.push({ index: i, type, mutable, initBytes: initBytes.toString("hex") });
  }
  return globals;
}

// ── Table section ─────────────────────────────────────────────────────────────
function parseTableSection(buf, sec) {
  const tables = [];
  let pos = sec.dataStart;
  const { value: count, pos: p1 } = readULEB128(buf, pos); pos = p1;
  for (let i = 0; i < Math.min(count, MAX_ITEMS) && pos < sec.dataEnd; i++) {
    const refType = buf[pos++];
    const { value: flags, pos: p2 } = readULEB128(buf, pos); pos = p2;
    const { value: min,   pos: p3 } = readULEB128(buf, p2); pos = p3;
    const tbl = { index: i, refType: VALTYPE[refType] || `0x${refType.toString(16)}`, flags, minElements: min };
    if (flags & 1) { const { value: max, pos: p4 } = readULEB128(buf, pos); pos = p4; tbl.maxElements = max; }
    tables.push(tbl);
  }
  return tables;
}

// ── Code section (sizes only) ─────────────────────────────────────────────────
function parseCodeSection(buf, sec) {
  const functions = [];
  let pos = sec.dataStart;
  const { value: count, pos: p1 } = readULEB128(buf, pos); pos = p1;
  for (let i = 0; i < Math.min(count, MAX_ITEMS) && pos < sec.dataEnd; i++) {
    const { value: size, pos: p2 } = readULEB128(buf, pos); pos = p2;
    // Parse locals briefly
    const bodyStart = pos;
    const { value: localGroups, pos: p3 } = readULEB128(buf, pos); pos = p3;
    const locals = [];
    for (let j = 0; j < Math.min(localGroups, 64) && pos < bodyStart + size; j++) {
      const { value: cnt, pos: p4 } = readULEB128(buf, pos); pos = p4;
      const { type, pos: p5 } = readValType(buf, pos); pos = p5;
      locals.push({ count: cnt, type });
    }
    functions.push({ functionIndex: i, bodySize: size, locals });
    pos = bodyStart + size;
  }
  return functions;
}

// ── Custom sections (names) ────────────────────────────────────────────────────
function parseCustomSections(buf, sections) {
  const customs = [];
  for (const sec of sections.filter(s => s.id === SEC.CUSTOM)) {
    const { name, pos } = readName(buf, sec.dataStart);
    customs.push({ name, payloadSize: sec.dataEnd - pos });
  }
  return customs;
}

// ── Start section ─────────────────────────────────────────────────────────────
function parseStartSection(buf, sec) {
  const { value: funcIdx } = readULEB128(buf, sec.dataStart);
  return funcIdx;
}

// ── Data section (count only) ─────────────────────────────────────────────────
function parseDataSectionCount(buf, sec) {
  const { value: count } = readULEB128(buf, sec.dataStart);
  return count;
}

// ── Element section (count only) ──────────────────────────────────────────────
function parseElementSectionCount(buf, sec) {
  const { value: count } = readULEB128(buf, sec.dataStart);
  return count;
}

// ── Main parser ───────────────────────────────────────────────────────────────
function parseWasm(buf, fileSize) {
  const { sections, version } = scanSections(buf);
  const find = id => sections.find(s => s.id === id);
  const all  = id => sections.filter(s => s.id === id);

  const typeSec    = find(SEC.TYPE);
  const importSec  = find(SEC.IMPORT);
  const funcSec    = find(SEC.FUNCTION);
  const tableSec   = find(SEC.TABLE);
  const memSec     = find(SEC.MEMORY);
  const globalSec  = find(SEC.GLOBAL);
  const exportSec  = find(SEC.EXPORT);
  const startSec   = find(SEC.START);
  const codeSec    = find(SEC.CODE);

  const types    = typeSec   ? parseTypeSection(buf, typeSec)       : [];
  const imports  = importSec ? parseImportSection(buf, importSec)   : [];
  const funcIdx  = funcSec   ? parseFunctionSection(buf, funcSec)   : [];
  const tables   = tableSec  ? parseTableSection(buf, tableSec)     : [];
  const memories = memSec    ? parseMemorySection(buf, memSec)      : [];
  const globals  = globalSec ? parseGlobalSection(buf, globalSec)   : [];
  const exports_ = exportSec ? parseExportSection(buf, exportSec)   : [];
  const codeBodies = codeSec ? parseCodeSection(buf, codeSec)       : [];
  const customs  = parseCustomSections(buf, sections);
  const startFuncIdx = startSec ? parseStartSection(buf, startSec) : null;

  // Merge function type indices with code bodies and imports
  const importedFunctions = imports.filter(i => i.kind === "function");
  const importedFuncCount = importedFunctions.length;

  const functions = funcIdx.map((typeIdx, i) => {
    const info = {
      functionIndex: i + importedFuncCount,
      typeIndex: typeIdx,
      isImported: false,
    };
    if (types[typeIdx]) info.signature = types[typeIdx].signature;
    if (codeBodies[i])  { info.bodySize = codeBodies[i].bodySize; info.locals = codeBodies[i].locals; }
    return info;
  });

  // Data / element counts
  const dataSec = find(SEC.DATA);
  const elemSec = find(SEC.ELEMENT);
  const dataCount    = dataSec ? parseDataSectionCount(buf, dataSec)    : 0;
  const elementCount = elemSec ? parseElementSectionCount(buf, elemSec) : 0;

  const sectionSummary = sections.map(s => ({
    id: s.id, name: SEC_NAMES[s.id] || "unknown", size: s.size, dataStart: s.dataStart,
  }));

  return {
    version, fileSize, sections: sectionSummary,
    types, imports, exports: exports_, functions,
    memories, tables, globals, customs,
    startFunctionIndex: startFuncIdx,
    dataSegmentCount: dataCount,
    elementSegmentCount: elementCount,
    counts: {
      types:     types.length,
      imports:   imports.length,
      exports:   exports_.length,
      functions: functions.length + importedFuncCount,
      definedFunctions: functions.length,
      importedFunctions: importedFuncCount,
      memories:  memories.length + imports.filter(i => i.kind === "memory").length,
      tables:    tables.length   + imports.filter(i => i.kind === "table").length,
      globals:   globals.length  + imports.filter(i => i.kind === "global").length,
      customs:   customs.length,
    },
  };
}

// ── Operation handlers ────────────────────────────────────────────────────────
function opInfo(parsed, filePath) {
  const c = parsed.counts;
  return {
    path: filePath,
    operation: "info",
    wasmVersion: parsed.version,
    fileSize: parsed.fileSize,
    sectionCount: parsed.sections.length,
    sections: parsed.sections,
    customSections: parsed.customs,
    startFunctionIndex: parsed.startFunctionIndex,
    counts: {
      types:     c.types,
      functions: c.functions,
      imports:   c.imports,
      exports:   c.exports,
      memories:  c.memories,
      tables:    c.tables,
      globals:   c.globals,
      dataSegments: parsed.dataSegmentCount,
      elementSegments: parsed.elementSegmentCount,
      customSections: c.customs,
    },
    importedFunctionCount:  c.importedFunctions,
    definedFunctionCount:   c.definedFunctions,
    hasStartFunction: parsed.startFunctionIndex !== null,
  };
}

function opImports(parsed, filePath) {
  const imports = parsed.imports;
  // Attach type signature to function imports
  const detailed = imports.map(imp => {
    if (imp.kind === "function" && imp.typeIndex !== undefined && parsed.types[imp.typeIndex])
      return { ...imp, signature: parsed.types[imp.typeIndex].signature };
    return imp;
  });
  return {
    path: filePath, operation: "imports",
    count: imports.length,
    byKind: {
      function: imports.filter(i => i.kind === "function").length,
      memory:   imports.filter(i => i.kind === "memory").length,
      table:    imports.filter(i => i.kind === "table").length,
      global:   imports.filter(i => i.kind === "global").length,
    },
    imports: detailed,
  };
}

function opExports(parsed, filePath) {
  const exports_ = parsed.exports;
  // Attach type signature to exported functions
  const importedFuncCount = parsed.counts.importedFunctions;
  const detailed = exports_.map(exp => {
    if (exp.kind === "function") {
      const relIdx = exp.itemIndex - importedFuncCount;
      if (relIdx >= 0 && parsed.functions[relIdx])
        return { ...exp, typeIndex: parsed.functions[relIdx].typeIndex, signature: parsed.functions[relIdx].signature };
    }
    return exp;
  });
  return {
    path: filePath, operation: "exports",
    count: exports_.length,
    byKind: {
      function: exports_.filter(e => e.kind === "function").length,
      memory:   exports_.filter(e => e.kind === "memory").length,
      table:    exports_.filter(e => e.kind === "table").length,
      global:   exports_.filter(e => e.kind === "global").length,
    },
    exports: detailed,
  };
}

function opTypes(parsed, filePath) {
  return {
    path: filePath, operation: "types",
    count: parsed.types.length,
    types: parsed.types,
  };
}

function opFunctions(parsed, filePath, args) {
  const limit  = Math.min(Math.max(1, args.limit ?? 200), 1000);
  const offset = Math.max(0, args.offset ?? 0);

  // Combine imported + defined functions
  const importedFuncCount = parsed.counts.importedFunctions;
  const importedFns = parsed.imports
    .filter(i => i.kind === "function")
    .map((imp, i) => ({
      functionIndex: i,
      typeIndex: imp.typeIndex,
      signature: parsed.types[imp.typeIndex]?.signature ?? null,
      isImported: true,
      importModule: imp.module,
      importName: imp.name,
    }));
  const allFunctions = [...importedFns, ...parsed.functions];
  const slice = allFunctions.slice(offset, offset + limit);
  return {
    path: filePath, operation: "functions",
    totalCount: allFunctions.length,
    importedCount: importedFuncCount,
    definedCount: parsed.functions.length,
    offset, limit, returnedCount: slice.length,
    functions: slice,
  };
}

function opMemory(parsed, filePath) {
  const imported = parsed.imports.filter(i => i.kind === "memory");
  const allMems  = [
    ...imported.map((m, i) => ({
      index: i, isImported: true,
      importModule: m.module, importName: m.name,
      ...m.limits,
    })),
    ...parsed.memories.map(m => ({ ...m, isImported: false, index: m.index + imported.length })),
  ];
  return {
    path: filePath, operation: "memory",
    count: allMems.length,
    memories: allMems,
    totalMinBytes:  allMems.reduce((s, m) => s + (m.minBytes || m.minPages * 65536 || 0), 0),
    pageSize: 65536,
  };
}

function opValidate(parsed, filePath, buf) {
  const issues = [];

  // Magic/version validated in scanSections already
  if (parsed.counts.types === 0 && parsed.counts.definedFunctions > 0)
    issues.push({ severity: "error", message: "Defined functions present but no type section." });

  const funcCount = parsed.counts.definedFunctions;
  if (funcCount !== parsed.functions.length)
    issues.push({ severity: "warning", message: `Function count mismatch: declared ${funcCount}, code bodies ${parsed.functions.length}.` });

  // Check type index validity for defined functions
  let badTypeRefs = 0;
  for (const fn of parsed.functions) {
    if (fn.typeIndex >= parsed.types.length) badTypeRefs++;
  }
  if (badTypeRefs > 0)
    issues.push({ severity: "error", message: `${badTypeRefs} function(s) reference out-of-range type index.` });

  // Import type index validity
  let badImportTypes = 0;
  for (const imp of parsed.imports.filter(i => i.kind === "function")) {
    if (imp.typeIndex >= parsed.types.length) badImportTypes++;
  }
  if (badImportTypes > 0)
    issues.push({ severity: "error", message: `${badImportTypes} import(s) reference out-of-range type index.` });

  // Multiple memories
  const totalMems = parsed.memories.length + parsed.imports.filter(i => i.kind === "memory").length;
  if (totalMems > 1)
    issues.push({ severity: "warning", message: `Module defines ${totalMems} memories (multi-memory proposal; not all engines support this).` });

  // Start function validity
  const totalFuncs = parsed.counts.functions;
  if (parsed.startFunctionIndex !== null && parsed.startFunctionIndex >= totalFuncs)
    issues.push({ severity: "error", message: `Start function index ${parsed.startFunctionIndex} out of range (${totalFuncs} total functions).` });

  // Trailing bytes check
  let lastSec = null;
  for (const s of parsed.sections) {
    if (!lastSec || s.dataStart > lastSec.dataStart) lastSec = s;
  }
  const trailing = lastSec ? buf.length - lastSec.dataEnd : 0;
  if (trailing > 0)
    issues.push({ severity: "warning", message: `${trailing} trailing bytes after last section.` });

  return {
    path: filePath, operation: "validate",
    valid: issues.filter(i => i.severity === "error").length === 0,
    wasmVersion: parsed.version,
    fileSize: parsed.fileSize,
    issueCount: issues.length,
    errorCount: issues.filter(i => i.severity === "error").length,
    warningCount: issues.filter(i => i.severity === "warning").length,
    issues,
    counts: parsed.counts,
  };
}

// ── Main export ────────────────────────────────────────────────────────────────
function wasmClient(args) {
  const { operation, path: filePath } = args;
  if (!operation) throw new Error("wasm_client: 'operation' is required.");
  if (!filePath)  throw new Error("wasm_client: 'path' is required.");

  const VALID_OPS = ["info", "imports", "exports", "types", "functions", "memory", "validate"];
  if (!VALID_OPS.includes(operation))
    throw new Error(`wasm_client: unknown operation '${operation}'. Valid: ${VALID_OPS.join(", ")}.`);

  const { buf, fileSize } = readFile(filePath);
  const parsed = parseWasm(buf, fileSize);

  switch (operation) {
    case "info":      return opInfo(parsed, filePath);
    case "imports":   return opImports(parsed, filePath);
    case "exports":   return opExports(parsed, filePath);
    case "types":     return opTypes(parsed, filePath);
    case "functions": return opFunctions(parsed, filePath, args);
    case "memory":    return opMemory(parsed, filePath);
    case "validate":  return opValidate(parsed, filePath, buf);
    default:
      throw new Error(`wasm_client: unhandled operation '${operation}'.`);
  }
}

module.exports = { wasmClient };
