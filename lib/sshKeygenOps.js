"use strict";
// ── ssh_keygen — SSH key inspector / generator (pure Node.js crypto; no npm deps) ─
// Operations: generate, inspect, fingerprint, convert, validate,
//             authorized_keys, known_hosts
// Supports: RSA (1024–8192 bits), ECDSA (P-256/P-384/P-521), Ed25519
// PEM (PKCS#8/SEC1/PKCS#1/OpenSSH), OpenSSH wire-format (base64 blob)
// Security: key-size guards; NUL-byte path guard; directory guard

"use strict";
const crypto = require("crypto");
const fs     = require("fs");
const path   = require("path");

// ── Constants ──────────────────────────────────────────────────────────────────
const MAX_FILE_SIZE  = 4 * 1024 * 1024;   // 4 MB (key files are tiny)
const MAX_AUTH_KEYS  = 10_000;
const MAX_KNOWN_HOSTS = 100_000;

// ── Path guard ────────────────────────────────────────────────────────────────
function readFileGuarded(filePath) {
  if (typeof filePath !== "string" || filePath.includes("\0"))
    throw new Error("ssh_keygen: path contains NUL byte.");
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) throw new Error("ssh_keygen: path is a directory.");
  if (stat.size > MAX_FILE_SIZE)
    throw new Error(`ssh_keygen: file too large (${stat.size} bytes; max ${MAX_FILE_SIZE} bytes).`);
  return fs.readFileSync(filePath, "utf8");
}

// ── Key type detection from PEM header ───────────────────────────────────────
function detectKeyType(pem) {
  const hdr = pem.trim().split("\n")[0];
  if (hdr.includes("OPENSSH PRIVATE KEY")) return { format: "openssh", role: "private" };
  if (hdr.includes("RSA PRIVATE KEY"))     return { format: "pkcs1",   role: "private", algo: "rsa" };
  if (hdr.includes("EC PRIVATE KEY"))      return { format: "sec1",    role: "private", algo: "ec" };
  if (hdr.includes("PRIVATE KEY"))         return { format: "pkcs8",   role: "private" };
  if (hdr.includes("RSA PUBLIC KEY"))      return { format: "pkcs1",   role: "public",  algo: "rsa" };
  if (hdr.includes("PUBLIC KEY"))          return { format: "spki",    role: "public" };
  if (hdr.includes("CERTIFICATE"))         return { format: "cert",    role: "cert" };
  return { format: "unknown", role: "unknown" };
}

// ── OpenSSH public key line parser ─────────────────────────────────────────────
// Format: <type> <base64> [<comment>]
function parseOpenSSHPublicKeyLine(line) {
  line = line.trim();
  if (!line || line.startsWith("#")) return null;

  const parts = line.split(" ");
  if (parts.length < 2) return null;

  const type    = parts[0];  // e.g. "ssh-rsa", "ecdsa-sha2-nistp256", "ssh-ed25519"
  const b64     = parts[1];
  const comment = parts.slice(2).join(" ") || "";

  // Decode the wire format blob
  let blob;
  try { blob = Buffer.from(b64, "base64"); } catch { return null; }

  // Wire format: 4-byte BE length prefix followed by data for each field
  function readField(buf, offset) {
    if (offset + 4 > buf.length) throw new Error("truncated");
    const len  = buf.readUInt32BE(offset);
    if (offset + 4 + len > buf.length) throw new Error("truncated");
    return { data: buf.slice(offset + 4, offset + 4 + len), next: offset + 4 + len };
  }

  let keyType, bitLength, curve;
  try {
    const f0 = readField(blob, 0);
    keyType   = f0.data.toString("utf8");

    if (keyType === "ssh-rsa") {
      // Fields: key-type, e, n
      const fe = readField(blob, f0.next);
      const fn = readField(blob, fe.next);
      bitLength = fn.data.length * 8;
      // Adjust for leading zero byte (sign indicator)
      if (fn.data[0] === 0x00) bitLength = (fn.data.length - 1) * 8;
    } else if (keyType.startsWith("ecdsa-sha2-")) {
      // Fields: key-type, curve-name, Q
      const fc = readField(blob, f0.next);
      curve     = fc.data.toString("utf8");
      bitLength = curve === "nistp256" ? 256 : curve === "nistp384" ? 384 : curve === "nistp521" ? 521 : null;
    } else if (keyType === "ssh-ed25519") {
      bitLength = 256;
    }
  } catch {
    // Blob parsing failed — return partial info
  }

  // SHA256 fingerprint (standard OpenSSH default)
  const sha256fp = "SHA256:" + crypto.createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
  // MD5 fingerprint (legacy)
  const md5fp    = crypto.createHash("md5").update(blob).digest("hex").replace(/(..)/g, "$1:").slice(0, -1);

  return {
    type,
    keyType:        keyType || type,
    comment,
    fingerprint:    sha256fp,
    fingerprintMd5: md5fp,
    bitLength:      bitLength || null,
    curve:          curve    || null,
    blobLength:     blob.length,
  };
}

// ── PEM → KeyObject, extract metadata ─────────────────────────────────────────
function inspectPemKey(pem) {
  const { format, role } = detectKeyType(pem);
  if (format === "unknown") throw new Error("ssh_keygen: unrecognised PEM header.");
  if (format === "cert")    throw new Error("ssh_keygen: certificate inspection not supported; use 'tls_cert_inspect' for X.509 certs.");

  let keyObj;
  try {
    if (role === "private") {
      keyObj = crypto.createPrivateKey({ key: pem, format: "pem" });
    } else {
      keyObj = crypto.createPublicKey({ key: pem, format: "pem" });
    }
  } catch (e) {
    throw new Error(`ssh_keygen: failed to parse key: ${e.message}`);
  }

  const details = keyObj.export({ format: "jwk" });
  const asymmType = keyObj.asymmetricKeyType;  // 'rsa', 'ec', 'ed25519', 'ed448', 'x25519', 'x448'
  const asymmDetails = keyObj.asymmetricKeyDetails || {};

  let bitLength = null;
  let curve     = null;

  if (asymmType === "rsa") {
    bitLength = asymmDetails.modulusLength || (details.n ? Buffer.from(details.n, "base64url").length * 8 : null);
  } else if (asymmType === "ec") {
    curve = asymmDetails.namedCurve || details.crv;
    bitLength = curve === "prime256v1" || curve === "P-256" ? 256
              : curve === "secp384r1"  || curve === "P-384" ? 384
              : curve === "secp521r1"  || curve === "P-521" ? 521
              : null;
  } else if (asymmType === "ed25519") {
    bitLength = 256;
  } else if (asymmType === "ed448") {
    bitLength = 448;
  }

  // Compute SSH fingerprints from the public key's OpenSSH wire format
  let fingerprint    = null;
  let fingerprintMd5 = null;
  let sshType        = null;

  try {
    const pubKeyObj = role === "private" ? crypto.createPublicKey(keyObj) : keyObj;
    const sshBlob   = publicKeyToSSHBlob(pubKeyObj, asymmType, asymmDetails);
    if (sshBlob) {
      fingerprint    = "SHA256:" + crypto.createHash("sha256").update(sshBlob).digest("base64").replace(/=+$/, "");
      fingerprintMd5 = crypto.createHash("md5").update(sshBlob).digest("hex").replace(/(..)/g, "$1:").slice(0, -1);
    }
    sshType = sshTypeFromAsymm(asymmType, asymmDetails);
  } catch {
    // Fingerprinting is best-effort
  }

  return {
    pemFormat:      format,
    role,
    algorithm:      asymmType,
    sshKeyType:     sshType,
    bitLength,
    curve,
    fingerprint,
    fingerprintMd5,
  };
}

// ── SSH key type string ────────────────────────────────────────────────────────
function sshTypeFromAsymm(asymmType, details = {}) {
  if (asymmType === "rsa")     return "ssh-rsa";
  if (asymmType === "ed25519") return "ssh-ed25519";
  if (asymmType === "ed448")   return "ssh-ed448";
  if (asymmType === "ec") {
    const c = details.namedCurve || "";
    if (c === "prime256v1" || c === "P-256") return "ecdsa-sha2-nistp256";
    if (c === "secp384r1"  || c === "P-384") return "ecdsa-sha2-nistp384";
    if (c === "secp521r1"  || c === "P-521") return "ecdsa-sha2-nistp521";
  }
  return null;
}

// ── Build the SSH wire-format blob for a public key ───────────────────────────
// Used to compute the standard OpenSSH fingerprint
function publicKeyToSSHBlob(pubKeyObj, asymmType, details = {}) {
  // Export as DER SPKI then parse the relevant fields for SSH wire format
  // For RSA: wire = string("ssh-rsa") || mpint(e) || mpint(n)
  // For ECDSA: wire = string("ecdsa-sha2-<curve>") || string(<curve>) || string(Q)
  // For Ed25519: wire = string("ssh-ed25519") || string(pk)

  function sshString(s) {
    const b = Buffer.isBuffer(s) ? s : Buffer.from(s);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length);
    return Buffer.concat([len, b]);
  }

  function sshMpint(bigEndianBytes) {
    // Add leading 0x00 if high bit set (to keep it positive)
    let b = bigEndianBytes;
    if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
    return sshString(b);
  }

  if (asymmType === "rsa") {
    const jwk = pubKeyObj.export({ format: "jwk" });
    const e   = Buffer.from(jwk.e, "base64url");
    const n   = Buffer.from(jwk.n, "base64url");
    return Buffer.concat([sshString("ssh-rsa"), sshMpint(e), sshMpint(n)]);
  }

  if (asymmType === "ec") {
    const c    = details.namedCurve || "";
    const sshC = c === "prime256v1" || c === "P-256" ? "nistp256"
               : c === "secp384r1"  || c === "P-384" ? "nistp384"
               : c === "secp521r1"  || c === "P-521" ? "nistp521"
               : null;
    if (!sshC) return null;
    const sshKeyType = `ecdsa-sha2-${sshC}`;
    // Export raw DER and extract the uncompressed Q point
    const der  = pubKeyObj.export({ format: "der", type: "spki" });
    // Q point is the final bitstring in the DER; it starts with 0x04 (uncompressed)
    const qIdx = der.lastIndexOf(0x04);
    if (qIdx < 0) return null;
    const Q = der.slice(qIdx);
    return Buffer.concat([sshString(sshKeyType), sshString(sshC), sshString(Q)]);
  }

  if (asymmType === "ed25519") {
    const der  = pubKeyObj.export({ format: "der", type: "spki" });
    // Ed25519 SPKI ends with 32-byte public key; last 32 bytes
    const pk   = der.slice(-32);
    return Buffer.concat([sshString("ssh-ed25519"), sshString(pk)]);
  }

  if (asymmType === "ed448") {
    const der = pubKeyObj.export({ format: "der", type: "spki" });
    const pk  = der.slice(-57);
    return Buffer.concat([sshString("ssh-ed448"), sshString(pk)]);
  }

  return null;
}

// ── Operation: generate ────────────────────────────────────────────────────────
function opGenerate(args) {
  const type    = (args.type || "ed25519").toLowerCase();
  const comment = args.comment || "";
  const passphrase = args.passphrase || null;

  let keyPair;
  let genOptions;
  let asymmType;

  if (type === "rsa") {
    const bits = args.bits ?? 4096;
    if (bits < 1024 || bits > 8192)
      throw new Error(`ssh_keygen generate: RSA bits must be 1024–8192 (got ${bits}).`);
    if (bits % 8 !== 0)
      throw new Error("ssh_keygen generate: RSA bits must be a multiple of 8.");
    genOptions = { modulusLength: bits, publicExponent: args.public_exponent ?? 65537 };
    asymmType  = "rsa";
    keyPair    = crypto.generateKeyPairSync("rsa", genOptions);
  } else if (type === "ecdsa" || type === "ec") {
    const curve = args.curve || "P-256";
    const namedCurve = curve === "P-256" || curve === "nistp256" ? "prime256v1"
                     : curve === "P-384" || curve === "nistp384" ? "secp384r1"
                     : curve === "P-521" || curve === "nistp521" ? "secp521r1"
                     : curve;  // pass-through for others
    genOptions = { namedCurve };
    asymmType  = "ec";
    keyPair    = crypto.generateKeyPairSync("ec", genOptions);
  } else if (type === "ed25519") {
    asymmType = "ed25519";
    keyPair   = crypto.generateKeyPairSync("ed25519", {});
  } else if (type === "ed448") {
    asymmType = "ed448";
    keyPair   = crypto.generateKeyPairSync("ed448", {});
  } else {
    throw new Error(`ssh_keygen generate: unsupported type '${type}'. Valid: rsa, ecdsa, ed25519, ed448.`);
  }

  // Export private key as OpenSSH PEM
  const privExportOpts = { type: "pkcs8", format: "pem" };
  if (passphrase) {
    privExportOpts.cipher     = "aes-256-cbc";
    privExportOpts.passphrase = passphrase;
  }
  const privateKeyPem = keyPair.privateKey.export(privExportOpts);

  // Export public key in OpenSSH authorized_keys format
  const pubKeyPem   = keyPair.publicKey.export({ type: "spki", format: "pem" });
  const asymmDetails = keyPair.privateKey.asymmetricKeyDetails || {};
  const sshType     = sshTypeFromAsymm(asymmType, asymmDetails);
  const sshBlob     = publicKeyToSSHBlob(keyPair.publicKey, asymmType, asymmDetails);
  const publicKeyOpenSSH = sshBlob
    ? `${sshType} ${sshBlob.toString("base64")}${comment ? " " + comment : ""}`
    : pubKeyPem;

  const fingerprint    = sshBlob ? "SHA256:" + crypto.createHash("sha256").update(sshBlob).digest("base64").replace(/=+$/, "") : null;
  const fingerprintMd5 = sshBlob ? crypto.createHash("md5").update(sshBlob).digest("hex").replace(/(..)/g, "$1:").slice(0, -1) : null;

  const info = {
    operation:        "generate",
    algorithm:        asymmType,
    sshKeyType:       sshType,
    bitLength:        asymmType === "rsa" ? (genOptions.modulusLength || null)
                    : asymmType === "ec"  ? (asymmDetails.modulusLength || (genOptions.namedCurve === "prime256v1" ? 256 : genOptions.namedCurve === "secp384r1" ? 384 : 521))
                    : asymmType === "ed25519" ? 256
                    : asymmType === "ed448"   ? 448
                    : null,
    curve:            asymmType === "ec" ? (asymmDetails.namedCurve || genOptions.namedCurve) : null,
    comment,
    encrypted:        !!passphrase,
    fingerprint,
    fingerprintMd5,
    privateKey:       privateKeyPem,
    publicKey:        publicKeyOpenSSH,
    publicKeyPem:     pubKeyPem,
  };
  return info;
}

// ── Operation: inspect ────────────────────────────────────────────────────────
function opInspect(args) {
  let pemText;
  if (args.path) {
    pemText = readFileGuarded(args.path);
  } else if (args.key) {
    pemText = args.key;
  } else if (args.public_key) {
    // OpenSSH public key line (authorized_keys format)
    const parsed = parseOpenSSHPublicKeyLine(args.public_key);
    if (!parsed) throw new Error("ssh_keygen inspect: could not parse public key line.");
    return { operation: "inspect", source: "inline", ...parsed };
  } else {
    throw new Error("ssh_keygen inspect: provide 'path', 'key' (PEM), or 'public_key' (OpenSSH line).");
  }

  // Check if it looks like an OpenSSH public key line (not PEM)
  const firstLine = pemText.trim().split("\n")[0];
  if (!firstLine.startsWith("-----")) {
    // Could be an OpenSSH public key line
    const parsed = parseOpenSSHPublicKeyLine(firstLine);
    if (parsed) return { operation: "inspect", source: args.path || "inline", ...parsed };
  }

  const meta = inspectPemKey(pemText);
  return { operation: "inspect", source: args.path || "inline", ...meta };
}

// ── Operation: fingerprint ────────────────────────────────────────────────────
function opFingerprint(args) {
  let pemText, keyLine;

  if (args.path) {
    const raw = readFileGuarded(args.path);
    const firstLine = raw.trim().split("\n")[0];
    if (!firstLine.startsWith("-----")) {
      keyLine = firstLine;
    } else {
      pemText = raw;
    }
  } else if (args.key) {
    pemText = args.key;
  } else if (args.public_key) {
    keyLine = args.public_key;
  } else {
    throw new Error("ssh_keygen fingerprint: provide 'path', 'key', or 'public_key'.");
  }

  if (keyLine) {
    const parsed = parseOpenSSHPublicKeyLine(keyLine);
    if (!parsed) throw new Error("ssh_keygen fingerprint: could not parse public key line.");
    return {
      operation:      "fingerprint",
      fingerprint:    parsed.fingerprint,
      fingerprintMd5: parsed.fingerprintMd5,
      keyType:        parsed.keyType,
      bitLength:      parsed.bitLength,
      curve:          parsed.curve,
      comment:        parsed.comment,
    };
  }

  const meta = inspectPemKey(pemText);
  return {
    operation:      "fingerprint",
    fingerprint:    meta.fingerprint,
    fingerprintMd5: meta.fingerprintMd5,
    algorithm:      meta.algorithm,
    sshKeyType:     meta.sshKeyType,
    bitLength:      meta.bitLength,
    curve:          meta.curve,
    role:           meta.role,
  };
}

// ── Operation: convert ────────────────────────────────────────────────────────
function opConvert(args) {
  const to = (args.to || "").toLowerCase();
  if (!["pem", "pkcs8", "openssh-pub", "spki"].includes(to))
    throw new Error(`ssh_keygen convert: unsupported target format '${to}'. Valid: pem, pkcs8, openssh-pub, spki.`);

  let pemText;
  if (args.path) {
    pemText = readFileGuarded(args.path);
  } else if (args.key) {
    pemText = args.key;
  } else {
    throw new Error("ssh_keygen convert: provide 'path' or 'key'.");
  }

  const { role } = detectKeyType(pemText);
  let keyObj;
  try {
    keyObj = role === "private"
      ? crypto.createPrivateKey({ key: pemText, format: "pem" })
      : crypto.createPublicKey({ key: pemText, format: "pem" });
  } catch (e) {
    throw new Error(`ssh_keygen convert: failed to parse source key: ${e.message}`);
  }

  const asymmType    = keyObj.asymmetricKeyType;
  const asymmDetails = keyObj.asymmetricKeyDetails || {};

  let converted;
  if (to === "pkcs8") {
    if (role !== "private")
      throw new Error("ssh_keygen convert: 'pkcs8' output requires a private key.");
    converted = keyObj.export({ type: "pkcs8", format: "pem" });
  } else if (to === "pem" || to === "spki") {
    const pubObj = role === "private" ? crypto.createPublicKey(keyObj) : keyObj;
    converted    = pubObj.export({ type: "spki", format: "pem" });
  } else if (to === "openssh-pub") {
    const pubObj = role === "private" ? crypto.createPublicKey(keyObj) : keyObj;
    const sshBlob  = publicKeyToSSHBlob(pubObj, asymmType, asymmDetails);
    if (!sshBlob) throw new Error("ssh_keygen convert: cannot convert this key type to OpenSSH public key line.");
    const sshType  = sshTypeFromAsymm(asymmType, asymmDetails);
    const comment  = args.comment || "";
    converted = `${sshType} ${sshBlob.toString("base64")}${comment ? " " + comment : ""}`;
  }

  return { operation: "convert", to, result: converted };
}

// ── Operation: validate ────────────────────────────────────────────────────────
function opValidate(args) {
  if (!args.private_key && !args.key)
    throw new Error("ssh_keygen validate: provide 'private_key' (or 'key') PEM string.");
  if (!args.public_key)
    throw new Error("ssh_keygen validate: provide 'public_key' (PEM or OpenSSH line).");

  const privPem = args.private_key || args.key;

  let privObj;
  try {
    privObj = crypto.createPrivateKey({ key: privPem, format: "pem" });
  } catch (e) {
    throw new Error(`ssh_keygen validate: failed to parse private key: ${e.message}`);
  }

  // Derive public key from private key
  const derivedPub = crypto.createPublicKey(privObj);
  const derivedSpki = derivedPub.export({ type: "spki", format: "der" });

  // Parse the provided public key
  let givenSpki;
  const pubStr = args.public_key.trim();
  if (pubStr.startsWith("-----")) {
    // PEM public key
    let givenPubObj;
    try {
      givenPubObj = crypto.createPublicKey({ key: pubStr, format: "pem" });
    } catch (e) {
      throw new Error(`ssh_keygen validate: failed to parse public key: ${e.message}`);
    }
    givenSpki = givenPubObj.export({ type: "spki", format: "der" });
  } else {
    // OpenSSH public key line — reconstruct from blob
    const parsed = parseOpenSSHPublicKeyLine(pubStr);
    if (!parsed) throw new Error("ssh_keygen validate: could not parse public key line.");

    // Get SPKI for derived pub to compare via fingerprint
    const asymmType    = privObj.asymmetricKeyType;
    const asymmDetails = privObj.asymmetricKeyDetails || {};
    const derivedBlob  = publicKeyToSSHBlob(derivedPub, asymmType, asymmDetails);
    if (!derivedBlob) {
      return { operation: "validate", matches: false, reason: "Could not compute SSH blob for derived public key." };
    }
    const derivedFp = "SHA256:" + crypto.createHash("sha256").update(derivedBlob).digest("base64").replace(/=+$/, "");
    const matches   = derivedFp === parsed.fingerprint;
    return {
      operation: "validate",
      matches,
      derivedFingerprint: derivedFp,
      givenFingerprint:   parsed.fingerprint,
      reason: matches ? null : "Fingerprints do not match — keys are not a pair.",
    };
  }

  const matches = derivedSpki.equals(givenSpki);
  return {
    operation: "validate",
    matches,
    reason: matches ? null : "SPKI bytes do not match — keys are not a pair.",
  };
}

// ── Operation: authorized_keys ────────────────────────────────────────────────
function opAuthorizedKeys(args) {
  let text;
  if (args.path) {
    text = readFileGuarded(args.path);
  } else if (args.content) {
    text = args.content;
  } else {
    throw new Error("ssh_keygen authorized_keys: provide 'path' or 'content'.");
  }

  const lines  = text.split(/\r?\n/);
  const entries = [];
  let lineNum  = 0;

  for (const rawLine of lines) {
    lineNum++;
    if (entries.length >= MAX_AUTH_KEYS) break;
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    // Lines can have leading options before the key type
    // Options are a comma-separated list before the key type token
    // Simple heuristic: find the first ssh- or ecdsa- token
    const KNOWN_TYPES = ["sk-ssh-ed25519@openssh.com", "sk-ecdsa-sha2-nistp256@openssh.com",
                         "ssh-rsa", "ssh-dss", "ssh-ed25519", "ssh-ed448",
                         "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521"];

    let options  = null;
    let keyLine  = line;
    // Check if line starts with options (not a key type directly)
    const firstWord = line.split(/\s+/)[0];
    if (!KNOWN_TYPES.includes(firstWord)) {
      // Parse options prefix: up to the first known key type
      for (const kt of KNOWN_TYPES) {
        const idx = line.indexOf(kt);
        if (idx > 0) {
          options = line.slice(0, idx).trim().replace(/,$/, "");
          keyLine = line.slice(idx);
          break;
        }
      }
    }

    const parsed = parseOpenSSHPublicKeyLine(keyLine);
    if (!parsed) {
      entries.push({ line: lineNum, raw: rawLine, error: "unparseable" });
      continue;
    }

    entries.push({
      line:           lineNum,
      type:           parsed.type,
      keyType:        parsed.keyType,
      comment:        parsed.comment,
      fingerprint:    parsed.fingerprint,
      fingerprintMd5: parsed.fingerprintMd5,
      bitLength:      parsed.bitLength,
      curve:          parsed.curve,
      options:        options || null,
      blobLength:     parsed.blobLength,
    });
  }

  const byType = {};
  for (const e of entries) {
    if (e.type) byType[e.type] = (byType[e.type] || 0) + 1;
  }

  return {
    operation: "authorized_keys",
    source:    args.path || "inline",
    total:     entries.length,
    byType,
    entries,
  };
}

// ── Operation: known_hosts ────────────────────────────────────────────────────
function opKnownHosts(args) {
  let text;
  if (args.path) {
    text = readFileGuarded(args.path);
  } else if (args.content) {
    text = args.content;
  } else {
    throw new Error("ssh_keygen known_hosts: provide 'path' or 'content'.");
  }

  const lines    = text.split(/\r?\n/);
  const entries  = [];
  const errors   = [];
  let lineNum    = 0;
  const seenHosts = new Set();
  let hashed = 0;

  for (const rawLine of lines) {
    lineNum++;
    if (entries.length + errors.length >= MAX_KNOWN_HOSTS) break;
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    // Format: [marker] hostnames keytype key [comment]
    // Marker: @cert-authority, @revoked
    let rest = line;
    let marker = null;
    if (rest.startsWith("@")) {
      const sp = rest.indexOf(" ");
      marker = rest.slice(0, sp);
      rest   = rest.slice(sp + 1).trim();
    }

    const parts = rest.split(/\s+/);
    if (parts.length < 3) {
      errors.push({ line: lineNum, error: "too few fields", raw: rawLine });
      continue;
    }

    const hostnamesRaw = parts[0];
    const keyType      = parts[1];
    const keyB64       = parts[2];
    const comment      = parts.slice(3).join(" ") || null;

    // Hashed host (|1|salt|hash|)
    const isHashed = hostnamesRaw.startsWith("|1|");
    if (isHashed) hashed++;

    let hostnames = [];
    if (!isHashed) {
      hostnames = hostnamesRaw.split(",").map(h => h.trim());
      hostnames.forEach(h => seenHosts.add(h));
    }

    // Parse key blob for fingerprint
    let fingerprint = null, fingerprintMd5 = null, bitLength = null, curve = null;
    try {
      const blob      = Buffer.from(keyB64, "base64");
      fingerprint     = "SHA256:" + crypto.createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
      fingerprintMd5  = crypto.createHash("md5").update(blob).digest("hex").replace(/(..)/g, "$1:").slice(0, -1);

      // Parse key type from blob
      if (blob.length >= 4) {
        const len0 = blob.readUInt32BE(0);
        if (len0 <= blob.length - 4) {
          const wKeyType = blob.slice(4, 4 + len0).toString();
          if (wKeyType === "ssh-rsa") {
            // e, n
            const eLen = blob.readUInt32BE(4 + len0);
            const nOff = 4 + len0 + 4 + eLen;
            const nLen = blob.readUInt32BE(nOff);
            bitLength   = (nLen - (blob[nOff + 4] === 0 ? 1 : 0)) * 8;
          } else if (wKeyType.startsWith("ecdsa-sha2-")) {
            const cOff = 4 + len0;
            const cLen = blob.readUInt32BE(cOff);
            curve       = blob.slice(cOff + 4, cOff + 4 + cLen).toString();
            bitLength   = curve === "nistp256" ? 256 : curve === "nistp384" ? 384 : curve === "nistp521" ? 521 : null;
          } else if (wKeyType === "ssh-ed25519") {
            bitLength = 256;
          }
        }
      }
    } catch {
      // Fingerprint is best-effort
    }

    entries.push({
      line:           lineNum,
      marker:         marker || null,
      hostnamesRaw,
      hostnames:      isHashed ? null : hostnames,
      hashed:         isHashed,
      keyType,
      comment,
      fingerprint,
      fingerprintMd5,
      bitLength,
      curve,
    });
  }

  const byKeyType = {};
  for (const e of entries) {
    byKeyType[e.keyType] = (byKeyType[e.keyType] || 0) + 1;
  }

  return {
    operation:     "known_hosts",
    source:        args.path || "inline",
    total:         entries.length,
    hashed,
    unhashed:      entries.length - hashed,
    uniqueHosts:   seenHosts.size,
    errorCount:    errors.length,
    byKeyType,
    entries,
    errors,
  };
}

// ── Main export ────────────────────────────────────────────────────────────────
function sshKeygen(args) {
  const op = args.operation;
  if (!op) throw new Error("ssh_keygen: 'operation' is required.");

  const VALID_OPS = ["generate", "inspect", "fingerprint", "convert", "validate", "authorized_keys", "known_hosts"];
  if (!VALID_OPS.includes(op))
    throw new Error(`ssh_keygen: unknown operation '${op}'. Valid: ${VALID_OPS.join(", ")}.`);

  switch (op) {
    case "generate":        return opGenerate(args);
    case "inspect":         return opInspect(args);
    case "fingerprint":     return opFingerprint(args);
    case "convert":         return opConvert(args);
    case "validate":        return opValidate(args);
    case "authorized_keys": return opAuthorizedKeys(args);
    case "known_hosts":     return opKnownHosts(args);
    default:
      throw new Error(`ssh_keygen: unhandled operation '${op}'.`);
  }
}

module.exports = { sshKeygen };
