"use strict";

const rtspClientSchema = {
  name: "rtsp_client",
  description: "Zero-dependency RTSP (Real Time Streaming Protocol) client (pure Node.js net/tls built-ins; no npm deps). Implements RFC 2326 (RTSP 1.0) for inspecting and controlling media stream servers — IP cameras, streaming servers, DVRs, media infrastructure. Operations: options (query server capabilities), describe (fetch SDP session description with full media track info), setup (establish a stream session and get sessionId), play (start/resume media delivery), pause (pause media delivery), teardown (end session and release resources), info (return protocol/config table, no I/O). Authentication: Basic and Digest MD5 (auto-negotiated on 401). TLS: use rtsps:// for encrypted connections. SDP (RFC 2327) parsed into structured mediaDescriptions with controlUrl per media track.",
  inputSchema: {
    type: "object",
    required: ["operation"],
    properties: {
      operation: {
        type: "string",
        enum: ["options", "describe", "setup", "play", "pause", "teardown", "info"],
        description: "Operation to perform. options=query server capabilities (OPTIONS). describe=fetch SDP media description (DESCRIBE). setup=establish stream session, get sessionId (SETUP). play=start/resume media delivery (PLAY). pause=pause delivery (PAUSE). teardown=end session (TEARDOWN). info=return protocol info (no I/O).",
      },
      url: {
        type: "string",
        description: "RTSP server URL (required for all except info). Format: rtsp://[user:pass@]host[:port]/path or rtsps://... for TLS. E.g. 'rtsp://192.168.1.100:554/stream1', 'rtsp://admin:secret@cam.local/live'. Default port 554 (rtsp) or 322 (rtsps).",
      },
      username: {
        type: "string",
        description: "Username for authentication (overrides URL userinfo). For cameras requiring Basic or Digest auth.",
      },
      password: {
        type: "string",
        description: "Password for authentication (overrides URL userinfo). Used with username for Basic/Digest auth.",
      },
      session_id: {
        type: "string",
        description: "RTSP session ID (required for play, pause, teardown). Obtained from the setup operation response. E.g. '12345678'.",
      },
      control_url: {
        type: "string",
        description: "Track/control URL for setup (optional; defaults to the main stream URL). Use a media track controlUrl from the describe SDP response. E.g. 'rtsp://host/stream/track1'.",
      },
      transport: {
        type: "string",
        description: "Transport header value for setup (default: 'RTP/AVP;unicast;client_port=0-1'). Specify port range e.g. 'RTP/AVP;unicast;client_port=5000-5001'. For multicast use 'RTP/AVP;multicast'.",
      },
      rtp_port: {
        type: "number",
        description: "Client RTP port for SETUP transport header (default: 0=any). Even number; RTCP uses rtp_port+1. Range 1024-65534.",
      },
      rtcp_port: {
        type: "number",
        description: "Client RTCP port for SETUP transport header (default: rtp_port+1). Typically rtp_port+1.",
      },
      range: {
        type: "string",
        description: "Range header for play (optional). NPT format: 'npt=0-' (live stream from start), 'npt=10-30' (seconds 10-30), 'npt=now-' (from current position). E.g. 'npt=0.000-'.",
      },
      timeout: {
        type: "number",
        description: "Operation timeout in milliseconds (default: 10000, range: 1000-60000).",
      },
      reject_unauthorized: {
        type: "boolean",
        description: "For rtsps:// connections: whether to reject self-signed or untrusted TLS certificates (default: true). Set false for self-signed certs on local cameras.",
      },
    },
  },
};

module.exports = { rtspClientSchema };
