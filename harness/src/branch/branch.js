// Branching: a branch is a copy of state/ and runtime/ under branches/<id>/ with its own
// provisional revisions. Main canon is untouched until an explicit promote.
import fs from "node:fs";
import path from "node:path";
import { ensureDir, exists, readJson, writeJson, copyDir, listFiles } from "../lib/fsx.js";
import { schemas } from "../lib/schema.js";
import { CampaignStore } from "../state/store.js";

export class BranchError extends Error {
  constructor(msg, code = "branch") { super(msg); this.name = "BranchError"; this.code = code; }
}

function branchesDir(root) { return path.join(root, "branches"); }
function activePath(root) { return path.join(root, "runtime", "active-branch.json"); }

export function listBranches(root) {
  const dir = branchesDir(root);
  if (!exists(dir)) return [];
  return fs.readdirSync(dir).filter((d) => exists(path.join(dir, d, "branch.json"))).map((d) => schemas.validate("branch", readJson(path.join(dir, d, "branch.json"))));
}

export function activeBranch(root) {
  return readJson(activePath(root), { id: null }).id;
}

export function createBranch(mainStore, { id, label, at }) {
  if (mainStore.branch) throw new BranchError(`already on branch '${mainStore.branch}'; /resume first`, "nested");
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id)) throw new BranchError(`invalid branch id '${id}'`, "id");
  const dir = path.join(branchesDir(mainStore.root), id);
  if (exists(dir)) throw new BranchError(`branch '${id}' already exists`, "exists");
  ensureDir(dir);
  copyDir(mainStore.stateRoot, path.join(dir, "state"));
  copyDir(mainStore.runtimeRoot, path.join(dir, "runtime"));
  fs.rmSync(path.join(dir, "runtime", ".lock"), { recursive: true, force: true });
  fs.rmSync(path.join(dir, "runtime", "active-branch.json"), { force: true });
  const meta = schemas.validate("branch", { id, ...(label ? { label } : {}), base_revision: mainStore.meta().revision, created_at: at, status: "active" });
  writeJson(path.join(dir, "branch.json"), meta);
  writeJson(activePath(mainStore.root), { id });
  return meta;
}

export function switchToMain(root) {
  writeJson(activePath(root), { id: null });
}

export function discardBranch(root, id, { confirm }) {
  if (confirm !== id) throw new BranchError(`discard requires confirmation: /branch discard ${id} ${id}`, "confirm");
  const dir = path.join(branchesDir(root), id);
  if (!exists(dir)) throw new BranchError(`unknown branch '${id}'`, "unknown");
  const meta = readJson(path.join(dir, "branch.json"));
  fs.rmSync(path.join(dir, "state"), { recursive: true, force: true });
  fs.rmSync(path.join(dir, "runtime"), { recursive: true, force: true });
  writeJson(path.join(dir, "branch.json"), { ...meta, status: "discarded" });
  if (activeBranch(root) === id) switchToMain(root);
  return { ...meta, status: "discarded" };
}

export function exportBranch(root, id, { at }) {
  const dir = path.join(branchesDir(root), id);
  if (!exists(dir)) throw new BranchError(`unknown branch '${id}'`, "unknown");
  const meta = readJson(path.join(dir, "branch.json"));
  const turnsDir = path.join(dir, "runtime", "turns");
  const bundle = {
    branch: meta, exported_at: at,
    state: Object.fromEntries(listFiles(path.join(dir, "state"), ".json").map((f) => [f.replace(/\.json$/, ""), readJson(path.join(dir, "state", f))])),
    minds: listFiles(path.join(dir, "state", "minds"), ".json").map((f) => readJson(path.join(dir, "state", "minds", f))),
    turns: listFiles(turnsDir, ".json").map((f) => readJson(path.join(turnsDir, f))),
  };
  const out = path.join(dir, `export-${at.replace(/[:.]/g, "-")}.json`);
  writeJson(out, bundle);
  writeJson(path.join(dir, "branch.json"), { ...meta, status: meta.status === "active" ? "exported" : meta.status });
  return { path: out, turns: bundle.turns.length };
}

/**
 * Promote: replace main state/runtime with the branch's, only if main has not advanced past
 * the branch base revision. Explicit confirmation required.
 */
export function promoteBranch(root, id, { confirm, clock }) {
  if (confirm !== id) throw new BranchError(`promote requires confirmation: /branch promote ${id} ${id}`, "confirm");
  const dir = path.join(branchesDir(root), id);
  if (!exists(dir)) throw new BranchError(`unknown branch '${id}'`, "unknown");
  const meta = readJson(path.join(dir, "branch.json"));
  if (meta.status !== "active" && meta.status !== "exported") throw new BranchError(`branch '${id}' is ${meta.status}`, "status");
  switchToMain(root);
  const main = new CampaignStore(root, { clock });
  if (main.meta().revision !== meta.base_revision) throw new BranchError(`main advanced to revision ${main.meta().revision} since branch base ${meta.base_revision}; cannot promote`, "diverged");
  const backup = path.join(branchesDir(root), `_pre-promote-${id}-${Date.now().toString(36)}`);
  ensureDir(backup);
  copyDir(main.stateRoot, path.join(backup, "state"));
  copyDir(main.runtimeRoot, path.join(backup, "runtime"));
  fs.rmSync(main.stateRoot, { recursive: true, force: true });
  copyDir(path.join(dir, "state"), main.stateRoot);
  for (const f of ["dirty.json", "form-ledger.json", "recent-play.md", "event-index.json", "usage.json"]) {
    const src = path.join(dir, "runtime", f);
    if (exists(src)) fs.copyFileSync(src, path.join(main.runtimeRoot, f));
  }
  ensureDir(path.join(main.runtimeRoot, "turns"));
  for (const f of listFiles(path.join(dir, "runtime", "turns"), ".json")) fs.copyFileSync(path.join(dir, "runtime", "turns", f), path.join(main.runtimeRoot, "turns", f));
  writeJson(path.join(dir, "branch.json"), { ...meta, status: "promoted" });
  writeJson(path.join(main.stateRoot, "meta.json"), { ...readJson(path.join(main.stateRoot, "meta.json")), branch: null });
  return { ...meta, status: "promoted", backup };
}
