"use strict";
// ── BROWSER TOOL SCHEMAS — only present when MCP_ALLOW_EXEC=true and MCP_READ_ONLY=false ──
// Browser tools spawn a real Chromium process, so they are gated the same
// way as run_command/start_process (see toolsSchema.js EXEC_TOOLS set).

const BROWSER_SCHEMAS = [
  {
    name: "browser_launch",
    description: "Launch a stealth Chromium browser session (playwright-extra + puppeteer-extra-plugin-stealth) and return a session id used by all other browser_* tools.",
    inputSchema: { type: "object", properties: {
      headless:   { type: "boolean", description: "Run without a visible window (default: true)." },
      user_agent: { type: "string",  description: "Optional custom User-Agent string." },
      viewport:   { type: "object",  description: "Optional {width, height} viewport (default 1280x800).",
        properties: { width: { type: "number" }, height: { type: "number" } } },
    }},
  },
  {
    name: "browser_navigate",
    description: "Navigate a browser session's page to a URL and wait for it to load.",
    inputSchema: { type: "object", required: ["session_id", "url"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
      url:        { type: "string", description: "URL to navigate to." },
      wait_until: { type: "string", description: "One of 'load', 'domcontentloaded', 'networkidle', 'commit' (default: 'load')." },
      timeout:    { type: "number", description: "Milliseconds before navigation times out (default: 30000)." },
    }},
  },
  {
    name: "browser_get_content",
    description: "Get the page's (or a selector's) rendered content, as plain text or HTML.",
    inputSchema: { type: "object", required: ["session_id"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
      selector:   { type: "string", description: "Optional CSS selector to scope content to; defaults to the whole page." },
      mode:       { type: "string", description: "'text' (innerText, default) or 'html' (innerHTML/full document)." },
    }},
  },
  {
    name: "browser_evaluate",
    description: "Run a JavaScript expression/function in the page context via page.evaluate and return the JSON-serializable result.",
    inputSchema: { type: "object", required: ["session_id", "script"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
      script:     { type: "string", description: "JavaScript expression or function body to evaluate in the page." },
    }},
  },
  {
    name: "browser_click",
    description: "Click an element matching a CSS selector.",
    inputSchema: { type: "object", required: ["session_id", "selector"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
      selector:   { type: "string", description: "CSS selector of the element to click." },
      timeout:    { type: "number", description: "Milliseconds before the click times out (default: 30000)." },
    }},
  },
  {
    name: "browser_type",
    description: "Fill a form field matching a CSS selector with text (clears existing value first).",
    inputSchema: { type: "object", required: ["session_id", "selector", "text"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
      selector:   { type: "string", description: "CSS selector of the input/textarea element." },
      text:       { type: "string", description: "Text to fill into the field." },
      timeout:    { type: "number", description: "Milliseconds before the action times out (default: 30000)." },
    }},
  },
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
    name: "browser_list_sessions",
    description: "List all active browser sessions with their current URL and metadata.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_close",
    description: "Close a browser session's page/context/browser and drop it from the session table.",
    inputSchema: { type: "object", required: ["session_id"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
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
    name: "browser_get_cookies",
    description: "Get cookies for the session's browser context, optionally filtered by URL.",
    inputSchema: { type: "object", required: ["session_id"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
      urls:       { type: "array",  description: "Optional list of URLs to filter cookies by; omit for all context cookies.", items: { type: "string" } },
    }},
  },
  {
    name: "browser_set_cookies",
    description: "Add cookies to the session's browser context.",
    inputSchema: { type: "object", required: ["session_id", "cookies"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
      cookies:    { type: "array",  description: "Array of cookie objects, each needing name, value, and either url or domain (+path).", items: { type: "object" } },
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
    name: "browser_select_option",
    description: "Select an option in a <select> element by value or visible label.",
    inputSchema: { type: "object", required: ["session_id", "selector"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
      selector:   { type: "string", description: "CSS selector of the <select> element." },
      value:      { type: "string", description: "Option value to select (use this or 'label')." },
      label:      { type: "string", description: "Option visible text to select (use this or 'value')." },
      timeout:    { type: "number", description: "Milliseconds before timing out (default: 30000)." },
    }},
  },
  {
    name: "browser_press_key",
    description: "Press a keyboard key, either globally or focused on a selector (e.g. 'Enter', 'Tab', 'ArrowDown').",
    inputSchema: { type: "object", required: ["session_id", "key"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
      key:        { type: "string", description: "Key name to press, e.g. 'Enter', 'Escape', 'Tab'." },
      selector:   { type: "string", description: "Optional CSS selector to focus before pressing the key." },
      timeout:    { type: "number", description: "Milliseconds before timing out (default: 30000)." },
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
    name: "browser_hover",
    description: "Move the mouse over an element (triggers CSS :hover / hover-based JS handlers) without clicking.",
    inputSchema: { type: "object", required: ["session_id", "selector"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
      selector:   { type: "string", description: "CSS selector of the element to hover." },
      timeout:    { type: "number", description: "Milliseconds before timing out (default: 30000)." },
    }},
  },
  {
    name: "browser_upload_file",
    description: "Set file(s) on a <input type=file> element via its selector, for testing upload flows.",
    inputSchema: { type: "object", required: ["session_id", "selector"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
      selector:   { type: "string", description: "CSS selector of the file input element." },
      files:      { type: "array",  description: "Array of file paths (relative to a configured root) to upload. Use this or 'path'.", items: { type: "string" } },
      path:       { type: "string", description: "Single file path (relative to a configured root) to upload. Use this or 'files'." },
      timeout:    { type: "number", description: "Milliseconds before timing out (default: 30000)." },
    }},
  },
  {
    name: "browser_scroll",
    description: "Scroll a page. With 'selector', scrolls that element into view; otherwise scrolls the window by (x, y) pixels.",
    inputSchema: { type: "object", required: ["session_id"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
      selector:   { type: "string", description: "Optional CSS selector to scroll into view." },
      x:          { type: "number", description: "Horizontal scroll offset in pixels (ignored if selector given)." },
      y:          { type: "number", description: "Vertical scroll offset in pixels (ignored if selector given)." },
      timeout:    { type: "number", description: "Milliseconds before timing out (default: 30000)." },
    }},
  },
  {
    name: "browser_double_click",
    description: "Double-click an element matching a CSS selector.",
    inputSchema: { type: "object", required: ["session_id", "selector"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
      selector:   { type: "string", description: "CSS selector of the element to double-click." },
      timeout:    { type: "number", description: "Milliseconds before timing out (default: 30000)." },
    }},
  },
  {
    name: "browser_right_click",
    description: "Right-click (context-click) an element matching a CSS selector.",
    inputSchema: { type: "object", required: ["session_id", "selector"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
      selector:   { type: "string", description: "CSS selector of the element to right-click." },
      timeout:    { type: "number", description: "Milliseconds before timing out (default: 30000)." },
    }},
  },
  {
    name: "browser_drag_and_drop",
    description: "Drag an element matching 'source' and drop it onto the element matching 'target'.",
    inputSchema: { type: "object", required: ["session_id", "source", "target"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
      source:     { type: "string", description: "CSS selector of the element to drag." },
      target:     { type: "string", description: "CSS selector of the drop target." },
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
    name: "browser_check",
    description: "Check a checkbox/radio element matching a CSS selector (no-op if already checked).",
    inputSchema: { type: "object", required: ["session_id", "selector"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
      selector:   { type: "string", description: "CSS selector of the checkbox/radio element." },
      timeout:    { type: "number", description: "Milliseconds before timing out (default: 30000)." },
    }},
  },
  {
    name: "browser_uncheck",
    description: "Uncheck a checkbox element matching a CSS selector (no-op if already unchecked).",
    inputSchema: { type: "object", required: ["session_id", "selector"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
      selector:   { type: "string", description: "CSS selector of the checkbox element." },
      timeout:    { type: "number", description: "Milliseconds before timing out (default: 30000)." },
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
    name: "browser_new_page",
    description: "Open a new tab/page in an existing browser session's context and make it the active page. Optionally navigate it.",
    inputSchema: { type: "object", required: ["session_id"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
      url:        { type: "string", description: "Optional URL to navigate the new page to." },
      wait_until: { type: "string", description: "Navigation wait condition (default: load)." },
      timeout:    { type: "number", description: "Milliseconds before timing out (default: 30000)." },
    }},
  },
  {
    name: "browser_switch_page",
    description: "Switch the active page/tab for a session. Subsequent tool calls on this session_id act on the newly active page.",
    inputSchema: { type: "object", required: ["session_id", "page_id"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
      page_id:    { type: "string", description: "Page id returned by browser_launch or browser_new_page." },
    }},
  },
  {
    name: "browser_list_pages",
    description: "List all open pages/tabs in a session with their URL and which one is currently active.",
    inputSchema: { type: "object", required: ["session_id"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
    }},
  },
  {
    name: "browser_close_page",
    description: "Close a specific page/tab in a session (not the whole session). Cannot close the last remaining page — use browser_close instead.",
    inputSchema: { type: "object", required: ["session_id", "page_id"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
      page_id:    { type: "string", description: "Page id to close." },
    }},
  },
];

module.exports = { BROWSER_SCHEMAS };
