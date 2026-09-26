import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFileAtomic, readJson, writeJson, DirLock } from "../src/lib/fsx.js";

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "rp-fsx-")); }

test("writeFileAtomic leaves no temp files and replaces content", () => {
  const d = tmp();
  const f = path.join(d, "a.json");
  writeJson(f, { v: 1 });
  writeJson(f, { v: 2 });
  assert.deepEqual(readJson(f), { v: 2 });
  assert.deepEqual(fs.readdirSync(d), ["a.json"]);
});

test("readJson fallback only on ENOENT; corrupt JSON throws with path", () => {
  const d = tmp();
  assert.deepEqual(readJson(path.join(d, "missing.json"), { x: 1 }), { x: 1 });
  fs.writeFileSync(path.join(d, "bad.json"), "{ nope");
  assert.throws(() => readJson(path.join(d, "bad.json"), {}), /bad\.json/);
});

test("DirLock: exclusive, stale lock is broken, release works", () => {
  const d = tmp();
  let t = 1000;
  const now = () => t;
  const a = new DirLock(path.join(d, ".lock"), { now, staleMs: 500 });
  const b = new DirLock(path.join(d, ".lock"), { now, staleMs: 500 });
  assert.equal(a.acquire("a"), true);
  assert.equal(b.acquire("b"), false);
  t += 600;
  assert.equal(b.acquire("b"), true, "stale lock should be broken");
  b.release();
  assert.equal(a.acquire("a"), true);
  writeFileAtomic(path.join(d, "x"), "x");
});
