/**
 * Structured logging (brief §39, doc §32.2).
 *
 * One event per line, JSON, parseable without regex. Every line of a request carries
 * the same correlation_id, and that id is shared with the audit record for the request
 * — which is what lets an incident move between the two stores.
 *
 * What a log line MUST carry: timestamp, level, service, correlation_id, principal_id
 * where authenticated, operation, duration, outcome, error code.
 * What it must NEVER carry is enforced in redaction.ts, not left to discipline.
 */
import { pino, type Logger as PinoLogger } from 'pino';
import { redact, redactValueText } from './redaction.js';

export type LogLevel = 'error' | 'warn' | 'info' | 'debug';

export interface LogContext {
  readonly correlationId?: string;
  readonly principalId?: string;
  readonly operation?: string;
  readonly durationMs?: number;
  readonly outcome?: 'SUCCEEDED' | 'REFUSED' | 'FAILED';
  readonly errorCode?: string;
  readonly [key: string]: unknown;
}

export interface Logger {
  error(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  debug(message: string, context?: LogContext): void;
  /** Returns a logger that stamps the given context onto every subsequent line. */
  child(context: LogContext): Logger;
}

export interface LoggerOptions {
  readonly service: string;
  readonly level?: LogLevel;
  /** Test seam: receives each already-redacted line. */
  readonly sink?: (line: Record<string, unknown>) => void;
}

class StarlinkLogger implements Logger {
  constructor(
    private readonly pinoLogger: PinoLogger,
    private readonly bound: LogContext,
    private readonly sink?: (line: Record<string, unknown>) => void,
  ) {}

  private emit(level: LogLevel, message: string, context?: LogContext): void {
    // Redaction happens here — once, centrally — so that no call site can opt out of
    // it by passing an unusual shape.
    const merged = redact({ ...this.bound, ...context }) as Record<string, unknown>;
    /**
     * The MESSAGE is scrubbed as well as the context.
     *
     * `redact` was applied to the merged context only and the message string went to pino
     * verbatim, so one idiomatic interpolated line would put a contact detail into a log
     * aggregator whose access list is far wider than the message store's. Every current
     * call site uses a static message with the data in the context object, so this was
     * latent rather than leaking — and nothing enforced that it stayed so.
     *
     * Value patterns only. The key rule cannot help here, because a message has no keys, so
     * this is the second layer working alone — which is why it errs toward over-redaction.
     */
    const safeMessage = redactValueText(message);
    if (this.sink !== undefined) {
      this.sink({ level, msg: safeMessage, ...merged });
      return;
    }
    this.pinoLogger[level](merged, safeMessage);
  }

  error(message: string, context?: LogContext): void {
    this.emit('error', message, context);
  }
  warn(message: string, context?: LogContext): void {
    this.emit('warn', message, context);
  }
  info(message: string, context?: LogContext): void {
    this.emit('info', message, context);
  }
  debug(message: string, context?: LogContext): void {
    this.emit('debug', message, context);
  }

  child(context: LogContext): Logger {
    return new StarlinkLogger(this.pinoLogger, { ...this.bound, ...context }, this.sink);
  }
}

export function createLogger(options: LoggerOptions): Logger {
  const instance = pino({
    level: options.level ?? 'info',
    base: { service: options.service },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
  });
  return new StarlinkLogger(instance, {}, options.sink);
}
