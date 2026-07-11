"use strict";
// ── STRING SIMILARITY OPS ──────────────────────────────────────────────────────────────────
// String distance metrics and fuzzy search — zero npm dependencies.
// Algorithms: Levenshtein, Jaro-Winkler, Dice coefficient (bigrams),
// Hamming, Longest Common Subsequence.

const { ToolError } = require("./errors");

const MAX_STR_LEN  = 10_000;
const MAX_LIST     = 50_000;
const MAX_CLUSTER  = 5_000;

const VALID_OPS     = ["distance","search","cluster","dedupe","normalize"];
const VALID_METRICS = ["levenshtein","jaro_winkler","dice","hamming","longest_common_subsequence"];

// ── Distance algorithms ───────────────────────────────────────────────────────────────────

function levenshtein(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      curr[j] = a[i-1] === b[j-1]
        ? prev[j-1]
        : 1 + Math.min(prev[j], curr[j-1], prev[j-1]);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function jaro(a, b) {
  if (a === b) return 1;
  const la = a.length, lb = b.length;
  if (la === 0 || lb === 0) return 0;
  const matchWindow = Math.max(Math.floor(Math.max(la, lb) / 2) - 1, 0);
  const aMatched    = new Array(la).fill(false);
  const bMatched    = new Array(lb).fill(false);
  let matches = 0;
  for (let i = 0; i < la; i++) {
    const lo = Math.max(0, i - matchWindow);
    const hi = Math.min(i + matchWindow + 1, lb);
    for (let j = lo; j < hi; j++) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = bMatched[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0, k = 0;
  for (let i = 0; i < la; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  return (matches/la + matches/lb + (matches - transpositions/2)/matches) / 3;
}

function jaroWinkler(a, b) {
  const j = jaro(a, b);
  let prefix = 0;
  for (let i = 0; i < Math.min(4, a.length, b.length); i++) {
    if (a[i] === b[i]) prefix++; else break;
  }
  return j + prefix * 0.1 * (1 - j);
}

function bigrams(s) {
  const bg = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const bi = s.slice(i, i + 2);
    bg.set(bi, (bg.get(bi) || 0) + 1);
  }
  return bg;
}

function dice(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bgA = bigrams(a), bgB = bigrams(b);
  let inter = 0;
  for (const [bg, cnt] of bgA) inter += Math.min(cnt, bgB.get(bg) || 0);
  return (2 * inter) / ((a.length - 1) + (b.length - 1));
}

function hammingDistance(a, b) {
  if (a.length !== b.length)
    throw new ToolError(
      `str_similarity hamming: strings must be equal length (${a.length} vs ${b.length}).`,
      -32602
    );
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

function lcsLength(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] + 1 : Math.max(dp[i-1][j], dp[i][j-1]);
  return dp[m][n];
}

// ── Unified similarity / raw-distance ─────────────────────────────────────────────────────

function similarity(a, b, metric) {
  switch (metric) {
    case "levenshtein": {
      const d = levenshtein(a, b);
      const maxLen = Math.max(a.length, b.length);
      return maxLen === 0 ? 1 : 1 - d / maxLen;
    }
    case "jaro_winkler": return jaroWinkler(a, b);
    case "dice":         return dice(a, b);
    case "hamming": {
      const d = hammingDistance(a, b);
      return a.length === 0 ? 1 : 1 - d / a.length;
    }
    case "longest_common_subsequence": {
      const l = lcsLength(a, b);
      const maxLen = Math.max(a.length, b.length);
      return maxLen === 0 ? 1 : l / maxLen;
    }
    default: throw new ToolError(`str_similarity: unknown metric '${metric}'.`, -32602);
  }
}

function rawDistance(a, b, metric) {
  switch (metric) {
    case "levenshtein":               return levenshtein(a, b);
    case "jaro_winkler":              return 1 - jaroWinkler(a, b);
    case "dice":                       return 1 - dice(a, b);
    case "hamming":                    return hammingDistance(a, b);
    case "longest_common_subsequence": return Math.max(a.length, b.length) - lcsLength(a, b);
    default: throw new ToolError(`str_similarity: unknown metric '${metric}'.`, -32602);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────────────────

function assertStr(s, label) {
  if (typeof s !== "string")
    throw new ToolError(`str_similarity ${label}: must be a string, got ${typeof s}.`, -32602);
  if (s.length > MAX_STR_LEN)
    throw new ToolError(`str_similarity ${label}: string too long (max ${MAX_STR_LEN} chars).`, -32602);
}

function round4(n) { return Math.round(n * 10000) / 10000; }

function normalizeStr(s, opts) {
  let r = String(s);
  if (opts.strip_diacritics)    r = r.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (opts.lower !== false)     r = r.toLowerCase();
  if (opts.strip_punctuation)   r = r.replace(/[^\w\s]/g, "");
  if (opts.trim !== false)      r = r.trim();
  if (opts.collapse_whitespace !== false) r = r.replace(/\s+/g, " ");
  return r;
}

// ── Main entry point ──────────────────────────────────────────────────────────────────────

function strSimilarity(args) {
  const { operation } = args;
  if (!operation) throw new ToolError("str_similarity: 'operation' is required.", -32602);
  if (!VALID_OPS.includes(operation))
    throw new ToolError(`str_similarity: Unknown operation '${operation}'. Valid: ${VALID_OPS.join(", ")}.`, -32602);

  const metric = args.metric || "levenshtein";
  if (!VALID_METRICS.includes(metric))
    throw new ToolError(`str_similarity: Unknown metric '${metric}'. Valid: ${VALID_METRICS.join(", ")}.`, -32602);

  switch (operation) {

    case "distance": {
      if (args.a == null || args.b == null)
        throw new ToolError("str_similarity distance: 'a' and 'b' are required.", -32602);
      assertStr(args.a, "distance.a");
      assertStr(args.b, "distance.b");
      const ic = args.ignore_case === true;
      const a  = ic ? args.a.toLowerCase() : args.a;
      const b  = ic ? args.b.toLowerCase() : args.b;
      return {
        operation, metric,
        a: args.a, b: args.b,
        similarity: round4(similarity(a, b, metric)),
        distance:   rawDistance(a, b, metric),
      };
    }

    case "search": {
      if (!args.query) throw new ToolError("str_similarity search: 'query' is required.", -32602);
      if (!Array.isArray(args.candidates)) throw new ToolError("str_similarity search: 'candidates' array is required.", -32602);
      if (args.candidates.length > MAX_LIST)
        throw new ToolError(`str_similarity search: 'candidates' list too large (max ${MAX_LIST}).`, -32602);
      assertStr(args.query, "search.query");
      const topN      = Math.min(Math.max(1, Number(args.top_n) || 10), 1000);
      const threshold = args.threshold != null ? Number(args.threshold) : 0;
      const ic        = args.ignore_case === true;
      const q         = ic ? args.query.toLowerCase() : args.query;
      const scored    = args.candidates
        .map((c, i) => {
          const cs  = ic ? String(c).toLowerCase() : String(c);
          const sim = round4(similarity(q, cs, metric));
          return { index: i, candidate: c, similarity: sim };
        })
        .filter(x => x.similarity >= threshold)
        .sort((x, y) => y.similarity - x.similarity)
        .slice(0, topN);
      return { operation, metric, query: args.query, resultCount: scored.length, results: scored };
    }

    case "cluster": {
      if (!Array.isArray(args.strings))
        throw new ToolError("str_similarity cluster: 'strings' array is required.", -32602);
      if (args.strings.length > MAX_CLUSTER)
        throw new ToolError(`str_similarity cluster: 'strings' list too large (max ${MAX_CLUSTER}).`, -32602);
      const threshold = args.threshold != null ? Number(args.threshold) : 0.8;
      const ic        = args.ignore_case === true;
      const strs      = args.strings;
      const n         = strs.length;
      const parent    = Array.from({ length: n }, (_, i) => i);
      const find = i => {
        while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
        return i;
      };
      const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
      for (let i = 0; i < n; i++) {
        const ai = ic ? String(strs[i]).toLowerCase() : String(strs[i]);
        for (let j = i + 1; j < n; j++) {
          const bj = ic ? String(strs[j]).toLowerCase() : String(strs[j]);
          if (similarity(ai, bj, metric) >= threshold) union(i, j);
        }
      }
      const groups = new Map();
      for (let i = 0; i < n; i++) {
        const root = find(i);
        if (!groups.has(root)) groups.set(root, []);
        groups.get(root).push(strs[i]);
      }
      const clusters = [...groups.values()].sort((a, b) => b.length - a.length);
      return { operation, metric, threshold, clusterCount: clusters.length, clusters };
    }

    case "dedupe": {
      if (!Array.isArray(args.strings))
        throw new ToolError("str_similarity dedupe: 'strings' array is required.", -32602);
      if (args.strings.length > MAX_CLUSTER)
        throw new ToolError(`str_similarity dedupe: 'strings' list too large (max ${MAX_CLUSTER}).`, -32602);
      const threshold = args.threshold != null ? Number(args.threshold) : 0.9;
      const ic        = args.ignore_case === true;
      const strs      = args.strings;
      const kept      = [];
      for (const s of strs) {
        const si = ic ? String(s).toLowerCase() : String(s);
        const isDup = kept.some(k => {
          const ki = ic ? String(k).toLowerCase() : String(k);
          return similarity(si, ki, metric) >= threshold;
        });
        if (!isDup) kept.push(s);
      }
      return {
        operation, metric, threshold,
        originalCount: strs.length, dedupeCount: kept.length,
        removed: strs.length - kept.length,
        strings: kept,
      };
    }

    case "normalize": {
      const hasSingle = typeof args.string  === "string";
      const hasMulti  = Array.isArray(args.strings);
      if (!hasSingle && !hasMulti)
        throw new ToolError("str_similarity normalize: 'string' (string) or 'strings' (array) is required.", -32602);
      const opts = {
        lower:             args.lower !== false,
        trim:              args.trim  !== false,
        collapse_whitespace: args.collapse_whitespace !== false,
        strip_punctuation:   args.strip_punctuation === true,
        strip_diacritics:    args.strip_diacritics  === true,
      };
      if (hasSingle) {
        return { operation, string: normalizeStr(args.string, opts) };
      }
      return { operation, strings: args.strings.map(s => normalizeStr(s, opts)) };
    }
  }
}

module.exports = { strSimilarity };
