import express, { type Express } from 'express';
import path from 'path';
import { healthRouter } from './routes/health.js';
import { webhooksRouter } from './routes/webhooks.js';
import { adminRouter } from './routes/admin.js';
import { faqRouter } from './routes/faq.js';
import { dashboardRouter } from './routes/dashboard.js';
import { medicalImportRouter } from './routes/medicalImport.js';
import { getEnv } from './config/env.js';
import { logger } from './utils/logger.js';

export function createApp(): Express {
  const app = express();
  const allowedOrigins = new Set(
    [
      'http://localhost:3001',
      ...(getEnv().CASE_FINANCIALS_ORIGIN?.split(',').map((value) =>
        value.trim().replace(/\/+$/, '')
      ) ?? []),
    ].filter(Boolean)
  );

  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    }
    if (req.method === 'OPTIONS') {
      res.sendStatus(origin && allowedOrigins.has(origin) ? 204 : 403);
      return;
    }
    next();
  });

  app.use(
    '/webhooks/slack/interactions',
    express.raw({ type: 'application/x-www-form-urlencoded' }),
    (req, _res, next) => {
      const raw = req.body as Buffer;
      (req as express.Request & { rawBody: string }).rawBody = raw.toString('utf8');
      const params = new URLSearchParams((req as express.Request & { rawBody: string }).rawBody);
      const payload = params.get('payload');
      if (payload) {
        try {
          req.body = { payload };
        } catch {
          req.body = {};
        }
      }
      next();
    }
  );

  app.use(
    '/webhooks/slack/events',
    express.raw({ type: 'application/json' }),
    (req, _res, next) => {
      const raw = req.body as Buffer;
      (req as express.Request & { rawBody: string }).rawBody = raw.toString('utf8');
      try {
        req.body = JSON.parse((req as express.Request & { rawBody: string }).rawBody);
      } catch {
        req.body = {};
      }
      next();
    }
  );

  app.use(express.json({ limit: '50mb' }));

  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      // Railway (and similar) probe /health constantly — skip to keep logs readable.
      if (req.path === '/health') return;
      logger.info('request', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Date.now() - start,
      });
    });
    next();
  });

  app.use(healthRouter);
  app.use(express.static(path.join(process.cwd(), 'public'), { index: false }));
  app.use(faqRouter);
  app.use(dashboardRouter);
  app.use(webhooksRouter);
  app.use(medicalImportRouter);
  app.use(adminRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use(
    (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      logger.error('Unhandled error', { err: err.message });
      res.status(500).json({ error: 'Internal server error' });
    }
  );

  return app;
}
