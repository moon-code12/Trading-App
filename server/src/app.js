import express from 'express';
import cors from 'cors';
import { authRouter } from './auth.js';
import { apiRouter } from './routes.js';
import { loadAssetState } from './assetState.js';
import { configureSimulation } from './simulation.js';

export function createApp(db, opts) {
  // 'ideal' (no costs, no delays, always open) unless told otherwise, so tests are exact. The real server asks for 'realistic'.
  configureSimulation(opts?.simulation);
  // The catalogue loads in the background; requests wait for it.
  const assetsReady = loadAssetState(db);
  assetsReady.catch(() => {});
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(async (_req, _res, next) => { await assetsReady; next(); });
  if (opts?.jobs) app.use('/api', async (_req, _res, next) => { await opts.jobs(); next(); });
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  // Hit by Vercel Cron; the jobs middleware above does the actual work.
  app.get('/api/cron', (_req, res) => res.json({ ok: true }));
  app.use('/api/auth', authRouter(db, opts));
  app.use('/api', apiRouter(db, opts));
  return app;
}
