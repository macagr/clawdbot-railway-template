// Private campaign source syncing: real local git repositories stand in for the remote; the token
// is a fake sentinel that must never surface anywhere except inside the per-process auth header.
import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FIXTURE_DIR } from "./helpers.js";
import { syncSource, sourceConfig, updateCampaign, authHeader, authGitArgs, normalizeRepoUrl, scrub, formatSyncResult, runGitProcess, SOURCE_DEFAULTS, LIVE_DIRS } from "../src/campaign/source.js";

const TOKEN = "github_pat_FAKE_SENTINEL_0123456789abcdefXYZ";
const HEADER_B64 = authHeader(TOKEN).slice("Authorization: Basic ".length);
const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const ID = "campaign_fixture";

function sh(args, cwd) {
  const r = childProcess.spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stdout}${r.stderr}`);
  return r.stdout.trim();
}

/** An authored repo (work) pushed to a bare repo (origin), with the fixture as <ID>/. */
function makeOrigin(base) {
  const work = path.join(base, "authored"), origin = path.join(base, "origin.git");
  fs.mkdirSync(work);
  sh(["init", "-q", "-b", "main"], work);
  fs.cpSync(FIXTURE_DIR, path.join(work, ID), { recursive: true });
  fs.writeFileSync(path.join(work, "README.md"), "campaigns\n");
  sh(["add", "-A"], work); sh(["commit", "-q", "-m", "initial"], work);
  sh(["init", "-q", "--bare", "-b", "main", origin]);
  sh(["remote", "add", "origin", origin], work); sh(["push", "-q", "origin", "main"], work);
  return { work, origin, sha: () => sh(["rev-parse", "HEAD"], work), push: (msg) => { sh(["add", "-A"], work); sh(["commit", "-q", "-m", msg], work); sh(["push", "-q", "origin", "main"], work); } };
}

/** Records every git invocation and everything git printed, for secret assertions. */
function recordingRunner() {
  const calls = [], outputs = [];
  const run = (bin, args, opts) => { calls.push(args); const r = runGitProcess(bin, args, opts); outputs.push(r.output); return r; };
  return { run, calls, outputs, authCalls: () => calls.filter((a) => a.includes("clone") || a.includes("fetch")), plainCalls: () => calls.filter((a) => !a.includes("clone") && !a.includes("fetch")) };
}

const lf = (p) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n"); // git on Windows may check out CRLF

function assertNoSecret(text, label) {
  assert.ok(!String(text).includes(TOKEN), `${label} leaks the token`);
  assert.ok(!String(text).includes(HEADER_B64), `${label} leaks the auth header`);
}

function withBase(fn) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "rp-src-"));
  try { return fn(base); } finally { fs.rmSync(base, { recursive: true, force: true }); }
}

test("config: defaults and env override; auth header is Basic x-access-token; URL normalization", () => {
  const c = sourceConfig({});
  assert.deepEqual([c.url, c.branch, c.dir, c.token], [SOURCE_DEFAULTS.CAMPAIGNS_REPO_URL, "main", "/data/campaigns-src", ""]);
  const o = sourceConfig({ CAMPAIGNS_REPO_URL: "https://example.invalid/x/y.git", CAMPAIGNS_REPO_BRANCH: "dev", CAMPAIGNS_REPO_DIR: "/tmp/src", CAMPAIGNS_REPO_TOKEN: TOKEN });
  assert.deepEqual([o.url, o.branch, o.dir, o.token], ["https://example.invalid/x/y.git", "dev", "/tmp/src", TOKEN]);
  assert.equal(Buffer.from(HEADER_B64, "base64").toString(), `x-access-token:${TOKEN}`);
  assert.deepEqual(authGitArgs(TOKEN), ["-c", `http.extraHeader=${authHeader(TOKEN)}`, "-c", "credential.helper="], "auth rides on per-process -c options; credential helpers disabled");
  assert.equal(normalizeRepoUrl("https://GitHub.com/o/r.git/"), normalizeRepoUrl("https://github.com/o/r"));
  assert.notEqual(normalizeRepoUrl("https://github.com/o/r"), normalizeRepoUrl("https://github.com/o/other"));
  assert.equal(scrub(`x ${TOKEN} y ${HEADER_B64} z`, [TOKEN, HEADER_B64]), "x [REDACTED] y [REDACTED] z");
});

test("missing token: useful error naming the variable, without env contents; missing git: clear error", () => {
  withBase((base) => {
    const env = { CAMPAIGNS_REPO_DIR: path.join(base, "src"), CAMPAIGNS_REPO_URL: "https://example.invalid/o/r.git", UNRELATED_SECRET: "unrelated-marker-value" };
    assert.throws(() => syncSource(sourceConfig(env)), (err) => { assert.match(err.message, /CAMPAIGNS_REPO_TOKEN is not set/); assert.doesNotMatch(err.message, /unrelated-marker-value/); assert.equal(err.code, "no-token"); return true; });
    assert.ok(!fs.existsSync(env.CAMPAIGNS_REPO_DIR), "nothing created");
    assert.throws(() => syncSource(sourceConfig({ ...env, CAMPAIGNS_REPO_TOKEN: TOKEN }), { gitBin: path.join(base, "no-such-git") }), /git is not available/);
    assert.throws(() => syncSource(sourceConfig({ ...env, CAMPAIGNS_REPO_TOKEN: TOKEN, CAMPAIGNS_REPO_URL: `https://user:${TOKEN}@example.invalid/o/r.git` })), (err) => { assert.match(err.message, /must not embed credentials/); assertNoSecret(err.message, "error"); return true; });
  });
});

test("clone: command-scoped auth, clean remote URL, nothing persisted; then a clean no-op; then fast-forward", () => {
  withBase((base) => {
    const o = makeOrigin(base);
    const dir = path.join(base, "clone");
    const env = { CAMPAIGNS_REPO_URL: o.origin, CAMPAIGNS_REPO_DIR: dir, CAMPAIGNS_REPO_TOKEN: TOKEN };
    let rec = recordingRunner();
    const first = syncSource(sourceConfig(env), { run: rec.run });
    assert.equal(first.status, "cloned");
    assert.equal(first.new_sha, o.sha());
    assert.equal(first.old_sha, null);
    assert.equal(rec.authCalls().length, 1, "exactly one authenticated git process (clone)");
    for (const a of rec.authCalls()) {
      assert.ok(a.includes(`http.extraHeader=${authHeader(TOKEN)}`), "auth header passed per process");
      assert.ok(a.includes("credential.helper="), "credential helpers disabled for that process");
      assert.ok(!a.some((x) => x !== `http.extraHeader=${authHeader(TOKEN)}` && x.includes(TOKEN)), "raw token only inside the header value");
      assert.ok(!a.some((x) => x.includes(`${TOKEN}@`)), "token not in URL");
    }
    for (const a of rec.plainCalls()) assertNoSecret(a.join(" "), "non-network git call");
    const gitConfig = fs.readFileSync(path.join(dir, ".git", "config"), "utf8");
    assertNoSecret(gitConfig, ".git/config");
    assert.doesNotMatch(gitConfig, /extraheader|credential/i, "no persisted header or credential helper");
    assert.equal(normalizeRepoUrl(sh(["remote", "get-url", "origin"], dir)), normalizeRepoUrl(o.origin), "remote URL is the configured clean URL");
    assert.ok(!fs.existsSync(path.join(dir, ".git-credentials")) && !fs.existsSync(path.join(os.homedir(), ".git-credentials-rp-test")));
    assertNoSecret(JSON.stringify(first) + formatSyncResult(first) + rec.outputs.join("\n"), "result/output");
    assert.ok(fs.existsSync(path.join(dir, ID, "campaign.json")));

    rec = recordingRunner();
    const again = syncSource(sourceConfig(env), { run: rec.run });
    assert.equal(again.status, "current");
    assert.equal(again.old_sha, again.new_sha);
    assert.equal(again.new_sha, o.sha());
    assert.equal(rec.authCalls().length, 1, "one authenticated fetch");
    assert.ok(rec.authCalls()[0].includes("fetch") && rec.authCalls()[0].includes(`http.extraHeader=${authHeader(TOKEN)}`), "fetch auth is command-scoped");
    assert.ok(!rec.calls.some((a) => a.includes("merge") || a.includes("reset") || a.includes("rebase") || a.includes("stash")), "no-op performs no history operation");
    assertNoSecret(fs.readFileSync(path.join(dir, ".git", "config"), "utf8"), ".git/config after fetch");

    fs.writeFileSync(path.join(o.work, ID, "prompts", "director.md"), "# Director fragment v2\n");
    o.push("v2");
    rec = recordingRunner();
    const ff = syncSource(sourceConfig(env), { run: rec.run });
    assert.equal(ff.status, "fast-forwarded");
    assert.equal(ff.old_sha, first.new_sha);
    assert.equal(ff.new_sha, o.sha());
    assert.equal(lf(path.join(dir, ID, "prompts", "director.md")), "# Director fragment v2\n");
    assert.ok(rec.calls.some((a) => a.includes("--ff-only")), "update is fast-forward only");
    assert.ok(!rec.calls.some((a) => a.includes("--force") || a.includes("reset") || a.includes("rebase")));
    assert.equal(runGitProcess("git", ["status", "--porcelain"], { cwd: dir }).output.trim(), "", "clone stays clean");
    assertNoSecret(rec.outputs.join("\n") + JSON.stringify(ff), "fast-forward output");
  });
});

test("refusals: dirty checkout, divergent history, unexpected origin, wrong branch, non-repo directory; local work is never touched", () => {
  withBase((base) => {
    const o = makeOrigin(base);
    const dir = path.join(base, "clone");
    const env = { CAMPAIGNS_REPO_URL: o.origin, CAMPAIGNS_REPO_DIR: dir, CAMPAIGNS_REPO_TOKEN: TOKEN };
    assert.equal(syncSource(sourceConfig(env)).status, "cloned");

    // dirty working tree
    const edited = path.join(dir, "README.md");
    fs.writeFileSync(edited, "local edit\n");
    let r = syncSource(sourceConfig(env));
    assert.equal(r.status, "refused"); assert.match(r.reason, /dirty/);
    assert.equal(fs.readFileSync(edited, "utf8"), "local edit\n", "local edit preserved");
    // dirty index
    sh(["add", "README.md"], dir);
    r = syncSource(sourceConfig(env));
    assert.equal(r.status, "refused"); assert.match(r.reason, /dirty/);
    sh(["reset", "-q", "--hard", "HEAD"], dir);
    // untracked file counts as dirty too
    fs.writeFileSync(path.join(dir, "scratch.txt"), "x");
    assert.match(syncSource(sourceConfig(env)).reason, /dirty/);
    fs.rmSync(path.join(dir, "scratch.txt"));
    assert.equal(syncSource(sourceConfig(env)).status, "current");

    // divergence: a local commit and a different remote commit
    fs.writeFileSync(edited, "local commit\n"); sh(["add", "-A"], dir); sh(["commit", "-q", "-m", "local"], dir);
    const localHead = sh(["rev-parse", "HEAD"], dir);
    fs.writeFileSync(path.join(o.work, "README.md"), "remote commit\n"); o.push("remote");
    r = syncSource(sourceConfig(env));
    assert.equal(r.status, "refused"); assert.match(r.reason, /diverged/); assert.equal(r.old_sha, localHead); assert.equal(r.new_sha, null);
    assert.equal(sh(["rev-parse", "HEAD"], dir), localHead, "local history untouched");
    assert.equal(fs.readFileSync(edited, "utf8"), "local commit\n");

    // unexpected origin
    r = syncSource(sourceConfig({ ...env, CAMPAIGNS_REPO_URL: path.join(base, "somewhere-else.git") }));
    assert.equal(r.status, "refused"); assert.match(r.reason, /unexpected origin/);
    // wrong checked-out branch
    r = syncSource(sourceConfig({ ...env, CAMPAIGNS_REPO_BRANCH: "release" }));
    assert.equal(r.status, "refused"); assert.match(r.reason, /checked-out branch is 'main', expected 'release'/);
    // existing directory that is not a repository
    const plain = path.join(base, "plain"); fs.mkdirSync(plain);
    r = syncSource(sourceConfig({ ...env, CAMPAIGNS_REPO_DIR: plain }));
    assert.equal(r.status, "refused"); assert.match(r.reason, /not a git repository/);
    assertNoSecret(JSON.stringify(r), "refusal");
  });
});

test("authentication failure: git output is scrubbed before it reaches the error; partial clone dir removed", () => {
  withBase((base) => {
    const dir = path.join(base, "clone");
    const env = { CAMPAIGNS_REPO_URL: "https://github.example.invalid/o/private.git", CAMPAIGNS_REPO_DIR: dir, CAMPAIGNS_REPO_TOKEN: TOKEN };
    const run = (bin, args) => args.includes("--version") ? { code: 0, output: "git version 0.test" }
      : { code: 128, output: `fatal: Authentication failed for 'https://x-access-token:${TOKEN}@github.example.invalid/o/private.git/' header ${HEADER_B64}\n` };
    assert.throws(() => syncSource(sourceConfig(env), { run }), (err) => {
      assert.equal(err.code, "clone-failed");
      assert.match(err.message, /authentication or access denied/);
      assertNoSecret(err.message, "thrown error");
      assert.match(err.message, /\[REDACTED\]/);
      return true;
    });
    assert.ok(!fs.existsSync(dir), "no half-cloned directory left behind");
  });
});

test("campaign update: installs the authored package, preserves live dirs, validates; refuses bad ids; reports the failing stage", () => {
  withBase((base) => {
    const o = makeOrigin(base);
    const dir = path.join(base, "clone"), wsRoot = path.join(base, "workspaces");
    const env = { CAMPAIGNS_REPO_URL: o.origin, CAMPAIGNS_REPO_DIR: dir, CAMPAIGNS_REPO_TOKEN: TOKEN, UNRELATED_SECRET: "unrelated-marker-value" };
    const ws = path.join(wsRoot, ID);

    let r = updateCampaign(ID, { env, workspacesRoot: wsRoot });
    assert.ok(r.ok, r.message);
    assert.equal(r.stage, "done"); assert.equal(r.sync.status, "cloned"); assert.ok(r.validation.ok);
    assert.ok(fs.existsSync(path.join(ws, "state", "meta.json")) && fs.existsSync(path.join(ws, "runtime")));
    assertNoSecret(JSON.stringify(r), "update result");

    // live state that must survive: mutate state, add runtime/branches/persistence markers
    const metaPath = path.join(ws, "state", "meta.json");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")); meta.revision = 41; fs.writeFileSync(metaPath, JSON.stringify(meta));
    for (const d of LIVE_DIRS) { fs.mkdirSync(path.join(ws, d), { recursive: true }); fs.writeFileSync(path.join(ws, d, "live-marker.txt"), d); }
    const stateBefore = fs.readFileSync(metaPath, "utf8");

    // authored changes: new prompt text, and a state/ dir inside the package that must be ignored
    fs.writeFileSync(path.join(o.work, ID, "prompts", "director.md"), "# Director fragment v2\n");
    fs.mkdirSync(path.join(o.work, ID, "state"), { recursive: true });
    fs.writeFileSync(path.join(o.work, ID, "state", "meta.json"), JSON.stringify({ poison: true }));
    fs.writeFileSync(path.join(o.work, ID, "NEW-FILE.md"), "new authored file\n");
    o.push("v2");

    r = updateCampaign(ID, { env, workspacesRoot: wsRoot });
    assert.ok(r.ok, r.message);
    assert.equal(r.sync.status, "fast-forwarded");
    assert.equal(lf(path.join(ws, "prompts", "director.md")), "# Director fragment v2\n", "authored package files updated");
    assert.ok(fs.existsSync(path.join(ws, "NEW-FILE.md")));
    assert.equal(fs.readFileSync(metaPath, "utf8"), stateBefore, "live state untouched (package state/ ignored)");
    for (const d of LIVE_DIRS) assert.equal(fs.readFileSync(path.join(ws, d, "live-marker.txt"), "utf8"), d, `${d}/ preserved`);
    assert.ok(!r.install.copied.some((e) => LIVE_DIRS.includes(e)));
    assert.match(r.message, /fast-forwarded[\s\S]*installed[\s\S]*valid/);

    // no-op update still validates
    r = updateCampaign(ID, { env, workspacesRoot: wsRoot });
    assert.ok(r.ok); assert.equal(r.sync.status, "current");

    // bad ids and unknown packages
    assert.equal(updateCampaign("../etc", { env, workspacesRoot: wsRoot }).stage, "resolve");
    r = updateCampaign("no_such_campaign", { env, workspacesRoot: wsRoot });
    assert.equal(r.ok, false); assert.equal(r.stage, "resolve"); assert.match(r.message, /no campaign package/);

    // sync refusal surfaces as stage source-sync and nothing is installed
    fs.writeFileSync(path.join(dir, "README.md"), "dirty\n");
    const promptBefore = lf(path.join(ws, "prompts", "director.md"));
    fs.writeFileSync(path.join(o.work, ID, "prompts", "director.md"), "# v3\n"); o.push("v3");
    r = updateCampaign(ID, { env, workspacesRoot: wsRoot });
    assert.equal(r.ok, false); assert.equal(r.stage, "source-sync"); assert.match(r.message, /dirty/);
    assert.equal(lf(path.join(ws, "prompts", "director.md")), promptBefore, "nothing installed after a refused sync");
    sh(["checkout", "-q", "--", "README.md"], dir);

    // missing token surfaces as stage source-sync without env contents
    r = updateCampaign(ID, { env: { ...env, CAMPAIGNS_REPO_TOKEN: "" }, workspacesRoot: wsRoot });
    assert.equal(r.stage, "source-sync"); assert.match(r.message, /CAMPAIGNS_REPO_TOKEN/); assert.doesNotMatch(r.message, /unrelated-marker-value/);

    // validation failure after install: a package whose channel catalog is invalid
    fs.writeFileSync(path.join(o.work, ID, "channels.json"), JSON.stringify({ channels: "not-an-object" }));
    o.push("broken");
    r = updateCampaign(ID, { env, workspacesRoot: wsRoot });
    assert.equal(r.ok, false); assert.equal(r.stage, "validate"); assert.match(r.message, /validation failed/);
    assertNoSecret(r.message, "validation message");
  });
});

test("CLI: source-sync and update print status and never print the token (stdout/stderr)", () => {
  withBase((base) => {
    const o = makeOrigin(base);
    const dir = path.join(base, "clone"), wsRoot = path.join(base, "workspaces");
    const env = { ...process.env, RP_LOG_LEVEL: "silent", CAMPAIGNS_REPO_URL: o.origin, CAMPAIGNS_REPO_DIR: dir, CAMPAIGNS_REPO_TOKEN: TOKEN };
    const rp = (args, e = env) => { const r = childProcess.spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: e }); assertNoSecret(r.stdout + r.stderr, `rp ${args.join(" ")}`); return { code: r.status, out: r.stdout, err: r.stderr }; };

    let r = rp(["campaign", "source-sync"]);
    assert.equal(r.code, 0, r.err); assert.match(r.out, /^source-sync: cloned .* \(main @ [0-9a-f]{7}\)/);
    r = rp(["campaign", "source-sync"]);
    assert.equal(r.code, 0); assert.match(r.out, /^source-sync: already current \(main @ [0-9a-f]{7}\)/);
    fs.writeFileSync(path.join(o.work, "README.md"), "v2\n"); o.push("v2");
    r = rp(["campaign", "source-sync", "--json"]);
    assert.equal(r.code, 0); const j = JSON.parse(r.out); assert.equal(j.status, "fast-forwarded"); assert.equal(j.new_sha, o.sha()); assert.ok(!("token" in j));
    fs.writeFileSync(path.join(dir, "README.md"), "dirty\n");
    r = rp(["campaign", "source-sync"]);
    assert.equal(r.code, 1); assert.match(r.out, /^source-sync: refused: working tree or index is dirty/);
    sh(["checkout", "-q", "--", "README.md"], dir);

    r = rp(["campaign", "update", ID, "--workspaces-root", wsRoot]);
    assert.equal(r.code, 0, r.err); assert.match(r.out, /already current[\s\S]*installed[\s\S]*valid/);
    assert.ok(fs.existsSync(path.join(wsRoot, ID, "state", "meta.json")));
    r = rp(["campaign", "update", ID, "--workspaces-root", wsRoot], { ...env, CAMPAIGNS_REPO_TOKEN: "" });
    assert.equal(r.code, 1); assert.match(r.out, /failed at stage 'source-sync': CAMPAIGNS_REPO_TOKEN is not set/);
    r = rp(["campaign", "update"]);
    assert.equal(r.code, 1); assert.match(r.err, /campaign update <campaign-id>/);
    r = rp(["campaign", "update", ID, "--workspaces-root", wsRoot], { ...env, RP_WORKSPACES_ROOT: path.join(base, "other-root") });
    assert.equal(r.code, 0, "explicit flag wins over RP_WORKSPACES_ROOT");
    r = rp(["campaign", "update", ID], { ...env, RP_WORKSPACES_ROOT: path.join(base, "other-root") });
    assert.equal(r.code, 0, r.err); assert.ok(fs.existsSync(path.join(base, "other-root", ID, "campaign.json")), "RP_WORKSPACES_ROOT used when no flag");
  });
});
