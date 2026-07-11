"use strict";
// ── color_convert — zero-dep color conversion + WCAG contrast tool ────────────
// Operations: info, convert, blend, palette
// Formats: hex, rgb, rgba, hsl, hsla, hsv, cmyk, named

const { ToolError } = require("./errors");

// ── Named CSS color table (148 standard named colors, lowercase) ──────────────
const NAMED_COLORS = {
  aliceblue:"#F0F8FF",antiquewhite:"#FAEBD7",aqua:"#00FFFF",aquamarine:"#7FFFD4",
  azure:"#F0FFFF",beige:"#F5F5DC",bisque:"#FFE4C4",black:"#000000",
  blanchedalmond:"#FFEBCD",blue:"#0000FF",blueviolet:"#8A2BE2",brown:"#A52A2A",
  burlywood:"#DEB887",cadetblue:"#5F9EA0",chartreuse:"#7FFF00",chocolate:"#D2691E",
  coral:"#FF7F50",cornflowerblue:"#6495ED",cornsilk:"#FFF8DC",crimson:"#DC143C",
  cyan:"#00FFFF",darkblue:"#00008B",darkcyan:"#008B8B",darkgoldenrod:"#B8860B",
  darkgray:"#A9A9A9",darkgreen:"#006400",darkgrey:"#A9A9A9",darkkhaki:"#BDB76B",
  darkmagenta:"#8B008B",darkolivegreen:"#556B2F",darkorange:"#FF8C00",darkorchid:"#9932CC",
  darkred:"#8B0000",darksalmon:"#E9967A",darkseagreen:"#8FBC8F",darkslateblue:"#483D8B",
  darkslategray:"#2F4F4F",darkslategrey:"#2F4F4F",darkturquoise:"#00CED1",darkviolet:"#9400D3",
  deeppink:"#FF1493",deepskyblue:"#00BFFF",dimgray:"#696969",dimgrey:"#696969",
  dodgerblue:"#1E90FF",firebrick:"#B22222",floralwhite:"#FFFAF0",forestgreen:"#228B22",
  fuchsia:"#FF00FF",gainsboro:"#DCDCDC",ghostwhite:"#F8F8FF",gold:"#FFD700",
  goldenrod:"#DAA520",gray:"#808080",green:"#008000",greenyellow:"#ADFF2F",
  grey:"#808080",honeydew:"#F0FFF0",hotpink:"#FF69B4",indianred:"#CD5C5C",
  indigo:"#4B0082",ivory:"#FFFFF0",khaki:"#F0E68C",lavender:"#E6E6FA",
  lavenderblush:"#FFF0F5",lawngreen:"#7CFC00",lemonchiffon:"#FFFACD",lightblue:"#ADD8E6",
  lightcoral:"#F08080",lightcyan:"#E0FFFF",lightgoldenrodyellow:"#FAFAD2",lightgray:"#D3D3D3",
  lightgreen:"#90EE90",lightgrey:"#D3D3D3",lightpink:"#FFB6C1",lightsalmon:"#FFA07A",
  lightseagreen:"#20B2AA",lightskyblue:"#87CEFA",lightslategray:"#778899",lightslategrey:"#778899",
  lightsteelblue:"#B0C4DE",lightyellow:"#FFFFE0",lime:"#00FF00",limegreen:"#32CD32",
  linen:"#FAF0E6",magenta:"#FF00FF",maroon:"#800000",mediumaquamarine:"#66CDAA",
  mediumblue:"#0000CD",mediumorchid:"#BA55D3",mediumpurple:"#9370DB",mediumseagreen:"#3CB371",
  mediumslateblue:"#7B68EE",mediumspringgreen:"#00FA9A",mediumturquoise:"#48D1CC",mediumvioletred:"#C71585",
  midnightblue:"#191970",mintcream:"#F5FFFA",mistyrose:"#FFE4E1",moccasin:"#FFE4B5",
  navajowhite:"#FFDEAD",navy:"#000080",oldlace:"#FDF5E6",olive:"#808000",
  olivedrab:"#6B8E23",orange:"#FFA500",orangered:"#FF4500",orchid:"#DA70D6",
  palegoldenrod:"#EEE8AA",palegreen:"#98FB98",paleturquoise:"#AFEEEE",palevioletred:"#DB7093",
  papayawhip:"#FFEFD5",peachpuff:"#FFDAB9",peru:"#CD853F",pink:"#FFC0CB",
  plum:"#DDA0DD",powderblue:"#B0E0E6",purple:"#800080",red:"#FF0000",
  rosybrown:"#BC8F8F",royalblue:"#4169E1",saddlebrown:"#8B4513",salmon:"#FA8072",
  sandybrown:"#F4A460",seagreen:"#2E8B57",seashell:"#FFF5EE",sienna:"#A0522D",
  silver:"#C0C0C0",skyblue:"#87CEEB",slateblue:"#6A5ACD",slategray:"#708090",
  slategrey:"#708090",snow:"#FFFAFA",springgreen:"#00FF7F",steelblue:"#4682B4",
  tan:"#D2B48C",teal:"#008080",thistle:"#D8BFD8",tomato:"#FF6347",
  turquoise:"#40E0D0",violet:"#EE82EE",wheat:"#F5DEB3",white:"#FFFFFF",
  whitesmoke:"#F5F5F5",yellow:"#FFFF00",yellowgreen:"#9ACD32",
};

// ── Math helpers ──────────────────────────────────────────────────────────────
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function round2(v) { return Math.round(v * 100) / 100; }
function round4(v) { return Math.round(v * 10000) / 10000; }

// ── Conversion primitives ─────────────────────────────────────────────────────

/** {r,g,b} 0-255 → {h,s,l} 0-360/0-100/0-100 */
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h, s;
  const l = (max + min) / 2;
  if (max === min) { h = s = 0; }
  else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      default: h = ((r - g) / d + 4) / 6;
    }
  }
  return { h: round2(h * 360), s: round2(s * 100), l: round2(l * 100) };
}

/** {h,s,l} 0-360/0-100/0-100 → {r,g,b} 0-255 */
function hslToRgb(h, s, l) {
  h /= 360; s /= 100; l /= 100;
  if (s === 0) { const v = Math.round(l * 255); return { r: v, g: v, b: v }; }
  function hue2rgb(p, q, t) {
    if (t < 0) t += 1; if (t > 1) t -= 1;
    if (t < 1/6) return p + (q - p) * 6 * t;
    if (t < 1/2) return q;
    if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
    return p;
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return {
    r: Math.round(hue2rgb(p, q, h + 1/3) * 255),
    g: Math.round(hue2rgb(p, q, h) * 255),
    b: Math.round(hue2rgb(p, q, h - 1/3) * 255),
  };
}

/** {r,g,b} 0-255 → {h,s,v} 0-360/0-100/0-100 */
function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h;
  const s = max === 0 ? 0 : d / max;
  const v = max;
  if (d === 0) { h = 0; }
  else {
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      default: h = ((r - g) / d + 4) / 6;
    }
  }
  return { h: round2(h * 360), s: round2(s * 100), v: round2(v * 100) };
}

/** {h,s,v} 0-360/0-100/0-100 → {r,g,b} 0-255 */
function hsvToRgb(h, s, v) {
  h /= 360; s /= 100; v /= 100;
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  let r, g, b;
  switch (i % 6) {
    case 0: r=v; g=t; b=p; break;
    case 1: r=q; g=v; b=p; break;
    case 2: r=p; g=v; b=t; break;
    case 3: r=p; g=q; b=v; break;
    case 4: r=t; g=p; b=v; break;
    default: r=v; g=p; b=q;
  }
  return { r: Math.round(r*255), g: Math.round(g*255), b: Math.round(b*255) };
}

/** {r,g,b} 0-255 → {c,m,y,k} 0-100 */
function rgbToCmyk(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const k = 1 - Math.max(r, g, b);
  if (k === 1) return { c: 0, m: 0, y: 0, k: 100 };
  return {
    c: round2((1 - r - k) / (1 - k) * 100),
    m: round2((1 - g - k) / (1 - k) * 100),
    y: round2((1 - b - k) / (1 - k) * 100),
    k: round2(k * 100),
  };
}

/** {c,m,y,k} 0-100 → {r,g,b} 0-255 */
function cmykToRgb(c, m, y, k) {
  c /= 100; m /= 100; y /= 100; k /= 100;
  return {
    r: Math.round(255 * (1 - c) * (1 - k)),
    g: Math.round(255 * (1 - m) * (1 - k)),
    b: Math.round(255 * (1 - y) * (1 - k)),
  };
}

/** {r,g,b} 0-255 → "#RRGGBB" */
function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** "#RGB" | "#RRGGBB" | "#RRGGBBAA" → {r,g,b,a} */
function parseHex(hex) {
  const h = hex.replace('#', '');
  if (h.length === 3) {
    return {
      r: parseInt(h[0]+h[0], 16),
      g: parseInt(h[1]+h[1], 16),
      b: parseInt(h[2]+h[2], 16),
      a: 1,
    };
  }
  if (h.length === 6) {
    return {
      r: parseInt(h.slice(0,2), 16),
      g: parseInt(h.slice(2,4), 16),
      b: parseInt(h.slice(4,6), 16),
      a: 1,
    };
  }
  if (h.length === 8) {
    return {
      r: parseInt(h.slice(0,2), 16),
      g: parseInt(h.slice(2,4), 16),
      b: parseInt(h.slice(4,6), 16),
      a: round4(parseInt(h.slice(6,8), 16) / 255),
    };
  }
  throw new ToolError(`color_convert: invalid hex color '${hex}'.`, -32602);
}

// ── Parse any supported input format → {r,g,b,a} ─────────────────────────────
function parseColor(input) {
  if (typeof input !== 'string' || !input.trim())
    throw new ToolError('color_convert: color input must be a non-empty string.', -32602);
  const s = input.trim();

  // Named
  const named = NAMED_COLORS[s.toLowerCase()];
  if (named) return { ...parseHex(named), inputFormat: 'named', inputName: s.toLowerCase() };

  // Hex
  if (/^#[0-9A-Fa-f]{3}$/.test(s) || /^#[0-9A-Fa-f]{6}$/.test(s) || /^#[0-9A-Fa-f]{8}$/.test(s)) {
    return { ...parseHex(s), inputFormat: 'hex' };
  }

  // rgb(r, g, b) or rgba(r, g, b, a)
  let m = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i);
  if (m) {
    return {
      r: clamp(Math.round(parseFloat(m[1])), 0, 255),
      g: clamp(Math.round(parseFloat(m[2])), 0, 255),
      b: clamp(Math.round(parseFloat(m[3])), 0, 255),
      a: m[4] !== undefined ? clamp(parseFloat(m[4]), 0, 1) : 1,
      inputFormat: m[4] !== undefined ? 'rgba' : 'rgb',
    };
  }

  // hsl(h, s%, l%) or hsla(h, s%, l%, a)
  m = s.match(/^hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%?\s*,\s*([\d.]+)%?(?:\s*,\s*([\d.]+))?\s*\)$/i);
  if (m) {
    const { r, g, b } = hslToRgb(
      clamp(parseFloat(m[1]), 0, 360),
      clamp(parseFloat(m[2]), 0, 100),
      clamp(parseFloat(m[3]), 0, 100),
    );
    return {
      r, g, b,
      a: m[4] !== undefined ? clamp(parseFloat(m[4]), 0, 1) : 1,
      inputFormat: m[4] !== undefined ? 'hsla' : 'hsl',
    };
  }

  // hsv(h, s%, v%)
  m = s.match(/^hsv\(\s*([\d.]+)\s*,\s*([\d.]+)%?\s*,\s*([\d.]+)%?\s*\)$/i);
  if (m) {
    const { r, g, b } = hsvToRgb(
      clamp(parseFloat(m[1]), 0, 360),
      clamp(parseFloat(m[2]), 0, 100),
      clamp(parseFloat(m[3]), 0, 100),
    );
    return { r, g, b, a: 1, inputFormat: 'hsv' };
  }

  // cmyk(c%, m%, y%, k%)
  m = s.match(/^cmyk\(\s*([\d.]+)%?\s*,\s*([\d.]+)%?\s*,\s*([\d.]+)%?\s*,\s*([\d.]+)%?\s*\)$/i);
  if (m) {
    const { r, g, b } = cmykToRgb(
      clamp(parseFloat(m[1]), 0, 100),
      clamp(parseFloat(m[2]), 0, 100),
      clamp(parseFloat(m[3]), 0, 100),
      clamp(parseFloat(m[4]), 0, 100),
    );
    return { r, g, b, a: 1, inputFormat: 'cmyk' };
  }

  throw new ToolError(
    `color_convert: cannot parse color '${s}'. ` +
    'Accepted formats: #RGB, #RRGGBB, #RRGGBBAA, rgb(), rgba(), hsl(), hsla(), hsv(), cmyk(), CSS named colors.',
    -32602
  );
}

// ── Representation builder from {r,g,b,a} ────────────────────────────────────
function buildRepresentations(r, g, b, a) {
  const hex = rgbToHex(r, g, b);
  const hexLower = hex.toLowerCase();
  const hsl = rgbToHsl(r, g, b);
  const hsv = rgbToHsv(r, g, b);
  const cmyk = rgbToCmyk(r, g, b);
  const alpha = round4(a);
  return {
    hex,
    hexLower,
    hex8: hex + Math.round(alpha * 255).toString(16).padStart(2, '0').toUpperCase(),
    rgb:  `rgb(${r}, ${g}, ${b})`,
    rgba: `rgba(${r}, ${g}, ${b}, ${alpha})`,
    hsl:  `hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)`,
    hsla: `hsla(${hsl.h}, ${hsl.s}%, ${hsl.l}%, ${alpha})`,
    hsv:  `hsv(${hsv.h}, ${hsv.s}%, ${hsv.v}%)`,
    cmyk: `cmyk(${cmyk.c}%, ${cmyk.m}%, ${cmyk.y}%, ${cmyk.k}%)`,
    components: { r, g, b, a: alpha, h: hsl.h, s: hsl.s, l: hsl.l, sv: hsv.s, v: hsv.v, c: cmyk.c, m: cmyk.m, y: cmyk.y, k: cmyk.k },
  };
}

// ── WCAG 2.1 relative luminance + contrast ratio ──────────────────────────────
function linearize(c) {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
function luminance(r, g, b) {
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}
function contrastRatio(r1, g1, b1, r2, g2, b2) {
  const l1 = luminance(r1, g1, b1), l2 = luminance(r2, g2, b2);
  const lighter = Math.max(l1, l2), darker = Math.min(l1, l2);
  return round2((lighter + 0.05) / (darker + 0.05));
}
function wcagRating(ratio) {
  if (ratio >= 7) return 'AAA';
  if (ratio >= 4.5) return 'AA';
  if (ratio >= 3) return 'AA Large';
  return 'Fail';
}

// ── Hue rotation ─────────────────────────────────────────────────────────────
function rotateHue(r, g, b, degrees) {
  const hsl = rgbToHsl(r, g, b);
  const h = ((hsl.h + degrees) % 360 + 360) % 360;
  return hslToRgb(h, hsl.s, hsl.l);
}

// ── Main export ───────────────────────────────────────────────────────────────
function colorConvert(args) {
  const op = (args.operation || '').trim();
  if (!op)
    throw new ToolError("color_convert: 'operation' is required. Valid: info, convert, blend, palette.", -32602);

  switch (op) {
    // ── info ─────────────────────────────────────────────────────────────────
    case 'info': {
      if (args.color == null)
        throw new ToolError("color_convert(info): 'color' is required.", -32602);
      const { r, g, b, a, inputFormat, inputName } = parseColor(args.color);
      const reps = buildRepresentations(r, g, b, a);
      // Lookup matching named color
      const hexUpper = reps.hex;
      const matchedName = Object.entries(NAMED_COLORS).find(([, v]) => v === hexUpper)?.[0] || null;

      const crWhite = contrastRatio(r, g, b, 255, 255, 255);
      const crBlack = contrastRatio(r, g, b, 0, 0, 0);
      const betterOn = crWhite >= crBlack ? 'white' : 'black';

      return {
        operation: 'info',
        input: args.color,
        inputFormat,
        ...(inputName && { inputName }),
        ...reps,
        cssName: matchedName,
        wcag: {
          luminance: round4(luminance(r, g, b)),
          contrastOnWhite: crWhite,
          contrastOnBlack: crBlack,
          ratingOnWhite:   wcagRating(crWhite),
          ratingOnBlack:   wcagRating(crBlack),
          textColorRecommendation: betterOn,
        },
      };
    }

    // ── convert ───────────────────────────────────────────────────────────────
    case 'convert': {
      if (args.color == null)
        throw new ToolError("color_convert(convert): 'color' is required.", -32602);
      const formats = args.to
        ? (Array.isArray(args.to) ? args.to : [args.to])
        : ['hex', 'rgb', 'hsl', 'hsv', 'cmyk'];
      const validFmts = new Set(['hex','hex8','hexLower','rgb','rgba','hsl','hsla','hsv','cmyk']);
      for (const f of formats) {
        if (!validFmts.has(f))
          throw new ToolError(`color_convert(convert): unknown format '${f}'. Valid: ${[...validFmts].join(', ')}.`, -32602);
      }

      const { r, g, b, a, inputFormat } = parseColor(args.color);
      const reps = buildRepresentations(r, g, b, a);

      const result = {};
      for (const f of formats) result[f] = reps[f];

      return { operation: 'convert', input: args.color, inputFormat, to: formats, result };
    }

    // ── blend ─────────────────────────────────────────────────────────────────
    case 'blend': {
      if (args.color == null || args.color2 == null)
        throw new ToolError("color_convert(blend): 'color' and 'color2' are required.", -32602);
      const weight = typeof args.weight === 'number' ? clamp(args.weight, 0, 1) : 0.5;

      const c1 = parseColor(args.color);
      const c2 = parseColor(args.color2);

      const r = Math.round(c1.r * (1 - weight) + c2.r * weight);
      const g = Math.round(c1.g * (1 - weight) + c2.g * weight);
      const b = Math.round(c1.b * (1 - weight) + c2.b * weight);
      const a = round4(c1.a * (1 - weight) + c2.a * weight);

      const reps = buildRepresentations(r, g, b, a);
      return {
        operation: 'blend',
        color1: args.color,
        color2: args.color2,
        weight,
        ...reps,
      };
    }

    // ── palette ───────────────────────────────────────────────────────────────
    case 'palette': {
      if (args.color == null)
        throw new ToolError("color_convert(palette): 'color' is required.", -32602);
      const type = (args.type || 'complementary').toLowerCase();
      const validTypes = new Set(['complementary','triadic','analogous','split-complementary','tetradic','monochromatic']);
      if (!validTypes.has(type))
        throw new ToolError(
          `color_convert(palette): unknown type '${type}'. Valid: ${[...validTypes].join(', ')}.`, -32602
        );

      const { r, g, b } = parseColor(args.color);
      const { h, s, l } = rgbToHsl(r, g, b);

      let angles;
      switch (type) {
        case 'complementary':      angles = [0, 180]; break;
        case 'triadic':            angles = [0, 120, 240]; break;
        case 'analogous':          angles = [-30, 0, 30]; break;
        case 'split-complementary':angles = [0, 150, 210]; break;
        case 'tetradic':           angles = [0, 90, 180, 270]; break;
        case 'monochromatic': {
          // 5 shades same hue, varying lightness
          const shades = [80, 60, l, 35, 15].map(ll => {
            const rgb = hslToRgb(h, s, ll);
            return { ...buildRepresentations(rgb.r, rgb.g, rgb.b, 1), lightness: ll };
          });
          return { operation: 'palette', type, base: args.color, colors: shades };
        }
      }

      const colors = angles.map(angle => {
        const nh = ((h + angle) % 360 + 360) % 360;
        const rgb = hslToRgb(nh, s, l);
        return { ...buildRepresentations(rgb.r, rgb.g, rgb.b, 1), hue: round2(nh) };
      });

      return { operation: 'palette', type, base: args.color, colors };
    }

    default:
      throw new ToolError(
        `color_convert: unknown operation '${op}'. Valid: info, convert, blend, palette.`,
        -32602
      );
  }
}

module.exports = { colorConvert };
