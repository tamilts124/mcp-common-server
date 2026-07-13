"use strict";
// ── geo_client — zero-dep geospatial file reader (pure Node.js) ───────────────
// Operations: info, read, search, stats, bbox, convert
// Formats (auto-detected): GeoJSON, KML, GPX, TopoJSON
// Security: 200 MB file cap; 500,000 feature limit; NUL-byte guard; directory guard

const fs   = require("fs");
const path = require("path");
const { ToolError } = require("./errors");

const MAX_FILE_SIZE    = 200 * 1024 * 1024; // 200 MB
const MAX_FEATURES     = 500_000;
const MAX_READ_FEATS   = 10_000;
const MAX_SEARCH_FEATS = 10_000;

// ══════════════════════════════════════════════════════════════════════════════
// FILE LOADING & FORMAT DETECTION
// ══════════════════════════════════════════════════════════════════════════════

function loadFile(filePath) {
  if (!filePath || typeof filePath !== "string")
    throw new ToolError("geo_client: 'path' must be a non-empty string.", -32602);
  if (filePath.includes("\0"))
    throw new ToolError("geo_client: 'path' must not contain NUL bytes.", -32602);

  let resolved;
  try { resolved = path.resolve(filePath); } catch {
    throw new ToolError(`geo_client: Cannot resolve path '${filePath}'.`, -32602);
  }

  let stat;
  try { stat = fs.statSync(resolved); } catch (e) {
    throw new ToolError(`geo_client: Cannot access '${filePath}': ${e.message}`, -32602);
  }
  if (stat.isDirectory())
    throw new ToolError(`geo_client: '${filePath}' is a directory, not a file.`, -32602);
  if (stat.size > MAX_FILE_SIZE)
    throw new ToolError(
      `geo_client: File too large (${stat.size} bytes; limit ${MAX_FILE_SIZE}).`, -32602
    );

  return { text: fs.readFileSync(resolved, "utf8"), stat, resolved };
}

function detectFormat(text, filePath) {
  const trimmed = text.trimStart();
  const ext = path.extname(filePath).toLowerCase();

  // KML: XML with <kml xmlns
  if (/<kml[\s>]/i.test(trimmed.slice(0, 512)))
    return "kml";
  // GPX: XML with <gpx
  if (/<gpx[\s>]/i.test(trimmed.slice(0, 512)))
    return "gpx";
  // TopoJSON: has "type":"Topology"
  if (trimmed.startsWith("{")) {
    try {
      const peek = JSON.parse(trimmed);
      if (peek.type === "Topology") return "topojson";
      if (peek.type === "FeatureCollection" || peek.type === "Feature" ||
          peek.type === "GeometryCollection" || ["Point","MultiPoint",
          "LineString","MultiLineString","Polygon","MultiPolygon"].includes(peek.type))
        return "geojson";
    } catch { /* fall through to ext check */ }
  }
  // Extension fallback
  if (ext === ".kml") return "kml";
  if (ext === ".gpx") return "gpx";
  if (ext === ".geojson") return "geojson";
  return "geojson"; // default
}

// ══════════════════════════════════════════════════════════════════════════════
// BOUNDING BOX HELPERS
// ══════════════════════════════════════════════════════════════════════════════

function emptyBbox() { return [Infinity, Infinity, -Infinity, -Infinity]; }

function expandBbox(bbox, lon, lat) {
  if (!isFinite(lon) || !isFinite(lat)) return;
  if (lon < bbox[0]) bbox[0] = lon;
  if (lat < bbox[1]) bbox[1] = lat;
  if (lon > bbox[2]) bbox[2] = lon;
  if (lat > bbox[3]) bbox[3] = lat;
}

function bboxValid(bbox) {
  return bbox[0] !== Infinity && bbox[2] !== -Infinity;
}

function bboxFromGeometry(geom, bbox) {
  if (!geom) return;
  const type = geom.type;
  const coords = geom.coordinates;
  switch (type) {
    case "Point":
      expandBbox(bbox, coords[0], coords[1]);
      break;
    case "MultiPoint":
    case "LineString":
      for (const c of coords) expandBbox(bbox, c[0], c[1]);
      break;
    case "MultiLineString":
    case "Polygon":
      for (const ring of coords)
        for (const c of ring) expandBbox(bbox, c[0], c[1]);
      break;
    case "MultiPolygon":
      for (const poly of coords)
        for (const ring of poly)
          for (const c of ring) expandBbox(bbox, c[0], c[1]);
      break;
    case "GeometryCollection":
      for (const g of (geom.geometries || [])) bboxFromGeometry(g, bbox);
      break;
  }
}

function bboxIntersects(abbox, qbbox) {
  // abbox = [minLon,minLat,maxLon,maxLat]
  return (
    abbox[0] <= qbbox[2] && abbox[2] >= qbbox[0] &&
    abbox[1] <= qbbox[3] && abbox[3] >= qbbox[1]
  );
}

function featureBbox(feature) {
  const bbox = emptyBbox();
  bboxFromGeometry(feature.geometry, bbox);
  return bboxValid(bbox) ? bbox : null;
}

// ══════════════════════════════════════════════════════════════════════════════
// GEOJSON PARSER
// ══════════════════════════════════════════════════════════════════════════════

function parseGeoJSON(text) {
  let obj;
  try { obj = JSON.parse(text); } catch (e) {
    throw new ToolError(`geo_client: Invalid JSON: ${e.message}`, -32602);
  }
  return normalizeToFeatures(obj);
}

function normalizeToFeatures(obj) {
  if (!obj || typeof obj !== "object")
    throw new ToolError("geo_client: GeoJSON root must be an object.", -32602);

  if (obj.type === "FeatureCollection") {
    const feats = obj.features || [];
    if (feats.length > MAX_FEATURES)
      throw new ToolError(`geo_client: Too many features (${feats.length}; limit ${MAX_FEATURES}).`, -32602);
    return {
      type: "FeatureCollection",
      features: feats.map((f, i) => ensureFeature(f, i)),
      meta: { name: obj.name || null, bbox: obj.bbox || null, crs: obj.crs || null },
    };
  }
  if (obj.type === "Feature") {
    return { type: "FeatureCollection", features: [ensureFeature(obj, 0)], meta: {} };
  }
  // Bare geometry
  const GEOM_TYPES = ["Point","MultiPoint","LineString","MultiLineString",
                      "Polygon","MultiPolygon","GeometryCollection"];
  if (GEOM_TYPES.includes(obj.type)) {
    return {
      type: "FeatureCollection",
      features: [{ type: "Feature", id: null, geometry: obj, properties: {} }],
      meta: {},
    };
  }
  throw new ToolError(`geo_client: Unknown GeoJSON type '${obj.type}'.`, -32602);
}

function ensureFeature(f, idx) {
  if (!f || f.type !== "Feature") {
    return { type: "Feature", id: idx, geometry: f, properties: {} };
  }
  return {
    type: "Feature",
    id: f.id !== undefined ? f.id : null,
    geometry: f.geometry || null,
    properties: f.properties || {},
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// TOPOJSON PARSER
// ══════════════════════════════════════════════════════════════════════════════

function parseTopoJSON(text) {
  let obj;
  try { obj = JSON.parse(text); } catch (e) {
    throw new ToolError(`geo_client: Invalid TopoJSON: ${e.message}`, -32602);
  }
  if (obj.type !== "Topology")
    throw new ToolError("geo_client: Not a valid TopoJSON Topology object.", -32602);

  const arcs = obj.arcs || [];
  const transform = obj.transform || null;

  // Decode delta-coded arcs
  function decodeArc(arcIdx) {
    const arc = arcs[arcIdx < 0 ? ~arcIdx : arcIdx];
    if (!arc) return [];
    let x = 0, y = 0;
    const pts = arc.map(([dx, dy]) => {
      x += dx; y += dy;
      if (transform) {
        return [
          x * transform.scale[0] + transform.translate[0],
          y * transform.scale[1] + transform.translate[1],
        ];
      }
      return [x, y];
    });
    return arcIdx < 0 ? pts.reverse() : pts;
  }

  function topoGeomToGeoJSON(geom) {
    if (!geom) return null;
    switch (geom.type) {
      case "Point":
        return { type: "Point", coordinates: geom.coordinates };
      case "MultiPoint":
        return { type: "MultiPoint", coordinates: geom.coordinates };
      case "LineString":
        return { type: "LineString", coordinates: decodeArc(geom.arcs[0]) };
      case "MultiLineString":
        return { type: "MultiLineString", coordinates: geom.arcs.map(a => decodeArc(a[0])) };
      case "Polygon":
        return { type: "Polygon", coordinates: geom.arcs.map(ring => ring.flatMap(decodeArc)) };
      case "MultiPolygon":
        return {
          type: "MultiPolygon",
          coordinates: geom.arcs.map(poly => poly.map(ring => ring.flatMap(decodeArc))),
        };
      case "GeometryCollection":
        return {
          type: "GeometryCollection",
          geometries: geom.geometries.map(topoGeomToGeoJSON),
        };
      default:
        return null;
    }
  }

  const features = [];
  for (const [objName, topoObj] of Object.entries(obj.objects || {})) {
    if (topoObj.type === "GeometryCollection") {
      for (const geom of topoObj.geometries) {
        features.push({
          type: "Feature",
          id: geom.id !== undefined ? geom.id : null,
          geometry: topoGeomToGeoJSON(geom),
          properties: { ...geom.properties, _topo_object: objName },
        });
      }
    }
  }

  if (features.length > MAX_FEATURES)
    throw new ToolError(`geo_client: Too many features (${features.length}; limit ${MAX_FEATURES}).`, -32602);

  return {
    type: "FeatureCollection",
    features,
    meta: {
      topoObjects: Object.keys(obj.objects || {}),
      arcs: arcs.length,
      hasTransform: !!transform,
      bbox: obj.bbox || null,
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// KML PARSER
// ══════════════════════════════════════════════════════════════════════════════

// Minimal zero-dep XML tag extractor (not a full XML parser, but handles KML's
// straightforward tag nesting for all major geometry and placemark constructs)

function xmlTextContent(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = re.exec(xml);
  return m ? m[1].trim() : null;
}

function xmlAllTags(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
  const results = [];
  let m;
  while ((m = re.exec(xml)) !== null) results.push(m[1].trim());
  return results;
}

function xmlAttr(tag, attr) {
  const re = new RegExp(`${attr}="([^"]*)"`,'i');
  const m = re.exec(tag);
  return m ? m[1] : null;
}

function parseCoordsStr(str) {
  // KML coordinate tuples: "lon,lat[,alt] lon,lat[,alt] ..."
  const tuples = str.trim().split(/\s+/);
  return tuples
    .map(t => {
      const parts = t.split(",").map(Number);
      if (parts.length < 2 || isNaN(parts[0]) || isNaN(parts[1])) return null;
      return parts.length >= 3 ? [parts[0], parts[1], parts[2]] : [parts[0], parts[1]];
    })
    .filter(Boolean);
}

function parseKmlGeometry(placemarkXml) {
  // Point
  const pointCoords = xmlTextContent(placemarkXml, "coordinates");
  const hasPoint    = /<Point/i.test(placemarkXml);
  const hasLine     = /<LineString/i.test(placemarkXml);
  const hasPolygon  = /<Polygon/i.test(placemarkXml);
  const hasMultiGeo = /<MultiGeometry/i.test(placemarkXml);

  if (hasMultiGeo) {
    // Recursively extract sub-geometries (simplified: detect children by type)
    const geometries = [];
    const subGeoms = placemarkXml.match(/<(Point|LineString|Polygon)[\s\S]*?<\/\1>/gi) || [];
    for (const sg of subGeoms) {
      const g = parseKmlGeometry(sg);
      if (g) geometries.push(g);
    }
    return { type: "GeometryCollection", geometries };
  }

  if (hasPolygon) {
    // Outer + inner rings
    const outerStr = xmlTextContent(placemarkXml, "outerBoundaryIs") ||
                     xmlTextContent(placemarkXml, "coordinates");
    const outerCoords = outerStr ? parseCoordsStr(
      xmlTextContent(outerStr, "coordinates") || outerStr
    ) : [];
    const innerRings = xmlAllTags(placemarkXml, "innerBoundaryIs").map(inner => {
      const cs = xmlTextContent(inner, "coordinates");
      return cs ? parseCoordsStr(cs) : [];
    }).filter(r => r.length > 0);
    const rings = [outerCoords, ...innerRings];
    return { type: "Polygon", coordinates: rings };
  }

  if (hasLine) {
    const cs = xmlTextContent(placemarkXml, "coordinates");
    return cs ? { type: "LineString", coordinates: parseCoordsStr(cs) } : null;
  }

  if (hasPoint && pointCoords) {
    const pts = parseCoordsStr(pointCoords);
    return pts.length > 0 ? { type: "Point", coordinates: pts[0] } : null;
  }

  return null;
}

function parseKml(text) {
  const placemarkXmls = xmlAllTags(text, "Placemark");

  if (placemarkXmls.length > MAX_FEATURES)
    throw new ToolError(`geo_client: Too many placemarks (${placemarkXmls.length}; limit ${MAX_FEATURES}).`, -32602);

  const features = placemarkXmls.map((pm, i) => {
    const name        = xmlTextContent(pm, "name");
    const description = xmlTextContent(pm, "description");
    const styleUrl    = xmlTextContent(pm, "styleUrl");
    const snippet     = xmlTextContent(pm, "Snippet") || xmlTextContent(pm, "snippet");

    // Extended data
    const extData = {};
    const dataItems = pm.match(/<Data name="([^"]*)">([\s\S]*?)<\/Data>/gi) || [];
    for (const di of dataItems) {
      const nameMatch = /name="([^"]*)"/i.exec(di);
      const valMatch  = /<value>([\s\S]*?)<\/value>/i.exec(di);
      if (nameMatch && valMatch) extData[nameMatch[1]] = valMatch[1].trim();
    }
    // SimpleData
    const simpleData = pm.match(/<SimpleData name="([^"]*)">([\s\S]*?)<\/SimpleData>/gi) || [];
    for (const sd of simpleData) {
      const nameMatch = /name="([^"]*)"/i.exec(sd);
      const val = sd.replace(/<[^>]+>/g, "").trim();
      if (nameMatch) extData[nameMatch[1]] = val;
    }

    const geometry = parseKmlGeometry(pm);

    return {
      type: "Feature",
      id: i,
      geometry,
      properties: {
        name: name || null,
        description: description ? description.replace(/<[^>]+>/g, "").trim() : null,
        styleUrl: styleUrl || null,
        snippet: snippet ? snippet.replace(/<[^>]+>/g, "").trim() : null,
        ...extData,
      },
    };
  });

  // Extract document-level metadata
  const docName = xmlTextContent(text, "name");
  const docDesc = xmlTextContent(text, "description");

  return {
    type: "FeatureCollection",
    features,
    meta: {
      name: docName || null,
      description: docDesc ? docDesc.replace(/<[^>]+>/g, "").trim() : null,
    },
  };
}

// ═══════════════��══════════════════════════════════════════════════════════════
// GPX PARSER
// ══════════════════════════════════════════════════════════════════════════════

function parseGpxCoord(trkptXml) {
  // <trkpt lat="..." lon="..."> or <wpt lat="..." lon="...">
  const latStr = xmlAttr(trkptXml.match(/^<[^>]+>/)?.[0] || trkptXml, "lat");
  const lonStr = xmlAttr(trkptXml.match(/^<[^>]+>/)?.[0] || trkptXml, "lon");
  const lat = parseFloat(latStr);
  const lon = parseFloat(lonStr);
  if (isNaN(lat) || isNaN(lon)) return null;
  const ele = parseFloat(xmlTextContent(trkptXml, "ele"));
  return isNaN(ele) ? [lon, lat] : [lon, lat, ele];
}

function parseGpxPointProps(ptXml) {
  return {
    name:   xmlTextContent(ptXml, "name"),
    desc:   xmlTextContent(ptXml, "desc"),
    type:   xmlTextContent(ptXml, "type"),
    sym:    xmlTextContent(ptXml, "sym"),
    time:   xmlTextContent(ptXml, "time"),
    ele:    parseFloat(xmlTextContent(ptXml, "ele")) || null,
    cmt:    xmlTextContent(ptXml, "cmt"),
    link:   xmlAttr(xmlAllTags(ptXml, "link")[0] || "", "href"),
  };
}

function parseGpx(text) {
  const features = [];

  // ── Waypoints <wpt> ────────────────────────────────────────────────────────
  // Need to extract the opening tag too for lat/lon attrs
  const wptMatches = text.match(/<wpt[\s\S]*?<\/wpt>/gi) || [];
  for (const wpt of wptMatches) {
    const coord = parseGpxCoord(wpt);
    if (!coord) continue;
    const props = parseGpxPointProps(wpt);
    features.push({
      type: "Feature",
      id: null,
      geometry: { type: "Point", coordinates: coord },
      properties: { gpx_type: "waypoint", ...props },
    });
  }

  // ── Routes <rte> → <rtept> ─────────────────────────────────────────────────
  const rteMatches = xmlAllTags(text, "rte");
  for (const rte of rteMatches) {
    const rteName = xmlTextContent(rte, "name");
    const rteptMatches = rte.match(/<rtept[\s\S]*?<\/rtept>/gi) || [];
    const coords = rteptMatches.map(parseGpxCoord).filter(Boolean);
    if (coords.length === 0) continue;
    features.push({
      type: "Feature",
      id: null,
      geometry: { type: "LineString", coordinates: coords },
      properties: {
        gpx_type: "route",
        name: rteName || null,
        desc: xmlTextContent(rte, "desc"),
        type: xmlTextContent(rte, "type"),
        pointCount: coords.length,
      },
    });
  }

  // ── Tracks <trk> → <trkseg> → <trkpt> ────────────────────────────────────
  const trkMatches = xmlAllTags(text, "trk");
  for (const trk of trkMatches) {
    const trkName = xmlTextContent(trk, "name");
    const trkDesc = xmlTextContent(trk, "desc");
    const trkType = xmlTextContent(trk, "type");
    const segs = xmlAllTags(trk, "trkseg");

    if (segs.length === 1) {
      // Single segment → LineString
      const trkptMatches = segs[0].match(/<trkpt[\s\S]*?<\/trkpt>/gi) || [];
      const coords = trkptMatches.map(parseGpxCoord).filter(Boolean);
      // Timestamps for the track
      const times = trkptMatches.map(t => xmlTextContent(t, "time")).filter(Boolean);
      if (coords.length === 0) continue;
      features.push({
        type: "Feature",
        id: null,
        geometry: { type: "LineString", coordinates: coords },
        properties: {
          gpx_type: "track",
          name: trkName || null,
          desc: trkDesc || null,
          type: trkType || null,
          segmentCount: 1,
          pointCount: coords.length,
          startTime: times[0] || null,
          endTime: times[times.length - 1] || null,
        },
      });
    } else if (segs.length > 1) {
      // Multi-segment → MultiLineString
      const allCoords = [];
      let totalPts = 0;
      let firstTime = null, lastTime = null;
      for (const seg of segs) {
        const trkptMatches = seg.match(/<trkpt[\s\S]*?<\/trkpt>/gi) || [];
        const coords = trkptMatches.map(parseGpxCoord).filter(Boolean);
        const times = trkptMatches.map(t => xmlTextContent(t, "time")).filter(Boolean);
        allCoords.push(coords);
        totalPts += coords.length;
        if (!firstTime && times[0]) firstTime = times[0];
        if (times[times.length - 1]) lastTime = times[times.length - 1];
      }
      features.push({
        type: "Feature",
        id: null,
        geometry: { type: "MultiLineString", coordinates: allCoords },
        properties: {
          gpx_type: "track",
          name: trkName || null,
          desc: trkDesc || null,
          type: trkType || null,
          segmentCount: segs.length,
          pointCount: totalPts,
          startTime: firstTime,
          endTime: lastTime,
        },
      });
    }
  }

  if (features.length > MAX_FEATURES)
    throw new ToolError(`geo_client: Too many GPX features (limit ${MAX_FEATURES}).`, -32602);

  // Document metadata
  const metaXml  = xmlAllTags(text, "metadata")[0] || "";
  const gpxName  = xmlTextContent(metaXml || text, "name");
  const gpxDesc  = xmlTextContent(metaXml || text, "desc");
  const gpxAuthor = xmlTextContent(xmlAllTags(metaXml || text, "author")[0] || "", "name") ||
                    xmlTextContent(metaXml || text, "author");
  const gpxTime  = xmlTextContent(metaXml || text, "time");
  const gpxAttr  = xmlAttr(text.slice(0, 512), "creator");

  return {
    type: "FeatureCollection",
    features,
    meta: {
      name: gpxName || null,
      description: gpxDesc || null,
      author: gpxAuthor || null,
      time: gpxTime || null,
      creator: gpxAttr || null,
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// UNIFIED PARSER DISPATCHER
// ══════════════════════════════════════════════════════════════════════════════

function parseFile(text, fmt) {
  switch (fmt) {
    case "geojson":  return parseGeoJSON(text);
    case "topojson": return parseTopoJSON(text);
    case "kml":      return parseKml(text);
    case "gpx":      return parseGpx(text);
    default:
      throw new ToolError(`geo_client: Unknown format '${fmt}'.`, -32602);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// GEOMETRY STATISTICS
// ══════════════════════════════════════════════════════════════════════════════

function countCoordinates(geom) {
  if (!geom) return 0;
  switch (geom.type) {
    case "Point":           return 1;
    case "MultiPoint":
    case "LineString":      return (geom.coordinates || []).length;
    case "MultiLineString":
    case "Polygon":         return (geom.coordinates || []).reduce((s, r) => s + r.length, 0);
    case "MultiPolygon":    return (geom.coordinates || []).reduce((s, p) =>
                              s + p.reduce((ss, r) => ss + r.length, 0), 0);
    case "GeometryCollection":
      return (geom.geometries || []).reduce((s, g) => s + countCoordinates(g), 0);
    default: return 0;
  }
}

function geometryType(geom) {
  return geom ? geom.type : null;
}

// ══════════════════════════════════════════════════════════════════════════════
// FILTERING
// ══════════════════════════════════════════════════════════════════════════════

function applyFilters(features, args) {
  let result = features;

  // geometry_type filter
  if (args.geometry_type) {
    const types = (Array.isArray(args.geometry_type) ? args.geometry_type : [args.geometry_type])
      .map(t => t.toLowerCase());
    result = result.filter(f => (geometryType(f.geometry) || "").toLowerCase() === types.find(t => (geometryType(f.geometry) || "").toLowerCase() === t));
    // Simpler rewrite:
    const typeSet = new Set(types.map(t => t.toLowerCase()));
    result = features.filter(f => f.geometry && typeSet.has(f.geometry.type.toLowerCase()));
  }

  // property filter
  if (args.property && args.property_value !== undefined) {
    const prop  = args.property;
    const val   = String(args.property_value);
    result = result.filter(f => {
      const fv = (f.properties || {})[prop];
      return fv !== undefined && fv !== null && String(fv) === val;
    });
  }

  // property_contains filter (substring on string prop)
  if (args.property && args.property_contains !== undefined) {
    const prop  = args.property;
    const query = String(args.property_contains).toLowerCase();
    result = result.filter(f => {
      const fv = (f.properties || {})[prop];
      return fv !== undefined && fv !== null && String(fv).toLowerCase().includes(query);
    });
  }

  // feature_id filter
  if (args.feature_id !== undefined) {
    const idStr = String(args.feature_id);
    result = result.filter(f => String(f.id) === idStr);
  }

  // bbox filter [minLon, minLat, maxLon, maxLat]
  if (args.filter_bbox) {
    let qbbox;
    try {
      qbbox = Array.isArray(args.filter_bbox)
        ? args.filter_bbox.map(Number)
        : JSON.parse(args.filter_bbox);
    } catch {
      throw new ToolError("geo_client: 'filter_bbox' must be [minLon,minLat,maxLon,maxLat].", -32602);
    }
    if (!Array.isArray(qbbox) || qbbox.length !== 4 || qbbox.some(isNaN))
      throw new ToolError("geo_client: 'filter_bbox' must be [minLon,minLat,maxLon,maxLat] with numeric values.", -32602);
    result = result.filter(f => {
      const fb = featureBbox(f);
      return fb && bboxIntersects(fb, qbbox);
    });
  }

  // search: string search across all property values + id
  if (args.search) {
    const q = String(args.search).toLowerCase();
    result = result.filter(f => {
      if (String(f.id).toLowerCase().includes(q)) return true;
      for (const v of Object.values(f.properties || {})) {
        if (v !== null && String(v).toLowerCase().includes(q)) return true;
      }
      return false;
    });
  }

  return result;
}

// ══════════════════════════════════════════════════════════════════════════════
// OPERATIONS
// ══════════════════════════════════════════════════════════════════════════════

// ── op: info ─────────────────────────────────────────────────────────────────
function opInfo(args) {
  const { text, stat, resolved } = loadFile(args.path);
  const fmt = args.format || detectFormat(text, args.path);
  const fc = parseFile(text, fmt);

  const features = fc.features;
  const typeCounts = {};
  const propKeys = new Set();
  const bbox = emptyBbox();

  for (const f of features) {
    const t = geometryType(f.geometry) || "null";
    typeCounts[t] = (typeCounts[t] || 0) + 1;
    for (const k of Object.keys(f.properties || {})) propKeys.add(k);
    bboxFromGeometry(f.geometry, bbox);
  }

  return {
    operation:      "info",
    path:           args.path,
    format:         fmt,
    fileSize:       stat.size,
    modified:       stat.mtime.toISOString(),
    featureCount:   features.length,
    geometryTypes:  typeCounts,
    propertyKeys:   [...propKeys].sort(),
    bbox:           bboxValid(bbox) ? bbox : null,
    meta:           fc.meta || {},
  };
}

// ── op: read ──────────────────────────────────────────────────────────────────
function opRead(args) {
  const { text } = loadFile(args.path);
  const fmt = args.format || detectFormat(text, args.path);
  const fc = parseFile(text, fmt);

  const offset = typeof args.offset === "number" ? Math.max(0, args.offset) : 0;
  const limit  = typeof args.limit  === "number" ? Math.min(Math.max(1, args.limit), MAX_READ_FEATS) : 100;

  let features = fc.features;
  features = applyFilters(features, args);
  const filtered = features.length;

  const sliced = features.slice(offset, offset + limit);
  const include_geometry = args.include_geometry !== false;

  const entries = sliced.map(f => ({
    id: f.id,
    geometry: include_geometry ? f.geometry : undefined,
    properties: f.properties,
  }));

  return {
    operation:    "read",
    path:         args.path,
    format:       fmt,
    total:        fc.features.length,
    filtered,
    offset,
    limit,
    count:        entries.length,
    truncated:    filtered > offset + limit,
    features:     entries,
  };
}

// ── op: search ────────────────────────────────────────────────────────────────
function opSearch(args) {
  const hasFilter = args.search || args.geometry_type || args.property ||
                    args.feature_id !== undefined || args.filter_bbox;
  if (!hasFilter)
    throw new ToolError(
      "geo_client: 'search' requires at least one filter: search, geometry_type, property, feature_id, or filter_bbox.",
      -32602
    );

  const { text } = loadFile(args.path);
  const fmt = args.format || detectFormat(text, args.path);
  const fc = parseFile(text, fmt);

  let features = fc.features;
  features = applyFilters(features, args);

  const cap = Math.min(features.length, MAX_SEARCH_FEATS);
  const truncated = features.length > cap;
  const include_geometry = args.include_geometry !== false;

  return {
    operation:   "search",
    path:        args.path,
    format:      fmt,
    total:       fc.features.length,
    matchCount:  features.length,
    truncated,
    features: features.slice(0, cap).map(f => ({
      id: f.id,
      geometry: include_geometry ? f.geometry : undefined,
      properties: f.properties,
    })),
  };
}

// ── op: stats ─────────────────────────────────────────────────────────────────
function opStats(args) {
  const { text, stat } = loadFile(args.path);
  const fmt = args.format || detectFormat(text, args.path);
  const fc = parseFile(text, fmt);

  const features = fc.features;
  const typeCounts = {};
  const propKeys = {};
  const coordCounts = { total: 0, byType: {} };
  const bbox = emptyBbox();
  let nullGeomCount = 0;

  for (const f of features) {
    const t = f.geometry ? f.geometry.type : null;
    if (!t) { nullGeomCount++; continue; }
    typeCounts[t] = (typeCounts[t] || 0) + 1;
    const c = countCoordinates(f.geometry);
    coordCounts.total += c;
    coordCounts.byType[t] = (coordCounts.byType[t] || 0) + c;
    bboxFromGeometry(f.geometry, bbox);
    for (const [k, v] of Object.entries(f.properties || {})) {
      if (!propKeys[k]) propKeys[k] = { count: 0, types: new Set(), sample: [] };
      propKeys[k].count++;
      if (v !== null && v !== undefined) {
        propKeys[k].types.add(typeof v);
        if (propKeys[k].sample.length < 5) propKeys[k].sample.push(v);
      }
    }
  }

  // Compute top-N for specific properties if requested
  const topFields = {};
  if (args.top_properties) {
    const propsToCount = Array.isArray(args.top_properties) ? args.top_properties : [args.top_properties];
    for (const pk of propsToCount) {
      const freq = {};
      for (const f of features) {
        const v = (f.properties || {})[pk];
        if (v !== undefined && v !== null) {
          const key = String(v);
          freq[key] = (freq[key] || 0) + 1;
        }
      }
      topFields[pk] = Object.entries(freq)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 20)
        .map(([value, count]) => ({ value, count }));
    }
  }

  const propSummary = {};
  for (const [k, v] of Object.entries(propKeys)) {
    propSummary[k] = {
      count: v.count,
      types: [...v.types],
      sample: v.sample,
    };
  }

  return {
    operation:     "stats",
    path:          args.path,
    format:        fmt,
    fileSize:      stat.size,
    featureCount:  features.length,
    nullGeometry:  nullGeomCount,
    geometryTypes: typeCounts,
    coordinateCount: coordCounts,
    bbox:          bboxValid(bbox) ? bbox : null,
    propertyStats: propSummary,
    topFields,
    meta:          fc.meta || {},
  };
}

// ── op: bbox ──────────────────────────────────────────────────────────────────
function opBbox(args) {
  const { text } = loadFile(args.path);
  const fmt = args.format || detectFormat(text, args.path);
  const fc = parseFile(text, fmt);

  let features = fc.features;
  // Apply filters (e.g. geometry_type, property) before computing bbox
  features = applyFilters(features, args);

  const bbox = emptyBbox();
  for (const f of features) bboxFromGeometry(f.geometry, bbox);

  const valid = bboxValid(bbox);
  return {
    operation:    "bbox",
    path:         args.path,
    format:       fmt,
    featureCount: features.length,
    bbox:         valid ? bbox : null,
    center:       valid ? [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2] : null,
    width:        valid ? bbox[2] - bbox[0] : null,
    height:       valid ? bbox[3] - bbox[1] : null,
  };
}

// ── op: convert ───────────────────────────────────────────────────────────────
function opConvert(args) {
  const { text } = loadFile(args.path);
  const fmt = args.format || detectFormat(text, args.path);
  const fc = parseFile(text, fmt);

  // Apply filters
  let features = fc.features;
  features = applyFilters(features, args);

  const outFmt = (args.format_out || "geojson").toLowerCase();
  const pretty = args.pretty !== false;

  let output;
  let byteCount;

  if (outFmt === "geojson") {
    const fcOut = {
      type: "FeatureCollection",
      ...(args.include_bbox !== false ? (() => {
        const bb = emptyBbox();
        for (const f of features) bboxFromGeometry(f.geometry, bb);
        return bboxValid(bb) ? { bbox: bb } : {};
      })() : {}),
      features: features.map(f => ({
        type: "Feature",
        ...(f.id !== null && f.id !== undefined ? { id: f.id } : {}),
        geometry: f.geometry,
        properties: f.properties,
      })),
    };
    output = JSON.stringify(fcOut, null, pretty ? 2 : 0);
  } else if (outFmt === "csv") {
    // Flatten properties + geometry type + bbox to CSV
    const allKeys = new Set();
    for (const f of features) for (const k of Object.keys(f.properties || {})) allKeys.add(k);
    const propCols = [...allKeys].sort();
    const headers = ["id", "geometry_type", "bbox_minlon", "bbox_minlat", "bbox_maxlon", "bbox_maxlat", ...propCols];
    const escCsv = v => {
      if (v == null) return "";
      const s = String(v);
      return (s.includes(",") || s.includes('"') || s.includes("\n"))
        ? `"${s.replace(/"/g, '""')}"`
        : s;
    };
    const rows = features.map(f => {
      const fb = featureBbox(f);
      return headers.map(h => {
        if (h === "id") return escCsv(f.id);
        if (h === "geometry_type") return escCsv(f.geometry?.type);
        if (h === "bbox_minlon") return escCsv(fb ? fb[0] : null);
        if (h === "bbox_minlat") return escCsv(fb ? fb[1] : null);
        if (h === "bbox_maxlon") return escCsv(fb ? fb[2] : null);
        if (h === "bbox_maxlat") return escCsv(fb ? fb[3] : null);
        return escCsv((f.properties || {})[h]);
      }).join(",");
    });
    output = [headers.join(","), ...rows].join("\n");
  } else if (outFmt === "wkt") {
    // Well-Known Text geometry export
    function coordsToWKT(coords, depth) {
      if (depth === 0) return coords.join(" ");
      return "(" + coords.map(c => coordsToWKT(c, depth - 1)).join(", ") + ")";
    }
    function geomToWKT(geom) {
      if (!geom) return "GEOMETRYCOLLECTION EMPTY";
      switch (geom.type) {
        case "Point":           return `POINT (${geom.coordinates.join(" ")})`;
        case "MultiPoint":      return `MULTIPOINT (${geom.coordinates.map(c => `(${c.join(" ")})`).join(", ")})`;
        case "LineString":      return `LINESTRING (${geom.coordinates.map(c => c.join(" ")).join(", ")})`;
        case "MultiLineString": return `MULTILINESTRING (${geom.coordinates.map(r => `(${r.map(c => c.join(" ")).join(", ")})`).join(", ")})`;
        case "Polygon":         return `POLYGON (${geom.coordinates.map(r => `(${r.map(c => c.join(" ")).join(", ")})`).join(", ")})`;
        case "MultiPolygon":    return `MULTIPOLYGON (${geom.coordinates.map(p => `(${p.map(r => `(${r.map(c => c.join(" ")).join(", ")})`).join(", ")})`).join(", ")})`;
        case "GeometryCollection": return `GEOMETRYCOLLECTION (${(geom.geometries||[]).map(geomToWKT).join(", ")})`;
        default: return "GEOMETRYCOLLECTION EMPTY";
      }
    }
    const lines = features.map(f => {
      const props = Object.entries(f.properties || {}).map(([k, v]) => `${k}=${v}`).join(";");
      return `${f.id ?? ""}\t${geomToWKT(f.geometry)}\t${props}`;
    });
    output = ["id\tgeometry_wkt\tproperties", ...lines].join("\n");
  } else {
    throw new ToolError(`geo_client: Unknown output format '${outFmt}'. Valid: geojson, csv, wkt.`, -32602);
  }

  byteCount = output.length;

  if (args.output_file) {
    const outPath = path.resolve(args.output_file);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, output, "utf8");
    return {
      operation:   "convert",
      path:        args.path,
      format_in:   fmt,
      format_out:  outFmt,
      features:    features.length,
      bytes:       byteCount,
      output_file: args.output_file,
    };
  }

  return {
    operation:  "convert",
    path:       args.path,
    format_in:  fmt,
    format_out: outFmt,
    features:   features.length,
    bytes:      byteCount,
    data:       output,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ══════════════════════════════════════════════════════════════════════════════

function geoClient(args) {
  const op = (args.operation || "").trim();
  const VALID_OPS = ["info", "read", "search", "stats", "bbox", "convert"];
  if (!op)
    throw new ToolError(
      `geo_client: 'operation' is required. Valid: ${VALID_OPS.join(", ")}.`, -32602
    );
  if (!VALID_OPS.includes(op))
    throw new ToolError(
      `geo_client: unknown operation '${op}'. Valid: ${VALID_OPS.join(", ")}.`, -32602
    );

  switch (op) {
    case "info":    return opInfo(args);
    case "read":    return opRead(args);
    case "search":  return opSearch(args);
    case "stats":   return opStats(args);
    case "bbox":    return opBbox(args);
    case "convert": return opConvert(args);
    default:
      throw new ToolError(`geo_client: unhandled operation '${op}'.`, -32603);
  }
}

module.exports = { geoClient };
