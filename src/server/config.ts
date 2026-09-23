import path from 'node:path';

export interface Config {
  port: number;
  /** Public URL of the site, used to build the Google OAuth redirect URI. */
  appUrl: string;
  databasePath: string;
  isProduction: boolean;
  google: { clientId: string; clientSecret: string } | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 3000);
  const isProduction = env.NODE_ENV === 'production';
  const appUrl = (env.APP_URL ?? (isProduction ? '' : 'http://localhost:5173')).replace(/\/$/, '');
  const google =
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }
      : null;
  if (google && !appUrl) {
    throw new Error('APP_URL must be set (e.g. https://backgammon.example.com) when Google sign-in is enabled');
  }
  return {
    port,
    appUrl,
    databasePath: env.DATABASE_PATH ?? path.resolve('data', 'backgammon.db'),
    isProduction,
    google,
  };
}
