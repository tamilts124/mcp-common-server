"use strict";
/**
 * Section 235: audio_client
 * Tests: A=validation(10), B=unit(20), C=happy-path(20), D=security(10), E=error-paths(10), F=concurrency(6)
 * Total: 76
 */
const fs   = require("fs");
const path = require("path");
const os   = require("os");
const { audioClient } = require("../../lib/audioClientOps");

// ── Helpers ───────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function assert(cond, name, detail) {
  if (cond) { passed++; process.stderr.write(`  PASS: ${name}\n`); }
  else       { failed++; process.stderr.write(`  FAIL: ${name}${detail ? ' -- ' + detail : ''}\n`); }
}
function assertThrows(fn, name, match) {
  try { fn(); failed++; process.stderr.write(`  FAIL: ${name} -- expected throw\n`); }
  catch (e) {
    if (match && !e.message.toLowerCase().includes(match.toLowerCase())) {
      failed++; process.stderr.write(`  FAIL: ${name} -- wrong error: ${e.message}\n`);
    } else { passed++; process.stderr.write(`  PASS: ${name}\n`); }
  }
}

const TMP = os.tmpdir();

// ── File Builders ────────────────────────────────────────────────────────────

// Build a minimal ID3v2.3 + MP3 frame
function buildMp3(title, artist, album, year, track, genre) {
  const buf = [];

  // ─ ID3v2.3 Header ─
  const frames = [];
  function makeFrame(id, text) {
    const enc = Buffer.from([0x00]); // latin1
    const content = Buffer.concat([enc, Buffer.from(text, 'latin1')]);
    const h = Buffer.alloc(10);
    h.write(id, 0, 4, 'ascii');
    h.writeUInt32BE(content.length, 4);
    return Buffer.concat([h, content]);
  }
  if (title)  frames.push(makeFrame('TIT2', title));
  if (artist) frames.push(makeFrame('TPE1', artist));
  if (album)  frames.push(makeFrame('TALB', album));
  if (year)   frames.push(makeFrame('TYER', year));
  if (track)  frames.push(makeFrame('TRCK', track));
  if (genre)  frames.push(makeFrame('TCON', genre));

  const framesData = Buffer.concat(frames);
  const totalSize  = framesData.length;
  // syncsafe encode totalSize
  const ss = Buffer.alloc(4);
  ss[0] = (totalSize >> 21) & 0x7f;
  ss[1] = (totalSize >> 14) & 0x7f;
  ss[2] = (totalSize >>  7) & 0x7f;
  ss[3] =  totalSize        & 0x7f;

  const id3Header = Buffer.alloc(10);
  id3Header.write('ID3', 0, 3, 'ascii');
  id3Header[3] = 3; // v2.3
  id3Header[4] = 0;
  id3Header[5] = 0;
  ss.copy(id3Header, 6);

  // ─ Minimal MPEG1 Layer3 frame (128kbps, 44100Hz, stereo) ─
  // frame sync: 0xFF 0xFB (MPEG1, L3, 128kbps, 44100Hz, stereo)
  // Bitrate index 9 = 128kbps, sample rate 0 = 44100, padding=0, stereo
  // 0xFF 0xFB 0x90 0x00 (MPEG1 L3 128k 44100 stereo)
  // Frame size = floor(144 * 128000 / 44100) + 0 = 417 bytes
  const mp3Frame = Buffer.alloc(417);
  mp3Frame[0] = 0xFF;
  mp3Frame[1] = 0xFB;  // sync + MPEG1 + Layer3 + no CRC
  mp3Frame[2] = 0x90;  // bitrate index 9 = 128kbps, sample rate 0 = 44100, no padding
  mp3Frame[3] = 0x00;  // stereo, no ext, not copyrighted, original
  // Fill with zeros (valid silent frame)

  // ─ ID3v1 footer ─
  const id3v1 = Buffer.alloc(128);
  id3v1.write('TAG', 0, 3, 'ascii');
  if (title)  id3v1.write(title.slice(0,30).padEnd(30,'\0'),  3,  30, 'latin1');
  if (artist) id3v1.write(artist.slice(0,30).padEnd(30,'\0'), 33, 30, 'latin1');
  if (album)  id3v1.write(album.slice(0,30).padEnd(30,'\0'),  63, 30, 'latin1');
  if (year)   id3v1.write(year.slice(0,4).padEnd(4,'\0'),     93,  4, 'latin1');
  id3v1[127] = 2; // genre index (Country)

  return Buffer.concat([id3Header, framesData, mp3Frame, id3v1]);
}

// Build a minimal FLAC file with STREAMINFO and VORBIS_COMMENT
function buildFlac(tags) {
  const parts = [];
  parts.push(Buffer.from('fLaC'));

  // STREAMINFO block (type=0, last=false) — 34 bytes data
  const si = Buffer.alloc(34);
  // min/max block size
  si.writeUInt16BE(4096, 0);
  si.writeUInt16BE(4096, 2);
  // min/max frame size (0 = unknown)
  si[4]=0; si[5]=0; si[6]=0;
  si[7]=0; si[8]=0; si[9]=0;
  // sample rate (44100) = 20 bits = 0xAC440
  // channels=2 (3 bits = 001), bits/sample=16 (5 bits=01111)
  // 44100 = 0x00AC44 -> first 20 bits in bits [10..30]
  // byte10: 0xAC, 11: 0x44, part at 12:
  // sampleRate=44100 => 0x00AC44 => bits 10.0-17.3 = 0xAC = 0b10101100
  //                                  bits 18.0-19.7 = 0x44 >> 4 = 0b0100 (upper nibble)
  // encode: (44100 << 12) | (channels-1 << 9) | (bitsPerSample-1 << 4) | totalSamples_upper
  // Simplified: use known byte sequence for 44100 Hz, 2ch, 16-bit
  si[10] = 0x0A; // sampleRate upper
  si[11] = 0xC4; // sampleRate middle
  si[12] = 0x42; // sampleRate lower nibble | channels 2ch (001) | bitsPerSample 16 (01111) upper
  // 44100 in 20 bits = 0xAC44, pack:
  // bits 0-19 = sampleRate, bits 20-22 = channels-1, bits 23-27 = bitsPerSample-1
  // bytes 10,11,12.upper4: 44100=0xAC44 -> 0xAC=0b10101100, 0x44=0b01000100
  // 20-bit: 0xAC44 = 0000_1010_1100_0100_0100 => too complex; use magic bytes
  // Actual STREAMINFO for 44100Hz, 2ch, 16-bit:
  //   sample rate (20 bits): 44100 = 0x00AC44 -> first 2.5 bytes
  //   channels (3 bits): 0b001 -> 2 channels
  //   bits/sample-1 (5 bits): 0b01111 -> 16 bits
  //   total samples (36 bits): small number
  // Pack: [ss ss ss ss ss] where s=sample_rate[19:0], c=channels[2:0], b=bps[4:0], n=total[35:0]
  // si[10..13] = 0x0A, 0xC4, 0x42, 0xF0 approximation for 44100/2ch/16bit
  si[10] = 0x0A;
  si[11] = 0xC4;
  si[12] = 0x42; // channel+bps packed
  si[13] = 0xF0; // total samples upper
  // total samples = 44100 (1 sec) packed in remaining 4.5 bytes
  si[14] = 0x00;
  si[15] = 0x00;
  si[16] = 0xAC;
  si[17] = 0x44; // 44100 samples
  // MD5 (16 bytes, zeros)
  // si[18..33] = 0

  const siHeader = Buffer.alloc(4);
  siHeader[0] = 0x00; // type=0, not-last
  siHeader.writeUIntBE(34, 1, 3); // block len
  parts.push(siHeader, si);

  // VORBIS_COMMENT block (type=4)
  function makeVorbisComment(tagMap) {
    const vendor = Buffer.from('test');
    const vendorLen = Buffer.alloc(4); vendorLen.writeUInt32LE(vendor.length, 0);
    const entries = [];
    for (const [k, v] of Object.entries(tagMap)) {
      const kv = Buffer.from(`${k}=${v}`, 'utf8');
      const len = Buffer.alloc(4); len.writeUInt32LE(kv.length, 0);
      entries.push(len, kv);
    }
    const count = Buffer.alloc(4); count.writeUInt32LE(Object.keys(tagMap).length, 0);
    return Buffer.concat([vendorLen, vendor, count, ...entries]);
  }
  const vcData = makeVorbisComment(tags || {});
  const vcHeader = Buffer.alloc(4);
  vcHeader[0] = 0x84; // type=4, is-last
  vcHeader.writeUIntBE(vcData.length, 1, 3);
  parts.push(vcHeader, vcData);

  return Buffer.concat(parts);
}

// Build minimal WAV (PCM, 1ch, 22050Hz, 8-bit, 0.1s)
function buildWav(infoTags) {
  // fmt chunk
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);    // PCM
  fmt.writeUInt16LE(1, 2);    // 1 channel
  fmt.writeUInt32LE(22050, 4); // 22050 Hz
  fmt.writeUInt32LE(22050, 8); // byte rate
  fmt.writeUInt16LE(1, 12);   // block align
  fmt.writeUInt16LE(8, 14);   // bits per sample

  // data chunk (0.1s = 2205 bytes silence)
  const dataPayload = Buffer.alloc(2205, 128);

  // LIST INFO chunk
  const infoEntries = [];
  for (const [id, val] of Object.entries(infoTags || {})) {
    const valBuf = Buffer.from(val + '\0', 'latin1');
    const vlen = valBuf.length % 2 === 0 ? valBuf : Buffer.concat([valBuf, Buffer.alloc(1)]);
    const hdr = Buffer.alloc(8);
    hdr.write(id, 0, 4, 'ascii');
    hdr.writeUInt32LE(valBuf.length, 4);
    infoEntries.push(hdr, vlen);
  }

  const listType = Buffer.from('INFO');
  const listData = Buffer.concat([listType, ...infoEntries]);
  const listHeader = Buffer.alloc(8);
  listHeader.write('LIST', 0, 4, 'ascii');
  listHeader.writeUInt32LE(listData.length, 4);

  const chunks = [];

  // fmt chunk with header
  const fmtHdr = Buffer.alloc(8);
  fmtHdr.write('fmt ', 0, 4, 'ascii');
  fmtHdr.writeUInt32LE(16, 4);
  chunks.push(fmtHdr, fmt);

  // LIST
  if (infoEntries.length > 0) chunks.push(listHeader, listData);

  // data chunk
  const dataHdr = Buffer.alloc(8);
  dataHdr.write('data', 0, 4, 'ascii');
  dataHdr.writeUInt32LE(dataPayload.length, 4);
  chunks.push(dataHdr, dataPayload);

  const body = Buffer.concat(chunks);

  // RIFF header
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 4, 'ascii');
  riff.writeUInt32LE(body.length + 4, 4); // 4 for 'WAVE'
  riff.write('WAVE', 8, 4, 'ascii');

  return Buffer.concat([riff, body]);
}

// FLAC with a tiny embedded cover (1x1 JPEG placeholder)
const TINY_JPEG = Buffer.from([
  0xFF,0xD8,0xFF,0xE0, 0x00,0x10,'J'.charCodeAt(0),'F'.charCodeAt(0),
  'I'.charCodeAt(0),'F'.charCodeAt(0), 0x00,0x01, 0x01,0x00, 0x00,0x01, 0x00,0x01, 0x00,0x00,
  0xFF,0xD9,
]);

// Build a minimal OGG Vorbis file with one identification page and comment page
function buildOgg() {
  // Only build a rough structure that passes format detection
  // 4 bytes OggS + minimal header
  const page1 = Buffer.alloc(64);
  page1.write('OggS', 0, 4, 'ascii'); // capture pattern
  page1[4] = 0; // version
  page1[5] = 0x02; // BOS
  // granule pos (8 bytes LE) = 0
  // bitstream serial (4 bytes)
  page1.writeUInt32LE(1, 14);
  // sequence no
  page1.writeUInt32LE(0, 18);
  // checksum (4 bytes)
  page1[26] = 1; // 1 segment
  // segment table
  page1[27] = 30; // body size
  // body: Vorbis identification header
  //   packet type 0x01, 'vorbis', version, channels, samplerate...
  const body = Buffer.alloc(30);
  body[0] = 0x01;
  body.write('vorbis', 1, 6, 'ascii');
  body.writeUInt32LE(0, 7); // version=0
  body[11] = 2; // channels
  body.writeUInt32LE(44100, 12); // sampleRate
  body.writeUInt32LE(0, 16); // max bitrate
  body.writeUInt32LE(128000, 20); // nominal bitrate
  body.writeUInt32LE(0, 24); // min bitrate
  // copy body into page
  body.copy(page1, 28);

  return page1;
}

// ── Write test files ─────────────────────────────────────────────────────────────

const MP3_FILE  = path.join(TMP, 'test-235.mp3');
const FLAC_FILE = path.join(TMP, 'test-235.flac');
const WAV_FILE  = path.join(TMP, 'test-235.wav');
const OGG_FILE  = path.join(TMP, 'test-235.ogg');
const BAD_FILE  = path.join(TMP, 'test-235-bad.mp3');

fs.writeFileSync(MP3_FILE,  buildMp3('Test Title', 'Test Artist', 'Test Album', '2024', '1/10', 'Rock'));
fs.writeFileSync(FLAC_FILE, buildFlac({
  title: 'FLAC Title', artist: 'FLAC Artist', album: 'FLAC Album',
  date: '2024-01-01', tracknumber: '3', genre: 'Electronic',
  albumartist: 'Various Artists', bpm: '128',
}));
fs.writeFileSync(WAV_FILE,  buildWav({ INAM: 'WAV Title', IART: 'WAV Artist', IPRD: 'WAV Album', ICRD: '2023' }));
fs.writeFileSync(OGG_FILE,  buildOgg());
fs.writeFileSync(BAD_FILE,  Buffer.from('This is not an audio file at all.'));

process.stderr.write(`\nSection 235: audio_client\n`);
process.stderr.write(`  MP3:  ${fs.statSync(MP3_FILE).size} bytes\n`);
process.stderr.write(`  FLAC: ${fs.statSync(FLAC_FILE).size} bytes\n`);
process.stderr.write(`  WAV:  ${fs.statSync(WAV_FILE).size} bytes\n`);

// ── [A] Validation ───────────────────────────────────────────────────────────────
process.stderr.write('\n[A] Validation\n');

assertThrows(() => audioClient({}),                                 'A01 missing operation throws',  'operation');
assertThrows(() => audioClient({ operation: '' }),                  'A02 empty operation throws',    'operation');
assertThrows(() => audioClient({ operation: '  ' }),               'A03 whitespace operation throws','operation');
assertThrows(() => audioClient({ operation: 'info' }),             'A04 missing path throws',       'path');
assertThrows(() => audioClient({ operation: 'info', path: '' }),   'A05 empty path throws',         'path');
assertThrows(() => audioClient({ operation: 'info', path: 42 }),   'A06 non-string path throws',    'path');
assertThrows(() => audioClient({ operation: 'info', path: 'a\0b.mp3' }), 'A07 NUL byte throws',   'nul');
assertThrows(() => audioClient({ operation: 'info', path: TMP }), 'A08 directory path throws',      'directory');
assertThrows(() => audioClient({ operation: 'info', path: '/no/such/file.mp3' }), 'A09 missing file throws', 'not found');
assertThrows(() => audioClient({ operation: 'unknown_op', path: MP3_FILE }), 'A10 unknown op throws', 'unknown operation');

// ── [B] Unit ─────────────────────────────────────────────────────────────────────
process.stderr.write('\n[B] Unit\n');

// MP3 info
const mp3Info = audioClient({ operation: 'info', path: MP3_FILE });
assert(mp3Info.operation === 'info',              'B01 info.operation=info');
assert(mp3Info.format === 'MP3',                  'B02 MP3 format detected');
assert(mp3Info.codec === 'MP3',                   'B03 MP3 codec=MP3');
assert(typeof mp3Info.fileSizeBytes === 'number', 'B04 fileSizeBytes is number');
assert(mp3Info.sampleRate === 44100,              'B05 MP3 sampleRate=44100');
assert(mp3Info.channels === 2,                    'B06 MP3 channels=2');
assert(mp3Info.bitrateKbps === 128,               'B07 MP3 bitrateKbps=128');
assert(mp3Info.tagCount > 0,                      'B08 MP3 tagCount>0');
assert(typeof mp3Info.isVbr === 'boolean',        'B09 isVbr is boolean');
assert(mp3Info.path === MP3_FILE,                 'B10 info.path echoed back');

// MP3 tags
const mp3Tags = audioClient({ operation: 'tags', path: MP3_FILE });
assert(mp3Tags.operation === 'tags',              'B11 tags.operation=tags');
assert(mp3Tags.tags.title === 'Test Title',       'B12 ID3v2 title correct');
assert(mp3Tags.tags.artist === 'Test Artist',     'B13 ID3v2 artist correct');
assert(mp3Tags.tags.album === 'Test Album',       'B14 ID3v2 album correct');
assert(mp3Tags.tags.year === '2024',              'B15 ID3v2 year correct');
assert(mp3Tags.tags.track === '1/10',             'B16 ID3v2 track correct');
assert(mp3Tags.tags.genre === 'Rock' ||
       mp3Tags.tags.genre === '(17)' ||
       (mp3Tags.tags.genre && mp3Tags.tags.genre.includes('Rock')), 'B17 ID3v2 genre correct');
assert(typeof mp3Tags.tagCount === 'number',      'B18 tagCount is number');
assert(mp3Tags.tagCount === Object.keys(mp3Tags.tags).length, 'B19 tagCount matches tags');
assert(mp3Tags.format === 'mp3',                  'B20 tags.format=mp3');

// ── [C] Happy-path ───────────────────────────────────────────────────────────────
process.stderr.write('\n[C] Happy-path\n');

// FLAC info
const flacInfo = audioClient({ operation: 'info', path: FLAC_FILE });
assert(flacInfo.format === 'FLAC',                'C01 FLAC format detected');
assert(flacInfo.codec === 'FLAC',                 'C02 FLAC codec=FLAC');
assert(flacInfo.sampleRate === 44100,             'C03 FLAC sampleRate=44100');
assert(flacInfo.channels === 2,                   'C04 FLAC channels=2');
assert(flacInfo.bitsPerSample === 16,             'C05 FLAC bitsPerSample=16');

// FLAC tags
const flacTags = audioClient({ operation: 'tags', path: FLAC_FILE });
assert(flacTags.tags.title === 'FLAC Title',      'C06 FLAC title correct');
assert(flacTags.tags.artist === 'FLAC Artist',    'C07 FLAC artist correct');
assert(flacTags.tags.album === 'FLAC Album',      'C08 FLAC album correct');
assert(flacTags.tags.genre === 'Electronic',      'C09 FLAC genre correct');
assert(flacTags.tags.bpm === '128',               'C10 FLAC bpm correct');

// WAV info
const wavInfo = audioClient({ operation: 'info', path: WAV_FILE });
assert(wavInfo.format === 'WAV',                  'C11 WAV format detected');
assert(wavInfo.codec.startsWith('WAV'),           'C12 WAV codec starts with WAV');
assert(wavInfo.sampleRate === 22050,              'C13 WAV sampleRate=22050');
assert(wavInfo.channels === 1,                    'C14 WAV channels=1');
assert(wavInfo.bitsPerSample === 8,               'C15 WAV bitsPerSample=8');
assert(wavInfo.durationMs > 0,                    'C16 WAV durationMs>0');

// WAV tags
const wavTags = audioClient({ operation: 'tags', path: WAV_FILE });
assert(wavTags.tags.title === 'WAV Title',        'C17 WAV title from RIFF INFO');
assert(wavTags.tags.artist === 'WAV Artist',      'C18 WAV artist from RIFF INFO');

// OGG basic format detection
const oggInfo = audioClient({ operation: 'info', path: OGG_FILE });
assert(oggInfo.format === 'OGG',                  'C19 OGG format detected');
assert(typeof oggInfo.codec === 'string' || oggInfo.codec === null, 'C20 OGG codec is string or null');

// ── [D] Security ───────────────────────────────────────────────────────────────
process.stderr.write('\n[D] Security\n');

assertThrows(() => audioClient({ operation: 'info', path: 'a\0b.mp3' }),
  'D01 NUL byte in path rejected', 'nul');
assertThrows(() => audioClient({ operation: 'info', path: TMP }),
  'D02 directory path rejected', 'directory');
assertThrows(() => audioClient({ operation: 'info', path: '/no/such/audio.mp3' }),
  'D03 nonexistent file rejected');

// Non-audio binary file
const binFile = path.join(TMP, 'test-235-bin.bin');
fs.writeFileSync(binFile, Buffer.alloc(512, 0xAB));
const binInfo = audioClient({ operation: 'info', path: binFile });
assert(binInfo.format === 'Unknown',             'D04 binary non-audio returns Unknown format');

// Covers with include_data=false
const mp3CoversNoData = audioClient({ operation: 'covers', path: MP3_FILE, include_data: false });
assert(Array.isArray(mp3CoversNoData.covers),     'D05 covers returns array');
assert(mp3CoversNoData.covers.every(c => c.data === undefined), 'D06 covers no data when include_data=false');

// Chapters on all formats return array (even if empty)
const mp3Chaps = audioClient({ operation: 'chapters', path: MP3_FILE });
assert(Array.isArray(mp3Chaps.chapters),          'D07 chapters is always array');
assert(typeof mp3Chaps.chapterCount === 'number', 'D08 chapterCount is number');

// Validate on malformed file returns problems
const badVal = audioClient({ operation: 'validate', path: BAD_FILE });
assert(badVal.operation === 'validate',           'D09 validate returns validate operation');
assert(typeof badVal.valid === 'boolean',         'D10 validate.valid is boolean');

// ── [E] Error-paths ───────────────────────────────────────────────────────────────
process.stderr.write('\n[E] Error-paths\n');

// Empty file
const emptyFile = path.join(TMP, 'test-235-empty.mp3');
fs.writeFileSync(emptyFile, Buffer.alloc(0));
const emptyInfo = audioClient({ operation: 'info', path: emptyFile });
assert(emptyInfo.format === 'Unknown',            'E01 empty file returns Unknown format');

// Very small file (less than 12 bytes)
const tinyFile = path.join(TMP, 'test-235-tiny.mp3');
fs.writeFileSync(tinyFile, Buffer.from([0xFF, 0xFB]));
const tinyInfo = audioClient({ operation: 'info', path: tinyFile });
assert(typeof tinyInfo === 'object',              'E02 tiny file returns info object');

// Tags on unrecognized file returns empty/minimal tags
const badTags = audioClient({ operation: 'tags', path: BAD_FILE });
assert(typeof badTags.tags === 'object',          'E03 tags on bad file returns object');
assert(typeof badTags.tagCount === 'number',      'E04 tagCount is always number');

// Covers on WAV (no cover) returns empty array
const wavCovers = audioClient({ operation: 'covers', path: WAV_FILE });
assert(wavCovers.coverCount === 0,                'E05 WAV with no covers gives count=0');
assert(wavCovers.covers.length === 0,             'E06 WAV covers array is empty');

// Validate on unknown format has problems
const badValidate = audioClient({ operation: 'validate', path: BAD_FILE });
assert(!badValidate.valid,                        'E07 validate on garbage file is not valid');
assert(Array.isArray(badValidate.problems),       'E08 problems is array');
assert(badValidate.problems.length > 0,           'E09 at least one problem reported for bad file');

// null args
assertThrows(() => audioClient(null), 'E10 null args throws');

// ── [F] Concurrency ───────────────────────────────────────────────────────────────
process.stderr.write('\n[F] Concurrency\n');

const CONC = 20;

const infoRuns = Array.from({ length: CONC }, () =>
  Promise.resolve(audioClient({ operation: 'info', path: MP3_FILE }))
);
Promise.all(infoRuns).then(results => {
  assert(results.every(r => r.format === 'MP3'), 'F01 20 concurrent MP3 info calls succeed');

  // F02: mixed ops on MP3
  return Promise.all([
    Promise.resolve(audioClient({ operation: 'info',     path: MP3_FILE })),
    Promise.resolve(audioClient({ operation: 'tags',     path: MP3_FILE })),
    Promise.resolve(audioClient({ operation: 'covers',   path: MP3_FILE })),
    Promise.resolve(audioClient({ operation: 'chapters', path: MP3_FILE })),
    Promise.resolve(audioClient({ operation: 'validate', path: MP3_FILE })),
  ]);
}).then(results => {
  assert(results.length === 5, 'F02 all 5 operations succeed concurrently on MP3');

  // F03: concurrent on different formats
  return Promise.all([
    Promise.resolve(audioClient({ operation: 'info', path: MP3_FILE })),
    Promise.resolve(audioClient({ operation: 'info', path: FLAC_FILE })),
    Promise.resolve(audioClient({ operation: 'info', path: WAV_FILE })),
    Promise.resolve(audioClient({ operation: 'tags', path: MP3_FILE })),
    Promise.resolve(audioClient({ operation: 'tags', path: FLAC_FILE })),
  ]);
}).then(results => {
  assert(
    results[0].format === 'MP3' &&
    results[1].format === 'FLAC' &&
    results[2].format === 'WAV',
    'F03 concurrent multi-format calls return correct formats'
  );

  // F04: errors don't poison good calls
  return Promise.all([
    Promise.resolve().then(() => { try { return audioClient({ operation: 'info', path: '/no/file.mp3' }); } catch { return null; } }),
    Promise.resolve(audioClient({ operation: 'info', path: MP3_FILE })),
    Promise.resolve().then(() => { try { return audioClient({ operation: 'unknown_x', path: MP3_FILE }); } catch { return null; } }),
    Promise.resolve(audioClient({ operation: 'tags', path: FLAC_FILE })),
  ]);
}).then(results => {
  assert(results[1].format === 'MP3' && results[3].tags.title === 'FLAC Title',
    'F04 valid calls succeed alongside error calls');

  // F05: repeated identical calls produce identical results
  const r1 = audioClient({ operation: 'info', path: MP3_FILE });
  const r2 = audioClient({ operation: 'info', path: MP3_FILE });
  assert(r1.format === r2.format && r1.sampleRate === r2.sampleRate,
    'F05 repeated calls are deterministic');

  // F06: 10 concurrent tag reads on FLAC
  return Promise.all(Array.from({ length: 10 }, () =>
    Promise.resolve(audioClient({ operation: 'tags', path: FLAC_FILE }))
  ));
}).then(results => {
  assert(results.every(r => r.tags.title === 'FLAC Title'),
    'F06 10 concurrent FLAC tag reads all correct');

  // ── Cleanup ───────────────────────────────────────────────────────────────
  for (const f of [MP3_FILE, FLAC_FILE, WAV_FILE, OGG_FILE, BAD_FILE, binFile, emptyFile, tinyFile]) {
    try { fs.unlinkSync(f); } catch {}
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  process.stderr.write(`\nSection 235 results: ${passed}/${passed + failed} passed\n`);
  if (failed === 0) process.stderr.write('All tests passed.\n');
  else process.stderr.write(`${failed} test(s) FAILED.\n`);
  process.exit(failed > 0 ? 1 : 0);
}).catch(err => {
  process.stderr.write('Uncaught: ' + err.stack + '\n');
  process.exit(1);
});
