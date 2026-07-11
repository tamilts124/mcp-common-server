"use strict";
// ── UTILITY TOOL SCHEMAS — part 18 ────────────────────────────────────────────────────
// Added: image_ops (v4.155.0).

const UTIL_SCHEMAS_18 = [
  {
    name: "image_ops",
    description:
      "Zero-dependency image utility — header inspection and PNG pixel operations. " +
      "Operations: 'info' (format/width/height/channels metadata for PNG/JPEG/GIF/BMP/WEBP, " +
      "header-only, no pixel decode for non-PNG), 'resize' (bilinear interpolation, " +
      "aspect-ratio preserved by default), 'crop' (extract sub-rectangle), " +
      "'rotate' (90/180/270 degrees clockwise, lossless), " +
      "'flip' (mirror horizontal or vertical), " +
      "'grayscale' (ITU-R BT.709 luminance conversion). " +
      "Input: 'path' (file on disk) OR 'data' (base64-encoded image bytes). " +
      "Pixel ops (resize/crop/rotate/flip/grayscale) require PNG input and produce PNG output. " +
      "Output: write to 'output_path' (returns metadata) or return result as base64 in 'data'. " +
      "Max input: 50 MB. Max output: 16000x16000 px / 100 MP. " +
      "Alpha channel is preserved across all pixel operations. " +
      "Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: {
      type: "object",
      required: ["operation"],
      properties: {
        operation: {
          type: "string",
          enum: ["info", "resize", "crop", "rotate", "flip", "grayscale"],
          description:
            "Operation: 'info' (read metadata), 'resize', 'crop', 'rotate', 'flip', 'grayscale'. " +
            "Pixel ops require PNG input and produce PNG output.",
        },
        path: {
          type: "string",
          description: "Source image file path. Provide 'path' or 'data', not both.",
        },
        data: {
          type: "string",
          description: "Source image as base64 string. Provide 'path' or 'data', not both.",
        },
        output_path: {
          type: "string",
          description:
            "[pixel ops] Write output PNG here. If omitted, PNG returned as base64 in 'data'.",
        },
        width: {
          type: "number",
          description: "[resize] Target width px. Omit to derive from height + aspect ratio.",
        },
        height: {
          type: "number",
          description: "[resize] Target height px. Omit to derive from width + aspect ratio.",
        },
        keep_aspect: {
          type: "boolean",
          description:
            "[resize] Maintain aspect ratio (default: true). false = exact width×height (may distort).",
        },
        x: {
          type: "number",
          description: "[crop] Left edge of crop rect in px (default: 0).",
        },
        y: {
          type: "number",
          description: "[crop] Top edge of crop rect in px (default: 0).",
        },
        crop_width: {
          type: "number",
          description: "[crop] Width of crop rect in px (default: source_width - x).",
        },
        crop_height: {
          type: "number",
          description: "[crop] Height of crop rect in px (default: source_height - y).",
        },
        degrees: {
          type: "number",
          description: "[rotate] Clockwise degrees: 0, 90, 180, or 270 (default: 90).",
        },
        axis: {
          type: "string",
          enum: ["horizontal", "vertical"],
          description: "[flip] 'horizontal' (left↔right, default) or 'vertical' (top↔bottom).",
        },
      },
    },
  },
];

module.exports = { UTIL_SCHEMAS_18 };
