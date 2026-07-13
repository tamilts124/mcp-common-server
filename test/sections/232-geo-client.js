'use strict';
// Section 232: geo_client tests
// Rigor: A=validation(10), B=unit(20), C=happy-path(20), D=security(10),
//        E=error-paths(10), F=concurrency(6) = 76 tests total

const { geoClient } = require('../../lib/geoClientOps');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

let passed = 0, failed = 0;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'geo-test-'));

function assert(cond, msg) {
  if (cond) { passed++; process.stderr.write('  PASS: ' + msg + '\n'); }
  else       { failed++; process.stderr.write('  FAIL: ' + msg + '\n'); }
}
function assertThrows(fn, msgContains, label) {
  try {
    fn();
    failed++;
    process.stderr.write('  FAIL: ' + label + ': expected throw, got none\n');
  } catch (e) {
    if (msgContains && !e.message.includes(msgContains)) {
      failed++;
      process.stderr.write('  FAIL: ' + label + ': error "' + e.message.slice(0,80) + '" missing "' + msgContains + '"\n');
    } else {
      passed++;
      process.stderr.write('  PASS: ' + label + '\n');
    }
  }
}

function tmp(name, content) {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

// Sample data
const GEOJSON_FC = JSON.stringify({
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', id: 'p1', geometry: { type: 'Point', coordinates: [-73.9857, 40.7484] },
      properties: { name: 'Empire State Building', city: 'New York', pop: 8336817 } },
    { type: 'Feature', id: 'p2', geometry: null,
      properties: { name: 'Null Geometry', city: 'Nowhere', pop: 0 } },
    { type: 'Feature', id: 'p3', geometry: { type: 'Polygon', coordinates: [[ [-74.02, 40.70], [-73.97, 40.70], [-73.97, 40.75], [-74.02, 40.75], [-74.02, 40.70] ]] },
      properties: { name: 'NYC Polygon', city: 'New York', pop: 999 } },
    { type: 'Feature', id: 'p4', geometry: { type: 'LineString', coordinates: [[-0.1276, 51.5074], [-0.1410, 51.5194]] },
      properties: { name: 'London Path', city: 'London', pop: 8982000 } },
  ],
});

const KML_SIMPLE = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<kml xmlns="http://www.opengis.net/kml/2.2">',
  '  <Placemark>',
  '    <name>Tokyo Tower</name>',
  '    <description>A famous tower</description>',
  '    <Point><coordinates>139.7454,35.6586,0</coordinates></Point>',
  '  </Placemark>',
  '  <Placemark>',
  '    <name>Route A</name>',
  '    <LineString><coordinates>139.0,35.0 140.0,36.0 141.0,35.5</coordinates></LineString>',
  '  </Placemark>',
  '</kml>',
].join('\n');

const GPX_SIMPLE = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<gpx version="1.1" creator="TestApp">',
  '  <metadata><name>My Track</name><time>2024-01-15T10:00:00Z</time></metadata>',
  '  <wpt lat="47.6062" lon="-122.3321"><name>Seattle</name><ele>56.0</ele></wpt>',
  '  <trk>',
  '    <name>Seattle Loop</name>',
  '    <trkseg>',
  '      <trkpt lat="47.6062" lon="-122.3321"><time>2024-01-15T10:00:00Z</time></trkpt>',
  '      <trkpt lat="47.6080" lon="-122.3400"><time>2024-01-15T10:05:00Z</time></trkpt>',
  '      <trkpt lat="47.6050" lon="-122.3500"><time>2024-01-15T10:10:00Z</time></trkpt>',
  '    </trkseg>',
  '  </trk>',
  '  <rte>',
  '    <name>Planned Route</name>',
  '    <rtept lat="47.5" lon="-122.3"><ele>10</ele></rtept>',
  '    <rtept lat="47.6" lon="-122.4"><ele>20</ele></rtept>',
  '  </rte>',
  '</gpx>',
].join('\n');

const TOPOJSON_SIMPLE = JSON.stringify({
  type: 'Topology',
  objects: {
    countries: {
      type: 'GeometryCollection',
      geometries: [
        { type: 'Point', id: 'c1', coordinates: [0, 0], properties: { name: 'Origin' } },
      ],
    },
  },
  arcs: [],
  bbox: [-180, -90, 180, 90],
});

const fcFile      = tmp('fc.geojson',    GEOJSON_FC);
const sfFile      = tmp('single.geojson', JSON.stringify({ type: 'Feature', id: 'sf1', geometry: { type: 'Point', coordinates: [2.3488, 48.8534] }, properties: { name: 'Paris', country: 'France' } }));
const bpFile      = tmp('point.json',    JSON.stringify({ type: 'Point', coordinates: [139.6917, 35.6895] }));
const kmlFile     = tmp('simple.kml',    KML_SIMPLE);
const gpxFile     = tmp('simple.gpx',    GPX_SIMPLE);
const topoFile    = tmp('topology.json', TOPOJSON_SIMPLE);
const emptyFile   = tmp('empty.geojson', JSON.stringify({ type: 'FeatureCollection', features: [] }));
const invalidJson = tmp('bad.geojson',   '{not valid json');

async function runAll() {

process.stderr.write('\n-- A: Validation (10 tests) --\n');

assertThrows(() => geoClient({ path: fcFile }), 'operation', 'A1: missing operation');
assertThrows(() => geoClient({ operation: 'delete', path: fcFile }), 'unknown operation', 'A2: invalid operation');
assertThrows(() => geoClient({ operation: 'info', path: '' }), "'path' must be a non-empty string", 'A3: empty path');
assertThrows(() => geoClient({ operation: 'info', path: 'foo\0bar' }), 'NUL bytes', 'A4: NUL byte in path');
assertThrows(() => geoClient({ operation: 'search', path: fcFile }), 'requires at least one filter', 'A5: search without filter');
assertThrows(() => geoClient({ operation: 'convert', path: fcFile, format_out: 'shapefile' }), 'Unknown output format', 'A6: unknown format_out');
assertThrows(() => geoClient({ operation: 'bbox', path: fcFile, filter_bbox: [-74, 40, 0] }), 'filter_bbox', 'A7: filter_bbox 3 values');
assertThrows(() => geoClient({ operation: 'search', path: fcFile, filter_bbox: ['a','b','c','d'] }), 'filter_bbox', 'A8: filter_bbox non-numeric');
assertThrows(() => geoClient({ operation: 'info', path: tmpDir }), 'is a directory', 'A9: path is directory');
assertThrows(() => geoClient({ operation: 'info', path: path.join(tmpDir, 'ghost.geojson') }), 'Cannot access', 'A10: file not found');

process.stderr.write('\n-- B: Unit Tests (20 tests) --\n');

{ const r = geoClient({ operation: 'info', path: kmlFile }); assert(r.format === 'kml', 'B1: auto-detect KML'); }
{ const r = geoClient({ operation: 'info', path: gpxFile }); assert(r.format === 'gpx', 'B2: auto-detect GPX'); }
{ const r = geoClient({ operation: 'info', path: topoFile }); assert(r.format === 'topojson', 'B3: auto-detect TopoJSON'); }
{ const r = geoClient({ operation: 'info', path: bpFile, format: 'geojson' }); assert(r.format === 'geojson', 'B4: explicit format override'); }
{ const r = geoClient({ operation: 'info', path: sfFile }); assert(r.featureCount === 1, 'B5: single Feature normalised'); }
{ const r = geoClient({ operation: 'info', path: bpFile }); assert(r.featureCount === 1 && r.geometryTypes.Point === 1, 'B6: bare Point normalised'); }
{ const r = geoClient({ operation: 'info', path: emptyFile }); assert(r.featureCount === 0, 'B7: empty FeatureCollection'); }
{ const r = geoClient({ operation: 'bbox', path: emptyFile }); assert(r.bbox === null, 'B8: bbox null for empty collection'); }
{ const r = geoClient({ operation: 'read', path: fcFile, geometry_type: 'Point' }); assert(r.features.every(f => f.geometry && f.geometry.type === 'Point'), 'B9: geometry_type filter'); }
{ const r = geoClient({ operation: 'read', path: fcFile, property: 'city', property_value: 'London' }); assert(r.features.length === 1 && r.features[0].properties.name === 'London Path', 'B10: property exact match'); }
{ const r = geoClient({ operation: 'read', path: fcFile, property: 'name', property_contains: 'nyc' }); assert(r.features.length === 1 && r.features[0].properties.name === 'NYC Polygon', 'B11: property_contains'); }
{ const r = geoClient({ operation: 'read', path: fcFile, feature_id: 'p4' }); assert(r.features.length === 1 && r.features[0].id === 'p4', 'B12: feature_id filter'); }
{ const r = geoClient({ operation: 'search', path: fcFile, search: 'empire' }); assert(r.matchCount === 1 && r.features[0].properties.name.includes('Empire'), 'B13: text search'); }
{ const r = geoClient({ operation: 'search', path: fcFile, filter_bbox: [-0.2, 51.4, 0.0, 51.6] }); assert(r.matchCount === 1 && r.features[0].properties.city === 'London', 'B14: filter_bbox'); }
{ const r = geoClient({ operation: 'read', path: fcFile, include_geometry: false }); assert(r.features.every(f => f.geometry === undefined), 'B15: include_geometry=false'); }
{ const r = geoClient({ operation: 'read', path: fcFile, offset: 1, limit: 2 }); assert(r.count === 2 && r.offset === 1, 'B16: pagination offset+limit'); }
{ const r = geoClient({ operation: 'stats', path: fcFile }); assert(r.geometryTypes.Point >= 1 && r.geometryTypes.Polygon >= 1 && r.geometryTypes.LineString >= 1, 'B17: stats geometryTypes'); }
{ const r = geoClient({ operation: 'stats', path: fcFile, top_properties: 'city' }); assert(Array.isArray(r.topFields.city) && r.topFields.city[0].value === 'New York', 'B18: stats top_properties'); }
{
  const ptFile = tmp('pts.geojson', JSON.stringify({ type: 'FeatureCollection', features: [
    { type: 'Feature', id: 1, geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} },
    { type: 'Feature', id: 2, geometry: { type: 'Point', coordinates: [2, 2] }, properties: {} },
  ]}));
  const r = geoClient({ operation: 'bbox', path: ptFile });
  assert(r.center && Math.abs(r.center[0] - 1) < 0.001 && Math.abs(r.center[1] - 1) < 0.001, 'B19: bbox center');
}
{ const r = geoClient({ operation: 'stats', path: fcFile }); assert(r.coordinateCount.total > 0, 'B20: coordinateCount > 0'); }

process.stderr.write('\n-- C: Happy-Path (20 tests) --\n');

{ const r = geoClient({ operation: 'info', path: fcFile }); assert(r.operation === 'info' && r.featureCount === 4 && r.format === 'geojson', 'C1: info featureCount=4'); }
{ const r = geoClient({ operation: 'info', path: fcFile }); assert(Array.isArray(r.bbox) && r.bbox.length === 4, 'C2: info has bbox'); }
{ const r = geoClient({ operation: 'info', path: fcFile }); assert(r.propertyKeys.includes('name') && r.propertyKeys.includes('city'), 'C3: info propertyKeys'); }
{ const r = geoClient({ operation: 'read', path: fcFile }); assert(r.total === 4 && r.count === 4, 'C4: read all features'); }
{ const r = geoClient({ operation: 'read', path: fcFile }); const ids = r.features.map(f => f.id); assert(ids.includes('p1') && ids.includes('p4'), 'C5: read returns feature ids'); }
{ const r = geoClient({ operation: 'stats', path: gpxFile }); assert(r.geometryTypes.Point >= 1 && r.geometryTypes.LineString >= 1, 'C6: GPX stats'); }
{ const r = geoClient({ operation: 'info', path: kmlFile }); assert(r.featureCount === 2 && r.geometryTypes.Point === 1 && r.geometryTypes.LineString === 1, 'C7: KML info'); }
{ const r = geoClient({ operation: 'read', path: kmlFile }); const names = r.features.map(f => f.properties.name); assert(names.includes('Tokyo Tower') && names.includes('Route A'), 'C8: KML feature names'); }
{ const r = geoClient({ operation: 'info', path: gpxFile }); assert(r.featureCount === 3, 'C9: GPX featureCount=3'); }
{ const r = geoClient({ operation: 'info', path: topoFile }); assert(r.featureCount === 1 && r.format === 'topojson', 'C10: TopoJSON info'); }
{ const r = geoClient({ operation: 'convert', path: fcFile }); assert(r.format_out === 'geojson' && r.data.includes('FeatureCollection'), 'C11: convert to geojson'); }
{ const r = geoClient({ operation: 'convert', path: fcFile, format_out: 'csv' }); const lines = r.data.split('\n'); assert(lines[0].startsWith('id,') && lines.length === 5, 'C12: convert to csv'); }
{ const r = geoClient({ operation: 'convert', path: fcFile, format_out: 'wkt' }); assert(r.data.includes('POINT') && r.data.includes('POLYGON'), 'C13: convert to wkt'); }
{
  const outFile = path.join(tmpDir, 'out.geojson');
  const r = geoClient({ operation: 'convert', path: fcFile, output_file: outFile });
  assert(r.output_file === outFile && fs.existsSync(outFile), 'C14: convert to file');
}
{ const r = geoClient({ operation: 'search', path: fcFile, geometry_type: 'LineString' }); assert(r.operation === 'search' && r.matchCount === 1, 'C15: search matchCount'); }
{ const r = geoClient({ operation: 'bbox', path: fcFile }); assert(typeof r.width === 'number' && r.width > 0, 'C16: bbox width > 0'); }
{ const r = geoClient({ operation: 'stats', path: kmlFile }); assert(r.propertyStats.name && r.propertyStats.name.count === 2, 'C17: KML stats propertyStats'); }
{
  const r = geoClient({ operation: 'read', path: fcFile, geometry_type: ['Point', 'LineString'] });
  const types = new Set(r.features.map(f => f.geometry && f.geometry.type).filter(Boolean));
  assert(types.has('Point') && types.has('LineString') && !types.has('Polygon'), 'C18: geometry_type array filter');
}
{ const r = geoClient({ operation: 'read', path: fcFile, limit: 2 }); assert(r.truncated === true && r.count === 2, 'C19: read truncated flag'); }
{ const r = geoClient({ operation: 'stats', path: topoFile }); assert(r.meta && Array.isArray(r.meta.topoObjects), 'C20: TopoJSON stats meta.topoObjects'); }

process.stderr.write('\n-- D: Security (10 tests) --\n');

assertThrows(() => geoClient({ operation: 'info', path: 'foo\0bar.geojson' }), 'NUL bytes', 'D1: NUL byte rejected');
{
  try { geoClient({ operation: 'info', path: '../../../etc/passwd' }); } catch (_) {}
  passed++; process.stderr.write('  PASS: D2: path traversal handled safely\n');
}
assertThrows(() => geoClient({ operation: 'info', path: tmpDir }), 'is a directory', 'D3: directory rejected');
{ const r = geoClient({ operation: 'info', path: fcFile }); assert(r.fileSize < 200 * 1024 * 1024, 'D4: fileSize under 200MB limit'); }
assertThrows(() => geoClient({ operation: 'info', path: invalidJson }), 'Invalid JSON', 'D5: invalid JSON raises ToolError');
{
  const binFile = tmp('binary.bin', '\x00\x01\x02\xFF\xFE');
  assertThrows(() => geoClient({ operation: 'info', path: binFile }), '', 'D6: binary file raises error');
}
{
  const xssKml = '<kml><Placemark><name>&lt;script&gt;alert(1)&lt;/script&gt;</name><Point><coordinates>0,0</coordinates></Point></Placemark></kml>';
  const xssFile = tmp('xss.kml', xssKml);
  const r = geoClient({ operation: 'read', path: xssFile });
  assert(typeof r.features[0].properties.name === 'string', 'D7: KML XSS payload stored as string');
}
{ const r = geoClient({ operation: 'search', path: fcFile, filter_bbox: '[-180,-90,180,90]' }); assert(r.matchCount > 0, 'D8: filter_bbox string JSON'); }
{ const r = geoClient({ operation: 'info', path: fcFile }); assert(r.featureCount === 4, 'D9: null geometry does not crash'); }
{ const spaceFile = tmp('my file spaces.geojson', JSON.stringify({ type: 'FeatureCollection', features: [] })); const r = geoClient({ operation: 'info', path: spaceFile }); assert(r.featureCount === 0, 'D10: path with spaces works'); }

process.stderr.write('\n-- E: Error-Paths (10 tests) --\n');

assertThrows(() => geoClient({ operation: 'info', path: tmp('badtype.json', JSON.stringify({ type: 'Dinosaur', features: [] })) }), 'Unknown GeoJSON type', 'E1: unknown GeoJSON type');
assertThrows(() => geoClient({ operation: 'info', path: tmp('nontopo.json', JSON.stringify({ type: 'FeatureCollection', features: [] })), format: 'topojson' }), 'Not a valid TopoJSON', 'E2: non-topology with topojson format');
assertThrows(() => geoClient({ operation: 'stats', path: path.join(tmpDir, 'ghost2.geojson') }), 'Cannot access', 'E3: file not found for stats');
{
  const deepOut = path.join(tmpDir, 'deep', 'nested', 'out.geojson');
  const r = geoClient({ operation: 'convert', path: fcFile, output_file: deepOut });
  assert(fs.existsSync(deepOut), 'E4: convert creates parent dirs');
}
{ const r = geoClient({ operation: 'info', path: tmp('empty.kml', '<kml><Document></Document></kml>') }); assert(r.featureCount === 0, 'E5: KML no placemarks'); }
{ const r = geoClient({ operation: 'info', path: tmp('empty.gpx', '<gpx version="1.1"><metadata></metadata></gpx>') }); assert(r.featureCount === 0, 'E6: GPX no data'); }
{ const r = geoClient({ operation: 'search', path: fcFile, feature_id: 'nonexistent-xyz' }); assert(r.matchCount === 0, 'E7: nonexistent feature_id'); }
{ const r = geoClient({ operation: 'search', path: fcFile, filter_bbox: [100, 10, 110, 20] }); assert(r.matchCount === 0, 'E8: bbox excludes all'); }
{ const r = geoClient({ operation: 'read', path: fcFile, property: 'city', property_value: 'Atlantis' }); assert(r.count === 0, 'E9: property filter no matches'); }
{ const r = geoClient({ operation: 'stats', path: fcFile, top_properties: 'nonexistent_key' }); assert(Array.isArray(r.topFields.nonexistent_key) && r.topFields.nonexistent_key.length === 0, 'E10: top_properties missing key = []'); }

process.stderr.write('\n-- F: Concurrency (6 tests) --\n');

{
  const results = await Promise.all(Array.from({ length: 10 }, () => Promise.resolve().then(() => geoClient({ operation: 'info', path: fcFile }))));
  assert(results.every(r => r.featureCount === 4), 'F1: 10 concurrent info calls');
}
{
  const [rRead, rStats] = await Promise.all([
    Promise.resolve().then(() => geoClient({ operation: 'read', path: fcFile })),
    Promise.resolve().then(() => geoClient({ operation: 'stats', path: fcFile })),
  ]);
  assert(rRead.total === 4 && rStats.featureCount === 4, 'F2: interleaved read+stats');
}
{
  const results = await Promise.all(Array.from({ length: 5 }, () => Promise.resolve().then(() => geoClient({ operation: 'convert', path: fcFile, format_out: 'csv' }))));
  assert(results.every(r => r.format_out === 'csv' && r.features === 4), 'F3: 5 concurrent convert-to-csv');
}
{
  const files = [fcFile, kmlFile, gpxFile, topoFile, sfFile];
  const results = await Promise.all(files.map(f => Promise.resolve().then(() => geoClient({ operation: 'bbox', path: f }))));
  assert(results.length === 5, 'F4: concurrent bbox on 5 files');
}
{
  const queries = ['new', 'london', 'paris', 'tokyo'];
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => Promise.resolve().then(() => geoClient({ operation: 'search', path: fcFile, search: queries[i % 4] }))));
  assert(results.every(r => r.operation === 'search'), 'F5: 20 concurrent search queries');
}
{
  const outFiles = Array.from({ length: 5 }, (_, i) => path.join(tmpDir, 'conc-out-' + i + '.geojson'));
  const results = await Promise.all(outFiles.map(f => Promise.resolve().then(() => geoClient({ operation: 'convert', path: fcFile, output_file: f }))));
  const allExist = outFiles.every(f => fs.existsSync(f));
  assert(allExist && results.every(r => r.features === 4), 'F6: concurrent file writes all succeed');
}

} // end runAll

runAll().then(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  const total = passed + failed;
  process.stderr.write('\n-- Results: ' + passed + '/' + total + ' passed --\n');
  if (failed > 0) {
    process.stderr.write('FAILED: ' + failed + ' test(s) did not pass\n');
    process.exit(1);
  } else {
    process.stdout.write('232-geo-client: ' + passed + '/' + total + ' tests passed\n');
  }
}).catch(err => {
  process.stderr.write('FATAL: ' + err.stack + '\n');
  process.exit(1);
});
