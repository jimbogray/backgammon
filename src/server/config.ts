import type { DatabaseAuth } from './db.js';

export interface Config {
  port: number;
  /** Public URL of the browser app. Google sign-in returns here, and it is allowed by CORS. */
  appUrl: string;
  /** Public URL of this API, used to build the Google OAuth redirect URI. */
  apiUrl: string;
  /** Browser origins allowed to call the API. */
  corsOrigins: string[];
  databaseUrl: string;
  /** `entra` signs in to Azure Database for PostgreSQL with a managed identity token instead of a password. */
  databaseAuth: DatabaseAuth;
  isProduction: boolean;
  google: { clientId: string; clientSecret: string } | null;
}

const DEV_DATABASE_URL = 'postgres://postgres:postgres@localhost:5432/backgammon';

function trimSlash(url: string): string {
  return url.replace(/\/$/, '');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 3000);
  const isProduction = env.NODE_ENV === 'production';
  const appUrl = trimSlash(env.APP_URL ?? (isProduction ? '' : 'http://localhost:5173'));
  // In development the Vite server proxies /api to this server, so both share one URL.
  const apiUrl = trimSlash(env.API_URL ?? appUrl);
  const google =
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }
      : null;
  if (isProduction && !appUrl) {
    throw new Error('APP_URL must be set to the web app address (e.g. https://backgammon.example.com)');
  }
  if (google && !apiUrl) {
    throw new Error('API_URL must be set (e.g. https://api.backgammon.example.com) when Google sign-in is enabled');
  }

  const databaseUrl = env.DATABASE_URL ?? (isProduction ? '' : DEV_DATABASE_URL);
  if (!databaseUrl) throw new Error('DATABASE_URL must be set');
  const databaseAuth = (env.DATABASE_AUTH ?? 'password').toLowerCase();
  if (databaseAuth !== 'password' && databaseAuth !== 'entra') {
    throw new Error('DATABASE_AUTH must be "password" or "entra"');
  }

  const corsOrigins = (env.CORS_ORIGINS ?? appUrl)
    .split(',')
    .map((origin) => trimSlash(origin.trim()))
    .filter(Boolean);

  return { port, appUrl, apiUrl, corsOrigins, databaseUrl, databaseAuth, isProduction, google };
}
