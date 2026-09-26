// Tiny structured logger. Never logs secrets (callers pass redacted values).
export function makeLogger({ stream = process.stderr, level = process.env.RP_LOG_LEVEL || "info", prefix = "rp" } = {}) {
  const levels = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
  const min = levels[level] ?? 20;
  const emit = (lvl, msg, data) => {
    if (levels[lvl] < min) return;
    const line = data === undefined ? `[${prefix}] ${lvl}: ${msg}` : `[${prefix}] ${lvl}: ${msg} ${safeJson(data)}`;
    stream.write(`${line}\n`);
  };
  return {
    debug: (m, d) => emit("debug", m, d),
    info: (m, d) => emit("info", m, d),
    warn: (m, d) => emit("warn", m, d),
    error: (m, d) => emit("error", m, d),
    child: (p) => makeLogger({ stream, level, prefix: `${prefix}:${p}` }),
  };
}

function safeJson(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

export const silentLogger = makeLogger({ level: "silent" });
