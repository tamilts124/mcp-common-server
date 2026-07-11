"use strict";
// ── PASSWORD GENERATE ─────────────────────────────────────────────────────────
// password_generate — crypto-secure password and passphrase generator.
// Zero dependencies — uses only Node.js built-in `crypto.randomBytes`.
//
// Password mode: builds a character pool from include_* flags and optional
//   exclude_chars, then draws characters uniformly using rejection sampling
//   (avoids modulo bias on non-power-of-2 pool sizes).
//
// Passphrase mode: draws N words from an embedded 512-word list of common
//   short English words (9 bits of entropy per word) and joins with a separator.
//   With 4 words: 36 bits; 5 words: 45 bits; 6 words: 54 bits.

const crypto = require("crypto");
const { ToolError } = require("./errors");

// ── Embedded 512-word list (9 bits/word) ─────────────────────────────────────
// Common 4-7 letter English words: memorable, typeable, no offensive content.
// Exactly 512 entries so list.length is a power of two (simpler entropy math).
const WORD_LIST = [
  "able","acid","aged","also","area","army","away","back","ball","band",
  "bank","base","bath","bear","beat","beer","bell","best","bird","bite",
  "blow","blue","boat","bold","bolt","bone","book","bore","both","bowl",
  "bulk","burn","busy","call","calm","card","care","case","cash","cast",
  "cave","cell","chip","city","clan","clay","clip","club","clue","coal",
  "coat","code","coin","cold","comb","cook","cool","copy","cord","core",
  "corn","cost","crew","crop","cure","curl","cute","damp","dark","dart",
  "dash","data","date","dawn","dead","deal","dear","debt","deck","deep",
  "deny","desk","dice","diet","dirt","disk","dive","dock","door","dose",
  "down","drag","draw","drop","drum","dual","dull","dump","dust","duty",
  "earn","edge","epic","even","exam","exit","face","fact","fail","fair",
  "fake","fall","fame","farm","fast","fate","feel","feet","fell","felt",
  "fern","file","fill","film","find","fine","fire","firm","fish","fist",
  "five","flag","flat","flaw","flew","flow","foam","fold","fond","food",
  "fool","foot","ford","form","fort","four","free","frog","fuel","full",
  "fund","game","gang","gaze","gear","gift","girl","give","glow","goal",
  "gold","golf","good","grab","gray","grew","grid","grin","grip","grow",
  "gulf","half","hall","halt","hand","hang","hard","harm","hash","hate",
  "haul","head","heal","heap","heat","heel","held","helm","help","herb",
  "herd","here","hide","high","hike","hill","hint","hire","hold","hole",
  "home","hood","hook","hope","horn","host","hour","hull","hunt","hurt",
  "idea","idle","inch","into","iron","item","jail","join","joke","jolt",
  "jump","just","keen","keep","kick","kind","king","knot","know","lack",
  "lake","lamp","land","lane","last","late","lawn","lead","leaf","lean",
  "leap","left","lens","less","life","lift","like","lime","line","link",
  "list","live","load","loan","lock","loft","long","look","loot","lord",
  "loss","love","luck","lung","made","mail","main","make","mall","many",
  "mark","mast","maze","meal","meet","melt","mesh","mild","mile","milk",
  "mill","mind","mine","mint","miss","mist","mode","mold","moon","more",
  "most","move","much","muse","must","myth","nail","name","near","need",
  "nest","next","nice","node","none","noon","norm","note","noun","oath",
  "once","only","open","oval","oven","over","pace","pack","page","paid",
  "pain","pair","park","part","pass","past","path","pave","peak","peel",
  "peer","pest","pick","pier","pile","pine","pipe","plan","plus","poem",
  "pole","pond","pool","poor","pore","port","pose","post","pour","prey",
  "prod","pull","pump","pure","push","race","rack","rain","rake","ramp",
  "rank","rare","rate","read","real","reap","reed","reef","reel","rent",
  "rest","rice","rich","ride","ring","riot","rise","road","roam","roar",
  "robe","role","roll","room","root","rope","rose","rule","rush","rust",
  "safe","sail","salt","same","sand","sane","save","scan","seal","seam",
  "seem","self","sell","send","shed","ship","shoe","shop","shot","show",
  "shut","sign","silk","silt","sing","site","size","skin","skip","slab",
  "slam","slap","slim","slip","slot","slow","slug","snap","snow","soak",
  "soar","sock","soil","sole","some","song","soot","sort","soul","sour",
  "span","spin","spot","spur","star","stay","stem","step","stew","stir",
  "stop","such","suit","sung","sway","swim","tail","tale","talk","tall",
  "tame","tank","tape","task","teal","team","tear","term","test","text",
  "that","then","tide","tile","till","time","tiny","tire","toad","toil",
  "toll","tomb","tone","tool","toss","tour","town","trap","tree","trim",
  "trio","trip","true","tube","tuck","twin","type","unit","upon","vain",
  "vale","vast","veil","vein","vest","view","vine","void","vote","wade",
  "wage","wake",
];
// Safety guard — list must be exactly 512
/* istanbul ignore next */
if (WORD_LIST.length !== 512)
  throw new Error(`passwordGenerateOps: WORD_LIST must have exactly 512 words (found ${WORD_LIST.length})`);

const CHAR_LOWER   = "abcdefghijklmnopqrstuvwxyz";
const CHAR_UPPER   = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const CHAR_DIGITS  = "0123456789";
const CHAR_SYMBOLS = "!@#$%^&*()-_=+[]{}|;:,.<>?";

/**
 * Draw an index in [0, n) uniformly at random using rejection sampling.
 * Avoids modulo bias even for non-power-of-2 n.
 *
 * @param {number} n  Exclusive upper bound (must be in [1, 2^32)).
 * @returns {number}
 */
function randomUniform(n) {
  // Maximum value whose floor-division by n yields a full stride.
  // We reject values in the partial trailing stride [limit, 2^32).
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  let v;
  do {
    v = crypto.randomBytes(4).readUInt32BE(0);
  } while (v >= limit);
  return v % n;
}

/**
 * Generate one or more passwords or passphrases.
 *
 * @param {object} [opts]
 * @param {"password"|"passphrase"} [opts.mode]         Generation mode (default "password").
 * @param {number}  [opts.count]                         How many to generate (1–100, default 1).
 * // ── Password-mode options ──────────────────────────────────────────────────
 * @param {number}  [opts.length]                        Character count (4–512, default 16).
 * @param {boolean} [opts.include_lowercase]             Include a–z (default true).
 * @param {boolean} [opts.include_uppercase]             Include A–Z (default true).
 * @param {boolean} [opts.include_digits]                Include 0–9 (default true).
 * @param {boolean} [opts.include_symbols]               Include symbol characters (default false).
 * @param {string}  [opts.symbols]                       Custom symbol string (default CHAR_SYMBOLS).
 * @param {string}  [opts.exclude_chars]                 Characters to remove from the pool.
 * // ── Passphrase-mode options ────────────────────────────────────────────────
 * @param {number}  [opts.word_count]                    Words per passphrase (3–10, default 4).
 * @param {string}  [opts.word_separator]                Separator string (default "-").
 * @param {boolean} [opts.capitalize_words]              Title-case each word (default false).
 * @param {boolean} [opts.add_number]                    Append a random digit (default false).
 * @returns {{ mode, count, entropyBits, ... }}
 */
function generatePasswords(opts = {}) {
  const mode  = opts.mode === "passphrase" ? "passphrase" : "password";
  const count = Math.max(1, Math.min(100, Math.trunc(Number(opts.count) || 1)));

  // ── Passphrase ─────────────────────────────────────────────────────────────
  if (mode === "passphrase") {
    const wordCount  = Math.max(3, Math.min(10, Math.trunc(Number(opts.word_count) || 4)));
    const sep        = typeof opts.word_separator === "string" ? opts.word_separator : "-";
    const capitalize = !!opts.capitalize_words;
    const addNum     = !!opts.add_number;
    const listSize   = WORD_LIST.length; // 512

    const results = [];
    for (let c = 0; c < count; c++) {
      const words = [];
      for (let w = 0; w < wordCount; w++) {
        let word = WORD_LIST[randomUniform(listSize)];
        if (capitalize) word = word[0].toUpperCase() + word.slice(1);
        words.push(word);
      }
      let phrase = words.join(sep);
      if (addNum) phrase += randomUniform(10).toString();
      results.push(phrase);
    }

    // Entropy per word = log2(512) = 9 bits; +log2(10)≈3.32 bits if add_number
    const entropyBits = parseFloat(
      (Math.log2(listSize) * wordCount + (addNum ? Math.log2(10) : 0)).toFixed(2)
    );

    const out = { mode, count, wordCount, separator: sep, entropyBits, wordlistSize: listSize, passphrases: results };
    if (count === 1) out.passphrase = results[0];
    return out;
  }

  // ── Password ───────────────────────────────────────────────────────────────
  const length     = Math.max(4, Math.min(512, Math.trunc(Number(opts.length) || 16)));
  const incLower   = opts.include_lowercase   !== false; // default true
  const incUpper   = opts.include_uppercase   !== false; // default true
  const incDigits  = opts.include_digits      !== false; // default true
  const incSymbols = opts.include_symbols     === true;  // default false

  let pool = "";
  if (incLower)   pool += CHAR_LOWER;
  if (incUpper)   pool += CHAR_UPPER;
  if (incDigits)  pool += CHAR_DIGITS;
  if (incSymbols) pool += (typeof opts.symbols === "string" && opts.symbols.length > 0
    ? opts.symbols
    : CHAR_SYMBOLS);

  // Apply exclude_chars filter
  if (typeof opts.exclude_chars === "string" && opts.exclude_chars.length > 0) {
    const excluded = new Set(opts.exclude_chars);
    pool = [...pool].filter(ch => !excluded.has(ch)).join("");
  }

  // Deduplicate (e.g. caller might pass symbols that overlap with alphanum)
  pool = [...new Set(pool)].join("");

  if (pool.length === 0)
    throw new ToolError(
      "password_generate: no characters remain after applying include/exclude filters. " +
      "Enable at least one character class or remove conflicting exclude_chars.",
      -32602
    );
  if (pool.length < 2)
    throw new ToolError(
      "password_generate: charset must contain at least 2 distinct characters.",
      -32602
    );

  const charsetSize = pool.length;
  const results     = [];
  for (let c = 0; c < count; c++) {
    let pwd = "";
    for (let i = 0; i < length; i++) pwd += pool[randomUniform(charsetSize)];
    results.push(pwd);
  }

  const entropyBits = parseFloat((length * Math.log2(charsetSize)).toFixed(2));

  const out = { mode, count, length, charsetSize, entropyBits, passwords: results };
  if (count === 1) out.password = results[0];
  return out;
}

module.exports = { generatePasswords, WORD_LIST, randomUniform };
