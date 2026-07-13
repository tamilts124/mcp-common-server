"use strict";
// utilSchemas73: ssh_keygen

const UTIL_SCHEMAS_73 = [
  {
    name: "ssh_keygen",
    description:
      "Zero-dependency SSH key inspector and generator (pure Node.js crypto; no npm deps). " +
      "Operations: " +
      "generate (create RSA/ECDSA/Ed25519/Ed448 key pair — returns privateKey PEM, publicKey in OpenSSH authorized_keys format, publicKeyPem, fingerprint, algorithm, bitLength, curve, encrypted flag); " +
      "inspect (parse a PEM private/public key or an OpenSSH public key line and return algorithm, role, sshKeyType, bitLength, curve, fingerprint in SHA256 and MD5 formats); " +
      "fingerprint (extract only the SHA256 and MD5 fingerprints from a PEM or OpenSSH public key line — fast single-purpose operation); " +
      "convert (reformat a PEM key to pkcs8 private PEM, spki public PEM, or openssh-pub authorized_keys line); " +
      "validate (check whether a private key and a public key form a matching pair — compares derived SPKI or fingerprints); " +
      "authorized_keys (parse an ~/.ssh/authorized_keys file or inline content — returns per-entry type, fingerprint, comment, bitLength, curve, options, and a byType breakdown); " +
      "known_hosts (parse an ~/.ssh/known_hosts file or inline content — returns per-entry hostnames, keyType, fingerprint, hashed flag, marker, and a byKeyType breakdown). " +
      "Supported algorithms: RSA (1024–8192 bits), ECDSA P-256/P-384/P-521, Ed25519, Ed448. " +
      "Supported PEM formats: PKCS#8, SEC1 (EC), PKCS#1 (RSA), OpenSSH private, SPKI public. " +
      "Security: key-size guards (RSA min 1024, max 8192 bits, multiple of 8); 4 MB file cap; NUL-byte path guard; directory guard.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["generate", "inspect", "fingerprint", "convert", "validate", "authorized_keys", "known_hosts"],
          description:
            "generate: create a new key pair (returns privateKey, publicKey, fingerprint, metadata). " +
            "inspect: parse and describe an existing key (PEM or OpenSSH public key line). " +
            "fingerprint: extract SHA256 and MD5 fingerprints only. " +
            "convert: reformat a key to a different PEM/OpenSSH encoding. " +
            "validate: check whether a private key and public key are a matching pair. " +
            "authorized_keys: parse an authorized_keys file or inline string. " +
            "known_hosts: parse a known_hosts file or inline string.",
        },
        // generate
        type: {
          type: "string",
          enum: ["rsa", "ecdsa", "ec", "ed25519", "ed448"],
          description: "[generate] Key algorithm. Default: ed25519.",
        },
        bits: {
          type: "number",
          description: "[generate, rsa] RSA modulus size in bits (1024–8192, must be a multiple of 8; default: 4096).",
        },
        curve: {
          type: "string",
          enum: ["P-256", "P-384", "P-521", "nistp256", "nistp384", "nistp521"],
          description: "[generate, ecdsa] Named curve. Default: P-256.",
        },
        comment: {
          type: "string",
          description: "[generate, convert→openssh-pub] Comment appended to the public key line (e.g. 'user@hostname'). Default: empty.",
        },
        passphrase: {
          type: "string",
          description: "[generate] Encrypt the private key with AES-256-CBC using this passphrase. Omit for an unencrypted key.",
        },
        public_exponent: {
          type: "number",
          description: "[generate, rsa] RSA public exponent (default: 65537).",
        },
        // inspect / fingerprint / convert
        path: {
          type: "string",
          description: "[inspect, fingerprint, convert] Absolute path to the key file to read (PEM or OpenSSH public key line).",
        },
        key: {
          type: "string",
          description: "[inspect, fingerprint, convert, validate] PEM-encoded key string (private or public). Provide 'key' or 'path', not both.",
        },
        public_key: {
          type: "string",
          description: "[inspect, fingerprint, validate] OpenSSH public key line (e.g. 'ssh-ed25519 AAAA... user@host') or PEM public key string.",
        },
        // convert
        to: {
          type: "string",
          enum: ["pem", "pkcs8", "openssh-pub", "spki"],
          description:
            "[convert] Target format. " +
            "pem/spki: export the public key as SPKI PEM. " +
            "pkcs8: export the private key as PKCS#8 PEM (private key input required). " +
            "openssh-pub: export as an OpenSSH authorized_keys public key line.",
        },
        // validate
        private_key: {
          type: "string",
          description: "[validate] PEM-encoded private key string.",
        },
        // authorized_keys / known_hosts
        content: {
          type: "string",
          description: "[authorized_keys, known_hosts] Inline file content to parse (instead of 'path').",
        },
      },
      required: ["operation"],
    },
  },
];

module.exports = { UTIL_SCHEMAS_73 };
