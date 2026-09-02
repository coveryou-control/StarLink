/**
 * API bootstrap.
 *
 * Configuration is validated before the server binds, so a misconfigured production
 * instance refuses to start rather than coming up and serving errors (doc §35.3).
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { installProcessSafetyNet, type Logger } from '@starlink/observability';
import { AppModule } from './app.module.js';
import { loadConfig } from './config.js';
import { LOGGER } from './tokens.js';

async function bootstrap(): Promise<void> {
  const config = loadConfig();

  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.use(cookieParser());

  const express = (await import('express')).default;

  /**
   * Raw bytes for the dev object endpoint ONLY, and registered before the JSON parser so
   * it wins for that path.
   *
   * ADR-012 has the client PUT a file straight to the URL in its upload grant. For the
   * local driver that URL is served by this process, so something has to accept a body
   * that is not JSON. Scoped to one path rather than applied globally: a global raw parser
   * would change how every other endpoint reads its input, which is exactly why the older
   * base64 dev route exists and why it was unusable from a browser.
   *
   * The ceiling matches the attachment policy's own maximum. An unbounded body is an
   * availability problem whatever it contains (§27.10).
   */
  app.use('/v1/dev/objects', express.raw({ type: () => true, limit: '25mb' }));

  // Bounded body size; an unbounded one is an availability problem (doc §27.10).
  app.use(express.json({ limit: '256kb' }));

  // Employee and customer surfaces are separate origins with separate cookie scopes
  // (§19.2). Credentials are allowed only for those two, never a wildcard.
  app.enableCors({
    origin: [config.SL_WEB_EMPLOYEE_ORIGIN, config.SL_WEB_CUSTOMER_ORIGIN],
    credentials: true,
  });

  app.use((_request: unknown, response: { setHeader: (k: string, v: string) => void }, next: () => void) => {
    // Security headers (doc §27.11). The API serves JSON only, so the CSP is maximally
    // restrictive — nothing here should ever be rendered as a document.
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    next();
  });

  /**
   * Graceful shutdown (§34, and the reason `SweepsHost.onApplicationShutdown` exists).
   *
   * Nest calls `onModuleDestroy`/`onApplicationShutdown` on SIGTERM ONLY if shutdown hooks
   * are enabled. They were not, so `SweepsHost.onApplicationShutdown` — written to stop the
   * sweep timers cleanly — could never be called, and every rolling deploy cut in-flight
   * responses mid-write and severed sweep ticks at an arbitrary point. The realtime gateway
   * had always drained on these signals, which is what made the omission here look
   * accidental rather than decided.
   */
  app.enableShutdownHooks();

  await app.listen(config.SL_API_PORT);

  /**
   * And the net beneath it. The API holds the pool that every request uses; before this,
   * a rejection nobody awaited — or an idle connection dropped by the provider — ended the
   * process with no log line saying why.
   */
  installProcessSafetyNet({
    logger: app.get<Logger>(LOGGER),
    service: 'api',
    onFatal: () => app.close(),
  });
  // The one place a direct write is correct: the process has no logger context yet and
  // an operator needs the bind confirmation.
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      level: 'info',
      service: 'api',
      msg: 'listening',
      port: config.SL_API_PORT,
      env: config.SL_ENV,
    }),
  );
}

void bootstrap();
