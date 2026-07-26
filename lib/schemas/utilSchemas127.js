"use strict";
/**
 * utilSchemas127.js
 * JSON Schema for the screen_capture tool.
 */

const SCREEN_CAPTURE_SCHEMA = {
  name: "screen_capture",
  description: [
    "Zero-dependency desktop screen capture and basic input control (pure Node.js child_process).",
    "Uses platform-native tools — PowerShell/Win32 on Windows, screencapture on macOS,",
    "scrot/import/gnome-screenshot on Linux — so no npm packages are required.",
    "",
    "Operations (4 total):",
    "  capture     — screenshot the full desktop or a pixel region; returns base64 PNG.",
    "  mouse_click — move the cursor to (x,y) and click (left or right button).",
    "  mouse_move  — move the cursor to (x,y) without clicking.",
    "  send_keys   — send keyboard input (Windows SendKeys syntax; Win32 only).",
    "",
    "Security: screenshots are returned as base64 and/or saved to a caller-specified path.",
    "Mouse/keyboard control operations currently require Windows (PowerShell + Win32 API).",
  ].join("\n"),
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        description: [
          "Operation to perform (default: capture).",
          "capture=take a screenshot and return base64 PNG;",
          "mouse_click=move cursor to (x,y) and click;",
          "mouse_move=move cursor to (x,y) without clicking;",
          "send_keys=send keyboard input to the focused window (Windows only).",
        ].join(" "),
        enum: ["capture", "mouse_click", "mouse_move", "send_keys"],
      },
      // ── capture region ────────────────────────────────────────────────────
      x: {
        type: "number",
        description: "For capture: left edge of the region in screen pixels. For mouse_click/mouse_move: cursor X coordinate.",
      },
      y: {
        type: "number",
        description: "For capture: top edge of the region in screen pixels. For mouse_click/mouse_move: cursor Y coordinate.",
      },
      width: {
        type: "number",
        description: "For capture: width of the capture region in pixels. Omit to capture the full screen width.",
        minimum: 1,
      },
      height: {
        type: "number",
        description: "For capture: height of the capture region in pixels. Omit to capture the full screen height.",
        minimum: 1,
      },
      save_path: {
        type: "string",
        description: "For capture: optional file path where the PNG should also be written to disk (e.g. 'claudedir/screenshots/snap.png'). Directories are created automatically.",
      },
      // ── mouse_click ───────────────────────────────────────────────────────
      button: {
        type: "string",
        description: "For mouse_click: which mouse button to click. 'left' (default) or 'right'.",
        enum: ["left", "right"],
      },
      // ── send_keys ─────────────────────────────────────────────────────────
      keys: {
        type: "string",
        description: [
          "For send_keys: key sequence to send (Windows SendKeys syntax).",
          "Examples: 'Hello World' sends text; '{ENTER}' presses Enter;",
          "'^c' sends Ctrl+C; '%{F4}' sends Alt+F4.",
        ].join(" "),
      },
    },
    required: [],
  },
};

module.exports = { SCREEN_CAPTURE_SCHEMA };
