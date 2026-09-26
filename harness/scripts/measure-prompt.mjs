#!/usr/bin/env node
// Measure the system prompt OpenClaw assembled for an agent, from its stored transcripts.
// Usage: node /opt/rp-harness/scripts/measure-prompt.mjs <agent id> [state dir]
// Prints the largest text blob found (the system prompt), its size, and its section headings.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const agent = process.argv[2];
if (!agent) { console.error("usage: measure-prompt.mjs <agent id> [state dir]"); process.exit(1); }
const stateDir = process.argv[3] || process.env.OPENCLAW_STATE_DIR || path.join(process.env.HOME || "/root", ".openclaw");
const base = path.join(stateDir, "agents", agent);
let best = "";
const consider = (s) => { if (typeof s === "string" && s.length > best.length) best = s; };
const walk = (v, d = 0) => {
  if (d > 6 || v == null) return;
  if (typeof v === "string") { consider(v); try { walk(JSON.parse(v), d + 1); } catch {} }
  else if (typeof v === "object") for (const x of Object.values(v)) walk(x, d + 1);
};
const sessDir = path.join(base, "sessions");
if (fs.existsSync(sessDir)) {
  for (const f of fs.readdirSync(sessDir)) if (f.endsWith(".jsonl")) for (const line of fs.readFileSync(path.join(sessDir, f), "utf8").split("\n")) { try { walk(JSON.parse(line)); } catch {} }
}
const db = path.join(base, "agent", "openclaw-agent.sqlite");
if (fs.existsSync(db)) {
  const d = new DatabaseSync(db, { readOnly: true });
  for (const { name } of d.prepare("select name from sqlite_master where type='table'").all()) for (const row of d.prepare(`select * from "${name}"`).all()) walk(row);
}
if (!best) { console.error(`no transcript text found under ${base}`); process.exit(2); }
console.log(`largest text blob: ${best.length} chars (~${Math.round(best.length / 4)} tokens)`);
console.log("--- headings ---");
for (const l of best.split("\n")) if (/^#{1,3} |^<[a-z_]+>$/.test(l.trim())) console.log(l.trim().slice(0, 80));
console.log("--- first 1500 chars ---");
console.log(best.slice(0, 1500));
