## Status legend
todo / in-progress / done / tested / blocked

## Current Task
- [x] Add send_process_input tool — status: tested (43/43, v4.157.0)
  - Sends stdin text to a running background process (started with start_process)
  - Enables interactive process communication: REPLs, CLIs, databases, etc.
  - Schema in execSchemas.js; handler in processOps.js + dispatchWrite.js; section 185 tests
  - start_process now spawns with stdin as pipe (was 'ignore'); uncaughtException handler silences Windows EOF on cleanup

## History
Completed task entries older than the ones below are archived in task-history.md to keep this file cheap to read each session.

## Tasks
- [x] Add git_write_ops tool — status: tested (77/77, v4.156.0)
  - operations: add, commit, push, pull, checkout, branch, reset, stash, merge, rebase, cherry_pick, tag
  - uses spawnSync (no shell) for injection safety; requires MCP_ALLOW_EXEC=true
  - schema in execSchemas.js; wired in dispatchGit.js; section 184a tests (A-J)

- [x] Add image_ops tool — status: tested (76/76, v4.155.0)
  - notes: imageOps.js (zero-dep; format detection PNG/JPEG/GIF/BMP/WEBP from magic bytes; header-only info for all formats; PNG pixel ops: bilinear resize w/ aspect-ratio control, crop, 90/180/270° rotate, h/v flip, BT.709 grayscale; alpha-channel preserved across all ops; RGBA PNG encoder built-in; 50 MB input cap; 16000×16000 / 100 MP output cap). utilSchemas18.js (image_ops schema). Wired in dispatchRead.js + utilSchemas.js. Fixed 3 test bugs vs prev session: makeJpegBuf SOI was 3 bytes (should be 2); SOF0 had incomplete length; E5 checked wrong pixel coord after 90° CW; added buildRoots()+project-relative TMP_DIR for dispatch path tests. 76/76 across A–J.

- [x] Add websocket_client + sse_client tools — status: tested (75/75, v4.154.0)
  - notes: websocketClientOps.js (zero-dep; RFC 6455 WebSocket handshake + frame protocol over Node.js net/tls/crypto; ws:// and wss://; text/binary frames; masked client frames; fragmented messages; auto ping→pong; close frame echo; max_messages/timeout caps; CRLF/null-byte injection guards on URL/headers/subprotocol; up to 100 send messages with per-message delay_ms). sseClientOps.js (zero-dep; RFC 8895 SSE parser; LF/CRLF/CR line endings; multi-line data; id/event/retry fields; event_types filter; last_event_id resume; max_events/timeout caps; content-type validation; HTTP status guard; CRLF injection guards). Both wired in dispatchRead.js + utilSchemas17.js chained into utilSchemas.js. Fixed previous-session utilSchemas.js corruption (premature require+module.exports at top; duplicate export missing schema 17). 75/75 tests across 10 sub-sections (A=WS validation, B=frame unit, C=WS happy-path, D=ping/pong+close, E=SSE validation, F=SseParser unit, G=SSE happy-path, H=filters+truncation, I=security, J=concurrency+stress).


- [x] Add section-181 comprehensive tests for port_check + wait_for_port + port_scan_range + dns_lookup — status: tested (75/75, v4.153.0)
  - notes: 181-port-dns-tools.js tests all 4 tools via direct imports across 10 sub-sections (A=port_check validation, B=port_check happy-path, C=wait_for_port validation, D=wait_for_port happy-path, E=port_scan_range validation, F=port_scan_range happy-path, G=dns_lookup validation, H=dns_lookup happy-path, I=security/injection, J=concurrency stress 20×portCheck+10×dns). Fixed test cleanup bug (srvJ.server.close→srvJ.close). Tools already had MCP schemas in utilSchemas2.js; no schema file needed.

- [x] Add multipart_upload + http_serve tools — status: tested (90/90, v4.152.0)
  - notes: multipartUploadOps.js (zero-dep; pure Node http/https + crypto; builds multipart/form-data boundary manually; text fields + files pre-read as Buffer by dispatch layer + inline data/base64 parts; POST/PUT/PATCH; escapeDisposition for CRLF/quote safety; 100 KB response cap; 50 MB per-inline-file cap; 100 field limit; returns status/ok/headers/body/partCount/boundary/requestBodySize). httpServeOps.js (in-process Node http.Server sessions keyed by UUID Map; 7 operations: start/stop/status/requests/add_route/clear_requests/wait; OS-assigned random port; route matching: exact/prefix(*/any; 404 on no match; captures method/path/headers/body up to 1 MB per request / 1000 req per session; wait polls 50ms until path_match+method_match found or timeout; add_route prepends for priority; delay_ms 0–5000ms per route). Both wired in dispatchRead.js + utilSchemas16.js chained into utilSchemas.js. 90/90 tests across 10 sub-sections (A–J).

- [x] Add key_generate + oauth2_token tools — status: tested (100/100, v4.151.0)
  - notes: key_generate (RSA 1024-4096 bits, EC P-256/P-384/P-521/secp256k1, Ed25519/Ed448, symmetric AES-256/HMAC, via crypto.generateKeyPairSync + crypto.randomBytes; PEM output; fingerprint; zero deps). oauth2_token (client_credentials/password/refresh_token grants + token_introspect + jwt_decode; POST to any token endpoint; zero deps reuses httpFetch; scope/audience/extra params; bearer token parse helper).

- [x] Add tls_cert_inspect + http_multi_fetch tools — status: tested (92/92, v4.150.0)
  - notes: tlsCertInspectOps.js (zero-dep Node tls module; ops: inspect/chain; returns subject/issuer/SANs/daysUntilExpiry/isExpired/isSelfSigned/isCA/fingerprint256/protocol/cipher; rejectUnauthorized:false to inspect any cert; expiryWarning EXPIRED/EXPIRES_IN_N_DAYS/null; warn_days configurable). httpMultiFetchOps.js (zero-dep; reuses httpFetch; concurrency pool pMap; up to 100 requests/call; max concurrency 20; per-request url/method/headers/body/timeout; aggregate stats: total/succeeded/failed/errors; fail_fast mode; HTTP 4xx/5xx counted as failed not errors; network failures captured per-result). Both wired in dispatchRead.js + utilSchemas14.js chained into utilSchemas.js. 92/92 tests pass across 10 sub-sections (A-J).
