"use strict";
// ── BROWSER A11Y: accessibility snapshot, role-based element lookup ──
const { ToolError, getSession, requireSessionId } = require("./shared");

const MAX_A11Y_MATCHES = 50;

async function accessibilitySnapshot(args = {}) {
  requireSessionId(args, "browser_accessibility_snapshot");
  const { page } = getSession(args.session_id);
  const selector = args.selector || "body";
  let locator;
  try {
    locator = page.locator(selector);
    if ((await locator.count()) === 0) throw new ToolError(`Selector not found: ${selector}`, -32602);
  } catch (e) {
    if (e instanceof ToolError) throw e;
    throw new ToolError(`browser_accessibility_snapshot invalid selector: ${e.message}`, -32603);
  }
  let snapshot;
  try {
    // ariaSnapshot() is Playwright's current accessibility-tree API — the older
    // page.accessibility.snapshot() was removed in this Playwright version.
    snapshot = await locator.first().ariaSnapshot();
  } catch (e) {
    throw new ToolError(`browser_accessibility_snapshot failed: ${e.message}`, -32603);
  }
  return { session_id: args.session_id, selector: args.selector || null, snapshot };
}

async function findByRole(args = {}) {
  requireSessionId(args, "browser_find_by_role");
  if (!args.role || typeof args.role !== "string")
    throw new ToolError("browser_find_by_role requires a 'role' string field.", -32602);
  const { page } = getSession(args.session_id);
  const options = {};
  if (args.name !== undefined) options.name = String(args.name);
  if (args.exact !== undefined) options.exact = !!args.exact;
  let locator, count, matches;
  try {
    locator = page.getByRole(args.role, options);
    count = await locator.count();
    const limit = Math.min(count, MAX_A11Y_MATCHES);
    matches = [];
    for (let i = 0; i < limit; i++) {
      const el = locator.nth(i);
      const [box, text, visible] = await Promise.all([
        el.boundingBox().catch(() => null),
        el.innerText().catch(() => null),
        el.isVisible().catch(() => null),
      ]);
      matches.push({ index: i, box, text, visible });
    }
  } catch (e) {
    throw new ToolError(`browser_find_by_role failed: ${e.message}`, -32603);
  }
  return { session_id: args.session_id, role: args.role, name: args.name || null, count, matches, truncated: count > MAX_A11Y_MATCHES };
}

module.exports = { accessibilitySnapshot, findByRole };
