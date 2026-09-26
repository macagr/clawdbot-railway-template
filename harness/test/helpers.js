// Shared test helpers: copy the generic fixture campaign into a temp dir and open a store.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CampaignStore } from "../src/state/store.js";
import { fixedClock } from "../src/lib/clock.js";

export const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/campaign-generic/", import.meta.url));
export const HARNESS_ROOT = fileURLToPath(new URL("../", import.meta.url));

export function tempCampaign({ seed = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rp-campaign-"));
  fs.cpSync(FIXTURE_DIR, dir, { recursive: true });
  const clock = fixedClock();
  const store = CampaignStore.init(dir, { clock, seed });
  return { dir, store, clock, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
