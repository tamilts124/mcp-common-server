"use strict";
// utilSchemas68: audio_client

const UTIL_SCHEMAS_68 = [
  {
    name: "audio_client",
    description:
      "Zero-dependency audio metadata reader (pure Node.js; no npm deps). " +
      "Reads audio files without external libraries. " +
      "Operations: info (format/codec/duration/bitrate/sampleRate/channels), " +
      "tags (all metadata tags: title/artist/album/year/genre/…), " +
      "covers (embedded artwork as base64), " +
      "chapters (ID3 CHAP, Nero, OGG, M4A markers), " +
      "validate (structural integrity check). " +
      "Formats: MP3 (ID3v1/ID3v2.2/2.3/2.4), FLAC, OGG Vorbis/Opus, WAV (RIFF INFO+ID3), " +
      "AIFF/AIFF-C, M4A/MP4 (ISO BMFF ilst atoms), WMA/ASF. " +
      "Security: 500 MB file cap; 50 MB per-cover cap; NUL-byte and directory guards.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["info", "tags", "covers", "chapters", "validate"],
          description:
            "info: format, codec, duration, bitrate, sampleRate, channels, counts. " +
            "tags: all metadata tags (title, artist, album, year, genre, track, …). " +
            "covers: embedded artwork — returns list with base64 data by default. " +
            "chapters: chapter markers (ID3 CHAP, Nero, OGG CHAPTER*, M4A chap). " +
            "validate: structural integrity — reports format, tag count, and any issues.",
        },
        path: {
          type: "string",
          description:
            "Absolute path to the audio file (.mp3, .flac, .ogg, .opus, .wav, .aiff, .aif, .m4a, .mp4, .wma).",
        },
        // covers-specific
        include_data: {
          type: "boolean",
          description:
            "[covers] If true (default), include base64-encoded image data in the response. " +
            "Set false to list covers (type, mime, size) without returning the binary data.",
        },
      },
      required: ["operation", "path"],
    },
  },
];

module.exports = { UTIL_SCHEMAS_68 };
