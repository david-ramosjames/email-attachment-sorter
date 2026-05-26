import express, { type Express } from 'express';
import { healthRouter } from './routes/health.js';
import { webhooksRouter } from './routes/webhooks.js';
import { adminRouter } from './routes/admin.js';
import { logger } from './utils/logger.js';

export function createApp(): Express {
  const app = express();

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

  app.use(express.json({ limit: '50mb' }));

  app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
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
  app.use(webhooksRouter);
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
