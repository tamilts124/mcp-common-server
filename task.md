## Status legend
todo / in-progress / done / tested / blocked

## History
Completed task entries older than the ones below are archived in task-history.md to keep this file cheap to read each session.

## Tasks

- [x] Add date_calc + text_extract tools — status: tested (75/75, v4.147.0)
  - notes: dateCalcOps.js (zero-dep, pure Node Intl + Date; 10 ops: now/parse/format/add/subtract/diff/start_of/end_of/convert_tz/is_valid; Moment-style token formatter YYYY/MM/DD/HH/mm/ss/SSS/A/dddd/MMMM/Z/X/x; IANA tz via Intl.DateTimeFormat; month-boundary clamping on add/subtract; week start=Monday). textExtractOps.js (zero-dep regex; 11 ops: emails/urls/phones/ips/numbers/dates/json/lines/between/pattern/words; balanced-bracket JSON scanner; grep-like lines with context/invert; word-frequency with stop_words; custom regex with capture groups + named groups). Both wired in dispatchRead.js + utilSchemas11.js chained into utilSchemas.js. Fixed E2 test off-by-one (120 adds → Apr 30 not May 1). 75/75 tests pass across 10 sub-sections (A-J).

- [x] Add color_convert + number_format tools — status: tested (67/67, v4.146.0)
  - notes: colorConvertOps.js (hex/rgb/hsl/hsv/cmyk/named, WCAG contrast, blend, palette — all 6 palette types, all input formats). numberFormatOps.js (decimal/currency/percent/bytes IEC+SI/SI-prefix/ordinal/roman/words/compact). Both wired in dispatchRead.js + utilSchemas10.js chained into utilSchemas.js. Fixed previous-session file corruption (dispatchRead.js header + premature handlers, utilSchemas.js duplicate module.exports). 67/67 tests pass across 10 sub-sections (A-J).

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
- [x] Add uuid_generate + cron_next tools — status: tested (63/63, v4.141.0)
  - notes: uuid_generate: v1 (time-based), v4 (crypto.randomUUID), v5 (name+SHA-1 per RFC 4122), ULID (Crockford Base32, 48-bit ms timestamp + 80-bit random). cron_next: zero-dep 5-field and 6-field cron parser with smart-skip scheduler, @hourly/@daily/@weekly/@monthly/@yearly aliases, next-N timestamps from configurable base time, unix/iso output.
- [x] Add diff_strings + password_generate tools — status: tested (67/67, v4.142.0)
  - notes: diffStringsOps.js (in-memory Myers LCS diff, unified/json output, 4 MB limit, custom labels, configurable context). passwordGenerateOps.js (crypto-secure password with charset pools + rejection sampling, or passphrase from 512-word embedded list with entropy estimate). Both wired in dispatchRead.js + utilSchemas6.js. 67/67 tests pass across all 5 rigor levels.
- [x] Add template_render + base62_encode/decode tools — status: tested (72/72, v4.143.0)
  - notes: templateRenderOps.js (zero-dep Mustache-compatible: HTML-escaped + raw interpolation, {{.}} primitive-loop fix via ctx["."] sentinel, sections/inverted sections, array loops, dot-notation paths, partials with depth-32 guard, 1 MB limit). base62Ops.js (0-9A-Za-z alphabet, number/hex/bytes input, min_length padding, BigInt arithmetic, round-trip encode/decode). Both wired in dispatchRead.js + utilSchemas7.js (already chained into utilSchemas.js). Fixed {{.}} bug: lookup() now checks for explicit ctx["."] before returning full ctx. 72/72 tests across 10 sub-sections (A–J).
- [x] Add markdown_to_html + xml_parse tools — status: tested (75/75, v4.144.0)
- [x] Add string_transform + ip_cidr tools — status: tested (53/53, v4.145.0)
  - notes: stringTransformOps.js (zero-dep string toolkit: 10 case conversions with smart camelCase/acronym tokenizer, reverse/capitalize/decapitalize/trim/slugify/strip_diacritics/swap_case, repeat with separator, truncate with clamp fix, pad_start/end/center, word_wrap, count with Unicode-aware char count). ipCidrOps.js (zero-dep IPv4+IPv6 subnet toolkit: info/contains/enumerate/convert/classify/subnets; bare-int/0x-hex pre-check fix in convert; 65536-cap enumerate; IPv6 via BigInt). Both wired in dispatchRead.js + utilSchemas9.js chained into utilSchemas.js. 53/53 tests pass across all 5 rigor levels (A-E).