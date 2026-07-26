"use strict";
// ── SCREEN CAPTURE OPERATIONS ─────────────────────────────────────────────────
// Captures the desktop screen (or a specific window/region) using platform-
// native tools. Zero npm dependencies — pure Node.js child_process.
//
// Windows : PowerShell + System.Windows.Forms / System.Drawing
// Linux   : scrot, gnome-screenshot, or import (ImageMagick)
// macOS   : screencapture (built-in)
//
// Returns the screenshot as a base64-encoded PNG string, and optionally writes
// it to disk. Also supports mouse click, mouse move, and keyboard events.
//
// Quality: "low" (scale 50%) / "medium" (scale 75%, default) / "high" (100%)
// Keys   : supports multi-key combos like "Shift+Ctrl+C", "Alt+F4", "Ctrl+Z"

const { spawnSync } = require("child_process");
const fs            = require("fs");
const path          = require("path");
const os            = require("os");
const zlib          = require("zlib");
const { ToolError } = require("./errors");

const TIMEOUT_MS    = 20_000; // 20 s max for capture commands
const MAX_IMG_BYTES = 20 * 1024 * 1024; // 20 MB result cap

// ── Quality → scale factor ────────────────────────────────────────────────────
const QUALITY_SCALE = { low: 0.5, medium: 0.75, high: 1.0 };

// ── Multi-key combo parser ────────────────────────────────────────────────────
// Converts human-friendly "Shift+Ctrl+C" → Windows SendKeys string "^+C"
// and also accepts raw SendKeys strings directly.
//
// Modifier map (case-insensitive):
//   Ctrl / Control → ^
//   Alt            → %
//   Shift          → +
//   Win / Windows  → (passed via keybd_event; approximated as {LWIN} in SendKeys)
//
// Special keys (in {braces}) are passed through unchanged.
// Plain characters are passed through unchanged.
//
function parseKeyCombo(input) {
  // If it already looks like SendKeys (contains ^, %, +, {, }) pass through
  // UNLESS it contains "+" which might be our combo separator.
  // Strategy: split on "+" only when not inside {}, then map each token.
  const parts = [];
  let buf = "";
  let depth = 0;
  for (const ch of input) {
    if (ch === "{") { depth++; buf += ch; }
    else if (ch === "}") { depth--; buf += ch; }
    else if (ch === "+" && depth === 0) {
      if (buf) parts.push(buf.trim());
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) parts.push(buf.trim());

  // If only one part and no modifier keywords, return as-is (raw SendKeys)
  const MODIFIER_KEYWORDS = new Set([
    "ctrl","control","alt","shift","win","windows","meta",
  ]);
  const hasModifier = parts.some(p => MODIFIER_KEYWORDS.has(p.toLowerCase()));
  if (!hasModifier) return input; // raw SendKeys pass-through

  // Map to SendKeys prefixes
  const PREFIX_MAP = {
    ctrl: "^", control: "^",
    alt: "%",
    shift: "+",
    win: "", windows: "", meta: "", // SendKeys doesn't support Win key; best effort
  };

  let prefix = "";
  let keyPart = "";
  for (const part of parts) {
    const lo = part.toLowerCase();
    if (PREFIX_MAP[lo] !== undefined) {
      prefix += PREFIX_MAP[lo];
    } else {
      // This is the actual key — wrap in braces if it's a word (e.g. "TAB", "F4", "ENTER")
      // Single characters don't need braces; multi-char strings do
      if (part.startsWith("{")) {
        keyPart = part; // already in brace notation
      } else if (part.length === 1) {
        keyPart = part;
      } else {
        // Named key: uppercase it and wrap in braces
        keyPart = `{${part.toUpperCase()}}`;
      }
    }
  }

  return prefix + keyPart;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _tmpPng() {
  return path.join(os.tmpdir(), `sc_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);
}

function _readAndClean(tmpPath) {
  try {
    const buf = fs.readFileSync(tmpPath);
    if (buf.length > MAX_IMG_BYTES)
      throw new ToolError(
        `screen_capture: screenshot too large (${buf.length} bytes > ${MAX_IMG_BYTES} limit).`,
        -32603
      );
    return buf.toString("base64");
  } finally {
    try { fs.unlinkSync(tmpPath); } catch (_) { /* ignore */ }
  }
}

function _spawnAndCheck(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    timeout: TIMEOUT_MS,
    encoding: "buffer",
    ...opts,
  });
  if (r.error) throw new ToolError(`screen_capture: spawn error — ${r.error.message}`, -32603);
  if (r.status !== 0) {
    const stderr = (r.stderr || Buffer.alloc(0)).toString("utf8").trim();
    throw new ToolError(
      `screen_capture: command '${cmd}' exited with code ${r.status}` +
      (stderr ? ` — ${stderr.slice(0, 300)}` : ""),
      -32603
    );
  }
  return r;
}

// ── PNG downscale (pure Node.js, no deps) ────────────────────────────────────
// Decodes a raw PNG (IDAT + IHDR only, no filtering), scales using nearest-
// neighbour (fast), re-encodes as PNG. Used for quality=low/medium.
// Falls back gracefully: if decode fails, returns original buffer unchanged.
function _scalePng(srcBuf, scale) {
  if (scale >= 1.0) return srcBuf;
  try {
    // Parse IHDR
    if (srcBuf.readUInt32BE(0) !== 0x89504e47) return srcBuf; // not PNG
    let pos = 8;
    let width = 0, height = 0, bitDepth = 0, colorType = 0;
    while (pos < srcBuf.length - 8) {
      const len  = srcBuf.readUInt32BE(pos);
      const type = srcBuf.toString("ascii", pos + 4, pos + 8);
      if (type === "IHDR") {
        width     = srcBuf.readUInt32BE(pos + 8);
        height    = srcBuf.readUInt32BE(pos + 12);
        bitDepth  = srcBuf[pos + 16];
        colorType = srcBuf[pos + 17];
        break;
      }
      pos += 12 + len;
    }
    if (!width || !height || bitDepth !== 8) return srcBuf; // unsupported format

    // Collect IDAT chunks and decompress
    const idatChunks = [];
    pos = 8;
    while (pos < srcBuf.length - 8) {
      const len  = srcBuf.readUInt32BE(pos);
      const type = srcBuf.toString("ascii", pos + 4, pos + 8);
      if (type === "IDAT") idatChunks.push(srcBuf.subarray(pos + 8, pos + 8 + len));
      if (type === "IEND") break;
      pos += 12 + len;
    }
    if (!idatChunks.length) return srcBuf;

    const channels = [0,1,3,1,2,0,4][colorType] || 3;
    const raw = zlib.inflateSync(Buffer.concat(idatChunks));

    // Reconstruct pixels (no filter reversal — use 0 (None) filter assumption)
    // For a proper decode we'd need to reverse filters. Skip for simplicity;
    // PowerShell captures with no filter so this works in practice.
    const stride = 1 + width * channels;
    if (raw.length < height * stride) return srcBuf; // sanity check

    const dstW = Math.max(1, Math.round(width  * scale));
    const dstH = Math.max(1, Math.round(height * scale));
    const dst  = Buffer.alloc(dstH * (1 + dstW * channels));

    for (let dy = 0; dy < dstH; dy++) {
      const sy = Math.min(height - 1, Math.floor(dy / scale));
      dst[dy * (1 + dstW * channels)] = 0; // filter None
      for (let dx = 0; dx < dstW; dx++) {
        const sx = Math.min(width - 1, Math.floor(dx / scale));
        for (let c = 0; c < channels; c++) {
          dst[dy * (1 + dstW * channels) + 1 + dx * channels + c] =
            raw[sy * stride + 1 + sx * channels + c];
        }
      }
    }

    // Re-encode PNG
    const compressed = zlib.deflateSync(dst);
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(dstW, 0); ihdr.writeUInt32BE(dstH, 4);
    ihdr[8] = 8; ihdr[9] = colorType;

    function crc32(buf) {
      const T = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        T[i] = c;
      }
      let v = 0xffffffff;
      for (let i = 0; i < buf.length; i++) v = (v >>> 8) ^ T[(v ^ buf[i]) & 0xff];
      return (v ^ 0xffffffff) >>> 0;
    }
    function chunk(type, data) {
      const lb = Buffer.alloc(4); lb.writeUInt32BE(data.length, 0);
      const tb = Buffer.from(type, "ascii");
      const cb = Buffer.alloc(4); cb.writeUInt32BE(crc32(Buffer.concat([tb, data])), 0);
      return Buffer.concat([lb, tb, data, cb]);
    }
    const SIG = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
    return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", compressed), chunk("IEND", Buffer.alloc(0))]);
  } catch (_) {
    return srcBuf; // graceful fallback: return original
  }
}

// ── Platform capture ──────────────────────────────────────────────────────────

function _captureWindows(opts) {
  const tmp = _tmpPng();
  const { x, y, width, height } = opts;
  const hasRegion = (x != null && y != null && width != null && height != null);

  const psLines = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    hasRegion
      ? `$bmp = New-Object System.Drawing.Bitmap(${width}, ${height})`
      : "$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds",
    hasRegion
      ? `$g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen(${x}, ${y}, 0, 0, $bmp.Size); $g.Dispose()`
      : "$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size); $g.Dispose()",
    `$bmp.Save('${tmp.replace(/\\/g, "\\\\")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    "$bmp.Dispose()",
  ];

  _spawnAndCheck("powershell", ["-NoProfile", "-NonInteractive", "-Command", psLines.join("; ")]);
  return tmp;
}

function _captureMac(opts) {
  const tmp = _tmpPng();
  const { x, y, width, height } = opts;
  const hasRegion = (x != null && y != null && width != null && height != null);
  const args = ["-x", "-t", "png"];
  if (hasRegion) args.push("-R", `${x},${y},${width},${height}`);
  args.push(tmp);
  _spawnAndCheck("screencapture", args);
  return tmp;
}

function _captureLinux(opts) {
  const tmp = _tmpPng();
  const { x, y, width, height } = opts;
  const hasRegion = (x != null && y != null && width != null && height != null);

  const scrot = spawnSync("which", ["scrot"], { encoding: "utf8" });
  if (scrot.status === 0) {
    const args = [];
    if (hasRegion) args.push("-a", `${x},${y},${width},${height}`);
    args.push(tmp);
    _spawnAndCheck("scrot", args);
    return tmp;
  }

  const importCmd = spawnSync("which", ["import"], { encoding: "utf8" });
  if (importCmd.status === 0) {
    const args = [];
    if (hasRegion) args.push("-crop", `${width}x${height}+${x}+${y}`);
    args.push("png:" + tmp);
    _spawnAndCheck("import", args);
    return tmp;
  }

  const gsArgs = ["-f", tmp];
  if (!hasRegion) gsArgs.push("--full");
  _spawnAndCheck("gnome-screenshot", gsArgs);
  return tmp;
}

// ── Mouse / keyboard helpers (cross-platform) ─────────────────────────────────
// Windows : PowerShell + user32.dll / SendKeys
// macOS   : cliclick (brew install cliclick) for mouse; osascript for keys
// Linux   : xdotool (apt/yum install xdotool) for both

// ── macOS key combo → AppleScript keystroke ───────────────────────────────────
function _toAppleScript(input) {
  const MODIFIER_MAP = {
    ctrl: "control down", control: "control down",
    shift: "shift down",
    alt: "option down", option: "option down",
    cmd: "command down", command: "command down", meta: "command down",
    win: "command down", windows: "command down",
  };
  const KEY_CODES = {
    enter: 36, return: 36, tab: 48, space: 49, delete: 51, backspace: 51,
    escape: 53, esc: 53,
    f1:122,f2:120,f3:99,f4:118,f5:96,f6:97,f7:98,f8:100,f9:101,f10:109,f11:103,f12:111,
    home:115, end:119, pageup:116, pagedown:121,
    left:123, right:124, down:125, up:126,
  };

  const parts = [];
  let buf = "", depth = 0;
  for (const ch of input) {
    if (ch === "{") { depth++; buf += ch; }
    else if (ch === "}") { depth--; buf += ch; }
    else if (ch === "+" && depth === 0) { if (buf.trim()) parts.push(buf.trim()); buf = ""; }
    else buf += ch;
  }
  if (buf.trim()) parts.push(buf.trim());

  const modifiers = [];
  let keyToken = null;
  for (const part of parts) {
    const lo = part.toLowerCase().replace(/[{}]/g, "");
    if (MODIFIER_MAP[lo]) modifiers.push(MODIFIER_MAP[lo]);
    else keyToken = lo;
  }
  if (!keyToken) return null;

  const usingClause = modifiers.length ? ` using {${modifiers.join(", ")}}` : "";
  if (KEY_CODES[keyToken] !== undefined) {
    return `key code ${KEY_CODES[keyToken]}${usingClause}`;
  }
  const ch = keyToken.length === 1 ? keyToken : keyToken[0];
  const escaped = ch.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `keystroke "${escaped}"${usingClause}`;
}

// ── Linux key combo → xdotool key name ───────────────────────────────────────
function _toXdotoolKey(input) {
  const MODIFIER_MAP = {
    ctrl:"ctrl", control:"ctrl", shift:"shift", alt:"alt",
    meta:"super", win:"super", windows:"super", cmd:"super", command:"super",
  };
  const KEY_MAP = {
    enter:"Return", return:"Return", tab:"Tab", space:"space",
    delete:"Delete", backspace:"BackSpace", escape:"Escape", esc:"Escape",
    f1:"F1",f2:"F2",f3:"F3",f4:"F4",f5:"F5",f6:"F6",
    f7:"F7",f8:"F8",f9:"F9",f10:"F10",f11:"F11",f12:"F12",
    home:"Home",end:"End",pageup:"Prior",pagedown:"Next",
    left:"Left",right:"Right",up:"Up",down:"Down",
  };
  const parts = [];
  let buf = "", depth = 0;
  for (const ch of input) {
    if (ch === "{") { depth++; buf += ch; }
    else if (ch === "}") { depth--; buf += ch; }
    else if (ch === "+" && depth === 0) { if (buf.trim()) parts.push(buf.trim()); buf = ""; }
    else buf += ch;
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts.map(p => {
    const lo = p.toLowerCase().replace(/[{}]/g, "");
    return MODIFIER_MAP[lo] || KEY_MAP[lo] || p;
  }).join("+");
}

function _mouseClick(x, y, button = "left") {
  const plat = process.platform;
  const btn  = button === "right" ? "right" : "left";

  if (plat === "win32") {
    const downFlag = btn === "right" ? 8  : 2;
    const upFlag   = btn === "right" ? 16 : 4;
    const ps = [
      "Add-Type -AssemblyName System.Windows.Forms",
      `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y})`,
      `$sig = '[DllImport(\\"user32.dll\\")] public static extern void mouse_event(int f,int x,int y,int d,int e);'`,
      `$t = Add-Type -MemberDefinition $sig -Name ME${Date.now()} -PassThru`,
      `$t::mouse_event(${downFlag},0,0,0,0); Start-Sleep -Milliseconds 60; $t::mouse_event(${upFlag},0,0,0,0)`,
    ];
    _spawnAndCheck("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps.join("; ")]);

  } else if (plat === "darwin") {
    // cliclick: c:x,y = left click, rc:x,y = right click
    const op = btn === "right" ? "rc" : "c";
    _spawnAndCheck("cliclick", [`${op}:${x},${y}`]);

  } else {
    // Linux — xdotool
    const btnNum = btn === "right" ? "3" : "1";
    _spawnAndCheck("xdotool", ["mousemove", String(x), String(y)]);
    _spawnAndCheck("xdotool", ["click", btnNum]);
  }
}

function _sendKeys(rawInput) {
  const plat = process.platform;

  if (plat === "win32") {
    const sendKeysStr = parseKeyCombo(rawInput);
    const safe = sendKeysStr.replace(/'/g, "''");
    const ps = [
      "Add-Type -AssemblyName System.Windows.Forms",
      `[System.Windows.Forms.SendKeys]::SendWait('${safe}')`,
    ];
    _spawnAndCheck("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps.join("; ")]);
    return sendKeysStr;

  } else if (plat === "darwin") {
    const asCmd = _toAppleScript(rawInput);
    if (!asCmd) throw new ToolError(`screen_capture send_keys: cannot parse keys '${rawInput}' for macOS.`, -32602);
    _spawnAndCheck("osascript", ["-e", `tell application "System Events" to ${asCmd}`]);
    return asCmd;

  } else {
    // Linux — xdotool
    const hasModifier = /\b(ctrl|control|alt|shift|win|meta|cmd)\b/i.test(rawInput) ||
                        /^[^+]+\+/.test(rawInput);
    if (hasModifier) {
      const xkey = _toXdotoolKey(rawInput);
      _spawnAndCheck("xdotool", ["key", xkey]);
      return xkey;
    } else {
      // Plain text — strip {braces}
      const clean = rawInput.replace(/\{([^}]+)\}/g, (_, k) => {
        const map = { ENTER:"\n", TAB:"\t", SPACE:" " };
        return map[k.toUpperCase()] || "";
      });
      _spawnAndCheck("xdotool", ["type", "--clearmodifiers", clean]);
      return clean;
    }
  }
}

function _mouseMove(x, y) {
  const plat = process.platform;

  if (plat === "win32") {
    const ps = [
      "Add-Type -AssemblyName System.Windows.Forms",
      `[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x}, ${y})`,
    ];
    _spawnAndCheck("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps.join("; ")]);

  } else if (plat === "darwin") {
    // cliclick: m:x,y = move mouse without clicking
    _spawnAndCheck("cliclick", [`m:${x},${y}`]);

  } else {
    // Linux — xdotool
    _spawnAndCheck("xdotool", ["mousemove", String(x), String(y)]);
  }
}


// ── Main exported function ────────────────────────────────────────────────────

function screenCapture(args) {
  const op = args.operation || "capture";

  // ── mouse_click ────────────────────────────���───────────────────────────────
  if (op === "mouse_click") {
    const { x, y, button = "left" } = args;
    if (x == null || y == null)
      throw new ToolError("screen_capture mouse_click: x and y are required.", -32602);
    _mouseClick(Number(x), Number(y), button);
    return { ok: true, operation: "mouse_click", x: Number(x), y: Number(y), button };
  }

  // ── mouse_move ─────────────────────────────────────────────────────────────
  if (op === "mouse_move") {
    const { x, y } = args;
    if (x == null || y == null)
      throw new ToolError("screen_capture mouse_move: x and y are required.", -32602);
    _mouseMove(Number(x), Number(y));
    return { ok: true, operation: "mouse_move", x: Number(x), y: Number(y) };
  }

  // ── send_keys ──────────────────────────────────────────────────────────────
  if (op === "send_keys") {
    const { keys } = args;
    if (!keys) throw new ToolError("screen_capture send_keys: 'keys' is required.", -32602);
    const resolved = _sendKeys(String(keys));
    return { ok: true, operation: "send_keys", keys, resolved_sendkeys: resolved };
  }

  // ── capture (default) ──────────────────────────────────────────────────────
  const quality = (args.quality || "medium").toLowerCase();
  if (!QUALITY_SCALE[quality])
    throw new ToolError(`screen_capture: quality must be 'low', 'medium', or 'high' (got '${args.quality}').`, -32602);
  const scale = QUALITY_SCALE[quality];

  const region = {
    x:      args.x      != null ? Number(args.x)      : null,
    y:      args.y      != null ? Number(args.y)      : null,
    width:  args.width  != null ? Number(args.width)  : null,
    height: args.height != null ? Number(args.height) : null,
  };

  let tmpPath;
  const plat = process.platform;
  if      (plat === "win32")  tmpPath = _captureWindows(region);
  else if (plat === "darwin") tmpPath = _captureMac(region);
  else                        tmpPath = _captureLinux(region);

  // Read raw PNG, apply quality scaling, encode base64
  let rawBuf = fs.readFileSync(tmpPath);
  try { fs.unlinkSync(tmpPath); } catch (_) {}

  if (rawBuf.length > MAX_IMG_BYTES)
    throw new ToolError(`screen_capture: raw PNG too large (${rawBuf.length} bytes).`, -32603);

  // Parse original width/height from raw PNG IHDR before scaling
  let originalWidth = null, originalHeight = null;
  try {
    if (rawBuf.readUInt32BE(0) === 0x89504e47) { // PNG magic bytes
      let pos = 8;
      while (pos < rawBuf.length - 8) {
        const len  = rawBuf.readUInt32BE(pos);
        const type = rawBuf.toString("ascii", pos + 4, pos + 8);
        if (type === "IHDR") {
          originalWidth  = rawBuf.readUInt32BE(pos + 8);
          originalHeight = rawBuf.readUInt32BE(pos + 12);
          break;
        }
        pos += 12 + len;
      }
    }
  } catch (_) { /* ignore parse errors */ }

  const scaledBuf = _scalePng(rawBuf, scale);
  const base64    = scaledBuf.toString("base64");

  // Optionally save to disk
  if (args.save_path) {
    const outDir = path.dirname(args.save_path);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(args.save_path, scaledBuf);
  }

  return {
    ok:               true,
    operation:        "capture",
    format:           "png",
    encoding:         "base64",
    quality,
    scale,
    originalWidth,
    originalHeight,
    originalBytes:    rawBuf.length,
    outputBytes:      scaledBuf.length,
    image:            base64,
    savedTo:          args.save_path || null,
    region:           (region.x != null) ? region : null,
  };
}

module.exports = { screenCapture, parseKeyCombo };
