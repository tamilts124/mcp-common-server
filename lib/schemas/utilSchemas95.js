"use strict";

const diameterClientSchema = {
  name: "diameter_client",
  description: "Zero-dependency Diameter protocol client (pure Node.js net/tls/crypto built-ins; no npm deps). Implements RFC 6733 (Diameter Base Protocol), the modern successor to RADIUS used in LTE/4G/5G networks (S6a, Gx, Gy, Cx interfaces), IMS, VoLTE, and enterprise AAA infrastructure. Diameter provides reliable TCP/TLS transport (vs RADIUS UDP), structured AVP encoding, built-in peer discovery, and graceful connection management. Operations: capabilities_exchange (CER/CEA handshake — discover peer's supported applications, product info, and capabilities), device_watchdog (DWR/DWA keepalive — measure round-trip latency and verify peer is alive), disconnect_peer (DPR/DPA graceful shutdown), send_request (send any Diameter request with custom command code and AVPs — useful for testing specific Diameter applications like Credit-Control, EAP, NASREQ, Mobile IPv6), info (return protocol/AVP/result-code table, no I/O). Transport: TCP (default port 3868) or TLS (default port 5658). Used for testing FreeRADIUS Diameter, Open-Source HPLMN, OpenDiameter, Broadhop/Oracle Diameter, and telecom core network elements.",
  inputSchema: {
    type: "object",
    required: ["operation"],
    properties: {
      operation: {
        type: "string",
        enum: ["capabilities_exchange", "device_watchdog", "disconnect_peer", "send_request", "info"],
        description: "Operation to perform. capabilities_exchange=send CER and parse CEA (discover peer capabilities). device_watchdog=send DWR and parse DWA (keepalive/latency). disconnect_peer=send DPR and parse DPA (graceful shutdown). send_request=send any Diameter request and parse answer. info=return protocol/config table (no I/O).",
      },
      host: {
        type: "string",
        description: "Diameter peer hostname or IP address. Required for all network operations. E.g. 'diameter.example.com', '10.0.0.1', '::1'.",
      },
      port: {
        type: "number",
        description: "TCP port of the Diameter peer (default: 3868 for plain TCP, 5658 for TLS). Range: 1-65535.",
      },
      use_tls: {
        type: "boolean",
        description: "Use TLS (DiameterS) instead of plain TCP. Default: false. When true, connects to port 5658 by default.",
      },
      reject_unauthorized: {
        type: "boolean",
        description: "Reject TLS connections with invalid/self-signed certificates. Default: true. Set to false for self-signed test servers.",
      },
      origin_host: {
        type: "string",
        description: "Origin-Host AVP value — the FQDN of this Diameter node. Required for all network operations. Must be unique and reachable. E.g. 'client.example.com', 'nas.realm.org'.",
      },
      origin_realm: {
        type: "string",
        description: "Origin-Realm AVP value — the realm (domain) of this Diameter node. Required for all network operations. E.g. 'example.com', 'telecom.net'.",
      },
      origin_ip: {
        type: "string",
        description: "Host-IP-Address AVP value for capabilities_exchange. IPv4 or IPv6 address of this node. Default: '127.0.0.1'. E.g. '192.168.1.10', '2001:db8::1'.",
      },
      vendor_id: {
        type: "number",
        description: "Vendor-Id AVP value for capabilities_exchange. IANA-assigned SMI Network Management Private Enterprise Code. 0 = no vendor (default). E.g. 193 = Ericsson, 10415 = 3GPP.",
      },
      product_name: {
        type: "string",
        description: "Product-Name AVP value for capabilities_exchange. Free-form string identifying this client software. Default: 'mcp-common-server'.",
      },
      firmware_revision: {
        type: "number",
        description: "Firmware-Revision AVP value for capabilities_exchange. Numeric firmware version. Default: 1.",
      },
      auth_app_ids: {
        type: "array",
        items: { type: "number" },
        description: "Auth-Application-Id AVP values for capabilities_exchange. List of application IDs this node supports. Default: [0, 1] (Base + NASREQ). Common values: 0=Base, 1=NASREQ, 2=Mobile-IPv4, 3=Accounting, 4=Credit-Control, 5=EAP.",
      },
      disconnect_cause: {
        type: "string",
        enum: ["rebooting", "busy", "do_not_want_to_talk"],
        description: "Disconnect-Cause AVP value for disconnect_peer. rebooting (0) = peer is restarting. busy (1) = peer is too busy. do_not_want_to_talk (2) = peer refuses further communication. Default: rebooting.",
      },
      command_code: {
        type: "number",
        description: "Diameter command code for send_request. E.g. 257=CER, 272=Credit-Control, 280=DWR, 282=DPR, 316=Update-Location (S6a). Range: 0-16777215.",
      },
      application_id: {
        type: "number",
        description: "Application-ID for send_request. Identifies the Diameter application. 0=Base, 1=NASREQ, 3=Accounting, 4=Credit-Control, 5=EAP, 16777251=3GPP S6a. Default: 0 (Base).",
      },
      destination_host: {
        type: "string",
        description: "Destination-Host AVP for send_request. FQDN of the target Diameter node. Optional — omit to let the realm route. E.g. 'hss.core.example.com'.",
      },
      destination_realm: {
        type: "string",
        description: "Destination-Realm AVP for send_request. Target realm for routing. E.g. 'core.example.com', '3gpp.org'.",
      },
      session_id: {
        type: "string",
        description: "Session-Id AVP for send_request. Unique session identifier per RFC 6733 §8.8 format: <originHost>;<high32>;<low32>[;<optional>]. Auto-generated if omitted.",
      },
      user_name: {
        type: "string",
        description: "User-Name AVP for send_request. IMSI for 3GPP, NAI for EAP, or username@realm for NASREQ. E.g. '001011234567890', 'alice@example.com'. Optional.",
      },
      extra_avps: {
        type: "array",
        description: "Additional AVPs to include in send_request. Each item: {code (number), value_hex (hex string) | value_string (string) | value_uint32 (number), mandatory (boolean, default true), vendor_id (number, default 0)}.",
        items: {
          type: "object",
          required: ["code"],
          properties: {
            code:         { type: "number",  description: "AVP code number." },
            value_hex:    { type: "string",  description: "AVP value as hex string (e.g. '0a010203' for IPv4 10.1.2.3)." },
            value_string: { type: "string",  description: "AVP value as UTF-8 string." },
            value_uint32: { type: "number",  description: "AVP value as a 32-bit unsigned integer." },
            mandatory:    { type: "boolean", description: "Set the M (Mandatory) flag on this AVP. Default: true." },
            vendor_id:    { type: "number",  description: "Vendor-Id for vendor-specific AVPs (V flag). 0 = no vendor (default)." },
          },
        },
      },
      timeout: {
        type: "number",
        description: "Connection + response timeout in milliseconds (default: 10000, range: 1000-60000).",
      },
    },
  },
};

module.exports = { diameterClientSchema };
