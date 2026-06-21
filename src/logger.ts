/**
 * stderr-only structured logger.
 *
 * IMPORTANT: with the stdio transport, stdout is the JSON-RPC channel. Anything
 * written to stdout corrupts the protocol, so all diagnostics go to stderr.
 * Never use console.log in this project.
 */

type Level = "debug" | "info" | "warn" | "error";

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

// Configurable via LOG_LEVEL; defaults to "info".
const threshold = LEVELS[(process.env.LOG_LEVEL as Level) ?? "info"] ?? LEVELS.info;

/** Keys whose values must never be logged in plain text. */
const SENSITIVE = /^(password|pass|authorization|cookie|set-cookie|access_token|bearer|x-xsrf-token)$/i;

function redact(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(redact);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE.test(k) ? "[redacted]" : redact(v);
  }
  return out;
}

function emit(level: Level, msg: string, meta?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const entry: Record<string, unknown> = { level, msg };
  if (meta && Object.keys(meta).length > 0) entry.meta = redact(meta);
  process.stderr.write(`${JSON.stringify(entry)}\n`);
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit("debug", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emit("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit("error", msg, meta),
};
