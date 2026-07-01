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
];

module.exports = { BROWSER_SCHEMAS };
