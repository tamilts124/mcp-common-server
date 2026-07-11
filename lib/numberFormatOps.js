"use strict";
// ── number_format — zero-dep versatile number formatting tool ─────────────
// Operations: decimal, currency, percent, bytes, si, ordinal, roman, words, compact

const { ToolError } = require("./errors");

// ── Parse input value ───────────────────────────────────────────────────────────
function parseValue(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new ToolError(`number_format: value must be a finite number (got ${value}).`, -32602);
    return value;
  }
  if (typeof value === 'string') {
    const v = Number(value.replace(/,/g, '').trim());
    if (!Number.isFinite(v))
      throw new ToolError(`number_format: cannot parse '${value}' as a number.`, -32602);
    return v;
  }
  throw new ToolError("number_format: 'value' must be a number or numeric string.", -32602);
}

// ── Decimal / thousands formatting ────────────────────────────────────────────────
function formatDecimalStr(num, precision, thousands, decimal, sign) {
  const absNum = Math.abs(num);
  const fixed = absNum.toFixed(precision);
  const [intPart, fracPart] = fixed.split('.');
  // Thousands separators
  const intFormatted = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, thousands);
  const result = fracPart !== undefined ? intFormatted + decimal + fracPart : intFormatted;
  // Sign
  if (num < 0) return '-' + result;
  if (sign && num > 0) return '+' + result;
  return result;
}

// ── SI unit prefixes ─────────────────────────────────────────────────────────────
const SI_PREFIXES_POS = [
  { value: 1e24,  symbol: 'Y',  name: 'yotta' },
  { value: 1e21,  symbol: 'Z',  name: 'zetta' },
  { value: 1e18,  symbol: 'E',  name: 'exa'   },
  { value: 1e15,  symbol: 'P',  name: 'peta'  },
  { value: 1e12,  symbol: 'T',  name: 'tera'  },
  { value: 1e9,   symbol: 'G',  name: 'giga'  },
  { value: 1e6,   symbol: 'M',  name: 'mega'  },
  { value: 1e3,   symbol: 'k',  name: 'kilo'  },
];
const SI_PREFIXES_NEG = [
  { value: 1e-3,  symbol: 'm',  name: 'milli' },
  { value: 1e-6,  symbol: '\u03bc',  name: 'micro' },
  { value: 1e-9,  symbol: 'n',  name: 'nano'  },
  { value: 1e-12, symbol: 'p',  name: 'pico'  },
  { value: 1e-15, symbol: 'f',  name: 'femto' },
];

// ── Roman numerals (1–3999) ───────────────────────────────────────────────────────
const ROMAN_TABLE = [
  [1000,'M'],[900,'CM'],[500,'D'],[400,'CD'],[100,'C'],[90,'XC'],
  [50,'L'],[40,'XL'],[10,'X'],[9,'IX'],[5,'V'],[4,'IV'],[1,'I'],
];
function toRoman(n) {
  if (!Number.isInteger(n) || n < 1 || n > 3999)
    throw new ToolError(`number_format(roman): value must be an integer between 1 and 3999 (got ${n}).`, -32602);
  let result = '', rem = n;
  for (const [val, sym] of ROMAN_TABLE) {
    while (rem >= val) { result += sym; rem -= val; }
  }
  return result;
}

// ── Number to English words ──────────────────────────────────────────────────────
const ONES = ['','one','two','three','four','five','six','seven','eight','nine',
  'ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen',
  'seventeen','eighteen','nineteen'];
const TENS = ['','','twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'];
const SCALES = ['','thousand','million','billion','trillion','quadrillion','quintillion'];

function wordsUnder1000(n) {
  if (n === 0) return '';
  if (n < 20) return ONES[n];
  if (n < 100) {
    const t = TENS[Math.floor(n / 10)];
    const o = ONES[n % 10];
    return o ? t + '-' + o : t;
  }
  const h = Math.floor(n / 100);
  const rem = n % 100;
  const tail = rem > 0 ? ' ' + wordsUnder1000(rem) : '';
  return ONES[h] + ' hundred' + tail;
}

function toWords(n) {
  if (!Number.isInteger(n) || Math.abs(n) > 999999999999999)
    throw new ToolError(`number_format(words): value must be an integer with |value| <= 999,999,999,999,999.`, -32602);
  if (n === 0) return 'zero';
  const neg = n < 0;
  let num = Math.abs(n);
  const parts = [];
  let scaleIdx = 0;
  while (num > 0) {
    const chunk = num % 1000;
    if (chunk !== 0) {
      const scale = SCALES[scaleIdx];
      const word = wordsUnder1000(chunk);
      parts.unshift(scale ? word + ' ' + scale : word);
    }
    num = Math.floor(num / 1000);
    scaleIdx++;
  }
  const joined = parts.join(', ');
  return neg ? 'negative ' + joined : joined;
}

// ── Byte formatting ──────────────────────────────────────────────────────────────
const IEC_UNITS = ['B','KiB','MiB','GiB','TiB','PiB','EiB'];
const SI_BYTE_UNITS = ['B','kB','MB','GB','TB','PB','EB'];

function formatBytes(bytes, mode, precision) {
  const p = typeof precision === 'number' ? precision : 2;
  const neg = bytes < 0;
  const abs = Math.abs(bytes);
  const base = mode === 'si' ? 1000 : 1024;
  const units = mode === 'si' ? SI_BYTE_UNITS : IEC_UNITS;
  if (abs < base) return (neg ? '-' : '') + abs.toFixed(p) + ' B';
  let i = 0;
  let val = abs;
  while (val >= base && i < units.length - 1) { val /= base; i++; }
  return (neg ? '-' : '') + val.toFixed(p) + ' ' + units[i];
}

// ── Main export ──────────────────────────────────────────────────────────────
function numberFormat(args) {
  const op = (args.operation || '').trim();
  if (!op)
    throw new ToolError(
      "number_format: 'operation' is required. Valid: decimal, currency, percent, bytes, si, ordinal, roman, words, compact.",
      -32602
    );
  if (args.value == null)
    throw new ToolError("number_format: 'value' is required.", -32602);

  const num = parseValue(args.value);

  switch (op) {

    // ── decimal ───────────────────────────────────────────────────────────────
    case 'decimal': {
      const precision  = typeof args.precision  === 'number' ? Math.max(0, Math.floor(args.precision)) : 2;
      const thousands  = args.thousands_sep  != null ? String(args.thousands_sep)  : ',';
      const decimal    = args.decimal_sep    != null ? String(args.decimal_sep)    : '.';
      const showSign   = !!args.sign;
      const result = formatDecimalStr(num, precision, thousands, decimal, showSign);
      return { operation: op, value: num, result, precision, thousands_sep: thousands, decimal_sep: decimal };
    }

    // ── currency ──────────────────────────────────────────────────────────────
    case 'currency': {
      const symbol     = args.symbol     != null ? String(args.symbol)     : '$';
      const precision  = typeof args.precision  === 'number' ? Math.max(0, Math.floor(args.precision)) : 2;
      const thousands  = args.thousands_sep  != null ? String(args.thousands_sep)  : ',';
      const decimal    = args.decimal_sep    != null ? String(args.decimal_sep)    : '.';
      const placement  = args.symbol_placement === 'after' ? 'after' : 'before';
      const negative_parens = !!args.negative_parens;

      const isNeg = num < 0;
      const absFormatted = formatDecimalStr(Math.abs(num), precision, thousands, decimal, false);

      let result;
      if (placement === 'before') {
        const withSymbol = symbol + absFormatted;
        result = isNeg ? (negative_parens ? `(${withSymbol})` : `-${withSymbol}`) : withSymbol;
      } else {
        const withSymbol = absFormatted + symbol;
        result = isNeg ? (negative_parens ? `(${withSymbol})` : `-${withSymbol}`) : withSymbol;
      }

      return { operation: op, value: num, result, symbol, placement, precision };
    }

    // ── percent ───────────────────────────────────────────────────────────────
    case 'percent': {
      const precision   = typeof args.precision === 'number' ? Math.max(0, Math.floor(args.precision)) : 1;
      const multiply    = args.multiply !== false; // default true: 0.42 → 42%
      const val         = multiply ? num * 100 : num;
      const formatted   = formatDecimalStr(val, precision, '', '.', false);
      const result      = formatted + '%';
      return { operation: op, value: num, result, multiply, precision };
    }

    // ── bytes ─────────────────────────────────────────────────────────────────
    case 'bytes': {
      const mode      = args.mode === 'si' ? 'si' : 'iec'; // iec = KiB/MiB; si = kB/MB
      const precision = typeof args.precision === 'number' ? Math.max(0, Math.floor(args.precision)) : 2;
      const result    = formatBytes(num, mode, precision);
      const both      = { iec: formatBytes(num, 'iec', precision), si: formatBytes(num, 'si', precision) };
      return { operation: op, value: num, result, mode, precision, both };
    }

    // ── si ────────────────────────────────────────────────────────────────────
    case 'si': {
      const precision  = typeof args.precision === 'number' ? Math.max(0, Math.floor(args.precision)) : 3;
      const unit       = args.unit != null ? String(args.unit) : '';
      const abs        = Math.abs(num);
      const sign       = num < 0 ? '-' : '';

      // Positive SI prefixes
      for (const p of SI_PREFIXES_POS) {
        if (abs >= p.value) {
          const scaled = abs / p.value;
          const result = sign + scaled.toFixed(precision) + ' ' + p.symbol + unit;
          return { operation: op, value: num, result, prefix: p.symbol, prefixName: p.name, scaled: parseFloat(scaled.toFixed(precision)), unit };
        }
      }
      // Sub-unit
      if (abs > 0 && abs < 1) {
        for (const p of SI_PREFIXES_NEG) {
          if (abs >= p.value) {
            const scaled = abs / p.value;
            const result = sign + scaled.toFixed(precision) + ' ' + p.symbol + unit;
            return { operation: op, value: num, result, prefix: p.symbol, prefixName: p.name, scaled: parseFloat(scaled.toFixed(precision)), unit };
          }
        }
      }
      // No prefix (0 or between 1 and 1000 or too small)
      const result = sign + abs.toFixed(precision) + (unit ? ' ' + unit : '');
      return { operation: op, value: num, result, prefix: '', prefixName: 'none', scaled: abs, unit };
    }

    // ── ordinal ───────────────────────────────────────────────────────────────
    case 'ordinal': {
      if (!Number.isInteger(num))
        throw new ToolError('number_format(ordinal): value must be an integer.', -32602);
      const abs = Math.abs(num);
      const lastTwo  = abs % 100;
      const lastOne  = abs % 10;
      let suffix;
      if (lastTwo >= 11 && lastTwo <= 13) {
        suffix = 'th';
      } else {
        switch (lastOne) {
          case 1: suffix = 'st'; break;
          case 2: suffix = 'nd'; break;
          case 3: suffix = 'rd'; break;
          default: suffix = 'th';
        }
      }
      const result = num.toString() + suffix;
      return { operation: op, value: num, result, suffix };
    }

    // ── roman ──────────────────────────────────────────────────────────────────
    case 'roman': {
      if (!Number.isInteger(num))
        throw new ToolError('number_format(roman): value must be an integer.', -32602);
      const result = toRoman(num);
      return { operation: op, value: num, result };
    }

    // ── words ──────────────────────────────────────────────────────────────────
    case 'words': {
      if (!Number.isInteger(num))
        throw new ToolError('number_format(words): value must be an integer.', -32602);
      const result = toWords(num);
      return { operation: op, value: num, result };
    }

    // ── compact ───────────────────────────────────────────────────────────────
    case 'compact': {
      const precision = typeof args.precision === 'number' ? Math.max(0, Math.floor(args.precision)) : 1;
      const abs       = Math.abs(num);
      const sign      = num < 0 ? '-' : '';
      const TIERS = [
        { value: 1e12, suffix: 'T' },
        { value: 1e9,  suffix: 'B' },
        { value: 1e6,  suffix: 'M' },
        { value: 1e3,  suffix: 'K' },
      ];
      for (const { value, suffix } of TIERS) {
        if (abs >= value) {
          const scaled = abs / value;
          const result = sign + scaled.toFixed(precision).replace(/\.?0+$/, '') + suffix;
          return { operation: op, value: num, result, tier: suffix };
        }
      }
      const result = sign + abs.toFixed(precision).replace(/\.?0+$/, '');
      return { operation: op, value: num, result, tier: null };
    }

    default:
      throw new ToolError(
        `number_format: unknown operation '${op}'. ` +
        'Valid: decimal, currency, percent, bytes, si, ordinal, roman, words, compact.',
        -32602
      );
  }
}

module.exports = { numberFormat };
