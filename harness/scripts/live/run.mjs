#!/usr/bin/env node
// Live test scenarios against real models / a running OpenClaw gateway. Uses a disposable
// copy of the generic fixture campaign. Never point this at a real campaign.
//
//   RP_LIVE_MODELS='{"director":"openrouter/<STRONG_MODEL>","novelist":"openrouter/<PROSE_MODEL>",...}' \
//   node harness/scripts/live/run.mjs specialists|reconstruction|editor|branch|persistence-local|webhook-mock|discord
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHarness } from "../../src/app.js";
import { TextTransport } from "../../src/transport/text.js";
import { routeCommand } from "../../src/commands/router.js";
import { reconstructCheck } from "../../src/ops/tools.js";
import { LocalFilesystemPersistenceAdapter } from "../../src/persistence/local.js";
import { WebhookPersistenceAdapter } from "../../src/persistence/webhook.js";
import { performSave } from "../../src/persistence/save.js";
import { performSync as doSync } from "../../src/persistence/sync.js";
import { CampaignStore } from "../../src/state/store.js";

const FIXTURE = fileURLToPath(new URL("../../test/fixtures/campaign-generic/", import.meta.url));
const scenario = process.argv[2];
if (!scenario) { console.error("usage: run.mjs <specialists|reconstruction|editor|branch|persistence-local|webhook-mock|discord>"); process.exit(1); }

function makeCampaign({ editorAll = false, presentation } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rp-live-"));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  const m = JSON.parse(fs.readFileSync(path.join(dir, "campaign.json"), "utf8"));
  const models = JSON.parse(process.env.RP_LIVE_MODELS || "{}");
  for (const [role, ref] of Object.entries(models)) m.roles[role] = { ...(m.roles[role] || {}), model: ref };
  if (Object.keys(models).length === 0 && scenario !== "webhook-mock" && scenario !== "persistence-local" && scenario !== "discord") {
    console.error("RP_LIVE_MODELS is required for this scenario (role -> model ref)."); process.exit(1);
  }
  if (editorAll) m.editor = { ...m.editor, when: "all" };
  m.save = { ...m.save, adapter: "none" };
  m.budget = { per_turn: 2, per_day: 10, per_month: 50 };
  fs.writeFileSync(path.join(dir, "campaign.json"), JSON.stringify(m, null, 2));
  CampaignStore.init(dir);
  if (presentation) { const s = new CampaignStore(dir); s.commit({ "state/scene.json": { ...s.scene(), presentation, presentation_forced: true } }); }
  return dir;
}

function show(label, v) { console.log(`\n=== ${label} ===\n${typeof v === "string" ? v : JSON.stringify(v, null, 2)}`); }

async function turn(h, text, eventId) {
  const t = new TextTransport(h, { name: "cli" });
  const r = await t.handle(text, { eventId });
  const rec = h.store.turn(r.turn_id);
  show(`turn ${r.turn_id} [${rec?.status}]`, r.text);
  if (rec?.validation) show("validation", { errors: rec.validation.errors, warnings: rec.validation.warnings, speakers: rec.validation.speakers, words: rec.validation.words });
  if (rec?.editor) show("editor", rec.editor.notes);
  show("cost", h.store.usage().totals);
  return r;
}

const scenarios = {
  async specialists() {
    const h = createHarness(makeCampaign());
    const r = await turn(h, "The player character finishes the task at hand and waits for <NPC_A>.", "live-1");
    process.exit(r.failed ? 2 : 0);
  },
  async reconstruction() {
    const h = createHarness(makeCampaign());
    await turn(h, "The player character looks over the object once more.", "live-1");
    h.sessions.resetAll("live reconstruction");
    show("sessions after wipe", h.store.sessions());
    const r = await turn(h, "The player character asks <NPC_A> what the marking means.", "live-2");
    show("reconstruct-check", reconstructCheck(h.store, h.sessions));
    process.exit(r.failed ? 2 : 0);
  },
  async editor() {
    const h = createHarness(makeCampaign({ editorAll: true, presentation: "scene" }));
    const r = await turn(h, "The player character answers with a shrug and says nothing.", "live-1");
    process.exit(r.failed ? 2 : 0);
  },
  async branch() {
    const h = createHarness(makeCampaign());
    await turn(h, "The player character waits.", "live-1");
    show("branch create", (await routeCommand("/branch create alt live branch", h)).text);
    await turn(h, "In the branch: the player character leaves through the side door.", "live-2");
    show("branch list", (await routeCommand("/branch list", h)).text);
    show("resume (back to main)", (await routeCommand("/resume", h)).text);
    show("main revision", h.store.meta().revision);
    show("discard", (await routeCommand("/branch discard alt alt", h)).text);
    process.exit(0);
  },
  async "persistence-local"() {
    const dir = makeCampaign();
    const responses = path.join(dir, "fake.json");
    const { directorPacket, NOVELIST_PROSE, EDITOR_OK } = await import("../../test/fixtures/packets.js");
    fs.writeFileSync(responses, JSON.stringify({ director: [directorPacket(), directorPacket({ fact_proposals: [], knowledge_events: [], mind_deltas: [] })], novelist: [NOVELIST_PROSE, NOVELIST_PROSE], editor: [EDITOR_OK, EDITOR_OK] }));
    const adapter = new LocalFilesystemPersistenceAdapter({ dir: path.join(dir, "persistence") });
    const h = createHarness(dir, { env: { ...process.env, RP_FAKE_RESPONSES: responses }, persistence: adapter });
    adapter.seedFrom(h.store);
    await turn(h, "one", "live-1");
    show("save", await performSave(h.store, adapter, { at: h.clock.iso() }));
    fs.appendFileSync(path.join(dir, "persistence", "canon", "operational_canon.md"), "\n\nremote edit\n");
    const meta = adapter.meta(); fs.writeFileSync(adapter.metaPath(), JSON.stringify({ ...meta, canon_revision: meta.canon_revision + 1 }));
    await turn(h, "two", "live-2");
    show("sync (conflict expected)", await doSync(h.store, adapter, { at: h.clock.iso() }));
    show("sync --stash", await doSync(h.store, adapter, { at: h.clock.iso(), mode: "stash" }));
    process.exit(0);
  },
  async "webhook-mock"() {
    const dir = makeCampaign();
    const responses = path.join(dir, "fake.json");
    const { directorPacket, NOVELIST_PROSE, EDITOR_OK } = await import("../../test/fixtures/packets.js");
    fs.writeFileSync(responses, JSON.stringify({ director: [directorPacket(), directorPacket({ fact_proposals: [], knowledge_events: [], mind_deltas: [] })], novelist: [NOVELIST_PROSE, NOVELIST_PROSE], editor: [EDITOR_OK, EDITOR_OK] }));
    const ledger = new Map(); let canonRev = 0; let failOnce = true;
    const server = http.createServer((req, res) => {
      const auth = req.headers.authorization === "Bearer live-token";
      if (!auth) { res.writeHead(401); return res.end("{}"); }
      if (req.method === "GET") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(req.url.includes("revision_only") ? { canon_revision: canonRev } : { campaign: "campaign_fixture", canon_revision: canonRev, files: { operational_canon: "mock canon" } })); }
      let body = ""; req.on("data", (d) => (body += d)); req.on("end", () => {
        const p = JSON.parse(body);
        let result;
        if (ledger.has(p.save_id)) result = { ...ledger.get(p.save_id), status: "duplicate" };
        else if (String(p.expect.canon_revision ?? "") !== "" && String(p.expect.canon_revision) !== String(canonRev)) result = { save_id: p.save_id, status: "rejected", applied: [], failed: [{ target: "expect", error: "mismatch" }], canon_revision: canonRev };
        else if (failOnce) { failOnce = false; result = { save_id: p.save_id, status: "partial", applied: ["state.facts"], failed: [{ target: "chronicle", error: "mock outage" }], canon_revision: canonRev }; }
        else { canonRev++; result = { save_id: p.save_id, status: "ok", applied: ["state", "chronicle"], failed: [], canon_revision: canonRev }; ledger.set(p.save_id, result); }
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(result));
      });
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${server.address().port}`;
    const env = { ...process.env, RP_FAKE_RESPONSES: responses, RP_SAVE_URL: `${url}/rp/save`, RP_SYNC_URL: `${url}/rp/canon`, RP_SAVE_TOKEN: "live-token" };
    const adapter = new WebhookPersistenceAdapter({ campaignId: "campaign_fixture", endpointEnv: "RP_SAVE_URL", tokenEnv: "RP_SAVE_TOKEN", syncEndpointEnv: "RP_SYNC_URL", env, retries: 1, sleep: async () => {} });
    const h = createHarness(dir, { env, persistence: adapter });
    show("health", await adapter.health());
    await turn(h, "one", "live-1");
    show("save #1 (partial expected)", (await performSave(h.store, adapter, { at: h.clock.iso() })).status);
    show("save #2 (ok expected, same save_id)", (await performSave(h.store, adapter, { at: h.clock.iso() })).status);
    await turn(h, "two", "live-2");
    canonRev++; // external change
    show("save #3 (rejected expected)", (await performSave(h.store, adapter, { at: h.clock.iso() })).status);
    show("sync (conflict expected)", (await doSync(h.store, adapter, { at: h.clock.iso() })).action);
    server.close();
    process.exit(0);
  },
  async discord() {
    console.log(`Discord transport smoke test (manual):
1. Fill campaign.json → discord (guild_id, channel_id, user_ids) in a disposable campaign copy and run: rp setup-openclaw --campaign <dir>
2. Restart the gateway; check: openclaw agents list --bindings ; openclaw channels status --probe
3. In the bound channel send: !status   → the coordinator must run 'rp command' and relay the status text.
   (Do not use /status in Discord: "/" is OpenClaw's native slash-command namespace and OpenClaw answers it itself.)
4. Send a play message; the coordinator runs 'rp turn --transport discord --event-id <message id>' and posts the prose.
5. Verify: rp pending --campaign <dir> lists the turn until 'rp deliver' is run by the coordinator; re-sending the same message id must not create a new revision.
Sample event for 'rp discord --event -':
${JSON.stringify({ message_id: "<discord message id>", channel_id: "<channel id>", guild_id: "<guild id>", user_id: "<user id>", text: "The player character waits." }, null, 2)}`);
    process.exit(0);
  },
};

if (!scenarios[scenario]) { console.error(`unknown scenario ${scenario}`); process.exit(1); }
scenarios[scenario]().catch((err) => { console.error(err.stack || err.message); process.exit(1); });
