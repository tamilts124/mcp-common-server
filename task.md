## Status legend
todo / in-progress / done / tested / blocked

## Current Task
(none)

## Done
- [tested] Add markdown_client tool (v4.180.0)
  - Zero-dep Markdown parser/renderer/editor (pure Node.js fs; no npm deps)
  - Operations: read, get_section, set_section, extract_links, extract_headings, extract_code_blocks, convert_to_html, stringify
  - Supports: ATX headings (#/##/###), setext headings, fenced code blocks, inline code, bold/italic/strikethrough, links, images, blockquotes, ordered/unordered lists, horizontal rules, tables (GFM), HTML passthrough with safe-tag whitelist
  - Security: path NUL guard; 4 MB file cap; 50,000-node limit; dangerous HTML tags (script/style/iframe) escaped
  - lib/markdownClientOps.js; lib/schemas/utilSchemas41.js; wired into dispatchRead.js + utilSchemas.js
  - section 208 tests: A=input-validation x10, B=parser-unit x20, C=html-render x10, D=happy-path x20, E=security x10, F=concurrency x5 -- 75/75

## Done
- [tested] Add xml_client tool (v4.179.0)
  - Zero-dep XML file reader/writer/query/transform (pure Node.js; no npm deps)
  - Operations: read, get, set, delete, list, query (XPath-like), stringify, transform
  - Supports: elements, attributes, text nodes, CDATA, comments, processing instructions, namespaces
  - Security: path NUL guard; 4 MB file cap; nesting depth limit (max 50); 100,000-node limit
  - lib/xmlClientOps.js; lib/schemas/utilSchemas40.js; wired into dispatchRead.js + utilSchemas.js
  - section 207 tests: A=input-validation, B=parser-unit, C=writer-unit, D=happy-path, E=security, F=concurrency

## Done
- [tested] Add ini_client tool (v4.178.0)
  - Zero-dep INI/CFG file parser and writer (pure Node.js fs; no npm deps)
  - Operations: read, get, set, delete, list_keys, list_sections, merge, stringify
  - Supports: '=' and ':' separators, '#'/';' comments (full-line and inline), line continuation (\), single/double-quoted values, global (pre-section) keys under __global__
  - Security: path NUL guard; 4 MB file cap; 50,000-key limit; section/key name length cap (256 chars)
  - lib/iniClientOps.js; lib/schemas/utilSchemas39.js; wired into dispatchRead.js + utilSchemas.js
  - section 206 tests: A=input-validation x10, B=parser-unit x20, C=writer-unit x10, D=happy-path x20, E=security x10, F=concurrency x5 -- 75/75

## Done
- [tested] Add yaml_client tool (v4.177.0)
  - Zero-dep YAML 1.2 subset parser/writer (pure Node.js fs; no npm deps)
  - Operations: read, get, set, delete, list_keys, list_sections, merge, stringify
  - Security: path NUL guard; 4 MB file cap; key nesting depth limit (max 20); 50,000 key limit
  - lib/yamlClientOps.js; lib/schemas/utilSchemas38.js; wired into dispatchRead.js + utilSchemas.js
  - section 205 tests: A=input-validation x10, B=parser-unit x20, C=writer-unit x10, D=happy-path x20, E=security x10, F=concurrency x5 -- 80/80

## Done
- [tested] Add toml_client tool (v4.176.0)
  - Zero-dep TOML v1.0 parser/writer (pure Node.js fs; no npm deps)
  - Operations: read, get, set, delete, list_keys, list_sections, merge, stringify
  - Supports: strings (basic/literal/multiline), integers (decimal/hex/octal/binary), floats (inf/nan), booleans, dates, arrays, inline tables, standard tables, array of tables
  - Security: path NUL guard; 4 MB file cap; key nesting depth limit (max 20); 50,000 key limit
  - lib/tomlClientOps.js; lib/schemas/utilSchemas37.js; wired into dispatchRead.js + utilSchemas.js
  - section 204 tests: A=input-validation x10, B=parser-unit x20, C=writer-unit x10, D=happy-path x20, E=security x10, F=concurrency x5 -- 75/75

## Done
- [tested] Add dotenv_client tool (v4.175.0)
  - Zero-dep .env file parser/writer (pure Node.js fs; no npm deps)
  - Operations: read, write, delete, merge, validate, to_shell, list
  - Security: path validation; key name guards (no NUL/CRLF/spaces); value size cap
  - lib/dotenvClientOps.js; lib/schemas/utilSchemas36.js; wired into dispatchRead.js + utilSchemas.js
  - section 203 tests: A=input-validation, B=parser-unit, C=writer-unit, D=happy-path, E=security, F=concurrency

## Done
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
