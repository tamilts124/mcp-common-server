"use strict";
// ── NNTP client (RFC 977, RFC 3977, RFC 4644) ──────────────────────────────────
// Zero-dependency NNTP (Network News Transfer Protocol) client.
// Pure Node.js net/tls built-ins; no npm deps.
// Supports RFC 3977 (NNTP base), RFC 977 (original NNTP), RFC 4644 (streaming).
// Operations: capabilities, list_groups, group, list_articles, article,
//             head, body, post, date, quit, info

const net = require("net");
const tls = require("tls");
const crypto = require("crypto");

// ── Constants ─────────────────────────────────────────────────────────────────
const DEFAULT_PORT_PLAIN  = 119;
const DEFAULT_PORT_TLS    = 563;
const DEFAULT_TIMEOUT     = 15000;
const MAX_TIMEOUT         = 120000;
const MIN_TIMEOUT         = 1000;
const MAX_RESPONSE_BYTES  = 8 * 1024 * 1024; // 8 MB
const MAX_ARTICLE_BYTES   = 4 * 1024 * 1024; // 4 MB
const MAX_LIST_LINES      = 50000;

// ── NUL guard ─────────────────────────────────────────────────────────────────
function guardNul(value, name) {
  if (typeof value === "string" && value.includes("\x00"))
    throw new Error(`nntp_client: '${name}' must not contain NUL bytes.`);
}

// ── Timeout clamping ──────────────────────────────────────────────────────────
function clampTimeout(ms) {
  if (ms == null) return DEFAULT_TIMEOUT;
  const n = Math.trunc(Number(ms));
  if (!Number.isFinite(n)) return DEFAULT_TIMEOUT;
  return Math.max(MIN_TIMEOUT, Math.min(MAX_TIMEOUT, n));
}

// ── Parse an NNTP single-line response: "NNN text\r\n" ──────────────────────
function parseStatus(line) {
  const m = /^(\d{3}) ?(.*)$/.exec(line.trim());
  if (!m) throw new Error(`nntp_client: unexpected response line: ${JSON.stringify(line)}`);
  return { code: parseInt(m[1], 10), text: m[2] };
}

// ── Low-level NNTP connection class ──────────────────────────────────────────
class NntpSession {
  constructor(socket, timeoutMs) {
    this._socket   = socket;
    this._timeout  = timeoutMs;
    this._buf      = Buffer.alloc(0);
    this._pending  = null; // { resolve, reject, multiline }
    this._totalBytes = 0;
    this._closed   = false;

    socket.on("data", (chunk) => {
      this._totalBytes += chunk.length;
      if (this._totalBytes > MAX_RESPONSE_BYTES) {
        this._fail(new Error("nntp_client: response size limit exceeded (8 MB)."));
        return;
      }
      this._buf = Buffer.concat([this._buf, chunk]);
      this._tryResolve();
    });
    socket.on("error", (err) => this._fail(err));
    socket.on("close", () => {
      this._closed = true;
      this._fail(new Error("nntp_client: connection closed unexpectedly."));
    });
  }

  _fail(err) {
    const p = this._pending;
    this._pending = null;
    if (p) p.reject(err);
  }

  _tryResolve() {
    if (!this._pending) return;
    const { resolve, multiline } = this._pending;
    const str = this._buf.toString("utf8");

    if (!multiline) {
      // Single-line: wait for \r\n or \n
      const idx = str.indexOf("\n");
      if (idx === -1) return;
      const line = str.slice(0, idx).replace(/\r$/, "");
      this._buf = Buffer.from(str.slice(idx + 1));
      this._pending = null;
      resolve(line);
    } else {
      // Multi-line: terminated by "\r\n.\r\n" or "\n.\n"
      const endMarker1 = "\r\n.\r\n";
      const endMarker2 = "\n.\n";
      let endIdx = str.indexOf(endMarker1);
      let markerLen = endMarker1.length;
      if (endIdx === -1) {
        endIdx = str.indexOf(endMarker2);
        markerLen = endMarker2.length;
      }
      if (endIdx === -1) return;
      const block = str.slice(0, endIdx);
      this._buf = Buffer.from(str.slice(endIdx + markerLen));
      this._pending = null;
      resolve(block);
    }
  }

  // Send a command and receive a single-line response
  async sendCmd(cmd) {
    if (this._closed) throw new Error("nntp_client: session is closed.");
    await new Promise((resolve, reject) => {
      // Reset per-request total bytes for this exchange
      this._totalBytes = 0;
      this._pending = { resolve, reject, multiline: false };
      const timer = setTimeout(() => {
        this._pending = null;
        reject(new Error(`nntp_client: timeout waiting for response to ${JSON.stringify(cmd.split(" ")[0])}.`));
      }, this._timeout);
      this._socket.write(cmd + "\r\n", (err) => {
        if (err) {
          clearTimeout(timer);
          this._pending = null;
          reject(err);
        }
      });
      // Wrap resolve to clear timer
      const origResolve = this._pending.resolve;
      this._pending.resolve = (v) => { clearTimeout(timer); origResolve(v); };
      const origReject = this._pending.reject;
      this._pending.reject = (e) => { clearTimeout(timer); origReject(e); };
    });
    // The result was stored via _tryResolve; we need the line value
    // Redesign: use a promise that resolves to the line
    return this._lastLine; // set by redesigned version below
  }

  // Better design: send + receive line as one promise
  cmd(cmdStr) {
    return new Promise((resolve, reject) => {
      if (this._closed) { reject(new Error("nntp_client: session is closed.")); return; }
      this._totalBytes = 0;
      const timer = setTimeout(() => {
        this._pending = null;
        reject(new Error(`nntp_client: timeout waiting for response to ${JSON.stringify(cmdStr.split(" ")[0])}.`));
      }, this._timeout);
      this._pending = {
        resolve: (line) => { clearTimeout(timer); resolve(line); },
        reject:  (err)  => { clearTimeout(timer); reject(err); },
        multiline: false,
      };
      this._socket.write(cmdStr + "\r\n", (err) => {
        if (err) {
          clearTimeout(timer);
          this._pending = null;
          reject(new Error(`nntp_client: write error: ${err.message}`));
        }
      });
      this._tryResolve(); // In case data arrived before we set pending
    });
  }

  // Receive a multi-line block (after a command that returns 2xx followed by dot-terminated body)
  recvMultiline() {
    return new Promise((resolve, reject) => {
      if (this._closed) { reject(new Error("nntp_client: session is closed.")); return; }
      const timer = setTimeout(() => {
        this._pending = null;
        reject(new Error("nntp_client: timeout waiting for multi-line response."));
      }, this._timeout);
      this._pending = {
        resolve: (block) => { clearTimeout(timer); resolve(block); },
        reject:  (err)   => { clearTimeout(timer); reject(err); },
        multiline: true,
      };
      this._tryResolve(); // In case data already in buffer
    });
  }

  // Read welcome banner
  readBanner() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending = null;
        reject(new Error("nntp_client: timeout waiting for server banner."));
      }, this._timeout);
      this._pending = {
        resolve: (line) => { clearTimeout(timer); resolve(line); },
        reject:  (err)  => { clearTimeout(timer); reject(err); },
        multiline: false,
      };
      this._tryResolve();
    });
  }

  destroy() {
    this._closed = true;
    try { this._socket.destroy(); } catch (_) {}
  }
}

// ── Connect and perform initial handshake ─────────────────────────────────────
async function connectNntp({ host, port, use_tls, reject_unauthorized, timeout }) {
  const timeoutMs = clampTimeout(timeout);
  const useTls    = !!use_tls;
  const actualPort = port ?? (useTls ? DEFAULT_PORT_TLS : DEFAULT_PORT_PLAIN);

  guardNul(host, "host");
  if (!host || typeof host !== "string")
    throw new Error("nntp_client: 'host' is required.");
  if (!Number.isInteger(actualPort) || actualPort < 1 || actualPort > 65535)
    throw new Error(`nntp_client: 'port' must be 1-65535, got ${actualPort}.`);

  const socket = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`nntp_client: connection to ${host}:${actualPort} timed out.`)), timeoutMs);
    let s;
    const onConnect = () => { clearTimeout(timer); resolve(s); };
    const onError   = (err) => { clearTimeout(timer); reject(new Error(`nntp_client: connection failed: ${err.message}`)); };

    if (useTls) {
      s = tls.connect({
        host, port: actualPort,
        rejectUnauthorized: reject_unauthorized !== false,
        servername: host,
      }, onConnect);
    } else {
      s = net.connect({ host, port: actualPort }, onConnect);
    }
    s.once("error", onError);
  });

  socket.setKeepAlive(true, 10000);
  const session = new NntpSession(socket, timeoutMs);

  // Read welcome banner
  const banner = await session.readBanner();
  const { code, text } = parseStatus(banner);
  if (code !== 200 && code !== 201) {
    session.destroy();
    throw new Error(`nntp_client: server rejected connection: ${code} ${text}`);
  }
  const postingAllowed = code === 200;

  return { session, banner: `${code} ${text}`, postingAllowed };
}

// ── Parse GROUP response: "211 count first last group" ─────────────────────
function parseGroupStatus(text) {
  // "211 count first last name" or sometimes "211 count first last"
  const parts = text.trim().split(/\s+/);
  return {
    count:     parseInt(parts[0], 10) || 0,
    first:     parseInt(parts[1], 10) || 0,
    last:      parseInt(parts[2], 10) || 0,
    groupName: parts[3] || "",
  };
}

// ── Parse multi-line list into array of lines ────────────────────────────────
// recvMultiline() returns the raw dot-terminated body AFTER the status line
// has already been consumed by cmd(). The block starts directly with data
// lines. We must NOT slice(1); just strip empty lines and the trailing ".".
function splitBlock(block) {
  const rawLines = block.split(/\r?\n/);
  const result = [];
  for (let i = 0; i < rawLines.length; i++) {
    const l = rawLines[i];
    // Skip bare "." line (dot terminator) and empty lines
    if (l === "." || l === "") continue;
    // De-dot-stuff: lines starting with ".." -> "."
    result.push(l.startsWith(".") ? l.slice(1) : l);
  }
  return result;
}

// ── Parse overview line (OVER/XOVER) ────────────────────────────────────────
// Format: num\tsubject\tfrom\tdate\tmessage-id\treferences\tbytes\tlines[\t...]
function parseOverviewLine(line) {
  const parts = line.split("\t");
  return {
    number:     parseInt(parts[0], 10) || 0,
    subject:    parts[1] || "",
    from:       parts[2] || "",
    date:       parts[3] || "",
    messageId:  parts[4] || "",
    references: parts[5] || "",
    bytes:      parseInt(parts[6], 10) || 0,
    lines:      parseInt(parts[7], 10) || 0,
  };
}

// ── Parse LIST NEWSGROUPS / LIST ACTIVE lines ─────────────────────────────────
function parseListActive(line) {
  // "group last first flag"
  const parts = line.trim().split(/\s+/);
  return {
    group: parts[0] || "",
    last:  parseInt(parts[1], 10) || 0,
    first: parseInt(parts[2], 10) || 0,
    flag:  parts[3] || "",
  };
}

function parseListDescriptions(line) {
  // "group\tdescription" or "group description"
  const tabIdx = line.indexOf("\t");
  if (tabIdx !== -1) {
    return { group: line.slice(0, tabIdx), description: line.slice(tabIdx + 1) };
  }
  const spIdx = line.indexOf(" ");
  if (spIdx === -1) return { group: line, description: "" };
  return { group: line.slice(0, spIdx), description: line.slice(spIdx + 1) };
}

// ── Parse article headers block into object ──────────────────────────────────
function parseHeaders(block) {
  const lines = block.split(/\r?\n/);
  const headers = {};
  let currentKey = null;
  for (const line of lines) {
    if (!line || line === ".") continue;
    // Folded header continuation
    if (/^[ \t]/.test(line) && currentKey) {
      headers[currentKey] += " " + line.trim();
      continue;
    }
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      currentKey = line.slice(0, colonIdx).toLowerCase();
      headers[currentKey] = line.slice(colonIdx + 1).trim();
    }
  }
  return headers;
}

// ── cmd + expect: send command, check response code ─────────────────────────
async function cmdExpect(session, cmdStr, expectedCodes) {
  const line = await session.cmd(cmdStr);
  const { code, text } = parseStatus(line);
  if (!expectedCodes.includes(code))
    throw new Error(`nntp_client: expected ${expectedCodes.join("/")}, got ${code} ${text}`);
  return { code, text };
}

// ── CAPABILITIES ─────────────────────────────────────────────────────────────
async function opCapabilities(session) {
  let line;
  try {
    line = await session.cmd("CAPABILITIES");
  } catch (e) {
    throw new Error(`nntp_client: CAPABILITIES failed: ${e.message}`);
  }
  const { code, text } = parseStatus(line);
  if (code === 500) {
    // Old server doesn't support CAPABILITIES (RFC 977 only)
    return { supported: false, version: null, capabilities: [], raw: `${code} ${text}` };
  }
  if (code !== 101)
    throw new Error(`nntp_client: CAPABILITIES returned ${code} ${text}`);

  const block = await session.recvMultiline();
  const lines = splitBlock(block);
  let version = null;
  const caps = [];
  for (const l of lines) {
    if (/^VERSION/i.test(l)) {
      version = l.split(/\s+/)[1] || null;
    } else if (l.trim()) {
      caps.push(l.trim());
    }
  }
  return { supported: true, version, capabilities: caps };
}

// ── LIST (ACTIVE or NEWSGROUPS) ──────────────────────────────────────────────
async function opListGroups(session, { list_type = "active", pattern, max_groups = 5000 }) {
  const cap = Math.min(Math.max(1, Math.trunc(Number(max_groups) || 5000)), 50000);
  let cmd;
  if (list_type === "descriptions") {
    cmd = pattern ? `LIST NEWSGROUPS ${pattern}` : "LIST NEWSGROUPS";
  } else {
    cmd = pattern ? `LIST ACTIVE ${pattern}` : "LIST ACTIVE";
  }

  const line = await session.cmd(cmd);
  const { code, text } = parseStatus(line);
  if (code !== 215)
    throw new Error(`nntp_client: LIST returned ${code} ${text}`);

  const block = await session.recvMultiline();
  let lines = splitBlock(block).filter(l => l.trim());
  const total = lines.length;
  const truncated = lines.length > cap;
  if (truncated) lines = lines.slice(0, cap);

  const groups = lines.map(l =>
    list_type === "descriptions" ? parseListDescriptions(l) : parseListActive(l)
  );

  return { listType: list_type, total, truncated, groupCount: groups.length, groups };
}

// ── GROUP selection ──────────────────────────────────────────────────────────
async function opGroup(session, { group }) {
  guardNul(group, "group");
  if (!group) throw new Error("nntp_client: 'group' is required for 'group' operation.");

  const line = await session.cmd(`GROUP ${group}`);
  const { code, text } = parseStatus(line);
  if (code === 411)
    throw new Error(`nntp_client: no such newsgroup '${group}'.`);
  if (code !== 211)
    throw new Error(`nntp_client: GROUP returned ${code} ${text}`);

  const g = parseGroupStatus(text);
  return {
    group:    g.groupName || group,
    count:    g.count,
    first:    g.first,
    last:     g.last,
    selected: true,
  };
}

// ── LISTGROUP (articles in range) / OVER (overview) ─────────────────────────
async function opListArticles(session, { group, first, last, max_articles = 500, overview = true }) {
  const cap = Math.min(Math.max(1, Math.trunc(Number(max_articles) || 500)), 5000);

  // Select group first if provided
  let groupInfo = null;
  if (group) {
    guardNul(group, "group");
    groupInfo = await opGroup(session, { group });
  }

  if (overview) {
    // Try OVER (RFC 3977) or XOVER (RFC 2980)
    const range = first != null && last != null
      ? `${first}-${last}`
      : first != null ? `${first}-` : "";
    let overCmd = `OVER ${range}`.trim();
    let line = await session.cmd(overCmd);
    let { code, text } = parseStatus(line);
    if (code === 500 || code === 480) {
      // Try XOVER
      overCmd = `XOVER ${range}`.trim();
      line = await session.cmd(overCmd);
      ({ code, text } = parseStatus(line));
    }
    if (code === 423 || code === 420) {
      return { group: group || null, articles: [], total: 0, truncated: false };
    }
    if (code !== 224)
      throw new Error(`nntp_client: OVER/XOVER returned ${code} ${text}`);

    const block = await session.recvMultiline();
    let lines = splitBlock(block).filter(l => l.trim());
    const total = lines.length;
    const truncated = lines.length > cap;
    if (truncated) lines = lines.slice(0, cap);
    const articles = lines.map(parseOverviewLine);
    return {
      group:    group || null,
      ...(groupInfo || {}),
      total,
      truncated,
      articleCount: articles.length,
      articles,
    };
  } else {
    // LISTGROUP
    const range = first != null && last != null ? ` ${first}-${last}` : "";
    const line = await session.cmd(group ? `LISTGROUP ${group}${range}` : `LISTGROUP${range}`);
    const { code, text } = parseStatus(line);
    if (code === 411)
      throw new Error(`nntp_client: no such newsgroup '${group}'.`);
    if (code !== 211)
      throw new Error(`nntp_client: LISTGROUP returned ${code} ${text}`);
    const gs = parseGroupStatus(text);
    const block = await session.recvMultiline();
    let articleNums = splitBlock(block).filter(l => /^\d+$/.test(l.trim())).map(Number);
    const total = articleNums.length;
    const truncated = articleNums.length > cap;
    if (truncated) articleNums = articleNums.slice(0, cap);
    return {
      group:    gs.groupName || group,
      count:    gs.count,
      first:    gs.first,
      last:     gs.last,
      total,
      truncated,
      articleCount: articleNums.length,
      articles: articleNums.map(n => ({ number: n })),
    };
  }
}

// ── ARTICLE / HEAD / BODY ─────────────────────────────────────────────────────
async function opArticle(session, { operation, message_id, article_num, group, parse_headers: ph = true }) {
  // Optionally select group
  if (group) {
    guardNul(group, "group");
    await opGroup(session, { group });
  }

  const target = message_id ? `<${message_id.replace(/^<|>$/g, "")}>` :
                 article_num != null ? `${article_num}` : "";
  const cmdName = operation.toUpperCase(); // ARTICLE, HEAD, BODY
  const line = await session.cmd(target ? `${cmdName} ${target}` : cmdName);
  const { code, text } = parseStatus(line);

  // Expected codes: 220 (ARTICLE), 221 (HEAD), 222 (BODY)
  const expectedMap = { ARTICLE: [220], HEAD: [221], BODY: [222] };
  const expected = expectedMap[cmdName] || [220, 221, 222];

  if (code === 423 || code === 420 || code === 430)
    throw new Error(`nntp_client: ${cmdName}: article not found (${code} ${text}).`);
  if (!expected.includes(code))
    throw new Error(`nntp_client: ${cmdName} returned ${code} ${text}`);

  const block = await session.recvMultiline();
  // recvMultiline() returns data AFTER the status line (already consumed by cmd()).
  // No need to slice(1). Just de-dot-stuff and join.
  const rawLines = block.split(/\r?\n/);
  const raw   = rawLines
    .filter((l, i, a) => !(i === a.length - 1 && (l === "." || l === "")))
    .map(l => l.startsWith(".") ? l.slice(1) : l)
    .join("\n");

  if (raw.length > MAX_ARTICLE_BYTES)
    throw new Error(`nntp_client: article too large (max ${MAX_ARTICLE_BYTES} bytes).`);

  const result = { code, articleId: text.trim(), raw };

  if ((cmdName === "ARTICLE" || cmdName === "HEAD") && ph) {
    // Split headers from body at first blank line
    const blankIdx = raw.indexOf("\n\n");
    const headerText = blankIdx !== -1 ? raw.slice(0, blankIdx) : raw;
    result.headers = parseHeaders(headerText);
    if (cmdName === "ARTICLE" && blankIdx !== -1) {
      result.body = raw.slice(blankIdx + 2);
    }
  }

  return result;
}

// ── POST ─────────────────────────────────────────────────────────────────────
async function opPost(session, { newsgroups, subject, from, body, extra_headers }) {
  guardNul(newsgroups, "newsgroups");
  guardNul(subject, "subject");
  guardNul(from, "from");
  guardNul(body, "body");

  if (!newsgroups) throw new Error("nntp_client: 'newsgroups' is required for post.");
  if (!subject)    throw new Error("nntp_client: 'subject' is required for post.");
  if (!from)       throw new Error("nntp_client: 'from' is required for post.");
  if (!body)       throw new Error("nntp_client: 'body' is required for post.");

  // Validate extra_headers BEFORE sending any commands (so NUL errors fire early)
  if (extra_headers) {
    for (const [k, v] of Object.entries(extra_headers)) {
      guardNul(v, `extra_headers.${k}`);
    }
  }

  // Send POST command
  const line1 = await session.cmd("POST");
  const { code: c1, text: t1 } = parseStatus(line1);
  if (c1 === 440) throw new Error("nntp_client: posting not allowed by this server.");
  if (c1 !== 340) throw new Error(`nntp_client: POST returned ${c1} ${t1}`);

  // Build article
  const msgId = `<${crypto.randomBytes(12).toString("hex")}.nntp@mcp.local>`;
  let article = `From: ${from}\r\nNewsgroups: ${newsgroups}\r\nSubject: ${subject}\r\nMessage-ID: ${msgId}\r\n`;
  if (extra_headers) {
    for (const [k, v] of Object.entries(extra_headers)) {
      article += `${k}: ${v}\r\n`;
    }
  }
  article += `\r\n${body.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n")}`;

  // Dot-stuff and terminate
  const stuffed = article.split("\r\n").map(l => l.startsWith(".") ? "." + l : l).join("\r\n");
  const fullMsg = stuffed + "\r\n.\r\n";

  const line2 = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session._pending = null;
      reject(new Error("nntp_client: timeout waiting for POST confirmation."));
    }, session._timeout);
    session._pending = {
      resolve: (l) => { clearTimeout(timer); resolve(l); },
      reject:  (e) => { clearTimeout(timer); reject(e); },
      multiline: false,
    };
    session._socket.write(fullMsg, (err) => {
      if (err) {
        clearTimeout(timer);
        session._pending = null;
        reject(new Error(`nntp_client: write error during POST: ${err.message}`));
      }
    });
    session._tryResolve();
  });

  const { code: c2, text: t2 } = parseStatus(line2);
  if (c2 === 441) throw new Error(`nntp_client: post rejected by server: ${t2}`);
  if (c2 !== 240) throw new Error(`nntp_client: POST confirmation returned ${c2} ${t2}`);

  return { posted: true, messageId: msgId, response: `${c2} ${t2}` };
}

// ── DATE (server time) ────────────────────────────────────────────────────────
async function opDate(session) {
  const line = await session.cmd("DATE");
  const { code, text } = parseStatus(line);
  if (code === 500) return { supported: false, raw: null, iso8601: null };
  if (code !== 111) throw new Error(`nntp_client: DATE returned ${code} ${text}`);
  // Format: 111 YYYYMMDDHHmmss
  const raw = text.trim();
  let iso8601 = null;
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(raw);
  if (m) {
    iso8601 = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
  }
  return { supported: true, raw, iso8601 };
}

// ── QUIT ─────────────────────────────────────────────────────────────────────
async function opQuit(session) {
  try {
    const line = await session.cmd("QUIT");
    const { code, text } = parseStatus(line);
    return { code, text };
  } catch (_) {
    return { code: 0, text: "connection closed" };
  } finally {
    session.destroy();
  }
}

// ── INFO (no I/O) ─────────────────────────────────────────────────────────────
function opInfo() {
  return {
    protocol: "NNTP",
    rfcs: [
      "RFC 977 (Network News Transfer Protocol, 1986)",
      "RFC 2980 (Common NNTP Extensions, including XOVER/XHDR)",
      "RFC 3977 (Network News Transfer Protocol, 2006 revision)",
      "RFC 4644 (NNTP Extension for Streaming Feeds)",
    ],
    defaultPorts: { plain: DEFAULT_PORT_PLAIN, tls: DEFAULT_PORT_TLS },
    authMethods: ["AUTHINFO USER/PASS (RFC 4643)"],
    operations: [
      { name: "capabilities", description: "List server capabilities (RFC 3977 CAPABILITIES command). Returns supported features." },
      { name: "list_groups",  description: "List available newsgroups (LIST ACTIVE or LIST NEWSGROUPS). Can filter by pattern e.g. comp.lang.*." },
      { name: "group",        description: "Select a newsgroup and return article count, first/last article numbers." },
      { name: "list_articles",description: "List articles in selected/specified group using OVER/XOVER (overview) or LISTGROUP." },
      { name: "article",      description: "Download a full article (headers + body) by message-ID or article number." },
      { name: "head",         description: "Retrieve only article headers by message-ID or article number." },
      { name: "body",         description: "Retrieve only article body by message-ID or article number." },
      { name: "post",         description: "Post a new article to one or more newsgroups." },
      { name: "date",         description: "Get the current date/time from the server (RFC 3977 DATE command)." },
      { name: "quit",         description: "Send QUIT command and close the connection gracefully." },
      { name: "info",         description: "Return protocol reference table (no network I/O)." },
    ],
    authInfo: "Authentication (AUTHINFO USER/PASS) is performed automatically when username+password are provided.",
    security: [
      "NUL-byte guards on all string inputs",
      "Timeout clamped 1000-120000 ms",
      "Response cap: 8 MB total; 4 MB per article",
      "Passwords never logged or returned",
      "TLS supported (port 563, NNTPS)",
      "List results capped at 50000 entries",
    ],
  };
}

// ── AUTHINFO (authenticate if credentials provided) ──────────────────────────
async function maybeAuth(session, { username, password }) {
  if (!username && !password) return;
  guardNul(username, "username");
  guardNul(password, "password");
  if (!username) throw new Error("nntp_client: 'username' is required when 'password' is set.");
  if (!password) throw new Error("nntp_client: 'password' is required when 'username' is set.");

  const l1 = await session.cmd(`AUTHINFO USER ${username}`);
  const { code: c1, text: t1 } = parseStatus(l1);
  if (c1 === 281) return; // Already authenticated
  if (c1 !== 381) throw new Error(`nntp_client: AUTHINFO USER failed: ${c1} ${t1}`);

  const l2 = await session.cmd(`AUTHINFO PASS ${password}`);
  const { code: c2, text: t2 } = parseStatus(l2);
  if (c2 === 481) throw new Error("nntp_client: authentication failed (invalid credentials).");
  if (c2 !== 281) throw new Error(`nntp_client: AUTHINFO PASS failed: ${c2} ${t2}`);
}

// ── Main entry point ─────────────────────────────────────────────────────────
async function nntpClient(args) {
  const { operation, host, port, use_tls, reject_unauthorized,
          username, password, timeout } = args;

  if (!operation)
    throw new Error("nntp_client: 'operation' is required.");

  // info doesn't need a connection
  if (operation === "info") return opInfo();

  // All other operations need a connection
  if (!host) throw new Error("nntp_client: 'host' is required.");

  let session;
  try {
    const conn = await connectNntp({
      host, port, use_tls, reject_unauthorized, timeout,
    });
    session = conn.session;
    const serverBanner   = conn.banner;
    const postingAllowed = conn.postingAllowed;

    // Authenticate if credentials supplied
    await maybeAuth(session, { username, password });

    let result;
    switch (operation) {
      case "capabilities":
        result = await opCapabilities(session);
        result = { ...result, serverBanner, postingAllowed };
        break;

      case "list_groups":
        result = await opListGroups(session, {
          list_type:  args.list_type,
          pattern:    args.pattern,
          max_groups: args.max_groups,
        });
        result = { serverBanner, postingAllowed, ...result };
        break;

      case "group":
        result = await opGroup(session, { group: args.group });
        result = { serverBanner, postingAllowed, ...result };
        break;

      case "list_articles":
        result = await opListArticles(session, {
          group:        args.group,
          first:        args.first,
          last:         args.last,
          max_articles: args.max_articles,
          overview:     args.overview !== false,
        });
        result = { serverBanner, postingAllowed, ...result };
        break;

      case "article":
      case "head":
      case "body":
        result = await opArticle(session, {
          operation,
          message_id:    args.message_id,
          article_num:   args.article_num,
          group:         args.group,
          parse_headers: args.parse_headers !== false,
        });
        result = { serverBanner, postingAllowed, ...result };
        break;

      case "post":
        result = await opPost(session, {
          newsgroups:    args.newsgroups,
          subject:       args.subject,
          from:          args.from,
          body:          args.body,
          extra_headers: args.extra_headers,
        });
        result = { serverBanner, postingAllowed, ...result };
        break;

      case "date":
        result = await opDate(session);
        result = { serverBanner, postingAllowed, ...result };
        break;

      case "quit":
        result = await opQuit(session);
        session = null; // Already destroyed
        result = { serverBanner, postingAllowed, ...result };
        return result;

      default:
        throw new Error(`nntp_client: unknown operation '${operation}'.`);
    }

    // Graceful quit
    try {
      const qLine = await session.cmd("QUIT");
      const { code: qc } = parseStatus(qLine);
      result.quitCode = qc;
    } catch (_) {
      // Ignore quit errors
    }
    session.destroy();
    return result;

  } catch (err) {
    if (session) {
      try { session.destroy(); } catch (_) {}
    }
    throw err;
  }
}

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports = { nntpClient };

// ── Internal exports for unit testing ────────────────────────────────────────
module.exports._internal = {
  parseStatus,
  parseGroupStatus,
  splitBlock,
  parseOverviewLine,
  parseListActive,
  parseListDescriptions,
  parseHeaders,
  clampTimeout,
  guardNul,
  opInfo,
};
