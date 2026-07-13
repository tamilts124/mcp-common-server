"use strict";
const fs = require("fs");

// ── Patch dispatchRead.js ─────────────────────────────────────────────────────
let c = fs.readFileSync("lib/dispatchRead.js", "utf8");

// 1. Add require
const R_OLD = 'const { epubClient }      = require("./epubClientOps");';
const R_NEW = R_OLD + "\nconst { audioClient }     = require(\"./audioClientOps\");";
if (!c.includes(R_OLD)) throw new Error("dispatchRead: require anchor not found");
c = c.replace(R_OLD, R_NEW);

// 2. Insert audio_client before closing }; of READ_DISPATCH object.
//    The last occurrence of 'epub_client(args) {' is followed by
//    the closing '};' of the whole READ_DISPATCH object (CRLF file).
const EPUB_IDX = c.lastIndexOf("epub_client(args) {");
if (EPUB_IDX === -1) throw new Error("dispatchRead: epub_client not found");

// find the '};' that closes READ_DISPATCH (\r\n};\r\n right after epub block)
const CRLF = "\r\n";
const CLOSE = CRLF + "};" + CRLF;
const closeIdx = c.indexOf(CLOSE, EPUB_IDX);
if (closeIdx === -1) throw new Error("dispatchRead: closing }; not found after epub_client. EPUB_IDX=" + EPUB_IDX);

const audioBlock =
  "  audio_client(args) {" + CRLF +
  "    // Pure sync fs -- no await needed." + CRLF +
  "    return audioClient(args);" + CRLF +
  "  }," + CRLF;

// insert audioBlock right before the closing };
c = c.slice(0, closeIdx + CRLF.length) + audioBlock + c.slice(closeIdx + CRLF.length);

fs.writeFileSync("lib/dispatchRead.js", c);
console.log("dispatchRead.js: audio_client wired");

// ── Patch lib/schemas/utilSchemas.js ─────────────────────────────────────────
let s = fs.readFileSync("lib/schemas/utilSchemas.js", "utf8");

const S_OLD = 'const { UTIL_SCHEMAS_67 } = require("./utilSchemas67");';
const S_NEW = S_OLD + "\nconst { UTIL_SCHEMAS_68 } = require(\"./utilSchemas68\");";
if (!s.includes(S_OLD)) throw new Error("utilSchemas.js: UTIL_SCHEMAS_67 require not found");
s = s.replace(S_OLD, S_NEW);

const SP_OLD = "...UTIL_SCHEMAS_67] }";
const SP_NEW = "...UTIL_SCHEMAS_67, ...UTIL_SCHEMAS_68] }";
if (!s.includes(SP_OLD)) throw new Error("utilSchemas.js: spread anchor not found");
s = s.replace(SP_OLD, SP_NEW);

fs.writeFileSync("lib/schemas/utilSchemas.js", s);
console.log("utilSchemas.js: UTIL_SCHEMAS_68 wired");

// ── Patch package.json ────────────────────────────────────────────────────────
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
if (pkg.version !== "4.207.0") throw new Error(`Unexpected version: ${pkg.version}`);
pkg.version = "4.208.0";
pkg.scripts["test:audio-client"] = "node test/sections/235-audio-client.js";
fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");
console.log("package.json: bumped to 4.208.0");

console.log("All patches applied.");
