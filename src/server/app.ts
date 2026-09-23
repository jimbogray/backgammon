import cookieParser from 'cookie-parser';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { authRouter, jsonBody, requireJson, sessionMiddleware } from './auth.js';
import type { Config } from './config.js';
import type { DB } from './db.js';
import { EventHub } from './events.js';
import { gamesRouter } from './games.js';
import type { Roller } from '../shared/engine.js';

export interface AppOptions {
  db: DB;
  config: Config;
  hub?: EventHub;
  roll?: Roller;
  fetch?: typeof fetch;
  /** Directory holding the built client (served in production). */
  clientDir?: string;
}

export function createApp({ db, config, hub = new EventHub(), roll, fetch, clientDir }: AppOptions) {
  const app = express();
  app.disable('x-powered-by');
  if (config.isProduction) app.set('trust proxy', 1);
  app.use(cookieParser());
  app.use(requireJson);
  app.use(jsonBody);
  app.use(sessionMiddleware(db));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, version: process.env.APP_VERSION ?? 'dev' });
  });
  app.use(authRouter({ db, config, fetch }));
  app.use(gamesRouter({ db, hub, roll }));

  if (clientDir && fs.existsSync(clientDir)) {
    app.use(express.static(clientDir, { index: false, maxAge: '1h' }));
    // Single-page app: every non-API route serves index.html.
    app.get(/^(?!\/api\/|\/auth\/).*/, (_req, res) => {
      res.sendFile(path.join(clientDir, 'index.html'));
    });
  }

  app.use((err: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // Client errors such as malformed JSON arrive with a 4xx status.
    if (err?.status && err.status >= 400 && err.status < 500) {
      res.status(err.status).json({ error: 'Bad request' });
      return;
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  });

  return app;
}
