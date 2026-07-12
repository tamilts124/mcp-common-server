"use strict";
// lib/grpcClientOps.js — Zero-dependency gRPC client
// Uses Node.js built-in `http2` only. No npm dependencies.
//
// gRPC-over-HTTP/2 wire protocol:
//   https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md
//
// Supported operations:
//   unary         — single request/response gRPC call
//   server_stream — collect all messages from a server-streaming RPC
//   health_check  — gRPC Health Protocol v1 (grpc.health.v1.Health/Check)
//   list_services — gRPC Server Reflection v1alpha (list available services)
//
// Proto3 wire format (hand-built, no protobufjs):
//   - Varint encoding/decoding (LEB128)
//   - Length-delimited, fixed32, fixed64 wire types

const http2 = require("http2");

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_MESSAGE_SIZE   = 16 * 1024 * 1024;  // 16 MB per-message cap
const MAX_STREAM_MSGS    = 1000;               // max messages to collect in server_stream
const DEFAULT_DEADLINE   = 30;                 // seconds

// gRPC status codes
const GRPC_STATUS = {
  0: "OK", 1: "CANCELLED", 2: "UNKNOWN", 3: "INVALID_ARGUMENT",
  4: "DEADLINE_EXCEEDED", 5: "NOT_FOUND", 6: "ALREADY_EXISTS",
  7: "PERMISSION_DENIED", 8: "RESOURCE_EXHAUSTED", 9: "FAILED_PRECONDITION",
  10: "ABORTED", 11: "OUT_OF_RANGE", 12: "UNIMPLEMENTED", 13: "INTERNAL",
  14: "UNAVAILABLE", 15: "DATA_LOSS", 16: "UNAUTHENTICATED",
};

// ─── Proto3 Varint Codec ──────────────────────────────────────────────────────

function encodeVarint(value) {
  const chunks = [];
  let n = typeof value === "bigint" ? value : BigInt(value);
  while (n > 127n) {
    chunks.push(Number(n & 0xffn) | 0x80);
    n >>= 7n;
  }
  chunks.push(Number(n & 0x7fn));
  return Buffer.from(chunks);
}

function decodeVarint(buf, offset) {
  let result = 0n;
  let shift  = 0n;
  let i      = offset;
  while (i < buf.length) {
    const byte = buf[i++];
    result |= BigInt(byte & 0x7f) << shift;
    shift += 7n;
    if (!(byte & 0x80)) break;
    if (shift > 63n) throw new Error("grpc_client: varint overflow (>64 bits).");
  }
  return { value: result, bytesRead: i - offset };
}

function encodeField(fieldNumber, wireType, value) {
  const tag = encodeVarint((fieldNumber << 3) | wireType);
  return Buffer.concat([tag, value]);
}

function encodeBytes(fieldNumber, buf) {
  return encodeField(fieldNumber, 2, Buffer.concat([encodeVarint(buf.length), buf]));
}

function encodeString(fieldNumber, str) {
  return encodeBytes(fieldNumber, Buffer.from(str, "utf8"));
}

function encodeVarintField(fieldNumber, value) {
  return encodeField(fieldNumber, 0, encodeVarint(value));
}

function decodeFields(buf) {
  const fields = [];
  let pos = 0;
  while (pos < buf.length) {
    const tagResult = decodeVarint(buf, pos);
    pos += tagResult.bytesRead;
    const tag         = tagResult.value;
    const fieldNumber = Number(tag >> 3n);
    const wireType    = Number(tag & 0x7n);

    if (wireType === 0) {
      const { value, bytesRead } = decodeVarint(buf, pos);
      pos += bytesRead;
      fields.push({ fieldNumber, wireType, value });
    } else if (wireType === 2) {
      const { value: len, bytesRead } = decodeVarint(buf, pos);
      pos += bytesRead;
      const lenN = Number(len);
      if (pos + lenN > buf.length)
        throw new Error(`grpc_client: truncated length-delimited field at pos ${pos}.`);
      fields.push({ fieldNumber, wireType, value: buf.slice(pos, pos + lenN) });
      pos += lenN;
    } else if (wireType === 1) {
      if (pos + 8 > buf.length) throw new Error("grpc_client: truncated 64-bit field.");
      fields.push({ fieldNumber, wireType, value: buf.slice(pos, pos + 8) });
      pos += 8;
    } else if (wireType === 5) {
      if (pos + 4 > buf.length) throw new Error("grpc_client: truncated 32-bit field.");
      fields.push({ fieldNumber, wireType, value: buf.slice(pos, pos + 4) });
      pos += 4;
    } else {
      throw new Error(`grpc_client: unknown wire type ${wireType} at pos ${pos}.`);
    }
  }
  return fields;
}

// ─── gRPC-over-HTTP/2 Framing ────────────────────────────────────────────────

function grpcFrame(msgBuf) {
  const header = Buffer.alloc(5);
  header[0] = 0x00; // no compression
  header.writeUInt32BE(msgBuf.length, 1);
  return Buffer.concat([header, msgBuf]);
}

function parseGrpcFrames(raw) {
  const messages = [];
  let pos = 0;
  while (pos + 5 <= raw.length) {
    const compressed = raw[pos] !== 0;
    const msgLen     = raw.readUInt32BE(pos + 1);
    if (pos + 5 + msgLen > raw.length) break;
    const data = raw.slice(pos + 5, pos + 5 + msgLen);
    messages.push({ compressed, data });
    pos += 5 + msgLen;
  }
  return { messages, remaining: raw.slice(pos) };
}

// ─── Security Guards ─────────────────────────────────────────────────────────

function validateHost(host) {
  if (typeof host !== "string" || host.length === 0)
    throw new Error("grpc_client: 'host' must be a non-empty string.");
  if (/[\x00\r\n]/.test(host))
    throw new Error("grpc_client: 'host' contains invalid characters (NUL/CR/LF).");
  if (host.length > 253)
    throw new Error("grpc_client: 'host' too long (max 253 chars).");
}

function validateMethod(method) {
  if (typeof method !== "string" || method.length === 0)
    throw new Error("grpc_client: 'method' must be a non-empty string.");
  if (!/^\/[A-Za-z0-9_.]+\/[A-Za-z0-9_]+$/.test(method))
    throw new Error(
      `grpc_client: 'method' must be in the form '/package.Service/MethodName' (got: '${method}').`
    );
}

// ─── HTTP/2 gRPC Call ─────────────────────────────────────────────────────────

function grpcHttp2Call(opts) {
  const {
    host, port, secure, method, requestBuf, timeout, metadata, maxMessages, rejectUnauthorized,
  } = opts;

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer   = null;
    let session = null;

    function settle(err, result) {
      if (settled) return;
      settled = true;
      if (timer) { clearTimeout(timer); timer = null; }
      if (session) { try { session.close(); } catch (_) { /* ignore */ } }
      if (err) reject(err);
      else     resolve(result);
    }

    timer = setTimeout(() => {
      settle(new Error(`grpc_client: operation timeout after ${timeout}ms.`));
    }, timeout);

    const authority = `${secure ? "https" : "http"}://${host}:${port}`;
    const sessionOpts = secure ? { rejectUnauthorized: rejectUnauthorized !== false } : {};

    try {
      session = http2.connect(authority, sessionOpts);
    } catch (err) {
      settle(new Error(`grpc_client: failed to create HTTP/2 session — ${err.message}`));
      return;
    }

    session.on("error", (err) => {
      settle(new Error(`grpc_client: HTTP/2 session error — ${err.message}`));
    });

    // http2.connect fires 'connect' when session is ready
    session.on("connect", () => {
      const headers = {
        ":method":      "POST",
        ":path":        method,
        ":scheme":      secure ? "https" : "http",
        ":authority":   `${host}:${port}`,
        "content-type": "application/grpc",
        "te":           "trailers",
        "grpc-timeout": `${Math.ceil(timeout / 1000)}S`,
        "user-agent":   "grpc-node-zero-dep/1.0",
        ...metadata,
      };

      let req;
      try {
        req = session.request(headers, { endStream: false });
      } catch (err) {
        settle(new Error(`grpc_client: failed to create HTTP/2 stream — ${err.message}`));
        return;
      }

      const rawChunks  = [];
      let totalBytes   = 0;
      let trailers     = {};
      let grpcStatus   = null;
      let grpcMsg      = "";
      const msgCap     = MAX_MESSAGE_SIZE * Math.max(1, maxMessages || 1) + 65536;

      req.on("response", (resHeaders) => {
        const httpStatus = resHeaders[":status"];
        if (httpStatus !== 200) {
          settle(new Error(`grpc_client: HTTP/2 response status ${httpStatus} (expected 200).`));
        }
      });

      req.on("data", (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > msgCap) {
          settle(new Error(`grpc_client: response too large (>${msgCap} bytes).`));
          return;
        }
        rawChunks.push(chunk);
      });

      req.on("trailers", (trailersObj) => {
        trailers   = Object.assign({}, trailersObj);
        grpcStatus = parseInt(trailers["grpc-status"] ?? "0", 10);
        grpcMsg    = trailers["grpc-message"]
          ? decodeURIComponent(trailers["grpc-message"])
          : (GRPC_STATUS[grpcStatus] ?? "");
      });

      req.on("end", () => {
        const raw = Buffer.concat(rawChunks);
        let messages;
        try {
          ({ messages } = parseGrpcFrames(raw));
        } catch (err) {
          settle(new Error(`grpc_client: frame parse error — ${err.message}`));
          return;
        }
        const cap = maxMessages || MAX_STREAM_MSGS;
        const truncated = messages.length > cap;
        if (truncated) messages = messages.slice(0, cap);

        settle(null, {
          messages:      messages.map(m => m.data),
          trailers,
          status:        grpcStatus ?? 0,
          statusMessage: grpcMsg,
          truncated,
        });
      });

      req.on("error", (err) => {
        settle(new Error(`grpc_client: stream error — ${err.message}`));
      });

      req.write(requestBuf);
      req.end();
    });
  });
}

// ─── Health Check Codec ───────────────────────────────────────────────────────

const HEALTH_STATUS = ["UNKNOWN", "SERVING", "NOT_SERVING", "SERVICE_UNKNOWN"];

function encodeHealthCheckRequest(service) {
  if (!service) return Buffer.alloc(0);
  return encodeString(1, service);
}

function decodeHealthCheckResponse(buf) {
  const fields = decodeFields(buf);
  const sf = fields.find(f => f.fieldNumber === 1 && f.wireType === 0);
  const code = sf ? Number(sf.value) : 0;
  return {
    status:     code,
    statusName: HEALTH_STATUS[code] ?? `UNKNOWN(${code})`,
    serving:    code === 1,
  };
}

// ─── Reflection Codec ────────────────────────────────────────────────────────

function encodeReflectionListServicesRequest(host) {
  const hostField = host ? encodeString(1, host) : Buffer.alloc(0);
  const listField = encodeString(4, ""); // list_services string = ""
  return Buffer.concat([hostField, listField]);
}

function decodeReflectionListServicesResponse(buf) {
  const fields = decodeFields(buf);
  const services = [];
  for (const f of fields) {
    if (f.fieldNumber === 4 && f.wireType === 2) {
      // ListServiceResponse
      const innerFields = decodeFields(f.value);
      for (const inner of innerFields) {
        if (inner.fieldNumber === 1 && inner.wireType === 2) {
          // ServiceResponse
          const nfs = decodeFields(inner.value);
          for (const nf of nfs) {
            if (nf.fieldNumber === 1 && nf.wireType === 2)
              services.push(nf.value.toString("utf8"));
          }
        }
      }
    } else if (f.fieldNumber === 7 && f.wireType === 2) {
      const errFields = decodeFields(f.value);
      let code = 0; let msg = "";
      for (const ef of errFields) {
        if (ef.fieldNumber === 1 && ef.wireType === 0) code = Number(ef.value);
        if (ef.fieldNumber === 2 && ef.wireType === 2) msg = ef.value.toString("utf8");
      }
      throw new Error(`grpc_client: reflection error ${code} — ${msg || "unknown"}`);
    }
  }
  return services;
}

// ─── Decode helper for unary/stream response fields ──────────────────────────

function decodeResponseFields(msgBuf) {
  const fields = decodeFields(msgBuf);
  return fields.map(f => ({
    fieldNumber: f.fieldNumber,
    wireType:    f.wireType,
    value: f.wireType === 2
      ? f.value.toString("utf8")
      : f.wireType === 0
        ? Number(f.value)
        : f.value.toString("hex"),
  }));
}

// ─── Public API ───────────────────────────────────────────────────────────────

async function grpcClient(args) {
  const host    = args.host    ?? "127.0.0.1";
  const port    = args.port    ?? 50051;
  const op      = args.operation;
  const secure  = args.secure  ?? false;
  const timeout = ((args.timeout != null) ? args.timeout : DEFAULT_DEADLINE) * 1000;
  const rejectUnauthorized = args.reject_unauthorized;

  validateHost(host);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("grpc_client: 'port' must be an integer 1–65535.");

  const baseOpts = {
    host, port, secure, timeout, rejectUnauthorized,
    metadata: args.metadata ?? {},
  };

  switch (op) {

    // ── UNARY ─────────────────────────────────────────────────────────────
    case "unary": {
      validateMethod(args.method);

      let requestProto;
      if (args.request_base64 != null) {
        requestProto = Buffer.from(args.request_base64, "base64");
      } else if (args.request_json != null) {
        const jsonStr = typeof args.request_json === "string"
          ? args.request_json
          : JSON.stringify(args.request_json);
        requestProto = encodeString(1, jsonStr);
      } else {
        requestProto = Buffer.alloc(0);
      }

      const requestBuf = grpcFrame(requestProto);
      const result = await grpcHttp2Call({ ...baseOpts, method: args.method, requestBuf, maxMessages: 1 });

      if (result.status !== 0)
        throw new Error(
          `grpc_client: gRPC error ${result.status} (${result.statusMessage || (GRPC_STATUS[result.status] ?? "UNKNOWN")}).`
        );

      const msgBuf = result.messages[0] ?? Buffer.alloc(0);
      let response;
      if (args.response_encoding === "base64" || args.response_encoding === "raw") {
        response = { base64: msgBuf.toString("base64"), bytes: msgBuf.length };
      } else {
        try {
          response = { fields: decodeResponseFields(msgBuf), base64: msgBuf.toString("base64"), bytes: msgBuf.length };
        } catch (_) {
          response = { base64: msgBuf.toString("base64"), bytes: msgBuf.length };
        }
      }

      return { method: args.method, status: result.status, statusMessage: result.statusMessage,
               ok: true, response, trailers: result.trailers };
    }

    // ── SERVER_STREAM ─────────────────────────────────────────────────────
    case "server_stream": {
      validateMethod(args.method);

      let requestProto;
      if (args.request_base64 != null) {
        requestProto = Buffer.from(args.request_base64, "base64");
      } else if (args.request_json != null) {
        const jsonStr = typeof args.request_json === "string"
          ? args.request_json : JSON.stringify(args.request_json);
        requestProto = encodeString(1, jsonStr);
      } else {
        requestProto = Buffer.alloc(0);
      }

      const maxMessages = Math.min(args.max_messages ?? MAX_STREAM_MSGS, MAX_STREAM_MSGS);
      const requestBuf  = grpcFrame(requestProto);
      const result = await grpcHttp2Call({ ...baseOpts, method: args.method, requestBuf, maxMessages });

      if (result.status !== 0)
        throw new Error(
          `grpc_client: gRPC error ${result.status} (${result.statusMessage || (GRPC_STATUS[result.status] ?? "UNKNOWN")}).`
        );

      const messages = result.messages.map((msgBuf, i) => {
        if (args.response_encoding === "base64" || args.response_encoding === "raw")
          return { index: i, base64: msgBuf.toString("base64"), bytes: msgBuf.length };
        try {
          return { index: i, fields: decodeResponseFields(msgBuf),
                   base64: msgBuf.toString("base64"), bytes: msgBuf.length };
        } catch (_) {
          return { index: i, base64: msgBuf.toString("base64"), bytes: msgBuf.length };
        }
      });

      return { method: args.method, status: result.status, statusMessage: result.statusMessage,
               ok: true, messageCount: messages.length, truncated: result.truncated,
               messages, trailers: result.trailers };
    }

    // ── HEALTH_CHECK ──────────────────────────────────────────────────────
    case "health_check": {
      const service    = args.service ?? "";
      const reqProto   = encodeHealthCheckRequest(service);
      const requestBuf = grpcFrame(reqProto);

      const result = await grpcHttp2Call({
        ...baseOpts,
        method:      "/grpc.health.v1.Health/Check",
        requestBuf,
        maxMessages: 1,
      });

      if (result.status !== 0 && result.status !== 5)
        throw new Error(
          `grpc_client: health_check gRPC error ${result.status} — ${result.statusMessage || (GRPC_STATUS[result.status] ?? "UNKNOWN")}.`
        );

      if (result.status === 5) {
        return { service, status: "SERVICE_UNKNOWN", statusCode: 3, serving: false, grpcStatus: 5 };
      }

      const msgBuf = result.messages[0] ?? Buffer.alloc(0);
      let decoded;
      try { decoded = decodeHealthCheckResponse(msgBuf); }
      catch (err) { throw new Error(`grpc_client: health_check parse error — ${err.message}`); }

      return {
        service, status: decoded.statusName, statusCode: decoded.status,
        serving: decoded.serving, grpcStatus: result.status,
      };
    }

    // ── LIST_SERVICES ─────────────────────────────────────────────────────
    case "list_services": {
      const reqProto   = encodeReflectionListServicesRequest(host);
      const requestBuf = grpcFrame(reqProto);

      const result = await grpcHttp2Call({
        ...baseOpts,
        method:      "/grpc.reflection.v1alpha.ServerReflection/ServerReflectionInfo",
        requestBuf,
        maxMessages: MAX_STREAM_MSGS,
      });

      if (result.status !== 0)
        throw new Error(
          `grpc_client: list_services gRPC error ${result.status} — ` +
          `${result.statusMessage || (GRPC_STATUS[result.status] ?? "UNKNOWN")}. ` +
          `Server may not support gRPC Server Reflection.`
        );

      const services = [];
      for (const msgBuf of result.messages) {
        try { services.push(...decodeReflectionListServicesResponse(msgBuf)); }
        catch (err) { throw new Error(`grpc_client: reflection parse error — ${err.message}`); }
      }

      return { host, port, serviceCount: services.length, services };
    }

    default:
      throw new Error(
        `grpc_client: unknown operation '${op}'. Valid: unary, server_stream, health_check, list_services.`
      );
  }
}

module.exports = {
  grpcClient,
  _proto: {
    encodeVarint, decodeVarint, encodeField, encodeBytes,
    encodeString, encodeVarintField, decodeFields,
    grpcFrame, parseGrpcFrames,
    encodeHealthCheckRequest, decodeHealthCheckResponse,
    encodeReflectionListServicesRequest, decodeReflectionListServicesResponse,
  },
};
