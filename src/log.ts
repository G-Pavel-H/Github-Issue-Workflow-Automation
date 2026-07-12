/**
 * Minimal structured logger shape. Compatible with Probot's pino logger
 * (`log.info(obj, msg)`), so we can pass `probot.log` directly while keeping our
 * own modules decoupled from Probot's types.
 */
export interface Logger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/**
 * A minimal structured console logger. Used as the process-wide logger for our own
 * modules (gateway, worker, app) because `probot.log` is `null` under the Probot
 * version we run — passing it through crashes on the first `log.info`. Probot keeps
 * doing its own internal logging; this only backs Tsukinome's `Logger` calls.
 */
export function createConsoleLogger(): Logger {
  const emit =
    (level: 'info' | 'warn' | 'error') =>
    (obj: unknown, msg?: string): void => {
      const base = { level, time: new Date().toISOString(), msg };
      const record =
        obj && typeof obj === 'object' ? { ...base, ...(obj as object) } : { ...base, obj };
      const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
      sink(JSON.stringify(record));
    };
  return { info: emit('info'), warn: emit('warn'), error: emit('error') };
}
