// Filesystem primitives: atomic writes, JSON helpers, directory locks.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

/** Write a file atomically: temp file in the same directory, fsync, rename. */
export function writeFileAtomic(filePath, content, { mode = 0o600 } = {}) {
  ensureDir(path.dirname(filePath));
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  const fd = fs.openSync(tmp, "w", mode);
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, filePath);
}

export function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT" && fallback !== undefined) return typeof fallback === "function" ? fallback() : fallback;
    throw new Error(`readJson ${filePath}: ${err.message}`);
  }
}

export function writeJson(filePath, value) {
  writeFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function readText(filePath, fallback) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT" && fallback !== undefined) return fallback;
    throw err;
  }
}

export function listFiles(dir, ext) {
  if (!exists(dir)) return [];
  return fs.readdirSync(dir).filter((f) => !ext || f.endsWith(ext)).sort();
}

export function removeFile(p) {
  try { fs.rmSync(p, { force: true }); } catch {}
}

export function copyDir(src, dest) {
  fs.cpSync(src, dest, { recursive: true });
}

/**
 * Directory-based lock (mkdir is atomic on all platforms). A lock older than staleMs is
 * considered abandoned (e.g. crash mid-turn) and is broken with a log line.
 */
export class DirLock {
  constructor(lockPath, { staleMs = 3 * 60 * 1000, now = Date.now, log = () => {} } = {}) {
    this.lockPath = lockPath;
    this.staleMs = staleMs;
    this.now = now;
    this.log = log;
    this.held = false;
  }

  acquire(owner = "rp") {
    ensureDir(path.dirname(this.lockPath));
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.mkdirSync(this.lockPath);
        writeFileAtomic(path.join(this.lockPath, "owner.json"), JSON.stringify({ owner, pid: process.pid, at: this.now() }));
        this.held = true;
        return true;
      } catch (err) {
        if (err.code !== "EEXIST") throw err;
        const info = readJson(path.join(this.lockPath, "owner.json"), { at: 0 });
        if (this.now() - (info.at || 0) > this.staleMs) {
          this.log(`[lock] breaking stale lock held by ${info.owner || "?"} pid=${info.pid || "?"}`);
          fs.rmSync(this.lockPath, { recursive: true, force: true });
          continue;
        }
        return false;
      }
    }
    return false;
  }

  release() {
    if (!this.held) return;
    fs.rmSync(this.lockPath, { recursive: true, force: true });
    this.held = false;
  }

  static forceRelease(lockPath) {
    fs.rmSync(lockPath, { recursive: true, force: true });
  }

  static info(lockPath) {
    if (!exists(lockPath)) return null;
    return readJson(path.join(lockPath, "owner.json"), {});
  }
}
