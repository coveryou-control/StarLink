/**
 * Correlation identity at the edge (brief §38, doc §32.2).
 *
 * One id is generated per request and carried through logs, the outbox, jobs and the
 * audit ledger. It is generated HERE and never regenerated downstream, which is what
 * lets an incident be followed across records that live in different stores with
 * different retentions.
 *
 * An inbound correlation header is deliberately NOT trusted for anything but
 * correlation: it never influences authorization, and it is length-bounded so a
 * hostile client cannot use it to bloat every log line it touches.
 */
import { Inject, Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { newCorrelationId, withContext } from '@starlink/observability';
import { AUDIT_WRITER } from '../tokens.js';
import type { AuditWriter } from '../audit/audit-writer.js';

const HEADER = 'x-correlation-id';
const MAX_LENGTH = 64;
const SAFE = /^[A-Za-z0-9_-]+$/;

@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  constructor(@Inject(AUDIT_WRITER) private readonly audit: AuditWriter) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const inbound = request.header(HEADER);
    const correlationId =
      typeof inbound === 'string' && inbound.length <= MAX_LENGTH && SAFE.test(inbound)
        ? inbound
        : newCorrelationId();

    response.setHeader(HEADER, correlationId);
    (request as Request & { correlationId: string }).correlationId = correlationId;

    // Identifying context is written to its own store with its own retention, never
    // onto the ledger record itself (doc §31.4).
    const userAgent = request.header('user-agent');
    void this.audit.recordRequestContext({
      correlationId,
      ...(request.ip !== undefined ? { ipAddress: request.ip } : {}),
      ...(userAgent !== undefined ? { userAgent } : {}),
    });

    withContext({ correlationId }, () => next());
  }
}
