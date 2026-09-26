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
      const u = data.usage || data.meta?.usage || {};
      return {
        text,
        usage: {
          input_tokens: num(u.input ?? u.input_tokens ?? u.inputTokens ?? u.prompt_tokens),
          output_tokens: num(u.output ?? u.output_tokens ?? u.outputTokens ?? u.completion_tokens),
          cached_tokens: num(u.cached ?? u.cached_tokens ?? u.cacheRead ?? 0),
        },
        model: data.model || model || agentId,
        provider: "openclaw",
        cost_reported: typeof data.costUsd === "number" ? data.costUsd : undefined,
      };
    } finally {
      try { fs.rmSync(file, { force: true }); } catch {}
    }
  }
}

function num(v) { return Number.isFinite(v) ? v : 0; }

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

export function extractReplyText(data) {
  const payloads = data.payloads || data.result?.payloads || [];
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
