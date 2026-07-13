"use strict";
// utilSchemas70: image_client

const UTIL_SCHEMAS_70 = [
  {
    name: "image_client",
    description:
      "Zero-dependency image metadata reader (pure Node.js; no npm deps). " +
      "Reads image files without external libraries — no ImageMagick, Sharp, or Canvas required. " +
      "Operations: info (format/dimensions/colorSpace/bitDepth/hasAlpha/chunks/segments), " +
      "exif (all EXIF/TIFF IFD tags including GPS sub-IFD and Exif sub-IFD), " +
      "iptc (IPTC/NAA dataset fields: caption, keywords, byline, city, country, copyright…), " +
      "xmp (XMP packet fields: dc:title, dc:creator, xmp:CreateDate, exif:*, tiff:*, photoshop:*…), " +
      "validate (structural integrity check — reports format, dimensions, and any issues). " +
      "Formats: JPEG (APP segments, SOF markers, embedded EXIF/IPTC/XMP/ICC), " +
      "PNG (IHDR/tEXt/zTXt/iTXt/pHYs/tIME/iCCP/sRGB/cHRM/gAMA chunks), " +
      "WebP (VP8/VP8L/VP8X sub-formats, EXIF/XMP RIFF chunks), " +
      "TIFF (IFD0 + Exif/GPS sub-IFDs, LE/BE byte order), " +
      "BMP (BITMAPINFOHEADER v1-v5, OS/2 core header), " +
      "GIF (GIF87a/GIF89a, animation frame count, loop count, transparency), " +
      "ICO (ICO/CUR, multi-size entries, embedded PNG detection). " +
      "Security: 200 MB file cap; 4 MB header scan window; NUL-byte and directory guards.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["info", "exif", "iptc", "xmp", "validate"],
          description:
            "info: format, width, height, bitDepth, colorSpace, hasAlpha, compression, dpi, " +
            "chunk/segment inventory, hasEXIF/hasIPTC/hasXMP/hasICC flags. " +
            "exif: all parsed EXIF IFD tags (Make, Model, DateTime, GPS coords, focal length, ISO…). " +
            "iptc: IPTC-NAA Record 1/2 dataset fields extracted from Photoshop IRB (APP13). " +
            "xmp: XMP packet fields extracted from embedded XMP (dc:*, xmp:*, exif:*, tiff:*, photoshop:*). " +
            "validate: structural integrity — reports dimensions, format, and any parse issues.",
        },
        path: {
          type: "string",
          description:
            "Absolute path to the image file (.jpg/.jpeg, .png, .webp, .tif/.tiff, .bmp, .gif, .ico).",
        },
        include_raw: {
          type: "boolean",
          description:
            "[xmp] If true, include the raw XMP XML string in the response as 'rawXMP'. " +
            "Default: false (only parsed fields are returned).",
        },
      },
      required: ["operation", "path"],
    },
  },
];

module.exports = { UTIL_SCHEMAS_70 };
