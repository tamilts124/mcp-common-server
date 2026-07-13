"use strict";

const radiusClientSchema = {
  name: "radius_client",
  description: "Zero-dependency RADIUS (Remote Authentication Dial In User Service) client (pure Node.js dgram/crypto built-ins; no npm deps). Implements RFC 2865 (RADIUS authentication — Access-Request, Access-Accept, Access-Reject, Access-Challenge), RFC 2866 (RADIUS accounting — Accounting-Request, Accounting-Response), and RFC 5997 (Status-Server for server health checks). Supports PAP (User-Password XOR-encrypted with MD5) and CHAP (MD5 challenge-response) authentication. Used for testing RADIUS servers (FreeRADIUS, Microsoft NPS, Cisco ACS/ISE, Aruba ClearPass, Juniper Steel-Belted RADIUS, etc.), network device authentication, VPN gateways, Wi-Fi 802.1X testing, and enterprise AAA infrastructure. Operations: authenticate (send Access-Request and receive Accept/Reject/Challenge), accounting (send Accounting-Request with start/stop/interim status), status (RFC 5997 Status-Server health check), info (return protocol/attribute/config table, no I/O). Transport: UDP (default port 1812 for authentication, 1813 for accounting). Security: Shared secret + MD5-based request authenticator; response authenticator verified; passwords never logged.",
  inputSchema: {
    type: "object",
    required: ["operation"],
    properties: {
      operation: {
        type: "string",
        enum: ["authenticate", "accounting", "status", "info"],
        description: "Operation to perform. authenticate=send Access-Request and parse Accept/Reject/Challenge. accounting=send Accounting-Request (start/stop/interim/on/off). status=Status-Server health check (RFC 5997). info=return protocol/config table (no I/O).",
      },
      server: {
        type: "string",
        description: "RADIUS server hostname or IP address. Required for authenticate, accounting, and status. E.g. 'radius.example.com', '192.168.1.10'.",
      },
      secret: {
        type: "string",
        description: "Shared secret configured on the RADIUS server for this NAS client. Required for all network operations. Case-sensitive. E.g. 'testing123', 'MyVerySecretSharedKey'.",
      },
      username: {
        type: "string",
        description: "Username for authentication (User-Name attribute). Required for authenticate and accounting. E.g. 'alice', 'bob@example.com', 'domain\\\\user'.",
      },
      password: {
        type: "string",
        description: "User password for PAP or CHAP authentication. Required for authenticate when auth_method is pap or chap.",
      },
      auth_method: {
        type: "string",
        enum: ["pap", "chap"],
        description: "Authentication method. pap (default) = User-Password attribute, XOR-encrypted with MD5(secret + authenticator) per RFC 2865 §5.2. chap = CHAP-Password attribute, MD5(chapId + password + challenge) per RFC 2865 §5.3.",
      },
      port: {
        type: "number",
        description: "UDP port of the RADIUS server. Defaults to 1812 for authenticate/status, 1813 for accounting. Range: 1-65535.",
      },
      timeout: {
        type: "number",
        description: "Per-attempt timeout in milliseconds before retransmitting (default: 5000, range: 1000-60000). RADIUS uses UDP so no TCP connection state; retransmit is standard.",
      },
      retries: {
        type: "number",
        description: "Maximum number of UDP retransmit attempts (default: 3, range: 1-10). Each attempt waits 'timeout' ms before the next.",
      },
      nas_ip: {
        type: "string",
        description: "NAS-IP-Address attribute value (IPv4). Identifies this client to the RADIUS server. Defaults to '127.0.0.1'. E.g. '10.0.0.1'.",
      },
      nas_port: {
        type: "number",
        description: "NAS-Port attribute value (0-65535). The physical port number through which the user connects. Optional.",
      },
      nas_identifier: {
        type: "string",
        description: "NAS-Identifier attribute value. A string identifying the NAS (network access server). E.g. 'access-point-1', 'vpn-gateway'. Optional.",
      },
      service_type: {
        type: "number",
        description: "Service-Type attribute value (default: 1 = Login). 1=Login, 2=Framed, 3=Callback Login, 4=Callback Framed, 5=Outbound, 6=Administrative, 7=NAS Prompt, 8=Authenticate Only.",
      },
      called_station_id: {
        type: "string",
        description: "Called-Station-Id attribute (attr 30). The station dialed or MAC of the AP. E.g. '00-11-22-33-44-55:SSID-Name' for Wi-Fi. Optional.",
      },
      calling_station_id: {
        type: "string",
        description: "Calling-Station-Id attribute (attr 31). The station initiating the call or client MAC. E.g. '11-22-33-44-55-66'. Optional.",
      },
      framed_ip_address: {
        type: "string",
        description: "Framed-IP-Address attribute (attr 8). The IPv4 address assigned or to be assigned to the user. Used in accounting stop/interim records. E.g. '10.1.2.3'. Optional.",
      },
      session_id: {
        type: "string",
        description: "Acct-Session-Id attribute (attr 44). Unique identifier for the user session. Required for accounting. E.g. 'sess-abc123', '4F3A8E21-00000001'.",
      },
      acct_status_type: {
        type: "string",
        enum: ["start", "stop", "interim", "on", "off"],
        description: "Acct-Status-Type attribute value for accounting operation. start=begin session (1), stop=end session (2), interim=update (3), on=NAS up (7), off=NAS down (8). Default: start.",
      },
      acct_delay_time: {
        type: "number",
        description: "Acct-Delay-Time attribute (seconds). How many seconds the client has been trying to send this record. Default: 0.",
      },
      acct_session_time: {
        type: "number",
        description: "Acct-Session-Time attribute (seconds). How long the user has been authenticated. Used in stop and interim records.",
      },
      acct_input_octets: {
        type: "number",
        description: "Acct-Input-Octets attribute. Bytes received from the user during the session. Used in stop and interim records.",
      },
      acct_output_octets: {
        type: "number",
        description: "Acct-Output-Octets attribute. Bytes sent to the user during the session. Used in stop and interim records.",
      },
      acct_terminate_cause: {
        type: "number",
        description: "Acct-Terminate-Cause attribute (1-20). Reason the session ended. 1=User-Request, 2=Lost-Carrier, 3=Lost-Service, 4=Idle-Timeout, 5=Session-Timeout, 6=Admin-Reset. Used in stop records.",
      },
    },
  },
};

module.exports = { radiusClientSchema };
