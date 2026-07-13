"use strict";
/**
 * tftp_client — Zero-dependency TFTP client.
 * Pure Node.js (dgram built-in; no npm deps).
 *
 * Implements:
 *   RFC 1350  — TFTP Protocol (Revision 2)
 *   RFC 2347  — TFTP Option Extension
 *   RFC 2348  — TFTP Blocksize Option
 *   RFC 2349  — TFTP Timeout Interval and Transfer Size Options
 *
 * Operations:
 *   get    — Download a file from a TFTP server
 *   put    — Upload a file to a TFTP server
 *   info   — Return config / protocol info (no I/O)
 *
 * Modes supported: octet (binary), netascii (text)
 *
 * Security:
 *   - NUL-byte guards on host/filename
 *   - Timeout clamped 1s–60s (default 5s)
 *   - Block size clamped 8–65464 bytes (RFC 2348)
 *   - Max transfer size: 256 MB
 *   - Port must be 1–65535
 *   - Retransmit up to 3 times per block
 */

const dgram = require("dgram");

// ── Constants ─────────────────────────────────────────────────────────────────
const TFTP_PORT            = 69;
const DEFAULT_TIMEOUT_MS   = 5_000;
const MIN_TIMEOUT_MS       = 1_000;
const MAX_TIMEOUT_MS       = 60_000;
const DEFAULT_BLOCK_SIZE   = 512;      // RFC 1350 default
const MIN_BLOCK_SIZE       = 8;        // RFC 2348 minimum
const MAX_BLOCK_SIZE       = 65_464;   // RFC 2348 maximum (65535 - 28 UDP/IP overhead)
const MAX_TRANSFER_BYTES   = 256 * 1024 * 1024; // 256 MB
const MAX_RETRIES          = 3;

// TFTP Opcode values (RFC 1350 §5)
const OP_RRQ   = 1;  // Read Request
const OP_WRQ   = 2;  // Write Request
const OP_DATA  = 3;  // Data
const OP_ACK   = 4;  // Acknowledgement
const OP_ERROR = 5;  // Error
const OP_OACK  = 6;  // Option Acknowledgement (RFC 2347)

// TFTP Error codes (RFC 1350 §5)
const ERROR_CODES = {
  0: "Not defined",
  1: "File not found",
  2: "Access violation",
  3: "Disk full or allocation exceeded",
  4: "Illegal TFTP operation",
  5: "Unknown transfer ID",
  6: "File already exists",
  7: "No such user",
  8: "Failed to negotiate options",
};

// ── Validation helpers ────────────────────────────────────────────────────────
function guardNul(value, name) {
  if (typeof value === "string" && value.includes("\0"))
    throw new Error(`tftp_client: '${name}' must not contain NUL bytes.`);
}

function clampTimeout(t) {
  const n = typeof t === "number" ? t : DEFAULT_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.trunc(n)));
}

function clampBlockSize(bs) {
  if (bs == null) return DEFAULT_BLOCK_SIZE;
  const n = Math.trunc(Number(bs));
  if (!isFinite(n)) return DEFAULT_BLOCK_SIZE;
  return Math.max(MIN_BLOCK_SIZE, Math.min(MAX_BLOCK_SIZE, n));
}

// ── Packet builders ───────────────────────────────────────────────────────────

/**
 * Build an RRQ or WRQ packet.
 * Format: 2-byte opcode | filename | \0 | mode | \0 [| option | \0 | value | \0 ...]
 */
function buildRequestPacket(opcode, filename, mode, options) {
  const parts = [];
  // Opcode (2 bytes BE)
  parts.push(Buffer.from([0, opcode]));
  // Filename (null-terminated)
  parts.push(Buffer.from(filename, "ascii"));
  parts.push(Buffer.from([0]));
  // Mode (null-terminated)
  parts.push(Buffer.from(mode, "ascii"));
  parts.push(Buffer.from([0]));
  // Options (RFC 2347)
  for (const [key, val] of Object.entries(options || {})) {
    parts.push(Buffer.from(String(key), "ascii"));
    parts.push(Buffer.from([0]));
    parts.push(Buffer.from(String(val), "ascii"));
    parts.push(Buffer.from([0]));
  }
  return Buffer.concat(parts);
}

/**
 * Build an ACK packet.
 * Format: 2-byte opcode (4) | 2-byte block number
 */
function buildAckPacket(blockNum) {
  const buf = Buffer.allocUnsafe(4);
  buf.writeUInt16BE(OP_ACK, 0);
  buf.writeUInt16BE(blockNum & 0xFFFF, 2);
  return buf;
}

/**
 * Build a DATA packet.
 * Format: 2-byte opcode (3) | 2-byte block number | data bytes
 */
function buildDataPacket(blockNum, data) {
  const header = Buffer.allocUnsafe(4);
  header.writeUInt16BE(OP_DATA, 0);
  header.writeUInt16BE(blockNum & 0xFFFF, 2);
  return Buffer.concat([header, data]);
}

/**
 * Build an ERROR packet.
 * Format: 2-byte opcode (5) | 2-byte error code | error message | \0
 */
function buildErrorPacket(code, message) {
  const header = Buffer.allocUnsafe(4);
  header.writeUInt16BE(OP_ERROR, 0);
  header.writeUInt16BE(code & 0xFFFF, 2);
  const msgBuf = Buffer.from(message || "", "ascii");
  return Buffer.concat([header, msgBuf, Buffer.from([0])]);
}

/**
 * Parse a received TFTP packet.
 * Returns { opcode, blockNum?, data?, errorCode?, errorMessage?, options? }
 */
function parsePacket(buf) {
  if (buf.length < 2) return { opcode: -1 };
  const opcode = buf.readUInt16BE(0);

  if (opcode === OP_DATA) {
    if (buf.length < 4) return { opcode: OP_DATA, blockNum: 0, data: Buffer.alloc(0) };
    const blockNum = buf.readUInt16BE(2);
    const data = buf.slice(4);
    return { opcode: OP_DATA, blockNum, data };
  }

  if (opcode === OP_ACK) {
    if (buf.length < 4) return { opcode: OP_ACK, blockNum: 0 };
    const blockNum = buf.readUInt16BE(2);
    return { opcode: OP_ACK, blockNum };
  }

  if (opcode === OP_ERROR) {
    const errorCode = buf.length >= 4 ? buf.readUInt16BE(2) : 0;
    // Error message is null-terminated string after the 4-byte header
    let errorMessage = "";
    if (buf.length > 4) {
      const end = buf.indexOf(0, 4);
      errorMessage = buf.slice(4, end === -1 ? buf.length : end).toString("ascii");
    }
    return { opcode: OP_ERROR, errorCode, errorMessage };
  }

  if (opcode === OP_OACK) {
    // Option ACK: pairs of null-terminated key/value strings
    const options = {};
    let pos = 2;
    while (pos < buf.length) {
      const keyEnd = buf.indexOf(0, pos);
      if (keyEnd === -1) break;
      const key = buf.slice(pos, keyEnd).toString("ascii").toLowerCase();
      pos = keyEnd + 1;
      const valEnd = buf.indexOf(0, pos);
      const val = buf.slice(pos, valEnd === -1 ? buf.length : valEnd).toString("ascii");
      pos = valEnd === -1 ? buf.length : valEnd + 1;
      if (key) options[key] = val;
    }
    return { opcode: OP_OACK, options };
  }

  return { opcode };
}

// ── Core transfer logic ───────────────────────────────────────────────────────

/**
 * Perform a TFTP GET (Read Request) operation.
 *
 * Downloads a file from the server using RFC 1350 block protocol.
 * Supports RFC 2347/2348 blksize option negotiation.
 *
 * @param {object} opts
 * @returns {Promise<Buffer>} - The downloaded file content
 */
async function tftpGet(opts) {
  const {
    host,
    port        = TFTP_PORT,
    filename,
    mode        = "octet",
    timeoutMs   = DEFAULT_TIMEOUT_MS,
    blockSize   = DEFAULT_BLOCK_SIZE,
    useOptions  = true,
  } = opts;

  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    let serverPort = null;   // assigned after first DATA/OACK from server (RFC 1350 §2)
    let expectedBlock = 1;
    const chunks = [];
    let totalBytes = 0;
    let done = false;
    let retries = 0;
    let lastAck = null;      // last ACK we sent (for retransmit)
    let timer = null;

    function cleanup(err) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.close();
      if (err) reject(err);
      else resolve(Buffer.concat(chunks));
    }

    function sendPacket(buf, toPort) {
      socket.send(buf, 0, buf.length, toPort || port, host, (err) => {
        if (err) cleanup(new Error(`tftp_client: UDP send error: ${err.message}`));
      });
    }

    function resetTimer() {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (retries < MAX_RETRIES && lastAck) {
          retries++;
          sendPacket(lastAck, serverPort || port);
          resetTimer();
        } else {
          cleanup(new Error(
            `tftp_client: GET '${filename}' timed out after ${timeoutMs} ms ` +
            `(block ${expectedBlock - 1}, ${retries} retries).`
          ));
        }
      }, timeoutMs);
    }

    socket.on("error", (err) => {
      cleanup(new Error(`tftp_client: socket error: ${err.message}`));
    });

    socket.on("message", (msg, rinfo) => {
      if (done) return;

      // RFC 1350 §4: server uses a new ephemeral port (TID)
      if (serverPort === null) {
        serverPort = rinfo.port;
      } else if (rinfo.port !== serverPort) {
        // Unknown TID — send error and ignore
        sendPacket(buildErrorPacket(5, "Unknown transfer ID"), rinfo.port);
        return;
      }

      clearTimeout(timer);
      retries = 0;
      const pkt = parsePacket(msg);

      if (pkt.opcode === OP_ERROR) {
        const desc = ERROR_CODES[pkt.errorCode] || "Unknown error";
        cleanup(new Error(
          `tftp_client: server error ${pkt.errorCode} (${desc}): ${pkt.errorMessage || ""}`
        ));
        return;
      }

      if (pkt.opcode === OP_OACK) {
        // Server acknowledged our options — send ACK 0 to start data flow
        lastAck = buildAckPacket(0);
        sendPacket(lastAck, serverPort);
        resetTimer();
        return;
      }

      if (pkt.opcode === OP_DATA) {
        const { blockNum, data } = pkt;

        if (blockNum === expectedBlock) {
          // New block — accept it
          totalBytes += data.length;
          if (totalBytes > MAX_TRANSFER_BYTES) {
            cleanup(new Error(
              `tftp_client: transfer size exceeded limit of ${MAX_TRANSFER_BYTES} bytes.`
            ));
            return;
          }
          chunks.push(Buffer.from(data)); // defensive copy
          lastAck = buildAckPacket(blockNum);
          sendPacket(lastAck, serverPort);
          expectedBlock = (expectedBlock + 1) & 0xFFFF;

          // Final block: last data block is shorter than block size
          if (data.length < blockSize) {
            // Send final ACK and finish
            // Small delay to allow final ACK to be delivered before socket close
            setTimeout(() => cleanup(null), 50);
            return;
          }
          resetTimer();
        } else if (blockNum === (expectedBlock - 1) & 0xFFFF) {
          // Duplicate block — re-send last ACK (Sorcerer's Apprentice protection)
          if (lastAck) sendPacket(lastAck, serverPort);
          resetTimer();
        }
        // else: ignore out-of-sequence blocks
        return;
      }

      // Unexpected opcode
      cleanup(new Error(`tftp_client: unexpected opcode ${pkt.opcode} from server.`));
    });

    // ── Initiate: send RRQ ──────────────────────────────────────────────────
    socket.bind(0, () => {
      const options = useOptions && blockSize !== DEFAULT_BLOCK_SIZE
        ? { blksize: String(blockSize) }
        : {};
      const rrq = buildRequestPacket(OP_RRQ, filename, mode, options);
      sendPacket(rrq, port);
      resetTimer();
    });
  });
}

/**
 * Perform a TFTP PUT (Write Request) operation.
 *
 * Uploads data to the server using RFC 1350 block protocol.
 * Supports RFC 2347/2348 blksize and RFC 2349 tsize option negotiation.
 *
 * @param {object} opts
 * @param {Buffer} opts.data - Data to upload
 */
async function tftpPut(opts) {
  const {
    host,
    port        = TFTP_PORT,
    filename,
    mode        = "octet",
    data,
    timeoutMs   = DEFAULT_TIMEOUT_MS,
    blockSize   = DEFAULT_BLOCK_SIZE,
    useOptions  = true,
  } = opts;

  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    let serverPort = null;
    let currentBlock = 1;      // block number to send next
    let done = false;
    let retries = 0;
    let lastSent = null;       // last DATA or WRQ packet (for retransmit)
    let timer = null;
    let waitingForOack = useOptions && (blockSize !== DEFAULT_BLOCK_SIZE || data.length > 0);

    // Total blocks (may be 0 if data is empty)
    const totalBlocks = Math.max(1, Math.ceil(data.length / blockSize));

    function cleanup(err) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.close();
      if (err) reject(err);
      else resolve();
    }

    function sendPacket(buf, toPort) {
      socket.send(buf, 0, buf.length, toPort || port, host, (err) => {
        if (err) cleanup(new Error(`tftp_client: UDP send error: ${err.message}`));
      });
    }

    function resetTimer() {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (retries < MAX_RETRIES && lastSent) {
          retries++;
          sendPacket(lastSent, serverPort || port);
          resetTimer();
        } else {
          cleanup(new Error(
            `tftp_client: PUT '${filename}' timed out after ${timeoutMs} ms ` +
            `(block ${currentBlock}, ${retries} retries).`
          ));
        }
      }, timeoutMs);
    }

    /**
     * Send block number `blockNum` to the server.
     * block 1 = bytes [0 .. blockSize-1] of data
     */
    function sendDataBlock(blockNum) {
      const start = (blockNum - 1) * blockSize;
      const end   = Math.min(start + blockSize, data.length);
      const chunk = data.slice(start, end);
      const pkt   = buildDataPacket(blockNum, chunk);
      lastSent    = pkt;
      sendPacket(pkt, serverPort);
      resetTimer();
    }

    socket.on("error", (err) => {
      cleanup(new Error(`tftp_client: socket error: ${err.message}`));
    });

    socket.on("message", (msg, rinfo) => {
      if (done) return;

      // Track server TID
      if (serverPort === null) {
        serverPort = rinfo.port;
      } else if (rinfo.port !== serverPort) {
        sendPacket(buildErrorPacket(5, "Unknown transfer ID"), rinfo.port);
        return;
      }

      clearTimeout(timer);
      retries = 0;
      const pkt = parsePacket(msg);

      if (pkt.opcode === OP_ERROR) {
        const desc = ERROR_CODES[pkt.errorCode] || "Unknown error";
        cleanup(new Error(
          `tftp_client: server error ${pkt.errorCode} (${desc}): ${pkt.errorMessage || ""}`
        ));
        return;
      }

      if (pkt.opcode === OP_OACK) {
        // Server accepted options — start sending data (block 1)
        waitingForOack = false;
        sendDataBlock(currentBlock);
        return;
      }

      if (pkt.opcode === OP_ACK) {
        const { blockNum } = pkt;

        if (blockNum === 0 && waitingForOack) {
          // ACK 0 = server acknowledges WRQ without OACK (no options)
          waitingForOack = false;
          sendDataBlock(currentBlock);
          return;
        }

        if (blockNum === currentBlock - 1 && blockNum === 0 && currentBlock === 1) {
          // Server ACKed the WRQ (block 0) — start sending
          sendDataBlock(currentBlock);
          return;
        }

        if (blockNum === currentBlock) {
          // Our last DATA block was ACKed
          // Check if we just sent the last block
          const lastBlockData = data.slice((currentBlock - 1) * blockSize, currentBlock * blockSize);
          if (lastBlockData.length < blockSize) {
            // This was the final block (short block = EOF signal)
            cleanup(null);
            return;
          }
          if (currentBlock === totalBlocks && data.length % blockSize === 0) {
            // Data length is an exact multiple of blockSize:
            // must send an empty final block to signal EOF
            currentBlock++;
            sendDataBlock(currentBlock);
            return;
          }
          currentBlock++;
          if (currentBlock > totalBlocks + 1) {
            cleanup(null);
            return;
          }
          sendDataBlock(currentBlock);
          return;
        }

        // Duplicate ACK — ignore (already moved on)
        if (blockNum < currentBlock) {
          resetTimer(); // still waiting
          return;
        }
      }
    });

    // ── Initiate: send WRQ ──────────────────────────────────────────────────
    socket.bind(0, () => {
      const options = {};
      if (useOptions) {
        if (blockSize !== DEFAULT_BLOCK_SIZE) options.blksize = String(blockSize);
        options.tsize = String(data.length);  // RFC 2349
      }
      const wrq = buildRequestPacket(OP_WRQ, filename, mode, options);
      lastSent = wrq;
      sendPacket(wrq, port);
      resetTimer();
    });
  });
}

// ── Operations ────────────────────────────────────────────────────────────────

/** get — Download a file from a TFTP server */
async function opGet(args) {
  const host     = (args.host     || "").trim();
  const filename = (args.filename || "").trim();
  const mode     = (args.mode     || "octet").toLowerCase();
  const port     = args.port ?? TFTP_PORT;
  const timeoutMs = clampTimeout(args.timeout);
  const blockSize = clampBlockSize(args.block_size);

  if (!host)     throw new Error("tftp_client: 'host' is required.");
  if (!filename) throw new Error("tftp_client: 'filename' is required.");
  guardNul(host,     "host");
  guardNul(filename, "filename");

  if (typeof port !== "number" || port < 1 || port > 65535)
    throw new Error("tftp_client: 'port' must be 1–65535.");
  if (mode !== "octet" && mode !== "netascii")
    throw new Error("tftp_client: 'mode' must be 'octet' or 'netascii'.");

  const t0 = Date.now();
  const dataBuf = await tftpGet({
    host, port, filename, mode, timeoutMs, blockSize,
    useOptions: args.use_options !== false,
  });

  const elapsedMs = Date.now() - t0;
  const sizeBytes = dataBuf.length;
  const encoding  = args.output_encoding || "base64";

  let content;
  if (encoding === "utf8" || encoding === "text") {
    content = dataBuf.toString("utf8");
  } else {
    content = dataBuf.toString("base64");
  }

  return {
    ok:        true,
    operation: "get",
    host,
    port,
    filename,
    mode,
    sizeBytes,
    blockSize,
    elapsedMs,
    encoding:  encoding === "utf8" || encoding === "text" ? "utf8" : "base64",
    content,
    throughputKBps: sizeBytes > 0 ? Math.round((sizeBytes / 1024) / (elapsedMs / 1000) * 10) / 10 : 0,
  };
}

/** put — Upload data/string to a TFTP server */
async function opPut(args) {
  const host     = (args.host     || "").trim();
  const filename = (args.filename || "").trim();
  const mode     = (args.mode     || "octet").toLowerCase();
  const port     = args.port ?? TFTP_PORT;
  const timeoutMs = clampTimeout(args.timeout);
  const blockSize = clampBlockSize(args.block_size);

  if (!host)     throw new Error("tftp_client: 'host' is required.");
  if (!filename) throw new Error("tftp_client: 'filename' is required.");
  if (args.data == null && args.content == null)
    throw new Error("tftp_client: 'data' (base64) or 'content' (text string) is required.");

  guardNul(host,     "host");
  guardNul(filename, "filename");

  if (typeof port !== "number" || port < 1 || port > 65535)
    throw new Error("tftp_client: 'port' must be 1–65535.");
  if (mode !== "octet" && mode !== "netascii")
    throw new Error("tftp_client: 'mode' must be 'octet' or 'netascii'.");

  // Build data buffer from either base64 'data' or text 'content'
  let dataBuf;
  if (args.data != null) {
    if (typeof args.data !== "string")
      throw new Error("tftp_client: 'data' must be a base64-encoded string.");
    dataBuf = Buffer.from(args.data, "base64");
  } else {
    if (typeof args.content !== "string")
      throw new Error("tftp_client: 'content' must be a string.");
    // netascii mode: convert \n to \r\n
    const text = mode === "netascii"
      ? args.content.replace(/\r?\n/g, "\r\n")
      : args.content;
    dataBuf = Buffer.from(text, "utf8");
  }

  if (dataBuf.length > MAX_TRANSFER_BYTES)
    throw new Error(`tftp_client: data too large (${dataBuf.length} bytes; max ${MAX_TRANSFER_BYTES}).`);

  const t0 = Date.now();
  await tftpPut({
    host, port, filename, mode, data: dataBuf, timeoutMs, blockSize,
    useOptions: args.use_options !== false,
  });
  const elapsedMs = Date.now() - t0;

  return {
    ok:        true,
    operation: "put",
    host,
    port,
    filename,
    mode,
    sizeBytes: dataBuf.length,
    blockSize,
    elapsedMs,
    throughputKBps: dataBuf.length > 0 ? Math.round((dataBuf.length / 1024) / (elapsedMs / 1000) * 10) / 10 : 0,
  };
}

/** info — Return protocol info (no I/O) */
function opInfo() {
  return {
    ok:        true,
    operation: "info",
    protocol: {
      name:         "TFTP — Trivial File Transfer Protocol",
      rfcs:         ["RFC 1350 (protocol)", "RFC 2347 (options)", "RFC 2348 (blocksize)", "RFC 2349 (timeout/tsize)"],
      transport:    "UDP",
      defaultPort:  TFTP_PORT,
      modes:        ["octet (binary)", "netascii (text, \\n → \\r\\n)"],
    },
    opcodes: {
      RRQ:  OP_RRQ,
      WRQ:  OP_WRQ,
      DATA: OP_DATA,
      ACK:  OP_ACK,
      ERROR: OP_ERROR,
      OACK:  OP_OACK,
    },
    errorCodes:    ERROR_CODES,
    defaults: {
      port:          TFTP_PORT,
      timeoutMs:     DEFAULT_TIMEOUT_MS,
      blockSize:     DEFAULT_BLOCK_SIZE,
      maxBlockSize:  MAX_BLOCK_SIZE,
      minBlockSize:  MIN_BLOCK_SIZE,
      maxTransferMB: MAX_TRANSFER_BYTES / (1024 * 1024),
      maxRetries:    MAX_RETRIES,
    },
    operations: [
      "get  — Download a file (RRQ, RFC 1350)",
      "put  — Upload a file/data (WRQ, RFC 1350)",
      "info — Return this info object (no I/O)",
    ],
    notes: [
      "Zero npm dependencies — pure Node.js dgram built-in.",
      "octet mode: raw binary transfer (recommended for all files).",
      "netascii mode: text transfer with \\n↔\\r\\n conversion.",
      "RFC 2348 blksize option supported (8–65464 bytes, default 512).",
      "RFC 2349 tsize option sent on PUT for server to pre-allocate.",
      "Sorcerer's Apprentice Syndrome prevention: duplicate blocks/ACKs ignored.",
      "TID verification: packets from unknown ports trigger ERROR 5.",
      "Timeout: 1s–60s (default 5s); up to 3 retransmits per block.",
      "Block number wraparound supported (16-bit, wraps at 65535).",
    ],
  };
}

// ── Main entry point ──────────────────────────────────────────────────────────
async function tftpClient(args) {
  const op = args.operation;
  if (!op) throw new Error("tftp_client: 'operation' is required.");

  switch (op) {
    case "get":  return opGet(args);
    case "put":  return opPut(args);
    case "info": return opInfo();
    default:
      throw new Error(
        `tftp_client: unknown operation '${op}'. Valid: get, put, info.`
      );
  }
}

module.exports = {
  tftpClient,
  // Exported for testing
  buildRequestPacket,
  buildAckPacket,
  buildDataPacket,
  buildErrorPacket,
  parsePacket,
  clampTimeout,
  clampBlockSize,
  guardNul,
  TFTP_PORT,
  DEFAULT_BLOCK_SIZE,
  MAX_BLOCK_SIZE,
  MIN_BLOCK_SIZE,
  MAX_RETRIES,
  MAX_TRANSFER_BYTES,
  OP_RRQ, OP_WRQ, OP_DATA, OP_ACK, OP_ERROR, OP_OACK,
  ERROR_CODES,
  DEFAULT_TIMEOUT_MS,
};
