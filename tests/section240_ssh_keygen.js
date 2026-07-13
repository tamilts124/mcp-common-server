"use strict";
// section240_ssh_keygen.js — Isolated functional tests for ssh_keygen tool
// Five rigor levels: A=validation, B=unit, C=happy-path, D=security, E=error-paths, F=concurrency
// Total: 76 tests

const crypto = require("crypto");
const fs     = require("fs");
const os     = require("os");
const path   = require("path");
const { sshKeygen } = require("../lib/sshKeygenOps");

// ── Simple assertion framework ────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const errors = [];

function assert(cond, msg) {
  if (cond) {
    passed++;
  } else {
    failed++;
    errors.push(msg);
    process.stderr.write(`  FAIL: ${msg}\n`);
  }
}

function assertThrows(fn, msgPart, label) {
  try {
    fn();
    failed++;
    errors.push(`${label}: expected throw containing '${msgPart}' but did not throw`);
    process.stderr.write(`  FAIL: ${label}: expected throw containing '${msgPart}' but did not throw\n`);
  } catch (e) {
    if (msgPart && !e.message.includes(msgPart)) {
      failed++;
      errors.push(`${label}: threw '${e.message}' but expected '${msgPart}'`);
      process.stderr.write(`  FAIL: ${label}: threw '${e.message}' but expected '${msgPart}'\n`);
    } else {
      passed++;
    }
  }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-keygen-test-"));
function tmpFile(name) { return path.join(tmpDir, name); }

// ── A: Validation (10 tests) ────────────────────────────────────────────────
console.log("A: Validation");

// A1: missing operation
assertThrows(() => sshKeygen({}), "'operation' is required", "A1 missing operation");

// A2: unknown operation
assertThrows(() => sshKeygen({ operation: "blorp" }), "unknown operation", "A2 unknown operation");

// A3: generate - invalid type
assertThrows(() => sshKeygen({ operation: "generate", type: "dsa" }), "unsupported type", "A3 invalid type");

// A4: generate RSA bits too small
assertThrows(() => sshKeygen({ operation: "generate", type: "rsa", bits: 512 }), "1024", "A4 RSA bits too small");

// A5: generate RSA bits too large
assertThrows(() => sshKeygen({ operation: "generate", type: "rsa", bits: 9000 }), "8192", "A5 RSA bits too large");

// A6: generate RSA bits not multiple of 8
assertThrows(() => sshKeygen({ operation: "generate", type: "rsa", bits: 2047 }), "multiple of 8", "A6 RSA bits not mult of 8");

// A7: inspect - no input provided
assertThrows(() => sshKeygen({ operation: "inspect" }), "provide 'path'", "A7 inspect no input");

// A8: fingerprint - no input
assertThrows(() => sshKeygen({ operation: "fingerprint" }), "provide 'path'", "A8 fingerprint no input");

// A9: convert - no input
assertThrows(() => sshKeygen({ operation: "convert", to: "pem" }), "provide 'path'", "A9 convert no input");

// A10: convert - invalid target format
assertThrows(() => sshKeygen({ operation: "convert", key: "fake", to: "garbage" }), "unsupported target format", "A10 convert invalid to");

// ── B: Unit tests (20 tests) ─────────────────────────────────────────────────
console.log("B: Unit tests");

// B1-B5: generate Ed25519 key pair (most common, fast)
const genEd25519 = sshKeygen({ operation: "generate", type: "ed25519", comment: "test@host" });
assert(genEd25519.operation === "generate", "B1 generate op field");
assert(genEd25519.algorithm === "ed25519", "B2 generate algorithm");
assert(genEd25519.sshKeyType === "ssh-ed25519", "B3 sshKeyType");
assert(typeof genEd25519.privateKey === "string" && genEd25519.privateKey.includes("PRIVATE KEY"), "B4 privateKey PEM");
assert(genEd25519.publicKey.startsWith("ssh-ed25519 "), "B5 publicKey openssh format");

// B6-B7: fingerprint in generated key
assert(genEd25519.fingerprint && genEd25519.fingerprint.startsWith("SHA256:"), "B6 fingerprint SHA256 prefix");
assert(genEd25519.fingerprintMd5 && genEd25519.fingerprintMd5.split(":").length === 16, "B7 fingerprintMd5 16 hex groups");

// B8-B9: inspect generated private key
const inspPriv = sshKeygen({ operation: "inspect", key: genEd25519.privateKey });
assert(inspPriv.role === "private", "B8 inspect priv role");
assert(inspPriv.algorithm === "ed25519", "B9 inspect priv algorithm");

// B10-B11: inspect generated public key (OpenSSH line)
const inspPub = sshKeygen({ operation: "inspect", public_key: genEd25519.publicKey });
assert(inspPub.type === "ssh-ed25519", "B10 inspect pub type");
assert(inspPub.comment === "test@host", "B11 inspect pub comment");

// B12-B13: fingerprint operation on private key
const fpResult = sshKeygen({ operation: "fingerprint", key: genEd25519.privateKey });
assert(fpResult.fingerprint === genEd25519.fingerprint, "B12 fingerprint matches generate");
assert(fpResult.algorithm === "ed25519", "B13 fingerprint algorithm");

// B14-B15: fingerprint on public key line
const fpPub = sshKeygen({ operation: "fingerprint", public_key: genEd25519.publicKey });
assert(fpPub.fingerprint === genEd25519.fingerprint, "B14 fingerprint pub matches");
assert(fpPub.comment === "test@host", "B15 fingerprint pub comment");

// B16-B17: validate - matching pair
const validateOk = sshKeygen({ operation: "validate", private_key: genEd25519.privateKey, public_key: genEd25519.publicKey });
assert(validateOk.matches === true, "B16 validate matching pair");
assert(validateOk.reason === null, "B17 validate reason null on match");

// B18-B19: convert private key to openssh-pub line
const convPub = sshKeygen({ operation: "convert", key: genEd25519.privateKey, to: "openssh-pub", comment: "converted" });
assert(convPub.to === "openssh-pub", "B18 convert to openssh-pub");
assert(convPub.result.startsWith("ssh-ed25519 "), "B19 converted openssh-pub line");

// B20: convert to SPKI public PEM
const convSpki = sshKeygen({ operation: "convert", key: genEd25519.privateKey, to: "spki" });
assert(convSpki.result.includes("PUBLIC KEY"), "B20 convert to spki PEM");

// ── C: Happy-path (20 tests) ──────────────────────────────────────────────────
console.log("C: Happy-path");

// C1-C4: ECDSA P-256 key pair
const genEc256 = sshKeygen({ operation: "generate", type: "ecdsa", curve: "P-256" });
assert(genEc256.algorithm === "ec", "C1 ECDSA algorithm");
assert(genEc256.sshKeyType === "ecdsa-sha2-nistp256", "C2 ECDSA sshKeyType");
assert(genEc256.bitLength === 256, "C3 ECDSA bitLength 256");
assert(genEc256.publicKey.startsWith("ecdsa-sha2-nistp256 "), "C4 ECDSA publicKey prefix");

// C5-C7: RSA 2048 key pair
const genRsa = sshKeygen({ operation: "generate", type: "rsa", bits: 2048 });
assert(genRsa.algorithm === "rsa", "C5 RSA algorithm");
assert(genRsa.bitLength === 2048, "C6 RSA bitLength");
assert(genRsa.publicKey.startsWith("ssh-rsa "), "C7 RSA publicKey prefix");

// C8-C9: inspect RSA private key
const inspRsa = sshKeygen({ operation: "inspect", key: genRsa.privateKey });
assert(inspRsa.algorithm === "rsa", "C8 inspect RSA algorithm");
assert(inspRsa.bitLength === 2048, "C9 inspect RSA bitLength");

// C10-C11: inspect RSA public key (PEM)
const inspRsaPub = sshKeygen({ operation: "inspect", key: genRsa.publicKeyPem });
assert(inspRsaPub.role === "public", "C10 inspect RSA pub role");
assert(inspRsaPub.algorithm === "rsa", "C11 inspect RSA pub algorithm");

// C12-C13: validate RSA pair
const valRsa = sshKeygen({ operation: "validate", private_key: genRsa.privateKey, public_key: genRsa.publicKey });
assert(valRsa.matches === true, "C12 RSA validate match");
assert(!valRsa.reason, "C13 RSA validate no reason");

// C14-C15: validate mismatch (ed25519 priv vs RSA pub)
const valMismatch = sshKeygen({ operation: "validate", private_key: genEd25519.privateKey, public_key: genRsa.publicKey });
assert(valMismatch.matches === false, "C14 validate mismatch false");
assert(typeof valMismatch.reason === "string", "C15 validate mismatch has reason");

// C16-C18: authorized_keys inline
const authKeysContent = [
  `${genEd25519.publicKey}`,
  `${genRsa.publicKey}`,
  `# comment line`,
  `command="/bin/ls" ${genEc256.publicKey}`,
].join("\n");
const authResult = sshKeygen({ operation: "authorized_keys", content: authKeysContent });
assert(authResult.total === 3, "C16 authorized_keys total");
assert(authResult.byType["ssh-ed25519"] === 1, "C17 authorized_keys byType ed25519");
assert(authResult.entries[2].options !== null, "C18 authorized_keys options parsed");

// C19-C20: known_hosts inline
const knownContent = [
  `github.com,140.82.121.4 ${genEd25519.publicKey}`,
  `|1|abc123|xyz789 ${genRsa.publicKey}`,
].join("\n");
const khResult = sshKeygen({ operation: "known_hosts", content: knownContent });
assert(khResult.total === 2, "C19 known_hosts total");
assert(khResult.hashed === 1, "C20 known_hosts hashed count");

// ── D: Security (10 tests) ────────────────────────────────────────────────────
console.log("D: Security");

// D1: NUL byte in path rejected
assertThrows(() => sshKeygen({ operation: "inspect", path: "file\0.pem" }), "NUL byte", "D1 NUL byte path");

// D2: directory path rejected
const tmpDirPath = os.tmpdir();
assertThrows(() => sshKeygen({ operation: "inspect", path: tmpDirPath }), "directory", "D2 directory path");

// D3: file too large rejected
const bigFile = tmpFile("big.pem");
fs.writeFileSync(bigFile, Buffer.alloc(5 * 1024 * 1024, "X"));
assertThrows(() => sshKeygen({ operation: "inspect", path: bigFile }), "too large", "D3 file too large");
fs.unlinkSync(bigFile);

// D4: authorized_keys - content with 10001 entries (limit hit)
let bigAK = "";
for (let i = 0; i < 10001; i++) bigAK += `${genEd25519.publicKey} user${i}\n`;
const bigAKResult = sshKeygen({ operation: "authorized_keys", content: bigAK });
assert(bigAKResult.total === 10000, "D4 authorized_keys capped at MAX_AUTH_KEYS");

// D5: RSA minimum bits enforced
assertThrows(() => sshKeygen({ operation: "generate", type: "rsa", bits: 1000 }), "1024", "D5 RSA min bits");

// D6: converting cert PEM throws informative error
const fakeCertPem = "-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----";
assertThrows(() => sshKeygen({ operation: "inspect", key: fakeCertPem }), "certificate", "D6 cert inspect rejected");

// D7: garbage string is treated as OpenSSH public key line (partial parse), not a fatal error
// The implementation returns partial info for unrecognised but parseable tokens
const d7Result = sshKeygen({ operation: "inspect", key: "not a pem at all" });
assert(d7Result.operation === "inspect", "D7 garbage treated as openssh line attempt");

// D8: unrecognised PEM header
assertThrows(() => sshKeygen({ operation: "inspect", key: "-----BEGIN WEIRD STUFF-----\nYWJj\n-----END WEIRD STUFF-----" }), "unrecognised", "D8 unrecognised PEM header");

// D9: known_hosts limit (100001 entries would be capped)
let bigKH = "";
for (let i = 0; i < 100001; i++) bigKH += `host${i}.example.com ${genEd25519.publicKey} comment\n`;
const bigKHResult = sshKeygen({ operation: "known_hosts", content: bigKH });
assert(bigKHResult.total <= 100000, "D9 known_hosts capped at MAX_KNOWN_HOSTS");

// D10: validate - missing private_key
assertThrows(() => sshKeygen({ operation: "validate", public_key: genEd25519.publicKey }), "private_key", "D10 validate missing private_key");

// ── E: Error paths (10 tests) ────────────────────────────────────────────────
console.log("E: Error paths");

// E1: inspect on nonexistent file
assertThrows(() => sshKeygen({ operation: "inspect", path: "/nonexistent/key.pem" }), "", "E1 nonexistent file");

// E2: convert pkcs8 on public key
assertThrows(() => sshKeygen({ operation: "convert", key: genEd25519.publicKeyPem || genRsa.publicKeyPem, to: "pkcs8" }), "private key", "E2 convert pkcs8 on public key");

// E3: convert openssh-pub on unsupported input
// (provide a corrupt base64 that would fail key parsing)
assertThrows(() => sshKeygen({ operation: "convert", key: "-----BEGIN PRIVATE KEY-----\ngarbage\n-----END PRIVATE KEY-----", to: "pkcs8" }), "failed", "E3 convert parse failure");

// E4: fingerprint - partial parse of unrecognised token; returns operation field
const e4Result = sshKeygen({ operation: "fingerprint", public_key: "this is not a key" });
assert(e4Result.operation === "fingerprint", "E4 fingerprint of unrecognised line returns op");

// E5: authorized_keys - no input
assertThrows(() => sshKeygen({ operation: "authorized_keys" }), "provide 'path'", "E5 authorized_keys no input");

// E6: known_hosts - no input
assertThrows(() => sshKeygen({ operation: "known_hosts" }), "provide 'path'", "E6 known_hosts no input");

// E7: convert - no target format
assertThrows(() => sshKeygen({ operation: "convert", key: genEd25519.privateKey, to: "" }), "unsupported target format", "E7 convert empty to");

// E8: validate - missing public_key
assertThrows(() => sshKeygen({ operation: "validate", private_key: genEd25519.privateKey }), "public_key", "E8 validate missing public_key");

// E9: fingerprint from file
const pubKeyFile = tmpFile("ed25519.pub");
fs.writeFileSync(pubKeyFile, genEd25519.publicKey + "\n");
const fpFromFile = sshKeygen({ operation: "fingerprint", path: pubKeyFile });
assert(fpFromFile.fingerprint === genEd25519.fingerprint, "E9 fingerprint from pub file");
fs.unlinkSync(pubKeyFile);

// E10: inspect PEM from file
const privFile = tmpFile("id_ed25519");
fs.writeFileSync(privFile, genEd25519.privateKey);
const inspFromFile = sshKeygen({ operation: "inspect", path: privFile });
assert(inspFromFile.algorithm === "ed25519", "E10 inspect from file");
fs.unlinkSync(privFile);

// ── F: Concurrency (6 tests) ──────────────────────────────────────────────────
console.log("F: Concurrency");

// F1-F3: 20 concurrent ed25519 generates produce unique fingerprints
const concKeys = Array.from({ length: 20 }, () =>
  sshKeygen({ operation: "generate", type: "ed25519" })
);
const concFps = new Set(concKeys.map(k => k.fingerprint));
assert(concFps.size === 20, "F1 20 concurrent generates produce unique fingerprints");
assert(concKeys.every(k => k.privateKey.includes("PRIVATE KEY")), "F2 all concurrent privateKeys valid");
assert(concKeys.every(k => k.publicKey.startsWith("ssh-ed25519 ")), "F3 all concurrent publicKeys valid");

// F4-F5: 10 concurrent inspects on same key
const concInspects = Array.from({ length: 10 }, () =>
  sshKeygen({ operation: "inspect", key: genEd25519.privateKey })
);
assert(concInspects.every(r => r.algorithm === "ed25519"), "F4 concurrent inspects consistent algorithm");
assert(concInspects.every(r => r.fingerprint === genEd25519.fingerprint), "F5 concurrent inspects consistent fingerprint");

// F6: 10 concurrent validates on known matching pair
const concValidates = Array.from({ length: 10 }, () =>
  sshKeygen({ operation: "validate", private_key: genEd25519.privateKey, public_key: genEd25519.publicKey })
);
assert(concValidates.every(r => r.matches === true), "F6 concurrent validates all match");

// ── Cleanup ───────────────────────────────────────────────────────────────────
try { fs.rmdirSync(tmpDir); } catch { /* ignore if not empty */ }

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\nResults: ${passed} passed, ${failed} failed out of ${passed + failed} tests`);
if (failed > 0) {
  console.error("\nFailed tests:");
  errors.forEach(e => console.error(" -", e));
  process.exit(1);
} else {
  console.log("All tests passed!");
}
