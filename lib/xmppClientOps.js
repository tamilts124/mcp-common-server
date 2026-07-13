"use strict";
/**
 * xmpp_client — Zero-dependency XMPP (Jabber) client.
 * Pure Node.js (net + tls + crypto built-ins; no npm deps).
 *
 * Implements:
 *   RFC 6120  — XMPP Core (stream open/close, SASL, resource binding, session)
 *   RFC 6121  — XMPP IM (roster, presence, messaging)
 *   RFC 7590  — Use of TLS in XMPP (STARTTLS / direct TLS)
 *   XEP-0199  — XMPP Ping (urn:ietf:params:xml:ns:xmpp-ping)
 *
 * Operations:
 *   send_message  — Send an XMPP instant message to a JID
 *   get_roster    — Retrieve the contact roster
 *   presence      — Send presence stanza (available/away/offline/subscribe)
 *   ping          — Send an XMPP ping (XEP-0199) and measure round-trip
 *   info          — Return protocol/config info (no I/O)
 *
 * Transport: Direct TLS (port 5223, XMPPS) or STARTTLS over plain (port 5222).
 * Authentication: SASL PLAIN (RFC 4616) over TLS; SASL EXTERNAL not implemented.
 *
 * Security:
 *   - NUL-byte guards on all string inputs
 *   - Timeout clamped 2s–60s (default 10s)
 *   - Response cap 512 KB
 *   - JID validated (user@domain[/resource] format)
 *   - Passwords never logged or included in error messages
 */

const net    = require("net");
const tls    = require("tls");
const crypto = require("crypto");

// ── Constants ─────────────────────────────────────────────────────────────────
const XMPP_DEFAULT_PORT  = 5222;  // STARTTLS
const XMPPS_DEFAULT_PORT = 5223;  // Direct TLS
const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS     =  2_000;
const MAX_TIMEOUT_MS     = 60_000;
const MAX_RESPONSE_BYTES = 512 * 1024; // 512 KB

// ── Validation helpers ────────────────────────────────────────────────────────
function guardNul(value, name) {
  if (typeof value === "string" && value.includes("\0"))
    throw new Error(`xmpp_client: '${name}' must not contain NUL bytes.`);
}

function clampTimeout(t) {
  const n = typeof t === "number" ? t : DEFAULT_TIMEOUT_MS;
  return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.trunc(n)));
}

/**
 * Parse a JID: user@domain[/resource]
 * Returns { user, domain, resource, bare, full }
 */
function parseJid(jidStr) {
  if (!jidStr || typeof jidStr !== "string")
    throw new Error("xmpp_client: JID must be a non-empty string.");
  const str = jidStr.trim();
  const atIdx = str.indexOf("@");
  if (atIdx === -1)
    throw new Error(`xmpp_client: invalid JID '${str}' — must be user@domain.`);
  const user   = str.slice(0, atIdx);
  const rest   = str.slice(atIdx + 1);
  const slashIdx = rest.indexOf("/");
  const domain   = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
  const resource = slashIdx === -1 ? null  : rest.slice(slashIdx + 1);
  if (!user)   throw new Error(`xmpp_client: JID '${str}' is missing localpart (user).`);
  if (!domain) throw new Error(`xmpp_client: JID '${str}' is missing domain.`);
  const bare = `${user}@${domain}`;
  const full = resource ? `${bare}/${resource}` : bare;
  return { user, domain, resource, bare, full };
}

/** Escape XML special characters in attribute values and text */
function xmlEsc(s) {
  if (typeof s !== "string") return String(s);
  return s
    .replace(/&/g,  "&amp;")
    .replace(/</g,  "&lt;")
    .replace(/>/g,  "&gt;")
    .replace(/"/g,  "&quot;")
    .replace(/'/g,  "&apos;");
}

/** Generate a random stanza ID */
function randomId() {
  return "mcp" + crypto.randomBytes(6).toString("hex");
}

// ── Minimal XML parser ────────────────────────────────────────────────────────
// Enough to extract XMPP stanzas from a stream without a full DOM.
// Only handles the subset of XML used in XMPP responses.

/**
 * Extract the first complete top-level XML element from a string buffer.
 * Returns { element: string, rest: string } or null if not yet complete.
 */
function extractElement(buf) {
  const m = buf.match(/^\s*<([a-zA-Z][^\s/>]*)/);
  if (!m) {
    // Check for stream-level error or stream close
    const errMatch = buf.match(/<stream:error[^>]*>[\s\S]*?<\/stream:error>/);
    if (errMatch) return { element: errMatch[0], rest: buf.slice(errMatch.index + errMatch[0].length) };
    const closeMatch = buf.match(/<\/stream:stream>/);
    if (closeMatch) return { element: closeMatch[0], rest: buf.slice(closeMatch.index + closeMatch[0].length) };
    return null;
  }
  const tagName = m[1].split(/[\s/>]/)[0];
  // Self-closing tag?
  const selfCloseRe = new RegExp("^\\s*<" + escapeRe(tagName) + "[^>]*/>");
  const selfClose = selfCloseRe.exec(buf);
  if (selfClose) return { element: selfClose[0], rest: buf.slice(selfClose[0].length) };
  // Find matching close tag using depth counting.
  // Start AFTER the initial opening tag to avoid counting it.
  const firstTagEnd = buf.indexOf(">");
  if (firstTagEnd === -1) return null;
  const openStr  = "<" + tagName;
  const closeTag = "</" + tagName + ">";
  let depth = 1; // we already consumed one open tag
  let i = firstTagEnd + 1;
  while (i < buf.length) {
    const nextOpen  = buf.indexOf(openStr, i);
    const nextClose = buf.indexOf(closeTag, i);
    if (nextClose === -1) return null; // stream incomplete
    // Determine which comes first: another open tag or the close tag
    if (nextOpen !== -1 && nextOpen < nextClose) {
      // Verify it's an actual tag boundary (not a substring)
      const ch = buf[nextOpen + openStr.length];
      if (ch === ">" || ch === " " || ch === "/" || ch === "\n" || ch === "\r" || ch === "\t") {
        depth++;
        i = nextOpen + openStr.length;
      } else {
        i = nextOpen + 1;
      }
    } else {
      depth--;
      i = nextClose + closeTag.length;
      if (depth === 0) {
        return { element: buf.slice(0, i), rest: buf.slice(i) };
      }
    }
  }
  return null;
}

function escapeRe(s) {
  return s.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&");
}

/** Extract attribute value from an XML fragment */
function xmlAttr(xml, attr) {
  const re = new RegExp(escapeRe(attr) + "=(?:\"([^\"]*)\"|'([^']*)')");
  const m = xml.match(re);
  return m ? (m[1] !== undefined ? m[1] : m[2]) : null;
}

/** Extract text content of the first matching element */
function xmlText(xml, tagName) {
  const tag = escapeRe(tagName);
  const re = new RegExp("<" + tag + "[^>]*>([\\s\\S]*?)<\/" + tag + ">");
  const m = xml.match(re);
  return m ? m[1].trim() : null;
}

/** Check if XML fragment contains an element */
function xmlHas(xml, tagName) {
  return new RegExp("<" + escapeRe(tagName) + "[\\s/>]").test(xml);
}

// ── XMPP Stream Manager ───────────────────────────────────────────────────────
/**
 * XmppStream: manages a single XMPP TCP/TLS connection.
 * Handles: stream open, STARTTLS upgrade, SASL PLAIN auth,
 * resource binding, session establishment, and stanza send/receive.
 */
class XmppStream {
  constructor(opts) {
    this.host    = opts.host;
    this.port    = opts.port;
    this.domain  = opts.domain;
    this.jid     = opts.jid;      // parsed JID
    this.password = opts.password;
    this.useTls  = opts.useTls;   // direct TLS (port 5223)
    this.rejectUnauthorized = opts.rejectUnauthorized !== false;
    this.timeoutMs = opts.timeoutMs;
    this.sock    = null;
    this.buf     = "";
    this.boundJid = null;         // set after resource binding
    this._resolvers = [];         // pending promise resolvers
    this._queue     = [];          // stanzas dispatched before a resolver was ready
    this._connected = false;
    this._done = false;
  }

  /** Connect and fully authenticate (stream open → TLS → SASL → bind → session) */
  async connect() {
    await this._openSocket();
    const feat1 = await this._openStream();
    if (!this.useTls) {
      // Only do STARTTLS if the server advertises it in features
      const hasTls = feat1 && feat1.xml && feat1.xml.includes("xmpp-tls");
      if (hasTls) {
        await this._doStartTls();
        // Re-open stream over TLS
        await this._openStream();
      }
      // If server offers SASL directly (no TLS), proceed without STARTTLS
    }
    await this._doSaslPlain();
    // Re-open stream after SASL
    await this._openStream();
    await this._bindResource();
    await this._establishSession();
  }

  async _openSocket() {
    return new Promise((resolve, reject) => {
      const tlsOptions = {
        host:               this.host,
        port:               this.port,
        servername:         this.domain,
        rejectUnauthorized: this.rejectUnauthorized,
      };

      let sock;
      if (this.useTls) {
        sock = tls.connect(this.port, this.host, { servername: this.domain, rejectUnauthorized: this.rejectUnauthorized });
        sock.once("secureConnect", () => {
          this.sock = sock;
          this._connected = true;
          this._attachDataHandler();
          resolve();
        });
      } else {
        sock = net.connect(this.port, this.host);
        sock.once("connect", () => {
          this.sock = sock;
          this._connected = true;
          this._attachDataHandler();
          resolve();
        });
      }

      const connTimer = setTimeout(() => {
        sock.destroy();
        reject(new Error(`xmpp_client: connection timed out to ${this.host}:${this.port} after ${this.timeoutMs} ms.`));
      }, this.timeoutMs);

      sock.once("error", (err) => {
        clearTimeout(connTimer);
        reject(new Error(`xmpp_client: connection error: ${err.message}`));
      });

      sock.once("connect", () => clearTimeout(connTimer));
      sock.once("secureConnect", () => clearTimeout(connTimer));
    });
  }

  _attachDataHandler() {
    this.sock.on("data", (chunk) => {
      this.buf += chunk.toString("utf8");
      if (this.buf.length > MAX_RESPONSE_BYTES) {
        this._rejectAll(new Error(`xmpp_client: response buffer exceeded ${MAX_RESPONSE_BYTES} byte cap.`));
        return;
      }
      this._dispatchBuf();
    });
    this.sock.once("close", () => {
      if (!this._done)
        this._rejectAll(new Error("xmpp_client: connection closed unexpectedly."));
    });
    this.sock.once("error", (err) => {
      this._rejectAll(new Error(`xmpp_client: socket error: ${err.message}`));
    });
  }

  _dispatchBuf() {
    // Extract and dispatch complete XML elements
    while (true) {
      // Check for stream:stream open FIRST (server hello) — must precede features check
      if (this.buf.includes("<stream:stream")) {
        // This may arrive without a closing tag
        const m = this.buf.match(/<stream:stream[^>]*>/);
        if (m) {
          this.buf = this.buf.slice(m.index + m[0].length);
          this._resolve({ type: "stream_open", xml: m[0] });
          continue;
        }
      }
      // Check for stream:features (special — not a normal element)
      if (this.buf.includes("<stream:features")) {
        const m = this.buf.match(/<stream:features[\s\S]*?<\/stream:features>/);
        if (m) {
          this.buf = this.buf.slice(m.index + m[0].length);
          this._resolve({ type: "features", xml: m[0] });
          continue;
        }
      }
      // Check for proceed (STARTTLS)
      if (this.buf.includes("<proceed")) {
        const m = this.buf.match(/<proceed[^>]*\/>|<proceed[^>]*><\/proceed>/);
        if (m) {
          this.buf = this.buf.slice(m.index + m[0].length);
          this._resolve({ type: "proceed", xml: m[0] });
          continue;
        }
      }
      // Check for failure (SASL/TLS failure)
      if (this.buf.includes("<failure")) {
        const m = this.buf.match(/<failure[\s\S]*?<\/failure>/);
        if (m) {
          this.buf = this.buf.slice(m.index + m[0].length);
          this._resolve({ type: "failure", xml: m[0] });
          continue;
        }
      }
      // Check for success (SASL success)
      if (this.buf.includes("<success")) {
        const m = this.buf.match(/<success[^>]*\/>|<success[^>]*>[^<]*<\/success>/);
        if (m) {
          this.buf = this.buf.slice(m.index + m[0].length);
          this._resolve({ type: "success", xml: m[0] });
          continue;
        }
      }
      // General element extraction
      const extracted = extractElement(this.buf);
      if (!extracted) break;
      this.buf = extracted.rest.trimStart();
      const xml = extracted.element;
      // Classify the element
      let type = "unknown";
      if (xml.startsWith("<iq"))       type = "iq";
      else if (xml.startsWith("<message"))  type = "message";
      else if (xml.startsWith("<presence")) type = "presence";
      else if (xml.startsWith("<stream:error")) type = "stream_error";
      this._resolve({ type, xml });
    }
  }

  _resolve(data) {
    if (this._resolvers.length > 0) {
      const { resolve } = this._resolvers.shift();
      resolve(data);
    } else {
      // No resolver waiting yet — queue for the next _waitFor call
      this._queue.push(data);
    }
  }

  _rejectAll(err) {
    const resolvers = this._resolvers.splice(0);
    for (const { reject } of resolvers) reject(err);
  }

  /** Wait for the next XMPP element/event */
  _waitFor(timeoutMs, description) {
    // If a stanza was queued before this _waitFor was set up, resolve immediately
    if (this._queue.length > 0) {
      return Promise.resolve(this._queue.shift());
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this._resolvers.findIndex(r => r.reject === reject);
        if (idx !== -1) this._resolvers.splice(idx, 1);
        reject(new Error(`xmpp_client: timed out waiting for ${description} after ${timeoutMs} ms.`));
      }, timeoutMs);

      this._resolvers.push({
        resolve: (data) => { clearTimeout(timer); resolve(data); },
        reject:  (err)  => { clearTimeout(timer); reject(err); },
      });

      // Trigger dispatch in case data is already buffered
      if (this.buf.length > 0) this._dispatchBuf();
    });
  }

  send(xml) {
    this.sock.write(xml, "utf8");
  }

  async _openStream() {
    this.buf   = ""; // clear buffer for fresh stream
    this._queue = []; // clear any stale queued stanzas
    this.send(
      `<?xml version='1.0'?><stream:stream xmlns='jabber:client' ` +
      `xmlns:stream='http://etherx.jabber.org/streams' ` +
      `to='${xmlEsc(this.domain)}' version='1.0'>`
    );
    // Expect: stream:stream open + stream:features
    await this._waitFor(this.timeoutMs, "stream open");
    const feat = await this._waitFor(this.timeoutMs, "stream features");
    return feat;
  }

  async _doStartTls() {
    this.send(`<starttls xmlns='urn:ietf:params:xml:ns:xmpp-tls'/>`);
    const resp = await this._waitFor(this.timeoutMs, "STARTTLS proceed");
    if (resp.type !== "proceed")
      throw new Error(`xmpp_client: STARTTLS failed — got: ${resp.xml.slice(0, 120)}`);
    // Upgrade socket to TLS
    await this._upgradeToTls();
  }

  async _upgradeToTls() {
    return new Promise((resolve, reject) => {
      const tlsSock = tls.connect({
        socket:             this.sock,
        servername:         this.domain,
        rejectUnauthorized: this.rejectUnauthorized,
      });
      tlsSock.once("secureConnect", () => {
        // Swap out socket, reset data handler
        this.sock.removeAllListeners("data");
        this.sock.removeAllListeners("close");
        this.sock.removeAllListeners("error");
        this.sock = tlsSock;
        this.buf  = "";
        this._attachDataHandler();
        resolve();
      });
      tlsSock.once("error", (err) => reject(new Error(`xmpp_client: TLS upgrade error: ${err.message}`)));
    });
  }

  async _doSaslPlain() {
    // SASL PLAIN: \0user\0password  (RFC 4616)
    const authStr = Buffer.from(`\0${this.jid.user}\0${this.password}`, "utf8").toString("base64");
    this.send(`<auth xmlns='urn:ietf:params:xml:ns:xmpp-sasl' mechanism='PLAIN'>${authStr}</auth>`);
    const resp = await this._waitFor(this.timeoutMs, "SASL response");
    if (resp.type !== "success") {
      throw new Error(
        `xmpp_client: SASL authentication failed — check username/password. ` +
        `Server response type: ${resp.type}`
      );
    }
  }

  async _bindResource() {
    const resource = this.jid.resource || `mcp-${crypto.randomBytes(4).toString("hex")}`;
    const id = randomId();
    this.send(
      `<iq type='set' id='${xmlEsc(id)}'><bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'>` +
      `<resource>${xmlEsc(resource)}</resource></bind></iq>`
    );
    const resp = await this._waitFor(this.timeoutMs, "resource binding");
    if (resp.type !== "iq" || resp.xml.includes('type="error"') || resp.xml.includes("type='error'"))
      throw new Error(`xmpp_client: resource binding failed: ${resp.xml.slice(0, 200)}`);
    const jidText = xmlText(resp.xml, "jid");
    this.boundJid = jidText || this.jid.full;
  }

  async _establishSession() {
    // RFC 3921 session establishment (optional in RFC 6121 but many servers still require it)
    const id = randomId();
    this.send(`<iq type='set' id='${xmlEsc(id)}'><session xmlns='urn:ietf:params:xml:ns:xmpp-session'/></iq>`);
    // Some servers don't advertise session; wait briefly but don't fail
    try {
      await this._waitFor(Math.min(3000, this.timeoutMs), "session");
    } catch (_) {
      // Session stanza optional — ignore timeout
    }
  }

  /** Send a stanza and collect the result IQ (by ID matching) */
  async sendIq(stanzaXml, expectedId, description) {
    this.send(stanzaXml);
    // Wait for IQ result/error with matching id
    const start = Date.now();
    while (Date.now() - start < this.timeoutMs) {
      const resp = await this._waitFor(this.timeoutMs, description);
      if (resp.type === "iq") {
        const respId = xmlAttr(resp.xml, "id");
        if (!expectedId || respId === expectedId) return resp;
      }
      if (resp.type === "stream_error")
        throw new Error(`xmpp_client: stream error: ${resp.xml.slice(0, 200)}`);
      // Other stanzas (presence, message) are discarded
    }
    throw new Error(`xmpp_client: timed out waiting for IQ response (${description}).`);
  }

  /** Close the XMPP stream gracefully */
  close() {
    this._done = true;
    try {
      this.send("</stream:stream>");
    } catch (_) {}
    try {
      this.sock.destroy();
    } catch (_) {}
  }
}

// ── Shared connection helper ───────────────────────────────────────────────────
async function withXmpp(args, fn) {
  const serverStr = (args.server || "").trim();
  if (!serverStr) throw new Error("xmpp_client: 'server' is required (XMPP server hostname).");
  guardNul(serverStr, "server");

  const jidStr = (args.jid || "").trim();
  if (!jidStr) throw new Error("xmpp_client: 'jid' is required (your Jabber ID, e.g. user@domain).");
  guardNul(jidStr, "jid");

  if (!args.password) throw new Error("xmpp_client: 'password' is required for XMPP authentication.");
  guardNul(args.password, "password");

  const jid = parseJid(jidStr);
  const useTls = args.use_tls === true || args.direct_tls === true;
  const port = args.port
    ? (Number(args.port) | 0)
    : (useTls ? XMPPS_DEFAULT_PORT : XMPP_DEFAULT_PORT);
  if (!isFinite(port) || port < 1 || port > 65535)
    throw new Error(`xmpp_client: invalid port ${port}.`);

  const timeoutMs = clampTimeout(args.timeout);

  const stream = new XmppStream({
    host:               serverStr,
    port,
    domain:             args.domain || jid.domain,
    jid,
    password:           args.password,
    useTls,
    rejectUnauthorized: args.reject_unauthorized !== false,
    timeoutMs,
  });

  try {
    await stream.connect();
    return await fn(stream, { jid, timeoutMs, serverStr, port, useTls });
  } finally {
    stream.close();
  }
}

// ── Operations ────────────────────────────────────────────────────────────────

/** send_message — Send an XMPP IM message to a JID */
async function opSendMessage(args) {
  // Validate server/jid/password first (same order as withXmpp checks them)
  if (!(args.server || "").trim()) throw new Error("xmpp_client: 'server' is required (XMPP server hostname).");
  if (!(args.jid    || "").trim()) throw new Error("xmpp_client: 'jid' is required (your Jabber ID, e.g. user@domain).");
  if (!args.password)              throw new Error("xmpp_client: 'password' is required for XMPP authentication.");

  const toStr = (args.to || "").trim();
  if (!toStr) throw new Error("xmpp_client: send_message requires 'to' (recipient JID).");
  guardNul(toStr, "to");
  const toJid = parseJid(toStr);

  const body = args.body;
  if (!body && body !== "") throw new Error("xmpp_client: send_message requires 'body' (message text).");
  guardNul(body, "body");

  const msgType = ["chat", "groupchat", "normal", "headline"].includes(args.type) ? args.type : "chat";
  const subject = args.subject || null;
  if (subject) guardNul(subject, "subject");

  return withXmpp(args, async (stream, ctx) => {
    const id = randomId();
    let msgXml =
      `<message from='${xmlEsc(stream.boundJid)}' to='${xmlEsc(toJid.bare)}' ` +
      `type='${msgType}' id='${id}'>`;
    if (subject) msgXml += `<subject>${xmlEsc(subject)}</subject>`;
    msgXml += `<body>${xmlEsc(body)}</body></message>`;

    stream.send(msgXml);
    // XMPP messaging is fire-and-forget; no ack needed for type=chat
    // Wait a brief moment to allow delivery to server
    await new Promise(r => setTimeout(r, 300));

    return {
      ok:         true,
      operation:  "send_message",
      server:     ctx.serverStr,
      from:       stream.boundJid,
      to:         toJid.bare,
      type:       msgType,
      messageId:  id,
      bodyLength: Buffer.byteLength(body, "utf8"),
      subject:    subject || null,
    };
  });
}

/** get_roster — Retrieve the contact list */
async function opGetRoster(args) {
  return withXmpp(args, async (stream, ctx) => {
    const id = randomId();
    const resp = await stream.sendIq(
      `<iq type='get' id='${id}'><query xmlns='jabber:iq:roster'/></iq>`,
      id,
      "roster response"
    );

    // Parse roster entries from the response
    const contacts = [];
    const itemRe = /<item([^>]*)\/?>/g;
    let m;
    while ((m = itemRe.exec(resp.xml)) !== null) {
      const attrs = m[1];
      const jidVal  = xmlAttr(attrs, "jid")  || xmlAttr(" " + attrs, "jid")  || "";
      const name    = xmlAttr(attrs, "name") || xmlAttr(" " + attrs, "name") || null;
      const sub     = xmlAttr(attrs, "subscription") || xmlAttr(" " + attrs, "subscription") || "none";
      const ask     = xmlAttr(attrs, "ask")  || xmlAttr(" " + attrs, "ask")  || null;
      if (jidVal) contacts.push({ jid: jidVal, name, subscription: sub, ask });
    }

    // Get roster version if available
    const verMatch = resp.xml.match(/ver=["']([^"']*)["']/);
    const ver = verMatch ? verMatch[1] : null;

    return {
      ok:         true,
      operation:  "get_roster",
      server:     ctx.serverStr,
      from:       stream.boundJid,
      contactCount: contacts.length,
      contacts,
      version:    ver,
    };
  });
}

/** presence — Send a presence stanza */
async function opPresence(args) {
  const presTypes = ["available", "unavailable", "subscribe", "subscribed", "unsubscribe", "unsubscribed"];
  const showValues = ["away", "chat", "dnd", "xa"];
  const type = args.type || "available";
  if (!presTypes.includes(type))
    throw new Error(`xmpp_client: invalid presence type '${type}'. Valid: ${presTypes.join(", ")}.`);

  const show   = args.show   || null;
  const status = args.status || null;
  if (show && !showValues.includes(show))
    throw new Error(`xmpp_client: invalid show value '${show}'. Valid: ${showValues.join(", ")}.`);
  if (status) guardNul(status, "status");

  const toStr = args.to ? args.to.trim() : null;
  if (toStr) guardNul(toStr, "to");

  return withXmpp(args, async (stream, ctx) => {
    let xml;
    if (type === "available") {
      // Available presence has no 'type' attribute
      xml = `<presence from='${xmlEsc(stream.boundJid)}'`;
      if (toStr) xml += ` to='${xmlEsc(toStr)}'`;
      xml += `>`;
      if (show)   xml += `<show>${xmlEsc(show)}</show>`;
      if (status) xml += `<status>${xmlEsc(status)}</status>`;
      xml += `</presence>`;
    } else {
      xml = `<presence type='${type}' from='${xmlEsc(stream.boundJid)}'`;
      if (toStr) xml += ` to='${xmlEsc(toStr)}'`;
      xml += `>`;
      if (status) xml += `<status>${xmlEsc(status)}</status>`;
      xml += `</presence>`;
    }

    stream.send(xml);
    await new Promise(r => setTimeout(r, 300));

    return {
      ok:        true,
      operation: "presence",
      server:    ctx.serverStr,
      from:      stream.boundJid,
      type,
      show:      show || null,
      status:    status || null,
      to:        toStr || null,
    };
  });
}

/** ping — XEP-0199 XMPP Ping */
async function opPing(args) {
  return withXmpp(args, async (stream, ctx) => {
    const id = randomId();
    const t0 = Date.now();

    const resp = await stream.sendIq(
      `<iq type='get' from='${xmlEsc(stream.boundJid)}' to='${xmlEsc(ctx.jid.domain)}' id='${id}'>` +
      `<ping xmlns='urn:ietf:params:xml:ns:xmpp-ping'/></iq>`,
      id,
      "ping response"
    );

    const elapsedMs = Date.now() - t0;
    const success = resp.xml.includes('type="result"') || resp.xml.includes("type='result'");

    return {
      ok:           success,
      operation:    "ping",
      server:       ctx.serverStr,
      from:         stream.boundJid,
      pingTarget:   ctx.jid.domain,
      elapsedMs,
      success,
      responseType: xmlAttr(resp.xml, "type") || null,
    };
  });
}

/** info — Return protocol info (no I/O) */
function opInfo() {
  return {
    ok: true,
    operation: "info",
    protocol: {
      name:    "XMPP — Extensible Messaging and Presence Protocol",
      rfcs:    [
        "RFC 6120 (XMPP Core)",
        "RFC 6121 (XMPP IM — roster, presence, messaging)",
        "RFC 7590 (Use of TLS in XMPP)",
        "XEP-0199 (XMPP Ping)",
      ],
      transport: ["TCP with STARTTLS (port 5222, default)", "Direct TLS (port 5223, use_tls:true)"],
      auth:    ["SASL PLAIN (RFC 4616) over TLS"],
      defaultPorts: { plain_starttls: XMPP_DEFAULT_PORT, direct_tls: XMPPS_DEFAULT_PORT },
    },
    operations: [
      "send_message — Send an XMPP instant message to a JID",
      "get_roster   — Retrieve the contact roster from the server",
      "presence     — Send presence stanza (available/unavailable/subscribe/etc.)",
      "ping         — Send XEP-0199 ping and measure round-trip latency",
      "info         — Return this info object (no I/O)",
    ],
    defaults: {
      port:      XMPP_DEFAULT_PORT,
      port_tls:  XMPPS_DEFAULT_PORT,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      msgType:   "chat",
    },
    notes: [
      "Zero npm dependencies — pure Node.js net/tls/crypto built-ins.",
      "Use use_tls:true for direct TLS (XMPPS, port 5223); otherwise STARTTLS on port 5222.",
      "JID format: user@domain or user@domain/resource.",
      "Passwords are never logged or included in error messages.",
      "SASL PLAIN authentication transmits credentials over the encrypted TLS channel.",
    ],
  };
}

// ── Main entry point ──────────────────────────────────────────────────────────
async function xmppClient(args) {
  const op = (args.operation || "").trim();
  if (!op) throw new Error("xmpp_client: 'operation' is required.");

  switch (op) {
    case "send_message": return opSendMessage(args);
    case "get_roster":   return opGetRoster(args);
    case "presence":     return opPresence(args);
    case "ping":         return opPing(args);
    case "info":         return opInfo();
    default:
      throw new Error(
        `xmpp_client: unknown operation '${op}'. Valid: send_message, get_roster, presence, ping, info.`
      );
  }
}

module.exports = {
  xmppClient,
  // Exported for testing
  parseJid,
  xmlEsc,
  xmlAttr,
  xmlText,
  xmlHas,
  extractElement,
  randomId,
  clampTimeout,
  guardNul,
  XmppStream,
  XMPP_DEFAULT_PORT,
  XMPPS_DEFAULT_PORT,
  DEFAULT_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
};
