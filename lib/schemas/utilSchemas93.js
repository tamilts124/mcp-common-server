"use strict";

const xmppClientSchema = {
  name: "xmpp_client",
  description: "Zero-dependency XMPP (Jabber) client (pure Node.js net/tls built-ins; no npm deps). Implements RFC 6120 (XMPP Core — stream, SASL PLAIN, resource binding), RFC 6121 (XMPP IM — roster, presence, messaging), RFC 7590 (TLS in XMPP — STARTTLS and direct TLS/XMPPS), and XEP-0199 (XMPP Ping). Connects to any standards-compliant XMPP server (ejabberd, Prosody, Openfire, Tigase, Metronome, XMPP.jp, jabber.org, etc.). Operations: send_message (send an instant message to a JID), get_roster (retrieve the contact list), presence (broadcast availability — available/away/dnd/xa/subscribe/etc.), ping (XEP-0199 round-trip latency measurement), info (return protocol/config table, no I/O). Authentication: SASL PLAIN (RFC 4616) over TLS. Transport: STARTTLS on port 5222 (default) or direct TLS (XMPPS) on port 5223 (use_tls:true). JID format: user@domain or user@domain/resource.",
  inputSchema: {
    type: "object",
    required: ["operation"],
    properties: {
      operation: {
        type: "string",
        enum: ["send_message", "get_roster", "presence", "ping", "info"],
        description: "Operation to perform. send_message=send an XMPP IM to a JID. get_roster=retrieve the contact list. presence=send a presence stanza (available/unavailable/subscribe/etc.). ping=XEP-0199 round-trip ping. info=return protocol/config info (no I/O).",
      },
      server: {
        type: "string",
        description: "XMPP server hostname or IP address. Required for all operations except info. E.g. 'jabber.org', 'xmpp.example.com', '192.168.1.10'.",
      },
      jid: {
        type: "string",
        description: "Your Jabber ID (JID) for authentication. Format: user@domain or user@domain/resource. E.g. 'alice@example.com', 'bob@jabber.org/laptop'. Required for all operations except info.",
      },
      password: {
        type: "string",
        description: "Password for SASL PLAIN authentication. Required for all operations except info. Transmitted only over the TLS-encrypted channel.",
      },
      to: {
        type: "string",
        description: "Recipient JID for send_message or target JID for presence subscribe/unsubscribe. E.g. 'bob@example.com'. Required for send_message.",
      },
      body: {
        type: "string",
        description: "Message body text for send_message. The text content of the XMPP instant message.",
      },
      type: {
        type: "string",
        enum: ["available", "unavailable", "subscribe", "subscribed", "unsubscribe", "unsubscribed", "chat", "groupchat", "normal", "headline"],
        description: "Stanza type. For presence: available (default), unavailable, subscribe, subscribed, unsubscribe, unsubscribed. For send_message: chat (default), groupchat, normal, headline.",
      },
      show: {
        type: "string",
        enum: ["away", "chat", "dnd", "xa"],
        description: "Presence show value (sub-state of 'available'). away=temporarily away, chat=actively chatting/available, dnd=do not disturb, xa=extended away. Only valid for presence operation with type=available.",
      },
      status: {
        type: "string",
        description: "Human-readable presence status message. E.g. 'In a meeting', 'Back in 5 minutes'. Optional for presence operation.",
      },
      subject: {
        type: "string",
        description: "Optional subject line for send_message. Appears as the message subject in clients that support it.",
      },
      domain: {
        type: "string",
        description: "Override the XMPP domain for the stream (defaults to the domain part of the JID). Useful when connecting through a proxy or when the server hostname differs from the XMPP domain.",
      },
      port: {
        type: "number",
        description: "Override the server port (default: 5222 for STARTTLS, 5223 for direct TLS). Range: 1-65535.",
      },
      use_tls: {
        type: "boolean",
        description: "Use direct TLS (XMPPS, default port 5223) instead of STARTTLS on port 5222 (default: false). Direct TLS wraps the entire connection in TLS from the start.",
      },
      reject_unauthorized: {
        type: "boolean",
        description: "Reject self-signed or untrusted TLS certificates (default: true). Set false for internal XMPP servers with self-signed certs.",
      },
      timeout: {
        type: "number",
        description: "Operation timeout in milliseconds (default: 10000, range: 2000-60000).",
      },
    },
  },
};

module.exports = { xmppClientSchema };
