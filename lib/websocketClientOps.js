"use strict";
// ── WEBSOCKET_CLIENT — RFC 6455 WebSocket client ────────────────────────────────
// Zero npm dependencies — uses Node.js built-in net/tls/crypto modules.
// Opens a WebSocket connection, sends messages, collects responses, closes.
// Supports ws:// and wss://, text/binary frames, ping/pong auto-response,
// fragmented messages (continuation frames), and partial TCP reads.

const net    = require("net");
const tls    = require("tls");
const crypto = require("crypto");
const { ToolError } = require("./errors");

const WS_GUID          = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const OP_CONTINUATION  = 0x0;
const OP_TEXT          = 0x1;
const OP_BINARY        = 0x2;
const OP_CLOSE         = 0x8;
const OP_PING          = 0x9;
const OP_PONG          = 0xA;

const DEFAULT_TIMEOUT_S      = 10;
const MAX_TIMEOUT_S          = 120;
const DEFAULT_MAX_MESSAGES   = 50;
const MAX_MESSAGES           = 1000;
const MAX_SEND_MESSAGES      = 100;
const MAX_PAYLOAD_BYTES      = 1 * 1024 * 1024;  // 1 MB per received message
const MAX_TOTAL_PAYLOAD      = 10 * 1024 * 1024; // 10 MB accumulated
const MAX_SEND_PAYLOAD_BYTES = 512 * 1024;        // 512 KB per sent message
const MAX_SUBPROTOCOL_LEN    = 200;
const MAX_HEADER_VALUE_LEN   = 4000;
const MAX_EXTRA_HEADERS      = 30;

// ── Frame builder (client → server frames MUST be masked per RFC 6455 §5.3) ──
function buildFrame(opcode, payload, fin = true) {
  const maskKey    = crypto.randomBytes(4);
  const payLen     = payload.length;
  let   headerSize = 2 + 4; // base + mask key

  if (payLen > 65535)      headerSize += 8;
  else if (payLen > 125)   headerSize += 2;

  const frame  = Buffer.allocUnsafe(headerSize + payLen);
  let   offset = 0;

  frame[offset++] = (fin ? 0x80 : 0x00) | (opcode & 0x0F);

  if (payLen > 65535) {
    frame[offset++] = 0x80 | 127;
    // 8-byte big-endian extended payload length
    const hi = Math.floor(payLen / 0x100000000);
    const lo = payLen >>> 0;
    frame.writeUInt32BE(hi, offset); offset += 4;
    frame.writeUInt32BE(lo, offset); offset += 4;
  } else if (payLen > 125) {
    frame[offset++] = 0x80 | 126;
    frame.writeUInt16BE(payLen, offset); offset += 2;
  } else {
    frame[offset++] = 0x80 | payLen;
  }

  maskKey.copy(frame, offset); offset += 4;

  for (let i = 0; i < payLen; i++) {
    frame[offset++] = payload[i] ^ maskKey[i % 4];
  }
  return frame;
}

// ── Frame parser — stateful, handles TCP fragmentation ───────────────────────
// Produces complete WebSocket frames from a stream of raw TCP chunks.
class FrameParser {
  constructor() {
    this._buf    = Buffer.alloc(0);
    this._frames = [];
  }

  push(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    this._parse();
  }

  _parse() {
    while (this._buf.length >= 2) {
      const fin     = (this._buf[0] & 0x80) !== 0;
      const rsv     = (this._buf[0] & 0x70);
      const opcode  = (this._buf[0] & 0x0F);
      const masked  = (this._buf[1] & 0x80) !== 0;
      let   payLen  = (this._buf[1] & 0x7F);
      let   hEnd    = 2;

      if (payLen === 126) {
        if (this._buf.length < 4) break;
        payLen = this._buf.readUInt16BE(2);
        hEnd   = 4;
      } else if (payLen === 127) {
        if (this._buf.length < 10) break;
        const hi = this._buf.readUInt32BE(2);
        const lo = this._buf.readUInt32BE(6);
        payLen   = hi * 0x100000000 + lo;
        hEnd     = 10;
      }

      if (masked) hEnd += 4;

      const total = hEnd + payLen;
      if (this._buf.length < total) break;

      let payload;
      if (masked) {
        const key = this._buf.slice(hEnd - 4, hEnd);
        payload = Buffer.from(this._buf.slice(hEnd, total));
        for (let i = 0; i < payload.length; i++) payload[i] ^= key[i % 4];
      } else {
        payload = Buffer.from(this._buf.slice(hEnd, total));
      }

      this._frames.push({ fin, rsv, opcode, payload });
      this._buf = this._buf.slice(total);
    }
  }

  /** @returns {{fin,opcode,payload}|null} */
  shift() {
    return this._frames.shift() ?? null;
  }
}

// ── Validate inputs ───────────────────────────────────────────────────────────
function validateInputs(opts) {
  const url = opts.url;
  if (!url || typeof url !== "string") {
    throw new ToolError("websocket_client: 'url' is required and must be a string.", -32602);
  }
  if (!/^wss?:\/\//i.test(url)) {
    throw new ToolError("websocket_client: 'url' must start with ws:// or wss://.", -32602);
  }
  // Basic injection guard: no newlines in URL
  if (/[\r\n]/.test(url)) {
    throw new ToolError("websocket_client: 'url' must not contain newline characters.", -32602);
  }
  if (url.includes('\x00') || /\x00/.test(url)) {
    throw new ToolError("websocket_client: 'url' must not contain null bytes.", -32602);
  }

  const messages = opts.messages ?? [];
  if (!Array.isArray(messages)) {
    throw new ToolError("websocket_client: 'messages' must be an array.", -32602);
  }
  if (messages.length > MAX_SEND_MESSAGES) {
    throw new ToolError(
      `websocket_client: 'messages' may contain at most ${MAX_SEND_MESSAGES} entries.`, -32602,
    );
  }
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || typeof m !== "object") {
      throw new ToolError(`websocket_client: messages[${i}] must be an object.`, -32602);
    }
    if (m.text != null && typeof m.text !== "string") {
      throw new ToolError(`websocket_client: messages[${i}].text must be a string.`, -32602);
    }
    if (m.data != null && typeof m.data !== "string") {
      throw new ToolError(`websocket_client: messages[${i}].data must be a string.`, -32602);
    }
    if (m.text == null && m.data == null) {
      throw new ToolError(
        `websocket_client: messages[${i}] must have 'text' (string) or 'data' (base64 string).`, -32602,
      );
    }
    const payBuf = m.text != null
      ? Buffer.from(m.text, "utf8")
      : Buffer.from(m.data, m.encoding ?? "base64");
    if (payBuf.length > MAX_SEND_PAYLOAD_BYTES) {
      throw new ToolError(
        `websocket_client: messages[${i}] exceeds ${MAX_SEND_PAYLOAD_BYTES} bytes.`, -32602,
      );
    }
    if (m.delay_ms != null && (typeof m.delay_ms !== "number" || m.delay_ms < 0 || m.delay_ms > 60000)) {
      throw new ToolError(`websocket_client: messages[${i}].delay_ms must be 0–60000.`, -32602);
    }
  }

  let timeout = DEFAULT_TIMEOUT_S;
  if (opts.timeout !== undefined) {
    if (typeof opts.timeout !== "number" || !Number.isFinite(opts.timeout) || opts.timeout <= 0) {
      throw new ToolError("websocket_client: 'timeout' must be a positive number of seconds.", -32602);
    }
    timeout = Math.min(opts.timeout, MAX_TIMEOUT_S);
  }

  let maxMessages = DEFAULT_MAX_MESSAGES;
  if (opts.max_messages !== undefined) {
    if (typeof opts.max_messages !== "number" || !Number.isInteger(opts.max_messages) || opts.max_messages < 1) {
      throw new ToolError("websocket_client: 'max_messages' must be a positive integer.", -32602);
    }
    maxMessages = Math.min(opts.max_messages, MAX_MESSAGES);
  }

  const headers = opts.headers ?? {};
  if (typeof headers !== "object" || Array.isArray(headers)) {
    throw new ToolError("websocket_client: 'headers' must be a plain object.", -32602);
  }
  if (Object.keys(headers).length > MAX_EXTRA_HEADERS) {
    throw new ToolError(`websocket_client: 'headers' may have at most ${MAX_EXTRA_HEADERS} entries.`, -32602);
  }
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v !== "string" && typeof v !== "number") {
      throw new ToolError(`websocket_client: headers['${k}'] must be a string or number.`, -32602);
    }
    if (String(v).length > MAX_HEADER_VALUE_LEN || /[\r\n]/.test(String(v))) {
      throw new ToolError(`websocket_client: headers['${k}'] contains invalid characters or is too long.`, -32602);
    }
    // Prevent overriding WS upgrade headers
    const kLower = k.toLowerCase();
    if (["upgrade", "connection", "sec-websocket-key", "sec-websocket-version"].includes(kLower)) {
      throw new ToolError(
        `websocket_client: cannot override reserved header '${k}'.`, -32602,
      );
    }
  }

  const subprotocol = opts.subprotocol;
  if (subprotocol != null) {
    if (typeof subprotocol !== "string" || subprotocol.length === 0) {
      throw new ToolError("websocket_client: 'subprotocol' must be a non-empty string.", -32602);
    }
    if (subprotocol.length > MAX_SUBPROTOCOL_LEN || /[\r\n ,;]/.test(subprotocol)) {
      throw new ToolError(
        "websocket_client: 'subprotocol' is too long or contains invalid characters.", -32602,
      );
    }
  }

  return { url, messages, timeout, maxMessages, headers, subprotocol };
}

// ── Parse ws:// URL into { secure, host, port, path } ────────────────────────
function parseWsUrl(url) {
  const m = url.match(/^(wss?):\/\/([^/:?#]+)(?::(\d+))?(\/[^?#]*)?(?:\?[^#]*)?(#.*)?$/i);
  if (!m) throw new ToolError(`websocket_client: malformed WebSocket URL: ${url}`, -32602);
  const secure = m[1].toLowerCase() === "wss";
  const host   = m[2];
  const port   = m[3] ? parseInt(m[3], 10) : (secure ? 443 : 80);
  const path   = (m[4] || "/") + (url.includes("?") ? "?" + url.split("?")[1].split("#")[0] : "");
  return { secure, host, port, path };
}

// ── Build & send WebSocket close frame ───────────────────────────────────────
function sendClose(socket, code = 1000, reason = "") {
  try {
    const codeBuf    = Buffer.allocUnsafe(2);
    codeBuf.writeUInt16BE(code, 0);
    const reasonBuf  = Buffer.from(reason, "utf8").slice(0, 123);
    const payload    = Buffer.concat([codeBuf, reasonBuf]);
    socket.write(buildFrame(OP_CLOSE, payload));
  } catch (_) { /* ignore write errors during shutdown */ }
}

// ── Main entry point ──────────────────────────────────────────────────────────
/**
 * @param {object} opts
 * @param {string}   opts.url            ws:// or wss:// URL
 * @param {Array}    [opts.messages]     [{text?,data?,encoding?,delay_ms?}]
 * @param {number}   [opts.timeout]      seconds (default 10, max 120)
 * @param {number}   [opts.max_messages] max frames to collect (default 50, max 1000)
 * @param {object}   [opts.headers]      extra HTTP headers for the upgrade request
 * @param {string}   [opts.subprotocol]  Sec-WebSocket-Protocol value
 * @returns {Promise<object>}
 */
function websocketClient(opts = {}) {
  const { url, messages, timeout, maxMessages, headers, subprotocol } = validateInputs(opts);
  const { secure, host, port, path } = parseWsUrl(url);

  return new Promise((resolve) => {
    const startMs     = Date.now();
    const received    = [];
    let   totalBytes  = 0;
    let   msgsSent    = 0;
    let   handshakeMs = null;
    let   closed      = false;
    let   closeCode   = null;
    let   closeReason = null;
    let   settled     = false;
    let   timer       = null;

    // Fragmented message reassembly buffer
    let   fragOpcode = null;
    let   fragBufs   = [];

    function finish(error) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      timer = null;

      const result = {
        url,
        connected: handshakeMs !== null,
        handshakeMs,
        messagesSent: msgsSent,
        messagesReceived: received.length,
        messages: received,
        closed,
        closeCode,
        closeReason,
        elapsedMs: Date.now() - startMs,
      };
      if (error) result.error = String(error);
      resolve(result);
    }

    // ── Build HTTP/1.1 Upgrade request ───────────────────────────────────────
    const wsKey  = crypto.randomBytes(16).toString("base64");
    const expectedAccept = crypto
      .createHash("sha1")
      .update(wsKey + WS_GUID)
      .digest("base64");

    const headerLines = [
      `GET ${path} HTTP/1.1`,
      `Host: ${host}:${port}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${wsKey}`,
      "Sec-WebSocket-Version: 13",
    ];
    if (subprotocol) headerLines.push(`Sec-WebSocket-Protocol: ${subprotocol}`);
    for (const [k, v] of Object.entries(headers)) headerLines.push(`${k}: ${v}`);
    const httpRequest = headerLines.join("\r\n") + "\r\n\r\n";

    // ── Open TCP / TLS socket ─────────────────────────────────────────────────
    const socketOpts = secure
      ? { host, port, servername: host, rejectUnauthorized: false }
      : {};

    const socket = secure
      ? tls.connect(socketOpts)
      : net.createConnection(port, host);

    // Overall deadline
    timer = setTimeout(() => {
      sendClose(socket, 1001, "client timeout");
      socket.destroy();
      finish("timeout");
    }, timeout * 1000);

    let   httpBuf     = Buffer.alloc(0);
    let   upgraded    = false;
    const parser      = new FrameParser();

    // ── Send messages sequentially with optional delays ───────────────────────
    async function sendMessages(sock) {
      for (const msg of messages) {
        if (settled) break;
        if (msg.delay_ms && msg.delay_ms > 0) {
          await new Promise((r) => setTimeout(r, msg.delay_ms));
        }
        if (settled) break;
        const isText = msg.text != null;
        const payload = isText
          ? Buffer.from(msg.text, "utf8")
          : Buffer.from(msg.data, msg.encoding ?? "base64");
        const frame = buildFrame(isText ? OP_TEXT : OP_BINARY, payload);
        sock.write(frame);
        msgsSent++;
      }
    }

    // ── Handle an assembled WebSocket message ────────────────────────────────
    function handleMessage(opcode, payload) {
      if (received.length >= maxMessages) {
        sendClose(socket, 1000, "max_messages reached");
        socket.destroy();
        finish();
        return;
      }
      totalBytes += payload.length;
      if (totalBytes > MAX_TOTAL_PAYLOAD) {
        sendClose(socket, 1009, "total payload too large");
        socket.destroy();
        finish("received payload exceeded total limit");
        return;
      }

      const entry = {
        index:     received.length,
        type:      opcode === OP_TEXT ? "text" : "binary",
        elapsedMs: Date.now() - startMs,
        sizeBytes: payload.length,
      };

      if (opcode === OP_TEXT) {
        entry.data         = payload.toString("utf8");
        entry.dataEncoding = "utf8";
      } else {
        if (payload.length <= 4096) {
          entry.data         = payload.toString("base64");
          entry.dataEncoding = "base64";
        } else {
          entry.data         = "<binary: " + payload.length + " bytes>";
          entry.dataEncoding = "binary";
        }
      }

      received.push(entry);
    }

    // ── Process data on upgraded connection ──────────────────────────────────
    function processFrames() {
      let frame;
      while ((frame = parser.shift()) !== null) {
        const { fin, opcode, payload } = frame;

        if (opcode === OP_PING) {
          // Auto-respond to ping
          socket.write(buildFrame(OP_PONG, payload));
          continue;
        }

        if (opcode === OP_PONG) {
          // Ignore unsolicited pongs
          continue;
        }

        if (opcode === OP_CLOSE) {
          closed = true;
          if (payload.length >= 2) {
            closeCode   = payload.readUInt16BE(0);
            closeReason = payload.slice(2).toString("utf8");
          } else {
            closeCode   = 1000;
            closeReason = "";
          }
          // Echo close frame and end
          sendClose(socket, closeCode, closeReason);
          socket.destroy();
          finish();
          return;
        }

        // Data frames: handle fragmentation
        if (opcode === OP_CONTINUATION) {
          if (fragOpcode === null) {
            // Unexpected continuation — ignore
            continue;
          }
          fragBufs.push(payload);
          if (fin) {
            const assembled = Buffer.concat(fragBufs);
            const savedOp   = fragOpcode;
            fragOpcode = null;
            fragBufs   = [];
            if (assembled.length > MAX_PAYLOAD_BYTES) {
              sendClose(socket, 1009, "message too large");
              socket.destroy();
              finish("received a message exceeding size limit");
              return;
            }
            handleMessage(savedOp, assembled);
          }
        } else if (opcode === OP_TEXT || opcode === OP_BINARY) {
          if (!fin) {
            // Start of fragmented message
            fragOpcode = opcode;
            fragBufs   = [payload];
          } else {
            if (payload.length > MAX_PAYLOAD_BYTES) {
              sendClose(socket, 1009, "message too large");
              socket.destroy();
              finish("received a message exceeding size limit");
              return;
            }
            handleMessage(opcode, payload);
          }
        }
      }
    }

    // ── Socket event handlers ─────────────────────────────────────────────────
    const connectEvent = secure ? "secureConnect" : "connect";

    socket.once(connectEvent, () => {
      socket.write(httpRequest);
    });

    socket.on("data", (chunk) => {
      if (settled) return;

      if (!upgraded) {
        // Still parsing HTTP/1.1 101 response
        httpBuf = Buffer.concat([httpBuf, chunk]);
        const headerEnd = httpBuf.indexOf("\r\n\r\n");
        if (headerEnd === -1) return; // wait for more

        const responseHeader = httpBuf.slice(0, headerEnd).toString("ascii");
        const leftover       = httpBuf.slice(headerEnd + 4);

        // Validate 101
        const firstLine = responseHeader.split("\r\n")[0];
        if (!/\s101\s/.test(firstLine)) {
          socket.destroy();
          finish(`WebSocket handshake failed: server returned "${firstLine}"`);
          return;
        }

        // Validate Sec-WebSocket-Accept
        const acceptMatch = responseHeader.match(/Sec-WebSocket-Accept:\s*([^\r\n]+)/i);
        if (!acceptMatch || acceptMatch[1].trim() !== expectedAccept) {
          socket.destroy();
          finish(`WebSocket handshake failed: invalid Sec-WebSocket-Accept value`);
          return;
        }

        upgraded    = true;
        handshakeMs = Date.now() - startMs;

        // Feed any data that arrived alongside the HTTP response
        if (leftover.length > 0) {
          parser.push(leftover);
          processFrames();
        }

        // Begin sending messages
        sendMessages(socket).catch((e) => {
          if (!settled) finish(e.message);
        });
        return;
      }

      // WebSocket data
      parser.push(chunk);
      processFrames();
    });

    socket.once("error", (e) => {
      if (!settled) finish(e.message);
    });

    socket.once("close", () => {
      if (!settled) finish();
    });

    socket.once("end", () => {
      if (!settled) finish();
    });
  });
}

module.exports = { websocketClient, buildFrame, FrameParser };
