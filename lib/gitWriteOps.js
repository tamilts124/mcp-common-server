"use strict";
// ── GIT WRITE OPERATIONS ────────────────────────────────────────────────────
// Implements git_write_ops: add, commit, push, pull, checkout, branch,
// reset, stash, merge, rebase, cherry_pick, tag.
// Uses spawnSync (args array, no shell) so arbitrary string content in
// commit messages / tag names / etc. cannot cause shell injection.
// Requires MCP_ALLOW_EXEC=true.
const childProcess = require("child_process");
const path         = require("path");

const { ALLOW_EXEC } = require("./config");
const { ToolError }  = require("./errors");

const GIT_WRITE_TIMEOUT_MS = 30_000;

function requireExec() {
  if (!ALLOW_EXEC)
    throw new ToolError(
      "git_write_ops is disabled. Start server with MCP_ALLOW_EXEC=true to enable.",
      -32001,
    );
}

/**
 * Minimal safety check — null bytes crash spawnSync and excessive length is
 * a DoS vector; that's all we guard against here since there is no shell
 * involved (args are passed directly to git as an array, not interpolated).
 */
function validateStr(value, label, maxLen) {
  maxLen = maxLen || 4096;
  if (typeof value !== "string")
    throw new ToolError(`git_write_ops: '${label}' must be a string, got ${typeof value}.`, -32602);
  if (value.length > maxLen)
    throw new ToolError(`git_write_ops: '${label}' exceeds ${maxLen} characters.`, -32602);
  if (/\0/.test(value))
    throw new ToolError(`git_write_ops: '${label}' contains null bytes.`, -32602);
}

/**
 * Run git with an explicit args array (no shell, so no injection risk).
 * Throws a ToolError with git's own stderr on non-zero exit.
 */
function gitSpawn(gitArgs, cwd) {
  const result = childProcess.spawnSync("git", gitArgs, {
    cwd,
    timeout:     GIT_WRITE_TIMEOUT_MS,
    encoding:    "utf8",
    windowsHide: true,
    maxBuffer:   10 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_CEILING_DIRECTORIES: path.dirname(cwd),
      GIT_TERMINAL_PROMPT: "0",   // never block waiting for credential input
      GIT_EDITOR: "true",         // suppress interactive editor in non-interactive rebase etc.
    },
  });

  if (result.error) throw result.error; // e.g. ENOENT if git not installed

  if (result.status !== 0) {
    const msg = ((result.stderr || "") + (result.stdout || "")).trim();
    throw new ToolError(
      msg || `git ${gitArgs[0]} failed with exit code ${result.status}`,
      -32603,
    );
  }
  return (result.stdout || "").trimEnd();
}

/** Current branch name (or commit hash when detached). */
function currentBranch(repoDir) {
  try { return gitSpawn(["rev-parse", "--abbrev-ref", "HEAD"], repoDir).trim(); }
  catch (_) { return null; }
}

/** HEAD commit hash. */
function headHash(repoDir) {
  try { return gitSpawn(["rev-parse", "HEAD"], repoDir).trim(); }
  catch (_) { return null; }
}

// ── Operations ───────────────────────────────────────────────────────────────

function opAdd(args, repoDir, resolveClientPath) {
  let stagedBefore = 0;
  try {
    const s = gitSpawn(["diff", "--cached", "--name-only"], repoDir);
    stagedBefore = s.split("\n").filter(Boolean).length;
  } catch (_) {}

  let out;
  if (args.paths && args.paths.length > 0) {
    const absPaths = args.paths.map((p, i) => {
      validateStr(p, `paths[${i}]`);
      return resolveClientPath(p).resolved;
    });
    out = gitSpawn(["add", "--", ...absPaths], repoDir);
  } else if (args.all !== false) {
    // Default: add --all
    out = gitSpawn(["add", "--all"], repoDir);
  } else {
    throw new ToolError("git_write_ops add: provide 'paths' array or set 'all: true'.", -32602);
  }

  let stagedAfter = 0;
  try {
    const s = gitSpawn(["diff", "--cached", "--name-only"], repoDir);
    stagedAfter = s.split("\n").filter(Boolean).length;
  } catch (_) {}

  return {
    operation: "add",
    stagedFiles: stagedAfter,
    newlyStagedFiles: Math.max(0, stagedAfter - stagedBefore),
    output: out || "(files staged)",
  };
}

function opCommit(args, repoDir) {
  const needsMsg = !args.amend || !args.no_edit;
  if (!args.message && needsMsg && !args.allow_empty_message)
    throw new ToolError(
      "git_write_ops commit: 'message' is required (or set amend+no_edit, or allow_empty_message).",
      -32602,
    );

  const gitArgs = ["commit"];
  if (args.message) {
    validateStr(args.message, "message", 10000);
    gitArgs.push("-m", args.message);
  }
  if (args.author) {
    validateStr(args.author, "author");
    if (!/^.+ <[^<>]+>$/.test(args.author))
      throw new ToolError("git_write_ops commit: 'author' must be 'Name <email>' format.", -32602);
    gitArgs.push(`--author=${args.author}`);
  }
  if (args.amend)               gitArgs.push("--amend");
  if (args.allow_empty)         gitArgs.push("--allow-empty");
  if (args.allow_empty_message) gitArgs.push("--allow-empty-message");
  if (args.no_verify)           gitArgs.push("--no-verify");
  if (args.no_edit)             gitArgs.push("--no-edit");

  const out = gitSpawn(gitArgs, repoDir);
  return { operation: "commit", hash: headHash(repoDir), output: out };
}

function opPush(args, repoDir) {
  const remote = args.remote || "origin";
  validateStr(remote, "remote");

  const gitArgs = ["push", remote];
  if (args.branch) {
    validateStr(args.branch, "branch");
    gitArgs.push(args.branch);
  }
  if (args.force)            gitArgs.push("--force");
  if (args.force_with_lease) gitArgs.push("--force-with-lease");
  if (args.set_upstream)     gitArgs.push("--set-upstream");
  if (args.tags)             gitArgs.push("--tags");
  if (args.delete_branch) {
    validateStr(args.delete_branch, "delete_branch");
    gitArgs.push("--delete", args.delete_branch);
  }

  const out = gitSpawn(gitArgs, repoDir);
  return { operation: "push", remote, output: out || "(pushed)" };
}

function opPull(args, repoDir) {
  const remote = args.remote || "origin";
  validateStr(remote, "remote");

  const gitArgs = ["pull", remote];
  if (args.branch) {
    validateStr(args.branch, "branch");
    gitArgs.push(args.branch);
  }
  if (args.rebase)    gitArgs.push("--rebase");
  if (args.ff_only)   gitArgs.push("--ff-only");
  if (args.no_commit) gitArgs.push("--no-commit");

  const out = gitSpawn(gitArgs, repoDir);
  return { operation: "pull", remote, output: out };
}

function opCheckout(args, repoDir) {
  if (!args.branch)
    throw new ToolError("git_write_ops checkout: 'branch' is required.", -32602);
  validateStr(args.branch, "branch");

  const gitArgs = args.create
    ? ["checkout", "-b", args.branch]
    : ["checkout", args.branch];

  if (args.from) {
    validateStr(args.from, "from");
    gitArgs.push(args.from);
  }

  const out = gitSpawn(gitArgs, repoDir);
  return {
    operation: "checkout",
    branch:    currentBranch(repoDir),
    output:    out || `Switched to branch '${args.branch}'`,
  };
}

function opBranch(args, repoDir) {
  const action = args.action || "create";

  if (action === "list") {
    const out    = gitSpawn(["branch", "-a"], repoDir);
    const branches = out.split("\n").filter(Boolean).map(b => b.trim().replace(/^\* /, ""));
    return { operation: "branch", action, branches };
  }

  if (!args.name)
    throw new ToolError(`git_write_ops branch: 'name' is required for action '${action}'.`, -32602);
  validateStr(args.name, "name");

  if (action === "create") {
    const gitArgs = ["branch", args.name];
    if (args.from) { validateStr(args.from, "from"); gitArgs.push(args.from); }
    const out = gitSpawn(gitArgs, repoDir);
    return { operation: "branch", action, name: args.name, output: out || `Branch '${args.name}' created.` };
  }
  if (action === "delete") {
    const flag = args.force ? "-D" : "-d";
    const out = gitSpawn(["branch", flag, args.name], repoDir);
    return { operation: "branch", action, name: args.name, output: out };
  }
  if (action === "rename") {
    if (!args.target)
      throw new ToolError("git_write_ops branch rename: 'target' (new name) is required.", -32602);
    validateStr(args.target, "target");
    const out = gitSpawn(["branch", "-m", args.name, args.target], repoDir);
    return { operation: "branch", action, name: args.name, target: args.target, output: out || "" };
  }
  throw new ToolError(
    `git_write_ops branch: unknown action '${action}'. Valid: create, delete, rename, list.`,
    -32602,
  );
}

function opReset(args, repoDir) {
  const mode = args.mode || "mixed";
  if (!["soft", "mixed", "hard"].includes(mode))
    throw new ToolError(`git_write_ops reset: unknown mode '${mode}'. Valid: soft, mixed, hard.`, -32602);

  if (args.paths && args.paths.length > 0) {
    const safePaths = args.paths.map((p, i) => { validateStr(p, `paths[${i}]`); return p; });
    const out = gitSpawn(["reset", "HEAD", "--", ...safePaths], repoDir);
    return { operation: "reset", mode: "unstage", paths: safePaths, hash: headHash(repoDir), output: out };
  }

  const ref = args.ref || "HEAD";
  validateStr(ref, "ref");
  const out = gitSpawn(["reset", `--${mode}`, ref], repoDir);
  return { operation: "reset", mode, ref, hash: headHash(repoDir), output: out || "Reset complete." };
}

function opStash(args, repoDir) {
  const subop = args.subop || "push";

  if (subop === "push") {
    const gitArgs = ["stash", "push"];
    if (args.message) { validateStr(args.message, "message", 500); gitArgs.push("-m", args.message); }
    if (args.include_untracked) gitArgs.push("--include-untracked");
    if (args.paths && args.paths.length > 0) {
      gitArgs.push("--");
      args.paths.forEach((p, i) => { validateStr(p, `paths[${i}]`); gitArgs.push(p); });
    }
    const out = gitSpawn(gitArgs, repoDir);
    return { operation: "stash", subop, output: out };
  }
  if (subop === "pop" || subop === "drop") {
    const gitArgs = ["stash", subop];
    if (args.stash) { validateStr(args.stash, "stash"); gitArgs.push(args.stash); }
    const out = gitSpawn(gitArgs, repoDir);
    return { operation: "stash", subop, output: out };
  }
  if (subop === "list") {
    const out = gitSpawn(["stash", "list"], repoDir);
    return { operation: "stash", subop, output: out };
  }
  if (subop === "show") {
    const gitArgs = ["stash", "show"];
    if (args.stash) { validateStr(args.stash, "stash"); gitArgs.push(args.stash); }
    const out = gitSpawn(gitArgs, repoDir);
    return { operation: "stash", subop, output: out };
  }
  if (subop === "clear") {
    const out = gitSpawn(["stash", "clear"], repoDir);
    return { operation: "stash", subop, output: out || "(stash cleared)" };
  }
  throw new ToolError(
    `git_write_ops stash: unknown subop '${subop}'. Valid: push, pop, drop, list, show, clear.`,
    -32602,
  );
}

function opMerge(args, repoDir) {
  if (args.abort) {
    const out = gitSpawn(["merge", "--abort"], repoDir);
    return { operation: "merge", action: "abort", output: out };
  }
  if (args.continue) {
    const out = gitSpawn(["merge", "--continue"], repoDir);
    return { operation: "merge", action: "continue", hash: headHash(repoDir), output: out };
  }
  if (!args.branch)
    throw new ToolError("git_write_ops merge: 'branch' is required (or set abort/continue).", -32602);
  validateStr(args.branch, "branch");

  const gitArgs = ["merge", args.branch];
  if (args.no_ff)     gitArgs.push("--no-ff");
  if (args.squash)    gitArgs.push("--squash");
  if (args.no_commit) gitArgs.push("--no-commit");
  if (args.message) { validateStr(args.message, "message", 10000); gitArgs.push("-m", args.message); }

  const out = gitSpawn(gitArgs, repoDir);
  return { operation: "merge", branch: args.branch, hash: headHash(repoDir), output: out };
}

function opRebase(args, repoDir) {
  if (args.action) {
    const action = args.action;
    if (!["continue", "abort", "skip"].includes(action))
      throw new ToolError(
        `git_write_ops rebase: unknown action '${action}'. Valid: continue, abort, skip.`,
        -32602,
      );
    const out = gitSpawn(["rebase", `--${action}`], repoDir);
    return { operation: "rebase", action, hash: headHash(repoDir), output: out };
  }
  if (!args.branch)
    throw new ToolError("git_write_ops rebase: 'branch' is required (or set 'action').", -32602);
  validateStr(args.branch, "branch");

  const gitArgs = ["rebase"];
  if (args.onto) {
    validateStr(args.onto, "onto");
    gitArgs.push("--onto", args.onto);
  }
  gitArgs.push(args.branch);

  const out = gitSpawn(gitArgs, repoDir);
  return { operation: "rebase", branch: args.branch, hash: headHash(repoDir), output: out };
}

function opCherryPick(args, repoDir) {
  if (args.action) {
    const action = args.action;
    if (!["continue", "abort", "quit"].includes(action))
      throw new ToolError(
        `git_write_ops cherry_pick: unknown action '${action}'. Valid: continue, abort, quit.`,
        -32602,
      );
    const out = gitSpawn(["cherry-pick", `--${action}`], repoDir);
    return { operation: "cherry_pick", action, hash: headHash(repoDir), output: out };
  }
  if (!args.ref)
    throw new ToolError("git_write_ops cherry_pick: 'ref' is required (or set 'action').", -32602);
  validateStr(args.ref, "ref");

  const gitArgs = ["cherry-pick", args.ref];
  if (args.no_commit) gitArgs.push("--no-commit");
  if (args.mainline != null) {
    if (!Number.isInteger(args.mainline) || args.mainline < 1)
      throw new ToolError("git_write_ops cherry_pick: 'mainline' must be a positive integer.", -32602);
    gitArgs.push("-m", String(args.mainline));
  }

  const out = gitSpawn(gitArgs, repoDir);
  return { operation: "cherry_pick", ref: args.ref, hash: headHash(repoDir), output: out };
}

function opTag(args, repoDir) {
  const action = args.action || "create";
  if (!["create", "delete", "list"].includes(action))
    throw new ToolError(`git_write_ops tag: unknown action '${action}'. Valid: create, delete, list.`, -32602);

  if (action === "list") {
    const out = gitSpawn(["tag", "-l"], repoDir);
    return { operation: "tag", action, tags: out.split("\n").filter(Boolean) };
  }

  if (!args.name)
    throw new ToolError("git_write_ops tag: 'name' is required.", -32602);
  validateStr(args.name, "name");

  if (action === "delete") {
    const out = gitSpawn(["tag", "-d", args.name], repoDir);
    return { operation: "tag", action, name: args.name, output: out };
  }

  // create
  const gitArgs = ["tag"];
  if (args.message) {
    validateStr(args.message, "message", 10000);
    gitArgs.push("-a", args.name, "-m", args.message);
  } else {
    gitArgs.push(args.name);
  }
  if (args.ref)   { validateStr(args.ref, "ref"); gitArgs.push(args.ref); }
  if (args.force) gitArgs.push("--force");

  const out = gitSpawn(gitArgs, repoDir);
  return { operation: "tag", action, name: args.name, output: out || `Tag '${args.name}' created.` };
}

// ── Main dispatcher ──────────────────────────────────────────────────────────

const VALID_OPS = [
  "add", "commit", "push", "pull", "checkout",
  "branch", "reset", "stash", "merge", "rebase",
  "cherry_pick", "tag",
];

function gitWriteOps(args, repoDir, resolveClientPath) {
  requireExec();

  if (!args.operation)
    throw new ToolError("git_write_ops: 'operation' is required.", -32602);
  if (!VALID_OPS.includes(args.operation))
    throw new ToolError(
      `git_write_ops: unknown operation '${args.operation}'. Valid: ${VALID_OPS.join(", ")}.`,
      -32602,
    );

  switch (args.operation) {
    case "add":         return opAdd(args, repoDir, resolveClientPath);
    case "commit":      return opCommit(args, repoDir);
    case "push":        return opPush(args, repoDir);
    case "pull":        return opPull(args, repoDir);
    case "checkout":    return opCheckout(args, repoDir);
    case "branch":      return opBranch(args, repoDir);
    case "reset":       return opReset(args, repoDir);
    case "stash":       return opStash(args, repoDir);
    case "merge":       return opMerge(args, repoDir);
    case "rebase":      return opRebase(args, repoDir);
    case "cherry_pick": return opCherryPick(args, repoDir);
    case "tag":         return opTag(args, repoDir);
    default:
      throw new ToolError(`git_write_ops: unhandled operation '${args.operation}'.`, -32603);
  }
}

module.exports = { gitWriteOps };
