#!/usr/bin/env node
// Report the system prompt OpenClaw assembled for an agent, from the session metadata it stores
// (systemPromptReport), plus the last run's usage. Usage:
//   node /opt/rp-harness/scripts/measure-prompt.mjs <agent id> [state dir]
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const agent = process.argv[2];
if (!agent) { console.error("usage: measure-prompt.mjs <agent id> [state dir]"); process.exit(1); }
const stateDir = process.argv[3] || process.env.OPENCLAW_STATE_DIR || path.join(process.env.HOME || "/root", ".openclaw");
const base = path.join(stateDir, "agents", agent);
const reports = [];
const visit = (v, d = 0) => {
  if (d > 8 || v == null) return;
  if (typeof v === "string") { if (v.length > 200 && v.includes("systemPromptReport")) { try { visit(JSON.parse(v), d + 1); } catch {} } return; }
  if (typeof v !== "object") return;
  if (v.systemPromptReport) reports.push({ updatedAt: v.updatedAt, sessionKey: v.systemPromptReport.sessionKey, report: v.systemPromptReport, skills: v.skillsSnapshot });
  for (const x of Object.values(v)) visit(x, d + 1);
};
const sessDir = path.join(base, "sessions");
if (fs.existsSync(sessDir)) for (const f of fs.readdirSync(sessDir)) if (/\.jsonl?$/.test(f)) for (const line of fs.readFileSync(path.join(sessDir, f), "utf8").split("\n")) { try { visit(JSON.parse(line)); } catch {} }
const db = path.join(base, "agent", "openclaw-agent.sqlite");
if (fs.existsSync(db)) {
  const d = new DatabaseSync(db, { readOnly: true });
  for (const { name } of d.prepare("select name from sqlite_master where type='table'").all()) for (const row of d.prepare(`select * from "${name}"`).all()) visit(row);
}
if (!reports.length) { console.error(`no systemPromptReport found under ${base}`); process.exit(2); }
reports.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
const r = reports[0];
const sp = r.report.systemPrompt || {};
console.log(`agent: ${agent}\nsession: ${r.sessionKey}\nworkspace: ${r.report.workspaceDir}`);
console.log(`system prompt: ${sp.chars} chars (~${Math.round((sp.chars || 0) / 4)} tokens)`);
console.log(`  workspace/bootstrap files: ${sp.projectContextChars} chars`);
console.log(`  OpenClaw fixed sections:   ${sp.nonProjectContextChars} chars`);
console.log(`injected files: ${(r.report.injectedWorkspaceFiles || []).map((f) => `${f.name}${f.chars ? ` (${f.chars})` : ""}`).join(", ") || "none"}`);
console.log(`skills in prompt: ${r.skills?.skills?.length ?? "?"} (prompt chars ${r.skills?.prompt?.length ?? "?"})`);
const tools = r.report.tools || r.report.toolNames || r.report.toolList;
if (tools) console.log(`tools: ${Array.isArray(tools) ? `${tools.length} (${tools.slice(0, 12).join(", ")}${tools.length > 12 ? ", …" : ""})` : JSON.stringify(tools).slice(0, 300)}`);
else console.log("tools: not listed in report (compare cacheRead tokens against system prompt size: the difference is tool schemas)");
console.log("--- raw report keys ---");
console.log(Object.keys(r.report).join(", "));
