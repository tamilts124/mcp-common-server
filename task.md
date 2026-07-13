## Status legend
todo / in-progress / done / tested / blocked

## Done
- [tested] Add sip_client tool (v4.232.0)
  - Zero-dep SIP (RFC 3261) client (pure Node.js dgram/net/tls; no npm deps)
  - Operations: options, register, invite, message, subscribe, info
  - RFC 3261 (SIP), RFC 3428 (MESSAGE), RFC 3265 (SUBSCRIBE/NOTIFY), RFC 2617 (Digest Auth), RFC 2327 (SDP)
  - Transport: UDP (default), TCP, TLS (SIPS), auto-negotiated
  - Auth: Digest MD5 (RFC 2617), auto-retried on 401/407
  - options: OPTIONS probe, returns allow/accept/supported headers
  - register: REGISTER address at registrar, parses Contact from 200 OK
  - invite: INVITE initiates call (signaling only, no RTP); auto-generates minimal SDP
  - message: MESSAGE sends SIP instant message (RFC 3428)
  - subscribe: SUBSCRIBE to event package (presence, dialog, etc.), RFC 3265
  - info: returns protocol/config table (no I/O)
  - parseSipUri: sip:/sips: URI parser; IPv6 bracket notation; URI parameter stripping
  - buildRequest: start-line + headers + body; array headers emit multiple lines
  - parseResponse: status-code/text; compact header expansion (RFC 3261 §7.3.3); duplicate headers as array
  - buildDigestAuth: MD5 HA1/HA2; qop=auth (cnonce, nc); opaque forwarded; no plaintext password in wire
  - randomBranch: MAGIC_COOKIE (z9hG4bK) prefix per RFC 3261 §8.1.1.7
  - isCompleteResponse: checks Content-Length to detect full response over streaming TCP
  - lib/sipClientOps.js (865 lines); lib/schemas/utilSchemas92.js (93 lines)
  - Wired into lib/dispatchRead.js + lib/schemas/utilSchemas.js
  - package.json: version 4.232.0; added test:sip-client script
  - README.md: 451 tools total (Network & Messaging: 38); added sip_client
  - section 259 tests: A=pure-helpers x40, B=validation x15, C=mock-network x13, D=security x10, E=concurrency x8 -- 119/119 (tests auto-exceeded targets)

## Done
- [tested] Add rtsp_client tool (v4.231.0)
- [tested] Add tftp_client tool (v4.230.0)
- [tested] Add irc_client tool (v4.229.0)
- [tested] Add dns_client tool (v4.228.0)
- [tested] Add tls_client tool (v4.227.0)
- [tested] Add whois_client tool (v4.226.0)
- [tested] Add coap_client tool (v4.225.0)
- [tested] Add modbus_client tool (v4.224.0)
- [tested] Add clickhouse_client tool (v4.223.0)
- [tested] Add syslog_client tool (v4.222.0)
- [tested] Add ntp_client tool (v4.221.0)
- [tested] Add influxdb_client tool (v4.220.0)
- [tested] Add cassandra_client tool (v4.219.0)
- [tested] Add mongodb_client tool (v4.218.0)
- [tested] Add elasticsearch_client tool (v4.217.0)
- [tested] Add prometheus_client tool (v4.216.0)
- [tested] Add k8s_client tool (v4.215.0)
- [tested] Add registry_client tool (v4.214.0)
