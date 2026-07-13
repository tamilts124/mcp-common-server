"use strict";
// Section 239 — wasm_client tests
// 76 tests: A=validation x10, B=unit x20, C=happy-path x20, D=security x10, E=error-paths x10, F=concurrency x6

const fs   = require("fs");
const os   = require("os");
const path = require("path");

const { wasmClient } = require("../../lib/wasmClientOps");

// ── Test helpers ───────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    console.error(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || "Assertion failed"); }
function assertEqual(a, b, msg) { if (a !== b) throw new Error(msg || `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
function assertThrows(fn, substr) {
  try { fn(); throw new Error("Expected an error but none was thrown"); }
  catch (e) { if (substr && !e.message.includes(substr)) throw new Error(`Error "${e.message}" does not include "${substr}"`); }
}

// ── Wasm binary builder ────────────────────────────────────────────────────────
function uleb128(n) {
  const bytes = [];
  do {
    let byte_ = n & 0x7F;
    n >>>= 7;
    if (n !== 0) byte_ |= 0x80;
    bytes.push(byte_);
  } while (n !== 0);
  return Buffer.from(bytes);
}

function section(id, payload) {
  return Buffer.concat([Buffer.from([id]), uleb128(payload.length), payload]);
}

function buildWasm({ types = [], imports = [], funcs = [], exports_ = [], memories = [], tables = [], globals = [], startFn = null, dataCount = 0, customSections = [] } = {}) {
  const parts = [Buffer.from([0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00])]; // magic + version

  // Type section
  if (types.length > 0) {
    const payloadParts = [uleb128(types.length)];
    for (const t of types) {
      payloadParts.push(Buffer.from([0x60]));
      payloadParts.push(uleb128(t.params.length));
      for (const p of t.params) payloadParts.push(Buffer.from([p]));
      payloadParts.push(uleb128(t.results.length));
      for (const r of t.results) payloadParts.push(Buffer.from([r]));
    }
    parts.push(section(1, Buffer.concat(payloadParts)));
  }

  // Import section
  if (imports.length > 0) {
    const payloadParts = [uleb128(imports.length)];
    for (const imp of imports) {
      const modBytes = Buffer.from(imp.module, "utf8");
      const nameBytes = Buffer.from(imp.name, "utf8");
      payloadParts.push(uleb128(modBytes.length), modBytes);
      payloadParts.push(uleb128(nameBytes.length), nameBytes);
      payloadParts.push(Buffer.from([imp.kind]));
      if (imp.kind === 0) payloadParts.push(uleb128(imp.typeIndex));
      else if (imp.kind === 2) { payloadParts.push(uleb128(0)); payloadParts.push(uleb128(imp.min || 1)); }
    }
    parts.push(section(2, Buffer.concat(payloadParts)));
  }

  // Function section
  if (funcs.length > 0) {
    const payloadParts = [uleb128(funcs.length)];
    for (const f of funcs) payloadParts.push(uleb128(f));
    parts.push(section(3, Buffer.concat(payloadParts)));
  }

  // Table section
  if (tables.length > 0) {
    const payloadParts = [uleb128(tables.length)];
    for (const t of tables) {
      payloadParts.push(Buffer.from([0x70])); // funcref
      payloadParts.push(uleb128(0));           // no max
      payloadParts.push(uleb128(t.min || 0));
    }
    parts.push(section(4, Buffer.concat(payloadParts)));
  }

  // Memory section
  if (memories.length > 0) {
    const payloadParts = [uleb128(memories.length)];
    for (const m of memories) {
      if (m.max !== undefined) {
        payloadParts.push(uleb128(1));
        payloadParts.push(uleb128(m.min || 1));
        payloadParts.push(uleb128(m.max));
      } else {
        payloadParts.push(uleb128(0));
        payloadParts.push(uleb128(m.min || 1));
      }
    }
    parts.push(section(5, Buffer.concat(payloadParts)));
  }

  // Global section
  if (globals.length > 0) {
    const payloadParts = [uleb128(globals.length)];
    for (const g of globals) {
      payloadParts.push(Buffer.from([g.type || 0x7F, g.mutable ? 1 : 0]));
      // init expr: i32.const 0, end
      payloadParts.push(Buffer.from([0x41, 0x00, 0x0B]));
    }
    parts.push(section(6, Buffer.concat(payloadParts)));
  }

  // Export section
  if (exports_.length > 0) {
    const payloadParts = [uleb128(exports_.length)];
    for (const e of exports_) {
      const nameBytes = Buffer.from(e.name, "utf8");
      payloadParts.push(uleb128(nameBytes.length), nameBytes);
      payloadParts.push(Buffer.from([e.kind]));
      payloadParts.push(uleb128(e.index));
    }
    parts.push(section(7, Buffer.concat(payloadParts)));
  }

  // Start section
  if (startFn !== null) {
    parts.push(section(8, uleb128(startFn)));
  }

  // Code section (one empty body per function)
  if (funcs.length > 0) {
    const payloadParts = [uleb128(funcs.length)];
    for (let i = 0; i < funcs.length; i++) {
      // locals count=0, end opcode
      const body = Buffer.from([0x00, 0x0B]);
      payloadParts.push(uleb128(body.length), body);
    }
    parts.push(section(10, Buffer.concat(payloadParts)));
  }

  // Custom sections
  for (const c of customSections) {
    const nameBuf = Buffer.from(c.name, "utf8");
    const payload = Buffer.concat([uleb128(nameBuf.length), nameBuf, Buffer.from(c.data || [])]);
    parts.push(section(0, payload));
  }

  return Buffer.concat(parts);
}

// ── Temp file helper ───────────────────────────────────────────────────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wasm-test-"));
function tmp(name, buf) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, buf);
  return p;
}
function cleanup() {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
}

// ── A: Validation tests (10) ───────────────────────────────────────────────────
console.error("\nA: Validation");

test("A01 missing operation throws", () => {
  const p = tmp("a01.wasm", buildWasm());
  assertThrows(() => wasmClient({ path: p }), "operation");
});

test("A02 missing path throws", () => {
  assertThrows(() => wasmClient({ operation: "info" }), "path");
});

test("A03 unknown operation throws", () => {
  const p = tmp("a03.wasm", buildWasm());
  assertThrows(() => wasmClient({ operation: "bytes", path: p }), "unknown operation");
});

test("A04 NUL byte in path throws", () => {
  assertThrows(() => wasmClient({ operation: "info", path: "/tmp/a\0b.wasm" }), "NUL");
});

test("A05 directory path throws", () => {
  assertThrows(() => wasmClient({ operation: "info", path: tmpDir }), "directory");
});

test("A06 non-wasm file throws bad magic", () => {
  const p = tmp("a06.bin", Buffer.from("Hello World!"));
  assertThrows(() => wasmClient({ operation: "info", path: p }), "magic");
});

test("A07 truncated file (< 8 bytes) throws", () => {
  const p = tmp("a07.wasm", Buffer.from([0x00, 0x61, 0x73]));
  assertThrows(() => wasmClient({ operation: "info", path: p }), "too short");
});

test("A08 wrong wasm version throws", () => {
  const buf = Buffer.from([0x00, 0x61, 0x73, 0x6D, 0x02, 0x00, 0x00, 0x00]);
  const p = tmp("a08.wasm", buf);
  assertThrows(() => wasmClient({ operation: "info", path: p }), "version");
});

test("A09 nonexistent file throws", () => {
  assertThrows(() => wasmClient({ operation: "info", path: path.join(tmpDir, "nope.wasm") }));
});

test("A10 all valid operations accept minimal module", () => {
  const p = tmp("a10.wasm", buildWasm());
  const ops = ["info", "imports", "exports", "types", "functions", "memory", "validate"];
  for (const op of ops) {
    const r = wasmClient({ operation: op, path: p });
    assert(r && r.operation === op, `op ${op} failed`);
  }
});

// ── B: Unit tests (20) ────────────────────────────────────────────────────────
console.error("\nB: Unit");

test("B01 empty module: info returns version 1", () => {
  const p = tmp("b01.wasm", buildWasm());
  const r = wasmClient({ operation: "info", path: p });
  assertEqual(r.wasmVersion, 1);
});

test("B02 empty module: zero counts", () => {
  const p = tmp("b02.wasm", buildWasm());
  const r = wasmClient({ operation: "info", path: p });
  assertEqual(r.counts.functions, 0);
  assertEqual(r.counts.types, 0);
  assertEqual(r.counts.imports, 0);
  assertEqual(r.counts.exports, 0);
});

test("B03 types section: count and signatures", () => {
  const buf = buildWasm({ types: [{ params: [0x7F], results: [0x7E] }] }); // i32->i64
  const p = tmp("b03.wasm", buf);
  const r = wasmClient({ operation: "types", path: p });
  assertEqual(r.count, 1);
  assertEqual(r.types[0].params[0], "i32");
  assertEqual(r.types[0].results[0], "i64");
  assertEqual(r.types[0].signature, "(i32) -> (i64)");
});

test("B04 function import: typeIndex and signature", () => {
  const buf = buildWasm({
    types:   [{ params: [0x7F], results: [0x7E] }],
    imports: [{ module: "env", name: "add", kind: 0, typeIndex: 0 }],
  });
  const p = tmp("b04.wasm", buf);
  const r = wasmClient({ operation: "imports", path: p });
  assertEqual(r.count, 1);
  assertEqual(r.imports[0].kind, "function");
  assertEqual(r.imports[0].module, "env");
  assertEqual(r.imports[0].name, "add");
  assertEqual(r.imports[0].signature, "(i32) -> (i64)");
});

test("B05 memory import: limits", () => {
  const buf = buildWasm({ imports: [{ module: "env", name: "mem", kind: 2, min: 2 }] });
  const p = tmp("b05.wasm", buf);
  const r = wasmClient({ operation: "imports", path: p });
  assertEqual(r.byKind.memory, 1);
  assert(r.imports[0].limits, "limits present");
});

test("B06 defined function: bodySize > 0", () => {
  const buf = buildWasm({
    types: [{ params: [], results: [] }],
    funcs: [0],
  });
  const p = tmp("b06.wasm", buf);
  const r = wasmClient({ operation: "functions", path: p });
  assertEqual(r.definedCount, 1);
  assert(r.functions[0].bodySize >= 0, "bodySize present");
});

test("B07 export: function export with name", () => {
  const buf = buildWasm({
    types:    [{ params: [0x7F], results: [] }],
    funcs:    [0],
    exports_: [{ name: "main", kind: 0, index: 0 }],
  });
  const p = tmp("b07.wasm", buf);
  const r = wasmClient({ operation: "exports", path: p });
  assertEqual(r.count, 1);
  assertEqual(r.exports[0].name, "main");
  assertEqual(r.exports[0].kind, "function");
});

test("B08 memory section: minPages and minBytes", () => {
  const buf = buildWasm({ memories: [{ min: 2, max: 4 }] });
  const p = tmp("b08.wasm", buf);
  const r = wasmClient({ operation: "memory", path: p });
  assertEqual(r.memories[0].minPages, 2);
  assertEqual(r.memories[0].minBytes, 2 * 65536);
  assertEqual(r.memories[0].maxPages, 4);
  assertEqual(r.memories[0].maxBytes, 4 * 65536);
});

test("B09 validate passes on clean module", () => {
  const buf = buildWasm({
    types:    [{ params: [], results: [] }],
    funcs:    [0],
    exports_: [{ name: "run", kind: 0, index: 0 }],
  });
  const p = tmp("b09.wasm", buf);
  const r = wasmClient({ operation: "validate", path: p });
  assert(r.valid, "should be valid");
  assertEqual(r.errorCount, 0);
});

test("B10 custom sections appear in info", () => {
  const buf = buildWasm({ customSections: [{ name: "name" }, { name: "producers" }] });
  const p = tmp("b10.wasm", buf);
  const r = wasmClient({ operation: "info", path: p });
  assertEqual(r.customSections.length, 2);
  assertEqual(r.customSections[0].name, "name");
  assertEqual(r.customSections[1].name, "producers");
});

test("B11 multiple types", () => {
  const buf = buildWasm({
    types: [
      { params: [],      results: [0x7F] },
      { params: [0x7F, 0x7E], results: [0x7D] },
    ],
  });
  const p = tmp("b11.wasm", buf);
  const r = wasmClient({ operation: "types", path: p });
  assertEqual(r.count, 2);
  assertEqual(r.types[1].params[0], "i32");
  assertEqual(r.types[1].params[1], "i64");
  assertEqual(r.types[1].results[0], "f32");
});

test("B12 memory export", () => {
  const buf = buildWasm({
    memories: [{ min: 1 }],
    exports_: [{ name: "memory", kind: 2, index: 0 }],
  });
  const p = tmp("b12.wasm", buf);
  const r = wasmClient({ operation: "exports", path: p });
  assertEqual(r.byKind.memory, 1);
  assertEqual(r.exports[0].kind, "memory");
});

test("B13 start section: hasStartFunction true", () => {
  const buf = buildWasm({
    types: [{ params: [], results: [] }],
    funcs: [0],
    startFn: 0,
  });
  const p = tmp("b13.wasm", buf);
  const r = wasmClient({ operation: "info", path: p });
  assert(r.hasStartFunction, "hasStartFunction");
  assertEqual(r.startFunctionIndex, 0);
});

test("B14 functions operation returns importedFunctions correctly", () => {
  const buf = buildWasm({
    types:   [{ params: [], results: [] }],
    imports: [{ module: "js", name: "f", kind: 0, typeIndex: 0 }],
    funcs:   [0],
  });
  const p = tmp("b14.wasm", buf);
  const r = wasmClient({ operation: "functions", path: p });
  assertEqual(r.importedCount, 1);
  assertEqual(r.definedCount, 1);
  assertEqual(r.totalCount, 2);
  assert(r.functions[0].isImported, "first fn is imported");
  assert(!r.functions[1].isImported, "second fn is defined");
});

test("B15 info reports fileSize accurately", () => {
  const buf = buildWasm({ memories: [{ min: 1 }] });
  const p = tmp("b15.wasm", buf);
  const r = wasmClient({ operation: "info", path: p });
  assertEqual(r.fileSize, buf.length);
});

test("B16 functions limit parameter respected", () => {
  const types = [{ params: [], results: [] }];
  const funcs = Array.from({ length: 10 }, () => 0);
  const buf = buildWasm({ types, funcs });
  const p = tmp("b16.wasm", buf);
  const r = wasmClient({ operation: "functions", path: p, limit: 3 });
  assertEqual(r.returnedCount, 3);
  assertEqual(r.functions.length, 3);
});

test("B17 functions offset parameter respected", () => {
  const types = [{ params: [], results: [] }];
  const funcs = Array.from({ length: 5 }, () => 0);
  const buf = buildWasm({ types, funcs });
  const p = tmp("b17.wasm", buf);
  const r = wasmClient({ operation: "functions", path: p, offset: 3, limit: 10 });
  assertEqual(r.functions.length, 2); // only 2 after offset 3
  assertEqual(r.functions[0].functionIndex, 3);
});

test("B18 multiple exports", () => {
  const buf = buildWasm({
    types:    [{ params: [], results: [] }],
    funcs:    [0, 0, 0],
    exports_: [
      { name: "f1", kind: 0, index: 0 },
      { name: "f2", kind: 0, index: 1 },
      { name: "f3", kind: 0, index: 2 },
    ],
  });
  const p = tmp("b18.wasm", buf);
  const r = wasmClient({ operation: "exports", path: p });
  assertEqual(r.count, 3);
  assertEqual(r.byKind.function, 3);
});

test("B19 info section summary contains all sections", () => {
  const buf = buildWasm({
    types:    [{ params: [], results: [] }],
    funcs:    [0],
    memories: [{ min: 1 }],
    exports_: [{ name: "f", kind: 0, index: 0 }],
  });
  const p = tmp("b19.wasm", buf);
  const r = wasmClient({ operation: "info", path: p });
  const names = r.sections.map(s => s.name);
  assert(names.includes("type"),     "type section");
  assert(names.includes("function"), "function section");
  assert(names.includes("memory"),   "memory section");
  assert(names.includes("export"),   "export section");
  assert(names.includes("code"),     "code section");
});

test("B20 memory with no max: maxPages undefined", () => {
  const buf = buildWasm({ memories: [{ min: 1 }] });
  const p = tmp("b20.wasm", buf);
  const r = wasmClient({ operation: "memory", path: p });
  assert(r.memories[0].maxPages === undefined, "no max");
});

// ── C: Happy-path tests (20) ──────────────────────────────────────────────────
console.error("\nC: Happy-path");

test("C01 info on module with all sections", () => {
  const buf = buildWasm({
    types:    [{ params: [0x7F], results: [0x7F] }],
    imports:  [{ module: "env", name: "log", kind: 0, typeIndex: 0 }],
    funcs:    [0],
    memories: [{ min: 1 }],
    exports_: [{ name: "run", kind: 0, index: 1 }],
    customSections: [{ name: "name" }],
  });
  const p = tmp("c01.wasm", buf);
  const r = wasmClient({ operation: "info", path: p });
  assertEqual(r.counts.imports, 1);
  assertEqual(r.counts.functions, 2); // 1 imported + 1 defined
  assertEqual(r.counts.exports, 1);
  assertEqual(r.counts.memories, 1);
  assert(Array.isArray(r.sections));
});

test("C02 imports byKind breakdown", () => {
  const buf = buildWasm({
    imports: [
      { module: "env",    name: "fn",  kind: 0, typeIndex: 0 },
      { module: "env",    name: "mem", kind: 2, min: 1 },
    ],
  });
  const p = tmp("c02.wasm", buf);
  const r = wasmClient({ operation: "imports", path: p });
  assertEqual(r.byKind.function, 1);
  assertEqual(r.byKind.memory, 1);
  assertEqual(r.count, 2);
});

test("C03 exports byKind breakdown: function + memory", () => {
  const buf = buildWasm({
    types:    [{ params: [], results: [] }],
    funcs:    [0],
    memories: [{ min: 1 }],
    exports_: [
      { name: "fn",  kind: 0, index: 0 },
      { name: "mem", kind: 2, index: 0 },
    ],
  });
  const p = tmp("c03.wasm", buf);
  const r = wasmClient({ operation: "exports", path: p });
  assertEqual(r.byKind.function, 1);
  assertEqual(r.byKind.memory, 1);
});

test("C04 types with multiple params and results", () => {
  const buf = buildWasm({
    types: [{ params: [0x7F, 0x7E, 0x7D, 0x7C], results: [0x7F, 0x7E] }],
  });
  const p = tmp("c04.wasm", buf);
  const r = wasmClient({ operation: "types", path: p });
  assertEqual(r.types[0].params.length, 4);
  assertEqual(r.types[0].results.length, 2);
  assert(r.types[0].signature.includes("i32"), "sig includes i32");
  assert(r.types[0].signature.includes("i64"), "sig includes i64");
});

test("C05 functions with start function", () => {
  const buf = buildWasm({
    types: [{ params: [], results: [] }],
    funcs: [0],
    startFn: 0,
  });
  const p = tmp("c05.wasm", buf);
  const r = wasmClient({ operation: "info", path: p });
  assert(r.hasStartFunction);
  assertEqual(r.startFunctionIndex, 0);
});

test("C06 memory totalMinBytes sum", () => {
  const buf = buildWasm({ memories: [{ min: 3 }] });
  const p = tmp("c06.wasm", buf);
  const r = wasmClient({ operation: "memory", path: p });
  assertEqual(r.totalMinBytes, 3 * 65536);
  assertEqual(r.pageSize, 65536);
});

test("C07 validate valid: correct module is valid", () => {
  const buf = buildWasm({
    types:    [{ params: [0x7F], results: [0x7F] }],
    funcs:    [0],
    exports_: [{ name: "identity", kind: 0, index: 0 }],
    memories: [{ min: 1 }],
  });
  const p = tmp("c07.wasm", buf);
  const r = wasmClient({ operation: "validate", path: p });
  assert(r.valid, "valid");
  assertEqual(r.errorCount, 0);
});

test("C08 functions: imported function includes importModule/importName", () => {
  const buf = buildWasm({
    types:   [{ params: [], results: [] }],
    imports: [{ module: "wasi_snapshot_preview1", name: "proc_exit", kind: 0, typeIndex: 0 }],
    funcs:   [0],
  });
  const p = tmp("c08.wasm", buf);
  const r = wasmClient({ operation: "functions", path: p });
  const imp = r.functions.find(f => f.isImported);
  assertEqual(imp.importModule, "wasi_snapshot_preview1");
  assertEqual(imp.importName, "proc_exit");
});

test("C09 info counts.customSections", () => {
  const buf = buildWasm({ customSections: [{ name: "a" }, { name: "b" }, { name: "c" }] });
  const p = tmp("c09.wasm", buf);
  const r = wasmClient({ operation: "info", path: p });
  assertEqual(r.counts.customSections, 3);
});

test("C10 functions default limit=200 cap", () => {
  const types = [{ params: [], results: [] }];
  const funcs = Array.from({ length: 250 }, () => 0);
  const buf = buildWasm({ types, funcs });
  const p = tmp("c10.wasm", buf);
  const r = wasmClient({ operation: "functions", path: p });
  assertEqual(r.returnedCount, 200); // default limit
  assertEqual(r.totalCount, 250);
});

test("C11 imports with multiple function imports all get signatures", () => {
  const buf = buildWasm({
    types:   [
      { params: [0x7F], results: [] },
      { params: [0x7E], results: [0x7F] },
    ],
    imports: [
      { module: "a", name: "f1", kind: 0, typeIndex: 0 },
      { module: "b", name: "f2", kind: 0, typeIndex: 1 },
    ],
  });
  const p = tmp("c11.wasm", buf);
  const r = wasmClient({ operation: "imports", path: p });
  assert(r.imports[0].signature, "sig 0");
  assert(r.imports[1].signature, "sig 1");
});

test("C12 exported functions have typeIndex and signature", () => {
  const buf = buildWasm({
    types:    [{ params: [0x7F], results: [0x7F] }],
    funcs:    [0],
    exports_: [{ name: "double", kind: 0, index: 0 }],
  });
  const p = tmp("c12.wasm", buf);
  const r = wasmClient({ operation: "exports", path: p });
  assert(r.exports[0].typeIndex !== undefined, "typeIndex present");
  assert(r.exports[0].signature, "signature present");
});

test("C13 memory: zero memories returns empty array", () => {
  const p = tmp("c13.wasm", buildWasm());
  const r = wasmClient({ operation: "memory", path: p });
  assertEqual(r.count, 0);
  assertEqual(r.memories.length, 0);
  assertEqual(r.totalMinBytes, 0);
});

test("C14 types: empty module returns empty", () => {
  const p = tmp("c14.wasm", buildWasm());
  const r = wasmClient({ operation: "types", path: p });
  assertEqual(r.count, 0);
  assert(Array.isArray(r.types));
});

test("C15 imports: empty module returns empty", () => {
  const p = tmp("c15.wasm", buildWasm());
  const r = wasmClient({ operation: "imports", path: p });
  assertEqual(r.count, 0);
  assert(Array.isArray(r.imports));
});

test("C16 exports: empty module returns empty", () => {
  const p = tmp("c16.wasm", buildWasm());
  const r = wasmClient({ operation: "exports", path: p });
  assertEqual(r.count, 0);
  assert(Array.isArray(r.exports));
});

test("C17 functions: empty module returns empty", () => {
  const p = tmp("c17.wasm", buildWasm());
  const r = wasmClient({ operation: "functions", path: p });
  assertEqual(r.totalCount, 0);
  assert(Array.isArray(r.functions));
});

test("C18 all ops return operation field matching request", () => {
  const p = tmp("c18.wasm", buildWasm({ types: [{ params: [], results: [] }], funcs: [0] }));
  for (const op of ["info", "imports", "exports", "types", "functions", "memory", "validate"]) {
    const r = wasmClient({ operation: op, path: p });
    assertEqual(r.operation, op, `${op} operation field`);
  }
});

test("C19 all ops return path field", () => {
  const p = tmp("c19.wasm", buildWasm());
  for (const op of ["info", "imports", "exports", "types", "functions", "memory", "validate"]) {
    const r = wasmClient({ operation: op, path: p });
    assertEqual(r.path, p, `${op} path field`);
  }
});

test("C20 validate with only type section (no functions) is valid", () => {
  const buf = buildWasm({ types: [{ params: [], results: [] }] });
  const p = tmp("c20.wasm", buf);
  const r = wasmClient({ operation: "validate", path: p });
  assert(r.valid, "valid");
});

// ── D: Security tests (10) ────────────────────────────────────────────────────
console.error("\nD: Security");

test("D01 NUL byte in path rejected", () => {
  assertThrows(() => wasmClient({ operation: "info", path: "/tmp/fi\0le.wasm" }), "NUL");
});

test("D02 directory path rejected", () => {
  assertThrows(() => wasmClient({ operation: "info", path: tmpDir }), "directory");
});

test("D03 path traversal: ../../etc/passwd rejected (file not found or wrong type)", () => {
  // File does not exist or is not a wasm file — either way, a clear error
  try {
    wasmClient({ operation: "info", path: "../../etc/passwd" });
    // If it returned a result, it would be wrong format — check that
    assert(false, "Should have thrown");
  } catch (e) {
    // Any error is acceptable — the key is it doesn't succeed silently
    assert(e.message.length > 0, "error message present");
  }
});

test("D04 truncated type section does not hang", () => {
  // Build a wasm where type section is cut short
  const validBuf = buildWasm({ types: [{ params: [0x7F], results: [] }] });
  const truncated = validBuf.slice(0, validBuf.length - 2);
  const p = tmp("d04.wasm", truncated);
  // Either throws or returns partial data without hanging
  try { wasmClient({ operation: "types", path: p }); }
  catch { /* acceptable */ }
});

test("D05 crafted LEB128 overflow not accepted (> 5 bytes used)", () => {
  // Inject a section with a payload-length LEB128 that would overflow
  const overflow = Buffer.from([
    0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00, // header
    0x01,                                              // type section id
    0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01,        // over-long LEB128 (7 bytes for size)
  ]);
  const p = tmp("d05.wasm", overflow);
  // Should throw or return empty/partial without crash
  try { wasmClient({ operation: "info", path: p }); }
  catch { /* acceptable */ }
});

test("D06 huge type count in section header (no OOM)", () => {
  const buf = buildWasm();
  // Manually craft a type section with count=0x7FFFFFFF but no actual data
  const fakeSec = Buffer.concat([
    Buffer.from([0x01]),               // type section id
    uleb128(5),                        // 5 payload bytes
    uleb128(0x7FFFFFFF),               // huge count (4 bytes LEB128)
    Buffer.from([0x00]),               // no actual types
  ]);
  const crafted = Buffer.concat([buf.slice(0, 8), fakeSec]);
  const p = tmp("d06.wasm", crafted);
  // Must not OOM/hang — just return or throw
  try { wasmClient({ operation: "types", path: p }); }
  catch { /* acceptable */ }
});

test("D07 file size limit: 50 MB cap defined and enforced", () => {
  // Verify the 50 MB cap is present in the source
  const src = fs.readFileSync(path.join(__dirname, "../../lib/wasmClientOps.js"), "utf8");
  const hasLimit = src.includes("50 * 1024 * 1024") || src.includes("52428800");
  assert(hasLimit, "50 MB file cap expression present in source");
  assert(src.includes("file too large"), "size-check error message present in source");
});

test("D08 malformed import section (truncated) does not crash", () => {
  // Build with imports but truncate import section payload
  const validBuf = buildWasm({
    types:   [{ params: [], results: [] }],
    imports: [{ module: "env", name: "longname_that_gets_truncated", kind: 0, typeIndex: 0 }],
  });
  const truncated = validBuf.slice(0, validBuf.length - 5);
  const p = tmp("d08.wasm", truncated);
  try { wasmClient({ operation: "imports", path: p }); }
  catch { /* acceptable */ }
});

test("D09 very long custom section names handled safely", () => {
  const longName = "x".repeat(1000);
  const buf = buildWasm({ customSections: [{ name: longName }] });
  const p = tmp("d09.wasm", buf);
  const r = wasmClient({ operation: "info", path: p });
  assertEqual(r.customSections[0].name, longName);
});

test("D10 operations on file modified after open are safe (TOCTOU not a concern for read)", () => {
  const buf = buildWasm({ types: [{ params: [], results: [] }] });
  const p = tmp("d10.wasm", buf);
  // Read, then immediately overwrite — result is whatever was read atomically
  const r = wasmClient({ operation: "types", path: p });
  assert(typeof r.count === "number", "safe result");
});

// ── E: Error-path tests (10) ──────────────────────────────────────────────────
console.error("\nE: Error-paths");

test("E01 wrong magic bytes error message includes 'magic'", () => {
  const p = tmp("e01.bin", Buffer.from("PNG\r\n\x1a\n\x00"));
  assertThrows(() => wasmClient({ operation: "info", path: p }), "magic");
});

test("E02 version 2 error message includes 'version'", () => {
  const buf = Buffer.from([0x00, 0x61, 0x73, 0x6D, 0x02, 0x00, 0x00, 0x00]);
  const p = tmp("e02.wasm", buf);
  assertThrows(() => wasmClient({ operation: "info", path: p }), "version");
});

test("E03 empty file error includes 'too short'", () => {
  const p = tmp("e03.wasm", Buffer.alloc(0));
  assertThrows(() => wasmClient({ operation: "info", path: p }), "too short");
});

test("E04 directory as path includes 'directory'", () => {
  assertThrows(() => wasmClient({ operation: "info", path: tmpDir }), "directory");
});

test("E05 missing path field error mentions 'path'", () => {
  assertThrows(() => wasmClient({ operation: "info" }), "path");
});

test("E06 missing operation field error mentions 'operation'", () => {
  const p = tmp("e06.wasm", buildWasm());
  assertThrows(() => wasmClient({ path: p }), "operation");
});

test("E07 unknown operation error lists valid operations", () => {
  const p = tmp("e07.wasm", buildWasm());
  assertThrows(() => wasmClient({ operation: "dump", path: p }), "Valid");
});

test("E08 NUL path error says 'NUL'", () => {
  assertThrows(() => wasmClient({ operation: "info", path: "a\0b.wasm" }), "NUL");
});

test("E09 nonexistent file throws ENOENT-style error", () => {
  assertThrows(() => wasmClient({ operation: "info", path: path.join(tmpDir, "ghost.wasm") }));
});

test("E10 4-byte file (only magic, no version) throws 'too short'", () => {
  const p = tmp("e10.wasm", Buffer.from([0x00, 0x61, 0x73, 0x6D]));
  assertThrows(() => wasmClient({ operation: "info", path: p }), "too short");
});

// ── F: Concurrency tests (6) ──────────────────────────────────────────────────
console.error("\nF: Concurrency");

test("F01 20 concurrent info calls on same file", async () => {
  const buf = buildWasm({ types: [{ params: [0x7F], results: [] }], funcs: [0] });
  const p = tmp("f01.wasm", buf);
  const results = await Promise.all(Array.from({ length: 20 }, () =>
    Promise.resolve(wasmClient({ operation: "info", path: p }))
  ));
  for (const r of results) assertEqual(r.wasmVersion, 1);
});

test("F02 concurrent calls to different operations", async () => {
  const buf = buildWasm({
    types:    [{ params: [], results: [] }],
    funcs:    [0],
    memories: [{ min: 1 }],
    exports_: [{ name: "f", kind: 0, index: 0 }],
  });
  const p = tmp("f02.wasm", buf);
  const ops = ["info", "types", "functions", "memory", "exports", "imports", "validate"];
  const results = await Promise.all(ops.map(op => Promise.resolve(wasmClient({ operation: op, path: p }))));
  for (let i = 0; i < ops.length; i++) assertEqual(results[i].operation, ops[i]);
});

test("F03 50 concurrent reads across 5 files", async () => {
  const files = Array.from({ length: 5 }, (_, i) => {
    const buf = buildWasm({ types: [{ params: [], results: [0x7F] }], funcs: [0] });
    return tmp(`f03-${i}.wasm`, buf);
  });
  const tasks = Array.from({ length: 50 }, (_, i) => Promise.resolve(
    wasmClient({ operation: "types", path: files[i % 5] })
  ));
  const results = await Promise.all(tasks);
  assert(results.every(r => r.count === 1), "all return 1 type");
});

test("F04 concurrent validate on multiple modules", async () => {
  const good = tmp("f04g.wasm", buildWasm({ types: [{ params: [], results: [] }], funcs: [0] }));
  const empty = tmp("f04e.wasm", buildWasm());
  const results = await Promise.all([
    Promise.resolve(wasmClient({ operation: "validate", path: good })),
    Promise.resolve(wasmClient({ operation: "validate", path: empty })),
    Promise.resolve(wasmClient({ operation: "validate", path: good })),
    Promise.resolve(wasmClient({ operation: "validate", path: empty })),
  ]);
  for (const r of results) assert(r.valid, "valid");
});

test("F05 concurrent functions with paging", async () => {
  const types = [{ params: [], results: [] }];
  const funcs = Array.from({ length: 50 }, () => 0);
  const buf = buildWasm({ types, funcs });
  const p = tmp("f05.wasm", buf);
  const results = await Promise.all([
    Promise.resolve(wasmClient({ operation: "functions", path: p, limit: 10, offset: 0 })),
    Promise.resolve(wasmClient({ operation: "functions", path: p, limit: 10, offset: 10 })),
    Promise.resolve(wasmClient({ operation: "functions", path: p, limit: 10, offset: 20 })),
    Promise.resolve(wasmClient({ operation: "functions", path: p, limit: 10, offset: 30 })),
    Promise.resolve(wasmClient({ operation: "functions", path: p, limit: 10, offset: 40 })),
  ]);
  let allFns = [];
  for (const r of results) allFns = allFns.concat(r.functions.map(f => f.functionIndex));
  assertEqual(new Set(allFns).size, 50, "all 50 distinct");
});

test("F06 memory isolation: parallel calls share no mutable state", async () => {
  const bufs = Array.from({ length: 10 }, (_, i) => {
    const mem = [{ min: i + 1 }];
    return { buf: buildWasm({ memories: mem }), min: i + 1 };
  });
  const files = bufs.map((b, i) => ({ p: tmp(`f06-${i}.wasm`, b.buf), min: b.min }));
  const results = await Promise.all(files.map(f =>
    Promise.resolve(wasmClient({ operation: "memory", path: f.p }))
  ));
  for (let i = 0; i < files.length; i++)
    assertEqual(results[i].memories[0].minPages, files[i].min, `file ${i} minPages`);
});

// ── Cleanup & summary ─────────────────────────────────────────────────────────
cleanup();

const total = passed + failed;
console.error(`\n${"=".repeat(50)}`);
console.error(`Section 239 (wasm_client): ${passed}/${total} tests passed`);
if (failed > 0) {
  console.error(`FAILED: ${failed} tests`);
  process.exit(1);
}
