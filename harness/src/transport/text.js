// Text transports (CLI, OpenClaw UI, tests): one message in, one text out. Delivery is
// immediate, so the turn is marked delivered as soon as the output is returned.
import { routeCommand, isCommand } from "../commands/router.js";

export class TextTransport {
  constructor(deps, { name = "cli" } = {}) { this.deps = deps; this.name = name; }

  async handle(text, { eventId, player } = {}) {
    if (isCommand(text)) {
      const r = await routeCommand(text, this.deps, { transport: this.name, eventId, player });
      return { text: r.text, command: true };
    }
    const res = await this.deps.runner.run({ text, eventId, transport: this.name, player });
    if (res.turn && (res.turn.status === "committed")) this.deps.runner.markDelivered(res.turn.turn_id, { transport: this.name });
    return { text: res.output, turn_id: res.turn?.turn_id, failed: Boolean(res.failed), reused: Boolean(res.reused) };
  }
}
