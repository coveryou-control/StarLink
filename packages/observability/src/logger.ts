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
import { redact } from './redaction.js';

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
    if (this.sink !== undefined) {
      this.sink({ level, msg: message, ...merged });
      return;
    }
    this.pinoLogger[level](merged, message);
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
