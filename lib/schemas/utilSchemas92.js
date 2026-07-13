"use strict";

const sipClientSchema = {
  name: "sip_client",
  description: "Zero-dependency SIP (Session Initiation Protocol) client (pure Node.js dgram/net/tls built-ins; no npm deps). Implements RFC 3261 for VoIP/telephony signaling — IP phones, PBXes, softphones, SIP proxies, and media gateways. Operations: options (probe server capabilities, discover allowed methods), register (REGISTER a SIP address with a registrar), invite (INVITE to initiate a call — signaling only, no RTP media), message (send a SIP instant message per RFC 3428), subscribe (SUBSCRIBE to event packages like presence per RFC 3265), info (return protocol/config table, no I/O). Transport: UDP (default, RFC 3261 §18.1), TCP, or TLS (SIPS). Authentication: Digest MD5 (RFC 2617), auto-negotiated on 401/407 responses. SIP URIs: sip:user@host[:port] or sips:user@host[:port].",
  inputSchema: {
    type: "object",
    required: ["operation"],
    properties: {
      operation: {
        type: "string",
        enum: ["options", "register", "invite", "message", "subscribe", "info"],
        description: "Operation to perform. options=probe server capabilities (OPTIONS). register=register a SIP address (REGISTER). invite=initiate a call, signaling only (INVITE). message=send SIP instant message (MESSAGE). subscribe=subscribe to event package (SUBSCRIBE). info=return protocol info (no I/O).",
      },
      server: {
        type: "string",
        description: "SIP server address. Accepts a full SIP URI (sip:host[:port]) or just host[:port]. Default port 5060 (SIP) or 5061 (SIPS). Required for all operations except info. E.g. 'sip:pbx.example.com', '192.168.1.1:5060', 'sip:sip.provider.com:5060'.",
      },
      from: {
        type: "string",
        description: "Caller/sender SIP URI for the From header. E.g. 'sip:alice@example.com'. Required for register, invite, message, subscribe.",
      },
      to: {
        type: "string",
        description: "Target/recipient SIP URI for the To header. E.g. 'sip:bob@example.com'. Required for invite, message, subscribe.",
      },
      username: {
        type: "string",
        description: "Username for Digest authentication (overrides user from 'from' URI). For register/invite, defaults to the user part of the from URI.",
      },
      password: {
        type: "string",
        description: "Password for Digest authentication. Used when the server returns 401 Unauthorized or 407 Proxy Authentication Required.",
      },
      transport: {
        type: "string",
        enum: ["udp", "tcp", "tls"],
        description: "SIP transport protocol (default: udp). udp=RFC 3261 §18.1 standard UDP. tcp=reliable TCP stream. tls=TLS-encrypted (SIPS, default port 5061).",
      },
      host: {
        type: "string",
        description: "Override the server host for the actual network connection (useful when server URI differs from network host, e.g. a local SIP proxy or ALG). If omitted, uses the host from 'server'.",
      },
      port: {
        type: "number",
        description: "Override the server port for the network connection (default: from 'server' URI, or 5060/5061). Range: 1-65535.",
      },
      expires: {
        type: "number",
        description: "Expires value in seconds for register and subscribe operations (default: 3600). Use 0 to unregister/unsubscribe.",
      },
      contact: {
        type: "string",
        description: "Contact URI for register (optional; defaults to the 'from' URI). The address where the server should route calls to the registered user.",
      },
      event: {
        type: "string",
        description: "Event package name for subscribe (required for subscribe). E.g. 'presence', 'dialog', 'message-summary', 'call-info'.",
      },
      accept: {
        type: "string",
        description: "Accept header value for subscribe (default: application/pidf+xml). E.g. 'application/pidf+xml' for presence, 'application/dialog-info+xml' for dialog events.",
      },
      body: {
        type: "string",
        description: "Message body text for the message operation (SIP MESSAGE method, RFC 3428). The text of the instant message to send.",
      },
      content_type: {
        type: "string",
        description: "Content-Type header for the message body (default: text/plain;charset=UTF-8). E.g. 'text/html;charset=UTF-8', 'application/json'.",
      },
      sdp_body: {
        type: "string",
        description: "Custom SDP body for invite (optional; if omitted a minimal SDP offer is generated automatically). Use to provide a real SDP with specific codecs/IP/ports.",
      },
      include_sdp: {
        type: "boolean",
        description: "For invite: include a minimal auto-generated SDP body (default: true). Set false to send the INVITE with no body.",
      },
      timeout: {
        type: "number",
        description: "Operation timeout in milliseconds (default: 5000, range: 1000-60000).",
      },
      reject_unauthorized: {
        type: "boolean",
        description: "For TLS connections: reject self-signed or untrusted certificates (default: true). Set false for internal SIP servers with self-signed certs.",
      },
    },
  },
};

module.exports = { sipClientSchema };
