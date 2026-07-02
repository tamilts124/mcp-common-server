"use strict";
// ── Navigation history, element/page state queries, capture, and page-scripting tools ──

const PAGE_STATE_SCHEMAS = [
  {
    name: "browser_screenshot",
    description: "Take a screenshot of the current page and save it to a jailed file path.",
    inputSchema: { type: "object", required: ["session_id", "path"], properties: {
      session_id: { type: "string",  description: "Session id returned by browser_launch." },
      path:       { type: "string",  description: "Destination path (relative to a configured root) for the screenshot, e.g. 'screenshots/out.png'." },
      full_page:  { type: "boolean", description: "Capture the full scrollable page instead of just the viewport (default: false)." },
    }},
  },
  {
    name: "browser_get_console_logs",
    description: "Return buffered browser console messages (and page errors) for a session.",
    inputSchema: { type: "object", required: ["session_id"], properties: {
      session_id: { type: "string",  description: "Session id returned by browser_launch." },
      clear:      { type: "boolean", description: "Clear the buffer after reading (default: false)." },
    }},
  },
  {
    name: "browser_wait_for_selector",
    description: "Wait until an element matching a CSS selector reaches a given state (default: visible).",
    inputSchema: { type: "object", required: ["session_id", "selector"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
      selector:   { type: "string", description: "CSS selector to wait for." },
      state:      { type: "string", description: "'attached', 'detached', 'visible', or 'hidden' (default: 'visible')." },
      timeout:    { type: "number", description: "Milliseconds before timing out (default: 30000)." },
    }},
  },
  {
    name: "browser_get_current_url",
    description: "Return the session's current page URL (thin page.url() wrapper — cheaper/clearer for an AI caller than a raw browser_evaluate script).",
    inputSchema: { type: "object", required: ["session_id"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
    }},
  },
  {
    name: "browser_get_title",
    description: "Return the session's current page title (thin page.title() wrapper — cheaper/clearer for an AI caller than a raw browser_evaluate script).",
    inputSchema: { type: "object", required: ["session_id"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
    }},
  },
  {
    name: "browser_go_back",
    description: "Navigate back in the session's browser history.",
    inputSchema: { type: "object", required: ["session_id"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
      wait_until: { type: "string", description: "One of 'load', 'domcontentloaded', 'networkidle', 'commit' (default: 'load')." },
      timeout:    { type: "number", description: "Milliseconds before timing out (default: 30000)." },
    }},
  },
  {
    name: "browser_go_forward",
    description: "Navigate forward in the session's browser history.",
    inputSchema: { type: "object", required: ["session_id"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
      wait_until: { type: "string", description: "One of 'load', 'domcontentloaded', 'networkidle', 'commit' (default: 'load')." },
      timeout:    { type: "number", description: "Milliseconds before timing out (default: 30000)." },
    }},
  },
  {
    name: "browser_reload",
    description: "Reload the current page.",
    inputSchema: { type: "object", required: ["session_id"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
      wait_until: { type: "string", description: "One of 'load', 'domcontentloaded', 'networkidle', 'commit' (default: 'load')." },
      timeout:    { type: "number", description: "Milliseconds before timing out (default: 30000)." },
    }},
  },
  {
    name: "browser_pdf",
    description: "Render the current page to a PDF file at a jailed path (headless Chromium only).",
    inputSchema: { type: "object", required: ["session_id", "path"], properties: {
      session_id:       { type: "string",  description: "Session id returned by browser_launch." },
      path:             { type: "string",  description: "Destination path (relative to a configured root) for the PDF, e.g. 'out/page.pdf'." },
      format:           { type: "string",  description: "Paper format, e.g. 'A4', 'Letter' (default: 'A4')." },
      print_background: { type: "boolean", description: "Include background graphics (default: true)." },
    }},
  },
  {
    name: "browser_wait_for_navigation",
    description: "Wait for an in-flight navigation to reach a load state (useful after a click/press that triggers a page load without calling browser_navigate).",
    inputSchema: { type: "object", required: ["session_id"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
      wait_until: { type: "string", description: "One of 'load', 'domcontentloaded', 'networkidle' (default: 'load')." },
      timeout:    { type: "number", description: "Milliseconds before timing out (default: 30000)." },
    }},
  },
  {
    name: "browser_download",
    description: "Click a selector that triggers a file download and save the downloaded file to a jailed path.",
    inputSchema: { type: "object", required: ["session_id", "selector", "path"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
      selector:   { type: "string", description: "CSS selector of the element that triggers the download when clicked." },
      path:       { type: "string", description: "Destination path (relative to a configured root) to save the downloaded file, e.g. 'downloads/file.csv'." },
      timeout:    { type: "number", description: "Milliseconds before timing out (default: 30000)." },
    }},
  },
  {
    name: "browser_get_attribute",
    description: "Get the value of a named HTML attribute from an element matching a CSS selector.",
    inputSchema: { type: "object", required: ["session_id", "selector", "attribute"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
      selector:   { type: "string", description: "CSS selector of the element." },
      attribute:  { type: "string", description: "Attribute name to read, e.g. 'href', 'class', 'disabled'." },
    }},
  },
  {
    name: "browser_is_visible",
    description: "Check whether an element matching a CSS selector is currently visible (does not wait/throw if absent).",
    inputSchema: { type: "object", required: ["session_id", "selector"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
      selector:   { type: "string", description: "CSS selector of the element." },
    }},
  },
  {
    name: "browser_is_checked",
    description: "Check whether a checkbox/radio element matching a CSS selector is currently checked.",
    inputSchema: { type: "object", required: ["session_id", "selector"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
      selector:   { type: "string", description: "CSS selector of the checkbox/radio element." },
    }},
  },
  {
    name: "browser_get_element_info",
    description: "Get bounding box, tag name, text content, and all attributes of an element matching a CSS selector in one call.",
    inputSchema: { type: "object", required: ["session_id", "selector"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
      selector:   { type: "string", description: "CSS selector of the element." },
    }},
  },
  {
    name: "browser_add_init_script",
    description: "Register a JS source string to run in every page of this session's context before any page script, on every subsequent navigation (context.addInitScript).",
    inputSchema: { type: "object", required: ["session_id", "script"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
      script:     { type: "string", description: "Raw JavaScript source to run before page scripts on each navigation." },
    }},
  },
  {
    name: "browser_get_page_metrics",
    description: "Read basic Navigation Timing / resource metrics for the active page (DOMContentLoaded/load timing, TTFB, transfer size, resource count, JS heap usage where available).",
    inputSchema: { type: "object", required: ["session_id"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
    }},
  },
  {
    name: "browser_expose_function",
    description: "Expose a Node-side callback reachable from page JS as window.<name>(...args). Calls are recorded and readable via browser_get_exposed_calls (no live channel back to the tool caller).",
    inputSchema: { type: "object", required: ["session_id", "name"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
      name:       { type: "string", description: "Valid JS identifier to bind on window, e.g. 'onAppEvent'." },
    }},
  },
  {
    name: "browser_get_exposed_calls",
    description: "Read recorded calls made from page JS to a browser_expose_function binding.",
    inputSchema: { type: "object", required: ["session_id"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
      name:       { type: "string", description: "Optional: filter to calls of this exposed function name only." },
      limit:      { type: "number", description: "Max calls to return, most recent first (default/max 200)." },
      clear:      { type: "boolean", description: "Clear the recorded call log after reading." },
    }},
  },
  {
    name: "browser_wait_for_response",
    description: "Block until a network response whose URL contains url_pattern (and optionally matches status) arrives, or timeout elapses.",
    inputSchema: { type: "object", required: ["session_id", "url_pattern"], properties: {
      session_id:  { type: "string", description: "Session id returned by browser_launch." },
      url_pattern: { type: "string", description: "Substring to match against the response URL." },
      status:      { type: "number", description: "Optional exact HTTP status to require." },
      timeout:     { type: "number", description: "Max wait in ms (default 30000)." },
    }},
  },
];

module.exports = { PAGE_STATE_SCHEMAS };
