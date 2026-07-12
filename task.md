## Status legend
todo / in-progress / done / tested / blocked

## Current Task
- [tested] Add kafka_client tool (v4.172.0)
  - Zero-dep Apache Kafka client (Node.js net; no npm deps)
  - Kafka binary protocol (KIP-compatible, API versions for Kafka 0.10+)
  - Operations: produce (send messages to topic/partition), fetch (consume messages), list_offsets (get partition offsets), metadata (topic/broker/partition info), create_topics, delete_topics, list_topics
  - SASL PLAIN authentication support
  - Message compression: none (raw bytes/UTF-8)
  - Security: NUL/CRLF guards on topic names, client.id; 10 MB message cap; 50 MB fetch cap
  - Wall-clock timeout (default 30s), connect_timeout (default min(timeout,10s))
  - lib/kafkaClientOps.js; lib/schemas/utilSchemas33.js; wired into dispatchRead.js + utilSchemas.js
  - section 200 tests: A=input-validation x10, B=codec-stubs x10, C=security-guards x10, D=happy-path-mock x30, E=error-paths x5, F=concurrency x5 -- 70/70

## Done
- [x] (tested) Add snmp_client tool (v4.171.0)
  - Zero-dep SNMP v1/v2c/v3 client (Node.js dgram/crypto; no npm deps)
  - Operations: get (GET single/multi OID), get_next (GETNEXT walk), get_bulk (GETBULK v2c/v3), walk (recursive GETNEXT walk), set (SET OID value), trap_listen (receive traps), inform (send INFORM-REQUEST)
  - SNMPv1 and SNMPv2c community-based auth
  - SNMPv3 USM (User Security Model): noAuthNoPriv, authNoPriv (MD5/SHA), authPriv (MD5/SHA + DES/AES)
  - BER-encoded ASN.1 PDU codec: encode/decode SEQUENCE, INTEGER, OCTET STRING, OID, NULL, IpAddress, Counter32/64, Gauge32, TimeTicks, Opaque
  - OID dot-notation support; numeric OID ↔ name mapping for common MIBs (sysDescr, sysUpTime, ifTable, etc.)
  - Security: community string NUL/CRLF guards; 64 KB response cap; max 100 OIDs per request
  - Wall-clock timeout (default 5s), retries (default 1)
  - lib/snmpClientOps.js; lib/schemas/utilSchemas32.js; wired into dispatchRead.js + utilSchemas.js
  - section 199 tests: A=input-validation x10, B=BER-codec x10, C=security-guards x10, D=happy-path-mock x30, E=error-paths x5, F=concurrency x5 -- 70/70

## Done
- [x] (tested) Add ftp_client tool (v4.170.0)
  - Zero-dep FTP/FTPS client (Node.js net/tls; no npm deps)
  - Operations: list (LIST directory), get (download file), put (upload file), delete (DELE), rename (RNFR/RNTO), mkdir (MKD), rmdir (RMD), pwd (PWD), stat (SIZE+MDTM), quit
  - Passive mode (PASV/EPSV) for data connections
  - TLS: ftps:true for explicit FTPS (AUTH TLS/SSL); reject_unauthorized configurable
  - Auth: username/password (USER/PASS); anonymous supported
  - Security: path injection guards, 50 MB download cap, 100 MB upload cap
  - lib/ftpClientOps.js (769 lines); lib/schemas/utilSchemas31.js; wired into dispatchRead.js + utilSchemas.js
  - section 198 tests: A=input-validation x10, B=parser-unit x10, C=security x10, D=happy-path x30, E=error-paths x5, F=concurrency x5 -- 70/70
  - FtpResponseParser: byte-offset-aware _parse() using indexOf("\n") (fixes CRLF consumed-counter bug)
  - makeMockFtp: first-connection flag routes data connections to real TCP (makeDataServer), control to mock socket
  - Pre-decode upload size estimate (avoids 101 MB Buffer allocation on size-exceed)

## Done
- [x] (tested) Add ldap_client tool (v4.169.0)
  - Zero-dep LDAP v3 client (Node.js net/tls; no npm deps)
  - Operations: bind (authenticate DN + password), search (LDAP search with filter/scope/attributes), add (add entry), modify (modify attributes), delete (delete entry), compare (compare attribute value), whoami (RFC 4532 extended op)
  - BER (Basic Encoding Rules) codec: encoder + streaming LdapParser + BerReader decoder
  - RFC 4515 filter parser: AND/OR/NOT/equality/substring/present/ge/le/approx
  - Auth: simple bind (bind_dn + bind_password) or SASL (sasl_mechanism + sasl_credentials)
  - TLS: tls:true for LDAPS (default port 636); reject_unauthorized configurable
  - Security: NUL-byte guards on all DN/filter/attr fields; max DN 1024 chars; max attr 8192 chars; 8 MB data cap
  - lib/ldapClientOps.js (1118 lines); lib/schemas/utilSchemas30.js; wired into dispatchRead.js + utilSchemas.js
  - section 197 tests: A=input-validation x10, B=BER-codec x10, C=security x10, D=happy-path x30, E=errors x5, F=concurrency x5 — 70/70
  - package.json: test:ldap-client script added, version 4.169.0

## Done
- [x] Add nats_client tool — status: tested (70/70, v4.168.0)
- [x] Add stomp_client tool — status: tested (70/70, v4.167.0)
- [x] Add amqp_client tool — status: tested (70/70, v4.166.0)
- [x] Add mqtt_client tool — status: tested (70/70, v4.165.0)

## History

- [x] Add redis_client tool — status: tested (130/130, v4.164.0)
- [x] Add imap_client tool — status: tested (230/230, v4.163.0)
- [x] Add smtp_client tool — status: tested (76/76, v4.162.0)
- [x] Add ssh_exec tool — status: tested (60/60, v4.161.0)
- [x] Add udp_client + safeSerialize tools — status: tested (66/66 + 33/33, v4.159.0 + v4.160.0)
- [x] Add tcp_client tool — status: tested (42/42, v4.158.0)
- [x] Add send_process_input tool — status: tested (43/43, v4.157.0)

## Older Tasks
- [x] Add git_write_ops tool — status: tested (77/77, v4.156.0)
- [x] Add image_ops tool — status: tested (76/76, v4.155.0)
- [x] Add websocket_client + sse_client tools — status: tested (75/75, v4.154.0)
- [x] Add section-181 comprehensive tests for port_check + wait_for_port + port_scan_range + dns_lookup — status: tested (75/75, v4.153.0)
- [x] Add multipart_upload + http_serve tools — status: tested (90/90, v4.152.0)
- [x] Add key_generate + oauth2_token tools — status: tested (100/100, v4.151.0)
- [x] Add tls_cert_inspect + http_multi_fetch tools — status: tested (92/92, v4.150.0)
