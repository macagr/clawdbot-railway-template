// PersistenceAdapter contract. The harness never knows which backend is behind it.
//
//   getRemoteRevision()            -> { canon_revision } | throws PersistenceError
//   pullCanon()                    -> sync-manifest (files by canon role, optional state)
//   save(packet)                   -> save-result (ok | partial | rejected | duplicate | error)
//   health()                       -> { ok, message }
import { schemas } from "../lib/schema.js";

export class PersistenceError extends Error {
  constructor(msg, { code = "persistence", retryable = false, cause } = {}) { super(msg); this.name = "PersistenceError"; this.code = code; this.retryable = retryable; if (cause) this.cause = cause; }
}

export function assertSaveResult(result) {
  return schemas.validate("save-result", result);
}

export function assertSyncManifest(manifest) {
  return schemas.validate("sync-manifest", manifest);
}

export class NoopPersistenceAdapter {
  async getRemoteRevision() { throw new PersistenceError("no persistence adapter configured (save.adapter = none)", { code: "no-adapter" }); }
  async pullCanon() { throw new PersistenceError("no persistence adapter configured (save.adapter = none)", { code: "no-adapter" }); }
  async save() { throw new PersistenceError("no persistence adapter configured (save.adapter = none)", { code: "no-adapter" }); }
  async health() { return { ok: false, message: "no adapter" }; }
}
