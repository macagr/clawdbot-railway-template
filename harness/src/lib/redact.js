// Best-effort secret redaction for logs and debug output.
export function redact(text) {
  if (!text) return text;
  return String(text)
    .replace(/(sk-[A-Za-z0-9_-]{10,})/g, "[REDACTED]")
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 [REDACTED]")
    .replace(/\b[a-f0-9]{64}\b/g, "[REDACTED]")
    .replace(/(["']?(?:token|apiKey|api_key|password|secret|authorization)["']?\s*[:=]\s*["'])([^"'\s]{6,})(["'])/gi, "$1[REDACTED]$3");
}
