"use strict";
/**
 * Section 260 — xmpp_client tests
 *
 * Five rigor levels:
 *   A  Pure-helper / unit functions          (x40)
 *   B  Input validation                      (x15)
 *   C  Mock-network (loopback TCP)           (x13)
 *   D  Security / injection guards           (x10)
 *   E  Concurrency / stress                  (x8)
 *
 * Total: 86 tests
 */

const assert = require("assert");
const net    = require("net");
const tls    = require("tls");
const crypto = require("crypto");

const {
  xmppClient,
  parseJid,
  xmlEsc,
  xmlAttr,
  xmlText,
  xmlHas,
  extractElement,
  randomId,
  clampTimeout,
  guardNul,
  XMPP_DEFAULT_PORT,
  XMPPS_DEFAULT_PORT,
  DEFAULT_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
} = require("../../lib/xmppClientOps");

let passed = 0;
let failed = 0;
const errors = [];

function ok(cond, label) {
  if (cond) {
    passed++;
  } else {
    failed++;
    errors.push(label);
    process.stderr.write(`  FAIL: ${label}\n`);
  }
}

async function rejects(fn, pattern, label) {
  try {
    await fn();
    failed++;
    errors.push(`${label} (expected rejection, got none)`);
    process.stderr.write(`  FAIL: ${label} (expected rejection, got none)\n`);
  } catch (e) {
    const m = typeof pattern === "string"
      ? e.message.toLowerCase().includes(pattern.toLowerCase())
      : pattern.test(e.message);
    if (m) {
      passed++;
    } else {
      failed++;
      errors.push(`${label} (msg: ${e.message})`);
      process.stderr.write(`  FAIL: ${label} — got: ${e.message}\n`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock XMPP Server Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the canonical XMPP server greeting sequence:
 *   1. <?xml ...><stream:stream ...> header
 *   2. <stream:features> with starttls or sasl mechanisms
 */
function buildStreamOpen(domain) {
  return (
    `<?xml version='1.0'?><stream:stream xmlns='jabber:client' ` +
    `xmlns:stream='http://etherx.jabber.org/streams' ` +
    `from='${domain}' id='mocksession' version='1.0'>`
  );
}

function buildFeaturesSasl() {
  return (
    `<stream:features>` +
    `<mechanisms xmlns='urn:ietf:params:xml:ns:xmpp-sasl'>` +
    `<mechanism>PLAIN</mechanism>` +
    `</mechanisms>` +
    `</stream:features>`
  );
}

function buildFeaturesStartTls() {
  return (
    `<stream:features>` +
    `<starttls xmlns='urn:ietf:params:xml:ns:xmpp-tls'><required/></starttls>` +
    `</stream:features>`
  );
}

function buildSaslSuccess() {
  return `<success xmlns='urn:ietf:params:xml:ns:xmpp-sasl'/>`;
}

function buildSaslFailure() {
  return (
    `<failure xmlns='urn:ietf:params:xml:ns:xmpp-sasl'>` +
    `<not-authorized/>` +
    `</failure>`
  );
}

function buildBindResult(jid) {
  return (
    `<iq type='result' id='bind1'>` +
    `<bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'>` +
    `<jid>${jid}</jid>` +
    `</bind>` +
    `</iq>`
  );
}

function buildSessionResult() {
  return `<iq type='result' id='sess1'/>`;
}

function buildPingResult(id) {
  return `<iq type='result' id='${id}'/>`;
}

function buildRosterResult() {
  return (
    `<iq type='result' id='roster1'>` +
    `<query xmlns='jabber:iq:roster'>` +
    `<item jid='bob@example.com' name='Bob' subscription='both'/>` +
    `<item jid='carol@example.com' subscription='from'/>` +
    `</query>` +
    `</iq>`
  );
}

/**
 * Start a mock XMPP TCP server that handles the full PLAIN-over-STARTTLS-skipping
 * handshake by offering SASL directly (no real STARTTLS — client must use use_tls:false
 * and we fake that features offers SASL without TLS requirement).
 *
 * Flow:
 *   Server → stream:open + features(SASL PLAIN)
 *   Client → <auth ...>.....</auth>
 *   Server → <success/>
 *   Client → stream:open  (re-opened after SASL)
 *   Server → stream:open + features(bind)
 *   Client → <iq type='set'><bind>...</bind></iq>
 *   Server → <iq type='result'><bind><jid>...</jid></bind></iq>
 *   Client → <iq type='set'><session.../></iq>   (optional)
 *   Server → <iq type='result'/>  (optional)
 *   ... then fn(socket) gets called with whatever extra stanzas needed
 */
function startMockXmppServer(responseBuilder) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((sock) => {
      const domain = "example.com";
      let buf = "";
      let phase = "stream_open_1";

      sock.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        handleData();
      });

      function handleData() {
        switch (phase) {
          case "stream_open_1":
            if (buf.includes("<stream:stream")) {
              buf = "";
              phase = "auth";
              // Send stream open + SASL features (no TLS requirement)
              sock.write(
                buildStreamOpen(domain) +
                `<stream:features>` +
                `<mechanisms xmlns='urn:ietf:params:xml:ns:xmpp-sasl'>` +
                `<mechanism>PLAIN</mechanism>` +
                `</mechanisms>` +
                `</stream:features>`
              );
            }
            break;

          case "auth":
            if (buf.includes("<auth")) {
              buf = "";
              phase = "stream_open_2";
              sock.write(buildSaslSuccess());
            }
            break;

          case "stream_open_2":
            if (buf.includes("<stream:stream")) {
              buf = "";
              phase = "bind";
              sock.write(
                buildStreamOpen(domain) +
                `<stream:features>` +
                `<bind xmlns='urn:ietf:params:xml:ns:xmpp-bind'/>` +
                `<session xmlns='urn:ietf:params:xml:ns:xmpp-session'/>` +
                `</stream:features>`
              );
            }
            break;

          case "bind":
            if (buf.includes("<bind")) {
              const idMatch = buf.match(/id='([^']*)'/);
              const id = idMatch ? idMatch[1] : "bind1";
              buf = "";
              phase = "session";
              sock.write(buildBindResult(`alice@${domain}/mcp-test`).replace("id='bind1'", `id='${id}'`));
            }
            break;

          case "session":
            if (buf.includes("<session") || buf.includes("</stream:stream>")) {
              const idMatch = buf.match(/id='([^']*)'/);
              const id = idMatch ? idMatch[1] : "sess1";
              buf = "";
              phase = "ready";
              sock.write(`<iq type='result' id='${id}'/>`);
              // Call the per-test response builder
              responseBuilder(sock, buf, () => {});
            }
            break;

          case "ready":
            // Hand off to per-test builder for any additional stanzas
            responseBuilder(sock, buf, () => {});
            break;
        }
      }

      sock.on("error", () => {});
    });

    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function closeServer(server) {
  return new Promise(r => server.close(r));
}

// ─────────────────────────────────────────────────────────────────────────────
// Test runner
// ─────────────────────────────────────────────────────────────────────────────
async function runAll() {

  // =========================================================================
  // A — Pure helpers / unit (40 tests)
  // =========================================================================

  // parseJid
  {
    const j = parseJid("alice@example.com");
    ok(j.user   === "alice",       "A01: user parsed");
    ok(j.domain === "example.com", "A02: domain parsed");
    ok(j.resource === null,        "A03: no resource");
    ok(j.bare  === "alice@example.com", "A04: bare JID");
    ok(j.full  === "alice@example.com", "A05: full JID same as bare");
  }

  {
    const j = parseJid("bob@jabber.org/phone");
    ok(j.user     === "bob",         "A06: user with resource");
    ok(j.domain   === "jabber.org",  "A07: domain with resource");
    ok(j.resource === "phone",       "A08: resource parsed");
    ok(j.full === "bob@jabber.org/phone", "A09: full JID");
  }

  {
    let threw = false;
    try { parseJid(""); } catch (e) { threw = /non-empty/i.test(e.message) || e.message.includes("JID"); }
    ok(threw, "A10: empty string throws");
  }

  {
    let threw = false;
    try { parseJid("nodomain"); } catch (e) { threw = /user@domain/i.test(e.message) || /JID/i.test(e.message); }
    ok(threw, "A11: no @ throws");
  }

  {
    let threw = false;
    try { parseJid("@nodomain"); } catch (e) { threw = /localpart|user/i.test(e.message); }
    ok(threw, "A12: missing localpart throws");
  }

  {
    let threw = false;
    try { parseJid("user@"); } catch (e) { threw = /domain/i.test(e.message); }
    ok(threw, "A13: missing domain throws");
  }

  // xmlEsc
  ok(xmlEsc("<b>Hello & 'World'</b>") === "&lt;b&gt;Hello &amp; &apos;World&apos;&lt;/b&gt;", "A14: xmlEsc all specials");
  ok(xmlEsc('say "hi"') === 'say &quot;hi&quot;', "A15: xmlEsc double quote");
  ok(xmlEsc("clean") === "clean", "A16: xmlEsc clean passthrough");
  ok(xmlEsc("") === "", "A17: xmlEsc empty");

  // xmlAttr
  {
    const xml = `<iq type="result" id='abc123'/>`;
    ok(xmlAttr(xml, "type") === "result", "A18: xmlAttr double-quote");
    ok(xmlAttr(xml, "id")   === "abc123", "A19: xmlAttr single-quote");
    ok(xmlAttr(xml, "from") === null,     "A20: xmlAttr missing → null");
  }

  // xmlText
  {
    const xml = `<iq><bind xmlns='...'><jid>alice@example.com/res</jid></bind></iq>`;
    ok(xmlText(xml, "jid") === "alice@example.com/res", "A21: xmlText extracts content");
    ok(xmlText(xml, "missing") === null,                "A22: xmlText missing → null");
  }

  // xmlHas
  ok(xmlHas(`<features><bind/></features>`, "bind"), "A23: xmlHas self-closing");
  ok(xmlHas(`<features><session/></features>`, "session"), "A24: xmlHas session");
  ok(!xmlHas(`<features/>`, "bind"), "A25: xmlHas absent → false");

  // extractElement
  {
    const r = extractElement("<iq type='result'/> extra");
    ok(r !== null, "A26: extractElement self-closing");
    ok(r.element === "<iq type='result'/>", "A27: extractElement element correct");
    ok(r.rest === " extra", "A28: extractElement rest correct");
  }

  {
    const xml = `<iq type='result'><bind><jid>a@b</jid></bind></iq>`;
    const r = extractElement(xml + "<next/>");
    ok(r !== null,                "A29: extractElement nested element");
    ok(r.element === xml,         "A30: extractElement nested element correct");
    ok(r.rest    === "<next/>",   "A31: extractElement nested rest correct");
  }

  {
    ok(extractElement("") === null, "A32: extractElement empty → null");
    ok(extractElement("<partial") === null, "A33: extractElement incomplete → null");
  }

  // randomId
  {
    const id1 = randomId();
    const id2 = randomId();
    ok(id1.startsWith("mcp"),   "A34: randomId prefix");
    ok(id1.length > 3,          "A35: randomId has content");
    ok(id1 !== id2,             "A36: randomId unique");
  }

  // clampTimeout
  ok(clampTimeout(0)         === 2_000,              "A37: clamp below min → 2000");
  ok(clampTimeout(999_999)   === 60_000,             "A38: clamp above max → 60000");
  ok(clampTimeout(10_000)    === 10_000,             "A39: within range unchanged");
  ok(clampTimeout(undefined) === DEFAULT_TIMEOUT_MS, "A40: undefined → default");

  // Constants sanity check
  ok(XMPP_DEFAULT_PORT  === 5222, "A41: default STARTTLS port");
  ok(XMPPS_DEFAULT_PORT === 5223, "A42: default direct TLS port");
  ok(DEFAULT_TIMEOUT_MS === 10_000, "A43: default timeout 10s");
  ok(MAX_RESPONSE_BYTES === 512 * 1024, "A44: response cap 512 KB");

  // =========================================================================
  // B — Input validation (15 tests)
  // =========================================================================

  await rejects(() => xmppClient({}),                                                        "operation",  "B01: missing operation");
  await rejects(() => xmppClient({ operation: "teleport" }),                                 "unknown",    "B02: unknown operation");
  await rejects(() => xmppClient({ operation: "send_message" }),                             "server",     "B03: send_message missing server");
  await rejects(() => xmppClient({ operation: "send_message", server: "x.com" }),            "jid",        "B04: send_message missing jid");
  await rejects(() => xmppClient({ operation: "send_message", server: "x.com", jid: "a@b" }), "password", "B05: send_message missing password");
  await rejects(() => xmppClient({ operation: "send_message", server: "x.com", jid: "a@b", password: "p" }), "to", "B06: send_message missing to");
  await rejects(() => xmppClient({ operation: "send_message", server: "x.com", jid: "a@b", password: "p", to: "b@x" }), "body", "B07: send_message missing body");

  {
    let threw = false;
    try { parseJid(""); } catch (e) { threw = true; }
    ok(threw, "B08: empty JID throws");
  }

  {
    let threw = false;
    try { parseJid("nodomain"); } catch (e) { threw = true; }
    ok(threw, "B09: no @ JID throws");
  }

  ok(clampTimeout(-1000)  === 2_000,  "B10: negative clamped to min");
  ok(clampTimeout(999999) === 60_000, "B11: huge clamped to max");
  ok(clampTimeout("text") === DEFAULT_TIMEOUT_MS, "B12: non-number → default");

  {
    let t1 = false, t2 = false;
    try { guardNul("a\0b", "f"); } catch (e) { t1 = /NUL/i.test(e.message); }
    try { guardNul("clean", "f"); t2 = true; } catch (_) {}
    ok(t1 && t2, "B13: guardNul correct");
  }

  {
    let threw = false;
    try { parseJid(null); } catch (e) { threw = true; }
    ok(threw, "B14: null JID throws");
  }

  {
    const j = parseJid("u@d/res/with/slashes");
    ok(j.resource === "res/with/slashes", "B15: resource allows slashes");
  }

  // =========================================================================
  // C — Mock network (13 tests)
  // =========================================================================

  // C01 — info operation (no I/O)
  {
    const r = await xmppClient({ operation: "info" });
    ok(r.ok === true,                           "C01: info ok");
    ok(r.operation === "info",                  "C02: info operation");
    ok(Array.isArray(r.protocol.rfcs),          "C03: protocol.rfcs array");
    ok(r.protocol.rfcs.some(s => s.includes("6120")), "C04: RFC 6120 listed");
    ok(Array.isArray(r.operations),             "C05: operations array");
    ok(r.operations.some(s => s.includes("send_message")), "C06: send_message listed");
    ok(r.defaults.port === XMPP_DEFAULT_PORT,   "C07: default port correct");
  }

  // C08 — send_message mock network test
  {
    let msgReceived = false;
    const { server, port } = await startMockXmppServer((sock, buf) => {
      // The client sends send_message stanza after session; server just waits
      // We watch for it in subsequent data events
      sock.on("data", (chunk) => {
        const data = chunk.toString("utf8");
        if (data.includes("<message") && data.includes("<body>")) {
          msgReceived = true;
        }
      });
    });
    try {
      const r = await xmppClient({
        operation: "send_message",
        server:    "127.0.0.1",
        port,
        jid:       "alice@example.com",
        password:  "secret",
        to:        "bob@example.com",
        body:      "Hello XMPP!",
        timeout:   5_000,
      });
      ok(r.ok === true,            "C08: send_message ok");
      ok(r.operation === "send_message", "C09: operation field");
      ok(r.to === "bob@example.com",     "C10: to field");
      ok(r.bodyLength > 0,               "C11: bodyLength > 0");
    } finally {
      await closeServer(server);
    }
  }

  // C12 — get_roster mock test
  {
    const { server, port } = await startMockXmppServer((sock) => {
      sock.on("data", (chunk) => {
        const data = chunk.toString("utf8");
        if (data.includes("jabber:iq:roster")) {
          const idMatch = data.match(/id='([^']*)'/);
          const id = idMatch ? idMatch[1] : "roster1";
          sock.write(buildRosterResult().replace("id='roster1'", `id='${id}'`));
        }
      });
    });
    try {
      const r = await xmppClient({
        operation: "get_roster",
        server:    "127.0.0.1",
        port,
        jid:       "alice@example.com",
        password:  "secret",
        timeout:   5_000,
      });
      ok(r.ok === true,              "C12: get_roster ok");
      ok(r.contactCount === 2,       "C13: 2 contacts");
    } finally {
      await closeServer(server);
    }
  }

  // C14 — ping mock test
  {
    const { server, port } = await startMockXmppServer((sock) => {
      sock.on("data", (chunk) => {
        const data = chunk.toString("utf8");
        if (data.includes("xmpp-ping")) {
          const idMatch = data.match(/id='([^']*)'/);
          const id = idMatch ? idMatch[1] : "ping1";
          sock.write(`<iq type='result' id='${id}'/>`);
        }
      });
    });
    try {
      const r = await xmppClient({
        operation: "ping",
        server:    "127.0.0.1",
        port,
        jid:       "alice@example.com",
        password:  "secret",
        timeout:   5_000,
      });
      ok(r.ok === true,         "C14: ping ok");
      ok(r.success === true,    "C15: ping success");
      ok(r.elapsedMs >= 0,      "C16: elapsedMs non-negative");
    } finally {
      await closeServer(server);
    }
  }

  // C17 — presence mock test
  {
    let presenceReceived = false;
    const { server, port } = await startMockXmppServer((sock) => {
      sock.on("data", (chunk) => {
        const data = chunk.toString("utf8");
        if (data.includes("<presence")) presenceReceived = true;
      });
    });
    try {
      const r = await xmppClient({
        operation: "presence",
        server:    "127.0.0.1",
        port,
        jid:       "alice@example.com",
        password:  "secret",
        type:      "available",
        show:      "away",
        status:    "In a meeting",
        timeout:   5_000,
      });
      ok(r.ok === true,           "C17: presence ok");
      ok(r.type === "available",  "C18: presence type");
      ok(r.show === "away",       "C19: presence show");
      ok(r.status === "In a meeting", "C20: presence status");
    } finally {
      await closeServer(server);
    }
  }

  // =========================================================================
  // D — Security / injection guards (10 tests)
  // =========================================================================

  await rejects(
    () => xmppClient({ operation: "send_message", server: "host\0bad", jid: "a@b", password: "p", to: "c@d", body: "x" }),
    "NUL", "D01: NUL in server"
  );
  await rejects(
    () => xmppClient({ operation: "send_message", server: "host", jid: "a\0b@c", password: "p", to: "d@e", body: "x" }),
    "NUL", "D02: NUL in jid"
  );
  await rejects(
    () => xmppClient({ operation: "send_message", server: "host", jid: "a@b", password: "p\0w", to: "c@d", body: "x" }),
    "NUL", "D03: NUL in password"
  );
  await rejects(
    () => xmppClient({ operation: "send_message", server: "host", jid: "a@b", password: "p", to: "c\0@d", body: "x" }),
    "NUL", "D04: NUL in to"
  );
  await rejects(
    () => xmppClient({ operation: "send_message", server: "host", jid: "a@b", password: "p", to: "c@d", body: "x\0y" }),
    "NUL", "D05: NUL in body"
  );

  {
    // xmlEsc prevents injection of XML tags in stanzas
    const escaped = xmlEsc('<script>alert("xss")</script>');
    ok(!escaped.includes("<script>"),   "D06: xmlEsc prevents tag injection");
    ok(escaped.includes("&lt;script"),  "D07: xmlEsc encodes <");
  }

  {
    // NUL in status should throw
    let threw = false;
    try {
      await xmppClient({
        operation: "presence",
        server: "host", jid: "a@b", password: "p",
        status: "bad\0status",
      });
    } catch (e) { threw = /NUL/i.test(e.message); }
    ok(threw, "D08: NUL in status throws");
  }

  ok(clampTimeout(-9999) === 2_000,  "D09: negative timeout clamped to min");
  ok(clampTimeout(999999) === 60_000, "D10: huge timeout clamped to max");

  // =========================================================================
  // E — Concurrency / stress (8 tests)
  // =========================================================================

  // E01 — parallel info x20
  {
    const results = await Promise.all(Array.from({ length: 20 }, () => xmppClient({ operation: "info" })));
    ok(results.length === 20 && results.every(r => r.ok), "E01: 20 parallel info calls");
  }

  // E02 — randomId uniqueness x500
  {
    const ids = new Set(Array.from({ length: 500 }, randomId));
    ok(ids.size === 500, "E02: 500 unique IDs");
  }

  // E03 — parseJid under load x500
  {
    let allOk = true;
    for (let i = 0; i < 500; i++) {
      const j = parseJid(`user${i}@domain${i}.example.com/res${i}`);
      if (j.user !== `user${i}` || j.domain !== `domain${i}.example.com` || j.resource !== `res${i}`) {
        allOk = false; break;
      }
    }
    ok(allOk, "E03: parseJid x500 load test");
  }

  // E04 — xmlEsc under load x500
  {
    let allOk = true;
    for (let i = 0; i < 500; i++) {
      const s = `<msg${i}>&'"</msg${i}>`;
      const esc = xmlEsc(s);
      if (!esc.includes("&lt;") || !esc.includes("&amp;")) { allOk = false; break; }
    }
    ok(allOk, "E04: xmlEsc x500 load test");
  }

  // E05 — extractElement under load x200
  {
    let allOk = true;
    for (let i = 0; i < 200; i++) {
      const xml = `<iq id='${i}' type='result'><body>text${i}</body></iq>`;
      const r = extractElement(xml + "<next/>");
      if (!r || r.element !== xml) { allOk = false; break; }
    }
    ok(allOk, "E05: extractElement x200 load test");
  }

  // E06 — parallel info x50
  {
    const results = await Promise.all(Array.from({ length: 50 }, () => xmppClient({ operation: "info" })));
    ok(results.every(r => r.ok), "E06: 50 parallel info calls");
  }

  // E07 — clampTimeout stability
  {
    let allOk = true;
    const vals = [0, -1, 2000, 5000, 10000, 60000, 99999, NaN, Infinity, -Infinity, undefined, null, "str"];
    for (const v of vals) {
      const t = clampTimeout(v);
      if (t < 2_000 || t > 60_000) { allOk = false; break; }
    }
    ok(allOk, "E07: clampTimeout always in [2000,60000]");
  }

  // E08 — randomId x100 all unique and start with 'mcp'
  {
    const ids = Array.from({ length: 100 }, randomId);
    ok(
      ids.every(id => id.startsWith("mcp")) && new Set(ids).size === 100,
      "E08: randomId x100 unique and prefixed"
    );
  }

  // =========================================================================
  // Summary
  // =========================================================================
  process.stderr.write(`\n260-xmpp-client: ${passed}/${passed + failed} tests passed\n`);
  if (errors.length) {
    process.stderr.write("FAILURES:\n");
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
    process.exit(1);
  }
}

runAll().catch(err => {
  process.stderr.write(`Unexpected error: ${err.stack || err}\n`);
  process.exit(1);
});
