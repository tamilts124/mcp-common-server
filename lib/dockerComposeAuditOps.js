"use strict";
// ── CHECK_DOCKER_COMPOSE_ISSUES — docker-compose.yml hygiene/security scan ──
// Distinct from scan_dockerfile_issues (Dockerfile instructions) and
// find_unpinned_docker_base_image (FROM tag pin-strictness inside a
// Dockerfile) — this tool audits docker-compose.yml/yaml service definitions
// themselves, which neither existing tool touches. Reuses the project's
// zero-dependency YAML parser (lib/yamlOps.js parseYaml) rather than a
// second hand-rolled parser.
//
// Rules, per top-level service in `services:`:
//   - image_missing_tag_or_digest (error) — `image:` with no ':' (bare repo,
//     implicit 'latest') and not built locally (no sibling `build:` key).
//   - image_explicit_latest_tag (error) — `image:` ending in ':latest'.
//   - privileged_true (error) — `privileged: true` — full host device/kernel
//     access, a major container-escape risk.
//   - host_network_mode (warning) — `network_mode: host` — bypasses network
//     namespace isolation entirely.
//   - missing_restart_policy (info) — no `restart:` key at all (defaults to
//     docker's own default of never auto-restarting on failure/host reboot).
//   - port_bound_to_all_interfaces (warning) — a `ports:` entry whose host
//     side has no explicit bind address (e.g. "8080:80", not
//     "127.0.0.1:8080:80") — binds to 0.0.0.0 by default, exposing the
//     service beyond localhost even in a "just for dev" compose file.
//   - inline_env_looks_like_secret (warning) — an `environment:` entry whose
//     key matches SECRET/KEY/TOKEN/PASSWORD/CREDENTIAL (case-insensitive)
//     and whose value is a literal (not a `${VAR}`/`$VAR` interpolation) —
//     a hardcoded credential shipped in version control.
//
// Pure structural check over the parsed YAML document (post parseYaml), not
// a full Compose-spec validator — unsupported YAML constructs in the file
// (anchors/aliases, multi-doc streams) surface as parseYaml's own descriptive
// error rather than a silent partial parse.
const fs = require("fs");
const path = require("path");
const { ToolError } = require("./errors");
const { parseYaml } = require("./yamlOps");

const DEFAULT_MAX_RESULTS = 500;
const HARD_MAX_RESULTS = 5000;
const SECRET_NAME_RE = /(SECRET|KEY|TOKEN|PASSWORD|CREDENTIAL)/i;
const INTERPOLATION_RE = /^\$\{?[A-Za-z_]/;

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function parseImageTag(image) {
  // last ':' after the last '/' is the tag separator; a digest ('@sha256:...')
  // counts as a full pin regardless of tag.
  if (typeof image !== "string") return { hasDigest: false, tag: null };
  const atIdx = image.indexOf("@");
  if (atIdx !== -1) return { hasDigest: true, tag: null };
  const lastSlash = image.lastIndexOf("/");
  const lastColon = image.lastIndexOf(":");
  if (lastColon > lastSlash) return { hasDigest: false, tag: image.slice(lastColon + 1) };
  return { hasDigest: false, tag: null };
}

function auditService(name, svc, findings) {
  if (!isPlainObject(svc)) return;

  // image tag / digest pinning
  if (typeof svc.image === "string" && svc.build === undefined) {
    const { hasDigest, tag } = parseImageTag(svc.image);
    if (!hasDigest) {
      if (tag === null) {
        findings.push({ service: name, rule: "image_missing_tag_or_digest", severity: "error",
          message: `Service '${name}' image '${svc.image}' has no tag or digest — resolves to the mutable 'latest' tag.` });
      } else if (tag === "latest") {
        findings.push({ service: name, rule: "image_explicit_latest_tag", severity: "error",
          message: `Service '${name}' image '${svc.image}' explicitly pins the mutable ':latest' tag.` });
      }
    }
  }

  // privileged mode
  if (svc.privileged === true) {
    findings.push({ service: name, rule: "privileged_true", severity: "error",
      message: `Service '${name}' runs with privileged: true — full host device/kernel access, a major container-escape risk.` });
  }

  // host network mode
  if (svc.network_mode === "host") {
    findings.push({ service: name, rule: "host_network_mode", severity: "warning",
      message: `Service '${name}' uses network_mode: host — bypasses network namespace isolation entirely.` });
  }

  // restart policy
  if (svc.restart === undefined) {
    findings.push({ service: name, rule: "missing_restart_policy", severity: "info",
      message: `Service '${name}' has no 'restart' policy — will not auto-restart on failure or host reboot.` });
  }

  // ports bound to all interfaces
  if (Array.isArray(svc.ports)) {
    for (const p of svc.ports) {
      if (typeof p !== "string") continue;
      const segments = p.split(":");
      // 2 segments ("HOST:CONTAINER") with no bind address => all interfaces.
      // 3 segments ("BIND:HOST:CONTAINER") with a non-empty first segment is fine.
      if (segments.length === 2) {
        findings.push({ service: name, rule: "port_bound_to_all_interfaces", severity: "warning",
          message: `Service '${name}' port mapping '${p}' has no explicit bind address — binds to 0.0.0.0 (all interfaces), not just localhost.` });
      } else if (segments.length === 3 && segments[0].trim() === "") {
        findings.push({ service: name, rule: "port_bound_to_all_interfaces", severity: "warning",
          message: `Service '${name}' port mapping '${p}' has an empty bind address — binds to 0.0.0.0 (all interfaces), not just localhost.` });
      }
    }
  }

  // inline secrets in environment
  if (Array.isArray(svc.environment)) {
    for (const entry of svc.environment) {
      if (typeof entry !== "string") continue;
      const eqIdx = entry.indexOf("=");
      if (eqIdx === -1) continue;
      const key = entry.slice(0, eqIdx);
      const value = entry.slice(eqIdx + 1);
      if (SECRET_NAME_RE.test(key) && value.trim() !== "" && !INTERPOLATION_RE.test(value.trim())) {
        findings.push({ service: name, rule: "inline_env_looks_like_secret", severity: "warning",
          message: `Service '${name}' environment key '${key}' looks security-sensitive and has a literal (non-\${VAR}) value — likely a hardcoded credential.` });
      }
    }
  } else if (isPlainObject(svc.environment)) {
    for (const [key, value] of Object.entries(svc.environment)) {
      if (typeof value !== "string") continue;
      if (SECRET_NAME_RE.test(key) && value.trim() !== "" && !INTERPOLATION_RE.test(value.trim())) {
        findings.push({ service: name, rule: "inline_env_looks_like_secret", severity: "warning",
          message: `Service '${name}' environment key '${key}' looks security-sensitive and has a literal (non-\${VAR}) value — likely a hardcoded credential.` });
      }
    }
  }
}

/**
 * @param {string} absPath  Absolute, jail-validated docker-compose file path.
 * @param {string} origPath Client-relative path echoed in the result.
 * @param {object} [opts]
 * @param {number} [opts.maxResults]
 * @returns {{path, serviceCount, findingsCount, errorCount, warningCount, infoCount, truncated, findings}}
 */
function checkDockerComposeIssues(absPath, origPath, opts = {}) {
  let raw;
  try { raw = fs.readFileSync(absPath, "utf8"); }
  catch (e) { throw new ToolError(`check_docker_compose_issues: cannot read '${origPath}': ${e.message}`, -32602); }

  if (opts.maxResults !== undefined && typeof opts.maxResults !== "number")
    throw new ToolError("check_docker_compose_issues: max_results must be a number.", -32602);
  const maxResults = Math.min(Math.max(1, Math.trunc(opts.maxResults ?? DEFAULT_MAX_RESULTS)), HARD_MAX_RESULTS);

  let doc;
  try { doc = parseYaml(raw); }
  catch (e) { throw new ToolError(`check_docker_compose_issues: '${origPath}' is not valid/supported YAML: ${e.message}`, -32602); }

  if (!isPlainObject(doc) || !isPlainObject(doc.services)) {
    return {
      path: origPath,
      serviceCount: 0,
      findingsCount: 0,
      errorCount: 0,
      warningCount: 0,
      infoCount: 0,
      truncated: false,
      findings: [],
      note: "No top-level 'services:' mapping found — nothing to audit.",
    };
  }

  const findings = [];
  const serviceNames = Object.keys(doc.services);
  for (const name of serviceNames) auditService(name, doc.services[name], findings);

  findings.sort((a, b) => a.service.localeCompare(b.service) || a.rule.localeCompare(b.rule));
  const truncated = findings.length > maxResults;
  const errorCount = findings.filter(f => f.severity === "error").length;
  const warningCount = findings.filter(f => f.severity === "warning").length;
  const infoCount = findings.filter(f => f.severity === "info").length;

  return {
    path: origPath,
    serviceCount: serviceNames.length,
    findingsCount: findings.length,
    errorCount,
    warningCount,
    infoCount,
    truncated,
    findings: findings.slice(0, maxResults),
  };
}

module.exports = { checkDockerComposeIssues };
