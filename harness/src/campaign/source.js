// Private campaign source: clone/fast-forward the authored campaign repository and install a
// package from it. Authentication is command-scoped: the token is passed to each git process as a
// per-process `-c http.extraHeader=…` option and is never written to the remote URL, .git/config,
// a credential helper, logs, command output or thrown errors.
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ensureDir, exists, copyDir } from "../lib/fsx.js";
import { redact } from "../lib/redact.js";
import { CampaignStore } from "../state/store.js";
import { validateCampaign } from "../ops/tools.js";

export const SOURCE_DEFAULTS = Object.freeze({
  CAMPAIGNS_REPO_URL: "https://github.com/macagr/rp-campaigns.git",
  CAMPAIGNS_REPO_BRANCH: "main",
  CAMPAIGNS_REPO_DIR: "/data/campaigns-src",
});
export const DEFAULT_WORKSPACES_ROOT = "/data/workspaces";
/** Directories owned by the harness at runtime; never copied from a package, never overwritten. */
export const LIVE_DIRS = Object.freeze(["state", "runtime", "branches", "persistence"]);
const CAMPAIGN_ID_RE = /^[a-z][a-z0-9_-]*$/;

/** Read source configuration from the environment. Never returns anything but the four keys. */
export function sourceConfig(env = process.env) {
  return {
    url: env.CAMPAIGNS_REPO_URL || SOURCE_DEFAULTS.CAMPAIGNS_REPO_URL,
    branch: env.CAMPAIGNS_REPO_BRANCH || SOURCE_DEFAULTS.CAMPAIGNS_REPO_BRANCH,
    dir: env.CAMPAIGNS_REPO_DIR || SOURCE_DEFAULTS.CAMPAIGNS_REPO_DIR,
    token: env.CAMPAIGNS_REPO_TOKEN || "",
  };
}

/** GitHub HTTPS auth: Basic with username x-access-token. */
export function authHeader(token) {
  return `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
}

/** Per-process git options carrying auth. Nothing here is persisted by git. */
export function authGitArgs(token) {
  return ["-c", `http.extraHeader=${authHeader(token)}`, "-c", "credential.helper="];
}

/** Compare repository URLs modulo trailing `.git`, trailing slashes and host case. */
export function normalizeRepoUrl(u) {
  let s = String(u || "").trim().replace(/\/+$/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  s = s.replace(/^(https?:\/\/)([^/]+)/i, (m, p, host) => p + host.toLowerCase());
  if (/^[A-Za-z]:[\\/]/.test(s) || s.startsWith("/") || s.startsWith("file:")) s = s.replace(/\\/g, "/").replace(/^file:\/\//, "");
  return s;
}

/** Remove every secret-bearing string from text destined for output or errors. */
export function scrub(text, secrets = []) {
  let s = String(text ?? "");
  const variants = new Set();
  for (const sec of secrets) if (sec) for (const v of [sec, encodeURIComponent(sec), Buffer.from(sec).toString("base64")]) if (v.length >= 4) variants.add(v);
  // Longest first so a shorter variant never splits a longer one (e.g. the token's base64 inside the header's).
  for (const v of [...variants].sort((a, b) => b.length - a.length)) s = s.split(v).join("[REDACTED]");
  return redact(s);
}

export class SourceSyncError extends Error {
  constructor(message, { code = "source-sync" } = {}) { super(message); this.code = code; }
}

/** Default process runner: never inherits stdin, never prompts, returns combined output. */
export function runGitProcess(bin, args, { cwd } = {}) {
  const r = childProcess.spawnSync(bin, args, {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "", GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM || "" },
  });
  if (r.error) return { code: r.error.code === "ENOENT" ? 127 : 1, output: String(r.error.message || r.error) };
  return { code: r.status ?? 1, output: `${r.stdout || ""}${r.stderr || ""}` };
}

/**
 * Clone or fast-forward the campaign source repository.
 * Returns { status: cloned|current|fast-forwarded|refused, dir, branch, old_sha, new_sha, reason }.
 * Throws SourceSyncError for missing token, missing git, or a failed clone/fetch (auth, network).
 */
export function syncSource(config, { run = runGitProcess, gitBin = process.env.GIT_BIN || "git" } = {}) {
  const { url, branch, dir, token } = config;
  const secrets = token ? [token, authHeader(token).slice("Authorization: ".length)] : [];
  if (!token) throw new SourceSyncError("CAMPAIGNS_REPO_TOKEN is not set. Set it to a GitHub fine-grained token with read-only Contents access to the campaign repository.", { code: "no-token" });
  if (!/^https:\/\//i.test(url) && !/^(file:|\/|[A-Za-z]:[\\/])/.test(url)) throw new SourceSyncError(`CAMPAIGNS_REPO_URL must be an https:// URL (got ${scrub(url, secrets)})`, { code: "bad-url" });
  if (url.includes("@")) throw new SourceSyncError("CAMPAIGNS_REPO_URL must not embed credentials; use CAMPAIGNS_REPO_TOKEN", { code: "bad-url" });
  if (!/^[A-Za-z0-9._\/-]+$/.test(branch) || branch.startsWith("-")) throw new SourceSyncError(`invalid CAMPAIGNS_REPO_BRANCH ${scrub(branch, secrets)}`, { code: "bad-branch" });

  const git = (args, opts = {}) => {
    const r = run(gitBin, args, { cwd: opts.cwd });
    return { code: r.code, output: scrub(r.output, secrets) };
  };
  const version = git(["--version"]);
  if (version.code !== 0) throw new SourceSyncError(`git is not available (${gitBin}): ${version.output.trim() || `exit ${version.code}`}`, { code: "no-git" });

  const auth = authGitArgs(token);
  const result = { status: null, dir, branch, url, old_sha: null, new_sha: null, reason: null };
  const refuse = (reason) => Object.assign(result, { status: "refused", reason });

  if (!exists(dir)) {
    ensureDir(path.dirname(dir));
    const r = git([...auth, "clone", "--quiet", "--branch", branch, "--single-branch", "--", url, dir]);
    if (r.code !== 0) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new SourceSyncError(`clone failed (${classifyGitFailure(r.output)}): ${r.output.trim().slice(-300)}`, { code: "clone-failed" });
    }
    result.new_sha = head(git, dir);
    result.status = "cloned";
    return result;
  }

  if (!exists(path.join(dir, ".git"))) return refuse(`${dir} exists but is not a git repository`);
  const origin = git(["remote", "get-url", "origin"], { cwd: dir });
  if (origin.code !== 0) return refuse(`no 'origin' remote in ${dir}`);
  if (normalizeRepoUrl(origin.output) !== normalizeRepoUrl(url)) return refuse(`unexpected origin in ${dir}: ${origin.output.trim()} (expected ${url})`);
  const current = git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir });
  if (current.code !== 0 || current.output.trim() !== branch) return refuse(`checked-out branch is '${current.output.trim()}', expected '${branch}'`);
  const status = git(["status", "--porcelain", "--untracked-files=normal"], { cwd: dir });
  if (status.code !== 0) return refuse(`git status failed: ${status.output.trim()}`);
  if (status.output.trim()) return refuse(`working tree or index is dirty in ${dir} (${status.output.trim().split("\n").length} path(s)); commit, revert or remove local changes first`);

  result.old_sha = head(git, dir);
  const fetch = git([...auth, "fetch", "--quiet", "--", "origin", branch], { cwd: dir });
  if (fetch.code !== 0) throw new SourceSyncError(`fetch failed (${classifyGitFailure(fetch.output)}): ${fetch.output.trim().slice(-300)}`, { code: "fetch-failed" });
  const fetched = git(["rev-parse", "FETCH_HEAD"], { cwd: dir });
  if (fetched.code !== 0) throw new SourceSyncError(`cannot resolve FETCH_HEAD: ${fetched.output.trim()}`, { code: "fetch-failed" });
  result.new_sha = fetched.output.trim();
  if (result.new_sha === result.old_sha) { result.status = "current"; return result; }
  const ancestor = git(["merge-base", "--is-ancestor", "HEAD", "FETCH_HEAD"], { cwd: dir });
  if (ancestor.code !== 0) { result.new_sha = null; return refuse(`local branch '${branch}' has diverged from origin/${branch} (local ${result.old_sha.slice(0, 7)}); resolve manually, the harness never merges, rebases or resets`); }
  const ff = git(["merge", "--ff-only", "--quiet", "FETCH_HEAD"], { cwd: dir });
  if (ff.code !== 0) throw new SourceSyncError(`fast-forward failed: ${ff.output.trim().slice(-300)}`, { code: "ff-failed" });
  result.new_sha = head(git, dir);
  result.status = "fast-forwarded";
  return result;
}

function head(git, dir) {
  const r = git(["rev-parse", "HEAD"], { cwd: dir });
  if (r.code !== 0) throw new SourceSyncError(`cannot resolve HEAD in ${dir}: ${r.output.trim()}`, { code: "no-head" });
  return r.output.trim();
}

function classifyGitFailure(output) {
  const o = String(output).toLowerCase();
  if (/authentication failed|401|403|could not read username|invalid credentials|permission denied|repository not found/.test(o)) return "authentication or access denied";
  if (/could not resolve host|unable to access|connection|timed out|network/.test(o)) return "network";
  if (/remote branch .* not found|couldn't find remote ref/.test(o)) return "branch not found";
  return "git error";
}

export function formatSyncResult(r) {
  const short = (s) => (s ? s.slice(0, 7) : "?");
  switch (r.status) {
    case "cloned": return `source-sync: cloned ${r.dir} (${r.branch} @ ${short(r.new_sha)})`;
    case "current": return `source-sync: already current (${r.branch} @ ${short(r.new_sha)})`;
    case "fast-forwarded": return `source-sync: fast-forwarded ${short(r.old_sha)}..${short(r.new_sha)} (${r.branch})`;
    case "refused": return `source-sync: refused: ${r.reason}`;
    default: return `source-sync: ${JSON.stringify(r)}`;
  }
}

/** Copy a package into a workspace, skipping live directories, then init (never overwrites state). */
export function installPackage(from, to) {
  if (!exists(path.join(from, "campaign.json"))) throw new Error(`${from} is not a campaign package (no campaign.json)`);
  ensureDir(to);
  const copied = [];
  for (const entry of fs.readdirSync(from)) {
    if (LIVE_DIRS.includes(entry) || entry === ".git") continue;
    const src = path.join(from, entry), dst = path.join(to, entry);
    if (fs.statSync(src).isDirectory()) copyDir(src, dst); else fs.copyFileSync(src, dst);
    copied.push(entry);
  }
  CampaignStore.init(to);
  return { from, to, copied };
}

/**
 * Sync the source, install <dir>/<campaignId> into <workspacesRoot>/<campaignId>, validate.
 * Returns { ok, stage, sync, install, validation, message }. Never touches OpenClaw config, bindings
 * or live state; never restarts anything.
 */
export function updateCampaign(campaignId, { env = process.env, workspacesRoot, run, gitBin } = {}) {
  if (!CAMPAIGN_ID_RE.test(String(campaignId || ""))) return { ok: false, stage: "resolve", message: `invalid campaign id '${campaignId}' (expected ${CAMPAIGN_ID_RE})` };
  const root = workspacesRoot || env.RP_WORKSPACES_ROOT || DEFAULT_WORKSPACES_ROOT;
  const config = sourceConfig(env);
  let sync;
  try { sync = syncSource(config, { run, gitBin }); } catch (err) { return { ok: false, stage: "source-sync", message: err.message }; }
  if (sync.status === "refused") return { ok: false, stage: "source-sync", sync, message: formatSyncResult(sync) };
  const from = path.join(config.dir, campaignId), to = path.join(root, campaignId);
  if (!exists(path.join(from, "campaign.json"))) return { ok: false, stage: "resolve", sync, message: `no campaign package at ${from} (campaign.json missing)` };
  let install;
  try { install = installPackage(from, to); } catch (err) { return { ok: false, stage: "install", sync, message: `install failed: ${err.message}` }; }
  let validation;
  try { validation = validateCampaign(new CampaignStore(to)); } catch (err) { return { ok: false, stage: "validate", sync, install, message: `validation could not run: ${err.message}` }; }
  if (!validation.ok) return { ok: false, stage: "validate", sync, install, validation, message: `validation failed:\n- ${validation.problems.join("\n- ")}` };
  return { ok: true, stage: "done", sync, install, validation, message: `${formatSyncResult(sync)}\ninstalled ${from} into ${to} (existing ${LIVE_DIRS.join("/")} untouched)\nvalid (${JSON.stringify(validation.counts)})` };
}
