"use strict";
// ── 3d_client — zero-dependency 3D model metadata reader ─────────────────────
// Pure Node.js (fs + Buffer); no npm deps.
// Operations: info, vertices, faces, materials, validate
// Formats: OBJ (Wavefront), STL (ASCII + Binary), PLY (ASCII + Binary LE/BE),
//          GLTF (.gltf JSON), GLB (GL Transmission Format binary)
// Security: 200 MB file cap; 10 MB sample window; NUL-byte path guard;
//           directory guard; vertex/face caps

const fs   = require("fs");
const path = require("path");

// ── Constants ──────────────────────────────────────────────────────────────────
const MAX_FILE_SIZE   = 200 * 1024 * 1024;  // 200 MB
const MAX_READ_HEAD   = 10  * 1024 * 1024;  // 10 MB text sample window
const MAX_VERTICES    = 5_000_000;
const MAX_FACES       = 5_000_000;
const MAX_MATERIALS   = 10_000;
const MAX_SAMPLE_VERTS = 1000;  // returned in vertices op
const MAX_SAMPLE_FACES = 1000;  // returned in faces op

// ── File helpers ───────────────────────────────────────────────────────────────
function statFile(filePath) {
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) throw new Error("3d_client: path is a directory.");
  if (stat.size > MAX_FILE_SIZE)
    throw new Error(`3d_client: file too large (${stat.size} B; max ${MAX_FILE_SIZE} B).`);
  return stat;
}

function readHead(filePath, maxBytes) {
  const stat = statFile(filePath);
  const readLen = Math.min(stat.size, maxBytes);
  const buf = Buffer.alloc(readLen);
  const fd  = fs.openSync(filePath, "r");
  try { fs.readSync(fd, buf, 0, readLen, 0); }
  finally { fs.closeSync(fd); }
  return { buf, fileSize: stat.size };
}

function readFull(filePath) {
  const stat = statFile(filePath);
  return { buf: fs.readFileSync(filePath), fileSize: stat.size };
}

// ── Format detection ───────────────────────────────────────────────────────────
function detectFormat(buf, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  // GLB: magic 0x46546C67 ("glTF")
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x46546C67) return "glb";
  // STL binary: 80-byte header + uint32 count — detect by extension + binary heuristic
  // STL ASCII: starts with "solid"
  if (ext === ".stl") {
    // Check if ASCII: first non-whitespace should be 'solid'
    const head = buf.slice(0, Math.min(256, buf.length)).toString("latin1").trimStart();
    return head.startsWith("solid") ? "stl-ascii" : "stl-binary";
  }
  if (ext === ".obj") return "obj";
  if (ext === ".mtl") return "mtl";
  if (ext === ".ply") return "ply";
  if (ext === ".gltf") return "gltf";
  if (ext === ".glb")  return "glb";
  // Fallback: check content
  const head = buf.slice(0, Math.min(256, buf.length)).toString("latin1");
  if (head.trimStart().startsWith("solid "))           return "stl-ascii";
  if (head.trimStart().startsWith("ply"))              return "ply";
  if (head.trimStart().startsWith("{"))                return "gltf";
  if (head.trimStart().startsWith("# ") || head.includes("\nv ")) return "obj";
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// OBJ Parser
// ═══════════════════════════════════════════════════════════════════════════════
function parseObjText(text, opts) {
  const op = opts.operation;
  let vertexCount = 0, faceCount = 0, normalCount = 0, uvCount = 0;
  let lineCount = 0;
  const materials = [];         // mtllib references
  const objects = [];           // o / g names
  const sampleVerts = [];       // first MAX_SAMPLE_VERTS vertices
  const sampleFaces = [];       // first MAX_SAMPLE_FACES faces
  const usedMaterials = new Set();
  let bbox = null;
  let currentGroup = null;

  const lines = text.split(/\r?\n/);
  lineCount = lines.length;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    const kw = parts[0];

    if (kw === "v") {
      vertexCount++;
      if (vertexCount > MAX_VERTICES) continue;
      const x = parseFloat(parts[1]), y = parseFloat(parts[2]), z = parseFloat(parts[3]);
      if (!isNaN(x) && !isNaN(y) && !isNaN(z)) {
        if (!bbox) bbox = { minX: x, maxX: x, minY: y, maxY: y, minZ: z, maxZ: z };
        else {
          if (x < bbox.minX) bbox.minX = x; if (x > bbox.maxX) bbox.maxX = x;
          if (y < bbox.minY) bbox.minY = y; if (y > bbox.maxY) bbox.maxY = y;
          if (z < bbox.minZ) bbox.minZ = z; if (z > bbox.maxZ) bbox.maxZ = z;
        }
        if (sampleVerts.length < MAX_SAMPLE_VERTS) sampleVerts.push({ x, y, z });
      }
    } else if (kw === "vn") {
      normalCount++;
    } else if (kw === "vt") {
      uvCount++;
    } else if (kw === "f") {
      faceCount++;
      if (faceCount > MAX_FACES) continue;
      if (sampleFaces.length < MAX_SAMPLE_FACES) {
        // Parse face indices (can be v, v/vt, v/vt/vn, v//vn)
        const indices = [];
        for (let i = 1; i < parts.length; i++) {
          const seg = parts[i].split("/");
          indices.push({
            v:  parseInt(seg[0], 10) || 0,
            vt: seg[1] ? (parseInt(seg[1], 10) || 0) : undefined,
            vn: seg[2] ? (parseInt(seg[2], 10) || 0) : undefined,
          });
        }
        sampleFaces.push({ vertexCount: parts.length - 1, indices });
      }
    } else if (kw === "mtllib") {
      for (let i = 1; i < parts.length; i++) {
        if (parts[i] && !materials.includes(parts[i])) materials.push(parts[i]);
      }
    } else if (kw === "usemtl") {
      if (parts[1]) usedMaterials.add(parts[1]);
    } else if (kw === "o" || kw === "g") {
      const name = parts.slice(1).join(" ");
      if (name && !objects.includes(name)) objects.push(name);
      currentGroup = name;
    }
  }

  const hasUVs     = uvCount > 0;
  const hasNormals = normalCount > 0;

  if (bbox) {
    bbox.sizeX = +((bbox.maxX - bbox.minX).toFixed(6));
    bbox.sizeY = +((bbox.maxY - bbox.minY).toFixed(6));
    bbox.sizeZ = +((bbox.maxZ - bbox.minZ).toFixed(6));
  }

  return {
    format: "OBJ",
    vertexCount, faceCount, normalCount, uvCount,
    hasNormals, hasUVs,
    lineCount, objects,
    materialLibraries: materials,
    usedMaterials: [...usedMaterials],
    bbox,
    sampleVerts,
    sampleFaces,
    verticesTruncated: vertexCount > MAX_VERTICES,
    facesTruncated:    faceCount  > MAX_FACES,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// MTL Parser
// ═══════════════════════════════════════════════════════════════════════════════
function parseMtlText(text) {
  const materials = [];
  let current = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    const kw = parts[0].toLowerCase();

    if (kw === "newmtl") {
      if (current) materials.push(current);
      current = { name: parts.slice(1).join(" "), textures: [] };
    } else if (current) {
      if (kw === "ka")  current.ambientColor  = [parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3])];
      else if (kw === "kd") current.diffuseColor  = [parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3])];
      else if (kw === "ks") current.specularColor = [parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3])];
      else if (kw === "ns") current.shininess = parseFloat(parts[1]);
      else if (kw === "d" || kw === "tr") current.opacity = parseFloat(parts[1]);
      else if (kw === "illum") current.illumModel = parseInt(parts[1], 10);
      else if (kw === "map_kd")  current.textures.push({ type: "diffuse",  path: parts.slice(1).join(" ") });
      else if (kw === "map_ks")  current.textures.push({ type: "specular", path: parts.slice(1).join(" ") });
      else if (kw === "map_bump" || kw === "bump") current.textures.push({ type: "bump", path: parts.slice(1).join(" ") });
      else if (kw === "map_ka")  current.textures.push({ type: "ambient",  path: parts.slice(1).join(" ") });
      else if (kw === "map_d")   current.textures.push({ type: "alpha",    path: parts.slice(1).join(" ") });
      else if (kw === "norm" || kw === "map_kn") current.textures.push({ type: "normal", path: parts.slice(1).join(" ") });
    }
  }
  if (current) materials.push(current);
  return materials;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STL ASCII Parser
// ═══════════════════════════════════════════════════════════════════════════════
function parseStlAscii(text) {
  let vertexCount = 0, faceCount = 0, normalCount = 0;
  const sampleVerts = [], sampleFaces = [];
  let bbox = null;
  let solidName = null;
  let inFacet = false;
  let currentFaceVerts = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const kw = parts[0].toLowerCase();

    if (kw === "solid" && !solidName) {
      solidName = parts.slice(1).join(" ") || null;
    } else if (kw === "facet" && parts[1] === "normal") {
      faceCount++;
      normalCount++;
      inFacet = true;
      currentFaceVerts = [];
    } else if (kw === "vertex" && inFacet) {
      const x = parseFloat(parts[1]), y = parseFloat(parts[2]), z = parseFloat(parts[3]);
      if (!isNaN(x) && !isNaN(y) && !isNaN(z)) {
        vertexCount++;
        if (!bbox) bbox = { minX: x, maxX: x, minY: y, maxY: y, minZ: z, maxZ: z };
        else {
          if (x < bbox.minX) bbox.minX = x; if (x > bbox.maxX) bbox.maxX = x;
          if (y < bbox.minY) bbox.minY = y; if (y > bbox.maxY) bbox.maxY = y;
          if (z < bbox.minZ) bbox.minZ = z; if (z > bbox.maxZ) bbox.maxZ = z;
        }
        currentFaceVerts.push({ x, y, z });
        if (sampleVerts.length < MAX_SAMPLE_VERTS) sampleVerts.push({ x, y, z });
      }
    } else if (kw === "endfacet") {
      if (sampleFaces.length < MAX_SAMPLE_FACES && currentFaceVerts.length > 0)
        sampleFaces.push({ vertexCount: currentFaceVerts.length, vertices: currentFaceVerts });
      inFacet = false;
    }
    if (vertexCount > MAX_VERTICES || faceCount > MAX_FACES) break;
  }

  if (bbox) {
    bbox.sizeX = +((bbox.maxX - bbox.minX).toFixed(6));
    bbox.sizeY = +((bbox.maxY - bbox.minY).toFixed(6));
    bbox.sizeZ = +((bbox.maxZ - bbox.minZ).toFixed(6));
  }

  return {
    format: "STL", subFormat: "ASCII",
    solidName, vertexCount, faceCount, normalCount,
    hasNormals: normalCount > 0,
    bbox, sampleVerts, sampleFaces,
    verticesTruncated: vertexCount >= MAX_VERTICES,
    facesTruncated: faceCount >= MAX_FACES,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// STL Binary Parser
// ═══════════════════════════════════════════════════════════════════════════════
function parseStlBinary(buf, fileSize) {
  // Binary STL: 80 bytes header, 4 bytes triangle count, then N * 50 bytes
  if (buf.length < 84) throw new Error("3d_client: STL binary file too small.");
  const header = buf.slice(0, 80).toString("latin1").replace(/\0/g, "").trim();
  const declaredFaces = buf.readUInt32LE(80);
  // Verify size makes sense: 84 + N*50
  const expectedSize = 84 + declaredFaces * 50;
  const sizeMatch = (fileSize === expectedSize) || (buf.length >= expectedSize);
  const faceCount = Math.min(declaredFaces, MAX_FACES,
    Math.floor((buf.length - 84) / 50));
  const vertexCount = faceCount * 3;

  const sampleVerts = [], sampleFaces = [];
  let bbox = null;

  for (let i = 0; i < faceCount; i++) {
    const off = 84 + i * 50;
    if (off + 50 > buf.length) break;
    // Normal: 3 floats at off, off+4, off+8
    // Vertices: 3*(3 floats) = 9 floats
    const faceVerts = [];
    for (let v = 0; v < 3; v++) {
      const vo = off + 12 + v * 12;
      const x = buf.readFloatLE(vo);
      const y = buf.readFloatLE(vo + 4);
      const z = buf.readFloatLE(vo + 8);
      if (!bbox) bbox = { minX: x, maxX: x, minY: y, maxY: y, minZ: z, maxZ: z };
      else {
        if (x < bbox.minX) bbox.minX = x; if (x > bbox.maxX) bbox.maxX = x;
        if (y < bbox.minY) bbox.minY = y; if (y > bbox.maxY) bbox.maxY = y;
        if (z < bbox.minZ) bbox.minZ = z; if (z > bbox.maxZ) bbox.maxZ = z;
      }
      faceVerts.push({ x, y, z });
      if (sampleVerts.length < MAX_SAMPLE_VERTS) sampleVerts.push({ x, y, z });
    }
    if (sampleFaces.length < MAX_SAMPLE_FACES)
      sampleFaces.push({ vertexCount: 3, vertices: faceVerts });
  }

  if (bbox) {
    bbox.sizeX = +((bbox.maxX - bbox.minX).toFixed(6));
    bbox.sizeY = +((bbox.maxY - bbox.minY).toFixed(6));
    bbox.sizeZ = +((bbox.maxZ - bbox.minZ).toFixed(6));
  }

  return {
    format: "STL", subFormat: "Binary",
    header: header || null,
    declaredFaceCount: declaredFaces,
    faceCount, vertexCount,
    hasNormals: true,
    sizeMatch,
    bbox, sampleVerts, sampleFaces,
    facesTruncated: declaredFaces > MAX_FACES,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// PLY Parser
// ═══════════════════════════════════════════════════════════════════════════════
const PLY_SCALAR_SIZES = {
  char: 1, uchar: 1, short: 2, ushort: 2, int: 4, uint: 4, float: 4, double: 8,
  int8: 1, uint8: 1, int16: 2, uint16: 2, int32: 4, uint32: 4, float32: 4, float64: 8,
};

function readPlyScalar(buf, offset, type, le) {
  switch (type) {
    case "char":   case "int8":   return { val: buf.readInt8(offset),   size: 1 };
    case "uchar":  case "uint8":  return { val: buf.readUInt8(offset),  size: 1 };
    case "short":  case "int16":  return { val: le ? buf.readInt16LE(offset)  : buf.readInt16BE(offset),  size: 2 };
    case "ushort": case "uint16": return { val: le ? buf.readUInt16LE(offset) : buf.readUInt16BE(offset), size: 2 };
    case "int":    case "int32":  return { val: le ? buf.readInt32LE(offset)  : buf.readInt32BE(offset),  size: 4 };
    case "uint":   case "uint32": return { val: le ? buf.readUInt32LE(offset) : buf.readUInt32BE(offset), size: 4 };
    case "float":  case "float32":return { val: le ? buf.readFloatLE(offset)  : buf.readFloatBE(offset), size: 4 };
    case "double": case "float64":return { val: le ? buf.readDoubleLE(offset) : buf.readDoubleBE(offset),size: 8 };
    default: throw new Error(`3d_client: unknown PLY scalar type '${type}'.`);
  }
}

function parsePly(buf, fileSize) {
  // Read header (text, terminated by "end_header")
  const MAX_HEADER = 65536;
  const headerText = buf.slice(0, Math.min(MAX_HEADER, buf.length)).toString("latin1");
  const eoh = headerText.indexOf("end_header");
  if (eoh === -1) throw new Error("3d_client: PLY missing 'end_header'.");

  const headerLines = headerText.slice(0, eoh).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!headerLines[0] || !headerLines[0].startsWith("ply"))
    throw new Error("3d_client: not a valid PLY file.");

  // Find data start offset
  const nlAfterEoh = headerText.indexOf("\n", eoh + "end_header".length);
  const dataStart = nlAfterEoh + 1;

  let format = "ascii"; // ascii | binary_little_endian | binary_big_endian
  let le = true;
  const elements = [];   // [{name, count, props:[{name,type,listCountType?,listItemType?}]}]
  let currentEl = null;
  let comments = [];

  for (const line of headerLines) {
    const parts = line.split(/\s+/);
    if (parts[0] === "format") {
      format = parts[1];
      le = format === "binary_little_endian";
    } else if (parts[0] === "element") {
      if (currentEl) elements.push(currentEl);
      currentEl = { name: parts[1], count: parseInt(parts[2], 10), props: [] };
    } else if (parts[0] === "property" && currentEl) {
      if (parts[1] === "list") {
        currentEl.props.push({ name: parts[4], isList: true, listCountType: parts[2], listItemType: parts[3] });
      } else {
        currentEl.props.push({ name: parts[2], type: parts[1], isList: false });
      }
    } else if (parts[0] === "comment") {
      comments.push(line.slice(7).trim());
    }
  }
  if (currentEl) elements.push(currentEl);

  const vertexEl = elements.find(e => e.name === "vertex");
  const faceEl   = elements.find(e => e.name === "face");
  const edgeEl   = elements.find(e => e.name === "edge");

  const vertexCount = vertexEl ? vertexEl.count : 0;
  const faceCount   = faceEl   ? faceEl.count   : 0;
  const edgeCount   = edgeEl   ? edgeEl.count   : 0;

  const vertexProps = vertexEl ? vertexEl.props.map(p => p.name) : [];
  const hasColors  = vertexProps.some(p => p === "red" || p === "r");
  const hasNormals = vertexProps.some(p => p === "nx");
  const hasUVs     = vertexProps.some(p => p === "s" || p === "texture_u" || p === "u");

  let sampleVerts = [], sampleFaces = [], bbox = null;

  if (format === "ascii") {
    // ASCII: parse text lines after data start
    const dataText = buf.slice(dataStart).toString("latin1");
    const dataLines = dataText.split(/\r?\n/).filter(l => l.trim().length > 0);
    let lineIdx = 0;

    // Parse vertex element
    if (vertexEl) {
      const xIdx = vertexEl.props.findIndex(p => p.name === "x");
      const yIdx = vertexEl.props.findIndex(p => p.name === "y");
      const zIdx = vertexEl.props.findIndex(p => p.name === "z");
      const count = Math.min(vertexEl.count, MAX_VERTICES);
      for (let i = 0; i < count && lineIdx < dataLines.length; i++, lineIdx++) {
        const vals = dataLines[lineIdx].trim().split(/\s+/).map(Number);
        if (xIdx >= 0 && yIdx >= 0 && zIdx >= 0) {
          const x = vals[xIdx], y = vals[yIdx], z = vals[zIdx];
          if (!isNaN(x) && !isNaN(y) && !isNaN(z)) {
            if (!bbox) bbox = { minX: x, maxX: x, minY: y, maxY: y, minZ: z, maxZ: z };
            else {
              if (x < bbox.minX) bbox.minX = x; if (x > bbox.maxX) bbox.maxX = x;
              if (y < bbox.minY) bbox.minY = y; if (y > bbox.maxY) bbox.maxY = y;
              if (z < bbox.minZ) bbox.minZ = z; if (z > bbox.maxZ) bbox.maxZ = z;
            }
            if (sampleVerts.length < MAX_SAMPLE_VERTS) sampleVerts.push({ x, y, z });
          }
        }
      }
      // Skip remaining vertex lines if truncated
      for (let i = count; i < vertexEl.count && lineIdx < dataLines.length; i++, lineIdx++) {}
    }

    // Parse face element
    if (faceEl) {
      const listProp = faceEl.props.find(p => p.isList);
      const fCount = Math.min(faceEl.count, MAX_FACES);
      for (let i = 0; i < fCount && lineIdx < dataLines.length; i++, lineIdx++) {
        const parts = dataLines[lineIdx].trim().split(/\s+/);
        if (listProp && parts.length > 0) {
          const n = parseInt(parts[0], 10);
          const indices = parts.slice(1, 1 + n).map(Number);
          if (sampleFaces.length < MAX_SAMPLE_FACES)
            sampleFaces.push({ vertexCount: n, indices });
        }
      }
    }
  } else {
    // Binary PLY
    let off = dataStart;

    if (vertexEl) {
      const props = vertexEl.props;
      const xProp = props.find(p => p.name === "x");
      const yProp = props.find(p => p.name === "y");
      const zProp = props.find(p => p.name === "z");
      const count = Math.min(vertexEl.count, MAX_VERTICES);

      for (let i = 0; i < count && off < buf.length; i++) {
        let xv = NaN, yv = NaN, zv = NaN;
        let localOff = off;
        // Read all props in order
        for (const prop of props) {
          if (localOff >= buf.length) break;
          if (prop.isList) {
            const cs = readPlyScalar(buf, localOff, prop.listCountType, le);
            localOff += cs.size;
            const n = cs.val;
            if (n < 0 || localOff + n * (PLY_SCALAR_SIZES[prop.listItemType] || 4) > buf.length) break;
            localOff += n * (PLY_SCALAR_SIZES[prop.listItemType] || 4);
          } else {
            const size = PLY_SCALAR_SIZES[prop.type] || 4;
            if (prop === xProp) { const r = readPlyScalar(buf, localOff, prop.type, le); xv = r.val; }
            else if (prop === yProp) { const r = readPlyScalar(buf, localOff, prop.type, le); yv = r.val; }
            else if (prop === zProp) { const r = readPlyScalar(buf, localOff, prop.type, le); zv = r.val; }
            localOff += size;
          }
        }
        // Advance main offset by one full vertex record
        // Recompute vertex record size
        let vRecordSize = 0;
        for (const prop of props) {
          if (prop.isList) break; // variable length — handled above
          vRecordSize += PLY_SCALAR_SIZES[prop.type] || 4;
        }
        off += vRecordSize || 12;

        if (!isNaN(xv) && !isNaN(yv) && !isNaN(zv)) {
          if (!bbox) bbox = { minX: xv, maxX: xv, minY: yv, maxY: yv, minZ: zv, maxZ: zv };
          else {
            if (xv < bbox.minX) bbox.minX = xv; if (xv > bbox.maxX) bbox.maxX = xv;
            if (yv < bbox.minY) bbox.minY = yv; if (yv > bbox.maxY) bbox.maxY = yv;
            if (zv < bbox.minZ) bbox.minZ = zv; if (zv > bbox.maxZ) bbox.maxZ = zv;
          }
          if (sampleVerts.length < MAX_SAMPLE_VERTS) sampleVerts.push({ x: xv, y: yv, z: zv });
        }
      }
    }

    if (faceEl) {
      const listProp = faceEl.props.find(p => p.isList);
      const fCount = Math.min(faceEl.count, MAX_FACES);
      for (let i = 0; i < fCount && off < buf.length; i++) {
        if (listProp) {
          if (off >= buf.length) break;
          const cs = readPlyScalar(buf, off, listProp.listCountType, le);
          off += cs.size;
          const n = cs.val;
          const itemSize = PLY_SCALAR_SIZES[listProp.listItemType] || 4;
          if (n < 0 || off + n * itemSize > buf.length) break;
          if (sampleFaces.length < MAX_SAMPLE_FACES) {
            const indices = [];
            for (let j = 0; j < n; j++) {
              const r = readPlyScalar(buf, off + j * itemSize, listProp.listItemType, le);
              indices.push(r.val);
            }
            sampleFaces.push({ vertexCount: n, indices });
          }
          off += n * itemSize;
          // Skip other non-list props in face element
          for (const prop of faceEl.props) {
            if (!prop.isList) off += PLY_SCALAR_SIZES[prop.type] || 4;
          }
        } else {
          // No list prop — skip record
          for (const prop of faceEl.props)
            off += PLY_SCALAR_SIZES[prop.type] || 4;
        }
      }
    }
  }

  if (bbox) {
    bbox.sizeX = +((bbox.maxX - bbox.minX).toFixed(6));
    bbox.sizeY = +((bbox.maxY - bbox.minY).toFixed(6));
    bbox.sizeZ = +((bbox.maxZ - bbox.minZ).toFixed(6));
  }

  return {
    format: "PLY",
    subFormat: format === "ascii" ? "ASCII" : (le ? "Binary LE" : "Binary BE"),
    elements: elements.map(e => ({ name: e.name, count: e.count,
      properties: e.props.map(p => p.isList
        ? `list ${p.listCountType} ${p.listItemType} ${p.name}`
        : `${p.type} ${p.name}`) })),
    vertexCount, faceCount, edgeCount,
    vertexProperties: vertexProps,
    hasNormals, hasColors, hasUVs,
    comments,
    bbox, sampleVerts, sampleFaces,
    verticesTruncated: vertexCount > MAX_VERTICES,
    facesTruncated:    faceCount  > MAX_FACES,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// GLTF JSON Parser
// ═══════════════════════════════════════════════════════════════════════════════
function parseGltfJson(jsonStr, filePath) {
  let gltf;
  try { gltf = JSON.parse(jsonStr); }
  catch (e) { throw new Error(`3d_client: GLTF JSON parse error: ${e.message}`); }

  return extractGltfData(gltf, filePath, "GLTF");
}

function extractGltfData(gltf, filePath, fmt) {
  const asset    = gltf.asset    || {};
  const scenes   = gltf.scenes   || [];
  const nodes    = gltf.nodes    || [];
  const meshes   = gltf.meshes   || [];
  const materials= gltf.materials|| [];
  const textures = gltf.textures || [];
  const images   = gltf.images   || [];
  const buffers  = gltf.buffers  || [];
  const accessors= gltf.accessors|| [];
  const animations = gltf.animations || [];
  const skins    = gltf.skins    || [];
  const cameras  = gltf.cameras  || [];
  const extensions = gltf.extensionsUsed || [];

  // Count total vertices and faces from accessors
  let vertexCount = 0, faceCount = 0;
  const POSITION_TYPE_IDX = 0; // POSITION accessor → VEC3
  const INDICES_COMPONENT = ["SCALAR"]; // scalar accessor → face indices

  // Collect accessor-based stats
  for (const mesh of meshes) {
    for (const prim of (mesh.primitives || [])) {
      if (prim.attributes && prim.attributes.POSITION !== undefined) {
        const acc = accessors[prim.attributes.POSITION];
        if (acc) vertexCount += acc.count || 0;
      }
      if (prim.indices !== undefined) {
        const acc = accessors[prim.indices];
        if (acc) faceCount += Math.floor((acc.count || 0) / 3);
      }
    }
  }

  // Material info
  const matInfo = materials.slice(0, MAX_MATERIALS).map(m => ({
    name: m.name || null,
    alphaMode: m.alphaMode || "OPAQUE",
    doubleSided: m.doubleSided || false,
    hasPBR:  !!m.pbrMetallicRoughness,
    hasNormalMap: !!(m.normalTexture),
    hasOcclusionMap: !!(m.occlusionTexture),
    hasEmissiveMap: !!(m.emissiveTexture),
  }));

  return {
    format: fmt,
    generator:   asset.generator   || null,
    version:     asset.version     || null,
    minVersion:  asset.minVersion  || null,
    copyright:   asset.copyright   || null,
    sceneCount:  scenes.length,
    nodeCount:   nodes.length,
    meshCount:   meshes.length,
    materialCount: materials.length,
    textureCount:  textures.length,
    imageCount:    images.length,
    bufferCount:   buffers.length,
    accessorCount: accessors.length,
    animationCount: animations.length,
    skinCount:     skins.length,
    cameraCount:   cameras.length,
    extensionsUsed: extensions,
    vertexCount, faceCount,
    materials: matInfo,
    defaultScene: gltf.scene !== undefined ? gltf.scene : null,
    meshNames: meshes.slice(0, 200).map(m => m.name || null),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// GLB Binary Parser
// ═══════════════════════════════════════════════════════════════════════════════
function parseGlb(buf, fileSize, filePath) {
  if (buf.length < 12) throw new Error("3d_client: GLB file too small.");
  const magic   = buf.readUInt32LE(0);
  if (magic !== 0x46546C67) throw new Error("3d_client: not a valid GLB file (bad magic).");
  const version = buf.readUInt32LE(4);
  const length  = buf.readUInt32LE(8);

  if (buf.length < 20) throw new Error("3d_client: GLB too small for chunk 0.");
  const chunk0Length = buf.readUInt32LE(12);
  const chunk0Type   = buf.readUInt32LE(16); // 0x4E4F534A = JSON
  if (chunk0Type !== 0x4E4F534A)
    throw new Error(`3d_client: GLB chunk 0 is not JSON (type=0x${chunk0Type.toString(16)}).`);
  if (20 + chunk0Length > buf.length)
    throw new Error("3d_client: GLB chunk 0 extends beyond buffer.");

  const jsonStr = buf.slice(20, 20 + chunk0Length).toString("utf8");
  const result  = parseGltfJson(jsonStr, filePath);

  // Check for BIN chunk
  const binChunkOff = 12 + 4 + 4 + chunk0Length;
  let binaryChunkSize = 0;
  if (binChunkOff + 8 <= buf.length) {
    binaryChunkSize = buf.readUInt32LE(binChunkOff);
    const binChunkType = buf.readUInt32LE(binChunkOff + 4); // 0x004E4942 = BIN
  }

  return {
    ...result,
    format: "GLB",
    glbVersion: version,
    glbTotalLength: length,
    jsonChunkSize: chunk0Length,
    binaryChunkSize,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Main entry
// ═══════════════════════════════════════════════════════════════════════════════
function client3d(args) {
  const { operation, path: filePath } = args;
  if (!operation) throw new Error("3d_client: 'operation' is required.");
  if (!filePath)  throw new Error("3d_client: 'path' is required.");
  const VALID_OPS = ["info", "vertices", "faces", "materials", "validate"];
  if (!VALID_OPS.includes(operation))
    throw new Error(`3d_client: unknown operation '${operation}'. Valid: ${VALID_OPS.join(", ")}.`);
  if (filePath.includes("\0")) throw new Error("3d_client: path contains NUL byte.");

  // Stat + read head for format detection
  const { buf: headBuf, fileSize } = readHead(filePath, MAX_READ_HEAD);
  const fmt = detectFormat(headBuf, filePath);
  if (!fmt)
    throw new Error(`3d_client: unrecognized 3D format for '${path.basename(filePath)}'. Supported: OBJ, STL, PLY, GLTF, GLB.`);

  // For text formats that need full content; binary we also need full buf for PLY/STL/GLB
  let parsed;
  const needFull = ["stl-binary", "ply", "glb"].includes(fmt)
    || (["stl-ascii", "obj", "gltf", "mtl"].includes(fmt) && fileSize <= MAX_READ_HEAD);

  let fullBuf = headBuf;
  if (needFull && fileSize > MAX_READ_HEAD) {
    fullBuf = readFull(filePath).buf;
  }

  switch (fmt) {
    case "obj":
    case "mtl": {
      // Always text
      const text = fullBuf.toString("utf8");
      if (fmt === "mtl") {
        const mats = parseMtlText(text);
        parsed = {
          format: "MTL", fileSize,
          materialCount: mats.length,
          materials: mats.slice(0, MAX_MATERIALS),
          materialsTruncated: mats.length > MAX_MATERIALS,
        };
      } else {
        parsed = parseObjText(text, { operation });
        parsed.fileSize = fileSize;
      }
      break;
    }
    case "stl-ascii": {
      const text = fullBuf.toString("utf8");
      parsed = parseStlAscii(text);
      parsed.fileSize = fileSize;
      break;
    }
    case "stl-binary": {
      parsed = parseStlBinary(fullBuf, fileSize);
      parsed.fileSize = fileSize;
      break;
    }
    case "ply": {
      parsed = parsePly(fullBuf, fileSize);
      parsed.fileSize = fileSize;
      break;
    }
    case "gltf": {
      const text = fullBuf.toString("utf8");
      parsed = parseGltfJson(text, filePath);
      parsed.fileSize = fileSize;
      break;
    }
    case "glb": {
      parsed = parseGlb(fullBuf, fileSize, filePath);
      parsed.fileSize = fileSize;
      break;
    }
    default:
      throw new Error(`3d_client: unsupported format '${fmt}'.`);
  }

  const base = {
    path: filePath, operation,
    format: parsed.format, fileSize: parsed.fileSize,
  };

  // ── info ──────────────────────────────────────────────────────────────────
  if (operation === "info") {
    const info = { ...base };
    const fields = [
      "subFormat", "generator", "version", "minVersion", "copyright",
      "glbVersion", "glbTotalLength", "jsonChunkSize", "binaryChunkSize",
      "solidName", "header",
      "vertexCount", "faceCount", "normalCount", "uvCount",
      "edgeCount", "lineCount",
      "hasNormals", "hasUVs", "hasColors",
      "verticesTruncated", "facesTruncated",
      "sceneCount", "nodeCount", "meshCount", "materialCount",
      "textureCount", "imageCount", "bufferCount", "accessorCount",
      "animationCount", "skinCount", "cameraCount",
      "extensionsUsed", "defaultScene",
      "objects", "materialLibraries", "usedMaterials",
      "meshNames",
      "comments", "elements", "vertexProperties",
      "declaredFaceCount", "sizeMatch",
      "ilumModel", "bbox",
    ];
    for (const f of fields)
      if (parsed[f] !== undefined) info[f] = parsed[f];
    return info;
  }

  // ── vertices ──────────────────────────────────────────────────────────────
  if (operation === "vertices") {
    const verts = (parsed.sampleVerts || []).slice(0, args.limit || MAX_SAMPLE_VERTS);
    return {
      ...base,
      totalVertexCount: parsed.vertexCount || 0,
      returnedCount: verts.length,
      truncated: (parsed.vertexCount || 0) > verts.length,
      vertices: verts,
      bbox: parsed.bbox || null,
    };
  }

  // ── faces ─────────────────────────────────────────────────────────────────
  if (operation === "faces") {
    const faces = (parsed.sampleFaces || []).slice(0, args.limit || MAX_SAMPLE_FACES);
    return {
      ...base,
      totalFaceCount: parsed.faceCount || 0,
      returnedCount: faces.length,
      truncated: (parsed.faceCount || 0) > faces.length,
      faces,
    };
  }

  // ── materials ─────────────────────────────────────────────────────────────
  if (operation === "materials") {
    // For OBJ: try to load the mtllib file(s)
    const dir = path.dirname(filePath);
    const result = {
      ...base,
      materialCount: parsed.materialCount || 0,
      materials: parsed.materials || [],
    };
    if (parsed.materialLibraries && parsed.materialLibraries.length > 0) {
      result.materialLibraries = parsed.materialLibraries;
      const loadedMats = [];
      for (const mtllib of parsed.materialLibraries.slice(0, 10)) {
        const mtlPath = path.join(dir, mtllib);
        try {
          const mtlText = fs.readFileSync(mtlPath, "utf8");
          const mats = parseMtlText(mtlText);
          loadedMats.push(...mats);
        } catch { /* MTL file not accessible */ }
      }
      if (loadedMats.length > 0) {
        result.materials = loadedMats;
        result.materialCount = loadedMats.length;
      } else if (parsed.usedMaterials && parsed.usedMaterials.length > 0) {
        result.usedMaterials = parsed.usedMaterials;
        result.materialCount = parsed.usedMaterials.length;
      }
    }
    return result;
  }

  // ── validate ──────────────────────────────────────────────────────────────
  if (operation === "validate") {
    const issues = [];
    if (!parsed.vertexCount && !parsed.meshCount)
      issues.push("No vertices or meshes found.");
    if (parsed.vertexCount === 0 && !parsed.meshCount)
      issues.push("Vertex count is 0.");
    if (fmt === "stl-binary" && !parsed.sizeMatch)
      issues.push(`STL binary: declared face count (${parsed.declaredFaceCount}) does not match file size.`);
    if (fmt === "ply" && !parsed.vertexCount)
      issues.push("PLY: no vertex element found.");
    if ((fmt === "gltf" || fmt === "glb") && !parsed.meshCount)
      issues.push("GLTF/GLB: no meshes found.");
    if (parsed.verticesTruncated)
      issues.push(`Vertex count exceeds limit (${MAX_VERTICES}); only partial data parsed.`);
    if (parsed.facesTruncated)
      issues.push(`Face count exceeds limit (${MAX_FACES}); only partial data parsed.`);
    return {
      ...base,
      valid: issues.length === 0,
      issueCount: issues.length,
      issues,
      vertexCount: parsed.vertexCount || 0,
      faceCount:   parsed.faceCount   || 0,
      hasNormals:  parsed.hasNormals  || false,
      bbox: parsed.bbox || null,
    };
  }

  throw new Error(`3d_client: unhandled operation '${operation}'.`);
}

module.exports = { client3d };
