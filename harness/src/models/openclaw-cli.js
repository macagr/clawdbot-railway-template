// OpenClaw CLI adapter: runs a specialist as an OpenClaw agent turn through the gateway.
//   openclaw agent --agent <id> --session-key <key> --message-file <path> --json --timeout <s>
// The agent's system prompt is its workspace (AGENTS.md/SOUL.md); the harness sends the full
// task as the message (system + user text) so the call is reconstructable from files alone.
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ModelError } from "./adapter.js";

export class OpenClawCliAdapter {
  constructor({ bin = process.env.OPENCLAW_BIN || "openclaw", spawn = childProcess.spawn, env = process.env, log } = {}) {
    this.bin = bin;
    this.spawn = spawn;
    this.env = env;
    this.log = log;
  }

  async complete({ role, model, system, user, sessionKey, agentId, timeoutMs = 300000, thinking }) {
    const message = system ? `${system}\n\n---\n\n${user}` : user;
    const file = path.join(os.tmpdir(), `rp-${role}-${process.pid}-${Date.now()}.md`);
    fs.writeFileSync(file, message, { mode: 0o600 });
    const args = ["agent", "--agent", agentId, "--message-file", file, "--json", "--timeout", String(Math.ceil(timeoutMs / 1000))];
    if (sessionKey) args.push("--session-key", sessionKey);
    if (model && !model.startsWith("openclaw:")) args.push("--model", model);
    if (thinking) args.push("--thinking", thinking);
    try {
      const { code, stdout, stderr } = await run(this.spawn, this.bin, args, { env: this.env, timeoutMs: timeoutMs + 15000 });
      if (code !== 0) throw new ModelError(`openclaw agent exited ${code}: ${stderr.slice(-400)}`, { code: "cli-exit", retryable: true });
      const data = parseJsonEnvelope(stdout);
      const text = extractReplyText(data);
      if (!text) throw new ModelError("openclaw agent returned no reply text", { code: "empty", retryable: true });
      const meta = data.result?.meta || data.meta || {};
      // OpenClaw 2026.9.5 `agent --json`: result.meta.agentMeta.usage = { input, output, cacheRead,
      // cacheWrite, reasoningTokens, total, cost: { total } } (per run); lastCallUsage = last model call.
      const am = meta.agentMeta || {};
      const u = am.usage || am.lastCallUsage || data.usage || data.result?.usage || data.summary?.usage || meta.usage || meta.tokens || meta.tokenUsage || {};
      let usage = {
        input_tokens: num(u.input ?? u.input_tokens ?? u.inputTokens ?? u.prompt_tokens ?? u.promptTokens),
        output_tokens: num(u.output ?? u.output_tokens ?? u.outputTokens ?? u.completion_tokens ?? u.completionTokens),
        cached_tokens: num(u.cacheRead ?? u.cached ?? u.cached_tokens ?? u.cache_read_input_tokens ?? 0),
        cache_write_tokens: num(u.cacheWrite ?? 0),
        reasoning_tokens: num(u.reasoningTokens ?? u.reasoning_tokens ?? 0),
      };
      if (usage.input_tokens === 0 && usage.output_tokens === 0) usage = { ...usage, ...findUsage(meta) };
      const cost = [u.cost?.total, am.cost?.total, data.costUsd, meta.costUsd, meta.cost, data.result?.costUsd, data.summary?.costUsd, u.costUsd].find((c) => typeof c === "number");
      this.log?.debug?.(`[openclaw-cli] ${role}/${agentId} usage=${JSON.stringify(usage)} cost=${cost ?? "n/a"} result.meta=${JSON.stringify(data.result?.meta ?? data.meta ?? null).slice(0, 500)}`);
      return { text, usage, model: am.model || data.model || model || agentId, provider: am.provider ? `openclaw/${am.provider}` : "openclaw", cost_reported: cost };
    } finally {
      try { fs.rmSync(file, { force: true }); } catch {}
    }
  }
}

function num(v) { return Number.isFinite(v) ? v : 0; }

/** Best-effort: find input/output token counts anywhere inside an envelope meta object (depth ≤ 3). */
export function findUsage(obj, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 3) return {};
  let input = 0, output = 0, cached = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "number") {
      const key = k.toLowerCase();
      if (/(^|_)(input|prompt)(_?tokens)?$/.test(key)) input = input || v;
      else if (/(^|_)(output|completion)(_?tokens)?$/.test(key)) output = output || v;
      else if (/cache(d|_?read)/.test(key)) cached = cached || v;
    } else if (v && typeof v === "object") {
      const nested = findUsage(v, depth + 1);
      input = input || nested.input_tokens || 0; output = output || nested.output_tokens || 0; cached = cached || nested.cached_tokens || 0;
    }
  }
  return input || output ? { input_tokens: input, output_tokens: output, cached_tokens: cached } : {};
}

function parseJsonEnvelope(stdout) {
  const trimmed = stdout.trim();
  const start = trimmed.indexOf("{");
  if (start < 0) throw new ModelError("openclaw agent: no JSON in output", { code: "bad-json" });
  try { return JSON.parse(trimmed.slice(start)); } catch {
    // Some builds print log lines after the JSON; find the last balanced object.
    const end = trimmed.lastIndexOf("}");
    try { return JSON.parse(trimmed.slice(start, end + 1)); } catch (err) {
      throw new ModelError(`openclaw agent: unparseable JSON: ${err.message}`, { code: "bad-json" });
    }
  }
}

/** Exposed for tests: usage/cost extraction from a parsed `openclaw agent --json` envelope. */
export function extractUsage(data) {
  const meta = data.result?.meta || data.meta || {};
  const am = meta.agentMeta || {};
  const u = am.usage || am.lastCallUsage || {};
  return {
    input_tokens: num(u.input), output_tokens: num(u.output), cached_tokens: num(u.cacheRead),
    cache_write_tokens: num(u.cacheWrite), reasoning_tokens: num(u.reasoningTokens),
    cost: typeof u.cost?.total === "number" ? u.cost.total : undefined, model: am.model, provider: am.provider,
  };
}

export function extractReplyText(data) {
  const payloads = data.payloads || data.result?.payloads || data.summary?.payloads || [];
  const texts = payloads.map((p) => (typeof p === "string" ? p : p.text ?? p.content ?? "")).filter(Boolean);
  if (texts.length) return texts.join("\n");
  return data.text || data.reply || data.result?.text || "";
}

function run(spawn, bin, args, { env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    proc.stdout?.on("data", (d) => (stdout += d));
    proc.stderr?.on("data", (d) => (stderr += d));
    const t = setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} reject(new ModelError(`openclaw agent timed out after ${timeoutMs}ms`, { code: "timeout" })); }, timeoutMs);
    proc.on("error", (err) => { clearTimeout(t); reject(new ModelError(`spawn ${bin}: ${err.message}`, { code: "spawn", retryable: false })); });
    proc.on("close", (code) => { clearTimeout(t); resolve({ code, stdout, stderr }); });
  });
}
