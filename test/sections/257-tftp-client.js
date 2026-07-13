"use strict";
/**
 * Section 257 — tftp_client tests
 *
 * Five rigor levels:
 *   A — Pure helpers (constants, packet builders, parsers, clamp/guard) — x20
 *   B — Validation / schema (bad inputs)                                — x15
 *   C — Mock-network (loopback UDP server)                               — x12
 *   D — Security (NUL, TID check, oversized data, path traversal)       — x10
 *   E — Concurrency / edge-cases                                        — x8
 *
 * Total: 65 tests
 */

const dgram = require("dgram");
const {
  tftpClient,
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
} = require("../../lib/tftpClientOps");

// ── Harness ────────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const errors = [];

function ok(condition, label) {
  if (condition) {
    passed++;
    console.error(`  ✓ ${label}`);
  } else {
    failed++;
    errors.push(label);
    console.error(`  ✗ FAIL: ${label}`);
  }
}

async function rejects(fn, substr, label) {
  try {
    await fn();
    failed++;
    errors.push(`${label} (expected rejection, got none)`);
    console.error(`  ✗ FAIL: ${label} (expected rejection)`);
  } catch (e) {
    const match = !substr || e.message.includes(substr);
    if (match) {
      passed++;
      console.error(`  ✓ ${label}`);
    } else {
      failed++;
      errors.push(`${label} (msg: ${e.message})`);
      console.error(`  ✗ FAIL: ${label} — got: ${e.message}`);
    }
  }
}

function sec(name) {
  console.error(`\n[${name}]`);
}

// ── UDP mock server helper ─────────────────────────────────────────────────────────
/** Bind a UDP socket and return its port. */
function bindSocket() {
  return new Promise((resolve) => {
    const s = dgram.createSocket("udp4");
    s.bind(0, () => resolve({ socket: s, port: s.address().port }));
  });
}

/** Safely close a dgram socket (ignore EBADF etc.). */
function safeClose(s) {
  try { if (s) s.close(); } catch (_) {}
}

/**
 * Start a one-shot TFTP GET server on a random port.
 * Waits for one RRQ, then sends `data` in block(s), handles ACKs.
 * Resolves with the server port once bound.
 */
function startGetServer(data, blkSize) {
  blkSize = blkSize || DEFAULT_BLOCK_SIZE;
  return new Promise((resolvePort) => {
    const main = dgram.createSocket("udp4");
    main.bind(0, () => resolvePort({ main, port: main.address().port }));

    main.once("message", (msg, rinfo) => {
      const pkt = parsePacket(msg);
      if (pkt.opcode !== OP_RRQ) { safeClose(main); return; }

      // Worker socket (simulates server TID / ephemeral port)
      const worker = dgram.createSocket("udp4");
      worker.bind(0, () => {
        sendBlock(1);
      });

      const totalBlocks = Math.max(1, Math.ceil(data.length / blkSize));
      let sentBlock = 0;

      function sendBlock(bn) {
        sentBlock = bn;
        const start = (bn - 1) * blkSize;
        const chunk = data.slice(start, start + blkSize);
        const dpkt  = buildDataPacket(bn, chunk);
        worker.send(dpkt, 0, dpkt.length, rinfo.port, rinfo.address);
      }

      worker.on("message", (ack) => {
        const ap = parsePacket(ack);
        if (ap.opcode === OP_ACK && ap.blockNum === sentBlock) {
          if (sentBlock >= totalBlocks) {
            safeClose(worker);
            safeClose(main);
          } else {
            sendBlock(sentBlock + 1);
          }
        }
      });

      worker.on("error", () => safeClose(worker));
      safeClose(main); // done listening for new connections
    });
  });
}

/**
 * Start a one-shot TFTP PUT server.
 * Resolves with received Buffer after the full upload.
 */
function startPutServer() {
  return new Promise((resolveSetup) => {
    const chunks = [];
    let expectBlock = 1;
    let receivedP;

    const main = dgram.createSocket("udp4");
    main.bind(0, () => {
      // receivedPromise resolves when upload finishes
      receivedP = new Promise((resData) => {
        main.once("message", (msg, rinfo) => {
          const pkt = parsePacket(msg);
          if (pkt.opcode !== OP_WRQ) { safeClose(main); resData(Buffer.alloc(0)); return; }

          const worker = dgram.createSocket("udp4");
          worker.bind(0, () => {
            // ACK 0 to start data flow
            const ack0 = buildAckPacket(0);
            worker.send(ack0, 0, ack0.length, rinfo.port, rinfo.address);
          });

          worker.on("message", (data) => {
            const dp = parsePacket(data);
            if (dp.opcode === OP_DATA && dp.blockNum === expectBlock) {
              chunks.push(Buffer.from(dp.data));
              const ack = buildAckPacket(expectBlock);
              worker.send(ack, 0, ack.length, rinfo.port, rinfo.address, () => {
                if (dp.data.length < DEFAULT_BLOCK_SIZE) {
                  setTimeout(() => {
                    safeClose(worker);
                    safeClose(main);
                    resData(Buffer.concat(chunks));
                  }, 80);
                } else {
                  expectBlock++;
                }
              });
            }
          });

          worker.on("error", () => safeClose(worker));
          safeClose(main);
        });
      });

      resolveSetup({ port: main.address().port, received: receivedP });
    });
  });
}

// ──────────────────────────────────────────────────────────────────────────────
async function runAll() {

  // =====================================================================
  // A — Pure helpers
  // =====================================================================
  sec("A — Pure helpers");

  // A1-A6: Constants
  ok(TFTP_PORT === 69,                              "A1: TFTP_PORT === 69");
  ok(DEFAULT_BLOCK_SIZE === 512,                    "A2: DEFAULT_BLOCK_SIZE === 512");
  ok(MAX_BLOCK_SIZE === 65464,                      "A3: MAX_BLOCK_SIZE === 65464");
  ok(MIN_BLOCK_SIZE === 8,                          "A4: MIN_BLOCK_SIZE === 8");
  ok(MAX_RETRIES === 3,                             "A5: MAX_RETRIES === 3");
  ok(MAX_TRANSFER_BYTES === 256 * 1024 * 1024,      "A6: MAX_TRANSFER_BYTES === 256 MB");

  // A7-A12: Opcode constants
  ok(OP_RRQ === 1,   "A7:  OP_RRQ === 1");
  ok(OP_WRQ === 2,   "A8:  OP_WRQ === 2");
  ok(OP_DATA === 3,  "A9:  OP_DATA === 3");
  ok(OP_ACK === 4,   "A10: OP_ACK === 4");
  ok(OP_ERROR === 5, "A11: OP_ERROR === 5");
  ok(OP_OACK === 6,  "A12: OP_OACK === 6");

  // A13-A15: Error code map
  ok(ERROR_CODES[1] === "File not found",                "A13: ERROR_CODES[1]");
  ok(ERROR_CODES[2] === "Access violation",              "A14: ERROR_CODES[2]");
  ok(ERROR_CODES[8] === "Failed to negotiate options",   "A15: ERROR_CODES[8]");

  // A16-A18: buildRequestPacket RRQ
  {
    const pkt = buildRequestPacket(OP_RRQ, "boot.bin", "octet", {});
    ok(pkt.readUInt16BE(0) === OP_RRQ,          "A16: RRQ opcode");
    ok(pkt.includes(Buffer.from("boot.bin")),   "A17: RRQ filename");
    ok(pkt.includes(Buffer.from("octet")),      "A18: RRQ mode");
  }

  // A19-A20: buildRequestPacket WRQ with options
  {
    const pkt = buildRequestPacket(OP_WRQ, "fw.bin", "octet", { blksize: "1024", tsize: "2048" });
    ok(pkt.readUInt16BE(0) === OP_WRQ,           "A19: WRQ opcode");
    ok(pkt.includes(Buffer.from("blksize")),     "A20: WRQ blksize option encoded");
  }

  // A21-A23: parsePacket DATA
  {
    const payload = Buffer.from("TFTP DATA payload");
    const dp = buildDataPacket(3, payload);
    const p  = parsePacket(dp);
    ok(p.opcode   === OP_DATA,      "A21: parse DATA opcode");
    ok(p.blockNum === 3,            "A22: parse DATA blockNum");
    ok(p.data.equals(payload),      "A23: parse DATA payload");
  }

  // A24-A25: parsePacket ACK
  {
    const ap = parsePacket(buildAckPacket(42));
    ok(ap.opcode   === OP_ACK,  "A24: parse ACK opcode");
    ok(ap.blockNum === 42,      "A25: parse ACK blockNum");
  }

  // A26-A28: parsePacket ERROR
  {
    const ep = parsePacket(buildErrorPacket(2, "Access violation"));
    ok(ep.opcode       === OP_ERROR,          "A26: parse ERROR opcode");
    ok(ep.errorCode    === 2,                 "A27: parse ERROR code");
    ok(ep.errorMessage === "Access violation", "A28: parse ERROR message");
  }

  // A29-A30: parsePacket OACK
  {
    const oack = Buffer.concat([
      Buffer.from([0, OP_OACK]),
      Buffer.from("blksize"), Buffer.from([0]),
      Buffer.from("1024"),    Buffer.from([0]),
    ]);
    const op = parsePacket(oack);
    ok(op.opcode === OP_OACK,           "A29: parse OACK opcode");
    ok(op.options.blksize === "1024",   "A30: parse OACK blksize value");
  }

  // A31: parsePacket too-short buffer
  ok(parsePacket(Buffer.alloc(1)).opcode === -1, "A31: parsePacket 1-byte buffer → opcode -1");

  // A32-A35: clampTimeout
  ok(clampTimeout(500)       === 1000,              "A32: clampTimeout(500) → 1000 (min)");
  ok(clampTimeout(5000)      === 5000,              "A33: clampTimeout(5000) → 5000");
  ok(clampTimeout(999_999)   === 60_000,            "A34: clampTimeout(999999) → 60000 (max)");
  ok(clampTimeout(undefined) === DEFAULT_TIMEOUT_MS,"A35: clampTimeout(undefined) → default");

  // A36-A39: clampBlockSize
  ok(clampBlockSize(null)   === DEFAULT_BLOCK_SIZE, "A36: clampBlockSize(null) → default");
  ok(clampBlockSize(0)      === MIN_BLOCK_SIZE,     "A37: clampBlockSize(0) → min");
  ok(clampBlockSize(999999) === MAX_BLOCK_SIZE,     "A38: clampBlockSize(999999) → max");
  ok(clampBlockSize(1024)   === 1024,               "A39: clampBlockSize(1024) → 1024");

  // A40: guardNul throws on NUL
  {
    let threw = false;
    try { guardNul("bad\0byte", "host"); } catch (e) { threw = e.message.includes("NUL"); }
    ok(threw, "A40: guardNul throws on NUL byte");
  }

  // =====================================================================
  // B — Validation
  // =====================================================================
  sec("B — Validation");

  await rejects(() => tftpClient({ operation: "get", filename: "f.txt" }),
    "'host' is required", "B1: get without host");

  await rejects(() => tftpClient({ operation: "get", host: "127.0.0.1" }),
    "'filename' is required", "B2: get without filename");

  await rejects(() => tftpClient({ operation: "put", host: "127.0.0.1", filename: "x" }),
    "'data' (base64) or 'content' (text string) is required", "B3: put without data/content");

  await rejects(() => tftpClient({ operation: "get", host: "127.0.0.1", filename: "f", port: 0 }),
    "port", "B4: get port=0");

  await rejects(() => tftpClient({ operation: "get", host: "127.0.0.1", filename: "f", port: 99999 }),
    "port", "B5: get port=99999");

  await rejects(() => tftpClient({ operation: "get", host: "127.0.0.1", filename: "f", mode: "binary" }),
    "mode", "B6: invalid mode");

  await rejects(() => tftpClient({ operation: "put", host: "127.0.0.1", filename: "f", data: 12345 }),
    "base64", "B7: put data not string");

  await rejects(() => tftpClient({ operation: "put", host: "127.0.0.1", filename: "f", content: 999 }),
    "string", "B8: put content not string");

  await rejects(() => tftpClient({ operation: "xyz" }),
    "unknown operation", "B9: unknown operation");

  await rejects(() => tftpClient({}),
    "'operation' is required", "B10: missing operation");

  // B11-B15: info
  {
    const info = await tftpClient({ operation: "info" });
    ok(info.ok === true,                         "B11: info.ok");
    ok(info.protocol.name.includes("TFTP"),      "B12: info.protocol.name");
    ok(Array.isArray(info.operations),           "B13: info.operations is array");
    ok(info.defaults.port === 69,                "B14: info.defaults.port");
    ok(info.opcodes.RRQ === 1,                   "B15: info.opcodes.RRQ");
  }

  // =====================================================================
  // C — Mock-network
  // =====================================================================
  sec("C — Mock-network");

  // C1-C3: GET small file (< 1 block)
  {
    const fileData = Buffer.from("Hello TFTP world!");
    const { main, port } = await startGetServer(fileData);

    const result = await tftpClient({
      operation: "get",
      host: "127.0.0.1",
      port,
      filename: "hello.txt",
      timeout: 4000,
    });

    ok(result.ok === true,                                 "C1: GET small file ok");
    ok(result.sizeBytes === fileData.length,               "C2: GET sizeBytes matches");
    ok(Buffer.from(result.content, "base64").equals(fileData), "C3: GET content matches");
  }

  // C4-C5: GET with utf8 encoding
  {
    const text = "UTF-8 transfer text";
    const { main, port } = await startGetServer(Buffer.from(text));

    const result = await tftpClient({
      operation: "get",
      host: "127.0.0.1",
      port,
      filename: "msg.txt",
      output_encoding: "utf8",
      timeout: 4000,
    });

    ok(result.encoding === "utf8",      "C4: GET utf8 encoding field");
    ok(result.content  === text,        "C5: GET utf8 content matches");
  }

  // C6: GET server sends ERROR → reject
  {
    const { socket: srv, port } = await bindSocket();
    srv.once("message", (msg, rinfo) => {
      const ep = buildErrorPacket(1, "File not found");
      srv.send(ep, 0, ep.length, rinfo.port, rinfo.address, () => safeClose(srv));
    });

    await rejects(
      () => tftpClient({ operation: "get", host: "127.0.0.1", port, filename: "x", timeout: 3000 }),
      "File not found",
      "C6: server ERROR rejects client"
    );
  }

  // C7-C9: PUT small file
  {
    const content = "PUT test file content";
    const { port, received } = await startPutServer();

    const result = await tftpClient({
      operation: "put",
      host: "127.0.0.1",
      port,
      filename: "upload.txt",
      content,
      timeout: 4000,
    });

    const rx = await received;
    ok(result.ok === true,                                    "C7: PUT ok");
    ok(result.sizeBytes === Buffer.byteLength(content, "utf8"), "C8: PUT sizeBytes");
    ok(rx && rx.toString("utf8") === content,                 "C9: PUT server received correct data");
  }

  // C10: GET timeout → rejects
  {
    const { socket: srv, port } = await bindSocket();
    // Server silently ignores all messages
    srv.on("message", () => {});

    try {
      await tftpClient({
        operation: "get",
        host: "127.0.0.1",
        port,
        filename: "silent.txt",
        timeout: 1200,
      });
      ok(false, "C10: GET timeout should reject");
    } catch (e) {
      ok(e.message.toLowerCase().includes("timed out") || e.message.toLowerCase().includes("timeout"),
        "C10: GET timeout rejects correctly");
    } finally {
      safeClose(srv);
    }
  }

  // C11: info — no network required
  {
    const info = await tftpClient({ operation: "info" });
    ok(info.protocol.transport === "UDP", "C11: info.protocol.transport === 'UDP'");
  }

  // C12-C12b: GET empty file (0-byte first block = EOF)
  {
    const { main, port } = await startGetServer(Buffer.alloc(0));

    const result = await tftpClient({
      operation: "get",
      host: "127.0.0.1",
      port,
      filename: "empty.txt",
      timeout: 4000,
    });

    ok(result.ok === true,      "C12: GET empty file ok");
    ok(result.sizeBytes === 0,  "C12b: GET empty file sizeBytes=0");
  }

  // =====================================================================
  // D — Security
  // =====================================================================
  sec("D — Security");

  // D1-D3: NUL byte guards
  await rejects(
    () => tftpClient({ operation: "get", host: "192.168.1.1\x00evil", filename: "f" }),
    "NUL", "D1: NUL in host rejected"
  );
  await rejects(
    () => tftpClient({ operation: "get", host: "127.0.0.1", filename: "f\x00ile" }),
    "NUL", "D2: NUL in filename (get) rejected"
  );
  await rejects(
    () => tftpClient({ operation: "put", host: "127.0.0.1", filename: "f\x00ile", content: "hi" }),
    "NUL", "D3: NUL in filename (put) rejected"
  );

  // D4: Oversized PUT data rejected before network
  {
    // Build a buffer just over the limit, encode as base64
    const bigBuf = Buffer.alloc(MAX_TRANSFER_BYTES + 1);
    const b64 = bigBuf.toString("base64");
    await rejects(
      () => tftpClient({ operation: "put", host: "127.0.0.1", filename: "big.bin", data: b64 }),
      "too large",
      "D4: data exceeding MAX_TRANSFER_BYTES rejected"
    );
  }

  // D5: Unknown TID → client sends ERROR 5
  // Protocol: real server establishes TID first (sends DATA 1 from worker port),
  // then attacker injects DATA 2 from a different port mid-transfer.
  // The transfer uses 2 blocks (>512 bytes) so there is a window between block 1 ACK
  // and block 2 arriving.
  {
    // Build 600-byte file = 2 blocks (512 + 88)
    const fileData = Buffer.alloc(600, 0x42);
    const BLKSZ = DEFAULT_BLOCK_SIZE;
    const { socket: srv, port } = await bindSocket();
    let receivedErrorCode5 = false;

    const tidDone = new Promise((resolveTid) => {
      srv.once("message", (msg, rinfo) => {
        const pkt = parsePacket(msg);
        if (pkt.opcode !== OP_RRQ) { safeClose(srv); resolveTid(); return; }

        const clientPort = rinfo.port;
        const clientAddr = rinfo.address;

        // Real worker socket - establishes the TID
        const worker = dgram.createSocket("udp4");
        worker.bind(0, () => {
          // Send block 1 first to establish TID with the client
          const block1 = buildDataPacket(1, fileData.slice(0, BLKSZ));
          worker.send(block1, 0, block1.length, clientPort, clientAddr);
        });

        worker.on("message", (ackBuf) => {
          const ap = parsePacket(ackBuf);
          if (ap.opcode !== OP_ACK) return;

          if (ap.blockNum === 1) {
            // Client ACKed block 1 — TID is established.
            // Now an attacker injects a fake DATA 2 from a DIFFERENT socket.
            const attacker = dgram.createSocket("udp4");
            attacker.on("message", (errBuf) => {
              const ep = parsePacket(errBuf);
              if (ep.opcode === OP_ERROR && ep.errorCode === 5) {
                receivedErrorCode5 = true;
              }
              safeClose(attacker);
              // Now real worker sends the real block 2 to finish the transfer
              const block2 = buildDataPacket(2, fileData.slice(BLKSZ));
              worker.send(block2, 0, block2.length, clientPort, clientAddr);
            });
            attacker.on("error", () => safeClose(attacker));
            attacker.bind(0, () => {
              const fakeData2 = buildDataPacket(2, Buffer.from("EVIL_INJECTION"));
              attacker.send(fakeData2, 0, fakeData2.length, clientPort, clientAddr);
            });
          } else if (ap.blockNum === 2) {
            // Transfer complete
            safeClose(worker);
            safeClose(srv);
            resolveTid();
          }
        });

        worker.on("error", () => { safeClose(worker); resolveTid(); });
        safeClose(srv);
      });
    });

    await Promise.all([
      tftpClient({ operation: "get", host: "127.0.0.1", port, filename: "tid.txt", timeout: 5000 }).catch(() => {}),
      tidDone,
    ]);
    ok(receivedErrorCode5, "D5: Unknown TID → client responds with ERROR 5");
  }

  // D6: Server sends Access Violation → propagated
  {
    const { socket: srv, port } = await bindSocket();
    srv.once("message", (msg, rinfo) => {
      const ep = buildErrorPacket(2, "Access violation");
      srv.send(ep, 0, ep.length, rinfo.port, rinfo.address, () => safeClose(srv));
    });

    await rejects(
      () => tftpClient({ operation: "get", host: "127.0.0.1", port, filename: "../etc/passwd", timeout: 3000 }),
      "Access violation",
      "D6: server Access Violation propagated to client"
    );
  }

  // D7: port boundary — port=1 passes validation
  {
    let validationFailed = false;
    try {
      await tftpClient({ operation: "get", host: "127.0.0.1", filename: "x", port: 1, timeout: 1100 });
    } catch (e) {
      if (e.message.includes("port")) validationFailed = true;
    }
    ok(!validationFailed, "D7: port=1 passes validation");
  }

  // D8: port=65535 passes validation
  {
    let validationFailed = false;
    try {
      await tftpClient({ operation: "get", host: "127.0.0.1", filename: "x", port: 65535, timeout: 1100 });
    } catch (e) {
      if (e.message.includes("port")) validationFailed = true;
    }
    ok(!validationFailed, "D8: port=65535 passes validation");
  }

  // D9: empty host rejected
  await rejects(
    () => tftpClient({ operation: "get", host: "", filename: "f" }),
    "'host' is required", "D9: empty host rejected"
  );

  // D10: empty filename rejected
  await rejects(
    () => tftpClient({ operation: "get", host: "127.0.0.1", filename: "" }),
    "'filename' is required", "D10: empty filename rejected"
  );

  // =====================================================================
  // E — Concurrency & edge-cases
  // =====================================================================
  sec("E — Concurrency & edge-cases");

  // E1: 5 concurrent info() calls
  {
    const results = await Promise.all(Array.from({ length: 5 }, () => tftpClient({ operation: "info" })));
    ok(results.every(r => r.ok), "E1: 5 concurrent info() all succeed");
  }

  // E2-E3: 3 concurrent GETs from independent mock servers
  {
    async function singleGet(data) {
      const { main, port } = await startGetServer(data);
      return tftpClient({ operation: "get", host: "127.0.0.1", port, filename: "c.txt", timeout: 5000 });
    }

    const [r1, r2, r3] = await Promise.all([
      singleGet(Buffer.from("alpha")),
      singleGet(Buffer.from("beta")),
      singleGet(Buffer.from("gamma")),
    ]);

    ok(r1.ok && r2.ok && r3.ok, "E2: 3 concurrent GETs all ok");
    ok(
      Buffer.from(r1.content, "base64").toString() === "alpha"  &&
      Buffer.from(r2.content, "base64").toString() === "beta"   &&
      Buffer.from(r3.content, "base64").toString() === "gamma",
      "E3: 3 concurrent GETs each receive correct data"
    );
  }

  // E4-E5: 16-bit block number wraparound
  {
    const p65535 = parsePacket(buildDataPacket(65535, Buffer.from("x")));
    ok(p65535.blockNum === 65535, "E4: blockNum 65535 encodes/parses correctly");

    // 65536 & 0xFFFF === 0
    const pWrap = parsePacket(buildDataPacket(65536, Buffer.from("y")));
    ok(pWrap.blockNum === 0, "E5: blockNum 65536 wraps to 0 (16-bit)");
  }

  // E6: ACK block wraps at 65535
  {
    const ap = parsePacket(buildAckPacket(65535));
    ok(ap.blockNum === 65535, "E6: ACK 65535 encodes correctly");
  }

  // E7: clampBlockSize boundary table
  {
    const table = [
      [8,      8],
      [512,    512],
      [1024,   1024],
      [65464,  65464],
      [0,      MIN_BLOCK_SIZE],
      [999999, MAX_BLOCK_SIZE],
      [null,   DEFAULT_BLOCK_SIZE],
    ];
    const allOk = table.every(([inp, exp]) => clampBlockSize(inp) === exp);
    ok(allOk, "E7: clampBlockSize boundary table correct");
  }

  // E8: buildRequestPacket with multiple options
  {
    const opts = { blksize: "1024", tsize: "65536", timeout: "5" };
    const pkt  = buildRequestPacket(OP_RRQ, "large.bin", "octet", opts);
    const s    = pkt.toString("ascii");
    ok(
      s.includes("blksize") && s.includes("tsize") && s.includes("timeout"),
      "E8: buildRequestPacket encodes 3 options correctly"
    );
  }

  // =====================================================================
  // Summary
  // =====================================================================
  console.error(`\n${'='.repeat(60)}`);
  console.error(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
  if (errors.length) {
    console.error("Failed:");
    errors.forEach(e => console.error(`  - ${e}`));
  }
  console.error('='.repeat(60));

  if (failed > 0) process.exit(1);
}

runAll().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
