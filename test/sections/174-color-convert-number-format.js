"use strict";
/**
 * test/sections/174-color-convert-number-format.js
 * Isolated functional tests for color_convert and number_format.
 * Section [174] — 5 rigor levels (A-E) per tool, 10 sub-sections total.
 */
const { test } = require("../test-harness");
const { colorConvert } = require("../../lib/colorConvertOps");
const { numberFormat } = require("../../lib/numberFormatOps");

function assert(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
function assertThrows(fn, check) {
  let threw = false, err;
  try { fn(); } catch (e) { threw = true; err = e; }
  assert(threw, "expected an error to be thrown");
  if (check) check(err);
}

// ============================================================
// Section A: color_convert — Normal (happy-path)
// ============================================================

test("[174-A1] color_convert info from hex #FF0000", () => {
  const r = colorConvert({ operation: 'info', color: '#FF0000' });
  assert(r.operation === 'info', `operation=${r.operation}`);
  assert(r.hex === '#FF0000', `hex=${r.hex}`);
  assert(r.rgb === 'rgb(255, 0, 0)', `rgb=${r.rgb}`);
  assert(r.components.h === 0, `h=${r.components.h}`);
  assert(r.components.s === 100, `s=${r.components.s}`);
  assert(r.cssName === 'red', `cssName=${r.cssName}`);
  assert(r.wcag.luminance > 0.2 && r.wcag.luminance < 0.22, `luminance=${r.wcag.luminance}`);
  assert(r.wcag.contrastOnWhite < r.wcag.contrastOnBlack, 'contrast order');
  assert(r.wcag.textColorRecommendation === 'black', `textRec=${r.wcag.textColorRecommendation}`);
});

test("[174-A2] color_convert info from named color 'coral'", () => {
  const r = colorConvert({ operation: 'info', color: 'coral' });
  assert(typeof r.hex === 'string' && r.hex.startsWith('#'), `hex=${r.hex}`);
  assert(r.inputFormat === 'named', `inputFormat=${r.inputFormat}`);
  assert(r.inputName === 'coral', `inputName=${r.inputName}`);
});

test("[174-A3] color_convert convert to hsl, rgb, cmyk", () => {
  const r = colorConvert({ operation: 'convert', color: '#336699', to: ['hsl', 'rgb', 'cmyk'] });
  assert(r.operation === 'convert', `op=${r.operation}`);
  assert(typeof r.result.hsl === 'string' && r.result.hsl.startsWith('hsl('), `hsl=${r.result.hsl}`);
  assert(typeof r.result.rgb === 'string', `rgb=${r.result.rgb}`);
  assert(typeof r.result.cmyk === 'string' && r.result.cmyk.startsWith('cmyk('), `cmyk=${r.result.cmyk}`);
});

test("[174-A4] color_convert blend 50-50 black+white gives mid-gray", () => {
  const r = colorConvert({ operation: 'blend', color: '#000000', color2: '#FFFFFF', weight: 0.5 });
  assert(r.hex === '#7F7F7F' || r.hex === '#808080', `hex=${r.hex}`);
  assert(r.weight === 0.5, `weight=${r.weight}`);
});

test("[174-A5] color_convert palette complementary = 2 colors", () => {
  const r = colorConvert({ operation: 'palette', color: '#FF0000', type: 'complementary' });
  assert(Array.isArray(r.colors) && r.colors.length === 2, `len=${r.colors.length}`);
  assert(r.type === 'complementary', `type=${r.type}`);
});

test("[174-A6] color_convert palette triadic = 3 colors", () => {
  const r = colorConvert({ operation: 'palette', color: '#FF0000', type: 'triadic' });
  assert(r.colors.length === 3, `len=${r.colors.length}`);
});

test("[174-A7] color_convert palette monochromatic = 5 shades each with hex", () => {
  const r = colorConvert({ operation: 'palette', color: '#336699', type: 'monochromatic' });
  assert(r.colors.length === 5, `len=${r.colors.length}`);
  assert(r.colors.every(c => typeof c.hex === 'string'), 'all have hex');
});

test("[174-A8] color_convert info from hsl() input — round-trip hue", () => {
  const r = colorConvert({ operation: 'info', color: 'hsl(120, 50%, 50%)' });
  assert(r.inputFormat === 'hsl', `inputFormat=${r.inputFormat}`);
  assert(Math.abs(r.components.h - 120) <= 1, `hue=${r.components.h}`);
});

test("[174-A9] color_convert info from hsv() — blue", () => {
  const r = colorConvert({ operation: 'info', color: 'hsv(240, 100%, 100%)' });
  assert(r.hex === '#0000FF', `hex=${r.hex}`);
});

test("[174-A10] color_convert info from cmyk(0,0,0,0%) — white", () => {
  const r = colorConvert({ operation: 'info', color: 'cmyk(0%, 0%, 0%, 0%)' });
  assert(r.hex === '#FFFFFF', `hex=${r.hex}`);
});

// ============================================================
// Section B: color_convert — Medium (edge values)
// ============================================================

test("[174-B1] color_convert short hex #F00 expands to #FF0000", () => {
  assert(colorConvert({ operation: 'info', color: '#F00' }).hex === '#FF0000');
});

test("[174-B2] color_convert hex8 #FF000080 — alpha ~0.502", () => {
  const r = colorConvert({ operation: 'info', color: '#FF000080' });
  assert(r.inputFormat === 'hex', `inputFormat=${r.inputFormat}`);
  assert(r.components.a > 0.49 && r.components.a < 0.51, `alpha=${r.components.a}`);
});

test("[174-B3] color_convert rgba() input preserves alpha", () => {
  const r = colorConvert({ operation: 'info', color: 'rgba(255, 128, 0, 0.75)' });
  assert(r.inputFormat === 'rgba', `inputFormat=${r.inputFormat}`);
  assert(Math.abs(r.components.a - 0.75) < 0.01, `alpha=${r.components.a}`);
});

test("[174-B4] color_convert WCAG for black", () => {
  const r = colorConvert({ operation: 'info', color: '#000000' });
  assert(r.wcag.luminance === 0, `lum=${r.wcag.luminance}`);
  assert(r.wcag.contrastOnWhite === 21, `cr=${r.wcag.contrastOnWhite}`);
  assert(r.wcag.textColorRecommendation === 'white', `textRec=${r.wcag.textColorRecommendation}`);
});

test("[174-B5] color_convert WCAG for white", () => {
  const r = colorConvert({ operation: 'info', color: 'white' });
  assert(r.wcag.luminance === 1, `lum=${r.wcag.luminance}`);
  assert(r.wcag.ratingOnBlack === 'AAA', `rating=${r.wcag.ratingOnBlack}`);
});

test("[174-B6] color_convert blend weight=0 returns color1", () => {
  assert(colorConvert({ operation: 'blend', color: '#FF0000', color2: '#0000FF', weight: 0 }).hex === '#FF0000');
});

test("[174-B7] color_convert blend weight=1 returns color2", () => {
  assert(colorConvert({ operation: 'blend', color: '#FF0000', color2: '#0000FF', weight: 1 }).hex === '#0000FF');
});

test("[174-B8] color_convert convert with no 'to' returns default formats", () => {
  const r = colorConvert({ operation: 'convert', color: 'black' });
  assert('hex' in r.result, 'missing hex');
  assert('rgb' in r.result, 'missing rgb');
  assert('hsl' in r.result, 'missing hsl');
});

// ============================================================
// Section C: color_convert — High (structural / format coverage)
// ============================================================

test("[174-C1] color_convert palette tetradic = 4 colors", () => {
  assert(colorConvert({ operation: 'palette', color: '#FF6600', type: 'tetradic' }).colors.length === 4);
});

test("[174-C2] color_convert palette analogous = 3 colors", () => {
  assert(colorConvert({ operation: 'palette', color: '#336699', type: 'analogous' }).colors.length === 3);
});

test("[174-C3] color_convert palette split-complementary = 3 colors", () => {
  assert(colorConvert({ operation: 'palette', color: '#FF0000', type: 'split-complementary' }).colors.length === 3);
});

test("[174-C4] color_convert convert to hex8 has length 9", () => {
  const r = colorConvert({ operation: 'convert', color: 'rgba(255,0,0,0.5)', to: 'hex8' });
  assert(r.result.hex8.length === 9, `hex8=${r.result.hex8}`);
});

test("[174-C5] color_convert convert to hexLower is all lowercase", () => {
  const r = colorConvert({ operation: 'convert', color: '#AABBCC', to: 'hexLower' });
  assert(r.result.hexLower === r.result.hexLower.toLowerCase(), `hexLower=${r.result.hexLower}`);
});

// ============================================================
// Section D: color_convert — Critical (validation / errors)
// ============================================================

test("[174-D1] color_convert missing operation throws", () => {
  assertThrows(
    () => colorConvert({ color: '#FF0000' }),
    e => assert(e.message.includes('operation'), `msg=${e.message}`)
  );
});

test("[174-D2] color_convert unknown operation throws", () => {
  assertThrows(
    () => colorConvert({ operation: 'INVALID', color: '#FF0000' }),
    e => assert(e.message.toLowerCase().includes('unknown') || e.message.includes('INVALID'), `msg=${e.message}`)
  );
});

test("[174-D3] color_convert invalid hex throws", () => {
  assertThrows(() => colorConvert({ operation: 'info', color: '#GGGGGG' }));
});

test("[174-D4] color_convert unparseable color string throws", () => {
  assertThrows(() => colorConvert({ operation: 'info', color: 'not-a-color' }));
});

test("[174-D5] color_convert blend missing color2 throws", () => {
  assertThrows(
    () => colorConvert({ operation: 'blend', color: '#FF0000' }),
    e => assert(e.message.includes('color2'), `msg=${e.message}`)
  );
});

test("[174-D6] color_convert unknown palette type throws", () => {
  assertThrows(
    () => colorConvert({ operation: 'palette', color: '#FF0000', type: 'rainbow' }),
    e => assert(e.message.includes('rainbow'), `msg=${e.message}`)
  );
});

test("[174-D7] color_convert unknown convert format throws", () => {
  assertThrows(() => colorConvert({ operation: 'convert', color: '#FF0000', to: 'xyz' }));
});

// ============================================================
// Section E: color_convert — Extreme (stress)
// ============================================================

test("[174-E1] color_convert 101 blend steps all succeed", () => {
  for (let i = 0; i <= 100; i++) {
    const r = colorConvert({ operation: 'blend', color: '#000000', color2: '#FFFFFF', weight: i / 100 });
    assert(r.hex, `step ${i}: no hex`);
  }
});

test("[174-E2] color_convert sample named colors all parse", () => {
  const names = ['red','blue','green','white','black','coral','goldenrod','darkslateblue',
    'lightcyan','mediumseagreen','lavender','turquoise','tomato','sienna','plum'];
  for (const name of names) {
    const r = colorConvert({ operation: 'info', color: name });
    assert(r.hex, `${name}: no hex`);
  }
});

// ============================================================
// Section F: number_format — Normal (happy-path)
// ============================================================

test("[174-F1] number_format decimal 1234567.891 → 1,234,567.89", () => {
  const r = numberFormat({ operation: 'decimal', value: 1234567.891 });
  assert(r.operation === 'decimal', `op=${r.operation}`);
  assert(r.result.includes(','), 'no thousands sep');
  assert(r.result === '1,234,567.89', `result=${r.result}`);
});

test("[174-F2] number_format decimal negative has minus prefix", () => {
  assert(numberFormat({ operation: 'decimal', value: -42.5, precision: 1 }).result.startsWith('-'));
});

test("[174-F3] number_format currency USD → $9,999.99", () => {
  assert(numberFormat({ operation: 'currency', value: 9999.99 }).result === '$9,999.99');
});

test("[174-F4] number_format currency EUR after symbol", () => {
  const r = numberFormat({ operation: 'currency', value: 1234.5, symbol: '\u20ac', symbol_placement: 'after', precision: 2 });
  assert(r.result.endsWith('\u20ac'), `result=${r.result}`);
});

test("[174-F5] number_format percent 0.4235 → 42.4%", () => {
  assert(numberFormat({ operation: 'percent', value: 0.4235, precision: 1 }).result === '42.4%');
});

test("[174-F6] number_format percent no-multiply 75 → 75%", () => {
  assert(numberFormat({ operation: 'percent', value: 75, multiply: false, precision: 0 }).result === '75%');
});

test("[174-F7] number_format bytes IEC 1073741824 → 1.00 GiB", () => {
  assert(numberFormat({ operation: 'bytes', value: 1073741824 }).result === '1.00 GiB');
});

test("[174-F8] number_format bytes SI 1000000 → 1.00 MB", () => {
  assert(numberFormat({ operation: 'bytes', value: 1000000, mode: 'si' }).result === '1.00 MB');
});

test("[174-F9] number_format si 5e6 Hz → 5.0 MHz", () => {
  assert(numberFormat({ operation: 'si', value: 5e6, unit: 'Hz', precision: 1 }).result === '5.0 MHz');
});

test("[174-F10] number_format ordinals: 1st-23rd and 101st", () => {
  const cases = [[1,'1st'],[2,'2nd'],[3,'3rd'],[4,'4th'],[11,'11th'],[12,'12th'],[13,'13th'],
    [21,'21st'],[22,'22nd'],[23,'23rd'],[101,'101st']];
  for (const [v, expected] of cases) {
    const r = numberFormat({ operation: 'ordinal', value: v });
    assert(r.result === expected, `${v}: got ${r.result}`);
  }
});

test("[174-F11] number_format roman numerals spot-check", () => {
  const cases = [[1,'I'],[4,'IV'],[9,'IX'],[14,'XIV'],[40,'XL'],[90,'XC'],
    [400,'CD'],[900,'CM'],[1999,'MCMXCIX'],[2024,'MMXXIV']];
  for (const [v, expected] of cases) {
    const r = numberFormat({ operation: 'roman', value: v });
    assert(r.result === expected, `${v}: got ${r.result}`);
  }
});

test("[174-F12] number_format words conversion", () => {
  const cases = [
    [0,'zero'],[1,'one'],[12,'twelve'],[42,'forty-two'],[100,'one hundred'],
    [1000,'one thousand'],[1000000,'one million'],[-5,'negative five'],
  ];
  for (const [v, expected] of cases) {
    const r = numberFormat({ operation: 'words', value: v });
    assert(r.result === expected, `${v}: got '${r.result}' expected '${expected}'`);
  }
});

test("[174-F13] number_format compact K: 1500 → 1.5K", () => {
  assert(numberFormat({ operation: 'compact', value: 1500, precision: 1 }).result === '1.5K');
});

test("[174-F14] number_format compact M: 2300000 → 2.3M", () => {
  assert(numberFormat({ operation: 'compact', value: 2300000, precision: 1 }).result === '2.3M');
});

test("[174-F15] number_format compact B: 5100000000 → 5.1B", () => {
  assert(numberFormat({ operation: 'compact', value: 5100000000, precision: 1 }).result === '5.1B');
});

// ============================================================
// Section G: number_format — Medium (edge values)
// ============================================================

test("[174-G1] number_format decimal European separators", () => {
  const r = numberFormat({ operation: 'decimal', value: 1234567.89, thousands_sep: '.', decimal_sep: ',' });
  assert(r.result === '1.234.567,89', `result=${r.result}`);
});

test("[174-G2] number_format decimal precision=0 rounds", () => {
  assert(numberFormat({ operation: 'decimal', value: 1234.5678, precision: 0 }).result === '1,235');
});

test("[174-G3] number_format currency negative_parens", () => {
  const r = numberFormat({ operation: 'currency', value: -42.5, negative_parens: true });
  assert(r.result.startsWith('('), `start: ${r.result}`);
  assert(r.result.endsWith(')'), `end: ${r.result}`);
});

test("[174-G4] number_format decimal sign=true forces plus on positive", () => {
  assert(numberFormat({ operation: 'decimal', value: 42, sign: true, precision: 0 }).result === '+42');
});

test("[174-G5] number_format bytes both field present", () => {
  const r = numberFormat({ operation: 'bytes', value: 1048576 });
  assert(r.both.iec === '1.00 MiB', `iec=${r.both.iec}`);
  assert(typeof r.both.si === 'string', `si=${r.both.si}`);
});

test("[174-G6] number_format compact T: 2e12 → 2T", () => {
  assert(numberFormat({ operation: 'compact', value: 2e12, precision: 0 }).result === '2T');
});

test("[174-G7] number_format si milli prefix for 0.005 m", () => {
  assert(numberFormat({ operation: 'si', value: 0.005, unit: 'm', precision: 1 }).prefix === 'm');
});

test("[174-G8] number_format si no prefix for 500 W", () => {
  assert(numberFormat({ operation: 'si', value: 500, unit: 'W', precision: 1 }).prefix === '');
});

test("[174-G9] number_format accepts numeric string with commas", () => {
  assert(numberFormat({ operation: 'decimal', value: '1,234.56', precision: 2 }).result === '1,234.56');
});

// ============================================================
// Section H: number_format — High (error / boundary)
// ============================================================

test("[174-H1] number_format roman >3999 throws", () => {
  assertThrows(() => numberFormat({ operation: 'roman', value: 4000 }));
});

test("[174-H2] number_format roman 0 throws", () => {
  assertThrows(() => numberFormat({ operation: 'roman', value: 0 }));
});

test("[174-H3] number_format words float throws", () => {
  assertThrows(() => numberFormat({ operation: 'words', value: 3.14 }));
});

test("[174-H4] number_format ordinal float throws", () => {
  assertThrows(() => numberFormat({ operation: 'ordinal', value: 1.5 }));
});

test("[174-H5] number_format NaN string throws", () => {
  assertThrows(() => numberFormat({ operation: 'decimal', value: 'hello' }));
});

test("[174-H6] number_format Infinity throws", () => {
  assertThrows(() => numberFormat({ operation: 'decimal', value: Infinity }));
});

// ============================================================
// Section I: number_format — Critical (missing fields / security)
// ============================================================

test("[174-I1] number_format missing operation throws", () => {
  assertThrows(() => numberFormat({ value: 42 }));
});

test("[174-I2] number_format missing value throws", () => {
  assertThrows(() => numberFormat({ operation: 'decimal' }));
});

test("[174-I3] number_format unknown operation throws", () => {
  assertThrows(() => numberFormat({ operation: 'INVALID', value: 1 }));
});

test("[174-I4] number_format separator passthrough (no code execution)", () => {
  const r = numberFormat({ operation: 'decimal', value: 1234, thousands_sep: '<script>', precision: 0 });
  assert(r.result.includes('<script>'), `result=${r.result}`);
});

// ============================================================
// Section J: number_format — Extreme (stress)
// ============================================================

test("[174-J1] number_format 1000 ordinal calls all well-formed", () => {
  for (let i = 1; i <= 1000; i++) {
    const r = numberFormat({ operation: 'ordinal', value: i });
    assert(/\d+(st|nd|rd|th)$/.test(r.result), `${i}: ${r.result}`);
  }
});

test("[174-J2] number_format roman 1-3999 spot-checks produce output", () => {
  const spots = [1, 100, 500, 999, 1000, 2000, 3000, 3999];
  for (const v of spots) {
    assert(numberFormat({ operation: 'roman', value: v }).result, `no result for ${v}`);
  }
});

test("[174-J3] number_format words max integer contains trillion", () => {
  // 999,999,999,999,999 = 999 trillion (< 1 quadrillion = 10^15)
  const r = numberFormat({ operation: 'words', value: 999999999999999 });
  assert(r.result.includes('trillion'), `result=${r.result}`);
  assert(r.result.startsWith('nine hundred ninety-nine trillion'), `result=${r.result}`);
});

test("[174-J4] number_format compact negative M", () => {
  const r = numberFormat({ operation: 'compact', value: -5500000, precision: 1 });
  assert(r.result.startsWith('-'), `result=${r.result}`);
  assert(r.result.includes('M'), `result=${r.result}`);
});

console.error('[174] color_convert + number_format section done.');
