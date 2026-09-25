import cookieParser from 'cookie-parser';
import express, { NextFunction, Request, Response } from 'express';
import { authRouter, jsonBody, requireJson, sessionMiddleware } from './auth.js';
import type { Config } from './config.js';
import type { Database } from './db.js';
import { EventHub } from './events.js';
import { gamesRouter } from './games.js';
import { rateLimits } from './limits.js';
import type { Roller } from '../shared/engine.js';

export interface AppOptions {
  db: Database;
  config: Config;
  hub?: EventHub;
  roll?: Roller;
  fetch?: typeof fetch;
}

/** Lets the browser app, served from its own origin, call the API. */
function cors(origins: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    res.vary('Origin');
    const origin = req.get('origin');
    if (origin && origins.includes(origin)) {
      res.set('Access-Control-Allow-Origin', origin);
      if (req.method === 'OPTIONS') {
        res.set({
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Max-Age': '86400',
        });
        res.status(204).end();
        return;
      }
    }
    next();
  };
}

export function createApp({ db, config, hub = new EventHub(), roll, fetch }: AppOptions) {
  const app = express();
  app.disable('x-powered-by');
  if (config.isProduction) app.set('trust proxy', 1);
  app.use(cors(config.corsOrigins));
  app.use(cookieParser());
  app.use(requireJson);
  app.use(jsonBody);

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, version: process.env.APP_VERSION ?? 'dev' });
  });
  const limits = rateLimits();
  app.use('/api/auth/login', limits.loginPerIp, limits.loginPerAccount);
  app.use('/api/auth/signup', limits.signup);
  app.use('/api/auth/google/exchange', limits.googleExchange);
  app.use(sessionMiddleware(db));
  app.use('/api', limits.api);
  app.use(authRouter({ db, config, fetch }));
  app.use(gamesRouter({ db, hub, roll }));

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use((err: { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
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
