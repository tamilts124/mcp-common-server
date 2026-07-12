## Status legend
todo / in-progress / done / tested / blocked

## Done
- [tested] Add pdf_client tool (v4.189.0)
  - Zero-dep PDF reader/writer/manipulator (pure Node.js; no npm deps)
  - Operations: info, get_text, merge, split, rotate, remove_pages, add_watermark, encrypt, decrypt
  - Security: 100 MB file cap; 10,000 page limit; NUL-byte path guard; %PDF- header validation
  - lib/pdfClientOps.js (866 lines); lib/schemas/utilSchemas50.js; wired into dispatchRead.js + utilSchemas.js
  - section 217 tests: A=validation x10, B=unit x20, C=happy-path x20, D=security x10, E=error-paths x10, F=concurrency x5 -- 77/77

## Done
- [tested] Add excel_client tool (v4.188.0)
  - Zero-dep XLSX reader/writer/editor (pure Node.js; no npm deps)
  - Operations: read, get_cell, set_cell, get_range, set_range, add_sheet, delete_sheet, list_sheets, append_rows, delete_rows, stringify
  - Supports Office Open XML (.xlsx) only — not legacy .xls BIFF format
  - ZIP reader/writer (DEFLATE + STORED), CRC-32, minimal XML parser, shared strings, date-format detection
  - Security: 50 MB file cap; 1,000,000 row limit; 16,384 col limit; NUL-byte path guard; row >= 1 guard
  - lib/excelClientOps.js (1001 lines); lib/schemas/utilSchemas49.js; wired into dispatchRead.js + utilSchemas.js
  - section 216 tests: A=validation x10, B=unit x20, C=happy-path x20, D=security x10, E=error-paths x10, F=concurrency x5 -- 97/97

- [tested] Add json_client tool (v4.187.0)
  - Fine-grained JSON file editor (pure Node.js; zero npm deps)
  - Operations: read, get, set, delete, keys, merge, patch, stringify
  - Completes the file-format client family: dotenv/toml/yaml/ini/xml/markdown/csv/jsonl/zip/tar → json
  - lib/jsonClientOps.js (478 lines); lib/schemas/utilSchemas48.js; wired into dispatchRead.js + utilSchemas.js
  - section 215 tests: A=validation x10, B=unit x20, C=happy-path x20, D=security x10, E=error-paths x10, F=concurrency x5 -- 75/75
- [tested] Add tar_client tool (v4.186.0)
  - Fine-grained TAR file manipulation (pure Node.js; zero npm deps)
  - Operations: list, read, extract, add, delete, create, info
  - Supports .tar, .tar.gz/.tgz (gzip), .tar.bz2 (bzip2 detection), .tar.xz (xz detection)
  - Builds on tarOps.js (parseTar, assertSafeEntryName, splitName, buildHeader)
  - lib/tarClientOps.js (644 lines); lib/schemas/utilSchemas47.js; wired into dispatchRead.js + utilSchemas.js
  - section 214 tests: A=validation x10, B=unit x20, C=happy-path x20, D=security x10, E=error-paths x10, F=concurrency x5 -- 95/95

## Done
- [tested] Add zip_client tool (v4.185.0)
- [tested] Add graphql_client tool (v4.184.0)
- [tested] Add http_client tool v4.183.0 (136/136 tests)
- [tested] Add jsonl_client tool (v4.182.0)
- [tested] Add csv_client tool (v4.181.0)
- [tested] Add markdown_client tool (v4.180.0)
- [tested] Add xml_client tool (v4.179.0)
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
- [tested] Add stomp_client tool (v4.167.0)
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
