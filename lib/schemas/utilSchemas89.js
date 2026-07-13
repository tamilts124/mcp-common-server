"use strict";

const ircClientSchema = {
  name: "irc_client",
  description: "Zero-dependency IRC client (pure Node.js net/tls built-ins; no npm deps). Connects to any IRC server using RFC 1459 + IRC v3 protocol. Supports plain TCP (default port 6667) and TLS (default port 6697). Authentication: SASL PLAIN (via CAP REQ sasl), NickServ IDENTIFY, and server password (PASS). Operations: send_message (connect, join channel(s) or PM a nick, send PRIVMSG, disconnect), join (join channels and collect received messages for a duration), list (LIST all channels on the server), whois (WHOIS a user), nick (connect and change nick), raw (send raw IRC commands and collect responses), info (return config/capability table, no I/O). Security: NUL-byte and CR/LF guards; message length clamped to 510 chars (RFC 1459); timeout clamped 3s\u201360s; channel name validated.",
  inputSchema: {
    type: "object",
    required: ["operation"],
    properties: {
      operation: {
        type: "string",
        enum: ["send_message", "join", "list", "whois", "nick", "raw", "info"],
        description: "Operation to perform. send_message=join channel(s) or PM nick and send PRIVMSG. join=join channels and collect messages for a duration. list=LIST all server channels. whois=WHOIS a user. nick=connect and change nick. raw=send raw IRC commands and collect responses. info=return config table (no I/O).",
      },
      host: {
        type: "string",
        description: "IRC server hostname or IP address (required for all operations except info). E.g. 'irc.libera.chat', '192.168.1.10'.",
      },
      port: {
        type: "number",
        description: "IRC server port (default: 6667 for plain, 6697 for TLS). Range: 1\u201365535.",
      },
      nick: {
        type: "string",
        description: "IRC nickname to use. Must be a valid RFC 1459 nick (starts with letter or special char; max 30 chars). Default: 'mcpbot'.",
      },
      user: {
        type: "string",
        description: "IRC username (ident) for USER command. Defaults to the nick value.",
      },
      realname: {
        type: "string",
        description: "Real name for USER command. Default: 'MCP IRC Client'.",
      },
      use_tls: {
        type: "boolean",
        description: "Use TLS (IRC over TLS). Default: false. When true, default port changes to 6697.",
      },
      reject_unauthorized: {
        type: "boolean",
        description: "Reject self-signed or invalid TLS certificates (default: true). Set false for private/self-signed servers.",
      },
      server_password: {
        type: "string",
        description: "Server password sent as PASS before NICK/USER (for password-protected servers).",
      },
      sasl_password: {
        type: "string",
        description: "SASL PLAIN password for IRC v3 SASL authentication (recommended for Libera.chat, OFTC, etc.). Uses CAP REQ sasl + AUTHENTICATE PLAIN.",
      },
      nickserv_password: {
        type: "string",
        description: "NickServ IDENTIFY password. Sent as PRIVMSG NickServ :IDENTIFY <password> after registration. Fallback for servers without SASL.",
      },
      timeout: {
        type: "number",
        description: "Connection/operation timeout in milliseconds (default: 10000, range: 3000\u201360000).",
      },
      target: {
        description: "Target channel or nick for send_message. E.g. '#mychannel' or 'mynick'. String or array of strings (max 10).",
        oneOf: [
          { type: "string" },
          { type: "array", items: { type: "string" } },
        ],
      },
      message: {
        type: "string",
        description: "Single message to send (PRIVMSG). Clamped to 510 chars. CR/LF stripped. Use for send_message operation.",
      },
      messages: {
        type: "array",
        items: { type: "string" },
        description: "Array of messages to send (PRIVMSG) to each target (max 20). Use for send_message.",
      },
      channel: {
        type: "string",
        description: "Single channel to join for 'join' operation. E.g. '#libera'. Prefer 'channels' for multiple.",
      },
      channels: {
        type: "array",
        items: { type: "string" },
        description: "Channels to join (max 10). Each must start with #, &, + or !. For 'join' operation.",
      },
      duration_ms: {
        type: "number",
        description: "Duration in milliseconds to stay connected and collect messages for 'join' and 'raw' operations (default: 5000, max: 30000).",
      },
      command: {
        type: "string",
        description: "Single raw IRC command to send (for 'raw' operation). E.g. 'MODE #channel +b'. No CRLF needed.",
      },
      commands: {
        type: "array",
        items: { type: "string" },
        description: "Array of raw IRC commands to send (for 'raw' operation, max 20). Sent in order.",
      },
      new_nick: {
        type: "string",
        description: "New nickname to request (for 'nick' operation).",
      },
      filter: {
        type: "string",
        description: "Optional substring filter for 'list' operation — only return channels whose name or topic includes this string (case-insensitive).",
      },
    },
  },
};

module.exports = { ircClientSchema };
