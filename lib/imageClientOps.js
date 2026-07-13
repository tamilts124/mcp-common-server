"use strict";
// ── image_client — zero-dependency image metadata reader ─────────────────────
// Pure Node.js (fs + Buffer + zlib); no npm deps.
// Operations: info, exif, iptc, xmp, validate
// Formats: JPEG, PNG, WebP, TIFF, BMP, GIF, ICO
// Security: 200 MB file cap; NUL-byte path guard; directory guard

const fs   = require("fs");
const path = require("path");
const zlib = require("zlib");

// ── Constants ──────────────────────────────────────────────────────────────────
const MAX_FILE_SIZE  = 200 * 1024 * 1024;  // 200 MB
const MAX_READ_HEAD  = 4  * 1024 * 1024;   // 4 MB for header scan
const MAX_EXIF_SIZE  = 64 * 1024;          // 64 KB EXIF APP1 max
const MAX_IPTC_SIZE  = 256 * 1024;         // 256 KB IPTC
const MAX_TAGS       = 1000;

// ── File reading ───────────────────────────────────────────────────────────────
function readBuf(filePath, maxBytes) {
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) throw new Error("image_client: path is a directory.");
  if (stat.size > MAX_FILE_SIZE)
    throw new Error(`image_client: file too large (${stat.size} B; max ${MAX_FILE_SIZE} B).`);
  const readLen = Math.min(stat.size, maxBytes);
  const buf = Buffer.alloc(readLen);
  const fd  = fs.openSync(filePath, "r");
  try { fs.readSync(fd, buf, 0, readLen, 0); }
  finally { fs.closeSync(fd); }
  return { buf, fileSize: stat.size };
}

// ── Format detection ───────────────────────────────────────────────────────────
function detectFormat(buf) {
  if (buf.length < 4) return null;
  // JPEG: FF D8 FF
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return "jpeg";
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504E47 && buf.readUInt32BE(4) === 0x0D0A1A0A)
    return "png";
  // GIF: GIF87a or GIF89a
  if (buf.length >= 6 && buf.slice(0, 6).toString("latin1").startsWith("GIF8")) return "gif";
  // BMP: BM
  if (buf[0] === 0x42 && buf[1] === 0x4D) return "bmp";
  // WebP: RIFF....WEBP
  if (buf.length >= 12 && buf.slice(0,4).toString("latin1") === "RIFF" &&
      buf.slice(8,12).toString("latin1") === "WEBP") return "webp";
  // TIFF: little-endian II* or big-endian MM*
  if (buf.length >= 4 &&
      ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2A && buf[3] === 0x00) ||
       (buf[0] === 0x4D && buf[1] === 0x4D && buf[2] === 0x00 && buf[3] === 0x2A)))
    return "tiff";
  // ICO: 00 00 01 00
  if (buf.length >= 4 && buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00)
    return "ico";
  // PSD: 8BPS
  if (buf.length >= 4 && buf.slice(0,4).toString("latin1") === "8BPS") return "psd";
  return null;
}

// ── EXIF IFD tag names ─────────────────────────────────────────────────────────
const EXIF_TAGS = {
  0x010E: "ImageDescription",
  0x010F: "Make",
  0x0110: "Model",
  0x0112: "Orientation",
  0x011A: "XResolution",
  0x011B: "YResolution",
  0x0128: "ResolutionUnit",
  0x0131: "Software",
  0x0132: "DateTime",
  0x013B: "Artist",
  0x013E: "WhitePoint",
  0x013F: "PrimaryChromaticities",
  0x0140: "ColorMap",
  0x014A: "SubIFDs",
  0x0213: "YCbCrPositioning",
  0x0214: "ReferenceBlackWhite",
  0x8298: "Copyright",
  0x8769: "ExifIFD",
  0x8825: "GPSIFD",
  // Exif sub-IFD tags
  0x829A: "ExposureTime",
  0x829D: "FNumber",
  0x8822: "ExposureProgram",
  0x8824: "SpectralSensitivity",
  0x8827: "ISOSpeedRatings",
  0x9000: "ExifVersion",
  0x9003: "DateTimeOriginal",
  0x9004: "DateTimeDigitized",
  0x9101: "ComponentsConfiguration",
  0x9102: "CompressedBitsPerPixel",
  0x9201: "ShutterSpeedValue",
  0x9202: "ApertureValue",
  0x9203: "BrightnessValue",
  0x9204: "ExposureBiasValue",
  0x9205: "MaxApertureValue",
  0x9206: "SubjectDistance",
  0x9207: "MeteringMode",
  0x9208: "LightSource",
  0x9209: "Flash",
  0x920A: "FocalLength",
  0x9214: "SubjectArea",
  0x927C: "MakerNote",
  0x9286: "UserComment",
  0x9290: "SubSecTime",
  0x9291: "SubSecTimeOriginal",
  0x9292: "SubSecTimeDigitized",
  0xA000: "FlashpixVersion",
  0xA001: "ColorSpace",
  0xA002: "PixelXDimension",
  0xA003: "PixelYDimension",
  0xA004: "RelatedSoundFile",
  0xA20B: "FlashEnergy",
  0xA20E: "FocalPlaneXResolution",
  0xA20F: "FocalPlaneYResolution",
  0xA210: "FocalPlaneResolutionUnit",
  0xA214: "SubjectLocation",
  0xA215: "ExposureIndex",
  0xA217: "SensingMethod",
  0xA300: "FileSource",
  0xA301: "SceneType",
  0xA302: "CFAPattern",
  0xA401: "CustomRendered",
  0xA402: "ExposureMode",
  0xA403: "WhiteBalance",
  0xA404: "DigitalZoomRatio",
  0xA405: "FocalLengthIn35mmFilm",
  0xA406: "SceneCaptureType",
  0xA407: "GainControl",
  0xA408: "Contrast",
  0xA409: "Saturation",
  0xA40A: "Sharpness",
  0xA40B: "DeviceSettingDescription",
  0xA40C: "SubjectDistanceRange",
  0xA420: "ImageUniqueID",
  0xA430: "CameraOwnerName",
  0xA431: "BodySerialNumber",
  0xA432: "LensSpecification",
  0xA433: "LensMake",
  0xA434: "LensModel",
  0xA435: "LensSerialNumber",
  // GPS sub-IFD tags
  0x0000: "GPSVersionID",
  0x0001: "GPSLatitudeRef",
  0x0002: "GPSLatitude",
  0x0003: "GPSLongitudeRef",
  0x0004: "GPSLongitude",
  0x0005: "GPSAltitudeRef",
  0x0006: "GPSAltitude",
  0x0007: "GPSTimeStamp",
  0x0008: "GPSSatellites",
  0x0009: "GPSStatus",
  0x000A: "GPSMeasureMode",
  0x000B: "GPSDOP",
  0x000C: "GPSSpeedRef",
  0x000D: "GPSSpeed",
  0x000E: "GPSTrackRef",
  0x000F: "GPSTrack",
  0x0010: "GPSImgDirectionRef",
  0x0011: "GPSImgDirection",
  0x0012: "GPSMapDatum",
  0x0013: "GPSDestLatitudeRef",
  0x0014: "GPSDestLatitude",
  0x0015: "GPSDestLongitudeRef",
  0x0016: "GPSDestLongitude",
  0x0017: "GPSDestBearingRef",
  0x0018: "GPSDestBearing",
  0x0019: "GPSDestDistanceRef",
  0x001A: "GPSDestDistance",
  0x001B: "GPSProcessingMethod",
  0x001C: "GPSAreaInformation",
  0x001D: "GPSDateStamp",
  0x001E: "GPSDifferential",
  0x001F: "GPSHPositioningError",
};

const ORIENTATION_MAP = {
  1: "Horizontal (normal)",
  2: "Mirror horizontal",
  3: "Rotate 180",
  4: "Mirror vertical",
  5: "Mirror horizontal and rotate 270 CW",
  6: "Rotate 90 CW",
  7: "Mirror horizontal and rotate 90 CW",
  8: "Rotate 270 CW",
};

const EXIF_TYPE_SIZES = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];

// ── TIFF/EXIF IFD parser ───────────────────────────────────────────────────────
function parseTiffIfd(buf, offset, le, tagMap, maxTags, depth) {
  const tags = {};
  if (depth > 4) return tags;
  if (offset + 2 > buf.length) return tags;

  const r16  = le ? (o) => buf.readUInt16LE(o) : (o) => buf.readUInt16BE(o);
  const r32  = le ? (o) => buf.readUInt32LE(o) : (o) => buf.readUInt32BE(o);
  const ri32 = le ? (o) => buf.readInt32LE(o)  : (o) => buf.readInt32BE(o);
  const r64  = (o, signed) => {
    const hi = le ? buf.readUInt32LE(o + 4) : buf.readUInt32BE(o);
    const lo = le ? buf.readUInt32LE(o)     : buf.readUInt32BE(o + 4);
    return hi * 4294967296 + lo;
  };

  const numEntries = r16(offset);
  if (numEntries > 1000 || offset + 2 + numEntries * 12 > buf.length) return tags;

  let count = 0;
  for (let i = 0; i < numEntries && count < maxTags; i++) {
    const eOff  = offset + 2 + i * 12;
    if (eOff + 12 > buf.length) break;
    const tag   = r16(eOff);
    const type  = r16(eOff + 2);
    const cnt   = r32(eOff + 4);
    const typeSize = (type >= 1 && type <= 12) ? EXIF_TYPE_SIZES[type] : 0;
    const dataLen  = typeSize * cnt;
    const dataOff  = dataLen <= 4 ? eOff + 8 : r32(eOff + 8);
    if (dataOff + dataLen > buf.length) continue;

    // Follow sub-IFDs
    if ((tag === 0x8769 || tag === 0x8825) && type === 4 && cnt === 1) {
      const subOff = r32(eOff + 8);
      const subTags = parseTiffIfd(buf, subOff, le, tagMap, maxTags - count, depth + 1);
      Object.assign(tags, subTags);
      count += Object.keys(subTags).length;
      continue;
    }

    const name = tagMap[tag] || ("Tag_0x" + tag.toString(16).padStart(4, "0"));
    let value;

    try {
      if (type === 2) { // ASCII
        value = buf.slice(dataOff, Math.min(dataOff + cnt, dataOff + 512)).toString("latin1").replace(/\0.*$/, "").trim();
      } else if (type === 5 || type === 10) { // RATIONAL / SRATIONAL
        const vals = [];
        for (let j = 0; j < Math.min(cnt, 16) && dataOff + j * 8 + 8 <= buf.length; j++) {
          if (type === 5) {
            const num = r32(dataOff + j * 8);
            const den = r32(dataOff + j * 8 + 4);
            vals.push(den !== 0 ? num / den : null);
          } else {
            const num = ri32(dataOff + j * 8);
            const den = ri32(dataOff + j * 8 + 4);
            vals.push(den !== 0 ? num / den : null);
          }
        }
        value = vals.length === 1 ? vals[0] : vals;
      } else if (type === 1 || type === 7) { // BYTE / UNDEFINED
        if (cnt <= 4) value = Array.from(buf.slice(dataOff, dataOff + cnt));
        else value = buf.slice(dataOff, Math.min(dataOff + 32, dataOff + cnt)).toString("hex");
      } else if (type === 3) { // SHORT
        const vals = [];
        for (let j = 0; j < Math.min(cnt, 16); j++)
          vals.push(r16(dataOff + j * 2));
        value = vals.length === 1 ? vals[0] : vals;
      } else if (type === 4) { // LONG
        const vals = [];
        for (let j = 0; j < Math.min(cnt, 16); j++)
          vals.push(r32(dataOff + j * 4));
        value = vals.length === 1 ? vals[0] : vals;
      } else if (type === 9) { // SLONG
        value = ri32(dataOff);
      } else if (type === 11) { // FLOAT
        value = buf.readFloatBE(dataOff);
      } else if (type === 12) { // DOUBLE
        value = buf.readDoubleBE(dataOff);
      } else {
        value = undefined;
      }
    } catch { value = undefined; }

    if (value !== undefined) {
      // Enrich orientation
      if (tag === 0x0112 && typeof value === "number")
        tags["OrientationDescription"] = ORIENTATION_MAP[value] || "Unknown";
      // GPS decimal degrees
      if (tag === 0x0002 && Array.isArray(value) && value.length === 3)
        tags["GPSLatitudeDec"] = +(value[0] + value[1]/60 + value[2]/3600).toFixed(7);
      if (tag === 0x0004 && Array.isArray(value) && value.length === 3)
        tags["GPSLongitudeDec"] = +(value[0] + value[1]/60 + value[2]/3600).toFixed(7);
      tags[name] = value;
      count++;
    }
  }
  return tags;
}

// ── JPEG parser ────────────────────────────────────────────────────────────────
function parseJpeg(buf, fileSize, operation) {
  const result = { format: "JPEG", fileSize };
  let pos = 2; // skip FF D8
  let width = 0, height = 0, channels = 0;
  let exifBuf = null, iptcData = null, xmpData = null;
  let hasThumbnail = false;
  const appSegments = [];

  while (pos + 4 <= buf.length) {
    if (buf[pos] !== 0xFF) break;
    const marker = buf.readUInt16BE(pos);
    const segLen  = buf.readUInt16BE(pos + 2); // includes the 2-byte length field
    const dataOff = pos + 4;
    const dataLen = segLen - 2;

    // SOF markers: dimensions
    if ((marker >= 0xFFC0 && marker <= 0xFFC3) ||
        (marker >= 0xFFC5 && marker <= 0xFFC7) ||
        (marker >= 0xFFC9 && marker <= 0xFFCB) ||
        (marker >= 0xFFCD && marker <= 0xFFCF)) {
      if (dataOff + 5 <= buf.length) {
        // prec(1), height(2), width(2), comp(1)
        height   = buf.readUInt16BE(dataOff + 1);
        width    = buf.readUInt16BE(dataOff + 3);
        channels = buf[dataOff + 5] || 0;
      }
    }

    // APP1: EXIF or XMP
    if (marker === 0xFFE1 && dataLen > 6 && dataOff + dataLen <= buf.length) {
      const hdr = buf.slice(dataOff, dataOff + 6).toString("latin1");
      if (hdr.startsWith("Exif\0\0") && !exifBuf) {
        exifBuf = buf.slice(dataOff + 6, Math.min(dataOff + dataLen, dataOff + MAX_EXIF_SIZE));
        appSegments.push({ type: "EXIF", offset: pos, size: segLen + 2 });
      } else if (hdr.startsWith("http://") || buf.slice(dataOff, Math.min(dataOff + 30, dataOff + dataLen)).toString("latin1").includes("xpacket")) {
        if (!xmpData)
          xmpData = buf.slice(dataOff, Math.min(dataOff + dataLen, dataOff + MAX_IPTC_SIZE)).toString("utf8");
        appSegments.push({ type: "XMP", offset: pos, size: segLen + 2 });
      }
    }
    // APP2: ICC profile
    if (marker === 0xFFE2 && dataLen > 12 && dataOff + 12 <= buf.length) {
      const hdr = buf.slice(dataOff, dataOff + 12).toString("latin1");
      if (hdr.startsWith("ICC_PROFILE"))
        appSegments.push({ type: "ICC_PROFILE", offset: pos, size: segLen + 2 });
    }
    // APP13: IPTC / Photoshop
    if (marker === 0xFFED && dataLen > 14 && dataOff + 14 <= buf.length) {
      const hdr = buf.slice(dataOff, dataOff + 14).toString("latin1");
      if (hdr.startsWith("Photoshop 3.0")) {
        iptcData = buf.slice(dataOff + 14, Math.min(dataOff + dataLen, dataOff + MAX_IPTC_SIZE));
        appSegments.push({ type: "IPTC", offset: pos, size: segLen + 2 });
      }
    }
    // APP14: Adobe
    if (marker === 0xFFEE && dataLen >= 12 && dataOff + 12 <= buf.length) {
      if (buf.slice(dataOff, dataOff + 5).toString("latin1") === "Adobe")
        appSegments.push({ type: "Adobe", offset: pos, size: segLen + 2 });
    }
    // Skip to next segment
    if (marker === 0xFFDA) break; // SOS: start of scan, stop
    pos += 2 + segLen;
    if (pos >= buf.length) break;
  }

  result.width    = width;
  result.height   = height;
  result.channels = channels;
  result.colorSpace = channels === 1 ? "Grayscale" : channels === 3 ? "YCbCr/RGB" : channels === 4 ? "CMYK" : "Unknown";
  result.bitDepth  = 8;
  result.hasAlpha  = false;
  result.appSegments = appSegments;
  result.hasEXIF   = appSegments.some(s => s.type === "EXIF");
  result.hasIPTC   = appSegments.some(s => s.type === "IPTC");
  result.hasXMP    = appSegments.some(s => s.type === "XMP");
  result.hasICC    = appSegments.some(s => s.type === "ICC_PROFILE");

  if (exifBuf) {
    result._exifBuf = exifBuf;
  }
  if (iptcData) {
    result._iptcBuf = iptcData;
  }
  if (xmpData) {
    result._xmpStr = xmpData;
  }
  return result;
}

// ── PNG parser ─────────────────────────────────────────────────────────────────
const PNG_COLOR_TYPES = { 0: "Grayscale", 2: "RGB", 3: "Indexed", 4: "Grayscale+Alpha", 6: "RGBA" };
const PNG_CHANNEL_MAP = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function parsePng(buf, fileSize, operation) {
  const result = { format: "PNG", fileSize };
  if (buf.length < 33) throw new Error("image_client: PNG too small for IHDR.");

  // IHDR is always the first chunk after the signature
  result.width      = buf.readUInt32BE(16);
  result.height     = buf.readUInt32BE(20);
  result.bitDepth   = buf[24];
  const colorType   = buf[25];
  result.colorType  = colorType;
  result.colorSpace = PNG_COLOR_TYPES[colorType] || `Unknown(${colorType})`;
  result.channels   = PNG_CHANNEL_MAP[colorType] ?? 1;
  result.hasAlpha   = colorType === 4 || colorType === 6;
  result.interlaced = buf[28] !== 0;
  result.compression = buf[26] === 0 ? "Deflate" : `Unknown(${buf[26]})`;
  result.filter      = buf[27] === 0 ? "Adaptive" : `Unknown(${buf[27]})`;

  // Walk chunks
  const chunks = [];
  const textChunks = {};
  let xmpData = null, iccData = null;
  let posChunk = 8; // after 8-byte PNG signature
  let chunkCount = 0;

  while (posChunk + 12 <= buf.length && chunkCount < 1000) {
    chunkCount++;
    const chunkLen  = buf.readUInt32BE(posChunk);
    const chunkType = buf.slice(posChunk + 4, posChunk + 8).toString("latin1");
    const dataStart = posChunk + 8;
    const dataEnd   = Math.min(dataStart + chunkLen, buf.length);

    chunks.push({ type: chunkType, size: chunkLen });

    if (chunkType === "tEXt" && dataEnd > dataStart) {
      // key\0value
      const payload = buf.slice(dataStart, dataEnd).toString("latin1");
      const nulIdx  = payload.indexOf("\0");
      if (nulIdx >= 0) {
        const key = payload.slice(0, nulIdx).trim();
        const val = payload.slice(nulIdx + 1);
        textChunks[key] = val;
      }
    } else if (chunkType === "zTXt" && dataEnd > dataStart + 2) {
      // key\0comp_method\0deflate(value)
      const keyEnd = buf.indexOf(0, dataStart);
      if (keyEnd > dataStart && keyEnd < dataEnd - 1) {
        const key = buf.slice(dataStart, keyEnd).toString("latin1").trim();
        try {
          const val = zlib.inflateSync(buf.slice(keyEnd + 2, dataEnd)).toString("utf8");
          textChunks[key] = val;
        } catch { /* compressed data corrupt */ }
      }
    } else if (chunkType === "iTXt" && dataEnd > dataStart + 4) {
      // keyword\0compression_flag\0compression_method\0lang_tag\0translated_keyword\0text
      const keyEnd = buf.indexOf(0, dataStart);
      if (keyEnd >= dataStart) {
        const key  = buf.slice(dataStart, keyEnd).toString("utf8").trim();
        const flag = keyEnd + 1 < dataEnd ? buf[keyEnd + 1] : 0;
        const meth = keyEnd + 2 < dataEnd ? buf[keyEnd + 2] : 0;
        const rest = buf.slice(keyEnd + 3, dataEnd);
        // Skip lang and translated keyword (two NUL-terminated)
        let p2 = rest.indexOf(0);
        let p3 = p2 >= 0 ? rest.indexOf(0, p2 + 1) : -1;
        let textBuf = (p3 >= 0) ? rest.slice(p3 + 1) : rest;
        try {
          const val = flag === 1 && meth === 0
            ? zlib.inflateSync(textBuf).toString("utf8")
            : textBuf.toString("utf8");
          if (key === "XML:com.adobe.xmp" || key === "xmp") xmpData = val;
          else textChunks[key] = val;
        } catch { /* inflate failed */ }
      }
    } else if (chunkType === "tIME" && chunkLen >= 7 && dataEnd >= dataStart + 7) {
      const year  = buf.readUInt16BE(dataStart);
      const month = buf[dataStart + 2];
      const day   = buf[dataStart + 3];
      const hour  = buf[dataStart + 4];
      const min   = buf[dataStart + 5];
      const sec   = buf[dataStart + 6];
      result.lastModified = `${year}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}T${String(hour).padStart(2,"0")}:${String(min).padStart(2,"0")}:${String(sec).padStart(2,"0")}Z`;
    } else if (chunkType === "pHYs" && chunkLen >= 9 && dataEnd >= dataStart + 9) {
      const px    = buf.readUInt32BE(dataStart);
      const py    = buf.readUInt32BE(dataStart + 4);
      const unit  = buf[dataStart + 8];
      result.pixelsPerUnit = { x: px, y: py, unit: unit === 1 ? "meter" : "aspect_ratio" };
      if (unit === 1) {
        result.dpi = { x: Math.round(px * 0.0254), y: Math.round(py * 0.0254) };
      }
    } else if (chunkType === "bKGD" && dataEnd > dataStart) {
      if (colorType === 0 || colorType === 4) {
        result.backgroundColor = { gray: buf.readUInt16BE(dataStart) };
      } else if (colorType === 2 || colorType === 6) {
        result.backgroundColor = {
          r: buf.readUInt16BE(dataStart),
          g: buf.readUInt16BE(dataStart + 2),
          b: buf.readUInt16BE(dataStart + 4),
        };
      }
    } else if (chunkType === "gAMA" && chunkLen >= 4 && dataEnd >= dataStart + 4) {
      result.gamma = buf.readUInt32BE(dataStart) / 100000;
    } else if (chunkType === "sRGB" && chunkLen >= 1 && dataEnd >= dataStart + 1) {
      const ri = buf[dataStart];
      const RENDER_INTENTS = ["Perceptual","Relative colorimetric","Saturation","Absolute colorimetric"];
      result.sRGBRenderingIntent = RENDER_INTENTS[ri] || "Unknown";
      result.colorProfile = "sRGB";
    } else if (chunkType === "iCCP" && dataEnd > dataStart + 2) {
      const nameEnd = buf.indexOf(0, dataStart);
      if (nameEnd > dataStart && nameEnd < dataEnd) {
        result.iccProfileName = buf.slice(dataStart, nameEnd).toString("latin1");
      }
      iccData = true;
    } else if (chunkType === "cHRM" && chunkLen >= 32 && dataEnd >= dataStart + 32) {
      result.chromaticity = {
        whiteX: buf.readUInt32BE(dataStart)     / 100000,
        whiteY: buf.readUInt32BE(dataStart + 4) / 100000,
        redX:   buf.readUInt32BE(dataStart + 8) / 100000,
        redY:   buf.readUInt32BE(dataStart + 12)/ 100000,
        greenX: buf.readUInt32BE(dataStart + 16)/ 100000,
        greenY: buf.readUInt32BE(dataStart + 20)/ 100000,
        blueX:  buf.readUInt32BE(dataStart + 24)/ 100000,
        blueY:  buf.readUInt32BE(dataStart + 28)/ 100000,
      };
    } else if (chunkType === "sBIT" && dataEnd > dataStart) {
      result.significantBits = Array.from(buf.slice(dataStart, dataEnd));
    } else if (chunkType === "hIST" && dataEnd > dataStart) {
      const histCount = Math.floor((dataEnd - dataStart) / 2);
      result.histogram = { entryCount: histCount };
    }

    if (chunkType === "IEND") break;
    posChunk += 4 + 4 + chunkLen + 4; // len + type + data + crc
  }

  result.chunkTypes = [...new Set(chunks.map(c => c.type))];
  result.chunkCount = chunks.length;
  if (Object.keys(textChunks).length > 0) result.textMetadata = textChunks;
  if (xmpData) result._xmpStr = xmpData;
  result.hasICC = !!iccData;
  result.hasXMP = !!xmpData;
  return result;
}

// ── WebP parser ────────────────────────────────────────────────────────────────
function parseWebp(buf, fileSize) {
  const result = { format: "WebP", fileSize };
  if (buf.length < 12) throw new Error("image_client: WebP too small.");

  const chunk = buf.slice(12, 16).toString("latin1");
  result.subFormat = chunk.trim();
  result.hasAlpha  = false;
  result.bitDepth  = 8;

  if (chunk === "VP8 " && buf.length >= 30 &&
      buf[23] === 0x9D && buf[24] === 0x01 && buf[25] === 0x2A) {
    result.width  = buf.readUInt16LE(26) & 0x3FFF;
    result.height = buf.readUInt16LE(28) & 0x3FFF;
    result.lossy  = true;
  } else if (chunk === "VP8L" && buf.length >= 25 && buf[20] === 0x2F) {
    const bits     = buf.readUInt32LE(21);
    result.width   = (bits & 0x3FFF) + 1;
    result.height  = ((bits >> 14) & 0x3FFF) + 1;
    result.hasAlpha= ((bits >> 28) & 1) === 1;
    result.lossy   = false;
  } else if (chunk === "VP8X" && buf.length >= 34) {
    const flags    = buf[20];
    result.hasAlpha= (flags & 0x10) !== 0;
    result.hasAnim = (flags & 0x02) !== 0;
    result.hasICC  = (flags & 0x20) !== 0;
    result.hasEXIF = (flags & 0x08) !== 0;
    result.hasXMP  = (flags & 0x04) !== 0;
    result.width   = buf.readUIntLE(24, 3) + 1;
    result.height  = buf.readUIntLE(27, 3) + 1;
    result.lossy   = null; // could be either
  }

  // Walk RIFF chunks for EXIF/XMP
  let posW = 12;
  let exifBuf = null, xmpData = null;
  while (posW + 8 <= buf.length) {
    const cType = buf.slice(posW, posW + 4).toString("latin1");
    const cSize = buf.readUInt32LE(posW + 4);
    if (cType === "EXIF" && !exifBuf) {
      exifBuf = buf.slice(posW + 8, Math.min(posW + 8 + cSize, buf.length, posW + 8 + MAX_EXIF_SIZE));
    } else if (cType === "XMP " && !xmpData) {
      xmpData = buf.slice(posW + 8, Math.min(posW + 8 + cSize, buf.length)).toString("utf8");
    } else if (cType === "ICCP") {
      result.hasICC = true;
    }
    posW += 8 + cSize + (cSize & 1);
    if (cSize === 0) break;
  }
  if (exifBuf) result._exifBuf = exifBuf;
  if (xmpData) result._xmpStr  = xmpData;
  return result;
}

// ── TIFF parser ────────────────────────────────────────────────────────────────
function parseTiff(buf, fileSize) {
  const result = { format: "TIFF", fileSize };
  if (buf.length < 8) throw new Error("image_client: TIFF too small.");

  const le  = buf[0] === 0x49; // II = little-endian, MM = big-endian
  result.byteOrder = le ? "little-endian" : "big-endian";
  const r16 = le ? (o) => buf.readUInt16LE(o) : (o) => buf.readUInt16BE(o);
  const r32 = le ? (o) => buf.readUInt32LE(o) : (o) => buf.readUInt32BE(o);

  const ifd0Offset = r32(4);
  if (ifd0Offset + 2 > buf.length) return result;

  const tags = parseTiffIfd(buf, ifd0Offset, le, EXIF_TAGS, MAX_TAGS, 0);

  // Extract key fields from tags
  result.width       = tags["PixelXDimension"] || tags["Tag_0x0100"] || 0;
  result.height      = tags["PixelYDimension"] || tags["Tag_0x0101"] || 0;
  result.bitDepth    = tags["Tag_0x0102"]  || 8; // BitsPerSample
  result.samplesPerPixel = tags["Tag_0x0115"] || 1; // SamplesPerPixel

  // Walk IFD0 for common tiff tags
  const numEntries = r16(ifd0Offset);
  for (let i = 0; i < Math.min(numEntries, 200); i++) {
    const eOff = ifd0Offset + 2 + i * 12;
    if (eOff + 12 > buf.length) break;
    const tag = r16(eOff);
    if (tag === 0x0100) { // ImageWidth
      const type = r16(eOff + 2);
      result.width = type === 3 ? r16(eOff + 8) : r32(eOff + 8);
    } else if (tag === 0x0101) { // ImageLength
      const type = r16(eOff + 2);
      result.height = type === 3 ? r16(eOff + 8) : r32(eOff + 8);
    } else if (tag === 0x0102) { // BitsPerSample
      result.bitDepth = r16(eOff + 8);
    } else if (tag === 0x0115) { // SamplesPerPixel
      result.samplesPerPixel = r16(eOff + 8);
    } else if (tag === 0x0106) { // PhotometricInterpretation
      const pi = r16(eOff + 8);
      const PHOTO = { 0:"WhiteIsZero", 1:"BlackIsZero", 2:"RGB", 3:"RGB Palette",
                      4:"Transparency Mask", 5:"CMYK", 6:"YCbCr", 8:"CIELab" };
      result.colorSpace = PHOTO[pi] || `PhotometricInterp(${pi})`;
    } else if (tag === 0x0128) { // ResolutionUnit
      result.resolutionUnit = r16(eOff + 8) === 2 ? "inch" : r16(eOff + 8) === 3 ? "centimeter" : "none";
    }
  }

  result.hasAlpha = (result.samplesPerPixel || 0) > 3;
  result._exifBuf = buf;  // entire TIFF is EXIF
  result._exifLe  = le;
  result._ifd0Off = ifd0Offset;
  result.tags     = tags;
  result.hasEXIF  = true;
  return result;
}

// ── BMP parser ─────────────────────────────────────────────────────────────────
function parseBmp(buf, fileSize) {
  const result = { format: "BMP", fileSize };
  if (buf.length < 54) throw new Error("image_client: BMP too small.");

  const fileHeaderSize = 14;
  const infoSize = buf.readUInt32LE(14);

  if (infoSize >= 40 && buf.length >= 54) {
    result.width           = Math.abs(buf.readInt32LE(18));
    result.height          = Math.abs(buf.readInt32LE(22));
    const planes           = buf.readUInt16LE(26);
    result.bitDepth        = buf.readUInt16LE(28);
    const compression      = buf.readUInt32LE(30);
    result.compression     = ["None (BI_RGB)","RLE8","RLE4","BITFIELDS","JPEG","PNG"][compression] || `Unknown(${compression})`;
    result.colorsInTable   = buf.readUInt32LE(46);
    const hRes             = buf.readInt32LE(38);
    const vRes             = buf.readInt32LE(42);
    if (hRes > 0) result.dpi = { x: Math.round(hRes * 0.0254), y: Math.round(vRes * 0.0254) };
  } else {
    // OS/2 BITMAPCOREHEADER
    result.width    = buf.readUInt16LE(18);
    result.height   = buf.readUInt16LE(20);
    result.bitDepth = buf.readUInt16LE(24);
  }

  result.channels   = result.bitDepth <= 8 ? 1 : result.bitDepth === 24 ? 3 : 4;
  result.hasAlpha   = result.bitDepth === 32;
  result.colorSpace = result.bitDepth <= 8 ? "Indexed" : result.bitDepth === 24 ? "RGB" : "RGBA";
  result.pixelDataOffset = buf.readUInt32LE(10);
  return result;
}

// ── GIF parser ─────────────────────────────────────────────────────────────────
function parseGif(buf, fileSize) {
  const result = { format: "GIF", fileSize };
  if (buf.length < 13) throw new Error("image_client: GIF too small.");

  result.version    = buf.slice(0, 6).toString("latin1"); // GIF87a or GIF89a
  result.width      = buf.readUInt16LE(6);
  result.height     = buf.readUInt16LE(8);
  result.bitDepth   = 8;
  result.hasAlpha   = true; // GIF supports transparency via GCE
  result.colorSpace = "Indexed";

  const packed         = buf[10];
  result.hasGCT        = (packed & 0x80) !== 0; // Global Color Table
  result.colorResolution = ((packed >> 4) & 0x07) + 1;
  result.gctSize       = result.hasGCT ? Math.pow(2, (packed & 0x07) + 1) : 0;
  result.bgColorIndex  = buf[11];
  result.pixelAspectRatio = buf[12] ? (buf[12] + 15) / 64 : 1;

  // Count frames and check for animation (GIF89a extension blocks)
  let posG = 13 + (result.hasGCT ? result.gctSize * 3 : 0);
  let frameCount = 0;
  let hasTransparency = false, loopCount = 0;
  const xmpBuf = null;

  while (posG < buf.length && posG < 32768) { // scan first 32KB
    const b = buf[posG];
    if (b === 0x3B) break; // trailer
    if (b === 0x2C) { // image descriptor
      frameCount++;
      posG += 10;
      if (posG < buf.length) {
        const lctFlag = (buf[posG - 1] & 0x80) !== 0;
        const lctSize = lctFlag ? Math.pow(2, (buf[posG - 1] & 0x07) + 1) : 0;
        posG += lctSize * 3 + 1; // skip LCT + min code size
        // skip sub-blocks
        while (posG < buf.length) {
          const subLen = buf[posG++];
          if (subLen === 0) break;
          posG += subLen;
        }
      }
    } else if (b === 0x21) { // extension
      if (posG + 1 < buf.length) {
        const extLabel = buf[posG + 1];
        posG += 2;
        if (extLabel === 0xF9 && posG + 1 < buf.length) {
          // Graphic Control Extension
          const blockSize = buf[posG++];
          if (posG + blockSize <= buf.length) {
            hasTransparency = hasTransparency || ((buf[posG] & 0x01) !== 0);
            posG += blockSize;
          }
        } else if (extLabel === 0xFF && posG + 1 < buf.length) {
          // Application Extension (Netscape loop)
          const blockSize = buf[posG++];
          if (posG + blockSize <= buf.length && blockSize === 11) {
            const appId = buf.slice(posG, posG + 11).toString("latin1");
            posG += blockSize;
            if (appId.startsWith("NETSCAPE2.0") || appId.startsWith("ANIMEXTS1.0")) {
              while (posG < buf.length) {
                const subLen = buf[posG++];
                if (subLen === 0) break;
                if (subLen === 3 && buf[posG] === 1 && posG + 2 < buf.length)
                  loopCount = buf.readUInt16LE(posG + 1);
                posG += subLen;
              }
            } else {
              // skip sub-blocks
              while (posG < buf.length) {
                const subLen = buf[posG++];
                if (subLen === 0) break;
                posG += subLen;
              }
            }
          } else {
            // skip sub-blocks
            while (posG < buf.length) {
              const subLen = buf[posG++];
              if (subLen === 0) break;
              posG += subLen;
            }
          }
        } else {
          // skip sub-blocks
          while (posG < buf.length) {
            const subLen = buf[posG++];
            if (subLen === 0) break;
            posG += subLen;
          }
        }
      } else break;
    } else {
      posG++;
    }
  }

  result.frameCount   = Math.max(1, frameCount);
  result.isAnimated   = frameCount > 1;
  result.loopCount    = loopCount; // 0 = infinite
  result.hasTransparency = hasTransparency;
  result.channels     = 4; // always RGBA with transparency support
  return result;
}

// ── ICO parser ─────────────────────────────────────────────────────────────────
function parseIco(buf, fileSize) {
  const result = { format: "ICO", fileSize };
  if (buf.length < 6) throw new Error("image_client: ICO too small.");

  const imageType = buf.readUInt16LE(2);
  result.iconType  = imageType === 1 ? "ICO" : imageType === 2 ? "CUR" : `Unknown(${imageType})`;
  const count      = buf.readUInt16LE(4);
  result.imageCount = count;

  const images = [];
  for (let i = 0; i < Math.min(count, 256) && 6 + i * 16 + 16 <= buf.length; i++) {
    const off = 6 + i * 16;
    let w = buf[off];     if (w === 0) w = 256;
    let h = buf[off + 1]; if (h === 0) h = 256;
    const colorCount = buf[off + 2];
    const planes     = buf.readUInt16LE(off + 4);
    const bpp        = buf.readUInt16LE(off + 6);
    const imgSize    = buf.readUInt32LE(off + 8);
    const imgOffset  = buf.readUInt32LE(off + 12);
    // Detect if PNG embedded
    let isPng = false;
    if (imgOffset + 4 <= buf.length)
      isPng = buf[imgOffset] === 0x89 && buf[imgOffset+1] === 0x50;
    images.push({ width: w, height: h, colorCount, planes, bitsPerPixel: bpp, size: imgSize, isPng });
  }

  result.images = images;
  if (images.length > 0) {
    // Pick the largest image for the "primary" size
    const largest = images.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b));
    result.width  = largest.width;
    result.height = largest.height;
    result.bitDepth = largest.bitsPerPixel;
  }
  result.hasAlpha = true;
  result.colorSpace = "Indexed/RGBA";
  return result;
}

// ── EXIF buffer parser ─────────────────────────────────────────────────────────
function parseExifBuf(exifBuf, isLe, ifd0Off) {
  if (!exifBuf || exifBuf.length < 8) return {};

  // If called from JPEG: first 8 bytes are TIFF header
  // If called from TIFF: already positioned
  let le = isLe;
  let offset = ifd0Off;

  if (isLe === undefined) {
    // Detect from EXIF buffer (JPEG case)
    if (exifBuf.length < 8) return {};
    le = exifBuf[0] === 0x49;
    const magic = le ? exifBuf.readUInt16LE(2) : exifBuf.readUInt16BE(2);
    if (magic !== 42) return {};
    offset = le ? exifBuf.readUInt32LE(4) : exifBuf.readUInt32BE(4);
  }

  return parseTiffIfd(exifBuf, offset, le, EXIF_TAGS, MAX_TAGS, 0);
}

// ── IPTC parser ────────────────────────────────────────────────────────────────
const IPTC_TAGS = {
  0x0014: "ModelVersion",
  0x005A: "Destination",
  0x005F: "FileFormat",
  0x0060: "FileVersion",
  0x0064: "ServiceIdentifier",
  0x0069: "EnvelopeNumber",
  0x0070: "ProductID",
  0x0078: "EnvelopePriority",
  0x0082: "DateSent",
  0x008C: "TimeSent",
  0x0096: "CodedCharacterSet",
  0x00A0: "UniqueObjectName",
  0x0078: "Priority",
  // Record 2 (Application)
  0x0200: "RecordVersion",     // 2:00
  0x0203: "ObjectTypeRef",      // 2:03
  0x0208: "ObjectAttrRef",      // 2:08
  0x020A: "ObjectName",         // 2:10
  0x0214: "EditStatus",         // 2:20
  0x0216: "EditorialUpdate",    // 2:22
  0x021E: "Urgency",             // 2:30
  0x0222: "SubjectReference",  // 2:34
  0x0228: "Category",           // 2:40
  0x022F: "SupplCategory",      // 2:47
  0x0232: "FixtureIdentifier", // 2:50
  0x0237: "Keywords",           // 2:55
  0x023C: "ContentLocationCode",// 2:60
  0x023E: "ContentLocationName",// 2:62
  0x0246: "ReleaseDate",        // 2:70
  0x0250: "ReleaseTime",        // 2:80
  0x0255: "ExpirationDate",     // 2:85
  0x025F: "ExpirationTime",     // 2:95
  0x0264: "SpecialInstructions",// 2:100
  0x0269: "ActionAdvised",      // 2:105
  0x0273: "ReferenceService",   // 2:115
  0x0278: "ReferenceDate",      // 2:120
  0x027D: "ReferenceNumber",    // 2:125
  0x0282: "DateCreated",        // 2:130
  0x028C: "TimeCreated",        // 2:140
  0x0296: "DigitalCreationDate",// 2:150
  0x02A0: "DigitalCreationTime",// 2:160
  0x02A5: "OriginatingProgram", // 2:165
  0x02AA: "ProgramVersion",     // 2:170
  0x02B4: "ObjectCycle",        // 2:180
  0x02B9: "Byline",              // 2:185 (author/photographer)
  0x02BE: "BylineTitle",        // 2:190
  0x02C8: "City",                // 2:200
  0x02CD: "Sublocation",         // 2:205
  0x02D2: "ProvinceState",      // 2:210
  0x02D7: "CountryCode",        // 2:215
  0x02DC: "Country",             // 2:220
  0x02E1: "OrigTransRef",       // 2:225
  0x02E6: "Headline",            // 2:230
  0x02EB: "Credit",              // 2:235
  0x02F0: "Source",              // 2:240
  0x02F5: "CopyrightNotice",    // 2:245
  0x02FA: "Contact",             // 2:250
  0x0302: "CaptionAbstract",    // 2:260 (description)
  0x0307: "WriterEditor",       // 2:295
  0x0316: "ImageType",           // 2:270 (rasterized caption)
  0x031A: "ImageOrientation",   // 2:271
  0x031E: "LanguageIdentifier", // 2:274
};

function parseIptcData(iptcBuf) {
  const tags = {};
  let pos = 0;
  // IPTC data starts with Photoshop IRB blocks: 8BIM marker
  while (pos + 4 <= iptcBuf.length) {
    if (iptcBuf[pos] !== 0x38 || iptcBuf[pos+1] !== 0x42 || iptcBuf[pos+2] !== 0x49 || iptcBuf[pos+3] !== 0x4D) {
      pos++; continue;
    }
    pos += 4;
    if (pos + 2 > iptcBuf.length) break;
    const resourceId = iptcBuf.readUInt16BE(pos); pos += 2;
    // Pascal string name (padded to even)
    const nameLen = iptcBuf[pos++];
    pos += nameLen + (nameLen % 2 === 0 ? 1 : 0); // pad to even
    if (pos + 4 > iptcBuf.length) break;
    const resourceSize = iptcBuf.readUInt32BE(pos); pos += 4;
    const resourceEnd  = pos + resourceSize;

    if (resourceId === 0x0404) { // IPTC-NAA Record
      // Parse IPTC NAA data stream
      let p = pos;
      while (p + 5 <= Math.min(resourceEnd, iptcBuf.length)) {
        if (iptcBuf[p] !== 0x1C) { p++; continue; }
        const rec  = iptcBuf[p + 1];
        const ds   = iptcBuf[p + 2];
        const dLen = iptcBuf.readUInt16BE(p + 3);
        p += 5;
        if (p + dLen > Math.min(resourceEnd, iptcBuf.length)) break;
        const key  = (rec << 8) | ds;
        const name = IPTC_TAGS[key] || `IPTC_${rec}_${ds}`;
        const val  = iptcBuf.slice(p, p + dLen).toString("utf8").replace(/\0/g, "");
        if (val) {
          if (tags[name]) {
            // Multi-value: make array
            if (!Array.isArray(tags[name])) tags[name] = [tags[name]];
            tags[name].push(val);
          } else {
            tags[name] = val;
          }
        }
        p += dLen;
      }
    }
    pos = resourceEnd + (resourceSize % 2 !== 0 ? 1 : 0);
  }
  return tags;
}

// ── XMP extractor ──────────────────────────────────────────────────────────────
function extractXmpFields(xmpStr) {
  if (!xmpStr) return {};
  const fields = {};
  // Extract common XMP fields via lightweight regex (no XML parser)
  const patterns = [
    ["dc:title",       /<dc:title[^>]*>\s*<rdf:Alt[^>]*>\s*<rdf:li[^>]*>([^<]+)<\/rdf:li>/i],
    ["dc:description", /<dc:description[^>]*>\s*<rdf:Alt[^>]*>\s*<rdf:li[^>]*>([^<]+)<\/rdf:li>/i],
    ["dc:creator",     /<dc:creator[^>]*>\s*<rdf:Seq[^>]*>\s*<rdf:li[^>]*>([^<]+)<\/rdf:li>/i],
    ["dc:subject",     /<rdf:li[^>]*>([^<]+)<\/rdf:li>/gi],
    ["dc:rights",      /<dc:rights[^>]*>\s*<rdf:Alt[^>]*>\s*<rdf:li[^>]*>([^<]+)<\/rdf:li>/i],
    ["xmp:CreateDate",     /<xmp:CreateDate>([^<]+)<\/xmp:CreateDate>/i],
    ["xmp:ModifyDate",     /<xmp:ModifyDate>([^<]+)<\/xmp:ModifyDate>/i],
    ["xmp:MetadataDate",   /<xmp:MetadataDate>([^<]+)<\/xmp:MetadataDate>/i],
    ["xmp:CreatorTool",    /<xmp:CreatorTool>([^<]+)<\/xmp:CreatorTool>/i],
    ["xmp:Rating",         /<xmp:Rating>([^<]+)<\/xmp:Rating>/i],
    ["xmpMM:DocumentID",   /<xmpMM:DocumentID>([^<]+)<\/xmpMM:DocumentID>/i],
    ["xmpMM:InstanceID",   /<xmpMM:InstanceID>([^<]+)<\/xmpMM:InstanceID>/i],
    ["photoshop:Headline", /<photoshop:Headline>([^<]+)<\/photoshop:Headline>/i],
    ["photoshop:Credit",   /<photoshop:Credit>([^<]+)<\/photoshop:Credit>/i],
    ["photoshop:Source",   /<photoshop:Source>([^<]+)<\/photoshop:Source>/i],
    ["photoshop:City",     /<photoshop:City>([^<]+)<\/photoshop:City>/i],
    ["photoshop:Country",  /<photoshop:Country>([^<]+)<\/photoshop:Country>/i],
    ["photoshop:ColorMode",/<photoshop:ColorMode>([^<]+)<\/photoshop:ColorMode>/i],
    ["tiff:Make",          /<tiff:Make>([^<]+)<\/tiff:Make>/i],
    ["tiff:Model",         /<tiff:Model>([^<]+)<\/tiff:Model>/i],
    ["tiff:Orientation",   /<tiff:Orientation>([^<]+)<\/tiff:Orientation>/i],
    ["exif:ExposureTime",  /<exif:ExposureTime>([^<]+)<\/exif:ExposureTime>/i],
    ["exif:FNumber",       /<exif:FNumber>([^<]+)<\/exif:FNumber>/i],
    ["exif:ISOSpeedRatings",/<exif:ISOSpeedRatings[^>]*>\s*<rdf:Seq[^>]*>\s*<rdf:li>([^<]+)<\/rdf:li>/i],
    ["exif:DateTimeOriginal",/<exif:DateTimeOriginal>([^<]+)<\/exif:DateTimeOriginal>/i],
    ["exif:FocalLength",   /<exif:FocalLength>([^<]+)<\/exif:FocalLength>/i],
  ];
  for (const [key, pat] of patterns) {
    if (key === "dc:subject") continue; // handled separately
    const m = xmpStr.match(pat);
    if (m) fields[key] = m[1].trim();
  }
  // dc:subject keywords
  const subjMatch = xmpStr.match(/<dc:subject[^>]*>[\s\S]*?<\/dc:subject>/i);
  if (subjMatch) {
    const kws = [];
    let km;
    const liPat = /<rdf:li[^>]*>([^<]+)<\/rdf:li>/gi;
    const subjSeg = subjMatch[0];
    while ((km = liPat.exec(subjSeg)) !== null) kws.push(km[1].trim());
    if (kws.length > 0) fields["dc:subject"] = kws;
  }
  return fields;
}

// ── Main export ────────────────────────────────────────────────────────────────
function imageClient(args) {
  const { operation, path: filePath } = args;
  if (!operation) throw new Error("image_client: 'operation' is required.");
  if (!filePath)  throw new Error("image_client: 'path' is required.");
  const VALID_OPS = ["info", "exif", "iptc", "xmp", "validate"];
  if (!VALID_OPS.includes(operation))
    throw new Error(`image_client: unknown operation '${operation}'. Valid: ${VALID_OPS.join(", ")}.`);
  if (filePath.includes("\0")) throw new Error("image_client: path contains NUL byte.");

  const { buf, fileSize } = readBuf(filePath, MAX_READ_HEAD);
  const fmt = detectFormat(buf);
  if (!fmt)
    throw new Error(`image_client: unrecognized image format for '${path.basename(filePath)}'. Supported: JPEG, PNG, WebP, TIFF, BMP, GIF, ICO.`);

  let parsed;
  switch (fmt) {
    case "jpeg": parsed = parseJpeg(buf, fileSize, operation); break;
    case "png":  parsed = parsePng(buf, fileSize, operation);  break;
    case "webp": parsed = parseWebp(buf, fileSize);            break;
    case "tiff": parsed = parseTiff(buf, fileSize);            break;
    case "bmp":  parsed = parseBmp(buf, fileSize);             break;
    case "gif":  parsed = parseGif(buf, fileSize);             break;
    case "ico":  parsed = parseIco(buf, fileSize);             break;
    default:     throw new Error(`image_client: unsupported format '${fmt}'.`);
  }

  const base = {
    path: filePath, operation,
    format: parsed.format, fileSize: parsed.fileSize,
    width: parsed.width, height: parsed.height,
  };

  // ── info ──────────────────────────────────────────────────────────────────
  if (operation === "info") {
    const info = { ...base };
    const infoFields = [
      "bitDepth","colorSpace","colorType","channels","hasAlpha","interlaced",
      "compression","filter","byteOrder","resolutionUnit","samplesPerPixel",
      "dpi","pixelsPerUnit","gamma","sRGBRenderingIntent","colorProfile",
      "iccProfileName","backgroundColor","significantBits","chromaticity",
      "lastModified","chunkTypes","chunkCount","textMetadata",
      "hasEXIF","hasIPTC","hasXMP","hasICC","hasAnim",
      "appSegments","subFormat","lossy",
      "version","frameCount","isAnimated","loopCount","hasTransparency","gctSize",
      "iconType","imageCount","images",
      "pixelDataOffset","colorsInTable","hasGCT","colorResolution","bgColorIndex",
      "histogram",
    ];
    for (const f of infoFields)
      if (parsed[f] !== undefined) info[f] = parsed[f];
    return info;
  }

  // ── exif ──────────────────────────────────────────────────────────────────
  if (operation === "exif") {
    let exifTags = {};
    if (parsed._exifBuf) {
      exifTags = parseExifBuf(parsed._exifBuf, parsed._exifLe, parsed._ifd0Off);
    } else if (parsed.tags) {
      exifTags = parsed.tags;
    }
    const hasExif = Object.keys(exifTags).length > 0;
    return {
      ...base,
      hasEXIF: hasExif,
      exifTagCount: Object.keys(exifTags).length,
      exif: exifTags,
    };
  }

  // ── iptc ──────────────────────────────────────────────────────────────────
  if (operation === "iptc") {
    let iptcTags = {};
    if (parsed._iptcBuf) {
      iptcTags = parseIptcData(parsed._iptcBuf);
    }
    return {
      ...base,
      hasIPTC: Object.keys(iptcTags).length > 0,
      iptcTagCount: Object.keys(iptcTags).length,
      iptc: iptcTags,
    };
  }

  // ── xmp ───────────────────────────────────────────────────────────────────
  if (operation === "xmp") {
    const xmpFields = extractXmpFields(parsed._xmpStr || null);
    return {
      ...base,
      hasXMP: Object.keys(xmpFields).length > 0,
      xmpFieldCount: Object.keys(xmpFields).length,
      xmp: xmpFields,
      rawXMP: args.include_raw ? (parsed._xmpStr || null) : undefined,
    };
  }

  // ── validate ──────────────────────────────────────────────────────────────
  if (operation === "validate") {
    const issues = [];
    if (!parsed.width || !parsed.height) issues.push("Could not determine image dimensions.");
    if (parsed.width === 0) issues.push("Width is 0.");
    if (parsed.height === 0) issues.push("Height is 0.");
    if (fmt === "jpeg" && !parsed.appSegments) issues.push("No APP segments found.");
    if (fmt === "png" && parsed.chunkCount === 0) issues.push("No PNG chunks found.");
    if (fmt === "gif" && (parsed.frameCount || 0) === 0) issues.push("No GIF frames found.");
    if (fmt === "ico" && (parsed.imageCount || 0) === 0) issues.push("No ICO images found.");
    return {
      ...base,
      valid: issues.length === 0,
      issueCount: issues.length,
      issues,
      bitDepth: parsed.bitDepth,
      colorSpace: parsed.colorSpace,
      hasAlpha: parsed.hasAlpha,
      hasEXIF: parsed.hasEXIF || false,
      hasIPTC: parsed.hasIPTC || false,
      hasXMP: parsed.hasXMP  || false,
      hasICC: parsed.hasICC  || false,
    };
  }

  throw new Error(`image_client: unhandled operation '${operation}'.`);
}

module.exports = { imageClient };
