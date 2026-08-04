// One JSON object per line on stdout/stderr. Railway (and every log
// aggregator worth using) parses that shape for free, whereas the
// console.log strings this replaces could only ever be read by a human
// staring at a live tail.
//
// Nothing here logs an email, a password, a raw listing, or a Stripe
// object — user identity is carried as an opaque id only.

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function currentThreshold(): number {
  const configured = process.env.LOG_LEVEL?.toLowerCase() as LogLevel | undefined;
  if (configured && configured in LEVEL_RANK) return LEVEL_RANK[configured];
  // Silent under test unless asked for — otherwise a request-per-line log
  // buries the assertion failures it sits next to.
  if (process.env.NODE_ENV === "test") return Number.POSITIVE_INFINITY;
  return process.env.NODE_ENV === "production" ? LEVEL_RANK.info : LEVEL_RANK.debug;
}

// Errors carry a stack that JSON.stringify would silently flatten to {}.
function serialize(value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

function emit(level: LogLevel, event: string, fields?: Record<string, unknown>): void {
  if (LEVEL_RANK[level] < currentThreshold()) return;

  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    event,
  };
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (value !== undefined) entry[key] = serialize(value);
  }

  const line = JSON.stringify(entry);
  if (level === "error" || level === "warn") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export const log = {
  debug: (event: string, fields?: Record<string, unknown>) => emit("debug", event, fields),
  info: (event: string, fields?: Record<string, unknown>) => emit("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => emit("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => emit("error", event, fields),
};
