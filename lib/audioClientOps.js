"use strict";
// ── AUDIO_CLIENT ───────────────────────────────────────────────────────────────
// Zero-dependency audio metadata reader (pure Node.js; no npm deps).
//
// Supported formats:
//   MP3  — ID3v1 (footer tag), ID3v2.2/2.3/2.4 (header tag)
//   FLAC — native block-based metadata (STREAMINFO, VORBIS_COMMENT, PICTURE, SEEKTABLE, CUESHEET)
//   OGG  — Vorbis comment + info packets (Vorbis, Opus, FLAC-in-OGG)
//   WAV  — RIFF INFO chunk + fmt sub-chunk
//   AIFF — AIFF/AIFF-C COMM, ANNO, NAME, MARK, (ID3 if present)
//   M4A/MP4 — ISO BMFF box parser (moov/udta/meta/ilst atoms)
//   WMA/ASF — ASF header object parser
//
// Operations:
//   info     — format, duration, bitrate, sampleRate, channels, codec
//   tags     — all metadata tags (title, artist, album, year, genre, track, …)
//   covers   — embedded cover art / artwork (returns base64 or sizes)
//   chapters — chapter markers (ID3 CHAP, Nero chapters, OGG, M4A)
//   validate — structural integrity checks
//
// Security:
//   • 500 MB file cap
//   • 50 MB per-cover cap
//   • NUL-byte guard on path
//   • Directory guard

const fs   = require("fs");
const path = require("path");
const { ToolError } = require("./errors");

// ── Constants ─────────────────────────────────────────────────────────────────
const MAX_AUDIO_BYTES  = 500 * 1024 * 1024;
const MAX_COVER_BYTES  =  50 * 1024 * 1024;
const MAX_TAG_STR      = 4096;
const MAX_TAGS         = 200;

// ── Guard helpers ─────────────────────────────────────────────────────────────
function guardPath(p, op) {
  if (typeof p !== "string" || p.length === 0)
    throw new ToolError(`audio_client ${op}: 'path' must be a non-empty string.`, -32602);
  if (p.indexOf("\0") !== -1)
    throw new ToolError(`audio_client ${op}: path contains a NUL byte.`, -32602);
}

function guardAudioFile(p, op) {
  guardPath(p, op);
  if (!fs.existsSync(p))
    throw new ToolError(`audio_client ${op}: file not found: ${p}`, -32602);
  const stat = fs.statSync(p);
  if (stat.isDirectory())
    throw new ToolError(`audio_client ${op}: '${p}' is a directory, not an audio file.`, -32602);
  if (stat.size > MAX_AUDIO_BYTES)
    throw new ToolError(
      `audio_client ${op}: file too large (${stat.size} bytes > ${MAX_AUDIO_BYTES} limit).`, -32602);
  return stat;
}

function clampStr(s) {
  if (typeof s !== "string") s = String(s);
  return s.slice(0, MAX_TAG_STR);
}

// ── Buffer helpers ────────────────────────────────────────────────────────────
function readU8(buf, off)  { return buf[off]; }
function readU16BE(buf, off) { return (buf[off] << 8) | buf[off + 1]; }
function readU16LE(buf, off) { return (buf[off + 1] << 8) | buf[off]; }
function readU24BE(buf, off) { return (buf[off] << 16) | (buf[off+1] << 8) | buf[off+2]; }
function readU32BE(buf, off) { return ((buf[off]*0x1000000) + (buf[off+1]<<16) + (buf[off+2]<<8) + buf[off+3]) >>> 0; }
function readU32LE(buf, off) { return ((buf[off+3]*0x1000000) + (buf[off+2]<<16) + (buf[off+1]<<8) + buf[off]) >>> 0; }
function readU64BE(buf, off) {
  const hi = readU32BE(buf, off);
  const lo = readU32BE(buf, off + 4);
  return hi * 0x100000000 + lo;
}
function readI16BE(buf, off) { const v = readU16BE(buf, off); return v >= 0x8000 ? v - 0x10000 : v; }
function readSyncsafe(buf, off) {
  return ((buf[off] & 0x7f) << 21) | ((buf[off+1] & 0x7f) << 14) |
         ((buf[off+2] & 0x7f) <<  7) |  (buf[off+3] & 0x7f);
}

function latin1(buf, start, end) {
  let s = "";
  for (let i = start; i < end; i++) s += String.fromCharCode(buf[i]);
  // trim trailing NUL + whitespace
  return s.replace(/\0.*$/, "").trim();
}

function utf16le(buf, start, end) {
  // handle BOM
  let s = start;
  if (end - start >= 2 && buf[s] === 0xFF && buf[s+1] === 0xFE) s += 2;
  let result = "";
  for (let i = s; i + 1 < end; i += 2) {
    const cp = buf[i] | (buf[i+1] << 8);
    if (cp === 0) break;
    result += String.fromCodePoint(cp);
  }
  return result.trim();
}

function utf16be(buf, start, end) {
  let s = start;
  if (end - start >= 2 && buf[s] === 0xFE && buf[s+1] === 0xFF) s += 2;
  let result = "";
  for (let i = s; i + 1 < end; i += 2) {
    const cp = (buf[i] << 8) | buf[i+1];
    if (cp === 0) break;
    result += String.fromCodePoint(cp);
  }
  return result.trim();
}

function decodeStr(buf, start, end, encoding) {
  if (encoding === 1) return utf16le(buf, start, end);
  if (encoding === 2) return utf16be(buf, start, end);
  if (encoding === 3) return buf.slice(start, end).toString("utf8").replace(/\0.*$/, "").trim();
  return latin1(buf, start, end);
}

function nullTermEnd(buf, start, end, wide) {
  const step = wide ? 2 : 1;
  for (let i = start; i < end - (step - 1); i += step) {
    if (wide ? (buf[i] === 0 && buf[i+1] === 0) : buf[i] === 0) return i;
  }
  return end;
}

// ── Format detection ──────────────────────────────────────────────────────────
function detectFormat(buf) {
  if (!buf || buf.length < 4) return "unknown";
  // FLAC
  if (buf[0]===0x66 && buf[1]===0x4C && buf[2]===0x61 && buf[3]===0x43) return "flac";
  // OGG
  if (buf[0]===0x4F && buf[1]===0x67 && buf[2]===0x67 && buf[3]===0x53) return "ogg";
  // RIFF (WAV)
  if (buf[0]===0x52 && buf[1]===0x49 && buf[2]===0x46 && buf[3]===0x46 &&
      buf.length >= 12 && buf[8]===0x57 && buf[9]===0x41 && buf[10]===0x56 && buf[11]===0x45) return "wav";
  // RIFF (AIFF alternative: AIF = FORM)
  if (buf[0]===0x46 && buf[1]===0x4F && buf[2]===0x52 && buf[3]===0x4D) {
    if (buf.length >= 12 && buf[8]===0x41 && buf[9]===0x49 && buf[10]===0x46) return "aiff";
    return "unknown";
  }
  // ID3v2 (MP3)
  if (buf[0]===0x49 && buf[1]===0x44 && buf[2]===0x33) return "mp3";
  // MP3 sync frame (0xFF 0xE? or 0xFF 0xF?)
  if (buf[0]===0xFF && (buf[1]&0xE0)===0xE0) return "mp3";
  // ID3v1 footer at end (handled after reading whole file)
  // ftyp box at offset 4 → MP4/M4A
  if (buf.length >= 8 && buf[4]===0x66 && buf[5]===0x74 && buf[6]===0x79 && buf[7]===0x70) return "mp4";
  // ASF/WMA magic
  if (buf[0]===0x30 && buf[1]===0xA1 && buf[2]===0x6E && buf[3]===0x53 &&
      buf[4]===0xE5 && buf[5]===0x8A && buf[6]===0x06 && buf[7]===0x41) return "wma";
  return "unknown";
}

// ── Genre table for ID3v1 ────────────────────────────────────────────────────
const ID3V1_GENRES = [
  "Blues","Classic Rock","Country","Dance","Disco","Funk","Grunge","Hip-Hop",
  "Jazz","Metal","New Age","Oldies","Other","Pop","R&B","Rap","Reggae","Rock",
  "Techno","Industrial","Alternative","Ska","Death Metal","Pranks","Soundtrack",
  "Euro-Techno","Ambient","Trip-Hop","Vocal","Jazz+Funk","Fusion","Trance",
  "Classical","Instrumental","Acid","House","Game","Sound Clip","Gospel",
  "Noise","AlternRock","Bass","Soul","Punk","Space","Meditative","Instrumental Pop",
  "Instrumental Rock","Ethnic","Gothic","Darkwave","Techno-Industrial","Electronic",
  "Pop-Folk","Eurodance","Dream","Southern Rock","Comedy","Cult","Gangsta Rap",
  "Top 40","Christian Rap","Pop/Funk","Jungle","Native American","Cabaret","New Wave",
  "Psychedelic","Rave","Showtunes","Trailer","Lo-Fi","Tribal","Acid Punk",
  "Acid Jazz","Polka","Retro","Musical","Rock & Roll","Hard Rock",
];

// ── MP3 / ID3 parsing ─────────────────────────────────────────────────────────
const MP3_BITRATES = [
  // MPEG1 layer3 (index 0), MPEG2/2.5 layer3 (index 1)
  [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0],
  [0, 8,16,24,32,40,48,56, 64, 80, 96,112,128,144,160,0],
];
const MP3_SAMPLERATES = [
  [44100,48000,32000,0], // MPEG1
  [22050,24000,16000,0], // MPEG2
  [11025,12000, 8000,0], // MPEG2.5
];

function parseMp3Frame(buf, offset) {
  if (offset + 4 > buf.length) return null;
  const b0 = buf[offset], b1 = buf[offset+1], b2 = buf[offset+2];
  if (b0 !== 0xFF || (b1 & 0xE0) !== 0xE0) return null;
  const layer    = (b1 >> 1) & 0x03; // 01=L3, 10=L2, 11=L1
  const mpegVer  = (b1 >> 3) & 0x03; // 11=MPEG1, 10=MPEG2, 00=MPEG2.5
  const bitrateI = (b2 >> 4) & 0x0F;
  const srateI   = (b2 >> 2) & 0x03;
  const padding  = (b2 >> 1) & 0x01;
  if (layer !== 1) return null; // require Layer III
  const verIdx   = mpegVer === 3 ? 0 : mpegVer === 2 ? 1 : 2;
  const bitrateT = mpegVer === 3 ? 0 : 1;
  const bitrate  = MP3_BITRATES[bitrateT][bitrateI] * 1000;
  const sampleRate = MP3_SAMPLERATES[verIdx][srateI];
  if (!bitrate || !sampleRate) return null;
  const spc        = mpegVer === 3 ? 1152 : 576; // samples per frame
  const frameSize  = Math.floor(spc / 8 * bitrate / sampleRate) + padding;
  return { bitrate, sampleRate, frameSize, mpegVer, layer, offset };
}

function findMp3Frame(buf, startAt) {
  for (let i = startAt; i < Math.min(buf.length - 4, startAt + 131072); i++) {
    if (buf[i] !== 0xFF) continue;
    const f = parseMp3Frame(buf, i);
    if (f) return f;
  }
  return null;
}

function parseId3v2(buf) {
  const tags = {};
  const covers = [];
  const chapters = [];
  if (buf.length < 10 || buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return { tags, covers, chapters, headerSize: 0 };
  const major   = buf[3];
  const minor   = buf[4];
  const flags   = buf[5];
  const totalSize = readSyncsafe(buf, 6) + 10;
  const unsync    = (flags & 0x80) !== 0;
  const extHeader = (flags & 0x40) !== 0;

  let pos = 10;
  if (extHeader) {
    if (major >= 4) pos += readSyncsafe(buf, pos);
    else            pos += readU32BE(buf, pos);
  }

  const isV22 = major === 2;
  const end   = Math.min(totalSize, buf.length);
  let tagCount = 0;

  while (pos < end - (isV22 ? 6 : 10) && tagCount < MAX_TAGS) {
    // Padding
    if (buf[pos] === 0) break;

    let frameId, frameSize, frameFlags = 0;
    if (isV22) {
      frameId   = buf.slice(pos, pos+3).toString("ascii");
      frameSize = readU24BE(buf, pos+3);
      pos += 6;
    } else {
      frameId   = buf.slice(pos, pos+4).toString("ascii");
      frameSize = major >= 4 ? readSyncsafe(buf, pos+4) : readU32BE(buf, pos+4);
      frameFlags = readU16BE(buf, pos+8);
      pos += 10;
    }

    if (frameSize <= 0 || pos + frameSize > end) break;
    const frameEnd = pos + frameSize;
    const fdata    = buf.slice(pos, frameEnd);
    pos = frameEnd;

    // Text frames
    if (frameId[0] === "T" && frameId !== "TXXX") {
      const enc = fdata[0];
      const txt = decodeStr(fdata, 1, fdata.length, enc);
      // Map standard IDs
      const key = {
        TIT2:"title",     TIT1:"contentGroup", TIT3:"subtitle",
        TPE1:"artist",    TPE2:"albumArtist",  TPE3:"conductor", TPE4:"remixedBy",
        TALB:"album",     TRCK:"track",        TPOS:"disc",
        TYER:"year",      TDRC:"year",         TCON:"genre",
        TCOM:"composer",  TEXT:"lyricist",     TENC:"encodedBy",
        TCOP:"copyright", TPUB:"publisher",    TLAN:"language",
        TLEN:"durationMs",TBPM:"bpm",          TMOO:"mood",
        TSRC:"isrc",      TKEY:"initialKey",   TMED:"mediaType",
        TDRL:"releaseDate",TSSE:"encoder",      TSOP:"sortArtist",
        TSOA:"sortAlbum", TSOT:"sortTitle",
        // ID3v2.2 equivalents
        TT2:"title", TP1:"artist", TAL:"album", TYE:"year", TCO:"genre",
        TRK:"track", TCM:"composer", TEN:"encodedBy",
      }[frameId] || frameId;
      // Genre: parse (NN) or (NN)suffix
      if ((frameId === "TCON" || frameId === "TCO") && txt) {
        const m = txt.match(/^\((\d+)\)(.*)$/);
        if (m) {
          const gi = parseInt(m[1], 10);
          tags[key] = (ID3V1_GENRES[gi] || String(gi)) + (m[2] ? " " + m[2].trim() : "");
        } else if (/^\d+$/.test(txt)) {
          tags[key] = ID3V1_GENRES[parseInt(txt, 10)] || txt;
        } else {
          tags[key] = txt;
        }
      } else {
        tags[key] = clampStr(txt);
      }
      tagCount++;
    }
    // TXXX
    else if (frameId === "TXXX") {
      const enc  = fdata[0];
      const wide = enc === 1 || enc === 2;
      const nlE  = nullTermEnd(fdata, 1, fdata.length, wide);
      const desc = decodeStr(fdata, 1, nlE, enc);
      const valStart = nlE + (wide ? 2 : 1);
      const val  = decodeStr(fdata, valStart, fdata.length, enc);
      if (desc) tags[`TXXX:${clampStr(desc)}`] = clampStr(val);
      tagCount++;
    }
    // Comment COMM
    else if (frameId === "COMM" || frameId === "COM") {
      const enc  = fdata[0];
      const lang = latin1(fdata, 1, 4);
      const wide = enc === 1 || enc === 2;
      const nlE  = nullTermEnd(fdata, 4, fdata.length, wide);
      const desc = decodeStr(fdata, 4, nlE, enc);
      const txt  = decodeStr(fdata, nlE + (wide ? 2 : 1), fdata.length, enc);
      const key  = desc ? `comment:${clampStr(desc)}` : "comment";
      tags[key] = clampStr(txt);
      if (lang && lang !== "XXX" && lang !== "   ") tags.language = lang;
      tagCount++;
    }
    // APIC — Attached Picture
    else if (frameId === "APIC" || frameId === "PIC") {
      const enc  = fdata[0];
      let mime, pictureType, dataStart;
      if (isV22) {
        const fmt = latin1(fdata, 1, 4); // 3-char format e.g. JPG, PNG
        mime = fmt === "JPG" ? "image/jpeg" : fmt === "PNG" ? "image/png" : `image/${fmt.toLowerCase()}`;
        pictureType = fdata[4];
        const descEnd = nullTermEnd(fdata, 5, fdata.length, false);
        dataStart = descEnd + 1;
      } else {
        const mimeEnd = nullTermEnd(fdata, 1, fdata.length, false);
        mime = latin1(fdata, 1, mimeEnd);
        pictureType = fdata[mimeEnd + 1];
        const wide = enc === 1 || enc === 2;
        const descStart = mimeEnd + 2;
        const descEnd   = nullTermEnd(fdata, descStart, fdata.length, wide);
        dataStart = descEnd + (wide ? 2 : 1);
      }
      const imgData = fdata.slice(dataStart);
      if (imgData.length > 0 && imgData.length <= MAX_COVER_BYTES) {
        covers.push({ pictureType, mime, sizeBytes: imgData.length, data: imgData });
      }
    }
    // USLT — Unsynchronized lyrics
    else if (frameId === "USLT" || frameId === "ULT") {
      const enc  = fdata[0];
      const lang = latin1(fdata, 1, 4);
      const wide = enc === 1 || enc === 2;
      const descEnd = nullTermEnd(fdata, 4, fdata.length, wide);
      const txt = decodeStr(fdata, descEnd + (wide ? 2 : 1), fdata.length, enc);
      tags.lyrics = clampStr(txt);
      if (lang && lang !== "XXX" && lang !== "   ") tags.language = lang;
      tagCount++;
    }
    // CHAP — Chapter
    else if (frameId === "CHAP") {
      const idEnd = nullTermEnd(fdata, 0, fdata.length, false);
      const elemId = latin1(fdata, 0, idEnd);
      const startMs = readU32BE(fdata, idEnd + 1);
      const endMs   = readU32BE(fdata, idEnd + 5);
      chapters.push({ id: elemId, startMs, endMs });
    }
    // WXXX — URL link
    else if (frameId === "WXXX") {
      const enc  = fdata[0];
      const wide = enc === 1 || enc === 2;
      const descEnd = nullTermEnd(fdata, 1, fdata.length, wide);
      const desc = decodeStr(fdata, 1, descEnd, enc);
      const url  = latin1(fdata, descEnd + (wide ? 2 : 1), fdata.length);
      tags[`url:${clampStr(desc) || "link"}`] = clampStr(url);
      tagCount++;
    }
    // WCOM, WOAR, WOAL, etc.
    else if (frameId[0] === "W" && frameId !== "WXXX") {
      const url = latin1(fdata, 0, fdata.length);
      const key = { WCOM:"commercialUrl", WOAR:"artistUrl", WOAL:"audioSourceUrl",
                    WORS:"radioStationUrl", WPUB:"publisherUrl" }[frameId] || frameId;
      tags[key] = clampStr(url);
      tagCount++;
    }
    // UFID
    else if (frameId === "UFID") {
      const ownerEnd = nullTermEnd(fdata, 0, fdata.length, false);
      const owner = latin1(fdata, 0, ownerEnd);
      if (owner.includes("musicbrainz") || owner.includes("MusicBrainz")) {
        tags.musicbrainzRecordingId = latin1(fdata, ownerEnd + 1, fdata.length);
        tagCount++;
      }
    }
  }

  return { tags, covers, chapters, headerSize: totalSize };
}

function parseId3v1(buf) {
  if (buf.length < 128) return null;
  const off  = buf.length - 128;
  if (buf[off] !== 0x54 || buf[off+1] !== 0x41 || buf[off+2] !== 0x47) return null; // "TAG"
  const tags = {};
  const title   = latin1(buf, off + 3,  off + 33);
  const artist  = latin1(buf, off + 33, off + 63);
  const album   = latin1(buf, off + 63, off + 93);
  const year    = latin1(buf, off + 93, off + 97);
  const comment = latin1(buf, off + 97, off + 127);
  const genre   = buf[off + 127];
  if (title)   tags.title   = clampStr(title);
  if (artist)  tags.artist  = clampStr(artist);
  if (album)   tags.album   = clampStr(album);
  if (year)    tags.year    = clampStr(year);
  if (comment) tags.comment = clampStr(comment);
  // ID3v1.1 track number
  if (buf[off + 125] === 0 && buf[off + 126] !== 0)
    tags.track = String(buf[off + 126]);
  if (genre < 192 && ID3V1_GENRES[genre]) tags.genre = ID3V1_GENRES[genre];
  return tags;
}

function parseMp3Info(buf, id3v2Size) {
  const frame = findMp3Frame(buf, id3v2Size);
  if (!frame) return {};
  // Try to detect VBR via Xing/Info header
  const xingOffset = frame.mpegVer === 3 ? frame.offset + 36 : frame.offset + 21;
  let isVbr = false, totalFrames = 0, totalBytes = 0;
  if (xingOffset + 8 <= buf.length) {
    const hdr = buf.slice(xingOffset, xingOffset + 4).toString("ascii");
    if (hdr === "Xing" || hdr === "Info") {
      isVbr = hdr === "Xing";
      const xflags = readU32BE(buf, xingOffset + 4);
      let xp = xingOffset + 8;
      if (xflags & 1) { totalFrames = readU32BE(buf, xp); xp += 4; }
      if (xflags & 2) { totalBytes  = readU32BE(buf, xp); xp += 4; }
    }
  }
  const spc = frame.mpegVer === 3 ? 1152 : 576;
  let durationMs;
  if (totalFrames > 0 && frame.sampleRate > 0) {
    durationMs = Math.round((totalFrames * spc / frame.sampleRate) * 1000);
  } else if (frame.bitrate > 0) {
    const audioBytes = buf.length - id3v2Size - 128; // subtract ID3v2 and ID3v1
    durationMs = Math.round((audioBytes * 8 / frame.bitrate) * 1000);
  }
  const channels = ((buf[frame.offset+3] >> 6) & 0x03) === 3 ? 1 : 2;
  return {
    codec:       "MP3",
    bitrateKbps: Math.round(frame.bitrate / 1000),
    sampleRate:  frame.sampleRate,
    channels,
    durationMs:  durationMs || null,
    isVbr,
  };
}

// ── FLAC parsing ──────────────────────────────────────────────────────────────
function parseFLAC(buf) {
  const tags = {};
  const covers = [];
  const chapters = [];
  let audioInfo = {};
  const issues = [];

  if (buf.length < 4 || buf.slice(0, 4).toString() !== "fLaC")
    return { tags, covers, chapters, audioInfo, issues };

  let pos = 4;
  while (pos + 4 <= buf.length) {
    const b0       = buf[pos];
    const isLast   = (b0 & 0x80) !== 0;
    const blockType = b0 & 0x7F;
    const blockLen  = readU24BE(buf, pos + 1);
    pos += 4;
    if (pos + blockLen > buf.length) { issues.push("Truncated metadata block"); break; }

    // STREAMINFO
    if (blockType === 0 && blockLen >= 18) {
      const minBlock  = readU16BE(buf, pos);
      const maxBlock  = readU16BE(buf, pos+2);
      const minFrame  = readU24BE(buf, pos+4);
      const maxFrame  = readU24BE(buf, pos+7);
      const tmp       = readU64BE(buf, pos+10); // 64-bit packed value
      const sampleRate = (buf[pos+10] << 12) | (buf[pos+11] << 4) | (buf[pos+12] >> 4);
      const channels   = ((buf[pos+12] >> 1) & 0x07) + 1;
      const bitsDepth  = (((buf[pos+12] & 0x01) << 4) | (buf[pos+13] >> 4)) + 1;
      const totalSamples = ((buf[pos+13] & 0x0F) * 0x100000000) + readU32BE(buf, pos+14);
      const durationMs = sampleRate > 0 ? Math.round(totalSamples / sampleRate * 1000) : null;
      audioInfo = { codec: "FLAC", sampleRate, channels, bitsPerSample: bitsDepth, durationMs };
    }
    // VORBIS_COMMENT
    else if (blockType === 4) {
      const parsed = parseVorbisComment(buf, pos, pos + blockLen);
      Object.assign(tags, parsed.tags);
      chapters.push(...parsed.chapters);
    }
    // PICTURE
    else if (blockType === 6 && blockLen >= 32) {
      const picType  = readU32BE(buf, pos);
      const mimeLen  = readU32BE(buf, pos+4);
      if (mimeLen + 8 <= blockLen) {
        const mime = buf.slice(pos+8, pos+8+mimeLen).toString("ascii");
        const descLen = readU32BE(buf, pos+8+mimeLen);
        const dstart  = pos+12+mimeLen;
        if (dstart + descLen + 20 <= pos + blockLen) {
          const dataLen = readU32BE(buf, dstart + descLen + 16);
          const dataStart = dstart + descLen + 20;
          if (dataStart + dataLen <= pos + blockLen && dataLen <= MAX_COVER_BYTES) {
            const imgData = buf.slice(dataStart, dataStart + dataLen);
            covers.push({ pictureType: picType, mime, sizeBytes: imgData.length, data: imgData });
          }
        }
      }
    }

    pos += blockLen;
    if (isLast) break;
  }
  return { tags, covers, chapters, audioInfo, issues };
}

// ── Vorbis Comment parser (shared by FLAC + OGG) ─────────────────────────────
function parseVorbisComment(buf, start, end) {
  const tags = {};
  const chapters = {}; // chapN.xxx grouping
  let pos = start;

  // Vendor string length (LE 32-bit)
  if (pos + 4 > end) return { tags, chapters: [] };
  const vendorLen = readU32LE(buf, pos); pos += 4;
  pos += vendorLen;
  if (pos + 4 > end) return { tags, chapters: [] };
  const count = readU32LE(buf, pos); pos += 4;

  for (let i = 0; i < count && pos + 4 <= end; i++) {
    const len = readU32LE(buf, pos); pos += 4;
    if (pos + len > end) break;
    const raw = buf.slice(pos, pos + len).toString("utf8");
    pos += len;
    const eq = raw.indexOf("=");
    if (eq === -1) continue;
    const key = raw.slice(0, eq).toLowerCase();
    const val = clampStr(raw.slice(eq + 1));
    // Nero chapter tags: CHAPTER001=HH:MM:SS.mmm  CHAPTER001NAME=...
    const chapM = key.match(/^chapter(\d+)(name|url)?$/);
    if (chapM) {
      const num = chapM[1];
      chapters[num] = chapters[num] || {};
      if (!chapM[2])          chapters[num].time = val;
      else if (chapM[2] === "name") chapters[num].title = val;
      else if (chapM[2] === "url")  chapters[num].url   = val;
    } else {
      // standard Vorbis comment field → normalize
      const normKey = {
        title:"title", artist:"artist", albumartist:"albumArtist",
        album:"album", date:"year", tracknumber:"track",
        discnumber:"disc", genre:"genre", comment:"comment",
        composer:"composer", lyricist:"lyricist", copyright:"copyright",
        description:"description", isrc:"isrc", language:"language",
        bpm:"bpm", replaygain_track_gain:"replaygainTrackGain",
        replaygain_album_gain:"replaygainAlbumGain",
        musicbrainz_trackid:"musicbrainzRecordingId",
        musicbrainz_albumid:"musicbrainzAlbumId",
        lyrics:"lyrics",
      }[key] || key;
      if (key in tags) {
        // Append multi-value
        const existing = tags[normKey];
        tags[normKey] = Array.isArray(existing) ? [...existing, val] : [existing, val];
      } else {
        tags[normKey] = val;
      }
    }
  }

  // Convert Nero chapters map to array
  const chapterArr = Object.entries(chapters)
    .sort(([a],[b]) => Number(a) - Number(b))
    .map(([num, ch]) => ({ num: Number(num), time: ch.time || null, title: ch.title || null, url: ch.url || null }));

  return { tags, chapters: chapterArr };
}

// ── OGG parsing ───────────────────────────────────────────────────────────────
function parseOGG(buf) {
  const tags = {};
  const covers = [];
  const chapters = [];
  let audioInfo = {};
  const issues = [];

  // Collect pages
  let pos = 0;
  const pages = [];
  while (pos + 27 <= buf.length) {
    if (buf[pos] !== 0x4F || buf[pos+1] !== 0x67 || buf[pos+2] !== 0x67 || buf[pos+3] !== 0x53) break;
    const headerType  = buf[pos+5];
    const granulePos  = Number(readU32LE(buf, pos+6)) + Number(readU32LE(buf, pos+10)) * 0x100000000;
    const bitstreamSN = readU32LE(buf, pos+14);
    const seqNum      = readU32LE(buf, pos+18);
    const numSegs     = buf[pos+26];
    if (pos + 27 + numSegs > buf.length) break;
    const segTable = buf.slice(pos+27, pos+27+numSegs);
    let pageBodyLen = 0;
    for (let i = 0; i < numSegs; i++) pageBodyLen += segTable[i];
    const bodyStart = pos + 27 + numSegs;
    if (bodyStart + pageBodyLen > buf.length) break;
    const body = buf.slice(bodyStart, bodyStart + pageBodyLen);
    pages.push({ headerType, granulePos, bitstreamSN, seqNum, body });
    pos = bodyStart + pageBodyLen;
    if (pages.length > 16) break; // only need first few pages for metadata
  }

  if (pages.length === 0) return { tags, covers, chapters, audioInfo, issues };

  // Determine codec from first packet
  const firstBody = pages[0].body;
  let codec = "OGG";
  let sampleRate = 0, channels = 0, durationMs = null, bitrateKbps = null;

  if (firstBody.length >= 7 &&
      firstBody[1]===0x76 && firstBody[2]===0x6F && firstBody[3]===0x72 &&
      firstBody[4]===0x62 && firstBody[5]===0x69 && firstBody[6]===0x73) {
    // Vorbis identification header
    codec      = "Vorbis";
    channels   = firstBody[11];
    sampleRate = readU32LE(firstBody, 12);
    const maxBr = readU32LE(firstBody, 16);
    const nomBr = readU32LE(firstBody, 20);
    bitrateKbps = Math.round((nomBr || maxBr) / 1000);
  } else if (firstBody.length >= 8 &&
      firstBody[0]===0x4F && firstBody[1]===0x70 && firstBody[2]===0x75 &&
      firstBody[3]===0x73 && firstBody[4]===0x48 && firstBody[5]===0x65 &&
      firstBody[6]===0x61 && firstBody[7]===0x64) {
    // Opus
    codec      = "Opus";
    channels   = firstBody[9];
    sampleRate = 48000;
    // original sample rate at offset 12
    const origSR = readU32LE(firstBody, 12);
    if (origSR > 0) sampleRate = origSR;
  } else if (firstBody.length >= 4 &&
      firstBody[0]===0x66 && firstBody[1]===0x4C && firstBody[2]===0x61 && firstBody[3]===0x43) {
    // FLAC-in-OGG
    codec = "FLAC";
  }

  // Parse granule position from the last collected page for duration estimate
  const lastPage = pages[pages.length - 1];
  if (lastPage.granulePos > 0 && sampleRate > 0) {
    durationMs = Math.round(lastPage.granulePos / sampleRate * 1000);
  }

  audioInfo = { codec, sampleRate: sampleRate || null, channels: channels || null,
                bitrateKbps: bitrateKbps || null, durationMs };

  // Find Vorbis comment packet (second logical bitstream packet)
  for (const page of pages) {
    const body = page.body;
    // Vorbis comment packet starts with \x03vorbis
    if (body.length >= 7 &&
        body[0]===0x03 && body[1]===0x76 && body[2]===0x6F && body[3]===0x72 &&
        body[4]===0x62 && body[5]===0x69 && body[6]===0x73) {
      const vc = parseVorbisComment(body, 7, body.length);
      Object.assign(tags, vc.tags);
      chapters.push(...vc.chapters);
    }
    // Opus tags packet starts with OpusTags
    if (body.length >= 8 &&
        body[0]===0x4F && body[1]===0x70 && body[2]===0x75 && body[3]===0x73 &&
        body[4]===0x54 && body[5]===0x61 && body[6]===0x67 && body[7]===0x73) {
      const vc = parseVorbisComment(body, 8, body.length);
      Object.assign(tags, vc.tags);
      chapters.push(...vc.chapters);
    }
  }

  // OGG embedded covers come as METADATA_BLOCK_PICTURE in base64 within vorbis comments
  if (tags.metadata_block_picture) {
    const vals = Array.isArray(tags.metadata_block_picture)
      ? tags.metadata_block_picture : [tags.metadata_block_picture];
    for (const b64 of vals) {
      try {
        const picBuf = Buffer.from(b64, "base64");
        if (picBuf.length < 32) continue;
        const picType = readU32BE(picBuf, 0);
        const mimeLen = readU32BE(picBuf, 4);
        if (mimeLen + 8 > picBuf.length) continue;
        const mime = picBuf.slice(8, 8+mimeLen).toString("ascii");
        const descLen = readU32BE(picBuf, 8+mimeLen);
        const dataOff  = 12 + mimeLen + descLen + 16;
        if (dataOff + 4 > picBuf.length) continue;
        const dataLen = readU32BE(picBuf, 8+mimeLen+4+descLen+16);
        const picData = picBuf.slice(dataOff + 4, dataOff + 4 + dataLen);
        if (picData.length > 0 && picData.length <= MAX_COVER_BYTES)
          covers.push({ pictureType: picType, mime, sizeBytes: picData.length, data: picData });
      } catch {}
    }
    delete tags.metadata_block_picture;
  }

  return { tags, covers, chapters, audioInfo, issues };
}

// ── WAV parsing ───────────────────────────────────────────────────────────────
function parseWAV(buf) {
  const tags = {};
  const covers = [];
  let audioInfo = {};
  const issues = [];

  if (buf.length < 12) return { tags, covers, chapters: [], audioInfo, issues };
  const riffSize = readU32LE(buf, 4);
  let pos = 12;

  while (pos + 8 <= buf.length) {
    const chunkId  = buf.slice(pos, pos+4).toString("ascii");
    const chunkSize = readU32LE(buf, pos+4);
    pos += 8;
    const chunkEnd = pos + chunkSize;
    if (chunkEnd > buf.length) break;

    if (chunkId === "fmt ") {
      const audioFmt  = readU16LE(buf, pos);
      const numCh     = readU16LE(buf, pos+2);
      const sr        = readU32LE(buf, pos+4);
      const byteRate  = readU32LE(buf, pos+8);
      const bitsDepth = chunkSize >= 16 ? readU16LE(buf, pos+14) : 16;
      const codecName = audioFmt === 1 ? "PCM" : audioFmt === 3 ? "IEEE_FLOAT" :
                        audioFmt === 6 ? "ALAW" : audioFmt === 7 ? "ULAW" :
                        audioFmt === 0xFFFE ? "EXTENSIBLE" : `WAV(${audioFmt})`;
      audioInfo = {
        codec: "WAV/" + codecName,
        sampleRate: sr,
        channels: numCh,
        bitsPerSample: bitsDepth,
        bitrateKbps: Math.round(byteRate * 8 / 1000),
      };
    } else if (chunkId === "data") {
      if (audioInfo.bitrateKbps && audioInfo.bitrateKbps > 0) {
        audioInfo.durationMs = Math.round(chunkSize * 8 / (audioInfo.bitrateKbps * 1000) * 1000);
      } else if (audioInfo.sampleRate && audioInfo.channels && audioInfo.bitsPerSample) {
        const bytesPerSample = audioInfo.channels * (audioInfo.bitsPerSample / 8);
        audioInfo.durationMs = bytesPerSample > 0
          ? Math.round(chunkSize / bytesPerSample / audioInfo.sampleRate * 1000) : null;
      }
    } else if (chunkId === "LIST") {
      // INFO sub-chunk
      const listType = buf.slice(pos, pos+4).toString("ascii");
      if (listType === "INFO") {
        let lpos = pos + 4;
        while (lpos + 8 <= chunkEnd) {
          const infoId   = buf.slice(lpos, lpos+4).toString("ascii");
          const infoSize = readU32LE(buf, lpos+4);
          lpos += 8;
          if (lpos + infoSize > chunkEnd) break;
          const val = latin1(buf, lpos, lpos + infoSize);
          const key = {
            INAM:"title", IART:"artist", IPRD:"album", ICRD:"year",
            IGNR:"genre", ICMT:"comment", IENG:"engineer", ISFT:"encoder",
            ICOP:"copyright", ITRK:"track", ISBJ:"subject",
          }[infoId] || infoId.trim();
          if (val) tags[key] = clampStr(val);
          lpos += infoSize + (infoSize % 2); // word-align
        }
      }
    } else if (chunkId === "id3 " || chunkId === "ID3 " || chunkId === "ID3") {
      // Embedded ID3 in WAV
      const id3Buf = buf.slice(pos, chunkEnd);
      const id3    = parseId3v2(id3Buf);
      Object.assign(tags, id3.tags);
      for (const c of id3.covers) covers.push(c);
    }

    pos = chunkEnd + (chunkEnd % 2); // word-align
  }
  return { tags, covers, chapters: [], audioInfo, issues };
}

// ── AIFF parsing ──────────────────────────────────────────────────────────────
function parseAIFF(buf) {
  const tags = {};
  const covers = [];
  let audioInfo = {};
  const issues = [];

  if (buf.length < 12) return { tags, covers, chapters: [], audioInfo, issues };
  const formType = buf.slice(8, 12).toString("ascii"); // AIFF or AIFC
  let pos = 12;

  while (pos + 8 <= buf.length) {
    const chunkId   = buf.slice(pos, pos+4).toString("ascii");
    const chunkSize = readU32BE(buf, pos+4);
    pos += 8;
    const chunkEnd  = pos + chunkSize;
    if (chunkEnd > buf.length) break;

    if (chunkId === "COMM") {
      const numCh    = readI16BE(buf, pos);
      const numFrames= readU32BE(buf, pos+2);
      const bitsDepth= readI16BE(buf, pos+6);
      // 80-bit IEEE 754 extended sample rate
      const exp   = ((buf[pos+8] & 0x7F) << 8) | buf[pos+9];
      const mant  = readU32BE(buf, pos+10);
      const sampleRate = exp > 16383 ? 0 : Math.round(mant * Math.pow(2, exp - 16383 - 31));
      audioInfo = {
        codec:         formType === "AIFC" ? "AIFF-C" : "AIFF",
        sampleRate,
        channels:      numCh,
        bitsPerSample: bitsDepth,
        durationMs:    sampleRate > 0 ? Math.round(numFrames / sampleRate * 1000) : null,
      };
      if (formType === "AIFC" && chunkSize > 22) {
        const compression = buf.slice(pos+18, pos+22).toString("ascii");
        audioInfo.codec = `AIFF-C/${compression.trim()}`;
      }
    } else if (chunkId === "NAME") {
      tags.title = clampStr(buf.slice(pos, chunkEnd).toString("ascii").replace(/\0/g, "").trim());
    } else if (chunkId === "AUTH") {
      tags.artist = clampStr(buf.slice(pos, chunkEnd).toString("ascii").replace(/\0/g, "").trim());
    } else if (chunkId === "(c) ") {
      tags.copyright = clampStr(buf.slice(pos, chunkEnd).toString("ascii").replace(/\0/g, "").trim());
    } else if (chunkId === "ANNO") {
      tags.comment = clampStr(buf.slice(pos, chunkEnd).toString("ascii").replace(/\0/g, "").trim());
    } else if (chunkId === "ID3 " || chunkId === "id3 ") {
      const id3Buf = buf.slice(pos, chunkEnd);
      const id3    = parseId3v2(id3Buf);
      Object.assign(tags, id3.tags);
      for (const c of id3.covers) covers.push(c);
    } else if (chunkId === "MARK") {
      // chapter markers via MARK chunk
    }

    pos = chunkEnd + (chunkSize % 2); // word-align
  }
  return { tags, covers, chapters: [], audioInfo, issues };
}

// ── M4A/MP4 ISO BMFF parsing ─────────────────────────────────────────────────
function readMp4BoxHeader(buf, pos) {
  if (pos + 8 > buf.length) return null;
  let size = readU32BE(buf, pos);
  let headerLen = 8;
  if (size === 1) {
    if (pos + 16 > buf.length) return null;
    size = Number(readU64BE(buf, pos + 8));
    headerLen = 16;
  } else if (size === 0) {
    size = buf.length - pos;
  }
  const type = buf.slice(pos+4, pos+8).toString("ascii");
  return { type, size, headerLen, dataStart: pos + headerLen, dataEnd: pos + size };
}

const M4A_TEXT_ATOMS = {
  "\xa9nam":"title",   "\xa9ART":"artist",  "aART":"albumArtist",
  "\xa9alb":"album",   "\xa9day":"year",     "\xa9gen":"genre",
  "\xa9cmt":"comment", "\xa9lyr":"lyrics",   "\xa9too":"encoder",
  "\xa9wrt":"composer","\xa9grp":"grouping",  "\xa9nam":"title",
  "\xa9mvn":"movement","soal":"sortAlbum",  "soar":"sortArtist",
  "sonm":"sortTitle",   "soco":"sortComposer",
  "desc":"description", "ldes":"longDescription",
  "cprt":"copyright",   "hdvd":"hdVideo",
  "tvsh":"tvShowName",  "tven":"tvEpisodeName",
  "tvsn":"tvSeason",    "tves":"tvEpisode",
};

function parseM4AIlst(buf, start, end, tags, covers) {
  let pos = start;
  while (pos + 8 <= end) {
    const box = readMp4BoxHeader(buf, pos);
    if (!box || box.size < 8) break;
    // Look for data atom inside each ilst item
    let dpos = box.dataStart;
    while (dpos + 8 <= box.dataEnd) {
      const dataBox = readMp4BoxHeader(buf, dpos);
      if (!dataBox || dataBox.type !== "data" || dataBox.size < 16) { dpos++; break; }
      const typeIndicator = readU32BE(buf, dataBox.dataStart);
      // Skip locale (4 bytes)
      const valueStart = dataBox.dataStart + 8;
      const valueEnd   = dataBox.dataEnd;
      const isText     = typeIndicator === 1 || typeIndicator === 4;
      const isCover    = typeIndicator === 13 || typeIndicator === 14; // JPEG or PNG

      const normKey = M4A_TEXT_ATOMS[box.type];
      if (isText && normKey && valueStart < valueEnd) {
        tags[normKey] = clampStr(buf.slice(valueStart, valueEnd).toString("utf8"));
      } else if (box.type === "trkn" && valueStart + 4 <= valueEnd) {
        // Track: 2-byte padding + 2-byte track + optional 2-byte total
        const t = readU16BE(buf, valueStart + 2);
        const tot = valueStart + 6 <= valueEnd ? readU16BE(buf, valueStart + 4) : 0;
        tags.track = tot > 0 ? `${t}/${tot}` : String(t);
      } else if (box.type === "disk" && valueStart + 4 <= valueEnd) {
        const d = readU16BE(buf, valueStart + 2);
        const tot = valueStart + 6 <= valueEnd ? readU16BE(buf, valueStart + 4) : 0;
        tags.disc = tot > 0 ? `${d}/${tot}` : String(d);
      } else if ((box.type === "covr") && isCover) {
        const mime = typeIndicator === 14 ? "image/png" : "image/jpeg";
        const imgData = buf.slice(valueStart, valueEnd);
        if (imgData.length > 0 && imgData.length <= MAX_COVER_BYTES)
          covers.push({ pictureType: 3, mime, sizeBytes: imgData.length, data: imgData });
      } else if (box.type === "gnre" && !isText && valueStart + 2 <= valueEnd) {
        const gi = readU16BE(buf, valueStart) - 1;
        if (gi >= 0 && gi < ID3V1_GENRES.length) tags.genre = ID3V1_GENRES[gi];
      }
      dpos += dataBox.size;
    }
    pos += box.size;
  }
}

function findMp4Box(buf, start, end, ...types) {
  let pos = start;
  while (pos + 8 <= end) {
    const box = readMp4BoxHeader(buf, pos);
    if (!box || box.size < 8) break;
    if (types.includes(box.type)) return box;
    pos += box.size;
  }
  return null;
}

function parseMvhdDuration(buf, pos, end) {
  if (pos >= end) return null;
  const version = buf[pos];
  let timescale, durationUnits;
  if (version === 1) {
    if (pos + 32 > end) return null;
    timescale    = readU32BE(buf, pos + 20);
    durationUnits = Number(readU64BE(buf, pos + 24));
  } else {
    if (pos + 20 > end) return null;
    timescale    = readU32BE(buf, pos + 12);
    durationUnits = readU32BE(buf, pos + 16);
  }
  return timescale > 0 ? Math.round(durationUnits / timescale * 1000) : null;
}

function parseMp4AudioTrack(buf, start, end) {
  // Walk trak → mdia → minf → stbl → stsd → mp4a
  const trakBox = findMp4Box(buf, start, end, "trak");
  if (!trakBox) return {};
  const mdiaBox = findMp4Box(buf, trakBox.dataStart, trakBox.dataEnd, "mdia");
  if (!mdiaBox) return {};
  const hdlrBox = findMp4Box(buf, mdiaBox.dataStart, mdiaBox.dataEnd, "hdlr");
  if (!hdlrBox) return {};
  // handler type at offset 8 in data
  const handler = buf.slice(hdlrBox.dataStart + 8, hdlrBox.dataStart + 12).toString("ascii");
  if (handler !== "soun") {
    // Try next trak
    const nextTrak = findMp4Box(buf, trakBox.dataStart + trakBox.size, end, "trak");
    if (nextTrak) return parseMp4AudioTrack(buf, nextTrak.dataStart - 8, end);
    return {};
  }
  const minfBox = findMp4Box(buf, mdiaBox.dataStart, mdiaBox.dataEnd, "minf");
  if (!minfBox) return {};
  const stblBox = findMp4Box(buf, minfBox.dataStart, minfBox.dataEnd, "stbl");
  if (!stblBox) return {};
  const stsdBox = findMp4Box(buf, stblBox.dataStart, stblBox.dataEnd, "stsd");
  if (!stsdBox) return {};
  // first sample entry is at stsd.dataStart + 8 (skip version+flags + entry count)
  const seStart = stsdBox.dataStart + 8;
  const seBox   = readMp4BoxHeader(buf, seStart);
  if (!seBox) return {};
  const codec = seBox.type === "mp4a" ? "AAC" : seBox.type === "alac" ? "ALAC" :
                seBox.type === "ac-3" ? "AC-3" : seBox.type;
  // AudioSampleEntry: 6 reserved + 2 data ref + 8 reserved + 2 channels + 2 bits + ...
  const aseBase = seBox.dataStart;
  if (aseBase + 20 > seBox.dataEnd) return { codec };
  const channels    = readU16BE(buf, aseBase + 6);
  const bitsPerSamp = readU16BE(buf, aseBase + 8);
  const sampleRate  = readU16BE(buf, aseBase + 12);
  return { codec, channels, bitsPerSample: bitsPerSamp, sampleRate };
}

function parseMP4(buf) {
  const tags = {};
  const covers = [];
  let audioInfo = {};
  const issues = [];

  let pos = 0;
  let mvhdDuration = null;
  let moovBox = null;

  // Top-level scan for moov
  while (pos + 8 <= buf.length) {
    const box = readMp4BoxHeader(buf, pos);
    if (!box || box.size < 8) break;
    if (box.type === "moov") { moovBox = box; break; }
    pos += box.size;
    if (pos >= buf.length) break;
  }

  if (!moovBox) return { tags, covers, chapters: [], audioInfo, issues: ["moov atom not found"] };

  // mvhd for duration
  const mvhdBox = findMp4Box(buf, moovBox.dataStart, moovBox.dataEnd, "mvhd");
  if (mvhdBox) mvhdDuration = parseMvhdDuration(buf, mvhdBox.dataStart, mvhdBox.dataEnd);

  // Audio track info
  const atInfo = parseMp4AudioTrack(buf, moovBox.dataStart, moovBox.dataEnd);
  audioInfo = { ...atInfo, durationMs: mvhdDuration };

  // udta → meta → ilst
  const udtaBox = findMp4Box(buf, moovBox.dataStart, moovBox.dataEnd, "udta");
  if (udtaBox) {
    const metaBox = findMp4Box(buf, udtaBox.dataStart, udtaBox.dataEnd, "meta");
    if (metaBox) {
      // meta has 4 bytes version+flags before children
      const ilstBox = findMp4Box(buf, metaBox.dataStart + 4, metaBox.dataEnd, "ilst");
      if (ilstBox) parseM4AIlst(buf, ilstBox.dataStart, ilstBox.dataEnd, tags, covers);
    }
  }

  // Chapter track: chap reference → tref
  const chapters = [];
  // (simplified: just report if track has chapters; full chapter extraction is complex)

  return { tags, covers, chapters, audioInfo, issues };
}

// ── WMA/ASF parsing ───────────────────────────────────────────────────────────
const ASF_HEADER_GUID     = "3026B2758E66CF11A6D900AA0062CE6C";
const ASF_CONTENT_DESC    = "3326B2758E66CF11A6D900AA0062CE6C";
const ASF_EXTENDED_CONTENT = "40A4D0D207E3D21197F000A0C95EA850";
const ASF_STREAM_PROPS    = "9107DCB7B7A9CF118EE600C00C205365";
const ASF_FILE_PROPS      = "A1DCAB8C47A9CF118EE400C00C205365";

function readAsfGuid(buf, pos) {
  // GUID is 16 bytes, first four parts in LE ordering (Microsoft variant)
  if (pos + 16 > buf.length) return null;
  const p = [];
  // Part 1: uint32 LE
  p.push(buf.slice(pos, pos+4).reverse().toString("hex").toUpperCase());
  // Part 2: uint16 LE
  p.push(buf.slice(pos+4, pos+6).reverse().toString("hex").toUpperCase());
  // Part 3: uint16 LE
  p.push(buf.slice(pos+6, pos+8).reverse().toString("hex").toUpperCase());
  // Part 4+5: big-endian bytes
  p.push(buf.slice(pos+8, pos+10).toString("hex").toUpperCase());
  p.push(buf.slice(pos+10, pos+16).toString("hex").toUpperCase());
  return p.join("");
}

function parseASF(buf) {
  const tags = {};
  const covers = [];
  let audioInfo = {};
  const issues = [];

  const headerGuid = readAsfGuid(buf, 0);
  if (headerGuid !== ASF_HEADER_GUID) {
    issues.push("Invalid ASF header GUID");
    return { tags, covers, chapters: [], audioInfo, issues };
  }
  // Header object size (8 bytes from offset 16)
  const headerSize = Number(readU64BE(buf.slice(16, 24), 0)); // LE actually
  // numHeaders at 24
  // Walk child objects
  let pos = 30; // 16 (guid) + 8 (size LE) + 4 (num headers) + 2 (reserved)

  const readU64LE = (b, off) => Number(readU32LE(b, off)) + Number(readU32LE(b, off+4)) * 0x100000000;

  while (pos + 24 <= Math.min(headerSize, buf.length)) {
    const guid    = readAsfGuid(buf, pos);
    const objSize = readU64LE(buf, pos + 16);
    const objEnd  = pos + objSize;
    if (objSize < 24 || objEnd > buf.length) break;
    pos += 24;

    if (guid === ASF_CONTENT_DESC) {
      // Title, Author, Copyright, Description, Rating — each as UTF-16LE length-prefixed strings
      const fields = ["title","author","copyright","description","rating"];
      let fp = pos;
      const lens = [];
      for (let i = 0; i < 5 && fp + 2 <= objEnd; i++) { lens.push(readU16LE(buf, fp)); fp += 2; }
      for (let i = 0; i < 5 && i < lens.length; i++) {
        const l = lens[i];
        if (fp + l > objEnd) break;
        const val = utf16le(buf, fp, fp + l);
        if (val) tags[fields[i]] = clampStr(val);
        fp += l;
      }
    } else if (guid === ASF_EXTENDED_CONTENT) {
      let ep = pos;
      if (ep + 2 > objEnd) { pos = objEnd; continue; }
      const descCount = readU16LE(buf, ep); ep += 2;
      for (let i = 0; i < descCount && ep + 4 <= objEnd; i++) {
        const nameLen = readU16LE(buf, ep); ep += 2;
        if (ep + nameLen > objEnd) break;
        const name = utf16le(buf, ep, ep + nameLen);
        ep += nameLen;
        if (ep + 4 > objEnd) break;
        const valType = readU16LE(buf, ep); ep += 2;
        const valLen  = readU16LE(buf, ep); ep += 2;
        if (ep + valLen > objEnd) break;
        let val;
        if (valType === 0) val = clampStr(utf16le(buf, ep, ep + valLen));
        else if (valType === 1) val = `[binary:${valLen}]`;
        else if (valType === 2) val = readU32LE(buf, ep) !== 0 ? "true" : "false";
        else if (valType === 3) val = String(readU32LE(buf, ep));
        else if (valType === 4) val = String(readU64LE(buf, ep));
        else if (valType === 5) val = String(readU16LE(buf, ep));
        ep += valLen;
        const normKey = {
          "WM/AlbumTitle":"album", "WM/AlbumArtist":"albumArtist",
          "WM/Genre":"genre",  "WM/TrackNumber":"track",
          "WM/Year":"year",    "WM/Composer":"composer",
          "WM/Lyrics":"lyrics",  "WM/ISRC":"isrc",
          "WM/BeatsPerMinute":"bpm", "WM/Language":"language",
        }[name] || name;
        if (val !== undefined) tags[normKey] = val;
      }
    } else if (guid === ASF_STREAM_PROPS) {
      const streamType = readAsfGuid(buf, pos);
      // Audio stream GUID: F8699E402B4C4C11A8FD00805F5C442B (corrected)
      if (streamType === "F8699E402B4C4C11A8FD00805F5C442B" && pos + 54 <= objEnd) {
        // Wave format at pos+54
        const wfx = pos + 54;
        if (wfx + 18 <= objEnd) {
          const fmtTag  = readU16LE(buf, wfx);
          const numCh   = readU16LE(buf, wfx+2);
          const sr      = readU32LE(buf, wfx+4);
          const byteRate= readU32LE(buf, wfx+8);
          const bits    = readU16LE(buf, wfx+14);
          const codec   = fmtTag === 0x0161 ? "WMA" : fmtTag === 0x0162 ? "WMA Pro" :
                          fmtTag === 0x0163 ? "WMA Lossless" : `ASF(${fmtTag.toString(16)})`;
          audioInfo = {
            codec,
            sampleRate:    sr,
            channels:      numCh,
            bitsPerSample: bits,
            bitrateKbps:   Math.round(byteRate * 8 / 1000),
          };
        }
      }
    } else if (guid === ASF_FILE_PROPS) {
      // Play duration in 100ns units at offset 40; preroll in ms at offset 48
      if (pos + 56 <= objEnd) {
        const durationHns = readU64LE(buf, pos + 40);
        const prerollMs   = readU64LE(buf, pos + 48);
        const durationMs  = Math.round(durationHns / 10000) - prerollMs;
        if (durationMs > 0) audioInfo.durationMs = durationMs;
      }
    }

    pos = objEnd;
  }

  return { tags, covers, chapters: [], audioInfo, issues };
}

// ── Top-level parse ────────────────────────────────────────────────────────────
function parseAudioFile(filePath) {
  const stat = fs.statSync(filePath);
  const buf  = fs.readFileSync(filePath);
  const fmt  = detectFormat(buf);

  // Check ID3v1 at tail even for unknown formats
  const v1tags = parseId3v1(buf);

  let tags = {}, covers = [], chapters = [], audioInfo = {}, issues = [];

  switch (fmt) {
    case "mp3": {
      const id3v2 = parseId3v2(buf);
      const mp3   = parseMp3Info(buf, id3v2.headerSize);
      tags     = id3v2.tags;
      covers   = id3v2.covers;
      chapters = id3v2.chapters;
      audioInfo = mp3;
      // Merge ID3v1 as fallback
      if (v1tags) {
        for (const [k, v] of Object.entries(v1tags))
          if (!(k in tags)) tags[k] = v;
      }
      break;
    }
    case "flac": {
      const r = parseFLAC(buf);
      tags = r.tags; covers = r.covers; chapters = r.chapters;
      audioInfo = r.audioInfo; issues = r.issues;
      break;
    }
    case "ogg": {
      const r = parseOGG(buf);
      tags = r.tags; covers = r.covers; chapters = r.chapters;
      audioInfo = r.audioInfo; issues = r.issues;
      break;
    }
    case "wav": {
      const r = parseWAV(buf);
      tags = r.tags; covers = r.covers;
      audioInfo = r.audioInfo; issues = r.issues;
      break;
    }
    case "aiff": {
      const r = parseAIFF(buf);
      tags = r.tags; covers = r.covers;
      audioInfo = r.audioInfo; issues = r.issues;
      break;
    }
    case "mp4": {
      const r = parseMP4(buf);
      tags = r.tags; covers = r.covers; chapters = r.chapters;
      audioInfo = r.audioInfo; issues = r.issues;
      break;
    }
    case "wma": {
      const r = parseASF(buf);
      tags = r.tags; covers = r.covers;
      audioInfo = r.audioInfo; issues = r.issues;
      break;
    }
    default:
      issues.push("Unrecognized audio format — only limited metadata may be available");
      if (v1tags) tags = v1tags;
  }

  return { fmt, stat, tags, covers, chapters, audioInfo, issues };
}

// ── Picture type descriptions ─────────────────────────────────────────────────
const PICTURE_TYPES = [
  "Other","32x32 icon","Other icon","Cover (front)","Cover (back)",
  "Leaflet page","Media label","Lead artist","Artist","Conductor",
  "Band/Orchestra","Composer","Lyricist","Recording location","During recording",
  "During performance","Screen capture","A bright coloured fish","Illustration",
  "Artist logo","Publisher logo",
];

// ── Operations ────────────────────────────────────────────────────────────────
function opInfo(args) {
  guardAudioFile(args.path, "info");
  const { fmt, stat, audioInfo, covers, chapters, tags, issues } = parseAudioFile(args.path);

  const formatMap = { mp3:"MP3", flac:"FLAC", ogg:"OGG", wav:"WAV",
                      aiff:"AIFF", mp4:"M4A/MP4", wma:"WMA/ASF", unknown:"Unknown" };

  return {
    operation:     "info",
    path:          args.path,
    format:        formatMap[fmt] || fmt,
    codec:         audioInfo.codec || null,
    fileSizeBytes: stat.size,
    durationMs:    audioInfo.durationMs || null,
    durationSec:   audioInfo.durationMs != null ? +(audioInfo.durationMs / 1000).toFixed(3) : null,
    bitrateKbps:   audioInfo.bitrateKbps || null,
    sampleRate:    audioInfo.sampleRate || null,
    channels:      audioInfo.channels || null,
    bitsPerSample: audioInfo.bitsPerSample || null,
    isVbr:         audioInfo.isVbr || false,
    tagCount:      Object.keys(tags).length,
    coverCount:    covers.length,
    chapterCount:  chapters.length,
    issues:        issues.length ? issues : undefined,
  };
}

function opTags(args) {
  guardAudioFile(args.path, "tags");
  const { fmt, tags, audioInfo } = parseAudioFile(args.path);
  return {
    operation:  "tags",
    path:       args.path,
    format:     fmt,
    tagCount:   Object.keys(tags).length,
    tags,
    // Include duration if embedded in tags (e.g. TLEN)
    durationMs: audioInfo.durationMs || null,
  };
}

function opCovers(args) {
  guardAudioFile(args.path, "covers");
  const { fmt, covers } = parseAudioFile(args.path);
  const includeData = args.include_data !== false;
  const result = covers.map((c, i) => {
    const rec = {
      index:       i,
      pictureType: c.pictureType,
      pictureTypeDesc: PICTURE_TYPES[c.pictureType] || "Unknown",
      mime:        c.mime,
      sizeBytes:   c.sizeBytes,
    };
    if (includeData) rec.data = c.data.toString("base64");
    return rec;
  });
  return {
    operation:  "covers",
    path:       args.path,
    format:     fmt,
    coverCount: covers.length,
    covers:     result,
  };
}

function opChapters(args) {
  guardAudioFile(args.path, "chapters");
  const { fmt, chapters } = parseAudioFile(args.path);
  return {
    operation:    "chapters",
    path:         args.path,
    format:       fmt,
    chapterCount: chapters.length,
    chapters,
  };
}

function opValidate(args) {
  guardAudioFile(args.path, "validate");
  const { fmt, audioInfo, tags, covers, chapters, issues } = parseAudioFile(args.path);
  const problems = [...issues];

  if (fmt === "unknown") problems.push("Unrecognized file format");
  if (!audioInfo.sampleRate) problems.push("Could not determine sample rate");
  if (!audioInfo.channels) problems.push("Could not determine channel count");
  if (audioInfo.durationMs != null && audioInfo.durationMs <= 0) problems.push("Non-positive duration");

  return {
    operation: "validate",
    path:      args.path,
    format:    fmt,
    valid:     problems.length === 0,
    problems,
    warnings:  [],
    tagCount:  Object.keys(tags).length,
    hasCover:  covers.length > 0,
    hasChapters: chapters.length > 0,
  };
}

// ── Dispatcher ────────────────────────────────────────────────────────────────
function audioClient(args) {
  if (!args || typeof args.operation !== "string" || args.operation.trim() === "") {
    throw new ToolError(
      "audio_client: 'operation' is required. Valid: info, tags, covers, chapters, validate.",
      -32602);
  }
  const op = args.operation.trim().toLowerCase();
  switch (op) {
    case "info":     return opInfo(args);
    case "tags":     return opTags(args);
    case "covers":   return opCovers(args);
    case "chapters": return opChapters(args);
    case "validate": return opValidate(args);
    default:
      throw new ToolError(
        `audio_client: unknown operation '${op}'. Valid: info, tags, covers, chapters, validate.`,
        -32602);
  }
}

module.exports = { audioClient };
