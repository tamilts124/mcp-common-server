"use strict";
// utilSchemas69: video_client

const UTIL_SCHEMAS_69 = [
  {
    name: "video_client",
    description:
      "Zero-dependency video container reader (pure Node.js; no npm deps). " +
      "Reads video files without external libraries. " +
      "Operations: info (format/container/duration/bitrate/resolution/streams), " +
      "streams (detailed per-track info: codec, dimensions, frame rate, sample rate), " +
      "tags (all metadata tags: title/artist/album/year/genre/…), " +
      "chapters (chapter markers with timestamps and titles), " +
      "validate (structural integrity check). " +
      "Formats: MP4/MOV (ISO BMFF), MKV/WebM (EBML/Matroska), AVI (RIFF). " +
      "Security: 2 GB file cap; NUL-byte and directory guards.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["info", "streams", "tags", "chapters", "validate"],
          description:
            "info: format, container, duration, bitrate, resolution, stream counts, tags. " +
            "streams: detailed per-track list (type, codec, dimensions, frameRate, sampleRate, channels, language). " +
            "tags: all metadata tags (title, artist, album, year, genre, comment, …). " +
            "chapters: chapter markers with index, timeSec, timeHms, and title. " +
            "validate: structural check — reports format, stream counts, duration, and any issues.",
        },
        path: {
          type: "string",
          description:
            "Absolute path to the video file (.mp4, .mov, .m4v, .mkv, .webm, .avi).",
        },
      },
      required: ["operation", "path"],
    },
  },
];

module.exports = { UTIL_SCHEMAS_69 };
