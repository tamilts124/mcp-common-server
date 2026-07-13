"use strict";
// lib/schemas/utilSchemas65.js -- JSON schema for geo_client tool

const UTIL_SCHEMAS_65 = [
  {
    name: "geo_client",
    description:
      "Zero-dependency geospatial file reader and analyzer (pure Node.js; no npm deps). " +
      "Auto-detects and parses geospatial formats: GeoJSON (.geojson/.json), KML (Google Earth/Maps), " +
      "GPX (GPS Exchange Format — tracks, routes, waypoints), and TopoJSON (topology-preserving). " +
      "All formats are normalized to a common GeoJSON-like FeatureCollection for uniform access. " +
      "Operations: " +
      "info (file metadata, format, feature count, geometry type breakdown, property keys, bbox); " +
      "read (return parsed features with optional filters and pagination using offset+limit); " +
      "search (filter features by geometry type, property value/contains, feature ID, bbox, or text search); " +
      "stats (aggregate statistics: geometry type counts, coordinate counts, property key summary, top field values); " +
      "bbox (compute the bounding box for all or filtered features — minLon, minLat, maxLon, maxLat); " +
      "convert (export features to GeoJSON, CSV, or WKT, optionally writing to a file). " +
      "Filters (applicable to read/search/bbox/convert): geometry_type, property+property_value, " +
      "property+property_contains, feature_id, filter_bbox, search (text across all property values). " +
      "Security: 200 MB file cap; 500,000 feature limit; NUL-byte guard; directory guard.",
    inputSchema: {
      type: "object",
      required: ["operation", "path"],
      additionalProperties: false,
      properties: {
        operation: {
          type: "string",
          enum: ["info", "read", "search", "stats", "bbox", "convert"],
          description:
            "Operation to perform. " +
            "'info': return file metadata, format, feature count, geometry types, property keys, and bounding box. " +
            "'read': return parsed features (paginated with offset+limit); accepts all filter args. " +
            "'search': filter features — requires at least one filter (search, geometry_type, property, feature_id, or filter_bbox). " +
            "'stats': aggregate statistics including geometry type counts, coordinate totals, and property key summary. " +
            "'bbox': compute the bounding box [minLon,minLat,maxLon,maxLat] for features (optionally filtered). " +
            "'convert': export features to GeoJSON, CSV, or WKT format; optionally write to a file.",
        },

        path: {
          type: "string",
          description:
            "Path to the geospatial file. Supported formats are auto-detected by content signature and extension: " +
            "GeoJSON (.geojson, .json), KML (.kml), GPX (.gpx), TopoJSON (.json with type=Topology).",
        },

        format: {
          type: "string",
          enum: ["geojson", "kml", "gpx", "topojson"],
          description:
            "Override the auto-detected format. Omit to auto-detect from file content. " +
            "'geojson': RFC 7946 GeoJSON FeatureCollection, Feature, or geometry; " +
            "'kml': Keyhole Markup Language (Google Earth/Maps); " +
            "'gpx': GPS Exchange Format (waypoints, routes, tracks); " +
            "'topojson': TopoJSON Topology (converted to GeoJSON features).",
        },

        // ── Pagination (read) ─────────────────────────────────────────────────────
        offset: {
          type: "integer",
          minimum: 0,
          description:
            "For 'read': number of (post-filter) features to skip (default: 0).",
        },

        limit: {
          type: "integer",
          minimum: 1,
          description:
            "For 'read': maximum features to return (default: 100; hard cap: 10,000).",
        },

        // ── Filters (read / search / bbox / convert) ───────────────────────────
        geometry_type: {
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
          description:
            "Filter by geometry type(s). String or array of strings. Case-insensitive. " +
            "Valid values: Point, MultiPoint, LineString, MultiLineString, Polygon, MultiPolygon, GeometryCollection. " +
            "GPX tracks become LineString or MultiLineString; waypoints become Point.",
        },

        property: {
          type: "string",
          description:
            "Property name to filter on. Used with 'property_value' (exact match) or " +
            "'property_contains' (substring match). Example: property='name', property_value='London'.",
        },

        property_value: {
          description:
            "Exact value to match for 'property' filter (compared as string). " +
            "Example: property='status', property_value='active'. Case-sensitive.",
        },

        property_contains: {
          type: "string",
          description:
            "Substring to search for within the 'property' field (case-insensitive). " +
            "Example: property='name', property_contains='park'.",
        },

        feature_id: {
          description:
            "Filter by feature ID (compared as string). GeoJSON Feature 'id' field. " +
            "Example: feature_id='abc123' or feature_id=42.",
        },

        filter_bbox: {
          oneOf: [
            { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 },
            { type: "string" },
          ],
          description:
            "Filter features that intersect this bounding box: [minLon, minLat, maxLon, maxLat]. " +
            "Example: [-180, -90, 180, 90] for the whole world; [-74.1, 40.6, -73.7, 40.9] for NYC. " +
            "Can be provided as a JSON array or a JSON-encoded string.",
        },

        search: {
          type: "string",
          description:
            "Text search across all property values and feature IDs (case-insensitive substring match). " +
            "Useful for quickly finding features without knowing the property name. " +
            "Example: 'Central Park', 'highway'.",
        },

        include_geometry: {
          type: "boolean",
          description:
            "For 'read' and 'search': include geometry in output (default: true). " +
            "Set to false to return properties-only (faster for large datasets).",
        },

        // ── Stats-specific ─────────────────────────────────────────────────────
        top_properties: {
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
          description:
            "For 'stats': property name(s) to compute top-value frequency tables for (top 20 values each). " +
            "Example: ['type', 'country'] for GeoJSON with those property keys.",
        },

        // ── Convert-specific ─────────────────────────────────────────────────
        format_out: {
          type: "string",
          enum: ["geojson", "csv", "wkt"],
          description:
            "For 'convert': output format (default: 'geojson'). " +
            "'geojson': RFC 7946 FeatureCollection with bbox; " +
            "'csv': flat table with id, geometry_type, bbox columns, plus all property columns; " +
            "'wkt': tab-separated (id, WKT geometry, key=value properties).",
        },

        pretty: {
          type: "boolean",
          description:
            "For 'convert' with format_out='geojson': pretty-print JSON with 2-space indent (default: true).",
        },

        include_bbox: {
          type: "boolean",
          description:
            "For 'convert' with format_out='geojson': include a top-level 'bbox' field (default: true).",
        },

        output_file: {
          type: "string",
          description:
            "For 'convert': write the exported data to this file instead of returning inline. " +
            "Parent directories are created automatically.",
        },
      },
    },
  },
];

module.exports = { UTIL_SCHEMAS_65 };
