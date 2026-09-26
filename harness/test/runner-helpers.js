import { tempCampaign } from "./helpers.js";
import { FakeModelAdapter } from "../src/models/adapter.js";
import { AdapterFactory, RoleCaller, loadModelsConfig } from "../src/models/registry.js";
import { TurnRunner } from "../src/orchestration/turn.js";
import { SessionManager } from "../src/sessions/sessions.js";
import { makeCounterIdGen } from "../src/lib/ids.js";
import { silentLogger } from "../src/lib/log.js";

/** A runner over a temp copy of the fixture campaign with a scripted fake model. */
export function makeRunner({ responses = {}, seed = true, manifestPatch } = {}) {
  const t = tempCampaign({ seed });
  if (manifestPatch) {
    const p = `${t.dir}/campaign.json`;
    const fs = require_fs();
    const m = JSON.parse(fs.readFileSync(p, "utf8"));
    fs.writeFileSync(p, JSON.stringify(manifestPatch(m), null, 2));
    t.store = new (t.store.constructor)(t.dir, { clock: t.clock });
  }
  const fake = new FakeModelAdapter({ responses });
  const factory = new AdapterFactory({ cfg: loadModelsConfig(t.dir), fake });
  const caller = new RoleCaller({ manifest: t.store.manifest, factory, log: silentLogger });
  const sessions = new SessionManager(t.store, { clock: t.clock });
  const runner = new TurnRunner({ store: t.store, caller, sessions, clock: t.clock, log: silentLogger, idGen: makeCounterIdGen(), rng: () => 0.42 });
  return { ...t, fake, caller, sessions, runner };
}

function require_fs() { return process.getBuiltinModule("node:fs"); }
