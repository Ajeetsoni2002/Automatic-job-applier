import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { Router } from 'express';
import helmet from 'helmet';
import { getEnv } from '@ja/shared';
import { authRouter, requireAuth } from './auth.js';
import { errorHandler, notFound } from './http.js';
import { applicationsRouter } from './routes/applications.js';
import { docsRouter } from './routes/docs.js';
import { jobsRouter } from './routes/jobs.js';
import { outreachRouter } from './routes/outreach.js';
import { portalsRouter } from './routes/portals.js';
import { systemRouter } from './routes/system.js';

export function createApp() {
  const env = getEnv();
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // behind Nginx in production
  app.use(helmet());
  app.use(cors({ origin: env.WEB_ORIGIN, credentials: true }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });
  app.use('/api/auth', authRouter);

  const api = Router();
  api.use(requireAuth);
  api.use(docsRouter);
  api.use(applicationsRouter);
  api.use(outreachRouter);
  api.use(portalsRouter);
  api.use('/jobs', jobsRouter);
  api.use(systemRouter);
  app.use('/api', api);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
