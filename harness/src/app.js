// Composition root: build a fully wired harness for a campaign directory.
import { CampaignStore } from "./state/store.js";
import { realClock } from "./lib/clock.js";
import { makeLogger } from "./lib/log.js";
import { FakeModelAdapter } from "./models/adapter.js";
import { AdapterFactory, RoleCaller, loadModelsConfig } from "./models/registry.js";
import { TurnRunner } from "./orchestration/turn.js";
import { SessionManager } from "./sessions/sessions.js";
import { createAdapter } from "./persistence/save.js";
import { readJson, exists } from "./lib/fsx.js";
import { reopenStore } from "./commands/router.js";

/**
 * options: { env, clock, log, fake (FakeModelAdapter), fetchImpl, spawn, persistence }
 * env.RP_FAKE_RESPONSES=<path to json {role: [responses]}> selects scripted fake models
 * (used by the CLI integration tests and smoke tests without any provider).
 */
export function createHarness(campaignDir, options = {}) {
  const env = options.env || process.env;
  const clock = options.clock || realClock();
  const log = options.log || makeLogger({ level: env.RP_LOG_LEVEL || "info" });
  const store = new CampaignStore(campaignDir, { clock, log });
  let fake = options.fake;
  if (!fake && env.RP_FAKE_RESPONSES && exists(env.RP_FAKE_RESPONSES)) fake = new FakeModelAdapter({ responses: readJson(env.RP_FAKE_RESPONSES) });
  const factory = new AdapterFactory({ cfg: loadModelsConfig(store.root, { env }), env, fake, fetchImpl: options.fetchImpl, spawn: options.spawn, log });
  const caller = new RoleCaller({ manifest: store.manifest, factory, clock, log });
  const sessions = new SessionManager(store, { clock });
  const runner = new TurnRunner({ store, caller, sessions, clock, log });
  const adapter = options.persistence || (store.manifest.save.adapter !== "none" ? createAdapter(store, { env, fetchImpl: options.fetchImpl }) : null);
  const deps = { store, runner, sessions, clock, caller, adapter, env, log };
  deps.reopen = () => reopenStore(deps);
  return deps;
}
