"use strict";
/**
 * Section 234: epub_client
 * Tests: A=validation(10), B=unit(20), C=happy-path(20), D=security(10), E=error-paths(10), F=concurrency(6)
 * Total: 76
 */
const fs   = require("fs");
const path = require("path");
const os   = require("os");
const zlib = require("zlib");
const { epubClient } = require("../../lib/epubClientOps");

// ── Helpers ──────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function assert(cond, name, detail) {
  if (cond) { passed++; process.stderr.write(`  PASS: ${name}\n`); }
  else       { failed++; process.stderr.write(`  FAIL: ${name}${detail ? ' -- ' + detail : ''}\n`); }
}
function assertThrows(fn, name, match) {
  try { fn(); failed++; process.stderr.write(`  FAIL: ${name} -- expected throw\n`); }
  catch (e) {
    if (match && !e.message.includes(match)) {
      failed++; process.stderr.write(`  FAIL: ${name} -- wrong error: ${e.message}\n`);
    } else { passed++; process.stderr.write(`  PASS: ${name}\n`); }
  }
}

// ── Build a minimal EPUB 2 in memory ─────────────────────────────────────────
// We need a valid ZIP container with OPF, NCX, chapters, and an image.

function buildZip(entries) {
  // Minimal ZIP builder: stored (method=0) entries for simplicity
  const CHUNKS = [];
  const CD     = [];
  let offset   = 0;

  function u16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v,0); return b; }
  function u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v,0); return b; }

  function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
      crc ^= buf[i];
      for (let j = 0; j < 8; j++)
        crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const dataBuf   = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const crc       = crc32(dataBuf);

    // Local file header
    const lfh = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(0),      // sig, ver, flags, method
      u16(0), u16(0),                                 // mod time, date
      u32(crc), u32(dataBuf.length), u32(dataBuf.length), // crc, comp, uncomp
      u16(nameBytes.length), u16(0),                  // fname len, extra len
      nameBytes,
    ]);
    CHUNKS.push(lfh, dataBuf);

    // Central directory entry
    const cde = Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0),
      u16(0), u16(0),
      u32(crc), u32(dataBuf.length), u32(dataBuf.length),
      u16(nameBytes.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset),
      nameBytes,
    ]);
    CD.push(cde);
    offset += lfh.length + dataBuf.length;
  }

  const cdBuf = Buffer.concat(CD);
  const eocd  = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0),
    u16(entries.length), u16(entries.length),
    u32(cdBuf.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([...CHUNKS, cdBuf, eocd]);
}

const MIMETYPE = 'application/epub+zip';
const CONTAINER_XML = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

const CONTENT_OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="BookId">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
    <dc:title>Test EPUB Book</dc:title>
    <dc:creator opf:role="aut">Jane Author</dc:creator>
    <dc:publisher>Test Publisher</dc:publisher>
    <dc:language>en</dc:language>
    <dc:identifier id="BookId" opf:scheme="ISBN">9780000000002</dc:identifier>
    <dc:date>2024-01-15</dc:date>
    <dc:description>A test EPUB ebook for unit tests.</dc:description>
    <meta name="cover" content="cover-img"/>
  </metadata>
  <manifest>
    <item id="ncx"        href="toc.ncx"       media-type="application/x-dtbncx+xml"/>
    <item id="cover-img"  href="images/cover.png" media-type="image/png"/>
    <item id="chapter1"   href="chapter1.xhtml"   media-type="application/xhtml+xml"/>
    <item id="chapter2"   href="chapter2.xhtml"   media-type="application/xhtml+xml"/>
    <item id="chapter3"   href="chapter3.xhtml"   media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="chapter1" linear="yes"/>
    <itemref idref="chapter2" linear="yes"/>
    <itemref idref="chapter3" linear="no"/>
  </spine>
</package>`;

const TOC_NCX = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="9780000000002"/></head>
  <docTitle><text>Test EPUB Book</text></docTitle>
  <navMap>
    <navPoint id="np1" playOrder="1">
      <navLabel><text>Chapter 1: Introduction</text></navLabel>
      <content src="chapter1.xhtml"/>
      <navPoint id="np1a" playOrder="2">
        <navLabel><text>Section 1.1</text></navLabel>
        <content src="chapter1.xhtml#sec1"/>
      </navPoint>
    </navPoint>
    <navPoint id="np2" playOrder="3">
      <navLabel><text>Chapter 2: Main Content</text></navLabel>
      <content src="chapter2.xhtml"/>
    </navPoint>
    <navPoint id="np3" playOrder="4">
      <navLabel><text>Chapter 3: Appendix</text></navLabel>
      <content src="chapter3.xhtml"/>
    </navPoint>
  </navMap>
</ncx>`;

const CHAPTER1 = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter 1: Introduction</title></head>
<body><h1>Introduction</h1><p>This is chapter one content.</p></body>
</html>`;

const CHAPTER2 = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter 2: Main Content</title></head>
<body><h1>Main Content</h1><p>This is chapter two content.</p></body>
</html>`;

const CHAPTER3 = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter 3: Appendix</title></head>
<body><h1>Appendix</h1><p>Non-linear appendix content.</p></body>
</html>`;

// Minimal 1x1 PNG
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108000000003a7e9b55' +
  '0000000a49444154789c6260000000020001e221bc330000000049454e44ae426082', 'hex'
);

function makeEpub2() {
  return buildZip([
    { name: 'mimetype',                    data: MIMETYPE },
    { name: 'META-INF/container.xml',      data: CONTAINER_XML },
    { name: 'OEBPS/content.opf',           data: CONTENT_OPF },
    { name: 'OEBPS/toc.ncx',              data: TOC_NCX },
    { name: 'OEBPS/chapter1.xhtml',        data: CHAPTER1 },
    { name: 'OEBPS/chapter2.xhtml',        data: CHAPTER2 },
    { name: 'OEBPS/chapter3.xhtml',        data: CHAPTER3 },
    { name: 'OEBPS/images/cover.png',      data: TINY_PNG },
  ]);
}

// EPUB 3 with nav document
const CONTENT_OPF3 = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>EPUB3 Test Book</dc:title>
    <dc:creator>EPUB3 Author</dc:creator>
    <dc:language>en</dc:language>
    <dc:identifier id="uid">urn:isbn:9780000000019</dc:identifier>
    <meta property="dcterms:modified">2024-01-15T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="cover-image" href="cover.png" media-type="image/png" properties="cover-image"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
  </spine>
</package>`;

const NAV_XHTML = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Navigation</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <ol>
      <li><a href="ch1.xhtml">Chapter 1</a>
        <ol>
          <li><a href="ch1.xhtml#s1">Section 1.1</a></li>
        </ol>
      </li>
    </ol>
  </nav>
</body>
</html>`;

const CH1 = `<?xml version="1.0"?><html><head><title>Chapter 1</title></head><body><p>content</p></body></html>`;

function makeEpub3() {
  return buildZip([
    { name: 'mimetype',               data: 'application/epub+zip' },
    { name: 'META-INF/container.xml', data: `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>` },
    { name: 'content.opf',            data: CONTENT_OPF3 },
    { name: 'nav.xhtml',              data: NAV_XHTML },
    { name: 'cover.png',              data: TINY_PNG },
    { name: 'ch1.xhtml',              data: CH1 },
  ]);
}

// Write temp files
const TMP   = os.tmpdir();
const EPUB2 = path.join(TMP, 'test-234-epub2.epub');
const EPUB3 = path.join(TMP, 'test-234-epub3.epub');
fs.writeFileSync(EPUB2, makeEpub2());
fs.writeFileSync(EPUB3, makeEpub3());

process.stderr.write('\nSection 234: epub_client\n');
process.stderr.write(`  EPUB2: ${fs.statSync(EPUB2).size} bytes\n`);
process.stderr.write(`  EPUB3: ${fs.statSync(EPUB3).size} bytes\n`);

// ── [A] Validation ────────────────────────────────────────────────────────────
process.stderr.write('\n[A] Validation\n');

assertThrows(() => epubClient({}),                              'A01 missing operation throws',     'operation');
assertThrows(() => epubClient({ operation: '' }),               'A02 empty operation throws',        'operation');
assertThrows(() => epubClient({ operation: 'info' }),           'A03 missing path throws',           'path');
assertThrows(() => epubClient({ operation: 'info', path: '' }), 'A04 empty path throws',             'path');
assertThrows(() => epubClient({ operation: 'info', path: 42 }), 'A05 non-string path throws',        'path');
assertThrows(() => epubClient({ operation: 'info', path: 'a\0b' }), 'A06 NUL byte in path throws',  'NUL');
assertThrows(() => epubClient({ operation: 'info', path: TMP }), 'A07 directory path throws',        'directory');
assertThrows(() => epubClient({ operation: 'info', path: '/no/such/file.epub' }), 'A08 missing file throws', 'not found');
assertThrows(() => epubClient({ operation: 'unknown', path: EPUB2 }), 'A09 unknown operation throws', 'unknown operation');
assertThrows(() => epubClient({ operation: 'read', path: EPUB2 }), 'A10 read without item throws',  'item');

// ── [B] Unit ─────────────────────────────────────────────────────────────────
process.stderr.write('\n[B] Unit\n');

const info2 = epubClient({ operation: 'info', path: EPUB2 });
assert(info2.epubVersion === '2.0',          'B01 info epubVersion=2.0');
assert(info2.title === 'Test EPUB Book',     'B02 info title correct');
assert(info2.author === 'Jane Author',       'B03 info author correct');
assert(info2.language === 'en',              'B04 info language correct');
assert(info2.spineItems === 3,               'B05 info spineItems=3');
assert(info2.manifestItems >= 5,             'B06 info manifestItems>=5');
assert(info2.imageCount >= 1,                'B07 info imageCount>=1');
assert(typeof info2.fileSizeBytes === 'number', 'B08 info fileSizeBytes is number');
assert(info2.opfPath === 'OEBPS/content.opf', 'B09 info opfPath correct');
assert(info2.zipEntries >= 8,               'B10 info zipEntries>=8');

const meta = epubClient({ operation: 'metadata', path: EPUB2 });
assert(meta.dc.title === 'Test EPUB Book',   'B11 metadata dc.title');
assert(meta.dc.language === 'en',            'B12 metadata dc.language');
assert(meta.dc.publisher === 'Test Publisher', 'B13 metadata dc.publisher');
assert(meta.isbn === '9780000000002',        'B14 metadata isbn extracted');
assert(typeof meta.dc.date === 'string' || meta.dc.date, 'B15 metadata dc.date present');

const toc = epubClient({ operation: 'toc', path: EPUB2 });
assert(toc.tocSource === 'epub2-ncx',        'B16 toc source=epub2-ncx');
assert(toc.totalItems >= 4,                  'B17 toc totalItems>=4 (including nested)');
assert(toc.items[0].label.includes('Chapter 1'), 'B18 toc first item label');
assert(toc.items.some(i => i.depth === 1),   'B19 toc has nested items (depth>0)');
assert(Array.isArray(toc.items),             'B20 toc items is array');

// ── [C] Happy-path ────────────────────────────────────────────────────────────
process.stderr.write('\n[C] Happy-path\n');

const info3 = epubClient({ operation: 'info', path: EPUB3 });
assert(info3.epubVersion === '3.0',          'C01 epub3 info epubVersion=3.0');
assert(info3.title === 'EPUB3 Test Book',    'C02 epub3 info title');
assert(info3.hasCover === true,              'C03 epub3 hasCover=true (cover-image property)');

const toc3 = epubClient({ operation: 'toc', path: EPUB3 });
assert(toc3.tocSource === 'epub3-nav',       'C04 epub3 toc source=epub3-nav');
assert(toc3.totalItems >= 2,                 'C05 epub3 toc items>=2 (including nested)');
assert(toc3.items[0].label === 'Chapter 1',  'C06 epub3 toc first item label');

const chapters2 = epubClient({ operation: 'chapters', path: EPUB2 });
assert(chapters2.totalChapters === 2,        'C07 chapters linear_only=true gives 2 chapters');
assert(chapters2.chapters[0].linear === true, 'C08 chapters[0] is linear');
assert(chapters2.chapters[0].title !== null,  'C09 chapters[0] has title from NCX');
assert(chapters2.chapters[0].href.includes('chapter1'), 'C10 chapters[0].href correct');

const chapters2All = epubClient({ operation: 'chapters', path: EPUB2, linear_only: false });
assert(chapters2All.totalChapters === 3,     'C11 chapters linear_only=false gives 3 chapters');

const read1 = epubClient({ operation: 'read', path: EPUB2, item: 'OEBPS/chapter1.xhtml' });
assert(read1.encoding === 'utf8',            'C12 read XHTML encoding=utf8');
assert(read1.content.includes('Introduction'), 'C13 read content has text');
assert(read1.sizeBytes > 0,                  'C14 read sizeBytes>0');

const readById = epubClient({ operation: 'read', path: EPUB2, item: 'chapter1' });
assert(readById.item.includes('chapter1'),   'C15 read by manifest ID works');

const readImg = epubClient({ operation: 'read', path: EPUB2, item: 'OEBPS/images/cover.png' });
assert(readImg.encoding === 'base64',        'C16 read PNG returns base64');
assert(readImg.content.length > 0,           'C17 read PNG content not empty');

const images2 = epubClient({ operation: 'images', path: EPUB2 });
assert(images2.totalImages >= 1,             'C18 images totalImages>=1');
assert(images2.images[0].href.includes('cover'), 'C19 images first is cover');
assert(images2.images[0].mediaType === 'image/png', 'C20 images mediaType=image/png');

// ── [D] Security ─────────────────────────────────────────────────────────────
process.stderr.write('\n[D] Security\n');

assertThrows(() => epubClient({ operation: 'info', path: 'a\0b.epub' }),
  'D01 NUL byte in path rejected', 'NUL');
assertThrows(() => epubClient({ operation: 'info', path: TMP }),
  'D02 directory path rejected', 'directory');
assertThrows(() => epubClient({ operation: 'info', path: '/no/such/path.epub' }),
  'D03 nonexistent file error');

// Non-ZIP file
const notZip = path.join(TMP, 'test-234-notzip.epub');
fs.writeFileSync(notZip, Buffer.from('NOT A ZIP FILE'));
assertThrows(() => epubClient({ operation: 'info', path: notZip }),
  'D04 non-ZIP file rejected', 'PK signature');

// Truncated ZIP
const truncated = path.join(TMP, 'test-234-truncated.epub');
const fullBuf = makeEpub2();
fs.writeFileSync(truncated, fullBuf.slice(0, 50));
assertThrows(() => epubClient({ operation: 'info', path: truncated }),
  'D05 truncated ZIP rejected');

// NUL in read item
assertThrows(() => epubClient({ operation: 'read', path: EPUB2, item: 'a\0b' }),
  'D06 NUL byte in item rejected', 'NUL');

// Read a non-existent item
assertThrows(() => epubClient({ operation: 'read', path: EPUB2, item: 'no-such-item.xhtml' }),
  'D07 read nonexistent item error', 'not found');

// operation=null
assertThrows(() => epubClient({ operation: null, path: EPUB2 }),
  'D08 null operation rejected', 'operation');

// Limit clamping for toc
const tocLimited = epubClient({ operation: 'toc', path: EPUB2, limit: 2 });
assert(tocLimited.items.length <= 2,         'D09 toc limit=2 respected');

// images limit
const imgLim = epubClient({ operation: 'images', path: EPUB2, limit: 1 });
assert(imgLim.images.length <= 1,            'D10 images limit=1 respected');

// ── [E] Error-paths ───────────────────────────────────────────────────────────
process.stderr.write('\n[E] Error-paths\n');

// ZIP missing container.xml
const noContainer = buildZip([{ name: 'mimetype', data: 'application/epub+zip' }]);
const noContainerPath = path.join(TMP, 'test-234-nocontainer.epub');
fs.writeFileSync(noContainerPath, noContainer);
assertThrows(() => epubClient({ operation: 'info', path: noContainerPath }),
  'E01 ZIP without container.xml throws', 'container.xml');

// OPF missing
const missingOpf = buildZip([
  { name: 'META-INF/container.xml', data: CONTAINER_XML },
  { name: 'mimetype', data: 'application/epub+zip' },
]);
const missingOpfPath = path.join(TMP, 'test-234-missingopf.epub');
fs.writeFileSync(missingOpfPath, missingOpf);
assertThrows(() => epubClient({ operation: 'info', path: missingOpfPath }),
  'E02 missing OPF throws', 'OPF');

// metadata on book with minimal dc elements
const minOPF = buildZip([
  { name: 'mimetype', data: 'application/epub+zip' },
  { name: 'META-INF/container.xml', data: CONTAINER_XML },
  { name: 'OEBPS/content.opf', data: `<package version="2.0"><metadata/><manifest/><spine/></package>` },
]);
const minOpfPath = path.join(TMP, 'test-234-minopf.epub');
fs.writeFileSync(minOpfPath, minOPF);
const minMeta = epubClient({ operation: 'metadata', path: minOpfPath });
assert(typeof minMeta.dc === 'object',       'E03 metadata on minimal OPF does not crash');

// chapters: empty spine
const chaps = epubClient({ operation: 'chapters', path: minOpfPath });
assert(chaps.totalChapters === 0,            'E04 empty spine gives 0 chapters');

// toc: no NCX/nav → empty items
const toc5 = epubClient({ operation: 'toc', path: minOpfPath });
assert(toc5.totalItems === 0,                'E05 no TOC source gives empty items');
assert(toc5.tocSource === null,              'E06 tocSource null when no TOC');

// read: directory entry attempt (not possible since entries are named, try root)
assertThrows(() => epubClient({ operation: 'read', path: EPUB2, item: '' }),
  'E07 empty item string throws', 'item');

// images: no images in manifest
const imgs5 = epubClient({ operation: 'images', path: minOpfPath });
assert(imgs5.totalImages === 0,              'E08 no images gives totalImages=0');
assert(imgs5.cover === null,                 'E09 no cover gives cover=null');

// info: extra unknown field ignored
const info9 = epubClient({ operation: 'info', path: EPUB2, unknownField: 42 });
assert(info9.operation === 'info',           'E10 extra fields ignored (robustness)');

// ── [F] Concurrency ───────────────────────────────────────────────────────────
process.stderr.write('\n[F] Concurrency\n');

const CONC = 20;

// F01: 20 concurrent info calls on EPUB2
const infoCalls = Array.from({ length: CONC }, () =>
  Promise.resolve(epubClient({ operation: 'info', path: EPUB2 }))
);
Promise.all(infoCalls).then(results => {
  assert(results.every(r => r.title === 'Test EPUB Book'), 'F01 20 concurrent info calls succeed');

  // F02: mixed concurrent operations
  const mixed = [
    Promise.resolve(epubClient({ operation: 'info',     path: EPUB2 })),
    Promise.resolve(epubClient({ operation: 'metadata', path: EPUB2 })),
    Promise.resolve(epubClient({ operation: 'toc',      path: EPUB2 })),
    Promise.resolve(epubClient({ operation: 'chapters', path: EPUB2 })),
    Promise.resolve(epubClient({ operation: 'images',   path: EPUB2 })),
    Promise.resolve(epubClient({ operation: 'read',     path: EPUB2, item: 'OEBPS/chapter1.xhtml' })),
  ];
  return Promise.all(mixed);
}).then(results => {
  assert(results.length === 6,               'F02 mixed concurrent operations all succeed');

  // F03: concurrent on both EPUB2 and EPUB3
  const both = [
    Promise.resolve(epubClient({ operation: 'info', path: EPUB2 })),
    Promise.resolve(epubClient({ operation: 'info', path: EPUB3 })),
    Promise.resolve(epubClient({ operation: 'toc',  path: EPUB2 })),
    Promise.resolve(epubClient({ operation: 'toc',  path: EPUB3 })),
  ];
  return Promise.all(both);
}).then(results => {
  assert(results[0].epubVersion === '2.0' && results[1].epubVersion === '3.0',
    'F03 concurrent epub2+epub3 versions correct');

  // F04: concurrent read calls with different items
  const reads = [
    Promise.resolve(epubClient({ operation: 'read', path: EPUB2, item: 'OEBPS/chapter1.xhtml' })),
    Promise.resolve(epubClient({ operation: 'read', path: EPUB2, item: 'OEBPS/chapter2.xhtml' })),
    Promise.resolve(epubClient({ operation: 'read', path: EPUB2, item: 'OEBPS/chapter3.xhtml' })),
  ];
  return Promise.all(reads);
}).then(results => {
  assert(results.every(r => r.encoding === 'utf8'), 'F04 concurrent reads return utf8');

  // F05: concurrent error + valid calls don't interfere
  const mixed2 = [
    Promise.resolve().then(() => { try { epubClient({ operation: 'info', path: '/no/such.epub' }); } catch{} return 'err'; }),
    Promise.resolve(epubClient({ operation: 'info', path: EPUB2 })),
    Promise.resolve().then(() => { try { epubClient({ operation: 'unknown', path: EPUB2 }); } catch{} return 'err'; }),
    Promise.resolve(epubClient({ operation: 'info', path: EPUB3 })),
  ];
  return Promise.all(mixed2);
}).then(results => {
  assert(results[1].title === 'Test EPUB Book' && results[3].title === 'EPUB3 Test Book',
    'F05 valid calls succeed alongside error calls');

  // F06: repeated calls return identical results (determinism)
  const r1 = epubClient({ operation: 'info', path: EPUB2 });
  const r2 = epubClient({ operation: 'info', path: EPUB2 });
  assert(r1.title === r2.title && r1.epubVersion === r2.epubVersion,
    'F06 repeated calls deterministic');

  // ── Cleanup ────────────────────────────────────────────────────────────────
  for (const f of [EPUB2, EPUB3, notZip, truncated, noContainerPath, missingOpfPath, minOpfPath]) {
    try { fs.unlinkSync(f); } catch {}
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  process.stderr.write(`\nSection 234 results: ${passed}/${passed + failed} passed\n`);
  if (failed === 0) process.stderr.write('All tests passed.\n');
  else process.stderr.write(`${failed} test(s) FAILED.\n`);
  process.exit(failed > 0 ? 1 : 0);
}).catch(err => {
  process.stderr.write('Uncaught: ' + err.stack + '\n');
  process.exit(1);
});
