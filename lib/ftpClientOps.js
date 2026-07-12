"use strict";
// ── ftp_client: zero-dep FTP/FTPS client ─────────────────────────────────────────────
// Pure Node.js net/tls — no npm dependencies.
// Implements RFC 959 (FTP) with RFC 4217 (Explicit FTPS via AUTH TLS).
//
// Compatible with: vsftpd, ProFTPD, FileZilla Server, IIS FTP, Pure-FTPd,
//                  WinSCP FTP, FileZilla, AWS Transfer Family, Azure Blob FTP
//
// Operations: list, get, put, delete, rename, mkdir, rmdir, pwd, stat, quit
//
// All data transfers use passive mode (PASV / EPSV) to avoid NAT/firewall issues.
// Protocol reference: https://www.rfc-editor.org/rfc/rfc959

const net  = require("net");
const tls  = require("tls");
const { ToolError } = require("./errors");

// ── Constants ────────────────────────────────────────────────────────────
const DEFAULT_PORT        = 21;
const DEFAULT_TIMEOUT_MS  = 30_000;
const DEFAULT_CONN_TO_MS  = 10_000;
const MAX_DOWNLOAD_BYTES  = 50 * 1024 * 1024;  // 50 MB
const MAX_UPLOAD_BYTES    = 100 * 1024 * 1024; // 100 MB
const MAX_LIST_BYTES      = 4 * 1024 * 1024;   // 4 MB listing
const MAX_PATH_LEN        = 4096;

// ── FTP Response Parser ───────────────────────────────────────────────────────────────────
// FTP uses line-based text protocol. Responses are either:
//   "NNN text"       (single-line)
//   "NNN-text\r\n ... NNN text" (multi-line)
// We accumulate data and extract complete responses.

class FtpResponseParser {
  constructor() {
    this._buf = "";
    this._events = [];
  }

  feed(chunk) {
    this._buf += (Buffer.isBuffer(chunk) ? chunk.toString("binary") : chunk);
    this._parse();
  }

  _parse() {
    // Extract complete FTP responses from _buf.
    // Uses indexOf('\n') to track exact byte offsets so CRLF vs LF never
    // corrupts the consumed counter (the old split(/\r?\n/) approach added
    // only +1 per line separator, missing the extra byte for \r in CRLF).
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let pos = 0;
      let code = null;
      let collected = [];
      let foundComplete = false;

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const nlIdx = this._buf.indexOf('\n', pos);
        if (nlIdx === -1) break; // Incomplete line -- wait for more data

        // Strip trailing \r if present (CRLF)
        const lineRaw = this._buf.slice(pos, nlIdx);
        const line = lineRaw.endsWith('\r') ? lineRaw.slice(0, -1) : lineRaw;
        const nextPos = nlIdx + 1;

        if (!code) {
          const m = line.match(/^(\d{3})([- ])(.*)$/);
          if (!m) {
            // Blank/spurious line -- skip
            pos = nextPos;
            continue;
          }
          code = m[1];
          const isContinuation = m[2] === '-';
          collected.push(line);
          if (!isContinuation) {
            this._buf = this._buf.slice(nextPos);
            this._events.push({ code, lines: collected, text: m[3] });
            foundComplete = true;
            break;
          }
          pos = nextPos;
        } else {
          collected.push(line);
          const m = line.match(/^(\d{3}) /);
          if (m && m[1] === code) {
            this._buf = this._buf.slice(nextPos);
            const text = collected[0].slice(4); // skip "NNN-"
            this._events.push({ code, lines: collected, text });
            foundComplete = true;
            break;
          }
          pos = nextPos;
        }
      }

      if (!foundComplete) break;
    }
  }
  shift() {
    return this._events.length > 0 ? this._events.shift() : null;
  }

  get available() { return this._events.length; }
}

// ── Security Guards ────────────────────────────────────────────────────────────────────────

function guardPath(val, label) {
  if (!val || typeof val !== "string")
    throw new ToolError(`ftp_client: '${label}' must be a non-empty string.`, -32602);
  if (val.length > MAX_PATH_LEN)
    throw new ToolError(`ftp_client: '${label}' exceeds ${MAX_PATH_LEN}-char limit.`, -32602);
  // Guard against null bytes, CRLF injection in commands
  if (/[\x00\r\n]/.test(val))
    throw new ToolError(`ftp_client: '${label}' must not contain NUL or CRLF bytes.`, -32602);
  return val;
}

function guardStr(val, label, maxLen = 512) {
  if (typeof val !== "string")
    throw new ToolError(`ftp_client: '${label}' must be a string.`, -32602);
  if (val.length > maxLen)
    throw new ToolError(`ftp_client: '${label}' exceeds ${maxLen}-char limit.`, -32602);
  if (/[\x00\r\n]/.test(val))
    throw new ToolError(`ftp_client: '${label}' must not contain NUL or CRLF bytes.`, -32602);
  return val;
}

// ── PASV Response Parser ──────────────────────────────────────────────────────────────────
// Parses "227 Entering Passive Mode (h1,h2,h3,h4,p1,p2)."

function parsePasvResponse(text) {
  const m = text.match(/(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/);
  if (!m) throw new ToolError(`ftp_client: cannot parse PASV response: ${text}`, -32603);
  const host = `${m[1]}.${m[2]}.${m[3]}.${m[4]}`;
  const port = (parseInt(m[5], 10) * 256) + parseInt(m[6], 10);
  return { host, port };
}

// Parses "229 Entering Extended Passive Mode (|||port|)."
function parseEpsvResponse(text) {
  const m = text.match(/\|\|\|(\d+)\|/);
  if (!m) throw new ToolError(`ftp_client: cannot parse EPSV response: ${text}`, -32603);
  return { port: parseInt(m[1], 10) };
}

// ── FTP Directory Listing Parser ──────────────────────────────────────────────────────────────────
// Parses Unix-style LIST output (e.g. "drwxr-xr-x 2 user group 4096 Jan  1 12:00 dir")
// and Windows/DOS-style output (e.g. "01-01-21  12:00AM <DIR> dir" or "01-01-21  12:00AM 1234 file")

function parseListEntry(line) {
  // Unix-style: -rwxr-xr-x links user group size mon day time/year name
  const unixM = line.match(
    /^([dlcbsp-][rwxstT-]{9})\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\w+\s+\d+\s+[\d:]+)\s+(.+)$/
  );
  if (unixM) {
    return {
      type:        unixM[1][0] === "d" ? "directory" : unixM[1][0] === "l" ? "symlink" : "file",
      permissions: unixM[1],
      links:       parseInt(unixM[2], 10),
      owner:       unixM[3],
      group:       unixM[4],
      size:        parseInt(unixM[5], 10),
      modified:    unixM[6].trim(),
      name:        unixM[7].trim(),
    };
  }

  // DOS/Windows-style: MM-DD-YY  HH:MMam/pm  <DIR>  or  size  name
  const dosM = line.match(
    /^(\d{2}-\d{2}-\d{2,4})\s+(\d{2}:\d{2}(?:AM|PM)?)\s+(<DIR>|\d+)\s+(.+)$/i
  );
  if (dosM) {
    const isDir = dosM[3].toUpperCase() === "<DIR>";
    return {
      type:     isDir ? "directory" : "file",
      modified: `${dosM[1]} ${dosM[2]}`,
      size:     isDir ? null : parseInt(dosM[3], 10),
      name:     dosM[4].trim(),
    };
  }

  // MLSD-style: Type=file;Size=1234;Modify=20210101120000; name
  const mlsdM = line.match(/^((?:[^;=]+=[^;]*;)+)\s*(.+)$/);
  if (mlsdM) {
    const facts = {};
    for (const fact of mlsdM[1].split(";")) {
      const [k, v] = fact.split("=");
      if (k && v !== undefined) facts[k.toLowerCase()] = v;
    }
    return {
      type:     (facts.type || "file").toLowerCase() === "dir" ? "directory" : "file",
      name:     mlsdM[2].trim(),
      size:     facts.size ? parseInt(facts.size, 10) : null,
      modified: facts.modify || null,
    };
  }

  // Unknown format — return raw
  return { type: "unknown", name: line.trim(), raw: line };
}

function parseListOutput(raw) {
  return raw
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith("total "))
    .map(parseListEntry);
}

// ── Connection Layer ──────────────────────────────────────────────────────────────────────────

async function openFtpConnection(opts, socketRef) {
  const {
    host,
    port         = DEFAULT_PORT,
    ftps         = false,
    reject_unauthorized = true,
    connect_timeout,
    timeout      = DEFAULT_TIMEOUT_MS,
  } = opts;

  const connToMs = typeof connect_timeout === "number"
    ? connect_timeout * 1000
    : Math.min(timeout, DEFAULT_CONN_TO_MS);

  return new Promise((resolve, reject) => {
    const parser  = new FtpResponseParser();
    const waiters = []; // { resolve, reject }
    let   settled = false;

    const done = (err, val) => {
      if (settled) return;
      settled = true;
      if (err) reject(err); else resolve(val);
    };

    // pendingMsgs: responses that arrived before a waiter was registered
    // (e.g. 220 banner arriving in the same setImmediate tick as connect)
    const pendingMsgs = [];

    const onData = (chunk) => {
      parser.feed(chunk);
      let msg;
      while ((msg = parser.shift()) !== null) {
        if (waiters.length > 0) {
          waiters.shift().resolve(msg);
        } else {
          // No waiter registered yet — buffer for waitResponse()
          pendingMsgs.push(msg);
        }
      }
    };

    // If a message is already buffered resolve immediately;
    // otherwise register a waiter that onData will resolve.
    const waitResponse = () => {
      if (pendingMsgs.length > 0) {
        return Promise.resolve(pendingMsgs.shift());
      }
      return new Promise((res, rej) => waiters.push({ resolve: res, reject: rej }));
    };

    const drainWaiters = () => {
      while (waiters.length) {
        waiters.shift().resolve({ code: "000", text: "connection closed", lines: [] });
      }
    };

    const sendCmd = (cmd) => {
      if (!socket.destroyed) socket.write(cmd + "\r\n", "binary");
    };

    // ── Socket ────────────────────────────────────────────────────────────────────────────────
    const socket = net.createConnection({ host, port });
    if (socketRef) socketRef.socket = socket;

    let connTimer = setTimeout(() => {
      socket.destroy(
        new ToolError(`ftp_client: TCP connect timed out after ${connToMs} ms.`, -32603));
    }, connToMs);
    connTimer.unref();

    socket.on("data",  onData);
    socket.on("error", (e) => {
      done(new ToolError(`ftp_client: socket error: ${e.message}`, -32603));
    });
    socket.on("close", () => { drainWaiters(); });

    socket.on("connect", async () => {
      clearTimeout(connTimer);
      connTimer = null;

      try {
        // Wait for 220 banner
        const banner = await waitResponse();
        if (banner.code !== "220") {
          throw new ToolError(`ftp_client: expected 220 greeting, got ${banner.code}: ${banner.text}`, -32603);
        }

        let activeSocket = socket;
        let activeSend = sendCmd;
        let activeWait = waitResponse;
        let activeDrain = drainWaiters;

        if (ftps) {
          // Explicit FTPS: send AUTH TLS
          activeSend("AUTH TLS");
          const authResp = await activeWait();
          if (authResp.code !== "234") {
            throw new ToolError(
              `ftp_client: AUTH TLS rejected (${authResp.code}): ${authResp.text}`, -32603);
          }

          // Upgrade socket to TLS
          const tlsSocket = await new Promise((res2, rej2) => {
            const ts = tls.connect({
              socket,
              host,
              rejectUnauthorized: reject_unauthorized,
              servername: host,
            }, () => res2(ts));
            ts.on("error", rej2);
          });

          // Rewire data events to TLS socket
          socket.removeListener("data", onData);
          tlsSocket.on("data", onData);
          tlsSocket.on("error", (e) => {
            done(new ToolError(`ftp_client: TLS error: ${e.message}`, -32603));
          });
          tlsSocket.on("close", drainWaiters);

          activeSocket = tlsSocket;
          activeSend = (cmd) => { if (!tlsSocket.destroyed) tlsSocket.write(cmd + "\r\n", "binary"); };
          activeWait  = waitResponse;  // same waiter queue
          activeDrain = drainWaiters;

          if (socketRef) socketRef.socket = tlsSocket;
        }

        done(null, {
          socket: activeSocket,
          send:   activeSend,
          wait:   activeWait,
          drain:  activeDrain,
          banner: banner.text,
        });
      } catch (e) {
        done(new ToolError(e.message.startsWith("ftp_client:") ? e.message : `ftp_client: handshake error: ${e.message}`, -32603));
        if (!socket.destroyed) socket.destroy();
      }
    });
  });
}

function closeFtpConnection(conn) {
  try {
    if (conn && conn.socket && !conn.socket.destroyed) conn.socket.destroy();
  } catch (_) { /* ignore */ }
}

// ── Passive Data Connection ───────────────────────────────────────────────────────────────────

async function openDataConnection(conn, host, dataTimeout) {
  const { send, wait } = conn;

  // Try EPSV first (more reliable through NAT)
  send("EPSV");
  const epsvResp = await wait();

  if (epsvResp.code === "229") {
    const { port } = parseEpsvResponse(epsvResp.text);
    return connectDataSocket(host, port, dataTimeout);
  }

  // Fall back to PASV
  send("PASV");
  const pasvResp = await wait();
  if (pasvResp.code !== "227") {
    throw new ToolError(`ftp_client: PASV failed (${pasvResp.code}): ${pasvResp.text}`, -32603);
  }
  const { host: dataHost, port: dataPort } = parsePasvResponse(pasvResp.text);
  return connectDataSocket(dataHost, dataPort, dataTimeout);
}

function connectDataSocket(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    const t = setTimeout(() => {
      sock.destroy();
      reject(new ToolError(`ftp_client: data connection timed out connecting to ${host}:${port}`, -32603));
    }, timeoutMs || 15000);
    t.unref();
    sock.on("connect", () => { clearTimeout(t); resolve(sock); });
    sock.on("error",   (e) => { clearTimeout(t); reject(new ToolError(`ftp_client: data socket error: ${e.message}`, -32603)); });
  });
}

// Collect all data from a data socket into a Buffer
function collectDataSocket(dataSock, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let ended = false;

    dataSock.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        dataSock.destroy();
        if (!ended) {
          ended = true;
          reject(new ToolError(
            `ftp_client: data transfer exceeds ${maxBytes / 1024 / 1024} MB limit.`, -32603));
        }
        return;
      }
      chunks.push(chunk);
    });

    dataSock.on("end",   () => { if (!ended) { ended = true; resolve(Buffer.concat(chunks)); } });
    dataSock.on("close", () => { if (!ended) { ended = true; resolve(Buffer.concat(chunks)); } });
    dataSock.on("error", (e) => { if (!ended) { ended = true; reject(new ToolError(`ftp_client: data socket read error: ${e.message}`, -32603)); } });
  });
}

// ── Assert FTP success response ───────────────────────────────────────────────────────────────────

function assertOk(resp, operation, expectedCodes) {
  const codes = Array.isArray(expectedCodes) ? expectedCodes : [expectedCodes];
  if (resp.code === "000")
    throw new ToolError(`ftp_client: connection closed during ${operation}.`, -32603);
  if (!codes.includes(resp.code)) {
    throw new ToolError(
      `ftp_client: ${operation} failed (${resp.code}): ${resp.text}`, -32603);
  }
  return resp;
}

// ── Main exported function ────────────────────────────────────────────────────────────────────

async function ftpClient(opts) {
  opts = opts || {};

  const {
    host,
    port,
    ftps                = false,
    reject_unauthorized = true,
    username            = "anonymous",
    password            = "anonymous@",
    timeout             = 30,
    connect_timeout,
    operation,
    // operation-specific
    path:   remotePath,
    new_name,
    data,                  // base64/utf8 string for put
    encoding            = "base64",
    binary              = true,
  } = opts;

  // ── Validation ───────────────────────────────────────────────────────────────────────
  if (!host || typeof host !== "string")
    throw new ToolError("ftp_client: 'host' is required (string).", -32602);

  const VALID_OPS = ["list", "get", "put", "delete", "rename", "mkdir", "rmdir", "pwd", "stat", "quit"];
  if (!operation || !VALID_OPS.includes(operation))
    throw new ToolError(
      `ftp_client: 'operation' must be one of: ${VALID_OPS.join(", ")}.`, -32602);

  if (username != null) guardStr(username, "username");
  if (password != null) guardStr(password, "password");

  const needsPath = ["list", "get", "put", "delete", "rename", "mkdir", "rmdir", "stat"];
  if (needsPath.includes(operation) && operation !== "list") {
    if (!remotePath) throw new ToolError(`ftp_client: 'path' is required for '${operation}'.`, -32602);
    guardPath(remotePath, "path");
  } else if (operation === "list" && remotePath != null) {
    guardPath(remotePath, "path");
  }

  if (operation === "rename") {
    if (!new_name) throw new ToolError("ftp_client: 'new_name' is required for 'rename'.", -32602);
    guardPath(new_name, "new_name");
  }

  // Decode and size-check upload data BEFORE opening any connection
  let uploadBuf = null;
  if (operation === "put") {
    if (data === undefined || data === null)
      throw new ToolError("ftp_client: 'data' (base64 string) is required for 'put'.", -32602);
    if (typeof data !== "string")
      throw new ToolError("ftp_client: 'data' must be a string.", -32602);
    // Fast pre-decode size estimate to avoid allocating huge buffers unnecessarily
    if (encoding !== "utf8" && encoding !== "text") {
      const estBytes = Math.ceil(data.length * 3 / 4);
      if (estBytes > MAX_UPLOAD_BYTES)
        throw new ToolError(
          `ftp_client: upload data exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024} MB limit.`, -32602);
    } else if (Buffer.byteLength(data, 'utf8') > MAX_UPLOAD_BYTES) {
      throw new ToolError(
        `ftp_client: upload data exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024} MB limit.`, -32602);
    }
    try {
      uploadBuf = Buffer.from(data, encoding === "utf8" || encoding === "text" ? "utf8" : "base64");
    } catch (e) {
      throw new ToolError(`ftp_client: failed to decode 'data' as ${encoding}: ${e.message}`, -32602);
    }
    if (uploadBuf.length > MAX_UPLOAD_BYTES)
      throw new ToolError(
        `ftp_client: upload data exceeds ${MAX_UPLOAD_BYTES / 1024 / 1024} MB limit.`, -32602);
  }

  const timeoutMs    = (typeof timeout === "number" && timeout > 0) ? timeout * 1000 : DEFAULT_TIMEOUT_MS;
  const resolvedPort = typeof port === "number" ? port : DEFAULT_PORT;

  const startTime = Date.now();
  let globalTimer;
  let conn;
  const socketRef = { socket: null };

  const timeoutPromise = new Promise((_, rej) => {
    globalTimer = setTimeout(() =>
      rej(new ToolError(`ftp_client: operation timed out after ${timeoutMs} ms.`, -32603)),
      timeoutMs);
    globalTimer.unref();
  });

  async function run() {
    conn = await openFtpConnection({
      host, port: resolvedPort, ftps, reject_unauthorized,
      timeout: timeoutMs, connect_timeout,
    }, socketRef);

    const { send, wait, banner } = conn;
    let result;

    // ── Authenticate ────────────────────────────────────────────────────────────────────
    send(`USER ${username}`);
    const userResp = await wait();

    if (userResp.code === "230") {
      // Logged in without password (e.g. anonymous with no password needed)
    } else if (userResp.code === "331") {
      // Password required
      send(`PASS ${password}`);
      const passResp = await wait();
      if (passResp.code !== "230" && passResp.code !== "202") {
        const desc = passResp.text || "";
        throw new ToolError(
          `ftp_client: login failed (${passResp.code}): ${desc}`, -32603);
      }
    } else {
      throw new ToolError(
        `ftp_client: USER command failed (${userResp.code}): ${userResp.text}`, -32603);
    }

    // Set binary or ASCII transfer mode
    send(binary ? "TYPE I" : "TYPE A");
    await wait(); // 200 Type set (be permissive about exact code)

    if (ftps) {
      // Protect the data channel too
      send("PBSZ 0");
      await wait(); // 200
      send("PROT P");
      await wait(); // 200
    }

    // ── Execute operation ────────────────────────────────────────────────────────────────────
    switch (operation) {

      case "pwd": {
        send("PWD");
        const r = await wait();
        assertOk(r, "pwd", "257");
        // 257 "/path" is the current directory
        const m = r.text.match(/"([^"]+)"/);
        result = { cwd: m ? m[1] : r.text };
        break;
      }

      case "list": {
        // Optional CWD first
        if (remotePath) {
          send(`CWD ${remotePath}`);
          const cwdR = await wait();
          if (cwdR.code !== "250") {
            throw new ToolError(`ftp_client: CWD '${remotePath}' failed (${cwdR.code}): ${cwdR.text}`, -32603);
          }
        }

        const dataSock = await openDataConnection(conn, host, Math.min(timeoutMs, 15000));
        const dataCollect = collectDataSocket(dataSock, MAX_LIST_BYTES);

        send("LIST -la");
        const listInit = await wait();
        if (listInit.code !== "150" && listInit.code !== "125") {
          dataSock.destroy();
          throw new ToolError(`ftp_client: LIST failed (${listInit.code}): ${listInit.text}`, -32603);
        }

        const listData = await dataCollect;
        const listDone = await wait(); // 226 Transfer complete

        const raw     = listData.toString("latin1");
        const entries = parseListOutput(raw);
        result = {
          path:       remotePath || ".",
          entryCount: entries.length,
          entries,
          resultCode: listDone.code,
        };
        break;
      }

      case "get": {
        const dataSock = await openDataConnection(conn, host, Math.min(timeoutMs, 15000));
        const dataCollect = collectDataSocket(dataSock, MAX_DOWNLOAD_BYTES);

        send(`RETR ${remotePath}`);
        const retrInit = await wait();
        if (retrInit.code !== "150" && retrInit.code !== "125") {
          dataSock.destroy();
          throw new ToolError(`ftp_client: RETR '${remotePath}' failed (${retrInit.code}): ${retrInit.text}`, -32603);
        }

        const fileData = await dataCollect;
        const retrDone = await wait(); // 226

        const outputEncoding = (encoding === "utf8" || encoding === "text") ? "utf8" : "base64";
        result = {
          path:       remotePath,
          size:       fileData.length,
          data:       fileData.toString(outputEncoding),
          encoding:   outputEncoding,
          resultCode: retrDone.code,
        };
        break;
      }

      case "put": {
        // uploadBuf already decoded and size-checked in validation above
        const dataSock = await openDataConnection(conn, host, Math.min(timeoutMs, 15000));

        send(`STOR ${remotePath}`);
        const storInit = await wait();
        if (storInit.code !== "150" && storInit.code !== "125") {
          dataSock.destroy();
          throw new ToolError(`ftp_client: STOR '${remotePath}' failed (${storInit.code}): ${storInit.text}`, -32603);
        }

        // Write upload data to data socket
        await new Promise((res, rej) => {
          dataSock.write(uploadBuf, (err) => {
            if (err) rej(new ToolError(`ftp_client: data write error: ${err.message}`, -32603));
            else res();
          });
        });
        dataSock.end();

        const storDone = await wait(); // 226
        if (storDone.code !== "226" && storDone.code !== "250") {
          throw new ToolError(`ftp_client: STOR '${remotePath}' transfer failed (${storDone.code}): ${storDone.text}`, -32603);
        }

        result = {
          path:       remotePath,
          size:       uploadBuf.length,
          uploaded:   true,
          resultCode: storDone.code,
        };
        break;
      }

      case "delete": {
        send(`DELE ${remotePath}`);
        const r = await wait();
        assertOk(r, "delete", ["250", "200"]);
        result = { path: remotePath, deleted: true, resultCode: r.code };
        break;
      }

      case "rename": {
        send(`RNFR ${remotePath}`);
        const rnfrR = await wait();
        assertOk(rnfrR, "rename (RNFR)", "350");
        send(`RNTO ${new_name}`);
        const rntoR = await wait();
        assertOk(rntoR, "rename (RNTO)", ["250", "200"]);
        result = { path: remotePath, new_name, renamed: true, resultCode: rntoR.code };
        break;
      }

      case "mkdir": {
        send(`MKD ${remotePath}`);
        const r = await wait();
        assertOk(r, "mkdir", "257");
        result = { path: remotePath, created: true, resultCode: r.code };
        break;
      }

      case "rmdir": {
        send(`RMD ${remotePath}`);
        const r = await wait();
        assertOk(r, "rmdir", ["250", "200"]);
        result = { path: remotePath, removed: true, resultCode: r.code };
        break;
      }

      case "stat": {
        // Try SIZE for file size (RFC 3659)
        let size = null;
        let modified = null;

        send(`SIZE ${remotePath}`);
        const sizeR = await wait();
        if (sizeR.code === "213") {
          size = parseInt(sizeR.text, 10);
        }

        // Try MDTM for modification time (RFC 3659)
        send(`MDTM ${remotePath}`);
        const mdtmR = await wait();
        if (mdtmR.code === "213") {
          // YYYYMMDDHHmmss
          const t = mdtmR.text.trim();
          modified = t.length >= 14
            ? `${t.slice(0,4)}-${t.slice(4,6)}-${t.slice(6,8)}T${t.slice(8,10)}:${t.slice(10,12)}:${t.slice(12,14)}Z`
            : t;
        }

        result = { path: remotePath, size, modified, exists: size !== null || modified !== null };
        break;
      }

      case "quit": {
        send("QUIT");
        const r = await wait();
        result = { quit: true, resultCode: r.code };
        break;
      }

      default:
        throw new ToolError(`ftp_client: unhandled operation '${operation}'.`, -32603);
    }

    // ── Graceful QUIT ──────────────────────────────────────────────────────────────────────────────
    if (operation !== "quit") {
      try { send("QUIT"); } catch (_) { /* ignore */ }
    }

    return {
      host, port: resolvedPort, operation,
      elapsedMs: Date.now() - startTime,
      banner,
      ...result,
    };
  }

  try {
    const runPromise = run();
    runPromise.catch(() => {});
    return await Promise.race([runPromise, timeoutPromise]);
  } finally {
    clearTimeout(globalTimer);
    closeFtpConnection(conn);
  }
}

module.exports = {
  ftpClient,
  FtpResponseParser,
  parsePasvResponse,
  parseEpsvResponse,
  parseListOutput,
  parseListEntry,
};
