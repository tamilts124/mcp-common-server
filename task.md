## Status legend
todo / in-progress / done / tested / blocked

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
  - Zero-dep Apache Parquet file reader (pure Node.js; no npm deps)
  - Operations: info, read, schema, row_group, to_json, to_csv
  - Thrift Compact protocol decoder for parsing Parquet footer metadata
  - Physical types: BOOLEAN, INT32, INT64, INT96, FLOAT, DOUBLE, BYTE_ARRAY, FIXED_LEN_BYTE_ARRAY
  - Logical/converted types: STRING, DATE, TIMESTAMP, DECIMAL, UUID, ENUM, JSON, BSON, LIST, MAP
  - Encodings: PLAIN, RLE, BIT_PACKED, DELTA_BINARY_PACKED, DELTA_LENGTH_BYTE_ARRAY, PLAIN_DICTIONARY, RLE_DICTIONARY
  - Compression: UNCOMPRESSED, SNAPPY (pure-JS), GZIP (node:zlib)
  - Definition/repetition level support (RLE/bit-packed, length-prefixed v1 and inline v2)
  - Security: 200 MB file cap; 10,000,000 row limit; NUL-byte path guard; directory path rejected
  - lib/parquetClientOps.js (1080 lines); lib/schemas/utilSchemas57.js
  - Wired into lib/dispatchRead.js + lib/schemas/utilSchemas.js
  - package.json: version 4.196.0; added test:parquet-client script
  - README.md: 300 tools total (Read & File System: 51)
  - section 224 tests: A=validation x10, B=unit x20, C=happy-path x20,
    D=security x10, E=error-paths x10, F=concurrency x6 -- 76/76

## Done
- [tested] Add thrift_client tool (v4.195.0)
  - Zero-dep Apache Thrift binary + compact protocol encoder/decoder (pure Node.js; no npm deps)
  - Operations: encode, decode, encode_file, decode_file, inspect
  - Binary protocol: fixed-width int16/32/64 (big-endian), big-endian double, 4-byte string length prefix
  - Compact protocol: zigzag VarInt for i16/i32/i64, delta field IDs, bool embedded in type nibble, little-endian double
  - Full type system: BOOL(2), BYTE(3), DOUBLE(4), I16(6), I32(8), I64(10), STRING/BINARY(11), STRUCT(12), MAP(13), SET(14), LIST(15), UUID(16)
  - Schema resolver: string shorthands (bool/byte/i8/i16/i32/i64/double/string/binary/uuid) + object form (struct/list/set/map)
  - Schema-less inspect: binary protocol wire-level field layout (typeId, fieldId, value) with sub-struct recursion
  - BigInt support for I64 (encode from number/BigInt/string; decode to number or {__i64:string})
  - UUID encode/decode: 8-4-4-4-12 hex format <-> 16-byte binary
  - STRING/BINARY: UTF-8 auto-detection; raw binary returned as {__binary,length}
  - Security: 50 MB file cap; 64-level nesting depth limit; 1,000,000 element limit; NUL-byte path guard; directory path rejected
  - lib/thriftClientOps.js (1067 lines); lib/schemas/utilSchemas56.js
  - Wired into lib/dispatchRead.js + lib/schemas/utilSchemas.js
  - package.json: version 4.195.0; added test:thrift-client script
  - README.md: 299 tools total (Read & File System: 50)
  - section 223 tests: A=validation x10, B=unit x20, C=happy-path x20,
    D=security x10, E=error-paths x10, F=concurrency x6 -- 76/76

## Done
- [tested] Add avro_client tool (v4.194.0)
  - Zero-dep Apache Avro binary encoder/decoder (pure Node.js; no npm deps)
  - Operations: encode, decode, encode_file, decode_file, inspect, schema_fingerprint
  - Full Avro binary encoding spec: null, boolean, int, long, float, double, bytes, string, record, enum, array, map, union, fixed
  - Long/int: variable-length zigzag encoding (ZigZag + VarInt)
  - Object Container File (OCF) read/write support with sync markers
  - Schema fingerprinting: Rabin fingerprint (64-bit) for schema evolution
  - lib/avroClientOps.js; lib/schemas/utilSchemas55.js

## Done
- [tested] Add jsonrpc_client tool (v4.193.0)
  - Zero-dep JSON-RPC 2.0 client (HTTP + TCP + Unix socket transports)
  - Operations: call, notify, batch, call_tcp, call_unix
  - HTTP/HTTPS POST transport with Content-Type: application/json
  - TCP socket transport with newline-delimited JSON framing
  - Unix domain socket transport (same framing as TCP)
  - Full JSON-RPC 2.0 spec: single calls, fire-and-forget notifications, batch requests
  - Batch: aligned responses by id; notification entries marked notify:true
  - Auto-incrementing id generator; explicit id override supported
  - Response validation: RPC-level errors surfaced as ToolError with error code
  - Security: 10 MB response cap; 100-call batch limit; NUL-byte path guard for Unix sockets
  - Timeouts: default 30s for HTTP, 30s for sockets; configurable
  - lib/jsonrpcClientOps.js (468 lines); lib/schemas/utilSchemas54.js (140 lines)
  - Wired into lib/dispatchRead.js + lib/schemas/utilSchemas.js
  - package.json: version 4.193.0; added test:jsonrpc-client script
  - README.md: 297 tools total (Read & File System: 48)
  - section 221 tests: A=validation x10, B=unit x20, C=happy-path x20,
    D=security x10, E=error-paths x10, F=concurrency x6 -- 76/76

## Done
- [tested] Add protobuf_client tool (v4.192.0)
  - Zero-dep Protocol Buffers (proto3) binary encoder/decoder (pure Node.js; no npm deps)
  - Operations: encode, decode, encode_file, decode_file, inspect
  - Full proto3 wire format: varint (WT0), 64-bit fixed (WT1), length-delimited (WT2), 32-bit fixed (WT5)
  - All scalar types: int32/64, uint32/64, sint32/64 (zigzag), bool, enum, fixed32/64, sfixed32/64, float, double, string, bytes, message
  - BigInt support for int64/uint64/sint64/sfixed64 (encoded as { __int64: 'string' })
  - Schema descriptor: { fieldNumber: { name, type, fields? } } for human-readable names + type-aware decode
  - Schema-less best-effort decode: varints as signed int64, len-delim as string or bytes
  - Repeated fields: multiple same-tag occurrences automatically coalesced into arrays
  - Nested messages: recursive encode/decode with depth tracking
  - inspect: wire-level field layout with sub-message heuristics (configurable max_depth 1-10)
  - Security: 50 MB file cap; 64-level nesting depth limit; 1,000,000 field limit; NUL-byte path guard
  - lib/protobufClientOps.js (805 lines); lib/schemas/utilSchemas53.js
  - Wired into lib/dispatchRead.js + lib/schemas/utilSchemas.js
  - package.json: version 4.192.0; added test:protobuf-client script
  - README.md: 296 tools total (Read & File System: 47)
  - section 220 tests: A=validation x10, B=unit x20, C=happy-path x20,
    D=security x10, E=error-paths x10, F=concurrency x6 -- 76/76

## Done
- [tested] Add cbor_client tool (v4.191.0)
  - Zero-dep CBOR (RFC 8949) encoder/decoder (pure Node.js; no npm deps)
  - Operations: encode, decode, encode_file, decode_file, inspect
  - Implements full RFC 8949 CBOR spec: MT0 uint, MT1 negint, MT2 bytes, MT3 text,
    MT4 array, MT5 map, MT6 tags (bignum tags 2/3), MT7 float16/32/64 + simples
  - Indefinite-length encoding for bytes, text, arrays, and maps (break code 0xff)
  - BigInt support for uint64/int64 and bignum tags 2/3
  - CborReader class with depth tracking, element counting, and offset reporting
  - toJsonSafe: Buffer→{__bytes,length}; BigInt→{__bigint}; tag→{__tag,value}
  - Security: 50 MB file cap; 100-level nesting depth limit; 1,000,000 element limit;
    NUL-byte path guard; directory path rejected; empty hex/base64 caught
  - lib/cborClientOps.js (852 lines); lib/schemas/utilSchemas52.js
  - Wired into lib/dispatchRead.js + lib/schemas/utilSchemas.js
  - package.json: version 4.191.0; added test:cbor-client script
  - README.md: 295 tools total (Read & File System: 46)
  - section 219 tests: A=validation x10, B=unit x20, C=happy-path x20,
    D=security x10, E=error-paths x10, F=concurrency x5 -- 96/96

## Done
- [tested] Add msgpack_client tool (v4.190.0)
  - Zero-dep MessagePack encoder/decoder (pure Node.js; no npm deps)
  - Operations: encode, decode, encode_file, decode_file, inspect
  - Implements full MessagePack spec: nil, bool, int, float, str, bin, array, map, ext types
  - MsgpackReader class; encode/decodeBuffer/inspectBuffer exported for tests
  - Security: 50 MB file cap; 100-level depth limit; 1,000,000 element limit; NUL-byte path guard
  - lib/msgpackClientOps.js (674 lines); lib/schemas/utilSchemas51.js; wired into dispatchRead.js + utilSchemas.js
  - section 218 tests: A=validation x10, B=unit x20, C=happy-path x20, D=security x10, E=error-paths x10, F=concurrency x5 -- 94/94

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
