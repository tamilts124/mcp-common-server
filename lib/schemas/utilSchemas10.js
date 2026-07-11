"use strict";
// ── UTILITY TOOL SCHEMAS — part 10 ──────────────────────────────────────────────
// Added: color_convert (v4.146.0), number_format (v4.146.0).

const UTIL_SCHEMAS_10 = [
  {
    name: "color_convert",
    description:
      "Convert, inspect, blend, and generate color palettes from any CSS/design color format " +
      "— zero npm dependencies, pure Node.js. " +
      "Input formats accepted: #RGB, #RRGGBB, #RRGGBBAA hex, " +
      "rgb(r,g,b), rgba(r,g,b,a), hsl(h,s%,l%), hsla(h,s%,l%,a), " +
      "hsv(h,s%,v%), cmyk(c%,m%,y%,k%), and all 148 CSS named colors (red, coral, darkslateblue...). " +
      "Operations: " +
      "'info' — parse 'color' and return every representation (hex, hexLower, hex8, rgb, rgba, hsl, hsla, hsv, cmyk, components), " +
      "WCAG 2.1 relative luminance, contrast ratio vs white and black with AA/AAA rating, " +
      "text-on-background color recommendation, and any matching CSS named color. " +
      "'convert' — parse 'color' and output only the requested format(s) via 'to' (string or array: " +
      "hex, hexLower, hex8, rgb, rgba, hsl, hsla, hsv, cmyk; default: all five main formats). " +
      "'blend' — mix 'color' with 'color2' in linear RGB space by 'weight' (0=all color1, 1=all color2, default 0.5). " +
      "'palette' — generate a color scheme from 'color' by 'type': " +
      "complementary (opposite hue), triadic (120° apart), analogous (±30°), " +
      "split-complementary (150°/210°), tetradic (90° apart), monochromatic (same hue, 5 lightness steps). " +
      "Always available — does not require MCP_ALLOW_EXEC. " +
      "Returns { operation, input, inputFormat, hex, rgb, hsl, hsv, cmyk, components, wcag, ... }.",
    inputSchema: {
      type: "object",
      required: ["operation"],
      properties: {
        operation: {
          type: "string",
          description: "Operation: info, convert, blend, or palette.",
        },
        color: {
          type: "string",
          description:
            "Primary input color in any supported format: #RGB, #RRGGBB, #RRGGBBAA, " +
            "rgb(), rgba(), hsl(), hsla(), hsv(), cmyk(), or a CSS named color (e.g. 'coral').",
        },
        color2: {
          type: "string",
          description: "(blend only) Second color to blend with 'color'.",
        },
        to: {
          description:
            "(convert only) Target format(s): a single string or array. " +
            "Valid: hex, hexLower, hex8, rgb, rgba, hsl, hsla, hsv, cmyk. Default: all five main formats.",
          oneOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
        },
        weight: {
          type: "number",
          description: "(blend only) Blend weight 0–1: 0 = 100% color1, 1 = 100% color2 (default 0.5).",
        },
        type: {
          type: "string",
          description:
            "(palette only) Palette type: complementary, triadic, analogous, " +
            "split-complementary, tetradic, monochromatic (default: complementary).",
        },
      },
    },
  },
  {
    name: "number_format",
    description:
      "Format numbers for display in a wide variety of styles — zero npm dependencies, pure Node.js. " +
      "Accepts 'value' as a JS number or a numeric string (commas stripped). Operations: " +
      "'decimal' — round to 'precision' decimal places (default 2), add 'thousands_sep' (default ',') " +
      "and 'decimal_sep' (default '.'), optional forced '+' 'sign'. " +
      "'currency' — format as money: 'symbol' (default '$'), 'symbol_placement' ('before'|'after', default 'before'), " +
      "'negative_parens' flag (($1.23) instead of -$1.23), 'precision' (default 2). " +
      "'percent' — format as percentage: 'multiply' (default true: 0.42 \u2192 42%), 'precision' (default 1). " +
      "'bytes' — human-readable file size: 'mode' 'iec' (KiB/MiB/GiB, default) or 'si' (kB/MB/GB), " +
      "'precision' (default 2); returns both IEC and SI forms. " +
      "'si' — apply SI metric prefixes (k/M/G/T/m/\u03bc/n/p/f) with 'unit' suffix and 'precision' (default 3). " +
      "'ordinal' — integer to English ordinal: 1st, 2nd, 3rd, 4th, 11th, 21st... " +
      "'roman' — integer 1–3999 to Roman numerals: I, IV, IX, XLII, MCMXCIX... " +
      "'words' — integer \u2264 999,999,999,999,999 to English words: " +
      "0='zero', 42='forty-two', -5='negative five', 1000000='one million'. " +
      "'compact' — compact notation: 1500='1.5K', 2300000='2.3M', 5100000000='5.1B', 'precision' (default 1). " +
      "Always available — does not require MCP_ALLOW_EXEC.",
    inputSchema: {
      type: "object",
      required: ["operation", "value"],
      properties: {
        operation: {
          type: "string",
          description: "Formatting operation: decimal, currency, percent, bytes, si, ordinal, roman, words, compact.",
        },
        value: {
          description: "Number to format (JS number or numeric string, commas stripped automatically).",
          oneOf: [
            { type: "number" },
            { type: "string" },
          ],
        },
        // decimal / currency / percent / si / compact shared
        precision: {
          type: "number",
          description:
            "Decimal places (non-negative integer). " +
            "Defaults: decimal/currency=2, percent=1, bytes=2, si=3, compact=1.",
        },
        // decimal / currency
        thousands_sep: {
          type: "string",
          description: "(decimal/currency) Thousands separator (default ',').",
        },
        decimal_sep: {
          type: "string",
          description: "(decimal/currency) Decimal separator (default '.').",
        },
        sign: {
          type: "boolean",
          description: "(decimal) Show '+' prefix for positive values (default false).",
        },
        // currency
        symbol: {
          type: "string",
          description: "(currency) Currency symbol (default '$').",
        },
        symbol_placement: {
          type: "string",
          description: "(currency) 'before' (default) or 'after' the amount.",
        },
        negative_parens: {
          type: "boolean",
          description: "(currency) Wrap negative values in parentheses instead of using '-' (default false).",
        },
        // percent
        multiply: {
          type: "boolean",
          description: "(percent) Multiply value by 100 before formatting (default true: 0.42 \u2192 42%).",
        },
        // bytes
        mode: {
          type: "string",
          description: "(bytes) 'iec' for KiB/MiB/GiB (default) or 'si' for kB/MB/GB.",
        },
        // si
        unit: {
          type: "string",
          description: "(si) Optional unit suffix appended after the SI prefix, e.g. 'Hz', 'm', 'W' (default '').",
        },
      },
    },
  },
];

module.exports = { UTIL_SCHEMAS_10 };
