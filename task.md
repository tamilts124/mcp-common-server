## Status legend
todo / in-progress / done / tested / blocked

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
  - Zero-dep PCAP/PCAPng network capture file reader (pure Node.js; no npm deps)
  - Operations: info, read, summary, filter, to_json
  - Formats: PCAP little/big/nanosecond variants, PCAPng (SHB+IDB+EPB/SPB)
  - Link layers: Ethernet, NULL/loopback, Linux SLL, Raw IP
  - Protocols: IPv4, IPv6, TCP, UDP, ICMPv4, ICMPv6, ARP, OSPF, GRE, ESP, AH
  - App protocols: DNS, DHCP, NTP, SNMP, mDNS, VXLAN (auto-detected from UDP ports)
  - Filter: field==value, !=, >=, <=, >, < combined with && and ||
  - Security: 500 MB file cap; 10,000,000 packet limit; NUL-byte guard; directory guard
  - lib/pcapClientOps.js (755 lines); lib/schemas/utilSchemas61.js
  - Wired into lib/dispatchRead.js + lib/schemas/utilSchemas.js
  - package.json: version 4.200.0; added test:pcap-client script
  - README.md: 304 tools total (Read & File System: 54)
  - section 228 tests: A=validation x10, B=unit x20, C=happy-path x20,
    D=security x10, E=error-paths x10, F=concurrency x6 -- 76/76

## Done
- [tested] Add hdf5_client tool (v4.199.0)
  - Zero-dep HDF5 file reader (pure Node.js; no npm deps)
  - Operations: info, list, attrs, read, to_json, to_csv
  - Datatypes: fixed-point int (int8/16/32/64 signed/unsigned), float (float32/float64),
    string (fixed/variable-length), compound, array, vlen, opaque, enum, reference, bitfield
  - Superblock v0-v2, B-tree v1/v2, symbol tables, object headers v1/v2
  - Local/global/fractal heaps, v2 link info + name-indexed B-tree traversal
  - Filters: none, deflate/gzip (node:zlib), shuffle, fletcher32, szip (best-effort)
  - Security: 256 MB file cap; 10,000,000 element limit; NUL-byte path guard;
    directory path rejected; max 64-level group depth
  - lib/hdf5ClientOps.js (1705 lines); lib/schemas/utilSchemas60.js
  - Wired into lib/dispatchRead.js + lib/schemas/utilSchemas.js
  - package.json: version 4.199.0; added test:hdf5-client script
  - README.md: 303 tools total (Read & File System: 53)
  - section 227 tests: A=validation x10, B=unit x20, C=happy-path x20,
    D=security x10, E=error-paths x10, F=concurrency x6 -- 76/76

## Done
- [tested] Add arrow_client tool (v4.198.0)
  - Zero-dep Apache Arrow IPC file/stream reader (pure Node.js; no npm deps)
  - Operations: info, schema, read, to_json, to_csv
  - Column types: NULL, Bool, Int (8/16/32/64 signed/unsigned), FloatingPoint (half/single/double),
    Binary, LargeBinary, Utf8, LargeUtf8, Date (day/ms), Time (32/64), Timestamp, Duration,
    Interval, Decimal (128/256-bit), FixedSizeBinary, List, LargeList, FixedSizeList, Struct, Map,
    Union, and dictionary-encoded variants of any type
  - Supports both Arrow IPC File format (.arrow, magic header/footer) and IPC Stream format (.arrows)
  - Minimal FlatBuffers reader for Schema, RecordBatch, DictionaryBatch, and Footer messages
  - IEEE 754 half-precision float decoder; time/date/timestamp formatted to ISO strings
  - Security: 200 MB file cap; 10,000,000 row limit; NUL-byte path guard; directory path rejected
  - lib/arrowClientOps.js (1288 lines); lib/schemas/utilSchemas59.js
  - Wired into lib/dispatchRead.js + lib/schemas/utilSchemas.js
  - package.json: version 4.198.0; added test:arrow-client script
  - README.md: 302 tools total (Read & File System: 52)
  - section 226 tests: A=validation x10, B=unit x20, C=happy-path x20,
    D=security x10, E=error-paths x10, F=concurrency x6 -- 76/76

## Done
- [tested] Add orc_client tool (v4.197.0)
  - Zero-dep Apache ORC file reader (pure Node.js; no npm deps)
  - Operations: info, schema, stripe, read, to_json, to_csv
  - Column types: BOOLEAN, BYTE, SHORT, INT, LONG, FLOAT, DOUBLE, STRING, BINARY,
    TIMESTAMP, DATE, DECIMAL, VARCHAR, CHAR, LIST, MAP, STRUCT, UNION, TIMESTAMP_INSTANT
  - Column encodings: DIRECT, DIRECT_V2, DICTIONARY, DICTIONARY_V2 (RLE v1 and v2)
  - Compression: NONE, ZLIB (node:zlib), SNAPPY (pure-JS), LZ4 (raw block decode)
  - Minimal Protocol Buffer decoder for ORC footer/postscript/stripe-footer parsing
  - Security: 200 MB file cap; 10,000,000 row limit; NUL-byte path guard; directory path rejected
  - lib/orcClientOps.js (1270 lines); lib/schemas/utilSchemas58.js
  - Wired into lib/dispatchRead.js + lib/schemas/utilSchemas.js
  - package.json: version 4.197.0; added test:orc-client script
  - README.md: 301 tools total (Read & File System: 51)
  - section 225 tests: A=validation x10, B=unit x20, C=happy-path x20,
    D=security x10, E=error-paths x10, F=concurrency x6 -- 76/76

- [tested] Add parquet_client tool (v4.196.0)
- [tested] Add thrift_client tool (v4.195.0)
- [tested] Add avro_client tool (v4.194.0)
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
