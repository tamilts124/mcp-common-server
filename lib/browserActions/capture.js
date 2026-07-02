"use strict";
// ── BROWSER CAPTURE: screenshot/pdf/download ──
// Extracted from lib/browserActions/core.js (which had grown past the 500-line threshold).
const {
  ToolError, resolveClientPath, clientRelative, getSession,
  DEFAULT_TIMEOUT, requireSessionId,
} = require("./shared");

async function screenshot(args = {}) {
  requireSessionId(args, "browser_screenshot");
  if (!args.path) throw new ToolError("browser_screenshot requires a 'path' field.", -32602);
  const { page } = getSession(args.session_id);
  const { alias, resolved } = resolveClientPath(args.path);

  try {
    await page.screenshot({ path: resolved, fullPage: !!args.full_page });
  } catch (e) {
    throw new ToolError(`browser_screenshot failed: ${e.message}`, -32603);
  }

  return { session_id: args.session_id, path: clientRelative(alias, resolved), full_page: !!args.full_page };
}

async function pdf(args = {}) {
  requireSessionId(args, "browser_pdf");
  if (!args.path) throw new ToolError("browser_pdf requires a 'path' field.", -32602);
  const { page } = getSession(args.session_id);
  const { alias, resolved } = resolveClientPath(args.path);
  try {
    await page.pdf({ path: resolved, format: args.format || "A4", printBackground: args.print_background !== false });
  } catch (e) {
    throw new ToolError(`browser_pdf failed: ${e.message}`, -32603);
  }
  return { session_id: args.session_id, path: clientRelative(alias, resolved), format: args.format || "A4" };
}

async function download(args = {}) {
  requireSessionId(args, "browser_download");
  if (!args.selector) throw new ToolError("browser_download requires a 'selector' field.", -32602);
  if (!args.path) throw new ToolError("browser_download requires a 'path' field.", -32602);
  const { page } = getSession(args.session_id);
  const { alias, resolved } = resolveClientPath(args.path);

  let download;
  try {
    const [dl] = await Promise.all([
      page.waitForEvent("download", { timeout: args.timeout || DEFAULT_TIMEOUT }),
      page.click(args.selector, { timeout: args.timeout || DEFAULT_TIMEOUT }),
    ]);
    download = dl;
    await download.saveAs(resolved);
  } catch (e) {
    throw new ToolError(`browser_download failed: ${e.message}`, -32603);
  }

  return {
    session_id: args.session_id,
    selector: args.selector,
    path: clientRelative(alias, resolved),
    suggested_filename: download.suggestedFilename(),
    status: "downloaded",
  };
}

module.exports = { screenshot, pdf, download };
