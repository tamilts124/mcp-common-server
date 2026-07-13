## Status legend
todo / in-progress / done / tested / blocked

## Done
- [tested] Add irc_client tool (v4.229.0)
  - Zero-dep IRC client (pure Node.js net/tls; no npm deps)
  - Operations: send_message, join, list, whois, nick, raw, info
  - Supports plain TCP and TLS; RFC 1459 + IRC v3 capabilities
  - SASL PLAIN authentication; NickServ IDENTIFY fallback
  - lib/ircClientOps.js (943 lines); lib/schemas/utilSchemas89.js (110 lines)
  - Wired into lib/dispatchRead.js + lib/schemas/utilSchemas.js
  - package.json: version 4.229.0; added test:irc-client script
  - README.md: 448 tools total (Network & Messaging: 35); added irc_client
  - section 256 tests: A=pure-helpers x20, B=validation x15, C=mock-network x12, D=security x10, E=concurrency x8 -- 65/65

## Done
- [tested] Add dns_client tool (v4.228.0)
  - Full-featured DNS client: UDP/TCP classic DNS + DNS-over-HTTPS (DoH)
  - Operations: query, reverse, batch, resolvers, info
  - All common record types: A, AAAA, MX, TXT, NS, SOA, CNAME, PTR, SRV, CAA, DNSKEY, DS, NAPTR, HTTPS, SVCB
  - Multiple resolver presets: Cloudflare, Google, Quad9, custom
  - Manual wire-format encoding/decoding (pure Node.js, no npm deps)
  - DNSSEC indicators, TTL, response codes, all RR sections
  - lib/dnsClientOps.js (1094 lines); lib/schemas/utilSchemas88.js (72 lines)
  - Wired into lib/dispatchRead.js + lib/schemas/utilSchemas.js
  - package.json: version 4.228.0; added test:dns-client script
  - README.md: 447 tools total (Network & Messaging: 34); added dns_client
  - section 255 tests: A=pure-helpers x20, B=validation x15, C=mock-network x12, D=security x10, E=concurrency x8 -- 65/65

## Done
- [tested] Add tls_client tool (v4.227.0)
  - Zero-dep TLS/SSL live inspector (pure Node.js tls; no npm deps)
  - Operations: inspect, chain, ciphers, verify, scan, info
  - lib/tlsClientOps.js (802 lines); lib/schemas/utilSchemas87.js (49 lines)
  - Wired into lib/dispatchRead.js + lib/schemas/utilSchemas.js
  - package.json: version 4.227.0; added test:tls-client script
  - README.md: 446 tools total (Network & Messaging: 33); added tls_client
  - section 254 tests: A=pure-helpers x23, B=validation x14, C=mock-network x10,
    D=security x10, E=concurrency+cipher x10 -- 67/67

## Done
- [tested] Add whois_client tool (v4.226.0)
  - Zero-dep WHOIS (RFC 3912) client (pure Node.js net; no npm deps)
  - Operations: domain, ip, asn, tld, raw, info
  - lib/whoisClientOps.js (1000 lines); lib/schemas/utilSchemas86.js (55 lines)
  - Wired into lib/dispatchRead.js + lib/schemas/utilSchemas.js
  - package.json: version 4.226.0; added test:whois-client script
  - README.md: 445 tools total (Network & Messaging: 32); added whois_client
  - section 253 tests: A=validation x10, B=unit/protocol x20, C=mock-network x10,
    D=security x10, E=error-paths x10 -- 60/60

## Done
- [tested] Add coap_client tool (v4.225.0)
  - Zero-dep CoAP (RFC 7252) client (pure Node.js dgram; no npm deps)
  - Operations: get, post, put, delete, discover, observe, ping, info
  - lib/coapClientOps.js (1053 lines); lib/schemas/utilSchemas85.js (57 lines)
  - Wired into lib/dispatchRead.js + lib/schemas/utilSchemas.js
  - package.json: version 4.225.0; added test:coap-client script
  - README.md: 444 tools total (Network & Messaging: 31); added coap_client
  - section 252 tests: A=validation x11, B=codec x22, C=mock-network x22,
    D=security x10, E=error-paths x10, F=concurrency x10 -- 85/85

## Done
- [tested] Add modbus_client tool (v4.224.0)
  - Zero-dep Modbus TCP client (pure Node.js net; no npm deps)
  - Operations: read_coils, read_discrete_inputs, read_holding_registers, read_input_registers, write_coil, write_register, write_multiple_coils, write_multiple_registers, info
  - FC01–FC06, FC15, FC16; MBAP framing per IEC 61158 / MODBUS Application Protocol v1.1b3
  - Modbus exceptions decoded to human-readable messages; NUL guard; timeout 500ms-30s
  - lib/modbusClientOps.js (693 lines); lib/schemas/utilSchemas84.js (67 lines)
  - Wired into lib/dispatchRead.js + lib/schemas/utilSchemas.js
  - package.json: version 4.224.0; added test:modbus-client script
  - README.md: 443 tools total (Network & Messaging: 30); added modbus_client
  - section 251 tests: A=validation x10, B=protocol/codec x20, C=mock-network x10,
    D=security x10, E=error-paths x6 -- 76/76

## Done
- [tested] Add clickhouse_client tool (v4.223.0)
  - Zero-dep ClickHouse HTTP API client (pure Node.js http/https; no npm deps)
  - Operations: ping, info, query, insert, databases, tables, create_table, drop_table
  - Auth: X-ClickHouse-User / X-ClickHouse-Key headers (username/password)
  - Formats: JSONEachRow (default), JSON (with meta/statistics), CSV, TSVWithNames
  - lib/clickhouseClientOps.js (518 lines); lib/schemas/utilSchemas83.js (153 lines)
  - Wired into lib/dispatchRead.js + lib/schemas/utilSchemas.js
  - package.json: version 4.223.0; added test:clickhouse-client script
  - README.md: 442 tools total (Read & File System: 94); added clickhouse_client
  - section 250 tests: A=validation x10, B=unit/protocol x20, C=mock-network x10,
    D=security x10, E=error-paths x6 -- 70/70

## Done
- [tested] Add syslog_client tool (v4.222.0)
  - Zero-dep syslog client (pure Node.js dgram/net; no npm deps)
  - Operations: send, send_batch, info
  - Supports RFC 5424 (modern) and RFC 3164 (BSD legacy) formats
  - Transports: UDP, TCP, TCP+TLS
  - lib/syslogClientOps.js (545 lines); lib/schemas/utilSchemas82.js (179 lines)
  - Wired into lib/dispatchRead.js + lib/schemas/utilSchemas.js
  - package.json: version 4.222.0; added test:syslog-client script
  - README.md: 441 tools total (Read & File System: 93); added syslog_client
  - section 249 tests: A=validation x10, B=unit/protocol x20, C=mock-network x10,
    D=security x10, E=error-paths x6 -- 59/59

## Done
- [tested] Add ntp_client tool (v4.221.0)
  - Zero-dep NTP/SNTP client (pure Node.js dgram; no npm deps)
  - Operations: query, sync_check, servers, stratum
  - RFC 4330 / RFC 5905 NTP packet encoding/parsing
  - lib/ntpClientOps.js (359 lines); lib/schemas/utilSchemas81.js (61 lines)
  - Wired into lib/dispatchRead.js + lib/schemas/utilSchemas.js
  - package.json: version 4.221.0; added test:ntp-client script
  - README.md: 440 tools total (Read & File System: 92); added ntp_client
  - section 248 tests: A=validation x10, B=unit/protocol x20, C=mock-network x10,
    D=security x10, E=error-paths x6 -- 56/56

## Done
- [tested] Add influxdb_client tool (v4.220.0)
  - Zero-dep InfluxDB v1/v2/v3 HTTP API client (pure Node.js https; no npm deps)
  - Operations: ping, health, write, query_flux, query_influxql, buckets, orgs, measurements, delete
  - Auth: token (Bearer, v2/v3), username/password (v1 / v2 compat)
  - lib/influxdbClientOps.js (528 lines); lib/schemas/utilSchemas80.js (158 lines)
  - Wired into lib/dispatchRead.js + lib/schemas/utilSchemas.js
  - package.json: version 4.220.0; added test:influxdb-client script
  - README.md: 439 tools total (Read & File System: 91); added influxdb_client
  - section 247 tests: A=validation x10, B=unit/protocol x20, C=mock-network x10,
    D=security x10, E=error-paths x6 -- 56/56

## Done
- [tested] Add cassandra_client tool (v4.219.0)
  - Zero-dep Apache Cassandra CQL native protocol client (pure Node.js net/tls; no npm deps)
  - Operations: info, query, execute, batch, tables, keyspaces, describe, use_keyspace
  - Auth: username/password (SASL plain), unauthenticated
  - CQL Native Protocol v4 (Cassandra 2.2+, ScyllaDB, AstraDB)
  - lib/cassandraClientOps.js; lib/schemas/utilSchemas79.js

## Done
- [tested] Add mongodb_client tool (v4.218.0)
  - Zero-dep MongoDB Wire Protocol client (pure Node.js net/tls; no npm deps)
  - Operations: info, find, find_one, insert, insert_many, update, update_many, delete, delete_many, count, aggregate, list_collections, create_collection, drop_collection, create_index, list_indexes
  - Auth: SCRAM-SHA-1, SCRAM-SHA-256, unauthenticated
  - lib/mongodbClientOps.js; lib/schemas/utilSchemas78.js
  - Wired into lib/dispatchRead.js + lib/schemas/utilSchemas.js
  - package.json: version 4.218.0; added test:mongodb-client script
  - README.md: 437 tools total (Read & File System: 89); added mongodb_client
  - section 245 tests: A=validation x10, B=unit/bson x16, C=mock-network x10, D=security x10, E=error-paths x10 -- 56/56
  - Bug fix: bsonEncodeValue() pushed type-byte constants as raw numbers instead of Buffer.from([type]); fixed all type-byte pushes to wrap in Buffer.from([...])

## Done
- [tested] Add elasticsearch_client tool (v4.217.0)
  - Zero-dep Elasticsearch/OpenSearch client (pure Node.js https; no npm deps)
  - Operations: info, search, get, index, delete, create_index, delete_index, indices, mapping, bulk, count, cluster_health
  - Auth: API key, Basic, Bearer token
  - lib/elasticsearchClientOps.js; lib/schemas/utilSchemas77.js

## Done
- [tested] Add prometheus_client tool (v4.216.0)
  - Zero-dep Prometheus/OpenMetrics text format parser (pure Node.js; no npm deps)
  - Operations: parse, query, labels, stats, filter, fetch, validate
  - Supports Prometheus text exposition format 0.0.4 and OpenMetrics text 1.0
  - HTTP fetch with configurable timeout and size cap (64 MB)
  - Bug fix: metadata (TYPE/HELP) for suffixed names (e.g. _total) now stored under base name
  - lib/prometheusClientOps.js (551 lines); lib/schemas/utilSchemas76.js
  - Wired into lib/dispatchRead.js + lib/schemas/utilSchemas.js
  - package.json: version 4.216.0; added test:prometheus-client script
  - README.md: 435 tools total (Read & File System: 87)
  - section 243 tests: A=validation x10, B=unit x20, C=happy-path x10, D=security x10, E=error-paths x6 -- 56/56

## Done
- [tested] Add k8s_client tool (v4.215.0)
  - Zero-dep Kubernetes API client (pure Node.js https; reads kubeconfig; no npm deps)
  - Operations: pods, deployments, services, namespaces, nodes, logs, get, list, apply, delete
  - Auth: kubeconfig (token, client-cert, basic); in-cluster service account token
  - lib/k8sClientOps.js; lib/schemas/utilSchemas75.js

## Done
- [tested] Add registry_client tool (v4.214.0)
  - Zero-dep Docker/OCI registry client (pure Node.js https; no npm deps)
  - Operations: ping, tags, manifest, config, layers, exists, digest
  - Supports Docker Hub, GCR, ECR, GHCR, and any OCI-compliant registry
  - Auth: anonymous, Basic, Bearer token (OAuth2 token exchange)
  - parseImageRef: auto-parses docker-pull format, normalises docker.io
  - Security: 16 MB response cap; NUL-byte guard; 20 s default timeout
  - lib/registryClientOps.js (598 lines); lib/schemas/utilSchemas74.js
  - Wired into lib/dispatchRead.js + lib/schemas/utilSchemas.js
  - package.json: version 4.214.0; added test:registry-client script
  - README.md: 433 tools total (Read & File System: 85)
  - section 241 offline tests: A=validation x10, B=unit x20, D=security x10,
    E=error-paths x5, F=concurrency x3 -- 48/48
  - section 241 full tests: 76/76 (requires network for C/E/F network sections)

- [tested] Add ssh_keygen tool (v4.213.0)
- [tested] Add wasm_client tool (v4.212.0)
- [tested] Add 3d_client tool (v4.211.0)
- [tested] Add image_client tool (v4.210.0)
- [tested] Add video_client tool (v4.209.0)
- [tested] Add audio_client tool (v4.208.0)
- [tested] Add epub_client tool (v4.207.0)
- [tested] Add font_client tool (v4.206.0)
- [tested] Add geo_client tool (v4.205.0)
- [tested] Add log_client tool (v4.204.0)
- [tested] Add sqlite_client tool (v4.203.0)
- [tested] Add ical_client tool (v4.202.0)
- [tested] Sync README.md with 420 server tools (v4.201.0)
- [tested] Add pcap_client tool (v4.200.0)
- [tested] Add hdf5_client tool (v4.199.0)
- [tested] Add arrow_client tool (v4.198.0)
- [tested] Add orc_client tool (v4.197.0)
- [tested] Add parquet_client tool (v4.196.0)
- [tested] Add thrift_client tool (v4.195.0)
- [tested] Add avro_client tool (v4.196.0)
- [tested] Add jsonrpc_client tool (v4.193.0)
- [tested] Add protobuf_client tool (v4.192.0)
- [tested] Add cbor_client tool (v4.191.0)
- [tested] Add msgpack_client tool (v4.190.0)
- [tested] Add pdf_client tool (v4.189.0)
- [tested] Add excel_client tool (v4.188.0)
- [tested] Add json_client tool (v4.187.0)
- [tested] Add tar_client tool (v4.186.0)
- [tested] Add zip_client tool (v4.185.0)
- [tested] Add graphql_client tool (v4.184.0)
- [tested] Add http_client tool v4.183.0 (136/136 tests)
- [tested] Add jsonl_client tool (v4.182.0)
- [tested] Add csv_client tool (v4.181.0)
- [tested] Add markdown_client tool (v4.180.0)
- [tested] Add xml_client tool (v4.178.0)
- [tested] Add ini_client tool (v4.178.0)
- [tested] Add yaml_client tool (v4.177.0)
- [tested] Add toml_client tool (v4.176.0)
- [tested] Add dotenv_client tool (v4.175.0)
- [tested] Add grpc_client tool (v4.174.0)
- [tested] Add memcached_client tool (v4.173.0)
- [tested] Add kafka_client tool (v4.172.0)
- [tested] Add snmp_client tool (v4.171.0)
- [tested] Add ftp_client tool (v4.170.0)
- [tested] Add ldap_client tool (v4.169.0)
- [tested] Add nats_client tool (v4.168.0)
- [tested] Add stomp_client tool (v4.166.0)
- [tested] Add amqp_client tool (v4.166.0)
- [tested] Add mqtt_client tool (v4.165.0)

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

## Done
- [tested] Add tftp_client tool (v4.230.0)
  - Zero-dep TFTP RFC 1350/2347/2348/2349 client (pure Node.js dgram; no npm deps)
  - Operations: get, put, info
  - lib/tftpClientOps.js (721 lines); lib/schemas/utilSchemas90.js (62 lines)
  - Wired into lib/dispatchRead.js + lib/schemas/utilSchemas.js
  - package.json: version 4.230.0; added test:tftp-client script
  - README.md: 449 tools total (Network & Messaging: 36); added tftp_client
  - section 257 tests: A=pure-helpers x40, B=validation x15, C=mock-network x13, D=security x10, E=concurrency x8 -- 86/86
