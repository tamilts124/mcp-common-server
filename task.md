## Status legend
todo / in-progress / done / tested / blocked

## History
Completed task entries older than the ones below are archived in task-history.md to keep this file cheap to read each session.

## Tasks

- [x] Add hmac_sign + hmac_verify + totp_generate + totp_verify tools — status: tested (57/57, v4.140.0)
  - notes: hmacSignOps.js (HMAC-SHA1/224/256/384/512, hex/base64/base64url, constant-time timingSafeEqual), totpOps.js (RFC 4226 HOTP + RFC 6238 TOTP, inline Base32 decoder, SHA-1/256/512, 6/8 digits, window drift tolerance, RFC 4226 Appendix D test vectors). Both wired in dispatchRead.js + utilSchemas.js. 57/57 tests pass across all 5 rigor levels.
- [x] Add find_missing_try_catch_in_async + find_unhandled_rejection_patterns tools — status: tested (v4.129.0)
- [x] Add find_memory_leak_patterns + find_circular_reference_risks tools — status: tested (v4.130.0)
- [x] Add find_promise_constructor_antipattern + find_event_emitter_leak tools — status: tested (v4.131.0)
- [x] Add find_sql_injection_risk + find_command_injection_risk tools — status: tested (26/26 + 21/21, v4.132.0)
  - notes: Fixed previous-session dispatchScan3.js + run-tests.js corruption. Both tools wired, tested, pushed.
- [x] Add find_xss_risk + find_path_traversal_risk tools — status: tested (9/9 + 10/10, v4.133.0)
  - notes: xssRiskOps.js + pathTraversalOps.js existed from prev session; wired dispatch handlers + schemas; all tests pass.
- [x] Add find_timing_attack_risk + find_missing_input_validation tools — status: tested (25/25, v4.134.0)
  - notes: timingAttackOps.js + missingInputValidationOps.js + dispatchScan4.js existed; wired dispatchScan4 into dispatchScan3 chain; fixed multiline /xi regex in missingInputValidationOps.js; added schemas to utilSchemas4.js; 25/25 tests pass.
- [x] Add find_insecure_deserialization + find_prototype_pollution_via_merge tools — status: tested (24/24, v4.135.0)
  - notes: insecureDeserializationOps.js + prototypePollutionMergeOps.js created; wired into dispatchScan4.js; schemas added to utilSchemas4.js; 24/24 tests pass.
- [x] Add find_race_condition_risk + find_unvalidated_redirect tools — status: tested (v4.136.0)
  - notes: find_race_condition_risk: detect non-atomic read-then-write on shared module-scope mutable state inside async handlers/callbacks without locking. find_unvalidated_redirect: detect res.redirect()/location.href/window.location assignments with ANY dynamic (non-literal) value without an allowlist check — broader than find_open_redirect_risks (which only flags direct req.* in redirect).
- [x] Add browser_storage_state_save + browser_set_cookies cookies_file param — status: tested (28/28, v4.137.0)
  - notes: browser_storage_state_save writes context.storageState() (cookies + per-origin localStorage) to a JSON file on disk for cross-run session persistence. browser_set_cookies gains a cookies_file param: accepts a bare JSON cookie array or a Playwright storageState file (object with a cookies key). Section 165 tests cover 5 rigor levels: offline JSON-parse logic, ToolError validation paths (empty/whitespace path, nonexistent file, invalid JSON, wrong shape), Unicode, large array perf, sequential stress, plus async no-session-guard paths for both tools. 28/28 pass.
- [x] Fix package.json JSON syntax bug (missing comma + duplicate key in scripts) + add jwt_sign + jwt_verify + crypto_encrypt + crypto_decrypt tools — status: tested (45/45 + 37/37, v4.139.0)
  - notes: package.json was already valid JSON (previous session partial fix); only version bump needed. jwt_sign/jwt_verify: Node built-in crypto (HS256/384/512 + RS256/384/512 + ES256/384/512), constant-time HMAC verify, full claim/audience/issuer checks. crypto_encrypt/crypto_decrypt: AES-256-GCM, PBKDF2-HMAC-SHA256 (600k iters) or raw 32-byte hex key, fresh random IV per call, self-describing token format. All 5 rigor levels tested.
