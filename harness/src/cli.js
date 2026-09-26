#!/usr/bin/env node
// rp — narrative RPG harness CLI. Campaign-agnostic; every command takes --campaign <dir>.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHarness } from "./app.js";
import { CampaignStore } from "./state/store.js";
import { TextTransport } from "./transport/text.js";
import { DiscordTransport } from "./transport/discord.js";
import { routeCommand } from "./commands/router.js";
import { validateCampaign, reconstructCheck, exportState, importState, repairLock, scanGenericTree } from "./ops/tools.js";
import { dryRunSave } from "./persistence/save.js";
import { openclawConfigFor, configSetOps, writeWorkspaces, applyConfig } from "./openclaw/setup.js";
import { importSillyTavern, exportSillyTavern } from "./voices/sillytavern.js";
import { resolveVoiceCard } from "./voices/voices.js";
import { readJson, writeJson, exists } from "./lib/fsx.js";
import { redact } from "./lib/redact.js";
import { installPackage, sourceConfig, syncSource, formatSyncResult, updateCampaign } from "./campaign/source.js";

const HARNESS_ROOT = fileURLToPath(new URL("../", import.meta.url));

const USAGE = `rp <command> [options]

Play
  turn --campaign <dir> [--event-id <id>] [--transport cli|discord|openclaw-ui] [--player <id>] [--show-stop|--hide-stop] (--text <t> | --stdin)
  command --campaign <dir> [--event-id <id>] [--transport <t>] -- /<command> [args]
  discord --campaign <dir> --event <json-file|->      handle one normalized Discord event; prints JSON {chunks, turn_id}
  deliver --campaign <dir> --turn <id> [--message-id <id>...]   mark a committed turn delivered
  pending --campaign <dir>                            list committed-but-undelivered turns

Operate
  status | context [director|novelist] | validate | reconstruct-check | repair-lock [--force]
  export-state --out <file> | import-state --in <file> --confirm <campaign id>
  dry-run-save | test-adapter | smoke-test | lint-generic [--denylist <file>]

Setup
  init --campaign <dir>                               create state/runtime for a campaign package (idempotent)
  campaign install --from <package dir> --to <workspace dir>   copy a package without touching existing state
  campaign source-sync [--json]                       clone or fast-forward the private campaign repo (CAMPAIGNS_REPO_*)
  campaign update <campaign-id> [--workspaces-root <dir>] [--json]   source-sync, install <repo>/<id>, validate (no OpenClaw changes)
  setup-openclaw --campaign <dir> [--dry-run] [--rp-bin <path>] [--workspaces-root <dir>]
  sillytavern import --campaign <dir> --file <card.json> [--id <id>]
  sillytavern export --campaign <dir> --voice <id> --out <file>

Env: RP_LOG_LEVEL, RP_FAKE_RESPONSES (scripted fake models), RP_MODELS_CONFIG, provider keys per config/models.json,
     CAMPAIGNS_REPO_TOKEN (required for source-sync/update), CAMPAIGNS_REPO_URL, CAMPAIGNS_REPO_BRANCH, CAMPAIGNS_REPO_DIR, RP_WORKSPACES_ROOT`;

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { out.rest = argv.slice(i + 1); break; }
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out.flags[k] = true;
      else { (out.flags[k] === undefined ? (out.flags[k] = next) : (out.flags[k] = [].concat(out.flags[k], next))); i++; }
    } else out._.push(a);
  }
  return out;
}

function need(flags, k) { if (!flags[k]) throw new Error(`--${k} is required`); return flags[k]; }
function readStdin() { return fs.readFileSync(0, "utf8"); }
function print(s) { process.stdout.write(`${typeof s === "string" ? s : JSON.stringify(s, null, 2)}\n`); }

export async function main(argv = process.argv.slice(2), { env = process.env } = {}) {
  const args = parseArgs(argv);
  const cmd = args._[0];
  const sub = args._[1];
  const f = args.flags;
  if (!cmd || cmd === "help" || f.help) { print(USAGE); return 0; }

  if (cmd === "init") { const dir = need(f, "campaign"); CampaignStore.init(dir); print(`initialized ${dir}`); return 0; }
  if (cmd === "campaign" && sub === "install") {
    const from = need(f, "from"), to = need(f, "to");
    installPackage(from, to);
    print(`installed package from ${from} to ${to} (existing state/runtime untouched)`);
    return 0;
  }
  if (cmd === "campaign" && sub === "source-sync") {
    const r = syncSource(sourceConfig(env));
    print(f.json ? r : formatSyncResult(r));
    return r.status === "refused" ? 1 : 0;
  }
  if (cmd === "campaign" && sub === "update") {
    const id = args._[2];
    if (!id) throw new Error("campaign update <campaign-id>");
    const r = updateCampaign(id, { env, workspacesRoot: f["workspaces-root"] });
    print(f.json ? r : r.ok ? r.message : `campaign update failed at stage '${r.stage}': ${r.message}`);
    return r.ok ? 0 : 1;
  }
  if (cmd === "campaign") throw new Error("campaign install|source-sync|update");
  if (cmd === "lint-generic") {
    const denylist = f.denylist || path.join(HARNESS_ROOT, "test", "fixtures", "campaign-generic", "denylist.txt");
    const roots = ["src", "prompts", "schemas", "config", "docs", "bin", "scripts"].map((d) => path.join(HARNESS_ROOT, d));
    const r = scanGenericTree(roots, denylist);
    print(r.ok ? `generic tree clean (${r.tokens} denylist tokens checked)` : r.hits.map((h) => `${h.file}:${h.line}: contains '${h.token}'`).join("\n"));
    return r.ok ? 0 : 1;
  }

  const campaignDir = need(f, "campaign");
  const h = createHarness(campaignDir, { env });
  const transport = f.transport || "cli";

  switch (cmd) {
    case "turn": {
      const text = f.stdin ? readStdin() : f.text;
      if (!text || !String(text).trim()) throw new Error("no input text (--text or --stdin)");
      const t = new TextTransport(h, { name: transport });
      const showStop = f["show-stop"] ? true : f["hide-stop"] ? false : null;
      if (transport === "discord") {
        const res = await h.runner.run({ text: String(text).trim(), eventId: f["event-id"], transport, player: f.player, showStop });
        print(res.output); return res.failed ? 2 : 0;
      }
      const res = await t.handle(String(text).trim(), { eventId: f["event-id"], player: f.player, showStop });
      print(res.text); return res.failed ? 2 : 0;
    }
    case "command": {
      const line = (args.rest || []).join(" ") || f.line;
      if (!line) throw new Error("no command (use -- /status)");
      const r = await routeCommand(line, h, { transport, eventId: f["event-id"], player: f.player });
      print(r.handled ? r.text : "not a command"); return 0;
    }
    case "discord": {
      const raw = f.event === "-" || !f.event ? JSON.parse(readStdin()) : readJson(f.event);
      const d = new DiscordTransport(h);
      const r = await d.handleInbound(raw);
      print(r); return r.refused ? 3 : 0;
    }
    case "deliver": {
      const ids = [].concat(f["message-id"] || []).filter(Boolean);
      const t = h.runner.markDelivered(need(f, "turn"), { transport, messageIds: ids });
      print(`delivered ${t.turn_id} (attempt ${t.delivery.attempts})`); return 0;
    }
    case "pending": { print(h.runner.undelivered().map((t) => ({ turn_id: t.turn_id, revision: t.revision_committed, output: t.output }))); return 0; }
    case "status": { const r = await routeCommand("/status", h, { transport }); print(r.text); return 0; }
    case "context": { const r = await routeCommand(`/context ${sub || "director"} ${(args.rest || []).join(" ")}`.trim(), h, { transport }); print(r.text); return 0; }
    case "validate": { const r = validateCampaign(h.store); print(r.ok ? `valid (${JSON.stringify(r.counts)})` : `PROBLEMS:\n- ${r.problems.join("\n- ")}`); return r.ok ? 0 : 1; }
    case "reconstruct-check": { const r = reconstructCheck(h.store, h.sessions); print(r); return r.ok ? 0 : 1; }
    case "repair-lock": { const r = repairLock(h.store, { force: Boolean(f.force) }); print(r.message); return r.released ? 0 : 1; }
    case "export-state": { print(exportState(h.store, need(f, "out"))); return 0; }
    case "import-state": { print(importState(h.store, need(f, "in"), { confirm: f.confirm })); return 0; }
    case "dry-run-save": { const d = dryRunSave(h.store, { at: h.clock.iso() }); print({ save_id: d.packet.save_id, turns: d.turns, facts: d.facts, events: d.events, bytes: d.size, expect: d.packet.expect }); return 0; }
    case "test-adapter": { if (!h.adapter) { print("no persistence adapter configured"); return 1; } const r = await h.adapter.health(); print(r); return r.ok ? 0 : 1; }
    case "smoke-test": {
      const t = new TextTransport(h, { name: "cli" });
      const before = h.store.meta().revision;
      const res = await t.handle(f.text || "The player character looks around and waits.", { eventId: `smoke:${Date.now()}` });
      print({ ok: !res.failed, revision_before: before, revision_after: h.store.meta().revision, output: res.text });
      return res.failed ? 2 : 0;
    }
    case "setup-openclaw": {
      const cfg = openclawConfigFor(h.store, { rpBin: f["rp-bin"], workspacesRoot: f["workspaces-root"] });
      const written = writeWorkspaces(h.store, { workspacesRoot: f["workspaces-root"], transport: h.store.manifest.discord?.channel_id ? "discord" : "openclaw-ui" });
      const results = await applyConfig(cfg, { dryRun: Boolean(f["dry-run"]), log: (l) => process.stdout.write(`${l}\n`) });
      print({ workspaces: written, ops: results.length, approvals: results.approvals.map((a) => ({ agent: a.agentId, pattern: a.pattern, ok: a.dryRun ? "dry-run" : a.code === 0 })), dry_run: Boolean(f["dry-run"]), agents: Object.keys(cfg.agents.entries), bindings: cfg.bindings.length });
      for (const i of results.instructions) process.stdout.write(`\nACTION REQUIRED: ${i}\n`);
      return results.instructions.length ? 4 : 0;
    }
    case "sillytavern": {
      if (sub === "import") {
        const { card, loss } = importSillyTavern(readJson(need(f, "file")), { id: f.id });
        const out = path.join(h.store.packagePath("voices"), `${card.id}.json`);
        if (exists(out) && !f.force) throw new Error(`${out} exists; use --force to overwrite`);
        writeJson(out, card);
        print({ written: out, loss }); return 0;
      }
      if (sub === "export") {
        const card = resolveVoiceCard(h.store, need(f, "voice"));
        if (!card) throw new Error(`unknown voice ${f.voice}`);
        const { card: st, loss } = exportSillyTavern(card);
        writeJson(need(f, "out"), st);
        print({ written: f.out, loss }); return 0;
      }
      throw new Error("sillytavern import|export");
    }
    default:
      throw new Error(`unknown command '${cmd}'\n${USAGE}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => process.exit(code)).catch((err) => { process.stderr.write(`rp: ${redact(err.message)}\n`); if (process.env.RP_LOG_LEVEL === "debug") process.stderr.write(`${err.stack}\n`); process.exit(1); });
}

export { configSetOps };
