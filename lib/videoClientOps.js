"use strict";
// ── video_client — zero-dependency video container reader ─────────────────────
// Pure Node.js (fs + Buffer); no npm deps.
// Operations: info, streams, tags, chapters, validate
// Formats: MP4/MOV (ISO BMFF), MKV/WebM (EBML/Matroska), AVI (RIFF)
// Security: 2 GB file cap; NUL-byte path guard; directory guard

const fs   = require("fs");
const path = require("path");

// ── Constants ──────────────────────────────────────────────────────────────────
const MAX_FILE_SIZE  = 2 * 1024 * 1024 * 1024; // 2 GB
const MAX_READ_HEAD  = 32 * 1024 * 1024;        // 32 MB header scan
const MAX_TAGS       = 300;
const MAX_STREAMS    = 64;
const MAX_CHAPTERS   = 5000;

// ── Utility ────────────────────────────────────────────────────────────────────
function readBuf(filePath, maxBytes) {
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) throw new Error("video_client: path is a directory.");
  if (stat.size > MAX_FILE_SIZE)
    throw new Error(`video_client: file too large (${stat.size} B; max ${MAX_FILE_SIZE} B).`);
  const readLen = Math.min(stat.size, maxBytes);
  const buf = Buffer.alloc(readLen);
  const fd  = fs.openSync(filePath, "r");
  try { fs.readSync(fd, buf, 0, readLen, 0); }
  finally { fs.closeSync(fd); }
  return { buf, fileSize: stat.size };
}

function detectFormat(buf) {
  // ISO BMFF (MP4/MOV/M4V): first box is ftyp or mdat or free or wide
  if (buf.length >= 8) {
    const boxSize = buf.readUInt32BE(0);
    const boxType = buf.slice(4, 8).toString("latin1");
    const BMFF_BOXES = ["ftyp", "mdat", "moov", "free", "wide", "skip", "pnot"];
    if (BMFF_BOXES.includes(boxType) && boxSize >= 8)
      return "mp4";
    if (boxSize === 0 || (boxSize >= 8 && boxSize <= 64 * 1024 * 1024))
      if (["wide", "mdat", "free"].includes(boxType)) return "mp4";
  }
  // EBML / Matroska / WebM: starts with 0x1A 0x45 0xDF 0xA3
  if (buf.length >= 4 && buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3)
    return "mkv";
  // RIFF AVI: "RIFF" ... "AVI "
  if (buf.length >= 12 &&
      buf.slice(0, 4).toString("latin1") === "RIFF" &&
      buf.slice(8, 12).toString("latin1") === "AVI ")
    return "avi";
  return null;
}

// ── ISO BMFF (MP4 / MOV) parser ──────────────────────────────────────────────
function readU32BE(buf, off) { return buf.readUInt32BE(off); }
function readU64BE(buf, off) {
  const hi = buf.readUInt32BE(off);
  const lo = buf.readUInt32BE(off + 4);
  return hi * 4294967296 + lo;
}

function iterBoxes(buf, offset, limit) {
  const boxes = [];
  let pos = offset;
  while (pos + 8 <= limit) {
    if (pos + 8 > buf.length) break;
    let size = readU32BE(buf, pos);
    const type = buf.slice(pos + 4, pos + 8).toString("latin1");
    let headerLen = 8;
    if (size === 1) {
      if (pos + 16 > buf.length) break;
      size = readU64BE(buf, pos + 8);
      headerLen = 16;
    }
    if (size === 0) size = limit - pos;
    if (size < headerLen || size > limit - pos + 16) break;
    boxes.push({ type, start: pos, size, headerLen });
    pos += size;
  }
  return boxes;
}

function findBox(buf, boxType, offset, limit) {
  return iterBoxes(buf, offset, limit).find(b => b.type === boxType) || null;
}

function readFixedStr(buf, off, len) {
  return buf.slice(off, Math.min(off + len, buf.length)).toString("latin1").replace(/\0.*$/, "");
}

function readUtf8(buf, off, len) {
  return buf.slice(off, Math.min(off + len, buf.length)).toString("utf8").replace(/\0.*$/, "");
}

function readFixed1616(buf, off) {
  const i = buf.readInt16BE(off);
  const f = buf.readUInt16BE(off + 2);
  return i + f / 65536;
}

function parseMp4(buf, fileSize, filePath, operation) {
  const result = { format: "MP4/MOV", container: "ISO BMFF", fileSize };
  const boxes  = iterBoxes(buf, 0, buf.length);

  // ftyp
  const ftyp = boxes.find(b => b.type === "ftyp");
  if (ftyp) {
    const fb = ftyp.start + ftyp.headerLen;
    result.brand = readFixedStr(buf, fb, 4);
    if (buf.length > fb + 4) result.version = readU32BE(buf, fb + 4);
    const compatBrands = [];
    let cbOff = fb + 8;
    while (cbOff + 4 <= ftyp.start + ftyp.size && cbOff + 4 <= buf.length) {
      const cb = readFixedStr(buf, cbOff, 4);
      if (cb && cb !== result.brand) compatBrands.push(cb);
      cbOff += 4;
    }
    result.compatibleBrands = [...new Set(compatBrands)];
  }

  // moov
  const moov = boxes.find(b => b.type === "moov");
  if (!moov) {
    result.warning = "moov box not found in scanned header (may be at end of file).";
    result.duration = null; result.streams = [];
    return result;
  }
  const moovStart = moov.start + moov.headerLen;
  const moovEnd   = moov.start + moov.size;

  // mvhd
  const mvhd = findBox(buf, "mvhd", moovStart, Math.min(moovEnd, buf.length));
  let movieDurationSec = null, movieTimescale = 0;
  if (mvhd) {
    const mb  = mvhd.start + mvhd.headerLen;
    const ver = mb < buf.length ? buf[mb] : -1;
    if (ver === 0 && mb + 18 <= buf.length) {
      movieTimescale   = readU32BE(buf, mb + 12);
      movieDurationSec = movieTimescale > 0 ? readU32BE(buf, mb + 16) / movieTimescale : null;
    } else if (ver === 1 && mb + 28 <= buf.length) {
      movieTimescale   = readU32BE(buf, mb + 20);
      movieDurationSec = movieTimescale > 0 ? readU64BE(buf, mb + 24) / movieTimescale : null;
    }
  }
  result.duration    = movieDurationSec;
  result.durationHms = movieDurationSec != null ? secToHms(movieDurationSec) : null;

  // trak boxes
  const streams   = [];
  const allBoxes  = iterBoxes(buf, moovStart, Math.min(moovEnd, buf.length));
  const trakBoxes = allBoxes.filter(b => b.type === "trak");

  for (const trak of trakBoxes.slice(0, MAX_STREAMS)) {
    const tStart = trak.start + trak.headerLen;
    const tEnd   = trak.start + trak.size;
    const stream = {};

    const tkhd = findBox(buf, "tkhd", tStart, Math.min(tEnd, buf.length));
    if (tkhd) {
      const tb  = tkhd.start + tkhd.headerLen;
      const ver = tb < buf.length ? buf[tb] : -1;
      if (ver === 0 && tb + 24 <= buf.length) {
        stream.trackId  = readU32BE(buf, tb + 12);
        const dur = readU32BE(buf, tb + 20);
        stream.duration = movieTimescale > 0 ? dur / movieTimescale : null;
        if (tb + 44 <= buf.length) {
          const w = readFixed1616(buf, tb + 36);
          const h = readFixed1616(buf, tb + 40);
          if (w > 0 || h > 0) { stream.width = Math.round(w); stream.height = Math.round(h); }
        }
      } else if (ver === 1 && tb + 36 <= buf.length) {
        stream.trackId  = readU32BE(buf, tb + 20);
        const dur = readU64BE(buf, tb + 28);
        stream.duration = movieTimescale > 0 ? dur / movieTimescale : null;
        if (tb + 56 <= buf.length) {
          const w = readFixed1616(buf, tb + 48);
          const h = readFixed1616(buf, tb + 52);
          if (w > 0 || h > 0) { stream.width = Math.round(w); stream.height = Math.round(h); }
        }
      }
    }

    const mdia = findBox(buf, "mdia", tStart, Math.min(tEnd, buf.length));
    if (mdia) {
      const mdStart = mdia.start + mdia.headerLen;
      const mdEnd   = mdia.start + mdia.size;
      const mdhd = findBox(buf, "mdhd", mdStart, Math.min(mdEnd, buf.length));
      if (mdhd) {
        const mb  = mdhd.start + mdhd.headerLen;
        const ver = mb < buf.length ? buf[mb] : -1;
        let ts = 0, lang = "";
        if (ver === 0 && mb + 16 <= buf.length) {
          ts = readU32BE(buf, mb + 12);
          if (mb + 18 <= buf.length) lang = decodeLang15(buf.readUInt16BE(mb + 16));
        } else if (ver === 1 && mb + 28 <= buf.length) {
          ts = readU32BE(buf, mb + 20);
          if (mb + 30 <= buf.length) lang = decodeLang15(buf.readUInt16BE(mb + 28));
        }
        stream.timescale = ts;
        if (lang) stream.language = lang;
      }
      const hdlr = findBox(buf, "hdlr", mdStart, Math.min(mdEnd, buf.length));
      if (hdlr) {
        const hb = hdlr.start + hdlr.headerLen;
        if (hb + 12 <= buf.length) {
          const ht = readFixedStr(buf, hb + 8, 4);
          stream.handlerType = ht;
          stream.type = ht === "vide" ? "video" : ht === "soun" ? "audio" :
                        (ht === "text" || ht === "subt" || ht === "clcp") ? "subtitle" : "other";
          if (hb + 13 <= buf.length)
            stream.handlerName = readUtf8(buf, hb + 12, Math.min(128, buf.length - hb - 12)).replace(/^\0/, "");
        }
      }
      const minf = findBox(buf, "minf", mdStart, Math.min(mdEnd, buf.length));
      if (minf) {
        const stbl = findBox(buf, "stbl", minf.start + minf.headerLen, Math.min(minf.start + minf.size, buf.length));
        if (stbl) {
          const stStart = stbl.start + stbl.headerLen;
          const stsd = findBox(buf, "stsd", stStart, Math.min(stbl.start + stbl.size, buf.length));
          if (stsd) {
            const sb = stsd.start + stsd.headerLen;
            if (sb + 16 <= buf.length && readU32BE(buf, sb + 4) > 0) {
              stream.codec = readFixedStr(buf, sb + 12, 4).trim();
              const entryOff = sb + 8;
              if ((stream.type === "video" || !stream.type) && entryOff + 30 <= buf.length) {
                const vw = buf.readUInt16BE(entryOff + 24);
                const vh = buf.readUInt16BE(entryOff + 26);
                if (vw > 0 && !stream.width)  stream.width  = vw;
                if (vh > 0 && !stream.height) stream.height = vh;
              }
              if (stream.type === "audio" && entryOff + 26 <= buf.length) {
                stream.channels   = buf.readUInt16BE(entryOff + 16);
                stream.sampleSize = buf.readUInt16BE(entryOff + 18);
                stream.sampleRate = readFixed1616(buf, entryOff + 20);
              }
            }
          }
          const stts = findBox(buf, "stts", stStart, Math.min(stbl.start + stbl.size, buf.length));
          if (stts) {
            const sb2 = stts.start + stts.headerLen;
            if (sb2 + 8 <= buf.length) {
              const ec = readU32BE(buf, sb2 + 4);
              let totalSamples = 0, totalDuration = 0;
              for (let i = 0; i < Math.min(ec, 1000) && sb2 + 8 + i * 8 + 8 <= buf.length; i++) {
                totalSamples  += readU32BE(buf, sb2 + 8 + i * 8);
                totalDuration += readU32BE(buf, sb2 + 8 + i * 8) * readU32BE(buf, sb2 + 8 + i * 8 + 4);
              }
              stream.sampleCount = totalSamples;
              if (stream.timescale > 0) {
                stream.durationSec = totalDuration / stream.timescale;
                if (stream.type === "video" && totalSamples > 0 && stream.durationSec > 0)
                  stream.frameRate = +(totalSamples / stream.durationSec).toFixed(4);
                if (stream.type === "audio" && totalSamples > 0 && stream.durationSec > 0 && !stream.sampleRate)
                  stream.sampleRate = +(totalSamples / stream.durationSec).toFixed(0);
              }
            }
          }
        }
      }
    }
    streams.push(stream);
  }

  result.streams    = streams;
  result.videoCount = streams.filter(s => s.type === "video").length;
  result.audioCount = streams.filter(s => s.type === "audio").length;
  result.otherCount = streams.filter(s => s.type !== "video" && s.type !== "audio").length;
  if (movieDurationSec && movieDurationSec > 0)
    result.bitrateKbps = Math.round(fileSize * 8 / movieDurationSec / 1000);

  // tags
  if (operation === "tags" || operation === "info") {
    result.tags = parseMp4Tags(buf, allBoxes, moovStart, Math.min(moovEnd, buf.length));
    result.tagCount = Object.keys(result.tags).length;
  }

  // chapters
  if (operation === "chapters") {
    result.chapters     = parseMp4Chapters(buf, trakBoxes, movieTimescale, buf.length);
    result.chapterCount = result.chapters.length;
  }

  return result;
}

function decodeLang15(val) {
  if (!val || val === 0x7FFF || val === 0) return "";
  const a = ((val >> 10) & 0x1F) + 0x60;
  const b = ((val >>  5) & 0x1F) + 0x60;
  const c = ((val)       & 0x1F) + 0x60;
  if (a < 0x61 || b < 0x61 || c < 0x61) return "";
  return String.fromCharCode(a, b, c);
}

function parseMp4Tags(buf, moovChildren, moovStart, moovEnd) {
  const tags  = {};
  const udta  = moovChildren.find(b => b.type === "udta");
  if (!udta)  return tags;
  const udtaStart = udta.start + udta.headerLen;
  const udtaEnd   = Math.min(udta.start + udta.size, moovEnd, buf.length);
  const meta  = findBox(buf, "meta", udtaStart, udtaEnd);
  if (!meta)  return tags;
  const metaChildStart = meta.start + meta.headerLen + 4; // skip version+flags
  const metaEnd        = Math.min(meta.start + meta.size, udtaEnd, buf.length);
  const ilst  = findBox(buf, "ilst", metaChildStart, metaEnd);
  if (!ilst)  return tags;

  const ILST_MAP = {
    "\xA9nam":"title","\xA9ART":"artist","\xA9alb":"album","\xA9day":"year",
    "\xA9cmt":"comment","\xA9gen":"genre","\xA9too":"encoder","\xA9wrt":"composer",
    "\xA9grp":"grouping","\xA9lyr":"lyrics","trkn":"track","disk":"disc",
    "cpil":"compilation","tmpo":"bpm","rtng":"rating","cprt":"copyright",
    "soal":"sort_album","soar":"sort_artist","sonm":"sort_title","aART":"album_artist",
    "tvsh":"tv_show","tven":"tv_episode_id","tvsn":"tv_season","tves":"tv_episode",
    "desc":"description","ldes":"long_description","catg":"category","keyw":"keyword",
    "hdvd":"hd_video","pgap":"gapless",
  };

  const iStart   = ilst.start + ilst.headerLen;
  const iEnd     = Math.min(ilst.start + ilst.size, metaEnd);
  const children = iterBoxes(buf, iStart, Math.min(iEnd, buf.length));
  let tagCount   = 0;

  for (const child of children) {
    if (tagCount >= MAX_TAGS) break;
    const raw     = buf.slice(child.start + 4, child.start + 8).toString("latin1");
    const tagName = ILST_MAP[raw] || raw.replace(/[^\x20-\x7E]/g, "?");
    const dataBox = findBox(buf, "data", child.start + child.headerLen,
      Math.min(child.start + child.size, iEnd, buf.length));
    if (!dataBox) continue;
    const db = dataBox.start + dataBox.headerLen;
    if (db + 8 > buf.length) continue;
    const typeInd  = readU32BE(buf, db);
    const valueOff = db + 8;
    const valueLen = Math.max(0, (dataBox.start + dataBox.size) - valueOff);
    if (valueLen <= 0 || valueOff + valueLen > buf.length) continue;
    let value;
    if (typeInd === 1 || typeInd === 0x15) {
      value = readUtf8(buf, valueOff, valueLen);
    } else if (typeInd === 0) {
      if ((raw === "trkn" || raw === "disk") && valueLen >= 4) {
        const num = buf.readUInt16BE(valueOff + 2);
        const tot = valueLen >= 6 ? buf.readUInt16BE(valueOff + 4) : 0;
        value = tot > 0 ? `${num}/${tot}` : String(num);
      } else if (raw === "tmpo" && valueLen >= 2) {
        value = String(buf.readUInt16BE(valueOff));
      } else if (["cpil","pgap","hdvd"].includes(raw)) {
        value = String(buf[valueOff] !== 0);
      } else {
        value = buf.slice(valueOff, Math.min(valueOff + 16, valueOff + valueLen)).toString("hex");
      }
    } else if (typeInd === 21) {
      if (valueLen === 1)      value = String(buf.readInt8(valueOff));
      else if (valueLen === 2) value = String(buf.readInt16BE(valueOff));
      else if (valueLen === 4) value = String(buf.readInt32BE(valueOff));
      else value = buf.slice(valueOff, valueOff + valueLen).toString("hex");
    } else {
      value = buf.slice(valueOff, Math.min(valueOff + valueLen, valueOff + 64)).toString("hex");
    }
    if (value !== undefined && value !== "") { tags[tagName] = value; tagCount++; }
  }
  return tags;
}

function parseMp4Chapters(buf, trakBoxes, movieTimescale, bufLen) {
  const chapters = [];
  for (const trak of trakBoxes) {
    const tStart = trak.start + trak.headerLen;
    const tEnd   = trak.start + trak.size;
    const mdia   = findBox(buf, "mdia", tStart, Math.min(tEnd, bufLen));
    if (!mdia) continue;
    const mdStart = mdia.start + mdia.headerLen;
    const mdEnd   = mdia.start + mdia.size;
    const hdlr    = findBox(buf, "hdlr", mdStart, Math.min(mdEnd, bufLen));
    if (!hdlr) continue;
    const hb = hdlr.start + hdlr.headerLen;
    if (hb + 12 > bufLen) continue;
    const ht = readFixedStr(buf, hb + 8, 4);
    if (ht !== "text" && ht !== "tmcd") continue;
    const minf = findBox(buf, "minf", mdStart, Math.min(mdEnd, bufLen));
    if (!minf) continue;
    const stbl = findBox(buf, "stbl", minf.start + minf.headerLen, Math.min(minf.start + minf.size, bufLen));
    if (!stbl)  continue;
    const stts = findBox(buf, "stts", stbl.start + stbl.headerLen, Math.min(stbl.start + stbl.size, bufLen));
    if (!stts)  continue;
    const sb = stts.start + stts.headerLen;
    if (sb + 8 > bufLen) continue;
    const mdhd = findBox(buf, "mdhd", mdStart, Math.min(mdEnd, bufLen));
    let ts = movieTimescale;
    if (mdhd) {
      const mb  = mdhd.start + mdhd.headerLen;
      const ver = mb < bufLen ? buf[mb] : 0;
      if (ver === 0 && mb + 16 <= bufLen)      ts = readU32BE(buf, mb + 12);
      else if (ver === 1 && mb + 24 <= bufLen) ts = readU32BE(buf, mb + 20);
    }
    const ec = readU32BE(buf, sb + 4);
    let time = 0;
    for (let i = 0; i < Math.min(ec, MAX_CHAPTERS) && sb + 8 + i * 8 + 8 <= bufLen; i++) {
      const sc = readU32BE(buf, sb + 8 + i * 8);
      const sd = readU32BE(buf, sb + 8 + i * 8 + 4);
      chapters.push({ index: i, timeSec: ts > 0 ? +(time / ts).toFixed(3) : null, timeHms: ts > 0 ? secToHms(time / ts) : null });
      time += sc * sd;
    }
    if (chapters.length > 0) break;
  }
  return chapters;
}

// ── EBML / Matroska / WebM parser ────────────────────────────────────────────
function readVint(buf, pos) {
  if (pos >= buf.length) return { value: -1, len: 1 };
  const b0 = buf[pos];
  if (b0 & 0x80) return { value: b0 & 0x7F, len: 1 };
  if (b0 & 0x40) {
    if (pos + 1 >= buf.length) return { value: -1, len: 2 };
    return { value: ((b0 & 0x3F) << 8) | buf[pos + 1], len: 2 };
  }
  if (b0 & 0x20) {
    if (pos + 2 >= buf.length) return { value: -1, len: 3 };
    return { value: ((b0 & 0x1F) << 16) | (buf[pos + 1] << 8) | buf[pos + 2], len: 3 };
  }
  if (b0 & 0x10) {
    if (pos + 3 >= buf.length) return { value: -1, len: 4 };
    return { value: ((b0 & 0x0F) << 24) | (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3], len: 4 };
  }
  if (b0 & 0x08) {
    if (pos + 4 >= buf.length) return { value: -1, len: 5 };
    return { value: (b0 & 0x07) * 4294967296 + buf.readUInt32BE(pos + 1), len: 5 };
  }
  return { value: -1, len: 1 };
}

function readEbmlId(buf, pos) {
  if (pos >= buf.length) return { id: -1, len: 1 };
  const b0 = buf[pos];
  if (b0 & 0x80) return { id: b0, len: 1 };
  if (b0 & 0x40) {
    if (pos + 1 >= buf.length) return { id: -1, len: 2 };
    return { id: (b0 << 8) | buf[pos + 1], len: 2 };
  }
  if (b0 & 0x20) {
    if (pos + 2 >= buf.length) return { id: -1, len: 3 };
    return { id: (b0 << 16) | (buf[pos + 1] << 8) | buf[pos + 2], len: 3 };
  }
  if (b0 & 0x10) {
    if (pos + 3 >= buf.length) return { id: -1, len: 4 };
    return { id: (b0 << 24) | (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3], len: 4 };
  }
  return { id: -1, len: 1 };
}

function ebmlUint(buf, pos, len) {
  if (len === 0) return 0;
  let v = 0;
  for (let i = 0; i < Math.min(len, 8) && pos + i < buf.length; i++) v = v * 256 + buf[pos + i];
  return v;
}
function ebmlFloat(buf, pos, len) {
  if (len === 4 && pos + 4 <= buf.length) return buf.readFloatBE(pos);
  if (len === 8 && pos + 8 <= buf.length) return buf.readDoubleBE(pos);
  return null;
}
function ebmlStr(buf, pos, len) {
  return buf.slice(pos, Math.min(pos + len, buf.length)).toString("utf8").replace(/\0.*$/, "");
}

const EID = {
  EBML_HDR:0x1A45DFA3, SEGMENT:0x18538067, INFO:0x1549A966, TRACKS:0x1654AE6B,
  CHAPTERS:0x1043A770, TAGS_EL:0x1254C367, TRACK_ENTRY:0xAE, TRACK_NUM:0xD7,
  TRACK_TYPE:0x83, TRACK_NAME:0x536E, CODEC_ID:0x86, CODEC_NAME:0x258688,
  LANG:0x22B59C, LANG_IETF:0x22B59D, DEFAULT_DUR:0x23E383, PIXEL_W:0xB0,
  PIXEL_H:0xBA, VIDEO_EL:0xE0, AUDIO_EL:0xE1, SAMPLERATE:0xB5, CHANNELS:0x9F,
  BITDEPTH:0x6264, DURATION:0x4489, TIMECODE_SC:0x2AD7B1, TITLE:0x7BA9,
  MUXING_APP:0x4D80, WRITING_APP:0x5741, DOC_TYPE:0x4282,
  EDITION_ENTRY:0x45B9, CHAPTER_ATOM:0xB6, CHAP_TS:0x91,
  CHAP_DISPLAY:0x80, CHAP_STRING:0x85,
  TAG_EL:0x7373, SIMPLE_TAG:0x67C8, TAG_NAME:0x45A3, TAG_STRING:0x4487,
};

function iterEbml(buf, pos, endPos) {
  const elems = [];
  let p = pos;
  while (p < endPos && p < buf.length) {
    const { id, len: idLen } = readEbmlId(buf, p);
    if (id === -1 || p + idLen >= buf.length) break;
    p += idLen;
    const { value: dataLen, len: szLen } = readVint(buf, p);
    if (dataLen === -1 || p + szLen > buf.length) break;
    p += szLen;
    const unknownSz = (dataLen === 0x7F || dataLen === 0x3FFF || dataLen === 0x1FFFFF ||
                       dataLen === 0x0FFFFFFF || dataLen === 0x07FFFFFFFF);
    if (unknownSz) break;
    elems.push({ id, dataStart: p, dataLen });
    p += dataLen;
  }
  return elems;
}

function findEbml(buf, pos, endPos, id) {
  return iterEbml(buf, pos, endPos).find(e => e.id === id) || null;
}

function parseMkv(buf, fileSize, filePath, operation) {
  const result = { format: "MKV/WebM", container: "Matroska/WebM (EBML)", fileSize };
  const elems0 = iterEbml(buf, 0, buf.length);

  const ebmlEl = elems0.find(e => e.id === EID.EBML_HDR);
  if (ebmlEl) {
    const hdElems = iterEbml(buf, ebmlEl.dataStart, Math.min(ebmlEl.dataStart + ebmlEl.dataLen, buf.length));
    const dtEl    = hdElems.find(e => e.id === EID.DOC_TYPE);
    if (dtEl) {
      result.docType = ebmlStr(buf, dtEl.dataStart, dtEl.dataLen);
      result.format  = result.docType === "webm" ? "WebM" : "MKV";
    }
  }

  const segEl = elems0.find(e => e.id === EID.SEGMENT);
  if (!segEl) { result.warning = "SEGMENT element not found in scanned header."; return result; }

  const segStart = segEl.dataStart;
  const segEnd   = Math.min(segEl.dataStart + segEl.dataLen, buf.length);
  const segElems = iterEbml(buf, segStart, segEnd);

  // INFO
  const infoEl = segElems.find(e => e.id === EID.INFO);
  let timecodeScale = 1000000;
  if (infoEl) {
    const ie  = iterEbml(buf, infoEl.dataStart, Math.min(infoEl.dataStart + infoEl.dataLen, segEnd));
    const tcEl = ie.find(e => e.id === EID.TIMECODE_SC);
    if (tcEl) timecodeScale = ebmlUint(buf, tcEl.dataStart, tcEl.dataLen);
    const durEl = ie.find(e => e.id === EID.DURATION);
    if (durEl) {
      const rawDur = ebmlFloat(buf, durEl.dataStart, durEl.dataLen);
      result.duration    = rawDur != null ? rawDur * timecodeScale / 1e9 : null;
      result.durationHms = result.duration != null ? secToHms(result.duration) : null;
    }
    const titleEl  = ie.find(e => e.id === EID.TITLE);
    if (titleEl)   result.title = ebmlStr(buf, titleEl.dataStart, titleEl.dataLen);
    const muxEl    = ie.find(e => e.id === EID.MUXING_APP);
    if (muxEl)     result.muxingApp = ebmlStr(buf, muxEl.dataStart, muxEl.dataLen);
    const wrtEl    = ie.find(e => e.id === EID.WRITING_APP);
    if (wrtEl)     result.writingApp = ebmlStr(buf, wrtEl.dataStart, wrtEl.dataLen);
  }
  if (result.duration && result.duration > 0)
    result.bitrateKbps = Math.round(fileSize * 8 / result.duration / 1000);

  // TRACKS
  const tracksEl = segElems.find(e => e.id === EID.TRACKS);
  const streams  = [];
  if (tracksEl) {
    const trackElems = iterEbml(buf, tracksEl.dataStart, Math.min(tracksEl.dataStart + tracksEl.dataLen, segEnd));
    for (const te of trackElems.filter(e => e.id === EID.TRACK_ENTRY).slice(0, MAX_STREAMS)) {
      const stream  = {};
      const teElems = iterEbml(buf, te.dataStart, Math.min(te.dataStart + te.dataLen, segEnd));
      const fi = id => teElems.find(e => e.id === id);

      const numEl = fi(EID.TRACK_NUM);   if (numEl)   stream.trackId = ebmlUint(buf, numEl.dataStart, numEl.dataLen);
      const typeEl= fi(EID.TRACK_TYPE);  if (typeEl)  { const t=ebmlUint(buf,typeEl.dataStart,typeEl.dataLen); stream.type=t===1?"video":t===2?"audio":t===17?"subtitle":"other"; }
      const nameEl= fi(EID.TRACK_NAME);  if (nameEl)  stream.name=ebmlStr(buf,nameEl.dataStart,nameEl.dataLen);
      const codEl = fi(EID.CODEC_ID);    if (codEl)   stream.codec=ebmlStr(buf,codEl.dataStart,codEl.dataLen);
      const cnEl  = fi(EID.CODEC_NAME);  if (cnEl)    stream.codecName=ebmlStr(buf,cnEl.dataStart,cnEl.dataLen);
      const langEl= fi(EID.LANG_IETF)||fi(EID.LANG); if (langEl) stream.language=ebmlStr(buf,langEl.dataStart,langEl.dataLen);
      const ddEl  = fi(EID.DEFAULT_DUR); if (ddEl)    { const dd=ebmlUint(buf,ddEl.dataStart,ddEl.dataLen); if(dd>0) stream.defaultDurationNs=dd; }

      const vidEl = fi(EID.VIDEO_EL);
      if (vidEl) {
        const ve = iterEbml(buf, vidEl.dataStart, Math.min(vidEl.dataStart + vidEl.dataLen, segEnd));
        const pw = ve.find(e=>e.id===EID.PIXEL_W); if(pw) stream.width  = ebmlUint(buf,pw.dataStart,pw.dataLen);
        const ph = ve.find(e=>e.id===EID.PIXEL_H); if(ph) stream.height = ebmlUint(buf,ph.dataStart,ph.dataLen);
        if (stream.defaultDurationNs && stream.defaultDurationNs > 0)
          stream.frameRate = +(1e9 / stream.defaultDurationNs).toFixed(4);
      }
      const audEl = fi(EID.AUDIO_EL);
      if (audEl) {
        const ae = iterEbml(buf, audEl.dataStart, Math.min(audEl.dataStart + audEl.dataLen, segEnd));
        const sr = ae.find(e=>e.id===EID.SAMPLERATE); if(sr) stream.sampleRate=ebmlFloat(buf,sr.dataStart,sr.dataLen)||ebmlUint(buf,sr.dataStart,sr.dataLen);
        const ch = ae.find(e=>e.id===EID.CHANNELS);   if(ch) stream.channels=ebmlUint(buf,ch.dataStart,ch.dataLen);
        const bd = ae.find(e=>e.id===EID.BITDEPTH);   if(bd) stream.bitDepth=ebmlUint(buf,bd.dataStart,bd.dataLen);
      }
      streams.push(stream);
    }
  }
  result.streams    = streams;
  result.videoCount = streams.filter(s=>s.type==="video").length;
  result.audioCount = streams.filter(s=>s.type==="audio").length;
  result.otherCount = streams.filter(s=>s.type!=="video"&&s.type!=="audio").length;

  // Tags
  if (operation === "tags" || operation === "info") {
    const tags  = {};
    const tagsEl = segElems.find(e=>e.id===EID.TAGS_EL);
    if (tagsEl) {
      const tagElems = iterEbml(buf, tagsEl.dataStart, Math.min(tagsEl.dataStart+tagsEl.dataLen, segEnd));
      for (const tagEl of tagElems.filter(e=>e.id===EID.TAG_EL)) {
        const tEl = iterEbml(buf, tagEl.dataStart, Math.min(tagEl.dataStart+tagEl.dataLen, segEnd));
        for (const st of tEl.filter(e=>e.id===EID.SIMPLE_TAG)) {
          const se  = iterEbml(buf, st.dataStart, Math.min(st.dataStart+st.dataLen, segEnd));
          const tn  = se.find(e=>e.id===EID.TAG_NAME);
          const tv  = se.find(e=>e.id===EID.TAG_STRING);
          if (tn&&tv) { const k=ebmlStr(buf,tn.dataStart,tn.dataLen).toLowerCase(); const v=ebmlStr(buf,tv.dataStart,tv.dataLen); if(k&&v) tags[k]=v; }
        }
      }
    }
    if (result.title) tags.title = result.title;
    result.tags     = tags;
    result.tagCount = Object.keys(tags).length;
  }

  // Chapters
  if (operation === "chapters") {
    const chapters = [];
    const chapEl   = segElems.find(e=>e.id===EID.CHAPTERS);
    if (chapEl) {
      const edElems = iterEbml(buf, chapEl.dataStart, Math.min(chapEl.dataStart+chapEl.dataLen, segEnd));
      for (const ed of edElems.filter(e=>e.id===EID.EDITION_ENTRY)) {
        const atomElems = iterEbml(buf, ed.dataStart, Math.min(ed.dataStart+ed.dataLen, segEnd));
        for (const atom of atomElems.filter(e=>e.id===EID.CHAPTER_ATOM)) {
          if (chapters.length >= MAX_CHAPTERS) break;
          const ae  = iterEbml(buf, atom.dataStart, Math.min(atom.dataStart+atom.dataLen, segEnd));
          const tsEl= ae.find(e=>e.id===EID.CHAP_TS);
          const dispEl=ae.find(e=>e.id===EID.CHAP_DISPLAY);
          let title = "";
          if (dispEl) {
            const de = iterEbml(buf, dispEl.dataStart, Math.min(dispEl.dataStart+dispEl.dataLen, segEnd));
            const cs = de.find(e=>e.id===EID.CHAP_STRING); if(cs) title=ebmlStr(buf,cs.dataStart,cs.dataLen);
          }
          const ts  = tsEl ? ebmlUint(buf, tsEl.dataStart, tsEl.dataLen) : null;
          const sec = ts != null ? ts / 1e9 : null;
          chapters.push({ index: chapters.length, timeSec: sec, timeHms: sec!=null?secToHms(sec):null, title: title||undefined });
        }
        if (chapters.length > 0) break;
      }
    }
    result.chapters     = chapters;
    result.chapterCount = chapters.length;
  }
  return result;
}

// ── AVI (RIFF) parser ─────────────────────────────────────────────────────────
function iterRiff(buf, pos, endPos) {
  const chunks = [];
  let p = pos;
  while (p + 8 <= endPos && p + 8 <= buf.length) {
    const fourcc = buf.slice(p, p + 4).toString("latin1");
    const size   = buf.readUInt32LE(p + 4);
    chunks.push({ fourcc, dataStart: p + 8, size });
    p += 8 + size + (size & 1);
    if (size === 0) break;
  }
  return chunks;
}

function findRiff(buf, pos, endPos, target) {
  return iterRiff(buf, pos, endPos).find(c => c.fourcc === target) || null;
}

function parseAvi(buf, fileSize, operation) {
  const result = { format: "AVI", container: "RIFF AVI", fileSize };
  const riffSize = buf.readUInt32LE(4);
  const listEnd  = Math.min(8 + riffSize, buf.length);
  const chunks   = iterRiff(buf, 12, listEnd);

  const hdrl = chunks.find(c => c.fourcc === "LIST" &&
    c.dataStart + 4 <= buf.length &&
    buf.slice(c.dataStart, c.dataStart + 4).toString("latin1") === "hdrl");

  if (!hdrl) { result.warning = "hdrl LIST not found."; return result; }
  const hdStart = hdrl.dataStart + 4;
  const hdEnd   = hdrl.dataStart + hdrl.size;

  const avih = findRiff(buf, hdStart, Math.min(hdEnd, buf.length), "avih");
  if (avih) {
    const ab = avih.dataStart;
    if (ab + 40 <= buf.length) {
      const mpf = buf.readUInt32LE(ab);     // microseconds per frame
      const mbs = buf.readUInt32LE(ab + 4); // max bytes per sec
      const flg = buf.readUInt32LE(ab + 12);
      const tf  = buf.readUInt32LE(ab + 16);
      const w   = buf.readUInt32LE(ab + 32);
      const h   = buf.readUInt32LE(ab + 36);
      result.width  = w; result.height = h;
      if (mpf > 0) {
        const fps = 1e6 / mpf;
        result.frameRate = +fps.toFixed(4);
        if (tf > 0) { result.duration = +(tf / fps).toFixed(3); result.durationHms = secToHms(result.duration); }
      }
      result.maxBytesPerSec = mbs;
      result.hasIndex       = !!(flg & 0x10);
      result.isInterleaved  = !!(flg & 0x100);
    }
  }

  const strlChunks = iterRiff(buf, hdStart, Math.min(hdEnd, buf.length))
    .filter(c => c.fourcc === "LIST" && c.dataStart + 4 <= buf.length &&
      buf.slice(c.dataStart, c.dataStart + 4).toString("latin1") === "strl");

  const streams = [];
  for (const strl of strlChunks.slice(0, MAX_STREAMS)) {
    const sStart = strl.dataStart + 4;
    const sEnd   = strl.dataStart + strl.size;
    const stream = {};
    const strh   = findRiff(buf, sStart, Math.min(sEnd, buf.length), "strh");
    const strf   = findRiff(buf, sStart, Math.min(sEnd, buf.length), "strf");
    if (strh) {
      const sb = strh.dataStart;
      if (sb + 8 <= buf.length) {
        const ft = buf.slice(sb, sb + 4).toString("latin1");
        const fh = buf.slice(sb + 4, sb + 8).toString("latin1");
        stream.type  = ft === "vids" ? "video" : ft === "auds" ? "audio" : ft === "txts" ? "subtitle" : "other";
        stream.codec = fh.trim();
        if (sb + 36 <= buf.length) {
          const scale = buf.readUInt32LE(sb + 20), rate = buf.readUInt32LE(sb + 24), len = buf.readUInt32LE(sb + 32);
          if (scale > 0 && rate > 0) {
            if (stream.type === "video") stream.frameRate = +(rate / scale).toFixed(4);
            if (stream.type === "audio") stream.sampleRate = rate;
            if (len > 0) { stream.frameCount = len; stream.durationSec = +(len * scale / rate).toFixed(3); }
          }
        }
      }
    }
    if (strf) {
      const sb = strf.dataStart;
      if (stream.type === "video" && sb + 20 <= buf.length) {
        stream.width  = buf.readUInt32LE(sb + 4);
        stream.height = Math.abs(buf.readInt32LE(sb + 8));
        stream.bitCount = buf.readUInt16LE(sb + 14);
        if (sb + 20 <= buf.length) { const fc = buf.slice(sb + 16, sb + 20).toString("latin1").trim(); if (fc) stream.fourCC = fc; }
      }
      if (stream.type === "audio" && sb + 16 <= buf.length) {
        stream.formatTag  = buf.readUInt16LE(sb);
        stream.channels   = buf.readUInt16LE(sb + 2);
        stream.sampleRate = buf.readUInt32LE(sb + 4);
        stream.bitRate    = buf.readUInt32LE(sb + 8) * 8;
        stream.bitDepth   = sb + 16 <= buf.length ? buf.readUInt16LE(sb + 14) : undefined;
      }
    }
    const strn = findRiff(buf, sStart, Math.min(sEnd, buf.length), "strn");
    if (strn) stream.name = readUtf8(buf, strn.dataStart, strn.size).replace(/\0$/, "");
    streams.push(stream);
  }
  result.streams    = streams;
  result.videoCount = streams.filter(s=>s.type==="video").length;
  result.audioCount = streams.filter(s=>s.type==="audio").length;
  result.otherCount = streams.filter(s=>s.type!=="video"&&s.type!=="audio").length;

  // INFO tags
  if (operation === "tags" || operation === "info") {
    const tags = {};
    const infoList = chunks.find(c => c.fourcc === "LIST" && c.dataStart + 4 <= buf.length &&
      buf.slice(c.dataStart, c.dataStart + 4).toString("latin1") === "INFO");
    if (infoList) {
      const IM = { INAM:"title",IART:"artist",IALB:"album",ICRD:"date",ICMT:"comment",
                   IGNR:"genre",ITRK:"track",IPRD:"product",ISFT:"software",
                   ICOP:"copyright",IENG:"engineer",ISBJ:"subject",ISRC:"source",IKEY:"keywords" };
      const ic = iterRiff(buf, infoList.dataStart + 4, Math.min(infoList.dataStart + infoList.size, buf.length));
      for (const c of ic) {
        const v = readUtf8(buf, c.dataStart, c.size).replace(/\0$/, "");
        if (v) tags[IM[c.fourcc] || c.fourcc] = v;
      }
    }
    result.tags = tags; result.tagCount = Object.keys(tags).length;
  }
  if (operation === "chapters") {
    result.chapters = []; result.chapterCount = 0;
    result.note = "AVI format does not have a standard chapter structure.";
  }
  return result;
}

// ── Shared helpers ─────────────────────────────────────────────────────────────
function secToHms(sec) {
  if (sec == null || isNaN(sec)) return null;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = (sec % 60).toFixed(3);
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(6,"0")}`;
}

// ── Main export ────────────────────────────────────────────────────────────────
function videoClient(args) {
  const { operation, path: filePath } = args;
  if (!operation) throw new Error("video_client: 'operation' is required.");
  if (!filePath)  throw new Error("video_client: 'path' is required.");
  const VALID_OPS = ["info", "streams", "tags", "chapters", "validate"];
  if (!VALID_OPS.includes(operation))
    throw new Error(`video_client: unknown operation '${operation}'. Valid: ${VALID_OPS.join(", ")}.`);
  if (filePath.includes("\0")) throw new Error("video_client: path contains NUL byte.");

  const { buf, fileSize } = readBuf(filePath, MAX_READ_HEAD);
  const format = detectFormat(buf);
  if (!format)
    throw new Error(`video_client: unrecognized video format for '${path.basename(filePath)}'. Supported: MP4/MOV, MKV/WebM, AVI.`);

  let parsed;
  if (format === "mp4")      parsed = parseMp4(buf, fileSize, filePath, operation);
  else if (format === "mkv") parsed = parseMkv(buf, fileSize, filePath, operation);
  else                       parsed = parseAvi(buf, fileSize, operation);

  const base = { path: filePath, operation, format: parsed.format, container: parsed.container, fileSize: parsed.fileSize };

  if (operation === "info") {
    return {
      ...base,
      brand: parsed.brand, compatibleBrands: parsed.compatibleBrands, docType: parsed.docType,
      duration: parsed.duration, durationHms: parsed.durationHms, bitrateKbps: parsed.bitrateKbps,
      width: parsed.width, height: parsed.height, frameRate: parsed.frameRate,
      videoCount: parsed.videoCount, audioCount: parsed.audioCount, otherCount: parsed.otherCount,
      streamCount: (parsed.videoCount||0) + (parsed.audioCount||0) + (parsed.otherCount||0),
      tags: parsed.tags, tagCount: parsed.tagCount,
      muxingApp: parsed.muxingApp, writingApp: parsed.writingApp, warning: parsed.warning,
    };
  }
  if (operation === "streams") {
    return { ...base, duration: parsed.duration, durationHms: parsed.durationHms,
      videoCount: parsed.videoCount, audioCount: parsed.audioCount, otherCount: parsed.otherCount,
      streams: parsed.streams || [] };
  }
  if (operation === "tags") {
    return { ...base, tags: parsed.tags || {}, tagCount: parsed.tagCount || 0 };
  }
  if (operation === "chapters") {
    return { ...base, chapterCount: parsed.chapterCount || 0, chapters: parsed.chapters || [], note: parsed.note };
  }
  if (operation === "validate") {
    const issues = [];
    if (parsed.warning) issues.push(parsed.warning);
    const streams = parsed.streams || [];
    if (streams.length === 0)  issues.push("No streams found in header scan.");
    const hasV = streams.some(s => s.type === "video");
    const hasA = streams.some(s => s.type === "audio");
    if (!hasV && !hasA) issues.push("No video or audio streams detected.");
    else if (!hasV)     issues.push("No video stream detected.");
    else if (!hasA)     issues.push("No audio stream detected.");
    if (parsed.duration != null && parsed.duration === 0) issues.push("Duration is 0 — may be truncated.");
    return {
      ...base, valid: issues.length === 0, issueCount: issues.length, issues,
      duration: parsed.duration, durationHms: parsed.durationHms,
      streamCount: streams.length, videoCount: parsed.videoCount, audioCount: parsed.audioCount,
    };
  }
  throw new Error(`video_client: unhandled operation '${operation}'.`);
}

module.exports = { videoClient };
