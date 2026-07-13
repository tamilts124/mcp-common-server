"use strict";

const tftpClientSchema = {
  name: "tftp_client",
  description: "Zero-dependency TFTP (Trivial File Transfer Protocol) client (pure Node.js dgram built-in; no npm deps). Implements RFC 1350 (protocol), RFC 2347 (option extension), RFC 2348 (blocksize), RFC 2349 (tsize). Transport: UDP. Operations: get (download a file via RRQ), put (upload data via WRQ), info (return protocol/config table, no I/O). Modes: octet (binary, default) and netascii (text with \\n\u2194\\r\\n conversion). Supports blksize option negotiation (8\u201365464 bytes). TID verification (unknown-port protection). Sorcerer's Apprentice Syndrome prevention. Timeout: 1s\u201360s (default 5s); up to 3 retransmits per block.",
  inputSchema: {
    type: "object",
    required: ["operation"],
    properties: {
      operation: {
        type: "string",
        enum: ["get", "put", "info"],
        description: "Operation to perform. get=download file from server (RRQ). put=upload data to server (WRQ). info=return protocol info (no I/O).",
      },
      host: {
        type: "string",
        description: "TFTP server hostname or IP address (required for get/put). E.g. '192.168.1.1', 'tftp.example.com'.",
      },
      port: {
        type: "number",
        description: "TFTP server UDP port (default: 69). Range: 1\u201365535.",
      },
      filename: {
        type: "string",
        description: "Filename on the TFTP server (required for get/put). E.g. 'firmware.bin', 'configs/router.cfg', 'pxelinux.0'.",
      },
      mode: {
        type: "string",
        enum: ["octet", "netascii"],
        description: "Transfer mode (default: 'octet'). 'octet' = raw binary (recommended for all files). 'netascii' = text with \\n\u2194\\r\\n conversion per RFC 764.",
      },
      timeout: {
        type: "number",
        description: "Operation timeout in milliseconds per block/ack (default: 5000, range: 1000\u201360000). Up to 3 retransmits before failing.",
      },
      block_size: {
        type: "number",
        description: "TFTP block size in bytes for RFC 2348 blksize option negotiation (default: 512, range: 8\u201365464). Larger block sizes improve throughput on fast LANs but may cause fragmentation.",
      },
      use_options: {
        type: "boolean",
        description: "Whether to request RFC 2347/2348/2349 TFTP options (blksize, tsize) in the initial request (default: true). Set false for strict RFC 1350 compatibility with older servers.",
      },
      output_encoding: {
        type: "string",
        enum: ["base64", "utf8", "text"],
        description: "How to encode the downloaded file content in the response (get only). 'base64' (default) = raw bytes as base64 string suitable for binary files. 'utf8'/'text' = decoded as UTF-8 text.",
      },
      data: {
        type: "string",
        description: "Base64-encoded binary data to upload (put only). Use for binary files (firmware, images). Mutually exclusive with 'content'.",
      },
      content: {
        type: "string",
        description: "Text string to upload as file content (put only). Encoded as UTF-8; in netascii mode \\n is converted to \\r\\n. Mutually exclusive with 'data'.",
      },
    },
  },
};

module.exports = { tftpClientSchema };
