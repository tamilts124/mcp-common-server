"use strict";
// utilSchemas71: 3d_client

const UTIL_SCHEMAS_71 = [
  {
    name: "3d_client",
    description:
      "Zero-dependency 3D model file reader (pure Node.js; no npm deps). " +
      "Reads 3D model files without external libraries — no Three.js, Assimp, or Blender required. " +
      "Operations: info (format, vertex/face counts, bounding box, normals/UVs/colors, materials, scene graph), " +
      "vertices (first N XYZ positions with bounding box), " +
      "faces (first N face records with vertex indices), " +
      "materials (material definitions including colors, textures, PBR properties), " +
      "validate (structural integrity check — reports missing geometry, size mismatches, truncation). " +
      "Formats: OBJ + MTL (Wavefront Object — vertices, normals, UVs, groups, mtllib references), " +
      "STL ASCII (text triangles with normals and vertex XYZ), " +
      "STL Binary (80-byte header, packed float32 triangles, attribute bytes), " +
      "PLY ASCII and Binary LE/BE (Polygon File Format — arbitrary element/property schema, " +
      "vertex colors, custom attributes), " +
      "GLTF (.gltf JSON — GL Transmission Format, PBR materials, animations, skins, cameras, extensions), " +
      "GLB (.glb binary GLTF container — JSON chunk + optional BIN chunk). " +
      "Security: 200 MB file cap; 10 MB text sample window; NUL-byte and directory guards; " +
      "vertex/face caps at 5 M each; MAX_SAMPLE=1000 vertices/faces returned.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["info", "vertices", "faces", "materials", "validate"],
          description:
            "info: format, vertex/face counts, bbox, normals/UVs flags, material libraries, " +
            "scene structure (meshes/nodes/animations for GLTF), PLY element schema. " +
            "vertices: first N XYZ positions (up to limit, default 1000) with bbox and total count. " +
            "faces: first N face records with vertex index arrays and total count. " +
            "materials: material definitions (OBJ loads companion .mtl file; GLTF extracts PBR materials). " +
            "validate: structural integrity — missing geometry, STL size mismatch, vertex/face overflow.",
        },
        path: {
          type: "string",
          description:
            "Absolute path to the 3D model file (.obj, .mtl, .stl, .ply, .gltf, .glb).",
        },
        limit: {
          type: "number",
          description:
            "[vertices/faces] Maximum number of items to return (1–1000, default 1000).",
        },
      },
      required: ["operation", "path"],
    },
  },
];

module.exports = { UTIL_SCHEMAS_71 };
