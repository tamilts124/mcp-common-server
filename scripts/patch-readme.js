"use strict";
const fs = require("fs");
let r = fs.readFileSync("README.md", "utf8");

// 1. tool count: 426 -> 427
if (!r.includes("**426 tools**")) throw new Error("426 tools not found");
r = r.replace("**426 tools**", "**427 tools**");

// 2. Read & File System: 78 -> 79
if (!r.includes("| Read & File System | 78 |")) throw new Error("Read & File System 78 not found");
r = r.replace("| Read & File System | 78 |", "| Read & File System | 79 |");

// 3. Add audio_client after epub_client in tool list
const EPUB_REF = "`epub_client`";
if (!r.includes(EPUB_REF)) throw new Error("epub_client ref not found");
r = r.replace(EPUB_REF, EPUB_REF + ", `audio_client`");

// 4. Version in package badge (if any) -- skip, no version badge
// 5. Version in package.json already updated

fs.writeFileSync("README.md", r);
console.log("README.md patched: 427 tools, Read & File System: 79, audio_client listed");
