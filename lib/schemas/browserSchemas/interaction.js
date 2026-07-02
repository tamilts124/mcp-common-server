"use strict";
// ── Content reading, evaluate, and all user-input interaction tools ──

const INTERACTION_SCHEMAS = [
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
    description: "Drag an element matching 'source' and drop it onto the element matching 'target'. Optionally scope either endpoint inside an <iframe> via source_frame_selector/target_frame_selector (uses manual mouse choreography instead of page.dragAndDrop when either is set, since that API can't cross frame boundaries).",
    inputSchema: { type: "object", required: ["session_id", "source", "target"], properties: {
      session_id: { type: "string", description: "Session id returned by browser_launch." },
      source:     { type: "string", description: "CSS selector of the element to drag." },
      target:     { type: "string", description: "CSS selector of the drop target." },
      source_frame_selector: { type: "string", description: "CSS selector of the <iframe> containing 'source', if it's inside a frame." },
      target_frame_selector: { type: "string", description: "CSS selector of the <iframe> containing 'target', if it's inside a frame." },
      timeout:    { type: "number", description: "Milliseconds before timing out (default: 30000)." },
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
];

module.exports = { INTERACTION_SCHEMAS };
