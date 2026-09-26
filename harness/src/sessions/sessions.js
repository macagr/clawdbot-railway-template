// Specialist session keys: disposable caches. A reset just mints a new key; nothing canonical
// lives in a session, so resets are always safe.
export class SessionManager {
  constructor(store, { clock }) {
    this.store = store;
    this.clock = clock;
  }

  keyFor(role) {
    const s = this.store.sessions();
    const entry = s.specialists[role];
    if (entry) return entry.session_key;
    return this.reset(role, "first-use");
  }

  reset(role, reason = "manual") {
    const s = this.store.sessions();
    const n = Object.keys(s.specialists).length + 1;
    const key = `rp:${this.store.id}:${role}:${this.clock.now().toString(36)}:${n}`;
    s.specialists[role] = { session_key: key, created_at: this.clock.iso(), turns: 0, tokens: 0 };
    this.store.saveSessions(s);
    this.store.log.info?.(`[sessions] reset ${role} (${reason})`);
    return key;
  }

  resetAll(reason) {
    const s = this.store.sessions();
    for (const role of Object.keys(s.specialists)) this.reset(role, reason);
    if (!Object.keys(s.specialists).length) this.store.saveSessions({ ...s, session_id: `s${this.clock.now().toString(36)}`, started_at: this.clock.iso() });
  }

  newPlaySession() {
    const s = this.store.sessions();
    this.store.saveSessions({ session_id: `s${this.clock.now().toString(36)}`, started_at: this.clock.iso(), specialists: {} });
    return s;
  }

  /** Record usage and reset when the campaign's token threshold is exceeded. */
  noteUsage(role, tokens) {
    const s = this.store.sessions();
    const e = s.specialists[role];
    if (!e) return;
    e.turns += 1; e.tokens += tokens;
    this.store.saveSessions(s);
    const threshold = this.store.manifest.sessions.token_threshold || 0;
    if (threshold && e.tokens > threshold) this.reset(role, `token threshold ${threshold}`);
  }

  onSceneEnd() {
    if (this.store.manifest.sessions.reset_on_scene_end) this.resetAll("scene end");
  }

  onResume() {
    if (this.store.manifest.sessions.reset_on_resume) this.resetAll("resume");
  }
}
