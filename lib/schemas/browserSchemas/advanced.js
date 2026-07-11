"use strict";
// ── Cookies/storage/emulation, network capture+mocking, accessibility, dialogs, and iframe tools ──

const ADVANCED_SCHEMAS = [
  {
    name: "browser_get_cookies",
    description: "Get cookies for the session's browser context, optionally filtered by URL.",
    inputSchema: { type: "object", required: ["session_id"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
      urls:       { type: "array",  description: "Optional list of URLs to filter cookies by; omit for all context cookies.", items: { type: "string" } },
    }},
  },
  {
    name: "browser_set_cookies",
    description: "Add cookies to the session's browser context. Cookies can be supplied inline as an array or loaded from a JSON file path (cookies_file). If both are given, cookies_file takes precedence.",
    inputSchema: { type: "object", required: ["session_id"], properties: {
      session_id:   { type: "string", description: "Session id returned by browser_launch." },
      cookies:      { type: "array",  description: "Array of cookie objects, each needing name, value, and either url or domain (+path).", items: { type: "object" } },
      cookies_file: { type: "string", description: "Path to a JSON file containing cookies — either a bare array of cookie objects, or an object with a 'cookies' array (e.g. a Playwright storageState file saved by browser_storage_state_save). Mutually exclusive with 'cookies'; if both are given, cookies_file takes precedence." },
    }},
  },
  {
    name: "browser_storage_state_save",
    description: "Save the current browser context's storage state (cookies + per-origin localStorage) to a JSON file on disk. Use this after a login flow to persist credentials for reuse via browser_launch's storage_state parameter or browser_set_cookies' cookies_file parameter.",
    inputSchema: { type: "object", required: ["session_id", "path"], properties: {
      session_id: { type: "string",  description: "Session id returned by browser_launch." },
      path:       { type: "string",  description: "Absolute or relative file path to write the storage state JSON to. Parent directories are created automatically. Existing file is overwritten." },
      pretty:     { type: "boolean", description: "Pretty-print the JSON output (default true)." },
    }},
  },
  {
    name: "browser_network_start",
    description: "Start capturing request/response/failure events for a session's active page into an in-memory log (cap 500 entries).",
    inputSchema: { type: "object", required: ["session_id"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
    }},
  },
  {
    name: "browser_network_stop",
    description: "Stop network capture for a session (log entries are kept until cleared via browser_get_network_requests).",
    inputSchema: { type: "object", required: ["session_id"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
    }},
  },
  {
    name: "browser_get_network_requests",
    description: "Return captured network log entries, optionally filtered by url_contains/resource_type/type and limited/cleared.",
    inputSchema: { type: "object", required: ["session_id"], properties: {
      session_id:    { type: "string",  description: "Session id returned by browser_launch." },
      url_contains:  { type: "string",  description: "Only return entries whose URL contains this substring." },
      resource_type: { type: "string",  description: "Filter by Playwright resourceType (e.g. document, xhr, fetch, image)." },
      type:          { type: "string",  description: "Filter by entry type: request, response, or request_failed." },
      limit:         { type: "number",  description: "Max entries to return, most recent first (default 100, cap 500)." },
      clear:         { type: "boolean", description: "Clear the log after reading (default false)." },
    }},
  },
  {
    name: "browser_route",
    description: "Intercept requests matching a Playwright glob url_pattern on the session's active page: abort, fulfill with a custom response, or continue unmodified.",
    inputSchema: { type: "object", required: ["session_id", "url_pattern", "action"], properties: {
      session_id:   { type: "string", description: "Session id returned by browser_launch." },
      url_pattern:  { type: "string", description: "Playwright glob URL pattern to match, e.g. '**/api/**'." },
      action:       { type: "string", enum: ["abort", "fulfill", "continue"], description: "What to do with matched requests." },
      error_code:   { type: "string", description: "Abort reason (action=abort only), e.g. 'failed', 'aborted', 'timedout'." },
      status:       { type: "number", description: "Response status code (action=fulfill only, default 200)." },
      body:         { type: "string", description: "Response body text (action=fulfill only)." },
      content_type: { type: "string", description: "Response Content-Type (action=fulfill only, default text/plain)." },
      headers:      { type: "object", description: "Extra response headers (action=fulfill only)." },
    }},
  },
  {
    name: "browser_unroute",
    description: "Remove a previously registered browser_route interception by url_pattern, or all of them if url_pattern is omitted.",
    inputSchema: { type: "object", required: ["session_id"], properties: {
      session_id:  { type: "string", description: "Session id returned by browser_launch." },
      url_pattern: { type: "string", description: "Exact url_pattern passed to browser_route. Omit to remove all routes." },
    }},
  },
  {
    name: "browser_emulate",
    description: "Runtime-change a session's viewport, geolocation, color-scheme, or offline mode. For device_scale_factor/timezone/locale, pass those to browser_launch instead (Playwright can't change them after context creation).",
    inputSchema: { type: "object", required: ["session_id"], properties: {
      session_id:   { type: "string",  description: "Session id returned by browser_launch." },
      viewport:     { type: "object",  description: "Optional {width, height} to resize the active page's viewport.",
        properties: { width: { type: "number" }, height: { type: "number" } } },
      geolocation:  { type: "object",  description: "Optional {latitude, longitude, accuracy?} to set (grants geolocation permission automatically).",
        properties: { latitude: { type: "number" }, longitude: { type: "number" }, accuracy: { type: "number" } } },
      color_scheme: { type: "string",  enum: ["light", "dark", "no-preference", "null"], description: "Preferred color scheme to emulate (page.emulateMedia)." },
      offline:      { type: "boolean", description: "Set the context's network offline state." },
    }},
  },
  {
    name: "browser_set_viewport",
    description: "Thin dedicated wrapper for resizing the active page's viewport. Equivalent to browser_emulate's viewport option, for callers who only need this and want a narrower schema.",
    inputSchema: { type: "object", required: ["session_id", "width", "height"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
      width:      { type: "number", description: "Viewport width in pixels." },
      height:     { type: "number", description: "Viewport height in pixels." },
    }},
  },
  {
    name: "browser_set_extra_headers",
    description: "Set custom HTTP headers sent with every subsequent request made by this session's context (e.g. Authorization, X-Test).",
    inputSchema: { type: "object", required: ["session_id", "headers"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
      headers:    { type: "object", description: "Map of header name -> string value.", additionalProperties: { type: "string" } },
    }},
  },
  {
    name: "browser_get_local_storage",
    description: "Read all key/value pairs from the active page's window.localStorage.",
    inputSchema: { type: "object", required: ["session_id"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
    }},
  },
  {
    name: "browser_set_local_storage",
    description: "Write key/value pairs into the active page's window.localStorage.",
    inputSchema: { type: "object", required: ["session_id", "items"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
      items:      { type: "object", description: "Map of key -> string value to set via localStorage.setItem.", additionalProperties: { type: "string" } },
    }},
  },
  {
    name: "browser_get_storage_state",
    description: "Snapshot the session context's storage state (cookies + per-origin localStorage) as a portable object. Pass the result as browser_launch's storage_state to resume the same logged-in session in a fresh browser. To persist to disk, use browser_storage_state_save instead.",
    inputSchema: { type: "object", required: ["session_id"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
    }},
  },
  {
    name: "browser_accessibility_snapshot",
    description: "Return the page's (or a selector's) accessibility tree as a YAML-style string (role, accessible name, and state per node) via Playwright's ariaSnapshot — a structure-aware alternative to reading raw HTML.",
    inputSchema: { type: "object", required: ["session_id"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
      selector:   { type: "string", description: "Optional CSS selector to root the snapshot at a subtree instead of the whole page (default: body)." },
    }},
  },
  {
    name: "browser_find_by_role",
    description: "Locate elements by ARIA role and optional accessible name (page.getByRole), returning bounding box/text/visibility for each match — often more robust than CSS selectors on dynamically-classed SPA markup.",
    inputSchema: { type: "object", required: ["session_id", "role"], properties: {
      session_id: { type: "string",  description: "Session id returned by browser_launch." },
      role:       { type: "string",  description: "ARIA role to match, e.g. 'button', 'link', 'textbox'." },
      name:       { type: "string",  description: "Optional accessible name to filter by (substring match unless exact=true)." },
      exact:      { type: "boolean", description: "Require an exact name match (default false)." },
    }},
  },
  {
    name: "browser_handle_next_dialog",
    description: "Arm a one-shot accept/dismiss action for the next alert/confirm/prompt dialog on this session. Without arming, dialogs are auto-dismissed (Playwright's no-listener default) and logged. Call this before the action that triggers the dialog. Pass queue:true to append to a FIFO queue of pre-armed actions instead of replacing the pending one — use this when a sequence of N dialogs is expected.",
    inputSchema: { type: "object", required: ["session_id", "action"], properties: {
      session_id:  { type: "string",  description: "Session id returned by browser_launch." },
      action:      { type: "string",  enum: ["accept", "dismiss"], description: "How to resolve the next dialog." },
      prompt_text: { type: "string",  description: "Text to enter if the dialog is a prompt() and action is 'accept'. Ignored otherwise." },
      queue:       { type: "boolean", description: "If true, append this action to the pending queue instead of replacing it (default false, matching original single-arm behavior)." },
    }},
  },
  {
    name: "browser_wait_for_dialog",
    description: "Block until the next alert/confirm/prompt/beforeunload dialog fires on this session (or timeout elapses). Does not itself decide accept/dismiss — pair with browser_handle_next_dialog if you need to control the outcome; otherwise the dialog is auto-dismissed per the default behavior.",
    inputSchema: { type: "object", required: ["session_id"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
      timeout_ms: { type: "number", description: "Max wait in milliseconds (default 5000, max 30000)." },
    }},
  },
  {
    name: "browser_get_dialog_log",
    description: "Read recorded alert/confirm/prompt/beforeunload dialogs for this session (message, type, default value, and how each was handled).",
    inputSchema: { type: "object", required: ["session_id"], properties: {
      session_id: { type: "string",  description: "Session id returned by browser_launch." },
      limit:      { type: "number",  description: "Max entries to return, most recent first (default/max 200)." },
      clear:      { type: "boolean", description: "Clear the recorded dialog log after reading." },
    }},
  },
  {
    name: "browser_list_frames",
    description: "Enumerate all frames (main + nested iframes) on the current page: url, name, and whether each is the main frame. Use to discover a frame_selector for browser_frame_* tools.",
    inputSchema: { type: "object", required: ["session_id"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
    }},
  },
  {
    name: "browser_frame_click",
    description: "Click an element inside an <iframe>. page.locator() cannot pierce iframe boundaries, so use this instead of browser_click when the target is inside a frame (payment widgets, embeds, OAuth screens).",
    inputSchema: { type: "object", required: ["session_id", "frame_selector", "selector"], properties: {
      session_id:     { type: "string", description: "Session id returned by browser_launch." },
      frame_selector: { type: "string", description: "CSS selector of the <iframe> element in the parent document." },
      selector:       { type: "string", description: "CSS selector of the target element inside the frame." },
      timeout:        { type: "number", description: "Max wait in ms (default 30000)." },
    }},
  },
  {
    name: "browser_frame_type",
    description: "Fill a form field inside an <iframe>. Use instead of browser_type when the target is inside a frame.",
    inputSchema: { type: "object", required: ["session_id", "frame_selector", "selector", "text"], properties: {
      session_id:     { type: "string", description: "Session id returned by browser_launch." },
      frame_selector: { type: "string", description: "CSS selector of the <iframe> element in the parent document." },
      selector:       { type: "string", description: "CSS selector of the target input inside the frame." },
      text:           { type: "string", description: "Text to fill into the field." },
      timeout:        { type: "number", description: "Max wait in ms (default 30000)." },
    }},
  },
  {
    name: "browser_frame_get_content",
    description: "Read text or HTML content from inside an <iframe>, optionally scoped to a selector within the frame (default: the frame's body). Use instead of browser_get_content when the target is inside a frame.",
    inputSchema: { type: "object", required: ["session_id", "frame_selector"], properties: {
      session_id:     { type: "string", description: "Session id returned by browser_launch." },
      frame_selector: { type: "string", description: "CSS selector of the <iframe> element in the parent document." },
      selector:       { type: "string", description: "Optional CSS selector within the frame to scope the read (default: body)." },
      mode:           { type: "string", enum: ["text", "html"], description: "Return innerText or innerHTML (default text)." },
      timeout:        { type: "number", description: "Max wait in ms (default 30000)." },
    }},
  },
  {
    name: "browser_frame_evaluate",
    description: "Run a JavaScript expression/function inside an <iframe>'s own document, mirroring browser_evaluate but scoped to a frame. Use instead of browser_evaluate when the code needs to run in the frame's context (its own window/document, not the parent page's).",
    inputSchema: { type: "object", required: ["session_id", "frame_selector", "script"], properties: {
      session_id:     { type: "string", description: "Session id returned by browser_launch." },
      frame_selector: { type: "string", description: "CSS selector of the <iframe> element in the parent document." },
      script:         { type: "string", description: "JavaScript expression or function body to evaluate inside the frame." },
      timeout:        { type: "number", description: "Max wait in ms to locate the frame element (default 30000)." },
    }},
  },
];

module.exports = { ADVANCED_SCHEMAS };
