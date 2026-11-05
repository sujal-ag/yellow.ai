// Express app: middleware + routes. No listening here, so tests can import it.

import express from 'express';
import { pool } from './db.js';
import { notFound, errorHandler } from './middlewares/error.middleware.js';
import campaignRoutes from './routes/campaign.routes.js';

export function createApp() {
  const app = express();
  app.use(express.json({ limit: '5mb' })); // campaigns carry recipient lists

  app.get('/health', async (_req, res, next) => {
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  app.use('/campaigns', campaignRoutes);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
