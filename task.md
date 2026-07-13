## Status legend
todo / in-progress / done / tested / blocked

## In Progress
- [tested] Add video_client tool (v4.209.0)
  - Zero-dep video container reader (pure Node.js; no npm deps)
  - Operations: info, streams, tags, chapters, validate
  - Formats: MP4/MOV (ISO BMFF), MKV/WebM (EBML/Matroska), AVI (RIFF)

## Done
- [tested] Add audio_client tool (v4.208.0)
  - Zero-dep audio metadata reader (pure Node.js; no npm deps)
  - Operations: info, tags, covers, chapters, validate
  - Formats: MP3 (ID3v1/ID3v2.2/2.3/2.4), FLAC, OGG Vorbis/Opus, WAV, AIFF/AIFF-C, M4A/MP4, WMA/ASF
  - Security: 500 MB file cap; 50 MB per-cover cap; NUL-byte and directory guards
  - lib/audioClientOps.js (1347 lines); lib/schemas/utilSchemas68.js
  - Wired into lib/dispatchRead.js + lib/schemas/utilSchemas.js
  - package.json: version 4.208.0; added test:audio-client script
  - README.md: 427 tools total (Read & File System: 79)
  - section 235 tests: A=validation x10, B=unit x20, C=happy-path x20,
    D=security x10, E=error-paths x10, F=concurrency x6 -- 76/76

## Done
- [tested] Add epub_client tool (v4.207.0)
  - Zero-dep EPUB ebook reader (pure Node.js; no npm deps)
  - Operations: info, metadata, toc, chapters, read, images
  - Formats: EPUB 2 and EPUB 3 (.epub)
  - Security: 200 MB file cap; 5 MB per-read cap; NUL-byte and directory guards
  - lib/epubClientOps.js (536 lines); lib/schemas/utilSchemas67.js
  - Wired into lib/dispatchRead.js + lib/schemas/utilSchemas.js
  - package.json: version 4.207.0; added test:epub-client script
  - README.md: 426 tools total (Read & File System: 78)
  - section 234 tests: A=validation x10, B=unit x20, C=happy-path x20,
    D=security x10, E=error-paths x10, F=concurrency x6 -- 76/76

## Done
- [tested] Add font_client tool (v4.206.0)
  - Zero-dep font file reader (pure Node.js; no npm deps)
  - Operations: info, names, metrics, tables, glyphs, unicode
  - Formats: TTF/OTF (OpenType), WOFF, WOFF2 (header decode only), TTC (first font)
  - Security: 50 MB file cap; NUL-byte guard; directory guard
  - lib/fontClientOps.js (1323 lines); lib/schemas/utilSchemas66.js
  - Wired into lib/dispatchRead.js + lib/schemas/utilSchemas.js
  - Fixed UTF-16 BE name decoding in decodeNameString (was incorrectly using utf16le + reverse)
  - package.json: version 4.206.0; added test:font-client script
  - README.md: 425 tools total (Read & File System: 77)
  - section 233 tests: A=validation x10, B=unit x20, C=happy-path x20,
    D=security x10, E=error-paths x10, F=concurrency x6 -- 76/76

## Done
- [tested] Add geo_client tool (v4.205.0)
  - Zero-dep geospatial file reader (pure Node.js; no npm deps)
  - Operations: info, read, search, stats, bbox, convert
  - Formats: GeoJSON (.geojson/.json), KML (.kml), GPX (.gpx), TopoJSON (.json)
  - Filters: geometry type, property matching, bounding box, feature ID
  - Security: 200 MB file cap; 500,000 feature limit; NUL-byte guard; directory guard
  - lib/geoClientOps.js (1043 lines); lib/schemas/utilSchemas65.js
  - Wired into lib/dispatchRead.js + lib/schemas/utilSchemas.js
  - package.json: version 4.205.0; added test:geo-client script
  - README.md: 424 tools total (Read & File System: 76)
  - section 232 tests: A=validation x10, B=unit x20, C=happy-path x20,
    D=security x10, E=error-paths x10, F=concurrency x6 -- 76/76

## Done
- [tested] Add log_client tool (v4.204.0)
  - Zero-dep structured log file reader/analyzer (pure Node.js; no npm deps)
  - Operations: info, read, search, stats, tail, export
  - Formats: JSON-lines, Apache/Nginx CLF+combined, syslog RFC3164/5424, W3C extended, TSV/CSV logs
  - Filters: level, time range, pattern/regex, field matching, AND/OR combinators
  - Security: 500 MB file cap; 5,000,000 line limit; NUL-byte guard; directory guard
  - lib/logClientOps.js (841 lines); lib/schemas/utilSchemas64.js
  - Wired into lib/dispatchRead.js + lib/schemas/utilSchemas.js
  - package.json: version 4.204.0; added test:log-client script
  - README.md: 423 tools total (Read & File System: 75)
  - section 231 tests: A=validation x10, B=unit x20, C=happy-path x20,
    D=security x10, E=error-paths x10, F=concurrency x6 -- 76/76

## Done
- [tested] Add sqlite_client tool (v4.203.0)
  - Zero-dep stateless SQLite file reader/writer (pure Node.js; no npm deps)
  - Operations: info, query, execute, tables, schema, export
  - Reads/writes .db/.sqlite/.sqlite3 files directly without session management
  - Security: 256 MB file cap; 1,000,000 row limit; NUL-byte guard; directory guard
  - Complement to existing sqlite session tools (sqlite_create/connect/execute/disconnect)
  - lib/sqliteClientOps.js (985 lines); lib/schemas/utilSchemas63.js
  - Wired into lib/dispatchRead.js + lib/schemas/utilSchemas.js
  - package.json: version 4.203.0; added test:sqlite-client script
  - README.md: 422 tools total (Read & File System: 74)
  - section 230 tests: A=validation x10, B=unit x20, C=happy-path x20,
    D=security x10, E=error-paths x10, F=concurrency x6 -- 79/79

## Done
- [tested] Add ical_client tool (v4.202.0)
  - Zero-dep iCalendar (.ics) file reader/parser (pure Node.js; no npm deps)
  - Operations: info, events, todos, freebusy, to_json
  - Supports VEVENT, VTODO, VJOURNAL, VFREEBUSY, VTIMEZONE components
  - RFC 5545 / 2445 compliant; recurrence rules (RRULE), VALARM, attachments
  - Line folding, CRLF/LF, quoted-printable, base64, EXDATE support
  - Security: 50 MB file cap; 100,000 component limit; NUL-byte guard; directory guard
  - lib/icalClientOps.js (560 lines); lib/schemas/utilSchemas62.js
  - Wired into lib/dispatchRead.js + lib/schemas/utilSchemas.js
  - package.json: version 4.202.0; added test:ical-client script
  - README.md: 421 tools total (Read & File System: 73)
  - section 229 tests: A=validation x10, B=unit x20, C=happy-path x20,
    D=security x10, E=error-paths x10, F=concurrency x6 -- 79/79

## Done
- [tested] Sync README.md with actual server tool count (v4.201.0)
  - 118 tools were wired in the server but missing from README documentation
  - Updated all 10 category sections with correct tool lists and counts
  - Read & File System: 54→72 (+18 tools: semver_compare, url_parse, json_flatten, uuid_generate,
    diff_strings, base62_encode, base62_decode, markdown_to_html, xml_parse, string_transform,
    ip_cidr, color_convert, number_format, date_calc, text_extract, str_similarity, cron_next, json_unflatten[was dup])
  - Write & Edit: 8→22 (+14: delete_file, delete_files, move_file, copy_file, move_directory,
    copy_directory, create_directory, delete_directory, gzip_compress, brotli_compress,
    md_to_docx, md_to_pdf, pdf_to_docx, json_path_set)
  - Code Analysis & Audit: 51→79 (+28 code/HTML/security analysis tools)
  - Security Scanning: 44→57 (+13: jwt_*, crypto_*, hmac_*, totp_*, password_generate, key_generate, oauth2_token, tls_cert_inspect)
  - Browser Automation: 36→71 (+35 browser tools: recording, pages, cookies, network, frames, etc.)
  - Network & Messaging: 23→29 (+6: tcp_client, udp_client, ssh_exec, http_multi_fetch, multipart_upload, http_serve)
  - Data & Format Utilities: 27→31 (+4: template_render, table_ops, graphql_query, jsonl_ops)
  - Execution & Process: 7→8 (+1: send_process_input)
  - Total: 304→420 tools
  - package.json: version 4.200.0→4.201.0

## Done
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
