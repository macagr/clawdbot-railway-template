// Discord transport helpers. OpenClaw performs the actual Discord I/O; the harness sees a
// normalized inbound event and produces reply chunks. This module never touches canon.
import { routeCommand, isCommand } from "../commands/router.js";

export const DISCORD_LIMIT = 2000;

/** Normalize whatever the coordinator passes: { message_id, channel_id, guild_id, user_id, thread_id?, text } */
export function normalizeDiscordEvent(raw) {
  const e = {
    message_id: String(raw.message_id ?? raw.id ?? ""),
    channel_id: String(raw.channel_id ?? ""),
    guild_id: raw.guild_id ? String(raw.guild_id) : null,
    user_id: String(raw.user_id ?? raw.author_id ?? ""),
    thread_id: raw.thread_id ? String(raw.thread_id) : null,
    text: String(raw.text ?? raw.content ?? ""),
  };
  if (!e.message_id) throw new Error("discord event has no message id (required for dedup)");
  return e;
}

/** Allowlist checks against the campaign manifest. Returns { ok, reason }. */
export function authorizeDiscordEvent(manifest, e) {
  const d = manifest.discord || {};
  if (d.guild_id && e.guild_id && e.guild_id !== d.guild_id) return { ok: false, reason: "guild not bound to this campaign" };
  if (d.channel_id && e.channel_id !== d.channel_id && e.thread_id === null) return { ok: false, reason: "channel not bound to this campaign" };
  const users = d.user_ids?.length ? d.user_ids : manifest.player.user_ids || [];
  if (users.length && !users.includes(e.user_id)) return { ok: false, reason: "user not allowlisted" };
  if (e.thread_id) {
    const policy = d.threads || "off";
    if (policy === "off") return { ok: false, reason: "threads are disabled for this campaign" };
  }
  return { ok: true };
}

/** Split output into Discord-sized chunks on paragraph, then sentence, boundaries. */
export function chunkForDiscord(text, limit = DISCORD_LIMIT) {
  const out = [];
  let cur = "";
  const push = () => { if (cur.trim()) out.push(cur.trimEnd()); cur = ""; };
  for (const para of String(text).split(/\n{2,}/)) {
    if ((cur + "\n\n" + para).length <= limit) { cur = cur ? `${cur}\n\n${para}` : para; continue; }
    push();
    if (para.length <= limit) { cur = para; continue; }
    let rest = para;
    while (rest.length > limit) {
      let cut = rest.lastIndexOf(". ", limit - 1);
      if (cut < limit / 2) cut = rest.lastIndexOf(" ", limit - 1);
      if (cut < limit / 2) cut = limit - 1;
      out.push(rest.slice(0, cut + 1).trimEnd());
      rest = rest.slice(cut + 1).trimStart();
    }
    cur = rest;
  }
  push();
  return out;
}

export class DiscordTransport {
  constructor(deps) { this.deps = deps; }

  /**
   * Handle one inbound Discord message. Returns { chunks, turn_id?, refused? }.
   * The caller (coordinator) posts the chunks and then calls confirmDelivery with message ids.
   */
  async handleInbound(raw) {
    const e = normalizeDiscordEvent(raw);
    const auth = authorizeDiscordEvent(this.deps.store.manifest, e);
    if (!auth.ok) return { refused: true, reason: auth.reason, chunks: [] };
    const eventId = `discord:${e.message_id}`;
    if (isCommand(e.text)) {
      const r = await routeCommand(e.text, this.deps, { transport: "discord", eventId, player: e.user_id });
      return { chunks: chunkForDiscord(r.text || ""), command: true };
    }
    if (e.thread_id && (this.deps.store.manifest.discord?.threads || "off") === "branches_on_request") {
      // A thread never creates a branch by itself; the player must /branch create explicitly.
      return { chunks: chunkForDiscord("Threads only host branches here. Run `/branch create <id>` in this thread first, then play."), refused: true, reason: "thread without branch" };
    }
    const res = await this.deps.runner.run({ text: e.text, eventId, transport: "discord", player: e.user_id });
    return { chunks: chunkForDiscord(res.output || ""), turn_id: res.turn?.turn_id, reused: Boolean(res.reused), failed: Boolean(res.failed) };
  }

  confirmDelivery(turnId, messageIds) {
    return this.deps.runner.markDelivered(turnId, { transport: "discord", messageIds });
  }

  /** Committed-but-undelivered turns as chunk lists, oldest first. */
  pendingDeliveries() {
    return this.deps.runner.undelivered().map((t) => ({ turn_id: t.turn_id, chunks: chunkForDiscord(t.output || "") }));
  }
}
