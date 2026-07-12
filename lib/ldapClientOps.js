"use strict";
// ── ldap_client: zero-dep LDAP v3 client ─────────────────────────────────────
// Pure Node.js net/tls — no npm dependencies.
// Implements RFC 4511 (LDAPv3) with BER (Basic Encoding Rules) codec.
// Compatible with: OpenLDAP, Active Directory, FreeIPA, 389 Directory Server,
//                  Oracle Directory Server, Apache Directory Server, Novell eDirectory
//
// Operations: bind, search, add, modify, delete, compare, whoami, unbind
//
// Protocol reference: https://www.rfc-editor.org/rfc/rfc4511

const net = require("net");
const tls = require("tls");
const { ToolError } = require("./errors");

// ── Constants ────────────────────────────────────────────────────────────────
const DEFAULT_PORT       = 389;
const DEFAULT_TLS_PORT   = 636;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CONN_TO_MS = 10_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024; // 8 MB
const MAX_DN_LEN         = 1024;
const MAX_ATTR_LEN       = 8192;

// ── LDAP Result Codes ────────────────────────────────────────────────────────
const RESULT_CODES = {
  0:  "success",
  1:  "operationsError",
  2:  "protocolError",
  3:  "timeLimitExceeded",
  4:  "sizeLimitExceeded",
  7:  "authMethodNotSupported",
  8:  "strongerAuthRequired",
  10: "referral",
  11: "adminLimitExceeded",
  16: "noSuchAttribute",
  17: "undefinedAttributeType",
  18: "inappropriateMatching",
  19: "constraintViolation",
  20: "attributeOrValueExists",
  21: "invalidAttributeSyntax",
  32: "noSuchObject",
  33: "aliasProblem",
  34: "invalidDNSyntax",
  48: "inappropriateAuthentication",
  49: "invalidCredentials",
  50: "insufficientAccessRights",
  51: "busy",
  52: "unavailable",
  53: "unwillingToPerform",
  54: "loopDetect",
  64: "namingViolation",
  65: "objectClassViolation",
  66: "notAllowedOnNonLeaf",
  67: "notAllowedOnRDN",
  68: "entryAlreadyExists",
  69: "objectClassModsProhibited",
  80: "other",
};

// ── BER Tags ─────────────────────────────────────────────────────────────────
const TAG = {
  // Universal primitive
  BOOLEAN:         0x01,
  INTEGER:         0x02,
  OCTET_STRING:    0x04,
  NULL:            0x05,
  ENUMERATED:      0x0A,
  // Universal constructed
  SEQUENCE:        0x30,
  SET:             0x31,
  // LDAP Application tags (constructed unless noted)
  BIND_REQUEST:         0x60, // [Application 0]
  BIND_RESPONSE:        0x61, // [Application 1]
  UNBIND_REQUEST:       0x42, // [Application 2] primitive
  SEARCH_REQUEST:       0x63, // [Application 3]
  SEARCH_RESULT_ENTRY:  0x64, // [Application 4]
  SEARCH_RESULT_DONE:   0x65, // [Application 5]
  MODIFY_REQUEST:       0x66, // [Application 6]
  MODIFY_RESPONSE:      0x67, // [Application 7]
  ADD_REQUEST:          0x68, // [Application 8]
  ADD_RESPONSE:         0x69, // [Application 9]
  DELETE_REQUEST:       0x4A, // [Application 10] primitive
  DELETE_RESPONSE:      0x6B, // [Application 11]
  COMPARE_REQUEST:      0x6E, // [Application 14]
  COMPARE_RESPONSE:     0x6F, // [Application 15]
  EXTENDED_REQUEST:     0x77, // [Application 23]
  EXTENDED_RESPONSE:    0x78, // [Application 24]
  // Context-specific
  CTX_0:  0x80, // primitive
  CTX_0C: 0xA0, // constructed
  CTX_1:  0x81, // primitive
  CTX_1C: 0xA1, // constructed
  CTX_2:  0x82, // primitive
  CTX_2C: 0xA2, // constructed
  CTX_3:  0x83, // primitive
  CTX_3C: 0xA3, // constructed — AND filter
  CTX_4C: 0xA4, // constructed — OR filter  (actually A4)
  CTX_5:  0x85, // primitive
  CTX_6:  0x86, // primitive
  CTX_7:  0x87, // primitive — present filter
  CTX_8C: 0xA8, // constructed — approx filter
  CTX_9:  0x89, // primitive
};

// ── BER Encoder ──────────────────────────────────────────────────────────────

function berLength(len) {
  if (len < 0x80) return Buffer.from([len]);
  if (len <= 0xFF) return Buffer.from([0x81, len]);
  if (len <= 0xFFFF) return Buffer.from([0x82, (len >> 8) & 0xFF, len & 0xFF]);
  if (len <= 0xFFFFFF) return Buffer.from([0x83, (len >> 16) & 0xFF, (len >> 8) & 0xFF, len & 0xFF]);
  return Buffer.from([0x84, (len >>> 24) & 0xFF, (len >> 16) & 0xFF, (len >> 8) & 0xFF, len & 0xFF]);
}

function berTLV(tag, value) {
  const v = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([Buffer.from([tag]), berLength(v.length), v]);
}

function berInt(n) {
  // Encode integer as minimal BER signed bytes
  if (n === 0) return berTLV(TAG.INTEGER, Buffer.from([0x00]));
  const bytes = [];
  let v = n < 0 ? ~(-n - 1) : n;
  if (n < 0) {
    let neg = (-n);
    let carry = 1;
    const bts = [];
    while (neg > 0) { const b = (neg & 0xFF); bts.unshift(b); neg >>= 8; }
    for (let i = bts.length - 1; i >= 0; i--) { let b = (~bts[i] & 0xFF) + carry; carry = b > 0xFF ? 1 : 0; bytes.unshift(b & 0xFF); }
    if (!(bytes[0] & 0x80)) bytes.unshift(0xFF);
  } else {
    while (v > 0) { bytes.unshift(v & 0xFF); v >>= 8; }
    if (bytes[0] & 0x80) bytes.unshift(0x00);
  }
  return berTLV(TAG.INTEGER, Buffer.from(bytes));
}

function berEnum(n) {
  const raw = berInt(n);
  // Replace INTEGER tag with ENUMERATED
  const buf = Buffer.from(raw);
  buf[0] = TAG.ENUMERATED;
  return buf;
}

function berOctetString(str, encoding) {
  const buf = Buffer.isBuffer(str) ? str :
              (encoding ? Buffer.from(str, encoding) : Buffer.from(str, "utf8"));
  return berTLV(TAG.OCTET_STRING, buf);
}

function berBoolean(b) {
  return berTLV(TAG.BOOLEAN, Buffer.from([b ? 0xFF : 0x00]));
}

function berSequence(items) {
  return berTLV(TAG.SEQUENCE, Buffer.concat(items.map(i => Buffer.isBuffer(i) ? i : Buffer.from(i))));
}

function berSet(items) {
  return berTLV(TAG.SET, Buffer.concat(items.map(i => Buffer.isBuffer(i) ? i : Buffer.from(i))));
}

function berCtx(tag, value) {
  return berTLV(tag, Buffer.isBuffer(value) ? value : Buffer.from(value));
}

// ── LDAP Message Builder ──────────────────────────────────────────────────────

let _msgId = 0;
function nextMsgId() { return ++_msgId; }

function ldapMessage(msgId, protocolOp) {
  // LDAPMessage ::= SEQUENCE { messageID MessageID, protocolOp CHOICE { ... } }
  return berSequence([berInt(msgId), protocolOp]);
}

// ── LDAP Search Filter BER Encoder ───────────────────────────────────────────
// Parses RFC 4515 LDAP search filter strings into BER

function encodeFilter(filter) {
  if (!filter || filter === "(objectClass=*)") {
    // Present filter: [7] attr
    return berCtx(TAG.CTX_7, Buffer.from("objectClass", "utf8"));
  }

  const f = filter.trim();

  // Strip outer parens
  if (f.startsWith("(") && f.endsWith(")")) {
    const inner = f.slice(1, -1).trim();

    // AND: (&(f1)(f2)...)
    if (inner.startsWith("&")) {
      const subs = parseSubFilters(inner.slice(1));
      return berCtx(0xA0, Buffer.concat(subs.map(encodeFilter)));
    }
    // OR: (|(f1)(f2)...)
    if (inner.startsWith("|")) {
      const subs = parseSubFilters(inner.slice(1));
      return berCtx(0xA1, Buffer.concat(subs.map(encodeFilter)));
    }
    // NOT: (!(f1))
    if (inner.startsWith("!")) {
      const subs = parseSubFilters(inner.slice(1));
      return berCtx(0xA2, encodeFilter(subs[0]));
    }

    // Leaf filter
    return encodeLeafFilter(inner);
  }

  // Bare filter (no parens)
  return encodeLeafFilter(f);
}

function parseSubFilters(s) {
  const results = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") {
      if (depth === 0) start = i;
      depth++;
    } else if (s[i] === ")") {
      depth--;
      if (depth === 0 && start !== -1) {
        results.push(s.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return results;
}

function encodeLeafFilter(inner) {
  // Present: attr=*
  const presMatch = inner.match(/^([^=<>~]+)=\*$/);
  if (presMatch) {
    return berCtx(TAG.CTX_7, Buffer.from(presMatch[1], "utf8"));
  }

  // Approximate: attr~=value
  const approxMatch = inner.match(/^([^~]+)~=(.*)$/);
  if (approxMatch) {
    return berCtx(0xA8, Buffer.concat([
      berOctetString(approxMatch[1]),
      berOctetString(approxMatch[2]),
    ]));
  }

  // GreaterOrEqual: attr>=value [3]
  const geMatch = inner.match(/^([^>]+)>=(.*)$/);
  if (geMatch) {
    return berCtx(0xA5, Buffer.concat([
      berOctetString(geMatch[1]),
      berOctetString(geMatch[2]),
    ]));
  }

  // LessOrEqual: attr<=value [6]
  const leMatch = inner.match(/^([^<]+)<=(.*)$/);
  if (leMatch) {
    return berCtx(0xA6, Buffer.concat([
      berOctetString(leMatch[1]),
      berOctetString(leMatch[2]),
    ]));
  }

  // Equality or Substring: attr=value or attr=*val* or attr=val*
  const eqMatch = inner.match(/^([^=]+)=(.*)$/);
  if (eqMatch) {
    const attr = eqMatch[1];
    const val  = eqMatch[2];
    if (val.includes("*")) {
      // Substring filter [4]
      const parts = val.split("*");
      const subs = [];
      if (parts[0]) subs.push(berCtx(0x80, Buffer.from(parts[0], "utf8")));
      for (let i = 1; i < parts.length - 1; i++) {
        if (parts[i]) subs.push(berCtx(0x81, Buffer.from(parts[i], "utf8")));
      }
      if (parts[parts.length - 1]) subs.push(berCtx(0x82, Buffer.from(parts[parts.length - 1], "utf8")));
      return berCtx(0xA4, Buffer.concat([berOctetString(attr), berTLV(TAG.SEQUENCE, Buffer.concat(subs))]));
    }
    // Equality filter [3]
    return berCtx(0xA3, Buffer.concat([berOctetString(attr), berOctetString(val)]));
  }

  // Fallback: present filter on entire string
  return berCtx(TAG.CTX_7, Buffer.from(inner, "utf8"));
}

// ── LDAP Request Builders ─────────────────────────────────────────────────────

function buildBindRequest(msgId, dn, password, sasl) {
  // BindRequest ::= [APPLICATION 0] SEQUENCE {
  //   version INTEGER (1..127),
  //   name LDAPDN,
  //   authentication AuthenticationChoice }
  // AuthenticationChoice ::= CHOICE {
  //   simple [0] OCTET STRING,
  //   sasl [3] SaslCredentials }
  let auth;
  if (sasl) {
    // SASL: [3] SEQUENCE { mechanism LDAPSTRING, credentials OCTET STRING OPTIONAL }
    const mechBuf = berOctetString(sasl.mechanism);
    const credsBuf = sasl.credentials
      ? berOctetString(sasl.credentials, "base64")
      : Buffer.alloc(0);
    auth = berCtx(0xA3, Buffer.concat([mechBuf, credsBuf]));
  } else {
    // Simple bind: [0] OCTET STRING
    auth = berCtx(TAG.CTX_0, Buffer.from(password || "", "utf8"));
  }
  const body = Buffer.concat([
    berInt(3),             // version = 3
    berOctetString(dn || ""),
    auth,
  ]);
  return ldapMessage(msgId, berTLV(TAG.BIND_REQUEST, body));
}

function buildUnbindRequest(msgId) {
  // UnbindRequest ::= [APPLICATION 2] NULL
  return ldapMessage(msgId, Buffer.from([TAG.UNBIND_REQUEST, 0x00]));
}

function buildSearchRequest(msgId, opts) {
  const {
    base_dn = "",
    scope = 2,           // wholeSubtree
    deref_aliases = 0,   // neverDerefAliases
    size_limit = 0,
    time_limit = 0,
    types_only = false,
    filter = "(objectClass=*)",
    attributes = [],
  } = opts;

  const scopeVal   = typeof scope === "string"
    ? { base: 0, one: 1, sub: 2, "single-level": 1, wholeSubtree: 2 }[scope.toLowerCase()] ?? 2
    : scope;
  const derefVal   = typeof deref_aliases === "string"
    ? { neverderefaliases: 0, derefinsearching: 1, dereffindinbalase: 2, derefalways: 3 }[deref_aliases.toLowerCase()] ?? 0
    : deref_aliases;

  const attrList   = attributes.map(a => berOctetString(a));
  const attrSeq    = berTLV(TAG.SEQUENCE, Buffer.concat(attrList));
  const filterBuf  = encodeFilter(filter);

  const body = Buffer.concat([
    berOctetString(base_dn),
    berEnum(scopeVal),
    berEnum(derefVal),
    berInt(size_limit),
    berInt(time_limit),
    berBoolean(types_only),
    filterBuf,
    attrSeq,
  ]);
  return ldapMessage(msgId, berTLV(TAG.SEARCH_REQUEST, body));
}

function buildAddRequest(msgId, dn, attrs) {
  // AddRequest ::= [APPLICATION 8] SEQUENCE {
  //   entry LDAPDN,
  //   attributes AttributeList }
  const attrBufs = [];
  for (const [type, values] of Object.entries(attrs)) {
    const vals = Array.isArray(values) ? values : [values];
    attrBufs.push(berSequence([
      berOctetString(type),
      berSet(vals.map(v => berOctetString(String(v)))),
    ]));
  }
  const body = Buffer.concat([berOctetString(dn), berSequence(attrBufs)]);
  return ldapMessage(msgId, berTLV(TAG.ADD_REQUEST, body));
}

function buildModifyRequest(msgId, dn, modifications) {
  // ModifyRequest ::= [APPLICATION 6] SEQUENCE {
  //   object LDAPDN,
  //   changes SEQUENCE OF change SEQUENCE {
  //     operation ENUMERATED { add(0), delete(1), replace(2) },
  //     modification PartialAttribute } }
  const modBufs = modifications.map(mod => {
    const op = { add: 0, delete: 1, replace: 2 }[mod.operation.toLowerCase()];
    if (op === undefined) throw new ToolError(`ldap_client: unknown modify operation '${mod.operation}'`, -32602);
    const vals = Array.isArray(mod.values) ? mod.values : (mod.values ? [mod.values] : []);
    const partial = berSequence([
      berOctetString(mod.attribute),
      berSet(vals.map(v => berOctetString(String(v)))),
    ]);
    return berSequence([berEnum(op), partial]);
  });
  const body = Buffer.concat([berOctetString(dn), berSequence(modBufs)]);
  return ldapMessage(msgId, berTLV(TAG.MODIFY_REQUEST, body));
}

function buildDeleteRequest(msgId, dn) {
  // DelRequest ::= [APPLICATION 10] LDAPDN
  return ldapMessage(msgId, berCtx(TAG.DELETE_REQUEST, Buffer.from(dn, "utf8")));
}

function buildCompareRequest(msgId, dn, attribute, value) {
  // CompareRequest ::= [APPLICATION 14] SEQUENCE {
  //   entry LDAPDN,
  //   ava AttributeValueAssertion }
  const ava = berSequence([berOctetString(attribute), berOctetString(value)]);
  const body = Buffer.concat([berOctetString(dn), ava]);
  return ldapMessage(msgId, berTLV(TAG.COMPARE_REQUEST, body));
}

function buildWhoamiRequest(msgId) {
  // ExtendedRequest ::= [APPLICATION 23] SEQUENCE {
  //   requestName [0] IMPLICIT LDAPOID }
  // whoami OID: 1.3.6.1.4.1.4203.1.11.3
  const oid = berCtx(TAG.CTX_0, Buffer.from("1.3.6.1.4.1.4203.1.11.3", "utf8"));
  return ldapMessage(msgId, berTLV(TAG.EXTENDED_REQUEST, oid));
}

// ── BER Decoder ──────────────────────────────────────────────────────────────

class BerReader {
  constructor(buf, start = 0, end = buf.length) {
    this.buf = buf;
    this.pos = start;
    this.end = end;
  }

  get remaining() { return this.end - this.pos; }

  peekTag() {
    if (this.pos >= this.end) return -1;
    return this.buf[this.pos];
  }

  readTag() {
    if (this.pos >= this.end) throw new Error("BER: unexpected end of data reading tag");
    return this.buf[this.pos++];
  }

  readLength() {
    if (this.pos >= this.end) throw new Error("BER: unexpected end of data reading length");
    const first = this.buf[this.pos++];
    if (first < 0x80) return first;
    const numBytes = first & 0x7F;
    if (numBytes === 0) throw new Error("BER: indefinite length not supported");
    if (numBytes > 4) throw new Error("BER: length too large");
    let len = 0;
    for (let i = 0; i < numBytes; i++) {
      if (this.pos >= this.end) throw new Error("BER: unexpected end reading length bytes");
      len = (len << 8) | this.buf[this.pos++];
    }
    return len >>> 0;
  }

  readTLV() {
    const tag = this.readTag();
    const len = this.readLength();
    if (this.pos + len > this.end) throw new Error(`BER: data truncated (need ${len} bytes, have ${this.end - this.pos})`);
    const value = this.buf.slice(this.pos, this.pos + len);
    this.pos += len;
    return { tag, len, value };
  }

  readInt() {
    const { tag, value } = this.readTLV();
    if (tag !== TAG.INTEGER && tag !== TAG.ENUMERATED) throw new Error(`BER: expected INTEGER/ENUM got 0x${tag.toString(16)}`);
    let n = 0;
    const signed = value[0] & 0x80;
    for (let i = 0; i < value.length; i++) {
      n = (n * 256 + value[i]) | 0;
    }
    return n;
  }

  readEnum() {
    const { tag, value } = this.readTLV();
    if (tag !== TAG.ENUMERATED && tag !== TAG.INTEGER) throw new Error(`BER: expected ENUMERATED got 0x${tag.toString(16)}`);
    let n = 0;
    for (let i = 0; i < value.length; i++) n = (n * 256 + value[i]) | 0;
    return n;
  }

  readOctetString() {
    const { tag, value } = this.readTLV();
    // Allow various octet string tags
    return value.toString("utf8");
  }

  readBoolean() {
    const { value } = this.readTLV();
    return value[0] !== 0x00;
  }

  subReader(len) {
    if (this.pos + len > this.end) throw new Error("BER: subReader extends beyond bounds");
    const r = new BerReader(this.buf, this.pos, this.pos + len);
    this.pos += len;
    return r;
  }
}

// ── LDAP Response Decoder ─────────────────────────────────────────────────────

function decodeLDAPResult(r) {
  const resultCode = r.readEnum();
  const matchedDN  = r.readOctetString();
  const message    = r.readOctetString();
  const codeStr    = RESULT_CODES[resultCode] || `code_${resultCode}`;
  return { resultCode, codeStr, matchedDN, message };
}

function decodeMessage(buf) {
  const r = new BerReader(buf);
  const seq = r.readTLV();
  if (seq.tag !== TAG.SEQUENCE) throw new Error(`LDAP: expected SEQUENCE got 0x${seq.tag.toString(16)}`);
  const sr = new BerReader(seq.value);

  // messageID
  const msgId = sr.readInt();

  // protocolOp tag
  const opTag = sr.peekTag();
  const opTlv = sr.readTLV();
  const or    = new BerReader(opTlv.value);

  const result = { msgId, opTag };

  switch (opTag) {
    case TAG.BIND_RESPONSE: {
      const { resultCode, codeStr, matchedDN, message } = decodeLDAPResult(or);
      result.type = "BindResponse";
      result.resultCode = resultCode; result.codeStr = codeStr;
      result.matchedDN = matchedDN; result.message = message;
      // serverSaslCreds [7] OPTIONAL
      if (or.remaining > 0 && or.peekTag() === 0x87) {
        const { value } = or.readTLV();
        result.serverSaslCreds = value.toString("base64");
      }
      break;
    }
    case TAG.SEARCH_RESULT_ENTRY: {
      result.type = "SearchResultEntry";
      result.dn = or.readOctetString();
      // attributes: SEQUENCE OF PartialAttribute
      const attrsTlv = or.readTLV();
      const ar = new BerReader(attrsTlv.value);
      const attributes = {};
      while (ar.remaining > 0) {
        const attrSeqTlv = ar.readTLV();
        const asr = new BerReader(attrSeqTlv.value);
        const attrType = asr.readOctetString();
        const valsTlv  = asr.readTLV(); // SET OF values
        const vr = new BerReader(valsTlv.value);
        const vals = [];
        while (vr.remaining > 0) {
          const valTlv = vr.readTLV();
          vals.push(valTlv.value.toString("utf8"));
        }
        attributes[attrType] = vals;
      }
      result.attributes = attributes;
      break;
    }
    case TAG.SEARCH_RESULT_DONE: {
      const { resultCode, codeStr, matchedDN, message } = decodeLDAPResult(or);
      result.type = "SearchResultDone";
      result.resultCode = resultCode; result.codeStr = codeStr;
      result.matchedDN = matchedDN; result.message = message;
      break;
    }
    case TAG.MODIFY_RESPONSE: {
      const { resultCode, codeStr, matchedDN, message } = decodeLDAPResult(or);
      result.type = "ModifyResponse";
      result.resultCode = resultCode; result.codeStr = codeStr;
      result.matchedDN = matchedDN; result.message = message;
      break;
    }
    case TAG.ADD_RESPONSE: {
      const { resultCode, codeStr, matchedDN, message } = decodeLDAPResult(or);
      result.type = "AddResponse";
      result.resultCode = resultCode; result.codeStr = codeStr;
      result.matchedDN = matchedDN; result.message = message;
      break;
    }
    case TAG.DELETE_RESPONSE: {
      const { resultCode, codeStr, matchedDN, message } = decodeLDAPResult(or);
      result.type = "DeleteResponse";
      result.resultCode = resultCode; result.codeStr = codeStr;
      result.matchedDN = matchedDN; result.message = message;
      break;
    }
    case TAG.COMPARE_RESPONSE: {
      const { resultCode, codeStr, matchedDN, message } = decodeLDAPResult(or);
      result.type = "CompareResponse";
      result.resultCode = resultCode; result.codeStr = codeStr;
      result.matchedDN = matchedDN; result.message = message;
      // compareTrue=6, compareFalse=5
      result.matched = resultCode === 6;
      break;
    }
    case TAG.EXTENDED_RESPONSE: {
      const { resultCode, codeStr, matchedDN, message } = decodeLDAPResult(or);
      result.type = "ExtendedResponse";
      result.resultCode = resultCode; result.codeStr = codeStr;
      result.matchedDN = matchedDN; result.message = message;
      // responseName [10] OPTIONAL, responseValue [11] OPTIONAL
      while (or.remaining > 0) {
        const tlv = or.readTLV();
        if (tlv.tag === 0x8A) result.responseName = tlv.value.toString("utf8");
        else if (tlv.tag === 0x8B) result.responseValue = tlv.value.toString("utf8");
      }
      break;
    }
    default:
      result.type = `Unknown_0x${opTag.toString(16)}`;
      result.raw = opTlv.value.toString("hex");
  }
  return result;
}

// ── LDAP Message Stream Parser ────────────────────────────────────────────────
// LDAP messages are BER SEQUENCE with known length — we can frame them
// by peeking at the length bytes of each SEQUENCE envelope.

class LdapParser {
  constructor() {
    this._buf    = Buffer.alloc(0);
    this._events = [];
    this._total  = 0;
  }

  feed(chunk) {
    this._buf   = Buffer.concat([this._buf, chunk]);
    this._total += chunk.length;
    if (this._total > MAX_RESPONSE_BYTES)
      throw new ToolError(`ldap_client: incoming data exceeds ${MAX_RESPONSE_BYTES / 1024 / 1024} MB limit.`, -32603);
    this._parse();
  }

  _parse() {
    while (true) {
      if (this._buf.length < 2) break;
      if (this._buf[0] !== TAG.SEQUENCE) {
        throw new ToolError(`ldap_client: expected SEQUENCE tag (0x30) but got 0x${this._buf[0].toString(16)}`, -32603);
      }

      // Determine the length of this BER message
      const first = this._buf[1];
      let hdrLen, bodyLen;
      if (first < 0x80) {
        hdrLen = 2; bodyLen = first;
      } else {
        const numBytes = first & 0x7F;
        if (numBytes === 0 || numBytes > 4) break; // indefinite or too large
        if (this._buf.length < 2 + numBytes) break; // wait for header bytes
        bodyLen = 0;
        for (let i = 0; i < numBytes; i++) bodyLen = (bodyLen << 8) | this._buf[2 + i];
        bodyLen = bodyLen >>> 0;
        hdrLen = 2 + numBytes;
      }

      const msgLen = hdrLen + bodyLen;
      if (this._buf.length < msgLen) break;

      const msgBuf = this._buf.slice(0, msgLen);
      this._buf = this._buf.slice(msgLen);

      try {
        const decoded = decodeMessage(msgBuf);
        this._events.push(decoded);
      } catch (e) {
        throw new ToolError(`ldap_client: decode error: ${e.message}`, -32603);
      }
    }
  }

  shift()         { return this._events.length > 0 ? this._events.shift() : null; }
  get available() { return this._events.length; }
}

// ── Security guards ──────────────────────────────────────────────────────────

function guardStr(val, label, maxLen = MAX_ATTR_LEN) {
  if (typeof val !== "string")
    throw new ToolError(`ldap_client: '${label}' must be a string.`, -32602);
  if (val.length > maxLen)
    throw new ToolError(`ldap_client: '${label}' exceeds ${maxLen}-char limit.`, -32602);
  if (/[\0]/.test(val))
    throw new ToolError(`ldap_client: '${label}' must not contain NUL bytes.`, -32602);
  return val;
}

function guardDN(val, label) {
  if (!val && val !== "") throw new ToolError(`ldap_client: '${label}' is required.`, -32602);
  if (typeof val !== "string") throw new ToolError(`ldap_client: '${label}' must be a string.`, -32602);
  if (val.length > MAX_DN_LEN) throw new ToolError(`ldap_client: '${label}' exceeds ${MAX_DN_LEN}-char limit.`, -32602);
  if (/[\0]/.test(val)) throw new ToolError(`ldap_client: '${label}' must not contain NUL bytes.`, -32602);
  return val;
}

function guardOptStr(val, label) {
  if (val === undefined || val === null) return undefined;
  return guardStr(String(val), label);
}

// ── Connection ────────────────────────────────────────────────────────────────

async function openLdapConnection(opts, socketRef) {
  const {
    host,
    port,
    tls:                useTls = false,
    reject_unauthorized         = true,
    connect_timeout,
    timeout = DEFAULT_TIMEOUT_MS,
    starttls = false,
  } = opts;

  const connToMs = typeof connect_timeout === "number"
    ? connect_timeout * 1000
    : Math.min(timeout, DEFAULT_CONN_TO_MS);

  return new Promise((resolve, reject) => {
    const parser  = new LdapParser();
    const waiters = [];   // { msgId, resolve, reject }
    let settled   = false;

    const done = (err, val) => {
      if (settled) return;
      settled = true;
      if (err) reject(err); else resolve(val);
    };

    const onData = (chunk) => {
      try { parser.feed(chunk); }
      catch (e) {
        done(new ToolError(`ldap_client: parse error: ${e.message}`, -32603));
        if (!socket.destroyed) socket.destroy();
        return;
      }
      let msg;
      while ((msg = parser.shift()) !== null) {
        const idx = waiters.findIndex(w => w.msgId === msg.msgId);
        if (idx !== -1) {
          waiters[idx].resolve(msg);
          waiters.splice(idx, 1);
        } else {
          // Unsolicited; ignore for now
        }
      }
    };

    const send = (buf) => {
      if (!socket.destroyed) socket.write(buf);
    };

    const waitResponse = (msgId) => {
      return new Promise((res, rej) => waiters.push({ msgId, resolve: res, reject: rej }));
    };

    const waitResponses = (msgId) => {
      // Collect multiple responses (for search) until SearchResultDone
      return new Promise((res, rej) => {
        const entries = [];
        const collector = { msgId, resolve: null, reject: rej };
        const resolveCurrent = (msg) => {
          if (msg === null) {
            res({ entries, done: null });
            return;
          }
          if (msg.type === "SearchResultEntry") {
            entries.push(msg);
            // Re-queue for next message
            waiters.push({ msgId, resolve: resolveCurrent, reject: rej });
          } else if (msg.type === "SearchResultDone") {
            res({ entries, done: msg });
          } else {
            // Unexpected type
            res({ entries, done: msg });
          }
        };
        collector.resolve = resolveCurrent;
        waiters.push(collector);
      });
    };

    const drainWaiters = () => {
      while (waiters.length) waiters.shift().resolve(null);
    };

    // ── Socket ─────────────────────────────────────────────────────────────────
    const socketOpts = { host, port };
    const socket = useTls
      ? tls.connect({ ...socketOpts, rejectUnauthorized: reject_unauthorized, servername: host })
      : net.createConnection(socketOpts);

    if (socketRef) socketRef.socket = socket;

    let connTimer = setTimeout(() => {
      socket.destroy(
        new ToolError(`ldap_client: TCP connect timed out after ${connToMs} ms.`, -32603));
    }, connToMs);
    connTimer.unref();

    socket.on("data",  onData);
    socket.on("error", (e) => {
      done(new ToolError(`ldap_client: socket error: ${e.message}`, -32603));
    });
    socket.on("close", () => {
      drainWaiters();
    });

    const onConnect = () => {
      clearTimeout(connTimer);
      connTimer = null;
      done(null, { socket, send, waitResponse, waitResponses, drainWaiters });
    };

    if (useTls) socket.on("secureConnect", onConnect);
    else        socket.on("connect",       onConnect);
  });
}

async function closeLdapConnection(conn) {
  try {
    if (conn && conn.drainWaiters) conn.drainWaiters();
    if (conn && conn.socket && !conn.socket.destroyed) conn.socket.destroy();
  } catch (_) { /* ignore */ }
}

// ── Helper: assert success result code ────────────────────────────────────────

function assertSuccess(msg, operation) {
  if (msg === null)
    throw new ToolError(`ldap_client: connection closed during ${operation}.`, -32603);
  if (msg.resultCode !== 0) {
    const desc = msg.message ? `: ${msg.message}` : "";
    throw new ToolError(
      `ldap_client: ${operation} failed — ${msg.codeStr} (${msg.resultCode})${desc}`,
      -32603
    );
  }
}

// ── Main exported function ────────────────────────────────────────────────────

async function ldapClient(opts) {
  opts = opts || {};

  const {
    host,
    port,
    tls:                useTls             = false,
    reject_unauthorized                    = true,
    bind_dn,
    bind_password,
    sasl_mechanism,
    sasl_credentials,
    timeout                                = 30,
    connect_timeout,
    operation,
    // search
    base_dn,
    scope,
    filter,
    attributes,
    size_limit,
    time_limit,
    types_only,
    // add
    dn,
    entry_attributes,
    // modify
    modifications,
    // compare
    attribute,
    value,
  } = opts;

  // ── Validation ─────────────────────────────────────────────────────────────
  if (!host || typeof host !== "string")
    throw new ToolError("ldap_client: 'host' is required (string).", -32602);

  const VALID_OPS = ["bind", "search", "add", "modify", "delete", "compare", "whoami"];
  if (!operation || !VALID_OPS.includes(operation))
    throw new ToolError(
      `ldap_client: 'operation' must be one of: ${VALID_OPS.join(", ")}.`, -32602);

  if (bind_dn   != null) guardDN(bind_dn, "bind_dn");
  if (bind_password != null) guardOptStr(bind_password, "bind_password");

  if (operation === "search") {
    if (base_dn != null) guardDN(base_dn, "base_dn");
    if (filter  != null) guardStr(filter, "filter", 4096);
    const validScopes = ["base", "one", "sub", "single-level", "wholeSubtree", 0, 1, 2];
    if (scope !== undefined && !validScopes.includes(scope))
      throw new ToolError(`ldap_client: 'scope' must be one of: base, one, sub (or 0/1/2).`, -32602);
    if (size_limit !== undefined && (typeof size_limit !== "number" || size_limit < 0))
      throw new ToolError("ldap_client: 'size_limit' must be a non-negative number.", -32602);
  }

  if (["add", "modify", "delete", "compare"].includes(operation)) {
    if (!dn) throw new ToolError(`ldap_client: 'dn' is required for '${operation}'.`, -32602);
    guardDN(dn, "dn");
  }
  if (operation === "add") {
    if (!entry_attributes || typeof entry_attributes !== "object")
      throw new ToolError("ldap_client: 'entry_attributes' (object) is required for 'add'.", -32602);
  }
  if (operation === "modify") {
    if (!Array.isArray(modifications) || modifications.length === 0)
      throw new ToolError("ldap_client: 'modifications' (array) is required for 'modify'.", -32602);
    for (const mod of modifications) {
      if (!mod.operation) throw new ToolError("ldap_client: each modification needs 'operation' (add/delete/replace).", -32602);
      if (!mod.attribute) throw new ToolError("ldap_client: each modification needs 'attribute'.", -32602);
    }
  }
  if (operation === "compare") {
    if (!attribute) throw new ToolError("ldap_client: 'attribute' is required for 'compare'.", -32602);
    if (value === undefined) throw new ToolError("ldap_client: 'value' is required for 'compare'.", -32602);
  }

  const timeoutMs    = (typeof timeout === "number" && timeout > 0) ? timeout * 1000 : DEFAULT_TIMEOUT_MS;
  const resolvedPort = typeof port === "number" ? port : (useTls ? DEFAULT_TLS_PORT : DEFAULT_PORT);

  const startTime = Date.now();
  let globalTimer;
  let conn;
  const socketRef = { socket: null };

  const timeoutPromise = new Promise((_, rej) => {
    globalTimer = setTimeout(() =>
      rej(new ToolError(`ldap_client: operation timed out after ${timeoutMs} ms.`, -32603)),
      timeoutMs);
    globalTimer.unref();
  });

  async function run() {
    conn = await openLdapConnection({
      host, port: resolvedPort, tls: useTls, reject_unauthorized,
      timeout: timeoutMs, connect_timeout,
    }, socketRef);

    const { send, waitResponse, waitResponses } = conn;
    let result;

    // ── Step 1: Bind (optional — anonymous if no bind_dn) ────────────────────
    const bindId = nextMsgId();
    const sasl = sasl_mechanism ? { mechanism: sasl_mechanism, credentials: sasl_credentials } : null;
    send(buildBindRequest(bindId, bind_dn || "", bind_password || "", sasl));
    const bindResp = await waitResponse(bindId);
    assertSuccess(bindResp, "bind");

    // ── Step 2: Perform operation ────────────────────────────────────────────
    switch (operation) {

      case "bind": {
        // Bind already done above
        result = {
          bound: true,
          dn: bind_dn || "",
          resultCode: bindResp.resultCode,
          codeStr: bindResp.codeStr,
        };
        break;
      }

      case "search": {
        const searchId = nextMsgId();
        send(buildSearchRequest(searchId, {
          base_dn:      base_dn     || "",
          scope:        scope       !== undefined ? scope : 2,
          filter:       filter      || "(objectClass=*)",
          attributes:   Array.isArray(attributes) ? attributes : [],
          size_limit:   size_limit  || 0,
          time_limit:   time_limit  || 0,
          types_only:   !!types_only,
          deref_aliases: 0,
        }));
        const { entries, done: doneMsg } = await waitResponses(searchId);
        if (doneMsg && doneMsg.resultCode !== 0 && doneMsg.resultCode !== 4 /* sizeLimitExceeded */) {
          const desc = doneMsg.message ? `: ${doneMsg.message}` : "";
          throw new ToolError(
            `ldap_client: search failed — ${doneMsg.codeStr} (${doneMsg.resultCode})${desc}`,
            -32603
          );
        }
        result = {
          entryCount: entries.length,
          entries: entries.map(e => ({ dn: e.dn, attributes: e.attributes })),
          resultCode:    doneMsg ? doneMsg.resultCode : 0,
          codeStr:       doneMsg ? doneMsg.codeStr : "success",
          sizeLimitExceeded: doneMsg ? doneMsg.resultCode === 4 : false,
        };
        break;
      }

      case "add": {
        const addId = nextMsgId();
        send(buildAddRequest(addId, dn, entry_attributes));
        const addResp = await waitResponse(addId);
        assertSuccess(addResp, "add");
        result = { added: true, dn, resultCode: addResp.resultCode, codeStr: addResp.codeStr };
        break;
      }

      case "modify": {
        const modId = nextMsgId();
        send(buildModifyRequest(modId, dn, modifications));
        const modResp = await waitResponse(modId);
        assertSuccess(modResp, "modify");
        result = { modified: true, dn, resultCode: modResp.resultCode, codeStr: modResp.codeStr };
        break;
      }

      case "delete": {
        const delId = nextMsgId();
        send(buildDeleteRequest(delId, dn));
        const delResp = await waitResponse(delId);
        assertSuccess(delResp, "delete");
        result = { deleted: true, dn, resultCode: delResp.resultCode, codeStr: delResp.codeStr };
        break;
      }

      case "compare": {
        const cmpId = nextMsgId();
        send(buildCompareRequest(cmpId, dn, attribute, String(value)));
        const cmpResp = await waitResponse(cmpId);
        if (cmpResp === null)
          throw new ToolError("ldap_client: connection closed during compare.", -32603);
        if (cmpResp.resultCode !== 5 && cmpResp.resultCode !== 6) {
          const desc = cmpResp.message ? `: ${cmpResp.message}` : "";
          throw new ToolError(
            `ldap_client: compare failed — ${cmpResp.codeStr} (${cmpResp.resultCode})${desc}`,
            -32603
          );
        }
        result = {
          dn,
          attribute,
          value: String(value),
          matched: cmpResp.resultCode === 6, // compareTrue
          resultCode: cmpResp.resultCode,
          codeStr: cmpResp.codeStr,
        };
        break;
      }

      case "whoami": {
        const whoId = nextMsgId();
        send(buildWhoamiRequest(whoId));
        const whoResp = await waitResponse(whoId);
        assertSuccess(whoResp, "whoami");
        result = {
          authzId: whoResp.responseValue || "",
          resultCode: whoResp.resultCode,
          codeStr: whoResp.codeStr,
        };
        break;
      }

      default:
        throw new ToolError(`ldap_client: unhandled operation '${operation}'.`, -32603);
    }

    // ── Step 3: Unbind ────────────────────────────────────────────────────────
    try { send(buildUnbindRequest(nextMsgId())); } catch (_) { /* ignore */ }

    return {
      host, port: resolvedPort, operation,
      elapsedMs: Date.now() - startTime,
      ...result,
    };
  }

  try {
    const runPromise = run();
    runPromise.catch(() => {});
    return await Promise.race([runPromise, timeoutPromise]);
  } finally {
    clearTimeout(globalTimer);
    if (conn) {
      await closeLdapConnection(conn).catch(() => {});
    } else if (socketRef.socket && !socketRef.socket.destroyed) {
      socketRef.socket.destroy();
    }
  }
}

module.exports = {
  ldapClient,
  LdapParser,
  BerReader,
  buildBindRequest,
  buildSearchRequest,
  buildAddRequest,
  buildModifyRequest,
  buildDeleteRequest,
  buildCompareRequest,
  buildWhoamiRequest,
  encodeFilter,
  berOctetString,
  berInt,
  berEnum,
  berSequence,
  berSet,
  berCtx,
  berTLV,
  TAG,
  RESULT_CODES,
};
